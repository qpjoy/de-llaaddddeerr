import { AppError } from '../core/errors.mjs'
import { requestFingerprint } from '../core/crypto.mjs'
import { nativeForwardingEndpoint } from '../contracts/native-forwarding.mjs'
import { TIKHUB_CONTENT_SEARCH_RECIPES, TIKHUB_CONTENT_SEARCH_VERSION, contentSearchDataItem, contentSearchLegacyRow, normalizeTikHubContentSearchRequest } from '../contracts/tikhub-content-search.mjs'
import { RAW_SEARCH_PATH, RAW_SEARCH_DATASET, RAW_SEARCH_VERSION } from '../contracts/raw-search.mjs'
import { createDataSearchCursorCodec, createRawSearchCursorCodec, createNightAllCompatibilityCursorCodec } from './cursor.mjs'
import { prepareNightAllCompatibilityTraversal } from '../data/night-all-pagination.mjs'
import { runContentSearch } from './content-search-workflow.mjs'

const hash = value => requestFingerprint({ method: 'POST', path: '/internal/tikhub-content-search/scope', body: value })
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
export const isDirectContentSearchPlatform = platform => Object.hasOwn(TIKHUB_CONTENT_SEARCH_RECIPES, platform)

export function normalizeContentSearchDelivery(normalized, { dataSearch, codec, historicalCodec }) {
  const platform = normalized.platform, recipe = TIKHUB_CONTENT_SEARCH_RECIPES[platform]
  if (!recipe) throw new AppError(400, 'invalid_platform', 'Unsupported direct content-search platform')
  const body = dataSearch ? normalized : normalized.upstreamBody
  const queryValues = dataSearch ? [body.query] : [...(body.queries || []), ...(body.keywords || [])]
  if (!queryValues.length) queryValues.push(body.query || body.keyword)
  const queries = [...new Set(queryValues.map(query => String(query || '').trim()))]
  if (!queries.length || queries.length > 50 || queries.some(query => !query || query.length > (dataSearch ? 500 : 2048) || query.includes('\0'))) {
    throw new AppError(400, 'invalid_query', 'A bounded content-search keyword is required')
  }
  const pageSize = normalized.pageSize, params = { ...(body.params || {}) }
  const paramsCursor = typeof params.cursor === 'string' && /^(?:mxnc1|mxraw1|mxds1)\./u.test(params.cursor) ? params.cursor : null
  const cursor = body.cursor || paramsCursor
  if (paramsCursor) delete params.cursor
  const scopeHash = hash({ version: TIKHUB_CONTENT_SEARCH_VERSION, platform, queries, pageSize, params,
    type: dataSearch?.resultType || 'raw', includeDetails: body.includeDetails === true,
    includeComments: body.includeComments === true, disableAutoDetails: body.disableAutoDetails === true,
    commentLimit: body.commentLimit ?? null, commentCursor: body.commentCursor ?? null, maxEnrichItems: body.maxEnrichItems ?? null })
  let page = 1, expiresAt = Date.now() + 86400000, previousDeliveryId = null, restartRequired = !cursor && body.page > 1
  const unsupportedNativeCursor = cursor && !/^(?:mxnc1|mxraw1|mxds1)\./u.test(cursor)
  let fingerprintBody = dataSearch ? { ...normalized, type: dataSearch.resultType }
    : { contractVersion: 'mx-insight-hub.night-all-compat.v1', ...body }
  if (cursor?.startsWith('mxnc1.')) {
    const old = prepareNightAllCompatibilityTraversal({ operation: dataSearch ? 'data-search' : 'raw', platform,
      upstreamBody: body, codec: historicalCodec })
    fingerprintBody = dataSearch ? { ...old.upstreamBody, type: dataSearch.resultType }
      : { contractVersion: 'mx-insight-hub.night-all-compat.v1', ...old.upstreamBody }
    restartRequired = true
  } else if (cursor && !unsupportedNativeCursor) {
    try {
      const state = codec.decode(cursor)
      if (state.version !== TIKHUB_CONTENT_SEARCH_VERSION || state.platform !== platform || state.provider !== 'tikhub'
        || state.recipe !== recipe.key || state.scope !== scopeHash || !uuid(state.previousDeliveryId)
        || !Number.isInteger(state.page) || state.page < 2 || state.page > 15
        || !Number.isSafeInteger(state.expiresAt) || state.expiresAt <= Date.now()) throw new Error('cursor')
      ;({ page, expiresAt, previousDeliveryId } = state)
    } catch { throw new AppError(400, 'invalid_cursor', 'The content-search cursor is invalid, expired or belongs to another query/Key; restart explicitly') }
  }
  // Only fixed recipe defaults are normalized before replay. User options are
  // checked after replay, when a new acquisition is actually required.
  const placeholder = normalizeTikHubContentSearchRequest({ platform, query: queries[0], pageSize,
    maxQueryLength: dataSearch ? 500 : 2048 })
  return { ...placeholder, platform, recipe, queries, params, pageSize, totalLimit: queries.length * pageSize,
    standard: Boolean(dataSearch),
    resultType: dataSearch?.resultType || 'raw', body, scopeHash, page, expiresAt, previousDeliveryId,
    restartRequired, unsupportedNativeCursor, fingerprintBody, deliveryMode: 'live_only',
    encodeNext: deliveryId => codec.encode({ version: TIKHUB_CONTENT_SEARCH_VERSION, platform, provider: 'tikhub',
      recipe: recipe.key, scope: scopeHash, page: page + 1, expiresAt, previousDeliveryId: deliveryId }) }
}

export function contentSearchDeliveryBody(request, rowsByJob, state, { calls, warnings, deliveryId }) {
  const all = rowsByJob.flat(), remaining = state.jobs.some(job => job.buffer || !job.done && job.upstreamPages < 15)
  const more = remaining && request.page < 15
  const nextCursor = more ? request.encodeNext(deliveryId) : null
  if (remaining && request.page === 15) warnings.push({ code: 'page_limit_reached', message: 'The content-search traversal reached its page limit; restart explicitly.' })
  const page = { page: request.page, pageSize: request.pageSize, returnedCount: all.length, hasMore: more,
    nextCursor, providerCursor: nextCursor, nextParams: more ? { cursor: nextCursor } : null,
    nextPage: null, paginationMode: more ? 'composite' : 'cursor' }
  const status = warnings.length ? 'partial' : 'ok'
  if (request.resultType !== 'raw') return { data: { contractVersion: 'night-all.data-search.v1', platform: request.platform,
    query: request.queries[0], items: all.map(contentSearchDataItem), pageInfo: { pageIndex: request.page,
      pageSize: request.pageSize, returnedCount: all.length, hasMore: more, nextCursor, cursorType: more ? 'opaque' : 'none' },
    status, warnings, meta: { capability: 'search_posts', capabilityStatus: 'ready', paginationMode: 'cursor', providerCalls: calls } }, requestId: deliveryId }
  const legacy = all.map(contentSearchLegacyRow)
  const authors = [...new Map(all.filter(row => row.author_id).map(row => [row.author_id, {
    user_id: row.author_id, name: row.author_name || '', avatar_url: row.author_avatar_url || '',
  }])).values()]
  return { contractVersion: RAW_SEARCH_VERSION, data: { platform: request.platform,
    query: request.queries[0], keyword: request.queries[0], raw_info: JSON.stringify(authors), raw_data: JSON.stringify(legacy),
    ...(request.queries.length > 1 ? { mode: 'batch', queries: request.queries, results: rowsByJob.map((rows, index) => ({
      platform: request.platform, query: request.queries[index], keyword: request.queries[index],
      success: state.jobs[index].started, status: state.jobs[index].started ? 'ok' : 'pending',
      items: rows.map(contentSearchLegacyRow), page: { ...page, returnedCount: rows.length },
    })) } : {}), page, status, warnings,
    meta: { implementation: 'hub', resultCount: all.length, upstreamCallCount: calls,
      enrichment: { enabled: false, supported: false, reason: 'content_search_only' } } }, requestId: deliveryId }
}

export function contentSearchPlan({ gateway, context, input, dependencies }) {
  const { normalized, body, idempotencyKey, dataSearch = null, signal } = input
  const recipe = TIKHUB_CONTENT_SEARCH_RECIPES[normalized.platform], endpoint = nativeForwardingEndpoint(recipe?.key)
  if (gateway.providerKey !== 'tikhub' || !endpoint || !gateway.operationControlStore) throw new AppError(503, 'content_search_unavailable', 'Hub content search is unavailable')
  const codec = (dataSearch ? createDataSearchCursorCodec : createRawSearchCursorCodec)(gateway.apiKeyPepper, `${context.consumer.id}:${context.apiKey.id}`)
  let request
  return { input: { body, idempotencyKey, signal, path: dataSearch ? '/api/v1/data/search' : RAW_SEARCH_PATH },
    plan: { operation: endpoint.operation, authorizationPlatform: normalized.platform, platformSearch: true,
      meterKey: dataSearch ? normalized.platform : 'raw', datasetId: dataSearch ? 'night-all.search.v1' : RAW_SEARCH_DATASET,
      nativeForwarding: true, dataSearch: Boolean(dataSearch), replayReleasedFailures: true, replayWindowMs: dataSearch?.replayWindowMs,
      normalize: ({ policy }) => {
        request = normalizeContentSearchDelivery(normalized, { dataSearch, codec,
          historicalCodec: createNightAllCompatibilityCursorCodec(gateway.apiKeyPepper, context.consumer.id) })
        if (request.totalLimit > policy.maxPageSize || request.totalLimit > 1000) throw new AppError(400, 'work_budget_exceeded', 'Content-search work exceeds the Key entitlement')
        return request
      },
      assemble: ({ delivery, deadlineAt, signal }) => runContentSearch({ gateway, context, request, delivery, deadlineAt, signal,
        ...dependencies, buildResponse: values => contentSearchDeliveryBody(request, values.rowsByJob, values.state, {
          calls: values.calls, warnings: values.warnings, deliveryId: delivery.usageRequestId }) }),
    } }
}
