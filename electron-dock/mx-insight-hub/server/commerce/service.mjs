import { randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { fingerprint, requestKey, fields, requirePayment } from '@qpjoy/mx-pay'
import { verifyPaymentOrder } from '@qpjoy/mx-pay/integration'
import { withPgTransaction } from '../stores/postgres-store.mjs'
import { authorizationScopeLockKey } from '../stores/usage-authorization.mjs'

export const IP_V2_CAPABILITY = 'ip.risk.query.v2'
export const IP_V2_METER = 'ip.risk.subscription.v2'
export const INITIAL_PRODUCT = Object.freeze({ sku: 'ip-risk-baidu-annual-100k', name: 'IP 风险画像 · 年度版', description: 'IP 归属地、运营商、应用场景和分类风险标签；百度 v2 渠道。', product: 'ip_risk', channel: 'baidu-v2', status: 'published', amountMinor: 3399900, currency: 'CNY', months: 12, quota: 100000 })
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const product = row => ({ ...row.document, revision: row.revision })
const view = row => row && ({ id: row.id, tenantId: row.tenant_id, consumerId: row.consumer_id, environment: row.environment, product: row.intent.product,
  createdAt: row.created_at, deliveredAt: row.delivered_at, paymentId: row.payment_id, status: row.delivered_at ? (row.environment === 'test' ? 'test_delivered' : 'active') : row.payment?.status === 'paid' ? 'delivering' : 'pending',
  paymentStatus: row.payment?.status || 'pending', receipt: row.receipt })

export function addCalendarMonths(value, months) {
  const date = new Date(value), day = date.getUTCDate()
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + months)
  const end = new Date(date); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0)
  date.setUTCDate(Math.min(day, end.getUTCDate()))
  return date
}

export class CommerceService {
  constructor(store = {}, recharge) { this.store = store; this.pool = store.pool; this.recharge = recharge }
  atomic(work) { requirePayment(this.pool, 'commerce_storage_required', '购买需要持久化数据库', 503); return withPgTransaction(this.pool, work, { outcomeUnknownCode: 'commerce_outcome_unknown' }) }
  async catalog(admin = false) {
    if (!this.pool) return { items: [{ ...INITIAL_PRODUCT, revision: 1 }], purchaseAvailable: false }
    const rows = (await this.pool.query("SELECT * FROM hub_commerce.products WHERE ($1 OR document->>'status'='published') ORDER BY sku", [admin])).rows
    const channel = (await this.pool.query('SELECT enabled,cooldown_until FROM hub_commerce.ip_channel WHERE id=$1', ['baidu-v2'])).rows[0]
    return { items: rows.map(product), purchaseAvailable: !!this.recharge && channel?.enabled === true, channelStatus: channel?.enabled ? 'enabled' : 'paused' }
  }
  async save(sku, body, actor) {
    fields(body, ['revision','name','description','status','amountMinor','months','quota'])
    requirePayment(/^[a-z][a-z0-9-]{2,79}$/.test(sku) && typeof body.name === 'string' && body.name.trim().length > 0 && body.name.length <= 100
      && typeof body.description === 'string' && body.description.length <= 2000 && ['draft','published','retired'].includes(body.status)
      && Number.isSafeInteger(body.amountMinor) && body.amountMinor >= 100 && body.amountMinor <= 100000000
      && Number.isInteger(body.months) && body.months >= 1 && body.months <= 36 && Number.isInteger(body.quota) && body.quota >= 1 && body.quota <= 10000000
      && Number.isInteger(body.revision) && body.revision >= 0, 'commerce_invalid_product', '商品名称、价格、期限、额度或修订不正确')
    return this.atomic(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`commerce-product:${sku}`])
      const old = (await client.query('SELECT * FROM hub_commerce.products WHERE sku=$1 FOR UPDATE', [sku])).rows[0]
      requirePayment((old?.revision || 0) === body.revision, 'commerce_revision_conflict', '商品已变化，请重新加载', 409)
      const { revision, ...values } = body
      const document = { ...INITIAL_PRODUCT, ...values, sku }
      const row = (await client.query(`INSERT INTO hub_commerce.products(sku,revision,document) VALUES($1,1,$2)
        ON CONFLICT(sku) DO UPDATE SET revision=hub_commerce.products.revision+1,document=excluded.document,updated_at=now() RETURNING *`, [sku,document])).rows[0]
      await client.query('INSERT INTO hub_commerce.audit(actor,action,document) VALUES($1,$2,$3)', [actor,'product.saved',{sku,revision:row.revision,before:old?.document || null,after:document}])
      return product(row)
    })
  }
  async row(id, tenantId, client = this.pool, lock = '') {
    requirePayment(uuid(id) && (!tenantId || uuid(tenantId)), 'commerce_invalid_id', '订单编号不正确')
    return (await client.query(`SELECT * FROM hub_commerce.orders WHERE id=$1 AND ($2::uuid IS NULL OR tenant_id=$2) ${lock}`, [id,tenantId])).rows[0]
  }
  async list(tenantId) {
    if (!this.pool) return { orders: [], subscriptions: [] }
    const [orders, subscriptions] = await Promise.all([
      this.pool.query('SELECT * FROM hub_commerce.orders WHERE tenant_id=$1 ORDER BY created_at DESC,id LIMIT 100', [tenantId]),
      this.pool.query(`SELECT id,order_id AS "orderId",consumer_id AS "consumerId",channel,starts_at AS "startsAt",ends_at AS "endsAt",quota,held,used
        FROM hub_commerce.subscriptions WHERE tenant_id=$1 ORDER BY starts_at DESC,id LIMIT 100`, [tenantId]),
    ])
    return { orders: orders.rows.map(view), subscriptions: subscriptions.rows, limit: 100 }
  }
  async subscription(context) {
    const [platforms,capabilities]=await Promise.all([this.store.listEffectiveGrants(context.consumer.id,context.apiKey.id),this.store.listEffectiveCapabilityGrants(context.consumer.id,context.apiKey.id)])
    if (!platforms.includes('ip_risk') || !capabilities.includes(IP_V2_CAPABILITY)) throw new AppError(403,'capability_not_granted','IP v2 未授权')
    if(!this.pool)return {subscription:null}
    const row=(await this.pool.query(`SELECT starts_at AS "startsAt",ends_at AS "endsAt",quota,used,held FROM hub_commerce.subscriptions
      WHERE tenant_id=$1 AND consumer_id=$2 AND channel='baidu-v2' AND starts_at<=now() AND ends_at>now() ORDER BY starts_at LIMIT 1`,[context.tenant.id,context.consumer.id])).rows[0]
    return {subscription:row||null}
  }
  async create(tenantId, body, key, actor) {
    fields(body, ['sku','revision','consumerId','environment']); requestKey(key)
    requirePayment(uuid(tenantId) && uuid(body.consumerId) && ['live','test'].includes(body.environment) && Number.isInteger(body.revision), 'commerce_invalid_purchase', '请选择受益账户、调用者和商品版本')
    requirePayment(this.recharge, 'commerce_payment_unavailable', '支付接入尚未就绪', 503)
    const hash = fingerprint(body)
    const row = await this.atomic(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`commerce-order:${tenantId}:${key}`])
      const prior = (await client.query('SELECT * FROM hub_commerce.orders WHERE tenant_id=$1 AND environment=$2 AND request_key=$3', [tenantId,body.environment,key])).rows[0]
      if (prior) { requirePayment(prior.fingerprint === hash, 'commerce_idempotency_conflict', '请求已用于其他购买', 409); return prior }
      const sku = (await client.query('SELECT * FROM hub_commerce.products WHERE sku=$1 FOR SHARE', [body.sku])).rows[0]
      requirePayment(sku?.document.status === 'published' && sku.revision === body.revision, 'commerce_product_changed', '商品已变更或下架，请重新确认', 409)
      const channel = (await client.query("SELECT enabled FROM hub_commerce.ip_channel WHERE id='baidu-v2' FOR SHARE")).rows[0]
      requirePayment(channel?.enabled, 'commerce_channel_unavailable', '产品渠道暂停，暂不接受新购买', 409)
      const beneficiary = (await client.query(`SELECT c.id FROM consumers c JOIN tenants t ON t.id=c.tenant_id
        WHERE c.id=$1 AND c.tenant_id=$2 AND c.status='active' AND t.status='active' FOR SHARE OF c,t`, [body.consumerId,tenantId])).rows[0]
      requirePayment(beneficiary, 'commerce_beneficiary_unavailable', '受益调用者不属于当前账户或已停用', 409)
      const route = await this.recharge.route(body.environment,client,'FOR SHARE')
      requirePayment(route?.source_id, 'commerce_payment_unavailable', '该环境尚未启用支付中心', 409)
      const intent = { product: product(sku), createdBy:actor, channelId:route.channel_id }
      return (await client.query(`INSERT INTO hub_commerce.orders(id,tenant_id,consumer_id,environment,request_key,fingerprint,source_id,app_id,intent)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [randomUUID(),tenantId,body.consumerId,body.environment,key,hash,route.source_id,route.app_id,intent])).rows[0]
    })
    try { await this.recharge.network(() => this.prepare(row)) } catch { return { ...view(row), recoveryRequired: true } }
    return view(await this.row(row.id,tenantId))
  }
  input(row) { return { businessOrderId:`hub-purchase:${row.id}`,customerRef:row.tenant_id,amountMinor:row.intent.product.amountMinor,
    initiatorRef:row.intent.createdBy,...(row.intent.channelId === 'mock' ? {} : { channelId:row.intent.channelId,subject:row.intent.product.name }) } }
  validate(row, payment) {
    verifyPaymentOrder(payment, { ...this.input(row),paymentId:row.payment_id,appId:row.app_id,environment:row.environment,currency:'CNY',channelId:row.intent.channelId }, {code:'commerce_payment_mismatch'})
  }
  async attach(row, payment) {
    this.validate(row,payment)
    await this.atomic(async client => {
      const current = await this.row(row.id,row.tenant_id,client,'FOR UPDATE'); this.validate(current,payment)
      if (current.delivered_at || current.payment?.revision > payment.revision) return
      requirePayment(!current.payment || current.payment.revision !== payment.revision || fingerprint(current.payment) === fingerprint(payment), 'commerce_payment_mismatch', '支付版本冲突',409)
      await client.query('UPDATE hub_commerce.orders SET payment_id=$2,payment=$3 WHERE id=$1', [row.id,payment.id,payment])
    })
  }
  async prepare(row) {
    const source = await this.recharge.remote(row.environment)
    requirePayment(source.identity.sourceId === row.source_id && source.appId === row.app_id, 'commerce_source_mismatch', '支付源不一致',409)
    const payment = row.payment_id ? await source.client.order(row.payment_id) : await source.client.create(this.input(row),`hub-purchase:${row.id}`)
    await this.attach(row,payment); return {source,payment}
  }
  async action(tenantId,id,action) {
    const row = await this.row(id,tenantId)
    requirePayment(row,'commerce_not_found','购买订单不存在',404)
    requirePayment(['checkout','refresh','retry'].includes(action),'commerce_invalid_action','不支持该订单操作')
    return this.recharge.network(async () => {
      const {source,payment} = await this.prepare(row)
      if (action === 'checkout') {
        const checkout = await source.client.checkout(payment.id)
        return {...view(await this.row(id,tenantId)),paymentUrl:checkout.payUrl}
      }
      if (action === 'refresh' && payment.provider === 'alipay') {
        const result = await source.client.refresh(payment.id); await this.attach(row,result.order)
      }
      return view(await this.row(id,tenantId))
    })
  }
  async commit(source,event,payment) {
    requirePayment(event?.type === 'payment.paid' && event.version === 1 && uuid(event.id) && uuid(event.paymentId)
      && event.appId === source.appId && event.environment === source.environment && /^hub-purchase:[0-9a-f-]{36}$/.test(event.businessOrderId || ''), 'commerce_event_mismatch','购买付款事件不匹配',409)
    const id = event.businessOrderId.slice(13), hash = fingerprint(event)
    return this.atomic(async client => {
      const row = await this.row(id,null,client,'FOR UPDATE')
      requirePayment(row && row.source_id === source.identity.sourceId && row.app_id === source.appId && row.environment === source.environment,'commerce_source_mismatch','没有匹配的购买意图',409)
      this.validate(row,payment)
      requirePayment(payment.id === event.paymentId && payment.status === 'paid' && payment.settlement?.amountMinor === row.intent.product.amountMinor
        && event.customerRef === row.tenant_id && event.amountMinor === row.intent.product.amountMinor && event.currency === 'CNY','commerce_event_mismatch','购买金额或付款事实不一致',409)
      const previous = (await client.query('SELECT * FROM hub_commerce.inbox WHERE source_id=$1 AND event_id=$2',[row.source_id,event.id])).rows[0]
      if (previous) { requirePayment(previous.fingerprint === hash && previous.order_id === id,'commerce_event_conflict','付款事件冲突',409); return previous.receipt }
      requirePayment(!row.delivered_at,'commerce_event_conflict','该订单已由其他事件交付',409)
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`tenant-access:${row.tenant_id}`])
      for (const scope of [{type:'platform',key:'ip_risk'},{type:'capability',key:IP_V2_CAPABILITY}]) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[authorizationScopeLockKey(row.consumer_id,scope)])
      }
      const beneficiary = (await client.query(`SELECT c.id FROM consumers c JOIN tenants t ON c.tenant_id=t.id WHERE c.id=$1 AND t.id=$2 AND c.status='active' AND t.status='active' FOR SHARE OF c,t`,[row.consumer_id,row.tenant_id])).rows[0]
      requirePayment(beneficiary,'commerce_beneficiary_unavailable','付款已确认，受益账户需要处理',409)
      let subscriptionId = null
      if (row.environment === 'live') {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`commerce-subscription:${row.consumer_id}:baidu-v2`])
        const latest = (await client.query("SELECT ends_at FROM hub_commerce.subscriptions WHERE consumer_id=$1 AND channel='baidu-v2' ORDER BY ends_at DESC LIMIT 1",[row.consumer_id])).rows[0]
        const start = new Date(Math.max(Date.now(),latest ? new Date(latest.ends_at).getTime() : 0)), end = addCalendarMonths(start,row.intent.product.months)
        subscriptionId = randomUUID()
        await client.query(`INSERT INTO hub_commerce.subscriptions(id,order_id,tenant_id,consumer_id,channel,starts_at,ends_at,quota) VALUES($1,$2,$3,$4,'baidu-v2',$5,$6,$7)`,[subscriptionId,id,row.tenant_id,row.consumer_id,start,end,row.intent.product.quota])
        // Add only this purchased capability. Preserve secrets, limits and unrelated scopes.
        await client.query("INSERT INTO platform_grants(consumer_id,platform) VALUES($1,'ip_risk') ON CONFLICT DO NOTHING",[row.consumer_id])
        await client.query('INSERT INTO capability_grants(consumer_id,capability) VALUES($1,$2) ON CONFLICT DO NOTHING',[row.consumer_id,IP_V2_CAPABILITY])
        await client.query(`INSERT INTO api_key_platform_entitlements(api_key_id,platform,max_requests,window_seconds,max_page_size)
          SELECT id,'ip_risk',1000,3600,100 FROM api_keys WHERE consumer_id=$1 AND status='active' AND environment='live' ON CONFLICT DO NOTHING`,[row.consumer_id])
        await client.query(`INSERT INTO api_key_capability_entitlements(api_key_id,capability,max_requests,window_seconds)
          SELECT id,$2,1000,3600 FROM api_keys WHERE consumer_id=$1 AND status='active' AND environment='live' ON CONFLICT DO NOTHING`,[row.consumer_id,IP_V2_CAPABILITY])
      }
      const receipt = `hub-purchase:${id}:${subscriptionId || 'test'}`
      await client.query('UPDATE hub_commerce.orders SET payment_id=$2,payment=$3,delivered_at=now(),receipt=$4 WHERE id=$1',[id,payment.id,payment,receipt])
      await client.query('INSERT INTO hub_commerce.inbox(source_id,event_id,order_id,fingerprint,document,receipt) VALUES($1,$2,$3,$4,$5,$6)',[row.source_id,event.id,id,hash,event,receipt])
      await client.query('INSERT INTO hub_commerce.audit(actor,action,document) VALUES($1,$2,$3)',[`payment-event:${event.id}`,'purchase.delivered',{orderId:id,tenantId:row.tenant_id,consumerId:row.consumer_id,subscriptionId,environment:row.environment,receipt}])
      return receipt
    })
  }
}
