import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { runMigrations as runCommonMigrations } from '@qpjoy/mx-common/postgres'
import { createPool } from './database.mjs'

export const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url))
export async function assertPaymentDatabase(pool) {
  const { rows } = await pool.query("SELECT to_regclass('public.tenants') AS hub, to_regclass('public.mx_platform_records') AS launcher, to_regclass('mx_pay.orders') AS legacy, to_regclass('pay_reporting.orders') AS reporting")
  if (rows[0].hub || rows[0].launcher || rows[0].legacy || rows[0].reporting) throw new Error('Refusing Hub/Launcher/reporting database: use dedicated mx-pay PostgreSQL')
}
export async function assertSchema(pool) {
  for (const name of (await readdir(migrationsDir)).filter(name => name.endsWith('.sql')).sort()) {
    const checksum = createHash('sha256').update(await readFile(resolve(migrationsDir, name))).digest('hex')
    const row = (await pool.query('SELECT checksum FROM schema_migrations WHERE filename=$1', [name])).rows[0]
    if (row?.checksum !== checksum) throw new Error('Payment migrations are missing or incompatible; run scripts/manage.sh deploy')
  }
}
export async function migrate(databaseUrl, logger = console, { runtimeRole = process.env.MX_PAY_RUNTIME_ROLE } = {}) {
  if (runtimeRole && !/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole)) throw new Error('Invalid runtime PostgreSQL role')
  const pool = createPool({ databaseUrl, maxConnections: 1 })
  try {
    await assertPaymentDatabase(pool)
    // The common runner supplies a session lock, immutable checksums and a transaction per file.
    const result = await runCommonMigrations({ connectionString: databaseUrl, migrationsDir, logger })
    if (runtimeRole) {
      // Deliberately allowlisted DML grants, reapplied after each schema update.
      // No ownership, schema CREATE, payment DELETE or audit UPDATE rights.
      // Session deletion is required for logout and single-use callbacks.
      const role = `"${runtimeRole}"`, client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(`GRANT USAGE ON SCHEMA pay TO ${role}`)
        await client.query(`GRANT SELECT ON public.schema_migrations TO ${role}`)
        await client.query(`GRANT SELECT, INSERT, UPDATE ON pay.orders, pay.settings, pay.outbox TO ${role}`)
        await client.query(`GRANT SELECT, INSERT ON pay.audit TO ${role}`)
        await client.query(`GRANT SELECT, INSERT ON pay.channel_bindings, pay.channel_observations TO ${role}`)
        await client.query(`GRANT SELECT, INSERT, UPDATE ON pay.channel_queries TO ${role}`)
        await client.query(`GRANT SELECT ON pay.reporting_source, pay.reporting_heads, pay.reporting_changes TO ${role}`)
        await client.query(`GRANT USAGE ON SCHEMA app_auth TO ${role}`)
        await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON app_auth.browser_sso_records TO ${role}`)
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK'); throw error }
      finally { client.release() }
    }
    return result
  } finally { await pool.end() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.env.MX_PAY_DATABASE_URL) throw new Error('MX_PAY_DATABASE_URL is required')
    await migrate(process.env.MX_PAY_DATABASE_URL)
  } catch (error) {
    // Do not echo connection strings or driver messages containing credentials.
    console.error('mx-pay migration failed; no API rollout is permitted.', error.code || error.name)
    process.exitCode = 1
  }
}
