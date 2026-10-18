import assert from 'node:assert/strict'
import test from 'node:test'
import { runWorker } from '../src/queue/postgres-queue.mjs'

const flush = () => new Promise(setImmediate)
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const states = new Map(), calls = []
  const signal = new AbortController()
  const queue = {
    async reclaimExpired() {},
    async claim(name, concurrency) {
      calls.push(['claim', name, concurrency])
      const id = calls.filter(([kind]) => kind === 'claim').length
      if (id > 2) return []
      states.set(id, 'running')
      return [{ id, payload: { id }, attempts: 1, max_attempts: 5 }]
    },
    async complete(id) { states.set(id, 'done'); calls.push(['complete', id]) },
    async fail(job) { states.set(job.id, 'pending'); calls.push(['fail', job.id]) },
  }
  const worker = runWorker({
    queue, name: 'test', handler: async () => {}, signal: signal.signal,
    logger: { error() {} }, ...options,
  })
  t.after(async () => { worker.stop(); t.mock.timers.tick(60_000); await worker.done })
  return { queue, calls, states, worker, signal }
}

test('post-batch delay starts after completion is acknowledged, then bounds the next claim', async (t) => {
  const complete = deferred()
  const f = fixture(t, { postBatchDelayMs: 1000 })
  f.queue.complete = async (id) => { await complete.promise; f.states.set(id, 'done') }
  await flush()
  t.mock.timers.tick(5000)
  await flush()
  assert.equal(f.calls.length, 1)
  assert.equal(f.states.get(1), 'running')
  complete.resolve()
  await flush()
  assert.equal(f.states.get(1), 'done')
  t.mock.timers.tick(999)
  await flush()
  assert.equal(f.calls.length, 1)
  t.mock.timers.tick(1)
  await flush()
  assert.equal(f.calls.length, 2)
})

test('handler failure is released before the post-batch wait and stop interrupts it without claiming again', async (t) => {
  const failed = deferred()
  const f = fixture(t, { postBatchDelayMs: 60_000, handler: async () => { throw Error('failed') } })
  f.queue.fail = async (job) => { await failed.promise; f.states.set(job.id, 'pending'); f.calls.push(['fail', job.id]) }
  await flush()
  t.mock.timers.tick(60_000)
  await flush()
  assert.equal(f.states.get(1), 'running')
  assert.deepEqual(f.calls.map(([kind]) => kind), ['claim'])
  failed.resolve()
  await flush()
  assert.equal(f.states.get(1), 'pending')
  assert.deepEqual(f.calls.map(([kind]) => kind), ['claim', 'fail'])
  f.worker.stop()
  await f.worker.done
  t.mock.timers.tick(60_000)
  await flush()
  assert.deepEqual(f.calls.map(([kind]) => kind), ['claim', 'fail'])
})

test('post-batch delay waits for every concurrently claimed job to settle', async (t) => {
  const last = deferred()
  const f = fixture(t, { postBatchDelayMs: 1000, concurrency: 2 })
  f.queue.claim = async (name, concurrency) => {
    f.calls.push(['claim', name, concurrency])
    return [1, 2].map(id => { f.states.set(id, 'running'); return { id, payload: { id } } })
  }
  f.queue.complete = async (id) => { if (id === 2) await last.promise; f.states.set(id, 'done') }
  await flush()
  assert.equal(f.states.get(1), 'done')
  assert.equal(f.states.get(2), 'running')
  t.mock.timers.tick(1000)
  await flush()
  assert.equal(f.calls.length, 1)
  last.resolve()
  await flush()
  assert.equal(f.states.get(2), 'done')
  t.mock.timers.tick(999)
  await flush()
  assert.equal(f.calls.length, 1)
  t.mock.timers.tick(1)
  await flush()
  assert.equal(f.calls.length, 2)
})

test('external abort interrupts a post-batch wait without another claim', async (t) => {
  const f = fixture(t, { postBatchDelayMs: 60_000 })
  await flush()
  assert.equal(f.states.get(1), 'done')
  f.signal.abort()
  await f.worker.done
  t.mock.timers.tick(60_000)
  await flush()
  assert.equal(f.calls.filter(([kind]) => kind === 'claim').length, 1)
})

for (const postBatchDelayMs of [undefined, 0]) test(`post-batch delay ${postBatchDelayMs} preserves immediate draining`, async (t) => {
  let completed = 0
  const f = fixture(t, { ...(postBatchDelayMs === undefined ? {} : { postBatchDelayMs }) })
  f.queue.complete = async () => { if (++completed === 2) f.worker.stop() }
  await f.worker.done
  assert.equal(completed, 2)
  assert.equal(f.calls.filter(([kind]) => kind === 'claim').length, 2)
})

test('already aborted workers never claim jobs', async (t) => {
  const controller = new AbortController()
  controller.abort()
  const f = fixture(t, { signal: controller.signal, postBatchDelayMs: 1000 })
  await f.worker.done
  assert.equal(f.calls.length, 0)
})

test('invalid post-batch delays fail before any queue operation', () => {
  for (const postBatchDelayMs of [-1, 0.5, NaN, Infinity, '1000']) {
    assert.throws(() => runWorker({ queue: {}, postBatchDelayMs }), /postBatchDelayMs/)
  }
})
