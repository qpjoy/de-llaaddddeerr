import { randomUUID } from 'node:crypto'
import { hmacSecret, issueApiKey, requestFingerprint } from './core/crypto.mjs'
import { AppError, UpstreamAmbiguousError, UpstreamRejectedError, assert } from './core/errors.mjs'

const DEFAULT_POLICY = Object.freeze({
  maxRequests: 1_000,
  windowSeconds: 3_600,
  maxPageSize: 100,
})

const PLATFORM_ALIASES = new Map([
  ['red', 'xiaohongshu'],
  ['rednote', 'xiaohongshu'],
  ['xhs', 'xiaohongshu'],
])
const PUBLIC_SEARCH_FIELDS = new Set(['platform', 'query', 'pageSize', 'cursor'])
const RESERVED_PLATFORM_NAMES = new Set(['*', 'all'])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function canonicalPlatform(value) {
  const platform = requiredString(value, 'platform').toLowerCase()
  return PLATFORM_ALIASES.get(platform) || platform
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

export class HubService {
  constructor({ store, adapter, apiKeyPepper, defaultPolicy = DEFAULT_POLICY, reservationLeaseMs = 120_000 }) {
    this.store = store
    this.adapter = adapter
    this.apiKeyPepper = apiKeyPepper
    this.defaultPolicy = defaultPolicy
    this.reservationLeaseMs = reservationLeaseMs
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

  async createConsumer(body) {
    const tenantId = requiredUuid(body.tenantId, 'tenantId')
    assert(await this.store.getTenant(tenantId), 404, 'tenant_not_found', 'Tenant not found')
    return this.store.createConsumer({
      tenantId,
      name: requiredString(body.name, 'name'),
      status: validateStatus(body.status),
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
    const issued = issueApiKey(this.apiKeyPepper, environment)
    const record = await this.store.createApiKey({
      ...issued,
      environment,
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
    assert(context, 401, 'invalid_api_key', 'API key is invalid or revoked')
    return context
  }

  async getPlatformConfiguration({ tenantId, consumerId }) {
    const normalizedTenantId = optionalUuid(tenantId, 'tenantId')
    const normalizedConsumerId = optionalUuid(consumerId, 'consumerId')
    return {
      grants: normalizedConsumerId ? await this.store.listGrants(normalizedConsumerId) : [],
      policies: normalizedConsumerId ? await this.store.listPolicies(normalizedConsumerId) : [],
    }
  }

  async putPlatformConfiguration(platformParam, body) {
    const platform = canonicalPlatform(platformParam)
    assert(!RESERVED_PLATFORM_NAMES.has(platform), 400, 'invalid_platform', 'Wildcard platform grants are not allowed')
    const tenantId = requiredUuid(body.tenantId, 'tenantId')
    const consumerId = requiredUuid(body.consumerId, 'consumerId')
    const consumer = await this.store.getConsumer(consumerId)
    assert(consumer?.tenantId === tenantId, 404, 'consumer_not_found', 'Consumer not found in tenant')

    const grants = new Set(await this.store.listGrants(consumerId))
    if (body.enabled === false) grants.delete(platform)
    else grants.add(platform)
    const savedGrants = await this.store.replaceGrants(consumerId, [...grants])

    const current = (await this.store.getPolicy(consumerId, platform)) || this.defaultPolicy
    const policy = await this.store.putPolicy({
      tenantId,
      consumerId,
      platform,
      maxRequests: positiveInteger(body.maxRequests, 'maxRequests', current.maxRequests),
      windowSeconds: positiveInteger(body.windowSeconds, 'windowSeconds', current.windowSeconds),
      maxPageSize: positiveInteger(body.maxPageSize, 'maxPageSize', current.maxPageSize),
    })
    return { platform, enabled: savedGrants.includes(platform), policy }
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
    return this.adapter.capabilities(grants)
  }

  async publicUsage(context, filters) {
    await this.store.reapStaleReservations()
    return this.store.usage(usageFilters({
      ...filters,
      tenantId: context.tenant.id,
      consumerId: context.consumer.id,
    }))
  }

  async requestStatus(context, requestId) {
    await this.store.reapStaleReservations()
    const record = await this.store.getRequest(requiredUuid(requestId, 'requestId'), context.consumer.id)
    assert(record, 404, 'request_not_found', 'Request not found')
    return {
      id: record.id,
      status: record.status,
      platform: record.platform,
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
    const unsupportedFields = Object.keys(body).filter((field) => !PUBLIC_SEARCH_FIELDS.has(field))
    assert(
      unsupportedFields.length === 0,
      400,
      'unsupported_fields',
      `Unsupported public fields: ${unsupportedFields.join(', ')}`,
    )
    const platform = canonicalPlatform(body.platform)
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
      assert(cursor.length <= 1024, 400, 'invalid_cursor', 'cursor is too long')
    }
    const upstreamBody = {
      platform,
      query,
      pageSize,
      ...(cursor ? { cursor } : {}),
    }
    const fingerprint = requestFingerprint({ method: 'POST', path, body: upstreamBody })
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
    try {
      const responseBody = await this.adapter.search({
        body: upstreamBody,
        businessId: context.consumer.businessId,
      })
      const itemCount = Array.isArray(responseBody?.data?.items) ? responseBody.data.items.length : 0
      await this.store.commitRequest(activeRequestId, {
        responseStatus: 200,
        responseBody,
        unitsActual: Math.max(1, itemCount),
        upstreamLatencyMs: Math.round(performance.now() - startedAt),
      })
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
      await this.store.releaseRequest(activeRequestId, 'internal_error')
      throw error
    }
  }
}
