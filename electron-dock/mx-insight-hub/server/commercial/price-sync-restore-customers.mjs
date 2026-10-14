import { createHash, randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { readCustomerPriceSyncInventory } from './price-sync-customers.mjs'

const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
const hash = value => createHash('sha256').update(stable(value)).digest('hex')
const fail = (code, message) => { throw new AppError(409, code, message) }
const sortedEntries = entries => [...entries].sort((a, b) => a.meterKey.localeCompare(b.meterKey))
const currentHash = customer => { const { exposureByMeter, ...state } = customer; return hash(state) }
const quote = (minor, multiplier) => {
  if (!Number.isSafeInteger(Number(minor)) || Number(minor) < 0 || !Number.isSafeInteger(Number(multiplier)) || Number(multiplier) < 0) return null
  const amount = (BigInt(minor) * BigInt(multiplier) + 999_999n) / 1_000_000n
  return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : null
}

function normalizeSelections(selections) {
  if (!Array.isArray(selections) || !selections.length || selections.length > 2048) fail('customer_restore_selection_required', 'Select exact consumers and billing meters to restore')
  const selected = new Map()
  for (const selection of selections) {
    if (typeof selection?.consumerId !== 'string' || !selection.consumerId || !Array.isArray(selection.meterKeys)
      || !selection.meterKeys.length || selection.meterKeys.some(key => typeof key !== 'string' || !/^[a-z][a-z0-9._-]{0,127}$/u.test(key))) {
      fail('customer_restore_invalid_selection', 'Each customer selection requires exact billing meters')
    }
    const keys = selected.get(selection.consumerId) || new Set()
    for (const key of selection.meterKeys) keys.add(key)
    selected.set(selection.consumerId, keys)
  }
  if (new Set([...selected.values()].flatMap(keys => [...keys])).size > 2048) fail('customer_restore_invalid_selection', 'Select at most 2048 distinct billing meters')
  return [...selected].sort(([a], [b]) => a.localeCompare(b)).map(([consumerId, keys]) => ({ consumerId, meterKeys: [...keys].sort() }))
}

function sourceParts(sourceBatch) {
  if (!sourceBatch?.id || sourceBatch.status !== 'completed' || sourceBatch.specification?.kind !== 'price-sync'
    || sourceBatch.result?.status !== 'completed' || sourceBatch.result.batchId !== sourceBatch.id
    || !Array.isArray(sourceBatch.preview?.customer?.changes) || !Array.isArray(sourceBatch.result?.customers)) {
    fail('customer_restore_invalid_source', 'Restoration requires a completed price-sync batch with saved preview and receipts')
  }
  const changes = new Map(sourceBatch.preview.customer.changes.map(change => [change.consumerId, change]))
  const receipts = new Map(sourceBatch.result.customers.map(receipt => [receipt.consumerId, receipt]))
  if (changes.size !== sourceBatch.preview.customer.changes.length || receipts.size !== sourceBatch.result.customers.length) {
    fail('customer_restore_invalid_source', 'Source customer changes and receipts must be unique')
  }
  return { changes, receipts }
}

/** The saved preview contains the resulting entries, so load the immutable
 * original book as well. This reader performs no supplier calls or mutations. */
export async function readCustomerRestoreInventory(client, { sourceBatch, selections }) {
  selections = normalizeSelections(selections)
  const { changes } = sourceParts(sourceBatch)
  const meterKeys = [...new Set(selections.flatMap(row => row.meterKeys))].sort()
  const inventory = await readCustomerPriceSyncInventory(client, { meterKeys, consumerIds: selections.map(row => row.consumerId) })
  const versionIds = [...new Set(selections.map(row => changes.get(row.consumerId)?.expectedAssignment?.planVersionId).filter(Boolean))]
  const rows = versionIds.length ? (await client.query(`SELECT v.id AS plan_version_id,v.limits,v.pricing,
      b.id AS book_id,b.price_book_key,b.currency,b.default_multiplier_ppm,
      coalesce((SELECT jsonb_agg(jsonb_build_object('meterKey',e.meter_key,'billingUnit',e.billing_unit,
        'unitPriceMinor',e.unit_price_minor) ORDER BY e.meter_key)
        FROM billing.customer_price_entries e WHERE e.price_book_id=b.id),'[]'::jsonb) AS entries
    FROM plan_versions v LEFT JOIN billing.customer_price_books b ON b.id=v.customer_price_book_id
    WHERE v.id=ANY($1::uuid[])`, [versionIds])).rows : []
  return { ...inventory, originalPlanVersions: rows.map(row => ({ planVersionId: row.plan_version_id,
    limits: row.limits, pricing: row.pricing, priceBook: row.book_id ? { id: row.book_id, key: row.price_book_key,
      currency: row.currency, defaultMultiplierPpm: Number(row.default_multiplier_ppm), entries: row.entries } : null })) }
}

/** Explicit recovery intentionally bypasses the forward migration's high-price
 * protection. It restores only source-batch updates, never an arbitrary price. */
export function planCustomerRestore({ sourceBatch, inventory, selections }) {
  selections = normalizeSelections(selections)
  const source = sourceParts(sourceBatch), changes = [], decisions = []
  const customers = new Map((inventory.consumers || []).map(row => [row.consumerId, row]))
  const originals = new Map((inventory.originalPlanVersions || []).map(row => [row.planVersionId, row]))
  for (const selection of selections) {
    const originalChange = source.changes.get(selection.consumerId), receipt = source.receipts.get(selection.consumerId)
    const customer = customers.get(selection.consumerId)
    const original = originals.get(originalChange?.expectedAssignment?.planVersionId)
    const restored = new Map((customer?.priceBook?.entries || []).map(entry => [entry.meterKey, { ...entry }]))
    const oldEntries = new Map((original?.priceBook?.entries || []).map(entry => [entry.meterKey, entry]))
    const sourceDecisions = new Map((originalChange?.decisions || []).map(row => [row.meterKey, row]))
    const expectedSourceHash = originalChange && hash({ expectedHash: originalChange.expectedHash, currency: originalChange.currency,
      entries: originalChange.entries, defaultMultiplierPpm: originalChange.defaultMultiplierPpm, ratesByMeter: originalChange.ratesByMeter })
    let reason = null
    if (!originalChange || !receipt || !['applied', 'already_applied'].includes(receipt.status)) reason = 'customer_not_changed_by_source_batch'
    else if (!customer || !original) reason = 'customer_or_original_plan_unavailable'
    else if (!Number.isSafeInteger(receipt.revision) || receipt.revision !== originalChange.expectedAssignment.revision + 1
      || customer.assignment.planVersionId !== receipt.planVersionId || customer.assignment.revision !== receipt.revision
      || customer.assignment.assignedAt !== originalChange.expectedAssignment.assignedAt) reason = 'source_assignment_changed'
    else if (customer.tenantId !== originalChange.tenantId || !customer.priceBook || customer.priceBook.id !== receipt.priceBookId
      || customer.plan.pricing?.priceSync?.batchId !== sourceBatch.id
      || customer.plan.pricing?.priceSync?.previousPlanVersionId !== original.planVersionId
      || customer.plan.pricing?.priceSync?.changeHash !== expectedSourceHash
      || customer.priceBook.currency !== originalChange.currency
      || customer.priceBook.defaultMultiplierPpm !== originalChange.defaultMultiplierPpm
      || hash(sortedEntries(customer.priceBook.entries)) !== hash(sortedEntries(originalChange.entries))
      || hash(customer.plan.limits) !== hash(original.limits)) reason = 'source_receipt_or_price_state_mismatch'
    const customerDecisions = []
    for (const meterKey of selection.meterKeys) {
      const decision = { consumerId: selection.consumerId, meterKey, action: 'blocked', reason }
      const sourceDecision = sourceDecisions.get(meterKey), entry = oldEntries.get(meterKey)
      if (!reason && sourceDecision?.action !== 'update') decision.reason = 'meter_not_changed_by_source_batch'
      else if (!reason && entry) {
        if (sourceDecision.priceSource !== 'plan' || original.priceBook.currency !== sourceDecision.currentCurrency
          || Number(entry.unitPriceMinor) !== Number(sourceDecision.currentMinor)
          || original.priceBook.currency !== customer.priceBook.currency
          || original.priceBook.defaultMultiplierPpm !== customer.priceBook.defaultMultiplierPpm) decision.reason = 'original_price_evidence_mismatch'
        else {
          const targetQuotedMinor = quote(entry.unitPriceMinor, customer.profile?.multiplierPpm ?? customer.priceBook.defaultMultiplierPpm)
          if (targetQuotedMinor === null) decision.reason = 'restored_price_out_of_range'
          else {
            restored.set(meterKey, { ...entry })
            Object.assign(decision, { action: 'restore', reason: 'restore_original_book_entry', currency: original.priceBook.currency,
              targetMinor: Number(entry.unitPriceMinor), targetQuotedMinor, originalPriceSource: 'plan' })
          }
        }
      } else if (!reason && sourceDecision?.action === 'update') {
        if (sourceDecision.priceSource !== 'tenant_default' || !customer.profile
          || customer.profile.defaultCurrency !== sourceDecision.currentCurrency
          || Number(customer.profile.defaultUnitPriceMinor) !== sourceDecision.currentQuotedMinor) decision.reason = 'original_fallback_changed'
        else {
          restored.delete(meterKey)
          Object.assign(decision, { action: 'restore', reason: 'restore_original_tenant_fallback',
            currency: sourceDecision.currentCurrency, targetMinor: Number(customer.profile.defaultUnitPriceMinor),
            targetQuotedMinor: sourceDecision.currentQuotedMinor, originalPriceSource: 'tenant_default' })
        }
      }
      customerDecisions.push(decision)
    }
    decisions.push(...customerDecisions)
    if (!customerDecisions.some(row => row.action === 'blocked')) changes.push({ consumerId: customer.consumerId, tenantId: customer.tenantId,
      sourceBatchId: sourceBatch.id, originalPlanVersionId: original.planVersionId, meterKeys: selection.meterKeys,
      expectedHash: currentHash(customer), expectedAssignment: customer.assignment,
      currency: customer.priceBook.currency, defaultMultiplierPpm: customer.priceBook.defaultMultiplierPpm,
      entries: sortedEntries([...restored.values()]), decisions: customerDecisions })
  }
  return { version: 1, selections, changes, decisions, blocked: decisions.filter(row => row.action === 'blocked') }
}

/** The caller owns the SERIALIZABLE transaction, saved source batch, restore
 * batch audit, commit and idempotency. All selected customers are revalidated
 * before any writes. Published rows and the tenant fallback remain untouched. */
export async function applyCustomerRestore(client, { batchId, sourceBatch, plan }) {
  if (typeof batchId !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/u.test(batchId)) fail('customer_restore_invalid_batch', 'A stable restore batch ID is required')
  if (!plan || plan.blocked?.length || !plan.changes?.length) fail('customer_restore_blocked', 'Resolve all selected customer restore blockers before applying')
  const isolation = (await client.query('SHOW transaction_isolation')).rows[0]?.transaction_isolation
  if (isolation !== 'serializable') fail('customer_restore_transaction_required', 'Customer price restoration requires a SERIALIZABLE transaction')
  await client.query('SAVEPOINT customer_price_restore_transaction_guard')
  await client.query('RELEASE SAVEPOINT customer_price_restore_transaction_guard')
  for (const change of [...plan.changes].sort((a, b) => a.consumerId.localeCompare(b.consumerId))) {
    await client.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))', [`billing:tenant:${change.tenantId}`])
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${change.tenantId}:${change.consumerId}:plan-month`])
    await client.query('SELECT consumer_id FROM consumer_plan_assignments WHERE consumer_id=$1 FOR UPDATE', [change.consumerId])
  }
  const inventory = await readCustomerRestoreInventory(client, { sourceBatch, selections: plan.selections })
  const fresh = planCustomerRestore({ sourceBatch, inventory, selections: plan.selections })
  if (fresh.blocked.length || hash(fresh) !== hash(plan)) fail('customer_restore_stale', 'Selected customer prices, assignment or billing configuration changed; prepare a new preview')
  const receipts = []
  for (const change of fresh.changes) {
    const customer = inventory.consumers.find(row => row.consumerId === change.consumerId)
    const planId = randomUUID(), versionId = randomUUID(), bookId = change.entries.length ? randomUUID() : null
    const key = `price-restore-${hash({ batchId, consumerId: change.consumerId }).slice(0, 40)}`, actor = `price-restore:${batchId}`
    await client.query('INSERT INTO plans(id,plan_key,name,status) VALUES($1,$2,$3,\'active\')', [planId, key, customer.plan.name])
    if (bookId) {
      await client.query(`INSERT INTO billing.customer_price_books(id,price_book_key,version,currency,default_multiplier_ppm,status)
        VALUES($1,$2,1,$3,$4,'draft')`, [bookId, key, change.currency, change.defaultMultiplierPpm])
      for (const entry of change.entries) await client.query(`INSERT INTO billing.customer_price_entries
        (price_book_id,meter_key,billing_unit,unit_price_minor) VALUES($1,$2,$3,$4)`, [bookId, entry.meterKey, entry.billingUnit, entry.unitPriceMinor])
      await client.query(`UPDATE billing.customer_price_books SET status='published',published_at=now(),published_by=$2 WHERE id=$1`, [bookId, actor])
    }
    const pricing = { ...customer.plan.pricing, rateCount: change.entries.length,
      priceRestore: { batchId, sourceBatchId: sourceBatch.id, previousPlanVersionId: customer.assignment.planVersionId } }
    await client.query(`INSERT INTO plan_versions(id,plan_id,version,status,limits,pricing,customer_price_book_id,published_at)
      VALUES($1,$2,1,'published',$3,$4,$5,now())`, [versionId, planId, customer.plan.limits, pricing, bookId])
    const updated = await client.query(`UPDATE consumer_plan_assignments SET plan_version_id=$2,assigned_by=$3,revision=revision+1
      WHERE consumer_id=$1 AND revision=$4 AND plan_version_id=$5 AND assigned_at=$6::timestamptz
      RETURNING revision,to_char(assigned_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS assigned_at`,
    [change.consumerId, versionId, actor, customer.assignment.revision, customer.assignment.planVersionId, customer.assignment.assignedAt])
    if (updated.rowCount !== 1) fail('customer_restore_stale', 'Consumer assignment changed; the entire transaction must roll back')
    receipts.push({ status: 'applied', consumerId: change.consumerId, planVersionId: versionId, priceBookId: bookId,
      revision: Number(updated.rows[0].revision), assignedAt: updated.rows[0].assigned_at, restoredMeterKeys: change.meterKeys })
  }
  return receipts
}
