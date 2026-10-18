import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE

test('reservation lock timeout rolls back before returning a safe unavailable response', async () => {
  const commands = []
  let released = false
  const failure = Object.assign(new Error('private database detail'), { code: '55P03' })
  const store = new PostgresStore({ connect: async () => ({
    async query(sql) {
      commands.push(sql)
      if (sql.includes('pg_advisory_xact_lock')) throw failure
      return { rows: [] }
    },
    release() { released = true },
  }) })
  await assert.rejects(store.reserve({ tenantId: randomUUID(), consumerId: randomUUID(),
    apiKeyId: randomUUID(), platform: 'twitter', idempotencyKey: 'unchanged-key' }), error => {
    assert.equal(error.status, 503)
    assert.equal(error.code, 'usage_admission_unavailable')
    assert.equal(error.cause, failure)
    assert.equal(Object.hasOwn(error.details, 'upstreamDispatched'), false)
    assert.equal(error.message.includes('private'), false)
    return true
  })
  assert.deepEqual(commands.slice(0, 3), [
    'BEGIN', "SET LOCAL lock_timeout = '5s'", "SET LOCAL statement_timeout = '15s'",
  ])
  assert.equal(commands.at(-1), 'ROLLBACK')
  assert.equal(commands.some(sql => sql.includes('INSERT INTO usage_requests')), false)
  assert.equal(released, true)
})

test('reservation connection acquisition failures never start a transaction', async () => {
  const store = new PostgresStore({ connect: async () => { throw new Error('connection timeout: private-host') } })
  await assert.rejects(store.reserve({ platform: 'twitter' }), error => {
    assert.equal(error.status, 503)
    assert.equal(error.code, 'usage_admission_unavailable')
    assert.equal(error.details.stage, 'connection')
    assert.equal(Object.hasOwn(error.details, 'upstreamDispatched'), false)
    assert.equal(error.message.includes('private-host'), false)
    return true
  })
})

test('a lost reservation COMMIT acknowledgement keeps its durable identity and discards the connection', async () => {
  const commands = [], existingId = randomUUID(), keyId = randomUUID()
  const failure = Object.assign(new Error('lost commit acknowledgement'), { code: '57014' })
  let releasedWith
  const store = new PostgresStore({ connect: async () => ({
    async query(sql) {
      commands.push(sql)
      if (sql === 'COMMIT') throw failure
      if (sql.includes('FOR SHARE')) return { rowCount: 1, rows: [{ id: keyId }] }
      if (sql.includes('JOIN platform_grants')) return { rows: [{ max_requests: 100, window_seconds: 3600 }] }
      if (sql.includes('JOIN usage_requests request')) return { rows: [{ id: existingId,
        api_key_id: keyId, fingerprint: 'a'.repeat(64), status: 'reserved' }] }
      return { rows: [] }
    },
    release(error) { releasedWith = error },
  }) })
  await assert.rejects(store.reserve({ requestId: randomUUID(), tenantId: randomUUID(), consumerId: randomUUID(),
    apiKeyId: keyId, platform: 'twitter', fingerprint: 'a'.repeat(64), idempotencyKey: 'same-key' }), error => {
    assert.equal(error.code, 'usage_reservation_persistence_unknown')
    assert.equal(error.details.requestId, existingId)
    assert.equal(Object.hasOwn(error.details, 'upstreamDispatched'), false)
    assert.equal(error.preserveReservation, true)
    assert.equal(error.cause, failure)
    return true
  })
  assert.equal(commands.includes('ROLLBACK'), false)
  assert.equal(commands.some(sql => sql.includes('INSERT INTO usage_requests')), false)
  assert.equal(releasedWith, failure)
})

test('failed rollback cannot return a connection with an open transaction to the pool', async () => {
  const failure = Object.assign(new Error('lock cancelled'), { code: '55P03' })
  const rollbackFailure = new Error('connection lost during rollback')
  let releasedWith
  const store = new PostgresStore({ connect: async () => ({
    async query(sql) {
      if (sql.includes('pg_advisory_xact_lock')) throw failure
      if (sql === 'ROLLBACK') throw rollbackFailure
      return { rows: [] }
    },
    release(error) { releasedWith = error },
  }) })
  await assert.rejects(store.reserve({ platform: 'twitter' }), { code: 'usage_admission_unavailable' })
  assert.equal(releasedWith, rollbackFailure)
})

test('failed reaper rollback discards its connection while preserving the original safe failure', async () => {
  const failure = Object.assign(new Error('private lock detail'), { code: '55P03' })
  const rollbackFailure = new Error('connection lost during rollback')
  let releasedWith
  const store = new PostgresStore({ connect: async () => ({
    async query(sql) {
      if (sql.includes('SELECT id FROM usage_requests')) return { rows: [{ id: randomUUID() }] }
      if (sql.includes('FOR UPDATE OF call SKIP LOCKED')) throw failure
      if (sql === 'ROLLBACK') throw rollbackFailure
      return { rows: [] }
    },
    release(error) { releasedWith = error },
  }) })
  await assert.rejects(store.reapStaleReservations(), error => {
    assert.equal(error.code, 'usage_admission_unavailable')
    assert.equal(error.details.stage, 'recovery')
    assert.equal(error.cause, failure)
    return true
  })
  assert.equal(releasedWith, rollbackFailure)
})

test('usage reaper bounds each batch and closes only expired pending calls atomically', {
  skip: !modulePath ? 'Set MX_INSIGHT_TEST_PGLITE_MODULE for the real SQL fixture' : false,
}, async t => {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`CREATE SCHEMA serving; CREATE SCHEMA external_platform;
    CREATE TABLE usage_requests(id uuid PRIMARY KEY, status text, lease_expires_at timestamptz,
      error_code text, completed_at timestamptz);
    CREATE TABLE serving.connector_calls(id uuid PRIMARY KEY,usage_request_id uuid,
      outcome text,business_status text,failure_kind text,error_code text,completed_at timestamptz);
    CREATE TABLE external_platform.provider_calls(id uuid PRIMARY KEY,usage_request_id uuid,
      outcome text,error_code text,completed_at timestamptz);`)
  const statements = []
  const query = async (sql, args) => { statements.push(sql); return db.query(sql, args) }
  const store = new PostgresStore({ query, connect: async () => ({ query, release() {} }) })
  const expired = Array.from({ length: 101 }, () => randomUUID())
  for (const id of expired) await db.query(`INSERT INTO usage_requests VALUES($1,'reserved',now()-interval '1 minute',NULL,NULL)`, [id])
  const future = randomUUID(), completed = randomUUID()
  await db.query(`INSERT INTO usage_requests VALUES($1,'reserved',now()+interval '1 hour',NULL,NULL),
    ($2,'committed',now()-interval '1 hour',NULL,now())`, [future, completed])
  const pendingCall = randomUUID(), terminalCall = randomUUID(), connector = randomUUID()
  await db.query(`INSERT INTO external_platform.provider_calls VALUES
    ($1,$3,'pending',NULL,NULL),($2,$3,'succeeded',NULL,now())`, [pendingCall, terminalCall, expired[0]])
  await db.query(`INSERT INTO serving.connector_calls VALUES($1,$2,NULL,NULL,NULL,NULL,NULL)`, [connector, expired[0]])
  assert.equal(await store.reapStaleReservations(), 100)
  assert.equal(await store.reapStaleReservations(), 1)
  assert.equal(await store.reapStaleReservations(), 0)
  const requests = await db.query('SELECT status,count(*)::int AS count FROM usage_requests GROUP BY status')
  assert.deepEqual(Object.fromEntries(requests.rows.map(row => [row.status, row.count])), { unknown: 101, reserved: 1, committed: 1 })
  assert.equal((await db.query('SELECT outcome FROM external_platform.provider_calls WHERE id=$1', [pendingCall])).rows[0].outcome, 'unknown')
  assert.equal((await db.query('SELECT outcome FROM external_platform.provider_calls WHERE id=$1', [terminalCall])).rows[0].outcome, 'succeeded')
  assert.equal((await db.query('SELECT outcome FROM serving.connector_calls WHERE id=$1', [connector])).rows[0].outcome, 'unknown')
  const callLock = statements.findIndex(sql => sql.includes('FOR UPDATE OF call SKIP LOCKED'))
  const usageLock = statements.findIndex(sql => sql.includes('FOR UPDATE OF request SKIP LOCKED'))
  assert.ok(callLock >= 0 && usageLock > callLock)
})

const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL
for (const lockedTable of ['providers', 'connectors', 'requests']) {
  test(`native PostgreSQL reaper skips a locked ${lockedTable} row without blocking settlement`, {
    skip: !connectionString ? 'Requires disposable PostgreSQL; PGlite cannot verify multi-session locks' : false,
  }, async t => {
    const schema = `reaper_${randomUUID().replaceAll('-', '')}`
    const pool = new pg.Pool({ connectionString, max: 3, connectionTimeoutMillis: 2000, statement_timeout: 2000 })
    let holder
    t.after(async () => {
      if (holder) { await holder.query('ROLLBACK'); holder.release() }
      try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`) }
      finally { await pool.end() }
    })
    await pool.query(`CREATE SCHEMA ${schema}`)
    await pool.query(`CREATE TABLE ${schema}.requests(id uuid PRIMARY KEY,status text,lease_expires_at timestamptz,
      error_code text,completed_at timestamptz);
      CREATE TABLE ${schema}.providers(id uuid PRIMARY KEY,usage_request_id uuid,outcome text,error_code text,completed_at timestamptz);
      CREATE TABLE ${schema}.connectors(id uuid PRIMARY KEY,usage_request_id uuid,outcome text,business_status text,
      failure_kind text,error_code text,completed_at timestamptz);`)
    const busy = randomUUID(), free = randomUUID(), provider = randomUUID(), connector = randomUUID()
    await pool.query(`INSERT INTO ${schema}.requests VALUES($1,'reserved',now()-interval '1 minute',NULL,NULL),
      ($2,'reserved',now()-interval '1 minute',NULL,NULL)`, [busy, free])
    await pool.query(`INSERT INTO ${schema}.providers VALUES($1,$2,'pending',NULL,NULL)`, [provider, busy])
    await pool.query(`INSERT INTO ${schema}.connectors VALUES($1,$2,NULL,NULL,NULL,NULL,NULL)`, [connector, busy])
    // Only table identities change; exercise the production SQL against real
    // PostgreSQL row locks in an isolated schema, never production records.
    const rewrite = sql => sql.replaceAll('external_platform.provider_calls', `${schema}.providers`)
      .replaceAll('serving.connector_calls', `${schema}.connectors`).replaceAll('usage_requests', `${schema}.requests`)
    const store = new PostgresStore({ connect: async () => {
      const client = await pool.connect()
      return { query: (sql, args) => client.query(rewrite(sql), args), release: error => client.release(error) }
    } })
    holder = await pool.connect()
    await holder.query('BEGIN')
    const lockedId = { providers: provider, connectors: connector, requests: busy }[lockedTable]
    await holder.query(`SELECT id FROM ${schema}.${lockedTable} WHERE id=$1 FOR UPDATE`, [lockedId])
    assert.equal(await store.reapStaleReservations(), 1)
    assert.equal((await pool.query(`SELECT status FROM ${schema}.requests WHERE id=$1`, [busy])).rows[0].status, 'reserved')
    // The reaper must not retain the usage lock while waiting for this call.
    await holder.query(`UPDATE ${schema}.providers SET outcome='succeeded' WHERE id=$1`, [provider])
    await holder.query(`UPDATE ${schema}.connectors SET outcome='complete' WHERE id=$1`, [connector])
    await holder.query(`UPDATE ${schema}.requests SET status='committed' WHERE id=$1`, [busy])
    await holder.query('COMMIT')
    assert.equal(await store.reapStaleReservations(), 0)
    assert.equal((await pool.query(`SELECT status FROM ${schema}.requests WHERE id=$1`, [busy])).rows[0].status, 'committed')
  })
}
