import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runMigrations } from './postgres/index.mjs'

export {
  loadCommonConfig,
  assertProductId,
  productDatabaseName,
  productIndexPrefix,
  ConfigError,
} from './config.mjs'
export { createPool, runMigrations, withTransaction } from './postgres/index.mjs'
export * from './elasticsearch/index.mjs'
export { createQueue, startWorker, PostgresQueue, BullmqQueue, runWorker } from './queue/index.mjs'
export { createSegmenter, fallbackSegment, toPresegmentedText } from './segmenter/index.mjs'
export {
  runProbes,
  postgresProbe,
  elasticsearchProbe,
  queueProbe,
  segmenterProbe,
} from './health/index.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Apply mx-common's own schema (job queue, cursors) into a product database.
 *
 * Products call this before their own migrations. The files are tracked in the
 * same `schema_migrations` table but namespaced by filename, so the two sets
 * cannot collide.
 */
export function runCommonMigrations({ connectionString, logger = console }) {
  return runMigrations({
    connectionString,
    migrationsDir: resolve(packageRoot, 'migrations'),
    logger,
  })
}
