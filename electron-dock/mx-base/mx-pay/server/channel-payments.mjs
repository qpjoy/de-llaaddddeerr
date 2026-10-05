import { randomUUID } from 'node:crypto'
import { AlipayChannel, decimalMinor, alipayTime, alipaySubject, alipayOrderNo, alipayOrderId, newAlipayOrderNo } from './alipay.mjs'
import { authorize } from './config.mjs'
import { requirePayment, fingerprint, minor, fields } from '../src/index.mjs'

export class ChannelPayments {
  constructor(center, configs = [], factory = config => new AlipayChannel(config)) {
    this.center = center
    this.adapters = new Map(configs.map(config => [config.id, factory(config)]))
    this.queriesInFlight = 0
  }
  async bind() {
    await this.center.atomic('channel-bindings', async client => {
      for (const [id, { config: c }] of this.adapters) {
        const identity = { provider: c.provider, environment: c.environment, appId: c.appId, sellerId: c.sellerId }
        await client.query('INSERT INTO pay.channel_bindings(id,identity) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, identity])
        const stored = (await client.query('SELECT identity FROM pay.channel_bindings WHERE id=$1', [id])).rows[0].identity
        requirePayment(fingerprint(stored) === fingerprint(identity), 'payment_channel_identity_changed', 'Existing channel identity cannot change; retain old configuration for pending receipts', 409)
      }
      const stored = (await client.query('SELECT id FROM pay.channel_bindings')).rows
      requirePayment(stored.every(row => this.adapters.has(row.id)), 'payment_channel_configuration_missing', 'Retain existing channels with enabled=false instead of removing receipt verification configuration', 409)
    })
  }
  available(principal) {
    return [...this.adapters.values()].filter(({ config: c }) => c.environment === principal.environment && c.allowedApps.includes(principal.appId))
      .map(({ config: c }) => ({ id: c.id, provider: c.provider, environment: c.environment, enabled: c.enabled,
        mode: 'page', currency: 'CNY', minMinor: 100, maxMinor: 10_000_000 }))
  }
  adapter(id) {
    const adapter = this.adapters.get(id)
    requirePayment(adapter, 'payment_channel_unavailable', 'Payment channel configuration unavailable', 409)
    return adapter
  }
  forOrder(order) {
    requirePayment(order.provider === 'alipay', 'payment_channel_action', 'This order does not use an automatic channel', 409)
    const adapter = this.adapter(order.checkout.channelId), c = adapter.config
    requirePayment(c.environment === order.environment && c.appId === order.checkout.alipayAppId && c.sellerId === order.merchantAccountId,
      'payment_channel_identity_changed', 'Channel identity does not match immutable order', 409)
    return adapter
  }
  create(principal, body) {
    const { config: c } = this.adapter(body.channelId)
    requirePayment(c.environment === principal.environment && c.allowedApps.includes(principal.appId), 'payment_channel_forbidden', 'Channel is not assigned to this application/environment', 403)
    requirePayment(c.enabled, 'payment_channel_disabled', 'Payment channel disabled', 409)
    const now = new Date().toISOString(), id = randomUUID()
    return { id, environment: principal.environment, provider: 'alipay', merchantAccountId: c.sellerId,
      subject: alipaySubject(body.subject), amountMinor: minor(body.amountMinor, 'amountMinor', { min: 100 }), currency: 'CNY',
      status: 'pending', revision: 0, checkout: { type: 'alipay_page', channelId: c.id, alipayAppId: c.appId, sellerId: c.sellerId, outTradeNo: newAlipayOrderNo(id) },
      submission: null, settlement: null, rejection: null, createdBy: `credential:${principal.id}`, createdAt: now, updatedAt: now }
  }
  async checkout(principal, id, body) {
    authorize(principal, 'orders.write'); fields(body, [])
    const order = await this.center.order(principal, id), adapter = this.forOrder(order)
    requirePayment(adapter.config.enabled && adapter.config.allowedApps.includes(principal.appId), 'payment_channel_disabled', 'Checkout disabled', 409)
    requirePayment(order.status === 'pending', 'payment_state_conflict', 'Order is not awaiting payment', 409)
    return adapter.checkout(order)
  }
  async notify(channelId, body) {
    const adapter = this.adapter(channelId)
    return this.observe(adapter, adapter.verify(body), 'notify')
  }
  async refresh(principal, id, body) {
    authorize(principal, 'orders.write'); fields(body, [])
    requirePayment(this.queriesInFlight < 4, 'payment_channel_query_busy', 'Channel query capacity reached; read the order and retry later', 429)
    this.queriesInFlight += 1
    try { return await this.queryOrder(principal, id) }
    finally { this.queriesInFlight -= 1 }
  }
  async queryOrder(principal, id) {
    const order = await this.center.order(principal, id), adapter = this.forOrder(order), lease = randomUUID()
    const acquired = await this.center.pool.query(`INSERT INTO pay.channel_queries(order_id,lease_id,available_at)
      VALUES ($1,$2,now()+interval '20 seconds') ON CONFLICT(order_id) DO UPDATE SET lease_id=excluded.lease_id,available_at=excluded.available_at
      WHERE pay.channel_queries.available_at<=now() RETURNING order_id`, [order.id, lease])
    requirePayment(acquired.rowCount === 1, 'payment_channel_query_busy', 'Query in progress or cooling down; read the order and retry later', 429)
    try {
      const result = await adapter.query(order)
      if (result.code === '40004' && result.sub_code === 'ACQ.TRADE_NOT_EXIST') {
        // Keep the original order; a concurrent notification may already have settled it.
        return { order: await this.center.order(principal, id), query: { status: 'not_found' } }
      }
      // A signed but unrelated response must never settle another application's order.
      requirePayment(result.out_trade_no === alipayOrderNo(order), 'payment_channel_query_identity', 'Query returned an unrelated order', 502)
      const observation = await this.observe(adapter, result, 'query')
      return { order: await this.center.order(principal, id), observation }
    } finally {
      await this.center.pool.query("UPDATE pay.channel_queries SET available_at=now()+interval '3 seconds' WHERE order_id=$1 AND lease_id=$2", [order.id, lease]).catch(() => {})
    }
  }
  async observe(adapter, body, source) {
    const c = adapter.config
    const evidence = { source, outTradeNo: body.out_trade_no ?? null, tradeNo: body.trade_no ?? null, tradeStatus: body.trade_status ?? null,
      appId: body.app_id ?? null, sellerId: body.seller_id ?? null, totalAmount: body.total_amount ?? null,
      receiptAmount: body.receipt_amount ?? null, paidAt: body.gmt_payment ?? null, currency: body.trans_currency || 'CNY',
      ...(body.additional_status ? { additionalStatus: body.additional_status } : {}),
      ...(body.credit_pay_mode ? { creditPayMode: body.credit_pay_mode } : {}) }
    const digest = fingerprint(evidence)
    const orderId = alipayOrderId(body.out_trade_no)
    return this.center.atomic(orderId ? `order:${orderId}` : `observation:${c.id}:${digest}`, async client => {
      const prior = (await client.query('SELECT id,outcome,reason FROM pay.channel_observations WHERE channel_id=$1 AND fingerprint=$2', [c.id, digest])).rows[0]
      if (prior) return prior
      const row = orderId && (await client.query('SELECT document FROM pay.orders WHERE id=$1', [orderId])).rows[0]
      const candidate = row?.document
      // Never attach evidence from one channel to another application's payment.
      const order = candidate?.provider === 'alipay' && candidate.checkout.channelId === c.id && candidate.environment === c.environment
        && alipayOrderNo(candidate) === body.out_trade_no ? candidate : null
      let outcome = 'review', reason = 'unmatched_order'
      const paidAt = alipayTime(body.gmt_payment)
      if (order) {
        if (body.app_id !== c.appId || body.seller_id !== c.sellerId || order.merchantAccountId !== c.sellerId || order.checkout.alipayAppId !== c.appId) reason = 'channel_identity_mismatch'
        else if (evidence.currency !== 'CNY' || decimalMinor(body.total_amount) !== order.amountMinor) reason = 'amount_or_currency_mismatch'
        else if (body.trade_status === 'WAIT_BUYER_PAY') { outcome = 'pending'; reason = 'awaiting_channel_payment' }
        else if (body.trade_status === 'TRADE_CLOSED') reason = 'channel_closed_or_refunded_requires_review'
        else if (!['TRADE_SUCCESS','TRADE_FINISHED'].includes(body.trade_status)) reason = 'unknown_channel_status'
        else if (body.additional_status || body.credit_pay_mode) reason = 'unsupported_channel_funding_state'
        else if (!/^\d{16,64}$/.test(body.trade_no || '')) reason = 'invalid_trade_number'
        else if (body.receipt_amount !== undefined && decimalMinor(body.receipt_amount) !== order.amountMinor) reason = 'receipt_amount_requires_review'
        else if (order.status === 'paid') {
          outcome = order.settlement.tradeNo === body.trade_no ? 'duplicate' : 'review'; reason = outcome === 'duplicate' ? 'already_paid' : 'different_receipt_for_paid_order'
        } else if (order.status !== 'pending') reason = 'late_receipt_for_terminal_order'
        else if (!paidAt || Date.parse(paidAt) < Date.parse(order.createdAt) - 300000 || Date.parse(paidAt) > Date.now() + 300000) reason = 'invalid_channel_payment_time'
        else {
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pay:receipt:${c.environment}:alipay:${c.sellerId}:${body.trade_no}`])
          const used = await client.query("SELECT id FROM pay.orders WHERE environment=$1 AND provider IN ('manual_alipay','alipay') AND merchant_account_id=$2 AND trade_no=$3", [c.environment, c.sellerId, body.trade_no])
          if (used.rowCount) reason = 'receipt_used_by_another_order'
          else {
            const now = new Date().toISOString(), next = { ...order, status: 'paid', revision: order.revision + 1, updatedAt: now,
              settlement: { tradeNo: body.trade_no, amountMinor: order.amountMinor, feeMinor: null, paidAt, confirmedAt: now,
                confirmedBy: `channel:${c.id}`, note: `Verified Alipay ${source}`, ledgerEntryId: null } }
            await client.query('UPDATE pay.orders SET document=$2 WHERE id=$1', [order.id, next])
            await this.center.audit(client, order.id, `channel:${digest}`, digest, { action: 'channel-paid', channelId: c.id, source, at: now, revision: next.revision })
            await this.center.paidEvent(client, next)
            outcome = 'paid'; reason = 'verified_payment'
          }
        }
      }
      const observation = { id: randomUUID(), outcome, reason }
      await client.query(`INSERT INTO pay.channel_observations(id,channel_id,fingerprint,order_id,app_id,environment,outcome,reason,document)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [observation.id,c.id,digest,order?.id || null,order?.appId || null,c.environment,outcome,reason,{...evidence,payloadHash:fingerprint(body)}])
      return observation
    })
  }
  async reviews(principal, query) {
    authorize(principal, 'receipts.confirm')
    requirePayment([...query.keys()].every(k => k === 'page' && query.getAll(k).length === 1), 'invalid_payment_query', 'Invalid review query')
    const page = Number(query.get('page') || 1)
    requirePayment(Number.isInteger(page) && page >= 1 && page <= 10000, 'invalid_payment_query', 'Invalid page')
    const { rows } = await this.center.pool.query(`SELECT id,channel_id AS "channelId",order_id AS "paymentId",reason,document,created_at AS "createdAt"
      FROM pay.channel_observations WHERE app_id=$1 AND environment=$2 AND outcome='review' ORDER BY created_at DESC,id DESC LIMIT 101 OFFSET $3`, [principal.appId,principal.environment,(page-1)*100])
    return { items: rows.slice(0,100), page, hasMore: rows.length > 100 }
  }
}
