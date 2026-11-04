import test from 'node:test'
import assert from 'node:assert/strict'
import { TIKHUB_CONTENT_SEARCH_RECIPES, normalizeTikHubContentSearchRequest, projectTikHubContentSearch,
  contentSearchDataItem, contentSearchLegacyRow } from '../../server/contracts/tikhub-content-search.mjs'
import { isPostgresSafeJsonValue } from '../../server/core/postgres-json.mjs'

const capturedAt = '2026-10-15T00:00:00.000Z'
const request = (platform, options = {}) => normalizeTikHubContentSearchRequest({ platform, query: '城市', pageSize: 20, ...options })
const project = (platform, data, options) => projectTikHubContentSearch({ publicBody: { data, meta: { capturedAt } },
  restrictedResponseArchive: { sha256: 'untouched-receipt' } }, request(platform, options))
const post = (id, extra = {}) => ({ id: `t3_${id}`, postTitle: '完整标题', content: { markdown: '完整正文' }, ...extra })
const dynamic = (edges = [], pageInfo) => ({ search: { dynamic: { components: {
  top: { navigation: { listPresentation: { items: [{ id: 'posts', text: '帖子' }] } } },
  main: { edges, ...(pageInfo ? { pageInfo } : {}) },
} } } })
const video = (id, extra = {}) => ({ video_id: id, title: '完整视频标题', description: '完整视频正文', ...extra })
const noMetrics = { likes: null, comments: null, shares: null, views: null, bookmarks: null }

test('new recipes preserve Night-All defaults, stable endpoint keys and standard-only public scope', () => {
  assert.deepEqual(request('reddit').upstreamQuery, { query: '城市', search_type: 'post', sort: 'NEW', time_range: 'all', safe_search: 'unset', allow_nsfw: '0', after: '', need_format: false })
  assert.deepEqual(request('youtube').upstreamQuery, { keyword: '城市', sort_by: 'upload_date', continuation_token: '' })
  for (const platform of ['reddit', 'youtube']) {
    // Raw aliases run here since 2026-10-31; public params stay standard-only.
    assert.equal(TIKHUB_CONTENT_SEARCH_RECIPES[platform].rawCompatibility, true)
    assert.equal(TIKHUB_CONTENT_SEARCH_RECIPES[platform].publicParams, false)
    assert.equal(Object.hasOwn(request(platform).upstreamQuery, 'page_size'), false)
    assert.equal(Object.hasOwn(request(platform).upstreamQuery, 'pageSize'), false)
    assert.equal(request(platform, { query: '字'.repeat(500) }).query.length, 500)
    assert.throws(() => request(platform, { query: '字'.repeat(501) }), { code: 'invalid_query' })
  }
  for (const platform of ['douyin', 'kuaishou', 'bilibili', 'zhihu']) {
    assert.equal(TIKHUB_CONTENT_SEARCH_RECIPES[platform].rawCompatibility, true)
    assert.equal(TIKHUB_CONTENT_SEARCH_RECIPES[platform].publicParams, true)
  }
})

test('internal filters and opaque native continuation are bounded without forwarding other controls', () => {
  const r = request('reddit', { params: { sort: 'TOP', time_range: 'week' }, providerCursor: { after: 'next==/+' } })
  assert.equal(r.upstreamQuery.after, 'next==/+')
  assert.equal(r.upstreamQuery.sort, 'TOP')
  assert.equal(request('youtube', { params: { features: 'hd,subtitles', type: 'video', duration: 'long' }, providerCursor: { continuation_token: 'next==' } }).upstreamQuery.continuation_token, 'next==')
  for (const [platform, params] of [['reddit', { search_type: 'community' }], ['reddit', { need_format: 'false' }], ['reddit', { sort: 'arbitrary' }], ['youtube', { type: 'channel' }], ['youtube', { features: 'unknown' }]]) {
    assert.throws(() => request(platform, { params }), { code: 'invalid_parameter' })
  }
  for (const platform of ['reddit', 'youtube']) {
    assert.throws(() => request(platform, { params: { provider: 'other' } }), { code: 'unsupported_fields' })
    assert.throws(() => request(platform, { providerCursor: { cursor: 'native' } }), { code: 'invalid_cursor' })
    for (const value of [{}, [], 0, false, null, ' ', 'x'.repeat(4097), 'x\u0000']) {
      assert.throws(() => request(platform, { providerCursor: { [platform === 'reddit' ? 'after' : 'continuation_token']: value } }), { code: 'invalid_cursor' })
    }
  }
})

test('Reddit main edges retain direct and wrapped posts but never navigation, ads, deleted or account cards', () => {
  const payload = dynamic([{ node: { post: post('a', { score: 0, commentCount: 3, permalink: '/r/test/comments/a/title/', authorInfo: { name: '作者' } }) } },
    { node: { children: [{ post: post('b') }, { post: post('ad', { isCommercialCommunication: true }) }, { post: post('deleted', { removedByCategory: 'deleted' }) },
      { community: { id: 'community' } }, { comment: { id: 'comment' } }, { author: { id: 'author' } }] } }], { endCursor: 'response-next', hasNextPage: true })
  payload.params = { after: 'ignored-echo' }
  const before = structuredClone(payload), output = project('reddit', payload)
  assert.deepEqual(output.items.map(row => row.content_id), ['a', 'b'])
  assert.equal(output.nonPostCount, 5)
  assert.equal(output.providerPage.sourceCount, 7)
  assert.deepEqual(output.providerPage.nextParams, { after: 'response-next' })
  const item = contentSearchDataItem(output.items[0])
  assert.equal(item.id, 'reddit:a')
  assert.equal(item.externalId, 'a')
  assert.equal(item.url, 'https://www.reddit.com/r/test/comments/a/title/')
  assert.equal(item.author.name, '作者')
  assert.deepEqual(item.metrics, { ...noMetrics, likes: 0, comments: 3 })
  assert.deepEqual(payload, before)
  assert.deepEqual(output.restrictedResponseArchive, { sha256: 'untouched-receipt' })
})

test('Reddit Listing wrappers keep bare identities and explicit null after is terminal', () => {
  const payload = { kind: 'Listing', data: { children: [{ kind: 't3', data: { id: 'abc', name: 't3_abc', title: '帖子', selftext: '正文', created_utc: 1700000000, author: '作者', num_comments: '0' } },
    { kind: 't1', data: { id: 'comment' } }], after: null } }
  const output = project('reddit', payload)
  assert.equal(output.items[0].content_id, 'abc')
  assert.equal(output.items[0].full_text, '正文')
  assert.equal(output.items[0].created_at, '2023-11-14T22:13:20.000Z')
  assert.equal(output.items[0].reply_count, 0)
  assert.deepEqual(contentSearchDataItem(output.items[0]).author, { id: '作者', name: '作者', avatarUrl: null })
  assert.equal(output.providerPage.hasMore, false)
  assert.equal(output.nonPostCount, 1)
})

test('Reddit standard images retain the existing verified preview/original policy without rewriting evidence', () => {
  const preview = 'https://preview.redd.it/asset.png?width=140&auto=webp&s=fixture', original = 'https://i.redd.it/asset.png'
  const output = project('reddit', dynamic([{ node: { post: post('a', { thumbnail: preview, images: [preview, original] }) } }], { hasNextPage: false }))
  const row = output.items[0]
  assert.equal(row.cover_url, preview)
  assert.deepEqual(JSON.parse(row.image_urls), [preview, original])
  assert.deepEqual(contentSearchDataItem(row).media, { coverUrl: original, images: [original], videos: [] })
})

test('YouTube formatted videos preserve full titles/text, source anonymity and absent versus actual zero metrics', () => {
  for (const missing of [undefined, null, '', '  ', true, false, 'unknown', '1.2K', '1.5', -1, Number.MAX_SAFE_INTEGER + 1]) {
    const output = project('youtube', { videos: [video('v1', { title: '完整标题'.repeat(100), description: '完整正文'.repeat(1000), like_count: missing, comment_count: missing, share_count: missing, view_count: missing, collect_count: missing })], has_more: false })
    const modern = contentSearchDataItem(output.items[0]), legacy = contentSearchLegacyRow(output.items[0])
    assert.equal(modern.title.length, 400)
    assert.equal(modern.text.length, 4000)
    assert.deepEqual(modern.metrics, noMetrics)
    assert.deepEqual(modern.source, { provider: null, endpointId: null })
    assert.equal(modern.id, 'youtube:v1')
    assert.equal(modern.externalId, 'v1')
    assert.equal(legacy.like_count, 0)
    assert.equal(legacy.reply_count, 0)
  }
  const zero = contentSearchDataItem(project('youtube', { videos: [video('zero', { like_count: 0, comment_count: '0', share_count: 0, collect_count: '0', view_count: 0 })], has_more: false }).items[0])
  assert.deepEqual(zero.metrics, { likes: 0, comments: 0, shares: 0, views: 0, bookmarks: 0 })
})

test('YouTube known native renderer sections project videos and pagination while excluding explicit channel/ad cards', () => {
  const output = project('youtube', { contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [
    { itemSectionRenderer: { contents: [{ videoRenderer: { videoId: 'v1', title: { runs: [{ text: '标题' }] }, descriptionSnippet: { simpleText: '正文' },
      thumbnail: { thumbnails: [{ url: 'https://example.test/thumb.jpg' }] }, viewCountText: { simpleText: '1,234 views' }, publishedTimeText: { simpleText: '3 hours ago' },
      ownerText: { runs: [{ text: '频道', navigationEndpoint: { browseEndpoint: { browseId: 'channel1' } } }] } } },
      { channelRenderer: { channelId: 'channel' } }, { adSlotRenderer: { slotId: 'ad' } }] } },
    { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'response-next' } } } },
  ] } } } }, params: { continuation_token: 'request-echo' } })
  const item = contentSearchDataItem(output.items[0])
  assert.equal(output.items.length, 1)
  assert.equal(output.nonPostCount, 2)
  assert.equal(output.providerPage.sourceCount, 3)
  assert.deepEqual(output.providerPage.nextParams, { continuation_token: 'response-next' })
  assert.equal(item.title, '标题')
  assert.equal(item.text, '正文')
  assert.equal(item.publishedAt, null)
  assert.deepEqual(item.metrics, { ...noMetrics, views: 1234 })
  assert.deepEqual(item.author, { id: 'channel1', name: '频道', avatarUrl: null })
  assert.deepEqual(item.media, { coverUrl: 'https://example.test/thumb.jpg', images: [], videos: [] })
})

test('YouTube continuation command and formatted mixed item envelopes retain real video identity only', () => {
  const page = project('youtube', { onResponseReceivedCommands: [{ appendContinuationItemsAction: { continuationItems: [
    { videoRenderer: { videoId: 'v2', title: { simpleText: '下一页' } } },
    { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'next2' } } } },
  ] } }] }, { providerCursor: { continuation_token: 'next1' } })
  assert.equal(page.items[0].content_id, 'v2')
  assert.deepEqual(page.providerPage.nextParams, { continuation_token: 'next2' })
  const mixed = project('youtube', { items: [{ type: 'channel', id: 'c' }, { type: 'playlist', id: 'p' }, video('v'), { type: 'video', id: 'typed' }], has_more: false })
  assert.deepEqual(mixed.items.map(row => row.content_id), ['v', 'typed'])
  assert.equal(mixed.nonPostCount, 2)
  assert.throws(() => project('youtube', { items: [{ id: 'untyped-channel', title: '频道' }], has_more: false }), /invalid_content_search_identity/)
})

for (const platform of ['reddit', 'youtube']) {
  const payload = (rows, extra = {}) => platform === 'reddit' ? { items: rows.map(id => post(id)), ...extra } : { videos: rows.map(id => video(id)), ...extra }
  const nextName = platform === 'reddit' ? 'after' : 'continuation_token'
  test(`${platform} retains all overflow, first identity wins and provider evidence remains immutable`, () => {
    const source = payload(Array.from({ length: 25 }, (_, index) => String(index)), { [nextName]: 'next', has_more: true })
    const values = platform === 'reddit' ? source.items : source.videos
    values.push({ ...values[0], title: 'duplicate must not win', postTitle: 'duplicate must not win' })
    const before = structuredClone(source), output = project(platform, source)
    assert.equal(output.acquiredItems.length, 25)
    assert.equal(output.items[0].title, platform === 'reddit' ? '完整标题' : '完整视频标题')
    assert.equal(output.duplicateCount, 1)
    assert.equal(output.providerPage.sourceCount, 26)
    assert.ok(isPostgresSafeJsonValue(output.acquiredItems))
    assert.ok(isPostgresSafeJsonValue(output.providerPage))
    assert.deepEqual(source, before)
  })
  test(`${platform} missing pagination stays unknown for empty and short pages; empty advancing pages remain resumable`, () => {
    for (const ids of [[], ['only']]) {
      assert.equal(project(platform, payload(ids)).providerPage.hasMore, null)
      assert.equal(project(platform, payload(ids, { params: { [nextName]: 'ignored', has_more: false } })).providerPage.hasMore, null)
      assert.equal(project(platform, payload(ids, { has_more: false })).providerPage.hasMore, false)
    }
    assert.deepEqual(project(platform, payload([], { [nextName]: 'next' })).providerPage.nextParams, { [nextName]: 'next' })
    assert.equal(project(platform, { data: payload(['wrapped'], { has_more: false }), params: { [nextName]: 'ignored' } }).items.length, 1)
  })
  test(`${platform} repeated continuation retains acquired rows and records a stop reason instead of losing the paid page`, () => {
    const output = project(platform, payload(['1'], { [nextName]: 'same', has_more: true }), { providerCursor: { [nextName]: 'same' } })
    assert.equal(output.items[0].content_id, '1')
    assert.deepEqual(output.providerPage, { hasMore: false, nextParams: null, nextPage: null, paginationMode: 'cursor', sourceCount: 1, stopReason: 'repeated_cursor' })
  })
  test(`${platform} malformed, contradictory and explicitly missing continuation fails closed`, () => {
    assert.throws(() => project(platform, payload(['1'], { [nextName]: 'next', has_more: false })), /contradictory_content_search_continuation/)
    assert.throws(() => project(platform, payload([], { has_more: true })), /missing_content_search_continuation/)
    for (const value of [{}, [], false, 10, ' ', 'x'.repeat(4097), 'bad\u0000']) {
      assert.throws(() => project(platform, payload([], { [nextName]: value })), /invalid_content_search_continuation/)
    }
    assert.throws(() => project(platform, payload([], { has_more: 'maybe' })), /invalid_content_search_pagination/)
  })
  test(`${platform} malformed collection or identity never becomes successful empty data`, () => {
    assert.throws(() => project(platform, { unexpected: [] }), /invalid_content_search_shape/)
    const key = platform === 'reddit' ? 'items' : 'videos'
    assert.throws(() => project(platform, { [key]: {}, has_more: false }), /invalid_content_search_shape/)
    assert.throws(() => project(platform, { [key]: [null], has_more: false }), /invalid_content_search_entry/)
    assert.throws(() => project(platform, { [key]: [{ id: Number.MAX_SAFE_INTEGER + 1 }], has_more: false }), /invalid_content_search_identity/)
    assert.throws(() => project(platform, { data: payload([]), code: 429 }), /content_search_business_rejected/)
  })
}

test('Reddit empty dynamic results never use top navigation or request pagination as fallback', () => {
  const source = dynamic([])
  source.params = { after: 'request-echo' }
  const output = project('reddit', source)
  assert.deepEqual(output.items, [])
  assert.equal(output.providerPage.hasMore, null)
  assert.equal(output.providerPage.nextParams, null)
  assert.throws(() => project('reddit', dynamic([{ node: { unknown: { post: post('hidden') } } }], { hasNextPage: false })), /invalid_content_search_entry/)
})

// Shapes seen in production on 2026-10-29 (calls 93494c87 and 0bf7cf68).
const searchPost = id => ({ __typename: 'SearchPost', behaviors: {}, telemetry: {}, post: { __typename: 'SubredditPost', ...post(id) } })
const notice = (message, explanation = '') => ({ __typename: 'SearchErrorMessage', behaviors: { cta: {} },
  presentation: { __typename: 'SearchErrorMessageDefaultPresentation', message, explanation, ctaButtonText: 'Try again', icon: 'search' },
  telemetry: { __typename: 'SearchElementTelemetry', events: [], trackingContext: {} } })

// Sanitized structure from hash-verified receipts c08af475 and 9787feef
// (2026-10-30). trackingContext.post is analytics metadata, not a search result.
const trackedWidget = (typename, behavior) => ({ __typename: typename,
  behaviors: { [behavior]: { telemetry: { trackingContext: { post: { id: 't3_analytics_only' } } } } } })

test('Reddit correction tracking context does not discard seven adjacent posts or mutate the receipt', () => {
  const ids = Array.from({ length: 7 }, (_, i) => `result${i}`)
  const payload = dynamic([{ node: trackedWidget('SearchSpellCorrectionApplied', 'corrected') },
    { node: { __typename: 'SearchListComponent', children: ids.map(searchPost) } }],
  { hasNextPage: true, endCursor: 'next-page' })
  const before = structuredClone(payload), output = project('reddit', payload)
  assert.deepEqual(output.items.map(item => item.content_id), ids)
  assert.equal(output.nonPostCount, 1)
  assert.deepEqual(output.providerPage.nextParams, { after: 'next-page' })
  assert.deepEqual(output.providerPage.warnings.map(warning => warning.code), ['reddit_spell_correction'])
  assert.deepEqual(payload, before)
})

test('Reddit spelling telemetry excludes deep search metadata only at the three known locations', () => {
  const deep = { search: { scope: { a: { b: { c: { d: { e: 'analytics' } } } } } } }
  const telemetry = { trackingContext: { post: { id: 't3_tracking' }, ...deep }, ...deep }
  const correction = { __typename: 'SearchSpellCorrectionApplied', telemetry,
    behaviors: { corrected: { telemetry }, original: { telemetry } } }
  const payload = dynamic([{ node: correction }, { node: { children: Array.from({ length: 7 }, (_, i) => searchPost(`p${i}`)) } }],
    { hasNextPage: true, endCursor: 'next' })
  const before = structuredClone(payload)
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } }
  freeze(payload)
  const output = project('reddit', payload)
  assert.deepEqual(output.items.map(item => item.content_id), Array.from({ length: 7 }, (_, i) => `p${i}`))
  assert.equal(output.nonPostCount, 1)
  assert.equal(output.providerPage.hasMore, true)
  assert.deepEqual(output.providerPage.nextParams, { after: 'next' })
  assert.deepEqual(output.providerPage.warnings.map(warning => warning.code), ['reddit_spell_correction'])
  assert.deepEqual(payload, before)
  for (const node of [{ ...correction, presentation: deep },
    { ...correction, behaviors: { corrected: { telemetry, content: { post: post('hidden') } } } },
    { ...correction, behaviors: { other: { telemetry } } },
    { ...correction, __typename: 'UnknownWidget' },
    { __typename: 'SearchBanner', telemetry: deep }]) {
    assert.throws(() => project('reddit', dynamic([{ node }])), /invalid_content_search_entry/)
  }
  const banner = { __typename: 'SearchBanner', telemetry: { trackingContext: deep },
    behaviors: { cta: { telemetry: { trackingContext: deep } }, dismiss: { telemetry: { trackingContext: deep } } } }
  assert.equal(project('reddit', dynamic([{ node: banner }])).nonPostCount, 1)
})

test('Reddit correction and banner tracking metadata permit an explicit no-results terminal page', () => {
  const widgets = [trackedWidget('SearchSpellCorrectionApplied', 'corrected'), trackedWidget('SearchBanner', 'cta')]
  const output = project('reddit', dynamic([...widgets, notice('No results found')].map(node => ({ node })),
    { hasNextPage: false, endCursor: 'last-edge' }))
  assert.deepEqual(output.items, [])
  assert.equal(output.nonPostCount, 3)
  assert.equal(output.providerPage.hasMore, false)
  assert.equal(output.providerPage.nextParams, null)
  assert.deepEqual(output.providerPage.warnings.map(warning => warning.code), ['reddit_spell_correction', 'reddit_no_results'])
  assert.throws(() => project('reddit', dynamic([...widgets, notice('Something went wrong')].map(node => ({ node })),
    { hasNextPage: false })), /upstream_search_error_message/)
})

test('Reddit widget metadata exception is limited to known telemetry paths and preserves real posts', () => {
  for (const [typename, behaviors] of [['SearchSpellCorrectionApplied', ['corrected', 'original']], ['SearchBanner', ['cta', 'dismiss']]]) {
    for (const behavior of behaviors) {
      const node = trackedWidget(typename, behavior)
      node.telemetry = { trackingContext: { post: null } }
      assert.equal(project('reddit', dynamic([{ node }])).nonPostCount, 1)
      node.post = post('actual')
      assert.deepEqual(project('reddit', dynamic([{ node }])).items.map(item => item.content_id), ['actual'])
      delete node.post
      for (const extra of [{ presentation: { post: post('hidden') } },
        { content: { telemetry: { trackingContext: { post: post('hidden') } } } }]) {
        assert.throws(() => project('reddit', dynamic([{ node: { ...node, ...extra } }])), /invalid_content_search_entry/)
      }
    }
  }
  assert.throws(() => project('reddit', dynamic([{ node: { __typename: 'SearchBanner',
    telemetry: { events: [{ post: post('hidden') }] } } }])), /invalid_content_search_entry/)
  for (const node of [trackedWidget('SearchUnknownWidget', 'corrected'),
    trackedWidget('SearchSpellCorrectionApplied', 'unknown'), trackedWidget('SearchBanner', 'corrected')]) {
    assert.throws(() => project('reddit', dynamic([{ node }])), /invalid_content_search_entry/)
  }
})

test('Reddit search widgets such as in-feed surveys are excluded without failing the page', () => {
  const output = project('reddit', dynamic([
    { node: { __typename: 'SearchListComponent', behaviors: {}, presentation: {}, children: [searchPost('a'), searchPost('b')] } },
    { node: { __typename: 'SearchInFeedSurveyUnit' } }], { hasNextPage: false }))
  assert.deepEqual(output.items.map(item => item.content_id), ['a', 'b'])
  assert.equal(output.nonPostCount, 1)
  assert.equal(output.providerPage.warnings, undefined)
})

test('Reddit no-results notice is an empty page; any other notice is a Reddit-side error, never an empty page', () => {
  for (const [message, explanation] of [['Hm... we couldn’t find any results for “x”', 'Double-check your spelling'], ['No results found', ''], ['没有找到相关结果', '']]) {
    const output = project('reddit', dynamic([{ node: notice(message, explanation) }], { hasNextPage: false }))
    assert.deepEqual(output.items, [])
    assert.equal(output.nonPostCount, 1)
    assert.deepEqual(output.providerPage.warnings.map(warning => warning.code), ['reddit_no_results'])
    assert.equal(output.providerPage.hasMore, false)
  }
  for (const message of ['Something went wrong', 'Server error. Try again later.', '']) {
    assert.throws(() => project('reddit', dynamic([{ node: notice(message) }], { hasNextPage: false })), /upstream_search_error_message/)
  }
  const mixed = project('reddit', dynamic([{ node: searchPost('a') }, { node: notice('Something went wrong') }], { hasNextPage: false }))
  assert.deepEqual(mixed.items.map(item => item.content_id), ['a'])
  assert.deepEqual(mixed.providerPage.warnings.map(warning => warning.code), ['reddit_search_notice'])
})

test('Reddit final page keeps its Relay endCursor with hasNextPage=false and ends pagination', () => {
  // Production 2026-10-29 (call 0bf7cf68): a no-results notice page carried
  // endCursor, startCursor and hasPreviousPage alongside hasNextPage=false.
  const finalInfo = { endCursor: 'last-edge-cursor', startCursor: 'first-edge-cursor', hasNextPage: false, hasPreviousPage: true }
  for (const edges of [[{ node: notice('No results found') }], [{ node: searchPost('a') }]]) {
    const output = project('reddit', dynamic(edges, finalInfo))
    assert.equal(output.providerPage.hasMore, false)
    assert.equal(output.providerPage.nextParams, null)
  }
  const next = project('reddit', dynamic([{ node: searchPost('a') }], { endCursor: 'next-cursor', hasNextPage: true }))
  assert.deepEqual(next.providerPage.nextParams, { after: 'next-cursor' })
  assert.throws(() => project('reddit', dynamic([{ node: searchPost('a') }], { hasNextPage: true })), /missing_content_search_continuation/)
})

test('Reddit unknown widgets that carry a post still fail the page instead of dropping it', () => {
  for (const node of [{ __typename: 'SearchCarousel', items: [{ __typename: 'SubredditPost', id: 'hidden' }] },
    { __typename: 'SearchPromo', target: { id: 't3_hidden' } },
    { __typename: 'SearchHighlight', content: { postTitle: '标题' } },
    { __typename: 'SearchNested', a: { b: { c: { d: { e: { f: { g: {} } } } } } } }]) {
    assert.throws(() => project('reddit', dynamic([{ node }], { hasNextPage: false })), /invalid_content_search_entry/, node.__typename)
  }
})

test('YouTube formatted search keeps a plain-string author and exact view-count text, never abbreviated or relative values', () => {
  const output = project('youtube', { videos: [
    video('a', { author: '方脸说', channel_id: 'UC123', view_count: '12,345 views', published_time: '3 years ago' }),
    video('b', { author: '频道二', view_count: '6789次观看' }),
    video('c', { author: '频道三', view_count: '1.2M views' }),
    video('d', { author: '频道四', view_count: '12万次观看' }),
    video('e', { author: '  ', view_count: 'No views' }),
  ], has_more: false })
  const items = output.items.map(contentSearchDataItem)
  assert.deepEqual(items.map(item => item.author.name), ['方脸说', '频道二', '频道三', '频道四', null])
  assert.equal(items[0].author.id, 'UC123')
  assert.deepEqual(items.map(item => item.metrics.views), [12345, 6789, null, null, 0])
  assert.equal(items[0].publishedAt, null)
  assert.deepEqual({ ...items[0].metrics, views: null }, noMetrics)
})
