const key = 'mx-hub-payment-return'
const valid = value => typeof value === 'string' && /^MXP[0-9a-f]{32}$/i.test(value)

export function alipayReturnTrade(search) {
  const query = new URLSearchParams(search)
  return query.get('method') === 'alipay.trade.page.pay.return' && query.getAll('out_trade_no').length === 1 && valid(query.get('out_trade_no')) ? query.get('out_trade_no') : null
}

// Keep only a non-secret locator across login. Returned amounts, identities,
// status and signatures are never consumed as payment evidence.
export function restorePaymentReturn(browser) {
  const query = new URLSearchParams(browser.location.search)
  const isReturn = query.get('method') === 'alipay.trade.page.pay.return'
  let trade = alipayReturnTrade(browser.location.search)
  try {
    if (trade) browser.sessionStorage.setItem(key, JSON.stringify({trade, expires: Date.now() + 30 * 60_000}))
    else if (query.get('sso') === 'ready' || !browser.location.hash) {
      const saved = JSON.parse(browser.sessionStorage.getItem(key) || 'null')
      if (saved?.expires > Date.now() && valid(saved.trade)) trade = saved.trade
      else browser.sessionStorage.removeItem(key)
    }
  } catch { /* Current return still works without browser storage. */ }
  if (!trade && !isReturn) return
  const search = query.get('sso') === 'ready' ? '?sso=ready' : ''
  browser.history.replaceState(null, '', `${browser.location.pathname}${search}#/payments${trade ? `?paymentReturn=${encodeURIComponent(trade)}` : ''}`)
}

export function clearPaymentReturn(browser) {
  try { browser.sessionStorage.removeItem(key) } catch { /* optional browser storage */ }
}
