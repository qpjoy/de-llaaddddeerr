import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { buildRssLineageBundle } from '../../server/ops/build-rss-file-lineage.mjs'
import { reconcileRssFileLineage } from '../../server/ingest/external/rss-file-lineage.mjs'
import { attachRssFileEvidence, readRssPage } from '../../server/ingest/external/rss-snapshot.mjs'
import { rssFileIdentity } from '../../server/ops/rss-file-coverage.mjs'

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const pool = db => ({ query: (sql, args) => db.query(sql, args), async connect() {
  return { query: (sql, args) => db.query(sql, args), release() {} }
} })
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'rss-lineage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['data', 'lib/domains/rss', 'lib/domains/data-feed/services']) await mkdir(join(root, dir), { recursive: true })
  for (const file of ['lib/domains/rss/rss-fetcher.js', 'lib/domains/data-feed/services/data-feed-service.js']) await writeFile(join(root, file), '')
  const config = { schedule: { enabled: false, cron: 'old-cron' }, feeds: [
    { id: 'feed', url: 'https://private.invalid?token=secret', enabled: false, tags: ['original'] },
  ] }
  const feeds = Object.fromEntries(['feed', 'missing-a', 'missing-b'].map((key, n) => [key, {
    feedTitle: 'original-feed-title', lastFetchedAt: '2026-10-31T00:00:00Z',
    items: [{ guid: String(n), title: 'article-title', link: 'https://article.invalid/' + n,
      pubDate: '2026-10-30', content: 'original-body-' + n }],
  }]))
  await writeFile(join(root, 'data/rss-config.json'), JSON.stringify(config))
  await writeFile(join(root, 'data/rss-results.json'), JSON.stringify({ lastFetchedAt: '2026-10-31', feeds }))
  return { root, config, feeds }
}

test('bundle preserves full configuration/metadata, sends hashes instead of article bodies and refuses new news files', async t => {
  const { root, config } = await fixture(t)
  const bundle = await buildRssLineageBundle(root)
  assert.deepEqual(bundle.metadata.config, config)
  assert.equal(Object.keys(bundle.metadata.rss.feeds).length, 3)
  assert.equal(bundle.manifest.items.length, 3)
  assert.doesNotMatch(JSON.stringify(bundle), /original-body|article-title|https:\/\/article.invalid/)
  await writeFile(join(root, 'data/news-results.json'), '{}')
  await assert.rejects(buildRssLineageBundle(root), /rss_news_file_requires_migration/)
})

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
test('SQL: file feed lineage is private, atomic, replayable and never creates/replaces an article', { skip: !modulePath }, async t => {
  const { PGlite } = await import(pathToFileURL(modulePath))
  const db = new PGlite(), hub = new PGlite()
  t.after(async () => { await db.close(); await hub.close() })
  await hub.exec('CREATE SCHEMA catalog')
  await hub.exec(await readFile(new URL('../../migrations/175_rss_file_lineage.sql', import.meta.url), 'utf8'))
  await db.exec(`CREATE TABLE rss_feeds(id uuid PRIMARY KEY,feed_key text,feed_url text,metadata jsonb);
    CREATE TABLE rss_items(id uuid PRIMARY KEY,feed_id uuid,item_hash text UNIQUE,raw jsonb);
    CREATE TABLE rss_canonical_items(id uuid PRIMARY KEY,rss_item_id uuid UNIQUE,item_hash text UNIQUE,
      feed_key text,raw jsonb,source_ref jsonb);`)
  const { root, feeds, config } = await fixture(t)
  const bundle = await buildRssLineageBundle(root)
  await db.query('INSERT INTO rss_feeds VALUES($1,$2,$3,$4)', [id(1), 'feed', config.feeds[0].url, { large: 'x'.repeat(1000) }])
  const originals = []
  for (const [i, [key, feed]] of Object.entries(feeds).entries()) {
    const raw = feed.items[0], itemId = id(i + 10), canonicalId = id(i + 20)
    const hash = rssFileIdentity(key, raw).itemHash
    await db.query('INSERT INTO rss_items VALUES($1,$2,$3,$4)', [itemId, i === 0 ? id(1) : null, hash, raw])
    const stored = i === 0 ? { ...raw, feed: {}, feedResult: {} } : { rssItem: raw, feed: {} }
    originals.push(stored)
    await db.query('INSERT INTO rss_canonical_items VALUES($1,$2,$3,$4,$5,$6)',
      [canonicalId, itemId, hash, i === 0 ? 'feed' : null, stored, { table: 'rss_items', id: itemId }])
  }
  const hubPool = pool(hub), input = { sourcePool: pool(db), hubPool, bundle, originFingerprint: 'a'.repeat(64) }
  const count = async () => (await hub.query('SELECT count(*)::int AS n FROM catalog.rss_file_snapshots')).rows[0].n
  const dry = await reconcileRssFileLineage(input)
  assert.equal(dry.status, 'validated')
  assert.equal(dry.feedAttributionsPreserved, 2)
  assert.equal(dry.canonicalArticleWrites, 0)
  assert.equal(await count(), 0)
  assert.doesNotMatch(JSON.stringify(dry), /original-body|private.invalid|secret|missing-a/)
  const applied = await reconcileRssFileLineage({ ...input, apply: true })
  assert.equal(applied.status, 'succeeded')
  assert.equal(await count(), 1)
  assert.deepEqual((await hub.query('SELECT metadata FROM catalog.rss_file_snapshots')).rows[0].metadata.config, config)
  const rows = (await hub.query('SELECT * FROM catalog.rss_file_article_lineage ORDER BY external_id')).rows
  assert.equal(rows[1].raw_payload.content, 'original-body-1')
  assert.deepEqual(rows.map(row => row.feed_key), ['feed', 'missing-a', 'missing-b'])
  assert.deepEqual(rows.map(row => row.external_id), [10, 11, 12].map(n => 'item:' + id(n)))
  assert.equal((await reconcileRssFileLineage({ ...input, apply: true })).replay, true)
  assert.equal(await count(), 1)
  const imported = [{ identity: 'item:' + id(11), scan_id: id(21) }]
  await attachRssFileEvidence(hubPool, imported, 'canonical', input.originFingerprint)
  assert.equal(imported[0].file_feed_evidence[0].feedKey, 'missing-a')
  const otherOrigin = [{ identity: 'item:' + id(11), scan_id: id(21) }]
  await attachRssFileEvidence(hubPool, otherOrigin, 'canonical', 'b'.repeat(64))
  assert.equal(otherOrigin[0].file_feed_evidence, undefined)
  await assert.rejects(attachRssFileEvidence(hubPool, [{ identity: 'item:' + id(11), scan_id: id(99) }],
    'canonical', input.originFingerprint), /rss_lineage_binding_changed/)

  await db.query("UPDATE rss_canonical_items SET raw=jsonb_set(raw,'{rssItem,content}','\"different\"') WHERE id=$1", [id(21)])
  assert.equal((await reconcileRssFileLineage({ ...input, apply: true })).status, 'blocked')
  assert.equal(await count(), 1)
  assert.equal((await hub.query('SELECT raw_payload FROM catalog.rss_file_article_lineage WHERE external_id=$1', ['item:' + id(11)])).rows[0].raw_payload.content, 'original-body-1')
  await db.query('UPDATE rss_canonical_items SET raw=$2 WHERE id=$1', [id(21), originals[1]])

  // A failure after snapshot insertion rolls back both header and bindings.
  const changedBundle = structuredClone(bundle)
  changedBundle.metadata.config.schedule.cron = 'changed-cron'
  const failingHub = { ...hubPool, async connect() { const client = await hubPool.connect(); return { ...client, async query(sql, args) {
    if (sql.startsWith('INSERT INTO catalog.rss_file_article_lineage')) throw new Error('injected failure')
    return client.query(sql, args)
  } } } }
  await assert.rejects(reconcileRssFileLineage({ ...input, bundle: changedBundle, hubPool: failingHub, apply: true }), /injected failure/)
  assert.equal(await count(), 1)
  assert.equal((await reconcileRssFileLineage({ ...input, bundle: changedBundle, apply: true })).status, 'succeeded')
  assert.equal(await count(), 2)

  // Source association changed after the snapshot: no silent overwrite/rebind.
  await db.query('UPDATE rss_canonical_items SET id=$2 WHERE id=$1', [id(21), id(99)])
  await assert.rejects(reconcileRssFileLineage({ ...input, apply: true }), /rss_lineage_binding_changed/)
  assert.equal(await count(), 2)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM rss_canonical_items')).rows[0].n, 3)

  // Byte-budget pagination preserves complete rows and refuses a single large row.
  await db.query('INSERT INTO rss_feeds VALUES($1,$2,$3,$4)', [id(2), 'other', 'https://other.invalid', { large: 'x'.repeat(1000) }])
  const first = await readRssPage(pool(db), 'feeds', null, 100, 1800)
  assert.equal(first.length, 1)
  assert.equal(first[0].payload.metadata.large.length, 1000)
  const second = await readRssPage(pool(db), 'feeds', first[0].scan_id, 100, 1800)
  assert.equal(second.length, 1)
  assert.notEqual(second[0].scan_id, first[0].scan_id)
  await assert.rejects(readRssPage(pool(db), 'feeds', null, 100, 100), /rss_source_row_too_large/)
})
