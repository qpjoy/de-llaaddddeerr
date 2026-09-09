import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Distinct from mx-common's lock. Two Hub migration Jobs may overlap across
// operator hosts; a session lock serializes schema_migrations inspection and
// all product DDL, and is released automatically if Kubernetes kills the Pod.
const MIGRATION_LOCK_KEY = 0x4d58_0002

export async function acquireMigrationLock(client) {
  const { rows } = await client.query(
    'SELECT pg_try_advisory_lock($1) AS acquired',
    [MIGRATION_LOCK_KEY],
  )
  if (rows[0]?.acquired !== true) {
    throw new Error('Another MX Insight Hub migration is already running')
  }
}

export async function runMigrations({ connectionString, migrationsDir = resolve(projectRoot, 'migrations') }) {
  if (!connectionString) throw new Error('DATABASE_URL is required')
  const pool = new pg.Pool({ connectionString })
  const client = await pool.connect()
  let migrationLockAcquired = false
  try {
    await acquireMigrationLock(client)
    migrationLockAcquired = true
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    const filenames = (await readdir(migrationsDir))
      .filter((filename) => filename.endsWith('.sql'))
      .sort()
    for (const filename of filenames) {
      const sql = await readFile(resolve(migrationsDir, filename), 'utf8')
      const checksum = createHash('sha256').update(sql).digest('hex')
      const applied = await client.query(
        'SELECT checksum FROM schema_migrations WHERE filename = $1',
        [filename],
      )
      if (applied.rows[0]) {
        if (applied.rows[0].checksum !== checksum) {
          throw new Error(`Applied migration changed: ${filename}`)
        }
        continue
      }
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query(
          'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
          [filename, checksum],
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
      console.log(`applied ${filename}`)
    }
  } finally {
    if (migrationLockAcquired) {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {})
    }
    client.release()
    await pool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const connectionString = process.env.DATABASE_URL
  // mx-common's schema (job queue, cursors) first: Hub migrations may reference
  // `mxq` objects, and both sets share one `schema_migrations` table, keyed by
  // filename. The `mxcommon_` prefix keeps the two namespaces from colliding.
  const { runCommonMigrations } = await import('@qpjoy/mx-common')
  await runCommonMigrations({ connectionString })
  await runMigrations({ connectionString })
}
