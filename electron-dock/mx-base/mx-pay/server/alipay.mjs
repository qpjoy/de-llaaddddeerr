import { AlipaySdk } from 'alipay-sdk'
import { requirePayment, PaymentError, text } from '../src/index.mjs'

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const newAlipayOrderNo = id => `MXP${id.replaceAll('-', '')}`
// Never rename a previously issued trade: legacy orders keep their exact UUID.
export const alipayOrderNo = order => order.checkout?.outTradeNo ?? order.id
export const alipayOrderId = value => {
  if (typeof value !== 'string') return null
  const id = /^MXP[0-9a-f]{32}$/.test(value)
    ? value.slice(3).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5') : value
  return uuidV4.test(id) ? id : null
}
export const alipaySubject = value => {
  requirePayment(typeof value !== 'string' || !/[\/=&\p{Cc}\p{Cf}]/u.test(value), 'invalid_payment_subject', 'Alipay subject cannot contain /, =, &, control or formatting characters')
  return text(value, 'subject', 128)
}

export const decimalMinor = value => {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
}
export const alipayTime = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return null
  const ms = Date.parse(`${value.replace(' ', 'T')}+08:00`)
  return Number.isFinite(ms) && chinaTime(ms) === value ? new Date(ms).toISOString() : null
}
const chinaTime = ms => new Date(ms + 8 * 3600000).toISOString().slice(0,19).replace('T', ' ')
export class AlipayChannel {
  constructor(config, sdk) {
    this.config = config
    this.sdk = sdk || new AlipaySdk({ appId: config.appId, privateKey: config.privateKey, keyType: config.keyType,
      alipayPublicKey: config.alipayPublicKey, signType: 'RSA2', camelcase: false, timeout: 5000,
      gateway: config.environment === 'live' ? 'https://openapi.alipay.com/gateway.do' : 'https://openapi-sandbox.dl.alipaydev.com/gateway.do' })
  }
  checkout(order) {
    const now = Date.now(), expires = Math.floor((Date.parse(order.createdAt) + 30 * 60000) / 1000) * 1000
    requirePayment(expires - now >= 60000, 'payment_checkout_expired', 'Checkout requires at least one minute remaining; retain and query this order', 409)
    const outTradeNo = alipayOrderNo(order)
    requirePayment(/^[A-Za-z0-9_]{1,64}$/.test(outTradeNo), 'payment_checkout_legacy_order', 'Legacy channel order is query-only; reconcile it before creating any replacement', 409)
    const subject = alipaySubject(order.subject)
    const amount = `${Math.floor(order.amountMinor / 100)}.${String(order.amountMinor % 100).padStart(2,'0')}`
    // pageExecute signs locally. It neither creates a remote charge nor retries it.
    const payUrl = this.sdk.pageExecute('alipay.trade.page.pay', 'GET', { timestamp: chinaTime(now), notifyUrl: this.config.notifyUrl, returnUrl: this.config.returnUrl,
      bizContent: { out_trade_no: outTradeNo, total_amount: amount, subject, product_code: 'FAST_INSTANT_TRADE_PAY', time_expire: chinaTime(expires) } })
    return { paymentId: order.id, provider: 'alipay', payUrl, expiresAt: new Date(expires).toISOString() }
  }
  verify(body) {
    let verified = false
    try { verified = body.sign_type === 'RSA2' && this.sdk.checkNotifySignV2(body) } catch {}
    requirePayment(verified, 'payment_notification_signature', 'Invalid channel signature', 400)
    requirePayment(body.app_id === this.config.appId && body.seller_id === this.config.sellerId,
      'payment_notification_identity', 'Channel application or seller mismatch', 400)
    return body
  }
  async query(order) {
    try {
      // Explicit response verification; a transport error or missing trade is never payment failure.
      const result = await this.sdk.exec('alipay.trade.query', { timestamp: chinaTime(Date.now()), bizContent: { out_trade_no: alipayOrderNo(order) } }, { validateSign: true })
      // Only an authenticated, explicit missing-trade response is a normal query outcome.
      // Opening page-pay is what creates the trade at Alipay; generating its URL does not.
      if (result.code === '40004' && result.sub_code === 'ACQ.TRADE_NOT_EXIST') return { code: result.code, sub_code: result.sub_code }
      if (result.code !== '10000') throw Error('Query unresolved')
      // Direct merchant queries are authenticated by the configured app. These defaults
      // come from the immutable binding, not fields purportedly returned by Alipay.
      return { ...result, app_id: result.app_id ?? this.config.appId, seller_id: result.seller_id ?? this.config.sellerId, gmt_payment: result.send_pay_date }
    } catch { throw new PaymentError(503, 'payment_channel_query_unknown', 'Channel query could not be verified; retain this order and query later') }
  }
}
