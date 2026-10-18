import { pathToFileURL } from 'node:url'

// Standalone stdin diagnostic: reads retained ledgers only, never runs a gateway.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const LIMIT = 20
const PLATFORMS = new Set(['twitter', 'facebook', 'instagram', 'bilibili', 'douyin', 'kuaishou', 'weibo', 'xiaohongshu', 'youtube', 'zhihu', 'tiktok', 'linkedin', 'reddit'])
const PATHS = new Set(['/api/v1/data/social/crawl', '/api/v1/data/social/user-info'])
const STATUSES = new Set(['reserved', 'committed', 'released', 'unknown'])
const OUTCOMES = new Set(['pending', 'succeeded', 'succeeded_unusable', 'rejected', 'unknown'])
const OPERATIONS = new Set(['social.content.crawl', 'social.profile.get', ...[...PLATFORMS].map(platform => `social.search.${platform}`)])
const ERRORS = new Set(['external_platform_pre_dispatch_failed', 'external_platform_persistence_unknown',
  'external_platform_call_persistence_unknown', 'reservation_lease_expired', 'request_in_progress',
  'request_outcome_unknown', 'social_upstream_outcome_unknown', 'social_upstream_response_unusable', 'social_upstream_rejected'])
const FAILURES = new Set(['invalid_arguments', 'invalid_request_id', 'database_url_required'])
const uuid = value => typeof value === 'string' && UUID.test(value) ? value : null
const allowed = (value, choices) => value == null ? null : choices.has(value) ? value : 'other'
const bool = value => typeof value === 'boolean' ? value : null
const count = value => /^(0|[1-9]\d*)$/u.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : null
const http = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null
const time = value => {
  if (!(value instanceof Date) && !(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?$/u.test(value))) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
const failure = error => new Error(FAILURES.has(error?.message) ? error.message : 'diagnostic_read_failed')
const usageProjection = row => ({ requestId: uuid(row.id), status: allowed(row.status, STATUSES),
  savedHttpStatus: http(row.response_status), errorCode: allowed(row.error_code, ERRORS),
  requestPath: allowed(row.request_path, PATHS), reservedAt: time(row.reserved_at), completedAt: time(row.completed_at),
  leaseExpiresAt: time(row.lease_expires_at) })

export async function diagnoseSocialAccountConflict(pool, requestId) {
  if (!uuid(requestId)) throw new Error('invalid_request_id')
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'")
    const { rows: [target] } = await client.query(`SELECT /* social-account-conflict:target */
      id, platform, status, response_status, error_code, reserved_at, completed_at, lease_expires_at,
      acquisition_request->>'path' AS request_path, now() AS database_now
      FROM public.usage_requests WHERE id = $1::uuid`, [requestId])
    const base = { requestId, found: Boolean(target), currentStateOnly: true, siblingWindowMinutes: 10,
      historicalLeaseOwnerRecorded: false,
      leaseEvidence: 'Current leases and nearby requests do not identify the historical conflicting owner.' }
    // The input may instead be an HTTP transport ID; absence is not an identity mapping.
    if (!target) return base
    const { rows: ownCalls } = await client.query(`SELECT /* social-account-conflict:own-calls */
      id, usage_request_id, operation, outcome, http_status, error_code, started_at, completed_at,
      count(*) OVER () AS total_count
      FROM external_platform.provider_calls WHERE usage_request_id = $1::uuid
      ORDER BY started_at, id LIMIT 21`, [requestId])
    const { rows: siblings } = await client.query(`WITH target AS ( /* social-account-conflict:siblings */
      SELECT id, consumer_id, fingerprint, platform, acquisition_request->>'path' AS request_path,
        api_key_id, idempotency_key, reserved_at FROM public.usage_requests WHERE id = $1::uuid
    )
    SELECT r.id, r.status, r.response_status, r.error_code, r.reserved_at, r.completed_at, r.lease_expires_at,
      r.acquisition_request->>'path' AS request_path,
      r.api_key_id = t.api_key_id AS same_api_key, r.idempotency_key = t.idempotency_key AS same_idempotency,
      (SELECT count(*) FROM external_platform.provider_calls p WHERE p.usage_request_id = r.id) AS provider_call_count,
      count(*) OVER () AS total_count
    FROM public.usage_requests r CROSS JOIN target t
    WHERE r.id <> t.id AND r.consumer_id = t.consumer_id AND r.fingerprint = t.fingerprint
      AND r.platform = t.platform AND r.acquisition_request->>'path' = t.request_path
      AND r.reserved_at BETWEEN t.reserved_at - INTERVAL '10 minutes' AND t.reserved_at + INTERVAL '10 minutes'
    ORDER BY r.reserved_at, r.id LIMIT 21`, [requestId])
    const { rows: leases } = await client.query(`WITH target AS ( /* social-account-conflict:leases */
      SELECT consumer_id, fingerprint FROM public.usage_requests WHERE id = $1::uuid
    )
    SELECT l.operation, l.owner_request_id, l.created_at, l.expires_at, l.expires_at > now() AS active,
      owner.status AS owner_status, owner.response_status AS owner_response_status,
      owner.reserved_at AS owner_reserved_at, owner.completed_at AS owner_completed_at,
      count(*) OVER () AS total_count
    FROM external_platform.dispatch_leases l CROSS JOIN target t
    LEFT JOIN public.usage_requests owner ON owner.id = l.owner_request_id
    WHERE l.consumer_id = t.consumer_id AND l.request_fingerprint = t.fingerprint
    ORDER BY l.created_at, l.operation LIMIT 21`, [requestId])
    return { ...base, databaseNow: time(target.database_now), target: { ...usageProjection(target), platform: allowed(target.platform, PLATFORMS) },
      ownProviderCallCount: ownCalls.length ? count(ownCalls[0].total_count) : 0,
      ownProviderCalls: ownCalls.slice(0, LIMIT).map(row => ({ callId: uuid(row.id), requestId: uuid(row.usage_request_id),
        operation: allowed(row.operation, OPERATIONS), outcome: allowed(row.outcome, OUTCOMES),
        httpStatus: http(row.http_status), errorCode: allowed(row.error_code, ERRORS), startedAt: time(row.started_at), completedAt: time(row.completed_at) })),
      siblingCount: siblings.length ? count(siblings[0].total_count) : 0,
      siblingCandidates: siblings.slice(0, LIMIT).map(row => ({ ...usageProjection(row), sameApiKey: bool(row.same_api_key),
        sameIdempotency: bool(row.same_idempotency), providerCallCount: count(row.provider_call_count) })),
      currentLeaseCount: leases.length ? count(leases[0].total_count) : 0,
      currentLeases: leases.slice(0, LIMIT).map(row => ({ operation: allowed(row.operation, OPERATIONS), ownerRequestId: uuid(row.owner_request_id),
        createdAt: time(row.created_at), expiresAt: time(row.expires_at), active: bool(row.active),
        ownerStatus: allowed(row.owner_status, STATUSES), ownerSavedHttpStatus: http(row.owner_response_status),
        ownerReservedAt: time(row.owner_reserved_at), ownerCompletedAt: time(row.owner_completed_at) })),
      rowLimit: LIMIT, ownProviderCallsTruncated: ownCalls.length > LIMIT,
      siblingCandidatesTruncated: siblings.length > LIMIT, currentLeasesTruncated: leases.length > LIMIT }
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
    console.log(JSON.stringify(await diagnoseSocialAccountConflict(pool, requestId), null, 2))
  } catch (error) {
    console.error(JSON.stringify({ error: failure(error).message }))
    process.exitCode = 1
  } finally { await pool?.end() }
}
