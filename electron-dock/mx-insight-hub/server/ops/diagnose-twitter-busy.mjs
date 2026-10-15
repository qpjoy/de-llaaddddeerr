import { pathToFileURL } from 'node:url'

// Standalone stdin diagnostic: no runtime imports, archives or paid requests.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const LIMIT = 100
const STATUSES = new Set(['reserved', 'committed', 'released', 'unknown'])
const OUTCOMES = new Set(['pending', 'succeeded', 'succeeded_unusable', 'rejected', 'unknown'])
const SOURCES = new Set(['live', 'fresh_cache', 'stored_fallback', 'idempotent_replay', 'duplicate_suppressed', 'circuit_rejected', 'unavailable'])
const ERRORS = new Set(['external_platform_busy', 'external_platform_pre_dispatch_failed',
  'external_platform_rate_limited', 'external_platform_circuit_open', 'external_platform_not_configured',
  'external_platform_persistence_unknown', 'external_platform_call_persistence_unknown', 'reservation_lease_expired',
  'social_upstream_outcome_unknown', 'social_upstream_response_unusable', 'social_upstream_rejected',
  'upstream_rate_limited', 'request_outcome_unknown', 'request_in_progress'])
const FAILURES = new Set(['invalid_arguments', 'invalid_request_id', 'database_url_required', 'request_not_found', 'request_not_twitter'])
const uuid = value => typeof value === 'string' && UUID.test(value) ? value : null
const allowed = (value, choices) => value == null ? null : choices.has(value) ? value : 'other'
const time = value => {
  if (!(value instanceof Date) && !(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?$/u.test(value))) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
const http = value => Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : null
const bool = value => typeof value === 'boolean' ? value : null
const failure = error => new Error(FAILURES.has(error?.message) ? error.message : 'diagnostic_read_failed')
const callProjection = row => ({ callId: uuid(row.id), requestId: uuid(row.usage_request_id),
  provider: row.provider_key === 'rapidapi' ? 'rapidapi' : 'other',
  operation: allowed(row.operation, new Set(['social.content.search', 'social.content.crawl', 'social.profile.get', 'social.facebook.search'])),
  outcome: allowed(row.outcome, OUTCOMES), httpStatus: http(row.http_status), errorCode: allowed(row.error_code, ERRORS),
  startedAt: time(row.started_at), completedAt: time(row.completed_at),
})

export async function diagnoseTwitterBusy(pool, requestId) {
  if (!uuid(requestId)) throw new Error('invalid_request_id')
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'")
    const { rows: [request] } = await client.query(`SELECT /* twitter-busy:usage */
      platform, status, error_code, response_status, reserved_at, completed_at,
      acquisition_request->>'path' AS request_path, clock_timestamp() AS database_now
      FROM public.usage_requests WHERE id = $1::uuid`, [requestId])
    if (!request) throw new Error('request_not_found')
    if (request.platform !== 'twitter') throw new Error('request_not_twitter')
    const { rows: gateways } = await client.query(`SELECT /* twitter-busy:gateways */
      source_mode, response_status, error_code, provider_call_id, created_at
      FROM external_platform.gateway_requests WHERE usage_request_id = $1::uuid
      ORDER BY created_at, id LIMIT 101`, [requestId])
    const { rows: ownCalls } = await client.query(`SELECT /* twitter-busy:own-calls */
      id, usage_request_id, provider_key, operation, outcome, http_status, error_code, started_at, completed_at
      FROM external_platform.provider_calls WHERE usage_request_id = $1::uuid
      ORDER BY started_at, id LIMIT 101`, [requestId])
    const { rows: nearby } = await client.query(`WITH target AS ( /* twitter-busy:nearby */
      SELECT id, tenant_id, consumer_id, api_key_id, reserved_at, completed_at
      FROM public.usage_requests WHERE id = $1::uuid AND platform = 'twitter'
    )
    SELECT p.id, p.usage_request_id, p.provider_key, p.operation, p.outcome,
      p.http_status, p.error_code, p.started_at, p.completed_at,
      p.tenant_id = t.tenant_id AS same_tenant, p.consumer_id = t.consumer_id AS same_consumer,
      p.api_key_id = t.api_key_id AS same_api_key,
      p.started_at <= COALESCE(t.completed_at, t.reserved_at)
        AND (p.completed_at IS NULL OR p.completed_at >= t.reserved_at) AS overlaps_target_window
    FROM external_platform.provider_calls p CROSS JOIN target t
    WHERE p.provider_key = 'rapidapi' AND p.usage_request_id <> t.id
      AND p.started_at BETWEEN t.reserved_at - INTERVAL '5 minutes'
        AND LEAST(COALESCE(t.completed_at, t.reserved_at), t.reserved_at + INTERVAL '5 minutes') + INTERVAL '30 seconds'
      AND (p.completed_at IS NULL OR p.completed_at >= t.reserved_at - INTERVAL '30 seconds')
    ORDER BY p.started_at DESC, p.id LIMIT 101`, [requestId])
    return { requestId, platform: 'twitter', status: allowed(request.status, STATUSES),
      errorCode: allowed(request.error_code, ERRORS), savedHttpStatus: http(request.response_status),
      requestPath: allowed(request.request_path, new Set(['/api/v1/data/search', '/api/v1/search/raw', '/api/v1/night-all/search/raw'])),
      reservedAt: time(request.reserved_at), completedAt: time(request.completed_at), databaseNow: time(request.database_now),
      gateways: gateways.slice(0, LIMIT).map(row => ({ sourceMode: allowed(row.source_mode, SOURCES),
        httpStatus: http(row.response_status), errorCode: allowed(row.error_code, ERRORS),
        providerCallId: uuid(row.provider_call_id), createdAt: time(row.created_at) })),
      ownCalls: ownCalls.slice(0, LIMIT).map(callProjection),
      nearbyCalls: nearby.slice(0, LIMIT).map(row => ({ ...callProjection(row), sameTenant: bool(row.same_tenant),
        sameConsumer: bool(row.same_consumer), sameApiKey: bool(row.same_api_key), overlapsTargetWindow: bool(row.overlaps_target_window) })),
      rowLimit: LIMIT, gatewaysTruncated: gateways.length > LIMIT, ownCallsTruncated: ownCalls.length > LIMIT,
      nearbyCallsTruncated: nearby.length > LIMIT,
      nearbyScope: 'RapidAPI candidates only; starts from reservation minus 5m through completion capped at reservation plus 5m, plus 30s; older starts omitted',
      concurrencyEvidence: 'historical_process_counters_and_gateway_instance_not_recorded',
    }
  } catch (error) { throw failure(error) }
  finally {
    if (client) {
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
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, query_timeout: 6000 })
    console.log(JSON.stringify(await diagnoseTwitterBusy(pool, requestId), null, 2))
  } catch (error) {
    console.error(JSON.stringify({ error: failure(error).message }))
    process.exitCode = 1
  } finally { await pool?.end() }
}
