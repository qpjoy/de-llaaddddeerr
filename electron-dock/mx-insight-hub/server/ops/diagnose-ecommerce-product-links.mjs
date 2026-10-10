import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import {
  extractJustOneProductSearchItems,
  inspectJustOneEnvelope,
  JUSTONE_SUPPORTED_MARKETPLACES,
  normalizeJustOneProductItem,
} from '../contracts/justone.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

// Offline projection only. No adapter, supplier credential, dispatch or writes.
// Return counts rather than restricted product data, URLs or source messages.
export function inspectEcommerceProductLinks(archive, marketplace) {
  if (!JUSTONE_SUPPORTED_MARKETPLACES.includes(marketplace)) return { state: 'unsupported_marketplace' }
  if (!archive?.body_bytes) return { state: 'archive_missing_or_oversized' }
  const bytes = Buffer.from(archive.body_bytes)
  if (createHash('sha256').update(bytes).digest('hex') !== archive.body_sha256) {
    return { state: 'archive_integrity_failed' }
  }
  let raw
  try { raw = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, '')) }
  catch { return { state: 'archive_not_json' } }
  const envelope = inspectJustOneEnvelope(raw)
  if (envelope.outcome !== 'success') {
    return { state: envelope.outcome === 'rejected' ? 'upstream_rejected' : 'invalid_envelope',
      businessCode: Number.isInteger(raw?.code) ? raw.code : null }
  }
  let items
  try { items = extractJustOneProductSearchItems(raw, marketplace).items }
  catch { return { state: 'unrecognized_item_list' } }
  if (items.length > 100) return { state: 'item_limit_exceeded' }
  const products = items.map(item => normalizeJustOneProductItem(item, marketplace)).filter(Boolean)
  return { state: 'projected', itemCount: items.length, productCount: products.length,
    discardedCount: items.length - products.length,
    urlCount: products.filter(item => item.url !== null).length,
    upstreamUrlCount: products.filter(item => item.urlSource === 'upstream').length,
    derivedUrlCount: products.filter(item => item.urlSource === 'derived_from_id').length,
    missingUrlCount: products.filter(item => item.url === null).length }
}

export async function diagnoseEcommerceProductLinks(client, requestIds) {
  if (!requestIds.length || requestIds.length > 10 || requestIds.some(id => !UUID.test(id))) {
    throw new Error('invalid_request_ids')
  }
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    const results = []
    for (const requestId of requestIds) {
      const { rows } = await client.query(`SELECT p.id, p.outcome, p.http_status, p.business_code,
        p.billed, p.latency_ms, u.acquisition_request #>> '{body,marketplace}' AS marketplace,
        a.body_bytes, a.body_sha256
        FROM external_platform.provider_calls p
        JOIN public.usage_requests u ON u.id = p.usage_request_id
        LEFT JOIN control.external_platform_restricted_raw_responses a
          ON a.provider_call_id = p.id AND a.body_size <= 8388608
        WHERE p.usage_request_id = $1 AND p.provider_key = 'justone'
          AND p.operation = 'ecommerce.products.search'
        ORDER BY p.started_at LIMIT 2`, [requestId])
      if (rows.length !== 1) {
        results.push({ requestId, state: rows.length ? 'multiple_calls_require_review' : 'call_not_found' })
        continue
      }
      const row = rows[0]
      results.push({ requestId, callId: row.id,
        marketplace: JUSTONE_SUPPORTED_MARKETPLACES.includes(row.marketplace) ? row.marketplace : null,
        outcome: row.outcome, httpStatus: row.http_status, businessCode: row.business_code,
        billed: row.billed, latencyMs: row.latency_ms,
        projection: inspectEcommerceProductLinks(row, row.marketplace) })
    }
    await client.query('ROLLBACK')
    return { mode: 'offline_read_only', results }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let client
  try {
    if (!process.env.DATABASE_URL) throw new Error('database_url_required')
    client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 })
    await client.connect()
    console.log(JSON.stringify(await diagnoseEcommerceProductLinks(client, process.argv.slice(2)), null, 2))
  } catch (error) {
    const known = ['database_url_required', 'invalid_request_ids']
    console.error(JSON.stringify({ error: known.includes(error.message) ? error.message : 'diagnostic_read_failed' }))
    process.exitCode = 1
  } finally { await client?.end() }
}
