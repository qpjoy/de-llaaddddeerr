import assert from 'node:assert/strict'
import test from 'node:test'
import { claimNoteOpenRequest, mergeNoteDetail, mergeNotes, nativeNote, nativeNotePage, storedNote } from '../../src/xiaohongshu-feed.js'
import { xiaohongshuReach } from '../../shared/xiaohongshu-reach.mjs'
import { xiaohongshuImageUrl } from '../../shared/xiaohongshu-media.mjs'

test('explicit list reads and impressions survive zero-only analytics with list provenance', () => {
  const original = nativeNote({ note_id: '69297248000000001e039940', interact_info: { view_count: '1200', impression_count: '2400' } })
  const displayed = mergeNoteDetail(original, { data: { item: { metrics: { views: 0, impressions: 0, liked: 0 } } } })
  assert.equal(displayed.metrics.views, 1200)
  assert.equal(displayed.metrics.impressions, 2400)
  assert.equal(displayed.metricSources.views, 'list')
  assert.equal(displayed.metricSources.impressions, 'list')
  assert.match(displayed.metricsNotice, /列表/)
  assert.deepEqual(xiaohongshuReach({ readNum: '12', impNum: '34' }), { views: 12, impressions: 34 })
  for (const value of [null, '', ' ', false, -1, 'NaN']) {
    assert.deepEqual(xiaohongshuReach({ view_count: value, impression_count: value }), { views: null, impressions: null })
  }
  assert.deepEqual(xiaohongshuReach({ view_count: 0, impression_count: 0 }), { views: 0, impressions: 0 })
  assert.deepEqual(xiaohongshuReach({ liked_count: 100, topic: { view_count: 9999 } }), { views: null, impressions: null })
})

test('one note opening claims one permitted operation across reopen, renewal and unknown outcomes', () => {
  const ready = { apiKey: 'temporary-credential', analyticsIssues: [], resolveIssues: [] }
  const saved = {}
  assert.equal(claimNoteOpenRequest(saved, { ...ready, apiKey: '' }), null)
  assert.equal(claimNoteOpenRequest(saved, ready), 'note_detail')
  assert.equal(claimNoteOpenRequest(saved, ready), null)
  assert.equal(claimNoteOpenRequest(saved, { ...ready, apiKey: 'renewed-credential' }), null)
  saved.researchError = new Error('unknown outcome')
  assert.equal(claimNoteOpenRequest(saved, ready), null)
  assert.equal(claimNoteOpenRequest({ research: { note_detail: { payload: { data: { item: null } } } } }, ready), null)
  assert.equal(claimNoteOpenRequest({ result: { payload: {} } }, ready), null)
})

test('runtime-disabled analytics uses authorized body detail; denied operations never dispatch', () => {
  const disabled = [{ kind: 'runtime' }], denied = [{ kind: 'authorization' }]
  const saved = {}, ready = { apiKey: 'key', analyticsIssues: disabled, resolveIssues: [] }
  assert.equal(claimNoteOpenRequest(saved, ready), 'resolve')
  assert.equal(claimNoteOpenRequest(saved, { ...ready, analyticsIssues: [] }), null)
  for (const analyticsIssues of [disabled, denied]) {
    assert.equal(claimNoteOpenRequest({}, { ...ready, analyticsIssues, resolveIssues: denied }), null)
  }
  assert.equal(claimNoteOpenRequest({}, { ...ready, analyticsIssues: [], resolveIssues: denied }), 'note_detail')
})

test('partial analytics without metadata renders safely and distinguishes missing metrics from zero', () => {
  const original = { text: '完整正文', tags: ['摄影'], media: [{ url: 'https://images.test/a' }], metrics: { liked: 5, views: null } }
  const displayed = mergeNoteDetail(original, { data: { item: { text: null, tags: [], media: [], metrics: { liked: null, views: 0 } } } })
  assert.equal(displayed.text, original.text)
  assert.deepEqual(displayed.tags, original.tags)
  assert.deepEqual(displayed.media, original.media)
  assert.deepEqual(displayed.metrics, { liked: 5, views: null })
  assert.deepEqual(displayed.metricSources, { liked: 'list' })
  assert.equal(mergeNoteDetail(original, { data: { item: null } }), original)
})

test('zero-only detail retains list metrics and discloses fallback', () => {
  const original = { author: { id: 'author', name: '列表作者' }, metrics: { liked: 326, collected: 87, comments: 18, views: null } }
  const item = { author: { id: 'author', name: null, avatarUrl: null }, metrics: { views: 0, impressions: 0, liked: 0, collected: 0, comments: 0, shared: null } }
  const displayed = mergeNoteDetail(original, { data: { item } })
  assert.deepEqual(displayed.metrics, original.metrics)
  assert.equal(displayed.author.name, '列表作者')
  assert.match(displayed.metricsNotice, /暂用列表数据/)
  assert.deepEqual(displayed.metricSources, { liked: 'list', collected: 'list', comments: 'list' })
  assert.equal(item.metrics.liked, 0, 'never rewrite the API evidence')
  assert.equal(mergeNoteDetail({ metrics: {} }, { data: { item } }).metrics.liked, 0, 'zero without contradictory evidence stays zero')
  const actualZero = mergeNoteDetail(original, { data: { item: { metrics: { views: 250, liked: 0, comments: 0 } } } })
  assert.equal(actualZero.metrics.liked, 0, 'do not keep the maximum or treat every zero as missing')
  assert.equal(actualZero.metrics.views, 250)
  assert.deepEqual(actualZero.metricSources, { views: 'detail', liked: 'detail', collected: 'list', comments: 'detail' })
  assert.equal(actualZero.metricsNotice, null)
})

test('all missing and mixed zero/missing detail metrics fall back to acquired list, including views and zero', () => {
  const original = { metrics: { views: 1200, liked: '326', collected: 0, comments: 18, shared: 2 } }
  for (const metrics of [undefined, {}, { views: null, liked: null }, { views: 0, liked: null, comments: 0 }, { views: '0', collected: 0 }]) {
    const displayed = mergeNoteDetail(original, { data: { item: { metrics } } })
    assert.deepEqual(displayed.metrics, original.metrics)
    assert.equal(displayed.metricSources.views, 'list')
    assert.equal(displayed.metricSources.collected, 'list')
    assert.match(displayed.metricsNotice, /暂用列表数据/)
  }
  const empty = mergeNoteDetail({ metrics: { views: null } }, { data: { item: {} } })
  assert.equal(empty.metrics.views, null, 'never fabricate views when neither source provides them')
  assert.deepEqual(empty.metricSources, {})
})

test('nonzero detail takes precedence even when smaller, while missing fields retain their list provenance', () => {
  const original = { metrics: { views: 1200, liked: 326, collected: 87, comments: 18, shared: 2 } }
  const payload = { data: { item: { metrics: { views: 1000, liked: 300, collected: null, comments: 0, shared: null } } } }
  const before = structuredClone(payload)
  const displayed = mergeNoteDetail(original, payload)
  assert.deepEqual(displayed.metrics, { views: 1000, liked: 300, collected: 87, comments: 0, shared: 2 })
  assert.deepEqual(displayed.metricSources, { views: 'detail', liked: 'detail', collected: 'list', comments: 'detail', shared: 'list' })
  assert.deepEqual(payload, before, 'presentation never edits delivered API evidence')
})

test('body detail and analytics both preserve the original list fallback and metric origins', () => {
  const list = { metricsSource: 'list', metrics: { views: 1200, liked: 326, collected: 87 }, tags: ['列表标签'] }
  const body = mergeNoteDetail(list, { data: { item: { metrics: { liked: 400, collected: null }, text: '完整正文', tags: ['完整标签'] } } }, { tagsAvailable: true })
  const displayed = mergeNoteDetail(body, { data: { item: { metrics: { views: 0, liked: 0 } } } })
  assert.equal(displayed.text, '完整正文')
  assert.deepEqual(displayed.tags, ['完整标签'])
  assert.deepEqual(displayed.metrics, { views: 1200, liked: 400, collected: 87 })
  assert.deepEqual(displayed.metricSources, { views: 'list', liked: 'detail', collected: 'list' })
})

test('detail image URLs render over HTTPS without losing signatures or replacing usable list images with invalid URLs', () => {
  const httpImage = 'http://ci.xiaohongshu.com/spectrum/test?imageView2/2/w/1080/format/jpg&sign=a%2Fb+z'
  assert.equal(xiaohongshuImageUrl(httpImage), httpImage.replace('http:', 'https:'))
  assert.equal(xiaohongshuImageUrl('http://sns-webpic.xhscdn.com/image?sign=a%2Fb'), 'https://sns-webpic.xhscdn.com/image?sign=a%2Fb')
  for (const value of ['http://localhost/private', 'http://ci.xiaohongshu.com.evil.test/image', 'http://ci.xiaohongshu.com:8080/image', 'https://user:secret@ci.xiaohongshu.com/image', 'javascript:alert(1)', null]) {
    assert.equal(xiaohongshuImageUrl(value), null)
  }
  const original = { media: [{ type: 'image', url: 'https://images.test/list.jpg' }] }
  assert.deepEqual(mergeNoteDetail(original, { data: { item: { media: [{ type: 'image', url: 'http://unknown.test/image' }] } } }).media, original.media)
  const media = [httpImage, 'https://images.test/second.jpg'].map(url => ({ type: 'image', url }))
  assert.deepEqual(mergeNoteDetail(original, { data: { item: { media } } }).media, media)
})
const note = { note_id: '675d277d000000000600e655', desc: '长'.repeat(1000), tag_list: [{ name: '摄影' }] }
const response = (extra = {}) => ({ code: 200, data: { data: { items: [{ model_type: 'note', note }], has_more: true, search_id: 'session', ...extra } } })
test('native search exposes only supplied view counts, keeps share counts, and marks list provenance', () => {
  const pageFor = fields => nativeNotePage(response({ items: [{ model_type: 'note', note: { ...note, ...fields } }] }), 'search_notes', { page: 1 }).items[0]
  const list = pageFor({ interact_info: { liked_count: '326', view_count: 1200, share_count: 2 } })
  assert.equal(list.metrics.views, 1200)
  assert.equal(list.metrics.shared, 2)
  assert.equal(list.metricsSource, 'list')
  assert.equal(pageFor({ view_count: 0 }).metrics.views, 0)
  assert.equal(pageFor({ interact_info: { liked_count: 326, comment_count: 18 } }).metrics.views, null)
})
test('native feed preserves text/tags, carries search sessions and terminates at page 15', () => {
  const page = nativeNotePage(response(), 'search_notes', { keyword: '摄影', page: 1 })
  assert.equal(page.items[0].text.length, 1000)
  assert.deepEqual(page.items[0].tags, ['摄影'])
  assert.equal(page.next.page, 2)
  assert.equal(page.next.search_id, 'session')
  assert.equal(nativeNotePage(response({ has_more: null, next_page: true }), 'search_notes', { page: 1 }).next.page, 2)
  assert.throws(() => nativeNotePage(response({ next_page: 0 }), 'search_notes', { page: 1 }))
  assert.throws(() => nativeNotePage(response({ next_page: 5 }), 'search_notes', { page: 1 }))
  assert.equal(nativeNotePage(response(), 'search_notes', { page: 15 }).next, null)
  assert.throws(() => nativeNotePage(response({ has_more: null }), 'search_notes', { page: 1 }))
  assert.throws(() => nativeNotePage(response({ items: [] }), 'search_notes', { page: 1 }))
  assert.throws(() => nativeNotePage({ code: 200, data: '服务异常' }, 'search_notes', { page: 1 }))
})
test('user feed forwards only Hub cursors and stops at terminal page', () => {
  const payload = cursor => ({ code: 200, data: { data: { notes: [{ ...note, cursor }] } } })
  const request = { user_id: note.note_id }
  assert.equal(nativeNotePage(payload('mxec2.opaque'), 'get_user_posted_notes', request).next.cursor, 'mxec2.opaque')
  assert.equal(nativeNotePage(payload(null), 'get_user_posted_notes', request).next, null)
  assert.throws(() => nativeNotePage(payload('raw-provider-cursor'), 'get_user_posted_notes', request))
})
test('stored projection retains complete body/tags and merges canonical IDs with native note identity', () => {
  const row = storedNote({ id: 'canonical-uuid', externalId: note.note_id, body: note.desc, stableFields: { tags: ['摄影'], media: { images: ['https://image.test/a'] } } })
  const live = nativeNotePage(response(), 'search_notes', { page: 1 }).items[0]
  assert.equal(row.text.length, 1000)
  assert.deepEqual(row.tags, ['摄影'])
  assert.equal(mergeNotes([live], [row]).length, 1)
  assert.equal(row.media[0].url, 'https://image.test/a')
})

test('App V2 images_list survives both live display and stored normalization', async () => {
  const { normalizeTikHubXiaohongshuNote } = await import('../../server/contracts/tikhub-xiaohongshu.mjs')
  const preview = 'https://sns-na-i11.xhscdn.com/example?sign=test&sc=SRH_PRV'
  const full = 'https://sns-na-i11.xhscdn.com/second?sign=test&sc=SRH_DTL'
  // Observed App V2 search shape: subsequent images have empty url and only a large URL.
  const source = { ...note, images_list: [{ url: preview, url_size_large: full }, { url: '', url_size_large: full }] }
  const payload = response({ items: [{ model_type: 'note', note: source }] })
  const live = nativeNotePage(payload, 'search_notes', { page: 1 }).items[0]
  const normalized = normalizeTikHubXiaohongshuNote({ data: source })
  const expected = [{ type: 'image', url: preview }, { type: 'image', url: full }]
  assert.deepEqual(live.media, expected)
  assert.deepEqual(normalized.media, expected)
  assert.deepEqual(storedNote({ stableFields: { media: { images: normalized.media.map(m => m.url) } } }).media, expected)
  assert.equal(normalizeTikHubXiaohongshuNote({ data: { note_id: note.note_id, images_list: source.images_list } }).media.length, 2)
  assert.deepEqual(normalizeTikHubXiaohongshuNote({ data: { ...note, images_list: [{ url_size_large: 'http://localhost/private' }] } }).media, [])
})
