import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import test from 'node:test'
import { loadConfig } from '../../server/config.mjs'
import { startLoop } from '../../server/workers/ingest.mjs'
import { runProjectorLoop } from '../../server/search/projector.mjs'

const base = {
  MX_INSIGHT_LISTENER_MODE: 'public',
  MX_INSIGHT_STORE: 'memory',
  MX_INSIGHT_API_KEY_PEPPER: 'offline-test-pepper-at-least-32-bytes',
}
const logger = { log() {}, warn() {}, error() {} }
const flush = () => new Promise(setImmediate)

test('background worker configuration has conservative defaults and bounded explicit overrides', () => {
  const defaults = loadConfig(base)
  assert.deepEqual(defaults.ingestWorker, {
    concurrency: 2, postBatchDelayMs: 0, adaptiveDelayFactor: 1, adaptiveDelayMaxMs: 60_000,
  })
  assert.deepEqual(defaults.projectorWorker, { postBatchDelayMs: 250, synchronousCommit: 'off' })
  assert.equal(loadConfig({ ...base, MX_INSIGHT_PROJECTOR_SYNCHRONOUS_COMMIT: 'on' }).projectorWorker.synchronousCommit, 'on')
  for (const value of ['ON', 'local', 'true']) {
    assert.throws(() => loadConfig({ ...base, MX_INSIGHT_PROJECTOR_SYNCHRONOUS_COMMIT: value }), /must be on or off/)
  }
  for (const concurrency of ['1', '4']) {
    assert.equal(loadConfig({ ...base, MX_INSIGHT_INGEST_WORKER_CONCURRENCY: concurrency }).ingestWorker.concurrency, Number(concurrency))
  }
  for (const concurrency of ['0', '5', '-1', '1.5', 'invalid']) {
    assert.throws(() => loadConfig({ ...base, MX_INSIGHT_INGEST_WORKER_CONCURRENCY: concurrency }))
  }
  for (const [name, field] of [
    ['MX_INSIGHT_INGEST_WORKER_DELAY_MS', 'ingestWorker'],
    ['MX_INSIGHT_PROJECTOR_WORKER_DELAY_MS', 'projectorWorker'],
  ]) {
    for (const value of ['0', '1', '60000']) {
      assert.equal(loadConfig({ ...base, [name]: value })[field].postBatchDelayMs, Number(value))
    }
    for (const value of ['-1', '1.5', '60001', 'invalid']) {
      assert.throws(() => loadConfig({ ...base, [name]: value }), /must be an integer between 0 and 60000/)
    }
  }
})

test('300 queued acquisitions drain once each with bounded ingest concurrency and a settlement pause', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // The previous defaults remain available as explicit settings.
  const config = loadConfig({
    ...base, MX_INSIGHT_INGEST_WORKER_CONCURRENCY: '1', MX_INSIGHT_INGEST_WORKER_DELAY_MS: '100',
  }).ingestWorker
  assert.deepEqual(config, {
    concurrency: 1, postBatchDelayMs: 100, adaptiveDelayFactor: 1, adaptiveDelayMaxMs: 60_000,
  })
  const controller = new AbortController()
  const pending = Array.from({ length: 300 }, (_, id) => ({ id, payload: { requestId: `request-${id}` } }))
  const completed = [], handled = [], leased = new Set()
  let active = 0, peak = 0, claims = 0
  const queue = {
    async reclaimExpired() {},
    async claim(name, concurrency) {
      assert.equal(name, 'ingest')
      assert.equal(leased.size, 0, 'the previous transaction must settle before another batch is claimed')
      claims++
      const jobs = pending.splice(0, concurrency)
      for (const job of jobs) leased.add(job.id)
      return jobs
    },
    async complete(id) { leased.delete(id); completed.push(id) },
    async fail() { assert.fail('a successful acquisition must not fail') },
  }
  const running = startLoop(queue, 'ingest', async ({ requestId }) => {
    active++
    peak = Math.max(active, peak)
    await flush()
    handled.push(requestId)
    active--
  }, controller.signal, config.concurrency, config.postBatchDelayMs, config)
  t.after(async () => { controller.abort(); await running })

  for (let count = 1; count <= 300; count++) {
    await flush()
    await flush()
    assert.equal(completed.length, count)
    assert.equal(claims, count)
    assert.equal(leased.size, 0)
    assert.equal(pending.length, 300 - count)
    t.mock.timers.tick(99)
    await flush()
    assert.equal(claims, count, 'ready backlog stays queued during the pause')
    if (count < 300) t.mock.timers.tick(1)
  }
  assert.equal(peak, 1)
  assert.equal(new Set(handled).size, 300)
  assert.deepEqual(completed, Array.from({ length: 300 }, (_, id) => id))
  controller.abort()
  await running
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('stopping ingest during a transaction settles the leased job and leaves the remaining backlog queued', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const config = loadConfig(base).ingestWorker
  const controller = new AbortController()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const pending = [{ id: 1, payload: {} }, { id: 2, payload: {} }, { id: 3, payload: {} }], completed = []
  const queue = {
    async reclaimExpired() {},
    async claim(name, concurrency) { return pending.splice(0, concurrency) },
    async complete(id) { completed.push(id) },
    async fail() { assert.fail('shutdown must finish the active transaction') },
  }
  const running = startLoop(queue, 'ingest', () => gate, controller.signal,
    config.concurrency, config.postBatchDelayMs, config)
  t.after(async () => { controller.abort(); release(); await running })
  await flush()
  controller.abort()
  assert.deepEqual(completed, [])
  release()
  await running
  assert.deepEqual(completed, [1, 2])
  assert.deepEqual(pending.map(({ id }) => id), [3])
})

test('ingest pauses at least as long as the batch took, so a slow database slows the drain', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const config = loadConfig(base).ingestWorker
  const controller = new AbortController()
  const pending = Array.from({ length: 4 }, (_, id) => ({ id, payload: {} }))
  let claims = 0
  const queue = {
    async reclaimExpired() {},
    async claim(name, concurrency) {
      claims++
      return pending.splice(0, concurrency)
    },
    async complete() {},
    async fail() { assert.fail('a successful job must not fail') },
  }
  // Each job takes 400 ms of (mocked) database time.
  const running = startLoop(queue, 'ingest', () => new Promise((resolve) => setTimeout(resolve, 400)),
    controller.signal, config.concurrency, config.postBatchDelayMs, config)
  t.after(async () => { controller.abort(); await running })

  await flush()
  assert.equal(claims, 1)
  t.mock.timers.tick(400)
  await flush()
  await flush()
  // No fixed pause is configured, yet the 400 ms batch earns a 400 ms pause.
  t.mock.timers.tick(399)
  await flush()
  assert.equal(claims, 1)
  t.mock.timers.tick(1)
  await flush()
  await flush()
  assert.equal(claims, 2)
  t.mock.timers.tick(400)
  await flush()
  await flush()
  t.mock.timers.tick(400)
  await flush()
  controller.abort()
  t.mock.timers.tick(1_000)
  await running
})

test('projector pauses only after a full batch settles and does not claim the next backlog early', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const config = loadConfig(base).projectorWorker
  assert.deepEqual(config, { postBatchDelayMs: 250, synchronousCommit: 'off' })
  const controller = new AbortController()
  let batches = 0, settled = 0, release
  const gate = new Promise((resolve) => { release = resolve })
  const projector = {
    async reclaimExpired() {},
    async projectBatch() {
      batches++
      if (batches === 1) await gate
      settled++
      return { claimed: 50, delivered: 49, failed: 1 }
    },
  }
  const running = runProjectorLoop(projector, { ...config, signal: controller.signal, logger })
  t.after(async () => { controller.abort(); release(); await running })
  await flush()
  t.mock.timers.tick(10_000)
  await flush()
  assert.equal(batches, 1)
  assert.equal(settled, 0)
  release()
  await flush()
  assert.equal(settled, 1)
  t.mock.timers.tick(249)
  await flush()
  assert.equal(batches, 1)
  t.mock.timers.tick(1)
  await flush()
  assert.equal(batches, 2)
  controller.abort()
  await running
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('projector rate-limit errors back off exponentially instead of adding a successful-batch pause', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const controller = new AbortController()
  let batches = 0
  const projector = {
    async reclaimExpired() {},
    async projectBatch() {
      batches++
      throw Object.assign(new Error('Elasticsearch bulk indexing is rate limited'), { code: 'projection_rate_limited', status: 429 })
    },
  }
  const running = runProjectorLoop(projector, {
    idleDelayMs: 100, postBatchDelayMs: 1_000, signal: controller.signal, logger,
  })
  t.after(async () => { controller.abort(); await running })
  await flush()
  assert.equal(batches, 1)
  t.mock.timers.tick(199)
  await flush()
  assert.equal(batches, 1)
  t.mock.timers.tick(1)
  await flush()
  assert.equal(batches, 2)
  t.mock.timers.tick(399)
  await flush()
  assert.equal(batches, 2)
  t.mock.timers.tick(1)
  await flush()
  assert.equal(batches, 3)
  controller.abort()
  await running
})

test('projector zero delay preserves immediate draining and rejects invalid delay before claims', async () => {
  const controller = new AbortController()
  let batches = 0
  const projector = {
    async reclaimExpired() {},
    async projectBatch() {
      if (++batches === 3) controller.abort()
      return { claimed: 1, delivered: 1, failed: 0 }
    },
  }
  await runProjectorLoop(projector, { postBatchDelayMs: 0, signal: controller.signal, logger })
  assert.equal(batches, 3)
  for (const postBatchDelayMs of [-1, 0.5, NaN, Infinity, '100']) {
    await assert.rejects(runProjectorLoop(projector, { postBatchDelayMs, logger }), /postBatchDelayMs/)
  }
  assert.equal(batches, 3)
})
