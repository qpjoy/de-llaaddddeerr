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
    reservationLeaseMs: positiveInteger(
      environment.MX_INSIGHT_RESERVATION_LEASE_MS,
      Math.max(120_000, nightAllTimeoutMs + 30_000),
      'MX_INSIGHT_RESERVATION_LEASE_MS',
    ),
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
