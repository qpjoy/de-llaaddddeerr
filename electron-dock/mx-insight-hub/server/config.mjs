import { loadCommonConfig } from '@qpjoy/mx-common'
import { AppError } from './core/errors.mjs'
import { parseServerFileRoots } from './ingest/external/server-files.mjs'

export const PRODUCT_ID = 'mx-insight-hub'

const KUBERNETES_ELASTICSEARCH_URL =
  'http://mx-common-elasticsearch.mx-common.svc.cluster.local:9200'

const DEPLOYMENT_EGRESS_FIELDS = new Set([
  'version',
  'configured',
  'sourceKind',
  'runtimeKind',
  'httpProxy',
  'httpsProxy',
  'noProxy',
  'sourceLocations',
  'nodeName',
  'observedAt',
])
const DEPLOYMENT_EGRESS_RUNTIME_KINDS = new Set([
  'kubernetes-host-network',
  'docker-compose-bridge',
  'host-process',
])
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

function normalizedDeploymentProxy(value, field) {
  if (value == null) return null
  if (typeof value !== 'string' || value.length > 2048) {
    throw new AppError(500, 'invalid_configuration', `${field} must be a valid HTTP(S) proxy URL or null`)
  }
  let parsed
  try { parsed = new URL(value) } catch {
    throw new AppError(500, 'invalid_configuration', `${field} must be a valid HTTP(S) proxy URL or null`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.search || parsed.hash
    || (parsed.pathname !== '' && parsed.pathname !== '/')) {
    throw new AppError(500, 'invalid_configuration', `${field} must be an HTTP(S) proxy origin without path, query or fragment`)
  }
  return parsed.toString().replace(/\/$/, '')
}

export function parseDeploymentEgressSnapshot(raw) {
  if (raw == null || String(raw).trim() === '') {
    return {
      version: 1,
      configured: false,
      sourceKind: null,
      runtimeKind: null,
      httpProxy: null,
      httpsProxy: null,
      noProxy: null,
      sourceLocations: [],
      nodeName: null,
      observedAt: null,
    }
  }
  let snapshot
  try { snapshot = JSON.parse(raw) } catch {
    throw new AppError(500, 'invalid_configuration', 'MX_INSIGHT_AGENT_DOCKER_PROXY_SNAPSHOT must be valid JSON')
  }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new AppError(500, 'invalid_configuration', 'MX_INSIGHT_AGENT_DOCKER_PROXY_SNAPSHOT must be a JSON object')
  }
  for (const field of Object.keys(snapshot)) {
    if (!DEPLOYMENT_EGRESS_FIELDS.has(field)) {
      throw new AppError(500, 'invalid_configuration', `MX_INSIGHT_AGENT_DOCKER_PROXY_SNAPSHOT contains unsupported field ${field}`)
    }
  }
  for (const field of DEPLOYMENT_EGRESS_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, field)) {
      throw new AppError(500, 'invalid_configuration', `MX_INSIGHT_AGENT_DOCKER_PROXY_SNAPSHOT is missing ${field}`)
    }
  }
  if (snapshot.version !== 1) {
    throw new AppError(500, 'invalid_configuration', 'MX_INSIGHT_AGENT_DOCKER_PROXY_SNAPSHOT.version must be 1')
  }
  if (typeof snapshot.configured !== 'boolean') {
    throw new AppError(500, 'invalid_configuration', 'MX_INSIGHT_AGENT_DOCKER_PROXY_SNAPSHOT.configured must be boolean')
  }
  if (snapshot.sourceKind !== 'docker-daemon-effective') {
    throw new AppError(500, 'invalid_configuration', 'MX_INSIGHT_AGENT_DOCKER_PROXY_SNAPSHOT.sourceKind must be docker-daemon-effective')
  }
  if (!DEPLOYMENT_EGRESS_RUNTIME_KINDS.has(snapshot.runtimeKind)) {
    throw new AppError(500, 'invalid_configuration', 'MX_INSIGHT_AGENT_DOCKER_PROXY_SNAPSHOT.runtimeKind is unsupported')
  }
  const httpProxy = normalizedDeploymentProxy(snapshot.httpProxy, 'MX_INSIGHT_AGENT_DOCKER_PROXY_SNAPSHOT.httpProxy')
  const httpsProxy = normalizedDeploymentProxy(snapshot.httpsProxy, 'MX_INSIGHT_AGENT_DOCKER_PROXY_SNAPSHOT.httpsProxy')
  if (snapshot.configured !== Boolean(httpProxy || httpsProxy)) {
    throw new AppError(500, 'invalid_configuration', 'MX_INSIGHT_AGENT_DOCKER_PROXY_SNAPSHOT.configured must match the effective proxy URLs')
  }
  if (snapshot.noProxy != null && (
    typeof snapshot.noProxy !== 'string'
    || snapshot.noProxy.length > 8192
    || /[\0\r\n]/.test(snapshot.noProxy)
  )) {
    throw new AppError(500, 'invalid_configuration', 'MX_INSIGHT_AGENT_DOCKER_PROXY_SNAPSHOT.noProxy must be a bounded single-line string or null')
  }
  if (!Array.isArray(snapshot.sourceLocations) || snapshot.sourceLocations.length > 32
    || snapshot.sourceLocations.some((value) => (
      typeof value !== 'string' || !value || value.length > 512 || /[\0\r\n]/.test(value)
    ))) {
    throw new AppError(500, 'invalid_configuration', 'MX_INSIGHT_AGENT_DOCKER_PROXY_SNAPSHOT.sourceLocations must contain bounded strings')
  }
  if (snapshot.nodeName != null && (
    typeof snapshot.nodeName !== 'string'
    || !snapshot.nodeName
    || snapshot.nodeName.length > 253
    || /[\0\r\n]/.test(snapshot.nodeName)
  )) {
    throw new AppError(500, 'invalid_configuration', 'MX_INSIGHT_AGENT_DOCKER_PROXY_SNAPSHOT.nodeName must be a bounded string or null')
  }
  if (typeof snapshot.observedAt !== 'string'
    || !RFC3339_PATTERN.test(snapshot.observedAt)
    || !Number.isFinite(Date.parse(snapshot.observedAt))) {
    throw new AppError(500, 'invalid_configuration', 'MX_INSIGHT_AGENT_DOCKER_PROXY_SNAPSHOT.observedAt must be RFC3339')
  }
  return {
    version: 1,
    configured: snapshot.configured,
    sourceKind: snapshot.sourceKind,
    runtimeKind: snapshot.runtimeKind,
    httpProxy,
    httpsProxy,
    noProxy: snapshot.noProxy == null ? null : snapshot.noProxy.trim(),
    sourceLocations: [...snapshot.sourceLocations],
    nodeName: snapshot.nodeName,
    observedAt: snapshot.observedAt,
  }
}

function positiveInteger(value, fallback, name) {
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AppError(500, 'invalid_configuration', `${name} must be a positive integer`)
  }
  return parsed
}

function boundedNonNegativeInteger(value, fallback, name, maximum) {
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new AppError(500, 'invalid_configuration', `${name} must be an integer between 0 and ${maximum}`)
  }
  return parsed
}

function required(environment, name) {
  const value = environment[name]?.trim()
  if (!value) throw new AppError(500, 'invalid_configuration', `${name} is required`)
  return value
}

function optionalNonNegativeInteger(value, name) {
  if (value == null || value === '') return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new AppError(500, 'invalid_configuration', `${name} must be a non-negative safe integer`)
  }
  return parsed
}

function binaryFlag(value, name) {
  if (value == null || value === '') return false
  if (value !== '0' && value !== '1') {
    throw new AppError(500, 'invalid_configuration', `${name} must be 0 or 1`)
  }
  return value === '1'
}

function unknownJustOneBilling() {
  return {
    source: 'unknown',
    currency: null,
    pricingAsOf: null,
    freeDailyCalls: null,
    monthlyBudgetMinor: null,
    unitCostMinorByEndpoint: {},
  }
}

function parseJustOneBilling(raw) {
  if (raw == null || String(raw).trim() === '') {
    return unknownJustOneBilling()
  }
  let value
  try { value = JSON.parse(raw) } catch {
    throw new AppError(500, 'invalid_configuration', 'MX_INSIGHT_JUSTONE_BILLING_JSON must be valid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(500, 'invalid_configuration', 'MX_INSIGHT_JUSTONE_BILLING_JSON must be an object')
  }
  const supported = new Set([
    'source', 'currency', 'pricingAsOf', 'freeDailyCalls',
    'monthlyBudgetMinor', 'unitCostMinorByEndpoint',
  ])
  const unknown = Object.keys(value).filter((key) => !supported.has(key))
  if (unknown.length > 0) {
    throw new AppError(500, 'invalid_configuration', `MX_INSIGHT_JUSTONE_BILLING_JSON contains unsupported field ${unknown[0]}`)
  }
  if (value.source != null && value.source !== 'manual') {
    throw new AppError(500, 'invalid_configuration', 'JustOne billing source must be manual until a provider API is verified')
  }
  const currency = value.currency == null ? null : String(value.currency).toUpperCase()
  if (currency != null && !/^[A-Z]{3}$/.test(currency)) {
    throw new AppError(500, 'invalid_configuration', 'JustOne billing currency must be a three-letter code')
  }
  let pricingAsOf = null
  if (value.pricingAsOf != null) {
    pricingAsOf = new Date(value.pricingAsOf)
    if (Number.isNaN(pricingAsOf.getTime())) {
      throw new AppError(500, 'invalid_configuration', 'JustOne pricingAsOf must be an ISO date')
    }
    pricingAsOf = pricingAsOf.toISOString()
  }
  const costs = value.unitCostMinorByEndpoint ?? {}
  if (!costs || typeof costs !== 'object' || Array.isArray(costs)) {
    throw new AppError(500, 'invalid_configuration', 'JustOne unitCostMinorByEndpoint must be an object')
  }
  const unitCostMinorByEndpoint = {}
  for (const [endpoint, cost] of Object.entries(costs)) {
    if (!/^[a-z][a-z0-9._-]{0,127}$/.test(endpoint)) {
      throw new AppError(500, 'invalid_configuration', 'JustOne billing endpoint keys must be stable identifiers')
    }
    unitCostMinorByEndpoint[endpoint] = optionalNonNegativeInteger(
      cost,
      `JustOne unit cost for ${endpoint}`,
    )
  }
  if (Object.keys(unitCostMinorByEndpoint).length > 0 && (!currency || !pricingAsOf)) {
    throw new AppError(
      500,
      'invalid_configuration',
      'JustOne estimated prices require currency and pricingAsOf',
    )
  }
  return {
    source: 'manual',
    currency,
    pricingAsOf,
    freeDailyCalls: optionalNonNegativeInteger(value.freeDailyCalls, 'JustOne freeDailyCalls'),
    monthlyBudgetMinor: optionalNonNegativeInteger(
      value.monthlyBudgetMinor,
      'JustOne monthlyBudgetMinor',
    ),
    unitCostMinorByEndpoint,
  }
}

export function parseJustOneConfig(environment = process.env, {
  reservationLeaseMs = positiveInteger(
    environment.MX_INSIGHT_RESERVATION_LEASE_MS,
    150_000,
    'MX_INSIGHT_RESERVATION_LEASE_MS',
  ),
} = {}) {
  const token = environment.MX_INSIGHT_JUSTONE_TOKEN?.trim() || null
  if (token && token.length > 4_096) {
    throw new AppError(
      500,
      'invalid_configuration',
      'MX_INSIGHT_JUSTONE_TOKEN must not exceed 4096 characters',
    )
  }
  const configuredSignal = binaryFlag(
    environment.MX_INSIGHT_JUSTONE_CONFIGURED,
    'MX_INSIGHT_JUSTONE_CONFIGURED',
  )
  const contractVerified = binaryFlag(
    environment.MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED,
    'MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED',
  )
  const timeoutMs = positiveInteger(
    environment.MX_INSIGHT_JUSTONE_TIMEOUT_MS,
    120_000,
    'MX_INSIGHT_JUSTONE_TIMEOUT_MS',
  )
  if (timeoutMs > 120_000) {
    throw new AppError(
      500,
      'invalid_configuration',
      'MX_INSIGHT_JUSTONE_TIMEOUT_MS must not exceed 120000',
    )
  }
  const freshTtlMs = positiveInteger(
    environment.MX_INSIGHT_JUSTONE_FRESH_TTL_MS,
    60_000,
    'MX_INSIGHT_JUSTONE_FRESH_TTL_MS',
  )
  const staleTtlMs = positiveInteger(
    environment.MX_INSIGHT_JUSTONE_STALE_TTL_MS,
    7 * 86_400_000,
    'MX_INSIGHT_JUSTONE_STALE_TTL_MS',
  )
  if (staleTtlMs < freshTtlMs) {
    throw new AppError(
      500,
      'invalid_configuration',
      'MX_INSIGHT_JUSTONE_STALE_TTL_MS must be greater than or equal to MX_INSIGHT_JUSTONE_FRESH_TTL_MS',
    )
  }
  if (token && reservationLeaseMs < timeoutMs + 30_000) {
    throw new AppError(
      500,
      'invalid_configuration',
      'MX_INSIGHT_RESERVATION_LEASE_MS must be at least MX_INSIGHT_JUSTONE_TIMEOUT_MS plus 30000 when a JustOne token is configured',
    )
  }
  const configured = Boolean(token) || configuredSignal
  return {
    // The provider host and endpoint paths are compiled into the adapter.
    // Keeping them out of env prevents this paid connector from becoming an
    // arbitrary URL proxy. Absence of a token disables only this provider.
    token,
    // Split listeners keep the paid credential on the public data plane. The
    // admin plane receives only these non-secret deployment facts.
    configured,
    contractVerified,
    dispatchEnabled: Boolean(token && contractVerified),
    configurationError: null,
    timeoutMs,
    freshTtlMs,
    staleTtlMs,
    unknownFingerprintCooldownMs: positiveInteger(
      environment.MX_INSIGHT_JUSTONE_UNKNOWN_FINGERPRINT_COOLDOWN_MS,
      15 * 60_000,
      'MX_INSIGHT_JUSTONE_UNKNOWN_FINGERPRINT_COOLDOWN_MS',
    ),
    maxConcurrency: positiveInteger(
      environment.MX_INSIGHT_JUSTONE_MAX_CONCURRENCY,
      8,
      'MX_INSIGHT_JUSTONE_MAX_CONCURRENCY',
    ),
    maxConsumerConcurrency: positiveInteger(
      environment.MX_INSIGHT_JUSTONE_MAX_CONSUMER_CONCURRENCY,
      2,
      'MX_INSIGHT_JUSTONE_MAX_CONSUMER_CONCURRENCY',
    ),
    circuitFailureThreshold: positiveInteger(
      environment.MX_INSIGHT_JUSTONE_CIRCUIT_FAILURES,
      3,
      'MX_INSIGHT_JUSTONE_CIRCUIT_FAILURES',
    ),
    circuitOpenMs: positiveInteger(
      environment.MX_INSIGHT_JUSTONE_CIRCUIT_OPEN_MS,
      60_000,
      'MX_INSIGHT_JUSTONE_CIRCUIT_OPEN_MS',
    ),
    billing: parseJustOneBilling(environment.MX_INSIGHT_JUSTONE_BILLING_JSON),
  }
}

function safeJustOneConfigurationError(error) {
  return {
    code: 'invalid_configuration',
    message: error instanceof AppError && error.code === 'invalid_configuration'
      ? error.message
      : 'JustOne configuration is invalid',
  }
}

function disabledJustOneConfig(environment, error) {
  return {
    token: null,
    configured: Boolean(environment.MX_INSIGHT_JUSTONE_TOKEN?.trim())
      || environment.MX_INSIGHT_JUSTONE_CONFIGURED === '1',
    contractVerified: environment.MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED === '1',
    dispatchEnabled: false,
    configurationError: safeJustOneConfigurationError(error),
    timeoutMs: 120_000,
    freshTtlMs: 60_000,
    staleTtlMs: 7 * 86_400_000,
    unknownFingerprintCooldownMs: 15 * 60_000,
    maxConcurrency: 8,
    maxConsumerConcurrency: 2,
    circuitFailureThreshold: 3,
    circuitOpenMs: 60_000,
    billing: unknownJustOneBilling(),
  }
}

// Deployment scripts call this strict entry point before changing ConfigMaps.
// Unlike loadConfig(), it deliberately rejects a bad optional-provider config.
export function preflightJustOneConfig(environment = process.env) {
  const config = parseJustOneConfig(environment)
  return {
    configured: config.configured,
    contractVerified: config.contractVerified,
    dispatchEnabled: config.dispatchEnabled,
  }
}

export function loadConfig(environment = process.env) {
  const listenerMode = environment.MX_INSIGHT_LISTENER_MODE || 'combined'
  if (!['combined', 'public', 'admin'].includes(listenerMode)) {
    throw new AppError(500, 'invalid_configuration', 'MX_INSIGHT_LISTENER_MODE must be combined, public, or admin')
  }
  const readyMode = environment.NIGHT_ALL_READY_MODE || 'ready_only'
  if (readyMode !== 'ready_only') {
    throw new AppError(500, 'invalid_configuration', 'NIGHT_ALL_READY_MODE must remain ready_only')
  }
  const databaseUrl = environment.DATABASE_URL?.trim() || null
  const storeDriver = environment.MX_INSIGHT_STORE || (databaseUrl ? 'postgres' : 'memory')
  if (!['memory', 'postgres'].includes(storeDriver)) {
    throw new AppError(500, 'invalid_configuration', 'MX_INSIGHT_STORE must be memory or postgres')
  }
  if (storeDriver === 'postgres' && !databaseUrl) {
    throw new AppError(500, 'invalid_configuration', 'DATABASE_URL is required for postgres storage')
  }
  const nightAllTimeoutMs = positiveInteger(environment.NIGHT_ALL_TIMEOUT_MS, 30_000, 'NIGHT_ALL_TIMEOUT_MS')
  // Shared data-plane configuration (Elasticsearch, queue, segmenter). Absent
  // values are not an error: every store described here is an optional
  // accelerator, and the Hub must start and serve without any of them.
  // The owned Kubernetes topology has one stable mx-common Service address.
  // Keep explicit configuration authoritative for external/TLS clusters, but
  // do not persist a transiently empty ConfigMap value as a permanent loss of
  // search discovery. Compose and manual runtimes have no equivalent reliable
  // service contract, so they remain disabled unless configured explicitly.
  const elasticsearchUrl = environment.MX_COMMON_ELASTICSEARCH_URL?.trim()
  const commonEnvironment = !elasticsearchUrl && environment.KUBERNETES_SERVICE_HOST?.trim()
    ? { ...environment, MX_COMMON_ELASTICSEARCH_URL: KUBERNETES_ELASTICSEARCH_URL }
    : environment
  const common = loadCommonConfig(PRODUCT_ID, commonEnvironment)
  common.postgres.url = databaseUrl
  common.queue.redisUrl = common.redis.url
  // mx-common serves products with very different tokenizer capacity. The Hub
  // runs strict, corpus-sized HanLP projections, so its absent-env defaults must
  // stay below the small in-cluster service's admission ceiling. Explicit common
  // settings remain authoritative for deployments that have measured more room.
  if (environment.MX_COMMON_SEGMENTER_CONCURRENCY == null
    || environment.MX_COMMON_SEGMENTER_CONCURRENCY === '') {
    common.segmenter.concurrency = 2
  }
  if (environment.MX_COMMON_SEGMENTER_BATCH_SIZE == null
    || environment.MX_COMMON_SEGMENTER_BATCH_SIZE === '') {
    common.segmenter.batchSize = 16
  }
  common.embedding = {
    // Dimensions are what couple an index mapping to a model, so they are
    // configured explicitly rather than inferred from a model name that may
    // change meaning between providers.
    dimensions: environment.MX_INSIGHT_EMBEDDING_DIMENSIONS
      ? positiveInteger(
          environment.MX_INSIGHT_EMBEDDING_DIMENSIONS,
          null,
          'MX_INSIGHT_EMBEDDING_DIMENSIONS',
        )
      : null,
    model: environment.MX_INSIGHT_EMBEDDING_MODEL?.trim() || null,
  }

  // Central agent. Providers are an ordered failover chain expressed as JSON;
  // see server/agent/providers.mjs. Absent configuration disables the agent and
  // every caller falls back to its deterministic path, so this is additive.
  const agent = {
    chatProviders: environment.MX_INSIGHT_AGENT_PROVIDERS?.trim() || null,
    embeddingProviders: environment.MX_INSIGHT_EMBEDDING_PROVIDERS?.trim() || null,
    // One-time, idempotent import into the database-backed Provider catalog.
    // Set to 0 only for an emergency rollback that must keep env authoritative.
    autoMigrate: environment.MX_INSIGHT_AGENT_AUTO_MIGRATE !== '0',
  }
  const deploymentEgress = parseDeploymentEgressSnapshot(
    environment.MX_INSIGHT_AGENT_DOCKER_PROXY_SNAPSHOT,
  )

  // Federated identity through MX Launcher's User Center. Absent configuration
  // simply disables the federated path; the admin token keeps working, which is
  // what makes this additive rather than a cutover.
  const launcher = {
    baseUrl: environment.MX_INSIGHT_LAUNCHER_URL?.trim() || null,
    audience: environment.MX_INSIGHT_LAUNCHER_AUDIENCE?.trim() || 'mx-insight-hub',
    timeoutMs: positiveInteger(environment.MX_INSIGHT_LAUNCHER_TIMEOUT_MS, 3_000, 'MX_INSIGHT_LAUNCHER_TIMEOUT_MS'),
    // Bounds how long a revoked Launcher token can still be accepted here.
    cacheTtlMs: positiveInteger(environment.MX_INSIGHT_LAUNCHER_CACHE_TTL_MS, 30_000, 'MX_INSIGHT_LAUNCHER_CACHE_TTL_MS'),
    // Launcher scopes that confer Hub platform-admin. Empty by default: nobody
    // becomes a Hub administrator merely by holding a Launcher account, and the
    // list is operator configuration rather than something a token can assert.
    adminScopes: (environment.MX_INSIGHT_LAUNCHER_ADMIN_SCOPES || '')
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean),
  }

  const reservationLeaseMs = positiveInteger(
    environment.MX_INSIGHT_RESERVATION_LEASE_MS,
    Math.max(150_000, nightAllTimeoutMs + 30_000),
    'MX_INSIGHT_RESERVATION_LEASE_MS',
  )
  let justOne
  try {
    justOne = parseJustOneConfig(environment, { reservationLeaseMs })
  } catch (error) {
    // Paid external providers are optional. A bad provider-only value must not
    // take down admin/login, stored reads, or unrelated workers. The strict
    // deploy preflight still rejects it before a ConfigMap can be changed.
    justOne = disabledJustOneConfig(environment, error)
  }

  return {
    common,
    launcher,
    agent,
    deploymentEgress,
    embedding: common.embedding,
    host: environment.MX_INSIGHT_HOST || '0.0.0.0',
    port: positiveInteger(environment.MX_INSIGHT_PORT, 18_180, 'MX_INSIGHT_PORT'),
    listenerMode,
    adminToken: listenerMode === 'public'
      ? environment.MX_INSIGHT_ADMIN_TOKEN?.trim() || null
      : required(environment, 'MX_INSIGHT_ADMIN_TOKEN'),
    apiKeyPepper: required(environment, 'MX_INSIGHT_API_KEY_PEPPER'),
    reservationLeaseMs,
    storeDriver,
    databaseUrl,
    nightAll: {
      baseUrl: environment.NIGHT_ALL_BASE_URL || 'http://127.0.0.1:13141',
      timeoutMs: nightAllTimeoutMs,
      readyMode,
      serviceToken: environment.NIGHT_ALL_SERVICE_TOKEN || null,
      // Separate credential for the bulk export route. Absent means backfill is
      // unavailable while the search path keeps working.
      exportToken: environment.NIGHT_ALL_EXPORT_TOKEN || null,
    },
    justOne,
    backfill: {
      // Platforms the Hub will backfill. Restricted by default to the three
      // with normalizer hooks in server/ingest/normalizers.mjs; anything else
      // would fall through to the generic mapper and produce lower-fidelity
      // canonical rows without anyone noticing.
      platforms: (environment.MX_INSIGHT_BACKFILL_PLATFORMS || 'xiaohongshu,douyin,twitter')
        .split(',')
        .map((platform) => platform.trim())
        .filter(Boolean),
      pageSize: positiveInteger(environment.MX_INSIGHT_BACKFILL_PAGE_SIZE, 200, 'MX_INSIGHT_BACKFILL_PAGE_SIZE'),
    },
    externalPull: {
      intervalMs: positiveInteger(
        environment.MX_INSIGHT_EXTERNAL_PULL_INTERVAL_MS,
        60_000,
        'MX_INSIGHT_EXTERNAL_PULL_INTERVAL_MS',
      ),
      batchSize: positiveInteger(
        environment.MX_INSIGHT_EXTERNAL_PULL_BATCH_SIZE,
        1_000,
        'MX_INSIGHT_EXTERNAL_PULL_BATCH_SIZE',
      ),
      telegramSqlitePageDelayMs: boundedNonNegativeInteger(
        environment.MX_INSIGHT_TELEGRAM_SQLITE_PAGE_DELAY_MS,
        1_000,
        'MX_INSIGHT_TELEGRAM_SQLITE_PAGE_DELAY_MS',
        60_000,
      ),
      provincePageDelayMs: boundedNonNegativeInteger(
        environment.MX_INSIGHT_PROVINCE_PAGE_DELAY_MS,
        2_000,
        'MX_INSIGHT_PROVINCE_PAGE_DELAY_MS',
        60_000,
      ),
    },
    serverFiles: {
      // A deployment-owned allowlist. API requests may paste an absolute path,
      // but the runtime immediately reduces it to one of these stable root IDs
      // plus a relative path before any lineage is stored.
      roots: listenerMode === 'public'
        ? []
        : parseServerFileRoots(environment.MX_INSIGHT_SERVER_FILE_ROOTS),
    },
  }
}
