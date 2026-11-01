// Standalone read-only comparison: this file is also sent through stdin to
// the Hub Admin Pod. It must not import application startup or local modules.
import { createHash } from 'node:crypto'

export function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}'
  return JSON.stringify(value)
}
export const digest = value => createHash('sha256').update(value).digest('hex')

export function rssFileIdentity(feedKey, item) {
  // Exact saveRssFetchRun algorithm, including the absence of isoDate in this
  // identity expression. Do not normalize URL/date/title before hashing.
  const parts = [feedKey, item.guid || '', item.link || '', item.title || '',
    item.parsedDate || item.pubDate || item.discoveredAt || ''].map(value => value == null ? '' : String(value))
  return { itemHash: createHash('sha1').update(parts.join('\n')).digest('hex'),
    identityHash: digest(stableJson(parts)), rawHash: digest(stableJson(item)) }
}

export function validateFileManifest(manifest) {
  const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  if (manifest?.version !== 'rss-file-manifest.v1' || !Array.isArray(manifest.items)
    || manifest.items.length > 500000 || !Array.isArray(manifest.feeds) || manifest.feeds.length > 100000
    || !Array.isArray(manifest.configFeeds) || manifest.configFeeds.length > 100000
    || manifest.items.some(row => !/^[a-f0-9]{40}$/.test(row.itemHash || '') || !sha(row.identityHash) || !sha(row.rawHash))
    || manifest.feeds.some(value => !sha(value))
    || manifest.configFeeds.some(row => !sha(row.keyHash) || !sha(row.urlHash))) throw new Error('rss_manifest_invalid')
}

export async function compareRssFiles(pool, manifest) {
  validateFileManifest(manifest)
  const report = { version: 'rss-file-coverage.v1', status: 'observed',
    files: manifest.files, items: { total: manifest.items.length, exactCanonical: 0, exactLegacyOnly: 0,
      contentDiffers: 0, identityMismatch: 0, missing: 0 },
    feeds: { total: manifest.feeds.length, matchedKey: 0, missingKey: 0 },
    configFeeds: { total: manifest.configFeeds.length, sameKeyAndUrl: 0, keyWithDifferentUrl: 0,
      urlWithDifferentKey: 0, missing: 0, comparison: 'identity_only_not_full_configuration' },
    databaseSnapshot: null, fullFileCoverage: false }
  const client = await pool.connect()
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '10s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'")
    report.databaseSnapshot = (await client.query('SELECT transaction_timestamp() AS observed_at')).rows[0].observed_at
    const { rows: feeds } = await client.query('SELECT feed_key,feed_url FROM public.rss_feeds')
    const feedKeys = new Map(feeds.map(row => [digest(String(row.feed_key)), digest(String(row.feed_url))]))
    const feedUrls = new Set(feedKeys.values())
    for (const key of manifest.feeds) report.feeds[feedKeys.has(key) ? 'matchedKey' : 'missingKey']++
    for (const feed of manifest.configFeeds) {
      report.configFeeds[feedKeys.get(feed.keyHash) === feed.urlHash ? 'sameKeyAndUrl'
        : feedKeys.has(feed.keyHash) ? 'keyWithDifferentUrl' : feedUrls.has(feed.urlHash) ? 'urlWithDifferentKey' : 'missing']++
    }
    for (let index = 0; index < manifest.items.length; index += 250) {
      const batch = manifest.items.slice(index, index + 250)
      const hashes = [...new Set(batch.map(row => row.itemHash))]
      // Select exactly the evidence that the current Hub importer would keep:
      // a linked canonical row takes priority even when its hash has changed.
      const { rows: legacy } = await client.query(`SELECT r.item_hash,f.feed_key,r.raw,
        c.id AS canonical_id,c.feed_key AS canonical_feed_key,c.raw AS canonical_raw
        FROM public.rss_items r LEFT JOIN public.rss_feeds f ON f.id=r.feed_id
        LEFT JOIN public.rss_canonical_items c ON c.rss_item_id=r.id
        WHERE r.item_hash=ANY($1::text[])`, [hashes])
      const { rows: canonical } = await client.query(`SELECT item_hash,feed_key,raw
        FROM public.rss_canonical_items WHERE item_hash=ANY($1::text[])`, [hashes])
      const oldByHash = new Map(legacy.map(row => [row.item_hash, row]))
      const canonicalByHash = new Map(canonical.map(row => [row.item_hash, row]))
      for (const entry of batch) {
        const old = oldByHash.get(entry.itemHash), canonicalRow = canonicalByHash.get(entry.itemHash)
        const isCanonical = Boolean(old?.canonical_id || !old && canonicalRow)
        const raw = old?.canonical_id ? old.canonical_raw : old ? old.raw : canonicalRow?.raw
        if (!old && !canonicalRow) { report.items.missing++; continue }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { report.items.identityMismatch++; continue }
        const item = { ...raw }
        if (isCanonical) { delete item.feed; delete item.feedResult }
        const key = old?.canonical_id ? old.canonical_feed_key : old ? old.feed_key : canonicalRow.feed_key
        const identity = rssFileIdentity(key, item)
        if (identity.itemHash !== entry.itemHash || identity.identityHash !== entry.identityHash) report.items.identityMismatch++
        else if (identity.rawHash !== entry.rawHash) report.items.contentDiffers++
        else report.items[isCanonical ? 'exactCanonical' : 'exactLegacyOnly']++
      }
    }
    // Article equality does not prove config parity or retirement of NewsNow.
    report.articlePayloadsCovered = report.items.exactCanonical + report.items.exactLegacyOnly === report.items.total
    await client.query('ROLLBACK')
    return report
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

export async function runRssFileComparison(manifest, sourceOptions) {
  let hub, source
  try {
    validateFileManifest(manifest)
    const { default: pg } = await import('pg')
    if (!process.env.DATABASE_URL) throw new Error('hub_database_unconfigured')
    hub = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000,
      statement_timeout: 10000, options: '-c default_transaction_read_only=on' })
    const { rows } = await hub.query(`SELECT s.connection,s.database_connection_id,p.connection AS profile_connection
      FROM catalog.external_sources s LEFT JOIN catalog.database_connections p ON p.id=s.database_connection_id
      WHERE s.source_key='telegram-monitor-messages'`)
    source = new pg.Pool(sourceOptions(rows[0]))
    process.stdout.write(JSON.stringify(await compareRssFiles(source, manifest), null, 2) + '\n')
  } catch (error) {
    const code = /^(rss_[a-z_]+|source_[a-z_]+|hub_database_unconfigured)$/.test(error.message)
      ? error.message : /^[A-Z0-9]{5}$/.test(error.code || '') ? error.code : 'rss_file_comparison_failed'
    process.stdout.write(JSON.stringify({ version: 'rss-file-coverage.v1', status: 'incomplete', code }) + '\n')
    process.exitCode = 2
  } finally { await source?.end(); await hub?.end() }
}
