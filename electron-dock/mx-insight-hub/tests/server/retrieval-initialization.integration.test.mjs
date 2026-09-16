import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { RetrievalJobs, RetrievalControl } from '../../server/retrieval/control.mjs'

async function fixture(t) {
  const { PGlite } = await import(process.env.MX_RETRIEVAL_TEST_PGLITE)
  const db = new PGlite()
  t.after(() => db.close())
  const query = async (sql, args) => {
    const r = await db.query(sql, args)
    return { ...r, rowCount: r.affectedRows }
  }
  const pool = { query, connect: async () => ({ query, release() {} }) }
  await db.exec(`CREATE SCHEMA core; CREATE SCHEMA outbox;
    CREATE TABLE core.canonical_records(id uuid PRIMARY KEY,projection_revision bigint DEFAULT 1,current_revision int DEFAULT 1,
      title text,body text DEFAULT '初始化任务使用固定的文本版本，新版本与新记录使用每日增量预算。',deleted_at timestamptz);
    CREATE TABLE core.record_chunks(id uuid,record_id uuid,projection_failed_at timestamptz,projection_attempts int);
    CREATE TABLE outbox.projection_events(aggregate_type text,aggregate_id uuid,projection_revision bigint,event_type text);`)
  for (const file of ['026_search_reindex_operations.sql', '086_retrieval_jobs.sql', '087_retrieval_initialization_budget.sql', '089_indexing_observation.sql'])
    await db.exec(await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'))
  const control = new RetrievalControl({ pool, agent: { embeddings: { available: true, dimensions: 2 } }, search: {
    chunkIndexSet: { writeAlias: 'chunks', mappings: { properties: { embedding: { dims: 2 } } } },
    client: { request: async () => ({ idx: { mappings: { properties: { embedding: { dims: 2 }, embeddingSpace: {} } } } }) },
    segmenter: { segmentWithMeta: async () => ({ tokens: ['测试'], backendUsed: 'hanlp', degraded: false }) },
  } })
  const jobs = new RetrievalJobs(pool)
  await query('INSERT INTO retrieval.workers(id) VALUES($1)', [randomUUID()])
  await control.configure({ enabled: true, paused: false, maxConcurrency: 2, dailyTokenBudget: 1000 })
  const event = (id, rev = 1, type = 'upsert') => query(
    `INSERT INTO outbox.projection_events VALUES('canonical_record',$1,$2,$3)`, [id, rev, type],
  )
  const add = async (id = randomUUID()) => {
    await query('INSERT INTO core.canonical_records(id) VALUES($1)', [id])
    await event(id)
    return id
  }
  const run = async () => (await query('SELECT * FROM retrieval.runs ORDER BY started_at DESC LIMIT 1')).rows[0]
  return { db, query, control, jobs, event, add, run }
}
const options = { skip: !process.env.MX_RETRIEVAL_TEST_PGLITE }

test('ETA detects a remaining budget too small for the next batch, even before the budget is numerically exhausted', options, async (t) => {
  const f = await fixture(t)
  await f.add()
  await f.control.start({ tokenBudget: 100 })
  await f.jobs.seedBatch()
  const job = await f.jobs.claim()
  await f.jobs.reserveTokens(90, job, 1)
  let failure
  try { await f.jobs.reserveTokens(20, job, 1) } catch (error) { failure = error }
  assert.equal(failure?.code, 'initialization_budget_exceeded')
  await f.jobs.fail(job, failure)
  await f.query('UPDATE retrieval.workers SET telemetry=$1::jsonb', [JSON.stringify({ sampledAt: Date.now(), stages: {}, active: [] })])
  f.control.progressCache = null
  const status = await f.control.status()
  assert.equal(Number(status.run.reserved_tokens), 90)
  assert.equal(status.run.progress.budgetBlocked, true)
  assert.equal(status.observation.eta.reason, 'initialization_budget')
  assert.equal(status.observation.eta.seconds, null)
})

test('initialization ETA uses fixed manifest progress, isolates daily quota and hides estimates on pause / stale worker metrics', options, async (t) => {
  const f = await fixture(t), id = await f.add()
  await f.add()
  await f.control.start({ tokenBudget: 0 })
  const run = await f.run(), config = (await f.query('SELECT * FROM retrieval.settings')).rows[0]
  await f.query("UPDATE retrieval.run_items SET status='completed',finished_at=now() WHERE record_id=$1", [id])
  await f.jobs.reserveTokens(1000) // Exhaust daily quota, not initialization.
  await f.query('UPDATE retrieval.workers SET telemetry=$1::jsonb', [JSON.stringify({ sampledAt: Date.now(), stages: {
    embedding: { calls: 3, failed: 0, ms: 600, maxMs: 250 },
  }, active: [] })])
  f.control.progressCache = null
  f.control.rate.estimate({ key: `${run.id}:${config.updated_at}`, at: Date.now() - 31000, processed: 0, remaining: 2 })
  let status = await f.control.status()
  assert.equal(status.observation.scope, 'initialization')
  assert.equal(status.observation.eta.reason, 'estimated')
  assert.ok(status.observation.eta.seconds >= 30 && status.observation.eta.seconds <= 35)
  assert.equal(status.observation.effectiveConcurrency, 1, 'two configured slots do not invent a second worker')
  assert.equal(status.observation.stages.embedding.calls, 3)
  status = await f.control.configure({ enabled: true, paused: true, maxConcurrency: 2, dailyTokenBudget: 1000 })
  assert.equal(status.observation.eta.reason, 'paused')
  assert.equal(status.observation.eta.seconds, null)
  await f.query("UPDATE retrieval.workers SET telemetry=jsonb_set(telemetry,'{sampledAt}',to_jsonb($1::bigint))", [Date.now() - 60000])
  status = await f.control.configure({ enabled: true, paused: false, maxConcurrency: 2, dailyTokenBudget: 1000 })
  assert.equal(status.observation.eta.reason, 'stale')
  assert.equal(status.observation.reportingWorkers, 0)
})

test('initialization freezes membership and versions, spends separate quota, then leaves daily processing intact', options, async (t) => {
  const f = await fixture(t)
  const a = await f.add('40000000-0000-4000-8000-000000000001')
  const b = await f.add('50000000-0000-4000-8000-000000000001')
  await f.query("INSERT INTO core.canonical_records(id,body) VALUES($1,'短文本')", [randomUUID()])
  await f.query('INSERT INTO core.canonical_records(id,deleted_at) VALUES($1,now())', [randomUUID()])
  await f.control.start({ tokenBudget: 100 })
  assert.equal(Number((await f.run()).target_count), 2)
  // New UUID is below the scan cursor: time membership cannot rely on UUID order.
  const later = await f.add('10000000-0000-4000-8000-000000000001')
  await f.query('UPDATE core.canonical_records SET projection_revision=2,current_revision=2 WHERE id=$1', [b])
  await f.event(b, 2)
  await f.jobs.seedBatch()
  assert.equal((await f.query('SELECT count(*) FROM retrieval.run_items WHERE record_id=$1', [later])).rows[0].count, 0)
  await f.jobs.reserveTokens(1000) // daily quota is already exhausted
  const history = await f.jobs.claim()
  // Depending on UUID order, daily jobs can be admitted first; defer them.
  let job = history
  while (job.record_id !== a) {
    await assert.rejects(f.jobs.reserveTokens(1, job, job.record_id === b ? 2 : 1), { code: 'embedding_budget_exceeded' })
    await f.jobs.fail(job, { code: 'embedding_budget_exceeded' })
    job = await f.jobs.claim()
  }
  assert.equal((await f.jobs.reserveTokens(80, job, 1)).scope, 'initialization')
  await assert.rejects(f.jobs.reserveTokens(21, job, 1), { code: 'initialization_budget_exceeded' })
  assert.equal(Number((await f.run()).reserved_tokens), 80)
  await f.control.configureBackfill({ tokenBudget: 0 })
  await f.jobs.reserveTokens(2000, job, 1)
  assert.equal(Number((await f.run()).reserved_tokens), 2080)
  assert.equal(Number((await f.query('SELECT reserved_tokens FROM retrieval.daily_usage')).rows[0].reserved_tokens), 1000)
  await f.jobs.complete(job)
  await f.jobs.settleRun()
  assert.equal((await f.run()).status, 'completed')
  const terminal = await f.control.status()
  assert.equal(terminal.run.progress.completed, 1)
  assert.equal(terminal.run.progress.superseded, 1)
  assert.equal(terminal.run.progress.pending || 0, 0)
  assert.equal((await f.query('SELECT status FROM retrieval.run_items WHERE record_id=$1', [b])).rows[0].status, 'superseded')
  assert.equal(Number((await f.query('SELECT daily_token_budget FROM retrieval.settings')).rows[0].daily_token_budget), 1000)
  assert.equal((await f.query('SELECT status FROM retrieval.jobs WHERE record_id=$1', [later])).rows[0].status, 'pending')
  // Raising the daily budget resumes deferred increments without restarting history.
  await f.control.configure({ enabled: true, paused: false, maxConcurrency: 2, dailyTokenBudget: 2000 })
  const resumed = await f.jobs.claim()
  assert.equal((await f.jobs.reserveTokens(100, resumed, resumed.record_id === b ? 2 : 1)).scope, 'daily')
})

test('captured records changed before seeding or while running cannot charge new text to unlimited initialization', options, async (t) => {
  const f = await fixture(t), id = await f.add()
  await f.control.start({ tokenBudget: 0 })
  await f.jobs.seedBatch()
  const job = await f.jobs.claim()
  await f.query('UPDATE core.canonical_records SET projection_revision=2,current_revision=2 WHERE id=$1', [id])
  await f.event(id, 2)
  assert.equal((await f.jobs.reserveTokens(100, job, 2)).scope, 'daily')
  await f.jobs.complete(job)
  await f.jobs.settleRun()
  assert.equal((await f.run()).status, 'completed')
  assert.equal(Number((await f.run()).reserved_tokens), 0)
  assert.equal((await f.query('SELECT status FROM retrieval.jobs')).rows[0].status, 'pending')
})

test('seeding closes concurrent-capture visibility races and ignores later random IDs', options, async (t) => {
  const f = await fixture(t), id = await f.add()
  await f.control.start({ tokenBudget: 0 })
  // Simulate an update whose trigger could not see the uncommitted manifest.
  await f.query('UPDATE core.canonical_records SET projection_revision=2,current_revision=2 WHERE id=$1', [id])
  await f.add()
  await f.jobs.seedBatch(1)
  await f.jobs.seedBatch(1)
  await f.jobs.settleRun()
  assert.equal((await f.run()).status, 'completed')
  assert.equal(Number((await f.run()).seeded), 1)
  assert.equal((await f.query('SELECT status FROM retrieval.run_items')).rows[0].status, 'superseded')
})

test('paused, cancelled and expired-lease runs cannot spend initialization budget; empty ranges finish', options, async (t) => {
  const f = await fixture(t)
  await f.control.start({ tokenBudget: 0 })
  assert.equal((await f.run()).status, 'completed')
  await assert.rejects(f.control.start({ tokenBudget: -1 }), { code: 'invalid_retrieval_request' })
  await assert.rejects(f.control.start({ tokenBudget: 0, model: 'override' }), { code: 'invalid_retrieval_request' })
  await f.add()
  await f.control.start({ tokenBudget: 0 })
  await f.jobs.seedBatch()
  const job = await f.jobs.claim()
  await f.control.configure({ enabled: true, paused: true, maxConcurrency: 2, dailyTokenBudget: 1000 })
  await assert.rejects(f.jobs.reserveTokens(1, job, 1), { code: 'initialization_budget_exceeded' })
  await f.control.configure({ enabled: true, paused: false, maxConcurrency: 2, dailyTokenBudget: 1000 })
  await f.query("UPDATE retrieval.jobs SET lease_until=now()-interval '1 second'")
  await assert.rejects(f.jobs.reserveTokens(1, job, 1), { code: 'initialization_budget_exceeded' })
  assert.equal(Number((await f.run()).reserved_tokens), 0)
  await f.control.cancel()
  await assert.rejects(f.jobs.reserveTokens(1, job, 1), { code: 'embedding_budget_exceeded' })
  await assert.rejects(f.control.configureBackfill({ tokenBudget: 100 }), { code: 'retrieval_run_inactive' })
})
