import test from 'node:test'
import assert from 'node:assert/strict'
import { SearchProtocolStore } from '../../server/data/search-protocol-store.mjs'
import { assertTwitterSearchAvailable } from '../../server/data/twitter-search-availability.mjs'
import { searchAdmissionDispositionFixture, pgOptions } from '../fixtures/search-admission-disposition.mjs'

test('administrative disposition restores a new v2 window without changing old identity, evidence or retry ancestry', pgOptions, async t => {
  const f = await searchAdmissionDispositionFixture(t), protocol = new SearchProtocolStore({ pool: f.pool })
  const nextBody = { ...f.body, timeWindow: { ...f.body.timeWindow, from: '2026-10-28T00:00:00.000Z', to: '2026-10-28T01:00:00.000Z' } }
  const invoke = () => protocol.begin(f.ctx, { version: 2, body: nextBody, idempotencyKey: 'next-scheduled-window' })
  await assert.rejects(invoke, error => error.code === 'search_admission_blocked' && error.details.blockingRequestId === f.id)
  const tables = ['usage_requests', 'external_platform.provider_calls', 'billing.customer_charges', 'billing.credit_ledger_entries', 'control.data_search_protocol_bindings']
  const before = await Promise.all(tables.map(name => f.db.query(`SELECT * FROM ${name}`)))
  await f.resolve()
  for (let i = 0; i < tables.length; i++) assert.deepEqual((await f.db.query(`SELECT * FROM ${tables[i]}`)).rows, before[i].rows)
  const lease = await invoke()
  assert.equal(lease.kind, 'acquired')
  assert.deepEqual(lease.acknowledgedRequestIds, [])
  assert.deepEqual(lease.input.acknowledgedRequestIds, [])
  await protocol.finish(lease.input, { state: 'retryable' })
  await assert.rejects(() => protocol.begin(f.ctx, { version: 2, body: f.body, idempotencyKey: f.key }), { code: 'request_outcome_unknown' })
  await assert.rejects(() => protocol.begin(f.ctx, { version: 2, body: nextBody, idempotencyKey: f.key }), { code: 'idempotency_conflict' })
  assert.equal((await f.db.query('SELECT status FROM usage_requests WHERE id=$1', [f.id])).rows[0].status, 'unknown')
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM external_platform.provider_calls')).rows[0].n, 1)
})

test('protocol and Twitter query guards still find another unknown after the first blocker is disposed', pgOptions, async t => {
  const f = await searchAdmissionDispositionFixture(t), protocol = new SearchProtocolStore({ pool: f.pool })
  const another = await f.addUnknown()
  await f.resolve()
  await assert.rejects(() => protocol.begin(f.ctx, { version: 2, body: f.body, idempotencyKey: 'next-window' }),
    error => error.code === 'search_admission_blocked' && error.details.blockingRequestId === another.id)
  await assert.rejects(() => assertTwitterSearchAvailable({ usageStore: { pool: f.pool }, context: f.ctx, query: f.body.query }),
    error => error.code === 'request_outcome_unknown' && error.details.blockingRequestId === another.id)
  await f.resolve(another.id)
  await assertTwitterSearchAvailable({ usageStore: { pool: f.pool }, context: f.ctx, query: f.body.query })
  const lease = await protocol.begin(f.ctx, { version: 2, body: f.body, idempotencyKey: 'next-window' })
  await protocol.finish(lease.input, { state: 'retryable' })
  const pending = await f.addUnknown({ status: 'reserved', protocol: false, withCall: false })
  await assert.rejects(() => protocol.begin(f.ctx, { version: 2, body: f.body, idempotencyKey: 'another-window' }),
    error => error.code === 'search_admission_blocked' && error.details.blockingRequestId === pending.id)
  await assert.rejects(() => assertTwitterSearchAvailable({ usageStore: { pool: f.pool }, context: f.ctx, query: f.body.query }),
    error => error.code === 'request_in_progress' && error.details.blockingRequestId === pending.id)
})

test('legacy Twitter blockers can be disposed without converting their old key to v2', pgOptions, async t => {
  const f = await searchAdmissionDispositionFixture(t, { v2: false }), protocol = new SearchProtocolStore({ pool: f.pool })
  await assert.rejects(() => protocol.begin(f.ctx, { version: 2, body: f.body, idempotencyKey: 'new-key' }), { code: 'search_admission_blocked' })
  await f.resolve()
  const lease = await protocol.begin(f.ctx, { version: 2, body: f.body, idempotencyKey: 'new-key' })
  await protocol.finish(lease.input, { state: 'retryable' })
  await assert.rejects(() => protocol.begin(f.ctx, { version: 2, body: f.body, idempotencyKey: f.key }), { code: 'idempotency_conflict' })
})

test('query equivalence and protocol state drift do not widen a disposition', pgOptions, async t => {
  const f = await searchAdmissionDispositionFixture(t), protocol = new SearchProtocolStore({ pool: f.pool })
  const equivalent = 'offline AND disposition AND fixture'
  await assert.rejects(() => assertTwitterSearchAvailable({ usageStore: { pool: f.pool }, context: f.ctx, query: equivalent }),
    { code: 'request_outcome_unknown' })
  await f.resolve()
  await assertTwitterSearchAvailable({ usageStore: { pool: f.pool }, context: f.ctx, query: equivalent })
  await assertTwitterSearchAvailable({ usageStore: { pool: f.pool }, context: f.ctx, query: ` ${f.body.query} ` })
  await f.db.query("UPDATE control.data_search_protocol_bindings SET state='running' WHERE usage_request_id=$1", [f.id])
  await assert.rejects(() => protocol.begin(f.ctx, { version: 2, body: f.body, idempotencyKey: 'new-key' }), { code: 'search_admission_blocked' })
  await assert.rejects(() => assertTwitterSearchAvailable({ usageStore: { pool: f.pool }, context: f.ctx, query: f.body.query }), { code: 'request_outcome_unknown' })
})
