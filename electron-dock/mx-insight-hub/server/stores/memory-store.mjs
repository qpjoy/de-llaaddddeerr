import { randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'

function nowIso() {
  return new Date().toISOString()
}

function clone(value) {
  return value == null ? value : structuredClone(value)
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

  async createExternalSource({
    sourceKey,
    displayName,
    sourceKind,
    datasetId,
    platform,
    objectType,
    status = 'active',
    connection = {},
    syncIntervalSeconds = 60,
  }) {
    if (this.externalSources.has(sourceKey)) {
      throw new AppError(409, 'source_exists', `Source key already exists: ${sourceKey}`)
    }
    const createdAt = nowIso()
    const source = {
      id: randomUUID(), sourceKey, displayName, sourceKind, datasetId, platform,
      objectType: objectType || 'record', status, connection,
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
    const bindingKey = `${issuer} ${subject} ${audience}`
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
