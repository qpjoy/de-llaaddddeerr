import { PaymentError, requirePayment, fields } from '@qpjoy/mx-pay'
import { AppError } from '../core/errors.mjs'
import { requireTenantCapability } from '../identity/index.mjs'

export async function commerceRoute({ commerce, service, productGateway, request, response, pathname, searchParams, principal, readJson, sendJson, requestId }) {
  const root = '/internal/v1/admin/commerce'
  if (!pathname.startsWith(`${root}/`)) return false
  const reply = (data,status=200) => { sendJson(response,status,{data,requestId},{'cache-control':'private, no-store'}); return true }
  try {
    const message = new RegExp(`^${root}/tenants/([0-9a-f-]{36})/messages(?:/([1-9][0-9]{0,17})/read|/(read-all))?$`).exec(pathname)
    if (message) {
      requireTenantCapability(principal,message[1],'billing.read')
      requirePayment(principal.kind==='launcher-user' && principal.memberId,'customer_identity_required','消息需要个人登录身份',403)
      if (request.method==='GET' && !message[2] && !message[3]) {
        if ([...searchParams.keys()].some(key=>searchParams.getAll(key).length!==1)) throw new AppError(400,'invalid_message_filter','消息筛选条件不正确')
        return reply(await commerce.messages.list(message[1],principal.memberId,Object.fromEntries(searchParams)))
      }
      if (request.method==='POST' && (message[2] || message[3]) && !searchParams.size) {
        fields(await readJson(request,1024),[])
        return reply(await (message[3] ? commerce.messages.readAll(message[1],principal.memberId) : commerce.messages.read(message[1],principal.memberId,message[2])))
      }
      throw new AppError(400,'invalid_message_request','消息请求不正确')
    }
    const listing = new RegExp(`^${root}/tenants/([0-9a-f-]{36})$`).exec(pathname)
    if (listing && request.method === 'GET') {
      requireTenantCapability(principal,listing[1],'billing.read')
      const options = {}
      for (const [key,value] of searchParams) {
        if (!['ordersPage','subscriptionsPage','pageSize'].includes(key) || searchParams.getAll(key).length !== 1 || !/^[1-9][0-9]*$/.test(value))
          throw new AppError(400,'commerce_invalid_query','分页参数不正确')
        options[key] = Number(value)
      }
      return reply(await commerce.list(listing[1],options))
    }
    if (searchParams.size) throw new AppError(400,'commerce_invalid_query','商城接口不接受额外查询参数')
    const actor = principal.memberId || principal.kind
    const selection = new RegExp(`^${root}/tenants/([0-9a-f-]{36})/subscription-selection$`).exec(pathname)
    if (selection && request.method==='POST') {
      requireTenantCapability(principal,selection[1],'billing.read')
      requireTenantCapability(principal,selection[1],'apikey.write')
      return reply(await commerce.selectSubscription(selection[1],await readJson(request,1024),actor))
    }
    if (pathname === `${root}/products` && request.method === 'GET') return reply(await commerce.catalog(principal.kind === 'admin-token', {harbor: Boolean(principal.portalOrigin)}))
    if(pathname===`${root}/delivery`) {
      requirePayment(principal.kind==='admin-token','admin_token_required','服务配置需要 Admin Token',403)
      if(request.method==='GET')return reply(productGateway?await productGateway.adminDelivery():await commerce.delivery())
      if(request.method==='PUT')return reply(await commerce.saveDelivery(await readJson(request,2048),actor))
    }
    const access=new RegExp(`^${root}/tenants/([0-9a-f-]{36})/access$`).exec(pathname)
    if(access && request.method==='POST') {
      requireTenantCapability(principal,access[1],'apikey.write')
      const body=await readJson(request,1024);requirePayment(!Object.keys(body).length,'commerce_invalid_request','请刷新后重试')
      return reply(await commerce.prepareAccess(access[1],service))
    }
    const acceptance=new RegExp(`^${root}/tenants/([0-9a-f-]{36})/acceptance-orders$`).exec(pathname)
    if(acceptance && request.method==='POST') {
      requirePayment(principal.kind==='admin-token','admin_token_required','验收价订单需要 Admin Token',403)
      return reply(await commerce.create(acceptance[1],await readJson(request,4096),request.headers['idempotency-key'],actor,{acceptance:true}),201)
    }
    const edit = new RegExp(`^${root}/products/([a-z0-9-]+)$`).exec(pathname)
    if (edit && request.method === 'PUT') {
      requirePayment(principal.kind === 'admin-token','admin_token_required','商品管理需要 Admin Token',403)
      return reply(await commerce.save(edit[1],await readJson(request,8192),actor))
    }
    const match = new RegExp(`^${root}/tenants/([0-9a-f-]{36})(?:/orders(?:/([0-9a-f-]{36})/(checkout|refresh|retry))?)?$`).exec(pathname)
    if (match) {
      const [,tenantId,id,action] = match
      requireTenantCapability(principal,tenantId,'billing.read')
      if (request.method === 'GET' && !id) return reply(await commerce.list(tenantId))
      if (request.method === 'POST') {
        requireTenantCapability(principal,tenantId,'recharge.create')
        if (action) {
          fields(await readJson(request,1024),[])
          // portalOrigin comes only from the verified Portal principal, never Host/body/Referer.
          const checkout = action==='checkout' && principal.portalOrigin
            ? {returnUrl:new URL('/payment/return',principal.portalOrigin).href} : undefined
          return reply(await commerce.action(tenantId,id,action,checkout))
        }
        requireTenantCapability(principal,tenantId,'apikey.write')
        return reply(await commerce.create(tenantId,await readJson(request,4096),request.headers['idempotency-key'],actor,{harbor: Boolean(principal.portalOrigin)}),201)
      }
    }
    throw new AppError(404,'not_found','商城接口不存在')
  } catch (error) {
    if (error instanceof PaymentError) throw new AppError(error.status,error.code,error.message)
    throw error
  }
}
