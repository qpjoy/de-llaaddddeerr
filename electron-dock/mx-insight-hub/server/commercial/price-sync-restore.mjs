import { randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { VerifiedPriceSyncService, priceSyncHash, priceSyncPreviewHash } from './price-sync.mjs'
import { readProcurementSyncState } from './price-sync-procurement.mjs'
import { planProcurementRestore, applyProcurementRestore } from './price-sync-restore-procurement.mjs'
import { readCustomerRestoreInventory, planCustomerRestore, applyCustomerRestore } from './price-sync-restore-customers.mjs'

const fail = (status, code, message) => { throw new AppError(status, code, message) }
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
export function normalizeRestoreSelection(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['procurement', 'customers', 'reason'].includes(key))
    || typeof input.reason !== 'string' || input.reason.trim().length < 3 || input.reason.length > 512) {
    fail(400, 'price_restore_selection_invalid', 'Provide exact selections and a short explanation of the observed impact')
  }
  const procurement = input.procurement || [], customers = input.customers || []
  if (!Array.isArray(procurement) || !Array.isArray(customers) || procurement.length + customers.length === 0
    || procurement.length > 2000 || customers.length > 100
    || procurement.some(row => typeof row !== 'string' || !/^[a-z][a-z0-9_-]*:[a-z][a-z0-9._-]{0,127}$/.test(row))
    || new Set(procurement).size !== procurement.length || new Set(customers.map(row => row?.consumerId)).size !== customers.length
    || customers.some(row => !row || !uuid(row.consumerId) || Object.keys(row).some(key => !['consumerId', 'meterKeys'].includes(key))
      || !Array.isArray(row.meterKeys) || !row.meterKeys.length || row.meterKeys.length > 2048
      || row.meterKeys.some(key => typeof key !== 'string' || !/^[a-z][a-z0-9._-]{0,127}$/.test(key))
      || new Set(row.meterKeys).size !== row.meterKeys.length)) {
    fail(400, 'price_restore_selection_invalid', 'Use unique exact provider:operation and consumer/meter selections; wildcards are not supported')
  }
  return { reason: input.reason.trim(), procurement: [...procurement].sort(),
    customers: customers.map(row => ({ consumerId: row.consumerId, meterKeys: [...row.meterKeys].sort() })).sort((a, b) => a.consumerId.localeCompare(b.consumerId)) }
}

const summary = view => ({ sourceBatchId: view.sourceBatchId, canApply: view.canApply,
  procurement: view.procurement?.summary || { updatedOperations: 0, changedEndpoints: 0 },
  procurementBlocked: view.procurement?.skipped || [], notices: view.procurement?.notices || [],
  customers: { changedConsumers: view.customers?.changes.length || 0,
    restoredPrices: view.customers?.decisions.filter(row => row.action === 'restore').length || 0,
    blocked: view.customers?.blocked || [] } })

export class PriceSyncRestoreService {
  constructor({ pool }) { this.pool = pool }
  async inspect(client, sourceBatchId, selection) {
    selection = normalizeRestoreSelection(selection)
    const source = await new VerifiedPriceSyncService({ pool: this.pool }).batch(sourceBatchId, client)
    if (source.status !== 'completed') fail(409, 'price_restore_source_incomplete', 'Only a completed price migration can be restored')
    if (priceSyncPreviewHash(source.preview) !== source.hash || source.result?.hash !== source.hash
      || source.result?.status !== 'completed' || source.result?.batchId !== source.id) {
      fail(409, 'price_restore_source_invalid', 'Original preview and completion receipt do not match; do not restore altered evidence')
    }
    let procurement = null, customers = null
    if (selection.procurement.length) {
      const providers = [...new Set(selection.procurement.map(row => row.split(':')[0]))]
      procurement = planProcurementRestore({ sourceBatch: source,
        operations: await readProcurementSyncState(client, { providers }), selections: selection.procurement })
    }
    if (selection.customers.length) {
      const inventory = await readCustomerRestoreInventory(client, { sourceBatch: source, selections: selection.customers })
      customers = planCustomerRestore({ sourceBatch: source, inventory, selections: selection.customers })
    }
    const canApply = !procurement?.skipped.length && !customers?.blocked.length
      && (Boolean(procurement?.updates.length) || Boolean(customers?.changes.length))
    return { view: { kind: 'price-sync-restore', version: 1, sourceBatchId, selection,
      sourceHash: priceSyncHash({ id: source.id, preview: source.preview, result: source.result }),
      procurement, customers, canApply }, source }
  }
  async preview(sourceBatchId, selection) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      const { view } = await this.inspect(client, sourceBatchId, selection)
      const batch = { id: randomUUID(), hash: priceSyncHash(view), status: 'preview',
        expiresAt: new Date(Date.now() + 30 * 60000).toISOString(), summary: summary(view) }
      await client.query(`INSERT INTO control.provisioning_batches
        (id,specification,preview,preview_hash,created_by,expires_at) VALUES($1,$2,$3,$4,$5,$6)`,
      [batch.id, { kind: 'price-sync-restore', sourceBatchId, selection: view.selection }, view, batch.hash, 'price-restore-cli', batch.expiresAt])
      await client.query('COMMIT')
      return batch
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    finally { client.release() }
  }
  async batch(id, executor = this.pool, lock = false) {
    if (!uuid(id)) fail(400, 'price_restore_invalid_batch', 'A restore batch UUID is required')
    const row = (await executor.query(`SELECT id,specification,preview,preview_hash AS hash,status,result,
      expires_at AS "expiresAt" FROM control.provisioning_batches WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0]
    if (row?.specification?.kind !== 'price-sync-restore') fail(404, 'price_restore_not_found', 'Restore batch not found')
    return row
  }
  async apply(id, expectedHash) {
    if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) fail(400, 'price_restore_hash_required', 'Use the saved restore preview hash')
    const client = await this.pool.connect()
    let committing = false, releaseError
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      const batch = await this.batch(id, client, true)
      if (batch.hash !== expectedHash || priceSyncHash(batch.preview) !== expectedHash) fail(409, 'price_restore_hash_mismatch', 'Restore preview hash differs')
      if (batch.status === 'completed') { await client.query('COMMIT'); return batch.result }
      if (Date.parse(batch.expiresAt) <= Date.now()) fail(409, 'price_restore_expired', 'Restore preview expired; prepare another preview')
      const { view, source } = await this.inspect(client, batch.specification.sourceBatchId, batch.specification.selection)
      if (priceSyncHash(view) !== batch.hash) fail(409, 'price_restore_changed', 'Prices or source evidence changed; prepare another preview')
      if (!view.canApply) fail(409, 'price_restore_blocked', 'Resolve all selected restore blockers before applying')
      const procurement = view.procurement ? await applyProcurementRestore(client, { batchId: id, sourceBatch: source, plan: view.procurement }) : { applied: [] }
      const customers = view.customers ? await applyCustomerRestore(client, { batchId: id, sourceBatch: source, plan: view.customers }) : []
      const result = { status: 'completed', batchId: id, sourceBatchId: source.id, hash: batch.hash,
        procurement, customers, summary: summary(view), completedAt: new Date().toISOString() }
      await client.query("UPDATE control.provisioning_batches SET status='completed',result=$2,applied_at=now() WHERE id=$1", [id, result])
      committing = true
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(e => { releaseError = e })
      if (['40001', '40P01'].includes(error.code)) fail(409, 'price_restore_changed', 'Concurrent metadata changed; prepare another preview')
      if (committing) { releaseError = error; fail(503, 'price_restore_outcome_unknown', 'Read or retry the SAME restore batch and hash to resolve the commit outcome') }
      throw error
    } finally { client.release(releaseError) }
  }
}
