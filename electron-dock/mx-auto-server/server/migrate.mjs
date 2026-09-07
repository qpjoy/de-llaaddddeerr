import { pathToFileURL } from 'node:url'
import { mapExternalEnvironment } from './env.mjs'
import { importKernelModule } from './legacy.mjs'

export async function migrate(environment = process.env) {
  mapExternalEnvironment(environment, process.env)
  const connectionString = process.env.MXT_DATABASE_URL
  if (!connectionString) {
    throw new Error('MX_AUTO_DATABASE_URL is required')
  }
  const kernel = await importKernelModule('server/migrate.mjs', environment)
  return kernel.migrate({ connectionString })
}

async function main() {
  const { applied, total } = await migrate()
  console.log(`mx-auto-server V0 migrations: ${applied.length} applied, ${total} total`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
