import { PaymentError, environment, requirePayment } from '@qpjoy/mx-pay'
import { AppError } from '../core/errors.mjs'
import { requirePlatformAdmin, requireTenantCapability } from '../identity/index.mjs'
import { openPersonalAccount } from '../identity/personal-account.mjs'

const uuid = value => {
  requirePayment(typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value), 'invalid_payment_id', '订单或租户编号不正确')
  return value.toLowerCase()
}
export async function paymentRoute({ payments, recharge, commerce = null, request, response, pathname, searchParams, principal, readJson, sendJson, requestId }) {
  const root = '/internal/v1/admin/payments'
  if (!(pathname === root || pathname.startsWith(`${root}/`))) return false
  try {
    const actor = principal.memberId || principal.kind || 'admin-token'
    const reply = (data, status = 200) => { sendJson(response, status, { data, requestId }, { 'cache-control': 'private, no-store' }); return true }
    const noQuery = () => requirePayment([...searchParams.keys()].length === 0, 'invalid_payment_query', '该操作不接受查询参数')
    if (pathname === `${root}/personal-account` && request.method === 'POST') {
      noQuery()
      const body = await readJson(request, 1024)
      requirePayment(body?.acknowledge === true && Object.keys(body).length === 1, 'invalid_account_request', '请确认开通自己的个人账户')
      return reply(await openPersonalAccount(payments.store.pool, principal))
    }
    if (pathname === `${root}/invoice-tasks` && request.method === 'GET') {
      requirePlatformAdmin(principal); noQuery()
      return reply(await payments.store.invoiceTasks())
    }
    if (pathname === `${root}/return-order` && request.method === 'GET') {
      requirePayment([...searchParams.keys()].length === 1 && searchParams.getAll('trade').length === 1 && /^MXP[0-9a-f]{32}$/i.test(searchParams.get('trade') || ''), 'invalid_payment_query', '支付返回订单编号不正确')
      const tenantIds = principal.platformAdmin ? null : principal.memberships.filter(item => item.capabilities?.includes('billing.read')).map(item => item.tenantId)
      const rows = recharge ? (await recharge.pool.query(`SELECT id,tenant_id FROM hub_recharge.orders WHERE payment #>> '{checkout,outTradeNo}'=$1
        AND ($2::uuid[] IS NULL OR tenant_id=ANY($2)) LIMIT 2`, [searchParams.get('trade'), tenantIds])).rows : []
      if (!rows.length && commerce?.pool) {
        const purchase = (await commerce.pool.query(`SELECT id,tenant_id FROM hub_commerce.orders WHERE payment #>> '{checkout,outTradeNo}'=$1
          AND ($2::uuid[] IS NULL OR tenant_id=ANY($2)) LIMIT 2`, [searchParams.get('trade'),tenantIds])).rows
        if (purchase.length === 1) {
          requireTenantCapability(principal,purchase[0].tenant_id,'billing.read')
          return reply({id:purchase[0].id,tenantId:purchase[0].tenant_id,businessType:'purchase'})
        }
      }
      requirePayment(rows.length === 1, 'payment_not_found', '当前账号无法查看该充值订单，请切换付款时的账号，或从充值记录查找原订单。', 404)
      requireTenantCapability(principal, rows[0].tenant_id, 'billing.read')
      // Locator only. No query, settlement, inbox dispatch or wallet write.
      return reply(await recharge.order(rows[0].id, rows[0].tenant_id))
    }
    if (pathname === `${root}/integration` && request.method === 'GET') {
      requirePlatformAdmin(principal); noQuery()
      return reply(recharge ? await recharge.status() : { items: [], available: false })
    }
    const activation = new RegExp(`^${root}/integration/(test|live)/activate$`).exec(pathname)
    const connection = new RegExp(`^${root}/integration/(test|live)/(connection|check)$`).exec(pathname)
    if (connection && (connection[2]==='connection' && request.method==='PUT' || connection[2]==='check' && request.method==='POST')) {
      requirePlatformAdmin(principal); noQuery()
      requirePayment(recharge,'recharge_unavailable','独立支付接入需要持久化数据库',503)
      return reply(await recharge.configure(connection[1],await readJson(request,8192),actor,{checkOnly:connection[2]==='check'}))
    }
    if (activation && request.method === 'POST') {
      requirePlatformAdmin(principal); noQuery()
      requirePayment(recharge, 'recharge_unavailable', '独立支付接入需要持久化数据库', 503)
      return reply(await recharge.activate(activation[1], await readJson(request,8192), actor))
    }
    if (pathname === `${root}/settings`) {
      requirePlatformAdmin(principal); noQuery()
      if (request.method === 'GET') return reply(await payments.store.settings())
      if (request.method === 'PUT') {
        const body = await readJson(request, 750_000)
        requirePayment(!body?.enabled || !recharge || !await recharge.owns('live'), 'recharge_legacy_writer_disabled', '已启用独立支付，请在支付中心维护渠道', 409)
        return reply(await payments.configure(body, actor))
      }
    }
    if (pathname === `${root}/channels` && request.method === 'GET') {
      requirePayment([...searchParams.keys()].every(key => key === 'tenantId'), 'invalid_payment_query', '不支持该查询参数')
      requireTenantCapability(principal, uuid(searchParams.get('tenantId')), 'billing.read')
      const channels = await payments.channels()
      return reply(recharge ? await recharge.channels(channels) : channels)
    }
    if (pathname === `${root}/orders` && request.method === 'GET') {
      requirePayment([...searchParams.keys()].every(key => ['tenantId','environment','status','invoiceStatus','invoicesOnly','orderId','page','pageSize'].includes(key)) && [...searchParams.keys()].every(key => searchParams.getAll(key).length === 1), 'invalid_payment_query', '不支持或重复的查询参数')
      const tenantId = searchParams.get('tenantId') ? uuid(searchParams.get('tenantId')) : null
      if (tenantId) requireTenantCapability(principal, tenantId, 'billing.read')
      else requirePlatformAdmin(principal)
      const env = environment(searchParams.get('environment'))
      const status = searchParams.get('status') || '', invoiceStatus = searchParams.get('invoiceStatus') || ''
      requirePayment(['','pending','submitted','paid','cancelled'].includes(status) && ['','requested','issued','rejected'].includes(invoiceStatus), 'invalid_payment_query', '订单状态不正确')
      const page = Number(searchParams.get('page') || 1), pageSize = Number(searchParams.get('pageSize') || 20)
      requirePayment(!searchParams.has('invoicesOnly') || searchParams.get('invoicesOnly') === '1', 'invalid_payment_query', '开票筛选参数不正确')
      requirePayment(Number.isInteger(page) && page >= 1 && page <= 10000 && Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= 100, 'invalid_payment_query', '分页参数不正确')
      return reply(await payments.store.list({ tenantId, environment: env, status, invoiceStatus, invoicesOnly: searchParams.get('invoicesOnly') === '1', orderId: searchParams.get('orderId') ? uuid(searchParams.get('orderId')) : '', page, pageSize }))
    }
    const create = new RegExp(`^${root}/tenants/([^/]+)/orders$`, 'u').exec(pathname)
    if (create && request.method === 'POST') {
      noQuery(); const tenantId = uuid(create[1])
      requireTenantCapability(principal, tenantId, 'recharge.create')
      const body = await readJson(request, 8192)
      const service = recharge && await recharge.owns(environment(body?.environment)) ? recharge : payments
      return reply(await service.create(tenantId, body, request.headers['idempotency-key'], actor), 201)
    }
    const match = new RegExp(`^${root}/tenants/([^/]+)/orders/([^/]+)(?:/([^/]+))?$`, 'u').exec(pathname)
    if (match) {
      noQuery(); const tenantId = uuid(match[1]), id = uuid(match[2]), action = match[3]
      requireTenantCapability(principal, tenantId, 'billing.read')
      const external = recharge && await recharge.row(id, tenantId)
      if (request.method === 'GET' && !action) {
        if (external) return reply(await recharge.order(id, tenantId))
        const order = await payments.store.order(id, tenantId)
        return reply({ ...order, events: await payments.store.events(id), eventsLimit: 100 })
      }
      if (request.method === 'POST' && action) {
        if (['confirm','reject','invoice-resolve'].includes(action)) requirePlatformAdmin(principal)
        else requireTenantCapability(principal, tenantId, action === 'invoice-request' ? 'invoice.request' : 'recharge.create')
        if (external) return reply(await recharge.action(external, action, await readJson(request,8192), request.headers['idempotency-key'], {actor,finance:principal.platformAdmin}))
        return reply(await payments.act(tenantId, id, action, await readJson(request, 8192), request.headers['idempotency-key'], { actor, finance: principal.platformAdmin }))
      }
    }
    throw new AppError(404, 'not_found', '支付接口不存在')
  } catch (error) {
    if (error instanceof PaymentError) throw new AppError(error.status, error.code, error.message)
    throw error
  }
}
