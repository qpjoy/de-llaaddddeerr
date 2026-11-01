import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { buildRssFileManifest, buildRssComparisonProgram } from '../../server/ops/build-rss-file-comparison.mjs'
import { digest, rssFileIdentity, compareRssFiles } from '../../server/ops/rss-file-coverage.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'rss-coverage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const path of ['data', 'lib/domains/rss', 'lib/domains/data-feed/services']) await mkdir(join(root, path), { recursive: true })
  await writeFile(join(root, 'lib/domains/rss/rss-fetcher.js'), '')
  await writeFile(join(root, 'lib/domains/data-feed/services/data-feed-service.js'), '')
  await writeFile(join(root, 'data/rss-config.json'), JSON.stringify({ feeds: [{ id: 'private-feed', url: 'https://private.invalid?token=secret' }] }))
  await writeFile(join(root, 'data/rss-results.json'), JSON.stringify({ feeds: { 'private-feed': { items: [
    { guid: 'private-guid', link: 'https://private.invalid/article', title: 'private-title', content: 'private-content', pubDate: '2026-11-01' },
  ] } } }))
  return root
}

test('manifest uses writer identity, preserves dates/URL literally and only transfers hashes', async t => {
  const root = await fixture(t)
  const manifest = await buildRssFileManifest(root)
  assert.equal(manifest.items.length, 1)
  assert.equal(manifest.files.news.state, 'absent')
  assert.doesNotMatch(JSON.stringify(manifest), /private|secret|https:/)
  const a = rssFileIdentity('feed', { title: 't', link: 'https://a/#x', isoDate: '2020' })
  const b = rssFileIdentity('feed', { title: 't', link: 'https://a/#x', isoDate: '2030' })
  assert.equal(a.itemHash, b.itemHash, 'writer does not use isoDate in item identity')
  assert.notEqual(a.rawHash, b.rawHash)
  assert.notEqual(a.itemHash, rssFileIdentity('feed', { title: 't', link: 'https://a/' }).itemHash)
  const newlineA = rssFileIdentity('a\nb', { guid: 'c' }), newlineB = rssFileIdentity('a', { guid: 'b\nc' })
  assert.equal(newlineA.itemHash, newlineB.itemHash)
  assert.notEqual(newlineA.identityHash, newlineB.identityHash, 'protect the ambiguous newline-joined writer identity')
  const program = await buildRssComparisonProgram(root)
  assert.doesNotMatch(program, /private-guid|private-title|private-content|token=secret/)
  assert.doesNotMatch(program, /\b(?:INSERT INTO|UPDATE |DELETE FROM|CREATE TABLE|fetch\(|createRuntime\()/)
  // Exercise the exact emitted stdin program, without DB access or a new image.
  const { DATABASE_URL: ignored, ...env } = process.env
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], { input: program, encoding: 'utf8',
    cwd: new URL('../../', import.meta.url), env })
  assert.equal(result.status, 2, result.stderr)
  assert.equal(JSON.parse(result.stdout).code, 'hub_database_unconfigured')
  await writeFile(join(root, 'data/rss-results.json'), '{truncated')
  await assert.rejects(buildRssFileManifest(root))
})

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
test('actual SQL compares current import evidence, not just row counts or matching URLs', { skip: !modulePath }, async t => {
  const { PGlite } = await import(pathToFileURL(modulePath))
  const db = new PGlite(); t.after(() => db.close())
  await db.exec(`CREATE TABLE rss_feeds (id integer PRIMARY KEY,feed_key text,feed_url text);
    CREATE TABLE rss_items(id integer PRIMARY KEY,feed_id integer,item_hash text UNIQUE,raw jsonb);
    CREATE TABLE rss_canonical_items(id integer PRIMARY KEY,rss_item_id integer UNIQUE,item_hash text UNIQUE,feed_key text,raw jsonb);
    INSERT INTO rss_feeds VALUES (1,'feed','https://feed.invalid'),(2,'changed','https://new.invalid');`)
  const entries = []
  const item = n => ({ guid: String(n), link: 'https://article.invalid/' + n, title: '文章', pubDate: '2026-11-01', content: 'body' })
  for (let n = 1; n <= 9; n++) {
    const raw = item(n), fingerprint = rssFileIdentity('feed', raw)
    entries.push(fingerprint)
    if (n === 8 || n === 9) raw.content = 'x'.repeat(300 * 1024)
    if (n !== 5 && n !== 6) await db.query('INSERT INTO rss_items VALUES ($1,1,$2,$3)', [n, fingerprint.itemHash, raw])
    // 1 exact canonical, 2 exact legacy, 3 canonical content differs from
    // file despite an exact legacy raw, 4 canonical identity differs,
    // 5 absent, 6 canonical-only exact, 7 canonical overwrote an item field.
    if ([1, 3, 4, 6, 7, 9].includes(n)) {
      const canonical = { ...raw, feed: { id: 'feed' }, feedResult: { items: ['x'.repeat(2 * 1024 * 1024)] } }
      if (n === 3) canonical.content = 'changed body'
      if (n === 4) canonical.guid = 'changed identity'
      if (n === 7) {
        raw.feed = 'intrinsic item field'
        entries[entries.length - 1] = rssFileIdentity('feed', raw)
      }
      await db.query('INSERT INTO rss_canonical_items VALUES ($1,$2,$3,$4,$5)', [n, n === 6 ? null : n, n === 4 ? 'changed-canonical-hash' : fingerprint.itemHash, 'feed', canonical])
    }
  }
  const manifest = { version: 'rss-file-manifest.v1', files: {}, items: entries,
    feeds: [digest('feed'), digest('missing')], configFeeds: [
      { keyHash: digest('feed'), urlHash: digest('https://feed.invalid') },
      { keyHash: digest('changed'), urlHash: digest('https://old.invalid') },
      { keyHash: digest('alias'), urlHash: digest('https://feed.invalid') },
      { keyHash: digest('new'), urlHash: digest('https://absent.invalid') },
    ] }
  let readOnly = false
  const pool = { async connect() { return { release() {}, async query(sql, args) {
    const value = await db.query(sql, args)
    if (sql.startsWith('BEGIN')) readOnly = (await db.query("SELECT current_setting('transaction_read_only') AS v")).rows[0].v === 'on'
    return value
  } } } }
  const result = await compareRssFiles(pool, manifest)
  assert.equal(readOnly, true)
  assert.equal(result.version, 'rss-file-coverage.v2')
  assert.equal(result.status, 'incomplete')
  assert.deepEqual(result.items, { total: 9, exactCanonical: 2, exactLegacyOnly: 1, contentDiffers: 2, identityMismatch: 1, missing: 1, payloadTooLarge: 2 })
  assert.deepEqual(result.feeds, { total: 2, matchedKey: 1, missingKey: 1 })
  assert.equal(result.configFeeds.sameKeyAndUrl, 1)
  assert.equal(result.configFeeds.keyWithDifferentUrl, 1)
  assert.equal(result.configFeeds.urlWithDifferentKey, 1)
  assert.equal(result.configFeeds.missing, 1)
  assert.equal(result.articlePayloadsCovered, false)
  assert.equal(result.fullFileCoverage, false)
  assert.doesNotMatch(JSON.stringify(result), /body|https:\/\/|changed identity|intrinsic item/)
  const exact = await compareRssFiles(pool, { ...manifest, items: [entries[0], entries[1], entries[5]] })
  assert.equal(exact.articlePayloadsCovered, true)
  assert.equal(exact.status, 'observed')
  assert.equal(exact.fullFileCoverage, false, 'article equality does not prove full config parity')
})

// A driver double exercises retained JS memory with the production item count;
// the PGlite test above independently verifies SQL envelope/size filtering.
test('14,836 comparisons complete under a 96 MiB Node heap', () => {
  const source = new URL('../../server/ops/rss-file-coverage.mjs', import.meta.url).href
  const program = `
    import assert from 'node:assert/strict';
    import { compareRssFiles, rssFileIdentity } from ${JSON.stringify(source)};
    const raw = n => ({ guid: String(n), title: 'article', content: 'x'.repeat(64 * 1024) });
    const items = Array.from({ length: 14836 }, (_, n) => rssFileIdentity('feed', raw(n)));
    const indexes = new Map(items.map((item, n) => [item.itemHash, n]));
    let batches = 0;
    const pool = { async connect() { return { release() {}, async query(sql, args) {
      if (sql.includes('transaction_timestamp')) return { rows: [{ observed_at: 'test' }] };
      if (sql.includes('SELECT feed_key,feed_url')) return { rows: [] };
      if (!args) return { rows: [] };
      assert.ok(args[0].length <= 16);
      batches++;
      // Simulate pg deserializing fresh result objects on every batch.
      return { rows: JSON.parse(JSON.stringify(args[0].map(item_hash => ({
        item_hash, feed_key: 'feed', is_canonical: true, payload_bytes: 66000,
        raw: raw(indexes.get(item_hash))
      })))) };
    } } } };
    const report = await compareRssFiles(pool, { version: 'rss-file-manifest.v1', files: {}, items, feeds: [], configFeeds: [] });
    assert.equal(report.items.exactCanonical, 14836);
    assert.equal(report.articlePayloadsCovered, true);
    assert.equal(report.status, 'observed');
    assert.equal(batches, 928);
    console.log(JSON.stringify({ total: report.items.total, batches }));
  `
  const result = spawnSync(process.execPath, ['--max-old-space-size=96', '--input-type=module', '-'], {
    input: program, encoding: 'utf8', timeout: 120000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { total: 14836, batches: 928 })
})
