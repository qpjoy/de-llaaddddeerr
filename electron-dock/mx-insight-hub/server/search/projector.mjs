import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { ElasticsearchUnavailableError } from '@qpjoy/mx-common/elasticsearch'
import { buildContentDocument } from './document.mjs'
import {
  purgeStaleCurrentStateCopies,
  withCurrentStateWriteFence,
} from './current-state.mjs'
import { isRetryableSegmenterIntegrityError } from './reindex-integrity.mjs'

// Outbox -> Elasticsearch projector.
//
// This is the only writer to the content index. ADR-0005 forbids application
// dual-write, and the reason shows up here concretely: the projector can be
// stopped, restarted, or run against an empty cluster, and the index converges
// to whatever PostgreSQL says. Nothing about search correctness depends on the
// request path having succeeded at indexing time.

const WORKER_ID = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`
const MAX_ATTEMPTS = 5
const DEFAULT_BATCH_SIZE = 50
const DEFAULT_LEASE_SECONDS = 300
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000

export class SearchProjector {
  constructor({
    pool,
    client,
    segmenter,
    indexSet,
    batchSize = DEFAULT_BATCH_SIZE,
    leaseSeconds = DEFAULT_LEASE_SECONDS,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    logger = console,
  }) {
    this.pool = pool
    this.client = client
    this.segmenter = segmenter
    this.indexSet = indexSet
    this.batchSize = batchSize
    this.leaseSeconds = leaseSeconds
    this.heartbeatIntervalMs = heartbeatIntervalMs
    this.setTimeoutFn = setTimeoutFn
    this.clearTimeoutFn = clearTimeoutFn
    this.logger = logger
    this.workerId = WORKER_ID
  }

  /**
   * Return claims whose worker never reported back.
   *
   * Called on startup and between batches. This is what makes a redeploy
   * self-healing: rolling the projector pod abandons an in-flight claim, the
   * lease lapses, and the next sweep re-queues exactly those events.
   */
  async reclaimExpired() {
    const { rowCount } = await this.pool.query(
      `UPDATE outbox.projection_events
          SET status = 'pending', leased_until = NULL, locked_by = NULL
        WHERE status = 'claimed' AND leased_until IS NOT NULL AND leased_until < now()`,
    )
    if (rowCount > 0) this.logger?.warn?.(`[projector] reclaimed ${rowCount} expired lease(s)`)
    return rowCount
  }

  /**
   * Claim a batch of pending events.
   *
   * `FOR UPDATE SKIP LOCKED` lets several projector replicas share the outbox
   * without coordination. Ordering by id keeps projection order aligned with
   * write order, so a backlog drains oldest-first instead of starving old rows.
   */
  async #claim() {
    const { rows } = await this.pool.query(
      `UPDATE outbox.projection_events AS e
          SET status = 'claimed',
              leased_until = now() + make_interval(secs => $2),
              locked_by = $3,
              attempts = e.attempts + 1
        WHERE e.id IN (
          SELECT id FROM outbox.projection_events
           WHERE status = 'pending'
           ORDER BY id
           FOR UPDATE SKIP LOCKED
           LIMIT $1
        )
        RETURNING e.id, e.aggregate_id, e.event_type, e.projection_revision, e.attempts`,
      [this.batchSize, this.leaseSeconds, this.workerId],
    )
    return rows
  }

  // Load the current canonical state for the claimed aggregates. Deliberately
  // reads *current* state rather than the event payload: an aggregate updated
  // several times while the projector lagged is then indexed once, at its latest
  // revision, instead of replaying every intermediate version.
  async #loadRecords(aggregateIds) {
    if (aggregateIds.length === 0) return new Map()
    const { rows } = await this.pool.query(
      `SELECT * FROM core.canonical_records WHERE id = ANY($1::uuid[])`,
      [aggregateIds],
    )
    return new Map(rows.map((row) => [row.id, row]))
  }

  /** Keep a long HanLP/Elasticsearch batch owned while it is still making progress. */
  #monitorClaimLease(eventIds) {
    const clearTimeoutFn = this.clearTimeoutFn
    let stopped = false
    let timer = null
    let inFlight = null
    let failure = null

    const recordFailure = (error) => {
      if (failure) return failure
      failure = error instanceof Error ? error : new Error(String(error))
      if (!failure.code) failure.code = 'projection_lease_heartbeat_failed'
      this.logger?.warn?.(`[projector] claim lease heartbeat failed: ${failure.message}`)
      return failure
    }
    const assertHealthy = () => {
      if (failure) throw failure
    }
    const pulse = async () => {
      assertHealthy()
      try {
        const { rowCount } = await this.pool.query(
          `UPDATE outbox.projection_events
              SET leased_until = now() + make_interval(secs => $2)
            WHERE id = ANY($1::bigint[])
              AND status = 'claimed'
              AND locked_by = $3`,
          [eventIds, this.leaseSeconds, this.workerId],
        )
        if (rowCount !== eventIds.length) {
          const error = new Error(
            `claim lease lost while renewing ${eventIds.length} event(s); renewed ${rowCount}`,
          )
          error.code = 'projection_lease_lost'
          throw error
        }
      } catch (error) {
        throw recordFailure(error)
      }
    }
    const schedule = () => {
      if (stopped || failure) return
      timer = this.setTimeoutFn(async () => {
        inFlight = pulse()
        await inFlight.catch(() => {})
        inFlight = null
        schedule()
      }, this.heartbeatIntervalMs)
      timer?.unref?.()
    }
    schedule()

    return {
      async stop({ requireHealthy = false } = {}) {
        stopped = true
        if (timer) clearTimeoutFn(timer)
        await inFlight?.catch(() => {})
        if (requireHealthy) assertHealthy()
      },
    }
  }

  async #markDelivered(eventIds) {
    if (eventIds.length === 0) return 0
    const { rowCount } = await this.pool.query(
      `UPDATE outbox.projection_events
          SET status = 'delivered', delivered_at = now(), leased_until = NULL,
              locked_by = NULL, last_error = NULL
        WHERE id = ANY($1::bigint[])
          AND status = 'claimed'
          AND locked_by = $2`,
      [eventIds, this.workerId],
    )
    return rowCount
  }

  async #markFailed(failures) {
    let transitioned = 0
    for (const [eventId, { attempts, error }] of failures) {
      const exhausted = attempts >= MAX_ATTEMPTS
      const { rowCount } = await this.pool.query(
        `UPDATE outbox.projection_events
            SET status = $2, last_error = $3, leased_until = NULL, locked_by = NULL
          WHERE id = $1
            AND status = 'claimed'
            AND locked_by = $4`,
        [eventId, exhausted ? 'dead' : 'pending', String(error).slice(0, 2_000), this.workerId],
      )
      transitioned += rowCount
      if (exhausted && rowCount > 0) {
        this.logger?.error?.(`[projector] event ${eventId} dead after ${attempts} attempts: ${error}`)
      }
    }
    return transitioned
  }

  /**
   * Project one batch. Returns counts; never throws for permanent per-document problems.
   *
   * Throws for retryable shared-dependency outages, which the caller turns into
   * a backoff rather than a per-event failure. Marking a whole batch failed
   * because Elasticsearch or the required tokenizer was briefly down would burn
   * their retry budget for no reason.
   */
  async projectBatch() {
    const events = await this.#claim()
    if (events.length === 0) return { claimed: 0, delivered: 0, failed: 0 }
    const leaseHeartbeat = this.#monitorClaimLease(events.map((event) => event.id))

    try {
      return await this.#projectClaimedBatch(events, leaseHeartbeat)
    } finally {
      await leaseHeartbeat.stop()
    }
  }

  async #projectClaimedBatch(events, leaseHeartbeat) {
    const runId = await this.#startRun(events.length)
    const records = await this.#loadRecords([...new Set(events.map((event) => event.aggregate_id))])

    const eventsByAggregate = new Map()
    for (const event of events) {
      const aggregateEvents = eventsByAggregate.get(event.aggregate_id) || []
      aggregateEvents.push(event)
      eventsByAggregate.set(event.aggregate_id, aggregateEvents)
    }
    const failures = new Map()
    const projections = []
    let retryableTokenizerError = null
    const retryableTokenizerEventIds = []

    for (const [aggregateId, aggregateEvents] of eventsByAggregate) {
      const record = records.get(aggregateId)
      const projectionRevision = record
        ? Number(record.projection_revision)
        : Math.max(...aggregateEvents.map((event) => Number(event.projection_revision)))
      const projection = {
        aggregateId,
        aggregateEvents,
        projectionRevision,
        document: null,
        deleted: !record || record.deleted_at != null,
      }
      // One verified shared-dependency outage is enough evidence for this
      // batch. Do not spend another strict retry window on every remaining
      // upsert; keep scanning only so tokenizer-independent tombstones proceed.
      if (retryableTokenizerError && !projection.deleted) {
        retryableTokenizerEventIds.push(...aggregateEvents.map((event) => event.id))
        continue
      }
      try {
        if (!projection.deleted) {
          projection.document = await buildContentDocument(record, { segmenter: this.segmenter })
        }
        projections.push(projection)
      } catch (error) {
        if (isRetryableSegmenterIntegrityError(error)) {
          retryableTokenizerError ||= error
          retryableTokenizerEventIds.push(...aggregateEvents.map((event) => event.id))
          continue
        }
        for (const event of aggregateEvents) {
          failures.set(event.id, { attempts: event.attempts, error: error.message })
        }
      }
    }

    let delivered = []
    if (projections.length > 0) {
      try {
        // Schema migrations and ILM rollover can leave several concrete indices
        // behind one read alias. `_id` and external versions are index-local, so
        // first remove only obsolete copies whose revision is not newer than the
        // PostgreSQL truth, then write that truth to the concrete current index.
        await withCurrentStateWriteFence({
          pool: this.pool,
          indexSet: this.indexSet,
        }, async (connection) => {
          const { writeTarget } = await purgeStaleCurrentStateCopies({
            client: this.client,
            pool: connection,
            indexSet: this.indexSet,
            documents: projections.map((projection) => ({
              id: projection.aggregateId,
              version: projection.projectionRevision,
            })),
            versionField: 'projectionRevision',
            expectedBackend: this.segmenter?.expectedBackend,
          })
          const operations = []
          const descriptors = []
          for (const projection of projections) {
            if (projection.deleted) {
              operations.push({
                delete: {
                  _index: writeTarget,
                  _id: projection.aggregateId,
                  version: projection.projectionRevision,
                  // A retried tombstone at the same revision must remain a
                  // successful delete rather than depend on conflict handling.
                  version_type: 'external_gte',
                },
              })
              descriptors.push({ ...projection, operation: 'delete' })
              continue
            }
            operations.push({
              index: {
                _index: writeTarget,
                _id: projection.aggregateId,
                version: projection.projectionRevision,
                version_type: 'external',
              },
            })
            operations.push(projection.document)
            descriptors.push({ ...projection, operation: 'index' })
          }
          const response = await this.client.bulk(operations)
          this.#recordBulkOutcomes(response, descriptors, failures)

          for (const projection of projections) {
            if (!projection.aggregateEvents.some((event) => failures.has(event.id))) {
              delivered.push(...projection.aggregateEvents.map((event) => event.id))
            }
          }
        })
      } catch (error) {
        const retryableControlError = [
          'search_alias_changed',
          'search_alias_ambiguous',
          'search_index_backend_mismatch',
        ].includes(error?.code)
        if (!(error instanceof ElasticsearchUnavailableError) && !retryableControlError) throw error
        // Give the whole batch back untouched; purge/index are idempotent, and a
        // transport/topology/provenance failure does not belong in any
        // individual event's budget.
        await leaseHeartbeat.stop()
        await this.#releaseClaim(events.map((event) => event.id))
        await this.#finishRun(runId, { delivered: 0, failed: 0, error: error.message })
        throw error
      }
    }

    // Stop renewing before terminal transitions. Their ownership predicates are
    // the final fence, and a concurrent heartbeat must not mistake a delivered
    // row for a lost claim.
    await leaseHeartbeat.stop({ requireHealthy: true })
    const deliveredCount = await this.#markDelivered(delivered)
    const failedCount = await this.#markFailed(failures)
    // Only tokenizer-dependent upserts wait for a shared HanLP outage. Deletes
    // and healthy documents in the same batch are already safe to acknowledge.
    await this.#releaseClaim(retryableTokenizerEventIds)
    await this.#finishRun(runId, {
      delivered: deliveredCount,
      failed: failedCount,
      error: retryableTokenizerError?.message || null,
    })

    if (retryableTokenizerError) throw retryableTokenizerError

    return { claimed: events.length, delivered: deliveredCount, failed: failedCount }
  }

  async #releaseClaim(eventIds) {
    if (eventIds.length === 0) return 0
    const { rowCount } = await this.pool.query(
      `UPDATE outbox.projection_events
          SET status = 'pending', leased_until = NULL, locked_by = NULL,
              attempts = GREATEST(attempts - 1, 0)
        WHERE id = ANY($1::bigint[])
          AND status = 'claimed'
          AND locked_by = $2`,
      [eventIds, this.workerId],
    )
    return rowCount
  }

  #recordBulkOutcomes(response, descriptors, failures) {
    const items = response?.items || []
    for (const [index, descriptor] of descriptors.entries()) {
      const item = items[index]
      const action = item?.index || item?.delete
      const status = Number(action?.status ?? 0)
      const isConflict = status === 409
      const isMissingDelete = descriptor.operation === 'delete' && status === 404
      const succeeded = Boolean(action) && (!action.error || isConflict || isMissingDelete)
      if (succeeded) continue
      const error = action?.error
        ? JSON.stringify(action.error)
        : `missing ${descriptor.operation} result from Elasticsearch bulk response`
      for (const event of descriptor.aggregateEvents) {
        failures.set(event.id, { attempts: event.attempts, error })
      }
    }
  }

  async #startRun(claimed) {
    const { rows } = await this.pool.query(
      `INSERT INTO outbox.projection_runs (projector, target, claimed_count)
       VALUES ($1, $2, $3) RETURNING id`,
      [this.workerId, this.indexSet.writeAlias, claimed],
    )
    return rows[0].id
  }

  async #finishRun(runId, { delivered, failed, error }) {
    await this.pool.query(
      `UPDATE outbox.projection_runs
          SET delivered_count = $2, failed_count = $3, finished_at = now(), last_error = $4
        WHERE id = $1`,
      [runId, delivered, failed, error],
    )
  }

  /** Pending/dead counts and projection lag, for the admin console and probes. */
  async status() {
    const { rows } = await this.pool.query(
      `SELECT status, count(*)::int AS count, min(created_at) AS oldest
         FROM outbox.projection_events
        WHERE status IN ('pending', 'claimed', 'dead')
        GROUP BY status`,
    )
    const byStatus = Object.fromEntries(rows.map((row) => [row.status, row]))
    const oldestPending = byStatus.pending?.oldest || null
    return {
      pending: byStatus.pending?.count ?? 0,
      claimed: byStatus.claimed?.count ?? 0,
      dead: byStatus.dead?.count ?? 0,
      lagSeconds: oldestPending ? Math.round((Date.now() - new Date(oldestPending).getTime()) / 1000) : 0,
    }
  }
}

/**
 * Drain loop. Backs off on an unavailable cluster instead of spinning.
 *
 * The backoff is capped and additive rather than exponential-to-minutes: search
 * is expected to catch up promptly once the cluster returns, and a long backoff
 * would leave the index stale well after the outage ended.
 */
export async function runProjectorLoop(projector, {
  idleDelayMs = 2_000,
  reclaimIntervalMs = idleDelayMs,
  nowFn = Date.now,
  signal,
  logger = console,
}) {
  let backoffMs = idleDelayMs
  let nextReclaimAt = nowFn()
  // A continuously non-empty backlog never enters the idle branch, so keep a
  // wall-clock sweep cadence between successful batches as well.
  const reclaimExpired = async ({ force = false } = {}) => {
    const now = nowFn()
    if (!force && now < nextReclaimAt) return
    nextReclaimAt = now + reclaimIntervalMs
    await projector.reclaimExpired().catch(() => {})
  }

  await reclaimExpired({ force: true })

  while (!signal?.aborted) {
    await reclaimExpired()
    try {
      const result = await projector.projectBatch()
      backoffMs = idleDelayMs
      if (result.claimed === 0) {
        await reclaimExpired({ force: true })
        await delay(idleDelayMs, signal)
      } else {
        logger?.log?.(
          `[projector] claimed=${result.claimed} delivered=${result.delivered} failed=${result.failed}`,
        )
      }
    } catch (error) {
      if (error instanceof ElasticsearchUnavailableError) {
        backoffMs = Math.min(backoffMs * 2, 60_000)
        logger?.warn?.(`[projector] Elasticsearch unavailable; retrying in ${backoffMs}ms`)
      } else {
        backoffMs = Math.min(backoffMs * 2, 60_000)
        logger?.error?.(`[projector] batch failed: ${error.message}`)
      }
      await delay(backoffMs, signal)
    }
  }
}

function delay(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}
