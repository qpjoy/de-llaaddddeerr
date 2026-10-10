import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { syncManagedApiAccess } from '../../server/stores/managed-api-access.mjs'
import { businessApiScopes } from '../../server/hub-service.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

const migration = name => readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8')
test('managed scope registry includes WeChat and native APIs without control-plane/ingestion privileges', () => {
  const scopes = businessApiScopes(['data_center_saved_records_new'])
  assert.ok(scopes.capabilities.includes('native.wechat.search.search'))
  assert.ok(scopes.capabilities.includes('native.wechat.mp.article-detail'))
  assert.ok(scopes.platforms.includes('data_center_saved_records_new'))
  assert.ok(scopes.capabilities.length > 1000)
  assert.ok(scopes.capabilities.every(value => !value.includes('ingest') && !value.includes('admin')))
})

test('PostgreSQL managed grants preserve identities/siblings and synchronize newly released scopes idempotently', {
  skip: !process.env.MX_INSIGHT_TEST_DATABASE_URL,
}, async t => {
  const db = new pg.Client({ connectionString: process.env.MX_INSIGHT_TEST_DATABASE_URL })
  await db.connect()
  const schema = `managed_${randomUUID().replaceAll('-', '')}`
  t.after(async () => { await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.end() })
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
  const sync = async (current = scopes) => {
    await db.query('BEGIN')
    try { const result = await syncManagedApiAccess(db, current); await db.query('COMMIT'); return result }
    catch (error) { await db.query('ROLLBACK'); throw error }
  }
  assert.equal((await sync()).changed, 1)
  assert.deepEqual(await store.listEffectiveCapabilityGrants(consumer, key), scopes.capabilities)
  assert.deepEqual(await store.listEffectiveCapabilityGrants(consumer, sibling), [])
  assert.deepEqual(await store.listEffectiveGrants(consumer, key), scopes.platforms)
  assert.deepEqual((await db.query('SELECT id,key_digest,status,expires_at FROM api_keys ORDER BY id')).rows, beforeKeys)
  assert.equal((await sync()).changed, 0)
  const next = { ...scopes, capabilities: [...scopes.capabilities, 'future.example.query'] }
  assert.equal((await sync(next)).changed, 1)
  assert.ok((await store.listEffectiveCapabilityGrants(consumer, key)).includes('future.example.query'))
  assert.deepEqual(await store.listEffectiveCapabilityGrants(consumer, sibling), [])
  await db.query("UPDATE api_keys SET scope_mode='legacy_dynamic' WHERE id=$1", [sibling])
  await assert.rejects(sync(), /sibling dynamic/)
  await db.query("UPDATE api_keys SET scope_mode='snapshot' WHERE id=$1", [sibling])
  await db.query("UPDATE api_keys SET status='revoked' WHERE id=$1", [key])
  assert.equal((await sync({ ...next, capabilities: [...next.capabilities, 'future.revoked.query'] })).changed, 0)
  assert.equal((await db.query('SELECT 1 FROM api_key_capability_entitlements WHERE capability=$1', ['future.revoked.query'])).rowCount, 0)
})
