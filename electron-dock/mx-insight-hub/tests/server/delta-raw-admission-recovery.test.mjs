import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { RECOVERY, verifyDeltaRawAdmissionRecovery } from '../../server/ops/verify-delta-raw-admission-recovery.mjs'

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const sourceUrl = new URL('../../server/ops/verify-delta-raw-admission-recovery.mjs', import.meta.url)
const source = readFileSync(sourceUrl, 'utf8')
const protocolBytes = readFileSync(new URL('../../server/data/search-protocol-store.mjs', import.meta.url))
const hash = value => createHash('sha256').update(value).digest('hex')
const protocolHash = '439490f908a1caf65211cd7e1562c719e05cbe667141cc1d83c164923389713b'
const secret = 'private-query-key-token-consumer-body'
const databaseNow = new Date('2026-10-18T11:12:13.456Z')

function fakePool({ missing = false, legacy = true, absent = true, fail = '', invalidTime = false, duringProof, releaseFails = false } = {}) {
  const queries = []
  let released = false, releaseError
  return { queries, get released() { return released }, get releaseError() { return releaseError },
    connect: async () => ({ query: async (sql, args) => {
      queries.push({ sql, args })
      assert.match(sql, /^(BEGIN|SET LOCAL|SELECT|ROLLBACK)\b/u)
      assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|COMMIT|TRUNCATE)\b/u)
      if (fail && sql.includes(fail)) throw new Error(secret)
      if (sql.includes('delta-raw-admission-recovery:proof')) {
        duringProof?.()
        assert.deepEqual(args, [RECOVERY.blockerRequestId, RECOVERY.idempotencyKeySha256])
        return { rows: missing ? [] : [{ database_now: invalidTime ? secret : databaseNow,
          legacy_raw_verified: legacy, page_identity_absent: absent, ignored_private: secret }] }
      }
      return { rows: [] }
    }, release: error => { released = true; releaseError = error; if (releaseFails) throw new Error(secret) } }) }
}

function runtimeFixture(t, bytes = protocolBytes) {
  const directory = mkdtempSync(join(tmpdir(), 'delta-raw-preflight-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  mkdirSync(join(directory, 'server/data'), { recursive: true })
  const file = join(directory, 'server/data/search-protocol-store.mjs')
  writeFileSync(file, bytes)
  return { root: pathToFileURL(`${directory}/`), file, directory }
}

test('incident receipt has only fixed identities, actual code hash and database time after a read-only rollback', async () => {
  assert.equal(hash(protocolBytes), protocolHash)
  const pool = fakePool(), receipt = await verifyDeltaRawAdmissionRecovery(pool)
  assert.deepEqual(receipt, { ...RECOVERY, checkedAt: databaseNow.toISOString(), protocolStoreSha256: protocolHash,
    legacyRawVerified: true, pageIdentityAbsent: true, ready: true })
  assert.equal(receipt.revision, 'delta-raw-admission-recovery.v1')
  assert.equal(receipt.planKey, '6905bd48-7324-4602-9c06-4b77994f93d9')
  assert.equal(receipt.runKey, '65a9f174-e611-4032-a759-fb64efcb540e')
  assert.equal(receipt.blockerRequestId, '8ebd9f58-f6b6-4f8a-b8fe-db94c1068c09')
  assert.equal(receipt.idempotencyKeySha256, 'c7ef520abe008e7c8ba0555bdddd496a0b055e37bc37dd97bd0323884afa1c00')
  assert.equal(receipt.payloadSha256, '40ba477e6e7b6bbb5c58bdf40c978daa6d03d9bd3931a5637c78f7d2ad5ff43b')
  assert.doesNotMatch(JSON.stringify(receipt), /private-|consumer|query|idempotency_key/u)
  assert.equal(pool.queries[0].sql, 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(pool.queries.at(-1).sql, 'ROLLBACK')
  assert.equal(pool.released, true)
  const proof = pool.queries.find(row => row.sql.includes('delta-raw-admission-recovery:proof')).sql
  assert.match(proof, /request\.id=\$1::uuid/u)
  assert.doesNotMatch(proof, /\bLIMIT\b|response_body|request_body|SELECT \*/u)
  assert.equal((proof.match(/encode\(sha256\(convert_to\(candidate\.idempotency_key,'UTF8'\)\),'hex'\)=\$2::text/gu) || []).length, 4)
  assert.equal((proof.match(/candidate\.consumer_id=request\.consumer_id/gu) || []).length, 4)
})

test('false or malformed evidence never produces a ready receipt', async () => {
  for (const options of [{ legacy: false }, { absent: false }, { legacy: null }, { absent: null },
    { legacy: 'true' }, { absent: 1 }, { legacy: secret, absent: secret }]) {
    const pool = fakePool(options), receipt = await verifyDeltaRawAdmissionRecovery(pool)
    assert.equal(receipt.ready, false)
    assert.doesNotMatch(JSON.stringify(receipt), /private-/u)
    assert.equal(pool.queries.at(-1).sql, 'ROLLBACK')
    assert.equal(pool.released, true)
  }
})

test('source mismatch, absent source, database errors and rollback failure fail closed without sensitive details', async t => {
  const wrong = runtimeFixture(t, secret), missing = pathToFileURL(`${wrong.directory}/missing/`)
  const noConnect = { connect() { assert.fail('invalid runtime must not connect') } }
  await assert.rejects(verifyDeltaRawAdmissionRecovery(noConnect, wrong), { message: 'runtime_source_mismatch' })
  await assert.rejects(verifyDeltaRawAdmissionRecovery(noConnect, { root: missing }), { message: 'runtime_source_unavailable' })
  for (const [options, message] of [[{ missing: true }, 'blocker_not_found'], [{ invalidTime: true }, 'preflight_read_failed'],
    [{ fail: 'BEGIN' }, 'preflight_read_failed'], [{ fail: 'delta-raw-admission-recovery:proof' }, 'preflight_read_failed'],
    [{ fail: 'ROLLBACK' }, 'preflight_read_failed'], [{ releaseFails: true }, 'preflight_read_failed']]) {
    const pool = fakePool(options)
    await assert.rejects(verifyDeltaRawAdmissionRecovery(pool), { message })
    assert.equal(pool.queries.at(-1).sql, 'ROLLBACK')
    assert.equal(pool.released, true)
    assert.equal(Boolean(pool.releaseError), options.fail === 'ROLLBACK')
  }
  const changed = runtimeFixture(t)
  const pool = fakePool({ duringProof: () => writeFileSync(changed.file, secret) })
  await assert.rejects(verifyDeltaRawAdmissionRecovery(pool, changed), { message: 'runtime_source_mismatch' })
  assert.equal(pool.queries.at(-1).sql, 'ROLLBACK')
})

test('CLI and stdin entry points accept no scope overrides and do not load application modules or send HTTP', t => {
  assert.doesNotMatch(source, /from ['"]\.\.?\/|\bfetch\s*\(|\bhttps?\b/u)
  const env = { ...process.env }; delete env.DATABASE_URL
  for (const args of [[], ['--request-id', secret], ['--key-sha', secret]]) {
    for (const stdin of [true, false]) {
      const result = spawnSync(process.execPath, stdin ? ['--input-type=module', '-', ...args] : [sourceUrl.pathname, ...args],
        { input: stdin ? source : undefined, env, encoding: 'utf8' })
      assert.equal(result.status, 1)
      assert.equal(result.stdout, '')
      assert.deepEqual(JSON.parse(result.stderr), { error: args.length ? 'invalid_arguments' : 'database_url_required' })
    }
  }
  const wrong = runtimeFixture(t, secret)
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], { input: source, cwd: wrong.directory,
    env: { ...env, DATABASE_URL: 'postgres://never-connect.invalid/no-database' }, encoding: 'utf8' })
  assert.equal(result.status, 1); assert.equal(result.stdout, '')
  assert.deepEqual(JSON.parse(result.stderr), { error: 'runtime_source_mismatch' })
})

async function postgresFixture(t) {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite()
  t.after(() => db.close())
  const consumerId = randomUUID(), callId = randomUUID(), fingerprint = 'a'.repeat(64)
  await db.exec(`CREATE SCHEMA serving; CREATE SCHEMA control;
    CREATE TABLE usage_requests(id uuid PRIMARY KEY, consumer_id uuid NOT NULL, idempotency_key text NOT NULL,
      platform text, status text, acquisition_request jsonb, capability text, billing_meter_key text, fingerprint char(64));
    CREATE TABLE serving.connector_calls(id uuid PRIMARY KEY, usage_request_id uuid, consumer_id uuid,
      platform text, request_fingerprint char(64), operation text, outcome text);
    CREATE TABLE usage_idempotency_bindings(consumer_id uuid,idempotency_key text);
    CREATE TABLE control.data_search_protocol_bindings(consumer_id uuid,idempotency_key text);
    CREATE TABLE control.data_search_protocol_leases(consumer_id uuid,idempotency_key text);`)
  await db.query(`INSERT INTO usage_requests VALUES($1,$2,$3,'twitter','unknown',NULL,NULL,'raw',$4)`,
    [RECOVERY.blockerRequestId, consumerId, 'synthetic-old-raw-key', fingerprint])
  await db.query(`INSERT INTO serving.connector_calls VALUES($1,$2,$3,'twitter',$4,'raw','unknown')`,
    [callId, RECOVERY.blockerRequestId, consumerId, fingerprint])
  const syntheticPageKey = 'synthetic-original-page-key-for-offline-tests'
  const pool = { connect: async () => ({ query: (sql, args) => {
    if (sql.includes('delta-raw-admission-recovery:proof')) {
      assert.deepEqual(args, [RECOVERY.blockerRequestId, RECOVERY.idempotencyKeySha256])
      // The production incident's key is intentionally unavailable to tests.
      // Substitute only its digest at the test driver boundary so the real
      // PostgreSQL SHA256 predicate is exercised with a synthetic private key.
      return db.query(sql, [args[0], hash(syntheticPageKey)])
    }
    return db.query(sql, args)
  }, release() {} }) }
  return { db, pool, consumerId, callId, syntheticPageKey }
}

test('actual PostgreSQL verifies strict raw evidence and distinguishes SQL NULL from omitted or JSON-null snapshots', { skip: !modulePath }, async t => {
  const f = await postgresFixture(t), before = (await f.db.query('SELECT * FROM usage_requests')).rows
  assert.equal((await verifyDeltaRawAdmissionRecovery(f.pool)).ready, true)
  const cases = [
    ["UPDATE usage_requests SET status='reserved'", "UPDATE usage_requests SET status='unknown'"],
    ["UPDATE usage_requests SET platform='facebook'", "UPDATE usage_requests SET platform='twitter'"],
    ["UPDATE usage_requests SET billing_meter_key='crawl'", "UPDATE usage_requests SET billing_meter_key='raw'"],
    ["UPDATE usage_requests SET capability='social.content.search'", 'UPDATE usage_requests SET capability=NULL'],
    ["UPDATE usage_requests SET fingerprint=NULL", "UPDATE usage_requests SET fingerprint=repeat('a',64)"],
    ["UPDATE usage_requests SET fingerprint='invalid'", "UPDATE usage_requests SET fingerprint=repeat('a',64)"],
    ["UPDATE usage_requests SET acquisition_request='null'::jsonb", 'UPDATE usage_requests SET acquisition_request=NULL'],
    ["UPDATE usage_requests SET acquisition_request='{}'::jsonb", 'UPDATE usage_requests SET acquisition_request=NULL'],
    ["UPDATE usage_requests SET acquisition_request='{\"path\":null}'::jsonb", 'UPDATE usage_requests SET acquisition_request=NULL'],
    ["UPDATE usage_requests SET acquisition_request='{\"path\":\"/api/v1/data/search\"}'::jsonb", 'UPDATE usage_requests SET acquisition_request=NULL'],
    ["UPDATE serving.connector_calls SET consumer_id=NULL", `UPDATE serving.connector_calls SET consumer_id='${f.consumerId}'`],
    ["UPDATE serving.connector_calls SET platform=NULL", "UPDATE serving.connector_calls SET platform='twitter'"],
    ["UPDATE serving.connector_calls SET request_fingerprint=repeat('b',64)", "UPDATE serving.connector_calls SET request_fingerprint=repeat('a',64)"],
    ["UPDATE serving.connector_calls SET operation='data-search'", "UPDATE serving.connector_calls SET operation='raw'"],
    ["UPDATE serving.connector_calls SET outcome=NULL", "UPDATE serving.connector_calls SET outcome='unknown'"],
    ["UPDATE serving.connector_calls SET usage_request_id=NULL", `UPDATE serving.connector_calls SET usage_request_id='${RECOVERY.blockerRequestId}'`],
  ]
  for (const [change, restore] of cases) {
    await f.db.exec(change)
    const receipt = await verifyDeltaRawAdmissionRecovery(f.pool)
    assert.equal(receipt.legacyRawVerified, false, change); assert.equal(receipt.ready, false, change)
    await f.db.exec(restore)
  }
  await f.db.query(`INSERT INTO serving.connector_calls SELECT $1,usage_request_id,consumer_id,platform,request_fingerprint,
    operation,outcome FROM serving.connector_calls`, [randomUUID()])
  assert.equal((await verifyDeltaRawAdmissionRecovery(f.pool)).ready, false, 'a second consistent connector is not sufficient proof')
  await f.db.query('DELETE FROM serving.connector_calls WHERE id<>$1', [f.callId])
  assert.equal((await verifyDeltaRawAdmissionRecovery(f.pool)).ready, true)
  assert.deepEqual((await f.db.query('SELECT * FROM usage_requests')).rows, before)
  assert.equal((await f.db.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'off', 'preflight always rolled back')
})

test('actual PostgreSQL checks all four key ledgers across the old consumer without status, age or result limits', { skip: !modulePath }, async t => {
  const f = await postgresFixture(t)
  assert.equal((await f.db.query("SELECT encode(sha256(convert_to($1::text,'UTF8')),'hex') AS digest", [f.syntheticPageKey])).rows[0].digest,
    hash(f.syntheticPageKey))
  const tables = ['public.usage_requests', 'public.usage_idempotency_bindings',
    'control.data_search_protocol_bindings', 'control.data_search_protocol_leases']
  for (const table of tables) {
    // A different consumer is unrelated. The same consumer must block even
    // where another platform/status would evade a narrower incident-only scan.
    const otherConsumer = randomUUID()
    const add = async consumer => table === 'public.usage_requests'
      ? f.db.query(`INSERT INTO ${table}(id,consumer_id,idempotency_key,platform,status) VALUES($1,$2,$3,'facebook','released')`,
        [randomUUID(), consumer, f.syntheticPageKey])
      : f.db.query(`INSERT INTO ${table}(consumer_id,idempotency_key) VALUES($1,$2)`, [consumer, f.syntheticPageKey])
    await add(otherConsumer)
    assert.equal((await verifyDeltaRawAdmissionRecovery(f.pool)).ready, true, table)
    await add(f.consumerId)
    const receipt = await verifyDeltaRawAdmissionRecovery(f.pool)
    assert.equal(receipt.legacyRawVerified, true)
    assert.equal(receipt.pageIdentityAbsent, false, table); assert.equal(receipt.ready, false, table)
    assert.doesNotMatch(JSON.stringify(receipt), new RegExp(`${f.syntheticPageKey}|${f.consumerId}|${otherConsumer}`, 'u'))
    await f.db.query(`DELETE FROM ${table} WHERE idempotency_key=$1`, [f.syntheticPageKey])
  }
})

test('actual PostgreSQL missing required tables cannot issue a ready receipt', { skip: !modulePath }, async t => {
  const f = await postgresFixture(t)
  for (const table of ['serving.connector_calls', 'usage_idempotency_bindings', 'control.data_search_protocol_bindings', 'control.data_search_protocol_leases']) {
    await f.db.exec(`ALTER TABLE ${table} RENAME TO hidden_evidence`)
    await assert.rejects(verifyDeltaRawAdmissionRecovery(f.pool), { message: 'preflight_read_failed' })
    await f.db.exec(`ALTER TABLE ${table.includes('.') ? `${table.split('.')[0]}.` : ''}hidden_evidence RENAME TO ${table.split('.').at(-1)}`)
    assert.equal((await verifyDeltaRawAdmissionRecovery(f.pool)).ready, true)
  }
})
