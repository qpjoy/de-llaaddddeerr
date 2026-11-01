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
    identityHash: digest(stableJson(parts)), rawHash: digest(stableJson(item)),
    fieldHashes: parts.map(digest) }
}

export function validateFileManifest(manifest) {
  const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  if (manifest?.version !== 'rss-file-manifest.v2' || !Array.isArray(manifest.items)
    || manifest.items.length > 500000 || !Array.isArray(manifest.feeds) || manifest.feeds.length > 100000
    || !Array.isArray(manifest.configFeeds) || manifest.configFeeds.length > 100000
    || manifest.items.some(row => !/^[a-f0-9]{40}$/.test(row.itemHash || '') || !sha(row.identityHash) || !sha(row.rawHash))
    || manifest.items.some(row => !Array.isArray(row.fieldHashes) || row.fieldHashes.length !== 5 || row.fieldHashes.some(value => !sha(value)))
    || manifest.feeds.some(value => !sha(value))
    || manifest.configFeeds.some(row => !sha(row.keyHash) || !sha(row.urlHash))) throw new Error('rss_manifest_invalid')
}

export async function compareRssFiles(pool, manifest) {
  validateFileManifest(manifest)
  const batchSize = 16, maxRowBytes = 256 * 1024
  const report = { version: 'rss-file-coverage.v3', status: 'observed',
    limits: { batchSize, maxRowBytes },
    files: manifest.files, items: { total: manifest.items.length, exactCanonical: 0, exactLegacyOnly: 0,
      contentDiffers: 0, identityMismatch: 0, missing: 0, payloadTooLarge: 0 },
    feeds: { total: manifest.feeds.length, matchedKey: 0, missingKey: 0 },
    configFeeds: { total: manifest.configFeeds.length, sameKeyAndUrl: 0, keyWithDifferentUrl: 0,
      urlWithDifferentKey: 0, missing: 0, comparison: 'identity_only_not_full_configuration' },
    databaseSnapshot: null, fullFileCoverage: false }
  const fields = ['feedKey', 'guid', 'link', 'title', 'identityDate']
  const emptyDifferences = () => ({ items: 0, invalidRaw: 0, rawPayloadEqual: 0, rawPayloadDifferent: 0,
    feedKeyOnlyChanged: 0, fields: Object.fromEntries(fields.map(field => [field, 0])) })
  report.identityDifferences = { ...emptyDifferences(), fileFeedMissing: 0, distinctFileFeeds: 0, byFileFeed: [] }
  const differencesByFeed = new Map()
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
    const recordDifference = (entry, identity) => {
      const keyHash = entry.fieldHashes[0]
      let group = differencesByFeed.get(keyHash)
      if (!group) {
        group = { ...emptyDifferences(), fileFeedRegistered: feedKeys.has(keyHash) }
        differencesByFeed.set(keyHash, group)
      }
      const changedFields = identity ? fields.filter((_, i) => entry.fieldHashes[i] !== identity.fieldHashes[i]) : []
      for (const stats of [report.identityDifferences, group]) {
        stats.items++
        if (!identity) { stats.invalidRaw++; continue }
        stats[identity.rawHash === entry.rawHash ? 'rawPayloadEqual' : 'rawPayloadDifferent']++
        for (const field of changedFields) stats.fields[field]++
        if (changedFields.length === 1 && changedFields[0] === 'feedKey') stats.feedKeyOnlyChanged++
      }
      if (!group.fileFeedRegistered) report.identityDifferences.fileFeedMissing++
    }
    for (let index = 0; index < manifest.items.length; index += batchSize) {
      const batch = manifest.items.slice(index, index + batchSize)
      const hashes = [...new Set(batch.map(row => row.itemHash))]
      // Choose the same evidence as the importer, including linked canonical
      // records whose own hash changed. Never return both raw versions or the
      // writer's feedResult envelope (it repeats an entire feed per article).
      // Guard the projected JSON size in SQL BEFORE pg parses any payload.
      const { rows } = await client.query(`WITH evidence AS MATERIALIZED (
        SELECT r.item_hash,
          CASE WHEN c.id IS NOT NULL THEN c.feed_key ELSE f.feed_key END AS feed_key,
          c.id IS NOT NULL AS is_canonical,
          CASE WHEN c.id IS NOT NULL THEN c.raw - 'feed' - 'feedResult' ELSE r.raw END AS raw
        FROM public.rss_items r LEFT JOIN public.rss_feeds f ON f.id=r.feed_id
        LEFT JOIN public.rss_canonical_items c ON c.rss_item_id=r.id
        WHERE r.item_hash=ANY($1::text[])
        UNION ALL
        SELECT c.item_hash,c.feed_key,true,c.raw - 'feed' - 'feedResult'
        FROM public.rss_canonical_items c WHERE c.item_hash=ANY($1::text[])
          AND NOT EXISTS (SELECT 1 FROM public.rss_items r WHERE r.item_hash=c.item_hash)
      ), sized AS MATERIALIZED (
        SELECT item_hash,is_canonical,feed_key,raw,
          COALESCE(octet_length(raw::text),0) + COALESCE(octet_length(feed_key),0) AS payload_bytes
        FROM evidence
      ) SELECT item_hash,is_canonical,payload_bytes,
        CASE WHEN payload_bytes <= $2 THEN feed_key END AS feed_key,
        CASE WHEN payload_bytes <= $2 THEN raw END AS raw
        FROM sized`, [hashes, maxRowBytes])
      const byHash = new Map(rows.map(row => [row.item_hash, row]))
      for (const entry of batch) {
        const row = byHash.get(entry.itemHash)
        if (!row) { report.items.missing++; continue }
        if (Number(row.payload_bytes) > maxRowBytes) { report.items.payloadTooLarge++; continue }
        const raw = row.raw
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          report.items.identityMismatch++; recordDifference(entry, null); continue
        }
        const identity = rssFileIdentity(row.feed_key, raw)
        if (identity.itemHash !== entry.itemHash || identity.identityHash !== entry.identityHash) {
          report.items.identityMismatch++
          recordDifference(entry, identity)
        }
        else if (identity.rawHash !== entry.rawHash) report.items.contentDiffers++
        else report.items[row.is_canonical ? 'exactCanonical' : 'exactLegacyOnly']++
      }
    }
    // Deterministic anonymous groups correlate differences with missing feed
    // keys, without printing feed IDs, URLs, article text, or even their hashes.
    report.identityDifferences.byFileFeed = [...differencesByFeed.entries()]
      .sort(([a], [b]) => a.localeCompare(b)).map(([, stats], index) => ({ group: index + 1, ...stats }))
    report.identityDifferences.distinctFileFeeds = differencesByFeed.size
    if (report.items.payloadTooLarge) report.status = 'incomplete'
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
    const report = await compareRssFiles(source, manifest)
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    if (report.status === 'incomplete') process.exitCode = 2
  } catch (error) {
    const code = /^(rss_[a-z_]+|source_[a-z_]+|hub_database_unconfigured)$/.test(error.message)
      ? error.message : /^[A-Z0-9]{5}$/.test(error.code || '') ? error.code : 'rss_file_comparison_failed'
    process.stdout.write(JSON.stringify({ version: 'rss-file-coverage.v3', status: 'incomplete', code }) + '\n')
    process.exitCode = 2
  } finally { await source?.end(); await hub?.end() }
}
