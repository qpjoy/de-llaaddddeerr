import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runMigrations } from '@qpjoy/mx-common/postgres'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function migrate({ connectionString, migrationsDir = resolve(projectRoot, 'migrations') }) {
  return runMigrations({ connectionString, migrationsDir })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const connectionString = process.env.MXT_DATABASE_URL || process.env.DATABASE_URL
  if (!connectionString) {
    console.error('MXT_DATABASE_URL is required')
    process.exit(1)
  }
  // Only this project's migrations. MXT does not use the mx-common job queue,
  // so pulling in `mxcommon_*` here would create tables nothing reads.
  const { applied, total } = await migrate({ connectionString })
  console.log(`mx-test-framework migrations: ${applied.length} applied, ${total} total`)
}
