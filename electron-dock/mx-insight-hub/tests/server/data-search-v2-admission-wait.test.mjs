import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { executeDataSearchV2, SEARCH_ADMISSION_WAIT_MS } from '../../server/data/search-protocol.mjs'
import { normalizeDataSearchV2, DATA_SEARCH_V1_PATH } from '../../server/contracts/data-search-v2.mjs'

const pepper = 'offline-search-protocol-pepper-at-least-32-characters'
const context = () => ({ tenant: { id: randomUUID() }, consumer: { id: randomUUID() }, apiKey: { id: randomUUID() } })
const request = normalizeDataSearchV2({ platform: 'twitter', query: 'admission wait fixture', pageSize: 20, type: 'fresh',
  timeWindow: { from: '2026-10-16T16:00:00.000Z', to: '2026-10-17T16:00:00.000Z', timezone: 'Asia/Shanghai', boundary: '[from,to)' } })
const delivery = () => ({ status: 200, requestId: randomUUID(), replay: false, sourceMode: 'live',
  capturedAt: '2026-10-17T15:00:00.000Z', body: { data: { platform: 'twitter', query: request.query, contractVersion: 'night-all.data-search.v1',
    items: [{ id: 'hit', publishedAt: request.timeWindow.from }], status: 'ok', warnings: [],
    pageInfo: { pageIndex: 1, pageSize: 20, returnedCount: 1, hasMore: false, nextCursor: null, cursorType: 'none' }, meta: { providerCalls: 1 } } } })

// Another key's equal search, reserved and still inside its lease.
function fixture() {
  const store = new MemoryStore(), ctx = context()
  const blocker = { id: randomUUID(), tenantId: ctx.tenant.id, consumerId: ctx.consumer.id, apiKeyId: ctx.apiKey.id,
    platform: 'twitter', idempotencyKey: randomUUID(), status: 'reserved', billingMeterKey: 'twitter', fingerprint: 'a'.repeat(64),
    acquisitionRequest: { path: DATA_SEARCH_V1_PATH, body: { platform: 'twitter', query: request.query } },
    reservedAt: new Date(Date.now() - 5_000).toISOString(), leaseExpiresAt: new Date(Date.now() + 175_000).toISOString() }
  store.requests.set(blocker.id, blocker)
  let clock = 0, calls = 0
  const sleeps = []
  const run = ({ admissionWaitMs = SEARCH_ADMISSION_WAIT_MS, onSleep = () => {}, signal = null, idempotencyKey = 'waiting-page', body = request } = {}) =>
    executeDataSearchV2({ store, context: ctx, body, idempotencyKey, pepper, admissionWaitMs, signal,
      now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms; onSleep(sleeps.length) },
      execute: async () => { calls++; return delivery() } })
  return { blocker, sleeps, run, calls: () => calls }
}
const refused = blocker => error => error.code === 'search_admission_blocked' && error.details.dispatchState === 'not_started'
  && error.details.blockingRequestId === blocker.id && error.details.retryAfterSeconds > 0

test('v2 waits for an equal search still in flight and then admits the new page itself', async () => {
  const { blocker, sleeps, run, calls } = fixture()
  const delivered = await run({ onSleep: count => { if (count === 3) blocker.status = 'committed' } })
  assert.equal(delivered.status, 200)
  assert.deepEqual(delivered.body.data.items.map(item => item.id), ['hit'])
  assert.deepEqual(sleeps, [1000, 1000, 1000])
  assert.equal(calls(), 1)
})

test('v2 returns the original admission refusal once the bounded wait is spent', async () => {
  const { blocker, sleeps, run, calls } = fixture()
  await assert.rejects(run({ admissionWaitMs: 2_500 }), refused(blocker))
  assert.deepEqual(sleeps, [1000, 1000, 500])
  assert.equal(calls(), 0)
  // The refused page stays unsent: the same key is admitted once the blocker ends.
  blocker.status = 'committed'
  assert.equal((await run({ admissionWaitMs: 0 })).status, 200)
  assert.equal(calls(), 1)
})

test('v2 stops waiting when the caller disconnects and never dispatches', async () => {
  const { blocker, sleeps, run, calls } = fixture(), controller = new AbortController()
  await assert.rejects(run({ signal: controller.signal, onSleep: () => controller.abort() }), refused(blocker))
  assert.equal(sleeps.length, 1)
  assert.equal(calls(), 0)
})

test('v2 waits only for in-flight admission; other refusals and the default return at once', async () => {
  const { blocker, sleeps, run, calls } = fixture()
  await assert.rejects(run({ admissionWaitMs: 0 }), refused(blocker))
  blocker.status = 'committed'
  await run({ idempotencyKey: 'completed-page' })
  const changed = { ...request, timeWindow: { ...request.timeWindow, to: '2026-10-17T17:00:00.000Z' } }
  await assert.rejects(run({ idempotencyKey: 'completed-page', body: changed }), error => error.code === 'idempotency_conflict')
  assert.deepEqual(sleeps, [])
  assert.equal(calls(), 1)
})
