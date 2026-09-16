import assert from 'node:assert/strict'
import test from 'node:test'
import { IndexingMetrics, ProgressRate, mergeWorkerMetrics, observeMethods, observePool } from '../../server/ops/indexing-metrics.mjs'

test('ETA starts with a resumed baseline, uses recent acknowledged progress, and resets on pause or a new phase', () => {
  const rate = new ProgressRate()
  const estimate = (at, processed, extra = {}) => rate.estimate({ key: 'build', at, processed, remaining: 900, ...extra })
  assert.equal(estimate(0, 120000).reason, 'warming')
  assert.equal(estimate(10000, 120100).reason, 'warming')
  assert.deepEqual(estimate(30000, 120300), { seconds: 90, rate: 10, reason: 'estimated', windowSeconds: 30 })
  assert.equal(estimate(130000, 120300).reason, 'stalled')
  assert.equal(estimate(140000, 120300, { blocked: 'paused' }).seconds, null)
  assert.equal(estimate(150000, 120300).reason, 'warming')
  assert.equal(estimate(180000, 120600).rate, 10)
  assert.equal(estimate(190000, 0, { key: 'catch-up', remaining: null }).reason, 'warming')
  assert.equal(estimate(220000, 30, { key: 'catch-up', remaining: null }).reason, 'unknown_total')
  assert.equal(estimate(221000, 30, { remaining: 0 }).seconds, 0)
})

test('stage metrics report in-flight calls, propagate errors unchanged and retain no input or messages', async () => {
  let now = 0, release
  const metrics = new IndexingMetrics(() => now)
  const pending = metrics.measure('hanlp', () => new Promise((resolve) => { release = resolve }))
  now = 123
  assert.deepEqual(metrics.snapshot().active, [{ stage: 'hanlp', since: 0 }])
  release('original result')
  assert.equal(await pending, 'original result')
  const error = Object.assign(new Error('secret source text'), { status: 429 })
  await assert.rejects(metrics.measure('embedding', () => { now += 10; throw error }), (e) => e === error)
  const snapshot = metrics.snapshot()
  assert.equal(snapshot.stages.hanlp.ms, 123)
  assert.equal(snapshot.stages.embedding.failed, 1)
  assert.equal(snapshot.lastError.kind, 'rate_limit')
  assert.ok(!JSON.stringify(snapshot).includes('secret'))
  now += 320000
  assert.deepEqual(metrics.snapshot().stages, {})
  assert.equal(metrics.snapshot().lastError, null)
})

test('maintenance wrappers preserve method binding, PG release semantics and only measure listed methods', async () => {
  class Client { #value = 2; async query() { return this.#value }; release() { return this.#value } }
  const client = new Client(), metrics = new IndexingMetrics()
  const pool = observePool({ async query() { return 1 }, async connect() { return client } }, metrics)
  assert.equal(await pool.query(), 1)
  const connection = await pool.connect()
  assert.equal(await connection.query(), 2)
  assert.equal(connection.release(), 2)
  assert.equal(metrics.snapshot().stages.postgres.calls, 3)
  const wrapped = observeMethods(client, metrics, 'other', [])
  assert.equal(await wrapped.query(), 2)
  assert.equal(metrics.snapshot().stages.other, undefined)
})

test('worker aggregation excludes stale reports and sums calls without multiplying throughput by worker count', () => {
  const row = { calls: 5, ms: 100, maxMs: 30, failed: 1 }
  const fresh = { sampledAt: 100000, stages: { embedding: row }, active: [{ stage: 'postgres', since: 99999 }] }
  const result = mergeWorkerMetrics([{ id: 'worker-a', telemetry: fresh }, { id: 'worker-b', telemetry: fresh },
    { id: 'stale', telemetry: { ...fresh, sampledAt: 1 } }], 100000)
  assert.equal(result.reportingWorkers, 2)
  assert.equal(result.stages.embedding.calls, 10)
  assert.equal(result.stages.embedding.ms, 200)
  assert.equal(result.stages.embedding.maxMs, 30)
  assert.equal(result.active.length, 2)
  assert.equal(result.rate, undefined)
})
