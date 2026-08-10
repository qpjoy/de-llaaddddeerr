import process from 'node:process'
import { createPool, createQueue, runCommonMigrations, startWorker } from '@qpjoy/mx-common'
import { NightAllAdapter } from '../adapters/night-all.mjs'
import { loadConfig } from '../config.mjs'
import { NightAllBackfill } from '../ingest/backfill.mjs'
import { DatabaseSourcePuller } from '../ingest/external/database-source.mjs'
import { ProviderRegistry } from '../ingest/external/provider-registry.mjs'
import { runExternalPullScheduler } from '../ingest/external/scheduler.mjs'
import { EXTERNAL_PULL_QUEUE, runExternalPullJob } from '../ingest/external/sync-job.mjs'
import { createPostgresStore } from '../stores/postgres-store.mjs'

// Ingest worker: drains queued search results and runs Night-All backfills.
//
// Separate from the API for latency, and separate from the projector because
// they fail for different reasons and should be restartable independently — the
// projector depends on Elasticsearch, this worker only on PostgreSQL and
// Night-All. Collapsing them would make a search outage stop ingestion.

const logger = console
const INGEST_QUEUE = 'ingest'
const BACKFILL_QUEUE = 'backfill'

async function main() {
  const config = loadConfig()
  if (config.storeDriver !== 'postgres') {
    logger.error('[ingest] requires MX_INSIGHT_STORE=postgres; refusing to start')
    process.exit(2)
  }

  const pool = createPool(config.common.postgres, { applicationName: 'mx-insight-hub-ingest' })
  await runCommonMigrations({ connectionString: config.common.postgres.url, logger })

  const store = await createPostgresStore({ connectionString: config.databaseUrl })
  const adapter = new NightAllAdapter(config.nightAll)
  // Force the PostgreSQL driver regardless of configuration: this worker's
  // producer side writes jobs inside the commit transaction, so its consumer
  // has to read from the same table.
  const queue = createQueue({ ...config.common.queue, driver: 'postgres' }, { pool, logger })
  const backfill = new NightAllBackfill({ store, adapter, queue, logger })
  const providerRegistry = config.providerMasterKey
    ? new ProviderRegistry({ store, masterKey: config.providerMasterKey })
    : null
  const databasePuller = new DatabaseSourcePuller({ store, queue, logger, providerRegistry })

  const controller = new AbortController()
  const shutdown = (signal) => {
    logger.log(`[ingest] ${signal} received; finishing current job`)
    controller.abort()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  async function handleIngest(payload) {
    if (payload?.kind !== 'search-result') {
      throw new Error(`Unknown ingest payload kind: ${payload?.kind}`)
    }
    const result = await store.ingestSearchResult({
      platform: payload.platform,
      rawPayload: payload.rawPayload,
      queryFingerprint: payload.queryFingerprint ?? null,
      requestId: payload.requestId ?? null,
    })
    logger.log(
      `[ingest] ${payload.platform} request=${payload.requestId} ingested=${result.ingested} changed=${result.changed} skipped=${result.skipped}`,
    )
  }

  async function handleBackfill(payload, job) {
    const platform = payload?.platform
    if (!platform) throw new Error('backfill payload is missing platform')

    const result = await backfill.runPlatform(platform, {
      maxPages: payload.maxPages ?? 50,
      since: payload.since ?? null,
      signal: controller.signal,
      // A page can take a while; extend the lease as we go so the reclaim sweep
      // does not decide this worker died and hand the job to a second one.
      onProgress: () => queue.heartbeat(job.id).catch(() => {}),
    })
    logger.log(
      `[backfill] ${platform} pages=${result.pages} ingested=${result.ingested} changed=${result.changed} done=${result.done}`,
    )

    // Not finished: re-enqueue to continue from the durable cursor. Chunking
    // this way keeps every unit of work short enough that a rollout never loses
    // more than one page of progress.
    //
    // The dedupe key carries a chunk counter, and it has to. The continuation is
    // enqueued while THIS job is still `running`, and the queue's uniqueness
    // index spans ('pending','running') — reusing `backfill:<platform>` would
    // collide with the very job doing the enqueueing, get swallowed by ON
    // CONFLICT DO NOTHING, and stall the backfill after one chunk with no error
    // anywhere. A monotonic counter keeps duplicate *submissions* deduped while
    // letting a chunk hand off to its successor.
    if (!result.done && !controller.signal.aborted) {
      const nextChunk = (payload.chunk ?? 0) + 1
      await queue.enqueue(
        BACKFILL_QUEUE,
        { ...payload, chunk: nextChunk },
        { dedupeKey: `backfill:${platform}:${nextChunk}`, priority: 200 },
      )
    }
  }

  async function handleExternalPull(payload, job) {
    return runExternalPullJob({
      puller: databasePuller,
      queue,
      payload,
      job,
      signal: controller.signal,
      logger,
    })
  }

  const workers = [
    startLoop(queue, INGEST_QUEUE, handleIngest, controller.signal),
    // Backfill runs at concurrency 1: it is a bulk scan, and running several in
    // parallel would compete with the latency-sensitive ingest queue for the
    // same connection pool.
    startLoop(queue, BACKFILL_QUEUE, handleBackfill, controller.signal, 1),
    // Foreign-table scans are bulk I/O just like backfill. One at a time keeps
    // them from competing with latency-sensitive search-result ingestion.
    startLoop(queue, EXTERNAL_PULL_QUEUE, handleExternalPull, controller.signal, 1),
    runExternalPullScheduler({
      store,
      queue,
      batchSize: config.externalPull.batchSize,
      intervalMs: config.externalPull.intervalMs,
      signal: controller.signal,
      logger,
    }),
  ]

  logger.log('[ingest] draining ingest and backfill queues')
  await Promise.all(workers)
  await store.close()
  await pool.end()
  logger.log('[ingest] stopped')
}

function startLoop(queue, name, handler, signal, concurrency = 4) {
  return startWorker(queue, { name, handler, concurrency, signal, logger }).done
}

main().catch((error) => {
  logger.error(`[ingest] fatal: ${error.stack || error.message}`)
  process.exit(1)
})
