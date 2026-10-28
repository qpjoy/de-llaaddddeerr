import test from 'node:test'
import assert from 'node:assert/strict'
import originalFixtures from '../fixtures/tikhub-content-search.json' with { type: 'json' }
import { TIKHUB_CONTENT_SEARCH_RECIPES, normalizeTikHubContentSearchRequest,
  projectTikHubContentSearch, contentSearchLegacyRow, contentSearchDataItem,
  isKuaishouRelatedSearchesCard, kuaishouRelatedSearchesCardCoverage } from '../../server/contracts/tikhub-content-search.mjs'
import { nativeForwardingEndpoint } from '../../server/contracts/native-forwarding.mjs'
import { rawSearchRecords } from '../../server/contracts/raw-search.mjs'
import { isPostgresSafeJsonValue } from '../../server/core/postgres-json.mjs'
import { projectContentPage } from '../../server/external-platforms/content-search-workflow.mjs'

const capturedAt = '2026-10-15T04:00:00.000Z'
const fixtures = { ...originalFixtures,
  twitter: { timeline: [{ tweet_id: '7111111111111111111', text: '完整正文', created_at: '2026-10-15T03:00:00Z', replies: 3, favorites: 0 }], next_cursor: '' },
  tiktok: { data: [{ item: { id: '7111111111111111111', desc: '完整正文', stats: { diggCount: 0, commentCount: 3 } } }], has_more: false },
  weibo: { parsed_data: { results: [{ weibo_id: '7111111111111111111', longText: { content: '完整正文' }, interaction: { comments: 3 } }], pagination: { has_next_page: false } } },
  xiaohongshu: { page: 1, next_page: null, data: { items: [{ model_type: 'note', note: { id: '675d277d000000000600e655', desc: '完整正文' } }] } },
}
const request = (platform, options = {}) => normalizeTikHubContentSearchRequest({ platform, query: '城市', ...options })
const result = (payload, req) => projectTikHubContentSearch({ publicBody: { data: payload, meta: { capturedAt } },
  restrictedResponseArchive: { sha256: 'immutable-archive' } }, req)
const project = (platform, payload = fixtures[platform], options = {}) => result(structuredClone(payload), request(platform, options))

test('fixed recipes reuse retained native endpoints and former defaults without Night-All dispatch', () => {
  for (const [platform, recipe] of Object.entries(TIKHUB_CONTENT_SEARCH_RECIPES)) {
    const endpoint = nativeForwardingEndpoint(recipe.key), normalized = request(platform)
    assert.equal(endpoint.path, recipe.path)
    assert.equal(normalized.endpointPath, recipe.path)
    assert.equal(normalized.method, recipe.method)
    assert.equal(normalized.upstreamQuery[['reddit', 'weibo'].includes(platform) ? 'query' : 'keyword'], '城市')
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

test('Bilibili search keeps the item share URL ahead of stale URL aliases', () => {
  const payload = structuredClone(fixtures.bilibili)
  Object.assign(payload.data.result[0], {
    share_url: 'https://www.bilibili.com/video/BVshare123',
    arcurl: 'https://www.bilibili.com/video/BVstale456',
  })
  assert.equal(contentSearchDataItem(project('bilibili', payload).items[0]).url,
    'https://www.bilibili.com/video/BVshare123')
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

// Reconstructed from the verified archive's field types/counts, not its raw body.
const biliEmptyPage = () => ({ code: 0, data: { page: 1, pagesize: 20, numResults: 0, numPages: 0 } })

test('Bilibili successful zero-count page may omit result and ends pagination without changing evidence', () => {
  const payload = biliEmptyPage()
  const original = { publicBody: { data: payload, meta: { capturedAt } }, restrictedResponseArchive: { sha256: 'immutable-archive' } }
  const before = structuredClone(original)
  const { projected, records } = projectContentPage(original, request('bilibili', { pageSize: 20 }))
  assert.deepEqual(projected.items, [])
  assert.deepEqual(projected.acquiredItems, [])
  assert.deepEqual(records, [])
  assert.deepEqual(projected.providerPage, { hasMore: false, nextParams: null, nextPage: null, paginationMode: 'page', sourceCount: 0 })
  assert.equal(projected.nonPostCount, 0)
  assert.equal(projected.duplicateCount, 0)
  assert.deepEqual(original, before)
  assert.equal(projected.publicBody, original.publicBody)
  assert.equal(projected.restrictedResponseArchive, original.restrictedResponseArchive)
  assert.equal(Object.hasOwn(projected.publicBody.data.data, 'result'), false)
})

test('Bilibili omitted result needs explicit numeric zero counts and matching page metadata', () => {
  const mutations = [
    p => { delete p.code }, p => { p.code = '0' }, p => { p.code = 200 },
    ...['numResults', 'numPages'].flatMap(key => [
      p => { delete p.data[key] },
      ...[1, -1, '0', false, null].map(value => p => { p.data[key] = value }),
    ]),
    ...['page', 'pagesize'].flatMap(key => [
      p => { delete p.data[key] },
      ...[0, -1, '1', false, null, 1.5, Number.MAX_SAFE_INTEGER + 1, 21].map(value => p => { p.data[key] = value }),
    ]),
    ...[null, 'bad', {}].map(value => p => { p.data.result = value }),
    ...['data', 'items', 'results', 'list', 'videos'].map(key => p => { p.data[key] = [{ id: 'unexpected-content' }] }),
    p => { p.data.num_results = 1 }, p => { p.data.num_pages = 1 }, p => { p.data.page_size = 21 },
    ...['has_more', 'hasMore'].flatMap(key => [true, 1, 'unknown'].map(value => p => { p.data[key] = value })),
    p => { p.data.next_page = 2 }, p => { p.data.nextPage = 2 }, p => { p.data.next_cursor = 'next' },
  ]
  for (const mutate of mutations) {
    const payload = biliEmptyPage()
    mutate(payload)
    assert.throws(() => project('bilibili', payload, { pageSize: 20 }), /invalid_content_search_shape/, JSON.stringify(payload))
  }
  assert.throws(() => project('bilibili', biliEmptyPage(), { page: 2, pageSize: 20 }), /invalid_content_search_shape/)
  assert.throws(() => project('douyin', biliEmptyPage(), { pageSize: 20 }), /invalid_content_search_shape/)
})

test('Bilibili business rejection is checked before and after unwrapping the result page', () => {
  for (const payload of [
    { code: -412, data: { result: [], page: 1, numPages: 0 } },
    { ...biliEmptyPage(), code: -412 },
    { code: 0, data: { ...biliEmptyPage().data, code: -412 } },
    { code: 0, data: { result: [], code: -412 } },
  ]) assert.throws(() => project('bilibili', payload, { pageSize: 20 }), /content_search_business_rejected/)
})

test('Bilibili omitted inner result never overrides an existing outer result list', () => {
  const payload = { ...biliEmptyPage(), result: [{ id: '1', type: 'video', title: 'Existing outer result' }] }
  const projected = project('bilibili', payload, { pageSize: 20 })
  assert.equal(projected.items.length, 1)
  assert.equal(projected.items[0].content_id, '1')
  assert.equal(projected.providerPage.hasMore, null)
  assert.throws(() => project('bilibili', { ...biliEmptyPage(), result: null }, { pageSize: 20 }), /invalid_content_search_shape/)
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

test('Douyin fixed direct/data/aweme_info wrappers preserve snake and camel native IDs regardless of numeric card type', () => {
  const wrappers = [value => value, value => ({ data: value }), value => ({ aweme_info: value }), value => ({ data: { aweme_info: value } })]
  for (const wrap of wrappers) for (const alias of ['aweme_id', 'awemeId']) for (const type of [1, 6]) {
    const payload = { data: [{ type, ...wrap({ [alias]: '123', desc: '真实视频正文',
      video: { play_addr: { url_list: ['https://example.test/play.mp4?signature=unchanged'] } },
      statistics: { digg_count: 0 } }) }], has_more: false }
    const original = structuredClone(payload), projected = project('douyin', payload)
    assert.equal(projected.items.length, 1)
    assert.equal(projected.nonPostCount, 0)
    assert.equal(projected.items[0].content_id, '123')
    assert.equal(projected.items[0].full_text, '真实视频正文')
    assert.deepEqual(contentSearchDataItem(projected.items[0]).media.videos, ['https://example.test/play.mp4?signature=unchanged'])
    assert.equal(projected.items[0].like_count, 0)
    assert.deepEqual(payload, original)
    assert.deepEqual(projected.restrictedResponseArchive, { sha256: 'immutable-archive' })
  }
  assert.equal(project('douyin', { data: [{ type: 6, data: { awemeId: 123, desc: '安全整数身份' } }], has_more: false }).items[0].content_id, '123')
})

test('Douyin fixed wrappers still reject absent or unsafe IDs and unknown numeric cards rather than silently dropping them', () => {
  const wrappers = [value => value, value => ({ data: value }), value => ({ aweme_info: value }), value => ({ data: { aweme_info: value } })]
  for (const wrap of wrappers) for (const alias of ['aweme_id', 'awemeId']) for (const id of [undefined, null, '', 0, -1, Number.MAX_SAFE_INTEGER + 1, {}, '\u0000']) {
    assert.throws(() => project('douyin', { data: [{ type: 6, ...wrap({ [alias]: id, desc: '有正文但无有效身份', video: {} }) }], has_more: false }), /invalid_content_search_identity/)
  }
  assert.throws(() => project('douyin', { data: [{ type: 6, data: { unknown: {} } }], has_more: false }), /invalid_content_search_identity/)
  assert.throws(() => project('douyin', { data: [{ type: 6, data: { unrelated: { awemeId: '123' } } }], has_more: false }), /invalid_content_search_identity/)
})

// Exact field names/kinds from the v6 incident schema; scalar values and all six
// recommendation entries are synthetic, not the original restricted receipt.
const relatedWordsDouyinCard = () => ({ type: 6,
  data: { card_tags: null, rs_extra_info: { hide_related_words: null, impr_extra: '{}', hide_related_words_id: null, query_id: 'fixture-query' }, hotspot_tab_config: null, common_tab_config: null },
  related_word_list: Array.from({ length: 6 }, (_, index) => ({ related_word: `fixture-related-${index}`,
    word_record: { group_id: `fixture-group-${index}`, words_position: index, words_content: `fixture-related-${index}`, words_source: 'fixture-source',
      words_image: { url_list: [`https://example.test/recommendation-${index}.jpg`] }, force_update_rank: false, product_id: 'fixture-product' },
    related_img: '', rand_num: 0, extra_info: { words_type: 'fixture-type' } })),
  words_query_record: { info: '{}', words_source: 'fixture-source', query_id: 'fixture-query' },
  card_info: { index: 4, fingerprint: 'fixture-fingerprint', double_n: 0, pos: 4, first_pos: 4 }, doc_type: 0, sub_card_list: null,
  ui_info: { quality_style_corner_type: 0, is_waterfall_layout: 0 }, provider_doc_id: 0, provider_doc_id_str: 'fixture-doc', tab: null, show_tab: null,
  debug_diff_info: {}, aweme_list: null, send_back: 'fixture-send-back', card_type: 42, card_style_type: 0,
  ecom_goods_list: null, music_info_list: null, debug_data: { filter_debug_info_list: null }, card_type_name: 'fixture-card', ops: null,
  card_id: 'fixture-card-id', qishui_music_list: null, shoot_position_list: null })

test('Douyin known related-words card preserves all eight raw entries while projecting seven real posts', () => {
  const entries = Array.from({ length: 7 }, (_, index) => ({ type: 1, aweme_info: {
    aweme_id: String(index + 1), desc: `完整正文-${index}`, video: { play_addr: { url_list: [`https://example.test/${index}.mp4`] } },
    statistics: { digg_count: 0 },
  } }))
  entries.splice(4, 0, relatedWordsDouyinCard())
  assert.equal(Object.keys(entries[4]).length, 25)
  assert.equal(entries[4].related_word_list.length, 6)
  const payload = { data: entries, aweme_list: null, has_more: 1, cursor: 20, backtrace: 'fixed-trace', extra: { logid: 'fixed-session' } }
  const original = structuredClone(payload), projected = project('douyin', payload)
  assert.equal(projected.items.length, 7)
  assert.equal(projected.nonPostCount, 1)
  assert.equal(projected.duplicateCount, 0)
  assert.equal(projected.providerPage.sourceCount, 8)
  assert.deepEqual(projected.providerPage.nextParams, { cursor: '20', search_id: 'fixed-session', backtrace: 'fixed-trace' })
  assert.equal(projected.publicBody.data.data.length, 8)
  assert.deepEqual(projected.publicBody.data, original)
  assert.deepEqual(projected.restrictedResponseArchive, { sha256: 'immutable-archive' })
  assert.ok(isPostgresSafeJsonValue(projected.acquiredItems))
  assert.deepEqual(payload, original)
})

test('Douyin related-words recognition never hides real type-six posts in fixed native wrappers', () => {
  const wrappers = [value => value, value => ({ data: value }), value => ({ aweme_info: value }), value => ({ data: { aweme_info: value } })]
  for (const wrap of wrappers) for (const alias of ['aweme_id', 'awemeId']) {
    const card = { ...relatedWordsDouyinCard(), ...wrap({ [alias]: 'real-6', desc: '真实 type6 视频', video: {}, statistics: { digg_count: 0 } }) }
    const projected = project('douyin', { data: [card], has_more: false })
    assert.equal(projected.nonPostCount, 0)
    assert.equal(projected.items[0].content_id, 'real-6')
    assert.equal(projected.items[0].full_text, '真实 type6 视频')
  }
})

test('Douyin related-words recognition fails closed on material signals, potential post containers and invalid native identities', () => {
  const signals = { aweme_id: Number.MAX_SAFE_INTEGER + 1, awemeId: '', id: 'unmapped-identity',
    desc: '', text: '', title: '', content: '', full_text: '', description: '', caption: '',
    video: {}, images: [], author: {}, statistics: {}, stats: {},
    create_time: 0, created_at: 0, share_url: '', url: '', video_url: '', cover_url: '',
    like_count: 0, comment_count: 0, share_count: 0, collect_count: 0, view_count: 0, aweme_info: {}, aweme: {}, aweme_detail: {},
    aweme_list: [], business_data: [], item: {}, items: [], list: [], object: {} }
  for (const location of ['outer', 'data']) for (const [name, value] of Object.entries(signals)) {
    const card = relatedWordsDouyinCard()
    if (location === 'outer') card[name] = value
    else card.data[name] = value
    assert.throws(() => project('douyin', { data: [card], has_more: false }), /invalid_content_search_identity/, `${location}.${name} prevents non-post exclusion`)
    if (location !== 'outer' || name !== 'aweme_list') {
      const nullCard = relatedWordsDouyinCard()
      if (location === 'outer') nullCard[name] = null
      else nullCard.data[name] = null
      assert.throws(() => project('douyin', { data: [nullCard], has_more: false }), /invalid_content_search_identity/, `present ${location}.${name}=null is not the observed missing field`)
    }
  }
})

test('Douyin related-words recognition never discards unknown composite payloads at outer or data scope', () => {
  for (const location of ['outer', 'data']) for (const value of [{}, [], { awemeId: 'unrecognized-nested-post', desc: '潜在真实内容' }, [{ aweme_id: 'unrecognized-carousel-post' }]]) {
    const card = relatedWordsDouyinCard()
    if (location === 'outer') card.unknownComposite = value
    else card.data.unknownComposite = value
    assert.throws(() => project('douyin', { data: [card], has_more: false }), /invalid_content_search_identity/)
  }
})

test('Douyin related-words recognition requires the exact numeric discriminators and explicit null/object envelope', () => {
  const changes = [{ type: '6' }, { type: 1 }, { type: 7 }, { card_type: undefined }, { card_type: '42' },
    { card_type: null }, { card_type: NaN }, { card_type: Infinity }, { card_type: 1.5 }, { card_type: -1 },
    { aweme_list: undefined }, { aweme_list: [] }, { aweme_list: {} }, { data: undefined }, { data: null }, { data: [] }, { data: 'unknown' }]
  for (const change of changes) {
    assert.throws(() => project('douyin', { data: [{ ...relatedWordsDouyinCard(), ...change }], has_more: false }), /invalid_content_search_identity/)
  }
  assert.throws(() => project('douyin', { data: [{ type: 6, card_type: 42, aweme_list: null,
    data: { opaqueA: 1, opaqueB: '', opaqueC: null, opaqueD: false } }], has_more: false }), /invalid_content_search_identity/,
  'the superseded scalar-only candidate is not retained as a general type-six exclusion')
})

test('Douyin related-words recognition validates every word, including unsampled third and sixth entries', () => {
  const rejected = [row => { delete row.related_word }, row => { row.related_word = 123 }, row => { row.word_record = null },
    row => { row.aweme_info = { aweme_id: 'hidden-real-post', desc: '潜在帖子' } },
    row => { row.word_record.hidden_post = { awemeId: 'hidden-real-post', video: {} } }]
  // Harmless suggestion differences no longer fail a paid page; posts still do.
  const tolerated = [row => { row.related_word = '' }, row => { row.word_record.words_image.url_list = [123] },
    row => { row.word_record.force_update_rank = 'false' }, row => { row.extra_info = [] }]
  for (const index of [2, 5]) {
    for (const change of rejected) {
      const card = relatedWordsDouyinCard()
      change(card.related_word_list[index])
      assert.throws(() => project('douyin', { data: [card], has_more: false }), /invalid_content_search_identity/, `word ${index + 1} is fully validated`)
    }
    for (const change of tolerated) {
      const card = relatedWordsDouyinCard()
      change(card.related_word_list[index])
      const projected = project('douyin', { data: [card], has_more: false })
      assert.equal(projected.items.length, 0)
      assert.equal(projected.nonPostCount, 1)
    }
  }
  for (const related_word_list of [undefined, null, [], 'not-an-array']) {
    assert.throws(() => project('douyin', { data: [{ ...relatedWordsDouyinCard(), related_word_list }], has_more: false }), /invalid_content_search_identity/)
  }
})

test('Douyin related-words envelope rejects unknown keys; word attributes are tolerated unless they hide a post', () => {
  const envelope = [card => card, card => card.data, card => card.data.rs_extra_info, card => card.words_query_record,
    card => card.card_info, card => card.ui_info, card => card.debug_diff_info, card => card.debug_data]
  const words = [card => card.related_word_list[5], card => card.related_word_list[5].word_record,
    card => card.related_word_list[5].word_record.words_image, card => card.related_word_list[5].extra_info]
  const hiddenPost = [{ aweme_id: 'hidden-post', desc: '不可静默丢弃' }]
  for (const locate of envelope) for (const value of [null, 'unknown', {}, hiddenPost]) {
    const card = relatedWordsDouyinCard()
    locate(card).unrecognized = value
    assert.throws(() => project('douyin', { data: [card], has_more: false }), /invalid_content_search_identity/)
  }
  for (const locate of words) {
    for (const value of [null, 'unknown', {}]) {
      const card = relatedWordsDouyinCard()
      locate(card).unrecognized = value
      assert.equal(project('douyin', { data: [card], has_more: false }).nonPostCount, 1)
    }
    const card = relatedWordsDouyinCard()
    locate(card).unrecognized = hiddenPost
    assert.throws(() => project('douyin', { data: [card], has_more: false }), /invalid_content_search_identity/)
  }
})

test('Douyin related-words encoded metadata must remain an empty JSON object rather than carry unknown content', () => {
  const locations = [card => [card.data.rs_extra_info, 'impr_extra'], card => [card.words_query_record, 'info']]
  for (const locate of locations) for (const value of ['', 'not-json', 'null', '[]', '{"unknown":null}', '{"aweme_info":{"aweme_id":"hidden-post"}}', null, {}]) {
    const card = relatedWordsDouyinCard(), [object, key] = locate(card)
    object[key] = value
    assert.throws(() => project('douyin', { data: [card], has_more: false }), /invalid_content_search_identity/)
  }
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

test('Kuaishou Night-All diagnostic ID aliases exclude only known feedback cards without material content', () => {
  // Same diagnostic ID forms as Night-All tests/tikhub-normalizer.test.js.
  // These are synthetic compatibility fixtures, not the incident receipt.
  const ids = ['search_quality2', 'search_title', 'search_cover', 'search_similar', 'search_outdated',
    'search_authoritative', 'search_rrelevant2', 'search_seen', 'search_missing']
  for (const alias of ['external_id', 'externalId']) {
    const projected = project('kuaishou', { feeds: [
      { photoId: 'real-photo', caption: '完整正文' },
      ...ids.map(id => ({ [alias]: id, title: '搜索反馈' })),
      { id: 'search_title', caption: '真实同名作品', user: { id: 'real-author' }, coverUrl: 'https://example.test/real-cover.jpg' },
      { id: 'search_missing', caption: '真实零互动作品', like_count: 0 },
      { feed: { [alias]: 'search_quality2', title: '搜索反馈' } },
    ], pcursor: 'no_more' })
    assert.deepEqual(projected.items.map(row => row.content_id), ['real-photo', 'search_title', 'search_missing'])
    assert.equal(projected.nonPostCount, ids.length + 1)
    assert.equal(projected.items[1].author_id, 'real-author')
    assert.equal(projected.items[2].like_count, 0)
  }
  assert.throws(() => project('kuaishou', { feeds: [{ external_id: 'unknown-card', title: '未知结构' }], pcursor: 'no_more' }),
    /invalid_content_search_identity/, 'unknown cards remain a contract error rather than being silently dropped')
})

// Types and keys follow the verified v9 receipt's related-search card; all
// words, screen keys and transfer values here are synthetic.
const kuaishouRelatedSearchesCard = () => ({ itemType: 9, position: 5, atmosphereType: 0,
  relatedSearches: Array.from({ length: 8 }, (_, index) => ({ expTag: 'fixture-tag', keyword: `fixture-word-${index}`,
    iconText: '', subtagType: 0, type: 'fixture-type',
    extParams: JSON.stringify({ reco_reason: 'fixture-reason', sever_path: 'fixture-path', module: 'fixture-module', request_source: 'fixture-source' }),
    iconColor: 'fixture-color' })),
  itemTransferInfo: JSON.stringify({ refer_single_double_type: 0 }), rank: 5,
  extInfo: { styleType: 0, screenItemKey: 'fixture-screen-key', lines: 2, rsType: 0 }, isSingleColumnMode: true,
})

test('Kuaishou fixed related-search card excludes one non-post while retaining all eleven source entries', () => {
  const entries = Array.from({ length: 10 }, (_, index) => ({ itemType: 5,
    feed: { photoId: `real-photo-${index}`, caption: `完整正文 ${index}`, like_count: 0, comment_count: 2,
      main_mv_url: `https://example.test/video-${index}.mp4?signature=a%2Fb` } }))
  entries.splice(5, 0, kuaishouRelatedSearchesCard())
  const payload = { mixFeeds: entries, pcursor: 'native-next', has_more: true }, original = structuredClone(payload)
  assert.equal(Object.keys(entries[5]).length, 8)
  assert.equal(isKuaishouRelatedSearchesCard(entries[5]), true)
  assert.deepEqual(kuaishouRelatedSearchesCardCoverage(entries[5]), {
    metadataAccepted: true, relatedSearchCount: 8, inspectedCount: 8, invalidIndexes: [], truncated: false,
  })
  const projected = project('kuaishou', payload)
  assert.equal(projected.items.length, 10); assert.equal(projected.nonPostCount, 1)
  assert.equal(projected.providerPage.sourceCount, 11); assert.equal(projected.duplicateCount, 0)
  assert.deepEqual(projected.providerPage.nextParams, { pcursor: 'native-next' })
  assert.equal(projected.items[0].like_count, 0)
  assert.deepEqual(contentSearchDataItem(projected.items[0]).media.videos, ['https://example.test/video-0.mp4?signature=a%2Fb'])
  assert.deepEqual(projected.publicBody.data, original)
  assert.deepEqual(projected.restrictedResponseArchive, { sha256: 'immutable-archive' })
  assert.ok(isPostgresSafeJsonValue(projected.acquiredItems))
  assert.deepEqual(payload, original)
})

test('Kuaishou related-search recognition validates every recommendation including rows three and eight', () => {
  for (let index = 0; index < 8; index++) for (const change of [{ keyword: null }, { unknown: null },
    { video: { url: 'https://example.test/hidden.mp4' } }, { photoId: 'hidden-post' }]) {
    const card = kuaishouRelatedSearchesCard()
    Object.assign(card.relatedSearches[index], change)
    assert.equal(isKuaishouRelatedSearchesCard(card), false)
    assert.deepEqual(kuaishouRelatedSearchesCardCoverage(card).invalidIndexes, [index])
    assert.throws(() => project('kuaishou', { mixFeeds: [card], pcursor: 'no_more' }), /invalid_content_search_identity/)
  }
  const full = kuaishouRelatedSearchesCard()
  full.relatedSearches = Array.from({ length: 100 }, () => structuredClone(full.relatedSearches[0]))
  assert.equal(isKuaishouRelatedSearchesCard(full), true)
  full.relatedSearches[99].extParams = JSON.stringify({ reco_reason: '', sever_path: '', module: '', request_source: '', hidden: null })
  assert.deepEqual(kuaishouRelatedSearchesCardCoverage(full).invalidIndexes, [99])
  full.relatedSearches.push(structuredClone(full.relatedSearches[0]))
  assert.equal(isKuaishouRelatedSearchesCard(full), false)
  assert.equal(kuaishouRelatedSearchesCardCoverage(full).truncated, true)
  assert.equal(kuaishouRelatedSearchesCardCoverage(full).inspectedCount, 0)
})

test('Kuaishou related-search metadata and encoded JSON accept only the complete observed typed key sets', () => {
  const reject = card => {
    assert.equal(isKuaishouRelatedSearchesCard(card), false)
    assert.throws(() => project('kuaishou', { mixFeeds: [card], has_more: false }), /invalid_content_search_identity/)
  }
  for (const name of Object.keys(kuaishouRelatedSearchesCard())) {
    const card = kuaishouRelatedSearchesCard(); delete card[name]; reject(card)
  }
  for (const changes of [{ itemType: '9' }, { position: '5' }, { atmosphereType: null }, { rank: -0 },
    { rank: Infinity }, { isSingleColumnMode: 1 }, { relatedSearches: [] }, { unknown: null }, { unknown: 'scalar' }]) {
    reject({ ...kuaishouRelatedSearchesCard(), ...changes })
  }
  for (const info of [null, {}, 'null', '[]', '{', '{}', '{"refer_single_double_type":"0"}',
    '{"refer_single_double_type":0,"unknown":null}', '{"refer_single_double_type":0,"photo":{"photoId":"hidden"}}']) {
    reject({ ...kuaishouRelatedSearchesCard(), itemTransferInfo: info })
  }
  for (const changes of [{ unknown: null }, { lines: '2' }, { screenItemKey: {} }]) {
    const card = kuaishouRelatedSearchesCard(); Object.assign(card.extInfo, changes); reject(card)
  }
  for (const name of Object.keys(kuaishouRelatedSearchesCard().relatedSearches[0])) {
    const card = kuaishouRelatedSearchesCard(); delete card.relatedSearches[7][name]; reject(card)
  }
  for (const info of [null, '{}', '{', '[]', '{"reco_reason":"","server_path":"","module":"","request_source":""}',
    JSON.stringify({ reco_reason: '', sever_path: '', module: '', request_source: '', unknown: null }),
    JSON.stringify({ reco_reason: '词'.repeat(23000), sever_path: '', module: '', request_source: '' })]) {
    const card = kuaishouRelatedSearchesCard(); card.relatedSearches[7].extParams = info; reject(card)
  }
})

test('Kuaishou itemType-nine real posts are never hidden by related-search metadata', () => {
  const post = { photoId: 'real-type-nine', caption: '真实正文', like_count: 0,
    main_mv_url: 'https://example.test/real.mp4?signature=a%2Fb' }
  for (const wrap of [value => value, value => ({ feed: value }), value => ({ photo: value })]) {
    const card = { ...kuaishouRelatedSearchesCard(), ...wrap(post) }
    assert.equal(isKuaishouRelatedSearchesCard(card), false)
    const projected = project('kuaishou', { mixFeeds: [card], has_more: false })
    assert.equal(projected.nonPostCount, 0); assert.equal(projected.items[0].content_id, post.photoId)
    assert.equal(projected.items[0].full_text, post.caption)
    assert.deepEqual(contentSearchDataItem(projected.items[0]).media.videos, [post.main_mv_url])
  }
  for (const [key, value] of Object.entries({ cid: null, photo_id: '', photo_info: {}, data: {}, user: {}, author: {},
    video: {}, images: [], caption: '', text: '', title: '', url: '', timestamp: 0, like_count: 0, stats: {} })) {
    const card = { ...kuaishouRelatedSearchesCard(), [key]: value }
    assert.equal(isKuaishouRelatedSearchesCard(card), false, key)
    assert.throws(() => project('kuaishou', { mixFeeds: [card], has_more: false }), /invalid_content_search_identity/)
  }
  assert.throws(() => project('kuaishou', { mixFeeds: [{ itemType: 9, relatedSearches: [{ keyword: 'unverified' }] }], has_more: false }),
    /invalid_content_search_identity/)
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

test('HTML numeric entities decode Unicode scalar values without introducing PostgreSQL-unsafe lone surrogates', () => {
  const body = '完整正文😀 &#128512; &#x1F642; &#xD800; &#57343; &#x110000; &#0; ' + '尾段'.repeat(1200)
  const payload = { data: [{ type: 'search_result', object: { id: 'unicode-article', type: 'article',
    title: '原始标题 &#xDFFF; &#128512;', content: `<p>${body}</p>` } }], paging: { is_end: true } }
  const original = structuredClone(payload), projected = project('zhihu', payload)
  const row = projected.acquiredItems[0], modern = contentSearchDataItem(row)
  assert.equal(row.full_text, body.replace('&#128512;', '😀').replace('&#x1F642;', '🙂'))
  assert.equal(modern.title, '原始标题 &#xDFFF; 😀')
  assert.equal(modern.text, row.full_text)
  assert.ok(modern.text.length > 2000)
  assert.ok(isPostgresSafeJsonValue(projected.acquiredItems))
  assert.ok(isPostgresSafeJsonValue(modern))
  const records = rawSearchRecords({ data: { raw_info: '[]', raw_data: JSON.stringify(projected.acquiredItems) } }, 'zhihu', 'tikhub')
  assert.equal(records[0].body, row.full_text)
  assert.ok(isPostgresSafeJsonValue(JSON.parse(JSON.stringify(records))))
  assert.deepEqual(payload, original, 'supplier payload evidence remains unchanged')
  assert.deepEqual(projected.restrictedResponseArchive, { sha256: 'immutable-archive' })
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
