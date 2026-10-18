import test from 'node:test'
import assert from 'node:assert/strict'
import { projectTikHubTwitterSearch, projectTikHubTwitterTimeline } from '../../server/contracts/tikhub-twitter-search.mjs'
import { contentSearchDataItem } from '../../server/contracts/tikhub-content-search.mjs'
import { rawSearchRecords } from '../../server/contracts/raw-search.mjs'
import { isPostgresSafeJsonValue } from '../../server/core/postgres-json.mjs'

const capturedAt = '2026-10-18T12:00:00.000Z'
// Synthetic values using every observed field in the operator's complete
// 19-entry saved-receipt structural report, not copied production content.
const post = (tweetId = '1979366117396988012', override = {}) => ({ tweet_id: tweetId,
  text: '完整正文 <内容> & "quotes"\n第二行 😀', created_at: 'Sun Oct 18 05:00:00 +0000 2026',
  user_info: { rest_id: '1899000000000000001', screen_name: 'example', name: '作者', avatar: 'https://cdn.example/avatar.jpg' },
  favorites: 0, replies: 1, retweets: 2, quotes: 3, bookmarks: 4, views: '5',
  media: [], entities: { hashtags: [{ text: '话题' }] }, ...override })
const project = (data, request = {}) => projectTikHubTwitterSearch({ publicBody: { data, meta: { capturedAt } },
  restrictedResponseArchive: { sha256: 'immutable' } }, request)

test('observed native timeline preserves native identities, full text, time, author and exact metrics', () => {
  const result = project({ timeline: [post()], next_cursor: 'next-page' })
  const row = result.items[0], item = contentSearchDataItem(row)
  assert.equal(row.content_id, '1979366117396988012')
  assert.equal(item.id, row.content_id)
  assert.equal(item.externalId, row.content_id)
  assert.equal(item.title, null)
  assert.equal(item.text, post().text)
  assert.equal(item.publishedAt, '2026-10-18T05:00:00.000Z')
  assert.equal(item.collectedAt, capturedAt)
  assert.equal(item.url, `https://twitter.com/example/status/${row.content_id}`)
  assert.deepEqual(item.author, { id: '1899000000000000001', name: '作者', avatarUrl: 'https://cdn.example/avatar.jpg' })
  assert.deepEqual(item.metrics, { likes: 0, comments: 1, shares: 2, views: 5, bookmarks: 4 })
  assert.equal(row.quote_count, 3)
  assert.equal(row.comment_count, 1)
  assert.deepEqual(row.metadata, { hashtags: ['话题'] })
  assert.deepEqual(result.providerPage, { hasMore: true, nextParams: { cursor: 'next-page' }, nextPage: null,
    paginationMode: 'cursor', sourceCount: 1 })
  assert.deepEqual(result.restrictedResponseArchive, { sha256: 'immutable' })
})

test('metrics preserve genuine zero while missing, boolean, unsafe, negative and fractional counts stay unknown', () => {
  for (const invalid of [null, undefined, '', ' ', true, false, -1, 1.5, '1.5', '-1', '01', '9007199254740993', Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, -0]) {
    const row = project({ timeline: [post(undefined, { favorites: invalid, views: invalid })], next_cursor: null }).items[0]
    assert.equal(row.like_count, null, String(invalid)); assert.equal(row.view_count, null, String(invalid))
  }
  for (const zero of [0, '0']) assert.equal(project({ timeline: [post(undefined, { views: zero })] }).items[0].view_count, 0)
})

test('native tweet ID must remain a positive decimal string and is never synthesized from URL or numeric ID', () => {
  for (const invalid of [null, undefined, '', 12, 1979366117396988012, '0', '-1', '1.2', 'abc', '1\0', '9'.repeat(31)]) {
    assert.throws(() => project({ timeline: [post(undefined, { tweet_id: invalid, id: '123', url: 'https://twitter.com/i/status/123' })] }), /invalid_content_search_identity/)
  }
  const row = project({ timeline: [post(undefined, { user_info: { rest_id: 12, screen_name: 'bad/name', name: '作者' } })] }).items[0]
  assert.equal(row.author_id, null)
  assert.equal(row.url, `https://twitter.com/i/status/${row.content_id}`)
})

test('photo/video assets stay separate, select best mp4 rendition and retain every attachment without modifying raw input', () => {
  const photo = { id: '1', media_url_https: 'https://cdn.example/photo.jpg' }
  const video = { id: '2', media_url_https: 'https://cdn.example/poster.jpg', duration: 3,
    variants: [{ content_type: 'application/x-mpegURL', url: 'https://cdn.example/video.m3u8' },
      { content_type: 'video/mp4', bitrate: 100, url: 'https://cdn.example/low.mp4' },
      { content_type: 'video/mp4', bitrate: 900, url: 'https://cdn.example/high.mp4' }] }
  const data = { timeline: [post(undefined, { media: { photo: [photo], video: [video,
    { media_url_https: 'https://cdn.example/poster2.jpg', variants: [{ content_type: 'application/x-mpegURL', url: 'https://cdn.example/second.m3u8' }] }] },
    entities: { media: [{ ...photo, type: 'photo' }, { type: 'video', media_url_https: video.media_url_https, video_info: { variants: video.variants } }] } })] }
  const before = structuredClone(data), row = project(data).items[0]
  assert.deepEqual(data, before)
  assert.deepEqual(JSON.parse(row.image_urls), ['https://cdn.example/photo.jpg'])
  assert.deepEqual(JSON.parse(row.video_urls), ['https://cdn.example/high.mp4', 'https://cdn.example/second.m3u8'])
  assert.equal(row.cover_url, 'https://cdn.example/poster.jpg')
})

test('photo-only and text-only records retain empty media rather than guessed assets', () => {
  const textOnly = project({ timeline: [post()] }).items[0]
  assert.equal(textOnly.cover_url, null); assert.deepEqual(JSON.parse(textOnly.image_urls), [])
  const photo = project({ timeline: [post(undefined, { media: { photo: [{ media_url_https: 'https://cdn.example/only.jpg' }] } })] }).items[0]
  assert.equal(photo.cover_url, 'https://cdn.example/only.jpg')
  assert.deepEqual(JSON.parse(photo.video_urls), [])
})

test('provider page size is a hint: all paid items survive overflow before shared buffering', () => {
  const timeline = Array.from({ length: 27 }, (_, index) => post(String(1000 + index)))
  const result = project({ timeline, next_cursor: 'next' }, { pageSize: 20 })
  assert.equal(result.items.length, 27); assert.equal(result.acquiredItems.length, 27)
  assert.equal(result.providerPage.sourceCount, 27)
  assert.equal(result.items.at(-1).content_id, '1026')
})

test('duplicates use first native identity while all distinct results survive and raw evidence stays unchanged', () => {
  const data = { timeline: [post('1'), post('1', { text: 'later copy' }), post('2')], next_cursor: '' }
  const result = project(data)
  assert.equal(result.items.length, 2); assert.equal(result.duplicateCount, 1)
  assert.equal(result.items[0].text, post().text)
  assert.equal(data.timeline.length, 3)
  assert.equal(result.nonPostCount, 0)
})

test('empty and short pages keep valid continuation; missing continuation metadata is unknown', () => {
  for (const timeline of [[], [post()]]) {
    assert.equal(project({ timeline, next_cursor: 'next' }).providerPage.hasMore, true)
    for (const end of [null, '']) assert.equal(project({ timeline, next_cursor: end }).providerPage.hasMore, false)
    assert.equal(project({ timeline }).providerPage.hasMore, null)
  }
  const repeated = project({ timeline: [post()], next_cursor: 'same' }, { upstreamQuery: { cursor: 'same' } })
  assert.equal(repeated.items.length, 1)
  assert.deepEqual(repeated.providerPage, { hasMore: false, nextParams: null, nextPage: null,
    paginationMode: 'cursor', sourceCount: 1, stopReason: 'repeated_cursor' })
})

test('malformed continuations cannot authorize another page', () => {
  for (const next_cursor of [1, true, {}, [], ' ', '\0', '\ud800', 'x'.repeat(4097)]) {
    assert.throws(() => project({ timeline: [], next_cursor }), /invalid_content_search_continuation/)
  }
})

test('known extra data wrapper is accepted, but arbitrary trees and malformed timeline entries are not treated as empty success', () => {
  assert.equal(project({ data: { timeline: [post()], next_cursor: null } }).items.length, 1)
  for (const payload of [{}, { recommendations: { timeline: [post()] } }, { timeline: {} }, { timeline: [null] }, { timeline: [{ user_info: { rest_id: '1' } }] }]) {
    assert.throws(() => project(payload))
  }
  assert.throws(() => project({ code: 400, timeline: [] }), /content_search_business_rejected/)
  assert.throws(() => project({ code: 400, data: { timeline: [post()] } }), /content_search_business_rejected/)
  assert.throws(() => project({ timeline: Array(10001).fill(post()) }), /content_search_page_too_large/)
})

test('unrelated unknown metadata does not poison projected rows, while projected text must be PostgreSQL-safe', () => {
  const row = project({ timeline: [post(undefined, { unrelated: '\0', unknown: { number: Infinity } })], other: '\ud800' }).items[0]
  assert.equal(isPostgresSafeJsonValue(row), true)
  for (const text of ['bad\0text', 'bad\ud800text']) {
    assert.throws(() => project({ timeline: [post(undefined, { text })] }), /invalid_content_search_projection/)
  }
  const projected = project({ timeline: [post()] })
  const records = rawSearchRecords({ data: { raw_info: '[]', raw_data: JSON.stringify(projected.acquiredItems), page: {}, meta: {} } }, 'twitter', 'tikhub')
  assert.equal(records.length, 1)
  for (const record of records) for (const value of Object.values(record)) {
    assert.equal(isPostgresSafeJsonValue(value instanceof Date ? value.toISOString() : value), true)
  }
})

test('archive helper exposes complete rows and supplier cursor without issuing requests or slicing delivery size', () => {
  const result = projectTikHubTwitterTimeline({ timeline: [post()], next_cursor: 'next' }, { pageSize: 1 }, capturedAt)
  assert.equal(result.rows.length, 1); assert.equal(result.nextProviderCursor, 'next'); assert.equal(result.hasMore, true)
  assert.throws(() => projectTikHubTwitterTimeline({ timeline: [] }, {}, 'bad'), /invalid_content_search_capture_time/)
})
