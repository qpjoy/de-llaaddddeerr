import { randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'

export const PROVINCE_GEOGRAPHY_PIPELINE_KEY = 'province-geography-v1'

const UPDATE_FIELDS = new Set(['expectedRevision', 'status', 'itemsPerMinute'])

function safeErrorCode(error) {
  for (const value of [error?.code, error?.name]) {
    if (typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value)) return value
  }
  return 'agent_analysis_failed'
}

function pipelineRow(row) {
  return {
    pipelineKey: row.pipeline_key,
    displayName: row.display_name,
    taskType: row.task_type,
    status: row.status,
    revision: Number(row.revision),
    analysisVersion: row.analysis_version,
    taxonomyVersion: row.taxonomy_version,
    ruleVersion: row.rule_version,
    promptVersion: row.prompt_version,
    itemsPerMinute: Number(row.items_per_minute),
    maxInFlight: Number(row.max_in_flight),
    nextDispatchAt: row.next_dispatch_at instanceof Date
      ? row.next_dispatch_at.toISOString()
      : row.next_dispatch_at ?? null,
    updatedBy: row.updated_by ?? null,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at ?? null,
    tasks: {
      pending: Number(row.pending_count || 0),
      running: Number(row.running_count || 0),
      succeeded: Number(row.succeeded_count || 0),
      dead: Number(row.dead_count || 0),
      superseded: Number(row.superseded_count || 0),
      total: Number(row.task_count || 0),
      oldestPendingAt: row.oldest_pending_at instanceof Date
        ? row.oldest_pending_at.toISOString()
        : row.oldest_pending_at ?? null,
      lastCompletedAt: row.last_completed_at instanceof Date
        ? row.last_completed_at.toISOString()
        : row.last_completed_at ?? null,
    },
    assertions: {
      proposed: Number(row.proposed_count || 0),
      accepted: Number(row.accepted_count || 0),
      rejected: Number(row.rejected_count || 0),
      superseded: Number(row.assertion_superseded_count || 0),
      total: Number(row.assertion_count || 0),
    },
  }
}

function assertionRow(row) {
  return {
    assertionId: row.assertion_id,
    taskId: Number(row.task_id),
    pipelineKey: row.pipeline_key,
    recordId: row.record_id,
    sourceObjectRevisionId: Number(row.source_object_revision_id),
    canonicalRevision: Number(row.canonical_revision),
    fieldKey: row.field_key,
    proposedValue: row.proposed_value,
    method: row.method,
    confidence: Number(row.confidence),
    evidenceRefs: row.evidence_refs || [],
    taxonomyVersion: row.taxonomy_version,
    ruleVersion: row.rule_version ?? null,
    providerId: row.provider_id ?? null,
    model: row.model ?? null,
    promptVersion: row.prompt_version ?? null,
    status: row.status,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  }
}

const PIPELINE_STATUS_SQL = `
  SELECT pipeline.*,
         coalesce(tasks.pending_count, 0)::bigint AS pending_count,
         coalesce(tasks.running_count, 0)::bigint AS running_count,
         coalesce(tasks.succeeded_count, 0)::bigint AS succeeded_count,
         coalesce(tasks.dead_count, 0)::bigint AS dead_count,
         coalesce(tasks.superseded_count, 0)::bigint AS superseded_count,
         coalesce(tasks.task_count, 0)::bigint AS task_count,
         tasks.oldest_pending_at,
         tasks.last_completed_at,
         coalesce(assertions.proposed_count, 0)::bigint AS proposed_count,
         coalesce(assertions.accepted_count, 0)::bigint AS accepted_count,
         coalesce(assertions.rejected_count, 0)::bigint AS rejected_count,
         coalesce(assertions.superseded_count, 0)::bigint AS assertion_superseded_count,
         coalesce(assertions.assertion_count, 0)::bigint AS assertion_count
    FROM control.agent_analysis_pipelines pipeline
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE status = 'pending') AS pending_count,
             count(*) FILTER (WHERE status = 'running') AS running_count,
             count(*) FILTER (WHERE status = 'succeeded') AS succeeded_count,
             count(*) FILTER (WHERE status = 'dead') AS dead_count,
             count(*) FILTER (WHERE status = 'superseded') AS superseded_count,
             count(*) AS task_count,
             min(created_at) FILTER (WHERE status = 'pending') AS oldest_pending_at,
             max(finished_at) FILTER (WHERE status = 'succeeded') AS last_completed_at
        FROM agent_center.analysis_tasks task
       WHERE task.pipeline_key = pipeline.pipeline_key
    ) tasks ON true
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE status = 'proposed') AS proposed_count,
             count(*) FILTER (WHERE status = 'accepted') AS accepted_count,
             count(*) FILTER (WHERE status = 'rejected') AS rejected_count,
             count(*) FILTER (WHERE status = 'superseded') AS superseded_count,
             count(*) AS assertion_count
        FROM agent_center.classification_assertions assertion
       WHERE assertion.pipeline_key = pipeline.pipeline_key
    ) assertions ON true`

export class AgentPipelineStore {
  constructor(pool) {
    this.pool = pool
  }

  async listPipelines() {
    const { rows } = await this.pool.query(`${PIPELINE_STATUS_SQL} ORDER BY pipeline.pipeline_key`)
    return rows.map(pipelineRow)
  }

  async getPipeline(pipelineKey) {
    const { rows } = await this.pool.query(
      `${PIPELINE_STATUS_SQL} WHERE pipeline.pipeline_key = $1`,
      [pipelineKey],
    )
    if (!rows[0]) throw new AppError(404, 'agent_pipeline_not_found', 'Agent pipeline was not found')
    return pipelineRow(rows[0])
  }

  async listAssertions(pipelineKey, limit = 20) {
    const bounded = Number(limit)
    if (!Number.isInteger(bounded) || bounded < 1 || bounded > 100) {
      throw new AppError(400, 'invalid_limit', 'limit must be an integer between 1 and 100')
    }
    const pipeline = await this.pool.query(
      'SELECT 1 FROM control.agent_analysis_pipelines WHERE pipeline_key = $1',
      [pipelineKey],
    )
    if (!pipeline.rows[0]) {
      throw new AppError(404, 'agent_pipeline_not_found', 'Agent pipeline was not found')
    }
    const { rows } = await this.pool.query(
      `SELECT assertion_id, task_id, pipeline_key, record_id,
              source_object_revision_id, canonical_revision, field_key,
              proposed_value, method, confidence, evidence_refs,
              taxonomy_version, rule_version, provider_id, model,
              prompt_version, status, created_at
         FROM agent_center.classification_assertions
        WHERE pipeline_key = $1
        ORDER BY created_at DESC, assertion_id DESC
        LIMIT $2`,
      [pipelineKey, bounded],
    )
    return rows.map(assertionRow)
  }

  async updatePipeline(pipelineKey, input, { updatedBy = 'admin-token' } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new AppError(400, 'invalid_agent_pipeline', 'request body must be an object')
    }
    for (const field of Object.keys(input)) {
      if (!UPDATE_FIELDS.has(field)) {
        throw new AppError(400, 'invalid_agent_pipeline', `unsupported pipeline field ${field}`)
      }
    }
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new AppError(400, 'invalid_agent_pipeline', 'expectedRevision must be a non-negative integer')
    }
    if (input.status == null && input.itemsPerMinute == null) {
      throw new AppError(400, 'invalid_agent_pipeline', 'status or itemsPerMinute is required')
    }
    if (input.status != null && !['active', 'paused'].includes(input.status)) {
      throw new AppError(400, 'invalid_agent_pipeline', 'status must be active or paused')
    }
    if (input.itemsPerMinute != null && (
      !Number.isInteger(input.itemsPerMinute)
      || input.itemsPerMinute < 1
      || input.itemsPerMinute > 60
    )) {
      throw new AppError(400, 'invalid_agent_pipeline', 'itemsPerMinute must be an integer between 1 and 60')
    }

    const { rows } = await this.pool.query(
      `UPDATE control.agent_analysis_pipelines
          SET status = coalesce($3, status),
              items_per_minute = coalesce($4, items_per_minute),
              revision = revision + 1,
              updated_by = $5,
              updated_at = now(),
              next_dispatch_at = CASE
                WHEN $3 = 'active' AND status = 'paused' THEN now()
                ELSE next_dispatch_at
              END
        WHERE pipeline_key = $1 AND revision = $2
        RETURNING pipeline_key`,
      [pipelineKey, input.expectedRevision, input.status ?? null, input.itemsPerMinute ?? null, updatedBy],
    )
    if (!rows[0]) {
      const current = await this.pool.query(
        'SELECT revision FROM control.agent_analysis_pipelines WHERE pipeline_key = $1',
        [pipelineKey],
      )
      if (!current.rows[0]) throw new AppError(404, 'agent_pipeline_not_found', 'Agent pipeline was not found')
      throw new AppError(409, 'agent_pipeline_revision_conflict', 'Agent pipeline changed; reload and retry', {
        currentRevision: Number(current.rows[0].revision),
      })
    }
    return this.getPipeline(pipelineKey)
  }

  async materializeCurrent(pipelineKey) {
    if (pipelineKey !== PROVINCE_GEOGRAPHY_PIPELINE_KEY) {
      throw new AppError(404, 'agent_pipeline_not_found', 'Agent pipeline was not found')
    }
    const { rowCount } = await this.pool.query(
      `INSERT INTO agent_center.analysis_tasks
         (pipeline_key, record_id, source_object_revision_id, canonical_revision,
          input_sha256, analysis_version, taxonomy_version, rule_version, prompt_version)
       SELECT pipeline.pipeline_key, record.id, source_revision.id,
              record.current_revision, source_revision.payload_sha256,
              pipeline.analysis_version, pipeline.taxonomy_version,
              pipeline.rule_version, pipeline.prompt_version
         FROM control.agent_analysis_pipelines pipeline
         JOIN core.canonical_records record
           ON record.dataset_id = 'public-opinion.province.v1'
         JOIN ingest.source_objects source_object
           ON source_object.connector_id = 'external:province-opinion-results'
          AND source_object.object_type = record.object_type
          AND source_object.source_key = record.external_id
         JOIN ingest.source_object_revisions source_revision
           ON source_revision.source_object_id = source_object.id
          AND source_revision.revision = source_object.current_revision
        WHERE pipeline.pipeline_key = $1
       ON CONFLICT (
         pipeline_key, record_id, source_object_revision_id,
         canonical_revision, analysis_version
       )
       DO NOTHING`,
      [pipelineKey],
    )
    return { pipelineKey, enqueued: rowCount, pipeline: await this.getPipeline(pipelineKey) }
  }

  async retryDead(pipelineKey) {
    const { rowCount } = await this.pool.query(
      `UPDATE agent_center.analysis_tasks
          SET status = 'pending', attempts = 0, next_attempt_at = now(),
              locked_by = NULL, leased_until = NULL, last_error_code = NULL,
              finished_at = NULL, updated_at = now()
        WHERE pipeline_key = $1 AND status = 'dead'`,
      [pipelineKey],
    )
    return { pipelineKey, retried: rowCount, pipeline: await this.getPipeline(pipelineKey) }
  }

  async reclaimExpired() {
    const { rowCount } = await this.pool.query(
      `UPDATE agent_center.analysis_tasks
          SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
              next_attempt_at = CASE
                WHEN attempts >= max_attempts THEN next_attempt_at
                ELSE now() + make_interval(secs => least(power(2, attempts)::integer * 5, 3600))
              END,
              locked_by = NULL, leased_until = NULL,
              last_error_code = 'claim_lease_expired',
              finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
              updated_at = now()
        WHERE status = 'running' AND leased_until < now()`,
    )
    return rowCount
  }

  async claimNext({ workerId, leaseSeconds = 300 } = {}) {
    if (!workerId) throw new Error('workerId is required')
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // Collapse obsolete backlog without spending model calls. Raw revisions
      // remain immutable evidence and the newest revision retains its own task.
      await client.query(
        `UPDATE agent_center.analysis_tasks task
            SET status = 'superseded', finished_at = now(), updated_at = now(),
                last_error_code = 'newer_source_revision'
           FROM ingest.source_object_revisions source_revision,
                ingest.source_objects source_object,
                core.canonical_records record
          WHERE task.status = 'pending'
            AND source_revision.id = task.source_object_revision_id
            AND source_object.id = source_revision.source_object_id
            AND record.id = task.record_id
            AND (source_object.current_revision <> source_revision.revision
                 OR record.current_revision <> task.canonical_revision)`,
      )
      const pipelineResult = await client.query(
        `SELECT *
           FROM control.agent_analysis_pipelines pipeline
          WHERE status = 'active'
            AND next_dispatch_at <= now()
            AND EXISTS (
              SELECT 1 FROM agent_center.analysis_tasks task
               WHERE task.pipeline_key = pipeline.pipeline_key
                 AND task.status = 'pending'
                 AND task.next_attempt_at <= now()
            )
          ORDER BY next_dispatch_at, pipeline_key
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
      )
      const pipeline = pipelineResult.rows[0]
      if (!pipeline) {
        await client.query('COMMIT')
        return null
      }
      const inFlight = await client.query(
        `SELECT count(*)::int AS count
           FROM agent_center.analysis_tasks
          WHERE pipeline_key = $1 AND status = 'running'`,
        [pipeline.pipeline_key],
      )
      if (Number(inFlight.rows[0]?.count || 0) >= Number(pipeline.max_in_flight)) {
        await client.query('COMMIT')
        return null
      }
      const claimed = await client.query(
        `UPDATE agent_center.analysis_tasks task
            SET status = 'running', attempts = attempts + 1,
                claim_generation = claim_generation + 1,
                locked_by = $2,
                leased_until = now() + make_interval(secs => $3),
                started_at = coalesce(started_at, now()),
                updated_at = now(), last_error_code = NULL
          WHERE task.id = (
            SELECT id FROM agent_center.analysis_tasks
             WHERE pipeline_key = $1 AND status = 'pending'
               AND next_attempt_at <= now()
             ORDER BY next_attempt_at, created_at, id
             FOR UPDATE SKIP LOCKED
             LIMIT 1
          )
        RETURNING task.*`,
        [pipeline.pipeline_key, workerId, leaseSeconds],
      )
      const task = claimed.rows[0]
      if (!task) {
        await client.query('COMMIT')
        return null
      }
      await client.query(
        `UPDATE control.agent_analysis_pipelines
            SET next_dispatch_at = now()
              + make_interval(secs => 60.0 / items_per_minute)
          WHERE pipeline_key = $1`,
        [pipeline.pipeline_key],
      )
      const inputResult = await client.query(
        `SELECT record.title, record.body, record.author_name,
                record.admin1_code, record.content_type, record.platform,
                record.stable_fields, record.extensions, record.deleted_at,
                record.current_revision,
                source_revision.raw_payload,
                source_revision.payload_sha256 AS source_payload_sha256,
                source_revision.revision AS source_revision_number,
                source_object.current_revision AS current_source_revision
           FROM core.canonical_records record
           JOIN ingest.source_object_revisions source_revision ON source_revision.id = $2
           JOIN ingest.source_objects source_object ON source_object.id = source_revision.source_object_id
          WHERE record.id = $1`,
        [task.record_id, task.source_object_revision_id],
      )
      await client.query('COMMIT')
      return {
        taskId: Number(task.id),
        pipelineKey: task.pipeline_key,
        recordId: task.record_id,
        sourceObjectRevisionId: Number(task.source_object_revision_id),
        canonicalRevision: Number(task.canonical_revision),
        inputSha256: task.input_sha256,
        analysisVersion: task.analysis_version,
        taxonomyVersion: task.taxonomy_version,
        ruleVersion: task.rule_version,
        promptVersion: task.prompt_version,
        attempts: Number(task.attempts),
        maxAttempts: Number(task.max_attempts),
        generation: Number(task.claim_generation),
        workerId,
        input: inputResult.rows[0] || null,
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async heartbeat(claim, leaseSeconds = 300) {
    const { rowCount } = await this.pool.query(
      `UPDATE agent_center.analysis_tasks
          SET leased_until = now() + make_interval(secs => $4), updated_at = now()
        WHERE id = $1 AND status = 'running'
          AND locked_by = $2 AND claim_generation = $3`,
      [claim.taskId, claim.workerId, claim.generation, leaseSeconds],
    )
    return rowCount === 1
  }

  async releaseClaim(claim) {
    const { rowCount } = await this.pool.query(
      `UPDATE agent_center.analysis_tasks
          SET status = 'pending',
              attempts = GREATEST(attempts - 1, 0),
              next_attempt_at = now(),
              last_error_code = NULL,
              locked_by = NULL, leased_until = NULL,
              finished_at = NULL, updated_at = now()
        WHERE id = $1 AND status = 'running'
          AND locked_by = $2 AND claim_generation = $3`,
      [claim.taskId, claim.workerId, claim.generation],
    )
    return { released: rowCount === 1 }
  }

  async completeClaim(claim, result) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const current = await client.query(
        `SELECT task.*, source_revision.revision AS source_revision_number,
                source_object.current_revision AS current_source_revision,
                record.current_revision AS current_canonical_revision
           FROM agent_center.analysis_tasks task
           JOIN ingest.source_object_revisions source_revision
             ON source_revision.id = task.source_object_revision_id
           JOIN ingest.source_objects source_object
             ON source_object.id = source_revision.source_object_id
           JOIN core.canonical_records record ON record.id = task.record_id
          WHERE task.id = $1
          FOR UPDATE`,
        [claim.taskId],
      )
      const task = current.rows[0]
      const ownsClaim = task?.status === 'running'
        && task.locked_by === claim.workerId
        && Number(task.claim_generation) === claim.generation
      if (!ownsClaim) {
        await client.query('COMMIT')
        return { completed: false, staleClaim: true }
      }
      const staleInput = Number(task.source_revision_number) !== Number(task.current_source_revision)
        || Number(task.canonical_revision) !== Number(task.current_canonical_revision)
      if (staleInput) {
        await client.query(
          `UPDATE agent_center.analysis_tasks
              SET status = 'superseded', finished_at = now(), updated_at = now(),
                  locked_by = NULL, leased_until = NULL,
                  last_error_code = 'newer_source_revision'
            WHERE id = $1 AND locked_by = $2 AND claim_generation = $3`,
          [claim.taskId, claim.workerId, claim.generation],
        )
        await client.query('COMMIT')
        return { completed: false, superseded: true }
      }

      for (const assertion of result.assertions || []) {
        await client.query(
          `INSERT INTO agent_center.classification_assertions
             (assertion_id, task_id, pipeline_key, record_id,
              source_object_revision_id, canonical_revision, input_sha256,
              field_key, proposed_value, method, confidence, evidence_refs,
              taxonomy_version, rule_version, provider_id, model,
              prompt_version, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                   $13, $14, $15, $16, $17, $18)
           ON CONFLICT (task_id, field_key, method) DO NOTHING`,
          [
            randomUUID(), claim.taskId, claim.pipelineKey, claim.recordId,
            claim.sourceObjectRevisionId, claim.canonicalRevision, claim.inputSha256,
            // node-postgres serializes objects as JSON, but JavaScript strings
            // are sent as bare text and arrays use PostgreSQL-array syntax.
            // Serialize both jsonb values explicitly; this also preserves a
            // JSON null as `null` instead of turning it into a SQL NULL.
            assertion.fieldKey, JSON.stringify(assertion.value), assertion.method,
            assertion.confidence, JSON.stringify(assertion.evidenceRefs || []),
            claim.taxonomyVersion, assertion.ruleVersion ?? claim.ruleVersion,
            assertion.providerId ?? result.providerId ?? null,
            assertion.model ?? result.model ?? null,
            assertion.promptVersion ?? (assertion.method === 'agent' ? claim.promptVersion : null),
            assertion.status || 'proposed',
          ],
        )
      }
      const completed = await client.query(
        `UPDATE agent_center.analysis_tasks
            SET status = 'succeeded', provider_id = $4, model = $5,
                result_summary = $6, last_error_code = NULL,
                locked_by = NULL, leased_until = NULL,
                finished_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'running'
            AND locked_by = $2 AND claim_generation = $3`,
        [
          claim.taskId, claim.workerId, claim.generation,
          result.providerId ?? null, result.model ?? null,
          result.summary || {},
        ],
      )
      await client.query('COMMIT')
      return { completed: completed.rowCount === 1 }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async failClaim(claim, error) {
    const exhausted = claim.attempts >= claim.maxAttempts
    const backoffSeconds = Math.min(2 ** claim.attempts * 5, 3_600)
    const { rowCount } = await this.pool.query(
      `UPDATE agent_center.analysis_tasks
          SET status = $4,
              next_attempt_at = CASE
                WHEN $4 = 'pending' THEN now() + make_interval(secs => $5)
                ELSE next_attempt_at
              END,
              last_error_code = $6,
              locked_by = NULL, leased_until = NULL,
              finished_at = CASE WHEN $4 = 'dead' THEN now() ELSE NULL END,
              updated_at = now()
        WHERE id = $1 AND status = 'running'
          AND locked_by = $2 AND claim_generation = $3`,
      [
        claim.taskId, claim.workerId, claim.generation,
        exhausted ? 'dead' : 'pending', backoffSeconds, safeErrorCode(error),
      ],
    )
    return { failed: rowCount === 1, dead: exhausted, errorCode: safeErrorCode(error) }
  }
}

export { pipelineRow, assertionRow, safeErrorCode }
