import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'
import { TikHubAdapter } from '../../server/adapters/tikhub.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { DispatchQueue } from '../../server/external-platforms/dispatch-queue.mjs'
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
const busyError = 'TWI-BUSY - Temporarily unavailable. You were not charged, please retry in a few seconds.'
const busyResponse = () => Response.json({ code: 'busy', error: busyError }, { status: 409 })
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
    invoke: (body = BODY, idempotencyKey = 'fallback-first-page', version = 1, signal) => service.search(context,
      { path: `/api/v${version}/data/search`, body, idempotencyKey, signal }) }
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
  assert.equal(f.wires[0].url.searchParams.get('category'), 'Latest')
  assert.equal(f.wires[1].url.searchParams.get('search_type'), 'Latest')
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

test('standard Twitter records only int4 business codes and replays each RapidAPI 409 without another dispatch', async () => {
  for (const [code, expected] of [
    ['SUPPLIER_CONFLICT', null], ['2147483648', null], [-2147483649, null], [1.5, null], ['1.0', null],
    ['-2147483648', -2147483648], [2147483647, 2147483647], ['0', 0], ['0409', 409],
    ['0x1ff', 511], ['-0X_80000000', -2147483648], ['0o77', 63], ['0b1_01', 5], ['1_000', 1000], ['0b1__0', null],
  ]) {
    const f = await fixture()
    f.setReply(async () => Response.json({ code }, { status: 409 }))
    const rejected = error => error.status === 502 && error.code === 'social_upstream_rejected' && error.details?.upstreamStatus === 409
    await assert.rejects(f.invoke(), rejected)
    const [call] = f.providerCalls()
    assert.equal(call.businessCode, expected, JSON.stringify(code))
    assert.equal(call.outcome, 'rejected')
    await assert.rejects(f.invoke(), rejected)
    assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 0 })
  }
})

test('v2 replays a known RapidAPI 409 with a textual business code and never switches supplier', async () => {
  const f = await fixture()
  const body = { ...BODY, type: 'fresh', timeWindow: WINDOW }
  f.setReply(async () => Response.json({ code: 'SUPPLIER_CONFLICT' }, { status: 409 }))
  const invoke = () => f.invoke(body, 'v2-textual-conflict', 2)
  const rejected = error => error.status === 502 && error.code === 'social_upstream_rejected'
    && error.details?.upstreamStatus === 409 && error.details.outcome === 'rejected'
  await assert.rejects(invoke(), rejected)
  await assert.rejects(invoke(), rejected)
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 0 })
})

async function enableRequestBilling(f) {
  await f.service.setTenantBillingProfile(f.context.tenant.id,
    { mode: 'enforced', multiplierPpm: 1000000, defaultUnitPriceMinor: 3, defaultCurrency: 'CNY' }, 'offline-admin')
  await f.service.addTenantCredit(f.context.tenant.id, { amountMinor: 100, currency: 'CNY', reason: 'Offline fixture' },
    { idempotencyKey: 'twitter-busy-credit', actor: 'offline-admin' })
}

for (const version of [1, 2]) test(`v${version}: a busy first page retries RapidAPI with identical inputs and one customer charge`, async () => {
  const f = await fixture(priority)
  await enableRequestBilling(f)
  const body = version === 2 ? { ...BODY, timeWindow: WINDOW } : BODY
  const invoke = () => f.invoke(body, 'busy-then-success', version)
  const firstRefusal = Promise.withResolvers()
  let firstAttemptAt
  f.setReply(async (provider, ordinal) => {
    assert.equal(provider, 'rapidapi')
    if (ordinal === 1) {
      firstAttemptAt = performance.now()
      setImmediate(firstRefusal.resolve)
      return busyResponse()
    }
    assert.ok(performance.now() - firstAttemptAt >= 2000, 'Retry must allow the supplier time to recover')
    const [firstCall] = f.providerCalls()
    assert.equal(firstCall.outcome, 'rejected')
    assert.equal(f.stores.rapidapi.restrictedResponseArchives.get(firstCall.id).parsedPayload.code, 'busy')
    assert.equal(f.usage.requests.get(firstCall.usageRequestId).status, 'reserved')
    return page(provider, [101, 102], null)
  })
  const pending = invoke()
  await Promise.race([firstRefusal.promise, pending])
  assert.equal(f.providerCalls()[0].outcome, 'rejected')
  await assert.rejects(invoke(), error => ['request_in_progress', 'search_admission_blocked'].includes(error.code))
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 0 })
  const result = await pending
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.data.items.map(item => item.id), ['101'])
  assert.equal(result.body.data.meta.providerCalls, 2)
  assert.deepEqual(f.calls, { rapidapi: 2, tikhub: 0 })
  assert.equal(f.wires[0].url.href, f.wires[1].url.href)
  const calls = f.providerCalls()
  assert.deepEqual(calls.map(call => [call.callOrdinal, call.httpStatus, call.usageRequestId]),
    [[0, 409, result.requestId], [1, 200, result.requestId]])
  assert.equal(calls[1].callRole, 'retry')
  const charges = [...f.usage.customerCharges.values()]
  assert.deepEqual(charges.map(charge => [charge.usageRequestId, charge.status, charge.chargedMinor]),
    [[result.requestId, 'captured', 3]])
  const replay = await invoke()
  assert.equal(replay.requestId, result.requestId)
  assert.deepEqual(replay.body, result.body)
  assert.deepEqual(f.commits, [{ id: result.requestId, status: 200 }])
  const bufferedPage = await f.invoke({ ...body, cursor: result.body.data.pageInfo.nextCursor }, 'busy-next-page', version)
  assert.deepEqual(bufferedPage.body.data.items.map(item => item.id), ['102'])
  assert.equal(bufferedPage.body.data.meta.providerCalls, 0)
  assert.deepEqual(f.calls, { rapidapi: 2, tikhub: 0 })
})

test('concurrent Twitter busy retries share a paced queue and leave capacity for fresh searches', async () => {
  const f = await fixture(fixed('rapidapi'))
  f.gateways.rapidapi.adapter.timeoutMs = 10000
  f.gateways.rapidapi.config.timeoutMs = 10000
  const queries = ['alpha', 'beta', 'gamma']
  const firstWave = Promise.withResolvers(), attempts = new Map(), retryStarts = []
  let retriesInFlight = 0, peakRetries = 0
  f.setReply(async (provider, _ordinal, wire) => {
    assert.equal(provider, 'rapidapi')
    const term = decodeURIComponent(wire.pathname.slice('/search/'.length))
    if (term === 'fresh') return page(provider, [201], null)
    assert.ok(queries.includes(term))
    const count = (attempts.get(term) || 0) + 1
    attempts.set(term, count)
    if (count === 1) {
      if (attempts.size === queries.length) setImmediate(firstWave.resolve)
      return busyResponse()
    }
    retryStarts.push(performance.now())
    peakRetries = Math.max(peakRetries, ++retriesInFlight)
    try {
      // A slow first retry spans another dispatch interval. The other two
      // return immediately, exercising pacing separately from serialization.
      if (retryStarts.length === 1) await sleep(3250)
      return page(provider, [202], null)
    } finally { retriesInFlight-- }
  })
  const invoke = term => f.invoke({ ...BODY, query: term }, `paced-retry-${term}`)
  const pending = Promise.all(queries.map(invoke))
  await Promise.race([firstWave.promise, pending])
  assert.equal(f.gateways.rapidapi.active, 0, 'Queued retries must release their ordinary concurrency slots')
  assert.equal((await invoke('fresh')).status, 200)
  assert.equal(retryStarts.length, 0, 'A fresh first page should finish while the busy retries wait')
  assert.ok((await pending).every(result => result.status === 200))
  assert.equal(peakRetries, 1)
  assert.equal(retryStarts.length, 3)
  // Compare dispatches at the adapter boundary, allowing 25 ms between the
  // queue clock and the actual mock call (including timer and DB resolution).
  for (let index = 1; index < retryStarts.length; index++) {
    const elapsed = retryStarts[index] - retryStarts[index - 1]
    assert.ok(elapsed >= 2975, `Consecutive retries started only ${elapsed} ms apart`)
  }
  assert.deepEqual(queries.map(term => attempts.get(term)), [2, 2, 2])
  assert.deepEqual(f.calls, { rapidapi: 7, tikhub: 0 })
})

for (const condition of ['full', 'expired', 'unavailable']) test(`Twitter settles the original busy reply once when its retry queue is ${condition}`, async () => {
  const f = await fixture(fixed('rapidapi'))
  await enableRequestBilling(f)
  f.gateways.rapidapi.config.concurrencyQueue = { maxPending: 1, maxWaitMs: 10000 }
  let now = Date.now(), waits = 0, joins = 0, ahead
  const queue = new DispatchQueue({ clock: () => now, wait: async () => { waits++; now += 11000 } })
  const enter = queue.enter.bind(queue)
  queue.enter = async input => {
    joins++
    if (condition === 'unavailable') throw new Error('Synthetic dispatch queue storage outage')
    if (condition === 'full') {
      ahead = await queue.transition(input.scope, { ...input, type: 'join', id: 'other-request', fingerprint: 'other-request' })
    }
    return enter(input)
  }
  f.stores.rapidapi.twitterBusyRetryQueue = queue
  f.setReply(busyResponse)
  const rejected = error => error.status === 502 && error.code === 'social_upstream_rejected'
    && error.details.reasonCode === 'upstream_service_busy' && error.details.upstreamDispatched === true
  await assert.rejects(f.invoke(), rejected)
  await assert.rejects(f.invoke(), rejected)
  assert.equal(joins, 1, 'Replay should only return the saved busy reply')
  if (condition === 'full') assert.equal(ahead?.kind, 'queued')
  assert.equal(waits, condition === 'expired' ? 1 : 0)
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 0 })
  const [call] = f.providerCalls()
  assert.equal(f.stores.rapidapi.restrictedResponseArchives.get(call.id).parsedPayload.code, 'busy')
  assert.deepEqual(f.commits, [{ id: call.usageRequestId, status: 502 }])
  assert.deepEqual([...f.usage.customerCharges.values()].map(charge => [charge.usageRequestId, charge.status, charge.chargedMinor]),
    [[call.usageRequestId, 'captured', 3]])
})

for (const version of [1, 2]) test(`v${version}: fixed RapidAPI saves two busy receipts and replays the final rejection`, async () => {
  const f = await fixture(fixed('rapidapi'))
  f.setReply(busyResponse)
  const body = version === 2 ? { ...BODY, timeWindow: WINDOW } : BODY
  const invoke = () => f.invoke(body, 'known-twitter-busy', version)
  const rejected = error => {
    assert.equal(error.status, 502)
    assert.equal(error.code, 'social_upstream_rejected')
    assert.equal(error.details.reasonCode, 'upstream_service_busy')
    assert.equal(error.details.upstreamStatus, 409)
    assert.equal(error.details.upstreamDispatched, true)
    assert.equal(error.details.outcome, 'rejected')
    assert.equal(error.details.retryable, false)
    assert.doesNotMatch(JSON.stringify([error.message, error.details]), /not charged/i)
    return true
  }
  await assert.rejects(invoke(), rejected)
  await assert.rejects(invoke(), rejected)
  assert.deepEqual(f.calls, { rapidapi: 2, tikhub: 0 })
  const [saved] = f.usage.requests.values()
  assert.deepEqual(f.commits, [{ id: saved.id, status: 502 }])
  assert.deepEqual(f.providerCalls().map(call => call.callOrdinal), [0, 1])
  for (const call of f.providerCalls()) {
    assert.equal(call.usageRequestId, saved.id)
    assert.equal(call.outcome, 'rejected')
    assert.equal(call.httpStatus, 409)
    assert.equal(call.errorCode, 'upstream_service_busy')
    assert.equal(call.businessCode, null)
    assert.equal(call.billed, null)
    assert.deepEqual(f.stores.rapidapi.restrictedResponseArchives.get(call.id).parsedPayload,
      { code: 'busy', error: busyError })
  }
})

test('a RapidAPI 400 on the busy retry ends the request before TikHub fallback', async () => {
  const f = await fixture(priority)
  f.setReply(async (_provider, ordinal) => ordinal === 1 ? busyResponse() : rejection(400))
  const rejected = error => error.code === 'social_upstream_rejected' && error.details.upstreamStatus === 400
  await assert.rejects(f.invoke(), rejected)
  await assert.rejects(f.invoke(), rejected)
  assert.deepEqual(f.calls, { rapidapi: 2, tikhub: 0 })
  assert.deepEqual(f.providerCalls().map(call => call.httpStatus), [409, 400])
})

test('an unknown result from the RapidAPI busy retry keeps the v2 key unresolved', async () => {
  const f = await fixture(priority)
  f.setReply(async (_provider, ordinal) => {
    if (ordinal === 1) return busyResponse()
    throw new DOMException('Connection ended during the retry', 'TimeoutError')
  })
  const invoke = () => f.invoke({ ...BODY, timeWindow: WINDOW }, 'busy-then-unknown', 2)
  await assert.rejects(invoke(), { code: 'request_outcome_unknown' })
  const [saved] = f.usage.requests.values()
  assert.equal(saved.status, 'unknown')
  assert.deepEqual(f.providerCalls().map(call => [call.callRole, call.outcome]),
    [['primary', 'rejected'], ['retry', 'unknown']])
  await assert.rejects(invoke(), { code: 'request_outcome_unknown' })
  assert.deepEqual(f.calls, { rapidapi: 2, tikhub: 0 })
})

test('insufficient time for both backoff and a second attempt commits the first busy receipt', async () => {
  const f = await fixture(priority)
  // This allows the first 100 ms provider timeout and 5 s commit margin, but not a further 3 s wait.
  f.gateways.rapidapi.reservationLeaseMs = 7000
  f.setReply(busyResponse)
  const rejected = error => error.code === 'social_upstream_rejected' && error.details.reasonCode === 'upstream_service_busy'
  await assert.rejects(f.invoke(), rejected)
  await assert.rejects(f.invoke(), rejected)
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 0 })
  assert.equal([...f.usage.requests.values()][0].status, 'committed')
})

for (const interruption of ['strategy pause', 'switch to fixed TikHub', 'client cancellation']) test(`a ${interruption} during busy backoff saves the original refusal without another dispatch`, async () => {
  const f = await fixture(priority)
  const controller = new AbortController()
  let interruptTimer
  try {
    f.setReply(async () => {
      interruptTimer = setTimeout(() => {
        if (interruption === 'strategy pause') f.setPolicy({ ...priority, mode: 'paused' })
        else if (interruption === 'switch to fixed TikHub') f.setPolicy(fixed('tikhub'))
        else controller.abort()
      }, 50)
      return busyResponse()
    })
    await assert.rejects(f.invoke(BODY, 'busy-interrupted', 1, controller.signal), error =>
      error.code === 'social_upstream_rejected' && error.details.reasonCode === 'upstream_service_busy')
  } finally { clearTimeout(interruptTimer) }
  const [saved] = f.usage.requests.values()
  assert.equal(saved.status, 'committed')
  f.setPolicy(priority)
  await assert.rejects(f.invoke(BODY, 'busy-interrupted'), error => error.code === 'social_upstream_rejected'
    && error.details.requestId === saved.id && error.details.reasonCode === 'upstream_service_busy')
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 0 })
  assert.equal(f.providerCalls()[0].errorCode, 'upstream_service_busy')
})

test('a historical unclassified busy receipt replays its exact original failure after retry support is enabled', async () => {
  const f = await fixture(fixed('rapidapi')), adapter = f.gateways.rapidapi.adapter
  const execute = adapter.execute.bind(adapter)
  f.setReply(busyResponse)
  // Recreate the old adapter's classification while retaining the actual archived busy response.
  adapter.execute = async (...args) => {
    try { return await execute(...args) } catch (error) {
      error.evidence = { ...error.evidence, errorCode: 'social_upstream_rejected', businessCode: 'busy' }
      throw error
    }
  }
  await assert.rejects(f.invoke(), { code: 'social_upstream_rejected' })
  const [saved] = structuredClone([...f.usage.requests.values()])
  assert.equal(f.stores.rapidapi.restrictedResponseArchives.get(f.providerCalls()[0].id).parsedPayload.code, 'busy')
  adapter.execute = execute
  await assert.rejects(f.invoke(), error => error.status === 502 && error.code === 'social_upstream_rejected'
    && error.details?.requestId === saved.id && error.details.reasonCode === undefined)
  assert.deepEqual(f.usage.requests.get(saved.id), saved)
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 0 })
})

test('other errors with a busy code or similar text retain their original rejection', async () => {
  for (const [status, payload] of [
    [409, { code: 'busy' }], [409, { code: 'BUSY', error: busyError }],
    [409, { code: 'busy', error: busyError + ' Extra text.' }], [403, { code: 'busy', error: busyError }],
  ]) {
    const f = await fixture(fixed('rapidapi'))
    f.setReply(async () => Response.json(payload, { status }))
    await assert.rejects(f.invoke(), error => error.code === 'social_upstream_rejected'
      && error.details.upstreamStatus === status && error.details.reasonCode !== 'upstream_service_busy')
    assert.equal(f.providerCalls()[0].errorCode, 'social_upstream_rejected')
    assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 0 })
  }
})

test('a textual RapidAPI 503 remains unknown on standard Twitter and its key cannot redispatch', async () => {
  const f = await fixture()
  f.setReply(async () => Response.json({ code: 'TEMPORARY_FAILURE' }, { status: 503 }))
  await assert.rejects(f.invoke(), { code: 'social_upstream_outcome_unknown' })
  assert.equal([...f.usage.requests.values()][0].status, 'unknown')
  await assert.rejects(f.invoke(), { code: 'request_outcome_unknown' })
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 0 })
})

for (const status of [400, 409]) test(`a RapidAPI continuation ${status} cannot retry the first page or restart on TikHub`, async () => {
  const f = await fixture()
  const refused = status === 409 ? busyResponse : () => rejection(400)
  f.setReply(async (provider, ordinal) => ordinal === 1 ? page(provider, [101], 'rapid-page-two') : refused())
  const first = await f.invoke()
  assert.equal(first.status, 200)
  await assert.rejects(f.invoke({ ...BODY, cursor: first.body.data.pageInfo.nextCursor }, 'fallback-rapid-continuation'),
    error => error.details?.upstreamStatus === status)
  assert.deepEqual(f.calls, { rapidapi: 2, tikhub: 0 })
})

for (const status of [400, 409]) test(`a later RapidAPI fill ${status} cannot retry or mix TikHub into an acquired page`, async () => {
  const f = await fixture(), body = { ...BODY, pageSize: 2 }
  const refused = status === 409 ? busyResponse : () => rejection(400)
  f.setReply(async (provider, ordinal) => ordinal === 1 ? page(provider, [101], 'rapid-fill-two') : refused())
  await f.invoke(body).catch(error => assert.equal(error.details?.upstreamStatus, status))
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

for (const version of [1, 2]) test(`v${version}: TikHub unknown after the saved RapidAPI 400 blocks its same key while new keys and versions acquire again`, async () => {
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
  await assert.rejects(f.invoke(body, `unknown-v${version}-first`, version), { code: 'request_outcome_unknown' })
  assert.deepEqual(f.calls, { rapidapi: 1, tikhub: 1 })
  // Each new key or API version is a new acquisition; the synthetic supplier fails it the same way.
  let expected = 1
  for (const [retryVersion, key] of [[version, `unknown-v${version}-new-key`], [version === 1 ? 2 : 1, `unknown-v${version}-other-api`]]) {
    const retryBody = { ...BODY, ...(retryVersion === 2 ? { timeWindow: WINDOW } : {}) }
    await assert.rejects(f.invoke(retryBody, key, retryVersion), error => ['upstream_outcome_unknown', 'request_outcome_unknown'].includes(error.code))
    expected++
    assert.deepEqual(f.calls, { rapidapi: expected, tikhub: expected })
  }
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
