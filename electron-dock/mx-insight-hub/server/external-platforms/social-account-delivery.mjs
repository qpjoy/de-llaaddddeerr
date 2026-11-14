import { createHash } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { createDataSearchCursorCodec } from './cursor.mjs'
import { normalizeHubSocialCompatRequest, buildHubSocialCompatDispatch, threadsAccountRecipe } from '../contracts/hub-social-compat.mjs'
import { requestFingerprint } from '../core/crypto.mjs'
import { assertCommentRouteEnabled } from './strategy-search-routing.mjs'
import { runSocialAccountWorkflow } from './social-account-workflow.mjs'
import { withSinglePage } from '../contracts/single-page-delivery.mjs'
import { THREADS_SCRAPER_ROUTE } from '../../shared/threads-search-routing.mjs'

export const SOCIAL_COMPAT_VERSION = 'mx-insight-hub.social-compat.v1'
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)

export function normalizeSocialAccountDelivery(operation, body, { context, maxPageSize, codec, provider = null }) {
  for (const key of ['businessId', 'business_id']) {
    if (body?.[key] != null && (typeof body[key] !== 'string' || body[key].trim() !== context.consumer.businessId)) throw new AppError(400, 'business_id_mismatch', 'businessId must match the authenticated consumer')
  }
  const normalized = normalizeHubSocialCompatRequest(operation, body, { maxPageSize, businessId: context.consumer.businessId, provider })
  const routeProvider = normalized.jobs[0].routeProvider
  const totalLimit = normalized.jobs.length * (operation === 'user-info' ? 1 : normalized.pageSize)
  const allowedWork = Math.min(maxPageSize, 1000)
  if (totalLimit > allowedWork) {
    throw new AppError(400, 'work_budget_exceeded', 'Account work exceeds this Key entitlement', {
      stage: 'admission', upstreamDispatched: false, retryable: false, jobCount: normalized.jobs.length,
      pageSize: normalized.pageSize, requestedWork: totalLimit, allowedWork,
    })
  }
  const scopeHash = hash({ version: SOCIAL_COMPAT_VERSION, operation, platform: normalized.platform,
    jobs: normalized.jobs, pageSize: normalized.pageSize, includeRaw: normalized.includeRaw })
  let page = 1, expiresAt = Date.now() + 86400000, previousDeliveryId = null
  if (normalized.cursor) {
    try {
      const state = codec.decode(normalized.cursor)
      if (state.version !== SOCIAL_COMPAT_VERSION || state.operation !== operation || state.scopeHash !== scopeHash
        || state.provider != null && state.provider !== normalized.jobs[0].provider
        || state.routeProvider !== routeProvider
        || state.platform !== normalized.platform || !uuid(state.previousDeliveryId)
        || !Number.isInteger(state.page) || state.page < 2 || state.page > 15
        || !Number.isSafeInteger(state.expiresAt) || state.expiresAt <= Date.now()) throw new Error('cursor')
      ;({ page, expiresAt, previousDeliveryId } = state)
      if (body.page != null && Number(body.page) !== page) throw new Error('page')
    } catch { throw new AppError(400, 'invalid_cursor', 'The account cursor is invalid, expired or belongs to another account/Key; restart explicitly') }
  } else if (normalized.page > 1) throw new AppError(400, 'invalid_cursor', 'Continue with the previous response nextCursor, or restart at page 1')
  // Validate every initial provider request before reserving or dispatching.
  for (const job of normalized.jobs) buildHubSocialCompatDispatch(job, { pageSize: normalized.pageSize })
  return { ...normalized, ...(routeProvider ? { routeProvider } : {}), totalLimit, scopeHash, page, expiresAt, previousDeliveryId,
    deliveryMode: 'live_only', fingerprintBody: { ...normalized.fingerprintBody, cursor: normalized.cursor || null },
    encodeNext: deliveryId => codec.encode({ version: SOCIAL_COMPAT_VERSION, operation, platform: normalized.platform,
      ...(normalized.platform === 'threads' ? { provider: normalized.jobs[0].provider } : {}),
      ...(routeProvider ? { routeProvider } : {}),
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
  const nextCursor = remaining && request.page < 15 ? request.encodeNext(deliveryId) : null
  const hasMore = !nextCursor && request.platform === 'threads' && (remaining || state.jobs.some(job => job.paginationUnproven)) ? null : Boolean(nextCursor)
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
  const provider = input.routing?.provider ?? gateway.providerKey
  const first = normalizeHubSocialCompatRequest(operation, body, { maxPageSize: 1000, businessId: context.consumer.businessId, provider })
  if (path !== `/api/v1/data/social/${operation}` || first.jobs.some(job => job.provider !== gateway.providerKey)) throw new AppError(400, 'social_platform_not_implemented', 'This social route does not support the selected platform')
  if (!gateway.operationControlStore) throw new AppError(503, 'external_platform_contract_unverified', 'Account data requires reviewed operation controls')
  const capability = operation === 'crawl' ? 'social.content.crawl' : 'social.profile.get'
  const codec = createDataSearchCursorCodec(gateway.apiKeyPepper, `${context.consumer.id}:${context.apiKey.id}:social:${operation}`)
  let request
  return { input, plan: { operation: capability, authorizationPlatform: first.platform,
    capabilityMessage: 'This Hub account operation is not granted for this API key', replayReleasedFailures: true,
    normalize: ({ policy }) => {
      const threads = first.platform === 'threads'
      // No live Threads page has proven end_cursor yet: one source page per request.
      request = withSinglePage(normalizeSocialAccountDelivery(operation, body, { context, maxPageSize: policy.maxPageSize, codec, provider }), input.singlePage || threads)
      return (request = threads ? { ...request, routeInterface: operation } : request)
    },
    assemble: async ({ delivery, deadlineAt, signal }) => {
      if (request.platform === 'threads' && !request.cursor) {
        const { operationKeys } = threadsAccountRecipe('threads', provider, request)
        // Each dispatch already enforces its own controls. For a batch or
        // handle lookup, check later steps before buying the first one.
        if (operationKeys.length > 1) {
          await assertCommentRouteEnabled(gateway.strategySearchRoutingStore, request)
          const readiness = await gateway.nativeReadiness({ consumerId: context.consumer.id, operationKeys })
          if (!operationKeys.every(key => readiness[key] === true)) throw new AppError(503, 'external_platform_operation_unavailable',
            'The selected source is not ready for every requested account operation', { upstreamDispatched: false })
        }
      }
      return runSocialAccountWorkflow({ gateway, context, request, delivery, deadlineAt, signal,
        ...dependencies, buildResponse: values => socialAccountDeliveryBody(request, { ...values, deliveryId: delivery.usageRequestId }) })
    },
  } }
}

// The account fingerprint includes the selected supplier in every job. An
// immutable first-page receipt must follow that supplier even after a change
// in readiness or strategy. The gateway still enforces grants and replay.
export async function threadsAccountReceiptProvider(store, context, input, normalized) {
  if (!input.idempotencyKey || normalized.cursor) return null
  const saved = await store.getUsageRequestByIdempotencyKey(context.consumer.id, input.idempotencyKey)
  if (!saved || saved.platform !== 'threads' || saved.apiKeyId !== context.apiKey.id
    || saved.tenantId !== context.tenant.id || saved.acquisitionRequest?.path !== input.path) return null
  for (const provider of ['rapidapi', 'tikhub', THREADS_SCRAPER_ROUTE]) {
    try {
      const request = provider === 'rapidapi' ? normalized : normalizeHubSocialCompatRequest(input.operation, input.body,
        { businessId: context.consumer.businessId, provider })
      const { fingerprintBody } = withSinglePage(request, true)
      if (requestFingerprint({ method: 'POST', path: input.path, body: fingerprintBody }) === saved.fingerprint) return provider
    } catch (error) {
      // A listing that cannot express this input cannot own its receipt.
      if (!(error instanceof AppError) || error.status !== 400) throw error
    }
  }
  return null // The gateway enforces authorization and rejects a conflicting fingerprint.
}

// The supplier that issued a signed Threads account cursor (see comment-routing.mjs).
export const socialAccountCursorProvider = operation => (body, { gateway, context }) => {
  const cursor = typeof body?.cursor === 'string' ? body.cursor : body?.params?.cursor
  if (typeof cursor !== 'string' || !cursor.startsWith('mxds1.')) return null
  try {
    const state = createDataSearchCursorCodec(gateway.apiKeyPepper, `${context.consumer.id}:${context.apiKey.id}:social:${operation}`).decode(cursor)
    const routeProvider = state.routeProvider ?? state.provider
    return typeof routeProvider === 'string' ? routeProvider : null
  } catch { return null }
}
