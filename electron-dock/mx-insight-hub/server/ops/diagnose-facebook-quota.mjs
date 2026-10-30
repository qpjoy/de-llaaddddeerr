import { pathToFileURL } from 'node:url'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const int = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const bool = value => typeof value === 'boolean' ? value : null
const id = value => typeof value === 'string' && UUID.test(value) ? value : null
const choice = (value, choices) => value == null ? null : choices.includes(value) ? value : 'other'
const time = value => {
  if (!(value instanceof Date) && !(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?$/u.test(value))) return null
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null
}

// Compatible with both pre-151 and post-151 databases. Reads only quota state
// and fixed operational billing evidence, never raw/restricted business data.
export async function diagnoseFacebookQuota(pool) {
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '3s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'")
    const { rows: [state] } = await client.query(`SELECT p.mode,p.monthly_limit,p.probe_interval_hours,
      p.billing_cycle_day,p.billing_probe_interval_hours,s.used,s.remaining,s.reset_at,s.blocked_until,
      s.reason,s.lease_until,s.updated_at,to_jsonb(s)->>'supplier_remaining' AS supplier_remaining,
      to_jsonb(s)->>'supplier_limit' AS supplier_limit,to_jsonb(s)->>'supplier_observed_at' AS supplier_observed_at,
      to_jsonb(s)->>'manual_check_until' AS manual_check_until,
      to_jsonb(s) ? 'supplier_remaining' AS supplier_quota_supported,clock_timestamp() AS database_now,
      to_jsonb(s)->'waiters' IS NOT NULL AS queue_supported,
      coalesce(jsonb_array_length(to_jsonb(s)->'waiters'),0) AS queue_depth
      FROM control.platform_search_policies p CROSS JOIN control.facebook_rapid_quota s
      WHERE p.platform='facebook' AND s.singleton`)
    const { rows } = await client.query(`WITH recent AS (
      SELECT id,usage_request_id,outcome,http_status,cost_kind,started_at,completed_at
      FROM external_platform.provider_calls
      WHERE provider_key='rapidapi' AND operation='social.facebook.search'
        AND endpoint_key='facebook-scraper3.search' AND started_at>=now()-interval '7 days'
      ORDER BY started_at DESC,id LIMIT 31
    ) SELECT recent.*,a.raw_payload->'response'->'quota' AS quota
      FROM recent LEFT JOIN external_platform.response_archives a ON a.provider_call_id=recent.id
      ORDER BY recent.started_at DESC,recent.id`)
    return { diagnosticRevision: 'facebook-quota.v2', state: state ? {
      mode: choice(state.mode, ['auto', 'rapidapi', 'justone', 'paused']), monthlyLimit: int(state.monthly_limit),
      usedReserved: int(state.used), remaining: int(state.remaining),
      availableIncluded: int(state.remaining), supplierQuotaSupported: bool(state.supplier_quota_supported),
      supplierRemaining: state.supplier_remaining == null ? null : int(Number(state.supplier_remaining)),
      supplierLimit: state.supplier_limit == null ? null : int(Number(state.supplier_limit)),
      supplierObservedAt: time(state.supplier_observed_at), manualCheckUntil: time(state.manual_check_until),
      legacyMonthlySettingsEnforced: state.supplier_quota_supported ? false : null,
      resetAt: time(state.reset_at), blockedUntil: time(state.blocked_until), leaseUntil: time(state.lease_until),
      reason: choice(state.reason, ['quota_exhausted', 'quota_unknown', 'recovery_probe', 'rate_limited']),
      queueSupported: bool(state.queue_supported), queueDepth: int(state.queue_depth),
      probeIntervalHours: int(state.probe_interval_hours), billingCycleDay: int(state.billing_cycle_day),
      billingProbeIntervalHours: int(state.billing_probe_interval_hours),
      observedAt: time(state.updated_at), databaseNow: time(state.database_now),
    } : null, recentCalls: rows.slice(0, 30).map(row => ({ callId: id(row.id), requestId: id(row.usage_request_id),
      outcome: choice(row.outcome, ['pending', 'succeeded', 'succeeded_unusable', 'rejected', 'unknown']),
      httpStatus: int(row.http_status) >= 100 && int(row.http_status) <= 599 ? row.http_status : null,
      costKind: choice(row.cost_kind, ['estimated', 'unknown']), startedAt: time(row.started_at), completedAt: time(row.completed_at),
      billingHeaders: { source: choice(row.quota?.billingHeaderSource, ['x-ratelimit-requests', 'x-rapidapi-requests']),
        remaining: int(row.quota?.remaining), limit: int(row.quota?.limit), resetSeconds: int(row.quota?.resetSeconds),
        conflict: bool(row.quota?.quotaConflict), monthlyExhausted: bool(row.quota?.monthlyExhausted) },
    })), truncated: rows.length > 30, scope: 'Facebook RapidAPI only; preceding 7 days; latest 30 calls; current state is not historical routing proof' }
  } catch { throw new Error('diagnostic_read_failed') }
  finally {
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
    if (process.argv.length > 2) throw new Error('invalid_arguments')
    if (!process.env.DATABASE_URL) throw new Error('database_url_required')
    const { default: pg } = await import('pg')
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, query_timeout: 4000 })
    console.log(JSON.stringify(await diagnoseFacebookQuota(pool), null, 2))
  } catch (error) {
    console.error(JSON.stringify({ error: ['invalid_arguments', 'database_url_required'].includes(error.message) ? error.message : 'diagnostic_read_failed' }))
    process.exitCode = 1
  } finally { await pool?.end() }
}
