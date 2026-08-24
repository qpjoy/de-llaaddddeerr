import { randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { CANONICAL_CONTEXT_DATASETS } from '../data/canonical-context.mjs'
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

const connectorCallOutcomes = new Set(['complete', 'partial', 'failed', 'unknown'])
const connectorSourceModes = new Set(['live', 'stale'])
const connectorFailureKinds = new Set(['network', 'timeout', 'http', 'contract', 'business', 'internal', 'unknown'])
const transientHttpStatuses = new Set([502, 503, 504])
// pg_get_indexdef(indexOid, columnNo, pretty) returns only the key expression.
// PostgreSQL stores DESC (bit 0) and NULLS FIRST (bit 1) separately in
// pg_index.indoption, so both pieces are required for an exact index contract.
function canonicalContextDatasetEntries(datasets) {
  if (!datasets || typeof datasets !== 'object' || Array.isArray(datasets)) {
    throw new Error('Canonical context dataset registry must be an object')
  }
  const entries = Object.entries(datasets)
  if (entries.length === 0) throw new Error('Canonical context dataset registry must not be empty')
  const indexNames = new Set()
  for (const [datasetId, dataset] of entries) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(datasetId)) {
      throw new Error(`Canonical context dataset id is unsafe: ${datasetId}`)
    }
    if (dataset?.objectType !== 'message') {
      throw new Error(`Canonical context dataset must contain messages: ${datasetId}`)
    }
    if (!/^[a-z][a-z0-9_]*$/.test(dataset.servingIndexName ?? '')) {
      throw new Error(`Canonical context serving index name is unsafe: ${datasetId}`)
    }
    if (indexNames.has(dataset.servingIndexName)) {
      throw new Error(`Canonical context serving index name is duplicated: ${dataset.servingIndexName}`)
    }
    indexNames.add(dataset.servingIndexName)
  }
  return entries
}

function canonicalContextQueryBranch(datasetId, position, side) {
  const before = side === 'before'
  const comparison = before ? '<' : '>'
  const direction = before ? 'DESC' : 'ASC'
  const limit = before ? '$2' : '$3'
  return {
    name: `context_${position}_${side}`,
    sql: `context_${position}_${side} AS (
         SELECT '${side}'::text AS side,
                row_number() OVER (ORDER BY r.event_time ${direction}, r.id ${direction}) AS side_position,
                r.id, r.dataset_id, r.platform, r.object_type, r.content_type,
                r.external_id, r.url, r.title, r.body, r.author_external_id, r.author_name,
                r.event_time, r.collected_at, r.stable_fields,
                r.stable_fields #>> '{relations,chatId}' AS context_id
           FROM anchor a
           CROSS JOIN LATERAL (
             SELECT id, dataset_id, platform, object_type, content_type,
                    external_id, url, title, body, author_external_id, author_name,
                    event_time, collected_at, stable_fields
               FROM core.canonical_records r
              WHERE a.dataset_id = '${datasetId}'
                AND a.object_type = 'message'
                AND a.event_time IS NOT NULL
                AND a.context_id IS NOT NULL
                AND r.dataset_id = '${datasetId}'
                AND r.platform = 'telegram'
                AND r.object_type = 'message'
                AND r.deleted_at IS NULL
                AND r.event_time IS NOT NULL
                AND r.stable_fields #>> '{relations,chatId}' IS NOT NULL
                AND r.stable_fields #>> '{relations,chatId}' = a.context_id
                AND (r.event_time, r.id) ${comparison} (a.event_time, a.id)
              ORDER BY r.event_time ${direction}, r.id ${direction}
              LIMIT ${limit}
           ) r
       )`,
  }
}

export function buildCanonicalContextStoragePlan(datasets = CANONICAL_CONTEXT_DATASETS) {
  const entries = canonicalContextDatasetEntries(datasets)
  const indexContracts = entries.map(([datasetId, dataset]) => Object.freeze({
    datasetId,
    name: dataset.servingIndexName,
    keys: Object.freeze([
      Object.freeze({ expression: "stable_fields #>> '{relations,chatId}'", options: 0 }),
      Object.freeze({ expression: 'event_time', options: 3 }),
      Object.freeze({ expression: 'id', options: 3 }),
    ]),
    predicate: Object.freeze([
      `dataset_id = '${datasetId}'`,
      "platform = 'telegram'",
      "object_type = 'message'",
      'deleted_at IS NULL',
    ]),
  }))
  const branches = entries.flatMap(([datasetId], position) => [
    canonicalContextQueryBranch(datasetId, position, 'before'),
    canonicalContextQueryBranch(datasetId, position, 'after'),
  ])
  const querySql = `WITH anchor AS MATERIALIZED (
         SELECT 'current'::text AS side,
                0::bigint AS side_position,
                id, dataset_id, platform, object_type, content_type,
                external_id, url, title, body, author_external_id, author_name,
                event_time, collected_at, stable_fields,
                stable_fields #>> '{relations,chatId}' AS context_id
           FROM core.canonical_records
          WHERE id = $1::uuid
            AND platform = 'telegram'
            AND deleted_at IS NULL
       ), ${branches.map((branch) => branch.sql).join(', ')}
       SELECT * FROM anchor
       ${branches.map((branch) => `UNION ALL SELECT * FROM ${branch.name}`).join('\n       ')}
       ORDER BY side, side_position`
  return Object.freeze({
    indexContracts: Object.freeze(indexContracts),
    querySql,
  })
}

const CANONICAL_CONTEXT_STORAGE_PLAN = buildCanonicalContextStoragePlan()
const CANONICAL_CONTEXT_SERVING_INDEX_CONTRACTS = CANONICAL_CONTEXT_STORAGE_PLAN.indexContracts
const CANONICAL_CONTEXT_QUERY_SQL = CANONICAL_CONTEXT_STORAGE_PLAN.querySql
const PUBLIC_OPINION_SERVING_INDEX_CONTRACTS = Object.freeze([
  {
    name: 'canonical_province_opinion_hot_idx',
    keys: [
      { expression: 'admin1_code', options: 0 },
      { expression: 'heat_score', options: 1 },
      { expression: 'coalesce(event_time, collected_at)', options: 1 },
      { expression: 'id', options: 3 },
    ],
    predicate: [
      "dataset_id = 'public-opinion.province.v1'",
      "platform = 'public_opinion'",
      "object_type = 'opinion_item'",
      'deleted_at IS NULL',
      'admin1_code IS NOT NULL',
      'heat_score IS NOT NULL',
      'collected_at IS NOT NULL',
    ],
  },
  {
    name: 'canonical_province_opinion_latest_idx',
    keys: [
      { expression: 'admin1_code', options: 0 },
      { expression: 'coalesce(event_time, collected_at)', options: 1 },
      { expression: 'collected_at', options: 1 },
      { expression: 'id', options: 3 },
    ],
    predicate: [
      "dataset_id = 'public-opinion.province.v1'",
      "platform = 'public_opinion'",
      "object_type = 'opinion_item'",
      'deleted_at IS NULL',
      'admin1_code IS NOT NULL',
      'collected_at IS NOT NULL',
    ],
  },
])

function lowerSqlOutsideLiterals(value) {
  const input = String(value ?? '')
  let output = ''
  let inLiteral = false
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]
    if (character === "'") {
      output += character
      if (inLiteral && input[index + 1] === "'") {
        output += input[index + 1]
        index += 1
      } else {
        inLiteral = !inLiteral
      }
    } else {
      output += inLiteral ? character : character.toLowerCase()
    }
  }
  return output
}

function normalizeIndexFragment(value) {
  return lowerSqlOutsideLiterals(value)
    .replace(/::(?:text(?:\[\])?|character varying)/g, '')
    .replace(/[()"\s]/g, '')
}

function normalizedPredicateTerms(value) {
  return normalizeIndexFragment(value).split('and').filter(Boolean).sort()
}

function servingIndexMatches(row, contract) {
  if (
    row?.indisready !== true
    || row?.indisvalid !== true
    || row?.indislive !== true
    || row?.access_method !== 'btree'
    || Number(row?.key_count) !== contract.keys.length
  ) return false
  const actualKeys = [row.key_1, row.key_2, row.key_3, row.key_4]
    .slice(0, contract.keys.length)
    .map(normalizeIndexFragment)
  const expectedKeys = contract.keys.map((key) => normalizeIndexFragment(key.expression))
  if (!actualKeys.every((key, index) => key === expectedKeys[index])) return false
  const actualOptions = [
    row.key_1_options,
    row.key_2_options,
    row.key_3_options,
    row.key_4_options,
  ].slice(0, contract.keys.length).map(Number)
  if (!actualOptions.every((options, index) => options === contract.keys[index].options)) return false
  const actualPredicate = normalizedPredicateTerms(row.predicate)
  const expectedPredicate = contract.predicate.map(normalizeIndexFragment).sort()
  return actualPredicate.length === expectedPredicate.length
    && actualPredicate.every((term, index) => term === expectedPredicate[index])
}

function compatibilityTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) {
    throw new AppError(400, 'invalid_compatibility_timestamp', 'Compatibility timestamp is invalid')
  }
  return date
}

function assertConnectorOutcome(outcome) {
  if (!connectorCallOutcomes.has(outcome)) {
    throw new AppError(400, 'invalid_connector_outcome', 'Connector outcome is invalid')
  }
}

function assertConnectorSourceMode(sourceMode) {
  if (!connectorSourceModes.has(sourceMode)) {
    throw new AppError(400, 'invalid_connector_source_mode', 'Connector source mode is invalid')
  }
}

function assertConnectorFailureKind(failureKind) {
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
    deliverySourceMode: row.delivery_source_mode,
    capturedAt: iso(row.response_captured_at),
    snapshotId: row.compatibility_snapshot_id,
    reservedAt: iso(row.reserved_at),
    leaseExpiresAt: iso(row.lease_expires_at),
    completedAt: iso(row.completed_at),
    createdAt: iso(row.created_at),
  }
}

function connectorCallRecord(row) {
  return row && {
    id: row.id,
    consumerId: row.consumer_id,
    requestId: row.usage_request_id,
    operation: row.operation,
    fingerprint: row.request_fingerprint,
    platform: row.platform,
    sourceMode: row.source_mode,
    outcome: row.outcome,
    httpStatus: row.http_status,
    businessStatus: row.business_status,
    failureKind: row.failure_kind,
    upstreamLatencyMs: row.upstream_latency_ms,
    errorCode: row.error_code,
    nightAllRequestId: row.upstream_request_id,
    nightAllTraceId: row.upstream_trace_id,
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    createdAt: iso(row.created_at),
  }
}

function compatibilitySnapshotRecord(row) {
  return row && {
    id: row.id,
    consumerId: row.consumer_id,
    operation: row.operation,
    fingerprint: row.request_fingerprint,
    platform: row.platform,
    responseBody: row.response_body,
    capturedAt: iso(row.captured_at),
    staleUntil: iso(row.stale_until),
    lastSuccessCallId: row.last_success_call_id,
    supersededAt: iso(row.superseded_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
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

/**
 * Decide whether a committed request may still be replayed verbatim.
 *
 * An Idempotency-Key exists to make a retry safe, and a retry happens within
 * seconds. Replaying forever quietly turns the key into a cache: a caller that
 * reuses one keeps receiving a frozen answer while the data underneath moves,
 * which is wrong for a search over a corpus that ingests continuously.
 *
 * A null window keeps the unbounded behaviour, which is what the `stable`
 * result type is for -- there it is the point, not an accident.
 */
function replayExpired(existing, replayWindowMs) {
  if (replayWindowMs == null) return false
  if (!existing.completedAt) return false
  return Date.now() - new Date(existing.completedAt).getTime() > replayWindowMs
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
    const { rows } = await this.pool.query(
      `WITH reaped AS (
         UPDATE usage_requests SET
           status = 'unknown', error_code = 'reservation_lease_expired', completed_at = now()
         WHERE status = 'reserved' AND lease_expires_at IS NOT NULL AND lease_expires_at <= now()
         RETURNING id
       ), closed_calls AS (
         UPDATE serving.connector_calls call SET
           outcome = 'unknown', business_status = 'unknown', failure_kind = 'unknown',
           error_code = 'reservation_lease_expired', completed_at = now()
         FROM reaped
         WHERE call.usage_request_id = reaped.id AND call.outcome IS NULL
         RETURNING call.id
       )
       SELECT count(*)::integer AS reaped FROM reaped`,
    )
    return Number(rows[0]?.reaped || 0)
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
      if (error?.code === '23505' && /business_id/i.test(error?.constraint || error?.detail || '')) {
        throw new AppError(409, 'business_id_conflict', 'businessId is already assigned to another consumer')
      }
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

  async getUsageRequestByIdempotencyKey(consumerId, idempotencyKey) {
    const { rows } = await this.pool.query(
      `SELECT * FROM usage_requests
       WHERE consumer_id = $1 AND idempotency_key = $2`,
      [consumerId, idempotencyKey],
    )
    return requestRecord(rows[0]) || null
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
        else if (existing.status === 'committed' && !replayExpired(existing, input.replayWindowMs)) {
          kind = 'replay'
        } else if (existing.status === 'reserved') kind = 'in_progress'
        else if (existing.status === 'unknown') kind = 'unknown'
        else {
          await this.#assertQuota(client, input)
          const updated = await client.query(
            `UPDATE usage_requests SET
               status = 'reserved', api_key_id = $2, units_reserved = $3,
               reserved_at = now(), lease_expires_at = $4,
               units_actual = NULL, response_status = NULL, response_body = NULL,
               upstream_latency_ms = NULL, delivery_source_mode = NULL,
               response_captured_at = NULL, compatibility_snapshot_id = NULL,
               completed_at = NULL, error_code = NULL
             WHERE id = $1 RETURNING *`,
            [existing.id, input.apiKeyId, input.unitsReserved, input.leaseExpiresAt],
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

  async beginConnectorCall({
    id = randomUUID(),
    consumerId,
    requestId = null,
    operation,
    fingerprint,
    platform = null,
    sourceMode = 'live',
  }) {
    if (!/^[a-z][a-z0-9._-]{0,127}$/.test(operation || '')) {
      throw new AppError(400, 'invalid_connector_operation', 'Connector operation is invalid')
    }
    if (!/^[0-9a-f]{64}$/.test(fingerprint || '')) {
      throw new AppError(400, 'invalid_connector_fingerprint', 'Connector fingerprint is invalid')
    }
    assertConnectorSourceMode(sourceMode)
    const { rows } = await this.pool.query(
      `INSERT INTO serving.connector_calls
         (id, consumer_id, usage_request_id, operation, request_fingerprint,
          platform, source_mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [id, consumerId, requestId, operation, fingerprint, platform, sourceMode],
    )
    return connectorCallRecord(rows[0])
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
    assertConnectorSourceMode(sourceMode)
    assertConnectorFailureKind(failureKind)
    const { rows } = await this.pool.query(
      `UPDATE serving.connector_calls SET
         outcome = $2, http_status = $3, business_status = $4,
         failure_kind = $5, upstream_latency_ms = $6, error_code = $7,
         source_mode = $8, upstream_request_id = $9, upstream_trace_id = $10,
         completed_at = now()
       WHERE id = $1 AND outcome IS NULL
       RETURNING *`,
      [
        id, outcome, httpStatus, businessStatus, failureKind, upstreamLatencyMs,
        errorCode, sourceMode, nightAllRequestId, nightAllTraceId,
      ],
    )
    if (!rows[0]) throw new AppError(404, 'connector_call_not_found', 'Connector call not found')
    return connectorCallRecord(rows[0])
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
    job = null,
  }) {
    if (!['complete', 'partial'].includes(outcome)) {
      throw new AppError(400, 'invalid_live_delivery_outcome', 'Live delivery must be complete or partial')
    }
    if (responseBody === undefined) {
      throw new AppError(400, 'compatibility_response_required', 'Live delivery requires a response body')
    }
    assertConnectorFailureKind(failureKind)
    const captured = compatibilityTimestamp(capturedAt)
    let stale = null
    if (outcome === 'complete') {
      if (staleUntil == null) {
        throw new AppError(400, 'compatibility_stale_until_required', 'Complete live delivery requires staleUntil')
      }
      stale = compatibilityTimestamp(staleUntil)
      if (stale < captured) {
        throw new AppError(400, 'invalid_compatibility_stale_until', 'staleUntil must not precede capturedAt')
      }
    }

    return withPgTransaction(this.pool, async (client) => {
      const locked = await client.query(
        `SELECT * FROM serving.connector_calls
         WHERE id = $1 AND outcome IS NULL
         FOR UPDATE`,
        [id],
      )
      const call = locked.rows[0]
      if (!call) throw new AppError(404, 'connector_call_not_found', 'Connector call not found')

      let snapshot = null
      if (outcome === 'complete') {
        const snapshotLockKey = `${call.consumer_id}:${call.operation}:${call.request_fingerprint}`
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [snapshotLockKey],
        )
        const current = await client.query(
          `SELECT * FROM serving.compatibility_snapshots
           WHERE consumer_id = $1 AND operation = $2 AND request_fingerprint = $3
             AND superseded_at IS NULL
           FOR UPDATE`,
          [call.consumer_id, call.operation, call.request_fingerprint],
        )
        const currentSnapshot = current.rows[0] || null
        if (!currentSnapshot || new Date(currentSnapshot.captured_at) <= captured) {
          if (currentSnapshot) {
            await client.query(
              `UPDATE serving.compatibility_snapshots
               SET superseded_at = now(), updated_at = now()
               WHERE id = $1 AND superseded_at IS NULL`,
              [currentSnapshot.id],
            )
          }
          const stored = await client.query(
            `INSERT INTO serving.compatibility_snapshots
               (id, consumer_id, operation, request_fingerprint, platform,
                response_body, captured_at, stale_until, last_success_call_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING *`,
            [
              randomUUID(), call.consumer_id, call.operation, call.request_fingerprint,
              call.platform, responseBody, captured, stale, id,
            ],
          )
          snapshot = stored.rows[0] || null
        }
      }

      const committed = await client.query(
        `UPDATE usage_requests SET
           status = 'committed', response_status = $2, response_body = $3,
           units_actual = $4, upstream_latency_ms = $5,
           delivery_source_mode = 'live', response_captured_at = $6,
           compatibility_snapshot_id = $7, completed_at = now()
         WHERE id = $1 AND consumer_id = $8 AND status = 'reserved'
         RETURNING *`,
        [
          call.usage_request_id, responseStatus, responseBody, unitsActual,
          upstreamLatencyMs, captured, snapshot?.id || null, call.consumer_id,
        ],
      )
      if (!committed.rows[0]) throw new AppError(404, 'request_not_found', 'Request not found')

      const completed = await client.query(
        `UPDATE serving.connector_calls SET
           outcome = $2, http_status = $3, business_status = $4,
           failure_kind = $5, upstream_latency_ms = $6, error_code = $7,
           source_mode = 'live', upstream_request_id = $8, upstream_trace_id = $9,
           completed_at = now()
         WHERE id = $1 AND outcome IS NULL
         RETURNING *`,
        [
          id, outcome, httpStatus, businessStatus, failureKind, upstreamLatencyMs,
          errorCode, nightAllRequestId, nightAllTraceId,
        ],
      )
      if (!completed.rows[0]) {
        throw new AppError(409, 'connector_call_state_conflict', 'Connector call is already complete')
      }

      if (job) {
        await client.query(
          `INSERT INTO mxq.jobs (queue, payload, dedupe_key, priority)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (queue, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','running')
           DO NOTHING`,
          [job.queue, job.payload, job.dedupeKey, job.priority ?? 100],
        )
      }

      return {
        request: requestRecord(committed.rows[0]),
        call: connectorCallRecord(completed.rows[0]),
        snapshot: compatibilitySnapshotRecord(snapshot),
      }
    }, { outcomeUnknownCode: 'compatibility_delivery_outcome_unknown' })
  }

  async findUsableCompatibilitySnapshot({ consumerId, operation, fingerprint, at = new Date() }) {
    const { rows } = await this.pool.query(
      `SELECT * FROM serving.compatibility_snapshots
       WHERE consumer_id = $1 AND operation = $2 AND request_fingerprint = $3
         AND superseded_at IS NULL AND stale_until >= $4`,
      [consumerId, operation, fingerprint, compatibilityTimestamp(at)],
    )
    return compatibilitySnapshotRecord(rows[0]) || null
  }

  async commitCompatibilityStaleDelivery(id, {
    snapshotId,
    responseStatus = 200,
    unitsActual = 1,
    httpStatus = null,
    businessStatus = null,
    failureKind,
    upstreamLatencyMs = null,
    errorCode = null,
    nightAllRequestId = null,
    nightAllTraceId = null,
    at = new Date(),
  }) {
    assertTransientFallback({ failureKind, httpStatus })
    const deliveredAt = compatibilityTimestamp(at)
    return withPgTransaction(this.pool, async (client) => {
      const locked = await client.query(
        `SELECT * FROM serving.connector_calls
         WHERE id = $1 AND outcome IS NULL
         FOR UPDATE`,
        [id],
      )
      const call = locked.rows[0]
      if (!call) throw new AppError(404, 'connector_call_not_found', 'Connector call not found')

      const found = await client.query(
        `SELECT * FROM serving.compatibility_snapshots
         WHERE id = $1 AND consumer_id = $2 AND operation = $3
           AND request_fingerprint = $4 AND stale_until >= $5
         FOR SHARE`,
        [
          snapshotId, call.consumer_id, call.operation, call.request_fingerprint,
          deliveredAt,
        ],
      )
      const snapshot = found.rows[0]
      if (!snapshot) {
        throw new AppError(409, 'compatibility_snapshot_unavailable', 'Compatibility snapshot is unavailable')
      }

      const committed = await client.query(
        `UPDATE usage_requests SET
           status = 'committed', response_status = $2, response_body = $3,
           units_actual = $4, upstream_latency_ms = $5,
           delivery_source_mode = 'stale', response_captured_at = $6,
           compatibility_snapshot_id = $7, completed_at = $8
         WHERE id = $1 AND consumer_id = $9 AND status = 'reserved'
         RETURNING *`,
        [
          call.usage_request_id, responseStatus, snapshot.response_body, unitsActual,
          upstreamLatencyMs, snapshot.captured_at, snapshot.id, deliveredAt,
          call.consumer_id,
        ],
      )
      if (!committed.rows[0]) throw new AppError(404, 'request_not_found', 'Request not found')

      const completed = await client.query(
        `UPDATE serving.connector_calls SET
           outcome = $2, http_status = $3, business_status = $4,
           failure_kind = $5, upstream_latency_ms = $6, error_code = $7,
           source_mode = 'stale', upstream_request_id = $8, upstream_trace_id = $9,
           completed_at = $10
         WHERE id = $1 AND outcome IS NULL
         RETURNING *`,
        [
          id, failureKind === 'http' ? 'failed' : 'unknown',
          httpStatus, businessStatus, failureKind, upstreamLatencyMs, errorCode,
          nightAllRequestId, nightAllTraceId, deliveredAt,
        ],
      )
      if (!completed.rows[0]) {
        throw new AppError(409, 'connector_call_state_conflict', 'Connector call is already complete')
      }

      return {
        request: requestRecord(committed.rows[0]),
        call: connectorCallRecord(completed.rows[0]),
        snapshot: compatibilitySnapshotRecord(snapshot),
      }
    }, { outcomeUnknownCode: 'compatibility_delivery_outcome_unknown' })
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
    apiSearchLineage = null,
  }) {
    if (records.length === 0 && !apiSearchLineage) return { ingested: 0, changed: 0 }
    if (apiSearchLineage && importRunId) {
      throw new AppError(400, 'ambiguous_ingest_lineage', 'API search and external import lineage cannot be combined')
    }
    if (apiSearchLineage && (
      !apiSearchLineage.requestId
      || !apiSearchLineage.queryFingerprint
      || !apiSearchLineage.connectorCallId
    )) {
      throw new AppError(400, 'incomplete_api_search_lineage', 'API search lineage is incomplete')
    }
    const stream = apiSearchLineage
      ? `${platform}.night-all-compat.v1`
      : `${platform}.external.v1`
    const client = sessionClient ?? await this.pool.connect()
    let changed = 0
    let deleted = 0
    let ingestRunId = null
    let commitStarted = false
    let committed = false
    let releaseError = null
    try {
      await client.query('BEGIN')
      if (apiSearchLineage) {
        const runId = randomUUID()
        const inserted = await client.query(
          `INSERT INTO ingest.ingest_runs
             (id, connector_id, stream_id, trigger, request_id, query_fingerprint,
              connector_call_id)
           SELECT $1, $2, $3, 'api_search', $4, $5, $6
             FROM serving.connector_calls call
            WHERE call.id = $6
              AND call.usage_request_id = $4
              AND call.request_fingerprint = $5
              AND call.outcome IN ('complete', 'partial')
           ON CONFLICT (connector_call_id) WHERE connector_call_id IS NOT NULL
           DO NOTHING
           RETURNING id`,
          [
            runId, connectorId, stream, apiSearchLineage.requestId,
            apiSearchLineage.queryFingerprint, apiSearchLineage.connectorCallId,
          ],
        )
        ingestRunId = inserted.rows[0]?.id || null
        if (!ingestRunId) {
          const existingResult = await client.query(
            `SELECT id, request_id, query_fingerprint, item_count, finished_at
               FROM ingest.ingest_runs
              WHERE connector_call_id = $1`,
            [apiSearchLineage.connectorCallId],
          )
          const existing = existingResult.rows[0]
          if (!existing
            || existing.request_id !== apiSearchLineage.requestId
            || existing.query_fingerprint !== apiSearchLineage.queryFingerprint) {
            throw new AppError(
              409,
              'api_search_lineage_mismatch',
              'Connector call does not match this API search lineage',
            )
          }
          if (!existing.finished_at) {
            throw new AppError(409, 'api_search_ingest_in_progress', 'API search ingestion is already in progress')
          }
          commitStarted = true
          await client.query('COMMIT')
          committed = true
          return {
            ingested: Number(existing.item_count),
            changed: 0,
            deleted: 0,
            rowCount: Number(existing.item_count),
            replayed: true,
            runId: existing.id,
          }
        }
      }
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

      const sourceRunColumn = apiSearchLineage ? 'ingest_run_id' : 'external_import_run_id'
      const sourceRunId = apiSearchLineage ? ingestRunId : importRunId
      for (const record of records) {
        if (record.deletedAt != null) deleted += 1
        const rawPayloadSha256 = record.rawPayloadSha256 || record.payloadSha256
        const sourceObjectResult = await client.query(
          `INSERT INTO ingest.source_objects
             (id, connector_id, stream_id, object_type, source_key,
              payload_sha256, raw_payload_hash_version, raw_payload,
              source_updated_at, ${sourceRunColumn})
           VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9)
           ON CONFLICT (connector_id, stream_id, object_type, source_key) DO UPDATE SET
             payload_sha256 = EXCLUDED.payload_sha256,
             raw_payload_hash_version = 1,
             raw_payload = EXCLUDED.raw_payload,
             source_updated_at = EXCLUDED.source_updated_at,
             ${sourceRunColumn} = EXCLUDED.${sourceRunColumn},
             current_revision = ingest.source_objects.current_revision
               + CASE
                   WHEN ingest.source_objects.raw_payload_hash_version = 0 THEN
                     ((CASE
                         WHEN ingest.source_objects.connector_id = 'external:province-opinion-results'
                           THEN ingest.source_objects.raw_payload - 'updated_at'
                         ELSE ingest.source_objects.raw_payload
                       END) IS DISTINCT FROM
                      (CASE
                         WHEN EXCLUDED.connector_id = 'external:province-opinion-results'
                           THEN EXCLUDED.raw_payload - 'updated_at'
                         ELSE EXCLUDED.raw_payload
                       END))::int
                   ELSE (ingest.source_objects.payload_sha256
                     IS DISTINCT FROM EXCLUDED.payload_sha256)::int
                 END,
             last_seen_at = now()
           RETURNING id, current_revision, raw_payload_hash_version`,
          [
            randomUUID(), connectorId, stream, record.objectType, record.externalId,
            rawPayloadSha256, record.rawItem, record.collectedAt, sourceRunId,
          ],
        )

        // Preserve every distinct raw payload independently from canonical
        // revisions. Province/source/model evidence may change without changing
        // public text, and delayed Agent work must still read the exact source
        // revision that justified it.
        const sourceObject = sourceObjectResult.rows[0]
        const sourceRevisionResult = await client.query(
          `WITH inserted AS (
             INSERT INTO ingest.source_object_revisions
               (source_object_id, revision, payload_sha256, payload_hash_version, raw_payload,
                source_updated_at, ${sourceRunColumn})
             VALUES ($1, $2, $3, 1, $4, $5, $6)
             ON CONFLICT (source_object_id, revision) DO NOTHING
             RETURNING id
           )
           SELECT id FROM inserted
           UNION ALL
           SELECT id FROM ingest.source_object_revisions
            WHERE source_object_id = $1 AND revision = $2
           LIMIT 1`,
          [
            sourceObject.id, Number(sourceObject.current_revision), rawPayloadSha256,
            record.rawItem, record.collectedAt, sourceRunId,
          ],
        )

        const upserted = await client.query(
          `INSERT INTO core.canonical_records
             (id, dataset_id, platform, object_type, external_id, schema_version,
              payload_sha256, content_type, url, title, body,
              author_external_id, author_name, event_time, collected_at,
              latitude, longitude, country_code, admin1_code, admin2_code,
              stable_fields, extensions, deleted_at, heat_score)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                   $16, $17, $18, $19, $20, $21, $22, $23, $24)
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
             heat_score = EXCLUDED.heat_score,
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
            record.stableFields, record.extensions, record.deletedAt, record.heatScore,
          ],
        )
        const { id, current_revision: revision, projection_revision: projection } = upserted.rows[0]

        const revisionInsert = await client.query(
          `INSERT INTO core.record_revisions
             (record_id, revision, payload_sha256, normalized_payload, parser_version, ${sourceRunColumn})
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (record_id, revision) DO NOTHING`,
          [id, revision, record.payloadSha256, record.rawItem, record.parserVersion, sourceRunId],
        )
        if (revisionInsert.rowCount > 0) changed += 1

        if (datasetId === 'public-opinion.province.v1') {
          const sourceRevisionId = sourceRevisionResult.rows[0]?.id
          if (!sourceRevisionId) {
            throw new Error('current source object revision was not materialized')
          }
          // Domain work is created in the same transaction as its immutable raw
          // evidence. The canonical revision is part of task identity, so a
          // mapping/normalizer change over unchanged raw evidence is analyzed
          // again instead of being swallowed by the old task's unique key.
          // Model availability never blocks this commit; a dedicated classifier
          // claims the task later under its own lease/rate policy.
          await client.query(
            `INSERT INTO agent_center.analysis_tasks
               (pipeline_key, record_id, source_object_revision_id,
                canonical_revision, input_sha256, analysis_version,
                taxonomy_version, rule_version, prompt_version)
             SELECT pipeline_key, $1, $2, $3, $4, analysis_version,
                    taxonomy_version, rule_version, prompt_version
               FROM control.agent_analysis_pipelines
              WHERE pipeline_key = 'province-geography-v1'
             ON CONFLICT
               (pipeline_key, record_id, source_object_revision_id,
                canonical_revision, analysis_version)
             DO NOTHING`,
            [id, sourceRevisionId, Number(revision), rawPayloadSha256],
          )
        }

        if (apiSearchLineage) {
          const sourceEventId = `${apiSearchLineage.connectorCallId}:${record.objectType}:${record.externalId}`
          await client.query(
            `INSERT INTO core.observations
               (id, record_id, connector_id, source_event_id, query_fingerprint,
                rank, metrics, observation_hash, ingest_run_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (record_id, observation_hash) DO NOTHING`,
            [
              randomUUID(), id, connectorId, sourceEventId,
              apiSearchLineage.queryFingerprint, record.rank ?? null,
              record.metrics || {},
              observationHash(record, apiSearchLineage.queryFingerprint, sourceEventId),
              ingestRunId,
            ],
          )
        }

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

      if (ingestRunId) {
        await client.query(
          `UPDATE ingest.ingest_runs
              SET item_count = $2, finished_at = now()
            WHERE id = $1`,
          [ingestRunId, records.length],
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
        ...(ingestRunId ? { runId: ingestRunId } : {}),
      }
    } catch (error) {
      if (commitStarted && !committed) {
        releaseError = error
        const unknown = new AppError(
          503,
          apiSearchLineage ? 'api_search_ingest_outcome_unknown' : 'external_commit_outcome_unknown',
          apiSearchLineage
            ? 'The API search ingest outcome is unknown; retry the same connector call'
            : 'The external batch commit outcome is unknown; retry the same run and batch',
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

  async getCanonicalContextServingIndexStatus() {
    const required = CANONICAL_CONTEXT_SERVING_INDEX_CONTRACTS.map((contract) => contract.name)
    const { rows } = await this.pool.query(
      `SELECT index_rel.relname AS name,
              index_meta.indisready,
              index_meta.indisvalid,
              index_meta.indislive,
              access_method.amname AS access_method,
              index_meta.indnkeyatts AS key_count,
              pg_get_indexdef(index_rel.oid, 1, true) AS key_1,
              pg_get_indexdef(index_rel.oid, 2, true) AS key_2,
              pg_get_indexdef(index_rel.oid, 3, true) AS key_3,
              index_meta.indoption[0]::integer AS key_1_options,
              index_meta.indoption[1]::integer AS key_2_options,
              index_meta.indoption[2]::integer AS key_3_options,
              pg_get_expr(index_meta.indpred, index_meta.indrelid, true) AS predicate
         FROM pg_class index_rel
         JOIN pg_namespace index_ns ON index_ns.oid = index_rel.relnamespace
         JOIN pg_index index_meta ON index_meta.indexrelid = index_rel.oid
         JOIN pg_am access_method ON access_method.oid = index_rel.relam
         JOIN pg_class table_rel ON table_rel.oid = index_meta.indrelid
         JOIN pg_namespace table_ns ON table_ns.oid = table_rel.relnamespace
        WHERE index_ns.nspname = 'core'
          AND table_ns.nspname = 'core'
          AND table_rel.relname = 'canonical_records'
          AND index_rel.relname = ANY($1::text[])`,
      [required],
    )
    const byName = new Map(rows.map((row) => [row.name, row]))
    const indexes = CANONICAL_CONTEXT_SERVING_INDEX_CONTRACTS.map((contract) => ({
      name: contract.name,
      ready: servingIndexMatches(byName.get(contract.name), contract),
    }))
    return {
      ready: indexes.every((index) => index.ready),
      required,
      indexes,
      missing: indexes.filter((index) => !index.ready).map((index) => index.name),
    }
  }

  /**
   * Resolve one canonical anchor and its nearest stored neighbors in a single
   * PostgreSQL snapshot. Each dataset branch names its partial-index predicate
   * literally so PostgreSQL can use the matching chat/time serving index.
  */
  async getCanonicalContext({ id, before, after }) {
    const { rows } = await this.pool.query(
      CANONICAL_CONTEXT_QUERY_SQL,
      [id, before + 1, after + 1],
    )
    const current = rows.find((row) => row.side === 'current') ?? null
    if (!current) return null
    const dataset = CANONICAL_CONTEXT_DATASETS[current.dataset_id]
    const contextSupported = Boolean(
      dataset
      && current.object_type === dataset.objectType
      && current.event_time
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
    const beforeRows = rows.filter((row) => row.side === 'before')
    const afterRows = rows.filter((row) => row.side === 'after')
    return {
      current,
      before: beforeRows.slice(0, before).reverse(),
      after: afterRows.slice(0, after),
      hasMoreStoredBefore: beforeRows.length > before,
      hasMoreStoredAfter: afterRows.length > after,
      contextSupported: true,
    }
  }

  /**
   * Customer-safe province feed over the current canonical PostgreSQL state.
   *
   * The SELECT is intentionally explicit and separate from Admin Data Center:
   * raw payloads, extensions, strategy ids, model reasoning and lineage never
   * cross this store boundary.
   */
  async getPublicOpinionServingIndexStatus() {
    const required = PUBLIC_OPINION_SERVING_INDEX_CONTRACTS.map((contract) => contract.name)
    const { rows } = await this.pool.query(
      `SELECT index_rel.relname AS name,
              index_meta.indisready,
              index_meta.indisvalid,
              index_meta.indislive,
              access_method.amname AS access_method,
              index_meta.indnkeyatts AS key_count,
              pg_get_indexdef(index_rel.oid, 1, true) AS key_1,
              pg_get_indexdef(index_rel.oid, 2, true) AS key_2,
              pg_get_indexdef(index_rel.oid, 3, true) AS key_3,
              pg_get_indexdef(index_rel.oid, 4, true) AS key_4,
              index_meta.indoption[0]::integer AS key_1_options,
              index_meta.indoption[1]::integer AS key_2_options,
              index_meta.indoption[2]::integer AS key_3_options,
              index_meta.indoption[3]::integer AS key_4_options,
              pg_get_expr(index_meta.indpred, index_meta.indrelid, true) AS predicate
         FROM pg_class index_rel
         JOIN pg_namespace index_ns ON index_ns.oid = index_rel.relnamespace
         JOIN pg_index index_meta ON index_meta.indexrelid = index_rel.oid
         JOIN pg_am access_method ON access_method.oid = index_rel.relam
         JOIN pg_class table_rel ON table_rel.oid = index_meta.indrelid
         JOIN pg_namespace table_ns ON table_ns.oid = table_rel.relnamespace
        WHERE index_ns.nspname = 'core'
          AND table_ns.nspname = 'core'
          AND table_rel.relname = 'canonical_records'
          AND index_rel.relname = ANY($1::text[])`,
      [required],
    )
    const byName = new Map(rows.map((row) => [row.name, row]))
    const indexes = PUBLIC_OPINION_SERVING_INDEX_CONTRACTS.map((contract) => ({
      name: contract.name,
      ready: servingIndexMatches(byName.get(contract.name), contract),
    }))
    return {
      ready: indexes.every((index) => index.ready),
      required,
      indexes,
      missing: indexes.filter((index) => !index.ready).map((index) => index.name),
    }
  }

  async listPublicOpinionRecords({
    provinceCode,
    sort,
    pageSize,
    cursor = null,
    from = null,
    to = null,
  }) {
    const select = `SELECT id, title, body, url, content_type, author_name,
                           event_time, collected_at, admin1_code, heat_score,
                           stable_fields,
                           coalesce(event_time, collected_at) AS sort_time`
    const scope = `FROM core.canonical_records
                    WHERE dataset_id = 'public-opinion.province.v1'
                      AND platform = 'public_opinion'
                      AND object_type = 'opinion_item'
                      AND deleted_at IS NULL
                      AND admin1_code = $1
                      AND collected_at IS NOT NULL
                      AND ($2::timestamptz IS NULL OR event_time >= $2::timestamptz)
                      AND ($3::timestamptz IS NULL OR event_time <= $3::timestamptz)`
    if (sort === 'hot') {
      const { rows } = await this.pool.query(
        `${select}
           ${scope}
              AND heat_score IS NOT NULL
              AND ($4::numeric IS NULL OR (heat_score, coalesce(event_time, collected_at), id) < ($4::numeric, $5::timestamptz, $6::uuid))
            ORDER BY heat_score DESC, coalesce(event_time, collected_at) DESC, id DESC
            LIMIT $7`,
        [
          provinceCode, from, to,
          cursor?.heatScore ?? null, cursor?.sortTime ?? null, cursor?.id ?? null,
          pageSize + 1,
        ],
      )
      return rows
    }
    const { rows } = await this.pool.query(
      `${select}
         ${scope}
            AND ($4::uuid IS NULL OR (coalesce(event_time, collected_at), collected_at, id) < ($5::timestamptz, $6::timestamptz, $4::uuid))
          ORDER BY coalesce(event_time, collected_at) DESC, collected_at DESC, id DESC
          LIMIT $7`,
      [
        provinceCode, from, to, cursor?.id ?? null,
        cursor?.sortTime ?? null, cursor?.collectedAt ?? null, pageSize + 1,
      ],
    )
    return rows
  }

  async getPublicOpinionRecord(id) {
    const { rows } = await this.pool.query(
      `SELECT id, title, body, url, content_type, author_name,
              event_time, collected_at, admin1_code, heat_score, stable_fields
         FROM core.canonical_records
        WHERE id = $1
          AND dataset_id = 'public-opinion.province.v1'
          AND platform = 'public_opinion'
          AND object_type = 'opinion_item'
          AND deleted_at IS NULL`,
      [id],
    )
    return rows[0] ?? null
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
   * Paginated page for the Admin Data Center record browser.
   *
   * This is deliberately separate from `dataCenter()`: the catalog/count query
   * is cheap and stable, while a user may walk many record pages. Only canonical
   * Admin operators need the canonical truth for diagnosis and curation, so
   * this page deliberately includes the current revision payload, extensions
   * and lineage. Public API projections remain separately allowlisted. Cursor
   * callers retain keyset pagination; the Admin UI may request a 1-based page
   * and pay the offset cost needed for direct page jumps.
   */
  async dataCenterRecords({
    datasetId = null,
    platform = null,
    objectType = null,
    pageSize = 50,
    cursor = null,
    page = null,
  } = {}) {
    const filterValues = []
    const filterClauses = []
    for (const [column, value] of [
      ['r.dataset_id', datasetId],
      ['r.platform', platform],
      ['r.object_type', objectType],
    ]) {
      if (!value) continue
      filterValues.push(value)
      filterClauses.push(`${column} = $${filterValues.length}`)
    }
    const values = [...filterValues]
    const clauses = [...filterClauses]
    if (cursor) {
      values.push(cursor.sortTime, cursor.id)
      clauses.push(
        `(coalesce(r.event_time, r.collected_at, r.last_seen_at, r.first_seen_at), r.id)`
        + ` < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
      )
    }
    values.push(pageSize + 1)
    const limitParameter = values.length
    let offset = ''
    if (page != null) {
      values.push((page - 1) * pageSize)
      offset = `OFFSET $${values.length}`
    }
    const filterWhere = filterClauses.length ? `WHERE ${filterClauses.join(' AND ')}` : ''
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const [countResult, recordResult] = await Promise.all([
      this.pool.query(
        `SELECT count(*)::bigint AS total
           FROM core.canonical_records r
           ${filterWhere}`,
        filterValues,
      ),
      this.pool.query(
        `WITH page AS MATERIALIZED (
         SELECT r.id,
                coalesce(r.event_time, r.collected_at, r.last_seen_at, r.first_seen_at) AS sort_time
           FROM core.canonical_records r
           ${where}
          ORDER BY coalesce(r.event_time, r.collected_at, r.last_seen_at, r.first_seen_at) DESC, r.id DESC
          LIMIT $${limitParameter}
          ${offset}
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
              observation.id AS observation_id,
              observation.ingest_run_id AS observation_ingest_run_id,
              observation.connector_id AS observation_connector_id,
              observation.source_event_id AS observation_source_event_id,
              observation.query_fingerprint AS observation_query_fingerprint,
              observation_run.request_id AS observation_request_id,
              observation_run.connector_call_id,
              connector_call.operation AS connector_operation,
              page.sort_time
         FROM page
         JOIN core.canonical_records r ON r.id = page.id
         LEFT JOIN core.record_revisions revision
           ON revision.record_id = r.id AND revision.revision = r.current_revision
         LEFT JOIN LATERAL (
           SELECT o.id, o.ingest_run_id, o.connector_id, o.source_event_id,
                  o.query_fingerprint, o.observed_at
             FROM core.observations o
            WHERE o.record_id = r.id
            ORDER BY o.observed_at DESC, o.id DESC
            LIMIT 1
         ) observation ON true
         LEFT JOIN ingest.ingest_runs observation_run
           ON observation_run.id = observation.ingest_run_id
         LEFT JOIN serving.connector_calls connector_call
           ON connector_call.id = observation_run.connector_call_id
        ORDER BY page.sort_time DESC, page.id DESC`,
        values,
      ),
    ])
    const rows = recordResult.rows
    const total = Number(countResult.rows[0]?.total ?? 0)
    const hasMore = rows.length > pageSize
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows
    const last = pageRows.at(-1)
    return {
      items: pageRows.map(dataCenterRecordDetail),
      total,
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
              revision.external_import_run_id,
              observation.id AS observation_id,
              observation.ingest_run_id AS observation_ingest_run_id,
              observation.connector_id AS observation_connector_id,
              observation.source_event_id AS observation_source_event_id,
              observation.query_fingerprint AS observation_query_fingerprint,
              observation_run.request_id AS observation_request_id,
              observation_run.connector_call_id,
              connector_call.operation AS connector_operation
         FROM core.canonical_records r
         LEFT JOIN core.record_revisions revision
           ON revision.record_id = r.id AND revision.revision = r.current_revision
         LEFT JOIN LATERAL (
           SELECT o.id, o.ingest_run_id, o.connector_id, o.source_event_id,
                  o.query_fingerprint, o.observed_at
             FROM core.observations o
            WHERE o.record_id = r.id
            ORDER BY o.observed_at DESC, o.id DESC
            LIMIT 1
         ) observation ON true
         LEFT JOIN ingest.ingest_runs observation_run
           ON observation_run.id = observation.ingest_run_id
         LEFT JOIN serving.connector_calls connector_call
           ON connector_call.id = observation_run.connector_call_id
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
      latestObservation: row.observation_id ? {
        id: row.observation_id,
        ingestRunId: row.observation_ingest_run_id ?? null,
        connectorId: row.observation_connector_id ?? null,
        sourceEventId: row.observation_source_event_id ?? null,
        queryFingerprint: row.observation_query_fingerprint ?? null,
        requestId: row.observation_request_id ?? null,
        connectorCallId: row.connector_call_id ?? null,
        operation: row.connector_operation ?? null,
      } : null,
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
