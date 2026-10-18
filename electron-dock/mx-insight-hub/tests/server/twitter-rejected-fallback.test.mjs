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
import { compileTwitterSearchQuery } from '../../server/contracts/twitter-search-query.mjs'
import { twitterDeliveryLeases } from '../../server/external-platforms/twitter-delivery-leases.mjs'

const pepper = 'offline-twitter-rejected-fallback-integration-fixture'
const priority = { mode: 'priority', primaryProvider: 'rapidapi', fallbackProvider: 'tikhub' }
const fixed = provider => ({ mode: 'fixed', primaryProvider: provider, fallbackProvider: null })
const query = '("外交" OR "外交部") AND NOT ("广告" OR "营销") AND (("diplomacy" OR "foreign policy") AND ("statement" OR "update") -ad -marketing -repost)'
const BODY = { platform: 'twitter', query, pageSize: 1, type: 'stable' }
const WINDOW = { from: '2026-10-18T00:00:00.000Z', to: '2026-10-19T00:00:00.000Z', timezone: 'Asia/Shanghai', boundary: '[from,to)' }
const post = id => ({ rest_id: String(id), legacy: { full_text: `Fixture ${id}`, created_at: 'Sun Oct 18 05:00:00 +0000 2026' } })
const timeline = (ids, next) => ({ entries: [
  ...ids.map(id => ({ content: { itemContent: { tweet_results: { result: post(id) } } } })),
  ...(next ? [{ content: { cursorType: 'Bottom', value: next } }] : []),
] })
const tikPost = id => ({ tweet_id: String(id), text: `Fixture ${id}`, created_at: 'Sun Oct 18 05:00:00 +0000 2026',
  user_info: { rest_id: '1999999999999999999', screen_name: 'fixture' }, favorites: 0, replies: 0, retweets: 0, views: '1' })
const rejection = status => Response.json({ message: 'Synthetic supplier refusal' }, { status })
const page = (provider, ids = [101, 102], next = 'provider-page-two') => Response.json(provider === 'rapidapi'
  ? timeline(ids, next) : { code: 200, data: { timeline: ids.map(tikPost), next_cursor: next } })

async function fixture(initialPolicy = priority) {
  const usage = new MemoryStore(), service = new HubService({ store: usage, apiKeyPepper: pepper })
  const tenant = await service.createTenant({ name: 'Synthetic fallback fixture' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Existing standard Twitter caller' })
  await usage.setPlatformGrant(consumer.id, 'twitter', true)
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Twitter only', platforms: ['twitter'], capabilities: [] })
  const context = await service.authenticate(key.secret)
  let policy = structuredClone(initialPolicy), policyError = null
  const policyStore = { async get(operation, platform) {
    if (policyError) throw policyError
    assert.equal(operation, 'search'); assert.equal(platform, 'twitter'); return structuredClone(policy)
  } }
  const controls = new MemoryExternalPlatformControlStore()
  const config = { configured: true, dispatchEnabled: true, contractVerified: true, timeoutMs: 100,
    freshTtlMs: 60000, staleTtlMs: 86400000, maxConcurrency: 3, maxConsumerConcurrency: 3, maxRequestsPerMinute: 100, billing: {} }
  const calls = { rapidapi: 0, tikhub: 0 }, wires = [], gateways = {}, stores = {}, commits = [], diagnostics = []
  const commit = usage.commitRequest.bind(usage)
  usage.commitRequest = async (id, input) => { commits.push({ id, status: input.responseStatus }); return commit(id, input) }
  let reply = async (provider, ordinal) => provider === 'rapidapi' ? rejection(400)
    : page(provider, ordinal === 1 ? [101, 102] : [103], ordinal === 1 ? 'provider-page-two' : null)
  for (const provider of ['rapidapi', 'tikhub']) {
    const operation = provider === 'rapidapi' ? 'social.content.search' : 'native.t.twitter_web_fetch_search_timeline'
    const endpoint = provider === 'rapidapi' ? 'twitter-aio.search' : operation
    await controls.updatePolicy(provider, operation, { expectedRevision: 1, desiredState: 'active', reason: 'Offline fixture',
      priceBook: { currency: 'USD', pricingAsOf: '2026-10-18T00:00:00Z', monthlyBudgetMinor: 100000,
        monthlySubsidyBudgetMinor: 100000, unitCostMinorByEndpoint: { [endpoint]: 1 } } },
    { runtime: { config, credentialConfigured: true } })
    const fetchImpl = async url => {
      calls[provider]++
      const wire = new URL(url); wires.push({ provider, url: wire })
      return reply(provider, calls[provider], wire)
    }
    const adapter = provider === 'rapidapi' ? new RapidApiAdapter({ apiKey: 'synthetic-only', timeoutMs: 100, fetchImpl })
      : new TikHubAdapter({ apiKey: 'synthetic-only', timeoutMs: 100, fetchImpl })
    stores[provider] = new MemoryExternalPlatformStore({ usageStore: usage, providerKey: provider, authorizationPlatform: 'twitter' })
    gateways[provider] = new ExternalPlatformGateway({ usageStore: usage, platformStore: stores[provider], adapter,
      config: { ...config }, providerKey: provider, apiKeyPepper: pepper, operationControlStore: controls,
      reservationLeaseMs: 120000, logger: { warn(...args) { diagnostics.push(args) }, error(...args) { diagnostics.push(args) } } })
  }
  service.externalDataSearch = createTwitterSearchRouter({ usageStore: usage, rapidGateway: gateways.rapidapi,
    tikHubGateway: gateways.tikhub, apiKeyPepper: pepper, policyStore,
    resolveProvider: async () => (await resolveTwitterSearchProvider({ policy: await policyStore.get('search', 'twitter'),
      capabilities: async () => ({ ready: true }) })).provider })
  const providerCalls = () => Object.values(stores).flatMap(store => [...store.calls.values()])
  return { usage, service, context, calls, wires, gateways, stores, commits, providerCalls, diagnostics,
    setPolicy(next) { policy = structuredClone(next) }, setPolicyError(error) { policyError = error }, setReply(next) { reply = next },
    invoke: (body = BODY, idempotencyKey = 'fallback-first-page', version = 1) => service.search(context,
      { path: `/api/v${version}/data/search`, body, idempotencyKey }) }
}

for (const version of [1, 2]) test(`v${version}: first RapidAPI 400 falls back in the same request; conditions, settlement, replay and TikHub continuation stay intact`, async () => {
  const f = await fixture(), body = { ...BODY, ...(version === 2 ? { timeWindow: WINDOW } : {}) }, original = structuredClone(body)
  const first = await f.invoke(body, `fallback-v${version}-first`, version).catch(error => {
    error.message += `; workflow diagnostics=${JSON.stringify(f.diagnostics)}`
    throw error
  })
  assert.equal(first.status, 200)
  assert.deepEqual(first.body.data.items.map(item => item.id), ['101'])
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 1 })
  assert.deepEqual(body, original)
  assert.equal(f.usage.requests.size, 1, 'Fallback must not reserve a second customer request')
  const saved = f.usage.requests.get(first.requestId)
  assert.equal(saved.status, 'committed')
  assert.equal(saved.acquisitionRequest.searchProvider, 'tikhub')
  assert.equal(saved.acquisitionRequest.body.query, body.query)
  assert.deepEqual(f.commits, [{ id: first.requestId, status: 200 }], 'Only the final delivery settles the request')
  const calls = f.providerCalls().sort((a, b) => a.callOrdinal - b.callOrdinal)
  assert.equal(calls.length, 2)
  assert.ok(calls.every(call => call.usageRequestId === first.requestId))
  assert.deepEqual(calls.map(call => [call.providerKey, call.callOrdinal, call.outcome, call.httpStatus]),
    [['rapidapi', 0, 'rejected', 400], ['tikhub', 1, 'succeeded', 200]])
  const providerQuery = compileTwitterSearchQuery(query).providerQuery
  assert.equal(decodeURIComponent(f.wires[0].url.pathname.slice('/search/'.length)), providerQuery)
  assert.equal(f.wires[1].url.searchParams.get('keyword'), providerQuery)
  assert.equal(f.wires[0].url.searchParams.get('count'), '1')
  assert.equal(f.wires[0].url.searchParams.get('category'), 'Top')
  assert.equal(f.wires[1].url.searchParams.get('search_type'), 'Top')
  if (version === 2) {
    assert.equal(first.body.data.meta.effectiveWindow.deliveryFiltering, 'exact')
    assert.equal(first.body.data.meta.effectiveWindow.from, WINDOW.from)
    assert.equal(first.body.data.meta.effectiveWindow.to, WINDOW.to)
  }
  const replay = await f.invoke(body, `fallback-v${version}-first`, version)
  assert.equal(replay.requestId, first.requestId); assert.deepEqual(replay.body, first.body)
  await assert.rejects(f.invoke({ ...body, query: 'a different query' }, `fallback-v${version}-first`, version), { code: 'idempotency_conflict' })
  const otherVersion = version === 1 ? 2 : 1
  await assert.rejects(f.invoke({ ...BODY, ...(otherVersion === 2 ? { timeWindow: WINDOW } : {}) },
    `fallback-v${version}-first`, otherVersion), { code: 'idempotency_conflict' })
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 1 })
  f.setPolicy(fixed('rapidapi'))
  const secondBody = { ...body, cursor: first.body.data.pageInfo.nextCursor }
  const second = await f.invoke(secondBody, `fallback-v${version}-second`, version)
  assert.deepEqual(second.body.data.items.map(item => item.id), ['102'])
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 1 }, 'Page two comes from the paid TikHub buffer')
  assert.deepEqual((await f.invoke(secondBody, `fallback-v${version}-second`, version)).body, second.body)
  const third = await f.invoke({ ...body, cursor: second.body.data.pageInfo.nextCursor }, `fallback-v${version}-third`, version)
  assert.deepEqual(third.body.data.items.map(item => item.id), ['103'])
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 2 }, 'Exhausted buffers continue with TikHub despite a changed default')
  assert.equal(f.wires.at(-1).url.searchParams.get('cursor'), 'provider-page-two')
  assert.equal(f.wires.at(-1).url.searchParams.get('keyword'), providerQuery)
})

for (const policy of [fixed('rapidapi'), { mode: 'priority', primaryProvider: 'tikhub', fallbackProvider: 'rapidapi' }]) {
  test(`${policy.mode}/${policy.primaryProvider}: a 400 cannot use an unconfigured fallback direction`, async () => {
    const f = await fixture(policy)
    f.setReply(async () => rejection(400))
    await assert.rejects(f.invoke(), error => error.status === 502)
    assert.deepEqual(f.calls, { rapidapi: policy.primaryProvider === 'rapidapi' ? 1 : 0, tikhub: policy.primaryProvider === 'tikhub' ? 1 : 0 })
    assert.deepEqual(f.providerCalls().map(call => [call.providerKey, call.httpStatus]), [[policy.primaryProvider, 400]])
  })
}

for (const outcome of [401, 403, 404, 429, 500, 'timeout', 'unusable', 'truncated400']) {
  test(`RapidAPI ${outcome} never triggers the HTTP400 fallback`, async () => {
    const f = await fixture()
    f.setReply(async provider => {
      assert.equal(provider, 'rapidapi', 'No TikHub request is authorized by this result')
      if (outcome === 'timeout') throw new DOMException('Synthetic timeout', 'TimeoutError')
      if (outcome === 'unusable') return Response.json({ unexpected: true })
      if (outcome === 'truncated400') return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{"message":')); controller.error(new Error('Synthetic body read failure'))
      } }), { status: 400 })
      return rejection(outcome)
    })
    await assert.rejects(f.invoke())
    assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 0 })
    if (['timeout', 'truncated400', 500].includes(outcome)) {
      assert.equal([...f.usage.requests.values()][0].status, 'unknown')
    }
  })
}

test('a RapidAPI continuation 400 never restarts the search on TikHub', async () => {
  const f = await fixture()
  f.setReply(async (provider, ordinal) => ordinal === 1 ? page(provider, [101], 'rapid-page-two') : rejection(400))
  const first = await f.invoke()
  assert.equal(first.status, 200)
  await assert.rejects(f.invoke({ ...BODY, cursor: first.body.data.pageInfo.nextCursor }, 'fallback-rapid-continuation'),
    error => error.details?.upstreamStatus === 400)
  assert.deepEqual(f.calls, { rapidapi: 2, tikhub: 0 })
})

test('a later RapidAPI fill rejection never mixes TikHub into an already acquired page', async () => {
  const f = await fixture(), body = { ...BODY, pageSize: 2 }
  f.setReply(async (provider, ordinal) => ordinal === 1 ? page(provider, [101], 'rapid-fill-two') : rejection(400))
  await f.invoke(body).catch(error => assert.equal(error.details?.upstreamStatus, 400))
  assert.deepEqual(f.calls, { rapidapi: 2, tikhub: 0 })
  assert.equal(f.providerCalls().length, 2)
})

for (const change of [{ ...fixed('rapidapi'), mode: 'paused' }, fixed('rapidapi'),
  { mode: 'priority', primaryProvider: 'tikhub', fallbackProvider: 'rapidapi' }]) {
  test(`policy changed to ${change.mode}/${change.primaryProvider} after RapidAPI dispatch prevents fallback acquisition`, async () => {
    const f = await fixture()
    f.setReply(async provider => { assert.equal(provider, 'rapidapi'); f.setPolicy(change); return rejection(400) })
    await assert.rejects(f.invoke())
    assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 0 })
    assert.ok([...f.usage.requests.values()].every(row => row.status !== 'unknown'), 'A known rejection and policy change do not become transport unknown')
    assert.ok(f.providerCalls().every(call => call.outcome === 'rejected'))
  })
}

for (const version of [1, 2]) test(`v${version}: TikHub unknown after the saved RapidAPI 400 blocks same key, new key and cross-version acquisition`, async () => {
  const f = await fixture(), body = { ...BODY, ...(version === 2 ? { timeWindow: WINDOW } : {}) }
  f.setReply(async provider => {
    if (provider === 'rapidapi') return rejection(400)
    throw new DOMException('Synthetic TikHub timeout', 'TimeoutError')
  })
  await assert.rejects(f.invoke(body, `unknown-v${version}-first`, version))
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 1 })
  assert.equal(f.usage.requests.size, 1)
  const row = [...f.usage.requests.values()][0]
  assert.equal(row.status, 'unknown')
  assert.equal(row.acquisitionRequest.searchProvider, 'tikhub')
  assert.deepEqual(f.providerCalls().map(call => [call.providerKey, call.outcome]), [['rapidapi', 'rejected'], ['tikhub', 'unknown']])
  for (const [retryVersion, key] of [[version, `unknown-v${version}-first`], [version, `unknown-v${version}-new-key`],
    [version === 1 ? 2 : 1, `unknown-v${version}-other-api`]]) {
    const retryBody = { ...BODY, ...(retryVersion === 2 ? { timeWindow: WINDOW } : {}) }
    await assert.rejects(f.invoke(retryBody, key, retryVersion), error =>
      ['request_outcome_unknown', 'search_admission_blocked'].includes(error.code))
  }
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 1 })
  assert.equal(f.usage.requests.get(row.id).status, 'unknown')
})

test('an already completed historical RapidAPI 400 retains its exact error after enabling priority fallback', async () => {
  const f = await fixture(fixed('rapidapi'))
  let first
  await assert.rejects(f.invoke(), error => { first = error; return error.details?.upstreamStatus === 400 })
  const saved = structuredClone([...f.usage.requests.values()][0])
  f.setPolicy(priority)
  await assert.rejects(f.invoke(), error => error.code === first.code && error.status === first.status
    && error.details.requestId === first.details.requestId && error.details.upstreamStatus === 400)
  assert.deepEqual(f.usage.requests.get(saved.id), saved)
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 0 })
})

test('a TikHub refusal ends the one-shot fallback and exact retries replay it without another supplier request', async () => {
  const f = await fixture()
  f.setReply(async () => rejection(400))
  let first
  await assert.rejects(f.invoke(), error => { first = error; return error.status === 502 })
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 1 })
  assert.equal(f.usage.requests.size, 1)
  const saved = structuredClone([...f.usage.requests.values()][0])
  assert.equal(saved.status, 'committed')
  assert.equal(saved.acquisitionRequest.searchProvider, 'tikhub')
  await assert.rejects(f.invoke(), error => error.code === first.code && error.status === first.status
    && error.details.requestId === first.details.requestId)
  assert.deepEqual(f.usage.requests.get(saved.id), saved)
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 1 })
})

test('while TikHub fallback is in flight the same key and a new key cannot dispatch another acquisition', async () => {
  const f = await fixture()
  let entered, release
  const started = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
  f.setReply(async provider => {
    if (provider === 'rapidapi') return rejection(400)
    entered(); await gate
    return page(provider, [101], null)
  })
  const pending = f.invoke()
  await started
  try {
    for (const key of ['fallback-first-page', 'parallel-new-key']) {
      await assert.rejects(f.invoke(BODY, key), error => ['request_in_progress', 'search_admission_blocked'].includes(error.code))
    }
    assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 1 })
  } finally { release() }
  const result = await pending
  assert.equal(result.status, 200)
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 1 })
})

test('unavailable TikHub before dispatch saves one final failure and same-key retries cannot return to RapidAPI', async () => {
  const f = await fixture()
  const credential = f.gateways.tikhub.adapter.resolveCredential.bind(f.gateways.tikhub.adapter)
  f.gateways.tikhub.adapter.resolveCredential = async () => null
  let first
  await assert.rejects(f.invoke(), error => { first = error; return error.code === 'external_platform_not_configured' })
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 0 })
  const saved = structuredClone([...f.usage.requests.values()][0])
  assert.equal(saved.status, 'committed')
  assert.equal(saved.acquisitionRequest.searchProvider, 'tikhub')
  f.gateways.tikhub.adapter.resolveCredential = credential
  await assert.rejects(f.invoke(), error => error.code === first.code && error.details.requestId === saved.id)
  assert.deepEqual(f.usage.requests.get(saved.id), saved)
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 0 })
})

test('failure to persist the fallback supplier pin leaves the original request unknown without dispatching TikHub', async () => {
  const f = await fixture(), finish = f.stores.rapidapi.finishProviderStep.bind(f.stores.rapidapi)
  f.stores.rapidapi.finishProviderStep = async input => {
    const result = await finish(input), row = f.usage.requests.get(input.delivery.usageRequestId)
    const acquisition = row.acquisitionRequest
    Object.defineProperty(row, 'acquisitionRequest', { configurable: true, enumerable: true,
      get: () => acquisition, set: () => { throw new Error('Synthetic supplier pin persistence failure') } })
    return result
  }
  await assert.rejects(f.invoke(), { code: 'request_outcome_unknown' })
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 0 })
  assert.equal([...f.usage.requests.values()][0].status, 'unknown')
  await assert.rejects(f.invoke(), { code: 'request_outcome_unknown' })
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 0 })
})

test('pausing after the supplier pin but before TikHub dispatch saves the pause and never reissues RapidAPI', async () => {
  const f = await fixture(), acquire = f.stores.tikhub.acquireDispatchLease.bind(f.stores.tikhub)
  f.stores.tikhub.acquireDispatchLease = async input => {
    const lease = await acquire(input)
    f.setPolicy({ ...fixed('rapidapi'), mode: 'paused' })
    return lease
  }
  await assert.rejects(f.invoke(), { code: 'strategy_search_paused' })
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 0 })
  const saved = [...f.usage.requests.values()][0]
  assert.equal(saved.status, 'committed')
  assert.equal(saved.acquisitionRequest.searchProvider, 'tikhub')
  f.setPolicy(priority)
  await assert.rejects(f.invoke(), { code: 'strategy_search_paused' })
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 0 })
})

test('an updated policy revision before the handoff is honored even if its providers remain the same', async () => {
  const f = await fixture({ ...priority, revision: 1 })
  f.setReply(async () => { f.setPolicy({ ...priority, revision: 2 }); return rejection(400) })
  await assert.rejects(f.invoke(), error => error.details?.upstreamStatus === 400)
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 0 })
})

test('the fallback settles exactly one funded customer charge across the two supplier attempts', async () => {
  const f = await fixture()
  await f.service.setTenantBillingProfile(f.context.tenant.id,
    { mode: 'enforced', multiplierPpm: 1000000, defaultUnitPriceMinor: 3, defaultCurrency: 'CNY' }, 'offline-admin')
  await f.service.addTenantCredit(f.context.tenant.id, { amountMinor: 100, currency: 'CNY', reason: 'Offline fixture' },
    { idempotencyKey: 'twitter-fallback-credit', actor: 'offline-admin' })
  const result = await f.invoke()
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 1 })
  const charges = [...f.usage.customerCharges.values()]
  assert.equal(charges.length, 1)
  assert.equal(charges[0].usageRequestId, result.requestId)
  assert.equal(charges[0].status, 'captured')
  assert.equal(charges[0].chargedMinor, 3)
  assert.deepEqual((await f.invoke()).body, result.body)
  assert.deepEqual([...f.usage.customerCharges.values()], charges)
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 1 })
})

test('unpersistable TikHub unknown retains the borrowed parent lease and never releases the original reserved request', async () => {
  const f = await fixture()
  f.setReply(async provider => {
    if (provider === 'rapidapi') return rejection(400)
    f.usage.markRequestUnknown = async () => { throw new Error('Synthetic unavailable status persistence') }
    throw new DOMException('Synthetic timeout', 'TimeoutError')
  })
  await assert.rejects(f.invoke(), { code: 'request_outcome_unknown' })
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 1 })
  const row = [...f.usage.requests.values()][0]
  assert.equal(row.status, 'reserved')
  const lease = [...twitterDeliveryLeases(f.usage).values()].find(value => value.ownerRequestId === row.id)
  assert.ok(lease, 'The parent owner must keep its lease when outcome persistence is unavailable')
  assert.ok(Date.parse(lease.expiresAt) > Date.now())
  await assert.rejects(f.invoke(), error => ['request_outcome_unknown', 'request_in_progress'].includes(error.code))
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 1 })
})

for (const status of [200, 400]) test(`a completed RapidAPI ${status} exact replay remains available while the strategy database is unavailable`, async () => {
  const f = await fixture(status === 400 ? fixed('rapidapi') : priority)
  f.setReply(async provider => status === 400 ? rejection(400) : page(provider, [101], null))
  let first, refusal
  if (status === 400) await assert.rejects(f.invoke(), error => { refusal = error; return error.details?.upstreamStatus === 400 })
  else first = await f.invoke()
  const saved = structuredClone([...f.usage.requests.values()][0])
  f.setPolicy(priority)
  f.setPolicyError(new Error('Synthetic strategy database unavailable; exact replay must not read it'))
  if (status === 400) await assert.rejects(f.invoke(), error => error.code === refusal.code && error.status === refusal.status
    && error.details.requestId === saved.id && error.details.upstreamStatus === 400)
  else {
    const replay = await f.invoke()
    assert.equal(replay.requestId, first.requestId)
    assert.deepEqual(replay.body, first.body)
  }
  assert.deepEqual(f.usage.requests.get(saved.id), saved)
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 0 })
})

for (const platform of ['x', ' Twitter ']) test(`the existing ${JSON.stringify(platform)} alias keeps its caller input and canonical identity through fallback and replay`, async () => {
  const f = await fixture(), body = { ...BODY, platform }, original = structuredClone(body)
  const result = await f.invoke(body)
  assert.equal(result.status, 200)
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 1 })
  assert.deepEqual(body, original)
  const saved = structuredClone(f.usage.requests.get(result.requestId))
  assert.equal(saved.platform, 'twitter')
  assert.equal(saved.acquisitionRequest.body.platform, platform, 'The original input remains audit evidence')
  assert.equal(saved.acquisitionRequest.searchProvider, 'tikhub')
  assert.ok(f.providerCalls().every(call => call.usageRequestId === saved.id && call.fingerprint === saved.fingerprint))
  for (const repeatedBody of [body, { ...body, platform: 'twitter' }]) {
    const replay = await f.invoke(repeatedBody)
    assert.equal(replay.requestId, result.requestId)
    assert.deepEqual(replay.body, result.body)
  }
  assert.deepEqual(f.usage.requests.get(result.requestId), saved)
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 1 })
})
