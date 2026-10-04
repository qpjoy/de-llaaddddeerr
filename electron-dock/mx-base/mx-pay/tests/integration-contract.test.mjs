import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyPaymentSource, verifyPaymentOrder } from '../src/integration.mjs'

const id = '13c82fc5-eedf-42ae-969f-c8d59b7a0e38'
const identity = { sourceId: id, appId: 'example', environment: 'test', features: ['initiatorRef'], scopes: ['orders.read'] }
const expected = { paymentId: id, appId: 'example', environment: 'test', businessOrderId: 'stable-business-order',
  customerRef: 'customer', amountMinor: 500, currency: 'CNY', initiatorRef: 'app-member', channelId: 'mock' }
const order = { ...expected, id, status: 'paid', revision: 2, provider: 'mock' }

test('consumer source binding rejects replacement, wrong application/environment and missing capabilities', () => {
  const binding = { ...identity, features: ['initiatorRef'], scopes: ['orders.read'] }
  assert.equal(verifyPaymentSource(identity, binding), identity)
  for (const change of [{ sourceId: 'invalid' }, { appId: 'other' }, { environment: 'live' }, { features: [] }, { scopes: [] }]) {
    assert.throws(() => verifyPaymentSource({ ...identity, ...change }, binding), { status: 409 })
  }
  assert.throws(() => verifyPaymentSource(identity, { ...binding, sourceId: '28c82fc5-eedf-42ae-969f-c8d59b7a0e38' }), { code: 'payment_source_mismatch' })
})

test('consumer verifies every immutable business/payment field before delivery, with stable adapter errors', () => {
  assert.equal(verifyPaymentOrder(order, expected), order)
  for (const change of [{ id: 'invalid' }, { revision: -1 }, { appId: 'other' }, { environment: 'live' },
    { businessOrderId: 'replacement' }, { customerRef: 'other' }, { amountMinor: 501 }, { currency: 'USD' },
    { initiatorRef: 'another-member' }, { status: 'unknown' }, { provider: 'alipay' }]) {
    assert.throws(() => verifyPaymentOrder({ ...order, ...change }, expected, { code: 'recharge_payment_mismatch' }), { code: 'recharge_payment_mismatch' })
  }
  const channelOrder = { ...order, provider: 'alipay', checkout: { channelId: 'sandbox' } }
  assert.equal(verifyPaymentOrder(channelOrder, { ...expected, channelId: 'sandbox' }), channelOrder)
  assert.throws(() => verifyPaymentOrder(channelOrder, { ...expected, channelId: 'other' }), { status: 409 })
})
