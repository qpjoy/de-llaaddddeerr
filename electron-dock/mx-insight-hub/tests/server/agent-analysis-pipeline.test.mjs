import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  AgentPipelineStore,
  assertionRow,
  pipelineRow,
} from '../../server/agent/pipeline-store.mjs'

test('migration 034 installs a paused backlog over append-only raw revisions', async () => {
  const migration = await readFile(
    new URL('../../migrations/034_agent_analysis_pipelines.sql', import.meta.url),
    'utf8',
  )

  assert.match(migration, /status text NOT NULL DEFAULT 'paused'/)
  assert.match(
    migration,
    /'province-geography-v1'[\s\S]*?'paused'[\s\S]*?'province-geography\.v1'/,
  )
  assert.match(migration, /applying the migration never starts Agent or HanLP calls/)
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ingest\.source_object_revisions/)
  assert.match(migration, /raw_payload_hash_version smallint NOT NULL DEFAULT 0/)
  assert.match(migration, /payload_hash_version smallint NOT NULL DEFAULT 1/)
  assert.match(migration, /raw_payload jsonb NOT NULL/)
  assert.match(migration, /UNIQUE \(source_object_id, revision\)/)
  assert.doesNotMatch(migration, /UNIQUE \(source_object_id, payload_sha256\)/)
  assert.doesNotMatch(migration, /REFERENCES (?:ingest\.source_objects|ingest\.source_object_revisions|core\.canonical_records|agent_center\.analysis_tasks)\([^)]*\) ON DELETE CASCADE/)
  assert.match(migration, /source_object_revisions_payload_idx/)
  assert.match(
    migration,
    /INSERT INTO ingest\.source_object_revisions[\s\S]*?ON CONFLICT \(source_object_id, revision\) DO NOTHING/,
  )
  assert.match(
    migration,
    /UNIQUE \([\s\S]*?source_object_revision_id,[\s\S]*?canonical_revision,[\s\S]*?analysis_version[\s\S]*?\)/,
  )
  assert.doesNotMatch(migration, /(?:UPDATE|DELETE FROM)\s+ingest\.source_object_revisions/i)
})

test('pipeline update rejects a revision-only no-op before touching PostgreSQL', async () => {
  let queries = 0
  const store = new AgentPipelineStore({
    async query() {
      queries += 1
      throw new Error('a no-op must not reach PostgreSQL')
    },
  })

  await assert.rejects(
    store.updatePipeline('province-geography-v1', { expectedRevision: 7 }),
    (error) => error?.code === 'invalid_agent_pipeline',
  )
  assert.equal(queries, 0)
})

test('migration 034 keeps Agent output proposed and outside canonical truth', async () => {
  const migration = await readFile(
    new URL('../../migrations/034_agent_analysis_pipelines.sql', import.meta.url),
    'utf8',
  )

  assert.match(migration, /CREATE TABLE IF NOT EXISTS agent_center\.classification_assertions/)
  assert.match(migration, /proposed_value jsonb NOT NULL/)
  assert.match(migration, /status text NOT NULL DEFAULT 'proposed'/)
  assert.match(migration, /method IN \('source', 'rule', 'agent', 'manual'\)/)
  assert.match(migration, /Agent proposals never mutate canonical or upstream facts/)
  assert.doesNotMatch(migration, /UPDATE\s+core\.canonical_records/i)
  assert.doesNotMatch(migration, /UPDATE\s+ingest\.source_objects/i)
  assert.doesNotMatch(migration, /INSERT INTO\s+core\.record_revisions/i)
})

test('raw source revisions preserve an A to B to A sequence instead of deduplicating by hash', async () => {
  const store = await readFile(
    new URL('../../server/stores/postgres-store.mjs', import.meta.url),
    'utf8',
  )
  assert.match(
    store,
    /current_revision = ingest\.source_objects\.current_revision[\s\S]*?payload_sha256 IS DISTINCT FROM EXCLUDED\.payload_sha256/,
  )
  assert.match(
    store,
    /INSERT INTO ingest\.source_object_revisions[\s\S]*?ON CONFLICT \(source_object_id, revision\) DO NOTHING/,
  )
  assert.match(
    store,
    /SELECT id FROM ingest\.source_object_revisions[\s\S]*?source_object_id = \$1 AND revision = \$2/,
  )
  assert.match(
    store,
    /ON CONFLICT[\s\S]*?source_object_revision_id,[\s\S]*?canonical_revision, analysis_version/,
  )
  assert.doesNotMatch(
    store,
    /ON CONFLICT \(source_object_id, payload_sha256\) DO NOTHING/,
  )
  assert.match(
    store,
    /raw_payload_hash_version = 0[\s\S]*?raw_payload - 'updated_at'[\s\S]*?IS DISTINCT FROM/,
  )
  assert.match(store, /raw_payload_hash_version = 1/)
})

test('pipeline and assertion rows serialize database numerics and timestamps for the Admin API', () => {
  const updatedAt = new Date('2026-08-24T10:00:00.000Z')
  const nextDispatchAt = new Date('2026-08-24T10:01:00.000Z')
  const oldestPendingAt = new Date('2026-08-24T09:00:00.000Z')
  const lastCompletedAt = new Date('2026-08-24T09:30:00.000Z')
  const pipeline = pipelineRow({
    pipeline_key: 'province-geography-v1',
    display_name: '全国省份舆情地理分类',
    task_type: 'record.classification',
    status: 'paused',
    revision: '7',
    analysis_version: 'province-geography.v1',
    taxonomy_version: 'cn-geography.v1',
    rule_version: 'province-evidence.2026-08',
    prompt_version: 'province-analysis.v1',
    items_per_minute: '12',
    max_in_flight: '1',
    next_dispatch_at: nextDispatchAt,
    updated_by: 'admin-token',
    updated_at: updatedAt,
    pending_count: '3',
    running_count: '1',
    succeeded_count: '8',
    dead_count: '2',
    superseded_count: '4',
    task_count: '18',
    oldest_pending_at: oldestPendingAt,
    last_completed_at: lastCompletedAt,
    proposed_count: '5',
    accepted_count: '2',
    rejected_count: '1',
    assertion_superseded_count: '3',
    assertion_count: '11',
  })

  assert.equal(pipeline.revision, 7)
  assert.equal(pipeline.itemsPerMinute, 12)
  assert.equal(pipeline.maxInFlight, 1)
  assert.equal(pipeline.nextDispatchAt, nextDispatchAt.toISOString())
  assert.equal(pipeline.updatedAt, updatedAt.toISOString())
  assert.deepEqual(pipeline.tasks, {
    pending: 3,
    running: 1,
    succeeded: 8,
    dead: 2,
    superseded: 4,
    total: 18,
    oldestPendingAt: oldestPendingAt.toISOString(),
    lastCompletedAt: lastCompletedAt.toISOString(),
  })
  assert.deepEqual(pipeline.assertions, {
    proposed: 5,
    accepted: 2,
    rejected: 1,
    superseded: 3,
    total: 11,
  })

  const createdAt = new Date('2026-08-24T10:02:00.000Z')
  const assertion = assertionRow({
    assertion_id: 'assertion-1',
    task_id: '42',
    pipeline_key: 'province-geography-v1',
    record_id: 'record-1',
    source_object_revision_id: '9',
    canonical_revision: '3',
    field_key: 'geography.event_admin1_code',
    proposed_value: 'CN-JS',
    method: 'agent',
    confidence: '0.875',
    evidence_refs: [{ path: 'event_text', quote: '江苏' }],
    taxonomy_version: 'cn-geography.v1',
    rule_version: null,
    provider_id: 'provider-1',
    model: 'model-1',
    prompt_version: 'province-analysis.v1',
    status: 'proposed',
    created_at: createdAt,
  })

  assert.equal(assertion.taskId, 42)
  assert.equal(assertion.sourceObjectRevisionId, 9)
  assert.equal(assertion.canonicalRevision, 3)
  assert.equal(assertion.confidence, 0.875)
  assert.equal(assertion.proposedValue, 'CN-JS')
  assert.deepEqual(assertion.evidenceRefs, [{ path: 'event_text', quote: '江苏' }])
  assert.equal(assertion.status, 'proposed')
  assert.equal(assertion.createdAt, createdAt.toISOString())
})

test('claim completion binds proposed values and evidence as JSON rather than PostgreSQL arrays', async () => {
  let assertionParameters = null
  const client = {
    async query(sql, parameters = []) {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 }
      if (sql === 'ROLLBACK') return { rows: [], rowCount: 0 }
      if (sql.includes('SELECT task.*, source_revision.revision')) {
        return {
          rows: [{
            status: 'running',
            locked_by: 'worker-1',
            claim_generation: '1',
            canonical_revision: '2',
            current_canonical_revision: '2',
            source_revision_number: '3',
            current_source_revision: '3',
          }],
          rowCount: 1,
        }
      }
      if (sql.includes('INSERT INTO agent_center.classification_assertions')) {
        assertionParameters = parameters
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes("SET status = 'succeeded'")) return { rows: [], rowCount: 1 }
      throw new Error(`unexpected SQL: ${sql}`)
    },
    release() {},
  }
  const store = new AgentPipelineStore({
    async connect() { return client },
  })
  const claim = {
    taskId: 11,
    pipelineKey: 'province-geography-v1',
    recordId: '7c0b1152-14c8-4429-9be0-1b4c39071349',
    sourceObjectRevisionId: 21,
    canonicalRevision: 2,
    inputSha256: 'a'.repeat(64),
    taxonomyVersion: 'cn-geography.v1',
    ruleVersion: 'province-evidence.2026-08',
    promptVersion: 'province-analysis.v1',
    generation: 1,
    workerId: 'worker-1',
  }
  const evidence = [{ path: 'title', quote: '江苏发布会' }]

  const completed = await store.completeClaim(claim, {
    assertions: [{
      fieldKey: 'geography.event_admin1_code',
      value: 'CN-JS',
      method: 'agent',
      confidence: 0.9,
      evidenceRefs: evidence,
      status: 'proposed',
    }],
    summary: {},
  })

  assert.equal(completed.completed, true)
  assert.equal(assertionParameters[8], JSON.stringify('CN-JS'))
  assert.equal(assertionParameters[11], JSON.stringify(evidence))
  assert.deepEqual(JSON.parse(assertionParameters[11]), evidence)
})

test('assertion listing rejects unknown pipelines and invalid limits', async () => {
  const store = new AgentPipelineStore({
    async query(sql) {
      if (sql.includes('SELECT 1 FROM control.agent_analysis_pipelines')) {
        return { rows: [] }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    },
  })

  await assert.rejects(
    () => store.listAssertions('missing', 20),
    (error) => error?.status === 404 && error?.code === 'agent_pipeline_not_found',
  )
  await assert.rejects(
    () => store.listAssertions('missing', 'abc'),
    (error) => error?.status === 400 && error?.code === 'invalid_limit',
  )
  await assert.rejects(
    () => store.listAssertions('missing', 101),
    (error) => error?.status === 400 && error?.code === 'invalid_limit',
  )
})
