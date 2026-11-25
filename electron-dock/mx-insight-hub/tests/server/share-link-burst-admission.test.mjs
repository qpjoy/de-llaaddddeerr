import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as tick } from 'node:timers/promises'
import { AppError } from '../../server/core/errors.mjs'
import { ShareLinkAdmission } from '../../server/services/share-link-admission.mjs'

const burst = retryAfterMs => new AppError(429, 'plan_burst_exceeded', 'Plan burst quota exceeded', { limitScope: 'plan_burst', retryAfterMs })
const ok = { kind: 'reserved', request: { id: 'same-operation' } }
const cancelled = { status: 499, code: 'request_cancelled' }
const reject = error => () => { throw error }
const noop = () => {}

function clocked(options = {}) {
  let now = 0
  const waits = []
  const admission = new ShareLinkAdmission({ now: () => now, sleep: async ms => { waits.push(ms); now += ms }, ...options })
  return { admission, waits, advance: ms => { now += ms } }
}

function held() {
  const waits = []
  const sleep = (ms, signal) => {
    const { promise, resolve, reject } = Promise.withResolvers()
    const abort = () => reject(new DOMException('Cancelled', 'AbortError'))
    signal?.addEventListener('abort', abort, { once: true })
    waits.push({ ms, resolve })
    return promise.finally(() => signal?.removeEventListener('abort', abort))
  }
  return { waits, options: { now: () => 0, sleep } }
}

test('successful reservations need no waiting or revalidation; each reattempt revalidates before reserving', async () => {
  const { admission, waits } = clocked()
  assert.equal(await admission.reserve('c', undefined, () => ok, () => assert.fail('unexpected revalidation')), ok)
  const events = []
  let attempts = 0
  const attempt = () => {
    events.push('reserve')
    if (++attempts <= 2) throw burst(attempts === 1 ? 7 : 3)
    return ok
  }
  assert.equal(await admission.reserve('c', undefined, attempt, () => { events.push('check') }), ok)
  assert.deepEqual(waits, [7, 3])
  assert.deepEqual(events, ['reserve', 'check', 'reserve', 'check', 'reserve'])
})

test('only a typed plan burst with a usable hint inside the budget can wait', async () => {
  const { admission, waits } = clocked()
  const errors = [
    new AppError(429, 'resource_admission_limited', 'busy', { retryAfterMs: 1 }),
    new AppError(429, 'plan_window_quota_exceeded', 'quota', { retryAfterMs: 1 }),
    new AppError(503, 'usage_reservation_persistence_unknown', 'unknown', { retryAfterMs: 1 }),
    Object.assign(new Error('untyped'), { status: 429, code: 'plan_burst_exceeded', details: { retryAfterMs: 1 } }),
    burst(undefined), burst(NaN), burst(161),
  ]
  for (const error of errors) {
    let count = 0
    await assert.rejects(admission.reserve('c', undefined, () => { count++; throw error }, noop), actual => actual === error)
    assert.equal(count, 1)
  }
  assert.deepEqual(waits, [])
})

test('competition permits at most two reattempts and time spent revisiting the store counts against the budget', async () => {
  const { admission, waits, advance } = clocked({ waitBudgetMs: 50 })
  let attempts = 0
  const sameError = burst(2)
  await assert.rejects(admission.reserve('c', undefined, () => { attempts++; throw sameError }, noop), actual => actual === sameError)
  assert.equal(attempts, 3)
  assert.deepEqual(waits.splice(0), [2, 2])
  attempts = 0
  const later = burst(20)
  await assert.rejects(admission.reserve('c', undefined, () => {
    if (++attempts === 1) throw burst(24)
    advance(12)
    throw later
  }, noop), actual => actual === later)
  assert.equal(attempts, 2)
  assert.deepEqual(waits, [24])
})

test('a late timer or slow revalidation cannot start another reserve after the 50 ms deadline', async () => {
  for (const delayedStage of ['sleep', 'revalidate']) {
    let time = 0, attempts = 0, checks = 0
    const admission = new ShareLinkAdmission({
      waitBudgetMs: 50,
      now: () => time,
      sleep: async ms => { time += ms + (delayedStage === 'sleep' ? 1 : 0) },
    })
    const original = burst(50)
    await assert.rejects(admission.reserve('c', undefined, () => {
      attempts++
      throw original
    }, () => { checks++; time++ }), actual => actual === original)
    assert.equal(attempts, 1)
    assert.equal(checks, delayedStage === 'sleep' ? 0 : 1)
  }
})

test('16 waiting places include the sleeping head; overflow checks the store and queued followers preserve FIFO order', async () => {
  const { waits, options } = held()
  const admission = new ShareLinkAdmission(options)
  const events = []
  let firstTry = true
  const heldAttempt = () => {
    events.push('reserve head')
    if (firstTry) { firstTry = false; throw burst(160) }
    return ok
  }
  const head = admission.reserve('a', undefined, heldAttempt, () => events.push('check head'))
  await tick()
  assert.equal(waits[0].ms, 160)
  const followers = Array.from({ length: 15 }, (_, index) => admission.reserve('a', undefined, () => {
    events.push('reserve ' + index); return ok
  }, () => { events.push('check ' + index) }))
  const noCall = () => assert.fail('unexpected revalidation')
  let overflowCalls = 0
  assert.equal(await admission.reserve('a', undefined, () => { overflowCalls++; return ok }, noop), ok)
  for (const own of [burst(3), new AppError(403, 'scope_not_granted', 'revoked')]) {
    await assert.rejects(admission.reserve('a', undefined, () => { overflowCalls++; throw own }, noop), actual => actual === own)
  }
  assert.equal(overflowCalls, 3)
  assert.equal(waits.length, 1)
  assert.equal(await admission.reserve('other', undefined, () => ok, noCall), ok)
  assert.deepEqual(events, ['reserve head'])
  waits[0].resolve()
  assert.equal(await head, ok)
  assert.deepEqual(await Promise.all(followers), Array(15).fill(ok))
  assert.deepEqual(events, ['reserve head', 'check head', 'reserve head',
    ...followers.flatMap((_, i) => ['check ' + i, 'reserve ' + i])])
  assert.equal(await admission.reserve('a', undefined, () => ok, noCall), ok)
})

test('a racing reservation already rejected by the plan preserves its own error if the local queue fills', async () => {
  const { waits, options } = held()
  const admission = new ShareLinkAdmission({ ...options, maxWaitersPerConsumer: 2 })
  const remote = Promise.withResolvers()
  const own = burst(7)
  const racing = admission.reserve('c', undefined, () => remote.promise, noop)
  const assertion = assert.rejects(racing, actual => actual === own)
  let fresh = true
  const head = admission.reserve('c', undefined, () => {
    if (fresh) { fresh = false; throw burst(5) }
    return ok
  }, noop)
  await tick()
  const follower = admission.reserve('c', undefined, () => ok, noop)
  remote.reject(own)
  await assertion
  waits[0].resolve()
  assert.deepEqual(await Promise.all([head, follower]), [ok, ok])
})

test('a full-queue database check stays a single attempt if the queue drains before Postgres replies', async () => {
  const { waits, options } = held()
  const admission = new ShareLinkAdmission({ ...options, maxWaitersPerConsumer: 1 })
  let headAttempts = 0
  const head = admission.reserve('c', undefined, () => {
    if (++headAttempts === 1) throw burst(5)
    return ok
  }, noop)
  await tick()
  const db = Promise.withResolvers()
  const own = burst(7)
  let attempts = 0
  const fresh = assert.rejects(admission.reserve('c', undefined, () => {
    attempts++
    return db.promise
  }, noop), actual => actual === own)
  assert.equal(attempts, 1)
  waits[0].resolve()
  assert.equal(await head, ok)
  db.reject(own)
  await tick()
  assert.equal(waits.length, 1, 'the overflow DB rejection must not open another queue')
  await fresh
  assert.equal(attempts, 1)
})

test('followers timing out before their turn check authority exactly once and neither plan nor business refusal gets retried', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let time = 0
  const { waits, options } = held()
  const admission = new ShareLinkAdmission({ ...options, waitBudgetMs: 50, now: () => time })
  const initial = burst(5)
  const head = admission.reserve('c', undefined, reject(initial), noop)
  const headCheck = assert.rejects(head, actual => actual === initial)
  await tick()
  const errors = [burst(5), new AppError(402, 'insufficient_credit', 'insufficient credit')]
  const checks = []
  const admitted = admission.reserve('c', undefined, () => { checks.push('admit'); return ok }, () => checks.push('revalidate admit'))
  const refused = errors.map((error, i) => assert.rejects(admission.reserve('c', undefined, () => {
    checks.push('refuse ' + i)
    throw error
  }, () => checks.push('revalidate ' + i)), actual => actual === error))
  assert.deepEqual(checks, [])
  time += 51
  t.mock.timers.tick(51)
  assert.equal(await admitted, ok)
  await Promise.all(refused)
  for (const [auth, attempt] of [['revalidate admit', 'admit'], ['revalidate 0', 'refuse 0'], ['revalidate 1', 'refuse 1']]) {
    assert.equal(checks.filter(x => x === attempt).length, 1)
    assert.ok(checks.includes(auth) && checks.indexOf(auth) < checks.indexOf(attempt))
  }
  assert.equal(waits.length, 1)
  waits[0].resolve()
  await headCheck
  assert.equal(await admission.reserve('c', undefined, () => ok, noop), ok)
})

test('an in-flight database reservation at the head does not serialize a fresh caller from the same consumer', async () => {
  const { waits, options } = held()
  const admission = new ShareLinkAdmission(options)
  const db = Promise.withResolvers()
  let calls = 0
  const head = admission.reserve('c', undefined, () => {
    if (++calls === 1) throw burst(5)
    return db.promise
  }, noop)
  await tick()
  const old = admission.reserve('c', undefined, () => ok, noop)
  waits[0].resolve()
  await tick()
  assert.equal(calls, 2)
  let started = false
  const fresh = admission.reserve('c', undefined, () => { started = true; return ok }, noop)
  await tick()
  assert.equal(started, true)
  db.resolve(ok)
  assert.deepEqual(await Promise.all([head, old, fresh]), [ok, ok, ok])
})

test('a successful reservation can hint a future slot to an existing follower; the store still makes its decision', async () => {
  const { waits, options } = held()
  let time = 100
  const admission = new ShareLinkAdmission({ ...options, now: () => time })
  const hinted = { ...ok, nextPlanBurstSlotAt: 125 }
  const events = []
  let first = true
  const head = admission.reserve('c', undefined, () => {
    if (first) { first = false; throw burst(5) }
    return hinted
  }, noop)
  await tick()
  const refused = burst(800)
  const next = assert.rejects(admission.reserve('c', undefined, () => { events.push('store'); throw refused },
    () => events.push('check')), actual => actual === refused)
  time = 105
  waits[0].resolve()
  assert.equal(await head, hinted)
  await tick()
  assert.deepEqual(waits.map(w => w.ms), [5, 20])
  assert.deepEqual(events, [])
  time = 125
  waits[1].resolve()
  await next
  assert.deepEqual(events, ['check', 'store'])
})

test('cancelling the middle and the head immediately hands the turn to the remaining follower', async () => {
  const { options } = held()
  const admission = new ShareLinkAdmission(options)
  const first = new AbortController(), middle = new AbortController()
  const noCall = () => assert.fail('cancelled job continued')
  const head = assert.rejects(admission.reserve('c', first.signal, reject(burst(5)), noCall), cancelled)
  await tick()
  const second = assert.rejects(admission.reserve('c', middle.signal, noCall, noCall), cancelled)
  const tail = admission.reserve('c', undefined, () => ok, noop)
  middle.abort()
  await second
  first.abort()
  await head
  assert.equal(await tail, ok)
})

test('a client cancelling before or during waiting never reserves a second time and frees its waiter', async () => {
  const { waits, options } = held()
  const admission = new ShareLinkAdmission({ ...options, maxWaitersPerConsumer: 1 })
  let attempts = 0
  const attempt = () => { attempts++; throw burst(5) }
  await assert.rejects(admission.reserve('c', AbortSignal.abort(), attempt, noop), cancelled)
  assert.equal(attempts, 0)
  const controller = new AbortController()
  const pending = admission.reserve('c', controller.signal, attempt, () => assert.fail('cancelled client revalidated'))
  await tick()
  assert.equal(waits.length, 1)
  controller.abort()
  await assert.rejects(pending, cancelled)
  assert.equal(attempts, 1)
  const revoked = new AppError(403, 'capability_not_granted', 'revoked')
  const next = admission.reserve('c', undefined, attempt, reject(revoked))
  await tick()
  assert.equal(waits.length, 2)
  waits[1].resolve()
  await assert.rejects(next, actual => actual === revoked)
  assert.equal(attempts, 2)
  const third = admission.reserve('c', undefined, attempt, reject(revoked))
  await tick()
  assert.equal(waits.length, 3)
  waits[2].resolve()
  await assert.rejects(third, actual => actual === revoked)
  assert.equal(attempts, 3)
})

test('cancellation during asynchronous revalidation prevents a late reservation', async () => {
  const { admission } = clocked()
  const ctl = new AbortController()
  let attempts = 0
  await assert.rejects(admission.reserve('c', ctl.signal, () => {
    if (++attempts === 1) throw burst(2)
    return ok
  }, async () => { ctl.abort(); await Promise.resolve() }), cancelled)
  assert.equal(attempts, 1)
})

test('two workers waking for a shared final slot still depend on the durable reservation result', async () => {
  const { waits, options } = held()
  let available = false, issued = 0
  const reserve = () => {
    if (!available) throw burst(2)
    if (issued) throw burst(999)
    issued++
    return ok
  }
  const results = Promise.allSettled([new ShareLinkAdmission(options), new ShareLinkAdmission(options)]
    .map(worker => worker.reserve('same-consumer', undefined, reserve, noop)))
  await tick()
  assert.equal(waits.length, 2)
  available = true
  for (const wait of waits) wait.resolve()
  const settled = await results
  assert.equal(issued, 1)
  assert.equal(settled.filter(r => r.status === 'fulfilled' && r.value === ok).length, 1)
  assert.equal(settled.filter(r => r.status === 'rejected' && r.reason.code === 'plan_burst_exceeded').length, 1)
})
