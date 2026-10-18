import assert from 'node:assert/strict'
import test from 'node:test'
import { processRetrievalJob } from '../../server/retrieval/worker.mjs'
import { main } from '../../server/workers/retrieval.mjs'
function fixture() {
  const calls = []
  return {
    calls,
    jobs: {
      pool: { query: async () => ({ rows: [] }) },
      assertLease: async () => calls.push('assertLease'),
      heartbeat: async () => calls.push('heartbeat'),
      complete: async () => calls.push('complete'),
      fail: async (j, e) => calls.push(e.code),
      reserveTokens: async () => calls.push('budget'),
    },
    pipeline: {
      agent: { embeddings: { available: true } },
      materializeChunks: async () => calls.push('chunk'),
      projectDeletions: async () => calls.push('delete'),
      embedPending: async () => ({ embedded: 0 }),
      projectPending: async () => ({ projected: 0 }),
    },
    job: { record_id: '1', lease_token: 'lease', version: 1 },
    signal: new AbortController().signal,
    logger: { warn() {} },
  }
}
test('worker entrypoint rejects memory configuration before opening connections', async () => {
  await assert.rejects(main({ storeDriver: 'memory' }), /requires.*postgres/)
})
test('tombstone cleanup does not call the embedding model', async () => {
  const f = fixture()
  f.job.retire = true
  f.pipeline.agent = null
  f.pipeline.embedPending = async () => {
    throw Error('must not embed')
  }
  await processRetrievalJob(f)
  assert.ok(f.calls.includes('delete'))
  assert.ok(f.calls.includes('complete'))
})
test('quarantined chunks keep job failed rather than falsely completing', async () => {
  const f = fixture()
  f.jobs.pool.query = async () => ({ rows: [{ pending: true }] })
  await processRetrievalJob(f)
  assert.ok(f.calls.includes('chunk_projection_failed'))
  assert.equal(f.calls.includes('complete'), false)
})
test('lost lease prevents model and projection writes', async () => {
  const f = fixture()
  f.jobs.assertLease = async () => {
    throw Object.assign(Error('lost'), { code: 'retrieval_lease_lost' })
  }
  await processRetrievalJob(f)
  assert.deepEqual(f.calls, ['retrieval_lease_lost'])
})
test('embedding reserves budget before request and uses a bounded abort signal', async () => {
  const f = fixture()
  let count = 0
  f.pipeline.embedPending = async ({ beforeEmbed, signal }) => {
    assert.ok(signal instanceof AbortSignal)
    if (count++) return { embedded: 0 }
    await beforeEmbed(['文本'.repeat(20)])
    f.calls.push('model')
    return { embedded: 1 }
  }
  await processRetrievalJob(f)
  assert.ok(f.calls.indexOf('budget') < f.calls.indexOf('model'))
  assert.ok(f.calls.includes('complete'))
})

test('resource pressure stops costly work before token reservation but still permits tombstone cleanup', async () => {
  const f = fixture()
  f.admission = { check: async () => { throw Object.assign(Error('pressure'), { code: 'retrieval_resource_pressure' }) }, failed: () => false }
  await processRetrievalJob(f)
  assert.deepEqual(f.calls, ['assertLease', 'retrieval_resource_pressure'])
  f.calls.length = 0
  f.job.retire = true
  await processRetrievalJob(f)
  assert.ok(f.calls.includes('delete'))
  assert.ok(f.calls.includes('complete'))
  assert.equal(f.calls.includes('budget'), false)
})

test('pressure is checked between embedding batches so a large record can yield without another model call', async () => {
  const f = fixture()
  let pressure = false, calls = 0
  f.admission = { check: async () => { if (pressure) throw Object.assign(Error('pressure'), { code: 'retrieval_resource_pressure' }) }, failed: () => false }
  f.pipeline.embedPending = async ({ beforeEmbed }) => {
    await beforeEmbed(['正文'])
    calls++; pressure = true
    return { embedded: 1 }
  }
  await processRetrievalJob(f)
  assert.equal(calls, 1)
  assert.ok(f.calls.includes('retrieval_resource_pressure'))
  assert.equal(f.calls.includes('complete'), false)
})

test('dependency 429 preserves the job for automatic retry rather than exhausting permanent-failure attempts', async () => {
  const f = fixture()
  f.admission = { check: async () => {}, failed: (e) => e.status === 429 }
  f.pipeline.embedPending = async () => { throw Object.assign(Error('busy'), { status: 429 }) }
  await processRetrievalJob(f)
  assert.ok(f.calls.includes('retrieval_dependency_backoff'))
})

test('short successful work validates every stage without renewing the lease on each stage', async () => {
  const f = fixture()
  let embedded = false, projected = false
  f.pipeline.embedPending = async ({ beforeEmbed }) => {
    if (embedded) return { embedded: 0 }
    await beforeEmbed(['正文'])
    embedded = true
    f.calls.push('model')
    return { embedded: 1 }
  }
  f.pipeline.projectPending = async () => {
    if (projected) return { projected: 0 }
    projected = true
    return { projected: 1 }
  }
  await processRetrievalJob(f)
  assert.equal(f.calls.filter((call) => call === 'heartbeat').length, 0)
  assert.equal(f.calls.filter((call) => call === 'assertLease').length, 7)
  assert.ok(f.calls.indexOf('budget') < f.calls.indexOf('model'))
  assert.ok(f.calls.includes('complete'))
})

test('ownership is checked again immediately before a paid embedding request', async () => {
  const f = fixture()
  f.pipeline.embedPending = async ({ beforeEmbed }) => {
    f.jobs.assertLease = async () => {
      throw Object.assign(Error('lost'), { code: 'retrieval_lease_lost' })
    }
    await beforeEmbed(['正文'])
    f.calls.push('model')
    return { embedded: 1 }
  }
  await processRetrievalJob(f)
  assert.ok(f.calls.includes('retrieval_lease_lost'))
  assert.equal(f.calls.includes('budget'), false)
  assert.equal(f.calls.includes('model'), false)
  assert.equal(f.calls.includes('complete'), false)
})

test('long work still renews every 30 seconds and stops the timer after completion', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture()
  let release, entered
  const gate = new Promise((resolve) => { release = resolve })
  const started = new Promise((resolve) => { entered = resolve })
  f.pipeline.materializeChunks = async () => { entered(); await gate }
  const running = processRetrievalJob(f)
  await started
  t.mock.timers.tick(29_999)
  await new Promise(setImmediate)
  assert.equal(f.calls.filter((call) => call === 'heartbeat').length, 0)
  t.mock.timers.tick(1)
  await new Promise(setImmediate)
  assert.equal(f.calls.filter((call) => call === 'heartbeat').length, 1)
  t.mock.timers.tick(30_000)
  await new Promise(setImmediate)
  assert.equal(f.calls.filter((call) => call === 'heartbeat').length, 2)
  release()
  await running
  t.mock.timers.tick(30_000)
  await new Promise(setImmediate)
  assert.equal(f.calls.filter((call) => call === 'heartbeat').length, 2)
  assert.ok(f.calls.includes('complete'))
})

test('periodic renewal failure stops the next costly stage', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture()
  let release, entered
  const gate = new Promise((resolve) => { release = resolve })
  const started = new Promise((resolve) => { entered = resolve })
  f.pipeline.materializeChunks = async () => { entered(); await gate }
  f.jobs.heartbeat = async () => {
    throw Object.assign(Error('lost'), { code: 'retrieval_lease_lost' })
  }
  f.pipeline.embedPending = async () => { f.calls.push('model'); return { embedded: 0 } }
  const running = processRetrievalJob(f)
  await started
  t.mock.timers.tick(30_000)
  await new Promise(setImmediate)
  release()
  await running
  assert.ok(f.calls.includes('retrieval_lease_lost'))
  assert.equal(f.calls.includes('model'), false)
  assert.equal(f.calls.includes('complete'), false)
})
