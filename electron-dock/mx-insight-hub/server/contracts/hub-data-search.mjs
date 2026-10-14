import { normalizeRawSearch } from './raw-search.mjs'
import { isNightAllDataSearchV1Envelope } from './night-all-data-search.mjs'
import { normalizeSearchContent } from './search-content.mjs'
import { AppError } from '../core/errors.mjs'
import { prepareNightAllCompatibilityTraversal } from '../data/night-all-pagination.mjs'

export const isHubDataCursor = value => typeof value === 'string' && value.startsWith('mxds1.')
export function canRouteDataSearch({ platform, pageSize, cursor }) {
  if (['facebook', 'twitter'].includes(platform)) return true
  return ['weibo', 'instagram'].includes(platform) && (isHubDataCursor(cursor) || (!cursor && pageSize >= 20))
}

export function normalizeHubDataSearch(body, codec, resultType, historicalCodec) {
  const { platform, query, pageSize, cursor } = body
  if (platform === 'twitter' && cursor?.startsWith('mxnc1.')) {
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
  // pageSize is a result ceiling, not a promise to fill a page. Keep one paid
  // call per delivery and expose the supplier's smaller page limit explicitly.
  const providerPageSize = platform === 'twitter' ? Math.min(pageSize, 50) : pageSize
  const normalized = normalizeRawSearch({ platform, pageSize: providerPageSize,
    upstreamBody: { platform, query, count: providerPageSize, ...(cursor ? { cursor } : {}) } }, codec,
  { cursorScope: platform === 'twitter' ? { type: resultType, pageSize } : resultType,
    ...(platform === 'twitter' ? { twitterSort: 'top' } : {}) })
  if (platform === 'twitter') normalized.providerRequest.standardSearch = true
  // Keep the exact pre-cutover data/search identity, including fresh/stable.
  return { ...normalized, pageSize, fingerprintBody: { ...body, type: resultType } }
}

// Social items use a different schema from the raw rows consumed by standard
// search and canonical ingestion. Build the shared row once, before either.
export function projectTwitterDataSearch(result) {
  const capturedAt = result.publicBody.meta.capturedAt
  const rows = result.items.map(item => ({
    content_id: item.id, platform_name: 'twitter', content_type: item.objectType, title: '',
    content: item.content, full_text: item.content, url: item.url,
    created_at: item.publishedAt, collected_at: capturedAt,
    author_id: item.author?.id ?? null, author_name: item.author?.name || item.author?.username || null,
    author_username: item.author?.username ?? null, author_avatar_url: item.author?.avatarUrl ?? null,
    like_count: item.metrics.likes, comment_count: item.metrics.replies, forward_count: item.metrics.shares,
    view_count: item.metrics.views, bookmark_count: item.metrics.bookmarks, quote_count: item.metrics.quotes,
    cover_url: item.coverUrl ?? null, image_urls: JSON.stringify(item.imageUrls), video_urls: JSON.stringify(item.videoUrls),
    metadata: { hashtags: item.tags },
  }))
  return { ...result, restrictedResponseArchive: result.restrictedResponseArchive, items: rows,
    publicBody: { ...result.publicBody, data: { ...result.publicBody.data, raw_data: JSON.stringify(rows) } } }
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
    media: { coverUrl: nullable(row.cover_url), images: urls(row.image_urls), videos: urls(row.video_urls) },
    source: { provider: null, endpointId: null },
  }))
  const warnings = [...(raw.warnings || [])]
  if (request.platform === 'twitter' && request.pageSize > request.providerRequest.count) warnings.push({
    code: 'provider_page_size_limit',
    message: 'Twitter returns at most 50 items per provider page; follow nextCursor for more results. No additional provider call was made to fill pageSize.',
  })
  const body = { data: { contractVersion: 'night-all.data-search.v1', platform: request.platform, query: request.query,
    items, pageInfo: { pageIndex: request.page, pageSize: request.pageSize, returnedCount: items.length,
      hasMore: raw.page.hasMore, nextCursor: raw.page.nextCursor, cursorType: raw.page.hasMore ? 'opaque' : 'none' },
    status: request.platform === 'twitter' && raw.page.hasMore && items.length < request.pageSize ? 'partial' : raw.status,
    warnings: warnings.map(warning => ({ code: warning.code,
      message: warning.message ?? `${warning.count} Weibo post(s) still contain an incomplete preview; full text was not verified.` })),
    meta: { capability: 'search_posts', capabilityStatus: 'ready', paginationMode: request.platform === 'twitter' ? 'cursor' : request.platform === 'weibo' ? 'page' : 'compound',
      providerCalls: raw.meta.upstreamCallCount } } }
  const projected = normalizeSearchContent(body, request.platform)
  if (!isNightAllDataSearchV1Envelope(projected)) throw new Error('invalid_hub_data_search_projection')
  return projected
}
