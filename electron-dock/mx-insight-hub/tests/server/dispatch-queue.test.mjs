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

test('busy retries share capped cooldowns and space the next dispatch from completion', () => {
  const state = {}, retryPolicy = { ...policy, intervalMs: 3000, busyBackoffMaxMs: 30000 }
  const ticket = id => ({ id, fingerprint: id, policy: retryPolicy, deadline: 600000 })
  let now = 0, index = 0
  let current = ticket('first')
  assert.equal(transition(state, 'join', now, current).kind, 'queued')
  assert.equal(transition(state, 'claim', now, current).kind, 'acquired')
  function completeAndClaimNext(outcome, delay) {
    now += 800 // The supplier responds after this ticket was dispatched.
    assert.equal(transition(state, 'finish', now, { ...current, outcome }).kind, 'finished')
    current = ticket('next-' + ++index)
    assert.equal(transition(state, 'join', now, current).kind, 'queued')
    assert.deepEqual(transition(state, 'claim', now, current), { kind: 'wait', waitMs: delay })
    assert.equal(transition(state, 'claim', now + delay - 1, current).kind, 'wait')
    now += delay
    assert.equal(transition(state, 'claim', now, current).kind, 'acquired')
  }
  for (const delay of [6000, 12000, 24000, 30000, 30000]) completeAndClaimNext('busy', delay)
  completeAndClaimNext('succeeded', 3000)
  completeAndClaimNext('busy', 6000)
  completeAndClaimNext('unknown', 3000)
  // A waiter abandoned before dispatch gives up its slot. The next request
  // comes well after the last cooldown and starts a new sequence.
  transition(state, 'finish', now + 2000, { ...current, outcome: 'cancelled' })
  assert.equal(state.nextAt, now + 3000)
  now += 60000
  current = ticket('after-idle')
  assert.equal(transition(state, 'join', now, current).kind, 'queued')
  assert.equal(transition(state, 'claim', now, current).kind, 'acquired')
  completeAndClaimNext('busy', 6000)
})

test('detail queues keep their configured dispatch spacing after a busy response', () => {
  const state = {}
  transition(state, 'join', 0)
  transition(state, 'claim', 0)
  transition(state, 'dispatch', 100)
  transition(state, 'finish', 2000, { outcome: 'busy' })
  const next = { id: 'b', fingerprint: 'note-b' }
  assert.equal(transition(state, 'join', 2000, next).kind, 'queued')
  assert.equal(transition(state, 'claim', 5099, next).kind, 'wait')
  assert.equal(transition(state, 'claim', 5100, next).kind, 'acquired')
})

test('a longer shared cooldown promptly releases a waiter whose deadline can no longer be met', async () => {
  let now = 0, cooldownStarted = false
  const queue = new DispatchQueue({ clock: () => now, wait: async delay => {
    assert.equal(cooldownStarted, false, 'the queued request must finish at its first poll after the cooldown')
    now += delay
    await queue.finish(first, 'busy')
    cooldownStarted = true
  } })
  const input = { scope: 'retry', policy: { ...policy, intervalMs: 3000, busyBackoffMaxMs: 30000 },
    deadline: 5000, leaseMs: 30000 }
  const first = await queue.enter({ ...input, id: 'first', fingerprint: 'first' })
  await assert.rejects(queue.enter({ ...input, id: 'second', fingerprint: 'second' }), { code: 'external_platform_busy' })
  assert.equal(now, 3000)
  assert.equal(queue.states.get('retry').queue.length, 0)
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

test('PostgreSQL waits and overflow admissions only update the retry queue when they prune expired state', async () => {
  const retryPolicy = { ...policy, busyBackoffMaxMs: 30000, maxPending: 1 }
  const state = {}, owner = { id: 'owner', fingerprint: 'owner', policy: retryPolicy }
  const waiter = { id: 'waiter', fingerprint: 'waiter', policy: retryPolicy }
  transition(state, 'join', 0, owner)
  transition(state, 'claim', 0, owner)
  transition(state, 'join', 0, waiter)
  const follower = { id: 'follower', fingerprint: 'owner', deadline: 200 }
  transition(state, 'join', 0, { ...follower, policy: retryPolicy })
  let now = 100, writes = 0
  const queue = new DispatchQueue({ pool: { connect: async () => ({
    async query(sql, values) {
      if (sql.startsWith('SELECT')) return { rows: [{ state: structuredClone(state), now: new Date(now) }] }
      if (sql.startsWith('UPDATE')) { writes++; Object.assign(state, values[1]) }
      return { rows: [] }
    }, release() {},
  }) } })
  const claim = { type: 'claim', ...waiter, jitterMs: 0, leaseMs: 30000 }
  assert.equal((await queue.transition('retry', claim)).kind, 'wait')
  assert.equal((await queue.transition('retry', { type: 'join', ...waiter, id: 'overflow',
    fingerprint: 'overflow', deadline: 60000 })).kind, 'busy')
  assert.equal(writes, 0)
  now = 200
  assert.equal((await queue.transition('retry', claim)).kind, 'wait')
  assert.equal(writes, 1)
  assert.deepEqual(state.followers, [])
  assert.equal((await queue.transition('retry', claim)).kind, 'wait')
  assert.equal(writes, 1)
})

test('exempt PGY requests skip unrelated scheduling but retain shared identity, expiry and unknown guards', () => {
  const state = {}
  transition(state, 'join', 0); transition(state, 'claim', 0)
  state.nextAt = 59999
  const admitted = { id: 'lcy', fingerprint: 'lcy-note', hubRateLimitExempt: true }
  assert.equal(transition(state, 'join', 1, admitted).kind, 'acquired')
  assert.equal(transition(state, 'dispatch', 2, admitted).kind, 'acquired')
  assert.equal(state.active.id, 'a'); assert.equal(state.nextAt, 59999)
  assert.equal(state.exemptActive.length, 1)
  assert.equal(transition(state, 'join', 3, { ...admitted, id: 'same' }).kind, 'follower')
  transition(state, 'finish', 4, { ...admitted, outcome: 'unknown' })
  assert.equal(state.exemptActive.length, 0)
  assert.equal(state.active.id, 'a'); assert.equal(state.nextAt, 59999)
  assert.equal(transition(state, 'join', 5, { ...admitted, id: 'retry' }).kind, 'unknown')
  assert.equal(transition(state, 'join', 6, { ...admitted, id: 'ordinary', hubRateLimitExempt: false }).kind, 'unknown')
  assert.equal(transition(state, 'join', 7, { ...admitted, id: 'expiring', fingerprint: 'other' }).kind, 'acquired')
  assert.equal(transition(state, 'join', 30008, { ...admitted, id: 'after-expiry', fingerprint: 'other' }).kind, 'unknown')
})

test('an exempt same-owner rejoin cannot cancel or share its active ownership token', async () => {
  const queue = new DispatchQueue()
  const input = { scope: 'lcy-rejoin', id: 'lcy', fingerprint: 'same-note', policy,
    deadline: Date.now() + 60000, leaseMs: 30000, hubRateLimitExempt: true }
  const owner = await queue.enter(input)
  await assert.rejects(queue.enter(input), { status: 409, code: 'request_in_progress' })
  const state = queue.states.get(input.scope)
  assert.equal(state.exemptActive.length, 1)
  assert.equal(state.exemptActive[0].id, owner.id)
  assert.equal(state.done.length, 0)
  await queue.finish(owner, 'unknown')
  await assert.rejects(queue.enter({ ...input, id: 'later' }), { code: 'request_outcome_unknown' })
})
