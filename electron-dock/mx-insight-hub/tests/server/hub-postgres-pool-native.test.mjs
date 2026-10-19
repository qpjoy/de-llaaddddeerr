import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { createHubPostgresPool } from '../../server/core/postgres-pool.mjs'

const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL
const native = { skip: !connectionString && 'Requires disposable native PostgreSQL' }
const quiet = { error() {}, warn() {} }

test('native PG drains 300 queued writes with bounded connections and retains every row', native, async t => {
  const pool = createHubPostgresPool({ connectionString, max: 2 }, { logger: quiet })
  const table = `pressure_${randomUUID().replaceAll('-', '')}`
  const holders = []
  t.after(async () => {
    for (const release of holders.splice(0)) release()
    try { await pool.query(`DROP TABLE IF EXISTS ${table}`) } finally { await pool.end() }
  })
  await pool.query(`CREATE TABLE ${table}(id integer PRIMARY KEY)`)
  for (let i = 0; i < 2; i++) {
    const client = await pool.connect()
    holders.push(() => client.release())
  }
  const writes = Array.from({ length: 300 }, (_, id) => pool.query(`INSERT INTO ${table} VALUES($1)`, [id]))
  assert.equal(pool.getPressureSnapshot().waitingConnections, 300)
  assert.equal(pool.getPressureSnapshot().totalConnections, 2)
  for (const release of holders.splice(0)) release()
  await Promise.all(writes)
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 300)
  assert.equal(pool.getPressureSnapshot().waitingHighWatermark, 300)
  assert.ok(pool.getPressureSnapshot().totalConnections <= 2)
})

test('native PG enforces server-side timeouts, cancels the write and leaves the client reusable after rollback', native, async t => {
  const pool = createHubPostgresPool({ connectionString, max: 2 }, { logger: quiet })
  const table = `pressure_${randomUUID().replaceAll('-', '')}`
  let client
  t.after(async () => {
    if (client) { await client.query('ROLLBACK').catch(() => {}); client.release() }
    try { await pool.query(`DROP TABLE IF EXISTS ${table}`) } finally { await pool.end() }
  })
  await pool.query(`CREATE TABLE ${table}(id integer PRIMARY KEY)`)
  client = await pool.connect()
  assert.equal((await client.query('SHOW statement_timeout')).rows[0].statement_timeout, '30s')
  assert.equal((await client.query('SHOW lock_timeout')).rows[0].lock_timeout, '5s')
  await client.query('BEGIN')
  await client.query("SET LOCAL statement_timeout = '30ms'")
  await assert.rejects(client.query(`INSERT INTO ${table} SELECT 1 FROM pg_sleep(1)`), { code: '57014' })
  await client.query('ROLLBACK')
  assert.equal((await client.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 0)
  assert.equal((await client.query('SELECT 1 AS healthy')).rows[0].healthy, 1)
  await client.query(`INSERT INTO ${table} VALUES(1)`)
  await client.query('BEGIN')
  await client.query(`UPDATE ${table} SET id=1 WHERE id=1`)
  const waiter = await pool.connect()
  try {
    await waiter.query('BEGIN')
    await waiter.query("SET LOCAL lock_timeout = '30ms'")
    await assert.rejects(waiter.query(`UPDATE ${table} SET id=2 WHERE id=1`), { code: '55P03' })
    await waiter.query('ROLLBACK')
  } finally { waiter.release() }
  await client.query('COMMIT')
  assert.equal((await client.query(`SELECT id FROM ${table}`)).rows[0].id, 1)
})
