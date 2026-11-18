import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { assertLcyRepairable, LCY_API_IDENTITY, lcyAccessArguments, runLcyApiAccess } from '../../scripts/lcy-api-access.mjs'
import { syncManagedApiAccess } from '../../server/stores/managed-api-access.mjs'
import { isLcyHubLimitIdentity } from '../../server/core/internal-traffic-policy.mjs'

test('LCY repair accepts only its fixed identity and explicit apply, without names, secrets or arbitrary targets', async () => {
  assert.deepEqual(lcyAccessArguments([]), { apply: false })
  assert.deepEqual(lcyAccessArguments(['--apply']), { apply: true })
  for (const args of [['--all'], ['--key-id', LCY_API_IDENTITY.apiKeyId], ['--api-key', 'secret'], ['--apply', '--apply']]) {
    assert.throws(() => lcyAccessArguments(args), { diagnosticCode: 'invalid_arguments' })
  }
  assert.ok(isLcyHubLimitIdentity({ apiKey: { id: LCY_API_IDENTITY.apiKeyId },
    tenant: { id: LCY_API_IDENTITY.tenantId }, consumer: { id: LCY_API_IDENTITY.consumerId } }))
  const neverQuery = { query: () => assert.fail('invalid target must be rejected before SQL') }
  for (const apiKeyId of ['LCY-delta', '', true]) await assert.rejects(syncManagedApiAccess(neverQuery, undefined, { apiKeyId }), /invalid target Key ID/u)
})

test('repair refuses older runtime modules, incomplete catalogs and disabled authority', () => {
  const valid = { targetedSyncAvailable: true, catalogCoverage: { missingCollectionPlatforms: [], missingCollectionCapabilities: [] },
    identityUsable: true, scopeMode: 'snapshot', accessProfile: 'managed_full' }
  assert.doesNotThrow(() => assertLcyRepairable(valid))
  for (const [changed, code] of [
    [{ targetedSyncAvailable: false }, 'installed_runtime_upgrade_required'],
    [{ catalogCoverage: { missingCollectionPlatforms: ['tieba'] } }, 'installed_runtime_upgrade_required'],
    [{ catalogCoverage: { missingCollectionCapabilities: ['collect.future'] } }, 'installed_runtime_upgrade_required'],
    [{ identityUsable: false }, 'identity_unavailable'],
    [{ scopeMode: 'legacy_dynamic' }, 'snapshot_key_required'],
    [{ accessProfile: 'standard' }, 'managed_profile_required'],
  ]) assert.throws(() => assertLcyRepairable({ ...valid, ...changed }), { diagnosticCode: code })
})

test('SQL audit separates both grant layers and targeted repair is atomic, idempotent and catalog-driven', {
  skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE,
}, async t => {
  const { PGlite } = await import(pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE).href)
  const db = new PGlite(); t.after(() => db.close())
  const queries = []
  const client = { async query(sql, params) {
    queries.push(sql)
    const result = params ? await db.query(sql, params) : (await db.exec(sql)).at(-1)
    return { ...result, rowCount: result.rows?.length || result.affectedRows || 0 }
  } }
  const migration = name => readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8')
  for (const name of ['001_initial.sql', '002_api_key_environment.sql', '003_consumer_platform_policies.sql',
    '016_api_key_expiry.sql', '018_public_capabilities.sql']) await client.query(await migration(name))
  await client.query((await migration('054_api_key_entitlements_plans_and_tikhub.sql')).split('-- Keep the caller-visible')[0])
  await client.query(await migration('079_api_key_scope_events.sql'))
  await client.query("ALTER TABLE api_keys ADD COLUMN web_search_order text[] NOT NULL DEFAULT '{}'; CREATE SCHEMA catalog; CREATE TABLE catalog.external_sources(source_key text)")
  const { tenantId, consumerId, apiKeyId } = LCY_API_IDENTITY
  const siblingId = '11111111-1111-4111-8111-111111111111'
  await client.query("INSERT INTO tenants(id,name) VALUES($1,'Fixture')", [tenantId])
  await client.query("INSERT INTO consumers(id,tenant_id,name,business_id) VALUES($1,$2,'Fixture',$3)", [consumerId, tenantId, siblingId])
  for (const [id, digest] of [[apiKeyId, '1'], [siblingId, '2']]) {
    await client.query(`INSERT INTO api_keys(id,tenant_id,consumer_id,name,key_digest,key_prefix,last_four,environment,scope_mode,expires_at)
      VALUES($1,$2,$3,'LCY-delta',$4,'synthetic','test','live','snapshot','2099-01-01')`, [id, tenantId, consumerId, digest.repeat(64)])
  }
  await client.query(await migration('141_lcy_managed_full_access.sql'))
  await client.query("UPDATE api_keys SET access_profile='managed_full' WHERE id=$1", [siblingId])
  await client.query("INSERT INTO platform_grants(consumer_id,platform) VALUES($1,'social')", [consumerId])
  await client.query(`INSERT INTO api_key_platform_entitlements(api_key_id,platform,max_requests,window_seconds,max_page_size)
    VALUES($1,'ecommerce',10,60,50)`, [apiKeyId])
  const keyRows = async () => (await client.query('SELECT id,key_digest,status,expires_at,access_profile FROM api_keys ORDER BY id')).rows
  const beforeKeys = await keyRows()
  queries.length = 0
  const before = await runLcyApiAccess(client)
  assert.equal(before.writes, 0)
  assert.equal(before.supplierHttpCallsMade, 0)
  assert.equal(before.complete, false)
  assert.equal(before.targetedSyncAvailable, true)
  assert.deepEqual(before.catalogCoverage, { missingCollectionPlatforms: [], missingCollectionCapabilities: [] })
  assert.ok(before.platforms.missingConsumerGrants.includes('ecommerce'))
  assert.ok(!before.platforms.missingConsumerGrants.includes('social'))
  assert.ok(before.platforms.missingKeyEntitlements.includes('social'))
  assert.ok(!before.platforms.missingKeyEntitlements.includes('ecommerce'))
  assert.ok(before.platforms.missingEffectiveGrants.includes('social'))
  assert.ok(before.platforms.missingEffectiveGrants.includes('ecommerce'))
  assert.equal(queries[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.ok(queries.every(sql => !/^\s*(INSERT|UPDATE|DELETE|ALTER)/iu.test(sql)))
  const applied = await runLcyApiAccess(client, { apply: true })
  assert.equal(applied.complete, true)
  assert.equal(applied.changedKeys, 1)
  assert.deepEqual(applied.platforms.missingEffectiveGrants, [])
  assert.deepEqual(applied.capabilities.missingEffectiveGrants, [])
  assert.deepEqual(await keyRows(), beforeKeys)
  for (const table of ['api_key_platform_entitlements', 'api_key_capability_entitlements']) {
    assert.equal((await client.query(`SELECT 1 FROM ${table} WHERE api_key_id=$1`, [siblingId])).rowCount, 0)
  }
  const events = async () => (await client.query('SELECT * FROM api_key_scope_events ORDER BY id')).rows
  const firstEvents = await events()
  assert.equal((await runLcyApiAccess(client, { apply: true })).changedKeys, 0)
  assert.deepEqual(await events(), firstEvents)
  await client.query("INSERT INTO catalog.external_sources(source_key) VALUES('night-all-saved-records-future-audit')")
  const future = await runLcyApiAccess(client)
  assert.notEqual(future.catalogFingerprint, before.catalogFingerprint)
  assert.deepEqual(future.platforms.missingEffectiveGrants, ['data_center_saved_records_future_audit'])
  // A sibling dynamic Key must make the attempted repair roll back, including
  // all authorization and audit writes for the newly registered source.
  await client.query("UPDATE api_keys SET scope_mode='legacy_dynamic' WHERE id=$1", [siblingId])
  await assert.rejects(runLcyApiAccess(client, { apply: true }), /sibling dynamic/u)
  assert.deepEqual(await events(), firstEvents)
  assert.deepEqual((await runLcyApiAccess(client)).platforms.missingEffectiveGrants, future.platforms.missingEffectiveGrants)
  await client.query("UPDATE api_keys SET scope_mode='snapshot' WHERE id=$1", [siblingId])
  assert.equal((await runLcyApiAccess(client, { apply: true })).complete, true)
})
