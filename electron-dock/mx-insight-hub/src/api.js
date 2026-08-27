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
  // Unauthenticated: the console needs to know how to sign in before it can.
  signInOptions: () => fetch(`${API_BASE}${ADMIN_ROOT}/sign-in-options`)
    .then(parsePayload)
    .then((payload) => payload?.data ?? { adminToken: true, launcher: null })
    .catch(() => ({ adminToken: true, launcher: null })),
  dashboard: (token) => request(token, `${ADMIN_ROOT}/dashboard`),
  tenants: (token) => request(token, `${ADMIN_ROOT}/tenants`),
  createTenant: (token, body) => request(token, `${ADMIN_ROOT}/tenants`, { method: 'POST', body }),
  renameTenant: (token, id, body) => request(token, `${ADMIN_ROOT}/tenants/${encodeURIComponent(id)}`, { method: 'PUT', body }),
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
  updateCapability: (token, capability, body) => request(
    token,
    `${ADMIN_ROOT}/capabilities/${encodeURIComponent(capability)}`,
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
  fileFormatRules: (token) => request(token, `${ADMIN_ROOT}/file-format-rules`),
  listServerFileRoots: (token) => request(token, `${ADMIN_ROOT}/server-file-roots`),
  dataCenter: (token, query = {}) => request(token, `${ADMIN_ROOT}/data-center`, { query }),
  dataCenterRecords: (token, query = {}) => request(token, `${ADMIN_ROOT}/data-center/records`, { query }),
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
  sourceCatalog: (token, { includeArchived = false } = {}) => request(
    token,
    `${ADMIN_ROOT}/source-catalog`,
    { query: { includeArchived: includeArchived || undefined } },
  ),
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
  sourceCatalogEvents: (token, id, limit = 50) => request(
    token,
    `${ADMIN_ROOT}/source-catalog/${encodeURIComponent(id)}/events`,
    { query: { limit } },
  ),
  sourceCatalogRelatedData: (token, id, { pageSize = 20 } = {}) => request(
    token,
    `${ADMIN_ROOT}/source-catalog/${encodeURIComponent(id)}/related-data`,
    { query: { pageSize } },
  ),
  sourceCatalogTaxonomy: (token, { includeArchived = false, kind } = {}) => request(
    token,
    `${ADMIN_ROOT}/source-catalog/taxonomy`,
    { query: { includeArchived: includeArchived || undefined, kind } },
  ),
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
  resumeProvinceOpinionPipeline: (token) => request(
    token, `${ADMIN_ROOT}/pipelines/province-opinion/resume`, { method: 'POST' },
  ),
  resetProvinceOpinionPipelineCheckpoint: (token, body) => request(
    token, `${ADMIN_ROOT}/pipelines/province-opinion/checkpoint/reset`, { method: 'POST', body },
  ),

  // Backfill (P3), agent (P5) and retrieval (embedding pipeline).
  backfill: (token) => request(token, `${ADMIN_ROOT}/backfill`),
  startBackfill: (token, body) => request(token, `${ADMIN_ROOT}/backfill`, { method: 'POST', body }),
  agent: (token) => request(token, `${ADMIN_ROOT}/agent`),
  updateAgentProviders: (token, kind, body) => request(
    token,
    `${ADMIN_ROOT}/agent/providers/${encodeURIComponent(kind)}`,
    { method: 'PUT', body },
  ),
  testAgentProvider: (token, kind, providerId) => request(
    token,
    `${ADMIN_ROOT}/agent/providers/${encodeURIComponent(kind)}/${encodeURIComponent(providerId)}/test`,
    { method: 'POST' },
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
  runtime: (token) => Promise.all([
    health(token, '/health/live'),
    health(token, '/health/ready'),
    health(token, '/health/dependencies'),
  ]).then(([live, ready, dependencies]) => ({ live, ready, dependencies })),
}
