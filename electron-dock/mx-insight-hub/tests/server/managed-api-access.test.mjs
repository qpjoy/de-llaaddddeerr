import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { syncManagedApiAccess } from '../../server/stores/managed-api-access.mjs'
import { businessApiScopes, lcyFullApiScopes } from '../../server/hub-service.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { FILE_DATASETS } from '../../shared/file-datasets.mjs'
import { COLLECT_CAPABILITY_KEYS } from '../../shared/collect-engines.mjs'

const migration = name => readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8')
test('managed scope registry includes WeChat and native APIs without control-plane/ingestion privileges', () => {
  const scopes = businessApiScopes(['data_center_saved_records_new'])
  assert.ok(scopes.capabilities.includes('native.wechat.search.search'))
  assert.ok(scopes.capabilities.includes('native.wechat.mp.article-detail'))
  assert.ok(scopes.platforms.includes('data_center_saved_records_new'))
  assert.ok(scopes.capabilities.length > 1000)
  assert.ok(scopes.capabilities.every(value => !value.includes('ingest') && !value.includes('admin')))
  for (const dataset of FILE_DATASETS) {
    assert.ok(!scopes.platforms.includes(dataset.platform))
    assert.ok(!scopes.capabilities.includes(dataset.searchCapability))
  }
  assert.ok(COLLECT_CAPABILITY_KEYS.every(value => !scopes.capabilities.includes(value)))
})

test('LCY full access follows every file dataset and collection capability without granting Admin authority', () => {
  const scopes = lcyFullApiScopes(['data_center_saved_records_new'])
  for (const dataset of FILE_DATASETS) {
    assert.ok(scopes.platforms.includes(dataset.platform), dataset.platform)
    assert.ok(scopes.capabilities.includes(dataset.searchCapability), dataset.searchCapability)
  }
  for (const capability of COLLECT_CAPABILITY_KEYS) assert.ok(scopes.capabilities.includes(capability), capability)
  assert.ok(scopes.capabilities.includes('public_opinion.all_ingested.read'))
  assert.ok(scopes.platforms.includes('data_center_saved_records_new'))
  assert.ok(scopes.capabilities.every(value => !value.startsWith('admin.') && !value.startsWith('ingest.')))
  assert.equal(new Set(scopes.platforms).size, scopes.platforms.length)
  assert.equal(new Set(scopes.capabilities).size, scopes.capabilities.length)
})

async function postgresClient() {
  if (process.env.MX_INSIGHT_TEST_DATABASE_URL) {
    const client = new pg.Client({ connectionString: process.env.MX_INSIGHT_TEST_DATABASE_URL })
    await client.connect()
    return client
  }
  const { PGlite } = await import(pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE).href)
  const db = new PGlite()
  // Execute real PostgreSQL statements in one WASM session. This covers the
  // transaction and scope intersections, not contention between server sessions.
  return { end: () => db.close(), async query(sql, params) {
    const result = params ? await db.query(sql, params) : (await db.exec(sql)).at(-1)
    return { ...result, rowCount: result.rows?.length || result.affectedRows || 0 }
  } }
}

test('PostgreSQL managed grants preserve identities/siblings and synchronize newly released scopes idempotently', {
  skip: !process.env.MX_INSIGHT_TEST_DATABASE_URL && !process.env.MX_INSIGHT_TEST_PGLITE_MODULE,
}, async t => {
  const db = await postgresClient()
  const schema = `managed_${randomUUID().replaceAll('-', '')}`
  t.after(async () => { try { await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`) } finally { await db.end() } })
  await db.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`)
  for (const name of ['001_initial.sql', '002_api_key_environment.sql', '003_consumer_platform_policies.sql', '016_api_key_expiry.sql', '018_public_capabilities.sql']) await db.query(await migration(name))
  await db.query((await migration('054_api_key_entitlements_plans_and_tikhub.sql')).split('-- Keep the caller-visible')[0])
  await db.query(await migration('079_api_key_scope_events.sql'))
  await db.query("ALTER TABLE api_keys ADD COLUMN web_search_order text[] NOT NULL DEFAULT '{}'")
  const tenant = '277bf8a4-5ed5-414d-b429-d72fcd7d36b6', consumer = 'be7d07fe-3d98-4db3-b00d-e5cbe5a76190'
  const key = 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83', sibling = randomUUID()
  await db.query("INSERT INTO tenants(id,name) VALUES($1,'Fixture')", [tenant])
  await db.query("INSERT INTO consumers(id,tenant_id,name,business_id) VALUES($1,$2,'Fixture',$3)", [consumer, tenant, randomUUID()])
  for (const [id, digest] of [[key, '1'], [sibling, '2']]) await db.query(`INSERT INTO api_keys(id,tenant_id,consumer_id,name,key_digest,key_prefix,last_four,environment,scope_mode,expires_at)
    VALUES($1,$2,$3,'LCY-delta',$4,'synthetic','test','live','snapshot','2099-01-01')`, [id, tenant, consumer, digest.repeat(64)])
  await db.query(await migration('141_lcy_managed_full_access.sql'))
  const beforeKeys = (await db.query('SELECT id,key_digest,status,expires_at FROM api_keys ORDER BY id')).rows
  const store = new PostgresStore(db)
  const scopes = businessApiScopes(['data_center_saved_records_new'])
  const fullScopes = lcyFullApiScopes(['data_center_saved_records_new'])
  const sync = async (current = scopes) => {
    await db.query('BEGIN')
    try { const result = await syncManagedApiAccess(db, current); await db.query('COMMIT'); return result }
    catch (error) { await db.query('ROLLBACK'); throw error }
  }
  // A stale sibling snapshot may retain a scope whose consumer grant was
  // removed. Restoring that grant must not silently reactivate the sibling.
  for (const [kind, scope] of [['platform', 'phone_directory'], ['capability', 'phone.directory.search']]) {
    const table = `api_key_${kind}_entitlements`
    const pageColumn = kind === 'platform' ? ',max_page_size' : ''
    const pageValue = kind === 'platform' ? ',50' : ''
    await db.query(`INSERT INTO ${table}(api_key_id,${kind},max_requests,window_seconds${pageColumn})
      VALUES($1,$2,10,60${pageValue})`, [sibling, scope])
    await assert.rejects(sync(), /sibling snapshot Key could regain access/)
    assert.equal((await db.query('SELECT 1 FROM platform_grants WHERE consumer_id=$1', [consumer])).rowCount, 0)
    assert.equal((await db.query('SELECT 1 FROM capability_grants WHERE consumer_id=$1', [consumer])).rowCount, 0)
    assert.equal((await db.query('SELECT 1 FROM api_key_capability_entitlements WHERE api_key_id=$1', [key])).rowCount, 0)
    await db.query(`DELETE FROM ${table} WHERE api_key_id=$1`, [sibling])
  }
  await db.query("UPDATE api_keys SET name='Renamed original' WHERE id=$1", [key])
  assert.equal((await sync()).changed, 1)
  // PostgreSQL collation may differ from JS for punctuation; authorization
  // depends on membership, not the order of scope names.
  assert.deepEqual((await store.listEffectiveCapabilityGrants(consumer, key)).sort(),
    fullScopes.capabilities)
  assert.deepEqual(await store.listEffectiveCapabilityGrants(consumer, sibling), [])
  assert.deepEqual((await store.listEffectiveGrants(consumer, key)).sort(),
    fullScopes.platforms)
  assert.deepEqual(await store.listEffectiveGrants(consumer, sibling), [])
  assert.deepEqual((await db.query('SELECT id,key_digest,status,expires_at FROM api_keys ORDER BY id')).rows, beforeKeys)
  assert.equal((await sync()).changed, 0)
  const next = { ...scopes, capabilities: [...scopes.capabilities, 'future.example.query'] }
  assert.equal((await sync(next)).changed, 1)
  assert.ok((await store.listEffectiveCapabilityGrants(consumer, key)).includes('future.example.query'))
  assert.equal((await sync(next)).changed, 0)
  assert.deepEqual(await store.listEffectiveCapabilityGrants(consumer, sibling), [])
  await db.query("UPDATE api_keys SET scope_mode='legacy_dynamic' WHERE id=$1", [sibling])
  await assert.rejects(sync(), /sibling dynamic/)
  await db.query("UPDATE api_keys SET scope_mode='snapshot' WHERE id=$1", [sibling])
  // Inactive identities and expired/revoked Keys remain unusable; synchronization
  // neither revives them nor adds a future capability while they are disabled.
  for (const [disable, restore, id] of [
    ["UPDATE api_keys SET expires_at='2000-01-01' WHERE id=$1", "UPDATE api_keys SET expires_at='2099-01-01' WHERE id=$1", key],
    ["UPDATE api_keys SET environment='test' WHERE id=$1", "UPDATE api_keys SET environment='live' WHERE id=$1", key],
    ["UPDATE consumers SET status='suspended' WHERE id=$1", "UPDATE consumers SET status='active' WHERE id=$1", consumer],
    ["UPDATE tenants SET status='suspended' WHERE id=$1", "UPDATE tenants SET status='active' WHERE id=$1", tenant],
  ]) {
    await db.query(disable, [id])
    assert.equal((await sync({ ...next, capabilities: [...next.capabilities, 'future.disabled.query'] })).changed, 0)
    assert.equal((await db.query('SELECT 1 FROM api_key_capability_entitlements WHERE capability=$1', ['future.disabled.query'])).rowCount, 0)
    await db.query(restore, [id])
  }
  await db.query("UPDATE api_keys SET status='revoked' WHERE id=$1", [key])
  assert.equal((await sync({ ...next, capabilities: [...next.capabilities, 'future.revoked.query'] })).changed, 0)
  assert.equal((await db.query('SELECT 1 FROM api_key_capability_entitlements WHERE capability=$1', ['future.revoked.query'])).rowCount, 0)
  // Even another live managed Key with identical name, tenant and consumer
  // must not inherit LCY-delta's file-dataset or collection access.
  await db.query("UPDATE api_keys SET access_profile='managed_full' WHERE id=$1", [sibling])
  assert.equal((await sync()).changed, 1)
  assert.deepEqual((await store.listEffectiveCapabilityGrants(consumer, sibling)).sort(), scopes.capabilities)
  assert.deepEqual((await store.listEffectiveGrants(consumer, sibling)).sort(), scopes.platforms)

  // The original UUID under a different consumer is not the authorized LCY
  // identity. Its mutable name and managed profile cannot confer full access.
  const otherConsumer = randomUUID()
  await db.query("INSERT INTO consumers(id,tenant_id,name,business_id) VALUES($1,$2,'Fixture other',$3)", [otherConsumer, tenant, randomUUID()])
  await db.query('DELETE FROM api_key_platform_entitlements WHERE api_key_id=$1', [key])
  await db.query('DELETE FROM api_key_capability_entitlements WHERE api_key_id=$1', [key])
  await db.query("UPDATE api_keys SET consumer_id=$2,status='active' WHERE id=$1", [key, otherConsumer])
  assert.equal((await sync()).changed, 1)
  assert.deepEqual((await store.listEffectiveCapabilityGrants(otherConsumer, key)).sort(), scopes.capabilities)
  assert.deepEqual((await store.listEffectiveGrants(otherConsumer, key)).sort(), scopes.platforms)

  const otherTenant = randomUUID()
  await db.query("INSERT INTO tenants(id,name) VALUES($1,'Fixture other tenant')", [otherTenant])
  await db.query('DELETE FROM api_key_platform_entitlements WHERE api_key_id=$1', [key])
  await db.query('DELETE FROM api_key_capability_entitlements WHERE api_key_id=$1', [key])
  await db.query('UPDATE consumers SET tenant_id=$2 WHERE id=$1', [consumer, otherTenant])
  await db.query('UPDATE api_keys SET tenant_id=$2,consumer_id=$3 WHERE id=$1', [key, otherTenant, consumer])
  assert.equal((await sync()).changed, 1)
  assert.deepEqual((await store.listEffectiveCapabilityGrants(consumer, key)).sort(), scopes.capabilities)
  assert.deepEqual((await store.listEffectiveGrants(consumer, key)).sort(), scopes.platforms)
})
