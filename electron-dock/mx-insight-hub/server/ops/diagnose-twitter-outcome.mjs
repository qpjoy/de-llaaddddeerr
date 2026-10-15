import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Standalone stdin diagnostic: no application imports, upstream calls or writes.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SHA = /^[0-9a-f]{64}$/u
const LIMIT = 20
const PATHS = ['/api/v1/data/search', '/api/v1/search/raw', '/api/v1/night-all/search/raw', '/api/v1/data/social/search']
const ERRORS = ['social_upstream_outcome_unknown', 'social_upstream_response_unusable', 'social_upstream_rejected',
  'social_upstream_timeout_or_size_limit', 'social_egress_unavailable', 'external_platform_persistence_unknown',
  'external_platform_call_persistence_unknown', 'external_platform_pre_dispatch_failed', 'reservation_lease_expired',
  'external_platform_busy', 'external_platform_rate_limited', 'external_platform_circuit_open',
  'request_outcome_unknown', 'request_in_progress', 'upstream_transport_error', 'upstream_deadline_exceeded',
  'proxy_route_unavailable', 'proxy_routes_unreachable']
const TRANSPORT_CODES = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'ABORT_ERR',
  'proxy_route_unavailable', 'proxy_routes_unreachable', '08000', '08001', '08003', '08004',
  '08006', '08007', '08P01', '42501', '42703', '42P01', '53300', '53400', '57P01', '57P02', '57P03']
const FAILURES = ['invalid_arguments', 'invalid_request_id', 'database_url_required', 'request_not_found', 'request_not_twitter_search']
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

export function projectTwitterTransportFailure(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const codes = Array.isArray(value.codes) ? value.codes.slice(0, 32) : []
  return { phase: choice(value.phase, ['request', 'body']),
    codes: [...new Set(codes.filter(code => TRANSPORT_CODES.includes(code)))],
    unrecognizedCodes: codes.some(code => !TRANSPORT_CODES.includes(code)),
    codesTruncated: Array.isArray(value.codes) && value.codes.length > 32,
    deadlineExceeded: boolean(value.deadlineExceeded), elapsedMs: integer(value.elapsedMs), timeoutMs: integer(value.timeoutMs) }
}

export function twitterOutcomeRuntime() {
  const root = process.argv[1] === '-' ? pathToFileURL(`${process.cwd()}/`) : new URL('../../', import.meta.url)
  const files = ['server/adapters/rapidapi.mjs', 'server/external-platforms/twitter-search-fill.mjs']
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

export async function diagnoseTwitterOutcome(pool, requestId) {
  if (!uuid(requestId)) throw new Error('invalid_request_id')
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'")
    const { rows: [request] } = await client.query(`SELECT /* twitter-outcome:usage */
      platform, status, error_code, response_status, reserved_at, completed_at,
      acquisition_request->>'path' AS request_path, clock_timestamp() AS database_now
      FROM public.usage_requests WHERE id = $1::uuid`, [requestId])
    if (!request) throw new Error('request_not_found')
    if (request.platform !== 'twitter' || !PATHS.includes(request.request_path)) throw new Error('request_not_twitter_search')
    const { rows: calls } = await client.query(`SELECT /* twitter-outcome:calls */
      c.id, c.provider_key, c.operation, c.endpoint_key, c.endpoint_version, c.contract_version,
      c.outcome, c.http_status, c.business_code, c.billed, c.error_code, c.item_count, c.latency_ms,
      c.started_at, c.completed_at, c.upstream_request_id IS NOT NULL AS upstream_request_id_present,
      a.id IS NOT NULL AS operational_archive_present, a.contract_state, a.http_status AS archive_http_status,
      a.body_size AS archive_body_size, a.payload_sha256 AS archive_sha256, a.captured_at AS archive_captured_at,
      CASE WHEN octet_length((a.raw_payload #> '{response,transportFailure}')::text) <= 4096
        THEN a.raw_payload #> '{response,transportFailure}' END AS transport_failure,
      COALESCE(octet_length((a.raw_payload #> '{response,transportFailure}')::text) > 4096, false) AS transport_failure_too_large,
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
    return { diagnosticRevision: 'twitter-outcome-diagnostic.v1', requestId, platform: 'twitter',
      status: choice(request.status, ['reserved', 'committed', 'released', 'unknown']),
      errorCode: choice(request.error_code, ERRORS), savedHttpStatus: http(request.response_status),
      requestPath: request.request_path, reservedAt: time(request.reserved_at), completedAt: time(request.completed_at),
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
          transportFailureTooLarge: boolean(row.transport_failure_too_large) },
        restrictedArchive: { present: boolean(row.restricted_archive_present), bodySize: integer(row.restricted_body_size),
          sha256: hash(row.restricted_sha256), capturedAt: time(row.restricted_captured_at), jsonParsed: boolean(row.json_parsed),
          integrity: 'metadata_only_not_verified' } })),
      gateways: gateways.slice(0, LIMIT).map(row => ({ providerCallId: uuid(row.provider_call_id),
        sourceMode: choice(row.source_mode, ['live', 'fresh_cache', 'stored_fallback', 'idempotent_replay', 'duplicate_suppressed', 'circuit_rejected', 'unavailable']),
        succeeded: boolean(row.succeeded), httpStatus: http(row.response_status), errorCode: choice(row.error_code, ERRORS), createdAt: time(row.created_at) })),
      rowLimit: LIMIT, ownCallsTruncated: calls.length > LIMIT, gatewaysTruncated: gateways.length > LIMIT,
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
    const [requestId, extra] = process.argv.slice(2)
    if (!requestId || extra) throw new Error('invalid_arguments')
    if (!uuid(requestId)) throw new Error('invalid_request_id')
    if (!process.env.DATABASE_URL) throw new Error('database_url_required')
    const { default: pg } = await import('pg')
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, query_timeout: 6000 })
    console.log(JSON.stringify({ ...await diagnoseTwitterOutcome(pool, requestId), runtime: twitterOutcomeRuntime() }, null, 2))
  } catch (error) {
    console.error(JSON.stringify({ error: failure(error).message }))
    process.exitCode = 1
  } finally { await pool?.end() }
}
