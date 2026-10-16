import {
  normalizeXiaohongshuSearchRequest, normalizeTikHubXiaohongshuSearchResponse,
  XIAOHONGSHU_SEARCH_OPERATION, XIAOHONGSHU_SEARCH_CONTRACT_VERSION,
  TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_KEY, TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_VERSION,
} from './tikhub-xiaohongshu-search.mjs'
import { projectWeiboSearch } from './raw-search.mjs'

// The buffered standard view keeps the established XHS operation/release and
// procurement identity. The native catalog supplies only its fixed wire schema.
export const xiaohongshuSearchOperation = Object.freeze({
  operation: XIAOHONGSHU_SEARCH_OPERATION,
  endpointKey: TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_KEY,
  endpointVersion: TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_VERSION,
  endpointContractVersion: XIAOHONGSHU_SEARCH_CONTRACT_VERSION,
})
const object = value => value != null && typeof value === 'object' && !Array.isArray(value)
const text = (...values) => values.find(value => typeof value === 'string' && value.trim()) || ''
const id = (...values) => values.map(value => Number.isSafeInteger(value) ? String(value) : value)
  .find(value => typeof value === 'string' && value.trim() && value.length <= 256 && !value.includes('\0')) || null
const array = value => Array.isArray(value) ? value : []
const urls = (...values) => [...new Set(values.flat(3).filter(value => typeof value === 'string' && /^https?:\/\/[^\s]+$/u.test(value)))]
const urlList = value => array(value?.url_list)
const count = (...values) => {
  for (const value of values) if ((typeof value === 'number' || typeof value === 'string' && /^\d+$/u.test(value.trim()))
    && Number.isSafeInteger(Number(value)) && Number(value) >= 0) return Number(value)
  return null
}
const timestamp = value => {
  if (typeof value !== 'number' && typeof value !== 'string' || value === '') return null
  const n = Number(value), date = new Date(Number.isFinite(n) ? n < 1e12 ? n * 1000 : n : value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
function rowFor(item) {
  return { content_id: item.externalId, platform_name: item.platform, content_type: item.contentType,
    title: item.title, text: item.text, full_text: item.text, content: item.text, url: item.url, original_url: item.url,
    created_at: item.publishedAt, collected_at: item.collectedAt, author_id: item.author.id,
    author_name: item.author.name, author_avatar_url: item.author.avatarUrl,
    like_count: item.metrics.likes, reply_count: item.metrics.comments, forward_count: item.metrics.shares,
    view_count: item.metrics.views, bookmark_count: item.metrics.bookmarks,
    cover_url: item.media.coverUrl, image_urls: JSON.stringify(item.media.images), video_urls: JSON.stringify(item.media.videos),
    standard_item: item }
}
function tiktokItem(value, capturedAt) {
  const externalId = id(value.id, value.aweme_id, value.video_id)
  if (!externalId) throw new Error('invalid_content_search_identity')
  const author = object(value.author) ? value.author : {}, stats = object(value.stats) ? value.stats : object(value.statistics) ? value.statistics : {}
  const video = object(value.video) ? value.video : {}, handle = text(author.uniqueId, author.unique_id)
  const images = urls(array(value.imagePost?.images).flatMap(image => urlList(image?.imageURL)),
    array(value.images).flatMap(image => [...urlList(image), ...urlList(image?.display_image), image?.url]))
  const videos = urls(video.playAddr, video.downloadAddr, urlList(video.play_addr), urlList(video.download_addr),
    array(video.bit_rate).flatMap(entry => urlList(entry?.play_addr)), value.video_url)
  return { id: `tiktok:${externalId}`, externalId, platform: 'tiktok', contentType: images.length ? 'image' : 'video',
    url: text(value.share_url, value.url) || `https://www.tiktok.com/@${encodeURIComponent(handle || 'i')}/video/${externalId}`,
    title: text(value.title) || null, text: text(value.desc, value.description, value.text, value.title) || null,
    publishedAt: timestamp(value.createTime ?? value.create_time), collectedAt: capturedAt,
    author: { id: id(author.id, author.uid, author.secUid, author.sec_uid), name: text(author.nickname, handle) || null,
      avatarUrl: urls(author.avatarThumb, author.avatarMedium, urlList(author.avatar_thumb), urlList(author.avatar_medium))[0] || null },
    metrics: { likes: count(stats.diggCount, stats.digg_count), comments: count(stats.commentCount, stats.comment_count),
      shares: count(stats.shareCount, stats.share_count), views: count(stats.playCount, stats.play_count),
      bookmarks: count(stats.collectCount, stats.collect_count) },
    media: { coverUrl: urls(video.cover, video.originCover, video.dynamicCover, urlList(video.cover), urlList(video.origin_cover), value.cover_url)[0] || null, images, videos },
    source: { provider: null, endpointId: null } }
}
function tiktokPage(result, data, request, capturedAt) {
  if (!Array.isArray(data.data) && object(data.data)) data = data.data
  if (data.status_code != null && ![0, '0'].includes(data.status_code)) throw new Error('content_search_business_rejected')
  const entries = [data.data, data.item_list, data.itemList, data.items].find(Array.isArray)
  if (!entries || entries.length > 10000) throw new Error('invalid_content_search_shape')
  const rows = new Map(); let nonPostCount = 0, duplicateCount = 0
  for (const entry of entries) {
    if (!object(entry)) throw new Error('invalid_content_search_entry')
    const value = object(entry.item) ? entry.item : object(entry.aweme_info) ? entry.aweme_info : entry
    if (!id(value.id, value.aweme_id, value.video_id) && object(entry.user)) { nonPostCount++; continue }
    const row = rowFor(tiktokItem(value, capturedAt))
    if (rows.has(row.content_id)) duplicateCount++; else rows.set(row.content_id, row)
  }
  const more = data.has_more ?? data.hasMore
  const hasMore = more == null ? null : [true, 1, '1', 'true'].includes(more) ? true
    : [false, 0, '0', 'false'].includes(more) ? false : (() => { throw new Error('invalid_content_search_pagination') })()
  const next = data.cursor ?? data.offset ?? data.next_offset
  let nextParams = null
  if (hasMore !== false && next != null) {
    if (!Number.isSafeInteger(Number(next)) || Number(next) <= Number(request.upstreamQuery.offset)) throw new Error('invalid_content_search_continuation')
    const searchId = id(data.search_id, data.searchId, data.extra?.logid, request.upstreamQuery.search_id)
    nextParams = { offset: Number(next), ...(searchId ? { search_id: searchId } : {}) }
  }
  if (hasMore === true && !nextParams) throw new Error('missing_content_search_continuation')
  const items = [...rows.values()]
  return { ...result, items, acquiredItems: items, nonPostCount, duplicateCount,
    providerPage: { hasMore: hasMore ?? (nextParams ? true : null), nextParams, nextPage: nextParams ? request.page + 1 : null,
      paginationMode: 'compound', sourceCount: entries.length } }
}
function xiaohongshuPage(result, data, request, capturedAt) {
  // The provider's search page is independent of the requested delivery size.
  // Reuse its reviewed full-page parser and retain overflow in the shared store.
  const sourceRequest = { ...normalizeXiaohongshuSearchRequest({ platform: 'xiaohongshu', query: request.query, pageSize: 100 }), page: request.page }
  let nextState = null
  const source = normalizeTikHubXiaohongshuSearchResponse({ code: 200, data }, sourceRequest,
    { capturedAt, encodeCursor: state => { nextState = state; return 'internal-page-state' } })
  const items = source.items.map(rowFor)
  return { ...result, items, acquiredItems: items, nonPostCount: 0, duplicateCount: 0,
    providerPage: { hasMore: source.page.hasMore, nextPage: nextState?.page ?? null,
      nextParams: nextState ? { page: nextState.page, ...(nextState.searchId ? { search_id: nextState.searchId } : {}),
        ...(nextState.searchSessionId ? { search_session_id: nextState.searchSessionId } : {}) } : null,
      // The established parser closes its cursor at source page 15. Carry its
      // truncation evidence separately so exhaustion cannot become a clean
      // success, including when the archived remainder is served later.
      warnings: source.publicBody.data.warnings.filter(warning => warning.code === 'page_limit_reached'),
      paginationMode: 'compound', sourceCount: items.length } }
}
export function projectRemainingContentSearch(result, data, request, capturedAt) {
  if (request.platform === 'weibo') {
    const source = projectWeiboSearch(result, { ...request, pageSize: 1000, encodeNext: () => 'internal-page-state' })
    const items = source.items.map(row => ({ ...row, content_type: row.content_type || 'post',
      cover_url: row.cover_url ?? null, reply_count: row.comment_count })), hasMore = source.publicBody.data.page.hasMore
    // projectWeiboSearch caps its public cursor at 15. Retain the original
    // reviewed continuation rule (explicit has_next_page, or a nonempty page
    // with pagination={}) to distinguish that bound from supplier exhaustion.
    const pagination = data.parsed_data.pagination
    const limitReached = request.page >= 15 && (pagination.has_next_page === true
      || Object.keys(pagination).length === 0 && items.length > 0)
    return { ...result, items, acquiredItems: items, nonPostCount: 0, duplicateCount: 0,
      providerPage: { hasMore, nextPage: hasMore ? request.page + 1 : null,
        nextParams: hasMore ? { page: request.page + 1 } : null,
        warnings: limitReached ? [{ code: 'page_limit_reached', message: 'Weibo search reached its upstream page limit; restart explicitly.' }] : [],
        paginationMode: 'page', sourceCount: items.length } }
  }
  return request.platform === 'xiaohongshu' ? xiaohongshuPage(result, data, request, capturedAt)
    : tiktokPage(result, data, request, capturedAt)
}
