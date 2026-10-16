import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { customerPriceArguments, billingGeneration, explainCustomerMeter, diagnoseCustomerPrice,
  FUNCTION_HASHES } from '../../server/ops/diagnose-customer-price.mjs'

const keyId = 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83'
const bookId = '2ea3381e-a43b-456a-a1f3-4b6ab4b80f71'
const planId = '64a80c90-7edc-44bd-a9b7-adac6f9c9cbf'
const tenantId = '9533a1df-6c01-49b5-a253-8251562df289'
const entryId = '614f30a2-9d20-4904-a16b-18ddd3a7bd81'
const row = { key_id: keyId, key_status: 'active', tenant_id: tenantId,
  consumer_id: '79668daa-987b-411e-a424-4a0b57789769', consumer_status: 'active', owner_matches: true,
  plan_version_id: planId, assignment_revision: 4, assigned_at: '2026-10-10T01:00:00.000Z',
  plan_status: 'published', assigned_book_id: bookId, book_id: bookId, book_status: 'published',
  book_version: 3, book_currency: 'CNY', default_multiplier_ppm: '1500000',
  profile_tenant_id: tenantId, mode: 'enforced', profile_revision: 2, multiplier_ppm: null,
  default_unit_price_minor: '1', default_currency: 'CNY', sibling_key_count: 2 }
const entry = { id: entryId, meter_key: 'raw', billing_unit: 'request', unit_price_minor: '3' }
const meters = ['raw', 'crawl', 'user-info', 'ecommerce.products.search']
const files = {
  '056': '056_commercial_billing_ledger.sql', '080': '080_unpriced_customer_operations.sql',
  '105': '105_tenant_default_request_price.sql',
}
async function body(version, name) {
  const source = await readFile(new URL(`../../migrations/${files[version]}`, import.meta.url), 'utf8')
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION billing.${name}(`)
  assert.ok(start >= 0)
  const bodyStart = source.indexOf('$function$', start) + '$function$'.length
  return source.slice(bodyStart, source.indexOf('$function$;', bodyStart))
}
async function functions(version = '105') {
  const rows = [{ proname: 'reserve_customer_charge', prosrc: await body(version, 'reserve_customer_charge') }]
  if (version === '105') rows.push({ proname: 'customer_price_for_usage', prosrc: await body(version, 'customer_price_for_usage') })
  return rows
}
const triggerDefinition = 'CREATE TRIGGER usage_requests_reserve_customer_charge AFTER INSERT ON public.usage_requests FOR EACH ROW EXECUTE FUNCTION billing.reserve_customer_charge()'
function poolFixture({ binding = row, entries = [entry], functionRows, trigger = 'O', definition = triggerDefinition, failAt } = {}) {
  const queries = [], releases = []
  return { queries, releases, pool: { async connect() { return {
    async query(sql, params) {
      queries.push({ sql, params })
      if (failAt && sql.includes(failAt)) throw new Error('secret-database-url-private-failure')
      if (sql.includes('customer-price:functions')) return { rows: functionRows }
      if (sql.includes('customer-price:trigger')) return { rows: [{ tgenabled: trigger, definition }] }
      if (sql.includes('customer-price:binding')) return { rows: binding ? [binding] : [] }
      if (sql.includes('customer-price:entries')) return { rows: entries }
      return { rows: [] }
    }, release(discard) { releases.push(discard) },
  } } } }
}

test('known production function hashes match exact migration bodies; altered implementations are unverified', async () => {
  for (const [version, generation] of [['056', 'missing_entry_errors_056'], ['080', 'unlisted_free_080'], ['105', 'tenant_default_105']]) {
    const rows = await functions(version)
    assert.equal(createHash('sha256').update(rows[0].prosrc).digest('hex'), FUNCTION_HASHES[`reserve${version}`])
    assert.equal(billingGeneration(rows).generation, generation)
    assert.equal(billingGeneration([{ ...rows[0], prosrc: `${rows[0].prosrc}\n` }, ...rows.slice(1)]).generation, 'unverified')
  }
  const rows = await functions()
  assert.equal(createHash('sha256').update(rows[1].prosrc).digest('hex'), FUNCTION_HASHES.price105)
  assert.equal(billingGeneration(rows.slice(0, 1)).generation, 'unverified')
})

test('same absent meter explains old 056 failure, 080 unbilled, and 105 tenant default distinctly', () => {
  assert.equal(explainCustomerMeter(row, null, 'missing_entry_errors_056').state, 'blocked')
  assert.equal(explainCustomerMeter(row, null, 'missing_entry_errors_056').reason, 'legacy_missing_meter_entry')
  assert.equal(explainCustomerMeter(row, null, 'unlisted_free_080').state, 'unbilled')
  const current = explainCustomerMeter(row, null, 'tenant_default_105')
  assert.equal(current.state, 'priced')
  assert.equal(current.priceSource, 'tenant_default')
  assert.equal(current.billingUnit, 'request')
  assert.equal(current.quotedMinor, '1')
  assert.equal(current.multiplierPpm, '1000000')
  assert.equal(explainCustomerMeter({ ...row, mode: 'shadow' }, null, 'missing_entry_errors_056').state, 'unbilled')
})

test('explicit entries including zero win; integer rounding and shadow pricing preserve billing semantics', () => {
  for (const generation of ['missing_entry_errors_056', 'unlisted_free_080', 'tenant_default_105']) {
    assert.equal(explainCustomerMeter(row, entry, generation).quotedMinor, '5')
    assert.equal(explainCustomerMeter({ ...row, multiplier_ppm: '1100000' }, entry, generation).quotedMinor, '4')
    const free = explainCustomerMeter(row, { ...entry, unit_price_minor: '0' }, generation)
    assert.equal(free.priceSource, 'plan_entry'); assert.equal(free.state, 'priced'); assert.equal(free.quotedMinor, '0')
  }
  assert.equal(explainCustomerMeter({ ...row, mode: 'shadow' }, entry, 'tenant_default_105').reason, 'shadow_quote_not_wallet_charge')
  assert.equal(explainCustomerMeter({ ...row, default_unit_price_minor: '0' }, null, 'tenant_default_105').state, 'unbilled')
  assert.equal(explainCustomerMeter(row, { ...entry, unit_price_minor: '9007199254740991' }, 'tenant_default_105').reason, 'quote_out_of_safe_integer_range')
})

test('unavailable assigned book remains blocked, retired book usable, and no-plan/profile states never imply readiness', () => {
  for (const generation of ['missing_entry_errors_056', 'unlisted_free_080', 'tenant_default_105']) {
    assert.equal(explainCustomerMeter({ ...row, book_status: 'draft' }, entry, generation).state, 'blocked')
    assert.equal(explainCustomerMeter({ ...row, book_id: null }, null, generation).state, 'blocked')
    assert.equal(explainCustomerMeter({ ...row, book_status: 'retired' }, entry, generation).state, 'priced')
    assert.equal(explainCustomerMeter({ ...row, plan_version_id: null }, null, generation).state, 'unbilled')
    assert.equal(explainCustomerMeter({ ...row, profile_tenant_id: null }, null, generation).state, 'unbilled')
  }
  assert.equal(explainCustomerMeter({ ...row, assigned_book_id: null, book_id: null }, null, 'tenant_default_105').quotedMinor, '1')
  assert.equal(explainCustomerMeter({ ...row, assigned_book_id: null, book_id: null }, null, 'unlisted_free_080').state, 'unbilled')
  assert.equal(explainCustomerMeter(row, entry, 'custom').state, 'unverified')
})

test('input is a selected Key record UUID and bounded exact meter names, never a credential or SQL', async () => {
  assert.deepEqual(customerPriceArguments([keyId, ...meters]), { keyId, meters })
  for (const args of [[], ['secret-key', 'raw'], [keyId], [keyId, 'raw', 'raw'], [keyId, 'raw;SELECT'],
    [keyId, 'ip.risk.subscription.v2'], [keyId, 'ip.risk.subscription.product'], [keyId, 'unreviewed.meter'],
    [keyId, ...meters, 'extra']]) {
    assert.throws(() => customerPriceArguments(args), /expected_key_uuid/)
  }
  await assert.rejects(diagnoseCustomerPrice({ connect() { throw new Error('must not connect') } }, 'secret-key', ['raw']), /expected_key_uuid/)
})

test('selected binding and entries use fixed parameterized READ ONLY queries, expose no secrets and do not call billing routines', async () => {
  const f = poolFixture({ functionRows: await functions(), binding: { ...row, key_digest: 'secret-digest', name: 'private-name' } })
  const report = await diagnoseCustomerPrice(f.pool, keyId, meters)
  assert.equal(report.businessCalls, 0); assert.equal(report.readOnly, true)
  assert.equal(report.runtime.generation, 'tenant_default_105')
  assert.equal(report.key.siblingKeyCount, 2)
  assert.deepEqual(report.meters.map(item => item.quotedMinor), ['5', '1', '1', '1'])
  assert.equal(report.assignment.assignedAt, row.assigned_at)
  assert.equal(f.queries[0].sql, 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(f.queries.at(-1).sql, 'ROLLBACK')
  assert.deepEqual(f.queries.find(query => query.sql.includes('customer-price:binding')).params, [keyId])
  assert.deepEqual(f.queries.find(query => query.sql.includes('customer-price:entries')).params, [bookId, meters])
  for (const { sql } of f.queries) assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|COMMIT)\b|FOR (UPDATE|SHARE)|SELECT \* FROM billing\./i)
  const json = JSON.stringify(report)
  assert.doesNotMatch(json, /secret-digest|private-name|key_digest|prosrc|CREATE OR REPLACE/)
  assert.ok(report.limitations.some(text => text.includes('historical request ownership was not queried')))
  assert.deepEqual(f.releases, [undefined])
})

test('unknown function, disabled reservation trigger, or mismatched owner cannot yield a verified quote', async () => {
  const functionRows = await functions()
  for (const options of [{ functionRows: [] }, { functionRows, trigger: 'D' },
    { functionRows, definition: triggerDefinition.replace('EXECUTE FUNCTION', 'WHEN (false) EXECUTE FUNCTION') },
    { functionRows, binding: { ...row, owner_matches: false } }]) {
    const f = poolFixture(options)
    const report = await diagnoseCustomerPrice(f.pool, keyId, meters)
    assert.ok(report.meters.every(item => item.state === 'unverified' && item.quotedMinor === null))
  }
})

test('absent exact key does not fall back to any key or read entries', async () => {
  const f = poolFixture({ functionRows: await functions(), binding: null })
  assert.equal((await diagnoseCustomerPrice(f.pool, keyId, meters)).state, 'key_not_found')
  assert.equal(f.queries.some(query => query.sql.includes('customer-price:entries')), false)
  assert.equal(f.queries.at(-1).sql, 'ROLLBACK')
})

test('connection and query failures are sanitized, rollback always occurs, and failed rollback discards connection', async () => {
  for (const failAt of ['customer-price:binding', 'ROLLBACK']) {
    const f = poolFixture({ functionRows: await functions(), failAt })
    await assert.rejects(diagnoseCustomerPrice(f.pool, keyId, meters), { message: 'customer_price_diagnostic_failed' })
    assert.equal(f.queries.at(-1).sql, 'ROLLBACK')
    assert.deepEqual(f.releases, [failAt === 'ROLLBACK' ? true : undefined])
  }
  await assert.rejects(diagnoseCustomerPrice({ async connect() { throw new Error('private connection URI') } }, keyId, meters),
    { message: 'customer_price_diagnostic_failed' })
})

test('actual PostgreSQL reads resolve exact Key binding across 056/080/105 without modifying stored configuration',
  { skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE }, async t => {
    const { PGlite } = await import(pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE).href)
    const db = new PGlite(); t.after(() => db.close())
    await db.exec(`CREATE SCHEMA billing;
      CREATE TABLE api_keys(id uuid PRIMARY KEY,status text,tenant_id uuid,consumer_id uuid);
      CREATE TABLE consumers(id uuid PRIMARY KEY,status text,tenant_id uuid);
      CREATE TABLE consumer_plan_assignments(consumer_id uuid PRIMARY KEY,plan_version_id uuid,revision int,assigned_at timestamptz);
      CREATE TABLE plan_versions(id uuid PRIMARY KEY,status text,customer_price_book_id uuid);
      CREATE TABLE billing.customer_price_books(id uuid PRIMARY KEY,status text,version int,currency char(3),default_multiplier_ppm bigint);
      CREATE TABLE billing.tenant_billing_profiles(tenant_id uuid PRIMARY KEY,mode text,revision int,multiplier_ppm bigint);
      CREATE TABLE billing.customer_price_entries(id uuid PRIMARY KEY,price_book_id uuid,meter_key text,billing_unit text,unit_price_minor bigint);
      CREATE TABLE usage_requests(id uuid PRIMARY KEY,billing_meter_key text);`)
    await db.query('INSERT INTO api_keys VALUES($1,$2,$3,$4)', [keyId, 'active', tenantId, row.consumer_id])
    await db.query('INSERT INTO consumers VALUES($1,$2,$3)', [row.consumer_id, 'active', tenantId])
    await db.query('INSERT INTO consumer_plan_assignments VALUES($1,$2,$3,$4)', [row.consumer_id, planId, 4, row.assigned_at])
    await db.query('INSERT INTO plan_versions VALUES($1,$2,$3)', [planId, 'published', bookId])
    await db.query('INSERT INTO billing.customer_price_books VALUES($1,$2,$3,$4,$5)', [bookId, 'published', 3, 'CNY', 1500000])
    await db.query('INSERT INTO billing.tenant_billing_profiles VALUES($1,$2,$3,$4)', [tenantId, 'enforced', 2, null])
    await db.query('INSERT INTO billing.customer_price_entries VALUES($1,$2,$3,$4,$5)', [entryId, bookId, 'raw', 'request', 3])
    const installReserve = async version => db.exec(`CREATE OR REPLACE FUNCTION billing.reserve_customer_charge()
      RETURNS trigger LANGUAGE plpgsql AS $function$${await body(version, 'reserve_customer_charge')}$function$;`)
    await installReserve('056')
    await db.exec('CREATE TRIGGER usage_requests_reserve_customer_charge AFTER INSERT ON usage_requests FOR EACH ROW EXECUTE FUNCTION billing.reserve_customer_charge()')
    let released = 0
    const pool = { async connect() { return { query: (...args) => db.query(...args), release() { released++ } } } }
    const tables = ['api_keys', 'consumers', 'consumer_plan_assignments', 'plan_versions',
      'billing.customer_price_books', 'billing.customer_price_entries', 'usage_requests']
    const snapshot = async () => Promise.all(tables.map(async name => (await db.query(`SELECT * FROM ${name}`)).rows))
    const before = await snapshot()
    const old = await diagnoseCustomerPrice(pool, keyId, meters)
    assert.equal(old.runtime.generation, 'missing_entry_errors_056')
    assert.equal(old.meters[0].quotedMinor, '5')
    assert.ok(old.meters.slice(1).every(item => item.state === 'blocked'))
    assert.equal(old.profile.defaultUnitPriceMinor, null)
    await installReserve('080')
    const free = await diagnoseCustomerPrice(pool, keyId, meters)
    assert.equal(free.runtime.generation, 'unlisted_free_080')
    assert.ok(free.meters.slice(1).every(item => item.state === 'unbilled'))
    await db.exec("ALTER TABLE billing.tenant_billing_profiles ADD default_unit_price_minor bigint DEFAULT 1, ADD default_currency char(3) DEFAULT 'CNY'")
    const migration = await readFile(new URL('../../migrations/105_tenant_default_request_price.sql', import.meta.url), 'utf8')
    const start = migration.indexOf('CREATE OR REPLACE FUNCTION billing.customer_price_for_usage(')
    await db.exec(migration.slice(start, migration.indexOf('$function$;', migration.indexOf('$function$', start) + 10) + '$function$;'.length))
    await installReserve('105')
    const current = await diagnoseCustomerPrice(pool, keyId, meters)
    assert.equal(current.runtime.generation, 'tenant_default_105')
    assert.deepEqual(current.meters.map(item => item.quotedMinor), ['5', '1', '1', '1'])
    assert.ok(current.meters.every(item => item.billingUnit === 'request'))
    assert.equal(current.assignment.assignedAt.toISOString(), row.assigned_at)
    for (const [file, contract] of [['129_commerce_ip_risk_v2.sql', 'subscription_exclusion_129'],
      ['130_commerce_space_subscriptions.sql', 'subscription_exclusions_130']]) {
      const migration = await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8')
      const start = migration.indexOf('CREATE TRIGGER usage_requests_reserve_customer_charge ')
      await db.exec('DROP TRIGGER usage_requests_reserve_customer_charge ON usage_requests')
      await db.exec(migration.slice(start, migration.indexOf(';', start) + 1))
      const report = await diagnoseCustomerPrice(pool, keyId, meters)
      assert.equal(report.runtime.reservationTriggerContract, contract)
      assert.deepEqual(report.meters.map(item => item.quotedMinor), ['5', '1', '1', '1'])
    }
    await db.exec('DROP TRIGGER usage_requests_reserve_customer_charge ON usage_requests')
    await db.exec(triggerDefinition.replace('EXECUTE FUNCTION', "WHEN (NEW.billing_meter_key <> 'raw') EXECUTE FUNCTION"))
    const unknownPredicate = await diagnoseCustomerPrice(pool, keyId, meters)
    assert.equal(unknownPredicate.runtime.reservationTriggerContract, 'unverified')
    assert.ok(unknownPredicate.meters.every(item => item.state === 'unverified'))
    assert.deepEqual(await snapshot(), before)
    assert.equal(released, 6)
    assert.equal((await db.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'off')
  })
