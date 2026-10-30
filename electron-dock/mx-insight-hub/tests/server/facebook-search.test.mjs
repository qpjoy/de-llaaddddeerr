import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { createApp } from '../../server/app.mjs'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'
import { JustOneAdapter } from '../../server/adapters/justone.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore, PostgresExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { createExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { FACEBOOK_ENDPOINT, FACEBOOK_OPERATION, FACEBOOK_JUSTONE_KEY, facebookRow, facebookRowV1, facebookStandardMedia,
  normalizeFacebookSearch } from '../../server/contracts/facebook-search.mjs'
import { isNightAllDataSearchV1Envelope } from '../../server/contracts/night-all-data-search.mjs'
import { createDataSearchCursorCodec, createRawSearchCursorCodec } from '../../server/external-platforms/cursor.mjs'
import { requestFingerprint } from '../../server/core/crypto.mjs'
import { PlatformSearchPolicyStore, rapidQuotaObservation } from '../../server/external-platforms/platform-search-policy.mjs'
import { migrateFacebookCredentials } from '../../scripts/migrate-facebook-credentials.mjs'
import { facebookQuotaFixture } from '../helpers/facebook-quota.mjs'

const PEPPER = 'facebook-offline-test-pepper-at-least-32-characters'
const ADMIN = 'facebook-offline-admin-token-at-least-32-characters'
const post = { post_id: '123_456', message: '完整内容\n' + '正文'.repeat(1000), timestamp: 1791597600,
  author: { id: '123', name: 'Author' }, reactions_count: 0, comments_count: 2, video_files: { hd: 'https://example.test/movie' } }
const fixturePosts = (start, count) => Array.from({ length: count }, (_, index) => ({ ...post, post_id: `post-${start + index}` }))
const facebookResponse = (provider, posts, cursor = null, status = 200) => provider === 'rapidapi'
  ? Response.json({ results: posts, cursor }, { status, headers: { 'x-ratelimit-requests-remaining': status === 429 ? '0' : '999',
    'x-ratelimit-requests-reset': '172800' } })
  : Response.json({ code: 0, message: 'success', requestId: 'upstream-justone', recordTime: '2026-10-10T00:00:00Z',
    data: { business_data: posts, cursor } }, { status })
const invokeStandard = (h, body, idempotencyKey, signal) => h.service.search(h.context,
  { body, idempotencyKey, signal, path: '/api/v1/data/search' })
const invokeV2 = (h, body, idempotencyKey) => h.service.search(h.context,
  { body, idempotencyKey, path: '/api/v2/data/search' })
const v2FacebookBody = () => ({ platform: 'facebook', query: 'v2 exact window', pageSize: 20,
  timeWindow: { from: '2026-10-16T16:00:00.000Z', to: '2026-10-17T16:00:00.000Z', timezone: 'Asia/Shanghai', boundary: '[from,to)' } })

test('v2 Facebook uses the real acquisition/archive pipeline, filters only delivery, and permanently replays one paid attempt', async () => {
  const input = v2FacebookBody(), h = await harness({ posts: [
    { ...post, post_id: 'from', timestamp: Date.parse(input.timeWindow.from) / 1000 },
    { ...post, post_id: 'to', timestamp: Date.parse(input.timeWindow.to) / 1000 },
    { ...post, post_id: 'missing', timestamp: null },
  ] })
  const first = await invokeV2(h, input, 'v2-facebook-first-key')
  assert.deepEqual(first.body.data.items.map(item => item.id), ['from'])
  assert.equal(h.calls[0].url.searchParams.get('start_date'), '2026-10-17')
  assert.equal(h.calls[0].url.searchParams.get('end_date'), '2026-10-18')
  const saved = await h.usage.getUsageRequestByIdempotencyKey(h.context.consumer.id, 'v2-facebook-first-key')
  assert.equal(saved.responseBody.data.items.length, 3)
  assert.equal(saved.acquisitionRequest.body.type, 'stable')
  assert.equal(saved.responseBody.data.contractVersion, 'night-all.data-search.v1')
  assert.equal(first.body.data.contractVersion, 'mx-insight-hub.data-search.v2')
  h.usage.requests.get(saved.id).completedAt = '2026-01-01T00:00:00Z'
  const replay = await invokeV2(h, input, 'v2-facebook-first-key')
  assert.deepEqual(replay.body, first.body)
  assert.equal(replay.replay, true)
  assert.equal(h.calls.length, 1)
  await assert.rejects(() => invokeStandard(h, { platform: 'facebook', query: input.query, pageSize: 20,
    params: { startDate: '2026-10-17', endDate: '2026-10-18' }, type: 'stable' }, 'v2-facebook-first-key'), error => error.code === 'idempotency_conflict')
  const status = await h.service.requestStatus(h.context, saved.id)
  assert.equal(status.status, 'committed')
  assert.equal(status.searchProtocol.deliveryConfirmed, true)
})

test('v2 Facebook continues an empty filtered page from the same paid archive and rejects either cross-version cursor', async () => {
  const input = v2FacebookBody(), posts = fixturePosts(0, 25).map((item, index) => ({ ...item,
    timestamp: Date.parse(index < 20 ? '2026-10-01T00:00:00Z' : input.timeWindow.from) / 1000 }))
  const h = await harness({ posts })
  const first = await invokeV2(h, input, 'v2-buffer-first-key')
  assert.equal(first.body.data.items.length, 0)
  assert.equal(first.body.data.pageInfo.hasMore, true)
  const cursor = first.body.data.pageInfo.nextCursor
  assert.ok(cursor.startsWith('mxds2.'))
  await assert.rejects(() => invokeStandard(h, { platform: 'facebook', query: input.query, cursor }, 'v1-wrong-cursor-key'), error => error.code === 'invalid_cursor')
  const second = await invokeV2(h, { ...input, cursor }, 'v2-buffer-second-key')
  assert.equal(second.body.data.items.length, 5)
  assert.equal(second.body.data.pageInfo.hasMore, false)
  assert.equal(h.calls.length, 1)
  const firstRaw = await h.usage.getUsageRequestByIdempotencyKey(h.context.consumer.id, 'v2-buffer-first-key')
  await assert.rejects(() => invokeV2(h, { ...input, cursor: firstRaw.responseBody.data.pageInfo.nextCursor }, 'v2-v1-cursor-key'), error => error.code === 'invalid_cursor')
  const replay = await invokeV2(h, { ...input, cursor }, 'v2-buffer-second-key')
  assert.deepEqual(replay.body, second.body)
  assert.equal(h.calls.length, 1)
})

test('an old v1 Facebook unknown cannot become a v2 acquisition by changing key, dates or age', async () => {
  const input = v2FacebookBody(), h = await harness({ rapidStatus: 'timeout' })
  await assert.rejects(() => invokeStandard(h, { platform: 'facebook', query: input.query, pageSize: 20 }, 'old-v1-unknown-key'))
  for (const row of h.usage.requests.values()) row.reservedAt = '2026-01-01T00:00:00Z'
  await assert.rejects(() => invokeV2(h, input, 'new-v2-bypass-key'), error => error.code === 'request_outcome_unknown')
  await assert.rejects(() => invokeV2(h, { ...input, timeWindow: { ...input.timeWindow, from: '2026-09-01T00:00:00Z' } }, 'new-v2-other-window'), error => error.code === 'request_outcome_unknown')
  assert.equal(h.calls.length, 1)
})

test('a v2 Facebook unknown blocks v1 and v2 new keys without changing the original usage evidence', async () => {
  const input = v2FacebookBody(), h = await harness({ rapidStatus: 'timeout' })
  await assert.rejects(() => invokeV2(h, input, 'first-v2-unknown-key'))
  const old = structuredClone([...h.usage.requests.values()][0])
  await assert.rejects(() => invokeStandard(h, { platform: 'facebook', query: input.query }, 'v1-downgrade-key'), error => error.code === 'request_outcome_unknown')
  await assert.rejects(() => invokeV2(h, input, 'v2-new-bypass-key'), error => error.code === 'request_outcome_unknown')
  assert.deepEqual(h.usage.requests.get(old.id), old)
  assert.equal(h.calls.length, 1)
  const status = await h.service.requestStatusByIdempotencyKey(h.context, 'first-v2-unknown-key')
  assert.equal(status.searchProtocol.state, 'unknown')
  assert.equal(status.searchProtocol.deliveryConfirmed, false)
})

test('v2 Facebook projection failure reports unresolved delivery while original acquisition remains committed', async () => {
  const input = v2FacebookBody(), h = await harness()
  const original = h.service.externalDataSearch
  h.service.externalDataSearch = async (...args) => {
    const result = await original(...args)
    return { ...result, body: { ...result.body, data: { ...result.body.data, pageInfo: null } } }
  }
  await assert.rejects(() => invokeV2(h, input, 'v2-projection-lost-key'), error => error.code === 'request_outcome_unknown')
  const status = await h.service.requestStatusByIdempotencyKey(h.context, 'v2-projection-lost-key')
  assert.equal(status.status, 'committed')
  assert.equal(status.searchProtocol.state, 'unknown')
  await assert.rejects(() => invokeV2(h, input, 'v2-projection-lost-key'), error => error.code === 'request_outcome_unknown')
  assert.equal(h.calls.length, 1)
})

// Independent pre-calibration fixture. Do not generate a legacy cursor hash
// from the current projector: old paid buffers bind the exact v1 row JSON.
function frozenFacebookRowV1(post, capturedAt) {
  const text = value => typeof value === 'string' ? value : ''
  const metric = value => value != null && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null
  const timestamp = value => {
    if (value == null || value === '') return null
    const result = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value)
    return Number.isFinite(result.getTime()) ? result.toISOString() : null
  }
  const id = post.post_id ?? post.postId ?? post.id, author = post.author || post.user || {}
  const urls = values => [...new Set(values.flat().map(v => typeof v === 'string' ? v : v?.uri || v?.url).filter(Boolean))]
  const images = urls([post.image, ...(post.album_preview || []), post.video_thumbnail].filter(Boolean))
  const files = post.video_files && !Array.isArray(post.video_files) ? Object.values(post.video_files) : post.video_files || []
  const videos = urls([post.video, ...files].filter(Boolean)), content = text(post.message ?? post.text ?? post.content)
  return { ...post, content_id: String(id), platform_name: 'facebook', title: '', text: content, content, full_text: content,
    url: text(post.url ?? post.post_url), author_id: String(author.id ?? post.author_id ?? ''),
    author_name: text(author.name ?? post.author_title), author_avatar_url: text(author.profile_picture_url),
    created_at: timestamp(post.timestamp ?? post.created_at), collected_at: capturedAt,
    like_count: metric(post.reactions_count), comment_count: metric(post.comments_count), forward_count: metric(post.reshare_count),
    view_count: metric(post.video_view_count), image_urls: JSON.stringify(images), video_urls: JSON.stringify(videos) }
}
const rowsDigest = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex')

async function harness({ rapidStatus = 200, mode = 'auto', quotaAllowed = true, malformed = false, hasMore = false,
  posts = [post], policyStore: suppliedPolicy, pool = null, respond = null } = {}) {
  const usage = pool ? new PostgresStore(pool) : new MemoryStore(), calls = [], stores = {}, gateways = {}, observations = []
  let oldCalls = 0
  const service = new HubService({ store: usage, apiKeyPepper: PEPPER, adapter: {
    async legacySearch() { oldCalls++; throw new Error('Facebook must not reach Night-All') },
    async search() { oldCalls++; throw new Error('Facebook must not reach Night-All') },
  } })
  const tenant = await service.createTenant({ name: 'Facebook fixture' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Facebook fixture' })
  await service.putPlatformConfiguration('facebook', { tenantId: tenant.id, consumerId: consumer.id, enabled: true, maxRequests: 1000, windowSeconds: 3600, maxPageSize: 100 })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Facebook', platforms: ['facebook'], capabilities: [] })
  const context = await service.authenticate(key.secret)
  const controls = createExternalPlatformControlStore({ pool })
  const policy = { mode, monthly_limit: 1000, probe_interval_hours: 72, revision: 1 }
  const policyStore = suppliedPolicy || { facebook: async () => policy,
    admitRapid: async () => ({ allowed: quotaAllowed, token: 'fixture' }),
    observeRapid: async (_, value) => observations.push(value) }
  for (const provider of ['rapidapi', 'justone']) {
    const endpointKey = provider === 'rapidapi' ? FACEBOOK_ENDPOINT : `native.${FACEBOOK_JUSTONE_KEY}`
    const operation = provider === 'rapidapi' ? FACEBOOK_OPERATION.operationKey : endpointKey
    const config = { configured: true, contractVerified: true, dispatchEnabled: true, timeoutMs: 1000,
      freshTtlMs: 60000, staleTtlMs: 86400000, maxConcurrency: 3, maxConsumerConcurrency: 3, maxRequestsPerMinute: 100 }
    const current = (await controls.describeProvider(provider, { config, credentialConfigured: true })).find(row => row.operationKey === operation)
    await controls.updatePolicy(provider, operation, { expectedRevision: current.revision, desiredState: 'active', reason: 'Offline Facebook fixture',
      priceBook: { currency: provider === 'rapidapi' ? 'USD' : 'CNY', pricingAsOf: '2026-10-10T00:00:00Z',
        monthlyBudgetMinor: 100000, monthlySubsidyBudgetMinor: 100000, unitCostMinorByEndpoint: { [endpointKey]: provider === 'rapidapi' ? 0 : 1 } } },
    { runtime: { config, credentialConfigured: true } })
    const fetchImpl = async url => {
      calls.push({ provider, url: new URL(url) })
      if (respond) return respond({ provider, url: new URL(url), ordinal: calls.length, calls })
      if (provider === 'rapidapi') {
        if (rapidStatus === 'timeout') throw new Error('synthetic transport loss')
        return Response.json(malformed ? { unexpected: true } : { results: posts, cursor: hasMore ? 'private-upstream-cursor' : null },
          { status: rapidStatus, headers: { 'x-ratelimit-requests-remaining': rapidStatus === 429 ? '0' : '999', 'x-ratelimit-requests-reset': '172800' } })
      }
      return Response.json({ code: 0, message: 'success', requestId: 'upstream-justone', recordTime: '2026-10-10T00:00:00Z',
        data: { business_data: posts, cursor: hasMore ? 'private-justone-cursor' : null } })
    }
    const adapter = provider === 'rapidapi' ? new RapidApiAdapter({ apiKey: 'fixture-only-key', fetchImpl })
      : new JustOneAdapter({ token: 'fixture-only-key', fetchImpl, logger: { warn() {}, error() {} } })
    const platformStore = pool ? new PostgresExternalPlatformStore({ pool, providerKey: provider, authorizationPlatform: 'facebook' })
      : new MemoryExternalPlatformStore({ usageStore: usage, providerKey: provider, authorizationPlatform: 'facebook' })
    stores[provider] = platformStore
    gateways[provider] = new ExternalPlatformGateway({ usageStore: usage, platformStore, adapter, config, providerKey: provider,
      operationControlStore: controls, apiKeyPepper: PEPPER, reservationLeaseMs: 120000, logger: pool ? console : { warn() {}, error() {} } })
  }
  const dispatch = (ctx, input) => gateways.rapidapi.searchFacebook(ctx, input, { policyStore, fallbackGateway: gateways.justone })
  service.externalRawSearch = dispatch; service.externalDataSearch = dispatch
  const invoke = (body = { platform: 'facebook', query: 'Unitree', count: 20 }, idempotencyKey = 'facebook-request-0001') =>
    service.nightAllCompatibilitySearch(context, { operation: 'raw', body, idempotencyKey, path: '/api/v1/night-all/search/raw' })
  return { usage, service, stores, gateways, context, key, calls, policy, policyStore, observations, invoke, oldCalls: () => oldCalls }
}

test('Facebook pause applied during concurrency waiting blocks both supplier dispatch and quota admission', async () => {
  const h = await harness()
  const gateway = h.gateways.rapidapi
  gateway.config = { ...gateway.config, maxConcurrency: 1, concurrencyQueue: { maxWaitMs: 1000, maxPending: 2 } }
  gateway.active = 1
  let admissions = 0
  h.policyStore.admitRapid = async () => { admissions += 1; return { allowed: true } }
  const pending = h.invoke().catch(error => error)
  for (let i = 0; i < 100 && !gateway.concurrencyQueue.entries.length; i++) await new Promise(resolve => setTimeout(resolve, 2))
  assert.equal(gateway.concurrencyQueue.entries.length, 1)
  h.policy.mode = 'paused'
  gateway.active = 0
  gateway.concurrencyQueue.drain()
  assert.equal((await pending).code, 'facebook_search_paused')
  assert.equal(admissions, 0)
  assert.equal(h.calls.length, 0)
  assert.equal(gateway.active, 0)
  assert.equal(h.stores.rapidapi.leases.size, 0)
})

test('Facebook raw owns both providers, dates, exact replay and canonical ingest', async () => {
  const h = await harness()
  const body = { platform: 'facebook', query: '(Unitree OR 宇树科技)', count: 20, params: { startTime: '2026-10-07T10:11:11Z', endTime: '2026-10-10T10:11:11Z' } }
  const first = await h.invoke(body)
  assert.equal(first.body.data.status, 'ok')
  assert.equal(h.calls[0].url.host, 'facebook-scraper3.p.rapidapi.com')
  assert.equal(h.calls[0].url.searchParams.get('start_date'), '2026-10-07')
  assert.equal(h.calls[0].url.searchParams.get('query'), body.query)
  assert.equal(JSON.parse(first.body.data.raw_data)[0].full_text, post.message)
  assert.equal(h.stores.rapidapi.ingestJobs[0].payload.records[0].body, post.message)
  assert.deepEqual((await h.invoke(body)).body, first.body)
  assert.equal(h.calls.length, 1); assert.equal(h.oldCalls(), 0)
})

test('confirmed 429 uses one customer request and two durable provider receipts', async () => {
  const h = await harness({ rapidStatus: 429 })
  const first = await h.invoke()
  assert.deepEqual(h.calls.map(row => row.provider), ['rapidapi', 'justone'])
  const rapid = [...h.stores.rapidapi.calls.values()][0], fallback = [...h.stores.justone.calls.values()][0]
  assert.equal(rapid.outcome, 'rejected'); assert.equal(fallback.outcome, 'succeeded')
  assert.equal(rapid.usageRequestId, fallback.usageRequestId)
  assert.equal(fallback.callOrdinal, 1)
  assert.equal(first.body.data.meta.upstreamCallCount, 2)
  assert.equal(h.stores.justone.ingestJobs[0].payload.providerKey, 'justone')
  assert.deepEqual((await h.invoke()).body, first.body)
  assert.equal(h.calls.length, 2)
})

test('exhausted quota and administrator-selected JustOne never send RapidAPI traffic', async () => {
  for (const options of [{ quotaAllowed: false }, { mode: 'justone' }]) {
    const h = await harness(options)
    await h.invoke()
    assert.deepEqual(h.calls.map(row => row.provider), ['justone'])
  }
})

test('Facebook raw and standard replicas wait for shared allowance and only one consumes the last included call',
  { skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE }, async t => {
    for (const route of ['raw', 'standard']) for (const used of [0, 999]) await t.test(`${route}-${used}`, async t => {
      const { db, store, replica } = await facebookQuotaFixture(t)
      await db.query('UPDATE control.facebook_rapid_quota SET used=$1,remaining=$2', [used, 1000 - used])
      let finish, started
      const ready = new Promise(resolve => { started = resolve }), gate = new Promise(resolve => { finish = resolve })
      const a = await harness({ policyStore: store, respond: async ({ provider }) => {
        assert.equal(provider, 'rapidapi'); started(); await gate
        return Response.json({ results: [post], cursor: null }, { headers: {
          'x-ratelimit-requests-limit': '1000', 'x-ratelimit-requests-remaining': String(999 - used) } })
      } })
      const b = await harness({ policyStore: replica })
      const invoke = (h, key) => route === 'raw' ? h.invoke({ platform: 'facebook', query: key, count: 20 }, key)
        : invokeStandard(h, { platform: 'facebook', query: key, pageSize: 20 }, key)
      const first = invoke(a, 'facebook-shared-first')
      await ready
      const second = invoke(b, 'facebook-shared-second')
      try {
        for (let i = 0; i < 100 && !(await store.facebook()).queue_depth; i++) await new Promise(resolve => setTimeout(resolve, 2))
        assert.equal((await store.facebook()).queue_depth, 1)
        assert.equal(b.calls.length, 0, 'busy does not spend a JustOne call')
        assert.equal((await store.facebook()).used, used + 1, 'waiting did not reserve another call')
      } finally { finish() }
      assert.equal((await first).status, 200)
      assert.equal((await second).status, 200)
      assert.deepEqual(b.calls.map(row => row.provider), [used === 999 ? 'justone' : 'rapidapi'])
      assert.equal((await store.facebook()).used, used === 999 ? 1000 : 2)
      assert.equal((await store.facebook()).queue_depth, 0)
      assert.equal((await store.facebook()).lease_until, null)
    })
  })

test('Facebook shared queue timeout and cancellation return Hub busy without purchasing the fallback',
  { skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE }, async t => {
    for (const scenario of ['timeout', 'cancel']) await t.test(scenario, async t => {
      const { store } = await facebookQuotaFixture(t)
      const active = await store.admitRapid()
      const h = await harness({ policyStore: store })
      if (scenario === 'timeout') h.gateways.rapidapi.reservationLeaseMs = 6100
      const abort = new AbortController()
      const pending = invokeStandard(h, { platform: 'facebook', query: 'queue-failure', pageSize: 20 }, 'facebook-shared-failure', abort.signal).catch(error => error)
      if (scenario === 'cancel') {
        for (let i = 0; i < 100 && !(await store.facebook()).queue_depth; i++) await new Promise(resolve => setTimeout(resolve, 2))
        abort.abort()
      }
      const error = await pending
      assert.equal(error.code, scenario === 'cancel' ? 'request_cancelled' : 'external_platform_busy')
      assert.equal(h.calls.length, 0)
      assert.equal((await store.facebook()).queue_depth, 0)
      assert.equal((await store.facebook()).used, 1)
      assert.equal([...h.usage.requests.values()][0].status, 'released')
      await store.observeRapid(active)
    })
  })

test('Facebook 301 preserves the failed receipt and existing customer settlement without a RapidAPI dispatch or automatic retry', async () => {
  for (const route of ['raw', 'standard']) for (const mode of ['justone', 'auto']) {
    const h = await harness({ mode, respond: ({ provider }) => {
      assert.equal(provider, 'justone')
      return Response.json({ code: 301, message: 'private-collector-error', data: null,
        requestId: 'fixture-301-request', recordTime: '2026-10-15T01:09:11Z' })
    } })
    h.policyStore.admitRapid = async () => ({ allowed: false, reason: 'quota_exhausted' })
    await h.service.setTenantBillingProfile(h.context.tenant.id,
      { mode: 'enforced', multiplierPpm: 1000000, defaultUnitPriceMinor: 1, defaultCurrency: 'CNY' }, 'test-admin')
    await h.service.addTenantCredit(h.context.tenant.id, { amountMinor: 100, currency: 'CNY', reason: 'Offline Facebook 301 receipt fixture' },
      { idempotencyKey: 'facebook-301-credit', actor: 'test-admin' })
    const query = '(练习生 OR "idol trainee")'
    const body = { platform: 'facebook', query, params: { startTime: '2026-10-12T00:47:59.087335Z', endTime: '2026-10-15T00:47:59.087335Z' },
      ...(route === 'raw' ? { count: 20 } : { pageSize: 20, type: 'stable' }) }
    const invoke = () => route === 'raw' ? h.invoke(body, 'facebook-301-request') : invokeStandard(h, body, 'facebook-301-request')
    let first
    await assert.rejects(invoke(), error => {
      first = error
      assert.equal(error.status, 502)
      assert.equal(error.code, 'external_platform_rejected')
      assert.equal(error.details.reasonCode, 'upstream_collection_failed')
      assert.equal(error.details.retryable, false)
      assert.doesNotMatch(JSON.stringify([error.message, error.details]), /private-collector-error|fixture-only-key/)
      return true
    })
    assert.deepEqual(h.calls.map(row => row.provider), ['justone'])
    assert.equal(h.calls[0].url.searchParams.get('keyword'), query)
    assert.equal(h.calls[0].url.searchParams.get('startDate'), '2026-10-12')
    assert.equal(h.calls[0].url.searchParams.get('endDate'), '2026-10-15')
    assert.equal(h.stores.rapidapi.calls.size, 0)
    const call = [...h.stores.justone.calls.values()][0]
    assert.equal(call.businessCode, 301)
    assert.equal(call.billed, false)
    assert.equal(call.outcome, 'rejected')
    assert.equal(h.stores.justone.ingestJobs.length, 0)
    const usage = h.usage.requests.get(first.details.requestId)
    assert.equal(usage.status, 'committed')
    assert.equal(usage.responseStatus, 502)
    assert.equal(usage.unitsActual, 0)
    const charge = [...h.usage.customerCharges.values()].find(row => row.usageRequestId === usage.id)
    assert.equal(charge.status, 'captured', 'observes the existing request-fee policy; does not authorize refunds or a new policy')
    assert.equal(charge.chargedMinor, 1)
    h.policy.mode = 'paused'
    await assert.rejects(invoke(), error => {
      assert.equal(error.message, first.message)
      assert.deepEqual(error.details, first.details)
      return true
    })
    assert.equal(h.calls.length, 1)
    assert.equal(h.usage.customerCharges.size, 1)
  }
})

test('Facebook capacity failures distinguish account causes and replay the same saved refusal', async () => {
  const reasons = [[100, 'upstream_auth_invalid', /credential is invalid/u],
    [600, 'upstream_permission_denied', /permission is denied/u],
    [601, 'upstream_balance_exhausted', /balance is exhausted/u],
    [602, 'upstream_token_limit_exceeded', /credential quota is exhausted/u]]
  for (const route of ['raw', 'standard']) for (const [code, reasonCode, message] of reasons) {
    const h = await harness({ mode: 'justone', respond: () => Response.json({ code,
      message: 'private-provider-token-and-balance', data: null, requestId: 'private-provider-id', recordTime: '2026-10-29T15:52:13Z' }) })
    const invoke = () => route === 'raw' ? h.invoke()
      : invokeStandard(h, { platform: 'facebook', query: 'Unitree', pageSize: 20 }, 'facebook-capacity-fixture')
    let first
    await assert.rejects(invoke(), error => {
      first = error
      assert.equal(error.status, 503)
      assert.equal(error.code, 'external_platform_capacity_unavailable')
      assert.equal(error.details.reasonCode, reasonCode)
      assert.equal(error.details.outcome, 'rejected')
      assert.equal(error.details.retryable, false)
      assert.equal(error.details.action, 'contact_administrator')
      assert.match(error.message, message)
      assert.doesNotMatch(JSON.stringify([error.message, error.details]), /private-|justone|fixture-only-key/u)
      return true
    })
    const call = [...h.stores.justone.calls.values()][0]
    assert.equal(call.businessCode, code)
    assert.equal(call.errorCode, reasonCode)
    assert.equal(call.billed, false)
    assert.equal(call.outcome, 'rejected')
    assert.equal(h.stores.justone.restrictedResponseArchives.size, 1)
    assert.equal(h.stores.justone.ingestJobs.length, 0)
    h.policy.mode = 'paused'
    await assert.rejects(invoke(), error => {
      assert.equal(error.status, first.status)
      assert.equal(error.code, first.code)
      assert.equal(error.message, first.message)
      assert.deepEqual(error.details, first.details)
      return true
    })
    assert.equal(h.calls.length, 1)
  }
})

test('ambiguous or malformed paid responses never fall through or retry', async () => {
  for (const options of [{ rapidStatus: 'timeout' }, { rapidStatus: 503 }, { malformed: true }]) {
    const h = await harness(options)
    await assert.rejects(h.invoke())
    await assert.rejects(h.invoke())
    assert.deepEqual(h.calls.map(row => row.provider), ['rapidapi'])
    assert.equal(h.oldCalls(), 0)
  }
})

test('cursor is consumer/query/provider pinned; pause and invalid shapes fail before dispatch', async () => {
  const h = await harness({ hasMore: true, mode: 'justone' })
  const first = await h.invoke()
  const cursor = first.body.data.page.nextCursor
  assert.ok(cursor.startsWith('mxraw1.')); assert.ok(!cursor.includes('justone'))
  h.policy.mode = 'auto'
  await h.invoke({ platform: 'facebook', query: 'Unitree', count: 20, cursor }, 'facebook-request-page2')
  assert.deepEqual(h.calls.map(row => row.provider), ['justone', 'justone'])
  assert.equal(h.calls[1].url.searchParams.get('cursor'), 'private-justone-cursor')
  for (const body of [ { platform: 'facebook', query: 'changed', cursor }, { platform: 'facebook', query: 'Unitree', cursor: 'old-provider-token' },
    { platform: 'facebook', queries: ['a', 'b'], count: 20 }, { platform: 'facebook', query: 'x', params: { host: 'evil' } } ]) {
    await assert.rejects(h.invoke(body, 'invalid-request-0001'), e => e.status === 400)
  }
  h.policy.mode = 'paused'
  await assert.rejects(h.invoke({ platform: 'facebook', query: 'other' }, 'paused-request-0001'), { code: 'facebook_search_paused' })
  assert.equal(h.calls.length, 2); assert.equal(h.oldCalls(), 0)
})

test('data/search projects Facebook into the existing canonical-compatible v1 envelope', async () => {
  const h = await harness()
  const result = await h.service.search(h.context, { body: { platform: 'facebook', query: 'Unitree', pageSize: 20,
    params: { startTime: '2026-10-07T10:11:11Z', endTime: '2026-10-10T10:11:11Z' } },
    idempotencyKey: 'facebook-data-00001', path: '/api/v1/data/search' })
  assert.equal(result.body.data.contractVersion, 'night-all.data-search.v1')
  assert.equal(result.body.data.items[0].title, null)
  assert.equal(result.body.data.items[0].text, post.message)
  assert.equal(result.body.data.items[0].source.provider, null)
  assert.equal(h.calls[0].url.searchParams.get('start_date'), '2026-10-07')
  assert.equal(h.calls[0].url.searchParams.get('end_date'), '2026-10-10')
  assert.equal(h.oldCalls(), 0)
})

test('Facebook calibration keeps existing date aliases, request fingerprints and scope hashes unchanged', () => {
  const query = '(练习生 OR "idol trainee")', params = { endTime: '2026-10-15T00:47:59.087335Z', startTime: '2026-10-12T00:47:59.087335Z' }
  for (const route of ['raw', 'standard']) {
    const body = { platform: 'facebook', query, ...(route === 'raw' ? { count: 20 } : { pageSize: 20 }), params }
    const normalized = route === 'raw' ? { platform: 'facebook', pageSize: 20, upstreamBody: body } : body
    const codec = (route === 'raw' ? createRawSearchCursorCodec : createDataSearchCursorCodec)(PEPPER, 'calibration-identity')
    const result = normalizeFacebookSearch(normalized, codec, route === 'raw' ? null : { resultType: 'stable' }, Date.parse('2026-10-15T01:00:00Z'))
    const expectedFingerprint = route === 'raw'
      ? { contractVersion: 'mx-insight-hub.night-all-compat.v1', ...body } : { ...body, type: 'stable' }
    const expectedScope = rowsDigest({ query, pageSize: 20, dates: { startTime: params.startTime, endTime: params.endTime },
      format: route === 'raw' ? 'raw' : 'stable' })
    assert.deepEqual(result.fingerprintBody, expectedFingerprint)
    assert.equal(result.scopeHash, expectedScope)
    assert.equal(result.projectionVersion, 2)
    for (const provider of ['rapidapi', 'justone']) {
      const { upstreamQuery } = result.forProvider(provider)
      assert.deepEqual(upstreamQuery, provider === 'rapidapi'
        ? { query, start_date: '2026-10-12', end_date: '2026-10-15' }
        : { keyword: query, startDate: '2026-10-12', endDate: '2026-10-15' })
    }
  }
})

test('Facebook calibration rejects unknown cursor projection versions without dispatch on either public contract', async () => {
  for (const route of ['raw', 'standard']) {
    const h = await harness({ mode: 'rapidapi', posts: fixturePosts(0, 20), hasMore: true })
    const body = { platform: 'facebook', query: 'projection-version', ...(route === 'raw' ? { count: 20 } : { pageSize: 20, type: 'stable' }) }
    const invoke = (nextBody, key) => route === 'raw' ? h.invoke(nextBody, key) : invokeStandard(h, nextBody, key)
    const first = await invoke(body, `fb-version-${route}-first`)
    const cursor = route === 'raw' ? first.body.data.page.nextCursor : first.body.data.pageInfo.nextCursor
    const codec = (route === 'raw' ? createRawSearchCursorCodec : createDataSearchCursorCodec)(PEPPER, `${h.context.consumer.id}:${h.context.apiKey.id}`)
    const state = codec.decode(cursor)
    assert.equal(state.projectionVersion, 2)
    for (const projectionVersion of [0, 3, '2']) {
      await assert.rejects(invoke({ ...body, cursor: codec.encode({ ...state, projectionVersion }) },
        `fb-version-${route}-${projectionVersion}`), { code: 'invalid_cursor' })
    }
    assert.equal(h.calls.length, 1)
    assert.equal(h.stores.rapidapi.ingestJobs.length, 1)
  }
})

test('Facebook calibration preserves pre-upgrade immutable 200 and 301 replay without projection, procurement or settlement', async () => {
  for (const route of ['raw', 'standard']) for (const status of [200, 502]) {
    const h = await harness({ mode: 'paused' })
    const body = { platform: 'facebook', query: 'legacy immutable body', ...(route === 'raw' ? { count: 20 } : { pageSize: 20, type: 'stable' }),
      params: { startTime: '2026-10-12T00:47:59.087335Z', endTime: '2026-10-15T00:47:59.087335Z' } }
    const path = route === 'raw' ? '/api/v1/night-all/search/raw' : '/api/v1/data/search'
    const fingerprintBody = route === 'raw' ? { contractVersion: 'mx-insight-hub.night-all-compat.v1', ...body } : body
    const id = randomUUID(), idempotencyKey = `fb-pre-upgrade-${route}-${status}`
    await h.usage.reserve({ requestId: id, idempotencyKey, fingerprint: requestFingerprint({ method: 'POST', path, body: fingerprintBody }),
      tenantId: h.context.tenant.id, consumerId: h.context.consumer.id, apiKeyId: h.context.apiKey.id,
      platform: 'facebook', meterKey: route === 'raw' ? 'raw' : 'facebook', unitsReserved: 1,
      leaseExpiresAt: new Date(Date.now() + 120000), windowStart: new Date(Date.now() - 3600000), maxRequests: 100, replayWindowMs: null })
    const saved = status === 502 ? { error: { code: 'external_platform_rejected', message: 'The data source reported a collection failure',
      details: { reasonCode: 'upstream_collection_failed', outcome: 'rejected', retryable: false, requestId: id } }, requestId: id }
      : route === 'raw' ? { data: { platform: 'facebook', query: body.query, raw_info: '[]',
        raw_data: '[{"content_id":"legacy-post","title":"saved historical title","full_text":"saved body","like_count":0}]',
        status: 'ok', warnings: [], page: { page: 1, pageSize: 20, returnedCount: 1, hasMore: false, nextCursor: null }, meta: { upstreamCallCount: 1 } }, requestId: id }
        : { data: { contractVersion: 'night-all.data-search.v1', platform: 'facebook', query: body.query,
          items: [{ id: 'legacy-post', title: 'saved historical title', text: 'saved body', metrics: { likes: 0 } }],
          pageInfo: { pageIndex: 1, pageSize: 20, returnedCount: 1, hasMore: false, nextCursor: null },
          status: 'ok', warnings: [], meta: { providerCalls: 1 } }, requestId: id }
    await h.usage.commitRequest(id, { responseStatus: status, responseBody: saved, unitsActual: status === 502 ? 0 : 1 })
    const charges = structuredClone([...h.usage.customerCharges.values()])
    h.policyStore.admitRapid = async () => { throw new Error('immutable replay must precede new admission') }
    const invoke = () => route === 'raw' ? h.invoke(body, idempotencyKey) : invokeStandard(h, body, idempotencyKey)
    if (status === 200) {
      const result = await invoke()
      assert.equal(result.replay, true)
      assert.deepEqual(result.body, saved)
    } else await assert.rejects(invoke(), error => {
      assert.equal(error.status, 502)
      assert.equal(error.code, saved.error.code)
      assert.equal(error.message, saved.error.message)
      assert.deepEqual(error.details, saved.error.details)
      return true
    })
    assert.deepEqual(h.usage.requests.get(id).responseBody, saved)
    assert.deepEqual([...h.usage.customerCharges.values()], charges)
    assert.equal(h.usage.requests.size, 1)
    assert.equal(h.calls.length, 0)
    assert.equal(h.stores.rapidapi.ingestJobs.length + h.stores.justone.ingestJobs.length, 0)
  }
})

test('Facebook calibration continues real pre-upgrade buffer hashes and pins the entire old traversal to v1', async () => {
  for (const mode of ['rapidapi', 'justone']) {
    const legacyPosts = fixturePosts(0, 45).map(row => ({ ...row, message: 'legacy buffered body', reactions_count: '', timestamp: String(post.timestamp),
      album_preview: [{ uri: 'https://www.facebook.com/photo.php?fbid=123' }] }))
    const newPosts = fixturePosts(45, 20).map(row => ({ ...row, message: 'legacy continued body', reactions_count: '', timestamp: String(post.timestamp) }))
    const h = await harness({ mode, respond: ({ provider, ordinal }) => facebookResponse(provider,
      ordinal === 1 ? legacyPosts : newPosts, ordinal === 1 ? 'old-provider-next' : null) })
    const body = { platform: 'facebook', query: 'legacy projection traversal', pageSize: 20, type: 'stable' }
    const first = await invokeStandard(h, body, `fb-real-v1-${mode}-first`)
    const store = h.stores[mode], archive = [...store.restrictedResponseArchives.values()][0]
    const archiveBefore = structuredClone(archive), capturedAt = archive.capturedAt
    const frozenRows = legacyPosts.map(row => frozenFacebookRowV1(row, capturedAt))
    assert.deepEqual(facebookRowV1(legacyPosts[0], capturedAt), frozenRows[0])
    assert.notEqual(rowsDigest(frozenRows), rowsDigest(legacyPosts.map(row => facebookRow(row, capturedAt))), 'the fixture must distinguish old and new projections')
    const codec = createDataSearchCursorCodec(PEPPER, `${h.context.consumer.id}:${h.context.apiKey.id}`)
    const state = codec.decode(first.body.data.pageInfo.nextCursor)
    delete state.projectionVersion
    state.buffer.hash = rowsDigest(frozenRows)
    const oldCursor = codec.encode(state), oldResponse = structuredClone(first.body)
    oldResponse.data.pageInfo.nextCursor = oldCursor
    for (const item of oldResponse.data.items) {
      item.metrics.likes = 0
      item.publishedAt = null
      item.media.images = ['https://www.facebook.com/photo.php?fbid=123']
    }
    h.usage.requests.get(first.requestId).responseBody = structuredClone(oldResponse)
    const ingestBefore = store.ingestJobs.length
    const second = await invokeStandard(h, { ...body, cursor: oldCursor }, `fb-real-v1-${mode}-second`)
    assert.deepEqual(second.body.data.items.map(item => item.id), Array.from({ length: 20 }, (_, i) => `post-${20 + i}`))
    assert.ok(second.body.data.items.every(item => item.metrics.likes === 0 && item.publishedAt === null))
    assert.ok(second.body.data.items.every(item => item.media.images.includes('https://www.facebook.com/photo.php?fbid=123')))
    assert.equal(second.body.data.meta.providerCalls, 0)
    assert.equal(h.calls.length, 1)
    assert.equal(store.ingestJobs.length, ingestBefore)
    const secondState = codec.decode(second.body.data.pageInfo.nextCursor)
    assert.equal(secondState.projectionVersion, 1)
    assert.equal(secondState.buffer.hash, rowsDigest(frozenRows))
    assert.equal(secondState.buffer.offset, 40)
    const third = await invokeStandard(h, { ...body, cursor: second.body.data.pageInfo.nextCursor }, `fb-real-v1-${mode}-third`)
    assert.deepEqual(third.body.data.items.map(item => item.id), Array.from({ length: 20 }, (_, i) => `post-${40 + i}`))
    assert.ok(third.body.data.items.every(item => item.metrics.likes === 0 && item.publishedAt === null), 'new source pages in an old traversal keep the original projection')
    assert.equal(third.body.data.meta.providerCalls, 1)
    assert.equal(h.calls.length, 2)
    assert.equal(h.calls[1].url.searchParams.get('cursor'), 'old-provider-next')
    assert.equal(codec.decode(third.body.data.pageInfo.nextCursor).projectionVersion, 1)
    assert.deepEqual(structuredClone(archive), archiveBefore)
    assert.equal(createHash('sha256').update(archive.bodyBytes).digest('hex'), archiveBefore.bodySha256)
    assert.deepEqual(h.usage.requests.get(first.requestId).responseBody, oldResponse)
    assert.deepEqual(store.ingestJobs.map(job => job.payload.records.length), [45, 20])
  }
})

test('Facebook calibration keeps pre-upgrade raw provider cursors on v1 without changing supplier requests', async () => {
  for (const mode of ['rapidapi', 'justone']) {
    const source = { ...post, reactions_count: '', timestamp: String(post.timestamp),
      album_preview: [{ uri: 'https://www.facebook.com/photo.php?fbid=123' }] }
    const h = await harness({ mode, respond: ({ provider, ordinal }) => facebookResponse(provider,
      [{ ...source, post_id: `old-raw-${ordinal}` }], ordinal < 3 ? `old-raw-source-${ordinal}` : null) })
    const body = { platform: 'facebook', query: '(练习生 OR "idol trainee")', count: 20,
      params: { startTime: '2026-10-12T00:47:59.087335Z', endTime: '2026-10-15T00:47:59.087335Z' } }
    const first = await h.invoke(body, `fb-old-raw-${mode}-first`)
    const codec = createRawSearchCursorCodec(PEPPER, `${h.context.consumer.id}:${h.context.apiKey.id}`)
    const state = codec.decode(first.body.data.page.nextCursor)
    delete state.projectionVersion
    const second = await h.invoke({ ...body, cursor: codec.encode(state) }, `fb-old-raw-${mode}-second`)
    const [row] = JSON.parse(second.body.data.raw_data)
    const capturedAt = [...h.stores[mode].restrictedResponseArchives.values()][1].capturedAt
    assert.deepEqual(row, frozenFacebookRowV1({ ...source, post_id: 'old-raw-2' }, capturedAt))
    assert.equal(codec.decode(second.body.data.page.nextCursor).projectionVersion, 1)
    assert.equal(h.calls[1].url.searchParams.get('cursor'), 'old-raw-source-1')
    assert.equal(h.calls[1].url.searchParams.get(mode === 'rapidapi' ? 'query' : 'keyword'), body.query)
    assert.equal(h.calls[1].url.searchParams.get(mode === 'rapidapi' ? 'start_date' : 'startDate'), '2026-10-12')
    assert.equal(h.calls[1].url.searchParams.get(mode === 'rapidapi' ? 'end_date' : 'endDate'), '2026-10-15')
    assert.equal(h.calls.length, 2)
  }
})

test('Facebook standard media separates only an explicit video poster and preserves genuine mixed photos and URL queries', () => {
  const photo = 'https://assets.example/photo.jpg?asset=original', poster = 'https://assets.example/poster.jpg?sig=one'
  const variant = 'https://assets.example/poster.jpg?sig=two', video = 'https://assets.example/movie.mp4'
  const landing = 'https://www.facebook.com/photo.php?fbid=123'
  const row = facebookRow({ ...post, image: { uri: photo }, album_preview: [{ uri: photo }, { url: poster }, { url: variant }, { uri: landing }],
    video_thumbnail: { uri: poster }, video_files: [{ url: video }, { url: video }] }, '2026-10-15T01:00:00.000Z')
  const original = structuredClone(row)
  assert.deepEqual(facebookStandardMedia(row), { coverUrl: poster, images: [photo, variant], videos: [video] })
  assert.deepEqual(row, original)
  assert.deepEqual(JSON.parse(row.image_urls), [photo, variant], 'explicit Facebook landing pages and video covers are not photo assets')
  assert.deepEqual(facebookStandardMedia({ ...row, video_thumbnail: null, cover_url: null }), { coverUrl: null,
    images: [photo, variant], videos: [video] }, 'first photo is never inferred to be a video poster')
  assert.deepEqual(facebookStandardMedia({ ...row, video_urls: '[]', image_urls: JSON.stringify([photo, poster, variant]) }), { coverUrl: poster,
    images: [photo, poster, variant], videos: [] }, 'without playback evidence no photo is removed')
})

test('Facebook new standard deliveries distinguish video cover and terminal short pages while raw contracts and exact replay stay intact', async () => {
  const photo = 'https://assets.example/photo.jpg', poster = 'https://assets.example/poster.jpg', video = 'https://assets.example/movie.mp4'
  const landing = 'https://www.facebook.com/photo.php?fbid=123'
  const source = { ...post, image: { uri: photo }, album_preview: [{ uri: photo }, { uri: landing }],
    video_thumbnail: { uri: poster }, video_files: [{ url: video }, { url: video }] }
  for (const mode of ['auto', 'justone']) {
    const h = await harness({ mode, respond: ({ provider, ordinal }) => facebookResponse(provider,
      [{ ...source, post_id: `media-${ordinal}` }], ordinal < 3 ? `media-cursor-${ordinal}` : null) })
    const body = { platform: 'facebook', query: 'fixture', pageSize: 20, type: 'stable' }
    const invoke = () => h.service.search(h.context, { body, idempotencyKey: 'facebook-media-standard', path: '/api/v1/data/search' })
    const standard = await invoke()
    assert.ok(isNightAllDataSearchV1Envelope(standard.body))
    assert.deepEqual(standard.body.data.items[0].media, { coverUrl: poster, images: [photo], videos: [video] })
    assert.equal(standard.body.data.items[0].title, null)
    assert.equal(standard.body.data.status, 'ok')
    assert.equal(standard.body.data.pageInfo.hasMore, false)
    assert.equal(standard.body.data.meta.providerCalls, 3)
    assert.equal(h.calls.length, 3, 'standard search stops when the provider explicitly exhausts its continuation')
    assert.deepEqual((await invoke()).body, standard.body)
    assert.equal(h.calls.length, 3)
    const raw = await h.invoke({ platform: 'facebook', query: 'fixture', count: 20 }, 'facebook-media-raw')
    const [row] = JSON.parse(raw.body.data.raw_data)
    assert.deepEqual(JSON.parse(row.image_urls), [photo])
    assert.deepEqual(JSON.parse(row.video_urls), [video])
    assert.equal(row.title, '')
    assert.equal(raw.body.data.status, 'ok')
    const store = h.stores[mode === 'auto' ? 'rapidapi' : 'justone']
    const receipts = [...store.restrictedResponseArchives.values()]
    const receipt = receipts[0].parsedPayload
    assert.deepEqual(mode === 'auto' ? receipt.results[0] : receipt.data.business_data[0], { ...source, post_id: 'media-1' })
  }
  const terminal = await harness({ posts: [source], hasMore: false })
  const result = await terminal.service.search(terminal.context, { body: { platform: 'facebook', query: 'fixture', pageSize: 20 },
    idempotencyKey: 'facebook-terminal-short', path: '/api/v1/data/search' })
  assert.equal(result.body.data.status, 'ok', 'a short terminal page is complete')
})

test('Facebook standard search fills from same-provider pages, buffers every paid overflow row and ingests each source once', async () => {
  for (const mode of ['rapidapi', 'justone']) {
    const h = await harness({ mode, respond: ({ provider, ordinal }) => facebookResponse(provider,
      fixturePosts((ordinal - 1) * 24, 24), `source-${ordinal}`) })
    const body = { platform: 'facebook', query: 'fixture', pageSize: 20, type: 'stable', params: { start_date: '2026-10-07', end_date: '2026-10-10' } }
    const first = await invokeStandard(h, body, `fb-fill-${mode}-first`)
    assert.equal(first.body.data.items.length, 20)
    assert.equal(first.body.data.meta.providerCalls, 1)
    assert.equal(first.body.data.pageInfo.hasMore, true)
    const second = await invokeStandard(h, { ...body, cursor: first.body.data.pageInfo.nextCursor }, `fb-fill-${mode}-second`)
    assert.deepEqual(second.body.data.items.map(row => row.id), Array.from({ length: 20 }, (_, i) => `post-${i + 20}`))
    assert.equal(second.body.data.meta.providerCalls, 1, 'four carried rows are combined with sixteen newly acquired rows')
    assert.equal(h.calls.length, 2)
    assert.equal(h.calls[1].url.searchParams.get('cursor'), 'source-1')
    assert.equal(h.calls[1].url.searchParams.has('count'), false, 'neither supplier accepts a synthetic count parameter')
    const sourceStore = h.stores[mode]
    assert.deepEqual(sourceStore.ingestJobs.map(job => job.payload.records.length), [24, 24])
    assert.equal(sourceStore.calls.size, 2)
    assert.equal(h.usage.requests.size, 2)
    assert.equal([...h.usage.requests.values()].filter(row => row.status === 'committed').length, 2)
    const saved = structuredClone(second.body)
    assert.deepEqual((await invokeStandard(h, { ...body, cursor: first.body.data.pageInfo.nextCursor }, `fb-fill-${mode}-second`)).body, saved)
    assert.equal(h.calls.length, 2)
    const third = await invokeStandard(h, { ...body, cursor: second.body.data.pageInfo.nextCursor }, `fb-fill-${mode}-third`)
    assert.deepEqual(third.body.data.items.map(row => row.id), Array.from({ length: 20 }, (_, i) => `post-${i + 40}`))
    assert.equal(h.calls.length, 3)
    assert.deepEqual(sourceStore.ingestJobs.map(job => job.payload.records.length), [24, 24, 24])
    assert.equal(h.oldCalls(), 0)
  }
})

test('Facebook initial confirmed 429 permits five successful fill pages with one settlement and provider pinning', async () => {
  const h = await harness({ respond: ({ provider, ordinal }) => provider === 'rapidapi'
    ? facebookResponse(provider, [], null, 429)
    : facebookResponse(provider, fixturePosts((ordinal - 2) * 4, 4), `justone-${ordinal}`) })
  const body = { platform: 'facebook', query: 'fixture', pageSize: 20, type: 'stable' }
  const first = await invokeStandard(h, body, 'fb-fill-fallback-first')
  assert.deepEqual(h.calls.map(row => row.provider), ['rapidapi', ...Array(5).fill('justone')])
  assert.equal(first.body.data.meta.providerCalls, 6)
  assert.equal(first.body.data.items.length, 20)
  assert.equal(first.body.data.status, 'ok')
  assert.equal(first.body.data.pageInfo.hasMore, true)
  assert.equal(h.usage.requests.size, 1)
  assert.equal([...h.usage.requests.values()][0].status, 'committed')
  assert.equal(h.stores.rapidapi.calls.size, 1)
  assert.equal([...h.stores.rapidapi.calls.values()][0].outcome, 'rejected')
  assert.equal(h.stores.justone.calls.size, 5)
  assert.deepEqual(h.stores.justone.ingestJobs.map(job => job.payload.records.length), Array(5).fill(4))
  assert.equal(h.stores.justone.restrictedResponseArchives.size, 5)
  const saved = [...h.usage.requests.values()][0]
  assert.equal(saved.acquisitionRequest.facebookFill.sources.length, 5)
  assert.equal(saved.acquisitionRequest.facebookFill.upstreamPages, 6)
  assert.deepEqual((await invokeStandard(h, body, 'fb-fill-fallback-first')).body, first.body)
  assert.equal(h.calls.length, 6)
  h.policy.mode = 'rapidapi'
  await invokeStandard(h, { ...body, cursor: first.body.data.pageInfo.nextCursor }, 'fb-fill-fallback-second')
  assert.ok(h.calls.slice(6).every(row => row.provider === 'justone'), 'continuation never sends a JustOne cursor to RapidAPI')
})

test('Facebook standard fills an empty or duplicate intermediate page without returning duplicates', async () => {
  const h = await harness({ mode: 'rapidapi', respond: ({ provider, ordinal }) => facebookResponse(provider,
    ordinal === 1 ? fixturePosts(0, 7) : ordinal === 2 ? [] : [...fixturePosts(4, 3), ...fixturePosts(7, 13)],
    ordinal < 3 ? `next-${ordinal}` : null) })
  const result = await invokeStandard(h, { platform: 'facebook', query: 'fixture', pageSize: 20 }, 'fb-fill-dedup-empty')
  assert.equal(result.body.data.items.length, 20)
  assert.equal(new Set(result.body.data.items.map(row => row.id)).size, 20)
  assert.equal(result.body.data.pageInfo.hasMore, false)
  assert.equal(result.body.data.meta.providerCalls, 3)
  assert.deepEqual(h.stores.rapidapi.ingestJobs.map(job => job.payload.records.length), [7, 0, 16])
})

test('Facebook raw still rejects oversized paid pages rather than silently changing its published format', async () => {
  const h = await harness({ posts: fixturePosts(0, 24), mode: 'rapidapi' })
  await assert.rejects(h.invoke({ platform: 'facebook', query: 'fixture', count: 20 }, 'fb-raw-overflow-preserved'),
    { code: 'social_upstream_response_unusable' })
  assert.equal(h.calls.length, 1)
  assert.equal([...h.stores.rapidapi.calls.values()][0].outcome, 'succeeded_unusable')
  assert.equal(h.stores.rapidapi.ingestJobs.length, 0)
})

test('Facebook known RapidAPI quota admission returns available rows without crossing a pinned provider', async () => {
  let allowed = true
  const h = await harness({ mode: 'auto', respond: ({ provider, ordinal }) => {
    allowed = false
    return facebookResponse(provider, fixturePosts(ordinal * 5, 5), 'pinned-rapid-next')
  }, policyStore: { facebook: async () => ({ mode: 'auto' }), admitRapid: async () => ({ allowed }), observeRapid: async () => {} } })
  const body = { platform: 'facebook', query: 'fixture', pageSize: 20, type: 'stable' }
  const result = await invokeStandard(h, body, 'fb-fill-quota-short')
  assert.equal(result.body.data.items.length, 5)
  assert.equal(result.body.data.status, 'partial')
  assert.equal(result.body.data.pageInfo.hasMore, true)
  assert.equal(result.body.data.meta.providerCalls, 1)
  await assert.rejects(invokeStandard(h, { ...body, cursor: result.body.data.pageInfo.nextCursor }, 'fb-fill-quota-next'),
    { code: 'search_restart_required' })
  assert.deepEqual(h.calls.map(row => row.provider), ['rapidapi'])
  const auto = await harness({ quotaAllowed: false })
  const fallback = await invokeStandard(auto, body, 'fb-fill-quota-initial')
  assert.equal(fallback.body.data.meta.providerCalls, 1)
  assert.deepEqual(auto.calls.map(row => row.provider), ['justone'])
})

test('Facebook later unknown acquisition never becomes a partial success or an automatic retry of its own key', async () => {
  for (const mode of ['rapidapi', 'justone']) {
    for (const type of ['fresh', 'stable']) {
      const h = await harness({ mode, respond: ({ provider, ordinal }) => {
        if (ordinal > 1) throw new Error('synthetic transport uncertainty after paid first page')
        return facebookResponse(provider, fixturePosts(0, 5), 'unknown-next')
      } })
      const body = { platform: 'facebook', query: 'fixture', pageSize: 20, type }
      await assert.rejects(invokeStandard(h, body, `fb-unknown-${mode}-${type}`))
      assert.equal([...h.usage.requests.values()][0].status, 'unknown')
      assert.deepEqual([...h.stores[mode].calls.values()].map(call => call.outcome), ['succeeded', 'unknown'])
      assert.equal(h.stores[mode].restrictedResponseArchives.size, 1)
      assert.equal(h.stores[mode].ingestJobs.length, 1)
      await assert.rejects(invokeStandard(h, body, `fb-unknown-${mode}-${type}`), { code: 'request_outcome_unknown' })
      assert.equal(h.calls.length, 2)
      // An ended unknown does not hold a new key; it makes its own acquisition.
      await assert.rejects(invokeStandard(h, body, `fb-unknown-new-${mode}-${type}`),
        { code: mode === 'rapidapi' ? 'social_upstream_outcome_unknown' : 'external_platform_outcome_unknown' })
      assert.equal(h.calls.length, 3)
    }
  }
})

test('Facebook evidence persistence failures retain a diagnostic code and prevent a second acquisition under the same key', async () => {
  for (const mode of ['rapidapi', 'justone']) for (const method of ['stageProviderEvidence', 'finishProviderStep']) {
    const h = await harness({ mode })
    h.stores[mode][method] = async () => { throw new Error('synthetic evidence persistence failure') }
    const body = { platform: 'facebook', query: 'fixture', pageSize: 20, type: 'stable' }
    const key = `fb-persist-unknown-${mode}-${method}`
    await assert.rejects(invokeStandard(h, body, key), { code: 'request_outcome_unknown' })
    const call = [...h.stores[mode].calls.values()][0]
    const usage = h.usage.requests.get(call.usageRequestId)
    assert.equal(call.outcome, 'unknown')
    assert.equal(call.errorCode, 'external_platform_persistence_unknown')
    assert.equal(usage.status, 'unknown')
    assert.equal(usage.errorCode, 'external_platform_persistence_unknown')
    assert.equal(h.stores[mode].responseArchives.get(call.id).httpStatus, 200)
    assert.equal(h.stores[mode].restrictedResponseArchives.size, 1)
    assert.equal(h.stores[mode].ingestJobs.length, 0)
    await assert.rejects(invokeStandard(h, body, key), { code: 'request_outcome_unknown' })
    assert.equal(h.calls.length, 1)
    await assert.rejects(invokeStandard(h, body, `${key}-new`), { code: 'request_outcome_unknown' })
    assert.equal(h.calls.length, 2, 'a new key is not held by the earlier persistence unknown')
  }
})

test('Facebook cancellation and Key revocation between fill steps prevent another procurement and retain paid evidence', async () => {
  for (const scenario of ['cancel', 'revoke']) {
    const h = await harness({ posts: fixturePosts(0, 5), hasMore: true, mode: 'rapidapi' })
    const controller = new AbortController(), original = h.gateways.rapidapi.adapter.execute.bind(h.gateways.rapidapi.adapter)
    h.gateways.rapidapi.adapter.execute = async (...args) => {
      const result = await original(...args)
      if (scenario === 'cancel') controller.abort()
      else await h.usage.revokeApiKey(h.context.apiKey.id)
      return result
    }
    await assert.rejects(invokeStandard(h, { platform: 'facebook', query: 'fixture', pageSize: 20, type: 'stable' },
      `fb-fill-step-${scenario}`, controller.signal))
    assert.equal(h.calls.length, 1)
    assert.equal(h.stores.rapidapi.restrictedResponseArchives.size, 1)
    assert.equal(h.stores.rapidapi.ingestJobs.length, 1)
    assert.equal([...h.usage.requests.values()][0].status, 'unknown')
  }
})

test('Facebook buffered hash verification fails closed on credential echoes, while credential rotation alone preserves the paid page', async () => {
  for (const echo of [false, true]) {
    const h = await harness({ posts: fixturePosts(0, 24).map(row => ({ ...row, message: echo ? 'fixture-only-key' : 'safe fixture' })), mode: 'rapidapi' })
    const body = { platform: 'facebook', query: 'fixture', pageSize: 20, type: 'stable' }
    const first = await invokeStandard(h, body, `fb-buffer-echo-source-${echo}`)
    h.gateways.rapidapi.adapter.apiKey = 'rotated-fixture-with-no-provider-echo'
    const continuation = { ...body, cursor: first.body.data.pageInfo.nextCursor }
    if (echo) await assert.rejects(invokeStandard(h, continuation, 'fb-buffer-echo-rejected'), { code: 'search_page_unavailable' })
    else {
      const second = await invokeStandard(h, continuation, 'fb-buffer-rotation-accepted')
      assert.equal(second.body.data.items.length, 4)
      assert.equal(second.body.data.meta.providerCalls, 0)
      assert.equal(second.body.data.pageInfo.hasMore, false)
    }
    assert.equal(h.calls.length, 1)
    assert.equal(h.stores.rapidapi.ingestJobs.length, 1)
  }
})

test('Facebook cached-only uncertain finalization preserves its reservation and lease until durable recovery', async () => {
  const h = await harness({ posts: fixturePosts(0, 21), mode: 'rapidapi' })
  await h.service.setTenantBillingProfile(h.context.tenant.id,
    { mode: 'enforced', multiplierPpm: 1000000, defaultUnitPriceMinor: 1, defaultCurrency: 'CNY' }, 'test-admin')
  await h.service.addTenantCredit(h.context.tenant.id, { amountMinor: 100, currency: 'CNY', reason: 'Offline FB uncertainty fixture' },
    { idempotencyKey: 'fb-fill-uncertainty-credit', actor: 'test-admin' })
  const body = { platform: 'facebook', query: 'fixture', pageSize: 20, type: 'stable' }
  const first = await invokeStandard(h, body, 'fb-buffer-unknown-source')
  const continuation = { ...body, cursor: first.body.data.pageInfo.nextCursor }, saved = structuredClone(first.body)
  const originalMark = h.usage.markRequestUnknown.bind(h.usage), originalGet = h.usage.getRequest.bind(h.usage)
  const originalRelease = h.usage.releaseRequest.bind(h.usage), releases = []
  h.stores.rapidapi.commitFacebookFillDelivery = async () => { throw new Error('synthetic final commit uncertainty') }
  h.usage.markRequestUnknown = async () => { throw new Error('synthetic unknown write unavailable') }
  h.usage.getRequest = async () => { throw new Error('synthetic confirmation read unavailable') }
  h.usage.releaseRequest = async (...args) => { releases.push(args); return originalRelease(...args) }
  await assert.rejects(invokeStandard(h, continuation, 'fb-buffer-retained-unknown'), error => {
    assert.equal(error.code, 'request_outcome_unknown')
    assert.doesNotMatch(JSON.stringify(error.details), /preserveReservation/)
    return true
  })
  const pending = [...h.usage.requests.values()].find(row => row.idempotencyKey === 'fb-buffer-retained-unknown')
  const charge = [...h.usage.customerCharges.values()].find(row => row.usageRequestId === pending.id)
  assert.equal(pending.status, 'reserved')
  assert.equal(charge.status, 'reserved')
  assert.equal(releases.length, 0)
  assert.ok([...h.stores.rapidapi.leases.values()].some(lease => lease.ownerRequestId === pending.id))
  await assert.rejects(invokeStandard(h, continuation, 'fb-buffer-retained-before-expiry'), { code: 'request_in_progress' })
  h.usage.markRequestUnknown = originalMark; h.usage.getRequest = originalGet
  pending.leaseExpiresAt = new Date(Date.now() - 1000).toISOString()
  for (const lease of h.stores.rapidapi.leases.values()) if (lease.ownerRequestId === pending.id) lease.expiresAt = pending.leaseExpiresAt
  await h.usage.reapStaleReservations()
  assert.equal(pending.status, 'unknown')
  assert.equal(charge.status, 'unknown')
  await assert.rejects(invokeStandard(h, continuation, 'fb-buffer-retained-after-expiry'), { code: 'request_outcome_unknown' })
  assert.equal(h.calls.length, 1)
  assert.equal(h.stores.rapidapi.ingestJobs.length, 1)
  assert.deepEqual(h.usage.requests.get(first.requestId).responseBody, saved)
})

test('Facebook legacy native-only cursors retain date and provider binding and conservatively inherit the upstream-page cap', async () => {
  const h = await harness({ mode: 'rapidapi', respond: ({ provider, ordinal }) => facebookResponse(provider,
    fixturePosts(ordinal * 100, ordinal === 1 ? 20 : 1), `legacy-source-${ordinal}`) })
  const body = { platform: 'facebook', query: 'fixture', pageSize: 20, type: 'stable' }
  const first = await invokeStandard(h, body, 'fb-legacy-native-origin')
  const codec = createDataSearchCursorCodec(PEPPER, `${h.context.consumer.id}:${h.context.apiKey.id}`)
  const state = codec.decode(first.body.data.pageInfo.nextCursor)
  const continued = await invokeStandard(h, { ...body, cursor: codec.encode({ ...state, fill: undefined, page: 14 }) }, 'fb-legacy-native-next')
  assert.equal(continued.body.data.items.length, 2)
  assert.equal(continued.body.data.meta.providerCalls, 2)
  assert.equal(continued.body.data.status, 'partial')
  assert.equal(continued.body.data.pageInfo.hasMore, false)
  const lineage = h.usage.requests.get(continued.requestId).acquisitionRequest.facebookFill
  assert.equal(lineage.upstreamPages, 15)
  assert.equal(lineage.previousDeliveryId, null)
  assert.equal(lineage.startDate, state.startDate)
  assert.equal(lineage.endDate, state.endDate)
  assert.equal(h.calls[1].url.searchParams.get('cursor'), 'legacy-source-1')
  assert.equal(h.calls[1].url.searchParams.get('start_date'), state.startDate)
  assert.equal(h.calls.length, 3)
  for (const mutation of [{ query: 'other' }, { pageSize: 21 }, { type: 'fresh' }, { params: { start_date: '2020-01-01' } }]) {
    await assert.rejects(invokeStandard(h, { ...body, ...mutation, cursor: first.body.data.pageInfo.nextCursor },
      `fb-bound-${Object.keys(mutation)[0]}`), { code: 'invalid_cursor' })
  }
  assert.equal(h.calls.length, 3)
})

test('Facebook legacy JustOne continuation reserves one historical dispatch for a possible initial RapidAPI 429 fallback', async () => {
  const h = await harness({ mode: 'justone', respond: ({ provider, ordinal }) => facebookResponse(provider,
    fixturePosts(ordinal * 100, ordinal === 1 ? 20 : 1), `legacy-justone-${ordinal}`) })
  const body = { platform: 'facebook', query: 'fixture', pageSize: 20, type: 'stable' }
  const first = await invokeStandard(h, body, 'fb-legacy-justone-origin')
  const codec = createDataSearchCursorCodec(PEPPER, `${h.context.consumer.id}:${h.context.apiKey.id}`)
  const state = codec.decode(first.body.data.pageInfo.nextCursor)
  const legacyCursor = page => codec.encode({ ...state, fill: undefined, page })
  const next = await invokeStandard(h, { ...body, cursor: legacyCursor(14) }, 'fb-legacy-justone-last-acquisition')
  assert.equal(next.body.data.items.length, 1)
  assert.equal(next.body.data.meta.providerCalls, 1, 'at legacy page14 only one acquisition remains when an initial fallback may have consumed an extra call')
  assert.equal(next.body.data.pageInfo.hasMore, false)
  assert.equal(h.usage.requests.get(next.requestId).acquisitionRequest.facebookFill.upstreamPages, 15)
  await assert.rejects(invokeStandard(h, { ...body, cursor: legacyCursor(15) }, 'fb-legacy-justone-limit'), { code: 'search_restart_required' })
  assert.equal(h.calls.length, 2)
  assert.deepEqual(h.calls.map(row => row.provider), ['justone', 'justone'])
})

test('Facebook repeated native cursors close without an extra purchase and preserve overflow until drained', async () => {
  for (const count of [20, 24]) {
    const h = await harness({ mode: 'rapidapi', respond: ({ provider, ordinal }) => facebookResponse(provider,
      fixturePosts(ordinal === 1 ? 0 : 20, ordinal === 1 ? 20 : count), 'same-next') })
    const body = { platform: 'facebook', query: 'fixture', pageSize: 20, type: 'stable' }
    const first = await invokeStandard(h, body, `fb-repeat-source-${count}`)
    const second = await invokeStandard(h, { ...body, cursor: first.body.data.pageInfo.nextCursor }, `fb-repeat-second-${count}`)
    assert.equal(second.body.data.items.length, 20)
    assert.equal(h.calls.length, 2)
    if (count === 20) assert.equal(second.body.data.pageInfo.hasMore, false)
    else {
      assert.equal(second.body.data.pageInfo.hasMore, true)
      const carry = await invokeStandard(h, { ...body, cursor: second.body.data.pageInfo.nextCursor }, 'fb-repeat-buffer-drained')
      assert.deepEqual(carry.body.data.items.map(row => row.id), ['post-40', 'post-41', 'post-42', 'post-43'])
      assert.equal(carry.body.data.meta.providerCalls, 0)
      assert.equal(carry.body.data.pageInfo.hasMore, false)
    }
    assert.equal(h.calls.length, 2)
    assert.equal(h.stores.rapidapi.ingestJobs.length, 2)
  }
  const cycle = await harness({ mode: 'rapidapi', respond: ({ provider, ordinal }) => facebookResponse(provider,
    fixturePosts(ordinal * 5, 5), ordinal === 2 ? 'cycle-b' : 'cycle-a') })
  const result = await invokeStandard(cycle, { platform: 'facebook', query: 'fixture', pageSize: 20 }, 'fb-three-source-cycle')
  assert.equal(result.body.data.items.length, 15)
  assert.equal(result.body.data.pageInfo.hasMore, false)
  assert.equal(cycle.calls.length, 3)
})

test('Facebook original 15-public-page limit closes buffered continuation without another supplier call', async () => {
  const h = await harness({ mode: 'rapidapi', posts: fixturePosts(0, 60), hasMore: true })
  const body = { platform: 'facebook', query: 'fixture', pageSize: 20, type: 'stable' }
  const first = await invokeStandard(h, body, 'fb-public-limit-source')
  const codec = createDataSearchCursorCodec(PEPPER, `${h.context.consumer.id}:${h.context.apiKey.id}`)
  const state = codec.decode(first.body.data.pageInfo.nextCursor)
  const final = await invokeStandard(h, { ...body, cursor: codec.encode({ ...state, page: 15 }) }, 'fb-public-limit-final')
  assert.equal(final.body.data.pageInfo.pageIndex, 15)
  assert.equal(final.body.data.items.length, 20)
  assert.equal(final.body.data.pageInfo.hasMore, false)
  assert.equal(final.body.data.pageInfo.nextCursor, null)
  assert.equal(final.body.data.meta.providerCalls, 0)
  assert.equal(h.calls.length, 1)
  assert.equal(h.stores.rapidapi.ingestJobs[0].payload.records.length, 60)
})

test('Facebook cumulative 12 MiB admission includes a complete incoming carry archive before another dispatch', async () => {
  const h = await harness({ mode: 'rapidapi', respond: ({ provider, ordinal }) => facebookResponse(provider,
    fixturePosts(ordinal === 1 ? 0 : 100 + ordinal * 5, ordinal === 1 ? 105 : 5)
      .map(row => ({ ...row, message: 'a'.repeat(ordinal === 1 ? 33000 : 700000) })), `large-next-${ordinal}`) })
  const body = { platform: 'facebook', query: 'fixture', pageSize: 100, type: 'stable' }
  const first = await invokeStandard(h, body, 'fb-byte-limit-source')
  assert.equal(first.body.data.items.length, 100)
  const second = await invokeStandard(h, { ...body, cursor: first.body.data.pageInfo.nextCursor }, 'fb-byte-limit-fill')
  assert.equal(second.body.data.items.length, 15)
  assert.equal(second.body.data.meta.providerCalls, 2)
  assert.equal(second.body.data.status, 'partial')
  assert.equal(second.body.data.pageInfo.hasMore, true)
  assert.equal(h.calls.length, 3)
  assert.deepEqual(h.stores.rapidapi.ingestJobs.map(job => job.payload.records.length), [105, 5, 5])
  const manifest = h.usage.requests.get(second.requestId).acquisitionRequest.facebookFill
  assert.equal(manifest.sources.length, 3, 'the original full carry receipt participates in the byte budget and durable manifest')
  assert.ok(manifest.sources.reduce((sum, source) => sum + source.bodySize, 0) <= 12 * 1024 * 1024)
})

test('an exhausted RapidAPI continuation never sends its cursor to JustOne', async () => {
  let allowed = true
  const h = await harness({ hasMore: true, policyStore: { facebook: async () => ({ mode: 'auto' }),
    admitRapid: async () => ({ allowed }), observeRapid: async () => {} } })
  const first = await h.invoke()
  allowed = false
  await assert.rejects(h.invoke({ platform: 'facebook', query: 'Unitree', count: 20, cursor: first.body.data.page.nextCursor },
    'facebook-pinned-capacity'), { code: 'search_restart_required' })
  assert.deepEqual(h.calls.map(row => row.provider), ['rapidapi'])
  assert.equal(h.oldCalls(), 0)
})

test('capabilities expose Hub-owned Facebook search separately from unmigrated operations', async () => {
  const h = await harness()
  h.service.externalFacebookCapabilities = async () => ({ ready: true })
  const result = await h.service.capabilities(h.context)
  const row = result.data.platforms.find(row => row.platform === 'facebook')
  assert.equal(row.search.ready, true)
  assert.equal(row.search.source, 'hub')
  assert.equal(row.ready, false)
  h.service.externalFacebookCapabilities = async () => ({ ready: false })
  assert.equal((await h.service.capabilities(h.context)).data.platforms.find(row => row.platform === 'facebook').search.ready, false)
  assert.equal(h.calls.length, 0)
  assert.equal(h.oldCalls(), 0)
})

test('HTTP aliases share immutable delivery and policy endpoints require the Admin token', async t => {
  const h = await harness()
  const app = createApp({ service: h.service, store: h.usage, adminToken: ADMIN,
    platformSearchPolicyStore: { list: async () => [{ platform: 'facebook' }], update: async (_, body) => body } })
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close())
  const origin = `http://127.0.0.1:${server.address().port}`
  const headers = { authorization: `Bearer ${h.key.secret}`, 'content-type': 'application/json', 'idempotency-key': 'facebook-http-alias' }
  const bodies = []
  for (const path of ['/api/v1/night-all/search/raw', '/api/v1/search/raw']) {
    const response = await fetch(origin + path, { method: 'POST', headers, body: JSON.stringify({ platform: 'facebook', query: 'Unitree', count: 20 }) })
    assert.equal(response.status, 200); bodies.push(await response.json())
  }
  assert.deepEqual(bodies[0], bodies[1]); assert.equal(h.calls.length, 1)
  assert.notEqual((await fetch(origin + '/internal/v1/admin/platform-search-policies', { headers })).status, 200)
  assert.equal((await fetch(origin + '/internal/v1/admin/platform-search-policies', { headers: { 'x-mx-insight-admin-token': ADMIN } })).status, 200)
})

test('credential bootstrap preserves configured and deliberately cleared credentials and is idempotent', async () => {
  const states = { rapidapi: { revision: 0, credentialConfigured: false, source: 'environment' }, justone: { revision: 2, credentialConfigured: true, source: 'database' } }
  const writes = [], reads = []
  const options = { fetchImpl: async (url, input) => {
    const provider = url.includes('/rapidapi') ? 'rapidapi' : 'justone'
    if (input.method === 'PUT') { writes.push(provider); states[provider] = { revision: 1, credentialConfigured: true, source: 'database' }; return Response.json({ data: states[provider] }) }
    return Response.json({ data: { credential: states[provider] } })
  }, readCredentials: async (_, { providers }) => { reads.push(...providers); return { rapidapi: 'fixture-key' } } }
  await migrateFacebookCredentials({ MX_INSIGHT_ADMIN_TOKEN: ADMIN }, options)
  await migrateFacebookCredentials({ MX_INSIGHT_ADMIN_TOKEN: ADMIN }, options)
  assert.deepEqual(reads, ['rapidapi']); assert.deepEqual(writes, ['rapidapi'])
  states.rapidapi.credentialConfigured = false
  await migrateFacebookCredentials({ MX_INSIGHT_ADMIN_TOKEN: ADMIN }, options)
  assert.deepEqual(writes, ['rapidapi'])
})

test('RapidAPI billing headers are separate from short rate windows', () => {
  assert.equal(rapidQuotaObservation(new Response('', { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2' } })).remaining, null)
  const v = rapidQuotaObservation(new Response('', { status: 429, headers: { 'x-ratelimit-requests-remaining': '0', 'x-ratelimit-requests-reset': '80000', 'retry-after': '20' } }))
  assert.equal(v.remaining, 0); assert.equal(v.resetSeconds, 80000); assert.equal(v.retryAfterSeconds, 20)
})

test('a completed Facebook quota observation is not repeated during response cleanup', async () => {
  for (const rapidStatus of [200, 429]) {
    const h = await harness({ rapidStatus })
    const first = await h.invoke()
    assert.equal(first.status, 200)
    assert.equal(h.observations.length, 1)
    assert.equal(h.observations[0].status, rapidStatus)
    assert.deepEqual((await h.invoke()).body, first.body)
    assert.equal(h.observations.length, 1)
  }
})

test('a quota-store write failure preserves successful and rejected receipts without a paid retry', async () => {
  for (const rapidStatus of [200, 429]) {
    const h = await harness({ rapidStatus })
    let observations = 0
    h.policyStore.observeRapid = async () => { observations++; throw new Error('synthetic quota storage failure') }
    const first = await h.invoke()
    assert.deepEqual(h.calls.map(row => row.provider), rapidStatus === 429 ? ['rapidapi', 'justone'] : ['rapidapi'])
    assert.equal([...h.stores.rapidapi.calls.values()][0].outcome, rapidStatus === 429 ? 'rejected' : 'succeeded')
    assert.equal(observations, 1, 'cleanup must not release an uncertain quota lease')
    assert.deepEqual((await h.invoke()).body, first.body)
    assert.equal(h.calls.length, rapidStatus === 429 ? 2 : 1)
  }
})

test('confirmed Facebook 429 with an unreadable body still switches once and preserves one request', async () => {
  const h = await harness({ rapidStatus: 429 })
  const originalFetch = h.gateways.rapidapi.adapter.fetch
  h.gateways.rapidapi.adapter.fetch = async (...args) => {
    await originalFetch(...args)
    return new Response(new Uint8Array([0xff]), { status: 429, headers: { 'x-ratelimit-requests-remaining': '0' } })
  }
  const first = await h.invoke()
  assert.deepEqual(h.calls.map(row => row.provider), ['rapidapi', 'justone'])
  const rapid = [...h.stores.rapidapi.calls.values()][0], fallback = [...h.stores.justone.calls.values()][0]
  assert.equal(rapid.outcome, 'rejected')
  assert.equal(rapid.usageRequestId, fallback.usageRequestId)
  assert.equal(first.body.data.meta.upstreamCallCount, 2)
  assert.equal(h.observations[0].remaining, 0)
  assert.deepEqual((await h.invoke()).body, first.body)
  assert.equal(h.calls.length, 2)
})

test('RapidAPI local rate limits allow auto first pages to use JustOne, never pinned cursors or forced mode', async () => {
  const deny = async () => ({ allowed: false, retryAfterMs: 1000 })
  const automatic = await harness()
  automatic.stores.rapidapi.acquireProviderRateLimit = deny
  const first = await automatic.invoke()
  assert.deepEqual(automatic.calls.map(row => row.provider), ['justone'])
  assert.equal(first.body.data.meta.upstreamCallCount, 1)
  assert.equal(automatic.stores.rapidapi.calls.size, 0)
  const forced = await harness({ mode: 'rapidapi' })
  forced.stores.rapidapi.acquireProviderRateLimit = deny
  await assert.rejects(forced.invoke(), { code: 'external_platform_rate_limited' })
  assert.equal(forced.calls.length, 0)
  const pinned = await harness({ hasMore: true })
  const page = await pinned.invoke()
  pinned.stores.rapidapi.acquireProviderRateLimit = deny
  await assert.rejects(pinned.invoke({ platform: 'facebook', query: 'Unitree', count: 20,
    cursor: page.body.data.page.nextCursor }, 'facebook-rate-pinned-page2'), { code: 'external_platform_rate_limited' })
  assert.deepEqual(pinned.calls.map(row => row.provider), ['rapidapi'])
})

test('PostgreSQL fallback preserves one usage identity, two raw receipts and one ingest job', { skip: !process.env.MX_FACEBOOK_TEST_DATABASE_URL }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.MX_FACEBOOK_TEST_DATABASE_URL })
  try {
    const h = await harness({ pool, rapidStatus: 429 })
    const first = await h.invoke()
    assert.deepEqual((await h.invoke()).body, first.body)
    assert.equal(h.calls.length, 2)
    const usages = (await pool.query('SELECT status,units_actual FROM usage_requests WHERE id=$1', [first.requestId])).rows
    assert.equal(usages.length, 1); assert.equal(usages[0].status, 'committed'); assert.equal(Number(usages[0].units_actual), 1)
    const calls = (await pool.query(`SELECT provider_key,outcome,usage_request_id,call_ordinal FROM external_platform.provider_calls
      WHERE usage_request_id=$1 ORDER BY call_ordinal`, [first.requestId])).rows
    assert.deepEqual(calls.map(row => [row.provider_key, row.outcome]), [['rapidapi', 'rejected'], ['justone', 'succeeded']])
    const archives = await pool.query(`SELECT count(*)::int n FROM control.external_platform_restricted_raw_responses raw
      JOIN external_platform.provider_calls call ON call.id=raw.provider_call_id WHERE call.usage_request_id=$1`, [first.requestId])
    assert.equal(archives.rows[0].n, 2)
    const jobs = await pool.query("SELECT payload FROM mxq.jobs WHERE payload->>'requestId'=$1", [first.requestId])
    assert.equal(jobs.rows.length, 1)
    assert.equal(jobs.rows[0].payload.records.length, 1)
    assert.equal(jobs.rows[0].payload.platform, 'facebook')
    assert.equal(h.oldCalls(), 0)
  } finally { await pool.end() }
})

test('PostgreSQL quota serializes replicas, recovers from reset/probes and audits policy CAS', { skip: !process.env.MX_FACEBOOK_TEST_DATABASE_URL }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.MX_FACEBOOK_TEST_DATABASE_URL })
  try {
    assert.match((await pool.query('SELECT current_database() name')).rows[0].name, /^mx_facebook_test_/)
    const sql = await readFile(new URL('../../migrations/143_facebook_platform_search.sql', import.meta.url), 'utf8')
    await pool.query('CREATE SCHEMA IF NOT EXISTS control')
    await pool.query(sql.slice(sql.indexOf('CREATE TABLE'), sql.indexOf('ALTER TABLE')))
    for (const [column, migration] of [['billing_cycle_day', '149_facebook_billing_window.sql'], ['waiters', '151_facebook_rapid_admission_queue.sql'], ['supplier_remaining', '169_facebook_supplier_quota.sql']]) {
      const table = ['waiters', 'supplier_remaining'].includes(column) ? 'facebook_rapid_quota' : 'platform_search_policies'
      const present = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='control' AND table_name=$1 AND column_name=$2`, [table, column])
      if (!present.rowCount) await pool.query(await readFile(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8'))
    }
    const store = new PlatformSearchPolicyStore(pool)
    const results = await Promise.all(Array.from({ length: 20 }, () => store.admitRapid()))
    assert.equal(results.filter(r => r.allowed).length, 1)
    const first = results.find(r => r.allowed)
    await store.observeRapid(first, { ok: true, remaining: 0, resetSeconds: 3600 })
    assert.equal((await store.admitRapid()).allowed, false)
    await pool.query("UPDATE control.facebook_rapid_quota SET reset_at=now()-interval '1 second'")
    const reset = await store.admitRapid(); assert.equal(reset.allowed, true); assert.equal(reset.probe, true)
    await store.observeRapid(reset, { ok: true, remaining: 999 })
    await pool.query("UPDATE control.facebook_rapid_quota SET used=1000, remaining=0, reset_at=now()-interval '1 second'")
    const probes = await Promise.all(Array.from({ length: 12 }, () => store.admitRapid()))
    assert.equal(probes.filter(r => r.allowed).length, 1)
    const probe = probes.find(r => r.allowed); assert.equal(probe.probe, true)
    await store.observeRapid(probe, { ok: true })
    assert.equal((await store.admitRapid()).allowed, false, 'HTTP 200 alone can mean a billed overage')
    await pool.query("UPDATE control.facebook_rapid_quota SET reset_at=now()-interval '1 second'")
    await store.observeRapid(await store.admitRapid(), { ok: true, remaining: 998, resetSeconds: 2500000 })
    assert.equal((await store.facebook()).used, 1002)
    const policy = await store.facebook()
    const update = { mode: 'justone', monthlyLimit: 900, probeIntervalHours: 72, expectedRevision: policy.revision, reason: 'Test audited change' }
    await store.update('facebook', update)
    await assert.rejects(store.update('facebook', update), { code: 'platform_search_revision_conflict' })
    assert.equal((await store.admitRapid()).allowed, false)
    assert.equal((await pool.query("SELECT count(*)::int n FROM control.platform_search_policy_events WHERE platform='facebook'")).rows[0].n, 2)
  } finally { await pool.end() }
})

test('PostgreSQL recovery probe preserves unknown procurement cost', { skip: !process.env.MX_FACEBOOK_TEST_DATABASE_URL }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.MX_FACEBOOK_TEST_DATABASE_URL })
  try {
    const h = await harness({ pool, policyStore: { facebook: async () => ({ mode: 'auto' }),
      admitRapid: async () => ({ allowed: true, probe: true }), observeRapid: async () => {} } })
    const result = await h.invoke()
    const { rows: [call] } = await pool.query('SELECT billed,cost_minor,cost_kind FROM external_platform.provider_calls WHERE usage_request_id=$1', [result.requestId])
    assert.equal(call.billed, null)
    assert.equal(call.cost_minor, null)
    assert.equal(call.cost_kind, 'unknown')
    assert.equal(h.calls.length, 1)
  } finally { await pool.end() }
})
