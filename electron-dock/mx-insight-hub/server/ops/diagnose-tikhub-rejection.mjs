import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

// Standalone so operators can pipe this source into an existing read-only Pod.
// No runtime adapter imports, supplier requests, writes or request replays.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_BYTES = 8 * 1024 * 1024
const INSTAGRAM_OPERATION = 'native.t.instagram_v3_general_search'
const NATIVE_CONTRACT = 'mx-insight-hub.native-forwarding.v1'
const PATHS = new Set(['/api/v1/data/search', '/api/v1/search/raw', '/api/v1/night-all/search/raw',
  '/api/v1/xiaohongshu/app_v2/search_notes', '/api/v1/data/native/t.instagram_v3_general_search'])
const ERRORS = new Set(['upstream_request_rejected', 'upstream_rate_limited', 'upstream_auth_or_balance_unavailable',
  'upstream_endpoint_unavailable', 'upstream_http_error', 'external_platform_rejected'])
const OUTCOMES = new Set(['pending', 'succeeded', 'succeeded_unusable', 'rejected', 'unknown'])
const STATUSES = new Set(['reserved', 'committed', 'released', 'unknown'])
const PLATFORMS = new Set(['xiaohongshu', 'instagram'])
const OPERATIONS = new Set(['social.posts.search', INSTAGRAM_OPERATION])
const ENDPOINTS = new Set(['xiaohongshu.app-v2.search-notes.v1', INSTAGRAM_OPERATION])
const CONTRACTS = new Set(['night-all.data-search.v1', NATIVE_CONTRACT])
const MESSAGES = new Map([['Bad Request', 'bad_request'], ['Unauthorized', 'unauthorized'],
  ['Forbidden', 'forbidden'], ['Not Found', 'not_found'], ['Too Many Requests', 'too_many_requests'],
  ['Internal Server Error', 'internal_server_error'],
  // This reviewed text is a supplier claim, not a billing-ledger correction.
  ["Request failed. Please retry. Check the docs below to verify your parameters, test with the default demo parameters, and send the response JSON to support. You won't be charged for this request.",
    'request_failed_no_charge_claim']])
const kind = value => value === undefined ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
const object = value => kind(value) === 'object'
const uuid = value => typeof value === 'string' && UUID.test(value) ? value : null
const integer = value => Number.isSafeInteger(value) ? value : null
const allowed = (value, values) => value == null ? null : values.has(value) ? value : 'other'
const present = value => value !== undefined && value !== null
const textShape = value => ({ type: kind(value), length: typeof value === 'string' ? value.length : null })
const messageShape = value => ({ ...textShape(value), classification: typeof value === 'string'
  ? MESSAGES.get(value) || 'other_text' : 'not_text' })
const envelope = value => ({ type: kind(value), code: integer(value?.code), requestId: uuid(value?.request_id),
  message: messageShape(value?.message), msg: messageShape(value?.msg) })
const instagramParameterShape = params => ({ type: kind(params),
  fields: Object.fromEntries(['query', 'next_max_id', 'rank_token', 'enable_metadata'].map(name => {
    const value = object(params) ? params[name] : undefined
    return [name, { ...textShape(value), empty: typeof value === 'string' ? value.length === 0 : null }]
  })) })

export function summarizeRejectionRequest(snapshot) {
  const body = object(snapshot?.body) ? snapshot.body : {}
  return { path: allowed(snapshot?.path, PATHS), page: integer(body.page), count: integer(body.count),
    pageSize: integer(body.pageSize), keyword: { present: present(body.keyword), ...textShape(body.keyword) },
    query: { present: present(body.query), ...textShape(body.query) }, cursorPresent: present(body.cursor) }
}

// Emit only fixed keys, integers, UUIDs and text types/lengths. Never emit an
// arbitrary message, field name, URL, keyword, cursor, credential or raw body.
export function inspectTikHubRejectionArchive(archive, { instagramSearch = false } = {}) {
  if (!archive) return { state: 'archive_missing' }
  if (archive.body_size > MAX_BYTES) return { state: 'archive_too_large' }
  const bytes = archive.body_bytes instanceof Uint8Array ? Buffer.from(archive.body_bytes) : null
  if (bytes?.length > MAX_BYTES) return { state: 'archive_too_large' }
  if (!bytes || (archive.body_size != null && archive.body_size !== bytes.length)
    || createHash('sha256').update(bytes).digest('hex') !== archive.body_sha256) {
    return { state: 'archive_integrity_failed' }
  }
  let payload
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { return { state: 'archive_not_json', hashVerified: true } }
  const detail = object(payload) ? payload.detail : undefined
  return { state: 'archive_verified', hashVerified: true, byteLength: bytes.length,
    root: envelope(payload), detail: { ...envelope(detail),
      // The reviewed supplier error envelope can echo params under detail.
      // Report only that location's shape; do not search other nesting, decode
      // strings or infer parameter validity from its values or from HTTP 400.
      ...(instagramSearch ? { params: instagramParameterShape(object(detail) ? detail.params : undefined) } : {}) } }
}

export async function diagnoseTikHubRejection(pool, requestId) {
  if (!uuid(requestId)) throw new Error('invalid_request_id')
  const client = await pool.connect()
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'")
    const { rows: [request] } = await client.query(`SELECT platform, status, error_code, response_status, acquisition_request
      FROM public.usage_requests WHERE id = $1`, [requestId])
    if (!request) throw new Error('request_not_found')
    const { rows: calls } = await client.query(`SELECT id, operation, endpoint_key, contract_version, outcome,
      http_status, business_code, error_code, upstream_request_id, billed
      FROM external_platform.provider_calls
      WHERE usage_request_id = $1 AND provider_key = 'tikhub'
      ORDER BY started_at, id LIMIT 10`, [requestId])
    const evidence = []
    for (const call of calls.slice(0, 10)) {
      const { rows: [archive] } = await client.query(`SELECT body_size, body_sha256,
        CASE WHEN body_size <= 8388608 AND octet_length(body_bytes) <= 8388608 THEN body_bytes ELSE NULL END AS body_bytes
        FROM control.external_platform_restricted_raw_responses WHERE provider_call_id = $1`, [call.id])
      evidence.push({ callId: uuid(call.id), operation: allowed(call.operation, OPERATIONS),
        endpoint: allowed(call.endpoint_key, ENDPOINTS), contract: allowed(call.contract_version, CONTRACTS),
        outcome: allowed(call.outcome, OUTCOMES), httpStatus: integer(call.http_status),
        businessCode: integer(call.business_code), errorCode: allowed(call.error_code, ERRORS),
        upstreamRequestId: uuid(call.upstream_request_id), billed: typeof call.billed === 'boolean' ? call.billed : null,
        archive: inspectTikHubRejectionArchive(archive, { instagramSearch: call.operation === INSTAGRAM_OPERATION
          && call.endpoint_key === INSTAGRAM_OPERATION && call.contract_version === NATIVE_CONTRACT }) })
    }
    return { requestId, platform: allowed(request.platform, PLATFORMS),
      status: allowed(request.status, STATUSES), httpStatus: integer(request.response_status),
      errorCode: allowed(request.error_code, ERRORS), request: summarizeRejectionRequest(request.acquisition_request),
      callLimit: 10, callLimitReached: calls.length >= 10, evidence }
  } finally {
    // A diagnostic never commits, even on success; discard a broken connection.
    let rollbackError
    try { await client.query('ROLLBACK') } catch (error) { rollbackError = error }
    client.release(rollbackError)
    if (rollbackError) throw new Error('diagnostic_read_failed')
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
    console.log(JSON.stringify(await diagnoseTikHubRejection(pool, requestId), null, 2))
  } catch (error) {
    const known = new Set(['invalid_arguments', 'invalid_request_id', 'database_url_required', 'request_not_found'])
    console.error(JSON.stringify({ error: known.has(error.message) ? error.message : 'diagnostic_read_failed' }))
    process.exitCode = 1
  } finally { await pool?.end() }
}
