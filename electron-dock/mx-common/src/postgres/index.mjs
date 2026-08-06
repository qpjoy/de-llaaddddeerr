import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import pg from 'pg'

// Advisory-lock key for the migration critical section. Two migration Jobs can
// overlap during a retried deploy; without this they interleave DDL and one
// fails on a half-created object. `pg_advisory_lock` is held for the session and
// released on disconnect, so a killed pod never leaves a stuck lock.
const MIGRATION_LOCK_KEY = 0x4d58_0001

export function createPool(config, { applicationName = 'mx-common' } = {}) {
  if (!config?.url) throw new Error('DATABASE_URL is required')
  return new pg.Pool({
    connectionString: config.url,
    max: config.maxConnections ?? 10,
    application_name: applicationName,
    // A runaway query must not pin a connection forever and starve the pool.
    statement_timeout: config.statementTimeoutMs ?? 30_000,
    idleTimeoutMillis: 30_000,
  })
}

/**
 * Apply ordered `.sql` migrations exactly once.
 *
 * Compatible with the existing `schema_migrations` table used by MX products, so
 * adopting this runner does not reapply or invalidate already-applied files.
 * Each file runs inside its own transaction: a failure rolls back that file only
 * and leaves every earlier file applied, which is what makes a retried deploy
 * resume rather than restart.
 */
export async function runMigrations({ connectionString, migrationsDir, logger = console }) {
  if (!connectionString) throw new Error('DATABASE_URL is required')
  const pool = new pg.Pool({ connectionString, max: 1, application_name: 'mx-common-migrate' })
  const client = await pool.connect()
  const applied = []
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)

    const filenames = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort()
    for (const filename of filenames) {
      const sql = await readFile(resolve(migrationsDir, filename), 'utf8')
      const checksum = createHash('sha256').update(sql).digest('hex')
      const existing = await client.query(
        'SELECT checksum FROM schema_migrations WHERE filename = $1',
        [filename],
      )
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) {
          throw new Error(
            `Applied migration changed on disk: ${filename}. Migrations are immutable; add a new file instead.`,
          )
        }
        continue
      }
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [
          filename,
          checksum,
        ])
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw new Error(`Migration ${filename} failed: ${error.message}`, { cause: error })
      }
      applied.push(filename)
      logger?.log?.(`applied ${filename}`)
    }
    return { applied, total: filenames.length }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {})
    client.release()
    await pool.end()
  }
}

/** Run `fn` inside a transaction, rolling back on any throw. */
export async function withTransaction(pool, fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
