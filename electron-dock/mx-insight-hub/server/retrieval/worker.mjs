import { randomUUID } from 'node:crypto'
import { IndexingMetrics, observeMethods, observePool } from '../ops/indexing-metrics.mjs'
import { setTimeout as sleep } from 'node:timers/promises'
import { AppError } from '../core/errors.mjs'
import { estimateTokens } from '../embedding/chunker.mjs'
import { RetrievalJobs } from './control.mjs'

export async function processRetrievalJob({ jobs, pipeline, job, signal, logger = console }) {
  const abort = new AbortController()
  const onAbort = () => abort.abort(signal.reason)
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  let lost = null,
    heartbeat = Promise.resolve()
  const timer = setInterval(() => {
    heartbeat = heartbeat
      .then(() => jobs.heartbeat(job))
      .catch((error) => {
        lost = error
        abort.abort(error)
      })
  }, 30000)
  timer.unref?.()
  const check = async () => {
    if (lost) throw lost
    abort.signal.throwIfAborted()
    await jobs.heartbeat(job)
  }
  try {
    await check()
    await pipeline.materializeChunks({ recordId: job.record_id, limit: 1 })
    await pipeline.projectDeletions()
    if (job.retire) {
      await check()
      await jobs.complete(job)
      return
    }
    if (!pipeline.agent?.embeddings?.available)
      throw new AppError(503, 'embedding_not_ready', 'Embedding Sequence unavailable')
    while (true) {
      await check()
      const batch = await pipeline.embedPending({
        recordId: job.record_id,
        limit: 16,
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60000)]),
        beforeEmbed: async (texts, sourceRevision) => {
          await check()
          await jobs.reserveTokens(texts.reduce((sum, text) => sum + estimateTokens(text), 0), job, sourceRevision)
        },
      })
      if (batch.skipped) throw new AppError(503, 'embedding_not_ready', 'Embedding Sequence unavailable')
      if (!batch.embedded) break
    }
    while (true) {
      await check()
      const batch = await pipeline.projectPending({ recordId: job.record_id, limit: 32 })
      if (batch.failed) throw new AppError(503, 'chunk_projection_failed', 'Chunk projection failed')
      if (!batch.projected) break
    }
    const remaining = await jobs.pool.query(
      `SELECT 1 FROM core.record_chunks c JOIN core.canonical_records r ON r.id=c.record_id WHERE c.record_id=$1 AND r.deleted_at IS NULL AND c.source_revision=r.current_revision AND (c.embedded_at IS NULL OR c.projected_at IS NULL OR c.projection_schema<>2 OR c.projection_failed_at IS NOT NULL) LIMIT 1`,
      [job.record_id],
    )
    if (remaining.rows.length)
      throw new AppError(503, 'chunk_projection_failed', 'Chunks remain pending or quarantined')
    await check()
    await jobs.complete(job)
  } catch (error) {
    logger.warn?.(`[retrieval] job ${job.record_id}: ${error.code || 'failed'}`)
    await jobs.fail(job, error)
  } finally {
    clearInterval(timer)
    await heartbeat
    signal?.removeEventListener('abort', onAbort)
  }
}

export async function runRetrievalWorker({ pool, pipeline, signal, logger = console }) {
  const metrics = new IndexingMetrics()
  const observedPool = observePool(pool, metrics)
  const jobs = new RetrievalJobs(observedPool)
  // This pipeline belongs to this worker; public search and forwarding keep
  // their original clients. Wrappers preserve strict tokenizer / retry rules.
  pipeline.pool = observePool(pipeline.pool, metrics)
  pipeline.agent = observeMethods(pipeline.agent, metrics, 'embedding', ['embed'])
  pipeline.segmenter = observeMethods(pipeline.segmenter, metrics, 'hanlp', ['segment', 'segmentWithMeta'])
  pipeline.client = observeMethods(pipeline.client, metrics, 'elasticsearch', ['bulk', 'request'])
  const workerId = randomUUID()
  await pool.query('INSERT INTO retrieval.workers(id) VALUES($1)', [workerId])
  let beat = Promise.resolve(), reporting = false
  const timer = setInterval(() => {
    if (reporting) return
    reporting = true
    beat = pool.query('UPDATE retrieval.workers SET heartbeat_at=now(),telemetry=$2::jsonb WHERE id=$1',
      [workerId, JSON.stringify(metrics.snapshot())]).catch(() => {}).finally(() => { reporting = false })
  }, 10000)
  timer.unref?.()
  try {
    let housekeepingAt = 0
    while (!signal.aborted) {
      try {
        // Tombstones remain deliverable while new embedding is paused/unconfigured.
        await pipeline.projectDeletions({ limit: 100 })
        const settings = (await pool.query('SELECT enabled,paused FROM retrieval.settings WHERE id')).rows[0]
        if (!pipeline.enabled) {
          await sleep(2000, undefined, { signal })
          continue
        }
        const retireOnly = !settings?.enabled || settings.paused || !pipeline.agent?.embeddings?.available
        if (Date.now() - housekeepingAt > 5000) {
          if (!retireOnly) await jobs.seedBatch(250)
          await jobs.settleRun()
          housekeepingAt = Date.now()
        }
        const job = await jobs.claim({ retireOnly })
        if (!job) {
          await sleep(1000, undefined, { signal })
          continue
        }
        await processRetrievalJob({ jobs, pipeline, job, signal, logger })
      } catch (error) {
        if (signal.aborted) break
        logger.warn?.(`[retrieval] worker retry: ${error.code || 'dependency_unavailable'}`)
        await sleep(3000, undefined, { signal }).catch(() => {})
      }
    }
  } finally {
    clearInterval(timer)
    await beat
    await pool.query('DELETE FROM retrieval.workers WHERE id=$1', [workerId]).catch(() => {})
  }
}
