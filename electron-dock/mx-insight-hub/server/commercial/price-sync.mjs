import { createHash, randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { PROVISIONING_CATALOG_VERSION } from './catalog.mjs'
import { verifiedPriceSources, ratesByCustomerMeter } from './verified-price-sources.mjs'
import { readProcurementSyncState, planProcurementSync, applyProcurementSync } from './price-sync-procurement.mjs'
import { readCustomerPriceSyncInventory, planCustomerPriceSync, applyCustomerPriceSync } from './price-sync-customers.mjs'

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
export const priceSyncHash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const fail = (status, code, message) => { throw new AppError(status, code, message) }
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)

// Presentation counts may grow between preview and apply. The exposure state
// and its reasons remain guarded by each customer's snapshot and the batch.
function decisionFingerprint(value) {
  if (Array.isArray(value)) return value.map(decisionFingerprint)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'exposure'
    ? { state: item.state, reasons: item.reasons } : decisionFingerprint(item)]))
}
const previewHash = value => priceSyncHash(decisionFingerprint(value))
const tally = rows => Object.fromEntries(rows.reduce((map, row) => map.set(row.reason, (map.get(row.reason) || 0) + 1), new Map()))

export function summarizePriceSync(preview) {
  return {
    sources: preview.sources,
    procurement: preview.procurement.summary,
    procurementSkipped: tally(preview.procurement.skipped),
    customer: { changedConsumers: preview.customer.changes.length,
      changedPrices: preview.customer.decisions.filter(row => row.action === 'update').length,
      kept: tally(preview.customer.decisions.filter(row => row.action === 'keep')),
      blocked: tally(preview.customer.blocked) },
    unmappedCustomerMeters: preview.customerMappingSkipped,
    excluded: preview.excluded,
  }
}

// This service only changes versioned prices. It does not invoke broad
// provisioning, runtime dispatch, wallet settlement or identity/grant mutation.
export class VerifiedPriceSyncService {
  constructor({ pool, sourceReader = verifiedPriceSources }) { this.pool = pool; this.sourceReader = sourceReader }

  async inspect(client) {
    const evidence = this.sourceReader()
    const providers = [...new Set(evidence.rates.map(rate => rate.provider))].sort()
    const procurement = planProcurementSync({
      operations: await readProcurementSyncState(client, { providers }), rates: evidence.rates,
    })
    const mapping = ratesByCustomerMeter(evidence.rates)
    const meterKeys = Object.keys(mapping.ratesByMeter)
    const customer = meterKeys.length
      ? planCustomerPriceSync(await readCustomerPriceSyncInventory(client, { meterKeys }), { ratesByMeter: mapping.ratesByMeter })
      : { version: 1, changes: [], decisions: [], blocked: [] }
    return { version: 1, kind: 'price-sync', catalogVersion: PROVISIONING_CATALOG_VERSION,
      evidenceHash: priceSyncHash(evidence), sources: evidence.sources, excluded: evidence.excluded,
      procurement, customer, customerMappingSkipped: mapping.skipped }
  }

  async preview() {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      const preview = await this.inspect(client)
      const batch = { id: randomUUID(), hash: previewHash(preview), status: 'preview',
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), summary: summarizePriceSync(preview) }
      await client.query(`INSERT INTO control.provisioning_batches
        (id,specification,preview,preview_hash,created_by,expires_at) VALUES($1,$2,$3,$4,$5,$6)`,
      [batch.id, { kind: 'price-sync', version: 1, evidenceHash: preview.evidenceHash }, preview, batch.hash, 'price-sync-cli', batch.expiresAt])
      await client.query('COMMIT')
      return batch
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    finally { client.release() }
  }

  async batch(id, executor = this.pool, lock = false) {
    if (!uuid(id)) fail(400, 'price_sync_invalid_batch', 'A valid saved price-sync batch UUID is required')
    const row = (await executor.query(`SELECT id,specification,preview,preview_hash AS hash,status,result,
      expires_at AS "expiresAt" FROM control.provisioning_batches WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0]
    if (!row || row.specification?.kind !== 'price-sync') fail(404, 'price_sync_not_found', 'Price-sync batch not found')
    return row
  }

  async apply(id, expectedHash) {
    if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) {
      fail(400, 'price_sync_hash_required', 'Use the exact hash returned by the saved preview')
    }
    const client = await this.pool.connect()
    let committing = false, releaseError
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      const batch = await this.batch(id, client, true)
      if (batch.hash !== expectedHash || previewHash(batch.preview) !== expectedHash) {
        fail(409, 'price_sync_hash_mismatch', 'The supplied hash does not match this preview')
      }
      if (batch.status === 'completed') {
        await client.query('COMMIT')
        return batch.result
      }
      if (Date.parse(batch.expiresAt) <= Date.now()) fail(409, 'price_sync_expired', 'Preview expired; prepare a new preview')
      const fresh = await this.inspect(client)
      if (previewHash(fresh) !== batch.hash) fail(409, 'price_sync_changed', 'Prices, exposure or source evidence changed; prepare a new preview')
      const procurement = await applyProcurementSync(client, { batchId: id, plan: fresh.procurement })
      const customers = []
      for (const change of fresh.customer.changes) customers.push(await applyCustomerPriceSync(client, change, { batchId: id }))
      const result = { batchId: id, status: 'completed', hash: batch.hash, procurement, customers,
        summary: summarizePriceSync(fresh), completedAt: new Date().toISOString() }
      await client.query(`UPDATE control.provisioning_batches SET status='completed',result=$2,applied_at=now() WHERE id=$1`, [id, result])
      committing = true
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(e => { releaseError = e })
      if (['40001', '40P01'].includes(error.code)) fail(409, 'price_sync_changed', 'Concurrent configuration or usage changed; prepare another preview')
      if (committing) {
        releaseError = error
        fail(503, 'price_sync_outcome_unknown', 'Commit outcome unknown; read or retry the SAME batch ID and hash')
      }
      throw error
    } finally { client.release(releaseError) }
  }
}
