import { randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'

// Durable state for self-hosted engines (migration 165). Every state change
// that decides whether an engine may dispatch happens in one short transaction
// holding the engine row; network calls never run inside a transaction.

const EXPIRED = { code: 'queue_deadline_exceeded', message: '排队超过最长等待时间，未派发，不收费' }
const RESTARTED = { code: 'executor_restarted', message: '执行进程重启时该任务仍在运行，结果未知' }
const ENGINE_RETRY_MS = 10 * 60 * 1000
const iso = value => value == null ? null : new Date(value).toISOString()

function jobRow(row) {
  if (!row) return null
  return {
    id: row.id, engineId: row.engine_id, batchId: row.batch_id, itemIndex: row.item_index, clientRef: row.client_ref,
    tenantId: row.tenant_id, consumerId: row.consumer_id, apiKeyId: row.api_key_id, idempotencyKey: row.idempotency_key,
    fingerprint: row.fingerprint, input: row.input, status: row.status, sourceMode: row.source_mode, billing: row.billing,
    usageRequestId: row.usage_request_id, owner: row.owner, engineRevision: row.engine_revision, baseUrl: row.base_url,
    queuedAt: iso(row.queued_at), deadlineAt: iso(row.deadline_at), dispatchedAt: iso(row.dispatched_at),
    finishedAt: iso(row.finished_at), durationMs: row.duration_ms, httpStatus: row.http_status,
    result: row.result, error: row.error, lateEvidence: row.late_evidence,
  }
}

function engineRow(row) {
  if (!row) return null
  return {
    id: row.id, baseUrl: row.base_url, enabled: row.enabled, billingEnabled: row.billing_enabled === true,
    revision: row.revision, activeJobId: row.active_job_id,
    quarantineReason: row.quarantine_reason, quarantinedAt: iso(row.quarantined_at), cooldownUntil: iso(row.cooldown_until),
    updatedBy: row.updated_by, updateReason: row.update_reason, updatedAt: iso(row.updated_at),
  }
}

const batchRow = row => row && ({ id: row.id, engineId: row.engine_id, consumerId: row.consumer_id,
  idempotencyKey: row.idempotency_key, fingerprint: row.fingerprint, itemCount: row.item_count, createdAt: iso(row.created_at) })

const conflict = () => new AppError(409, 'idempotency_conflict', 'Idempotency-Key was used with a different request')

function assertAccepting(engine) {
  if (!engine) throw new AppError(503, 'engine_unavailable', '自建引擎未配置', { retryAfterMs: ENGINE_RETRY_MS })
  if (!engine.enabled) throw new AppError(503, 'engine_disabled', '自建引擎已停用，暂不接收新任务', { retryAfterMs: ENGINE_RETRY_MS })
  if (engine.quarantineReason) {
    throw new AppError(503, 'engine_attention_required', '自建引擎等待人工核实，暂不接收新任务', { retryAfterMs: ENGINE_RETRY_MS })
  }
}

function assertCapacity({ queued, mine }, count, limits) {
  if (queued + count > limits.globalQueued) {
    throw new AppError(429, 'engine_queue_full', `自建引擎排队已满（最多 ${limits.globalQueued} 条），请稍后再提交`,
      { queued, limit: limits.globalQueued, retryAfterMs: 60_000 })
  }
  if (mine + count > limits.consumerOpen) {
    throw new AppError(429, 'consumer_queue_full', `当前调用方未完成的任务已达上限（${limits.consumerOpen} 条）`,
      { open: mine, limit: limits.consumerOpen, retryAfterMs: 60_000 })
  }
}

function assertRevision(engine, expectedRevision) {
  if (!Number.isInteger(expectedRevision) || expectedRevision !== engine.revision) {
    throw new AppError(409, 'engine_revision_conflict', '配置已被其他人修改，请刷新后再操作', { revision: engine.revision })
  }
}

export class PostgresSelfHostedStore {
  constructor(pool) { this.pool = pool }

  async #tx(run) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL lock_timeout = '5s'")
      await client.query("SET LOCAL statement_timeout = '15s'")
      const value = await run(client)
      await client.query('COMMIT')
      return value
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async #event(client, engineId, action, { jobId = null, actor, reason, details = {} }) {
    await client.query(`INSERT INTO self_hosted.engine_events (engine_id, action, revision, job_id, actor, reason, details)
      SELECT id, $2, revision, $3, $4, $5, $6::jsonb FROM self_hosted.engines WHERE id = $1`,
    [engineId, action, jobId, actor, reason, JSON.stringify(details)])
  }

  async engine(engineId) {
    const { rows } = await this.pool.query('SELECT * FROM self_hosted.engines WHERE id = $1', [engineId])
    return engineRow(rows[0])
  }

  // Lock-free idle check for the executor poll: one indexed read, no row lock
  // or WAL, so an idle engine costs nothing on the shared database.
  async readiness(engineId) {
    const { rows: [row] } = await this.pool.query(`SELECT
        engine.enabled AND engine.active_job_id IS NULL AND engine.quarantine_reason IS NULL
          AND (engine.cooldown_until IS NULL OR engine.cooldown_until <= clock_timestamp()) AS ready,
        EXISTS (SELECT 1 FROM self_hosted.jobs job WHERE job.engine_id = engine.id AND job.status = 'queued') AS queued,
        EXISTS (SELECT 1 FROM self_hosted.jobs job WHERE job.engine_id = engine.id AND job.status = 'queued'
          AND job.deadline_at <= clock_timestamp()) AS overdue
      FROM self_hosted.engines engine WHERE engine.id = $1`, [engineId])
    return { claimable: Boolean(row && ((row.ready && row.queued) || row.overdue)) }
  }

  async submit({ engineId, owner, kind, idempotencyKey, fingerprint, items, limits }) {
    return this.#tx(async client => {
      // Exact global and per-caller counts need submissions serialized.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`self_hosted:submit:${engineId}`])
      if (kind === 'batch') {
        const { rows: [batch] } = await client.query('SELECT * FROM self_hosted.batches WHERE consumer_id = $1 AND idempotency_key = $2',
          [owner.consumerId, idempotencyKey])
        if (batch) {
          if (batch.fingerprint !== fingerprint) throw conflict()
          const { rows } = await client.query('SELECT * FROM self_hosted.jobs WHERE batch_id = $1 ORDER BY item_index', [batch.id])
          return { replay: true, batch: batchRow(batch), jobs: rows.map(jobRow) }
        }
      } else {
        const { rows: [existing] } = await client.query(`SELECT * FROM self_hosted.jobs
          WHERE consumer_id = $1 AND idempotency_key = $2 AND batch_id IS NULL`, [owner.consumerId, idempotencyKey])
        if (existing) {
          if (existing.fingerprint !== fingerprint) throw conflict()
          return { replay: true, batch: null, jobs: [jobRow(existing)] }
        }
      }
      const { rows: [engine] } = await client.query('SELECT * FROM self_hosted.engines WHERE id = $1', [engineId])
      assertAccepting(engineRow(engine))
      const { rows: [counts] } = await client.query(`SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
          count(*) FILTER (WHERE consumer_id = $2)::int AS mine
        FROM self_hosted.jobs WHERE engine_id = $1 AND status IN ('queued', 'running')`, [engineId, owner.consumerId])
      assertCapacity(counts, items.length, limits)
      let batch = null
      if (kind === 'batch') {
        const { rows: [row] } = await client.query(`INSERT INTO self_hosted.batches
            (id, engine_id, tenant_id, consumer_id, api_key_id, idempotency_key, fingerprint, item_count)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [randomUUID(), engineId, owner.tenantId, owner.consumerId, owner.apiKeyId, idempotencyKey, fingerprint, items.length])
        batch = batchRow(row)
      }
      const jobs = []
      for (const [index, item] of items.entries()) {
        const { rows: [row] } = await client.query(`INSERT INTO self_hosted.jobs
            (id, engine_id, batch_id, item_index, client_ref, tenant_id, consumer_id, api_key_id, idempotency_key,
             fingerprint, input, status, deadline_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, 'queued', clock_timestamp() + ($12::int * interval '1 millisecond'))
          RETURNING *`,
        [randomUUID(), engineId, batch?.id || null, batch ? index : null, item.clientRef, owner.tenantId, owner.consumerId,
          owner.apiKeyId, batch ? null : idempotencyKey, item.fingerprint, JSON.stringify(item.input), limits.queueWaitMs])
        jobs.push(jobRow(row))
      }
      return { replay: false, batch, jobs }
    })
  }

  async claim({ engineId, owner }) {
    return this.#tx(async client => {
      const { rows: [engine] } = await client.query(`SELECT *, cooldown_until > clock_timestamp() AS cooling
        FROM self_hosted.engines WHERE id = $1 FOR UPDATE`, [engineId])
      if (!engine) return { job: null, expired: 0 }
      const expired = await client.query(`UPDATE self_hosted.jobs SET status = 'expired', finished_at = clock_timestamp(), error = $2::jsonb
        WHERE engine_id = $1 AND status = 'queued' AND deadline_at <= clock_timestamp() RETURNING id`, [engineId, JSON.stringify(EXPIRED)])
      if (!engine.enabled || engine.active_job_id || engine.quarantine_reason || engine.cooling) return { job: null, expired: expired.rowCount }
      const { rows: [next] } = await client.query(`SELECT id FROM self_hosted.jobs WHERE engine_id = $1 AND status = 'queued'
        ORDER BY queued_at, item_index, id LIMIT 1 FOR UPDATE SKIP LOCKED`, [engineId])
      if (!next) return { job: null, expired: expired.rowCount }
      const { rows: [running] } = await client.query(`UPDATE self_hosted.jobs SET status = 'running', owner = $2,
          dispatched_at = clock_timestamp(), engine_revision = $3, base_url = $4
        WHERE id = $1 RETURNING *`, [next.id, owner, engine.revision, engine.base_url])
      await client.query('UPDATE self_hosted.engines SET active_job_id = $2 WHERE id = $1', [engineId, next.id])
      return { job: jobRow(running), expired: expired.rowCount, billingEnabled: engine.billing_enabled === true }
    })
  }

  async markReserved({ jobId, owner, usageRequestId }) {
    const { rowCount } = await this.pool.query(`UPDATE self_hosted.jobs SET usage_request_id = $3, billing = 'reserved'
      WHERE id = $1 AND owner = $2 AND status = 'running'`, [jobId, owner, usageRequestId])
    return rowCount === 1
  }

  async finish({ engineId, jobId, owner, outcome, httpStatus = null, durationMs = null, billing }) {
    return this.#tx(async client => {
      await client.query('SELECT 1 FROM self_hosted.engines WHERE id = $1 FOR UPDATE', [engineId])
      const { rows: [row] } = await client.query(`UPDATE self_hosted.jobs SET status = $4, source_mode = $5, result = $6::jsonb,
          error = $7::jsonb, http_status = $8, duration_ms = $9, billing = $10, finished_at = clock_timestamp()
        WHERE id = $1 AND owner = $2 AND engine_id = $3 AND status = 'running' RETURNING *`,
      [jobId, owner, engineId, outcome.status, outcome.sourceMode || null, outcome.result ? JSON.stringify(outcome.result) : null,
        outcome.error ? JSON.stringify(outcome.error) : null, httpStatus, durationMs, billing])
      if (!row) {
        // A restarted executor already marked this run unknown. Keep the late
        // answer as evidence; never overwrite the recorded terminal state.
        await client.query('UPDATE self_hosted.jobs SET late_evidence = $2::jsonb WHERE id = $1', [jobId, JSON.stringify({
          at: new Date().toISOString(), owner, status: outcome.status, sourceMode: outcome.sourceMode || null,
          error: outcome.error || null, httpStatus, itemCount: outcome.result?.items?.length ?? null })])
        return { fenced: true, job: null }
      }
      if (outcome.quarantine) {
        await client.query(`UPDATE self_hosted.engines SET quarantine_reason = $2, quarantined_at = clock_timestamp()
          WHERE id = $1`, [engineId, outcome.quarantine])
        await this.#event(client, engineId, 'quarantined', { jobId, actor: 'executor', reason: outcome.error?.message || outcome.quarantine,
          details: { code: outcome.error?.code || outcome.quarantine } })
      } else {
        await client.query(`UPDATE self_hosted.engines SET active_job_id = NULL,
            cooldown_until = CASE WHEN $3::timestamptz IS NULL THEN cooldown_until
              ELSE GREATEST(COALESCE(cooldown_until, $3::timestamptz), $3::timestamptz) END
          WHERE id = $1 AND active_job_id = $2`, [engineId, jobId, outcome.cooldownUntil ? new Date(outcome.cooldownUntil) : null])
        if (outcome.cooldownUntil) {
          await this.#event(client, engineId, 'cooldown', { jobId, actor: 'executor', reason: '搜狗访问限制，引擎冷却',
            details: { until: new Date(outcome.cooldownUntil).toISOString() } })
        }
      }
      return { fenced: false, job: jobRow(row) }
    })
  }

  async setBilling(jobId, billing) {
    await this.pool.query('UPDATE self_hosted.jobs SET billing = $2 WHERE id = $1', [jobId, billing])
  }

  async orphanRunning({ engineId, owner }) {
    return this.#tx(async client => {
      await client.query('SELECT 1 FROM self_hosted.engines WHERE id = $1 FOR UPDATE', [engineId])
      const { rows } = await client.query(`UPDATE self_hosted.jobs SET status = 'unknown', finished_at = clock_timestamp(), error = $3::jsonb,
          billing = CASE WHEN billing = 'reserved' THEN 'pending_review' ELSE billing END
        WHERE engine_id = $1 AND status = 'running' AND owner IS DISTINCT FROM $2 RETURNING *`, [engineId, owner, JSON.stringify(RESTARTED)])
      if (rows[0]) {
        await client.query(`UPDATE self_hosted.engines SET active_job_id = $2, quarantine_reason = 'executor_restarted',
          quarantined_at = clock_timestamp() WHERE id = $1`, [engineId, rows[0].id])
        await this.#event(client, engineId, 'quarantined', { jobId: rows[0].id, actor: 'executor', reason: RESTARTED.message,
          details: { code: RESTARTED.code } })
      }
      return rows.map(jobRow)
    })
  }

  async updateEngine({ engineId, baseUrl, enabled, billingEnabled, expectedRevision, actor, reason }) {
    return this.#tx(async client => {
      const { rows: [current] } = await client.query('SELECT * FROM self_hosted.engines WHERE id = $1 FOR UPDATE', [engineId])
      if (!current) throw new AppError(404, 'engine_not_found', 'Engine not found')
      const before = engineRow(current)
      assertRevision(before, expectedRevision)
      if (baseUrl !== before.baseUrl && before.activeJobId) {
        throw new AppError(409, 'engine_busy', '引擎有任务正在执行或等待核实，此时不能更换地址')
      }
      const charging = billingEnabled ?? before.billingEnabled
      const { rows: [row] } = await client.query(`UPDATE self_hosted.engines SET base_url = $2, enabled = $3, billing_enabled = $4,
          revision = revision + 1, updated_by = $5, update_reason = $6, updated_at = clock_timestamp()
        WHERE id = $1 RETURNING *`, [engineId, baseUrl, enabled, charging, actor, reason])
      await this.#event(client, engineId, 'configured', { actor, reason, details: {
        before: { baseUrl: before.baseUrl, enabled: before.enabled, billingEnabled: before.billingEnabled },
        after: { baseUrl, enabled, billingEnabled: charging } } })
      return engineRow(row)
    })
  }

  async recoverEngine({ engineId, expectedRevision, actor, reason }) {
    return this.#tx(async client => {
      const { rows: [current] } = await client.query('SELECT * FROM self_hosted.engines WHERE id = $1 FOR UPDATE', [engineId])
      if (!current) throw new AppError(404, 'engine_not_found', 'Engine not found')
      const before = engineRow(current)
      assertRevision(before, expectedRevision)
      if (!before.quarantineReason) throw new AppError(409, 'engine_not_quarantined', '引擎当前不需要恢复')
      const { rows: [running] } = await client.query(`SELECT id FROM self_hosted.jobs WHERE engine_id = $1 AND status = 'running'`, [engineId])
      if (running) throw new AppError(409, 'engine_job_running', '仍有任务处于执行中，不能恢复')
      const { rows: [row] } = await client.query(`UPDATE self_hosted.engines SET active_job_id = NULL, quarantine_reason = NULL,
          quarantined_at = NULL, revision = revision + 1, updated_by = $2, update_reason = $3, updated_at = clock_timestamp()
        WHERE id = $1 RETURNING *`, [engineId, actor, reason])
      await this.#event(client, engineId, 'recovered', { jobId: before.activeJobId, actor, reason,
        details: { quarantineReason: before.quarantineReason } })
      return engineRow(row)
    })
  }

  async events(engineId, limit = 20) {
    const { rows } = await this.pool.query(`SELECT * FROM self_hosted.engine_events WHERE engine_id = $1
      ORDER BY created_at DESC, id DESC LIMIT $2`, [engineId, limit])
    return rows.map(row => ({ id: Number(row.id), action: row.action, revision: row.revision, jobId: row.job_id,
      actor: row.actor, reason: row.reason, details: row.details, createdAt: iso(row.created_at) }))
  }

  async queueSnapshot(engineId) {
    const [queued, running, median] = await Promise.all([
      this.pool.query(`SELECT id, consumer_id FROM self_hosted.jobs WHERE engine_id = $1 AND status = 'queued'
        ORDER BY queued_at, item_index, id`, [engineId]),
      this.pool.query(`SELECT id, dispatched_at FROM self_hosted.jobs WHERE engine_id = $1 AND status = 'running'`, [engineId]),
      this.pool.query(`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS median FROM (
          SELECT duration_ms FROM self_hosted.jobs WHERE engine_id = $1 AND status = 'succeeded' AND source_mode = 'live'
            AND duration_ms IS NOT NULL ORDER BY finished_at DESC LIMIT 20) recent`, [engineId]),
    ])
    return {
      queued: queued.rows.map(row => ({ id: row.id, consumerId: row.consumer_id })),
      runningSince: running.rows[0] ? new Date(running.rows[0].dispatched_at).getTime() : null,
      runningJobId: running.rows[0]?.id || null,
      medianMs: median.rows[0]?.median == null ? null : Math.round(Number(median.rows[0].median)),
    }
  }

  async get(jobId) {
    const { rows } = await this.pool.query('SELECT * FROM self_hosted.jobs WHERE id = $1', [jobId])
    return jobRow(rows[0])
  }

  async listForConsumer(consumerId, limit) {
    const { rows } = await this.pool.query(`SELECT * FROM self_hosted.jobs WHERE consumer_id = $1
      ORDER BY queued_at DESC, item_index, id LIMIT $2`, [consumerId, limit])
    return rows.map(jobRow)
  }

  async listRecent(engineId, limit) {
    const { rows } = await this.pool.query(`SELECT * FROM self_hosted.jobs WHERE engine_id = $1
      ORDER BY queued_at DESC, item_index, id LIMIT $2`, [engineId, limit])
    return rows.map(jobRow)
  }

  async batch(batchId) {
    const { rows: [batch] } = await this.pool.query('SELECT * FROM self_hosted.batches WHERE id = $1', [batchId])
    if (!batch) return null
    const { rows } = await this.pool.query('SELECT * FROM self_hosted.jobs WHERE batch_id = $1 ORDER BY item_index', [batchId])
    return { batch: batchRow(batch), jobs: rows.map(jobRow) }
  }

  async cancel({ jobId, consumerId }) {
    const { rows } = await this.pool.query(`UPDATE self_hosted.jobs SET status = 'cancelled', finished_at = clock_timestamp(),
        error = '{"code":"cancelled","message":"调用方已取消，未派发，不收费"}'::jsonb
      WHERE id = $1 AND consumer_id = $2 AND status = 'queued' RETURNING *`, [jobId, consumerId])
    return jobRow(rows[0])
  }

  // Terminal jobs older than the retention window. Unknown runs stay for review.
  async prune(engineId, retentionMs) {
    return this.#tx(async client => {
      const { rowCount } = await client.query(`DELETE FROM self_hosted.jobs WHERE engine_id = $1
        AND status IN ('succeeded', 'failed', 'cancelled', 'expired') AND billing <> 'pending_review'
        AND finished_at < clock_timestamp() - ($2::bigint * interval '1 millisecond')`, [engineId, retentionMs])
      await client.query(`DELETE FROM self_hosted.batches batch WHERE engine_id = $1
        AND NOT EXISTS (SELECT 1 FROM self_hosted.jobs job WHERE job.batch_id = batch.id)`, [engineId])
      return rowCount
    })
  }
}

// In-process implementation for the memory store mode and tests. Every method
// runs to completion without awaiting, which makes each call atomic.
export class MemorySelfHostedStore {
  constructor({ engines = [] } = {}) {
    this.engines = new Map(engines.map(engine => [engine.id, { revision: 0, enabled: true, billingEnabled: false, activeJobId: null, quarantineReason: null,
      quarantinedAt: null, cooldownUntil: null, updatedBy: 'memory', updateReason: 'default', updatedAt: new Date().toISOString(), ...engine }]))
    this.jobs = new Map()
    this.batches = new Map()
    this.engineEvents = []
  }

  #engine(engineId) { return this.engines.get(engineId) || null }
  #event(engineId, action, { jobId = null, actor, reason, details = {} }) {
    this.engineEvents.unshift({ id: this.engineEvents.length + 1, engineId, action, revision: this.#engine(engineId)?.revision ?? 0,
      jobId, actor, reason, details, createdAt: new Date().toISOString() })
  }
  #ordered(engineId, status) {
    return [...this.jobs.values()].filter(job => job.engineId === engineId && job.status === status)
      .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || (a.itemIndex ?? 0) - (b.itemIndex ?? 0) || a.id.localeCompare(b.id))
  }
  #copy(value) { return value == null ? value : structuredClone(value) }

  async engine(engineId) { return this.#copy(this.#engine(engineId)) }

  async readiness(engineId) {
    const engine = this.#engine(engineId)
    if (!engine) return { claimable: false }
    const now = Date.now()
    const queued = this.#ordered(engineId, 'queued')
    const ready = engine.enabled && !engine.activeJobId && !engine.quarantineReason
      && !(engine.cooldownUntil && new Date(engine.cooldownUntil).getTime() > now)
    return { claimable: (ready && queued.length > 0) || queued.some(job => new Date(job.deadlineAt).getTime() <= now) }
  }

  async submit({ engineId, owner, kind, idempotencyKey, fingerprint, items, limits }) {
    if (kind === 'batch') {
      const batch = [...this.batches.values()].find(row => row.consumerId === owner.consumerId && row.idempotencyKey === idempotencyKey)
      if (batch) {
        if (batch.fingerprint !== fingerprint) throw conflict()
        return { replay: true, batch: this.#copy(batch), jobs: [...this.jobs.values()].filter(job => job.batchId === batch.id)
          .sort((a, b) => a.itemIndex - b.itemIndex).map(job => this.#copy(job)) }
      }
    } else {
      const existing = [...this.jobs.values()].find(job => !job.batchId && job.consumerId === owner.consumerId && job.idempotencyKey === idempotencyKey)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw conflict()
        return { replay: true, batch: null, jobs: [this.#copy(existing)] }
      }
    }
    assertAccepting(this.#engine(engineId))
    const open = [...this.jobs.values()].filter(job => job.engineId === engineId && ['queued', 'running'].includes(job.status))
    assertCapacity({ queued: open.filter(job => job.status === 'queued').length,
      mine: open.filter(job => job.consumerId === owner.consumerId).length }, items.length, limits)
    const now = new Date()
    const batch = kind === 'batch' ? { id: randomUUID(), engineId, consumerId: owner.consumerId, idempotencyKey, fingerprint,
      itemCount: items.length, createdAt: now.toISOString() } : null
    if (batch) this.batches.set(batch.id, batch)
    const jobs = items.map((item, index) => {
      const job = { id: randomUUID(), engineId, batchId: batch?.id || null, itemIndex: batch ? index : null, clientRef: item.clientRef,
        tenantId: owner.tenantId, consumerId: owner.consumerId, apiKeyId: owner.apiKeyId, idempotencyKey: batch ? null : idempotencyKey,
        fingerprint: item.fingerprint, input: structuredClone(item.input), status: 'queued', sourceMode: null, billing: 'none',
        usageRequestId: null, owner: null, engineRevision: null, baseUrl: null, queuedAt: now.toISOString(),
        deadlineAt: new Date(now.getTime() + limits.queueWaitMs).toISOString(), dispatchedAt: null, finishedAt: null,
        durationMs: null, httpStatus: null, result: null, error: null, lateEvidence: null }
      this.jobs.set(job.id, job)
      return this.#copy(job)
    })
    return { replay: false, batch: this.#copy(batch), jobs }
  }

  async claim({ engineId, owner }) {
    const engine = this.#engine(engineId)
    if (!engine) return { job: null, expired: 0 }
    const now = Date.now()
    let expired = 0
    for (const job of this.#ordered(engineId, 'queued')) {
      if (new Date(job.deadlineAt).getTime() > now) continue
      Object.assign(job, { status: 'expired', finishedAt: new Date().toISOString(), error: EXPIRED })
      expired++
    }
    const cooling = engine.cooldownUntil && new Date(engine.cooldownUntil).getTime() > now
    if (!engine.enabled || engine.activeJobId || engine.quarantineReason || cooling) return { job: null, expired }
    const next = this.#ordered(engineId, 'queued')[0]
    if (!next) return { job: null, expired }
    Object.assign(next, { status: 'running', owner, dispatchedAt: new Date().toISOString(), engineRevision: engine.revision, baseUrl: engine.baseUrl })
    engine.activeJobId = next.id
    return { job: this.#copy(next), expired, billingEnabled: engine.billingEnabled === true }
  }

  async markReserved({ jobId, owner, usageRequestId }) {
    const job = this.jobs.get(jobId)
    if (!job || job.owner !== owner || job.status !== 'running') return false
    Object.assign(job, { usageRequestId, billing: 'reserved' })
    return true
  }

  async finish({ engineId, jobId, owner, outcome, httpStatus = null, durationMs = null, billing }) {
    const job = this.jobs.get(jobId)
    if (!job || job.owner !== owner || job.engineId !== engineId || job.status !== 'running') {
      if (job) job.lateEvidence = { at: new Date().toISOString(), owner, status: outcome.status, sourceMode: outcome.sourceMode || null,
        error: outcome.error || null, httpStatus, itemCount: outcome.result?.items?.length ?? null }
      return { fenced: true, job: null }
    }
    Object.assign(job, { status: outcome.status, sourceMode: outcome.sourceMode || null, result: outcome.result ? structuredClone(outcome.result) : null,
      error: outcome.error || null, httpStatus, durationMs, billing, finishedAt: new Date().toISOString() })
    const engine = this.#engine(engineId)
    if (outcome.quarantine) {
      Object.assign(engine, { quarantineReason: outcome.quarantine, quarantinedAt: new Date().toISOString() })
      this.#event(engineId, 'quarantined', { jobId, actor: 'executor', reason: outcome.error?.message || outcome.quarantine,
        details: { code: outcome.error?.code || outcome.quarantine } })
    } else if (engine.activeJobId === jobId) {
      engine.activeJobId = null
      if (outcome.cooldownUntil) {
        const until = Math.max(outcome.cooldownUntil, engine.cooldownUntil ? new Date(engine.cooldownUntil).getTime() : 0)
        engine.cooldownUntil = new Date(until).toISOString()
        this.#event(engineId, 'cooldown', { jobId, actor: 'executor', reason: '搜狗访问限制，引擎冷却', details: { until: engine.cooldownUntil } })
      }
    }
    return { fenced: false, job: this.#copy(job) }
  }

  async setBilling(jobId, billing) {
    const job = this.jobs.get(jobId)
    if (job) job.billing = billing
  }

  async orphanRunning({ engineId, owner }) {
    const orphans = this.#ordered(engineId, 'running').filter(job => job.owner !== owner)
    for (const job of orphans) {
      Object.assign(job, { status: 'unknown', finishedAt: new Date().toISOString(), error: RESTARTED,
        billing: job.billing === 'reserved' ? 'pending_review' : job.billing })
    }
    if (orphans[0]) {
      Object.assign(this.#engine(engineId), { activeJobId: orphans[0].id, quarantineReason: 'executor_restarted', quarantinedAt: new Date().toISOString() })
      this.#event(engineId, 'quarantined', { jobId: orphans[0].id, actor: 'executor', reason: RESTARTED.message, details: { code: RESTARTED.code } })
    }
    return orphans.map(job => this.#copy(job))
  }

  async updateEngine({ engineId, baseUrl, enabled, billingEnabled, expectedRevision, actor, reason }) {
    const engine = this.#engine(engineId)
    if (!engine) throw new AppError(404, 'engine_not_found', 'Engine not found')
    assertRevision(engine, expectedRevision)
    if (baseUrl !== engine.baseUrl && engine.activeJobId) throw new AppError(409, 'engine_busy', '引擎有任务正在执行或等待核实，此时不能更换地址')
    const before = { baseUrl: engine.baseUrl, enabled: engine.enabled, billingEnabled: engine.billingEnabled }
    const charging = billingEnabled ?? engine.billingEnabled
    Object.assign(engine, { baseUrl, enabled, billingEnabled: charging, revision: engine.revision + 1, updatedBy: actor, updateReason: reason, updatedAt: new Date().toISOString() })
    this.#event(engineId, 'configured', { actor, reason, details: { before, after: { baseUrl, enabled, billingEnabled: charging } } })
    return this.#copy(engine)
  }

  async recoverEngine({ engineId, expectedRevision, actor, reason }) {
    const engine = this.#engine(engineId)
    if (!engine) throw new AppError(404, 'engine_not_found', 'Engine not found')
    assertRevision(engine, expectedRevision)
    if (!engine.quarantineReason) throw new AppError(409, 'engine_not_quarantined', '引擎当前不需要恢复')
    if (this.#ordered(engineId, 'running').length) throw new AppError(409, 'engine_job_running', '仍有任务处于执行中，不能恢复')
    const previous = { jobId: engine.activeJobId, quarantineReason: engine.quarantineReason }
    Object.assign(engine, { activeJobId: null, quarantineReason: null, quarantinedAt: null, revision: engine.revision + 1,
      updatedBy: actor, updateReason: reason, updatedAt: new Date().toISOString() })
    this.#event(engineId, 'recovered', { jobId: previous.jobId, actor, reason, details: { quarantineReason: previous.quarantineReason } })
    return this.#copy(engine)
  }

  async events(engineId, limit = 20) {
    return this.engineEvents.filter(event => event.engineId === engineId).slice(0, limit).map(event => this.#copy(event))
  }

  async queueSnapshot(engineId) {
    const running = this.#ordered(engineId, 'running')[0]
    const recent = [...this.jobs.values()].filter(job => job.engineId === engineId && job.status === 'succeeded' && job.sourceMode === 'live' && job.durationMs != null)
      .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt)).slice(0, 20).map(job => job.durationMs).sort((a, b) => a - b)
    const middle = recent.length >> 1
    return {
      queued: this.#ordered(engineId, 'queued').map(job => ({ id: job.id, consumerId: job.consumerId })),
      runningSince: running ? new Date(running.dispatchedAt).getTime() : null,
      runningJobId: running?.id || null,
      medianMs: !recent.length ? null : recent.length % 2 ? recent[middle] : Math.round((recent[middle - 1] + recent[middle]) / 2),
    }
  }

  async get(jobId) { return this.#copy(this.jobs.get(jobId) || null) }

  async listForConsumer(consumerId, limit) {
    return [...this.jobs.values()].filter(job => job.consumerId === consumerId)
      .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt) || (a.itemIndex ?? 0) - (b.itemIndex ?? 0)).slice(0, limit).map(job => this.#copy(job))
  }

  async listRecent(engineId, limit) {
    return [...this.jobs.values()].filter(job => job.engineId === engineId)
      .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt) || (a.itemIndex ?? 0) - (b.itemIndex ?? 0)).slice(0, limit).map(job => this.#copy(job))
  }

  async batch(batchId) {
    const batch = this.batches.get(batchId)
    if (!batch) return null
    return { batch: this.#copy(batch), jobs: [...this.jobs.values()].filter(job => job.batchId === batchId)
      .sort((a, b) => a.itemIndex - b.itemIndex).map(job => this.#copy(job)) }
  }

  async cancel({ jobId, consumerId }) {
    const job = this.jobs.get(jobId)
    if (!job || job.consumerId !== consumerId || job.status !== 'queued') return null
    Object.assign(job, { status: 'cancelled', finishedAt: new Date().toISOString(), error: { code: 'cancelled', message: '调用方已取消，未派发，不收费' } })
    return this.#copy(job)
  }

  async prune(engineId, retentionMs) {
    const cutoff = Date.now() - retentionMs
    let removed = 0
    for (const job of [...this.jobs.values()]) {
      if (job.engineId === engineId && ['succeeded', 'failed', 'cancelled', 'expired'].includes(job.status)
        && job.billing !== 'pending_review' && job.finishedAt && new Date(job.finishedAt).getTime() < cutoff) {
        this.jobs.delete(job.id); removed++
      }
    }
    for (const batch of [...this.batches.values()]) {
      if (![...this.jobs.values()].some(job => job.batchId === batch.id)) this.batches.delete(batch.id)
    }
    return removed
  }
}

export function createSelfHostedStore(pool, { engines = [] } = {}) {
  return pool ? new PostgresSelfHostedStore(pool) : new MemorySelfHostedStore({ engines })
}
