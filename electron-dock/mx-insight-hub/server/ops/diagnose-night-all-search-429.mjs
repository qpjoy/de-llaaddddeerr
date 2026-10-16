import { pathToFileURL } from 'node:url'

// Standalone stdin diagnostic. No application/adapter imports, HTTP, raw
// archives, request/response bodies, queries, credentials or mutations.
export const INCIDENT_REQUEST_IDS = Object.freeze([
  '9e20649f-ca22-455e-a9ff-16fe625ab9ad',
  'f9ed20e4-ecc9-4fb0-bcfc-2770817fdfda',
  'ac4b66e1-b757-40b6-a593-9340b8bd7c37',
])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const LIMIT = 20
const uuid = value => typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null
const choice = (value, values) => value == null ? null : values.includes(value) ? value : 'other'
const integer = (value, maximum = 1_000_000_000) => {
  const number = typeof value === 'string' && /^\d{1,12}$/u.test(value) ? Number(value) : value
  return Number.isSafeInteger(number) && number >= 0 && number <= maximum ? number : null
}
const time = value => {
  if (!(value instanceof Date) && !(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?$/u.test(value))) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
const http = value => integer(value, 599) >= 100 ? integer(value, 599) : null
const correlationId = value => uuid(value) || (typeof value === 'string'
  && /^(?:[a-f0-9]{32}|req_[A-Za-z0-9_-]{8,80})$/u.test(value) ? value : null)
const errorCode = value => choice(value, ['night_all_http_429', 'night_all_http_502', 'night_all_rejected',
  'RATE_LIMITED', 'night_all_timeout', 'night_all_network_error', 'request_outcome_unknown',
  'external_platform_pre_dispatch_failed', 'reservation_lease_expired'])

export function parseNightAll429Arguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true }
  if (!args.length) return { requestIds: [...INCIDENT_REQUEST_IDS] }
  if (args.length > 20 || args.length % 2) throw new Error('invalid_arguments')
  const requestIds = []
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] !== '--request-id') throw new Error('invalid_arguments')
    const value = uuid(args[index + 1])
    if (!value) throw new Error('invalid_request_id')
    if (!requestIds.includes(value)) requestIds.push(value)
  }
  return { requestIds }
}

export function nightAllTargetPort(environment = {}) {
  const configured = Boolean(environment.NIGHT_ALL_BASE_URL)
  try {
    const target = new URL(environment.NIGHT_ALL_BASE_URL || 'http://127.0.0.1:13141')
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error()
    return { source: configured ? 'current_admin_environment' : 'hub_default',
      port: Number(target.port || (target.protocol === 'https:' ? 443 : 80)),
      historicalTargetVerified: false }
  } catch { return { source: configured ? 'current_admin_environment' : 'hub_default', port: null, configurationInvalid: true,
    historicalTargetVerified: false } }
}

export async function diagnoseNightAllSearch429(pool, requestIds = INCIDENT_REQUEST_IDS, environment = {}) {
  if (!Array.isArray(requestIds) || !requestIds.length || requestIds.length > 10 || requestIds.some(value => !uuid(value))) throw new Error('invalid_request_id')
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '3s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'")
    const section = async (sql, values, project) => {
      await client.query('SAVEPOINT diagnostic_section')
      try {
        const { rows } = await client.query(sql, values)
        await client.query('RELEASE SAVEPOINT diagnostic_section')
        return { state: 'read', rows: rows.slice(0, LIMIT).map(project), truncated: rows.length > LIMIT }
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT diagnostic_section')
        await client.query('RELEASE SAVEPOINT diagnostic_section')
        return { state: ['42P01', '42703'].includes(error.code) ? 'unsupported_schema' : 'read_unavailable',
          reason: choice(error.code, ['42P01', '42703', '42501', '57014', '55P03']), rows: null }
      }
    }
    const requests = []
    for (const requestId of [...new Set(requestIds.map(uuid))]) {
      const values = [requestId]
      const usage = await section(`SELECT /* night-all-429:usage */ id,platform,status,error_code,response_status,
        upstream_latency_ms,reserved_at,completed_at,clock_timestamp() AS database_now
        FROM public.usage_requests WHERE id=$1::uuid LIMIT 1`, values, row => ({
        requestId: uuid(row.id), platform: choice(row.platform, ['reddit', 'twitter', 'youtube']),
        status: choice(row.status, ['reserved', 'committed', 'released', 'unknown']),
        errorCode: errorCode(row.error_code), savedHttpStatus: http(row.response_status),
        upstreamLatencyMs: integer(row.upstream_latency_ms), reservedAt: time(row.reserved_at), completedAt: time(row.completed_at),
        databaseNow: time(row.database_now),
      }))
      const path = await section(`SELECT /* night-all-429:path */ acquisition_request->>'path' AS request_path
        FROM public.usage_requests WHERE id=$1::uuid LIMIT 1`, values, row => ({
        path: choice(row.request_path, ['/api/v1/data/search', '/api/v1/search/raw', '/api/v1/night-all/search/raw']),
      }))
      const connectorCalls = await section(`SELECT /* night-all-429:connectors */ id,operation,platform,outcome,http_status,
        failure_kind,error_code,upstream_latency_ms,upstream_request_id,upstream_trace_id,started_at,completed_at
        FROM serving.connector_calls WHERE usage_request_id=$1::uuid ORDER BY started_at,id LIMIT 21`, values, row => ({
        callId: uuid(row.id), operation: choice(row.operation, ['raw', 'crawl', 'user-info', 'data-search', 'data.search', 'search']),
        platform: choice(row.platform, ['reddit', 'twitter', 'youtube']), outcome: choice(row.outcome, ['complete', 'partial', 'failed', 'unknown']),
        httpStatus: http(row.http_status), failureKind: choice(row.failure_kind, ['network', 'timeout', 'http', 'contract', 'business', 'internal', 'unknown']),
        errorCode: errorCode(row.error_code), upstreamLatencyMs: integer(row.upstream_latency_ms),
        upstreamRequestId: correlationId(row.upstream_request_id), upstreamTraceId: correlationId(row.upstream_trace_id),
        startedAt: time(row.started_at), completedAt: time(row.completed_at),
      }))
      // Optional new metadata is a separate query so older deployments retain
      // their basic evidence even without the failure_evidence column.
      const rateLimitEvidence = await section(`SELECT /* night-all-429:rate-metadata */ id,
        failure_evidence->'errors' @> '[{"code":"RATE_LIMITED"}]'::jsonb AS rate_limited_code_present,
        failure_evidence#>>'{rateLimit,layer}' AS layer, failure_evidence#>>'{rateLimit,scope}' AS scope,
        failure_evidence#>>'{rateLimit,keyType}' AS key_type, failure_evidence#>>'{rateLimit,limit}' AS limit_value,
        failure_evidence#>>'{rateLimit,remaining}' AS remaining, failure_evidence#>>'{rateLimit,windowMs}' AS window_ms,
        failure_evidence#>>'{rateLimit,retryAfterSeconds}' AS retry_seconds,
        failure_evidence#>>'{rateLimit,resetAt}' AS reset_at, failure_evidence#>>'{rateLimit,dispatched}' AS dispatched
        FROM serving.connector_calls WHERE usage_request_id=$1::uuid ORDER BY started_at,id LIMIT 21`, values, row => ({
        callId: uuid(row.id), rateLimitedCodePresent: typeof row.rate_limited_code_present === 'boolean' ? row.rate_limited_code_present : null,
        layer: choice(row.layer, ['night_all_ingress']), scope: choice(row.scope, ['data-search', 'public', 'search', 'raw', 'crawl', 'user-info']),
        keyType: choice(row.key_type, ['ip']), limit: integer(row.limit_value), remaining: integer(row.remaining),
        windowMs: integer(row.window_ms, 86400000), retryAfterSeconds: integer(row.retry_seconds, 86400), resetAt: time(row.reset_at),
        dispatched: row.layer === 'night_all_ingress' && row.dispatched === 'false' ? false : null,
      }))
      const hubProviderDispatchPresence = await section(`SELECT /* night-all-429:dispatch-presence */ EXISTS (
        SELECT 1 FROM external_platform.provider_calls WHERE usage_request_id=$1::uuid LIMIT 1
      ) AS recorded`, values, row => ({ recorded: typeof row.recorded === 'boolean' ? row.recorded : null }))
      requests.push({ requestId, usage, path, connectorCalls, rateLimitEvidence, hubProviderDispatchPresence })
    }
    return { diagnosticRevision: 'night-all-search-429.v1', checkedAt: new Date().toISOString(),
      nightAllTarget: nightAllTargetPort(environment), rowLimitPerSection: LIMIT, requests,
      evidenceBoundary: 'Saved Hub evidence only. Missing rows/metadata do not prove no upstream call. Hub provider-call presence does not measure Night-All internal dispatch. Current Admin configuration does not prove the historical Public target. No upstream HTTP or production mutation performed.' }
  } catch { throw new Error('diagnostic_read_failed') }
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
    const options = parseNightAll429Arguments(process.argv.slice(2))
    if (options.help) console.log('Usage: node server/ops/diagnose-night-all-search-429.mjs [--request-id UUID ...]\nDefaults to the three 2026-10-13 incident requests. At most 10 UUIDs; stored read-only evidence only; no HTTP or body output.')
    else {
      if (!process.env.DATABASE_URL) throw new Error('database_url_required')
      const { default: pg } = await import('pg')
      pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000,
        query_timeout: 4000, options: '-c default_transaction_read_only=on -c statement_timeout=3000 -c lock_timeout=1000' })
      console.log(JSON.stringify(await diagnoseNightAllSearch429(pool, options.requestIds, process.env), null, 2))
    }
  } catch (error) {
    console.error(JSON.stringify({ error: choice(error.message, ['invalid_arguments', 'invalid_request_id', 'database_url_required', 'diagnostic_read_failed']) }))
    process.exitCode = 1
  } finally { await pool?.end().catch(() => { console.error('{"error":"diagnostic_read_failed"}'); process.exitCode = 1 }) }
}
