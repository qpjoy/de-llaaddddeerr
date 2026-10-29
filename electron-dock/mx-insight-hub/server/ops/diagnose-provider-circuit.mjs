import { pathToFileURL } from 'node:url'

// Standalone stdin diagnostic for any platform's circuit refusal: the refused
// request, the provider circuits, and the provider's failed calls around it,
// including Hub-side failures (parse, persistence) that may have counted.
// Only saved metadata is read; no application runtime or upstream calls.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const LIMIT = 20
const PROVIDERS = new Set(['justone', 'tikhub'])
const STATUSES = new Set(['reserved', 'committed', 'released', 'unknown'])
const SOURCES = new Set(['live', 'fresh_cache', 'stored_fallback', 'idempotent_replay', 'duplicate_suppressed', 'circuit_rejected', 'unavailable'])
const ERRORS = new Set(['external_platform_circuit_open', 'external_platform_pre_dispatch_failed',
  'external_platform_capacity_unavailable', 'external_platform_capacity_exceeded',
  'external_platform_response_unusable', 'external_platform_rejected', 'external_platform_outcome_unknown',
  'social_upstream_response_unusable', 'social_upstream_rejected', 'social_upstream_outcome_unknown',
  'upstream_rate_limited', 'upstream_auth_or_balance_unavailable', 'upstream_balance_exhausted',
  'upstream_auth_invalid', 'upstream_permission_denied',
  'upstream_collection_failed', 'upstream_daily_quota_exceeded', 'upstream_token_limit_exceeded',
  'upstream_http_error', 'upstream_endpoint_unavailable', 'upstream_failure', 'upstream_business_error',
  'upstream_transport_error', 'upstream_deadline_exceeded', 'upstream_body_read_failed', 'upstream_response_too_large',
  'upstream_status_envelope_conflict', 'upstream_payload_unrepresentable', 'invalid_upstream_response',
  'invalid_upstream_json', 'invalid_upstream_content_type', 'invalid_upstream_envelope', 'invalid_upstream_contract',
  'upstream_request_rejected', 'upstream_note_unavailable', 'upstream_identity_mismatch', 'social_upstream_timeout_or_size_limit',
  // Hub-side failures recorded on a provider call: before 2026-10-29 these also
  // advanced the shared provider circuit.
  'invalid_content_search_contract', 'invalid_content_search_identity', 'invalid_social_contract',
  'external_platform_enrichment_unknown', 'external_platform_persistence_unknown'])
// Hub's own dotted operation/endpoint keys only (e.g. native.t.douyin_search_v1).
const ENDPOINT = /^(?=.{3,120}$)[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/u
const endpoint = value => typeof value === 'string' && ENDPOINT.test(value) ? value : value == null ? null : 'other'
const PLATFORMS = new Set(['instagram', 'twitter', 'xiaohongshu', 'douyin', 'bilibili', 'kuaishou',
  'zhihu', 'telegram', 'reddit', 'weibo', 'facebook', 'tiktok', 'youtube', 'wechat', 'wechat_mp',
  'taobao', 'tmall', 'jd', 'xianyu', 'xiaohongshu_ec', 'douyin_ec', 'kuaishou_ec', 'pinduoduo', 'ecommerce', 'unknown'])
const FAILURES = new Set(['invalid_arguments', 'invalid_request_id', 'database_url_required', 'request_not_found'])
const uuid = value => typeof value === 'string' && UUID.test(value) ? value : null
const allowed = (value, choices) => value == null ? null : choices.has(value) ? value : 'other'
const integer = value => Number.isSafeInteger(value) ? value : null
const bool = value => typeof value === 'boolean' ? value : null
const http = value => Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : null
const time = value => {
  if (!(value instanceof Date) && !(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?$/u.test(value))) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
const failure = error => new Error(FAILURES.has(error?.message) ? error.message
  : ['42P01', '42703'].includes(error?.code) ? 'diagnostic_schema_unavailable' : 'diagnostic_read_failed')
const stateProjection = row => ({ provider: allowed(row.provider_key, PROVIDERS), openNow: bool(row.open_now),
  consecutiveFailures: integer(row.consecutive_failures), circuitOpenUntil: time(row.circuit_open_until),
  lastFailureAt: time(row.last_failure_at), lastErrorCode: allowed(row.last_error_code, ERRORS), updatedAt: time(row.updated_at) })

export async function diagnoseProviderCircuit(pool, requestId) {
  if (!uuid(requestId)) throw new Error('invalid_request_id')
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'")
    const { rows: [request] } = await client.query(`SELECT /* provider-circuit:usage */
      platform, status, error_code, response_status, reserved_at, completed_at,
      acquisition_request->>'searchProvider' AS saved_search_provider,
      transaction_timestamp() AS observed_at,
      to_regclass('external_platform.provider_contract_circuits') IS NOT NULL AS has_contract_circuits,
      to_regclass('control.strategy_search_routes') IS NOT NULL AS has_search_routes
      FROM public.usage_requests WHERE id = $1::uuid`, [requestId])
    if (!request) throw new Error('request_not_found')
    const { rows: gateways } = await client.query(`SELECT /* provider-circuit:gateways */
      provider_key, source_mode, response_status, error_code, provider_call_id, created_at
      FROM external_platform.gateway_requests WHERE usage_request_id = $1::uuid
        AND source_mode <> 'idempotent_replay'
      ORDER BY created_at, id LIMIT 21`, [requestId])
    // A capacity refusal can be an actual supplier response after the breaker
    // expired. Read this request's calls separately from nearby trigger candidates.
    const { rows: ownCalls } = await client.query(`SELECT /* provider-circuit:own-calls */
      id, provider_key, marketplace, operation, endpoint_key, outcome, http_status,
      business_code, error_code, billed, started_at, completed_at
      FROM external_platform.provider_calls WHERE usage_request_id = $1::uuid
      ORDER BY started_at, id LIMIT 21`, [requestId])
    // An incomplete ledger must not select a guessed provider from today's route policy.
    const providers = gateways.length > LIMIT ? [] : [...new Set(gateways.map(row => row.provider_key).filter(value => PROVIDERS.has(value)))]
    const { rows: states } = await client.query(`SELECT /* provider-circuit:states */
      provider_key, consecutive_failures, circuit_open_until, last_failure_at, last_error_code, updated_at,
      COALESCE(circuit_open_until > transaction_timestamp(), false) AS open_now
      FROM external_platform.provider_state WHERE provider_key = ANY($1::text[]) ORDER BY provider_key`, [providers])
    const contracts = request.has_contract_circuits ? (await client.query(`SELECT /* provider-circuit:contracts */
      provider_key, consecutive_failures, circuit_open_until, last_failure_at, last_error_code, updated_at,
      COALESCE(circuit_open_until > transaction_timestamp(), false) AS open_now
      FROM external_platform.provider_contract_circuits
      WHERE provider_key = ANY($1::text[]) AND scope = $2 ORDER BY provider_key`, [providers, request.platform])).rows : []
    const policy = request.has_search_routes ? (await client.query(`SELECT /* provider-circuit:policy */
      mode, primary_provider, fallback_provider, revision, updated_at FROM control.strategy_search_routes
      WHERE interface_key = 'search' AND platform = $1`, [request.platform])).rows[0] : null
    const { rows: nearby } = await client.query(`WITH target AS ( /* provider-circuit:nearby */
      SELECT id, reserved_at FROM public.usage_requests WHERE id = $1::uuid
    )
    SELECT p.id, p.provider_key, p.marketplace, p.operation, p.endpoint_key, p.outcome, p.http_status, p.business_code, p.error_code,
      p.billed, p.started_at, p.completed_at, p.completed_at <= t.reserved_at AS completed_before_target
    FROM external_platform.provider_calls p CROSS JOIN target t
    WHERE p.provider_key = ANY($2::text[]) AND p.usage_request_id <> t.id
      AND p.outcome IN ('rejected', 'unknown', 'succeeded_unusable')
      AND p.started_at BETWEEN t.reserved_at - INTERVAL '5 minutes' AND t.reserved_at + INTERVAL '5 minutes'
    ORDER BY abs(extract(epoch FROM p.started_at - t.reserved_at)), p.id LIMIT 21`, [requestId, providers])
    return { diagnosticRevision: 'provider-circuit-diagnostic.v2', requestId, platform: allowed(request.platform, PLATFORMS), readOnly: true,
      historical: { status: allowed(request.status, STATUSES), errorCode: allowed(request.error_code, ERRORS),
        savedHttpStatus: http(request.response_status), reservedAt: time(request.reserved_at), completedAt: time(request.completed_at),
        savedSearchProvider: allowed(request.saved_search_provider, PROVIDERS),
        gatewayProviders: providers, gatewayProvidersComplete: gateways.length <= LIMIT,
        gateways: gateways.slice(0, LIMIT).map(row => ({ provider: allowed(row.provider_key, PROVIDERS),
          sourceMode: allowed(row.source_mode, SOURCES), httpStatus: http(row.response_status),
          errorCode: allowed(row.error_code, ERRORS), providerCallId: uuid(row.provider_call_id), createdAt: time(row.created_at) })),
        ownCalls: ownCalls.slice(0, LIMIT).map(row => ({ callId: uuid(row.id), provider: allowed(row.provider_key, PROVIDERS),
          marketplace: allowed(row.marketplace, PLATFORMS), operation: endpoint(row.operation), endpoint: endpoint(row.endpoint_key),
          outcome: allowed(row.outcome, new Set(['pending', 'succeeded', 'rejected', 'unknown', 'succeeded_unusable'])),
          httpStatus: http(row.http_status), businessCode: integer(row.business_code), errorCode: allowed(row.error_code, ERRORS),
          billed: bool(row.billed), startedAt: time(row.started_at), completedAt: time(row.completed_at) })),
        ownCallsTruncated: ownCalls.length > LIMIT,
        historicalCircuitState: 'not_recorded_here', historicalRoutingPolicy: 'not_recorded_here' },
      current: { observedAt: time(request.observed_at), selectedFrom: 'historical_gateway_provider_only',
        providerCircuits: states.map(stateProjection),
        missingProviderStateRows: providers.filter(provider => !states.some(row => row.provider_key === provider)),
        contractTableAvailable: bool(request.has_contract_circuits),
        platformContractCircuits: contracts.map(stateProjection),
        missingPlatformContractRows: request.has_contract_circuits
          ? providers.filter(provider => !contracts.some(row => row.provider_key === provider)) : null,
        searchPolicyTableAvailable: bool(request.has_search_routes),
        searchPolicy: policy ? { mode: allowed(policy.mode, new Set(['fixed', 'priority', 'paused'])),
          primaryProvider: allowed(policy.primary_provider, PROVIDERS), fallbackProvider: allowed(policy.fallback_provider, PROVIDERS),
          revision: integer(policy.revision), updatedAt: time(policy.updated_at) } : null },
      nearbyHistoricalFailures: nearby.slice(0, LIMIT).map(row => ({ callId: uuid(row.id), provider: allowed(row.provider_key, PROVIDERS),
        marketplace: allowed(row.marketplace, PLATFORMS), operation: endpoint(row.operation), endpoint: endpoint(row.endpoint_key),
        outcome: allowed(row.outcome, new Set(['rejected', 'unknown', 'succeeded_unusable'])),
        httpStatus: http(row.http_status), businessCode: integer(row.business_code), errorCode: allowed(row.error_code, ERRORS),
        billed: bool(row.billed), startedAt: time(row.started_at), completedAt: time(row.completed_at),
        completedBeforeTarget: bool(row.completed_before_target) })),
      nearbyFailuresTruncated: nearby.length > LIMIT, rowLimit: LIMIT,
      evidenceLimit: 'Current policy/circuits do not prove historical state. Nearby failures are candidates, not proven circuit triggers; only starts within 5 minutes of the reservation are included. Empty ownCalls alone does not prove no dispatch. Ecommerce marketplace circuits/routes require diagnose-ecommerce-search.mjs; the authorization platform ecommerce is not a marketplace scope.' }
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
    console.log(JSON.stringify(await diagnoseProviderCircuit(pool, requestId), null, 2))
  } catch (error) {
    console.error(JSON.stringify({ error: error?.message === 'diagnostic_schema_unavailable' ? error.message : failure(error).message }))
    process.exitCode = 1
  } finally { await pool?.end() }
}
