import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { RetrievalJobs, RetrievalControl } from '../../server/retrieval/control.mjs'
// Optional isolated PostgreSQL engine, never a production database.
// MX_RETRIEVAL_TEST_PGLITE points to an installed @electric-sql/pglite entry.
test(
  'durable retrieval queue SQL: coalescing, budget, fencing, pause, tombstones and resumable backfill',
  { skip: !process.env.MX_RETRIEVAL_TEST_PGLITE },
  async () => {
    const { PGlite } = await import(process.env.MX_RETRIEVAL_TEST_PGLITE)
    const db = new PGlite()
    const pool = {
      async query(sql, args) {
        const result = await db.query(sql, args)
        return { ...result, rowCount: result.affectedRows }
      },
      async connect() {
        return { query: pool.query, release() {} }
      },
    }
    try {
      await db.exec(`CREATE SCHEMA core;CREATE SCHEMA outbox;
      CREATE TABLE core.canonical_records(id uuid PRIMARY KEY,projection_revision bigint,current_revision int DEFAULT 1,
        title text,body text DEFAULT '这是一段用于验证历史初始化范围的已入库正文，需要满足最短可检索文本要求。',deleted_at timestamptz);
      CREATE TABLE core.record_chunks(id uuid,record_id uuid,projection_failed_at timestamptz,projection_attempts int);
      CREATE TABLE outbox.projection_events(aggregate_type text,aggregate_id uuid,projection_revision bigint,event_type text);`)
      await db.exec(
        await readFile(new URL('../../migrations/086_retrieval_jobs.sql', import.meta.url), 'utf8'),
      )
      await db.exec(await readFile(new URL('../../migrations/087_retrieval_initialization_budget.sql', import.meta.url), 'utf8'))
      const jobs = new RetrievalJobs(pool),
        control = new RetrievalControl({
          pool,
          agent: { embeddings: { available: true, dimensions: 2 } },
          search: {
            chunkIndexSet: { writeAlias: 'chunks', mappings: { properties: { embedding: { dims: 2 } } } },
            client: {
              request: async () => ({
                idx: {
                  mappings: { properties: { embedding: { dims: 2 }, embeddingSpace: { type: 'keyword' } } },
                },
              }),
            },
            segmenter: {
              segmentWithMeta: async () => ({ tokens: ['测试'], backendUsed: 'hanlp', degraded: false }),
            },
          },
        })
      const id = randomUUID(),
        other = randomUUID()
      const event = async (id, rev, type = 'upsert') =>
        pool.query(`INSERT INTO outbox.projection_events VALUES('canonical_record',$1,$2,$3)`, [
          id,
          rev,
          type,
        ])
      await event(id, 1)
      await event(id, 1)
      assert.equal((await pool.query('SELECT version FROM retrieval.jobs')).rows[0].version, 1)
      assert.equal(await jobs.claim(), null)
      await control.configure({ enabled: true, paused: false, maxConcurrency: 1, dailyTokenBudget: 1000 })
      const first = await jobs.claim()
      assert.equal(first.record_id, id)
      await event(other, 1)
      assert.equal(await jobs.claim(), null)
      await event(id, 2)
      await jobs.complete(first)
      assert.equal(
        (await pool.query('SELECT status FROM retrieval.jobs WHERE record_id=$1', [id])).rows[0].status,
        'pending',
      )
      const old = await jobs.claim()
      await pool.query(`UPDATE retrieval.jobs SET lease_until=now()-interval '1 second' WHERE record_id=$1`, [
        old.record_id,
      ])
      await assert.rejects(jobs.heartbeat(old), (e) => e.code === 'retrieval_lease_lost')
      await jobs.complete(old)
      assert.equal(
        (await pool.query('SELECT status FROM retrieval.jobs WHERE record_id=$1', [old.record_id])).rows[0]
          .status,
        'running',
      )
      await jobs.claim()
      await pool.query(
        "UPDATE retrieval.jobs SET run_at=now(),status='pending',lease_token=NULL,lease_until=NULL",
      )
      const replacement = await jobs.claim()
      await jobs.complete(old)
      assert.equal(
        (
          await pool.query('SELECT lease_token FROM retrieval.jobs WHERE record_id=$1', [
            replacement.record_id,
          ])
        ).rows[0].lease_token,
        replacement.lease_token,
      )
      await jobs.complete(replacement)
      await jobs.reserveTokens(800)
      await assert.rejects(jobs.reserveTokens(201), (e) => e.code === 'embedding_budget_exceeded')
      await pool.query('BEGIN')
      await event(id, 100)
      await pool.query('ROLLBACK')
      assert.equal(
        (await pool.query('SELECT requested_revision FROM retrieval.jobs WHERE record_id=$1', [id])).rows[0]
          .requested_revision,
        2,
      )
      await pool.query("UPDATE retrieval.jobs SET status='done',lease_token=NULL,lease_until=NULL")
      await control.configure({ enabled: true, paused: true, maxConcurrency: 1, dailyTokenBudget: 1000 })
      await event(id, 3, 'delete')
      const tombstone = await jobs.claim({ retireOnly: true })
      assert.equal(tombstone.record_id, id)
      assert.equal(tombstone.retire, true)
      await jobs.complete(tombstone)
      await control.configure({ enabled: true, paused: false, maxConcurrency: 1, dailyTokenBudget: 1000 })
      await pool.query('INSERT INTO core.canonical_records(id,projection_revision) VALUES($1,3)', [id])
      await assert.rejects(control.start(), (e) => e.code === 'retrieval_worker_unavailable')
      await pool.query('INSERT INTO retrieval.workers(id) VALUES($1)', [randomUUID()])
      await control.start()
      await assert.rejects(control.start(), (e) => e.code === 'retrieval_run_active')
      await jobs.seedBatch(250)
      const seeded = await jobs.claim()
      assert.equal(seeded.record_id, id)
      await jobs.complete(seeded)
      await event(randomUUID(), 1) // ongoing ingestion must not prevent the history run finishing
      await jobs.settleRun()
      assert.equal((await pool.query('SELECT status FROM retrieval.runs')).rows[0].status, 'completed')
      // The hot claim path must stay indexed even with a sizeable backlog.
      await db.exec(`INSERT INTO retrieval.jobs(record_id,requested_revision)
        SELECT md5(i::text)::uuid,1 FROM generate_series(1,50000) i;
        ANALYZE retrieval.jobs;`)
      const plan=await pool.query(`EXPLAIN (FORMAT JSON) SELECT record_id FROM retrieval.jobs
        WHERE status='pending' AND run_at<=now()
        ORDER BY retire DESC,priority,run_at,record_id FOR UPDATE SKIP LOCKED LIMIT 1`)
      assert.match(JSON.stringify(plan.rows),/retrieval_jobs_claim_idx/)
    } finally {
      await db.close()
    }
  },
)

test('chunk SQL preserves unchanged vectors, invalidates changed text, and queues deletion', {skip:!process.env.MX_RETRIEVAL_TEST_PGLITE},async()=>{
 const {PGlite}=await import(process.env.MX_RETRIEVAL_TEST_PGLITE)
 const {EmbeddingPipeline}=await import('../../server/embedding/pipeline.mjs')
 const db=new PGlite(),id=randomUUID()
 const query=async(sql,args)=>{const r=await db.query(sql,args);return{...r,rowCount:r.affectedRows}}
 const pool={query,connect:async()=>({query,release(){}})}
 try {
  await db.exec(`CREATE SCHEMA core;
   CREATE TABLE core.canonical_records(id uuid PRIMARY KEY,dataset_id text,platform text,external_id text,url text,title text,body text,event_time timestamptz,current_revision int,deleted_at timestamptz);
   CREATE TABLE core.record_chunks(id uuid PRIMARY KEY,record_id uuid,chunk_index int,content text,token_count int,chunker_version text,source_revision bigint,embedding_model text,embedding_version int,embedded_at timestamptz,vector real[],projected_at timestamptz,projection_attempts int DEFAULT 0,projection_last_error text,projection_failed_at timestamptz,UNIQUE(record_id,chunk_index,chunker_version));
   CREATE TABLE core.chunk_projection_deletes(document_id text PRIMARY KEY,record_id uuid,source_revision bigint,projected_at timestamptz,updated_at timestamptz DEFAULT now());`)
  await query('INSERT INTO core.canonical_records(id,title,body,current_revision) VALUES($1,$2,$3,1)',[id,'标题','这是一段真实结构的长文本，用于验证切分修订与向量缓存保留。'])
  const pipeline=new EmbeddingPipeline({pool})
  await pipeline.materializeChunks({recordId:id})
  await query("UPDATE core.record_chunks SET embedding_model='test:model',embedding_version=1,embedded_at=now(),vector=ARRAY[0.1,0.2]::real[],projected_at=now()")
  await query('UPDATE core.canonical_records SET current_revision=2')
  await pipeline.materializeChunks({recordId:id})
  const retained=(await query('SELECT * FROM core.record_chunks')).rows[0]
  assert.equal(retained.source_revision,2);assert.ok(retained.vector);assert.equal(retained.projected_at,null)
  await query("UPDATE core.canonical_records SET current_revision=3,body='修改后的正文，是一段与之前不同的内容，需要重新产生嵌入向量。'")
  await pipeline.materializeChunks({recordId:id})
  const changed=(await query('SELECT * FROM core.record_chunks')).rows[0]
  assert.equal(changed.source_revision,3);assert.equal(changed.vector,null);assert.equal(changed.embedded_at,null)
  await query('UPDATE core.canonical_records SET current_revision=4,deleted_at=now()')
  await pipeline.materializeChunks({recordId:id})
  assert.equal((await query('SELECT * FROM core.record_chunks')).rows.length,0)
  assert.equal((await query('SELECT * FROM core.chunk_projection_deletes')).rows[0].source_revision,4)
 }finally{await db.close()}
})
