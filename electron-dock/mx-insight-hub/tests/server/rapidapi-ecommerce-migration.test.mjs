import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { PostgresExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { migrate, parseArgs } from '../../scripts/migrate-missing-operation-prices.mjs'

const pinduoduo = 'native.r.pinduoduo_search_products'
const shein = 'native.r.shein_search_products'
const facebook = 'native.r.facebook_marketplace_search'
const keys = [pinduoduo, shein, facebook]
const migration = name => readFile(new URL(`../../migrations/${name}.sql`, import.meta.url), 'utf8')
const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE

test('ecommerce registrations preserve manual policy and keep held marketplaces paused through price bootstrap', {
  skip: !modulePath && 'Set MX_INSIGHT_TEST_PGLITE_MODULE for isolated PostgreSQL execution',
}, async t => {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec('CREATE SCHEMA control')
  const control = await migration('060_external_platform_operation_control')
  await db.exec(control.slice(control.indexOf('CREATE TABLE IF NOT EXISTS control.external_platform_provider_price_books'),
    control.indexOf('CREATE OR REPLACE FUNCTION control.reject_external_platform_append_only_mutation')))
  await db.exec(`INSERT INTO control.external_platform_provider_price_books(provider_key,version,source,status)
    VALUES ('rapidapi',0,'legacy_environment','inherited'), ('tikhub',0,'legacy_environment','inherited')`)
  await db.exec(await migration('168_ecommerce_supplier_operations'))
  const install = [await migration('195_rapidapi_ecommerce_keyword_search'), await migration('197_rapidapi_facebook_marketplace_search')].join('\n')
  const snapshot = async () => {
    const tables = ['operation_releases', 'operation_policies', 'operation_policy_events', 'provider_price_books', 'provider_price_book_entries']
    const rows = {}
    for (const table of tables) rows[table] = (await db.query(`SELECT * FROM control.external_platform_${table} ORDER BY 1,2,3`)).rows
    return rows
  }
  await db.exec(install)
  const initial = await snapshot()
  for (const [key, expected] of [[pinduoduo, 'disabled'], [shein, 'paused'], [facebook, 'paused']]) {
    const [release] = initial.operation_releases.filter(row => row.operation_key === key)
    assert.equal(release.contract_version, 'mx-insight-hub.native-forwarding.v1')
    assert.equal(release.status, 'released')
    assert.deepEqual(release.endpoint_keys, [key])
    const events = initial.operation_policy_events.filter(row => row.operation_key === key)
    assert.equal(events.length, 1)
    assert.equal(events[0].actor, key === facebook ? 'migration-197' : 'migration-195')
    assert.equal(events[0].desired_state, expected)
    assert.equal(initial.operation_policies.find(row => row.operation_key === key).desired_state, expected)
  }
  await db.exec(install)
  assert.deepEqual(await snapshot(), initial)

  const client = { query: db.query.bind(db), release() {} }
  const store = new PostgresExternalPlatformControlStore({ pool: { ...client, connect: async () => client } })
  const runtime = { credentialConfigured: true, config: { billing: {}, reservationLeaseMs: 150000 } }
  const admin = async (path, body) => {
    if (body) return store.updatePolicy('rapidapi', path.split('/').at(-2), body, { runtime })
    if (path.endsWith('external-platforms?range=24h')) return { providers: [{ key: 'rapidapi' }] }
    return { operations: await store.describeProvider('rapidapi', runtime), provider: { billing: {} } }
  }
  const options = parseArgs(['--provider', 'rapidapi', ...keys.flatMap(key => ['--operation', key]),
    '--defaults', '--missing-budget-minor', '100000', '--apply'])
  const applyDefaults = async () => migrate({ options, admin, audit: (await db.query(
    'SELECT * FROM control.external_platform_operation_policy_events ORDER BY operation_key, revision')).rows })
  const first = await applyDefaults()
  assert.equal(first.summary.errors, 0, JSON.stringify(first.errors))
  assert.equal(first.summary.confirmedWrites, keys.length)
  const afterPricing = await snapshot()
  const policy = (rows, key) => rows.operation_policies.find(row => row.operation_key === key)
  assert.equal(policy(afterPricing, pinduoduo).desired_state, 'active')
  assert.equal(policy(afterPricing, shein).desired_state, 'paused')
  assert.equal(policy(afterPricing, facebook).desired_state, 'paused')
  for (const key of keys) {
    const prices = afterPricing.provider_price_book_entries.filter(row => row.endpoint_key === key)
    assert.equal(prices.length, 1)
    assert.equal(Number(prices[0].unit_cost_minor), 1)
  }
  assert.equal((await applyDefaults()).summary.confirmedWrites, 0)
  assert.deepEqual(await snapshot(), afterPricing)

  await store.updatePolicy('rapidapi', pinduoduo, { expectedRevision: Number(policy(afterPricing, pinduoduo).revision),
    desiredState: 'paused', reason: 'Operator hold pending review' }, { actor: 'operator', runtime })
  const manual = await snapshot()
  assert.equal(policy(manual, pinduoduo).updated_by, 'operator')
  await db.exec(install)
  assert.equal((await applyDefaults()).summary.confirmedWrites, 0)
  assert.deepEqual(await snapshot(), manual)
})
