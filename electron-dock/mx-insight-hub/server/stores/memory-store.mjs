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

export class MemoryStore {
  constructor() {
    this.tenants = new Map()
    this.consumers = new Map()
    this.apiKeys = new Map()
    this.apiKeysByDigest = new Map()
    this.grants = new Map()
    this.policies = new Map()
    this.requests = new Map()
    this.requestsByScope = new Map()
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

  async createConsumer({ tenantId, name, status = 'active', businessId }) {
    if (!this.tenants.has(tenantId)) throw new AppError(404, 'tenant_not_found', 'Tenant not found')
    const id = randomUUID()
    const record = {
      id,
      tenantId,
      name,
      status,
      businessId: businessId || `mxih:${tenantId}:${id}`,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    this.consumers.set(id, record)
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

  async createApiKey({ id, tenantId, consumerId, name, digest, prefix, lastFour, environment = 'live', status = 'active' }) {
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
      revokedAt: null,
      lastUsedAt: null,
    }
    this.apiKeys.set(id, record)
    this.apiKeysByDigest.set(digest, id)
    return this.#publicApiKey(record)
  }

  #publicApiKey(record) {
    const { digest: _digest, ...safe } = record
    return clone(safe)
  }

  async listApiKeys(consumerId) {
    return [...this.apiKeys.values()]
      .filter((record) => !consumerId || record.consumerId === consumerId)
      .map((record) => this.#publicApiKey(record))
  }

  async findApiKeyByDigest(digest) {
    const key = this.apiKeys.get(this.apiKeysByDigest.get(digest))
    if (!active(key)) return null
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

  async listGrants(consumerId) {
    return clone(this.grants.get(consumerId) || [])
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

  async reserve({
    requestId,
    idempotencyKey,
    fingerprint,
    tenantId,
    consumerId,
    apiKeyId,
    platform,
    unitsReserved,
    leaseExpiresAt,
    windowStart,
    maxRequests,
  }) {
    const scopeKey = `${consumerId}:${idempotencyKey}`
    const existingId = this.requestsByScope.get(scopeKey)
    if (existingId) {
      const existing = this.requests.get(existingId)
      if (existing.fingerprint !== fingerprint) return { kind: 'conflict', request: clone(existing) }
      if (existing.status === 'committed') return { kind: 'replay', request: clone(existing) }
      if (existing.status === 'reserved') return { kind: 'in_progress', request: clone(existing) }
      if (existing.status === 'unknown') return { kind: 'unknown', request: clone(existing) }
      if (existing.status === 'released') {
        this.#assertQuota({ tenantId, consumerId, platform, windowStart, maxRequests })
        Object.assign(existing, {
          status: 'reserved',
          unitsReserved,
          reservedAt: nowIso(),
          leaseExpiresAt: new Date(leaseExpiresAt).toISOString(),
          completedAt: null,
          errorCode: null,
        })
        return { kind: 'reserved', request: clone(existing) }
      }
    }

    this.#assertQuota({ tenantId, consumerId, platform, windowStart, maxRequests })
    const record = {
      id: requestId,
      tenantId,
      consumerId,
      apiKeyId,
      idempotencyKey,
      fingerprint,
      platform,
      status: 'reserved',
      unitsReserved,
      unitsActual: null,
      responseStatus: null,
      responseBody: null,
      errorCode: null,
      upstreamLatencyMs: null,
      reservedAt: nowIso(),
      leaseExpiresAt: new Date(leaseExpiresAt).toISOString(),
      completedAt: null,
      createdAt: nowIso(),
    }
    this.requests.set(record.id, record)
    this.requestsByScope.set(scopeKey, record.id)
    return { kind: 'reserved', request: clone(record) }
  }

  #assertQuota({ tenantId, consumerId, platform, windowStart, maxRequests }) {
    if (!Number.isFinite(maxRequests)) return
    const count = [...this.requests.values()].filter(
      (record) =>
        record.tenantId === tenantId &&
        record.consumerId === consumerId &&
        record.platform === platform &&
        ['reserved', 'committed', 'unknown'].includes(record.status) &&
        new Date(record.reservedAt) >= windowStart,
    ).length
    if (count >= maxRequests) {
      throw new AppError(429, 'quota_exceeded', 'Request quota exceeded', {
        platform,
        maxRequests,
      })
    }
  }

  async commitRequest(id, { responseStatus, responseBody, unitsActual, upstreamLatencyMs }) {
    const record = this.#request(id)
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

  async releaseRequest(id, errorCode) {
    const record = this.#request(id)
    Object.assign(record, { status: 'released', errorCode, completedAt: nowIso() })
    return clone(record)
  }

  async markRequestUnknown(id, errorCode) {
    const record = this.#request(id)
    Object.assign(record, { status: 'unknown', errorCode, completedAt: nowIso() })
    return clone(record)
  }

  #request(id) {
    const record = this.requests.get(id)
    if (!record) throw new AppError(404, 'request_not_found', 'Request not found')
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
      activeApiKeys: [...this.apiKeys.values()].filter(active).length,
      ...usage,
    }
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
  let latencyTotal = 0
  let latencyCount = 0
  for (const record of records) {
    const entry = (byPlatform[record.platform] ||= {
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
  }
}
