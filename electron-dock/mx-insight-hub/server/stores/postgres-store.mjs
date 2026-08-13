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

// Format rules are shared across files whose concrete header spelling may
// differ only by case, Unicode width or whitespace.  Source mappings retain
// the concrete parser column names used for that source; rule versions store
// this canonical form so semantic equality does not depend on those spellings.
function canonicalFileFieldMap(fieldMap) {
  const canonical = {}
  for (const [target, rule] of Object.entries(fieldMap || {})) {
    const normalizeColumn = (column) => String(column)
      .normalize('NFKC')
      .trim()
      .replace(/\s+/gu, ' ')
      .toLowerCase()
    canonical[target] = {
      ...rule,
      from: Array.isArray(rule.from)
        ? rule.from.map(normalizeColumn)
        : normalizeColumn(rule.from),
    }
  }
  return canonical
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
  const expired = row?.status === 'active'
    && row.expires_at != null
    && new Date(row.expires_at).getTime() <= Date.now()
  return row && {
    id: row.id,
    tenantId: row.tenant_id,
    consumerId: row.consumer_id,
    name: row.name,
    prefix: row.key_prefix,
    lastFour: row.last_four,
    environment: row.environment,
    status: row.status,
    effectiveStatus: expired ? 'expired' : row.status,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
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
    capability: row.capability,
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

function capabilityPolicy(row) {
  return row && {
    tenantId: row.tenant_id,
    consumerId: row.consumer_id,
    capability: row.capability,
    maxRequests: row.max_requests,
    windowSeconds: row.window_seconds,
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

  async renameTenant(id, name) {
    const { rows } = await this.pool.query(
      'UPDATE tenants SET name = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [id, name],
    )
    return tenant(rows[0]) || null
  }

  async createConsumer({ tenantId, name, status = 'active', businessId, defaultCapabilityPolicy = null }) {
    const id = randomUUID()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `INSERT INTO consumers (id, tenant_id, name, status, business_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [id, tenantId, name, status, businessId || `mxih:${tenantId}:${id}`],
      )
      if (defaultCapabilityPolicy) {
        const { capability, maxRequests, windowSeconds } = defaultCapabilityPolicy
        await client.query(
          'INSERT INTO capability_grants (consumer_id, capability) VALUES ($1, $2)',
          [id, capability],
        )
        await client.query(
          `INSERT INTO consumer_capability_policies
             (tenant_id, consumer_id, capability, max_requests, window_seconds)
           VALUES ($1, $2, $3, $4, $5)`,
          [tenantId, id, capability, maxRequests, windowSeconds],
        )
      }
      await client.query('COMMIT')
      return consumer(rows[0])
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
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

  async createApiKey({ id, tenantId, consumerId, name, digest, prefix, lastFour, environment = 'live', status = 'active', expiresAt }) {
    const { rows } = await this.pool.query(
      `INSERT INTO api_keys
         (id, tenant_id, consumer_id, name, key_digest, key_prefix, last_four, environment, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [id, tenantId, consumerId, name, digest, prefix, lastFour, environment, status, expiresAt],
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
       WHERE k.key_digest = $1
         AND k.status = 'active'
         AND k.expires_at > now()`,
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

  async setPlatformGrant(consumerId, platformName, enabled) {
    if (enabled) {
      await this.pool.query(
        `INSERT INTO platform_grants (consumer_id, platform) VALUES ($1, $2)
         ON CONFLICT (consumer_id, platform) DO NOTHING`,
        [consumerId, platformName],
      )
      return
    }
    await this.pool.query(
      'DELETE FROM platform_grants WHERE consumer_id = $1 AND platform = $2',
      [consumerId, platformName],
    )
  }

  async listGrants(consumerId) {
    const { rows } = await this.pool.query(
      'SELECT platform FROM platform_grants WHERE consumer_id = $1 ORDER BY platform',
      [consumerId],
    )
    return rows.map((row) => row.platform)
  }

  async listCapabilityGrants(consumerId) {
    const { rows } = await this.pool.query(
      'SELECT capability FROM capability_grants WHERE consumer_id = $1 ORDER BY capability',
      [consumerId],
    )
    return rows.map((row) => row.capability)
  }

  async putCapabilityConfiguration({
    tenantId,
    consumerId,
    capability,
    enabled,
    maxRequests,
    windowSeconds,
  }) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      if (enabled) {
        await client.query(
          `INSERT INTO capability_grants (consumer_id, capability) VALUES ($1, $2)
           ON CONFLICT (consumer_id, capability) DO NOTHING`,
          [consumerId, capability],
        )
      } else {
        await client.query(
          'DELETE FROM capability_grants WHERE consumer_id = $1 AND capability = $2',
          [consumerId, capability],
        )
      }
      const { rows } = await client.query(
        `INSERT INTO consumer_capability_policies
           (tenant_id, consumer_id, capability, max_requests, window_seconds)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (consumer_id, capability) DO UPDATE SET
           tenant_id = EXCLUDED.tenant_id,
           max_requests = EXCLUDED.max_requests,
           window_seconds = EXCLUDED.window_seconds,
           updated_at = now()
         RETURNING *`,
        [tenantId, consumerId, capability, maxRequests, windowSeconds],
      )
      await client.query('COMMIT')
      return capabilityPolicy(rows[0])
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
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

  async getCapabilityPolicy(consumerId, capability) {
    const { rows } = await this.pool.query(
      'SELECT * FROM consumer_capability_policies WHERE consumer_id = $1 AND capability = $2',
      [consumerId, capability],
    )
    return capabilityPolicy(rows[0]) || null
  }

  async listCapabilityPolicies(consumerId) {
    const { rows } = await this.pool.query(
      'SELECT * FROM consumer_capability_policies WHERE consumer_id = $1 ORDER BY capability',
      [consumerId],
    )
    return rows.map(capabilityPolicy)
  }

  async reserve(input) {
    if (Boolean(input.platform) === Boolean(input.capability)) {
      throw new AppError(500, 'invalid_usage_scope', 'Usage reservation requires exactly one scope')
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `${input.tenantId}:${input.consumerId}:${input.capability ? `capability:${input.capability}` : `platform:${input.platform}`}`,
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
            platform, capability, status, units_reserved, lease_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'reserved', $9, $10)
         RETURNING *`,
        [
          input.requestId,
          input.tenantId,
          input.consumerId,
          input.apiKeyId,
          input.idempotencyKey,
          input.fingerprint,
          input.platform ?? null,
          input.capability ?? null,
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
       WHERE tenant_id = $1 AND consumer_id = $2
         AND platform IS NOT DISTINCT FROM $3
         AND capability IS NOT DISTINCT FROM $4
         AND status IN ('reserved', 'committed', 'unknown')
         AND reserved_at >= $5`,
      [input.tenantId, input.consumerId, input.platform ?? null, input.capability ?? null, input.windowStart],
    )
    if (rows[0].count >= input.maxRequests) {
      throw new AppError(429, 'quota_exceeded', 'Request quota exceeded', {
        ...(input.platform ? { platform: input.platform } : { capability: input.capability }),
        maxRequests: input.maxRequests,
      })
    }
  }

  async commitRequest(id, { responseStatus, responseBody, unitsActual, upstreamLatencyMs }) {
    return this.#updateRequest(
      `UPDATE usage_requests SET
         status = 'committed', response_status = $2, response_body = $3,
         units_actual = $4, upstream_latency_ms = $5, completed_at = now()
       WHERE id = $1 AND status = 'reserved' RETURNING *`,
      [id, responseStatus, responseBody, unitsActual, upstreamLatencyMs],
    )
  }

  releaseRequest(id, errorCode) {
    return this.#updateRequest(
      `UPDATE usage_requests SET status = 'released', error_code = $2, completed_at = now()
       WHERE id = $1 AND status = 'reserved' RETURNING *`,
      [id, errorCode],
    )
  }

  markRequestUnknown(id, errorCode) {
    return this.#updateRequest(
      `UPDATE usage_requests SET status = 'unknown', error_code = $2, completed_at = now()
       WHERE id = $1 AND status IN ('reserved', 'committed') RETURNING *`,
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

  /**
   * Commit a billed request and queue its ingestion in ONE transaction.
   *
   * This is the property the PostgreSQL queue driver exists for. Committing the
   * request and then enqueueing separately leaves a window where the caller has
   * a billed, committed response and the follow-up ingest job does not exist —
   * a silent data hole that nothing would ever detect. Here, if the request row
   * says committed, the job is in `mxq.jobs` by the same COMMIT.
   *
   * The payload travels inside the job rather than being re-fetched later,
   * because the upstream call was billed and is not repeatable.
   */
  async commitRequestAndEnqueueIngest(id, { responseStatus, responseBody, unitsActual, upstreamLatencyMs }, job) {
    return withPgTransaction(this.pool, async (client) => {
      const { rows } = await client.query(
          `UPDATE usage_requests
            SET status = 'committed', response_status = $2, response_body = $3,
                units_actual = $4, upstream_latency_ms = $5, completed_at = now()
          WHERE id = $1 AND status = 'reserved'
          RETURNING *`,
        [id, responseStatus, responseBody, unitsActual, upstreamLatencyMs],
      )
      if (!rows[0]) throw new AppError(404, 'request_not_found', 'Request not found')

      if (job) {
        await client.query(
          `INSERT INTO mxq.jobs (queue, payload, dedupe_key, priority)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (queue, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','running')
           DO NOTHING`,
          [job.queue, job.payload, job.dedupeKey, job.priority ?? 100],
        )
      }
      return requestRecord(rows[0])
    }, { outcomeUnknownCode: 'usage_commit_outcome_unknown' })
  }

  /**
   * Write mapped external records through the same canonical path as Night-All
   * content.
   *
   * Sharing `core.canonical_records` rather than giving external data its own
   * table is what makes a spreadsheet row and a scraped post searchable by the
   * same query and projectable by the same worker. They are separated by
   * `dataset_id`, not by physical schema, so external data never silently
   * merges into platform analytics while still living in one queryable model.
   */
  async ingestExternalRecords({
    datasetId,
    platform,
    records,
    importRunId,
    sourceId = null,
    connectorId,
    batch = null,
    sessionClient = null,
  }) {
    if (records.length === 0) return { ingested: 0, changed: 0 }
    const stream = `${platform}.external.v1`
    const client = sessionClient ?? await this.pool.connect()
    let changed = 0
    let deleted = 0
    let commitStarted = false
    let committed = false
    let releaseError = null
    try {
      await client.query('BEGIN')
      if (importRunId) {
        const runResult = await client.query(
          `SELECT id, source_id, status
             FROM ingest.import_runs
            WHERE id = $1
            FOR UPDATE`,
          [importRunId],
        )
        const run = runResult.rows[0]
        if (!run || run.status !== 'running' || (sourceId && run.source_id !== sourceId)) {
          throw new AppError(
            409,
            'import_run_not_running',
            'External records can only be written to the running import run that owns this source',
          )
        }
      }

      // A reclaimed worker must detect a committed page before touching
      // canonical state. Locking the run row above serializes this check with
      // another worker that is committing the same logical run.
      if (importRunId && batch?.key) {
        const existing = await client.query(
          `SELECT batch_key, cursor_end, row_count, ingested_count,
                  changed_count, deleted_count, rejected_count, status,
                  page_fingerprint
             FROM ingest.import_run_batches
            WHERE import_run_id = $1 AND batch_key = $2`,
          [importRunId, batch.key],
        )
        if (existing.rows[0]) {
          const replay = existing.rows[0]
          if (replay.status !== 'succeeded') {
            throw new AppError(409, 'import_batch_failed', 'This import batch previously failed and must be reset')
          }
          commitStarted = true
          await client.query('COMMIT')
          committed = true
          return {
            ingested: Number(replay.ingested_count),
            changed: Number(replay.changed_count),
            deleted: Number(replay.deleted_count),
            cursorEnd: replay.cursor_end,
            rowCount: Number(replay.row_count),
            replayed: true,
            pageDrifted: Boolean(
              replay.page_fingerprint
              && batch.pageFingerprint
              && replay.page_fingerprint !== batch.pageFingerprint,
            ),
          }
        }
      }

      for (const record of records) {
        if (record.deletedAt != null) deleted += 1
        await client.query(
          `INSERT INTO ingest.source_objects
             (id, connector_id, stream_id, object_type, source_key,
              payload_sha256, raw_payload, source_updated_at, external_import_run_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (connector_id, stream_id, object_type, source_key) DO UPDATE SET
             payload_sha256 = EXCLUDED.payload_sha256,
             raw_payload = EXCLUDED.raw_payload,
             source_updated_at = EXCLUDED.source_updated_at,
             external_import_run_id = EXCLUDED.external_import_run_id,
             last_seen_at = now()`,
          [
            randomUUID(), connectorId, stream, record.objectType, record.externalId,
            record.payloadSha256, record.rawItem, record.collectedAt, importRunId,
          ],
        )

        const upserted = await client.query(
          `INSERT INTO core.canonical_records
             (id, dataset_id, platform, object_type, external_id, schema_version,
              payload_sha256, content_type, url, title, body,
              author_external_id, author_name, event_time, collected_at,
              latitude, longitude, country_code, admin1_code, admin2_code,
              stable_fields, extensions, deleted_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                   $16, $17, $18, $19, $20, $21, $22, $23)
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
             deleted_at = EXCLUDED.deleted_at,
             last_seen_at = now(),
             current_revision = core.canonical_records.current_revision
               + (core.canonical_records.payload_sha256 IS DISTINCT FROM EXCLUDED.payload_sha256)::int,
             projection_revision = core.canonical_records.projection_revision
               + (core.canonical_records.payload_sha256 IS DISTINCT FROM EXCLUDED.payload_sha256)::int
           RETURNING id, current_revision, projection_revision`,
          [
            randomUUID(), datasetId, platform, record.objectType, record.externalId,
            'external.v1', record.payloadSha256, record.contentType, record.url,
            record.title, record.body, record.authorExternalId, record.authorName,
            record.eventTime, record.collectedAt, record.latitude, record.longitude,
            record.countryCode, record.admin1Code, record.admin2Code,
            record.stableFields, record.extensions, record.deletedAt,
          ],
        )
        const { id, current_revision: revision, projection_revision: projection } = upserted.rows[0]

        const revisionInsert = await client.query(
          `INSERT INTO core.record_revisions
             (record_id, revision, payload_sha256, normalized_payload, parser_version, external_import_run_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (record_id, revision) DO NOTHING`,
          [id, revision, record.payloadSha256, record.rawItem, record.parserVersion, importRunId],
        )
        if (revisionInsert.rowCount > 0) changed += 1

        // Same outbox contract as the Night-All path: the projector cannot tell
        // (and must not care) which ingest route produced the event.
        await client.query(
          `INSERT INTO outbox.projection_events
             (aggregate_type, aggregate_id, event_type, projection_revision, payload)
           VALUES ('canonical_record', $1, $3, $2, $4)
           ON CONFLICT (aggregate_id, projection_revision) DO NOTHING`,
          [
            id,
            projection,
            record.deletedAt ? 'delete' : 'upsert',
            { datasetId, platform, objectType: record.objectType },
          ],
        )
      }

      if (importRunId && batch?.key) {
        await client.query(
          `INSERT INTO ingest.import_run_batches
             (import_run_id, batch_key, cursor_start, cursor_end, row_count,
              ingested_count, changed_count, deleted_count, rejected_count, status,
              page_fingerprint)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 'succeeded', $9)`,
          [
            importRunId, batch.key, batch.cursorStart ?? null, batch.cursorEnd ?? null,
            batch.rowCount ?? records.length, records.length, changed, deleted,
            batch.pageFingerprint ?? null,
          ],
        )
      }

      if (importRunId) {
        const updated = await client.query(
          `UPDATE ingest.import_runs
              SET row_count = row_count + $2,
                  ingested_count = ingested_count + $3,
                  changed_count = changed_count + $4,
                  deleted_count = deleted_count + $5
            WHERE id = $1 AND status = 'running'
            RETURNING id`,
          [importRunId, batch?.rowCount ?? 0, records.length, changed, deleted],
        )
        if (updated.rowCount === 0) {
          throw new AppError(409, 'import_run_not_running', 'The import run stopped before this batch could commit')
        }
      }
      commitStarted = true
      await client.query('COMMIT')
      committed = true
      return {
        ingested: records.length,
        changed,
        deleted,
        cursorEnd: batch?.cursorEnd ?? null,
        rowCount: batch?.rowCount ?? records.length,
      }
    } catch (error) {
      if (commitStarted && !committed) {
        releaseError = error
        const unknown = new AppError(
          503,
          'external_commit_outcome_unknown',
          'The external batch commit outcome is unknown; retry the same run and batch',
        )
        unknown.cause = error
        throw unknown
      }
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      if (!sessionClient) client.release(releaseError)
    }
  }

  /**
   * Keyset page over a fixed canonical dataset.
   *
   * Only explicitly selected customer-safe columns leave the store. Raw source
   * objects, `extensions`, connector ids and lineage remain inside PostgreSQL.
   */
  async listCanonicalRecords({
    datasetId,
    platform,
    objectType,
    pageSize,
    cursor = null,
    chatId = null,
    from = null,
    to = null,
  }) {
    const chatPredicate = objectType === 'chat'
      ? 'external_id = $4'
      : `(stable_fields #>> '{relations,chatId}') = $4`
    const { rows } = await this.pool.query(
      `SELECT id, dataset_id, external_id, object_type, content_type, url, title, body,
              author_external_id, author_name, event_time, collected_at,
              stable_fields, current_revision, event_time AS sort_time
         FROM core.canonical_records
        WHERE dataset_id = $1
          AND platform = $2
          AND object_type = $3
          AND deleted_at IS NULL
          AND event_time IS NOT NULL
          AND ($4::text IS NULL OR ${chatPredicate})
          AND ($5::timestamptz IS NULL OR event_time >= $5::timestamptz)
          AND ($6::timestamptz IS NULL OR event_time <= $6::timestamptz)
          AND ($7::timestamptz IS NULL OR (event_time, id) < ($7::timestamptz, $8::uuid))
        ORDER BY event_time DESC, id DESC
        LIMIT $9`,
      [
        datasetId, platform, objectType, chatId, from, to,
        cursor?.sortTime ?? null, cursor?.id ?? null, pageSize + 1,
      ],
    )
    return rows
  }

  async dataCenter({ datasetId = null, platform = null, objectType = null, pageSize = 50 } = {}) {
    const values = []
    const clauses = []
    for (const [column, value] of [
      ['r.dataset_id', datasetId],
      ['r.platform', platform],
      ['r.object_type', objectType],
    ]) {
      if (!value) continue
      values.push(value)
      clauses.push(`${column} = $${values.length}`)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const recordValues = [...values, pageSize]
    const [datasetResult, recordResult] = await Promise.all([
      this.pool.query(
        `SELECT dataset_id,
                array_agg(DISTINCT platform ORDER BY platform) AS platforms,
                array_agg(DISTINCT object_type ORDER BY object_type) AS object_types,
                coalesce(
                  array_agg(DISTINCT content_type ORDER BY content_type)
                    FILTER (WHERE content_type IS NOT NULL),
                  ARRAY[]::text[]
                ) AS content_types,
                count(*) FILTER (WHERE deleted_at IS NULL) AS active_record_count,
                count(*) FILTER (WHERE deleted_at IS NOT NULL) AS deleted_record_count,
                coalesce(sum(current_revision), 0) AS revision_count,
                max(collected_at) AS last_collected_at,
                max(event_time) AS last_event_at
           FROM core.canonical_records r
           ${where}
          GROUP BY dataset_id
          ORDER BY dataset_id`,
        values,
      ),
      this.pool.query(
        `SELECT id, dataset_id, platform, object_type, content_type, external_id,
                title, current_revision, event_time, collected_at, deleted_at
           FROM core.canonical_records r
           ${where}
          ORDER BY coalesce(event_time, collected_at, last_seen_at, first_seen_at) DESC, id DESC
          LIMIT $${recordValues.length}`,
        recordValues,
      ),
    ])
    const datasets = datasetResult.rows.map(dataCenterDataset)
    return {
      stats: {
        datasetCount: datasets.length,
        activeRecordCount: datasets.reduce((total, row) => total + row.activeRecordCount, 0),
        revisionCount: datasets.reduce((total, row) => total + row.revisionCount, 0),
        deletedRecordCount: datasets.reduce((total, row) => total + row.deletedRecordCount, 0),
      },
      datasets,
      records: recordResult.rows.map(dataCenterRecord),
      pageSize,
    }
  }

  /**
   * Keyset page for the Admin Data Center record browser.
   *
   * This is deliberately separate from `dataCenter()`: the catalog/count query
   * is cheap and stable, while a user may walk many record pages. Only canonical
   * Admin operators need the canonical truth for diagnosis and curation, so
   * this page deliberately includes the current revision payload, extensions
   * and lineage. Public API projections remain separately allowlisted.
   */
  async dataCenterRecords({
    datasetId = null,
    platform = null,
    objectType = null,
    pageSize = 50,
    cursor = null,
  } = {}) {
    const values = []
    const clauses = []
    for (const [column, value] of [
      ['r.dataset_id', datasetId],
      ['r.platform', platform],
      ['r.object_type', objectType],
    ]) {
      if (!value) continue
      values.push(value)
      clauses.push(`${column} = $${values.length}`)
    }
    if (cursor) {
      values.push(cursor.sortTime, cursor.id)
      clauses.push(
        `(coalesce(r.event_time, r.collected_at, r.last_seen_at, r.first_seen_at), r.id)`
        + ` < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
      )
    }
    values.push(pageSize + 1)
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const { rows } = await this.pool.query(
      `WITH page AS MATERIALIZED (
         SELECT r.id,
                coalesce(r.event_time, r.collected_at, r.last_seen_at, r.first_seen_at) AS sort_time
           FROM core.canonical_records r
           ${where}
          ORDER BY coalesce(r.event_time, r.collected_at, r.last_seen_at, r.first_seen_at) DESC, r.id DESC
          LIMIT $${values.length}
       )
       SELECT r.id, r.dataset_id, r.platform, r.object_type, r.external_id, r.identity_hash,
              r.schema_version, r.payload_sha256, r.content_type, r.url, r.title, r.body,
              r.author_external_id, r.author_name, r.event_time, r.collected_at,
              r.latitude, r.longitude, r.country_code, r.admin1_code, r.admin2_code,
              r.stable_fields, r.extensions, r.current_revision, r.projection_revision,
              r.first_seen_at, r.last_seen_at, r.deleted_at,
              revision.normalized_payload AS raw_payload,
              revision.parser_version, revision.ingest_run_id,
              revision.external_import_run_id,
              page.sort_time
         FROM page
         JOIN core.canonical_records r ON r.id = page.id
         LEFT JOIN core.record_revisions revision
           ON revision.record_id = r.id AND revision.revision = r.current_revision
        ORDER BY page.sort_time DESC, page.id DESC`,
      values,
    )
    const hasMore = rows.length > pageSize
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows
    const last = pageRows.at(-1)
    return {
      items: pageRows.map(dataCenterRecordDetail),
      hasMore,
      nextCursor: hasMore && last
        ? { sortTime: iso(last.sort_time), id: last.id }
        : null,
    }
  }

  async dataCenterRecordsByIds(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return []
    const { rows } = await this.pool.query(
      `SELECT r.id, r.dataset_id, r.platform, r.object_type, r.external_id, r.identity_hash,
              r.schema_version, r.payload_sha256, r.content_type, r.url, r.title, r.body,
              r.author_external_id, r.author_name, r.event_time, r.collected_at,
              r.latitude, r.longitude, r.country_code, r.admin1_code, r.admin2_code,
              r.stable_fields, r.extensions, r.current_revision, r.projection_revision,
              r.first_seen_at, r.last_seen_at, r.deleted_at,
              revision.normalized_payload AS raw_payload,
              revision.parser_version, revision.ingest_run_id,
              revision.external_import_run_id
         FROM core.canonical_records r
         LEFT JOIN core.record_revisions revision
           ON revision.record_id = r.id AND revision.revision = r.current_revision
        WHERE r.id = ANY($1::uuid[])`,
      [ids],
    )
    return rows.map(dataCenterRecordDetail)
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
         capability,
         count(*)::integer AS requests,
         count(*) FILTER (WHERE status = 'committed')::integer AS committed,
         count(*) FILTER (WHERE status = 'released')::integer AS released,
         count(*) FILTER (WHERE status = 'unknown')::integer AS unknown,
         coalesce(sum(units_actual) FILTER (WHERE status = 'committed'), 0)::integer AS units,
         round(avg(upstream_latency_ms))::integer AS average_latency
       FROM usage_requests ${where}
       GROUP BY platform, capability`,
      values,
    )
    return summarizeAggregates(rows)
  }

  async dashboard() {
    const [tenantsResult, consumersResult, keysResult, usage] = await Promise.all([
      this.pool.query('SELECT count(*)::integer AS count FROM tenants'),
      this.pool.query('SELECT count(*)::integer AS count FROM consumers'),
      this.pool.query("SELECT count(*)::integer AS count FROM api_keys WHERE status = 'active' AND expires_at > now()"),
      this.usage(),
    ])
    return {
      tenants: tenantsResult.rows[0].count,
      consumers: consumersResult.rows[0].count,
      activeApiKeys: keysResult.rows[0].count,
      ...usage,
    }
  }

  // ---- external sources (migration 008) ----------------------------------

  async createExternalSource({
    sourceKey,
    displayName,
    sourceKind,
    datasetId,
    platform,
    objectType,
    status,
    connection,
    syncIntervalSeconds = 60,
  }) {
    const { rows } = await this.pool.query(
      `INSERT INTO catalog.external_sources
         (id, source_key, display_name, source_kind, dataset_id, platform, object_type, status, connection,
          sync_interval_seconds)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (source_key) DO NOTHING
       RETURNING *`,
      [
        randomUUID(), sourceKey, displayName, sourceKind, datasetId, platform,
        objectType || 'record', status || 'active', connection || {}, syncIntervalSeconds,
      ],
    )
    if (!rows[0]) throw new AppError(409, 'source_exists', `Source key already exists: ${sourceKey}`)
    return externalSource(rows[0])
  }

  async updateExternalSource(sourceKey, patch) {
    const hasSyncInterval = Object.prototype.hasOwnProperty.call(patch, 'syncIntervalSeconds')
    const { rows } = await this.pool.query(
      `UPDATE catalog.external_sources
          SET status = coalesce($2, status),
              connection = coalesce($3, connection),
              sync_interval_seconds = CASE WHEN $4 THEN $5 ELSE sync_interval_seconds END,
              updated_at = now()
        WHERE source_key = $1
        RETURNING *`,
      [
        sourceKey,
        patch.status ?? null,
        patch.connection ?? null,
        hasSyncInterval,
        patch.syncIntervalSeconds ?? null,
      ],
    )
    if (!rows[0]) throw new AppError(404, 'source_not_found', `Unknown external source: ${sourceKey}`)
    return externalSource(rows[0])
  }

  /** Apply related source changes in one transaction (for built-in pipelines). */
  async updateExternalSourcesBatch(updates) {
    if (!Array.isArray(updates) || updates.length === 0) return []
    return withPgTransaction(this.pool, async (client) => {
      const results = []
      for (const update of updates) {
        const hasSyncInterval = Object.prototype.hasOwnProperty.call(update, 'syncIntervalSeconds')
        const { rows } = await client.query(
          `UPDATE catalog.external_sources
              SET status = coalesce($2, status),
                  connection = coalesce($3, connection),
                  sync_interval_seconds = CASE WHEN $4 THEN $5 ELSE sync_interval_seconds END,
                  updated_at = now()
            WHERE source_key = $1
            RETURNING *`,
          [
            update.sourceKey,
            update.status ?? null,
            update.connection ?? null,
            hasSyncInterval,
            update.syncIntervalSeconds ?? null,
          ],
        )
        if (!rows[0]) throw new AppError(404, 'source_not_found', `Unknown external source: ${update.sourceKey}`)
        results.push(externalSource(rows[0]))
      }
      return results
    })
  }

  async getExternalSource(sourceKey) {
    const { rows } = await this.pool.query(
      `SELECT * FROM catalog.external_sources WHERE source_key = $1`,
      [sourceKey],
    )
    return externalSource(rows[0])
  }

  async listExternalSources() {
    const { rows } = await this.pool.query(
      `SELECT * FROM catalog.external_sources ORDER BY created_at DESC`,
    )
    return rows.map(externalSource)
  }

  /**
   * Serialize pull/reset operations for one source across all Hub workers.
   *
   * This is a session advisory lock rather than an in-memory mutex because the
   * ingest deployment can be restarted or scaled.  try-lock semantics keep an
   * operator reset responsive: it reports `source_busy` instead of waiting
   * behind a long upstream query with no visible progress.
   */
  async withExternalSourceLock(sourceKey, operation) {
    const client = await this.pool.connect()
    const lockName = `mx-insight-hub:external-source:${sourceKey}`
    let locked = false
    let lockLost = false
    const markLockLost = () => { lockLost = true }
    client.once?.('error', markLockLost)
    client.once?.('end', markLockLost)
    const assertOwned = async () => {
      if (lockLost) {
        throw new AppError(409, 'source_lock_lost', `External source lock was lost: ${sourceKey}`)
      }
      try {
        await client.query('SELECT 1')
      } catch {
        lockLost = true
        throw new AppError(409, 'source_lock_lost', `External source lock was lost: ${sourceKey}`)
      }
      if (lockLost) {
        throw new AppError(409, 'source_lock_lost', `External source lock was lost: ${sourceKey}`)
      }
    }
    try {
      const { rows } = await client.query(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
        [lockName],
      )
      locked = rows[0]?.locked === true
      if (!locked) {
        throw new AppError(409, 'source_busy', `External source is currently being synchronized: ${sourceKey}`)
      }
      return await operation(assertOwned, client)
    } finally {
      if (locked) {
        await client.query(
          'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
          [lockName],
        ).catch(() => {})
      }
      client.off?.('error', markLockLost)
      client.off?.('end', markLockLost)
      client.release(lockLost ? new Error('external source lock session lost') : undefined)
    }
  }

  /**
   * Add a mapping version. Never edits an existing one.
   *
   * Mappings are immutable per version because they explain historical rows:
   * editing version 3 in place would silently rewrite the answer to "why is
   * this 2026-03 record missing a title".
   */
  async createSourceMapping({
    sourceId,
    fieldMap,
    origin,
    agentModel,
    agentConfidence,
    notes,
    schemaFingerprint = null,
    fileStructure = null,
    formatRuleVersionId = null,
    selectedRuleKey = null,
  }) {
    return withPgTransaction(this.pool, async (client) => {
      // max(version) + 1 needs serialization per source. Without this lock, two
      // simultaneous previews can both choose the same next version and one
      // fails at the unique constraint even though both requests are valid.
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`mx-insight-hub:source-mapping:${sourceId}`],
      )
      const { rows } = await client.query(
        `INSERT INTO catalog.source_mappings
          (id, source_id, version, field_map, origin, agent_model, agent_confidence, notes,
            schema_fingerprint, file_structure, format_rule_version_id, selected_rule_key)
         VALUES (
           $1, $2,
           (SELECT coalesce(max(version), 0) + 1 FROM catalog.source_mappings WHERE source_id = $2),
           $3, $4, $5, $6, $7, $8, $9, $10, $11
         )
         RETURNING *`,
        [
          randomUUID(), sourceId, fieldMap, origin || 'manual', agentModel || null,
          agentConfidence ?? null, notes || null, schemaFingerprint, fileStructure,
          formatRuleVersionId, selectedRuleKey,
        ],
      )
      return sourceMapping(rows[0])
    })
  }

  async approveSourceMapping({ sourceId, version, approvedBy }, { sessionClient = null } = {}) {
    return withPgTransaction(this.pool, async (client) => {
      const selected = await client.query(
        `SELECT m.*, s.source_kind, s.dataset_id, s.platform, s.object_type
           FROM catalog.source_mappings m
           JOIN catalog.external_sources s ON s.id = m.source_id
          WHERE m.source_id = $1 AND m.version = $2
          FOR UPDATE OF m`,
        [sourceId, version],
      )
      const mapping = selected.rows[0]
      if (!mapping) throw new AppError(404, 'mapping_not_found', 'Mapping version not found')
      const canonicalFieldMap = canonicalFileFieldMap(mapping.field_map)

      if (mapping.source_kind !== 'file' && (
        mapping.schema_fingerprint || mapping.file_structure || mapping.format_rule_version_id
        || mapping.selected_rule_key
      )) {
        throw new AppError(409, 'format_rule_mismatch', 'File structure evidence is only valid for file sources')
      }

      let formatRuleVersionId = mapping.format_rule_version_id
      if (formatRuleVersionId) {
        const selectedRuleClause = mapping.selected_rule_key ? 'AND r.rule_key = $8' : ''
        const linked = await client.query(
          `SELECT v.id
             FROM catalog.file_format_rule_versions v
             JOIN catalog.file_format_rules r ON r.id = v.rule_id
            WHERE v.id = $1
              AND r.dataset_id = $2 AND r.platform = $3 AND r.object_type = $4
              AND v.schema_fingerprint = $5
              AND v.field_map = $6::jsonb
              AND v.file_structure = $7::jsonb
              ${selectedRuleClause}`,
          [
            formatRuleVersionId, mapping.dataset_id, mapping.platform,
            mapping.object_type, mapping.schema_fingerprint, canonicalFieldMap,
            mapping.file_structure,
            ...(mapping.selected_rule_key ? [mapping.selected_rule_key] : []),
          ],
        )
        if (!linked.rows[0]) {
          throw new AppError(409, 'format_rule_mismatch', 'The selected format rule does not match this source and mapping')
        }
      } else if (mapping.schema_fingerprint && mapping.file_structure) {
        const structureLockKey = `mx-insight-hub:file-format-rule:${JSON.stringify([
          mapping.dataset_id, mapping.platform, mapping.object_type,
          mapping.schema_fingerprint,
        ])}`
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [structureLockKey],
        )
        if (mapping.selected_rule_key) {
          await client.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
            [`mx-insight-hub:file-format-rule-key:${mapping.selected_rule_key}`],
          )
        }
        let ruleId = null
        let matched
        if (mapping.selected_rule_key) {
          const selectedRule = await client.query(
            `SELECT r.id
               FROM catalog.file_format_rules r
              WHERE r.rule_key = $1
                AND r.dataset_id = $2 AND r.platform = $3 AND r.object_type = $4
              FOR UPDATE`,
            [
              mapping.selected_rule_key, mapping.dataset_id,
              mapping.platform, mapping.object_type,
            ],
          )
          ruleId = selectedRule.rows[0]?.id ?? null
          if (!ruleId) {
            throw new AppError(409, 'format_rule_mismatch', 'The selected format rule is outside this source scope')
          }
          matched = await client.query(
            `SELECT v.id AS version_id, v.version,
                    v.file_structure = $3::jsonb AS file_structure_matches,
                    v.field_map = $4::jsonb AS field_map_matches
               FROM catalog.file_format_rule_versions v
              WHERE v.rule_id = $1
                AND v.schema_fingerprint = $2
              ORDER BY v.approved_at DESC, v.version DESC
              LIMIT 1`,
            [ruleId, mapping.schema_fingerprint, mapping.file_structure, canonicalFieldMap],
          )
        } else {
          matched = await client.query(
            `SELECT r.id AS rule_id, v.id AS version_id, v.version,
                    v.file_structure = $5::jsonb AS file_structure_matches,
                    v.field_map = $6::jsonb AS field_map_matches
               FROM catalog.file_format_rules r
               JOIN catalog.file_format_rule_versions v ON v.rule_id = r.id
              WHERE r.dataset_id = $1 AND r.platform = $2 AND r.object_type = $3
                AND v.schema_fingerprint = $4
              ORDER BY v.approved_at DESC, v.version DESC
              LIMIT 1
              FOR UPDATE OF r`,
            [
              mapping.dataset_id, mapping.platform, mapping.object_type,
              mapping.schema_fingerprint, mapping.file_structure, canonicalFieldMap,
            ],
          )
          ruleId = matched.rows[0]?.rule_id ?? null
        }
        if (matched.rows[0] && matched.rows[0].file_structure_matches !== true) {
          throw new AppError(409, 'schema_fingerprint_conflict', 'The structure fingerprint is already linked to different structure evidence')
        }
        if (!ruleId) {
          ruleId = randomUUID()
          const inputFormat = typeof mapping.file_structure.format === 'string'
            ? mapping.file_structure.format
            : 'file'
          await client.query(
            `INSERT INTO catalog.file_format_rules
               (id, rule_key, display_name, dataset_id, platform, object_type)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              ruleId,
              `file.${mapping.schema_fingerprint.slice(0, 16)}.${ruleId.slice(0, 8)}`,
              `${inputFormat.toUpperCase()} ${mapping.schema_fingerprint.slice(0, 8)}`,
              mapping.dataset_id,
              mapping.platform,
              mapping.object_type,
            ],
          )
        }

        if (matched.rows[0]?.field_map_matches === true) {
          formatRuleVersionId = matched.rows[0].version_id
        } else {
          const parserFamily = typeof mapping.file_structure.parserFamily === 'string'
            ? mapping.file_structure.parserFamily
            : 'unknown'
          const inputFormat = typeof mapping.file_structure.format === 'string'
            ? mapping.file_structure.format
            : 'unknown'
          const inserted = await client.query(
            `INSERT INTO catalog.file_format_rule_versions
               (id, rule_id, version, schema_fingerprint, parser_family, input_format,
                file_structure, field_map, origin, agent_model, agent_confidence,
                approved_at, approved_by)
             VALUES (
               $1, $2,
               (SELECT coalesce(max(version), 0) + 1 FROM catalog.file_format_rule_versions WHERE rule_id = $2),
               $3, $4, $5, $6, $7, $8, $9, $10, now(), $11
             )
             RETURNING id`,
            [
              randomUUID(), ruleId, mapping.schema_fingerprint,
              parserFamily,
              inputFormat,
              mapping.file_structure, canonicalFieldMap,
              mapping.origin === 'format_rule' ? 'manual' : mapping.origin,
              mapping.agent_model, mapping.agent_confidence, approvedBy,
            ],
          )
          formatRuleVersionId = inserted.rows[0].id
        }
      }

      const approved = await client.query(
        `UPDATE catalog.source_mappings
            SET approved_at = now(), approved_by = $3,
                format_rule_version_id = $4
          WHERE source_id = $1 AND version = $2
          RETURNING *`,
        [sourceId, version, approvedBy, formatRuleVersionId],
      )
      return sourceMapping(approved.rows[0])
    }, { sessionClient })
  }

  async findApprovedFileFormatRule({ schemaFingerprint, datasetId, platform, objectType }) {
    const { rows } = await this.pool.query(
      `SELECT r.id AS rule_id, r.rule_key, r.display_name,
              r.dataset_id, r.platform, r.object_type,
              v.id AS version_id, v.version, v.schema_fingerprint, v.field_map,
              v.parser_family, v.input_format, v.file_structure
         FROM catalog.file_format_rules r
         JOIN catalog.file_format_rule_versions v ON v.rule_id = r.id
        WHERE r.dataset_id = $1 AND r.platform = $2 AND r.object_type = $3
          AND v.schema_fingerprint = $4
        ORDER BY v.approved_at DESC, v.version DESC
        LIMIT 1`,
      [datasetId, platform, objectType, schemaFingerprint],
    )
    return fileFormatRule(rows[0])
  }

  async listFileFormatRules() {
    const { rows } = await this.pool.query(
      `SELECT r.id AS rule_id, r.rule_key, r.display_name,
              r.dataset_id, r.platform, r.object_type,
              v.id AS version_id, v.version, v.schema_fingerprint, v.field_map,
              v.parser_family, v.input_format, v.file_structure
         FROM catalog.file_format_rules r
         LEFT JOIN LATERAL (
           SELECT version.id, version.version, version.schema_fingerprint,
                  version.field_map, version.parser_family, version.input_format,
                  version.file_structure
             FROM catalog.file_format_rule_versions version
            WHERE version.rule_id = r.id
            ORDER BY version.approved_at DESC, version.version DESC
            LIMIT 1
         ) v ON true
        ORDER BY r.platform, r.dataset_id, r.object_type, r.display_name, r.rule_key`,
    )
    return rows.map(fileFormatRule)
  }

  async findApprovedFileFormatRuleByKey({
    ruleKey,
    schemaFingerprint,
    datasetId,
    platform,
    objectType,
  }) {
    const { rows } = await this.pool.query(
      `SELECT r.id AS rule_id, r.rule_key, r.display_name,
              r.dataset_id, r.platform, r.object_type,
              v.id AS version_id, v.version, v.schema_fingerprint, v.field_map,
              v.parser_family, v.input_format, v.file_structure
         FROM catalog.file_format_rules r
         JOIN catalog.file_format_rule_versions v ON v.rule_id = r.id
        WHERE r.rule_key = $1
          AND r.dataset_id = $2 AND r.platform = $3 AND r.object_type = $4
          AND v.schema_fingerprint = $5
        ORDER BY v.approved_at DESC, v.version DESC
        LIMIT 1`,
      [ruleKey, datasetId, platform, objectType, schemaFingerprint],
    )
    return fileFormatRule(rows[0])
  }

  async recordFileObservation({
    sourceId,
    rootId,
    relativePath,
    pathHash,
    inputSha256,
    inputBytes,
    mtime,
    schemaFingerprint = null,
    formatRuleVersionId = null,
    importRunId = null,
    status,
  }) {
    const { rows } = await this.pool.query(
      `INSERT INTO ingest.file_observations
         (id, source_id, root_id, relative_path, path_hash, input_sha256,
          input_bytes, source_mtime, schema_fingerprint, format_rule_version_id,
          import_run_id, status)
       SELECT $1, s.id, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
         FROM catalog.external_sources s
         LEFT JOIN catalog.file_format_rule_versions v ON v.id = $10
         LEFT JOIN catalog.file_format_rules r ON r.id = v.rule_id
         LEFT JOIN ingest.import_runs ir ON ir.id = $11
        WHERE s.id = $2
          AND s.source_kind = 'file'
          AND s.connection->>'fileMode' = 'server_path'
          AND ($10::uuid IS NULL OR (
            r.dataset_id = s.dataset_id
            AND r.platform = s.platform
            AND r.object_type = s.object_type
            AND v.schema_fingerprint = $9
          ))
          AND ($11::uuid IS NULL OR ir.source_id = s.id)
       ON CONFLICT (source_id, root_id, relative_path, input_sha256) DO UPDATE SET
         input_bytes = EXCLUDED.input_bytes,
         source_mtime = EXCLUDED.source_mtime,
         schema_fingerprint = CASE
           WHEN EXCLUDED.status = 'imported' OR ingest.file_observations.status <> 'imported'
             THEN EXCLUDED.schema_fingerprint
           ELSE ingest.file_observations.schema_fingerprint
         END,
         format_rule_version_id = CASE
           WHEN EXCLUDED.status = 'imported' OR ingest.file_observations.status <> 'imported'
             THEN EXCLUDED.format_rule_version_id
           ELSE ingest.file_observations.format_rule_version_id
         END,
         import_run_id = CASE
           WHEN EXCLUDED.status = 'imported' THEN EXCLUDED.import_run_id
           ELSE ingest.file_observations.import_run_id
         END,
         status = CASE WHEN EXCLUDED.status = 'imported' THEN 'imported' ELSE ingest.file_observations.status END,
         last_seen_at = now()
       RETURNING *`,
      [
        randomUUID(), sourceId, rootId, relativePath, pathHash, inputSha256,
        inputBytes, mtime, schemaFingerprint, formatRuleVersionId, importRunId, status,
      ],
    )
    if (!rows[0]) {
      throw new AppError(409, 'file_observation_scope_mismatch', 'File evidence must reference the same file source, format-rule scope and import run')
    }
    return fileObservation(rows[0])
  }

  async listFileObservations(sourceId, limit = 20) {
    const { rows } = await this.pool.query(
      `SELECT * FROM ingest.file_observations
        WHERE source_id = $1
        ORDER BY last_seen_at DESC LIMIT $2`,
      [sourceId, limit],
    )
    return rows.map(fileObservation)
  }

  /** Approve all mappings or none, so a built-in pipeline cannot split versions. */
  async approveSourceMappingsBatch({ approvals, approvedBy }) {
    if (!Array.isArray(approvals) || approvals.length === 0) return []
    return withPgTransaction(this.pool, async (client) => {
      const results = []
      for (const approval of approvals) {
        const { rows } = await client.query(
          `UPDATE catalog.source_mappings
              SET approved_at = now(), approved_by = $4
            WHERE id = $1 AND source_id = $2 AND version = $3
            RETURNING *`,
          [approval.mappingId, approval.sourceId, approval.version, approvedBy],
        )
        if (!rows[0]) throw new AppError(404, 'mapping_not_found', 'Mapping version not found')
        results.push(sourceMapping(rows[0]))
      }
      return results
    })
  }

  async activateExternalSourcesWithAttestation({
    sourceKeys,
    pipelineKey,
    contractVersion,
    contractDigest,
    contractSummary,
    attestedBy,
    approvals = [],
  }) {
    return withPgTransaction(this.pool, async (client) => {
      for (const approval of approvals) {
        const approved = await client.query(
          `UPDATE catalog.source_mappings
              SET approved_at = now(), approved_by = $4
            WHERE id = $1 AND source_id = $2 AND version = $3
            RETURNING id`,
          [approval.mappingId, approval.sourceId, approval.version, attestedBy],
        )
        if (!approved.rows[0]) throw new AppError(409, 'builtin_mapping_conflict', 'Seeded built-in mapping changed before activation')
      }

      const attestationResult = await client.query(
        `INSERT INTO catalog.pipeline_writer_contract_attestations
           (id, pipeline_key, contract_version, contract_digest, contract_summary, attested_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [randomUUID(), pipelineKey, contractVersion, contractDigest, contractSummary, attestedBy],
      )
      const sources = []
      for (const sourceKey of sourceKeys) {
        const { rows } = await client.query(
          `UPDATE catalog.external_sources
              SET status = 'active', updated_at = now()
            WHERE source_key = $1
            RETURNING *`,
          [sourceKey],
        )
        if (!rows[0]) throw new AppError(404, 'source_not_found', `Unknown external source: ${sourceKey}`)
        sources.push(externalSource(rows[0]))
      }
      return {
        sources,
        attestation: pipelineWriterContractAttestation(attestationResult.rows[0]),
      }
    }, { outcomeUnknownCode: 'pipeline_activation_outcome_unknown' })
  }

  async getLatestPipelineWriterContractAttestation(pipelineKey) {
    const { rows } = await this.pool.query(
      `SELECT *
         FROM catalog.pipeline_writer_contract_attestations
        WHERE pipeline_key = $1
        ORDER BY attested_at DESC
        LIMIT 1`,
      [pipelineKey],
    )
    return pipelineWriterContractAttestation(rows[0])
  }

  async listSourceMappings(sourceId) {
    const { rows } = await this.pool.query(
      'SELECT * FROM catalog.source_mappings WHERE source_id = $1 ORDER BY version DESC',
      [sourceId],
    )
    return rows.map(sourceMapping)
  }

  /** Highest approved version. Unapproved mappings are never returned. */
  async getActiveMapping(sourceId) {
    const { rows } = await this.pool.query(
      `SELECT * FROM catalog.source_mappings
        WHERE source_id = $1 AND approved_at IS NOT NULL
        ORDER BY version DESC LIMIT 1`,
      [sourceId],
    )
    return sourceMapping(rows[0])
  }

  async getImportRunState(id) {
    const { rows } = await this.pool.query(
      `SELECT id, source_id, status
         FROM ingest.import_runs
        WHERE id = $1`,
      [id],
    )
    return rows[0] && {
      id: rows[0].id,
      sourceId: rows[0].source_id,
      status: rows[0].status,
    }
  }

  async getImportBatch(importRunId, batchKey) {
    const { rows } = await this.pool.query(
      `SELECT batch_key, cursor_start, cursor_end, row_count, ingested_count,
              changed_count, deleted_count, rejected_count, status, error_code,
              page_fingerprint
         FROM ingest.import_run_batches
        WHERE import_run_id = $1 AND batch_key = $2`,
      [importRunId, batchKey],
    )
    return importRunBatch(rows[0])
  }

  /** Finish a database import and its durable cursor in one PostgreSQL commit. */
  async finalizeExternalImportRun({
    importRunId,
    sourceId,
    cursorId,
    position,
    status,
    cursorStatus,
    processedDelta = 0,
    error = null,
  }) {
    return withPgTransaction(this.pool, async (client) => {
      const updated = await client.query(
        `UPDATE ingest.import_runs
            SET status = $3,
                cursor_end = coalesce($4, cursor_end),
                last_error = $5,
                finished_at = now()
          WHERE id = $1 AND source_id = $2 AND status = 'running'
          RETURNING *`,
        [
          importRunId,
          sourceId,
          status,
          position,
          error ? String(error).slice(0, 2_000) : null,
        ],
      )
      if (updated.rowCount === 0) {
        throw new AppError(
          409,
          'import_run_not_running',
          'The import run is missing, terminal, or belongs to another source',
        )
      }
      const cursor = await saveCursorInTransaction(client, cursorId, position, {
        status: cursorStatus,
        processedDelta,
        error,
      })
      return { run: importRun(updated.rows[0]), cursor }
    }, { outcomeUnknownCode: 'external_finalize_outcome_unknown' })
  }

  /** Keep a resumable run open when only its continuation hand-off is lost. */
  async markExternalImportCursorFailed({ importRunId, sourceId, cursorId, position, error }) {
    return withPgTransaction(this.pool, async (client) => {
      const { rows } = await client.query(
        `SELECT id
           FROM ingest.import_runs
          WHERE id = $1 AND source_id = $2 AND status = 'running'
          FOR UPDATE`,
        [importRunId, sourceId],
      )
      if (!rows[0]) {
        throw new AppError(
          409,
          'import_run_not_running',
          'The continuation import run is missing, terminal, or belongs to another source',
        )
      }
      const cursor = await saveCursorInTransaction(client, cursorId, position, {
        status: 'failed',
        processedDelta: 0,
        error,
      })
      return { importRunId, cursor }
    }, { outcomeUnknownCode: 'external_cursor_failure_outcome_unknown' })
  }

  /** Reset the checkpoint and fail every orphaned running run atomically. */
  async resetExternalImportCheckpoint({ sourceId, cursorId, position }) {
    return withPgTransaction(this.pool, async (client) => {
      const { rows } = await client.query(
        `UPDATE ingest.import_runs
            SET status = 'failed',
                cursor_end = $2,
                last_error = 'checkpoint_reset',
                finished_at = now()
          WHERE source_id = $1 AND run_key IS NOT NULL AND status = 'running'
          RETURNING id`,
        [sourceId, position],
      )
      const cursor = await saveCursorInTransaction(client, cursorId, position, {
        status: 'idle',
        error: null,
      })
      return { failedRunIds: rows.map((row) => row.id), cursor }
    }, { outcomeUnknownCode: 'external_reset_outcome_unknown' })
  }

  /** Reset every child checkpoint of one built-in pipeline in one commit. */
  async resetExternalImportCheckpointsBatch(resets) {
    return withPgTransaction(this.pool, async (client) => {
      const results = []
      for (const reset of resets) {
        const { rows } = await client.query(
          `UPDATE ingest.import_runs
              SET status = 'failed',
                  cursor_end = $2,
                  last_error = 'checkpoint_reset',
                  finished_at = now()
            WHERE source_id = $1 AND run_key IS NOT NULL AND status = 'running'
            RETURNING id`,
          [reset.sourceId, reset.position],
        )
        const cursor = await saveCursorInTransaction(client, reset.cursorId, reset.position, {
          status: 'idle',
          error: null,
        })
        results.push({
          sourceKey: reset.sourceKey,
          failedRunIds: rows.map((row) => row.id),
          cursor,
        })
      }
      return results
    }, { outcomeUnknownCode: 'external_reset_outcome_unknown' })
  }

  /**
   * Open an import run, or report that this exact input already succeeded.
   *
   * Content-hash deduplication at the file level is cheaper than relying on
   * per-row uniqueness for a 50,000-row spreadsheet someone uploaded twice, and
   * it gives the operator a clear answer ("skipped, identical to run X")
   * instead of a run that reports 50,000 rows and zero changes.
   */
  async startImportRun({
    sourceId,
    mappingVersion,
    inputSha256,
    interpretationKey = null,
    inputName,
    inputBytes,
    cursorStart = null,
    trigger = inputSha256 ? 'file' : 'manual',
    runKey = null,
    sessionClient = null,
  }) {
    if (inputSha256) {
      const keyedInterpretation = interpretationKey !== null
      return withPgTransaction(this.pool, async (client) => {
        // This UPDATE is the database fence for a reclaimed file import. It
        // takes the same run-row lock that ingestExternalRecords holds while
        // writing a batch, so an old writer either commits before this claim
        // or observes the failed status before touching canonical state.
        // input_sha256 also covers file runs created before migration 012,
        // whose trigger column was backfilled to the legacy 'manual' default.
        await client.query(
          `UPDATE ingest.import_runs
              SET status = 'failed',
                  last_error = 'superseded_by_new_file_import',
                  finished_at = now()
            WHERE source_id = $1
              AND input_sha256 IS NOT NULL
              AND status = 'running'`,
          [sourceId],
        )

        const { rows } = await client.query(
          `SELECT id, started_at FROM ingest.import_runs
            WHERE source_id = $1
              AND input_sha256 = $2
              AND ${keyedInterpretation ? 'interpretation_key = $3' : 'interpretation_key IS NULL'}
              AND status = 'succeeded'
            ORDER BY started_at DESC LIMIT 1`,
          keyedInterpretation
            ? [sourceId, inputSha256, interpretationKey]
            : [sourceId, inputSha256],
        )
        if (rows[0]) return { duplicateOf: rows[0].id, id: null }

        const inserted = await client.query(
          `INSERT INTO ingest.import_runs
             (id, source_id, mapping_version, input_sha256, input_name, input_bytes,
              interpretation_key, cursor_start, trigger)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [
            randomUUID(), sourceId, mappingVersion, inputSha256, inputName, inputBytes,
            interpretationKey, cursorStart, trigger,
          ],
        )
        return { id: inserted.rows[0].id, duplicateOf: null }
      }, {
        outcomeUnknownCode: 'external_import_claim_outcome_unknown',
        sessionClient,
      })
    }
    if (runKey) {
      const { rows } = await this.pool.query(
        `INSERT INTO ingest.import_runs
           (id, source_id, mapping_version, input_sha256, input_name, input_bytes,
            interpretation_key, cursor_start, trigger, run_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (source_id, run_key)
           WHERE run_key IS NOT NULL AND status = 'running'
         DO UPDATE SET run_key = EXCLUDED.run_key
         RETURNING id`,
        [
          randomUUID(), sourceId, mappingVersion, inputSha256, inputName, inputBytes,
          interpretationKey, cursorStart, trigger, runKey,
        ],
      )
      return { id: rows[0].id, duplicateOf: null }
    }
    const { rows } = await this.pool.query(
      `INSERT INTO ingest.import_runs
         (id, source_id, mapping_version, input_sha256, input_name, input_bytes,
          interpretation_key, cursor_start, trigger)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        randomUUID(), sourceId, mappingVersion, inputSha256, inputName, inputBytes,
        interpretationKey, cursorStart, trigger,
      ],
    )
    return { id: rows[0].id, duplicateOf: null }
  }

  async finishImportRun(id, {
    status,
    rowCount,
    rejectedCount,
    changedCount,
    deletedCount,
    cursorEnd = null,
    error,
  }, { sessionClient = null } = {}) {
    const result = await (sessionClient ?? this.pool).query(
      `UPDATE ingest.import_runs
          SET status = $2,
              row_count = coalesce($3, row_count),
              rejected_count = coalesce($4, rejected_count),
              changed_count = coalesce($5, changed_count),
              deleted_count = coalesce($6, deleted_count),
              cursor_end = coalesce($7, cursor_end),
              last_error = $8,
              finished_at = now()
        WHERE id = $1
          AND (status = 'running' OR status = $2)`,
      [
        id, status, rowCount, rejectedCount, changedCount ?? null, deletedCount ?? null, cursorEnd,
        error ? String(error).slice(0, 2_000) : null,
      ],
    )
    return { transitioned: result.rowCount !== 0 }
  }

  async recordRejectedImportBatch(importRunId, {
    sourceId = null,
    batchKey,
    cursorStart = null,
    rowCount,
    rejections,
    pageFingerprint = null,
    errorCode = 'row_rejections_detected',
  }) {
    return withPgTransaction(this.pool, async (client) => {
      const runResult = await client.query(
        `SELECT id, source_id, status
           FROM ingest.import_runs
          WHERE id = $1
          FOR UPDATE`,
        [importRunId],
      )
      const run = runResult.rows[0]
      if (!run || run.status !== 'running' || (sourceId && run.source_id !== sourceId)) {
        throw new AppError(409, 'import_run_not_running', 'Rejected rows can only be attached to their running import run')
      }
      const inserted = await client.query(
        `INSERT INTO ingest.import_run_batches
           (import_run_id, batch_key, cursor_start, cursor_end, row_count,
            ingested_count, changed_count, deleted_count, rejected_count, status,
            error_code, page_fingerprint)
         VALUES ($1, $2, $3, $3, $4, 0, 0, 0, $5, 'failed', $6, $7)
         ON CONFLICT (import_run_id, batch_key) DO NOTHING
         RETURNING batch_key`,
        [
          importRunId, batchKey, cursorStart, rowCount, rejections.length,
          errorCode, pageFingerprint,
        ],
      )
      if (inserted.rowCount === 0) return { recorded: false }
      const stored = rejections.slice(0, 1_000)
      if (stored.length > 0) {
        const values = stored.flatMap((rejection) => [
          importRunId, rejection.rowIndex, rejection.reason, rejection.raw,
        ])
        const tuples = stored
          .map((_, index) => `($${index * 4 + 1}, $${index * 4 + 2}, $${index * 4 + 3}, $${index * 4 + 4})`)
          .join(', ')
        await client.query(
          `INSERT INTO ingest.rejected_rows (import_run_id, row_index, reason, raw_row) VALUES ${tuples}`,
          values,
        )
      }
      await client.query(
        `UPDATE ingest.import_runs
            SET row_count = row_count + $2,
                rejected_count = rejected_count + $3
          WHERE id = $1 AND status = 'running'`,
        [importRunId, rowCount, rejections.length],
      )
      return { recorded: true }
    })
  }

  /**
   * Record rows that could not be mapped, with the reason.
   *
   * These are evidence. A row rejected for a missing external id is how you
   * find out a spreadsheet gained a header row or an upstream column was
   * renamed; discarding them is how an import "succeeds" at 60% coverage and
   * nobody notices for a month.
   */
  async recordRejectedRows(importRunId, rejections, { sessionClient = null } = {}) {
    if (rejections.length === 0) return
    // Cap what is stored: a mapping that rejects every row of a large file
    // would otherwise write a second copy of it into the database.
    const stored = rejections.slice(0, 1_000)
    const values = stored.flatMap((rejection) => [importRunId, rejection.rowIndex, rejection.reason, rejection.raw])
    const tuples = stored
      .map((_, index) => `($${index * 4 + 1}, $${index * 4 + 2}, $${index * 4 + 3}, $${index * 4 + 4})`)
      .join(', ')
    await (sessionClient ?? this.pool).query(
      `INSERT INTO ingest.rejected_rows (import_run_id, row_index, reason, raw_row) VALUES ${tuples}`,
      values,
    )
  }

  async listImportRuns(sourceId, limit = 20) {
    const { rows } = await this.pool.query(
      `SELECT r.*,
              (SELECT count(*)::int FROM ingest.import_run_batches b WHERE b.import_run_id = r.id) AS batch_count
         FROM ingest.import_runs r
        WHERE ($1::uuid IS NULL OR r.source_id = $1)
        ORDER BY r.started_at DESC LIMIT $2`,
      [sourceId || null, limit],
    )
    return rows.map(importRun)
  }

  // ---- federated identity (migration 007) --------------------------------

  /**
   * Find or create the Hub member behind a verified external identity.
   *
   * The binding, not the member, carries the uniqueness constraint, so the same
   * human reaching the Hub through two issuers gets two bindings and (for now)
   * two members. Merging them is an explicit operator action; doing it
   * automatically would mean guessing that two subjects are the same person,
   * which is exactly the mistake that email-keyed identity makes.
   */
  async upsertExternalIdentity({
    issuer,
    subject,
    audience,
    organizationId,
    launcherTenantId,
    authProvider,
    displayName,
  }) {
    return withPgTransaction(this.pool, async (client) => {
      const existing = await client.query(
        `SELECT b.member_id, m.display_name, m.status
           FROM iam.external_identity_bindings b
           JOIN iam.members m ON m.id = b.member_id
          WHERE b.issuer = $1 AND b.subject = $2 AND b.audience = $3`,
        [issuer, subject, audience],
      )

      if (existing.rows[0]) {
        const row = existing.rows[0]
        await client.query(
          `UPDATE iam.external_identity_bindings
              SET last_seen_at = now(),
                  organization_id = COALESCE($4, organization_id),
                  launcher_tenant_id = COALESCE($5, launcher_tenant_id),
                  auth_provider = COALESCE($6, auth_provider)
            WHERE issuer = $1 AND subject = $2 AND audience = $3`,
          [issuer, subject, audience, organizationId, launcherTenantId, authProvider],
        )
        // Refresh the cached display name, which is a Launcher attribute and can
        // change there at any time.
        if (displayName && displayName !== row.display_name) {
          await client.query(
            'UPDATE iam.members SET display_name = $2, updated_at = now() WHERE id = $1',
            [row.member_id, displayName],
          )
        }
        return { id: row.member_id, displayName: displayName || row.display_name, status: row.status }
      }

      const memberId = randomUUID()
      await client.query(
        'INSERT INTO iam.members (id, display_name) VALUES ($1, $2)',
        [memberId, displayName || subject],
      )
      await client.query(
        `INSERT INTO iam.external_identity_bindings
           (id, member_id, issuer, subject, audience, organization_id, launcher_tenant_id, auth_provider, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
        [randomUUID(), memberId, issuer, subject, audience, organizationId, launcherTenantId, authProvider],
      )
      await client.query(
        `INSERT INTO iam.identity_events (member_id, event_type, issuer, subject, detail)
         VALUES ($1, 'member.provisioned', $2, $3, $4)`,
        [memberId, issuer, subject, { organizationId, authProvider }],
      )
      return { id: memberId, displayName: displayName || subject, status: 'active' }
    })
  }

  /**
   * Reconcile platform-admin status against the current token's scopes.
   *
   * Revoking is as important as granting: if the allowlisted scope is removed in
   * Launcher, the next sign-in must drop the Hub privilege too. A grant that
   * only ever accumulates is a privilege ratchet.
   */
  async syncPlatformAdmin(memberId, { granted, grantedVia }) {
    if (granted) {
      await this.pool.query(
        `INSERT INTO iam.platform_admins (member_id, granted_via)
         VALUES ($1, $2)
         ON CONFLICT (member_id) DO UPDATE SET granted_via = EXCLUDED.granted_via, updated_at = now()`,
        [memberId, grantedVia || 'launcher-scope'],
      )
      return true
    }
    const { rowCount } = await this.pool.query(
      'DELETE FROM iam.platform_admins WHERE member_id = $1',
      [memberId],
    )
    if (rowCount > 0) {
      await this.pool.query(
        `INSERT INTO iam.identity_events (member_id, event_type, detail)
         VALUES ($1, 'platform_admin.revoked', '{"reason":"scope no longer present"}'::jsonb)`,
        [memberId],
      )
    }
    return false
  }

  async listTenantMemberships(memberId) {
    const { rows } = await this.pool.query(
      `SELECT m.id, m.tenant_id, m.role, m.status, t.name AS tenant_name
         FROM iam.tenant_memberships m
         JOIN tenants t ON t.id = m.tenant_id
        WHERE m.member_id = $1
        ORDER BY t.name`,
      [memberId],
    )
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      tenantName: row.tenant_name,
      role: row.role,
      status: row.status,
    }))
  }

  async listMembers() {
    const { rows } = await this.pool.query(
      `SELECT m.id, m.display_name, m.status, m.created_at,
              (a.member_id IS NOT NULL) AS platform_admin,
              coalesce(
                json_agg(
                  json_build_object('tenantId', tm.tenant_id, 'role', tm.role, 'status', tm.status)
                ) FILTER (WHERE tm.id IS NOT NULL),
                '[]'::json
              ) AS memberships
         FROM iam.members m
         LEFT JOIN iam.platform_admins a ON a.member_id = m.id
         LEFT JOIN iam.tenant_memberships tm ON tm.member_id = m.id
        GROUP BY m.id, a.member_id
        ORDER BY m.created_at DESC`,
    )
    return rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      status: row.status,
      platformAdmin: row.platform_admin,
      memberships: row.memberships,
      createdAt: iso(row.created_at),
    }))
  }

  async grantTenantMembership({ memberId, tenantId, role, grantedBy }) {
    const { rows } = await this.pool.query(
      `INSERT INTO iam.tenant_memberships (id, member_id, tenant_id, role, granted_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (member_id, tenant_id) DO UPDATE SET
         role = EXCLUDED.role, status = 'active', granted_by = EXCLUDED.granted_by, updated_at = now()
       RETURNING id, member_id, tenant_id, role, status`,
      [randomUUID(), memberId, tenantId, role, grantedBy],
    )
    await this.pool.query(
      `INSERT INTO iam.identity_events (member_id, event_type, detail)
       VALUES ($1, 'membership.granted', $2)`,
      [memberId, { tenantId, role, grantedBy }],
    )
    const row = rows[0]
    return { id: row.id, memberId: row.member_id, tenantId: row.tenant_id, role: row.role, status: row.status }
  }

  async revokeTenantMembership({ memberId, tenantId, revokedBy }) {
    const { rowCount } = await this.pool.query(
      `UPDATE iam.tenant_memberships SET status = 'suspended', updated_at = now()
        WHERE member_id = $1 AND tenant_id = $2`,
      [memberId, tenantId],
    )
    if (rowCount === 0) throw new AppError(404, 'membership_not_found', 'Membership not found')
    await this.pool.query(
      `INSERT INTO iam.identity_events (member_id, event_type, detail)
       VALUES ($1, 'membership.revoked', $2)`,
      [memberId, { tenantId, revokedBy }],
    )
    return { memberId, tenantId, status: 'suspended' }
  }
}

function dataCenterDataset(row) {
  return {
    datasetId: row.dataset_id,
    platforms: row.platforms || [],
    objectTypes: row.object_types || [],
    contentTypes: row.content_types || [],
    activeRecordCount: Number(row.active_record_count || 0),
    deletedRecordCount: Number(row.deleted_record_count || 0),
    revisionCount: Number(row.revision_count || 0),
    lastCollectedAt: iso(row.last_collected_at),
    lastEventAt: iso(row.last_event_at),
  }
}

function dataCenterRecord(row) {
  return {
    id: row.id,
    datasetId: row.dataset_id,
    platform: row.platform,
    objectType: row.object_type,
    contentType: row.content_type,
    externalId: row.external_id,
    title: row.title,
    currentRevision: Number(row.current_revision),
    eventTime: iso(row.event_time),
    collectedAt: iso(row.collected_at),
    deletedAt: iso(row.deleted_at),
  }
}

function dataCenterRecordDetail(row) {
  return {
    ...dataCenterRecord(row),
    identityHash: row.identity_hash,
    schemaVersion: row.schema_version,
    payloadSha256: row.payload_sha256,
    url: row.url,
    body: row.body,
    authorExternalId: row.author_external_id,
    authorName: row.author_name,
    latitude: row.latitude == null ? null : Number(row.latitude),
    longitude: row.longitude == null ? null : Number(row.longitude),
    countryCode: row.country_code,
    admin1Code: row.admin1_code,
    admin2Code: row.admin2_code,
    stableFields: row.stable_fields || {},
    extensions: row.extensions || {},
    metrics: row.stable_fields?.metrics || {},
    rawPayload: row.raw_payload ?? null,
    lineage: {
      parserVersion: row.parser_version ?? null,
      ingestRunId: row.ingest_run_id ?? null,
      externalImportRunId: row.external_import_run_id ?? null,
    },
    projectionRevision: Number(row.projection_revision || 0),
    firstSeenAt: iso(row.first_seen_at),
    lastSeenAt: iso(row.last_seen_at),
    highlight: null,
  }
}

function externalSource(row) {
  return row && {
    id: row.id,
    sourceKey: row.source_key,
    displayName: row.display_name,
    sourceKind: row.source_kind,
    datasetId: row.dataset_id,
    platform: row.platform,
    objectType: row.object_type,
    status: row.status,
    connection: row.connection,
    syncIntervalSeconds: row.sync_interval_seconds == null ? null : Number(row.sync_interval_seconds),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function sourceMapping(row) {
  return row && {
    id: row.id,
    sourceId: row.source_id,
    version: row.version,
    fieldMap: row.field_map,
    origin: row.origin,
    agentModel: row.agent_model,
    agentConfidence: row.agent_confidence === null ? null : Number(row.agent_confidence),
    notes: row.notes,
    schemaFingerprint: row.schema_fingerprint ?? null,
    fileStructure: row.file_structure ?? null,
    formatRuleVersionId: row.format_rule_version_id ?? null,
    selectedRuleKey: row.selected_rule_key ?? null,
    approved: Boolean(row.approved_at),
    approvedAt: iso(row.approved_at),
    approvedBy: row.approved_by,
    createdAt: iso(row.created_at),
  }
}

function fileFormatRule(row) {
  if (!row) return null
  return {
    ruleId: row.rule_id,
    ruleKey: row.rule_key,
    displayName: row.display_name,
    datasetId: row.dataset_id,
    platform: row.platform,
    objectType: row.object_type,
    versionId: row.version_id ?? null,
    version: row.version == null ? null : Number(row.version),
    schemaFingerprint: row.schema_fingerprint ?? null,
    fieldMap: row.field_map ?? null,
    parserFamily: row.parser_family ?? null,
    inputFormat: row.input_format ?? null,
    fileStructure: row.file_structure ?? null,
  }
}

function fileObservation(row) {
  return row && {
    id: row.id,
    sourceId: row.source_id,
    rootId: row.root_id,
    relativePath: row.relative_path,
    pathHash: row.path_hash,
    inputSha256: row.input_sha256,
    inputBytes: Number(row.input_bytes),
    mtime: iso(row.source_mtime),
    schemaFingerprint: row.schema_fingerprint ?? null,
    formatRuleVersionId: row.format_rule_version_id ?? null,
    importRunId: row.import_run_id ?? null,
    status: row.status,
    firstSeenAt: iso(row.first_seen_at),
    lastSeenAt: iso(row.last_seen_at),
  }
}

function pipelineWriterContractAttestation(row) {
  return row && {
    id: row.id,
    pipelineKey: row.pipeline_key,
    contractVersion: row.contract_version,
    contractDigest: row.contract_digest,
    contractSummary: row.contract_summary,
    attestedBy: row.attested_by,
    attestedAt: iso(row.attested_at),
  }
}

function importRun(row) {
  return row && {
    id: row.id,
    sourceId: row.source_id,
    mappingVersion: row.mapping_version,
    inputName: row.input_name,
    inputBytes: row.input_bytes === null ? null : Number(row.input_bytes),
    status: row.status,
    rowCount: row.row_count,
    ingestedCount: row.ingested_count,
    rejectedCount: row.rejected_count,
    changedCount: Number(row.changed_count ?? 0),
    deletedCount: Number(row.deleted_count ?? 0),
    batchCount: Number(row.batch_count ?? 0),
    trigger: row.trigger ?? null,
    cursorStart: row.cursor_start ?? null,
    cursorEnd: row.cursor_end ?? null,
    lastError: row.last_error,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
  }
}

function importRunBatch(row) {
  return row && {
    key: row.batch_key,
    cursorStart: row.cursor_start ?? null,
    cursorEnd: row.cursor_end ?? null,
    rowCount: Number(row.row_count),
    ingested: Number(row.ingested_count),
    changed: Number(row.changed_count),
    deleted: Number(row.deleted_count),
    rejected: Number(row.rejected_count),
    status: row.status,
    errorCode: row.error_code ?? null,
    pageFingerprint: row.page_fingerprint ?? null,
  }
}

async function saveCursorInTransaction(client, id, position, {
  status,
  processedDelta = 0,
  error = null,
}) {
  const { rows } = await client.query(
    `INSERT INTO mxq.cursors
       (id, position, status, processed_count, last_error, started_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())
     ON CONFLICT (id) DO UPDATE SET
       position = EXCLUDED.position,
       status = EXCLUDED.status,
       processed_count = mxq.cursors.processed_count + $4,
       last_error = EXCLUDED.last_error,
       updated_at = now()
     RETURNING *`,
    [id, position, status, processedDelta, error],
  )
  return rows[0]
}

// Local transaction helper. mx-common exports an equivalent, but the store
// receives a pool rather than the shared config and should not reach into the
// package for one three-line function.
async function withPgTransaction(pool, fn, {
  outcomeUnknownCode = null,
  sessionClient = null,
} = {}) {
  const client = sessionClient ?? await pool.connect()
  let commitStarted = false
  let committed = false
  let releaseError = null
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    commitStarted = true
    await client.query('COMMIT')
    committed = true
    return result
  } catch (error) {
    if (commitStarted && !committed && outcomeUnknownCode) {
      releaseError = error
      const unknown = new AppError(
        503,
        outcomeUnknownCode,
        'The transaction outcome is unknown; retry the same operation',
      )
      unknown.cause = error
      throw unknown
    }
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    if (!sessionClient) client.release(releaseError)
  }
}

function summarizeAggregates(rows) {
  const byPlatform = {}
  const byCapability = {}
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
    if (row.capability) byCapability[row.capability] = entry
    else byPlatform[row.platform] = entry
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
    byCapability,
  }
}

export async function createPostgresStore(options) {
  const { Pool } = await import('pg')
  return new PostgresStore(new Pool(options))
}
