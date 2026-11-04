import test from 'node:test'
import assert from 'node:assert/strict'
import { SearchProtocolStore } from '../../server/data/search-protocol-store.mjs'
import { assertTwitterSearchAvailable } from '../../server/data/twitter-search-availability.mjs'
import { searchAdmissionDispositionFixture, pgOptions } from '../fixtures/search-admission-disposition.mjs'

test('an ended unknown does not hold a new v2 window; disposition still records without changing old identity or evidence', pgOptions, async t => {
  const f = await searchAdmissionDispositionFixture(t), protocol = new SearchProtocolStore({ pool: f.pool })
  const nextBody = { ...f.body, timeWindow: { ...f.body.timeWindow, from: '2026-10-28T00:00:00.000Z', to: '2026-10-28T01:00:00.000Z' } }
  const tables = ['usage_requests', 'external_platform.provider_calls', 'billing.customer_charges', 'billing.credit_ledger_entries', 'control.data_search_protocol_bindings']
  const before = await Promise.all(tables.map(name => f.db.query(`SELECT * FROM ${name}`)))
  const lease = await protocol.begin(f.ctx, { version: 2, body: nextBody, idempotencyKey: 'next-scheduled-window' })
  assert.equal(lease.kind, 'acquired')
  assert.deepEqual(lease.acknowledgedRequestIds, [])
  await protocol.finish(lease.input, { state: 'retryable' })
  // Manual recovery stays available and auditable; it changes no historical row.
  const recorded = await f.resolve()
  assert.ok(recorded)
  const after = await Promise.all(tables.map(name => f.db.query(`SELECT * FROM ${name}`)))
  for (let i = 0; i < tables.length - 1; i++) assert.deepEqual(after[i].rows, before[i].rows)
  await assert.rejects(() => protocol.begin(f.ctx, { version: 2, body: f.body, idempotencyKey: f.key }), { code: 'request_outcome_unknown' })
  await assert.rejects(() => protocol.begin(f.ctx, { version: 2, body: nextBody, idempotencyKey: f.key }), { code: 'idempotency_conflict' })
  assert.equal((await f.db.query('SELECT status FROM usage_requests WHERE id=$1', [f.id])).rows[0].status, 'unknown')
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM external_platform.provider_calls')).rows[0].n, 1)
})

test('protocol and Twitter query guards hold a new key only behind an in-flight equal search', pgOptions, async t => {
  const f = await searchAdmissionDispositionFixture(t), protocol = new SearchProtocolStore({ pool: f.pool })
  await f.addUnknown()
  await assertTwitterSearchAvailable({ usageStore: { pool: f.pool }, context: f.ctx, query: f.body.query })
  const lease = await protocol.begin(f.ctx, { version: 2, body: f.body, idempotencyKey: 'next-window' })
  await protocol.finish(lease.input, { state: 'retryable' })
  const running = await f.addUnknown({ status: 'reserved', protocol: false, withCall: false })
  await f.db.query("UPDATE usage_requests SET lease_expires_at=now()+interval '2 minutes' WHERE id=$1", [running.id])
  await assert.rejects(() => protocol.begin(f.ctx, { version: 2, body: f.body, idempotencyKey: 'another-window' }),
    error => error.code === 'search_admission_blocked' && error.details.blockingRequestId === running.id
      && error.details.retryAfterSeconds > 0 && error.details.retryAfterSeconds <= 120)
  await assert.rejects(() => assertTwitterSearchAvailable({ usageStore: { pool: f.pool }, context: f.ctx, query: f.body.query }),
    error => error.code === 'request_in_progress' && error.details.blockingRequestId === running.id)
  await f.db.query("UPDATE usage_requests SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [running.id])
  await assertTwitterSearchAvailable({ usageStore: { pool: f.pool }, context: f.ctx, query: f.body.query })
})

test('a legacy Twitter unknown does not hold a new key and its old key is not converted to v2', pgOptions, async t => {
  const f = await searchAdmissionDispositionFixture(t, { v2: false }), protocol = new SearchProtocolStore({ pool: f.pool })
  const lease = await protocol.begin(f.ctx, { version: 2, body: f.body, idempotencyKey: 'new-key' })
  await protocol.finish(lease.input, { state: 'retryable' })
  await assert.rejects(() => protocol.begin(f.ctx, { version: 2, body: f.body, idempotencyKey: f.key }), { code: 'idempotency_conflict' })
})

test('equivalent queries and an expired running binding do not hold a new search', pgOptions, async t => {
  const f = await searchAdmissionDispositionFixture(t), protocol = new SearchProtocolStore({ pool: f.pool })
  await assertTwitterSearchAvailable({ usageStore: { pool: f.pool }, context: f.ctx, query: 'offline AND disposition AND fixture' })
  await assertTwitterSearchAvailable({ usageStore: { pool: f.pool }, context: f.ctx, query: ` ${f.body.query} ` })
  await f.db.query("UPDATE control.data_search_protocol_bindings SET state='running' WHERE usage_request_id=$1", [f.id])
  const lease = await protocol.begin(f.ctx, { version: 2, body: f.body, idempotencyKey: 'new-key' })
  assert.equal(lease.kind, 'acquired')
  await protocol.finish(lease.input, { state: 'retryable' })
  await assert.rejects(() => protocol.begin(f.ctx, { version: 2, body: f.body, idempotencyKey: f.key }), { code: 'request_outcome_unknown' })
})
