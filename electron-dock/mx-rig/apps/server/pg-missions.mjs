import { randomUUID } from 'node:crypto'
import { RigError, TERMINAL } from '../../packages/contracts/index.mjs'
import { syncedRecord } from '../../packages/runtime/store.mjs'

const LIVE = ['queued', 'running']
const OPEN = ['queued', 'running', 'awaiting_approval']
const MAX_PER_OWNER = 500
const LIST_LIMIT = 200

/**
 * Missions in PostgreSQL, shared by every replica of the service.
 *
 * Same contract as the file-backed MissionStore the desktop keeps, plus the
 * few operations that only mean something when more than one process can see a
 * mission:
 *
 * - One writer. The process executing a mission (`holder`) is the only one
 *   that rewrites its record. Anyone else who wants it stopped sets
 *   `cancel_requested_at`, and the holder notices on its next save or
 *   heartbeat and stops itself — so there is never a merge of two versions.
 * - Approval is a compare-and-set on the pending approval id, so the same
 *   approval clicked on two replicas executes once.
 * - A holder that stops heartbeating is presumed gone. Its queued/running
 *   missions are closed as blocked: whatever it was doing may or may not have
 *   happened, and replaying it would be a guess. A mission paused for approval
 *   has nothing in flight and nothing held in memory — its checkpoint is in the
 *   row — so it stays approvable from any replica.
 */
export class PgMissionStore {
  constructor(pool, { instance = randomUUID(), staleAfterMs = 90_000 } = {}) {
    this.pool = pool
    this.instance = instance
    this.staleAfterMs = staleAfterMs
    // Rows this process is executing, by id. `get` hands back the same object
    // the runtime is mutating, so a cancel on this replica sees the live state.
    this.live = new Map()
    // Saves for one mission are applied in the order they were made; a late
    // streaming snapshot must never land on top of a newer full record.
    this.queues = new Map()
  }
  get shared() {
    return true
  }
  async init() {
    await this.sweep()
    return this
  }

  async list(owner) {
    const { rows } = await this.pool.query(
      `SELECT doc FROM rig_missions WHERE owner = $1 ORDER BY created_at DESC LIMIT ${LIST_LIMIT}`,
      [owner]
    )
    return rows.map(({ doc }) => this.public(this.live.get(doc.id) ?? doc))
  }
  /** Every mission, newest first, for reports. Never includes transcripts. */
  async recent({ limit = LIST_LIMIT, since = null } = {}) {
    const { rows } = await this.pool.query(
      `SELECT doc FROM rig_missions
       WHERE ($1::timestamptz IS NULL OR created_at >= $1)
       ORDER BY created_at DESC LIMIT $2`,
      [since, limit]
    )
    return rows.map(({ doc }) => this.public(doc))
  }
  async get(id, owner) {
    const live = this.live.get(id)
    if (live) {
      if (live.owner !== owner) throw new RigError('not_found', '任务不存在', 404)
      return live
    }
    const { rows } = await this.pool.query('SELECT doc FROM rig_missions WHERE id = $1', [id])
    const doc = rows[0]?.doc
    if (!doc || doc.owner !== owner) throw new RigError('not_found', '任务不存在', 404)
    return doc
  }
  public(row) {
    const { messages, graph, evidence, skippedCalls, crew, ...visible } = row
    return structuredClone(visible)
  }

  /**
   * One mission at a time per member on the service, across replicas. A
   * single runtime already enforces this in memory; the database is what makes
   * it hold when the next request lands on another replica.
   */
  async assertIdle(owner) {
    const { rows } = await this.pool.query(
      `SELECT id FROM rig_missions
       WHERE owner = $1 AND surface = 'internal' AND status = ANY($2) LIMIT 1`,
      [owner, OPEN]
    )
    if (rows[0]) throw new RigError('busy', '已有任务运行或等待确认，请先完成或取消', 409)
  }

  async create(owner, input) {
    const { rows } = await this.pool.query(
      'SELECT count(*)::int AS count FROM rig_missions WHERE owner = $1',
      [owner]
    )
    if (rows[0].count >= MAX_PER_OWNER)
      throw new RigError('capacity', `已达到 ${MAX_PER_OWNER} 项任务上限，请联系管理员归档`, 409)
    const row = {
      id: randomUUID(),
      owner,
      goal: input.goal,
      mode: input.mode,
      agentKey: input.agentKey ?? null,
      orchestrationKey: input.orchestrationKey ?? null,
      inputs: input.inputs ?? null,
      status: 'queued',
      createdAt: new Date().toISOString(),
      events: [],
      messages: [],
      pending: null,
      result: null,
      policyRevision: null,
      trace: [],
      evidence: [],
      graph: null
    }
    await this.pool.query(
      `INSERT INTO rig_missions (id, owner, surface, mode, status, doc, holder, heartbeat_at, created_at)
       VALUES ($1, $2, 'internal', $3, $4, $5::jsonb, $6, now(), $7)`,
      [row.id, owner, row.mode, row.status, JSON.stringify(row), this.instance, row.createdAt]
    )
    this.live.set(row.id, row)
    return row
  }

  #enqueue(id, work) {
    const previous = this.queues.get(id) ?? Promise.resolve()
    const next = previous.then(work)
    const settled = next.catch(() => {})
    this.queues.set(id, settled)
    settled.then(() => {
      if (this.queues.get(id) === settled) this.queues.delete(id)
    })
    return next
  }

  /**
   * Write the whole record. Reports back whether someone asked elsewhere for
   * this mission to stop; acting on that is the runtime's job, because only it
   * can abort what is in flight.
   */
  save(row) {
    row.updatedAt = new Date().toISOString()
    const doc = JSON.stringify(row)
    const status = row.status
    const live = LIVE.includes(status)
    if (live) this.live.set(row.id, row)
    else this.live.delete(row.id)
    return this.#enqueue(row.id, async () => {
      const { rows } = await this.pool.query(
        `UPDATE rig_missions SET
           doc = $2::jsonb,
           status = $3,
           mode = $4,
           holder = CASE WHEN $5 THEN $6 ELSE NULL END,
           heartbeat_at = CASE WHEN $5 THEN now() ELSE heartbeat_at END,
           cancel_requested_at = CASE WHEN $3 = ANY($7) THEN NULL ELSE cancel_requested_at END,
           updated_at = now()
         WHERE id = $1
         RETURNING cancel_requested_at`,
        [row.id, doc, status, row.mode, live, this.instance, [...TERMINAL]]
      )
      return { cancelRequested: Boolean(rows[0]?.cancel_requested_at) }
    })
  }

  /**
   * Store what a desktop reported. An id that belongs to a server mission or
   * to another member is left alone, and an older snapshot never replaces a
   * newer one.
   */
  async syncDesktop(owner, rows) {
    let stored = 0
    for (const input of rows) {
      const row = syncedRecord(owner, input)
      const { rowCount } = await this.pool.query(
        `INSERT INTO rig_missions (id, owner, surface, mode, status, doc, created_at)
         VALUES ($1, $2, 'desktop', $3, $4, $5::jsonb, $6)
         ON CONFLICT (id) DO UPDATE SET
           doc = EXCLUDED.doc, status = EXCLUDED.status, mode = EXCLUDED.mode, updated_at = now()
         WHERE rig_missions.surface = 'desktop' AND rig_missions.owner = EXCLUDED.owner
           AND coalesce(rig_missions.doc->>'updatedAt', '') <= coalesce(EXCLUDED.doc->>'updatedAt', '')`,
        [row.id, owner, row.mode, row.status, JSON.stringify(row), row.createdAt]
      )
      stored += rowCount
    }
    return stored
  }

  /** Partial text while a model answers: only the draft changes. */
  saveStream(row) {
    const stream = JSON.stringify(row.stream ?? null)
    return this.#enqueue(row.id, async () => {
      await this.pool.query(
        `UPDATE rig_missions SET doc = jsonb_set(doc, '{stream}', $2::jsonb), heartbeat_at = now()
         WHERE id = $1 AND holder = $3`,
        [row.id, stream, this.instance]
      )
    })
  }

  /**
   * Take an approval, once. `row` already carries the resumed state; it is
   * written only if the mission is still waiting on exactly this approval.
   */
  async claimApproval(row, approvalId) {
    const { rowCount } = await this.pool.query(
      `UPDATE rig_missions SET
         doc = $3::jsonb, status = $4, holder = $5, heartbeat_at = now(),
         cancel_requested_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'awaiting_approval' AND doc->'pending'->>'approvalId' = $2`,
      [row.id, approvalId, JSON.stringify(row), row.status, this.instance]
    )
    if (rowCount !== 1) return false
    this.live.set(row.id, row)
    return true
  }

  /**
   * Stop a mission this process is not executing.
   *
   * Paused for approval: nothing is in flight, so it is closed here and now.
   * Running on a live holder: the holder is asked, and stops itself.
   * Running on a holder that stopped heartbeating: there is no one to ask, so
   * it is closed here — as cancelled, with the same caveat a restart gives.
   */
  async requestCancel(row, message) {
    const at = new Date().toISOString()
    if (row.status === 'awaiting_approval') {
      const closed = {
        ...row,
        status: 'cancelled',
        pending: null,
        stream: null,
        events: [...row.events, { at, kind: 'cancelled', message }]
      }
      const { rowCount } = await this.pool.query(
        `UPDATE rig_missions SET doc = $2::jsonb, status = 'cancelled', holder = NULL,
           cancel_requested_at = NULL, updated_at = now()
         WHERE id = $1 AND status = 'awaiting_approval'`,
        [row.id, JSON.stringify(closed)]
      )
      if (rowCount === 1) return closed
      return this.requestCancel(await this.get(row.id, row.owner), message)
    }
    if (!LIVE.includes(row.status)) return row
    const orphaned = {
      ...row,
      status: 'cancelled',
      pending: null,
      stream: null,
      events: [
        ...row.events,
        {
          at,
          kind: 'cancelled',
          message: `${message}执行这项任务的服务实例已失去心跳，外部动作结果可能未知，请核验。`
        }
      ]
    }
    const stale = await this.pool.query(
      `UPDATE rig_missions SET doc = $2::jsonb, status = 'cancelled', holder = NULL,
         cancel_requested_at = NULL, updated_at = now()
       WHERE id = $1 AND status = ANY($3)
         AND (heartbeat_at IS NULL OR heartbeat_at < now() - ($4::text || ' milliseconds')::interval)`,
      [row.id, JSON.stringify(orphaned), LIVE, String(this.staleAfterMs)]
    )
    if (stale.rowCount === 1) return orphaned
    await this.pool.query(
      `UPDATE rig_missions SET cancel_requested_at = coalesce(cancel_requested_at, now())
       WHERE id = $1 AND status = ANY($2)`,
      [row.id, LIVE]
    )
    return { ...row, cancelRequested: true }
  }

  /**
   * Keep this process's claim on what it is executing, and learn which of
   * those missions someone asked to stop.
   */
  async heartbeat() {
    const { rows } = await this.pool.query(
      `UPDATE rig_missions SET heartbeat_at = now()
       WHERE holder = $1 AND status = ANY($2)
       RETURNING id, cancel_requested_at IS NOT NULL AS cancel`,
      [this.instance, LIVE]
    )
    return rows.filter((row) => row.cancel).map((row) => row.id)
  }

  /** Close missions whose holder is gone. Safe to run from every replica. */
  async sweep() {
    const event = {
      at: new Date().toISOString(),
      kind: 'interrupted',
      message:
        '执行这项任务的服务实例已停止；外部动作结果可能未知，请核验后创建新任务，不自动重放。'
    }
    const { rows } = await this.pool.query(
      `UPDATE rig_missions SET
         status = 'blocked',
         holder = NULL,
         cancel_requested_at = NULL,
         updated_at = now(),
         doc = doc || jsonb_build_object(
           'status', 'blocked', 'pending', null, 'stream', null, 'graph', null,
           'events', coalesce(doc->'events', '[]'::jsonb) || jsonb_build_array($2::jsonb))
       WHERE status = ANY($1) AND surface = 'internal'
         AND (heartbeat_at IS NULL OR heartbeat_at < now() - ($3::text || ' milliseconds')::interval)
       RETURNING id`,
      [LIVE, JSON.stringify(event), String(this.staleAfterMs)]
    )
    for (const { id } of rows) this.live.delete(id)
    return rows.map((row) => row.id)
  }
}
