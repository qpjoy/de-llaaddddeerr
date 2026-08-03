import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export async function runMigrations({ connectionString, migrationsDir = resolve(projectRoot, 'migrations') }) {
  if (!connectionString) throw new Error('DATABASE_URL is required')
  const pool = new pg.Pool({ connectionString })
  const client = await pool.connect()
  try {
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
    client.release()
    await pool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runMigrations({ connectionString: process.env.DATABASE_URL })
}
