import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { diagnoseTwitterOutcome, projectTwitterTransportFailure, twitterOutcomeRuntime } from '../../server/ops/diagnose-twitter-outcome.mjs'

const requestId = 'ced3bb03-709d-438b-8d80-4deada7f8476'
const secret = 'private-query-token-proxy-url-body'
const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const source = readFileSync(new URL('../../server/ops/diagnose-twitter-outcome.mjs', import.meta.url), 'utf8')
const transport = { phase: 'request', codes: ['UND_ERR_CONNECT_TIMEOUT', '42P01'], deadlineExceeded: false,
  elapsedMs: 10003, timeoutMs: 30000, message: secret, url: secret, stack: secret }

function fixture({ missing = false, platform = 'twitter', path = '/api/v1/data/search', hostile = false, count = 1, fail = '' } = {}) {
  const queries = []
  let released = false, releaseError
  const row = { id: randomUUID(), provider_key: 'rapidapi', operation: 'social.content.search', endpoint_key: 'twitter-aio.search',
    endpoint_version: 'twitter-aio.hub.v1', contract_version: 'mx-insight-hub.social-data.v1', outcome: 'unknown',
    error_code: 'social_upstream_response_unusable', http_status: null, billed: null, item_count: 0, latency_ms: 10005,
    started_at: new Date('2026-10-15T09:31:28Z'), completed_at: new Date('2026-10-15T09:31:38Z'),
    operational_archive_present: true, contract_state: 'unknown', archive_body_size: null, archive_sha256: null,
    restricted_archive_present: false, transport_failure: transport, raw_payload: secret, upstream_request_id: secret }
  if (hostile) for (const key of Object.keys(row)) row[key] = secret
  const pool = { connect: async () => ({ query: async (sql, params) => {
    queries.push({ sql, params })
    assert.match(sql, /^(BEGIN|SET LOCAL|SELECT|ROLLBACK)\b/u)
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|COMMIT|TRUNCATE)\b/u)
    if (fail && sql.includes(fail)) throw new Error(secret)
    if (sql.includes('twitter-outcome:usage')) return { rows: missing ? [] : [{ platform, request_path: path,
      status: hostile ? secret : 'unknown', error_code: hostile ? secret : 'social_upstream_outcome_unknown',
      response_status: 502, reserved_at: new Date('2026-10-15T09:31:27Z'), completed_at: row.completed_at,
      database_now: new Date('2026-10-15T10:00:00Z') }] }
    if (sql.includes('twitter-outcome:')) return { rows: Array.from({ length: count }, () => row) }
    return { rows: [] }
  }, release: error => { released = true; releaseError = error } }) }
  return { pool, queries, get released() { return released }, get releaseError() { return releaseError } }
}

test('Twitter unknown diagnostic reports only supplied request metadata with preserved null billing and bounded transport evidence', async () => {
  const db = fixture(), result = await diagnoseTwitterOutcome(db.pool, requestId)
  assert.equal(result.errorCode, 'social_upstream_outcome_unknown')
  assert.equal(result.savedHttpStatus, 502)
  assert.equal(result.ownCalls[0].errorCode, 'social_upstream_response_unusable')
  assert.equal(result.ownCalls[0].billed, null)
  assert.equal(result.ownCalls[0].httpStatus, null)
  assert.equal(result.ownCalls[0].latencyMs, 10005)
  assert.equal(result.ownCalls[0].restrictedArchive.present, false)
  assert.equal(result.ownCalls[0].restrictedArchive.integrity, 'metadata_only_not_verified')
  assert.deepEqual(result.ownCalls[0].operationalArchive.transportFailure.codes, ['UND_ERR_CONNECT_TIMEOUT', '42P01'])
  assert.equal(result.ownCalls[0].operationalArchive.transportFailure.deadlineExceeded, false)
  assert.doesNotMatch(JSON.stringify(result), /private-|raw_payload|upstream_request_id/u)
  assert.equal(db.queries[0].sql, 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(db.queries.at(-1).sql, 'ROLLBACK')
  assert.equal(db.released, true)
  for (const query of db.queries.filter(row => row.sql.includes('twitter-outcome:'))) {
    assert.deepEqual(query.params, [requestId])
    assert.match(query.sql, /(?:usage_request_)?id = \$1::uuid/u)
    assert.doesNotMatch(query.sql, /body_bytes|body_text|parsed_payload|response_body|SELECT \*/u)
  }
})

test('historical missing archives stay unknown, lists are capped, and hostile fields do not leave report', async () => {
  const result = await diagnoseTwitterOutcome(fixture({ hostile: true, count: 21 }).pool, requestId)
  assert.equal(result.ownCalls.length, 20); assert.equal(result.gateways.length, 20)
  assert.equal(result.ownCallsTruncated, true); assert.equal(result.gatewaysTruncated, true)
  assert.equal(result.status, 'other')
  assert.equal(result.ownCalls[0].callId, null)
  assert.equal(result.ownCalls[0].billed, null)
  assert.equal(result.ownCalls[0].operationalArchive.transportFailure, null)
  assert.doesNotMatch(JSON.stringify(result), /private-/u)
  const malformed = projectTwitterTransportFailure({ phase: secret, codes: ['ECONNRESET', secret, 'ECONNRESET', ...Array(40).fill(secret)],
    deadlineExceeded: secret, elapsedMs: -1, timeoutMs: secret, message: secret })
  assert.deepEqual(malformed, { phase: 'other', codes: ['ECONNRESET'], unrecognizedCodes: true,
    codesTruncated: true, deadlineExceeded: null, elapsedMs: null, timeoutMs: null })
  assert.equal(projectTwitterTransportFailure(null), null)
  assert.equal(projectTwitterTransportFailure([]), null)
})

test('wrong request scope and database failures stop safely and discard failed rollback connections', async () => {
  await assert.rejects(diagnoseTwitterOutcome({ connect() { assert.fail('must not connect') } }, secret), /invalid_request_id/u)
  for (const [options, message] of [[{ missing: true }, 'request_not_found'], [{ platform: 'facebook' }, 'request_not_twitter_search'],
    [{ path: '/api/v1/data/social/crawl' }, 'request_not_twitter_search'], [{ fail: 'twitter-outcome:calls' }, 'diagnostic_read_failed'],
    [{ fail: 'ROLLBACK' }, 'diagnostic_read_failed']]) {
    const db = fixture(options)
    await assert.rejects(diagnoseTwitterOutcome(db.pool, requestId), { message })
    assert.equal(db.queries.at(-1).sql, 'ROLLBACK'); assert.equal(db.released, true)
    assert.equal(Boolean(db.releaseError), options.fail === 'ROLLBACK')
  }
  for (const path of ['/api/v1/search/raw', '/api/v1/night-all/search/raw', '/api/v1/data/social/search']) {
    assert.equal((await diagnoseTwitterOutcome(fixture({ path }).pool, requestId)).requestPath, path)
  }
})

test('standalone stdin validates before loading pg or touching runtime and emits only fixed errors', () => {
  assert.doesNotMatch(source, /from ['"]\.\.?\/|\bfetch\s*\(/u)
  const env = { ...process.env }; delete env.DATABASE_URL
  for (const [args, error] of [[[], 'invalid_arguments'], [[secret], 'invalid_request_id'], [[requestId], 'database_url_required'],
    [[requestId, secret], 'invalid_arguments']]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-', ...args], { input: source, env, encoding: 'utf8' })
    assert.equal(result.status, 1); assert.equal(result.stdout, '')
    assert.deepEqual(JSON.parse(result.stderr), { error })
  }
})

test('runtime fingerprint reads only fixed source files and emits hashes rather than content', () => {
  const runtime = twitterOutcomeRuntime()
  assert.equal(runtime.nodeVersion, process.version)
  assert.equal(runtime.scope, 'diagnostic_container_only_not_public_serving_version')
  assert.equal(runtime.installedSources.length, 2)
  for (const item of runtime.installedSources) {
    assert.equal(item.state, 'hashed')
    const bytes = readFileSync(new URL(`../../${item.file}`, import.meta.url))
    assert.equal(item.sha256, createHash('sha256').update(bytes).digest('hex'))
  }
})

test('diagnostic actual SQL reads real archive schemas in a read-only transaction and cannot mix another request', { skip: !modulePath }, async t => {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite(); t.after(() => db.close())
  const table = (migration, name) => {
    const sql = readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8')
      .match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name.replaceAll('.', '\\.')} \\([\\s\\S]*?\\n\\);`))?.[0]
    assert.ok(sql); return sql
  }
  await db.exec(`CREATE SCHEMA external_platform; CREATE SCHEMA control;
    CREATE TABLE tenants(id uuid PRIMARY KEY); CREATE TABLE consumers(id uuid PRIMARY KEY); CREATE TABLE api_keys(id uuid PRIMARY KEY);
    CREATE TABLE public.usage_requests(id uuid PRIMARY KEY,platform text,status text,error_code text,response_status int,
      reserved_at timestamptz,completed_at timestamptz,acquisition_request jsonb);
    CREATE TABLE external_platform.response_snapshots(id uuid PRIMARY KEY);`)
  for (const name of ['provider_calls', 'response_archives', 'gateway_requests']) {
    await db.exec(table('051_external_platform_gateway.sql', `external_platform.${name}`))
  }
  await db.exec(table('058_external_platform_restricted_raw_responses.sql', 'control.external_platform_restricted_raw_responses'))
  const tenant = randomUUID(), consumer = randomUUID(), key = randomUUID(), other = randomUUID(), call = randomUUID(), unrelated = randomUUID()
  for (const [name, id] of [['tenants', tenant], ['consumers', consumer], ['api_keys', key]]) await db.query(`INSERT INTO ${name} VALUES($1)`, [id])
  for (const id of [requestId, other]) await db.query(`INSERT INTO usage_requests VALUES($1,'twitter','unknown','social_upstream_outcome_unknown',502,
    '2026-10-15T09:31:27Z','2026-10-15T09:31:38Z',$2)`, [id, JSON.stringify({ path: '/api/v1/data/search', body: secret })])
  for (const [id, usage] of [[call, requestId], [unrelated, other]]) await db.query(`INSERT INTO external_platform.provider_calls
    (id,provider_key,tenant_id,consumer_id,api_key_id,usage_request_id,operation,contract_version,endpoint_key,endpoint_version,
      marketplace,request_fingerprint,outcome,error_code,latency_ms,started_at,completed_at)
    VALUES($1,'rapidapi',$2,$3,$4,$5,'social.content.search','mx-insight-hub.social-data.v1','twitter-aio.search','twitter-aio.hub.v1',
      'twitter',$6,'unknown','social_upstream_response_unusable',10005,'2026-10-15T09:31:28Z','2026-10-15T09:31:38Z')`,
  [id, tenant, consumer, key, usage, 'a'.repeat(64)])
  await db.query(`INSERT INTO external_platform.response_archives(id,provider_call_id,contract_state,raw_payload,captured_at)
    VALUES($1,$2,'unknown',$3,now())`, [randomUUID(), call, JSON.stringify({ body: secret, response: { transportFailure: transport, token: secret } })])
  const bytes = Buffer.from(secret), sha = createHash('sha256').update(bytes).digest('hex')
  await db.query(`INSERT INTO control.external_platform_restricted_raw_responses
    (id,provider_call_id,body_size,body_sha256,body_bytes,json_parsed,captured_at) VALUES($1,$2,$3,$4,$5,false,now())`,
  [randomUUID(), unrelated, bytes.length, sha, bytes])
  await db.query(`INSERT INTO external_platform.gateway_requests
    (id,provider_key,tenant_id,consumer_id,usage_request_id,request_fingerprint,source_mode,succeeded,response_status,provider_call_id,error_code)
    VALUES($1,'rapidapi',$2,$3,$4,$5,'unavailable',false,502,$6,'social_upstream_outcome_unknown')`,
  [randomUUID(), tenant, consumer, requestId, 'a'.repeat(64), call])
  let readOnlyVerified = false, rolledBack = false
  const pool = { connect: async () => ({ release() {}, query: async (sql, args) => {
    assert.match(sql, /^(BEGIN|SET LOCAL|SELECT|ROLLBACK)\b/u)
    if (sql.includes('twitter-outcome:usage')) {
      assert.equal((await db.query("SELECT current_setting('transaction_read_only') AS value")).rows[0].value, 'on')
      readOnlyVerified = true
    }
    if (sql === 'ROLLBACK') rolledBack = true
    return db.query(sql, args)
  } }) }
  const report = await diagnoseTwitterOutcome(pool, requestId)
  assert.equal(readOnlyVerified, true); assert.equal(rolledBack, true)
  assert.equal(report.ownCalls.length, 1); assert.equal(report.ownCalls[0].callId, call)
  assert.equal(report.gateways[0].providerCallId, call)
  assert.equal(report.ownCalls[0].restrictedArchive.present, false)
  assert.equal(report.ownCalls[0].billed, null)
  assert.equal(report.ownCalls[0].operationalArchive.present, true)
  assert.deepEqual(report.ownCalls[0].operationalArchive.transportFailure.codes, transport.codes)
  assert.doesNotMatch(JSON.stringify(report), /private-/u)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM usage_requests')).rows[0].n, 2)
  // A retained HTTP response is metadata only: no bytes are fetched or claimed verified.
  const otherReport = await diagnoseTwitterOutcome(pool, other)
  assert.equal(otherReport.ownCalls[0].restrictedArchive.sha256, sha)
  assert.equal(otherReport.ownCalls[0].restrictedArchive.bodySize, bytes.length)
  assert.equal(otherReport.ownCalls[0].restrictedArchive.integrity, 'metadata_only_not_verified')
  assert.equal(otherReport.ownCalls[0].operationalArchive.transportFailure, null)
  await db.query(`UPDATE external_platform.response_archives SET raw_payload=$1 WHERE provider_call_id=$2`,
    [JSON.stringify({ response: { transportFailure: { ...transport, message: secret.repeat(200) } } }), call])
  const oversized = await diagnoseTwitterOutcome(pool, requestId)
  assert.equal(oversized.ownCalls[0].operationalArchive.transportFailure, null)
  assert.equal(oversized.ownCalls[0].operationalArchive.transportFailureTooLarge, true)
})
