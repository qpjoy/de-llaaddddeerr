import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Standalone stdin diagnostic: no application imports, upstream calls or writes.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SHA = /^[0-9a-f]{64}$/u
const LIMIT = 20
const PATHS = ['/api/v1/data/search', '/api/v1/search/raw', '/api/v1/night-all/search/raw', '/api/v1/data/social/search']
const METERS = ['twitter', 'raw', 'crawl', 'user-info', 'social.content.search', 'social.content.crawl', 'social.profile.get']
const ERRORS = ['social_upstream_outcome_unknown', 'social_upstream_response_unusable', 'social_upstream_rejected',
  'social_upstream_timeout_or_size_limit', 'social_egress_unavailable', 'external_platform_persistence_unknown',
  'external_platform_call_persistence_unknown', 'external_platform_pre_dispatch_failed', 'reservation_lease_expired',
  'external_platform_busy', 'external_platform_rate_limited', 'external_platform_circuit_open',
  'request_outcome_unknown', 'request_in_progress', 'upstream_transport_error', 'upstream_deadline_exceeded',
  'proxy_route_unavailable', 'proxy_routes_unreachable', 'night_all_outcome_unknown',
  'night_all_internal_error', 'night_all_invalid_upstream_content_type', 'night_all_invalid_upstream_json',
  'night_all_invalid_upstream_contract', 'night_all_partial_result', 'compatibility_commit_ambiguous',
  'usage_commit_ambiguous', 'upstream_outcome_unknown',
  ...Array.from({ length: 200 }, (_, index) => `night_all_http_${index + 400}`)]
const PROTOCOL_ERRORS = [...ERRORS, 'search_v2_projection_unavailable', 'search_v2_unavailable',
  'idempotency_conflict', 'invalid_cursor', 'invalid_time_window', 'internal_error',
  'usage_commit_ambiguous', 'external_platform_unavailable']
const TRANSPORT_CODES = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'ABORT_ERR',
  'proxy_route_unavailable', 'proxy_routes_unreachable', '08000', '08001', '08003', '08004',
  '08006', '08007', '08P01', '42501', '42703', '42P01', '53300', '53400', '57P01', '57P02', '57P03']
const FAILURES = ['invalid_arguments', 'invalid_request_id', 'database_url_required', 'request_not_found', 'request_not_twitter_search']
const FAILURE_PHASES = ['admission', 'begin_call', 'provider_request', 'finish_step', 'supplier_handoff',
  'finish_failure', 'project_response', 'stage_evidence', 'assemble_page', 'build_delivery', 'commit_delivery']
const FAILURE_CLASSES = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AppError', 'RapidApiUpstreamError']
const choice = (value, values) => value == null ? null : values.includes(value) ? value : 'other'
const uuid = value => typeof value === 'string' && UUID.test(value) ? value : null
const hash = value => typeof value === 'string' && SHA.test(value) ? value : null
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const boolean = value => typeof value === 'boolean' ? value : null
const http = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null
const time = value => {
  if (!(value instanceof Date) && !(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?$/u.test(value))) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
const failure = error => new Error(FAILURES.includes(error?.message) ? error.message : 'diagnostic_read_failed')
const elapsed = (start, end) => time(start) && time(end) ? integer(Date.parse(time(end)) - Date.parse(time(start))) : null
const validComparison = value => value == null || typeof value === 'string' && value.length > 0 && value.length <= 500 && !value.includes('\0')

export function projectTwitterTransportFailure(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const codes = Array.isArray(value.codes) ? value.codes.slice(0, 32) : []
  return { phase: choice(value.phase, ['request', 'body']),
    codes: [...new Set(codes.filter(code => TRANSPORT_CODES.includes(code)))],
    unrecognizedCodes: codes.some(code => !TRANSPORT_CODES.includes(code)),
    codesTruncated: Array.isArray(value.codes) && value.codes.length > 32,
    deadlineExceeded: boolean(value.deadlineExceeded), elapsedMs: integer(value.elapsedMs), timeoutMs: integer(value.timeoutMs) }
}

export function projectTwitterRateLimit(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return { observedAt: time(value.observedAt), httpStatus: http(value.httpStatus),
    retryAfterSeconds: integer(value.retryAfterSeconds),
    headers: Object.fromEntries(['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset',
      'x-ratelimit-requests-limit', 'x-ratelimit-requests-remaining', 'x-ratelimit-requests-reset']
      .map(name => [name, integer(value.headers?.[name])])) }
}

export function twitterOutcomeRuntime() {
  const root = process.argv[1] === '-' ? pathToFileURL(`${process.cwd()}/`) : new URL('../../', import.meta.url)
  const files = ['server/adapters/rapidapi.mjs', 'server/external-platforms/twitter-search-fill.mjs',
    'server/data/search-protocol.mjs', 'server/data/search-protocol-store.mjs']
  return { scope: 'diagnostic_container_only_not_public_serving_version',
    nodeVersion: /^v\d+\.\d+\.\d+$/u.test(process.version) ? process.version : null,
    installedSources: files.map(file => {
      try {
        const path = new URL(file, root), stat = statSync(path)
        if (!stat.isFile() || stat.size > 1024 * 1024) return { file, state: 'unavailable', sha256: null }
        const bytes = readFileSync(path)
        return { file, state: 'hashed', sha256: createHash('sha256').update(bytes).digest('hex') }
      } catch { return { file, state: 'unavailable', sha256: null } }
    }) }
}

async function readSearchProtocol(client, requestId) {
  // Inspect optional schema before querying: old deployments must retain the
  // original diagnostic without aborting the read-only transaction on 42P01.
  const { rows: [tables] } = await client.query(`SELECT /* twitter-protocol:tables */
    to_regclass('control.data_search_protocol_bindings') IS NOT NULL AS bindings,
    to_regclass('control.data_search_protocol_leases') IS NOT NULL AS leases`)
  const bindingsPresent = tables?.bindings === true, leasesPresent = tables?.leases === true
  let bindings = [], leases = []
  if (bindingsPresent) {
    bindings = (await client.query(`SELECT /* twitter-protocol:bindings */
      b.state, b.usage_request_id, b.created_at, b.updated_at, b.lease_expires_at,
      b.lease_expires_at <= now() AS lease_expired,
      b.result IS NOT NULL AS result_present,
      CASE WHEN b.error->>'code'=ANY($2::text[]) THEN b.error->>'code'
        WHEN b.error->>'code' IS NULL THEN NULL ELSE 'other' END AS error_code
      FROM public.usage_requests u
      JOIN control.data_search_protocol_bindings b ON b.tenant_id=u.tenant_id
        AND b.consumer_id=u.consumer_id AND b.api_key_id=u.api_key_id AND b.platform=u.platform
        AND (b.usage_request_id=u.id OR b.idempotency_key=u.idempotency_key)
      WHERE u.id = $1::uuid ORDER BY b.created_at, b.owner_id LIMIT 21`, [requestId, PROTOCOL_ERRORS])).rows
  }
  if (leasesPresent) {
    // A pending protocol finish may not yet have persisted usage_request_id.
    // The immutable caller/key scope still ties its lease to this exact usage.
    leases = (await client.query(`SELECT /* twitter-protocol:leases */
      l.version, l.expires_at, l.expires_at <= now() AS expired
      FROM public.usage_requests u
      JOIN control.data_search_protocol_leases l ON l.tenant_id=u.tenant_id
        AND l.consumer_id=u.consumer_id AND l.api_key_id=u.api_key_id AND l.platform=u.platform
        AND (l.idempotency_key=u.idempotency_key${bindingsPresent ? ` OR EXISTS (
          SELECT 1 FROM control.data_search_protocol_bindings b WHERE b.owner_id=l.owner_id
            AND b.tenant_id=u.tenant_id AND b.consumer_id=u.consumer_id AND b.api_key_id=u.api_key_id
            AND b.platform=u.platform AND b.idempotency_key=l.idempotency_key AND b.usage_request_id=u.id)` : ''})
      WHERE u.id = $1::uuid ORDER BY l.expires_at, l.owner_id LIMIT 21`, [requestId])).rows
  }
  return { tables: { bindings: bindingsPresent, leases: leasesPresent },
    bindings: bindings.slice(0, LIMIT).map(row => ({ version: 2,
      state: choice(row.state, ['running', 'retryable', 'complete', 'failed', 'unknown']),
      effectiveState: row.state === 'running' && row.lease_expired === true ? 'unknown'
        : choice(row.state, ['running', 'retryable', 'complete', 'failed', 'unknown']),
      usageRequestId: uuid(row.usage_request_id), createdAt: time(row.created_at), updatedAt: time(row.updated_at),
      leaseExpiresAt: time(row.lease_expires_at), leaseExpired: boolean(row.lease_expired),
      resultPresent: boolean(row.result_present), errorCode: choice(row.error_code, PROTOCOL_ERRORS) })),
    leases: leases.slice(0, LIMIT).map(row => ({ version: [1, 2].includes(row.version) ? row.version : null,
      expiresAt: time(row.expires_at), expired: boolean(row.expired) })),
    rowLimit: LIMIT, bindingsTruncated: bindings.length > LIMIT, leasesTruncated: leases.length > LIMIT,
    interpretation: 'Inner usage may record v1 even for v2. A committed acquisition does not confirm v2 delivery; expired running state remains unknown. Missing tables or bindings do not authorize retry.' }
}

async function readLegacyConnectorCalls(client, requestId) {
  const { rows: [tables] } = await client.query(`SELECT /* twitter-connector:tables */
    to_regclass('serving.connector_calls') IS NOT NULL AS calls`)
  const present = tables?.calls === true
  const rows = present ? (await client.query(`SELECT /* twitter-connector:calls */
    c.id, c.operation, c.platform, c.source_mode, c.outcome, c.http_status, c.failure_kind,
    c.upstream_latency_ms, c.started_at, c.completed_at,
    c.request_fingerprint IS NOT NULL AS request_fingerprint_present,
    c.request_fingerprint=u.fingerprint AS fingerprint_matches_usage,
    c.platform=u.platform AS platform_matches_usage,
    c.upstream_request_id IS NOT NULL AS upstream_request_id_present,
    c.upstream_trace_id IS NOT NULL AS upstream_trace_id_present,
    CASE WHEN c.error_code=ANY($2::text[]) THEN c.error_code
      WHEN c.error_code IS NULL THEN NULL ELSE 'other' END AS error_code
    FROM serving.connector_calls c JOIN public.usage_requests u
      ON c.usage_request_id=u.id AND c.consumer_id=u.consumer_id
    WHERE u.id = $1::uuid ORDER BY c.started_at, c.id LIMIT 21`, [requestId, ERRORS])).rows : []
  return { tablePresent: present,
    calls: rows.slice(0, LIMIT).map(row => ({ callId: uuid(row.id),
      operation: choice(row.operation, ['data-search', 'data.search', 'search', 'raw', 'crawl', 'user-info']),
      platform: choice(row.platform, ['twitter']), sourceMode: choice(row.source_mode, ['live', 'stale']),
      outcome: choice(row.outcome, ['complete', 'partial', 'failed', 'unknown']), httpStatus: http(row.http_status),
      failureKind: choice(row.failure_kind, ['network', 'timeout', 'http', 'contract', 'business', 'internal', 'unknown']),
      errorCode: choice(row.error_code, ERRORS), upstreamLatencyMs: integer(row.upstream_latency_ms),
      elapsedMs: elapsed(row.started_at, row.completed_at), startedAt: time(row.started_at), completedAt: time(row.completed_at),
      requestFingerprintPresent: boolean(row.request_fingerprint_present),
      fingerprintMatchesUsage: boolean(row.fingerprint_matches_usage), platformMatchesUsage: boolean(row.platform_matches_usage),
      upstreamRequestIdPresent: boolean(row.upstream_request_id_present), upstreamTraceIdPresent: boolean(row.upstream_trace_id_present) })),
    rowLimit: LIMIT, callsTruncated: rows.length > LIMIT,
    interpretation: 'Connector evidence records a Hub-to-Night-All attempt, not its downstream supplier billing. Its schema retains no request path, body or query; a fingerprint cannot reconstruct them. Missing calls do not authorize retry.' }
}

async function readRequestFailure(client, requestId) {
  const { rows: [tables] } = await client.query(`SELECT /* twitter-failure:table */
    to_regclass('public.usage_request_failures') IS NOT NULL AS failures`)
  const tablePresent = tables?.failures === true
  const row = tablePresent ? (await client.query(`SELECT /* twitter-failure:record */
    request_id, phase, sql_state, call_id, error_class, recorded_at
    FROM public.usage_request_failures WHERE request_id = $1::uuid`, [requestId])).rows[0] : null
  return { tablePresent, present: Boolean(row), record: row ? {
    requestId: uuid(row.request_id), phase: choice(row.phase, FAILURE_PHASES),
    sqlState: typeof row.sql_state === 'string' && /^[0-9A-Z]{5}$/u.test(row.sql_state) ? row.sql_state : null,
    callId: uuid(row.call_id), errorClass: choice(row.error_class, FAILURE_CLASSES), recordedAt: time(row.recorded_at),
  } : null, interpretation: 'First saved failure metadata only. Missing evidence may predate collection or reflect a failed diagnostic write; it does not authorize retry.' }
}

export async function diagnoseTwitterOutcome(pool, requestId, { compareQuery = null } = {}) {
  if (!uuid(requestId)) throw new Error('invalid_request_id')
  if (!validComparison(compareQuery)) throw new Error('invalid_arguments')
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'")
    const { rows: [request] } = await client.query(`SELECT /* twitter-outcome:usage */
      platform, status, response_status, reserved_at, completed_at, upstream_latency_ms,
      CASE WHEN error_code=ANY($3::text[]) THEN error_code
        WHEN error_code IS NULL THEN NULL ELSE 'other' END AS error_code,
      CASE WHEN billing_meter_key=ANY($4::text[]) THEN billing_meter_key
        WHEN billing_meter_key IS NULL THEN NULL ELSE 'other' END AS billing_meter_key,
      CASE WHEN capability=ANY($4::text[]) THEN capability
        WHEN capability IS NULL THEN NULL ELSE 'other' END AS capability,
      fingerprint IS NOT NULL AS request_fingerprint_present,
      acquisition_request IS NOT NULL AS acquisition_request_present,
      COALESCE(acquisition_request->'body' <> 'null'::jsonb, false) AS body_present,
      COALESCE(acquisition_request#>'{body,query}' <> 'null'::jsonb, false) AS query_present,
      COALESCE(jsonb_typeof(acquisition_request#>'{body,query}')='string', false) AS query_is_string,
      CASE WHEN $2::text IS NOT NULL AND jsonb_typeof(acquisition_request#>'{body,query}')='string'
        THEN acquisition_request#>>'{body,query}' = $2::text ELSE NULL END AS query_equals_comparison,
      acquisition_request->>'path' AS request_path, clock_timestamp() AS database_now
      FROM public.usage_requests WHERE id = $1::uuid`, [requestId, compareQuery, ERRORS, METERS])
    if (!request) throw new Error('request_not_found')
    if (request.platform !== 'twitter' || request.request_path != null && !PATHS.includes(request.request_path)) throw new Error('request_not_twitter_search')
    const { rows: calls } = await client.query(`SELECT /* twitter-outcome:calls */
      c.id, c.provider_key, c.operation, c.endpoint_key, c.endpoint_version, c.contract_version,
      c.outcome, c.http_status, c.business_code, c.billed, c.error_code, c.item_count, c.latency_ms,
      c.started_at, c.completed_at, c.upstream_request_id IS NOT NULL AS upstream_request_id_present,
      a.id IS NOT NULL AS operational_archive_present, a.contract_state, a.http_status AS archive_http_status,
      a.body_size AS archive_body_size, a.payload_sha256 AS archive_sha256, a.captured_at AS archive_captured_at,
      CASE WHEN octet_length((a.raw_payload #> '{response,transportFailure}')::text) <= 4096
        THEN a.raw_payload #> '{response,transportFailure}' END AS transport_failure,
      COALESCE(octet_length((a.raw_payload #> '{response,transportFailure}')::text) > 4096, false) AS transport_failure_too_large,
      CASE WHEN octet_length((a.raw_payload #> '{response,rateLimit}')::text) <= 4096
        THEN a.raw_payload #> '{response,rateLimit}' END AS rate_limit,
      COALESCE(octet_length((a.raw_payload #> '{response,rateLimit}')::text) > 4096, false) AS rate_limit_too_large,
      r.id IS NOT NULL AS restricted_archive_present, r.body_size AS restricted_body_size,
      r.body_sha256 AS restricted_sha256, r.captured_at AS restricted_captured_at, r.json_parsed
      FROM external_platform.provider_calls c
      LEFT JOIN external_platform.response_archives a ON a.provider_call_id = c.id
      LEFT JOIN control.external_platform_restricted_raw_responses r ON r.provider_call_id = c.id
      WHERE c.usage_request_id = $1::uuid ORDER BY c.started_at, c.id LIMIT 21`, [requestId])
    const { rows: gateways } = await client.query(`SELECT /* twitter-outcome:gateways */
      provider_call_id, source_mode, succeeded, response_status, error_code, created_at
      FROM external_platform.gateway_requests WHERE usage_request_id = $1::uuid
      ORDER BY created_at, id LIMIT 21`, [requestId])
    const searchProtocol = await readSearchProtocol(client, requestId)
    const legacyConnector = await readLegacyConnectorCalls(client, requestId)
    const failureDiagnostic = await readRequestFailure(client, requestId)
    return { diagnosticRevision: 'twitter-outcome-diagnostic.v5', requestId, platform: 'twitter',
      status: choice(request.status, ['reserved', 'committed', 'released', 'unknown']),
      errorCode: choice(request.error_code, ERRORS), savedHttpStatus: http(request.response_status),
      billingMeterKey: choice(request.billing_meter_key, METERS), capability: choice(request.capability, METERS),
      requestPath: request.request_path ?? null, requestPathUnknown: request.request_path == null,
      reservedAt: time(request.reserved_at), completedAt: time(request.completed_at),
      elapsedMs: elapsed(request.reserved_at, request.completed_at), upstreamLatencyMs: integer(request.upstream_latency_ms),
      requestEvidence: { requestFingerprintPresent: boolean(request.request_fingerprint_present),
        acquisitionRequestPresent: boolean(request.acquisition_request_present), bodyPresent: boolean(request.body_present),
        queryPresent: boolean(request.query_present), queryIsString: boolean(request.query_is_string),
        comparisonProvided: compareQuery != null, queryEqualsComparison: boolean(request.query_equals_comparison),
        comparisonMeaning: 'Exact saved body.query equality only; null means no comparable evidence. The compared query and fingerprint are not returned.' },
      databaseNow: time(request.database_now),
      ownCalls: calls.slice(0, LIMIT).map(row => ({ callId: uuid(row.id),
        provider: choice(row.provider_key, ['rapidapi']), operation: choice(row.operation, ['social.content.search']),
        endpoint: choice(row.endpoint_key, ['twitter-aio.search']), endpointVersion: choice(row.endpoint_version, ['twitter-aio.hub.v1']),
        contractVersion: choice(row.contract_version, ['mx-insight-hub.social-data.v1']),
        outcome: choice(row.outcome, ['pending', 'succeeded', 'succeeded_unusable', 'rejected', 'unknown']),
        httpStatus: http(row.http_status), businessCode: Number.isSafeInteger(row.business_code) ? row.business_code : null,
        billed: boolean(row.billed), errorCode: choice(row.error_code, ERRORS), itemCount: integer(row.item_count),
        latencyMs: integer(row.latency_ms), startedAt: time(row.started_at), completedAt: time(row.completed_at),
        upstreamRequestIdPresent: boolean(row.upstream_request_id_present),
        operationalArchive: { present: boolean(row.operational_archive_present),
          contractState: choice(row.contract_state, ['accepted', 'rejected', 'unknown', 'succeeded_unusable', 'not_dispatched']),
          httpStatus: http(row.archive_http_status), bodySize: integer(row.archive_body_size), sha256: hash(row.archive_sha256),
          capturedAt: time(row.archive_captured_at), transportFailure: projectTwitterTransportFailure(row.transport_failure),
          transportFailureTooLarge: boolean(row.transport_failure_too_large),
          rateLimit: projectTwitterRateLimit(row.rate_limit), rateLimitTooLarge: boolean(row.rate_limit_too_large) },
        restrictedArchive: { present: boolean(row.restricted_archive_present), bodySize: integer(row.restricted_body_size),
          sha256: hash(row.restricted_sha256), capturedAt: time(row.restricted_captured_at), jsonParsed: boolean(row.json_parsed),
          integrity: 'metadata_only_not_verified' } })),
      gateways: gateways.slice(0, LIMIT).map(row => ({ providerCallId: uuid(row.provider_call_id),
        sourceMode: choice(row.source_mode, ['live', 'fresh_cache', 'stored_fallback', 'idempotent_replay', 'duplicate_suppressed', 'circuit_rejected', 'unavailable']),
        succeeded: boolean(row.succeeded), httpStatus: http(row.response_status), errorCode: choice(row.error_code, ERRORS), createdAt: time(row.created_at) })),
      rowLimit: LIMIT, ownCallsTruncated: calls.length > LIMIT, gatewaysTruncated: gateways.length > LIMIT,
      searchProtocol, legacyConnector, failureDiagnostic,
      interpretation: 'Missing HTTP/archives does not prove no dispatch or no charge; historical transport detail may not have been retained.' }
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

if (process.argv[1] === '-' || process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let pool
  try {
    const [requestId, option, compareQuery = null, extra] = process.argv.slice(2)
    if (!requestId || option != null && (option !== '--compare-query' || compareQuery == null) || extra || !validComparison(compareQuery)) throw new Error('invalid_arguments')
    if (!uuid(requestId)) throw new Error('invalid_request_id')
    if (!process.env.DATABASE_URL) throw new Error('database_url_required')
    const { default: pg } = await import('pg')
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, query_timeout: 6000 })
    console.log(JSON.stringify({ ...await diagnoseTwitterOutcome(pool, requestId, { compareQuery }), runtime: twitterOutcomeRuntime() }, null, 2))
  } catch (error) {
    console.error(JSON.stringify({ error: failure(error).message }))
    process.exitCode = 1
  } finally { await pool?.end() }
}
