// A v2 search that Hub shed before reserving anything must stay retryable with
// its own key; anything that may have reached a reservation or a dispatch keeps
// the existing manual unknown protection.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { AppError } from '../../server/core/errors.mjs'
import { SearchProtocolStore } from '../../server/data/search-protocol-store.mjs'
import { executeDataSearchV2 } from '../../server/data/search-protocol.mjs'
import { normalizeDataSearchV2 } from '../../server/contracts/data-search-v2.mjs'
import {
  currentDatabaseLane, enterAdmissionLane, promoteAdmittedWork, runInDatabaseLane, runWithDatabaseLane,
} from '../../server/core/postgres-pool.mjs'

const pepper = 'offline-search-protocol-pepper-at-least-32-characters'
const context = () => ({ tenant: { id: randomUUID() }, consumer: { id: randomUUID() }, apiKey: { id: randomUUID() } })
const request = () => normalizeDataSearchV2({ platform: 'twitter', query: 'shed fixture', pageSize: 20, type: 'fresh',
  timeWindow: { from: '2026-10-16T16:00:00.000Z', to: '2026-10-17T16:00:00.000Z', timezone: 'Asia/Shanghai', boundary: '[from,to)' } })
const delivered = () => ({ status: 200, requestId: randomUUID(), replay: false, sourceMode: 'live',
  capturedAt: '2026-10-17T15:00:00.000Z', body: { data: { platform: 'twitter', query: 'shed fixture',
    contractVersion: 'night-all.data-search.v1', items: [], status: 'ok', warnings: [],
    pageInfo: { pageIndex: 1, pageSize: 20, returnedCount: 0, hasMore: false, nextCursor: null, cursorType: 'none' },
    meta: { providerCalls: 1 } } } })
const checkoutTimeout = () => new Error('timeout exceeded when trying to connect')

// As app.mjs does for a data request: own lane holder, admission lane, and
// promotion only when a reservation succeeds.
function asDataRequest(operation) {
  return runWithDatabaseLane(() => { enterAdmissionLane(); return operation() })
}

test('a v2 search shed before reservation is retryable and the same key then completes once', async () => {
  const store = new MemoryStore(), ctx = context(), body = request(), key = 'shed-before-reservation'
  let dispatches = 0
  const invoke = execute => asDataRequest(() => executeDataSearchV2({ store, context: ctx, body, idempotencyKey: key, pepper, execute }))
  await assert.rejects(invoke(async () => { throw checkoutTimeout() }), error => {
    assert.equal(error.status, 503)
    assert.equal(error.code, 'hub_database_unavailable')
    assert.equal(error.details.currentAttemptStarted, false)
    assert.equal(error.details.retryAfterMs, 1000)
    return true
  })
  assert.equal((await new SearchProtocolStore(store).binding(ctx, key)).state, 'retryable')
  const first = await invoke(async () => { dispatches++; promoteAdmittedWork(); return delivered() })
  const replay = await invoke(async () => { dispatches++; return delivered() })
  assert.equal(dispatches, 1)
  assert.equal(replay.replay, true)
  assert.deepEqual(replay.body, first.body)
})

test('the reservation layer\'s own not-started 503 is kept and leaves the key retryable', async () => {
  const store = new MemoryStore(), ctx = context(), key = 'reserve-shed'
  await assert.rejects(asDataRequest(() => executeDataSearchV2({ store, context: ctx, body: request(), idempotencyKey: key, pepper,
    execute: async () => { throw new AppError(503, 'usage_admission_unavailable', 'synthetic',
      { stage: 'connection', currentAttemptStarted: false, retryAfterMs: 1000 }) } })),
  error => error.code === 'usage_admission_unavailable' && error.details.currentAttemptStarted === false)
  assert.equal((await new SearchProtocolStore(store).binding(ctx, key)).state, 'retryable')
})

for (const [name, setup, failure] of [
  ['after the reservation succeeded', () => promoteAdmittedWork(), checkoutTimeout],
  ['with a non-database error', () => {}, () => new Error('synthetic dispatch failure')],
  ['outside any HTTP request lane', null, checkoutTimeout],
  ['when the reservation COMMIT was lost', () => {}, () => new AppError(503, 'usage_reservation_persistence_unknown', 'synthetic')],
]) test(`a v2 failure ${name} stays a manual unknown`, async () => {
  const store = new MemoryStore(), ctx = context(), key = `not-shed-${randomUUID()}`
  const run = () => executeDataSearchV2({ store, context: ctx, body: request(), idempotencyKey: key, pepper,
    execute: async () => { setup?.(); throw failure() } })
  await assert.rejects(setup ? asDataRequest(run) : run(),
    error => error.code === 'request_outcome_unknown' && error.details.automaticRetryAllowed === false)
  assert.equal((await new SearchProtocolStore(store).binding(ctx, key)).state, 'unknown')
})

test('a failed outcome lookup still keeps a shed request conservative', async () => {
  const store = new MemoryStore(), ctx = context(), key = 'shed-lookup-failed'
  const lookup = store.getUsageRequestByIdempotencyKey.bind(store)
  let calls = 0
  store.getUsageRequestByIdempotencyKey = async (...args) => {
    if (++calls > 1) throw checkoutTimeout()
    return lookup(...args)
  }
  await assert.rejects(asDataRequest(() => executeDataSearchV2({ store, context: ctx, body: request(), idempotencyKey: key, pepper,
    execute: async () => { throw checkoutTimeout() } })), error => error.code === 'request_outcome_unknown')
  assert.equal((await new SearchProtocolStore(store).binding(ctx, key)).state, 'unknown')
})

test('outcome bookkeeping runs in the top lane without changing the request lane', async () => {
  await asDataRequest(async () => {
    assert.equal(await runInDatabaseLane('default', async () => currentDatabaseLane()), 'default')
    assert.equal(currentDatabaseLane(), 'admission')
  })
  assert.throws(() => runInDatabaseLane('urgent', () => {}), /Unknown database lane/)
})
