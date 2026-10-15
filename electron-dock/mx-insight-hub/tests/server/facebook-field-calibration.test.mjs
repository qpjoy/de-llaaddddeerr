import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import * as facebook from '../../server/contracts/facebook-search.mjs'
import { projectDataSearch } from '../../server/contracts/hub-data-search.mjs'
import { rawSearchRecords, RAW_SEARCH_VERSION } from '../../server/contracts/raw-search.mjs'
import { isNightAllDataSearchV1Envelope } from '../../server/contracts/night-all-data-search.mjs'
import { createDataSearchCursorCodec, createRawSearchCursorCodec } from '../../server/external-platforms/cursor.mjs'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'
import { JustOneAdapter } from '../../server/adapters/justone.mjs'
import { canonicalJson, sha256 } from '../../server/ingest/normalizers.mjs'

const capturedAt = '2026-10-15T03:00:00.000Z'
const query = '(练习生 OR "idol trainee")'
const dates = { startTime: '2026-10-12T00:47:59.087335+00:00', endTime: '2026-10-15T00:47:59.087335+00:00' }
const secret = 'facebook-field-calibration-offline-secret-32-characters'
const fixture = async provider => JSON.parse(await readFile(new URL(`../fixtures/facebook/${provider}-search.success.json`, import.meta.url), 'utf8'))
const sourcePosts = (body, provider) => provider === 'rapid' ? body.results : body.data.results
function request(format = 'raw', overrides = {}, identity = 'fixture-consumer-key') {
  const codec = format === 'raw' ? createRawSearchCursorCodec(secret, identity) : createDataSearchCursorCodec(secret, identity)
  const body = { platform: 'facebook', query, params: dates, ...(format === 'raw' ? { count: 20 } : { pageSize: 20 }), ...overrides }
  return { codec, body, normalized: facebook.normalizeFacebookSearch(format === 'raw' ? { upstreamBody: body, pageSize: body.count } : body,
    codec, format === 'raw' ? null : { resultType: 'stable' }) }
}
function assertSameContent(raw, item, record) {
  assert.equal(item.id, raw.content_id)
  assert.equal(item.externalId, raw.content_id)
  assert.equal(record.externalId, raw.content_id)
  assert.equal(item.contentType, raw.content_type || 'post')
  assert.equal(record.contentType, raw.content_type || 'post')
  assert.equal(item.text, raw.full_text || null)
  assert.equal(record.body, raw.full_text || null)
  assert.equal(item.title, null)
  assert.equal(record.title, null)
  assert.equal(item.publishedAt, raw.created_at)
  assert.equal(record.eventTime instanceof Date ? record.eventTime.toISOString() : record.eventTime, raw.created_at)
  assert.equal(item.author.id, raw.author_id || null)
  assert.equal(item.author.name, raw.author_name || null)
  assert.equal(item.author.avatarUrl, raw.author_avatar_url || null)
  assert.equal(record.authorExternalId || null, raw.author_id || null)
  assert.equal(record.authorName || null, raw.author_name || null)
  assert.equal(record.stableFields.author.avatarUrl || null, raw.author_avatar_url || null)
  for (const [key, field] of Object.entries({ likes: 'like_count', comments: 'comment_count', shares: 'forward_count', views: 'view_count' })) {
    assert.equal(item.metrics[key], raw[field])
    assert.equal(record.metrics[key] ?? null, raw[field])
  }
  const images = JSON.parse(raw.image_urls), videos = JSON.parse(raw.video_urls)
  assert.deepEqual(item.media.images, images)
  assert.deepEqual(item.media.videos, videos)
  assert.deepEqual(record.stableFields.media.images, images)
  assert.deepEqual(record.stableFields.media.videos, videos)
  assert.equal(item.media.coverUrl, raw.cover_url || null)
  assert.equal(record.stableFields.media.coverUrl, raw.cover_url || null)
}

test('Facebook synthetic supplier fixtures keep the existing raw, standard and canonical field contracts aligned', async t => {
  for (const provider of ['rapidapi', 'justone']) await t.test(provider, async () => {
    const payload = await fixture(provider === 'rapidapi' ? 'rapid' : provider), original = structuredClone(payload)
    const { normalized } = request('standard')
    const projected = facebook.projectFacebookSearch(provider === 'rapidapi' ? payload : payload.data,
      normalized, provider, capturedAt)
    const standard = projectDataSearch(projected, normalized)
    const canonical = rawSearchRecords(projected.publicBody, 'facebook', provider, { projectionVersion: normalized.projectionVersion })
    assert.equal(projected.publicBody.contractVersion, RAW_SEARCH_VERSION)
    assert.ok(isNightAllDataSearchV1Envelope(standard))
    assert.equal(standard.data.contractVersion, 'night-all.data-search.v1')
    assert.equal(standard.data.items.length, 3)
    assert.equal(canonical.length, 3)
    assert.deepEqual(JSON.parse(projected.publicBody.data.raw_data), projected.items)
    projected.items.forEach((row, index) => assertSameContent(row, standard.data.items[index], canonical[index]))
    assert.deepEqual(payload, original, 'calibration does not mutate original supplier data')
    assert.deepEqual(projected.items.map(row => row.album_preview), sourcePosts(payload, provider === 'rapidapi' ? 'rapid' : provider).map(row => row.album_preview))
    assert.equal(standard.data.items[0].source.provider, null)
    assert.equal(standard.data.items[0].source.endpointId, null)
    assert.equal(projected.publicBody.data.page.hasMore, true)
    assert.doesNotMatch(projected.publicBody.data.page.nextCursor, /synthetic-rapid-next|fixture-justone-next-cursor/)
  })
})

test('JustOne documented album image_file_uri wins over its Facebook photo landing URL without inventing missing album media', async () => {
  const payload = await fixture('justone'), original = structuredClone(payload.data.results[0])
  const row = facebook.facebookRow(payload.data.results[0], capturedAt)
  assert.deepEqual(JSON.parse(row.image_urls), ['https://cdn.example.test/album-1.jpg', 'https://cdn.example.test/album-2.jpg'])
  assert.equal(row.album_preview.length, 2)
  assert.equal(row.images_count, 8)
  assert.deepEqual(row.album_preview, original.album_preview)
  assert.deepEqual(payload.data.results[0], original)
  assert.equal(JSON.parse(row.image_urls).some(value => value.includes('facebook.com/photo.php')), false)
})

test('Facebook poster separation is identical in raw, standard and canonical projection while exact supplier URLs remain archived', async () => {
  const payload = await fixture('rapid'), source = payload.results[1], original = structuredClone(source)
  const { normalized } = request('standard')
  const projected = facebook.projectFacebookSearch({ results: [source], cursor: null }, normalized, 'rapidapi', capturedAt)
  const row = projected.items[0], standard = projectDataSearch(projected, normalized)
  const canonical = rawSearchRecords(projected.publicBody, 'facebook', 'rapidapi', { projectionVersion: normalized.projectionVersion })
  assert.deepEqual(JSON.parse(row.image_urls), ['https://cdn.example.test/mixed-photo.jpg'])
  assert.deepEqual(JSON.parse(row.video_urls), ['https://cdn.example.test/video-hd.mp4?sig=one', 'https://cdn.example.test/video-sd.mp4?sig=two'])
  assert.equal(row.cover_url, 'https://cdn.example.test/poster.jpg?sig=one')
  assertSameContent(row, standard.data.items[0], canonical[0])
  assert.deepEqual(source, original)
  assert.deepEqual(row.video_thumbnail, original.video_thumbnail)
  assert.deepEqual(row.video_files, original.video_files)
})

test('Facebook known normalized aliases preserve complete body, author, metrics and media without overriding explicit supplier zero or unknown', () => {
  const body = '正文\n'.repeat(5000)
  const source = { post_id: 'compat-post', message: '', full_text: body,
    author_name: 'Compat Author', user_name: 'Compat Username', author_id: 'compat-author', author_avatar_url: 'https://cdn.example.test/avatar.jpg',
    created_time: '1791763200', like_count: '12', reply_count: 3, share_count: '4', view_count: '50',
    image_urls: JSON.stringify(['https://cdn.example.test/compat-photo.jpg']), video_urls: JSON.stringify(['https://cdn.example.test/compat-video.mp4']) }
  const original = structuredClone(source), row = facebook.facebookRow(source, capturedAt)
  assert.equal(row.full_text, body)
  assert.equal(row.text, body)
  assert.equal(row.content, body)
  assert.equal(row.author_name, 'Compat Author')
  assert.equal(row.author_id, 'compat-author')
  assert.equal(row.author_avatar_url, source.author_avatar_url)
  assert.equal(row.created_at, '2026-10-12T00:00:00.000Z')
  assert.equal(row.like_count, 12)
  assert.equal(row.comment_count, 3)
  assert.equal(row.forward_count, 4)
  assert.equal(row.view_count, 50)
  assert.deepEqual(JSON.parse(row.image_urls), JSON.parse(source.image_urls))
  assert.deepEqual(JSON.parse(row.video_urls), JSON.parse(source.video_urls))
  assert.deepEqual(source, original)
  const explicit = facebook.facebookRow({ ...source, reactions_count: 0, comments_count: null, reshare_count: '0', video_view_count: null }, capturedAt)
  assert.deepEqual([explicit.like_count, explicit.comment_count, explicit.forward_count, explicit.view_count], [0, null, 0, null])
})

test('Facebook strict counts distinguish zero from empty, boolean, composite, fractional and unsafe values', () => {
  for (const value of ['', '  ', false, true, [], [1], {}, -1, '-1', 1.5, '1.5', Number.MAX_SAFE_INTEGER + 1, '9007199254740992']) {
    const row = facebook.facebookRow({ post_id: 'metric-post', reactions_count: value, comments_count: value, reshare_count: value, video_view_count: value }, capturedAt)
    assert.deepEqual([row.like_count, row.comment_count, row.forward_count, row.view_count], [null, null, null, null], `invalid metric ${JSON.stringify(value)}`)
  }
  for (const value of [0, '0', 123, '123']) {
    assert.equal(facebook.facebookRow({ post_id: 'metric-post', reactions_count: value }, capturedAt).like_count, Number(value))
  }
})

test('Facebook calibrated shares override an older normalized alias consistently in standard output and canonical ingestion', () => {
  const { normalized } = request('standard')
  for (const shares of [0, 3, null]) {
    const projected = facebook.projectFacebookSearch({ results: [{ post_id: 'share-alias-post', message: 'complete body',
      reshare_count: shares, share_count: '999' }], cursor: null }, normalized, 'rapidapi', capturedAt)
    const standard = projectDataSearch(projected, normalized)
    const canonical = rawSearchRecords(projected.publicBody, 'facebook', 'rapidapi', { projectionVersion: normalized.projectionVersion })
    assert.equal(projected.items[0].forward_count, shares)
    assert.equal(projected.items[0].share_count, shares)
    assert.equal(standard.data.items[0].metrics.shares, shares)
    assert.equal(canonical[0].metrics.shares ?? null, shares)
  }
})

test('Facebook v2 explicit unknowns cannot be revived from retained aliases during canonical ingestion; v1 and unrelated mapping stay unchanged', () => {
  const { normalized } = request('standard')
  const source = { post_id: 'unknown-alias-post', type: 'video', message: '', text: '', content: '',
    caption: 'retained old caption', description: 'retained old description',
    author_id: null, user_id: 'retained-old-user-id', author_name: '', authorName: 'Retained Old Name',
    timestamp: null, created_at: '2021-01-01T00:00:00.000Z', created_time: '2022-02-02T00:00:00.000Z',
    reactions_count: null, like_count: 10, likes: 11, digg_count: 12,
    comments_count: null, comment_count: 20, comments: 21, reply_count: 22,
    reshare_count: null, forward_count: 30, share_count: 31, shares: 32, repost_count: 33,
    video_view_count: null, view_count: 40, views: 41, play_count: 42,
    bookmark_count: null, bookmarks: 51, collect_count: 52 }
  const original = structuredClone(source)
  const projected = facebook.projectFacebookSearch({ results: [source], cursor: null }, normalized, 'rapidapi', capturedAt)
  const row = projected.items[0], originalRow = structuredClone(row)
  const standard = projectDataSearch(projected, normalized)
  const [record] = rawSearchRecords(projected.publicBody, 'facebook', 'rapidapi', { projectionVersion: normalized.projectionVersion })
  const unknownMetrics = { likes: null, comments: null, shares: null, views: null, bookmarks: null }
  assert.deepEqual([row.like_count, row.comment_count, row.forward_count, row.view_count, row.bookmark_count], [null, null, null, null, null])
  assert.equal(row.created_at, null)
  assert.equal(row.full_text, '')
  assert.deepEqual(standard.data.items[0].metrics, unknownMetrics)
  assert.deepEqual(record.metrics, unknownMetrics)
  assert.deepEqual(record.stableFields.metrics, unknownMetrics)
  assert.equal(record.eventTime, null)
  assert.equal(record.body, null)
  assert.equal(record.authorExternalId, null)
  assert.equal(record.authorName, null)
  assert.equal(record.stableFields.author.externalId, null)
  assert.equal(record.stableFields.author.name, null)
  assertSameContent(row, standard.data.items[0], record)
  assert.deepEqual(record.rawItem, originalRow)
  assert.equal(record.rawPayloadSha256, sha256(canonicalJson(originalRow)))
  assert.deepEqual(row, originalRow)
  assert.deepEqual(source, original)
  assert.equal(row.likes, 11)
  assert.equal(row.comments, 21)
  assert.equal(row.shares, 32)
  assert.equal(row.repost_count, 33)
  assert.equal(row.views, 41)
  assert.equal(row.bookmarks, 51)
  assert.equal(row.collect_count, 52)
  assert.equal(row.created_time, '2022-02-02T00:00:00.000Z')

  const [legacy] = rawSearchRecords(projected.publicBody, 'facebook', 'rapidapi')
  const [v1] = rawSearchRecords(projected.publicBody, 'facebook', 'rapidapi', { projectionVersion: 1 })
  const [unrelated] = rawSearchRecords(projected.publicBody, 'twitter', 'rapidapi', { projectionVersion: 2 })
  assert.deepEqual(v1, legacy)
  for (const old of [legacy, v1, unrelated]) {
    assert.deepEqual(old.metrics, { likes: 11, comments: 21, shares: 32, views: 41, bookmarks: 51 })
    assert.equal(old.eventTime.toISOString(), '2022-02-02T00:00:00.000Z')
    assert.equal(old.body, 'retained old caption')
    assert.equal(old.authorExternalId, 'retained-old-user-id')
    assert.equal(old.authorName, 'Retained Old Name')
    assert.equal(old.contentType, 'video')
    assert.deepEqual(old.rawItem, originalRow)
    assert.equal(old.rawPayloadSha256, record.rawPayloadSha256)
  }
})

test('Facebook numeric string and numeric epoch seconds or milliseconds share the same UTC timestamp', () => {
  for (const value of [1791763200, '1791763200', 1791763200000, '1791763200000', '2026-10-12T00:00:00Z']) {
    assert.equal(facebook.facebookRow({ post_id: 'time-post', timestamp: value }, capturedAt).created_at, '2026-10-12T00:00:00.000Z')
  }
  for (const value of ['', false, [], {}, 'not-a-time']) {
    assert.equal(facebook.facebookRow({ post_id: 'time-post', timestamp: value }, capturedAt).created_at, null)
  }
})

test('Facebook raw and standard adapters preserve the complete query and dates and retain exact fixture receipts', async t => {
  for (const format of ['raw', 'standard']) for (const provider of ['rapidapi', 'justone']) await t.test(`${format}-${provider}`, async () => {
    const payload = await fixture(provider === 'rapidapi' ? 'rapid' : provider), original = structuredClone(payload)
    const bytes = Buffer.from(JSON.stringify(payload)), { normalized } = request(format), step = normalized.forProvider(provider)
    const calls = [], fetchImpl = async (input, options) => {
      calls.push({ url: new URL(input), method: options.method })
      return new Response(bytes, { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const result = provider === 'rapidapi'
      ? await new RapidApiAdapter({ apiKey: 'fixture-key', fetchImpl }).execute({ ...normalized, ...step })
      : await new JustOneAdapter({ token: 'fixture-key', fetchImpl, logger: { warn() {}, error() {} } }).forwardNative(facebook.FACEBOOK_JUSTONE_KEY, { params: step.upstreamQuery })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'GET')
    const sent = calls[0].url.searchParams
    assert.equal(sent.get(provider === 'rapidapi' ? 'query' : 'keyword'), query)
    assert.equal(sent.get(provider === 'rapidapi' ? 'start_date' : 'startDate'), '2026-10-12')
    assert.equal(sent.get(provider === 'rapidapi' ? 'end_date' : 'endDate'), '2026-10-15')
    assert.equal(sent.has('count'), false)
    assert.equal(sent.has('pageSize'), false)
    assert.equal(sent.has('cursor'), false)
    assert.deepEqual(result.restrictedResponseArchive.bodyBytes, bytes)
    assert.deepEqual(result.restrictedResponseArchive.parsedPayload, original)
    assert.deepEqual(payload, original)
    if (provider === 'rapidapi') assert.equal(result.publicBody.data.items[0].full_text, payload.results[0].message)
    else assert.deepEqual(result.publicBody.data.results, payload.data.results)
  })
})

test('Facebook new cursor projection version is pinned while untagged old cursors retain the frozen v1 projection', async () => {
  const { normalized, codec, body } = request(), payload = await fixture('justone')
  assert.equal(normalized.projectionVersion, 2)
  const cursor = normalized.encodeNext('justone', 'supplier-cursor')
  const state = codec.decode(cursor)
  assert.equal(state.projectionVersion, 2)
  assert.equal(state.provider, 'justone')
  const resumed = request('raw', { cursor }).normalized
  assert.equal(resumed.projectionVersion, 2)
  assert.equal(resumed.provider, 'justone')
  assert.equal(resumed.forProvider('justone').upstreamQuery.cursor, 'supplier-cursor')
  const oldState = { ...state }
  delete oldState.projectionVersion
  const oldCursor = codec.encode(oldState), oldRequest = request('raw', { cursor: oldCursor }).normalized
  assert.equal(oldRequest.projectionVersion, 1)
  assert.equal(codec.decode(oldRequest.encodeNext('justone', 'supplier-next')).projectionVersion, 1)
  const oldResult = facebook.projectFacebookSearch(payload.data, oldRequest, 'justone', capturedAt)
  assert.deepEqual(oldResult.items, payload.data.results.map(post => facebook.facebookRowV1(post, capturedAt)))
  assert.equal(facebook.facebookRowV1({ post_id: 'old-time', timestamp: '1791763200' }, capturedAt).created_at, null)
  assert.equal(facebook.facebookRowV1({ post_id: 'old-count', reactions_count: '' }, capturedAt).like_count, 0)
  for (const change of [
    { query: 'another query' }, { count: 10 }, { params: { ...dates, endTime: '2026-10-14T00:00:00Z' } },
  ]) assert.throws(() => request('raw', { ...body, ...change, cursor }), { code: 'invalid_cursor' })
  assert.throws(() => request('raw', { cursor }, 'another-consumer-key'), { code: 'invalid_cursor' })
  assert.throws(() => request('standard', { cursor }), { code: 'invalid_cursor' })
  assert.throws(() => request('raw', { cursor: codec.encode({ ...state, projectionVersion: 3 }) }), { code: 'invalid_cursor' })
})

test('Facebook JustOne business 301 never enters successful field projection or triggers an adapter retry', async () => {
  let calls = 0
  const payload = { code: 301, message: 'COLLECT FAILED, SEND REQUEST AGAIN', data: null, requestId: 'fixture-301', recordTime: null }
  const adapter = new JustOneAdapter({ token: 'fixture-key', logger: { warn() {}, error() {} }, fetchImpl: async () => {
    calls += 1
    return Response.json(payload)
  } })
  const { normalized } = request()
  await assert.rejects(adapter.forwardNative(facebook.FACEBOOK_JUSTONE_KEY, { params: normalized.forProvider('justone').upstreamQuery }), error => {
    assert.equal(error.evidence.outcome, 'rejected')
    assert.equal(error.evidence.businessCode, 301)
    assert.equal(error.evidence.errorCode, 'upstream_collection_failed')
    assert.equal(error.evidence.billed, false)
    assert.deepEqual(error.restrictedResponseArchive.parsedPayload, payload)
    assert.equal(error.publicBody, undefined)
    return true
  })
  assert.equal(calls, 1)
})
