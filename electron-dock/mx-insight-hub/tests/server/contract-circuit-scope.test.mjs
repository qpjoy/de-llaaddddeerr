// Contract failures open one marketplace's breaker, not the provider's.
//
// A response the Hub cannot normalize is a gap in our own contract: the vendor
// answered, and answered for exactly one marketplace. Counting those against
// the provider-wide breaker meant an unparseable marketplace suspended live
// dispatch for every other marketplace too -- which then quietly degraded
// healthy traffic to days-old stored snapshots.
//
// Upstream faults (authentication, capacity, balance, transport) are genuinely
// provider-wide and must keep tripping the provider-wide breaker.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'

const OPERATION = 'ecommerce.products.search'

function callInput(marketplace, overrides = {}) {
  return {
    id: randomUUID(),
    tenantId: randomUUID(),
    consumerId: randomUUID(),
    apiKeyId: randomUUID(),
    usageRequestId: randomUUID(),
    operation: OPERATION,
    contractVersion: 'mx-insight-hub.ecommerce-products.v1',
    endpointKey: `${marketplace}.product-search.v1`,
    endpointVersion: 'v1',
    marketplace,
    fingerprint: 'a'.repeat(64),
    ...overrides,
  }
}

function reservedUsage(input) {
  return {
    id: input.usageRequestId,
    tenantId: input.tenantId,
    consumerId: input.consumerId,
    apiKeyId: input.apiKeyId,
    fingerprint: input.fingerprint,
    platform: 'ecommerce',
    billingMeterKey: OPERATION,
    status: 'reserved',
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
}

function newStore() {
  return new MemoryExternalPlatformStore({ usageStore: { requests: new Map() } })
}

async function dispatch(store, marketplace) {
  const input = callInput(marketplace)
  store.usageStore.requests.set(input.usageRequestId, reservedUsage(input))
  const call = await store.beginProviderCall(input)
  return { input, call }
}

async function failTimes(store, marketplace, times, { circuitCategory, errorCode }) {
  for (let attempt = 0; attempt < times; attempt += 1) {
    const { input, call } = await dispatch(store, marketplace)
    await store.finishProviderStep({
      callId: call.id,
      delivery: input,
      outcome: 'succeeded_unusable',
      httpStatus: 200,
      businessCode: 0,
      billed: true,
      latencyMs: 5,
      errorCode,
      circuitCategory,
    })
  }
}

test('three unparseable responses open only that marketplace', async () => {
  const store = newStore()
  await failTimes(store, 'xianyu', 3, {
    circuitCategory: 'contract',
    errorCode: 'invalid_upstream_items',
  })

  const scoped = await store.contractCircuitState('justone', 'xianyu')
  assert.equal(scoped.consecutiveFailures, 3)
  assert.ok(new Date(scoped.circuitOpenUntil) > new Date(), 'xianyu is suspended')

  // The whole point: the provider-wide breaker is untouched, so taobao keeps
  // dispatching live instead of falling back to a stale snapshot.
  const provider = await store.providerState('justone')
  assert.equal(provider.consecutiveFailures, 0)
  assert.equal(provider.circuitOpenUntil, null)
  assert.equal(await store.contractCircuitState('justone', 'taobao'), null)
})

test('an upstream fault still opens the provider-wide breaker', async () => {
  const store = newStore()
  // Authentication, capacity and balance are conditions of the account, not of
  // one marketplace, so they must keep suspending the provider.
  await failTimes(store, 'taobao', 3, {
    circuitCategory: 'authentication',
    errorCode: 'upstream_business_error',
  })

  const provider = await store.providerState('justone')
  assert.equal(provider.consecutiveFailures, 3)
  assert.ok(new Date(provider.circuitOpenUntil) > new Date())
  assert.equal(await store.contractCircuitState('justone', 'taobao'), null)
})

test('two marketplaces failing on contract are counted apart', async () => {
  const store = newStore()
  await failTimes(store, 'xianyu', 2, { circuitCategory: 'contract', errorCode: 'invalid_upstream_items' })
  await failTimes(store, 'jd', 1, { circuitCategory: 'contract', errorCode: 'invalid_upstream_items' })

  // Neither has reached the threshold on its own, and pooling them would have
  // opened a breaker that no single marketplace earned.
  assert.equal((await store.contractCircuitState('justone', 'xianyu')).consecutiveFailures, 2)
  assert.equal((await store.contractCircuitState('justone', 'xianyu')).circuitOpenUntil, null)
  assert.equal((await store.contractCircuitState('justone', 'jd')).consecutiveFailures, 1)
  assert.equal((await store.providerState('justone')).consecutiveFailures, 0)
})

test('a marketplace that parses again clears its own breaker', async () => {
  const store = newStore()
  await failTimes(store, 'xianyu', 3, { circuitCategory: 'contract', errorCode: 'invalid_upstream_items' })
  assert.ok((await store.contractCircuitState('justone', 'xianyu')).circuitOpenUntil)

  const { input, call } = await dispatch(store, 'xianyu')
  await store.finishProviderStep({
    callId: call.id,
    delivery: input,
    outcome: 'succeeded',
    httpStatus: 200,
    businessCode: 0,
    billed: true,
    latencyMs: 5,
    itemCount: 2,
  })

  // Deploying a contract fix should not require waiting out a breaker.
  assert.equal(await store.contractCircuitState('justone', 'xianyu'), null)
})
