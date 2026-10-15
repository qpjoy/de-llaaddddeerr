import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { planCustomerPriceSync } from '../../server/commercial/price-sync-customers.mjs'
import { applyCustomerRestore, planCustomerRestore } from '../../server/commercial/price-sync-restore-customers.mjs'

const meter = 'native.restore.first', other = 'native.restore.second', untouched = 'native.restore.untouched'
const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
const hash = value => createHash('sha256').update(stable(value)).digest('hex')
const rate = unitPrice => ({ currency: 'CNY', unit: 'request', unitPrice, source: { kind: 'synthetic' } })
function fixture({ oldMinor = 1, fallback = false, two = true } = {}) {
  const old = { consumerId: 'consumer', tenantId: 'tenant', consumerStatus: 'active', tenantStatus: 'active',
    assignment: { planVersionId: 'old-version', revision: 4, assignedAt: '2020-01-01T00:00:00.123456Z' },
    plan: { id: 'old-plan', key: 'old', name: 'Old plan', status: 'active', versionStatus: 'published', version: 1,
      limits: { monthlyRequests: 500 }, pricing: { components: [{ kind: 'existing' }] } },
    priceBook: fallback ? null : { id: 'old-book', key: 'old', currency: 'CNY', defaultMultiplierPpm: 500_000,
      entries: [{ meterKey: meter, billingUnit: 'request', unitPriceMinor: oldMinor },
        { meterKey: untouched, billingUnit: 'request', unitPriceMinor: 35 }] },
    profile: { mode: 'enforced', revision: 7, defaultCurrency: 'CNY', defaultUnitPriceMinor: 1, multiplierPpm: null },
    walletCurrencies: ['CNY'], exposureByMeter: { [meter]: { state: 'unserved' }, [other]: { state: 'unserved' } } }
  const ratesByMeter = { [meter]: rate('0.20'), ...(two ? { [other]: rate('0.30') } : {}) }
  const forward = planCustomerPriceSync({ consumers: [old] }, { ratesByMeter })
  const change = forward.changes[0], batchId = 'source-batch'
  const changeHash = hash({ expectedHash: change.expectedHash, currency: change.currency, entries: change.entries,
    defaultMultiplierPpm: change.defaultMultiplierPpm, ratesByMeter: change.ratesByMeter })
  const receipt = { status: 'applied', consumerId: old.consumerId, planVersionId: 'new-version', priceBookId: 'new-book', revision: 5 }
  const current = structuredClone(old)
  current.assignment = { ...old.assignment, planVersionId: receipt.planVersionId, revision: receipt.revision }
  current.plan = { ...old.plan, id: 'new-plan', key: 'new', pricing: { ...old.plan.pricing,
    priceSync: { batchId, changeHash, previousPlanVersionId: old.assignment.planVersionId } } }
  current.priceBook = { id: receipt.priceBookId, key: 'new', currency: change.currency,
    defaultMultiplierPpm: change.defaultMultiplierPpm, entries: structuredClone(change.entries) }
  const sourceBatch = { id: batchId, status: 'completed', specification: { kind: 'price-sync' },
    preview: { customer: forward }, result: { batchId, status: 'completed', customers: [receipt] } }
  const inventory = { consumers: [current], originalPlanVersions: [{ planVersionId: old.assignment.planVersionId,
    limits: old.plan.limits, pricing: old.plan.pricing, priceBook: old.priceBook }] }
  return { sourceBatch, inventory, selections: [{ consumerId: old.consumerId, meterKeys: [meter] }] }
}

test('restores only selected source updates and keeps other migrated entries, limits and multipliers', () => {
  const input = fixture(), before = structuredClone(input), result = planCustomerRestore(input)
  assert.equal(result.blocked.length, 0)
  assert.equal(result.changes.length, 1)
  const change = result.changes[0]
  assert.equal(change.entries.find(row => row.meterKey === meter).unitPriceMinor, 1)
  assert.equal(change.entries.find(row => row.meterKey === other).unitPriceMinor, 30)
  assert.equal(change.entries.find(row => row.meterKey === untouched).unitPriceMinor, 35)
  assert.equal(change.defaultMultiplierPpm, 500_000)
  assert.equal(change.expectedAssignment.assignedAt, '2020-01-01T00:00:00.123456Z')
  assert.deepEqual(input, before)
})

test('intentional restoration may restore an original high price even after external usage', () => {
  const input = fixture({ oldMinor: 100 })
  input.inventory.consumers[0].exposureByMeter[meter] = { state: 'served', reasons: ['non_admin_usage_or_charge'] }
  const result = planCustomerRestore(input)
  assert.equal(result.blocked.length, 0)
  assert.equal(result.decisions[0].targetMinor, 100)
  assert.equal(result.decisions[0].targetQuotedMinor, 50)
})

test('restoration removes only the selected overlay and permits an empty resulting book', () => {
  for (const two of [false, true]) {
    const result = planCustomerRestore(fixture({ fallback: true, two }))
    assert.equal(result.blocked.length, 0)
    assert.equal(result.decisions[0].reason, 'restore_original_tenant_fallback')
    assert.deepEqual(result.changes[0].entries, two ? [{ meterKey: other, billingUnit: 'request', unitPriceMinor: 30 }] : [])
  }
})

test('fallback restoration refuses a changed amount, currency or missing billing profile', () => {
  for (const replacement of [{ defaultUnitPriceMinor: 2 }, { defaultCurrency: 'USD' }, null]) {
    const input = fixture({ fallback: true })
    input.inventory.consumers[0].profile = replacement ? { ...input.inventory.consumers[0].profile, ...replacement } : null
    const result = planCustomerRestore(input)
    assert.equal(result.changes.length, 0)
    assert.equal(result.blocked[0].reason, 'original_fallback_changed')
  }
})

test('manual reassignment, revision changes and altered quota epoch all refuse restoration', () => {
  for (const replacement of [{ revision: 6 }, { planVersionId: 'different-version' }, { assignedAt: '2020-01-02T00:00:00.123456Z' }]) {
    const input = fixture()
    Object.assign(input.inventory.consumers[0].assignment, replacement)
    const result = planCustomerRestore(input)
    assert.equal(result.changes.length, 0)
    assert.equal(result.blocked[0].reason, 'source_assignment_changed')
  }
  const missingRevision = fixture()
  delete missingRevision.sourceBatch.result.customers[0].revision
  assert.equal(planCustomerRestore(missingRevision).blocked[0].reason, 'source_assignment_changed')
})

test('unselected, unchanged and fabricated original prices cannot be restored', () => {
  const unchanged = fixture()
  unchanged.selections[0].meterKeys = [meter, untouched]
  const result = planCustomerRestore(unchanged)
  assert.equal(result.changes.length, 0)
  assert.equal(result.blocked[0].reason, 'meter_not_changed_by_source_batch')
  const fabricated = fixture()
  fabricated.inventory.originalPlanVersions[0].priceBook.entries[0].unitPriceMinor = 999
  assert.equal(planCustomerRestore(fabricated).blocked[0].reason, 'original_price_evidence_mismatch')
  const altered = fixture()
  altered.inventory.consumers[0].priceBook.entries[0].unitPriceMinor = 999
  assert.equal(planCustomerRestore(altered).blocked[0].reason, 'source_receipt_or_price_state_mismatch')
})

test('traffic and exposure counters do not stale an intentional restore but billing changes do', () => {
  const input = fixture(), before = planCustomerRestore(input)
  input.inventory.consumers[0].exposureByMeter = { [meter]: { state: 'served', usage: { committed: 1000 } } }
  assert.deepEqual(planCustomerRestore(input), before)
  input.inventory.consumers[0].profile.multiplierPpm = 750_000
  assert.notEqual(planCustomerRestore(input).changes[0].expectedHash, before.changes[0].expectedHash)
  assert.equal(planCustomerRestore(input).decisions[0].targetQuotedMinor, 1)
})

test('requires a completed source and explicit meter selections', () => {
  const input = fixture()
  input.sourceBatch.status = 'preview'
  assert.throws(() => planCustomerRestore(input), { code: 'customer_restore_invalid_source' })
  assert.throws(() => planCustomerRestore({ ...fixture(), selections: [] }), { code: 'customer_restore_selection_required' })
  assert.throws(() => planCustomerRestore({ ...fixture(), selections: [{ consumerId: 'consumer', meterKeys: ['*'] }] }), { code: 'customer_restore_invalid_selection' })
})

test('writer rejects blockers and requires a caller-owned serializable transaction before mutations', async () => {
  const input = fixture(), plan = planCustomerRestore(input), queries = []
  const client = { query: async sql => { queries.push(sql); return { rows: [{ transaction_isolation: 'read committed' }] } } }
  await assert.rejects(applyCustomerRestore(client, { batchId: 'restore', sourceBatch: input.sourceBatch, plan }), { code: 'customer_restore_transaction_required' })
  assert.deepEqual(queries, ['SHOW transaction_isolation'])
  await assert.rejects(applyCustomerRestore(client, { batchId: 'restore', sourceBatch: input.sourceBatch,
    plan: { ...plan, blocked: [{ reason: 'blocked' }] } }), { code: 'customer_restore_blocked' })
  assert.deepEqual(queries, ['SHOW transaction_isolation'])
})
