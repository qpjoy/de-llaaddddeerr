const API_BASE = (import.meta.env.VITE_MX_INSIGHT_API_BASE || '').replace(/\/$/, '')
const ADMIN_ROOT = '/internal/v1/admin'

export class ApiError extends Error {
  constructor({ status = 0, code = 'request_failed', message = 'Request failed', requestId, details } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.requestId = requestId
    this.details = details
  }
}

function queryString(query) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  }
  const serialized = params.toString()
  return serialized ? `?${serialized}` : ''
}

async function parsePayload(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

async function request(token, path, { method = 'GET', body, query } = {}) {
  const response = await fetch(`${API_BASE}${path}${queryString(query)}`, {
    method,
    headers: {
      accept: 'application/json',
      'x-mx-insight-admin-token': token,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const payload = await parsePayload(response)
  if (!response.ok) {
    throw new ApiError({
      status: response.status,
      code: payload?.error?.code,
      message: payload?.error?.message || `Request failed with HTTP ${response.status}`,
      requestId: payload?.requestId || response.headers.get('x-request-id'),
      details: payload?.error?.details,
    })
  }
  return payload?.data
}

async function health(token, path) {
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      headers: { accept: 'application/json', 'x-mx-insight-admin-token': token },
    })
    const payload = await parsePayload(response)
    return {
      ok: response.ok,
      status: response.status,
      data: payload?.data,
      error: payload?.error,
      requestId: payload?.requestId || response.headers.get('x-request-id'),
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: { code: 'network_error', message: error instanceof Error ? error.message : 'Network error' },
    }
  }
}

export const adminApi = {
  dashboard: (token) => request(token, `${ADMIN_ROOT}/dashboard`),
  tenants: (token) => request(token, `${ADMIN_ROOT}/tenants`),
  createTenant: (token, body) => request(token, `${ADMIN_ROOT}/tenants`, { method: 'POST', body }),
  consumers: (token, tenantId) => request(token, `${ADMIN_ROOT}/consumers`, { query: { tenantId } }),
  createConsumer: (token, body) => request(token, `${ADMIN_ROOT}/consumers`, { method: 'POST', body }),
  apiKeys: (token, consumerId) => request(token, `${ADMIN_ROOT}/api-keys`, { query: { consumerId } }),
  createApiKey: (token, body) => request(token, `${ADMIN_ROOT}/api-keys`, { method: 'POST', body }),
  revokeApiKey: (token, id) => request(token, `${ADMIN_ROOT}/api-keys/${encodeURIComponent(id)}/revoke`, { method: 'POST' }),
  platforms: (token, query) => request(token, `${ADMIN_ROOT}/platforms`, { query }),
  updatePlatform: (token, platform, body) => request(
    token,
    `${ADMIN_ROOT}/platforms/${encodeURIComponent(platform)}`,
    { method: 'PUT', body },
  ),
  usage: (token, query) => request(token, `${ADMIN_ROOT}/usage`, { query }),
  runtime: (token) => Promise.all([
    health(token, '/health/live'),
    health(token, '/health/ready'),
    health(token, '/health/dependencies'),
  ]).then(([live, ready, dependencies]) => ({ live, ready, dependencies })),
}
