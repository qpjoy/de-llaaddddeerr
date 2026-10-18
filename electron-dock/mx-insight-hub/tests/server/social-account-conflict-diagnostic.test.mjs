import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { diagnoseSocialAccountConflict } from '../../server/ops/diagnose-social-account-conflict.mjs'

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const secret = 'private-account-body-idempotency-credential'
const path = '/api/v1/data/social/crawl'
const reservedAt = '2026-10-17T01:00:00.000Z'
async function fixture(t) {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite()
  t.after(() => db.close())
  // Actual column names/types from migrations 001, 004, 051 and 094. Migration 054
  // permits historical usage rows to share one consumer/idempotency pair.
  await db.exec(`CREATE SCHEMA external_platform;
    CREATE TABLE usage_requests(id uuid PRIMARY KEY, consumer_id uuid, api_key_id uuid, fingerprint char(64),
      idempotency_key text, platform text, status text, response_status integer, error_code text,
      reserved_at timestamptz, completed_at timestamptz, acquisition_request jsonb, lease_expires_at timestamptz);
    CREATE TABLE external_platform.provider_calls(id uuid PRIMARY KEY, usage_request_id uuid, operation text,
      outcome text, http_status integer, error_code text, started_at timestamptz, completed_at timestamptz);
    CREATE TABLE external_platform.dispatch_leases(consumer_id uuid, operation text, request_fingerprint char(64),
      owner_request_id uuid, created_at timestamptz, expires_at timestamptz,
      PRIMARY KEY(consumer_id, operation, request_fingerprint));`)
  const consumer = randomUUID(), key = randomUUID(), fingerprint = 'a'.repeat(64), queries = []
  const insertUsage = async (overrides = {}) => {
    const row = { id: randomUUID(), consumer, key, fingerprint, idem: secret, platform: 'twitter', path, reservedAt, ...overrides }
    await db.query(`INSERT INTO usage_requests VALUES($1,$2,$3,$4,$5,$6,'released',NULL,
      'external_platform_pre_dispatch_failed',$7,$7,$8,$7::timestamptz + INTERVAL '5 minutes')`, [row.id, row.consumer, row.key, row.fingerprint,
      row.idem, row.platform, row.reservedAt, JSON.stringify({ path: row.path, body: secret, account: secret, token: secret })])
    return row.id
  }
  const insertCall = async (id, operation = 'social.content.crawl') => {
    const callId = randomUUID()
    await db.query(`INSERT INTO external_platform.provider_calls VALUES($1,$2,$3,'succeeded',200,NULL,$4,$4)`, [callId, id, operation, reservedAt])
    return callId
  }
  const insertLease = async (owner, operation = 'social.search.twitter', active = true, overrides = {}) => {
    await db.query(`INSERT INTO external_platform.dispatch_leases VALUES($1,$2,$3,$4,$5,
      now() + $6::interval)`, [overrides.consumer || consumer, operation, overrides.fingerprint || fingerprint,
      owner, reservedAt, active ? '1 hour' : '-1 hour'])
  }
  let probe = true, releases = 0
  const pool = { async connect() { return { async query(sql, params) {
    queries.push({ sql, params })
    assert.match(sql, /^(BEGIN|SET LOCAL|SELECT|WITH|ROLLBACK)\b/u)
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|COMMIT)\b/u)
    if (probe && sql.includes('social-account-conflict:target')) {
      probe = false
      const { rows: [settings] } = await db.query(`SELECT current_setting('transaction_read_only') AS ro,
        current_setting('transaction_isolation') AS isolation, current_setting('statement_timeout') AS statement,
        current_setting('lock_timeout') AS lock`)
      assert.deepEqual(settings, { ro: 'on', isolation: 'repeatable read', statement: '5s', lock: '1s' })
      await db.query('SAVEPOINT readonly_probe')
      await assert.rejects(db.query('UPDATE usage_requests SET status = status WHERE false'), error => error.code === '25006')
      await db.query('ROLLBACK TO SAVEPOINT readonly_probe')
    }
    return db.query(sql, params)
  }, release() { releases++ } } } }
  const snapshot = async () => JSON.stringify(await Promise.all(['usage_requests', 'external_platform.provider_calls', 'external_platform.dispatch_leases']
    .map(table => db.query(`SELECT * FROM ${table} ORDER BY 1, 2`))))
  return { db, pool, consumer, fingerprint, insertUsage, insertCall, insertLease, queries, snapshot, get releases() { return releases } }
}

test('actual PostgreSQL diagnostic isolates exact usage, sibling candidates and current leases, and cannot write', { skip: !modulePath }, async t => {
  const f = await fixture(t), target = await f.insertUsage()
  const sameKey = await f.insertUsage({ idem: 'different-private-key', reservedAt: '2026-10-17T00:50:00Z' })
  const sameIdem = await f.insertUsage({ key: randomUUID(), reservedAt: '2026-10-17T01:10:00Z' })
  for (const overrides of [{ consumer: randomUUID() }, { fingerprint: 'b'.repeat(64) }, { platform: 'weibo' },
    { path: '/api/v1/data/social/user-info' }, { reservedAt: '2026-10-17T00:49:59Z' }, { reservedAt: '2026-10-17T01:10:01Z' }]) await f.insertUsage(overrides)
  const own = await f.insertCall(target)
  await f.insertCall(sameKey)
  await f.insertLease(sameKey)
  const absentOwner = randomUUID()
  await f.insertLease(absentOwner, 'social.content.crawl', false)
  await f.insertLease(target, 'social.search.twitter', true, { consumer: randomUUID() })
  await f.insertLease(target, 'social.search.twitter', true, { fingerprint: 'b'.repeat(64) })
  const before = await f.snapshot(), result = await diagnoseSocialAccountConflict(f.pool, target)
  assert.equal(result.found, true)
  assert.equal(result.currentStateOnly, true)
  assert.equal(result.siblingWindowMinutes, 10)
  assert.equal(result.historicalLeaseOwnerRecorded, false)
  assert.equal(result.target.savedHttpStatus, null)
  assert.equal(result.target.requestPath, path)
  assert.equal(result.target.leaseExpiresAt, '2026-10-17T01:05:00.000Z')
  assert.equal(result.ownProviderCallCount, 1)
  assert.equal(result.ownProviderCalls[0].callId, own)
  assert.equal(result.siblingCount, 2)
  assert.deepEqual(result.siblingCandidates.map(row => [row.requestId, row.sameApiKey, row.sameIdempotency, row.providerCallCount]),
    [[sameKey, true, false, 1], [sameIdem, false, true, 0]])
  assert.equal(result.siblingCandidates[0].leaseExpiresAt, '2026-10-17T00:55:00.000Z')
  assert.equal(result.currentLeaseCount, 2)
  assert.equal(result.currentLeases.find(row => row.ownerRequestId === sameKey).active, true)
  assert.equal(result.currentLeases.find(row => row.ownerRequestId === sameKey).ownerStatus, 'released')
  assert.equal(result.currentLeases.find(row => row.ownerRequestId === absentOwner).active, false)
  assert.equal(result.currentLeases.find(row => row.ownerRequestId === absentOwner).ownerStatus, null)
  assert.doesNotMatch(JSON.stringify(result), /private-|fingerprint|idempotency_key|account-body/u)
  const missing = await diagnoseSocialAccountConflict(f.pool, randomUUID())
  assert.equal(missing.found, false)
  assert.equal(missing.target, undefined)
  assert.equal(f.queries.at(-1).sql, 'ROLLBACK')
  assert.equal(f.releases, 2)
  assert.equal(await f.snapshot(), before)
  for (const { sql, params } of f.queries.filter(row => row.sql.includes('social-account-conflict:'))) {
    assert.equal(params.length, 1)
    assert.doesNotMatch(sql, /response_body|body_bytes|parsed_payload/u)
  }
})

test('actual PostgreSQL diagnostic bounds every list at 20 and hides unknown strings', { skip: !modulePath }, async t => {
  const f = await fixture(t), target = await f.insertUsage()
  for (let i = 0; i < 21; i++) {
    await f.insertUsage({ idem: `${secret}-${i}` })
    await f.insertCall(target, `${secret}-${i}`)
    await f.insertLease(target, `${secret}-${i}`)
  }
  const result = await diagnoseSocialAccountConflict(f.pool, target)
  for (const [list, total] of [['ownProviderCalls', 'ownProviderCallCount'], ['siblingCandidates', 'siblingCount'], ['currentLeases', 'currentLeaseCount']]) {
    assert.equal(result[list].length, 20)
    assert.equal(result[`${list}Truncated`], true)
    assert.equal(result[total], 21)
  }
  assert.equal(result.ownProviderCalls[0].operation, 'other')
  assert.equal(result.currentLeases[0].operation, 'other')
  assert.doesNotMatch(JSON.stringify(result), /private-/u)
})

test('standalone stdin validates before connecting, and query failures roll back without disclosing errors', async () => {
  const source = readFileSync(new URL('../../server/ops/diagnose-social-account-conflict.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /from ['"]\.\.?\/|\bfetch\s*\(/u)
  const env = { ...process.env }; delete env.DATABASE_URL
  for (const [args, error] of [[[randomUUID()], 'database_url_required'], [[secret], 'invalid_request_id'], [[], 'invalid_arguments'], [[randomUUID(), secret], 'invalid_arguments']]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-', ...args], { input: source, env, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.deepEqual(JSON.parse(result.stderr), { error })
  }
  await assert.rejects(diagnoseSocialAccountConflict({ connect() { assert.fail('invalid ID must not connect') } }, secret), { message: 'invalid_request_id' })
  for (const failRollback of [false, true]) {
    const sql = []; let released = false, releaseError
    const pool = { async connect() { return { async query(query) {
      sql.push(query)
      if (query.includes('social-account-conflict:target') || failRollback && query === 'ROLLBACK') throw new Error(secret)
      return { rows: [] }
    }, release(error) { released = true; releaseError = error } } } }
    await assert.rejects(diagnoseSocialAccountConflict(pool, randomUUID()), { message: 'diagnostic_read_failed' })
    assert.equal(sql.at(-1), 'ROLLBACK')
    assert.equal(released, true)
    assert.equal(Boolean(releaseError), failRollback)
  }
})
