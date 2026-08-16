import { randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { ensureSearchIndices } from './index.mjs'
import { requiredReindexBackend, requireSegmenterBackend } from './reindex-integrity.mjs'
import {
  monitorSearchReindexLock,
  tryAcquireSearchReindexLock,
} from './reindex-lock.mjs'

export { SEARCH_REINDEX_LOCK_NAME, tryAcquireSearchReindexLock } from './reindex-lock.mjs'

const ACTIVE_STATUSES = new Set(['queued', 'running'])
const PREFLIGHT_CACHE_MS = 15_000

function iso(value) {
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function publicOperation(row, extra = {}) {
  if (!row) return null
  return {
    id: row.id,
    status: row.status,
    phase: row.phase,
    processed: Number(row.processed || 0),
    total: row.total == null ? null : Number(row.total),
    progress: row.progress == null ? null : Number(row.progress),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    logs: Array.isArray(row.logs) ? row.logs : [],
    ...extra,
  }
}

function issue(code, message, action) {
  return { code, message, action }
}

function safeMessage(error) {
  return String(error?.message || error || 'Search reindex failed').slice(0, 2_000)
}

export class AdminSearchReindex {
  constructor({
    search,
    segmenterConfig,
    logger = console,
    reconcile = ensureSearchIndices,
    now = () => Date.now(),
  }) {
    this.search = search
    this.segmenterConfig = segmenterConfig || {}
    this.pool = search?.pool || null
    this.logger = logger
    this.reconcile = reconcile
    this.now = now
    this.preflightCache = null
  }

  async status() {
    let row = await this.#latestOperation()
    if (ACTIVE_STATUSES.has(row?.status)) {
      row = await this.#recoverLostOperation(row)
    }
    const preflight = ACTIVE_STATUSES.has(row?.status) && row.preflight?.ready
      ? row.preflight
      : await this.preflight()
    return { preflight, operation: publicOperation(row) }
  }

  async preflight({ fresh = false } = {}) {
    if (!fresh
      && this.preflightCache
      && this.now() - this.preflightCache.checkedAt < PREFLIGHT_CACHE_MS) {
      return this.preflightCache.value
    }

    const blockers = []
    const warnings = [issue(
      'projector_readiness_not_required',
      'The Admin API runs the strict reconciler directly; a projector with zero Ready replicas does not block recovery.',
      'After a successful rebuild, verify that mx-insight-hub-projector becomes Ready again.',
    )]
    let expectedBackend = null
    let sourceIndexSchema = null
    const targetIndexSchema = this.search?.indexSet?.schemaVersion == null
      ? null
      : `content-v${this.search.indexSet.schemaVersion}`

    if (!this.pool?.query || !this.search) {
      blockers.push(issue(
        'postgres_unavailable',
        'Search reindex requires the PostgreSQL-backed Admin runtime.',
        'Deploy the Admin API with MX_INSIGHT_STORE=postgres and a working DATABASE_URL.',
      ))
    } else {
      try {
        await this.pool.query('SELECT 1')
      } catch (error) {
        blockers.push(issue(
          'postgres_unavailable',
          `PostgreSQL preflight failed: ${safeMessage(error)}`,
          'Restore the Hub PostgreSQL connection, then retry preflight.',
        ))
      }
    }

    if (!this.search?.client) {
      blockers.push(issue(
        'elasticsearch_not_configured',
        'MX_COMMON_ELASTICSEARCH_URL is not configured in the Admin runtime.',
        'Set MX_COMMON_ELASTICSEARCH_URL in mx-insight-hub-config and redeploy the Admin API.',
      ))
    } else {
      try {
        await this.search.client.clusterHealth({ waitForStatus: 'yellow', timeout: '3s' })
        const capabilities = await this.search.queries?.searchCapabilities?.({ audience: 'admin' })
        sourceIndexSchema = capabilities?.activeIndexSchema || null
      } catch (error) {
        blockers.push(issue(
          'elasticsearch_unavailable',
          `Elasticsearch preflight failed: ${safeMessage(error)}`,
          'Restore Elasticsearch connectivity and yellow-or-better cluster health, then retry.',
        ))
      }
    }

    try {
      expectedBackend = requiredReindexBackend(this.segmenterConfig)
      const strictSegmenter = requireSegmenterBackend(this.search?.segmenter, {
        expectedBackend,
        maxAttempts: fresh ? 3 : 1,
        logger: this.logger,
      })
      await strictSegmenter.segmentWithMeta('吴恩达与人工智能')
    } catch (error) {
      blockers.push(issue(
        error?.code || 'segmenter_unavailable',
        `Strict tokenizer preflight failed: ${safeMessage(error)}`,
        'Restore the configured tokenizer backend; fallback tokens are never accepted by a rebuild.',
      ))
    }

    const value = {
      ready: blockers.length === 0,
      blockers,
      warnings,
      projectorRequired: false,
      projectorReadyReplicas: null,
      expectedBackend,
      sourceIndexSchema,
      targetIndexSchema,
    }
    this.preflightCache = { checkedAt: this.now(), value }
    return value
  }

  async start({ requestedBy, requestId = null }) {
    const lock = await tryAcquireSearchReindexLock(this.pool)
    if (!lock) {
      const active = await this.#activeOperation()
      if (active) {
        return {
          preflight: active.preflight,
          operation: publicOperation(active, { alreadyRunning: true }),
        }
      }
      throw new AppError(
        409,
        'search_reindex_busy',
        'Another CLI or Admin search reindex holds the global rebuild lock',
        { action: 'Wait for the running rebuild to finish, then refresh this page.' },
      )
    }
    const lockHeartbeat = monitorSearchReindexLock(lock)

    let preflight
    try {
      // Probe only after acquiring the global fence. A CLI rebuild may be using
      // the single-slot HanLP backend, so a losing POST must not create the very
      // tokenizer contention the lock is intended to prevent.
      preflight = await this.preflight({ fresh: true })
      if (!preflight.ready) {
        throw new AppError(
          409,
          'search_reindex_preflight_failed',
          'Search reindex preflight has blocking failures',
          { preflight },
        )
      }
    } catch (error) {
      await lockHeartbeat.stop()
      await lock.release()
      throw error
    }

    let row
    try {
      await lock.client.query('BEGIN')
      // Holding the global session lock proves no previous runner is still
      // alive. Any active row is therefore stale evidence from a terminated
      // Admin process and can be closed before admitting the replacement.
      await lock.client.query(
        `UPDATE control.search_reindex_operations
            SET status = 'failed', phase = 'failed',
                error_code = 'reindex_runner_lost',
                error_message = 'The Admin process stopped before the rebuild completed',
                finished_at = now(), updated_at = now()
          WHERE status IN ('queued', 'running')`,
      )
      const { rows } = await lock.client.query(
        `INSERT INTO control.search_reindex_operations
           (id, status, phase, requested_by, request_id, preflight, logs)
         VALUES ($1, 'queued', 'queued', $2, $3, $4::jsonb, $5::jsonb)
         RETURNING *`,
        [
          randomUUID(),
          requestedBy || 'admin-token',
          requestId,
          JSON.stringify(preflight),
          JSON.stringify([{ at: new Date(this.now()).toISOString(), level: 'info', message: 'Search reindex queued' }]),
        ],
      )
      row = rows[0]
      await lock.client.query('COMMIT')
    } catch (error) {
      await lock.client.query('ROLLBACK').catch(() => {})
      await lockHeartbeat.stop()
      await lock.release()
      throw error
    }

    // Deliberately detached from the request. The retained PostgreSQL session
    // owns the global advisory lock until success/failure is durably recorded.
    void this.#run(row.id, preflight, lock, lockHeartbeat)
    return { preflight, operation: publicOperation(row) }
  }

  async #run(id, preflight, lock, lockHeartbeat) {
    let lastPass = null
    const passProgress = new Map()
    try {
      lockHeartbeat.assertHealthy()
      await this.#update(lock.client, id, {
        status: 'running',
        phase: 'preflight',
        started: true,
        log: { level: 'info', message: `Strict ${preflight.expectedBackend} preflight passed; rebuilding projections` },
      })
      const strictSegmenter = requireSegmenterBackend(this.search.segmenter, {
        expectedBackend: preflight.expectedBackend,
        logger: this.logger,
      })
      lockHeartbeat.assertHealthy()
      const report = await this.reconcile({ ...this.search, segmenter: strictSegmenter }, {
        logger: this.logger,
        failOnError: true,
        onProgress: async ({ projection, pass, processed }) => {
          lockHeartbeat.assertHealthy()
          const passKey = `${projection}:${pass}`
          passProgress.set(passKey, processed)
          const cumulativeProcessed = [...passProgress.values()]
            .reduce((total, value) => total + value, 0)
          await this.#update(lock.client, id, {
            phase: projection,
            processed: cumulativeProcessed,
            ...(lastPass === passKey ? {} : {
              log: { level: 'info', message: `${projection} ${pass} pass started` },
            }),
          })
          lastPass = passKey
        },
      })
      lockHeartbeat.assertHealthy()
      await this.#update(lock.client, id, {
        status: 'succeeded',
        phase: 'completed',
        progress: 1,
        finished: true,
        result: report,
        log: { level: 'info', message: 'Search reindex completed and aliases are ready' },
      })
      this.preflightCache = null
    } catch (error) {
      this.logger?.error?.(`[search] Admin reindex failed: ${safeMessage(error)}`)
      await this.#update(lock.client, id, {
        status: 'failed',
        phase: 'failed',
        finished: true,
        errorCode: error?.code || 'search_reindex_failed',
        errorMessage: safeMessage(error),
        log: { level: 'error', message: safeMessage(error) },
      }).catch((updateError) => {
        this.logger?.error?.(`[search] could not persist Admin reindex failure: ${safeMessage(updateError)}`)
      })
    } finally {
      await lockHeartbeat.stop()
      await lock.release()
    }
  }

  async #update(connection, id, {
    status = null,
    phase = null,
    processed = null,
    progress = null,
    started = false,
    finished = false,
    result = null,
    errorCode = null,
    errorMessage = null,
    log = null,
  }) {
    const entry = log
      ? JSON.stringify([{ at: new Date(this.now()).toISOString(), ...log }])
      : null
    await connection.query(
      `UPDATE control.search_reindex_operations
          SET status = coalesce($2, status),
              phase = coalesce($3, phase),
              processed = coalesce($4, processed),
              progress = coalesce($5, progress),
              started_at = CASE WHEN $6 THEN coalesce(started_at, now()) ELSE started_at END,
              finished_at = CASE WHEN $7 THEN now() ELSE finished_at END,
              result = coalesce($8::jsonb, result),
              error_code = coalesce($9, error_code),
              error_message = coalesce($10, error_message),
              logs = CASE WHEN $11::jsonb IS NULL THEN logs ELSE logs || $11::jsonb END,
              heartbeat_at = now(), updated_at = now()
        WHERE id = $1`,
      [
        id, status, phase, processed, progress, started, finished,
        result == null ? null : JSON.stringify(result),
        errorCode, errorMessage, entry,
      ],
    )
  }

  async #activeOperation() {
    const { rows } = await this.pool.query(
      `SELECT * FROM control.search_reindex_operations
        WHERE status IN ('queued', 'running')
        ORDER BY created_at DESC LIMIT 1`,
    )
    return rows[0] || null
  }

  async #recoverLostOperation(row) {
    const lock = await tryAcquireSearchReindexLock(this.pool)
    if (!lock) return row
    try {
      await lock.client.query(
        `UPDATE control.search_reindex_operations
            SET status = 'failed', phase = 'failed',
                error_code = 'reindex_runner_lost',
                error_message = 'The Admin process stopped before the rebuild completed',
                finished_at = now(), updated_at = now()
          WHERE id = $1 AND status IN ('queued', 'running')`,
        [row.id],
      )
      this.preflightCache = null
      return await this.#latestOperation()
    } finally {
      await lock.release()
    }
  }

  async #latestOperation() {
    if (!this.pool?.query) return null
    const { rows } = await this.pool.query(
      'SELECT * FROM control.search_reindex_operations ORDER BY created_at DESC LIMIT 1',
    )
    return rows[0] || null
  }
}
