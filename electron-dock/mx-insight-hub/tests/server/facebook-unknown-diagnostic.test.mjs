import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { diagnoseFacebookUnknown } from '../../server/ops/diagnose-facebook-unknown.mjs'

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const secret = 'private-query-token-idempotency-response'
const path = '/api/v1/data/search'
async function fixture(t) {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite()
  t.after(() => db.close())
  // Actual column names/types from migrations 001, 004, 051, 058 and 094.
  await db.exec(`CREATE SCHEMA external_platform; CREATE SCHEMA control;
    CREATE TABLE usage_requests(id uuid PRIMARY KEY,tenant_id uuid,consumer_id uuid,api_key_id uuid,
      fingerprint char(64),idempotency_key text,platform text,status text,response_status integer,
      response_body jsonb,error_code text,reserved_at timestamptz,completed_at timestamptz,
      lease_expires_at timestamptz,acquisition_request jsonb);
    CREATE TABLE external_platform.provider_calls(id uuid PRIMARY KEY,usage_request_id uuid,
      provider_key text,operation text,outcome text,http_status integer,error_code text,
      started_at timestamptz,completed_at timestamptz);
    CREATE TABLE external_platform.response_archives(id uuid PRIMARY KEY,provider_call_id uuid UNIQUE,
      body_size integer,payload_sha256 char(64),captured_at timestamptz,contract_state text,http_status integer,raw_payload jsonb);
    CREATE TABLE control.external_platform_restricted_raw_responses(id uuid PRIMARY KEY,provider_call_id uuid UNIQUE,
      body_size integer,body_sha256 char(64),captured_at timestamptz,json_parsed boolean,body_bytes bytea,parsed_payload jsonb);
    CREATE TABLE external_platform.dispatch_leases(consumer_id uuid,operation text,request_fingerprint char(64),
      owner_request_id uuid,created_at timestamptz,expires_at timestamptz,PRIMARY KEY(consumer_id,operation,request_fingerprint));`)
  const tenant = randomUUID(), consumer = randomUUID(), key = randomUUID(), fingerprint = 'a'.repeat(64)
  const { rows: [clock] } = await db.query('SELECT now() AS now')
  const base = new Date(clock.now).getTime() - 3600000, at = delta => new Date(base + delta).toISOString()
  const insertUsage = async (overrides = {}) => {
    const row = { id: randomUUID(), tenant, consumer, key, fingerprint, platform: 'facebook', path,
      status: 'unknown', http: null, response: null, error: 'external_platform_persistence_unknown',
      reserved: at(0), completed: at(1000), ...overrides }
    await db.query(`INSERT INTO usage_requests VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
      $12::timestamptz+INTERVAL '5 minutes',$14)`, [row.id,row.tenant,row.consumer,row.key,row.fingerprint,
      secret,row.platform,row.status,row.http,row.response == null ? null : JSON.stringify(row.response),
      row.error,row.reserved,row.completed,JSON.stringify({ path: row.path, body: { query: secret, token: secret } })])
    return row.id
  }
  const insertCall = async (requestId, overrides = {}) => {
    const row = { id: randomUUID(), provider: 'rapidapi', operation: 'social.facebook.search', outcome: 'succeeded',
      http: 200, error: null, ...overrides }
    await db.query('INSERT INTO external_platform.provider_calls VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [row.id,requestId,row.provider,row.operation,row.outcome,row.http,row.error,at(0),at(500)])
    return row.id
  }
  const insertArchive = async (callId, restricted = true) => {
    await db.query(`INSERT INTO external_platform.response_archives VALUES($1,$2,32,$3,$4,'accepted',200,$5)`,
      [randomUUID(),callId,'b'.repeat(64),at(500),JSON.stringify({ token: secret })])
    if (restricted) await db.query(`INSERT INTO control.external_platform_restricted_raw_responses
      VALUES($1,$2,64,$3,$4,true,$5,$6)`, [randomUUID(),callId,'c'.repeat(64),at(500),Buffer.from(secret),JSON.stringify({ query: secret })])
  }
  const queries = []; let releases = 0, probe = true
  const pool = { async connect() { return { async query(sql, params) {
    queries.push({ sql, params })
    assert.match(sql, /^(BEGIN|SET LOCAL|SELECT|WITH|ROLLBACK)\b/u)
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|COMMIT)\b/u)
    if (probe && sql.includes('facebook-unknown:target')) {
      probe = false
      const { rows: [settings] } = await db.query(`SELECT current_setting('transaction_read_only') AS ro,
        current_setting('transaction_isolation') AS isolation,current_setting('statement_timeout') AS statement,
        current_setting('lock_timeout') AS lock`)
      assert.deepEqual(settings, { ro: 'on', isolation: 'repeatable read', statement: '5s', lock: '1s' })
      await db.query('SAVEPOINT readonly_probe')
      await assert.rejects(db.query('UPDATE usage_requests SET status=status WHERE false'), error => error.code === '25006')
      await db.query('ROLLBACK TO SAVEPOINT readonly_probe')
    }
    return db.query(sql, params)
  }, release() { releases++ } } } }
  const snapshot = async () => JSON.stringify(await Promise.all(['usage_requests','external_platform.provider_calls',
    'external_platform.response_archives','control.external_platform_restricted_raw_responses','external_platform.dispatch_leases']
    .map(table => db.query(`SELECT * FROM ${table} ORDER BY 1`))))
  return { db,pool,tenant,consumer,key,fingerprint,at,insertUsage,insertCall,insertArchive,queries,snapshot,get releases() { return releases } }
}

test('actual PostgreSQL diagnostic isolates prior unknown candidates and archived evidence without writes or private content', { skip: !modulePath }, async t => {
  const f = await fixture(t), target = await f.insertUsage({ status: 'released', error: 'external_platform_pre_dispatch_failed' })
  const original = await f.insertUsage({ reserved: f.at(-2000) })
  const old = await f.insertUsage({ reserved: f.at(-86400000) })
  for (const overrides of [{ tenant: randomUUID() },{ consumer: randomUUID() },{ key: randomUUID() },
    { fingerprint: 'd'.repeat(64) },{ platform: 'twitter' },{ path: '/api/v1/search/raw' },
    { status: 'committed', http: 200 },{ reserved: f.at(-86400001) },{ reserved: f.at(1001) }]) await f.insertUsage(overrides)
  const successCall = await f.insertCall(original), unknownCall = await f.insertCall(old, { outcome: 'unknown', http: null,
    error: 'social_upstream_timeout_or_size_limit' })
  await f.insertArchive(successCall)
  await f.insertArchive(unknownCall, false)
  await f.db.query(`INSERT INTO external_platform.dispatch_leases VALUES($1,'social.facebook.search',$2,$3,$4,now()+INTERVAL '1 hour'),
    ($1,'social.content.search',$2,$3,$4,now()+INTERVAL '1 hour')`, [f.consumer,f.fingerprint,original,f.at(0)])
  const before = await f.snapshot(), result = await diagnoseFacebookUnknown(f.pool, target)
  assert.equal(result.currentStateOnly, true)
  assert.equal(result.historicalUnknownStateRecorded, false)
  assert.equal(result.target.status, 'released')
  assert.equal(result.target.savedResponsePresent, false)
  assert.equal(result.target.ownProviderCallCount, 0)
  assert.deepEqual(result.candidateWindow, { startAt: f.at(-86400000), endAt: f.at(1000), endSource: 'completed_at' })
  assert.equal(result.unknownCandidateCount, 2)
  assert.deepEqual(result.unknownCandidates.map(row => [row.requestId,row.currentlyMatchesUnknownGuard,row.isTarget]),
    [[original,true,false],[old,false,false]])
  const evidence = result.unknownCandidates[0].ownProviderCalls[0]
  assert.equal(evidence.callId, successCall)
  assert.equal(evidence.outcome, 'succeeded')
  assert.equal(evidence.operationalArchive.present, true)
  assert.equal(evidence.operationalArchive.bodySize, 32)
  assert.equal(evidence.restrictedArchive.present, true)
  assert.equal(evidence.restrictedArchive.sha256, 'c'.repeat(64))
  assert.equal(result.unknownCandidates[1].ownProviderCalls[0].restrictedArchive.present, false)
  assert.match(result.archiveEvidence, /not verified/u)
  assert.equal(result.currentLeaseCount, 1)
  assert.equal(result.currentLeases[0].ownerRequestId, original)
  assert.equal(result.currentLeases[0].active, true)
  assert.doesNotMatch(JSON.stringify(result), /private-|fingerprint|idempotency|tenant_id|api_key_id/u)
  assert.equal(await f.snapshot(), before)
  assert.equal(f.queries.at(-1).sql, 'ROLLBACK')
  assert.equal(f.releases, 1)
  for (const { sql } of f.queries) assert.doesNotMatch(sql, /body_bytes|raw_payload|parsed_payload/u)
})

test('actual PostgreSQL diagnostic includes the target unknown, bounds candidates/calls and uses a ten-minute unfinished window', { skip: !modulePath }, async t => {
  const f = await fixture(t), target = await f.insertUsage({ completed: null, error: secret, response: { secret } })
  const only = await diagnoseFacebookUnknown(f.pool, target.toUpperCase())
  assert.equal(only.target.requestId, target)
  assert.equal(only.unknownCandidates[0].isTarget, true)
  assert.equal(only.target.currentlyMatchesUnknownGuard, true)
  assert.equal(only.target.errorCode, 'other')
  assert.equal(only.target.savedResponsePresent, true)
  assert.deepEqual(only.candidateWindow, { startAt: f.at(-86400000), endAt: f.at(600000), endSource: 'reserved_at_plus_10_minutes' })
  const boundary = await f.insertUsage({ reserved: f.at(600000) })
  await f.insertUsage({ reserved: f.at(600001) })
  for (let i = 0; i < 21; i++) {
    await f.insertUsage({ reserved: f.at(-1000) })
    await f.insertCall(target, { provider: secret, operation: secret, error: secret })
    await f.insertCall(boundary)
  }
  const result = await diagnoseFacebookUnknown(f.pool, target)
  assert.equal(result.unknownCandidateCount, 23)
  assert.equal(result.unknownCandidates.length, 20)
  assert.equal(result.unknownCandidatesTruncated, true)
  assert.equal(result.unknownCandidates[0].requestId, boundary)
  for (const row of [result.target,result.unknownCandidates[0]]) {
    assert.equal(row.ownProviderCallCount, 21)
    assert.equal(row.ownProviderCalls.length, 20)
    assert.equal(row.ownProviderCallsTruncated, true)
  }
  assert.equal(result.target.ownProviderCalls[0].provider, 'other')
  assert.doesNotMatch(JSON.stringify(result), /private-/u)
})

test('actual PostgreSQL missing/wrong scopes and standalone stdin fail safely, with rollback on query failures', { skip: !modulePath }, async t => {
  const f = await fixture(t)
  await assert.rejects(diagnoseFacebookUnknown(f.pool, randomUUID()), { message: 'request_not_found' })
  for (const overrides of [{ platform: 'twitter' },{ path: '/api/v1/search/raw' }]) {
    await assert.rejects(diagnoseFacebookUnknown(f.pool, await f.insertUsage(overrides)), { message: 'request_not_facebook_standard_search' })
  }
  assert.equal(f.releases, 3)
  const empty = await diagnoseFacebookUnknown(f.pool, await f.insertUsage({ status: 'released' }))
  assert.equal(empty.unknownCandidateCount, 0)
  assert.match(empty.interpretation, /empty list does not exclude a historical unknown/u)
  const source = readFileSync(new URL('../../server/ops/diagnose-facebook-unknown.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /from ['"]\.\.?\/|\bfetch\s*\(/u)
  const env = { ...process.env }; delete env.DATABASE_URL
  for (const [args,error] of [[[randomUUID()],'database_url_required'],[[secret],'invalid_request_id'],[[],'invalid_arguments'],[[randomUUID(),secret],'invalid_arguments']]) {
    const result = spawnSync(process.execPath, ['--input-type=module','-',...args], { input: source,env,encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.deepEqual(JSON.parse(result.stderr), { error })
  }
  await assert.rejects(diagnoseFacebookUnknown({ connect() { assert.fail('invalid ID must not connect') } }, secret), { message: 'invalid_request_id' })
  for (const failRollback of [false,true]) {
    const sql = []; let released = false, releaseError
    const pool = { async connect() { return { async query(query) {
      sql.push(query)
      if (query.includes('facebook-unknown:target') || failRollback && query === 'ROLLBACK') throw new Error(secret)
      return { rows: [] }
    }, release(error) { released = true; releaseError = error } } } }
    await assert.rejects(diagnoseFacebookUnknown(pool, randomUUID()), { message: 'diagnostic_read_failed' })
    assert.equal(sql.at(-1), 'ROLLBACK')
    assert.equal(released, true)
    assert.equal(Boolean(releaseError), failRollback)
  }
})
