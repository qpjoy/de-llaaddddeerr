import assert from 'node:assert/strict'
import test from 'node:test'
import { requestMaintenance } from '../../server/core/request-maintenance.mjs'
import { PostgresExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

test('300 concurrent requests share one awaited cleanup per PG pool and method without caching business state', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const gate = deferred(), pool = {}
  let calls = 0, providerCalls = 0
  const store = { pool, async reapStaleReservations() { calls++; await gate.promise; return 100 } }
  const samePool = { pool, reapStaleReservations: (...args) => store.reapStaleReservations(...args),
    async reapStaleCalls() { providerCalls++; return 1 } }
  const requests = Array.from({ length: 300 }, (_, i) => requestMaintenance(i % 2 ? store : samePool))
  await Promise.resolve()
  assert.equal(calls, 1)
  gate.resolve()
  assert.ok((await Promise.all(requests)).every(value => value === 100))
  assert.equal(await requestMaintenance(store), 0)
  assert.equal(await requestMaintenance(samePool, 'reapStaleCalls'), 1)
  assert.equal(providerCalls, 1)
  t.mock.timers.tick(999)
  assert.equal(await requestMaintenance(store), 0)
  t.mock.timers.tick(1)
  assert.equal(await requestMaintenance(store), 100)
  assert.equal(calls, 2)
  // Explicit operator cleanup is never throttled by opportunistic requests.
  assert.equal(await store.reapStaleReservations(), 100)
  assert.equal(calls, 3)
  t.mock.timers.setTime(9000)
  assert.equal(await requestMaintenance(store), 100, 'clock rollback never suppresses a new pass')
})

test('cleanup failures are shared but never cached, pool boundaries and memory stores stay independent', async () => {
  const error = new Error('cleanup failed')
  let calls = 0
  const store = { pool: {}, async reapStaleReservations() { calls++; throw error } }
  const outcomes = await Promise.allSettled(Array.from({ length: 300 }, () => requestMaintenance(store)))
  assert.ok(outcomes.every(item => item.status === 'rejected' && item.reason === error))
  assert.equal(calls, 1)
  await assert.rejects(requestMaintenance(store), e => e === error)
  assert.equal(calls, 2)
  const independent = { ...store, pool: {}, reapStaleReservations: async () => 2 }
  assert.equal(await requestMaintenance(independent), 2)
  let memoryCalls = 0
  const memory = { async reapStaleReservations() { return ++memoryCalls } }
  assert.deepEqual(await Promise.all([requestMaintenance(memory), requestMaintenance(memory)]), [1, 2])
  assert.equal(await requestMaintenance({}, 'reapStaleCalls'), 0)
  assert.throws(() => requestMaintenance(store, 'reserve'), TypeError)
})

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
test('provider cleanup batches at most 100 unknown usages and preserves pending/terminal evidence', {
  skip: !modulePath && 'Requires isolated PGlite SQL fixture',
}, async t => {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`CREATE SCHEMA external_platform;
    CREATE TABLE usage_requests(id uuid PRIMARY KEY,status text);
    CREATE TABLE external_platform.provider_calls(id uuid PRIMARY KEY,usage_request_id uuid,
      outcome text,error_code text,completed_at timestamptz);
    INSERT INTO usage_requests SELECT md5(i::text)::uuid,'unknown' FROM generate_series(1,250) i;
    INSERT INTO external_platform.provider_calls SELECT md5(('call'||i)::text)::uuid,md5(i::text)::uuid,
      'pending',NULL,NULL FROM generate_series(1,250) i;`)
  const store = new PostgresExternalPlatformStore({ pool: { query: (...args) => db.query(...args) } })
  const active = randomUUID(), terminal = randomUUID()
  await db.query("INSERT INTO usage_requests VALUES($1,'reserved'),($2,'unknown')", [active, terminal])
  await db.query("INSERT INTO external_platform.provider_calls VALUES($1,$1,'pending',NULL,NULL),($2,$2,'succeeded',NULL,NULL)", [active, terminal])
  assert.equal(await store.reapStaleCalls(), 100)
  assert.equal(await store.reapStaleCalls(), 100)
  assert.equal(await store.reapStaleCalls(), 50)
  assert.equal(await store.reapStaleCalls(), 0)
  assert.equal((await db.query('SELECT outcome FROM external_platform.provider_calls WHERE id=$1', [active])).rows[0].outcome, 'pending')
  assert.equal((await db.query('SELECT outcome FROM external_platform.provider_calls WHERE id=$1', [terminal])).rows[0].outcome, 'succeeded')
})

const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL
test('native provider cleanup skips a call locked by settlement and does not overwrite its success', {
  skip: !connectionString && 'Requires disposable native PostgreSQL',
}, async t => {
  const schema = `maintenance_${randomUUID().replaceAll('-', '')}`
  const pool = new pg.Pool({ connectionString, max: 3, statement_timeout: 2000 })
  let holder
  t.after(async () => {
    if (holder) { await holder.query('ROLLBACK'); holder.release() }
    try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`) } finally { await pool.end() }
  })
  await pool.query(`CREATE SCHEMA ${schema}; CREATE TABLE ${schema}.requests(id uuid PRIMARY KEY,status text);
    CREATE TABLE ${schema}.calls(id uuid PRIMARY KEY,usage_request_id uuid,outcome text,error_code text,completed_at timestamptz)`)
  const locked = randomUUID(), free = randomUUID()
  await pool.query(`INSERT INTO ${schema}.requests VALUES($1,'unknown'),($2,'unknown')`, [locked, free])
  await pool.query(`INSERT INTO ${schema}.calls VALUES($1,$1,'pending',NULL,NULL),($2,$2,'pending',NULL,NULL)`, [locked, free])
  const store = new PostgresExternalPlatformStore({ pool: { query: (sql, args) => pool.query(sql
    .replaceAll('external_platform.provider_calls', `${schema}.calls`).replaceAll('usage_requests', `${schema}.requests`), args) } })
  holder = await pool.connect()
  await holder.query('BEGIN')
  await holder.query(`SELECT id FROM ${schema}.calls WHERE id=$1 FOR UPDATE`, [locked])
  assert.equal(await store.reapStaleCalls(), 1)
  await holder.query(`UPDATE ${schema}.calls SET outcome='succeeded' WHERE id=$1`, [locked])
  await holder.query('COMMIT')
  assert.equal(await store.reapStaleCalls(), 0)
  assert.equal((await pool.query(`SELECT outcome FROM ${schema}.calls WHERE id=$1`, [locked])).rows[0].outcome, 'succeeded')
})
