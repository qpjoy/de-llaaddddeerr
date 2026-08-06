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

// One header carries either credential. The server compares it against the
// admin token first and only offers a non-matching value to Launcher, so the
// console does not need to know which kind of session it holds.
async function request(token, path, { method = 'GET', body, query, raw, contentType } = {}) {
  const response = await fetch(`${API_BASE}${path}${queryString(query)}`, {
    method,
    headers: {
      accept: 'application/json',
      'x-mx-insight-admin-token': token,
      ...(raw ? { 'content-type': contentType || 'application/octet-stream' } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: raw || (body ? JSON.stringify(body) : undefined),
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

/**
 * Exchange Launcher credentials for a token, from the BROWSER.
 *
 * Deliberately does not go through the Hub. Launcher is the only authentication
 * authority (ADR-0004); routing the form through the Hub server would put it in
 * the credential path for a password it must never see or store. The browser
 * posts to Launcher, gets an opaque `mx-v1-...` token back, and that token is
 * what the Hub then introspects.
 */
export async function signInWithLauncher({ url, audience, username, password }) {
  const response = await fetch(`${url.replace(/\/$/, '')}/internal/v1/sdk/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ grant_type: 'password', username, password, audience }),
  })
  const payload = await parsePayload(response)
  if (!response.ok) {
    throw new ApiError({
      status: response.status,
      code: 'launcher_sign_in_failed',
      message: response.status === 401
        ? '账号或密码不正确'
        : payload?.message || `Launcher 返回 HTTP ${response.status}`,
    })
  }
  // Launcher wraps the issued token differently across its endpoints; accept
  // the shapes it actually returns rather than assuming one.
  const token = payload?.access_token
    ?? payload?.token
    ?? payload?.issued?.token
    ?? payload?.data?.access_token
  if (!token) {
    throw new ApiError({ code: 'launcher_sign_in_failed', message: 'Launcher 未返回 token' })
  }
  return token
}

export const adminApi = {
  // Unauthenticated: the console needs to know how to sign in before it can.
  signInOptions: () => fetch(`${API_BASE}${ADMIN_ROOT}/sign-in-options`)
    .then(parsePayload)
    .then((payload) => payload?.data ?? { adminToken: true, launcher: null })
    .catch(() => ({ adminToken: true, launcher: null })),
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

  // Identity. `session` is fetched first on load: the console renders itself
  // from the returned capabilities so a scoped user never sees a control they
  // are not allowed to use.
  session: (token) => request(token, `${ADMIN_ROOT}/session`),
  members: (token) => request(token, `${ADMIN_ROOT}/members`),
  grantMembership: (token, body) => request(token, `${ADMIN_ROOT}/members/memberships`, { method: 'POST', body }),
  revokeMembership: (token, body) => request(token, `${ADMIN_ROOT}/members/memberships/revoke`, { method: 'POST', body }),

  // External sources (P4).
  sources: (token) => request(token, `${ADMIN_ROOT}/sources`),
  createSource: (token, body) => request(token, `${ADMIN_ROOT}/sources`, { method: 'POST', body }),
  sourceMappings: (token, key) => request(token, `${ADMIN_ROOT}/sources/${encodeURIComponent(key)}/mappings`),
  createMapping: (token, key, body) => request(
    token, `${ADMIN_ROOT}/sources/${encodeURIComponent(key)}/mappings`, { method: 'POST', body },
  ),
  approveMapping: (token, key, version) => request(
    token, `${ADMIN_ROOT}/sources/${encodeURIComponent(key)}/mappings/${version}/approve`, { method: 'POST' },
  ),
  previewImport: (token, key, file) => request(
    token, `${ADMIN_ROOT}/sources/${encodeURIComponent(key)}/preview`,
    { method: 'POST', raw: file, query: { filename: file.name } },
  ),
  runImport: (token, key, file) => request(
    token, `${ADMIN_ROOT}/sources/${encodeURIComponent(key)}/import`,
    { method: 'POST', raw: file, query: { filename: file.name } },
  ),
  importRuns: (token, key) => request(token, `${ADMIN_ROOT}/sources/${encodeURIComponent(key)}/imports`),

  // Backfill (P3), agent (P5) and retrieval (embedding pipeline).
  backfill: (token) => request(token, `${ADMIN_ROOT}/backfill`),
  startBackfill: (token, body) => request(token, `${ADMIN_ROOT}/backfill`, { method: 'POST', body }),
  agent: (token) => request(token, `${ADMIN_ROOT}/agent`),
  retrieval: (token) => request(token, `${ADMIN_ROOT}/retrieval`),
  semanticSearch: (token, body) => request(token, `${ADMIN_ROOT}/retrieval/search`, { method: 'POST', body }),
  runtime: (token) => Promise.all([
    health(token, '/health/live'),
    health(token, '/health/ready'),
    health(token, '/health/dependencies'),
  ]).then(([live, ready, dependencies]) => ({ live, ready, dependencies })),
}
