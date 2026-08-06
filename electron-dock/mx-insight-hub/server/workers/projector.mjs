import process from 'node:process'
import { createPool, runCommonMigrations } from '@qpjoy/mx-common'
import { loadConfig } from '../config.mjs'
import { createSearch, ensureSearchIndices, runProjectorLoop } from '../search/index.mjs'
import { createAgent } from '../agent/index.mjs'
import { EmbeddingPipeline, runEmbeddingLoop } from '../embedding/pipeline.mjs'

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

  const report = await ensureSearchIndices(search, { logger })
  if (report.error) {
    // Do not exit: the cluster may be mid-restart, and a crash loop here would
    // delay the projector's recovery rather than help it. The loop retries.
    logger.warn(`[projector] starting with unreconciled indices: ${report.error}`)
  }
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

  // The embedding pipeline shares this workload because both write to
  // Elasticsearch through the same client and index definitions. They run as
  // independent loops so a stalled model provider cannot hold up the content
  // projection, which has no external dependency at all.
  const agent = createAgent({ config, logger })
  const embedding = new EmbeddingPipeline({
    pool,
    agent,
    client: search.client,
    segmenter: search.segmenter,
    chunkIndexSet: search.chunkIndexSet,
    logger,
  })

  logger.log(`[projector] draining outbox into ${search.indexSet.writeAlias}`)
  const loops = [runProjectorLoop(search.projector, { signal: controller.signal, logger })]

  if (embedding.enabled) {
    logger.log(`[embed] retrieval pipeline active -> ${search.chunkIndexSet.writeAlias}`)
    loops.push(runEmbeddingLoop(embedding, { signal: controller.signal, logger }))
  } else {
    // Say which half is missing. "Embeddings are off" is far less useful than
    // knowing whether it is the index or the provider that is unconfigured.
    logger.log(
      `[embed] retrieval pipeline idle (chunk index: ${search.chunkIndexSet ? 'configured' : 'missing MX_INSIGHT_EMBEDDING_DIMENSIONS'}, ` +
        `provider: ${agent.embeddings?.available ? 'configured' : 'missing MX_INSIGHT_EMBEDDING_PROVIDERS'})`,
    )
  }

  await Promise.all(loops)

  await pool.end()
  logger.log('[projector] stopped')
}

main().catch((error) => {
  logger.error(`[projector] fatal: ${error.stack || error.message}`)
  process.exit(1)
})
