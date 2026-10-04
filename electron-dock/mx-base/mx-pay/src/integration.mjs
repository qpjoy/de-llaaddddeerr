import { requirePayment } from './index.mjs'

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

// Consumers persist sourceId and paymentId in their own database. Never learn a
// replacement identity automatically after a timeout, restart or config change.
export function verifyPaymentSource(identity, { appId, environment, sourceId, features = [], scopes = [] }, {
  sourceCode = 'payment_source_mismatch', scopeCode = 'payment_credential_scope',
} = {}) {
  requirePayment(uuid(identity?.sourceId) && identity.appId === appId && identity.environment === environment
    && (!sourceId || identity.sourceId === sourceId) && Array.isArray(identity.features)
    && features.every(feature => identity.features.includes(feature)), sourceCode, '支付服务身份或协议不匹配', 409)
  requirePayment(Array.isArray(identity.scopes) && scopes.every(scope => identity.scopes.includes(scope)),
    scopeCode, '支付服务凭据权限不足', 409)
  return identity
}

export function verifyPaymentOrder(payment, expected, { code = 'payment_order_mismatch' } = {}) {
  requirePayment(uuid(payment?.id) && Number.isSafeInteger(payment.revision) && payment.revision >= 0
    && ['pending','submitted','paid','cancelled'].includes(payment.status)
    && (!expected.paymentId || payment.id === expected.paymentId)
    && ['appId','environment','businessOrderId','customerRef','amountMinor','currency','initiatorRef']
      .every(key => payment[key] === expected[key])
    && (expected.channelId === 'mock' ? payment.provider === 'mock' && expected.environment === 'test'
      : payment.provider === 'alipay' && payment.checkout?.channelId === expected.channelId),
  code, '支付记录与原业务意图不一致，已停止交付', 409)
  return payment
}
