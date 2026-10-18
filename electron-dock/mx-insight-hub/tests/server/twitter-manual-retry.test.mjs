import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'
import { requestFingerprint } from '../../server/core/crypto.mjs'

const BODY = { platform: 'twitter', query: 'fixture #chipban', pageSize: 2, type: 'stable' }
const timeline = (ids, next = null) => ({ entries: [
  ...ids.map(id => ({ content: { itemContent: { tweet_results: { result: { rest_id: String(id), legacy: { full_text: `Post ${id}` } } } } } })),
  ...(next ? [{ content: { cursorType: 'Bottom', value: next } }] : []),
] })
async function fixture() {
  const usage = new MemoryStore(), service = new HubService({ store: usage, adapter: {}, apiKeyPepper: 'manual-twitter-retry-fixture-pepper' })
  const tenant = await service.createTenant({ name: 'Retry fixture' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Retry consumer' })
  await usage.setPlatformGrant(consumer.id, 'twitter', true)
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Retry Key', platforms: ['twitter'], capabilities: [] })
  const context = await service.authenticate(key.secret)
  const controls = new MemoryExternalPlatformControlStore()
  const config = { configured: true, dispatchEnabled: true, contractVerified: true, timeoutMs: 100,
    freshTtlMs: 60000, staleTtlMs: 86400000, maxConcurrency: 3, maxConsumerConcurrency: 3, maxRequestsPerMinute: 100, billing: {} }
  await controls.updatePolicy('rapidapi', 'social.content.search', { expectedRevision: 1, desiredState: 'active', reason: 'Offline test',
    priceBook: { currency: 'USD', pricingAsOf: '2026-10-15T00:00:00Z', monthlyBudgetMinor: 100000,
      monthlySubsidyBudgetMinor: 100000, unitCostMinorByEndpoint: { 'twitter-aio.search': 1 } } },
  { runtime: { config, credentialConfigured: true } })
  const store = new MemoryExternalPlatformStore({ usageStore: usage, providerKey: 'rapidapi', authorizationPlatform: 'twitter', circuitFailureThreshold: 100 })
  let reply = async () => { throw new Error('Synthetic ambiguous transport') }, calls = 0
  const adapter = new RapidApiAdapter({ apiKey: 'synthetic-only', timeoutMs: 100, fetchImpl: async url => {
    calls++; return Response.json(await reply(new URL(url)))
  } })
  const gateway = new ExternalPlatformGateway({ usageStore: usage, platformStore: store, adapter, config, providerKey: 'rapidapi',
    apiKeyPepper: 'manual-twitter-retry-fixture-pepper', operationControlStore: controls, reservationLeaseMs: 120000, logger: { warn() {}, error() {} } })
  const invoke = (body = BODY, idempotencyKey = 'original-twitter-unknown', retryOfRequestId, caller = context) => gateway.searchRaw(caller, {
    body, normalized: { platform: body.platform === 'x' ? 'twitter' : body.platform, query: body.query.trim(), pageSize: body.pageSize ?? 20,
      ...(body.cursor ? { cursor: body.cursor } : {}) }, idempotencyKey, retryOfRequestId,
    dataSearch: { resultType: body.type ?? 'fresh', replayWindowMs: body.type === 'stable' ? null : 120000 },
  })
  const original = async (body = BODY, key = 'original-twitter-unknown') => {
    await assert.rejects(invoke(body, key), { code: 'social_upstream_outcome_unknown' })
    return [...usage.requests.values()].find(row => row.idempotencyKey === key)
  }
  return { usage, store, gateway, config, context, service, consumer, invoke, original, calls: () => calls,
    reply: next => { reply = next } }
}

test('Twitter explicit retry fills multiple pages, records one successor and replays without touching the unknown hold', async () => {
  const f = await fixture()
  await f.service.setTenantBillingProfile(f.context.tenant.id,
    { mode: 'enforced', multiplierPpm: 1000000, defaultUnitPriceMinor: 1, defaultCurrency: 'CNY' }, 'test-admin')
  await f.service.addTenantCredit(f.context.tenant.id, { amountMinor: 100, currency: 'CNY', reason: 'Offline retry fixture' },
    { idempotencyKey: 'retry-fixture-credit', actor: 'test-admin' })
  const old = await f.original(), savedOld = structuredClone(old), oldCharge = structuredClone(f.usage.customerCharges.get(old.id))
  f.reply(async url => url.searchParams.has('cursor') ? timeline([2]) : timeline([1], 'bottom'))
  const result = await f.invoke(BODY, 'manual-twitter-successor', old.id)
  assert.deepEqual(result.body.data.items.map(item => item.id), ['1', '2'])
  assert.equal(f.calls(), 3)
  const childCalls = [...f.store.calls.values()].filter(call => call.usageRequestId === result.requestId)
  assert.equal(childCalls.length, 2)
  assert.equal(childCalls[0].retryOfRequestId, old.id); assert.equal(childCalls[1].retryOfRequestId, undefined)
  assert.equal(f.store.twitterManualRetries.size, 1)
  assert.deepEqual(f.usage.requests.get(old.id), savedOld)
  assert.deepEqual(f.usage.customerCharges.get(old.id), oldCharge)
  assert.equal(f.usage.customerCharges.get(result.requestId).status, 'captured')
  assert.deepEqual((await f.invoke(BODY, 'manual-twitter-successor', old.id)).body, result.body)
  await assert.rejects(f.invoke(BODY, 'original-twitter-unknown'), { code: 'request_outcome_unknown' })
  await assert.rejects(f.invoke(BODY, 'manual-twitter-other-owner', old.id), { code: 'uncertain_retry_not_allowed' })
  assert.equal(f.calls(), 3)
})

test('Twitter retry requires exact saved scope, a new explicit Key and current contract evidence', async () => {
  const f = await fixture(), old = await f.original()
  f.reply(async () => timeline([1, 2]))
  for (const [body, key, target] of [[BODY, 'missing-target-key', randomUUID()], [{ ...BODY, query: 'changed' }, 'different-query-key', old.id],
    [{ ...BODY, pageSize: 1 }, 'different-count-key', old.id], [{ ...BODY, type: 'fresh' }, 'different-type-key', old.id],
    [BODY, 'original-twitter-unknown', old.id]]) {
    await assert.rejects(f.invoke(body, key, target), { code: 'uncertain_retry_not_allowed' })
  }
  for (const id of ['', 'bad', ['bad']]) await assert.rejects(f.invoke(BODY, 'malformed-retry-key', id), { code: 'invalid_uncertain_retry' })
  await assert.rejects(f.invoke(BODY, '', old.id), { code: 'idempotency_key_required' })
  const otherKey = await f.service.createApiKey({ consumerId: f.consumer.id, name: 'Another Key', platforms: ['twitter'], capabilities: [] })
  await assert.rejects(f.invoke(BODY, 'different-api-key', old.id, await f.service.authenticate(otherKey.secret)), { code: 'uncertain_retry_not_allowed' })
  const call = [...f.store.calls.values()][0]
  call.contractVersion = 'retired-contract'
  await assert.rejects(f.invoke(BODY, 'retired-contract-key', old.id), { code: 'uncertain_retry_not_allowed' })
  assert.equal(f.calls(), 1); assert.equal(f.store.twitterManualRetries?.size ?? 0, 0)
})

test('Twitter latest unknown successor can be explicitly retried while ordinary requests still honor every ancestor', async () => {
  const f = await fixture(), old = await f.original()
  await assert.rejects(f.invoke(BODY, 'first-manual-unknown', old.id), { code: 'social_upstream_outcome_unknown' })
  const first = [...f.usage.requests.values()].find(row => row.idempotencyKey === 'first-manual-unknown')
  assert.equal(first.status, 'unknown')
  f.reply(async () => timeline([1, 2]))
  await assert.rejects(f.invoke(BODY, 'ordinary-after-manual'), { code: 'request_outcome_unknown' })
  const final = await f.invoke(BODY, 'second-manual-retry', first.id)
  assert.equal(final.status, 200); assert.equal(f.calls(), 3)
  assert.equal(f.usage.requests.get(old.id).status, 'unknown'); assert.equal(first.status, 'unknown')
  assert.equal(f.store.twitterManualRetries.size, 2)
  await assert.rejects(f.invoke(BODY, 'ordinary-after-success'), { code: 'request_outcome_unknown' })
})

test('Twitter retry does not exclude unrelated unknown parents or pending/unusable provider calls', async () => {
  for (const blocker of ['unknown', 'pending', 'succeeded_unusable']) {
    const f = await fixture(), old = await f.original(), originalCall = [...f.store.calls.values()][0]
    f.reply(async () => timeline([1, 2]))
    if (blocker === 'unknown') {
      const otherId = randomUUID()
      f.usage.requests.set(otherId, { ...structuredClone(old), id: otherId, idempotencyKey: 'independent-unknown' })
    } else {
      const id = randomUUID()
      const usageId = randomUUID()
      f.usage.requests.set(usageId, { ...structuredClone(old), id: usageId, status: blocker === 'pending' ? 'reserved' : 'committed' })
      f.store.calls.set(id, { ...structuredClone(originalCall), id, usageRequestId: usageId, outcome: blocker,
        completedAt: new Date().toISOString(), errorCode: blocker === 'succeeded_unusable' ? 'invalid_response_json' : null })
    }
    await assert.rejects(f.invoke(BODY, `blocked-${blocker}-manual`, old.id), error => ['request_outcome_unknown', 'request_in_progress', 'external_platform_response_unusable'].includes(error.code), blocker)
    assert.equal(f.calls(), 1); assert.equal(f.store.twitterManualRetries?.size ?? 0, 0)
  }
})

test('Twitter manual retry excludes verified ancestors only, not a same-query TikHub unknown with different page conditions', async () => {
  const f = await fixture(), old = await f.original()
  const body = { ...BODY, pageSize: 40, type: 'fresh' }, id = randomUUID()
  const blocker = { ...structuredClone(old), id, idempotencyKey: 'unrelated-tikhub-query-unknown',
    fingerprint: requestFingerprint({ method: 'POST', path: '/api/v1/data/search', body }),
    acquisitionRequest: { method: 'POST', path: '/api/v1/data/search', body, searchProvider: 'tikhub' } }
  f.usage.requests.set(id, blocker)
  f.reply(async () => timeline([1, 2]))
  await assert.rejects(f.invoke(BODY, 'manual-cross-supplier-retry', old.id),
    error => error.code === 'request_outcome_unknown' && error.details.blockingRequestId === id)
  assert.equal(f.calls(), 1)
  assert.equal(f.store.twitterManualRetries?.size ?? 0, 0)
  assert.equal(f.usage.requests.get(old.id).status, 'unknown')
  assert.equal(f.usage.requests.get(id).status, 'unknown')
})

test('Twitter preflight refusal consumes no manual retry edge', async () => {
  const f = await fixture(), old = await f.original()
  f.store.state.circuitOpenUntil = new Date(Date.now() + 60000).toISOString()
  await assert.rejects(f.invoke(BODY, 'retry-circuit-refused', old.id), { code: 'external_platform_circuit_open' })
  assert.equal(f.store.twitterManualRetries?.size ?? 0, 0)
  assert.equal(f.calls(), 1)
  f.store.state.circuitOpenUntil = null
  f.reply(async () => timeline([1, 2]))
  assert.equal((await f.invoke(BODY, 'retry-after-circuit', old.id)).status, 200)
  assert.equal(f.calls(), 2)
})

test('Twitter simultaneous manual intents have one successor and one acquisition', async () => {
  const f = await fixture(), old = await f.original()
  let entered, release
  const started = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
  f.reply(async () => { entered(); await gate; return timeline([1, 2]) })
  const first = f.invoke(BODY, 'concurrent-manual-first', old.id)
  await started
  await assert.rejects(f.invoke(BODY, 'concurrent-manual-second', old.id), { code: 'uncertain_retry_not_allowed' })
  release()
  const result = await first
  assert.equal(f.calls(), 2)
  assert.equal(await f.store.twitterManualRetryOwnerFor(old.id), result.requestId)
})

test('Twitter buffer-only retry records its unique successor without a fabricated provider call', async () => {
  const f = await fixture()
  f.reply(async () => timeline([1, 2, 3]))
  const first = await f.invoke(BODY, 'buffer-source-first')
  const body = { ...BODY, cursor: first.body.data.pageInfo.nextCursor }
  const commit = f.store.commitTwitterFillDelivery.bind(f.store)
  f.store.commitTwitterFillDelivery = async () => { throw new Error('Synthetic unknown cache commit') }
  await assert.rejects(f.invoke(body, 'buffer-unknown-parent'), { code: 'request_outcome_unknown' })
  const old = [...f.usage.requests.values()].find(row => row.idempotencyKey === 'buffer-unknown-parent')
  assert.equal(old.status, 'unknown')
  f.store.commitTwitterFillDelivery = commit
  const result = await f.invoke(body, 'buffer-manual-successor', old.id)
  assert.deepEqual(result.body.data.items.map(item => item.id), ['3'])
  assert.equal(f.calls(), 1); assert.equal(f.store.calls.size, 1)
  assert.equal(await f.store.twitterManualRetryOwnerFor(old.id), result.requestId)
  assert.deepEqual((await f.invoke(body, 'buffer-manual-successor', old.id)).body, result.body)
  await assert.rejects(f.invoke(body, 'another-buffer-owner', old.id), { code: 'uncertain_retry_not_allowed' })
})

test('Twitter retry fresh success remains immutable after the ordinary fresh window, with or without its header', async () => {
  const f = await fixture(), body = { ...BODY, type: 'fresh' }, old = await f.original(body)
  f.reply(async () => timeline([1, 2]))
  const result = await f.invoke(body, 'fresh-manual-successor', old.id)
  f.usage.requests.get(result.requestId).completedAt = new Date(Date.now() - 180000).toISOString()
  const before = f.usage.requests.size
  for (const retryOf of [old.id, undefined]) {
    const replay = await f.invoke(body, 'fresh-manual-successor', retryOf)
    assert.equal(replay.requestId, result.requestId)
    assert.deepEqual(replay.body, result.body)
  }
  assert.equal(f.usage.requests.size, before); assert.equal(f.calls(), 2)
})

test('Twitter same retry idempotency key remains in-progress while queued before its edge is claimed', async () => {
  const f = await fixture(), old = await f.original()
  f.gateway.active = f.config.maxConcurrency
  f.config.concurrencyQueue = { maxWaitMs: 100, maxPending: 4 }
  const pending = f.invoke(BODY, 'queued-manual-successor', old.id)
  const settled = assert.rejects(pending, { code: 'external_platform_busy' })
  for (let i = 0; i < 50 && !f.gateway.concurrencyQueue.entries.length; i++) await new Promise(resolve => setTimeout(resolve, 1))
  assert.equal(f.gateway.concurrencyQueue.entries.length, 1)
  await assert.rejects(f.invoke(BODY, 'queued-manual-successor', old.id), { code: 'request_in_progress' })
  assert.equal(f.store.twitterManualRetries?.size ?? 0, 0)
  await settled
  assert.equal(f.calls(), 1)
  f.gateway.active = 0
})
