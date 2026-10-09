import { AppError } from '../core/errors.mjs'
import { readJson, sendJson } from '../core/http.mjs'

const root = '/internal/v1/admin/peripherals'
async function bodyOf(request) {
  const body = await readJson(request, 16_384)
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'peripheral_input', '请求体必须为 JSON 对象')
  return body
}
export async function peripheralRoute({ service, request, response, pathname, searchParams, principal, requestId }) {
  if (pathname !== root && !pathname.startsWith(`${root}/`)) return false
  if (principal?.kind !== 'admin-token') throw new AppError(403, 'admin_token_required', '外设管理仅限 Hub Admin Token')
  if (!service) {
    if (request.method === 'GET' && pathname === root) {
      sendJson(response, 200, { data: { available: false, persistent: false, devices: [], origins: [], reason: '外设模块未启用：请检查 PostgreSQL 与部署地址配置。内存模式不允许驱动真实设备。' }, requestId })
      return true
    }
    throw new AppError(503, 'peripheral_unavailable', '外设模块未就绪；请检查 PostgreSQL 和部署地址白名单')
  }
  const parts = pathname.slice(root.length).split('/').filter(Boolean)
  let data, status = 200
  try {
    if (!parts.length && request.method === 'GET') data = await service.overview()
    else if (!parts.length && request.method === 'POST') { data = await service.register(await bodyOf(request)); status = 201 }
    else if (parts.length === 1 && request.method === 'GET') data = await service.inspect(parts[0], searchParams.get('before'))
    else if (parts.length === 2 && parts[1] === 'probe' && request.method === 'POST') data = await service.probe(parts[0])
    else if (parts.length === 2 && parts[1] === 'control' && request.method === 'POST') data = await service.control(parts[0], await bodyOf(request))
    else if (parts.length === 2 && parts[1] === 'jobs' && request.method === 'POST') { data = await service.submit(parts[0], await bodyOf(request)); status = 202 }
    else if (parts.length === 3 && parts[1] === 'jobs' && request.method === 'GET') data = await service.job(parts[0], parts[2])
    else throw new AppError(404, 'not_found', '外设接口不存在')
  } catch (error) {
    if (['42P01','3F000','ECONNREFUSED','53300','55P03','57014'].includes(error.code)) throw new AppError(503, 'peripheral_storage_unavailable', '外设存储暂不可用；请检查连接并先执行 migration 139，不影响其他 Hub 功能')
    throw error
  }
  sendJson(response, status, { data, requestId })
  return true
}
