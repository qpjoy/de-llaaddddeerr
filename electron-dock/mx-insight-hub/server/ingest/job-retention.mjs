// Done-job retention for mxq.jobs.
//
// The queue keeps every finished job, so the table and its TOAST grow without
// bound. Nothing reads a done row after its own request: settlement reconciles
// its ingest job within seconds, the dedupe index covers only pending/running,
// and the diagnostics fall back to ingest.ingest_runs. Done rows older than the
// retention window are therefore deleted here. Pending, running and dead rows
// are never touched: a dead row is the only record that work was lost.
//
// Deleting is not free. Each first touch of a heap or TOAST page after a
// checkpoint writes a full-page image, so removing a row costs about its
// stored payload in WAL (measured 1.0x, plus 0.04x for the VACUUM). The pass
// is paced by payload bytes so a large backlog drains over hours instead of
// competing with ingest and settlement for the same disk.
//
// docs/operations/delivery-write-amplification-2026-10-21.md

const RETENTION_DAYS = 14
const BATCH_ROWS = 200
const MIN_PAUSE_MS = 2_000
const DURATION_PAUSE_FACTOR = 4
const PAYLOAD_BYTES_PER_HOUR = 1024 ** 3
const INITIAL_DELAY_MS = 60_000
const PASS_INTERVAL_MS = 10 * 60_000
// Passes resume where the previous one stopped. A job that was still pending
// when a pass went by and finished later is picked up by this periodic full
// rescan (and by every process start).
const FULL_RESCAN_MS = 24 * 60 * 60_000

/** Pause after a batch: the longest of a floor, its duration and its byte budget. */
export function retentionPauseMs({
  durationMs,
  payloadBytes,
  minPauseMs = MIN_PAUSE_MS,
  payloadBytesPerHour = PAYLOAD_BYTES_PER_HOUR,
}) {
  return Math.ceil(Math.max(
    minPauseMs,
    durationMs * DURATION_PAUSE_FACTOR,
    (payloadBytes * 3_600_000) / payloadBytesPerHour,
  ))
}

/**
 * Delete expired done rows among the next `batchRows` jobs after `afterId`.
 *
 * The window is taken in primary-key order, so no index beyond the primary key
 * is needed. Ids grow with creation time, so the first row created inside the
 * retention window marks where the expired region ends.
 */
export async function pruneDoneJobsBatch(pool, {
  afterId = 0,
  retentionDays = RETENTION_DAYS,
  batchRows = BATCH_ROWS,
} = {}) {
  const client = await pool.connect()
  let releaseError
  try {
    await client.query('BEGIN')
    // Done rows are never locked by the queue, so a wait means something
    // unusual holds them; give up quickly and retry on the next pass. A lost
    // commit only leaves rows for the next pass to delete.
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL statement_timeout = '15s'")
    await client.query('SET LOCAL synchronous_commit = off')
    const { rows: [result] } = await client.query(
      `WITH scanned AS (
         SELECT id, created_at
           FROM mxq.jobs
          WHERE id > $1
          ORDER BY id
          LIMIT $2
       ),
       removed AS (
         DELETE FROM mxq.jobs AS job
          USING scanned
          WHERE job.id = scanned.id
            AND job.status = 'done'
            AND job.completed_at < now() - make_interval(days => $3)
         RETURNING pg_column_size(job.payload) AS payload_bytes
       )
       SELECT (SELECT max(id) FROM scanned) AS last_id,
              (SELECT count(*) FROM scanned)::int AS scanned,
              (SELECT min(id) FROM scanned
                WHERE created_at >= now() - make_interval(days => $3)) AS first_recent_id,
              (SELECT count(*) FROM removed)::int AS deleted,
              (SELECT coalesce(sum(payload_bytes), 0) FROM removed)::bigint AS payload_bytes`,
      [afterId, batchRows, retentionDays],
    )
    await client.query('COMMIT')
    return {
      lastId: result.last_id == null ? null : Number(result.last_id),
      scanned: result.scanned,
      firstRecentId: result.first_recent_id == null ? null : Number(result.first_recent_id),
      deleted: result.deleted,
      payloadBytes: Number(result.payload_bytes),
    }
  } catch (error) {
    await client.query('ROLLBACK').catch((rollbackError) => { releaseError = rollbackError })
    throw error
  } finally {
    client.release(releaseError)
  }
}

/**
 * One pass from `afterId` until the retention window or the end of the table.
 * Returns where the next pass should resume.
 */
export async function pruneDoneJobsPass(pool, {
  afterId = 0,
  retentionDays = RETENTION_DAYS,
  batchRows = BATCH_ROWS,
  minPauseMs = MIN_PAUSE_MS,
  payloadBytesPerHour = PAYLOAD_BYTES_PER_HOUR,
  signal,
  wait = delay,
} = {}) {
  let cursor = afterId
  let batches = 0
  let deleted = 0
  let payloadBytes = 0
  while (!signal?.aborted) {
    const startedAt = Date.now()
    const batch = await pruneDoneJobsBatch(pool, { afterId: cursor, retentionDays, batchRows })
    batches += 1
    deleted += batch.deleted
    payloadBytes += batch.payloadBytes
    if (batch.scanned === 0) break
    if (batch.firstRecentId != null) {
      cursor = batch.firstRecentId - 1
      break
    }
    cursor = batch.lastId
    await wait(retentionPauseMs({
      durationMs: Date.now() - startedAt,
      payloadBytes: batch.payloadBytes,
      minPauseMs,
      payloadBytesPerHour,
    }), signal)
  }
  return { cursor, batches, deleted, payloadBytes }
}

/** Background loop for the ingest worker. Resolves once `signal` aborts. */
export async function runJobRetention({
  pool,
  signal,
  logger = console,
  afterId = 0,
  initialDelayMs = INITIAL_DELAY_MS,
  passIntervalMs = PASS_INTERVAL_MS,
  ...passOptions
}) {
  let cursor = afterId
  let rescanAt = Date.now() + FULL_RESCAN_MS
  await delay(initialDelayMs, signal)
  while (!signal?.aborted) {
    if (Date.now() >= rescanAt) {
      cursor = 0
      rescanAt = Date.now() + FULL_RESCAN_MS
    }
    try {
      const pass = await pruneDoneJobsPass(pool, { ...passOptions, afterId: cursor, signal })
      cursor = pass.cursor
      if (pass.deleted > 0) {
        logger?.log?.(
          `[ingest] job retention: deleted ${pass.deleted} done job(s), `
            + `${(pass.payloadBytes / 1024 ** 2).toFixed(1)} MiB payload, in ${pass.batches} batch(es)`,
        )
      }
    } catch (error) {
      // Lock or statement timeouts and transient database errors just end
      // this pass; the next one starts from the same cursor.
      logger?.warn?.(`[ingest] job retention pass stopped: ${error.code || error.message}`)
    }
    await delay(passIntervalMs, signal)
  }
}

function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    timer.unref?.()
    signal?.addEventListener('abort', finish, { once: true })
  })
}
