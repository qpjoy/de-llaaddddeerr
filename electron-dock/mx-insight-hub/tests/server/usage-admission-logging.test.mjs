import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createApp } from '../../server/app.mjs'
import { AppError } from '../../server/core/errors.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

async function requestWithFailure(operation, logger) {
  const app = createApp({ store: {}, listenerMode: 'public', logger, service: {
    authenticate: async () => ({ consumer: { id: 'consumer' }, apiKey: { id: 'key' } }),
    search: async (_context, input) => {
      assert.equal(input.idempotencyKey, 'original-page-key')
      return operation(input)
    },
  } })
  const response = new EventEmitter(), headers = {}
  response.setHeader = (key, value) => { headers[key.toLowerCase()] = value }
  response.writeHead = (status, values) => { response.statusCode = status; Object.assign(headers, values) }
  response.end = value => { response.body = JSON.parse(value); response.writableEnded = true }
  const request = Object.assign(new EventEmitter(), { method: 'POST', url: '/api/v1/data/search',
    headers: { authorization: 'Bearer private-fixture-key', 'idempotency-key': 'original-page-key',
      'content-type': 'application/json' } })
  request[Symbol.asyncIterator] = async function * () { yield Buffer.from('{"platform":"twitter","query":"private query"}') }
  await app(request, response)
  return { response, headers }
}

test('pre-reservation failures retain safe database evidence under the HTTP request ID', async t => {
  const cases = [
    { stage: 'connection', cause: Error('timeout exceeded when trying to connect'), reason: 'connection_acquire_timeout', sqlState: null },
    { stage: 'connection', cause: Object.assign(Error('private host'), { code: 'ECONNREFUSED' }), reason: 'admission_unavailable', sqlState: null },
    { stage: 'reservation', cause: Object.assign(Error('private SQL'), { code: '55P03' }), reason: 'lock_timeout', sqlState: '55P03' },
    { stage: 'reservation', cause: Object.assign(Error('private SQL'), { code: '57014' }), reason: 'statement_cancelled', sqlState: '57014' },
    { stage: 'reservation', cause: Object.assign(Error('private SQL'), { code: '40P01' }), reason: 'deadlock', sqlState: '40P01' },
    { stage: 'recovery', cause: Object.assign(Error('private SQL'), { code: '55P03' }), reason: 'lock_timeout', sqlState: '55P03' },
  ]
  for (const entry of cases) await t.test(`${entry.stage}: ${entry.reason}`, async () => {
    const logs = [], commands = []
    entry.cause.detail = 'private SQL and parameters'
    const store = new PostgresStore({ connect: async () => {
      if (entry.stage === 'connection') throw entry.cause
      return {
        query: async sql => {
          commands.push(sql)
          if (sql.includes('pg_advisory_xact_lock') || sql.includes('SELECT id FROM usage_requests')) throw entry.cause
          return { rows: [] }
        }, release() {},
      }
    } })
    const { response, headers } = await requestWithFailure(input => entry.stage === 'recovery'
      ? store.reapStaleReservations()
      : store.reserve({ platform: 'twitter', ...input }), { error: value => logs.push(value) })
    assert.equal(response.statusCode, 503)
    assert.equal(headers['retry-after'], '1')
    assert.deepEqual(response.body.error, {
      code: 'usage_admission_unavailable',
      message: 'Hub request admission is temporarily unavailable; check the same idempotency key before retrying',
      details: { stage: entry.stage, currentAttemptStarted: false, retryAfterMs: 1000 },
    })
    assert.match(response.body.requestId, /^[a-f0-9-]{36}$/u)
    assert.deepEqual(logs, [{ requestId: response.body.requestId, event: 'hub_database_request_failed',
      errorCode: 'usage_admission_unavailable', stage: entry.stage, reason: entry.reason, sqlState: entry.sqlState }])
    assert.doesNotMatch(JSON.stringify({ logs, body: response.body }), /private|original-page-key|ECONNREFUSED/u)
    assert.equal(commands.includes('COMMIT'), false)
    assert.equal(commands.some(sql => sql.includes('INSERT INTO usage_requests')), false)
    if (entry.stage !== 'connection') assert.equal(commands.at(-1), 'ROLLBACK')
  })
})

test('admission logging failure cannot replace the original response or retry guidance', async () => {
  const store = new PostgresStore({ connect: async () => { throw Error('timeout exceeded when trying to connect') } })
  const { response, headers } = await requestWithFailure(input => store.reserve({ platform: 'twitter', ...input }),
    { error() { throw Error('logging unavailable') } })
  assert.equal(response.statusCode, 503)
  assert.equal(response.body.error.code, 'usage_admission_unavailable')
  assert.equal(response.body.error.details.currentAttemptStarted, false)
  assert.equal(headers['retry-after'], '1')
})

test('other application errors are not reclassified by an attached database cause', async () => {
  const logs = []
  const error = new AppError(503, 'usage_reservation_persistence_unknown', 'Reservation outcome is unknown',
    { requestId: '97a61bef-c5b8-4d70-9638-6a966d1e2fdd', stage: 'reservation_commit' })
  error.cause = Object.assign(Error('private SQL'), { code: '57014' })
  const { response, headers } = await requestWithFailure(() => { throw error }, { error: value => logs.push(value) })
  assert.equal(response.statusCode, 503)
  assert.equal(response.body.error.code, 'usage_reservation_persistence_unknown')
  assert.equal(response.body.error.details.currentAttemptStarted, undefined)
  assert.equal(response.body.requestId, error.details.requestId)
  assert.equal(headers['retry-after'], undefined)
  assert.deepEqual(logs, [])
})
