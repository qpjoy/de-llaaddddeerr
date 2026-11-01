import { createHash } from 'node:crypto'
import { applyMapping } from './mapping.mjs'
import { canonicalJson } from '../normalizers.mjs'

export const RSS_SOURCE_KEY = 'rss-subscription-snapshot'
export const RSS_DATASET = 'rss.articles.v1'
export const RSS_CONTRACT = 'rss-snapshot.v1'
export const RSS_FIELD_MAP = {
  externalId: { from: 'identity' }, title: { from: 'title' },
  body: { from: ['content', 'summary'] }, url: { from: 'url' },
  authorName: { from: 'author' }, language: { from: 'language' },
  eventTime: { from: 'effective_time', type: 'timestamp' },
  collectedAt: { from: 'collected_at', type: 'timestamp' },
}

export function rssOriginFingerprint(options) {
  const dsn = options.connectionString ? new URL(options.connectionString) : null
  return createHash('sha256').update(JSON.stringify([
    dsn?.hostname || options.host, dsn?.port || String(options.port || 5432),
    dsn ? decodeURIComponent(dsn.pathname.slice(1)) : options.database,
  ])).digest('hex')
}

// Fixed identifiers only. Both phases run in ONE repeatable-read snapshot.
// rss_item_id is stable across the legacy -> canonical promotion. Standalone
// canonical rows use a different namespace so unrelated UUIDs cannot collide.
export const RSS_PAGES = {
  canonical: `SELECT c.id AS scan_id, 'item:' || c.rss_item_id AS legacy_identity,
      CASE WHEN c.rss_item_id IS NULL THEN 'canonical:' || c.id ELSE 'item:' || c.rss_item_id END AS identity,
      c.title, c.content_text AS content, c.summary,
      coalesce(nullif(c.canonical_url,''), nullif(c.article_url,'')) AS url,
      c.author, c.language, coalesce(c.normalized_at,c.published_at,c.collected_at,c.created_at) AS effective_time,
      coalesce(c.collected_at,c.created_at) AS collected_at,
      to_jsonb(c) AS article, to_jsonb(f) AS feed
    FROM public.rss_canonical_items c LEFT JOIN public.rss_feeds f ON f.id=c.feed_id
    WHERE ($1::uuid IS NULL OR c.id > $1::uuid) ORDER BY c.id LIMIT $2`,
  legacy: `SELECT r.id AS scan_id, 'item:' || r.id AS identity, r.title, r.content, r.summary,
      r.link AS url, r.author, f.language,
      coalesce(r.published_at,r.discovered_at,r.created_at) AS effective_time,
      coalesce(r.discovered_at,r.created_at) AS collected_at,
      to_jsonb(r) AS article, to_jsonb(f) AS feed
    FROM public.rss_items r LEFT JOIN public.rss_feeds f ON f.id=r.feed_id
    WHERE ($1::uuid IS NULL OR r.id > $1::uuid) AND NOT EXISTS
      (SELECT 1 FROM public.rss_canonical_items c WHERE c.rss_item_id=r.id)
    ORDER BY r.id LIMIT $2`,
  feeds: `SELECT id AS scan_id, to_jsonb(f) AS payload FROM public.rss_feeds f
    WHERE ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT $2`,
}

// Bound the JSON sent to Node while retaining complete source rows. A single
// oversized row fails visibly; never trim evidence or advance past that row.
export async function readRssPage(reader, phase, last, batchSize, maxBytes = 8 * 1024 * 1024) {
  const { rows } = await reader.query(`WITH page AS MATERIALIZED (${RSS_PAGES[phase]}),
    sized AS MATERIALIZED (SELECT scan_id,to_jsonb(page) AS payload,
      octet_length(to_jsonb(page)::text) AS payload_bytes FROM page),
    budgeted AS (SELECT *,sum(payload_bytes) OVER (ORDER BY scan_id) AS total_bytes,
      row_number() OVER (ORDER BY scan_id) AS ordinal FROM sized)
    SELECT scan_id,payload_bytes,CASE WHEN payload_bytes <= $3 THEN payload END AS payload
    FROM budgeted WHERE total_bytes <= $3 OR ordinal=1 ORDER BY scan_id`, [last, batchSize, maxBytes])
  if (rows.some(row => Number(row.payload_bytes) > maxBytes)) throw new Error('rss_source_row_too_large')
  return rows.map(row => row.payload)
}

export async function attachRssFileEvidence(hub, rows, phase, originFingerprint) {
  const { rows: evidence } = await hub.query(`SELECT l.external_id,l.canonical_id,l.feed_key,l.raw_hash,l.snapshot_id
    FROM catalog.rss_file_article_lineage l JOIN catalog.rss_file_snapshots s ON s.id=l.snapshot_id
    WHERE l.external_id=ANY($1::text[]) AND s.origin_fingerprint=$2
    ORDER BY l.snapshot_id,l.feed_key,l.raw_hash`, [rows.map(row => row.identity), originFingerprint])
  const byId = new Map()
  for (const item of evidence) {
    const list = byId.get(item.external_id) || []
    list.push(item)
    byId.set(item.external_id, list)
  }
  for (const row of rows) {
    const items = byId.get(row.identity)
    if (!items) continue
    if (phase === 'canonical' && items.some(item => item.canonical_id && item.canonical_id !== row.scan_id)) {
      throw new Error('rss_lineage_binding_changed')
    }
    row.file_feed_evidence = items.map(item => ({ snapshotId: item.snapshot_id, feedKey: item.feed_key, rawHash: item.raw_hash }))
  }
}

export function mapRssRow(row, phase) {
  if (!['canonical', 'legacy'].includes(phase) || !row.identity || !row.effective_time || !row.collected_at) {
    throw new Error('rss_row_invalid')
  }
  const normalized = { ...row,
    effective_time: row.effective_time instanceof Date ? row.effective_time.toISOString() : row.effective_time,
    collected_at: row.collected_at instanceof Date ? row.collected_at.toISOString() : row.collected_at }
  const { record, rejected } = applyMapping(normalized, RSS_FIELD_MAP, {
    platform: 'rss', objectType: 'article', source: { origin: 'database', sourceKey: RSS_SOURCE_KEY },
  })
  if (rejected || !record || !record.eventTime || !record.collectedAt) throw new Error('rss_row_invalid')
  record.parserVersion = RSS_CONTRACT
  return record
}

async function register(store, originFingerprint) {
  let source = await store.getExternalSource(RSS_SOURCE_KEY)
  const connection = { reconciliationContract: RSS_CONTRACT, originFingerprint }
  if (!source) source = await store.createExternalSource({ sourceKey: RSS_SOURCE_KEY,
    displayName: 'RSS 订阅库快照对账', sourceKind: 'database', datasetId: RSS_DATASET,
    platform: 'rss', objectType: 'article', status: 'paused', connection })
  // This is an explicit snapshot job, not a generic watermark-based plan.
  // Refuse operator edits instead of silently overwriting a source or mapping.
  if (source.sourceKind !== 'database' || source.datasetId !== RSS_DATASET || source.platform !== 'rss'
    || source.objectType !== 'article' || source.status !== 'paused' || source.databaseConnectionId
    || canonicalJson(source.connection) !== canonicalJson(connection)) throw new Error('rss_source_contract_changed')
  let mapping = await store.getActiveMapping(source.id)
  if (!mapping) {
    const proposed = await store.createSourceMapping({ sourceId: source.id, fieldMap: RSS_FIELD_MAP,
      origin: 'manual', notes: RSS_CONTRACT })
    mapping = await store.approveSourceMapping({ sourceId: source.id, version: proposed.version,
      approvedBy: 'operator:rss-snapshot-apply' })
  }
  if (canonicalJson(mapping.fieldMap) !== canonicalJson(RSS_FIELD_MAP)) throw new Error('rss_mapping_changed')
  return { source, mapping }
}

// Re-read every source row each run: no unproven updated_at watermark, no
// deletion inference, no upstream API/model calls. Failed batches are safely
// revisited on the next run using the same canonical identities.
export async function reconcileRssSnapshot({ sourcePool, hubPool, store, apply = false, batchSize = 100,
  originFingerprint, onProgress = () => {}, maxDurationMs = 3_600_000 }) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new Error('rss_batch_size_invalid')
  if (apply && !/^[a-f0-9]{64}$/.test(originFingerprint || '')) throw new Error('rss_origin_required')
  const reader = await sourcePool.connect()
  let lock, locked = false, run, source, mapping
  const started = Date.now()
  const report = { version: RSS_CONTRACT, mode: apply ? 'apply' : 'dry-run', status: 'running',
    feeds: 0, canonical: 0, legacy: 0, changed: 0, importRunId: null,
    fileFallbacks: 'not_inspected', deletions: 'not_propagated' }
  try {
    if (apply) {
      lock = await hubPool.connect()
      locked = (await lock.query("SELECT pg_try_advisory_lock(hashtextextended('hub:rss-snapshot:v1',0)) AS locked")).rows[0].locked
      if (!locked) throw new Error('rss_snapshot_already_running')
    }
    await reader.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await reader.query("SET LOCAL statement_timeout = '30s'")
    await reader.query("SET LOCAL lock_timeout = '1s'")
    await reader.query("SET LOCAL idle_in_transaction_session_timeout = '5min'")
    // Fail before Hub registration if the observed source schema is absent.
    for (const sql of Object.values(RSS_PAGES)) await reader.query(sql, [null, 0])
    // Check the destination evidence schema before registering/writing a source.
    await hubPool.query('SELECT s.metadata,l.raw_payload FROM catalog.rss_file_snapshots s JOIN catalog.rss_file_article_lineage l ON l.snapshot_id=s.id LIMIT 0')
    if (apply) {
      ({ source, mapping } = await register(store, originFingerprint))
      await lock.query(`UPDATE ingest.import_runs SET status='failed',finished_at=now(),
        last_error='rss_snapshot_interrupted; superseded by full reconciliation'
        WHERE source_id=$1 AND status='running'`, [source.id])
      run = await store.startImportRun({ sourceId: source.id, mappingVersion: mapping.version,
        inputName: RSS_CONTRACT, trigger: 'manual' })
      report.importRunId = run.id
    }
    for (const phase of ['feeds', 'canonical', 'legacy']) {
      let last = null
      while (true) {
        if (Date.now() - started > maxDurationMs) throw new Error('rss_snapshot_deadline')
        // A lost session lock must stop writes, never continue unfenced.
        if (lock) await lock.query('SELECT 1')
        const rows = await readRssPage(reader, phase, last, batchSize)
        if (!rows.length) break
        if (phase === 'feeds') {
          if (apply) await lock.query(`INSERT INTO catalog.rss_subscription_snapshots (feed_id,payload,import_run_id)
            SELECT (value->>'scan_id')::uuid,value->'payload',$2::uuid FROM jsonb_array_elements($1::jsonb)
            ON CONFLICT (feed_id) DO UPDATE SET payload=EXCLUDED.payload,
              import_run_id=EXCLUDED.import_run_id,observed_at=now()`, [JSON.stringify(rows), run.id])
        } else {
          await attachRssFileEvidence(hubPool, rows, phase, originFingerprint)
          const records = rows.map(row => mapRssRow(row, phase))
          if (apply) {
            if (phase === 'canonical') {
              const identities = JSON.stringify(rows.map(row => ({ id: row.scan_id, identity: row.identity })))
              await lock.query(`INSERT INTO catalog.rss_article_identities (canonical_id,external_id)
                SELECT (value->>'id')::uuid,value->>'identity' FROM jsonb_array_elements($1::jsonb)
                ON CONFLICT (canonical_id) DO NOTHING`, [identities])
              const mismatch = await lock.query(`SELECT 1 FROM jsonb_array_elements($1::jsonb) input
                JOIN catalog.rss_article_identities known ON known.canonical_id=(input->>'id')::uuid
                WHERE known.external_id <> input->>'identity' LIMIT 1`, [identities])
              if (mismatch.rows.length) throw new Error('rss_article_identity_changed')
            }
            const result = await store.ingestExternalRecords({ datasetId: RSS_DATASET, platform: 'rss',
              connectorId: `external:${RSS_SOURCE_KEY}`, records, importRunId: run.id, sourceId: source.id, sessionClient: lock,
              batch: { key: `${phase}:${rows.at(-1).scan_id}`, rowCount: rows.length } })
            report.changed += result.changed
          }
        }
        report[phase] += rows.length
        last = rows.at(-1).scan_id
        onProgress({ ...report })
      }
    }
    await reader.query('ROLLBACK')
    if (run) await store.finishImportRun(run.id, { status: 'succeeded', rowCount: report.canonical + report.legacy,
      changedCount: report.changed, rejectedCount: 0 })
    return { ...report, status: apply ? 'succeeded' : 'validated' }
  } catch (error) {
    if (run) await store.finishImportRun(run.id, { status: 'failed', rowCount: report.canonical + report.legacy,
      changedCount: report.changed, error: 'rss_snapshot_failed; rerun full reconciliation' }).catch(() => {})
    throw error
  } finally {
    await reader.query('ROLLBACK').catch(() => {})
    reader.release()
    if (locked) await lock.query("SELECT pg_advisory_unlock(hashtextextended('hub:rss-snapshot:v1',0))").catch(() => {})
    lock?.release()
  }
}
