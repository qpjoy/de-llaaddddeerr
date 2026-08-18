import assert from 'node:assert/strict'
import test from 'node:test'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

const CONSUMER = '33333333-3333-4333-8333-333333333333'

/**
 * Drive `reserve` against one pre-existing committed request.
 *
 * Only the branch under test is modelled: the advisory lock, quota check and
 * transaction control all return empty result sets, which is what the real
 * statements yield when they succeed.
 */
function storeWithCommittedRequest({ completedAt }) {
  const statements = []
  const committed = {
    id: '44444444-4444-4444-8444-444444444444',
    consumer_id: CONSUMER,
    idempotency_key: 'search-abc12345',
    fingerprint: 'fp-1',
    status: 'committed',
    response_status: 200,
    response_body: { data: { items: ['stale'] } },
    completed_at: completedAt,
  }
  const client = {
    async query(sql, values) {
      statements.push(sql.trim().split('\n')[0].trim())
      if (sql.includes('FROM usage_requests')) return { rows: [committed] }
      if (sql.startsWith('UPDATE usage_requests')) {
        return { rows: [{ ...committed, status: 'reserved', response_body: null, completed_at: null }] }
      }
      if (sql.includes('count(*)')) return { rows: [{ count: '0' }] }
      return { rows: [], rowCount: 0 }
    },
    release() {},
  }
  return {
    store: new PostgresStore({ async connect() { return client } }),
    statements,
  }
}

function input(overrides = {}) {
  return {
    requestId: '55555555-5555-4555-8555-555555555555',
    idempotencyKey: 'search-abc12345',
    fingerprint: 'fp-1',
    tenantId: '66666666-6666-4666-8666-666666666666',
    consumerId: CONSUMER,
    apiKeyId: '77777777-7777-4777-8777-777777777777',
    platform: 'telegram',
    unitsReserved: 1,
    leaseExpiresAt: new Date(Date.now() + 30_000),
    windowStart: new Date(Date.now() - 3_600_000),
    maxRequests: 1_000,
    ...overrides,
  }
}

test('a retry inside the window still replays the stored response', async () => {
  const { store } = storeWithCommittedRequest({ completedAt: new Date(Date.now() - 5_000) })
  const reservation = await store.reserve(input({ replayWindowMs: 120_000 }))
  // This is the case an Idempotency-Key exists for: a duplicate delivery must
  // not search or charge twice.
  assert.equal(reservation.kind, 'replay')
  assert.deepEqual(reservation.request.responseBody, { data: { items: ['stale'] } })
})

test('the same key asked again much later re-executes against current data', async () => {
  const { store } = storeWithCommittedRequest({ completedAt: new Date(Date.now() - 3_600_000) })
  const reservation = await store.reserve(input({ replayWindowMs: 120_000 }))
  // An hour later the corpus has moved; returning the frozen answer would make
  // the key a cache rather than a retry guard.
  assert.equal(reservation.kind, 'reserved')
})

test('a stable request keeps replaying forever', async () => {
  const { store } = storeWithCommittedRequest({ completedAt: new Date('2026-01-01T00:00:00.000Z') })
  // No window: one key names one immutable answer, which is the whole point of
  // the stable result type.
  const reservation = await store.reserve(input({ replayWindowMs: null }))
  assert.equal(reservation.kind, 'replay')
})

test('re-executing after the window still re-checks quota', async () => {
  const { store, statements } = storeWithCommittedRequest({ completedAt: new Date(Date.now() - 3_600_000) })
  await store.reserve(input({ replayWindowMs: 120_000 }))
  // A fresh execution consumes quota like any other; it is not a free replay,
  // and it reuses the existing row rather than orphaning the key.
  assert.ok(statements.some((statement) => statement.startsWith('UPDATE usage_requests')))
  assert.ok(statements.some((statement) => statement.startsWith('COMMIT')))
})

test('a different body under the same key is still a conflict, window or not', async () => {
  const { store } = storeWithCommittedRequest({ completedAt: new Date(Date.now() - 3_600_000) })
  const reservation = await store.reserve(input({ fingerprint: 'fp-2', replayWindowMs: 120_000 }))
  assert.equal(reservation.kind, 'conflict')
})
