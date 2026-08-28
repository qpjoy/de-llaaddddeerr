import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { secureEqual } from './core/crypto.mjs'
import { AppError } from './core/errors.mjs'
import { bearerToken, publicApiKey, readBuffer, readJson, routeMatch, sendJson } from './core/http.mjs'
import {
  PUBLIC_DOCS_LEGACY_ROUTE_SCRIPT,
  PUBLIC_OPENAPI_DOCUMENT,
  publicDocsHtmlForPath,
  publicDocsRedirectForPath,
} from './public-docs.mjs'
import { publicStoredSearchItem } from './data/stored-search.mjs'
import { normalizeChinaProvince } from './data/china-provinces.mjs'
import { ADVANCED_SEARCH_AGENT_KEY } from '../agent-market/advanced-search/schemas.ts'
import { runAdvancedSearchDryRun } from './agent-market/runner.ts'
import { builtinAdvancedSearchSnapshot } from './agent-market/store.ts'
import {
  normalizeSourceCatalogCreate,
  normalizeSourceCatalogOwnerCreate,
  normalizeSourceCatalogOwnerPatch,
  normalizeSourceCatalogPatch,
  normalizeSourceCatalogTermCreate,
  normalizeSourceCatalogTermPatch,
  SOURCE_CATALOG_TERM_KINDS,
  sourceCatalogId,
  sourceCatalogOwnerId,
  sourceCatalogOwnerSnapshot,
  sourceCatalogRevision,
  sourceCatalogSnapshot,
  sourceCatalogTermId,
  sourceCatalogTermSnapshot,
} from './data/source-catalog.mjs'

import { validateFieldMap } from './ingest/external/mapping.mjs'
import {
  BUILTIN_FILE_FORMAT_RULES,
  builtinFileFormatRule,
} from './ingest/external/builtin-format-rules.mjs'
import {
  fingerprintFileStructure,
  normalizeStructureColumnName,
} from './ingest/external/importer.mjs'
import { validateDatabaseConnection } from './ingest/external/database-source.mjs'
import {
  isTelegramMonitorSourceKey,
  TelegramMonitorPipeline,
} from './ingest/telegram/monitor-pipeline.mjs'
import {
  isTelegramSQLiteSourceKey,
  TelegramSQLitePipeline,
} from './ingest/telegram/sqlite-pipeline.mjs'
import {
  isProvinceOpinionSourceKey,
  ProvinceOpinionPipeline,
} from './ingest/province/monitor-pipeline.mjs'
import {
  adminTokenPrincipal,
  filterByTenantCapability,
  requireCapability,
  requirePlatformAdmin,
  requireTenantCapability,
  scopeTenantCapability,
} from './identity/index.mjs'
import {
  publicSearchProfile,
  resolveSearchProfile,
  searchCapabilities,
} from './search/profiles.mjs'

const PUBLIC_DOCS_SCRIPT_HASH = createHash('sha256')
  .update(PUBLIC_DOCS_LEGACY_ROUTE_SCRIPT)
  .digest('base64')

function queryFilters(searchParams) {
  return {
    tenantId: searchParams.get('tenantId') || undefined,
    consumerId: searchParams.get('consumerId') || undefined,
    from: searchParams.get('from') || undefined,
    to: searchParams.get('to') || undefined,
  }
}

function adminCredential(request) {
  const value = request.headers['x-mx-insight-admin-token']
  return (typeof value === 'string' && value) || bearerToken(request)
}

// Combine all tenant summaries in one pass. Store averages are weighted by
// committed requests, so released/unknown traffic must not dilute latency here.
function mergeUsageSummaries(summaries) {
  const merged = {
    requests: 0,
    committed: 0,
    released: 0,
    unknown: 0,
    units: 0,
    averageUpstreamLatencyMs: null,
    byPlatform: {},
    byCapability: {},
  }
  let weightedLatency = 0
  let latencyCommitted = 0

  for (const summary of summaries) {
    merged.requests += summary.requests || 0
    merged.committed += summary.committed || 0
    merged.released += summary.released || 0
    merged.unknown += summary.unknown || 0
    merged.units += summary.units || 0

    if (summary.averageUpstreamLatencyMs != null && summary.committed > 0) {
      weightedLatency += summary.averageUpstreamLatencyMs * summary.committed
      latencyCommitted += summary.committed
    }

    for (const dimension of ['byPlatform', 'byCapability']) {
      for (const [scope, entry] of Object.entries(summary[dimension] || {})) {
        const existing = merged[dimension][scope]
        merged[dimension][scope] = existing
          ? {
              requests: existing.requests + entry.requests,
              committed: existing.committed + entry.committed,
              released: existing.released + entry.released,
              unknown: existing.unknown + entry.unknown,
              units: existing.units + entry.units,
            }
          : { ...entry }
      }
    }
  }

  merged.averageUpstreamLatencyMs = latencyCommitted > 0
    ? Math.round(weightedLatency / latencyCommitted)
    : null
  return merged
}

function requiredField(body, name) {
  const value = body?.[name]
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(400, 'invalid_request', `${name} is required`)
  }
  return value.trim()
}

function requiredSourceKey(body) {
  const sourceKey = requiredField(body, 'sourceKey')
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(sourceKey)) {
    throw new AppError(
      400,
      'invalid_source_key',
      'sourceKey must be 1-128 lowercase letters, digits, dots, underscores, or hyphens',
    )
  }
  return sourceKey
}

function dataCenterCursorBinding({
  query, datasetId, platform, objectType, relatedProvince = null, provinceRelation = null,
  pageSize, searchProfile = null, sort = null,
}) {
  return createHash('sha256')
    .update(JSON.stringify({
      query, datasetId, platform, objectType, relatedProvince, provinceRelation, pageSize,
      ...(searchProfile ? { searchProfile } : {}),
      // The sort is part of what a cursor means. Without it, flipping the order
      // and paging on would resume from a position computed under the old one.
      ...(sort ? { sort } : {}),
    }))
    .digest('base64url')
}

function encodeDataCenterCursor(kind, cursor, binding) {
  if (!cursor) return null
  return Buffer.from(JSON.stringify({ v: 1, kind, binding, cursor }), 'utf8').toString('base64url')
}

function decodeDataCenterCursor(value, kind, binding) {
  if (!value) return null
  if (typeof value !== 'string' || value.length > 16_384) {
    throw new AppError(400, 'invalid_cursor', 'cursor is invalid')
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (parsed?.v !== 1 || parsed.kind !== kind || parsed.binding !== binding || !parsed.cursor) {
      throw new Error('cursor binding mismatch')
    }
    if (kind === 'browse') {
      if (typeof parsed.cursor.sortTime !== 'string'
        || Number.isNaN(new Date(parsed.cursor.sortTime).getTime())
        || typeof parsed.cursor.id !== 'string') {
        throw new Error('invalid browse cursor')
      }
    } else if (!['elasticsearch', 'postgres'].includes(parsed.cursor.mode)) {
      throw new Error('invalid search cursor')
    }
    return parsed.cursor
  } catch {
    throw new AppError(400, 'invalid_cursor', 'cursor is invalid or belongs to different filters')
  }
}

function dataCenterCursorState(cursor) {
  if (!cursor) return { cursor: null, page: 1 }
  const { page: encodedPage, ...value } = cursor
  return {
    cursor: value,
    page: Number.isSafeInteger(encodedPage) && encodedPage >= 2 ? encodedPage : 2,
  }
}

function dataCenterTotal(value) {
  if (value == null) return null
  const total = Number(value)
  return Number.isSafeInteger(total) && total >= 0 ? total : null
}

const DATA_CENTER_SEARCH_RESULT_WINDOW = 10_000

function dataCenterPageInfo({ page, pageSize, total, hasMore, nextCursor, maxDirectPage = null }) {
  return {
    page,
    pageSize,
    total,
    totalPages: total == null ? null : Math.max(1, Math.ceil(total / pageSize)),
    hasMore,
    nextCursor,
    ...(maxDirectPage == null ? {} : { maxDirectPage }),
  }
}

function assertGenericSourceMutable(sourceKey) {
  if (
    !isTelegramMonitorSourceKey(sourceKey)
    && !isTelegramSQLiteSourceKey(sourceKey)
    && !isProvinceOpinionSourceKey(sourceKey)
  ) return
  const pipeline = isTelegramSQLiteSourceKey(sourceKey)
    ? 'telegram-sqlite'
    : isProvinceOpinionSourceKey(sourceKey)
      ? 'province-opinion'
      : 'telegram-monitor'
  throw new AppError(
    409,
    'pipeline_managed_source',
    `This fixed source is managed through /internal/v1/admin/pipelines/${pipeline}`,
  )
}

function adminSourceView(source) {
  if (source?.sourceKind !== 'sqlite_api') return source
  const { token, ...connection } = source.connection || {}
  return {
    ...source,
    connection: {
      ...connection,
      tokenConfigured: typeof token === 'string' && token.length > 0,
    },
  }
}

// Best-effort client address for rate limiting and for forwarding upstream.
// The proxy header is trusted only because this plane sits behind a controlled
// edge; on a directly exposed listener it would be attacker-controlled.
function clientAddress(request) {
  const forwarded = request.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim()
  return request.socket?.remoteAddress || null
}

// Fixed-window throttle on sign-in attempts, per client address.
//
// Launcher already rate-limits, but proxying means it sees the Hub's address
// rather than the caller's, so its per-source limit would either be useless or
// lock out every user at once. This keeps the Hub from becoming an amplifier
// regardless of how the upstream treats the forwarded header.
const SIGN_IN_WINDOW_MS = 60_000
const SIGN_IN_MAX_ATTEMPTS = 10
const signInAttempts = new Map()

function assertSignInAllowed(clientIp) {
  const key = clientIp || 'unknown'
  const now = Date.now()
  const entry = signInAttempts.get(key)
  if (!entry || now - entry.startedAt > SIGN_IN_WINDOW_MS) {
    signInAttempts.set(key, { startedAt: now, count: 1 })
    // Bound the map so a spray of source addresses cannot grow it without limit.
    if (signInAttempts.size > 10_000) {
      for (const [candidate, value] of signInAttempts) {
        if (now - value.startedAt > SIGN_IN_WINDOW_MS) signInAttempts.delete(candidate)
      }
    }
    return
  }
  entry.count += 1
  if (entry.count > SIGN_IN_MAX_ATTEMPTS) {
    throw new AppError(429, 'too_many_attempts', 'Too many sign-in attempts; try again in a minute')
  }
}

function requiredQuery(searchParams, name) {
  const value = searchParams.get(name)
  if (!value) throw new AppError(400, 'invalid_request', `${name} query parameter is required`)
  return value
}

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

async function serveSpa(pathname, response, staticRoot) {
  if (!staticRoot) return false
  const normalizedPath = normalize(decodeURIComponent(pathname)).replace(/^(\.\.(\/|\\|$))+/, '')
  const relativePath = normalizedPath === '/' ? 'index.html' : normalizedPath.replace(/^[/\\]/, '')
  const candidates = [join(staticRoot, relativePath)]
  if (!extname(relativePath)) candidates.push(join(staticRoot, 'index.html'))
  for (const candidate of candidates) {
    try {
      const body = await readFile(candidate)
      response.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(candidate)] || 'application/octet-stream',
        'content-length': body.length,
      })
      response.end(body)
      return true
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'EISDIR') throw error
    }
  }
  return false
}

export function createApp({
  service,
  store,
  adapter,
  adminToken,
  identity = null,
  queue = null,
  backfillPlatforms = [],
  importer = null,
  serverFileReader = null,
  databasePuller = null,
  sqliteApiPuller = null,
  telegramSourcePreparer = null,
  agent = null,
  agentPipelines = null,
  agentMarket = null,
  search = null,
  searchReindex = null,
  embedding = null,
  segmenterConfig = null,
  launcherAudience = 'mx-insight-hub',
  listenerMode = 'combined',
  staticRoot,
  logger = console,
}) {
  const telegramMonitorPipeline = new TelegramMonitorPipeline({
    store,
    queue,
    databasePuller,
    sourcePreparer: telegramSourcePreparer,
  })
  const telegramSQLitePipeline = new TelegramSQLitePipeline({
    store,
    queue,
    sqliteApiPuller,
  })
  const provinceOpinionPipeline = new ProvinceOpinionPipeline({
    store,
    queue,
    databasePuller,
    agentPipelineStore: agentPipelines,
    segmenterConfig,
  })

  /**
   * Resolve the caller of an administrative route.
   *
   * Order matters and is not arbitrary: the admin token is checked first, with a
   * constant-time comparison, and only a credential that is *not* the admin
   * token is offered to Launcher. That keeps the break-glass path completely
   * independent of Launcher's availability — an operator holding the admin token
   * gets in whether or not the identity provider is reachable.
   */
  async function resolvePrincipal(request) {
    const credential = adminCredential(request)
    if (!credential) {
      if (typeof request.headers['x-api-key'] === 'string' && request.headers['x-api-key'].trim()) {
        throw new AppError(403, 'admin_token_required', 'Only the Hub admin token may manage external data sources')
      }
      throw new AppError(401, 'admin_auth_required', 'Admin token or Launcher session is required')
    }
    // The `adminToken &&` guard is load-bearing: secureEqual stringifies its
    // arguments, so a null admin token would compare equal to the literal
    // credential "null".
    if (adminToken && secureEqual(credential, adminToken)) return adminTokenPrincipal()
    if (credential.startsWith('mih_live_') || credential.startsWith('mih_test_')) {
      throw new AppError(403, 'admin_token_required', 'Only the Hub admin token may manage external data sources')
    }

    if (!identity?.enabled) {
      throw new AppError(401, 'admin_auth_required', 'Valid admin token is required')
    }
    const principal = await identity.resolve(credential)
    if (!principal) {
      throw new AppError(401, 'invalid_session', 'Session is invalid, expired, or revoked')
    }
    return principal
  }

  async function requirePublic(request) {
    return service.authenticate(publicApiKey(request))
  }

  // Usage for exactly the tenants a principal may see. An unscoped principal
  // passes straight through to the existing platform-wide query.
  async function scopedUsageFor(principal, filters) {
    const scope = scopeTenantCapability(principal, filters.tenantId ?? null, 'usage.read')
    if (!Array.isArray(scope)) {
      return service.usage({ ...filters, tenantId: scope || undefined })
    }
    const results = await Promise.all(
      scope.map((tenantId) => service.usage({ ...filters, tenantId })),
    )
    return mergeUsageSummaries(results)
  }

  async function scopedDashboardFor(principal) {
    const scope = scopeTenantCapability(principal, null, 'usage.read')
    if (!Array.isArray(scope)) return service.dashboard()

    const allowedTenantIds = new Set(scope)
    const [usage, tenants, consumers, apiKeys] = await Promise.all([
      scopedUsageFor(principal, {}),
      service.listTenants(),
      service.listConsumers(),
      service.listApiKeys(),
    ])
    return {
      tenants: tenants.filter((tenant) => allowedTenantIds.has(tenant.id)).length,
      consumers: consumers.filter((consumer) => allowedTenantIds.has(consumer.tenantId)).length,
      activeApiKeys: apiKeys.filter((key) => (
        allowedTenantIds.has(key.tenantId) && (key.effectiveStatus || key.status) === 'active'
      )).length,
      ...usage,
    }
  }

  // Resolve a consumer's owning tenant before acting on it. The tenant is never
  // taken from the request body: a caller who could name the tenant could name
  // one they are entitled to and still address a consumer in another.
  async function assertConsumerCapability(principal, consumerId, capability) {
    if (!consumerId || principal.platformAdmin) return
    const consumer = await store.getConsumer(consumerId)
    if (!consumer) throw new AppError(404, 'consumer_not_found', 'Consumer not found')
    requireTenantCapability(principal, consumer.tenantId, capability)
  }

  async function assertApiKeyCapability(principal, apiKeyId, capability) {
    if (principal.platformAdmin) return
    const keys = await service.listApiKeys()
    const key = keys.find((candidate) => candidate.id === apiKeyId)
    if (!key) throw new AppError(404, 'api_key_not_found', 'API key not found')
    requireTenantCapability(principal, key.tenantId, capability)
  }

  async function requireSource(sourceKey) {
    const source = await store.getExternalSource(sourceKey)
    if (!source) throw new AppError(404, 'source_not_found', `Unknown external source: ${sourceKey}`)
    return source
  }

  async function fileFormatRuleCatalog() {
    const persisted = typeof store.listFileFormatRules === 'function'
      ? await store.listFileFormatRules()
      : []
    const byKey = new Map(BUILTIN_FILE_FORMAT_RULES.map((rule) => [rule.ruleKey, {
      ...rule,
      versions: [],
    }]))
    for (const rule of persisted || []) {
      if (!rule?.ruleKey) continue
      const builtin = byKey.get(rule.ruleKey)
      byKey.set(rule.ruleKey, {
        ...(builtin || {}),
        ...rule,
        builtIn: Boolean(builtin?.builtIn || rule.builtIn),
        inputFormats: [...new Set([
          ...(builtin?.inputFormats || []),
          ...(rule.inputFormats || []),
          ...(rule.inputFormat ? [rule.inputFormat] : []),
        ])].sort(),
        versions: rule.versions || builtin?.versions || [],
      })
    }
    return [...byKey.values()].sort((left, right) => (
      String(left.platform).localeCompare(String(right.platform))
      || String(left.displayName || left.ruleKey).localeCompare(String(right.displayName || right.ruleKey))
    ))
  }

  async function resolveFileFormatRule(ruleKey) {
    if (ruleKey == null || ruleKey === '') return null
    if (typeof ruleKey !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(ruleKey)) {
      throw new AppError(400, 'invalid_file_format_rule', 'preferredRuleKey must name a valid file format rule')
    }
    const rule = (await fileFormatRuleCatalog()).find((candidate) => candidate.ruleKey === ruleKey)
    if (!rule) throw new AppError(400, 'unknown_file_format_rule', `Unknown file format rule: ${ruleKey}`)
    return rule
  }

  function requireSourceAdmin(principal) {
    if (principal?.kind !== 'admin-token') {
      throw new AppError(403, 'admin_token_required', 'Only the Hub admin token may manage external data sources')
    }
  }

  function requireAgentAdmin(principal) {
    if (principal?.kind !== 'admin-token') {
      throw new AppError(403, 'admin_token_required', 'Only the Hub admin token may change model providers')
    }
  }

  function requireAgentMarketAdmin(principal) {
    if (principal?.kind !== 'admin-token') {
      throw new AppError(403, 'admin_token_required', 'Only the Hub admin token may save or run Agent Market drafts')
    }
  }

  function requireImporter() {
    if (!importer) {
      throw new AppError(503, 'importer_unavailable', 'External imports require the PostgreSQL store')
    }
  }

  function requireServerFileReader() {
    if (!serverFileReader) {
      throw new AppError(503, 'server_file_reader_unavailable', 'Server file reads are unavailable on this listener')
    }
    return serverFileReader
  }

  function requireServerPathSource(source) {
    if (source.sourceKind !== 'file' || source.connection?.fileMode !== 'server_path') {
      throw new AppError(400, 'wrong_source_kind', 'This operation requires a server-path file source')
    }
  }

  async function readServerSourceFile(source, serverPath) {
    requireServerPathSource(source)
    const reader = requireServerFileReader()
    if (serverPath != null && typeof serverPath !== 'string') {
      throw new AppError(400, 'invalid_server_file_path', 'serverPath must be a string')
    }
    if (typeof serverPath === 'string' && serverPath.trim()) {
      return reader.readInput(serverPath.trim())
    }
    return reader.readLocator({
      rootId: source.connection?.rootId,
      relativePath: source.connection?.relativePath,
    })
  }

  function filePathHash(file) {
    return createHash('sha256')
      .update(`${file.rootId}\0${file.relativePath}`)
      .digest('hex')
  }

  function adaptFormatRuleFieldMap(fieldMap, columns) {
    const exactByNormalized = new Map()
    for (const column of columns) {
      const normalized = normalizeStructureColumnName(column)
      if (exactByNormalized.has(normalized)) return null
      exactByNormalized.set(normalized, column)
    }
    const adapted = {}
    for (const [target, rule] of Object.entries(fieldMap || {})) {
      const sources = Array.isArray(rule.from) ? rule.from : [rule.from]
      const currentSources = sources.map((sourceColumn) => (
        exactByNormalized.get(normalizeStructureColumnName(sourceColumn))
      ))
      if (currentSources.some((sourceColumn) => !sourceColumn)) return null
      adapted[target] = {
        ...rule,
        from: Array.isArray(rule.from) ? currentSources : currentSources[0],
      }
    }
    return adapted
  }

  async function previewWithSuggestion({
    source,
    buffer,
    filename,
    agentRequested,
    preferredRuleKey = null,
  }) {
    const preview = await importer.preview(buffer, filename)
    const requestedRule = preferredRuleKey || source?.connection?.preferredRuleKey || null
    const requestedDefinition = requestedRule ? await resolveFileFormatRule(requestedRule) : null
    const requestedBuiltin = requestedRule ? builtinFileFormatRule(requestedRule) : null
    if (requestedRule && requestedBuiltin && preview.builtinFormatRule?.ruleKey !== requestedRule) {
      throw new AppError(409, 'file_format_rule_mismatch', 'The selected built-in rule does not match this file structure and sampled platform evidence')
    }
    if (requestedDefinition) {
      const scopeMatches = !source || (
        source.datasetId === requestedDefinition.datasetId
        && source.platform === requestedDefinition.platform
        && source.objectType === requestedDefinition.objectType
      )
      const inputFormatMatches = !requestedDefinition.inputFormats?.length
        || requestedDefinition.inputFormats.includes(preview.fileStructure?.format)
      if (!scopeMatches || !inputFormatMatches) {
        throw new AppError(409, 'file_format_rule_mismatch', 'The selected rule does not match this source scope or input format')
      }
    }
    let matchedFormatRule = !requestedRule && source && typeof store.findApprovedFileFormatRule === 'function'
      ? await store.findApprovedFileFormatRule({
          schemaFingerprint: preview.schemaFingerprint,
          datasetId: source.datasetId,
          platform: source.platform,
          objectType: source.objectType,
        })
      : null
    if (matchedFormatRule) {
      const adaptedFieldMap = adaptFormatRuleFieldMap(matchedFormatRule.fieldMap, preview.columns)
      matchedFormatRule = adaptedFieldMap
        ? { ...matchedFormatRule, fieldMap: adaptedFieldMap }
        : null
    }
    let selectedFormatRule = matchedFormatRule
    if (requestedRule && typeof store.findApprovedFileFormatRuleByKey === 'function') {
      const selected = await store.findApprovedFileFormatRuleByKey({
        ruleKey: requestedRule,
        schemaFingerprint: preview.schemaFingerprint,
        datasetId: source?.datasetId ?? requestedDefinition?.datasetId ?? null,
        platform: source?.platform ?? requestedDefinition?.platform ?? null,
        objectType: source?.objectType ?? requestedDefinition?.objectType ?? null,
      })
      if (selected) {
        const adaptedFieldMap = adaptFormatRuleFieldMap(selected.fieldMap, preview.columns)
        if (!adaptedFieldMap) {
          throw new AppError(409, 'file_format_rule_mismatch', 'The selected rule cannot be adapted to this file columns')
        }
        selectedFormatRule = { ...selected, fieldMap: adaptedFieldMap }
      } else {
        // A logical rule may receive a new immutable version when its schema
        // changes. The new mapping still requires explicit human approval.
        selectedFormatRule = {
          ...requestedDefinition,
          // Only code-owned built-ins have a mapping that is valid before an
          // exact immutable version exists. A generic logical rule needs Agent
          // or deterministic inference for its new schema.
          fieldMap: requestedBuiltin?.fieldMap ?? null,
        }
      }
    }
    if (!selectedFormatRule && preview.builtinFormatRule) {
      const definition = builtinFileFormatRule(preview.builtinFormatRule.ruleKey)
      const sourceScopeMatches = !source || (
        source.datasetId === definition.datasetId
        && source.platform === definition.platform
        && source.objectType === definition.objectType
      )
      if (sourceScopeMatches) {
        selectedFormatRule = {
          ...definition,
          inputFormat: preview.builtinFormatRule.inputFormat,
          fieldMap: preview.builtinFormatRule.fieldMap,
        }
      }
    }
    const valueFreeSampling = preview.sampling
      ? { ...preview.sampling, items: undefined }
      : null
    const agentSuggestion = !selectedFormatRule?.fieldMap && agentRequested
      ? typeof agent?.suggestFileProfile === 'function'
        ? await agent.suggestFileProfile({ columns: preview.columns, sampling: valueFreeSampling })
        : typeof agent?.suggestFieldMap === 'function'
          ? await agent.suggestFieldMap({ columns: preview.columns, sampleRows: [] })
          : {
              fieldMap: preview.inferredFieldMap,
              origin: 'inferred',
              model: null,
              confidence: null,
            }
      : null
    const suggestion = selectedFormatRule?.fieldMap
      ? {
          fieldMap: selectedFormatRule.fieldMap,
          origin: 'format_rule',
          model: null,
          confidence: null,
        }
      : agentRequested
        ? agentSuggestion
        : {
            fieldMap: preview.inferredFieldMap,
            origin: 'inferred',
            model: null,
            confidence: null,
          }
    return {
      ...preview,
      matchedFormatRule,
      selectedFormatRule,
      suggestion: suggestion ?? null,
      detection: {
        ...preview.detection,
        platform: selectedFormatRule?.platform || agentSuggestion?.platform || preview.detection?.platform || null,
        objectType: selectedFormatRule?.objectType || agentSuggestion?.objectType || preview.detection?.objectType || null,
        ruleKey: selectedFormatRule?.ruleKey || preview.detection?.ruleKey || null,
        displayName: selectedFormatRule?.displayName || preview.builtinFormatRule?.displayName || null,
        confidence: selectedFormatRule?.fieldMap || preview.builtinFormatRule ? 1 : null,
        method: requestedRule
          ? 'explicit-rule'
          : selectedFormatRule
            ? 'structure-rule'
            : agentSuggestion?.origin === 'agent'
              ? 'agent-structure-summary'
              : 'deterministic-structure',
      },
      agentRequested,
      agentDataScope: agentRequested && !selectedFormatRule?.fieldMap ? 'column_names_and_value_shapes' : 'none',
    }
  }

  function requireFileImportLock() {
    if (typeof databasePuller?.withSourceLocks !== 'function') {
      throw new AppError(503, 'source_lock_unavailable', 'File imports require the PostgreSQL source-lock session')
    }
  }

  function requireDatabasePuller() {
    if (!databasePuller || !queue) {
      throw new AppError(503, 'database_pull_unavailable', 'Database source pulls require the PostgreSQL store')
    }
  }

  function requireDatabaseSourceTester() {
    if (typeof databasePuller?.testSource !== 'function') {
      throw new AppError(503, 'source_validation_unavailable', 'Database source testing requires the PostgreSQL workload')
    }
  }

  function requireSQLiteApiPuller() {
    if (!sqliteApiPuller || !queue) {
      throw new AppError(503, 'sqlite_api_pull_unavailable', 'SQLite API pulls require the PostgreSQL store')
    }
  }

  function requireExternalQueue() {
    if (!queue) {
      throw new AppError(503, 'external_queue_unavailable', 'External source status requires the PostgreSQL queue')
    }
  }

  function pullerForSource(source) {
    if (source.sourceKind === 'database') {
      if (!databasePuller) {
        throw new AppError(503, 'database_pull_unavailable', 'Database source pulls require the PostgreSQL store')
      }
      return databasePuller
    }
    if (source.sourceKind === 'sqlite_api') {
      requireSQLiteApiPuller()
      return sqliteApiPuller
    }
    throw new AppError(400, 'wrong_source_kind', 'This operation requires a database or SQLite API source')
  }

  async function withSourceLocks(keys, operation) {
    const unique = [...new Set((keys || []).filter(Boolean))]
    if (unique.length === 0 || typeof databasePuller?.withSourceLocks !== 'function') return operation()
    return databasePuller.withSourceLocks(unique, operation)
  }

  async function dependencies() {
    const result = { store: { status: 'down' }, nightAll: { status: 'down' } }
    try {
      await store.ping()
      result.store = { status: 'up' }
    } catch (error) {
      result.store = { status: 'down', detail: error.name }
    }
    result.nightAll = await adapter.dependencies()
    return result
  }

  return async function app(request, response) {
    const requestId = request.headers['x-request-id'] || randomUUID()
    response.setHeader('x-request-id', requestId)
    try {
      const url = new URL(request.url, 'http://localhost')
      const { pathname, searchParams } = url
      const isAdminPath = pathname.startsWith('/internal/v1/admin/') || pathname.startsWith('/internal/v1/ops/')
      const isPublicPath = pathname.startsWith('/api/v1/')
      // Listener isolation must run before unauthenticated sign-in routes. The
      // public listener previously exposed both sign-in endpoints because their
      // handlers appeared before this guard.
      if ((listenerMode === 'public' && isAdminPath) || (listenerMode === 'admin' && isPublicPath)) {
        throw new AppError(404, 'not_found', 'Route not found')
      }

      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'authorization, content-type, idempotency-key, x-api-key, x-mx-insight-admin-token',
          'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        })
        response.end()
        return
      }

      // Unauthenticated by necessity: the console has to know how to sign in
      // before it can. Reveals only the Launcher address and audience, both of
      // which a user needs anyway to authenticate and neither of which is
      // secret. No Hub state is exposed.
      if (request.method === 'GET' && pathname === '/internal/v1/admin/sign-in-options') {
        // When Launcher sign-in is unavailable, say WHICH half is missing. The
        // two causes need different fixes and look identical from the login
        // page: an absent provider URL means Launcher was never discovered, an
        // absent public URL means it was discovered but the browser has no way
        // to reach it.
        // Sign-in goes through this server, so the browser needs no address of
        // its own for Launcher -- which is the whole point: Launcher is only
        // reachable on the internal network, and the console is not.
        const available = Boolean(identity?.enabled)
        sendJson(response, 200, {
          data: {
            adminToken: true,
            launcher: available ? { audience: launcherAudience, mode: 'proxied' } : null,
            ...(available
              ? {}
              : {
                  launcherUnavailableReason:
                    'MX_INSIGHT_LAUNCHER_URL is not set and no mx-launcher Service was discovered',
                }),
          },
          requestId,
        })
        return
      }

      // Sign-in proxy. Unauthenticated by definition: it is how a session is
      // obtained. The password is forwarded to Launcher and never stored,
      // logged or cached here.
      if (request.method === 'POST' && pathname === '/internal/v1/admin/sign-in') {
        if (!identity?.enabled) {
          throw new AppError(503, 'launcher_not_configured', 'Launcher sign-in is not configured')
        }
        const clientIp = clientAddress(request)
        // A local throttle so the Hub cannot be used to amplify attempts
        // against Launcher, independently of Launcher's own limits.
        assertSignInAllowed(clientIp)
        const body = await readJson(request)
        const issued = await identity.client.signIn({
          username: requiredField(body, 'username'),
          password: requiredField(body, 'password'),
          clientIp,
        })
        sendJson(response, 200, { data: issued, requestId })
        return
      }

      if (request.method === 'GET' && (pathname === '/health' || pathname === '/health/live')) {
        sendJson(response, 200, { data: { status: 'live' }, requestId })
        return
      }
      if (request.method === 'GET' && pathname === '/health/dependencies') {
        if (listenerMode === 'public') throw new AppError(404, 'not_found', 'Route not found')
        const data = await dependencies()
        sendJson(response, 200, { data, requestId })
        return
      }
      if (request.method === 'GET' && pathname === '/health/ready') {
        const data = await dependencies()
        const requiredDependencies = listenerMode === 'admin' ? [data.store] : Object.values(data)
        const ready = requiredDependencies.every((entry) => entry.status === 'up')
        const readiness = {
          status: ready ? 'ready' : 'not_ready',
          ...(listenerMode === 'public' ? {} : { dependencies: data }),
        }
        sendJson(response, ready ? 200 : 503, { data: readiness, requestId })
        return
      }

      const publicDocsRedirect = request.method === 'GET' ? publicDocsRedirectForPath(pathname) : null
      if (publicDocsRedirect !== null) {
        if (listenerMode === 'admin') throw new AppError(404, 'not_found', 'Route not found')
        response.writeHead(308, {
          location: publicDocsRedirect,
          'cache-control': 'public, max-age=300',
          'content-length': '0',
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
        })
        response.end()
        return
      }

      const publicDocsHtml = request.method === 'GET' ? publicDocsHtmlForPath(pathname) : null
      if (publicDocsHtml !== null) {
        if (listenerMode === 'admin') throw new AppError(404, 'not_found', 'Route not found')
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': Buffer.byteLength(publicDocsHtml),
          'cache-control': 'public, max-age=300',
          'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${PUBLIC_DOCS_SCRIPT_HASH}'; base-uri 'none'; frame-ancestors 'none'`,
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
        })
        response.end(publicDocsHtml)
        return
      }
      if (request.method === 'GET' && pathname === '/docs/openapi.json') {
        if (listenerMode === 'admin') throw new AppError(404, 'not_found', 'Route not found')
        sendJson(response, 200, PUBLIC_OPENAPI_DOCUMENT, {
          'cache-control': 'public, max-age=300',
          'access-control-allow-origin': '*',
        })
        return
      }

      let principal = null
      if (isAdminPath) {
        principal = await resolvePrincipal(request)
      }

      // Who am I, and what may I see? The console calls this first and renders
      // itself from the answer, so a scoped user never sees a control they are
      // not allowed to use.
      if (request.method === 'GET' && pathname === '/internal/v1/admin/session') {
        sendJson(response, 200, {
          data: {
            kind: principal.kind,
            memberId: principal.memberId,
            displayName: principal.displayName,
            platformAdmin: principal.platformAdmin,
            scoped: principal.tenantIds !== null,
            tenantIds: principal.tenantIds,
            capabilities: principal.capabilities,
            memberships: principal.memberships,
            identityProvider: identity?.enabled ? 'mx-launcher' : null,
            // Diagnostic pair for federated sessions: what the provider said,
            // and what would have granted platform admin.
            ...(principal.launcherScopes
              ? {
                  launcherScopes: principal.launcherScopes,
                  adminScopeAllowlist: principal.adminScopeAllowlist,
                  adminScopeMatched: principal.launcherScopes.filter((scope) =>
                    principal.adminScopeAllowlist.includes(scope),
                  ),
                }
              : {}),
          },
          requestId,
        })
        return
      }

      if (request.method === 'GET' && pathname === '/internal/v1/admin/dashboard') {
        sendJson(response, 200, { data: await scopedDashboardFor(principal), requestId })
        return
      }
      if (request.method === 'GET' && pathname === '/internal/v1/ops/summary') {
        // Operational summary for Launcher's health proxy: platform-wide by
        // definition, so only either platform-admin identity may read it.
        requirePlatformAdmin(principal)
        sendJson(response, 200, { data: await service.dashboard(), requestId })
        return
      }
      if (request.method === 'GET' && pathname === '/internal/v1/admin/runtime') {
        sendJson(response, 200, {
          data: { listenerMode, dependencies: await dependencies() },
          requestId,
        })
        return
      }
      if (request.method === 'GET' && pathname === '/internal/v1/admin/data-center') {
        requireSourceAdmin(principal)
        const rawPageSize = searchParams.get('pageSize')
        const pageSize = rawPageSize == null || rawPageSize === '' ? 50 : Number(rawPageSize)
        if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
          throw new AppError(400, 'invalid_page_size', 'pageSize must be an integer between 1 and 100')
        }
        const optionalFilter = (name) => searchParams.get(name)?.trim() || null
        const catalog = await store.dataCenter({
          datasetId: optionalFilter('datasetId'),
          platform: optionalFilter('platform'),
          objectType: optionalFilter('objectType'),
          pageSize,
        })
        const capabilities = typeof search?.queries?.searchCapabilities === 'function'
          ? await search.queries.searchCapabilities({ audience: 'admin' })
          : {
              ...searchCapabilities({ audience: 'admin', activeIndexSchema: null }),
              readinessError: 'search_projection_unavailable',
            }
        sendJson(response, 200, {
          data: {
            ...catalog,
            searchCapabilities: capabilities,
          },
          requestId,
        })
        return
      }
      if (
        request.method === 'GET'
        && pathname === '/internal/v1/admin/data-products/telegram/chats'
      ) {
        requireSourceAdmin(principal)
        sendJson(response, 200, {
          data: await service.adminDataProductTelegramChats(
            Object.fromEntries(searchParams.entries()),
          ),
          requestId,
        })
        return
      }
      let params = routeMatch(
        pathname,
        '/internal/v1/admin/data-products/telegram/chats/:chatId/messages',
      )
      if (request.method === 'GET' && params) {
        requireSourceAdmin(principal)
        sendJson(response, 200, {
          data: await service.adminDataProductTelegramMessages(
            params.chatId,
            Object.fromEntries(searchParams.entries()),
          ),
          requestId,
        })
        return
      }
      if (
        request.method === 'POST'
        && pathname === '/internal/v1/admin/data-products/telegram/search'
      ) {
        requireSourceAdmin(principal)
        sendJson(response, 200, {
          data: await service.adminDataProductTelegramSearch(await readJson(request)),
          requestId,
        })
        return
      }
      params = routeMatch(
        pathname,
        '/internal/v1/admin/data-products/telegram/items/:id/context',
      )
      if (request.method === 'GET' && params) {
        requireSourceAdmin(principal)
        sendJson(response, 200, {
          data: await service.adminDataProductTelegramContext(
            params.id,
            Object.fromEntries(searchParams.entries()),
          ),
          requestId,
        })
        return
      }
      if (
        request.method === 'GET'
        && pathname === '/internal/v1/admin/data-products/public-opinion/regions'
      ) {
        requireSourceAdmin(principal)
        sendJson(response, 200, {
          data: await service.adminDataProductPublicOpinionRegions(
            Object.fromEntries(searchParams.entries()),
          ),
          requestId,
        })
        return
      }
      if (
        request.method === 'GET'
        && pathname === '/internal/v1/admin/data-products/public-opinion/province-coverage'
      ) {
        requireSourceAdmin(principal)
        sendJson(response, 200, {
          data: await service.adminDataProductPublicOpinionCoverage(
            Object.fromEntries(searchParams.entries()),
          ),
          requestId,
        })
        return
      }
      if (
        request.method === 'GET'
        && pathname === '/internal/v1/admin/data-products/public-opinion/funnel'
      ) {
        requireSourceAdmin(principal)
        sendJson(response, 200, {
          data: await service.adminDataProductPublicOpinionFunnel(
            Object.fromEntries(searchParams.entries()),
          ),
          requestId,
        })
        return
      }
      if (
        request.method === 'GET'
        && pathname === '/internal/v1/admin/data-products/public-opinion/records'
      ) {
        requireSourceAdmin(principal)
        sendJson(response, 200, {
          data: await service.adminDataProductPublicOpinionBrowse(
            Object.fromEntries(searchParams.entries()),
          ),
          requestId,
        })
        return
      }
      params = routeMatch(
        pathname,
        '/internal/v1/admin/data-products/public-opinion/records/:id',
      )
      if (request.method === 'GET' && params) {
        requireSourceAdmin(principal)
        sendJson(response, 200, {
          data: await service.adminDataProductPublicOpinionBrowseItem(
            params.id,
            Object.fromEntries(searchParams.entries()),
          ),
          requestId,
        })
        return
      }
      params = routeMatch(
        pathname,
        '/internal/v1/admin/data-products/public-opinion/provinces/:province/items',
      )
      if (request.method === 'GET' && params) {
        requireSourceAdmin(principal)
        sendJson(response, 200, {
          data: await service.adminDataProductPublicOpinionProvince(
            params.province,
            Object.fromEntries(searchParams.entries()),
          ),
          requestId,
        })
        return
      }
      params = routeMatch(
        pathname,
        '/internal/v1/admin/data-products/public-opinion/items/:id',
      )
      if (request.method === 'GET' && params) {
        requireSourceAdmin(principal)
        sendJson(response, 200, {
          data: await service.adminDataProductPublicOpinionItem(
            params.id,
            Object.fromEntries(searchParams.entries()),
          ),
          requestId,
        })
        return
      }
      if (request.method === 'GET' && pathname === '/internal/v1/admin/search/reindex') {
        requireSourceAdmin(principal)
        if (!searchReindex) {
          throw new AppError(503, 'search_reindex_unavailable', 'Search reindex requires the PostgreSQL Admin runtime')
        }
        sendJson(response, 200, { data: await searchReindex.status(), requestId })
        return
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/search/reindex') {
        requireSourceAdmin(principal)
        if (!searchReindex) {
          throw new AppError(503, 'search_reindex_unavailable', 'Search reindex requires the PostgreSQL Admin runtime')
        }
        const body = await readJson(request)
        const allowed = new Set(['confirmation', 'acknowledgeBackend'])
        if (body?.confirmation !== 'REINDEX' || Object.keys(body || {}).some((key) => !allowed.has(key))) {
          throw new AppError(
            400,
            'search_reindex_confirmation_required',
            'The request body must be {"confirmation":"REINDEX"} with an optional acknowledgeBackend',
          )
        }
        const data = await searchReindex.start({
          requestedBy: principal.memberId || principal.kind || 'admin-token',
          requestId,
          acknowledgeBackend: body?.acknowledgeBackend ?? null,
        })
        sendJson(response, 202, { data, requestId })
        return
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/search/reindex/cancel') {
        requireSourceAdmin(principal)
        if (!searchReindex) {
          throw new AppError(503, 'search_reindex_unavailable', 'Search reindex requires the PostgreSQL Admin runtime')
        }
        sendJson(response, 200, {
          data: await searchReindex.cancel({
            requestedBy: principal.memberId || principal.kind || 'admin-token',
          }),
          requestId,
        })
        return
      }
      if (request.method === 'PUT' && pathname === '/internal/v1/admin/search/startup-rebuild') {
        requireSourceAdmin(principal)
        if (!searchReindex) {
          throw new AppError(503, 'search_reindex_unavailable', 'Search reindex requires the PostgreSQL Admin runtime')
        }
        const body = await readJson(request)
        if (Object.keys(body || {}).some((key) => key !== 'enabled')) {
          throw new AppError(400, 'unsupported_fields', 'Only enabled is accepted')
        }
        sendJson(response, 200, {
          data: await searchReindex.setStartupRebuild(body?.enabled, {
            requestedBy: principal.memberId || principal.kind || 'admin-token',
          }),
          requestId,
        })
        return
      }
      if (request.method === 'GET' && pathname === '/internal/v1/admin/data-center/records') {
        requireSourceAdmin(principal)
        const rawPageSize = searchParams.get('pageSize')
        const pageSize = rawPageSize == null || rawPageSize === '' ? 50 : Number(rawPageSize)
        if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
          throw new AppError(400, 'invalid_page_size', 'pageSize must be an integer between 1 and 100')
        }
        const rawPage = searchParams.get('page')
        const requestedPage = rawPage == null || rawPage === '' ? null : Number(rawPage)
        if (requestedPage != null && (
          !Number.isSafeInteger(requestedPage)
          || requestedPage < 1
          || !Number.isSafeInteger((requestedPage - 1) * pageSize)
        )) {
          throw new AppError(400, 'invalid_page', 'page must be a positive integer with a safe offset')
        }
        const optionalFilter = (name) => searchParams.get(name)?.trim() || null
        const query = optionalFilter('q')
        if (query && query.length > 500) {
          throw new AppError(400, 'invalid_request', 'q must not exceed 500 characters')
        }
        const requestedOffset = requestedPage == null ? null : (requestedPage - 1) * pageSize
        if (
          query
          && !searchParams.get('relatedProvince')?.trim()
          && requestedOffset != null
          && requestedOffset + pageSize > DATA_CENTER_SEARCH_RESULT_WINDOW
        ) {
          throw new AppError(
            400,
            'search_page_out_of_range',
            `Keyword search direct page jumps are limited to the first ${DATA_CENTER_SEARCH_RESULT_WINDOW} ranked results; narrow the filters or use cursor pagination`,
          )
        }
        const filters = {
          datasetId: optionalFilter('datasetId'),
          platform: optionalFilter('platform'),
          objectType: optionalFilter('objectType'),
        }
        const rawRelatedProvince = optionalFilter('relatedProvince')
        const relatedProvince = rawRelatedProvince
          ? normalizeChinaProvince(rawRelatedProvince)
          : null
        if (rawRelatedProvince && !relatedProvince) {
          throw new AppError(
            400,
            'invalid_related_province',
            'relatedProvince must be a supported ISO 3166-2:CN code or province name',
          )
        }
        const requestedProvinceRelation = optionalFilter('provinceRelation')
        const provinceRelation = requestedProvinceRelation || 'any'
        const provinceRelations = new Set([
          'any', 'event', 'publisher', 'display', 'report', 'recall', 'related', 'canonical',
        ])
        if (!provinceRelations.has(provinceRelation)) {
          throw new AppError(
            400,
            'invalid_province_relation',
            'provinceRelation must be any, event, publisher, display, report, recall, related or canonical',
          )
        }
        if (requestedProvinceRelation && !relatedProvince) {
          throw new AppError(400, 'invalid_request', 'provinceRelation requires relatedProvince')
        }
        // Default to newest-first. A relevance-ranked list under a 时间 column
        // reads as unsorted; ranking is still available, but by choice.
        const sort = optionalFilter('sort') || 'newest'
        if (!['relevance', 'newest', 'oldest'].includes(sort)) {
          throw new AppError(400, 'invalid_sort', "sort must be relevance, newest or oldest")
        }
        if (relatedProvince && sort === 'relevance') {
          throw new AppError(
            400,
            'invalid_sort',
            'relatedProvince uses PostgreSQL canonical truth and supports newest or oldest sorting',
          )
        }
        const requestedSearchProfile = optionalFilter('searchProfile')
        if (!query && requestedSearchProfile) {
          throw new AppError(400, 'invalid_request', 'searchProfile requires a non-blank q')
        }
        const profile = query
          ? resolveSearchProfile(requestedSearchProfile, { audience: 'admin' })
          : null
        if (relatedProvince && requestedSearchProfile) {
          throw new AppError(
            400,
            'invalid_request',
            'searchProfile is not used with relatedProvince; the combined filter uses PostgreSQL substring search',
          )
        }
        const binding = dataCenterCursorBinding({
          query,
          ...filters,
          relatedProvince: relatedProvince?.code ?? null,
          provinceRelation: relatedProvince ? provinceRelation : null,
          pageSize,
          sort,
          searchProfile: relatedProvince ? null : profile?.id ?? null,
        })
        const encodedCursor = optionalFilter('cursor')
        if (requestedPage != null && encodedCursor) {
          throw new AppError(400, 'invalid_request', 'page and cursor cannot be used together')
        }
        if (query && !relatedProvince) {
          if (!search?.queries?.searchContent) {
            throw new AppError(503, 'stored_search_unavailable', 'Data Center search requires the canonical search layer')
          }
          const cursorState = dataCenterCursorState(decodeDataCenterCursor(encodedCursor, 'search', binding))
          const page = requestedPage ?? cursorState.page
          const result = await search.queries.searchContent(query, {
            ...filters,
            sort,
            size: pageSize,
            cursor: cursorState.cursor,
            offset: requestedOffset,
            searchProfile: profile.id,
            trackTotalHits: true,
          })
          let items = result.items
          if (typeof store.dataCenterRecordsByIds === 'function' && result.items.length > 0) {
            const fullRecords = await store.dataCenterRecordsByIds(result.items.map((item) => item.id))
            const fullById = new Map(fullRecords.map((record) => [record.id, record]))
            items = result.items.map((item) => ({
              ...(fullById.get(item.id) || item),
              score: item.score ?? null,
              highlight: item.highlight ?? null,
              matchEvidence: item.matchEvidence ?? [],
            }))
          }
          const total = dataCenterTotal(result.total)
          const maxDirectPage = Math.min(
            total == null ? Number.MAX_SAFE_INTEGER : Math.max(1, Math.ceil(total / pageSize)),
            Math.floor(DATA_CENTER_SEARCH_RESULT_WINDOW / pageSize),
          )
          const publicSample = items.length > 0 ? publicStoredSearchItem(items[0]) : null
          const execution = result.searchExecution || {
            requestedProfile: profile.id,
            appliedProfile: profile.id,
            profile: publicSearchProfile(profile),
            queryAnalysis: {
              tokens: [], tokenCount: 0, truncated: false,
              backendUsed: null, degraded: false, errorCode: null,
            },
            matchedBranches: [],
            warning: profile.warning,
          }
          sendJson(response, 200, {
            data: {
              items,
              mode: result.mode,
              searchExecution: {
                ...execution,
                sample: {
                  request: {
                    query,
                    searchProfile: profile.id,
                    platform: filters.platform,
                    datasetId: filters.datasetId,
                    objectType: filters.objectType,
                    pageSize,
                  },
                  response: {
                    searchMode: result.mode,
                    searchProfile: {
                      requested: execution.requestedProfile,
                      applied: execution.appliedProfile,
                    },
                    items: publicSample ? [publicSample] : [],
                  },
                },
              },
              pageInfo: dataCenterPageInfo({
                page,
                pageSize,
                total,
                hasMore: result.hasMore,
                maxDirectPage,
                nextCursor: encodeDataCenterCursor(
                  'search',
                  result.nextCursor ? { ...result.nextCursor, page: page + 1 } : null,
                  binding,
                ),
              }),
            },
            requestId,
          })
          return
        }
        if (typeof store.dataCenterRecords !== 'function') {
          throw new AppError(503, 'data_center_unavailable', 'Data Center record browsing requires the PostgreSQL store')
        }
        const cursorState = dataCenterCursorState(decodeDataCenterCursor(encodedCursor, 'browse', binding))
        const page = requestedPage ?? cursorState.page
        const result = await store.dataCenterRecords({
          ...filters,
          ...(relatedProvince ? {
            query,
            relatedAdmin1Code: relatedProvince.code,
            relatedProvinceNames: [relatedProvince.name, relatedProvince.officialName],
            provinceRelation,
          } : {}),
          sort,
          pageSize,
          cursor: cursorState.cursor,
          page: requestedPage,
        })
        const total = dataCenterTotal(result.total)
        sendJson(response, 200, {
          data: {
            items: result.items,
            mode: relatedProvince ? 'postgres-related' : 'postgres',
            ...(relatedProvince ? {
              provinceFilter: {
                province: { code: relatedProvince.code, name: relatedProvince.name },
                relation: provinceRelation,
                relationStatusScope: 'accepted-or-proposed',
                includesRecallHints: ['any', 'recall'].includes(provinceRelation),
                qualityGateApplied: false,
                keywordMode: query ? 'postgres-substring' : null,
              },
            } : {}),
            pageInfo: dataCenterPageInfo({
              page,
              pageSize,
              total,
              hasMore: result.hasMore,
              nextCursor: encodeDataCenterCursor(
                'browse',
                result.nextCursor ? { ...result.nextCursor, page: page + 1 } : null,
                binding,
              ),
            }),
          },
          requestId,
        })
        return
      }
      if (request.method === 'GET' && pathname === '/internal/v1/admin/tenants') {
        const tenants = filterByTenantCapability(
          principal,
          (await service.listTenants()).map((tenant) => ({ ...tenant, tenantId: tenant.id })),
          'tenant.read',
        )
        sendJson(response, 200, { data: tenants.map(({ tenantId: _, ...rest }) => rest), requestId })
        return
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/tenants') {
        // Creating a tenant is a platform action: a scoped user has no tenant to
        // create it "inside", and letting them would let anyone mint themselves
        // an unbounded namespace.
        requirePlatformAdmin(principal)
        sendJson(response, 201, { data: await service.createTenant(await readJson(request)), requestId })
        return
      }
      params = routeMatch(pathname, '/internal/v1/admin/tenants/:id')
      if (request.method === 'PUT' && params) {
        requireTenantCapability(principal, params.id, 'tenant.write')
        sendJson(response, 200, { data: await service.renameTenant(params.id, await readJson(request)), requestId })
        return
      }
      if (request.method === 'GET' && pathname === '/internal/v1/admin/consumers') {
        const scope = scopeTenantCapability(principal, searchParams.get('tenantId') || null, 'consumer.read')
        if (Array.isArray(scope)) {
          const all = await Promise.all(scope.map((tenantId) => service.listConsumers(tenantId)))
          sendJson(response, 200, { data: all.flat(), requestId })
          return
        }
        sendJson(response, 200, { data: await service.listConsumers(scope || undefined), requestId })
        return
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/consumers') {
        const body = await readJson(request)
        requireTenantCapability(principal, body?.tenantId, 'consumer.write')
        sendJson(response, 201, { data: await service.createConsumer(body), requestId })
        return
      }
      if (request.method === 'GET' && pathname === '/internal/v1/admin/api-keys') {
        const consumerId = searchParams.get('consumerId') || undefined
        await assertConsumerCapability(principal, consumerId, 'apikey.read')
        const keys = filterByTenantCapability(
          principal,
          await service.listApiKeys(consumerId),
          'apikey.read',
        )
        sendJson(response, 200, { data: keys, requestId })
        return
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/api-keys') {
        const body = await readJson(request)
        // The tenant is derived from the consumer, so scope has to be checked
        // against the consumer's owner rather than anything the caller sends.
        await assertConsumerCapability(principal, body?.consumerId, 'apikey.write')
        sendJson(response, 201, { data: await service.createApiKey(body), requestId })
        return
      }
      params = routeMatch(pathname, '/internal/v1/admin/api-keys/:id/revoke')
      if (request.method === 'POST' && params) {
        await assertApiKeyCapability(principal, params.id, 'apikey.write')
        sendJson(response, 200, { data: await service.revokeApiKey(params.id), requestId })
        return
      }
      if (request.method === 'GET' && pathname === '/internal/v1/admin/platforms') {
        const filters = queryFilters(searchParams)
        if (filters.consumerId) await assertConsumerCapability(principal, filters.consumerId, 'consumer.read')
        else scopeTenantCapability(principal, null, 'consumer.read')
        sendJson(response, 200, {
          data: await service.getPlatformConfiguration(filters),
          requestId,
        })
        return
      }
      params = routeMatch(pathname, '/internal/v1/admin/platforms/:platform')
      if (request.method === 'PUT' && params) {
        const body = await readJson(request)
        await assertConsumerCapability(principal, body?.consumerId, 'platform.write')
        sendJson(response, 200, {
          data: await service.putPlatformConfiguration(params.platform, body),
          requestId,
        })
        return
      }
      params = routeMatch(pathname, '/internal/v1/admin/capabilities/:capability')
      if (request.method === 'PUT' && params) {
        const body = await readJson(request, 64 * 1024)
        await assertConsumerCapability(principal, body?.consumerId, 'platform.write')
        sendJson(response, 200, {
          data: await service.putCapabilityConfiguration(params.capability, body),
          requestId,
        })
        return
      }
      if (request.method === 'GET' && pathname === '/internal/v1/admin/usage') {
        sendJson(response, 200, {
          data: await scopedUsageFor(principal, queryFilters(searchParams)),
          requestId,
        })
        return
      }

      // ---- external sources (P4) ------------------------------------------
      //
      // Source configuration includes the upstream password by explicit
      // operator policy, so this surface is narrower than general platform
      // administration: only the break-glass admin token may enter it.

      if (pathname === '/internal/v1/admin/pipelines/telegram-monitor') {
        requireSourceAdmin(principal)
        requireDatabasePuller()
        if (request.method === 'GET') {
          sendJson(response, 200, { data: await telegramMonitorPipeline.get(), requestId })
          return
        }
        if (request.method === 'PUT') {
          const body = await readJson(request)
          sendJson(response, 200, { data: await telegramMonitorPipeline.configure(body), requestId })
          return
        }
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/pipelines/telegram-monitor/status') {
        requireSourceAdmin(principal)
        requireDatabasePuller()
        const body = await readJson(request)
        const unsupported = Object.keys(body || {}).filter(
          (field) => !['status', 'writerContractAttestation'].includes(field),
        )
        if (unsupported.length > 0) {
          throw new AppError(400, 'unsupported_fields', `Unsupported status fields: ${unsupported.join(', ')}`)
        }
        sendJson(response, 200, {
          data: await telegramMonitorPipeline.setStatus(body?.status, {
            approvedBy: principal.memberId || 'admin-token',
            writerContractAttestation: body?.writerContractAttestation ?? null,
          }),
          requestId,
        })
        return
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/pipelines/telegram-monitor/sync') {
        requireSourceAdmin(principal)
        requireDatabasePuller()
        const body = await readJson(request)
        sendJson(response, 202, { data: await telegramMonitorPipeline.sync(body), requestId })
        return
      }
      if (request.method === 'GET' && pathname === '/internal/v1/admin/pipelines/telegram-monitor/progress') {
        requireSourceAdmin(principal)
        requireDatabasePuller()
        sendJson(response, 200, { data: await telegramMonitorPipeline.progress(), requestId })
        return
      }
      if (
        request.method === 'GET'
        && pathname === '/internal/v1/admin/pipelines/telegram-monitor/source/prepare'
      ) {
        requireSourceAdmin(principal)
        requireDatabasePuller()
        sendJson(response, 200, {
          data: await telegramMonitorPipeline.inspectSourcePreparation(),
          requestId,
        })
        return
      }
      if (
        request.method === 'POST'
        && pathname === '/internal/v1/admin/pipelines/telegram-monitor/source/prepare'
      ) {
        requireSourceAdmin(principal)
        requireDatabasePuller()
        const body = await readJson(request)
        sendJson(response, 200, {
          data: await telegramMonitorPipeline.prepareSource(body),
          requestId,
        })
        return
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/pipelines/telegram-monitor/resume') {
        requireSourceAdmin(principal)
        requireDatabasePuller()
        sendJson(response, 200, { data: await telegramMonitorPipeline.resumeFailedTasks(), requestId })
        return
      }
      if (
        request.method === 'POST'
        && pathname === '/internal/v1/admin/pipelines/telegram-monitor/checkpoints/reset'
      ) {
        requireSourceAdmin(principal)
        requireDatabasePuller()
        const body = await readJson(request)
        const unsupported = Object.keys(body || {}).filter((field) => field !== 'confirmPipelineKey')
        if (unsupported.length > 0) {
          throw new AppError(400, 'unsupported_fields', `Unsupported checkpoint reset fields: ${unsupported.join(', ')}`)
        }
        sendJson(response, 200, {
          data: await telegramMonitorPipeline.resetCheckpoints(body?.confirmPipelineKey),
          requestId,
        })
        return
      }

      if (pathname === '/internal/v1/admin/pipelines/province-opinion') {
        requireSourceAdmin(principal)
        requireDatabasePuller()
        if (request.method === 'GET') {
          sendJson(response, 200, { data: await provinceOpinionPipeline.get(), requestId })
          return
        }
        if (request.method === 'PUT') {
          const body = await readJson(request)
          sendJson(response, 200, { data: await provinceOpinionPipeline.configure(body), requestId })
          return
        }
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/pipelines/province-opinion/status') {
        requireSourceAdmin(principal)
        requireDatabasePuller()
        const body = await readJson(request)
        const unsupported = Object.keys(body || {}).filter(
          (field) => !['status', 'writerContractAttestation'].includes(field),
        )
        if (unsupported.length > 0) {
          throw new AppError(400, 'unsupported_fields', `Unsupported status fields: ${unsupported.join(', ')}`)
        }
        sendJson(response, 200, {
          data: await provinceOpinionPipeline.setStatus(body?.status, {
            approvedBy: principal.memberId || 'admin-token',
            writerContractAttestation: body?.writerContractAttestation ?? null,
          }),
          requestId,
        })
        return
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/pipelines/province-opinion/sync') {
        requireSourceAdmin(principal)
        requireDatabasePuller()
        const body = await readJson(request)
        sendJson(response, 202, { data: await provinceOpinionPipeline.sync(body), requestId })
        return
      }
      if (request.method === 'GET' && pathname === '/internal/v1/admin/pipelines/province-opinion/progress') {
        requireSourceAdmin(principal)
        requireDatabasePuller()
        sendJson(response, 200, { data: await provinceOpinionPipeline.progress(), requestId })
        return
      }
      if (request.method === 'GET' && pathname === '/internal/v1/admin/pipelines/province-opinion/quality-summary') {
        requireSourceAdmin(principal)
        sendJson(response, 200, { data: await provinceOpinionPipeline.qualitySummary(), requestId })
        return
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/pipelines/province-opinion/resume') {
        requireSourceAdmin(principal)
        requireDatabasePuller()
        sendJson(response, 200, { data: await provinceOpinionPipeline.resumeFailedTask(), requestId })
        return
      }
      if (
        request.method === 'POST'
        && pathname === '/internal/v1/admin/pipelines/province-opinion/checkpoint/reset'
      ) {
        requireSourceAdmin(principal)
        requireDatabasePuller()
        const body = await readJson(request)
        const unsupported = Object.keys(body || {}).filter((field) => field !== 'confirmPipelineKey')
        if (unsupported.length > 0) {
          throw new AppError(400, 'unsupported_fields', `Unsupported checkpoint reset fields: ${unsupported.join(', ')}`)
        }
        sendJson(response, 200, {
          data: await provinceOpinionPipeline.resetCheckpoint(body?.confirmPipelineKey),
          requestId,
        })
        return
      }

      if (pathname === '/internal/v1/admin/pipelines/telegram-sqlite') {
        requireSourceAdmin(principal)
        requireSQLiteApiPuller()
        if (request.method === 'GET') {
          sendJson(response, 200, { data: await telegramSQLitePipeline.get(), requestId })
          return
        }
        if (request.method === 'PUT') {
          const body = await readJson(request)
          sendJson(response, 200, { data: await telegramSQLitePipeline.configure(body), requestId })
          return
        }
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/pipelines/telegram-sqlite/status') {
        requireSourceAdmin(principal)
        requireSQLiteApiPuller()
        const body = await readJson(request)
        const unsupported = Object.keys(body || {}).filter((field) => field !== 'status')
        if (unsupported.length > 0) {
          throw new AppError(400, 'unsupported_fields', `Unsupported status fields: ${unsupported.join(', ')}`)
        }
        sendJson(response, 200, {
          data: await telegramSQLitePipeline.setStatus(body?.status, {
            approvedBy: principal.memberId || 'admin-token',
          }),
          requestId,
        })
        return
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/pipelines/telegram-sqlite/sync') {
        requireSourceAdmin(principal)
        requireSQLiteApiPuller()
        sendJson(response, 202, {
          data: await telegramSQLitePipeline.sync(await readJson(request)),
          requestId,
        })
        return
      }
      if (request.method === 'GET' && pathname === '/internal/v1/admin/pipelines/telegram-sqlite/progress') {
        requireSourceAdmin(principal)
        requireSQLiteApiPuller()
        sendJson(response, 200, { data: await telegramSQLitePipeline.progress(), requestId })
        return
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/pipelines/telegram-sqlite/resume') {
        requireSourceAdmin(principal)
        requireSQLiteApiPuller()
        sendJson(response, 200, { data: await telegramSQLitePipeline.resumeFailedTasks(), requestId })
        return
      }
      if (
        request.method === 'POST'
        && pathname === '/internal/v1/admin/pipelines/telegram-sqlite/checkpoints/reset'
      ) {
        requireSourceAdmin(principal)
        requireSQLiteApiPuller()
        const body = await readJson(request)
        const unsupported = Object.keys(body || {}).filter((field) => field !== 'confirmPipelineKey')
        if (unsupported.length > 0) {
          throw new AppError(400, 'unsupported_fields', `Unsupported checkpoint reset fields: ${unsupported.join(', ')}`)
        }
        sendJson(response, 200, {
          data: await telegramSQLitePipeline.resetCheckpoints(body?.confirmPipelineKey),
          requestId,
        })
        return
      }

      if (request.method === 'GET' && pathname === '/internal/v1/admin/source-catalog') {
        requireSourceAdmin(principal)
        const includeArchived = url.searchParams.get('includeArchived') === 'true'
        const [items, taxonomyTerms] = await Promise.all([
          store.listSourceCatalogEntries({ includeArchived }),
          typeof store.listSourceCatalogTerms === 'function'
            ? store.listSourceCatalogTerms({ includeArchived: false })
            : [],
        ])
        sendJson(response, 200, { data: sourceCatalogSnapshot(items, taxonomyTerms), requestId })
        return
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/source-catalog') {
        requireSourceAdmin(principal)
        const body = await readJson(request)
        const input = normalizeSourceCatalogCreate({
          ...body,
          sourceKey: body?.sourceKey || `catalog-${randomUUID()}`,
        })
        const data = await store.createSourceCatalogEntry(input, {
          actor: principal.memberId || principal.kind || 'admin-token',
        })
        sendJson(response, 201, { data, requestId })
        return
      }

      if (request.method === 'GET' && pathname === '/internal/v1/admin/source-catalog/owners') {
        requireSourceAdmin(principal)
        const includeArchived = url.searchParams.get('includeArchived') === 'true'
        const owners = await store.listSourceCatalogOwners({ includeArchived })
        sendJson(response, 200, { data: sourceCatalogOwnerSnapshot(owners), requestId })
        return
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/source-catalog/owners') {
        requireSourceAdmin(principal)
        const body = await readJson(request)
        const input = normalizeSourceCatalogOwnerCreate({
          ...body,
          ownerKey: body?.ownerKey || `owner-${randomUUID()}`,
        })
        const data = await store.createSourceCatalogOwner(input, {
          actor: principal.memberId || principal.kind || 'admin-token',
        })
        sendJson(response, 201, { data, requestId })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/source-catalog/owners/:id/events')
      if (params && request.method === 'GET') {
        requireSourceAdmin(principal)
        const ownerId = sourceCatalogOwnerId(params.id)
        const owner = await store.getSourceCatalogOwner(ownerId)
        if (!owner) throw new AppError(404, 'source_catalog_owner_not_found', 'Source catalog owner was not found')
        const requestedLimit = Number(url.searchParams.get('limit') || 50)
        const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 200)) : 50
        sendJson(response, 200, {
          data: await store.listSourceCatalogOwnerEvents(ownerId, limit),
          requestId,
        })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/source-catalog/owners/:id/archive')
      if (params && request.method === 'POST') {
        requireSourceAdmin(principal)
        const ownerId = sourceCatalogOwnerId(params.id)
        const body = await readJson(request)
        const unsupported = Object.keys(body || {}).filter((field) => field !== 'revision')
        if (unsupported.length > 0) {
          throw new AppError(400, 'unsupported_fields', `Unsupported owner archive fields: ${unsupported.join(', ')}`)
        }
        const data = await store.archiveSourceCatalogOwner(ownerId, {
          expectedRevision: sourceCatalogRevision(body?.revision),
          actor: principal.memberId || principal.kind || 'admin-token',
        })
        sendJson(response, 200, { data, requestId })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/source-catalog/owners/:id/restore')
      if (params && request.method === 'POST') {
        requireSourceAdmin(principal)
        const ownerId = sourceCatalogOwnerId(params.id)
        const body = await readJson(request)
        const unsupported = Object.keys(body || {}).filter((field) => field !== 'revision')
        if (unsupported.length > 0) {
          throw new AppError(400, 'unsupported_fields', `Unsupported owner restore fields: ${unsupported.join(', ')}`)
        }
        const data = await store.restoreSourceCatalogOwner(ownerId, {
          expectedRevision: sourceCatalogRevision(body?.revision),
          actor: principal.memberId || principal.kind || 'admin-token',
        })
        sendJson(response, 200, { data, requestId })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/source-catalog/owners/:id')
      if (params && request.method === 'GET') {
        requireSourceAdmin(principal)
        const data = await store.getSourceCatalogOwner(sourceCatalogOwnerId(params.id))
        if (!data) throw new AppError(404, 'source_catalog_owner_not_found', 'Source catalog owner was not found')
        sendJson(response, 200, { data, requestId })
        return
      }
      if (params && request.method === 'PUT') {
        requireSourceAdmin(principal)
        const ownerId = sourceCatalogOwnerId(params.id)
        const body = await readJson(request)
        const revision = sourceCatalogRevision(body?.revision)
        const patch = normalizeSourceCatalogOwnerPatch(body)
        const data = await store.updateSourceCatalogOwner(ownerId, patch, {
          expectedRevision: revision,
          actor: principal.memberId || principal.kind || 'admin-token',
        })
        sendJson(response, 200, { data, requestId })
        return
      }

      if (request.method === 'GET' && pathname === '/internal/v1/admin/source-catalog/taxonomy') {
        requireSourceAdmin(principal)
        const includeArchived = url.searchParams.get('includeArchived') === 'true'
        const kind = url.searchParams.get('kind')?.trim() || null
        if (kind && !SOURCE_CATALOG_TERM_KINDS.includes(kind)) {
          throw new AppError(400, 'invalid_source_catalog_term_kind', `kind must be one of ${SOURCE_CATALOG_TERM_KINDS.join(', ')}`)
        }
        const terms = await store.listSourceCatalogTerms({ includeArchived, kind })
        sendJson(response, 200, { data: sourceCatalogTermSnapshot(terms), requestId })
        return
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/source-catalog/taxonomy') {
        requireSourceAdmin(principal)
        const body = await readJson(request)
        const input = normalizeSourceCatalogTermCreate({
          ...body,
          termKey: body?.termKey || `term-${randomUUID()}`,
        })
        const data = await store.createSourceCatalogTerm(input, {
          actor: principal.memberId || principal.kind || 'admin-token',
        })
        sendJson(response, 201, { data, requestId })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/source-catalog/taxonomy/:id/events')
      if (params && request.method === 'GET') {
        requireSourceAdmin(principal)
        const termId = sourceCatalogTermId(params.id)
        const term = await store.getSourceCatalogTerm(termId)
        if (!term) throw new AppError(404, 'source_catalog_term_not_found', 'Source catalog taxonomy term was not found')
        const requestedLimit = Number(url.searchParams.get('limit') || 50)
        const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 200)) : 50
        sendJson(response, 200, {
          data: await store.listSourceCatalogTermEvents(termId, limit),
          requestId,
        })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/source-catalog/taxonomy/:id/archive')
      if (params && request.method === 'POST') {
        requireSourceAdmin(principal)
        const termId = sourceCatalogTermId(params.id)
        const body = await readJson(request)
        const unsupported = Object.keys(body || {}).filter((field) => field !== 'revision')
        if (unsupported.length > 0) {
          throw new AppError(400, 'unsupported_fields', `Unsupported taxonomy archive fields: ${unsupported.join(', ')}`)
        }
        const data = await store.archiveSourceCatalogTerm(termId, {
          expectedRevision: sourceCatalogRevision(body?.revision),
          actor: principal.memberId || principal.kind || 'admin-token',
        })
        sendJson(response, 200, { data, requestId })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/source-catalog/taxonomy/:id/restore')
      if (params && request.method === 'POST') {
        requireSourceAdmin(principal)
        const termId = sourceCatalogTermId(params.id)
        const body = await readJson(request)
        const unsupported = Object.keys(body || {}).filter((field) => field !== 'revision')
        if (unsupported.length > 0) {
          throw new AppError(400, 'unsupported_fields', `Unsupported taxonomy restore fields: ${unsupported.join(', ')}`)
        }
        const data = await store.restoreSourceCatalogTerm(termId, {
          expectedRevision: sourceCatalogRevision(body?.revision),
          actor: principal.memberId || principal.kind || 'admin-token',
        })
        sendJson(response, 200, { data, requestId })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/source-catalog/taxonomy/:id')
      if (params && request.method === 'GET') {
        requireSourceAdmin(principal)
        const data = await store.getSourceCatalogTerm(sourceCatalogTermId(params.id))
        if (!data) throw new AppError(404, 'source_catalog_term_not_found', 'Source catalog taxonomy term was not found')
        sendJson(response, 200, { data, requestId })
        return
      }
      if (params && request.method === 'PUT') {
        requireSourceAdmin(principal)
        const termId = sourceCatalogTermId(params.id)
        const body = await readJson(request)
        const revision = sourceCatalogRevision(body?.revision)
        const patch = normalizeSourceCatalogTermPatch(body)
        const data = await store.updateSourceCatalogTerm(termId, patch, {
          expectedRevision: revision,
          actor: principal.memberId || principal.kind || 'admin-token',
        })
        sendJson(response, 200, { data, requestId })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/source-catalog/:id/related-data')
      if (params && request.method === 'GET') {
        requireSourceAdmin(principal)
        const entryId = sourceCatalogId(params.id)
        const entry = await store.getSourceCatalogEntry(entryId)
        if (!entry) throw new AppError(404, 'source_catalog_entry_not_found', 'Source catalog entry was not found')
        const rawPageSize = url.searchParams.get('pageSize')
        const pageSize = rawPageSize == null || rawPageSize === '' ? 20 : Number(rawPageSize)
        if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
          throw new AppError(400, 'invalid_page_size', 'pageSize must be an integer between 1 and 100')
        }
        sendJson(response, 200, {
          data: await store.sourceCatalogRelatedData(entry, { pageSize }),
          requestId,
        })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/source-catalog/:id/events')
      if (params && request.method === 'GET') {
        requireSourceAdmin(principal)
        const entryId = sourceCatalogId(params.id)
        const entry = await store.getSourceCatalogEntry(entryId)
        if (!entry) throw new AppError(404, 'source_catalog_entry_not_found', 'Source catalog entry was not found')
        const requestedLimit = Number(url.searchParams.get('limit') || 50)
        const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 200)) : 50
        sendJson(response, 200, {
          data: await store.listSourceCatalogEvents(entryId, limit),
          requestId,
        })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/source-catalog/:id/archive')
      if (params && request.method === 'POST') {
        requireSourceAdmin(principal)
        const entryId = sourceCatalogId(params.id)
        const body = await readJson(request)
        const unsupported = Object.keys(body || {}).filter((field) => field !== 'revision')
        if (unsupported.length > 0) {
          throw new AppError(400, 'unsupported_fields', `Unsupported archive fields: ${unsupported.join(', ')}`)
        }
        const data = await store.archiveSourceCatalogEntry(entryId, {
          expectedRevision: sourceCatalogRevision(body?.revision),
          actor: principal.memberId || principal.kind || 'admin-token',
        })
        sendJson(response, 200, { data, requestId })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/source-catalog/:id/restore')
      if (params && request.method === 'POST') {
        requireSourceAdmin(principal)
        const entryId = sourceCatalogId(params.id)
        const body = await readJson(request)
        const unsupported = Object.keys(body || {}).filter((field) => field !== 'revision')
        if (unsupported.length > 0) {
          throw new AppError(400, 'unsupported_fields', `Unsupported restore fields: ${unsupported.join(', ')}`)
        }
        const data = await store.restoreSourceCatalogEntry(entryId, {
          expectedRevision: sourceCatalogRevision(body?.revision),
          actor: principal.memberId || principal.kind || 'admin-token',
        })
        sendJson(response, 200, { data, requestId })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/source-catalog/:id')
      if (params && request.method === 'GET') {
        requireSourceAdmin(principal)
        const data = await store.getSourceCatalogEntry(sourceCatalogId(params.id))
        if (!data) throw new AppError(404, 'source_catalog_entry_not_found', 'Source catalog entry was not found')
        sendJson(response, 200, { data, requestId })
        return
      }
      if (params && request.method === 'PUT') {
        requireSourceAdmin(principal)
        const entryId = sourceCatalogId(params.id)
        const body = await readJson(request)
        const revision = sourceCatalogRevision(body?.revision)
        const patch = normalizeSourceCatalogPatch(body)
        const data = await store.updateSourceCatalogEntry(entryId, patch, {
          expectedRevision: revision,
          actor: principal.memberId || principal.kind || 'admin-token',
        })
        sendJson(response, 200, { data, requestId })
        return
      }

      if (request.method === 'GET' && pathname === '/internal/v1/admin/sources') {
        requireSourceAdmin(principal)
        sendJson(response, 200, {
          data: (await store.listExternalSources()).map(adminSourceView),
          requestId,
        })
        return
      }
      if (request.method === 'GET' && pathname === '/internal/v1/admin/server-file-roots') {
        requireSourceAdmin(principal)
        const description = requireServerFileReader().describeRoots()
        sendJson(response, 200, { data: description.roots, requestId })
        return
      }
      if (request.method === 'GET' && pathname === '/internal/v1/admin/file-format-rules') {
        requireSourceAdmin(principal)
        sendJson(response, 200, { data: await fileFormatRuleCatalog(), requestId })
        return
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/sources') {
        requireSourceAdmin(principal)
        const body = await readJson(request)
        const sourceKey = requiredSourceKey(body)
        assertGenericSourceMutable(sourceKey)
        if (await store.getExternalSource?.(sourceKey)) {
          throw new AppError(409, 'source_exists', 'Source keys are immutable; update a paused source through its PUT route')
        }
        const sourceKind = body.sourceKind || 'file'
        if (!['file', 'database'].includes(sourceKind)) {
          throw new AppError(400, 'invalid_source_kind', 'sourceKind must be file or database')
        }
        const displayName = requiredField(body, 'displayName')
        const syncIntervalSeconds = body.syncIntervalSeconds ?? 60
        if (!Number.isInteger(syncIntervalSeconds) || syncIntervalSeconds < 60 || syncIntervalSeconds > 86_400) {
          throw new AppError(400, 'invalid_sync_interval', 'syncIntervalSeconds must be between 60 and 86400')
        }
        if (sourceKind === 'database') {
          validateDatabaseConnection(body.connection)
          if (typeof databasePuller?.testConnection !== 'function') {
            throw new AppError(503, 'source_validation_unavailable', 'Database source creation requires the PostgreSQL test workload')
          }
          await databasePuller.testConnection(body.connection)
        }
        let sourceConnection = body.connection || {}
        let selectedRule = null
        let detectedProfile = null
        if (sourceKind === 'file') {
          const fileMode = body.fileMode || 'upload'
          if (!['upload', 'server_path'].includes(fileMode)) {
            throw new AppError(400, 'invalid_file_mode', 'fileMode must be upload or server_path')
          }
          selectedRule = await resolveFileFormatRule(body.preferredRuleKey || null)
          if (fileMode === 'server_path') {
            const serverPath = requiredField(body, 'serverPath')
            const file = await requireServerFileReader().readInput(serverPath)
            if (importer) {
              const preview = await previewWithSuggestion({
                source: null,
                buffer: file.buffer,
                filename: file.filename,
                // Registration is the user's explicit request to classify this
                // server file. Only the value-free structural summary reaches a
                // configured model; raw samples stay in the Admin response path.
                agentRequested: true,
                preferredRuleKey: selectedRule?.ruleKey || null,
              })
              const detectedRuleKey = preview.detection?.ruleKey || null
              if (!selectedRule && detectedRuleKey) selectedRule = await resolveFileFormatRule(detectedRuleKey)
              detectedProfile = preview.detection || null
            }
            sourceConnection = {
              fileMode: 'server_path',
              rootId: file.rootId,
              relativePath: file.relativePath,
              ...(selectedRule ? { preferredRuleKey: selectedRule.ruleKey } : {}),
            }
          } else {
            if (body.serverPath != null) {
              throw new AppError(400, 'unsupported_fields', 'serverPath requires fileMode server_path')
            }
            sourceConnection = {
              fileMode: 'upload',
              ...(selectedRule ? { preferredRuleKey: selectedRule.ruleKey } : {}),
            }
          }
        } else if (body.preferredRuleKey != null || body.fileMode != null || body.serverPath != null) {
          throw new AppError(400, 'unsupported_fields', 'File rule and path fields require sourceKind file')
        }
        const datasetId = selectedRule?.datasetId || body.datasetId || `external.${sourceKey}.v1`
        const platform = selectedRule?.platform
          || (detectedProfile?.platform && (!body.platform || body.platform === 'external')
            ? detectedProfile.platform
            : body.platform)
          || 'external'
        const objectType = selectedRule?.objectType
          || (detectedProfile?.objectType && (!body.objectType || body.objectType === 'record')
            ? detectedProfile.objectType
            : body.objectType)
          || 'record'
        const created = await withSourceLocks([sourceKey], async () => {
          if (await store.getExternalSource?.(sourceKey)) {
            throw new AppError(409, 'source_exists', 'Source keys are immutable; update a paused source through its PUT route')
          }
          return store.createExternalSource({
              sourceKey,
              displayName,
              sourceKind,
              // External data lands in its own dataset by default so it never
              // silently merges into the Night-All corpus and skews platform stats.
              datasetId,
              platform,
              objectType,
              status: sourceKind === 'database' ? 'paused' : 'active',
              connection: sourceConnection,
              syncIntervalSeconds,
            })
        })
        sendJson(response, 201, { data: created, requestId })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/sources/:key')
      if (params && request.method === 'GET') {
        requireSourceAdmin(principal)
        sendJson(response, 200, { data: adminSourceView(await requireSource(params.key)), requestId })
        return
      }
      if (params && request.method === 'PUT') {
        requireSourceAdmin(principal)
        assertGenericSourceMutable(params.key)
        const initialSource = await requireSource(params.key)
        const body = await readJson(request)
        const unsupported = Object.keys(body || {}).filter(
          (field) => !['connection', 'status', 'syncIntervalSeconds'].includes(field),
        )
        if (unsupported.length > 0) {
          throw new AppError(400, 'unsupported_fields', `Unsupported source fields: ${unsupported.join(', ')}`)
        }
        if (body.status != null && !['active', 'paused'].includes(body.status)) {
          throw new AppError(400, 'invalid_status', 'status must be active or paused')
        }
        const changesConnection = body.connection != null
        if (body.syncIntervalSeconds != null && (
          !Number.isInteger(body.syncIntervalSeconds) || body.syncIntervalSeconds < 60 || body.syncIntervalSeconds > 86_400
        )) {
          throw new AppError(400, 'invalid_sync_interval', 'syncIntervalSeconds must be between 60 and 86400')
        }
        const needsExclusiveProbe = changesConnection || body.status === 'active'
        const lockKeys = needsExclusiveProbe ? [params.key] : []
        const updateSource = async () => {
          const source = await requireSource(params.key)
          if (changesConnection) {
            if (source.sourceKind !== 'database') {
              throw new AppError(400, 'wrong_source_kind', 'Only database sources have connection metadata')
            }
            if (source.status !== 'paused') {
              throw new AppError(409, 'source_pause_required', 'Pause this source before changing its connection metadata')
            }
            if (body.status === 'active') {
              throw new AppError(409, 'source_probe_required', 'Update connection while paused, then probe and activate separately')
            }
            const cursor = await queue?.getCursor?.(`external:${params.key}`)
            if (cursor?.status === 'running') {
              throw new AppError(409, 'source_draining', 'Wait for the running batch to reach its checkpoint before changing connection metadata')
            }
          }
          const mergedConnection = { ...source.connection, ...(body.connection || {}) }
          if (body.connection && Object.keys(body.connection).some((field) => (
            ['host', 'port', 'database', 'username', 'password', 'sslMode'].includes(field)
          ))) {
            delete mergedConnection.dsnEnv
          }
          if (typeof body.connection?.dsnEnv === 'string') {
            for (const field of ['host', 'port', 'database', 'username', 'password', 'sslMode']) {
              delete mergedConnection[field]
            }
          }
          if (changesConnection) {
            validateDatabaseConnection(mergedConnection)
            if (typeof databasePuller?.testConnection !== 'function') {
              throw new AppError(503, 'source_validation_unavailable', 'Database source connection changes require the PostgreSQL test workload')
            }
            await databasePuller.testConnection(mergedConnection)
          }
          if (body.status === 'active' && source.status !== 'active') {
            requireDatabasePuller()
            const cursor = await queue?.getCursor?.(`external:${params.key}`)
            if (cursor?.status === 'running') {
              throw new AppError(409, 'source_draining', 'Wait for the running batch to finish before activating this source')
            }
            const mapping = await store.getActiveMapping(source.id)
            if (!mapping) {
              throw new AppError(409, 'no_approved_mapping', 'Approve a verified field mapping before activating this source')
            }
            await databasePuller.assertCheckpointCompatible?.(params.key)
            const description = await databasePuller.describe(params.key)
            if (description.issues.length > 0) {
              throw new AppError(409, 'source_probe_failed', 'Source schema is not safe for incremental sync', {
                issues: description.issues,
              })
            }
          }
          return store.updateExternalSource(params.key, {
            status: body.status ?? null,
            connection: changesConnection ? mergedConnection : null,
            ...(body.syncIntervalSeconds == null ? {} : { syncIntervalSeconds: body.syncIntervalSeconds }),
          })
        }
        const data = await withSourceLocks(lockKeys, updateSource)
        sendJson(response, 200, {
          data,
          requestId,
        })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/sources/:key/test')
      if (params && request.method === 'POST') {
        requireSourceAdmin(principal)
        const source = await requireSource(params.key)
        const puller = pullerForSource(source)
        if (typeof puller.testSource !== 'function') requireDatabaseSourceTester()
        const test = () => puller.testSource(params.key)
        const data = typeof puller.withSourceLocks === 'function'
          ? await puller.withSourceLocks([params.key], test)
          : await withSourceLocks([params.key], test)
        sendJson(response, 200, { data, requestId })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/sources/:key/mappings')
      if (params && request.method === 'GET') {
        requireSourceAdmin(principal)
        const source = await requireSource(params.key)
        sendJson(response, 200, { data: await store.listSourceMappings(source.id), requestId })
        return
      }
      if (params && request.method === 'POST') {
        requireSourceAdmin(principal)
        assertGenericSourceMutable(params.key)
        const source = await requireSource(params.key)
        const body = await readJson(request)
        validateFieldMap(body?.fieldMap)
        const requestedRuleKey = body?.selectedRuleKey ?? null
        const preferredRuleKey = source.connection?.preferredRuleKey ?? null
        if (requestedRuleKey != null && preferredRuleKey != null && requestedRuleKey !== preferredRuleKey) {
          throw new AppError(
            409,
            'file_format_rule_mismatch',
            'selectedRuleKey conflicts with this source preferredRuleKey',
          )
        }
        const selectedRule = await resolveFileFormatRule(requestedRuleKey ?? preferredRuleKey)
        if (selectedRule && (
          source.datasetId !== selectedRule.datasetId
          || source.platform !== selectedRule.platform
          || source.objectType !== selectedRule.objectType
        )) {
          throw new AppError(409, 'file_format_rule_mismatch', 'The selected rule does not match this source scope')
        }
        if (source.sourceKind === 'file' && source.connection?.fileMode === 'server_path') {
          if (!/^[0-9a-f]{64}$/.test(body?.schemaFingerprint || '')) {
            throw new AppError(400, 'invalid_schema_fingerprint', 'A server-path mapping requires its preview structure fingerprint')
          }
          if (!body.fileStructure || typeof body.fileStructure !== 'object' || Array.isArray(body.fileStructure)) {
            throw new AppError(400, 'invalid_file_structure', 'A server-path mapping requires its preview structure')
          }
        }
        if (body?.schemaFingerprint != null) {
          if (!/^[0-9a-f]{64}$/.test(body.schemaFingerprint)
            || !body.fileStructure
            || fingerprintFileStructure(body.fileStructure) !== body.schemaFingerprint) {
            throw new AppError(400, 'invalid_schema_fingerprint', 'schemaFingerprint does not match fileStructure')
          }
        }
        const mapping = await store.createSourceMapping({
          sourceId: source.id,
          fieldMap: body.fieldMap,
          origin: body.origin || 'manual',
          agentModel: body.agentModel,
          agentConfidence: body.agentConfidence,
          notes: body.notes,
          schemaFingerprint: body.schemaFingerprint,
          fileStructure: body.fileStructure,
          formatRuleVersionId: body.formatRuleVersionId,
          selectedRuleKey: selectedRule?.ruleKey || null,
        })
        // Created unapproved on purpose: a mapping decides how stored data is
        // shaped, so it takes a second, explicit action to put it in force.
        sendJson(response, 201, { data: mapping, requestId })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/sources/:key/mappings/:version/approve')
      if (params && request.method === 'POST') {
        requireSourceAdmin(principal)
        assertGenericSourceMutable(params.key)
        const initial = await requireSource(params.key)
        const needsMappingLock = initial.sourceKind === 'database'
          || initial.connection?.fileMode === 'server_path'
        const approved = await withSourceLocks(needsMappingLock ? [params.key] : [], async (
          _assertOwned = async () => {},
          sessionClients = [],
        ) => {
          const source = await requireSource(params.key)
          if (source.sourceKind === 'database' && source.status !== 'paused') {
            throw new AppError(409, 'source_pause_required', 'Pause this database source before changing its active mapping')
          }
          if (source.sourceKind === 'database') {
            const cursor = await queue?.getCursor?.(`external:${params.key}`)
            if (cursor?.status === 'running') {
              throw new AppError(409, 'source_draining', 'Wait for the running batch to finish before changing the active mapping')
            }
          }
          const sessionClient = needsMappingLock ? sessionClients[0] : null
          if (needsMappingLock && !sessionClient) {
            throw new AppError(503, 'source_lock_unavailable', 'Mapping approval requires the PostgreSQL source-lock session')
          }
          return store.approveSourceMapping({
            sourceId: source.id,
            version: Number(params.version),
            approvedBy: principal.memberId || 'admin-token',
          }, { sessionClient })
        })
        sendJson(response, 200, { data: approved, requestId })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/sources/:key/preview')
      if (params && request.method === 'GET') {
        requireSourceAdmin(principal)
        const source = await requireSource(params.key)
        const puller = pullerForSource(source)
        sendJson(response, 200, {
          data: await puller.preview(params.key, { limit: Number(searchParams.get('limit') || 3) }),
          requestId,
        })
        return
      }
      if (params && request.method === 'POST') {
        requireSourceAdmin(principal)
        requireImporter()
        // Preserve the original local-preview contract for embedded/test
        // importers whose store does not expose a source catalog. Production
        // PostgreSQL stores do, and therefore also receive scoped format-rule
        // matching. Preview itself never writes canonical data.
        const source = typeof store.getExternalSource === 'function'
          ? await requireSource(params.key)
          : null
        const buffer = await readBuffer(request)
        const filename = requiredQuery(searchParams, 'filename')
        const agentQuery = searchParams.get('agent')
        if (agentQuery != null && !['true', 'false'].includes(agentQuery)) {
          throw new AppError(400, 'invalid_agent_preview', 'agent must be true or false')
        }
        const agentRequested = agentQuery === 'true'
        const preferredRuleKey = searchParams.get('preferredRuleKey')?.trim() || null
        // Agent-assisted preview receives only column names and a value-free
        // first/middle/last structure summary — never source rows or values.
        sendJson(response, 200, {
          data: await previewWithSuggestion({
            source, buffer, filename, agentRequested, preferredRuleKey,
          }),
          requestId,
        })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/sources/:key/server-preview')
      if (params && request.method === 'POST') {
        requireSourceAdmin(principal)
        requireImporter()
        const source = await requireSource(params.key)
        const body = await readJson(request, 64 * 1024)
        if (body.agent != null && typeof body.agent !== 'boolean') {
          throw new AppError(400, 'invalid_agent_preview', 'agent must be true or false')
        }
        const file = await readServerSourceFile(source, body.serverPath)
        const data = await previewWithSuggestion({
          source,
          buffer: file.buffer,
          filename: file.filename,
          agentRequested: body.agent === true,
          preferredRuleKey: body.preferredRuleKey || null,
        })
        if (typeof store.recordFileObservation === 'function') {
          await store.recordFileObservation({
            sourceId: source.id,
            rootId: file.rootId,
            relativePath: file.relativePath,
            pathHash: filePathHash(file),
            inputSha256: file.inputSha256,
            inputBytes: file.inputBytes,
            mtime: file.mtime,
            schemaFingerprint: data.schemaFingerprint,
            formatRuleVersionId: data.selectedFormatRule?.versionId || data.matchedFormatRule?.versionId || null,
            status: 'previewed',
          })
        }
        sendJson(response, 200, { data, requestId })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/sources/:key/files')
      if (params && request.method === 'GET') {
        requireSourceAdmin(principal)
        const source = await requireSource(params.key)
        requireServerPathSource(source)
        sendJson(response, 200, {
          data: typeof store.listFileObservations === 'function'
            ? await store.listFileObservations(source.id)
            : [],
          requestId,
        })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/sources/:key/schema')
      if (params && request.method === 'GET') {
        requireSourceAdmin(principal)
        const source = await requireSource(params.key)
        const puller = pullerForSource(source)
        sendJson(response, 200, { data: await puller.describe(params.key), requestId })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/sources/:key/sync')
      if (params && request.method === 'GET') {
        requireSourceAdmin(principal)
        const source = await requireSource(params.key)
        pullerForSource(source)
        requireExternalQueue()
        const cursor = await queue.getCursor(`external:${params.key}`)
        const latestRun = (await store.listImportRuns(source.id, 1))[0] ?? null
        const cursorUpdatedAt = cursor?.updated_at ?? cursor?.updatedAt ?? null
        sendJson(response, 200, {
          data: {
            cursor,
            latestRun,
            syncIntervalSeconds: source.syncIntervalSeconds ?? 60,
            nextDueAt: cursorUpdatedAt
              ? new Date(new Date(cursorUpdatedAt).getTime() + (source.syncIntervalSeconds ?? 60) * 1_000).toISOString()
              : null,
          },
          requestId,
        })
        return
      }
      if (params && request.method === 'POST') {
        requireSourceAdmin(principal)
        assertGenericSourceMutable(params.key)
        requireDatabasePuller()
        const source = await requireSource(params.key)
        if (source.sourceKind !== 'database') {
          throw new AppError(400, 'wrong_source_kind', 'This source is not a database source')
        }
        if (source.status !== 'active') {
          throw new AppError(409, 'source_paused', 'Probe, approve and activate this source before scheduling sync')
        }
        const existingCursor = await queue.getCursor(`external:${params.key}`)
        if (existingCursor?.status === 'running') {
          sendJson(response, 202, {
            data: { sourceKey: params.key, jobId: null, alreadyScheduled: true },
            requestId,
          })
          return
        }
        const description = await databasePuller.describe(params.key)
        if (description.issues.length > 0) {
          throw new AppError(409, 'source_probe_failed', 'Source schema is not safe for incremental sync', {
            issues: description.issues,
          })
        }
        const body = await readJson(request)
        const batchSize = body?.batchSize ?? 1_000
        if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5_000) {
          throw new AppError(400, 'invalid_batch_size', 'batchSize must be an integer between 1 and 5000')
        }
        const jobId = await queue.enqueue(
          'external-pull',
          { sourceKey: params.key, batchSize, trigger: 'manual', chunk: 0 },
          { dedupeKey: `external-pull:${params.key}:0`, priority: 220 },
        )
        sendJson(response, 202, {
          data: { sourceKey: params.key, jobId, alreadyScheduled: jobId === null },
          requestId,
        })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/sources/:key/checkpoint/reset')
      if (params && request.method === 'POST') {
        requireSourceAdmin(principal)
        assertGenericSourceMutable(params.key)
        requireDatabasePuller()
        const source = await requireSource(params.key)
        const body = await readJson(request)
        if (body?.confirmSourceKey !== source.sourceKey) {
          throw new AppError(400, 'checkpoint_reset_confirmation_required', 'confirmSourceKey must exactly match the source key')
        }
        sendJson(response, 200, {
          data: await databasePuller.resetCheckpoint(params.key), requestId,
        })
        return
      }

      // ---- retrieval ------------------------------------------------------
      if (request.method === 'GET' && pathname === '/internal/v1/admin/retrieval') {
        requirePlatformAdmin(principal)
        sendJson(response, 200, {
          data: embedding ? await embedding.status() : { enabled: false },
          requestId,
        })
        return
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/retrieval/search') {
        requirePlatformAdmin(principal)
        if (!search?.queries?.chunkIndexSet) {
          throw new AppError(503, 'semantic_search_unavailable', 'The chunk index is not configured')
        }
        const body = await readJson(request)
        const result = await search.queries.semanticSearch(requiredField(body, 'query'), {
          platform: body.platform ?? null,
          datasetId: body.datasetId ?? null,
          size: body.size ?? 10,
          // Passing the embedder in rather than reaching for a global keeps the
          // query layer independent of whether an agent exists at all.
          embed: agent?.embeddings?.available ? (texts) => agent.embed(texts) : null,
        })
        sendJson(response, 200, { data: result, requestId })
        return
      }

      // ---- agent (P5) -----------------------------------------------------
      if (request.method === 'GET' && pathname === '/internal/v1/admin/agent') {
        requirePlatformAdmin(principal)
        const pipelines = agentPipelines ? await agentPipelines.listPipelines() : []
        const pipelineData = agentPipelines
          ? await Promise.all(pipelines.map(async (pipeline) => ({
              ...pipeline,
              recentAssertions: await agentPipelines.listAssertions(pipeline.pipelineKey, 8),
            })))
          : []
        sendJson(response, 200, {
          data: {
            available: Boolean(agent?.available),
            // The circuit state per provider is the operationally useful part:
            // it shows when the chain is quietly running on a fallback.
            ...(agent?.status() ?? {}),
            control: typeof agent?.controlStatus === 'function'
              ? await agent.controlStatus()
              : { sequences: [], bindings: [], providerTests: [], proxy: { endpoints: [], sequences: [], globalSequenceKey: null, revision: 0 } },
            pipelines: pipelineData,
          },
          requestId,
        })
        return
      }

      // ---- Agent Market -------------------------------------------------
      // This namespace is intentionally separate from production analysis
      // tasks. A dry run calls only the read-side search object and the model
      // router; it never reaches HubService reservations, queues or outbox.
      if (request.method === 'GET' && pathname === '/internal/v1/admin/agent-market') {
        requirePlatformAdmin(principal)
        const items = agentMarket
          ? await agentMarket.listAgents()
          : (() => {
              const snapshot = builtinAdvancedSearchSnapshot()
              return [{
                ...snapshot,
                activeStages: snapshot.definition.stages.filter((stage) => stage.state === 'active').length,
                trashedStages: snapshot.definition.stages.filter((stage) => stage.state === 'trashed').length,
              }]
            })()
        sendJson(response, 200, { data: items, requestId })
        return
      }
      params = routeMatch(pathname, '/internal/v1/admin/agent-market/:agentKey/dry-run')
      if (params && request.method === 'POST') {
        requireAgentMarketAdmin(principal)
        if (params.agentKey !== ADVANCED_SEARCH_AGENT_KEY) {
          throw new AppError(404, 'agent_market_not_found', 'The Agent Market item was not found')
        }
        const data = await runAdvancedSearchDryRun({
          body: await readJson(request, 256 * 1024),
          search,
          agent,
        })
        sendJson(response, 200, { data, requestId })
        return
      }
      params = routeMatch(pathname, '/internal/v1/admin/agent-market/:agentKey')
      if (params && request.method === 'GET') {
        requirePlatformAdmin(principal)
        const data = agentMarket
          ? await agentMarket.getAgent(params.agentKey)
          : params.agentKey === ADVANCED_SEARCH_AGENT_KEY
            ? builtinAdvancedSearchSnapshot()
            : null
        if (!data) throw new AppError(404, 'agent_market_not_found', 'The Agent Market item was not found')
        sendJson(response, 200, { data, requestId })
        return
      }
      if (params && request.method === 'PUT') {
        requireAgentMarketAdmin(principal)
        if (!agentMarket) {
          throw new AppError(503, 'agent_market_store_unavailable', 'Saving Agent Market drafts requires PostgreSQL')
        }
        const data = await agentMarket.saveAgent(
          params.agentKey,
          await readJson(request, 256 * 1024),
          { updatedBy: principal.memberId || principal.kind || 'admin-token' },
        )
        sendJson(response, 200, { data, requestId })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/agent/providers/:kind/:providerId/test')
      if (params && request.method === 'POST') {
        requireAgentAdmin(principal)
        if (typeof agent?.testProvider !== 'function') {
          throw new AppError(503, 'agent_settings_unavailable', 'Agent provider testing is unavailable')
        }
        const data = await agent.testProvider({
          kind: params.kind,
          providerId: params.providerId,
        })
        sendJson(response, 200, { data, requestId })
        return
      }
      params = routeMatch(pathname, '/internal/v1/admin/agent/providers/:kind/:providerId/reveal')
      if (params && request.method === 'POST') {
        requireAgentAdmin(principal)
        if (typeof agent?.revealProviderCredential !== 'function') {
          throw new AppError(503, 'agent_settings_unavailable', 'Provider credentials require PostgreSQL')
        }
        const body = await readJson(request, 16 * 1024)
        if (!adminToken || typeof body?.adminToken !== 'string' || !secureEqual(body.adminToken, adminToken)) {
          throw new AppError(403, 'admin_token_reauthentication_required', 'Re-enter the Hub admin token to reveal this key')
        }
        const data = await agent.revealProviderCredential(params.kind, params.providerId)
        sendJson(response, 200, { data, requestId })
        return
      }
      params = routeMatch(pathname, '/internal/v1/admin/agent/providers/:kind')
      if (params && request.method === 'PUT') {
        requireAgentAdmin(principal)
        if (typeof agent?.updateSetting !== 'function') {
          throw new AppError(503, 'agent_settings_unavailable', 'Dynamic provider settings require PostgreSQL')
        }
        const data = await agent.updateSetting(
          params.kind,
          await readJson(request, 64 * 1024),
          { updatedBy: 'admin-token' },
        )
        sendJson(response, data.runtimeApplied === false ? 202 : 200, {
          data,
          requestId,
        })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/agent/sequences/:sequenceKey/test')
      if (params && request.method === 'POST') {
        requireAgentAdmin(principal)
        if (typeof agent?.testSequence !== 'function') {
          throw new AppError(503, 'agent_control_unavailable', 'LLM Sequence testing requires PostgreSQL')
        }
        const body = await readJson(request, 16 * 1024)
        const data = await agent.testSequence(params.sequenceKey, { kind: body?.kind })
        sendJson(response, 200, { data, requestId })
        return
      }
      params = routeMatch(pathname, '/internal/v1/admin/agent/sequences/:sequenceKey/default')
      if (params && request.method === 'PUT') {
        requireAgentAdmin(principal)
        if (typeof agent?.setDefaultSequence !== 'function') {
          throw new AppError(503, 'agent_control_unavailable', 'LLM Sequence settings require PostgreSQL')
        }
        const body = await readJson(request, 16 * 1024)
        const data = await agent.setDefaultSequence(
          body?.kind,
          params.sequenceKey,
          body,
          { updatedBy: 'admin-token' },
        )
        sendJson(response, data.runtimeApplied === false ? 202 : 200, { data, requestId })
        return
      }
      params = routeMatch(pathname, '/internal/v1/admin/agent/sequences/:sequenceKey')
      if (params && request.method === 'PUT') {
        requireAgentAdmin(principal)
        if (typeof agent?.saveSequence !== 'function') {
          throw new AppError(503, 'agent_control_unavailable', 'LLM Sequence settings require PostgreSQL')
        }
        const data = await agent.saveSequence(
          params.sequenceKey,
          await readJson(request, 64 * 1024),
          { updatedBy: 'admin-token' },
        )
        sendJson(response, data.runtimeApplied === false ? 202 : 200, { data, requestId })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/agent/proxies/endpoints/:proxyKey')
      if (params && request.method === 'PUT') {
        requireAgentAdmin(principal)
        const data = await agent.saveProxyEndpoint(
          params.proxyKey,
          await readJson(request, 32 * 1024),
          { updatedBy: 'admin-token' },
        )
        sendJson(response, data.runtimeApplied === false ? 202 : 200, { data, requestId })
        return
      }
      params = routeMatch(pathname, '/internal/v1/admin/agent/proxies/sequences/:sequenceKey')
      if (params && request.method === 'PUT') {
        requireAgentAdmin(principal)
        const data = await agent.saveProxySequence(
          params.sequenceKey,
          await readJson(request, 32 * 1024),
          { updatedBy: 'admin-token' },
        )
        sendJson(response, data.runtimeApplied === false ? 202 : 200, { data, requestId })
        return
      }
      if (pathname === '/internal/v1/admin/agent/proxies/default' && request.method === 'PUT') {
        requireAgentAdmin(principal)
        const body = await readJson(request, 16 * 1024)
        const data = await agent.setGlobalProxySequence(
          body?.sequenceKey ?? null,
          body,
          { updatedBy: 'admin-token' },
        )
        sendJson(response, data.runtimeApplied === false ? 202 : 200, { data, requestId })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/agent/pipelines/:pipelineKey')
      if (params && request.method === 'PUT') {
        requireAgentAdmin(principal)
        if (!agentPipelines) {
          throw new AppError(503, 'agent_pipeline_unavailable', 'Agent pipelines require PostgreSQL')
        }
        const data = await agentPipelines.updatePipeline(
          params.pipelineKey,
          await readJson(request, 16 * 1024),
          { updatedBy: 'admin-token' },
        )
        sendJson(response, 200, { data, requestId })
        return
      }
      params = routeMatch(pathname, '/internal/v1/admin/agent/pipelines/:pipelineKey/materialize')
      if (params && request.method === 'POST') {
        requireAgentAdmin(principal)
        if (!agentPipelines) {
          throw new AppError(503, 'agent_pipeline_unavailable', 'Agent pipelines require PostgreSQL')
        }
        const data = await agentPipelines.materializeCurrent(params.pipelineKey)
        sendJson(response, 202, { data, requestId })
        return
      }
      params = routeMatch(pathname, '/internal/v1/admin/agent/pipelines/:pipelineKey/retry-dead')
      if (params && request.method === 'POST') {
        requireAgentAdmin(principal)
        if (!agentPipelines) {
          throw new AppError(503, 'agent_pipeline_unavailable', 'Agent pipelines require PostgreSQL')
        }
        const data = await agentPipelines.retryDead(params.pipelineKey)
        sendJson(response, 202, { data, requestId })
        return
      }
      params = routeMatch(pathname, '/internal/v1/admin/agent/pipelines/:pipelineKey/assertions')
      if (params && request.method === 'GET') {
        requirePlatformAdmin(principal)
        if (!agentPipelines) {
          throw new AppError(503, 'agent_pipeline_unavailable', 'Agent pipelines require PostgreSQL')
        }
        const data = await agentPipelines.listAssertions(
          params.pipelineKey,
          searchParams.get('limit') || 20,
        )
        sendJson(response, 200, { data, requestId })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/sources/:key/import')
      if (params && request.method === 'POST') {
        requireSourceAdmin(principal)
        requireImporter()
        assertGenericSourceMutable(params.key)
        requireFileImportLock()
        // Raw body plus a filename query parameter, deliberately not multipart:
        // multipart needs its own parser for attacker-controlled input, and this
        // path already accepts untrusted spreadsheets.
        const buffer = await readBuffer(request)
        const result = await withSourceLocks([params.key], (
          assertOwned = async () => {},
          sessionClients = [],
        ) => {
          const sessionClient = sessionClients[0]
          if (!sessionClient) {
            throw new AppError(503, 'source_lock_unavailable', 'File import lock session is unavailable')
          }
          return importer.importFile({
            sourceKey: params.key,
            buffer,
            filename: requiredQuery(searchParams, 'filename'),
            assertOwned,
            sessionClient,
          })
        })
        sendJson(response, result.status === 'skipped' ? 200 : 201, { data: result, requestId })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/sources/:key/server-import')
      if (params && request.method === 'POST') {
        requireSourceAdmin(principal)
        requireImporter()
        assertGenericSourceMutable(params.key)
        requireFileImportLock()
        const initialSource = await requireSource(params.key)
        requireServerPathSource(initialSource)
        const body = await readJson(request, 64 * 1024)
        if (!/^[0-9a-f]{64}$/.test(body.expectedSha256 || '')) {
          throw new AppError(400, 'invalid_expected_sha256', 'Preview inputSha256 is required before a server-file import')
        }
        const result = await withSourceLocks([params.key], async (
          assertOwned = async () => {},
          sessionClients = [],
        ) => {
          const sessionClient = sessionClients[0]
          if (!sessionClient) {
            throw new AppError(503, 'source_lock_unavailable', 'File import lock session is unavailable')
          }
          const source = await requireSource(params.key)
          const file = await readServerSourceFile(source, body.serverPath)
          if (file.inputSha256 !== body.expectedSha256) {
            throw new AppError(409, 'server_file_changed', 'Server file changed after preview; preview it again before importing')
          }
          const structurePreview = await importer.preview(file.buffer, file.filename)
          const activeMapping = await store.getActiveMapping(source.id)
          if (activeMapping?.schemaFingerprint
            && activeMapping.schemaFingerprint !== structurePreview.schemaFingerprint) {
            throw new AppError(409, 'file_schema_drift', 'Server file structure differs from the approved mapping; preview and approve the new structure')
          }
          const imported = await importer.importFile({
            sourceKey: params.key,
            buffer: file.buffer,
            filename: file.filename,
            assertOwned,
            sessionClient,
          })
          if (typeof store.recordFileObservation === 'function') {
            await store.recordFileObservation({
              sourceId: source.id,
              rootId: file.rootId,
              relativePath: file.relativePath,
              pathHash: filePathHash(file),
              inputSha256: file.inputSha256,
              inputBytes: file.inputBytes,
              mtime: file.mtime,
              schemaFingerprint: structurePreview.schemaFingerprint,
              formatRuleVersionId: activeMapping?.formatRuleVersionId || null,
              importRunId: imported.importRunId || imported.duplicateOf || null,
              status: 'imported',
            })
          }
          return {
            ...imported,
            file: { rootId: file.rootId, relativePath: file.relativePath },
            schemaFingerprint: structurePreview.schemaFingerprint,
          }
        })
        sendJson(response, result.status === 'skipped' ? 200 : 201, { data: result, requestId })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/sources/:key/imports')
      if (params && request.method === 'GET') {
        requireSourceAdmin(principal)
        const source = await requireSource(params.key)
        sendJson(response, 200, { data: await store.listImportRuns(source.id), requestId })
        return
      }

      // ---- backfill control ----------------------------------------------
      //
      // Backfill is platform-wide, reads Night-All's whole store, and costs
      // real database work, so it requires platform administration rather than
      // any tenant-scoped role.
      if (request.method === 'GET' && pathname === '/internal/v1/admin/backfill') {
        requirePlatformAdmin(principal)
        if (!queue) {
          throw new AppError(503, 'queue_unavailable', 'Backfill requires the PostgreSQL store')
        }
        const cursors = await Promise.all(
          backfillPlatforms.map(async (platform) => [
            platform,
            await queue.getCursor(`backfill:night-all:${platform}`),
          ]),
        )
        sendJson(response, 200, {
          data: {
            platforms: Object.fromEntries(cursors),
            queue: await queue.stats('backfill'),
          },
          requestId,
        })
        return
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/backfill') {
        requirePlatformAdmin(principal)
        if (!queue) {
          throw new AppError(503, 'queue_unavailable', 'Backfill requires the PostgreSQL store')
        }
        const body = await readJson(request)
        const platform = body?.platform
        // Only configured platforms: an arbitrary name would fall through the
        // generic normalizer and produce lower-fidelity canonical rows silently.
        if (!backfillPlatforms.includes(platform)) {
          throw new AppError(400, 'platform_not_backfillable', 'Platform is not configured for backfill', {
            supported: backfillPlatforms,
          })
        }
        const jobId = await queue.enqueue(
          'backfill',
          { platform, since: body?.since ?? null, maxPages: body?.maxPages ?? 50, chunk: 0 },
          { dedupeKey: `backfill:${platform}:0`, priority: 200 },
        )
        sendJson(response, 202, {
          // A null id means an identical backfill is already outstanding, which
          // is a success: the work the caller asked for is already scheduled.
          data: { platform, jobId, alreadyScheduled: jobId === null },
          requestId,
        })
        return
      }

      // ---- membership administration ------------------------------------
      if (request.method === 'GET' && pathname === '/internal/v1/admin/members') {
        requirePlatformAdmin(principal)
        sendJson(response, 200, { data: await store.listMembers(), requestId })
        return
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/members/memberships') {
        const body = await readJson(request)
        requireTenantCapability(principal, body?.tenantId, 'membership.write')
        const granted = await store.grantTenantMembership({
          memberId: body?.memberId,
          tenantId: body?.tenantId,
          role: body?.role,
          grantedBy: principal.memberId || 'admin-token',
        })
        // The introspection cache holds the old membership set, so a grant would
        // otherwise take effect only after the TTL elapsed.
        identity?.client?.invalidate?.()
        sendJson(response, 201, { data: granted, requestId })
        return
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/members/memberships/revoke') {
        const body = await readJson(request)
        requireTenantCapability(principal, body?.tenantId, 'membership.write')
        const revoked = await store.revokeTenantMembership({
          memberId: body?.memberId,
          tenantId: body?.tenantId,
          revokedBy: principal.memberId || 'admin-token',
        })
        identity?.client?.invalidate?.()
        sendJson(response, 200, { data: revoked, requestId })
        return
      }

      if (request.method === 'GET' && pathname === '/api/v1/data/capabilities') {
        const context = await requirePublic(request)
        const payload = await service.capabilities(context)
        sendJson(response, 200, { ...payload, requestId })
        return
      }
      if (request.method === 'POST' && pathname === '/api/v1/tools/tokenize') {
        const context = await requirePublic(request)
        const result = await service.tokenize(context, {
          body: await readJson(request, 16 * 1024),
          idempotencyKey: request.headers['idempotency-key'],
        })
        sendJson(response, result.status, { ...result.body, requestId: result.requestId }, {
          'x-mx-insight-request-id': result.requestId,
          'idempotent-replay': String(result.replay),
        })
        return
      }
      params = routeMatch(pathname, '/api/v1/night-all/search/:operation')
      if (request.method === 'POST' && params) {
        const context = await requirePublic(request)
        const result = await service.nightAllCompatibilitySearch(context, {
          operation: params.operation,
          body: await readJson(request),
          idempotencyKey: request.headers['idempotency-key'],
          path: pathname,
        })
        // Keep Night-All's own requestId and legacy envelope in the body. The
        // Hub request id is transport metadata exposed by the response header.
        sendJson(response, result.status, result.body, {
          'idempotent-replay': String(result.replay),
          'x-mx-insight-request-id': result.requestId,
          'x-mx-insight-source-mode': result.sourceMode,
          ...(result.capturedAt ? { 'x-mx-insight-captured-at': result.capturedAt } : {}),
          ...(result.staleAgeSeconds != null ? { age: String(result.staleAgeSeconds) } : {}),
          ...(result.sourceMode === 'stale' ? { warning: '110 - "Response is stale"' } : {}),
        })
        return
      }
      if (request.method === 'GET' && pathname === '/api/v1/data/telegram/entities/search') {
        const context = await requirePublic(request)
        sendJson(response, 200, {
          data: await service.telegramEntities(context, Object.fromEntries(searchParams.entries())),
          requestId,
        })
        return
      }
      if (request.method === 'GET' && pathname === '/api/v1/data/source-catalog/metadata') {
        const context = await requirePublic(request)
        sendJson(response, 200, {
          data: await service.sourceCatalogMetadata(
            context,
            Object.fromEntries(searchParams.entries()),
          ),
          requestId,
        })
        return
      }
      if (request.method === 'GET' && pathname === '/api/v1/data/source-catalog') {
        const context = await requirePublic(request)
        sendJson(response, 200, {
          data: await service.sourceCatalog(context, Object.fromEntries(searchParams.entries())),
          requestId,
        })
        return
      }
      params = routeMatch(pathname, '/api/v1/data/source-catalog/:id')
      if (request.method === 'GET' && params) {
        const context = await requirePublic(request)
        sendJson(response, 200, {
          data: await service.sourceCatalogDetail(
            context,
            params.id,
            Object.fromEntries(searchParams.entries()),
          ),
          requestId,
        })
        return
      }
      if (request.method === 'GET' && pathname === '/api/v1/data/public-opinion/regions') {
        const context = await requirePublic(request)
        sendJson(response, 200, {
          data: await service.publicOpinionRegions(
            context,
            Object.fromEntries(searchParams.entries()),
          ),
          requestId,
        })
        return
      }
      params = routeMatch(pathname, '/api/v1/data/public-opinion/regions/:region/items')
      if (request.method === 'GET' && params) {
        const context = await requirePublic(request)
        sendJson(response, 200, {
          data: await service.publicOpinionRegion(
            context,
            params.region,
            Object.fromEntries(searchParams.entries()),
          ),
          requestId,
        })
        return
      }
      params = routeMatch(pathname, '/api/v1/data/public-opinion/provinces/:province/items')
      if (request.method === 'GET' && params) {
        const context = await requirePublic(request)
        sendJson(response, 200, {
          data: await service.publicOpinionProvince(
            context,
            params.province,
            Object.fromEntries(searchParams.entries()),
          ),
          requestId,
        })
        return
      }
      if (request.method === 'GET' && pathname === '/api/v1/data/public-opinion/province-coverage') {
        const context = await requirePublic(request)
        sendJson(response, 200, {
          data: await service.publicOpinionCoverage(
            context,
            Object.fromEntries(searchParams.entries()),
          ),
          requestId,
        })
        return
      }
      if (request.method === 'GET' && pathname === '/api/v1/data/public-opinion/funnel') {
        const context = await requirePublic(request)
        sendJson(response, 200, {
          data: await service.publicOpinionDiagnosticsFunnel(
            context,
            Object.fromEntries(searchParams.entries()),
          ),
          requestId,
        })
        return
      }
      if (request.method === 'GET' && pathname === '/api/v1/data/public-opinion/records') {
        const context = await requirePublic(request)
        sendJson(response, 200, {
          data: await service.publicOpinionDiagnosticsRecords(
            context,
            Object.fromEntries(searchParams.entries()),
          ),
          requestId,
        })
        return
      }
      params = routeMatch(pathname, '/api/v1/data/public-opinion/records/:id')
      if (request.method === 'GET' && params) {
        const context = await requirePublic(request)
        sendJson(response, 200, {
          data: await service.publicOpinionDiagnosticsRecord(
            context,
            params.id,
            Object.fromEntries(searchParams.entries()),
          ),
          requestId,
        })
        return
      }
      params = routeMatch(pathname, '/api/v1/data/public-opinion/items/:id')
      if (request.method === 'GET' && params) {
        const context = await requirePublic(request)
        sendJson(response, 200, {
          data: await service.publicOpinionItem(
            context,
            params.id,
            Object.fromEntries(searchParams.entries()),
          ),
          requestId,
        })
        return
      }
      if (request.method === 'POST' && pathname === '/api/v1/data/telegram/search') {
        const context = await requirePublic(request)
        const result = await service.search(context, {
          body: await readJson(request),
          idempotencyKey: request.headers['idempotency-key'],
          path: pathname,
        })
        sendJson(response, result.status, { ...result.body, requestId: result.requestId }, {
          'idempotent-replay': String(result.replay),
          'x-mx-insight-request-id': result.requestId,
        })
        return
      }
      if (request.method === 'POST' && pathname === '/api/v1/data/stored/search') {
        const context = await requirePublic(request)
        const result = await service.storedSearch(context, {
          body: await readJson(request),
          idempotencyKey: request.headers['idempotency-key'],
          path: pathname,
        })
        sendJson(response, result.status, { ...result.body, requestId: result.requestId }, {
          'idempotent-replay': String(result.replay),
          'x-mx-insight-request-id': result.requestId,
        })
        return
      }
      params = routeMatch(pathname, '/api/v1/data/canonical/items/:id/context')
      if (request.method === 'GET' && params) {
        const context = await requirePublic(request)
        sendJson(response, 200, {
          data: await service.canonicalContext(
            context,
            params.id,
            Object.fromEntries(searchParams.entries()),
          ),
          requestId,
        })
        return
      }
      if (request.method === 'POST' && pathname === '/api/v1/data/canonical/search') {
        const context = await requirePublic(request)
        const result = await service.canonicalSearch(context, {
          body: await readJson(request),
          idempotencyKey: request.headers['idempotency-key'],
          path: pathname,
        })
        sendJson(response, result.status, { ...result.body, requestId: result.requestId }, {
          'idempotent-replay': String(result.replay),
          'x-mx-insight-request-id': result.requestId,
        })
        return
      }
      params = routeMatch(pathname, '/api/v1/data/telegram/:resource')
      if (request.method === 'GET' && params) {
        const context = await requirePublic(request)
        sendJson(response, 200, {
          data: await service.telegramMonitor(
            context,
            params.resource,
            Object.fromEntries(searchParams.entries()),
          ),
          requestId,
        })
        return
      }
      if (request.method === 'POST' && pathname === '/api/v1/data/search') {
        const context = await requirePublic(request)
        const result = await service.search(context, {
          body: await readJson(request),
          idempotencyKey: request.headers['idempotency-key'],
          path: pathname,
        })
        sendJson(response, result.status, { ...result.body, requestId: result.requestId }, {
          'idempotent-replay': String(result.replay),
          'x-mx-insight-request-id': result.requestId,
        })
        return
      }
      params = routeMatch(pathname, '/api/v1/requests/:id')
      if (request.method === 'GET' && params) {
        const context = await requirePublic(request)
        sendJson(response, 200, { data: await service.requestStatus(context, params.id), requestId })
        return
      }
      if (request.method === 'GET' && pathname === '/api/v1/usage') {
        const context = await requirePublic(request)
        sendJson(response, 200, {
          data: await service.publicUsage(context, queryFilters(searchParams)),
          requestId,
        })
        return
      }

      if (
        request.method === 'GET' &&
        listenerMode !== 'public' &&
        !pathname.startsWith('/api/') &&
        !pathname.startsWith('/internal/') &&
        !pathname.startsWith('/health') &&
        await serveSpa(pathname, response, staticRoot)
      ) return

      throw new AppError(404, 'not_found', 'Route not found')
    } catch (error) {
      const appError = error instanceof AppError
        ? error
        : new AppError(500, 'internal_error', 'Internal server error')
      if (!(error instanceof AppError)) logger.error?.({ requestId, error }, 'request failed')
      sendJson(response, appError.status, {
        error: {
          code: appError.code,
          message: appError.message,
          ...(appError.details ? { details: appError.details } : {}),
        },
        requestId,
      })
    }
  }
}
