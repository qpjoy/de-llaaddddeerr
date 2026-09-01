import { createHash, randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import {
  CANONICAL_CONTEXT_DATASETS,
  canonicalEventTimeCursor,
} from '../data/canonical-context.mjs'
import { SOURCE_CATALOG_SEED } from '../data/source-catalog-seed.mjs'
import { sourceCatalogTermNormalizedName } from '../data/source-catalog.mjs'
import { VIRTUAL_SUPERMARKET_DEFAULT_CATEGORY_ID } from '../data/virtual-supermarket.mjs'

function nowIso() {
  return new Date().toISOString()
}

function clone(value) {
  return value == null ? value : structuredClone(value)
}

function memoryCanonicalField(record, camel, snake = camel) {
  return record?.[camel] ?? record?.[snake] ?? null
}

function memoryCanonicalContextRow(record) {
  const stableFields = memoryCanonicalField(record, 'stableFields', 'stable_fields') || {}
  const eventTime = memoryCanonicalField(record, 'eventTime', 'event_time')
  return {
    id: record.id,
    dataset_id: memoryCanonicalField(record, 'datasetId', 'dataset_id'),
    platform: record.platform ?? null,
    object_type: memoryCanonicalField(record, 'objectType', 'object_type'),
    content_type: memoryCanonicalField(record, 'contentType', 'content_type'),
    external_id: memoryCanonicalField(record, 'externalId', 'external_id'),
    url: record.url ?? null,
    title: record.title ?? null,
    body: record.body ?? null,
    author_external_id: memoryCanonicalField(record, 'authorExternalId', 'author_external_id'),
    author_name: memoryCanonicalField(record, 'authorName', 'author_name'),
    event_time: eventTime,
    event_time_cursor: canonicalEventTimeCursor(
      memoryCanonicalField(record, 'eventTimeCursor', 'event_time_cursor') ?? eventTime,
    ),
    collected_at: memoryCanonicalField(record, 'collectedAt', 'collected_at'),
    stable_fields: clone(stableFields),
    context_id: stableFields?.relations?.chatId ?? null,
  }
}

function memoryCanonicalContextActive(record) {
  return record?.platform === 'telegram'
    && !memoryCanonicalField(record, 'deletedAt', 'deleted_at')
}

function canonicalTimelineTuple(row) {
  return [row.event_time_cursor ?? canonicalEventTimeCursor(row.event_time), row.id]
}

function compareCanonicalTimelineRows(left, right) {
  const [leftTime, leftId] = canonicalTimelineTuple(left)
  const [rightTime, rightId] = canonicalTimelineTuple(right)
  if (leftTime !== rightTime) return String(leftTime).localeCompare(String(rightTime))
  return leftId.localeCompare(rightId)
}

function defaultVirtualSupermarketCategory() {
  const now = nowIso()
  return {
    id: VIRTUAL_SUPERMARKET_DEFAULT_CATEGORY_ID,
    categoryKey: 'uncategorized',
    displayName: '待分类',
    departmentKey: 'uncategorized',
    departmentName: '待分类区',
    departmentSortOrder: 1_000_000,
    aisleKey: 'uncategorized',
    aisleName: '待整理通道',
    aisleSortOrder: 1_000_000,
    shelfKey: 'uncategorized',
    shelfName: '待整理货架',
    shelfSortOrder: 1_000_000,
    sortOrder: 1_000_000,
    revision: 1,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  }
}

function defaultVirtualSupermarketListing() {
  return {
    explicit: false,
    publicationId: null,
    status: 'off_shelf',
    categoryId: VIRTUAL_SUPERMARKET_DEFAULT_CATEGORY_ID,
    displayTitle: null,
    specification: null,
    priceAmount: null,
    currency: null,
    shelfPosition: null,
    revision: 0,
    createdBy: null,
    updatedBy: null,
    createdAt: null,
    updatedAt: null,
  }
}

function virtualSupermarketMemoryItem(record, listing, category) {
  return {
    id: record.id,
    externalId: record.externalId ?? record.external_id ?? null,
    title: record.title ?? null,
    authorName: record.authorName ?? record.author_name ?? null,
    collectedAt: record.collectedAt ?? record.collected_at ?? null,
    currentRevision: Number(record.currentRevision ?? record.current_revision ?? 1),
    stableFields: clone(record.stableFields ?? record.stable_fields ?? {}),
    listing: clone(listing),
    category: clone(category),
  }
}

function virtualSupermarketEffectivePrice(item) {
  const value = item.listing.priceAmount
    ?? item.stableFields?.commerce?.product?.price
    ?? null
  const text = value == null ? '' : String(value).trim()
  if (!/^(?:0|[1-9]\d{0,17})(?:\.\d{1,2})?$/u.test(text)) return null
  const [whole, fraction = ''] = text.split('.')
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))
}

function virtualSupermarketInventoryFingerprint(records) {
  const snapshots = records.map((record) => ({
    id: record.id,
    externalId: record.externalId ?? record.external_id ?? null,
    currentRevision: Number(record.currentRevision ?? record.current_revision ?? 1),
    collectedAt: record.collectedAt ?? record.collected_at ?? null,
    title: record.title ?? null,
    authorName: record.authorName ?? record.author_name ?? null,
    stableFields: record.stableFields ?? record.stable_fields ?? {},
  })).sort((left, right) => left.id.localeCompare(right.id))
  const maxCollectedAt = snapshots.reduce((maximum, item) => (
    String(item.collectedAt || '') > maximum ? String(item.collectedAt || '') : maximum
  ), '')
  const maxId = snapshots.reduce((maximum, item) => (item.id > maximum ? item.id : maximum), '')
  const digest = createHash('sha256').update(JSON.stringify({
    count: snapshots.length,
    maxCollectedAt,
    maxId,
    records: snapshots,
  })).digest('hex')
  return `sha256:${digest}`
}

function assertVirtualSupermarketCategoryHierarchy(categories, candidate, excludedId = null) {
  const others = categories.filter((category) => category.id !== excludedId)
  const rules = [
    {
      level: 'department',
      key: candidate.departmentKey,
      conflict: (category) => (
        category.departmentKey === candidate.departmentKey
        && (
          category.departmentName !== candidate.departmentName
          || category.departmentSortOrder !== candidate.departmentSortOrder
        )
      ),
    },
    {
      level: 'aisle',
      key: candidate.aisleKey,
      conflict: (category) => (
        category.departmentKey === candidate.departmentKey
        && category.aisleKey === candidate.aisleKey
        && (
          category.aisleName !== candidate.aisleName
          || category.aisleSortOrder !== candidate.aisleSortOrder
        )
      ),
    },
    {
      level: 'shelf',
      key: candidate.shelfKey,
      conflict: (category) => (
        category.departmentKey === candidate.departmentKey
        && category.aisleKey === candidate.aisleKey
        && category.shelfKey === candidate.shelfKey
        && (
          category.shelfName !== candidate.shelfName
          || category.shelfSortOrder !== candidate.shelfSortOrder
        )
      ),
    },
  ]
  for (const rule of rules) {
    const conflict = others.find(rule.conflict)
    if (!conflict) continue
    throw new AppError(
      409,
      'virtual_supermarket_category_hierarchy_conflict',
      'Virtual-supermarket hierarchy key is already bound to different metadata',
      { level: rule.level, key: rule.key, conflictingCategoryId: conflict.id },
    )
  }
}

function initialSourceCatalogTerms(entries) {
  const terms = new Map()
  const add = (kind, displayName) => {
    const normalizedName = sourceCatalogTermNormalizedName(displayName)
    if (!normalizedName || terms.has(`${kind}\u0000${normalizedName}`)) return
    const id = randomUUID()
    terms.set(`${kind}\u0000${normalizedName}`, {
      id,
      termKey: `term-${id}`,
      kind,
      displayName: String(displayName).normalize('NFKC').trim(),
      normalizedName,
      description: null,
      color: null,
      sortOrder: 0,
      revision: 1,
      archivedAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
  }
  for (const entry of entries) {
    add('major_category', entry.majorCategory)
    entry.scenarios?.forEach((value) => add('scenario', value))
    entry.regions?.forEach((value) => add('region', value))
    entry.tags?.forEach((value) => add('tag', value))
  }
  return [...terms.values()]
}

function initialSourceCatalogOwners(entries) {
  const owners = new Map()
  for (const entry of entries) {
    const normalizedName = sourceCatalogTermNormalizedName(entry.owner)
    if (!normalizedName || owners.has(normalizedName)) continue
    const id = randomUUID()
    owners.set(normalizedName, {
      id,
      ownerKey: `owner-${id}`,
      displayName: String(entry.owner).normalize('NFKC').trim(),
      normalizedName,
      description: null,
      linkedAccountId: null,
      revision: 1,
      archivedAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
  }
  return owners
}

function sourceCatalogEntryNormalizedNames(entry) {
  return [...new Set([entry.canonicalName, ...(entry.aliases || [])]
    .map(sourceCatalogTermNormalizedName)
    .filter(Boolean))]
}

function sourceCatalogEntryTaxonomyValues(entry, kind) {
  if (kind === 'major_category') return [entry.majorCategory]
  if (kind === 'scenario') return entry.scenarios || []
  if (kind === 'region') return entry.regions || []
  return entry.tags || []
}

function sourceCatalogEntryUsesTerm(entry, term) {
  const normalizedTerm = sourceCatalogTermNormalizedName(term.displayName)
  return sourceCatalogEntryTaxonomyValues(entry, term.kind)
    .some((value) => sourceCatalogTermNormalizedName(value) === normalizedTerm)
}

function safeSourceCatalogRecord(record) {
  return {
    id: record.id,
    datasetId: record.datasetId,
    platform: record.platform,
    objectType: record.objectType,
    contentType: record.contentType ?? null,
    externalId: record.externalId,
    title: record.title ?? null,
    currentRevision: Number(record.currentRevision || 1),
    eventTime: record.eventTime ?? null,
    collectedAt: record.collectedAt ?? null,
    deletedAt: record.deletedAt ?? null,
  }
}

function active(record) {
  return record?.status === 'active'
}

const connectorCallOutcomes = new Set(['complete', 'partial', 'failed', 'unknown'])
const connectorSourceModes = new Set(['live', 'stale'])
const connectorFailureKinds = new Set(['network', 'timeout', 'http', 'contract', 'business', 'internal', 'unknown'])
const transientHttpStatuses = new Set([502, 503, 504])

function compatibilitySnapshotKey(consumerId, operation, fingerprint) {
  return `${consumerId}\u0000${operation}\u0000${fingerprint}`
}

function timestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) {
    throw new AppError(400, 'invalid_compatibility_timestamp', 'Compatibility timestamp is invalid')
  }
  return date.toISOString()
}

function replayExpired(record, replayWindowMs) {
  if (replayWindowMs == null || !record.completedAt) return false
  return Date.now() - new Date(record.completedAt).getTime() > replayWindowMs
}

function assertConnectorOutcome(outcome) {
  if (!connectorCallOutcomes.has(outcome)) {
    throw new AppError(400, 'invalid_connector_outcome', 'Connector outcome is invalid')
  }
}

function assertSourceMode(sourceMode) {
  if (!connectorSourceModes.has(sourceMode)) {
    throw new AppError(400, 'invalid_connector_source_mode', 'Connector source mode is invalid')
  }
}

function assertFailureKind(failureKind) {
  if (failureKind != null && !connectorFailureKinds.has(failureKind)) {
    throw new AppError(400, 'invalid_connector_failure_kind', 'Connector failure kind is invalid')
  }
}

function assertTransientFallback({ failureKind, httpStatus }) {
  const eligible = ((failureKind === 'network' || failureKind === 'timeout') && httpStatus == null)
    || (failureKind === 'contract' && httpStatus == null)
    || (failureKind === 'http' && transientHttpStatuses.has(httpStatus))
  if (!eligible) {
    throw new AppError(
      409,
      'compatibility_fallback_not_allowed',
      'Only network, timeout, invalid-success-contract, or HTTP 502/503/504 failures may use a compatibility snapshot',
    )
  }
}

export class MemoryStore {
  constructor() {
    this.tenants = new Map()
    this.consumers = new Map()
    this.apiKeys = new Map()
    this.apiKeysByDigest = new Map()
    this.grants = new Map()
    this.policies = new Map()
    this.capabilityGrants = new Map()
    this.capabilityPolicies = new Map()
    this.requests = new Map()
    this.requestsByScope = new Map()
    this.connectorCalls = new Map()
    this.compatibilitySnapshots = new Map()
    this.compatibilitySnapshotsByKey = new Map()
    // File/source administration is durable only in PostgreSQL. Keeping a
    // small in-memory catalog makes the local UI and focused HTTP tests honest
    // enough to exercise registration without pretending imports are durable.
    this.externalSources = new Map()
    this.databaseConnections = new Map()
    const defaultStoreCategory = defaultVirtualSupermarketCategory()
    this.virtualSupermarketStorefrontRevision = 1
    this.virtualSupermarketCategories = new Map([[defaultStoreCategory.id, defaultStoreCategory]])
    this.virtualSupermarketCategoryEvents = new Map([[defaultStoreCategory.id, [{
      id: '50000000-0000-4000-8000-000000000002',
      aggregateType: 'category',
      aggregateId: defaultStoreCategory.id,
      eventType: 'seed_import',
      actor: 'memory-seed',
      fromRevision: null,
      toRevision: 1,
      storefrontRevision: 1,
      reason: null,
      changes: { seed: 'uncategorized' },
      createdAt: defaultStoreCategory.createdAt,
    }]]])
    this.virtualSupermarketListings = new Map()
    this.virtualSupermarketProductEvents = new Map()
    // The governance catalog is useful in local development without a data
    // plane. Unlike canonical records it is ordinary administrative metadata,
    // so the memory implementation can exercise the complete CRUD contract.
    const ownersByName = initialSourceCatalogOwners(SOURCE_CATALOG_SEED)
    this.sourceCatalogOwners = new Map([...ownersByName.values()].map((owner) => [owner.id, owner]))
    this.sourceCatalogOwnerEvents = new Map([...ownersByName.values()].map((owner) => [owner.id, [{
      id: randomUUID(),
      ownerId: owner.id,
      eventType: 'seed_import',
      actor: 'memory-seed',
      fromRevision: null,
      toRevision: 1,
      changes: { after: clone(owner) },
      createdAt: owner.createdAt,
    }]]))
    this.sourceCatalogEntries = new Map(SOURCE_CATALOG_SEED.map((entry) => {
      const ownerId = ownersByName.get(sourceCatalogTermNormalizedName(entry.owner))?.id || null
      return [entry.id, { ...clone(entry), ownerId }]
    }))
    this.sourceCatalogEvents = new Map(SOURCE_CATALOG_SEED.map((entry) => [entry.id, [{
      id: entry.id,
      entryId: entry.id,
      eventType: 'seed_import',
      actor: 'memory-seed',
      fromRevision: null,
      toRevision: entry.revision,
      changes: {
        after: {
          id: entry.id,
          sourceKey: entry.sourceKey,
          legacySequence: entry.legacySequence,
          revision: entry.revision,
          importedFrom: entry.importedFrom,
        },
      },
      createdAt: entry.createdAt,
    }]]))
    const taxonomyTerms = initialSourceCatalogTerms(SOURCE_CATALOG_SEED)
    this.sourceCatalogTerms = new Map(taxonomyTerms.map((term) => [term.id, term]))
    this.sourceCatalogTermEvents = new Map(taxonomyTerms.map((term) => [term.id, [{
      id: randomUUID(),
      termId: term.id,
      eventType: 'seed_import',
      actor: 'memory-seed',
      fromRevision: null,
      toRevision: 1,
      changes: { after: clone(term) },
      createdAt: term.createdAt,
    }]]))
    // Canonical data stays PostgreSQL-authoritative. These maps are empty in
    // local mode, but keep the related-data contract testable without faking a
    // second API shape.
    this.canonicalRecords = new Map()
    this.recordChunks = new Map()
  }

  async close() {}

  async ping() {
    return true
  }

  async reapStaleReservations(now = new Date()) {
    let reaped = 0
    for (const record of this.requests.values()) {
      if (record.status === 'reserved' && record.leaseExpiresAt && new Date(record.leaseExpiresAt) <= now) {
        Object.assign(record, {
          status: 'unknown',
          errorCode: 'reservation_lease_expired',
          completedAt: now.toISOString(),
        })
        for (const call of this.connectorCalls.values()) {
          if (call.requestId !== record.id || call.outcome != null) continue
          Object.assign(call, {
            outcome: 'unknown',
            businessStatus: 'unknown',
            failureKind: 'unknown',
            errorCode: 'reservation_lease_expired',
            completedAt: now.toISOString(),
          })
        }
        reaped += 1
      }
    }
    return reaped
  }

  async createTenant({ name, status = 'active' }) {
    const record = { id: randomUUID(), name, status, createdAt: nowIso(), updatedAt: nowIso() }
    this.tenants.set(record.id, record)
    return clone(record)
  }

  async listTenants() {
    return clone([...this.tenants.values()])
  }

  async getTenant(id) {
    return clone(this.tenants.get(id) || null)
  }

  async renameTenant(id, name) {
    const record = this.tenants.get(id)
    if (!record) return null
    record.name = name
    record.updatedAt = nowIso()
    return clone(record)
  }

  async createConsumer({ tenantId, name, status = 'active', businessId, defaultCapabilityPolicy = null }) {
    if (!this.tenants.has(tenantId)) throw new AppError(404, 'tenant_not_found', 'Tenant not found')
    if (businessId && [...this.consumers.values()].some((consumer) => consumer.businessId === businessId)) {
      throw new AppError(409, 'business_id_conflict', 'businessId is already assigned to another consumer')
    }
    const id = randomUUID()
    const createdAt = nowIso()
    const record = {
      id,
      tenantId,
      name,
      status,
      businessId: businessId || `mxih:${tenantId}:${id}`,
      createdAt,
      updatedAt: createdAt,
    }

    // Consumer creation and its default public capability become visible in
    // the same synchronous turn; API keys are still issued separately.
    this.consumers.set(id, record)
    if (defaultCapabilityPolicy) {
      const { capability, maxRequests, windowSeconds } = defaultCapabilityPolicy
      this.capabilityGrants.set(id, [capability])
      this.capabilityPolicies.set(`${id}:${capability}`, {
        tenantId,
        consumerId: id,
        capability,
        maxRequests,
        windowSeconds,
        updatedAt: createdAt,
      })
    }
    return clone(record)
  }

  async listConsumers(tenantId) {
    return clone(
      [...this.consumers.values()].filter((record) => !tenantId || record.tenantId === tenantId),
    )
  }

  async getConsumer(id) {
    return clone(this.consumers.get(id) || null)
  }

  async createApiKey({ id, tenantId, consumerId, name, digest, prefix, lastFour, environment = 'live', status = 'active', expiresAt }) {
    if (!this.consumers.has(consumerId)) {
      throw new AppError(404, 'consumer_not_found', 'Consumer not found')
    }
    const record = {
      id,
      tenantId,
      consumerId,
      name,
      digest,
      prefix,
      lastFour,
      environment,
      status,
      createdAt: nowIso(),
      expiresAt,
      revokedAt: null,
      lastUsedAt: null,
    }
    this.apiKeys.set(id, record)
    this.apiKeysByDigest.set(digest, id)
    return this.#publicApiKey(record)
  }

  #publicApiKey(record) {
    const { digest: _digest, ...safe } = record
    return clone({
      ...safe,
      effectiveStatus: safe.status === 'active'
        && safe.expiresAt != null
        && new Date(safe.expiresAt).getTime() <= Date.now()
        ? 'expired'
        : safe.status,
    })
  }

  async listApiKeys(consumerId) {
    return [...this.apiKeys.values()]
      .filter((record) => !consumerId || record.consumerId === consumerId)
      .map((record) => this.#publicApiKey(record))
  }

  async findApiKeyByDigest(digest) {
    const key = this.apiKeys.get(this.apiKeysByDigest.get(digest))
    if (!active(key) || (key.expiresAt != null && new Date(key.expiresAt).getTime() <= Date.now())) return null
    const consumer = this.consumers.get(key.consumerId)
    const tenant = this.tenants.get(key.tenantId)
    if (!active(consumer) || !active(tenant)) return null
    key.lastUsedAt = nowIso()
    return clone({ apiKey: this.#publicApiKey(key), consumer, tenant })
  }

  async revokeApiKey(id) {
    const record = this.apiKeys.get(id)
    if (!record) throw new AppError(404, 'api_key_not_found', 'API key not found')
    record.status = 'revoked'
    record.revokedAt = nowIso()
    return this.#publicApiKey(record)
  }

  async replaceGrants(consumerId, platforms) {
    if (!this.consumers.has(consumerId)) {
      throw new AppError(404, 'consumer_not_found', 'Consumer not found')
    }
    const normalized = [...new Set(platforms)].sort()
    this.grants.set(consumerId, normalized)
    return clone(normalized)
  }

  async setPlatformGrant(consumerId, platform, enabled) {
    if (!this.consumers.has(consumerId)) {
      throw new AppError(404, 'consumer_not_found', 'Consumer not found')
    }
    const grants = new Set(this.grants.get(consumerId) || [])
    if (enabled) grants.add(platform)
    else grants.delete(platform)
    this.grants.set(consumerId, [...grants].sort())
  }

  async listGrants(consumerId) {
    return clone(this.grants.get(consumerId) || [])
  }

  async listCapabilityGrants(consumerId) {
    return clone(this.capabilityGrants.get(consumerId) || [])
  }

  async putCapabilityConfiguration({
    tenantId,
    consumerId,
    capability,
    enabled,
    maxRequests,
    windowSeconds,
  }) {
    if (!this.tenants.has(tenantId)) throw new AppError(404, 'tenant_not_found', 'Tenant not found')
    if (this.consumers.get(consumerId)?.tenantId !== tenantId) {
      throw new AppError(404, 'consumer_not_found', 'Consumer not found')
    }

    const grants = new Set(this.capabilityGrants.get(consumerId) || [])
    if (enabled) grants.add(capability)
    else grants.delete(capability)
    const policyRecord = {
      tenantId,
      consumerId,
      capability,
      maxRequests,
      windowSeconds,
      updatedAt: nowIso(),
    }

    // Publish both copy-on-write snapshots in one synchronous turn. No caller
    // can observe a new grant paired with the old policy (or vice versa).
    const nextGrants = new Map(this.capabilityGrants)
    nextGrants.set(consumerId, [...grants].sort())
    const nextPolicies = new Map(this.capabilityPolicies)
    nextPolicies.set(`${consumerId}:${capability}`, policyRecord)
    this.capabilityGrants = nextGrants
    this.capabilityPolicies = nextPolicies
    return clone(policyRecord)
  }

  async putPolicy({ tenantId, consumerId, platform, maxRequests, windowSeconds, maxPageSize }) {
    if (!this.tenants.has(tenantId)) throw new AppError(404, 'tenant_not_found', 'Tenant not found')
    if (this.consumers.get(consumerId)?.tenantId !== tenantId) throw new AppError(404, 'consumer_not_found', 'Consumer not found')
    const key = `${consumerId}:${platform}`
    const record = {
      tenantId,
      consumerId,
      platform,
      maxRequests,
      windowSeconds,
      maxPageSize,
      updatedAt: nowIso(),
    }
    this.policies.set(key, record)
    return clone(record)
  }

  async getPolicy(consumerId, platform) {
    return clone(this.policies.get(`${consumerId}:${platform}`) || null)
  }

  async listPolicies(consumerId) {
    return clone([...this.policies.values()].filter((record) => record.consumerId === consumerId))
  }

  async getCapabilityPolicy(consumerId, capability) {
    return clone(this.capabilityPolicies.get(`${consumerId}:${capability}`) || null)
  }

  async listCapabilityPolicies(consumerId) {
    return clone([...this.capabilityPolicies.values()].filter((record) => record.consumerId === consumerId))
  }

  async getUsageRequestByIdempotencyKey(consumerId, idempotencyKey) {
    const id = this.requestsByScope.get(`${consumerId}:${idempotencyKey}`)
    return clone(id ? this.requests.get(id) : null)
  }

  async reserve({
    requestId,
    idempotencyKey,
    fingerprint,
    tenantId,
    consumerId,
    apiKeyId,
    platform,
    capability,
    unitsReserved,
    leaseExpiresAt,
    windowStart,
    maxRequests,
    replayWindowMs = null,
  }) {
    if (Boolean(platform) === Boolean(capability)) {
      throw new AppError(500, 'invalid_usage_scope', 'Usage reservation requires exactly one scope')
    }
    const scopeKey = `${consumerId}:${idempotencyKey}`
    const existingId = this.requestsByScope.get(scopeKey)
    if (existingId) {
      const existing = this.requests.get(existingId)
      if (existing.fingerprint !== fingerprint) return { kind: 'conflict', request: clone(existing) }
      if (existing.status === 'committed' && !replayExpired(existing, replayWindowMs)) {
        return { kind: 'replay', request: clone(existing) }
      }
      if (existing.status === 'reserved') return { kind: 'in_progress', request: clone(existing) }
      if (existing.status === 'unknown') return { kind: 'unknown', request: clone(existing) }
      if (existing.status === 'released' || existing.status === 'committed') {
        this.#assertQuota({ tenantId, consumerId, platform, capability, windowStart, maxRequests })
        Object.assign(existing, {
          status: 'reserved',
          apiKeyId,
          unitsReserved,
          unitsActual: null,
          responseStatus: null,
          responseBody: null,
          upstreamLatencyMs: null,
          deliverySourceMode: null,
          capturedAt: null,
          snapshotId: null,
          reservedAt: nowIso(),
          leaseExpiresAt: new Date(leaseExpiresAt).toISOString(),
          completedAt: null,
          errorCode: null,
        })
        return { kind: 'reserved', request: clone(existing) }
      }
    }

    this.#assertQuota({ tenantId, consumerId, platform, capability, windowStart, maxRequests })
    const record = {
      id: requestId,
      tenantId,
      consumerId,
      apiKeyId,
      idempotencyKey,
      fingerprint,
      platform: platform ?? null,
      capability: capability ?? null,
      status: 'reserved',
      unitsReserved,
      unitsActual: null,
      responseStatus: null,
      responseBody: null,
      errorCode: null,
      upstreamLatencyMs: null,
      deliverySourceMode: null,
      capturedAt: null,
      snapshotId: null,
      reservedAt: nowIso(),
      leaseExpiresAt: new Date(leaseExpiresAt).toISOString(),
      completedAt: null,
      createdAt: nowIso(),
    }
    this.requests.set(record.id, record)
    this.requestsByScope.set(scopeKey, record.id)
    return { kind: 'reserved', request: clone(record) }
  }

  #assertQuota({ tenantId, consumerId, platform, capability, windowStart, maxRequests }) {
    if (!Number.isFinite(maxRequests)) return
    const count = [...this.requests.values()].filter(
      (record) =>
        record.tenantId === tenantId &&
        record.consumerId === consumerId &&
        record.platform === (platform ?? null) &&
        record.capability === (capability ?? null) &&
        ['reserved', 'committed', 'unknown'].includes(record.status) &&
        new Date(record.reservedAt) >= windowStart,
    ).length
    if (count >= maxRequests) {
      throw new AppError(429, 'quota_exceeded', 'Request quota exceeded', {
        ...(platform ? { platform } : { capability }),
        maxRequests,
      })
    }
  }

  async commitRequest(id, { responseStatus, responseBody, unitsActual, upstreamLatencyMs }) {
    const record = this.#requestInState(id, ['reserved'])
    Object.assign(record, {
      status: 'committed',
      responseStatus,
      responseBody: clone(responseBody),
      unitsActual,
      upstreamLatencyMs,
      completedAt: nowIso(),
    })
    return clone(record)
  }

  async beginConnectorCall({
    id = randomUUID(),
    consumerId,
    requestId = null,
    operation,
    fingerprint,
    platform = null,
    sourceMode = 'live',
  }) {
    if (!this.consumers.has(consumerId)) {
      throw new AppError(404, 'consumer_not_found', 'Consumer not found')
    }
    if (requestId != null) {
      const request = this.#request(requestId)
      if (request.consumerId !== consumerId) {
        throw new AppError(409, 'connector_request_scope_mismatch', 'Connector call and request scopes differ')
      }
    }
    if (!/^[a-z][a-z0-9._-]{0,127}$/.test(operation || '')) {
      throw new AppError(400, 'invalid_connector_operation', 'Connector operation is invalid')
    }
    if (!/^[0-9a-f]{64}$/.test(fingerprint || '')) {
      throw new AppError(400, 'invalid_connector_fingerprint', 'Connector fingerprint is invalid')
    }
    assertSourceMode(sourceMode)
    if (this.connectorCalls.has(id)) {
      throw new AppError(409, 'connector_call_exists', 'Connector call already exists')
    }

    const startedAt = nowIso()
    const record = {
      id, consumerId, requestId, operation, fingerprint, platform, sourceMode,
      outcome: null, httpStatus: null, businessStatus: null, failureKind: null,
      upstreamLatencyMs: null, errorCode: null, nightAllRequestId: null,
      nightAllTraceId: null, startedAt, completedAt: null, createdAt: startedAt,
    }
    this.connectorCalls.set(id, record)
    return clone(record)
  }

  async finishConnectorCall(id, {
    outcome,
    httpStatus = null,
    businessStatus = null,
    failureKind = null,
    upstreamLatencyMs = null,
    errorCode = null,
    sourceMode = 'live',
    nightAllRequestId = null,
    nightAllTraceId = null,
  }) {
    assertConnectorOutcome(outcome)
    assertSourceMode(sourceMode)
    assertFailureKind(failureKind)
    const record = this.#connectorCallInProgress(id)
    Object.assign(record, {
      outcome, httpStatus, businessStatus, failureKind, upstreamLatencyMs,
      errorCode, sourceMode, nightAllRequestId, nightAllTraceId,
      completedAt: nowIso(),
    })
    return clone(record)
  }

  async commitCompatibilityLiveDelivery(id, {
    outcome,
    responseStatus = 200,
    responseBody,
    unitsActual = 1,
    httpStatus = 200,
    businessStatus = null,
    failureKind = null,
    upstreamLatencyMs = null,
    errorCode = null,
    nightAllRequestId = null,
    nightAllTraceId = null,
    capturedAt = new Date(),
    staleUntil = null,
    job: _job = null,
  }) {
    if (!['complete', 'partial'].includes(outcome)) {
      throw new AppError(400, 'invalid_live_delivery_outcome', 'Live delivery must be complete or partial')
    }
    if (responseBody === undefined) {
      throw new AppError(400, 'compatibility_response_required', 'Live delivery requires a response body')
    }
    assertFailureKind(failureKind)
    const call = this.#connectorCallInProgress(id)
    const request = this.#requestInState(call.requestId, ['reserved'])
    if (request.consumerId !== call.consumerId) {
      throw new AppError(409, 'connector_request_scope_mismatch', 'Connector call and request scopes differ')
    }

    const captured = timestamp(capturedAt)
    let storedSnapshot = null
    if (outcome === 'complete') {
      if (staleUntil == null) {
        throw new AppError(400, 'compatibility_stale_until_required', 'Complete live delivery requires staleUntil')
      }
      const stale = timestamp(staleUntil)
      if (new Date(stale) < new Date(captured)) {
        throw new AppError(400, 'invalid_compatibility_stale_until', 'staleUntil must not precede capturedAt')
      }
      const key = compatibilitySnapshotKey(call.consumerId, call.operation, call.fingerprint)
      const existingId = this.compatibilitySnapshotsByKey.get(key)
      const existing = existingId ? this.compatibilitySnapshots.get(existingId) : null
      if (!existing || new Date(existing.capturedAt) <= new Date(captured)) {
        const updatedAt = nowIso()
        if (existing) {
          this.compatibilitySnapshots.set(existing.id, {
            ...existing,
            supersededAt: updatedAt,
            updatedAt,
          })
        }
        storedSnapshot = {
          id: randomUUID(),
          consumerId: call.consumerId,
          operation: call.operation,
          fingerprint: call.fingerprint,
          platform: call.platform,
          responseBody: clone(responseBody),
          capturedAt: captured,
          staleUntil: stale,
          lastSuccessCallId: call.id,
          supersededAt: null,
          createdAt: updatedAt,
          updatedAt,
        }
        this.compatibilitySnapshots.set(storedSnapshot.id, storedSnapshot)
        this.compatibilitySnapshotsByKey.set(key, storedSnapshot.id)
      }
    }

    const completedAt = nowIso()
    const committedRequest = {
      ...request,
      status: 'committed',
      responseStatus,
      responseBody: clone(responseBody),
      unitsActual,
      upstreamLatencyMs,
      deliverySourceMode: 'live',
      capturedAt: captured,
      snapshotId: storedSnapshot?.id || null,
      completedAt,
    }
    const completedCall = {
      ...call,
      outcome,
      httpStatus,
      businessStatus,
      failureKind,
      upstreamLatencyMs,
      errorCode,
      sourceMode: 'live',
      nightAllRequestId,
      nightAllTraceId,
      completedAt,
    }
    this.requests.set(request.id, committedRequest)
    this.connectorCalls.set(call.id, completedCall)
    return {
      request: clone(committedRequest),
      call: clone(completedCall),
      snapshot: clone(storedSnapshot),
    }
  }

  async findUsableCompatibilitySnapshot({ consumerId, operation, fingerprint, at = new Date() }) {
    const key = compatibilitySnapshotKey(consumerId, operation, fingerprint)
    const id = this.compatibilitySnapshotsByKey.get(key)
    const record = id ? this.compatibilitySnapshots.get(id) : null
    if (!record || new Date(record.staleUntil) < new Date(timestamp(at))) return null
    return clone(record)
  }

  async commitCompatibilityStaleDelivery(id, {
    snapshotId,
    responseStatus = 200,
    unitsActual = 1,
    httpStatus = null,
    businessStatus = null,
    failureKind,
    upstreamLatencyMs = null,
    errorCode,
    nightAllRequestId = null,
    nightAllTraceId = null,
    at = new Date(),
  }) {
    assertTransientFallback({ failureKind, httpStatus })
    const call = this.#connectorCallInProgress(id)
    const request = this.#requestInState(call.requestId, ['reserved'])
    const snapshot = this.compatibilitySnapshots.get(snapshotId)
    const deliveredAt = timestamp(at)
    if (!snapshot
      || snapshot.consumerId !== call.consumerId
      || snapshot.operation !== call.operation
      || snapshot.fingerprint !== call.fingerprint
      || new Date(snapshot.staleUntil) < new Date(deliveredAt)) {
      throw new AppError(409, 'compatibility_snapshot_unavailable', 'Compatibility snapshot is unavailable')
    }

    const committedRequest = {
      ...request,
      status: 'committed',
      responseStatus,
      responseBody: clone(snapshot.responseBody),
      unitsActual,
      upstreamLatencyMs,
      deliverySourceMode: 'stale',
      capturedAt: snapshot.capturedAt,
      snapshotId: snapshot.id,
      completedAt: deliveredAt,
    }
    const completedCall = {
      ...call,
      outcome: failureKind === 'http' ? 'failed' : 'unknown',
      httpStatus,
      businessStatus,
      failureKind,
      upstreamLatencyMs,
      errorCode,
      sourceMode: 'stale',
      nightAllRequestId,
      nightAllTraceId,
      completedAt: deliveredAt,
    }
    this.requests.set(request.id, committedRequest)
    this.connectorCalls.set(call.id, completedCall)
    return {
      request: clone(committedRequest),
      call: clone(completedCall),
      snapshot: clone(snapshot),
    }
  }

  async releaseRequest(id, errorCode) {
    const record = this.#requestInState(id, ['reserved'])
    Object.assign(record, { status: 'released', errorCode, completedAt: nowIso() })
    return clone(record)
  }

  async markRequestUnknown(id, errorCode) {
    const record = this.#requestInState(id, ['reserved', 'committed'])
    Object.assign(record, { status: 'unknown', errorCode, completedAt: nowIso() })
    return clone(record)
  }

  #request(id) {
    const record = this.requests.get(id)
    if (!record) throw new AppError(404, 'request_not_found', 'Request not found')
    return record
  }

  #requestInState(id, allowedStatuses) {
    const record = this.#request(id)
    if (!allowedStatuses.includes(record.status)) {
      throw new AppError(
        409,
        'request_state_conflict',
        `Request in ${record.status} state cannot transition from ${allowedStatuses.join(' or ')}`,
      )
    }
    return record
  }

  #connectorCallInProgress(id) {
    const record = this.connectorCalls.get(id)
    if (!record) throw new AppError(404, 'connector_call_not_found', 'Connector call not found')
    if (record.outcome != null) {
      throw new AppError(409, 'connector_call_state_conflict', 'Connector call is already complete')
    }
    return record
  }

  async getRequest(id, consumerId) {
    const record = this.requests.get(id)
    if (!record || (consumerId && record.consumerId !== consumerId)) return null
    const { responseBody: _responseBody, fingerprint: _fingerprint, ...safe } = record
    return clone(safe)
  }

  async usage({ tenantId, consumerId, from, to } = {}) {
    const fromDate = from ? new Date(from) : null
    const toDate = to ? new Date(to) : null
    const records = [...this.requests.values()].filter((record) => {
      const createdAt = new Date(record.createdAt)
      return (
        (!tenantId || record.tenantId === tenantId) &&
        (!consumerId || record.consumerId === consumerId) &&
        (!fromDate || createdAt >= fromDate) &&
        (!toDate || createdAt < toDate)
      )
    })
    return summarizeUsage(records)
  }

  async dashboard() {
    const usage = summarizeUsage([...this.requests.values()])
    return {
      tenants: this.tenants.size,
      consumers: this.consumers.size,
      activeApiKeys: [...this.apiKeys.values()].filter((key) => (
        active(key) && (key.expiresAt == null || new Date(key.expiresAt).getTime() > Date.now())
      )).length,
      ...usage,
    }
  }

  async dataCenter({ pageSize = 50 } = {}) {
    return {
      stats: { datasetCount: 0, activeRecordCount: 0, revisionCount: 0, deletedRecordCount: 0 },
      datasets: [],
      records: [],
      pageSize,
    }
  }

  async dataCenterRecords() {
    return { items: [], total: 0, hasMore: false, nextCursor: null }
  }

  async dataCenterRecordsByIds() {
    return []
  }

  // ---- shared database connections -------------------------------------

  #assertDatabaseConnectionReference(id) {
    if (id != null && !this.databaseConnections.has(id)) {
      throw new AppError(404, 'database_connection_not_found', `Unknown database connection: ${id}`)
    }
  }

  async listDatabaseConnections() {
    return clone([...this.databaseConnections.values()].sort((left, right) => (
      right.createdAt.localeCompare(left.createdAt)
    )))
  }

  async getDatabaseConnection(id) {
    return clone(this.databaseConnections.get(id) || null)
  }

  async createDatabaseConnection({ key, displayName, engine = 'postgresql', connection = {} }) {
    if ([...this.databaseConnections.values()].some((entry) => entry.key === key)) {
      throw new AppError(409, 'database_connection_exists', `Database connection key already exists: ${key}`)
    }
    const createdAt = nowIso()
    const entry = {
      id: randomUUID(),
      key,
      displayName,
      engine,
      connection: clone(connection),
      revision: 1,
      createdAt,
      updatedAt: createdAt,
    }
    this.databaseConnections.set(entry.id, entry)
    return clone(entry)
  }

  async updateDatabaseConnection(id, patch, { expectedRevision = null } = {}) {
    const current = this.databaseConnections.get(id)
    if (!current) {
      throw new AppError(404, 'database_connection_not_found', `Unknown database connection: ${id}`)
    }
    if (expectedRevision != null && current.revision !== expectedRevision) {
      throw new AppError(
        409,
        'database_connection_revision_conflict',
        'Database connection changed; reload before saving',
        { expectedRevision, currentRevision: current.revision },
      )
    }
    const updated = {
      ...current,
      ...(Object.prototype.hasOwnProperty.call(patch, 'displayName')
        ? { displayName: patch.displayName }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(patch, 'engine')
        ? { engine: patch.engine }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(patch, 'connection')
        ? { connection: clone(patch.connection) }
        : {}),
      revision: current.revision + 1,
      updatedAt: nowIso(),
    }
    this.databaseConnections.set(id, updated)
    return clone(updated)
  }

  async listDatabaseConnectionReferences(id) {
    return clone([...this.externalSources.values()]
      .filter((source) => source.databaseConnectionId === id)
      .sort((left, right) => left.sourceKey.localeCompare(right.sourceKey)))
  }

  async deleteDatabaseConnection(id) {
    const current = this.databaseConnections.get(id)
    if (!current) {
      throw new AppError(404, 'database_connection_not_found', `Unknown database connection: ${id}`)
    }
    const references = await this.listDatabaseConnectionReferences(id)
    if (references.length > 0) {
      throw new AppError(
        409,
        'database_connection_in_use',
        'Database connection is referenced by one or more external sources',
        { references: references.map(({ id: sourceId, sourceKey, displayName }) => ({ sourceId, sourceKey, displayName })) },
      )
    }
    this.databaseConnections.delete(id)
    return clone(current)
  }

  async createExternalSource({
    sourceKey,
    displayName,
    sourceKind,
    datasetId,
    platform,
    objectType,
    status = 'active',
    connection = {},
    databaseConnectionId = null,
    syncIntervalSeconds = 60,
  }) {
    if (this.externalSources.has(sourceKey)) {
      throw new AppError(409, 'source_exists', `Source key already exists: ${sourceKey}`)
    }
    this.#assertDatabaseConnectionReference(databaseConnectionId)
    const createdAt = nowIso()
    const source = {
      id: randomUUID(), sourceKey, displayName, sourceKind, datasetId, platform,
      objectType: objectType || 'record', status, connection,
      databaseConnectionId,
      syncIntervalSeconds, createdAt, updatedAt: createdAt,
    }
    this.externalSources.set(sourceKey, source)
    return clone(source)
  }

  async getExternalSource(sourceKey) {
    return clone(this.externalSources.get(sourceKey) || null)
  }

  async listExternalSources() {
    return clone([...this.externalSources.values()].sort((left, right) => (
      right.createdAt.localeCompare(left.createdAt)
    )))
  }

  async updateExternalSource(sourceKey, patch) {
    const current = this.externalSources.get(sourceKey)
    if (!current) throw new AppError(404, 'source_not_found', `Unknown external source: ${sourceKey}`)
    if (Object.prototype.hasOwnProperty.call(patch, 'databaseConnectionId')) {
      this.#assertDatabaseConnectionReference(patch.databaseConnectionId)
    }
    const updated = {
      ...current,
      ...(Object.prototype.hasOwnProperty.call(patch, 'status') && patch.status != null
        ? { status: patch.status }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(patch, 'connection') && patch.connection != null
        ? { connection: clone(patch.connection) }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(patch, 'databaseConnectionId')
        ? { databaseConnectionId: patch.databaseConnectionId ?? null }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(patch, 'syncIntervalSeconds')
        ? { syncIntervalSeconds: patch.syncIntervalSeconds ?? null }
        : {}),
      updatedAt: nowIso(),
    }
    this.externalSources.set(sourceKey, updated)
    return clone(updated)
  }

  async updateExternalSourcesBatch(updates) {
    if (!Array.isArray(updates) || updates.length === 0) return []
    for (const update of updates) {
      if (!this.externalSources.has(update.sourceKey)) {
        throw new AppError(404, 'source_not_found', `Unknown external source: ${update.sourceKey}`)
      }
      if (Object.prototype.hasOwnProperty.call(update, 'databaseConnectionId')) {
        this.#assertDatabaseConnectionReference(update.databaseConnectionId)
      }
    }
    const updated = updates.map((update) => {
      const current = this.externalSources.get(update.sourceKey)
      return {
        ...current,
        ...(Object.prototype.hasOwnProperty.call(update, 'status') && update.status != null
          ? { status: update.status }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(update, 'connection') && update.connection != null
          ? { connection: clone(update.connection) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(update, 'databaseConnectionId')
          ? { databaseConnectionId: update.databaseConnectionId ?? null }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(update, 'syncIntervalSeconds')
          ? { syncIntervalSeconds: update.syncIntervalSeconds ?? null }
          : {}),
        updatedAt: nowIso(),
      }
    })
    updated.forEach((source) => this.externalSources.set(source.sourceKey, source))
    return clone(updated)
  }

  // ---- virtual supermarket ---------------------------------------------

  async getVirtualSupermarketStorefrontRevision() {
    return this.virtualSupermarketStorefrontRevision
  }

  async getVirtualSupermarketInventoryRevision() {
    return virtualSupermarketInventoryFingerprint(this.#virtualSupermarketRecords())
  }

  #bumpVirtualSupermarketStorefront() {
    this.virtualSupermarketStorefrontRevision += 1
    return this.virtualSupermarketStorefrontRevision
  }

  async listVirtualSupermarketCategories({ includeArchived = false } = {}) {
    return clone([...this.virtualSupermarketCategories.values()]
      .filter((category) => includeArchived || !category.archivedAt)
      .sort((left, right) => (
        left.departmentSortOrder - right.departmentSortOrder
        || left.departmentKey.localeCompare(right.departmentKey)
        || left.aisleSortOrder - right.aisleSortOrder
        || left.aisleKey.localeCompare(right.aisleKey)
        || left.shelfSortOrder - right.shelfSortOrder
        || left.shelfKey.localeCompare(right.shelfKey)
        || left.sortOrder - right.sortOrder
        || left.categoryKey.localeCompare(right.categoryKey)
      )))
  }

  async getVirtualSupermarketCategory(id) {
    return clone(this.virtualSupermarketCategories.get(id) || null)
  }

  async createVirtualSupermarketCategory(input, { actor = 'admin-token' } = {}) {
    if ([...this.virtualSupermarketCategories.values()].some((category) => category.categoryKey === input.categoryKey)) {
      throw new AppError(409, 'virtual_supermarket_category_exists', 'A virtual-supermarket category with this key already exists')
    }
    const createdAt = nowIso()
    const category = {
      id: randomUUID(),
      categoryKey: input.categoryKey,
      displayName: input.displayName,
      departmentKey: input.department.key,
      departmentName: input.department.name,
      departmentSortOrder: input.department.sortOrder,
      aisleKey: input.aisle.key,
      aisleName: input.aisle.name,
      aisleSortOrder: input.aisle.sortOrder,
      shelfKey: input.shelf.key,
      shelfName: input.shelf.name,
      shelfSortOrder: input.shelf.sortOrder,
      sortOrder: input.sortOrder,
      revision: 1,
      archivedAt: null,
      createdAt,
      updatedAt: createdAt,
    }
    assertVirtualSupermarketCategoryHierarchy(
      [...this.virtualSupermarketCategories.values()],
      category,
    )
    this.virtualSupermarketCategories.set(category.id, category)
    const storefrontRevision = this.#bumpVirtualSupermarketStorefront()
    this.#appendVirtualSupermarketEvent(this.virtualSupermarketCategoryEvents, category.id, {
      aggregateType: 'category', eventType: 'create', actor,
      fromRevision: null, toRevision: 1, storefrontRevision,
      reason: null, changes: { after: clone(category) },
    })
    return { item: clone(category), storefrontRevision }
  }

  async updateVirtualSupermarketCategory(id, patch, {
    expectedRevision,
    actor = 'admin-token',
  } = {}) {
    const category = this.virtualSupermarketCategories.get(id)
    if (!category) {
      throw new AppError(404, 'virtual_supermarket_category_not_found', 'Virtual-supermarket category was not found')
    }
    if (category.revision !== expectedRevision) {
      throw new AppError(
        409,
        'virtual_supermarket_category_revision_conflict',
        'Virtual-supermarket category changed; reload before saving',
        { expectedRevision, currentRevision: category.revision },
      )
    }
    const before = clone(category)
    const merged = {
      ...before,
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.department ? {
        departmentKey: patch.department.key,
        departmentName: patch.department.name,
        departmentSortOrder: patch.department.sortOrder,
      } : {}),
      ...(patch.aisle ? {
        aisleKey: patch.aisle.key,
        aisleName: patch.aisle.name,
        aisleSortOrder: patch.aisle.sortOrder,
      } : {}),
      ...(patch.shelf ? {
        shelfKey: patch.shelf.key,
        shelfName: patch.shelf.name,
        shelfSortOrder: patch.shelf.sortOrder,
      } : {}),
      ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
      revision: category.revision + 1,
      updatedAt: nowIso(),
    }
    assertVirtualSupermarketCategoryHierarchy(
      [...this.virtualSupermarketCategories.values()],
      merged,
      id,
    )
    Object.assign(category, merged)
    const storefrontRevision = this.#bumpVirtualSupermarketStorefront()
    this.#appendVirtualSupermarketEvent(this.virtualSupermarketCategoryEvents, id, {
      aggregateType: 'category', eventType: 'update', actor,
      fromRevision: before.revision, toRevision: category.revision, storefrontRevision,
      reason: null, changes: { before, after: clone(category) },
    })
    return { item: clone(category), storefrontRevision }
  }

  async listVirtualSupermarketCategoryEvents(id, limit = 50) {
    return clone((this.virtualSupermarketCategoryEvents.get(id) || [])
      .slice()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.max(1, Math.min(Number(limit) || 50, 200))))
  }

  async getCanonicalContextServingIndexStatus() {
    return {
      ready: true,
      required: [],
      indexes: [],
      missing: [],
      storage: 'memory',
    }
  }

  async getCanonicalContext({ id, before, after }) {
    const source = this.canonicalRecords.get(id)
    if (!source || !memoryCanonicalContextActive(source)) return null
    const current = memoryCanonicalContextRow(source)
    const dataset = CANONICAL_CONTEXT_DATASETS[current.dataset_id]
    const contextSupported = Boolean(
      dataset
      && current.object_type === dataset.objectType
      && canonicalTimelineTuple(current)[0]
      && current.context_id,
    )
    if (!contextSupported) {
      return {
        current,
        before: [],
        after: [],
        hasMoreStoredBefore: false,
        hasMoreStoredAfter: false,
        contextSupported: false,
      }
    }
    const stream = [...this.canonicalRecords.values()]
      .filter(memoryCanonicalContextActive)
      .map(memoryCanonicalContextRow)
      .filter((row) => (
        row.id !== current.id
        && row.dataset_id === current.dataset_id
        && row.object_type === dataset.objectType
        && row.context_id === current.context_id
        && canonicalTimelineTuple(row)[0]
      ))
      .sort(compareCanonicalTimelineRows)
    const beforeRows = stream.filter((row) => compareCanonicalTimelineRows(row, current) < 0)
    const afterRows = stream.filter((row) => compareCanonicalTimelineRows(row, current) > 0)
    return {
      current,
      before: before === 0 ? [] : clone(beforeRows.slice(-before)),
      after: clone(afterRows.slice(0, after)),
      hasMoreStoredBefore: beforeRows.length > before,
      hasMoreStoredAfter: afterRows.length > after,
      contextSupported: true,
    }
  }

  async getCanonicalTimelinePage({
    datasetId,
    contextId,
    direction,
    boundary,
    pageSize,
  }) {
    if (!CANONICAL_CONTEXT_DATASETS[datasetId] || !['older', 'newer'].includes(direction)) {
      throw new AppError(409, 'context_not_supported', 'Canonical item does not support message timeline')
    }
    const boundaryRow = { event_time: boundary.eventTime, id: boundary.id }
    const rows = [...this.canonicalRecords.values()]
      .filter(memoryCanonicalContextActive)
      .map(memoryCanonicalContextRow)
      .filter((row) => (
        row.dataset_id === datasetId
        && row.object_type === 'message'
        && row.context_id === contextId
        && canonicalTimelineTuple(row)[0]
        && (direction === 'older'
          ? compareCanonicalTimelineRows(row, boundaryRow) < 0
          : compareCanonicalTimelineRows(row, boundaryRow) > 0)
      ))
      .sort((left, right) => (
        direction === 'older'
          ? compareCanonicalTimelineRows(right, left)
          : compareCanonicalTimelineRows(left, right)
      ))
    const page = rows.slice(0, pageSize)
    return {
      items: clone(direction === 'older' ? page.reverse() : page),
      hasMore: rows.length > pageSize,
    }
  }

  #virtualSupermarketItem(record) {
    const listing = this.virtualSupermarketListings.get(record.id) || defaultVirtualSupermarketListing()
    const category = this.virtualSupermarketCategories.get(listing.categoryId)
      || this.virtualSupermarketCategories.get(VIRTUAL_SUPERMARKET_DEFAULT_CATEGORY_ID)
    return virtualSupermarketMemoryItem(record, listing, category)
  }

  #virtualSupermarketRecords() {
    return [...this.canonicalRecords.values()].filter((record) => (
      (record.datasetId ?? record.dataset_id) === 'mobile-commerce.collected-items.v1'
      && (record.platform ?? null) === 'mobile_commerce'
      && (record.objectType ?? record.object_type) === 'commerce_capture'
      && !(record.deletedAt ?? record.deleted_at)
    ))
  }

  async listVirtualSupermarketProducts({
    status = 'all',
    categoryId = null,
    department = null,
    aisle = null,
    shelf = null,
    marketplace = null,
    query = null,
    sort = 'newest',
    pageSize = 24,
    offset = 0,
    includeGovernanceEvidence = false,
  } = {}) {
    const normalizedQuery = query?.normalize('NFKC').trim().toLocaleLowerCase('zh-CN') || null
    const items = this.#virtualSupermarketRecords()
      .map((record) => this.#virtualSupermarketItem(record))
      .filter((item) => {
        if (status !== 'all' && item.listing.status !== status) return false
        if (categoryId && item.category.id !== categoryId) return false
        if (department && item.category.departmentKey !== department) return false
        if (aisle && item.category.aisleKey !== aisle) return false
        if (shelf && item.category.shelfKey !== shelf) return false
        const commerce = item.stableFields?.commerce || {}
        const mappedMarketplaceValues = commerce.marketplace?.status === 'mapped'
          ? [commerce.marketplace?.entryId, commerce.marketplace?.canonicalName]
          : []
        const marketplaceValues = includeGovernanceEvidence
          ? [
              ...mappedMarketplaceValues,
              commerce.marketplace?.sourceValue,
              commerce.marketplace?.entryId,
              commerce.marketplace?.sourceKey,
              commerce.marketplace?.canonicalName,
            ]
          : mappedMarketplaceValues
        if (marketplace && !marketplaceValues.includes(marketplace)) return false
        if (normalizedQuery) {
          const effectiveTitle = item.listing.displayTitle
            ?? commerce.product?.title
            ?? item.title
            ?? null
          const effectiveShop = commerce.shop?.name ?? item.authorName ?? null
          const searchable = [
            effectiveTitle,
            item.listing.specification,
            effectiveShop,
            ...(includeGovernanceEvidence
              ? [
                  commerce.product?.title,
                  item.title,
                  commerce.shop?.name,
                  item.authorName,
                  commerce.signals?.tagsText,
                ]
              : []),
          ].filter(Boolean).join('\n').normalize('NFKC').toLocaleLowerCase('zh-CN')
          if (!searchable.includes(normalizedQuery)) return false
        }
        return !item.category.archivedAt
      })
    items.sort((left, right) => {
      if (sort === 'title_asc') {
        const leftTitle = left.listing.displayTitle ?? left.stableFields?.commerce?.product?.title ?? left.title ?? ''
        const rightTitle = right.listing.displayTitle ?? right.stableFields?.commerce?.product?.title ?? right.title ?? ''
        return leftTitle.localeCompare(rightTitle, 'zh-CN') || left.id.localeCompare(right.id)
      }
      if (sort === 'price_asc' || sort === 'price_desc') {
        const leftPrice = virtualSupermarketEffectivePrice(left)
        const rightPrice = virtualSupermarketEffectivePrice(right)
        if (leftPrice == null && rightPrice != null) return 1
        if (rightPrice == null && leftPrice != null) return -1
        if (leftPrice != null && rightPrice != null && leftPrice !== rightPrice) {
          const direction = leftPrice < rightPrice ? -1 : 1
          return sort === 'price_asc' ? direction : -direction
        }
        return left.id.localeCompare(right.id)
      }
      return String(right.collectedAt || '').localeCompare(String(left.collectedAt || ''))
        || right.id.localeCompare(left.id)
    })
    return clone(items.slice(offset, offset + pageSize + 1))
  }

  async getVirtualSupermarketProduct(id, { onShelfOnly = false } = {}) {
    const record = this.canonicalRecords.get(id)
    if (!record || !this.#virtualSupermarketRecords().some((candidate) => candidate.id === id)) return null
    const item = this.#virtualSupermarketItem(record)
    return onShelfOnly && (item.listing.status !== 'on_shelf' || item.category.archivedAt) ? null : clone(item)
  }

  async updateVirtualSupermarketProduct(id, patch, {
    expectedRevision,
    actor = 'admin-token',
    eventType = 'update',
    reason = null,
  } = {}) {
    const record = this.#virtualSupermarketRecords().find((candidate) => candidate.id === id)
    if (!record) {
      throw new AppError(404, 'virtual_supermarket_product_not_found', 'Virtual-supermarket product was not found')
    }
    const current = this.virtualSupermarketListings.get(id) || defaultVirtualSupermarketListing()
    if (current.revision !== expectedRevision) {
      throw new AppError(
        409,
        'virtual_supermarket_listing_revision_conflict',
        'Virtual-supermarket listing changed; reload before saving',
        { expectedRevision, currentRevision: current.revision },
      )
    }
    const categoryId = patch.categoryId !== undefined
      ? patch.categoryId || VIRTUAL_SUPERMARKET_DEFAULT_CATEGORY_ID
      : current.categoryId
    const category = this.virtualSupermarketCategories.get(categoryId)
    if (!category || category.archivedAt) {
      throw new AppError(404, 'virtual_supermarket_category_not_found', 'Virtual-supermarket category was not found')
    }
    const before = clone(current)
    const now = nowIso()
    const listing = {
      ...current,
      explicit: true,
      publicationId: current.publicationId
        || (patch.status === 'on_shelf' ? randomUUID() : null),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      categoryId,
      ...(patch.displayTitle !== undefined ? { displayTitle: patch.displayTitle } : {}),
      ...(patch.specification !== undefined ? { specification: patch.specification } : {}),
      ...(patch.shelfPosition !== undefined ? { shelfPosition: patch.shelfPosition } : {}),
      ...(patch.price !== undefined ? {
        priceAmount: patch.price?.amount ?? null,
        currency: patch.price?.currency ?? null,
      } : {}),
      revision: current.revision + 1,
      createdBy: current.createdBy || actor,
      updatedBy: actor,
      createdAt: current.createdAt || now,
      updatedAt: now,
    }
    this.virtualSupermarketListings.set(id, listing)
    const storefrontRevision = this.#bumpVirtualSupermarketStorefront()
    this.#appendVirtualSupermarketEvent(this.virtualSupermarketProductEvents, id, {
      aggregateType: 'product', eventType, actor,
      fromRevision: before.revision, toRevision: listing.revision, storefrontRevision,
      reason, changes: { before, after: clone(listing) },
    })
    return { item: clone(this.#virtualSupermarketItem(record)), storefrontRevision }
  }

  async listVirtualSupermarketProductEvents(id, limit = 50) {
    return clone((this.virtualSupermarketProductEvents.get(id) || [])
      .slice()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.max(1, Math.min(Number(limit) || 50, 200))))
  }

  async getVirtualSupermarketProductByPublicationId(publicationId) {
    const match = [...this.virtualSupermarketListings.entries()].find(([, listing]) => (
      listing.publicationId === publicationId
    ))
    if (!match) return null
    return this.getVirtualSupermarketProduct(match[0], { onShelfOnly: true })
  }

  #appendVirtualSupermarketEvent(target, aggregateId, event) {
    const events = target.get(aggregateId) || []
    events.push({ id: randomUUID(), aggregateId, createdAt: nowIso(), ...clone(event) })
    target.set(aggregateId, events)
  }

  // ---- governed source catalog ------------------------------------------

  async listSourceCatalogEntries({ includeArchived = false } = {}) {
    return clone([...this.sourceCatalogEntries.values()]
      .filter((entry) => includeArchived || !entry.archivedAt)
      .sort((left, right) => (
        Number(left.legacySequence || Number.MAX_SAFE_INTEGER)
          - Number(right.legacySequence || Number.MAX_SAFE_INTEGER)
          || left.canonicalName.localeCompare(right.canonicalName, 'zh-CN')
      )))
  }

  async getSourceCatalogEntry(id) {
    return clone(this.sourceCatalogEntries.get(id) || null)
  }

  async createSourceCatalogEntry(input, { actor = 'admin-token' } = {}) {
    if ([...this.sourceCatalogEntries.values()].some((entry) => entry.sourceKey === input.sourceKey)) {
      throw new AppError(409, 'source_catalog_key_exists', `Source catalog key already exists: ${input.sourceKey}`)
    }
    if (input.legacySequence != null && [...this.sourceCatalogEntries.values()]
      .some((entry) => entry.legacySequence === input.legacySequence)) {
      throw new AppError(409, 'source_catalog_sequence_exists', `Legacy sequence already exists: ${input.legacySequence}`)
    }
    this.#assertSourceCatalogNamesAvailable(input)
    this.#assertSourceCatalogTaxonomyAvailable(input)
    const managedInput = { ...clone(input) }
    if (managedInput.ownerId) {
      managedInput.owner = this.#requireAssignableSourceCatalogOwner(managedInput.ownerId).displayName
    }
    const createdAt = nowIso()
    const entry = {
      id: randomUUID(),
      ...managedInput,
      revision: 1,
      archivedAt: null,
      createdAt,
      updatedAt: createdAt,
    }
    this.sourceCatalogEntries.set(entry.id, entry)
    this.#appendSourceCatalogEvent(entry.id, {
      eventType: 'create', actor, fromRevision: null, toRevision: 1,
      changes: { after: clone(entry) },
    })
    return clone(entry)
  }

  async updateSourceCatalogEntry(id, patch, {
    expectedRevision,
    actor = 'admin-token',
    eventType = 'update',
  } = {}) {
    const entry = this.sourceCatalogEntries.get(id)
    if (!entry) throw new AppError(404, 'source_catalog_entry_not_found', 'Source catalog entry was not found')
    if (entry.revision !== expectedRevision) {
      throw new AppError(409, 'source_catalog_revision_conflict', 'Source catalog entry changed; reload before saving', {
        expectedRevision,
        currentRevision: entry.revision,
      })
    }
    if (patch.parentSourceId === id) {
      throw new AppError(400, 'invalid_source_catalog_parent', 'A source catalog entry cannot be its own parent')
    }
    const before = clone(entry)
    const merged = { ...entry, ...clone(patch) }
    if (Object.prototype.hasOwnProperty.call(patch, 'ownerId')) {
      if (patch.ownerId) {
        merged.owner = this.#requireAssignableSourceCatalogOwner(patch.ownerId).displayName
      } else if (patch.owner) {
        merged.owner = patch.owner
      } else {
        merged.owner = null
      }
    } else if (Object.prototype.hasOwnProperty.call(patch, 'owner')) {
      const managedOwner = before.ownerId
        ? this.#requireAssignableSourceCatalogOwner(before.ownerId)
        : null
      if (
        !patch.owner
        || !managedOwner
        || sourceCatalogTermNormalizedName(patch.owner)
          !== sourceCatalogTermNormalizedName(managedOwner.displayName)
      ) {
        merged.ownerId = null
      } else {
        merged.ownerId = managedOwner.id
        merged.owner = managedOwner.displayName
      }
    } else if (merged.ownerId) {
      merged.owner = this.#requireAssignableSourceCatalogOwner(merged.ownerId).displayName
    }
    if (
      patch.canonicalName
      && sourceCatalogTermNormalizedName(patch.canonicalName)
        !== sourceCatalogTermNormalizedName(before.canonicalName)
    ) {
      merged.aliases = [...new Set([...(merged.aliases || []), before.canonicalName])]
      if (merged.aliases.length > 32) {
        throw new AppError(400, 'invalid_source_catalog_field', 'aliases has too many values')
      }
    }
    this.#assertSourceCatalogNamesAvailable(merged, { excludeEntryId: id })
    this.#assertSourceCatalogTaxonomyAvailable(merged)
    Object.assign(entry, merged, {
      revision: entry.revision + 1,
      updatedAt: nowIso(),
    })
    this.#appendSourceCatalogEvent(id, {
      eventType,
      actor,
      fromRevision: before.revision,
      toRevision: entry.revision,
      changes: { before, after: clone(entry) },
    })
    return clone(entry)
  }

  async archiveSourceCatalogEntry(id, options = {}) {
    return this.updateSourceCatalogEntry(id, { archivedAt: nowIso() }, {
      ...options,
      eventType: 'archive',
    })
  }

  async restoreSourceCatalogEntry(id, options = {}) {
    return this.updateSourceCatalogEntry(id, { archivedAt: null }, {
      ...options,
      eventType: 'restore',
    })
  }

  async listSourceCatalogEvents(entryId, limit = 50) {
    return clone((this.sourceCatalogEvents.get(entryId) || [])
      .slice()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit))
  }

  #appendSourceCatalogEvent(entryId, event) {
    const events = this.sourceCatalogEvents.get(entryId) || []
    events.push({ id: randomUUID(), entryId, createdAt: nowIso(), ...clone(event) })
    this.sourceCatalogEvents.set(entryId, events)
  }

  #requireAssignableSourceCatalogOwner(ownerId) {
    const owner = this.sourceCatalogOwners.get(ownerId)
    if (!owner) {
      throw new AppError(404, 'source_catalog_owner_not_found', 'Source catalog owner was not found')
    }
    if (owner.archivedAt) {
      throw new AppError(409, 'source_catalog_owner_archived', 'Archived source catalog owners cannot be assigned', {
        ownerId,
      })
    }
    return owner
  }

  #assertSourceCatalogNamesAvailable(candidate, { excludeEntryId = null } = {}) {
    const requested = new Set(sourceCatalogEntryNormalizedNames(candidate))
    for (const entry of this.sourceCatalogEntries.values()) {
      if (entry.id === excludeEntryId) continue
      const conflict = sourceCatalogEntryNormalizedNames(entry).find((name) => requested.has(name))
      if (!conflict) continue
      throw new AppError(409, 'source_catalog_name_conflict', 'Source catalog canonical names and aliases must be unique', {
        normalizedName: conflict,
        conflictingEntryId: entry.id,
        conflictingEntryName: entry.canonicalName,
      })
    }
  }

  #assertSourceCatalogTaxonomyAvailable(candidate) {
    for (const term of this.sourceCatalogTerms.values()) {
      if (!term.archivedAt || !sourceCatalogEntryUsesTerm(candidate, term)) continue
      throw new AppError(409, 'source_catalog_term_archived', 'Source catalog entries cannot reference an archived taxonomy term', {
        termId: term.id,
        kind: term.kind,
        displayName: term.displayName,
      })
    }
  }

  #sourceCatalogTermUsage(term) {
    return [...this.sourceCatalogEntries.values()]
      .filter((entry) => sourceCatalogEntryUsesTerm(entry, term)).length
  }

  #sourceCatalogOwnerUsage(ownerId) {
    return [...this.sourceCatalogEntries.values()]
      .filter((entry) => entry.ownerId === ownerId).length
  }

  #sourceCatalogOwnerView(owner) {
    return owner ? { ...clone(owner), usageCount: this.#sourceCatalogOwnerUsage(owner.id) } : null
  }

  async listSourceCatalogOwners({ includeArchived = false } = {}) {
    return [...this.sourceCatalogOwners.values()]
      .filter((owner) => includeArchived || !owner.archivedAt)
      .sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-CN'))
      .map((owner) => this.#sourceCatalogOwnerView(owner))
  }

  async getSourceCatalogOwner(id) {
    return this.#sourceCatalogOwnerView(this.sourceCatalogOwners.get(id))
  }

  async createSourceCatalogOwner(input, { actor = 'admin-token' } = {}) {
    if ([...this.sourceCatalogOwners.values()].some((owner) => (
      owner.ownerKey === input.ownerKey || owner.normalizedName === input.normalizedName
    ))) {
      throw new AppError(409, 'source_catalog_owner_exists', 'A source catalog owner with this key or name already exists')
    }
    if (input.linkedAccountId && [...this.sourceCatalogOwners.values()]
      .some((owner) => owner.linkedAccountId === input.linkedAccountId)) {
      throw new AppError(409, 'source_catalog_owner_account_conflict', 'This login account is already linked to another source catalog owner')
    }
    const createdAt = nowIso()
    const owner = {
      id: randomUUID(),
      ...clone(input),
      revision: 1,
      archivedAt: null,
      createdAt,
      updatedAt: createdAt,
    }
    this.sourceCatalogOwners.set(owner.id, owner)
    this.#appendSourceCatalogOwnerEvent(owner.id, {
      eventType: 'create', actor, fromRevision: null, toRevision: 1,
      changes: { after: clone(owner) },
    })
    return this.#sourceCatalogOwnerView(owner)
  }

  async updateSourceCatalogOwner(id, patch, {
    expectedRevision,
    actor = 'admin-token',
    eventType = 'update',
  } = {}) {
    const owner = this.sourceCatalogOwners.get(id)
    if (!owner) throw new AppError(404, 'source_catalog_owner_not_found', 'Source catalog owner was not found')
    if (owner.revision !== expectedRevision) {
      throw new AppError(409, 'source_catalog_owner_revision_conflict', 'Source catalog owner changed; reload before saving', {
        expectedRevision,
        currentRevision: owner.revision,
      })
    }
    if (patch.normalizedName && [...this.sourceCatalogOwners.values()].some((candidate) => (
      candidate.id !== id && candidate.normalizedName === patch.normalizedName
    ))) {
      throw new AppError(409, 'source_catalog_owner_exists', 'A source catalog owner with this name already exists')
    }
    if (patch.linkedAccountId && [...this.sourceCatalogOwners.values()].some((candidate) => (
      candidate.id !== id && candidate.linkedAccountId === patch.linkedAccountId
    ))) {
      throw new AppError(409, 'source_catalog_owner_account_conflict', 'This login account is already linked to another source catalog owner')
    }
    if (patch.archivedAt && this.#sourceCatalogOwnerUsage(id) > 0) {
      throw new AppError(409, 'source_catalog_owner_in_use', 'Referenced source catalog owners cannot be archived', {
        usageCount: this.#sourceCatalogOwnerUsage(id),
      })
    }
    const before = clone(owner)
    Object.assign(owner, clone(patch), {
      revision: owner.revision + 1,
      updatedAt: nowIso(),
    })
    if (patch.displayName) {
      for (const entry of this.sourceCatalogEntries.values()) {
        if (entry.ownerId === id) entry.owner = owner.displayName
      }
    }
    this.#appendSourceCatalogOwnerEvent(id, {
      eventType,
      actor,
      fromRevision: before.revision,
      toRevision: owner.revision,
      changes: { before, after: clone(owner) },
    })
    return this.#sourceCatalogOwnerView(owner)
  }

  async archiveSourceCatalogOwner(id, options = {}) {
    return this.updateSourceCatalogOwner(id, { archivedAt: nowIso() }, {
      ...options,
      eventType: 'archive',
    })
  }

  async restoreSourceCatalogOwner(id, options = {}) {
    return this.updateSourceCatalogOwner(id, { archivedAt: null }, {
      ...options,
      eventType: 'restore',
    })
  }

  async listSourceCatalogOwnerEvents(ownerId, limit = 50) {
    return clone((this.sourceCatalogOwnerEvents.get(ownerId) || [])
      .slice()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit))
  }

  #appendSourceCatalogOwnerEvent(ownerId, event) {
    const events = this.sourceCatalogOwnerEvents.get(ownerId) || []
    events.push({ id: randomUUID(), ownerId, createdAt: nowIso(), ...clone(event) })
    this.sourceCatalogOwnerEvents.set(ownerId, events)
  }

  #sourceCatalogTermView(term) {
    return term ? { ...clone(term), usageCount: this.#sourceCatalogTermUsage(term) } : null
  }

  async listSourceCatalogTerms({ includeArchived = false, kind = null } = {}) {
    return [...this.sourceCatalogTerms.values()]
      .filter((term) => (includeArchived || !term.archivedAt) && (!kind || term.kind === kind))
      .sort((left, right) => (
        left.kind.localeCompare(right.kind)
          || left.sortOrder - right.sortOrder
          || left.displayName.localeCompare(right.displayName, 'zh-CN')
      ))
      .map((term) => this.#sourceCatalogTermView(term))
  }

  async getSourceCatalogTerm(id) {
    return this.#sourceCatalogTermView(this.sourceCatalogTerms.get(id))
  }

  async createSourceCatalogTerm(input, { actor = 'admin-token' } = {}) {
    if ([...this.sourceCatalogTerms.values()].some((term) => (
      term.kind === input.kind && term.normalizedName === input.normalizedName
    ))) {
      throw new AppError(409, 'source_catalog_term_exists', 'A taxonomy term with this name already exists')
    }
    const createdAt = nowIso()
    const term = {
      id: randomUUID(),
      ...clone(input),
      revision: 1,
      archivedAt: null,
      createdAt,
      updatedAt: createdAt,
    }
    this.sourceCatalogTerms.set(term.id, term)
    this.#appendSourceCatalogTermEvent(term.id, {
      eventType: 'create', actor, fromRevision: null, toRevision: 1,
      changes: { after: clone(term) },
    })
    return this.#sourceCatalogTermView(term)
  }

  async updateSourceCatalogTerm(id, patch, {
    expectedRevision,
    actor = 'admin-token',
    eventType = 'update',
  } = {}) {
    const term = this.sourceCatalogTerms.get(id)
    if (!term) throw new AppError(404, 'source_catalog_term_not_found', 'Source catalog taxonomy term was not found')
    if (term.revision !== expectedRevision) {
      throw new AppError(409, 'source_catalog_term_revision_conflict', 'Taxonomy term changed; reload before saving', {
        expectedRevision,
        currentRevision: term.revision,
      })
    }
    if (patch.normalizedName && patch.normalizedName !== term.normalizedName) {
      const usageCount = this.#sourceCatalogTermUsage(term)
      if (usageCount > 0) {
        throw new AppError(409, 'source_catalog_term_in_use', 'Referenced taxonomy terms cannot be renamed', {
          usageCount,
        })
      }
      if ([...this.sourceCatalogTerms.values()].some((candidate) => (
        candidate.id !== id
          && candidate.kind === term.kind
          && candidate.normalizedName === patch.normalizedName
      ))) {
        throw new AppError(409, 'source_catalog_term_exists', 'A taxonomy term with this name already exists')
      }
    }
    const before = clone(term)
    Object.assign(term, clone(patch), {
      revision: term.revision + 1,
      updatedAt: nowIso(),
    })
    this.#appendSourceCatalogTermEvent(id, {
      eventType,
      actor,
      fromRevision: before.revision,
      toRevision: term.revision,
      changes: { before, after: clone(term) },
    })
    return this.#sourceCatalogTermView(term)
  }

  async archiveSourceCatalogTerm(id, options = {}) {
    const term = this.sourceCatalogTerms.get(id)
    if (!term) throw new AppError(404, 'source_catalog_term_not_found', 'Source catalog taxonomy term was not found')
    const usageCount = this.#sourceCatalogTermUsage(term)
    if (usageCount > 0) {
      throw new AppError(409, 'source_catalog_term_in_use', 'Referenced taxonomy terms cannot be archived', {
        usageCount,
      })
    }
    return this.updateSourceCatalogTerm(id, { archivedAt: nowIso() }, {
      ...options,
      eventType: 'archive',
    })
  }

  async restoreSourceCatalogTerm(id, options = {}) {
    return this.updateSourceCatalogTerm(id, { archivedAt: null }, {
      ...options,
      eventType: 'restore',
    })
  }

  async listSourceCatalogTermEvents(termId, limit = 50) {
    return clone((this.sourceCatalogTermEvents.get(termId) || [])
      .slice()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit))
  }

  #appendSourceCatalogTermEvent(termId, event) {
    const events = this.sourceCatalogTermEvents.get(termId) || []
    events.push({ id: randomUUID(), termId, createdAt: nowIso(), ...clone(event) })
    this.sourceCatalogTermEvents.set(termId, events)
  }

  async sourceCatalogRelatedData(entry, { pageSize = 20 } = {}) {
    const matchKeys = [...new Set([entry.canonicalName, ...(entry.aliases || [])]
      .map(sourceCatalogTermNormalizedName)
      .filter(Boolean))]
    const matches = (value) => matchKeys.includes(sourceCatalogTermNormalizedName(value))
    const marketplaceEntryId = (record) => (
      record?.stableFields?.commerce?.marketplace?.entryId
      ?? record?.stable_fields?.commerce?.marketplace?.entryId
      ?? null
    )
    const records = [...this.canonicalRecords.values()]
      .filter((record) => matches(record.platform) || marketplaceEntryId(record) === entry.id)
      .sort((left, right) => String(
        right.eventTime || right.collectedAt || right.lastSeenAt || right.firstSeenAt || '',
      ).localeCompare(String(
        left.eventTime || left.collectedAt || left.lastSeenAt || left.firstSeenAt || '',
      )))
    const recordIds = new Set(records.filter((record) => !record.deletedAt).map((record) => record.id))
    const chunks = [...this.recordChunks.values()].filter((chunk) => recordIds.has(chunk.recordId))
    const hasActiveMarketplaceRecord = records.some((record) => (
      !record.deletedAt && marketplaceEntryId(record) === entry.id
    ))
    const externalSources = [...this.externalSources.values()]
      .filter((source) => (
        matches(source.platform)
        || (source.sourceKey === 'mobile-commerce-collected-items' && hasActiveMarketplaceRecord)
      ))
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .map((source) => ({
        id: source.id,
        sourceKey: source.sourceKey,
        displayName: source.displayName,
        sourceKind: source.sourceKind,
        datasetId: source.datasetId,
        platform: source.platform,
        objectType: source.objectType,
        status: source.status,
        syncIntervalSeconds: source.syncIntervalSeconds,
        createdAt: source.createdAt,
        updatedAt: source.updatedAt,
      }))
    const datasets = new Map()
    for (const record of records) {
      const current = datasets.get(record.datasetId) || {
        datasetId: record.datasetId,
        platforms: new Set(),
        objectTypes: new Set(),
        contentTypes: new Set(),
        activeRecordCount: 0,
        deletedRecordCount: 0,
        revisionCount: 0,
        lastCollectedAt: null,
        lastEventAt: null,
        chunkCount: 0,
        projectedChunkCount: 0,
      }
      current.platforms.add(record.platform)
      current.objectTypes.add(record.objectType)
      if (record.contentType) current.contentTypes.add(record.contentType)
      if (record.deletedAt) current.deletedRecordCount += 1
      else current.activeRecordCount += 1
      current.revisionCount += Number(record.currentRevision || 1)
      if (record.collectedAt && (!current.lastCollectedAt || record.collectedAt > current.lastCollectedAt)) {
        current.lastCollectedAt = record.collectedAt
      }
      if (record.eventTime && (!current.lastEventAt || record.eventTime > current.lastEventAt)) {
        current.lastEventAt = record.eventTime
      }
      datasets.set(record.datasetId, current)
    }
    for (const chunk of chunks) {
      const record = this.canonicalRecords.get(chunk.recordId)
      const dataset = record && datasets.get(record.datasetId)
      if (!dataset) continue
      dataset.chunkCount += 1
      if (chunk.projectedAt) dataset.projectedChunkCount += 1
    }
    const datasetRows = [...datasets.values()].map((dataset) => ({
      ...dataset,
      platforms: [...dataset.platforms].sort(),
      objectTypes: [...dataset.objectTypes].sort(),
      contentTypes: [...dataset.contentTypes].sort(),
    })).sort((left, right) => left.datasetId.localeCompare(right.datasetId))
    const activeRecordCount = records.filter((record) => !record.deletedAt).length
    const embeddedChunkCount = chunks.filter((chunk) => chunk.embeddedAt).length
    const projectedChunkCount = chunks.filter((chunk) => chunk.projectedAt).length
    const recordsWithChunks = new Set(chunks.map((chunk) => chunk.recordId)).size
    const projectionState = activeRecordCount === 0
      ? 'empty'
      : projectedChunkCount === 0
        ? 'not_indexed'
        : projectedChunkCount < chunks.length
          ? 'partial'
          : 'ready'
    return {
      entry: {
        id: entry.id,
        sourceKey: entry.sourceKey,
        canonicalName: entry.canonicalName,
        aliases: entry.aliases || [],
        archivedAt: entry.archivedAt,
        revision: entry.revision,
      },
      matchKeys: [entry.canonicalName, ...(entry.aliases || [])],
      stats: {
        datasetCount: datasetRows.length,
        externalSourceCount: externalSources.length,
        recordCount: records.length,
        activeRecordCount,
        deletedRecordCount: records.length - activeRecordCount,
        revisionCount: records.reduce((total, record) => total + Number(record.currentRevision || 1), 0),
        chunkCount: chunks.length,
        embeddedChunkCount,
        projectedChunkCount,
      },
      datasets: datasetRows,
      externalSources: clone(externalSources),
      recentRecords: records.slice(0, pageSize).map(safeSourceCatalogRecord),
      searchProjection: {
        state: projectionState,
        recordCount: activeRecordCount,
        recordsWithChunks,
        chunkCount: chunks.length,
        embeddedChunkCount,
        projectedChunkCount,
      },
      pageSize,
      hasMore: records.length > pageSize,
    }
  }

  async listFileFormatRules() {
    return []
  }

  async findApprovedFileFormatRuleByKey() {
    return null
  }

  // Authoritative ingestion needs PostgreSQL transactions and uniqueness, so
  // the in-memory store deliberately does not persist canonical data. It
  // reports nothing ingested rather than pretending to store it, keeping local
  // and test runs working without implying a second source of truth.
  async ingestSearchResult() {
    return { ingested: 0, changed: 0, skipped: 0, runId: null }
  }

  // ---- federated identity ------------------------------------------------
  //
  // Unlike ingestion, identity IS implemented here. Local development and the
  // test suite need to exercise sign-in, scoping and membership without a
  // database, and an identity model that only works against PostgreSQL would go
  // untested until deployment.

  #memberByBinding = new Map()
  #members = new Map()
  #memberships = new Map()
  #platformAdmins = new Set()

  async upsertExternalIdentity({ issuer, subject, audience, displayName, ...rest }) {
    const bindingKey = `${issuer}\u0000${subject}\u0000${audience}`
    const existingId = this.#memberByBinding.get(bindingKey)
    if (existingId) {
      const member = this.#members.get(existingId)
      if (displayName) member.displayName = displayName
      return { ...member }
    }
    const member = {
      id: randomUUID(),
      displayName: displayName || subject,
      status: 'active',
      binding: { issuer, subject, audience, ...rest },
    }
    this.#members.set(member.id, member)
    this.#memberByBinding.set(bindingKey, member.id)
    return { ...member }
  }

  async syncPlatformAdmin(memberId, { granted }) {
    if (granted) this.#platformAdmins.add(memberId)
    else this.#platformAdmins.delete(memberId)
    return granted
  }

  async listTenantMemberships(memberId) {
    return [...(this.#memberships.get(memberId) || new Map()).values()].map((membership) => ({
      ...membership,
      tenantName: this.tenants.get(membership.tenantId)?.name ?? null,
    }))
  }

  async listMembers() {
    return [...this.#members.values()].map((member) => ({
      id: member.id,
      displayName: member.displayName,
      status: member.status,
      platformAdmin: this.#platformAdmins.has(member.id),
      memberships: [...(this.#memberships.get(member.id) || new Map()).values()],
    }))
  }

  async grantTenantMembership({ memberId, tenantId, role }) {
    if (!this.#members.has(memberId)) {
      throw new AppError(404, 'member_not_found', 'Member not found')
    }
    if (!this.tenants.has(tenantId)) {
      throw new AppError(404, 'tenant_not_found', 'Tenant not found')
    }
    const forMember = this.#memberships.get(memberId) || new Map()
    const membership = { id: randomUUID(), memberId, tenantId, role, status: 'active' }
    forMember.set(tenantId, membership)
    this.#memberships.set(memberId, forMember)
    return { ...membership }
  }

  async revokeTenantMembership({ memberId, tenantId }) {
    const membership = this.#memberships.get(memberId)?.get(tenantId)
    if (!membership) throw new AppError(404, 'membership_not_found', 'Membership not found')
    membership.status = 'suspended'
    return { memberId, tenantId, status: 'suspended' }
  }
}

function summarizeUsage(records) {
  const byPlatform = {}
  const byCapability = {}
  let latencyTotal = 0
  let latencyCount = 0
  for (const record of records) {
    const bucket = record.capability ? byCapability : byPlatform
    const scope = record.capability || record.platform
    const entry = (bucket[scope] ||= {
      requests: 0,
      committed: 0,
      released: 0,
      unknown: 0,
      units: 0,
    })
    entry.requests += 1
    if (record.status in entry) entry[record.status] += 1
    if (record.status === 'committed') entry.units += record.unitsActual || 0
    if (record.upstreamLatencyMs != null) {
      latencyTotal += record.upstreamLatencyMs
      latencyCount += 1
    }
  }
  return {
    requests: records.length,
    committed: records.filter((record) => record.status === 'committed').length,
    released: records.filter((record) => record.status === 'released').length,
    unknown: records.filter((record) => record.status === 'unknown').length,
    units: records.reduce(
      (total, record) => total + (record.status === 'committed' ? record.unitsActual || 0 : 0),
      0,
    ),
    averageUpstreamLatencyMs: latencyCount ? Math.round(latencyTotal / latencyCount) : null,
    byPlatform,
    byCapability,
  }
}
