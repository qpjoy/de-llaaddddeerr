import { AppError } from '../core/errors.mjs'
import { capabilitiesForRole, requireTenantCapability } from '../identity/index.mjs'

const roles = ['owner', 'admin', 'billing', 'analyst', 'viewer']
export async function workspaceRoute({ request, response, pathname, searchParams, principal, store, sendJson, requestId }) {
  if (request.method !== 'GET' || !['/internal/v1/admin/me/workspace', '/internal/v1/admin/me/usage'].includes(pathname)) return false
  const usage = pathname.endsWith('/usage')
  const allowed = usage ? ['tenantId', 'days'] : ['tenantId']
  if ([...searchParams.keys()].some(key => !allowed.includes(key) || searchParams.getAll(key).length !== 1)) throw new AppError(400, 'invalid_query', '筛选条件不正确')
  const tenantId = requireTenantCapability(principal, searchParams.get('tenantId'), usage ? 'usage.read' : 'tenant.read')
  const tenant = await store.getTenant(tenantId)
  if (!tenant || tenant.status !== 'active') throw new AppError(403, 'tenant_unavailable', '当前空间不可用')
  const membership = principal.memberships?.find(item => item.tenantId === tenantId)
  let data
  if (usage) {
    const days = searchParams.get('days') || '7'
    if (!['7', '30'].includes(days)) throw new AppError(400, 'invalid_query', '请选择近 7 天或近 30 天')
    const now = new Date(), from = new Date(now)
    from.setUTCHours(0, 0, 0, 0); from.setUTCDate(from.getUTCDate() - Number(days) + 1)
    const filters = { tenantId, from: from.toISOString(), to: now.toISOString() }
    const [summary, daily] = await Promise.all([store.usage(filters), store.usageDaily(filters)])
    data = {
      tenant: { id: tenant.id, name: tenant.name }, ...filters, days: Number(days), timezone: 'UTC',
      requests: summary.requests, committed: summary.committed, released: summary.released, unknown: summary.unknown,
      pending: Math.max(0, summary.requests - summary.committed - summary.released - summary.unknown),
      meters: summary.requestMetering?.byMeter || {}, daily,
    }
  } else {
    data = {
      tenant: { id: tenant.id, name: tenant.name, status: tenant.status },
      memberId: principal.memberId, role: membership?.role || null,
      capabilities: membership?.capabilities || capabilitiesForRole(membership?.role),
      members: await store.listTenantMembers(tenantId),
      roles: roles.map(role => ({ role, capabilities: capabilitiesForRole(role) })),
    }
  }
  sendJson(response, 200, { data, requestId }, { 'cache-control': 'private, no-store' })
  return true
}
