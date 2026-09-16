import { AppError } from './core/errors.mjs'

const RULES = Object.freeze({
  upstream_balance_exhausted: { category: 'upstream.balance', severity: 'critical', title: 'JustOne 账户余额不足' },
  upstream_token_limit_exceeded: { category: 'upstream.token_limit', severity: 'warning', title: 'JustOne Token 消费限额已达到' },
})
const STATUSES = ['active', 'open', 'acknowledged', 'closed', 'all']
const PAGE_SIZE = 50

export function notificationQuery(query = {}) {
  if (Object.keys(query).some((key) => !['status', 'category', 'before'].includes(key))) {
    throw new AppError(400, 'unsupported_fields', 'Unsupported notification filter')
  }
  const status = query.status || 'active'
  const category = query.category || 'all'
  const before = query.before || null
  if (!STATUSES.includes(status) || !['all', ...Object.values(RULES).map((rule) => rule.category)].includes(category)
      || (before !== null && !/^[1-9]\d{0,17}$/.test(before))) {
    throw new AppError(400, 'invalid_notification_filter', 'Invalid notification filter')
  }
  return { status, category, before }
}

export function notificationAction(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => !['action', 'reason'].includes(key))
      || !['acknowledge', 'close'].includes(body.action)
      || typeof body.reason !== 'string' || !body.reason.trim() || body.reason.trim().length > 1000) {
    throw new AppError(400, 'invalid_notification_action', 'Choose acknowledge/close and provide a reason (1–1000 characters)')
  }
  return { action: body.action, reason: body.reason.trim() }
}

function validId(id) {
  if (!/^[1-9]\d{0,17}$/.test(String(id))) throw new AppError(400, 'invalid_notification_id', 'Invalid notification ID')
  return String(id)
}

export class NotificationService {
  constructor(pool, { logger = console } = {}) {
    this.pool = pool
    this.logger = logger
    this.collection = { state: pool ? 'pending' : 'unavailable', lastSuccessAt: null, lastErrorAt: null }
    this.running = null
    this.timer = null
  }

  async transaction(operation) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL statement_timeout = '5s'")
      await client.query("SET LOCAL lock_timeout = '2s'")
      const result = await operation(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally { client.release() }
  }

  // Only already-completed ledger records are read. A unique source event ID
  // provides durable deduplication across restarts, replicas and late commits.
  async collectBatch() {
    return this.transaction(async (client) => {
      const lock = await client.query('SELECT pg_try_advisory_xact_lock(129761, 85) AS acquired')
      if (!lock.rows[0].acquired) return false
      const calls = await client.query(`
        SELECT c.id, c.usage_request_id, c.provider_credential_revision,
               c.marketplace, c.error_code, c.completed_at
        FROM external_platform.provider_calls c
        WHERE c.provider_key = 'justone' AND c.started_at >= now() - interval '7 days'
          AND c.completed_at IS NOT NULL
          AND c.error_code IN ('upstream_balance_exhausted', 'upstream_token_limit_exceeded')
          AND NOT EXISTS (SELECT 1 FROM notifications.events e WHERE e.source_event_id = c.id)
        ORDER BY c.completed_at, c.id LIMIT 100`)
      for (const call of calls.rows) {
        const rule = RULES[call.error_code]
        const scope = `credential:${call.provider_credential_revision ?? 'unknown'}`
        const result = await client.query(`
          INSERT INTO notifications.incidents
            (category, severity, source, source_scope, code, title,
             first_occurred_at, last_occurred_at, latest_request_id)
          VALUES ($1, $2, 'justone', $3, $4, $5, $6, $6, $7)
          ON CONFLICT (source, source_scope, code) WHERE status <> 'closed'
          DO UPDATE SET occurrence_count = notifications.incidents.occurrence_count + 1,
            first_occurred_at = LEAST(notifications.incidents.first_occurred_at, EXCLUDED.first_occurred_at),
            last_occurred_at = GREATEST(notifications.incidents.last_occurred_at, EXCLUDED.last_occurred_at),
            latest_request_id = CASE WHEN EXCLUDED.last_occurred_at >= notifications.incidents.last_occurred_at
              THEN EXCLUDED.latest_request_id ELSE notifications.incidents.latest_request_id END,
            updated_at = now()
          RETURNING id`, [rule.category, rule.severity, scope, call.error_code, rule.title,
          call.completed_at, call.usage_request_id])
        await client.query(`INSERT INTO notifications.events
          (incident_id, kind, actor, source_event_id, request_id, marketplace, credential_revision, occurred_at)
          VALUES ($1, 'observed', 'collector:justone', $2, $3, $4, $5, $6)`, [
          result.rows[0].id, call.id, call.usage_request_id, call.marketplace,
          call.provider_credential_revision, call.completed_at,
        ])
      }
      return true
    })
  }

  collect() {
    if (!this.pool) return Promise.resolve()
    if (this.running) return this.running
    this.running = this.collectBatch().then((collected) => {
      if (collected) this.collection = { ...this.collection, state: 'ready', lastSuccessAt: new Date().toISOString() }
    }).catch(() => {
      this.collection = { ...this.collection, state: 'error', lastErrorAt: new Date().toISOString() }
      this.logger.warn('[notifications] Ledger collection failed; existing notifications remain available')
    }).finally(() => { this.running = null })
    return this.running
  }

  start() {
    if (!this.pool || this.timer) return
    void this.collect()
    this.timer = setInterval(() => { void this.collect() }, 30_000)
    this.timer.unref?.()
  }

  async close() { clearInterval(this.timer); this.timer = null; await this.running }

  async list(query) {
    const { status, category, before } = notificationQuery(query)
    if (!this.pool) return { available: false, items: [], counts: [], collection: this.collection }
    const [result, counts] = await Promise.all([
      this.pool.query(`SELECT * FROM notifications.incidents
        WHERE ($1 = 'all' OR ($1 = 'active' AND status <> 'closed') OR status = $1)
          AND ($2 = 'all' OR category = $2) AND ($3::bigint IS NULL OR id < $3)
        ORDER BY id DESC LIMIT 51`, [status, category, before]),
      this.pool.query('SELECT category, status, count(*)::integer AS count FROM notifications.incidents GROUP BY category, status'),
    ])
    const items = result.rows.slice(0, PAGE_SIZE)
    return { available: true, items, counts: counts.rows, collection: this.collection,
      nextBefore: result.rows.length > PAGE_SIZE ? items.at(-1).id : null }
  }

  async detail(id, before = null) {
    validId(id)
    if (before !== null) validId(before)
    if (!this.pool) throw new AppError(503, 'notifications_unavailable', 'Notifications require PostgreSQL')
    const incident = await this.pool.query('SELECT * FROM notifications.incidents WHERE id = $1', [id])
    if (!incident.rows[0]) throw new AppError(404, 'notification_not_found', 'Notification not found')
    const result = await this.pool.query(`SELECT * FROM notifications.events
      WHERE incident_id = $1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT 51`, [id, before])
    const events = result.rows.slice(0, PAGE_SIZE)
    return { incident: incident.rows[0], events,
      nextBefore: result.rows.length > PAGE_SIZE ? events.at(-1).id : null }
  }

  async act(id, body) {
    validId(id)
    const { action, reason } = notificationAction(body)
    if (!this.pool) throw new AppError(503, 'notifications_unavailable', 'Notifications require PostgreSQL')
    return this.transaction(async (client) => {
      const result = await client.query('SELECT * FROM notifications.incidents WHERE id = $1 FOR UPDATE', [id])
      const incident = result.rows[0]
      if (!incident) throw new AppError(404, 'notification_not_found', 'Notification not found')
      const status = action === 'close' ? 'closed' : 'acknowledged'
      // Retrying a completed action does not append duplicate audit records.
      if (incident.status === status) return incident
      if (incident.status === 'closed') throw new AppError(409, 'notification_closed', 'Notification is already closed')
      const updated = await client.query('UPDATE notifications.incidents SET status = $2, updated_at = now() WHERE id = $1 RETURNING *', [id, status])
      await client.query(`INSERT INTO notifications.events (incident_id, kind, actor, note, occurred_at)
        VALUES ($1, $2, 'admin-token', $3, now())`, [id, status, reason])
      return updated.rows[0]
    })
  }
}
