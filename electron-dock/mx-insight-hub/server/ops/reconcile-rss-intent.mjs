import pg from 'pg'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { PostgresStore } from '../stores/postgres-store.mjs'
import { rssSourceOptions } from './diagnose-rss-intent-migration.mjs'
import { reconcileRssSnapshot } from '../ingest/external/rss-snapshot.mjs'

async function main() {
  let hub, source
  try {
    const args = process.argv.slice(2)
    if (args.some(arg => !['--apply', '--dry-run'].includes(arg)) || args.length > 1) throw new Error('rss_arguments_invalid')
    if (!process.env.DATABASE_URL) throw new Error('hub_database_unconfigured')
    hub = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3,
      connectionTimeoutMillis: 5000, statement_timeout: 60000, application_name: 'hub-rss-snapshot' })
    const { rows } = await hub.query(`SELECT s.connection,s.database_connection_id,p.connection AS profile_connection
      FROM catalog.external_sources s LEFT JOIN catalog.database_connections p ON p.id=s.database_connection_id
      WHERE s.source_key='telegram-monitor-messages'`)
    const options = rssSourceOptions(rows[0])
    const dsn = options.connectionString ? new URL(options.connectionString) : null
    // Pin the physical origin without storing credentials; credential rotation
    // at the same endpoint remains allowed. A different origin needs review.
    const originFingerprint = createHash('sha256').update(JSON.stringify([
      dsn?.hostname || options.host, dsn?.port || String(options.port || 5432),
      dsn ? decodeURIComponent(dsn.pathname.slice(1)) : options.database,
    ])).digest('hex')
    source = new pg.Pool(options)
    let last = 0
    const report = await reconcileRssSnapshot({ sourcePool: source, hubPool: hub, store: new PostgresStore(hub),
      apply: args.includes('--apply'), originFingerprint, onProgress(report) {
        if (Date.now() - last > 10000) { process.stdout.write(JSON.stringify(report) + '\n'); last = Date.now() }
      } })
    process.stdout.write(JSON.stringify(report) + '\n')
  } catch (error) {
    // Driver messages may contain values or connection coordinates.
    const code = /^(rss_[a-z_]+|source_[a-z_]+|hub_database_unconfigured)$/.test(error.message)
      ? error.message : /^[A-Z0-9]{5}$/.test(error.code || '') ? error.code : 'rss_snapshot_failed'
    process.stdout.write(JSON.stringify({ version: 'rss-snapshot.v1', status: 'failed', code }) + '\n')
    process.exitCode = 1
  } finally { await source?.end(); await hub?.end() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
