import { normalizeRawSearch } from './raw-search.mjs'
import { isNightAllDataSearchV1Envelope } from './night-all-data-search.mjs'

export const isHubDataCursor = value => typeof value === 'string' && value.startsWith('mxds1.')
export function canRouteDataSearch({ platform, pageSize, cursor }) {
  return ['weibo', 'instagram'].includes(platform) && (isHubDataCursor(cursor) || (!cursor && pageSize >= 20))
}

export function normalizeHubDataSearch(body, codec, resultType) {
  const { platform, query, pageSize, cursor } = body
  const normalized = normalizeRawSearch({ platform, pageSize,
    upstreamBody: { platform, query, count: pageSize, ...(cursor ? { cursor } : {}) } }, codec, { cursorScope: resultType })
  // Keep the exact pre-cutover data/search identity, including fresh/stable.
  return { ...normalized, fingerprintBody: { ...body, type: resultType } }
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
  const body = { data: { contractVersion: 'night-all.data-search.v1', platform: request.platform, query: request.query,
    items, pageInfo: { pageIndex: request.page, pageSize: request.pageSize, returnedCount: items.length,
      hasMore: raw.page.hasMore, nextCursor: raw.page.nextCursor, cursorType: raw.page.hasMore ? 'opaque' : 'none' },
    status: raw.status, warnings: (raw.warnings || []).map(warning => ({ code: warning.code,
      message: `${warning.count} Weibo post(s) still contain an incomplete preview; full text was not verified.` })),
    meta: { capability: 'search_posts', capabilityStatus: 'ready', paginationMode: request.platform === 'weibo' ? 'page' : 'compound',
      providerCalls: raw.meta.upstreamCallCount } } }
  if (!isNightAllDataSearchV1Envelope(body)) throw new Error('invalid_hub_data_search_projection')
  return body
}
