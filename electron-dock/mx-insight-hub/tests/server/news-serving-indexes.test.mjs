import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import pg from 'pg'
import { NewsDiscoveryStore } from '../../server/data/news-discovery.mjs'

// Opt-in, isolated PostgreSQL only. The fixture requires an empty disposable DB.
test('news indexes reuse valid builds, repair interrupted builds and preserve conflicts', {
  skip: !process.env.MX_NEWS_INDEX_TEST_DATABASE_URL,
}, async () => {
  const client = new pg.Client({ connectionString: process.env.MX_NEWS_INDEX_TEST_DATABASE_URL })
  await client.connect()
  try {
    const db = (await client.query('SELECT current_database() AS name')).rows[0].name
    assert.match(db, /^mx_news_test_/, 'must use a dedicated disposable database')
    assert.equal((await client.query("SELECT to_regclass('core.canonical_records') AS existing")).rows[0].existing, null)
    await client.query(`CREATE SCHEMA core;
      CREATE TABLE core.canonical_records (
        id uuid PRIMARY KEY, platform text, collected_at timestamptz, event_time timestamptz,
        deleted_at timestamptz, content_type text);
      INSERT INTO core.canonical_records VALUES
        ('10000000-0000-4000-8000-000000000001', 'data_center_saved_records_news', now(), now(), NULL, 'news')`)
    const source = await readFile(new URL('../../scripts/news-discovery-serving-indexes.sql', import.meta.url), 'utf8')
    const viewStart = source.indexOf('CREATE TEMP VIEW news_serving_index_contract')
    await client.query(source.slice(viewStart, source.indexOf('SELECT bool_or(', viewStart)))
    const generatedSql = prefix => {
      const start = source.indexOf(prefix)
      return source.slice(start, source.indexOf('\\gexec', start))
    }
    const dropSql = generatedSql("SELECT format('DROP INDEX")
    const createSql = generatedSql('SELECT format($ddl$')
    const status = async () => (await client.query('SELECT * FROM news_serving_index_contract ORDER BY index_name')).rows
    const commands = async sql => (await client.query(sql)).rows.map(r => r.format)
    const reconcile = async () => {
      assert(!(await status()).some(r => r.object_exists && !r.definition_matches), 'definition conflict')
      const statements = [...await commands(dropSql)]
      for (const sql of statements) await client.query(sql)
      const builds = await commands(createSql)
      for (const sql of builds) await client.query(sql)
      assert((await status()).every(r => r.contract_ready))
      return [...statements, ...builds]
    }
    const oids = async () => (await client.query(`SELECT indexrelid::text AS oid FROM pg_index
      WHERE indrelid='core.canonical_records'::regclass ORDER BY indexrelid`)).rows
    assert.equal((await reconcile()).length, 2, 'first run creates both time indexes')
    const before = await oids()
    assert.deepEqual(await reconcile(), [], 'unchanged deploy performs no index DDL')
    assert.deepEqual(await oids(), before)

    // Model the invalid catalog state left by an interrupted concurrent build.
    await client.query(`UPDATE pg_index SET indisvalid=false
      WHERE indexrelid='core.canonical_news_published_feed_idx'::regclass`)
    const repair = await reconcile()
    assert.equal(repair.length, 2)
    assert.match(repair[0], /^DROP INDEX CONCURRENTLY core.canonical_news_published_feed_idx/)
    assert.match(repair[1], /CREATE INDEX CONCURRENTLY canonical_news_published_feed_idx/)

    for (const definition of [
      '(platform, event_time ASC, id DESC) WHERE deleted_at IS NULL AND content_type IN (\'news\', \'news.article\', \'news.resolved\', \'bbc.article\')',
      '(platform, event_time DESC, id DESC) WHERE deleted_at IS NULL',
      '(platform, collected_at DESC, id DESC) WHERE deleted_at IS NULL AND content_type IN (\'news\', \'news.article\', \'news.resolved\', \'bbc.article\')',
    ]) {
      await client.query('DROP INDEX core.canonical_news_published_feed_idx')
      await client.query('CREATE INDEX canonical_news_published_feed_idx ON core.canonical_records ' + definition)
      const beforeConflict = await oids()
      await assert.rejects(reconcile(), /definition conflict/)
      assert.deepEqual(await commands(dropSql), [], 'a wrong definition must never be automatically dropped')
      assert.deepEqual(await oids(), beforeConflict)
    }

    // A reused connection must retain its prior timeout after COMMIT and ROLLBACK.
    await client.query("SET statement_timeout = '7s'")
    let releases = 0
    const pool = { connect: async () => ({ query: (...args) => client.query(...args), release() { releases++ } }) }
    const news = new NewsDiscoveryStore(pool)
    const result = await news.bounded("SELECT current_setting('statement_timeout') AS timeout, current_setting('transaction_read_only') AS read_only")
    assert.deepEqual(result.rows, [{ timeout: '15s', read_only: 'on' }])
    assert.equal((await client.query('SHOW statement_timeout')).rows[0].statement_timeout, '7s')
    await assert.rejects(new NewsDiscoveryStore(pool, { queryTimeoutMs: 1000 }).bounded('SELECT pg_sleep(2)'), { code: 'news_query_timeout' })
    assert.equal((await client.query('SHOW statement_timeout')).rows[0].statement_timeout, '7s')
    assert.equal(releases, 2)
  } finally {
    await client.end()
  }
})
