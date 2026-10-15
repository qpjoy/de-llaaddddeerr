import assert from 'node:assert/strict'
import test from 'node:test'
import { readCustomerPriceSyncInventory, planCustomerPriceSync, applyCustomerPriceSync, customerPriceSyncSnapshotHash } from '../../server/commercial/price-sync-customers.mjs'

const meter = 'native.example.search'
const rate = (unitPrice = '0.20', extra = {}) => ({ currency: 'CNY', unit: 'request', unitPrice,
  source: { url: 'https://supplier.example/prices', observedAt: '2026-10-14' }, ...extra })
function customer(extra = {}) {
  return { consumerId: '00000000-0000-4000-8000-000000000001', tenantId: '00000000-0000-4000-8000-000000000002',
    consumerStatus: 'active', tenantStatus: 'active',
    assignment: { planVersionId: '00000000-0000-4000-8000-000000000003', revision: 4, assignedAt: '2026-09-01T00:00:00.123456Z' },
    plan: { id: '00000000-0000-4000-8000-000000000004', key: 'original', name: 'Original plan', version: 2,
      status: 'active', versionStatus: 'published', limits: { monthlyRequests: 500, maxPageSize: 40 }, pricing: { components: [{ kind: 'existing' }] } },
    priceBook: null,
    profile: { mode: 'enforced', revision: 7, defaultCurrency: 'CNY', defaultUnitPriceMinor: 1, multiplierPpm: null },
    walletCurrencies: ['CNY'], exposureByMeter: { [meter]: { state: 'unserved', reasons: [] } }, ...extra }
}
const plan = (c = customer(), rates = { [meter]: rate() }) => planCustomerPriceSync({ version: 1, consumers: [c] }, { ratesByMeter: rates })
function book(amount = 1) {
  return { id: 'book-id', key: 'book', currency: 'CNY', defaultMultiplierPpm: 1_000_000,
    entries: [{ meterKey: meter, billingUnit: 'request', unitPriceMinor: amount },
      { meterKey: 'native.other.read', billingUnit: 'request', unitPriceMinor: 35 }] }
}

test('one-minor calibration overlays only the exact meter without changing fallback, plan limits or input', () => {
  const c = customer(), before = structuredClone(c)
  const result = plan(c)
  assert.equal(result.changes.length, 1)
  assert.deepEqual(result.changes[0].entries, [{ meterKey: meter, billingUnit: 'request', unitPriceMinor: 20 }])
  assert.equal(result.decisions[0].reason, 'authorized_one_minor_calibration')
  assert.deepEqual(c, before)
  assert.equal(c.profile.defaultUnitPriceMinor, 1)
})

test('served and unknown high effective prices stay while an unserved high price is corrected', () => {
  for (const state of ['served', 'unknown']) {
    const result = plan(customer({ priceBook: book(50), exposureByMeter: { [meter]: { state } } }))
    assert.equal(result.changes.length, 0)
    assert.equal(result.decisions[0].reason, 'served_or_unknown_high_price_preserved')
  }
  const result = plan(customer({ priceBook: book(50) }))
  assert.equal(result.changes[0].entries.find(row => row.meterKey === meter).unitPriceMinor, 20)
  assert.equal(result.changes[0].entries.find(row => row.meterKey === 'native.other.read').unitPriceMinor, 35)
})

test('the protected price uses actual multiplier quote, including a one-minor entry with a high multiplier', () => {
  const c = customer({ priceBook: book(1), profile: { ...customer().profile, multiplierPpm: 30_000_000 },
    exposureByMeter: { [meter]: { state: 'served' } } })
  const result = plan(c)
  assert.equal(result.decisions[0].currentQuotedMinor, 30)
  assert.equal(result.decisions[0].reason, 'served_or_unknown_high_price_preserved')
  assert.equal(result.changes.length, 0)
})

test('served discounted high base prices stay protected even when their current quote is below the supplier rate', () => {
  for (const state of ['served', 'unknown']) {
    const c = customer({ priceBook: book(100), profile: { ...customer().profile, multiplierPpm: 500_000 },
      exposureByMeter: { [meter]: { state } } })
    const result = plan(c, { [meter]: rate('0.75') })
    assert.equal(result.decisions[0].currentMinor, 100)
    assert.equal(result.decisions[0].currentQuotedMinor, 50)
    assert.equal(result.decisions[0].targetQuotedMinor, 38)
    assert.equal(result.decisions[0].reason, 'served_or_unknown_high_price_preserved')
    assert.equal(result.changes.length, 0)
  }
})

test('explicit zero, free fallback and zero-multiplier contracts are preserved', () => {
  for (const c of [customer({ priceBook: book(0) }), customer({ profile: { ...customer().profile, defaultUnitPriceMinor: 0 } }),
    customer({ priceBook: book(1), profile: { ...customer().profile, multiplierPpm: 0 } })]) {
    const result = plan(c)
    assert.equal(result.decisions[0].reason, 'explicit_free_preserved')
    assert.equal(result.changes.length, 0)
  }
})

test('cross currency, unsupported minor precision, billing units and conflicting shared meters stay blocked', () => {
  for (const [candidate, reason] of [
    [rate('0.20', { currency: 'USD' }), 'customer_currency_conversion_required'],
    [rate('0.005'), 'subminor_customer_price_unsupported'],
    [rate('0.20', { unit: 'item' }), 'billing_unit_mismatch'],
    [[rate('0.20'), rate('0.30')], 'shared_meter_price_conflict'],
    [rate('0.20', { source: null }), 'price_evidence_missing'],
    [rate('0.20', { currency: 'JPY' }), 'currency_minor_unit_unverified'],
    [rate(0.2), 'price_precision_unverified'],
  ]) {
    const result = plan(customer(), { [meter]: candidate })
    assert.equal(result.changes.length, 0, reason)
    assert.equal(result.blocked[0].reason, reason)
  }
  assert.equal(plan(customer(), { [meter]: [rate('0.200000'), rate('0.20')] }).changes.length, 1)
})

test('fallback-to-entry preview discloses the existing contract multiplier without changing it', () => {
  const c = customer({ profile: { ...customer().profile, multiplierPpm: 500_000 } })
  const result = plan(c)
  assert.equal(result.decisions[0].currentQuotedMinor, 1)
  assert.equal(result.decisions[0].targetQuotedMinor, 10)
  assert.equal(c.profile.multiplierPpm, 500_000)
})

test('ongoing traffic does not invalidate a price preview unless its exposure classification changes', () => {
  const before = customer({ exposureByMeter: { [meter]: { state: 'served', reasons: ['non_admin_usage_or_charge'], usage: { committed: 1 } } } })
  const after = structuredClone(before)
  after.exposureByMeter[meter].usage.committed = 200
  assert.equal(customerPriceSyncSnapshotHash(before), customerPriceSyncSnapshotHash(after))
  after.exposureByMeter[meter].state = 'unknown'
  assert.notEqual(customerPriceSyncSnapshotHash(before), customerPriceSyncSnapshotHash(after))
})

test('mixed-currency plan/fallback, wrong wallet and missing exposure never silently allow high-price replacement', () => {
  const mixed = customer({ priceBook: { ...book(), currency: 'USD', entries: [] } })
  assert.equal(plan(mixed).blocked[0].reason, 'customer_currency_conversion_required')
  assert.equal(plan(customer({ walletCurrencies: ['USD'] })).blocked[0].reason, 'wallet_currency_mismatch')
  assert.equal(plan(customer({ priceBook: book(50), exposureByMeter: {} })).decisions[0].reason, 'served_or_unknown_high_price_preserved')
})

// The fake exercises transaction sequencing and all optimistic checks. The
// companion PostgreSQL test validates real triggers, immutable rows and rollback.
function database() {
  const c = customer()
  const row = { consumer_id: c.consumerId, tenant_id: c.tenantId, consumer_status: 'active', tenant_status: 'active',
    plan_version_id: c.assignment.planVersionId, assignment_revision: 4, assigned_at: c.assignment.assignedAt,
    plan_id: c.plan.id, plan_key: c.plan.key, plan_name: c.plan.name, plan_status: 'active',
    plan_version: 2, version_status: 'published', limits: c.plan.limits, pricing: c.plan.pricing,
    book_id: null, entries: [], profile: c.profile, wallet_currencies: ['CNY'], other_live_keys: 0, admin_keys: 0 }
  let prior = null
  const queries = []
  const client = { row, queries, isolation: 'serializable', inTransaction: true, async query(sql, params = []) {
    queries.push({ sql, params })
    if (sql === 'SHOW transaction_isolation') return { rows: [{ transaction_isolation: this.isolation }] }
    if (sql.startsWith('SAVEPOINT') && !this.inTransaction) throw Object.assign(new Error('no transaction'), { code: '25P01' })
    if (sql.includes('FROM consumers c JOIN tenants')) return { rows: [row] }
    if (sql.includes('FROM usage_requests u')) return { rows: this.usage || [] }
    if (sql.includes('FROM billing.customer_charges WHERE')) return { rows: [] }
    if (sql.includes('SELECT v.id,v.pricing,a.plan_version_id')) return { rows: prior ? [{ ...prior, plan_version_id: row.plan_version_id }] : [] }
    if (sql.startsWith('INSERT INTO plan_versions')) prior = { id: params[0], pricing: params[3] }
    if (sql.startsWith('UPDATE consumer_plan_assignments')) {
      assert.equal(params[5], '2026-09-01T00:00:00.123456Z')
      assert.equal(row.assignment_revision, params[3])
      assert.equal(row.plan_version_id, params[4])
      row.plan_version_id = params[1]; row.assignment_revision++
      return { rowCount: 1, rows: [{ revision: row.assignment_revision, assigned_at: row.assigned_at }] }
    }
    return { rows: [], rowCount: 1 }
  } }
  return client
}

test('inventory separates real usage evidence and unknown live-customer identity without reading secrets or request bodies', async () => {
  const db = database()
  db.row.other_live_keys = 1
  let inventory = await readCustomerPriceSyncInventory(db, { meterKeys: [meter] })
  assert.equal(inventory.consumers[0].exposureByMeter[meter].state, 'unknown')
  db.usage = [{ consumer_id: db.row.consumer_id, meter_key: meter, committed: 1, unresolved: 0, released: 0, external_evidence: 1 }]
  inventory = await readCustomerPriceSyncInventory(db, { meterKeys: [meter] })
  assert.equal(inventory.consumers[0].exposureByMeter[meter].state, 'served')
  assert.equal(inventory.consumers[0].assignment.assignedAt, '2026-09-01T00:00:00.123456Z')
  assert.ok(db.queries.every(({ sql }) => !/key_digest|key_prefix|response_body|request_params/u.test(sql)))
})

test('writer copies an immutable version, retains assignment epoch and limits, and repeats without writes', async () => {
  const db = database()
  const inventory = await readCustomerPriceSyncInventory(db, { meterKeys: [meter] })
  const change = planCustomerPriceSync(inventory, { ratesByMeter: { [meter]: rate() } }).changes[0]
  const first = await applyCustomerPriceSync(db, change, { batchId: 'verified-20261014' })
  assert.equal(first.status, 'applied')
  assert.equal(first.revision, 5)
  const insertedPlan = db.queries.find(({ sql }) => sql.startsWith('INSERT INTO plan_versions'))
  assert.deepEqual(insertedPlan.params[2], inventory.consumers[0].plan.limits)
  assert.deepEqual(insertedPlan.params[3].components, inventory.consumers[0].plan.pricing.components)
  assert.doesNotMatch(JSON.stringify(insertedPlan.params[3]), /supplier\.example|observedAt|sources|ratesByMeter/u)
  const update = db.queries.find(({ sql }) => sql.startsWith('UPDATE consumer_plan_assignments'))
  assert.doesNotMatch(update.sql.split('WHERE')[0], /assigned_at\s*=/u)
  assert.ok(db.queries.every(({ sql }) => !/^(UPDATE|INSERT INTO|DELETE FROM) (api_keys|platform_grants|hub_commerce|billing\.tenant_billing_profiles|billing\.customer_charges)/u.test(sql)))
  const writesBefore = db.queries.filter(({ sql }) => /^(INSERT|UPDATE)/u.test(sql)).length
  const replay = await applyCustomerPriceSync(db, change, { batchId: 'verified-20261014' })
  assert.equal(replay.status, 'already_applied')
  assert.equal(db.queries.filter(({ sql }) => /^(INSERT|UPDATE)/u.test(sql)).length, writesBefore)
  await assert.rejects(applyCustomerPriceSync(db, { ...change, entries: [] }, { batchId: 'verified-20261014' }), { code: 'customer_price_sync_batch_conflict' })
})

test('writer rejects stale exposure, tampered prices, default isolation and autocommit before any data write', async () => {
  for (const scenario of ['exposure', 'price', 'isolation', 'autocommit']) {
    const db = database()
    const inventory = await readCustomerPriceSyncInventory(db, { meterKeys: [meter] })
    const change = planCustomerPriceSync(inventory, { ratesByMeter: { [meter]: rate() } }).changes[0]
    if (scenario === 'exposure') db.row.other_live_keys = 1
    if (scenario === 'price') change.entries[0].unitPriceMinor = 999
    if (scenario === 'isolation') db.isolation = 'read committed'
    if (scenario === 'autocommit') db.inTransaction = false
    await assert.rejects(applyCustomerPriceSync(db, change, { batchId: 'stale-check' }))
    assert.equal(db.queries.filter(({ sql }) => /^(INSERT|UPDATE)/u.test(sql)).length, 0, scenario)
  }
})
