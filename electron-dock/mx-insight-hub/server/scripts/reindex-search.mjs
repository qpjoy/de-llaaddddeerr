import process from 'node:process'
import { createPool } from '@qpjoy/mx-common'
import { loadConfig } from '../config.mjs'
import { createSearch, ensureSearchIndices } from '../search/index.mjs'
import {
  monitorSearchReindexLock,
  requireSearchReindexLock,
} from '../search/reindex-lock.mjs'
import { requiredReindexBackend, requireSegmenterBackend } from '../search/reindex-integrity.mjs'

const logger = console

async function main() {
  const config = loadConfig()
  if (config.storeDriver !== 'postgres') {
    throw new Error('search reindex requires MX_INSIGHT_STORE=postgres')
  }

  const pool = createPool(config.common.postgres, {
    applicationName: 'mx-insight-hub-reindex',
  })
  let reindexLock = null
  let lockHeartbeat = null
  try {
    reindexLock = await requireSearchReindexLock(pool, {
      busyMessage: 'another CLI, Admin, or Projector search reindex is already running',
    })
    lockHeartbeat = monitorSearchReindexLock(reindexLock)
    const search = createSearch({ pool, config: config.common, logger })
    if (!search.client) throw new Error('MX_COMMON_ELASTICSEARCH_URL is not configured')
    const expectedBackend = requiredReindexBackend(config.common.segmenter)

    const strictSegmenter = requireSegmenterBackend(search.segmenter, {
      expectedBackend,
      maxBatch: search.segmenterBatchSize,
      logger,
    })
    // Verify provenance even for an empty database, where the snapshot itself
    // would otherwise make no tokenizer calls.
    await strictSegmenter.segmentWithMeta('吴恩达与人工智能')
    await lockHeartbeat.pulse()

    const report = await ensureSearchIndices({
      ...search,
      segmenter: strictSegmenter,
    }, {
      logger,
      forceFull: true,
      onProgress: () => lockHeartbeat.pulse(),
    })
    await lockHeartbeat.pulse()
    if (report.error) throw new Error(report.error)
    const conflict = report.content?.mappingConflict || report.chunk?.mappingConflict
    if (conflict) throw new Error(`search mapping conflict: ${conflict}`)

    logger.log(`[reindex] completed with verified tokenizer backend=${expectedBackend}`)
  } finally {
    await lockHeartbeat?.stop()
    await reindexLock?.release()
    await pool.end()
  }
}

main().catch((error) => {
  logger.error(`[reindex] fatal: ${error.stack || error.message}`)
  process.exitCode = 1
})
