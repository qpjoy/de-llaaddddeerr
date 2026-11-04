import pg from 'pg'
import { pathToFileURL } from 'node:url'
import { rssSourceOptions } from './diagnose-rss-intent-migration.mjs'
import { rssOriginFingerprint } from '../ingest/external/rss-snapshot.mjs'
import { reconcileRssFileLineage } from '../ingest/external/rss-file-lineage.mjs'

export async function readRssLineageInput(input) {
  let bytes = 0
  const chunks = []
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 32 * 1024 * 1024) throw new Error('rss_lineage_bundle_too_large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
async function main() {
  let hub, source
  try {
    const args = process.argv.slice(2)
    if (args.length > 1 || args.some(arg => !['--apply', '--dry-run'].includes(arg))) throw new Error('rss_arguments_invalid')
    const bundle = await readRssLineageInput(process.stdin)
    if (!process.env.DATABASE_URL) throw new Error('hub_database_unconfigured')
    hub = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1,
      connectionTimeoutMillis: 5000, statement_timeout: 30000, application_name: 'hub-rss-file-lineage' })
    const { rows } = await hub.query(`SELECT s.connection,s.database_connection_id,p.connection AS profile_connection
      FROM catalog.external_sources s LEFT JOIN catalog.database_connections p ON p.id=s.database_connection_id
      WHERE s.source_key='telegram-monitor-messages'`)
    const options = rssSourceOptions(rows[0])
    source = new pg.Pool(options)
    const report = await reconcileRssFileLineage({ sourcePool: source, hubPool: hub, bundle,
      originFingerprint: rssOriginFingerprint(options), apply: args.includes('--apply') })
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    if (report.status === 'blocked') process.exitCode = 2
  } catch (error) {
    const code = /^(rss_[a-z_]+|source_[a-z_]+|hub_database_unconfigured)$/.test(error.message)
      ? error.message : /^[A-Z0-9]{5}$/.test(error.code || '') ? error.code : 'rss_lineage_failed'
    process.stdout.write(JSON.stringify({ version: 'rss-file-lineage.v1', status: 'failed', code }) + '\n')
    process.exitCode = 1
  } finally { await source?.end(); await hub?.end() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
