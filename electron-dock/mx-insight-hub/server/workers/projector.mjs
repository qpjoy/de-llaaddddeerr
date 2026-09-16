import process from 'node:process'
import { createPool, runCommonMigrations } from '@qpjoy/mx-common'
import { loadConfig } from '../config.mjs'
import {
  createSearch,
  ensureSearchIndices,
  runProjectorLoop,
  startupRebuildEnabled,
} from '../search/index.mjs'
import { requiredReindexBackend, requireSegmenterBackend } from '../search/reindex-integrity.mjs'
import {
  monitorSearchReindexLock,
  requireSearchReindexLock,
} from '../search/reindex-lock.mjs'

// Projector worker entrypoint.
//
// Runs as its own workload rather than inside the API process, for two reasons:
// a bulk-indexing loop and a latency-sensitive request path compete badly for
// the same event loop, and the projector must be independently restartable
// without dropping in-flight API requests.

const logger = console

async function main() {
  const config = loadConfig()
  if (config.storeDriver !== 'postgres') {
    logger.error('[projector] requires MX_INSIGHT_STORE=postgres; refusing to start')
    process.exit(2)
  }

  const pool = createPool(config.common.postgres, { applicationName: 'mx-insight-hub-projector' })
  const search = createSearch({ pool, config: config.common, logger })

  if (!search.client) {
    logger.error('[projector] MX_COMMON_ELASTICSEARCH_URL is not configured; refusing to start')
    process.exit(2)
  }

  // The queue schema belongs to mx-common and is needed by backfill jobs that
  // share this database. Applying it here keeps the projector deployable on its
  // own, without ordering it behind the API's migration Job.
  await runCommonMigrations({ connectionString: config.common.postgres.url, logger })

  // Every index writer requires one verified tokenizer backend. Canonical
  // ingest remains independent in PostgreSQL, while projection waits and
  // retries instead of mixing HanLP and downgraded tokens in one index.
  // Request-side query segmentation deliberately keeps the fail-soft segmenter.
  const strictProjectionSegmenter = requireSegmenterBackend(search.segmenter, {
    expectedBackend: requiredReindexBackend(config.common.segmenter),
    maxBatch: search.segmenterBatchSize,
    logger,
  })
  search.projector.segmenter = strictProjectionSegmenter
  // Whether this restart replays the corpus is an operator setting, not a
  // consequence of restarting. Read before taking the lock: a schema-only pass
  // is milliseconds and must not queue behind, or block, anything.
  const rebuildOnStartup = await startupRebuildEnabled(pool)
  if (!rebuildOnStartup) {
    logger.log('[projector] startup rebuild is disabled; reconciling schema only and serving')
  }
  const startupReindexLock = await requireSearchReindexLock(pool, {
    busyMessage: 'an Admin or CLI full search reindex is running; exiting so the supervisor retries startup',
  })
  const lockHeartbeat = monitorSearchReindexLock(startupReindexLock)
  let report
  try {
    await lockHeartbeat.pulse()
    report = await ensureSearchIndices({
      ...search,
      segmenter: strictProjectionSegmenter,
    }, {
      logger,
      failOnError: true,
      schemaOnly: !rebuildOnStartup,
      forceFull: rebuildOnStartup,
      onProgress: () => lockHeartbeat.pulse(),
    })
    await lockHeartbeat.pulse()
  } finally {
    await lockHeartbeat.stop()
    await startupReindexLock.release()
  }
  // A failed reconciliation must not fall through to runProjectorLoop: that
  // loop retries outbox delivery, not schema/snapshot reconciliation. Let the
  // fatal handler exit non-zero so the Deployment restarts this startup phase
  // with its normal backoff.
  if (report.content?.mappingConflict) {
    logger.warn(
      `[projector] mapping conflict on ${search.indexSet.writeAlias}: ${report.content.mappingConflict}. ` +
        'New fields are not queryable until a schema-version bump and reindex.',
    )
  }

  const controller = new AbortController()
  const shutdown = (signal) => {
    logger.log(`[projector] ${signal} received; finishing current batch`)
    controller.abort()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  logger.log(`[projector] draining outbox into ${search.indexSet.writeAlias}`)
  // Embedding is drained by the independently budgeted retrieval workload.
  await runProjectorLoop(search.projector, { signal: controller.signal, logger })
  await pool.end()
  logger.log('[projector] stopped')
}

main().catch((error) => {
  logger.error(`[projector] fatal: ${error.stack || error.message}`)
  process.exit(1)
})
