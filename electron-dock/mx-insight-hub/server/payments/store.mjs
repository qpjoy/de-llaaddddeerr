import { randomUUID } from 'node:crypto'
import { defaultSettings } from '@qpjoy/mx-pay'
import { AppError } from '../core/errors.mjs'
import { withPgTransaction } from '../stores/postgres-store.mjs'

const states = new WeakMap()
const copy = value => structuredClone(value)
const notFound = () => new AppError(404, 'payment_not_found', '充值订单不存在')

// Both listeners share the Hub store. Memory is a local demo only; production
// uses PostgreSQL locks, unique receipt identity and the existing wallet trigger.
export class PaymentStore {
  constructor(hubStore) {
    this.hub = hubStore
    this.pool = hubStore.pool
    if (!this.pool && !states.has(hubStore)) states.set(hubStore, { orders: new Map(), events: [], settings: defaultSettings(), testCredits: [], tail: Promise.resolve() })
    this.memory = states.get(hubStore)
  }

  async atomic(scope, work) {
    if (this.pool) {
      try {
        return await withPgTransaction(this.pool, async client => {
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`mx-pay:${scope}`])
          return work(client)
        }, { outcomeUnknownCode: 'payment_outcome_unknown' })
      } catch (error) {
        if (error.code === '23505') throw new AppError(409, 'payment_receipt_used', '支付流水号已关联其他订单，请核对到账记录')
        throw error
      }
    }
    const state = this.memory
    const prior = state.tail
    let release
    state.tail = new Promise(resolve => { release = resolve })
    await prior
    // Include the existing memory wallet so a late failure is atomic here too.
    const before = copy({ orders: state.orders, events: state.events, settings: state.settings, testCredits: state.testCredits,
      creditAccounts: this.hub.creditAccounts, creditLedgerEntries: this.hub.creditLedgerEntries, creditAdjustmentKeys: this.hub.creditAdjustmentKeys })
    try { return await work(null) } catch (error) {
      for (const key of ['orders', 'events', 'settings', 'testCredits']) state[key] = before[key]
      for (const key of ['creditAccounts', 'creditLedgerEntries', 'creditAdjustmentKeys']) this.hub[key] = before[key]
      throw error
    } finally { release() }
  }

  async settings(client = this.pool) {
    return client ? copy((await client.query("SELECT document FROM mx_pay.settings WHERE id='manual_alipay'")).rows[0]?.document || defaultSettings()) : copy(this.memory.settings)
  }
  async saveSettings(document, client) {
    if (client) await client.query("INSERT INTO mx_pay.settings(id,document) VALUES ('manual_alipay',$1) ON CONFLICT(id) DO UPDATE SET document=excluded.document", [document])
    else this.memory.settings = copy(document)
  }
  async findCreated(tenantId, environment, key, client) {
    if (client) return (await client.query('SELECT document,fingerprint FROM mx_pay.orders WHERE tenant_id=$1 AND environment=$2 AND request_key=$3', [tenantId, environment, key])).rows[0]
    return copy([...this.memory.orders.values()].find(row => row.document.tenantId === tenantId && row.document.environment === environment && row.key === key))
  }
  async order(id, tenantId = null, client = this.pool) {
    const row = client ? (await client.query(`SELECT document FROM mx_pay.orders WHERE id=$1${tenantId ? ' AND tenant_id=$2' : ''}`, tenantId ? [id, tenantId] : [id])).rows[0] : this.memory.orders.get(id)
    if (!row || (tenantId && row.document.tenantId !== tenantId)) throw notFound()
    return copy(row.document)
  }
  async insert(order, key, fingerprint, client) {
    if (client) await client.query('INSERT INTO mx_pay.orders(id,tenant_id,request_key,fingerprint,document) VALUES ($1,$2,$3,$4,$5)', [order.id, order.tenantId, key, fingerprint, order])
    else this.memory.orders.set(order.id, { document: copy(order), key, fingerprint })
  }
  async save(order, client) {
    if (client) await client.query('UPDATE mx_pay.orders SET document=$2 WHERE id=$1', [order.id, order])
    else {
      if (order.settlement && [...this.memory.orders.values()].some(({ document: old }) => old.id !== order.id && old.environment === order.environment && old.provider === order.provider && old.merchantAccountId === order.merchantAccountId && old.settlement?.tradeNo === order.settlement.tradeNo)) {
        throw new AppError(409, 'payment_receipt_used', '支付流水号已关联其他订单，请核对到账记录')
      }
      this.memory.orders.get(order.id).document = copy(order)
    }
  }
  async eventFor(id, key, client) {
    return client ? (await client.query('SELECT fingerprint FROM mx_pay.events WHERE order_id=$1 AND request_key=$2', [id, key])).rows[0]
      : this.memory.events.find(event => event.orderId === id && event.key === key)
  }
  async event(order, action, key, fingerprint, actor, client) {
    const document = { id: randomUUID(), action, actor, at: order.updatedAt, revision: order.revision,
      status: order.status, submission: order.submission, settlement: order.settlement, invoice: order.invoice, rejection: order.rejection }
    if (client) await client.query('INSERT INTO mx_pay.events(id,order_id,request_key,fingerprint,document) VALUES ($1,$2,$3,$4,$5)', [document.id, order.id || null, key, fingerprint, document])
    else this.memory.events.push({ orderId: order.id, key, fingerprint, document: copy(document) })
  }
  async events(id) {
    return this.pool ? (await this.pool.query('SELECT document FROM mx_pay.events WHERE order_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100', [id])).rows.map(row => row.document)
      : copy(this.memory.events.filter(event => event.orderId === id).slice(-100).reverse().map(event => event.document))
  }
  async credit(order, actor, client) {
    if (order.environment === 'test') {
      const id = randomUUID()
      if (client) await client.query('INSERT INTO mx_pay.test_credits(id,order_id,tenant_id,amount_minor) VALUES ($1,$2,$3,$4)', [id, order.id, order.tenantId, order.amountMinor])
      else this.memory.testCredits.push({ id, orderId: order.id, tenantId: order.tenantId, amountMinor: order.amountMinor })
      return id
    }
    const credit = await this.hub.addTenantCredit({ tenantId: order.tenantId, amountMinor: order.amountMinor, currency: order.currency,
      reason: 'mx-pay 充值订单核实到账', externalReference: `mx-pay:${order.id}`, idempotencyKey: `mx-pay:${order.id}`, actor, transactionClient: client })
    return credit.id
  }
  async invoiceTasks() {
    let rows
    if (this.pool) {
      const source = this.includeRecharge ? `(SELECT environment,invoice_status FROM mx_pay.orders UNION ALL
        SELECT environment,invoice->>'status' AS invoice_status FROM hub_recharge.orders) AS invoices` : 'mx_pay.orders'
      rows = (await this.pool.query(`SELECT environment,count(*)::int AS count FROM ${source} WHERE invoice_status='requested' GROUP BY environment`)).rows
    } else {
      rows = ['live','test'].map(environment => ({environment, count: [...this.memory.orders.values()].filter(({document}) => document.environment === environment && document.invoice?.status === 'requested').length}))
    }
    return { live: rows.find(row => row.environment === 'live')?.count || 0, test: rows.find(row => row.environment === 'test')?.count || 0, checkedAt: new Date().toISOString() }
  }
  async list({ tenantId = null, environment, status = '', invoiceStatus = '', invoicesOnly = false, orderId = '', page = 1, pageSize = 20 }) {
    let rows
    if (this.pool) {
      const args = [environment], clauses = ['environment=$1']
      if (invoicesOnly) clauses.push("invoice_status IN ('requested','issued','rejected')")
      for (const [column, value] of [['tenant_id', tenantId], ['status', status], ['invoice_status', invoiceStatus], ['id', orderId]]) {
        if (value) { args.push(value); clauses.push(`${column}=$${args.length}`) }
      }
      args.push(pageSize + 1, (page - 1) * pageSize)
      const source = this.includeRecharge ? `(SELECT id,tenant_id,environment,status,invoice_status,created_at,document FROM mx_pay.orders
        UNION ALL SELECT id,tenant_id,environment,status,invoice_status,created_at,document FROM hub_recharge.order_documents) AS orders` : 'mx_pay.orders'
      rows = (await this.pool.query(`SELECT document - 'checkout' AS document FROM ${source} WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT $${args.length - 1} OFFSET $${args.length}`, args)).rows.map(row => row.document)
    } else {
      rows = [...this.memory.orders.values()].map(row => copy(row.document))
        .filter(row => row.environment === environment && (!tenantId || row.tenantId === tenantId) && (!status || row.status === status) && (!invoiceStatus || row.invoice?.status === invoiceStatus) && (!invoicesOnly || row.invoice) && (!orderId || row.id === orderId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice((page - 1) * pageSize, page * pageSize + 1)
      for (const row of rows) delete row.checkout
    }
    return { items: rows.slice(0, pageSize), page, pageSize, hasMore: rows.length > pageSize }
  }
}
