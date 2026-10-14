import test from 'node:test'
import assert from 'node:assert/strict'
import { EXTERNAL_PLATFORM_OPERATION_CATALOG } from '../../server/external-platforms/control-store.mjs'
import { applyProcurementSync, normalizeProcurementSyncRate, planProcurementSync } from '../../server/commercial/price-sync-procurement.mjs'

const detail = EXTERNAL_PLATFORM_OPERATION_CATALOG.justone.find(row => row.operationKey === 'ecommerce.products.detail')
const search = EXTERNAL_PLATFORM_OPERATION_CATALOG.justone.find(row => row.operationKey === 'ecommerce.products.search')
const timestamp = '2026-10-14T00:00:00.000Z'
function operation(definition = detail, patch = {}) {
  return { provider: 'justone', operationKey: definition.operationKey, revision: 7,
    controlSource: 'database', desiredState: 'active', canaryConsumerIds: [],
    release: { revision: 3, status: 'released', contractVersion: definition.contractVersion, endpointKeys: definition.endpointKeys,
      ...(definition.optionalEndpointKeys ? { optionalEndpointKeys: definition.optionalEndpointKeys } : {}) },
    priceBook: { version: 9, source: 'database', status: 'reviewed', currency: 'CNY', pricingAsOf: timestamp,
      monthlyBudgetMinor: 12345, monthlySubsidyBudgetMinor: 0,
      endpointPrices: Object.fromEntries(definition.endpointKeys.map(key => [key, 107])) }, exactRates: [], ...patch }
}
function rate(endpointKey = detail.endpointKeys[0], patch = {}) {
  return { provider: 'justone', endpointKey, currency: 'CNY', unitPrice: '0.200000', sourceKind: 'official',
    sourceUrl: 'https://example.com/account-prices', observedAt: timestamp, sourceHash: 'a'.repeat(64), ...patch }
}

test('verified prices replace old estimates without enabling operations or changing budgets', () => {
  for (const desiredState of ['active', 'canary', 'paused', 'disabled', 'shadow']) {
    const current = operation(detail, { desiredState, canaryConsumerIds: ['00000000-0000-4000-8000-000000000001'] })
    const before = structuredClone(current)
    const plan = planProcurementSync({ operations: [current], rates: [rate()] })
    assert.equal(plan.updates.length, 1)
    assert.deepEqual(current, before)
    assert.deepEqual(plan.updates[0].body, { expectedRevision: 7, desiredState,
      canaryConsumerIds: current.canaryConsumerIds,
      priceBook: { currency: 'CNY', pricingAsOf: timestamp, monthlyBudgetMinor: 12345,
        monthlySubsidyBudgetMinor: 0, unitCostMinorByEndpoint: { [detail.endpointKeys[0]]: 20 } },
      reason: 'Verified procurement price synchronization; preserve operation state, budgets and customer terms' })
  }
})

test('partial sync retains other required and optional endpoint prices and exact references', () => {
  const current = operation(search)
  const optional = search.optionalEndpointKeys[0]
  current.priceBook.endpointPrices[optional] = 25
  const previous = normalizeProcurementSyncRate(rate(search.endpointKeys[1], { unitPrice: '1.07' }))
  current.exactRates = [previous]
  const plan = planProcurementSync({ operations: [current], rates: [rate(search.endpointKeys[0])] })
  assert.deepEqual(plan.updates[0].body.priceBook.unitCostMinorByEndpoint, {
    ...current.priceBook.endpointPrices, [search.endpointKeys[0]]: 20,
  })
  assert.ok(plan.updates[0].exactRates.some(row => row.endpointKey === previous.endpointKey))
  const optionalPlan = planProcurementSync({ operations: [current], rates: [rate(optional, { unitPrice: '0.15' })] })
  assert.equal(optionalPlan.updates[0].body.priceBook.unitCostMinorByEndpoint[optional], 15)
})

test('a sub-cent exact price is retained separately from its conservative cent budget', () => {
  const current = operation()
  current.priceBook.endpointPrices[detail.endpointKeys[0]] = 1
  const plan = planProcurementSync({ operations: [current], rates: [rate(undefined, { unitPrice: '0.0038' })] })
  const change = plan.updates[0].changes[0]
  assert.equal(change.previousBudgetMinor, 1)
  assert.equal(change.nextBudgetMinor, 1)
  assert.equal(change.nextExact.amountMicros, '3800')
  assert.equal(change.nextExact.rounded, true)
  assert.equal(change.nextExact.unitPrice, '0.0038')
  assert.equal(Object.hasOwn(change, 'placeholder'), false)
})

test('matching exact price and source evidence is a no-op; a new source is versioned even if budget matches', () => {
  const exact = normalizeProcurementSyncRate(rate(undefined, { unitPrice: '0.0038' }))
  const current = operation(detail, { exactRates: [exact] })
  current.priceBook.endpointPrices[detail.endpointKeys[0]] = 1
  const same = planProcurementSync({ operations: [current], rates: [exact] })
  assert.equal(same.updates.length, 0)
  assert.equal(same.unchanged.length, 1)
  const changed = planProcurementSync({ operations: [current], rates: [{ ...exact, sourceHash: 'b'.repeat(64) }] })
  assert.equal(changed.updates.length, 1)
})

test('catalogue eligibility and evidence qualifiers survive normalization and affect versioning', () => {
  const flags = { verified: true, inferred: false, priceBasis: 'official_catalog_base_rate', accountSpecific: false,
    actualChargeVerified: false, allowDiscount: true, allowFreeCredit: false, providerPath: '/api/v1/test/endpoint',
    endpointType: 'third-party', snapshotHash: 'c'.repeat(64) }
  const exact = normalizeProcurementSyncRate(rate(undefined, { flags }))
  assert.deepEqual(exact.flags, flags)
  assert.notEqual(exact.flags, flags)
  assert.deepEqual(normalizeProcurementSyncRate(exact), exact)
  const current = operation(detail, { exactRates: [exact] })
  current.priceBook.endpointPrices[detail.endpointKeys[0]] = 20
  assert.equal(planProcurementSync({ operations: [current], rates: [exact] }).updates.length, 0)
  assert.equal(planProcurementSync({ operations: [current], rates: [{ ...exact, flags: { ...flags, allowDiscount: false } }] }).updates.length, 1)
  for (const invalid of [{ allowDiscount: 1 }, { unknownEligibility: true }, { providerPath: '/api/v1/foo?token=secret' },
    { accountSpecific: 'false' }, { priceBasis: 'inferred_from_daily_total' }, { snapshotHash: 'bad' }]) {
    assert.throws(() => normalizeProcurementSyncRate(rate(undefined, { flags: invalid })), { code: 'price_sync_invalid_evidence_flags' })
  }
})

test('explicit free prices, unsupported new free prices, unknown budgets and mixed currencies stay unchanged', () => {
  const free = operation()
  free.priceBook.endpointPrices[detail.endpointKeys[0]] = 0
  assert.equal(planProcurementSync({ operations: [free], rates: [rate()] }).skipped[0].reason, 'explicit_free_price_preserved')
  assert.equal(planProcurementSync({ operations: [operation()], rates: [rate(undefined, { unitPrice: '0' })] }).skipped[0].reason, 'official_free_price_unsupported')
  const budget = operation()
  budget.priceBook.monthlyBudgetMinor = null
  assert.equal(planProcurementSync({ operations: [budget], rates: [rate()] }).skipped[0].reason, 'budget_policy_missing')
  assert.equal(planProcurementSync({ operations: [operation()], rates: [rate(undefined, { currency: 'USD' })] }).skipped[0].reason, 'currency_mismatch')
})

test('incomplete multi-endpoint books cannot be silently completed with invented prices', () => {
  const current = operation(search)
  delete current.priceBook.endpointPrices[search.endpointKeys[1]]
  const plan = planProcurementSync({ operations: [current], rates: [rate(search.endpointKeys[0])] })
  assert.equal(plan.updates.length, 0)
  assert.equal(plan.skipped[0].reason, 'incomplete_or_invalid_operation_price_book')
})

test('duplicate, inferred and credential-bearing evidence is rejected before planning writes', () => {
  for (const patch of [{ sourceKind: 'manual' }, { flags: { inferred: true } }, { flags: { verified: false } },
    { sourceHash: 'not-a-hash' }, { sourceUrl: 'https://example.com/price?token=secret' },
    { sourceUrl: 'https://user:secret@example.com/price' }, { observedAt: 'not-a-date' }, { unitPrice: 0.2 }]) {
    assert.throws(() => planProcurementSync({ operations: [operation()], rates: [rate(undefined, patch)] }))
  }
  assert.throws(() => planProcurementSync({ operations: [operation()], rates: [rate(), rate()] }), { code: 'price_sync_duplicate_rate' })
  const unknown = planProcurementSync({ operations: [operation()], rates: [rate('unknown.endpoint')] })
  assert.equal(unknown.updates.length, 0)
  assert.equal(unknown.skipped[0].reason, 'endpoint_not_registered')
})

test('apply refuses a non-serializable session or a normal provisioning batch before price writes', async () => {
  const commands = []
  const client = { query: async sql => {
    commands.push(sql)
    return { rows: sql === 'SHOW transaction_isolation' ? [{ transaction_isolation: 'read committed' }] : [] }
  } }
  await assert.rejects(applyProcurementSync(client, { batchId: 'not-used', plan: {} }), { code: 'price_sync_transaction_required' })
  assert.equal(commands.length, 1)
  client.query = async sql => ({ rows: sql === 'SHOW transaction_isolation'
    ? [{ transaction_isolation: 'serializable' }] : [{ status: 'preview', kind: 'normal-provisioning' }] })
  await assert.rejects(applyProcurementSync(client, { batchId: 'not-used', plan: {} }), { code: 'price_sync_batch_invalid' })
})
