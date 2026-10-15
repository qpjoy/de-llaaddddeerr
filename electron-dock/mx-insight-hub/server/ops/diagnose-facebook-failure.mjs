import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

// Standalone read-only incident inspection. No adapter/app imports or replay.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const MAX_BYTES = 65536
const id = value => typeof value === 'string' && UUID.test(value) ? value : null
const upstreamId = value => id(value) || (typeof value === 'string' && /^[a-f0-9]{32}$/iu.test(value) ? value : null)
const choice = (value, allowed) => value == null ? null : allowed.includes(value) ? value : 'other'
const int = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const time = value => {
  if (!(value instanceof Date) && typeof value !== 'string') return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
const kind = value => value === undefined ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
const object = value => kind(value) === 'object'
const REVIEWED = new Set(['采集失败', '数据采集失败', '请求失败', '请求超时', '采集超时', '参数错误', '余额不足', 'success'])
const message = value => ({ type: kind(value), length: typeof value === 'string' ? value.length : null,
  reviewedText: REVIEWED.has(value) ? value : null, unreviewedText: typeof value === 'string' && !REVIEWED.has(value) })

export function inspectFacebookFailureArchive(archive) {
  if (!archive) return { state: 'archive_missing' }
  if (archive.body_size > MAX_BYTES) return { state: 'archive_too_large' }
  const bytes = archive.body_bytes instanceof Uint8Array ? Buffer.from(archive.body_bytes) : null
  if (!bytes || bytes.length > MAX_BYTES || bytes.length !== archive.body_size
    || createHash('sha256').update(bytes).digest('hex') !== archive.body_sha256) return { state: 'archive_integrity_failed' }
  let payload
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { return { state: 'archive_not_json', hashVerified: true } }
  if (!object(payload)) return { state: 'archive_not_object', hashVerified: true }
  const error = object(payload.error) ? payload.error : null
  return { state: 'archive_verified', hashVerified: true, byteLength: bytes.length, sha256: archive.body_sha256,
    businessCode: int(payload.code), upstreamRequestId: upstreamId(payload.requestId ?? payload.request_id),
    message: message(payload.message), msg: message(payload.msg), errorType: kind(payload.error),
    errorMessage: message(error?.message), dataType: kind(payload.data),
    // Unknown text can contain echoed tokens/queries. Never print it or raw JSON.
    textScope: 'root message/msg and error.message only; unknown text withheld; no recursive content inspection' }
}

const quota = value => ({ remaining: int(value?.remaining), limit: int(value?.limit), resetSeconds: int(value?.resetSeconds),
  source: choice(value?.billingHeaderSource, ['x-ratelimit-requests', 'x-rapidapi-requests']),
  conflict: typeof value?.quotaConflict === 'boolean' ? value.quotaConflict : null,
  monthlyExhausted: typeof value?.monthlyExhausted === 'boolean' ? value.monthlyExhausted : null })
const projectCall = row => ({ callId: id(row.id), requestId: id(row.usage_request_id),
  provider: choice(row.provider_key, ['rapidapi', 'justone']),
  outcome: choice(row.outcome, ['pending', 'succeeded', 'succeeded_unusable', 'rejected', 'unknown']),
  httpStatus: int(row.http_status) >= 100 && int(row.http_status) <= 599 ? row.http_status : null,
  businessCode: int(row.business_code),
  errorCode: choice(row.error_code, ['upstream_collection_failed', 'upstream_rate_limited', 'upstream_balance_exhausted',
    'upstream_daily_quota_exceeded', 'upstream_token_limit_exceeded', 'invalid_facebook_response', 'upstream_http_error']),
  upstreamRequestId: upstreamId(row.upstream_request_id), billed: typeof row.billed === 'boolean' ? row.billed : null,
  startedAt: time(row.started_at), completedAt: time(row.completed_at) })

export async function diagnoseFacebookFailure(pool, requestId) {
  if (!id(requestId)) throw new Error('invalid_request_id')
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '3s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'")
    const { rows: [request] } = await client.query(`SELECT id,platform,status,error_code,response_status,
      reserved_at,completed_at,clock_timestamp() AS database_now
      FROM public.usage_requests WHERE id=$1`, [requestId])
    if (!request) throw new Error('request_not_found')
    if (request.platform !== 'facebook') throw new Error('request_is_not_facebook')
    const { rows: calls } = await client.query(`SELECT id,usage_request_id,provider_key,operation,endpoint_key,
      outcome,http_status,business_code,error_code,upstream_request_id,billed,started_at,completed_at
      FROM external_platform.provider_calls WHERE usage_request_id=$1 AND (
        (provider_key='justone' AND operation='native.j.facebook_post_search_v1' AND endpoint_key='native.j.facebook_post_search_v1')
        OR (provider_key='rapidapi' AND operation='social.facebook.search' AND endpoint_key='facebook-scraper3.search'))
      ORDER BY started_at,id LIMIT 11`, [requestId])
    const ownCalls = []
    for (const call of calls.slice(0, 10)) {
      let archive = null
      if (call.provider_key === 'justone' && call.outcome === 'rejected') {
        const { rows: [saved] } = await client.query(`SELECT body_size,body_sha256,
          CASE WHEN body_size<=65536 AND octet_length(body_bytes)<=65536 THEN body_bytes ELSE NULL END AS body_bytes
          FROM control.external_platform_restricted_raw_responses WHERE provider_call_id=$1`, [call.id])
        archive = inspectFacebookFailureArchive(saved)
      }
      ownCalls.push({ ...projectCall(call), archive })
    }
    const { rows: [policy] } = await client.query(`SELECT revision,created_at,policy->>'mode' AS mode,
      policy->>'monthly_limit' AS monthly_limit
      FROM control.platform_search_policy_events WHERE platform='facebook' AND created_at<=$1
      ORDER BY created_at DESC,revision DESC LIMIT 1`, [request.reserved_at])
    const { rows: recent } = await client.query(`WITH recent AS (
      SELECT c.id,c.usage_request_id,c.provider_key,c.outcome,c.http_status,c.business_code,c.error_code,
        c.upstream_request_id,c.billed,c.started_at,c.completed_at,
        c.started_at<=$1 AND (c.completed_at IS NULL OR c.completed_at>$1) AS in_flight_at_reservation,
        c.completed_at<=$1 AS completed_before_reservation
      FROM external_platform.provider_calls c WHERE c.provider_key='rapidapi'
        AND c.operation='social.facebook.search' AND c.endpoint_key='facebook-scraper3.search'
        AND c.started_at>=$1::timestamptz-interval '7 days' AND c.started_at<=$1
      ORDER BY c.started_at DESC,c.id LIMIT 16
    ) SELECT recent.*,a.raw_payload->'response'->'quota' AS quota
      FROM recent LEFT JOIN external_platform.response_archives a ON a.provider_call_id=recent.id
      ORDER BY recent.started_at DESC,recent.id`, [request.reserved_at])
    return { diagnosticRevision: 'facebook-failure.v1', requestId,
      status: choice(request.status, ['reserved', 'committed', 'released', 'unknown']),
      responseStatus: int(request.response_status),
      errorCode: choice(request.error_code, ['upstream_collection_failed', 'external_platform_pre_dispatch_failed',
        'facebook_quota_state_unavailable', 'external_platform_busy']),
      reservedAt: time(request.reserved_at), completedAt: time(request.completed_at), databaseNow: time(request.database_now),
      ownCalls, ownCallsTruncated: calls.length > 10,
      lastPolicyAuditBeforeRequest: policy ? { revision: int(policy.revision), createdAt: time(policy.created_at),
        mode: choice(policy.mode, ['auto', 'rapidapi', 'justone', 'paused']),
        monthlyLimit: /^\d{1,7}$/u.test(policy.monthly_limit || '') ? int(Number(policy.monthly_limit)) : null } : null,
      precedingRapidCalls: recent.slice(0, 15).map(row => ({ ...projectCall(row),
        inFlightAtReservation: row.in_flight_at_reservation === true,
        completedBeforeReservation: row.completed_before_reservation === true, billingHeaders: quota(row.quota) })),
      precedingRapidCallsTruncated: recent.length > 15,
      scope: 'preceding 7 days; latest 15 Facebook RapidAPI calls that started before reservation; current quota is not a historical snapshot',
      routingEvidence: 'audit and candidate calls only; original admission reason and quota snapshot are not present in these tables' }
  } catch (error) {
    throw new Error(['request_not_found', 'request_is_not_facebook'].includes(error.message) ? error.message : 'diagnostic_read_failed')
  } finally {
    if (client) {
      let error
      try { await client.query('ROLLBACK') } catch (cause) { error = cause }
      client.release(error)
      if (error) throw new Error('diagnostic_read_failed')
    }
  }
}

if (process.argv[1] === '-' || (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  let pool
  try {
    const [requestId, extra] = process.argv.slice(2)
    if (!requestId || extra) throw new Error('invalid_arguments')
    if (!id(requestId)) throw new Error('invalid_request_id')
    if (!process.env.DATABASE_URL) throw new Error('database_url_required')
    const { default: pg } = await import('pg')
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, query_timeout: 4000 })
    console.log(JSON.stringify(await diagnoseFacebookFailure(pool, requestId), null, 2))
  } catch (error) {
    const known = ['invalid_arguments', 'invalid_request_id', 'database_url_required', 'request_not_found', 'request_is_not_facebook']
    console.error(JSON.stringify({ error: known.includes(error.message) ? error.message : 'diagnostic_read_failed' }))
    process.exitCode = 1
  } finally { await pool?.end() }
}
