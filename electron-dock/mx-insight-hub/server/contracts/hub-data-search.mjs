import { normalizeRawSearch } from './raw-search.mjs'
import { isNightAllDataSearchV1Envelope } from './night-all-data-search.mjs'
import { normalizeSearchContent } from './search-content.mjs'
import { AppError } from '../core/errors.mjs'
import { prepareNightAllCompatibilityTraversal } from '../data/night-all-pagination.mjs'
import { HUB_SOCIAL_VERSION } from './hub-social.mjs'
import { facebookStandardMedia } from './facebook-search.mjs'

export const isHubDataCursor = value => typeof value === 'string' && value.startsWith('mxds1.')
export function canRouteDataSearch({ platform, pageSize, cursor }) {
  if (['facebook', 'twitter', 'instagram'].includes(platform)) return true
  return platform === 'weibo' && (isHubDataCursor(cursor) || (!cursor && pageSize >= 20))
}

export function normalizeHubDataSearch(body, codec, resultType, historicalCodec, { instagramProvider = 'tikhub', instagramStrategy = false } = {}) {
  const { platform, query, pageSize, cursor } = body
  if ((platform === 'twitter' || platform === 'instagram' && (instagramProvider === 'justone' || instagramStrategy)) && cursor?.startsWith('mxnc1.')) {
    // Decode only to preserve the old ledger identity. Replay/unknown checks
    // must run before refusing a new dispatch with a retired continuation.
    const historical = prepareNightAllCompatibilityTraversal({ operation: 'data-search',
      platform, upstreamBody: body, codec: historicalCodec })
    return { platform, pageSize, deliveryMode: 'live_only', restartRequired: true,
      fingerprintBody: { ...historical.upstreamBody, type: resultType } }
  }
  if (platform === 'twitter' && (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100)) {
    throw new AppError(400, 'page_size_exceeded', 'Twitter pageSize must be between 1 and 100')
  }
  // pageSize is a result ceiling. The bounded Twitter workflow can combine
  // source pages while each supplier request keeps its own smaller count limit.
  const providerPageSize = platform === 'twitter' ? Math.min(pageSize, 50) : pageSize
  const normalized = normalizeRawSearch({ platform, pageSize: providerPageSize,
    upstreamBody: { platform, query, count: providerPageSize, ...(cursor ? { cursor } : {}) } }, codec,
  { cursorScope: platform === 'twitter' ? { type: resultType, pageSize } : resultType,
    instagramProvider, instagramStrategy, historicalCodec,
    ...(platform === 'twitter' ? { twitterSort: 'top', twitterBuffer: true, bufferPageSize: pageSize } : {}) })
  if (platform === 'twitter') {
    normalized.providerRequest.standardSearch = true
    normalized.providerRequest.allowOverflow = true
  }
  // Keep the exact pre-cutover data/search identity, including fresh/stable.
  return { ...normalized, pageSize, resultType, fingerprintBody: { ...body, type: resultType } }
}

// Social items use a different schema from the raw rows consumed by standard
// search and canonical ingestion. Build the shared row once, before either.
export function projectTwitterDataSearch(result) {
  const capturedAt = result.publicBody.meta.capturedAt
  const row = item => ({
    content_id: item.id, platform_name: 'twitter', content_type: item.objectType, title: '',
    content: item.content, full_text: item.content, url: item.url,
    created_at: item.publishedAt, collected_at: item.collectedAt || capturedAt,
    author_id: item.author?.id ?? null, author_name: item.author?.name || item.author?.username || null,
    author_username: item.author?.username ?? null, author_avatar_url: item.author?.avatarUrl ?? null,
    like_count: item.metrics.likes, comment_count: item.metrics.replies, forward_count: item.metrics.shares,
    view_count: item.metrics.views, bookmark_count: item.metrics.bookmarks, quote_count: item.metrics.quotes,
    cover_url: item.coverUrl ?? null, image_urls: JSON.stringify(item.imageUrls), video_urls: JSON.stringify(item.videoUrls),
    metadata: { hashtags: item.tags },
  })
  const rows = result.items.map(row)
  return { ...result, restrictedResponseArchive: result.restrictedResponseArchive, items: rows,
    ...(result.acquiredItems ? { acquiredItems: result.acquiredItems.map(row) } : {}),
    publicBody: { ...result.publicBody, data: { ...result.publicBody.data, raw_data: JSON.stringify(rows) } } }
}

// One logical page may combine a verified archived remainder and newly paid
// pages. Durable predecessor/source references stay in the signed cursor;
// delivered IDs are read server-side rather than growing the cursor token.
export function projectTwitterSearchFillDelivery({ items, capturedAt, buffer = null, providerCursor = null,
  upstreamPages, upstreamCallCount, stopReason = null, duplicateCount = 0, discardedCount = 0,
  sourcePartial = false, previousDeliveryId }, request) {
  const more = Boolean(buffer || providerCursor) && request.page < 15
    && (Boolean(buffer) || upstreamPages < 15)
  const nextCursor = more ? request.encodeNext({ page: request.page + 1, providerCursor,
    ...(buffer ? { buffer } : {}), fill: { version: 'twitter-fill.v1', previousDeliveryId, upstreamPages } }) : null
  const warnings = []
  if (stopReason) warnings.push({ code: 'TWITTER_PAGE_FILL_STOPPED',
    message: 'Twitter returned a partial page because the bounded continuation could not acquire more results.' })
  if (discardedCount || sourcePartial) warnings.push({ code: 'TWITTER_ITEMS_DISCARDED',
    message: 'The provider page contained entries that could not be projected; available items were retained.' })
  if (request.page === 15 && (buffer || providerCursor) || upstreamPages >= 15 && providerCursor && !buffer) {
    warnings.push({ code: 'TWITTER_PAGE_LIMIT_REACHED', message: 'Twitter search reached its traversal limit. Restart explicitly to search again.' })
  }
  const publicBody = { contractVersion: HUB_SOCIAL_VERSION, data: { platform: 'twitter', items,
    raw_info: '[]', raw_data: '[]',
    page: { page: request.page, pageSize: request.pageSize, returnedCount: items.length, duplicateCount,
      discardedCount, hasMore: more, nextCursor }, status: warnings.length ? 'partial' : 'ok', warnings,
    meta: { implementation: 'hub', resultCount: items.length, upstreamCallCount } }, meta: { capturedAt } }
  const result = projectTwitterDataSearch({ publicBody, items })
  result.publicBody = { ...projectDataSearch(result, request), meta: publicBody.meta }
  return result
}

const nullable = value => typeof value === 'string' && value ? value : null
const metric = value => value != null && Number.isFinite(value) && value >= 0 ? value : null
function urls(value) { return JSON.parse(value || '[]').filter(value => typeof value === 'string') }

export function projectDataSearch(result, request) {
  const raw = result.publicBody.data
  const items = result.items.map(row => ({
    id: row.content_id, externalId: row.content_id, platform: request.platform,
    contentType: row.content_type || 'post', url: nullable(row.url), title: null,
    text: nullable(row.full_text || row.text), publishedAt: row.created_at || null, collectedAt: row.collected_at || null,
    author: { id: row.author_id || null, name: nullable(row.author_name), avatarUrl: nullable(row.author_avatar_url) },
    metrics: { likes: metric(row.like_count), comments: metric(row.comment_count), shares: metric(row.forward_count),
      views: metric(row.view_count), bookmarks: metric(row.bookmark_count) },
    media: request.platform === 'facebook' ? facebookStandardMedia(row)
      : { coverUrl: nullable(row.cover_url), images: urls(row.image_urls), videos: urls(row.video_urls) },
    source: { provider: null, endpointId: null },
  }))
  const warnings = [...(raw.warnings || [])]
  if (request.platform === 'twitter' && request.pageSize > request.providerRequest.count) warnings.push({
    code: 'provider_page_size_limit',
    message: 'Twitter requests at most 50 items per provider call; Hub fills pages within its dispatch limit and retains any buffered overflow.',
  })
  const body = { data: { contractVersion: 'night-all.data-search.v1', platform: request.platform, query: request.query,
    items, pageInfo: { pageIndex: request.page, pageSize: request.pageSize, returnedCount: items.length,
      hasMore: raw.page.hasMore, nextCursor: raw.page.nextCursor, cursorType: raw.page.hasMore ? 'opaque' : 'none' },
    status: ['twitter', 'facebook'].includes(request.platform) && raw.page.hasMore && items.length < request.pageSize ? 'partial' : raw.status,
    warnings: warnings.map(warning => ({ code: warning.code,
      message: warning.message ?? `${warning.count} Weibo post(s) still contain an incomplete preview; full text was not verified.` })),
    meta: { capability: 'search_posts', capabilityStatus: 'ready', paginationMode: request.platform === 'twitter'
      || (request.platform === 'instagram' && request.provider === 'justone') ? 'cursor' : request.platform === 'weibo' ? 'page' : 'compound',
      providerCalls: raw.meta.upstreamCallCount } } }
  const projected = normalizeSearchContent(body, request.platform)
  if (!isNightAllDataSearchV1Envelope(projected)) throw new Error('invalid_hub_data_search_projection')
  return projected
}
