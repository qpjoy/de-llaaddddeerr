import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { twitterDeliveryLeases } from '../../server/external-platforms/twitter-delivery-leases.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { StrategySearchRoutingStore } from '../../server/external-platforms/strategy-search-routing.mjs'
import { TikHubAdapter } from '../../server/adapters/tikhub.mjs'
import { JustOneAdapter } from '../../server/adapters/justone.mjs'
import { classifyExternalPlatformIngest } from '../../server/workers/ingest.mjs'
import { JUSTONE_INSTAGRAM_SEARCH_KEY } from '../../server/contracts/instagram-justone-search.mjs'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'
import { nativeForwardingEndpoint } from '../../server/contracts/native-forwarding.mjs'
import { createApp } from '../../server/app.mjs'
import { requestFingerprint } from '../../server/core/crypto.mjs'
import { AppError } from '../../server/core/errors.mjs'
import { createInternalTrafficPolicy } from '../../server/core/internal-traffic-policy.mjs'
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
const TWITTER_LONG_TEXT = `完整长文 🚗\n${'保留正文而非截断预览。'.repeat(80)}#汽车`
const twitterPost = { rest_id: '1843144227000000001', core: { user_results: { result: {
  rest_id: '1843144227000000002', legacy: { screen_name: 'fixture_author', name: '作者显示名',
    profile_image_url_https: 'https://example.test/twitter-avatar.jpg' },
} } }, note_tweet: { note_tweet_results: { result: { text: TWITTER_LONG_TEXT } } }, views: { count: '0' },
legacy: { full_text: '截断预览…', created_at: 'Thu Oct 08 01:00:00 +0000 2026',
  favorite_count: 0, reply_count: 7, retweet_count: 0, quote_count: 3, bookmark_count: 9,
  extended_entities: { media: [{ type: 'photo', media_url_https: 'https://example.test/twitter-photo.jpg' },
    { type: 'video', media_url_https: 'https://example.test/twitter-video-cover.jpg', video_info: { variants: [
      { content_type: 'application/x-mpegURL', url: 'https://example.test/movie.m3u8' },
      { content_type: 'video/mp4', bitrate: 256000, url: 'https://example.test/twitter-small.mp4' },
      { content_type: 'video/mp4', bitrate: 2176000, url: 'https://example.test/twitter-large.mp4' },
    ] } }] } } }
const twitterZeroPost = { rest_id: '1843144227000000003', views: { count: '0' },
  legacy: { full_text: '普通正文', created_at: '2026-10-08T02:00:00Z',
    favorite_count: 0, reply_count: 0, retweet_count: 0, bookmark_count: 0 } }
function twitterTimeline(tweets = [twitterPost], next = null) {
  return { data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [{ entries: [
    ...tweets.map(tweet => ({ entryId: `tweet-${tweet.rest_id}`, content: { itemContent: { tweet_results: { result: tweet } } } })),
    ...(next ? [{ entryId: 'cursor-bottom', content: { cursorType: 'Bottom', value: next } }] : []),
  ] }] } } } } }
}
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
  hasMore = false, malformed = false, searchFails = false, rows = [preview], instagramData, twitterData, weiboData, weiboDetailData,
  instagramProvider = 'tikhub', justOneCode = 0 } = {}) {
  const store = new MemoryStore(), calls = [], historical = [], logs = []
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
  const providerKey = platform === 'instagram' ? instagramProvider : platform === 'weibo' ? 'tikhub' : 'rapidapi'
  const config = { configured: true, contractVerified: true, dispatchEnabled: true, timeoutMs: 100,
    freshTtlMs: 60000, staleTtlMs: 86400000, maxConcurrency: 3, maxConsumerConcurrency: 3, maxRequestsPerMinute: 100, billing: {} }
  const controls = new MemoryExternalPlatformControlStore()
  const operations = platform === 'weibo' ? [WEIBO_SEARCH_KEY, WEIBO_DETAIL_KEY].map(nativeForwardingEndpoint)
    : platform === 'instagram' ? [nativeForwardingEndpoint(providerKey === 'justone' ? JUSTONE_INSTAGRAM_SEARCH_KEY : INSTAGRAM_SEARCH_KEY)] : [{ operation: 'social.content.search', endpointKey: 'twitter-aio.search' }]
  for (const [i, endpoint] of operations.entries()) {
    if (!enabled || (i === 1 && !detailEnabled)) continue
    await controls.updatePolicy(providerKey, endpoint.operation, { expectedRevision: 1, desiredState: 'active', reason: 'Offline regression fixture',
      priceBook: { currency: 'USD', pricingAsOf: '2026-10-08T00:00:00Z', monthlyBudgetMinor: 100000,
        monthlySubsidyBudgetMinor: 100000, unitCostMinorByEndpoint: { [endpoint.endpointKey]: 12 } } },
    { runtime: { config, credentialConfigured: true } })
  }
  const Adapter = providerKey === 'justone' ? JustOneAdapter : providerKey === 'tikhub' ? TikHubAdapter : RapidApiAdapter
  const adapter = new Adapter({ apiKey: 'fixture-secret', token: 'fixture-secret', timeoutMs: 100, fetchImpl: async url => {
    calls.push(new URL(url))
    if (calls.at(-1).pathname.endsWith('fetch_post_detail')) {
      if (detail === 'unknown') throw new Error('connection lost after dispatch')
      if (detail === 'rejected') return Response.json({ code: 400 }, { status: 400 })
      return Response.json({ code: 200, request_id: 'detail-receipt', data: weiboDetailData || {
        idstr: detail === 'wrong-id' ? '999999' : POST_ID,
        user: { idstr: AUTHOR, screen_name: '作者' }, isLongText: true,
        text: PREVIEW, text_raw: FULL, longText: { content: FULL } } })
    }
    if (searchFails) throw new Error('search transport outcome unknown')
    if (platform === 'instagram' && providerKey === 'justone') return Response.json({ code: justOneCode, requestId: 'justone-instagram-receipt', message: null, recordTime: null,
      data: (typeof instagramData === 'function' ? instagramData(calls.at(-1)) : instagramData) || {
        data: { count: 1, items: [instagramPost] }, pagination_token: hasMore ? 'justone-next-page' : '',
      } })
    if (platform === 'instagram') return Response.json({ code: 200, request_id: 'instagram-receipt', data: (typeof instagramData === 'function' ? instagramData(calls.at(-1)) : instagramData) || {
      status: 'ok', rank_token: 'search-rank-token', media_grid: { sections: [{ layout_content: { medias: [{ media: instagramPost }] } }],
        more_available: hasMore, ...(hasMore ? { next_max_id: 'next-instagram-page' } : {}) },
      other_results: { keyword_recommendations: { keywords: [{ id: '999', name: 'not a post' }] } },
    } })
    if (platform === 'twitter') return Response.json((typeof twitterData === 'function' ? twitterData(calls.at(-1)) : twitterData) || { data: { search_by_raw_query: { search_timeline: { timeline: {
      instructions: [{ entries: [{ entryId: 'tweet-one', content: { itemContent: { tweet_results: { result: {
        rest_id: POST_ID, legacy: { full_text: FULL, created_at: '2026-10-08T01:00:00Z', favorite_count: 0 },
      } } } } }, ...(hasMore ? [{ entryId: 'cursor-bottom', content: { cursorType: 'Bottom', value: 'opaque-next' } }] : [])] }],
    } } } } })
    return Response.json({ code: 200, request_id: 'search-receipt', data: malformed ? { unexpected: [] }
      : (typeof weiboData === 'function' ? weiboData(Number(calls.at(-1).searchParams.get('page'))) : weiboData)
        ?? { parsed_data: { results: rows, result_count: rows.length, pagination: { has_next_page: hasMore } } } })
  } })
  const platformStore = new MemoryExternalPlatformStore({ usageStore: store, providerKey, authorizationPlatform: platform })
  const gateway = new ExternalPlatformGateway({ usageStore: store, platformStore, adapter, config, providerKey,
    apiKeyPepper: PEPPER, reservationLeaseMs: 120000, operationControlStore: controls, logger: { warn(...args) { logs.push(args) } } })
  service.externalRawSearch = (context, input) => gateway.searchRaw(context, input)
  service.externalDataSearch = (context, input) => input.normalized.platform === 'weibo'
    && (input.normalized.pageSize < 20 || input.normalized.cursor?.startsWith('mxnc1.'))
    ? gateway.searchContent(context, input) : gateway.searchRaw(context, input)
  const invoke = (body = { ...BODY, platform }, idempotencyKey = 'raw-fixture-first') => service.nightAllCompatibilitySearch(context,
    { operation: 'raw', body, idempotencyKey, path: RAW_SEARCH_PATH })
  const invokeData = (body = { platform, query: '汽车', pageSize: 20 }, idempotencyKey = 'data-fixture-first') => service.search(context,
    { body, idempotencyKey, path: '/api/v1/data/search' })
  return { store, service, gateway, platformStore, controls, config, context, key, calls, historical, logs, oldPayload, oldDataPayload, invoke, invokeData }
}

test('Weibo native protocol-relative URL and flat metrics reach new deliveries without changing immutable saved replay', async () => {
  const native = { weibo_id: POST_ID, user_name: 'fixture author', user_url: `//weibo.com/${AUTHOR}`,
    post_url: `//weibo.com/${AUTHOR}/Abc?refer_flag=1001030103_`, content: FULL,
    longText: { content: FULL }, like_count: '12', comment_count: '3', share_count: '2',
    view_count: '0', collect_count: 0, media: { images: ['https://example.test/image.jpg?sig=a%2Fb'] } }
  for (const route of ['invoke', 'invokeData']) {
    const h = await harness({ rows: [native] })
    const first = await h[route]()
    const item = route === 'invoke' ? JSON.parse(first.body.data.raw_data)[0] : first.body.data.items[0]
    assert.equal(item.url, `https://weibo.com/${AUTHOR}/Abc?refer_flag=1001030103_`)
    assert.deepEqual(route === 'invoke' ? [item.like_count, item.comment_count, item.forward_count, item.view_count, item.bookmark_count]
      : Object.values(item.metrics), [12, 3, 2, 0, 0])
    assert.equal(h.calls.length, 1)
    const [call] = h.platformStore.calls.values()
    const originalArchive = structuredClone(h.platformStore.restrictedResponseArchives.get(call.id))
    native.like_count = '99'
    const replay = await h[route]()
    assert.equal(replay.replay, true)
    assert.deepEqual(replay.body, first.body)
    assert.equal(h.calls.length, 1)
    assert.deepEqual(structuredClone(h.platformStore.restrictedResponseArchives.get(call.id)), originalArchive)
    native.like_count = '12'
  }
})

test('allowlisted Weibo callers keep the same local RPM exemption for search and full text on both routes', async () => {
  for (const route of ['invoke', 'invokeData']) {
    const h = await harness()
    h.store.internalTrafficPolicy = createInternalTrafficPolicy({ keyIds: [h.key.id] })
    let rateChecks = 0
    h.platformStore.acquireProviderRateLimit = async () => { rateChecks++; return { allowed: false, retryAfterMs: 1200 } }
    const first = await h[route]()
    assert.equal(first.body.data.status, 'ok')
    assert.equal(h.calls.length, 2)
    assert.equal(rateChecks, 0)
    assert.equal(h.platformStore.ingestJobs[0].payload.records[0].body, FULL)
    assert.ok([...h.platformStore.calls.values()].every(call => call.billed === true))
    assert.ok([...h.platformStore.costReservations.values()].every(hold => hold.status !== 'active'))
    assert.deepEqual((await h[route]()).body, first.body)
    assert.equal(h.calls.length, 2)
  }
})

test('Weibo full-text admission applies internal rate-circuit grace without clearing shared state', async () => {
  for (const [internal, errorCode, age, expectedCalls] of [
    [true, 'upstream_rate_limited', 11000, 2],
    [true, 'upstream_rate_limited', 1000, 1],
    [true, 'upstream_authentication_failed', 11000, 1],
    [false, 'upstream_rate_limited', 11000, 1],
  ]) {
    const h = await harness()
    if (internal) h.store.internalTrafficPolicy = createInternalTrafficPolicy({ keyIds: [h.key.id] })
    // Leave less time than the still-active cooldown needs; waiting is tested
    // separately with a virtual clock rather than real 9/49-second sleeps.
    if (expectedCalls === 1) h.config.timeoutMs = 110000
    const failedAt = Date.now() - age
    const state = Object.freeze({ lastErrorCode: errorCode, lastFailureAt: new Date(failedAt).toISOString(),
      circuitOpenUntil: new Date(failedAt + 60000).toISOString() })
    // Another request opens a shared circuit while this search is in flight.
    h.platformStore.providerState = async () => h.calls.length ? state : null
    const first = await h.invokeData()
    assert.equal(h.calls.length, expectedCalls)
    assert.equal(first.body.data.status, expectedCalls === 2 ? 'ok' : 'partial')
    if (expectedCalls === 1) assert.deepEqual(JSON.parse(h.logs[0][0]).skipped,
      [{ postId: POST_ID, reason: 'provider_circuit_open' }])
    assert.equal(Date.parse(state.circuitOpenUntil), failedAt + 60000)
  }
})

test('ordinary Weibo search waits for local admission then commits full text and immutable replay on both routes', async () => {
  for (const route of ['invoke', 'invokeData']) {
    const h = await harness()
    let checks = 0
    h.platformStore.acquireProviderRateLimit = async () => ({ allowed: ++checks !== 2, retryAfterMs: 1 })
    const first = await h[route]()
    assert.equal(first.body.data.status, 'ok')
    assert.equal(checks, 3)
    assert.equal(h.calls.length, 2)
    assert.equal(h.platformStore.ingestJobs[0].payload.records[0].body, FULL)
    assert.equal(h.platformStore.restrictedResponseArchives.size, 2)
    assert.ok([...h.platformStore.costReservations.values()].every(hold => hold.status !== 'active'))
    assert.deepEqual((await h[route]()).body, first.body)
    assert.equal(checks, 3)
    assert.equal(h.calls.length, 2)
  }
})

test('ordinary Weibo callers still obey the shared RPM and record the undispatched detail reason when waiting cannot fit', async () => {
  const h = await harness()
  // A sibling allowlist and a user-supplied flag cannot confer the exemption.
  h.store.internalTrafficPolicy = createInternalTrafficPolicy({ keyIds: [randomUUID()] })
  let checks = 0
  h.platformStore.acquireProviderRateLimit = async () => ({ allowed: ++checks === 1, retryAfterMs: 120000 })
  await assert.rejects(h.invoke({ ...BODY, internal: true }), { code: 'unsupported_fields' })
  assert.equal(checks, 0)
  const first = await h.invoke()
  assert.equal(first.body.data.status, 'partial')
  assert.equal(h.calls.length, 1)
  assert.equal(checks, 2)
  const event = JSON.parse(h.logs[0][0])
  assert.deepEqual(event, { event: 'weibo_full_text_incomplete', requestId: first.body.requestId,
    detailUpstreamCalls: 0, incompleteItems: 1, admissionWaitMs: 0,
    skipped: [{ postId: POST_ID, reason: 'provider_rate_limited' }] })
  assert.equal(h.platformStore.calls.size, 1)
  assert.ok([...h.platformStore.costReservations.values()].every(hold => hold.status !== 'active'))
  assert.deepEqual((await h.invoke()).body, first.body)
  assert.equal(checks, 2)
  assert.equal(h.logs.length, 1)
})

test('internal Weibo full text still respects deadline, operation, cost and dispatch-lease gates', async () => {
  for (const gate of ['deadline', 'operation_unavailable', 'cost_unavailable', 'dispatch_lease_unavailable']) {
    const h = await harness({ detailEnabled: gate !== 'operation_unavailable' })
    h.store.internalTrafficPolicy = createInternalTrafficPolicy({ keyIds: [h.key.id] })
    if (gate === 'deadline') h.config.timeoutMs = 120000
    if (gate === 'cost_unavailable') {
      const reserve = h.platformStore.reserveProviderCostWorkflow.bind(h.platformStore)
      h.platformStore.reserveProviderCostWorkflow = input => h.calls.length
        ? Promise.reject(new AppError(503, 'external_platform_cost_budget_exhausted', 'private-cost-message')) : reserve(input)
    }
    if (gate === 'dispatch_lease_unavailable') {
      const acquire = h.platformStore.acquireDispatchLease.bind(h.platformStore)
      h.platformStore.acquireDispatchLease = input => input.operation === `native.${WEIBO_DETAIL_KEY}`
        ? { kind: 'blocked', reason: 'unknown' } : acquire(input)
    }
    const first = await h.invokeData()
    assert.equal(first.body.data.status, 'partial', gate)
    assert.equal(h.calls.length, 1, gate)
    const event = JSON.parse(h.logs[0][0])
    assert.deepEqual(event.skipped, [{ postId: POST_ID, reason: gate }])
    assert.doesNotMatch(JSON.stringify(event), /private-cost-message|fixture-secret|汽车|展开/)
    assert.ok(isNightAllDataSearchV1Envelope(first.body))
    assert.ok([...h.platformStore.costReservations.values()].every(hold => hold.status !== 'active'))
  }
})

test('raw search fills a Weibo preview through governed detail, archives both receipts and keeps one raw charge', async () => {
  const h = await harness()
  const first = await h.invoke()
  const row = JSON.parse(first.body.data.raw_data)[0]
  assert.equal(row.full_text, FULL)
  assert.equal(row.summary, PREVIEW)
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
    assert.equal(JSON.parse(result.body.data.raw_data)[0].full_text, null)
    assert.equal(JSON.parse(result.body.data.raw_data)[0].summary, PREVIEW)
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

// Anonymized shape of the authorized 2026-10-08 response: 8 results,
// parse_success=true, pagination={} and search_stats={}; no post content retained.
function weiboEmptyPagination(results) {
  return { parsed_data: { results, result_count: results.length, pagination: {}, search_stats: {}, parse_success: true } }
}

test('Weibo empty pagination preserves short pages and bounded continuation on both Hub contracts', async () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ ...preview, weibo_id: `53517268654499${66 + i}`, content: FULL }))
  const source = weiboEmptyPagination(rows)
  for (const route of ['raw', 'data']) {
    const h = await harness({ weiboData: page => page === 2 ? weiboEmptyPagination([]) : source })
    const invoke = route === 'raw' ? h.invoke : h.invokeData
    const body = route === 'raw' ? BODY : { platform: 'weibo', query: '汽车', pageSize: 20 }
    const first = await invoke(body)
    if (route === 'data') assert.ok(isNightAllDataSearchV1Envelope(first.body))
    const page = route === 'raw' ? first.body.data.page : first.body.data.pageInfo
    const items = route === 'raw' ? JSON.parse(first.body.data.raw_data) : first.body.data.items
    assert.equal(items.length, 8)
    assert.ok(items.every(item => item.title === (route === 'raw' ? '' : null)))
    assert.equal(page.returnedCount, 8)
    assert.equal(page.hasMore, true)
    assert.ok(page.nextCursor.startsWith(route === 'raw' ? 'mxraw1.' : 'mxds1.'))
    assert.equal(h.calls.length, 1) // A next cursor never acquires another page itself.
    assert.equal(h.platformStore.ingestJobs[0].payload.records.length, 8)
    const receipt = [...h.platformStore.restrictedResponseArchives.values()][0]
    assert.deepEqual(receipt.parsedPayload.data, source)
    assert.equal([...h.platformStore.calls.values()][0].outcome, 'succeeded')
    assert.deepEqual((await invoke(body)).body, first.body)
    assert.equal(h.calls.length, 1)
    const second = await invoke({ ...body, cursor: page.nextCursor }, `${route}-empty-page-two`)
    const secondPage = route === 'raw' ? second.body.data.page : second.body.data.pageInfo
    assert.equal(secondPage.returnedCount, 0)
    assert.equal(secondPage.hasMore, false)
    assert.equal(secondPage.nextCursor, null)
    assert.equal(h.calls[1].searchParams.get('page'), '2')
    assert.equal(h.calls.length, 2)
    const codec = (route === 'raw' ? createRawSearchCursorCodec : createDataSearchCursorCodec)(PEPPER,
      `${h.context.consumer.id}:${h.context.apiKey.id}`)
    const lastCursor = codec.encode({ ...codec.decode(page.nextCursor), page: 15 })
    const last = await invoke({ ...body, cursor: lastCursor }, `${route}-empty-pagination-last`)
    const lastPage = route === 'raw' ? last.body.data.page : last.body.data.pageInfo
    assert.equal(lastPage.returnedCount, 8)
    assert.equal(lastPage.hasMore, false)
    assert.equal(lastPage.nextCursor, null)
    assert.equal(h.historical.length, 0)
  }
})

test('Weibo empty pagination still runs the governed long-text enrichment', async () => {
  const h = await harness({ weiboData: weiboEmptyPagination([preview]) })
  const result = await h.invokeData()
  assert.equal(result.body.data.items[0].text, FULL)
  assert.equal(result.body.data.items[0].title, null)
  assert.equal(result.body.data.pageInfo.hasMore, true)
  assert.equal(h.calls.length, 2)
  assert.equal(h.calls[1].searchParams.get('is_get_long_text'), 'true')
})

test('both search contracts deliver independently verified edited full text as ok and preserve evidence and replay', async () => {
  const short = 'whzy超话这是正文开头，后续正文包含表情 展开c'
  const full = '#whzy[超话]#作者编辑后的短文[新表情]。'
  const detail = { idstr: POST_ID, user: { idstr: AUTHOR }, isLongText: true,
    text: 'whzy超话这是正文开头，后续正文包含表情。', text_raw: full, longText: { content: full } }
  for (const route of ['raw', 'data']) {
    const h = await harness({ rows: [{ ...preview, content: short }], weiboDetailData: detail })
    const invoke = route === 'raw' ? h.invoke : h.invokeData
    const result = await invoke()
    assert.equal(result.body.data.status, 'ok')
    assert.deepEqual(result.body.data.warnings || [], [])
    const item = route === 'raw' ? JSON.parse(result.body.data.raw_data)[0] : result.body.data.items[0]
    assert.equal(item.text, full)
    assert.equal(item.title, route === 'raw' ? '' : null)
    assert.equal(h.calls.length, 2)
    assert.equal(h.historical.length, 0)
    assert.equal(h.platformStore.ingestJobs[0].payload.records[0].body, full)
    assert.equal(h.platformStore.ingestJobs[0].payload.records[0].extensions.weiboBody.summary, short)
    assert.equal(h.platformStore.ingestJobs[0].payload.records[0].extensions.weiboBody.fullText, full)
    assert.equal(h.platformStore.ingestJobs[0].payload.records[0].extensions.rawSearch.bodyCompleteness, 'full_text')
    const archives = [...h.platformStore.restrictedResponseArchives.values()]
    assert.equal(archives[0].parsedPayload.data.parsed_data.results[0].content, short)
    assert.deepEqual(archives[1].parsedPayload.data, detail)
    assert.deepEqual((await invoke()).body, result.body)
    assert.equal(h.calls.length, 2)
  }
})

test('Weibo contract failures preserve a bounded cause and still suppress a second paid dispatch', async () => {
  for (const [options, code] of [
    [{ malformed: true }, 'invalid_weibo_search_shape'],
    ...[undefined, null, [], { has_next_page: 'false' }, { unexpected: true }].map(pagination =>
      [{ weiboData: { parsed_data: { results: [preview], pagination } } }, 'invalid_weibo_search_shape']),
    [{ weiboData: { parsed_data: { ...weiboEmptyPagination([preview]).parsed_data, parse_success: false } } },
      'invalid_weibo_search_shape'],
    [{ rows: [{ ...preview, weibo_id: 'invalid-private-value' }] }, 'invalid_weibo_identity'],
    [{ rows: Array(21).fill({ ...preview, content: FULL }) }, 'weibo_page_exceeds_requested_count'],
  ]) {
    const h = await harness(options)
    await assert.rejects(h.invokeData(), error => {
      assert.equal(error.code, 'external_platform_response_unusable')
      assert.equal(error.details.normalizationCode, code)
      assert.doesNotMatch(JSON.stringify(error.details), /invalid-private-value/)
      return true
    })
    assert.equal([...h.platformStore.calls.values()][0].errorCode, code)
    await assert.rejects(h.invokeData({ platform: 'weibo', query: '另一关键词', pageSize: 20 }, 'another-query-idempotency'),
      { status: 409, code: 'external_platform_response_unusable' })
    assert.equal(h.calls.length, 1)
    assert.equal(h.historical.length, 0)
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
  assert.equal(h.calls[0].searchParams.get('category'), 'Latest')
})

test('Twitter data/search directly preserves full text, author, zero metrics and media in strict v1', async () => {
  const h = await harness({ platform: 'twitter', twitterData: twitterTimeline([twitterPost, twitterZeroPost]) })
  const startedAt = Date.now()
  const body = { platform: 'twitter', query: '汽车', pageSize: 10 }
  const result = await h.invokeData(body)
  assert.ok(isNightAllDataSearchV1Envelope(result.body))
  assert.equal(result.body.data.contractVersion, 'night-all.data-search.v1')
  assert.equal(result.body.data.query, body.query)
  assert.deepEqual(result.body.data.pageInfo, { pageIndex: 1, pageSize: 10, returnedCount: 2,
    hasMore: false, nextCursor: null, cursorType: 'none' })
  assert.equal(result.body.data.meta.providerCalls, 1)
  const [item, zero] = result.body.data.items
  assert.equal(item.id, twitterPost.rest_id)
  assert.equal(item.externalId, twitterPost.rest_id)
  assert.equal(item.platform, 'twitter')
  assert.equal(item.contentType, 'post')
  assert.equal(item.title, null)
  assert.equal(item.text, TWITTER_LONG_TEXT)
  assert.equal(item.url, `https://twitter.com/fixture_author/status/${twitterPost.rest_id}`)
  assert.equal(item.publishedAt, '2026-10-08T01:00:00.000Z')
  assert.ok(Date.parse(item.collectedAt) >= startedAt && Date.parse(item.collectedAt) <= Date.now())
  assert.deepEqual(item.author, { id: '1843144227000000002', name: '作者显示名', avatarUrl: 'https://example.test/twitter-avatar.jpg' })
  assert.deepEqual(item.metrics, { likes: 0, comments: 7, shares: 0, views: 0, bookmarks: 9 })
  assert.deepEqual(item.media, { coverUrl: 'https://example.test/twitter-video-cover.jpg',
    images: ['https://example.test/twitter-photo.jpg'],
    videos: ['https://example.test/twitter-large.mp4'] })
  assert.deepEqual(item.source, { provider: null, endpointId: null })
  assert.equal(zero.text, '普通正文')
  assert.deepEqual(zero.metrics, { likes: 0, comments: 0, shares: 0, views: 0, bookmarks: 0 })
  assert.deepEqual(zero.author, { id: null, name: null, avatarUrl: null })
  assert.deepEqual(zero.media, { coverUrl: null, images: [], videos: [] })
  assert.equal(zero.publishedAt, '2026-10-08T02:00:00.000Z')
  assert.equal(h.calls[0].searchParams.get('category'), 'Top')
  assert.equal(h.calls[0].searchParams.get('count'), '10')
  assert.equal(h.calls.length, 1)
  assert.equal(h.historical.length, 0)
  const usage = [...h.store.requests.values()][0]
  assert.equal(usage.billingMeterKey, 'twitter')
  assert.equal(usage.unitsActual, 2)
  assert.equal(h.platformStore.ingestJobs[0].payload.datasetId, 'night-all.search.v1')
  assert.equal(h.platformStore.ingestJobs[0].payload.records[0].title, null)
  assert.equal(h.platformStore.ingestJobs[0].payload.records[0].body, TWITTER_LONG_TEXT)
  const record = h.platformStore.ingestJobs[0].payload.records[0]
  assert.equal(record.authorExternalId, item.author.id)
  assert.equal(record.authorName, item.author.name)
  assert.equal(record.stableFields.author.avatarUrl, item.author.avatarUrl)
  assert.deepEqual(record.metrics, item.metrics)
  assert.deepEqual(record.stableFields.media, item.media)
  assert.equal(new Date(record.eventTime).toISOString(), item.publishedAt)
  assert.equal(new Date(record.collectedAt).toISOString(), item.collectedAt)
  assert.equal(h.platformStore.restrictedResponseArchives.size, 1)
  assert.deepEqual((await h.invokeData(body)).body, result.body)
  assert.equal(h.calls.length, 1)
})

test('Twitter data/search unwraps a root TimelineAddEntries instruction and preserves archive, replay and scoped pagination', async () => {
  const posts = Array.from({ length: 20 }, (_, index) => ({ ...twitterZeroPost, rest_id: String(1843144227000000000n + BigInt(index)) }))
  const entries = twitterTimeline(posts, 'root-wrapper-next').data.search_by_raw_query.search_timeline.timeline.instructions[0].entries
  const value = entries[1].content.itemContent.tweet_results.result
  entries[1].content.itemContent.tweet_results.result = { __typename: 'TweetWithVisibilityResults', tweet: value }
  const wire = { entries: [{ type: 'TimelineAddEntries', entries }] }
  const h = await harness({ platform: 'twitter', twitterData: wire })
  const body = { platform: 'twitter', query: 'fixture', pageSize: 20, type: 'stable' }
  const first = await h.invokeData(body, 'twitter-root-wrapper-first')
  assert.equal(isNightAllDataSearchV1Envelope(first.body), true)
  assert.equal(first.body.data.items.length, 20)
  assert.equal(first.body.data.pageInfo.returnedCount, 20)
  assert.equal(first.body.data.pageInfo.hasMore, true)
  assert.match(first.body.data.pageInfo.nextCursor, /^mxds1\./)
  assert.equal(h.calls[0].searchParams.get('category'), 'Top')
  assert.equal(h.calls[0].searchParams.get('count'), '20')
  assert.equal(h.calls.length, 1)
  assert.equal(h.historical.length, 0)
  const receipt = [...h.platformStore.restrictedResponseArchives.values()][0]
  const originalBytes = Buffer.from(receipt.bodyBytes), originalHash = receipt.bodySha256
  assert.deepEqual(JSON.parse(originalBytes.toString()), wire)
  assert.deepEqual((await h.invokeData(body, 'twitter-root-wrapper-first')).body, first.body)
  assert.equal(h.calls.length, 1)
  const next = await h.invokeData({ ...body, cursor: first.body.data.pageInfo.nextCursor }, 'twitter-root-wrapper-next')
  assert.equal(next.body.data.pageInfo.pageIndex, 2)
  assert.equal(next.body.data.items.length, 0, 'previously delivered tweets are excluded across source pages')
  assert.equal(next.body.data.pageInfo.hasMore, false, 'a repeated supplier token is terminal')
  assert.equal(h.calls[1].searchParams.get('cursor'), 'root-wrapper-next')
  assert.equal(h.calls.length, 2)
  assert.equal(receipt.bodySha256, originalHash)
  assert.ok(originalBytes.equals(Buffer.from(receipt.bodyBytes)))
})

test('Twitter parser correction never rewrites a committed stable empty delivery or acquires it again', async () => {
  const h = await harness({ platform: 'twitter', enabled: false })
  const body = { platform: 'twitter', query: 'fixture', pageSize: 20, type: 'stable' }
  const requestId = randomUUID()
  await h.store.reserve({ requestId, idempotencyKey: 'twitter-stable-empty-history',
    fingerprint: requestFingerprint({ method: 'POST', path: '/api/v1/data/search', body }),
    tenantId: h.context.tenant.id, consumerId: h.context.consumer.id, apiKeyId: h.context.apiKey.id,
    platform: 'twitter', unitsReserved: 1, leaseExpiresAt: new Date(Date.now() + 120000),
    windowStart: new Date(Date.now() - 3600000), maxRequests: 100, replayWindowMs: null })
  const saved = structuredClone(h.oldDataPayload)
  saved.requestId = requestId
  saved.data.query = body.query
  saved.data.items = []
  saved.data.pageInfo.returnedCount = 0
  await h.store.commitRequest(requestId, { responseStatus: 200, responseBody: saved, unitsActual: 1 })
  h.store.requests.get(requestId).completedAt = new Date(Date.now() - 86400000).toISOString()
  const replay = await h.invokeData(body, 'twitter-stable-empty-history')
  assert.equal(replay.replay, true)
  assert.deepEqual(replay.body, saved)
  assert.deepEqual(h.store.requests.get(requestId).responseBody, saved)
  assert.equal(h.calls.length, 0)
  assert.equal(h.historical.length, 0)
  assert.equal(h.platformStore.restrictedResponseArchives.size, 0)
})

test('Twitter standard oversized module pages fill the next page from carry plus one paid Bottom and retain its remainder', async () => {
  const posts = Array.from({ length: 24 }, (_, i) => ({ ...twitterZeroPost, rest_id: String(i + 1) }))
  const entries = twitterTimeline(posts, 'original-twitter-bottom').data.search_by_raw_query.search_timeline.timeline.instructions[0].entries
  const module = rows => ({ content: { entryType: 'TimelineTimelineModule', items: rows.map(row => ({ item: row.content })) } })
  const wire = { entries: [{ type: 'TimelineAddEntries', entries: [...entries.slice(0, 18),
    module(entries.slice(18, 21)), module(entries.slice(21, 24)), entries[24],
    { content: { cursorType: 'Top', value: 'original-twitter-top' } },
    { content: { itemContent: { itemType: 'TimelineUser' } } }] }] }
  assert.equal(wire.entries[0].entries.length, 23)
  const additional = Array.from({ length: 24 }, (_, i) => ({ ...twitterZeroPost, rest_id: String(i + 25) }))
  const h = await harness({ platform: 'twitter', twitterData: url => url.searchParams.has('cursor') ? twitterTimeline(additional, null) : wire })
  await h.service.setTenantBillingProfile(h.context.tenant.id,
    { mode: 'enforced', multiplierPpm: 1000000, defaultUnitPriceMinor: 1, defaultCurrency: 'CNY' }, 'test-admin')
  await h.service.addTenantCredit(h.context.tenant.id, { amountMinor: 100, currency: 'CNY', reason: 'Offline Twitter pagination fixture' },
    { idempotencyKey: 'twitter-pagination-credit', actor: 'test-admin' })
  const body = { platform: 'twitter', query: 'fixture', pageSize: 20, type: 'stable' }
  const first = await h.invokeData(body, 'twitter-overflow-first')
  assert.equal(first.body.data.items.length, 20)
  assert.equal(first.body.data.pageInfo.hasMore, true)
  assert.equal(first.body.data.meta.providerCalls, 1)
  const codec = createDataSearchCursorCodec(PEPPER, `${h.context.consumer.id}:${h.context.apiKey.id}`)
  const state = codec.decode(first.body.data.pageInfo.nextCursor)
  assert.equal(state.provider, 'rapidapi')
  assert.equal(state.buffer.offset, 20)
  assert.equal(state.providerCursor, undefined)
  const receipt = [...h.platformStore.restrictedResponseArchives.values()][0]
  const bytes = Buffer.from(receipt.bodyBytes), sha = receipt.bodySha256
  assert.deepEqual(JSON.parse(bytes.toString()), wire)
  const bufferedBody = { ...body, cursor: first.body.data.pageInfo.nextCursor }
  const second = await h.invokeData(bufferedBody, 'twitter-overflow-buffer')
  assert.deepEqual((await h.invokeData(bufferedBody, 'twitter-overflow-buffer')).body, second.body)
  assert.equal(second.body.data.items.length, 20)
  assert.equal(second.body.data.meta.providerCalls, 1)
  assert.equal(second.body.data.pageInfo.pageIndex, 2)
  assert.equal(second.body.data.pageInfo.hasMore, true)
  assert.deepEqual([...first.body.data.items, ...second.body.data.items].map(row => row.id), [...posts, ...additional].slice(0, 40).map(row => row.rest_id))
  assert.equal(h.calls.length, 2)
  assert.equal(h.platformStore.calls.size, 2)
  assert.equal([...h.platformStore.calls.values()][0].itemCount, 24)
  assert.equal(h.platformStore.ingestJobs.length, 2)
  assert.equal(h.platformStore.ingestJobs[0].payload.records.filter(row => row.objectType === 'post').length, 24)
  assert.equal(h.store.requests.get(first.requestId).unitsActual, 20)
  assert.equal(h.store.requests.get(second.requestId).unitsActual, 20)
  const third = await h.invokeData({ ...body, cursor: second.body.data.pageInfo.nextCursor }, 'twitter-overflow-bottom')
  assert.equal(h.calls.length, 2)
  assert.equal(h.calls[1].searchParams.get('cursor'), 'original-twitter-bottom')
  assert.equal(h.calls[1].searchParams.get('category'), 'Top')
  assert.equal(h.calls[1].searchParams.get('count'), '16')
  assert.equal(h.calls[1].searchParams.get('includeTimestamp'), 'false')
  assert.equal(third.body.data.items.length, 8)
  assert.equal(third.body.data.meta.providerCalls, 0)
  assert.deepEqual([...first.body.data.items, ...second.body.data.items, ...third.body.data.items].map(row => row.id), [...posts, ...additional].map(row => row.rest_id))
  assert.equal(third.body.data.pageInfo.hasMore, false)
  assert.equal(receipt.bodySha256, sha)
  assert.ok(bytes.equals(Buffer.from(receipt.bodyBytes)))
  const charges = [...h.store.customerCharges.values()]
  assert.equal(charges.length, 3)
  assert.ok(charges.every(row => row.chargedMinor === 1 && row.meterKey === 'twitter'))
  assert.equal(h.historical.length, 0)
  for (const result of [first, second, third]) assert.ok(isNightAllDataSearchV1Envelope(result.body))
})

test('Twitter buffer failures preserve paid evidence and never reacquire; credential echoes fail closed', async () => {
  for (const corruption of [null, 'missing', 'bytes', 'hash', 'identity', 'failed', 'credential-echo']) {
    const posts = Array.from({ length: 21 }, (_, i) => ({ ...twitterZeroPost, rest_id: String(i + 1),
      legacy: { ...twitterZeroPost.legacy, full_text: corruption === 'credential-echo' ? 'fixture-secret' : 'safe fixture' } }))
    const h = await harness({ platform: 'twitter', twitterData: twitterTimeline(posts, null) })
    const body = { platform: 'twitter', query: 'fixture', pageSize: 20, type: 'stable' }
    const first = await h.invokeData(body, 'twitter-buffer-source')
    const [callId, archive] = [...h.platformStore.restrictedResponseArchives][0]
    assert.doesNotMatch(JSON.stringify(first.body), /fixture-secret/)
    if (corruption === 'missing') h.platformStore.restrictedResponseArchives.delete(callId)
    if (corruption === 'bytes') archive.bodyBytes[0] = 0
    if (corruption === 'hash') archive.bodySha256 = '0'.repeat(64)
    if (corruption === 'identity') h.store.requests.get(first.requestId).apiKeyId = randomUUID()
    if (corruption === 'failed') h.platformStore.calls.get(callId).outcome = 'succeeded_unusable'
    if (!corruption) h.gateway.adapter.apiKey = 'rotated-credential-with-no-provider-echo'
    const invoke = () => h.invokeData({ ...body, cursor: first.body.data.pageInfo.nextCursor }, 'twitter-buffer-followup')
    if (corruption) await assert.rejects(invoke(), { code: 'search_page_unavailable' })
    else {
      const last = await invoke()
      assert.equal(last.body.data.items.length, 1)
      assert.equal(last.body.data.pageInfo.hasMore, false)
      assert.equal(last.body.data.pageInfo.nextCursor, null)
      assert.equal(last.body.data.meta.providerCalls, 0)
    }
    assert.equal(h.calls.length, 1)
    assert.equal(h.platformStore.ingestJobs.length, 1)
  }
})

test('Twitter later paid-page overflow preserves its input cursor while a short carry can continue to Bottom', async () => {
  const rows = count => Array.from({ length: count }, (_, i) => ({ ...twitterZeroPost, rest_id: String(i + 1) }))
  const h = await harness({ platform: 'twitter', twitterData: url => {
    const cursor = url.searchParams.get('cursor')
    return cursor === 'first-bottom' ? twitterTimeline(rows(5), 'second-bottom')
      : cursor === 'second-bottom' ? twitterTimeline([], null) : twitterTimeline(rows(2).map((row, i) => ({ ...row, rest_id: String(i + 101) })), 'first-bottom')
  } })
  const body = { platform: 'twitter', query: 'fixture', pageSize: 2, type: 'stable' }
  let current = await h.invokeData(body, 'twitter-later-page-first')
  const second = await h.invokeData({ ...body, cursor: current.body.data.pageInfo.nextCursor }, 'twitter-later-page-second')
  assert.equal(second.body.data.items.length, 2)
  assert.equal(h.calls.length, 2)
  const codec = createDataSearchCursorCodec(PEPPER, `${h.context.consumer.id}:${h.context.apiKey.id}`)
  const state = codec.decode(second.body.data.pageInfo.nextCursor)
  assert.equal(state.providerCursor, 'first-bottom')
  current = second
  const ids = [...second.body.data.items.map(item => item.id)]
  for (const page of [3, 4]) {
    current = await h.invokeData({ ...body, cursor: current.body.data.pageInfo.nextCursor }, `twitter-later-buffer-${page}`)
    ids.push(...current.body.data.items.map(item => item.id))
    assert.equal(current.body.data.meta.providerCalls, page === 3 ? 0 : 1)
    assert.equal(h.calls.length, page === 3 ? 2 : 3)
  }
  assert.deepEqual(ids, ['1', '2', '3', '4', '5'])
  assert.equal(h.calls.length, 3)
  assert.equal(h.calls[2].searchParams.get('cursor'), 'second-bottom')
  assert.equal(current.body.data.pageInfo.hasMore, false)
  assert.equal(h.platformStore.ingestJobs.length, 3, 'each live acquisition enqueues once; buffer deliveries enqueue nothing')
})

test('Twitter overflow offsets use requested pageSize100 rather than capped provider count50', async () => {
  const posts = Array.from({ length: 120 }, (_, i) => ({ ...twitterZeroPost, rest_id: String(i + 1) }))
  const h = await harness({ platform: 'twitter', twitterData: twitterTimeline(posts, null) })
  const body = { platform: 'twitter', query: 'fixture', pageSize: 100, type: 'stable' }
  const first = await h.invokeData(body, 'twitter-hundred-first')
  assert.equal(h.calls[0].searchParams.get('count'), '50')
  assert.equal(first.body.data.items.length, 100)
  const second = await h.invokeData({ ...body, cursor: first.body.data.pageInfo.nextCursor }, 'twitter-hundred-buffer')
  assert.equal(second.body.data.items.length, 20)
  assert.equal(second.body.data.meta.providerCalls, 0)
  assert.equal(second.body.data.pageInfo.hasMore, false)
  assert.deepEqual([...first.body.data.items, ...second.body.data.items].map(row => row.id), posts.map(row => row.rest_id))
  assert.equal(h.calls.length, 1)
  assert.equal(h.platformStore.ingestJobs[0].payload.records.filter(row => row.objectType === 'post').length, 120)
})

test('Twitter buffers retain route, provider, query, page-size, type, Key and current authorization boundaries', async () => {
  const posts = Array.from({ length: 21 }, (_, i) => ({ ...twitterZeroPost, rest_id: String(i + 1) }))
  const h = await harness({ platform: 'twitter', twitterData: twitterTimeline(posts, null) })
  const body = { platform: 'twitter', query: 'fixture', pageSize: 20, type: 'stable' }
  const first = await h.invokeData(body, 'twitter-buffer-boundary-first')
  const cursor = first.body.data.pageInfo.nextCursor, nextBody = { ...body, cursor }
  const codec = createDataSearchCursorCodec(PEPPER, `${h.context.consumer.id}:${h.context.apiKey.id}`), state = codec.decode(cursor)
  for (const patch of [{ expiresAt: 1 }, { page: 16 }, { provider: 'tikhub' }, { provider: null },
    { buffer: { ...state.buffer, offset: 0 } }, { buffer: { ...state.buffer, callId: 'bad' } },
    { buffer: { ...state.buffer, unexpected: true } }]) {
    await assert.rejects(h.invokeData({ ...body, cursor: codec.encode({ ...state, ...patch }) }, randomUUID()), { code: 'invalid_cursor' })
  }
  for (const patch of [{ query: 'different' }, { pageSize: 10 }, { type: 'fresh' }]) {
    await assert.rejects(h.invokeData({ ...nextBody, ...patch }, randomUUID()), { code: 'invalid_cursor' })
  }
  await assert.rejects(h.invoke({ platform: 'twitter', query: body.query, count: body.pageSize, cursor }, 'twitter-buffer-raw-route'), { code: 'invalid_cursor' })
  const otherKey = await h.service.createApiKey({ consumerId: h.context.consumer.id, name: 'Other Twitter key', platforms: ['twitter'], capabilities: [] })
  const otherContext = await h.service.authenticate(otherKey.secret)
  await assert.rejects(h.service.search(otherContext, { body: nextBody, idempotencyKey: 'twitter-buffer-other-key', path: '/api/v1/data/search' }), { code: 'invalid_cursor' })
  await assert.rejects(h.invokeData({ ...body, cursor: codec.encode({ ...state, buffer: { ...state.buffer, hash: '0'.repeat(64) } }) }, 'twitter-buffer-projection-drift'), { code: 'search_page_unavailable' })
  h.store.apiKeyPlatformEntitlements.get(h.context.apiKey.id)[0].maxPageSize = 10
  await assert.rejects(h.invokeData(nextBody, 'twitter-buffer-page-limit'), { code: 'page_size_exceeded' })
  h.store.apiKeyPlatformEntitlements.get(h.context.apiKey.id)[0].maxPageSize = 100
  await h.store.setPlatformGrant(h.context.consumer.id, 'twitter', false)
  await assert.rejects(h.invokeData(nextBody, 'twitter-buffer-grant-revoked'), { code: 'platform_not_granted' })
  assert.equal(h.calls.length, 1)
})

test('Twitter raw aliases remain strict for oversized pages and do not gain standard buffers', async () => {
  const posts = Array.from({ length: 21 }, (_, i) => ({ ...twitterZeroPost, rest_id: String(i + 1) }))
  const h = await harness({ platform: 'twitter', twitterData: twitterTimeline(posts, null) })
  await assert.rejects(h.invoke({ platform: 'twitter', query: 'fixture', count: 20 }, 'twitter-raw-overflow'), { code: 'social_upstream_response_unusable' })
  assert.equal(h.calls.length, 1)
  assert.equal([...h.platformStore.calls.values()][0].outcome, 'succeeded_unusable')
  assert.equal(h.platformStore.ingestJobs.length, 0)
  assert.equal(h.platformStore.restrictedResponseArchives.size, 1)
})

test('Twitter overflow correction preserves an already committed stable unusable response without a paid retry', async () => {
  const h = await harness({ platform: 'twitter', enabled: false })
  const body = { platform: 'twitter', query: 'fixture', pageSize: 20, type: 'stable' }, requestId = randomUUID()
  await h.store.reserve({ requestId, idempotencyKey: 'twitter-historical-unusable',
    fingerprint: requestFingerprint({ method: 'POST', path: '/api/v1/data/search', body }),
    tenantId: h.context.tenant.id, consumerId: h.context.consumer.id, apiKeyId: h.context.apiKey.id,
    platform: 'twitter', unitsReserved: 1, leaseExpiresAt: new Date(Date.now() + 120000),
    windowStart: new Date(Date.now() - 3600000), maxRequests: 100, replayWindowMs: null })
  const saved = { requestId, error: { code: 'social_upstream_response_unusable', message: 'Historical immutable failure',
    details: { requestId, upstreamStatus: 200, outcome: 'succeeded_unusable' } } }
  await h.store.commitRequest(requestId, { responseStatus: 502, responseBody: saved, unitsActual: 1 })
  await assert.rejects(h.invokeData(body, 'twitter-historical-unusable'), { status: 502, code: 'social_upstream_response_unusable' })
  assert.deepEqual(h.store.requests.get(requestId).responseBody, saved)
  assert.equal(h.store.requests.get(requestId).responseStatus, 502)
  assert.equal(h.calls.length, 0)
  assert.equal(h.platformStore.ingestJobs.length, 0)
})

test('Twitter fill de-duplicates previous delivered pages and carries an arbitrary offset from the next acquisition', async () => {
  const rows = (start, count) => Array.from({ length: count }, (_, i) => ({ ...twitterZeroPost, rest_id: String(start + i) }))
  const h = await harness({ platform: 'twitter', twitterData: url => {
    const cursor = url.searchParams.get('cursor')
    return cursor === 'fill-one' ? twitterTimeline(rows(11, 20), 'fill-two')
      : cursor === 'fill-two' ? twitterTimeline(rows(31, 20), null) : twitterTimeline(rows(1, 20), 'fill-one')
  } })
  const body = { platform: 'twitter', query: 'fixture', pageSize: 20, type: 'stable' }
  const first = await h.invokeData(body, 'twitter-dedup-first')
  const secondBody = { ...body, cursor: first.body.data.pageInfo.nextCursor }
  const second = await h.invokeData(secondBody, 'twitter-dedup-second')
  assert.equal(second.body.data.meta.providerCalls, 2)
  assert.equal(second.body.data.items.length, 20)
  const codec = createDataSearchCursorCodec(PEPPER, `${h.context.consumer.id}:${h.context.apiKey.id}`)
  const cursorState = codec.decode(second.body.data.pageInfo.nextCursor)
  assert.equal(cursorState.fill.version, 'twitter-fill.v1')
  assert.equal(cursorState.fill.upstreamPages, 3)
  assert.equal(cursorState.fill.previousDeliveryId, second.requestId)
  assert.equal(cursorState.buffer.offset, 10)
  assert.deepEqual((await h.invokeData(secondBody, 'twitter-dedup-second')).body, second.body)
  const third = await h.invokeData({ ...body, cursor: second.body.data.pageInfo.nextCursor }, 'twitter-dedup-third')
  assert.equal(third.body.data.meta.providerCalls, 0)
  assert.equal(third.body.data.items.length, 10)
  assert.equal(third.body.data.pageInfo.hasMore, false)
  assert.deepEqual([...first.body.data.items, ...second.body.data.items, ...third.body.data.items].map(item => item.id),
    Array.from({ length: 50 }, (_, i) => String(i + 1)))
  assert.equal(h.calls.length, 3)
  assert.equal(h.platformStore.ingestJobs.length, 3)
  assert.equal(h.platformStore.ingestJobs.reduce((sum, job) => sum + job.payload.records.filter(row => row.objectType === 'post').length, 0), 60,
    'all three original paid pages ingest once, including their source overlap')
  assert.equal(h.platformStore.requests.filter(row => row.succeeded && row.sourceMode !== 'idempotent_replay').length, 3,
    'one representative gateway event per delivered HTTP request, not per acquisition')
})

test('Twitter fills beyond three real dispatches and carries its upstream traversal count without resetting', async () => {
  const h = await harness({ platform: 'twitter', twitterData: url => {
    const index = Number(url.searchParams.get('cursor')?.replace('bounded-', '') || 0)
    return twitterTimeline(Array.from({ length: 4 }, (_, offset) => ({ ...twitterZeroPost,
      rest_id: String(index * 4 + offset + 1) })), `bounded-${index + 1}`)
  } })
  const body = { platform: 'twitter', query: 'fixture', pageSize: 20, type: 'stable' }
  let cursor, count = 0
  for (let page = 1; page <= 3; page++) {
    const result = await h.invokeData({ ...body, ...(cursor ? { cursor } : {}) }, `twitter-bounded-${page}`)
    assert.equal(result.body.data.items.length, 20)
    assert.equal(result.body.data.meta.providerCalls, 5)
    assert.equal(result.body.data.status, page < 3 ? 'ok' : 'partial')
    count += result.body.data.items.length
    cursor = result.body.data.pageInfo.nextCursor
    if (page < 3) {
      const codec = createDataSearchCursorCodec(PEPPER, `${h.context.consumer.id}:${h.context.apiKey.id}`)
      assert.equal(codec.decode(cursor).fill.upstreamPages, page * 5)
    } else assert.equal(cursor, null)
  }
  assert.equal(h.calls.length, 15)
  assert.equal(count, 60)
  assert.equal(h.platformStore.restrictedResponseArchives.size, 15)
  assert.equal(h.platformStore.ingestJobs.length, 15)
  assert.equal(h.store.requests.size, 3)
})

test('Twitter fill closes a known repeated Bottom loop without publishing it for another purchase', async () => {
  const h = await harness({ platform: 'twitter', twitterData: url => {
    const cursor = url.searchParams.get('cursor')
    const id = cursor === 'loop-A' ? '2' : cursor === 'loop-B' ? '3' : '1'
    return twitterTimeline([{ ...twitterZeroPost, rest_id: id }], cursor === 'loop-A' ? 'loop-B' : 'loop-A')
  } })
  const body = { platform: 'twitter', query: 'fixture', pageSize: 20, type: 'stable' }
  const result = await h.invokeData(body, 'twitter-repeated-bottom')
  assert.deepEqual(result.body.data.items.map(item => item.id), ['1', '2', '3'])
  assert.equal(result.body.data.meta.providerCalls, 3)
  assert.equal(result.body.data.pageInfo.hasMore, false)
  assert.equal(result.body.data.pageInfo.nextCursor, null)
  assert.equal(result.body.data.status, 'partial')
  assert.deepEqual((await h.invokeData(body, 'twitter-repeated-bottom')).body, result.body)
  assert.equal(h.calls.length, 3)
  assert.equal(h.platformStore.ingestJobs.length, 3)
})

test('Twitter full-page repeated Bottom closes immediately, while repeated-page overflow keeps its paid carry until drained', async () => {
  for (const count of [20, 24]) {
    const h = await harness({ platform: 'twitter', twitterData: url => {
      const cursor = url.searchParams.get('cursor')
      return twitterTimeline(Array.from({ length: cursor ? count : 20 }, (_, i) => ({ ...twitterZeroPost,
        rest_id: String(i + (cursor ? 21 : 1)),
      })), 'same-bottom')
    } })
    const body = { platform: 'twitter', query: 'fixture', pageSize: 20, type: 'stable' }
    const first = await h.invokeData(body, 'twitter-full-repeat-first')
    const second = await h.invokeData({ ...body, cursor: first.body.data.pageInfo.nextCursor }, 'twitter-full-repeat-second')
    assert.equal(second.body.data.items.length, 20)
    assert.equal(h.calls.length, 2)
    if (count === 20) {
      assert.equal(second.body.data.pageInfo.hasMore, false)
      assert.equal(second.body.data.pageInfo.nextCursor, null)
    } else {
      assert.equal(second.body.data.pageInfo.hasMore, true)
      const carry = await h.invokeData({ ...body, cursor: second.body.data.pageInfo.nextCursor }, 'twitter-full-repeat-carry')
      assert.deepEqual(carry.body.data.items.map(item => item.id), ['41', '42', '43', '44'])
      assert.equal(carry.body.data.meta.providerCalls, 0)
      assert.equal(carry.body.data.pageInfo.hasMore, false)
      assert.equal(carry.body.data.pageInfo.nextCursor, null)
    }
    assert.equal(h.calls.length, 2)
    assert.equal(h.platformStore.ingestJobs.length, 2)
  }
})

async function waitForTwitterQueue(gateway, depth = 1) {
  for (let i = 0; i < 100 && gateway.concurrencyQueue.entries.length !== depth; i++) await new Promise(resolve => setTimeout(resolve, 2))
  assert.equal(gateway.concurrencyQueue.entries.length, depth)
}

test('Twitter standard bounded waiting times out at either concurrency limit and releases only the rejected request', async () => {
  for (const limit of ['hub', 'consumer']) {
    const h = await harness({ platform: 'twitter', twitterData: twitterTimeline([twitterPost], null) })
    h.config.maxConcurrency = limit === 'hub' ? 1 : 3
    h.config.maxConsumerConcurrency = 1
    h.config.concurrencyQueue = { maxWaitMs: 30, maxPending: 1 }
    let started, finish
    const pending = new Promise(resolve => { started = resolve })
    const held = new Promise(resolve => { finish = resolve })
    const execute = h.gateway.adapter.execute.bind(h.gateway.adapter)
    h.gateway.adapter.execute = async (...args) => { started(); await held; return execute(...args) }
    const body = { platform: 'twitter', query: 'leader', pageSize: 20 }
    const leader = h.invokeData(body, `twitter-${limit}-busy-leader`)
    await pending
    try {
      await assert.rejects(h.invokeData({ ...body, query: 'follower' }, `twitter-${limit}-busy-follower`), error => {
        assert.equal(error.status, 503)
        assert.equal(error.code, 'external_platform_busy')
        assert.match(error.message, /Hub Twitter.*并发.*尚未发起采集/)
        assert.equal(error.details.layer, 'hub')
        assert.equal(error.details.stage, 'concurrency_admission')
        assert.equal(error.details.reason, 'concurrency_queue_timeout')
        assert.equal(error.details.upstreamDispatched, false)
        assert.equal(error.details.admissionMode, 'bounded_wait')
        assert.equal(error.details.maxWaitMs, 30)
        assert.equal(error.details.retryAfterMs, 1000)
        assert.equal(error.details.activeConcurrency, 1)
        assert.equal(error.details.consumerActiveConcurrency, 1)
        assert.equal(error.details.queueDepth, 0)
        assert.equal(h.store.requests.get(error.details.requestId).status, 'released')
        return true
      })
      assert.equal(h.platformStore.calls.size, 1, 'only the leader reached dispatch')
      assert.equal(h.platformStore.requests.length, 1)
      assert.equal(h.platformStore.requests[0].providerCallId, null)
      assert.equal(h.platformStore.requests[0].responseStatus, 503)
      assert.equal(h.platformStore.requests[0].errorCode, 'external_platform_busy')
      assert.equal(h.gateway.active, 1, 'rejected follower does not release the leader capacity')
    } finally { finish() }
    assert.equal((await leader).status, 200)
    assert.equal(h.gateway.active, 0)
    assert.equal(h.gateway.activeByConsumer.size, 0)
    assert.equal((await h.invokeData({ ...body, query: 'follower' }, `twitter-${limit}-busy-explicit-retry`)).status, 200)
    assert.equal(h.calls.length, 2, 'only an explicit new business request dispatches after capacity becomes free')
    assert.equal(h.gateway.active, 0)
  }
})

test('Twitter standard third request waits for a consumer slot without buying capacity or losing equal-intent protection', async () => {
  const h = await harness({ platform: 'twitter', twitterData: twitterTimeline([twitterPost], null) })
  await h.service.setTenantBillingProfile(h.context.tenant.id,
    { mode: 'enforced', multiplierPpm: 1000000, defaultUnitPriceMinor: 1, defaultCurrency: 'CNY' }, 'test-admin')
  await h.service.addTenantCredit(h.context.tenant.id, { amountMinor: 100, currency: 'CNY', reason: 'Offline queue hold fixture' },
    { idempotencyKey: 'twitter-queue-credit', actor: 'test-admin' })
  h.config.maxConsumerConcurrency = 2
  h.config.concurrencyQueue = { maxWaitMs: 1000, maxPending: 4 }
  const finish = [], dispatched = []
  const execute = h.gateway.adapter.execute.bind(h.gateway.adapter)
  h.gateway.adapter.execute = async (...args) => {
    dispatched.push(args)
    if (dispatched.length <= 2) await new Promise(resolve => finish.push(resolve))
    return execute(...args)
  }
  const body = { platform: 'twitter', query: 'one', pageSize: 20 }
  const one = h.invokeData(body, 'twitter-queue-one')
  const two = h.invokeData({ ...body, query: 'two' }, 'twitter-queue-two')
  for (let i = 0; i < 100 && finish.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 2))
  assert.equal(finish.length, 2)
  const three = h.invokeData({ ...body, query: 'three' }, 'twitter-queue-three')
  try {
    await waitForTwitterQueue(h.gateway)
    const pending = [...h.store.requests.values()].find(row => row.idempotencyKey === 'twitter-queue-three')
    assert.equal(pending.status, 'reserved')
    assert.equal([...h.store.customerCharges.values()].find(row => row.usageRequestId === pending.id).status, 'reserved')
    const heldLease = [...twitterDeliveryLeases(h.store).values()].find(row => row.ownerRequestId === pending.id)
    assert.ok(heldLease, 'delivery arbitration remains held while waiting')
    assert.equal(heldLease.expiresAt, pending.leaseExpiresAt)
    assert.equal(h.platformStore.calls.size, 2)
    assert.equal(h.platformStore.costReservations.size, 2, 'the queued request has no procurement reservation')
    await assert.rejects(h.invokeData({ ...body, query: 'three' }, 'twitter-queue-three-equal'), { code: 'request_in_progress' })
    h.gateway.adapter.resolveCredential = async () => 'fresh-fixture-credential'
    finish[0]()
    assert.equal((await one).status, 200)
    assert.equal((await three).status, 200)
    assert.equal([...h.store.customerCharges.values()].find(row => row.usageRequestId === pending.id).status, 'captured')
    assert.equal(dispatched.length, 3)
    assert.equal(dispatched[2][1].credential, 'fresh-fixture-credential', 'credential is resolved again after waiting')
    assert.equal(pending.leaseExpiresAt, heldLease.expiresAt, 'waiting cannot extend the original deadline')
    assert.equal(h.gateway.active, 1, 'second original acquisition still owns one slot')
  } finally { finish.forEach(resolve => resolve()); await Promise.allSettled([one, two, three]) }
  assert.equal(h.gateway.active, 0)
  assert.equal(h.gateway.activeByConsumer.size, 0)
  assert.equal(twitterDeliveryLeases(h.store).size, 0)
  assert.equal(h.gateway.concurrencyQueue.entries.length, 0)
})

test('Twitter queued admission rechecks current access, operation, circuit and unknown-delivery protection', async t => {
  for (const scenario of ['key', 'grant', 'credential', 'operation', 'circuit', 'parent_unknown', 'dispatch_unknown']) await t.test(scenario, async () => {
    const h = await harness({ platform: 'twitter' })
    h.gateway.active = h.config.maxConcurrency
    h.config.concurrencyQueue = { maxWaitMs: 1000, maxPending: 4 }
    const pending = h.invokeData({ platform: 'twitter', query: 'waiting', pageSize: 20 }, `twitter-queue-${scenario}`).catch(error => error)
    await waitForTwitterQueue(h.gateway)
    if (scenario === 'key') await h.store.revokeApiKey(h.key.id)
    if (scenario === 'grant') await h.store.setPlatformGrant(h.context.consumer.id, 'twitter', false)
    if (scenario === 'credential') h.gateway.adapter.resolveCredential = async () => null
    if (scenario === 'operation') h.controls.authorizeDispatch = async () => { throw new AppError(503, 'external_platform_operation_paused', 'paused') }
    if (scenario === 'circuit') h.platformStore.providerState = async () => ({ circuitOpenUntil: new Date(Date.now() + 60000).toISOString() })
    if (scenario === 'parent_unknown') h.platformStore.twitterFillUnknownFor = async () => true
    if (scenario === 'dispatch_unknown') h.platformStore.acquireDispatchLease = async () => ({ kind: 'blocked', reason: 'unknown' })
    h.gateway.active = 0
    h.gateway.concurrencyQueue.drain()
    const error = await pending
    assert.ok(error instanceof AppError)
    assert.equal(error.code, ({ key: 'capability_not_granted', grant: 'capability_not_granted', credential: 'external_platform_not_configured',
      operation: 'external_platform_operation_paused', circuit: 'external_platform_circuit_open',
      parent_unknown: 'request_outcome_unknown', dispatch_unknown: 'request_outcome_unknown' })[scenario])
    assert.equal(h.platformStore.calls.size, 0)
    assert.equal(h.calls.length, 0)
    assert.equal(h.gateway.active, 0)
    assert.equal(h.gateway.activeByConsumer.size, 0)
    assert.equal(twitterDeliveryLeases(h.store).size, 0)
    assert.equal([...h.store.requests.values()][0].status, 'released')
  })
})

test('Twitter admission bounds full queues, cancellation and the original settlement margin before acquisition', async () => {
  const h = await harness({ platform: 'twitter' })
  h.gateway.active = h.config.maxConcurrency
  h.config.concurrencyQueue = { maxWaitMs: 1000, maxPending: 1 }
  const abort = new AbortController()
  const pending = h.service.search(h.context, { body: { platform: 'twitter', query: 'waiting', pageSize: 20 },
    idempotencyKey: 'twitter-queue-cancelled', path: '/api/v1/data/search', signal: abort.signal }).catch(error => error)
  await waitForTwitterQueue(h.gateway)
  await assert.rejects(h.invokeData({ platform: 'twitter', query: 'overflow', pageSize: 20 }, 'twitter-queue-full'), error => {
    assert.equal(error.status, 503)
    assert.equal(error.details.reason, 'concurrency_queue_full')
    assert.match(error.message, /Hub Twitter.*等待队列已满/)
    return true
  })
  abort.abort()
  assert.equal((await pending).code, 'request_cancelled')
  assert.equal(h.gateway.concurrencyQueue.entries.length, 0)
  h.gateway.reservationLeaseMs = h.config.timeoutMs + 5120
  await assert.rejects(h.invokeData({ platform: 'twitter', query: 'short-budget', pageSize: 20 }, 'twitter-queue-no-time'), error => {
    assert.equal(error.code, 'external_platform_busy')
    assert.equal(error.details.reason, 'concurrency_queue_timeout')
    return true
  })
  assert.equal(h.gateway.active, h.config.maxConcurrency, 'rejected requests do not release another owner capacity')
  assert.equal(h.platformStore.calls.size, 0)
  assert.equal(twitterDeliveryLeases(h.store).size, 0)
  assert.ok([...h.store.requests.values()].every(row => row.status === 'released'))
})

test('Twitter busy after consuming paid carry returns a short committed page and preserves its Bottom without waiting or another acquisition', async () => {
  const rows = start => Array.from({ length: 24 }, (_, i) => ({ ...twitterZeroPost, rest_id: String(start + i) }))
  const h = await harness({ platform: 'twitter', twitterData: url => url.searchParams.has('cursor')
    ? twitterTimeline(rows(25), null) : twitterTimeline(rows(1), 'carry-bottom') })
  await h.service.setTenantBillingProfile(h.context.tenant.id,
    { mode: 'enforced', multiplierPpm: 1000000, defaultUnitPriceMinor: 1, defaultCurrency: 'CNY' }, 'test-admin')
  await h.service.addTenantCredit(h.context.tenant.id, { amountMinor: 100, currency: 'CNY', reason: 'Offline paid carry fixture' },
    { idempotencyKey: 'twitter-busy-carry-credit', actor: 'test-admin' })
  const body = { platform: 'twitter', query: 'carry', pageSize: 20, type: 'stable' }
  const first = await h.invokeData(body, 'twitter-busy-carry-first')
  h.gateway.active = h.config.maxConcurrency
  const second = await h.invokeData({ ...body, cursor: first.body.data.pageInfo.nextCursor }, 'twitter-busy-carry-second')
  assert.equal(second.status, 200)
  assert.deepEqual(second.body.data.items.map(row => row.id), ['21', '22', '23', '24'])
  assert.equal(second.body.data.status, 'partial')
  assert.equal(second.body.data.meta.providerCalls, 0)
  assert.equal(second.body.data.pageInfo.hasMore, true)
  assert.equal(h.store.requests.get(second.requestId).status, 'committed')
  const charge = [...h.store.customerCharges.values()].find(row => row.usageRequestId === second.requestId)
  assert.equal(charge.status, 'captured')
  assert.equal(charge.chargedMinor, 1)
  assert.equal(h.gateway.concurrencyQueue.entries.length, 0)
  assert.equal(h.calls.length, 1)
  assert.equal(h.platformStore.ingestJobs.length, 1)
  assert.deepEqual((await h.invokeData({ ...body, cursor: first.body.data.pageInfo.nextCursor }, 'twitter-busy-carry-second')).body, second.body)
  h.gateway.active = 0
  const third = await h.invokeData({ ...body, cursor: second.body.data.pageInfo.nextCursor }, 'twitter-busy-carry-third')
  assert.equal(third.body.data.items[0].id, '25')
  assert.equal(h.calls.length, 2)
  assert.equal(h.platformStore.ingestJobs.length, 2)
})

test('Twitter standard HTTP busy exposes its Hub cause, durable request ID and backoff hint', async t => {
  const h = await harness({ platform: 'twitter' })
  h.gateway.active = h.config.maxConcurrency
  h.config.concurrencyQueue = { maxWaitMs: 20, maxPending: 1 }
  const server = createServer(createApp({ service: h.service, store: h.store, adapter: {}, listenerMode: 'public', logger: { error() {} } }))
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => { server.closeAllConnections(); server.close() })
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/data/search`, {
    method: 'POST', headers: { authorization: `Bearer ${h.key.secret}`, 'content-type': 'application/json', 'idempotency-key': 'twitter-http-busy' },
    body: JSON.stringify({ platform: 'twitter', query: 'fixture', pageSize: 20 }),
  })
  const body = await response.json()
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('retry-after'), '1')
  assert.equal(body.error.code, 'external_platform_busy')
  assert.match(body.error.message, /Hub Twitter.*并发/)
  assert.equal(body.error.details.reason, 'concurrency_queue_timeout')
  assert.equal(body.error.details.admissionMode, 'bounded_wait')
  assert.equal(body.error.details.upstreamDispatched, false)
  assert.equal(body.error.details.requestId, body.requestId)
  assert.equal(h.store.requests.get(body.requestId).status, 'released')
  assert.equal(h.calls.length, 0)
  assert.equal(h.platformStore.calls.size, 0)
  assert.equal(h.platformStore.requests[0].responseStatus, 503)
})

test('Twitter known rate admission may deliver a short page while a later unknown acquisition never becomes partial 200', async () => {
  const rows = start => Array.from({ length: 5 }, (_, i) => ({ ...twitterZeroPost, rest_id: String(start + i) }))
  const partial = await harness({ platform: 'twitter', twitterData: twitterTimeline(rows(1), 'rate-next') })
  partial.config.maxRequestsPerMinute = 1
  const body = { platform: 'twitter', query: 'fixture', pageSize: 20, type: 'stable' }
  const result = await partial.invokeData(body, 'twitter-admission-short')
  assert.equal(result.body.data.items.length, 5)
  assert.equal(result.body.data.status, 'partial')
  assert.equal(result.body.data.pageInfo.hasMore, true)
  assert.equal(result.body.data.meta.providerCalls, 1)
  assert.equal(partial.calls.length, 1)
  for (const type of ['fresh', 'stable']) {
    const h = await harness({ platform: 'twitter', twitterData: url => {
      if (url.searchParams.has('cursor')) throw new Error('synthetic unknown after paid dispatch')
      return twitterTimeline(rows(1), 'unknown-next')
    } })
    await assert.rejects(h.invokeData({ ...body, type }, 'twitter-fill-unknown-first'))
    const request = [...h.store.requests.values()][0]
    assert.equal(request.status, 'unknown')
    assert.equal(h.calls.length, 2)
    assert.equal(h.platformStore.restrictedResponseArchives.size, 1)
    assert.equal(h.platformStore.ingestJobs.length, 1)
    assert.deepEqual([...h.platformStore.calls.values()].map(row => row.outcome), ['succeeded', 'unknown'])
    await assert.rejects(h.invokeData({ ...body, type }, 'twitter-fill-unknown-first'), { code: 'request_outcome_unknown' })
    await assert.rejects(h.invokeData({ ...body, type }, 'twitter-fill-unknown-new-key'), { code: 'request_outcome_unknown' })
    assert.equal(h.calls.length, 2)
  }
})

test('Twitter fill final-commit uncertainty keeps the parent unknown even when every supplier step succeeded', async () => {
  const h = await harness({ platform: 'twitter', twitterData: twitterTimeline([twitterPost], null) })
  h.platformStore.commitTwitterFillDelivery = async () => { throw new Error('synthetic parent persistence uncertainty') }
  const body = { platform: 'twitter', query: 'fixture', pageSize: 20, type: 'stable' }
  await assert.rejects(h.invokeData(body, 'twitter-fill-final-unknown'))
  assert.equal([...h.store.requests.values()][0].status, 'unknown')
  assert.equal(h.calls.length, 1)
  assert.equal([...h.platformStore.calls.values()][0].outcome, 'succeeded')
  assert.equal(h.platformStore.restrictedResponseArchives.size, 1)
  assert.equal(h.platformStore.ingestJobs.length, 1)
  await assert.rejects(h.invokeData(body, 'twitter-fill-final-unknown-other'), { code: 'request_outcome_unknown' })
  assert.equal(h.calls.length, 1)
})

test('Twitter cached-only final-commit uncertainty blocks a new idempotency key without another acquisition', async () => {
  const posts = Array.from({ length: 21 }, (_, i) => ({ ...twitterZeroPost, rest_id: String(i + 1) }))
  const h = await harness({ platform: 'twitter', twitterData: twitterTimeline(posts, null) })
  const body = { platform: 'twitter', query: 'fixture', pageSize: 20, type: 'stable' }
  const first = await h.invokeData(body, 'twitter-cached-unknown-source')
  const continuation = { ...body, cursor: first.body.data.pageInfo.nextCursor }
  const saved = structuredClone(first.body)
  h.platformStore.commitTwitterFillDelivery = async () => { throw new Error('synthetic buffer-only commit uncertainty') }
  await assert.rejects(h.invokeData(continuation, 'twitter-cached-unknown-first'), { code: 'request_outcome_unknown' })
  assert.equal([...h.store.requests.values()].find(row => row.idempotencyKey === 'twitter-cached-unknown-first').status, 'unknown')
  await assert.rejects(h.invokeData(continuation, 'twitter-cached-unknown-new-key'), { code: 'request_outcome_unknown' })
  assert.equal(h.calls.length, 1)
  assert.equal(h.platformStore.ingestJobs.length, 1)
  assert.equal(h.platformStore.restrictedResponseArchives.size, 1)
  assert.equal(h.store.requests.get(first.requestId).status, 'committed')
  assert.deepEqual(h.store.requests.get(first.requestId).responseBody, saved)
})

test('Twitter uncertain cached commit preserves its customer hold and lease when unknown marking fails, then reaps to unknown', async () => {
  const posts = Array.from({ length: 21 }, (_, i) => ({ ...twitterZeroPost, rest_id: String(i + 1) }))
  const h = await harness({ platform: 'twitter', twitterData: twitterTimeline(posts, null) })
  await h.service.setTenantBillingProfile(h.context.tenant.id,
    { mode: 'enforced', multiplierPpm: 1000000, defaultUnitPriceMinor: 1, defaultCurrency: 'CNY' }, 'test-admin')
  await h.service.addTenantCredit(h.context.tenant.id, { amountMinor: 100, currency: 'CNY', reason: 'Offline uncertain commit fixture' },
    { idempotencyKey: 'twitter-uncertain-commit-credit', actor: 'test-admin' })
  const body = { platform: 'twitter', query: 'fixture', pageSize: 20, type: 'stable' }
  const first = await h.invokeData(body, 'twitter-retained-source')
  const continuation = { ...body, cursor: first.body.data.pageInfo.nextCursor }
  const originalMark = h.store.markRequestUnknown.bind(h.store), originalGet = h.store.getRequest.bind(h.store)
  const originalRelease = h.store.releaseRequest.bind(h.store), releaseCalls = []
  h.platformStore.commitTwitterFillDelivery = async () => { throw new Error('synthetic commit acknowledgement unavailable') }
  h.store.markRequestUnknown = async () => { throw new Error('synthetic unknown write unavailable') }
  h.store.getRequest = async () => { throw new Error('synthetic confirmation read unavailable') }
  h.store.releaseRequest = async (...args) => { releaseCalls.push(args); return originalRelease(...args) }
  await assert.rejects(h.invokeData(continuation, 'twitter-retained-unknown'), error => {
    assert.equal(error.code, 'request_outcome_unknown')
    assert.doesNotMatch(JSON.stringify(error.details), /preserveReservation/)
    return true
  })
  const pending = [...h.store.requests.values()].find(row => row.idempotencyKey === 'twitter-retained-unknown')
  const charge = [...h.store.customerCharges.values()].find(row => row.usageRequestId === pending.id)
  assert.equal(pending.status, 'reserved')
  assert.equal(charge.status, 'reserved')
  assert.equal(releaseCalls.length, 0, 'outer cleanup cannot release a hold whose outcome is unconfirmed')
  assert.ok([...twitterDeliveryLeases(h.store).values()].some(lease => lease.ownerRequestId === pending.id))
  await assert.rejects(h.invokeData(continuation, 'twitter-retained-before-expiry'), { code: 'request_in_progress' })
  assert.equal(pending.status, 'reserved')
  assert.equal(charge.status, 'reserved')
  h.store.markRequestUnknown = originalMark
  h.store.getRequest = originalGet
  pending.leaseExpiresAt = new Date(Date.now() - 1000).toISOString()
  for (const lease of twitterDeliveryLeases(h.store).values()) if (lease.ownerRequestId === pending.id) lease.expiresAt = pending.leaseExpiresAt
  await h.store.reapStaleReservations()
  assert.equal(pending.status, 'unknown')
  assert.equal(charge.status, 'unknown')
  await assert.rejects(h.invokeData(continuation, 'twitter-retained-after-expiry'), { code: 'request_outcome_unknown' })
  assert.equal(h.calls.length, 1)
  assert.equal(h.platformStore.ingestJobs.length, 1)
  assert.equal(h.platformStore.restrictedResponseArchives.size, 1)
  assert.equal(h.store.requests.get(first.requestId).status, 'committed')
})

test('Twitter fill continues a legacy v3 source buffer without weakening its hash or prior delivered prefix', async () => {
  const rows = (start, count) => Array.from({ length: count }, (_, i) => ({ ...twitterZeroPost, rest_id: String(start + i) }))
  const h = await harness({ platform: 'twitter', twitterData: url => url.searchParams.has('cursor')
    ? twitterTimeline(rows(21, 24), null) : twitterTimeline(rows(1, 24), 'legacy-buffer-bottom') })
  const body = { platform: 'twitter', query: 'fixture', pageSize: 20, type: 'stable' }
  const first = await h.invokeData(body, 'twitter-legacy-buffer-first')
  const saved = structuredClone(first.body)
  delete h.store.requests.get(first.requestId).acquisitionRequest.twitterFill
  const codec = createDataSearchCursorCodec(PEPPER, `${h.context.consumer.id}:${h.context.apiKey.id}`)
  const state = codec.decode(first.body.data.pageInfo.nextCursor)
  const legacyCursor = codec.encode({ ...state, fill: undefined })
  const second = await h.invokeData({ ...body, cursor: legacyCursor }, 'twitter-legacy-buffer-second')
  assert.deepEqual(second.body.data.items.map(row => row.id), Array.from({ length: 20 }, (_, i) => String(i + 21)))
  assert.equal(h.calls.length, 2)
  assert.equal(h.calls[1].searchParams.get('cursor'), 'legacy-buffer-bottom')
  assert.equal(h.calls[1].searchParams.get('count'), '16')
  assert.equal(codec.decode(second.body.data.pageInfo.nextCursor).fill.upstreamPages, 2)
  assert.deepEqual(h.store.requests.get(first.requestId).responseBody, saved)
})

test('Twitter legacy native-only continuation starts durable lineage from its new delivery and conservatively retains the upstream counter', async () => {
  const posts = Array.from({ length: 20 }, (_, i) => ({ ...twitterZeroPost, rest_id: String(i + 1) }))
  const h = await harness({ platform: 'twitter', twitterData: url => twitterTimeline(posts,
    url.searchParams.has('cursor') ? 'legacy-native-next' : 'legacy-native-first') })
  const body = { platform: 'twitter', query: 'fixture', pageSize: 20, type: 'stable' }
  const first = await h.invokeData(body, 'twitter-legacy-native-origin')
  const codec = createDataSearchCursorCodec(PEPPER, `${h.context.consumer.id}:${h.context.apiKey.id}`)
  const state = codec.decode(first.body.data.pageInfo.nextCursor)
  const continued = await h.invokeData({ ...body, cursor: codec.encode({ ...state, fill: undefined, page: 3 }) }, 'twitter-legacy-native-continue')
  assert.equal(continued.body.data.items.length, 20, 'legacy tokens cannot identify earlier deliveries; do not invent a global history scan')
  assert.equal(h.calls.length, 2)
  const newState = codec.decode(continued.body.data.pageInfo.nextCursor)
  assert.equal(newState.fill.upstreamPages, 3)
  assert.equal(newState.fill.previousDeliveryId, continued.requestId)
  assert.equal(h.store.requests.get(continued.requestId).acquisitionRequest.twitterFill.previousDeliveryId, null)
})

test('Twitter automatic fill retains a source projection partial status even when its Bottom is exhausted', async () => {
  const malformed = { rest_id: '2', __typename: 'TweetUnavailable' }
  const h = await harness({ platform: 'twitter', twitterData: twitterTimeline([twitterPost, malformed], null) })
  const result = await h.invokeData({ platform: 'twitter', query: 'fixture', pageSize: 20 }, 'twitter-fill-source-partial')
  assert.equal(result.body.data.items.length, 1)
  assert.equal(result.body.data.pageInfo.hasMore, false)
  assert.equal(result.body.data.status, 'partial')
  assert.ok(result.body.data.warnings.some(warning => warning.code === 'TWITTER_ITEMS_DISCARDED'))
  assert.equal(h.calls.length, 1)
})

test('Twitter pageSize75 requests count50 then only25 while retaining the next source remainder', async () => {
  const h = await harness({ platform: 'twitter', twitterData: url => {
    const page = Number(url.searchParams.get('cursor')?.replace('seventy-five-', '') || 0)
    return twitterTimeline(Array.from({ length: 50 }, (_, i) => ({ ...twitterZeroPost, rest_id: String(page * 50 + i + 1) })), `seventy-five-${page + 1}`)
  } })
  const body = { platform: 'twitter', query: 'fixture', pageSize: 75, type: 'stable' }
  const first = await h.invokeData(body, 'twitter-seventy-five-first')
  assert.equal(first.body.data.items.length, 75)
  assert.deepEqual(h.calls.map(url => url.searchParams.get('count')), ['50', '25'])
  const second = await h.invokeData({ ...body, cursor: first.body.data.pageInfo.nextCursor }, 'twitter-seventy-five-next')
  assert.equal(second.body.data.items.length, 75)
  assert.equal(second.body.data.meta.providerCalls, 1)
  assert.equal(h.calls.length, 3)
  assert.equal(h.calls[2].searchParams.get('count'), '50')
  assert.deepEqual([...first.body.data.items, ...second.body.data.items].map(item => item.id), Array.from({ length: 150 }, (_, i) => String(i + 1)))
})

test('Twitter cancellation or Key revocation between fill steps never dispatches another paid call', async () => {
  for (const scenario of ['cancel', 'revoke']) {
    const posts = Array.from({ length: 5 }, (_, i) => ({ ...twitterZeroPost, rest_id: String(i + 1) }))
    const h = await harness({ platform: 'twitter', twitterData: twitterTimeline(posts, 'next-before-revocation') })
    const controller = new AbortController(), original = h.gateway.adapter.execute.bind(h.gateway.adapter)
    h.gateway.adapter.execute = async (...args) => {
      const result = await original(...args)
      if (scenario === 'cancel') controller.abort()
      else await h.store.revokeApiKey(h.context.apiKey.id)
      return result
    }
    await assert.rejects(h.service.search(h.context, {
      body: { platform: 'twitter', query: 'fixture', pageSize: 20, type: 'stable' },
      idempotencyKey: `twitter-step-${scenario}`, path: '/api/v1/data/search', signal: controller.signal,
    }))
    assert.equal(h.calls.length, 1)
    assert.equal(h.platformStore.restrictedResponseArchives.size, 1)
    assert.equal(h.platformStore.ingestJobs.length, 1)
    assert.equal([...h.store.requests.values()][0].status, 'unknown', 'already paid evidence is retained while no parent page was delivered')
  }
})

test('Twitter X alias standard fill retains its canonical platform and original scoped lineage', async () => {
  const posts = Array.from({ length: 3 }, (_, i) => ({ ...twitterZeroPost, rest_id: String(i + 1) }))
  const h = await harness({ platform: 'twitter', twitterData: twitterTimeline(posts, null) })
  const body = { platform: 'x', query: 'fixture', pageSize: 2, type: 'stable' }
  const first = await h.invokeData(body, 'twitter-x-alias-first')
  const second = await h.invokeData({ ...body, cursor: first.body.data.pageInfo.nextCursor }, 'twitter-x-alias-second')
  assert.equal(first.body.data.platform, 'twitter')
  assert.equal(second.body.data.platform, 'twitter')
  assert.deepEqual([...first.body.data.items, ...second.body.data.items].map(item => item.id), ['1', '2', '3'])
  assert.equal(h.calls.length, 1)
})

test('Twitter standard photo, video and GIF media retain their types without changing raw search media', async () => {
  const photo = twitterPost.legacy.extended_entities.media[0]
  const video = twitterPost.legacy.extended_entities.media[1]
  const gif = { type: 'animated_gif', media_url_https: 'https://example.test/twitter-gif-cover.jpg',
    video_info: { variants: [{ content_type: 'video/mp4', url: 'https://example.test/twitter-gif.mp4' }] } }
  for (const [media, expected] of [
    [photo, { coverUrl: null, images: [photo.media_url_https], videos: [] }],
    [video, { coverUrl: video.media_url_https, images: [], videos: ['https://example.test/twitter-large.mp4'] }],
    [gif, { coverUrl: gif.media_url_https, images: [], videos: ['https://example.test/twitter-gif.mp4'] }],
  ]) {
    const tweet = { ...twitterZeroPost, legacy: { ...twitterZeroPost.legacy, extended_entities: { media: [media] } } }
    const h = await harness({ platform: 'twitter', twitterData: twitterTimeline([tweet]) })
    const result = await h.invokeData()
    assert.ok(isNightAllDataSearchV1Envelope(result.body))
    assert.deepEqual(result.body.data.items[0].media, expected)
    assert.deepEqual(h.platformStore.ingestJobs[0].payload.records[0].stableFields.media, expected)
    const raw = await h.invoke()
    const rawItem = JSON.parse(raw.body.data.raw_data)[0]
    assert.deepEqual(JSON.parse(rawItem.image_urls), [media.media_url_https])
    assert.deepEqual(JSON.parse(rawItem.video_urls), expected.videos)
    assert.equal(h.calls.length, 2)
    assert.equal(h.historical.length, 0)
  }
})

test('Twitter data/search keeps mxds1 continuations scoped to Key, query, size and type through page fifteen', async () => {
  const h = await harness({ platform: 'twitter', twitterData: url => twitterTimeline(Array.from({ length: 10 }, (_, i) => ({
    ...twitterZeroPost, rest_id: String(i + (url.searchParams.has('cursor') ? 11 : 1)),
  })), 'twitter-next-page') })
  const body = { platform: 'twitter', query: '汽车', pageSize: 10, type: 'stable' }
  const first = await h.invokeData(body)
  const cursor = first.body.data.pageInfo.nextCursor
  assert.match(cursor, /^mxds1\./)
  const second = await h.invokeData({ ...body, cursor }, 'twitter-data-page-two')
  assert.ok(isNightAllDataSearchV1Envelope(second.body))
  assert.equal(second.body.data.pageInfo.pageIndex, 2)
  assert.equal(h.calls[1].searchParams.get('cursor'), 'twitter-next-page')
  assert.equal(h.calls[1].searchParams.get('category'), 'Top')
  assert.equal(second.body.data.pageInfo.nextCursor, null) // Repeated provider cursor is terminal.
  for (const patch of [{ query: 'different' }, { pageSize: 20 }, { type: 'fresh' }]) {
    await assert.rejects(h.invokeData({ ...body, ...patch, cursor }, `twitter-invalid-${Object.keys(patch)[0]}`), { code: 'invalid_cursor' })
  }
  const codec = createDataSearchCursorCodec(PEPPER, `${h.context.consumer.id}:${h.context.apiKey.id}`)
  const state = codec.decode(cursor)
  const otherKey = createDataSearchCursorCodec(PEPPER, `${h.context.consumer.id}:other-key`)
  await assert.rejects(h.invokeData({ ...body, cursor: otherKey.encode(state) }, 'twitter-other-key'), { code: 'invalid_cursor' })
  await assert.rejects(h.invoke({ platform: 'twitter', query: body.query, count: body.pageSize, cursor }, 'twitter-data-cursor-in-raw'), { code: 'invalid_cursor' })
  const rawCodec = createRawSearchCursorCodec(PEPPER, `${h.context.consumer.id}:${h.context.apiKey.id}`)
  await assert.rejects(h.invokeData({ ...body, cursor: rawCodec.encode(state) }, 'twitter-raw-cursor-in-data'), { code: 'invalid_cursor' })
  await assert.rejects(h.invokeData({ ...body, cursor: codec.encode({ ...state, expiresAt: Date.now() - 1 }) }, 'twitter-expired-cursor'), { code: 'invalid_cursor' })
  assert.equal(h.calls.length, 2)
  const last = await h.invokeData({ ...body, cursor: codec.encode({ ...state, fill: undefined, page: 15 }) }, 'twitter-data-page-fifteen')
  assert.equal(last.body.data.pageInfo.pageIndex, 15)
  assert.equal(last.body.data.pageInfo.hasMore, false)
  assert.equal(last.body.data.pageInfo.nextCursor, null)
  await assert.rejects(h.invokeData({ ...body, cursor: codec.encode({ ...state, page: 16 }) }, 'twitter-data-page-sixteen'), { code: 'invalid_cursor' })
  assert.equal(h.calls.length, 3)
  assert.equal(h.historical.length, 0)
})

test('Twitter data/search rejects historical mxnc1 and unwrapped provider cursors without calling Night-All', async () => {
  const h = await harness({ platform: 'twitter' })
  const body = { platform: 'twitter', query: '汽车', pageSize: 20 }
  const codec = createNightAllCompatibilityCursorCodec(PEPPER, h.context.consumer.id)
  const traversal = prepareNightAllCompatibilityTraversal({ operation: 'data-search', platform: 'twitter', upstreamBody: body, codec })
  const old = structuredClone(h.oldDataPayload)
  Object.assign(old.data.pageInfo, { hasMore: true, nextCursor: 'night-all-twitter-token', cursorType: 'opaque' })
  const wrapped = capNightAllDataSearchTraversal(old, { platform: 'twitter', page: 1, scope: traversal.scope, codec })
  assert.match(wrapped.data.pageInfo.nextCursor, /^mxnc1\./)
  const cases = [[wrapped.data.pageInfo.nextCursor, 'search_restart_required'], ['night-all-twitter-token', 'invalid_cursor'],
    [`${wrapped.data.pageInfo.nextCursor}tampered`, 'invalid_cursor']]
  for (const [index, [cursor, code]] of cases.entries()) {
    await assert.rejects(h.invokeData({ ...body, cursor }, `twitter-old-cursor-${index}`), { code })
  }
  assert.equal(h.calls.length, 0)
  assert.equal(h.historical.length, 0)
})

test('Twitter legacy mxnc1 continuations replay saved success and retain unknown outcomes after cutover', async () => {
  for (const [type, status] of ['fresh', 'stable'].flatMap(type => ['committed', 'unknown'].map(status => [type, status]))) {
    const h = await harness({ platform: 'twitter', enabled: false })
    const body = { platform: 'twitter', query: '汽车', pageSize: 20 }
    const codec = createNightAllCompatibilityCursorCodec(PEPPER, h.context.consumer.id)
    const traversal = prepareNightAllCompatibilityTraversal({ operation: 'data-search', platform: 'twitter', upstreamBody: body, codec })
    const old = structuredClone(h.oldDataPayload)
    Object.assign(old.data.pageInfo, { hasMore: true, nextCursor: 'night-all-twitter-token', cursorType: 'opaque' })
    const wrapped = capNightAllDataSearchTraversal(old, { platform: 'twitter', page: 1, scope: traversal.scope, codec })
    const requestId = randomUUID()
    await h.store.reserve({ requestId, idempotencyKey: 'data-fixture-first',
      fingerprint: requestFingerprint({ method: 'POST', path: '/api/v1/data/search',
        body: { ...body, cursor: 'night-all-twitter-token', type } }),
      tenantId: h.context.tenant.id, consumerId: h.context.consumer.id, apiKeyId: h.context.apiKey.id,
      platform: 'twitter', unitsReserved: 1, leaseExpiresAt: new Date(Date.now() + 120000),
      windowStart: new Date(Date.now() - 3600000), maxRequests: 100, replayWindowMs: type === 'fresh' ? 120000 : null })
    const savedResponse = { ...h.oldDataPayload, requestId }
    const input = { ...body, type, cursor: wrapped.data.pageInfo.nextCursor }
    if (status === 'committed') {
      await h.store.commitRequest(requestId, { responseStatus: 200, responseBody: savedResponse, unitsActual: 1 })
      assert.deepEqual((await h.invokeData(input)).body, savedResponse)
    } else {
      await h.store.markRequestUnknown(requestId, 'night_all_outcome_unknown')
      h.store.requests.get(requestId).completedAt = new Date(Date.now() - 121000).toISOString()
      await assert.rejects(h.invokeData(input), error => {
        assert.equal(error.code, 'request_outcome_unknown')
        assert.equal(error.details.requestId, requestId)
        return true
      })
    }
    assert.equal(h.store.requests.size, 1)
    assert.equal(h.calls.length, 0)
    assert.equal(h.historical.length, 0)
  }
})

test('Twitter standard page sizes one through one hundred fill from capped provider calls and preserve the requested ceiling', async () => {
  const posts = Array.from({ length: 50 }, (_, index) => ({ ...twitterZeroPost, rest_id: String(1843144227000000100n + BigInt(index)) }))
  const h = await harness({ platform: 'twitter', twitterData: url => {
    const ordinal = Number(url.searchParams.get('cursor')?.replace('twitter-page-', '') || 0)
    return twitterTimeline(posts.map((post, i) => ({ ...post, rest_id: String(ordinal * 50 + i + 1) })), `twitter-page-${ordinal + 1}`)
  } })
  const body = { platform: 'twitter', query: '汽车', pageSize: 100 }
  const first = await h.invokeData(body)
  assert.ok(isNightAllDataSearchV1Envelope(first.body))
  assert.equal(first.body.data.pageInfo.pageSize, 100)
  assert.equal(first.body.data.pageInfo.returnedCount, 100)
  assert.equal(first.body.data.pageInfo.hasMore, true)
  assert.equal(first.body.data.status, 'ok')
  assert.equal(first.body.data.warnings[0].code, 'provider_page_size_limit')
  assert.equal(h.calls[0].searchParams.get('count'), '50')
  assert.equal(h.calls.length, 2)
  assert.equal([...h.store.requests.values()][0].unitsActual, 100)
  const cursor = first.body.data.pageInfo.nextCursor
  for (const pageSize of [50, 99]) {
    await assert.rejects(h.invokeData({ ...body, pageSize, cursor }, `twitter-size-${pageSize}`), { code: 'invalid_cursor' })
  }
  await assert.rejects(h.invokeData({ ...body, pageSize: 101 }, 'twitter-size-over-limit'), { code: 'page_size_exceeded' })
  assert.equal(h.calls.length, 2)
  const second = await h.invokeData({ ...body, cursor }, 'twitter-large-page-two')
  assert.equal(second.body.data.pageInfo.pageIndex, 2)
  assert.equal(second.body.data.pageInfo.pageSize, 100)
  assert.equal(h.calls[1].searchParams.get('count'), '50')
  assert.equal(h.calls.length, 4)
  assert.equal(h.historical.length, 0)
  const one = await harness({ platform: 'twitter', twitterData: twitterTimeline([twitterPost]) })
  const single = await one.invokeData({ ...body, pageSize: 1 })
  assert.equal(single.body.data.pageInfo.pageSize, 1)
  assert.equal(single.body.data.pageInfo.returnedCount, 1)
  assert.deepEqual(single.body.data.warnings, [])
  assert.equal(one.calls[0].searchParams.get('count'), '1')
  assert.equal(one.calls.length, 1)
  assert.equal(one.historical.length, 0)
})

test('Twitter data/search records uncertain dispatch once and never retries it for fresh or stable requests', async () => {
  for (const type of ['fresh', 'stable']) {
    const h = await harness({ platform: 'twitter', searchFails: true })
    const body = { platform: 'twitter', query: '汽车', pageSize: 20, type }
    await assert.rejects(h.invokeData(body), { code: 'social_upstream_outcome_unknown' })
    const usage = [...h.store.requests.values()][0]
    assert.equal(usage.status, 'unknown')
    assert.equal(usage.billingMeterKey, 'twitter')
    usage.completedAt = new Date(Date.now() - 121000).toISOString()
    await assert.rejects(h.invokeData(body), { status: 409, code: 'request_outcome_unknown' })
    assert.equal(h.calls.length, 1)
    assert.equal(h.historical.length, 0)
  }
})

test('Twitter cutover retains old unknown request identity without dispatching either provider', async () => {
  for (const type of ['fresh', 'stable']) {
    const h = await harness({ platform: 'twitter' })
    const body = { platform: 'twitter', query: '汽车', pageSize: 20, type }
    const requestId = randomUUID()
    await h.store.reserve({ requestId, idempotencyKey: 'data-fixture-first',
      fingerprint: requestFingerprint({ method: 'POST', path: '/api/v1/data/search', body }),
      tenantId: h.context.tenant.id, consumerId: h.context.consumer.id, apiKeyId: h.context.apiKey.id,
      platform: 'twitter', unitsReserved: 1, leaseExpiresAt: new Date(Date.now() + 120000),
      windowStart: new Date(Date.now() - 3600000), maxRequests: 100, replayWindowMs: type === 'fresh' ? 120000 : null })
    await h.store.markRequestUnknown(requestId, 'night_all_outcome_unknown')
    h.store.requests.get(requestId).completedAt = new Date(Date.now() - 121000).toISOString()
    await assert.rejects(h.invokeData(body), error => {
      assert.equal(error.code, 'request_outcome_unknown')
      assert.equal(error.details.requestId, requestId)
      return true
    })
    assert.equal(h.store.requests.size, 1)
    assert.equal(h.calls.length, 0)
    assert.equal(h.historical.length, 0)
  }
})

test('Twitter data/search preserves platform admission and empty-result usage without a historical fallback', async () => {
  const empty = await harness({ platform: 'twitter', twitterData: twitterTimeline([]) })
  const result = await empty.invokeData()
  assert.ok(isNightAllDataSearchV1Envelope(result.body))
  assert.deepEqual(result.body.data.items, [])
  assert.equal(result.body.data.pageInfo.returnedCount, 0)
  assert.equal([...empty.store.requests.values()][0].unitsActual, 1)
  assert.equal(empty.historical.length, 0)
  const revoked = await harness({ platform: 'twitter' })
  await revoked.store.setPlatformGrant(revoked.context.consumer.id, 'twitter', false)
  await assert.rejects(revoked.invokeData(), { code: 'platform_not_granted' })
  const paused = await harness({ platform: 'twitter', enabled: false })
  await assert.rejects(paused.invokeData(), /operation/i)
  for (const h of [revoked, paused]) {
    assert.equal(h.calls.length, 0)
    assert.equal(h.historical.length, 0)
  }
})

test('Facebook cutover cannot fall back through the old raw gateway', async () => {
  const h = await harness({ platform: 'facebook' })
  await assert.rejects(h.invoke(), { code: 'raw_search_unavailable' })
  assert.equal(h.historical.length, 0)
  assert.equal(h.calls.length, 0)
  const before = structuredClone(h.oldPayload)
  assert.deepEqual(rawSearchContentTitles(before, 'xiaohongshu'), before)
  assert.equal(JSON.parse(rawSearchContentTitles(before, 'facebook').data.raw_data)[0].title, '')
  assert.deepEqual(h.oldPayload, before)
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
  for (const [platform, type] of ['weibo', 'twitter'].flatMap(platform => ['fresh', 'stable'].map(type => [platform, type]))) {
    const h = await harness({ platform, enabled: false })
    const body = { platform, query: '汽车', pageSize: 20, type }
    const requestId = randomUUID()
    await h.store.reserve({ requestId, idempotencyKey: 'data-fixture-first',
      fingerprint: requestFingerprint({ method: 'POST', path: '/api/v1/data/search', body }),
      tenantId: h.context.tenant.id, consumerId: h.context.consumer.id, apiKeyId: h.context.apiKey.id,
      platform, unitsReserved: 1, leaseExpiresAt: new Date(Date.now() + 120000),
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

test('Weibo small pages use Hub enrichment and historical continuations require an explicit restart', async () => {
  for (const platform of ['weibo']) {
    const h = await harness({ platform })
    const before = structuredClone(h.oldDataPayload)
    const result = await h.invokeData({ platform, query: '汽车', pageSize: 10 })
    assert.equal(result.body.data.items[0].title, null)
    assert.equal(result.body.data.items[0].text, FULL)
    assert.deepEqual(h.oldDataPayload, before)
    assert.equal(h.historical.length, 0)
    assert.equal(h.calls.length, 2)
  }
  const h = await harness({ platform: 'weibo' })
  const body = { platform: 'weibo', query: '汽车', pageSize: 20 }
  const codec = createNightAllCompatibilityCursorCodec(PEPPER, h.context.consumer.id)
  const traversal = prepareNightAllCompatibilityTraversal({ operation: 'data-search', platform: 'weibo', upstreamBody: body, codec })
  const old = structuredClone(h.oldDataPayload)
  Object.assign(old.data.pageInfo, { hasMore: true, nextCursor: 'old-night-all-token', cursorType: 'opaque' })
  const wrapped = capNightAllDataSearchTraversal(old, { platform: 'weibo', page: 1, scope: traversal.scope, codec })
  await assert.rejects(h.invokeData({ ...body, cursor: wrapped.data.pageInfo.nextCursor }), error => error.code === 'search_restart_required')
  assert.equal(h.historical.length, 0)
  assert.equal(h.calls.length, 0)
})

test('Instagram list-only account results deliver zero posts without quarantining later searches or losing the paid receipt', async () => {
  // Reconstructed from the operator's field-type report; contains no production account values.
  const account = { id: '12345', pk: '12345', username: 'account-result', full_name: 'Account result' }
  const upstream = { status: 'ok', list: [{ position: 0, user: account }],
    has_more: false, rank_token: 'rank'.repeat(19) + 'xx' }
  for (const route of ['data', 'raw']) {
    const h = await harness({ platform: 'instagram', instagramData: upstream })
    const invoke = route === 'data' ? h.invokeData : h.invoke
    const body = route === 'data' ? { platform: 'instagram', query: 'fixture', pageSize: 20 }
      : { platform: 'instagram', query: 'fixture', count: 20 }
    const response = await invoke(body, 'instagram-account-list')
    assert.equal(response.body.data.status, 'ok')
    assert.deepEqual(route === 'data' ? response.body.data.items : JSON.parse(response.body.data.raw_data), [])
    const page = route === 'data' ? response.body.data.pageInfo : response.body.data.page
    assert.equal(page.returnedCount, 0)
    assert.equal(page.hasMore, false)
    assert.equal(page.nextCursor, null)
    if (route === 'data') assert.equal(isNightAllDataSearchV1Envelope(response.body), true)
    assert.equal(h.platformStore.restrictedResponseArchives.size, 1)
    const call = [...h.platformStore.calls.values()][0]
    assert.equal(call.outcome, 'succeeded')
    assert.equal(call.billed, true)
    assert.equal(call.errorCode, null)
    assert.deepEqual((await invoke(body, 'instagram-account-list')).body, response.body)
    assert.equal(h.calls.length, 1)
    // A distinct keyword can dispatch; the account-only result did not open quarantine.
    await invoke({ ...body, query: 'next fixture' }, 'instagram-account-next')
    assert.equal(h.calls.length, 2)
    assert.equal(h.historical.length, 0)
    assert.deepEqual(upstream.list[0].user, account)
  }
})

test('Instagram list media retain captions and IDs while an account-only page retains a bound continuation', async () => {
  const instagramData = { status: 'ok', list: [{ user: { id: '123', username: 'account-result' } }],
    has_more: true, next_max_id: 'list-next', rank_token: 'list-rank' }
  const h = await harness({ platform: 'instagram', instagramData })
  const body = { platform: 'instagram', query: 'fixture', pageSize: 20 }
  const first = await h.invokeData(body, 'instagram-list-page1')
  assert.deepEqual(first.body.data.items, [])
  assert.equal(first.body.data.pageInfo.hasMore, true)
  assert.equal(isNightAllDataSearchV1Envelope(first.body), true)
  instagramData.list.push({ media: instagramPost }, instagramPost)
  instagramData.has_more = false
  const second = await h.invokeData({ ...body, cursor: first.body.data.pageInfo.nextCursor }, 'instagram-list-page2')
  assert.equal(second.body.data.items.length, 1)
  assert.equal(second.body.data.items[0].externalId, instagramPost.pk)
  assert.equal(second.body.data.items[0].title, null)
  assert.equal(second.body.data.items[0].text, instagramPost.caption.text)
  assert.equal(second.body.data.pageInfo.hasMore, false)
  assert.equal(h.calls[1].searchParams.get('next_max_id'), 'list-next')
  assert.equal(h.calls[1].searchParams.get('rank_token'), 'list-rank')
  assert.equal(h.calls.length, 2)
})

test('Instagram non-post-only lists without a cursor return an explicit partial page, retain receipts and do not quarantine other queries', async () => {
  // Field types from the 2026-10-12 archive; hashtag contents were not disclosed.
  for (const recommendation of [{ position: 0, hashtag: {} },
    { position: 0, place: { location: { pk: '123', name: 'fixture-place' } } },
    { position: 0, user: { id: '123', username: 'account-result' } }]) {
    for (const route of ['data', 'raw']) {
      const upstream = { status: 'ok', list: [recommendation], has_more: true, rank_token: 'r'.repeat(78) }
      const before = structuredClone(upstream)
      const h = await harness({ platform: 'instagram', instagramData: upstream })
      const invoke = route === 'data' ? h.invokeData : h.invoke
      const body = route === 'data' ? { platform: 'instagram', query: 'fixture', pageSize: 20 }
        : { platform: 'instagram', query: 'fixture', count: 20 }
      const response = await invoke(body, 'instagram-non-post-list')
      assert.equal(response.body.data.status, 'partial')
      assert.deepEqual(route === 'data' ? response.body.data.items : JSON.parse(response.body.data.raw_data), [])
      const page = route === 'data' ? response.body.data.pageInfo : response.body.data.page
      assert.equal(page.returnedCount, 0)
      assert.equal(page.hasMore, false)
      assert.equal(page.nextCursor, null)
      assert.deepEqual(response.body.data.warnings.map(warning => warning.code), ['INSTAGRAM_NON_POST_CONTINUATION_UNAVAILABLE'])
      assert.match(response.body.data.warnings[0].message, /completeness is unknown/)
      assert.doesNotMatch(response.body.data.warnings[0].message, /Weibo|undefined/)
      if (route === 'data') assert.equal(isNightAllDataSearchV1Envelope(response.body), true)
      const call = [...h.platformStore.calls.values()][0]
      assert.equal(call.outcome, 'succeeded')
      assert.equal(call.billed, true)
      assert.equal(call.errorCode, null)
      assert.equal(h.platformStore.restrictedResponseArchives.size, 1)
      assert.deepEqual((await invoke(body, 'instagram-non-post-list')).body, response.body)
      assert.equal(h.calls.length, 1)
      await invoke({ ...body, query: 'another fixture' }, 'instagram-after-non-post-list')
      assert.equal(h.calls.length, 2)
      assert.equal(h.historical.length, 0)
      assert.deepEqual(upstream, before)
    }
  }
})

test('Instagram hashtag lists preserve real continuations and mixed media on both contracts', async () => {
  for (const route of ['data', 'raw']) {
    const instagramData = { status: 'ok', list: [{ position: 0, hashtag: { name: 'fixture' } }],
      has_more: true, next_max_id: 'hashtag-next', rank_token: 'hashtag-rank' }
    const h = await harness({ platform: 'instagram', instagramData })
    const invoke = route === 'data' ? h.invokeData : h.invoke
    const body = { platform: 'instagram', query: 'fixture', pageSize: 20 }
    const first = await invoke(body, 'hashtag-page-1')
    const page = route === 'data' ? first.body.data.pageInfo : first.body.data.page
    assert.equal(first.body.data.status, 'ok')
    assert.equal(page.returnedCount, 0)
    assert.equal(page.hasMore, true)
    assert.ok(page.nextCursor)
    instagramData.list.push({ media: instagramPost })
    instagramData.has_more = false
    const second = await invoke({ ...body, cursor: page.nextCursor }, 'hashtag-page-2')
    const items = route === 'data' ? second.body.data.items : JSON.parse(second.body.data.raw_data)
    assert.equal(items.length, 1)
    assert.equal(route === 'data' ? items[0].externalId : items[0].content_id, instagramPost.pk)
    assert.equal(items[0].text, instagramPost.caption.text)
    assert.equal(h.calls[1].searchParams.get('next_max_id'), 'hashtag-next')
    assert.equal(h.calls[1].searchParams.get('rank_token'), 'hashtag-rank')
    assert.equal(h.calls.length, 2)
  }
})

test('Instagram grouped recommendations keep both delivery contracts, receipts, idempotency and post continuations', async () => {
  for (const route of ['data', 'raw']) {
    for (const group of [{ users: [{ pk: '123', username: 'fixture' }] },
      { hashtags: [{ name: 'fixture' }] }, { places: [{ location: {} }] },
      { other_results: { keyword_recommendations: { keywords: [{ name: 'fixture' }] } } }]) {
      const instagramData = { status: 'ok', ...group, has_more: true, rank_token: 'fixture-rank' }
      const h = await harness({ platform: 'instagram', instagramData })
      const invoke = route === 'data' ? h.invokeData : h.invoke
      const body = { platform: 'instagram', query: 'fixture', pageSize: 20 }
      const response = await invoke(body, 'grouped-partial')
      assert.equal(response.body.data.status, 'partial')
      assert.equal(response.body.data.warnings[0].code, 'INSTAGRAM_NON_POST_CONTINUATION_UNAVAILABLE')
      assert.deepEqual((await invoke(body, 'grouped-partial')).body, response.body)
      assert.equal(h.calls.length, 1)
      assert.equal([...h.platformStore.calls.values()][0].billed, true)
      assert.equal([...h.platformStore.calls.values()][0].outcome, 'succeeded')
      assert.equal(h.platformStore.restrictedResponseArchives.size, 1)
      instagramData.next_max_id = 'grouped-next'
      const first = await invoke({ ...body, query: 'another-fixture' }, 'grouped-page-1')
      const page = route === 'data' ? first.body.data.pageInfo : first.body.data.page
      assert.equal(page.hasMore, true)
      instagramData.items = [instagramPost]
      instagramData.list = [{ media: { ...instagramPost, pk: '98765', code: 'second' } }]
      instagramData.has_more = false
      const second = await invoke({ ...body, query: 'another-fixture', cursor: page.nextCursor }, 'grouped-page-2')
      assert.equal(route === 'data' ? second.body.data.items.length : JSON.parse(second.body.data.raw_data).length, 2)
      assert.equal(h.calls.length, 3)
      assert.equal(h.calls[2].searchParams.get('next_max_id'), 'grouped-next')
      assert.equal(h.calls[2].searchParams.get('rank_token'), 'fixture-rank')
      assert.equal(h.historical.length, 0)
      if (route === 'data') assert.ok(isNightAllDataSearchV1Envelope(second.body))
    }
  }
})

test('Instagram partial recommendation pages keep HTTP raw-alias replay and strict data-search delivery', async t => {
  const h = await harness({ platform: 'instagram', instagramData: { status: 'ok',
    list: [{ position: 0, hashtag: {} }], has_more: true, rank_token: 'r'.repeat(78) } })
  const server = createServer(createApp({ service: h.service, store: h.store, adapter: {},
    adminToken: null, listenerMode: 'public', logger: { warn() {}, error() {} } }))
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  let first
  for (const path of ['/api/v1/search/raw', RAW_SEARCH_PATH, '/api/v1/data/search']) {
    const dataSearch = path === '/api/v1/data/search'
    const response = await fetch(base + path, { method: 'POST', headers: {
      Authorization: `Bearer ${h.key.secret}`, 'content-type': 'application/json',
      'idempotency-key': dataSearch ? 'instagram-data-partial' : 'instagram-raw-partial' },
    body: JSON.stringify({ platform: 'instagram', query: 'fixture', ...(dataSearch ? { pageSize: 20 } : { count: 20 }) }) })
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.data.status, 'partial')
    assert.equal(body.data.warnings[0].code, 'INSTAGRAM_NON_POST_CONTINUATION_UNAVAILABLE')
    if (dataSearch) assert.ok(isNightAllDataSearchV1Envelope(body))
    else if (first) {
      assert.deepEqual(body, first)
      assert.equal(h.calls.length, 1)
    } else first = body
  }
  assert.equal(h.historical.length, 0)
})

test('Instagram empty keyword suggestions remain empty; malformed and incomplete continuation shapes fail without fallback or retry', async () => {
  const empty = await harness({ platform: 'instagram', instagramData: { status: 'ok',
    other_results: { keyword_recommendations: { keywords: [{ id: '123', name: 'popular term' }] } } } })
  assert.deepEqual((await empty.invokeData()).body.data.items, [])
  for (const [data, reason] of [[{ unexpected: true }, 'invalid_instagram_search_shape'],
    [{ items: [instagramPost], has_more: true }, 'missing_instagram_continuation'],
    [{ items: [instagramPost], next_max_id: 'valid', rank_token: { unexpected: 'shape' } }, 'invalid_instagram_continuation'],
    [{ items: [instagramPost], has_more: 'unexpected-value' }, 'invalid_instagram_pagination'],
    [{ items: [{ ...instagramPost, pk: 9007199254740992 }] }, 'invalid_instagram_post_identity'],
    [{ media_grid: { sections: [{ layout_content: { medias: {} } }] } }, 'invalid_instagram_media_grid'],
    [{ items: [null] }, 'invalid_instagram_post_identity'],
    [{ status: 'ok', list: [{ user: { pk: '123', username: 'name' }, caption: 'malformed post' }], has_more: false }, 'invalid_instagram_search_shape'],
    [{ status: 'ok', list: [{ user: { pk: '123', username: 'name' }, media: null }], has_more: false }, 'invalid_instagram_search_shape'],
    [{ status: 'ok', list: [{ name: 'unrecognized result' }], has_more: false }, 'invalid_instagram_search_shape'],
    [{ status: 'ok', list: [null], has_more: false }, 'invalid_instagram_search_shape'],
    [{ status: 'ok', list: [], has_more: true }, 'missing_instagram_continuation'],
    [{ status: 'ok', list: [{ hashtag: {} }, { media: instagramPost }], has_more: true }, 'missing_instagram_continuation'],
    [{ status: 'ok', list: [{ hashtag: {}, media: null }], has_more: true }, 'invalid_instagram_search_shape'],
    [{ status: 'ok', list: [{ hashtag: {}, caption: 'malformed post' }] }, 'invalid_instagram_search_shape'],
    [{ status: 'ok', list: [{ hashtag: {}, media: { caption: 'missing identity' } }] }, 'invalid_instagram_post_identity'],
    [{ status: 'ok', list: [{ hashtag: {}, user: {} }] }, 'invalid_instagram_search_shape'],
    [{ status: 'ok', list: [{ hashtag: {}, place: {} }] }, 'invalid_instagram_search_shape'],
    ...[null, [], 'topic'].map(hashtag => [{ status: 'ok', list: [{ hashtag }] }, 'invalid_instagram_search_shape']),
    [{ status: 'ok', list: [{ hashtag: {} }, { unknown: 'shape' }] }, 'invalid_instagram_search_shape'],
    [{ status: 'ok', list: [{ hashtag: {} }], has_more: true, next_max_id: 123 }, 'invalid_instagram_continuation'],
    [{ status: 'ok', list: [{ hashtag: {} }], has_more: true, rank_token: {} }, 'invalid_instagram_continuation'],
    [{ status: 'ok', list: [{ hashtag: {} }], has_more: 'unexpected' }, 'invalid_instagram_pagination'],
    [{ status: 'ok', list: [], items: {} }, 'invalid_instagram_search_shape'],
    [{ status: 'ok', list: [], media_grid: {} }, 'invalid_instagram_search_shape'],
    [{ status: 'fail', list: [] }, 'invalid_instagram_search_shape'],
    [{ list: [] }, 'invalid_instagram_search_shape'],
  ]) {
    const h = await harness({ platform: 'instagram', instagramData: data })
    await assert.rejects(h.invokeData())
    await assert.rejects(h.invokeData())
    assert.equal(h.calls.length, 1)
    assert.equal(h.historical.length, 0)
    assert.equal(h.platformStore.restrictedResponseArchives.size, 1)
    assert.equal([...h.platformStore.calls.values()][0].outcome, 'succeeded_unusable')
    assert.equal([...h.platformStore.calls.values()][0].errorCode, reason)
  }
})

test('Instagram splits a paid oversized page losslessly on raw/data routes before advancing the upstream cursor', async () => {
  for (const route of ['invoke', 'invokeData']) {
    const rows = Array.from({ length: 41 }, (_, i) => ({ ...instagramPost, pk: String(i + 1) }))
    const data = { status: 'ok', items: rows, list: [{ media: rows[0] }],
      has_more: true, next_max_id: 'next-upstream', rank_token: 'first-rank' }
    const h = await harness({ platform: 'instagram', instagramData: url => url.searchParams.has('next_max_id')
      ? { items: [{ ...instagramPost, pk: '42' }], has_more: false } : data })
    const body = route === 'invoke' ? { platform: 'instagram', query: 'fixture', count: 20 }
      : { platform: 'instagram', query: 'fixture', pageSize: 20 }
    const page = response => response.body.data.pageInfo || response.body.data.page
    const ids = response => route === 'invoke' ? JSON.parse(response.body.data.raw_data).map(row => row.content_id)
      : response.body.data.items.map(row => row.id)
    const first = await h[route](body, 'overflow-page-1')
    const receipt = Buffer.from([...h.platformStore.restrictedResponseArchives.values()][0].bodyBytes)
    const second = await h[route]({ ...body, cursor: page(first).nextCursor }, 'overflow-page-2')
    const replay = await h[route]({ ...body, cursor: page(first).nextCursor }, 'overflow-page-2')
    assert.deepEqual(replay.body, second.body)
    const third = await h[route]({ ...body, cursor: page(second).nextCursor }, 'overflow-page-3')
    assert.deepEqual([ids(first).length, ids(second).length, ids(third).length], [20, 20, 1])
    assert.deepEqual([...ids(first), ...ids(second), ...ids(third)], rows.map(row => row.pk))
    assert.equal(h.calls.length, 1)
    assert.equal(h.platformStore.calls.size, 1)
    assert.equal([...h.platformStore.calls.values()][0].itemCount, 41)
    assert.equal(h.store.requests.get(first.requestId).unitsActual, route === 'invokeData' ? 20 : 1)
    assert.equal(h.store.requests.get(third.requestId).unitsActual, 1)
    assert.equal(h.platformStore.ingestJobs.length, 1)
    assert.equal(h.platformStore.ingestJobs[0].payload.records.filter(row => row.objectType === 'post').length, 41)
    assert.equal(second.body.data.meta.providerCalls ?? second.body.data.meta.upstreamCallCount, 0)
    assert.ok(receipt.equals(Buffer.from([...h.platformStore.restrictedResponseArchives.values()][0].bodyBytes)))
    const fourth = await h[route]({ ...body, cursor: page(third).nextCursor }, 'overflow-page-4')
    assert.equal(h.calls.length, 2)
    assert.equal(h.calls[1].searchParams.get('next_max_id'), 'next-upstream')
    assert.equal(h.calls[1].searchParams.get('rank_token'), 'first-rank')
    assert.deepEqual(ids(fourth), ['42'])
    assert.equal(page(fourth).hasMore, false)
    assert.equal(h.historical.length, 0)
    if (route === 'invokeData') for (const result of [first, second, third, fourth]) assert.ok(isNightAllDataSearchV1Envelope(result.body))
  }
})

test('Instagram terminal oversized pages preserve all rows, and missing/corrupt buffers never reacquire upstream', async () => {
  const data = { items: Array.from({ length: 21 }, (_, i) => ({ ...instagramPost, pk: String(i + 1) })), has_more: false }
  for (const corruption of [null, 'missing', 'bytes', 'hash', 'identity', 'failed']) {
    const h = await harness({ platform: 'instagram', instagramData: data })
    const first = await h.invokeData()
    const cursor = first.body.data.pageInfo.nextCursor
    const [callId, archive] = [...h.platformStore.restrictedResponseArchives][0]
    if (corruption === 'missing') h.platformStore.restrictedResponseArchives.delete(callId)
    if (corruption === 'bytes') archive.bodyBytes[0] = 0
    if (corruption === 'hash') archive.bodySha256 = '0'.repeat(64)
    if (corruption === 'identity') h.store.requests.get(first.requestId).apiKeyId = randomUUID()
    if (corruption === 'failed') h.platformStore.calls.get(callId).outcome = 'succeeded_unusable'
    const invoke = () => h.invokeData({ platform: 'instagram', query: '汽车', pageSize: 20, cursor }, 'buffer-next-page')
    if (corruption) await assert.rejects(invoke(), { code: 'search_page_unavailable' })
    else {
      const last = await invoke()
      assert.equal(last.body.data.items.length, 1)
      assert.equal(last.body.data.pageInfo.hasMore, false)
      assert.equal(last.body.data.pageInfo.nextCursor, null)
    }
    assert.equal(h.calls.length, 1)
  }
})

test('Instagram buffer cursors retain route/query/Key/expiry and current grant/page-size boundaries', async () => {
  const h = await harness({ platform: 'instagram', instagramData: { items: Array.from({ length: 21 }, (_, i) => ({ ...instagramPost, pk: String(i + 1) })) } })
  const first = await h.invokeData()
  const cursor = first.body.data.pageInfo.nextCursor
  const body = { platform: 'instagram', query: '汽车', pageSize: 20, cursor }
  const otherKey = await h.service.createApiKey({ consumerId: h.context.consumer.id, name: 'Second original scope', platforms: ['instagram'], capabilities: [] })
  const otherContext = await h.service.authenticate(otherKey.secret)
  await assert.rejects(h.service.search(otherContext, { body, idempotencyKey: 'buffer-other-key', path: '/api/v1/data/search' }), { code: 'invalid_cursor' })
  await assert.rejects(h.invokeData({ ...body, query: 'another' }, 'buffer-query-change'), { code: 'invalid_cursor' })
  await assert.rejects(h.invoke({ platform: 'instagram', query: '汽车', count: 20, cursor }, 'buffer-route-change'), { code: 'invalid_cursor' })
  const codec = createDataSearchCursorCodec(PEPPER, `${h.context.consumer.id}:${h.context.apiKey.id}`)
  const state = codec.decode(cursor)
  for (const patch of [{ expiresAt: 1 }, { buffer: { ...state.buffer, offset: 21 } },
    { buffer: { ...state.buffer, callId: 'bad' } }, { buffer: { ...state.buffer, unexpected: true } }]) {
    await assert.rejects(h.invokeData({ ...body, cursor: codec.encode({ ...state, ...patch }) }, randomUUID()), { code: 'invalid_cursor' })
  }
  await assert.rejects(h.invokeData({ ...body, cursor: codec.encode({ ...state, buffer: { ...state.buffer, hash: '0'.repeat(64) } }) }, 'buffer-drift'), { code: 'search_page_unavailable' })
  h.store.apiKeyPlatformEntitlements.get(h.context.apiKey.id)[0].maxPageSize = 10
  await assert.rejects(h.invokeData(body, 'buffer-lower-entitlement'), { code: 'page_size_exceeded' })
  await h.store.setPlatformGrant(h.context.consumer.id, 'instagram', false)
  await assert.rejects(h.invokeData(body, 'buffer-revoked-grant'), { code: 'platform_not_granted' })
  assert.equal(h.calls.length, 1)
})

test('Instagram buffered pages keep customer per-request charges and settle exact replays only once', async () => {
  const h = await harness({ platform: 'instagram', instagramData: { items: Array.from({ length: 21 }, (_, i) => ({ ...instagramPost, pk: String(i + 1) })) } })
  await h.service.setTenantBillingProfile(h.context.tenant.id,
    { mode: 'enforced', multiplierPpm: 1000000, defaultUnitPriceMinor: 1, defaultCurrency: 'CNY' }, 'test-admin')
  await h.service.addTenantCredit(h.context.tenant.id, { amountMinor: 100, currency: 'CNY', reason: 'Offline pagination fixture' },
    { idempotencyKey: 'pagination-credit', actor: 'test-admin' })
  const first = await h.invokeData()
  const body = { platform: 'instagram', query: '汽车', pageSize: 20, cursor: first.body.data.pageInfo.nextCursor }
  const second = await h.invokeData(body, 'buffer-paid-second')
  assert.deepEqual((await h.invokeData(body, 'buffer-paid-second')).body, second.body)
  assert.equal(h.calls.length, 1)
  const charges = [...h.store.customerCharges.values()]
  assert.equal(charges.length, 2)
  assert.ok(charges.every(charge => charge.chargedMinor === 1 && charge.meterKey === 'instagram'))
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
  for (const platform of ['weibo', 'twitter']) {
    const h = await harness({ platform, twitterData: twitterTimeline([twitterPost, twitterZeroPost]),
      rows: [{ ...preview, content: FULL }, { ...preview, weibo_id: '5351726865449967', content: FULL }] })
    const plan = await h.service.publishPlanVersion({ key: 'data-search-paid', name: 'Offline platform price',
      limits: { monthlyRequests: 10000, maxPageSize: 100, burstRps: 100 },
      priceBook: { key: 'data-search-paid', currency: 'CNY', defaultMultiplierPpm: 1000000,
        entries: [{ meterKey: platform, billingUnit: 'request', unitPriceMinor: 9 }] } }, 'test-admin')
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
    assert.equal(charges[0].meterKey, platform)
    assert.equal(charges[0].chargedMinor, 9)
    const key = h.store.apiKeyPlatformEntitlements.get(h.context.apiKey.id)[0]
    key.maxPageSize = 10
    await assert.rejects(h.invokeData(undefined, 'data-limit-exceeded'), { code: 'page_size_exceeded' })
    assert.equal(h.calls.length, 1)
    await h.store.setPlatformGrant(h.context.consumer.id, platform, false)
    await assert.rejects(h.invokeData(), { code: 'platform_not_granted' })
    assert.equal(h.calls.length, 1)
    assert.equal(h.historical.length, 0)
  }
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


test('raw and data-search forward cancellation through Hub routing before generic admission', async () => {
  const h = await harness()
  const controller = new AbortController()
  const observed = []
  const cancelled = async (_context, input) => {
    observed.push(input.signal)
    assert.equal(input.signal, controller.signal)
    assert.equal(input.signal.aborted, true)
    throw new AppError(499, 'request_cancelled', 'Request cancelled before dispatch')
  }
  h.service.externalRawSearch = cancelled
  h.service.externalDataSearch = cancelled
  controller.abort()
  await assert.rejects(h.service.nightAllCompatibilitySearch(h.context, { operation: 'raw', body: BODY,
    path: RAW_SEARCH_PATH, idempotencyKey: 'raw-cancel-routing', signal: controller.signal }), { code: 'request_cancelled' })
  await assert.rejects(h.service.search(h.context, { body: { platform: 'weibo', query: '汽车', pageSize: 20 },
    path: '/api/v1/data/search', idempotencyKey: 'data-cancel-routing', signal: controller.signal }), { code: 'request_cancelled' })
  assert.equal(observed.length, 2)
  assert.equal(h.calls.length, 0)
})

test('Instagram shared and contract circuits explain the active blocker without dispatch or state changes', async t => {
  for (const provider of ['justone', 'tikhub']) for (const route of ['invoke', 'invokeData']) {
    for (const contractActive of [false, true]) await t.test(`${provider}/${route}/${contractActive ? 'contract' : 'shared'}`, async () => {
      const h = await harness({ platform: 'instagram', instagramProvider: provider })
      h.config.circuitFailureThreshold = 3
      const sharedUntil = new Date(Date.now() + (contractActive ? -60000 : 60000)).toISOString()
      const contractUntil = new Date(Date.now() + (contractActive ? 30000 : -30000)).toISOString()
      Object.assign(h.platformStore.state, { consecutiveFailures: 3, circuitOpenUntil: sharedUntil,
        lastErrorCode: 'upstream_rate_limited' })
      h.platformStore.contractCircuits.set('instagram', { scope: 'instagram', consecutiveFailures: 3,
        circuitOpenUntil: contractUntil, lastErrorCode: 'private_contract_failure' })
      const beforeShared = structuredClone(h.platformStore.state)
      const beforeContract = structuredClone(h.platformStore.contractCircuits.get('instagram'))
      await assert.rejects(h[route]({ platform: 'instagram', query: 'circuit fixture', pageSize: 20 }, 'instagram-circuit'), error => {
        assert.equal(error.status, 503)
        assert.equal(error.code, 'external_platform_circuit_open')
        assert.equal(error.message, 'Instagram 搜索暂时受保护，请保留请求 ID 核查原因。')
        assert.equal(error.details.upstreamDispatched, false)
        assert.equal(error.details.scope, contractActive ? 'platform_contract' : 'shared_upstream')
        assert.equal(error.details.reason, contractActive ? 'response_contract_unusable' : 'upstream_rate_limited')
        assert.equal(error.details.circuitOpenUntil, contractActive ? contractUntil : sharedUntil)
        assert.ok(error.details.retryAfterMs > 0 && error.details.retryAfterMs <= (contractActive ? 30000 : 60000))
        assert.equal(error.details.failureThreshold, 3)
        assert.equal(error.details.retryable, false)
        assert.ok(h.store.requests.has(error.details.requestId))
        assert.doesNotMatch(JSON.stringify(error.details), /justone|tikhub|private_contract_failure|fixture-secret/u)
        return true
      })
      assert.equal(h.calls.length, 0)
      assert.equal(h.historical.length, 0)
      assert.equal(h.platformStore.calls.size, 0)
      assert.equal(h.platformStore.requests.at(-1).sourceMode, 'circuit_rejected')
      assert.deepEqual(h.platformStore.state, beforeShared)
      assert.deepEqual(h.platformStore.contractCircuits.get('instagram'), beforeContract)
    })
  }
})

test('Instagram circuit diagnostics do not replace an immutable saved upstream rejection', async () => {
  for (const route of ['invoke', 'invokeData']) {
    const h = await harness({ platform: 'instagram', instagramProvider: 'justone', justOneCode: 400 })
    const body = { platform: 'instagram', query: 'saved rejection', pageSize: 20 }
    await assert.rejects(h[route](body, 'instagram-saved-rejection'))
    const [call] = [...h.platformStore.calls.values()]
    const usage = h.store.requests.get(call.usageRequestId)
    const before = structuredClone(usage)
    Object.assign(h.platformStore.state, { consecutiveFailures: 3,
      circuitOpenUntil: new Date(Date.now() + 60000).toISOString(), lastErrorCode: 'upstream_rate_limited' })
    await assert.rejects(h[route](body, 'instagram-saved-rejection'), error => {
      assert.equal(error.status, before.responseStatus)
      assert.equal(error.code, before.responseBody.error.code)
      assert.equal(error.message, before.responseBody.error.message)
      assert.deepEqual(error.details, before.responseBody.error.details)
      return true
    })
    assert.deepEqual(h.store.requests.get(call.usageRequestId), before)
    assert.equal(h.calls.length, 1)
    assert.equal(h.platformStore.calls.size, 1)
    assert.equal(h.historical.length, 0)
  }
})

test('JustOne Instagram standard/raw routing preserves grants, customer meters and one immutable receipt', async () => {
  for (const route of ['invoke', 'invokeData']) {
    const h = await harness({ platform: 'instagram', instagramProvider: 'justone' })
    await h.service.setTenantBillingProfile(h.context.tenant.id,
      { mode: 'enforced', multiplierPpm: 1000000, defaultUnitPriceMinor: 3, defaultCurrency: 'CNY' }, 'test-admin')
    await h.service.addTenantCredit(h.context.tenant.id, { amountMinor: 100, currency: 'CNY', reason: 'Offline JustOne fixture' },
      { idempotencyKey: 'justone-credit', actor: 'test-admin' })
    const body = { platform: 'instagram', query: '#fashion/中文 &+', pageSize: 10 }
    const first = await h[route](body, 'justone-instagram-first')
    assert.equal(first.status, 200)
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].origin, 'https://api.justoneapi.com')
    assert.equal(h.calls[0].pathname, '/api/instagram/general-search/v1')
    assert.deepEqual(Object.fromEntries(h.calls[0].searchParams), { token: 'fixture-secret', keyword: body.query, paginationToken: '' })
    const item = route === 'invokeData' ? first.body.data.items[0] : JSON.parse(first.body.data.raw_data)[0]
    assert.equal(item.text, instagramPost.caption.text)
    assert.deepEqual((await h[route](body, 'justone-instagram-first')).body, first.body)
    assert.equal(h.calls.length, 1)
    const call = [...h.platformStore.calls.values()][0]
    assert.equal(call.providerKey, 'justone')
    assert.equal(call.operation, `native.${JUSTONE_INSTAGRAM_SEARCH_KEY}`)
    assert.equal(call.businessCode, 0)
    assert.equal(call.outcome, 'succeeded')
    assert.equal(h.platformStore.restrictedResponseArchives.size, 1)
    assert.equal(h.platformStore.ingestJobs.length, 1)
    const charges = [...h.store.customerCharges.values()]
    assert.equal(classifyExternalPlatformIngest(h.platformStore.ingestJobs[0].payload).hubRaw, true)
    assert.equal(charges.length, 1)
    assert.equal(charges[0].chargedMinor, 3)
    assert.equal(charges[0].meterKey, route === 'invokeData' ? 'instagram' : 'raw')
    assert.equal(h.historical.length, 0)
  }
})

test('JustOne Instagram buffers oversized pages without extra purchases then passes the exact opaque token', async () => {
  for (const route of ['invoke', 'invokeData']) {
    const rows = Array.from({ length: 41 }, (_, i) => ({ ...instagramPost, pk: String(i + 1) }))
    const h = await harness({ platform: 'instagram', instagramProvider: 'justone', instagramData: url => url.searchParams.get('paginationToken')
      ? { data: { count: 1, items: [{ ...instagramPost, pk: '42' }] }, pagination_token: null }
      : { data: { count: rows.length, items: rows }, pagination_token: 'next+opaque/=中文' } })
    const body = { platform: 'instagram', query: 'fixture', pageSize: 20 }
    const page = response => response.body.data.pageInfo || response.body.data.page
    const ids = response => route === 'invoke' ? JSON.parse(response.body.data.raw_data).map(row => row.content_id) : response.body.data.items.map(row => row.id)
    const first = await h[route](body, 'justone-overflow-first')
    const secondBody = { ...body, cursor: page(first).nextCursor }
    const second = await h[route](secondBody, 'justone-overflow-second')
    assert.deepEqual((await h[route](secondBody, 'justone-overflow-second')).body, second.body)
    const third = await h[route]({ ...body, cursor: page(second).nextCursor }, 'justone-overflow-third')
    assert.deepEqual([...ids(first), ...ids(second), ...ids(third)], rows.map(row => row.pk))
    assert.equal(h.calls.length, 1)
    assert.equal(h.platformStore.ingestJobs.length, 1)
    assert.equal(h.platformStore.ingestJobs[0].payload.records.filter(row => row.objectType === 'post').length, 41)
    const fourth = await h[route]({ ...body, cursor: page(third).nextCursor }, 'justone-overflow-fourth')
    assert.deepEqual(ids(fourth), ['42'])
    assert.equal(page(fourth).hasMore, false)
    assert.equal(h.calls.length, 2)
    assert.equal(h.calls[1].searchParams.get('paginationToken'), 'next+opaque/=中文')
    assert.equal(h.historical.length, 0)
  }
})

test('Instagram cutover replays TikHub deliveries exactly but retires old cursors before any new purchase', async () => {
  for (const route of ['invoke', 'invokeData']) {
    for (const buffered of [false, true]) {
      const h = await harness({ platform: 'instagram', hasMore: true,
        ...(buffered ? { instagramData: { items: Array.from({ length: 41 }, (_, i) => ({ ...instagramPost, pk: String(i + 1) })) } } : {}) })
      const body = { platform: 'instagram', query: 'fixture', pageSize: 20 }
      const first = await h[route](body, 'precutover-first')
      const cursor = (first.body.data.pageInfo || first.body.data.page).nextCursor
      const continuedBody = { ...body, cursor }
      const second = await h[route](continuedBody, 'precutover-second')
      const j = await harness({ platform: 'instagram', instagramProvider: 'justone' })
      j.gateway.usageStore = h.store
      j.platformStore.usageStore = h.store
      h.service.externalRawSearch = (context, input) => j.gateway.searchRaw(context, input)
      h.service.externalDataSearch = (context, input) => j.gateway.searchRaw(context, input)
      assert.deepEqual((await h[route](body, 'precutover-first')).body, first.body)
      assert.deepEqual((await h[route](continuedBody, 'precutover-second')).body, second.body)
      await assert.rejects(h[route](continuedBody, 'postcutover-old-cursor'), { code: 'search_restart_required', status: 409 })
      assert.equal(j.calls.length, 0)
      await h[route](body, 'postcutover-first')
      assert.equal(j.calls.length, 1)
      assert.equal(h.calls.length, buffered ? 1 : 2)
      assert.equal(h.historical.length, 0)
    }
  }
})

test('JustOne Instagram rejects unavailable, malformed and uncertain requests without TikHub or Night-All fallback', async () => {
  for (const route of ['invoke', 'invokeData']) {
    for (const options of [{ justOneCode: 400 }, { searchFails: true }, { instagramData: { unexpected: [] } }, { enabled: false }]) {
      const h = await harness({ platform: 'instagram', instagramProvider: 'justone', ...options })
      const first = await h[route]().catch(error => error)
      assert.ok(first.status >= 400)
      assert.equal(h.calls.length, options.enabled === false ? 0 : 1)
      if (options.instagramData) {
        const call = [...h.platformStore.calls.values()][0]
        assert.equal(call.businessCode, 0)
        assert.equal(call.billed, true)
        assert.equal(call.outcome, 'succeeded_unusable')
        assert.equal(h.platformStore.restrictedResponseArchives.size, 1)
      }
      await h[route]().catch(() => {})
      assert.equal(h.calls.length, options.enabled === false ? 0 : 1)
      assert.equal(h.historical.length, 0)
    }
    const h = await harness({ platform: 'instagram', instagramProvider: 'justone' })
    h.service.externalRawSearch = null
    h.service.externalDataSearch = null
    await assert.rejects(h[route](), { code: 'instagram_search_unavailable' })
    assert.equal(h.historical.length, 0)
    assert.equal(h.calls.length, 0)
  }
})

async function instagramStrategyHarness({ justone = {}, tikhub = {}, policy = {} } = {}) {
  const j = await harness({ platform: 'instagram', instagramProvider: 'justone', ...justone })
  const t = await harness({ platform: 'instagram', instagramProvider: 'tikhub', ...tikhub })
  t.gateway.usageStore = j.store
  t.platformStore.usageStore = j.store
  const policyStore = new StrategySearchRoutingStore()
  const gateways = { justone: j.gateway, tikhub: t.gateway }
  const setPolicy = async patch => policyStore.update('search', 'instagram', {
    mode: 'fixed', primaryProvider: 'justone', fallbackProvider: null,
    expectedRevision: (await policyStore.get('search', 'instagram')).revision,
    reason: 'Offline strategy fixture', ...patch,
  })
  if (Object.keys(policy).length) await setPolicy(policy)
  j.service.externalRawSearch = j.service.externalDataSearch = (context, input) => j.gateway.searchRaw(context, input, { policyStore, gateways })
  // PostgreSQL enforces one active procurement hold per usage request across
  // suppliers. Separate memory stores must not hide overlapping fallback holds.
  for (const current of [j, t]) {
    const reserve = current.platformStore.reserveProviderCostWorkflow.bind(current.platformStore)
    current.platformStore.reserveProviderCostWorkflow = async input => {
      if ([j, t].some(h => [...h.platformStore.costReservations.values()].some(row => row.status === 'active'
        && row.usageRequestId === input.usageRequestId))) {
        throw new AppError(409, 'external_platform_cost_reservation_exists', 'Fixture mirrors PostgreSQL active usage uniqueness')
      }
      return reserve(input)
    }
  }
  return { ...j, providers: { justone: j, tikhub: t }, policyStore, setPolicy }
}

const instagramPage = response => response.body.data.pageInfo || response.body.data.page
const instagramBody = { platform: 'instagram', query: 'strategy fixture', pageSize: 20 }

test('Instagram strategy fixed TikHub uses the original customer meter and one shared reservation', async () => {
  for (const route of ['invoke', 'invokeData']) {
    const h = await instagramStrategyHarness({ policy: { primaryProvider: 'tikhub' } })
    await h.service.setTenantBillingProfile(h.context.tenant.id,
      { mode: 'enforced', multiplierPpm: 1000000, defaultUnitPriceMinor: 3, defaultCurrency: 'CNY' }, 'test-admin')
    await h.service.addTenantCredit(h.context.tenant.id, { amountMinor: 100, currency: 'CNY', reason: 'Offline strategy fixture' },
      { idempotencyKey: 'strategy-credit', actor: 'test-admin' })
    const body = { ...instagramBody, pageSize: 10 }
    const first = await h[route](body, 'strategy-fixed-tikhub')
    assert.equal(first.status, 200)
    assert.equal(h.providers.justone.calls.length, 0)
    assert.equal(h.providers.tikhub.calls.length, 1)
    assert.equal(h.store.requests.size, 1)
    const charges = [...h.store.customerCharges.values()]
    assert.equal(charges.length, 1)
    assert.equal(charges[0].chargedMinor, 3)
    assert.equal(charges[0].meterKey, route === 'invoke' ? 'raw' : 'instagram')
    assert.deepEqual((await h[route](body, 'strategy-fixed-tikhub')).body, first.body)
    assert.equal(h.providers.tikhub.calls.length, 1)
  }
})

test('Instagram strategy provider-pinned cursors retain buffers and upstream tokens across default changes', async () => {
  for (const route of ['invoke', 'invokeData']) {
    for (const provider of ['justone', 'tikhub']) {
      const rows = Array.from({ length: 41 }, (_, i) => ({ ...instagramPost, pk: String(i + 1) }))
      const h = await instagramStrategyHarness({ policy: { primaryProvider: provider },
        justone: { instagramData: url => url.searchParams.get('paginationToken')
          ? { data: { count: 1, items: [{ ...instagramPost, pk: '42' }] }, pagination_token: null }
          : { data: { count: 41, items: rows }, pagination_token: 'justone-opaque-next' } },
        tikhub: { instagramData: url => url.searchParams.get('next_max_id')
          ? { items: [{ ...instagramPost, pk: '42' }], more_available: false }
          : { items: rows, more_available: true, next_max_id: 'tikhub-opaque-next', rank_token: 'tikhub-rank' } },
      })
      const first = await h[route](instagramBody, 'strategy-pin-first')
      const codec = (route === 'invoke' ? createRawSearchCursorCodec : createDataSearchCursorCodec)(PEPPER, `${h.context.consumer.id}:${h.context.apiKey.id}`)
      assert.equal(codec.decode(instagramPage(first).nextCursor).provider, provider)
      const other = provider === 'justone' ? 'tikhub' : 'justone'
      await h.setPolicy({ primaryProvider: other })
      const secondBody = { ...instagramBody, cursor: instagramPage(first).nextCursor }
      const second = await h[route](secondBody, 'strategy-pin-second')
      assert.deepEqual((await h[route](secondBody, 'strategy-pin-second')).body, second.body)
      const third = await h[route]({ ...instagramBody, cursor: instagramPage(second).nextCursor }, 'strategy-pin-third')
      assert.equal(h.providers[provider].calls.length, 1)
      assert.equal(h.providers[other].calls.length, 0)
      assert.equal(h.providers[provider].platformStore.ingestJobs.length, 1)
      assert.equal(h.providers[provider].platformStore.ingestJobs[0].payload.records.filter(row => row.objectType === 'post').length, 41)
      const fourth = await h[route]({ ...instagramBody, cursor: instagramPage(third).nextCursor }, 'strategy-pin-fourth')
      assert.equal(instagramPage(fourth).hasMore, false)
      assert.equal(h.providers[provider].calls.length, 2)
      assert.equal(h.providers[other].calls.length, 0)
      const query = h.providers[provider].calls[1].searchParams
      assert.equal(query.get(provider === 'justone' ? 'paginationToken' : 'next_max_id'), `${provider}-opaque-next`)
      if (provider === 'tikhub') assert.equal(query.get('rank_token'), 'tikhub-rank')
      assert.equal(h.historical.length, 0)
    }
  }
})

test('Instagram strategy priority falls back only before dispatch with one customer settlement', async () => {
  for (const route of ['invoke', 'invokeData']) {
    for (const blocker of ['disabled', 'local-rate-limit']) {
      const h = await instagramStrategyHarness({ justone: { enabled: blocker !== 'disabled' },
        policy: { mode: 'priority', primaryProvider: 'justone', fallbackProvider: 'tikhub' } })
      if (blocker === 'local-rate-limit') h.providers.justone.platformStore.acquireProviderRateLimit = async () => ({ allowed: false, retryAfterMs: 1000 })
      await h.service.setTenantBillingProfile(h.context.tenant.id,
        { mode: 'enforced', multiplierPpm: 1000000, defaultUnitPriceMinor: 3, defaultCurrency: 'CNY' }, 'test-admin')
      await h.service.addTenantCredit(h.context.tenant.id, { amountMinor: 100, currency: 'CNY', reason: 'Offline fallback fixture' },
        { idempotencyKey: 'strategy-fallback-credit', actor: 'test-admin' })
      const first = await h[route](instagramBody, 'strategy-priority-first')
      assert.equal(first.status, 200)
      assert.equal(h.providers.justone.calls.length, 0)
      assert.equal(h.providers.tikhub.calls.length, 1)
      assert.equal(h.store.requests.size, 1)
      assert.equal(h.store.customerCharges.size, 1)
      assert.equal([...h.store.customerCharges.values()][0].chargedMinor, 3)
      assert.deepEqual((await h[route](instagramBody, 'strategy-priority-first')).body, first.body)
      assert.equal(h.providers.tikhub.calls.length, 1)
      assert.ok(Object.values(h.providers).every(p => [...p.platformStore.costReservations.values()].every(hold => hold.status !== 'active')))
    }
  }
})

test('Instagram strategy priority never retries upstream rejection, paid unusable or unknown outcomes', async () => {
  for (const route of ['invoke', 'invokeData']) {
    for (const justone of [{ justOneCode: 400 }, { searchFails: true }, { instagramData: { unexpected: [] } }]) {
      const h = await instagramStrategyHarness({ justone,
        policy: { mode: 'priority', primaryProvider: 'justone', fallbackProvider: 'tikhub' } })
      const first = await h[route](instagramBody, 'strategy-failed-first').catch(error => error)
      assert.ok(first.status >= 400)
      await h[route](instagramBody, 'strategy-failed-first').catch(() => {})
      assert.equal(h.providers.justone.calls.length, 1)
      assert.equal(h.providers.tikhub.calls.length, 0)
      assert.equal(h.store.requests.size, 1)
      if (justone.searchFails) assert.equal([...h.store.requests.values()][0].status, 'unknown')
      if (justone.instagramData) assert.equal([...h.platformStore.calls.values()][0].billed, true)
    }
  }
})

test('Instagram strategy pause and configuration database failure preserve exact saved replay', async () => {
  for (const route of ['invoke', 'invokeData']) {
    const h = await instagramStrategyHarness()
    const first = await h[route](instagramBody, 'strategy-replay-first')
    await h.setPolicy({ mode: 'paused' })
    assert.deepEqual((await h[route](instagramBody, 'strategy-replay-first')).body, first.body)
    await assert.rejects(h[route](instagramBody, 'strategy-paused-new'), { code: 'strategy_search_paused' })
    let reads = 0
    h.policyStore.get = async () => { reads++; throw new AppError(503, 'strategy_search_route_unavailable', 'Fixture database unavailable') }
    assert.deepEqual((await h[route](instagramBody, 'strategy-replay-first')).body, first.body)
    assert.equal(reads, 0)
    await assert.rejects(h[route](instagramBody, 'strategy-database-new'), { code: 'strategy_search_route_unavailable' })
    assert.equal(reads, 1)
    assert.equal(h.providers.justone.calls.length, 1)
    assert.equal(h.providers.tikhub.calls.length, 0)
  }
})

test('Instagram strategy cannot substitute a provider for pinned unavailable continuations or missing buffers', async () => {
  for (const route of ['invoke', 'invokeData']) {
    for (const missingBuffer of [false, true]) {
      const h = await instagramStrategyHarness({ justone: { hasMore: true,
        ...(missingBuffer ? { instagramData: { data: { count: 21,
          items: Array.from({ length: 21 }, (_, i) => ({ ...instagramPost, pk: String(i + 1) })) }, pagination_token: null } } : {}) } })
      const first = await h[route](instagramBody, 'strategy-protected-first')
      const cursor = instagramPage(first).nextCursor
      await h.setPolicy({ mode: 'priority', primaryProvider: 'tikhub', fallbackProvider: 'justone' })
      if (missingBuffer) h.platformStore.restrictedResponseArchives.clear()
      else h.gateway.adapter = null
      await assert.rejects(h[route]({ ...instagramBody, cursor }, 'strategy-protected-next'),
        missingBuffer ? { code: 'search_page_unavailable' } : error => error.status >= 400)
      assert.equal(h.providers.justone.calls.length, 1)
      assert.equal(h.providers.tikhub.calls.length, 0)
    }
  }
})

test('Instagram strategy retires untagged historical cursors while retaining their immutable deliveries', async () => {
  for (const route of ['invoke', 'invokeData']) {
    for (const buffered of [false, true]) {
      const h = await instagramStrategyHarness({ tikhub: { hasMore: true,
        ...(buffered ? { instagramData: { items: Array.from({ length: 41 }, (_, i) => ({ ...instagramPost, pk: String(i + 1) })) } } : {}) } })
      const strategy = h.service.externalRawSearch
      h.service.externalRawSearch = h.service.externalDataSearch = (context, input) => h.providers.tikhub.gateway.searchRaw(context, input)
      const first = await h[route](instagramBody, 'strategy-historical-first')
      const nextBody = { ...instagramBody, cursor: instagramPage(first).nextCursor }
      const second = await h[route](nextBody, 'strategy-historical-second')
      h.service.externalRawSearch = h.service.externalDataSearch = strategy
      await h.setPolicy({ primaryProvider: 'tikhub' })
      assert.deepEqual((await h[route](instagramBody, 'strategy-historical-first')).body, first.body)
      assert.deepEqual((await h[route](nextBody, 'strategy-historical-second')).body, second.body)
      await assert.rejects(h[route](nextBody, 'strategy-retired-new'), { status: 409, code: 'search_restart_required' })
      assert.equal(h.providers.justone.calls.length, 0)
      assert.equal(h.providers.tikhub.calls.length, buffered ? 1 : 2)
    }
  }
})

test('Instagram strategy stops after one unavailable backup and never treats control database faults as fallback permission', async () => {
  for (const route of ['invoke', 'invokeData']) {
    for (const fault of ['both-disabled', 'control-database']) {
      const h = await instagramStrategyHarness({ justone: { enabled: false }, tikhub: { enabled: false },
        policy: { mode: 'priority', primaryProvider: 'justone', fallbackProvider: 'tikhub' } })
      let backupAttempts = 0
      const forward = h.providers.tikhub.gateway.searchRaw.bind(h.providers.tikhub.gateway)
      h.providers.tikhub.gateway.searchRaw = (...args) => { backupAttempts++; return forward(...args) }
      if (fault === 'control-database') h.controls.authorizeDispatch = async () => { throw new Error('fixture control database fault') }
      await assert.rejects(h[route](instagramBody, 'strategy-availability-first'))
      assert.equal(backupAttempts, fault === 'both-disabled' ? 1 : 0)
      assert.equal(h.providers.justone.calls.length, 0)
      assert.equal(h.providers.tikhub.calls.length, 0)
      assert.equal(h.store.requests.size, 1)
      assert.equal([...h.store.requests.values()][0].status, 'released')
    }
  }
})

test('Instagram strategy unknown replay is resolved before reading changed or unavailable policy', async () => {
  for (const route of ['invoke', 'invokeData']) {
    const h = await instagramStrategyHarness({ justone: { searchFails: true },
      policy: { mode: 'priority', primaryProvider: 'justone', fallbackProvider: 'tikhub' } })
    await assert.rejects(h[route](instagramBody, 'strategy-unknown-first'))
    let reads = 0
    h.policyStore.get = async () => { reads++; throw new Error('fixture policy database fault') }
    await assert.rejects(h[route](instagramBody, 'strategy-unknown-first'), { code: 'request_outcome_unknown' })
    assert.equal(reads, 0)
    assert.equal(h.providers.justone.calls.length, 1)
    assert.equal(h.providers.tikhub.calls.length, 0)
    assert.equal([...h.store.requests.values()][0].status, 'unknown')
  }
})

test('Instagram strategy cannot bypass an equal unknown or paid unusable dispatch via a primary-provider circuit', async () => {
  for (const route of ['invoke', 'invokeData']) {
    for (const justone of [{ searchFails: true }, { instagramData: { unexpected: [] } }]) {
      const h = await instagramStrategyHarness({ justone,
        policy: { mode: 'priority', primaryProvider: 'justone', fallbackProvider: 'tikhub' } })
      h.platformStore.circuitFailureThreshold = 1
      await assert.rejects(h[route](instagramBody, 'strategy-circuit-unresolved'))
      const providerState = await h.platformStore.providerState()
      const contractState = await h.platformStore.contractCircuitState('justone', 'instagram')
      assert.ok(providerState?.circuitOpenUntil || contractState?.circuitOpenUntil)
      await assert.rejects(h[route](instagramBody, 'strategy-circuit-different-key'), {
        code: justone.searchFails ? 'request_outcome_unknown' : 'external_platform_response_unusable',
      })
      assert.equal(h.providers.justone.calls.length, 1)
      assert.equal(h.providers.tikhub.calls.length, 0)
      assert.equal([...h.store.requests.values()][0].status, justone.searchFails ? 'unknown' : 'committed')
      // Unknown protection is query-specific. Contract quarantine also blocks
      // different queries until the existing endpoint guard permits dispatch.
      const other = h[route]({ ...instagramBody, query: 'different strategy fixture' }, 'strategy-circuit-other-query')
      if (justone.searchFails) assert.equal((await other).status, 200)
      else await assert.rejects(other, { code: 'external_platform_response_unusable' })
      assert.equal(h.providers.tikhub.calls.length, justone.searchFails ? 1 : 0)
      assert.equal(h.platformStore.leases.size, 0)
    }
  }
})

test('Instagram strategy holds the primary dispatch lease until its backup finishes', async () => {
  for (const route of ['invoke', 'invokeData']) {
    const h = await instagramStrategyHarness({ justone: { enabled: false },
      policy: { mode: 'priority', primaryProvider: 'justone', fallbackProvider: 'tikhub' } })
    let signalStarted, release
    const started = new Promise(resolve => { signalStarted = resolve })
    const waiting = new Promise(resolve => { release = resolve })
    const adapter = h.providers.tikhub.gateway.adapter
    const original = adapter.forwardNative.bind(adapter)
    adapter.forwardNative = async (...args) => { signalStarted(); await waiting; return original(...args) }
    const leader = h[route](instagramBody, 'strategy-concurrent-leader')
    await started
    try {
      assert.equal(h.platformStore.leases.size, 1)
      await assert.rejects(h[route](instagramBody, 'strategy-concurrent-follower'), { code: 'request_in_progress' })
      assert.equal(h.providers.tikhub.platformStore.calls.size, 1)
    } finally { release() }
    assert.equal((await leader).status, 200)
    assert.equal(h.platformStore.leases.size, 0)
    assert.equal(h.providers.tikhub.platformStore.leases.size, 0)
    assert.equal(h.providers.tikhub.calls.length, 1)
  }
})
