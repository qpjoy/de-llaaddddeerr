import { randomUUID } from 'node:crypto'
import { hmacSecret, issueApiKey, requestFingerprint } from './core/crypto.mjs'
import { AppError, UpstreamAmbiguousError, UpstreamRejectedError, assert } from './core/errors.mjs'
import { NIGHT_ALL_LEGACY_OPERATIONS } from './contracts/night-all-legacy.mjs'
import {
  normalizeTelegramMonitorQuery,
  normalizeTelegramEntityQuery,
  normalizeTelegramSearchQuery,
  publicTelegramMonitorPage,
  publicTelegramMonitorRecord,
  telegramDataSearchResponse,
  telegramMonitorResource,
  telegramStoredDatasetIds,
} from './data/telegram-monitor.mjs'
import {
  canonicalSearchResponse,
  normalizeCanonicalSearchQuery,
  normalizeStoredSearchQuery,
  storedSearchResponse,
} from './data/stored-search.mjs'
import {
  canonicalContextCapability,
  canonicalContextResponse,
  normalizeCanonicalContextQuery,
} from './data/canonical-context.mjs'
import {
  normalizePublicSourceCatalogDetailQuery,
  normalizePublicSourceCatalogId,
  normalizePublicSourceCatalogMetadataQuery,
  normalizePublicSourceCatalogQuery,
  publicSourceCatalogDetail,
  publicSourceCatalogItem,
  publicSourceCatalogMetadata,
  publicSourceCatalogPage,
  SOURCE_CATALOG_PLATFORM,
} from './data/public-source-catalog.mjs'
import {
  PUBLIC_OPINION_ALL_INGESTED_CAPABILITY,
  PUBLIC_OPINION_DIAGNOSTICS_CAPABILITY,
  PUBLIC_OPINION_PLATFORM,
  normalizePublicOpinionCoverageQuery,
  normalizePublicOpinionDetailQuery,
  normalizePublicOpinionItemId,
  normalizePublicOpinionQuery,
  normalizePublicOpinionRegionQuery,
  normalizePublicOpinionRegionsQuery,
  publicOpinionCoverage,
  publicOpinionItem,
  publicOpinionPage,
  publicOpinionRegionPage,
  publicOpinionRegions,
} from './data/public-opinion.mjs'
import {
  normalizePublicOpinionDiagnosticsBrowseQuery,
  publicOpinionDiagnosticsBrowseResponse,
} from './data/public-opinion-diagnostics.mjs'
import {
  MOBILE_COMMERCE_PLATFORM,
  normalizeMobileCommerceQuery,
  publicMobileCommercePage,
} from './data/mobile-commerce.mjs'
import {
  adminPublicOpinionCoverageResponse,
  adminPublicOpinionBrowseItemResponse,
  adminPublicOpinionBrowseResponse,
  adminPublicOpinionFunnelResponse,
  adminPublicOpinionItemResponse,
  adminPublicOpinionProvinceResponse,
  adminPublicOpinionRegionsResponse,
  adminTelegramChatsResponse,
  adminTelegramContextResponse,
  adminTelegramMessagesResponse,
  adminTelegramSearchResponse,
  demoAdminPublicOpinionCoverageRows,
  demoAdminPublicOpinionBrowseItem,
  demoAdminPublicOpinionBrowseRows,
  demoAdminPublicOpinionFunnel,
  demoAdminPublicOpinionItem,
  demoAdminPublicOpinionRows,
  demoAdminTelegramChats,
  demoAdminTelegramContext,
  demoAdminTelegramMessages,
  demoAdminTelegramSearch,
  normalizeAdminPublicOpinionCoverageQuery,
  normalizeAdminPublicOpinionBrowseItemQuery,
  normalizeAdminPublicOpinionBrowseQuery,
  normalizeAdminPublicOpinionFunnelQuery,
  normalizeAdminPublicOpinionItemQuery,
  normalizeAdminPublicOpinionProvinceQuery,
  normalizeAdminPublicOpinionRegionsQuery,
  normalizeAdminTelegramChatsQuery,
  normalizeAdminTelegramContextQuery,
  normalizeAdminTelegramHistoryQuery,
  normalizeAdminTelegramSearchQuery,
} from './data/admin-data-products.mjs'
import {
  canUseNightAllCompatibilityFallback,
  compatibilityUpstreamEvidence,
  nightAllCompatibilityBusinessOutcome,
  nightAllCompatibilityFallbackWindowMs,
  nightAllCompatibilityItemCount,
  normalizeNightAllCompatibilityRequest,
  staleSnapshotAgeSeconds,
} from './data/night-all-compat.mjs'

const DEFAULT_POLICY = Object.freeze({
  maxRequests: 1_000,
  windowSeconds: 3_600,
  maxPageSize: 100,
})
const DEFAULT_API_KEY_LIFETIME_DAYS = 180
const MAX_API_KEY_LIFETIME_DAYS = 730

const PLATFORM_ALIASES = new Map([
  ['x', 'twitter'],
  ['fb', 'facebook'],
  ['ig', 'instagram'],
  ['ins', 'instagram'],
  ['insta', 'instagram'],
  ['li', 'linkedin'],
  ['red', 'xiaohongshu'],
  ['rednote', 'xiaohongshu'],
  ['xhs', 'xiaohongshu'],
  ['wechat', 'wechat_search'],
  ['weixin', 'wechat_search'],
])
const PUBLIC_SEARCH_FIELDS = new Set(['platform', 'query', 'pageSize', 'cursor', 'type'])

/**
 * How long a committed response stays replayable.
 *
 * `fresh` is the default because the Hub indexes continuously: a caller asking
 * the same question a minute later means "what is true now", not "show me what
 * you said before". The window still covers a retry -- which is the only thing
 * an Idempotency-Key was ever meant to make safe -- so a duplicate delivery is
 * absorbed without charging or searching twice, while a genuinely later call
 * sees genuinely later data.
 *
 * `stable` keeps the unbounded replay: one key names one immutable answer, for
 * callers that need a snapshot to stay reproducible across a report, a paging
 * sequence or an audit.
 */
const RESULT_TYPES = new Set(['fresh', 'stable'])
const FRESH_REPLAY_WINDOW_MS = 120_000
const PUBLIC_OPINION_VISIBILITY_CONTRACT = 'public-opinion.publication-visibility.v1'

function publicDataProductContract(response, contractVersion) {
  const payload = { ...response, contractVersion }
  delete payload.demoMode
  return payload
}

function resolveResultType(body) {
  const value = body?.type ?? 'fresh'
  assert(
    typeof value === 'string' && RESULT_TYPES.has(value),
    400,
    'invalid_result_type',
    "type must be 'fresh' (default) or 'stable'",
  )
  return value
}

function replayWindowFor(resultType) {
  return resultType === 'stable' ? null : FRESH_REPLAY_WINDOW_MS
}
const RESERVED_PLATFORM_NAMES = new Set(['*', 'all'])
const TOKENIZE_CAPABILITY = 'nlp.tokenize'
const PUBLIC_CAPABILITIES = new Set([
  TOKENIZE_CAPABILITY,
  PUBLIC_OPINION_ALL_INGESTED_CAPABILITY,
  PUBLIC_OPINION_DIAGNOSTICS_CAPABILITY,
])
const CANONICAL_SEARCH_USAGE_SCOPE = 'data.canonical-search'
const TOKENIZE_MAX_TEXT_LENGTH = 4_096
const TOKENIZE_MAX_TOKENS = 8_192
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function canonicalPlatform(value) {
  const platform = requiredString(value, 'platform').toLowerCase()
  return PLATFORM_ALIASES.get(platform) || platform
}

function canonicalCapability(value) {
  const capability = requiredString(value, 'capability').toLowerCase()
  assert(
    PUBLIC_CAPABILITIES.has(capability),
    400,
    'unsupported_capability',
    'Capability is not supported',
  )
  return capability
}

function requiredString(value, field) {
  assert(typeof value === 'string' && value.trim(), 400, 'invalid_request', `${field} is required`)
  return value.trim()
}

function requiredUuid(value, field) {
  const normalized = requiredString(value, field)
  assert(UUID_PATTERN.test(normalized), 400, 'invalid_request', `${field} must be a UUID`)
  return normalized
}

function optionalUuid(value, field) {
  return value == null || value === '' ? undefined : requiredUuid(value, field)
}

function validateStatus(status) {
  const normalized = status || 'active'
  assert(['active', 'suspended'].includes(normalized), 400, 'invalid_request', 'status must be active or suspended')
  return normalized
}

function usageFilters(filters = {}) {
  const normalized = {
    tenantId: optionalUuid(filters.tenantId, 'tenantId'),
    consumerId: optionalUuid(filters.consumerId, 'consumerId'),
  }
  for (const field of ['from', 'to']) {
    if (filters[field]) {
      const date = new Date(filters[field])
      assert(!Number.isNaN(date.getTime()), 400, 'invalid_request', `${field} must be an ISO date`)
      normalized[field] = date.toISOString()
    }
  }
  return normalized
}

function positiveInteger(value, field, fallback) {
  if (value == null) return fallback
  assert(Number.isInteger(value) && value > 0, 400, 'invalid_request', `${field} must be a positive integer`)
  return value
}

function apiKeyLifetimeDays(value) {
  const days = positiveInteger(value, 'expiresInDays', DEFAULT_API_KEY_LIFETIME_DAYS)
  assert(
    days <= MAX_API_KEY_LIFETIME_DAYS,
    400,
    'invalid_request',
    `expiresInDays must not exceed ${MAX_API_KEY_LIFETIME_DAYS}`,
  )
  return days
}

function optionalNightAllBusinessId(value) {
  if (value == null || value === '') return undefined
  const businessId = requiredString(value, 'businessId')
  assert(
    businessId.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(businessId),
    400,
    'invalid_business_id',
    'businessId must be at most 128 characters and contain no control characters',
  )
  return businessId
}

function compatibilityFailureKind(error) {
  if (error instanceof UpstreamRejectedError) return 'http'
  if (error instanceof UpstreamAmbiguousError && error.cause?.name === 'AbortError') return 'timeout'
  if (error instanceof UpstreamAmbiguousError && error.cause?.name === 'InvalidUpstreamResponseError') return 'contract'
  if (error instanceof UpstreamAmbiguousError) return 'network'
  return 'internal'
}

function compatibilityPublicStatus(error) {
  if (!(error instanceof UpstreamRejectedError)) return 502
  if ([400, 404, 409, 422, 429].includes(error.status)) return error.status
  return 502
}

function compatibilityOperationState(matrix, operation, platform) {
  if (
    matrix?.contractVersion !== 'night-all.legacy-search-capabilities.v1'
    || !matrix.operations
    || typeof matrix.operations !== 'object'
    || Array.isArray(matrix.operations)
  ) return 'invalid'
  for (const requiredOperation of NIGHT_ALL_LEGACY_OPERATIONS) {
    if (matrix.operations[requiredOperation] == null) return 'invalid'
  }
  const capability = matrix.operations[operation]
  if (
    !capability
    || typeof capability !== 'object'
    || !Array.isArray(capability.supportedPlatforms)
    || !Array.isArray(capability.readyPlatforms)
    || capability.supportedPlatforms.some((entry) => typeof entry !== 'string')
    || capability.readyPlatforms.some((entry) => typeof entry !== 'string')
  ) return 'invalid'
  const supported = new Set(capability.supportedPlatforms)
  if (capability.readyPlatforms.some((entry) => !supported.has(entry))) return 'invalid'
  if (!supported.has(platform)) return 'unsupported'
  return capability.readyPlatforms.includes(platform) ? 'ready' : 'unavailable'
}

function compatibilityIdempotencyStateIsDecisive(record, fingerprint) {
  if (!record) return false
  return record.fingerprint !== fingerprint
    || ['committed', 'reserved', 'unknown'].includes(record.status)
}

export class HubService {
  constructor({
    store,
    adapter,
    apiKeyPepper,
    defaultPolicy = DEFAULT_POLICY,
    reservationLeaseMs = 120_000,
    ingestQueueName = 'mx-insight-hub:ingest',
    searchQueries = null,
    segmenter = null,
    logger = console,
  }) {
    this.store = store
    this.adapter = adapter
    this.apiKeyPepper = apiKeyPepper
    this.defaultPolicy = defaultPolicy
    this.reservationLeaseMs = reservationLeaseMs
    // Fully-qualified queue name: the store writes the row directly inside the
    // commit transaction and so cannot go through the queue object's own
    // namespacing.
    this.ingestQueueName = ingestQueueName
    this.searchQueries = searchQueries
    this.segmenter = segmenter
    this.logger = logger
  }

  createTenant(body) {
    return this.store.createTenant({
      name: requiredString(body.name, 'name'),
      status: validateStatus(body.status),
    })
  }

  listTenants() {
    return this.store.listTenants()
  }

  async renameTenant(id, body) {
    const tenantId = requiredUuid(id, 'tenantId')
    const tenant = await this.store.renameTenant(tenantId, requiredString(body.name, 'name'))
    assert(tenant, 404, 'tenant_not_found', 'Tenant not found')
    return tenant
  }

  async createConsumer(body) {
    const tenantId = requiredUuid(body.tenantId, 'tenantId')
    assert(await this.store.getTenant(tenantId), 404, 'tenant_not_found', 'Tenant not found')
    return this.store.createConsumer({
      tenantId,
      name: requiredString(body.name, 'name'),
      status: validateStatus(body.status),
      businessId: optionalNightAllBusinessId(body.businessId),
      defaultCapabilityPolicy: {
        capability: TOKENIZE_CAPABILITY,
        maxRequests: this.defaultPolicy.maxRequests,
        windowSeconds: this.defaultPolicy.windowSeconds,
      },
    })
  }

  listConsumers(tenantId) {
    return this.store.listConsumers(optionalUuid(tenantId, 'tenantId'))
  }

  async createApiKey(body) {
    const consumerId = requiredUuid(body.consumerId, 'consumerId')
    const consumer = await this.store.getConsumer(consumerId)
    assert(consumer, 404, 'consumer_not_found', 'Consumer not found')
    const environment = body.environment || 'live'
    assert(['live', 'test'].includes(environment), 400, 'invalid_request', 'environment must be live or test')
    const expiresInDays = apiKeyLifetimeDays(body.expiresInDays)
    const expiresAt = new Date(Date.now() + expiresInDays * 86_400_000).toISOString()
    const issued = issueApiKey(this.apiKeyPepper, environment)
    const record = await this.store.createApiKey({
      ...issued,
      environment,
      expiresAt,
      tenantId: consumer.tenantId,
      consumerId,
      name: requiredString(body.name, 'name'),
    })
    return { ...record, secret: issued.plaintext }
  }

  listApiKeys(consumerId) {
    return this.store.listApiKeys(optionalUuid(consumerId, 'consumerId'))
  }

  revokeApiKey(id) {
    return this.store.revokeApiKey(requiredUuid(id, 'id'))
  }

  async authenticate(secret) {
    assert(secret, 401, 'api_key_required', 'API key is required')
    const context = await this.store.findApiKeyByDigest(hmacSecret(secret, this.apiKeyPepper))
    assert(context, 401, 'invalid_api_key', 'API key is invalid, expired, or revoked')
    return context
  }

  async getPlatformConfiguration({ tenantId, consumerId }) {
    const normalizedTenantId = optionalUuid(tenantId, 'tenantId')
    const normalizedConsumerId = optionalUuid(consumerId, 'consumerId')
    const allIngestedReady = await this.#publicOpinionRegionServingReady()
    return {
      grants: normalizedConsumerId ? await this.store.listGrants(normalizedConsumerId) : [],
      policies: normalizedConsumerId ? await this.store.listPolicies(normalizedConsumerId) : [],
      capabilityGrants: normalizedConsumerId && typeof this.store.listCapabilityGrants === 'function'
        ? await this.store.listCapabilityGrants(normalizedConsumerId)
        : [],
      capabilityPolicies: normalizedConsumerId && typeof this.store.listCapabilityPolicies === 'function'
        ? await this.store.listCapabilityPolicies(normalizedConsumerId)
        : [],
      availableCapabilities: [
        {
          capability: TOKENIZE_CAPABILITY,
          ready: typeof this.segmenter?.segmentWithMeta === 'function',
        },
        {
          capability: PUBLIC_OPINION_ALL_INGESTED_CAPABILITY,
          ready: allIngestedReady,
        },
        {
          capability: PUBLIC_OPINION_DIAGNOSTICS_CAPABILITY,
          ready: typeof this.store.getAdminPublicOpinionFunnel === 'function'
            && typeof this.store.listAdminPublicOpinionBrowseRecords === 'function'
            && typeof this.store.getAdminPublicOpinionBrowseRecord === 'function',
        },
      ],
    }
  }

  async putPlatformConfiguration(platformParam, body) {
    const platform = canonicalPlatform(platformParam)
    assert(!RESERVED_PLATFORM_NAMES.has(platform), 400, 'invalid_platform', 'Wildcard platform grants are not allowed')
    const tenantId = requiredUuid(body.tenantId, 'tenantId')
    const consumerId = requiredUuid(body.consumerId, 'consumerId')
    const consumer = await this.store.getConsumer(consumerId)
    assert(consumer?.tenantId === tenantId, 404, 'consumer_not_found', 'Consumer not found in tenant')

    const enabled = body.enabled !== false
    await this.store.setPlatformGrant(consumerId, platform, enabled)

    const current = (await this.store.getPolicy(consumerId, platform)) || this.defaultPolicy
    const policy = await this.store.putPolicy({
      tenantId,
      consumerId,
      platform,
      maxRequests: positiveInteger(body.maxRequests, 'maxRequests', current.maxRequests),
      windowSeconds: positiveInteger(body.windowSeconds, 'windowSeconds', current.windowSeconds),
      maxPageSize: positiveInteger(body.maxPageSize, 'maxPageSize', current.maxPageSize),
    })
    return { platform, enabled, policy }
  }

  async putCapabilityConfiguration(capabilityParam, body) {
    const capability = canonicalCapability(capabilityParam)
    assert(body && typeof body === 'object' && !Array.isArray(body), 400, 'invalid_request', 'JSON object body is required')
    const unsupported = Object.keys(body).filter(
      (field) => !['tenantId', 'consumerId', 'enabled', 'maxRequests', 'windowSeconds'].includes(field),
    )
    assert(unsupported.length === 0, 400, 'unsupported_fields', `Unsupported capability fields: ${unsupported.join(', ')}`)
    assert(body.enabled == null || typeof body.enabled === 'boolean', 400, 'invalid_request', 'enabled must be a boolean')
    const tenantId = requiredUuid(body.tenantId, 'tenantId')
    const consumerId = requiredUuid(body.consumerId, 'consumerId')
    const consumer = await this.store.getConsumer(consumerId)
    assert(consumer?.tenantId === tenantId, 404, 'consumer_not_found', 'Consumer not found in tenant')
    assert(
      typeof this.store.putCapabilityConfiguration === 'function'
        && typeof this.store.getCapabilityPolicy === 'function',
      503,
      'capability_store_unavailable',
      'Capability grants require the current Hub database migration',
    )

    const enabled = body.enabled !== false
    const current = (await this.store.getCapabilityPolicy(consumerId, capability)) || this.defaultPolicy
    const policy = await this.store.putCapabilityConfiguration({
      tenantId,
      consumerId,
      capability,
      enabled,
      maxRequests: positiveInteger(body.maxRequests, 'maxRequests', current.maxRequests),
      windowSeconds: positiveInteger(body.windowSeconds, 'windowSeconds', current.windowSeconds),
    })
    return { capability, enabled, policy }
  }

  async dashboard() {
    await this.store.reapStaleReservations()
    return this.store.dashboard()
  }

  async usage(filters) {
    await this.store.reapStaleReservations()
    return this.store.usage(usageFilters(filters))
  }

  async capabilities(context) {
    const grants = await this.store.listGrants(context.consumer.id)
    const canonicalGrants = [...new Set(grants.map((grant) => canonicalPlatform(grant)))]
    const localStoredPlatforms = new Set([
      'telegram',
      PUBLIC_OPINION_PLATFORM,
      SOURCE_CATALOG_PLATFORM,
      MOBILE_COMMERCE_PLATFORM,
    ])
    const nightAllGrants = canonicalGrants.filter((platform) => !localStoredPlatforms.has(platform))
    const payload = nightAllGrants.length > 0
      ? await this.adapter.capabilities(nightAllGrants)
      : { data: { platforms: [], legacySearch: null } }
    if (canonicalGrants.includes('telegram') && typeof this.store.listCanonicalRecords === 'function') {
      const platforms = payload?.data?.platforms
      if (Array.isArray(platforms) && !platforms.some((entry) => (entry?.platform || entry) === 'telegram')) {
        let context = null
        if (
          typeof this.store.getCanonicalContext === 'function'
          && typeof this.store.getCanonicalContextServingIndexStatus === 'function'
        ) {
          try {
            context = canonicalContextCapability(await this.store.getCanonicalContextServingIndexStatus())
          } catch {
            // Capability discovery must not take existing Telegram reads down
            // because the optional context index diagnostic is unavailable.
            context = canonicalContextCapability(null)
            this.logger?.warn?.('[canonical-context] serving index status is unavailable')
          }
        }
        platforms.push({
          platform: 'telegram',
          ready: true,
          source: 'hub',
          servingMode: 'stored',
          capabilities: [
            'monitor_chats',
            'monitor_messages',
            ...(typeof this.store.listAdminTelegramChats === 'function'
              ? ['sqlite_chats']
              : []),
            ...(typeof this.store.listAdminTelegramMessages === 'function'
              ? ['sqlite_messages']
              : []),
            ...(typeof this.store.listAdminTelegramChats === 'function'
              && typeof this.store.getAdminTelegramChat === 'function'
              && typeof this.store.listAdminTelegramMessages === 'function'
              ? ['multi_source_conversations']
              : []),
            ...(typeof this.store.listAdminTelegramChats === 'function'
              ? ['conversation_filter']
              : []),
            'stored_search',
            'entity_search',
            ...(context ? ['message_context'] : []),
          ],
          ...(context ? { context } : {}),
        })
      }
    }
    if (canonicalGrants.includes(PUBLIC_OPINION_PLATFORM) && typeof this.store.listPublicOpinionRecords === 'function') {
      const platforms = payload?.data?.platforms
      if (Array.isArray(platforms) && !platforms.some((entry) => (entry?.platform || entry) === PUBLIC_OPINION_PLATFORM)) {
        const [source, servingIndexes] = await Promise.all([
          typeof this.store.getExternalSource === 'function'
            ? this.store.getExternalSource('province-opinion-results')
            : null,
          typeof this.store.getPublicOpinionServingIndexStatus === 'function'
            ? this.store.getPublicOpinionServingIndexStatus()
            : null,
        ])
        platforms.push({
          platform: PUBLIC_OPINION_PLATFORM,
          ready: source?.status === 'active' && servingIndexes?.ready === true,
          source: 'hub',
          servingMode: 'stored',
          capabilities: [
            'province_feed',
            'province_coverage',
            'region_catalog',
            'region_feed',
            'item_detail',
            'stored_search',
            'diagnostics',
          ],
        })
      }
    }
    if (
      canonicalGrants.includes(SOURCE_CATALOG_PLATFORM)
      && typeof this.store.listSourceCatalogEntries === 'function'
    ) {
      const platforms = payload?.data?.platforms
      if (Array.isArray(platforms) && !platforms.some((entry) => (entry?.platform || entry) === SOURCE_CATALOG_PLATFORM)) {
        platforms.push({
          platform: SOURCE_CATALOG_PLATFORM,
          ready: true,
          source: 'hub',
          servingMode: 'stored',
          capabilities: [
            'catalog_entries',
            'catalog_metadata',
            'catalog_detail',
            'filtered_browse',
            ...(canonicalGrants.includes(MOBILE_COMMERCE_PLATFORM)
              && typeof this.store.listMobileCommerceItems === 'function'
              ? ['catalog_data_items']
              : []),
          ],
        })
      }
    }
    if (
      canonicalGrants.includes(MOBILE_COMMERCE_PLATFORM)
      && typeof this.store.listMobileCommerceItems === 'function'
    ) {
      const platforms = payload?.data?.platforms
      if (Array.isArray(platforms) && !platforms.some((entry) => (entry?.platform || entry) === MOBILE_COMMERCE_PLATFORM)) {
        const source = typeof this.store.getExternalSource === 'function'
          ? await this.store.getExternalSource('mobile-commerce-collected-items')
          : null
        platforms.push({
          platform: MOBILE_COMMERCE_PLATFORM,
          ready: source?.status === 'active',
          source: 'hub',
          servingMode: 'stored',
          capabilities: ['commerce_items', 'marketplace_filter', 'catalog_filter', 'task_filter', 'stored_refresh'],
          remoteFetch: { available: false, status: 'reserved' },
        })
      }
    }
    const capabilityGrants = typeof this.store.listCapabilityGrants === 'function'
      ? await this.store.listCapabilityGrants(context.consumer.id)
      : []
    const allIngestedReady = capabilityGrants.includes(PUBLIC_OPINION_ALL_INGESTED_CAPABILITY)
      ? await this.#publicOpinionRegionServingReady()
      : false
    const diagnosticsReady = typeof this.store.getAdminPublicOpinionFunnel === 'function'
      && typeof this.store.listAdminPublicOpinionBrowseRecords === 'function'
      && typeof this.store.getAdminPublicOpinionBrowseRecord === 'function'
    return {
      ...payload,
      data: {
        ...(payload?.data || {}),
        capabilities: capabilityGrants
          .filter((capability) => PUBLIC_CAPABILITIES.has(capability))
          .map((capability) => ({
            capability,
            ready: capability === TOKENIZE_CAPABILITY
              ? typeof this.segmenter?.segmentWithMeta === 'function'
              : capability === PUBLIC_OPINION_ALL_INGESTED_CAPABILITY
                ? allIngestedReady
                : capability === PUBLIC_OPINION_DIAGNOSTICS_CAPABILITY
                  ? diagnosticsReady
                  : false,
          })),
      },
    }
  }

  async tokenize(context, { body, idempotencyKey }) {
    assert(idempotencyKey, 400, 'idempotency_key_required', 'Idempotency-Key header is required')
    assert(
      typeof idempotencyKey === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey),
      400,
      'invalid_idempotency_key',
      'Idempotency-Key must contain 8-128 safe characters',
    )
    assert(body && typeof body === 'object' && !Array.isArray(body), 400, 'invalid_request', 'JSON object body is required')
    const unsupported = Object.keys(body).filter((field) => field !== 'text')
    assert(unsupported.length === 0, 400, 'unsupported_fields', `Unsupported tokenize fields: ${unsupported.join(', ')}`)
    const text = requiredString(body.text, 'text')
    assert(text.length <= TOKENIZE_MAX_TEXT_LENGTH, 400, 'invalid_request', `text must not exceed ${TOKENIZE_MAX_TEXT_LENGTH} characters`)
    assert(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text), 400, 'invalid_request', 'text contains unsupported control characters')
    assert(/[\p{L}\p{N}]/u.test(text), 400, 'invalid_request', 'text must contain at least one letter or number')

    const grants = typeof this.store.listCapabilityGrants === 'function'
      ? await this.store.listCapabilityGrants(context.consumer.id)
      : []
    assert(grants.includes(TOKENIZE_CAPABILITY), 403, 'capability_not_granted', 'Capability is not granted')
    const policy = {
      ...this.defaultPolicy,
      ...((await this.store.getCapabilityPolicy(context.consumer.id, TOKENIZE_CAPABILITY)) || {}),
    }

    const requestId = randomUUID()
    const startedAt = performance.now()
    const windowStart = new Date(Date.now() - policy.windowSeconds * 1_000)
    await this.store.reapStaleReservations()
    const reservation = await this.store.reserve({
      requestId,
      idempotencyKey,
      fingerprint: requestFingerprint({
        method: 'POST',
        path: '/api/v1/tools/tokenize',
        body: { text },
      }),
      tenantId: context.tenant.id,
      consumerId: context.consumer.id,
      apiKeyId: context.apiKey.id,
      capability: TOKENIZE_CAPABILITY,
      unitsReserved: 1,
      leaseExpiresAt: new Date(Date.now() + this.reservationLeaseMs),
      windowStart,
      // No window: tokens are a pure function of the text, so replaying a
      // committed result is always the same answer, never a stale one.
      maxRequests: policy.maxRequests,
    })
    if (reservation.kind === 'conflict') {
      throw new AppError(409, 'idempotency_conflict', 'Idempotency-Key was used with a different request')
    }
    if (reservation.kind === 'in_progress') {
      throw new AppError(409, 'request_in_progress', 'Request with this Idempotency-Key is in progress', {
        requestId: reservation.request.id,
      })
    }
    if (reservation.kind === 'unknown') {
      throw new AppError(409, 'request_outcome_unknown', 'Previous request outcome is unknown; do not retry automatically', {
        requestId: reservation.request.id,
      })
    }
    if (reservation.kind === 'replay') {
      return {
        status: reservation.request.responseStatus,
        body: reservation.request.responseBody,
        requestId: reservation.request.id,
        replay: true,
      }
    }
    assert(reservation.kind === 'reserved' && reservation.request?.id, 500, 'usage_reservation_failed', 'Tokenizer usage reservation did not enter the expected state')
    const activeRequestId = reservation.request.id
    if (typeof this.segmenter?.segmentWithMeta !== 'function') {
      await this.store.releaseRequest(activeRequestId, 'tokenizer_unavailable').catch(() => {})
      throw new AppError(503, 'tokenizer_unavailable', 'Tokenizer is temporarily unavailable')
    }

    let metadata
    try {
      metadata = await this.segmenter.segmentWithMeta(text)
      assert(metadata && typeof metadata === 'object' && !Array.isArray(metadata), 503, 'tokenizer_invalid_response', 'Tokenizer returned an invalid response')
      assert(Array.isArray(metadata.tokens) && metadata.tokens.length > 0, 503, 'tokenizer_invalid_response', 'Tokenizer returned an invalid response')
      assert(metadata.tokens.length <= TOKENIZE_MAX_TOKENS, 503, 'tokenizer_invalid_response', 'Tokenizer returned an invalid response')
      assert(
        metadata.tokens.every((token) => (
          typeof token === 'string'
            && token.trim()
            && token.length <= 512
            && !/[\u0000-\u001f\u007f]/u.test(token)
        )),
        503,
        'tokenizer_invalid_response',
        'Tokenizer returned an invalid response',
      )
      assert(['hanlp', 'jieba', 'bigram'].includes(metadata.backendUsed), 503, 'tokenizer_invalid_response', 'Tokenizer returned an invalid response')
      assert(typeof metadata.degraded === 'boolean', 503, 'tokenizer_invalid_response', 'Tokenizer returned an invalid response')
    } catch (error) {
      await this.store.releaseRequest(activeRequestId, 'tokenizer_failed').catch(() => {})
      if (error instanceof AppError) throw error
      throw new AppError(503, 'tokenizer_unavailable', 'Tokenizer is temporarily unavailable')
    }

    const safeErrorCode = metadata.errorCode == null
      ? null
      : typeof metadata.errorCode === 'string' && /^[a-z0-9_]{1,64}$/.test(metadata.errorCode)
        ? metadata.errorCode
        : 'segmenter_error'
    const tokens = metadata.tokens.map((token) => token.trim())
    const responseBody = {
      data: {
        capability: TOKENIZE_CAPABILITY,
        tokens,
        actualBackend: metadata.backendUsed,
        degraded: metadata.degraded,
        errorCode: safeErrorCode,
      },
    }
    try {
      await this.store.commitRequest(activeRequestId, {
        responseStatus: 200,
        // The idempotency contract needs the successful response for replay.
        // Store only the bounded public result, never the original input text,
        // upstream response body, URL or credentials.
        responseBody,
        unitsActual: Math.max(1, tokens.length),
        upstreamLatencyMs: Math.round(performance.now() - startedAt),
      })
    } catch (error) {
      await this.store.markRequestUnknown(activeRequestId, 'usage_commit_ambiguous').catch(() => {})
      throw error
    }
    return { status: 200, body: responseBody, requestId: activeRequestId, replay: false }
  }

  async publicUsage(context, filters) {
    await this.store.reapStaleReservations()
    return this.store.usage(usageFilters({
      ...filters,
      tenantId: context.tenant.id,
      consumerId: context.consumer.id,
    }))
  }

  async adminDataProductTelegramChats(queryInput) {
    const query = normalizeAdminTelegramChatsQuery(queryInput)
    if (typeof this.store.listAdminTelegramChats !== 'function') {
      return adminTelegramChatsResponse(demoAdminTelegramChats(query), query, { demoMode: true })
    }
    const rows = await this.store.listAdminTelegramChats(query)
    return adminTelegramChatsResponse(rows, query)
  }

  async adminDataProductTelegramMessages(chatIdInput, queryInput) {
    const query = normalizeAdminTelegramHistoryQuery(chatIdInput, queryInput)
    if (
      typeof this.store.getAdminTelegramChat !== 'function'
      || typeof this.store.listAdminTelegramMessages !== 'function'
    ) {
      const demo = demoAdminTelegramMessages(query)
      if (!demo.chat) throw new AppError(404, 'chat_not_found', 'Telegram chat not found')
      return adminTelegramMessagesResponse(demo.chat, demo.rows, query, { demoMode: true })
    }
    const chat = await this.store.getAdminTelegramChat(query.chatId, query.sourceScope)
    if (!chat) throw new AppError(404, 'chat_not_found', 'Telegram chat not found')
    const rows = await this.store.listAdminTelegramMessages({
      ...query,
      chatExternalId: String(chat.external_id),
    })
    return adminTelegramMessagesResponse(chat, rows, query)
  }

  async adminDataProductTelegramSearch(body) {
    const query = normalizeAdminTelegramSearchQuery(body)
    if (
      typeof this.store.getAdminTelegramChat !== 'function'
      || typeof this.store.searchAdminTelegramMessages !== 'function'
    ) {
      const demo = demoAdminTelegramSearch(query)
      if (query.chatId && !demo.chat) {
        throw new AppError(404, 'chat_not_found', 'Telegram chat not found')
      }
      return adminTelegramSearchResponse(demo.rows, query, { demoMode: true })
    }
    const chat = query.chatId
      ? await this.store.getAdminTelegramChat(query.chatId, query.sourceScope)
      : null
    if (query.chatId && !chat) {
      throw new AppError(404, 'chat_not_found', 'Telegram chat not found')
    }
    const rows = await this.store.searchAdminTelegramMessages({
      ...query,
      chatExternalId: chat ? String(chat.external_id) : null,
    })
    return adminTelegramSearchResponse(rows, query)
  }

  async adminDataProductTelegramContext(idInput, queryInput) {
    const query = normalizeAdminTelegramContextQuery(idInput, queryInput)
    if (
      typeof this.store.getAdminTelegramMessage !== 'function'
      || typeof this.store.getCanonicalContext !== 'function'
    ) {
      const result = demoAdminTelegramContext(query)
      if (!result) throw new AppError(404, 'item_not_found', 'Telegram item not found')
      return adminTelegramContextResponse(query, result, { demoMode: true })
    }
    const anchor = await this.store.getAdminTelegramMessage(query.id, query.sourceScope)
    if (!anchor) throw new AppError(404, 'item_not_found', 'Telegram item not found')
    const result = await this.store.getCanonicalContext(query)
    if (!result) throw new AppError(404, 'item_not_found', 'Telegram item not found')
    if (!result.contextSupported) {
      throw new AppError(409, 'context_not_supported', 'Canonical item does not support message context')
    }
    return adminTelegramContextResponse(query, result)
  }

  async adminDataProductPublicOpinionRegions(queryInput) {
    const query = normalizeAdminPublicOpinionRegionsQuery(queryInput)
    return adminPublicOpinionRegionsResponse(query, {
      demoMode: typeof this.store.listAdminPublicOpinionRecords !== 'function',
    })
  }

  async adminDataProductPublicOpinionCoverage(queryInput) {
    const query = normalizeAdminPublicOpinionCoverageQuery(queryInput)
    if (typeof this.store.getAdminPublicOpinionProvinceCoverage !== 'function') {
      return adminPublicOpinionCoverageResponse(
        demoAdminPublicOpinionCoverageRows(query),
        query,
        { demoMode: true },
      )
    }
    const rows = await this.store.getAdminPublicOpinionProvinceCoverage(query)
    return adminPublicOpinionCoverageResponse(rows, query)
  }

  async adminDataProductPublicOpinionFunnel(queryInput) {
    const query = normalizeAdminPublicOpinionFunnelQuery(queryInput)
    if (typeof this.store.getAdminPublicOpinionFunnel !== 'function') {
      return adminPublicOpinionFunnelResponse(
        demoAdminPublicOpinionFunnel(query),
        query,
        { demoMode: true },
      )
    }
    return adminPublicOpinionFunnelResponse(
      await this.store.getAdminPublicOpinionFunnel(query),
      query,
    )
  }

  async adminDataProductPublicOpinionBrowse(queryInput) {
    const query = normalizeAdminPublicOpinionBrowseQuery(queryInput)
    if (typeof this.store.listAdminPublicOpinionBrowseRecords !== 'function') {
      return adminPublicOpinionBrowseResponse(
        demoAdminPublicOpinionBrowseRows(query),
        query,
        { demoMode: true },
      )
    }
    return adminPublicOpinionBrowseResponse(
      await this.store.listAdminPublicOpinionBrowseRecords(query),
      query,
    )
  }

  async adminDataProductPublicOpinionBrowseItem(idInput, queryInput) {
    const query = normalizeAdminPublicOpinionBrowseItemQuery(idInput, queryInput)
    if (typeof this.store.getAdminPublicOpinionBrowseRecord !== 'function') {
      const row = demoAdminPublicOpinionBrowseItem(query.id)
      if (!row) throw new AppError(404, 'item_not_found', 'Public-opinion record not found')
      return adminPublicOpinionBrowseItemResponse(row, query, { demoMode: true })
    }
    const row = await this.store.getAdminPublicOpinionBrowseRecord(query.id)
    if (!row) throw new AppError(404, 'item_not_found', 'Public-opinion record not found')
    return adminPublicOpinionBrowseItemResponse(row, query)
  }

  async adminDataProductPublicOpinionProvince(provinceInput, queryInput) {
    const query = normalizeAdminPublicOpinionProvinceQuery(
      provinceInput,
      queryInput,
      this.apiKeyPepper,
    )
    if (typeof this.store.listAdminPublicOpinionRecords !== 'function') {
      return adminPublicOpinionProvinceResponse(
        demoAdminPublicOpinionRows(query),
        query,
        this.apiKeyPepper,
        { demoMode: true },
      )
    }
    const rows = await this.store.listAdminPublicOpinionRecords({
      provinceCode: query.province.code,
      sort: query.sort,
      pageSize: query.pageSize,
      cursor: query.cursor,
      from: query.from,
      to: query.to,
    })
    return adminPublicOpinionProvinceResponse(rows, query, this.apiKeyPepper)
  }

  async adminDataProductPublicOpinionItem(idInput, queryInput) {
    const id = normalizeAdminPublicOpinionItemQuery(idInput, queryInput)
    if (typeof this.store.getAdminPublicOpinionRecord !== 'function') {
      const row = demoAdminPublicOpinionItem(id)
      if (!row) throw new AppError(404, 'item_not_found', 'Public-opinion item not found')
      return adminPublicOpinionItemResponse(row, { demoMode: true })
    }
    const row = await this.store.getAdminPublicOpinionRecord(id)
    if (!row) throw new AppError(404, 'item_not_found', 'Public-opinion item not found')
    return adminPublicOpinionItemResponse(row)
  }

  async telegramMonitor(context, resourceName, queryInput) {
    if (typeof this.store.listCanonicalRecords !== 'function') {
      throw new AppError(503, 'stored_data_unavailable', 'Stored Telegram data requires the PostgreSQL store')
    }
    const policy = await this.#storedPlatformPolicy(context, 'telegram', 'Telegram')
    const resource = telegramMonitorResource(resourceName)
    const query = normalizeTelegramMonitorQuery(
      queryInput,
      policy.maxPageSize,
      resourceName,
      this.apiKeyPepper,
    )
    return this.#meterStoredRead(context, 'telegram', policy, {
      path: `/api/v1/data/telegram/${resourceName}`,
      fingerprintBody: query,
      operation: async () => {
        let rows
        let chat = null
        let effectiveSourceScope = query.sourceScope
        if (resourceName === 'chats') {
          if (query.cursorBinding) {
            if (typeof this.store.listAdminTelegramChats !== 'function') {
              throw new AppError(
                503,
                'stored_data_unavailable',
                'Multi-source Telegram directory requires the PostgreSQL product store',
              )
            }
            rows = await this.store.listAdminTelegramChats({
              kind: query.kind,
              sourceScope: query.sourceScope,
              query: query.query,
              pageSize: query.pageSize,
              cursor: query.cursor,
            })
          } else {
            rows = await this.store.listCanonicalRecords({
              ...resource,
              platform: 'telegram',
              ...query,
            })
          }
        } else {
          let selectedSourceScope = query.sourceScope
          let chatId = query.chatId
          const qualifiedChat = /^(monitor|sqlite):/i.exec(chatId || '')
          if (qualifiedChat) {
            if (query.sourceScope !== 'all' && query.sourceScope !== qualifiedChat[1].toLowerCase()) {
              throw new AppError(400, 'source_scope_mismatch', 'chatKey source does not match sourceScope')
            }
            if (typeof this.store.getAdminTelegramChat !== 'function') {
              throw new AppError(503, 'stored_data_unavailable', 'Qualified Telegram chat lookup requires the PostgreSQL store')
            }
            chat = await this.store.getAdminTelegramChat(chatId, query.sourceScope)
            if (!chat) throw new AppError(404, 'chat_not_found', 'Telegram chat not found')
            selectedSourceScope = qualifiedChat[1].toLowerCase()
            effectiveSourceScope = selectedSourceScope
            chatId = String(chat.external_id)
          }
          if (query.cursorBinding) {
            if (typeof this.store.listAdminTelegramMessages !== 'function') {
              throw new AppError(
                503,
                'stored_data_unavailable',
                'Multi-source Telegram history requires the PostgreSQL product store',
              )
            }
            rows = await this.store.listAdminTelegramMessages({
              chatExternalId: chatId,
              sourceScope: selectedSourceScope,
              pageSize: query.pageSize,
              cursor: query.cursor,
              from: query.from,
              to: query.to,
            })
          } else {
            const datasets = telegramStoredDatasetIds(selectedSourceScope, resourceName)
            const pages = await Promise.all(datasets.map((datasetId) => this.store.listCanonicalRecords({
              ...resource,
              datasetId,
              platform: 'telegram',
              ...query,
              chatId,
            })))
            rows = [...new Map(
              pages.flat()
                .sort((left, right) => {
                  const time = new Date(right.sort_time).getTime() - new Date(left.sort_time).getTime()
                  return time || String(right.id).localeCompare(String(left.id))
                })
                .map((row) => [row.id, row]),
            ).values()]
          }
        }
        const page = publicTelegramMonitorPage(rows, query.pageSize, {
          cursorBinding: query.cursorBinding,
          cursorSecret: this.apiKeyPepper,
        })
        return {
          contractVersion: `mx-insight-hub.data-products.telegram-${resourceName}.v1`,
          sourceScope: {
            selected: effectiveSourceScope,
            datasets: telegramStoredDatasetIds(effectiveSourceScope, resourceName),
          },
          ...(resourceName === 'chats'
            ? { filters: { kind: query.kind, query: query.query } }
            : { filters: { chatId: query.chatId, from: query.from, to: query.to } }),
          ...(chat ? { chat: publicTelegramMonitorRecord(chat) } : {}),
          ...page,
        }
      },
    })
  }

  async sourceCatalog(context, queryInput) {
    if (typeof this.store.listSourceCatalogEntries !== 'function') {
      throw new AppError(503, 'stored_data_unavailable', 'Source catalog requires the current Hub store')
    }
    const policy = await this.#storedPlatformPolicy(context, SOURCE_CATALOG_PLATFORM, 'Source catalog')
    const query = normalizePublicSourceCatalogQuery(queryInput, policy.maxPageSize, this.apiKeyPepper)
    return this.#meterStoredRead(context, SOURCE_CATALOG_PLATFORM, policy, {
      path: '/api/v1/data/source-catalog',
      fingerprintBody: {
        ...query.filters,
        pageSize: query.pageSize,
        cursor: query.cursorToken,
      },
      operation: async () => publicSourceCatalogPage(
        await this.store.listSourceCatalogEntries({ includeArchived: false }),
        query,
        this.apiKeyPepper,
      ),
    })
  }

  async sourceCatalogMetadata(context, queryInput = {}) {
    const query = normalizePublicSourceCatalogMetadataQuery(queryInput)
    if (
      typeof this.store.listSourceCatalogEntries !== 'function'
      || typeof this.store.listSourceCatalogTerms !== 'function'
      || typeof this.store.listSourceCatalogOwners !== 'function'
    ) {
      throw new AppError(503, 'stored_data_unavailable', 'Source catalog metadata requires the current Hub store')
    }
    const policy = await this.#storedPlatformPolicy(context, SOURCE_CATALOG_PLATFORM, 'Source catalog')
    return this.#meterStoredRead(context, SOURCE_CATALOG_PLATFORM, policy, {
      path: '/api/v1/data/source-catalog/metadata',
      fingerprintBody: query,
      operation: async () => {
        const [entries, taxonomyTerms, owners] = await Promise.all([
          this.store.listSourceCatalogEntries({ includeArchived: false }),
          this.store.listSourceCatalogTerms({ includeArchived: false }),
          this.store.listSourceCatalogOwners({ includeArchived: false }),
        ])
        return publicSourceCatalogMetadata(entries, taxonomyTerms, owners)
      },
    })
  }

  async sourceCatalogDetail(context, idInput, queryInput = {}) {
    if (typeof this.store.getSourceCatalogEntry !== 'function') {
      throw new AppError(503, 'stored_data_unavailable', 'Source catalog detail requires the current Hub store')
    }
    const policy = await this.#storedPlatformPolicy(context, SOURCE_CATALOG_PLATFORM, 'Source catalog')
    const id = normalizePublicSourceCatalogId(idInput)
    const query = normalizePublicSourceCatalogDetailQuery(queryInput)
    return this.#meterStoredRead(context, SOURCE_CATALOG_PLATFORM, policy, {
      path: `/api/v1/data/source-catalog/${id}`,
      fingerprintBody: { id, ...query },
      operation: async () => {
        const entry = await this.store.getSourceCatalogEntry(id)
        if (!entry || entry.archivedAt) {
          throw new AppError(404, 'source_catalog_entry_not_found', 'Source catalog entry was not found')
        }
        return publicSourceCatalogDetail(entry)
      },
    })
  }

  async sourceCatalogItems(context, idInput, queryInput = {}) {
    if (
      typeof this.store.getSourceCatalogEntry !== 'function'
      || typeof this.store.listMobileCommerceItems !== 'function'
    ) {
      throw new AppError(503, 'stored_data_unavailable', 'Source-catalog data queries require the PostgreSQL product store')
    }
    if (Object.prototype.hasOwnProperty.call(queryInput, 'catalogEntryId')) {
      throw new AppError(400, 'unsupported_fields', 'catalogEntryId is supplied by the source-catalog path')
    }
    await this.#storedPlatformPolicy(context, SOURCE_CATALOG_PLATFORM, 'Source catalog')
    const policy = await this.#storedPlatformPolicy(context, MOBILE_COMMERCE_PLATFORM, 'Mobile commerce')
    const id = normalizePublicSourceCatalogId(idInput)
    const query = normalizeMobileCommerceQuery(
      { ...queryInput, catalogEntryId: id },
      policy.maxPageSize,
      this.apiKeyPepper,
    )
    return this.#meterStoredRead(context, MOBILE_COMMERCE_PLATFORM, policy, {
      path: `/api/v1/data/source-catalog/${id}/items`,
      fingerprintBody: {
        catalogEntryId: id,
        ...query.filters,
        refresh: query.refresh,
        pageSize: query.pageSize,
        cursor: query.cursorToken,
      },
      operation: async () => {
        const entry = await this.store.getSourceCatalogEntry(id)
        if (!entry || entry.archivedAt) {
          throw new AppError(404, 'source_catalog_entry_not_found', 'Source catalog entry was not found')
        }
        const page = publicMobileCommercePage(
          await this.store.listMobileCommerceItems({
            ...query.filters,
            pageSize: query.pageSize,
            cursor: query.cursor,
          }),
          query,
          this.apiKeyPepper,
        )
        return {
          contractVersion: 'mx-insight-hub.data-products.source-catalog-items.v1',
          catalogEntry: publicSourceCatalogItem(entry),
          dataProductKey: 'mobile-commerce-items',
          page,
        }
      },
    })
  }

  async telegramEntities(context, queryInput) {
    if (!this.searchQueries?.searchAuthors || !this.searchQueries?.searchTelegramChats) {
      throw new AppError(503, 'stored_search_unavailable', 'Telegram entity search requires the PostgreSQL search layer')
    }
    const policy = await this.#storedPlatformPolicy(context, 'telegram', 'Telegram')
    const query = normalizeTelegramEntityQuery(queryInput, policy.maxPageSize)
    return this.#meterStoredRead(context, 'telegram', policy, {
      path: '/api/v1/data/telegram/entities/search',
      fingerprintBody: query,
      operation: async () => {
        const [authors, chats] = await Promise.all([
          this.searchQueries.searchAuthors(query.query, {
            platform: 'telegram',
            datasetId: 'telegram.monitor.messages.v1',
            objectType: 'message',
            size: query.pageSize,
          }),
          this.searchQueries.searchTelegramChats(query.query, { size: query.pageSize }),
        ])
        const ranked = [
          ...(authors.authors || []).map((author) => ({
            entityType: 'author',
            id: author.authorExternalId,
            name: author.authorName,
            username: author.username ?? null,
            postCount: author.postCount,
            score: author.score,
          })),
          ...(chats.chats || []).map((chat) => ({
            entityType: 'chat',
            id: chat.id,
            title: chat.title ?? null,
            username: chat.username ?? null,
            url: chat.url ?? null,
            memberCount: chat.memberCount ?? null,
            eventTime: chat.eventTime ?? null,
            collectedAt: chat.collectedAt ?? null,
            score: chat.score ?? null,
          })),
        ].sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
          .slice(0, query.pageSize)
        return {
          items: ranked,
          pageInfo: { returnedCount: ranked.length, hasMore: false, nextCursor: null },
          searchMode: authors.mode === 'elasticsearch' || chats.mode === 'elasticsearch'
            ? 'elasticsearch'
            : 'postgres',
        }
      },
    })
  }

  async publicOpinionProvince(context, provinceInput, queryInput) {
    if (typeof this.store.listPublicOpinionRecords !== 'function') {
      throw new AppError(503, 'stored_data_unavailable', 'Province opinion data requires the PostgreSQL store')
    }
    const policy = await this.#storedPlatformPolicy(context, PUBLIC_OPINION_PLATFORM, 'Public opinion')
    const query = normalizePublicOpinionQuery(
      provinceInput,
      queryInput,
      policy.maxPageSize,
      this.apiKeyPepper,
    )
    await this.#assertPublicOpinionServingIndexes()
    return this.#meterStoredRead(context, PUBLIC_OPINION_PLATFORM, policy, {
      path: `/api/v1/data/public-opinion/provinces/${query.province.code}/items`,
      fingerprintBody: {
        provinceCode: query.province.code,
        sort: query.sort,
        from: query.from,
        to: query.to,
        pageSize: query.pageSize,
        cursor: query.cursorToken,
        ...(query.candidateMode === 'formal'
          ? {}
          : { includeCandidates: query.candidateMode, minQualityScore: query.minQualityScore }),
      },
      operation: async () => {
        const rows = await this.store.listPublicOpinionRecords({
          provinceCode: query.province.code,
          sort: query.sort,
          pageSize: query.pageSize,
          cursor: query.cursor,
          from: query.from,
          to: query.to,
          candidateMode: query.candidateMode,
          minQualityScore: query.minQualityScore,
        })
        return publicOpinionPage(rows, query, this.apiKeyPepper)
      },
    })
  }

  async publicOpinionRegions(context, queryInput) {
    const policy = await this.#storedPlatformPolicy(context, PUBLIC_OPINION_PLATFORM, 'Public opinion')
    const query = normalizePublicOpinionRegionsQuery(queryInput)
    return this.#meterStoredRead(context, PUBLIC_OPINION_PLATFORM, policy, {
      path: '/api/v1/data/public-opinion/regions',
      fingerprintBody: query,
      operation: async () => publicOpinionRegions(query),
    })
  }

  async mobileCommerceItems(context, queryInput) {
    if (typeof this.store.listMobileCommerceItems !== 'function') {
      throw new AppError(503, 'stored_data_unavailable', 'Stored mobile-commerce data requires the PostgreSQL store')
    }
    const policy = await this.#storedPlatformPolicy(context, MOBILE_COMMERCE_PLATFORM, 'Mobile commerce')
    const query = normalizeMobileCommerceQuery(queryInput, policy.maxPageSize, this.apiKeyPepper)
    return this.#meterStoredRead(context, MOBILE_COMMERCE_PLATFORM, policy, {
      path: '/api/v1/data/mobile-commerce/items',
      fingerprintBody: {
        ...query.filters,
        refresh: query.refresh,
        pageSize: query.pageSize,
        cursor: query.cursorToken,
      },
      operation: async () => publicMobileCommercePage(
        await this.store.listMobileCommerceItems({
          ...query.filters,
          pageSize: query.pageSize,
          cursor: query.cursor,
        }),
        query,
        this.apiKeyPepper,
      ),
    })
  }

  async publicOpinionRegion(context, regionInput, queryInput) {
    if (typeof this.store.listPublicOpinionRegionRecords !== 'function') {
      throw new AppError(503, 'stored_data_unavailable', 'Public opinion region data requires the PostgreSQL store')
    }
    const platformPolicy = await this.#storedPlatformPolicy(context, PUBLIC_OPINION_PLATFORM, 'Public opinion')
    const query = normalizePublicOpinionRegionQuery(
      regionInput,
      queryInput,
      platformPolicy.maxPageSize,
      this.apiKeyPepper,
    )
    const grants = typeof this.store.listCapabilityGrants === 'function'
      ? await this.store.listCapabilityGrants(context.consumer.id)
      : []
    assert(
      grants.includes(PUBLIC_OPINION_ALL_INGESTED_CAPABILITY),
      403,
      'capability_not_granted',
      'all_ingested public opinion is not granted',
    )
    const capabilityPolicy = {
      ...this.defaultPolicy,
      ...((typeof this.store.getCapabilityPolicy === 'function'
        ? await this.store.getCapabilityPolicy(
            context.consumer.id,
            PUBLIC_OPINION_ALL_INGESTED_CAPABILITY,
          )
        : null) || {}),
    }
    const policy = {
      ...platformPolicy,
      maxRequests: capabilityPolicy.maxRequests,
      windowSeconds: capabilityPolicy.windowSeconds,
    }
    await this.#assertPublicOpinionRegionServingIndexes()
    return this.#meterStoredRead(context, PUBLIC_OPINION_PLATFORM, policy, {
      capability: PUBLIC_OPINION_ALL_INGESTED_CAPABILITY,
      path: `/api/v1/data/public-opinion/regions/${query.region.code}/items`,
      fingerprintBody: {
        regionCode: query.region.code,
        visibility: query.visibility,
        sort: query.sort,
        from: query.from,
        to: query.to,
        pageSize: query.pageSize,
        cursor: query.cursorToken,
      },
      operation: async () => {
        const rows = await this.store.listPublicOpinionRegionRecords({
          regionCode: query.region.code,
          visibility: query.visibility,
          sort: query.sort,
          from: query.from,
          to: query.to,
          pageSize: query.pageSize,
          cursor: query.cursor,
        })
        return publicOpinionRegionPage(rows, query, this.apiKeyPepper)
      },
    })
  }

  async publicOpinionCoverage(context, queryInput) {
    if (typeof this.store.getPublicOpinionProvinceCoverage !== 'function') {
      throw new AppError(503, 'stored_data_unavailable', 'Province opinion coverage requires the PostgreSQL store')
    }
    const policy = await this.#storedPlatformPolicy(context, PUBLIC_OPINION_PLATFORM, 'Public opinion')
    const query = normalizePublicOpinionCoverageQuery(queryInput)
    await this.#assertPublicOpinionServingIndexes()
    return this.#meterStoredRead(context, PUBLIC_OPINION_PLATFORM, policy, {
      path: '/api/v1/data/public-opinion/province-coverage',
      fingerprintBody: {
        from: query.from,
        to: query.to,
        includeCandidates: query.candidateMode === 'formal' ? false : query.candidateMode,
        minQualityScore: query.minQualityScore,
        targetPerProvince: query.targetPerProvince,
      },
      operation: async () => {
        const rows = await this.store.getPublicOpinionProvinceCoverage(query)
        return publicOpinionCoverage(rows, query)
      },
    })
  }

  async publicOpinionItem(context, idInput, queryInput = {}) {
    if (typeof this.store.getPublicOpinionRecord !== 'function') {
      throw new AppError(503, 'stored_data_unavailable', 'Province opinion data requires the PostgreSQL store')
    }
    const policy = await this.#storedPlatformPolicy(context, PUBLIC_OPINION_PLATFORM, 'Public opinion')
    const id = normalizePublicOpinionItemId(idInput)
    const query = normalizePublicOpinionDetailQuery(queryInput)
    return this.#meterStoredRead(context, PUBLIC_OPINION_PLATFORM, policy, {
      path: `/api/v1/data/public-opinion/items/${id}`,
      fingerprintBody: {
        id,
        ...(query.candidateMode === 'formal'
          ? {}
          : { includeCandidates: query.candidateMode, minQualityScore: query.minQualityScore }),
      },
      operation: async () => {
        const row = await this.store.getPublicOpinionRecord(id, query)
        if (!row) throw new AppError(404, 'item_not_found', 'Province opinion item not found')
        return publicOpinionItem(row, { includeQuality: query.candidateMode !== 'formal' })
      },
    })
  }

  async publicOpinionDiagnosticsFunnel(context, queryInput) {
    const { policy } = await this.#publicOpinionDiagnosticsPolicy(context)
    if (typeof this.store.getAdminPublicOpinionFunnel !== 'function') {
      throw new AppError(503, 'stored_data_unavailable', 'Public-opinion diagnostics require the PostgreSQL store')
    }
    const query = normalizeAdminPublicOpinionFunnelQuery(queryInput)
    return this.#meterStoredRead(context, PUBLIC_OPINION_PLATFORM, policy, {
      capability: PUBLIC_OPINION_DIAGNOSTICS_CAPABILITY,
      path: '/api/v1/data/public-opinion/funnel',
      fingerprintBody: query,
      operation: async () => publicDataProductContract(
        adminPublicOpinionFunnelResponse(
          await this.store.getAdminPublicOpinionFunnel(query),
          query,
        ),
        'mx-insight-hub.data-products.public-opinion-funnel.v1',
      ),
    })
  }

  async publicOpinionDiagnosticsRecords(context, queryInput) {
    const { policy, maxPageSize } = await this.#publicOpinionDiagnosticsPolicy(context)
    if (typeof this.store.listAdminPublicOpinionBrowseRecords !== 'function') {
      throw new AppError(503, 'stored_data_unavailable', 'Public-opinion diagnostics require the PostgreSQL store')
    }
    const query = normalizePublicOpinionDiagnosticsBrowseQuery(
      queryInput,
      maxPageSize,
      this.apiKeyPepper,
    )
    return this.#meterStoredRead(context, PUBLIC_OPINION_PLATFORM, policy, {
      capability: PUBLIC_OPINION_DIAGNOSTICS_CAPABILITY,
      path: '/api/v1/data/public-opinion/records',
      fingerprintBody: query,
      operation: async () => publicOpinionDiagnosticsBrowseResponse(
        await this.store.listAdminPublicOpinionBrowseRecords(query),
        query,
        this.apiKeyPepper,
      ),
    })
  }

  async publicOpinionDiagnosticsRecord(context, idInput, queryInput) {
    const { policy } = await this.#publicOpinionDiagnosticsPolicy(context)
    if (typeof this.store.getAdminPublicOpinionBrowseRecord !== 'function') {
      throw new AppError(503, 'stored_data_unavailable', 'Public-opinion diagnostics require the PostgreSQL store')
    }
    const query = normalizeAdminPublicOpinionBrowseItemQuery(idInput, queryInput)
    return this.#meterStoredRead(context, PUBLIC_OPINION_PLATFORM, policy, {
      capability: PUBLIC_OPINION_DIAGNOSTICS_CAPABILITY,
      path: `/api/v1/data/public-opinion/records/${query.id}`,
      fingerprintBody: query,
      operation: async () => {
        const row = await this.store.getAdminPublicOpinionBrowseRecord(query.id)
        if (!row) throw new AppError(404, 'item_not_found', 'Public-opinion record not found')
        return publicDataProductContract(
          adminPublicOpinionBrowseItemResponse(row, query),
          'mx-insight-hub.data-products.public-opinion-record.v1',
        )
      },
    })
  }

  async canonicalContext(context, idInput, queryInput) {
    if (
      typeof this.store.getCanonicalContext !== 'function'
      || typeof this.store.getCanonicalContextServingIndexStatus !== 'function'
    ) {
      throw new AppError(503, 'stored_data_unavailable', 'Canonical context requires the PostgreSQL store')
    }
    const id = requiredUuid(idInput, 'id')
    const query = normalizeCanonicalContextQuery(queryInput)
    const policy = await this.#storedPlatformPolicy(context, 'telegram', 'Telegram')
    let servingIndexes
    try {
      servingIndexes = await this.store.getCanonicalContextServingIndexStatus()
    } catch {
      throw new AppError(
        503,
        'serving_indexes_unavailable',
        'Canonical context serving index status is unavailable',
      )
    }
    if (!servingIndexes.ready) {
      throw new AppError(
        503,
        'serving_indexes_unavailable',
        'Canonical context serving indexes are not ready',
      )
    }
    return this.#meterStoredRead(context, 'telegram', policy, {
      path: `/api/v1/data/canonical/items/${id}/context`,
      fingerprintBody: { id, before: query.before, after: query.after },
      operation: async () => {
        const result = await this.store.getCanonicalContext({ id, ...query })
        if (!result) throw new AppError(404, 'item_not_found', 'Canonical item not found')
        if (!result.contextSupported) {
          throw new AppError(409, 'context_not_supported', 'Canonical item does not support message context')
        }
        return canonicalContextResponse({ query, result })
      },
    })
  }

  async storedSearch(context, { body, idempotencyKey, path }) {
    assert(idempotencyKey, 400, 'idempotency_key_required', 'Idempotency-Key header is required')
    assert(
      typeof idempotencyKey === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey),
      400,
      'invalid_idempotency_key',
      'Idempotency-Key must contain 8-128 safe characters',
    )
    assert(body && typeof body === 'object' && !Array.isArray(body), 400, 'invalid_request', 'JSON object body is required')
    const platform = canonicalPlatform(body.platform)
    assert(!RESERVED_PLATFORM_NAMES.has(platform), 400, 'invalid_platform', 'A single explicit platform is required')
    const grants = await this.store.listGrants(context.consumer.id)
    assert(grants.includes(platform), 403, 'platform_not_granted', 'Platform is not granted')
    if (!this.searchQueries?.searchContent) {
      throw new AppError(503, 'stored_search_unavailable', 'Stored search requires the PostgreSQL search layer')
    }
    const policy = {
      ...this.defaultPolicy,
      ...((await this.store.getPolicy(context.consumer.id, platform)) || {}),
    }
    const query = normalizeStoredSearchQuery(
      { ...body, platform },
      policy.maxPageSize,
      this.apiKeyPepper,
    )
    // `resultType` joins the fingerprint so the same key cannot mean a frozen
    // answer on one call and a live one on the next.
    const resultType = resolveResultType(body)
    const fingerprintBody = {
      query: query.query,
      platform: query.platform,
      datasetId: query.datasetId,
      objectType: query.objectType,
      pageSize: query.pageSize,
      cursor: query.cursorToken,
      type: resultType,
      ...(query.platform === PUBLIC_OPINION_PLATFORM ? {
        publicOpinionVisibility: {
          contractVersion: PUBLIC_OPINION_VISIBILITY_CONTRACT,
          mode: query.publicOpinionVisibility.candidateMode,
        },
      } : {}),
      ...(query.publicOpinionVisibility.explicit ? {
        includeCandidates: query.publicOpinionVisibility.candidateMode === 'formal'
          ? false
          : query.publicOpinionVisibility.candidateMode,
        minQualityScore: query.publicOpinionVisibility.minQualityScore,
        province: query.publicOpinionVisibility.provinceCode,
        countryCode: query.publicOpinionVisibility.countryCode,
        location: query.publicOpinionVisibility.location,
        from: query.publicOpinionVisibility.from,
        to: query.publicOpinionVisibility.to,
      } : {}),
    }
    const requestId = randomUUID()
    const windowStart = new Date(Date.now() - policy.windowSeconds * 1_000)
    await this.store.reapStaleReservations()
    const reservation = await this.store.reserve({
      requestId,
      idempotencyKey,
      fingerprint: requestFingerprint({ method: 'POST', path, body: fingerprintBody }),
      tenantId: context.tenant.id,
      consumerId: context.consumer.id,
      apiKeyId: context.apiKey.id,
      platform,
      unitsReserved: 1,
      leaseExpiresAt: new Date(Date.now() + this.reservationLeaseMs),
      windowStart,
      maxRequests: policy.maxRequests,
      replayWindowMs: replayWindowFor(resultType),
    })

    if (reservation.kind === 'conflict') {
      throw new AppError(409, 'idempotency_conflict', 'Idempotency-Key was used with a different request')
    }
    if (reservation.kind === 'in_progress') {
      throw new AppError(409, 'request_in_progress', 'Request with this Idempotency-Key is in progress', {
        requestId: reservation.request.id,
      })
    }
    if (reservation.kind === 'unknown') {
      throw new AppError(409, 'request_outcome_unknown', 'Previous request outcome is unknown', {
        requestId: reservation.request.id,
      })
    }
    if (reservation.kind === 'replay') {
      return {
        status: reservation.request.responseStatus,
        body: reservation.request.responseBody,
        requestId: reservation.request.id,
        replay: true,
      }
    }

    const activeRequestId = reservation.request.id
    const startedAt = performance.now()
    let commitAttempted = false
    try {
      // `datasetId` is an exact search filter, not an authorization grant. The
      // current public model authorizes the complete canonical platform corpus.
      const result = await this.searchQueries.searchContent(query.query, {
        platform: query.platform,
        datasetId: query.datasetId,
        objectType: query.objectType,
        size: query.pageSize,
        cursor: query.cursor,
        ...(query.platform === PUBLIC_OPINION_PLATFORM
          ? { publicOpinionVisibility: query.publicOpinionVisibility }
          : {}),
      })
      const responseBody = storedSearchResponse({
        query,
        result,
        durationMs: Math.round(performance.now() - startedAt),
        cursorSecret: this.apiKeyPepper,
      })
      commitAttempted = true
      await this.store.commitRequest(activeRequestId, {
        responseStatus: 200,
        responseBody,
        unitsActual: Math.max(1, responseBody.data.items.length),
        upstreamLatencyMs: Math.round(performance.now() - startedAt),
      })
      return { status: 200, body: responseBody, requestId: activeRequestId, replay: false }
    } catch (error) {
      if (commitAttempted) {
        await this.store.markRequestUnknown(activeRequestId, 'usage_commit_ambiguous').catch(() => {})
        throw error
      }
      await this.store.releaseRequest(activeRequestId, 'stored_search_failed').catch(() => {})
      throw error
    }
  }

  async canonicalSearch(context, { body, idempotencyKey, path }) {
    assert(idempotencyKey, 400, 'idempotency_key_required', 'Idempotency-Key header is required')
    assert(
      typeof idempotencyKey === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey),
      400,
      'invalid_idempotency_key',
      'Idempotency-Key must contain 8-128 safe characters',
    )
    assert(body && typeof body === 'object' && !Array.isArray(body), 400, 'invalid_request', 'JSON object body is required')
    const grants = [...new Set(await this.store.listGrants(context.consumer.id))].sort()
    assert(grants.length > 0, 403, 'platform_not_granted', 'At least one platform grant is required')
    const platform = body.platform == null ? null : canonicalPlatform(body.platform)
    if (platform) {
      assert(!RESERVED_PLATFORM_NAMES.has(platform), 400, 'invalid_platform', 'A single explicit platform is required')
      assert(grants.includes(platform), 403, 'platform_not_granted', 'Platform is not granted')
    }
    if (!this.searchQueries?.searchContent) {
      throw new AppError(503, 'canonical_search_unavailable', 'Canonical search requires the PostgreSQL search layer')
    }
    const policies = await Promise.all(grants.map(async (name) => ({
      ...this.defaultPolicy,
      ...((await this.store.getPolicy(context.consumer.id, name)) || {}),
    })))
    // A unified read needs one stable, conservative quota policy. Its separate
    // usage bucket always applies the strictest request/page limit and longest
    // window across the consumer's complete current grant set. Using the same
    // stable policy for explicit-platform and all-platform requests prevents a
    // loose platform request from filling a bucket that is later evaluated
    // against a different, stricter limit.
    const policy = {
      maxRequests: Math.min(...policies.map((entry) => entry.maxRequests)),
      windowSeconds: Math.max(...policies.map((entry) => entry.windowSeconds)),
      maxPageSize: Math.min(...policies.map((entry) => entry.maxPageSize)),
    }
    const query = normalizeCanonicalSearchQuery(
      { ...body, platform },
      {
        platforms: grants,
        maxPageSize: policy.maxPageSize,
        cursorSecret: this.apiKeyPepper,
      },
    )
    const resultType = resolveResultType(body)
    const fingerprintBody = {
      query: query.query,
      platform: query.platform,
      platforms: query.platforms,
      datasetId: query.datasetId,
      objectType: query.objectType,
      pageSize: query.pageSize,
      searchProfile: query.searchProfile,
      cursor: query.cursorToken,
      sort: query.sort,
      type: resultType,
      ...(query.platforms.includes(PUBLIC_OPINION_PLATFORM) ? {
        publicOpinionVisibility: {
          contractVersion: PUBLIC_OPINION_VISIBILITY_CONTRACT,
          mode: query.publicOpinionVisibility.candidateMode,
        },
      } : {}),
      ...(query.publicOpinionVisibility.explicit ? {
        includeCandidates: query.publicOpinionVisibility.candidateMode === 'formal'
          ? false
          : query.publicOpinionVisibility.candidateMode,
        minQualityScore: query.publicOpinionVisibility.minQualityScore,
        province: query.publicOpinionVisibility.provinceCode,
        countryCode: query.publicOpinionVisibility.countryCode,
        location: query.publicOpinionVisibility.location,
        from: query.publicOpinionVisibility.from,
        to: query.publicOpinionVisibility.to,
      } : {}),
    }
    const requestId = randomUUID()
    const windowStart = new Date(Date.now() - policy.windowSeconds * 1_000)
    await this.store.reapStaleReservations()
    const reservation = await this.store.reserve({
      requestId,
      idempotencyKey,
      fingerprint: requestFingerprint({ method: 'POST', path, body: fingerprintBody }),
      tenantId: context.tenant.id,
      consumerId: context.consumer.id,
      apiKeyId: context.apiKey.id,
      capability: CANONICAL_SEARCH_USAGE_SCOPE,
      unitsReserved: 1,
      leaseExpiresAt: new Date(Date.now() + this.reservationLeaseMs),
      windowStart,
      maxRequests: policy.maxRequests,
      replayWindowMs: replayWindowFor(resultType),
    })

    if (reservation.kind === 'conflict') {
      throw new AppError(409, 'idempotency_conflict', 'Idempotency-Key was used with a different request')
    }
    if (reservation.kind === 'in_progress') {
      throw new AppError(409, 'request_in_progress', 'Request with this Idempotency-Key is in progress', {
        requestId: reservation.request.id,
      })
    }
    if (reservation.kind === 'unknown') {
      throw new AppError(409, 'request_outcome_unknown', 'Previous request outcome is unknown', {
        requestId: reservation.request.id,
      })
    }
    if (reservation.kind === 'replay') {
      return {
        status: reservation.request.responseStatus,
        body: reservation.request.responseBody,
        requestId: reservation.request.id,
        replay: true,
      }
    }

    const activeRequestId = reservation.request.id
    const startedAt = performance.now()
    let commitAttempted = false
    try {
      // Dataset/object filters narrow the already-authorized platform set; they
      // never replace it. The common projection produces one globally ranked
      // result list rather than merging incomparable per-source scores.
      const result = await this.searchQueries.searchContent(query.query, {
        sort: query.sort,
        platforms: query.platforms,
        datasetId: query.datasetId,
        objectType: query.objectType,
        size: query.pageSize,
        cursor: query.cursor,
        searchProfile: query.searchProfile,
        trackTotalHits: true,
        ...(query.platforms.includes(PUBLIC_OPINION_PLATFORM)
          ? { publicOpinionVisibility: query.publicOpinionVisibility }
          : {}),
      })
      const responseBody = canonicalSearchResponse({
        query,
        result,
        durationMs: Math.round(performance.now() - startedAt),
        cursorSecret: this.apiKeyPepper,
      })
      commitAttempted = true
      await this.store.commitRequest(activeRequestId, {
        responseStatus: 200,
        responseBody,
        unitsActual: Math.max(1, responseBody.data.items.length),
        upstreamLatencyMs: Math.round(performance.now() - startedAt),
      })
      return { status: 200, body: responseBody, requestId: activeRequestId, replay: false }
    } catch (error) {
      if (commitAttempted) {
        await this.store.markRequestUnknown(activeRequestId, 'usage_commit_ambiguous').catch(() => {})
        throw error
      }
      await this.store.releaseRequest(activeRequestId, 'canonical_search_failed').catch(() => {})
      throw error
    }
  }

  async #storedPlatformPolicy(context, platform, label) {
    const grants = await this.store.listGrants(context.consumer.id)
    assert(grants.includes(platform), 403, 'platform_not_granted', `${label} is not granted`)
    return {
      ...this.defaultPolicy,
      ...((await this.store.getPolicy(context.consumer.id, platform)) || {}),
    }
  }

  async #publicOpinionDiagnosticsPolicy(context) {
    const platformPolicy = await this.#storedPlatformPolicy(
      context,
      PUBLIC_OPINION_PLATFORM,
      'Public opinion',
    )
    const grants = typeof this.store.listCapabilityGrants === 'function'
      ? await this.store.listCapabilityGrants(context.consumer.id)
      : []
    assert(
      grants.includes(PUBLIC_OPINION_DIAGNOSTICS_CAPABILITY),
      403,
      'capability_not_granted',
      'Public-opinion diagnostics are not granted',
    )
    const capabilityPolicy = {
      ...this.defaultPolicy,
      ...((typeof this.store.getCapabilityPolicy === 'function'
        ? await this.store.getCapabilityPolicy(
            context.consumer.id,
            PUBLIC_OPINION_DIAGNOSTICS_CAPABILITY,
          )
        : null) || {}),
    }
    return {
      maxPageSize: platformPolicy.maxPageSize,
      policy: {
        ...platformPolicy,
        maxRequests: capabilityPolicy.maxRequests,
        windowSeconds: capabilityPolicy.windowSeconds,
      },
    }
  }

  async #assertPublicOpinionServingIndexes() {
    if (typeof this.store.getPublicOpinionServingIndexStatus !== 'function') {
      throw new AppError(
        503,
        'serving_indexes_unavailable',
        'Province opinion serving indexes are not available',
      )
    }
    const servingIndexes = await this.store.getPublicOpinionServingIndexStatus()
    if (!servingIndexes.ready) {
      throw new AppError(
        503,
        'serving_indexes_unavailable',
        'Province opinion serving indexes are not ready',
      )
    }
  }

  async #publicOpinionRegionServingReady() {
    if (
      typeof this.store.listPublicOpinionRegionRecords !== 'function'
      || typeof this.store.getPublicOpinionRegionServingIndexStatus !== 'function'
    ) return false
    try {
      const servingIndexes = await this.store.getPublicOpinionRegionServingIndexStatus()
      return servingIndexes?.ready === true
    } catch {
      this.logger?.warn?.('[public-opinion] region serving index status is unavailable')
      return false
    }
  }

  async #assertPublicOpinionRegionServingIndexes() {
    if (typeof this.store.getPublicOpinionRegionServingIndexStatus !== 'function') {
      throw new AppError(
        503,
        'serving_indexes_unavailable',
        'Public opinion region serving indexes are not available',
      )
    }
    let servingIndexes
    try {
      servingIndexes = await this.store.getPublicOpinionRegionServingIndexStatus()
    } catch {
      throw new AppError(
        503,
        'serving_indexes_unavailable',
        'Public opinion region serving index status is unavailable',
      )
    }
    if (!servingIndexes.ready) {
      throw new AppError(
        503,
        'serving_indexes_unavailable',
        'Public opinion region serving indexes are not ready',
      )
    }
  }

  async #meterStoredRead(context, platform, policy, {
    path,
    fingerprintBody,
    operation,
    capability = null,
  }) {
    const requestId = randomUUID()
    const startedAt = performance.now()
    const windowStart = new Date(Date.now() - policy.windowSeconds * 1_000)
    await this.store.reapStaleReservations()
    const reservation = await this.store.reserve({
      requestId,
      idempotencyKey: `${capability || platform}-read:${requestId}`,
      fingerprint: requestFingerprint({ method: 'GET', path, body: fingerprintBody }),
      tenantId: context.tenant.id,
      consumerId: context.consumer.id,
      apiKeyId: context.apiKey.id,
      ...(capability ? { capability } : { platform }),
      unitsReserved: 1,
      leaseExpiresAt: new Date(Date.now() + this.reservationLeaseMs),
      windowStart,
      maxRequests: policy.maxRequests,
    })
    assert(
      reservation.kind === 'reserved' && reservation.request?.id === requestId,
      500,
      'usage_reservation_failed',
      'Stored read usage reservation did not enter the expected state',
    )
    let payload
    try {
      payload = await operation()
    } catch (error) {
      await this.store.releaseRequest(requestId, 'stored_read_failed').catch(() => {})
      throw error
    }
    try {
      await this.store.commitRequest(requestId, {
        responseStatus: 200,
        // Stored pages may contain customer-visible text. Usage evidence needs
        // counts and latency, not a second retained copy of that content.
        responseBody: null,
        unitsActual: Math.max(
          1,
          payload.pageInfo?.returnedCount
            ?? payload.page?.pageInfo?.returnedCount
            ?? payload.storedWindow?.returnedCount
            ?? payload.items?.length
            ?? payload.regions?.length
            ?? 0,
        ),
        upstreamLatencyMs: Math.round(performance.now() - startedAt),
      })
      return payload
    } catch (error) {
      await this.store.markRequestUnknown(requestId, 'usage_commit_ambiguous').catch(() => {})
      throw error
    }
  }

  async requestStatus(context, requestId) {
    await this.store.reapStaleReservations()
    const record = await this.store.getRequest(requiredUuid(requestId, 'requestId'), context.consumer.id)
    assert(record, 404, 'request_not_found', 'Request not found')
    return {
      id: record.id,
      status: record.status,
      ...(record.platform ? { platform: record.platform } : {}),
      ...(record.capability ? { capability: record.capability } : {}),
      units: record.status === 'committed' ? record.unitsActual : null,
      errorCode: record.errorCode,
      ...(record.deliverySourceMode ? { sourceMode: record.deliverySourceMode } : {}),
      ...(record.capturedAt ? { capturedAt: record.capturedAt } : {}),
      reservedAt: record.reservedAt,
      completedAt: record.completedAt,
    }
  }

  async nightAllCompatibilitySearch(context, { operation, body, idempotencyKey, path }) {
    assert(NIGHT_ALL_LEGACY_OPERATIONS.has(operation), 404, 'not_found', 'Route not found')
    assert(idempotencyKey, 400, 'idempotency_key_required', 'Idempotency-Key header is required')
    assert(
      typeof idempotencyKey === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey),
      400,
      'invalid_idempotency_key',
      'Idempotency-Key must contain 8-128 safe characters',
    )
    assert(body && typeof body === 'object' && !Array.isArray(body), 400, 'invalid_request', 'JSON object body is required')

    const requestedPlatform = canonicalPlatform(body.platform)
    assert(!RESERVED_PLATFORM_NAMES.has(requestedPlatform), 400, 'invalid_platform', 'A single explicit platform is required')
    const grants = await this.store.listGrants(context.consumer.id)
    const matchingGrant = grants.find((grant) => canonicalPlatform(grant) === requestedPlatform)
    assert(matchingGrant, 403, 'platform_not_granted', 'Platform is not granted')
    const storedPolicy = (await this.store.getPolicy(context.consumer.id, requestedPlatform))
      || (matchingGrant !== requestedPlatform
        ? await this.store.getPolicy(context.consumer.id, matchingGrant)
        : null)
    const policy = {
      ...this.defaultPolicy,
      ...(storedPolicy || {}),
    }
    const normalized = normalizeNightAllCompatibilityRequest(operation, body, {
      businessId: context.consumer.businessId,
      canonicalizePlatform: canonicalPlatform,
      maxPageSize: policy.maxPageSize,
    })
    const fingerprint = requestFingerprint({
      method: 'POST',
      path,
      body: { contractVersion: 'mx-insight-hub.night-all-compat.v1', ...normalized.upstreamBody },
    })
    const requestId = randomUUID()
    const windowStart = new Date(Date.now() - policy.windowSeconds * 1_000)
    const reservationInput = {
      requestId,
      idempotencyKey,
      fingerprint,
      tenantId: context.tenant.id,
      consumerId: context.consumer.id,
      apiKeyId: context.apiKey.id,
      platform: normalized.platform,
      unitsReserved: 1,
      leaseExpiresAt: new Date(Date.now() + this.reservationLeaseMs),
      windowStart,
      maxRequests: policy.maxRequests,
      // A compatibility Idempotency-Key names one immutable paid dispatch.
      // Reusing its usage row after two minutes would overwrite billing
      // evidence and let repeated upstream calls count as one quota request.
      replayWindowMs: null,
    }

    await this.store.reapStaleReservations()
    let reservation
    const existing = await this.store.getUsageRequestByIdempotencyKey(
      context.consumer.id,
      idempotencyKey,
    )
    if (compatibilityIdempotencyStateIsDecisive(existing, fingerprint)) {
      reservation = await this.store.reserve(reservationInput)
    } else {
      let precheckError = null
      let compatibilityCapabilities
      try {
        compatibilityCapabilities = await this.adapter.legacySearchCapabilities([normalized.platform])
      } catch (_error) {
        precheckError = new AppError(
          503,
          'compatibility_capabilities_unavailable',
          'Night-All compatibility capabilities are unavailable',
        )
      }
      if (!precheckError) {
        const operationState = compatibilityOperationState(
          compatibilityCapabilities,
          operation,
          normalized.platform,
        )
        if (operationState === 'invalid') {
          precheckError = new AppError(
            503,
            'compatibility_capabilities_unavailable',
            'Night-All compatibility capabilities are unavailable',
          )
        } else if (operationState === 'unsupported') {
          precheckError = new AppError(
            400,
            'platform_operation_unsupported',
            'The platform does not support this Night-All compatibility operation',
            { platform: normalized.platform, operation },
          )
        } else if (operationState === 'unavailable') {
          precheckError = new AppError(
            503,
            'platform_operation_unavailable',
            'The platform operation is not currently ready in Night-All',
            { platform: normalized.platform, operation },
          )
        }
      }
      if (precheckError) {
        const raced = await this.store.getUsageRequestByIdempotencyKey(
          context.consumer.id,
          idempotencyKey,
        )
        if (!compatibilityIdempotencyStateIsDecisive(raced, fingerprint)) throw precheckError
      }
      reservation = await this.store.reserve(reservationInput)
    }

    if (reservation.kind === 'conflict') {
      throw new AppError(409, 'idempotency_conflict', 'Idempotency-Key was used with a different request')
    }
    if (reservation.kind === 'in_progress') {
      throw new AppError(409, 'request_in_progress', 'Request with this Idempotency-Key is in progress', {
        requestId: reservation.request.id,
      })
    }
    if (reservation.kind === 'unknown') {
      throw new AppError(409, 'request_outcome_unknown', 'Previous request outcome is unknown', {
        requestId: reservation.request.id,
      })
    }
    if (reservation.kind === 'replay') {
      const sourceMode = reservation.request.deliverySourceMode || 'live'
      const capturedAt = reservation.request.capturedAt || null
      return {
        status: reservation.request.responseStatus,
        body: reservation.request.responseBody,
        requestId: reservation.request.id,
        replay: true,
        sourceMode,
        capturedAt,
        staleAgeSeconds: sourceMode === 'stale' && capturedAt
          ? Math.max(0, Math.floor((Date.now() - new Date(capturedAt).getTime()) / 1_000))
          : 0,
      }
    }

    const activeRequestId = reservation.request.id
    let call
    try {
      call = await this.store.beginConnectorCall({
        consumerId: context.consumer.id,
        requestId: activeRequestId,
        operation,
        fingerprint,
        platform: normalized.platform,
        sourceMode: 'live',
      })
    } catch (error) {
      await this.store.releaseRequest(activeRequestId, 'connector_call_evidence_failed').catch(() => {})
      throw error
    }

    const startedAt = performance.now()
    let commitAttempted = false
    let commitEvidence = null
    try {
      const upstream = await this.adapter.legacySearch({
        operation,
        body: normalized.upstreamBody,
        businessId: context.consumer.businessId,
      })
      const businessOutcome = nightAllCompatibilityBusinessOutcome(upstream.payload)
      const capturedAt = new Date()
      const staleUntil = new Date(capturedAt.getTime() + nightAllCompatibilityFallbackWindowMs(operation))
      const upstreamLatencyMs = Math.round(performance.now() - startedAt)
      const unitsActual = nightAllCompatibilityItemCount(upstream.payload)
      commitEvidence = {
        outcome: businessOutcome,
        httpStatus: 200,
        businessStatus: businessOutcome,
        failureKind: businessOutcome === 'partial' ? 'business' : null,
        upstreamLatencyMs,
        errorCode: businessOutcome === 'partial' ? 'night_all_partial_result' : null,
        sourceMode: 'live',
        nightAllRequestId: upstream.raw?.requestId ?? null,
        nightAllTraceId: upstream.raw?.traceId ?? null,
      }
      commitAttempted = true
      await this.store.commitCompatibilityLiveDelivery(call.id, {
        ...commitEvidence,
        responseStatus: 200,
        responseBody: upstream.payload,
        unitsActual,
        capturedAt,
        staleUntil,
        job: {
          queue: this.ingestQueueName,
          payload: {
            kind: 'night-all-compat-result',
            platform: normalized.platform,
            operation,
            rawPayload: upstream.raw,
            queryFingerprint: fingerprint,
            requestId: activeRequestId,
            connectorCallId: call.id,
          },
          // Every real dispatch has a unique connector call. Keying ingestion
          // by that immutable call keeps observation lineage exact and also
          // avoids collisions if a future policy permits a fresh dispatch.
          dedupeKey: `night-all-compat-result:${call.id}`,
          priority: 100,
        },
      })
      return {
        status: 200,
        body: upstream.payload,
        requestId: activeRequestId,
        replay: false,
        sourceMode: 'live',
        capturedAt: capturedAt.toISOString(),
        staleAgeSeconds: 0,
      }
    } catch (error) {
      if (canUseNightAllCompatibilityFallback(error)) {
        let snapshot
        try {
          snapshot = await this.store.findUsableCompatibilitySnapshot({
            consumerId: context.consumer.id,
            operation,
            fingerprint,
          })
        } catch (_snapshotLookupError) {
          const evidence = compatibilityUpstreamEvidence(error)
          await this.store.finishConnectorCall(call.id, {
            outcome: evidence.outcome === 'unknown' ? 'unknown' : 'failed',
            httpStatus: error instanceof UpstreamRejectedError ? error.status : null,
            businessStatus: evidence.outcome === 'unknown' ? 'unknown' : 'failed',
            upstreamLatencyMs: Math.round(performance.now() - startedAt),
            errorCode: evidence.errorCode,
            failureKind: compatibilityFailureKind(error),
            sourceMode: 'live',
            nightAllRequestId: error instanceof UpstreamRejectedError ? error.body?.requestId ?? null : null,
            nightAllTraceId: error instanceof UpstreamRejectedError ? error.body?.traceId ?? null : null,
          }).catch(() => {})
          if (error instanceof UpstreamAmbiguousError) {
            await this.store.markRequestUnknown(activeRequestId, 'night_all_outcome_unknown').catch(() => {})
          } else {
            await this.store.releaseRequest(activeRequestId, 'compatibility_snapshot_lookup_failed').catch(() => {})
          }
          throw new AppError(
            503,
            'compatibility_store_unavailable',
            'Night-All fallback store is temporarily unavailable',
            { requestId: activeRequestId },
          )
        }
        if (snapshot) {
          const evidence = compatibilityUpstreamEvidence(error)
          const upstreamLatencyMs = Math.round(performance.now() - startedAt)
          const staleAgeSeconds = staleSnapshotAgeSeconds(snapshot)
          commitEvidence = {
            outcome: evidence.outcome === 'unknown' ? 'unknown' : 'failed',
            httpStatus: error instanceof UpstreamRejectedError ? error.status : null,
            businessStatus: evidence.outcome === 'unknown' ? 'unknown' : 'failed',
            upstreamLatencyMs,
            errorCode: evidence.errorCode,
            failureKind: compatibilityFailureKind(error),
            sourceMode: 'live',
            nightAllRequestId: error instanceof UpstreamRejectedError ? error.body?.requestId ?? null : null,
            nightAllTraceId: error instanceof UpstreamRejectedError ? error.body?.traceId ?? null : null,
          }
          commitAttempted = true
          try {
            await this.store.commitCompatibilityStaleDelivery(call.id, {
              snapshotId: snapshot.id,
              responseStatus: 200,
              unitsActual: nightAllCompatibilityItemCount(snapshot.responseBody),
              httpStatus: commitEvidence.httpStatus,
              businessStatus: commitEvidence.businessStatus,
              upstreamLatencyMs,
              errorCode: evidence.errorCode,
              failureKind: commitEvidence.failureKind,
              nightAllRequestId: commitEvidence.nightAllRequestId,
              nightAllTraceId: commitEvidence.nightAllTraceId,
            })
          } catch (persistenceError) {
            await this.store.finishConnectorCall(call.id, {
              ...commitEvidence,
              errorCode: 'compatibility_persistence_failed',
            }).catch(() => {})
            await this.store.markRequestUnknown(activeRequestId, 'compatibility_commit_ambiguous').catch(() => {})
            throw persistenceError
          }
          return {
            status: 200,
            body: snapshot.responseBody,
            requestId: activeRequestId,
            replay: false,
            sourceMode: 'stale',
            capturedAt: snapshot.capturedAt,
            staleAgeSeconds,
          }
        }
      }

      if (error instanceof UpstreamRejectedError || error instanceof UpstreamAmbiguousError) {
        const evidence = compatibilityUpstreamEvidence(error)
        await this.store.finishConnectorCall(call.id, {
          outcome: error instanceof UpstreamAmbiguousError ? 'unknown' : 'failed',
          httpStatus: error instanceof UpstreamRejectedError ? error.status : null,
          businessStatus: error instanceof UpstreamAmbiguousError ? 'unknown' : 'failed',
          upstreamLatencyMs: Math.round(performance.now() - startedAt),
          errorCode: evidence.errorCode,
          failureKind: compatibilityFailureKind(error),
          sourceMode: 'live',
          nightAllRequestId: error instanceof UpstreamRejectedError ? error.body?.requestId ?? null : null,
          nightAllTraceId: error instanceof UpstreamRejectedError ? error.body?.traceId ?? null : null,
        }).catch(() => {})
      }
      if (error instanceof UpstreamRejectedError) {
        await this.store.releaseRequest(activeRequestId, `night_all_http_${error.status}`)
        throw new AppError(
          compatibilityPublicStatus(error),
          'night_all_rejected',
          'Night-All rejected the request',
          { requestId: activeRequestId, upstreamStatus: error.status },
        )
      }
      if (error instanceof UpstreamAmbiguousError) {
        await this.store.markRequestUnknown(activeRequestId, 'night_all_outcome_unknown')
        throw new AppError(502, 'upstream_outcome_unknown', 'Night-All outcome is unknown; do not retry automatically', {
          requestId: activeRequestId,
        })
      }
      if (commitAttempted) {
        if (commitEvidence) {
          await this.store.finishConnectorCall(call.id, {
            ...commitEvidence,
            errorCode: 'compatibility_persistence_failed',
          }).catch(() => {})
        }
        await this.store.markRequestUnknown(activeRequestId, 'compatibility_commit_ambiguous').catch(() => {})
        throw error
      }
      await this.store.finishConnectorCall(call.id, {
        outcome: 'failed',
        upstreamLatencyMs: Math.round(performance.now() - startedAt),
        errorCode: 'internal_error',
        failureKind: 'internal',
        sourceMode: 'live',
      }).catch(() => {})
      await this.store.releaseRequest(activeRequestId, 'internal_error')
      throw error
    }
  }

  async search(context, { body, idempotencyKey, path }) {
    assert(idempotencyKey, 400, 'idempotency_key_required', 'Idempotency-Key header is required')
    assert(
      typeof idempotencyKey === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey),
      400,
      'invalid_idempotency_key',
      'Idempotency-Key must contain 8-128 safe characters',
    )
    assert(body && typeof body === 'object' && !Array.isArray(body), 400, 'invalid_request', 'JSON object body is required')
    const dedicatedTelegramSearch = path === '/api/v1/data/telegram/search'
    const unsupportedFields = dedicatedTelegramSearch
      ? []
      : Object.keys(body).filter((field) => !PUBLIC_SEARCH_FIELDS.has(field))
    assert(unsupportedFields.length === 0, 400, 'unsupported_fields', `Unsupported public fields: ${unsupportedFields.join(', ')}`)
    const platform = dedicatedTelegramSearch ? 'telegram' : canonicalPlatform(body.platform)
    assert(!RESERVED_PLATFORM_NAMES.has(platform), 400, 'invalid_platform', 'A single explicit platform is required')
    const query = requiredString(body.query, 'query')
    assert(query.length <= 500, 400, 'invalid_request', 'query must not exceed 500 characters')
    const grants = await this.store.listGrants(context.consumer.id)
    assert(grants.includes(platform), 403, 'platform_not_granted', 'Platform is not granted')
    assert(
      platform !== PUBLIC_OPINION_PLATFORM,
      400,
      'platform_operation_unsupported',
      'public_opinion is Hub-stored; use the province feed or canonical stored search',
    )

    const policy = {
      ...this.defaultPolicy,
      ...((await this.store.getPolicy(context.consumer.id, platform)) || {}),
    }
    const pageSize = positiveInteger(body.pageSize, 'pageSize', 20)
    assert(
      pageSize <= policy.maxPageSize,
      400,
      'page_size_exceeded',
      `pageSize must not exceed ${policy.maxPageSize}`,
    )
    let cursor
    if (body.cursor != null) {
      cursor = requiredString(body.cursor, 'cursor')
      assert(cursor.length <= 8192, 400, 'invalid_cursor', 'cursor is too long')
    }
    const telegramQuery = platform === 'telegram'
      ? normalizeTelegramSearchQuery(
          dedicatedTelegramSearch
            ? body
            : { query, pageSize, ...(cursor ? { cursor } : {}), scope: 'messages' },
          policy.maxPageSize,
          this.apiKeyPepper,
        )
      : null
    const upstreamBody = {
      platform,
      query,
      pageSize,
      ...(cursor ? { cursor } : {}),
    }
    const resultType = resolveResultType(body)
    let fingerprintQuery = telegramQuery ?? upstreamBody
    if (telegramQuery && (!dedicatedTelegramSearch || body.sourceScope == null)) {
      // Preserve the pre-sourceScope idempotency fingerprint for callers that
      // did not opt into the additive multi-source contract. This lets an
      // in-flight retry across a Hub upgrade replay its existing request.
      fingerprintQuery = { ...telegramQuery }
      delete fingerprintQuery.sourceScope
    }
    const fingerprint = requestFingerprint({
      method: 'POST',
      path,
      body: { ...fingerprintQuery, type: resultType },
    })
    const requestId = randomUUID()
    const windowStart = new Date(Date.now() - policy.windowSeconds * 1_000)
    await this.store.reapStaleReservations()
    const reservation = await this.store.reserve({
      requestId,
      idempotencyKey,
      fingerprint,
      tenantId: context.tenant.id,
      consumerId: context.consumer.id,
      apiKeyId: context.apiKey.id,
      platform,
      unitsReserved: 1,
      leaseExpiresAt: new Date(Date.now() + this.reservationLeaseMs),
      windowStart,
      maxRequests: policy.maxRequests,
      replayWindowMs: replayWindowFor(resultType),
    })

    if (reservation.kind === 'conflict') {
      throw new AppError(409, 'idempotency_conflict', 'Idempotency-Key was used with a different request')
    }
    if (reservation.kind === 'in_progress') {
      throw new AppError(409, 'request_in_progress', 'Request with this Idempotency-Key is in progress', {
        requestId: reservation.request.id,
      })
    }
    if (reservation.kind === 'unknown') {
      throw new AppError(409, 'request_outcome_unknown', 'Previous request outcome is unknown', {
        requestId: reservation.request.id,
      })
    }
    if (reservation.kind === 'replay') {
      return {
        status: reservation.request.responseStatus,
        body: reservation.request.responseBody,
        requestId: reservation.request.id,
        replay: true,
      }
    }

    const activeRequestId = reservation.request.id
    const startedAt = performance.now()
    let commitAttempted = false
    try {
      const localTelegram = platform === 'telegram'
      const upstream = localTelegram
        ? null
        : await this.adapter.search({
            body: upstreamBody,
            businessId: context.consumer.businessId,
          })
      const responseBody = localTelegram
        ? await this.#searchStoredTelegram(telegramQuery, startedAt)
        : upstream.payload
      const itemCount = Array.isArray(responseBody?.data?.items) ? responseBody.data.items.length : 0
      const commit = {
        responseStatus: 200,
        responseBody,
        unitsActual: Math.max(1, itemCount),
        upstreamLatencyMs: Math.round(performance.now() - startedAt),
      }

      // Persist the result as authoritative Hub data.
      //
      // Ingestion is queued rather than run inline. Two reasons, and the second
      // matters more than the first:
      //
      //  1. Latency. Normalising and writing a page of items costs several
      //     round trips the caller should not wait for; the billed upstream
      //     result is already in hand.
      //  2. Durability. The commit and the enqueue happen in ONE transaction,
      //     so a committed request can never exist without its ingest job. The
      //     previous inline version was best-effort and swallowed failures,
      //     which meant a transient database error silently lost the data with
      //     nothing left to retry from.
      commitAttempted = true
      if (!localTelegram && this.store.commitRequestAndEnqueueIngest) {
        await this.store.commitRequestAndEnqueueIngest(activeRequestId, commit, {
          queue: this.ingestQueueName,
          payload: {
            kind: 'search-result',
            platform,
            rawPayload: upstream.raw,
            queryFingerprint: fingerprint,
            requestId: activeRequestId,
          },
          // The request id is already unique per billed call, so a retried
          // commit cannot enqueue the same page twice.
          dedupeKey: `search-result:${activeRequestId}`,
        })
      } else {
        // Stores without a transactional queue (the in-memory one) keep the
        // simple path; they persist nothing anyway.
        await this.store.commitRequest(activeRequestId, commit)
      }

      return { status: 200, body: responseBody, requestId: activeRequestId, replay: false }
    } catch (error) {
      if (error instanceof UpstreamRejectedError) {
        await this.store.releaseRequest(activeRequestId, `night_all_http_${error.status}`)
        throw new AppError(502, 'night_all_rejected', 'Night-All rejected the request', {
          requestId: activeRequestId,
          upstreamStatus: error.status,
        })
      }
      if (error instanceof UpstreamAmbiguousError) {
        await this.store.markRequestUnknown(activeRequestId, 'night_all_outcome_unknown')
        throw new AppError(502, 'upstream_outcome_unknown', 'Night-All outcome is unknown; do not retry automatically', {
          requestId: activeRequestId,
        })
      }
      if (commitAttempted) {
        // A database error after the commit call begins cannot prove whether
        // the write committed before the connection failed. Preserve that
        // uncertainty so the same idempotency key cannot execute the request
        // again. The store permits committed -> unknown for this exact case,
        // but never committed -> released.
        await this.store.markRequestUnknown(activeRequestId, 'usage_commit_ambiguous').catch(() => {})
        throw error
      }
      await this.store.releaseRequest(activeRequestId, 'internal_error')
      throw error
    }
  }

  async #searchStoredTelegram(query, startedAt) {
    if (!this.searchQueries?.searchContent) {
      throw new AppError(503, 'stored_search_unavailable', 'Stored Telegram search requires the PostgreSQL search layer')
    }
    const datasets = query.scope === 'all'
      ? [
          ...telegramStoredDatasetIds(query.sourceScope, 'messages'),
          ...telegramStoredDatasetIds(query.sourceScope, 'chats'),
        ]
      : telegramStoredDatasetIds(query.sourceScope, query.scope)
    const result = await this.searchQueries.searchContent(query.query, {
      platform: 'telegram',
      datasetIds: datasets,
      objectType: query.scope === 'all' ? null : query.scope === 'chats' ? 'chat' : 'message',
      authorExternalId: query.authorId,
      chatId: query.chatId,
      fromTime: query.from,
      toTime: query.to,
      size: query.pageSize,
      cursor: query.cursor,
    })
    return telegramDataSearchResponse({
      query: query.query,
      result,
      pageSize: query.pageSize,
      cursor: query.cursor,
      cursorBinding: query.cursorBinding,
      cursorSecret: this.apiKeyPepper,
      durationMs: Math.round(performance.now() - startedAt),
    })
  }
}
