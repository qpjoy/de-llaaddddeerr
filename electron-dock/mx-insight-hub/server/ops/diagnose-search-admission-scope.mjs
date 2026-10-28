// Read-only: from one blockingRequestId, list every request that can block
// standard-search admission for the same Key, platform and query, with the
// action each needs. No writes, dispositions, retries or supplier calls; the
// query is reported only as length and hash prefix.
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const REVISION = 'search-admission-scope.v1'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
// Same characters as search-protocol-store.mjs, so this scan matches the gate.
const QUERY_TRIM_CHARACTERS = ' \t\n\r\v\f                 　﻿'
// A reservation older than this is not a normal in-flight search.
const STALE_RESERVATION_MINUTES = 30
const SAFE_CODES = new Set(['invalid_arguments', 'invalid_request_id', 'database_url_required', 'request_not_found', 'query_unavailable'])
const fail = code => Object.assign(new Error(code), { diagnosticCode: code })
const source = path => import(new URL(path, pathToFileURL(`${process.cwd()}/`)))
const iso = value => value ? new Date(value).toISOString() : null
const text = value => typeof value === 'string' ? value.slice(0, 120) : null

function action({ usageStatus, bindingState, leaseExpired, ageMinutes, disposed, dispositionAvailable }) {
  if (disposed) return 'none_disposed'
  const running = usageStatus === 'reserved' || (bindingState === 'running' && !leaseExpired)
  if (running) return ageMinutes != null && ageMinutes > STALE_RESERVATION_MINUTES ? 'investigate_stuck_reservation' : 'wait_in_progress'
  return dispositionAvailable ? 'dispose_in_diagnostics_center' : 'deploy_disposition_then_dispose'
}

export async function diagnoseAdmissionScope(pool, blockerId, { now = Date.now() } = {}) {
  if (!UUID.test(blockerId || '')) throw fail('invalid_request_id')
  const [{ dataSearchQueryHash, DATA_SEARCH_V1_PATH }, dispositions] = await Promise.all([
    source('server/contracts/data-search-v2.mjs'), source('server/operations/search-admission-disposition.mjs').catch(() => null)])
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout='5s'")
    const blocker = (await client.query(`SELECT /* admission-scope:blocker */ u.tenant_id,u.consumer_id,u.api_key_id,u.platform,
      u.acquisition_request->'body'->>'query' AS query,b.request_body->>'query' AS binding_query
      FROM usage_requests u LEFT JOIN control.data_search_protocol_bindings b ON b.usage_request_id=u.id WHERE u.id=$1 LIMIT 1`, [blockerId])).rows[0]
    if (!blocker) throw fail('request_not_found')
    const query = [blocker.query, blocker.binding_query].find(value => typeof value === 'string' && value.trim())
    if (!query) throw fail('query_unavailable')
    const scope = [blocker.tenant_id, blocker.consumer_id, blocker.api_key_id, blocker.platform], queryHash = dataSearchQueryHash(query)
    // The two unresolved scans and the lease scan below mirror SearchProtocolStore.begin.
    const bindings = (await client.query(`SELECT /* admission-scope:bindings */ usage_request_id,state,lease_expires_at<=now() AS lease_expired
      FROM control.data_search_protocol_bindings WHERE tenant_id=$1 AND consumer_id=$2 AND api_key_id=$3 AND platform=$4 AND query_hash=$5
      AND state IN ('unknown','running') LIMIT 50`, [...scope, queryHash])).rows
    const usages = (await client.query(`SELECT /* admission-scope:usages */ id FROM usage_requests
      WHERE tenant_id=$1 AND consumer_id=$2 AND api_key_id=$3 AND platform=$4 AND acquisition_request->>'path'=$5
      AND jsonb_typeof(acquisition_request->'body'->'query')='string' AND btrim(acquisition_request->'body'->>'query',$7)=$6
      AND status IN ('unknown','reserved') LIMIT 50`, [...scope, DATA_SEARCH_V1_PATH, query.trim(), QUERY_TRIM_CHARACTERS])).rows
    const leases = (await client.query(`SELECT /* admission-scope:leases */ count(*)::int AS total,count(*) FILTER (WHERE expires_at<=now())::int AS expired
      FROM control.data_search_protocol_leases WHERE tenant_id=$1 AND consumer_id=$2 AND api_key_id=$3 AND platform=$4 AND query_hash=$5`, [...scope, queryHash])).rows[0]
    const ids = [...new Set([...bindings.map(row => row.usage_request_id), ...usages.map(row => row.id)].filter(Boolean))]
    const requests = new Map((await client.query(`SELECT /* admission-scope:requests */ id,status,error_code,reserved_at,completed_at
      FROM usage_requests WHERE id=ANY($1::uuid[])`, [ids])).rows.map(row => [row.id, row]))
    const calls = (await client.query(`SELECT /* admission-scope:calls */ usage_request_id,provider_key,operation,outcome,http_status,error_code,
      round(EXTRACT(EPOCH FROM (completed_at-started_at))*1000)::int AS duration_ms FROM external_platform.provider_calls
      WHERE usage_request_id=ANY($1::uuid[]) ORDER BY usage_request_id,call_ordinal`, [ids])).rows
    const tablePresent = (await client.query("SELECT to_regclass('control.search_admission_dispositions') IS NOT NULL AS present")).rows[0].present === true
    const dispositionAvailable = tablePresent && typeof dispositions?.getSearchAdmissionDispositionIds === 'function' && blocker.platform === 'twitter'
    const disposed = new Set(dispositionAvailable ? await dispositions.getSearchAdmissionDispositionIds(client, ids,
      { tenantId: scope[0], consumerId: scope[1], apiKeyId: scope[2], platform: scope[3], query }) : [])
    const binding = new Map(bindings.filter(row => row.usage_request_id).map(row => [row.usage_request_id, row]))
    const blockers = ids.map(id => {
      const request = requests.get(id), state = binding.get(id)
      const ageMinutes = request?.reserved_at ? Math.round((now - new Date(request.reserved_at).getTime()) / 60000) : null
      const row = { requestId: id, usageStatus: text(request?.status), bindingState: text(state?.state), leaseExpired: state ? state.lease_expired === true : null,
        errorCode: text(request?.error_code), reservedAt: iso(request?.reserved_at), completedAt: iso(request?.completed_at), ageMinutes,
        calls: calls.filter(call => call.usage_request_id === id).map(call => ({ provider: text(call.provider_key), operation: text(call.operation),
          outcome: text(call.outcome), httpStatus: call.http_status ?? null, errorCode: text(call.error_code), durationMs: call.duration_ms ?? null })),
        disposed: disposed.has(id) }
      return { ...row, action: action({ ...row, dispositionAvailable }) }
    }).sort((left, right) => String(left.reservedAt).localeCompare(String(right.reservedAt)))
    return { diagnosticRevision: REVISION, blockerId, readOnlyTransaction: true,
      scope: { platform: text(blocker.platform), queryLength: query.trim().length, queryHashPrefix: createHash('sha256').update(query.trim()).digest('hex').slice(0, 12) },
      disposition: { tablePresent, moduleInstalled: Boolean(dispositions), available: dispositionAvailable },
      blockers, unboundBindings: bindings.filter(row => !row.usage_request_id).length, leases: { total: leases.total, expired: leases.expired },
      summary: { blocking: blockers.filter(row => !row.disposed).length,
        needDisposition: blockers.filter(row => ['dispose_in_diagnostics_center', 'deploy_disposition_then_dispose'].includes(row.action)).length,
        inProgress: blockers.filter(row => row.action === 'wait_in_progress').length,
        stuck: blockers.filter(row => row.action === 'investigate_stuck_reservation').length,
        blockerIdListed: blockers.some(row => row.requestId === blockerId) } }
  } finally { await client.query('ROLLBACK').catch(() => {}); client.release() }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  let pool
  try {
    if (args.length !== 1) throw fail('invalid_arguments')
    if (!UUID.test(args[0])) throw fail('invalid_request_id')
    if (typeof env.DATABASE_URL !== 'string' || !env.DATABASE_URL.trim()) throw fail('database_url_required')
    const { Pool } = await import('pg')
    pool = new Pool({ connectionString: env.DATABASE_URL, max: 1, application_name: REVISION, connectionTimeoutMillis: 5000 })
    process.stdout.write(`${JSON.stringify(await diagnoseAdmissionScope(pool, args[0]), null, 2)}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ diagnosticRevision: REVISION, errorCode: SAFE_CODES.has(error?.diagnosticCode) ? error.diagnosticCode : 'diagnostic_unavailable',
      sqlState: typeof error?.code === 'string' && /^[0-9A-Z]{5}$/u.test(error.code) ? error.code : null })}\n`)
    process.exitCode = 1
  } finally { await pool?.end().catch(() => {}) }
}

const stdinEntry = process.argv[1] === '-' && fileURLToPath(import.meta.url) === `${process.cwd()}/[eval1]`
if (stdinEntry || process.argv[1] && process.argv[1] !== '-' && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
