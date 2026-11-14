import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { diagnoseThreadsTransport, projectThreadsTransportFailure } from '../../server/ops/diagnose-threads-transport.mjs'
import { projectTwitterTransportFailure } from '../../server/ops/diagnose-twitter-outcome.mjs'

const requestId = randomUUID()
const privateValue = 'private-query-url-key-body-exception'
const source = readFileSync(new URL('../../server/ops/diagnose-threads-transport.mjs', import.meta.url), 'utf8')
const transport = { phase: 'request', codes: ['ENOTFOUND'], deadlineExceeded: false, elapsedMs: 100,
  timeoutMs: 30000, message: privateValue, url: privateValue, key: privateValue }

function fixture({ count = 1, hostile = false, missing = false, fail = '' } = {}) {
  const queries = []
  let released = false, releaseError
  const row = { id: randomUUID(), provider_key: 'rapidapi', endpoint_key: 'native.r.threads_scraper_search_posts',
    outcome: 'unknown', http_status: null, billed: null, latency_ms: 101, error_code: 'social_upstream_outcome_unknown',
    archive_present: true, transport_failure: transport, transport_failure_too_large: false }
  if (hostile) for (const key of Object.keys(row)) row[key] = privateValue
  const pool = { connect: async () => ({
    query: async (sql, args) => {
      queries.push({ sql, args })
      assert.match(sql, /^(BEGIN|SET LOCAL|SELECT|ROLLBACK)\b/u)
      assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|COMMIT|TRUNCATE)\b|SELECT \*/u)
      if (fail && sql.includes(fail)) throw new Error(privateValue)
      if (sql.includes('threads-transport:usage')) return { rows: missing ? [] : [{ status: hostile ? privateValue : 'unknown',
        response_status: 502, upstream_latency_ms: null, error_code: row.error_code }] }
      if (sql.includes('threads-transport:calls')) return { rows: Array.from({ length: count }, () => row) }
      return { rows: [] }
    },
    release(error) { released = true; releaseError = error },
  }) }
  return { pool, queries, get released() { return released }, get releaseError() { return releaseError } }
}

test('Threads diagnostic uses exact request scope and preserves unknown HTTP and billing', async () => {
  const db = fixture(), result = await diagnoseThreadsTransport(db.pool, requestId)
  assert.equal(result.status, 'unknown')
  assert.equal(result.httpStatus, 502)
  assert.equal(result.calls[0].endpoint, 'native.r.threads_scraper_search_posts')
  assert.equal(result.calls[0].latencyMs, 101)
  assert.equal(result.calls[0].httpStatus, null)
  assert.equal(result.calls[0].billed, null)
  assert.equal(result.calls[0].archivePresent, true)
  assert.deepEqual(result.calls[0].transportFailure, projectTwitterTransportFailure(transport))
  assert.doesNotMatch(JSON.stringify(result), /private-/u)
  assert.equal(db.queries[0].sql, 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(db.queries.at(-1).sql, 'ROLLBACK')
  assert.equal(db.released, true)
  for (const { sql, args } of db.queries.filter(row => row.sql.startsWith('SELECT'))) {
    assert.deepEqual(args, [requestId])
    assert.match(sql, /(?:usage_request_)?id = \$1::uuid/u)
    assert.match(sql, /platform = 'threads'/u)
    assert.doesNotMatch(sql, /acquisition_request|body_text|body_bytes|response_body|upstream_request_id/u)
  }
})

test('Threads output and transport codes are capped and hostile fields are discarded', async () => {
  const result = await diagnoseThreadsTransport(fixture({ count: 21, hostile: true }).pool, requestId)
  assert.equal(result.calls.length, 20)
  assert.equal(result.callsTruncated, true)
  assert.equal(result.calls[0].provider, 'other')
  assert.equal(result.calls[0].endpoint, 'other')
  assert.equal(result.calls[0].billed, null)
  assert.equal(result.calls[0].transportFailure, null)
  assert.doesNotMatch(JSON.stringify(result), /private-/u)
  for (const value of [null, [], privateValue, transport,
    { phase: privateValue, codes: ['ECONNRESET', privateValue, ...Array(40).fill('ECONNRESET')],
      deadlineExceeded: privateValue, elapsedMs: -1, timeoutMs: privateValue }]) {
    assert.deepEqual(projectThreadsTransportFailure(value), projectTwitterTransportFailure(value))
  }
})

test('validation and read failures expose only fixed errors and always roll back acquired connections', async () => {
  await assert.rejects(diagnoseThreadsTransport({ connect() { assert.fail('must not connect') } }, privateValue),
    { message: 'invalid_request_id' })
  await assert.rejects(diagnoseThreadsTransport({ connect() { throw new Error(privateValue) } }, requestId),
    { message: 'diagnostic_read_failed' })
  for (const options of [{ missing: true }, { fail: 'threads-transport:calls' }, { fail: 'ROLLBACK' }]) {
    const db = fixture(options)
    await assert.rejects(diagnoseThreadsTransport(db.pool, requestId),
      { message: options.missing ? 'request_not_found' : 'diagnostic_read_failed' })
    assert.equal(db.queries.at(-1).sql, 'ROLLBACK')
    assert.equal(db.released, true)
    assert.equal(Boolean(db.releaseError), options.fail === 'ROLLBACK')
  }
})

test('stdin invocation validates before importing pg and emits no free-text errors', () => {
  assert.doesNotMatch(source, /from ['"]\.\.?\/|\bfetch\s*\(/u)
  const env = { ...process.env }
  delete env.DATABASE_URL
  for (const [args, error] of [[[], 'invalid_arguments'], [[privateValue], 'invalid_request_id'],
    [[requestId, ''], 'invalid_arguments'], [[requestId], 'database_url_required']]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-', ...args], { input: source, env, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.deepEqual(JSON.parse(result.stderr), { error })
  }
})

test('the CLI total deadline covers hung connection, query, rollback and pool shutdown', t => {
  const directory = mkdtempSync(join(tmpdir(), 'threads-transport-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const loader = join(directory, 'loader.mjs')
  const mock = `export default { Pool: class {
    on() {}
    async connect() {
      if (process.env.TEST_HANG === 'connect') return new Promise(() => {})
      return { release() {}, async query(sql) {
        if (process.env.TEST_HANG === 'query' || process.env.TEST_HANG === 'rollback' && sql === 'ROLLBACK') return new Promise(() => {})
        return { rows: sql.includes('threads-transport:usage') ? [{ status: 'unknown' }] : [] }
      } }
    }
    async end() { if (process.env.TEST_HANG === 'end') return new Promise(() => {}) }
  } }`
  writeFileSync(loader, `export async function resolve(name, context, next) {
    return name === 'pg' ? { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(mock)}`)}, shortCircuit: true } : next(name, context)
  }`)
  const timer = 'const original = globalThis.setTimeout; globalThis.setTimeout = (fn, ms, ...args) => original(fn, ms === 20000 ? 100 : ms, ...args)'
  for (const phase of ['connect', 'query', 'rollback', 'end']) {
    const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loader,
      '--import', `data:text/javascript,${encodeURIComponent(timer)}`, '--input-type=module', '-', requestId], {
      input: source, encoding: 'utf8', timeout: 3000,
      env: { ...process.env, DATABASE_URL: privateValue, TEST_HANG: phase },
    })
    assert.equal(result.status, 1, phase)
    assert.equal(result.stdout, '', phase)
    assert.deepEqual(JSON.parse(result.stderr), { error: 'diagnostic_timeout' }, phase)
  }
})

test('actual SQL filters other requests and platforms, bounds archives, and remains read-only',
  { skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE }, async t => {
    const { PGlite } = await import(pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE).href)
    const db = new PGlite()
    t.after(() => db.close())
    await db.exec(`CREATE SCHEMA external_platform;
      CREATE TABLE public.usage_requests(id uuid PRIMARY KEY, platform text, status text, response_status int,
        upstream_latency_ms int, error_code text);
      CREATE TABLE external_platform.provider_calls(id uuid PRIMARY KEY, usage_request_id uuid, provider_key text,
        endpoint_key text, outcome text, http_status int, latency_ms int, billed boolean, error_code text, started_at timestamptz);
      CREATE TABLE external_platform.response_archives(id uuid PRIMARY KEY, provider_call_id uuid UNIQUE, raw_payload jsonb);`)
    const other = randomUUID(), wrongPlatform = randomUUID()
    for (const id of [requestId, other, wrongPlatform]) await db.query(
      "INSERT INTO public.usage_requests VALUES($1,$2,'unknown',502,NULL,'upstream_outcome_unknown')",
      [id, id === wrongPlatform ? 'twitter' : 'threads'])
    for (let index = 0; index < 23; index++) {
      const callId = randomUUID(), usage = index < 21 ? requestId : index === 21 ? other : wrongPlatform
      await db.query(`INSERT INTO external_platform.provider_calls VALUES($1,$2,$4,
        'native.r.threads_scraper_search_posts','unknown',NULL,100,NULL,NULL,$3)`,
      [callId, usage, new Date(1000 * index), index === 3 ? 'tikhub' : 'rapidapi'])
      if (index !== 2) await db.query('INSERT INTO external_platform.response_archives VALUES($1,$2,$3)',
        [randomUUID(), callId, { body: privateValue, response: { transportFailure: index === 1
          ? { ...transport, message: privateValue.repeat(300) } : transport } }])
    }
    let readOnly = false, rolledBack = false
    const pool = { connect: async () => ({ release() {}, async query(sql, args) {
      if (sql.includes('threads-transport:calls')) {
        readOnly = (await db.query("SELECT current_setting('transaction_read_only') AS value")).rows[0].value === 'on'
      }
      if (sql === 'ROLLBACK') rolledBack = true
      return db.query(sql, args)
    } }) }
    const report = await diagnoseThreadsTransport(pool, requestId)
    assert.equal(readOnly, true)
    assert.equal(rolledBack, true)
    assert.equal(report.calls.length, 20)
    assert.equal(report.callsTruncated, true)
    assert.equal(report.errorCode, 'upstream_outcome_unknown')
    assert.deepEqual(report.calls[0].transportFailure, projectThreadsTransportFailure(transport))
    assert.equal(report.calls[1].transportFailure, null)
    assert.equal(report.calls[1].transportFailureTooLarge, true)
    assert.equal(report.calls[2].archivePresent, false)
    assert.equal(report.calls[2].transportFailure, null)
    assert.equal(report.calls[2].billed, null)
    assert.equal(report.calls[3].provider, 'tikhub')
    assert.equal(report.calls[3].transportFailure, null)
    assert.doesNotMatch(JSON.stringify(report), /private-/u)
    assert.equal((await diagnoseThreadsTransport(pool, other)).calls.length, 1)
    await assert.rejects(diagnoseThreadsTransport(pool, wrongPlatform), { message: 'request_not_found' })
    assert.equal((await db.query('SELECT count(*)::int AS count FROM external_platform.provider_calls')).rows[0].count, 23)
  })
