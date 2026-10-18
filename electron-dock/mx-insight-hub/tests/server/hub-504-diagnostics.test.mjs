import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { INCIDENT_IDS, SAMPLE_IDS, diagnoseHub504, hub504Runtime, filterHub504Logs } from '../../server/ops/diagnose-hub-504.mjs'

const secret = 'PRIVATE_QUERY_CURSOR_TOKEN_SQL_BODY'
const sourcePath = new URL('../../server/ops/diagnose-hub-504.mjs', import.meta.url)
const start = '2026-10-18T14:12:41.857Z', end = '2026-10-18T14:15:16.578Z'
function fixture({ missingSchema = false, privateValues = false, fail, rollbackFail = false, many = false } = {}) {
  const queries = [], releaseErrors = []
  const row = { id: SAMPLE_IDS[0], usage_request_id: SAMPLE_IDS[0], platform: 'twitter', status: 'released',
    error_code: 'external_platform_pre_dispatch_failed', response_status: null, reserved_at: start, completed_at: end,
    upstream_latency_ms: 1689, outcome: 'unknown', http_status: null, billed: null, item_count: 0, latency_ms: 1689,
    started_at: start, source_mode: 'unavailable', succeeded: false, provider_call_id: randomUUID(), created_at: end,
    raw_body: secret, request_body: secret, code: secret }
  const db = { database_now: end, database_started_at: start, max_connections: 100, all_sessions_visible: false,
    numbackends: 8, deadlocks: '4', conflicts: '0', stats_reset: start, query: secret }
  const con = { state: 'idle in transaction', wait_event_type: 'Lock', count: 3, pid: 12, blocking_pids: [0, 24],
    transaction_age_ms: 155001, query_age_ms: 33, query: secret, usename: secret }
  if (privateValues) for (const obj of [row, db, con]) for (const key of Object.keys(obj)) obj[key] = secret
  const usage = INCIDENT_IDS.map((id, i) => ({ ...row, id, status: privateValues ? secret : i < 21 ? 'released' : i < 49 ? 'committed' : 'unknown',
    error_code: privateValues ? secret : i < 21 ? 'external_platform_pre_dispatch_failed' : i < 49 ? null : 'external_platform_persistence_unknown' }))
  const pool = { async connect() { return { async query(sql, params) {
    queries.push({ sql, params })
    assert.match(sql, /^(BEGIN|SET LOCAL|SELECT|ROLLBACK)\b/u)
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|COMMIT)\b/u)
    if (fail && sql.includes(fail) || rollbackFail && sql === 'ROLLBACK') throw Object.assign(new TypeError(secret), { code: '55P03', detail: secret, query: secret })
    if (sql.includes('hub-504:schema')) return { rows: [{ usage: !missingSchema, calls: !missingSchema, gateways: !missingSchema }] }
    if (sql.includes('hub-504:usage')) return { rows: usage }
    if (/hub-504:(calls|gateways)/u.test(sql)) return { rows: Array.from({ length: many ? 101 : 1 }, () => row) }
    if (sql.includes('hub-504:database')) return { rows: [db] }
    if (/hub-504:(connections|blocking)/u.test(sql)) return { rows: Array.from({ length: many ? 101 : 1 }, () => con) }
    return { rows: [] }
  }, release(error) { releaseErrors.push(error) } } } }
  return { pool, queries, releaseErrors }
}

test('fixed incident set preserves all three ledger states and restricts every business query to primary identities', async () => {
  assert.equal(INCIDENT_IDS.length, 56); assert.equal(new Set(INCIDENT_IDS).size, 56)
  assert.equal(SAMPLE_IDS.length, 4)
  const db = fixture(), result = await diagnoseHub504(db.pool)
  assert.deepEqual(result.batch.groups.map(row => [row.status, row.count]), [['released', 21], ['committed', 28], ['unknown', 7]])
  assert.equal(result.batch.found, 56)
  assert.equal(result.samples[0].usage.elapsedMs, 154721)
  assert.equal(result.samples[0].providerCalls[0].billed, null)
  assert.equal(result.samples[0].usage.savedHttpStatus, null, 'never invent original HTTP from the 504')
  assert.equal(result.currentDatabase.deadlocks, 4)
  assert.equal(result.currentDatabase.allSessionsVisible, false)
  assert.deepEqual(result.currentDatabase.blocking[0].blockingPids, [0, 24], 'zero may be prepared transaction')
  assert.match(result.evidenceLimits.historicalSqlStateAndPhase, /not_retained/u)
  assert.equal(db.queries[0].sql, 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(db.queries.at(-1).sql, 'ROLLBACK'); assert.deepEqual(db.releaseErrors, [undefined])
  for (const { sql, params } of db.queries.filter(row => /hub-504:(usage|calls|gateways)/u.test(row.sql))) {
    assert.match(sql, /WHERE (?:usage_request_)?id = ANY\(\$1::uuid\[\]\)/u)
    assert.deepEqual(params, [sql.includes('hub-504:usage') ? INCIDENT_IDS : SAMPLE_IDS])
  }
  assert.doesNotMatch(db.queries.map(row => row.sql).join('\n'), /response_body|raw_payload|body_bytes|acquisition_request|SELECT \*/u)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret, 'u'))
})

test('old schemas explicitly report unavailable evidence, with no failed relation query or history scan', async () => {
  const db = fixture({ missingSchema: true }), result = await diagnoseHub504(db.pool)
  assert.equal(result.batch.found, 0); assert.equal(result.batch.missingRequestIds.length, 56)
  assert.deepEqual(result.schema, { usage: false, calls: false, gateways: false })
  assert.ok(result.samples.every(row => row.usage === null))
  assert.ok(db.queries.every(row => !/FROM (public.usage_requests|external_platform\.)/u.test(row.sql)))
})

test('arbitrary database strings cannot disclose business/credentials through any projected field', async () => {
  const result = await diagnoseHub504(fixture({ privateValues: true, many: true }).pool)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret, 'u'))
  assert.equal(result.samples[0].usage.platform, 'other')
  assert.equal(result.currentDatabase.deadlocks, null)
  assert.equal(result.evidenceLimits.callsTruncated, true)
  assert.equal(result.currentDatabase.blockingTruncated, true)
  assert.equal(result.currentDatabase.blocking.length, 100)
})

test('query and rollback failures expose only allowlisted SQLSTATE/class and always release', async () => {
  for (const options of [{ fail: 'hub-504:calls' }, { rollbackFail: true }, { fail: 'hub-504:usage', rollbackFail: true }]) {
    const db = fixture(options)
    await assert.rejects(diagnoseHub504(db.pool), error => {
      assert.equal(error.message, 'diagnostic_read_failed')
      assert.deepEqual(error.diagnostic, { error: 'diagnostic_read_failed', sqlState: '55P03', errorClass: 'TypeError' })
      assert.doesNotMatch(JSON.stringify(error), new RegExp(secret, 'u')); return true
    })
    assert.equal(db.queries.at(-1).sql, 'ROLLBACK')
    assert.equal(db.releaseErrors.length, 1)
    assert.equal(Boolean(db.releaseErrors[0]), Boolean(options.rollbackFail))
  }
})

test('container inventory hashes source without imports and only projects allowlisted integer pool variables', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-504-runtime-'))
  try {
    mkdirSync(join(dir, 'server')); writeFileSync(join(dir, 'server/index.mjs'), `throw new Error('${secret}')`)
    const result = hub504Runtime({ root: dir, env: { DATABASE_URL: secret, MX_INSIGHT_LISTENER_MODE: secret,
      MX_COMMON_POSTGRES_MAX_CONNECTIONS: '10', MX_COMMON_POSTGRES_STATEMENT_TIMEOUT_MS: secret } })
    assert.equal(result.installedSources[0].sha256, createHash('sha256').update(`throw new Error('${secret}')`).digest('hex'))
    assert.equal(result.configuredCommonPool.MX_COMMON_POSTGRES_MAX_CONNECTIONS, 10)
    assert.equal(result.configuredCommonPool.MX_COMMON_POSTGRES_STATEMENT_TIMEOUT_MS, null)
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret, 'u'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('original log filtering extracts multiline phase/SQLSTATE and crash metadata without arbitrary lines or messages', async () => {
  const logs = [
    '2026-10-18T14:15:00.000Z {', `2026-10-18T14:15:00.000Z   requestId: '${SAMPLE_IDS[1]}',`,
    "2026-10-18T14:15:00.000Z   phase: 'commit_delivery',", "2026-10-18T14:15:00.000Z   errorClass: 'Error',",
    "2026-10-18T14:15:00.000Z   sqlState: '55P03'", `2026-10-18T14:15:00.000Z } ${secret}`,
    JSON.stringify({ requestId: SAMPLE_IDS[2], phase: 'stage_evidence', err: { name: 'TypeError', code: '23505', message: secret, query: secret } }),
    `2026-10-18T16:08:31.000Z Error: ${secret}`, "2026-10-18T16:08:31.001Z   code: '57P01',",
    `2026-10-18T16:08:31.001Z   detail: '${secret}',`, `2026-10-18T16:08:31.001Z at ${secret}`,
    JSON.stringify({ event: 'hub_postgres_idle_connection_error', sqlState: '08006', message: secret }),
    "2026-10-18T16:08:32.000Z { event: 'hub_postgres_idle_connection_error', sqlState: '57P01' }",
    JSON.stringify({ event: 'twitter_search_outcome_unknown', requestId: 'fd83c26c-7804-4243-a321-5614bc593282',
      phase: 'finish_step', errorClass: 'RapidApiUpstreamError', sqlState: '23505', message: secret }),
    JSON.stringify({ requestId: secret, phase: secret, code: secret, errorClass: secret, env: secret }),
  ].join('\n')
  const result = []
  await filterHub504Logs(Readable.from([...logs].map(char => char)), row => result.push(row))
  assert.equal(result[0].phase, 'commit_delivery'); assert.equal(result[0].sqlState, '55P03')
  assert.equal(result[0].requestId, SAMPLE_IDS[1]); assert.equal(result[1].sqlState, '23505')
  assert.equal(result[2].timestamp, '2026-10-18T16:08:31.000Z')
  assert.equal(result[2].requestId, null, 'later crash is not attributed to incident request')
  assert.equal(result[3].sqlState, '57P01')
  assert.equal(result[4].event, 'hub_postgres_idle_connection_error')
  assert.equal(result[5].sqlState, '57P01')
  assert.equal(result[6].phase, 'finish_step')
  assert.equal(result[6].attribution, 'runtime_request_not_original_incident')
  assert.equal(result.at(-1).emitted, 7)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret, 'u'))
})

test('log filtering bounds oversized lines and output, keeping null evidence explicit', async () => {
  const result = []
  await filterHub504Logs(Readable.from([`${secret.repeat(4000)}\n`, ...Array(502).fill('Error: private\n')]), row => result.push(row))
  assert.equal(result.length, 501); assert.equal(result.at(-1).truncated, true)
  assert.equal(result.at(-1).discardedLongLines, 1)
  assert.ok(result.slice(0, -1).every(row => row.sqlState === null))
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|private/u)
})

test('standalone stdin validates before pg import; local --logs runs without DATABASE_URL', () => {
  const source = readFileSync(sourcePath, 'utf8'), env = { ...process.env }
  delete env.DATABASE_URL
  assert.doesNotMatch(source, /from ['"]\.\.?\/|\bfetch\s*\(/u)
  for (const [args, expected] of [[[], 'database_url_required'], [[secret], 'invalid_arguments'], [['--logs'], 'invalid_arguments']]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-', ...args], { input: source, env, encoding: 'utf8' })
    assert.equal(result.status, 1); assert.equal(result.stdout, '')
    assert.deepEqual(JSON.parse(result.stderr), { error: expected })
  }
  const result = spawnSync(process.execPath, [sourcePath.pathname, '--logs'], { input: `Error: ${secret}\n`, env, encoding: 'utf8' })
  assert.equal(result.status, 0); assert.equal(result.stderr, ''); assert.doesNotMatch(result.stdout, new RegExp(secret, 'u'))
})

test('actual PostgreSQL queries including system views retain exact scope and read-only transaction', { skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE }, async t => {
  const { PGlite } = await import(pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE).href)
  const db = new PGlite(); t.after(() => db.close())
  await db.exec(`CREATE SCHEMA external_platform;
    CREATE TABLE usage_requests(id uuid PRIMARY KEY, platform text, status text, error_code text, response_status int,
      reserved_at timestamptz, completed_at timestamptz, upstream_latency_ms int);
    CREATE TABLE external_platform.provider_calls(id uuid PRIMARY KEY, usage_request_id uuid, outcome text,
      http_status int, billed boolean, item_count int, latency_ms int, error_code text, started_at timestamptz, completed_at timestamptz);
    CREATE TABLE external_platform.gateway_requests(id uuid PRIMARY KEY, usage_request_id uuid, provider_call_id uuid,
      source_mode text, succeeded boolean, response_status int, error_code text, created_at timestamptz);`)
  await db.query("INSERT INTO usage_requests VALUES ($1,'twitter','unknown','external_platform_persistence_unknown',NULL,$2,$3,1689)", [SAMPLE_IDS[2], start, end])
  await db.query("INSERT INTO usage_requests VALUES ($1,'twitter','committed',NULL,200,$2,$3,1)", [randomUUID(), start, end])
  const pool = { connect: async () => ({ query: async (sql, params) => {
    // System views exist but PGlite has no concurrent live backends to block.
    return db.query(sql, params)
  }, release() {} }) }
  const result = await diagnoseHub504(pool)
  assert.equal(result.batch.found, 1); assert.equal(result.batch.groups[0].status, 'unknown')
  assert.equal(result.samples[2].usage.elapsedMs, 154721)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM usage_requests')).rows[0].n, 2)
  assert.equal(result.currentDatabase.maxConnections, 100)
  assert.equal(result.currentDatabase.statsReset, null)
})
