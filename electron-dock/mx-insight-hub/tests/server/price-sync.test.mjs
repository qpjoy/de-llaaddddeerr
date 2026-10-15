import test from 'node:test'
import assert from 'node:assert/strict'
import { priceSyncArguments } from '../../server/ops/sync-verified-provider-prices.mjs'
import { priceSyncHash, summarizePriceSync } from '../../server/commercial/price-sync.mjs'

test('price sync requires an explicit mode and an apply preview hash', () => {
  assert.deepEqual(priceSyncArguments(['--preview']), { mode: 'preview' })
  assert.deepEqual(priceSyncArguments(['--show', 'id', '--details']), { mode: 'show', id: 'id', details: true })
  assert.deepEqual(priceSyncArguments(['--apply', 'id', '--preview-hash', 'hash']), { mode: 'apply', id: 'id', hash: 'hash' })
  for (const args of [[], ['--apply', 'id'], ['--preview', '--apply'], ['--show', 'id', '--force']]) assert.throws(() => priceSyncArguments(args), /Usage:/)
})

test('price sync hashes semantic objects and summarizes preserved/blocked decisions separately', () => {
  assert.equal(priceSyncHash({ b: 2, a: { d: 4, c: 3 } }), priceSyncHash({ a: { c: 3, d: 4 }, b: 2 }))
  const summary = summarizePriceSync({ sources: [], excluded: [], customerMappingSkipped: [],
    procurement: { summary: { updatedOperations: 2 }, skipped: [{ reason: 'currency_mismatch' }] },
    customer: { changes: [{}], decisions: [{ action: 'update' }, { action: 'keep', reason: 'served_or_unknown_high_price_preserved' }],
      blocked: [{ reason: 'customer_currency_conversion_required' }] } })
  assert.equal(summary.customer.changedPrices, 1)
  assert.equal(summary.customer.kept.served_or_unknown_high_price_preserved, 1)
  assert.equal(summary.customer.blocked.customer_currency_conversion_required, 1)
})
