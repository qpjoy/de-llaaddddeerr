// Read-only migration inventory. Run through stdin in the existing Hub Admin
// Pod; no application startup, HTTP, model, sync, grants or data writes.
import { pathToFileURL } from 'node:url'

const TABLES = ['rss_feeds', 'rss_items', 'rss_canonical_items', 'event_source_items']
const SOURCE_KEYS = ['telegram-monitor-messages', 'telegram-monitor-chats']
const CONFIG_ERRORS = new Set(['source_not_registered', 'source_profile_missing', 'source_transport_conflict',
  'source_dsn_unavailable', 'source_dsn_invalid', 'source_transport_unconfigured', 'source_ssl_mode_unsupported', 'hub_database_unconfigured'])
const failure = error => /^[A-Z0-9]{5}$/.test(error?.code || '') ? error.code
  : CONFIG_ERRORS.has(error?.message) ? error.message : 'diagnostic_read_failed'

export function rssSourceOptions(row, env = process.env) {
  if (!row) throw new Error('source_not_registered')
  const inline = row.connection || {}, profile = row.profile_connection
  const transport = profile || inline
  if (row.database_connection_id && !profile) throw new Error('source_profile_missing')
  if (profile && ['host', 'port', 'database', 'username', 'password', 'sslMode', 'dsnEnv'].some(key => Object.hasOwn(inline, key))) throw new Error('source_transport_conflict')
  let options
  if (transport.dsnEnv) {
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(transport.dsnEnv) || !env[transport.dsnEnv]) throw new Error('source_dsn_unavailable')
    if (['host', 'port', 'database', 'username', 'password'].some(key => Object.hasOwn(transport, key))) throw new Error('source_transport_conflict')
    const value = new URL(env[transport.dsnEnv])
    if (!['postgres:', 'postgresql:'].includes(value.protocol)) throw new Error('source_dsn_invalid')
    options = { connectionString: value.href }
  } else {
    if (!transport.host || !transport.database || !transport.username) throw new Error('source_transport_unconfigured')
    const sslMode = transport.sslMode ?? 'require'
    if (!['disable', 'require', 'verify-ca', 'verify-full'].includes(sslMode)) throw new Error('source_ssl_mode_unsupported')
    options = { host: transport.host, port: transport.port || 5432, database: transport.database,
      user: transport.username, password: transport.password,
      ssl: sslMode === 'disable' ? false : sslMode === 'verify-ca'
        ? { rejectUnauthorized: true, checkServerIdentity: () => undefined }
        : { rejectUnauthorized: sslMode === 'verify-full' } }
  }
  return { ...options, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 10000,
    options: '-c default_transaction_read_only=on', application_name: 'hub-rss-migration-readonly' }
}

async function readonly(pool, work) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '10s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'")
    const result = await work(client)
    await client.query('ROLLBACK')
    return result
  } finally { client.release() }
}

export async function inspectRssSource(pool) {
  return readonly(pool, async client => {
    const section = async (sql, params = []) => {
      await client.query('SAVEPOINT evidence')
      try {
        const { rows } = await client.query(sql, params)
        await client.query('RELEASE SAVEPOINT evidence')
        return { state: 'read', rows }
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT evidence')
        await client.query('RELEASE SAVEPOINT evidence')
        return { state: 'unavailable', code: failure(error), rows: null }
      }
    }
    const identity = await section(`SELECT current_database() AS database,
      current_setting('transaction_read_only') AS read_only`)
    const columns = await section(`SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[])
      ORDER BY table_name, ordinal_position`, [TABLES])
    const indexes = await section(`SELECT t.relname AS table_name, i.relname AS index_name,
      x.indisunique AS unique, x.indisprimary AS primary_key, x.indisvalid AS valid,
      pg_get_indexdef(i.oid) AS definition
      FROM pg_index x JOIN pg_class t ON t.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid
      JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='public' AND t.relname=ANY($1::text[]) ORDER BY t.relname,i.relname`, [TABLES])
    const tables = {}
    for (const name of TABLES) {
      const present = columns.rows?.some(row => row.table_name === name)
      // Identifiers come only from TABLES, never user input or a profile locator.
      tables[name] = present ? await section(`SELECT count(*)::text AS rows FROM public."${name}"`)
        : { state: columns.state === 'read' ? 'absent' : 'unavailable', rows: null }
    }
    const has = (table, column) => columns.rows?.some(row => row.table_name === table && row.column_name === column)
    const rss = has('rss_items', 'id') && has('rss_canonical_items', 'rss_item_id')
      ? await section(`SELECT
        (SELECT count(*)::text FROM public.rss_items r WHERE NOT EXISTS
          (SELECT 1 FROM public.rss_canonical_items c WHERE c.rss_item_id=r.id)) AS legacy_without_canonical,
        (SELECT count(*)::text FROM public.rss_canonical_items WHERE rss_item_id IS NULL) AS canonical_without_legacy_id`)
      : { state: 'unavailable', code: 'rss_relationship_columns_missing', rows: null }
    const news = has('event_source_items', 'source_type')
      ? await section(`SELECT source_type, count(*)::text AS rows FROM public.event_source_items
          GROUP BY source_type ORDER BY source_type LIMIT 51`)
      : { state: 'unavailable', code: 'event_source_type_missing', rows: null }
    return { identity, columns, indexes, tables, rss, news,
      fileFallbacks: 'not_inspected: Night-All rss-fetcher results and local news-results JSON require a separate runtime inventory' }
  })
}

export async function diagnoseRssMigration(hubPool, { sourcePoolFactory, env = process.env, sourceKey = SOURCE_KEYS[0] } = {}) {
  if (!SOURCE_KEYS.includes(sourceKey)) throw new Error('unsupported_source_key')
  let sourceRow
  const hub = await readonly(hubPool, async client => {
    const source = await client.query(`SELECT s.source_key, s.connection, s.database_connection_id,
      p.connection AS profile_connection FROM catalog.external_sources s
      LEFT JOIN catalog.database_connections p ON p.id=s.database_connection_id WHERE s.source_key=$1`, [sourceKey])
    sourceRow = source.rows[0]
    const registered = await client.query(`SELECT source_key,dataset_id,platform,status
      FROM catalog.external_sources WHERE platform='rss' OR source_key LIKE '%rss%'
      ORDER BY source_key LIMIT 51`)
    return { selectedConnectionSource: sourceKey, connectionRegistered: Boolean(sourceRow),
      rssSources: registered.rows.slice(0, 50), truncated: registered.rows.length > 50 }
  })
  const report = { version: 'rss-intent-migration-diagnostic.v1', status: 'incomplete', hub, source: null }
  let sourcePool
  try {
    sourcePool = sourcePoolFactory(rssSourceOptions(sourceRow, env))
    report.source = await inspectRssSource(sourcePool)
    const parts = [report.source.identity, report.source.columns, report.source.indexes,
      ...Object.values(report.source.tables), report.source.rss, report.source.news]
    if (parts.every(part => part.state === 'read') && !hub.truncated && report.source.news.rows.length <= 50) report.status = 'database_observed'
  } catch (error) {
    report.source = { state: 'unavailable', code: failure(error) }
  } finally { await sourcePool?.end() }
  return report
}

async function main() {
  let pool
  try {
    const { default: pg } = await import('pg')
    if (!process.env.DATABASE_URL) throw new Error('hub_database_unconfigured')
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000,
      options: '-c default_transaction_read_only=on', application_name: 'hub-rss-migration-readonly' })
    const report = await diagnoseRssMigration(pool, { sourcePoolFactory: options => new pg.Pool(options), sourceKey: process.argv[2] })
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    if (report.status !== 'database_observed') process.exitCode = 2
  } catch (error) {
    process.stdout.write(JSON.stringify({ version: 'rss-intent-migration-diagnostic.v1', status: 'incomplete', code: failure(error) }) + '\n')
    process.exitCode = 2
  } finally { await pool?.end() }
}
if (process.argv[1] === '-' || process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
