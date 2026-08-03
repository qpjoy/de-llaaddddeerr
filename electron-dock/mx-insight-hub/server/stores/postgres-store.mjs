import { randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'

function iso(value) {
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function tenant(row) {
  return row && {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function consumer(row) {
  return row && {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    status: row.status,
    businessId: row.business_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function apiKey(row) {
  return row && {
    id: row.id,
    tenantId: row.tenant_id,
    consumerId: row.consumer_id,
    name: row.name,
    prefix: row.key_prefix,
    lastFour: row.last_four,
    environment: row.environment,
    status: row.status,
    createdAt: iso(row.created_at),
    revokedAt: iso(row.revoked_at),
    lastUsedAt: iso(row.last_used_at),
  }
}

function requestRecord(row) {
  return row && {
    id: row.id,
    tenantId: row.tenant_id,
    consumerId: row.consumer_id,
    apiKeyId: row.api_key_id,
    idempotencyKey: row.idempotency_key,
    fingerprint: row.fingerprint,
    platform: row.platform,
    status: row.status,
    unitsReserved: row.units_reserved,
    unitsActual: row.units_actual,
    responseStatus: row.response_status,
    responseBody: row.response_body,
    errorCode: row.error_code,
    upstreamLatencyMs: row.upstream_latency_ms,
    reservedAt: iso(row.reserved_at),
    leaseExpiresAt: iso(row.lease_expires_at),
    completedAt: iso(row.completed_at),
    createdAt: iso(row.created_at),
  }
}

function policy(row) {
  return row && {
    tenantId: row.tenant_id,
    consumerId: row.consumer_id,
    platform: row.platform,
    maxRequests: row.max_requests,
    windowSeconds: row.window_seconds,
    maxPageSize: row.max_page_size,
    updatedAt: iso(row.updated_at),
  }
}

export class PostgresStore {
  constructor(pool) {
    this.pool = pool
  }

  async close() {
    await this.pool.end()
  }

  async ping() {
    await this.pool.query('SELECT 1')
    return true
  }

  async reapStaleReservations() {
    const { rowCount } = await this.pool.query(
      `UPDATE usage_requests SET
         status = 'unknown', error_code = 'reservation_lease_expired', completed_at = now()
       WHERE status = 'reserved' AND lease_expires_at IS NOT NULL AND lease_expires_at <= now()`,
    )
    return rowCount || 0
  }

  async createTenant({ name, status = 'active' }) {
    const { rows } = await this.pool.query(
      `INSERT INTO tenants (id, name, status) VALUES ($1, $2, $3) RETURNING *`,
      [randomUUID(), name, status],
    )
    return tenant(rows[0])
  }

  async listTenants() {
    const { rows } = await this.pool.query('SELECT * FROM tenants ORDER BY created_at DESC')
    return rows.map(tenant)
  }

  async getTenant(id) {
    const { rows } = await this.pool.query('SELECT * FROM tenants WHERE id = $1', [id])
    return tenant(rows[0]) || null
  }

  async createConsumer({ tenantId, name, status = 'active', businessId }) {
    const id = randomUUID()
    const { rows } = await this.pool.query(
      `INSERT INTO consumers (id, tenant_id, name, status, business_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, tenantId, name, status, businessId || `mxih:${tenantId}:${id}`],
    )
    return consumer(rows[0])
  }

  async listConsumers(tenantId) {
    const { rows } = tenantId
      ? await this.pool.query('SELECT * FROM consumers WHERE tenant_id = $1 ORDER BY created_at DESC', [tenantId])
      : await this.pool.query('SELECT * FROM consumers ORDER BY created_at DESC')
    return rows.map(consumer)
  }

  async getConsumer(id) {
    const { rows } = await this.pool.query('SELECT * FROM consumers WHERE id = $1', [id])
    return consumer(rows[0]) || null
  }

  async createApiKey({ id, tenantId, consumerId, name, digest, prefix, lastFour, environment = 'live', status = 'active' }) {
    const { rows } = await this.pool.query(
      `INSERT INTO api_keys
         (id, tenant_id, consumer_id, name, key_digest, key_prefix, last_four, environment, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [id, tenantId, consumerId, name, digest, prefix, lastFour, environment, status],
    )
    return apiKey(rows[0])
  }

  async listApiKeys(consumerId) {
    const { rows } = consumerId
      ? await this.pool.query('SELECT * FROM api_keys WHERE consumer_id = $1 ORDER BY created_at DESC', [consumerId])
      : await this.pool.query('SELECT * FROM api_keys ORDER BY created_at DESC')
    return rows.map(apiKey)
  }

  async findApiKeyByDigest(digest) {
    const { rows } = await this.pool.query(
      `SELECT
         k.*,
         row_to_json(c) AS consumer_record,
         row_to_json(t) AS tenant_record
       FROM api_keys k
       JOIN consumers c ON c.id = k.consumer_id AND c.status = 'active'
       JOIN tenants t ON t.id = k.tenant_id AND t.status = 'active'
       WHERE k.key_digest = $1 AND k.status = 'active'`,
      [digest],
    )
    if (!rows[0]) return null
    await this.pool.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [rows[0].id])
    return {
      apiKey: apiKey(rows[0]),
      consumer: consumer(rows[0].consumer_record),
      tenant: tenant(rows[0].tenant_record),
    }
  }

  async revokeApiKey(id) {
    const { rows } = await this.pool.query(
      `UPDATE api_keys SET status = 'revoked', revoked_at = now()
       WHERE id = $1 RETURNING *`,
      [id],
    )
    if (!rows[0]) throw new AppError(404, 'api_key_not_found', 'API key not found')
    return apiKey(rows[0])
  }

  async replaceGrants(consumerId, platforms) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM platform_grants WHERE consumer_id = $1', [consumerId])
      for (const platformName of [...new Set(platforms)]) {
        await client.query(
          'INSERT INTO platform_grants (consumer_id, platform) VALUES ($1, $2)',
          [consumerId, platformName],
        )
      }
      await client.query('COMMIT')
      return [...new Set(platforms)].sort()
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async listGrants(consumerId) {
    const { rows } = await this.pool.query(
      'SELECT platform FROM platform_grants WHERE consumer_id = $1 ORDER BY platform',
      [consumerId],
    )
    return rows.map((row) => row.platform)
  }

  async putPolicy({ tenantId, consumerId, platform: platformName, maxRequests, windowSeconds, maxPageSize }) {
    const { rows } = await this.pool.query(
      `INSERT INTO consumer_platform_policies
         (tenant_id, consumer_id, platform, max_requests, window_seconds, max_page_size)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (consumer_id, platform) DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id,
         max_requests = EXCLUDED.max_requests,
         window_seconds = EXCLUDED.window_seconds,
         max_page_size = EXCLUDED.max_page_size,
         updated_at = now()
       RETURNING *`,
      [tenantId, consumerId, platformName, maxRequests, windowSeconds, maxPageSize],
    )
    return policy(rows[0])
  }

  async getPolicy(consumerId, platformName) {
    const { rows } = await this.pool.query(
      'SELECT * FROM consumer_platform_policies WHERE consumer_id = $1 AND platform = $2',
      [consumerId, platformName],
    )
    return policy(rows[0]) || null
  }

  async listPolicies(consumerId) {
    const { rows } = await this.pool.query(
      'SELECT * FROM consumer_platform_policies WHERE consumer_id = $1 ORDER BY platform',
      [consumerId],
    )
    return rows.map(policy)
  }

  async reserve(input) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `${input.tenantId}:${input.consumerId}:${input.platform}`,
      ])
      const { rows } = await client.query(
        `SELECT * FROM usage_requests
         WHERE consumer_id = $1 AND idempotency_key = $2 FOR UPDATE`,
        [input.consumerId, input.idempotencyKey],
      )
      const existing = requestRecord(rows[0])
      if (existing) {
        let kind
        if (existing.fingerprint !== input.fingerprint) kind = 'conflict'
        else if (existing.status === 'committed') kind = 'replay'
        else if (existing.status === 'reserved') kind = 'in_progress'
        else if (existing.status === 'unknown') kind = 'unknown'
        else {
          await this.#assertQuota(client, input)
          const updated = await client.query(
            `UPDATE usage_requests SET
               status = 'reserved', units_reserved = $2, reserved_at = now(),
               lease_expires_at = $3, completed_at = NULL, error_code = NULL
             WHERE id = $1 RETURNING *`,
            [existing.id, input.unitsReserved, input.leaseExpiresAt],
          )
          await client.query('COMMIT')
          return { kind: 'reserved', request: requestRecord(updated.rows[0]) }
        }
        await client.query('COMMIT')
        return { kind, request: existing }
      }

      await this.#assertQuota(client, input)
      const inserted = await client.query(
        `INSERT INTO usage_requests
           (id, tenant_id, consumer_id, api_key_id, idempotency_key, fingerprint,
            platform, status, units_reserved, lease_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'reserved', $8, $9)
         RETURNING *`,
        [
          input.requestId,
          input.tenantId,
          input.consumerId,
          input.apiKeyId,
          input.idempotencyKey,
          input.fingerprint,
          input.platform,
          input.unitsReserved,
          input.leaseExpiresAt,
        ],
      )
      await client.query('COMMIT')
      return { kind: 'reserved', request: requestRecord(inserted.rows[0]) }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async #assertQuota(client, input) {
    const { rows } = await client.query(
      `SELECT count(*)::integer AS count
       FROM usage_requests
       WHERE tenant_id = $1 AND consumer_id = $2 AND platform = $3
         AND status IN ('reserved', 'committed', 'unknown')
         AND reserved_at >= $4`,
      [input.tenantId, input.consumerId, input.platform, input.windowStart],
    )
    if (rows[0].count >= input.maxRequests) {
      throw new AppError(429, 'quota_exceeded', 'Request quota exceeded', {
        platform: input.platform,
        maxRequests: input.maxRequests,
      })
    }
  }

  async commitRequest(id, { responseStatus, responseBody, unitsActual, upstreamLatencyMs }) {
    return this.#updateRequest(
      `UPDATE usage_requests SET
         status = 'committed', response_status = $2, response_body = $3,
         units_actual = $4, upstream_latency_ms = $5, completed_at = now()
       WHERE id = $1 RETURNING *`,
      [id, responseStatus, responseBody, unitsActual, upstreamLatencyMs],
    )
  }

  releaseRequest(id, errorCode) {
    return this.#updateRequest(
      `UPDATE usage_requests SET status = 'released', error_code = $2, completed_at = now()
       WHERE id = $1 RETURNING *`,
      [id, errorCode],
    )
  }

  markRequestUnknown(id, errorCode) {
    return this.#updateRequest(
      `UPDATE usage_requests SET status = 'unknown', error_code = $2, completed_at = now()
       WHERE id = $1 RETURNING *`,
      [id, errorCode],
    )
  }

  async #updateRequest(sql, values) {
    const { rows } = await this.pool.query(sql, values)
    if (!rows[0]) throw new AppError(404, 'request_not_found', 'Request not found')
    return requestRecord(rows[0])
  }

  async getRequest(id, consumerId) {
    const { rows } = await this.pool.query(
      `SELECT * FROM usage_requests
       WHERE id = $1 AND ($2::uuid IS NULL OR consumer_id = $2)`,
      [id, consumerId || null],
    )
    const record = requestRecord(rows[0])
    if (!record) return null
    const { responseBody: _responseBody, fingerprint: _fingerprint, ...safe } = record
    return safe
  }

  async usage(filters = {}) {
    const values = []
    const clauses = []
    for (const [column, value] of [
      ['tenant_id', filters.tenantId],
      ['consumer_id', filters.consumerId],
    ]) {
      if (value) {
        values.push(value)
        clauses.push(`${column} = $${values.length}`)
      }
    }
    if (filters.from) {
      values.push(filters.from)
      clauses.push(`created_at >= $${values.length}`)
    }
    if (filters.to) {
      values.push(filters.to)
      clauses.push(`created_at < $${values.length}`)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const { rows } = await this.pool.query(
      `SELECT
         platform,
         count(*)::integer AS requests,
         count(*) FILTER (WHERE status = 'committed')::integer AS committed,
         count(*) FILTER (WHERE status = 'released')::integer AS released,
         count(*) FILTER (WHERE status = 'unknown')::integer AS unknown,
         coalesce(sum(units_actual) FILTER (WHERE status = 'committed'), 0)::integer AS units,
         round(avg(upstream_latency_ms))::integer AS average_latency
       FROM usage_requests ${where}
       GROUP BY platform`,
      values,
    )
    return summarizeAggregates(rows)
  }

  async dashboard() {
    const [tenantsResult, consumersResult, keysResult, usage] = await Promise.all([
      this.pool.query('SELECT count(*)::integer AS count FROM tenants'),
      this.pool.query('SELECT count(*)::integer AS count FROM consumers'),
      this.pool.query("SELECT count(*)::integer AS count FROM api_keys WHERE status = 'active'"),
      this.usage(),
    ])
    return {
      tenants: tenantsResult.rows[0].count,
      consumers: consumersResult.rows[0].count,
      activeApiKeys: keysResult.rows[0].count,
      ...usage,
    }
  }
}

function summarizeAggregates(rows) {
  const byPlatform = {}
  let requests = 0
  let committed = 0
  let released = 0
  let unknown = 0
  let units = 0
  let weightedLatency = 0
  let latencyRequests = 0
  for (const row of rows) {
    const entry = {
      requests: row.requests,
      committed: row.committed,
      released: row.released,
      unknown: row.unknown,
      units: row.units,
    }
    byPlatform[row.platform] = entry
    requests += row.requests
    committed += row.committed
    released += row.released
    unknown += row.unknown
    units += row.units
    if (row.average_latency != null && row.committed > 0) {
      weightedLatency += row.average_latency * row.committed
      latencyRequests += row.committed
    }
  }
  return {
    requests,
    committed,
    released,
    unknown,
    units,
    averageUpstreamLatencyMs: latencyRequests ? Math.round(weightedLatency / latencyRequests) : null,
    byPlatform,
  }
}

export async function createPostgresStore(options) {
  const { Pool } = await import('pg')
  return new PostgresStore(new Pool(options))
}
