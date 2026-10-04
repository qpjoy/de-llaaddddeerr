import { randomUUID } from 'node:crypto'
import { createOrder, transitionOrder, settingsInput, requestKey, fingerprint, defaultSettings, requirePayment, fields, text, PaymentError } from '../src/index.mjs'
import { authorize } from './config.mjs'
import { ReportingReader } from './reporting.mjs'
import { ChannelPayments } from './channel-payments.mjs'

export const uuid = value => {
  requirePayment(typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value), 'invalid_payment_id', 'Invalid UUID')
  return value.toLowerCase()
}
const actorOf = principal => `credential:${principal.id}`
export class PaymentCenter {
  constructor(pool, { reportingPool = pool, channels = [], channelFactory } = {}) {
    this.pool = pool; this.reporting = new ReportingReader(reportingPool)
    this.channelPayments = new ChannelPayments(this, channels, channelFactory)
  }
  async atomic(scope, work) {
    const client = await this.pool.connect()
    let committing = false
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pay:${scope}`])
      const result = await work(client)
      committing = true
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      if (error.code === '23505') throw new PaymentError(409, 'payment_identity_conflict', 'Receipt or business order already recorded; query the original order')
      if (committing) throw new PaymentError(503, 'payment_outcome_unknown', 'Outcome unknown; query or retry with the same idempotency key')
      throw error
    } finally { client.release() }
  }
  async settings(client = this.pool) {
    return (await client.query("SELECT document FROM pay.settings WHERE id='manual_alipay'")).rows[0]?.document || defaultSettings()
  }
  async identity(principal) {
    authorize(principal, 'orders.read')
    const { rows } = await this.pool.query('SELECT id FROM pay.reporting_source WHERE singleton=true')
    requirePayment(rows.length === 1, 'payment_source_unavailable', 'Payment source identity unavailable', 503)
    return { sourceId: rows[0].id, appId: principal.appId, environment: principal.environment, features: ['initiatorRef'], scopes: principal.scopes }
  }
  async channels(principal) {
    authorize(principal, 'orders.read')
    const settings = await this.settings()
    return { environment: principal.environment, provider: principal.environment === 'test' ? 'mock' : 'manual_alipay',
      enabled: principal.environment === 'test' || settings.enabled, currency: 'CNY', minMinor: 500, maxMinor: 10_000_000,
      items: [{ id: principal.environment === 'test' ? 'mock' : 'manual_alipay', provider: principal.environment === 'test' ? 'mock' : 'manual_alipay',
        environment: principal.environment, enabled: principal.environment === 'test' || settings.enabled, mode: 'manual', currency: 'CNY', minMinor: 500, maxMinor: 10_000_000 }, ...this.channelPayments.available(principal)] }
  }
  async configure(principal, body) {
    authorize(principal, 'settings.write')
    requirePayment(principal.environment === 'live', 'payment_environment_mismatch', 'Live settings require a live credential', 403)
    const input = settingsInput(body)
    return this.atomic('settings', async client => {
      const current = await this.settings(client)
      requirePayment(current.revision === body.expectedRevision, 'payment_revision_conflict', 'Reload settings', 409)
      requirePayment(!current.merchantAccountId || current.merchantAccountId === input.merchantAccountId, 'payment_account_immutable', 'Merchant account identity cannot change', 409)
      const next = { ...input, revision: current.revision + 1, updatedAt: new Date().toISOString(), updatedBy: actorOf(principal) }
      await client.query("INSERT INTO pay.settings VALUES ('manual_alipay',$1) ON CONFLICT(id) DO UPDATE SET document=excluded.document", [next])
      await this.audit(client, null, `settings:${next.revision}`, fingerprint(input), { action: 'configure', actor: actorOf(principal), revision: next.revision, enabled: next.enabled })
      return next
    })
  }
  async audit(client, orderId, key, hash, document) {
    await client.query('INSERT INTO pay.audit(id,order_id,request_key,fingerprint,document) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), orderId, key, hash, document])
  }
  async create(principal, body, key) {
    authorize(principal, 'orders.write'); requestKey(key)
    fields(body, ['businessOrderId','customerRef','amountMinor','channelId','subject','initiatorRef'])
    requirePayment(body.channelId !== undefined || body.subject === undefined, 'invalid_payment', 'subject requires an explicit channel')
    const businessOrderId = text(body.businessOrderId, 'businessOrderId', 128), customerRef = text(body.customerRef, 'customerRef', 128)
    const initiator = body.initiatorRef === undefined ? {} : { initiatorRef: text(body.initiatorRef, 'initiatorRef', 200) }
    const hash = fingerprint({ businessOrderId, customerRef, amountMinor: body.amountMinor, ...initiator,
      ...(body.channelId === undefined ? {} : { channelId: text(body.channelId, 'channelId', 80), subject: body.subject }) })
    return this.atomic(`create:${principal.appId}:${principal.environment}:${key}`, async client => {
      const prior = (await client.query('SELECT document,fingerprint,request_key FROM pay.orders WHERE app_id=$1 AND environment=$2 AND (request_key=$3 OR business_order_id=$4)', [principal.appId, principal.environment, key, businessOrderId])).rows
      if (prior.length) {
        requirePayment(prior.length === 1 && prior[0].fingerprint === hash && prior[0].request_key === key, 'payment_idempotency_conflict', 'Keep the original business order, amount and key', 409)
        return prior[0].document
      }
      const legacy = body.channelId === undefined || body.channelId === (principal.environment === 'test' ? 'mock' : 'manual_alipay')
      requirePayment(!legacy || body.subject === undefined, 'invalid_payment', 'Legacy channels do not accept subject')
      const { tenantId: ignored, invoice, ...base } = legacy
        ? createOrder({ tenantId: customerRef, input: { environment: principal.environment, amountMinor: body.amountMinor }, settings: await this.settings(client), actor: actorOf(principal) })
        : this.channelPayments.create(principal, body)
      // Application-attested audit reference, never a replacement for service authorization.
      const order = { ...base, appId: principal.appId, businessOrderId, customerRef, ...initiator }
      await client.query('INSERT INTO pay.orders(id,app_id,environment,business_order_id,request_key,fingerprint,document) VALUES ($1,$2,$3,$4,$5,$6,$7)', [order.id, principal.appId, principal.environment, businessOrderId, key, hash, order])
      await this.audit(client, order.id, `create:${key}`, hash, { action: 'create', actor: actorOf(principal), at: order.createdAt, revision: 0 })
      return order
    })
  }
  async order(principal, id, client = this.pool) {
    const row = (await client.query('SELECT document FROM pay.orders WHERE id=$1 AND app_id=$2 AND environment=$3', [uuid(id), principal.appId, principal.environment])).rows[0]
    requirePayment(row, 'payment_not_found', 'Payment order not found', 404)
    return row.document
  }
  async act(principal, id, action, body, key) {
    requirePayment(['submit','cancel','confirm','reject'].includes(action), 'invalid_payment_action', 'Unsupported payment action')
    const finance = ['confirm','reject'].includes(action)
    authorize(principal, finance ? 'receipts.confirm' : 'orders.write'); requestKey(key); uuid(id)
    const hash = fingerprint({ action, body })
    return this.atomic(`order:${id}`, async client => {
      const order = await this.order(principal, id, client)
      requirePayment(order.provider !== 'alipay', 'payment_channel_action', 'Automatic channel orders require verified notification/query; manual settlement and local cancellation are forbidden', 409)
      const prior = (await client.query('SELECT fingerprint FROM pay.audit WHERE order_id=$1 AND request_key=$2', [id, key])).rows[0]
      if (prior) {
        requirePayment(prior.fingerprint === hash, 'payment_idempotency_conflict', 'Idempotency key was used for another action', 409)
        return order
      }
      const next = transitionOrder(order, action, body, { actor: actorOf(principal), finance })
      // Payment success and durable notification are one local transaction. No wallet calls here.
      await client.query('UPDATE pay.orders SET document=$2 WHERE id=$1', [id, next])
      await this.audit(client, id, key, hash, { action, actor: actorOf(principal), at: next.updatedAt, revision: next.revision, submission: next.submission, settlement: next.settlement })
      if (action === 'confirm') {
        await this.paidEvent(client, next)
      }
      return next
    })
  }
  async paidEvent(client, order) {
    const event = { id: randomUUID(), version: 1, type: 'payment.paid', appId: order.appId, environment: order.environment,
      paymentId: order.id, businessOrderId: order.businessOrderId, customerRef: order.customerRef, amountMinor: order.amountMinor,
      currency: order.currency, occurredAt: order.updatedAt }
    await client.query('INSERT INTO pay.outbox(id,order_id,app_id,environment,document) VALUES ($1,$2,$3,$4,$5)', [event.id, order.id, order.appId, order.environment, event])
  }
  async list(principal, query) {
    authorize(principal, 'orders.read')
    requirePayment([...query.keys()].every(k => ['status','page','pageSize','businessOrderId'].includes(k) && query.getAll(k).length === 1), 'invalid_payment_query', 'Invalid query')
    const page = Number(query.get('page') || 1), pageSize = Number(query.get('pageSize') || 20), status = query.get('status') || ''
    requirePayment(Number.isInteger(page) && page >= 1 && page <= 10000 && Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= 100 && ['','pending','submitted','paid','cancelled'].includes(status), 'invalid_payment_query', 'Invalid page or status')
    const args = [principal.appId, principal.environment], where = ['app_id=$1','environment=$2']
    for (const [column,value] of [['status',status],['business_order_id',query.get('businessOrderId')]]) if (value) { args.push(value); where.push(`${column}=$${args.length}`) }
    args.push(pageSize + 1, (page - 1) * pageSize)
    const { rows } = await this.pool.query(`SELECT document - 'checkout' AS document FROM pay.orders WHERE ${where.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT $${args.length-1} OFFSET $${args.length}`, args)
    return { items: rows.slice(0,pageSize).map(r => r.document), page, pageSize, hasMore: rows.length > pageSize }
  }
  async pending(principal, query = new URLSearchParams()) {
    authorize(principal, 'events.read')
    requirePayment([...query.keys()].every(key => key === 'after' && query.getAll(key).length === 1), 'invalid_payment_query', 'Invalid event cursor')
    const after = query.get('after'), args = [principal.appId,principal.environment]
    let clause = ''
    if (after) {
      uuid(after)
      const row = (await this.pool.query('SELECT id FROM pay.outbox WHERE id=$1 AND app_id=$2 AND environment=$3', [after,...args])).rows[0]
      requirePayment(row, 'payment_event_not_found', 'Event cursor not found', 404)
      args.push(after)
      clause = ' AND (created_at,id) > (SELECT created_at,id FROM pay.outbox WHERE id=$3)'
    }
    const { rows } = await this.pool.query(`SELECT id,document FROM pay.outbox WHERE app_id=$1 AND environment=$2 AND acknowledged_at IS NULL${clause} ORDER BY created_at,id LIMIT 101`, args)
    // This is a sweep cursor, never a permanent acknowledgement watermark.
    return { items: rows.slice(0,100).map(r => r.document), limit: 100, nextAfter: rows.length > 100 ? rows[99].id : null }
  }
  async acknowledge(principal, id, body) {
    authorize(principal, 'events.ack'); uuid(id); fields(body, ['businessReceipt'])
    const businessReceipt = text(body.businessReceipt, 'businessReceipt', 200)
    return this.atomic(`event:${id}`, async client => {
      const row = (await client.query('SELECT acknowledgement FROM pay.outbox WHERE id=$1 AND app_id=$2 AND environment=$3 FOR UPDATE', [id,principal.appId,principal.environment])).rows[0]
      requirePayment(row, 'payment_event_not_found', 'Event not found', 404)
      if (row.acknowledgement) requirePayment(row.acknowledgement.businessReceipt === businessReceipt, 'payment_ack_conflict', 'Event acknowledged with different evidence', 409)
      else await client.query('UPDATE pay.outbox SET acknowledged_at=now(), acknowledgement=$2 WHERE id=$1', [id, { businessReceipt, actor: actorOf(principal) }])
      return { id, acknowledged: true, businessReceipt }
    })
  }
}
