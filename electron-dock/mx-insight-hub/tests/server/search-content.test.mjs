import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { normalizeSearchContent, normalizeSearchMedia } from '../../server/contracts/search-content.mjs'
import { normalizeSearchPayload, canonicalJson, sha256 } from '../../server/ingest/normalizers.mjs'
import { normalizeNightAllLegacyPayload } from '../../server/ingest/legacy-night-all.mjs'
import { isNightAllDataSearchV1Envelope } from '../../server/contracts/night-all-data-search.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { createApp } from '../../server/app.mjs'

const COVER = 'https://media.example.test/poster.jpg?sig=original'
const PHOTO = 'https://media.example.test/photo.jpg'
const VIDEO = 'https://media.example.test/video.mp4'
function item(overrides = {}) {
  return { id: 'douyin:post-1', externalId: 'post-1', platform: 'douyin', contentType: 'video',
    url: 'https://www.douyin.com/video/123456789', title: '原生标题', text: '完整正文',
    publishedAt: '2026-10-09T02:00:00.000Z', collectedAt: '2026-10-09T02:00:10.000Z',
    author: { id: 'author-1', name: '作者', avatarUrl: null },
    metrics: { likes: 3, comments: 0, shares: 0, views: null, bookmarks: null },
    media: { coverUrl: COVER, images: [COVER], videos: [VIDEO] },
    source: { provider: null, endpointId: null }, ...overrides }
}
function modern(items = [item()]) {
  return { data: { contractVersion: 'night-all.data-search.v1', platform: 'douyin', query: '汽车', items,
    pageInfo: { pageIndex: 1, pageSize: 20, returnedCount: items.length, hasMore: false, nextCursor: null, cursorType: 'none' },
    status: 'ok', warnings: [], meta: { providerCalls: 1 } } }
}
function rawRow(overrides = {}) {
  return { content_id: 'post-1', platform_name: 'douyin', content_type: 'video', title: '原生标题',
    text: '完整正文', full_text: '完整正文', author_id: 'author-1', author_name: '作者',
    published_at: 1791511200, collected_at: 1791511210, cover_url: COVER,
    image_urls: JSON.stringify([COVER]), video_urls: JSON.stringify([VIDEO]), ...overrides }
}
function legacy(rows = [rawRow()]) {
  return { data: { raw_info: JSON.stringify([{ user_id: 'author-1', name: '账号名', image_urls: JSON.stringify([COVER]) }]),
    raw_data: JSON.stringify(rows), page: { page: 1, pageSize: 20, returnedCount: rows.length, hasMore: false, nextCursor: null },
    meta: { resultCount: rows.length } } }
}

test('modern and raw deliveries remove the duplicated video poster while retaining contracts and originals', () => {
  const source = modern(), raw = legacy(), before = structuredClone({ source, raw })
  const output = normalizeSearchContent(source, 'douyin')
  assert.ok(isNightAllDataSearchV1Envelope(output))
  assert.deepEqual(output.data.items[0], { ...item(), media: { coverUrl: COVER, images: [], videos: [VIDEO] } })
  const old = normalizeSearchContent(raw, 'douyin', { format: 'raw' })
  assert.deepEqual(JSON.parse(old.data.raw_data)[0], { ...rawRow(), image_urls: '[]' })
  assert.equal(old.data.raw_info, raw.data.raw_info)
  assert.deepEqual(old.data.page, raw.data.page)
  assert.deepEqual({ source, raw }, before)
  assert.deepEqual(normalizeSearchContent(output, 'douyin'), output)
  assert.deepEqual(normalizeSearchContent(old, 'douyin', { format: 'raw' }), old)
})

test('production Douyin kind 4 keeps its original type and removes exactly the matching cover', () => {
  const output = normalizeSearchContent(modern([item({ contentType: '4' })]), 'douyin').data.items[0]
  assert.equal(output.contentType, '4')
  assert.deepEqual(output.media, { coverUrl: COVER, images: [], videos: [VIDEO] })
  const raw = normalizeSearchContent(legacy([rawRow({ content_type: '4' })]), 'douyin', { format: 'raw' })
  assert.equal(JSON.parse(raw.data.raw_data)[0].content_type, '4')
  assert.equal(JSON.parse(raw.data.raw_data)[0].image_urls, '[]')
})

test('photo galleries, real mixed attachments, missing posters and CDN URL variants are preserved', () => {
  for (const contentType of ['image', 'photo', 'carousel', 'mixed', '图文', '68', '150']) {
    const source = item({ contentType })
    assert.deepEqual(normalizeSearchContent(modern([source]), 'douyin').data.items[0], source)
  }
  const media = { coverUrl: COVER, images: [COVER, PHOTO, COVER.replace('original', 'other')], videos: [VIDEO] }
  assert.deepEqual(normalizeSearchMedia(media, 'douyin', { contentType: 'video' }).images, [PHOTO, COVER.replace('original', 'other')])
  assert.equal(normalizeSearchMedia({ ...media, coverUrl: null }, 'douyin').images, media.images)
  assert.equal(normalizeSearchMedia({ ...media, videos: [] }, 'douyin').images, media.images)
  for (const platform of ['instagram', 'xiaohongshu', 'weibo', 'twitter', 'facebook']) {
    assert.equal(normalizeSearchMedia(media, platform), media)
  }
})

test('raw nested results and media objects keep their shape without touching account metadata', () => {
  const media = { images: [{ url: COVER, width: 320 }, { url: PHOTO }], videos: [{ url: VIDEO, coverUrl: COVER }] }
  const row = rawRow({ image_urls: [COVER, PHOTO], media })
  const source = { data: { results: [{ data: { raw_data: JSON.stringify([row]) } }], raw_info: JSON.stringify([row]) } }
  const result = normalizeSearchContent(source, 'douyin', { format: 'raw' })
  const output = JSON.parse(result.data.results[0].data.raw_data)[0]
  assert.deepEqual(output.image_urls, [PHOTO])
  assert.deepEqual(output.media.images, [{ url: PHOTO }])
  assert.equal(result.data.raw_info, source.data.raw_info)
  assert.deepEqual(output.media.videos, media.videos)
  const nestedOnly = normalizeSearchContent(legacy([rawRow({ image_urls: '[]', media })]), 'douyin', { format: 'raw' })
  assert.equal(JSON.parse(nestedOnly.data.raw_data)[0].image_urls, '[]')
  assert.deepEqual(JSON.parse(nestedOnly.data.raw_data)[0].media.images, [{ url: PHOTO }])
  const independent = normalizeSearchContent(legacy([rawRow({ image_urls: '[]', images: [PHOTO, COVER] })]), 'douyin', { format: 'raw' })
  assert.equal(JSON.parse(independent.data.raw_data)[0].image_urls, '[]')
  assert.deepEqual(JSON.parse(independent.data.raw_data)[0].images, [PHOTO])
  const distinct = normalizeSearchContent(legacy([rawRow({ images: [PHOTO] })]), 'douyin', { format: 'raw' })
  assert.equal(JSON.parse(distinct.data.raw_data)[0].image_urls, '[]')
  assert.deepEqual(JSON.parse(distinct.data.raw_data)[0].images, [PHOTO])
  assert.equal(normalizeSearchMedia(media, 'douyin', { objectType: 'profile' }), media)
})

test('both canonical ingestion paths use the same media policy, retain raw evidence and revise old hashes', () => {
  const source = modern()
  const record = normalizeSearchPayload(source, 'douyin').records[0]
  assert.deepEqual(record.stableFields.media, { coverUrl: COVER, images: [], videos: [VIDEO] })
  assert.deepEqual(record.rawItem, source.data.items[0])
  const { collectedAt, metrics, ...oldContent } = source.data.items[0]
  assert.notEqual(record.payloadSha256, sha256(canonicalJson(oldContent)))
  assert.equal(record.payloadSha256, normalizeSearchPayload(modern([item({ collectedAt: '2026-10-09T03:00:00.000Z', metrics: { likes: 99 } })]), 'douyin').records[0].payloadSha256)
  const raw = legacy()
  const records = normalizeNightAllLegacyPayload(raw, 'douyin', 'raw').records
  const post = records.find(row => row.objectType === 'post')
  assert.deepEqual(post.stableFields.media, record.stableFields.media)
  assert.deepEqual(post.rawItem, rawRow())
  assert.match(post.parserVersion, /douyin-video-cover/)
  assert.equal(post.title, '原生标题')
  assert.equal(records.find(row => row.objectType === 'profile').title, '账号名')
})

async function harness() {
  const store = new MemoryStore(), calls = [], source = modern(), raw = legacy()
  const service = new HubService({ store, apiKeyPepper: 'search-content-test-pepper-at-least-32-bytes', adapter: {
    async search(input) { calls.push({ format: 'data', input }); return { payload: structuredClone(source), raw: structuredClone(source) } },
    async legacySearch(input) { calls.push({ format: 'raw', input }); return { payload: structuredClone(raw), raw: structuredClone(raw) } },
  } })
  const tenant = await service.createTenant({ name: 'Search content' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Original Delta caller' })
  await service.putPlatformConfiguration('douyin', { tenantId: tenant.id, consumerId: consumer.id, enabled: true, maxRequests: 1000, windowSeconds: 3600, maxPageSize: 100 })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Original key', platforms: ['douyin'], capabilities: [] })
  const context = await service.authenticate(key.secret)
  return { store, service, calls, key, context, source, raw }
}

test('old raw aliases enter the shared search service, retain one raw charge and immutable replay', async t => {
  const h = await harness()
  const formats = [], search = h.service.search.bind(h.service)
  h.service.search = (context, input) => { formats.push(input.responseFormat || 'data'); return search(context, input) }
  const server = createServer(createApp({ service: h.service, store: h.store, adapter: {}, adminToken: null,
    listenerMode: 'public', logger: { warn() {}, error() {} } }))
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  let first
  for (const path of ['/api/v1/night-all/search/raw', '/api/v1/search/raw']) {
    const response = await fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${h.key.secret}`,
      'content-type': 'application/json', 'idempotency-key': 'douyin-old-client' }, body: JSON.stringify({ platform: 'douyin', keyword: '汽车', count: 20 }) })
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(JSON.parse(body.data.raw_data)[0].image_urls, '[]')
    if (first) assert.deepEqual(body, first)
    first = body
  }
  assert.deepEqual(formats, ['raw', 'raw'])
  assert.equal(h.calls.length, 1)
  assert.equal([...h.store.requests.values()][0].billingMeterKey, 'raw')
  assert.equal([...h.store.requests.values()][0].unitsActual, 1)
  const old = [...h.store.requests.values()][0]
  old.responseBody = { ...h.raw, requestId: old.id }
  const replay = await h.service.nightAllCompatibilitySearch(h.context, { operation: 'raw', body: { platform: 'douyin', keyword: '汽车', count: 20 }, idempotencyKey: 'douyin-old-client', path: '/api/v1/night-all/search/raw' })
  assert.equal(JSON.parse(replay.body.data.raw_data)[0].image_urls, JSON.stringify([COVER]))
  assert.equal(h.calls.length, 1)
})

test('data/search keeps its strict envelope, platform meter and upstream evidence with no second acquisition', async () => {
  const h = await harness()
  const input = { body: { platform: 'douyin', query: '汽车', pageSize: 20 }, idempotencyKey: 'douyin-data-client', path: '/api/v1/data/search' }
  const first = await h.service.search(h.context, input)
  assert.ok(isNightAllDataSearchV1Envelope(first.body))
  assert.deepEqual(first.body.data.items[0].media, { coverUrl: COVER, images: [], videos: [VIDEO] })
  assert.deepEqual((await h.service.search(h.context, input)).body, first.body)
  assert.equal(h.calls.length, 1)
  assert.equal([...h.store.requests.values()][0].billingMeterKey, 'douyin')
  assert.deepEqual(h.source.data.items[0].media.images, [COVER])
  await assert.rejects(() => h.service.search(h.context, { ...input, idempotencyKey: 'invalid-body-format',
    body: { ...input.body, responseFormat: 'raw' } }), error => error.code === 'unsupported_fields')
})

for (const format of ['data', 'raw']) {
  test(`PostgreSQL ${format} ingest revises an old duplicate poster once and preserves its historical evidence`, {
    skip: process.env.MX_INSIGHT_TEST_DATABASE_URL ? false : 'Requires a disposable migrated PostgreSQL',
  }, async () => {
    const pool = new pg.Pool({ connectionString: process.env.MX_INSIGHT_TEST_DATABASE_URL, statement_timeout: 5000 })
    const store = new PostgresStore(pool), id = randomUUID(), externalId = randomUUID()
    const dataset = format === 'data' ? 'night-all.search.v1' : 'night-all.compat.v1'
    const source = format === 'data' ? modern([item({ externalId, id: externalId, contentType: '4' })])
      : { data: { ...legacy([rawRow({ content_id: externalId, content_type: '4' })]).data, raw_info: '[]' } }
    const original = structuredClone(source)
    try {
      await pool.query(`INSERT INTO core.canonical_records
        (id,dataset_id,platform,object_type,external_id,schema_version,payload_sha256,stable_fields)
        VALUES($1,$2,'douyin','post',$3,'content.v1',$4,$5::jsonb)`,
      [id, dataset, externalId, '0'.repeat(64), JSON.stringify({ media: item().media })])
      await pool.query(`INSERT INTO core.record_revisions(record_id,revision,payload_sha256,normalized_payload,parser_version)
        VALUES($1,1,$2,$3::jsonb,'old-fixture')`, [id, '0'.repeat(64), JSON.stringify(source)])
      const ingest = () => format === 'data' ? store.ingestSearchResult({ platform: 'douyin', rawPayload: source })
        : store.ingestExternalRecords({ datasetId: dataset, platform: 'douyin', connectorId: 'night-all-legacy', importRunId: null,
          records: normalizeNightAllLegacyPayload(source, 'douyin', 'raw').records })
      assert.equal((await ingest()).changed, 1)
      assert.equal((await ingest()).changed, 0)
      const current = (await pool.query('SELECT current_revision,stable_fields FROM core.canonical_records WHERE id=$1', [id])).rows[0]
      assert.equal(current.current_revision, 2)
      assert.deepEqual(current.stable_fields.media, { coverUrl: COVER, images: [], videos: [VIDEO] })
      const revisions = (await pool.query('SELECT revision,parser_version,normalized_payload FROM core.record_revisions WHERE record_id=$1 ORDER BY revision', [id])).rows
      assert.equal(revisions.length, 2)
      assert.deepEqual(revisions[0].normalized_payload, original)
      assert.match(revisions[1].parser_version, /douyin-video-cover/)
      assert.deepEqual(source, original)
    } finally { await pool.end() }
  })
}
