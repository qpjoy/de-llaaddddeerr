import test from 'node:test'
import assert from 'node:assert/strict'
import { createOrder, transitionOrder, fingerprint, defaultSettings, settingsInput } from '../src/index.mjs'

test('amounts are integer minor units and live channels fail closed', () => {
  for (const amountMinor of [0, 499, 10000001, 5.01, '500', NaN, Infinity]) assert.throws(() => createOrder({ tenantId: 't', input: { environment: 'test', amountMinor }, settings: defaultSettings(), actor: 'test' }))
  assert.throws(() => createOrder({ tenantId: 't', input: { environment: 'live', amountMinor: 500 }, settings: defaultSettings(), actor: 'test' }), { code: 'payment_channel_disabled' })
  assert.throws(() => createOrder({ tenantId: 't', input: { environment: 'test', amountMinor: 500, status: 'paid' }, settings: defaultSettings() }))
})
test('submission never pays; state, revision, actor and exact amount gate settlement', () => {
  const order = createOrder({ tenantId: 't', input: { environment: 'test', amountMinor: 500 }, settings: defaultSettings(), actor: 'user' })
  const submitted = transitionOrder(order, 'submit', { expectedRevision: 0, payerName: '测试', tradeNo: 'TEST-001' }, { actor: 'user' })
  assert.equal(submitted.status, 'submitted'); assert.equal(submitted.settlement, null)
  const body = { expectedRevision: 1, tradeNo: 'TEST-001', receivedAmountMinor: 500, paidAt: new Date().toISOString(), note: 'Test' }
  assert.throws(() => transitionOrder(submitted, 'confirm', body, { actor: 'user' }), { code: 'payment_finance_required' })
  assert.throws(() => transitionOrder(submitted, 'confirm', { ...body, receivedAmountMinor: 501 }, { actor: 'admin', finance: true }), { code: 'payment_amount_mismatch' })
  const paid = transitionOrder(submitted, 'confirm', body, { actor: 'admin', finance: true })
  assert.equal(paid.status, 'paid'); assert.equal(paid.settlement.feeMinor, null)
  assert.throws(() => transitionOrder(paid, 'cancel', { expectedRevision: 2 }, { actor: 'user' }), { code: 'payment_state_conflict' })
  assert.throws(() => transitionOrder(order, 'invoice-request', { expectedRevision: 0 }, { actor: 'user' }), { code: 'payment_state_conflict' })
})
test('configuration rejects external images and SVG, fingerprints ignore property order', () => {
  const input = { expectedRevision: 0, enabled: true, merchantAccountId: 'alipay-main', payeeName: 'test', instructions: '' }
  for (const qrImage of ['https://evil.test/code.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,PHN2Zz4=']) assert.throws(() => settingsInput({ ...input, qrImage }), { code: 'invalid_payment_qr' })
  assert.equal(fingerprint({ b: 2, a: 1 }), fingerprint({ a: 1, b: 2 }))
})
