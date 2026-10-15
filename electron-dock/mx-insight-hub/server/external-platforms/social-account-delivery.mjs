import { createHash } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { createDataSearchCursorCodec } from './cursor.mjs'
import { normalizeHubSocialCompatRequest, buildHubSocialCompatDispatch } from '../contracts/hub-social-compat.mjs'
import { runSocialAccountWorkflow } from './social-account-workflow.mjs'

export const SOCIAL_COMPAT_VERSION = 'mx-insight-hub.social-compat.v1'
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)

export function normalizeSocialAccountDelivery(operation, body, { context, maxPageSize, codec }) {
  for (const key of ['businessId', 'business_id']) {
    if (body?.[key] != null && (typeof body[key] !== 'string' || body[key].trim() !== context.consumer.businessId)) throw new AppError(400, 'business_id_mismatch', 'businessId must match the authenticated consumer')
  }
  const normalized = normalizeHubSocialCompatRequest(operation, body, { maxPageSize, businessId: context.consumer.businessId })
  const totalLimit = normalized.jobs.length * (operation === 'user-info' ? 1 : normalized.pageSize)
  if (totalLimit > maxPageSize || totalLimit > 1000) throw new AppError(400, 'work_budget_exceeded', 'Account work exceeds this Key entitlement')
  const scopeHash = hash({ version: SOCIAL_COMPAT_VERSION, operation, platform: normalized.platform,
    jobs: normalized.jobs, pageSize: normalized.pageSize, includeRaw: normalized.includeRaw })
  let page = 1, expiresAt = Date.now() + 86400000, previousDeliveryId = null
  if (normalized.cursor) {
    try {
      const state = codec.decode(normalized.cursor)
      if (state.version !== SOCIAL_COMPAT_VERSION || state.operation !== operation || state.scopeHash !== scopeHash
        || state.platform !== normalized.platform || !uuid(state.previousDeliveryId)
        || !Number.isInteger(state.page) || state.page < 2 || state.page > 15
        || !Number.isSafeInteger(state.expiresAt) || state.expiresAt <= Date.now()) throw new Error('cursor')
      ;({ page, expiresAt, previousDeliveryId } = state)
      if (body.page != null && Number(body.page) !== page) throw new Error('page')
    } catch { throw new AppError(400, 'invalid_cursor', 'The account cursor is invalid, expired or belongs to another account/Key; restart explicitly') }
  } else if (normalized.page > 1) throw new AppError(400, 'invalid_cursor', 'Continue with the previous response nextCursor, or restart at page 1')
  // Validate every initial provider request before reserving or dispatching.
  for (const job of normalized.jobs) buildHubSocialCompatDispatch(job, { pageSize: normalized.pageSize })
  return { ...normalized, totalLimit, scopeHash, page, expiresAt, previousDeliveryId,
    deliveryMode: 'live_only', fingerprintBody: { ...normalized.fingerprintBody, cursor: normalized.cursor || null },
    encodeNext: deliveryId => codec.encode({ version: SOCIAL_COMPAT_VERSION, operation, platform: normalized.platform,
      scopeHash, page: page + 1, expiresAt, previousDeliveryId: deliveryId }) }
}

export function socialAccountDeliveryBody(request, { rowsByJob, state, calls, warnings, deliveryId }) {
  const visibleProfiles = (job, rows) => [...new Map([...(job.profiles || []), ...rows.filter(row => row.objectType === 'user')]
    .map(row => [row.user_id, row])).values()]
  const allRows = rowsByJob.flat()
  const rows = [...new Map(allRows.map(row => [request.operation === 'user-info' || row.objectType === 'user'
    ? `user:${row.user_id}` : `post:${row.content_id}`, row])).values()]
  const duplicateCount = allRows.length - rows.length
  const profiles = [...new Map(state.jobs.flatMap((job, index) => visibleProfiles(job, rowsByJob[index])).map(row => [row.user_id, row])).values()]
  const remaining = state.jobs.some(job => job.buffer || !job.done && job.upstreamPages < 15)
  const hasMore = remaining && request.page < 15
  const nextCursor = hasMore ? request.encodeNext(deliveryId) : null
  if (remaining && request.page === 15) warnings.push({ code: 'page_limit_reached', message: 'The account traversal reached its page limit; restart explicitly.' })
  const page = { page: request.page, pageSize: request.pageSize, returnedCount: rows.length, duplicateCount,
    hasMore, nextCursor, providerCursor: nextCursor, nextParams: nextCursor ? { cursor: nextCursor } : null,
    nextPage: null, paginationMode: 'cursor' }
  return { contractVersion: SOCIAL_COMPAT_VERSION, data: { platform: request.platform,
    items: rows, raw_info: JSON.stringify(profiles), raw_data: JSON.stringify(request.operation === 'user-info' ? [] : rows),
    ...(request.jobs.length > 1 ? { mode: 'batch', results: rowsByJob.map((items, index) => ({
      platform: request.platform, ...request.jobs[index].identity, success: state.jobs[index].started,
      items: structuredClone(items), raw_info: JSON.stringify(visibleProfiles(state.jobs[index], items)),
      raw_data: JSON.stringify(request.operation === 'user-info' ? [] : items), page: { ...structuredClone(page), returnedCount: items.length },
    })) } : {}), page, pageInfo: { ...structuredClone(page), pageIndex: request.page, cursorType: hasMore ? 'opaque' : 'none' },
    status: warnings.length || hasMore && rows.length < request.totalLimit ? 'partial' : 'ok', warnings,
    meta: { implementation: 'hub', resultCount: rows.length, duplicateCount, upstreamCallCount: calls, providerCalls: calls } }, requestId: deliveryId }
}

export function socialAccountPlan({ gateway, context, input, dependencies }) {
  const { operation, body, path } = input
  const first = normalizeHubSocialCompatRequest(operation, body, { maxPageSize: 1000, businessId: context.consumer.businessId })
  if (path !== `/api/v1/data/social/${operation}` || first.jobs.some(job => job.provider !== gateway.providerKey)) throw new AppError(400, 'social_platform_not_implemented', 'This social route does not support the selected platform')
  if (!gateway.operationControlStore) throw new AppError(503, 'external_platform_contract_unverified', 'Account data requires reviewed operation controls')
  const capability = operation === 'crawl' ? 'social.content.crawl' : 'social.profile.get'
  const codec = createDataSearchCursorCodec(gateway.apiKeyPepper, `${context.consumer.id}:${context.apiKey.id}:social:${operation}`)
  let request
  return { input, plan: { operation: capability, authorizationPlatform: first.platform,
    capabilityMessage: 'This Hub account operation is not granted for this API key', replayReleasedFailures: true,
    normalize: ({ policy }) => (request = normalizeSocialAccountDelivery(operation, body, { context, maxPageSize: policy.maxPageSize, codec })),
    assemble: ({ delivery, deadlineAt, signal }) => runSocialAccountWorkflow({ gateway, context, request, delivery, deadlineAt, signal,
      ...dependencies, buildResponse: values => socialAccountDeliveryBody(request, { ...values, deliveryId: delivery.usageRequestId }) }),
  } }
}
