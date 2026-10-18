import test from 'node:test'
import assert from 'node:assert/strict'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'
import { TikHubAdapter } from '../../server/adapters/tikhub.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { createTwitterSearchRouter, resolveTwitterSearchProvider } from '../../server/data/twitter-search-routing.mjs'

const pepper = 'offline-twitter-strategy-policy-integration-fixture'
const fixed = provider => ({ mode: 'fixed', primaryProvider: provider, fallbackProvider: null })
const BODY = { platform: 'twitter', query: 'strategy fixture', pageSize: 1, type: 'stable' }
const rawPost = id => ({ rest_id: String(id), legacy: { full_text: `Fixture ${id}` } })
const timeline = (ids, next) => ({ entries: [
  ...ids.map(id => ({ content: { itemContent: { tweet_results: { result: rawPost(id) } } } })),
  ...(next ? [{ content: { cursorType: 'Bottom', value: next } }] : []),
] })
const tikPost = id => ({ tweet_id: String(id), text: `Fixture ${id}`, created_at: 'Sun Oct 18 05:00:00 +0000 2026',
  user_info: { rest_id: '1999999999999999999', screen_name: 'fixture' }, favorites: 0, replies: 0, retweets: 0, views: '1' })

async function fixture(initialProvider) {
  const usage = new MemoryStore(), service = new HubService({ store: usage, apiKeyPepper: pepper })
  const tenant = await service.createTenant({ name: 'Strategy fixture' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Existing Twitter caller' })
  await usage.setPlatformGrant(consumer.id, 'twitter', true)
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Twitter only', platforms: ['twitter'], capabilities: [] })
  const context = await service.authenticate(key.secret)
  let policy = fixed(initialProvider), policyReads = 0
  const policyStore = { async get(operation, platform) {
    assert.equal(operation, 'search'); assert.equal(platform, 'twitter'); policyReads++
    return structuredClone(policy)
  } }
  const controls = new MemoryExternalPlatformControlStore()
  const config = { configured: true, dispatchEnabled: true, contractVerified: true, timeoutMs: 100,
    freshTtlMs: 60000, staleTtlMs: 86400000, maxConcurrency: 3, maxConsumerConcurrency: 3, maxRequestsPerMinute: 100, billing: {} }
  const calls = { rapidapi: 0, tikhub: 0 }, gateways = {}, stores = {}
  const ready = { rapidapi: true, tikhub: true }
  let reply = async (provider, ordinal) => ordinal === 1 ? { ids: [101, 102, 103], next: 'provider-page-two' } : { ids: [104, 105], next: null }
  for (const provider of ['rapidapi', 'tikhub']) {
    const operation = provider === 'rapidapi' ? 'social.content.search' : 'native.t.twitter_web_fetch_search_timeline'
    const endpoint = provider === 'rapidapi' ? 'twitter-aio.search' : operation
    await controls.updatePolicy(provider, operation, { expectedRevision: 1, desiredState: 'active', reason: 'Offline fixture',
      priceBook: { currency: 'USD', pricingAsOf: '2026-10-18T00:00:00Z', monthlyBudgetMinor: 100000,
        monthlySubsidyBudgetMinor: 100000, unitCostMinorByEndpoint: { [endpoint]: 1 } } },
    { runtime: { config, credentialConfigured: true } })
    const fetchImpl = async url => {
      calls[provider]++
      const result = await reply(provider, calls[provider], new URL(url))
      return Response.json(provider === 'rapidapi' ? timeline(result.ids, result.next)
        : { code: 200, data: { timeline: result.ids.map(tikPost), next_cursor: result.next } })
    }
    const adapter = provider === 'rapidapi' ? new RapidApiAdapter({ apiKey: 'synthetic-only', timeoutMs: 100, fetchImpl })
      : new TikHubAdapter({ apiKey: 'synthetic-only', timeoutMs: 100, fetchImpl })
    stores[provider] = new MemoryExternalPlatformStore({ usageStore: usage, providerKey: provider, authorizationPlatform: 'twitter' })
    gateways[provider] = new ExternalPlatformGateway({ usageStore: usage, platformStore: stores[provider], adapter,
      config: { ...config }, providerKey: provider, apiKeyPepper: pepper, operationControlStore: controls,
      reservationLeaseMs: 120000, logger: { warn() {}, error() {} } })
  }
  service.externalDataSearch = createTwitterSearchRouter({ usageStore: usage, rapidGateway: gateways.rapidapi,
    tikHubGateway: gateways.tikhub, apiKeyPepper: pepper, policyStore,
    resolveProvider: async () => (await resolveTwitterSearchProvider({ policy: await policyStore.get('search', 'twitter'),
      capabilities: async provider => ({ ready: ready[provider] }) })).provider })
  return { usage, service, context, calls, gateways, stores, ready, policyReads: () => policyReads,
    setPolicy(next) { policy = next }, setReply(next) { reply = next },
    invoke: (body = BODY, idempotencyKey = 'strategy-first-page') => service.search(context,
      { path: '/api/v1/data/search', body, idempotencyKey }) }
}

for (const provider of ['rapidapi', 'tikhub']) {
  test(`${provider}: paused database strategy blocks new acquisition before any supplier HTTP`, async () => {
    const f = await fixture(provider)
    f.setPolicy({ ...fixed(provider), mode: 'paused' })
    await assert.rejects(f.invoke(), { code: 'strategy_search_paused' })
    assert.deepEqual(f.calls, { rapidapi: 0, tikhub: 0 })
    assert.ok([...f.usage.requests.values()].every(row => row.status !== 'unknown'))
    assert.equal(f.stores[provider].calls.size, 0)
  })

  test(`${provider}: pause keeps replay and paid buffers accessible; resume preserves the original supplier after a fixed-policy switch`, async () => {
    const f = await fixture(provider), first = await f.invoke()
    assert.equal(first.status, 200)
    const original = structuredClone(f.usage.requests.get(first.requestId))
    f.setPolicy({ ...fixed(provider), mode: 'paused' })
    const replay = await f.invoke()
    assert.equal(replay.requestId, first.requestId); assert.deepEqual(replay.body, first.body)
    let cursor = first.body.data.pageInfo.nextCursor
    for (const page of [2, 3]) {
      const body = { ...BODY, cursor }, result = await f.invoke(body, `strategy-page-${page}`)
      assert.equal(result.status, 200); assert.equal(result.body.data.items.length, 1)
      assert.equal(f.calls[provider], 1, 'Only already acquired buffered data may be served while paused')
      const repeated = await f.invoke(body, `strategy-page-${page}`)
      assert.equal(repeated.requestId, result.requestId); assert.deepEqual(repeated.body, result.body)
      cursor = result.body.data.pageInfo.nextCursor
    }
    assert.ok(cursor)
    const continuation = { ...BODY, cursor }
    await assert.rejects(f.invoke(continuation, 'strategy-page-four-paused'), { code: 'strategy_search_paused' })
    assert.equal(f.calls[provider], 1)
    assert.ok([...f.usage.requests.values()].every(row => row.status !== 'unknown'))
    const other = provider === 'rapidapi' ? 'tikhub' : 'rapidapi'
    f.setPolicy(fixed(other))
    const resumed = await f.invoke(continuation, 'strategy-page-four-paused')
    assert.equal(resumed.status, 200); assert.equal(resumed.body.data.items[0].id, '104')
    assert.equal(f.calls[provider], 2); assert.equal(f.calls[other], 0)
    assert.deepEqual(f.usage.requests.get(first.requestId), original)
    const fresh = await f.invoke({ ...BODY, query: 'independent strategy fixture' }, 'strategy-new-query')
    assert.equal(fresh.status, 200); assert.equal(f.calls[other], 1, 'A new search must see the changed DB strategy')
  })

  test(`${provider}: pausing during fill retains the acquired partial page and never turns an admission refusal into unknown`, async () => {
    const f = await fixture(provider), body = { ...BODY, pageSize: 2 }
    f.setReply(async () => {
      f.setPolicy({ ...fixed(provider), mode: 'paused' })
      return { ids: [201], next: 'next-after-policy-pause' }
    })
    const result = await f.invoke(body)
    assert.equal(result.status, 200)
    assert.deepEqual(result.body.data.items.map(row => row.id), ['201'])
    assert.equal(result.body.data.status, 'partial')
    assert.equal(result.body.data.pageInfo.hasMore, true)
    assert.ok(result.body.data.pageInfo.nextCursor)
    assert.equal(f.calls[provider], 1)
    assert.equal(f.usage.requests.get(result.requestId).status, 'committed')
    assert.ok([...f.usage.requests.values()].every(row => row.status !== 'unknown'))
    assert.deepEqual((await f.invoke(body)).body, result.body)
    assert.equal(f.calls[provider], 1)
  })

  test(`${provider}: a strategy paused after initial admission is rechecked before dispatch`, async () => {
    const f = await fixture(provider), store = f.stores[provider]
    const acquire = store.acquireDispatchLease.bind(store)
    store.acquireDispatchLease = async (...args) => {
      const lease = await acquire(...args)
      f.setPolicy({ ...fixed(provider), mode: 'paused' })
      return lease
    }
    await assert.rejects(f.invoke(), { code: 'strategy_search_paused' })
    assert.deepEqual(f.calls, { rapidapi: 0, tikhub: 0 })
    assert.equal(store.calls.size, 0)
    assert.ok([...f.usage.requests.values()].every(row => row.status !== 'unknown'))
  })

  test(`${provider}: an expired fresh replay obeys the current pause without erasing its earlier successful receipt`, async () => {
    const f = await fixture(provider), body = { ...BODY, type: 'fresh' }
    const first = await f.invoke(body)
    const saved = f.usage.requests.get(first.requestId)
    saved.completedAt = new Date(Date.now() - 180000).toISOString()
    const historical = structuredClone(saved)
    f.setPolicy({ ...fixed(provider), mode: 'paused' })
    await assert.rejects(f.invoke(body), { code: 'strategy_search_paused' })
    assert.equal(f.calls[provider], 1)
    assert.deepEqual(f.usage.requests.get(first.requestId), historical)
    assert.ok([...f.usage.requests.values()].every(row => row.status !== 'unknown'))
  })
}

test('database priority and fixed policies choose only a ready allowed supplier, and update without reconstructing the router', async () => {
  const f = await fixture('rapidapi')
  f.setPolicy({ mode: 'priority', primaryProvider: 'rapidapi', fallbackProvider: 'tikhub' })
  await f.invoke()
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 0 })
  f.ready.rapidapi = false
  await f.invoke({ ...BODY, query: 'fallback fixture' }, 'strategy-fallback-query')
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 1 })
  f.ready.rapidapi = true
  f.setPolicy(fixed('tikhub'))
  await f.invoke({ ...BODY, query: 'fixed tikhub fixture' }, 'strategy-fixed-query')
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 2 })
  assert.ok(f.policyReads() >= 3)
  const checked = []
  const resolution = await resolveTwitterSearchProvider({ policy: fixed('rapidapi'), capabilities: async provider => {
    checked.push(provider); return { ready: provider === 'tikhub' }
  } })
  assert.equal(resolution.provider, 'rapidapi'); assert.equal(resolution.ready, false)
  assert.deepEqual(checked, ['rapidapi'], 'Fixed selection never silently falls back to another supplier')
})
