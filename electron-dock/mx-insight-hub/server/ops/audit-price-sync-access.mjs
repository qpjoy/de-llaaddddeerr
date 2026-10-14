import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import pg from 'pg'

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
// Match the forward preview algorithm while keeping this operator script
// standalone for streaming into an already deployed Pod.
export function auditPreviewHash(value) {
  const normalize = item => Array.isArray(item) ? item.map(normalize) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(key === 'exposure'
      ? { state: item[key].state, reasons: item[key].reasons } : item[key])])) : item
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex')
}
const quote = (minor, multiplier) => {
  if (minor == null || multiplier == null) return null
  const value = (BigInt(minor) * BigInt(multiplier) + 999999n) / 1000000n
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null
}

export function customerAccessImpact(decision, current, receipt) {
  const currency = current.entry_minor == null ? current.default_currency : current.book_currency
  const currentQuote = quote(current.entry_minor ?? current.default_unit_price_minor,
    current.entry_minor == null ? 1000000 : current.multiplier_ppm ?? current.default_multiplier_ppm)
  const matchesMigration = current.plan_version_id === receipt?.planVersionId
    && Number(current.assignment_revision) === receipt?.revision
    && currentQuote === decision.targetQuotedMinor && currency === decision.currency
  const available = current.available_minor == null ? null : Number(current.available_minor)
  const walletReady = current.wallet_status === 'active' && current.wallet_currency === currency
  const increased = decision.targetQuotedMinor > decision.currentQuotedMinor
  return { consumerId: decision.consumerId, consumerName: current.consumer_name, meterKey: decision.meterKey,
    mode: current.mode, currency, oldQuotedMinor: decision.currentQuotedMinor,
    migratedQuotedMinor: decision.targetQuotedMinor, currentQuotedMinor: currentQuote,
    availableMinor: available, walletStatus: current.wallet_status, walletCurrency: current.wallet_currency,
    matchesMigration, increased,
    oldAffordableNewUnaffordableNow: matchesMigration && increased && current.mode === 'enforced' && walletReady
      && available >= decision.currentQuotedMinor && available < currentQuote,
    currentlyUnaffordable: current.mode === 'enforced' && currentQuote > 0 && (!walletReady || available < currentQuote) }
}

// Standalone and read-only, so it can also be streamed into the existing Admin
// Pod with node --input-type=module - BATCH_ID; no new image or supplier call.
export async function auditPriceSyncAccess(client, id) {
  if (!uuid(id)) throw new Error('A price-sync batch UUID is required')
  const source = (await client.query(`SELECT id,status,specification,preview,preview_hash AS hash,result,applied_at
    FROM control.provisioning_batches WHERE id=$1`, [id])).rows[0]
  if (source?.specification?.kind !== 'price-sync' || source.status !== 'completed') throw new Error('A completed price-sync batch is required')
  if (source.result?.status !== 'completed' || source.result?.batchId !== id || source.result?.hash !== source.hash
    || auditPreviewHash(source.preview) !== source.hash) throw new Error('Original preview and completed receipt hashes do not match')
  const now = new Date(), completedAt = new Date(source.result.completedAt)
  // Bound historical reads; disclose if older evidence falls outside the scan.
  const from = new Date(Math.max(completedAt.getTime(), now.getTime() - 7 * 86400000)).toISOString()
  const updates = source.preview.procurement.updates
  const providers = [...new Set(updates.map(row => row.provider))]
  const decisions = source.preview.customer.decisions.filter(row => row.action === 'update')
  const targets = decisions.map(row => ({ consumer_id: row.consumerId, meter_key: row.meterKey }))
  const current = (await client.query(`WITH targets AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(consumer_id uuid,meter_key text))
    SELECT x.consumer_id,x.meter_key,c.name AS consumer_name,a.plan_version_id,a.revision AS assignment_revision,
      bp.mode,bp.default_currency,bp.default_unit_price_minor,bp.multiplier_ppm,
      b.currency AS book_currency,b.default_multiplier_ppm,e.unit_price_minor AS entry_minor,
      w.currency AS wallet_currency,w.status AS wallet_status,w.available_minor
    FROM targets x JOIN consumers c ON c.id=x.consumer_id
    LEFT JOIN consumer_plan_assignments a ON a.consumer_id=c.id
    LEFT JOIN plan_versions v ON v.id=a.plan_version_id
    LEFT JOIN billing.customer_price_books b ON b.id=v.customer_price_book_id
    LEFT JOIN billing.customer_price_entries e ON e.price_book_id=b.id AND e.meter_key=x.meter_key
    LEFT JOIN billing.tenant_billing_profiles bp ON bp.tenant_id=c.tenant_id
    LEFT JOIN billing.credit_accounts w ON w.tenant_id=c.tenant_id
    ORDER BY x.consumer_id,x.meter_key`, [JSON.stringify(targets)])).rows
  const index = new Map(current.map(row => [`${row.consumer_id}:${row.meter_key}`, row]))
  const receipts = new Map(source.result.customers.map(row => [row.consumerId, row]))
  const customerImpacts = decisions.map(row => customerAccessImpact(row, index.get(`${row.consumerId}:${row.meterKey}`) || {}, receipts.get(row.consumerId)))
  const policies = (await client.query(`SELECT p.provider_key,p.operation_key,p.control_source,p.desired_state,p.revision,
      r.price_book_version FROM control.external_platform_operation_policies p
      JOIN control.external_platform_operation_releases r ON r.provider_key=p.provider_key AND r.operation_key=p.operation_key
        AND r.release_revision=p.release_revision WHERE p.provider_key=ANY($1::text[])`, [providers])).rows
  const policyIndex = new Map(policies.map(row => [`${row.provider_key}:${row.operation_key}`, row]))
  const policyChanges = (await client.query(`SELECT provider_key,operation_key,revision,previous_state,desired_state,reason
    FROM control.external_platform_operation_policy_events WHERE reason=$1 ORDER BY provider_key,operation_key`,
  [`Price sync batch ${id}: verified source prices; preserve state and budgets`])).rows
  const procurementReceipts = new Map(source.result.procurement.applied.map(row => [`${row.provider}:${row.operationKey}`, row]))
  const procurementIncreases = updates.flatMap(row => row.changes.filter(change => change.previousBudgetMinor != null
    && change.nextBudgetMinor > change.previousBudgetMinor).map(change => {
    const key = `${row.provider}:${row.operationKey}`, current = policyIndex.get(key), receipt = procurementReceipts.get(key)
    return { selection: key, provider: row.provider, operationKey: row.operationKey, endpointKey: change.endpointKey,
      currency: row.body.priceBook.currency, oldMinor: change.previousBudgetMinor, newMinor: change.nextBudgetMinor,
      monthlyBudgetMinor: row.body.priceBook.monthlyBudgetMinor, monthlySubsidyBudgetMinor: row.body.priceBook.monthlySubsidyBudgetMinor,
      desiredState: current?.desired_state,
      matchesMigration: Number(current?.revision) === receipt?.revision && Number(current?.price_book_version) === receipt?.priceBookVersion }
  }))
  const gatewayFailures = (await client.query(`SELECT g.provider_key,g.consumer_id,u.billing_meter_key,u.capability,
      g.response_status,g.error_code,count(*)::integer AS count,max(g.created_at) AS latest
    FROM external_platform.gateway_requests g LEFT JOIN usage_requests u ON u.id=g.usage_request_id
    WHERE g.provider_key=ANY($1::text[]) AND g.created_at >= $2 AND g.created_at <= $3
      AND (g.response_status >= 400 OR g.error_code IS NOT NULL)
    GROUP BY 1,2,3,4,5,6 ORDER BY count(*) DESC LIMIT 100`, [providers, from, now])).rows
  const preDispatchFailures = (await client.query(`SELECT u.consumer_id,u.billing_meter_key,u.capability,u.error_code,
      count(*)::integer AS count,max(u.created_at) AS latest FROM usage_requests u
    WHERE u.created_at >= $1 AND u.created_at <= $2 AND u.status='released'
      AND u.error_code='external_platform_pre_dispatch_failed'
      AND (u.billing_meter_key=ANY($3::text[]) OR u.capability=ANY($3::text[]))
      AND NOT EXISTS(SELECT 1 FROM external_platform.gateway_requests g WHERE g.usage_request_id=u.id)
    GROUP BY 1,2,3,4 ORDER BY count(*) DESC LIMIT 100`, [from, now, updates.map(row => row.operationKey)])).rows
  const newlyUnaffordable = customerImpacts.filter(row => row.oldAffordableNewUnaffordableNow)
  return { batchId: id, status: source.status, completedAt: completedAt.toISOString(), observedAt: now.toISOString(), from,
    readOnly: true, businessCalls: 0,
    customers: { checkedPrices: customerImpacts.length, newlyUnaffordableCount: newlyUnaffordable.length,
      newlyUnaffordable: newlyUnaffordable.slice(0, 100),
      currentUnaffordableCount: customerImpacts.filter(row => row.currentlyUnaffordable).length,
      driftedPrices: customerImpacts.filter(row => !row.matchesMigration).length,
      accounts: [...new Set(customerImpacts.map(row => row.consumerId))].map(consumerId => {
        const rows = customerImpacts.filter(row => row.consumerId === consumerId), row = rows[0]
        return { consumerId, name: row.consumerName, mode: row.mode, walletCurrency: row.walletCurrency,
          walletStatus: row.walletStatus, availableMinor: row.availableMinor,
          increasedPrices: rows.filter(row => row.increased).length, maximumNewQuoteMinor: Math.max(...rows.map(row => row.migratedQuotedMinor)) }
      }) },
    procurement: { increasedRecords: procurementIncreases.length,
      increases: procurementIncreases.sort((a, b) => (b.newMinor - b.oldMinor) - (a.newMinor - a.oldMinor)).slice(0, 100),
      stateChangesDuringMigration: policyChanges.filter(row => row.previous_state !== row.desired_state) },
    gatewayFailures, preDispatchFailures,
    limits: ['No paid probes. No observed errors is not proof of availability.',
      'Insufficient-credit 402 can roll back before logging. Affordability is a current-balance counterfactual, not proof of a historical failure.',
      'Pre-dispatch failures are not proof of budget exhaustion. Positive enforced requests with a valid wallet hold bypass provider monthly budgets.',
      'Procurement increases are candidates for review; full workflow/subsidy headroom and historical causality are not inferred.',
      'Rows/samples capped at 100 per group; audit uses at most 7 days since completion.'] }
}

export async function main(id = process.argv[2]) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10000,
    statement_timeout: 45000, application_name: 'price-sync-readonly-audit' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const report = await auditPriceSyncAccess(client, id)
    await client.query('COMMIT')
    return report
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
  finally { client.release(); await pool.end() }
}
if (process.argv[1] === '-' || process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(report => console.log(JSON.stringify(report, null, 2))).catch(() => {
    console.error('Read-only price access audit failed; no changes were made. Check the batch ID and database availability.')
    process.exitCode = 1
  })
}
