import { randomUUID } from 'node:crypto'
import { hmacSecret, issueApiKey, requestFingerprint } from './core/crypto.mjs'
import { AppError, UpstreamAmbiguousError, UpstreamRejectedError, assert } from './core/errors.mjs'
import {
  normalizeTelegramMonitorQuery,
  normalizeTelegramEntityQuery,
  normalizeTelegramSearchQuery,
  publicTelegramMonitorPage,
  telegramDataSearchResponse,
  telegramMonitorResource,
} from './data/telegram-monitor.mjs'
import {
  canonicalSearchResponse,
  normalizeCanonicalSearchQuery,
  normalizeStoredSearchQuery,
  storedSearchResponse,
} from './data/stored-search.mjs'

const DEFAULT_POLICY = Object.freeze({
  maxRequests: 1_000,
  windowSeconds: 3_600,
  maxPageSize: 100,
})
const DEFAULT_API_KEY_LIFETIME_DAYS = 180
const MAX_API_KEY_LIFETIME_DAYS = 730

const PLATFORM_ALIASES = new Map([
  ['red', 'xiaohongshu'],
  ['rednote', 'xiaohongshu'],
  ['xhs', 'xiaohongshu'],
])
const PUBLIC_SEARCH_FIELDS = new Set(['platform', 'query', 'pageSize', 'cursor'])
const RESERVED_PLATFORM_NAMES = new Set(['*', 'all'])
const PUBLIC_CAPABILITIES = new Set(['nlp.tokenize'])
const TOKENIZE_CAPABILITY = 'nlp.tokenize'
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
    return {
      grants: normalizedConsumerId ? await this.store.listGrants(normalizedConsumerId) : [],
      policies: normalizedConsumerId ? await this.store.listPolicies(normalizedConsumerId) : [],
      capabilityGrants: normalizedConsumerId && typeof this.store.listCapabilityGrants === 'function'
        ? await this.store.listCapabilityGrants(normalizedConsumerId)
        : [],
      capabilityPolicies: normalizedConsumerId && typeof this.store.listCapabilityPolicies === 'function'
        ? await this.store.listCapabilityPolicies(normalizedConsumerId)
        : [],
      availableCapabilities: [{
        capability: TOKENIZE_CAPABILITY,
        ready: typeof this.segmenter?.segmentWithMeta === 'function',
      }],
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
    const payload = grants.length > 0
      ? await this.adapter.capabilities(grants)
      : { data: { platforms: [] } }
    if (grants.includes('telegram') && typeof this.store.listCanonicalRecords === 'function') {
      const platforms = payload?.data?.platforms
      if (Array.isArray(platforms) && !platforms.some((entry) => (entry?.platform || entry) === 'telegram')) {
        platforms.push({
          platform: 'telegram',
          ready: true,
          capabilities: ['monitor_chats', 'monitor_messages', 'stored_search', 'entity_search'],
        })
      }
    }
    const capabilityGrants = typeof this.store.listCapabilityGrants === 'function'
      ? await this.store.listCapabilityGrants(context.consumer.id)
      : []
    return {
      ...payload,
      data: {
        ...(payload?.data || {}),
        capabilities: capabilityGrants
          .filter((capability) => PUBLIC_CAPABILITIES.has(capability))
          .map((capability) => ({
            capability,
            ready: capability === TOKENIZE_CAPABILITY
              && typeof this.segmenter?.segmentWithMeta === 'function',
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

  async telegramMonitor(context, resourceName, queryInput) {
    if (typeof this.store.listCanonicalRecords !== 'function') {
      throw new AppError(503, 'stored_data_unavailable', 'Stored Telegram data requires the PostgreSQL store')
    }
    const policy = await this.#telegramPolicy(context)
    const resource = telegramMonitorResource(resourceName)
    const query = normalizeTelegramMonitorQuery(queryInput, policy.maxPageSize)
    return this.#meterStoredTelegramRead(context, policy, {
      path: `/api/v1/data/telegram/${resourceName}`,
      fingerprintBody: query,
      operation: async () => {
      const rows = await this.store.listCanonicalRecords({
        ...resource,
        platform: 'telegram',
        ...query,
      })
        return publicTelegramMonitorPage(rows, query.pageSize)
      },
    })
  }

  async telegramEntities(context, queryInput) {
    if (!this.searchQueries?.searchAuthors || !this.searchQueries?.searchTelegramChats) {
      throw new AppError(503, 'stored_search_unavailable', 'Telegram entity search requires the PostgreSQL search layer')
    }
    const policy = await this.#telegramPolicy(context)
    const query = normalizeTelegramEntityQuery(queryInput, policy.maxPageSize)
    return this.#meterStoredTelegramRead(context, policy, {
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
    const fingerprintBody = {
      query: query.query,
      platform: query.platform,
      datasetId: query.datasetId,
      objectType: query.objectType,
      pageSize: query.pageSize,
      cursor: query.cursorToken,
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
    const fingerprintBody = {
      query: query.query,
      platform: query.platform,
      platforms: query.platforms,
      datasetId: query.datasetId,
      objectType: query.objectType,
      pageSize: query.pageSize,
      searchProfile: query.searchProfile,
      cursor: query.cursorToken,
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
        platforms: query.platforms,
        datasetId: query.datasetId,
        objectType: query.objectType,
        size: query.pageSize,
        cursor: query.cursor,
        searchProfile: query.searchProfile,
        trackTotalHits: true,
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

  async #telegramPolicy(context) {
    const grants = await this.store.listGrants(context.consumer.id)
    assert(grants.includes('telegram'), 403, 'platform_not_granted', 'Telegram is not granted')
    return {
      ...this.defaultPolicy,
      ...((await this.store.getPolicy(context.consumer.id, 'telegram')) || {}),
    }
  }

  async #meterStoredTelegramRead(context, policy, { path, fingerprintBody, operation }) {
    const requestId = randomUUID()
    const startedAt = performance.now()
    const windowStart = new Date(Date.now() - policy.windowSeconds * 1_000)
    await this.store.reapStaleReservations()
    const reservation = await this.store.reserve({
      requestId,
      idempotencyKey: `telegram-read:${requestId}`,
      fingerprint: requestFingerprint({ method: 'GET', path, body: fingerprintBody }),
      tenantId: context.tenant.id,
      consumerId: context.consumer.id,
      apiKeyId: context.apiKey.id,
      platform: 'telegram',
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
        unitsActual: Math.max(1, payload.pageInfo?.returnedCount ?? payload.items?.length ?? 0),
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
      reservedAt: record.reservedAt,
      completedAt: record.completedAt,
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
    const fingerprint = requestFingerprint({
      method: 'POST',
      path,
      body: telegramQuery ?? upstreamBody,
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
    const datasets = {
      messages: ['telegram.monitor.messages.v1'],
      chats: ['telegram.monitor.chats.v1'],
      all: ['telegram.monitor.messages.v1', 'telegram.monitor.chats.v1'],
    }[query.scope]
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
