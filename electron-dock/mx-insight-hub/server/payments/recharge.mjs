import { randomUUID } from 'node:crypto'
import { PaymentClient } from '@qpjoy/mx-pay/client'
import { verifyPaymentSource, verifyPaymentOrder } from '@qpjoy/mx-pay/integration'
import { PaymentError, fields, fingerprint, minor, environment, requestKey, requirePayment, transitionOrder } from '@qpjoy/mx-pay'
import { withPgTransaction } from '../stores/postgres-store.mjs'
import { parseRechargeSources } from './recharge-config.mjs'
import { PaymentConnections, checkPaymentConnection, connectionFailure } from './connections.mjs'

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const safeCode = error => /^(payment_|recharge_|credit_|wallet_|tenant_|commerce_)[a-z_]+$/.test(error?.code || '') ? error.code : 'recharge_dependency_unavailable'

// Hub owns recharge intent, beneficiary and delivery. Remote payment facts never
// become wallet credit merely by being read or shown in a browser/report.
export class RechargeService {
  constructor(hubStore, sources = [], { clientFactory = config => new PaymentClient({ ...config, timeoutMs: 5000 }), logger = console, pepper } = {}) {
    this.hub = hubStore; this.pool = hubStore.pool; this.logger = logger
    this.sources = new Map(sources.map(source => [source.environment, { ...source, client: clientFactory(source) }]))
    this.clientFactory = clientFactory
    this.connections = pepper ? new PaymentConnections(this.pool,pepper) : null
    this.cursors = new Map(); this.failures = new Map(); this.stopped = false; this.running = null; this.inFlight = 0
  }
  atomic(work) { return withPgTransaction(this.pool, async client => {
    await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s'")
    return work(client)
  }, { outcomeUnknownCode: 'recharge_outcome_unknown' }) }
  async network(work) {
    requirePayment(this.inFlight < 4, 'recharge_busy', '支付服务繁忙，请稍后重试原订单', 503)
    this.inFlight++
    try { return await work() } finally { this.inFlight-- }
  }
  async route(env, client = this.pool, lock = '') {
    environment(env)
    return (await client.query(`SELECT * FROM hub_recharge.routes WHERE environment=$1 ${lock}`, [env])).rows[0]
  }
  async owns(env) { return Boolean((await this.route(env))?.source_id) }
  async configuredSource(env) {
    const saved = await this.connections?.read(env)
    return saved ? {...saved.source,configRevision:saved.revision,client:this.clientFactory(saved.source)} : this.sources.get(env)
  }
  async remote(env, { allowUnbound = false } = {}) {
    const source = await this.configuredSource(env)
    requirePayment(source, 'recharge_unconfigured', '支付连接尚未配置，原订单会保留', 503)
    const identity = await source.client.identity()
    verifyPaymentSource(identity, { appId: source.appId, environment: env, sourceId: source.sourceId, features: ['initiatorRef'],
      scopes: ['orders.read','orders.write','events.read','events.ack'] },
    { sourceCode: 'recharge_source_mismatch', scopeCode: 'recharge_credential_scope' })
    const route = await this.route(env)
    requirePayment(route && (route.source_id ? route.source_id === identity.sourceId && route.app_id === source.appId && route.channel_id === source.channelId : allowUnbound),
      'recharge_source_mismatch', '支付服务与已绑定账务源不一致，请核对配置', 409)
    return { ...source, identity, route }
  }
  async status() {
    return { items: await Promise.all(['test','live'].map(async env => {
      const route = await this.route(env)
      const legacy = env === 'live' ? Number((await this.pool.query("SELECT count(*) FROM mx_pay.orders WHERE environment='live'")).rows[0].count) : 0
      const errors = (await this.pool.query('SELECT event_id AS "eventId",code,attempts,updated_at AS "updatedAt" FROM hub_recharge.delivery_errors WHERE environment=$1 ORDER BY updated_at DESC LIMIT 20', [env])).rows
      const base = { environment: env, active: Boolean(route.source_id), sourceId: route.source_id, legacyOrderCount: legacy, errors, workerError: this.failures.get(env)?.code || null }
      try {
        base.connection = this.connections ? this.connections.view(await this.connections.current(env,this.sources.get(env))) : null
        const source = await this.remote(env, { allowUnbound: true })
        const checked = await checkPaymentConnection(source,source.client,route,source.identity)
        return { ...base, ...checked, configured: true }
      } catch (error) { const failure=connectionFailure(error);return { ...base, configured: false, error:failure.code,errorMessage:failure.message } }
    })) }
  }
  async configure(env, body, actor, {checkOnly=false} = {}) {
    environment(env)
    requirePayment(this.connections,'recharge_unavailable','界面配置需要保留的 Hub 加密密钥和支付连接迁移',503)
    const candidate = await this.connections.candidate(env,body,this.sources.get(env))
    let checked
    try {
      checked = await this.network(()=>this.route(env).then(route=>checkPaymentConnection(candidate.source,this.clientFactory(candidate.source),route)))
    } catch(error) {
      const failure=connectionFailure(error)
      throw new PaymentError(400,failure.code,failure.message)
    }
    if(checkOnly)return checked
    const connection = await this.atomic(async client=>{
      // Same lock as activation: an in-flight probe cannot overwrite or bind a
      // newer configuration, and an activated source can never be replaced.
      const route=await this.route(env,client,'FOR UPDATE')
      requirePayment(!route.source_id || route.source_id===checked.sourceId && route.app_id===checked.appId && route.channel_id===checked.channelId,
        'recharge_source_mismatch','连接与已绑定支付源不一致，原配置保留',409)
      return this.connections.save(client,env,candidate,checked,actor)
    })
    this.failures.delete(env)
    return {...checked,connection}
  }
  async activate(env, body, actor) {
    fields(body, ['sourceId','acknowledge']); environment(env)
    requirePayment(uuid(body.sourceId) && body.acknowledge === true, 'recharge_activation_required', '请核对支付源并确认切换')
    const source = await this.remote(env, { allowUnbound: true })
    requirePayment(source.identity.sourceId === body.sourceId, 'recharge_source_mismatch', '支付源已经变化，请重新核对', 409)
    const channel = (await source.client.channels()).items?.find(item => item.id === source.channelId)
    requirePayment(channel && (channel.provider === 'alipay' || env === 'test' && channel.provider === 'mock'), 'recharge_channel_unsupported', '当前接入支持支付宝收银台或 mock 测试', 409)
    return this.atomic(async client => {
      const route = await this.route(env, client, 'FOR UPDATE')
      await this.connections?.assertRevision(client,env,source.configRevision || 0)
      if (route.source_id) {
        requirePayment(route.source_id === source.identity.sourceId && route.app_id === source.appId && route.channel_id === source.channelId,
          'recharge_source_mismatch', '支付接入已经变化，请重新核对', 409)
        return { active: true, sourceId: route.source_id }
      }
      if (env === 'live') {
        const settings = (await client.query("SELECT document FROM mx_pay.settings WHERE id='manual_alipay' FOR UPDATE")).rows[0]?.document
        requirePayment(!settings?.enabled, 'recharge_legacy_handover_required', '请先停用旧人工收款，再核对存量订单', 409)
        const legacy = await client.query("SELECT 1 FROM mx_pay.orders WHERE environment='live' LIMIT 1")
        requirePayment(!legacy.rowCount, 'recharge_legacy_handover_required', '已有正式充值记录，须完成存量支付交接后再切换；不能跳过历史流水', 409)
      }
      await client.query('UPDATE hub_recharge.routes SET source_id=$2,app_id=$3,channel_id=$4,activated_by=$5,activated_at=now() WHERE environment=$1',
        [env, source.identity.sourceId, source.appId, source.channelId, actor])
      return { active: true, sourceId: source.identity.sourceId }
    })
  }
  async channels(legacy) {
    const result = { ...legacy }
    for (const env of ['test','live']) {
      if (!await this.owns(env)) continue
      result[env] = { provider: 'alipay', backend: 'center', enabled: false }
      try {
        const source = await this.remote(env), channel = (await source.client.channels()).items.find(c => c.id === source.channelId)
        if (channel) result[env] = { ...result[env], provider: channel.provider, enabled: channel.enabled, payeeName: '支付宝收银台显示的收款方' }
      } catch (error) { result[env].error = safeCode(error) }
    }
    return result
  }
  async row(id, tenantId = null, client = this.pool, lock = '') {
    requirePayment(uuid(id), 'invalid_payment_id', '订单编号不正确')
    return (await client.query(`SELECT * FROM hub_recharge.orders WHERE id=$1${tenantId ? ' AND tenant_id=$2' : ''} ${lock}`, tenantId ? [id, tenantId] : [id])).rows[0] || null
  }
  async order(id, tenantId = null) {
    const row = (await this.pool.query(`SELECT document FROM hub_recharge.order_documents WHERE id=$1${tenantId ? ' AND tenant_id=$2' : ''}`, tenantId ? [id, tenantId] : [id])).rows[0]
    return row?.document || null
  }
  async create(tenantId, body, key, actor) {
    fields(body, ['environment','amountMinor']); requestKey(key); environment(body.environment)
    minor(body.amountMinor, 'amountMinor', { min: 100 })
    const hash = fingerprint(body)
    const row = await this.atomic(async client => {
      const prior = (await client.query('SELECT * FROM hub_recharge.orders WHERE tenant_id=$1 AND environment=$2 AND request_key=$3', [tenantId, body.environment, key])).rows[0]
      if (prior) { requirePayment(prior.fingerprint === hash, 'payment_idempotency_conflict', '原请求不能更改金额或环境', 409); return prior }
      const route = await this.route(body.environment, client, 'FOR SHARE')
      requirePayment(route?.source_id, 'recharge_inactive', '尚未启用独立支付', 409)
      const tenant = (await client.query('SELECT status FROM tenants WHERE id=$1 FOR SHARE', [tenantId])).rows[0]
      requirePayment(tenant?.status === 'active', 'payment_tenant_unavailable', '租户不可充值', 409)
      const wallet = (await client.query('SELECT currency,status FROM billing.credit_accounts WHERE tenant_id=$1', [tenantId])).rows[0]
      requirePayment(!wallet || wallet.currency === 'CNY' && wallet.status === 'active', 'payment_wallet_unavailable', '钱包当前不可充值', 409)
      const id = randomUUID(), intent = { id, tenantId, environment: body.environment, amountMinor: body.amountMinor, currency: 'CNY',
        createdBy: actor, createdAt: new Date().toISOString(), channelId: route.channel_id, productType: 'wallet_topup', subject: 'Hub 租户钱包充值' }
      const inserted = await client.query(`INSERT INTO hub_recharge.orders(id,tenant_id,environment,source_id,app_id,request_key,fingerprint,intent)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id,environment,request_key) DO NOTHING RETURNING *`,
        [id, tenantId, body.environment, route.source_id, route.app_id, key, hash, intent])
      const result = inserted.rows[0] || (await client.query('SELECT * FROM hub_recharge.orders WHERE tenant_id=$1 AND environment=$2 AND request_key=$3', [tenantId,body.environment,key])).rows[0]
      requirePayment(result.fingerprint === hash, 'payment_idempotency_conflict', '原请求不能更改金额或环境', 409)
      return result
    })
    // A durable intent is always returned even if remote creation is uncertain.
    // Reconciliation reuses this exact identity and never constructs another order.
    try { await this.network(() => this.prepare(row)) } catch (error) { return { ...await this.order(row.id, tenantId), recoveryCode: safeCode(error) } }
    return this.order(row.id, tenantId)
  }
  input(row) {
    return { businessOrderId: `hub-recharge:${row.id}`, customerRef: row.tenant_id, amountMinor: row.intent.amountMinor,
      initiatorRef: row.intent.createdBy, ...(row.intent.channelId === 'mock' ? {} : { channelId: row.intent.channelId, subject: row.intent.subject }) }
  }
  validatePayment(row, payment) {
    const expected = this.input(row)
    verifyPaymentOrder(payment, { ...expected, paymentId: row.payment_id, appId: row.app_id,
      environment: row.environment, currency: 'CNY', channelId: row.intent.channelId },
    { code: 'recharge_payment_mismatch' })
  }
  async attach(row, payment) {
    this.validatePayment(row, payment)
    await this.atomic(async client => {
      const current = await this.row(row.id, row.tenant_id, client, 'FOR UPDATE')
      this.validatePayment(current, payment)
      if (current.ledger_id) return
      if (current.payment && current.payment.revision > payment.revision) return
      requirePayment(!current.payment || current.payment.revision !== payment.revision || fingerprint(current.payment) === fingerprint(payment),
        'recharge_payment_mismatch', '同一支付版本内容不同，请核对支付源', 409)
      await client.query('UPDATE hub_recharge.orders SET payment_id=$2,payment=$3 WHERE id=$1', [row.id,payment.id,payment])
    })
  }
  async prepare(row) {
    const source = await this.remote(row.environment)
    const payment = row.payment_id ? await source.client.order(row.payment_id) : await source.client.create(this.input(row), `hub-recharge:${row.id}`)
    await this.attach(row, payment)
    return { source, payment }
  }
  async action(row, action, body, key, { actor, finance }) {
    if (['invoice-request','invoice-resolve'].includes(action)) {
      requestKey(key); const hash = fingerprint({ action, body })
      await this.atomic(async client => {
        await this.row(row.id, row.tenant_id, client, 'FOR UPDATE')
        const prior = (await client.query('SELECT fingerprint FROM hub_recharge.audit WHERE order_id=$1 AND request_key=$2', [row.id,key])).rows[0]
        if (prior) { requirePayment(prior.fingerprint === hash, 'payment_idempotency_conflict', '请求已用于不同操作', 409); return }
        const order = (await client.query('SELECT document FROM hub_recharge.order_documents WHERE id=$1', [row.id])).rows[0].document
        const next = transitionOrder(order, action, body, { actor, finance })
        await client.query('UPDATE hub_recharge.orders SET invoice=$2,revision=$3 WHERE id=$1', [row.id,next.invoice,next.revision])
        await client.query('INSERT INTO hub_recharge.audit(order_id,request_key,fingerprint,document) VALUES($1,$2,$3,$4)', [row.id,key,hash,{action,actor,at:next.updatedAt,invoice:next.invoice}])
      })
    } else {
      requirePayment(['retry','checkout','refresh'].includes(action), 'payment_channel_action', '付款由支付中心核实；不能在 Hub 手工确认或取消', 409)
      fields(body, ['expectedRevision'])
      return this.network(async () => {
        const { source, payment } = await this.prepare(row)
        if (action === 'checkout') {
          requirePayment(payment.provider === 'alipay', 'payment_channel_action', '模拟订单无需打开支付宝', 409)
          const checkout = await source.client.checkout(payment.id)
          return { ...await this.order(row.id, row.tenant_id), paymentUrl: checkout.payUrl }
        }
        if (action === 'refresh' && payment.provider === 'alipay') {
          const result = await source.client.refresh(payment.id)
          await this.attach(row, result.order)
          const status = result.query?.status === 'not_found' ? 'not_found' : result.observation?.outcome
          return { ...await this.order(row.id, row.tenant_id), paymentQuery: { status: ['not_found','pending','paid','duplicate','review'].includes(status) ? status : 'unknown' } }
        }
        return this.order(row.id, row.tenant_id)
      })
    }
    return this.order(row.id, row.tenant_id)
  }
  async commit(source, event, payment) {
    requirePayment(event?.type === 'payment.paid' && event.version === 1 && uuid(event.id) && uuid(event.paymentId)
      && event.appId === source.appId && event.environment === source.environment && /^hub-recharge:[0-9a-f-]{36}$/.test(event.businessOrderId || ''),
    'recharge_event_mismatch', '付款事件归属不正确', 409)
    const id = event.businessOrderId.slice('hub-recharge:'.length), hash = fingerprint(event)
    return this.atomic(async client => {
      const row = await this.row(id, null, client, 'FOR UPDATE')
      requirePayment(row && row.source_id === source.identity.sourceId && row.app_id === source.appId && row.environment === source.environment,
        'recharge_event_unmatched', '付款事件没有对应充值意图', 409)
      this.validatePayment(row, payment)
      requirePayment(payment.id === event.paymentId && payment.status === 'paid' && payment.settlement?.amountMinor === row.intent.amountMinor
        && event.customerRef === row.tenant_id && event.amountMinor === row.intent.amountMinor && event.currency === 'CNY',
      'recharge_event_mismatch', '付款事件金额或收款事实不一致', 409)
      const prior = (await client.query('SELECT * FROM hub_recharge.inbox WHERE source_id=$1 AND event_id=$2', [source.identity.sourceId,event.id])).rows[0]
      if (prior) { requirePayment(prior.fingerprint === hash && prior.order_id === id, 'recharge_event_conflict', '付款事件内容冲突', 409); return prior.receipt }
      requirePayment(!row.ledger_id, 'recharge_event_conflict', '充值已由另一付款事件交付，请核对', 409)
      const tenant = (await client.query('SELECT status FROM tenants WHERE id=$1 FOR SHARE', [row.tenant_id])).rows[0]
      // Match the existing wallet writer's lock order to avoid a credit/debit deadlock.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`billing:tenant:${row.tenant_id}`])
      const wallet = (await client.query('SELECT currency,status FROM billing.credit_accounts WHERE tenant_id=$1 FOR UPDATE', [row.tenant_id])).rows[0]
      requirePayment(tenant?.status === 'active' && (!wallet || wallet.status === 'active' && wallet.currency === 'CNY'), 'recharge_beneficiary_unavailable', '收款已确认，但受益钱包暂不可入账', 409)
      let ledgerId
      if (row.environment === 'test') {
        ledgerId = randomUUID()
        await client.query('INSERT INTO hub_recharge.test_credits(id,order_id,tenant_id,amount_minor) VALUES($1,$2,$3,$4)', [ledgerId,id,row.tenant_id,row.intent.amountMinor])
      } else {
        const ledger = await this.hub.addTenantCredit({ tenantId: row.tenant_id, amountMinor: row.intent.amountMinor, currency: 'CNY',
          reason: 'mx-pay 独立支付充值到账', externalReference: `mx-pay:${payment.id}`, idempotencyKey: `mx-pay:${payment.id}`,
          actor: `payment-event:${event.id}`, transactionClient: client })
        ledgerId = ledger.id
      }
      const receipt = `hub-recharge:${id}:${ledgerId}`
      await client.query('UPDATE hub_recharge.orders SET payment_id=$2,payment=$3,ledger_id=$4,credited_at=now(),revision=revision+1 WHERE id=$1', [id,payment.id,payment,ledgerId])
      await client.query('INSERT INTO hub_recharge.inbox(source_id,event_id,order_id,payment_id,fingerprint,document,receipt) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [source.identity.sourceId,event.id,id,payment.id,hash,event,receipt])
      await client.query('INSERT INTO hub_recharge.audit(order_id,request_key,fingerprint,document) VALUES($1,$2,$3,$4)', [id,`event:${event.id}`,hash,{action:'credited',eventId:event.id,ledgerId,at:new Date().toISOString()}])
      return receipt
    })
  }
  async sweep(env) {
    if (!await this.owns(env)) return
    const source = await this.remote(env), page = await source.client.events(this.cursors.get(env))
    requirePayment(Array.isArray(page?.items) && page.items.length <= 100, 'recharge_event_mismatch', '付款事件列表不正确', 502)
    for (const event of page.items.slice(0,10)) {
      if (this.stopped) return
      requirePayment(uuid(event?.id) && uuid(event?.paymentId), 'recharge_event_mismatch', '付款事件编号不正确', 502)
      try {
        const payment = await source.client.order(event.paymentId)
        const receipt = event.businessOrderId?.startsWith('hub-purchase:') && this.commerce
          ? await this.commerce.commit(source, event, payment) : await this.commit(source, event, payment)
        await source.client.acknowledge(event.id, receipt)
        await this.pool.query('DELETE FROM hub_recharge.delivery_errors WHERE environment=$1 AND event_id=$2', [env,event.id])
      } catch (error) {
        if (uuid(event?.id)) await this.pool.query(`INSERT INTO hub_recharge.delivery_errors(environment,event_id,code) VALUES($1,$2,$3)
          ON CONFLICT(environment,event_id) DO UPDATE SET code=excluded.code,attempts=hub_recharge.delivery_errors.attempts+1,updated_at=now()`, [env,event.id,safeCode(error)])
      }
      this.cursors.set(env,event.id)
    }
    // Cursor is only a sweep position. Failed/unacknowledged events are revisited.
    if (page.items.length <= 10 && !page.nextAfter) this.cursors.delete(env)
  }
  start() {
    if (this.running || this.timer || !this.connections && !this.sources.size) return
    const tick = async () => {
      for (const env of this.connections ? ['test','live'] : this.sources.keys()) {
        if (this.stopped) return
        if ((this.failures.get(env)?.until || 0) > Date.now()) continue
        try { await this.sweep(env); this.failures.delete(env) }
        catch (error) {
          const count = (this.failures.get(env)?.count || 0)+1
          this.failures.set(env,{count,until:Date.now()+Math.min(60000,2000*2**Math.min(count,5)),code:safeCode(error)})
          this.logger.error?.(`Payment delivery paused: ${safeCode(error)}`)
        }
      }
    }
    const run = () => { this.timer = null; this.running = tick().finally(() => { this.running = null; if (!this.stopped) { this.timer = setTimeout(run,2000); this.timer.unref() } }) }
    run()
  }
  async close() { this.stopped = true; clearTimeout(this.timer); await this.running }
}
export function createRechargeService(hubStore, raw, options = {}) {
  if (!hubStore.pool) return null
  let sources = []
  try { sources = parseRechargeSources(raw) } catch { options.logger?.error?.('Payment delivery configuration invalid; existing login/data remain available') }
  return new RechargeService(hubStore, sources, options)
}
