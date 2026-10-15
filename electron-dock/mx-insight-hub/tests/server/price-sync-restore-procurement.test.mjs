import test from 'node:test'
import assert from 'node:assert/strict'
import { EXTERNAL_PLATFORM_OPERATION_CATALOG } from '../../server/external-platforms/control-store.mjs'
import { normalizeProcurementSyncRate, planProcurementSync } from '../../server/commercial/price-sync-procurement.mjs'
import { applyProcurementRestore, planProcurementRestore } from '../../server/commercial/price-sync-restore-procurement.mjs'

const definition = EXTERNAL_PLATFORM_OPERATION_CATALOG.justone.find(row => row.operationKey === 'ecommerce.products.search')
const endpointKey = definition.endpointKeys[0]
const sourceId = 'f8934d88-a728-4bfa-8049-fd354737c625'
const selection = `justone:${definition.operationKey}`
function evidence(endpoint = endpointKey, unitPrice = '0.20', sourceHash = 'a'.repeat(64)) {
  return normalizeProcurementSyncRate({ provider: 'justone', endpointKey: endpoint, currency: 'CNY', unitPrice,
    sourceKind: 'contract', sourceUrl: 'https://example.com/synthetic-contract', observedAt: '2026-10-14T00:00:00Z', sourceHash })
}
function fixture({ oldExact = null, endpointPrices = {} } = {}) {
  const before = { provider: 'justone', operationKey: definition.operationKey, revision: 5,
    controlSource: 'database', desiredState: 'paused', canaryConsumerIds: ['2857e821-6cb3-4e6a-a1d2-72bdd59d2e0d'],
    release: { revision: 3, status: 'released', contractVersion: definition.contractVersion, endpointKeys: definition.endpointKeys },
    priceBook: { version: 8, source: 'database', status: 'reviewed', currency: 'CNY', pricingAsOf: '2026-10-01T00:00:00Z',
      monthlyBudgetMinor: 2000, monthlySubsidyBudgetMinor: 0,
      endpointPrices: { ...Object.fromEntries(definition.endpointKeys.map(key => [key, 1])), ...endpointPrices } },
    exactRates: oldExact ? [oldExact] : [] }
  const procurement = planProcurementSync({ operations: [before], rates: [evidence()] })
  const update = procurement.updates[0]
  const operation = structuredClone(before)
  operation.revision = 6
  operation.release.revision = 4
  operation.priceBook = { ...before.priceBook, version: 9, pricingAsOf: update.body.priceBook.pricingAsOf,
    endpointPrices: { ...update.body.priceBook.unitCostMinorByEndpoint } }
  operation.exactRates = update.exactRates
  const sourceBatch = { id: sourceId, status: 'completed', preview: { kind: 'price-sync', procurement },
    result: { status: 'completed', batchId: sourceId,
      procurement: { applied: [{ provider: 'justone', operationKey: definition.operationKey, revision: 6, priceBookVersion: 9,
        draftId: '9b5f94a1-1da3-4366-8aee-ad44aadfb42b', changedEndpoints: [endpointKey] }] } } }
  return { sourceBatch, operations: [operation], selections: [selection], before }
}

test('restore changes only source-batch endpoints and preserves current state, canary, budgets and other prices', () => {
  const input = fixture({ endpointPrices: { [definition.optionalEndpointKeys[0]]: 55 } })
  const current = structuredClone(input.operations[0])
  const source = structuredClone(input.sourceBatch)
  const plan = planProcurementRestore(input)
  assert.equal(plan.updates.length, 1)
  assert.equal(plan.updates[0].body.priceBook.unitCostMinorByEndpoint[endpointKey], 1)
  assert.equal(plan.updates[0].body.priceBook.unitCostMinorByEndpoint[definition.optionalEndpointKeys[0]], 55)
  assert.equal(plan.updates[0].body.desiredState, 'paused')
  assert.deepEqual(plan.updates[0].body.canaryConsumerIds, current.canaryConsumerIds)
  assert.equal(plan.updates[0].body.priceBook.monthlyBudgetMinor, 2000)
  assert.equal(plan.updates[0].body.priceBook.monthlySubsidyBudgetMinor, 0)
  assert.deepEqual(plan.updates[0].exactRates, [])
  assert.equal(plan.notices[0].reason, 'state_restoration_requires_separate_runtime_evidence')
  assert.deepEqual(input.operations[0], current)
  assert.deepEqual(input.sourceBatch, source)
})

test('previous exact decimal and source flags are restored; unrelated exact evidence remains', () => {
  const old = evidence(endpointKey, '0.0038', 'b'.repeat(64))
  old.flags = { verified: true, accountSpecific: true, priceBasis: 'contract_account_rate' }
  const input = fixture({ oldExact: old })
  const other = evidence(definition.endpointKeys[1], '0.01', 'c'.repeat(64))
  input.operations[0].exactRates.push(other)
  const plan = planProcurementRestore(input)
  assert.deepEqual(plan.updates[0].exactRates.find(rate => rate.endpointKey === endpointKey), old)
  assert.deepEqual(plan.updates[0].exactRates.find(rate => rate.endpointKey === other.endpointKey), other)
  assert.equal(plan.updates[0].changes[0].nextExact.amountMicros, '3800')
})

test('later revision or price-book change prevents restoring the selected operation', () => {
  for (const field of ['revision', 'priceBook']) {
    const input = fixture()
    if (field === 'revision') input.operations[0].revision++
    else input.operations[0].priceBook.version++
    const plan = planProcurementRestore(input)
    assert.equal(plan.updates.length, 0)
    assert.equal(plan.skipped[0].reason, 'operation_changed_after_source_batch')
  }
})

test('missing prior endpoint price is reported without deleting the current price or disabling the operation', () => {
  const input = fixture()
  input.sourceBatch.preview.procurement.updates[0].changes[0].previousBudgetMinor = null
  const plan = planProcurementRestore(input)
  assert.equal(plan.updates.length, 0)
  assert.equal(plan.skipped[0].reason, 'previous_endpoint_price_missing_or_unsupported')
  assert.equal(input.operations[0].priceBook.endpointPrices[endpointKey], 20)
})

test('current endpoint or exact evidence inconsistent with the receipt is not overwritten', () => {
  for (const patch of ['price', 'evidence', 'invalid-prior']) {
    const input = fixture()
    if (patch === 'price') input.operations[0].priceBook.endpointPrices[endpointKey] = 21
    if (patch === 'evidence') input.operations[0].exactRates = [evidence(endpointKey, '0.20', 'b'.repeat(64))]
    if (patch === 'invalid-prior') input.sourceBatch.preview.procurement.updates[0].changes[0].previousExact = evidence(endpointKey, '0.02')
    const plan = planProcurementRestore(input)
    assert.equal(plan.updates.length, 0)
    assert.equal(plan.skipped.at(-1).reason, 'source_endpoint_evidence_mismatch')
  }
})

test('only exact unique operation selections in the completed source batch are eligible', () => {
  const input = fixture()
  for (const selections of [[], ['justone:*'], [selection, selection]]) {
    assert.throws(() => planProcurementRestore({ ...input, selections }), { code: 'price_restore_invalid_selection' })
  }
  assert.throws(() => planProcurementRestore({ ...input, sourceBatch: { ...input.sourceBatch, status: 'preview' } }), { code: 'price_restore_invalid_source' })
  const plan = planProcurementRestore({ ...input, selections: ['justone:ecommerce.products.detail'] })
  assert.equal(plan.updates.length, 0)
  assert.equal(plan.skipped[0].reason, 'source_operation_not_changed')
})

test('current legacy controls are never converted, and disabled operations are never guessed active', () => {
  const input = fixture()
  input.operations[0].controlSource = 'legacy_environment'
  assert.equal(planProcurementRestore(input).skipped[0].reason, 'current_control_requires_manual_review')
  input.operations[0].controlSource = 'database'
  input.operations[0].desiredState = 'disabled'
  const plan = planProcurementRestore(input)
  assert.equal(plan.updates[0].body.desiredState, 'disabled')
  assert.equal(plan.notices[0].reason, 'state_restoration_requires_separate_runtime_evidence')
})

test('apply refuses a non-serializable transaction and a non-restoration batch', async () => {
  const client = { query: async () => ({ rows: [{ transaction_isolation: 'read committed' }] }) }
  await assert.rejects(applyProcurementRestore(client, { batchId: sourceId }), { code: 'price_restore_transaction_required' })
  client.query = async sql => ({ rows: sql === 'SHOW transaction_isolation'
    ? [{ transaction_isolation: 'serializable' }] : [{ status: 'preview', kind: 'price-sync' }] })
  await assert.rejects(applyProcurementRestore(client, { batchId: sourceId }), { code: 'price_restore_batch_invalid' })
})
