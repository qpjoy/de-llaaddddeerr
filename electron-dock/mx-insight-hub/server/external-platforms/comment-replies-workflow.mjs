import { createHash } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { createDataSearchCursorCodec } from './cursor.mjs'
import { normalizeCommentRepliesRequest, commentReplyRecipe, COMMENT_REPLIES_VERSION,
  COMMENT_REPLIES_CAPABILITY, COMMENT_REPLIES_PATH } from '../contracts/comment-replies.mjs'
import { runSocialAccountWorkflow } from './social-account-workflow.mjs'
import { withSinglePage } from '../contracts/single-page-delivery.mjs'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
const invalidCursor = () => new AppError(400, 'invalid_cursor', 'The replies cursor is invalid, expired or belongs to another request/Key; restart explicitly')
const codecFor = (gateway, context) => createDataSearchCursorCodec(gateway.apiKeyPepper, `${context.consumer.id}:${context.apiKey.id}:comment-replies`)

export function normalizeCommentRepliesDelivery(body, { context, maxPageSize, codec, provider = null }) {
  const request = normalizeCommentRepliesRequest(body, { maxPageSize, businessId: context.consumer.businessId, provider })
  const recipe = commentReplyRecipe(request.platform, request.provider)
  // The supplier is part of the traversal: a cursor never changes supplier.
  const scopeHash = hash({ version: COMMENT_REPLIES_VERSION, ...request.fingerprintBody,
    recipe: { provider: recipe.provider, key: recipe.key } })
  let page = 1, expiresAt = Date.now() + 86400000, previousDeliveryId = null
  if (request.cursor) {
    try {
      const state = codec.decode(request.cursor)
      if (state.version !== COMMENT_REPLIES_VERSION || state.scopeHash !== scopeHash || state.provider !== recipe.provider
        || !uuid(state.previousDeliveryId) || !Number.isInteger(state.page) || state.page < 2 || state.page > 15
        || !Number.isSafeInteger(state.expiresAt) || state.expiresAt <= Date.now()) throw new Error('cursor')
      ;({ page, expiresAt, previousDeliveryId } = state)
    } catch { throw invalidCursor() }
  }
  return { ...request, jobs: request.jobs.map(job => ({ ...job, id: scopeHash })), scopeHash, page, expiresAt,
    previousDeliveryId, deliveryMode: 'live_only', manualProviderPagination: recipe.manualPagination,
    fingerprintBody: { ...request.fingerprintBody, cursor: request.cursor ?? null },
    encodeNext: deliveryId => codec.encode({ version: COMMENT_REPLIES_VERSION, scopeHash, provider: recipe.provider,
      page: page + 1, expiresAt, previousDeliveryId: deliveryId }) }
}

export function commentRepliesDeliveryBody(request, { rowsByJob, state, calls, warnings, deliveryId }) {
  const job = state.jobs[0], items = rowsByJob[0]
  const remaining = Boolean(job.buffer || !job.done && job.upstreamPages < 15)
  const hasNext = remaining && request.page < 15
  const nextCursor = hasNext ? request.encodeNext(deliveryId) : null
  if (remaining && request.page === 15) warnings.push({ code: 'page_limit_reached', message: 'The replies traversal reached its response-page limit; restart explicitly.' })
  const incomplete = warnings.some(row => ['pagination_completeness_unknown', 'upstream_pagination_stopped', 'repeated_cursor'].includes(row.code))
  const limited = warnings.some(row => ['page_limit_reached', 'upstream_page_limit_reached'].includes(row.code))
  const unknownContinuation = request.manualProviderPagination && !job.buffer && incomplete
  const paginationStatus = nextCursor ? unknownContinuation ? 'unknown' : 'continuable'
    : limited ? 'limit_reached' : incomplete ? 'unknown' : 'exhausted'
  const page = { page: request.page, pageSize: request.pageSize, returnedCount: items.length,
    duplicateCount: job.duplicateCount || 0, hasMore: nextCursor ? unknownContinuation ? null : true : incomplete || limited ? null : false,
    nextCursor, providerCursor: nextCursor, nextPage: null, nextParams: nextCursor ? { cursor: nextCursor } : null,
    paginationMode: 'cursor', paginationStatus,
    ...(request.manualProviderPagination ? { continuationAvailable: Boolean(nextCursor) } : {}) }
  return { contractVersion: COMMENT_REPLIES_VERSION, data: { platform: request.platform, commentId: request.commentId,
    contentId: request.contentId, items, replies: structuredClone(items), raw_info: '[]', raw_data: JSON.stringify(items), page,
    pageInfo: { ...structuredClone(page), pageIndex: request.page, cursorType: nextCursor ? 'opaque' : 'none' },
    status: warnings.length || nextCursor ? 'partial' : 'ok', warnings,
    meta: { implementation: 'hub', scope: 'comment_replies', resultCount: items.length, providerCalls: calls,
      upstreamCallCount: calls, upstreamPages: job.upstreamPages, maxUpstreamPages: 15, paginationStatus } }, requestId: deliveryId }
}

export function commentRepliesPlan({ gateway, context, input, dependencies }) {
  if (input.path !== COMMENT_REPLIES_PATH) throw new AppError(404, 'not_found', 'Unknown comment replies route')
  if (!gateway.operationControlStore) throw new AppError(503, 'external_platform_contract_unverified', 'Replies require reviewed operation controls')
  const codec = codecFor(gateway, context)
  let request
  return { input, plan: { operation: COMMENT_REPLIES_CAPABILITY, authorizationPlatform: input.platform,
    capabilityMessage: 'Comment replies are not granted for this API key', replayReleasedFailures: true,
    normalize: ({ policy }) => {
      request = normalizeCommentRepliesDelivery(input.body, { context, maxPageSize: policy.maxPageSize, codec, provider: gateway.providerKey })
      if (request.platform !== input.platform || request.provider !== gateway.providerKey) {
        throw new AppError(503, 'external_platform_unavailable', 'The configured reply supplier does not match this platform')
      }
      return (request = withSinglePage(request, input.singlePage))
    },
    assemble: ({ delivery, deadlineAt, signal }) => runSocialAccountWorkflow({ gateway, context, request, delivery,
      deadlineAt, signal, ...dependencies, workflowKind: 'comment-replies',
      buildResponse: values => commentRepliesDeliveryBody(request, { ...values, deliveryId: delivery.usageRequestId }) }),
  } }
}

// The supplier that issued a signed replies cursor (see comment-routing.mjs).
export function commentRepliesCursorProvider(body, { gateway, context }) {
  if (typeof body?.cursor !== 'string' || !body.cursor.startsWith('mxds1.')) return null
  try {
    const state = codecFor(gateway, context).decode(body.cursor)
    return typeof state.provider === 'string' ? state.provider : null
  } catch { return null }
}
