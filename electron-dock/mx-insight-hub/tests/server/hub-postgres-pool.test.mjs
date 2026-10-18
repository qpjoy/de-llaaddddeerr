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

test('pool bounds are Hub-local and do not change transaction/query deadlines or retry failed writes', async () => {
  const pool = createHubPostgresPool({ Client: LocalClient, statement_timeout: 30000 }, { logger: { error() { throw Error('logger failed') } } })
  assert.equal(pool.options.connectionTimeoutMillis, 5000)
  assert.equal(pool.options.statement_timeout, 30000)
  assert.equal(pool.options.query_timeout, undefined)
  assert.doesNotThrow(() => pool.emit('error', Error('private')))
  await pool.end()
})

test('database failure classification does not guess that upstream network or integrity errors are transient DB faults', () => {
  for (const code of ['55P03', '57014', '53300', '57P01', '08006']) assert.ok(hubDatabaseFailure({ code }))
  for (const code of ['ECONNRESET', 'ETIMEDOUT', '23502', '42P01', 'constructor']) assert.equal(hubDatabaseFailure({ code }), null)
  assert.equal(hubDatabaseFailure(Error('timeout exceeded when trying to connect')).reason, 'connection_acquire_timeout')
})

test('HTTP database failures remain structured and make no assertion about dispatch or settlement', async () => {
  for (const error of [Object.assign(Error('private SQL'), { code: '57P01' }), Error('timeout exceeded when trying to connect')]) {
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
