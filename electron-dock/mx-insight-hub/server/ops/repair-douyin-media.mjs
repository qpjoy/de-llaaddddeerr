#!/usr/bin/env node
// Explicit, resumable data repair; never invoked by deploy or schema migration.
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { normalizeSearchMedia, normalizeSearchContent, DOUYIN_MEDIA_POLICY } from '../contracts/search-content.mjs'
import { normalizeSearchPayload, canonicalJson, sha256 } from '../ingest/normalizers.mjs'
import { normalizeNightAllLegacyPayload } from '../ingest/legacy-night-all.mjs'

const POLICY = `repair:${DOUYIN_MEDIA_POLICY}`
const TARGETS = {
  canonical: { table: 'core.canonical_records', time: 'first_seen_at',
    where: "platform='douyin' AND object_type='post' AND deleted_at IS NULL" },
  deliveries: { table: 'usage_requests', time: 'created_at',
    where: "platform='douyin' AND status='committed' AND response_status=200 AND response_body IS NOT NULL" },
  snapshots: { table: 'serving.compatibility_snapshots', time: 'created_at',
    where: "platform='douyin'" },
}
const digest = value => sha256(canonicalJson(value))
const equal = (a, b) => isDeepStrictEqual(a, b)
const withoutMetrics = fields => { const { metrics, ...rest } = fields || {}; return rest }

// Match the current canonical content before adopting a normal ingestion hash.
// If an old row was manually edited or uses another mapper, repair only media
// and use a distinct manual-repair digest instead of asserting false lineage.
function sameContent(record, row, fields) {
  const columns = { externalId: 'external_id', objectType: 'object_type', contentType: 'content_type',
    title: 'title', body: 'body', url: 'url', authorExternalId: 'author_external_id', authorName: 'author_name',
    eventTime: 'event_time', latitude: 'latitude', longitude: 'longitude', countryCode: 'country_code',
    admin1Code: 'admin1_code', admin2Code: 'admin2_code' }
  return Object.entries(columns).every(([key, column]) => digest(record[key] ?? null) === digest(row[column] ?? null))
    && equal(withoutMetrics(record.stableFields), withoutMetrics(fields))
    && equal(record.extensions || {}, row.extensions || {})
}

export function planCanonical(row, raw) {
  const fields = row.stable_fields || {}
  const media = normalizeSearchMedia(fields.media, 'douyin', { contentType: row.content_type, objectType: row.object_type })
  if (media === fields.media) return null
  const stableFields = { ...fields, media }
  let mapped
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (row.dataset_id === 'night-all.search.v1') mapped = normalizeSearchPayload({ data: { items: [raw] } }, 'douyin').records[0]
    if (row.dataset_id === 'night-all.compat.v1') mapped = normalizeNightAllLegacyPayload({ data: { raw_data: JSON.stringify([raw]) } }, 'douyin', 'raw').records[0]
  }
  const compatible = mapped && sameContent(mapped, row, stableFields)
  return { stableFields, payloadSha256: compatible ? mapped.payloadSha256
    : digest({ policy: POLICY, previousPayloadSha256: row.payload_sha256, stableFields: withoutMetrics(stableFields) }),
  normalizedPayload: compatible ? raw : null }
}

export function planDelivery(body) {
  // The first pass preserves strict modern item shapes; the second handles raw
  // aliases and nested results. No title rule applies to Douyin.
  const normalized = normalizeSearchContent(normalizeSearchContent(body, 'douyin'), 'douyin', { format: 'raw' })
  return equal(body, normalized) ? null : normalized
}

export function parseArgs(args) {
  const options = { apply: false, includeDeliveries: false, batchSize: 50 }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') return { help: true }
    if (args[i] === '--apply') options.apply = true
    else if (args[i] === '--include-deliveries') options.includeDeliveries = true
    else if (args[i] === '--batch-size') {
      const value = args[++i]
      if (!/^\d+$/.test(value || '') || Number(value) < 1 || Number(value) > 200) throw new Error('invalid_batch_size')
      options.batchSize = Number(value)
    } else throw new Error('unknown_argument')
  }
  return options
}

async function prepareAudit(client) {
  // Existing control schema is private operator evidence, not a public API.
  await client.query(`CREATE TABLE IF NOT EXISTS control.douyin_media_repairs (
    id uuid PRIMARY KEY, run_id uuid NOT NULL, policy text NOT NULL,
    target text NOT NULL CHECK (target IN ('canonical','deliveries','snapshots')),
    target_id uuid NOT NULL, before_value jsonb NOT NULL, after_sha256 char(64) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now())`)
}

async function backup(client, { runId, target, row, after }) {
  await client.query(`INSERT INTO control.douyin_media_repairs
    (id,run_id,policy,target,target_id,before_value,after_sha256) VALUES($1,$2,$3,$4,$5,$6,$7)`,
  [randomUUID(), runId, POLICY, target, row.id, row, digest(after)])
}

async function repairCanonical(client, row, plan, runId) {
  await backup(client, { runId, target: 'canonical', row, after: { stableFields: plan.stableFields, payloadSha256: plan.payloadSha256 } })
  const updated = (await client.query(`UPDATE core.canonical_records
    SET stable_fields=$2,payload_sha256=$3,current_revision=current_revision+1,projection_revision=projection_revision+1
    WHERE id=$1 RETURNING *`, [row.id, plan.stableFields, plan.payloadSha256])).rows[0]
  await client.query(`INSERT INTO core.record_revisions
    (record_id,revision,payload_sha256,normalized_payload,parser_version,ingest_run_id)
    VALUES($1,$2,$3,$4,$5,$6)`, [row.id, updated.current_revision, plan.payloadSha256, plan.normalizedPayload || updated, POLICY, runId])
  await client.query(`INSERT INTO outbox.projection_events
    (aggregate_type,aggregate_id,event_type,projection_revision,payload)
    VALUES('canonical_record',$1,'upsert',$2,$3)`, [row.id, updated.projection_revision,
  { datasetId: row.dataset_id, platform: 'douyin', objectType: row.object_type }])
}

export async function repairDouyinMedia(pool, { apply = false, includeDeliveries = false, batchSize = 50, onProgress = () => {} } = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 200) throw new Error('invalid_batch_size')
  const client = await pool.connect()
  const runId = randomUUID(), totals = {}
  let locked = false
  try {
    if (apply) {
      locked = (await client.query("SELECT pg_try_advisory_lock(hashtextextended('ops:douyin-media-repair',0)) AS locked")).rows[0].locked
      if (!locked) throw new Error('repair_already_running')
      await prepareAudit(client)
    }
    const cutoff = (await client.query('SELECT clock_timestamp() AS cutoff')).rows[0].cutoff
    for (const target of includeDeliveries ? Object.keys(TARGETS) : ['canonical']) {
      const spec = TARGETS[target], stats = totals[target] = { scanned: 0, matched: 0, updated: 0 }
      let after = '00000000-0000-0000-0000-000000000000'
      for (;;) {
        await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
        try {
          await client.query("SET LOCAL lock_timeout='2s'")
          await client.query("SET LOCAL statement_timeout='15s'")
          // Keyset traversal, bounded row locks; do not SKIP LOCKED and falsely
          // claim completion while an ingest worker owns a matching old row.
          const rows = (await client.query(`SELECT * FROM ${spec.table}
            WHERE ${spec.where} AND id>$1 AND ${spec.time}<=$2 ORDER BY id LIMIT $3 ${apply ? 'FOR UPDATE' : ''}`,
          [after, cutoff, batchSize])).rows
          let matched = 0
          for (const row of rows) {
            let plan
            if (target === 'canonical') {
              if (!planCanonical(row, null)) continue
              const raw = (await client.query(`SELECT normalized_payload FROM core.record_revisions
                WHERE record_id=$1 AND revision=$2`, [row.id, row.current_revision])).rows[0]?.normalized_payload
              plan = planCanonical(row, raw)
            } else plan = planDelivery(row.response_body)
            if (!plan) continue
            matched++
            if (!apply) continue
            if (target === 'canonical') {
              await client.query(`INSERT INTO ingest.ingest_runs(id,connector_id,stream_id,trigger)
                VALUES($1,'ops:douyin-media-repair','douyin.media-repair.v1','manual_media_repair') ON CONFLICT(id) DO NOTHING`, [runId])
              await repairCanonical(client, row, plan, runId)
            } else {
              await backup(client, { runId, target, row, after: plan })
              await client.query(`UPDATE ${spec.table} SET response_body=$2 WHERE id=$1`, [row.id, plan])
            }
          }
          if (apply && target === 'canonical' && matched) {
            await client.query('UPDATE ingest.ingest_runs SET item_count=item_count+$2,finished_at=clock_timestamp() WHERE id=$1', [runId, matched])
          }
          await client.query('COMMIT')
          stats.scanned += rows.length
          stats.matched += matched
          if (apply) stats.updated += matched
          onProgress({ mode: apply ? 'apply' : 'preview', runId, target, ...stats })
          if (rows.length < batchSize) break
          after = rows.at(-1).id
        } catch (error) { await client.query('ROLLBACK'); throw error }
      }
    }
    return { mode: apply ? 'apply' : 'preview', runId, totals }
  } finally {
    let releaseError
    if (locked) {
      try { await client.query("SELECT pg_advisory_unlock(hashtextextended('ops:douyin-media-repair',0))") }
      catch (error) { releaseError = error }
    }
    client.release(releaseError)
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('node server/ops/repair-douyin-media.mjs [--apply] [--include-deliveries] [--batch-size 1..200]\nDefault: read-only canonical preview. --apply backs up and repairs matching media; --include-deliveries also changes historical response/replay bodies and raw snapshots. No upstream calls.')
    return
  }
  if (!process.env.DATABASE_URL) throw new Error('database_url_required')
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 15000 })
  try {
    let lastProgress = Date.now()
    console.log(JSON.stringify(await repairDouyinMedia(pool, { ...options, onProgress: value => {
      if (Date.now() - lastProgress >= 5000) {
        console.log(JSON.stringify(value))
        lastProgress = Date.now()
      }
    } })))
  } finally { await pool.end() }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    // Never print driver messages, connection strings, bodies or media URLs.
    const authored = ['invalid_batch_size','unknown_argument','database_url_required','repair_already_running']
    const code = authored.includes(error.message) ? error.message : /^[a-zA-Z0-9_]{1,60}$/.test(error.code || '') ? error.code : 'repair_failed'
    console.error(JSON.stringify({ error: code, message: 'Stopped; completed batches remain committed. Re-run the same command to continue.' }))
    process.exitCode = 1
  })
}
