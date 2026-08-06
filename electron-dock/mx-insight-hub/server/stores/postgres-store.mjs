import { randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import {
  CONNECTOR_ID,
  DATASET_ID,
  PARSER_VERSION,
  SCHEMA_VERSION,
  normalizeSearchPayload,
  observationHash,
  streamId,
} from '../ingest/normalizers.mjs'

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

  // Persist an upstream search result as authoritative Hub data.
  //
  // Ordering follows ADR-0006: the ingest run, raw source object, canonical
  // upsert, revision, observation and outbox event all commit together, so a
  // crash can only lose the whole batch and a replay is idempotent:
  //   * unchanged content keeps its revision, writes no new revision row and
  //     enqueues no projection event;
  //   * a repeated batch collides on the observation hash and is ignored;
  //   * changed content bumps current/projection revision and emits one event.
  //
  // `rawPayload` must be the pre-redaction upstream payload: provider and
  // endpoint identifiers are lineage evidence and never reach public responses.
  async ingestSearchResult({ platform, rawPayload, queryFingerprint = null, requestId = null }) {
    const { records, skipped } = normalizeSearchPayload(rawPayload, platform)
    if (records.length === 0) return { ingested: 0, changed: 0, skipped, runId: null }

    const stream = streamId(platform)
    const runId = randomUUID()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO ingest.ingest_runs
           (id, connector_id, stream_id, trigger, request_id, query_fingerprint)
         VALUES ($1, $2, $3, 'api_search', $4, $5)`,
        [runId, CONNECTOR_ID, stream, requestId, queryFingerprint],
      )

      let changed = 0
      for (const record of records) {
        await client.query(
          `INSERT INTO ingest.source_objects
             (id, connector_id, stream_id, object_type, source_key,
              payload_sha256, raw_payload, source_updated_at, ingest_run_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (connector_id, stream_id, object_type, source_key) DO UPDATE SET
             payload_sha256 = EXCLUDED.payload_sha256,
             raw_payload = EXCLUDED.raw_payload,
             source_updated_at = EXCLUDED.source_updated_at,
             last_seen_at = now(),
             ingest_run_id = EXCLUDED.ingest_run_id`,
          [
            randomUUID(), CONNECTOR_ID, stream, record.objectType, record.externalId,
            record.payloadSha256, record.rawItem, record.eventTime, runId,
          ],
        )

        const upserted = await client.query(
          `INSERT INTO core.canonical_records
             (id, dataset_id, platform, object_type, external_id, schema_version,
              payload_sha256, content_type, url, title, body,
              author_external_id, author_name, event_time, collected_at,
              latitude, longitude, country_code, admin1_code, admin2_code,
              stable_fields, extensions)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                   $16, $17, $18, $19, $20, $21, $22)
           ON CONFLICT (dataset_id, platform, object_type, external_id) DO UPDATE SET
             payload_sha256 = EXCLUDED.payload_sha256,
             content_type = EXCLUDED.content_type,
             url = EXCLUDED.url,
             title = EXCLUDED.title,
             body = EXCLUDED.body,
             author_external_id = EXCLUDED.author_external_id,
             author_name = EXCLUDED.author_name,
             event_time = EXCLUDED.event_time,
             collected_at = EXCLUDED.collected_at,
             latitude = EXCLUDED.latitude,
             longitude = EXCLUDED.longitude,
             country_code = EXCLUDED.country_code,
             admin1_code = EXCLUDED.admin1_code,
             admin2_code = EXCLUDED.admin2_code,
             stable_fields = EXCLUDED.stable_fields,
             extensions = EXCLUDED.extensions,
             last_seen_at = now(),
             current_revision = core.canonical_records.current_revision
               + (core.canonical_records.payload_sha256 IS DISTINCT FROM EXCLUDED.payload_sha256)::int,
             projection_revision = core.canonical_records.projection_revision
               + (core.canonical_records.payload_sha256 IS DISTINCT FROM EXCLUDED.payload_sha256)::int
           RETURNING id, current_revision, projection_revision`,
          [
            randomUUID(), DATASET_ID, record.platform, record.objectType, record.externalId,
            SCHEMA_VERSION, record.payloadSha256, record.contentType, record.url,
            record.title, record.body, record.authorExternalId, record.authorName,
            record.eventTime, record.collectedAt, record.latitude, record.longitude,
            record.countryCode, record.admin1Code, record.admin2Code,
            record.stableFields, record.extensions,
          ],
        )
        const { id, current_revision: revision, projection_revision: projection } = upserted.rows[0]

        // Unchanged content collides on (record_id, revision) and is skipped.
        const revisionInsert = await client.query(
          `INSERT INTO core.record_revisions
             (record_id, revision, payload_sha256, normalized_payload, parser_version, ingest_run_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (record_id, revision) DO NOTHING`,
          [id, revision, record.payloadSha256, record.rawItem, PARSER_VERSION, runId],
        )
        if (revisionInsert.rowCount > 0) changed += 1

        await client.query(
          `INSERT INTO core.observations
             (id, record_id, connector_id, query_fingerprint, rank, metrics,
              observation_hash, ingest_run_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (record_id, observation_hash) DO NOTHING`,
          [
            randomUUID(), id, CONNECTOR_ID, queryFingerprint, record.rank ?? null,
            record.metrics || {}, observationHash(record, queryFingerprint), runId,
          ],
        )

        await client.query(
          `INSERT INTO outbox.projection_events
             (aggregate_type, aggregate_id, event_type, projection_revision, payload)
           VALUES ('canonical_record', $1, 'upsert', $2, $3)
           ON CONFLICT (aggregate_id, projection_revision) DO NOTHING`,
          [id, projection, { datasetId: DATASET_ID, platform: record.platform, objectType: record.objectType }],
        )
      }

      await client.query(
        `UPDATE ingest.ingest_runs SET item_count = $2, finished_at = now() WHERE id = $1`,
        [runId, records.length],
      )
      await client.query('COMMIT')
      return { ingested: records.length, changed, skipped, runId }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
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
