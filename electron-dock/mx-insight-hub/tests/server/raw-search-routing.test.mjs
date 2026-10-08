import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { TikHubAdapter } from '../../server/adapters/tikhub.mjs'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'
import { nativeForwardingEndpoint } from '../../server/contracts/native-forwarding.mjs'
import { createApp } from '../../server/app.mjs'
import { requestFingerprint } from '../../server/core/crypto.mjs'
import { createRawSearchCursorCodec, createDataSearchCursorCodec, createNightAllCompatibilityCursorCodec } from '../../server/external-platforms/cursor.mjs'
import { INSTAGRAM_SEARCH_KEY } from '../../server/contracts/instagram-search.mjs'
import { isNightAllDataSearchV1Envelope } from '../../server/contracts/night-all-data-search.mjs'
import { capNightAllDataSearchTraversal, prepareNightAllCompatibilityTraversal } from '../../server/data/night-all-pagination.mjs'
import { normalizeSearchPayload, canonicalJson, sha256 } from '../../server/ingest/normalizers.mjs'
import { normalizeNightAllLegacyPayload } from '../../server/ingest/legacy-night-all.mjs'
import { rawSearchContentTitles, weiboRow, RAW_SEARCH_PATH, RAW_SEARCH_VERSION,
  WEIBO_SEARCH_KEY, WEIBO_DETAIL_KEY } from '../../server/contracts/raw-search.mjs'

const PEPPER = 'raw-search-fixture-with-sufficient-entropy'
const POST_ID = '5351726865449966'
const AUTHOR = '2471317784'
const PREVIEW = '在名利场中心，我们观察到新的问题。 展开c'
const FULL = '在名利场中心，我们观察到新的问题。这里是经详情确认的完整后文，保留全部内容和话题。#汽车#'
const BODY = { platform: 'weibo', keyword: '汽车', count: 20 }
const preview = { weibo_id: POST_ID, user_name: '作者', user_url: `https://weibo.com/u/${AUTHOR}`,
  publish_time: '14秒前', post_url: `https://weibo.com/${AUTHOR}/Abc`, content: PREVIEW,
  media: { images: ['https://example.test/image.jpg'] }, interaction: { likes: 7, comments: 8, reposts: 9 } }
const instagramPost = { pk: '123456789012345678', code: 'DEMO', taken_at: 1791441120, media_type: 2,
  caption: { text: 'Full Instagram caption <3\nSecond line #tag' }, user: { pk: '7761793874', username: 'creator', profile_pic_url: 'https://example.test/avatar.jpg' },
  image_versions2: { candidates: [{ url: 'https://example.test/large.jpg', width: 1080, height: 1080 }, { url: 'https://example.test/small.jpg', width: 150, height: 150 }] },
  video_versions: [{ url: 'https://example.test/movie.mp4', width: 1080, height: 1920 }], like_count: 12, comment_count: 3 }
function oldDataSearch(platform) {
  return { data: { contractVersion: 'night-all.data-search.v1', platform, query: '汽车',
    items: [{ id: POST_ID, externalId: POST_ID, platform, contentType: 'post', url: 'https://example.test/post', title: PREVIEW,
      text: PREVIEW, publishedAt: null, collectedAt: null, author: { id: AUTHOR, name: '作者', avatarUrl: null },
      metrics: { likes: 1, comments: null, shares: null, views: null, bookmarks: null },
      media: { coverUrl: null, images: [], videos: [] }, source: { provider: null, endpointId: null } }],
    pageInfo: { pageIndex: 1, pageSize: 20, returnedCount: 1, hasMore: false, nextCursor: null, cursorType: 'none' },
    status: 'ok', warnings: [], meta: { providerCalls: 1 } } }
}

function legacy() {
  return { data: { raw_info: JSON.stringify([{ user_id: AUTHOR, name: '账号名' }]),
    raw_data: JSON.stringify([{ content_id: POST_ID, title: '旧合成标题', text: PREVIEW, full_text: PREVIEW }]),
    page: { page: 1, pageSize: 20, returnedCount: 1, hasMore: false, nextCursor: null }, meta: { resultCount: 1 } } }
}

async function harness({ platform = 'weibo', detail = 'success', enabled = true, detailEnabled = true,
  hasMore = false, malformed = false, searchFails = false, rows = [preview], instagramData } = {}) {
  const store = new MemoryStore(), calls = [], historical = []
  const oldPayload = legacy()
  const oldDataPayload = oldDataSearch(platform)
  const service = new HubService({ store, apiKeyPepper: PEPPER,
    adapter: {
      async legacySearch(input) { historical.push(input); return { payload: structuredClone(oldPayload), raw: structuredClone(oldPayload) } },
      async search(input) { historical.push(input); return { payload: structuredClone(oldDataPayload), raw: structuredClone(oldDataPayload) } },
    } })
  const tenant = await service.createTenant({ name: 'Raw fixture' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Raw caller' })
  await store.setPlatformGrant(consumer.id, platform, true)
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Original raw scope', platforms: [platform], capabilities: [] })
  const context = await service.authenticate(key.secret)
  const providerKey = ['weibo', 'instagram'].includes(platform) ? 'tikhub' : 'rapidapi'
  const config = { configured: true, contractVerified: true, dispatchEnabled: true, timeoutMs: 100,
    freshTtlMs: 60000, staleTtlMs: 86400000, maxConcurrency: 3, maxConsumerConcurrency: 3, maxRequestsPerMinute: 100, billing: {} }
  const controls = new MemoryExternalPlatformControlStore()
  const operations = platform === 'weibo' ? [WEIBO_SEARCH_KEY, WEIBO_DETAIL_KEY].map(nativeForwardingEndpoint)
    : platform === 'instagram' ? [nativeForwardingEndpoint(INSTAGRAM_SEARCH_KEY)] : [{ operation: 'social.content.search', endpointKey: 'twitter-aio.search' }]
  for (const [i, endpoint] of operations.entries()) {
    if (!enabled || (i === 1 && !detailEnabled)) continue
    await controls.updatePolicy(providerKey, endpoint.operation, { expectedRevision: 1, desiredState: 'active', reason: 'Offline regression fixture',
      priceBook: { currency: 'USD', pricingAsOf: '2026-10-08T00:00:00Z', monthlyBudgetMinor: 100000,
        monthlySubsidyBudgetMinor: 100000, unitCostMinorByEndpoint: { [endpoint.endpointKey]: 12 } } },
    { runtime: { config, credentialConfigured: true } })
  }
  const Adapter = providerKey === 'tikhub' ? TikHubAdapter : RapidApiAdapter
  const adapter = new Adapter({ apiKey: 'fixture-secret', timeoutMs: 100, fetchImpl: async url => {
    calls.push(new URL(url))
    if (calls.at(-1).pathname.endsWith('fetch_post_detail')) {
      if (detail === 'unknown') throw new Error('connection lost after dispatch')
      if (detail === 'rejected') return Response.json({ code: 400 }, { status: 400 })
      return Response.json({ code: 200, request_id: 'detail-receipt', data: {
        idstr: detail === 'wrong-id' ? '999999' : POST_ID,
        user: { idstr: AUTHOR, screen_name: '作者' }, isLongText: true,
        text: PREVIEW, text_raw: FULL, longText: { content: FULL } } })
    }
    if (searchFails) throw new Error('search transport outcome unknown')
    if (platform === 'instagram') return Response.json({ code: 200, request_id: 'instagram-receipt', data: instagramData || {
      status: 'ok', rank_token: 'search-rank-token', media_grid: { sections: [{ layout_content: { medias: [{ media: instagramPost }] } }],
        more_available: hasMore, ...(hasMore ? { next_max_id: 'next-instagram-page' } : {}) },
      other_results: { keyword_recommendations: { keywords: [{ id: '999', name: 'not a post' }] } },
    } })
    if (platform === 'twitter') return Response.json({ data: { search_by_raw_query: { search_timeline: { timeline: {
      instructions: [{ entries: [{ entryId: 'tweet-one', content: { itemContent: { tweet_results: { result: {
        rest_id: POST_ID, legacy: { full_text: FULL, created_at: '2026-10-08T01:00:00Z', favorite_count: 0 },
      } } } } }, ...(hasMore ? [{ entryId: 'cursor-bottom', content: { cursorType: 'Bottom', value: 'opaque-next' } }] : [])] }],
    } } } } })
    return Response.json({ code: 200, request_id: 'search-receipt', data: malformed ? { unexpected: [] }
      : { parsed_data: { results: rows, result_count: rows.length, pagination: { has_next_page: hasMore } } } })
  } })
  const platformStore = new MemoryExternalPlatformStore({ usageStore: store, providerKey, authorizationPlatform: platform })
  const gateway = new ExternalPlatformGateway({ usageStore: store, platformStore, adapter, config, providerKey,
    apiKeyPepper: PEPPER, reservationLeaseMs: 120000, operationControlStore: controls, logger: { warn() {} } })
  service.externalRawSearch = (context, input) => gateway.searchRaw(context, input)
  service.externalDataSearch = (context, input) => gateway.searchRaw(context, input)
  const invoke = (body = { ...BODY, platform }, idempotencyKey = 'raw-fixture-first') => service.nightAllCompatibilitySearch(context,
    { operation: 'raw', body, idempotencyKey, path: RAW_SEARCH_PATH })
  const invokeData = (body = { platform, query: '汽车', pageSize: 20 }, idempotencyKey = 'data-fixture-first') => service.search(context,
    { body, idempotencyKey, path: '/api/v1/data/search' })
  return { store, service, gateway, platformStore, controls, config, context, key, calls, historical, oldPayload, oldDataPayload, invoke, invokeData }
}

test('raw search fills a Weibo preview through governed detail, archives both receipts and keeps one raw charge', async () => {
  const h = await harness()
  const first = await h.invoke()
  const row = JSON.parse(first.body.data.raw_data)[0]
  assert.equal(row.full_text, FULL)
  assert.equal(row.title, '')
  assert.equal(row.body_completeness, 'full_text')
  assert.equal(row.like_count, 7)
  assert.deepEqual(JSON.parse(row.image_urls), preview.media.images)
  assert.equal(h.historical.length, 0)
  assert.equal(h.calls.length, 2)
  assert.equal(h.calls[1].searchParams.get('is_get_long_text'), 'true')
  assert.equal(h.calls[1].searchParams.get('id'), POST_ID)
  assert.equal(h.store.requests.size, 1)
  assert.equal([...h.store.requests.values()][0].billingMeterKey, 'raw')
  assert.equal(h.platformStore.calls.size, 2)
  assert.equal(h.platformStore.restrictedResponseArchives.size, 2)
  assert.equal(h.platformStore.ingestJobs.length, 1)
  assert.equal(h.platformStore.ingestJobs[0].payload.records[0].body, FULL)
  assert.equal(h.platformStore.ingestJobs[0].payload.platform, 'weibo')
  assert.equal(h.platformStore.ingestJobs[0].payload.records[0].stableFields.connectorId, 'external-platform:tikhub')
  assert.equal(h.platformStore.ingestJobs[0].payload.records[0].extensions.rawSearch.bodyCompleteness, 'full_text')
  assert.deepEqual((await h.invoke()).body, first.body)
  assert.equal(h.calls.length, 2)
})

test('old immutable Night-All delivery replays after cutover without new provider readiness or spend', async () => {
  const h = await harness({ enabled: false })
  const requestId = randomUUID()
  await h.store.reserve({ requestId, idempotencyKey: 'raw-fixture-first',
    fingerprint: requestFingerprint({ method: 'POST', path: RAW_SEARCH_PATH, body: { contractVersion: 'mx-insight-hub.night-all-compat.v1', ...BODY } }),
    tenantId: h.context.tenant.id, consumerId: h.context.consumer.id, apiKeyId: h.context.apiKey.id,
    platform: 'weibo', meterKey: 'raw', unitsReserved: 1, leaseExpiresAt: new Date(Date.now() + 120000),
    windowStart: new Date(Date.now() - 3600000), maxRequests: 100, replayWindowMs: null })
  await h.store.commitRequest(requestId, { responseStatus: 200, responseBody: h.oldPayload, unitsActual: 1 })
  const result = await h.invoke()
  assert.equal(result.replay, true)
  assert.deepEqual(result.body, h.oldPayload)
  assert.equal(h.calls.length, 0)
  assert.equal(h.historical.length, 0)
})

test('one customer raw charge covers search plus detail while each provider receipt keeps its original currency', async () => {
  const h = await harness()
  const plan = await h.service.publishPlanVersion({ key: 'raw-paid-fixture', name: 'Synthetic raw prices',
    limits: { monthlyRequests: 10000, maxPageSize: 100, burstRps: 100 },
    priceBook: { key: 'raw-paid-fixture', currency: 'CNY', defaultMultiplierPpm: 1000000,
      entries: [{ meterKey: 'raw', billingUnit: 'request', unitPriceMinor: 7 }] } }, 'test-admin')
  const current = await h.service.getConsumerPlan(h.context.consumer.id)
  await h.service.assignConsumerPlan(h.context.consumer.id, { planVersionId: plan.versionId, expectedRevision: current.revision }, 'test-admin')
  await h.service.setTenantBillingProfile(h.context.tenant.id, { mode: 'enforced', multiplierPpm: 1000000 }, 'test-admin')
  await h.service.addTenantCredit(h.context.tenant.id, { amountMinor: 100, currency: 'CNY', reason: 'Offline raw fixture' },
    { idempotencyKey: 'raw-credit-fixture', actor: 'test-admin' })
  await h.invoke()
  await h.invoke()
  const charges = [...h.store.customerCharges.values()]
  assert.equal(charges.length, 1)
  assert.equal(charges[0].meterKey, 'raw')
  assert.equal(charges[0].chargedMinor, 7)
  assert.equal(charges[0].status, 'captured')
  assert.equal(h.calls.length, 2)
  const calls = [...h.platformStore.calls.values()]
  assert.ok(calls.every(call => call.currency === 'USD' && call.billed === true))
  assert.equal(calls.reduce((sum, call) => sum + call.costMinor, 0), 24)
  assert.ok([...h.platformStore.costReservations.values()].every(hold => hold.status !== 'active'))
})

test('detail fanout is bounded, repeated post identities spend once, and search evidence survives detail persistence failure', async () => {
  const duplicates = await harness({ rows: [preview, { ...preview }] })
  const result = await duplicates.invoke()
  assert.equal(duplicates.calls.length, 2)
  assert.ok(JSON.parse(result.body.data.raw_data).every(row => row.full_text === FULL))
  assert.equal([...duplicates.store.requests.values()][0].unitsActual, 1)
  const bounded = await harness({ rows: [preview, { ...preview, weibo_id: '5351726865449967' }] })
  const partial = await bounded.invoke({ ...BODY, maxEnrichItems: 1 })
  assert.equal(bounded.calls.length, 2)
  assert.equal(partial.body.data.meta.enrichment.incompleteItems, 1)
  const broken = await harness()
  const stage = broken.platformStore.stageProviderEvidence.bind(broken.platformStore)
  broken.platformStore.stageProviderEvidence = input => input.delivery.operation.includes(WEIBO_DETAIL_KEY)
    ? Promise.reject(new Error('detail receipt write lost')) : stage(input)
  await assert.rejects(broken.invoke())
  assert.equal(broken.calls.length, 2)
  assert.equal(broken.platformStore.restrictedResponseArchives.size, 1)
  assert.equal([...broken.store.requests.values()][0].status, 'unknown')
  await assert.rejects(broken.invoke())
  assert.equal(broken.calls.length, 2)
})

test('raw routing preserves platform/Key admission before any provider call', async () => {
  const h = await harness()
  await h.store.setPlatformGrant(h.context.consumer.id, 'weibo', false)
  await assert.rejects(h.invoke(), { code: 'platform_not_granted' })
  assert.equal(h.calls.length, 0)
  assert.equal(h.store.requests.size, 0)
  const testKey = await harness()
  testKey.context.apiKey.environment = 'test'
  await assert.rejects(testKey.invoke(), { code: 'test_key_not_supported' })
  assert.equal(testKey.calls.length, 0)
})

test('detail rejection, unknown outcome, mismatched identity and paused detail keep an explicit incomplete preview', async () => {
  for (const options of [{ detail: 'rejected' }, { detail: 'unknown' }, { detail: 'wrong-id' }, { detailEnabled: false }]) {
    const h = await harness(options)
    const result = await h.invoke()
    assert.equal(JSON.parse(result.body.data.raw_data)[0].full_text, PREVIEW)
    assert.equal(result.body.data.status, 'partial')
    assert.equal(result.body.data.warnings[0].code, 'WEIBO_FULL_TEXT_INCOMPLETE')
    assert.deepEqual((await h.invoke()).body, result.body)
    assert.equal(h.calls.length, options.detailEnabled === false ? 1 : 2)
    assert.ok([...h.platformStore.calls.values()].every(call => call.outcome !== 'pending'))
    assert.equal(h.historical.length, 0)
  }
})

test('disabled, malformed and uncertain search never fall back to Night-All or dispatch again on replay', async () => {
  for (const options of [{ enabled: false }, { malformed: true }, { searchFails: true }]) {
    const h = await harness(options)
    await assert.rejects(h.invoke())
    const calls = h.calls.length
    await assert.rejects(h.invoke())
    assert.equal(h.calls.length, calls)
    assert.equal(h.historical.length, 0)
    if (options.malformed) assert.equal([...h.platformStore.calls.values()][0].outcome, 'succeeded_unusable')
  }
})

test('Hub raw pagination binds query and Key, limits 15 pages, and never loses a provider continuation', async () => {
  for (const platform of ['weibo', 'twitter']) {
    const h = await harness({ platform, hasMore: true, rows: [{ ...preview, content: FULL }] })
    const body = { ...BODY, platform }
    const first = await h.invoke(body)
    const cursor = first.body.data.page.nextCursor
    assert.ok(cursor.startsWith('mxraw1.'))
    const next = await h.invoke({ ...body, cursor }, 'raw-fixture-page-two')
    assert.equal(next.body.data.page.page, 2)
    assert.equal(h.calls[1].searchParams.get(platform === 'weibo' ? 'page' : 'cursor'), platform === 'weibo' ? '2' : 'opaque-next')
    await assert.rejects(h.invoke({ ...body, keyword: 'changed', cursor }, 'raw-fixture-wrong-query'), { code: 'invalid_cursor' })
    const codec = createRawSearchCursorCodec(PEPPER, `${h.context.consumer.id}:${h.context.apiKey.id}`)
    const state = codec.decode(cursor)
    const last = await h.invoke({ ...body, cursor: codec.encode({ ...state, page: 15 }) }, 'raw-fixture-page-last')
    assert.equal(last.body.data.page.nextCursor, null)
    await assert.rejects(h.invoke({ ...body, cursor: codec.encode({ ...state, page: 16 }) }, 'raw-fixture-too-far'), { code: 'invalid_cursor' })
    const otherCodec = createRawSearchCursorCodec(PEPPER, `${h.context.consumer.id}:different-key`)
    await assert.rejects(h.invoke({ ...body, cursor: otherCodec.encode(state) }, 'raw-fixture-wrong-key'), { code: 'invalid_cursor' })
  }
})

test('Twitter uses existing direct adapter with empty raw title and null canonical title, no new native grant', async () => {
  const h = await harness({ platform: 'twitter' })
  const result = await h.invoke()
  assert.equal(JSON.parse(result.body.data.raw_data)[0].title, '')
  assert.equal(JSON.parse(result.body.data.raw_data)[0].full_text, FULL)
  assert.equal(h.platformStore.ingestJobs[0].payload.records[0].title, null)
  assert.equal(h.historical.length, 0)
  assert.equal(h.calls.length, 1)
})

test('Facebook new raw delivery removes only content titles, preserving archived payload and account names', async () => {
  const h = await harness({ platform: 'facebook' })
  const before = structuredClone(h.oldPayload)
  const result = await h.invoke()
  assert.equal(h.historical.length, 1)
  assert.equal(h.calls.length, 0)
  assert.equal(JSON.parse(result.body.data.raw_data)[0].title, '')
  assert.equal(result.body.data.raw_info, before.data.raw_info)
  assert.deepEqual(h.oldPayload, before)
  assert.deepEqual(rawSearchContentTitles(before, 'xiaohongshu'), before)
  assert.deepEqual((await h.invoke()).body, result.body)
})

test('unsupported batches and existing Night-All shapes stay historical; explicit detail opt-out does not spend', async () => {
  const h = await harness()
  for (const [i, body] of [{ platform: 'weibo', keywords: ['a', 'b'] }, { ...BODY, params: { sort: 'latest' } }, { ...BODY, page: 2 }].entries()) {
    await h.invoke(body, `raw-fixture-legacy-${i}`)
  }
  assert.equal(h.calls.length, 0)
  assert.equal(h.historical.length, 3)
  const result = await h.invoke({ ...BODY, disableAutoDetails: true }, 'raw-fixture-no-detail')
  assert.equal(h.calls.length, 1)
  assert.equal(result.body.data.status, 'partial')
})

test('both HTTP aliases share full-text delivery and replay identity', async t => {
  const h = await harness()
  const server = createServer(createApp({ service: h.service, store: h.store, adapter: {},
    adminToken: null, listenerMode: 'public', logger: { warn() {}, error() {} } }))
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  let first
  for (const path of ['/api/v1/search/raw', RAW_SEARCH_PATH]) {
    const response = await fetch(base + path, { method: 'POST', headers: {
      Authorization: `Bearer ${h.key.secret}`, 'content-type': 'application/json', 'idempotency-key': 'raw-fixture-alias' }, body: JSON.stringify(BODY) })
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    if (first) assert.deepEqual(body, first)
    else first = body
  }
  assert.equal(h.calls.length, 2)
})

test('Weibo dates and long-text selection preserve source meaning', () => {
  const capturedAt = '2026-10-08T06:32:00.000Z'
  assert.equal(weiboRow(preview, capturedAt).created_at, '2026-10-08T06:31:46.000Z')
  assert.equal(weiboRow({ ...preview, publish_time: '今天 14:00' }, capturedAt).created_at, '2026-10-08T06:00:00.000Z')
  assert.equal(weiboRow({ ...preview, longText: { content: FULL } }, capturedAt).full_text, FULL)
  assert.equal(RAW_SEARCH_VERSION, 'mx-insight-hub.raw-search.v1')
})

test('data/search Weibo directly fills full text, retains its strict v1 envelope and original dataset/meter', async () => {
  const h = await harness()
  const body = { platform: 'weibo', query: '尊界V800 支架断裂', pageSize: 20 }
  const result = await h.invokeData(body, 'compass-title-check-798480b6-20261008')
  assert.ok(isNightAllDataSearchV1Envelope(result.body))
  const item = result.body.data.items[0]
  assert.equal(item.title, null)
  assert.equal(item.text, FULL)
  assert.equal(item.author.id, AUTHOR)
  assert.equal(item.metrics.likes, 7)
  assert.deepEqual(item.media.images, preview.media.images)
  assert.deepEqual(item.source, { provider: null, endpointId: null })
  assert.equal(result.body.data.query, body.query)
  assert.equal(h.calls[0].searchParams.get('query'), body.query)
  assert.equal(h.calls[1].searchParams.get('is_get_long_text'), 'true')
  assert.equal(h.historical.length, 0)
  assert.equal(h.calls.length, 2)
  const usage = [...h.store.requests.values()][0]
  assert.equal(usage.billingMeterKey, 'weibo')
  assert.equal(usage.unitsActual, 1)
  const job = h.platformStore.ingestJobs[0].payload
  assert.equal(job.datasetId, 'night-all.search.v1')
  assert.equal(job.records[0].title, null)
  assert.equal(job.records[0].body, FULL)
  assert.equal(job.records[0].extensions.rawSearch.bodyCompleteness, 'full_text')
  assert.equal(h.platformStore.restrictedResponseArchives.size, 2)
  assert.deepEqual((await h.invokeData(body, 'compass-title-check-798480b6-20261008')).body, result.body)
  assert.equal(h.calls.length, 2)
})

test('data/search failed Weibo detail stays partial with strict warnings and no forged full text', async () => {
  const h = await harness({ detail: 'rejected' })
  const result = await h.invokeData()
  assert.ok(isNightAllDataSearchV1Envelope(result.body))
  assert.equal(result.body.data.items[0].title, null)
  assert.equal(result.body.data.items[0].text, PREVIEW)
  assert.equal(result.body.data.status, 'partial')
  assert.equal(result.body.data.meta.providerCalls, 2)
  assert.equal(result.body.data.warnings[0].code, 'WEIBO_FULL_TEXT_INCOMPLETE')
  assert.deepEqual((await h.invokeData()).body, result.body)
  assert.equal(h.calls.length, 2)
})

test('Instagram data and raw search are direct, keep caption/media/identity, and exclude keyword suggestions', async () => {
  const h = await harness({ platform: 'instagram' })
  const result = await h.invokeData({ platform: 'ins', query: '汽车', pageSize: 20 })
  assert.ok(isNightAllDataSearchV1Envelope(result.body))
  assert.equal(result.body.data.items.length, 1)
  const item = result.body.data.items[0]
  assert.equal(item.externalId, instagramPost.pk)
  assert.equal(item.platform, 'instagram')
  assert.equal(item.title, null)
  assert.equal(item.text, instagramPost.caption.text)
  assert.equal(item.author.id, instagramPost.user.pk)
  assert.equal(item.metrics.likes, 12)
  assert.deepEqual(item.media.images, ['https://example.test/large.jpg'])
  assert.deepEqual(item.media.videos, ['https://example.test/movie.mp4'])
  assert.equal(h.calls[0].pathname, '/api/v1/instagram/v3/general_search')
  assert.equal(h.platformStore.ingestJobs[0].payload.datasetId, 'night-all.search.v1')
  const raw = await h.invoke()
  assert.equal(JSON.parse(raw.body.data.raw_data)[0].title, '')
  assert.equal(JSON.parse(raw.body.data.raw_data)[0].full_text, instagramPost.caption.text)
  assert.equal(h.platformStore.ingestJobs[1].payload.datasetId, 'night-all.compat.v1')
  assert.equal(h.historical.length, 0)
  assert.equal(h.calls.length, 2)
})

test('data-search cursor preserves compound Instagram params and binds Key, page size, query, type and endpoint', async () => {
  for (const platform of ['weibo', 'instagram']) {
    const h = await harness({ platform, hasMore: true, rows: [{ ...preview, content: FULL }] })
    const body = { platform, query: '汽车', pageSize: 20, type: 'stable' }
    const first = await h.invokeData(body)
    const cursor = first.body.data.pageInfo.nextCursor
    assert.ok(cursor.startsWith('mxds1.'))
    const second = await h.invokeData({ ...body, cursor }, 'data-fixture-page-two')
    assert.ok(isNightAllDataSearchV1Envelope(second.body))
    assert.equal(second.body.data.pageInfo.pageIndex, 2)
    if (platform === 'instagram') {
      assert.equal(h.calls[1].searchParams.get('next_max_id'), 'next-instagram-page')
      assert.equal(h.calls[1].searchParams.get('rank_token'), 'search-rank-token')
      assert.equal(second.body.data.pageInfo.nextCursor, null) // Repeated upstream token is terminal.
    } else assert.equal(h.calls[1].searchParams.get('page'), '2')
    for (const patch of [{ query: 'different' }, { pageSize: 30 }, { type: 'fresh' }]) {
      await assert.rejects(h.invokeData({ ...body, ...patch, cursor }, `data-invalid-${Object.keys(patch)[0]}`), { code: 'invalid_cursor' })
    }
    const codec = createDataSearchCursorCodec(PEPPER, `${h.context.consumer.id}:${h.context.apiKey.id}`)
    const state = codec.decode(cursor)
    const otherCodec = createDataSearchCursorCodec(PEPPER, `${h.context.consumer.id}:other-key`)
    await assert.rejects(h.invokeData({ ...body, cursor: otherCodec.encode(state) }, 'data-invalid-key'), { code: 'invalid_cursor' })
    await assert.rejects(h.invoke({ ...BODY, platform, cursor }, 'raw-cannot-use-data-cursor'), { code: 'invalid_cursor' })
    const last = await h.invokeData({ ...body, cursor: codec.encode({ ...state, page: 15 }) }, 'data-page-fifteen')
    assert.equal(last.body.data.pageInfo.nextCursor, null)
    await assert.rejects(h.invokeData({ ...body, cursor: codec.encode({ ...state, page: 16 }) }, 'data-page-sixteen'), { code: 'invalid_cursor' })
  }
})

test('existing data-search requests replay original responses across cutover; fresh expiry and stable semantics survive', async () => {
  for (const type of ['fresh', 'stable']) {
    const h = await harness({ enabled: false })
    const body = { platform: 'weibo', query: '汽车', pageSize: 20, type }
    const requestId = randomUUID()
    await h.store.reserve({ requestId, idempotencyKey: 'data-fixture-first',
      fingerprint: requestFingerprint({ method: 'POST', path: '/api/v1/data/search', body }),
      tenantId: h.context.tenant.id, consumerId: h.context.consumer.id, apiKeyId: h.context.apiKey.id,
      platform: 'weibo', unitsReserved: 1, leaseExpiresAt: new Date(Date.now() + 120000),
      windowStart: new Date(Date.now() - 3600000), maxRequests: 100, replayWindowMs: type === 'fresh' ? 120000 : null })
    const old = { ...h.oldDataPayload, requestId }
    await h.store.commitRequest(requestId, { responseStatus: 200, responseBody: old, unitsActual: 1 })
    const saved = h.store.requests.get(requestId)
    saved.completedAt = new Date(Date.now() - 119000).toISOString()
    assert.deepEqual((await h.invokeData(body)).body, old)
    assert.equal(h.calls.length, 0)
    saved.completedAt = new Date(Date.now() - 121000).toISOString()
    if (type === 'stable') assert.deepEqual((await h.invokeData(body)).body, old)
    else await assert.rejects(h.invokeData(body), /operation/i) // Expired fresh replay encounters paused operation, never hidden fallback.
    assert.equal(h.calls.length, 0)
    assert.equal(h.historical.length, 0)
  }
})

test('historical small pages and old continuations clean titles in Hub while preserving source payloads and profile names', async () => {
  for (const platform of ['weibo', 'instagram', 'facebook', 'twitter']) {
    const h = await harness({ platform })
    const before = structuredClone(h.oldDataPayload)
    const result = await h.invokeData({ platform, query: '汽车', pageSize: 10 })
    assert.equal(result.body.data.items[0].title, null)
    assert.equal(result.body.data.items[0].text, PREVIEW)
    assert.deepEqual(h.oldDataPayload, before)
    assert.equal(h.historical.length, 1)
    assert.equal(h.calls.length, 0)
  }
  const h = await harness({ platform: 'instagram' })
  const body = { platform: 'instagram', query: '汽车', pageSize: 20 }
  const codec = createNightAllCompatibilityCursorCodec(PEPPER, h.context.consumer.id)
  const traversal = prepareNightAllCompatibilityTraversal({ operation: 'data-search', platform: 'instagram', upstreamBody: body, codec })
  const old = structuredClone(h.oldDataPayload)
  Object.assign(old.data.pageInfo, { hasMore: true, nextCursor: 'old-night-all-token', cursorType: 'opaque' })
  const wrapped = capNightAllDataSearchTraversal(old, { platform: 'instagram', page: 1, scope: traversal.scope, codec })
  await h.invokeData({ ...body, cursor: wrapped.data.pageInfo.nextCursor })
  assert.equal(h.historical[0].body.cursor, 'old-night-all-token')
  assert.equal(h.calls.length, 0)
  h.oldDataPayload.data.items[0].contentType = 'user_profile'
  h.oldDataPayload.data.items[0].title = 'account name'
  assert.equal((await h.invokeData({ ...body, pageSize: 10 }, 'data-profile-preserved')).body.data.items[0].title, 'account name')
})

test('Instagram empty keyword suggestions remain empty; malformed, oversize and incomplete continuation shapes fail without fallback or retry', async () => {
  const empty = await harness({ platform: 'instagram', instagramData: { status: 'ok',
    other_results: { keyword_recommendations: { keywords: [{ id: '123', name: 'popular term' }] } } } })
  assert.deepEqual((await empty.invokeData()).body.data.items, [])
  for (const data of [{ unexpected: true },
    { items: Array.from({ length: 21 }, (_, i) => ({ ...instagramPost, pk: String(i + 1) })) },
    { items: [instagramPost], has_more: true },
    { items: [instagramPost], next_max_id: 'valid', rank_token: { unexpected: 'shape' } },
  ]) {
    const h = await harness({ platform: 'instagram', instagramData: data })
    await assert.rejects(h.invokeData())
    await assert.rejects(h.invokeData())
    assert.equal(h.calls.length, 1)
    assert.equal(h.historical.length, 0)
    assert.equal(h.platformStore.restrictedResponseArchives.size, 1)
    assert.equal([...h.platformStore.calls.values()][0].outcome, 'succeeded_unusable')
  }
})

test('Weibo/Instagram canonical and legacy normalization clear generated titles without modifying raw evidence or account/article names', () => {
  for (const platform of ['weibo', 'instagram']) {
    const payload = oldDataSearch(platform)
    const before = structuredClone(payload)
    const record = normalizeSearchPayload(payload, platform).records[0]
    assert.equal(record.title, null)
    assert.equal(record.body, PREVIEW)
    assert.equal(record.rawItem.title, PREVIEW)
    const { collectedAt, metrics, ...oldContent } = payload.data.items[0]
    assert.notEqual(record.payloadSha256, sha256(canonicalJson(oldContent)))
    assert.deepEqual(payload, before)
    const raw = legacy()
    const records = normalizeNightAllLegacyPayload(raw, platform, 'raw').records
    assert.equal(records.find(row => row.objectType === 'post').title, null)
    assert.equal(records.find(row => row.objectType === 'post').rawItem.title, '旧合成标题')
    assert.equal(records.find(row => row.objectType === 'profile').title, '账号名')
    for (const contentType of ['user_profile', 'location', 'article']) {
      payload.data.items[0].contentType = contentType
      assert.equal(normalizeSearchPayload(payload, platform).records[0].title, PREVIEW)
    }
  }
  assert.equal(normalizeSearchPayload(oldDataSearch('xiaohongshu'), 'xiaohongshu').records[0].title, PREVIEW)
})

test('data/search preserves the platform price, item usage and immutable Key limits without granting native capabilities', async () => {
  const h = await harness({ rows: [{ ...preview, content: FULL }, { ...preview, weibo_id: '5351726865449967', content: FULL }] })
  const plan = await h.service.publishPlanVersion({ key: 'data-search-paid', name: 'Offline platform price',
    limits: { monthlyRequests: 10000, maxPageSize: 100, burstRps: 100 },
    priceBook: { key: 'data-search-paid', currency: 'CNY', defaultMultiplierPpm: 1000000,
      entries: [{ meterKey: 'weibo', billingUnit: 'request', unitPriceMinor: 9 }] } }, 'test-admin')
  const current = await h.service.getConsumerPlan(h.context.consumer.id)
  await h.service.assignConsumerPlan(h.context.consumer.id, { planVersionId: plan.versionId, expectedRevision: current.revision }, 'test-admin')
  await h.service.setTenantBillingProfile(h.context.tenant.id, { mode: 'enforced', multiplierPpm: 1000000 }, 'test-admin')
  await h.service.addTenantCredit(h.context.tenant.id, { amountMinor: 100, currency: 'CNY', reason: 'Offline fixture' },
    { idempotencyKey: 'data-search-credit', actor: 'test-admin' })
  await h.invokeData()
  await h.invokeData()
  assert.equal([...h.store.requests.values()][0].unitsActual, 2)
  assert.equal(h.calls.length, 1)
  const charges = [...h.store.customerCharges.values()]
  assert.equal(charges.length, 1)
  assert.equal(charges[0].meterKey, 'weibo')
  assert.equal(charges[0].chargedMinor, 9)
  const key = h.store.apiKeyPlatformEntitlements.get(h.context.apiKey.id)[0]
  key.maxPageSize = 10
  await assert.rejects(h.invokeData(undefined, 'data-limit-exceeded'), { code: 'page_size_exceeded' })
  assert.equal(h.calls.length, 1)
  await h.store.setPlatformGrant(h.context.consumer.id, 'weibo', false)
  await assert.rejects(h.invokeData(), { code: 'platform_not_granted' })
  assert.equal(h.calls.length, 1)
})

test('the user data/search curl shape works through the public HTTP route without a Night-All hop', async t => {
  const h = await harness()
  const server = createServer(createApp({ service: h.service, store: h.store, adapter: {},
    adminToken: null, listenerMode: 'public', logger: { warn() {}, error() {} } }))
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/data/search`, { method: 'POST', headers: {
    Authorization: `Bearer ${h.key.secret}`, 'Content-Type': 'application/json', Accept: 'application/json',
    'Idempotency-Key': 'compass-title-check-798480b6-20261008' },
    body: JSON.stringify({ platform: 'weibo', query: '尊界V800 支架断裂', pageSize: 20 }) })
  const body = await response.json()
  assert.equal(response.status, 200, JSON.stringify(body))
  assert.ok(isNightAllDataSearchV1Envelope(body))
  assert.equal(body.data.items[0].title, null)
  assert.equal(body.data.items[0].text, FULL)
  assert.equal(h.calls.length, 2)
  assert.equal(h.historical.length, 0)
})
