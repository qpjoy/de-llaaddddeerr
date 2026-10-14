import { createHash, randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'

const meterPattern = /^[a-z][a-z0-9._-]{0,127}$/u
const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
const digest = value => createHash('sha256').update(stable(value)).digest('hex')
const fail = (code, message) => { throw new AppError(409, code, message) }
const integer = value => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null
const quote = (amount, multiplier) => {
  if (integer(amount) === null || integer(multiplier) === null) return null
  const result = (BigInt(amount) * BigInt(multiplier) + 999_999n) / 1_000_000n
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : null
}

export function customerPriceSyncSnapshotHash(customer) {
  return digest({ ...customer, exposureByMeter: Object.fromEntries(Object.entries(customer.exposureByMeter || {})
    .map(([key, exposure]) => [key, { state: exposure.state, reasons: exposure.reasons || [] }])) })
}

function meters(input) {
  if (!Array.isArray(input) || !input.length || input.length > 2048 || input.some(key => !meterPattern.test(key))) {
    fail('customer_price_sync_invalid_meters', 'Select 1–2048 exact customer billing meters')
  }
  return [...new Set(input)].sort()
}

// All amounts in the existing customer ledger are integer hundredths. Do not
// silently apply that convention to currencies with a different minor unit.
function verifiedRate(input) {
  const candidates = Array.isArray(input) ? input : [input]
  if (!candidates.length || candidates.some(rate => !rate || !rate.source)) return { error: 'price_evidence_missing' }
  const prices = []
  for (const rate of candidates) {
    if (rate.unit !== 'request') return { error: 'billing_unit_mismatch' }
    if (!['CNY', 'USD'].includes(rate.currency)) return { error: 'currency_minor_unit_unverified' }
    if (typeof rate.unitPrice !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/u.test(rate.unitPrice)) return { error: 'price_precision_unverified' }
    const [whole, fraction = ''] = rate.unitPrice.split('.')
    if (fraction.slice(2).replaceAll('0', '')) return { error: 'subminor_customer_price_unsupported' }
    const minor = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, '0'))
    if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return { error: 'price_out_of_range' }
    prices.push({ currency: rate.currency, minor: Number(minor) })
  }
  if (new Set(prices.map(rate => `${rate.currency}:${rate.minor}`)).size !== 1) return { error: 'shared_meter_price_conflict' }
  return { ...prices[0], sources: candidates.map(rate => rate.source) }
}

/** Read metadata only. No raw requests, credentials, supplier calls or mutations.
 * Exposure is deliberately conservative: a non-Admin live Key or a bound
 * commercial price without a proven internal identity means unknown, not unused.
 */
export async function readCustomerPriceSyncInventory(client, { meterKeys, consumerIds = null }) {
  meterKeys = meters(meterKeys)
  const rows = (await client.query(`
    SELECT c.id AS consumer_id,c.tenant_id,c.status AS consumer_status,t.status AS tenant_status,
      a.plan_version_id,a.revision AS assignment_revision,
      to_char(a.assigned_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS assigned_at,
      p.id AS plan_id,p.plan_key,p.name AS plan_name,p.status AS plan_status,
      v.version AS plan_version,v.status AS version_status,v.limits,v.pricing,
      b.id AS book_id,b.price_book_key,b.currency,b.default_multiplier_ppm,
      coalesce((SELECT jsonb_agg(jsonb_build_object('meterKey',e.meter_key,'billingUnit',e.billing_unit,
        'unitPriceMinor',e.unit_price_minor) ORDER BY e.meter_key)
        FROM billing.customer_price_entries e WHERE e.price_book_id=b.id),'[]'::jsonb) AS entries,
      CASE WHEN bp.tenant_id IS NULL THEN NULL ELSE jsonb_build_object('mode',bp.mode,'revision',bp.revision,
        'defaultCurrency',bp.default_currency,'defaultUnitPriceMinor',bp.default_unit_price_minor,
        'multiplierPpm',bp.multiplier_ppm) END AS profile,
      coalesce((SELECT jsonb_agg(ca.currency ORDER BY ca.currency) FROM billing.credit_accounts ca
        WHERE ca.tenant_id=c.tenant_id),'[]'::jsonb) AS wallet_currencies,
      (SELECT count(*)::integer FROM api_keys k WHERE k.consumer_id=c.id AND k.environment='live'
        AND NOT EXISTS(SELECT 1 FROM control.admin_execution_identity ai WHERE ai.api_key_id=k.id)) AS other_live_keys,
      (SELECT count(*)::integer FROM api_keys k JOIN control.admin_execution_identity ai ON ai.api_key_id=k.id
        WHERE k.consumer_id=c.id) AS admin_keys
    FROM consumers c JOIN tenants t ON t.id=c.tenant_id
    JOIN consumer_plan_assignments a ON a.consumer_id=c.id
    JOIN plan_versions v ON v.id=a.plan_version_id JOIN plans p ON p.id=v.plan_id
    LEFT JOIN billing.customer_price_books b ON b.id=v.customer_price_book_id
    LEFT JOIN billing.tenant_billing_profiles bp ON bp.tenant_id=c.tenant_id
    WHERE ($1::uuid[] IS NULL OR c.id=ANY($1::uuid[])) ORDER BY c.id`, [consumerIds])).rows
  const ids = rows.map(row => row.consumer_id)
  if (!ids.length) return { version: 1, meterKeys, consumers: [] }
  const usage = (await client.query(`SELECT u.consumer_id,u.billing_meter_key AS meter_key,
      count(*) FILTER(WHERE u.status='committed')::integer AS committed,
      count(*) FILTER(WHERE u.status IN ('reserved','unknown'))::integer AS unresolved,
      count(*) FILTER(WHERE u.status='released')::integer AS released,
      count(*) FILTER(WHERE u.status IN ('committed','reserved','unknown') AND NOT EXISTS
        (SELECT 1 FROM control.admin_execution_identity ai WHERE ai.api_key_id=u.api_key_id))::integer AS external_evidence
    FROM usage_requests u WHERE u.consumer_id=ANY($1::uuid[]) AND u.billing_meter_key=ANY($2::text[])
    GROUP BY u.consumer_id,u.billing_meter_key`, [ids, meterKeys])).rows
  const charges = (await client.query(`SELECT consumer_id,meter_key,
      count(*) FILTER(WHERE status='captured')::integer AS captured,
      count(*) FILTER(WHERE status IN ('reserved','unknown'))::integer AS unresolved,
      count(*) FILTER(WHERE status IN ('captured','reserved','unknown') AND NOT EXISTS
        (SELECT 1 FROM control.admin_execution_identity ai WHERE ai.api_key_id=billing.customer_charges.api_key_id))::integer AS external_evidence
    FROM billing.customer_charges WHERE consumer_id=ANY($1::uuid[]) AND meter_key=ANY($2::text[])
    GROUP BY consumer_id,meter_key`, [ids, meterKeys])).rows
  // Orders retain their original snapshots, including unpaid and scheduled
  // purchases. All IP product orders protect the related IP price candidates.
  const orders = meterKeys.some(key => key.startsWith('ip.risk.'))
    ? (await client.query(`SELECT c.id AS consumer_id,count(o.id)::integer AS orders
        FROM consumers c JOIN hub_commerce.orders o ON o.tenant_id=c.tenant_id
          AND (o.consumer_id IS NULL OR o.consumer_id=c.id)
        WHERE c.id=ANY($1::uuid[]) GROUP BY c.id`, [ids])).rows : []
  const index = items => new Map(items.map(row => [`${row.consumer_id}:${row.meter_key}`, row]))
  const byUsage = index(usage), byCharge = index(charges), byOrders = new Map(orders.map(row => [row.consumer_id, row.orders]))
  return { version: 1, meterKeys, consumers: rows.map(row => {
    const priceBook = row.book_id ? { id: row.book_id, key: row.price_book_key, currency: row.currency,
      defaultMultiplierPpm: Number(row.default_multiplier_ppm), entries: row.entries } : null
    const exposureByMeter = Object.fromEntries(meterKeys.map(meterKey => {
      const u = byUsage.get(`${row.consumer_id}:${meterKey}`), ch = byCharge.get(`${row.consumer_id}:${meterKey}`)
      const reasons = []
      if ((u?.external_evidence || 0) + (ch?.external_evidence || 0)) reasons.push('non_admin_usage_or_charge')
      if (meterKey.startsWith('ip.risk.') && byOrders.get(row.consumer_id)) reasons.push('existing_order_terms')
      const served = reasons.length > 0
      if (row.other_live_keys > 0) reasons.push('live_customer_key_identity_unknown')
      if (!row.admin_keys && priceBook?.entries.some(entry => entry.meterKey === meterKey)) reasons.push('assigned_customer_price')
      return [meterKey, { state: served ? 'served' : reasons.length ? 'unknown' : 'unserved', reasons,
        usage: { committed: u?.committed || 0, unresolved: u?.unresolved || 0, released: u?.released || 0 },
        charges: { captured: ch?.captured || 0, unresolved: ch?.unresolved || 0 } }]
    }))
    return { consumerId: row.consumer_id, tenantId: row.tenant_id, consumerStatus: row.consumer_status,
      tenantStatus: row.tenant_status,
      assignment: { planVersionId: row.plan_version_id, revision: Number(row.assignment_revision), assignedAt: row.assigned_at },
      plan: { id: row.plan_id, key: row.plan_key, name: row.plan_name, status: row.plan_status,
        version: row.plan_version, versionStatus: row.version_status, limits: row.limits, pricing: row.pricing },
      priceBook, profile: row.profile, walletCurrencies: row.wallet_currencies, exposureByMeter }
  }) }
}

/** ratesByMeter maps an exact Hub meter to one or more reviewed candidates:
 * { currency:'CNY', unit:'request', unitPrice:'0.10', source:{...evidence} }.
 * Customer currency conversion and subminor rounding are intentionally absent.
 */
export function planCustomerPriceSync(inventory, { ratesByMeter }) {
  const meterKeys = meters(Object.keys(ratesByMeter || {}))
  const decisions = [], changes = []
  for (const customer of inventory.consumers) {
    const entries = new Map((customer.priceBook?.entries || []).map(entry => [entry.meterKey, { ...entry }]))
    const customerDecisions = []
    let targetCurrency = customer.priceBook?.currency || customer.profile?.defaultCurrency
    for (const meterKey of meterKeys) {
      const entry = entries.get(meterKey), profile = customer.profile
      const currentCurrency = entry ? customer.priceBook.currency : profile?.defaultCurrency
      const currentMinor = entry?.unitPriceMinor ?? profile?.defaultUnitPriceMinor
      const multiplier = entry ? profile?.multiplierPpm ?? customer.priceBook.defaultMultiplierPpm : 1_000_000
      const currentQuotedMinor = quote(currentMinor, multiplier)
      const exposure = customer.exposureByMeter?.[meterKey] || { state: 'unknown', reasons: ['exposure_not_observed'] }
      const decision = { consumerId: customer.consumerId, meterKey, currentMinor, currentQuotedMinor,
        currentCurrency, priceSource: entry ? 'plan' : 'tenant_default', exposure, action: 'blocked', reason: null }
      const rate = verifiedRate(ratesByMeter[meterKey])
      if (!profile || currentQuotedMinor === null) decision.reason = 'customer_price_unavailable'
      else if (customer.consumerStatus !== 'active' || customer.tenantStatus !== 'active'
        || customer.plan.status !== 'active' || customer.plan.versionStatus !== 'published') decision.reason = 'customer_identity_or_plan_inactive'
      else if (Number(currentMinor) === 0 || currentQuotedMinor === 0) Object.assign(decision, { action: 'keep', reason: 'explicit_free_preserved' })
      else if (rate.error) decision.reason = rate.error
      else if (entry && entry.billingUnit !== 'request') decision.reason = 'billing_unit_mismatch'
      else if (rate.currency !== currentCurrency || (targetCurrency && rate.currency !== targetCurrency)) decision.reason = 'customer_currency_conversion_required'
      else if (customer.walletCurrencies?.length && !customer.walletCurrencies.includes(rate.currency)) decision.reason = 'wallet_currency_mismatch'
      else {
        targetCurrency ||= rate.currency
        const nextMultiplier = profile.multiplierPpm ?? customer.priceBook?.defaultMultiplierPpm ?? 1_000_000
        const nextQuotedMinor = quote(rate.minor, nextMultiplier)
        Object.assign(decision, { targetMinor: rate.minor, targetQuotedMinor: nextQuotedMinor, currency: rate.currency, sources: rate.sources })
        if (nextQuotedMinor === null) decision.reason = 'price_out_of_range'
        else if ((Number(currentMinor) > rate.minor || currentQuotedMinor > nextQuotedMinor || currentQuotedMinor > rate.minor)
          && exposure.state !== 'unserved') Object.assign(decision, { action: 'keep', reason: 'served_or_unknown_high_price_preserved' })
        else if (Number(currentMinor) === rate.minor && currentQuotedMinor === nextQuotedMinor) Object.assign(decision, { action: 'keep', reason: 'price_already_matches' })
        else {
          Object.assign(decision, { action: 'update', reason: Number(currentMinor) === 1 ? 'authorized_one_minor_calibration' : 'verified_unprotected_price_calibration' })
          entries.set(meterKey, { meterKey, billingUnit: 'request', unitPriceMinor: rate.minor })
        }
      }
      customerDecisions.push(decision)
    }
    decisions.push(...customerDecisions)
    if (customerDecisions.some(row => row.action === 'update')) {
      changes.push({ consumerId: customer.consumerId, tenantId: customer.tenantId,
        expectedHash: customerPriceSyncSnapshotHash(customer), expectedAssignment: customer.assignment,
        currency: targetCurrency, defaultMultiplierPpm: customer.priceBook?.defaultMultiplierPpm ?? 1_000_000,
        entries: [...entries.values()].sort((a, b) => a.meterKey.localeCompare(b.meterKey)),
        ratesByMeter, decisions: customerDecisions })
    }
  }
  return { version: 1, changes, decisions, blocked: decisions.filter(row => row.action === 'blocked') }
}

/** Call inside the caller's SERIALIZABLE transaction; never begin or commit.
 * A dedicated plan prevents changing the default launch plan for future users.
 * The original assigned_at is retained, so existing quota periods do not reset.
 */
export async function applyCustomerPriceSync(client, change, { batchId }) {
  if (typeof batchId !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/u.test(batchId)) fail('customer_price_sync_invalid_batch', 'A stable batch ID is required')
  const isolation = (await client.query('SHOW transaction_isolation')).rows[0]?.transaction_isolation
  if (isolation !== 'serializable') fail('customer_price_sync_transaction_required', 'Customer price migration requires a SERIALIZABLE transaction')
  // SAVEPOINT rejects an autocommit connection even if its session default is serializable.
  await client.query('SAVEPOINT customer_price_sync_transaction_guard')
  await client.query('RELEASE SAVEPOINT customer_price_sync_transaction_guard')
  await client.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))', [`billing:tenant:${change.tenantId}`])
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${change.tenantId}:${change.consumerId}:plan-month`])
  await client.query('SELECT consumer_id FROM consumer_plan_assignments WHERE consumer_id=$1 FOR UPDATE', [change.consumerId])
  const key = `price-sync-${digest({ batchId, consumerId: change.consumerId }).slice(0, 40)}`
  const changeHash = digest({ expectedHash: change.expectedHash, currency: change.currency,
    entries: change.entries, defaultMultiplierPpm: change.defaultMultiplierPpm, ratesByMeter: change.ratesByMeter })
  const prior = (await client.query(`SELECT v.id,v.pricing,a.plan_version_id FROM plans p
    JOIN plan_versions v ON v.plan_id=p.id LEFT JOIN consumer_plan_assignments a ON a.consumer_id=$2
    WHERE p.plan_key=$1`, [key, change.consumerId])).rows[0]
  if (prior) {
    if (prior.pricing?.priceSync?.changeHash !== changeHash || prior.plan_version_id !== prior.id) {
      fail('customer_price_sync_batch_conflict', 'This batch was used for different prices or the customer assignment changed')
    }
    return { status: 'already_applied', consumerId: change.consumerId, planVersionId: prior.id }
  }
  const inventory = await readCustomerPriceSyncInventory(client, { meterKeys: Object.keys(change.ratesByMeter), consumerIds: [change.consumerId] })
  const customer = inventory.consumers[0]
  if (!customer || customer.tenantId !== change.tenantId || customerPriceSyncSnapshotHash(customer) !== change.expectedHash) {
    fail('customer_price_sync_stale', 'Customer price, assignment, billing or exposure changed; prepare a new preview')
  }
  const fresh = planCustomerPriceSync(inventory, { ratesByMeter: change.ratesByMeter }).changes[0]
  if (!fresh || digest({ entries: fresh.entries, currency: fresh.currency, defaultMultiplierPpm: fresh.defaultMultiplierPpm })
    !== digest({ entries: change.entries, currency: change.currency, defaultMultiplierPpm: change.defaultMultiplierPpm })) {
    fail('customer_price_sync_invalid_change', 'The requested change does not match the verified price preview')
  }
  const planId = randomUUID(), bookId = randomUUID(), versionId = randomUUID(), actor = `price-sync:${batchId}`
  await client.query('INSERT INTO plans(id,plan_key,name,status) VALUES($1,$2,$3,\'active\')', [planId, key, customer.plan.name])
  await client.query(`INSERT INTO billing.customer_price_books(id,price_book_key,version,currency,default_multiplier_ppm,status)
    VALUES($1,$2,1,$3,$4,'draft')`, [bookId, key, change.currency, change.defaultMultiplierPpm])
  for (const entry of change.entries) await client.query(`INSERT INTO billing.customer_price_entries
    (price_book_id,meter_key,billing_unit,unit_price_minor) VALUES($1,$2,$3,$4)`, [bookId, entry.meterKey, entry.billingUnit, entry.unitPriceMinor])
  await client.query(`UPDATE billing.customer_price_books SET status='published',published_at=now(),published_by=$2 WHERE id=$1`, [bookId, actor])
  // Plan pricing is also a customer DTO. Supplier evidence belongs to the
  // caller's Admin-only batch audit, never this customer-visible metadata.
  const pricing = { ...customer.plan.pricing, currency: change.currency, defaultMultiplierPpm: change.defaultMultiplierPpm,
    rateCount: change.entries.length, priceSync: { batchId, changeHash, previousPlanVersionId: customer.assignment.planVersionId } }
  await client.query(`INSERT INTO plan_versions(id,plan_id,version,status,limits,pricing,customer_price_book_id,published_at)
    VALUES($1,$2,1,'published',$3,$4,$5,now())`, [versionId, planId, customer.plan.limits, pricing, bookId])
  const updated = await client.query(`UPDATE consumer_plan_assignments SET plan_version_id=$2,assigned_by=$3,revision=revision+1
    WHERE consumer_id=$1 AND revision=$4 AND plan_version_id=$5 AND assigned_at=$6::timestamptz RETURNING revision,assigned_at`,
  [change.consumerId, versionId, actor, customer.assignment.revision, customer.assignment.planVersionId, customer.assignment.assignedAt])
  if (updated.rowCount !== 1) fail('customer_price_sync_stale', 'Consumer assignment changed; the entire transaction must roll back')
  return { status: 'applied', consumerId: change.consumerId, planVersionId: versionId, priceBookId: bookId,
    revision: Number(updated.rows[0].revision), assignedAt: new Date(updated.rows[0].assigned_at).toISOString() }
}
