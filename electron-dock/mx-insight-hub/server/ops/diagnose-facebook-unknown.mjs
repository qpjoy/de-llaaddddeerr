import { pathToFileURL } from 'node:url'

// Standalone stdin diagnostic. No gateway, replay, supplier call or recovery.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SHA = /^[0-9a-f]{64}$/u
const LIMIT = 20
const PATH = '/api/v1/data/search'
const STATUSES = ['reserved', 'committed', 'released', 'unknown']
const OUTCOMES = ['pending', 'succeeded', 'succeeded_unusable', 'rejected', 'unknown']
const OPERATIONS = ['social.facebook.search', 'native.j.facebook_post_search_v1']
const ERRORS = ['external_platform_pre_dispatch_failed', 'external_platform_persistence_unknown',
  'external_platform_call_persistence_unknown', 'reservation_lease_expired', 'request_outcome_unknown',
  'request_in_progress', 'social_upstream_outcome_unknown', 'social_upstream_response_unusable',
  'social_upstream_timeout_or_size_limit', 'social_upstream_rejected', 'social_egress_unavailable',
  'upstream_transport_error', 'upstream_deadline_exceeded', 'upstream_collection_failed',
  'upstream_rate_limited', 'invalid_facebook_response', 'upstream_http_error', 'facebook_quota_state_unavailable']
const FAILURES = ['invalid_arguments', 'invalid_request_id', 'database_url_required', 'request_not_found', 'request_not_facebook_standard_search']
const uuid = value => typeof value === 'string' && UUID.test(value) ? value : null
const sha = value => typeof value === 'string' && SHA.test(value) ? value : null
const choice = (value, values) => value == null ? null : values.includes(value) ? value : 'other'
const bool = value => typeof value === 'boolean' ? value : null
const count = value => /^(0|[1-9]\d*)$/u.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : null
const http = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null
const time = value => {
  if (!(value instanceof Date) && !(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?$/u.test(value))) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
const failure = error => new Error(FAILURES.includes(error?.message) ? error.message : 'diagnostic_read_failed')
const usage = row => ({ requestId: uuid(row.id), status: choice(row.status, STATUSES), savedHttpStatus: http(row.response_status),
  savedResponsePresent: bool(row.saved_response_present), errorCode: choice(row.error_code, ERRORS),
  reservedAt: time(row.reserved_at), completedAt: time(row.completed_at), leaseExpiresAt: time(row.lease_expires_at),
  currentlyMatchesUnknownGuard: bool(row.current_guard_match) })
const call = row => ({ callId: uuid(row.id), provider: choice(row.provider_key, ['rapidapi', 'justone']),
  operation: choice(row.operation, OPERATIONS), outcome: choice(row.outcome, OUTCOMES),
  httpStatus: http(row.http_status), errorCode: choice(row.error_code, ERRORS),
  startedAt: time(row.started_at), completedAt: time(row.completed_at),
  operationalArchive: { present: bool(row.operational_archive_present), bodySize: count(row.archive_body_size),
    sha256: sha(row.archive_sha256), capturedAt: time(row.archive_captured_at),
    contractState: choice(row.archive_contract_state, ['accepted', 'rejected', 'unknown', 'succeeded_unusable', 'not_dispatched']),
    httpStatus: http(row.archive_http_status) },
  restrictedArchive: { present: bool(row.restricted_archive_present), bodySize: count(row.restricted_body_size),
    sha256: sha(row.restricted_sha256), capturedAt: time(row.restricted_captured_at), jsonParsed: bool(row.json_parsed) } })

export async function diagnoseFacebookUnknown(pool, requestId) {
  if (!uuid(requestId)) throw new Error('invalid_request_id')
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'")
    const { rows: [target] } = await client.query(`SELECT /* facebook-unknown:target */
      id, platform, status, response_status, error_code, reserved_at, completed_at, lease_expires_at,
      response_body IS NOT NULL AS saved_response_present, acquisition_request->>'path' AS request_path,
      status='unknown' AND reserved_at>=now()-INTERVAL '24 hours' AS current_guard_match,
      reserved_at-INTERVAL '24 hours' AS window_start,
      COALESCE(completed_at,reserved_at+INTERVAL '10 minutes') AS window_end, now() AS database_now
      FROM public.usage_requests WHERE id=$1::uuid`, [requestId])
    if (!target) throw new Error('request_not_found')
    if (target.platform !== 'facebook' || target.request_path !== PATH) throw new Error('request_not_facebook_standard_search')
    const { rows: candidates } = await client.query(`WITH target AS ( /* facebook-unknown:candidates */
      SELECT tenant_id,consumer_id,api_key_id,fingerprint,reserved_at,completed_at
      FROM public.usage_requests WHERE id=$1::uuid
    ) SELECT r.id,r.status,r.response_status,r.error_code,r.reserved_at,r.completed_at,r.lease_expires_at,
      r.response_body IS NOT NULL AS saved_response_present,
      r.reserved_at>=now()-INTERVAL '24 hours' AS current_guard_match, count(*) OVER () AS total_count
      FROM public.usage_requests r CROSS JOIN target t
      WHERE r.tenant_id=t.tenant_id AND r.consumer_id=t.consumer_id AND r.api_key_id=t.api_key_id
        AND r.fingerprint=t.fingerprint AND r.platform='facebook' AND r.status='unknown'
        AND r.acquisition_request->>'path'='/api/v1/data/search'
        AND r.reserved_at BETWEEN t.reserved_at-INTERVAL '24 hours'
          AND COALESCE(t.completed_at,t.reserved_at+INTERVAL '10 minutes')
      ORDER BY r.reserved_at DESC,r.id LIMIT 21`, [requestId])
    const selected = candidates.slice(0, LIMIT)
    const requestIds = [...new Set([target.id, ...selected.map(row => row.id)])]
    const { rows: calls } = await client.query(`WITH ranked AS ( /* facebook-unknown:calls */
      SELECT id,usage_request_id,provider_key,operation,outcome,http_status,error_code,started_at,completed_at,
        count(*) OVER (PARTITION BY usage_request_id) AS total_count,
        row_number() OVER (PARTITION BY usage_request_id ORDER BY started_at,id) AS position
      FROM external_platform.provider_calls WHERE usage_request_id=ANY($1::uuid[])
    ) SELECT c.*,a.id IS NOT NULL AS operational_archive_present,a.body_size AS archive_body_size,
      a.payload_sha256 AS archive_sha256,a.captured_at AS archive_captured_at,
      a.contract_state AS archive_contract_state,a.http_status AS archive_http_status,
      r.id IS NOT NULL AS restricted_archive_present,r.body_size AS restricted_body_size,
      r.body_sha256 AS restricted_sha256,r.captured_at AS restricted_captured_at,r.json_parsed
      FROM ranked c LEFT JOIN external_platform.response_archives a ON a.provider_call_id=c.id
      LEFT JOIN control.external_platform_restricted_raw_responses r ON r.provider_call_id=c.id
      WHERE c.position<=21 ORDER BY c.usage_request_id,c.position`, [requestIds])
    const { rows: leases } = await client.query(`WITH target AS ( /* facebook-unknown:leases */
      SELECT consumer_id,fingerprint FROM public.usage_requests WHERE id=$1::uuid
    ) SELECT l.operation,l.owner_request_id,l.created_at,l.expires_at,l.expires_at>now() AS active,
      owner.status AS owner_status,count(*) OVER () AS total_count
      FROM external_platform.dispatch_leases l CROSS JOIN target t
      LEFT JOIN public.usage_requests owner ON owner.id=l.owner_request_id
      WHERE l.consumer_id=t.consumer_id AND l.request_fingerprint=t.fingerprint
        AND l.operation IN ('social.facebook.search','native.j.facebook_post_search_v1')
      ORDER BY l.created_at,l.operation LIMIT 21`, [requestId])
    const withCalls = row => {
      const own = calls.filter(entry => entry.usage_request_id === row.id)
      return { ...usage(row), ownProviderCallCount: own.length ? count(own[0].total_count) : 0,
        ownProviderCalls: own.slice(0, LIMIT).map(call), ownProviderCallsTruncated: own.length > LIMIT }
    }
    return { diagnosticRevision: 'facebook-unknown.v1', requestId, currentStateOnly: true,
      historicalUnknownStateRecorded: false, databaseNow: time(target.database_now), target: withCalls(target),
      candidateWindow: { startAt: time(target.window_start), endAt: time(target.window_end),
        endSource: target.completed_at == null ? 'reserved_at_plus_10_minutes' : 'completed_at' },
      unknownCandidateCount: candidates.length ? count(candidates[0].total_count) : 0,
      unknownCandidates: selected.map(row => ({ ...withCalls(row), isTarget: row.id === target.id })),
      unknownCandidatesTruncated: candidates.length > LIMIT,
      currentLeaseCount: leases.length ? count(leases[0].total_count) : 0,
      currentLeases: leases.slice(0, LIMIT).map(row => ({ operation: choice(row.operation, OPERATIONS),
        ownerRequestId: uuid(row.owner_request_id), ownerStatus: choice(row.owner_status, STATUSES),
        createdAt: time(row.created_at), expiresAt: time(row.expires_at), active: bool(row.active) })),
      currentLeasesTruncated: leases.length > LIMIT, rowLimit: LIMIT,
      archiveEvidence: 'Metadata only; original bytes, integrity, completeness and recoverability are not verified.',
      interpretation: 'Candidates have unknown status now within the target-time window; their status at the failed admission was not recorded. An empty list does not exclude a historical unknown, a changed status or a different retained window. Current leases do not identify a historical blocker. No dispatch, replay, recovery or settlement change.' }
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
    console.log(JSON.stringify(await diagnoseFacebookUnknown(pool, requestId), null, 2))
  } catch (error) {
    console.error(JSON.stringify({ error: failure(error).message }))
    process.exitCode = 1
  } finally { await pool?.end() }
}
