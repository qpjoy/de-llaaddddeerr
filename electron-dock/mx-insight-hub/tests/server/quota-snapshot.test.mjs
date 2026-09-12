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
  const reserve = (n) => store.reserve({
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
  })
  const snapshot = async () => (await store.quotaSnapshot({
    tenantId: tenant.id, consumerId: consumer.id, apiKeyId: context.apiKey.id,
  }))[0]
  return { store, snapshot, reserve }
}

test('remaining reaches zero exactly when admission starts rejecting', async () => {
  const { snapshot, reserve } = await fixture({ consumerMax: 3 })

  assert.equal((await snapshot()).binding.remaining, 3)
  for (let index = 1; index <= 3; index += 1) await reserve(index)

  // The whole view rests on this: a number that disagreed with the admission
  // check would show room where the next call is about to be rejected.
  assert.equal((await snapshot()).binding.remaining, 0)
  await assert.rejects(() => reserve(4), (error) => error.code === 'consumer_quota_exceeded')
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
