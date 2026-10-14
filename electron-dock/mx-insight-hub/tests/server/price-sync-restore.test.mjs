import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeRestoreSelection } from '../../server/commercial/price-sync-restore.mjs'
import { restoreArguments } from '../../server/ops/restore-price-sync.mjs'
import { customerAccessImpact, auditPreviewHash } from '../../server/ops/audit-price-sync-access.mjs'
import { priceSyncPreviewHash } from '../../server/commercial/price-sync.mjs'

test('standalone audit verifies the same preview fingerprint as forward migration', () => {
  const view = { z: 3, changes: [{ exposure: { usage: { count: 10 }, reasons: ['observed'], state: 'served' }, a: 4 }] }
  assert.equal(auditPreviewHash(view), priceSyncPreviewHash(view))
  view.changes[0].exposure.usage.count++
  assert.equal(auditPreviewHash(view), priceSyncPreviewHash(view))
})

test('targeted restore requires explicit unique selectors and an impact explanation', () => {
  const valid = { reason: 'Observed budget rejection', procurement: ['qixin:enterprise.api.1.13'] }
  assert.deepEqual(normalizeRestoreSelection(valid), { ...valid, customers: [] })
  for (const input of [{}, { reason: 'x' }, { reason: 'valid', procurement: ['*'] },
    { ...valid, procurement: ['qixin:enterprise.api.1.13', 'qixin:enterprise.api.1.13'] },
    { reason: 'valid', customers: [{ consumerId: 'bad', meterKeys: ['x'] }] }, { ...valid, force: true }]) {
    assert.throws(() => normalizeRestoreSelection(input), { code: 'price_restore_selection_invalid' })
  }
  assert.equal(restoreArguments(['--preview', 'source', '--selection', JSON.stringify(valid)]).mode, 'preview')
  assert.throws(() => restoreArguments(['--apply', 'id']), /Usage:/)
})

test('audit confirms only a matching current enforced quote at a current balance between old and new prices', () => {
  const decision = { consumerId: 'consumer', meterKey: 'meter', currentQuotedMinor: 1, targetQuotedMinor: 20, currency: 'CNY' }
  const current = { plan_version_id: 'version', assignment_revision: 2, entry_minor: 20, book_currency: 'CNY',
    default_multiplier_ppm: 1000000, mode: 'enforced', wallet_status: 'active', wallet_currency: 'CNY', available_minor: '10' }
  const receipt = { planVersionId: 'version', revision: 2 }
  assert.equal(customerAccessImpact(decision, current, receipt).oldAffordableNewUnaffordableNow, true)
  for (const override of [{ mode: 'shadow' }, { mode: 'disabled' }, { available_minor: '0' }, { available_minor: '20' },
    { plan_version_id: 'other' }, { assignment_revision: 3 }, { entry_minor: 50 }, { wallet_currency: 'USD' }, { wallet_status: 'suspended' }]) {
    assert.equal(customerAccessImpact(decision, { ...current, ...override }, receipt).oldAffordableNewUnaffordableNow, false)
  }
  assert.equal(customerAccessImpact(decision, {}, receipt).oldAffordableNewUnaffordableNow, false)
})
