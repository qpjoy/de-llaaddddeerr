import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

// Standalone, selected-Key customer-price read. Never call billing functions:
// their reservation path takes locks and is not a diagnostic quote endpoint.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[0-9a-f]{12}$/i
const METERS = new Set(['raw', 'crawl', 'user-info', 'ecommerce.products.search'])
const TRIGGER_PREFIX = 'CREATE TRIGGER usage_requests_reserve_customer_charge AFTER INSERT ON public.usage_requests FOR EACH ROW '
const TRIGGER_SUFFIX = 'EXECUTE FUNCTION billing.reserve_customer_charge()'
// Exact PostgreSQL deparsing of the reviewed 056, 129 and 130 triggers. All four
// incident meters pass these predicates. An unfamiliar trigger is not a quote.
const TRIGGER_CONTRACTS = new Map([
  [`${TRIGGER_PREFIX}${TRIGGER_SUFFIX}`, 'all_meters_056'],
  [`${TRIGGER_PREFIX}WHEN ((new.billing_meter_key IS DISTINCT FROM 'ip.risk.subscription.v2'::text)) ${TRIGGER_SUFFIX}`, 'subscription_exclusion_129'],
  [`${TRIGGER_PREFIX}WHEN (((new.billing_meter_key IS NULL) OR (new.billing_meter_key <> ALL (ARRAY['ip.risk.subscription.v2'::text, 'ip.risk.subscription.product'::text])))) ${TRIGGER_SUFFIX}`, 'subscription_exclusions_130'],
])
export const FUNCTION_HASHES = Object.freeze({
  reserve056: 'ad3181fa193b6ed15a302a576bdb88e3be6c01a985301bb4ab926a3261b4fc93',
  reserve080: 'b16216cb668204306923156d7a89ee42d669a5d8b6ce92bfe96d64bdc46ece4c',
  reserve105: '142e5676457342feba7e0437283ce093aee1e6959bd15dea21f5e27999ad256d',
  price105: '00452f550a6a0ff875ad45db40fad11df1ac885d3005c6b7c29ac1ae8879e8c2',
})
const sha = text => createHash('sha256').update(text).digest('hex')
const choice = (value, choices) => value == null ? null : choices.includes(value) ? value : 'other'
const uuid = value => typeof value === 'string' && UUID.test(value) ? value : null
const minor = value => value != null && /^(0|[1-9][0-9]*)$/.test(String(value))
  && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER) ? String(value) : null
const currency = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null

export function customerPriceArguments(args) {
  const [keyId, ...meters] = args
  if (!UUID.test(keyId || '') || !meters.length || meters.length > 4
    || meters.some(value => !METERS.has(value)) || new Set(meters).size !== meters.length) {
    throw new Error('expected_key_uuid_and_1_to_4_distinct_incident_meter_keys')
  }
  return { keyId: keyId.toLowerCase(), meters }
}

export function billingGeneration(functions) {
  const reserve = functions.find(row => row.proname === 'reserve_customer_charge')
  const price = functions.find(row => row.proname === 'customer_price_for_usage')
  const reserveSha256 = typeof reserve?.prosrc === 'string' ? sha(reserve.prosrc) : null
  const priceSha256 = typeof price?.prosrc === 'string' ? sha(price.prosrc) : null
  const generation = reserveSha256 === FUNCTION_HASHES.reserve105 && priceSha256 === FUNCTION_HASHES.price105
    ? 'tenant_default_105' : reserveSha256 === FUNCTION_HASHES.reserve080 ? 'unlisted_free_080'
      : reserveSha256 === FUNCTION_HASHES.reserve056 ? 'missing_entry_errors_056' : 'unverified'
  return { generation, reserveSha256, priceSha256 }
}

export function explainCustomerMeter(row, entry, generation) {
  const base = { entryPresent: Boolean(entry), entryId: uuid(entry?.id),
    entryUnitPriceMinor: minor(entry?.unit_price_minor),
    billingUnit: choice(entry?.billing_unit, ['request']), priceSource: null,
    currency: null, unitPriceMinor: null, multiplierPpm: null, quotedMinor: null }
  const result = (state, reason) => ({ ...base, state, reason })
  if (!['tenant_default_105', 'unlisted_free_080', 'missing_entry_errors_056'].includes(generation)) return result('unverified', 'deployed_billing_function_not_recognized')
  if (!row.profile_tenant_id || row.mode === 'disabled') return result('unbilled', 'profile_missing_or_disabled')
  if (!['enforced', 'shadow'].includes(row.mode)) return result('unverified', 'invalid_or_missing_price_metadata')
  if (!row.plan_version_id) return result('unbilled', 'plan_assignment_missing')
  const usableBook = row.book_id && ['published', 'retired'].includes(row.book_status)
  if (row.assigned_book_id && !usableBook) return result(row.mode === 'enforced' ? 'blocked' : 'unbilled', 'assigned_customer_price_book_unavailable')
  if (generation !== 'tenant_default_105' && !row.assigned_book_id) return result('unbilled', 'legacy_plan_without_price_book')
  if (!entry && generation !== 'tenant_default_105') {
    return result(generation === 'missing_entry_errors_056' && row.mode === 'enforced' ? 'blocked' : 'unbilled',
      generation === 'missing_entry_errors_056' ? 'legacy_missing_meter_entry' : 'unlisted_meter_free')
  }
  base.priceSource = entry ? 'plan_entry' : 'tenant_default'
  if (!entry) base.billingUnit = 'request'
  base.currency = currency(entry ? row.book_currency : row.default_currency)
  base.unitPriceMinor = minor(entry ? entry.unit_price_minor : row.default_unit_price_minor)
  base.multiplierPpm = minor(entry ? row.multiplier_ppm ?? row.default_multiplier_ppm : 1000000)
  if (base.unitPriceMinor == null || base.multiplierPpm == null || !base.currency || base.billingUnit !== 'request') return result('unverified', 'invalid_or_missing_price_metadata')
  if (!entry && base.unitPriceMinor === '0') {
    base.quotedMinor = '0'
    return result('unbilled', 'zero_tenant_default')
  }
  const quoted = (BigInt(base.unitPriceMinor) * BigInt(base.multiplierPpm) + 999999n) / 1000000n
  if (quoted > BigInt(Number.MAX_SAFE_INTEGER)) return result('blocked', 'quote_out_of_safe_integer_range')
  base.quotedMinor = quoted.toString()
  return result('priced', row.mode === 'shadow' ? 'shadow_quote_not_wallet_charge' : 'customer_price_resolved')
}

export async function diagnoseCustomerPrice(pool, keyId, meters) {
  const args = customerPriceArguments([keyId, ...meters])
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout='5s'")
    await client.query("SET LOCAL lock_timeout='1s'")
    const { rows: functions } = await client.query(`/* customer-price:functions */
      SELECT proname,prosrc FROM pg_catalog.pg_proc WHERE oid IN (
        to_regprocedure('billing.reserve_customer_charge()'),
        to_regprocedure('billing.customer_price_for_usage(uuid,uuid,text)'))`)
    const runtime = billingGeneration(functions)
    const { rows: triggers } = await client.query(`/* customer-price:trigger */
      SELECT t.tgenabled,pg_get_triggerdef(t.oid,false) AS definition
      FROM pg_catalog.pg_trigger t WHERE t.tgrelid=to_regclass('public.usage_requests')
        AND t.tgname='usage_requests_reserve_customer_charge'
        AND t.tgfoid=to_regprocedure('billing.reserve_customer_charge()') AND NOT t.tgisinternal`)
    runtime.reservationTrigger = choice(triggers[0]?.tgenabled, ['O', 'A', 'R', 'D'])
    runtime.reservationTriggerContract = TRIGGER_CONTRACTS.get(triggers[0]?.definition) || 'unverified'
    const { rows: [row] } = await client.query(`/* customer-price:binding */
      SELECT k.id AS key_id,k.status AS key_status,k.tenant_id,k.consumer_id,
        c.status AS consumer_status,c.tenant_id=k.tenant_id AS owner_matches,
        a.plan_version_id,a.revision AS assignment_revision,a.assigned_at,
        v.status AS plan_status,v.customer_price_book_id AS assigned_book_id,
        b.id AS book_id,b.status AS book_status,b.version AS book_version,b.currency AS book_currency,b.default_multiplier_ppm,
        bp.tenant_id AS profile_tenant_id,bp.mode,bp.revision AS profile_revision,bp.multiplier_ppm,
        to_jsonb(bp)->>'default_unit_price_minor' AS default_unit_price_minor,
        to_jsonb(bp)->>'default_currency' AS default_currency,
        (SELECT count(*)::integer FROM api_keys sibling WHERE sibling.consumer_id=k.consumer_id) AS sibling_key_count
      FROM api_keys k JOIN consumers c ON c.id=k.consumer_id
      LEFT JOIN consumer_plan_assignments a ON a.consumer_id=c.id
      LEFT JOIN plan_versions v ON v.id=a.plan_version_id
      LEFT JOIN billing.customer_price_books b ON b.id=v.customer_price_book_id
      LEFT JOIN billing.tenant_billing_profiles bp ON bp.tenant_id=k.tenant_id WHERE k.id=$1`, [args.keyId])
    if (!row) return { diagnosticRevision: 'customer-price.v1', keyId: args.keyId, state: 'key_not_found', readOnly: true, runtime }
    const { rows: entries } = await client.query(`/* customer-price:entries */
      SELECT id,meter_key,billing_unit,unit_price_minor::text FROM billing.customer_price_entries
      WHERE price_book_id=$1 AND meter_key=ANY($2::text[]) ORDER BY meter_key LIMIT 4`, [row.assigned_book_id, args.meters])
    const verifiedGeneration = ['O', 'A'].includes(runtime.reservationTrigger)
      && runtime.reservationTriggerContract !== 'unverified' && row.owner_matches === true
      ? runtime.generation : 'unverified'
    return { diagnosticRevision: 'customer-price.v1', readOnly: true, businessCalls: 0,
      key: { id: uuid(row.key_id), status: choice(row.key_status, ['active', 'revoked']),
        tenantId: uuid(row.tenant_id), consumerId: uuid(row.consumer_id),
        consumerStatus: choice(row.consumer_status, ['active', 'suspended', 'disabled']), ownerMatches: row.owner_matches === true,
        siblingKeyCount: row.sibling_key_count }, runtime,
      assignment: { planVersionId: uuid(row.plan_version_id), revision: row.assignment_revision,
        assignedAt: row.assigned_at, planStatus: choice(row.plan_status, ['draft', 'published', 'retired']),
        assignedBookId: uuid(row.assigned_book_id), bookFound: Boolean(row.book_id),
        bookStatus: choice(row.book_status, ['draft', 'published', 'retired']), bookVersion: row.book_version },
      profile: { mode: choice(row.mode, ['disabled', 'shadow', 'enforced']), revision: row.profile_revision,
        multiplierPpm: minor(row.multiplier_ppm), defaultUnitPriceMinor: minor(row.default_unit_price_minor),
        defaultCurrency: currency(row.default_currency) },
      meters: args.meters.map(meterKey => ({ meterKey, ...explainCustomerMeter(row,
        entries.find(entry => entry.meter_key === meterKey), verifiedGeneration) })),
      limitations: ['Current configuration only; historical request ownership was not queried and a current quote does not prove the cause of a historical 503.',
        'Selected meter keys are operator input, not proof of endpoint mapping or authorization.',
        'A resolved price is not a readiness check: grants, plan validity, wallet and procurement admission remain separate.',
        'Consumer plan pricing applies to all sibling Keys; no price, assignment, quota period, grant or wallet was changed.'] }
  } catch { throw new Error('customer_price_diagnostic_failed') }
  finally {
    if (client) {
      try { await client.query('ROLLBACK') }
      catch { client.release(true); throw new Error('customer_price_diagnostic_failed') }
      client.release()
    }
  }
}

if (process.argv[1] === '-' || (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  let pool
  try {
    const { keyId, meters } = customerPriceArguments(process.argv.slice(2))
    if (!process.env.DATABASE_URL) throw new Error('database_url_required')
    const { default: pg } = await import('pg')
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, query_timeout: 6000 })
    console.log(JSON.stringify(await diagnoseCustomerPrice(pool, keyId, meters)))
  } catch (error) {
    console.error(JSON.stringify({ error: ['expected_key_uuid_and_1_to_4_distinct_incident_meter_keys', 'database_url_required'].includes(error.message)
      ? error.message : 'customer_price_diagnostic_failed' }))
    process.exitCode = 1
  } finally { await pool?.end() }
}
