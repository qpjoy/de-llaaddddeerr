import { pathToFileURL } from 'node:url'

// Standalone stdin diagnostic for unified ecommerce product search: the saved
// supplier routes, each supplier's breaker and operation state, and what the
// suppliers answered in a recent window (outcome, HTTP, business and error
// code, billed). Answers "is JustOne out of balance / is the backup working"
// from the call ledger. Read-only; no credentials, bodies, queries or upstream
// calls; unrecognised stored values print as "other".
const OPERATION = 'ecommerce.products.search'
const PROVIDERS = new Set(['justone', 'rapidapi'])
const MARKETS = new Set(['taobao', 'tmall', 'jd', 'xianyu', 'xiaohongshu_ec', 'douyin_ec'])
const OUTCOMES = new Set(['pending', 'succeeded', 'rejected', 'unknown', 'succeeded_unusable'])
const STATES = new Set(['disabled', 'shadow', 'canary', 'active', 'paused'])
const MODES = new Set(['fixed', 'priority'])
const ADAPTER = /^(?:justone|rapidapi):[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u
const CODE = /^(?:upstream|invalid_upstream|invalid|external_platform|ecommerce|request|missing|cursor|unsupported)_[a-z0-9_]{2,60}$/u
const FAILURES = new Set(['invalid_arguments', 'database_url_required'])
const MAX_HOURS = 168
const allowed = (value, choices) => value == null ? null : choices.has(value) ? value : 'other'
const code = value => value == null ? null : typeof value === 'string' && CODE.test(value) ? value : 'other'
const adapter = value => value == null ? null : typeof value === 'string' && ADAPTER.test(value) ? value : 'other'
const integer = value => Number.isSafeInteger(Number(value)) && value !== null ? Number(value) : null
const http = value => Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : null
const bool = value => typeof value === 'boolean' ? value : null
const time = value => {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null
}
const failure = error => new Error(FAILURES.has(error?.message) ? error.message
  : ['42P01', '42703'].includes(error?.code) ? 'diagnostic_schema_unavailable' : 'diagnostic_read_failed')
const circuit = row => ({ provider: allowed(row.provider_key, PROVIDERS), scope: allowed(row.scope ?? null, MARKETS),
  openNow: bool(row.open_now), consecutiveFailures: integer(row.consecutive_failures), circuitOpenUntil: time(row.circuit_open_until),
  lastFailureAt: time(row.last_failure_at), lastErrorCode: code(row.last_error_code), lastSuccessAt: time(row.last_success_at ?? null) })

export async function diagnoseEcommerceSearch(pool, hours = 24) {
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > MAX_HOURS) throw new Error('invalid_arguments')
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'")
    const { rows: [meta] } = await client.query(`SELECT /* ecommerce-search:meta */ transaction_timestamp() AS observed_at,
      to_regclass('control.ecommerce_product_routes') IS NOT NULL AS has_routes,
      to_regclass('external_platform.provider_contract_circuits') IS NOT NULL AS has_contract_circuits`)
    // to_jsonb keeps this readable before and after the supplier-mode migration.
    const routes = meta.has_routes ? (await client.query(`SELECT /* ecommerce-search:routes */ to_jsonb(r) AS route
      FROM control.ecommerce_product_routes r ORDER BY marketplace`)).rows.map(row => row.route) : []
    const { rows: states } = await client.query(`SELECT /* ecommerce-search:states */
      provider_key, consecutive_failures, circuit_open_until, last_failure_at, last_error_code, last_success_at,
      COALESCE(circuit_open_until > transaction_timestamp(), false) AS open_now
      FROM external_platform.provider_state WHERE provider_key = 'justone' ORDER BY provider_key`)
    const contracts = meta.has_contract_circuits ? (await client.query(`SELECT /* ecommerce-search:contracts */
      provider_key, scope, consecutive_failures, circuit_open_until, last_failure_at, last_error_code,
      COALESCE(circuit_open_until > transaction_timestamp(), false) AS open_now
      FROM external_platform.provider_contract_circuits
      WHERE provider_key = ANY($1::text[]) AND scope = ANY($2::text[]) ORDER BY provider_key, scope`,
    [[...PROVIDERS], [...MARKETS]])).rows : []
    const { rows: controls } = await client.query(`SELECT /* ecommerce-search:controls */ provider_key, desired_state, revision, updated_at
      FROM control.external_platform_operation_policies WHERE operation_key = $1 AND provider_key = ANY($2::text[])
      ORDER BY provider_key`, [OPERATION, [...PROVIDERS]])
    const { rows: calls } = await client.query(`SELECT /* ecommerce-search:calls */
      provider_key, marketplace, outcome, http_status, business_code, error_code, billed,
      count(*)::int AS calls, max(started_at) AS last_started_at
      FROM external_platform.provider_calls
      WHERE operation = $1 AND started_at >= transaction_timestamp() - make_interval(hours => $2)
      GROUP BY 1, 2, 3, 4, 5, 6, 7 ORDER BY max(started_at) DESC LIMIT 60`, [OPERATION, hours])
    const { rows: [lastSuccess] } = await client.query(`SELECT /* ecommerce-search:last-success */
      max(started_at) FILTER (WHERE provider_key = 'justone') AS justone, max(started_at) FILTER (WHERE provider_key = 'rapidapi') AS rapidapi
      FROM external_platform.provider_calls WHERE operation = $1 AND outcome = 'succeeded'`, [OPERATION])
    return { diagnosticRevision: 'ecommerce-search-diagnostic.v1', readOnly: true, windowHours: hours, observedAt: time(meta.observed_at),
      routes: routes.map(row => ({ marketplace: allowed(row.marketplace, MARKETS), mode: allowed(row.mode ?? 'fixed', MODES),
        primary: adapter(row.adapter_id), fallback: adapter(row.fallback_adapter_id ?? null), revision: integer(row.revision),
        updatedAt: time(row.updated_at) })),
      supplierModeInstalled: routes.length ? Object.hasOwn(routes[0], 'mode') : null,
      justoneCircuit: states.map(circuit)[0] ?? null,
      marketplaceCircuits: contracts.map(circuit),
      operationControls: controls.map(row => ({ provider: allowed(row.provider_key, PROVIDERS),
        desiredState: allowed(row.desired_state, STATES), revision: integer(row.revision), updatedAt: time(row.updated_at) })),
      lastSuccessfulCall: { justone: time(lastSuccess?.justone ?? null), rapidapi: time(lastSuccess?.rapidapi ?? null) },
      recentCalls: calls.map(row => ({ provider: allowed(row.provider_key, PROVIDERS), marketplace: allowed(row.marketplace, MARKETS),
        outcome: allowed(row.outcome, OUTCOMES), httpStatus: http(row.http_status), businessCode: integer(row.business_code),
        errorCode: code(row.error_code), billed: bool(row.billed), calls: integer(row.calls), lastStartedAt: time(row.last_started_at) })),
      recentCallsTruncated: calls.length >= 60,
      howToRead: 'businessCode 601 / errorCode upstream_balance_exhausted on justone means the JustOne account has no balance; 100/600 credential or permission; 302/303 rate or daily quota. rapidapi 401/403 means the RapidAPI key is invalid or not subscribed to the Taobao/Tmall listing; 429 its plan limit.' }
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
    const [value, extra] = process.argv.slice(2)
    const hours = value === undefined ? 24 : /^\d{1,3}$/u.test(value) ? Number(value) : NaN
    if (extra || !Number.isSafeInteger(hours)) throw new Error('invalid_arguments')
    if (!process.env.DATABASE_URL) throw new Error('database_url_required')
    const { default: pg } = await import('pg')
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, query_timeout: 6000 })
    console.log(JSON.stringify(await diagnoseEcommerceSearch(pool, hours), null, 2))
  } catch (error) {
    console.error(JSON.stringify({ error: error?.message === 'diagnostic_schema_unavailable' ? error.message : failure(error).message }))
    process.exitCode = 1
  } finally { await pool?.end() }
}
