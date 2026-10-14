import { createHash, randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { EXTERNAL_PLATFORM_OPERATION_CATALOG, PostgresExternalPlatformControlStore, normalizePriceBook } from '../external-platforms/control-store.mjs'
import { procurementAmount } from './price-drafts.mjs'
import { transactionPool } from './transaction.mjs'

const fail = (code, message, status = 409) => { throw new AppError(status, code, message) }
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const keyOf = (provider, endpoint) => `${provider}:${endpoint}`
const definitionFor = operation => EXTERNAL_PLATFORM_OPERATION_CATALOG[operation.provider]?.find(row => row.operationKey === operation.operationKey)
const priceFields = ['version', 'source', 'status', 'currency', 'pricingAsOf', 'monthlyBudgetMinor', 'monthlySubsidyBudgetMinor', 'endpointPrices']
const flagChecks = {
  ...Object.fromEntries(['verified', 'inferred', 'unverified', 'accountSpecific', 'actualChargeVerified', 'allowDiscount', 'allowFreeCredit']
    .map(key => [key, value => typeof value === 'boolean'])),
  priceBasis: value => ['official_catalog_base_rate', 'dated_public_catalog_rate', 'contract_account_rate'].includes(value),
  providerPath: value => typeof value === 'string' && /^\/api\/v1\/[a-zA-Z0-9_/-]{1,200}$/.test(value),
  endpointType: value => ['self-operated', 'third-party', 'self-owned'].includes(value),
  snapshotHash: value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
  refreshStatus: value => value === 'latest_refresh_http_405',
  apiId: value => typeof value === 'string' && /^\d{1,4}\.\d{1,4}$/.test(value),
}

// Source hashes identify reviewed evidence, not credentials. Decimal arithmetic
// stays in procurementAmount; the legacy dispatch budget remains integer minor.
export function normalizeProcurementSyncRate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !EXTERNAL_PLATFORM_OPERATION_CATALOG[input.provider]
    || typeof input.endpointKey !== 'string' || !/^[a-z][a-z0-9._-]{0,127}$/.test(input.endpointKey)
    || !['official', 'contract'].includes(input.sourceKind)
    || typeof input.sourceHash !== 'string' || !/^[a-f0-9]{64}$/i.test(input.sourceHash)) {
    fail('price_sync_invalid_evidence', 'Reviewed endpoint, source kind and SHA-256 evidence hash are required', 400)
  }
  let url
  try { url = new URL(input.sourceUrl) } catch { fail('price_sync_invalid_evidence', 'Evidence URL is invalid', 400) }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || typeof input.observedAt !== 'string' || !Number.isFinite(Date.parse(input.observedAt))) {
    fail('price_sync_invalid_evidence', 'Evidence URL or observation time is invalid', 400)
  }
  const flags = input.flags ?? {}
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)
    || flags.verified === false || flags.inferred === true || flags.unverified === true) {
    fail('price_sync_unverified_evidence', 'Inferred or unverified prices cannot be synchronized', 400)
  }
  if (Object.entries(flags).some(([key, value]) => !Object.hasOwn(flagChecks, key) || !flagChecks[key](value))) {
    fail('price_sync_invalid_evidence_flags', 'Evidence flags contain an unsupported field or value', 400)
  }
  return { provider: input.provider, endpointKey: input.endpointKey, billingUnit: 'request',
    ...procurementAmount(input.unitPrice, input.currency), sourceKind: input.sourceKind,
    sourceUrl: url.href, observedAt: new Date(input.observedAt).toISOString(), sourceHash: input.sourceHash.toLowerCase(),
    flags: { ...flags } }
}

function snapshot(operation) {
  return { provider: operation.provider, operationKey: operation.operationKey,
    controlSource: operation.controlSource, desiredState: operation.desiredState, revision: operation.revision,
    canaryConsumerIds: [...(operation.canaryConsumerIds || [])].sort(), release: operation.release,
    priceBook: Object.fromEntries(priceFields.map(key => [key, operation.priceBook?.[key] ?? null])),
    exactRates: operation.exactRates || [] }
}

export async function readProcurementSyncState(client, { providers }) {
  const selected = [...new Set(providers)].sort()
  if (selected.some(provider => !EXTERNAL_PLATFORM_OPERATION_CATALOG[provider])) {
    fail('price_sync_invalid_provider', 'Unsupported procurement provider', 400)
  }
  const control = new PostgresExternalPlatformControlStore({ pool: transactionPool(client) })
  const { rows } = await client.query(`SELECT r.provider_key,r.operation_key,r.price_book_version,d.specification
    FROM control.procurement_price_references r
    JOIN control.procurement_price_drafts d ON d.id=r.draft_id
    JOIN control.external_platform_operation_policies p ON p.provider_key=r.provider_key AND p.operation_key=r.operation_key
    JOIN control.external_platform_operation_releases v ON v.provider_key=p.provider_key AND v.operation_key=p.operation_key
      AND v.release_revision=p.release_revision AND v.price_book_version=r.price_book_version
    WHERE r.provider_key=ANY($1::text[])`, [selected])
  const references = new Map(rows.map(row => [keyOf(row.provider_key, row.operation_key), row.specification]))
  const operations = []
  for (const provider of selected) {
    // No runtime credentials, network probes or fabricated readiness are needed.
    for (const operation of await control.describeProvider(provider)) {
      const spec = references.get(keyOf(provider, operation.operationKey))
      const exactRates = []
      for (const rate of spec?.rates || []) {
        try { exactRates.push(normalizeProcurementSyncRate({ ...spec, ...rate, provider })) }
        catch { /* Older drafts without a source hash cannot attest identical evidence. */ }
      }
      operations.push({ provider, ...operation, exactRates: exactRates.sort((a, b) => a.endpointKey.localeCompare(b.endpointKey)) })
    }
  }
  return operations
}

export function planProcurementSync({ operations, rates }) {
  const normalized = rates.map(normalizeProcurementSyncRate).sort((a, b) => keyOf(a.provider, a.endpointKey).localeCompare(keyOf(b.provider, b.endpointKey)))
  const index = new Map()
  for (const rate of normalized) {
    const key = keyOf(rate.provider, rate.endpointKey)
    if (index.has(key)) fail('price_sync_duplicate_rate', 'An endpoint has duplicate price evidence', 400)
    index.set(key, rate)
  }
  const updates = [], skipped = [], unchanged = [], matched = new Set()
  for (const operation of [...operations].sort((a, b) => keyOf(a.provider, a.operationKey).localeCompare(keyOf(b.provider, b.operationKey)))) {
    const definition = definitionFor(operation)
    if (!definition) continue
    const endpointKeys = [...new Set([...definition.endpointKeys, ...(definition.optionalEndpointKeys || [])])]
    const targets = endpointKeys.map(endpoint => index.get(keyOf(operation.provider, endpoint))).filter(Boolean)
    if (!targets.length) continue
    targets.forEach(rate => matched.add(keyOf(rate.provider, rate.endpointKey)))
    const identity = { provider: operation.provider, operationKey: operation.operationKey }
    const skip = reason => skipped.push({ ...identity, reason, endpointKeys: targets.map(rate => rate.endpointKey) })
    const book = operation.priceBook || {}
    if (operation.controlSource !== 'database') { skip('legacy_control_requires_runtime_review'); continue }
    if (operation.migrationRequired || operation.release?.status !== 'released' || !Number.isSafeInteger(operation.revision)) { skip('release_unavailable'); continue }
    if (book.status === 'retired') { skip('retired_price_book'); continue }
    if (definition.dispatchBlock) { skip('operation_not_priceable'); continue }
    if (![book.monthlyBudgetMinor, book.monthlySubsidyBudgetMinor].every(value => Number.isSafeInteger(value) && value >= 0)) { skip('budget_policy_missing'); continue }
    if (!book.currency || targets.some(rate => rate.currency !== book.currency)) { skip('currency_mismatch'); continue }
    const prices = Object.fromEntries(endpointKeys.filter(key => book.endpointPrices?.[key] != null).map(key => [key, book.endpointPrices[key]]))
    const exact = new Map((operation.exactRates || []).map(rate => [rate.endpointKey, rate]))
    const changes = []
    for (const rate of targets) {
      if (prices[rate.endpointKey] === 0) {
        skipped.push({ ...identity, endpointKeys: [rate.endpointKey], reason: 'explicit_free_price_preserved' }); continue
      }
      if (rate.budgetMinor === 0 && !definition.allowZeroCost) {
        skipped.push({ ...identity, endpointKeys: [rate.endpointKey], reason: 'official_free_price_unsupported' }); continue
      }
      const previous = exact.get(rate.endpointKey)
      if (prices[rate.endpointKey] === rate.budgetMinor && previous && hash(previous) === hash(rate)) {
        unchanged.push({ ...identity, endpointKey: rate.endpointKey, reason: 'price_and_evidence_unchanged' }); continue
      }
      changes.push({ endpointKey: rate.endpointKey, previousBudgetMinor: prices[rate.endpointKey] ?? null,
        nextBudgetMinor: rate.budgetMinor, previousExact: previous || null, nextExact: rate })
      prices[rate.endpointKey] = rate.budgetMinor
      exact.set(rate.endpointKey, rate)
    }
    if (!changes.length) continue
    const pricingAsOf = targets.map(rate => rate.observedAt).sort().at(-1)
    const priceBook = { currency: book.currency, pricingAsOf, monthlyBudgetMinor: book.monthlyBudgetMinor,
      monthlySubsidyBudgetMinor: book.monthlySubsidyBudgetMinor, unitCostMinorByEndpoint: prices }
    try { normalizePriceBook(priceBook, definition) }
    catch { skip('incomplete_or_invalid_operation_price_book'); continue }
    updates.push({ ...identity, expectedRevision: operation.revision, expectedStateHash: hash(snapshot(operation)),
      previousPriceBookVersion: book.version, changes,
      exactRates: [...exact.values()].filter(rate => endpointKeys.includes(rate.endpointKey)).sort((a, b) => a.endpointKey.localeCompare(b.endpointKey)),
      body: { expectedRevision: operation.revision, desiredState: operation.desiredState,
        canaryConsumerIds: [...(operation.canaryConsumerIds || [])], priceBook,
        reason: 'Verified procurement price synchronization; preserve operation state, budgets and customer terms' } })
  }
  for (const rate of normalized) if (!matched.has(keyOf(rate.provider, rate.endpointKey))) {
    skipped.push({ provider: rate.provider, endpointKeys: [rate.endpointKey], reason: 'endpoint_not_registered' })
  }
  return { kind: 'price-sync-procurement', rates: normalized, updates, skipped, unchanged,
    summary: { updatedOperations: updates.length, changedEndpoints: updates.reduce((sum, row) => sum + row.changes.length, 0),
      skipped: skipped.length, unchanged: unchanged.length } }
}

// The caller owns one SERIALIZABLE transaction and its batch receipt. This
// function never begins/commits that outer transaction and never changes grants.
export async function applyProcurementSync(client, { batchId, plan }) {
  const isolation = (await client.query('SHOW transaction_isolation')).rows[0]?.transaction_isolation
  if (isolation !== 'serializable') fail('price_sync_transaction_required', 'A caller-owned SERIALIZABLE transaction is required')
  const batch = (await client.query(`SELECT status,specification->>'kind' AS kind
    FROM control.provisioning_batches WHERE id=$1 FOR UPDATE`, [batchId])).rows[0]
  if (!batch || batch.kind !== 'price-sync' || batch.status !== 'preview') {
    fail('price_sync_batch_invalid', 'An open price-sync batch is required')
  }
  if (plan?.kind !== 'price-sync-procurement' || !Array.isArray(plan.updates) || !Array.isArray(plan.rates)) {
    fail('price_sync_plan_invalid', 'A prepared procurement price-sync plan is required', 400)
  }
  const providers = [...new Set(plan.rates.map(rate => rate.provider))]
  const current = await readProcurementSyncState(client, { providers })
  const checked = planProcurementSync({ operations: current, rates: plan.rates })
  if (hash(checked) !== hash(plan)) fail('price_sync_changed', 'Procurement policy, prices or evidence changed; prepare another preview')
  const control = new PostgresExternalPlatformControlStore({ pool: transactionPool(client) })
  const applied = []
  for (const update of checked.updates) {
    const next = await control.updatePolicy(update.provider, update.operationKey,
      { ...update.body, reason: `Price sync batch ${batchId}: verified source prices; preserve state and budgets` }, { actor: 'admin-token' })
    const draftId = randomUUID()
    const spec = { kind: 'price-sync', provider: update.provider, name: `Verified procurement ${update.operationKey}`,
      rates: update.exactRates, costBasis: 'reference_decimal_and_conservative_minor_budget' }
    await client.query(`INSERT INTO control.procurement_price_drafts
      (id,provider_key,specification,specification_hash,created_by) VALUES($1,$2,$3,$4,$5)`,
    [draftId, update.provider, spec, hash(spec), 'admin-token'])
    await client.query(`INSERT INTO control.procurement_price_references
      (provider_key,operation_key,price_book_version,draft_id,batch_id) VALUES($1,$2,$3,$4,$5)`,
    [update.provider, update.operationKey, next.priceBook.version, draftId, batchId])
    applied.push({ provider: update.provider, operationKey: update.operationKey, revision: next.revision,
      priceBookVersion: next.priceBook.version, draftId, changedEndpoints: update.changes.map(row => row.endpointKey) })
  }
  return { applied }
}
