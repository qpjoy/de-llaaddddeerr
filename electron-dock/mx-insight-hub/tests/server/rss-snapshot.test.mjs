import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { readFile, readdir } from 'node:fs/promises'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { RSS_DATASET, reconcileRssSnapshot } from '../../server/ingest/external/rss-snapshot.mjs'
import { aggregateSourceCatalog, normalizeAggregateRequest } from '../../server/data/aggregate-search.mjs'

test('RSS is explicit stored-only authorization, including hub_only discovery', () => {
  for (const execution of [undefined, 'hub_only']) {
    assert.deepEqual(aggregateSourceCatalog([], [], [], execution), [])
    const sources = aggregateSourceCatalog(['rss'], [], [], execution)
    assert.equal(sources[0].refresh, false)
    assert.deepEqual(sources[0].objectTypes, ['article'])
    const body = { mode: 'stored', query: '真实搜索问题', platforms: ['rss'] }
    assert.equal(normalizeAggregateRequest(body, sources).query, '真实搜索问题')
    assert.throws(() => normalizeAggregateRequest(body, []), { code: 'platform_not_granted' })
    assert.throws(() => normalizeAggregateRequest({ ...body, mode: 'refresh' }, sources), { code: 'refresh_unavailable' })
    assert.throws(() => normalizeAggregateRequest({ ...body, businessId: 'purpose' }, sources), { code: 'invalid_request' })
  }
})

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function pool(db) {
  const query = async (sql, args) => { const r = await db.query(sql, args); return { ...r, rowCount: r.affectedRows ?? r.rows.length } }
  return { query, async connect() { return { query, release() {} } } }
}

test('real SQL: full snapshot, legacy promotion, update, replay, outbox and failure recovery', { skip: !modulePath }, async t => {
  const url = pathToFileURL(modulePath)
  const { PGlite } = await import(url.href)
  const { pg_trgm } = await import(new URL('./contrib/pg_trgm.js', url))
  const hub = new PGlite({ extensions: { pg_trgm } }), upstream = new PGlite()
  t.after(async () => { await hub.close(); await upstream.close() })
  for (const dir of [new URL('../../../mx-common/migrations/', import.meta.url), new URL('../../migrations/', import.meta.url)]) {
    for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
      await hub.exec(await readFile(new URL(file, dir), 'utf8'))
    }
  }
  await upstream.exec(`CREATE TABLE rss_feeds(id uuid PRIMARY KEY,title text,language text,enabled boolean,feed_url text);
    CREATE TABLE rss_items(id uuid PRIMARY KEY,feed_id uuid,title text,content text,summary text,link text,author text,
      published_at timestamptz,discovered_at timestamptz,created_at timestamptz);
    CREATE TABLE rss_canonical_items(id uuid PRIMARY KEY,rss_item_id uuid UNIQUE,feed_id uuid,title text,content_text text,
      summary text,canonical_url text,article_url text,author text,language text,normalized_at timestamptz,
      published_at timestamptz,collected_at timestamptz,created_at timestamptz);`)
  await upstream.query('INSERT INTO rss_feeds VALUES ($1,$2,$3,false,$4)', [id(1), '订阅', 'zh', 'https://private.invalid/feed?token=secret'])
  for (const n of [10, 11]) await upstream.query(`INSERT INTO rss_items
    VALUES ($1,$2,'关键词新闻','旧正文',NULL,'https://article.invalid','作者',NULL,'2026-10-31T18:00:00Z','2026-10-31T18:00:00Z')`, [id(n), id(1)])
  const promote = async n => upstream.query(`INSERT INTO rss_canonical_items
    VALUES ($1,$2,$3,'关键词新闻','完整正文',NULL,NULL,'https://article.invalid','作者','zh',
    '2026-10-31T18:00:00Z','2020-01-01','2026-10-31T18:00:00Z','2026-10-31T18:00:00Z')`, [id(n+100), id(n), id(1)])
  await promote(10)
  const hubPool = pool(hub), store = new PostgresStore(hubPool)
  const input = { sourcePool: pool(upstream), hubPool, store, batchSize: 1, originFingerprint: 'a'.repeat(64) }
  const count = async table => (await hub.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n
  const dry = await reconcileRssSnapshot(input)
  assert.deepEqual([dry.feeds, dry.canonical, dry.legacy, dry.status], [1, 1, 1, 'validated'])
  assert.equal(await count('catalog.rss_subscription_snapshots'), 0)
  const a = await reconcileRssSnapshot({ ...input, apply: true })
  assert.equal(a.changed, 2)
  assert.equal(await count('catalog.rss_subscription_snapshots'), 1)
  let rows = (await hub.query('SELECT * FROM core.canonical_records WHERE dataset_id=$1 ORDER BY external_id', [RSS_DATASET])).rows
  assert.deepEqual(rows.map(r => r.external_id), ['item:' + id(10), 'item:' + id(11)])
  assert.equal(rows[0].body, '完整正文')
  assert.equal(rows[0].event_time.toISOString(), '2026-10-31T18:00:00.000Z')
  assert.equal(rows[0].extensions.feed.enabled, false)
  const outbox = await count('outbox.projection_events')
  assert.equal((await reconcileRssSnapshot({ ...input, apply: true })).changed, 0)
  assert.equal(await count('outbox.projection_events'), outbox)
  await promote(11)
  const promotion = await reconcileRssSnapshot({ ...input, apply: true })
  assert.deepEqual([promotion.canonical, promotion.legacy, promotion.changed], [2, 0, 1])
  rows = (await hub.query('SELECT * FROM core.canonical_records WHERE dataset_id=$1', [RSS_DATASET])).rows
  assert.equal(rows.length, 2, 'promotion updates the same identity')
  await upstream.query("UPDATE rss_canonical_items SET content_text='新正文' WHERE rss_item_id=$1", [id(10)])
  const original = store.ingestExternalRecords.bind(store)
  store.ingestExternalRecords = async () => { throw new Error('injected failure with private content') }
  await assert.rejects(reconcileRssSnapshot({ ...input, apply: true }), /injected failure/)
  assert.equal((await hub.query("SELECT count(*)::int AS n FROM ingest.import_runs WHERE status='failed'")).rows[0].n, 1)
  store.ingestExternalRecords = original
  assert.equal((await reconcileRssSnapshot({ ...input, apply: true })).changed, 1)
  assert.equal((await hub.query('SELECT body FROM core.canonical_records WHERE external_id=$1', ['item:' + id(10)])).rows[0].body, '新正文')
  await assert.rejects(reconcileRssSnapshot({ ...input, apply: true, originFingerprint: 'b'.repeat(64) }), /rss_source_contract_changed/)
  await upstream.query('UPDATE rss_canonical_items SET rss_item_id=$1 WHERE rss_item_id=$2', [id(12), id(10)])
  await assert.rejects(reconcileRssSnapshot({ ...input, apply: true }), /rss_article_identity_changed/)
  assert.equal((await hub.query('SELECT count(*)::int AS n FROM core.canonical_records WHERE dataset_id=$1', [RSS_DATASET])).rows[0].n, 2)
})
