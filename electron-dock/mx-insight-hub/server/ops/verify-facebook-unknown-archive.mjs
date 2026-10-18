import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

// Standalone, exact request/call/SHA inspection; no runtime, supplier or recovery imports.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SHA = /^[0-9a-f]{64}$/u
const MAX_RAW_BYTES = 4096
const MAX_OPERATIONAL_BYTES = 65536
const FAILURES = ['invalid_arguments', 'database_url_required', 'bound_archive_not_found']
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const kind = value => value === undefined ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
const hash = value => createHash('sha256').update(value).digest('hex')
const choice = (value, allowed) => value == null ? null : allowed.includes(value) ? value : 'other'
const safeFailure = error => new Error(FAILURES.includes(error?.message) ? error.message : 'archive_verification_failed')

// Same algorithm as contracts/justone.mjs canonicalJson, including undefined -> null.
// Kept local so stdin execution needs only Node and pg; tests compare with the real producer.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value === undefined ? null : value)
}

function boundedStructure(value, depth = 0, state = { nodes: 0 }) {
  if (++state.nodes > 10000 || depth > 64) return false
  return value === null || typeof value !== 'object'
    || Object.values(value).every(item => boundedStructure(item, depth + 1, state))
}

export function projectFacebookUnknownArchive(row) {
  const bytes = row.body_bytes instanceof Uint8Array ? Buffer.from(row.body_bytes) : null
  let restricted
  if (row.body_size > MAX_RAW_BYTES || row.actual_body_size > MAX_RAW_BYTES) {
    restricted = { state: 'archive_too_large' }
  } else if (!bytes || bytes.length !== row.body_size || hash(bytes) !== row.body_sha256) {
    restricted = { state: 'archive_integrity_failed' }
  } else {
    try {
      const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      const data = object(payload) ? payload.data : undefined
      const items = object(data) ? data.business_data ?? data.results : undefined
      const cursor = object(data) ? data.cursor || data.next_cursor || data.nextCursor
        || data.pagination?.next_cursor || data.pagination?.nextCursor || null : null
      const businessCode = object(payload) && Number.isSafeInteger(payload.code) ? payload.code : null
      const continuationValid = cursor === null || (typeof cursor === 'string' && cursor.length <= 4096)
      const empty = businessCode === 0 && Array.isArray(items) && items.length === 0 && continuationValid
      restricted = { state: 'archive_verified', hashVerified: true, byteLength: bytes.length,
        businessCode, rootType: kind(payload), dataType: kind(data),
        arrayLengths: { data: Array.isArray(data) ? data.length : null,
          businessData: Array.isArray(data?.business_data) ? data.business_data.length : null,
          results: Array.isArray(data?.results) ? data.results.length : null },
        continuationValid, continuationPresent: Boolean(cursor), normalEmptyPage: empty,
        emptyTerminalPage: empty && !cursor }
    } catch { restricted = { state: 'archive_not_json', hashVerified: true } }
  }

  const payload = row.operational_payload
  let operational
  if (!row.operational_present) operational = { state: 'archive_missing' }
  else if (row.operational_body_size > MAX_OPERATIONAL_BYTES) operational = { state: 'archive_too_large' }
  else if (!object(payload) || !object(payload.request) || payload.kind !== 'provider_call_evidence'
    || payload.schemaVersion !== 1 || !boundedStructure(payload) || !SHA.test(row.payload_sha256 || '')) {
    operational = { state: 'archive_shape_unverified' }
  } else {
    const pagePresent = Object.hasOwn(payload.request, 'page')
    // Never mutate stored JSON. Only the single missing page property is restored.
    const restored = pagePresent ? null : { ...payload, request: { ...payload.request, page: null } }
    operational = { state: 'archive_checked', byteLength: row.operational_body_size,
      storedPayloadHashMatches: hash(canonicalJson(payload)) === row.payload_sha256,
      requestPagePresent: pagePresent,
      restoredMissingPageAsNullHashMatches: restored ? hash(canonicalJson(restored)) === row.payload_sha256 : null,
      restrictedBodyHashMatches: payload.response?.bodySha256 === row.body_sha256,
      restrictedBodySizeMatches: payload.response?.bodySize === row.body_size }
  }
  return { restricted, operational,
    interpretation: 'A restored-page hash match is consistent with a missing page field originally hashed as null. It does not prove why the field disappeared, reconcile the call, or authorize recovery.' }
}

export async function verifyFacebookUnknownArchive(pool, { requestId, callId, sha256 }) {
  if (!UUID.test(requestId || '') || !UUID.test(callId || '') || !SHA.test(sha256 || '')) throw new Error('invalid_arguments')
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'")
    const { rows: [row] } = await client.query(`SELECT /* facebook-unknown:verify-exact-archive */
      u.status AS request_status,c.outcome AS call_outcome,a.contract_state,a.http_status AS archive_http_status,
      r.body_size,r.body_sha256,octet_length(r.body_bytes) AS actual_body_size,
      CASE WHEN r.body_size<=4096 AND octet_length(r.body_bytes)<=4096 THEN r.body_bytes ELSE NULL END AS body_bytes,
      a.provider_call_id IS NOT NULL AS operational_present,a.payload_sha256,
      octet_length(a.raw_payload::text) AS operational_body_size,
      CASE WHEN octet_length(a.raw_payload::text)<=65536 THEN a.raw_payload ELSE NULL END AS operational_payload
      FROM public.usage_requests u JOIN external_platform.provider_calls c ON c.usage_request_id=u.id
      JOIN control.external_platform_restricted_raw_responses r ON r.provider_call_id=c.id
      LEFT JOIN external_platform.response_archives a ON a.provider_call_id=c.id
      WHERE u.id=$1::uuid AND c.id=$2::uuid AND r.body_sha256=$3
        AND u.platform='facebook' AND u.acquisition_request->>'path'='/api/v1/data/search'
        AND c.provider_key='justone' AND c.operation='native.j.facebook_post_search_v1'
        AND c.endpoint_key='native.j.facebook_post_search_v1'`, [requestId, callId, sha256])
    if (!row) throw new Error('bound_archive_not_found')
    return { diagnosticRevision: 'facebook-unknown-archive.v1', requestId, callId, restrictedSha256: sha256,
      currentStateOnly: true, requestStatus: choice(row.request_status, ['reserved', 'committed', 'released', 'unknown']),
      callOutcome: choice(row.call_outcome, ['pending', 'succeeded', 'succeeded_unusable', 'rejected', 'unknown']),
      archiveContractState: choice(row.contract_state, ['accepted', 'rejected', 'unknown', 'succeeded_unusable', 'not_dispatched']),
      archiveHttpStatus: Number.isInteger(row.archive_http_status) && row.archive_http_status >= 100
        && row.archive_http_status <= 599 ? row.archive_http_status : null,
      ...projectFacebookUnknownArchive(row) }
  } catch (error) { throw safeFailure(error) }
  finally {
    if (client) {
      let error
      try { await client.query('ROLLBACK') } catch (cause) { error = cause }
      client.release(error)
      if (error) throw new Error('archive_verification_failed')
    }
  }
}

if (process.argv[1] === '-' || (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  let pool
  try {
    const [requestId, callId, sha256, extra] = process.argv.slice(2)
    if (extra || !UUID.test(requestId || '') || !UUID.test(callId || '') || !SHA.test(sha256 || '')) throw new Error('invalid_arguments')
    if (!process.env.DATABASE_URL) throw new Error('database_url_required')
    const { default: pg } = await import('pg')
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, query_timeout: 6000 })
    console.log(JSON.stringify(await verifyFacebookUnknownArchive(pool, { requestId, callId, sha256 }), null, 2))
  } catch (error) {
    console.error(JSON.stringify({ error: safeFailure(error).message }))
    process.exitCode = 1
  } finally { await pool?.end() }
}
