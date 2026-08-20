import { randomUUID } from 'node:crypto'
import { describeClusterHealth } from '@qpjoy/mx-common/elasticsearch'
import { AppError } from '../core/errors.mjs'
import {
  ensureSearchIndices,
  fullRebuildTargetIndex,
  readIndexBackend,
  resolveCurrentStateBackings,
  setStartupRebuild,
  startupRebuildEnabled,
} from './index.mjs'
import { requiredReindexBackend, requireSegmenterBackend } from './reindex-integrity.mjs'
import {
  describeSearchReindexLockHolder,
  monitorSearchReindexLock,
  tryAcquireSearchReindexLock,
} from './reindex-lock.mjs'

export { SEARCH_REINDEX_LOCK_NAME, tryAcquireSearchReindexLock } from './reindex-lock.mjs'

const ACTIVE_STATUSES = new Set(['queued', 'running'])
const PREFLIGHT_CACHE_MS = 15_000
// Elasticsearch stops allocating new shards at the high watermark, 90% by
// default. Warning below that leaves room to act before a rebuild is refused.
const DISK_HEADROOM_WARN_PERCENT = 85

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

  /** Ask a running rebuild to stop at its next batch boundary. */
  async cancel({ requestedBy = 'admin-token' } = {}) {
    const active = await this.#activeOperation()
    if (!active) {
      throw new AppError(409, 'search_reindex_not_running', 'No search reindex is running')
    }
    await this.pool.query(
      `UPDATE control.search_reindex_operations
          SET cancel_requested_at = coalesce(cancel_requested_at, now()), updated_at = now()
        WHERE id = $1 AND status IN ('queued', 'running')`,
      [active.id],
    )
    this.logger?.log?.(`[search] cancel requested for reindex ${active.id} by ${requestedBy}`)
    // Cooperative on purpose: the runner stops between batches so every
    // document already written stays durable and the aliases are never left
    // pointing at a half-built index.
    return { operation: publicOperation(await this.#latestOperation(), { cancelRequested: true }) }
  }

  async startupRebuild() {
    return { startupRebuild: await startupRebuildEnabled(this.pool) }
  }

  async setStartupRebuild(enabled, { requestedBy = 'admin-token' } = {}) {
    if (typeof enabled !== 'boolean') {
      throw new AppError(400, 'invalid_request', 'enabled must be a boolean')
    }
    return setStartupRebuild(this.pool, enabled, requestedBy)
  }

  async #cancelRequested(id) {
    try {
      const { rows } = await this.pool.query(
        'SELECT cancel_requested_at FROM control.search_reindex_operations WHERE id = $1',
        [id],
      )
      return rows[0]?.cancel_requested_at != null
    } catch {
      return false
    }
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
    let activeIndex = this.search?.indexSet?.currentIndex || null
    if (this.search?.client && this.search?.indexSet?.writeAlias) {
      try {
        activeIndex = (await resolveCurrentStateBackings({
          client: this.search.client,
          indexSet: this.search.indexSet,
        })).currentIndex || activeIndex
      } catch {
        // Alias readiness is reported separately below. Provenance lookup must
        // remain best-effort so it cannot hide the actionable preflight issue.
      }
    }
    const targetIndex = this.search?.indexSet?.writeAlias
      ? fullRebuildTargetIndex(this.search.indexSet, activeIndex)
      : this.search?.indexSet?.currentIndex || null
    // What the live projection is made of, as opposed to what this process is
    // configured to produce. They diverged once already, silently.
    const activeBackend = await readIndexBackend(this.pool, activeIndex)
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
      // Reachability blocks; cluster colour does not.
      //
      // A strict rebuild reads PostgreSQL canonical truth, writes a brand-new
      // schema-versioned index and only then switches the aliases, so it never
      // reads the index it replaces. When that stale index is precisely what
      // holds the cluster below yellow -- the usual shape after a schema bump
      // leaves the previous generation's shards unassigned -- blocking here
      // would forbid the one operation that repairs the cluster.
      try {
        const health = await this.search.client.clusterHealth({
          waitForStatus: 'yellow',
          // Long enough to ride out shards that are merely initializing, so a
          // settling cluster reports its real colour instead of a bare timeout.
          timeout: '10s',
        })
        if (health?.status !== 'green' && health?.status !== 'yellow') {
          // Distinguish the two shapes of "red" that matter here. If the shard
          // this rebuild writes to is itself unassignable, the rebuild cannot
          // repair anything -- it would create the index, fail every bulk write
          // and leave a second dead generation behind. That is a blocker, and
          // the cluster's own deciders say exactly why. Red for any other
          // reason stays a warning, since the rebuild does not read those
          // indices.
          const stuck = await this.#unassignableTarget(targetIndex)
          if (stuck) {
            blockers.push(issue(
              'search_index_unallocatable',
              `Elasticsearch cannot allocate ${stuck.index} shard ${stuck.shard}: ${stuck.reason}`,
              stuck.action,
            ))
          } else {
            warnings.push(issue(
              'elasticsearch_cluster_degraded',
              `Elasticsearch is reachable but below yellow (${describeClusterHealth(health)}).`,
              'The rebuild writes a new index and does not read the degraded ones; review them after it completes.',
            ))
          }
        }
        for (const warning of await this.#diskHeadroomWarnings()) warnings.push(warning)
      } catch (error) {
        blockers.push(issue(
          'elasticsearch_unavailable',
          `Elasticsearch is unreachable: ${safeMessage(error)}`,
          'Restore Elasticsearch connectivity from the Admin runtime, then retry.',
        ))
      }

      // Reported separately: the active schema is a display field, and losing
      // it to a degraded cluster should not hide which version is being left
      // behind -- that is exactly what the operator is here to read.
      try {
        const capabilities = await this.search.queries?.searchCapabilities?.({ audience: 'admin' })
        sourceIndexSchema = capabilities?.activeIndexSchema || null
        if (capabilities?.readinessError) {
          warnings.push(issue(
            'elasticsearch_capabilities_unavailable',
            `The active content read alias could not be inspected (${capabilities.readinessError}).`,
            'The rebuild targets the configured schema version regardless of what the current alias reports.',
          ))
        }
      } catch (error) {
        warnings.push(issue(
          'elasticsearch_capabilities_unavailable',
          `The active index schema could not be read: ${safeMessage(error)}`,
          'The rebuild targets the configured schema version regardless of what the current alias reports.',
        ))
      }
    }

    try {
      expectedBackend = requiredReindexBackend(this.segmenterConfig)
      const strictSegmenter = requireSegmenterBackend(this.search?.segmenter, {
        expectedBackend,
        maxBatch: this.search?.segmenterBatchSize,
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

    // Strict verification proves tokens came from the *configured* backend. It
    // cannot know that the configuration was intended. An empty HanLP URL once
    // resolved the requirement to jieba, passed every check, and rebuilt the
    // whole corpus in six minutes -- fast because nothing was ever segmented by
    // HanLP. Saying so out loud is the only thing that catches that class of
    // mistake, because every other signal looked healthy.
    if (expectedBackend && expectedBackend !== 'hanlp') {
      warnings.push(issue(
        'tokenizer_downgrade',
        `This rebuild would produce a ${expectedBackend} index, not a HanLP one.`,
        this.segmenterConfig?.hanlpUrl
          ? `MX_COMMON_SEGMENTER pins ${expectedBackend}; clear it to use HanLP.`
          : 'MX_COMMON_HANLP_URL is empty in this runtime, so HanLP cannot be required. Restore it before rebuilding unless a lower-quality index is intended.',
      ))
    }
    if (activeBackend && expectedBackend && activeBackend !== expectedBackend) {
      warnings.push(issue(
        'tokenizer_backend_change',
        `The live index was built with ${activeBackend}; this rebuild would replace it with ${expectedBackend}.`,
        'Confirm this is the direction you want before starting.',
      ))
    }

    const value = {
      ready: blockers.length === 0,
      blockers,
      warnings,
      activeBackend,
      activeIndex,
      targetIndex,
      startupRebuild: await startupRebuildEnabled(this.pool),
      // Acknowledgement is required for anything but HanLP, so the UI can ask
      // rather than let a downgrade through on a single click.
      requiresBackendAcknowledgement: Boolean(expectedBackend && expectedBackend !== 'hanlp'),
      projectorRequired: false,
      projectorReadyReplicas: null,
      expectedBackend,
      sourceIndexSchema,
      targetIndexSchema,
    }
    this.preflightCache = { checkedAt: this.now(), value }
    return value
  }

  async start({ requestedBy, requestId = null, acknowledgeBackend = null }) {
    const lock = await tryAcquireSearchReindexLock(this.pool)
    if (!lock) {
      const active = await this.#activeOperation()
      if (active) {
        return {
          preflight: active.preflight,
          operation: publicOperation(active, { alreadyRunning: true }),
        }
      }
      // The projector takes this same lock for its startup reconciliation and
      // writes no operation row, so "something else is running" was previously
      // the whole story. Name it.
      const owner = await describeSearchReindexLockHolder(this.pool)
      const minutes = owner ? Math.round(owner.heldSeconds / 60) : null
      throw new AppError(
        409,
        'search_reindex_busy',
        owner
          ? `${owner.holder} has held the global rebuild lock for ${minutes} minute(s)`
          : 'Another CLI or Admin search reindex holds the global rebuild lock',
        {
          ...(owner ? { holder: owner.holder, heldSeconds: owner.heldSeconds } : {}),
          action: owner?.holder?.includes('projector')
            ? 'The projector rebuilds on startup and does the same strict work; let it finish, or scale it to zero to run this from the Admin UI instead.'
            : 'Wait for the running rebuild to finish, then refresh this page.',
        },
      )
    }
    const lockHeartbeat = monitorSearchReindexLock(lock)

    let preflight
    try {
      // Probe only after acquiring the global fence. A CLI rebuild may be using
      // the single-slot HanLP backend, so a losing POST must not create the very
      // tokenizer contention the lock is intended to prevent.
      preflight = await this.preflight({ fresh: true })
      if (preflight.requiresBackendAcknowledgement && acknowledgeBackend !== preflight.expectedBackend) {
        throw new AppError(
          409,
          'tokenizer_acknowledgement_required',
          `This rebuild produces ${preflight.expectedBackend} tokens; acknowledge the backend to proceed`,
          {
            expectedBackend: preflight.expectedBackend,
            activeBackend: preflight.activeBackend,
            action: `Resend with acknowledgeBackend="${preflight.expectedBackend}", or restore HanLP first.`,
          },
        )
      }
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
      // A rebuild of this corpus runs for hours. Recording the denominator up
      // front is what makes it observable rather than merely long: without it
      // the UI can only show a rising count, which is indistinguishable from a
      // stall.
      const total = await this.#projectionTotal(lock.client)
      await this.#update(lock.client, id, {
        status: 'running',
        phase: 'preflight',
        started: true,
        total,
        log: { level: 'info', message: `Strict ${preflight.expectedBackend} preflight passed; rebuilding ${total ?? 'an unknown number of'} projections` },
      })
      const strictSegmenter = requireSegmenterBackend(this.search.segmenter, {
        expectedBackend: preflight.expectedBackend,
        maxBatch: this.search.segmenterBatchSize,
        logger: this.logger,
      })
      lockHeartbeat.assertHealthy()
      const report = await this.reconcile({ ...this.search, segmenter: strictSegmenter }, {
        logger: this.logger,
        failOnError: true,
        forceFull: true,
        onProgress: async ({ projection, pass, processed }) => {
          lockHeartbeat.assertHealthy()
          if (await this.#cancelRequested(id)) {
            throw new AppError(
              409,
              'search_reindex_cancelled',
              `Search reindex cancelled after ${processed} record(s)`,
            )
          }
          const passKey = `${projection}:${pass}`
          passProgress.set(passKey, processed)
          const cumulativeProcessed = [...passProgress.values()]
            .reduce((total, value) => total + value, 0)
          await this.#update(lock.client, id, {
            phase: projection,
            processed: cumulativeProcessed,
            progress: total ? Math.min(1, cumulativeProcessed / total) : null,
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
      const cancelled = error?.code === 'search_reindex_cancelled'
      const report = cancelled ? this.logger?.log : this.logger?.error
      report?.call(this.logger, `[search] Admin reindex ${cancelled ? 'cancelled' : 'failed'}: ${safeMessage(error)}`)
      await this.#update(lock.client, id, {
        status: 'failed',
        phase: 'failed',
        finished: true,
        errorCode: error?.code || 'search_reindex_failed',
        errorMessage: safeMessage(error),
        log: { level: cancelled ? 'info' : 'error', message: safeMessage(error) },
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
    total = null,
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
              total = coalesce($12, total),
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
        errorCode, errorMessage, entry, total,
      ],
    )
  }

  /**
   * Count what a rebuild will project.
   *
   * Both projections are included because `processed` accumulates across them;
   * a denominator covering only records would run past 100% once chunks start.
   * A failure here costs the progress bar, not the rebuild.
   */
  async #projectionTotal(connection) {
    try {
      const { rows } = await connection.query(
        `SELECT (SELECT count(*) FROM core.canonical_records)
              + (SELECT count(*) FROM core.record_chunks c
                   JOIN core.canonical_records r ON r.id = c.record_id
                  WHERE c.embedded_at IS NOT NULL AND c.vector IS NOT NULL
                    AND r.deleted_at IS NULL
                    AND c.source_revision = r.current_revision) AS total`,
      )
      const total = Number(rows[0]?.total)
      return Number.isFinite(total) && total > 0 ? total : null
    } catch (error) {
      this.logger?.warn?.(`[search] could not size the rebuild: ${safeMessage(error)}`)
      return null
    }
  }

  /**
   * Report the target index's primary shard when the cluster refuses to place it.
   *
   * Only an unassigned shard that Elasticsearch has decided it *cannot* place
   * counts. A shard still being relocated or initialized will settle on its
   * own and must not be turned into a permanent-looking blocker.
   */
  async #unassignableTarget(targetIndex = null) {
    const index = targetIndex || this.search?.indexSet?.currentIndex
    if (!index || typeof this.search.client?.allocationExplain !== 'function') return null
    let explain
    try {
      explain = await this.search.client.allocationExplain({ index, shard: 0, primary: true })
    } catch (error) {
      this.logger?.warn?.(`[search] allocation explain failed: ${safeMessage(error)}`)
      return null
    }
    if (!explain || explain.current_state !== 'unassigned') return null
    if (explain.can_allocate !== 'no' && explain.can_allocate !== 'no_valid_shard_copy') return null

    // Quote the cluster's own deciders. A paraphrase of "the node is above the
    // high watermark, having less than the minimum required 102.3gb free" loses
    // the two numbers the operator needs to size the fix.
    const deciders = (explain.node_allocation_decisions || [])
      .flatMap((node) => (node.deciders || [])
        .filter((decider) => decider.decision === 'NO')
        .map((decider) => `${decider.decider}: ${decider.explanation}`))
    const reason = deciders.length > 0
      ? deciders.join(' | ')
      : explain.allocate_explanation || 'no node accepted the shard'
    return {
      index,
      shard: 0,
      reason: reason.slice(0, 1_500),
      action: deciders.some((text) => text.startsWith('disk_threshold'))
        ? 'Free disk on the Elasticsearch data node, or move its data directory to a larger volume, then retry. No rebuild can succeed while the shard cannot be placed.'
        : 'Resolve the allocation decision above, then retry the preflight.',
    }
  }

  /**
   * Warn before the disk watermark becomes the next blocker.
   *
   * A rebuild writes a full second copy of the projection before the aliases
   * move, so headroom that looks adequate at rest can disappear mid-run.
   */
  async #diskHeadroomWarnings() {
    if (typeof this.search?.client?.catAllocation !== 'function') return []
    let rows
    try {
      rows = await this.search.client.catAllocation()
    } catch (error) {
      this.logger?.warn?.(`[search] disk headroom probe failed: ${safeMessage(error)}`)
      return []
    }
    const warnings = []
    for (const row of Array.isArray(rows) ? rows : []) {
      const percent = Number(row?.['disk.percent'])
      if (!Number.isFinite(percent) || percent < DISK_HEADROOM_WARN_PERCENT) continue
      const available = Number(row?.['disk.avail'])
      const free = Number.isFinite(available) ? `${(available / 1024 ** 3).toFixed(1)}GiB free` : 'free space unknown'
      warnings.push(issue(
        'elasticsearch_disk_pressure',
        `Elasticsearch data node ${row.node || 'unknown'} is ${percent}% full (${free}).`,
        'A rebuild writes a second full copy of the projection before switching aliases; free disk first or it will stop at the allocation watermark.',
      ))
    }
    return warnings
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
