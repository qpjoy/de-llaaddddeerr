import { createHash, randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'

// Durable state for collection engines (migration 183).
//
// Lock order is engine → slot → job everywhere a transaction waits. Claims
// take slots and jobs with SKIP LOCKED, so they never wait on either; an
// executor on another process or node simply takes the next free slot.
// Network calls never run inside a transaction.

const EXPIRED = { code: 'queue_deadline_exceeded', message: '排队超过最长等待时间，未派发，不收费' }
const ORPHANED = { code: 'executor_lost', message: '执行进程在派发途中失联，上游是否已开始执行未知' }
const READ_LOST = { code: 'executor_lost', message: '执行进程在只读查询途中失联；查询没有后续动作，可以重新提交' }
const ENGINE_RETRY_MS = 10 * 60 * 1000
const QUEUE_SNAPSHOT_MAX = 1_000
const iso = value => value == null ? null : new Date(value).toISOString()
const num = value => value == null ? null : Number(value)
const sha256 = text => createHash('sha256').update(text).digest('hex')

function jobRow(row) {
  if (!row) return null
  return {
    id: row.id, engineId: row.engine_id, capability: row.capability, routeKey: row.route_key, batchId: row.batch_id,
    itemIndex: row.item_index, clientRef: row.client_ref, tenantId: row.tenant_id, consumerId: row.consumer_id,
    apiKeyId: row.api_key_id, idempotencyKey: row.idempotency_key, fingerprint: row.fingerprint, input: row.input,
    status: row.status, phase: row.phase, dataStatus: row.data_status, slotNo: row.slot_no, owner: row.owner,
    leaseUntil: iso(row.lease_until), nextCheckAt: iso(row.next_check_at), checks: row.checks ?? 0,
    upstreamRef: row.upstream_ref, upstreamState: row.upstream_state, billing: row.billing, usageRequestId: row.usage_request_id,
    engineRevision: row.engine_revision, baseUrl: row.base_url, queuedAt: iso(row.queued_at), deadlineAt: iso(row.deadline_at),
    dispatchedAt: iso(row.dispatched_at), runDeadlineAt: iso(row.run_deadline_at), finishedAt: iso(row.finished_at),
    durationMs: row.duration_ms, httpStatus: row.http_status, error: row.error, cost: row.cost, lateEvidence: row.late_evidence,
    result: row.result_bytes == null ? null : { bytes: row.result_bytes, sha256: row.result_sha256, itemCount: row.result_item_count },
  }
}

function engineRow(row) {
  if (!row) return null
  return {
    id: row.id, kind: row.kind, displayName: row.display_name, slotRef: row.slot_ref, baseUrl: row.base_url,
    credentialProvider: row.credential_provider, config: row.config || {}, capacity: row.capacity,
    queueLimit: row.queue_limit, consumerOpenLimit: row.consumer_open_limit, queueWaitMs: num(row.queue_wait_ms),
    runTimeoutMs: row.run_timeout_ms, enabled: row.enabled, billingEnabled: row.billing_enabled === true,
    quarantineReason: row.quarantine_reason, quarantinedAt: iso(row.quarantined_at), cooldownUntil: iso(row.cooldown_until),
    revision: row.revision, createdAt: iso(row.created_at), updatedBy: row.updated_by, updateReason: row.update_reason, updatedAt: iso(row.updated_at),
  }
}

const batchRow = row => row && ({ id: row.id, capability: row.capability, consumerId: row.consumer_id,
  idempotencyKey: row.idempotency_key, fingerprint: row.fingerprint, itemCount: row.item_count, createdAt: iso(row.created_at) })

const conflict = () => new AppError(409, 'idempotency_conflict', 'Idempotency-Key was already used with a different request')

function assertAccepting(engine, capability, routeKey) {
  if (!engine) {
    throw new AppError(503, 'capability_not_routed', '当前没有引擎承接该能力', { capability, routeKey: routeKey || null, retryAfterMs: ENGINE_RETRY_MS })
  }
  if (!engine.enabled) throw new AppError(503, 'engine_disabled', '承接该能力的引擎已停用，暂不接收新任务', { engineId: engine.id, retryAfterMs: ENGINE_RETRY_MS })
  if (engine.quarantineReason) {
    throw new AppError(503, 'engine_attention_required', '承接该能力的引擎等待人工核实，暂不接收新任务', { engineId: engine.id, retryAfterMs: ENGINE_RETRY_MS })
  }
}

// Per-caller limits are exact (submissions of one caller are serialized);
// the engine queue limit is admission control and may overshoot by the
// submissions in flight at the same moment (spider_man invariant 4).
function assertCapacity(engine, { queued, mine }, count) {
  if (queued + count > engine.queueLimit) {
    throw new AppError(429, 'engine_queue_full', `引擎排队已满（最多 ${engine.queueLimit} 条），请稍后再提交`,
      { engineId: engine.id, queued, limit: engine.queueLimit, retryAfterMs: 60_000 })
  }
  if (mine + count > engine.consumerOpenLimit) {
    throw new AppError(429, 'consumer_queue_full', `当前调用方在该引擎未完成的任务已达上限（${engine.consumerOpenLimit} 条）`,
      { engineId: engine.id, open: mine, limit: engine.consumerOpenLimit, retryAfterMs: 60_000 })
  }
}

function assertRevision(engine, expectedRevision) {
  if (!Number.isInteger(expectedRevision) || expectedRevision !== engine.revision) {
    throw new AppError(409, 'engine_revision_conflict', '配置已被其他人修改，请刷新后再操作', { revision: engine.revision })
  }
}

function resultRecord(outcome) {
  if (outcome.result == null) return null
  const text = JSON.stringify(outcome.result)
  return { text, bytes: Buffer.byteLength(text), sha256: sha256(text), itemCount: Number.isInteger(outcome.itemCount) ? outcome.itemCount : null }
}

const lateEvidence = (owner, outcome, httpStatus) => ({ at: new Date().toISOString(), owner, status: outcome.status,
  dataStatus: outcome.dataStatus || null, error: outcome.error || null, httpStatus, itemCount: outcome.itemCount ?? null })

const ENGINE_COLUMNS = {
  displayName: 'display_name', slotRef: 'slot_ref', baseUrl: 'base_url', credentialProvider: 'credential_provider', config: 'config',
  capacity: 'capacity', queueLimit: 'queue_limit', consumerOpenLimit: 'consumer_open_limit', queueWaitMs: 'queue_wait_ms',
  runTimeoutMs: 'run_timeout_ms', enabled: 'enabled', billingEnabled: 'billing_enabled',
}
const ADDRESS_FIELDS = ['baseUrl', 'credentialProvider', 'slotRef', 'config']

function routeTaken(error) {
  return error?.code === '23505' && String(error.constraint || '').startsWith('routes_pkey')
    ? new AppError(409, 'route_taken', '该能力（及路由）已由其他引擎承接，请先在原引擎解除') : null
}

export class PostgresCollectStore {
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

  async #event(client, engineId, action, { jobId = null, slotNo = null, actor, reason, details = {} }) {
    await client.query(`INSERT INTO collect.engine_events (engine_id, action, revision, slot_no, job_id, actor, reason, details)
      SELECT id, $2, revision, $3, $4, $5, $6, $7::jsonb FROM collect.engines WHERE id = $1`,
    [engineId, action, slotNo, jobId, actor, reason, JSON.stringify(details)])
  }

  // ---- engines --------------------------------------------------------------

  async engine(engineId) {
    const { rows } = await this.pool.query('SELECT * FROM collect.engines WHERE id = $1', [engineId])
    return engineRow(rows[0])
  }

  async enginesById(ids) {
    if (!ids.length) return new Map()
    const { rows } = await this.pool.query('SELECT * FROM collect.engines WHERE id = ANY($1::text[])', [ids])
    return new Map(rows.map(row => [row.id, engineRow(row)]))
  }

  async listEngines() {
    const { rows } = await this.pool.query(`SELECT engine.*,
        (SELECT count(*) FROM collect.engine_slots slot WHERE slot.engine_id = engine.id AND slot.job_id IS NOT NULL AND slot.quarantine_reason IS NULL)::int AS busy_slots,
        (SELECT count(*) FROM collect.engine_slots slot WHERE slot.engine_id = engine.id AND slot.quarantine_reason IS NOT NULL)::int AS quarantined_slots,
        (SELECT count(*) FROM (SELECT 1 FROM collect.jobs job WHERE job.engine_id = engine.id AND job.status = 'queued' LIMIT 20001) queued)::int AS queued,
        (SELECT COALESCE(jsonb_object_agg(status, total), '{}'::jsonb) FROM (SELECT job.status, count(*)::int AS total FROM collect.jobs job
          WHERE job.engine_id = engine.id AND job.finished_at > clock_timestamp() - interval '24 hours' GROUP BY job.status) recent) AS recent,
        (SELECT COALESCE(sum((job.cost->>'usd')::numeric), 0)::float8 FROM collect.jobs job WHERE job.engine_id = engine.id
          AND job.finished_at > clock_timestamp() - interval '24 hours' AND jsonb_typeof(job.cost->'usd') = 'number') AS cost_usd,
        (SELECT COALESCE(jsonb_agg(jsonb_build_object('capability', route.capability, 'routeKey', route.route_key) ORDER BY route.capability, route.route_key), '[]'::jsonb)
          FROM collect.routes route WHERE route.engine_id = engine.id) AS routes
      FROM collect.engines engine ORDER BY engine.id`)
    return rows.map(row => ({ ...engineRow(row), stats: { busySlots: row.busy_slots, quarantinedSlots: row.quarantined_slots,
      queued: row.queued, recent: row.recent, costUsd24h: Math.round(Number(row.cost_usd) * 1e4) / 1e4 }, routes: row.routes }))
  }

  async engineDetail(engineId) {
    const [engine, slots, routes] = await Promise.all([
      this.engine(engineId),
      this.pool.query(`SELECT slot.*, job.status AS job_status, job.phase AS job_phase, job.capability AS job_capability,
          job.dispatched_at AS job_dispatched_at, job.run_deadline_at AS job_run_deadline_at, job.consumer_id AS job_consumer_id
        FROM collect.engine_slots slot LEFT JOIN collect.jobs job ON job.id = slot.job_id
        WHERE slot.engine_id = $1 ORDER BY slot.slot_no`, [engineId]),
      this.pool.query('SELECT capability, route_key FROM collect.routes WHERE engine_id = $1 ORDER BY capability, route_key', [engineId]),
    ])
    if (!engine) return null
    return {
      engine,
      slots: slots.rows.map(row => ({ slotNo: row.slot_no, jobId: row.job_id, quarantineReason: row.quarantine_reason, quarantinedAt: iso(row.quarantined_at),
        job: row.job_id ? { status: row.job_status, phase: row.job_phase, capability: row.job_capability, consumerId: row.job_consumer_id,
          dispatchedAt: iso(row.job_dispatched_at), runDeadlineAt: iso(row.job_run_deadline_at) } : null })),
      routes: routes.rows.map(row => ({ capability: row.capability, routeKey: row.route_key })),
    }
  }

  async createEngine({ engine, routes, actor, reason }) {
    try {
      return await this.#tx(async client => {
        const { rows: [row] } = await client.query(`INSERT INTO collect.engines (id, kind, display_name, slot_ref, base_url, credential_provider, config,
            capacity, queue_limit, consumer_open_limit, queue_wait_ms, run_timeout_ms, enabled, billing_enabled, updated_by, update_reason)
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
        [engine.id, engine.kind, engine.displayName, engine.slotRef, engine.baseUrl, engine.credentialProvider, JSON.stringify(engine.config || {}),
          engine.capacity, engine.queueLimit, engine.consumerOpenLimit, engine.queueWaitMs, engine.runTimeoutMs, engine.enabled, engine.billingEnabled, actor, reason])
        await client.query('INSERT INTO collect.engine_slots (engine_id, slot_no) SELECT $1, generate_series(1, $2)', [engine.id, engine.capacity])
        for (const route of routes) {
          await client.query('INSERT INTO collect.routes (capability, route_key, engine_id, updated_by) VALUES ($1, $2, $3, $4)',
            [route.capability, route.routeKey, engine.id, actor])
        }
        await this.#event(client, engine.id, 'created', { actor, reason, details: { kind: engine.kind, capacity: engine.capacity, routes } })
        return engineRow(row)
      })
    } catch (error) {
      if (error?.code === '23505' && error.constraint === 'engines_pkey') throw new AppError(409, 'engine_exists', '引擎 ID 已存在')
      throw routeTaken(error) || error
    }
  }

  async updateEngine({ engineId, patch, routes = null, expectedRevision, actor, reason }) {
    try {
      return await this.#tx(async client => {
        const { rows: [current] } = await client.query('SELECT * FROM collect.engines WHERE id = $1 FOR UPDATE', [engineId])
        if (!current) throw new AppError(404, 'engine_not_found', 'Engine not found')
        const before = engineRow(current)
        assertRevision(before, expectedRevision)
        const changed = Object.keys(patch).filter(key => JSON.stringify(patch[key]) !== JSON.stringify(before[key]))
        if (changed.some(key => ADDRESS_FIELDS.includes(key))) {
          const { rows: [busy] } = await client.query('SELECT 1 FROM collect.engine_slots WHERE engine_id = $1 AND job_id IS NOT NULL LIMIT 1', [engineId])
          if (busy) throw new AppError(409, 'engine_busy', '引擎有任务正在执行或等待核实，此时不能更换地址、凭据或配置')
        }
        const sets = changed.map((key, index) => `${ENGINE_COLUMNS[key]} = $${index + 2}${key === 'config' ? '::jsonb' : ''}`)
        const values = changed.map(key => key === 'config' ? JSON.stringify(patch[key]) : patch[key])
        const { rows: [row] } = await client.query(`UPDATE collect.engines SET ${[...sets, `revision = revision + 1`,
          `updated_by = $${values.length + 2}`, `update_reason = $${values.length + 3}`, 'updated_at = clock_timestamp()'].join(', ')}
          WHERE id = $1 RETURNING *`, [engineId, ...values, actor, reason])
        if (changed.includes('capacity')) {
          await client.query(`INSERT INTO collect.engine_slots (engine_id, slot_no) SELECT $1, generate_series(1, $2)
            ON CONFLICT DO NOTHING`, [engineId, row.capacity])
          // Busy slots above the new capacity drain and are removed when freed.
          await client.query('DELETE FROM collect.engine_slots WHERE engine_id = $1 AND slot_no > $2 AND job_id IS NULL', [engineId, row.capacity])
        }
        if (routes) {
          await client.query('DELETE FROM collect.routes WHERE engine_id = $1', [engineId])
          for (const route of routes) {
            await client.query('INSERT INTO collect.routes (capability, route_key, engine_id, updated_by) VALUES ($1, $2, $3, $4)',
              [route.capability, route.routeKey, engineId, actor])
          }
        }
        await this.#event(client, engineId, 'configured', { actor, reason, details: {
          changed, before: Object.fromEntries(changed.map(key => [key, before[key]])), after: Object.fromEntries(changed.map(key => [key, patch[key]])),
          ...(routes ? { routes } : {}) } })
        return engineRow(row)
      })
    } catch (error) {
      throw routeTaken(error) || error
    }
  }

  async recoverEngine({ engineId, expectedRevision, actor, reason }) {
    return this.#tx(async client => {
      const { rows: [current] } = await client.query('SELECT * FROM collect.engines WHERE id = $1 FOR UPDATE', [engineId])
      if (!current) throw new AppError(404, 'engine_not_found', 'Engine not found')
      const before = engineRow(current)
      assertRevision(before, expectedRevision)
      if (!before.quarantineReason) throw new AppError(409, 'engine_not_quarantined', '引擎当前不需要恢复')
      const { rows: [row] } = await client.query(`UPDATE collect.engines SET quarantine_reason = NULL, quarantined_at = NULL, revision = revision + 1,
          updated_by = $2, update_reason = $3, updated_at = clock_timestamp() WHERE id = $1 RETURNING *`, [engineId, actor, reason])
      await this.#event(client, engineId, 'recovered', { actor, reason, details: { quarantineReason: before.quarantineReason } })
      return engineRow(row)
    })
  }

  async recoverSlot({ engineId, slotNo, expectedRevision, actor, reason }) {
    return this.#tx(async client => {
      const { rows: [current] } = await client.query('SELECT * FROM collect.engines WHERE id = $1 FOR UPDATE', [engineId])
      if (!current) throw new AppError(404, 'engine_not_found', 'Engine not found')
      assertRevision(engineRow(current), expectedRevision)
      const { rows: [slot] } = await client.query('SELECT * FROM collect.engine_slots WHERE engine_id = $1 AND slot_no = $2 FOR UPDATE', [engineId, slotNo])
      if (!slot) throw new AppError(404, 'slot_not_found', 'Slot not found')
      if (!slot.quarantine_reason) throw new AppError(409, 'slot_not_quarantined', '该执行槽当前不需要恢复')
      const { rows: [running] } = await client.query(`SELECT 1 FROM collect.jobs WHERE id = $1 AND status = 'running'`, [slot.job_id])
      if (running) throw new AppError(409, 'slot_job_running', '该执行槽上的任务仍在执行中，不能恢复')
      if (slotNo > current.capacity) {
        await client.query('DELETE FROM collect.engine_slots WHERE engine_id = $1 AND slot_no = $2', [engineId, slotNo])
      } else {
        await client.query(`UPDATE collect.engine_slots SET job_id = NULL, quarantine_reason = NULL, quarantined_at = NULL
          WHERE engine_id = $1 AND slot_no = $2`, [engineId, slotNo])
      }
      const { rows: [row] } = await client.query(`UPDATE collect.engines SET revision = revision + 1, updated_by = $2, update_reason = $3,
          updated_at = clock_timestamp() WHERE id = $1 RETURNING *`, [engineId, actor, reason])
      await this.#event(client, engineId, 'slot_recovered', { slotNo, jobId: slot.job_id, actor, reason, details: { quarantineReason: slot.quarantine_reason } })
      return engineRow(row)
    })
  }

  async recordEvent(engineId, action, { actor, reason, details = {} }) {
    await this.#tx(client => this.#event(client, engineId, action, { actor, reason, details }))
  }

  async events(engineId, limit = 30) {
    const { rows } = await this.pool.query(`SELECT * FROM collect.engine_events WHERE engine_id = $1
      ORDER BY created_at DESC, id DESC LIMIT $2`, [engineId, limit])
    return rows.map(row => ({ id: Number(row.id), action: row.action, revision: row.revision, slotNo: row.slot_no, jobId: row.job_id,
      actor: row.actor, reason: row.reason, details: row.details, createdAt: iso(row.created_at) }))
  }

  // ---- submission -----------------------------------------------------------

  async submit({ owner, kind, idempotencyKey, fingerprint, capability, items }) {
    return this.#tx(async client => {
      // One caller's submissions are serialized: exact per-caller limits and
      // no idempotency race. Different callers never wait on each other.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`collect:submit:${owner.consumerId}`])
      if (kind === 'batch') {
        const { rows: [batch] } = await client.query('SELECT * FROM collect.batches WHERE consumer_id = $1 AND idempotency_key = $2',
          [owner.consumerId, idempotencyKey])
        if (batch) {
          if (batch.fingerprint !== fingerprint) throw conflict()
          const { rows } = await client.query('SELECT * FROM collect.jobs WHERE batch_id = $1 ORDER BY item_index', [batch.id])
          return { replay: true, batch: batchRow(batch), jobs: rows.map(jobRow) }
        }
      } else {
        const { rows: [existing] } = await client.query(`SELECT * FROM collect.jobs
          WHERE consumer_id = $1 AND idempotency_key = $2 AND batch_id IS NULL`, [owner.consumerId, idempotencyKey])
        if (existing) {
          if (existing.fingerprint !== fingerprint) throw conflict()
          return { replay: true, batch: null, jobs: [jobRow(existing)] }
        }
      }
      const routeKeys = [...new Set(items.map(item => item.routeKey))]
      const { rows: routed } = await client.query(`SELECT route.route_key, engine.* FROM collect.routes route
        JOIN collect.engines engine ON engine.id = route.engine_id WHERE route.capability = $1 AND route.route_key = ANY($2::text[])`,
      [capability, routeKeys])
      const byRoute = new Map(routed.map(row => [row.route_key, engineRow(row)]))
      for (const key of routeKeys) assertAccepting(byRoute.get(key), capability, key)
      const perEngine = new Map()
      for (const item of items) {
        const engine = byRoute.get(item.routeKey)
        perEngine.set(engine.id, { engine, count: (perEngine.get(engine.id)?.count || 0) + 1 })
      }
      for (const { engine, count } of perEngine.values()) {
        const { rows: [counts] } = await client.query(`SELECT
            (SELECT count(*) FROM (SELECT 1 FROM collect.jobs WHERE engine_id = $1 AND status = 'queued' LIMIT $3) queued)::int AS queued,
            (SELECT count(*) FROM (SELECT 1 FROM collect.jobs WHERE engine_id = $1 AND consumer_id = $2
              AND status IN ('queued', 'running') LIMIT $4) mine)::int AS mine`,
        [engine.id, owner.consumerId, engine.queueLimit + 1, engine.consumerOpenLimit + 1])
        assertCapacity(engine, counts, count)
      }
      let batch = null
      if (kind === 'batch') {
        const { rows: [row] } = await client.query(`INSERT INTO collect.batches
            (id, capability, tenant_id, consumer_id, api_key_id, idempotency_key, fingerprint, item_count)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [randomUUID(), capability, owner.tenantId, owner.consumerId, owner.apiKeyId, idempotencyKey, fingerprint, items.length])
        batch = batchRow(row)
      }
      const records = items.map((item, index) => {
        const engine = byRoute.get(item.routeKey)
        return { id: randomUUID(), engine_id: engine.id, route_key: item.routeKey, item_index: batch ? index : null,
          client_ref: item.clientRef, fingerprint: item.fingerprint, input: item.input, queue_wait_ms: engine.queueWaitMs }
      })
      // One statement for the whole batch; clock_timestamp() advances per row,
      // so queued_at keeps the input order.
      const { rows } = await client.query(`INSERT INTO collect.jobs (id, engine_id, capability, route_key, batch_id, item_index, client_ref,
          tenant_id, consumer_id, api_key_id, idempotency_key, fingerprint, input, status, deadline_at)
        SELECT item.id, item.engine_id, $2, item.route_key, $3, item.item_index, item.client_ref, $4, $5, $6, $7, item.fingerprint, item.input,
          'queued', clock_timestamp() + item.queue_wait_ms * interval '1 millisecond'
        FROM jsonb_to_recordset($1::jsonb) AS item(id uuid, engine_id text, route_key text, item_index integer, client_ref text,
          fingerprint text, input jsonb, queue_wait_ms bigint)
        ORDER BY item.item_index NULLS FIRST
        RETURNING *`,
      [JSON.stringify(records), capability, batch?.id || null, owner.tenantId, owner.consumerId, owner.apiKeyId, batch ? null : idempotencyKey])
      return { replay: false, batch, jobs: rows.map(jobRow).sort((a, b) => (a.itemIndex ?? 0) - (b.itemIndex ?? 0)) }
    })
  }

  // ---- executor ---------------------------------------------------------------

  // Lock-free scan for the executor poll: which engines have a free slot and
  // queued work, and whether any housekeeping or async check is due.
  async readiness() {
    const [engines, due] = await Promise.all([
      this.pool.query(`SELECT engine.id, engine.kind,
          (SELECT count(*) FROM collect.engine_slots slot WHERE slot.engine_id = engine.id AND slot.slot_no <= engine.capacity
            AND slot.job_id IS NULL AND slot.quarantine_reason IS NULL)::int AS free
        FROM collect.engines engine
        WHERE engine.enabled AND engine.quarantine_reason IS NULL
          AND (engine.cooldown_until IS NULL OR engine.cooldown_until <= clock_timestamp())
          AND EXISTS (SELECT 1 FROM collect.jobs job WHERE job.engine_id = engine.id AND job.status = 'queued' AND job.deadline_at > clock_timestamp())`),
      this.pool.query(`SELECT
          EXISTS (SELECT 1 FROM collect.jobs WHERE phase = 'waiting' AND next_check_at <= clock_timestamp()) AS checks,
          EXISTS (SELECT 1 FROM collect.jobs WHERE phase = 'dispatching' AND lease_until <= clock_timestamp()) AS orphans,
          EXISTS (SELECT 1 FROM collect.jobs WHERE status = 'queued' AND deadline_at <= clock_timestamp()) AS expired`),
    ])
    return { engines: engines.rows.filter(row => row.free > 0).map(row => ({ id: row.id, kind: row.kind, free: row.free })), ...due.rows[0] }
  }

  async claim({ engineId, owner, dispatchLeaseMs = null, leaseGraceMs }) {
    return this.#tx(async client => {
      const { rows: [engine] } = await client.query(`SELECT *, COALESCE(cooldown_until > clock_timestamp(), false) AS cooling
        FROM collect.engines WHERE id = $1 FOR KEY SHARE`, [engineId])
      if (!engine || !engine.enabled || engine.quarantine_reason || engine.cooling) return { job: null }
      const { rows: [slot] } = await client.query(`SELECT slot_no FROM collect.engine_slots WHERE engine_id = $1 AND slot_no <= $2
        AND job_id IS NULL AND quarantine_reason IS NULL ORDER BY slot_no LIMIT 1 FOR UPDATE SKIP LOCKED`, [engineId, engine.capacity])
      if (!slot) return { job: null }
      const { rows: [next] } = await client.query(`SELECT id FROM collect.jobs WHERE engine_id = $1 AND status = 'queued'
        AND deadline_at > clock_timestamp() ORDER BY queued_at, item_index, id LIMIT 1 FOR UPDATE SKIP LOCKED`, [engineId])
      if (!next) return { job: null }
      const leaseMs = dispatchLeaseMs ?? engine.run_timeout_ms + leaseGraceMs
      const { rows: [running] } = await client.query(`UPDATE collect.jobs SET status = 'running', phase = 'dispatching', slot_no = $2, owner = $3,
          dispatched_at = clock_timestamp(), run_deadline_at = clock_timestamp() + $4::bigint * interval '1 millisecond',
          lease_until = clock_timestamp() + $5::bigint * interval '1 millisecond', engine_revision = $6, base_url = $7
        WHERE id = $1 RETURNING *`, [next.id, slot.slot_no, owner, engine.run_timeout_ms, leaseMs, engine.revision, engine.base_url])
      await client.query('UPDATE collect.engine_slots SET job_id = $3 WHERE engine_id = $1 AND slot_no = $2', [engineId, slot.slot_no, next.id])
      return { job: jobRow(running), engine: engineRow(engine) }
    })
  }

  // Claim one specific queued job for an inline (synchronous) run. Same slot
  // arbitration as claim(); it only skips the queue order, so it is used for
  // synchronous kinds whose jobs are meant to run at once.
  async claimJob({ jobId, owner, dispatchLeaseMs = null, leaseGraceMs }) {
    return this.#tx(async client => {
      const { rows: [target] } = await client.query(`SELECT engine_id FROM collect.jobs WHERE id = $1`, [jobId])
      if (!target) return { job: null, reason: 'missing' }
      const { rows: [engine] } = await client.query(`SELECT *, COALESCE(cooldown_until > clock_timestamp(), false) AS cooling
        FROM collect.engines WHERE id = $1 FOR KEY SHARE`, [target.engine_id])
      if (!engine || !engine.enabled || engine.quarantine_reason || engine.cooling) return { job: null, reason: 'engine_not_ready' }
      const { rows: [slot] } = await client.query(`SELECT slot_no FROM collect.engine_slots WHERE engine_id = $1 AND slot_no <= $2
        AND job_id IS NULL AND quarantine_reason IS NULL ORDER BY slot_no LIMIT 1 FOR UPDATE SKIP LOCKED`, [engine.id, engine.capacity])
      if (!slot) return { job: null, reason: 'no_free_slot' }
      const { rows: [queued] } = await client.query(`SELECT id FROM collect.jobs WHERE id = $1 AND status = 'queued'
        AND deadline_at > clock_timestamp() FOR UPDATE SKIP LOCKED`, [jobId])
      if (!queued) return { job: null, reason: 'not_queued' }
      const leaseMs = dispatchLeaseMs ?? engine.run_timeout_ms + leaseGraceMs
      const { rows: [running] } = await client.query(`UPDATE collect.jobs SET status = 'running', phase = 'dispatching', slot_no = $2, owner = $3,
          dispatched_at = clock_timestamp(), run_deadline_at = clock_timestamp() + $4::bigint * interval '1 millisecond',
          lease_until = clock_timestamp() + $5::bigint * interval '1 millisecond', engine_revision = $6, base_url = $7
        WHERE id = $1 RETURNING *`, [jobId, slot.slot_no, owner, engine.run_timeout_ms, leaseMs, engine.revision, engine.base_url])
      await client.query('UPDATE collect.engine_slots SET job_id = $3 WHERE engine_id = $1 AND slot_no = $2', [engine.id, slot.slot_no, jobId])
      return { job: jobRow(running), engine: engineRow(engine) }
    })
  }

  async markReserved({ jobId, owner, usageRequestId }) {
    const { rowCount } = await this.pool.query(`UPDATE collect.jobs SET usage_request_id = $3, billing = 'reserved'
      WHERE id = $1 AND owner = $2 AND status = 'running'`, [jobId, owner, usageRequestId])
    return rowCount === 1
  }

  async markWaiting({ jobId, owner, upstreamRef, upstreamState, nextCheckMs, leaseGraceMs }) {
    const { rows: [row] } = await this.pool.query(`UPDATE collect.jobs SET phase = 'waiting', upstream_ref = $3, upstream_state = $4::jsonb,
        next_check_at = clock_timestamp() + $5::bigint * interval '1 millisecond', lease_until = run_deadline_at + $6::bigint * interval '1 millisecond'
      WHERE id = $1 AND owner = $2 AND phase = 'dispatching' RETURNING *`,
    [jobId, owner, upstreamRef, JSON.stringify(upstreamState ?? null), nextCheckMs, leaseGraceMs])
    return jobRow(row)
  }

  // Due async checks. Taking one moves next_check_at forward, which doubles as
  // the check lease: a crashed checker's job becomes due again by itself.
  async claimChecks({ owner, limit, checkLeaseMs }) {
    const { rows } = await this.pool.query(`WITH due AS (
        SELECT id FROM collect.jobs WHERE phase = 'waiting' AND next_check_at <= clock_timestamp()
        ORDER BY next_check_at LIMIT $2 FOR UPDATE SKIP LOCKED)
      UPDATE collect.jobs job SET owner = $1, checks = job.checks + 1,
        next_check_at = clock_timestamp() + $3::bigint * interval '1 millisecond'
      FROM due WHERE job.id = due.id RETURNING job.*`, [owner, limit, checkLeaseMs])
    return rows.map(jobRow)
  }

  async updateWaiting({ jobId, owner, upstreamState = null, nextCheckMs }) {
    const { rowCount } = await this.pool.query(`UPDATE collect.jobs SET upstream_state = COALESCE($3::jsonb, upstream_state),
        next_check_at = clock_timestamp() + $4::bigint * interval '1 millisecond'
      WHERE id = $1 AND owner = $2 AND phase = 'waiting'`, [jobId, owner, upstreamState == null ? null : JSON.stringify(upstreamState), nextCheckMs])
    return rowCount === 1
  }

  async finish({ jobId, owner, outcome, httpStatus = null, durationMs = null, billing }) {
    const record = resultRecord(outcome)
    return this.#tx(async client => {
      const engineScoped = Boolean(outcome.cooldownUntil || outcome.paceUntil || outcome.quarantine === 'engine')
      if (engineScoped) {
        // Engine row first, matching the engine → slot → job order elsewhere.
        await client.query(`SELECT 1 FROM collect.engines WHERE id = (SELECT engine_id FROM collect.jobs WHERE id = $1) FOR NO KEY UPDATE`, [jobId])
      }
      const { rows: [row] } = await client.query(`UPDATE collect.jobs SET status = $3, phase = NULL, data_status = $4, error = $5::jsonb,
          http_status = $6, duration_ms = $7, billing = $8, cost = $9::jsonb, finished_at = clock_timestamp(), lease_until = NULL, next_check_at = NULL
        WHERE id = $1 AND owner = $2 AND status = 'running' RETURNING *`,
      [jobId, owner, outcome.status, outcome.dataStatus || null, outcome.error ? JSON.stringify(outcome.error) : null, httpStatus, durationMs, billing,
        outcome.cost ? JSON.stringify(outcome.cost) : null])
      if (!row) {
        // Someone else already recorded an outcome. Keep this answer as
        // evidence; never overwrite the recorded terminal state.
        await client.query('UPDATE collect.jobs SET late_evidence = $2::jsonb WHERE id = $1', [jobId, JSON.stringify(lateEvidence(owner, outcome, httpStatus))])
        return { fenced: true, job: null }
      }
      if (record) {
        await client.query(`INSERT INTO collect.job_results (job_id, payload, bytes, sha256, item_count) VALUES ($1, $2::jsonb, $3, $4, $5)
          ON CONFLICT (job_id) DO NOTHING`, [jobId, record.text, record.bytes, record.sha256, record.itemCount])
      }
      if (outcome.quarantine) {
        await client.query(`UPDATE collect.engine_slots SET quarantine_reason = $4, quarantined_at = clock_timestamp()
          WHERE engine_id = $1 AND slot_no = $2 AND job_id = $3`, [row.engine_id, row.slot_no, jobId, outcome.error?.code || 'unknown'])
        await this.#event(client, row.engine_id, 'slot_quarantined', { jobId, slotNo: row.slot_no, actor: 'executor',
          reason: outcome.error?.message || '结果未知', details: { code: outcome.error?.code || null } })
        if (outcome.quarantine === 'engine') {
          await client.query(`UPDATE collect.engines SET quarantine_reason = $2, quarantined_at = clock_timestamp()
            WHERE id = $1 AND quarantine_reason IS NULL`, [row.engine_id, outcome.error?.code || 'unknown'])
          await this.#event(client, row.engine_id, 'quarantined', { jobId, actor: 'executor', reason: outcome.error?.message || '结果未知' })
        }
      } else {
        await client.query('UPDATE collect.engine_slots SET job_id = NULL WHERE engine_id = $1 AND slot_no = $2 AND job_id = $3',
          [row.engine_id, row.slot_no, jobId])
        await client.query(`DELETE FROM collect.engine_slots slot USING collect.engines engine WHERE engine.id = slot.engine_id
          AND slot.engine_id = $1 AND slot.slot_no = $2 AND slot.slot_no > engine.capacity AND slot.job_id IS NULL`, [row.engine_id, row.slot_no])
      }
      if (outcome.cooldownUntil) {
        const until = new Date(outcome.cooldownUntil)
        await client.query(`UPDATE collect.engines SET cooldown_until = GREATEST(COALESCE(cooldown_until, $2::timestamptz), $2::timestamptz)
          WHERE id = $1`, [row.engine_id, until])
        await this.#event(client, row.engine_id, 'cooldown', { jobId, actor: 'executor', reason: outcome.error?.message || '上游要求冷却',
          details: { until: until.toISOString() } })
      }
      if (outcome.paceUntil) {
        // Routine pacing (e.g. one request per second): no audit event.
        await client.query(`UPDATE collect.engines SET cooldown_until = GREATEST(COALESCE(cooldown_until, $2::timestamptz), $2::timestamptz)
          WHERE id = $1`, [row.engine_id, new Date(outcome.paceUntil)])
      }
      return { fenced: false, job: jobRow({ ...row, result_bytes: record?.bytes ?? null, result_sha256: record?.sha256 ?? null, result_item_count: record?.itemCount ?? null }) }
    })
  }

  async setBilling(jobId, billing) {
    await this.pool.query('UPDATE collect.jobs SET billing = $2 WHERE id = $1', [jobId, billing])
  }

  async expireQueued(limit = 1_000) {
    const { rows } = await this.pool.query(`UPDATE collect.jobs SET status = 'expired', finished_at = clock_timestamp(), error = $2::jsonb
      WHERE id IN (SELECT id FROM collect.jobs WHERE status = 'queued' AND deadline_at <= clock_timestamp()
        ORDER BY deadline_at LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING id`, [limit, JSON.stringify(EXPIRED)])
    return rows.length
  }

  // Dispatches whose executor stopped renewing them. A reconcilable kind is
  // re-checked against the upstream; otherwise the run is unknown and its
  // slot stays quarantined.
  async reapOrphans({ reconcilableKinds, readOnlyKinds = [], leaseGraceMs, limit = 100 }) {
    return this.#tx(async client => {
      const { rows } = await client.query(`SELECT job.id, job.engine_id, job.slot_no, job.usage_request_id, engine.kind FROM collect.jobs job
        JOIN collect.engines engine ON engine.id = job.engine_id
        WHERE job.phase = 'dispatching' AND job.lease_until <= clock_timestamp()
        ORDER BY job.lease_until LIMIT $1 FOR UPDATE OF job SKIP LOCKED`, [limit])
      const unknownJobs = []
      for (const row of rows) {
        if (reconcilableKinds.includes(row.kind)) {
          await client.query(`UPDATE collect.jobs SET phase = 'waiting', owner = 'reaper', upstream_ref = COALESCE(upstream_ref, id::text),
              upstream_state = COALESCE(upstream_state, '{"confirmed":false}'::jsonb), next_check_at = clock_timestamp(),
              lease_until = GREATEST(run_deadline_at, clock_timestamp()) + $2::bigint * interval '1 millisecond'
            WHERE id = $1`, [row.id, leaseGraceMs])
          await this.#event(client, row.engine_id, 'reconcile', { jobId: row.id, slotNo: row.slot_no, actor: 'executor', reason: '派发进程失联，改为向上游核对' })
          continue
        }
        if (readOnlyKinds.includes(row.kind)) {
          // A read-only query leaves nothing running upstream: fail it and free the slot.
          await client.query(`UPDATE collect.jobs SET status = 'failed', phase = NULL, finished_at = clock_timestamp(), lease_until = NULL,
              next_check_at = NULL, error = $2::jsonb, billing = CASE WHEN billing = 'reserved' THEN 'pending_review' ELSE billing END
            WHERE id = $1`, [row.id, JSON.stringify(READ_LOST)])
          await client.query('UPDATE collect.engine_slots SET job_id = NULL WHERE engine_id = $1 AND slot_no = $2 AND job_id = $3', [row.engine_id, row.slot_no, row.id])
          continue
        }
        const { rows: [job] } = await client.query(`UPDATE collect.jobs SET status = 'unknown', phase = NULL, data_status = 'unknown',
            finished_at = clock_timestamp(), lease_until = NULL, next_check_at = NULL, error = $2::jsonb,
            billing = CASE WHEN billing = 'reserved' THEN 'pending_review' ELSE billing END
          WHERE id = $1 RETURNING *`, [row.id, JSON.stringify(ORPHANED)])
        await client.query(`UPDATE collect.engine_slots SET quarantine_reason = $4, quarantined_at = clock_timestamp()
          WHERE engine_id = $1 AND slot_no = $2 AND job_id = $3`, [row.engine_id, row.slot_no, row.id, ORPHANED.code])
        await this.#event(client, row.engine_id, 'slot_quarantined', { jobId: row.id, slotNo: row.slot_no, actor: 'executor', reason: ORPHANED.message,
          details: { code: ORPHANED.code } })
        unknownJobs.push(jobRow(job))
      }
      return unknownJobs
    })
  }

  // ---- reads ------------------------------------------------------------------

  async queueSnapshot(engineId) {
    const [queued, total, running, median] = await Promise.all([
      this.pool.query(`SELECT id FROM collect.jobs WHERE engine_id = $1 AND status = 'queued'
        ORDER BY queued_at, item_index, id LIMIT $2`, [engineId, QUEUE_SNAPSHOT_MAX]),
      this.pool.query(`SELECT count(*)::int AS total FROM (SELECT 1 FROM collect.jobs WHERE engine_id = $1 AND status = 'queued' LIMIT 20001) queued`, [engineId]),
      this.pool.query(`SELECT count(*)::int AS total, min(dispatched_at) AS oldest FROM collect.jobs WHERE engine_id = $1 AND status = 'running'`, [engineId]),
      this.pool.query(`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS median FROM (
          SELECT duration_ms FROM collect.jobs WHERE engine_id = $1 AND status = 'succeeded' AND duration_ms IS NOT NULL
          ORDER BY finished_at DESC LIMIT 50) recent`, [engineId]),
    ])
    return {
      queuedIds: queued.rows.map(row => row.id), queued: total.rows[0].total, truncated: total.rows[0].total > queued.rows.length,
      running: running.rows[0].total, oldestRunningAt: iso(running.rows[0].oldest),
      medianMs: median.rows[0]?.median == null ? null : Math.round(Number(median.rows[0].median)),
    }
  }

  static #select = `SELECT job.*, result.bytes AS result_bytes, result.sha256 AS result_sha256, result.item_count AS result_item_count
    FROM collect.jobs job LEFT JOIN collect.job_results result ON result.job_id = job.id`

  async get(jobId) {
    const { rows } = await this.pool.query(`${PostgresCollectStore.#select} WHERE job.id = $1`, [jobId])
    return jobRow(rows[0])
  }

  async result(jobId) {
    const { rows: [row] } = await this.pool.query('SELECT payload, bytes, sha256, item_count, created_at FROM collect.job_results WHERE job_id = $1', [jobId])
    return row ? { payload: row.payload, bytes: row.bytes, sha256: row.sha256, itemCount: row.item_count, createdAt: iso(row.created_at) } : null
  }

  async listForConsumer(consumerId, { limit, capability = null }) {
    const { rows } = await this.pool.query(`${PostgresCollectStore.#select} WHERE job.consumer_id = $1 AND ($3::text IS NULL OR job.capability = $3)
      ORDER BY job.queued_at DESC, job.item_index, job.id LIMIT $2`, [consumerId, limit, capability])
    return rows.map(jobRow)
  }

  async listRecent(engineId, limit) {
    const { rows } = await this.pool.query(`${PostgresCollectStore.#select} WHERE job.engine_id = $1
      ORDER BY job.queued_at DESC, job.item_index, job.id LIMIT $2`, [engineId, limit])
    return rows.map(jobRow)
  }

  async batch(batchId) {
    const { rows: [batch] } = await this.pool.query('SELECT * FROM collect.batches WHERE id = $1', [batchId])
    if (!batch) return null
    const { rows } = await this.pool.query(`${PostgresCollectStore.#select} WHERE job.batch_id = $1 ORDER BY job.item_index`, [batchId])
    return { batch: batchRow(batch), jobs: rows.map(jobRow) }
  }

  async cancel({ jobId, consumerId }) {
    const { rows } = await this.pool.query(`UPDATE collect.jobs SET status = 'cancelled', finished_at = clock_timestamp(),
        error = '{"code":"cancelled","message":"调用方已取消，未派发，不收费"}'::jsonb
      WHERE id = $1 AND consumer_id = $2 AND status = 'queued' RETURNING *`, [jobId, consumerId])
    return jobRow(rows[0])
  }

  // Terminal jobs older than the retention window, in bounded batches.
  // Unknown runs and anything awaiting billing review stay for an operator.
  async prune(retentionMs, limit = 5_000) {
    const { rowCount } = await this.pool.query(`DELETE FROM collect.jobs WHERE id IN (SELECT id FROM collect.jobs
      WHERE status IN ('succeeded', 'failed', 'cancelled', 'expired') AND billing <> 'pending_review'
        AND finished_at < clock_timestamp() - $1::bigint * interval '1 millisecond' LIMIT $2)`, [retentionMs, limit])
    await this.pool.query(`DELETE FROM collect.batches batch WHERE batch.created_at < clock_timestamp() - $1::bigint * interval '1 millisecond'
      AND NOT EXISTS (SELECT 1 FROM collect.jobs job WHERE job.batch_id = batch.id)`, [retentionMs])
    return rowCount
  }
}

// In-process implementation for the memory store mode and tests. Every
// method runs to completion without awaiting, which makes each call atomic.
export class MemoryCollectStore {
  constructor() {
    this.engines = new Map()
    this.slots = new Map() // `${engineId}:${slotNo}` → slot
    this.routes = new Map() // `${capability}:${routeKey}` → engineId
    this.jobs = new Map()
    this.results = new Map()
    this.batches = new Map()
    this.engineEvents = []
    this.lastQueuedAt = 0
  }

  // Strictly increasing submit times, like clock_timestamp() per row in PG.
  #stamp() {
    this.lastQueuedAt = Math.max(Date.now(), this.lastQueuedAt + 1)
    return this.lastQueuedAt
  }

  #copy(value) { return value == null ? value : structuredClone(value) }
  #now() { return Date.now() }
  #event(engineId, action, { jobId = null, slotNo = null, actor, reason, details = {} }) {
    this.engineEvents.unshift({ id: this.engineEvents.length + 1, engineId, action, revision: this.engines.get(engineId)?.revision ?? 0,
      slotNo, jobId, actor, reason, details, createdAt: new Date().toISOString() })
  }
  #engineSlots(engineId) {
    return [...this.slots.values()].filter(slot => slot.engineId === engineId).sort((a, b) => a.slotNo - b.slotNo)
  }
  #ordered(engineId, status) {
    return [...this.jobs.values()].filter(job => job.engineId === engineId && job.status === status)
      .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || (a.itemIndex ?? 0) - (b.itemIndex ?? 0) || a.id.localeCompare(b.id))
  }
  #view(job) {
    if (!job) return null
    const result = this.results.get(job.id)
    return this.#copy({ ...job, result: result ? { bytes: result.bytes, sha256: result.sha256, itemCount: result.itemCount } : null })
  }
  #routesOf(engineId) {
    return [...this.routes.entries()].filter(([, id]) => id === engineId)
      .map(([key]) => { const [capability, ...rest] = key.split(':'); return { capability, routeKey: rest.join(':') } })
      .sort((a, b) => a.capability.localeCompare(b.capability) || a.routeKey.localeCompare(b.routeKey))
  }
  #setRoutes(engineId, routes) {
    for (const route of routes) {
      const owner = this.routes.get(`${route.capability}:${route.routeKey}`)
      if (owner && owner !== engineId) throw new AppError(409, 'route_taken', '该能力（及路由）已由其他引擎承接，请先在原引擎解除')
    }
    for (const [key, id] of [...this.routes.entries()]) if (id === engineId) this.routes.delete(key)
    for (const route of routes) this.routes.set(`${route.capability}:${route.routeKey}`, engineId)
  }
  #ensureSlots(engine) {
    for (let slotNo = 1; slotNo <= engine.capacity; slotNo++) {
      const key = `${engine.id}:${slotNo}`
      if (!this.slots.has(key)) this.slots.set(key, { engineId: engine.id, slotNo, jobId: null, quarantineReason: null, quarantinedAt: null })
    }
    for (const slot of this.#engineSlots(engine.id)) if (slot.slotNo > engine.capacity && !slot.jobId) this.slots.delete(`${engine.id}:${slot.slotNo}`)
  }

  async engine(engineId) { return this.#copy(this.engines.get(engineId) || null) }
  async enginesById(ids) { return new Map(ids.filter(id => this.engines.has(id)).map(id => [id, this.#copy(this.engines.get(id))])) }

  async listEngines() {
    const since = this.#now() - 24 * 60 * 60 * 1000
    return [...this.engines.values()].sort((a, b) => a.id.localeCompare(b.id)).map(engine => {
      const slots = this.#engineSlots(engine.id)
      const recent = {}
      let cost = 0
      for (const job of this.jobs.values()) {
        if (job.engineId !== engine.id || !job.finishedAt || new Date(job.finishedAt).getTime() <= since) continue
        recent[job.status] = (recent[job.status] || 0) + 1
        if (Number.isFinite(job.cost?.usd)) cost += job.cost.usd
      }
      return { ...this.#copy(engine), stats: { busySlots: slots.filter(slot => slot.jobId && !slot.quarantineReason).length,
        quarantinedSlots: slots.filter(slot => slot.quarantineReason).length, queued: this.#ordered(engine.id, 'queued').length, recent,
        costUsd24h: Math.round(cost * 1e4) / 1e4 },
      routes: this.#routesOf(engine.id) }
    })
  }

  async engineDetail(engineId) {
    const engine = this.engines.get(engineId)
    if (!engine) return null
    return { engine: this.#copy(engine), routes: this.#routesOf(engineId), slots: this.#engineSlots(engineId).map(slot => {
      const job = slot.jobId ? this.jobs.get(slot.jobId) : null
      return { slotNo: slot.slotNo, jobId: slot.jobId, quarantineReason: slot.quarantineReason, quarantinedAt: slot.quarantinedAt,
        job: job ? { status: job.status, phase: job.phase, capability: job.capability, consumerId: job.consumerId, dispatchedAt: job.dispatchedAt, runDeadlineAt: job.runDeadlineAt } : null }
    }) }
  }

  async createEngine({ engine, routes, actor, reason }) {
    if (this.engines.has(engine.id)) throw new AppError(409, 'engine_exists', '引擎 ID 已存在')
    for (const route of routes) if (this.routes.has(`${route.capability}:${route.routeKey}`)) throw new AppError(409, 'route_taken', '该能力（及路由）已由其他引擎承接，请先在原引擎解除')
    const now = new Date().toISOString()
    const row = { quarantineReason: null, quarantinedAt: null, cooldownUntil: null, revision: 0, createdAt: now, updatedBy: actor, updateReason: reason, updatedAt: now,
      config: {}, slotRef: null, baseUrl: null, credentialProvider: null, ...structuredClone(engine) }
    this.engines.set(engine.id, row)
    this.#ensureSlots(row)
    this.#setRoutes(engine.id, routes)
    this.#event(engine.id, 'created', { actor, reason, details: { kind: engine.kind, capacity: engine.capacity, routes } })
    return this.#copy(row)
  }

  async updateEngine({ engineId, patch, routes = null, expectedRevision, actor, reason }) {
    const engine = this.engines.get(engineId)
    if (!engine) throw new AppError(404, 'engine_not_found', 'Engine not found')
    assertRevision(engine, expectedRevision)
    const changed = Object.keys(patch).filter(key => JSON.stringify(patch[key]) !== JSON.stringify(engine[key]))
    if (changed.some(key => ADDRESS_FIELDS.includes(key)) && this.#engineSlots(engineId).some(slot => slot.jobId)) {
      throw new AppError(409, 'engine_busy', '引擎有任务正在执行或等待核实，此时不能更换地址、凭据或配置')
    }
    if (routes) this.#setRoutes(engineId, routes)
    const before = Object.fromEntries(changed.map(key => [key, engine[key]]))
    Object.assign(engine, Object.fromEntries(changed.map(key => [key, structuredClone(patch[key])])),
      { revision: engine.revision + 1, updatedBy: actor, updateReason: reason, updatedAt: new Date().toISOString() })
    if (changed.includes('capacity')) this.#ensureSlots(engine)
    this.#event(engineId, 'configured', { actor, reason, details: { changed, before, after: Object.fromEntries(changed.map(key => [key, patch[key]])), ...(routes ? { routes } : {}) } })
    return this.#copy(engine)
  }

  async recoverEngine({ engineId, expectedRevision, actor, reason }) {
    const engine = this.engines.get(engineId)
    if (!engine) throw new AppError(404, 'engine_not_found', 'Engine not found')
    assertRevision(engine, expectedRevision)
    if (!engine.quarantineReason) throw new AppError(409, 'engine_not_quarantined', '引擎当前不需要恢复')
    const previous = engine.quarantineReason
    Object.assign(engine, { quarantineReason: null, quarantinedAt: null, revision: engine.revision + 1, updatedBy: actor, updateReason: reason, updatedAt: new Date().toISOString() })
    this.#event(engineId, 'recovered', { actor, reason, details: { quarantineReason: previous } })
    return this.#copy(engine)
  }

  async recoverSlot({ engineId, slotNo, expectedRevision, actor, reason }) {
    const engine = this.engines.get(engineId)
    if (!engine) throw new AppError(404, 'engine_not_found', 'Engine not found')
    assertRevision(engine, expectedRevision)
    const slot = this.slots.get(`${engineId}:${slotNo}`)
    if (!slot) throw new AppError(404, 'slot_not_found', 'Slot not found')
    if (!slot.quarantineReason) throw new AppError(409, 'slot_not_quarantined', '该执行槽当前不需要恢复')
    if (this.jobs.get(slot.jobId)?.status === 'running') throw new AppError(409, 'slot_job_running', '该执行槽上的任务仍在执行中，不能恢复')
    const previous = { jobId: slot.jobId, quarantineReason: slot.quarantineReason }
    if (slotNo > engine.capacity) this.slots.delete(`${engineId}:${slotNo}`)
    else Object.assign(slot, { jobId: null, quarantineReason: null, quarantinedAt: null })
    Object.assign(engine, { revision: engine.revision + 1, updatedBy: actor, updateReason: reason, updatedAt: new Date().toISOString() })
    this.#event(engineId, 'slot_recovered', { slotNo, jobId: previous.jobId, actor, reason, details: { quarantineReason: previous.quarantineReason } })
    return this.#copy(engine)
  }

  async recordEvent(engineId, action, { actor, reason, details = {} }) {
    if (this.engines.has(engineId)) this.#event(engineId, action, { actor, reason, details })
  }

  async events(engineId, limit = 30) {
    return this.engineEvents.filter(event => event.engineId === engineId).slice(0, limit).map(event => this.#copy(event))
  }

  async submit({ owner, kind, idempotencyKey, fingerprint, capability, items }) {
    if (kind === 'batch') {
      const batch = [...this.batches.values()].find(row => row.consumerId === owner.consumerId && row.idempotencyKey === idempotencyKey)
      if (batch) {
        if (batch.fingerprint !== fingerprint) throw conflict()
        return { replay: true, batch: this.#copy(batch), jobs: [...this.jobs.values()].filter(job => job.batchId === batch.id)
          .sort((a, b) => a.itemIndex - b.itemIndex).map(job => this.#view(job)) }
      }
    } else {
      const existing = [...this.jobs.values()].find(job => !job.batchId && job.consumerId === owner.consumerId && job.idempotencyKey === idempotencyKey)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw conflict()
        return { replay: true, batch: null, jobs: [this.#view(existing)] }
      }
    }
    const byRoute = new Map()
    for (const key of new Set(items.map(item => item.routeKey))) {
      const engine = this.engines.get(this.routes.get(`${capability}:${key}`))
      assertAccepting(engine, capability, key)
      byRoute.set(key, engine)
    }
    const perEngine = new Map()
    for (const item of items) {
      const engine = byRoute.get(item.routeKey)
      perEngine.set(engine.id, { engine, count: (perEngine.get(engine.id)?.count || 0) + 1 })
    }
    for (const { engine, count } of perEngine.values()) {
      const open = [...this.jobs.values()].filter(job => job.engineId === engine.id && ['queued', 'running'].includes(job.status))
      assertCapacity(engine, { queued: open.filter(job => job.status === 'queued').length,
        mine: open.filter(job => job.consumerId === owner.consumerId).length }, count)
    }
    const now = this.#now()
    const batch = kind === 'batch' ? { id: randomUUID(), capability, consumerId: owner.consumerId, idempotencyKey, fingerprint,
      itemCount: items.length, createdAt: new Date(now).toISOString() } : null
    if (batch) this.batches.set(batch.id, batch)
    const jobs = items.map((item, index) => {
      const engine = byRoute.get(item.routeKey)
      const job = { id: randomUUID(), engineId: engine.id, capability, routeKey: item.routeKey, batchId: batch?.id || null,
        itemIndex: batch ? index : null, clientRef: item.clientRef, tenantId: owner.tenantId, consumerId: owner.consumerId,
        apiKeyId: owner.apiKeyId, idempotencyKey: batch ? null : idempotencyKey, fingerprint: item.fingerprint,
        input: structuredClone(item.input), status: 'queued', phase: null, dataStatus: null, slotNo: null, owner: null,
        leaseUntil: null, nextCheckAt: null, checks: 0, upstreamRef: null, upstreamState: null, billing: 'none', usageRequestId: null,
        engineRevision: null, baseUrl: null, queuedAt: new Date(this.#stamp()).toISOString(), deadlineAt: new Date(now + engine.queueWaitMs).toISOString(),
        dispatchedAt: null, runDeadlineAt: null, finishedAt: null, durationMs: null, httpStatus: null, error: null, cost: null, lateEvidence: null }
      this.jobs.set(job.id, job)
      return this.#view(job)
    })
    return { replay: false, batch: this.#copy(batch), jobs }
  }

  async readiness() {
    const now = this.#now()
    const engines = []
    for (const engine of this.engines.values()) {
      if (!engine.enabled || engine.quarantineReason || (engine.cooldownUntil && new Date(engine.cooldownUntil).getTime() > now)) continue
      const free = this.#engineSlots(engine.id).filter(slot => slot.slotNo <= engine.capacity && !slot.jobId && !slot.quarantineReason).length
      const queued = this.#ordered(engine.id, 'queued').some(job => new Date(job.deadlineAt).getTime() > now)
      if (free > 0 && queued) engines.push({ id: engine.id, kind: engine.kind, free })
    }
    const jobs = [...this.jobs.values()]
    return {
      engines,
      checks: jobs.some(job => job.phase === 'waiting' && new Date(job.nextCheckAt).getTime() <= now),
      orphans: jobs.some(job => job.phase === 'dispatching' && new Date(job.leaseUntil).getTime() <= now),
      expired: jobs.some(job => job.status === 'queued' && new Date(job.deadlineAt).getTime() <= now),
    }
  }

  async claim({ engineId, owner, dispatchLeaseMs = null, leaseGraceMs }) {
    const engine = this.engines.get(engineId)
    const now = this.#now()
    if (!engine || !engine.enabled || engine.quarantineReason || (engine.cooldownUntil && new Date(engine.cooldownUntil).getTime() > now)) return { job: null }
    const slot = this.#engineSlots(engineId).find(row => row.slotNo <= engine.capacity && !row.jobId && !row.quarantineReason)
    if (!slot) return { job: null }
    const next = this.#ordered(engineId, 'queued').find(job => new Date(job.deadlineAt).getTime() > now)
    if (!next) return { job: null }
    const leaseMs = dispatchLeaseMs ?? engine.runTimeoutMs + leaseGraceMs
    Object.assign(next, { status: 'running', phase: 'dispatching', slotNo: slot.slotNo, owner, dispatchedAt: new Date(now).toISOString(),
      runDeadlineAt: new Date(now + engine.runTimeoutMs).toISOString(), leaseUntil: new Date(now + leaseMs).toISOString(),
      engineRevision: engine.revision, baseUrl: engine.baseUrl })
    slot.jobId = next.id
    return { job: this.#view(next), engine: this.#copy(engine) }
  }

  async claimJob({ jobId, owner, dispatchLeaseMs = null, leaseGraceMs }) {
    const target = this.jobs.get(jobId)
    if (!target) return { job: null, reason: 'missing' }
    const engine = this.engines.get(target.engineId)
    const now = this.#now()
    if (!engine || !engine.enabled || engine.quarantineReason || (engine.cooldownUntil && new Date(engine.cooldownUntil).getTime() > now)) return { job: null, reason: 'engine_not_ready' }
    const slot = this.#engineSlots(engine.id).find(row => row.slotNo <= engine.capacity && !row.jobId && !row.quarantineReason)
    if (!slot) return { job: null, reason: 'no_free_slot' }
    if (target.status !== 'queued' || new Date(target.deadlineAt).getTime() <= now) return { job: null, reason: 'not_queued' }
    const leaseMs = dispatchLeaseMs ?? engine.runTimeoutMs + leaseGraceMs
    Object.assign(target, { status: 'running', phase: 'dispatching', slotNo: slot.slotNo, owner, dispatchedAt: new Date(now).toISOString(),
      runDeadlineAt: new Date(now + engine.runTimeoutMs).toISOString(), leaseUntil: new Date(now + leaseMs).toISOString(),
      engineRevision: engine.revision, baseUrl: engine.baseUrl })
    slot.jobId = target.id
    return { job: this.#view(target), engine: this.#copy(engine) }
  }

  async markReserved({ jobId, owner, usageRequestId }) {
    const job = this.jobs.get(jobId)
    if (!job || job.owner !== owner || job.status !== 'running') return false
    Object.assign(job, { usageRequestId, billing: 'reserved' })
    return true
  }

  async markWaiting({ jobId, owner, upstreamRef, upstreamState, nextCheckMs, leaseGraceMs }) {
    const job = this.jobs.get(jobId)
    if (!job || job.owner !== owner || job.phase !== 'dispatching') return null
    Object.assign(job, { phase: 'waiting', upstreamRef, upstreamState: structuredClone(upstreamState ?? null),
      nextCheckAt: new Date(this.#now() + nextCheckMs).toISOString(), leaseUntil: new Date(new Date(job.runDeadlineAt).getTime() + leaseGraceMs).toISOString() })
    return this.#view(job)
  }

  async claimChecks({ owner, limit, checkLeaseMs }) {
    const now = this.#now()
    const due = [...this.jobs.values()].filter(job => job.phase === 'waiting' && new Date(job.nextCheckAt).getTime() <= now)
      .sort((a, b) => a.nextCheckAt.localeCompare(b.nextCheckAt)).slice(0, limit)
    for (const job of due) Object.assign(job, { owner, checks: job.checks + 1, nextCheckAt: new Date(now + checkLeaseMs).toISOString() })
    return due.map(job => this.#view(job))
  }

  async updateWaiting({ jobId, owner, upstreamState = null, nextCheckMs }) {
    const job = this.jobs.get(jobId)
    if (!job || job.owner !== owner || job.phase !== 'waiting') return false
    if (upstreamState != null) job.upstreamState = structuredClone(upstreamState)
    job.nextCheckAt = new Date(this.#now() + nextCheckMs).toISOString()
    return true
  }

  async finish({ jobId, owner, outcome, httpStatus = null, durationMs = null, billing }) {
    const job = this.jobs.get(jobId)
    if (!job || job.owner !== owner || job.status !== 'running') {
      if (job) job.lateEvidence = lateEvidence(owner, outcome, httpStatus)
      return { fenced: true, job: null }
    }
    const record = resultRecord(outcome)
    Object.assign(job, { status: outcome.status, phase: null, dataStatus: outcome.dataStatus || null, error: outcome.error || null, httpStatus,
      durationMs, billing, cost: outcome.cost || null, finishedAt: new Date().toISOString(), leaseUntil: null, nextCheckAt: null })
    if (record) this.results.set(jobId, { payload: JSON.parse(record.text), bytes: record.bytes, sha256: record.sha256, itemCount: record.itemCount, createdAt: job.finishedAt })
    const engine = this.engines.get(job.engineId)
    const slotKey = `${job.engineId}:${job.slotNo}`
    const slot = this.slots.get(slotKey)
    if (outcome.quarantine) {
      if (slot?.jobId === jobId) Object.assign(slot, { quarantineReason: outcome.error?.code || 'unknown', quarantinedAt: new Date().toISOString() })
      this.#event(job.engineId, 'slot_quarantined', { jobId, slotNo: job.slotNo, actor: 'executor', reason: outcome.error?.message || '结果未知', details: { code: outcome.error?.code || null } })
      if (outcome.quarantine === 'engine' && !engine.quarantineReason) {
        Object.assign(engine, { quarantineReason: outcome.error?.code || 'unknown', quarantinedAt: new Date().toISOString() })
        this.#event(job.engineId, 'quarantined', { jobId, actor: 'executor', reason: outcome.error?.message || '结果未知' })
      }
    } else if (slot?.jobId === jobId) {
      slot.jobId = null
      if (slot.slotNo > engine.capacity) this.slots.delete(slotKey)
    }
    if (outcome.cooldownUntil) {
      const until = Math.max(new Date(outcome.cooldownUntil).getTime(), engine.cooldownUntil ? new Date(engine.cooldownUntil).getTime() : 0)
      engine.cooldownUntil = new Date(until).toISOString()
      this.#event(job.engineId, 'cooldown', { jobId, actor: 'executor', reason: outcome.error?.message || '上游要求冷却', details: { until: engine.cooldownUntil } })
    }
    if (outcome.paceUntil) {
      const until = Math.max(new Date(outcome.paceUntil).getTime(), engine.cooldownUntil ? new Date(engine.cooldownUntil).getTime() : 0)
      engine.cooldownUntil = new Date(until).toISOString()
    }
    return { fenced: false, job: this.#view(job) }
  }

  async setBilling(jobId, billing) {
    const job = this.jobs.get(jobId)
    if (job) job.billing = billing
  }

  async expireQueued(limit = 1_000) {
    const now = this.#now()
    let expired = 0
    for (const job of this.jobs.values()) {
      if (expired >= limit) break
      if (job.status !== 'queued' || new Date(job.deadlineAt).getTime() > now) continue
      Object.assign(job, { status: 'expired', finishedAt: new Date(now).toISOString(), error: EXPIRED })
      expired++
    }
    return expired
  }

  async reapOrphans({ reconcilableKinds, readOnlyKinds = [], leaseGraceMs, limit = 100 }) {
    const now = this.#now()
    const stale = [...this.jobs.values()].filter(job => job.phase === 'dispatching' && new Date(job.leaseUntil).getTime() <= now).slice(0, limit)
    const unknownJobs = []
    for (const job of stale) {
      const engine = this.engines.get(job.engineId)
      if (reconcilableKinds.includes(engine.kind)) {
        Object.assign(job, { phase: 'waiting', owner: 'reaper', upstreamRef: job.upstreamRef || job.id, upstreamState: job.upstreamState || { confirmed: false },
          nextCheckAt: new Date(now).toISOString(), leaseUntil: new Date(Math.max(new Date(job.runDeadlineAt).getTime(), now) + leaseGraceMs).toISOString() })
        this.#event(job.engineId, 'reconcile', { jobId: job.id, slotNo: job.slotNo, actor: 'executor', reason: '派发进程失联，改为向上游核对' })
        continue
      }
      if (readOnlyKinds.includes(engine.kind)) {
        Object.assign(job, { status: 'failed', phase: null, finishedAt: new Date(now).toISOString(), leaseUntil: null, nextCheckAt: null, error: READ_LOST,
          billing: job.billing === 'reserved' ? 'pending_review' : job.billing })
        const slot = this.slots.get(`${job.engineId}:${job.slotNo}`)
        if (slot?.jobId === job.id) slot.jobId = null
        continue
      }
      Object.assign(job, { status: 'unknown', phase: null, dataStatus: 'unknown', finishedAt: new Date(now).toISOString(), leaseUntil: null, nextCheckAt: null,
        error: ORPHANED, billing: job.billing === 'reserved' ? 'pending_review' : job.billing })
      const slot = this.slots.get(`${job.engineId}:${job.slotNo}`)
      if (slot?.jobId === job.id) Object.assign(slot, { quarantineReason: ORPHANED.code, quarantinedAt: new Date(now).toISOString() })
      this.#event(job.engineId, 'slot_quarantined', { jobId: job.id, slotNo: job.slotNo, actor: 'executor', reason: ORPHANED.message, details: { code: ORPHANED.code } })
      unknownJobs.push(this.#view(job))
    }
    return unknownJobs
  }

  async queueSnapshot(engineId) {
    const queued = this.#ordered(engineId, 'queued')
    const running = this.#ordered(engineId, 'running')
    const recent = [...this.jobs.values()].filter(job => job.engineId === engineId && job.status === 'succeeded' && job.durationMs != null)
      .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt)).slice(0, 50).map(job => job.durationMs).sort((a, b) => a - b)
    const middle = recent.length >> 1
    return {
      queuedIds: queued.slice(0, QUEUE_SNAPSHOT_MAX).map(job => job.id), queued: queued.length, truncated: queued.length > QUEUE_SNAPSHOT_MAX,
      running: running.length, oldestRunningAt: running.map(job => job.dispatchedAt).sort()[0] || null,
      medianMs: !recent.length ? null : recent.length % 2 ? recent[middle] : Math.round((recent[middle - 1] + recent[middle]) / 2),
    }
  }

  async get(jobId) { return this.#view(this.jobs.get(jobId) || null) }

  async result(jobId) {
    const row = this.results.get(jobId)
    return row ? this.#copy(row) : null
  }

  async listForConsumer(consumerId, { limit, capability = null }) {
    return [...this.jobs.values()].filter(job => job.consumerId === consumerId && (!capability || job.capability === capability))
      .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt) || (a.itemIndex ?? 0) - (b.itemIndex ?? 0)).slice(0, limit).map(job => this.#view(job))
  }

  async listRecent(engineId, limit) {
    return [...this.jobs.values()].filter(job => job.engineId === engineId)
      .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt) || (a.itemIndex ?? 0) - (b.itemIndex ?? 0)).slice(0, limit).map(job => this.#view(job))
  }

  async batch(batchId) {
    const batch = this.batches.get(batchId)
    if (!batch) return null
    return { batch: this.#copy(batch), jobs: [...this.jobs.values()].filter(job => job.batchId === batchId)
      .sort((a, b) => a.itemIndex - b.itemIndex).map(job => this.#view(job)) }
  }

  async cancel({ jobId, consumerId }) {
    const job = this.jobs.get(jobId)
    if (!job || job.consumerId !== consumerId || job.status !== 'queued') return null
    Object.assign(job, { status: 'cancelled', finishedAt: new Date().toISOString(), error: { code: 'cancelled', message: '调用方已取消，未派发，不收费' } })
    return this.#view(job)
  }

  async prune(retentionMs, limit = 5_000) {
    const cutoff = this.#now() - retentionMs
    let removed = 0
    for (const job of [...this.jobs.values()]) {
      if (removed >= limit) break
      if (['succeeded', 'failed', 'cancelled', 'expired'].includes(job.status) && job.billing !== 'pending_review'
        && job.finishedAt && new Date(job.finishedAt).getTime() < cutoff) {
        this.jobs.delete(job.id); this.results.delete(job.id); removed++
      }
    }
    for (const batch of [...this.batches.values()]) {
      if (new Date(batch.createdAt).getTime() < cutoff && ![...this.jobs.values()].some(job => job.batchId === batch.id)) this.batches.delete(batch.id)
    }
    return removed
  }
}

export function createCollectStore(pool) {
  return pool ? new PostgresCollectStore(pool) : new MemoryCollectStore()
}
