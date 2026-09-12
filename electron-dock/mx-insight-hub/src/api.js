import {
  dataCenterVisibleProjection,
  sourceCatalogVisibleProjection,
} from '../shared/source-catalog-visibility.mjs'

const API_BASE = (import.meta.env.VITE_MX_INSIGHT_API_BASE || '').replace(/\/$/, '')
const ADMIN_ROOT = '/internal/v1/admin'

function withoutTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

function httpOrigin(value) {
  const candidate = withoutTrailingSlash(value)
  if (!candidate) return ''
  try {
    const url = new URL(candidate)
    if (
      !['http:', 'https:'].includes(url.protocol)
      || url.username
      || url.password
      || url.search
      || url.hash
      || (url.pathname !== '' && url.pathname !== '/')
    ) return ''
    return url.origin
  } catch {
    return ''
  }
}

// Production runs the Admin SPA on :18151 and the bearer-key Public API on
// :18150. The public edge may instead route both surfaces on one origin. Keep
// the default relative for that edge and for the combined/dev listener, while
// making a direct Admin-listener visit work without baking one host into the
// image. The authenticated Admin session supplies the authoritative runtime
// origin for split-host/TLS deployments; a build-time override remains as a
// compatibility fallback only.
const FALLBACK_PUBLIC_API_BASE = (() => {
  const configured = httpOrigin(import.meta.env.VITE_MX_INSIGHT_PUBLIC_API_BASE)
  if (configured) return configured
  if (typeof window !== 'undefined' && window.location.port === '18151') {
    const url = new URL(window.location.origin)
    url.port = '18150'
    return url.origin
  }
  return ''
})()

let runtimePublicApiBase = ''

const visibleDataCenterResponse = (responsePromise) => responsePromise.then(dataCenterVisibleProjection)
const visibleSourceCatalogResponse = (responsePromise) => responsePromise.then(sourceCatalogVisibleProjection)

export function configurePublicApiBase(value) {
  runtimePublicApiBase = httpOrigin(value)
}

function publicApiBase() {
  return runtimePublicApiBase || FALLBACK_PUBLIC_API_BASE
}

export function publicApiOrigin() {
  const configured = publicApiBase()
  if (configured) return configured
  return typeof window !== 'undefined' ? window.location.origin : ''
}

export function publicDocsHref(path = '/docs') {
  const normalizedPath = path.startsWith('/docs') ? path : `/docs/${String(path).replace(/^\/+/, '')}`
  if (runtimePublicApiBase) return `${runtimePublicApiBase}${normalizedPath}`
  const configured = withoutTrailingSlash(import.meta.env.VITE_MX_INSIGHT_PUBLIC_DOCS_URL)
  if (configured) {
    return normalizedPath === '/docs'
      ? configured
      : `${configured}${normalizedPath.slice('/docs'.length)}`
  }
  return `${publicApiBase()}${normalizedPath}`
}

export class ApiError extends Error {
  constructor({ status = 0, code = 'request_failed', message = 'Request failed', requestId, details, reason } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.requestId = requestId
    this.details = details
    // A rejection explains itself in the same vocabulary a degraded delivery
    // uses, so failure and fallback can be triaged the same way.
    this.reason = reason || details?.reason || null
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
async function request(token, path, { method = 'GET', body, query, raw, contentType, headers } = {}) {
  const response = await fetch(`${API_BASE}${path}${queryString(query)}`, {
    method,
    headers: {
      accept: 'application/json',
      'x-mx-insight-admin-token': token,
      ...(raw ? { 'content-type': contentType || 'application/octet-stream' } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(headers || {}),
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

async function publicDataRequest(apiKey, path, {
  method = 'GET',
  body,
  idempotencyKey,
  retryOfRequestId,
  signal,
} = {}) {
  const response = await fetch(`${publicApiBase()}${path}`, {
    method,
    signal,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${apiKey}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      ...(retryOfRequestId ? { 'x-mx-insight-retry-of': retryOfRequestId } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const payload = await parsePayload(response)
  const evidence = {
    requestId: payload?.requestId || response.headers.get('x-mx-insight-request-id'),
    sourceMode: response.headers.get('x-mx-insight-source-mode') || payload?.meta?.sourceMode || null,
    idempotentReplay: response.headers.get('idempotent-replay') === 'true',
    capturedAt: response.headers.get('x-mx-insight-captured-at') || payload?.meta?.capturedAt || null,
    ageSeconds: payload?.meta?.ageSeconds ?? null,
    // Hub states why a delivery looks the way it does instead of leaving the
    // caller to infer it from sourceMode. `liveAttempted` in particular is the
    // only definitive answer to "did this request spend an upstream call",
    // which sourceMode alone cannot give for a stored fallback.
    reason: payload?.meta?.reason
      || payload?.error?.details?.reason
      || (response.headers.get('x-mx-insight-reason')
        ? { code: response.headers.get('x-mx-insight-reason') }
        : null),
  }
  if (!response.ok) {
    throw new ApiError({
      status: response.status,
      code: payload?.error?.code,
      message: payload?.error?.message || `Request failed with HTTP ${response.status}`,
      requestId: evidence.requestId,
      details: payload?.error?.details,
      reason: evidence.reason,
    })
  }
  return { payload, evidence }
}

async function publicDataImage(apiKey, path, query, { signal } = {}) {
  const response = await fetch(`${publicApiBase()}${path}${queryString(query)}`, {
    signal,
    headers: {
      accept: 'image/webp,image/png,image/jpeg',
      authorization: `Bearer ${apiKey}`,
    },
  })
  if (!response.ok) {
    const payload = await parsePayload(response)
    throw new ApiError({
      status: response.status,
      code: payload?.error?.code,
      message: payload?.error?.message || `Image request failed with HTTP ${response.status}`,
      requestId: payload?.requestId || response.headers.get('x-mx-insight-request-id'),
      details: payload?.error?.details,
    })
  }
  return response.blob()
}

// This deliberately accepts the ordinary Hub Public API key, never an upstream provider
// credential. The data-product workbench keeps the value in component memory
// and calls the same stable public contract used by external clients.
export const publicDataApi = {
  capabilities: (apiKey, { signal } = {}) => publicDataRequest(
    apiKey,
    '/api/v1/data/capabilities',
    { signal },
  ),
  requestStatus: (apiKey, requestId, { signal } = {}) => publicDataRequest(
    apiKey,
    `/api/v1/requests/${encodeURIComponent(requestId)}`,
    { signal },
  ),
  acquisitionHistory: (apiKey, requestId, { signal } = {}) => publicDataRequest(
    apiKey,
    `/api/v1/acquisitions/${encodeURIComponent(requestId)}`,
    { signal },
  ),
  requestByIdempotencyKey: (apiKey, idempotencyKey, { signal } = {}) => publicDataRequest(
    apiKey,
    '/api/v1/requests/by-idempotency-key',
    { idempotencyKey, signal },
  ),
  ecommerceStoredItems: (apiKey, query) => publicDataRequest(apiKey, `/api/v1/data/ecommerce/products/items?${new URLSearchParams(query)}`),
  ecommerceProductsSearch: (apiKey, body, { idempotencyKey, retryOfRequestId } = {}) => publicDataRequest(
    apiKey,
    '/api/v1/data/ecommerce/products/search',
    { method: 'POST', body, idempotencyKey, retryOfRequestId },
  ),
  xiaohongshuNative: (apiKey, endpoint, body, { idempotencyKey, signal } = {}) => publicDataRequest(
    apiKey,
    `/api/v1/xiaohongshu/app_v2/${encodeURIComponent(endpoint)}`,
    { method: 'POST', body, idempotencyKey, signal },
  ),
  xiaohongshuNote: (apiKey, body, { idempotencyKey, retryOfRequestId, signal } = {}) => publicDataRequest(
    apiKey,
    '/api/v1/xiaohongshu/app/get_note_info',
    { method: 'POST', body, idempotencyKey, retryOfRequestId, signal },
  ),
  ecommerceProductImage: (apiKey, { requestId, itemId, imageIndex = 0 }, { signal } = {}) => publicDataImage(
    apiKey,
    '/api/v1/data/ecommerce/products/media',
    { requestId, itemId, imageIndex },
    { signal },
  ),
  socialPostImage: (apiKey, { requestId, mediaIndex = 0 }, { signal } = {}) => publicDataImage(
    apiKey,
    '/api/v1/data/posts/media',
    { requestId, mediaIndex },
    { signal },
  ),
  createTopicReport: (apiKey, body, { idempotencyKey, signal } = {}) => publicDataRequest(
    apiKey,
    '/api/v1/data/topic-reports',
    { method: 'POST', body, idempotencyKey, signal },
  ),
  topicReport: (apiKey, reportId, { signal } = {}) => publicDataRequest(
    apiKey,
    `/api/v1/data/topic-reports/${encodeURIComponent(reportId)}`,
    { signal },
  ),
}

/**
 * Sign in with a Launcher account, through the Hub.
 *
 * Not posted to Launcher directly: Launcher answers only on the internal
 * network, so a browser outside the VPN could never reach it. The Hub forwards
 * the credentials and returns just the issued token.
 */
export async function signInWithLauncher({ username, password }) {
  const response = await fetch(`${API_BASE}${ADMIN_ROOT}/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const payload = await parsePayload(response)
  if (!response.ok) {
    throw new ApiError({
      status: response.status,
      code: payload?.error?.code,
      message: payload?.error?.code === 'invalid_credentials'
        ? '账号或密码不正确'
        : payload?.error?.message || `登录失败（HTTP ${response.status}）`,
      requestId: payload?.requestId,
    })
  }
  return payload?.data?.token
}

export const adminApi = {
  ecommerceItems: (token, query) => request(token, `${ADMIN_ROOT}/data-products/ecommerce/items`, { query }),
  saveEcommerceItem: (token, body) => request(token, `${ADMIN_ROOT}/data-products/ecommerce/items`, { method: body.requestId ? 'PUT' : 'POST', body }),
  deleteEcommerceItem: (token, body) => request(token, `${ADMIN_ROOT}/data-products/ecommerce/items`, { method: 'DELETE', body }),
  ecommerceImage: async (token, query, signal) => {
    const response = await fetch(`${API_BASE}${ADMIN_ROOT}/data-products/ecommerce/media${queryString(query)}`, { headers: { 'x-mx-insight-admin-token': token }, signal })
    if (!response.ok) throw new ApiError({ status: response.status, message: '图片暂不可用' })
    return response.blob()
  },
  // Unauthenticated: the console needs to know how to sign in before it can.
  signInOptions: () => fetch(`${API_BASE}${ADMIN_ROOT}/sign-in-options`)
    .then(parsePayload)
    .then((payload) => payload?.data ?? { adminToken: true, launcher: null })
    .catch(() => ({ adminToken: true, launcher: null })),
  dashboard: (token) => request(token, `${ADMIN_ROOT}/dashboard`),
  tenants: (token) => request(token, `${ADMIN_ROOT}/tenants`),
  createTenant: (token, body) => request(token, `${ADMIN_ROOT}/tenants`, { method: 'POST', body }),
  renameTenant: (token, id, body) => request(token, `${ADMIN_ROOT}/tenants/${encodeURIComponent(id)}`, { method: 'PUT', body }),
  setTenantStatus: (token, id, body) => request(token, `${ADMIN_ROOT}/tenants/${encodeURIComponent(id)}/status`, { method: 'PUT', body }),
  consumers: (token, tenantId) => request(token, `${ADMIN_ROOT}/consumers`, { query: { tenantId } }),
  createConsumer: (token, body) => request(token, `${ADMIN_ROOT}/consumers`, { method: 'POST', body }),
  apiKeys: (token, consumerId) => request(token, `${ADMIN_ROOT}/api-keys`, { query: { consumerId } }),
  createApiKey: (token, body) => request(token, `${ADMIN_ROOT}/api-keys`, { method: 'POST', body }),
  apiKeyOverview: (token, id) => request(token, `${ADMIN_ROOT}/api-keys/${encodeURIComponent(id)}/overview`),
  consumerHealth: (token, id) => request(token, `${ADMIN_ROOT}/consumers/${encodeURIComponent(id)}/health`),
  myOverview: (token, tenantId) => request(token, `${ADMIN_ROOT}/me/overview${tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : ''}`),
  revokeApiKey: (token, id) => request(token, `${ADMIN_ROOT}/api-keys/${encodeURIComponent(id)}/revoke`, { method: 'POST' }),
  plans: (token, consumerId) => request(token, `${ADMIN_ROOT}/plans`, { query: { consumerId } }),
  publishPlan: (token, body) => request(token, `${ADMIN_ROOT}/plans`, { method: 'POST', body }),
  assignConsumerPlan: (token, consumerId, body) => request(
    token,
    `${ADMIN_ROOT}/consumers/${encodeURIComponent(consumerId)}/plan`,
    { method: 'PUT', body },
  ),
  platforms: (token, query) => request(token, `${ADMIN_ROOT}/platforms`, { query }),
  updatePlatform: (token, platform, body) => request(
    token,
    `${ADMIN_ROOT}/platforms/${encodeURIComponent(platform)}`,
    { method: 'PUT', body },
  ),
  updateCapability: (token, capability, body) => request(
    token,
    `${ADMIN_ROOT}/capabilities/${encodeURIComponent(capability)}`,
    { method: 'PUT', body },
  ),
  usage: (token, query) => request(token, `${ADMIN_ROOT}/usage`, { query }),
  tenantBilling: (token, tenantId, query = {}) => request(
    token,
    `${ADMIN_ROOT}/tenants/${encodeURIComponent(tenantId)}/billing`,
    { query },
  ),
  updateTenantBillingProfile: (token, tenantId, body) => request(
    token,
    `${ADMIN_ROOT}/tenants/${encodeURIComponent(tenantId)}/billing/profile`,
    { method: 'PUT', body },
  ),
  addTenantCredit: (token, tenantId, body, idempotencyKey) => request(
    token,
    `${ADMIN_ROOT}/tenants/${encodeURIComponent(tenantId)}/billing/credits`,
    { method: 'POST', body, headers: { 'idempotency-key': idempotencyKey } },
  ),
  reconcileUnknownCustomerCharge: (token, usageRequestId, body, idempotencyKey) => request(
    token,
    `${ADMIN_ROOT}/usage/${encodeURIComponent(usageRequestId)}/customer-charge/reconciliation`,
    { method: 'POST', body, headers: { 'idempotency-key': idempotencyKey } },
  ),

  // Identity. `session` is fetched first on load: the console renders itself
  // from the returned capabilities so a scoped user never sees a control they
  // are not allowed to use.
  session: (token) => request(token, `${ADMIN_ROOT}/session`),
  members: (token) => request(token, `${ADMIN_ROOT}/members`),
  grantMembership: (token, body) => request(token, `${ADMIN_ROOT}/members/memberships`, { method: 'POST', body }),
  revokeMembership: (token, body) => request(token, `${ADMIN_ROOT}/members/memberships/revoke`, { method: 'POST', body }),

  // External sources (P4).
  sources: (token) => request(token, `${ADMIN_ROOT}/sources`),
  databaseConnections: (token) => request(token, `${ADMIN_ROOT}/database-connections`),
  externalPlatforms: (token, query = {}) => request(
    token, `${ADMIN_ROOT}/external-platforms`, { query },
  ),
  updateExternalPlatformProxy: (token, key, body) => request(token, `${ADMIN_ROOT}/external-platforms/${encodeURIComponent(key)}/proxy`, { method: 'PUT', body }),
  externalPlatform: (token, key, query = {}) => request(
    token, `${ADMIN_ROOT}/external-platforms/${encodeURIComponent(key)}`, { query },
  ),
  updateExternalPlatformCredential: (token, key, body) => request(
    token,
    `${ADMIN_ROOT}/external-platforms/${encodeURIComponent(key)}/credential`,
    { method: 'PUT', body },
  ),
  updateExternalPlatformOperationPolicy: (token, key, operation, body) => request(
    token,
    `${ADMIN_ROOT}/external-platforms/${encodeURIComponent(key)}/operations/${encodeURIComponent(operation)}/policy`,
    { method: 'PUT', body },
  ),
  updateExternalPlatformPriceBook: (token, key, body) => request(
    token,
    `${ADMIN_ROOT}/external-platforms/${encodeURIComponent(key)}/price-book`,
    { method: 'PUT', body },
  ),
  revealExternalPlatformCredential: (token, key, adminToken) => request(
    token,
    `${ADMIN_ROOT}/external-platforms/${encodeURIComponent(key)}/credential/reveal`,
    { method: 'POST', body: { adminToken } },
  ),
  createDatabaseConnection: (token, body) => request(
    token, `${ADMIN_ROOT}/database-connections`, { method: 'POST', body },
  ),
  updateDatabaseConnection: (token, id, body) => request(
    token, `${ADMIN_ROOT}/database-connections/${encodeURIComponent(id)}`, { method: 'PUT', body },
  ),
  deleteDatabaseConnection: (token, id) => request(
    token, `${ADMIN_ROOT}/database-connections/${encodeURIComponent(id)}`, { method: 'DELETE' },
  ),
  testDatabaseConnection: (token, id) => request(
    token, `${ADMIN_ROOT}/database-connections/${encodeURIComponent(id)}/test`, { method: 'POST' },
  ),
  fileFormatRules: (token) => request(token, `${ADMIN_ROOT}/file-format-rules`),
  listServerFileRoots: (token) => request(token, `${ADMIN_ROOT}/server-file-roots`),
  dataCenter: (token, query = {}) => visibleDataCenterResponse(request(
    token,
    `${ADMIN_ROOT}/data-center`,
    { query: { ...query, presentation: 'safe' } },
  )),
  dataCenterRecords: (token, query = {}) => visibleDataCenterResponse(request(
    token,
    `${ADMIN_ROOT}/data-center/records`,
    { query: { ...query, presentation: 'safe' } },
  )),
  acquisitionHistory: (token, requestId) => request(
    token,
    `${ADMIN_ROOT}/acquisitions/${encodeURIComponent(requestId)}`,
  ),
  searchReindex: (token) => request(token, `${ADMIN_ROOT}/search/reindex`),
  cancelSearchReindex: (token) => request(
    token, `${ADMIN_ROOT}/search/reindex/cancel`, { method: 'POST' },
  ),
  // Whether a projector restart replays the corpus. Off means it comes up,
  // reconciles schema and serves.
  setSearchStartupRebuild: (token, enabled) => request(
    token, `${ADMIN_ROOT}/search/startup-rebuild`, { method: 'PUT', body: { enabled } },
  ),
  // acknowledgeBackend is sent only for a deliberate non-HanLP rebuild; the
  // server refuses the downgrade without it.
  startSearchReindex: (token, acknowledgeBackend = null) => request(
    token,
    `${ADMIN_ROOT}/search/reindex`,
    {
      method: 'POST',
      body: {
        confirmation: 'REINDEX',
        ...(acknowledgeBackend ? { acknowledgeBackend } : {}),
      },
    },
  ),
  sourceCatalog: (token, { includeArchived = false } = {}) => visibleSourceCatalogResponse(request(
    token,
    `${ADMIN_ROOT}/source-catalog`,
    { query: { includeArchived: includeArchived || undefined, presentation: 'safe' } },
  )),
  createSourceCatalogEntry: (token, body) => request(
    token, `${ADMIN_ROOT}/source-catalog`, { method: 'POST', body },
  ),
  updateSourceCatalogEntry: (token, id, body) => request(
    token, `${ADMIN_ROOT}/source-catalog/${encodeURIComponent(id)}`, { method: 'PUT', body },
  ),
  archiveSourceCatalogEntry: (token, id, revision) => request(
    token,
    `${ADMIN_ROOT}/source-catalog/${encodeURIComponent(id)}/archive`,
    { method: 'POST', body: { revision } },
  ),
  restoreSourceCatalogEntry: (token, id, revision) => request(
    token,
    `${ADMIN_ROOT}/source-catalog/${encodeURIComponent(id)}/restore`,
    { method: 'POST', body: { revision } },
  ),
  sourceCatalogEvents: (token, id, limit = 50) => visibleSourceCatalogResponse(request(
    token,
    `${ADMIN_ROOT}/source-catalog/${encodeURIComponent(id)}/events`,
    { query: { limit } },
  )),
  sourceCatalogRelatedData: (token, id, { pageSize = 20 } = {}) => visibleSourceCatalogResponse(request(
    token,
    `${ADMIN_ROOT}/source-catalog/${encodeURIComponent(id)}/related-data`,
    { query: { pageSize } },
  )),
  sourceCatalogTaxonomy: (token, { includeArchived = false, kind } = {}) => visibleSourceCatalogResponse(request(
    token,
    `${ADMIN_ROOT}/source-catalog/taxonomy`,
    { query: { includeArchived: includeArchived || undefined, kind } },
  )),
  createSourceCatalogTaxonomyTerm: (token, body) => request(
    token,
    `${ADMIN_ROOT}/source-catalog/taxonomy`,
    { method: 'POST', body },
  ),
  updateSourceCatalogTaxonomyTerm: (token, id, body) => request(
    token,
    `${ADMIN_ROOT}/source-catalog/taxonomy/${encodeURIComponent(id)}`,
    { method: 'PUT', body },
  ),
  archiveSourceCatalogTaxonomyTerm: (token, id, revision) => request(
    token,
    `${ADMIN_ROOT}/source-catalog/taxonomy/${encodeURIComponent(id)}/archive`,
    { method: 'POST', body: { revision } },
  ),
  restoreSourceCatalogTaxonomyTerm: (token, id, revision) => request(
    token,
    `${ADMIN_ROOT}/source-catalog/taxonomy/${encodeURIComponent(id)}/restore`,
    { method: 'POST', body: { revision } },
  ),
  sourceCatalogOwners: (token, { includeArchived = false } = {}) => visibleSourceCatalogResponse(request(
    token,
    `${ADMIN_ROOT}/source-catalog/owners`,
    { query: { includeArchived: includeArchived || undefined } },
  )),
  createSourceCatalogOwner: (token, body) => visibleSourceCatalogResponse(request(
    token, `${ADMIN_ROOT}/source-catalog/owners`, { method: 'POST', body },
  )),
  updateSourceCatalogOwner: (token, id, body) => request(
    token, `${ADMIN_ROOT}/source-catalog/owners/${encodeURIComponent(id)}`, { method: 'PUT', body },
  ),
  archiveSourceCatalogOwner: (token, id, revision) => request(
    token,
    `${ADMIN_ROOT}/source-catalog/owners/${encodeURIComponent(id)}/archive`,
    { method: 'POST', body: { revision } },
  ),
  restoreSourceCatalogOwner: (token, id, revision) => request(
    token,
    `${ADMIN_ROOT}/source-catalog/owners/${encodeURIComponent(id)}/restore`,
    { method: 'POST', body: { revision } },
  ),
  sourceCatalogOwnerEvents: (token, id, limit = 50) => visibleSourceCatalogResponse(request(
    token,
    `${ADMIN_ROOT}/source-catalog/owners/${encodeURIComponent(id)}/events`,
    { query: { limit } },
  )),

  // Read-only business presentations. These routes deliberately use the
  // admin session rather than borrowing a Hub Public API key, so inspecting a
  // showcase neither consumes customer quota nor exposes a reusable secret in
  // the renderer.
  dataProductTelegramChats: (token, query = {}) => request(
    token, `${ADMIN_ROOT}/data-products/telegram/chats`, { query },
  ),
  dataProductTelegramMessages: (token, chatId, query = {}) => request(
    token,
    `${ADMIN_ROOT}/data-products/telegram/chats/${encodeURIComponent(chatId)}/messages`,
    { query },
  ),
  searchDataProductTelegram: (token, body) => request(
    token, `${ADMIN_ROOT}/data-products/telegram/search`, { method: 'POST', body },
  ),
  dataProductTelegramContext: (token, id, query = {}) => request(
    token,
    `${ADMIN_ROOT}/data-products/telegram/items/${encodeURIComponent(id)}/context`,
    { query },
  ),
  topicReports: (token, { limit = 30 } = {}) => request(
    token,
    `${ADMIN_ROOT}/data-products/topic-reports`,
    { query: { limit } },
  ),
  createTopicReport: (token, body) => request(
    token,
    `${ADMIN_ROOT}/data-products/topic-reports`,
    { method: 'POST', body },
  ),
  topicReport: (token, id) => request(
    token,
    `${ADMIN_ROOT}/data-products/topic-reports/${encodeURIComponent(id)}`,
  ),
  dataProductPublicOpinionRegions: (token) => request(
    token, `${ADMIN_ROOT}/data-products/public-opinion/regions`,
  ),
  dataProductPublicOpinionCoverage: (token, query = {}) => request(
    token, `${ADMIN_ROOT}/data-products/public-opinion/province-coverage`, { query },
  ),
  dataProductPublicOpinionProvince: (token, province, query = {}) => request(
    token,
    `${ADMIN_ROOT}/data-products/public-opinion/provinces/${encodeURIComponent(province)}/items`,
    { query },
  ),
  dataProductPublicOpinionItem: (token, id) => request(
    token, `${ADMIN_ROOT}/data-products/public-opinion/items/${encodeURIComponent(id)}`,
  ),
  dataProductPublicOpinionFunnel: (token, query = {}) => request(
    token, `${ADMIN_ROOT}/data-products/public-opinion/funnel`, { query },
  ),
  dataProductPublicOpinionRecords: (token, query = {}) => request(
    token, `${ADMIN_ROOT}/data-products/public-opinion/records`, { query },
  ),
  dataProductPublicOpinionRecord: (token, id, query = {}) => request(
    token,
    `${ADMIN_ROOT}/data-products/public-opinion/records/${encodeURIComponent(id)}`,
    { query },
  ),
  dataProductVirtualSupermarketMetadata: (token) => request(
    token, `${ADMIN_ROOT}/data-products/virtual-supermarket/metadata`,
  ),
  dataProductVirtualSupermarketCategories: (token, query = {}) => request(
    token, `${ADMIN_ROOT}/data-products/virtual-supermarket/categories`, { query },
  ),
  createDataProductVirtualSupermarketCategory: (token, body) => request(
    token, `${ADMIN_ROOT}/data-products/virtual-supermarket/categories`, { method: 'POST', body },
  ),
  updateDataProductVirtualSupermarketCategory: (token, id, body) => request(
    token,
    `${ADMIN_ROOT}/data-products/virtual-supermarket/categories/${encodeURIComponent(id)}`,
    { method: 'PATCH', body },
  ),
  dataProductVirtualSupermarketProducts: (token, query = {}) => request(
    token, `${ADMIN_ROOT}/data-products/virtual-supermarket/products`, { query },
  ),
  dataProductVirtualSupermarketProduct: (token, id) => request(
    token, `${ADMIN_ROOT}/data-products/virtual-supermarket/products/${encodeURIComponent(id)}`,
  ),
  updateDataProductVirtualSupermarketProduct: (token, id, body) => request(
    token,
    `${ADMIN_ROOT}/data-products/virtual-supermarket/products/${encodeURIComponent(id)}`,
    { method: 'PATCH', body },
  ),
  publishDataProductVirtualSupermarketProduct: (token, id, body) => request(
    token,
    `${ADMIN_ROOT}/data-products/virtual-supermarket/products/${encodeURIComponent(id)}/publish`,
    { method: 'POST', body },
  ),
  unpublishDataProductVirtualSupermarketProduct: (token, id, body) => request(
    token,
    `${ADMIN_ROOT}/data-products/virtual-supermarket/products/${encodeURIComponent(id)}/unpublish`,
    { method: 'POST', body },
  ),
  dataProductVirtualSupermarketEvents: (token, id) => request(
    token,
    `${ADMIN_ROOT}/data-products/virtual-supermarket/products/${encodeURIComponent(id)}/events`,
  ),
  createSource: (token, body) => request(token, `${ADMIN_ROOT}/sources`, { method: 'POST', body }),
  updateSource: (token, key, body) => request(
    token, `${ADMIN_ROOT}/sources/${encodeURIComponent(key)}`, { method: 'PUT', body },
  ),
  testSource: (token, key) => request(
    token, `${ADMIN_ROOT}/sources/${encodeURIComponent(key)}/test`, { method: 'POST' },
  ),
  sourceMappings: (token, key) => request(token, `${ADMIN_ROOT}/sources/${encodeURIComponent(key)}/mappings`),
  createMapping: (token, key, body) => request(
    token, `${ADMIN_ROOT}/sources/${encodeURIComponent(key)}/mappings`, { method: 'POST', body },
  ),
  approveMapping: (token, key, version) => request(
    token, `${ADMIN_ROOT}/sources/${encodeURIComponent(key)}/mappings/${version}/approve`, { method: 'POST' },
  ),
  previewImport: (token, key, file, { useAgent = false, preferredRuleKey = null } = {}) => request(
    token, `${ADMIN_ROOT}/sources/${encodeURIComponent(key)}/preview`,
    {
      method: 'POST',
      raw: file,
      query: { filename: file.name, agent: useAgent, preferredRuleKey: preferredRuleKey || undefined },
    },
  ),
  runImport: (token, key, file) => request(
    token, `${ADMIN_ROOT}/sources/${encodeURIComponent(key)}/import`,
    { method: 'POST', raw: file, query: { filename: file.name } },
  ),
  serverPreview: (token, key, { serverPath, agent = false, preferredRuleKey = null } = {}) => request(
    token, `${ADMIN_ROOT}/sources/${encodeURIComponent(key)}/server-preview`,
    {
      method: 'POST',
      body: {
        ...(serverPath ? { serverPath } : {}),
        ...(preferredRuleKey ? { preferredRuleKey } : {}),
        agent,
      },
    },
  ),
  serverImport: (token, key, { serverPath, expectedSha256 }) => request(
    token, `${ADMIN_ROOT}/sources/${encodeURIComponent(key)}/server-import`,
    { method: 'POST', body: { ...(serverPath ? { serverPath } : {}), expectedSha256 } },
  ),
  importRuns: (token, key) => request(token, `${ADMIN_ROOT}/sources/${encodeURIComponent(key)}/imports`),
  sourceSchema: (token, key) => request(token, `${ADMIN_ROOT}/sources/${encodeURIComponent(key)}/schema`),
  previewDatabaseSource: (token, key, limit = 3) => request(
    token, `${ADMIN_ROOT}/sources/${encodeURIComponent(key)}/preview`, { query: { limit } },
  ),
  sourceSync: (token, key) => request(token, `${ADMIN_ROOT}/sources/${encodeURIComponent(key)}/sync`),
  runSourceSync: (token, key, body = {}) => request(
    token, `${ADMIN_ROOT}/sources/${encodeURIComponent(key)}/sync`, { method: 'POST', body },
  ),
  resetSourceCheckpoint: (token, key, body) => request(
    token, `${ADMIN_ROOT}/sources/${encodeURIComponent(key)}/checkpoint/reset`, { method: 'POST', body },
  ),
  telegramMonitorPipeline: (token) => request(token, `${ADMIN_ROOT}/pipelines/telegram-monitor`),
  updateTelegramMonitorPipeline: (token, body) => request(
    token, `${ADMIN_ROOT}/pipelines/telegram-monitor`, { method: 'PUT', body },
  ),
  updateTelegramMonitorPipelineStatus: (token, status, writerContractAttestation = null) => request(
    token, `${ADMIN_ROOT}/pipelines/telegram-monitor/status`, {
      method: 'POST',
      body: { status, ...(writerContractAttestation ? { writerContractAttestation } : {}) },
    },
  ),
  runTelegramMonitorPipeline: (token, body = {}) => request(
    token, `${ADMIN_ROOT}/pipelines/telegram-monitor/sync`, { method: 'POST', body },
  ),
  telegramMonitorPipelineProgress: (token) => request(
    token, `${ADMIN_ROOT}/pipelines/telegram-monitor/progress`,
  ),
  telegramMonitorSourcePreparation: (token) => request(
    token, `${ADMIN_ROOT}/pipelines/telegram-monitor/source/prepare`,
  ),
  prepareTelegramMonitorSource: (token, body) => request(
    token, `${ADMIN_ROOT}/pipelines/telegram-monitor/source/prepare`, { method: 'POST', body },
  ),
  resetTelegramMonitorPipelineCheckpoints: (token, body) => request(
    token, `${ADMIN_ROOT}/pipelines/telegram-monitor/checkpoints/reset`, { method: 'POST', body },
  ),
  telegramSqlitePipeline: (token) => request(token, `${ADMIN_ROOT}/pipelines/telegram-sqlite`),
  updateTelegramSqlitePipeline: (token, body) => request(
    token, `${ADMIN_ROOT}/pipelines/telegram-sqlite`, { method: 'PUT', body },
  ),
  updateTelegramSqlitePipelineStatus: (token, status) => request(
    token, `${ADMIN_ROOT}/pipelines/telegram-sqlite/status`, { method: 'POST', body: { status } },
  ),
  runTelegramSqlitePipeline: (token, body = {}) => request(
    token, `${ADMIN_ROOT}/pipelines/telegram-sqlite/sync`, { method: 'POST', body },
  ),
  telegramSqlitePipelineProgress: (token) => request(
    token, `${ADMIN_ROOT}/pipelines/telegram-sqlite/progress`,
  ),
  resetTelegramSqlitePipelineCheckpoints: (token, body) => request(
    token, `${ADMIN_ROOT}/pipelines/telegram-sqlite/checkpoints/reset`, { method: 'POST', body },
  ),
  // Clears a failed cursor so scheduling resumes; the checkpoint is untouched.
  resumeTelegramSqlitePipeline: (token) => request(
    token, `${ADMIN_ROOT}/pipelines/telegram-sqlite/resume`, { method: 'POST' },
  ),
  resumeTelegramMonitorPipeline: (token) => request(
    token, `${ADMIN_ROOT}/pipelines/telegram-monitor/resume`, { method: 'POST' },
  ),
  provinceOpinionPipeline: (token) => request(token, `${ADMIN_ROOT}/pipelines/province-opinion`),
  updateProvinceOpinionPipeline: (token, body) => request(
    token, `${ADMIN_ROOT}/pipelines/province-opinion`, { method: 'PUT', body },
  ),
  updateProvinceOpinionPipelineStatus: (token, status, writerContractAttestation = null) => request(
    token, `${ADMIN_ROOT}/pipelines/province-opinion/status`, {
      method: 'POST',
      body: { status, ...(writerContractAttestation ? { writerContractAttestation } : {}) },
    },
  ),
  runProvinceOpinionPipeline: (token, body = {}) => request(
    token, `${ADMIN_ROOT}/pipelines/province-opinion/sync`, { method: 'POST', body },
  ),
  provinceOpinionPipelineProgress: (token) => request(
    token, `${ADMIN_ROOT}/pipelines/province-opinion/progress`,
  ),
  provinceOpinionQualitySummary: (token) => request(
    token, `${ADMIN_ROOT}/pipelines/province-opinion/quality-summary`,
  ),
  resumeProvinceOpinionPipeline: (token) => request(
    token, `${ADMIN_ROOT}/pipelines/province-opinion/resume`, { method: 'POST' },
  ),
  resetProvinceOpinionPipelineCheckpoint: (token, body) => request(
    token, `${ADMIN_ROOT}/pipelines/province-opinion/checkpoint/reset`, { method: 'POST', body },
  ),
  nightAllSavedRecordsPipeline: (token) => request(
    token, `${ADMIN_ROOT}/pipelines/night-all-saved-records`,
  ),
  updateNightAllSavedRecordsPipeline: (token, body) => request(
    token, `${ADMIN_ROOT}/pipelines/night-all-saved-records`, { method: 'PUT', body },
  ),
  updateNightAllSavedRecordsPipelineStatus: (
    token, status, writerContractAttestation = null, selector = null,
  ) => request(
    token,
    `${ADMIN_ROOT}/pipelines/night-all-saved-records/status`,
    {
      method: 'POST',
      body: {
        status,
        ...(writerContractAttestation ? { writerContractAttestation } : {}),
        ...(selector && Object.prototype.hasOwnProperty.call(selector, 'sourceType')
          ? { sourceType: selector.sourceType }
          : {}),
      },
    },
  ),
  runNightAllSavedRecordsPipeline: (token, body = {}) => request(
    token, `${ADMIN_ROOT}/pipelines/night-all-saved-records/sync`, { method: 'POST', body },
  ),
  nightAllSavedRecordsPipelineProgress: (token) => request(
    token, `${ADMIN_ROOT}/pipelines/night-all-saved-records/progress`,
  ),
  resumeNightAllSavedRecordsPipeline: (token) => request(
    token, `${ADMIN_ROOT}/pipelines/night-all-saved-records/resume`, { method: 'POST' },
  ),
  resetNightAllSavedRecordsPipelineCheckpoints: (token, body) => request(
    token, `${ADMIN_ROOT}/pipelines/night-all-saved-records/checkpoints/reset`, { method: 'POST', body },
  ),
  mobileCommercePipeline: (token) => request(token, `${ADMIN_ROOT}/pipelines/mobile-commerce`),
  updateMobileCommercePipeline: (token, body) => request(
    token, `${ADMIN_ROOT}/pipelines/mobile-commerce`, { method: 'PUT', body },
  ),
  updateMobileCommercePipelineStatus: (token, status, writerContractAttestation = null) => request(
    token,
    `${ADMIN_ROOT}/pipelines/mobile-commerce/status`,
    {
      method: 'POST',
      body: { status, ...(writerContractAttestation ? { writerContractAttestation } : {}) },
    },
  ),
  runMobileCommercePipeline: (token, body = {}) => request(
    token, `${ADMIN_ROOT}/pipelines/mobile-commerce/sync`, { method: 'POST', body },
  ),
  resumeMobileCommercePipeline: (token) => request(
    token, `${ADMIN_ROOT}/pipelines/mobile-commerce/resume`, { method: 'POST' },
  ),
  resetMobileCommercePipelineCheckpoint: (token, body) => request(
    token, `${ADMIN_ROOT}/pipelines/mobile-commerce/checkpoint/reset`, { method: 'POST', body },
  ),

  // Backfill (P3), agent (P5) and retrieval (embedding pipeline).
  backfill: (token) => request(token, `${ADMIN_ROOT}/backfill`),
  startBackfill: (token, body) => request(token, `${ADMIN_ROOT}/backfill`, { method: 'POST', body }),
  agent: (token) => request(token, `${ADMIN_ROOT}/agent`),
  agentMarket: (token) => request(token, `${ADMIN_ROOT}/agent-market`),
  agentMarketCatalog: (token) => request(token, `${ADMIN_ROOT}/agent-market/catalog`),
  createAgentMarketCategory: (token, body) => request(
    token,
    `${ADMIN_ROOT}/agent-market/categories`,
    { method: 'POST', body },
  ),
  updateAgentMarketCategory: (token, categoryKey, body) => request(
    token,
    `${ADMIN_ROOT}/agent-market/categories/${encodeURIComponent(categoryKey)}`,
    { method: 'PUT', body },
  ),
  deleteAgentMarketCategory: (token, categoryKey, body) => request(
    token,
    `${ADMIN_ROOT}/agent-market/categories/${encodeURIComponent(categoryKey)}`,
    { method: 'DELETE', body },
  ),
  createAgentMarketAgent: (token, body) => request(
    token,
    `${ADMIN_ROOT}/agent-market/agents`,
    { method: 'POST', body },
  ),
  updateAgentMarketAgent: (token, agentKey, body) => request(
    token,
    `${ADMIN_ROOT}/agent-market/agents/${encodeURIComponent(agentKey)}`,
    { method: 'PUT', body },
  ),
  agentMarketItem: (token, agentKey) => request(
    token,
    `${ADMIN_ROOT}/agent-market/${encodeURIComponent(agentKey)}`,
  ),
  saveAgentMarketItem: (token, agentKey, body) => request(
    token,
    `${ADMIN_ROOT}/agent-market/${encodeURIComponent(agentKey)}`,
    { method: 'PUT', body },
  ),
  runAgentMarketDryRun: (token, agentKey, body) => request(
    token,
    `${ADMIN_ROOT}/agent-market/${encodeURIComponent(agentKey)}/dry-run`,
    { method: 'POST', body },
  ),
  agentStudioNodeTypes: (token) => request(token, `${ADMIN_ROOT}/agent-studio/node-types`),
  agentStudioTemplates: (token) => request(token, `${ADMIN_ROOT}/agent-studio/templates`),
  agentStudioProjects: (token) => request(token, `${ADMIN_ROOT}/agent-studio/projects`),
  createAgentStudioProject: (token, body) => request(
    token,
    `${ADMIN_ROOT}/agent-studio/projects`,
    { method: 'POST', body },
  ),
  agentStudioProject: (token, agentKey) => request(
    token,
    `${ADMIN_ROOT}/agent-studio/projects/${encodeURIComponent(agentKey)}`,
  ),
  updateAgentStudioProject: (token, agentKey, body) => request(
    token,
    `${ADMIN_ROOT}/agent-studio/projects/${encodeURIComponent(agentKey)}`,
    { method: 'PUT', body },
  ),
  createAgentStudioDraft: (token, agentKey, body) => request(
    token,
    `${ADMIN_ROOT}/agent-studio/projects/${encodeURIComponent(agentKey)}/drafts`,
    { method: 'POST', body },
  ),
  agentStudioDraft: (token, agentKey, draftId) => request(
    token,
    `${ADMIN_ROOT}/agent-studio/projects/${encodeURIComponent(agentKey)}/drafts/${encodeURIComponent(draftId)}`,
  ),
  saveAgentStudioDraft: (token, agentKey, draftId, body) => request(
    token,
    `${ADMIN_ROOT}/agent-studio/projects/${encodeURIComponent(agentKey)}/drafts/${encodeURIComponent(draftId)}`,
    { method: 'PUT', body },
  ),
  compileAgentStudioDraft: (token, agentKey, draftId, body) => request(
    token,
    `${ADMIN_ROOT}/agent-studio/projects/${encodeURIComponent(agentKey)}/drafts/${encodeURIComponent(draftId)}/compile`,
    { method: 'POST', body },
  ),
  agentStudioArtifact: (token, agentKey, artifactId) => request(
    token,
    `${ADMIN_ROOT}/agent-studio/projects/${encodeURIComponent(agentKey)}/artifacts/${encodeURIComponent(artifactId)}`,
  ),
  updateAgentProviders: (token, kind, body) => request(
    token,
    `${ADMIN_ROOT}/agent/providers/${encodeURIComponent(kind)}`,
    { method: 'PUT', body },
  ),
  testAgentProvider: (token, kind, providerId, body) => request(
    token,
    `${ADMIN_ROOT}/agent/providers/${encodeURIComponent(kind)}/${encodeURIComponent(providerId)}/test`,
    { method: 'POST', body },
  ),
  revealAgentProviderKey: (token, kind, providerId, adminToken) => request(
    token,
    `${ADMIN_ROOT}/agent/providers/${encodeURIComponent(kind)}/${encodeURIComponent(providerId)}/reveal`,
    { method: 'POST', body: { adminToken } },
  ),
  saveAgentSequence: (token, sequenceKey, body) => request(
    token,
    `${ADMIN_ROOT}/agent/sequences/${encodeURIComponent(sequenceKey)}`,
    { method: 'PUT', body },
  ),
  testAgentSequence: (token, sequenceKey, kind, expectedRevision) => request(
    token,
    `${ADMIN_ROOT}/agent/sequences/${encodeURIComponent(sequenceKey)}/test`,
    { method: 'POST', body: { kind, expectedRevision } },
  ),
  setDefaultAgentSequence: (token, sequenceKey, body) => request(
    token,
    `${ADMIN_ROOT}/agent/sequences/${encodeURIComponent(sequenceKey)}/default`,
    { method: 'PUT', body },
  ),
  clearDefaultAgentSequence: (token, body) => request(
    token,
    `${ADMIN_ROOT}/agent/sequences/default`,
    { method: 'PUT', body },
  ),
  saveAgentProxyEndpoint: (token, proxyKey, body) => request(
    token,
    `${ADMIN_ROOT}/agent/proxies/endpoints/${encodeURIComponent(proxyKey)}`,
    { method: 'PUT', body },
  ),
  deleteAgentProxyEndpoint: (token, proxyKey, expectedRevision) => request(
    token,
    `${ADMIN_ROOT}/agent/proxies/endpoints/${encodeURIComponent(proxyKey)}`,
    { method: 'DELETE', body: { expectedRevision } },
  ),
  saveAgentProxySequence: (token, sequenceKey, body) => request(
    token,
    `${ADMIN_ROOT}/agent/proxies/sequences/${encodeURIComponent(sequenceKey)}`,
    { method: 'PUT', body },
  ),
  deleteAgentProxySequence: (token, sequenceKey, expectedRevision) => request(
    token,
    `${ADMIN_ROOT}/agent/proxies/sequences/${encodeURIComponent(sequenceKey)}`,
    { method: 'DELETE', body: { expectedRevision } },
  ),
  setDefaultAgentProxySequence: (token, body) => request(
    token,
    `${ADMIN_ROOT}/agent/proxies/default`,
    { method: 'PUT', body },
  ),
  saveAgentEgressPolicy: (token, body) => request(
    token,
    `${ADMIN_ROOT}/agent/proxies/default`,
    { method: 'PUT', body },
  ),
  updateAgentPipeline: (token, pipelineKey, body) => request(
    token,
    `${ADMIN_ROOT}/agent/pipelines/${encodeURIComponent(pipelineKey)}`,
    { method: 'PUT', body },
  ),
  materializeAgentPipeline: (token, pipelineKey) => request(
    token,
    `${ADMIN_ROOT}/agent/pipelines/${encodeURIComponent(pipelineKey)}/materialize`,
    { method: 'POST' },
  ),
  retryDeadAgentPipeline: (token, pipelineKey) => request(
    token,
    `${ADMIN_ROOT}/agent/pipelines/${encodeURIComponent(pipelineKey)}/retry-dead`,
    { method: 'POST' },
  ),
  retrieval: (token) => request(token, `${ADMIN_ROOT}/retrieval`),
  semanticSearch: (token, body) => request(token, `${ADMIN_ROOT}/retrieval/search`, { method: 'POST', body }),
  runtime: (token) => request(
    token,
    `${ADMIN_ROOT}/runtime`,
    { query: { presentation: 'safe' } },
  ),
}
