// Read-only presentation of the existing Alipay checkout rule. Do not turn a
// checkout deadline into a cancelled payment or suppress a later paid receipt.
export function paymentExpiry(payment) {
  if (payment?.provider !== 'alipay' || typeof payment.createdAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(payment.createdAt)) return null
  const created = Date.parse(payment.createdAt)
  if (!Number.isFinite(created) || new Date(created).toISOString() !== payment.createdAt.replace(/(?:\.(\d{1,3}))?Z$/,(_match,fraction) => `.${(fraction || '').padEnd(3,'0')}Z`)) return null
  return Math.floor((created + 30 * 60000) / 1000) * 1000
}
export function paymentTimedOut(row, now = Date.now()) {
  const expires = paymentExpiry(row?.payment)
  return !row?.delivered_at && row?.payment?.status === 'pending' && expires !== null && expires - now < 60000
}
// Shared by count/list/export and full-tenant summaries. Historical malformed
// timestamps stay unresolved instead of breaking all orders or guessing a date.
// The shared data plane runs PostgreSQL 16+, which provides pg_input_is_valid.
export const paymentTimedOutSql = `(delivered_at IS NULL AND payment->>'provider'='alipay' AND payment->>'status'='pending'
  AND CASE WHEN payment->>'createdAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,3})?Z$' AND pg_input_is_valid(payment->>'createdAt','timestamp with time zone')
    THEN date_trunc('second',(payment->>'createdAt')::timestamptz)+interval '30 minutes' < now()+interval '1 minute'
    ELSE false END)`
export const checkoutExpiredMessage = '支付超时，请查询原订单的付款状态。'
