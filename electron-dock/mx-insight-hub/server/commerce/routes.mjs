import { PaymentError, requirePayment } from '@qpjoy/mx-pay'
import { AppError } from '../core/errors.mjs'
import { requireTenantCapability } from '../identity/index.mjs'

export async function commerceRoute({ commerce, request, response, pathname, searchParams, principal, readJson, sendJson, requestId }) {
  const root = '/internal/v1/admin/commerce'
  if (!pathname.startsWith(`${root}/`)) return false
  const reply = (data,status=200) => { sendJson(response,status,{data,requestId},{'cache-control':'private, no-store'}); return true }
  try {
    if (searchParams.size) throw new AppError(400,'commerce_invalid_query','商城接口不接受额外查询参数')
    const actor = principal.memberId || principal.kind
    if (pathname === `${root}/products` && request.method === 'GET') return reply(await commerce.catalog(principal.kind === 'admin-token'))
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
        if (action) { await readJson(request,1024); return reply(await commerce.action(tenantId,id,action)) }
        requireTenantCapability(principal,tenantId,'apikey.write')
        return reply(await commerce.create(tenantId,await readJson(request,4096),request.headers['idempotency-key'],actor),201)
      }
    }
    throw new AppError(404,'not_found','商城接口不存在')
  } catch (error) {
    if (error instanceof PaymentError) throw new AppError(error.status,error.code,error.message)
    throw error
  }
}
