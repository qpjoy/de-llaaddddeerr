import { PaymentError, requestKey } from './index.mjs'

// Server-side credentials only. This SDK does not import pg or any Hub/Launcher code.
export class PaymentClient {
  constructor({ baseUrl, token, timeoutMs = 10000, fetchImplementation = fetch }) {
    const url = new URL(baseUrl)
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Payment base URL must be an HTTP(S) origin')
    if (typeof token !== 'string' || token.length < 32) throw new Error('Payment service token required')
    this.baseUrl = url.origin; this.token = token; this.timeoutMs = timeoutMs; this.fetch = fetchImplementation
  }
  async request(path, { method = 'GET', body, key } = {}) {
    if (key) requestKey(key)
    let response
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body) })
      const result = await response.json()
      if (!response.ok) throw new PaymentError(response.status, result.error?.code || 'payment_unavailable', result.error?.message || 'Payment request failed')
      return result.data
    } catch (error) {
      if (error instanceof PaymentError) throw error
      throw new PaymentError(503, method === 'GET' ? 'payment_unavailable' : 'payment_outcome_unknown', 'Payment response unavailable; keep the original idempotency key')
    }
  }
  create(body, key) { return this.request('/v1/orders', { method: 'POST', body, key }) }
  order(id) { return this.request(`/v1/orders/${encodeURIComponent(id)}`) }
  act(id, action, body, key) { return this.request(`/v1/orders/${encodeURIComponent(id)}/${encodeURIComponent(action)}`, { method: 'POST', body, key }) }
  events(after) { return this.request(`/v1/events${after ? `?after=${encodeURIComponent(after)}` : ''}`) }
  acknowledge(id, businessReceipt) { return this.request(`/v1/events/${encodeURIComponent(id)}/ack`, { method: 'POST', body: { businessReceipt } }) }
  async consumeBatch(commitBusinessEvent, { after } = {}) {
    const { items, nextAfter = null } = await this.events(after), result = { acknowledged: [], failed: [], nextAfter }
    for (const event of items) {
      try {
        // Consumer must atomically commit an inbox entry + business ledger and return
        // the same receipt on replay. Ack loss deliberately causes redelivery.
        const receipt = await commitBusinessEvent(event)
        if (typeof receipt !== 'string' || !receipt.trim()) throw new Error('Committed business receipt required')
        await this.acknowledge(event.id, receipt)
        result.acknowledged.push(event.id)
      } catch (error) { result.failed.push({ id: event.id, code: error.code || 'business_delivery_failed' }) }
    }
    return result
  }
}
