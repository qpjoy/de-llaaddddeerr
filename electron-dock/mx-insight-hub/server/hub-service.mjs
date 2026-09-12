import { storedEcommerceQuery } from './contracts/ecommerce-stored.mjs'
import { randomUUID } from 'node:crypto'
import { hmacSecret, issueApiKey, requestFingerprint } from './core/crypto.mjs'
import { AppError, UpstreamAmbiguousError, UpstreamRejectedError, assert } from './core/errors.mjs'
import {
  buildNightAllLegacySearchCapabilities,
  NIGHT_ALL_LEGACY_OPERATIONS,
} from './contracts/night-all-legacy.mjs'
import { XIAOHONGSHU_POST_OPERATION } from './contracts/tikhub-xiaohongshu.mjs'
import {
  normalizeBillingProfile,
  normalizeCreditAdjustment,
  normalizePublishedPlan,
} from './billing/contracts.mjs'
import {
  XIAOHONGSHU_SEARCH_MAX_QUERY_LENGTH,
  XIAOHONGSHU_SEARCH_OPERATION,
} from './contracts/tikhub-xiaohongshu-search.mjs'
import { XIAOHONGSHU_USER_INFO_OPERATION } from './contracts/tikhub-xiaohongshu-user-info.mjs'
import { XIAOHONGSHU_CRAWL_OPERATION } from './contracts/tikhub-xiaohongshu-user-posts.mjs'
import { XIAOHONGSHU_APP_V2_COMPAT_CAPABILITY } from './contracts/tikhub-xiaohongshu-official.mjs'
import { JUSTONE_OPERATION } from './contracts/justone.mjs'
import { JUSTONE_RESOURCE_OPERATION_KEYS } from './contracts/justone-resources.mjs'
import { SOCIAL_ACCOUNT_SEARCH_OPERATION } from './contracts/social-accounts.mjs'
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
  CRAWLER_SAVED_RECORDS_PLATFORM_PREFIX,
  canonicalSearchResponse,
  normalizeCanonicalSearchQuery,
  normalizeStoredSearchQuery,
  storedSearchResponse,
} from './data/stored-search.mjs'
import { CRAWLER_SOURCES } from './ingest/crawler/source-contract.mjs'
import {
  canonicalContextCapability,
  canonicalContextResponse,
  normalizeCanonicalContextQuery,
} from './data/canonical-context.mjs'
import {
  canonicalTimelineCapability,
  canonicalTimelineContinuationResponse,
  canonicalTimelineInitialResponse,
  canonicalTimelineScopeFingerprint,
  normalizeCanonicalTimelineQuery,
} from './data/canonical-timeline.mjs'
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
  VIRTUAL_SUPERMARKET_ADMIN_CONTRACT,
  VIRTUAL_SUPERMARKET_PLATFORM,
  normalizeVirtualSupermarketCategoryCreate,
  normalizeVirtualSupermarketCategoryPatch,
  normalizeVirtualSupermarketProductPatch,
  normalizeVirtualSupermarketPublication,
  normalizeVirtualSupermarketQuery,
  virtualSupermarketCategoryResponse,
  virtualSupermarketDetail,
  virtualSupermarketMetadata,
  virtualSupermarketPage,
} from './data/virtual-supermarket.mjs'
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
import {
  capNightAllCompatibilityTraversal,
  capNightAllDataSearchTraversal,
  prepareNightAllCompatibilityTraversal,
} from './data/night-all-pagination.mjs'
import { createNightAllCompatibilityCursorCodec } from './external-platforms/cursor.mjs'
import {
  normalizeTopicReportRequest,
  TOPIC_REPORT_PLATFORMS,
  TOPIC_REPORT_USAGE_SCOPE,
} from './insights/topic-reports.mjs'

// A data product is opened by many people at once inside a customer company,
// and a cache hit consumes this quota just as a live acquisition does, so the
// window has to hold a whole team's browsing rather than one person's session.
// This is Hub's own service quota; it does not loosen any upstream cost control.
const DEFAULT_POLICY = Object.freeze({
  maxRequests: 100_000,
  windowSeconds: 3_600,
  maxPageSize: 100,
})
const DEFAULT_API_KEY_LIFETIME_DAYS = 180
const MAX_API_KEY_LIFETIME_DAYS = 730
const DEFAULT_EXTERNAL_MEDIA_POLICY = Object.freeze({
  maxRequests: 1_200,
  windowMs: 60_000,
  maxConcurrency: 16,
})

function isTestApiKey(apiKey) {
  return apiKey?.environment === 'test' || apiKey?.prefix?.startsWith('mih_test_')
}

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
const ECOMMERCE_PLATFORM = 'ecommerce'
const XIAOHONGSHU_SEARCH_CAPABILITY = 'search_posts'
const DIRECT_XIAOHONGSHU_PAGE_SIZE = 20
const DIRECT_XIAOHONGSHU_CURSOR_PREFIX = 'mxec2.'

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
  XIAOHONGSHU_SEARCH_OPERATION,
  XIAOHONGSHU_POST_OPERATION,
  XIAOHONGSHU_USER_INFO_OPERATION,
  XIAOHONGSHU_CRAWL_OPERATION,
  XIAOHONGSHU_APP_V2_COMPAT_CAPABILITY,
  JUSTONE_OPERATION,
  // Each released platform-shaped resource family is its own capability, so a
  // key granted product search never gains a paid detail or reviews call with
  // it. The list is derived from the registry rather than restated here.
  ...JUSTONE_RESOURCE_OPERATION_KEYS,
  SOCIAL_ACCOUNT_SEARCH_OPERATION,
  PUBLIC_OPINION_ALL_INGESTED_CAPABILITY,
  PUBLIC_OPINION_DIAGNOSTICS_CAPABILITY,
])
const NIGHT_ALL_XIAOHONGSHU_OPERATION_CAPABILITIES = Object.freeze({
  raw: XIAOHONGSHU_SEARCH_OPERATION,
  crawl: XIAOHONGSHU_CRAWL_OPERATION,
  'user-info': XIAOHONGSHU_USER_INFO_OPERATION,
})
const XIAOHONGSHU_ACQUISITION_CAPABILITIES = new Set([
  XIAOHONGSHU_SEARCH_OPERATION,
  XIAOHONGSHU_POST_OPERATION,
  XIAOHONGSHU_USER_INFO_OPERATION,
  XIAOHONGSHU_CRAWL_OPERATION,
  XIAOHONGSHU_APP_V2_COMPAT_CAPABILITY,
])
const CANONICAL_SEARCH_USAGE_SCOPE = 'data.canonical-search'
const TOKENIZE_MAX_TEXT_LENGTH = 4_096
const TOKENIZE_MAX_TOKENS = 8_192
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/

function providerOperationReady(providerCapability, operationKey) {
  const operationReady = providerCapability?.operations?.[operationKey]?.ready
  return typeof operationReady === 'boolean'
    ? operationReady
    : Boolean(providerCapability?.ready)
}

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

function requiredIdempotencyKey(value) {
  assert(value, 400, 'idempotency_key_required', 'Idempotency-Key header is required')
  assert(
    typeof value === 'string' && IDEMPOTENCY_KEY_PATTERN.test(value),
    400,
    'invalid_idempotency_key',
    'Idempotency-Key must contain 8-128 safe characters',
  )
  return value
}

function publicRequestStatus(record) {
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
    apiKeyId: optionalUuid(filters.apiKeyId, 'apiKeyId'),
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

function requestedScopes(value, field, canonicalize) {
  if (value == null) return null
  assert(Array.isArray(value), 400, 'invalid_request', `${field} must be an array`)
  assert(value.length <= 128, 400, 'invalid_request', `${field} must contain at most 128 entries`)
  return [...new Set(value.map((entry) => canonicalize(entry)))].sort()
}

function apiKeyScopePreset(value) {
  const preset = value == null ? 'none' : value
  assert(
    typeof preset === 'string' && ['none', 'legacy_all'].includes(preset),
    400,
    'invalid_request',
    'scopePreset must be none or legacy_all',
  )
  return preset
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

function compatibilityIdempotencyStateIsDecisive(record, fingerprint) {
  if (!record) return false
  return record.fingerprint !== fingerprint
    || ['committed', 'reserved', 'unknown'].includes(record.status)
}

function isDirectXiaohongshuCursor(value) {
  return typeof value === 'string' && value.startsWith(DIRECT_XIAOHONGSHU_CURSOR_PREFIX)
}

function directXiaohongshuLegacyRawRequest(operation, normalized) {
  if (operation !== 'raw' || normalized.platform !== 'xiaohongshu') return null
  const body = normalized.upstreamBody
  const singular = ['keyword', 'query'].filter((field) => (
    typeof body[field] === 'string' && body[field].trim()
  ))
  if (singular.length !== 1 || body.keywords != null || body.queries != null) return null
  // The historical facade accepts identifiers up to 2,048 characters, while
  // the pinned direct search contract accepts 500. Preserve the older request
  // instead of changing a formerly valid legacy shape into a direct 400.
  if (body[singular[0]].trim().length > XIAOHONGSHU_SEARCH_MAX_QUERY_LENGTH) return null
  if (normalized.pageSize !== DIRECT_XIAOHONGSHU_PAGE_SIZE) return null
  if (body.cursor && !isDirectXiaohongshuCursor(body.cursor)) return null
  if (body.page != null && (body.page !== 1 || body.cursor)) return null
  // Detail enrichment is already an atomic, cost-governed Hub-native search
  // workflow. Shapes that fan out or carry Night-All-specific comment,
  // continuation, cache, or concurrency semantics stay historical until an
  // equivalent Hub-native contract exists.
  if (
    body.params != null
    || body.includeComments === true
    || body.commentLimit != null
    || body.commentCursor != null
    || body.cacheMaxAgeHours != null
    || body.enrichConcurrency != null
    || body.concurrency != null
  ) return null
  return {
    body: {
      platform: 'xiaohongshu',
      query: body[singular[0]],
      pageSize: normalized.pageSize,
      ...(body.cursor ? { cursor: body.cursor } : {}),
    },
    enrichment: {
      includeDetails: body.includeDetails === true,
      disableAutoDetails: body.disableAutoDetails === true,
      ...(body.maxEnrichItems != null ? { maxEnrichItems: body.maxEnrichItems } : {}),
    },
  }
}

function directXiaohongshuLegacyUserActivityRequest(operation, normalized) {
  if (!['crawl', 'user-info'].includes(operation) || normalized.platform !== 'xiaohongshu') return null
  const body = normalized.upstreamBody
  const identifierFields = operation === 'crawl'
    ? ['username', 'usernames', 'userId', 'userIds', 'user_id', 'uid', 'url', 'urls']
    : ['username', 'usernames', 'userId', 'userIds', 'user_id', 'uid', 'url', 'profileUrl', 'profile_url', 'urls']
  const allowed = new Set([
    'platform', ...identifierFields, 'count', 'limit', 'pageSize', 'page',
    ...(operation === 'crawl' ? ['cursor', 'params', 'activityTypes', 'concurrency'] : []),
  ])
  if (Object.keys(body).some((field) => !allowed.has(field))) return null
  const supplied = identifierFields.filter((field) => body[field] != null && body[field] !== '')
  const arrays = new Set(['usernames', 'userIds', 'urls'])
  const count = supplied.reduce((sum, field) => (
    sum + (arrays.has(field) && Array.isArray(body[field]) ? body[field].length : 1)
  ), 0)
  if (count !== 1) return null
  const userIdField = supplied.find((field) => ['userId', 'userIds', 'user_id', 'uid'].includes(field))
  if (userIdField) {
    const value = arrays.has(userIdField) ? body[userIdField][0] : body[userIdField]
    if (!/^[0-9a-f]{24}$/iu.test(String(value))) return null
  }
  if (operation === 'user-info') {
    if (body.page != null && body.page !== 1) return null
    return { body }
  }
  if (normalized.pageSize !== DIRECT_XIAOHONGSHU_PAGE_SIZE) return null
  if (body.activityTypes != null && (
    !Array.isArray(body.activityTypes)
    || body.activityTypes.length !== 1
    || body.activityTypes[0] !== 'posts'
  )) return null
  if (body.concurrency != null && body.concurrency !== 1) return null
  const directCursor = body.cursor || body.params?.cursor || null
  if (body.params != null && (
    !body.params
    || typeof body.params !== 'object'
    || Array.isArray(body.params)
    || Object.keys(body.params).some((field) => field !== 'cursor')
  )) return null
  if (directCursor && !isDirectXiaohongshuCursor(directCursor)) return null
  if (!directCursor && body.page != null && body.page !== 1) return null
  if (body.cursor && body.params?.cursor && body.cursor !== body.params.cursor) return null
  return { body }
}

// Mirrors the CHECK constraint on tenants.status. A value outside this set is
// rejected here rather than surfacing as a database error.
const TENANT_STATUSES = new Set(['active', 'suspended'])

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
    externalPlatformCapabilities = null,
    externalPostCapabilities = null,
    externalSocialSearch = null,
    externalSocialSearchEnabled = false,
    externalSocialSearchCanaryConsumerIds = [],
    externalSocialUserActivity = null,
    externalSocialUserActivityEnabled = false,
    externalImageLoader = null,
    externalMediaPolicy = DEFAULT_EXTERNAL_MEDIA_POLICY,
    topicReports = null,
    logger = console,
  }) {
    const mediaPolicy = externalMediaPolicy || DEFAULT_EXTERNAL_MEDIA_POLICY
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
    this.externalPlatformCapabilities = externalPlatformCapabilities
    this.externalPostCapabilities = externalPostCapabilities
    this.externalSocialSearch = externalSocialSearch
    this.externalSocialSearchEnabled = externalSocialSearchEnabled === true
    this.externalSocialSearchCanaryConsumerIds = new Set(
      externalSocialSearchCanaryConsumerIds.map((consumerId) => String(consumerId).toLowerCase()),
    )
    this.externalSocialUserActivity = externalSocialUserActivity
    this.externalSocialUserActivityEnabled = externalSocialUserActivityEnabled === true
    this.externalImageLoader = externalImageLoader
    this.topicReports = topicReports
    this.externalMediaPolicy = {
      maxRequests: Math.max(1, Math.floor(Number(mediaPolicy.maxRequests) || DEFAULT_EXTERNAL_MEDIA_POLICY.maxRequests)),
      windowMs: Math.max(1_000, Math.floor(Number(mediaPolicy.windowMs) || DEFAULT_EXTERNAL_MEDIA_POLICY.windowMs)),
      maxConcurrency: Math.max(1, Math.floor(Number(mediaPolicy.maxConcurrency) || DEFAULT_EXTERNAL_MEDIA_POLICY.maxConcurrency)),
    }
    this.externalMediaWindows = new Map()
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

  // Stop a tenant calling, reversibly.
  //
  // Deliberately not a delete. The schema refuses to delete a tenant that has
  // usage or billing rows (those foreign keys are RESTRICT, not CASCADE), which
  // is the right call -- metering evidence should outlive the account. So the
  // console offers the operation that is actually safe to offer, and says so.
  async setTenantStatus(idInput, body) {
    const tenantId = requiredUuid(idInput, 'tenantId')
    const status = requiredString(body?.status, 'status')
    assert(
      TENANT_STATUSES.has(status),
      400,
      'invalid_tenant_status',
      `status must be one of ${[...TENANT_STATUSES].join(', ')}`,
    )
    assert(await this.store.getTenant(tenantId), 404, 'tenant_not_found', 'Tenant not found')
    assert(
      typeof this.store.setTenantStatus === 'function',
      503,
      'tenant_status_unavailable',
      'Tenant suspension requires the current Hub database migration',
    )
    const tenant = await this.store.setTenantStatus(tenantId, status)
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
    assert(body && typeof body === 'object' && !Array.isArray(body), 400, 'invalid_request', 'JSON object body is required')
    const unsupported = Object.keys(body).filter(
      (field) => !['consumerId', 'name', 'environment', 'expiresInDays', 'scopePreset', 'platforms', 'capabilities'].includes(field),
    )
    assert(unsupported.length === 0, 400, 'unsupported_fields', `Unsupported API key fields: ${unsupported.join(', ')}`)
    const consumerId = requiredUuid(body.consumerId, 'consumerId')
    const consumer = await this.store.getConsumer(consumerId)
    assert(consumer, 404, 'consumer_not_found', 'Consumer not found')
    const environment = body.environment || 'live'
    assert(['live', 'test'].includes(environment), 400, 'invalid_request', 'environment must be live or test')
    const expiresInDays = apiKeyLifetimeDays(body.expiresInDays)
    const expiresAt = new Date(Date.now() + expiresInDays * 86_400_000).toISOString()
    const consumerPlatforms = await this.store.listGrants(consumerId)
    const consumerCapabilities = typeof this.store.listCapabilityGrants === 'function'
      ? await this.store.listCapabilityGrants(consumerId)
      : []
    const scopePreset = apiKeyScopePreset(body.scopePreset)
    const requestedPlatforms = requestedScopes(body.platforms, 'platforms', canonicalPlatform)
    const requestedCapabilities = requestedScopes(body.capabilities, 'capabilities', canonicalCapability)
    assert(
      scopePreset !== 'legacy_all' || (requestedPlatforms == null && requestedCapabilities == null),
      400,
      'invalid_request',
      'legacy_all cannot be combined with explicit platforms or capabilities',
    )
    const platforms = requestedPlatforms ?? (scopePreset === 'legacy_all' ? [...consumerPlatforms] : [])
    const capabilities = requestedCapabilities ?? (scopePreset === 'legacy_all' ? [...consumerCapabilities] : [])
    const consumerPlatformSet = new Set(consumerPlatforms)
    const consumerCapabilitySet = new Set(consumerCapabilities)
    const plan = typeof this.store.getConsumerPlan === 'function'
      ? await this.store.getConsumerPlan(consumerId)
      : null
    const invalidPlatforms = platforms.filter((platform) => !consumerPlatformSet.has(platform))
    const invalidCapabilities = capabilities.filter((capability) => !consumerCapabilitySet.has(capability))
    assert(
      invalidPlatforms.length === 0,
      400,
      'api_key_scope_not_granted',
      `API key platforms must be a subset of the consumer grants: ${invalidPlatforms.join(', ')}`,
    )
    assert(
      invalidCapabilities.length === 0,
      400,
      'api_key_scope_not_granted',
      `API key capabilities must be a subset of the consumer grants: ${invalidCapabilities.join(', ')}`,
    )
    const platformEntitlements = await Promise.all(platforms.map(async (platform) => {
      const policy = { ...this.defaultPolicy, ...((await this.store.getPolicy(consumerId, platform)) || {}) }
      return {
        platform,
        maxRequests: Math.min(policy.maxRequests, plan?.limits?.maxRequests || Number.POSITIVE_INFINITY),
        windowSeconds: policy.windowSeconds,
        maxPageSize: Math.min(policy.maxPageSize, plan?.limits?.maxPageSize || Number.POSITIVE_INFINITY),
      }
    }))
    const capabilityEntitlements = await Promise.all(capabilities.map(async (capability) => {
      const policy = {
        ...this.defaultPolicy,
        ...((typeof this.store.getCapabilityPolicy === 'function'
          ? await this.store.getCapabilityPolicy(consumerId, capability)
          : null) || {}),
      }
      return {
        capability,
        maxRequests: Math.min(policy.maxRequests, plan?.limits?.maxRequests || Number.POSITIVE_INFINITY),
        windowSeconds: policy.windowSeconds,
      }
    }))
    const issued = issueApiKey(this.apiKeyPepper, environment)
    const record = await this.store.createApiKey({
      ...issued,
      environment,
      expiresAt,
      tenantId: consumer.tenantId,
      consumerId,
      name: requiredString(body.name, 'name'),
      platformEntitlements,
      capabilityEntitlements,
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
    const digest = hmacSecret(secret, this.apiKeyPepper)
    const context = await this.store.findApiKeyByDigest(digest)
    if (context) return context
    // Only now, having already refused, is it worth asking why. A suspended
    // tenant is an operator decision rather than a credential problem, and
    // reporting it as "invalid, expired, or revoked" sends the caller to
    // rotate a key that is perfectly good.
    if (typeof this.store.explainApiKeyRejection === 'function'
      && await this.store.explainApiKeyRejection(digest) === 'tenant_suspended') {
      throw new AppError(403, 'tenant_suspended', 'This tenant is suspended; contact the account owner to resume it')
    }
    assert(context, 401, 'invalid_api_key', 'API key is invalid, expired, or revoked')
    return context
  }

  listPlans() {
    assert(typeof this.store.listPlans === 'function', 503, 'plan_store_unavailable', 'Plans require the current Hub database migration')
    return this.store.listPlans()
  }

  publishPlanVersion(body, publishedByInput) {
    assert(
      typeof this.store.publishPlanVersion === 'function',
      503,
      'billing_store_unavailable',
      'Published customer pricing requires the current Hub database migration',
    )
    const publishedBy = requiredString(publishedByInput, 'publishedBy')
    assert(
      publishedBy.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(publishedBy),
      400,
      'invalid_request',
      'publishedBy must be at most 256 characters and contain no control characters',
    )
    return this.store.publishPlanVersion({
      ...normalizePublishedPlan(body),
      publishedBy,
    })
  }

  async getTenantBilling(tenantIdInput, options = {}) {
    const tenantId = requiredUuid(tenantIdInput, 'tenantId')
    assert(await this.store.getTenant(tenantId), 404, 'tenant_not_found', 'Tenant not found')
    assert(
      typeof this.store.getTenantBilling === 'function',
      503,
      'billing_store_unavailable',
      'Tenant billing requires the current Hub database migration',
    )
    return this.store.getTenantBilling(tenantId, options)
  }

  async setTenantBillingProfile(tenantIdInput, body, updatedByInput) {
    const tenantId = requiredUuid(tenantIdInput, 'tenantId')
    assert(await this.store.getTenant(tenantId), 404, 'tenant_not_found', 'Tenant not found')
    assert(
      typeof this.store.replaceTenantBillingProfile === 'function',
      503,
      'billing_store_unavailable',
      'Tenant billing requires the current Hub database migration',
    )
    return this.store.replaceTenantBillingProfile({
      tenantId,
      ...normalizeBillingProfile(body),
      updatedBy: requiredString(updatedByInput, 'updatedBy'),
    })
  }

  async addTenantCredit(tenantIdInput, body, { idempotencyKey, actor } = {}) {
    const tenantId = requiredUuid(tenantIdInput, 'tenantId')
    assert(await this.store.getTenant(tenantId), 404, 'tenant_not_found', 'Tenant not found')
    assert(
      typeof idempotencyKey === 'string'
        && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(idempotencyKey),
      400,
      'invalid_idempotency_key',
      'Idempotency-Key must contain 8-128 safe characters',
    )
    assert(
      typeof this.store.addTenantCredit === 'function',
      503,
      'billing_store_unavailable',
      'Tenant credit requires the current Hub database migration',
    )
    return this.store.addTenantCredit({
      tenantId,
      ...normalizeCreditAdjustment(body),
      idempotencyKey,
      actor: requiredString(actor, 'actor'),
    })
  }

  async reconcileUnknownCustomerCharge(
    usageRequestIdInput,
    body,
    { idempotencyKey, actor: actorInput } = {},
  ) {
    const usageRequestId = requiredUuid(usageRequestIdInput, 'usageRequestId')
    assert(
      body && typeof body === 'object' && !Array.isArray(body),
      400,
      'invalid_request',
      'JSON object body is required',
    )
    const unsupported = Object.keys(body).filter(
      (field) => !['disposition', 'reason'].includes(field),
    )
    assert(
      unsupported.length === 0,
      400,
      'unsupported_fields',
      `Unsupported customer charge reconciliation fields: ${unsupported.join(', ')}`,
    )
    const disposition = requiredString(body.disposition, 'disposition').toLowerCase()
    assert(
      disposition === 'capture' || disposition === 'release',
      400,
      'invalid_request',
      'disposition must be capture or release',
    )
    const reason = requiredString(body.reason, 'reason')
    assert(
      reason.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(reason),
      400,
      'invalid_request',
      'reason must be at most 1024 characters and contain no control characters',
    )
    const actor = requiredString(actorInput, 'actor')
    assert(
      actor.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(actor),
      400,
      'invalid_request',
      'actor must be at most 256 characters and contain no control characters',
    )
    assert(
      typeof this.store.reconcileUnknownCustomerCharge === 'function',
      503,
      'billing_store_unavailable',
      'Customer charge reconciliation requires the current Hub database migration',
    )
    return this.store.reconcileUnknownCustomerCharge({
      usageRequestId,
      disposition,
      idempotencyKey: requiredIdempotencyKey(idempotencyKey),
      actor,
      reason,
    })
  }

  async getConsumerPlan(consumerIdInput) {
    const consumerId = requiredUuid(consumerIdInput, 'consumerId')
    assert(await this.store.getConsumer(consumerId), 404, 'consumer_not_found', 'Consumer not found')
    assert(typeof this.store.getConsumerPlan === 'function', 503, 'plan_store_unavailable', 'Plans require the current Hub database migration')
    return this.store.getConsumerPlan(consumerId)
  }

  async assignConsumerPlan(consumerIdInput, body, assignedByInput) {
    assert(
      body && typeof body === 'object' && !Array.isArray(body),
      400,
      'invalid_request',
      'JSON object body is required',
    )
    const unsupported = Object.keys(body).filter(
      (field) => !['planVersionId', 'expectedRevision'].includes(field),
    )
    assert(
      unsupported.length === 0,
      400,
      'unsupported_fields',
      `Unsupported plan assignment fields: ${unsupported.join(', ')}`,
    )
    const consumerId = requiredUuid(consumerIdInput, 'consumerId').toLowerCase()
    const planVersionId = requiredUuid(body.planVersionId, 'planVersionId').toLowerCase()
    assert(
      Number.isInteger(body.expectedRevision)
        && body.expectedRevision > 0
        && body.expectedRevision <= 2_147_483_647,
      400,
      'invalid_request',
      'expectedRevision must be a positive 32-bit integer',
    )
    const assignedBy = requiredString(assignedByInput, 'assignedBy')
    assert(
      assignedBy.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(assignedBy),
      400,
      'invalid_request',
      'assignedBy must be at most 256 characters and contain no control characters',
    )
    assert(
      typeof this.store.replaceConsumerPlan === 'function',
      503,
      'plan_store_unavailable',
      'Plan assignment requires the current Hub database migration',
    )
    return this.store.replaceConsumerPlan({
      consumerId,
      planVersionId,
      expectedRevision: body.expectedRevision,
      assignedBy,
    })
  }

  // The layer every key under a consumer shares.
  //
  // Most reasons a call is refused are not properties of the key that made it:
  // a blocked provider operation and a spent consumer window reject every key
  // alike. Reporting them per key would print the same fact N times and cost
  // one provider probe per key, so they are gathered once here and the per-key
  // view keeps only what is genuinely per key.
  async getConsumerHealth(consumerIdInput) {
    const consumerId = requiredUuid(consumerIdInput, 'consumerId')
    const consumer = await this.store.getConsumer(consumerId)
    assert(consumer, 404, 'consumer_not_found', 'Consumer not found')

    const [plan, allKeys, capabilityGrants, tenant] = await Promise.all([
      typeof this.store.getConsumerPlan === 'function'
        ? this.store.getConsumerPlan(consumerId)
        : null,
      this.store.listApiKeys(consumerId),
      typeof this.store.listCapabilityGrants === 'function'
        ? this.store.listCapabilityGrants(consumerId)
        : [],
      // A suspended tenant rejects every key beneath it, and nothing else in
      // this payload would reveal that: the keys stay active, the quota stays
      // unspent, and the operations stay ready.
      this.store.getTenant(consumer.tenantId),
    ])
    const quota = typeof this.store.consumerQuotaSnapshot === 'function'
      ? await this.store.consumerQuotaSnapshot({ tenantId: consumer.tenantId, consumerId })
      : []

    const operations = {}
    for (const source of [this.externalPlatformCapabilities, this.externalPostCapabilities]) {
      if (typeof source !== 'function') continue
      try {
        const capability = await source({ consumerId })
        for (const [operationKey, state] of Object.entries(capability?.operations || {})) {
          operations[operationKey] = state
        }
      } catch {
        // Provider readiness is diagnostic here. A provider that cannot answer
        // must not stop the rest of the health view from rendering.
      }
    }
    // Only operations this consumer is actually granted. A provider operation
    // nobody here can call is an operator concern, not this consumer's.
    const granted = new Set(capabilityGrants.map((entry) => (
      typeof entry === 'string' ? entry : entry.capability
    )))
    // Two different ways an operation refuses work, kept apart because they
    // have different owners and different fixes. An operation can be perfectly
    // ready and still reject every unbilled call for having spent its monthly
    // procurement budget -- which is invisible from readiness alone, and was
    // previously only discoverable by making a call and reading the 429.
    const blockedOperations = Object.entries(operations)
      .filter(([operationKey, state]) => granted.has(operationKey) && (
        state?.ready === false || state?.budget?.exhausted === true
      ))
      .map(([operationKey, state]) => ({
        operation: operationKey,
        effectiveState: state.effectiveState || 'unknown',
        reason: state?.ready === false ? 'not_ready' : 'budget_exhausted',
        budget: state?.budget ?? null,
      }))
    // Not yet refusing, but close enough that it will during the next burst.
    const budgetWarnings = Object.entries(operations)
      .filter(([operationKey, state]) => granted.has(operationKey)
        && state?.ready !== false
        && state?.budget
        && state.budget.exhausted === false
        && Number.isFinite(state.budget.budgetMinor)
        && state.budget.budgetMinor > 0
        && state.budget.remainingMinor / state.budget.budgetMinor <= 0.1)
      .map(([operationKey, state]) => ({ operation: operationKey, budget: state.budget }))

    const now = Date.now()
    const keys = allKeys.map((key) => ({
      id: key.id,
      name: key.name,
      status: key.effectiveStatus || key.status,
      expiresAt: key.expiresAt,
    }))
    return {
      consumer: { id: consumer.id, name: consumer.name, tenantId: consumer.tenantId },
      tenant: tenant ? { id: tenant.id, name: tenant.name, status: tenant.status } : null,
      plan,
      quota,
      operations,
      blockedOperations,
      budgetWarnings,
      keys: {
        total: keys.length,
        active: keys.filter((key) => key.status === 'active').length,
        // Rotation should start before the key stops working, so keys already
        // inside the warning window are counted separately from healthy ones.
        expiringSoon: keys.filter((key) => key.status === 'active'
          && key.expiresAt
          && new Date(key.expiresAt).getTime() - now <= 14 * 86_400_000).length,
        unusable: keys.filter((key) => key.status === 'expired' || key.status === 'revoked').length,
      },
    }
  }

  // What a tenant sees after signing in: their own access, across every
  // consumer they own, in one answer.
  //
  // The operator console asks "which of all tenants is in trouble". A tenant
  // asks a different question -- "can my integration call right now, and how
  // long until something stops working" -- and that question is not answerable
  // from any one consumer page, because a tenant with several consumers has
  // several independent ceilings and gates.
  //
  // Per-consumer health is reused verbatim rather than re-derived, so the
  // tenant view and the operator view can never disagree about what is blocked.
  // That does mean one provider readiness probe per consumer; consumers are
  // fetched in parallel, and this stays proportional to a single tenant's
  // consumer count rather than the whole platform's.
  async getTenantOverview(tenantIdsInput) {
    const tenantIds = (Array.isArray(tenantIdsInput) ? tenantIdsInput : [tenantIdsInput])
      .filter(Boolean)
      .map((tenantId) => requiredUuid(tenantId, 'tenantId'))
    if (tenantIds.length === 0) return { tenants: [], generatedAt: new Date().toISOString() }

    const wanted = new Set(tenantIds)
    const allTenants = await this.store.listTenants()
    const tenants = allTenants.filter((tenant) => wanted.has(tenant.id))

    const resolved = await Promise.all(tenants.map(async (tenant) => {
      const consumers = await this.store.listConsumers(tenant.id)
      const health = await Promise.all(
        consumers.map((consumer) => this.getConsumerHealth(consumer.id)),
      )
      return {
        id: tenant.id,
        name: tenant.name,
        status: tenant.status,
        consumers: health,
      }
    }))

    return { tenants: resolved, generatedAt: new Date().toISOString() }
  }

  async getApiKeyOverview(apiKeyIdInput) {
    const apiKeyId = requiredUuid(apiKeyIdInput, 'apiKeyId')
    const apiKey = (await this.store.listApiKeys()).find((candidate) => candidate.id === apiKeyId)
    assert(apiKey, 404, 'api_key_not_found', 'API key not found')
    const [platformEntitlements, capabilityEntitlements, plan, usage] = await Promise.all([
      typeof this.store.listApiKeyPlatformEntitlements === 'function'
        ? this.store.listApiKeyPlatformEntitlements(apiKeyId)
        : [],
      typeof this.store.listApiKeyCapabilityEntitlements === 'function'
        ? this.store.listApiKeyCapabilityEntitlements(apiKeyId)
        : [],
      typeof this.store.getConsumerPlan === 'function'
        ? this.store.getConsumerPlan(apiKey.consumerId)
        : null,
      this.store.usage({ apiKeyId }),
    ])
    // What this key would hit on its next call, counted exactly as admission
    // counts it. Cumulative usage alone cannot answer "can I call right now".
    const quota = typeof this.store.quotaSnapshot === 'function'
      ? await this.store.quotaSnapshot({
          tenantId: apiKey.tenantId,
          consumerId: apiKey.consumerId,
          apiKeyId,
        })
      : []
    // Which of this key's granted operations can actually dispatch right now.
    // A key can be perfectly scoped and still fail because the provider
    // operation behind it is blocked, and that is invisible from the key alone.
    const operations = {}
    for (const source of [this.externalPlatformCapabilities, this.externalPostCapabilities]) {
      if (typeof source !== 'function') continue
      try {
        const capability = await source({ consumerId: apiKey.consumerId })
        for (const [operationKey, state] of Object.entries(capability?.operations || {})) {
          operations[operationKey] = state
        }
      } catch {
        // Provider readiness is diagnostic here. A provider that cannot answer
        // must not stop the rest of the key overview from rendering.
      }
    }
    const grantedCapabilities = new Set(capabilityEntitlements.map((entry) => entry.capability))
    const blockedOperations = Object.entries(operations)
      .filter(([operationKey, state]) => grantedCapabilities.has(operationKey) && state?.ready === false)
      .map(([operationKey, state]) => ({
        operation: operationKey,
        effectiveState: state.effectiveState || 'unknown',
      }))

    return {
      apiKey,
      platformEntitlements,
      capabilityEntitlements,
      plan,
      usage,
      quota,
      operations,
      blockedOperations,
    }
  }

  async #effectivePlatformGrants(context) {
    if (typeof this.store.listEffectiveGrants === 'function') {
      return this.store.listEffectiveGrants(context.consumer.id, context.apiKey.id)
    }
    return this.store.listGrants(context.consumer.id)
  }

  #externalSocialSearchEnabledFor(context) {
    if (!this.externalSocialSearchEnabled) return false
    if (this.externalSocialSearchCanaryConsumerIds.size === 0) return true
    return this.externalSocialSearchCanaryConsumerIds.has(
      String(context?.consumer?.id || '').toLowerCase(),
    )
  }

  async #effectiveCapabilityGrants(context) {
    if (typeof this.store.listEffectiveCapabilityGrants === 'function') {
      return this.store.listEffectiveCapabilityGrants(context.consumer.id, context.apiKey.id)
    }
    return typeof this.store.listCapabilityGrants === 'function'
      ? this.store.listCapabilityGrants(context.consumer.id)
      : []
  }

  async #effectivePlatformPolicy(context, platform) {
    const consumerPolicy = {
      ...this.defaultPolicy,
      ...((await this.store.getPolicy(context.consumer.id, platform)) || {}),
    }
    const entitlement = typeof this.store.getApiKeyPlatformEntitlement === 'function'
      ? await this.store.getApiKeyPlatformEntitlement(context.apiKey.id, platform)
      : null
    const plan = typeof this.store.getConsumerPlan === 'function'
      ? await this.store.getConsumerPlan(context.consumer.id)
      : null
    return {
      ...consumerPolicy,
      maxPageSize: entitlement
        ? Math.min(
            consumerPolicy.maxPageSize,
            entitlement.maxPageSize,
            plan?.limits?.maxPageSize || Number.POSITIVE_INFINITY,
          )
        : Math.min(consumerPolicy.maxPageSize, plan?.limits?.maxPageSize || Number.POSITIVE_INFINITY),
    }
  }

  async #effectiveCapabilityPolicy(context, capability) {
    return {
      ...this.defaultPolicy,
      ...((typeof this.store.getCapabilityPolicy === 'function'
        ? await this.store.getCapabilityPolicy(context.consumer.id, capability)
        : null) || {}),
    }
  }

  async getPlatformConfiguration({ tenantId, consumerId }) {
    const normalizedTenantId = optionalUuid(tenantId, 'tenantId')
    const normalizedConsumerId = optionalUuid(consumerId, 'consumerId')
    const allIngestedReady = await this.#publicOpinionRegionServingReady()
    const xiaohongshuAcquisition = this.externalPostCapabilities
      ? await this.externalPostCapabilities({ consumerId: normalizedConsumerId })
      : null
    const ecommerceSearch = this.externalPlatformCapabilities
      ? await this.externalPlatformCapabilities({ consumerId: normalizedConsumerId })
      : null
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
        {
          capability: XIAOHONGSHU_POST_OPERATION,
          ready: providerOperationReady(xiaohongshuAcquisition, XIAOHONGSHU_POST_OPERATION),
        },
        {
          capability: XIAOHONGSHU_SEARCH_OPERATION,
          ready: providerOperationReady(xiaohongshuAcquisition, XIAOHONGSHU_SEARCH_OPERATION),
        },
        {
          capability: XIAOHONGSHU_USER_INFO_OPERATION,
          ready: providerOperationReady(xiaohongshuAcquisition, XIAOHONGSHU_USER_INFO_OPERATION),
        },
        {
          capability: XIAOHONGSHU_CRAWL_OPERATION,
          ready: providerOperationReady(xiaohongshuAcquisition, XIAOHONGSHU_CRAWL_OPERATION),
        },
        {
          capability: XIAOHONGSHU_APP_V2_COMPAT_CAPABILITY,
          // The compatibility grant covers several App V2 endpoints, so its
          // generic readiness stays conservative unless every operation is ready.
          ready: Boolean(xiaohongshuAcquisition?.ready),
        },
        {
          capability: JUSTONE_OPERATION,
          ready: providerOperationReady(ecommerceSearch, JUSTONE_OPERATION),
        },
        // Each platform-shaped resource family is separately gated and priced,
        // so it reports its own readiness instead of inheriting the search row.
        ...JUSTONE_RESOURCE_OPERATION_KEYS.map((operationKey) => ({
          capability: operationKey,
          ready: providerOperationReady(ecommerceSearch, operationKey),
        })),
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
    const grants = await this.#effectivePlatformGrants(context)
    const canonicalGrants = [...new Set(grants.map((grant) => canonicalPlatform(grant)))]
    // Historical compatibility support is a Hub-pinned routing contract, not
    // a live provider-health result. Compile it locally so capability discovery
    // never depends on Night-All. Conservative top-level readiness stays false
    // until a Hub-native capability below can publish its own nested readiness.
    const legacySearch = buildNightAllLegacySearchCapabilities(canonicalGrants)
    const legacyPlatforms = new Set(Object.values(legacySearch.operations)
      .flatMap(({ supportedPlatforms }) => supportedPlatforms))
    const payload = {
      data: {
        platforms: canonicalGrants
          .filter((platform) => legacyPlatforms.has(platform))
          .map((platform) => ({ platform, ready: false })),
        legacySearch: legacyPlatforms.size > 0 ? legacySearch : null,
      },
    }
    if (canonicalGrants.includes('telegram') && typeof this.store.listCanonicalRecords === 'function') {
      const platforms = payload?.data?.platforms
      if (Array.isArray(platforms) && !platforms.some((entry) => (entry?.platform || entry) === 'telegram')) {
        let contextCapability = null
        let timelineCapability = null
        if (
          typeof this.store.getCanonicalContext === 'function'
          && typeof this.store.getCanonicalContextServingIndexStatus === 'function'
        ) {
          try {
            const servingIndexes = await this.store.getCanonicalContextServingIndexStatus()
            contextCapability = canonicalContextCapability(servingIndexes)
            if (typeof this.store.getCanonicalTimelinePage === 'function') {
              timelineCapability = canonicalTimelineCapability(servingIndexes)
            }
          } catch {
            // Capability discovery must not take existing Telegram reads down
            // because the optional context index diagnostic is unavailable.
            contextCapability = canonicalContextCapability(null)
            if (typeof this.store.getCanonicalTimelinePage === 'function') {
              timelineCapability = canonicalTimelineCapability(null)
            }
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
            ...(contextCapability ? ['message_context'] : []),
            ...(timelineCapability ? ['message_timeline'] : []),
          ],
          ...(contextCapability ? { context: contextCapability } : {}),
          ...(timelineCapability ? { timeline: timelineCapability } : {}),
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
    const crawlerGrants = CRAWLER_SOURCES.filter((source) => canonicalGrants.includes(source.platform))
    if (crawlerGrants.length > 0) {
      const platforms = payload?.data?.platforms
      if (Array.isArray(platforms)) {
        const sources = await Promise.all(crawlerGrants.map((source) => (
          typeof this.store.getExternalSource === 'function'
            ? this.store.getExternalSource(source.sourceKey)
            : null
        )))
        for (const [index, spec] of crawlerGrants.entries()) {
          if (platforms.some((entry) => (entry?.platform || entry) === spec.platform)) continue
          platforms.push({
            platform: spec.platform,
            ready: sources[index]?.status === 'active' && Boolean(this.searchQueries?.searchContent),
            source: 'hub',
            servingMode: 'stored',
            capabilities: [
              'stored_search',
              'canonical_search',
              ...(this.topicReports ? ['topic_report'] : []),
            ],
          })
        }
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
    if (
      canonicalGrants.includes(VIRTUAL_SUPERMARKET_PLATFORM)
      && typeof this.store.listVirtualSupermarketProducts === 'function'
    ) {
      const platforms = payload?.data?.platforms
      if (Array.isArray(platforms) && !platforms.some((entry) => (
        (entry?.platform || entry) === VIRTUAL_SUPERMARKET_PLATFORM
      ))) {
        let ready = typeof this.store.getVirtualSupermarketStorefrontRevision === 'function'
          && typeof this.store.getVirtualSupermarketInventoryRevision === 'function'
        if (ready) {
          try {
            await Promise.all([
              this.store.getVirtualSupermarketStorefrontRevision(),
              this.store.listVirtualSupermarketCategories(),
            ])
          } catch {
            ready = false
            this.logger?.warn?.('[virtual-supermarket] serving migration readiness probe failed')
          }
        }
        platforms.push({
          platform: VIRTUAL_SUPERMARKET_PLATFORM,
          ready,
          source: 'hub',
          servingMode: 'stored',
          capabilities: [
            'metadata',
            'products',
            'product_detail',
            'stored_search',
            'category_filter',
            'department_filter',
            'aisle_filter',
            'shelf_filter',
            'marketplace_filter',
          ],
        })
      }
    }
    let externalEcommerceCapability = null
    if (canonicalGrants.includes(ECOMMERCE_PLATFORM) && this.externalPlatformCapabilities) {
      const platforms = payload?.data?.platforms
      if (Array.isArray(platforms)) {
        externalEcommerceCapability = await this.externalPlatformCapabilities({
          consumerId: context.consumer.id,
        })
        const ecommerceIndex = platforms.findIndex((entry) => (
          (entry?.platform || entry) === ECOMMERCE_PLATFORM
        ))
        if (ecommerceIndex < 0) {
          platforms.push(isTestApiKey(context.apiKey)
            ? { ...externalEcommerceCapability, ready: false }
            : externalEcommerceCapability)
        } else if (isTestApiKey(context.apiKey)) {
          const ecommerce = platforms[ecommerceIndex]
          platforms[ecommerceIndex] = typeof ecommerce === 'object'
            ? { ...ecommerce, ready: false }
            : { platform: ECOMMERCE_PLATFORM, ready: false }
        }
      }
    }
    const capabilityGrants = await this.#effectiveCapabilityGrants(context)
    let externalPostCapability = null
    const hasPostDetailGrant = capabilityGrants.includes(XIAOHONGSHU_POST_OPERATION)
    const hasXiaohongshuAcquisitionGrant = capabilityGrants.some((capability) => (
      XIAOHONGSHU_ACQUISITION_CAPABILITIES.has(capability)
    ))
    const externalSocialSearchEnabled = this.#externalSocialSearchEnabledFor(context)
    if (
      canonicalGrants.includes('xiaohongshu')
      && this.externalPostCapabilities
      && (externalSocialSearchEnabled || hasXiaohongshuAcquisitionGrant)
    ) {
      const platforms = payload?.data?.platforms
      if (Array.isArray(platforms)) {
        let capability = null
        try {
          capability = await this.externalPostCapabilities({ consumerId: context.consumer.id })
        } catch {
          this.logger?.warn?.('[external-platform] TikHub capability discovery is unavailable')
        }
        externalPostCapability = capability
        const index = platforms.findIndex((entry) => (entry?.platform || entry) === 'xiaohongshu')
        const postDetailReady = !isTestApiKey(context.apiKey)
          && providerOperationReady(capability, XIAOHONGSHU_POST_OPERATION)
        const searchReady = !isTestApiKey(context.apiKey)
          && providerOperationReady(capability, XIAOHONGSHU_SEARCH_OPERATION)
        const directCapabilities = [
          ...(externalSocialSearchEnabled ? [XIAOHONGSHU_SEARCH_CAPABILITY] : []),
          ...(hasPostDetailGrant ? ['post_detail'] : []),
        ]
        const postDetail = hasPostDetailGrant ? {
          ready: postDetailReady,
          source: 'hub',
          servingMode: capability?.servingMode || 'live_with_stored_fallback',
          contractVersion: capability?.contractVersion,
          input: capability?.input,
          deliveryModes: capability?.deliveryModes,
        } : null
        const search = externalSocialSearchEnabled ? {
          ready: searchReady,
          source: 'hub',
          servingMode: capability?.servingMode || 'live_with_stored_fallback',
          contractVersion: 'night-all.data-search.v1',
        } : null
        if (index < 0) {
          platforms.push({
            platform: 'xiaohongshu',
            ready: Boolean(capability?.ready) && !isTestApiKey(context.apiKey),
            source: 'hub',
            servingMode: capability?.servingMode || 'live_with_stored_fallback',
            capabilities: directCapabilities,
            ...(search ? { search } : {}),
            ...(postDetail ? { postDetail } : {}),
          })
        } else if (typeof platforms[index] === 'object') {
          const current = platforms[index]
          platforms[index] = {
            ...current,
            // This top-level row may still describe Night-All-only legacy
            // operations. Preserve its provider/readiness identity and publish
            // direct readiness only on the nested search/postDetail fields.
            ...(
              Array.isArray(current.capabilities) || directCapabilities.length > 0
                ? { capabilities: [...new Set([...(current.capabilities || []), ...directCapabilities])] }
                : {}
            ),
            ...(search ? { search } : {}),
            ...(postDetail ? { postDetail } : {}),
          }
        }
      }
    }
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
                  : XIAOHONGSHU_ACQUISITION_CAPABILITIES.has(capability)
                    ? !isTestApiKey(context.apiKey) && (
                        capability === XIAOHONGSHU_APP_V2_COMPAT_CAPABILITY
                          ? Boolean(externalPostCapability?.ready)
                          : providerOperationReady(externalPostCapability, capability)
                      )
                    : capability === JUSTONE_OPERATION
                      ? !isTestApiKey(context.apiKey)
                        && providerOperationReady(externalEcommerceCapability, JUSTONE_OPERATION)
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

    const grants = await this.#effectiveCapabilityGrants(context)
    assert(grants.includes(TOKENIZE_CAPABILITY), 403, 'capability_not_granted', 'Capability is not granted')
    const policy = await this.#effectiveCapabilityPolicy(context, TOKENIZE_CAPABILITY)

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
      requestId: activeRequestId,
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

  async adminCreateTopicReport(body, { actor = 'admin-token' } = {}) {
    if (!this.topicReports) {
      throw new AppError(503, 'topic_reports_unavailable', 'Topic reports require PostgreSQL migration 067')
    }
    const input = normalizeTopicReportRequest(body, { allowedPlatforms: TOPIC_REPORT_PLATFORMS })
    return this.topicReports.create(input, { createdBy: actor })
  }

  async adminTopicReports(queryInput = {}) {
    if (!this.topicReports) {
      throw new AppError(503, 'topic_reports_unavailable', 'Topic reports require PostgreSQL migration 067')
    }
    const unsupported = Object.keys(queryInput || {}).filter((field) => field !== 'limit')
    if (unsupported.length > 0) {
      throw new AppError(400, 'unsupported_fields', `Unsupported topic report query fields: ${unsupported.join(', ')}`)
    }
    const limit = queryInput?.limit == null ? 30 : Number(queryInput.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new AppError(400, 'invalid_request', 'limit must be an integer from 1 to 100')
    }
    return {
      contractVersion: 'mx-insight-hub.data-products.topic-report.v1',
      items: await this.topicReports.list({ limit }),
    }
  }

  async adminTopicReport(id) {
    if (!this.topicReports) {
      throw new AppError(503, 'topic_reports_unavailable', 'Topic reports require PostgreSQL migration 067')
    }
    const report = await this.topicReports.get(id, { includeOwner: true })
    assert(report, 404, 'topic_report_not_found', 'Topic report not found')
    return report
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

  async adminEcommerceItems(input) {
    const query = storedEcommerceQuery({ pageSize: '100', ...input }, 'admin-ecommerce', this.apiKeyPepper)
    return query.page(await this.store.listAdminEcommerceItems(query))
  }

  async adminSaveEcommerceItem(body, deleting = false) {
    const allowed = new Set(['requestId', 'ordinal', 'revision', 'title', 'price', 'marketplace'])
    assert(body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every(key => allowed.has(key)), 400, 'invalid_product', 'Invalid product fields')
    const manual = !body.requestId
    assert(!deleting || !manual, 400, 'invalid_product', 'Select a saved product to delete')
    const requestId = manual ? randomUUID() : requiredUuid(body.requestId, 'requestId')
    const ordinal = manual ? 1 : Number(body.ordinal)
    const revision = manual ? 0 : Number(body.revision)
    assert(Number.isInteger(ordinal) && ordinal > 0 && Number.isInteger(revision) && revision >= 0, 400, 'invalid_product', 'Invalid product revision')
    const existing = manual ? null : await this.store.getAdminEcommerceItem(requestId, ordinal)
    assert(manual || (existing && !existing.deleted), 404, 'product_not_found', 'Product is not available')
    assert(manual || existing.revision === revision, 409, 'product_revision_conflict', 'Product changed; reload before editing')
    let product = existing?.product
    if (!deleting) {
      assert(typeof body.title === 'string' && body.title.trim().length > 0 && body.title.length <= 1000, 400, 'invalid_product', 'Title must be 1–1000 characters')
      assert(typeof body.price === 'string' && /^\d{1,12}(?:\.\d{1,2})?$/.test(body.price), 400, 'invalid_product', 'Price must be a decimal amount')
      assert(!manual || ['taobao','tmall','jd','xianyu','xiaohongshu_ec'].includes(body.marketplace), 400, 'invalid_product', 'Choose one marketplace')
      product = { ...(product || { id: requestId, marketplace: body.marketplace, images: [] }), title: body.title.trim(), pricing: { ...product?.pricing, current: body.price, currency: 'CNY' } }
    }
    const saved = await this.store.saveAdminEcommerceItem({ requestId, ordinal, product, manual, deleted: deleting, revision })
    assert(saved, 409, 'product_revision_conflict', 'Product changed; reload before editing')
    return { requestId, ordinal, ...saved }
  }

  async adminEcommerceImage(input, signal) {
    const requestId = requiredUuid(input.requestId, 'requestId')
    const ordinal = Number(input.ordinal)
    assert(Number.isInteger(ordinal) && ordinal > 0, 400, 'invalid_product', 'Invalid ordinal')
    const item = await this.store.getAdminEcommerceItem(requestId, ordinal)
    assert(item && !item.deleted && item.product.images?.[0], 404, 'external_media_not_found', 'Product image is unavailable')
    assert(this.externalImageLoader, 503, 'external_media_unavailable', 'Image relay is unavailable')
    const release = this.#enterExternalMedia('admin-ecommerce')
    try { return await this.externalImageLoader(item.product.images[0], { signal, cacheScope: 'admin-ecommerce' }) }
    finally { release() }
  }

  async ecommerceStoredItems(context, input) {
    assert(!isTestApiKey(context.apiKey), 403, 'test_key_not_supported', 'Stored ecommerce requires a live key')
    const policy = await this.#storedPlatformPolicy(context, 'ecommerce', 'Ecommerce')
    const query = storedEcommerceQuery(input, context.consumer.id, this.apiKeyPepper, policy.maxPageSize)
    return this.#meterStoredRead(context, 'ecommerce', policy, {
      path: '/api/v1/data/ecommerce/products/items',
      fingerprintBody: input,
      operation: async () => query.page(await this.store.listStoredEcommerceItems(query)),
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

  #assertVirtualSupermarketStore() {
    if (
      typeof this.store.getVirtualSupermarketStorefrontRevision !== 'function'
      || typeof this.store.listVirtualSupermarketCategories !== 'function'
      || typeof this.store.listVirtualSupermarketProducts !== 'function'
      || typeof this.store.getVirtualSupermarketProduct !== 'function'
      || typeof this.store.getVirtualSupermarketProductByPublicationId !== 'function'
    ) {
      throw new AppError(503, 'stored_data_unavailable', 'Virtual-supermarket data requires the current Hub store migration')
    }
  }

  async #virtualSupermarketSnapshot(operation, expectedRevision = null, expectedInventoryRevision = null) {
    this.#assertVirtualSupermarketStore()
    const before = await this.store.getVirtualSupermarketStorefrontRevision()
    if (expectedRevision != null && before !== expectedRevision) {
      throw new AppError(
        409,
        'storefront_revision_changed',
        'Virtual-supermarket publication changed; restart pagination from the first page',
        { cursorRevision: expectedRevision, storefrontRevision: before },
      )
    }
    let inventoryBefore = null
    if (expectedInventoryRevision != null) {
      if (typeof this.store.getVirtualSupermarketInventoryRevision !== 'function') {
        throw new AppError(503, 'inventory_revision_unavailable', 'Virtual-supermarket inventory revision is unavailable')
      }
      inventoryBefore = await this.store.getVirtualSupermarketInventoryRevision()
      if (inventoryBefore !== expectedInventoryRevision) {
        throw new AppError(
          409,
          'virtual_supermarket_inventory_changed',
          'Virtual-supermarket inventory changed; restart pagination from the first page',
          { cursorInventoryRevision: expectedInventoryRevision, inventoryRevision: inventoryBefore },
        )
      }
    }
    const value = await operation(before)
    const after = await this.store.getVirtualSupermarketStorefrontRevision()
    if (after !== before) {
      throw new AppError(
        409,
        'storefront_revision_changed',
        'Virtual-supermarket publication changed while the response was being assembled; retry the request',
        { storefrontRevision: after },
      )
    }
    if (expectedInventoryRevision != null) {
      const inventoryAfter = await this.store.getVirtualSupermarketInventoryRevision()
      if (inventoryAfter !== inventoryBefore) {
        throw new AppError(
          409,
          'virtual_supermarket_inventory_changed',
          'Virtual-supermarket inventory changed while the response was being assembled; retry the request',
          { inventoryRevision: inventoryAfter },
        )
      }
    }
    return { storefrontRevision: before, value }
  }

  async virtualSupermarketMetadata(context) {
    const policy = await this.#storedPlatformPolicy(context, VIRTUAL_SUPERMARKET_PLATFORM, 'Virtual supermarket')
    return this.#meterStoredRead(context, VIRTUAL_SUPERMARKET_PLATFORM, policy, {
      path: '/api/v1/data/virtual-supermarket/metadata',
      fingerprintBody: {},
      operation: async () => (await this.#virtualSupermarketSnapshot(async (storefrontRevision) => (
        virtualSupermarketMetadata(
          await this.store.listVirtualSupermarketCategories(),
          { storefrontRevision },
        )
      ))).value,
    })
  }

  async #virtualSupermarketPage(context, queryInput, { path, requireQuery = false } = {}) {
    const policy = await this.#storedPlatformPolicy(context, VIRTUAL_SUPERMARKET_PLATFORM, 'Virtual supermarket')
    this.#assertVirtualSupermarketStore()
    const storefrontRevision = await this.store.getVirtualSupermarketStorefrontRevision()
    const query = normalizeVirtualSupermarketQuery(queryInput, {
      cursorSecret: this.apiKeyPepper,
      maxPageSize: policy.maxPageSize,
      requireQuery,
      storefrontRevision,
    })
    return this.#meterStoredRead(context, VIRTUAL_SUPERMARKET_PLATFORM, policy, {
      path,
      fingerprintBody: {
        ...query.filters,
        sort: query.sort,
        pageSize: query.pageSize,
        cursor: query.cursorToken,
      },
      operation: async () => (await this.#virtualSupermarketSnapshot(async () => (
        virtualSupermarketPage(
          await this.store.listVirtualSupermarketProducts({
            ...query.filters,
            sort: query.sort,
            pageSize: query.pageSize,
            offset: query.offset,
            includeGovernanceEvidence: false,
          }),
          query,
          this.apiKeyPepper,
        )
      ), query.storefrontRevision)).value,
    })
  }

  async virtualSupermarketProducts(context, queryInput) {
    return this.#virtualSupermarketPage(context, queryInput, {
      path: '/api/v1/data/virtual-supermarket/products',
    })
  }

  async virtualSupermarketSearch(context, queryInput) {
    return this.#virtualSupermarketPage(context, queryInput, {
      path: '/api/v1/data/virtual-supermarket/search',
      requireQuery: true,
    })
  }

  async virtualSupermarketProduct(context, idInput) {
    const policy = await this.#storedPlatformPolicy(context, VIRTUAL_SUPERMARKET_PLATFORM, 'Virtual supermarket')
    const id = requiredUuid(idInput, 'publicationId')
    return this.#meterStoredRead(context, VIRTUAL_SUPERMARKET_PLATFORM, policy, {
      path: `/api/v1/data/virtual-supermarket/products/${id}`,
      fingerprintBody: { id },
      operation: async () => (await this.#virtualSupermarketSnapshot(async (storefrontRevision) => {
        const item = await this.store.getVirtualSupermarketProductByPublicationId(id)
        if (!item) {
          throw new AppError(404, 'virtual_supermarket_product_not_found', 'Virtual-supermarket product was not found')
        }
        return virtualSupermarketDetail(item, { storefrontRevision })
      })).value,
    })
  }

  async adminVirtualSupermarketMetadata() {
    return (await this.#virtualSupermarketSnapshot(async (storefrontRevision) => (
      virtualSupermarketMetadata(
        await this.store.listVirtualSupermarketCategories({ includeArchived: true }),
        { admin: true, storefrontRevision },
      )
    ))).value
  }

  async adminVirtualSupermarketCategories() {
    const metadata = await this.adminVirtualSupermarketMetadata()
    return {
      contractVersion: VIRTUAL_SUPERMARKET_ADMIN_CONTRACT,
      storefrontRevision: metadata.storefrontRevision,
      items: metadata.categories,
    }
  }

  async adminCreateVirtualSupermarketCategory(input, { actor = 'admin-token' } = {}) {
    this.#assertVirtualSupermarketStore()
    const result = await this.store.createVirtualSupermarketCategory(
      normalizeVirtualSupermarketCategoryCreate(input),
      { actor },
    )
    return {
      contractVersion: VIRTUAL_SUPERMARKET_ADMIN_CONTRACT,
      storefrontRevision: result.storefrontRevision,
      item: virtualSupermarketCategoryResponse(result.item, { admin: true }),
    }
  }

  async adminUpdateVirtualSupermarketCategory(idInput, input, { actor = 'admin-token' } = {}) {
    this.#assertVirtualSupermarketStore()
    const id = requiredUuid(idInput, 'categoryId')
    const { expectedRevision, patch } = normalizeVirtualSupermarketCategoryPatch(input)
    const result = await this.store.updateVirtualSupermarketCategory(id, patch, { expectedRevision, actor })
    return {
      contractVersion: VIRTUAL_SUPERMARKET_ADMIN_CONTRACT,
      storefrontRevision: result.storefrontRevision,
      item: virtualSupermarketCategoryResponse(result.item, { admin: true }),
    }
  }

  async adminVirtualSupermarketProducts(queryInput) {
    this.#assertVirtualSupermarketStore()
    if (typeof this.store.getVirtualSupermarketInventoryRevision !== 'function') {
      throw new AppError(503, 'inventory_revision_unavailable', 'Virtual-supermarket inventory revision is unavailable')
    }
    const [storefrontRevision, inventoryRevision] = await Promise.all([
      this.store.getVirtualSupermarketStorefrontRevision(),
      this.store.getVirtualSupermarketInventoryRevision(),
    ])
    const query = normalizeVirtualSupermarketQuery(queryInput, {
      admin: true,
      cursorSecret: this.apiKeyPepper,
      storefrontRevision,
      inventoryRevision,
    })
    return (await this.#virtualSupermarketSnapshot(async () => (
      virtualSupermarketPage(
        await this.store.listVirtualSupermarketProducts({
          ...query.filters,
          sort: query.sort,
          pageSize: query.pageSize,
          offset: query.offset,
          includeGovernanceEvidence: true,
        }),
        query,
        this.apiKeyPepper,
        { admin: true },
      )
    ), query.storefrontRevision, query.inventoryRevision)).value
  }

  async adminVirtualSupermarketProduct(idInput) {
    const id = requiredUuid(idInput, 'productId')
    return (await this.#virtualSupermarketSnapshot(async (storefrontRevision) => {
      const item = await this.store.getVirtualSupermarketProduct(id)
      if (!item) {
        throw new AppError(404, 'virtual_supermarket_product_not_found', 'Virtual-supermarket product was not found')
      }
      return virtualSupermarketDetail(item, { admin: true, storefrontRevision })
    })).value
  }

  async adminUpdateVirtualSupermarketProduct(idInput, input, { actor = 'admin-token' } = {}) {
    this.#assertVirtualSupermarketStore()
    const id = requiredUuid(idInput, 'productId')
    const { expectedRevision, patch, reason } = normalizeVirtualSupermarketProductPatch(input)
    const result = await this.store.updateVirtualSupermarketProduct(id, patch, {
      expectedRevision,
      actor,
      eventType: 'update',
      reason,
    })
    return virtualSupermarketDetail(result.item, {
      admin: true,
      storefrontRevision: result.storefrontRevision,
    })
  }

  async adminPublishVirtualSupermarketProduct(idInput, input, {
    actor = 'admin-token',
    publish = true,
  } = {}) {
    this.#assertVirtualSupermarketStore()
    const id = requiredUuid(idInput, 'productId')
    const { expectedRevision, reason } = normalizeVirtualSupermarketPublication(input)
    const result = await this.store.updateVirtualSupermarketProduct(
      id,
      { status: publish ? 'on_shelf' : 'off_shelf' },
      {
        expectedRevision,
        actor,
        eventType: publish ? 'publish' : 'unpublish',
        reason,
      },
    )
    return virtualSupermarketDetail(result.item, {
      admin: true,
      storefrontRevision: result.storefrontRevision,
    })
  }

  async adminVirtualSupermarketProductEvents(idInput) {
    this.#assertVirtualSupermarketStore()
    const id = requiredUuid(idInput, 'productId')
    return (await this.#virtualSupermarketSnapshot(async (storefrontRevision) => {
      const item = await this.store.getVirtualSupermarketProduct(id)
      if (!item) {
        throw new AppError(404, 'virtual_supermarket_product_not_found', 'Virtual-supermarket product was not found')
      }
      return {
        contractVersion: VIRTUAL_SUPERMARKET_ADMIN_CONTRACT,
        storefrontRevision,
        items: await this.store.listVirtualSupermarketProductEvents(id),
      }
    })).value
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
    const grants = await this.#effectiveCapabilityGrants(context)
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

  async canonicalTimeline(context, idInput, queryInput) {
    if (
      typeof this.store.getCanonicalContext !== 'function'
      || typeof this.store.getCanonicalTimelinePage !== 'function'
      || typeof this.store.getCanonicalContextServingIndexStatus !== 'function'
    ) {
      throw new AppError(503, 'stored_data_unavailable', 'Canonical timeline requires the current Hub store')
    }
    const id = requiredUuid(idInput, 'id').toLowerCase()
    const policy = await this.#storedPlatformPolicy(context, 'telegram', 'Telegram')
    const scopeFingerprint = canonicalTimelineScopeFingerprint({
      tenantId: context.tenant.id,
      consumerId: context.consumer.id,
    })
    const query = normalizeCanonicalTimelineQuery(queryInput, {
      anchorId: id,
      maxPageSize: policy.maxPageSize,
      scopeFingerprint,
      cursorSecret: this.apiKeyPepper,
    })
    let servingIndexes
    try {
      servingIndexes = await this.store.getCanonicalContextServingIndexStatus()
    } catch {
      throw new AppError(
        503,
        'serving_indexes_unavailable',
        'Canonical timeline serving index status is unavailable',
      )
    }
    if (!servingIndexes.ready) {
      throw new AppError(
        503,
        'serving_indexes_unavailable',
        'Canonical timeline serving indexes are not ready',
      )
    }
    return this.#meterStoredRead(context, 'telegram', policy, {
      path: `/api/v1/data/canonical/items/${id}/timeline`,
      fingerprintBody: query.mode === 'initial'
        ? { id, before: query.before, after: query.after }
        : { id, cursor: query.cursorToken },
      operation: async () => {
        if (query.mode === 'continuation') {
          const result = await this.store.getCanonicalTimelinePage({
            datasetId: query.cursor.datasetId,
            contextId: query.cursor.streamId,
            direction: query.cursor.direction,
            boundary: query.cursor.boundary,
            pageSize: query.cursor.pageSize,
          })
          return canonicalTimelineContinuationResponse({
            query,
            result,
            cursorSecret: this.apiKeyPepper,
          })
        }
        const result = await this.store.getCanonicalContext({
          id,
          before: query.before,
          after: query.after,
        })
        if (!result) throw new AppError(404, 'item_not_found', 'Canonical item not found')
        if (!result.contextSupported) {
          throw new AppError(409, 'context_not_supported', 'Canonical item does not support message timeline')
        }
        return canonicalTimelineInitialResponse({
          anchorId: id,
          query,
          result,
          scopeFingerprint,
          cursorSecret: this.apiKeyPepper,
        })
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
    const grants = await this.#effectivePlatformGrants(context)
    assert(grants.includes(platform), 403, 'platform_not_granted', 'Platform is not granted')
    if (!this.searchQueries?.searchContent) {
      throw new AppError(503, 'stored_search_unavailable', 'Stored search requires the PostgreSQL search layer')
    }
    const policy = await this.#effectivePlatformPolicy(context, platform)
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
      ...(query.crawlerPublicationVisibility ? {
        crawlerPublicationVisibility: query.crawlerPublicationVisibility,
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
        ...(query.crawlerPublicationVisibility
          ? { crawlerPublicationVisibility: query.crawlerPublicationVisibility }
          : {}),
      })
      const responseBody = {
        ...storedSearchResponse({
          query,
          result,
          durationMs: Math.round(performance.now() - startedAt),
          cursorSecret: this.apiKeyPepper,
        }),
        requestId: activeRequestId,
      }
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
    const grants = [...new Set(await this.#effectivePlatformGrants(context))].sort()
    assert(grants.length > 0, 403, 'platform_not_granted', 'At least one platform grant is required')
    const platform = body.platform == null ? null : canonicalPlatform(body.platform)
    if (platform) {
      assert(!RESERVED_PLATFORM_NAMES.has(platform), 400, 'invalid_platform', 'A single explicit platform is required')
      assert(grants.includes(platform), 403, 'platform_not_granted', 'Platform is not granted')
    }
    if (!this.searchQueries?.searchContent) {
      throw new AppError(503, 'canonical_search_unavailable', 'Canonical search requires the PostgreSQL search layer')
    }
    const policies = await Promise.all(grants.map((name) => this.#effectivePlatformPolicy(context, name)))
    const keyEntitlements = typeof this.store.getApiKeyPlatformEntitlement === 'function'
      ? await Promise.all(grants.map((name) => this.store.getApiKeyPlatformEntitlement(context.apiKey.id, name)))
      : policies
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
    const apiKeyQuota = {
      maxRequests: Math.min(...keyEntitlements.map((entry) => entry?.maxRequests ?? this.defaultPolicy.maxRequests)),
      windowSeconds: Math.max(...keyEntitlements.map((entry) => entry?.windowSeconds ?? this.defaultPolicy.windowSeconds)),
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
      ...(query.crawlerPublicationVisibility ? {
        crawlerPublicationVisibility: query.crawlerPublicationVisibility,
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
      apiKeyQuota,
      authorizationPlatforms: grants,
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
        ...(query.crawlerPublicationVisibility
          ? { crawlerPublicationVisibility: query.crawlerPublicationVisibility }
          : {}),
      })
      const responseBody = {
        ...canonicalSearchResponse({
          query,
          result,
          durationMs: Math.round(performance.now() - startedAt),
          cursorSecret: this.apiKeyPepper,
        }),
        requestId: activeRequestId,
      }
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

  async createTopicReport(context, { body, idempotencyKey, path }) {
    if (!this.topicReports) {
      throw new AppError(503, 'topic_reports_unavailable', 'Topic reports require the PostgreSQL report store')
    }
    const key = requiredIdempotencyKey(idempotencyKey)
    const grants = [...new Set(await this.#effectivePlatformGrants(context))]
    const allowedPlatforms = grants.filter((platform) => TOPIC_REPORT_PLATFORMS.includes(platform))
    const input = normalizeTopicReportRequest(body, { allowedPlatforms })
    const policies = await Promise.all(input.platforms.map((platform) => (
      this.#effectivePlatformPolicy(context, platform)
    )))
    const keyEntitlements = typeof this.store.getApiKeyPlatformEntitlement === 'function'
      ? await Promise.all(input.platforms.map((platform) => (
          this.store.getApiKeyPlatformEntitlement(context.apiKey.id, platform)
        )))
      : policies
    const policy = {
      maxRequests: Math.min(...policies.map((entry) => entry.maxRequests)),
      windowSeconds: Math.max(...policies.map((entry) => entry.windowSeconds)),
    }
    const apiKeyQuota = {
      maxRequests: Math.min(...keyEntitlements.map((entry) => entry?.maxRequests ?? this.defaultPolicy.maxRequests)),
      windowSeconds: Math.max(...keyEntitlements.map((entry) => entry?.windowSeconds ?? this.defaultPolicy.windowSeconds)),
    }
    const requestId = randomUUID()
    const windowStart = new Date(Date.now() - policy.windowSeconds * 1_000)
    await this.store.reapStaleReservations()
    const reservation = await this.store.reserve({
      requestId,
      idempotencyKey: key,
      fingerprint: requestFingerprint({
        method: 'POST',
        path,
        body: {
          topic: input.topic,
          language: input.language,
          range: input.range,
          ...(input.range === 'custom' ? {
            rangeStart: input.rangeStart,
            rangeEnd: input.rangeEnd,
          } : {}),
          sourceScope: input.sourceScope,
          platforms: input.platforms,
          sampleLimit: input.sampleLimit,
        },
      }),
      tenantId: context.tenant.id,
      consumerId: context.consumer.id,
      apiKeyId: context.apiKey.id,
      capability: TOPIC_REPORT_USAGE_SCOPE,
      unitsReserved: 1,
      leaseExpiresAt: new Date(Date.now() + this.reservationLeaseMs),
      windowStart,
      maxRequests: policy.maxRequests,
      apiKeyQuota,
      authorizationPlatforms: input.platforms,
      replayWindowMs: null,
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
    let report
    try {
      report = await this.topicReports.create(input, {
        id: activeRequestId,
        owner: {
          tenantId: context.tenant.id,
          consumerId: context.consumer.id,
          apiKeyId: context.apiKey.id,
        },
        createdBy: `consumer:${context.consumer.id}`,
      })
    } catch (error) {
      await this.store.releaseRequest(activeRequestId, 'topic_report_create_failed').catch(() => {})
      throw error
    }
    const responseBody = { data: report }
    try {
      await this.store.commitRequest(activeRequestId, {
        responseStatus: 202,
        responseBody,
        unitsActual: 1,
        upstreamLatencyMs: 0,
      })
    } catch (error) {
      await this.store.markRequestUnknown(activeRequestId, 'usage_commit_ambiguous').catch(() => {})
      throw error
    }
    return { status: 202, body: responseBody, requestId: activeRequestId, replay: false }
  }

  async topicReport(context, id) {
    if (!this.topicReports) {
      throw new AppError(503, 'topic_reports_unavailable', 'Topic reports require the PostgreSQL report store')
    }
    const report = await this.topicReports.get(id, { consumerId: context.consumer.id })
    assert(report, 404, 'topic_report_not_found', 'Topic report not found')
    return report
  }

  async #storedPlatformPolicy(context, platform, label) {
    const grants = await this.#effectivePlatformGrants(context)
    assert(grants.includes(platform), 403, 'platform_not_granted', `${label} is not granted`)
    return this.#effectivePlatformPolicy(context, platform)
  }

  async #publicOpinionDiagnosticsPolicy(context) {
    const platformPolicy = await this.#storedPlatformPolicy(
      context,
      PUBLIC_OPINION_PLATFORM,
      'Public opinion',
    )
    const grants = await this.#effectiveCapabilityGrants(context)
    assert(
      grants.includes(PUBLIC_OPINION_DIAGNOSTICS_CAPABILITY),
      403,
      'capability_not_granted',
      'Public-opinion diagnostics are not granted',
    )
    const capabilityPolicy = await this.#effectiveCapabilityPolicy(
      context,
      PUBLIC_OPINION_DIAGNOSTICS_CAPABILITY,
    )
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
    return publicRequestStatus(record)
  }

  async requestStatusByIdempotencyKey(context, idempotencyKey) {
    const key = requiredIdempotencyKey(idempotencyKey)
    await this.store.reapStaleReservations()
    const record = await this.store.getUsageRequestByIdempotencyKey(context.consumer.id, key)
    assert(record, 404, 'request_not_found', 'Request not found')
    return publicRequestStatus(record)
  }

  #enterExternalMedia(consumerId) {
    const now = Date.now()
    if (this.externalMediaWindows.size > 1_000) {
      for (const [id, candidate] of this.externalMediaWindows) {
        if (candidate.active === 0 && now - candidate.startedAt >= this.externalMediaPolicy.windowMs) {
          this.externalMediaWindows.delete(id)
        }
      }
    }
    let window = this.externalMediaWindows.get(consumerId)
    if (!window) {
      window = { startedAt: now, requests: 0, active: 0 }
      this.externalMediaWindows.set(consumerId, window)
    } else if (now - window.startedAt >= this.externalMediaPolicy.windowMs) {
      // A rate-window rollover must not erase still-running relays. Concurrency
      // is an instantaneous boundary, independent of the request-count window.
      window.startedAt = now
      window.requests = 0
    }
    assert(
      window.requests < this.externalMediaPolicy.maxRequests,
      429,
      'external_media_rate_limited',
      'Product image request limit exceeded',
    )
    // Busy attempts still consume the request window. Otherwise a consumer
    // holding one relay open could hammer grant/store checks without limit.
    window.requests += 1
    assert(
      window.active < this.externalMediaPolicy.maxConcurrency,
      429,
      'external_media_busy',
      'Product image relay is busy',
    )
    window.active += 1
    return () => {
      window.active = Math.max(0, window.active - 1)
    }
  }

  async ecommerceProductImage(context, {
    requestId,
    itemId,
    imageIndex,
    signal,
    deliveryComplete = null,
  }) {
    assert(
      !isTestApiKey(context.apiKey),
      403,
      'test_key_not_supported',
      'Test API keys cannot access external ecommerce media',
    )
    assert(
      this.externalImageLoader && typeof this.store.getCommittedEcommerceImageSource === 'function',
      503,
      'external_media_unavailable',
      'Product image relay is unavailable',
    )
    const grants = await this.#effectivePlatformGrants(context)
    assert(grants.includes('ecommerce'), 403, 'platform_not_granted', 'Platform is not granted')
    const release = this.#enterExternalMedia(context.consumer.id)
    let releaseDeferred = false
    try {
      const normalizedRequestId = requiredUuid(requestId, 'requestId')
      const normalizedItemId = requiredString(itemId, 'itemId')
      assert(
        normalizedItemId.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(normalizedItemId),
        400,
        'invalid_request',
        'itemId must be at most 512 characters and contain no control characters',
      )
      const normalizedImageIndex = Number(imageIndex)
      assert(
        Number.isInteger(normalizedImageIndex) && normalizedImageIndex >= 0 && normalizedImageIndex < 20,
        400,
        'invalid_request',
        'imageIndex must be an integer from 0 to 19',
      )
      const sourceUrl = await this.store.getCommittedEcommerceImageSource({
        requestId: normalizedRequestId,
        consumerId: context.consumer.id,
        itemId: normalizedItemId,
        imageIndex: normalizedImageIndex,
      })
      assert(sourceUrl, 404, 'external_media_not_found', 'Product image is not available for this request')
      const media = await this.externalImageLoader(sourceUrl, {
        signal,
        cacheScope: context.consumer.id,
      })
      if (deliveryComplete && typeof deliveryComplete.then === 'function') {
        releaseDeferred = true
        Promise.resolve(deliveryComplete).then(release, release)
      }
      return media
    } finally {
      if (!releaseDeferred) release()
    }
  }

  async socialPostImage(context, {
    requestId,
    mediaIndex,
    signal,
    deliveryComplete = null,
  }) {
    assert(
      !isTestApiKey(context.apiKey),
      403,
      'test_key_not_supported',
      'Test API keys cannot access external social media',
    )
    assert(
      this.externalImageLoader && typeof this.store.getCommittedSocialPostMediaSource === 'function',
      503,
      'external_media_unavailable',
      'Social image relay is unavailable',
    )
    const [platforms, capabilities] = await Promise.all([
      this.#effectivePlatformGrants(context),
      this.#effectiveCapabilityGrants(context),
    ])
    assert(platforms.includes('xiaohongshu'), 403, 'platform_not_granted', 'Platform is not granted')
    assert(capabilities.includes(XIAOHONGSHU_POST_OPERATION), 403, 'capability_not_granted', 'Post detail is not granted')
    const release = this.#enterExternalMedia(context.consumer.id)
    let releaseDeferred = false
    try {
      const normalizedRequestId = requiredUuid(requestId, 'requestId')
      const normalizedMediaIndex = Number(mediaIndex)
      assert(
        Number.isInteger(normalizedMediaIndex) && normalizedMediaIndex >= 0 && normalizedMediaIndex < 20,
        400,
        'invalid_request',
        'mediaIndex must be an integer from 0 to 19',
      )
      const sourceUrl = await this.store.getCommittedSocialPostMediaSource({
        requestId: normalizedRequestId,
        consumerId: context.consumer.id,
        mediaIndex: normalizedMediaIndex,
      })
      assert(sourceUrl, 404, 'external_media_not_found', 'Social image is not available for this request')
      const media = await this.externalImageLoader(sourceUrl, {
        signal,
        cacheScope: context.consumer.id,
      })
      if (deliveryComplete && typeof deliveryComplete.then === 'function') {
        releaseDeferred = true
        Promise.resolve(deliveryComplete).then(release, release)
      }
      return media
    } finally {
      if (!releaseDeferred) release()
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
    const grants = await this.#effectivePlatformGrants(context)
    const matchingGrant = grants.find((grant) => canonicalPlatform(grant) === requestedPlatform)
    assert(matchingGrant, 403, 'platform_not_granted', 'Platform is not granted')
    if (requestedPlatform === 'xiaohongshu') {
      const requiredCapability = NIGHT_ALL_XIAOHONGSHU_OPERATION_CAPABILITIES[operation]
      const capabilityGrants = await this.#effectiveCapabilityGrants(context)
      assert(
        capabilityGrants.includes(requiredCapability),
        403,
        'capability_not_granted',
        `${requiredCapability} is not granted`,
      )
    }
    const storedPolicy = (await this.store.getPolicy(context.consumer.id, requestedPlatform))
      || (matchingGrant !== requestedPlatform
        ? await this.store.getPolicy(context.consumer.id, matchingGrant)
        : null)
    const keyEntitlement = typeof this.store.getApiKeyPlatformEntitlement === 'function'
      ? await this.store.getApiKeyPlatformEntitlement(context.apiKey.id, matchingGrant)
      : null
    const policy = {
      ...this.defaultPolicy,
      ...(storedPolicy || {}),
      maxPageSize: Math.min(
        storedPolicy?.maxPageSize || this.defaultPolicy.maxPageSize,
        keyEntitlement?.maxPageSize || Number.POSITIVE_INFINITY,
      ),
    }
    const normalized = normalizeNightAllCompatibilityRequest(operation, body, {
      businessId: context.consumer.businessId,
      canonicalizePlatform: canonicalPlatform,
      maxPageSize: policy.maxPageSize,
    })
    const directUserActivity = directXiaohongshuLegacyUserActivityRequest(operation, normalized)
    if (
      directUserActivity
      && this.externalSocialUserActivity
      && (
        (operation === 'crawl' && (
          isDirectXiaohongshuCursor(directUserActivity.body.cursor)
          || isDirectXiaohongshuCursor(directUserActivity.body.params?.cursor)
        ))
        || (this.externalSocialUserActivityEnabled && !isTestApiKey(context.apiKey))
      )
    ) {
      return this.externalSocialUserActivity(context, {
        operation,
        body: directUserActivity.body,
        idempotencyKey,
        path,
      })
    }
    const direct = directXiaohongshuLegacyRawRequest(operation, normalized)
    if (
      direct
      && this.externalSocialSearch
      && (
        isDirectXiaohongshuCursor(direct.body.cursor)
        || (this.#externalSocialSearchEnabledFor(context) && !isTestApiKey(context.apiKey))
      )
    ) {
      return this.externalSocialSearch(context, {
        ...direct,
        idempotencyKey,
        path,
        responseMode: 'legacy',
        fingerprintBody: {
          contractVersion: 'mx-insight-hub.night-all-compat.v1',
          ...normalized.upstreamBody,
        },
        replayWindowMs: null,
      })
    }
    const compatibilityCursorCodec = createNightAllCompatibilityCursorCodec(
      this.apiKeyPepper,
      context.consumer.id,
    )
    const traversal = prepareNightAllCompatibilityTraversal({
      operation,
      platform: normalized.platform,
      upstreamBody: normalized.upstreamBody,
      codec: compatibilityCursorCodec,
    })
    const fingerprint = requestFingerprint({
      method: 'POST',
      path,
      body: { contractVersion: 'mx-insight-hub.night-all-compat.v1', ...traversal.upstreamBody },
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
      meterKey: normalized.platform === 'xiaohongshu'
        ? NIGHT_ALL_XIAOHONGSHU_OPERATION_CAPABILITIES[operation]
        : operation,
      ...(normalized.platform === 'xiaohongshu' ? {
        requiredAuthorizationScopes: [
          { type: 'platform', key: normalized.platform },
          {
            type: 'capability',
            key: NIGHT_ALL_XIAOHONGSHU_OPERATION_CAPABILITIES[operation],
          },
        ],
      } : {}),
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
      const pinnedCapability = buildNightAllLegacySearchCapabilities([normalized.platform])
        .operations[operation]
      if (!pinnedCapability.supportedPlatforms.includes(normalized.platform)) {
        throw new AppError(
          400,
          'platform_operation_unsupported',
          'The platform does not support this Night-All compatibility operation',
          { platform: normalized.platform, operation },
        )
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
        body: traversal.upstreamBody,
        businessId: context.consumer.businessId,
      })
      const responseBody = capNightAllCompatibilityTraversal(upstream.payload, {
        operation,
        platform: normalized.platform,
        page: traversal.page,
        scope: traversal.scope,
        codec: compatibilityCursorCodec,
        upstreamBody: traversal.upstreamBody,
      })
      const businessOutcome = nightAllCompatibilityBusinessOutcome(responseBody)
      const capturedAt = new Date()
      const staleUntil = new Date(capturedAt.getTime() + nightAllCompatibilityFallbackWindowMs(operation))
      const upstreamLatencyMs = Math.round(performance.now() - startedAt)
      const unitsActual = nightAllCompatibilityItemCount(responseBody)
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
        responseBody,
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
        body: responseBody,
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
    const grants = await this.#effectivePlatformGrants(context)
    assert(grants.includes(platform), 403, 'platform_not_granted', 'Platform is not granted')
    assert(
      !platform.startsWith(CRAWLER_SAVED_RECORDS_PLATFORM_PREFIX),
      400,
      'platform_operation_unsupported',
      'Data Center crawler corpora are Hub-stored; use canonical stored search',
    )
    if (platform === 'xiaohongshu') {
      const capabilityGrants = await this.#effectiveCapabilityGrants(context)
      assert(
        capabilityGrants.includes(XIAOHONGSHU_SEARCH_OPERATION),
        403,
        'capability_not_granted',
        `${XIAOHONGSHU_SEARCH_OPERATION} is not granted`,
      )
    }
    assert(
      platform !== PUBLIC_OPINION_PLATFORM,
      400,
      'platform_operation_unsupported',
      'public_opinion is Hub-stored; use the province feed or canonical stored search',
    )

    const policy = await this.#effectivePlatformPolicy(context, platform)
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
    if (
      platform === 'xiaohongshu'
      && pageSize === DIRECT_XIAOHONGSHU_PAGE_SIZE
      && this.externalSocialSearch
      && (!cursor || isDirectXiaohongshuCursor(cursor))
      && (
        isDirectXiaohongshuCursor(cursor)
        || (this.#externalSocialSearchEnabledFor(context) && !isTestApiKey(context.apiKey))
      )
    ) {
      return this.externalSocialSearch(context, {
        body: upstreamBody,
        idempotencyKey,
        path,
        responseMode: 'modern',
        fingerprintBody: { ...fingerprintQuery, type: resultType },
        enrichment: {},
        replayWindowMs: replayWindowFor(resultType),
      })
    }
    // Every non-local request below is served by the historical compatibility
    // adapter. Keep its opaque continuation inside a Hub-authenticated cursor
    // so no provider can bypass the shared 15-page acquisition boundary.
    // Telegram remains entirely local, while Xiaohongshu mxec2 cursors have
    // already returned through the Hub-native branch above.
    const historicalCompatibilityCursorCodec = platform === 'telegram'
      ? null
      : createNightAllCompatibilityCursorCodec(this.apiKeyPepper, context.consumer.id)
    const historicalCompatibilityTraversal = historicalCompatibilityCursorCodec
      ? prepareNightAllCompatibilityTraversal({
          operation: 'data-search',
          platform,
          upstreamBody,
          codec: historicalCompatibilityCursorCodec,
        })
      : null
    const historicalUpstreamBody = historicalCompatibilityTraversal?.upstreamBody ?? upstreamBody
    if (historicalCompatibilityTraversal) fingerprintQuery = historicalUpstreamBody
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
      ...(platform === 'xiaohongshu' ? {
        meterKey: XIAOHONGSHU_SEARCH_OPERATION,
        requiredAuthorizationScopes: [
          { type: 'platform', key: platform },
          { type: 'capability', key: XIAOHONGSHU_SEARCH_OPERATION },
        ],
      } : {}),
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
            body: historicalUpstreamBody,
            businessId: context.consumer.businessId,
          })
      const responsePayload = localTelegram
        ? await this.#searchStoredTelegram(telegramQuery, startedAt)
        : historicalCompatibilityTraversal
          ? capNightAllDataSearchTraversal(upstream.payload, {
              platform,
              page: historicalCompatibilityTraversal.page,
              scope: historicalCompatibilityTraversal.scope,
              codec: historicalCompatibilityCursorCodec,
            })
          : upstream.payload
      // The HTTP layer has always exposed the durable Hub request ID. Persist
      // that exact delivered JSON as the replay/history body too, instead of
      // appending requestId only after the usage commit.
      const responseBody = { ...responsePayload, requestId: activeRequestId }
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
