import { AppError } from '../core/errors.mjs'
import { normalizeNativeForwardingRequest } from './native-forwarding.mjs'

// These are the retained Night-All default keyword endpoints, not an editable
// URL catalog. All execution, archives, leases and public cursor signing live
// in the gateway. No Night-All module is used at runtime.
export const TIKHUB_CONTENT_SEARCH_VERSION = 'mx-insight-hub.tikhub-content-search.v1'
export const TIKHUB_CONTENT_SEARCH_RECIPES = Object.freeze(Object.fromEntries([
  ['bilibili', 'bilibili_web_fetch_general_search', 'GET', '/api/v1/bilibili/web/fetch_general_search', 'page',
    { order: 'pubdate', duration: 0, pubtime_begin_s: 0, pubtime_end_s: 0 }, ['keyword', 'order', 'page', 'page_size', 'duration', 'pubtime_begin_s', 'pubtime_end_s']],
  ['douyin', 'douyin_search_fetch_video_search_v1', 'POST', '/api/v1/douyin/search/fetch_video_search_v1', 'compound',
    { cursor: 0, sort_type: '2', publish_time: '0', filter_duration: '0', content_type: '0', search_id: '', backtrace: '' }, ['keyword', 'cursor', 'sort_type', 'publish_time', 'filter_duration', 'content_type', 'search_id', 'backtrace']],
  ['kuaishou', 'kuaishou_app_search_comprehensive', 'GET', '/api/v1/kuaishou/app/search_comprehensive', 'cursor',
    { sort_type: 'newest', publish_time: 'all', duration: 'all' }, ['keyword', 'pcursor', 'sort_type', 'publish_time', 'duration']],
  ['zhihu', 'zhihu_web_fetch_article_search_v3', 'GET', '/api/v1/zhihu/web/fetch_article_search_v3', 'offset',
    { offset: '0', show_all_topics: 0, search_source: 'Normal', search_hash_id: '', sort: 'created_time' }, ['keyword', 'offset', 'limit', 'show_all_topics', 'search_source', 'search_hash_id', 'sort']],
].map(([platform, endpointId, method, path, pagination, defaults, parameterNames]) => [platform, Object.freeze({
  platform, key: `t.${endpointId}`, endpointId, method, path, pagination,
  defaults: Object.freeze(defaults), parameterNames: Object.freeze(parameterNames),
})])))

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const string = value => typeof value === 'string' ? value : ''
const first = (...values) => values.find(value => typeof value === 'string' && value.trim()) || ''
const identity = (...values) => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() && value.length <= 256 && !value.includes('\u0000')) return value.trim()
    if (Number.isSafeInteger(value) && value > 0) return String(value)
  }
  return null
}
const count = (...values) => {
  for (const value of values) {
    if ((typeof value === 'number' || typeof value === 'string' && value.trim())
      && Number.isFinite(Number(value)) && Number(value) >= 0) return Number(value)
  }
  return null
}
const array = value => Array.isArray(value) ? value : []
const token = value => typeof value === 'string' && value.trim() && value.length <= 4096 && !value.includes('\u0000')
  ? value : Number.isSafeInteger(value) && value >= 0 ? String(value) : null
const flag = value => value == null ? null : [true, 1, '1', 'true'].includes(value) ? true
  : [false, 0, '0', 'false'].includes(value) ? false : (() => { throw new Error('invalid_content_search_pagination') })()
const html = value => string(value).replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/p\s*>/gi, '\n')
  .replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[name])
  .replace(/&#(x[\da-f]+|\d+);/gi, (match, number) => {
    const code = number[0].toLowerCase() === 'x' ? parseInt(number.slice(1), 16) : Number(number)
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : match
  }).trim()
function timestamp(value) {
  if (value == null || value === '') return null
  const numeric = typeof value === 'number' || typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)
  const date = new Date(numeric ? Number(value) < 1e12 ? Number(value) * 1000 : Number(value) : value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
function urls(...values) {
  const result = []
  for (const value of values.flat(2)) {
    const candidate = typeof value === 'string' ? value : object(value) ? first(value.url, value.playUrl, value.play_url, value.src) : ''
    const url = candidate.startsWith('//') ? `https:${candidate}` : candidate
    if (/^https?:\/\/[^\s]+$/i.test(url) && !result.includes(url)) result.push(url)
  }
  return result
}
const urlLists = value => object(value) ? array(value.url_list) : []

export function normalizeTikHubContentSearchRequest({ platform, query, pageSize = 20, params = {}, page = 1, providerCursor = null, maxPageSize = 1000, maxQueryLength = 500 }) {
  const recipe = TIKHUB_CONTENT_SEARCH_RECIPES[platform]
  if (!recipe) throw new AppError(400, 'invalid_platform', 'Unsupported content-search platform')
  if (typeof query !== 'string' || !query.trim() || query.length > maxQueryLength || query.includes('\u0000')) throw new AppError(400, 'invalid_query', 'A bounded keyword is required')
  if (!object(params) || Object.keys(params).some(name => !recipe.parameterNames.includes(name))) throw new AppError(400, 'unsupported_fields', 'Unsupported content-search parameter')
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > maxPageSize) throw new AppError(400, 'invalid_page_size', 'Invalid content-search page or page size')
  const nextNames = { bilibili: ['page'], douyin: ['cursor', 'search_id', 'backtrace'], kuaishou: ['pcursor'], zhihu: ['offset', 'search_hash_id'] }[platform]
  if (providerCursor != null && (!object(providerCursor) || Object.keys(providerCursor).some(name => !nextNames.includes(name)))) throw new AppError(400, 'invalid_cursor', 'Invalid platform continuation')
  const upstream = { ...recipe.defaults, ...params, keyword: query.trim(), ...(providerCursor || {}) }
  if (platform === 'bilibili') { upstream.page ??= page; upstream.page_size ??= pageSize }
  if (platform === 'zhihu') upstream.limit ??= String(pageSize)
  for (const name of ['page', 'page_size', 'offset', 'cursor', 'limit', 'pubtime_begin_s', 'pubtime_end_s']) {
    if (upstream[name] != null && (typeof upstream[name] === 'boolean' || !Number.isSafeInteger(Number(upstream[name])) || Number(upstream[name]) < (name === 'page' || name === 'page_size' || name === 'limit' ? 1 : 0))) throw new AppError(400, 'invalid_parameter', `${name} must be a nonnegative integer`)
  }
  const native = normalizeNativeForwardingRequest(recipe.key, { params: upstream }, { maxPageSize })
  return { ...native, platform, query: query.trim(), page, pageSize, providerCursor, recipeKey: recipe.key }
}

function baseRow(platform, id, capturedAt, values) {
  if (!id) throw new Error('invalid_content_search_identity')
  return { content_id: id, platform_name: platform, content_type: values.kind || 'video',
    title: html(values.title), text: html(values.text), full_text: html(values.text), content: html(values.text),
    url: values.url || null, original_url: values.url || null,
    created_at: timestamp(values.publishedAt), collected_at: capturedAt,
    author_id: identity(values.authorId), author_name: string(values.authorName), author_avatar_url: urls(values.avatar)[0] || null,
    like_count: values.likes ?? null, reply_count: values.comments ?? null, forward_count: values.shares ?? null,
    bookmark_count: values.bookmarks ?? null, view_count: values.views ?? null,
    cover_url: urls(values.cover)[0] || null, image_urls: JSON.stringify(urls(values.images)), video_urls: JSON.stringify(urls(values.videos)),
    ...(values.completeness ? { body_completeness: values.completeness } : {}),
  }
}
function bilibiliRow(value, capturedAt) {
  const stat = object(value.stat) ? value.stat : {}
  const id = identity(value.id, value.aid, value.bvid)
  const kind = value.type === 'article' ? 'article' : 'video'
  const url = first(value.arcurl, value.url) || (kind !== 'video' ? '' : identity(value.bvid) ? `https://www.bilibili.com/video/${value.bvid}` : /^\d+$/.test(id || '') ? `https://www.bilibili.com/video/av${id}` : '')
  return baseRow('bilibili', id, capturedAt, { kind, title: value.title, text: first(value.description, value.desc, value.text, value.title),
    url, authorId: value.mid ?? value.author_id ?? value.owner?.mid, authorName: first(value.author, value.owner?.name), avatar: first(value.upic, value.uface, value.owner?.face),
    publishedAt: value.pubdate ?? value.published_at, likes: count(value.like_count, value.like, stat.like), comments: count(value.comment_count, value.review, stat.reply),
    bookmarks: count(value.collect_count, value.favorites, stat.favorite), shares: count(value.share_count, value.shared_count), views: count(value.view_count, value.play, stat.view),
    cover: first(value.pic, value.cover_url), images: value.images, videos: [value.video_url, ...array(value.video_urls)] })
}
function douyinRow(value, capturedAt) {
  const stats = object(value.statistics) ? value.statistics : object(value.stats) ? value.stats : {}
  const author = object(value.author) ? value.author : {}, video = object(value.video) ? value.video : {}
  const id = identity(value.aweme_id, value.awemeId)
  const videos = urls(urlLists(video.play_addr), urlLists(video.download_addr), urlLists(video.play_addr_h264),
    array(video.bit_rate).flatMap(entry => urlLists(entry?.play_addr)), value.video_url)
  const cover = urls(urlLists(video.cover), urlLists(video.origin_cover), value.cover_url)[0]
  const images = array(value.images).flatMap(image => [...array(image?.url_list), ...urlLists(image?.display_image), image?.url].filter(Boolean))
  return baseRow('douyin', id, capturedAt, { title: first(value.title, value.desc), text: first(value.desc, value.text, value.title),
    kind: images.length ? 'image' : 'video', url: first(value.share_url, value.url) || `https://www.douyin.com/video/${id}`,
    authorId: author.id ?? author.uid ?? author.sec_uid, authorName: first(author.nickname, author.unique_id), avatar: [...urlLists(author.avatar_thumb), ...urlLists(author.avatar_medium)][0],
    publishedAt: value.create_time ?? value.created_at, likes: count(value.like_count, stats.digg_count, stats.like_count), comments: count(value.comment_count, stats.comment_count),
    shares: count(value.share_count, stats.share_count), bookmarks: count(value.collect_count, stats.collect_count), views: count(value.view_count, stats.play_count), cover, images, videos })
}
const plainCardObject = value => object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const cardString = value => typeof value === 'string'
const cardNumber = value => typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)
const cardNull = value => value === null
const cardBoolean = value => typeof value === 'boolean'
function cardShape(value, fields, required = []) {
  return plainCardObject(value) && required.every(key => Object.hasOwn(value, key))
    && Object.entries(value).every(([key, field]) => Object.hasOwn(fields, key) && fields[key](field))
}
function emptyCardJson(value) {
  if (!cardString(value) || value.length > 65536) return false
  try { return cardShape(JSON.parse(value), {}) } catch { return false }
}
const relatedWordImage = value => cardShape(value, {
  url_list: urls => Array.isArray(urls) && urls.length <= 100 && urls.every(cardString),
}, ['url_list'])
const relatedWordRecord = value => cardShape(value, {
  group_id: cardString, words_position: cardNumber, words_content: cardString, words_source: cardString,
  words_image: relatedWordImage, force_update_rank: cardBoolean, product_id: cardString,
}, ['words_content'])
const relatedWord = value => cardShape(value, {
  related_word: word => cardString(word) && Boolean(word.trim()), word_record: relatedWordRecord,
  related_img: cardString, rand_num: cardNumber, extra_info: extra => cardShape(extra, { words_type: cardString }),
}, ['related_word', 'word_record'])
const relatedWordData = value => cardShape(value, {
  card_tags: cardNull, hotspot_tab_config: cardNull, common_tab_config: cardNull,
  rs_extra_info: extra => cardShape(extra, {
    hide_related_words: cardNull, impr_extra: emptyCardJson, hide_related_words_id: cardNull, query_id: cardString,
  }, ['impr_extra']),
}, ['rs_extra_info'])
function relatedWordsCardMetadata(entry) {
  // This is the related-word recommendation envelope observed in the retained
  // V1 receipt, not a rule to discard all numeric type-six or empty cards.
  // Unknown fields, including null/scalar fields and encoded post containers,
  // prevent exclusion. Real native post wrappers still reach video parsing.
  return cardShape(entry, {
    type: value => value === 6,
    related_word_list: value => Array.isArray(value) && value.length > 0 && value.length <= 100,
    words_query_record: value => cardShape(value, { info: emptyCardJson, words_source: cardString, query_id: cardString }, ['info']),
    card_info: value => cardShape(value, { index: cardNumber, fingerprint: cardString, double_n: cardNumber, pos: cardNumber, first_pos: cardNumber }),
    doc_type: cardNumber, data: relatedWordData, sub_card_list: cardNull,
    ui_info: value => cardShape(value, { quality_style_corner_type: cardNumber, is_waterfall_layout: cardNumber }),
    provider_doc_id: cardNumber, provider_doc_id_str: cardString, tab: cardNull, show_tab: cardNull,
    debug_diff_info: value => cardShape(value, {}), aweme_list: cardNull, send_back: cardString,
    card_type: value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0), card_style_type: cardNumber,
    ecom_goods_list: cardNull, music_info_list: cardNull,
    debug_data: value => cardShape(value, { filter_debug_info_list: cardNull }),
    card_type_name: cardString, ops: cardNull, card_id: cardString, qishui_music_list: cardNull, shoot_position_list: cardNull,
  }, ['type', 'related_word_list', 'words_query_record', 'card_type', 'aweme_list', 'data'])
}
export function isDouyinRelatedWordsCard(entry) {
  return relatedWordsCardMetadata(entry) && entry.related_word_list.every(relatedWord)
}
export function douyinRelatedWordsCardCoverage(entry) {
  const words = entry?.related_word_list, bounded = Array.isArray(words) && words.length <= 100
  const invalidIndexes = bounded ? words.flatMap((word, index) => relatedWord(word) ? [] : [index]) : []
  return { metadataAccepted: relatedWordsCardMetadata(entry), relatedWordCount: Array.isArray(words) ? words.length : null,
    inspectedCount: bounded ? words.length : 0, invalidIndexes, truncated: Array.isArray(words) && !bounded }
}
function shareParam(value, name) {
  const match = string(value).match(new RegExp(`(?:^|[?&])${name}=([^&]+)`))
  if (!match) return ''
  try { return decodeURIComponent(match[1]) } catch { return '' }
}
function kuaishouRow(entry, capturedAt) {
  const value = object(entry.feed) ? { ...entry, ...entry.feed } : object(entry.photo) ? { ...entry, ...entry.photo } : entry
  const user = object(value.user) ? value.user : {}, stats = object(value.stats) ? value.stats : {}
  const publicId = [value.photoId, shareParam(value.share_info, 'photoId'), shareParam(value.shareInfo, 'photoId'), value.photo_id].find(id => typeof id === 'string' && id && !/^\d+$/.test(id))
  const id = identity(value.cid, value.photo_id, value.photoId, publicId, value.id)
  const videos = urls(value.main_mv_url, value.main_mv_urls, value.video_url, value.video?.url,
    array(value.streamManifest?.adaptationSet).flatMap(set => array(set?.representation).flatMap(rep => [rep?.url, ...array(rep?.backupUrl)])))
  return baseRow('kuaishou', id, capturedAt, { title: first(value.title, value.shareText, value.captionText, value.pureTitle, value.caption), text: first(value.shareText, value.share_text, value.captionText, value.pureTitle, value.captionToComment, value.caption, value.text, value.title),
    url: first(value.url, value.share_url) || (publicId ? `https://www.kuaishou.com/short-video/${publicId}` : ''),
    authorId: user.id ?? user.uid ?? value.user_id ?? shareParam(value.share_info, 'userId'), authorName: first(user.name, user.user_name, value.user_name), avatar: first(user.headurl, user.avatar, value.headurl),
    publishedAt: value.timestamp ?? value.time ?? value.created_at, likes: count(value.like_count, value.likeCount, stats.like_count), comments: count(value.comment_count, value.commentCount, stats.comment_count),
    shares: count(value.share_count, value.forward_count, stats.share_count), bookmarks: count(value.collect_count, stats.collect_count), views: count(value.view_count, value.viewCount, stats.view_count),
    cover: first(value.coverUrl, value.cover_url, value.thumbnail_url, value.main_url), images: value.images, videos })
}
function kuaishouDiagnostic(entry) {
  const value = object(entry.feed) ? { ...entry, ...entry.feed } : object(entry.photo) ? { ...entry, ...entry.photo } : entry
  const diagnosticId = first(value.external_id, value.externalId, value.id)
  if (!/^search_(quality|cover|similar|outdated|authoritative|ir?relevant|rrelevant|title|seen|missing)\d*$/i.test(diagnosticId)) return false
  const user = object(value.user) ? value.user : {}
  const stats = object(value.stats) ? value.stats : {}
  // Known feedback IDs alone are not content. Keep a matching real post when
  // it also carries identity, author, media, timestamp or metric evidence.
  return ![value.cid, value.photo_id, value.photoId, value.url, value.share_url, value.cover_url, value.coverUrl,
    value.thumbnail_url, value.main_url, value.user_id, user.id, user.uid, user.name, value.user_name,
    value.timestamp, value.time, value.created_at, value.main_mv_url, value.video_url, value.video?.url,
    ...array(value.main_mv_urls), ...array(value.images), ...array(value.streamManifest?.adaptationSet)
      .flatMap(set => array(set?.representation).flatMap(rep => [rep?.url, ...array(rep?.backupUrl)]))].some(Boolean)
    && !['like_count', 'likeCount', 'comment_count', 'commentCount', 'view_count', 'viewCount', 'share_count', 'forward_count', 'collect_count']
      .some(name => value[name] != null || stats[name] != null)
}
function zhihuRow(entry, capturedAt) {
  const value = entry.type === 'search_result' && object(entry.object) ? entry.object : entry
  const id = identity(value.id), questionId = identity(value.question?.id), author = object(value.author) ? value.author : {}
  const kind = first(value.type, 'article')
  const url = kind === 'answer' && questionId ? `https://www.zhihu.com/question/${questionId}/answer/${id}`
    : kind === 'question' ? `https://www.zhihu.com/question/${id}` : first(value.url)
  const full = first(value.content, value.content?.markdown, value.content?.html, value.text)
  const preview = first(value.excerpt, value.description, value.summary)
  return baseRow('zhihu', id, capturedAt, { title: first(value.title, value.question?.name, value.name), text: full || preview || first(value.title), kind,
    url, authorId: author.id ?? author.uid, authorName: first(author.name), avatar: first(author.avatar_url), publishedAt: value.created_time ?? value.created ?? value.published_at,
    likes: count(value.like_count, value.voteup_count), comments: count(value.comment_count), shares: count(value.share_count), bookmarks: count(value.collect_count), views: count(value.view_count, value.visits_count),
    cover: first(value.thumbnail, value.thumbnail_url), images: value.images, videos: value.videos,
    completeness: full ? 'provided_content' : preview ? 'provider_preview' : 'title_only' })
}

function selectedArray(data, paths) {
  for (const path of paths) {
    const value = path.reduce((current, key) => current?.[key], data)
    if (value != null) {
      if (!Array.isArray(value)) throw new Error('invalid_content_search_shape')
      if (value.length > 10000) throw new Error('content_search_page_too_large')
      return value
    }
  }
  if (Array.isArray(data) && data.length <= 10000) return data
  throw new Error('invalid_content_search_shape')
}
function pagination(data, request, sourceCount) {
  const platform = request.platform, input = request.upstreamQuery
  let hasMore = flag(data.has_more ?? data.hasMore), nextParams = null, nextPage = null
  if (platform === 'bilibili') {
    const total = count(data.numPages ?? data.num_pages), current = count(data.page) ?? Number(input.page)
    if (total != null) hasMore = current < total
    nextPage = current + 1
    nextParams = { page: nextPage }
  } else if (platform === 'douyin') {
    const next = token(data.cursor ?? data.next_cursor)
    const searchId = token(data.search_id ?? data.log_pb?.impr_id ?? data.extra?.logid) || token(input.search_id)
    const backtrace = token(data.backtrace) || token(input.backtrace)
    if (hasMore === true && (!next || next === String(input.cursor))) throw new Error('missing_content_search_continuation')
    if (next && next !== String(input.cursor)) { nextParams = { cursor: next, ...(searchId ? { search_id: searchId } : {}), ...(backtrace ? { backtrace } : {}) }; hasMore ??= true }
  } else if (platform === 'kuaishou') {
    const next = token(data.pcursor ?? data.next_cursor)
    if (next === 'no_more') hasMore = false
    else if (next && next !== String(input.pcursor ?? '')) { nextParams = { pcursor: next }; hasMore ??= true }
    if (hasMore === true && !nextParams) throw new Error('missing_content_search_continuation')
  } else {
    const paging = object(data.paging) ? data.paging : {}
    if (paging.is_end != null) hasMore = !flag(paging.is_end)
    let nextOffset = data.next_offset, hash = token(data.search_hash_id)
    if (hasMore !== false && typeof paging.next === 'string' && paging.next) {
      let url
      try { url = new URL(paging.next) } catch { throw new Error('invalid_content_search_continuation') }
      nextOffset ??= url.searchParams.get('offset')
      hash ||= token(url.searchParams.get('search_hash_id'))
    }
    if (hasMore !== false && nextOffset != null && nextOffset !== '') {
      if (!Number.isSafeInteger(Number(nextOffset)) || Number(nextOffset) <= Number(input.offset)) throw new Error('invalid_content_search_continuation')
      nextParams = { offset: Number(nextOffset), ...(hash || token(input.search_hash_id) ? { search_hash_id: hash || token(input.search_hash_id) } : {}) }
      hasMore ??= true
    }
    if (hasMore === true && !nextParams) throw new Error('missing_content_search_continuation')
  }
  if (hasMore === false) { nextParams = null; nextPage = null }
  // Absence of metadata is unknown, never inferred exhaustion from a short page.
  return { hasMore, nextParams, nextPage, paginationMode: TIKHUB_CONTENT_SEARCH_RECIPES[platform].pagination, sourceCount }
}

export function projectTikHubContentSearch(result, request) {
  let data = result.publicBody?.data
  if (!object(data) && !Array.isArray(data)) throw new Error('invalid_content_search_shape')
  // Known extra Bilibili / Zhihu payload envelope; never walk content objects.
  if (object(data.data) && (request.platform === 'bilibili' && data.data.result != null || request.platform === 'zhihu' && Array.isArray(data.data.data))) data = data.data
  if (data.code != null && ![0, 200, '0', '200'].includes(data.code)) throw new Error('content_search_business_rejected')
  const capturedAt = timestamp(result.publicBody?.meta?.capturedAt)
  if (!capturedAt) throw new Error('invalid_content_search_capture_time')
  let entries = selectedArray(data, { bilibili: [['result'], ['data', 'result'], ['data']], douyin: [['business_data'], ['aweme_list'], ['data'], ['items']],
    kuaishou: [['mixFeeds'], ['feeds'], ['result', 'items'], ['items'], ['data']], zhihu: [['data'], ['items']] }[request.platform])
  let nonPostCount = 0
  if (request.platform === 'bilibili') entries = entries.flatMap(entry => {
    if (!object(entry)) throw new Error('invalid_content_search_entry')
    if (entry.result_type != null && Array.isArray(entry.data)) {
      if (['video', 'article'].includes(entry.result_type)) return entry.data.map(value => {
        if (!object(value)) throw new Error('invalid_content_search_entry')
        return { ...value, type: value.type || entry.result_type }
      })
      nonPostCount += entry.data.length; return []
    }
    return [entry]
  })
  if (entries.length > 10000) throw new Error('content_search_page_too_large')
  const sourceCount = entries.length, rows = new Map()
  let duplicateCount = 0
  for (let entry of entries) {
    if (!object(entry)) throw new Error('invalid_content_search_entry')
    const type = first(entry.type, entry.itemType)
    if (['relevant_query', 'knowledge_ad', 'user', 'search_user', 'related_search', 'suggestion', 'keyword', 'hot_timing'].includes(type)) { nonPostCount++; continue }
    if (request.platform === 'kuaishou' && kuaishouDiagnostic(entry)) { nonPostCount++; continue }
    if (request.platform === 'douyin') {
      if (isDouyinRelatedWordsCard(entry)) { nonPostCount++; continue }
      entry = object(entry.data?.aweme_info) ? entry.data.aweme_info : object(entry.aweme_info) ? entry.aweme_info
        : object(entry.data) && (entry.data.aweme_id != null || entry.data.awemeId != null) ? entry.data : entry
    }
    const row = ({ bilibili: bilibiliRow, douyin: douyinRow, kuaishou: kuaishouRow, zhihu: zhihuRow })[request.platform](entry, capturedAt)
    if (rows.has(row.content_id)) duplicateCount++
    else rows.set(row.content_id, row)
  }
  const items = [...rows.values()]
  return { ...result, items, acquiredItems: items, providerPage: pagination(data, request, sourceCount), nonPostCount, duplicateCount }
}

// Legacy flat defaults are deliberately separate from truthful modern metrics.
export function contentSearchLegacyRow(row) {
  return { ...row, url: row.url || '', original_url: row.original_url || row.url || '',
    published_at: row.created_at || null, source: '',
    like_count: row.like_count ?? 0, reply_count: row.reply_count ?? 0,
    forward_count: row.forward_count ?? 0, bookmark_count: row.bookmark_count ?? 0, quote_count: 0,
    lang: '', is_forward: false, author_id: row.author_id || '', user_name: row.author_name || '',
    author_name: row.author_name || '', author_avatar_url: row.author_avatar_url || '',
    profile_image_url: row.author_avatar_url || '', cover_url: row.cover_url || '', metadata: '{}' }
}
export function contentSearchDataItem(row) {
  return { id: row.content_id, externalId: row.content_id, platform: row.platform_name, contentType: row.content_type || null,
    url: row.url || null, title: row.title || null, text: row.full_text || row.text || null,
    publishedAt: row.created_at || null, collectedAt: row.collected_at,
    author: { id: row.author_id || null, name: row.author_name || null, avatarUrl: row.author_avatar_url || null },
    metrics: { likes: row.like_count ?? null, comments: row.reply_count ?? null, shares: row.forward_count ?? null, views: row.view_count ?? null, bookmarks: row.bookmark_count ?? null },
    media: { coverUrl: row.cover_url || null, images: JSON.parse(row.image_urls), videos: JSON.parse(row.video_urls) },
    source: { provider: null, endpointId: null } }
}
