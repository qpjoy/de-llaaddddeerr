import { migrate } from '../../packages/test-platform/server/migrate.mjs'
if (!process.env.MX_RIG_DATABASE_URL)
  throw new Error('MX_RIG_DATABASE_URL is required; never use the Launcher database')
const result = await migrate({ connectionString: process.env.MX_RIG_DATABASE_URL })
console.log(`MX Rig migrations: ${result.applied.length} applied / ${result.total}`)
