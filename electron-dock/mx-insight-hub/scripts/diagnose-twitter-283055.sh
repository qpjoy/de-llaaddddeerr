#!/usr/bin/env bash
# Run on the operator host with kubectl configured for the production Hub.
# Optional arguments: [all|2026-11-DD|2026-11-DDTHH] [default|signature|receipts|active|released|v2|all]
# Beijing dates 18–24 only. Default returns the signature and acquisition denominators.
# v2 is explicitly selectable because its serving index has no creation-time column.
# Stdout is one JSON report; stderr streams obtained counts and incomplete sections.
set -eu
if [ "$#" -gt 2 ]; then echo 'Expected [Beijing date or hour] [metric]' >&2; exit 2; fi
case "${1:-all}" in all|2026-11-1[89]|2026-11-2[0-4]|2026-11-1[89]T[01][0-9]|2026-11-1[89]T2[0-3]|2026-11-2[0-4]T[01][0-9]|2026-11-2[0-4]T2[0-3]) ;; *) echo 'Select all, 2026-11-18 through 2026-11-24, or one Beijing hour such as 2026-11-24T17.' >&2; exit 2 ;; esac
case "${2:-default}" in default|signature|receipts|active|released|v2|all) ;; *) echo 'Select default, signature, receipts, active, released, v2, or all.' >&2; exit 2 ;; esac
exec kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- node --input-type=module - "${1:-all}" "${2:-default}" <<'HUB_READ_ONLY'
import pg from 'pg'

// One saved call only. The SQL returns no response text, business-code values or request parameters.
const usageId = '145e1ecc-9480-4fab-a24b-c65e3dc842a8'
const callId = 'eec344d0-2b51-41ca-8ba8-038e8f785512'
const phases = ['admission', 'begin_call', 'provider_request', 'supplier_handoff', 'project_response',
  'stage_evidence', 'finish_step', 'finish_failure', 'assemble_page', 'build_delivery', 'commit_delivery']

const evidenceSql = `
WITH receipt AS (
  SELECT c.http_status AS call_http_status, a.http_status AS archive_http_status,
    a.body_size AS archive_size, r.body_size AS restricted_size, r.json_parsed,
    CASE WHEN r.body_size = 132 AND octet_length(r.body_bytes) = 132
      THEN encode(sha256(r.body_bytes), 'hex') = r.body_sha256 END AS restricted_hash_verified,
    a.payload_sha256 = r.body_sha256 AS archive_hashes_match, r.parsed_payload
  FROM external_platform.provider_calls c
  JOIN public.usage_requests u ON u.id = c.usage_request_id
  LEFT JOIN external_platform.response_archives a ON a.provider_call_id = c.id
  LEFT JOIN control.external_platform_restricted_raw_responses r ON r.provider_call_id = c.id
  WHERE u.id = $1::uuid AND u.platform = 'twitter' AND c.id = $2::uuid
    AND c.provider_key = 'rapidapi' AND c.endpoint_key = 'twitter-aio.search'
    AND c.operation = 'social.content.search'
), fields AS (
  SELECT *, (restricted_hash_verified IS TRUE AND json_parsed IS TRUE AND parsed_payload IS NOT NULL) AS has_json,
    parsed_payload #> '{error,code}' AS nested_code, parsed_payload -> 'code' AS root_code
  FROM receipt
), selected AS (
  SELECT *, coalesce(nullif(nested_code, 'null'::jsonb), root_code) AS candidate FROM fields
)
SELECT call_http_status, archive_http_status, archive_size, restricted_size, json_parsed,
  restricted_hash_verified, archive_hashes_match, has_json AS parsed_projection_available,
  CASE WHEN has_json THEN coalesce(jsonb_typeof(nested_code), 'absent') END AS nested_code_type,
  CASE WHEN has_json THEN coalesce(jsonb_typeof(root_code), 'absent') END AS root_code_type,
  CASE WHEN has_json THEN CASE WHEN nullif(nested_code, 'null'::jsonb) IS NOT NULL THEN 'error.code'
    WHEN nullif(root_code, 'null'::jsonb) IS NOT NULL THEN 'code' ELSE 'none' END END AS selected_code_source,
  CASE WHEN NOT has_json THEN NULL
    WHEN jsonb_typeof(candidate) = 'string' AND (candidate #>> '{}') COLLATE "C" ~ '^[A-Za-z0-9_.:-]{1,100}$'
      THEN NOT pg_input_is_valid(candidate #>> '{}', 'int4')
    WHEN jsonb_typeof(candidate) = 'number' THEN
      (candidate::numeric <> trunc(candidate::numeric) OR candidate::numeric NOT BETWEEN -2147483648 AND 2147483647)
    ELSE false END AS int4_rejected_before_credential_redaction
FROM selected`

async function checkArchive(client) {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try {
    await client.query("SET LOCAL statement_timeout = '5s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    const { rows: [archive] } = await client.query(evidenceSql, [usageId, callId])
    const report = { diagnostic: 'twitter-283055-archive-check.v1', usageId, callId,
      exactCallMatched: Boolean(archive), archive: archive ?? null }
    if (archive) {
      const { rows: [table] } = await client.query("SELECT to_regclass('public.usage_request_failures') IS NOT NULL AS available")
      report.failureTableAvailable = table.available
      report.failure = null
      if (table.available) {
        const { rows: [failure] } = await client.query(`SELECT
          CASE WHEN phase = ANY($3::text[]) THEN phase ELSE 'other' END AS phase,
          CASE WHEN sql_state COLLATE "C" ~ '^[0-9A-Z]{5}$' THEN sql_state END AS sql_state,
          call_id = $2::uuid AS same_call
          FROM public.usage_request_failures WHERE request_id = $1::uuid`, [usageId, callId, phases])
        report.failure = failure ?? null
      }
    }
    return report
  } finally {
    await client.query('ROLLBACK')
  }
}


const [requestedWindow, mode] = process.argv.slice(2)
const [firstDate, lastDate] = ['2026-11-18', '2026-11-24']
const hourMs = 3_600_000, dayMs = 24 * hourMs
const atMidnight = day => Date.parse(day + 'T00:00:00+08:00')
const iso = ms => new Date(ms).toISOString()
const localDay = ms => iso(ms + 8 * hourMs).slice(0, 10)
const rangeStart = requestedWindow === 'all' ? atMidnight(firstDate)
  : atMidnight(requestedWindow.slice(0, 10)) + Number(requestedWindow.slice(11) || 0) * hourMs
const rangeEnd = requestedWindow === 'all' ? atMidnight(lastDate) + dayMs
  : rangeStart + (requestedWindow.length > 10 ? hourMs : dayMs)
const anchorSql = `SELECT u.tenant_id, u.consumer_id, u.api_key_id, transaction_timestamp() AS snapshot_at,
  u.platform = 'twitter' AS twitter, u.acquisition_request->>'path' = '/api/v1/data/search' AS standard,
  EXISTS (SELECT 1 FROM control.data_search_protocol_bindings b
          WHERE b.usage_request_id=u.id AND (b.tenant_id,b.consumer_id,b.api_key_id,b.platform)
                =(u.tenant_id,u.consumer_id,u.api_key_id,u.platform))
    OR EXISTS (SELECT 1 FROM control.data_search_protocol_bindings b
          WHERE b.consumer_id=u.consumer_id AND b.idempotency_key=u.idempotency_key AND b.usage_request_id IS NULL
            AND (b.tenant_id,b.api_key_id,b.platform)=(u.tenant_id,u.api_key_id,u.platform)) AS v2
  FROM public.usage_requests u WHERE u.id=$1::uuid`
const scope = `u.tenant_id=$1 AND u.consumer_id=$2 AND u.api_key_id=$3 AND u.platform='twitter'
  AND u.reserved_at >= $4::timestamptz AND u.reserved_at < $5::timestamptz
  AND u.acquisition_request->>'path'='/api/v1/data/search'`
const dayOfReservation = "(u.reserved_at AT TIME ZONE 'Asia/Shanghai')::date::text"

// Failure rows are sparse, with one row per usage ID. OFFSET 0 keeps the receipt lookup
// on its primary key rather than starting the investigation with every stored request.
const signatureSql = `WITH candidates AS MATERIALIZED (
    SELECT request_id,call_id FROM public.usage_request_failures
    WHERE phase='finish_failure' AND sql_state='22P02' AND call_id IS NOT NULL
  )
  SELECT ${dayOfReservation} AS day, count(*)::int AS n
  FROM candidates f
  CROSS JOIN LATERAL (SELECT tenant_id,consumer_id,api_key_id,platform,reserved_at,acquisition_request,status
    FROM public.usage_requests WHERE id=f.request_id OFFSET 0) u
  WHERE u.status='unknown' AND ${scope} AND EXISTS (SELECT 1 FROM external_platform.provider_calls c
    JOIN external_platform.response_archives a ON a.provider_call_id=c.id
    WHERE c.id=f.call_id AND c.usage_request_id=f.request_id AND c.provider_key='rapidapi'
      AND c.operation='social.content.search' AND c.endpoint_key='twitter-aio.search' AND a.http_status=409 OFFSET 0)
  GROUP BY 1`
// The quota indexes exclude released rows. This explicit predicate gives the main
// count an index range on (key,platform,reserved_at) or (tenant,consumer,platform,reserved_at).
const activeSql = `SELECT count(*)::int AS n, count(*) FILTER (WHERE status='unknown')::int AS unknown
  FROM public.usage_requests u WHERE ${scope} AND status IN ('reserved','committed','unknown')`
// One pass for all selected dates. Re-running this for every hour could scan the
// same history repeatedly since the existing quota indexes omit released rows.
const releasedSql = `SELECT ${dayOfReservation} AS day,count(*)::int AS n FROM public.usage_requests u
  WHERE ${scope} AND status='released' GROUP BY 1`
// Each disjoint hash interval is a range on the existing data_search_protocol_query
// index. Count every selected day during that single pass over the interval.
const v2Sql = `SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date::text AS day, count(*)::int AS total,
    count(*) FILTER (WHERE state='unknown')::int AS recorded,
    count(*) FILTER (WHERE state='running' AND lease_expires_at<=now())::int AS expired
  FROM control.data_search_protocol_bindings
  WHERE tenant_id=$1 AND consumer_id=$2 AND api_key_id=$3 AND platform='twitter'
    AND query_hash >= $6::char(64) AND query_hash < $7::char(64)
    AND created_at >= $4::timestamptz AND created_at < $5::timestamptz GROUP BY 1`

const knownErrors = new Set(['usage_receipt_not_found', 'receipt_not_twitter', 'twitter_search_not_confirmed', 'database_url_required'])
function errorSummary(error) {
  if (knownErrors.has(error.message)) return { error: error.message }
  const sqlState = /^[0-9A-Z]{5}$/.test(error.code ?? '') ? error.code : null
  return { error: sqlState === '57014' ? 'diagnostic_timeout' : 'diagnostic_read_failed', sqlState }
}
const percent = (n, total) => total > 0 ? Math.round(10_000 * n / total) / 100 : null
const progress = (section, detail) => console.error(JSON.stringify({section, ...detail}))

async function readTrend(client) {
  const issues = []
  const report = { scope: 'same_api_key_twitter', timezone: 'Asia/Shanghai', requestedWindow, mode,
    asOf: null, dates: [], issues }
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try {
    await client.query("SET LOCAL lock_timeout='1s'")
    await client.query("SET LOCAL statement_timeout='8s'")
    const { rows: [anchor] } = await client.query(anchorSql, [usageId])
    if (!anchor) throw Error('usage_receipt_not_found')
    if (!anchor.twitter) throw Error('receipt_not_twitter')
    if (!anchor.v2 && !anchor.standard) throw Error('twitter_search_not_confirmed')
    report.asOf = anchor.snapshot_at
    report.anchorV2BindingFound = anchor.v2
    const stop = Math.min(rangeEnd, new Date(anchor.snapshot_at).getTime())
    const ids = [anchor.tenant_id, anchor.consumer_id, anchor.api_key_id]
    const ranges = []
    for (let from = rangeStart; from < stop; from += dayMs) {
      const to = Math.min(from + dayMs, stop), day = localDay(from)
      ranges.push({ day, from, to })
      report.dates.push({ day, from: iso(from), to: iso(to), partial: to - from < dayMs,
        standardAcquisitionReceipts: { total: null, unknown: null, unknownPercent: null,
          unknownWith409And22P02: null, reservedCommittedUnknown: null, released: null }, v2Bindings: null })
    }
    if (!ranges.length) return report
    const args = [...ids, iso(rangeStart), iso(stop)]
    // A failed statement is isolated to its savepoint, keeping one snapshot for
    // all completed sections. Leave failed/unrequested counts null in the report.
    async function readPart(section, window, sql, params, ms) {
      await client.query('SAVEPOINT read_part')
      try {
        await client.query("SELECT set_config('statement_timeout',$1,true)", [ms + 'ms'])
        const { rows } = await client.query(sql, params)
        return rows
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT read_part')
        const issue = { section, window, ...errorSummary(error) }
        issues.push(issue)
        progress(section, issue)
        return null
      } finally {
        await client.query('RELEASE SAVEPOINT read_part')
      }
    }
    if (['default','all','signature'].includes(mode)) {
      const rows = await readPart('signature', requestedWindow, signatureSql, args, 20_000)
      if (rows) {
        for (const row of report.dates) row.standardAcquisitionReceipts.unknownWith409And22P02 = rows.find(r => r.day === row.day)?.n ?? 0
        progress('signature', { counts: report.dates.map(r => [r.day,r.standardAcquisitionReceipts.unknownWith409And22P02]) })
      }
    }
    if (['default','all','receipts','active'].includes(mode)) {
      for (const [i, {day, from, to}] of ranges.entries()) {
        const rows = await readPart('active', day, activeSql, [...ids, iso(from), iso(to)], 8_000)
        if (!rows) continue
        Object.assign(report.dates[i].standardAcquisitionReceipts, { reservedCommittedUnknown: rows[0].n, unknown: rows[0].unknown })
        progress('active', { day, count: rows[0].n, unknown: rows[0].unknown })
      }
    }
    if (['default','all','receipts','released'].includes(mode)) {
      const rows = await readPart('released', requestedWindow, releasedSql, args, 25_000)
      if (rows) for (const row of report.dates) {
        const a = row.standardAcquisitionReceipts
        a.released = rows.find(r => r.day === row.day)?.n ?? 0
        if (a.reservedCommittedUnknown !== null) { a.total = a.released + a.reservedCommittedUnknown; a.unknownPercent = percent(a.unknown, a.total) }
      }
    }
    if (['v2','all'].includes(mode)) {
      const bounds = '0123456789abcdefg', sums = new Map()
      for (let i = 0; i < 16; i++) {
        const rows = await readPart('v2', bounds[i], v2Sql, [...args, bounds[i], bounds[i+1]], 6_000)
        if (!rows) break
        for (const r of rows) {
          const s = sums.get(r.day) || { total:0, recordedUnknown:0, expiredRunning:0 }
          s.total += r.total; s.recordedUnknown += r.recorded; s.expiredRunning += r.expired
          sums.set(r.day, s)
        }
        if (i === 15) for (const row of report.dates) {
          const v = sums.get(row.day) || { total:0, recordedUnknown:0, expiredRunning:0 }
          row.v2Bindings = { ...v, unresolvedPercent: percent(v.recordedUnknown + v.expiredRunning, v.total) }
        }
      }
    }
    return report
  } finally {
    await client.query('ROLLBACK')
  }
}

const report = { run: 283055, usageId, callId }
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000,
  options: '-c default_transaction_read_only=on -c statement_timeout=8000 -c idle_in_transaction_session_timeout=30000' })
try {
  if (!process.env.DATABASE_URL) throw Error('database_url_required')
  await client.connect()
  if (mode === 'all') {
    try { report.archiveCheck = await checkArchive(client) }
    catch (error) { report.archiveCheck = errorSummary(error); process.exitCode = 1 }
  }
  try {
    report.trend = await readTrend(client)
    if (report.trend.issues.length) process.exitCode = 1
  } catch (error) { report.trend = errorSummary(error); process.exitCode = 1 }
} catch (error) { report.connection = errorSummary(error); process.exitCode = 1 }
finally { await client.end() }
console.log(JSON.stringify(report, null, 2))
HUB_READ_ONLY
