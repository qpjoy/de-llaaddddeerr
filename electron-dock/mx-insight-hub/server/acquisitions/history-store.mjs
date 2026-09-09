import { createHash } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { canonicalJson } from '../ingest/normalizers.mjs'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const CONTRACT_VERSION = 'mx-insight-hub.acquisition-query-run.v1'

function requireUuid(value, field) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new AppError(400, `invalid_${field}`, `${field} must be a UUID`)
  }
}

function iso(value) {
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function integer(value, field = 'integer') {
  if (value == null) return null
  let parsed = null
  if (typeof value === 'number') {
    parsed = value
  } else if (typeof value === 'bigint') {
    if (value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)) {
      parsed = Number(value)
    }
  } else if (typeof value === 'string' && /^-?\d+$/u.test(value)) {
    const exact = BigInt(value)
    if (exact <= BigInt(Number.MAX_SAFE_INTEGER) && exact >= BigInt(Number.MIN_SAFE_INTEGER)) {
      parsed = Number(exact)
    }
  }
  if (!Number.isSafeInteger(parsed)) {
    throw new AppError(
      500,
      'acquisition_history_integer_out_of_range',
      `Acquisition history ${field} exceeds the JavaScript safe integer range`,
    )
  }
  return parsed
}

function minor(value) {
  return value == null ? null : String(value)
}

export function deliveredResponseSemanticSha256(responseBody) {
  return createHash('sha256').update(canonicalJson(responseBody)).digest('hex')
}

async function withReadSnapshot(pool, task) {
  if (typeof pool.connect !== 'function') return task(pool)

  const client = await pool.connect()
  let began = false
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    began = true
    const result = await task(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    if (began) await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

function customerCharge(row) {
  if (!row.customer_charge_id) return null
  return {
    id: row.customer_charge_id,
    meterKey: row.customer_meter_key,
    billingUnit: row.customer_billing_unit,
    enforcementMode: row.customer_enforcement_mode,
    status: row.customer_charge_status,
    currency: row.customer_currency,
    unitPriceMinor: minor(row.customer_unit_price_minor),
    quotedMinor: minor(row.customer_quoted_minor),
    chargedMinor: minor(row.customer_charged_minor),
    priceBookKey: row.customer_price_book_key,
    priceBookVersion: integer(row.customer_price_book_version, 'customer price-book version'),
    settledAt: iso(row.customer_settled_at),
  }
}

function publicItem(row, ordinal) {
  return {
    ordinal,
    observationId: row.observation_id,
    recordId: row.record_id,
    platform: row.platform,
    objectType: row.object_type,
    externalId: row.external_id,
    rank: integer(row.rank),
    observedAt: iso(row.observed_at),
    metrics: row.metrics || {},
    canonicalRevision: integer(row.canonical_revision, 'canonical revision'),
    canonicalRevisionEvidence: row.revision_evidence,
    currentRevision: integer(row.current_revision, 'current canonical revision'),
  }
}

function adminItem(row, ordinal) {
  return {
    ...publicItem(row, ordinal),
    ingestRunId: row.ingest_run_id,
    connectorId: row.connector_id,
    queryFingerprint: row.query_fingerprint,
    datasetId: row.dataset_id,
    sourceKind: row.source_kind,
    sourceCallId: row.source_call_id,
    sourceCallOrdinal: integer(row.source_call_ordinal),
    normalizedPayload: row.normalized_payload ?? null,
  }
}

function gatewayEvent(row, admin) {
  const event = {
    sourceMode: row.source_mode,
    succeeded: row.succeeded,
    responseStatus: integer(row.response_status),
    createdAt: iso(row.created_at),
  }
  if (!admin) return event
  return {
    ...event,
    id: row.id,
    providerKey: row.provider_key,
    requestProviderCallId: row.provider_call_id,
    deliveredSourceProviderCallId: row.source_provider_call_id,
    snapshotId: row.snapshot_id,
    errorCode: row.error_code,
  }
}

function providerCall(row) {
  return {
    id: row.id,
    providerKey: row.provider_key,
    usageRequestId: row.usage_request_id,
    requestCall: row.request_call,
    deliveredSource: row.delivered_source,
    callOrdinal: integer(row.call_ordinal),
    callRole: row.call_role,
    operation: row.operation,
    contractVersion: row.contract_version,
    endpointKey: row.endpoint_key,
    endpointVersion: row.endpoint_version,
    marketplace: row.marketplace,
    operationPolicyRevision: integer(row.operation_policy_revision, 'operation policy revision'),
    operationReleaseRevision: integer(row.operation_release_revision, 'operation release revision'),
    providerPriceBookVersion: integer(row.provider_price_book_version, 'provider price-book version'),
    providerCredentialRevision: integer(row.provider_credential_revision, 'provider credential revision'),
    requestFingerprint: row.request_fingerprint,
    dispatchFingerprint: row.dispatch_fingerprint,
    outcome: row.outcome,
    httpStatus: integer(row.http_status),
    businessCode: integer(row.business_code),
    billed: row.billed,
    costMinor: minor(row.cost_minor),
    costKind: row.cost_kind,
    currency: row.currency,
    itemCount: integer(row.item_count),
    latencyMs: integer(row.latency_ms),
    errorCode: row.error_code,
    upstreamRequestId: row.upstream_request_id,
    upstreamRecordTime: row.upstream_record_time,
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
  }
}

function connectorCall(row) {
  return {
    id: row.id,
    usageRequestId: row.usage_request_id,
    requestCall: row.request_call,
    deliveredSource: row.delivered_source,
    operation: row.operation,
    platform: row.platform,
    sourceMode: row.source_mode,
    requestFingerprint: row.request_fingerprint,
    outcome: row.outcome,
    httpStatus: integer(row.http_status),
    businessStatus: row.business_status,
    failureKind: row.failure_kind,
    upstreamLatencyMs: integer(row.upstream_latency_ms),
    errorCode: row.error_code,
    upstreamRequestId: row.upstream_request_id,
    upstreamTraceId: row.upstream_trace_id,
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
  }
}

export class PostgresAcquisitionHistoryStore {
  constructor(pool) {
    if (!pool || typeof pool.query !== 'function') {
      throw new TypeError('PostgresAcquisitionHistoryStore requires a PostgreSQL pool')
    }
    this.pool = pool
  }

  async getPublicDeliveredRun({ requestId, consumerId, apiKeyId }) {
    requireUuid(requestId, 'request_id')
    requireUuid(consumerId, 'consumer_id')
    requireUuid(apiKeyId, 'api_key_id')
    return withReadSnapshot(this.pool, async (client) => {
      const root = await this.#getRoot(client, requestId, { consumerId, apiKeyId })
      this.#assertDelivered(root)
      // A node-postgres Client owns one wire protocol stream. Parallel query()
      // calls on that same transaction client are deprecated and will fail in
      // pg 9, so keep the repeatable-read snapshot and read it sequentially.
      const itemRows = await this.#getItems(client, requestId)
      const gatewayRows = await this.#getGatewayEvents(client, requestId)
      return this.#publicProjection(root, itemRows, gatewayRows)
    })
  }

  async getAdminDeliveredRun(requestId) {
    requireUuid(requestId, 'request_id')
    return withReadSnapshot(this.pool, async (client) => {
      const root = await this.#getRoot(client, requestId)
      this.#assertDelivered(root)
      const itemRows = await this.#getItems(client, requestId)
      const gatewayRows = await this.#getGatewayEvents(client, requestId)
      const providerRows = await this.#getProviderCalls(client, requestId)
      const connectorRows = await this.#getConnectorCalls(client, requestId)
      return {
        ...this.#publicProjection(root, itemRows, gatewayRows, true),
        owner: {
          tenantId: root.tenant_id,
          tenantName: root.tenant_name,
          consumerId: root.consumer_id,
          consumerName: root.consumer_name,
          consumerBusinessId: root.consumer_business_id,
          apiKeyId: root.api_key_id,
          apiKeyPrefix: root.api_key_prefix,
          apiKeyLastFour: root.api_key_last_four,
        },
        requestEvidence: {
          idempotencyKey: root.idempotency_key,
          fingerprint: root.fingerprint,
        },
        costLineage: {
          providerCalls: providerRows.map(providerCall),
          connectorCalls: connectorRows.map(connectorCall),
        },
      }
    })
  }

  #assertDelivered(root) {
    if (!root) {
      throw new AppError(404, 'acquisition_query_run_not_found', 'Acquisition query run not found')
    }
    if (root.status !== 'committed' || !root.has_response_body) {
      throw new AppError(
        409,
        'acquisition_query_run_unavailable',
        'Acquisition query run has no committed delivered response',
      )
    }
  }

  #publicProjection(root, itemRows, gatewayRows, admin = false) {
    return {
      contractVersion: CONTRACT_VERSION,
      requestId: root.id,
      status: root.status,
      scope: {
        platform: root.platform,
        capability: root.capability,
        billingMeterKey: root.billing_meter_key,
      },
      units: {
        reserved: integer(root.units_reserved, 'reserved units'),
        actual: integer(root.units_actual, 'actual units'),
      },
      delivered: {
        responseStatus: integer(root.response_status),
        sourceMode: root.delivery_source_mode,
        capturedAt: iso(root.response_captured_at),
        completedAt: iso(root.completed_at),
        responseHash: deliveredResponseSemanticSha256(root.response_body),
        responseHashContract: 'sha256-canonical-json-v1',
        responseBody: root.response_body,
        gatewayEvents: gatewayRows.map((row) => gatewayEvent(row, admin)),
      },
      customerCharge: customerCharge(root),
      items: itemRows.map((row, index) => (
        admin ? adminItem(row, index + 1) : publicItem(row, index + 1)
      )),
    }
  }

  async #getRoot(client, requestId, owner = null) {
    const ownerPredicate = owner
      ? 'AND usage.consumer_id = $2 AND usage.api_key_id = $3'
      : ''
    const { rows } = await client.query(
      `/* acquisition-history:root */
       SELECT usage.id, usage.tenant_id, usage.consumer_id, usage.api_key_id,
              usage.idempotency_key, usage.fingerprint, usage.platform,
              usage.capability, usage.billing_meter_key, usage.status,
              usage.units_reserved, usage.units_actual, usage.response_status,
              usage.response_body, usage.response_body IS NOT NULL AS has_response_body,
              usage.delivery_source_mode, usage.response_captured_at,
              usage.compatibility_snapshot_id, usage.completed_at,
              tenant.name AS tenant_name,
              consumer.name AS consumer_name,
              consumer.business_id AS consumer_business_id,
              api_key.key_prefix AS api_key_prefix,
              api_key.last_four AS api_key_last_four,
              charge.id AS customer_charge_id,
              charge.meter_key AS customer_meter_key,
              charge.billing_unit AS customer_billing_unit,
              charge.enforcement_mode AS customer_enforcement_mode,
              charge.status AS customer_charge_status,
              charge.currency AS customer_currency,
              charge.unit_price_minor AS customer_unit_price_minor,
              charge.quoted_minor AS customer_quoted_minor,
              charge.charged_minor AS customer_charged_minor,
              charge.price_book_key AS customer_price_book_key,
              charge.price_book_version AS customer_price_book_version,
              charge.settled_at AS customer_settled_at
         FROM public.usage_requests usage
         JOIN public.tenants tenant ON tenant.id = usage.tenant_id
         JOIN public.consumers consumer ON consumer.id = usage.consumer_id
         JOIN public.api_keys api_key ON api_key.id = usage.api_key_id
         LEFT JOIN billing.customer_charges charge
           ON charge.usage_request_id = usage.id
        WHERE usage.id = $1
          ${ownerPredicate}
        LIMIT 1`,
      owner ? [requestId, owner.consumerId, owner.apiKeyId] : [requestId],
    )
    return rows[0] || null
  }

  async #getGatewayEvents(client, requestId) {
    const { rows } = await client.query(
      `/* acquisition-history:gateway-events */
       SELECT id, provider_key, source_mode, succeeded, response_status,
              provider_call_id, source_provider_call_id, snapshot_id,
              error_code, created_at
         FROM external_platform.gateway_requests
        WHERE usage_request_id = $1
        ORDER BY created_at, id`,
      [requestId],
    )
    return rows
  }

  async #getItems(client, requestId) {
    const { rows } = await client.query(
      `/* acquisition-history:items */
       WITH provider_source_calls AS (
         SELECT DISTINCT coalesce(
                  gateway.source_provider_call_id,
                  CASE WHEN gateway.source_mode = 'live'
                       THEN gateway.provider_call_id END
                ) AS call_id
           FROM external_platform.gateway_requests gateway
          WHERE gateway.usage_request_id = $1
            AND coalesce(
                  gateway.source_provider_call_id,
                  CASE WHEN gateway.source_mode = 'live'
                       THEN gateway.provider_call_id END
                ) IS NOT NULL
         UNION
         SELECT call.id
           FROM external_platform.provider_calls call
           JOIN public.usage_requests usage
             ON usage.id = call.usage_request_id
          WHERE call.usage_request_id = $1
            -- A live multi-step workflow can contribute records from successful
            -- resolver/enrichment calls before its terminal provider call.  A
            -- stored fallback must never expose those newly ingested records as
            -- part of the older snapshot response that was actually delivered.
            AND usage.delivery_source_mode = 'live'
            AND call.outcome = 'succeeded'
       ),
       connector_source_calls AS (
         SELECT call.id
           FROM serving.connector_calls call
          WHERE call.usage_request_id = $1
            AND call.source_mode = 'live'
            AND call.outcome IN ('complete', 'partial')
         UNION
         SELECT snapshot.last_success_call_id
           FROM public.usage_requests usage
           JOIN serving.compatibility_snapshots snapshot
             ON snapshot.id = usage.compatibility_snapshot_id
          WHERE usage.id = $1
       ),
       linked_runs AS (
         SELECT run.id, 'provider'::text AS source_kind,
                call.id AS source_call_id,
                call.call_ordinal AS source_call_ordinal,
                call.started_at AS source_started_at
           FROM provider_source_calls source
           JOIN external_platform.provider_calls call ON call.id = source.call_id
           JOIN ingest.ingest_runs run
             ON run.external_platform_call_id = call.id
         UNION ALL
         SELECT run.id, 'compatibility'::text AS source_kind,
                call.id AS source_call_id,
                0 AS source_call_ordinal,
                call.started_at AS source_started_at
           FROM connector_source_calls source
           JOIN serving.connector_calls call ON call.id = source.id
           JOIN ingest.ingest_runs run ON run.connector_call_id = call.id
         UNION ALL
         -- Historical generic /data/search ingestion predates connector-call
         -- and provider-call ledgers.  Those runs are still unambiguously
         -- owned by the durable usage request recorded on the ingest run.
         SELECT run.id, 'request'::text AS source_kind,
                NULL::uuid AS source_call_id,
                NULL::integer AS source_call_ordinal,
                run.started_at AS source_started_at
           FROM ingest.ingest_runs run
          WHERE run.request_id = $1
            AND run.connector_call_id IS NULL
            AND run.external_platform_call_id IS NULL
       )
       SELECT observation.id AS observation_id,
              observation.record_id,
              observation.connector_id,
              observation.query_fingerprint,
              observation.observed_at,
              observation.rank,
              observation.metrics,
              observation.ingest_run_id,
              record.dataset_id,
              record.platform,
              record.object_type,
              record.external_id,
              record.current_revision,
              coalesce(observation.canonical_revision, same_run_revision.revision)
                AS canonical_revision,
              CASE
                WHEN observation.canonical_revision IS NOT NULL THEN 'captured'
                WHEN same_run_revision.revision IS NOT NULL THEN 'same_ingest_revision'
                ELSE 'unavailable'
              END AS revision_evidence,
              coalesce(captured_revision.normalized_payload,
                       same_run_revision.normalized_payload) AS normalized_payload,
              linked.source_kind,
              linked.source_call_id,
              linked.source_call_ordinal,
              linked.source_started_at
         FROM linked_runs linked
         JOIN core.observations observation
           ON observation.ingest_run_id = linked.id
         JOIN core.canonical_records record ON record.id = observation.record_id
         LEFT JOIN core.record_revisions captured_revision
           ON captured_revision.record_id = observation.record_id
          AND captured_revision.revision = observation.canonical_revision
         LEFT JOIN LATERAL (
           SELECT revision.revision, revision.normalized_payload
             FROM core.record_revisions revision
            WHERE revision.record_id = observation.record_id
              AND revision.ingest_run_id = observation.ingest_run_id
            ORDER BY revision.revision DESC
            LIMIT 1
         ) same_run_revision ON observation.canonical_revision IS NULL
        ORDER BY linked.source_call_ordinal,
                 linked.source_started_at,
                 coalesce(observation.rank, 2147483647),
                 observation.observed_at,
                 observation.id`,
      [requestId],
    )
    return rows
  }

  async #getProviderCalls(client, requestId) {
    const { rows } = await client.query(
      `/* acquisition-history:provider-calls */
       WITH delivered_provider_calls AS (
         SELECT DISTINCT coalesce(
                  gateway.source_provider_call_id,
                  CASE WHEN gateway.source_mode = 'live'
                       THEN gateway.provider_call_id END
                ) AS id
           FROM external_platform.gateway_requests gateway
          WHERE gateway.usage_request_id = $1
       )
       SELECT call.*,
              call.usage_request_id = $1 AS request_call,
              delivered.id IS NOT NULL AS delivered_source
         FROM external_platform.provider_calls call
         LEFT JOIN delivered_provider_calls delivered ON delivered.id = call.id
        WHERE call.usage_request_id = $1 OR delivered.id IS NOT NULL
        ORDER BY call.call_ordinal, call.started_at, call.id`,
      [requestId],
    )
    return rows
  }

  async #getConnectorCalls(client, requestId) {
    const { rows } = await client.query(
      `/* acquisition-history:connector-calls */
       WITH delivered_connector_calls AS (
         SELECT call.id
           FROM serving.connector_calls call
          WHERE call.usage_request_id = $1
            AND call.source_mode = 'live'
            AND call.outcome IN ('complete', 'partial')
         UNION
         SELECT snapshot.last_success_call_id
           FROM public.usage_requests usage
           JOIN serving.compatibility_snapshots snapshot
             ON snapshot.id = usage.compatibility_snapshot_id
          WHERE usage.id = $1
       )
       SELECT call.*,
              call.usage_request_id = $1 AS request_call,
              delivered.id IS NOT NULL AS delivered_source
         FROM serving.connector_calls call
         LEFT JOIN delivered_connector_calls delivered ON delivered.id = call.id
        WHERE call.usage_request_id = $1 OR delivered.id IS NOT NULL
        ORDER BY call.started_at, call.id`,
      [requestId],
    )
    return rows
  }
}
