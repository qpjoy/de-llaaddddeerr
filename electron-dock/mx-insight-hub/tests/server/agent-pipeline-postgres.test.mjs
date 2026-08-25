import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { AgentPipelineStore } from '../../server/agent/pipeline-store.mjs'

const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL || ''

function scopedSql(sql, schema) {
  return sql.replaceAll(
    /\b(?:agent_center|core|ingest|outbox)\./gu,
    `"${schema}".`,
  )
}

function scopedStore(pool, schema) {
  return new AgentPipelineStore({
    async connect() {
      const client = await pool.connect()
      return {
        query(sql, parameters = []) {
          return client.query(scopedSql(sql, schema), parameters)
        },
        release() {
          client.release()
        },
      }
    },
    query(sql, parameters = []) {
      return pool.query(scopedSql(sql, schema), parameters)
    },
  })
}

async function createFixture(pool, schema) {
  await pool.query(`CREATE SCHEMA "${schema}"`)
  await pool.query(`
    CREATE TABLE "${schema}".source_objects (
      id uuid PRIMARY KEY,
      current_revision integer NOT NULL
    );
    CREATE TABLE "${schema}".source_object_revisions (
      id bigint PRIMARY KEY,
      source_object_id uuid NOT NULL,
      revision integer NOT NULL
    );
    CREATE TABLE "${schema}".canonical_records (
      id uuid PRIMARY KEY,
      current_revision integer NOT NULL,
      dataset_id text NOT NULL,
      platform text NOT NULL,
      object_type text NOT NULL,
      projection_revision bigint NOT NULL DEFAULT 1
    );
    CREATE TABLE "${schema}".analysis_tasks (
      id bigint PRIMARY KEY,
      pipeline_key text NOT NULL,
      record_id uuid NOT NULL,
      source_object_revision_id bigint NOT NULL,
      canonical_revision integer NOT NULL,
      input_sha256 text NOT NULL,
      analysis_version text NOT NULL,
      taxonomy_version text NOT NULL,
      rule_version text NOT NULL,
      prompt_version text NOT NULL,
      status text NOT NULL,
      attempts integer NOT NULL,
      max_attempts integer NOT NULL,
      claim_generation bigint NOT NULL,
      locked_by text,
      leased_until timestamptz,
      provider_id text,
      model text,
      last_error_code text,
      result_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
      finished_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE "${schema}".public_opinion_current_state (
      record_id uuid PRIMARY KEY,
      canonical_revision integer NOT NULL,
      source_object_revision_id bigint,
      source_stage text NOT NULL,
      status text NOT NULL,
      quality_score smallint,
      qualification_threshold smallint NOT NULL DEFAULT 80,
      quality_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
      rejection_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
      event_admin1_code text,
      publisher_admin1_code text,
      display_admin1_code text,
      geography_verified boolean NOT NULL DEFAULT false,
      geo_scope text NOT NULL DEFAULT 'unknown',
      location_label text,
      location_type text NOT NULL DEFAULT 'unknown',
      country_name text,
      country_code text,
      analysis_version text,
      taxonomy_version text,
      rule_version text,
      prompt_version text,
      materialized_from_task_id bigint,
      assessed_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE "${schema}".projection_events (
      aggregate_type text NOT NULL,
      aggregate_id uuid NOT NULL,
      event_type text NOT NULL,
      projection_revision bigint NOT NULL,
      payload jsonb NOT NULL,
      UNIQUE (aggregate_id, projection_revision)
    );
  `)
}

async function insertTask(pool, schema, {
  taskId,
  recordId,
  sourceObjectId,
  sourceRevisionId,
  publication,
}) {
  await pool.query(
    `INSERT INTO "${schema}".source_objects (id, current_revision)
     VALUES ($1, 1)`,
    [sourceObjectId],
  )
  await pool.query(
    `INSERT INTO "${schema}".source_object_revisions
       (id, source_object_id, revision)
     VALUES ($1, $2, 1)`,
    [sourceRevisionId, sourceObjectId],
  )
  await pool.query(
    `INSERT INTO "${schema}".canonical_records
       (id, current_revision, dataset_id, platform, object_type)
     VALUES ($1, 1, 'public-opinion.province.v1', 'public_opinion', 'opinion_item')`,
    [recordId],
  )
  await pool.query(
    `INSERT INTO "${schema}".analysis_tasks
       (id, pipeline_key, record_id, source_object_revision_id,
        canonical_revision, input_sha256, analysis_version, taxonomy_version,
        rule_version, prompt_version, status, attempts, max_attempts,
        claim_generation, locked_by)
     VALUES ($1, 'province-geography-v1', $2, $3, 1, $4,
             'province-geography.v1', 'cn-geography.v1',
             'province-evidence.2026-08', 'province-analysis.v1',
             'running', 5, 5, 1, 'worker-1')`,
    [taskId, recordId, sourceRevisionId, 'a'.repeat(64)],
  )
  if (publication) {
    await pool.query(
      `INSERT INTO "${schema}".public_opinion_current_state
         (record_id, canonical_revision, source_object_revision_id,
          source_stage, status)
       VALUES ($1, 1, $2, 'candidate', 'pending')`,
      [recordId, sourceRevisionId],
    )
  }
}

function claim({ taskId, recordId, sourceRevisionId }) {
  return {
    taskId,
    pipelineKey: 'province-geography-v1',
    recordId,
    sourceObjectRevisionId: sourceRevisionId,
    canonicalRevision: 1,
    inputSha256: 'a'.repeat(64),
    analysisVersion: 'province-geography.v1',
    taxonomyVersion: 'cn-geography.v1',
    ruleVersion: 'province-evidence.2026-08',
    promptVersion: 'province-analysis.v1',
    attempts: 5,
    maxAttempts: 5,
    generation: 1,
    workerId: 'worker-1',
  }
}

test('claim completion and exhaustion lock only non-nullable joined rows in PostgreSQL', {
  skip: connectionString ? false : 'MX_INSIGHT_TEST_DATABASE_URL is not configured',
}, async () => {
  const schema = `mxhub_agent_lock_${randomUUID().replaceAll('-', '')}`
  const pool = new pg.Pool({ connectionString, statement_timeout: 5_000 })
  const store = scopedStore(pool, schema)
  const cases = [
    { taskId: 1, recordId: randomUUID(), sourceObjectId: randomUUID(), sourceRevisionId: 11, publication: true },
    { taskId: 2, recordId: randomUUID(), sourceObjectId: randomUUID(), sourceRevisionId: 12, publication: false },
    { taskId: 3, recordId: randomUUID(), sourceObjectId: randomUUID(), sourceRevisionId: 13, publication: true },
  ]

  try {
    await createFixture(pool, schema)
    for (const fixture of cases) await insertTask(pool, schema, fixture)

    assert.deepEqual(
      await store.completeClaim(claim(cases[0]), { assertions: [], summary: {} }),
      { completed: true },
    )
    assert.deepEqual(
      await store.completeClaim(claim(cases[1]), { assertions: [], summary: {} }),
      { completed: true },
    )
    assert.deepEqual(
      await store.failClaim(claim(cases[2]), { code: 'agent_invalid_response' }),
      { failed: true, dead: true, errorCode: 'agent_invalid_response' },
    )

    const { rows: tasks } = await pool.query(
      `SELECT id, status, last_error_code
         FROM "${schema}".analysis_tasks
        ORDER BY id`,
    )
    assert.deepEqual(tasks, [
      { id: '1', status: 'succeeded', last_error_code: null },
      { id: '2', status: 'succeeded', last_error_code: null },
      { id: '3', status: 'dead', last_error_code: 'agent_invalid_response' },
    ])
    const { rows: publications } = await pool.query(
      `SELECT record_id, status, rejection_codes, materialized_from_task_id
         FROM "${schema}".public_opinion_current_state
        ORDER BY materialized_from_task_id`,
    )
    assert.deepEqual(publications.map((row) => ({
      status: row.status,
      rejectionCodes: row.rejection_codes,
      taskId: row.materialized_from_task_id,
    })), [
      { status: 'failed', rejectionCodes: [], taskId: '1' },
      { status: 'failed', rejectionCodes: ['agent_invalid_response'], taskId: '3' },
    ])
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
    await pool.end()
  }
})
