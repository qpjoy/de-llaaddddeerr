import { PostgresQueue, runWorker as runPostgresWorker } from './postgres-queue.mjs'
import { BullmqQueue } from './bullmq-queue.mjs'

export { PostgresQueue, BullmqQueue }
export { runWorker } from './postgres-queue.mjs'

/**
 * Build the queue driver named by configuration.
 *
 * Default is `postgres`. That is a deliberate inversion of the usual instinct to
 * reach for Redis: the dominant requirement here is that a job and the row that
 * caused it commit together, and that a redeploy resumes unfinished work without
 * operator action. PostgreSQL gives both with no extra moving part. Redis buys
 * throughput this workload does not need, at the cost of a second store that can
 * be down or evict.
 */
export function createQueue(config, { pool, logger = console } = {}) {
  if (!pool) throw new Error('a PostgreSQL pool is required for the queue')
  const driver = config?.driver || 'postgres'
  if (driver === 'postgres') {
    return new PostgresQueue({
      pool,
      namespace: config.namespace,
      visibilityTimeoutMs: config.visibilityTimeoutMs,
      maxAttempts: config.maxAttempts,
      logger,
    })
  }
  if (driver === 'bullmq') {
    if (!config.redisUrl) throw new Error('MX_COMMON_REDIS_URL is required for the bullmq driver')
    return new BullmqQueue({
      pool,
      namespace: config.namespace,
      redisUrl: config.redisUrl,
      maxAttempts: config.maxAttempts,
      logger,
    })
  }
  throw new Error(`Unknown queue driver: ${driver}`)
}

/** Start a consumer against whichever driver is configured. */
export function startWorker(queue, options) {
  if (queue instanceof BullmqQueue) return queue.runWorker(options)
  return runPostgresWorker({ queue, ...options })
}
