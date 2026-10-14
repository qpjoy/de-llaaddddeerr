import test from 'node:test'
import assert from 'node:assert/strict'
import fixtures from '../fixtures/tikhub-content-search.json' with { type: 'json' }
import { TIKHUB_CONTENT_SEARCH_RECIPES, normalizeTikHubContentSearchRequest,
  projectTikHubContentSearch, contentSearchLegacyRow, contentSearchDataItem } from '../../server/contracts/tikhub-content-search.mjs'
import { nativeForwardingEndpoint } from '../../server/contracts/native-forwarding.mjs'
import { rawSearchRecords } from '../../server/contracts/raw-search.mjs'

const capturedAt = '2026-10-15T04:00:00.000Z'
const request = (platform, options = {}) => normalizeTikHubContentSearchRequest({ platform, query: '城市', ...options })
const result = (payload, req) => projectTikHubContentSearch({ publicBody: { data: payload, meta: { capturedAt } },
  restrictedResponseArchive: { sha256: 'immutable-archive' } }, req)
const project = (platform, payload = fixtures[platform], options = {}) => result(structuredClone(payload), request(platform, options))

test('four fixed recipes reuse retained native endpoints and former defaults without Night-All dispatch', () => {
  for (const [platform, recipe] of Object.entries(TIKHUB_CONTENT_SEARCH_RECIPES)) {
    const endpoint = nativeForwardingEndpoint(recipe.key), normalized = request(platform)
    assert.equal(endpoint.path, recipe.path)
    assert.equal(normalized.endpointPath, recipe.path)
    assert.equal(normalized.method, recipe.method)
    assert.equal(normalized.upstreamQuery.keyword, '城市')
    assert.deepEqual(Object.keys(normalized.upstreamQuery).filter(key => !recipe.parameterNames.includes(key)), [])
  }
  assert.equal(request('douyin').key, 't.douyin_search_fetch_video_search_v1')
  assert.equal(request('douyin').upstreamQuery.sort_type, '2')
  assert.equal(request('bilibili').upstreamQuery.order, 'pubdate')
  assert.equal(request('kuaishou').upstreamQuery.sort_type, 'newest')
  assert.equal(request('zhihu').upstreamQuery.sort, 'created_time')
})

test('request mapping preserves declared sort/time filters and complete continuation state immutably', () => {
  const params = { order: 'totalrank', duration: 3, pubtime_begin_s: 1700000000, pubtime_end_s: 1800000000 }
  const before = structuredClone(params)
  const bili = request('bilibili', { params, pageSize: 75, page: 2 })
  assert.deepEqual(params, before)
  assert.deepEqual(bili.upstreamQuery, { ...params, keyword: '城市', page: 2, page_size: 75 })
  const dy = request('douyin', { params: { sort_type: '1', publish_time: '7', filter_duration: '2', content_type: '1' },
    providerCursor: { cursor: '40', search_id: 'session-1', backtrace: 'trace-1' } })
  assert.deepEqual(dy.upstreamQuery, { keyword: '城市', cursor: '40', sort_type: '1', publish_time: '7', filter_duration: '2', content_type: '1', search_id: 'session-1', backtrace: 'trace-1' })
  const ks = request('kuaishou', { params: { sort_type: 'most_likes', publish_time: 'week', duration: 'short' }, providerCursor: { pcursor: 'ks-next' } })
  assert.equal(ks.upstreamQuery.pcursor, 'ks-next')
  assert.equal(ks.upstreamQuery.publish_time, 'week')
  const zh = request('zhihu', { pageSize: 5, params: { sort: 'upvoted_count' }, providerCursor: { offset: 40, search_hash_id: 'hash-1' } })
  assert.equal(zh.upstreamQuery.limit, '5')
  assert.equal(zh.upstreamQuery.offset, 40)
  assert.equal(zh.upstreamQuery.search_hash_id, 'hash-1')
})

test('undeclared/provider/private controls and malformed native pagination fail before dispatch', () => {
  for (const params of [{ provider: 'other' }, { endpointId: 'arbitrary' }, { capability: 'user_profile' }, { cookie: 'secret' }, { time_interval: 'week' }]) {
    assert.throws(() => request('zhihu', { params }), { code: 'unsupported_fields' })
  }
  assert.throws(() => request('douyin', { providerCursor: { cursor: '20', token: 'secret' } }), { code: 'invalid_cursor' })
  assert.throws(() => request('douyin', { params: { cursor: -1 } }), { code: 'invalid_parameter' })
  assert.throws(() => request('bilibili', { params: { page_size: 1001 } }), { code: 'invalid_page_size' })
  assert.throws(() => request('bilibili', { query: ['a', 'b'] }), { code: 'invalid_query' })
  assert.equal(request('douyin', { params: { keyword: 'wrong' } }).upstreamQuery.keyword, '城市')
  assert.throws(() => request('douyin', { query: 'x'.repeat(501) }), { code: 'invalid_query' })
  assert.equal(request('douyin', { query: 'x'.repeat(2048), maxQueryLength: 2048 }).upstreamQuery.keyword.length, 2048)
})

test('Bilibili fixed payload maps evidenced native metrics, genuine zero and nullable modern values separately from legacy defaults', () => {
  const projected = project('bilibili'), row = projected.items[0], modern = contentSearchDataItem(row), legacy = contentSearchLegacyRow(row)
  assert.equal(row.content_id, '116328836961725')
  assert.equal(modern.title, '城市纪录')
  assert.equal(modern.text, '完整描述')
  assert.equal(modern.author.id, '123456789012345678')
  assert.deepEqual(modern.metrics, { likes: null, comments: 4, shares: null, views: 123, bookmarks: 9 })
  assert.equal(legacy.like_count, 0)
  assert.equal(legacy.forward_count, 0)
  assert.equal(legacy.reply_count, 4)
  assert.equal(legacy.bookmark_count, 9)
  assert.equal(legacy.user_name, modern.author.name)
  assert.equal(legacy.profile_image_url, modern.author.avatarUrl)
  assert.equal(legacy.published_at, modern.publishedAt)
  assert.equal(legacy.quote_count, 0)
  assert.equal(legacy.lang, '')
  assert.equal(legacy.is_forward, false)
  assert.equal(legacy.metadata, '{}')
  assert.deepEqual(projected.providerPage, { hasMore: true, nextParams: { page: 2 }, nextPage: 2, paginationMode: 'page', sourceCount: 1 })
  const altered = structuredClone(fixtures.bilibili)
  Object.assign(altered.data.result[0], { like_count: 0, like: 17, comment_count: 0, collect_count: 0, share_count: 0, view_count: 0, stat: { like: 18, share: 77, coin: 88 } })
  assert.deepEqual(contentSearchDataItem(project('bilibili', altered).items[0]).metrics, { likes: 0, comments: 0, shares: 0, views: 0, bookmarks: 0 })
  delete altered.data.result[0].share_count
  assert.equal(project('bilibili', altered).items[0].forward_count, null, 'unverified stat.share/coin/video_review are not invented metrics')
})

test('Bilibili grouped articles retain their type and never acquire a guessed video URL; verified stat aliases remain nullable', () => {
  const projected = project('bilibili', { result: [
    { result_type: 'video', data: [{ id: '1', title: '视频', stat: { like: 17, reply: 4, favorite: 9, view: 123, coin: 88 } }] },
    { result_type: 'article', data: [{ id: '2', title: '文章', description: '文章摘要' }] },
    { result_type: 'bili_user', data: [{ id: '3', title: '账号' }] },
  ], page: 1, numPages: 1 })
  assert.equal(projected.items.length, 2)
  assert.equal(projected.nonPostCount, 1)
  assert.deepEqual(contentSearchDataItem(projected.items[0]).metrics, { likes: 17, comments: 4, shares: null, views: 123, bookmarks: 9 })
  assert.equal(projected.items[1].content_type, 'article')
  assert.equal(projected.items[1].url, null)
  assert.equal(projected.providerPage.hasMore, false)
})

test('Douyin V1 keeps full body, exact signed media and response session/cursor without reading echo or recommendations', () => {
  const payload = structuredClone(fixtures.douyin), full = '完整正文'.repeat(900)
  payload.data[0].aweme_info.desc = full
  payload.data[0].aweme_info.statistics.cursor = 777
  const original = structuredClone(payload), projected = project('douyin', payload), modern = contentSearchDataItem(projected.items[0])
  assert.deepEqual(payload, original)
  assert.equal(modern.text, full)
  assert.equal(modern.metrics.likes, 0)
  assert.equal(modern.metrics.views, 123456)
  assert.equal(projected.items.length, 1)
  assert.deepEqual(modern.media.images, [])
  assert.equal(modern.media.coverUrl, 'https://example.test/dy-cover.jpg')
  assert.deepEqual(modern.media.videos, ['https://example.test/dy-play.mp4?signature=one', 'https://example.test/dy-play.mp4?signature=two'])
  assert.deepEqual(projected.providerPage.nextParams, { cursor: '20', search_id: 'session-1', backtrace: 'trace-1' })
  const next = request('douyin', { providerCursor: projected.providerPage.nextParams })
  assert.equal(next.upstreamQuery.search_id, 'session-1')
})

test('Douyin business_data wrapper and extra.logid preserve actual image posts and compound session state', () => {
  const projected = project('douyin', { business_data: [{ data: { aweme_info: {
    aweme_id: '123', desc: '真实图文', images: [{ url_list: ['https://example.test/real-photo.jpg'] }],
    video: { cover: { url_list: ['https://example.test/poster.jpg'] } }, statistics: { digg_count: '0' },
  } } }], has_more: 1, cursor: 20, extra: { logid: 'real-session' } })
  assert.equal(projected.items[0].content_type, 'image')
  assert.deepEqual(contentSearchDataItem(projected.items[0]).media.images, ['https://example.test/real-photo.jpg'])
  assert.equal(projected.items[0].like_count, 0)
  assert.deepEqual(projected.providerPage.nextParams, { cursor: '20', search_id: 'real-session' })
})

test('Kuaishou mixFeeds retains real photos and video alternatives and derives public links only from known public identity', () => {
  const projected = project('kuaishou'), row = projected.items[0], modern = contentSearchDataItem(row)
  assert.equal(row.content_id, '5216857423057152000')
  assert.equal(row.url, 'https://www.kuaishou.com/short-video/3xtdqvdnqd3psuc')
  assert.deepEqual(modern.media.images, ['https://example.test/ks-real-photo.jpg'])
  assert.equal(modern.media.videos.length, 2)
  assert.equal(modern.media.coverUrl, 'https://example.test/ks-cover.jpg')
  assert.equal(modern.metrics.likes, 0)
  assert.equal(modern.metrics.bookmarks, null)
  assert.deepEqual(projected.providerPage.nextParams, { pcursor: 'ks-next' })
  const internalOnly = { feeds: [{ photo_id: '5216857423057152000', caption: 'fixture' }], pcursor: 'no_more' }
  assert.equal(project('kuaishou', internalOnly).items[0].url, null)
  assert.equal(project('kuaishou', internalOnly).providerPage.hasMore, false)
})

test('Kuaishou explicit photo wrappers preserve their author and known search diagnostics are not content', () => {
  const projected = project('kuaishou', { feeds: [{ type: 'photo', user: { id: 'author-1', name: '作者' },
    photo: { photoId: 'photo-1', shareText: '完整正文', coverUrl: 'https://example.test/cover.jpg' } },
  { id: 'search_missing', title: '作品缺集' }], pcursor: 'no_more' })
  assert.equal(projected.items.length, 1)
  assert.equal(projected.nonPostCount, 1)
  assert.equal(projected.items[0].author_id, 'author-1')
  assert.equal(projected.items[0].full_text, '完整正文')
})

test('Zhihu search_result preserves original article/question titles, full content vs explicit preview and fixed next URL fields only', () => {
  const projected = project('zhihu'), answer = contentSearchDataItem(projected.items[0]), article = contentSearchDataItem(projected.items[1])
  assert.equal(projected.nonPostCount, 1)
  assert.equal(answer.title, '城市问题？')
  assert.equal(answer.text, '完整答案第一段。\n完整答案第二段。')
  assert.equal(answer.url, 'https://www.zhihu.com/question/2070091050450941275/answer/2073094725792445480')
  assert.equal(answer.metrics.likes, 0)
  assert.equal(article.title, '城市专栏')
  assert.equal(projected.items[1].body_completeness, 'provider_preview')
  assert.deepEqual(projected.providerPage.nextParams, { offset: 20, search_hash_id: 'zh-session' })
  assert.equal(Object.hasOwn(projected.providerPage.nextParams, 'q'), false)
})

test('projection retains an entire oversized page with first-wins dedup for gateway buffering and unchanged evidence', () => {
  const payload = structuredClone(fixtures.bilibili), prototype = payload.data.result[0]
  payload.data.result = Array.from({ length: 24 }, (_, index) => ({ ...prototype, id: String(index + 1), aid: String(index + 1), description: `body-${index}` }))
  payload.data.result.push({ ...prototype, id: '1', description: 'later duplicate' })
  const projected = project('bilibili', payload, { pageSize: 20 })
  assert.equal(projected.items.length, 24)
  assert.equal(projected.acquiredItems.length, 24)
  assert.equal(projected.items[0].text, 'body-0')
  assert.equal(projected.duplicateCount, 1)
  assert.deepEqual(projected.restrictedResponseArchive, { sha256: 'immutable-archive' })
  assert.equal(projected.publicBody.data.data.result.length, 25)
})

test('recognized empty/missing pagination is explicit unknown, malformed pages and unusable continuations fail closed', () => {
  assert.equal(project('bilibili', { result: [] }).providerPage.hasMore, null)
  assert.equal(project('bilibili', { result: [], page: 1, numPages: 0 }).providerPage.hasMore, false)
  assert.throws(() => project('bilibili', { result: 'bad' }), /invalid_content_search_shape/)
  assert.throws(() => project('bilibili', { data: { unrelated: [{ id: '1', title: 'recommendation' }] } }), /invalid_content_search_shape/)
  assert.throws(() => project('douyin', { data: [], has_more: true }), /missing_content_search_continuation/)
  assert.throws(() => project('douyin', { data: [], has_more: 'unknown' }), /invalid_content_search_pagination/)
  assert.throws(() => project('zhihu', { data: [], paging: { is_end: false, next: 'not a URL' } }), /invalid_content_search_continuation/)
  assert.deepEqual(project('zhihu', { data: [], paging: { is_end: true, next: 'irrelevant terminal value' } }).providerPage,
    { hasMore: false, nextParams: null, nextPage: null, paginationMode: 'offset', sourceCount: 0 })
  assert.throws(() => project('kuaishou', { feeds: [{ photo_id: Number.MAX_SAFE_INTEGER + 2, caption: 'unsafe' }], has_more: false }), /invalid_content_search_identity/)
  assert.throws(() => project('douyin', { data: [{ unrelated: { aweme_id: '1' } }], has_more: false }), /invalid_content_search_identity/)
})

test('direct acquired rows map reply/bookmark metrics and full body into the existing canonical ingestion contract without legacy default zeros', () => {
  for (const platform of Object.keys(TIKHUB_CONTENT_SEARCH_RECIPES)) {
    const rows = project(platform).acquiredItems
    const records = rawSearchRecords({ data: { raw_info: '[]', raw_data: JSON.stringify(rows) } }, platform, 'tikhub')
    assert.equal(records.length, rows.length)
    records.forEach((record, index) => {
      const row = rows[index]
      assert.equal(record.externalId, row.content_id)
      assert.equal(record.body, row.full_text)
      assert.equal(record.stableFields.author.externalId, row.author_id)
      assert.equal(record.stableFields.media.coverUrl, row.cover_url)
      for (const [field, raw] of [['likes', 'like_count'], ['comments', 'reply_count'], ['shares', 'forward_count'], ['bookmarks', 'bookmark_count'], ['views', 'view_count']]) {
        assert.equal(record.stableFields.metrics[field] ?? null, row[raw])
      }
      assert.equal(record.rawItem.reply_count, row.reply_count)
      assert.equal(record.rawItem.bookmark_count, row.bookmark_count)
    })
  }
})
