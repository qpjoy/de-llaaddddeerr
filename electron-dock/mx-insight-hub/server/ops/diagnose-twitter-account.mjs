// Read retained evidence only. Runs over stdin inside the existing Admin Pod.
// No gateway imports, supplier calls, retries, credentials or account text.
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const MAX_BYTES = 8 * 1024 * 1024
const choice = (value, choices) => value == null ? null : choices.includes(value) ? value : 'other'
const ERRORS = ['social_upstream_response_unusable', 'social_upstream_timeout_or_size_limit',
  'invalid_social_contract', 'social_account_not_found', 'social_account_unavailable', 'social_upstream_rejected',
  'external_platform_response_unusable', 'external_platform_pre_dispatch_failed']
const kind = value => value === undefined ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
const FIELDS = ['data', 'userExists', 'errors', 'error', 'users', 'user', 'result', 'user_result_by_screen_name',
  'entries', 'instructions', 'timeline', 'search_by_raw_query', 'search_timeline', 'legacy', 'core',
  'rest_id', 'id_str', 'screen_name', '__typename']
const shape = value => ({ kind: kind(value), ...(Array.isArray(value) ? { length: value.length } : {}),
  ...(kind(value) === 'object' ? { fields: Object.fromEntries(FIELDS.filter(key => Object.hasOwn(value, key))
    .map(key => [key, kind(value[key])])), otherFieldCount: Object.keys(value).filter(key => !FIELDS.includes(key)).length } : {}) })

export function inspectTwitterAccountArchive(row) {
  if (!row) return { state: 'missing' }
  if (row.body_size > MAX_BYTES) return { state: 'too_large' }
  const bytes = row.body_bytes instanceof Uint8Array ? Buffer.from(row.body_bytes) : null
  if (!bytes || bytes.length !== row.body_size || createHash('sha256').update(bytes).digest('hex') !== row.body_sha256?.trim()) {
    return { state: 'integrity_failed' }
  }
  let payload
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '')) }
  catch { return { state: 'invalid_utf8_or_json', bytes: bytes.length } }
  const root = kind(payload?.data) === 'object' ? payload.data : payload
  const candidates = root?.users || [root?.user?.result || root?.user_result_by_screen_name?.result || root?.result]
  return { state: 'verified_json', bytes: bytes.length, top: shape(payload), root: shape(root),
    userExists: typeof payload?.userExists === 'boolean' ? payload.userExists : null,
    explicitNotFoundEnvelope: payload?.userExists === false && kind(payload.data) === 'object'
      && Object.keys(payload.data).length === 0 && payload.error == null
      && (payload.errors == null || Array.isArray(payload.errors) && payload.errors.length === 0),
    businessErrorCount: (Array.isArray(payload?.errors) ? payload.errors.length : 0)
      + (root !== payload && Array.isArray(root?.errors) ? root.errors.length : 0),
    profileCandidates: Array.isArray(candidates) ? candidates.slice(0, 3).map(candidate => {
      const user = candidate?.result || candidate
      return { shape: shape(user), legacy: shape(user?.legacy), core: shape(user?.core),
        unavailable: user?.__typename === 'UserUnavailable',
        unavailableReason: user?.__typename === 'UserUnavailable'
          ? choice(typeof user.reason === 'string' ? user.reason.toLowerCase() : null,
            ['suspended', 'deactivated', 'deleted', 'protected', 'notfound', 'not_found', 'unavailable']) : null }
    }) : { kind: kind(candidates) },
    parserReplayed: false }
}

export async function diagnoseTwitterAccount(pool, requestId) {
  if (!UUID.test(requestId)) throw new Error('invalid_request_id')
  const client = await pool.connect()
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'")
    const { rows: [request] } = await client.query(`SELECT id, platform, status, response_status, error_code,
      reserved_at, completed_at, acquisition_request->>'path' AS path
      FROM public.usage_requests WHERE id=$1::uuid`, [requestId])
    const base = { revision: 'twitter-account-diagnostic.v2', requestId, found: Boolean(request) }
    if (!request) return base
    if (request.platform !== 'twitter') throw new Error('request_not_twitter')
    const { rows: calls } = await client.query(`SELECT c.id, c.provider_key, c.operation, c.endpoint_key,
      c.outcome, c.http_status, c.business_code, c.billed, c.error_code, c.item_count, c.started_at, c.completed_at,
      r.id IS NOT NULL AS archive_present, r.body_size, r.json_parsed
      FROM external_platform.provider_calls c
      LEFT JOIN control.external_platform_restricted_raw_responses r ON r.provider_call_id=c.id
      WHERE c.usage_request_id=$1::uuid ORDER BY c.started_at,c.id LIMIT 51`, [requestId])
    let inspected = 0
    const ownCalls = []
    for (const call of calls.slice(0, 50)) {
      let archive = { state: call.archive_present ? 'not_inspected' : 'missing' }
      if ((call.outcome === 'succeeded_unusable' || ['social_account_not_found', 'social_account_unavailable'].includes(call.error_code)) && call.archive_present && inspected < 3) {
        inspected++
        const { rows: [raw] } = await client.query(`SELECT body_size, body_sha256,
          CASE WHEN body_size <= $2 THEN body_bytes END AS body_bytes
          FROM control.external_platform_restricted_raw_responses WHERE provider_call_id=$1::uuid`, [call.id, MAX_BYTES])
        archive = inspectTwitterAccountArchive(raw)
      }
      ownCalls.push({ callId: call.id, provider: choice(call.provider_key, ['rapidapi', 'tikhub', 'justone']),
        operation: choice(call.operation, ['social.profile.get', 'social.content.crawl']),
        endpoint: choice(call.endpoint_key, ['twitter-aio.user-info', 'twitter-aio.crawl']),
        outcome: choice(call.outcome, ['pending', 'succeeded', 'succeeded_unusable', 'rejected', 'unknown']),
        httpStatus: call.http_status, businessCode: Number.isSafeInteger(call.business_code) ? call.business_code : null,
        billed: call.billed, errorCode: choice(call.error_code, ERRORS), itemCount: call.item_count,
        startedAt: call.started_at, completedAt: call.completed_at, archive })
    }
    return { ...base, status: choice(request.status, ['reserved', 'committed', 'released', 'unknown']),
      path: choice(request.path, ['/api/v1/data/social/crawl', '/api/v1/data/social/user-info']),
      httpStatus: request.response_status, errorCode: choice(request.error_code, ERRORS),
      reservedAt: request.reserved_at, completedAt: request.completed_at, ownCalls, truncated: calls.length > 50,
      archivesInspected: inspected, archiveInspectionLimit: 3,
      interpretation: 'Saved evidence only; shape does not prove account validity or parser correctness. No paid replay. Null billed is unknown.' }
  } finally {
    let rollbackError
    try { await client.query('ROLLBACK') } catch (error) { rollbackError = error }
    client.release(rollbackError)
    if (rollbackError) throw new Error('diagnostic_rollback_failed')
  }
}

if (process.argv[1] === '-' || process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let pool
  try {
    const [requestId, extra] = process.argv.slice(2)
    if (!requestId || !UUID.test(requestId) || extra) throw new Error('invalid_arguments')
    if (!process.env.DATABASE_URL) throw new Error('database_url_required')
    const { default: pg } = await import('pg')
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, query_timeout: 6000 })
    console.log(JSON.stringify(await diagnoseTwitterAccount(pool, requestId), null, 2))
  } catch (error) {
    console.error(JSON.stringify({ error: choice(error.message, ['invalid_arguments', 'database_url_required',
      'request_not_twitter', 'diagnostic_rollback_failed']) === 'other' ? 'diagnostic_read_failed' : error.message }))
    process.exitCode = 1
  } finally { await pool?.end() }
}
