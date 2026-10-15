import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { diagnoseTwitterBusy } from '../../server/ops/diagnose-twitter-busy.mjs'

const requestId = '23820161-3f4d-4e2b-886d-b9fc9664c234'
const secret = 'private-keyword-credential-body'
function fixture({ platform = 'twitter', missing = false, fail = '', count = 1, privateValues = false } = {}) {
  const queries = []
  let released = false, releaseError
  const pool = { async connect() { return { async query(sql, params) {
    queries.push({ sql, params })
    assert.match(sql, /^(BEGIN|SET LOCAL|SELECT|WITH|ROLLBACK)\b/u)
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|COMMIT)\b/u)
    if (fail && sql.includes(fail)) throw new Error(secret)
    const row = { id: randomUUID(), usage_request_id: requestId, provider_key: 'rapidapi', operation: 'social.content.search',
      outcome: 'succeeded', http_status: 200, started_at: new Date('2026-10-15T01:00:00Z'), completed_at: new Date('2026-10-15T01:00:02Z'),
      reserved_at: new Date('2026-10-15T01:00:01Z'), database_now: new Date('2026-10-15T01:00:03Z'), status: 'released',
      error_code: 'external_platform_pre_dispatch_failed', response_status: null, request_path: '/api/v1/data/search',
      same_tenant: true, same_consumer: true, same_api_key: false, overlaps_target_window: true,
      source_mode: 'unavailable', provider_call_id: null, created_at: new Date(), raw_body: secret }
    if (privateValues) for (const key of Object.keys(row)) row[key] = secret
    if (sql.includes('twitter-busy:usage')) return { rows: missing ? [] : [{ ...row, platform }] }
    if (/twitter-busy:(gateways|own-calls|nearby)/u.test(sql)) return { rows: Array.from({ length: count }, () => row) }
    return { rows: [] }
  }, release(error) { released = true; releaseError = error } } } }
  return { pool, queries, get released() { return released }, get releaseError() { return releaseError } }
}

test('Twitter busy diagnostic reads exact usage and own calls, bounded nearby candidates, and always rolls back', async () => {
  const db = fixture()
  const result = await diagnoseTwitterBusy(db.pool, requestId)
  assert.equal(result.errorCode, 'external_platform_pre_dispatch_failed', 'historical generic release is not relabeled busy')
  assert.equal(result.requestPath, '/api/v1/data/search')
  assert.equal(result.savedHttpStatus, null)
  assert.equal(result.ownCalls.length, 1)
  assert.equal(result.nearbyCalls[0].sameConsumer, true)
  assert.equal(result.nearbyCalls[0].sameApiKey, false)
  assert.equal(result.concurrencyEvidence, 'historical_process_counters_and_gateway_instance_not_recorded')
  assert.equal(db.queries[0].sql, 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(db.queries.at(-1).sql, 'ROLLBACK')
  assert.equal(db.released, true)
  for (const query of db.queries.filter(row => row.sql.includes('twitter-busy:'))) {
    assert.deepEqual(query.params, [requestId])
    assert.match(query.sql, /(?:usage_request_)?id = \$1::uuid/u)
    assert.doesNotMatch(query.sql, /response_body|body_bytes|parsed_payload/u)
  }
  const nearby = db.queries.find(row => row.sql.includes('twitter-busy:nearby')).sql
  assert.match(nearby, /p.provider_key = 'rapidapi'/u)
  assert.match(nearby, /INTERVAL '5 minutes'/u)
  assert.match(nearby, /LIMIT 101/u)
  assert.doesNotMatch(JSON.stringify(result), /private-|raw_body|acquisition_request/u)
})

test('Twitter diagnostic bounds all lists and suppresses arbitrary values', async () => {
  const result = await diagnoseTwitterBusy(fixture({ count: 101, privateValues: true }).pool, requestId)
  for (const key of ['gateways', 'ownCalls', 'nearbyCalls']) {
    assert.equal(result[key].length, 100)
    assert.equal(result[`${key}Truncated`], true)
  }
  assert.equal(result.status, 'other')
  assert.equal(result.requestPath, 'other')
  assert.equal(result.nearbyCalls[0].sameConsumer, null)
  assert.equal(result.ownCalls[0].callId, null)
  assert.doesNotMatch(JSON.stringify(result), /private-/u)
})

test('invalid, missing, other-platform and database failures stop safely without raw error disclosure', async () => {
  await assert.rejects(diagnoseTwitterBusy({ connect() { assert.fail('must not connect') } }, secret), { message: 'invalid_request_id' })
  for (const [options, message] of [[{ missing: true }, 'request_not_found'], [{ platform: 'facebook' }, 'request_not_twitter'],
    [{ fail: 'twitter-busy:nearby' }, 'diagnostic_read_failed'], [{ fail: 'ROLLBACK' }, 'diagnostic_read_failed']]) {
    const db = fixture(options)
    await assert.rejects(diagnoseTwitterBusy(db.pool, requestId), { message })
    assert.equal(db.queries.at(-1).sql, 'ROLLBACK')
    assert.equal(db.released, true)
    assert.equal(Boolean(db.releaseError), options.fail === 'ROLLBACK')
  }
})

test('Twitter diagnostic standalone stdin validates arguments without runtime or database dependencies', () => {
  const source = readFileSync(new URL('../../server/ops/diagnose-twitter-busy.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /from ['"]\.\.?\/|\bfetch\s*\(/u)
  const env = { ...process.env }
  delete env.DATABASE_URL
  for (const [args, expected] of [[[requestId], 'database_url_required'], [[secret], 'invalid_request_id'], [[requestId, secret], 'invalid_arguments']]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-', ...args], { input: source, env, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.deepEqual(JSON.parse(result.stderr), { error: expected })
  }
})

test('Twitter busy diagnostic executes its actual SQL read-only against PostgreSQL', { skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE }, async t => {
  const { PGlite } = await import(pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`CREATE SCHEMA external_platform;
    CREATE TABLE usage_requests(id uuid PRIMARY KEY, platform text, status text, error_code text, response_status int,
      reserved_at timestamptz, completed_at timestamptz, acquisition_request jsonb, tenant_id uuid, consumer_id uuid, api_key_id uuid);
    CREATE TABLE external_platform.gateway_requests(id uuid PRIMARY KEY, usage_request_id uuid, source_mode text,
      response_status int, error_code text, provider_call_id uuid, created_at timestamptz);
    CREATE TABLE external_platform.provider_calls(id uuid PRIMARY KEY, usage_request_id uuid, provider_key text,
      operation text, outcome text, http_status int, error_code text, started_at timestamptz, completed_at timestamptz,
      tenant_id uuid, consumer_id uuid, api_key_id uuid);`)
  const tenant = randomUUID(), consumer = randomUUID(), key = randomUUID(), other = randomUUID(), call = randomUUID()
  const insertUsage = id => db.query(`INSERT INTO usage_requests VALUES($1,'twitter','released','external_platform_pre_dispatch_failed',NULL,
    '2026-10-15T01:00:01Z','2026-10-15T01:00:01.010Z',$2,$3,$4,$5)`, [id, JSON.stringify({ path: '/api/v1/data/search', body: secret }), tenant, consumer, key])
  await insertUsage(requestId)
  await insertUsage(other)
  await db.query(`INSERT INTO external_platform.provider_calls VALUES($1,$2,'rapidapi','social.content.search','pending',NULL,NULL,
    '2026-10-15T01:00:00Z',NULL,$3,$4,$5)`, [call, other, tenant, consumer, key])
  const pool = { connect: async () => ({ query: (sql, params) => db.query(sql, params), release() {} }) }
  const result = await diagnoseTwitterBusy(pool, requestId)
  assert.equal(result.ownCalls.length, 0)
  assert.equal(result.gateways.length, 0, 'old assembly busy may have no gateway record')
  assert.equal(result.nearbyCalls[0].callId, call)
  assert.equal(result.nearbyCalls[0].overlapsTargetWindow, true)
  assert.equal(result.nearbyCalls[0].sameConsumer, true)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM usage_requests')).rows[0].n, 2)
  assert.doesNotMatch(JSON.stringify(result), /private-/u)
})
