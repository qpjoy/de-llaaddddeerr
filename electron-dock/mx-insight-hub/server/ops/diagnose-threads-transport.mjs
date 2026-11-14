import { pathToFileURL } from 'node:url'

// Standalone stdin diagnostic for old Admin images. Keep all projections local.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const LIMIT = 20
const ENDPOINTS = [
  ...['user_info', 'user_posts', 'user_reposts', 'user_replies', 'post_get_id', 'post_detail',
    'post_related', 'post_comments', 'search_top', 'search_recent', 'search_profiles',
    'scraper_search_posts', 'scraper_user_detail', 'scraper_user_detail_with_biolink', 'scraper_search_users',
    'scraper_user_posts', 'scraper_post_detail', 'scraper_resolve_post', 'scraper_post_media', 'scraper_profiles_batch']
    .map(name => `native.r.threads_${name}`),
  ...['06c2a6bd48a28096', '6ed05f6aae232935', '67e96da77f8c4d36', '3373e07cf15256c1',
    '52ba4078e18653d1', '6878f42802227f49', 'dfe3e53d555c3766', 'fe58186e16adc3bb',
    'dc7793fe70c053a9', 'c5b777a8cb915521', '01fa5792e82a0605', '37b3bbbdb7234c59']
    .map(name => `native.t.api_${name}`),
]
const ERRORS = ['social_upstream_outcome_unknown', 'social_upstream_response_unusable', 'social_upstream_rejected',
  'social_upstream_timeout_or_size_limit', 'social_egress_unavailable', 'external_platform_rejected',
  'external_platform_persistence_unknown', 'external_platform_call_persistence_unknown',
  'external_platform_pre_dispatch_failed', 'external_platform_busy', 'external_platform_rate_limited',
  'external_platform_circuit_open', 'upstream_transport_error', 'upstream_deadline_exceeded',
  'request_outcome_unknown', 'upstream_outcome_unknown', 'request_in_progress', 'reservation_lease_expired']
// Same restricted codes and fields as diagnose-twitter-outcome.mjs.
const TRANSPORT_CODES = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'ABORT_ERR',
  'proxy_route_unavailable', 'proxy_routes_unreachable', '08000', '08001', '08003', '08004',
  '08006', '08007', '08P01', '42501', '42703', '42P01', '53300', '53400', '57P01', '57P02', '57P03']
const FAILURES = ['invalid_arguments', 'invalid_request_id', 'database_url_required', 'request_not_found']
const choice = (value, values) => value == null ? null : values.includes(value) ? value : 'other'
const uuid = value => typeof value === 'string' && UUID.test(value) ? value : null
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const boolean = value => typeof value === 'boolean' ? value : null
const http = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null
const failure = error => new Error(FAILURES.includes(error?.message) ? error.message : 'diagnostic_read_failed')

export function projectThreadsTransportFailure(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const codes = Array.isArray(value.codes) ? value.codes.slice(0, 32) : []
  return { phase: choice(value.phase, ['request', 'body']),
    codes: [...new Set(codes.filter(code => TRANSPORT_CODES.includes(code)))],
    unrecognizedCodes: codes.some(code => !TRANSPORT_CODES.includes(code)),
    codesTruncated: Array.isArray(value.codes) && value.codes.length > 32,
    deadlineExceeded: boolean(value.deadlineExceeded), elapsedMs: integer(value.elapsedMs), timeoutMs: integer(value.timeoutMs) }
}

export async function diagnoseThreadsTransport(pool, requestId) {
  if (!uuid(requestId)) throw new Error('invalid_request_id')
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'")
    const { rows: [request] } = await client.query(`SELECT /* threads-transport:usage */
      status, response_status, upstream_latency_ms, error_code
      FROM public.usage_requests WHERE id = $1::uuid AND platform = 'threads'`, [requestId])
    if (!request) throw new Error('request_not_found')
    const { rows: calls } = await client.query(`SELECT /* threads-transport:calls */
      c.id, c.provider_key, c.endpoint_key, c.outcome, c.http_status, c.latency_ms, c.billed, c.error_code,
      a.id IS NOT NULL AS archive_present,
      CASE WHEN c.provider_key = 'rapidapi' AND octet_length((a.raw_payload #> '{response,transportFailure}')::text) <= 4096
        THEN a.raw_payload #> '{response,transportFailure}' END AS transport_failure,
      COALESCE(c.provider_key = 'rapidapi' AND octet_length((a.raw_payload #> '{response,transportFailure}')::text) > 4096, false) AS transport_failure_too_large
      FROM external_platform.provider_calls c
      JOIN public.usage_requests u ON u.id = c.usage_request_id AND u.platform = 'threads'
      LEFT JOIN external_platform.response_archives a ON a.provider_call_id = c.id
      WHERE c.usage_request_id = $1::uuid ORDER BY c.started_at, c.id LIMIT 21`, [requestId])
    return { diagnosticRevision: 'threads-transport-diagnostic.v1', requestId, platform: 'threads',
      status: choice(request.status, ['reserved', 'committed', 'released', 'unknown']),
      httpStatus: http(request.response_status), latencyMs: integer(request.upstream_latency_ms),
      errorCode: choice(request.error_code, ERRORS),
      calls: calls.slice(0, LIMIT).map(row => ({ callId: uuid(row.id),
        provider: choice(row.provider_key, ['rapidapi', 'tikhub']), endpoint: choice(row.endpoint_key, ENDPOINTS),
        outcome: choice(row.outcome, ['pending', 'succeeded', 'succeeded_unusable', 'rejected', 'unknown']),
        httpStatus: http(row.http_status), latencyMs: integer(row.latency_ms), billed: boolean(row.billed),
        errorCode: choice(row.error_code, ERRORS), archivePresent: boolean(row.archive_present),
        transportFailure: row.provider_key === 'rapidapi' ? projectThreadsTransportFailure(row.transport_failure) : null,
        transportFailureTooLarge: boolean(row.transport_failure_too_large) })),
      rowLimit: LIMIT, callsTruncated: calls.length > LIMIT }
  } catch (error) { throw failure(error) }
  finally {
    if (client) {
      let rollbackError
      try { await client.query('ROLLBACK') } catch (error) { rollbackError = error }
      try { client.release(rollbackError) } catch { throw new Error('diagnostic_read_failed') }
      if (rollbackError) throw new Error('diagnostic_read_failed')
    }
  }
}

if (process.argv[1] === '-' || process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Covers pg import, connection, reads, rollback and pool shutdown together.
  const deadline = setTimeout(() => {
    console.error(JSON.stringify({ error: 'diagnostic_timeout' }))
    process.exit(1)
  }, 20000)
  let pool
  try {
    const [requestId, extra] = process.argv.slice(2)
    if (!requestId || extra !== undefined) throw new Error('invalid_arguments')
    if (!uuid(requestId)) throw new Error('invalid_request_id')
    if (!process.env.DATABASE_URL) throw new Error('database_url_required')
    const { default: pg } = await import('pg')
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, query_timeout: 6000 })
    pool.on('error', () => {}) // Idle connection errors carry private connection details.
    const report = await diagnoseThreadsTransport(pool, requestId)
    await pool.end()
    pool = null
    console.log(JSON.stringify(report, null, 2))
  } catch (error) {
    console.error(JSON.stringify({ error: failure(error).message }))
    process.exitCode = 1
  } finally {
    try { await pool?.end() } catch {
      console.error(JSON.stringify({ error: 'diagnostic_read_failed' }))
      process.exitCode = 1
    }
    clearTimeout(deadline)
  }
}
