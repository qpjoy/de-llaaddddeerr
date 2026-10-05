// Never navigate to arbitrary code or another site's checkout using a service response.
export function checkoutLocation(value, environment) {
  let url
  try { url = new URL(value) } catch {}
  const host = { live: 'openapi.alipay.com', test: 'openapi-sandbox.dl.alipaydev.com' }[environment]
  if (!url || !host || url.protocol !== 'https:' || url.hostname !== host || url.port || url.username || url.password || url.pathname !== '/gateway.do' || url.hash) {
    throw Object.assign(new Error('支付宝收银台地址无效，请联系管理员检查支付接入；原订单已保留。'), { code: 'payment_checkout_url_invalid' })
  }
  return url.href
}

export function paymentQueryMessage(order) {
  if (!order.paymentQuery || order.status === 'paid') return ''
  if (order.paymentStatus === 'paid') return '支付宝付款已确认，正在入账。请稍后刷新订单，无需再次付款。'
  const messages = {
    not_found: '支付宝暂未查到这笔交易。尚未进入收银台时可点击“支付宝支付”；若已经付款，请稍后查询原订单，勿重复付款。',
    pending: '支付宝交易仍在等待付款。若刚完成付款，请稍后再次查询。',
    review: '已取得渠道记录，但尚不能确认入账，请联系管理员核对原订单，勿重复付款。',
  }
  return messages[order.paymentQuery.status] || '本次查询尚不能确认到账，请稍后查询原订单，勿重复付款。'
}

export function paymentActionError(error) {
  const messages = {
    payment_channel_query_unknown: '暂时无法核实支付宝付款状态，可能是渠道请求或验签异常。原订单已保留，请稍后重试；若持续出现，请联系管理员并提供 Request ID。',
    payment_channel_query_busy: '正在查询或查询过于频繁，请稍等几秒后再试。',
    payment_checkout_expired: '这笔订单的收银台已过期，请先查询付款状态并联系管理员核对，勿重复付款。',
  }
  return messages[error?.code] ? Object.assign(new Error(messages[error.code]), { code: error.code, status: error.status, requestId: error.requestId }) : error
}
