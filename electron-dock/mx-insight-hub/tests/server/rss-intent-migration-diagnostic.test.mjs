import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { rssSourceOptions, diagnoseRssMigration, inspectRssSource } from '../../server/ops/diagnose-rss-intent-migration.mjs'

const connection = { host: 'source.invalid', database: 'synthetic', username: 'reader', password: 'never-print-this' }
const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const pool = db => ({ async connect() { return { query: (sql, args) => db.query(sql, args), release() {} } }, async end() {} })

test('source connection is profile-owned, read-only and excludes locator configuration', () => {
  const options = rssSourceOptions({ connection: { schema: 'public', table: 'tg_monitor_messages' },
    database_connection_id: 'fixture', profile_connection: connection })
  assert.equal(options.password, connection.password)
  assert.equal(options.options, '-c default_transaction_read_only=on')
  assert.equal(options.max, 1)
  assert.deepEqual(options.ssl, { rejectUnauthorized: false }, 'Match the existing source reader require default')
  assert.equal(rssSourceOptions({ connection: { ...connection, sslMode: 'disable' } }).ssl, false)
  const verifyCa = rssSourceOptions({ connection: { ...connection, sslMode: 'verify-ca' } }).ssl
  assert.equal(verifyCa.rejectUnauthorized, true)
  assert.equal(verifyCa.checkServerIdentity(), undefined)
  assert.equal(options.table, undefined)
  assert.throws(() => rssSourceOptions({ connection, database_connection_id: 'fixture' }), /source_profile_missing/)
  assert.throws(() => rssSourceOptions({ connection, database_connection_id: 'fixture', profile_connection: connection }), /source_transport_conflict/)
  assert.throws(() => rssSourceOptions({ connection: { dsnEnv: 'MISSING' } }, {}), /source_dsn_unavailable/)
  assert.throws(() => rssSourceOptions({ connection: { dsnEnv: 'SOURCE', host: 'conflict' } }, { SOURCE: 'postgres://reader:secret@source/db' }), /source_transport_conflict/)
  assert.equal(rssSourceOptions({ connection: { dsnEnv: 'SOURCE' } }, { SOURCE: 'postgres://reader:secret@source/db' }).options, '-c default_transaction_read_only=on')
})

test('diagnostic implementation has no HTTP, application runtime, grants or mutations', async () => {
  const source = await readFile(new URL('../../server/ops/diagnose-rss-intent-migration.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\b(?:INSERT INTO|UPDATE |DELETE FROM|CREATE TABLE|fetch\(|createRuntime\()/)
  assert.match(source, /REPEATABLE READ READ ONLY/)
  assert.match(source, /statement_timeout/)
})

test('actual SQL inventories both RSS layers without exposing credentials or article content', { skip: !modulePath }, async t => {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const hub = new PGlite(), source = new PGlite()
  t.after(async () => { await hub.close(); await source.close() })
  await hub.exec(`CREATE SCHEMA catalog;
    CREATE TABLE catalog.database_connections (id text PRIMARY KEY, connection jsonb);
    CREATE TABLE catalog.external_sources (source_key text PRIMARY KEY, connection jsonb, database_connection_id text,
      dataset_id text, platform text, status text);`)
  await hub.query('INSERT INTO catalog.database_connections VALUES ($1,$2)', ['profile', connection])
  await hub.query(`INSERT INTO catalog.external_sources VALUES ('telegram-monitor-messages',$1,'profile','tg','telegram','active')`, [{ table: 'tg_monitor_messages' }])
  await source.exec(`CREATE TABLE rss_feeds (id integer PRIMARY KEY, title text);
    CREATE TABLE rss_items (id integer PRIMARY KEY, content text);
    CREATE TABLE rss_canonical_items (id integer PRIMARY KEY, rss_item_id integer, content_text text);
    CREATE TABLE event_source_items (id integer PRIMARY KEY, source_type text, title text);
    INSERT INTO rss_feeds VALUES (1,'private feed title');
    INSERT INTO rss_items VALUES (1,'private article body'),(2,'legacy-only body');
    INSERT INTO rss_canonical_items VALUES (1,1,'canonical body'),(2,NULL,'canonical-only body');
    INSERT INTO event_source_items VALUES (1,'news','private news title');`)
  let sourceOptions
  const report = await diagnoseRssMigration(pool(hub), { sourcePoolFactory(options) { sourceOptions = options; return pool(source) } })
  assert.equal(sourceOptions.database, 'synthetic')
  assert.equal(report.status, 'database_observed')
  assert.equal(report.source.identity.rows[0].read_only, 'on')
  assert.deepEqual(report.source.rss.rows, [{ legacy_without_canonical: '1', canonical_without_legacy_id: '1' }])
  assert.deepEqual(report.source.news.rows, [{ source_type: 'news', rows: '1' }])
  assert.equal(report.source.tables.rss_items.rows[0].rows, '2')
  assert.match(report.source.fileFallbacks, /not_inspected/)
  assert.doesNotMatch(JSON.stringify(report), /never-print-this|private feed|private article|legacy-only body|canonical body|canonical-only body|private news/)

  const unavailable = await diagnoseRssMigration(pool(hub), { sourcePoolFactory() { throw new Error('password=never-print-this') } })
  assert.equal(unavailable.status, 'incomplete')
  assert.deepEqual(unavailable.source, { state: 'unavailable', code: 'diagnostic_read_failed' })
  const missing = await diagnoseRssMigration(pool(hub), { sourceKey: 'telegram-monitor-chats', sourcePoolFactory() { throw new Error('must not connect') } })
  assert.equal(missing.status, 'incomplete')
  assert.equal(missing.hub.connectionRegistered, false)
  assert.equal(missing.source.code, 'source_not_registered')
  await assert.rejects(diagnoseRssMigration(pool(hub), { sourceKey: 'arbitrary' }), /unsupported_source_key/)
})

test('missing RSS tables remain absent, never a successful zero-row migration', { skip: !modulePath }, async t => {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite(); t.after(() => db.close())
  const report = await inspectRssSource(pool(db))
  assert.equal(report.tables.rss_items.state, 'absent')
  assert.equal(report.tables.rss_items.rows, null)
  assert.equal(report.rss.state, 'unavailable')
})
