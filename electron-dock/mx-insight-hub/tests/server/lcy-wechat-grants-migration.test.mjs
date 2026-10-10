import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import services from '../../shared/wechat-services.json' with { type: 'json' }
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

const migration = name => readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8')
const sql = await migration('140_lcy_wechat_mp_grants.sql')
const tenant = '277bf8a4-5ed5-414d-b429-d72fcd7d36b6'
const consumer = 'be7d07fe-3d98-4db3-b00d-e5cbe5a76190'
const key = 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83'
const sibling = '00000000-0000-4000-8000-000000000002'
const operations = services.filter(row => row.key.startsWith('wechat.mp.') || row.key === 'wechat.search.search').map(row => row.operation).sort()

test('LCY migration pins only current MP endpoints and article search, independently from pricing', () => {
  const declared = [...sql.matchAll(/'(native\.wechat\.[a-z0-9.-]+)'/g)].map(match => match[1]).sort()
  assert.equal(operations.length, 12)
  assert.deepEqual(declared, operations)
  assert.doesNotMatch(sql, /UPDATE\s+(?:api_keys|plan_versions|billing_accounts|control\.)/i)
})

test('real PostgreSQL grants fix the effective intersection without changing identity, siblings or old limits', {
  skip: process.env.MX_INSIGHT_TEST_DATABASE_URL ? false : 'Requires a disposable MX_INSIGHT_TEST_DATABASE_URL',
}, async t => {
  const db = new pg.Client({ connectionString: process.env.MX_INSIGHT_TEST_DATABASE_URL })
  await db.connect()
  const schema = `wechat_test_${randomUUID().replaceAll('-', '')}`
  t.after(async () => { await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.end() })
  await db.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`)
  for (const name of ['001_initial.sql', '002_api_key_environment.sql', '003_consumer_platform_policies.sql',
    '016_api_key_expiry.sql', '018_public_capabilities.sql']) await db.query(await migration(name))
  await db.query((await migration('054_api_key_entitlements_plans_and_tikhub.sql')).split('-- Keep the caller-visible')[0])
  await db.query(await migration('079_api_key_scope_events.sql'))
  await db.query("ALTER TABLE api_keys ADD COLUMN web_search_order text[] NOT NULL DEFAULT '{}'")
  const store = new PostgresStore(db)
  const rows = async (query, args = []) => (await db.query(query, args)).rows
  const apply = async () => {
    await db.query('BEGIN')
    try { await db.query(sql); await db.query('COMMIT') }
    catch (error) { await db.query('ROLLBACK'); throw error }
  }
  await apply()
  assert.equal((await rows('SELECT * FROM api_keys')).length, 0)
  await db.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenant, 'Fixture'])
  await db.query('INSERT INTO consumers(id,tenant_id,name,business_id) VALUES($1,$2,$3,$4)', [consumer, tenant, 'Fixture', randomUUID()])
  for (const [id, name, digest] of [[key, 'renamed-original', '1'], [sibling, 'LCY-delta', '2']]) {
    await db.query(`INSERT INTO api_keys(id,tenant_id,consumer_id,name,key_digest,key_prefix,last_four,environment,scope_mode,expires_at)
      VALUES($1,$2,$3,$4,$5,'synthetic','test','live','snapshot','2099-01-01')`, [id, tenant, consumer, name, digest.repeat(64)])
    await db.query("INSERT INTO api_key_platform_entitlements(api_key_id,platform,max_requests,window_seconds,max_page_size) VALUES($1,'social',80,60,15)", [id])
    await db.query("INSERT INTO api_key_capability_entitlements(api_key_id,capability,max_requests,window_seconds) VALUES($1,'existing',7,120)", [id])
  }
  await db.query("INSERT INTO platform_grants(consumer_id,platform) VALUES($1,'social')", [consumer])
  await db.query("INSERT INTO capability_grants(consumer_id,capability) VALUES($1,'existing')", [consumer])
  await db.query(`INSERT INTO consumer_capability_policies(tenant_id,consumer_id,capability,max_requests,window_seconds)
    VALUES($1,$2,'native.wechat.search.search',3,120)`, [tenant, consumer])
  await db.query(`INSERT INTO api_key_capability_entitlements(api_key_id,capability,max_requests,window_seconds)
    VALUES($1,'native.wechat.mp.article-detail',2,300)`, [key])
  const keysBefore = await rows('SELECT * FROM api_keys ORDER BY id')
  const platformsBefore = await rows('SELECT * FROM api_key_platform_entitlements ORDER BY api_key_id,platform')
  assert.deepEqual(await store.listEffectiveCapabilityGrants(consumer, key), ['existing'])

  for (const [change, restore, error, id = key] of [
    ["UPDATE api_keys SET scope_mode='legacy_dynamic' WHERE id=$1", "UPDATE api_keys SET scope_mode='snapshot' WHERE id=$1", /sibling dynamic/, sibling],
    ["UPDATE api_keys SET status='revoked' WHERE id=$1", "UPDATE api_keys SET status='active' WHERE id=$1", /Key unavailable/],
    ["UPDATE api_keys SET environment='test' WHERE id=$1", "UPDATE api_keys SET environment='live' WHERE id=$1", /Key unavailable/],
    ["UPDATE api_keys SET expires_at='2000-01-01' WHERE id=$1", "UPDATE api_keys SET expires_at='2099-01-01' WHERE id=$1", /Key unavailable/],
    ["UPDATE platform_grants SET platform='other' WHERE consumer_id=$1", "UPDATE platform_grants SET platform='social' WHERE consumer_id=$1", /effective social/, consumer],
  ]) {
    await db.query(change, [id])
    await assert.rejects(apply(), error)
    assert.deepEqual(await store.listEffectiveCapabilityGrants(consumer, key), ['existing'])
    await db.query(restore, [id])
  }
  // Force failure after grants were inserted: the whole migration must roll back.
  await db.query(`CREATE FUNCTION reject_scope_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    RAISE EXCEPTION 'synthetic audit failure'; END $$;
    CREATE TRIGGER reject_scope_audit BEFORE INSERT ON api_key_scope_events FOR EACH ROW EXECUTE FUNCTION reject_scope_audit()`)
  await assert.rejects(apply(), /synthetic audit failure/)
  assert.deepEqual(await store.listEffectiveCapabilityGrants(consumer, key), ['existing'])
  await db.query('DROP TRIGGER reject_scope_audit ON api_key_scope_events')

  await apply()
  assert.deepEqual(await store.listEffectiveCapabilityGrants(consumer, key), ['existing', ...operations])
  assert.deepEqual(await store.listEffectiveCapabilityGrants(consumer, sibling), ['existing'])
  assert.deepEqual(await rows('SELECT * FROM api_keys ORDER BY id'), keysBefore)
  assert.deepEqual(await rows('SELECT * FROM api_key_platform_entitlements ORDER BY api_key_id,platform'), platformsBefore)
  assert.deepEqual(await rows('SELECT max_requests,window_seconds FROM api_key_capability_entitlements WHERE api_key_id=$1 AND capability=$2',
    [key, 'native.wechat.search.search']), [{ max_requests: 3, window_seconds: 120 }])
  assert.deepEqual(await rows('SELECT max_requests,window_seconds FROM api_key_capability_entitlements WHERE api_key_id=$1 AND capability=$2',
    [key, 'native.wechat.mp.article-detail']), [{ max_requests: 2, window_seconds: 300 }])
  const grantsAfter = await rows('SELECT * FROM capability_grants ORDER BY capability')
  const auditAfter = await rows('SELECT * FROM api_key_scope_events')
  assert.equal(auditAfter.length, 1)
  assert.equal(auditAfter[0].actor, 'migration-140:user-authorized-wechat-mp')
  await apply()
  assert.deepEqual(await rows('SELECT * FROM capability_grants ORDER BY capability'), grantsAfter)
  assert.deepEqual(await rows('SELECT * FROM api_key_scope_events'), auditAfter)
})
