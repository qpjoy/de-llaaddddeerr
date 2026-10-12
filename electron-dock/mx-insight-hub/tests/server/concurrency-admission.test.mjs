import test from 'node:test'
import assert from 'node:assert/strict'
import { ConcurrencyAdmissionQueue } from '../../server/external-platforms/concurrency-admission.mjs'

test('queued callers are admitted FIFO as slots release, without exceeding capacity', async () => {
  const queue = new ConcurrencyAdmissionQueue()
  let active = 1
  const admitted = []
  const enter = id => queue.enter({ maxPending: 4, deadline: Date.now() + 1000,
    tryEnter() { if (active === 1) return false; active++; admitted.push(id); return true } })
  const first = enter('first'), second = enter('second')
  assert.equal(queue.entries.length, 2)
  active--; queue.drain(); await first
  assert.deepEqual(admitted, ['first'])
  assert.equal(active, 1)
  active--; queue.drain(); await second
  assert.deepEqual(admitted, ['first', 'second'])
  assert.equal(queue.entries.length, 0)
})

test('queue bound, deadline and cancellation reject before dispatch and clean pending entries', async () => {
  const queue = new ConcurrencyAdmissionQueue()
  const cancel = new AbortController()
  const pending = queue.enter({ maxPending: 1, deadline: Date.now() + 1000, tryEnter: () => false, signal: cancel.signal })
  const cancelled = assert.rejects(pending, { code: 'request_cancelled' })
  await assert.rejects(queue.enter({ maxPending: 1, deadline: Date.now() + 1000, tryEnter: () => false }),
    error => error.code === 'external_platform_busy' && error.details.reason === 'concurrency_queue_full' && error.details.upstreamDispatched === false)
  cancel.abort(); await cancelled
  assert.equal(queue.entries.length, 0)
  await assert.rejects(queue.enter({ maxPending: 1, deadline: Date.now() + 10, tryEnter: () => false }),
    error => error.details.reason === 'concurrency_queue_timeout')
  assert.equal(queue.entries.length, 0)
  await assert.rejects(queue.enter({ maxPending: 1, deadline: Date.now() - 1, tryEnter: () => assert.fail('expired waiter must not acquire') }),
    error => error.details.reason === 'concurrency_queue_timeout')
})

test('a caller blocked by its own quota does not hold up another eligible caller', async () => {
  const queue = new ConcurrencyAdmissionQueue()
  let eligible = false
  const first = queue.enter({ maxPending: 2, deadline: Date.now() + 1000, tryEnter: () => eligible })
  await queue.enter({ maxPending: 2, deadline: Date.now() + 1000, tryEnter: () => true })
  assert.equal(queue.entries.length, 1)
  eligible = true; queue.drain(); await first
  assert.equal(queue.entries.length, 0)
})
