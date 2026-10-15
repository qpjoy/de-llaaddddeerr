import { pathToFileURL } from 'node:url'

// Standalone for stdin execution in an existing Pod. No adapters, paid calls,
// response archives, request bodies, retries or configuration writes.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const API_ID = '\\d{1,3}(?:\\.\\d{1,3})?'
const PATH = new RegExp(`^/api/v1/data/enterprise/${API_ID}/query$`)
const OPERATION = new RegExp(`^enterprise\\.api\\.${API_ID}$`)
const ENDPOINT = new RegExp(`^enterprise\\.${API_ID}$`)
const LIMIT = 100
const STATUSES = new Set(['reserved', 'committed', 'released', 'unknown'])
const OUTCOMES = new Set(['pending', 'succeeded', 'succeeded_unusable', 'rejected', 'unknown'])
const SOURCES = new Set(['live', 'fresh_cache', 'stored_fallback', 'idempotent_replay',
  'duplicate_suppressed', 'circuit_rejected', 'unavailable'])
const ERRORS = new Set(['external_platform_busy', 'external_platform_rate_limited',
  'external_platform_circuit_open', 'external_platform_not_configured', 'external_platform_pre_dispatch_failed',
  'external_platform_persistence_unknown', 'external_platform_call_persistence_unknown',
  'external_platform_response_unusable', 'external_platform_rejected', 'request_in_progress',
  'request_outcome_unknown', 'stored_snapshot_not_found', 'enterprise_response_too_large',
  'enterprise_outcome_unknown', 'enterprise_query_rejected', 'enterprise_response_unusable'])
const FAILURES = new Set(['invalid_arguments', 'invalid_request_id', 'database_url_required',
  'request_not_found', 'request_not_enterprise'])
const uuid = value => typeof value === 'string' && UUID.test(value) ? value : null
const allowed = (value, choices) => value == null ? null : choices.has(value) ? value : 'other'
const matched = (value, pattern) => value == null ? null : typeof value === 'string' && pattern.test(value) ? value : 'other'
const integer = value => Number.isSafeInteger(value) ? value : null
const boolean = value => typeof value === 'boolean' ? value : null
const httpStatus = value => Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : null
const time = value => {
  if (!(value instanceof Date) && !(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?$/.test(value))) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
const failure = error => new Error(FAILURES.has(error?.message) ? error.message : 'diagnostic_read_failed')

export async function diagnoseEnterpriseBusy(pool, requestId) {
  if (!uuid(requestId)) throw new Error('invalid_request_id')
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'")
    const { rows: [request] } = await client.query(`SELECT /* enterprise-busy:usage */
      platform, status, error_code, response_status, billing_meter_key,
      acquisition_request->>'method' AS request_method,
      acquisition_request->>'path' AS request_path, reserved_at, completed_at
      FROM public.usage_requests WHERE id = $1::uuid`, [requestId])
    if (!request) throw new Error('request_not_found')
    if (request.platform !== 'enterprise') throw new Error('request_not_enterprise')
    const { rows: gateways } = await client.query(`SELECT /* enterprise-busy:gateways */
      id, provider_key, source_mode, succeeded, response_status, error_code,
      provider_call_id, created_at
      FROM external_platform.gateway_requests WHERE usage_request_id = $1::uuid
      ORDER BY created_at, id LIMIT 101`, [requestId])
    const { rows: calls } = await client.query(`WITH target AS ( /* enterprise-busy:calls */
      SELECT id, tenant_id, consumer_id, api_key_id, reserved_at, completed_at
      FROM public.usage_requests WHERE id = $1::uuid AND platform = 'enterprise'
    )
    SELECT p.id, p.usage_request_id, p.operation, p.endpoint_key, p.outcome,
      p.http_status, p.business_code, p.error_code, p.started_at, p.completed_at,
      p.tenant_id = t.tenant_id AS same_tenant,
      p.consumer_id = t.consumer_id AS same_consumer,
      p.api_key_id = t.api_key_id AS same_api_key,
      p.started_at <= COALESCE(t.completed_at, t.reserved_at)
        AND (p.completed_at IS NULL OR p.completed_at >= t.reserved_at)
        AS overlaps_target_window
    FROM external_platform.provider_calls p CROSS JOIN target t
    WHERE p.provider_key = 'qixin'
      AND p.started_at <= COALESCE(t.completed_at, t.reserved_at) + INTERVAL '30 seconds'
      AND (p.completed_at IS NULL OR p.completed_at >= t.reserved_at - INTERVAL '30 seconds')
    ORDER BY p.started_at, p.id LIMIT 101`, [requestId])
    return {
      requestId, platform: 'enterprise', status: allowed(request.status, STATUSES),
      errorCode: allowed(request.error_code, ERRORS), savedHttpStatus: httpStatus(request.response_status),
      billingMeterKey: matched(request.billing_meter_key, OPERATION),
      request: { method: request.request_method == null ? null : request.request_method === 'POST' ? 'POST' : 'other',
        path: matched(request.request_path, PATH) },
      reservedAt: time(request.reserved_at), completedAt: time(request.completed_at),
      gateways: gateways.slice(0, LIMIT).map(row => ({ id: uuid(row.id),
        provider: row.provider_key === 'qixin' ? 'qixin' : 'other', sourceMode: allowed(row.source_mode, SOURCES),
        succeeded: boolean(row.succeeded), httpStatus: httpStatus(row.response_status),
        errorCode: allowed(row.error_code, ERRORS), providerCallId: uuid(row.provider_call_id),
        createdAt: time(row.created_at) })),
      gatewayLimit: LIMIT, gatewaysTruncated: gateways.length > LIMIT,
      nearbyCalls: calls.slice(0, LIMIT).map(row => ({ callId: uuid(row.id), requestId: uuid(row.usage_request_id),
        operation: matched(row.operation, OPERATION), endpoint: matched(row.endpoint_key, ENDPOINT),
        outcome: allowed(row.outcome, OUTCOMES), httpStatus: httpStatus(row.http_status),
        businessCode: integer(row.business_code), errorCode: allowed(row.error_code, ERRORS),
        startedAt: time(row.started_at), completedAt: time(row.completed_at),
        sameTenant: boolean(row.same_tenant), sameConsumer: boolean(row.same_consumer),
        sameApiKey: boolean(row.same_api_key), overlapsTargetWindow: boolean(row.overlaps_target_window) })),
      nearbyWindowSeconds: 30, callLimit: LIMIT, callsTruncated: calls.length > LIMIT,
      concurrencyEvidence: 'historical_process_counters_not_recorded',
    }
  } catch (error) {
    throw failure(error)
  } finally {
    if (client) {
      // No COMMIT even on success. Discard a connection that cannot roll back.
      let rollbackError
      try { await client.query('ROLLBACK') } catch (error) { rollbackError = error }
      client.release(rollbackError)
      if (rollbackError) throw new Error('diagnostic_read_failed')
    }
  }
}

if (process.argv[1] === '-' || (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  let pool
  try {
    const [requestId, extra] = process.argv.slice(2)
    if (!requestId || extra) throw new Error('invalid_arguments')
    if (!uuid(requestId)) throw new Error('invalid_request_id')
    if (!process.env.DATABASE_URL) throw new Error('database_url_required')
    const { default: pg } = await import('pg')
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1,
      connectionTimeoutMillis: 5000, query_timeout: 6000 })
    console.log(JSON.stringify(await diagnoseEnterpriseBusy(pool, requestId), null, 2))
  } catch (error) {
    console.error(JSON.stringify({ error: failure(error).message }))
    process.exitCode = 1
  } finally { await pool?.end() }
}
