// The monthly procurement cap, as reported to the console.
//
// This number exists so an operator stops learning about an exhausted budget by
// reading a 429. That only holds if the reported figure agrees with the figure
// the gateway enforces -- so these tests drive real reservations until admission
// refuses, and assert the projection flips to exhausted at exactly that point.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'

const FINGERPRINT = 'a'.repeat(64)
const OPERATION = 'ecommerce.products.search'
const ENDPOINT_KEY = 'jd.product-search.v1'

function callInput(overrides = {}) {
  return {
    id: randomUUID(),
    tenantId: randomUUID(),
    consumerId: randomUUID(),
    apiKeyId: randomUUID(),
    usageRequestId: randomUUID(),
    operation: OPERATION,
    contractVersion: 'mx-insight-hub.ecommerce-products.v1',
    endpointKey: ENDPOINT_KEY,
    endpointVersion: 'v1',
    marketplace: 'jd',
    fingerprint: FINGERPRINT,
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

const COST_CONTROL = Object.freeze({
  costMinor: 5,
  costKind: 'estimated',
  currency: 'USD',
  monthlyBudgetMinor: 20,
  monthlySubsidyBudgetMinor: 1_000_000,
})

test('the reported budget flips to exhausted on exactly the call admission refuses', async () => {
  const inputs = Array.from({ length: 6 }, () => callInput())
  const usageStore = {
    requests: new Map(inputs.map((input) => [input.usageRequestId, reservedUsage(input)])),
  }
  const store = new MemoryExternalPlatformStore({ usageStore })

  const before = store.describeCostBudget(COST_CONTROL)
  assert.equal(before.budgetMinor, 20)
  assert.equal(before.spentMinor, 0)
  assert.equal(before.remainingMinor, 20)
  assert.equal(before.exhausted, false)

  // 20 / 5 = four admissible reservations.
  for (let call = 0; call < 4; call += 1) {
    await store.reserveProviderCostWorkflow({
      tenantId: inputs[call].tenantId,
      consumerId: inputs[call].consumerId,
      apiKeyId: inputs[call].apiKeyId,
      usageRequestId: inputs[call].usageRequestId,
      fingerprint: inputs[call].fingerprint,
      costControls: [COST_CONTROL],
    })
    const snapshot = store.describeCostBudget(COST_CONTROL)
    assert.equal(snapshot.spentMinor, (call + 1) * 5, `after ${call + 1} reservations`)
    assert.equal(snapshot.remainingMinor, 20 - (call + 1) * 5)
  }

  const spent = store.describeCostBudget(COST_CONTROL)
  assert.equal(spent.remainingMinor, 0)
  assert.equal(spent.exhausted, true)

  // The moment of truth: the console said exhausted, and the gateway agrees.
  await assert.rejects(
    () => store.reserveProviderCostWorkflow({
      tenantId: inputs[4].tenantId,
      consumerId: inputs[4].consumerId,
      apiKeyId: inputs[4].apiKeyId,
      usageRequestId: inputs[4].usageRequestId,
      fingerprint: inputs[4].fingerprint,
      costControls: [COST_CONTROL],
    }),
    (error) => error?.status === 429 && error?.code === 'external_platform_cost_budget_exhausted',
  )
})

test('a budget with room never reports exhausted while admission still accepts', async () => {
  const inputs = Array.from({ length: 3 }, () => callInput())
  const usageStore = {
    requests: new Map(inputs.map((input) => [input.usageRequestId, reservedUsage(input)])),
  }
  const store = new MemoryExternalPlatformStore({ usageStore })
  await store.reserveProviderCostWorkflow({
    tenantId: inputs[0].tenantId,
    consumerId: inputs[0].consumerId,
    apiKeyId: inputs[0].apiKeyId,
    usageRequestId: inputs[0].usageRequestId,
    fingerprint: inputs[0].fingerprint,
    costControls: [COST_CONTROL],
  })
  const snapshot = store.describeCostBudget(COST_CONTROL)
  assert.equal(snapshot.exhausted, false)
  // Still admissible, so "not exhausted" was not a hopeful guess.
  assert.ok(await store.reserveProviderCostWorkflow({
    tenantId: inputs[1].tenantId,
    consumerId: inputs[1].consumerId,
    apiKeyId: inputs[1].apiKeyId,
    usageRequestId: inputs[1].usageRequestId,
    fingerprint: inputs[1].fingerprint,
    costControls: [COST_CONTROL],
  }))
})

test('an unconfigured budget reports nothing rather than zero', async () => {
  const store = new MemoryExternalPlatformStore({ usageStore: { requests: new Map() } })
  // Unknown and zero lead to opposite conclusions -- "not set up yet" versus
  // "set up and fully spent" -- so an absent cap must never render as 0.
  assert.equal(store.describeCostBudget({ currency: 'USD', monthlyBudgetMinor: null }), null)
  assert.equal(store.describeCostBudget({ currency: 'USD' }), null)
  assert.equal(store.describeCostBudget(null), null)

  const zero = store.describeCostBudget({ currency: 'USD', monthlyBudgetMinor: 0 })
  assert.equal(zero.budgetMinor, 0)
  assert.equal(zero.exhausted, true, 'a zero budget admits nothing, and says so')
})
