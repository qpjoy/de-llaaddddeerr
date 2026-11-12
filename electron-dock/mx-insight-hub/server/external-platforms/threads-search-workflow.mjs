import { createHash } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { createDataSearchCursorCodec } from './cursor.mjs'
import { nativeForwardingEndpoint } from '../contracts/native-forwarding.mjs'
import { THREADS_SEARCH_PATH, THREADS_SEARCH_VERSION, threadsSearchRecipe } from '../contracts/threads-search.mjs'
import { contentSearchDeliveryBody } from './content-search.mjs'
import { runSocialAccountWorkflow } from './social-account-workflow.mjs'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
const invalidCursor = () => new AppError(400, 'invalid_cursor', 'The Threads search cursor is invalid, expired or belongs to another query/Key; restart explicitly')
const codecFor = (gateway, context) => createDataSearchCursorCodec(gateway.apiKeyPepper, `${context.consumer.id}:${context.apiKey.id}:threads-search`)

export function normalizeThreadsSearchDelivery(normalized, { resultType, provider, codec }) {
  const query = String(normalized.query || '').trim(), pageSize = normalized.pageSize
  if (!query || query.length > 500 || query.includes('\0')) throw new AppError(400, 'invalid_query', 'A bounded content-search keyword is required')
  const scopeHash = hash({ version: THREADS_SEARCH_VERSION, provider, query, pageSize, type: resultType })
  let page = 1, expiresAt = Date.now() + 86400000, previousDeliveryId = null
  if (normalized.cursor) {
    try {
      const state = codec.decode(normalized.cursor)
      if (state.version !== THREADS_SEARCH_VERSION || state.scopeHash !== scopeHash || state.provider !== provider
        || !uuid(state.previousDeliveryId) || !Number.isInteger(state.page) || state.page < 2 || state.page > 15
        || !Number.isSafeInteger(state.expiresAt) || state.expiresAt <= Date.now()) throw new Error('cursor')
      ;({ page, expiresAt, previousDeliveryId } = state)
    } catch { throw invalidCursor() }
  }
  // Each request reads one source page: no live page has shown more than one yet.
  return { platform: 'threads', provider, query, queries: [query], pageSize, totalLimit: pageSize, resultType,
    jobs: [{ id: scopeHash, provider }], operation: 'search', path: THREADS_SEARCH_PATH, routeInterface: 'search',
    scopeHash, page, expiresAt, previousDeliveryId, deliveryMode: 'live_only', manualProviderPagination: true, singlePage: true,
    fingerprintBody: { ...normalized, type: resultType },
    encodeNext: deliveryId => codec.encode({ version: THREADS_SEARCH_VERSION, scopeHash, provider,
      page: page + 1, expiresAt, previousDeliveryId: deliveryId }) }
}

export function threadsSearchPlan({ gateway, context, input, dependencies }) {
  const { normalized, body, idempotencyKey, dataSearch, signal } = input
  const recipe = threadsSearchRecipe('threads', gateway.providerKey), endpoint = nativeForwardingEndpoint(recipe?.key)
  if (!endpoint || !gateway.operationControlStore) throw new AppError(503, 'content_search_unavailable', 'Hub content search is unavailable')
  let request
  return { input: { body, idempotencyKey, signal, path: THREADS_SEARCH_PATH },
    plan: { operation: endpoint.operation, authorizationPlatform: 'threads', platformSearch: true, meterKey: 'threads',
      datasetId: 'night-all.search.v1', nativeForwarding: true, dataSearch: true, replayReleasedFailures: true, replayWindowMs: dataSearch.replayWindowMs,
      normalize: ({ policy }) => {
        request = normalizeThreadsSearchDelivery(normalized, { resultType: dataSearch.resultType, provider: gateway.providerKey, codec: codecFor(gateway, context) })
        if (request.totalLimit > policy.maxPageSize) throw new AppError(400, 'work_budget_exceeded', 'Content-search work exceeds the Key entitlement')
        return request
      },
      assemble: ({ delivery, deadlineAt, signal }) => runSocialAccountWorkflow({ gateway, context, request, delivery, deadlineAt, signal,
        ...dependencies, workflowKind: 'threads-search',
        buildResponse: values => contentSearchDeliveryBody(request, values.rowsByJob, values.state, {
          calls: values.calls, warnings: values.warnings, deliveryId: delivery.usageRequestId }) }),
    } }
}

// The supplier that issued a signed search cursor; a traversal never changes supplier.
export function threadsSearchCursorProvider(input, { gateway, context }) {
  const cursor = input?.cursor
  if (typeof cursor !== 'string' || !cursor.startsWith('mxds1.')) return null
  try {
    const state = codecFor(gateway, context).decode(cursor)
    return typeof state.provider === 'string' ? state.provider : null
  } catch { return null }
}
