import assert from 'node:assert/strict'
import test from 'node:test'
import { MemoryCollectStore, PostgresCollectStore } from '../../server/collect/store.mjs'
import { ingestTiebaPostSearchResult } from '../../server/workers/ingest.mjs'
import { canonicalJson, sha256 } from '../../server/ingest/normalizers.mjs'

const JOB = '10101010-1010-4010-8010-101010101010'
const CAP = 'collect.tieba.posts.search'
const capturedAt = '2026-11-18T01:00:00.000Z'
const ingestion = () => ({ kind: 'tieba-post-search-result', version: 1,
  input: { query: '测试', maxResults: 1, page: 1, maxPages: 1 }, taskId: 10, runId: 11, capturedAt,
  items: [{ record_type: 'tieba.thread', source_id: '123', source_url: 'https://tieba.baidu.com/p/123',
    title: '帖子标题', text: '帖子摘要', author: { id: '5', name: '作者' }, published_at: null,
    metrics: { replies: 0, likes: 1, shares: null }, media: [],
    attributes: { query: '测试', page: 1, forum: '测试吧' }, raw: { original: 'restricted source evidence' } }] })
const outcome = () => ({ status: 'succeeded', dataStatus: 'success', charge: true, itemCount: 1,
  result: { items: [{ id: '123', title: '帖子标题', body: '帖子摘要' }] }, ingestion: ingestion() })

function memory(capability = CAP) {
  const jobs = new MemoryCollectStore()
  jobs.jobs.set(JOB, { id: JOB, capability, status: 'running', owner: 'worker', engineId: 'tieba.main', slotNo: 1 })
  jobs.engines.set('tieba.main', { id: 'tieba.main', capacity: 1 })
  jobs.slots.set('tieba.main:1', { jobId: JOB, slotNo: 1 })
  return jobs
}
const finish = (jobs, value = outcome()) => jobs.finish({ jobId: JOB, owner: 'worker', outcome: value, billing: 'none' })

test('Tieba collection seals public result and exactly one restricted ingest job; a late result cannot replace it', async () => {
  const jobs = memory()
  assert.equal((await finish(jobs)).fenced, false)
  const stored = await jobs.result(JOB)
  assert.equal(JSON.stringify(stored.payload).includes('restricted'), false)
  const queued = [...jobs.ingestJobs.values()][0]
  assert.equal(queued.queue, 'ingest')
  assert.equal(queued.payload.jobId, JOB)
  assert.equal(queued.payload.resultSha256, stored.sha256)
  assert.equal(jobs.jobs.get(JOB).upstreamState.ingestionSha256, sha256(canonicalJson(queued.payload)))
  assert.equal(stored.payload.ingestionSha256, undefined)
  assert.equal(queued.payload.ingestionSha256, undefined)
  assert.equal(queued.payload.items[0].raw.original, 'restricted source evidence')
  assert.equal(jobs.slots.get('tieba.main:1').jobId, null)
  assert.equal((await finish(jobs, { ...outcome(), ingestion: { ...ingestion(), items: [] } })).fenced, true)
  assert.equal(jobs.ingestJobs.size, 1)
  assert.equal([...jobs.ingestJobs.values()][0].payload.items.length, 1)
})

test('invalid or missing Tieba ingestion cannot leave a successful public job without cleaning work', async () => {
  for (const mutate of [value => { delete value.ingestion }, value => { value.ingestion.version = 2 },
    value => { value.ingestion.items[0].record_type = 'tieba.user' },
    value => { value.ingestion.items[0].raw.original = '\0' },
    value => { value.ingestion.items = Array.from({ length: 101 }, () => ingestion().items[0]) }]) {
    const jobs = memory(), value = outcome()
    mutate(value)
    await assert.rejects(finish(jobs, value), /collect_ingestion_contract_mismatch/)
    assert.equal(jobs.jobs.get(JOB).status, 'running')
    assert.equal(jobs.results.size, 0)
    assert.equal(jobs.ingestJobs.size, 0)
    assert.equal(jobs.slots.get('tieba.main:1').jobId, JOB)
  }
  const other = memory('collect.app.details')
  await assert.rejects(finish(other), /collect_ingestion_contract_mismatch/)
  assert.equal(other.jobs.get(JOB).status, 'running')
})

test('failed collection never enqueues ingestion; empty successful search has a durable no-data ingest record', async () => {
  const failed = memory()
  await finish(failed, { status: 'failed', error: { code: 'upstream_failed' }, ingestion: ingestion() })
  assert.equal(failed.ingestJobs.size, 0)
  const empty = memory()
  await finish(empty, { ...outcome(), dataStatus: 'no_data', itemCount: 0, result: { items: [] }, ingestion: { ...ingestion(), items: [] } })
  assert.equal([...empty.ingestJobs.values()][0].payload.items.length, 0)
})

test('pending, running and dead cleaning jobs keep their source result past collection retention', async () => {
  const jobs = memory()
  await finish(jobs)
  jobs.jobs.get(JOB).finishedAt = '2020-01-01T00:00:00.000Z'
  const queued = [...jobs.ingestJobs.values()][0]
  for (const state of ['pending', 'running', 'dead']) {
    queued.status = state
    assert.equal(await jobs.prune(1), 0, state)
  }
  queued.status = 'done'
  assert.equal(await jobs.prune(1), 1)
})

function postgresFixture({ rejectQueue = false } = {}) {
  const sql = [], results = [], queued = [], seals = []
  let pendingResults = [], pendingQueue = [], pendingSeals = []
  const client = { release() {}, async query(query, values = []) {
    sql.push(query)
    if (query === 'BEGIN') { pendingResults = []; pendingQueue = []; pendingSeals = [] }
    if (query === 'COMMIT') { results.push(...pendingResults); queued.push(...pendingQueue); seals.push(...pendingSeals) }
    if (query === 'ROLLBACK') { pendingResults = []; pendingQueue = []; pendingSeals = [] }
    if (query.startsWith('UPDATE collect.jobs SET status')) return { rows: [{ id: JOB, capability: CAP, status: 'succeeded',
      engine_id: 'tieba.main', slot_no: 1 }] }
    if (query.startsWith('INSERT INTO collect.job_results')) pendingResults.push(values)
    if (query.startsWith('UPDATE collect.jobs SET upstream_state')) pendingSeals.push(values)
    if (query.startsWith('INSERT INTO mxq.jobs')) {
      if (rejectQueue) throw new Error('queue unavailable')
      pendingQueue.push(values)
    }
    return { rows: [], rowCount: 1 }
  } }
  return { jobs: new PostgresCollectStore({ connect: async () => client }), sql, results, queued, seals }
}

test('PostgreSQL finish enqueues restricted evidence in the same transaction as the public result', async () => {
  const fx = postgresFixture()
  await finish(fx.jobs)
  assert.equal(fx.results.length, 1)
  assert.equal(fx.queued.length, 1)
  const payload = JSON.parse(fx.queued[0][1])
  assert.equal(payload.jobId, JOB)
  assert.equal(payload.resultSha256, fx.results[0][3])
  assert.deepEqual(fx.seals, [[JOB, sha256(canonicalJson(payload))]])
  assert.equal(fx.sql.at(-1), 'COMMIT')
  assert.match(fx.sql.find(sql => sql.startsWith('INSERT INTO mxq.jobs')), /ON CONFLICT \(queue, dedupe_key\)/)
})

test('PostgreSQL queue failure rolls back result completion, leaving collection retry reconciliation possible', async () => {
  const fx = postgresFixture({ rejectQueue: true })
  await assert.rejects(finish(fx.jobs), /queue unavailable/)
  assert.equal(fx.results.length, 0)
  assert.equal(fx.queued.length, 0)
  assert.equal(fx.seals.length, 0)
  assert.equal(fx.sql.at(-1), 'ROLLBACK')
  assert.equal(fx.sql.includes('COMMIT'), false)
})

async function queuedFixture() {
  const jobs = memory()
  jobs.jobs.get(JOB).upstreamState = { taskId: 10, runId: 11 }
  await finish(jobs)
  const job = jobs.jobs.get(JOB)
  assert.equal(job.upstreamState.taskId, 10)
  assert.equal(job.upstreamState.runId, 11)
  return { payload: [...jobs.ingestJobs.values()][0].payload,
    committed: { capability: job.capability, status: job.status, sha256: (await jobs.result(JOB)).sha256,
      ingestion_sha256: job.upstreamState.ingestionSha256 } }
}

test('ingest worker rehydrates raw Tieba evidence under a dedicated dataset and retries without acquisition or billing', async () => {
  const { payload, committed } = await queuedFixture(), calls = []
  const deps = { pool: { query: async () => ({ rows: [committed] }) },
    store: { async ingestExternalRecords(value) { calls.push(value); if (calls.length === 1) throw new Error('temporary storage failure'); return { ingested: 1, changed: 1 } } } }
  await assert.rejects(ingestTiebaPostSearchResult(payload, deps), /temporary storage failure/)
  assert.deepEqual(await ingestTiebaPostSearchResult(payload, deps), { ingested: 1, changed: 1 })
  const row = calls[1]
  assert.equal(row.datasetId, 'tieba.posts.v1')
  assert.equal(row.platform, 'tieba')
  assert.equal(row.connectorId, 'collect:tieba-post-search')
  assert.equal(row.records[0].externalId, '123')
  assert.equal(row.records[0].objectType, 'post')
  assert.ok(JSON.stringify(row.records[0].rawItem).includes('restricted source evidence'))
  assert.deepEqual(calls[0], calls[1])
})

test('ingest worker rejects absent, unfinished, wrong-capability or changed public results before canonical writes', async () => {
  const { payload } = await queuedFixture()
  for (const row of [null, { capability: CAP, status: 'running', sha256: payload.resultSha256 },
    { capability: 'collect.app.details', status: 'succeeded', sha256: payload.resultSha256 },
    { capability: CAP, status: 'succeeded', sha256: 'f'.repeat(64) }]) {
    let writes = 0
    await assert.rejects(ingestTiebaPostSearchResult(payload, {
      pool: { query: async () => ({ rows: row ? [row] : [] }) },
      store: { ingestExternalRecords() { writes++ } },
    }), /tieba_ingest_result_mismatch/)
    assert.equal(writes, 0)
  }
})

test('ingest worker rejects changed restricted evidence even when the public result hash is unchanged', async () => {
  const { payload, committed } = await queuedFixture()
  for (const mutate of [value => { value.items[0].title = '替换标题' },
    value => { value.items[0].raw.original = 'replaced source evidence' },
    value => { value.capturedAt = '2026-11-18T02:00:00.000Z' },
    value => { value.input.query = '替换查询'; value.items[0].attributes.query = '替换查询' }]) {
    const changed = structuredClone(payload)
    mutate(changed)
    assert.equal(changed.resultSha256, committed.sha256)
    let writes = 0
    await assert.rejects(ingestTiebaPostSearchResult(changed, {
      pool: { query: async () => ({ rows: [committed] }) },
      store: { ingestExternalRecords() { writes++ } },
    }), /tieba_ingest_evidence_mismatch/)
    assert.equal(writes, 0)
  }
  for (const seal of [undefined, '', 'f'.repeat(64)]) {
    await assert.rejects(ingestTiebaPostSearchResult(payload, {
      pool: { query: async () => ({ rows: [{ ...committed, ingestion_sha256: seal }] }) },
      store: { ingestExternalRecords() { assert.fail('unsealed evidence must not be ingested') } },
    }), /tieba_ingest_evidence_mismatch/)
  }
})

test('ingest worker accepts JSONB object key reordering without changing the sealed evidence', async () => {
  const { payload, committed } = await queuedFixture()
  const reverseKeys = value => Array.isArray(value) ? value.map(reverseKeys)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)])) : value
  const reordered = reverseKeys(payload)
  assert.notEqual(JSON.stringify(reordered), JSON.stringify(payload))
  assert.equal(sha256(canonicalJson(reordered)), committed.ingestion_sha256)
  const writes = []
  const deps = { pool: { query: async () => ({ rows: [committed] }) },
    store: { async ingestExternalRecords(value) { writes.push(value); return { ingested: 1, changed: 1 } } } }
  await ingestTiebaPostSearchResult(payload, deps)
  await ingestTiebaPostSearchResult(reordered, deps)
  assert.deepEqual(writes[0], writes[1])
})
