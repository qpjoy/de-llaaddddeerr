import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const PEPPER = 'quota-snapshot-test-pepper-with-entropy'

async function fixture({ consumerMax = 5, keyMax = null } = {}) {
  const store = new MemoryStore()
  const hub = new HubService({ store, adapter: {}, apiKeyPepper: PEPPER })
  const tenant = await hub.createTenant({ name: 'T' })
  const consumer = await hub.createConsumer({ tenantId: tenant.id, name: 'C' })
  await store.setPlatformGrant(consumer.id, 'ecommerce', true)
  await store.putPolicy({
    tenantId: tenant.id,
    consumerId: consumer.id,
    platform: 'ecommerce',
    maxRequests: consumerMax,
    windowSeconds: 3_600,
    maxPageSize: 100,
  })
  const key = await hub.createApiKey({
    consumerId: consumer.id,
    name: 'K',
    platforms: ['ecommerce'],
    ...(keyMax ? { platformQuotas: { ecommerce: { maxRequests: keyMax } } } : {}),
  })
  const context = await hub.authenticate(key.secret)
  const reserve = (n, options) => store.reserve({
    requestId: randomUUID(),
    idempotencyKey: `key-${n}`,
    fingerprint: `fp-${n}`,
    tenantId: tenant.id,
    consumerId: consumer.id,
    apiKeyId: context.apiKey.id,
    platform: 'ecommerce',
    meterKey: 'ecommerce.products.search',
    unitsReserved: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    windowStart: new Date(Date.now() - 3_600_000),
    maxRequests: consumerMax,
    replayWindowMs: null,
    ...options,
  })
  const snapshot = async () => (await store.quotaSnapshot({
    tenantId: tenant.id, consumerId: consumer.id, apiKeyId: context.apiKey.id,
  }))[0]
  return { store, snapshot, reserve }
}

test('opted-in plan burst hint expires the oldest reservation at exactly one second', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const { store, reserve } = await fixture({ consumerMax: 20 })
  const limits = store.plans.find(row => row.key === 'launch-1m').limits
  limits.burstRps = 2
  const waiting = { includePlanBurstRetryAfter: true }
  const rejected = (hint) => error => error.code === 'plan_burst_exceeded' && error.details.retryAfterMs === hint

  await reserve(1)
  t.mock.timers.tick(400)
  await reserve(2)
  await assert.rejects(reserve(3, waiting), rejected(600))
  limits.burstRps = 1
  await assert.rejects(reserve(3, waiting), rejected(1000))
  limits.burstRps = 2
  t.mock.timers.tick(599)
  await assert.rejects(reserve(3, waiting), rejected(1))
  t.mock.timers.tick(1)
  await assert.rejects(reserve(3), rejected(undefined))
  assert.equal(store.requests.size, 2)
  assert.equal((await reserve(3, waiting)).kind, 'reserved')
  assert.equal(store.requests.size, 3)
})

test('remaining reaches zero exactly when admission starts rejecting', async () => {
  const { snapshot, reserve } = await fixture({ consumerMax: 3 })

  assert.equal((await snapshot()).binding.remaining, 3)
  for (let index = 1; index <= 3; index += 1) await reserve(index)

  // The whole view rests on this: a number that disagreed with the admission
  // check would show room where the next call is about to be rejected.
  assert.equal((await snapshot()).binding.remaining, 0)
  await assert.rejects(() => reserve(4), (error) => error.code === 'consumer_quota_exceeded')
})

test('only a fresh opt-in reservation filling a multi-slot plan carries a local scheduling hint', async t => {
  const start = Date.now()
  t.mock.timers.enable({ apis: ['Date'], now: start })
  t.mock.method(performance, 'now', () => 5_000 + Date.now() - start)
  const { store, reserve } = await fixture({ consumerMax: 20 })
  const limits = store.plans.find(row => row.key === 'launch-1m').limits
  const optedIn = { includePlanBurstRetryAfter: true }
  const hasHint = result => Object.hasOwn(result, 'nextPlanBurstSlotAt')

  limits.burstRps = 1
  assert.equal(hasHint(await reserve(1, optedIn)), false)
  t.mock.timers.tick(1_000)
  limits.burstRps = 2
  assert.equal(hasHint(await reserve(2, optedIn)), false)
  t.mock.timers.tick(400)
  const third = await reserve(3, optedIn)
  assert.equal(third.nextPlanBurstSlotAt, performance.now() + 600)
  assert.equal(hasHint(store.requests.get(third.request.id)), false)
  assert.equal(hasHint(await reserve(3, optedIn)), false) // In progress.
  assert.equal(hasHint(await reserve(3, { ...optedIn, fingerprint: 'different' })), false)

  await store.releaseRequest(third.request.id, 'test_release')
  const retried = await reserve(3, optedIn)
  assert.equal(retried.nextPlanBurstSlotAt, third.nextPlanBurstSlotAt)
  await store.commitRequest(retried.request.id, { responseStatus: 200, unitsActual: 1 })
  const replay = await reserve(3, optedIn)
  assert.equal(replay.kind, 'replay')
  assert.equal(hasHint(replay), false)
  t.mock.timers.tick(601)
  assert.equal(hasHint(await reserve(4)), false) // Legacy callers get the existing shape.
})

test('an in-flight reservation already holds its slot', async () => {
  const { snapshot, reserve } = await fixture({ consumerMax: 2 })
  await reserve(1)

  // The request is `reserved`, not committed. Counting only committed requests
  // would let a burst of concurrent calls all see room that is already taken.
  const snap = await snapshot()
  assert.equal(snap.binding.used, 1)
  assert.equal(snap.binding.remaining, 1)
})

test('the tightest ceiling is the one reported', async () => {
  const { snapshot } = await fixture({ consumerMax: 100 })
  const snap = await snapshot()

  const tightest = snap.layers.reduce((left, right) => (
    right.remaining < left.remaining ? right : left
  ))
  assert.equal(snap.binding.limitScope, tightest.limitScope)
  assert.equal(snap.binding.remaining, tightest.remaining)
  // Both layers stay visible so an operator can see which one to raise.
  assert.deepEqual(
    snap.layers.map((layer) => layer.limitScope).sort(),
    ['api_key', 'consumer'],
  )
})

test('a key that does not belong to the consumer yields nothing', async () => {
  const { store } = await fixture()
  assert.deepEqual(
    await store.quotaSnapshot({ tenantId: randomUUID(), consumerId: randomUUID(), apiKeyId: randomUUID() }),
    [],
  )
})
