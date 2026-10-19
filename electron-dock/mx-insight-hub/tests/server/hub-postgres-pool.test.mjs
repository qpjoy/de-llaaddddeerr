import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { createHubPostgresPool, hubDatabaseFailure } from '../../server/core/postgres-pool.mjs'
import { createApp } from '../../server/app.mjs'

class LocalClient extends EventEmitter {
  _queryable = true
  _ending = false
  queries = []
  connect(callback) { queueMicrotask(() => callback(null)) }
  query(text, values, callback) {
    this.queries.push(text)
    queueMicrotask(() => (typeof values === 'function' ? values : callback)(null, { rows: [] }))
  }
  end(callback) { this._ending = true; queueMicrotask(() => { this.emit('end'); callback?.() }) }
}

test('actual pg-pool removes a timed-out queued query so it cannot execute after capacity returns', async () => {
  const pool = createHubPostgresPool({ Client: LocalClient, max: 1, connectionTimeoutMillis: 20 })
  const held = await pool.connect()
  try {
    const pending = assert.rejects(pool.query('must-not-run-late'), /timeout exceeded when trying to connect/)
    // pg-pool intentionally unrefs its acquisition timer. Keep this fixture
    // alive without a socket, PostgreSQL process, or any real database.
    await Promise.all([pending, delay(40)])
    assert.equal(pool.waitingCount, 0)
    assert.equal(pool.getPressureSnapshot().acquireTimeouts, 1)
    held.release()
    await pool.query('healthy-after-capacity-returns')
    assert.deepEqual(held.queries, ['healthy-after-capacity-returns'])
  } finally { await pool.end() }
})

test('an idle connection error is removed without crashing, leaking the client, or preventing a fresh checkout', async () => {
  const logs = []
  const pool = createHubPostgresPool({ Client: LocalClient, max: 1 }, { logger: { error: value => logs.push(value) } })
  const first = await pool.connect()
  first.release()
  const error = Object.assign(new Error('private SQL and credentials'), { code: '57P01', detail: 'private details' })
  assert.doesNotThrow(() => first.emit('error', error))
  assert.equal(pool.totalCount, 0)
  const second = await pool.connect()
  assert.notEqual(first, second)
  second.release()
  await pool.end()
  assert.deepEqual(logs, [{ event: 'hub_postgres_idle_connection_error', sqlState: '57P01' }])
})

test('runtime pools use server-side SQL limits, preserve explicit options and never install client query deadlines', async () => {
  const pool = createHubPostgresPool({ Client: LocalClient }, { logger: { error() { throw Error('logger failed') } } })
  assert.equal(pool.options.connectionTimeoutMillis, 5000)
  assert.equal(pool.options.statement_timeout, 30000)
  assert.equal(pool.options.lock_timeout, 5000)
  assert.equal(pool.options.max, 10)
  assert.equal(pool.options.query_timeout, undefined)
  assert.doesNotThrow(() => pool.emit('error', Error('private')))
  await pool.end()
  const configured = createHubPostgresPool({ Client: LocalClient, poolSize: 2,
    statement_timeout: 45000, lock_timeout: 0, connectionTimeoutMillis: 1234, maxWaitingClients: 1000 })
  assert.equal(configured.options.max, 2)
  assert.equal(configured.options.statement_timeout, 45000)
  assert.equal(configured.options.lock_timeout, 0)
  assert.equal(configured.options.connectionTimeoutMillis, 1234)
  assert.equal(configured.getPressureSnapshot().maxWaiting, 1000)
  assert.equal(configured.options.maxWaitingClients, undefined)
  await configured.end()
})

test('actual pg-pool absorbs 300 queued operations in FIFO order without opening extra database sessions', async () => {
  const pool = createHubPostgresPool({ Client: LocalClient, max: 1 })
  const held = await pool.connect()
  try {
    const operations = Array.from({ length: 300 }, (_, index) => `burst-${index}`)
    const pending = operations.map(sql => pool.query(sql))
    assert.equal(pool.waitingCount, 300)
    assert.equal(pool.totalCount, 1)
    assert.equal(pool.getPressureSnapshot().waitingHighWatermark, 300)
    held.release()
    await Promise.all(pending)
    assert.deepEqual(held.queries, operations)
    assert.equal(pool.waitingCount, 0)
    assert.equal(pool.totalCount, 1)
    assert.equal(pool.getPressureSnapshot().queueRejected, 0)
  } finally { await pool.end() }
})

test('full checkout queues reject promise and callback queries before SQL, with bounded content-free diagnostics', async () => {
  const logs = []
  const pool = createHubPostgresPool({ Client: LocalClient, max: 1, maxWaitingClients: 2 },
    { logger: { warn: entry => logs.push(entry) } })
  const held = await pool.connect()
  try {
    const pending = [pool.query('first-admitted'), new Promise((resolve, reject) => {
      assert.equal(pool.query('second-admitted', [1], (error, result) => error ? reject(error) : resolve(result)), undefined)
    })]
    await assert.rejects(pool.query('private-rejected-sql'), { code: 'HUB_PG_QUEUE_FULL' })
    await new Promise(resolve => {
      assert.equal(pool.query('private-rejected-callback', error => {
        assert.equal(error.code, 'HUB_PG_QUEUE_FULL')
        resolve()
      }), undefined)
    })
    assert.equal(pool.waitingCount, 2)
    assert.equal(pool.getPressureSnapshot().queueRejected, 2)
    assert.equal(logs.length, 1)
    assert.equal(logs[0].event, 'hub_postgres_queue_full')
    assert.doesNotMatch(JSON.stringify(logs), /private|sql|password|connectionString/)
    held.release()
    await Promise.all(pending)
    assert.deepEqual(held.queries, ['first-admitted', 'second-admitted'])
    await pool.query('capacity-restored')
  } finally { await pool.end() }
})

test('checkout admission retains callback release, transaction ownership and double-release protection', async () => {
  const pool = createHubPostgresPool({ Client: LocalClient, max: 1, maxWaitingClients: 0 },
    { logger: { warn() { throw Error('diagnostic failure') } } })
  try {
    await new Promise((resolve, reject) => {
      assert.equal(pool.connect((error, client, release) => {
        if (error) return reject(error)
        assert.equal(release, client.release)
        client.query('BEGIN', () => {
          // No extra admission occurs inside an owned transaction.
          client.query('transaction-write', () => client.query('COMMIT', () => {
            release()
            assert.throws(() => release(), /already been released/)
            resolve()
          }))
        })
      }), undefined)
    })
    const held = await pool.connect()
    await assert.rejects(pool.connect(), { code: 'HUB_PG_QUEUE_FULL' })
    await new Promise(resolve => pool.connect(error => {
      assert.equal(error.code, 'HUB_PG_QUEUE_FULL')
      resolve()
    }))
    assert.equal(pool.waitingCount, 0)
    held.release()
    await pool.query('healthy-idle-checkout')
  } finally { await pool.end() }
  await assert.rejects(pool.connect(), /Cannot use a pool after calling end/)
})

test('checkout timeout still removes callback work before capacity returns', async () => {
  const pool = createHubPostgresPool({ Client: LocalClient, max: 1, maxWaitingClients: 1, connectionTimeoutMillis: 15 })
  const held = await pool.connect()
  try {
    const timeout = new Promise(resolve => pool.query('callback-must-not-run-late', error => {
      assert.equal(hubDatabaseFailure(error).reason, 'connection_acquire_timeout')
      resolve()
    }))
    await Promise.all([timeout, delay(30)])
    held.release()
    await pool.query('healthy')
    assert.deepEqual(held.queries, ['healthy'])
    assert.equal(pool.getPressureSnapshot().acquireTimeouts, 1)
  } finally { await pool.end() }
})

test('invalid queue bounds are rejected before a database pool is constructed', () => {
  for (const maxWaitingClients of [-1, 0.5, Infinity, '512', NaN]) {
    assert.throws(() => createHubPostgresPool({ maxWaitingClients }), /non-negative safe integer/)
  }
})

test('database failure classification does not guess that upstream network or integrity errors are transient DB faults', () => {
  for (const code of ['55P03', '57014', '53300', '57P01', '08006']) assert.ok(hubDatabaseFailure({ code }))
  for (const code of ['ECONNRESET', 'ETIMEDOUT', '23502', '42P01', 'constructor']) assert.equal(hubDatabaseFailure({ code }), null)
  assert.equal(hubDatabaseFailure(Error('timeout exceeded when trying to connect')).reason, 'connection_acquire_timeout')
  assert.deepEqual(hubDatabaseFailure({ code: 'HUB_PG_QUEUE_FULL' }), { reason: 'connection_queue_full', sqlState: null })
})

test('HTTP database failures remain structured and make no assertion about dispatch or settlement', async () => {
  for (const error of [Object.assign(Error('private SQL'), { code: '57P01' }),
    Object.assign(Error('private SQL'), { code: 'HUB_PG_QUEUE_FULL' }), Error('timeout exceeded when trying to connect')]) {
    const logs = []
    const app = createApp({ store: {}, service: { async authenticate() { throw error } },
      listenerMode: 'public', logger: { error: value => logs.push(value) } })
    const response = new EventEmitter()
    const headers = {}
    response.setHeader = (key, value) => { headers[key.toLowerCase()] = value }
    response.writeHead = (status, values) => { response.statusCode = status; Object.assign(headers, values) }
    response.end = value => { response.body = JSON.parse(value); response.writableEnded = true }
    await app({ method: 'GET', url: '/api/v1/requests/by-idempotency-key',
      headers: { authorization: 'Bearer synthetic-key', 'idempotency-key': 'synthetic-page-key' } }, response)
    assert.equal(response.statusCode, 503)
    assert.match(headers['content-type'], /application\/json/)
    assert.equal(response.body.error.code, 'hub_database_unavailable')
    assert.equal(response.body.error.details.upstreamDispatched, undefined)
    assert.equal(response.body.error.details.retryable, undefined)
    assert.doesNotMatch(JSON.stringify({ logs, body: response.body }), /private SQL|synthetic-key/)
    assert.match(response.body.requestId, /^[a-f0-9-]{36}$/)
  }
})
