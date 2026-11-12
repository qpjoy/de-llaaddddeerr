import { createHash } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { createDataSearchCursorCodec } from './cursor.mjs'
import { normalizePostCommentsRequest, POST_COMMENTS_VERSION, POST_COMMENTS_CAPABILITY, POST_COMMENTS_PATH,
  POST_COMMENTS_RECIPES, postCommentRecipe } from '../contracts/post-comments.mjs'
import { runSocialAccountWorkflow } from './social-account-workflow.mjs'
import { withSinglePage } from '../contracts/single-page-delivery.mjs'
import { commentRoutePlatforms } from '../contracts/comment-routes.mjs'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
const invalidCursor = () => new AppError(400, 'invalid_cursor', 'The comments cursor is invalid, expired or belongs to another request/Key; restart explicitly')

export function normalizePostCommentsDelivery(body, { context, maxPageSize, codec, allowHistoricalProviderCursor = false, provider = null }) {
  const request = normalizePostCommentsRequest(body, { maxPageSize, businessId: context.consumer.businessId, provider,
    allowHistoricalRedditCursor: allowHistoricalProviderCursor, allowHistoricalKuaishouCursor: allowHistoricalProviderCursor })
  const { initialParams: _initialParams, cursor: _cursor, page: _page, ...identity } = request.fingerprintBody
  const recipe = postCommentRecipe(request.platform, request.provider)
  // These platforms changed suppliers, and a routing policy may select any
  // registered supplier. A signed cursor resumes only the supplier that
  // issued it; historical receipt fingerprints stay put. The baseline
  // supplier of an unmigrated platform keeps its original scope identity.
  const migratedProvider = ['twitter', 'reddit', 'kuaishou', 'weibo', 'zhihu', 'threads'].includes(request.platform)
    || recipe.provider !== POST_COMMENTS_RECIPES[request.platform].provider
  const scopeHash = hash({ version: POST_COMMENTS_VERSION, ...identity,
    ...(migratedProvider ? { recipe: { provider: recipe.provider, key: recipe.key } } : {}) })
  const legacyScopeHash = migratedProvider ? hash({ version: POST_COMMENTS_VERSION, ...identity }) : null
  let page = 1, expiresAt = Date.now() + 86400000, previousDeliveryId = null,
    legacyProviderCursor = request.legacyRedditCursor === true || request.legacyKuaishouCursor === true
  const importedContinuation = Boolean(request.initialParams && Object.keys(request.initialParams).length)
  if (request.cursor?.startsWith('mxds1.')) {
    if (importedContinuation) throw invalidCursor()
    try {
      const state = codec.decode(request.cursor)
      legacyProviderCursor = allowHistoricalProviderCursor && legacyScopeHash !== null && state.scopeHash === legacyScopeHash
      if (state.version !== POST_COMMENTS_VERSION || state.scopeHash !== scopeHash && !legacyProviderCursor
        || state.provider != null && state.provider !== recipe.provider
        || !uuid(state.previousDeliveryId) || !Number.isInteger(state.page) || state.page < 2 || state.page > 15
        || !Number.isSafeInteger(state.expiresAt) || state.expiresAt <= Date.now() && !(['reddit', 'kuaishou'].includes(request.platform) && legacyProviderCursor)
        || body.page != null && Number(body.page) !== state.page) throw new Error('cursor')
      ;({ page, expiresAt, previousDeliveryId } = state)
    } catch { throw invalidCursor() }
  } else if (request.cursor && /^mx[a-z0-9]+\./u.test(request.cursor)
    || request.cursor && !importedContinuation || request.page !== 1 && !importedContinuation) throw invalidCursor()
  return { ...request, jobs: request.jobs.map(job => ({ ...job, id: scopeHash })), scopeHash, page, expiresAt,
    previousDeliveryId, importedContinuation, legacyProviderCursor, deliveryMode: 'live_only',
    // TikHub pages without a trusted end flag buy one page per request. Zhihu
    // still relays Zhihu's own is_end, so it keeps filling count as before.
    // Threads: no live page has proven end_cursor yet, so never auto-buy one.
    manualProviderPagination: ['twitter', 'reddit', 'kuaishou', 'weibo'].includes(request.platform) && recipe.provider === 'tikhub' || request.platform === 'threads',
    fingerprintBody: { ...identity, initialParams: request.initialParams ?? null, cursor: request.cursor ?? null },
    encodeNext: deliveryId => codec.encode({ version: POST_COMMENTS_VERSION, scopeHash, provider: recipe.provider,
      page: page + 1, expiresAt, previousDeliveryId: deliveryId }) }
}

// Each comment carries the identities the replies interface needs, so callers
// pass it back unchanged instead of assembling per-platform parameters.
const REPLY_PLATFORMS = new Set(commentRoutePlatforms('comment-replies'))
// Reddit names a comment's hidden replies by its tree cursor, carried here too.
const withReplyRef = (platform, row) => REPLY_PLATFORMS.has(platform) && row.commentId
  ? { ...row, replyRef: { platform, commentId: row.commentId, contentId: row.contentId ?? null, ...(row.replyCursor ? { cursor: row.replyCursor } : {}) } } : row

export function postCommentsDeliveryBody(request, { rowsByJob, state, calls, warnings, deliveryId }) {
  const job = state.jobs[0], items = rowsByJob[0].map(row => withReplyRef(request.platform, row))
  const remaining = Boolean(job.buffer || !job.done && job.upstreamPages < 15)
  const hasNext = remaining && request.page < 15
  const nextCursor = hasNext ? request.encodeNext(deliveryId) : null
  if (remaining && request.page === 15) warnings.push({ code: 'page_limit_reached', message: 'The comments traversal reached its response-page limit; restart explicitly.' })
  if (request.importedContinuation) warnings.push({ code: 'imported_continuation', message: 'A supplied provider continuation starts a new bounded Hub traversal; preceding pages are outside this response.' })
  const incomplete = warnings.some(row => ['pagination_completeness_unknown', 'upstream_pagination_stopped', 'repeated_cursor'].includes(row.code))
  const limited = warnings.some(row => ['page_limit_reached', 'upstream_page_limit_reached'].includes(row.code))
  // A saved cursor allows an explicit next request without proving that its
  // response will contain more comments. Buffered paid rows do prove more data.
  const unknownContinuation = request.manualProviderPagination && !job.buffer && incomplete
  const paginationStatus = nextCursor ? unknownContinuation ? 'unknown' : 'continuable'
    : limited ? 'limit_reached' : incomplete ? 'unknown' : 'exhausted'
  const page = { page: request.page, pageSize: request.pageSize, returnedCount: items.length,
    duplicateCount: job.duplicateCount || 0, hasMore: nextCursor ? unknownContinuation ? null : true : incomplete || limited ? null : false,
    nextCursor, providerCursor: nextCursor, nextPage: null, nextParams: nextCursor ? { cursor: nextCursor } : null,
    paginationMode: 'cursor', paginationStatus,
    ...(request.manualProviderPagination ? { continuationAvailable: Boolean(nextCursor) } : {}) }
  return { contractVersion: POST_COMMENTS_VERSION, data: { platform: request.platform, postId: request.postId,
    items, comments: structuredClone(items), raw_info: '[]', raw_data: JSON.stringify(items), page,
    pageInfo: { ...structuredClone(page), pageIndex: request.page, cursorType: nextCursor ? 'opaque' : 'none' },
    status: warnings.length || nextCursor ? 'partial' : 'ok', warnings,
    meta: { implementation: 'hub', scope: 'single_post', resultCount: items.length, providerCalls: calls,
      upstreamCallCount: calls, upstreamPages: job.upstreamPages, maxUpstreamPages: 15, paginationStatus,
      repliesIncluded: items.some(row => row.parentCommentId != null), repliesFetched: false } }, requestId: deliveryId }
}

export function postCommentsPlan({ gateway, context, input, dependencies }) {
  if (input.path !== POST_COMMENTS_PATH) throw new AppError(404, 'not_found', 'Unknown post comments route')
  if (!gateway.operationControlStore) throw new AppError(503, 'external_platform_contract_unverified', 'Comments require reviewed operation controls')
  const codec = createDataSearchCursorCodec(gateway.apiKeyPepper, `${context.consumer.id}:${context.apiKey.id}:post-comments`)
  let request
  return { input, plan: { operation: POST_COMMENTS_CAPABILITY, authorizationPlatform: input.platform,
    capabilityMessage: 'Post comments are not granted for this API key', replayReleasedFailures: true,
    normalize: ({ policy }) => {
      request = normalizePostCommentsDelivery(input.body, { context, maxPageSize: policy.maxPageSize, codec,
        allowHistoricalProviderCursor: true, provider: gateway.providerKey })
      if (request.platform !== input.platform || request.provider !== gateway.providerKey) {
        throw new AppError(503, 'external_platform_unavailable', 'The configured comments provider does not match this platform')
      }
      return (request = withSinglePage(request, input.singlePage))
    },
    assemble: ({ delivery, deadlineAt, signal }) => {
      // Normalize happens before the gateway's immutable historical replay.
      // Accept the old identity only for that replay; never resume it live.
      if (request.legacyProviderCursor) throw invalidCursor()
      return runSocialAccountWorkflow({ gateway, context, request, delivery,
        deadlineAt, signal, ...dependencies, workflowKind: 'post-comments',
        buildResponse: values => postCommentsDeliveryBody(request, { ...values, deliveryId: delivery.usageRequestId }) })
    },
  } }
}

// The supplier that issued a signed comments cursor. Routing reads it before
// choosing a gateway so a traversal never changes supplier mid-way. Cursors
// issued before routing carry no supplier and resume on the baseline recipe.
export function postCommentsCursorProvider(body, { gateway, context }) {
  const cursor = typeof body?.cursor === 'string' ? body.cursor
    : typeof body?.params?.cursor === 'string' && body.params.cursor.startsWith('mxds1.') ? body.params.cursor : null
  if (!cursor?.startsWith('mxds1.')) return null
  try {
    const state = createDataSearchCursorCodec(gateway.apiKeyPepper, `${context.consumer.id}:${context.apiKey.id}:post-comments`).decode(cursor)
    return typeof state.provider === 'string' ? state.provider : 'baseline'
  } catch { return null }
}
