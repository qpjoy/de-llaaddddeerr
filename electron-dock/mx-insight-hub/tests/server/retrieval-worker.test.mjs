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
  f.jobs.heartbeat = async () => {
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
