import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'

// Lease-based job queue on PostgreSQL. Schema: migrations/001_queue.sql.
//
// Chosen as the default driver over BullMQ for one reason that matters more than
// throughput: `enqueue` accepts an existing client, so a job can be written in
// the same transaction as the data that justifies it. Redis cannot participate
// in a PostgreSQL transaction, so a BullMQ enqueue after COMMIT has a window
// where the row exists and the follow-up work does not.
//
// Throughput ceiling is roughly thousands of jobs/second on one node, which is
// far above ingest volume here. Switch to BullMQ only when that stops being true.

const WORKER_ID = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`

function assertPayloadMatch(payloadMatch) {
  if (payloadMatch === null || typeof payloadMatch !== 'object' || Array.isArray(payloadMatch)) {
    throw new TypeError('payloadMatch must be a plain object')
  }
}

export class PostgresQueue {
  constructor({ pool, namespace, visibilityTimeoutMs = 120_000, maxAttempts = 5, logger = console }) {
    this.pool = pool
    this.namespace = namespace
    this.visibilityTimeoutMs = visibilityTimeoutMs
    this.maxAttempts = maxAttempts
    this.logger = logger
    this.workerId = WORKER_ID
  }

  #queueName(queue) {
    return `${this.namespace}:${queue}`
  }

  /**
   * Enqueue one job.
   *
   * Pass `client` to enlist in a caller-owned transaction — the whole point of
   * this driver. Without it the insert is autocommitted on its own connection.
   */
  async enqueue(
    queue,
    payload,
    { client = null, dedupeKey = null, runAt = null, priority = 100, maxAttempts = null } = {},
  ) {
    const executor = client || this.pool
    const { rows } = await executor.query(
      `INSERT INTO mxq.jobs (queue, payload, dedupe_key, run_at, priority, max_attempts)
       VALUES ($1, $2, $3, coalesce($4, now()), $5, $6)
       ON CONFLICT (queue, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','running')
       DO NOTHING
       RETURNING id`,
      [
        this.#queueName(queue),
        payload,
        dedupeKey,
        runAt,
        priority,
        maxAttempts ?? this.maxAttempts,
      ],
    )
    // No row means an identical job is already outstanding; that is a success.
    return rows[0]?.id ?? null
  }

  /**
   * Atomically claim up to `limit` ready jobs.
   *
   * `FOR UPDATE SKIP LOCKED` is what allows several workers to drain the same
   * queue without coordination: each transaction takes rows nobody else holds
   * instead of blocking on them.
   */
  async claim(queue, limit = 1) {
    const { rows } = await this.pool.query(
      `UPDATE mxq.jobs AS j
          SET status = 'running',
              attempts = j.attempts + 1,
              lease_expires_at = now() + make_interval(secs => $3),
              locked_by = $4,
              updated_at = now()
        WHERE j.id IN (
          SELECT id FROM mxq.jobs
           WHERE queue = $1 AND status = 'pending' AND run_at <= now()
           ORDER BY priority, run_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT $2
        )
        RETURNING j.id, j.queue, j.payload, j.attempts, j.max_attempts`,
      [this.#queueName(queue), limit, this.visibilityTimeoutMs / 1000, this.workerId],
    )
    return rows
  }

  async complete(jobId) {
    await this.pool.query(
      `UPDATE mxq.jobs
          SET status = 'done', completed_at = now(), updated_at = now(),
              lease_expires_at = NULL, locked_by = NULL, last_error = NULL
        WHERE id = $1`,
      [jobId],
    )
  }

  /**
   * Record a failure and decide retry vs dead letter.
   *
   * Backoff is exponential with a 1h ceiling. Jobs that exhaust `max_attempts`
   * become `dead` and stay in the table: a dead-letter row is evidence, and
   * deleting it would erase the only record that work was lost.
   */
  async fail(job, error) {
    const exhausted = job.attempts >= job.max_attempts
    const backoffSeconds = Math.min(2 ** job.attempts * 5, 3_600)
    await this.pool.query(
      `UPDATE mxq.jobs
          SET status = $2,
              run_at = CASE WHEN $2 = 'pending' THEN now() + make_interval(secs => $3) ELSE run_at END,
              last_error = $4,
              lease_expires_at = NULL,
              locked_by = NULL,
              updated_at = now()
        WHERE id = $1`,
      [job.id, exhausted ? 'dead' : 'pending', backoffSeconds, String(error?.message || error).slice(0, 2_000)],
    )
    if (exhausted) {
      this.logger?.error?.(`[mx-common] job ${job.id} (${job.queue}) dead after ${job.attempts} attempts`)
    }
  }

  /**
   * Return jobs whose worker vanished to the pending pool.
   *
   * This is the "resume after redeploy" mechanism: a rollout kills workers
   * mid-job, their leases lapse, and the next sweep re-queues exactly the jobs
   * that never finished. Call it on startup and then periodically.
   */
  async reclaimExpired() {
    const { rowCount } = await this.pool.query(
      `UPDATE mxq.jobs
          SET status = 'pending', lease_expires_at = NULL, locked_by = NULL, updated_at = now()
        WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < now()`,
    )
    if (rowCount > 0) this.logger?.warn?.(`[mx-common] reclaimed ${rowCount} expired job lease(s)`)
    return rowCount
  }

  /** Extend the lease of a long-running job so the sweep does not steal it. */
  async heartbeat(jobId) {
    await this.pool.query(
      `UPDATE mxq.jobs
          SET lease_expires_at = now() + make_interval(secs => $2), updated_at = now()
        WHERE id = $1 AND status = 'running'`,
      [jobId, this.visibilityTimeoutMs / 1000],
    )
  }

  async stats(queue = null) {
    const { rows } = await this.pool.query(
      `SELECT queue, status, count(*)::int AS count
         FROM mxq.jobs
        WHERE ($1::text IS NULL OR queue = $1)
        GROUP BY queue, status`,
      [queue ? this.#queueName(queue) : null],
    )
    return rows
  }

  /** Return whether this namespaced queue has a pending/running matching job. */
  async hasOutstandingJob(queue, payloadMatch) {
    assertPayloadMatch(payloadMatch)
    const { rows } = await this.pool.query(
      `SELECT EXISTS (
         SELECT 1
           FROM mxq.jobs
          WHERE queue = $1
            AND status IN ('pending', 'running')
            AND payload @> $2::jsonb
       ) AS outstanding`,
      [this.#queueName(queue), payloadMatch],
    )
    return rows[0]?.outstanding === true
  }

  // ---- durable cursors -------------------------------------------------

  async getCursor(id) {
    const { rows } = await this.pool.query('SELECT * FROM mxq.cursors WHERE id = $1', [id])
    return rows[0] || null
  }

  async saveCursor(id, position, { status = 'running', processedDelta = 0, error = null } = {}) {
    const { rows } = await this.pool.query(
      `INSERT INTO mxq.cursors (id, position, status, processed_count, last_error, started_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now())
       ON CONFLICT (id) DO UPDATE SET
         position = EXCLUDED.position,
         status = EXCLUDED.status,
         processed_count = mxq.cursors.processed_count + $4,
         last_error = EXCLUDED.last_error,
         updated_at = now()
       RETURNING *`,
      [id, position, status, processedDelta, error],
    )
    return rows[0]
  }
}

/**
 * Poll-and-process loop.
 *
 * Backs off to `idleDelayMs` when a queue is empty so an idle worker does not
 * hammer PostgreSQL, and drains at full speed while work exists.
 */
export function runWorker({
  queue,
  name,
  handler,
  concurrency = 4,
  idleDelayMs = 1_000,
  reclaimIntervalMs = 30_000,
  logger = console,
  signal,
}) {
  let stopped = false
  const stop = () => {
    stopped = true
  }
  signal?.addEventListener('abort', stop, { once: true })

  const reclaimTimer = setInterval(() => {
    queue.reclaimExpired().catch((error) => logger?.error?.(`[mx-common] reclaim failed: ${error.message}`))
  }, reclaimIntervalMs)
  reclaimTimer.unref?.()

  const loop = (async () => {
    // Startup sweep: whatever the previous pod was holding when it died is
    // returned to the pool before this one starts claiming.
    await queue.reclaimExpired().catch(() => {})
    while (!stopped) {
      let jobs = []
      try {
        jobs = await queue.claim(name, concurrency)
      } catch (error) {
        logger?.error?.(`[mx-common] claim failed on ${name}: ${error.message}`)
        await delay(idleDelayMs)
        continue
      }
      if (jobs.length === 0) {
        await delay(idleDelayMs)
        continue
      }
      await Promise.all(
        jobs.map(async (job) => {
          try {
            await handler(job.payload, job)
            await queue.complete(job.id)
          } catch (error) {
            logger?.error?.(`[mx-common] job ${job.id} failed: ${error.message}`)
            await queue.fail(job, error).catch(() => {})
          }
        }),
      )
    }
    clearInterval(reclaimTimer)
  })()

  return { stop, done: loop }
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
