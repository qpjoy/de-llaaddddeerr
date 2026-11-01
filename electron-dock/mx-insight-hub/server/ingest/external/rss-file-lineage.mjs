import { digest, stableJson, validateFileManifest, compareRssFiles } from '../../ops/rss-file-coverage.mjs'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
export function validateRssLineageBundle(bundle) {
  if (bundle?.version !== 'rss-file-lineage-bundle.v1') throw new Error('rss_lineage_bundle_invalid')
  validateFileManifest(bundle.manifest)
  const { manifest, metadata } = bundle
  if (manifest.files?.news?.state !== 'absent') throw new Error('rss_news_file_requires_migration')
  for (const name of ['rss', 'config']) {
    const file = manifest.files[name]
    if (file?.state !== 'read' || !/^[a-f0-9]{64}$/.test(file.sha256 || '')
      || !Number.isSafeInteger(file.bytes) || file.bytes < 1) throw new Error('rss_lineage_bundle_invalid')
  }
  if (!metadata?.rss?.feeds || typeof metadata.rss.feeds !== 'object' || Array.isArray(metadata.rss.feeds)
    || !Array.isArray(metadata.config?.feeds)) throw new Error('rss_lineage_metadata_invalid')
  const keys = Object.keys(metadata.rss.feeds)
  const feedKeys = new Map(keys.map(key => [digest(key), key]))
  if (keys.length !== manifest.feeds.length || manifest.feeds.some(key => !feedKeys.has(key))
    || manifest.items.some(item => !feedKeys.has(item.fieldHashes[0]))) throw new Error('rss_lineage_metadata_invalid')
  const config = metadata.config.feeds.map(feed => ({ keyHash: digest(String(feed.id)), urlHash: digest(String(feed.url)) }))
  if (stableJson(config) !== stableJson(manifest.configFeeds)) throw new Error('rss_lineage_metadata_invalid')
  return feedKeys
}

export async function reconcileRssFileLineage({ sourcePool, hubPool, bundle, originFingerprint, apply = false }) {
  const feedKeys = validateRssLineageBundle(bundle)
  if (!/^[a-f0-9]{64}$/.test(originFingerprint || '')) throw new Error('rss_origin_required')
  await hubPool.query('SELECT s.metadata,l.raw_payload FROM catalog.rss_file_snapshots s JOIN catalog.rss_file_article_lineage l ON l.snapshot_id=s.id LIMIT 0')
  const snapshotId = digest(stableJson({ originFingerprint, bundle }))
  const bindings = new Map()
  let evidenceBytes = 0
  const coverage = await compareRssFiles(sourcePool, bundle.manifest, { onEvidence(evidence) {
    const { entry, raw, externalId, canonicalId, feedKeyMatches } = evidence
    if (!/^(item|canonical):/.test(externalId || '') || !uuid.test(externalId.split(':')[1])
      || canonicalId && !uuid.test(canonicalId)) throw new Error('rss_lineage_identity_invalid')
    const key = entry.identityHash + ':' + entry.rawHash
    const binding = { itemHash: entry.itemHash, identityHash: entry.identityHash, rawHash: entry.rawHash,
      feedKey: feedKeys.get(entry.fieldHashes[0]), externalId, canonicalId, feedKeyMatches }
    if (bindings.has(key) && (bindings.get(key).externalId !== externalId || bindings.get(key).canonicalId !== canonicalId)) throw new Error('rss_lineage_binding_conflict')
    if (!bindings.has(key)) {
      evidenceBytes += Buffer.byteLength(JSON.stringify(raw))
      if (evidenceBytes > 32 * 1024 * 1024) throw new Error('rss_file_evidence_size_limit')
      bindings.set(key, binding)
      // Freeze the verified payload too: a later source update must not erase
      // the file version between this receipt and the canonical import.
      if (apply) binding.rawPayload = raw
    }
  } })
  const matched = coverage.items.exactCanonical + coverage.items.exactLegacyOnly
    + coverage.identityDifferences.feedKeyOnlyChanged
  // Feed-only mismatches qualify only when the exact raw matched as well.
  const uniqueExpected = new Set(bundle.manifest.items.map(item => item.identityHash + ':' + item.rawHash)).size
  if (coverage.status !== 'observed' || matched !== coverage.items.total || bindings.size !== uniqueExpected) {
    return { version: 'rss-file-lineage.v1', status: 'blocked', mode: apply ? 'apply' : 'dry-run',
      code: 'rss_file_evidence_unresolved', coverage }
  }
  const report = { version: 'rss-file-lineage.v1', mode: apply ? 'apply' : 'dry-run',
    status: 'validated', snapshotId, articles: coverage.items.total, bindings: bindings.size,
    feedAttributionsPreserved: coverage.identityDifferences.feedKeyOnlyChanged,
    feeds: bundle.manifest.feeds.length, configFeeds: bundle.manifest.configFeeds.length,
    databaseSnapshot: coverage.databaseSnapshot, evidenceBytes, canonicalArticleWrites: 0 }
  if (!apply) return report
  const client = await hubPool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout='5s'")
    await client.query("SET LOCAL statement_timeout='30s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout='30s'")
    // Serialize the immutable snapshot receipt and all its bindings atomically.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['hub:rss-file-lineage:' + snapshotId])
    const existing = await client.query('SELECT id FROM catalog.rss_file_snapshots WHERE id=$1', [snapshotId])
    if (!existing.rows.length) {
      await client.query(`INSERT INTO catalog.rss_file_snapshots
        (id,origin_fingerprint,files,metadata,database_snapshot,article_count) VALUES($1,$2,$3,$4,$5,$6)`,
      [snapshotId, originFingerprint, bundle.manifest.files, bundle.metadata, coverage.databaseSnapshot, coverage.items.total])
    }
    const rows = [...bindings.values()]
    for (let i = 0; i < rows.length;) {
      const encoded = []
      let bytes = 0
      while (i < rows.length && encoded.length < 100) {
        const value = JSON.stringify(rows[i]), size = Buffer.byteLength(value)
        if (encoded.length && bytes + size > 2 * 1024 * 1024) break
        encoded.push(value); bytes += size; i++
      }
      const batch = '[' + encoded.join(',') + ']'
      if (!existing.rows.length) await client.query(`INSERT INTO catalog.rss_file_article_lineage
        (snapshot_id,item_hash,identity_hash,raw_hash,raw_payload,feed_key,external_id,canonical_id,feed_key_matches)
        SELECT $1,value->>'itemHash',value->>'identityHash',value->>'rawHash',value->'rawPayload',value->>'feedKey',
          value->>'externalId',(value->>'canonicalId')::uuid,(value->>'feedKeyMatches')::boolean
        FROM jsonb_array_elements($2::jsonb)`, [snapshotId, batch])
      else {
        const mismatch = await client.query(`SELECT 1 FROM jsonb_array_elements($2::jsonb) input
          LEFT JOIN catalog.rss_file_article_lineage known ON known.snapshot_id=$1
            AND known.identity_hash=input->>'identityHash' AND known.raw_hash=input->>'rawHash'
          WHERE known.external_id IS DISTINCT FROM input->>'externalId'
            OR known.canonical_id IS DISTINCT FROM (input->>'canonicalId')::uuid
            OR known.feed_key IS DISTINCT FROM input->>'feedKey' LIMIT 1`, [snapshotId, batch])
        if (mismatch.rows.length) throw new Error('rss_lineage_binding_changed')
      }
    }
    await client.query('COMMIT')
    return { ...report, status: 'succeeded', replay: Boolean(existing.rows.length) }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}
