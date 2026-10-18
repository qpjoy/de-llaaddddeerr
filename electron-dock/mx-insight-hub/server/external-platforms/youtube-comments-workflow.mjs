import { createHash } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { createDataSearchCursorCodec } from './cursor.mjs'
import { normalizeYoutubeCommentsRequest, buildYoutubeCommentsDispatch, YOUTUBE_COMMENTS_VERSION,
  YOUTUBE_COMMENTS_CAPABILITY, YOUTUBE_COMMENT_PATHS } from '../contracts/youtube-comments.mjs'
import { runSocialAccountWorkflow } from './social-account-workflow.mjs'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
export function normalizeYoutubeCommentsDelivery(kind, body, { context, maxPageSize, codec }) {
  const request = normalizeYoutubeCommentsRequest(kind, body, { maxPageSize, businessId: context.consumer.businessId })
  const scopeHash = hash({ version: YOUTUBE_COMMENTS_VERSION, ...request.fingerprintBody })
  let page = 1, expiresAt = Date.now() + 86400000, previousDeliveryId = null
  if (request.cursor) {
    try {
      const state = codec.decode(request.cursor)
      if (state.version !== YOUTUBE_COMMENTS_VERSION || state.scopeHash !== scopeHash || state.kind !== kind
        || !uuid(state.previousDeliveryId) || !Number.isInteger(state.page) || state.page < 2 || state.page > 15
        || !Number.isSafeInteger(state.expiresAt) || state.expiresAt <= Date.now()
        || body.page != null && body.page !== state.page) throw new Error('cursor')
      ;({ page, expiresAt, previousDeliveryId } = state)
    } catch { throw new AppError(400, 'invalid_cursor', 'The comments cursor is invalid, expired or belongs to another request/Key; restart explicitly') }
  } else if (request.page !== 1) throw new AppError(400, 'invalid_cursor', 'Continue with the returned nextCursor, or start at page 1')
  buildYoutubeCommentsDispatch(request, { resolvedIdentity: null, providerCursor: null })
  return { ...request, scopeHash, page, expiresAt, previousDeliveryId, deliveryMode: 'live_only',
    fingerprintBody: { ...request.fingerprintBody, cursor: request.cursor },
    encodeNext: deliveryId => codec.encode({ version: YOUTUBE_COMMENTS_VERSION, kind, scopeHash,
      page: page + 1, expiresAt, previousDeliveryId: deliveryId }) }
}

export function youtubeCommentsDeliveryBody(request, { rowsByJob, state, calls, warnings, deliveryId }) {
  const job = state.jobs[0], items = rowsByJob[0], resolved = job.resolvedIdentity
  const remaining = Boolean(job.buffer || !job.done && job.upstreamPages < 15)
  const hasMore = remaining && request.page < 15
  const nextCursor = hasMore ? request.encodeNext(deliveryId) : null
  if (remaining && request.page === 15) warnings.push({ code: 'page_limit_reached', message: 'The comments traversal reached its response-page limit; restart explicitly.' })
  if (resolved?.discoveryPartial) warnings.push({ code: 'channel_video_discovery_partial', message: 'The bounded video discovery did not prove that all requested videos were found.' })
  const videos = request.kind === 'video' ? [{ videoId: request.videoId, url: `https://www.youtube.com/watch?v=${request.videoId}` }] : resolved?.videos || []
  const results = videos.map(video => ({ videoId: video.videoId, video: structuredClone(video), commentsScope: 'current_response_page',
    comments: structuredClone(items.filter(row => row.videoId === video.videoId)) }))
  const duplicateCount = job.duplicateCount || 0
  const page = { page: request.page, pageSize: request.maxComments, returnedCount: items.length, duplicateCount, hasMore,
    nextCursor, providerCursor: nextCursor, nextPage: null, nextParams: nextCursor ? { cursor: nextCursor } : null, paginationMode: 'cursor' }
  return { contractVersion: YOUTUBE_COMMENTS_VERSION, data: { platform: 'youtube',
    ...(request.kind === 'channel' ? { channel: { channelId: resolved?.channelId || request.channelId,
      channelUrl: request.channelUrl || `https://www.youtube.com/channel/${resolved?.channelId || request.channelId}` }, videos,
    videoIds: videos.map(row => row.videoId), results } : { videoId: request.videoId, comments: structuredClone(items) }),
    items, raw_info: '[]', raw_data: JSON.stringify(items), page, pageInfo: { ...structuredClone(page), pageIndex: request.page, cursorType: hasMore ? 'opaque' : 'none' },
    status: warnings.length || hasMore ? 'partial' : 'ok', warnings,
    meta: { implementation: 'hub', resultCount: items.length, totalCommentCount: items.length, duplicateCount,
      maxComments: request.maxComments, maxVideos: request.maxVideos, selectedVideoCount: videos.length,
      channelHasMoreVideos: resolved?.channelHasMoreVideos ?? false,
      scope: request.kind === 'channel' ? 'selected_channel_videos' : 'single_video',
      maxUpstreamPages: 15, upstreamPages: job.upstreamPages, upstreamCallCount: calls, providerCalls: calls,
      repliesIncluded: false } }, requestId: deliveryId }
}

export function youtubeCommentsPlan({ gateway, context, input, dependencies }) {
  const { kind, body, path } = input
  if (gateway.providerKey !== 'tikhub' || path !== YOUTUBE_COMMENT_PATHS[kind]) throw new AppError(404, 'not_found', 'Unknown YouTube comments route')
  if (!gateway.operationControlStore) throw new AppError(503, 'external_platform_contract_unverified', 'Comments require reviewed operation controls')
  const codec = createDataSearchCursorCodec(gateway.apiKeyPepper, `${context.consumer.id}:${context.apiKey.id}:youtube-comments:${kind}`)
  let request
  return { input, plan: { operation: YOUTUBE_COMMENTS_CAPABILITY, authorizationPlatform: 'youtube',
    capabilityMessage: 'YouTube comments are not granted for this API key', replayReleasedFailures: true,
    normalize: ({ policy }) => (request = normalizeYoutubeCommentsDelivery(kind, body, { context, maxPageSize: policy.maxPageSize, codec })),
    assemble: ({ delivery, deadlineAt, signal }) => runSocialAccountWorkflow({ gateway, context, request, delivery,
      deadlineAt, signal, ...dependencies, workflowKind: 'youtube-comments',
      buildResponse: values => youtubeCommentsDeliveryBody(request, { ...values, deliveryId: delivery.usageRequestId }) }),
  } }
}
