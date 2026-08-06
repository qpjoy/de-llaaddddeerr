import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { ElasticsearchUnavailableError } from '@qpjoy/mx-common/elasticsearch'
import { buildContentDocument } from './document.mjs'

// Outbox -> Elasticsearch projector.
//
// This is the only writer to the content index. ADR-0005 forbids application
// dual-write, and the reason shows up here concretely: the projector can be
// stopped, restarted, or run against an empty cluster, and the index converges
// to whatever PostgreSQL says. Nothing about search correctness depends on the
// request path having succeeded at indexing time.

const WORKER_ID = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`
const MAX_ATTEMPTS = 5

export class SearchProjector {
  constructor({
    pool,
    client,
    segmenter,
    indexSet,
    batchSize = 200,
    leaseSeconds = 120,
    logger = console,
  }) {
    this.pool = pool
    this.client = client
    this.segmenter = segmenter
    this.indexSet = indexSet
    this.batchSize = batchSize
    this.leaseSeconds = leaseSeconds
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

  async #markDelivered(eventIds) {
    if (eventIds.length === 0) return
    await this.pool.query(
      `UPDATE outbox.projection_events
          SET status = 'delivered', delivered_at = now(), leased_until = NULL,
              locked_by = NULL, last_error = NULL
        WHERE id = ANY($1::bigint[])`,
      [eventIds],
    )
  }

  async #markFailed(failures) {
    for (const [eventId, { attempts, error }] of failures) {
      const exhausted = attempts >= MAX_ATTEMPTS
      await this.pool.query(
        `UPDATE outbox.projection_events
            SET status = $2, last_error = $3, leased_until = NULL, locked_by = NULL
          WHERE id = $1`,
        [eventId, exhausted ? 'dead' : 'pending', String(error).slice(0, 2_000)],
      )
      if (exhausted) {
        this.logger?.error?.(`[projector] event ${eventId} dead after ${attempts} attempts: ${error}`)
      }
    }
  }

  /**
   * Project one batch. Returns counts; never throws for per-document problems.
   *
   * Throws only for a cluster-level outage, which the caller turns into a backoff
   * rather than a per-event failure — marking 200 events failed because the
   * cluster was briefly down would burn their retry budget for no reason.
   */
  async projectBatch() {
    const events = await this.#claim()
    if (events.length === 0) return { claimed: 0, delivered: 0, failed: 0 }

    const runId = await this.#startRun(events.length)
    const records = await this.#loadRecords([...new Set(events.map((event) => event.aggregate_id))])

    const operations = []
    const eventByDocumentId = new Map()
    const failures = new Map()

    for (const event of events) {
      if (event.event_type === 'delete') {
        operations.push({ delete: { _index: this.indexSet.writeAlias, _id: event.aggregate_id } })
        eventByDocumentId.set(event.aggregate_id, event)
        continue
      }
      const record = records.get(event.aggregate_id)
      if (!record) {
        // The canonical row is gone (hard-deleted or never committed). There is
        // nothing to project and retrying cannot help, so retire the event
        // instead of letting it cycle until it dies.
        failures.set(event.id, { attempts: MAX_ATTEMPTS, error: 'canonical record not found' })
        continue
      }
      try {
        const document = await buildContentDocument(record, { segmenter: this.segmenter })
        operations.push({
          index: {
            _index: this.indexSet.writeAlias,
            _id: record.id,
            // External versioning is the guard against out-of-order delivery:
            // Elasticsearch refuses a write whose version is not greater than
            // what it holds, so a late event can never clobber newer content.
            version: Number(record.projection_revision),
            version_type: 'external',
          },
        })
        operations.push(document)
        eventByDocumentId.set(record.id, event)
      } catch (error) {
        failures.set(event.id, { attempts: event.attempts, error: error.message })
      }
    }

    let delivered = []
    if (operations.length > 0) {
      let response
      try {
        response = await this.client.bulk(operations)
      } catch (error) {
        if (error instanceof ElasticsearchUnavailableError) {
          // Give the whole batch back untouched; this is not the events' fault.
          await this.#releaseClaim(events.map((event) => event.id))
          await this.#finishRun(runId, { delivered: 0, failed: 0, error: error.message })
          throw error
        }
        throw error
      }

      for (const item of response.items || []) {
        const action = item.index || item.delete || {}
        const event = eventByDocumentId.get(action._id)
        if (!event) continue
        // 409 version_conflict means the index already holds this revision or a
        // newer one. That is the success case for a redelivered event, not an
        // error: the projection is already at least as fresh as this event.
        const isConflict = action.status === 409
        if (!action.error || isConflict) delivered.push(event.id)
        else failures.set(event.id, { attempts: event.attempts, error: JSON.stringify(action.error) })
      }
    }

    await this.#markDelivered(delivered)
    await this.#markFailed(failures)
    await this.#finishRun(runId, { delivered: delivered.length, failed: failures.size, error: null })

    return { claimed: events.length, delivered: delivered.length, failed: failures.size }
  }

  async #releaseClaim(eventIds) {
    if (eventIds.length === 0) return
    await this.pool.query(
      `UPDATE outbox.projection_events
          SET status = 'pending', leased_until = NULL, locked_by = NULL,
              attempts = GREATEST(attempts - 1, 0)
        WHERE id = ANY($1::bigint[])`,
      [eventIds],
    )
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
export async function runProjectorLoop(projector, { idleDelayMs = 2_000, signal, logger = console }) {
  let backoffMs = idleDelayMs
  await projector.reclaimExpired().catch(() => {})

  while (!signal?.aborted) {
    try {
      const result = await projector.projectBatch()
      backoffMs = idleDelayMs
      if (result.claimed === 0) {
        await projector.reclaimExpired().catch(() => {})
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
