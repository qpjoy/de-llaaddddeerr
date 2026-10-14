import { createHash, randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { EXTERNAL_PLATFORM_OPERATION_CATALOG, PostgresExternalPlatformControlStore, normalizePriceBook } from '../external-platforms/control-store.mjs'
import { normalizeProcurementSyncRate, readProcurementSyncState } from './price-sync-procurement.mjs'
import { transactionPool } from './transaction.mjs'

const fail = (code, message, status = 409) => { throw new AppError(status, code, message) }
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const keyOf = row => `${row.provider}:${row.operationKey}`
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const sourceEvidence = batch => ({ id: batch.id, status: batch.status, preview: batch.preview, result: batch.result })

function indexByOperation(rows) {
  const index = new Map()
  for (const row of rows) {
    if (!row || typeof row.provider !== 'string' || typeof row.operationKey !== 'string' || index.has(keyOf(row))) {
      fail('price_restore_invalid_source', 'Operation evidence must be unique and complete', 400)
    }
    index.set(keyOf(row), row)
  }
  return index
}

function selectedOperations(selections) {
  if (!Array.isArray(selections) || !selections.length || selections.length > 2000
    || selections.some(value => typeof value !== 'string' || !/^[a-z][a-z0-9_-]*:[a-z][a-z0-9._-]*$/.test(value))
    || new Set(selections).size !== selections.length) {
    fail('price_restore_invalid_selection', 'Select unique exact provider:operation identities', 400)
  }
  return [...selections].sort()
}

function validateSource(sourceBatch) {
  if (!uuid(sourceBatch?.id) || sourceBatch.status !== 'completed' || sourceBatch.preview?.kind !== 'price-sync'
    || sourceBatch.result?.status !== 'completed' || sourceBatch.result.batchId !== sourceBatch.id
    || !Array.isArray(sourceBatch.preview?.procurement?.updates)
    || !Array.isArray(sourceBatch.result?.procurement?.applied)) {
    fail('price_restore_invalid_source', 'A completed price-sync batch with saved preview and receipt is required', 400)
  }
}

// A price restoration is another immutable version, never an undo of audit
// history. Source batches lack legacy runtime settings: state is never restored.
export function planProcurementRestore({ sourceBatch, operations, selections }) {
  validateSource(sourceBatch)
  const selected = selectedOperations(selections)
  const sourceUpdates = indexByOperation(sourceBatch.preview.procurement.updates)
  const receipts = indexByOperation(sourceBatch.result.procurement.applied)
  const current = indexByOperation(operations)
  const updates = [], skipped = [], notices = []
  for (const selection of selected) {
    const [provider, operationKey] = selection.split(':')
    const identity = { provider, operationKey }
    const skip = reason => skipped.push({ ...identity, reason })
    const original = sourceUpdates.get(selection), receipt = receipts.get(selection), operation = current.get(selection)
    const definition = EXTERNAL_PLATFORM_OPERATION_CATALOG[provider]?.find(row => row.operationKey === operationKey)
    if (!original || !receipt || !Array.isArray(original.changes) || !original.changes.length) { skip('source_operation_not_changed'); continue }
    if (!definition || !operation) { skip('operation_not_registered'); continue }
    if (!Number.isSafeInteger(receipt.revision) || !Number.isSafeInteger(receipt.priceBookVersion)
      || operation.revision !== receipt.revision || operation.priceBook?.version !== receipt.priceBookVersion) {
      skip('operation_changed_after_source_batch'); continue
    }
    if (operation.controlSource !== 'database' || operation.release?.status !== 'released'
      || operation.priceBook?.source !== 'database' || operation.priceBook.status !== 'reviewed'
      || operation.migrationRequired || definition.dispatchBlock) { skip('current_control_requires_manual_review'); continue }
    if (['disabled', 'paused', 'shadow'].includes(operation.desiredState)) {
      notices.push({ ...identity, reason: 'state_restoration_requires_separate_runtime_evidence', desiredState: operation.desiredState })
    }
    const book = operation.priceBook
    const endpointKeys = new Set([...definition.endpointKeys, ...(definition.optionalEndpointKeys || [])])
    const prices = { ...book.endpointPrices }
    const exact = new Map((operation.exactRates || []).map(rate => [rate.endpointKey, rate]))
    const seen = new Set(), changes = []
    let invalidSource = false
    for (const change of original.changes) {
      const endpointKey = change.endpointKey
      if (!endpointKeys.has(endpointKey) || seen.has(endpointKey)
        || prices[endpointKey] !== change.nextBudgetMinor) { invalidSource = true; break }
      seen.add(endpointKey)
      // Do not turn a configured operation back into missing-price rejection.
      if (!Number.isSafeInteger(change.previousBudgetMinor) || change.previousBudgetMinor < (definition.allowZeroCost ? 0 : 1)) {
        skipped.push({ ...identity, endpointKey, reason: 'previous_endpoint_price_missing_or_unsupported' }); continue
      }
      let previousExact = null
      if (change.previousExact) {
        try { previousExact = normalizeProcurementSyncRate(change.previousExact) }
        catch { invalidSource = true; break }
        if (previousExact.provider !== provider || previousExact.endpointKey !== endpointKey
          || previousExact.currency !== book.currency || previousExact.budgetMinor !== change.previousBudgetMinor) {
          invalidSource = true; break
        }
      }
      const nextExact = exact.get(endpointKey) || null
      let appliedExact
      try { appliedExact = change.nextExact ? normalizeProcurementSyncRate(change.nextExact) : null }
      catch { invalidSource = true; break }
      if (hash(nextExact) !== hash(appliedExact)) { invalidSource = true; break }
      prices[endpointKey] = change.previousBudgetMinor
      if (previousExact) exact.set(endpointKey, previousExact)
      else exact.delete(endpointKey)
      changes.push({ endpointKey, previousBudgetMinor: change.nextBudgetMinor, nextBudgetMinor: change.previousBudgetMinor,
        previousExact: nextExact, nextExact: previousExact })
    }
    if (invalidSource) { skip('source_endpoint_evidence_mismatch'); continue }
    if (!changes.length) continue
    const priceBook = { currency: book.currency, pricingAsOf: book.pricingAsOf,
      monthlyBudgetMinor: book.monthlyBudgetMinor, monthlySubsidyBudgetMinor: book.monthlySubsidyBudgetMinor,
      unitCostMinorByEndpoint: prices }
    try { normalizePriceBook(priceBook, definition) }
    catch { skip('restored_price_book_invalid'); continue }
    updates.push({ ...identity, expectedRevision: operation.revision, previousPriceBookVersion: book.version,
      sourcePriceBookVersion: original.previousPriceBookVersion, changes,
      exactRates: [...exact.values()].sort((a, b) => a.endpointKey.localeCompare(b.endpointKey)),
      body: { expectedRevision: operation.revision, desiredState: operation.desiredState,
        canaryConsumerIds: [...(operation.canaryConsumerIds || [])], priceBook,
        reason: `Restore procurement prices changed by batch ${sourceBatch.id}; preserve current state and budgets` } })
  }
  return { kind: 'price-sync-restore-procurement', sourceBatchId: sourceBatch.id, sourceHash: hash(sourceEvidence(sourceBatch)),
    selections: selected, updates, skipped, notices,
    summary: { updatedOperations: updates.length, changedEndpoints: updates.reduce((sum, row) => sum + row.changes.length, 0),
      skipped: skipped.length, notices: notices.length } }
}

// Caller owns the atomic SERIALIZABLE restore batch and its idempotent receipt.
export async function applyProcurementRestore(client, { batchId, sourceBatch, plan }) {
  const isolation = (await client.query('SHOW transaction_isolation')).rows[0]?.transaction_isolation
  if (isolation !== 'serializable') fail('price_restore_transaction_required', 'A caller-owned SERIALIZABLE transaction is required')
  const batch = (await client.query(`SELECT status,specification->>'kind' AS kind
    FROM control.provisioning_batches WHERE id=$1 FOR UPDATE`, [batchId])).rows[0]
  if (!batch || batch.kind !== 'price-sync-restore' || batch.status !== 'preview') {
    fail('price_restore_batch_invalid', 'An open price-sync-restore batch is required')
  }
  if (plan?.kind !== 'price-sync-restore-procurement' || !uuid(plan.sourceBatchId)
    || !Array.isArray(plan.updates) || sourceBatch?.id !== plan.sourceBatchId) {
    fail('price_restore_plan_invalid', 'A prepared procurement restoration plan and its source batch are required', 400)
  }
  const storedSource = (await client.query(`SELECT id,status,preview,result FROM control.provisioning_batches
    WHERE id=$1 FOR SHARE`, [plan.sourceBatchId])).rows[0]
  if (!storedSource || hash(sourceEvidence(storedSource)) !== hash(sourceEvidence(sourceBatch))) {
    fail('price_restore_source_changed', 'Source batch evidence changed; prepare another preview')
  }
  const providers = [...new Set(plan.selections.map(selection => selection.split(':')[0]))]
  const current = await readProcurementSyncState(client, { providers })
  const checked = planProcurementRestore({ sourceBatch: storedSource, operations: current, selections: plan.selections })
  if (hash(checked) !== hash(plan)) fail('price_restore_changed', 'Operation policy, prices or source evidence changed; prepare another preview')
  const control = new PostgresExternalPlatformControlStore({ pool: transactionPool(client) })
  const applied = []
  for (const update of checked.updates) {
    const next = await control.updatePolicy(update.provider, update.operationKey,
      { ...update.body, reason: `Price restore batch ${batchId} from ${plan.sourceBatchId}: preserve current state and budgets` }, { actor: 'admin-token' })
    const draftId = randomUUID()
    const specification = { kind: 'price-sync-restore', provider: update.provider,
      name: `Restored procurement ${update.operationKey}`, sourceBatchId: plan.sourceBatchId,
      sourcePriceBookVersion: update.sourcePriceBookVersion, rates: update.exactRates,
      costBasis: 'restored_prior_budget_and_available_exact_evidence' }
    await client.query(`INSERT INTO control.procurement_price_drafts
      (id,provider_key,specification,specification_hash,created_by) VALUES($1,$2,$3,$4,$5)`,
    [draftId, update.provider, specification, hash(specification), 'admin-token'])
    await client.query(`INSERT INTO control.procurement_price_references
      (provider_key,operation_key,price_book_version,draft_id,batch_id) VALUES($1,$2,$3,$4,$5)`,
    [update.provider, update.operationKey, next.priceBook.version, draftId, batchId])
    applied.push({ provider: update.provider, operationKey: update.operationKey, revision: next.revision,
      priceBookVersion: next.priceBook.version, draftId, changedEndpoints: update.changes.map(row => row.endpointKey) })
  }
  return { applied }
}
