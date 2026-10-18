import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Independent stdin diagnostic: no Hub runtime imports, archives, HTTP or writes.
// Exact incident UUIDs avoid a historical table scan and contain no query/cursor/key.
export const INCIDENT_IDS = Object.freeze(`
5e540f29-5086-43dd-b36e-65353b73d7c2 692b026b-74d0-467f-91ac-bde5e6385ff5
b46b71ef-4da2-43cc-b55c-5172706267e1 8ff49526-bdbd-47af-ae2a-fa4addacf6d8
e45c1da1-9b33-45ec-9dab-b59cc0a67b10 1c1656ae-aa91-4774-8be3-bb6511b6dee3
3e0d9744-8f75-4fd4-8d43-2ff1fa3c91a5 f6915ee2-b6d1-45a3-8f38-ec7255c33d8b
9079cf15-b4bf-41cd-bd58-8e09b5486301 c54130a8-a442-476e-a28f-c05b0a19b324
64b5a409-5f74-46c4-9f3e-026471f7efea b13e7b4f-11c7-4e8d-9ab5-a83f9bfc6bee
041fdd71-6ffe-48c0-88b1-f6396b6e6edf ad8bc9f7-a6f2-4aec-bb33-3f983cb02c2f
328d43e1-0325-4391-a88f-44cd88a0452e 83443bf9-4a32-4289-b73a-1fe941e989d8
8ab95c69-c685-49c0-a012-fc5bc1f4d84d a10aa016-ab15-4dd1-b13f-5f196f282a53
1966c5ff-c3df-4eaa-b4bb-b7e9f392e589 8d635122-f0b4-46db-9ae8-335c8c4b8a1f
ff72da2d-bcd8-446c-90ce-4210c1294e7f 642fa4d8-f2e1-4eaa-a71e-fd714237f571
3f8c7c93-43d8-4e04-9a5b-63d008eb89c5 3ad43e2c-5bb6-45a9-9bc2-1c6d6f181c36
8802fcc5-5750-4c04-9480-f2a652563de6 6fb09c06-4ebb-4081-9150-44e34bd4de68
891e08c8-7146-4a38-ab13-8f02ed8b99f2 2ef2ed45-a8d8-4fd9-b5ad-61b9decb84ca
e53561ce-b231-4bef-9fe4-1ca831726011 7be7a0d3-5bc7-42f8-b32a-2c2caa80b3be
88758531-a5d8-4c20-8d3e-75294c783a49 62c370c4-89b9-4cd1-a354-eebb4fec5b4c
cbc266d2-5fcc-47a0-9a3f-b376a18b81f7 911f1a2b-db69-4184-b3a9-d6aa9ff80e63
b1e35da6-2a35-4bfe-ae0e-79d9fad389b3 27a4771d-3f1a-407b-a031-02366920cdb9
0e47337f-b90e-4ac3-939a-55bf0ebabe23 8df72f60-7f91-483f-860d-449588bec9f4
7b1ffdfa-9bcd-4855-8080-748e024d58d8 26168e45-fee4-49ff-9872-080df3637d9e
97f4b3f9-3c3d-4808-a7e0-51a8b52215b5 a3e75382-2640-4911-903e-09088bde5647
3c6672cf-6b66-4a36-ad0e-b329c535349a 4e2b3ef1-66dd-4e3b-9926-946ac004570a
30a96711-4cfd-4cf7-86d3-f1c9ab2d06c7 06667eef-0a5d-4178-8f63-e6de547d3e50
ca24b7c6-2210-41cb-a7b2-1fc15b14fd87 0ed5fed4-72f6-419e-a88d-418109c67bb5
0c1db84d-154a-4b34-a079-2246660b7a9e a787fa5f-b902-4ddf-9d3f-f6b17607a2e6
6b5e1a04-7b2f-4bb6-99c6-da853dc7a713 c0d55984-54cc-4dbd-8ac1-b665cf8963d6
160a55c4-d386-4348-abb6-45d8e583e682 ba9160dc-cbc9-4887-a6d8-07942c0e0c2a
ea88058e-01f5-439b-95fd-141e9d110761 faf74a02-22cd-468c-902c-69ce9047fcaa
`.trim().split(/\s+/u))
export const SAMPLE_IDS = Object.freeze([INCIDENT_IDS[0], INCIDENT_IDS[28], INCIDENT_IDS[26], INCIDENT_IDS[43]])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const STATUS = ['reserved', 'committed', 'released', 'unknown']
const ERRORS = ['external_platform_pre_dispatch_failed', 'external_platform_persistence_unknown',
  'external_platform_call_persistence_unknown', 'external_platform_busy', 'external_platform_rate_limited',
  'external_platform_circuit_open', 'reservation_lease_expired', 'request_outcome_unknown',
  'social_upstream_outcome_unknown', 'social_upstream_rejected', 'social_upstream_response_unusable']
const PHASES = ['admission', 'begin_call', 'provider_request', 'project_response', 'finish_failure',
  'validate_evidence', 'stage_evidence', 'finish_step', 'assemble_page', 'build_delivery', 'commit_delivery', 'supplier_handoff']
const CLASSES = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'AggregateError', 'AppError', 'TikHubUpstreamError', 'RapidApiUpstreamError', 'DatabaseError']
const SQLSTATES = ['08000', '08001', '08003', '08004', '08006', '08007', '08P01', '22001', '22003', '22007',
  '22008', '22021', '22P02', '23502', '23503', '23505', '23514', '25006', '25P02', '40001', '40P01',
  '42501', '42703', '42P01', '53000', '53100', '53200', '53300', '53400', '54000', '55P03', '57014', '57P01', '57P02', '57P03', '58030', 'XX000', 'XX001', 'XX002']
const TRANSPORT = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'ERR_OUT_OF_MEMORY']
const EVENTS = ['hub_postgres_idle_connection_error', 'hub_database_request_failed', 'twitter_search_outcome_unknown']
const choice = (value, allowed) => value == null ? null : allowed.includes(value) ? value : 'other'
const uuid = value => typeof value === 'string' && UUID.test(value) ? value : null
const count = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
const databaseCount = value => typeof value === 'string' && /^\d+$/u.test(value) ? count(Number(value)) : count(value)
const bool = value => typeof value === 'boolean' ? value : null
const http = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null
const time = value => {
  if (!(value instanceof Date) && !(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?$/u.test(value))) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
const elapsed = (start, end) => time(start) && time(end) ? count(Date.parse(time(end)) - Date.parse(time(start))) : null
const safeFailure = error => ({ error: 'diagnostic_read_failed', sqlState: choice(error?.code, SQLSTATES), errorClass: choice(error?.name, CLASSES) })
const LIMIT = 100

export function hub504Runtime({ root = process.cwd(), env = process.env } = {}) {
  const files = ['server/index.mjs', 'server/config.mjs', 'server/stores/postgres-store.mjs',
    'server/core/postgres-pool.mjs',
    'server/external-platforms/store.mjs', 'server/external-platforms/content-search-workflow.mjs',
    'server/external-platforms/twitter-search-fill.mjs', 'server/adapters/rapidapi.mjs']
  return { scope: 'this_container_files_and_environment_only_not_historical_or_live_process_pool',
    listenerMode: choice(env.MX_INSIGHT_LISTENER_MODE, ['public', 'admin', 'combined']),
    nodeVersion: /^v\d+\.\d+\.\d+$/u.test(process.version) ? process.version : null,
    configuredCommonPool: Object.fromEntries(['MX_COMMON_POSTGRES_MAX_CONNECTIONS', 'MX_COMMON_POSTGRES_STATEMENT_TIMEOUT_MS']
      .map(name => [name, env[name] == null ? null : databaseCount(env[name])])),
    configuredCommonPoolMeaning: 'explicit_environment_only_null_means_unset_or_invalid_defaults_depend_on_installed_code',
    installedSources: files.map(file => {
      try {
        const path = new URL(file, pathToFileURL(`${root}/`)), stat = statSync(path)
        if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return { file, sha256: null }
        return { file, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }
      } catch { return { file, sha256: null } }
    }),
    livePoolCounters: 'unavailable_in_separate_diagnostic_process',
  }
}

export async function diagnoseHub504(pool) {
  let client, rollbackError
  try {
    client = await pool.connect()
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'")
    const { rows: [schema] } = await client.query(`SELECT /* hub-504:schema */
      to_regclass('public.usage_requests') IS NOT NULL AS usage,
      to_regclass('external_platform.provider_calls') IS NOT NULL AS calls,
      to_regclass('external_platform.gateway_requests') IS NOT NULL AS gateways`)
    const usage = schema?.usage === true ? (await client.query(`SELECT /* hub-504:usage */
      id, platform, status, error_code, response_status, reserved_at, completed_at, upstream_latency_ms
      FROM public.usage_requests WHERE id = ANY($1::uuid[]) ORDER BY reserved_at, id`, [INCIDENT_IDS])).rows : []
    const calls = schema?.calls === true ? (await client.query(`SELECT /* hub-504:calls */
      id, usage_request_id, outcome, http_status, billed, item_count, latency_ms, error_code, started_at, completed_at
      FROM external_platform.provider_calls WHERE usage_request_id = ANY($1::uuid[])
      ORDER BY started_at, id LIMIT 101`, [SAMPLE_IDS])).rows : []
    const gateways = schema?.gateways === true ? (await client.query(`SELECT /* hub-504:gateways */
      usage_request_id, provider_call_id, source_mode, succeeded, response_status, error_code, created_at
      FROM external_platform.gateway_requests WHERE usage_request_id = ANY($1::uuid[])
      ORDER BY created_at, id LIMIT 101`, [SAMPLE_IDS])).rows : []
    const { rows: [database] } = await client.query(`SELECT /* hub-504:database */
      clock_timestamp() AS database_now, pg_postmaster_start_time() AS database_started_at,
      current_setting('max_connections')::int AS max_connections,
      pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER') OR (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS all_sessions_visible,
      numbackends, deadlocks, conflicts, stats_reset FROM pg_stat_database WHERE datname = current_database()`)
    const { rows: connections } = await client.query(`SELECT /* hub-504:connections */
      state, wait_event_type, count(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
      GROUP BY state, wait_event_type ORDER BY count(*) DESC LIMIT 101`)
    const { rows: blocking } = await client.query(`SELECT /* hub-504:blocking */
      pid, state, wait_event_type, pg_blocking_pids(pid) AS blocking_pids,
      GREATEST(0, floor(extract(epoch FROM clock_timestamp() - xact_start) * 1000))::float8 AS transaction_age_ms,
      GREATEST(0, floor(extract(epoch FROM clock_timestamp() - query_start) * 1000))::float8 AS query_age_ms
      FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()
      AND (wait_event_type = 'Lock' OR state = 'idle in transaction')
      ORDER BY xact_start NULLS LAST, pid LIMIT 101`)
    const projected = usage.filter(row => INCIDENT_IDS.includes(row.id)).map(row => ({ requestId: row.id,
      platform: choice(row.platform, ['twitter']), status: choice(row.status, STATUS), errorCode: choice(row.error_code, ERRORS),
      savedHttpStatus: http(row.response_status), reservedAt: time(row.reserved_at), completedAt: time(row.completed_at),
      elapsedMs: elapsed(row.reserved_at, row.completed_at), upstreamLatencyMs: count(row.upstream_latency_ms) }))
    const groups = new Map()
    for (const row of projected) {
      const key = `${row.status}/${row.errorCode}`
      const group = groups.get(key) || { status: row.status, errorCode: row.errorCode, count: 0, over60Seconds: 0 }
      group.count++; if (row.elapsedMs > 60000) group.over60Seconds++
      groups.set(key, group)
    }
    const states = ['active', 'idle', 'idle in transaction', 'idle in transaction (aborted)', 'fastpath function call', 'disabled']
    const waits = ['Activity', 'BufferPin', 'Client', 'Extension', 'IO', 'IPC', 'Lock', 'LWLock', 'Timeout']
    return { diagnosticRevision: 'hub-504-2026-10-18.v1',
      incidentWindow: { from: '2026-10-18T14:08:00Z', to: '2026-10-18T14:23:00Z' },
      scope: 'exact_56_saved_incident_uuids_not_all_requests_in_window',
      schema: { usage: bool(schema?.usage), calls: bool(schema?.calls), gateways: bool(schema?.gateways) },
      batch: { expected: INCIDENT_IDS.length, found: projected.length, missingRequestIds: INCIDENT_IDS.filter(id => !projected.some(row => row.requestId === id)), groups: [...groups.values()] },
      samples: SAMPLE_IDS.map(requestId => ({ requestId, usage: projected.find(row => row.requestId === requestId) ?? null,
        providerCalls: calls.slice(0, LIMIT).filter(row => row.usage_request_id === requestId).map(row => ({ callId: uuid(row.id),
          outcome: choice(row.outcome, ['pending', 'succeeded', 'succeeded_unusable', 'rejected', 'unknown']),
          httpStatus: http(row.http_status), billed: bool(row.billed), itemCount: count(row.item_count), latencyMs: count(row.latency_ms),
          errorCode: choice(row.error_code, ERRORS), startedAt: time(row.started_at), completedAt: time(row.completed_at) })),
        gateways: gateways.slice(0, LIMIT).filter(row => row.usage_request_id === requestId).map(row => ({ providerCallId: uuid(row.provider_call_id),
          sourceMode: choice(row.source_mode, ['live', 'fresh_cache', 'stored_fallback', 'idempotent_replay', 'duplicate_suppressed', 'circuit_rejected', 'unavailable']),
          succeeded: bool(row.succeeded), httpStatus: http(row.response_status), errorCode: choice(row.error_code, ERRORS), createdAt: time(row.created_at) })) })),
      evidenceLimits: { rowLimit: LIMIT, callsTruncated: calls.length > LIMIT, gatewaysTruncated: gateways.length > LIMIT,
        historicalSqlStateAndPhase: 'not_retained_in_these_tables_use_filtered_original_logs',
        billing: 'committed_released_unknown_are_preserved_missing_provider_rows_do_not_prove_no_dispatch_or_charge' },
      currentDatabase: { scope: 'current_snapshot_and_counters_since_stats_reset_not_incident_proof',
        databaseNow: time(database?.database_now), startedAt: time(database?.database_started_at), statsReset: time(database?.stats_reset),
        maxConnections: count(database?.max_connections), connections: count(database?.numbackends),
        deadlocks: databaseCount(database?.deadlocks), recoveryConflicts: databaseCount(database?.conflicts),
        allSessionsVisible: bool(database?.all_sessions_visible), connectionFailures: 'not_available_in_portable_pg_stat_database_columns',
        connectionDistribution: connections.slice(0, LIMIT).map(row => ({ state: choice(row.state, states), waitType: choice(row.wait_event_type, waits), count: count(row.count) })),
        blocking: blocking.slice(0, LIMIT).map(row => ({ pid: count(row.pid), state: choice(row.state, states), waitType: choice(row.wait_event_type, waits),
          blockingPids: Array.isArray(row.blocking_pids) ? row.blocking_pids.slice(0, LIMIT).map(count).filter(value => value !== null) : [],
          transactionAgeMs: count(row.transaction_age_ms), queryAgeMs: count(row.query_age_ms) })),
        connectionsTruncated: connections.length > LIMIT, blockingTruncated: blocking.length > LIMIT,
        visibility: 'without_all_sessions_visibility_other_roles_may_be_hidden_missing_rows_are_not_proof_of_no_waits' },
    }
  } catch (error) {
    const safe = new Error('diagnostic_read_failed'); safe.diagnostic = safeFailure(error); throw safe
  } finally {
    if (client) {
      try { await client.query('ROLLBACK') } catch (error) { rollbackError = error }
      client.release(rollbackError)
      if (rollbackError) { const safe = new Error('diagnostic_read_failed'); safe.diagnostic = safeFailure(rollbackError); throw safe }
    }
  }
}

// Stream-filter original logs locally; never echo arbitrary lines, messages or SQL.
// Supports JSON log objects, console.warn multi-line objects, and Node error headers.
export async function filterHub504Logs(input, emit) {
  let pending = '', object = null, objectLines = 0, firstTime = null, outputCount = 0, discardedLongLines = 0, discarding = false
  const output = record => {
    const source = record?.err && typeof record.err === 'object' ? { ...record, ...record.err } : record
    if (!source || typeof source !== 'object') return
    const incident = INCIDENT_IDS.includes(source.requestId)
    const event = EVENTS.includes(source.event) ? source.event : null
    const requestId = incident ? source.requestId : event ? uuid(source.requestId) : null
    const errorClass = CLASSES.includes(source.errorClass || source.name) ? source.errorClass || source.name : null
    const code = source.sqlState || source.code
    const sqlState = SQLSTATES.includes(code) ? code : null, transportCode = TRANSPORT.includes(code) ? code : null
    const phase = requestId && PHASES.includes(source.phase) ? source.phase : null
    if (!requestId && !errorClass && !sqlState && !transportCode && !event) return
    if (outputCount++ >= 500) return
    emit({ timestamp: time(source.timestamp) || firstTime, requestId,
      callId: requestId ? uuid(source.callId) : null, phase, errorClass, sqlState, transportCode, event,
      attribution: incident ? 'saved_incident_request' : requestId ? 'runtime_request_not_original_incident' : 'process_log_metadata_not_attributed_to_incident' })
  }
  const line = raw => {
    const match = raw.match(/^(\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?)\s+(.*)$/u)
    const stamp = match ? time(match[1]) : null, text = (match ? match[2] : raw).trim()
    if (object && ++objectLines > 40) object = null
    if (!object) firstTime = stamp
    try { const parsed = JSON.parse(text); output({ ...parsed, timestamp: stamp }); return } catch { /* console format */ }
    if (text === '{') { object = {}; objectLines = 0; firstTime = stamp; return }
    if (object && text.startsWith('}')) { output({ ...object, timestamp: firstTime }); object = null; return }
    const inline = text.match(/^\{(.*)\}(?:\s.*)?$/u)
    const body = (inline ? inline[1] : text).trim()
    // Accept complete lines of whitelisted primitive fields only; never eval
    // console inspection text or search arbitrary message/SQL substrings.
    const grammar = /^(?:(?:requestId|callId|phase|errorClass|sqlState|code|name|event):\s*(?:'[-A-Za-z0-9_]+'|"[-A-Za-z0-9_]+"|null),?\s*)+$/u
    if (grammar.test(body)) {
      const fields = {}
      for (const field of body.matchAll(/(requestId|callId|phase|errorClass|sqlState|code|name|event):\s*['"]([-A-Za-z0-9_]+)['"]/gu)) fields[field[1]] = field[2]
      if (object && !inline) Object.assign(object, fields)
      else output({ ...fields, timestamp: stamp })
      return
    }
    const exception = text.match(/^(Error|TypeError|RangeError|SyntaxError|ReferenceError|AggregateError|DatabaseError|error):/u)
    if (exception) output({ name: exception[1] === 'error' ? 'DatabaseError' : exception[1], timestamp: stamp })
  }
  for await (const chunk of input) {
    for (const part of String(chunk).split(/(?<=\n)/u)) {
      if (!discarding) pending += part
      if (pending.length > 32768) { pending = ''; discarding = true; discardedLongLines++; object = null }
      if (part.endsWith('\n')) { if (!discarding) line(pending.trimEnd()); pending = ''; discarding = false }
    }
  }
  if (pending && !discarding) line(pending)
  emit({ summary: true, emitted: Math.min(outputCount, 500), truncated: outputCount > 500, discardedLongLines,
    interpretation: 'metadata_only_absence_is_not_proof_no_error_logs_may_be_rotated_previous_is_only_last_container_instance' })
}

if (process.argv[1] === '-' || process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let pool
  try {
    const args = process.argv.slice(2)
    if (args.length === 1 && args[0] === '--logs' && process.argv[1] !== '-') {
      await filterHub504Logs(process.stdin, value => console.log(JSON.stringify(value)))
    } else {
      if (args.length) throw new Error('invalid_arguments')
      if (!process.env.DATABASE_URL) throw new Error('database_url_required')
      const { default: pg } = await import('pg')
      pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000,
        query_timeout: 6000, application_name: 'hub-504-readonly-diagnostic' })
      pool.on('error', () => {})
      console.log(JSON.stringify({ ...await diagnoseHub504(pool), runtime: hub504Runtime() }, null, 2))
    }
  } catch (error) {
    console.error(JSON.stringify(error.diagnostic || { error: ['invalid_arguments', 'database_url_required'].includes(error.message) ? error.message : 'diagnostic_read_failed' }))
    process.exitCode = 1
  } finally { await pool?.end() }
}
