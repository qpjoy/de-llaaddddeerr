import test from 'node:test'
import assert from 'node:assert/strict'
import { queueTransition, DispatchQueue, DEFAULT_DETAIL_QUEUE, canRetryDetail } from '../../server/external-platforms/dispatch-queue.mjs'
const policy = { ...DEFAULT_DETAIL_QUEUE, jitterMs: 0 }
const transition = (state, type, now, extra = {}) => queueTransition(state, { type, policy, id: 'a', fingerprint: 'note-a', deadline: 60000, leaseMs: 30000, jitterMs: 0, ...extra }, now)

test('atomic FIFO admission bounds delay, shares identical notes, and enforces spacing at actual dispatch', () => {
  const state = {}
  assert.equal(transition(state, 'join', 0).kind, 'queued')
  assert.equal(transition(state, 'claim', 0).kind, 'acquired')
  assert.equal(transition(state, 'join', 1, { id: 'same' }).kind, 'follower')
  for (let i = 1; i <= 11; i++) assert.equal(transition(state, 'join', 1, { id: 'b' + i, fingerprint: 'note' + i }).kind, 'queued')
  assert.equal(transition(state, 'join', 1, { id: 'overflow', fingerprint: 'overflow' }).kind, 'busy')
  assert.equal(transition(state, 'dispatch', 2000).kind, 'acquired')
  transition(state, 'finish', 2100, { outcome: 'succeeded' })
  assert.equal(transition(state, 'claim', 6000, { id: 'b1' }).kind, 'wait')
  assert.equal(transition(state, 'claim', 7000, { id: 'b1' }).kind, 'acquired')
  assert.equal(transition(state, 'observe', 7000).kind, 'succeeded')
})

test('retry yields to queued work, retains original deadline, and cannot steal a running permit', () => {
  const state = {}
  transition(state, 'join', 0); transition(state, 'claim', 0)
  transition(state, 'join', 1, { id: 'b', fingerprint: 'note-b' })
  assert.equal(transition(state, 'requeue', 2, { notBefore: 10000 }).kind, 'queued')
  assert.equal(transition(state, 'claim', 5000, { id: 'b' }).kind, 'acquired')
  assert.equal(transition(state, 'claim', 10000).kind, 'wait')
  transition(state, 'finish', 10000, { id: 'b', outcome: 'succeeded' })
  assert.equal(transition(state, 'claim', 10001).kind, 'acquired')
  assert.equal(transition(state, 'dispatch', 10002, { id: 'b' }).kind, 'expired')
})

test('abandoned dispatch remains unknown across callers; expired pending tickets do not acquire', () => {
  const state = {}
  transition(state, 'join', 0); transition(state, 'claim', 0)
  assert.equal(transition(state, 'join', 30001, { id: 'other' }).kind, 'unknown')
  transition(state, 'join', 30002, { id: 'b', fingerprint: 'note-b', deadline: 40000 })
  assert.equal(transition(state, 'claim', 40001, { id: 'b' }).kind, 'expired')
  assert.equal(canRetryDetail({ evidence: { outcome: 'unknown', billed: null, httpStatus: 504 } }), false)
  assert.equal(canRetryDetail({ evidence: { outcome: 'succeeded_unusable', billed: true, httpStatus: 200 } }), false)
})

test('waiting cancellation removes only the waiter and does not contact any upstream', async () => {
  let now = 0
  const controller = new AbortController()
  const queue = new DispatchQueue({ clock: () => now, wait: async () => { controller.abort(); now++ } })
  await queue.enter({ scope: 'scope', id: 'a', fingerprint: 'a', deadline: 60000, policy, leaseMs: 30000 })
  await assert.rejects(queue.enter({ scope: 'scope', id: 'b', fingerprint: 'b', deadline: 60000, policy, leaseMs: 30000, signal: controller.signal }), { code: 'request_cancelled' })
  assert.equal(queue.states.get('scope').queue.length, 0)
  assert.equal(queue.states.get('scope').active.id, 'a')
})

test('same-note followers have a separate bounded capacity and detach independently', () => {
  const state = {}
  transition(state, 'join', 0); transition(state, 'claim', 0)
  for (let i = 0; i < 100; i++) assert.equal(transition(state, 'join', 1, { id: 'f' + i }).kind, 'follower')
  assert.equal(transition(state, 'join', 1, { id: 'full' }).kind, 'busy')
  transition(state, 'detach', 1, { id: 'f0' })
  assert.equal(transition(state, 'join', 1, { id: 'next' }).kind, 'follower')
  assert.equal(state.active.id, 'a')
})

test('PostgreSQL queue uses one short row-locked transaction and releases the connection before waiting', async () => {
  const queries = [], state = {}
  let connected = 0
  const pool = { connect: async () => {
    connected++
    return { query: async (sql, values) => {
      queries.push(sql)
      if (sql.startsWith('SELECT')) return { rows: [{ state: structuredClone(state), now: new Date(0) }] }
      if (sql.startsWith('UPDATE')) Object.assign(state, values[1])
      return { rows: [] }
    }, release: () => { connected-- } }
  } }
  const one = new DispatchQueue({ pool }), two = new DispatchQueue({ pool })
  const input = { type: 'join', policy, id: 'a', fingerprint: 'a', deadline: 60000 }
  assert.equal((await one.transition('digest', input)).kind, 'queued')
  assert.equal((await two.transition('digest', { ...input, id: 'b' })).kind, 'follower')
  assert.equal(connected, 0)
  assert.equal(queries.filter(sql => sql.includes('FOR UPDATE')).length, 2)
  assert.equal(queries.filter(sql => sql === 'COMMIT').length, 2)
})
