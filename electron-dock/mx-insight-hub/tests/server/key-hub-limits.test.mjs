import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { readKeyHubLimits, saveKeyHubLimits } from '../../server/stores/key-hub-limits.mjs'

const keyId = 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83'
const tenantId = '277bf8a4-5ed5-414d-b429-d72fcd7d36b6'
const consumerId = 'be7d07fe-3d98-4db3-b00d-e5cbe5a76190'
const actor = () => ({ actor: 'admin-token', requestId: randomUUID() })
const body = (hubRateLimitExempt, revision = 0) => ({ hubRateLimitExempt, revision, reason: 'Reviewed LCY admission policy' })
const reservation = (extra = {}) => ({ tenantId, consumerId, apiKeyId: keyId, platform: 'xiaohongshu',
  requestId: randomUUID(), idempotencyKey: randomUUID(), fingerprint: 'a'.repeat(64),
  unitsReserved: 1, leaseExpiresAt: new Date(Date.now() + 60000),
  maxRequests: 1, windowStart: new Date(Date.now() - 3600000), ...extra })

async function memoryFixture() {
  const store = new MemoryStore({ internalTraffic: { keyIds: [keyId] } })
  store.tenants.set(tenantId, { id: tenantId, status: 'active', name: 'Fixture' })
  store.consumers.set(consumerId, { id: consumerId, tenantId, status: 'active', name: 'Fixture' })
  store.consumerPlans.set(consumerId, { versionId: store.plans[0].versionId, assignedAt: new Date().toISOString(), revision: 1 })
  store.grants.set(consumerId, ['xiaohongshu'])
  await store.createApiKey({ id: keyId, tenantId, consumerId, name: 'Renamed original key',
    digest: 'a'.repeat(64), prefix: 'synthetic', lastFour: 'test', environment: 'live', expiresAt: '2099-01-01T00:00:00.000Z',
    platformEntitlements: [{ platform: 'xiaohongshu', maxRequests: 1, windowSeconds: 3600, maxPageSize: 100 }], capabilityEntitlements: [] })
  store.apiKeys.get(keyId).accessProfile = 'managed_full'
  return store
}

test('legacy is preserved until an explicit audited CAS switch; auth reflects state without changing Key identity or scopes', async () => {
  const store = await memoryFixture()
  const before = await store.findApiKeyById(keyId)
  // Supplier admission is additive: legacy rows read as the original bypass.
  assert.deepEqual(await readKeyHubLimits(store, keyId), { apiKeyId: keyId, policyVersion: 2, hubRateLimitExempt: null,
    effectiveExempt: false, hubSupplierAdmission: 'bypass', effectiveSupplierPriority: false,
    inheritedQuotaExempt: true, source: 'legacy', revision: 0, updatedAt: null })
  assert.equal(store.keyHubLimitEvents, undefined)
  const saved = await saveKeyHubLimits(store, keyId, body(true), actor())
  assert.equal(saved.effectiveExempt, true)
  assert.equal(saved.source, 'explicit')
  assert.equal(saved.revision, 1)
  assert.equal((await store.findApiKeyByDigest('a'.repeat(64))).apiKey.hubRateLimitExempt, true)
  await assert.rejects(saveKeyHubLimits(store, keyId, body(false), actor()), { code: 'api_key_hub_limits_changed' })
  const disabled = await saveKeyHubLimits(store, keyId, body(false, 1), actor())
  assert.equal(disabled.effectiveExempt, false)
  assert.equal(disabled.inheritedQuotaExempt, false)
  const after = await store.findApiKeyById(keyId)
  for (const field of ['id', 'tenantId', 'consumerId', 'expiresAt', 'accessProfile', 'scopeMode', 'platforms', 'capabilities', 'status']) {
    assert.deepEqual(after.apiKey[field], before.apiKey[field])
  }
  assert.equal(store.keyHubLimitEvents.length, 2)
  assert.deepEqual(store.keyHubLimitEvents.map(row => [row.previousExempt, row.nextExempt]), [[null, true], [true, false]])
  assert.doesNotMatch(JSON.stringify(store.keyHubLimitEvents), /key_digest|digest|synthetic/)
})

test('only exact original identity can save; names, sibling keys, inactive identities and arbitrary flags cannot grant exemption', async () => {
  const store = await memoryFixture()
  const siblingId = randomUUID()
  store.apiKeys.set(siblingId, { ...store.apiKeys.get(keyId), id: siblingId, name: 'LCY-delta' })
  for (const method of [() => readKeyHubLimits(store, siblingId), () => saveKeyHubLimits(store, siblingId, body(true), actor())]) {
    await assert.rejects(method, { code: 'api_key_hub_limits_not_supported' })
  }
  await assert.rejects(saveKeyHubLimits(store, keyId, body(true), { ...actor(), actor: 'launcher-user' }), { code: 'admin_token_required' })
  for (const invalid of [{ ...body(true), internal: true }, body(null), body('true'), body(true, -1), { ...body(true), reason: '' }, { ...body(true), reason: 'x'.repeat(501) }]) {
    await assert.rejects(saveKeyHubLimits(store, keyId, invalid, actor()), { code: 'invalid_key_hub_limits' })
  }
  const key = store.apiKeys.get(keyId)
  for (const [field, changed] of [['tenantId', randomUUID()], ['consumerId', randomUUID()]]) {
    const old = key[field]; key[field] = changed
    await assert.rejects(saveKeyHubLimits(store, keyId, body(true), actor()), { code: 'api_key_hub_limits_not_supported' })
    key[field] = old
  }
  for (const [field, changed] of [['status', 'revoked'], ['environment', 'test'], ['expiresAt', '2000-01-01']]) {
    const old = key[field]; key[field] = changed
    await assert.rejects(saveKeyHubLimits(store, keyId, body(true), actor()), { code: 'api_key_unavailable' })
    key[field] = old
  }
  store.tenants.get(tenantId).status = 'suspended'
  await assert.rejects(saveKeyHubLimits(store, keyId, body(true), actor()), { code: 'identity_inactive' })
  assert.equal(store.keyHubLimitEvents, undefined)
  const service = new HubService({ store, adapter: {}, apiKeyPepper: 'synthetic-pepper-with-enough-characters' })
  await assert.rejects(service.createApiKey({ consumerId, name: 'Spoof', hubRateLimitExempt: true }), { code: 'unsupported_fields' })
})

test('memory quota reservation uses current stored switch, preserves counts, auth, unknown/idempotency and billing guards', async () => {
  const store = await memoryFixture()
  const first = reservation()
  await store.reserve(first)
  await saveKeyHubLimits(store, keyId, body(false), actor())
  await assert.rejects(store.reserve(reservation({ hubRateLimitExempt: true, managedQuotaExempt: true, accessProfile: 'managed_full' })), { code: 'consumer_quota_exceeded' })
  assert.equal((await store.quotaSnapshot({ tenantId, consumerId, apiKeyId: keyId }))[0].binding.remaining, 0)
  await saveKeyHubLimits(store, keyId, body(true, 1), actor())
  assert.equal((await store.reserve(reservation())).kind, 'reserved')
  assert.equal((await store.reserve(first)).kind, 'in_progress')
  store.requests.get(first.requestId).status = 'unknown'
  assert.equal((await store.reserve(first)).kind, 'unknown')
  assert.equal((await store.reserve({ ...first, fingerprint: 'b'.repeat(64) })).kind, 'conflict')
  assert.equal((await store.quotaSnapshot({ tenantId, consumerId, apiKeyId: keyId }))[0].binding.exempt, true)
  await assert.rejects(store.reserve(reservation({ platform: 'weibo' })), { code: 'api_key_scope_not_granted' })
  const plan = store.plans.find(row => row.versionId === store.consumerPlans.get(consumerId).versionId)
  plan.status = 'retired'
  await assert.rejects(store.reserve(reservation()), { code: 'plan_assignment_unavailable' })
  plan.status = 'active'
  store.billingProfiles.set(tenantId, { mode: 'enforced', multiplierPpm: 1000000, defaultUnitPriceMinor: 1, defaultCurrency: 'CNY' })
  await assert.rejects(store.reserve(reservation()), { code: 'insufficient_credit' })
})

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
async function postgresFixture(t) {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite(); t.after(() => db.close())
  await db.exec(`CREATE SCHEMA control;
    CREATE TABLE tenants(id uuid PRIMARY KEY,status text);
    CREATE TABLE consumers(id uuid PRIMARY KEY,tenant_id uuid,status text);
    CREATE TABLE api_keys(id uuid PRIMARY KEY,tenant_id uuid,consumer_id uuid,name text,status text,environment text,
      key_digest text,last_used_at timestamptz,created_at timestamptz DEFAULT now(),scope_mode text DEFAULT 'snapshot',access_profile text DEFAULT 'managed_full',expires_at timestamptz);
    CREATE TABLE platform_grants(consumer_id uuid,platform text);
    CREATE TABLE capability_grants(consumer_id uuid,capability text);
    CREATE TABLE api_key_platform_entitlements(api_key_id uuid,platform text,max_requests int,window_seconds int,max_page_size int,created_at timestamptz DEFAULT now());
    CREATE TABLE api_key_capability_entitlements(api_key_id uuid,capability text,max_requests int,window_seconds int,created_at timestamptz DEFAULT now());
    CREATE TABLE consumer_platform_policies(consumer_id uuid,platform text,max_requests int,window_seconds int,max_page_size int,updated_at timestamptz DEFAULT now());
    CREATE TABLE consumer_capability_policies(consumer_id uuid,capability text,max_requests int,window_seconds int,created_at timestamptz DEFAULT now());
    CREATE TABLE usage_requests(id uuid PRIMARY KEY,tenant_id uuid,consumer_id uuid,api_key_id uuid,idempotency_key text,fingerprint text,
      platform text,capability text,billing_meter_key text,authorization_scopes jsonb,status text,units_reserved int,lease_expires_at timestamptz,
      acquisition_request jsonb,reserved_at timestamptz,completed_at timestamptz,response_status int,response_body jsonb,error_code text);
    CREATE TABLE usage_idempotency_bindings(tenant_id uuid,consumer_id uuid,idempotency_key text,api_key_id uuid,fingerprint text,current_request_id uuid,updated_at timestamptz);
    CREATE TABLE usage_request_authorization_scopes(usage_request_id uuid,scope_type text,scope_key text);
    CREATE TABLE plans(id uuid PRIMARY KEY,plan_key text,status text);
    CREATE TABLE plan_versions(id uuid PRIMARY KEY,plan_id uuid,status text,limits jsonb);
    CREATE TABLE consumer_plan_assignments(consumer_id uuid,plan_version_id uuid,assigned_at timestamptz);`)
  for (const name of ['083_key_access_limits.sql', '138_admission_recovery.sql', '153_api_key_hub_limits.sql', '172_api_key_supplier_priority.sql']) {
    await db.exec(await readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'))
  }
  await db.query("INSERT INTO tenants VALUES($1,'active')", [tenantId])
  await db.query("INSERT INTO consumers VALUES($1,$2,'active')", [consumerId, tenantId])
  await db.query("INSERT INTO api_keys(id,tenant_id,consumer_id,name,status,environment,key_digest,expires_at) VALUES($1,$2,$3,'Renamed original','active','live',$4,'2099-01-01')", [keyId, tenantId, consumerId, 'a'.repeat(64)])
  await db.query("INSERT INTO platform_grants VALUES($1,'xiaohongshu')", [consumerId])
  await db.query("INSERT INTO api_key_platform_entitlements(api_key_id,platform,max_requests,window_seconds,max_page_size) VALUES($1,'xiaohongshu',1,3600,100)", [keyId])
  await db.query("INSERT INTO consumer_platform_policies(consumer_id,platform,max_requests,window_seconds,max_page_size) VALUES($1,'xiaohongshu',1,3600,100)", [consumerId])
  const planId = randomUUID(), versionId = randomUUID()
  await db.query("INSERT INTO plans VALUES($1,'fixture','active')", [planId])
  await db.query("INSERT INTO plan_versions VALUES($1,$2,'published','{\"maxRequests\":1,\"windowSeconds\":3600,\"monthlyRequests\":1,\"burstRps\":1}')", [versionId, planId])
  await db.query('INSERT INTO consumer_plan_assignments VALUES($1,$2,now())', [consumerId, versionId])
  const query = async (...args) => { const result = await db.query(...args); return { ...result, rowCount: result.rows.length || result.affectedRows } }
  const pool = { query, async connect() { return { query, release() {} } } }
  return { db, store: new PostgresStore(pool, { internalTraffic: { keyIds: [keyId] } }), pool }
}

test('PostgreSQL migration leaves state unchanged; CAS/audit are atomic, immutable and survive store recreation', { skip: !modulePath }, async t => {
  const { db, store, pool } = await postgresFixture(t)
  assert.equal((await readKeyHubLimits(store, keyId)).hubRateLimitExempt, null)
  const before = (await db.query('SELECT id,tenant_id,consumer_id,key_digest,status,environment,access_profile FROM api_keys')).rows
  const saved = await saveKeyHubLimits(store, keyId, body(true), actor())
  assert.equal(saved.revision, 1)
  assert.equal((await new PostgresStore(pool).findApiKeyById(keyId)).apiKey.hubRateLimitExempt, true)
  await assert.rejects(saveKeyHubLimits(store, keyId, body(false), actor()), { code: 'api_key_hub_limits_changed' })
  assert.equal((await db.query('SELECT count(*)::int AS count FROM control.api_key_hub_limit_events')).rows[0].count, 1)
  await assert.rejects(db.query("UPDATE control.api_key_hub_limit_events SET reason='changed'"), /immutable/)
  await assert.rejects(db.query('DELETE FROM control.api_key_hub_limit_events'), /immutable/)
  await db.exec(`CREATE FUNCTION control.reject_fixture_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture audit failure'; END$$;
    CREATE TRIGGER reject_fixture_audit BEFORE INSERT ON control.api_key_hub_limit_events FOR EACH ROW EXECUTE FUNCTION control.reject_fixture_audit();`)
  await assert.rejects(saveKeyHubLimits(store, keyId, body(false, 1), actor()), /fixture audit failure/)
  assert.equal((await readKeyHubLimits(store, keyId)).revision, 1)
  assert.equal((await readKeyHubLimits(store, keyId)).effectiveExempt, true)
  assert.deepEqual((await db.query('SELECT id,tenant_id,consumer_id,key_digest,status,environment,access_profile FROM api_keys')).rows, before)
  const sibling = randomUUID()
  await assert.rejects(db.query("INSERT INTO api_keys(id,tenant_id,consumer_id,hub_rate_limit_exempt) VALUES($1,$2,$3,true)", [sibling, tenantId, consumerId]), /api_key_hub_limit_identity/)
  // 172: the supplier mode defaults to bypass, persists with CAS/audit, and is LCY-only.
  await db.exec('DROP TRIGGER reject_fixture_audit ON control.api_key_hub_limit_events')
  assert.equal((await readKeyHubLimits(store, keyId)).hubSupplierAdmission, 'bypass')
  const priority = await saveKeyHubLimits(store, keyId, { ...body(true, 1), hubSupplierAdmission: 'priority' }, actor())
  assert.deepEqual([priority.hubSupplierAdmission, priority.effectiveSupplierPriority], ['priority', true])
  assert.equal((await new PostgresStore(pool).findApiKeyById(keyId)).apiKey.hubSupplierAdmission, 'priority')
  assert.deepEqual((await db.query(`SELECT previous_supplier_admission AS previous, next_supplier_admission AS next
    FROM control.api_key_hub_limit_events ORDER BY revision`)).rows, [{ previous: 'bypass', next: 'bypass' }, { previous: 'bypass', next: 'priority' }])
  await assert.rejects(db.query("INSERT INTO api_keys(id,tenant_id,consumer_id,hub_supplier_admission) VALUES($1,$2,$3,'priority')", [sibling, tenantId, consumerId]), /api_key_hub_supplier_admission_identity/)
  await assert.rejects(db.query("UPDATE api_keys SET hub_supplier_admission='fast' WHERE id=$1", [keyId]), /check constraint/)
})

test('PostgreSQL reservations read locked stored override, never input flags; explicit off restores ordinary quotas without resetting history', { skip: !modulePath }, async t => {
  const { db, store } = await postgresFixture(t)
  const first = reservation()
  await store.reserve(first)
  await saveKeyHubLimits(store, keyId, body(false), actor())
  await assert.rejects(store.reserve(reservation({ hubRateLimitExempt: true, managedQuotaExempt: true })), { code: 'consumer_quota_exceeded' })
  assert.equal((await store.quotaSnapshot({ tenantId, consumerId, apiKeyId: keyId }))[0].binding.remaining, 0)
  await saveKeyHubLimits(store, keyId, body(true, 1), actor())
  assert.equal((await store.reserve(reservation())).kind, 'reserved')
  assert.equal((await store.reserve(first)).kind, 'in_progress')
  await db.query("UPDATE usage_requests SET status='unknown' WHERE id=$1", [first.requestId])
  assert.equal((await store.reserve(first)).kind, 'unknown')
  assert.equal((await store.quotaSnapshot({ tenantId, consumerId, apiKeyId: keyId }))[0].binding.exempt, true)
  await saveKeyHubLimits(store, keyId, body(false, 2), actor())
  await assert.rejects(store.reserve(reservation()), { code: 'consumer_quota_exceeded' })
  assert.equal((await db.query('SELECT count(*)::int AS count FROM usage_requests')).rows[0].count, 2)
  await saveKeyHubLimits(store, keyId, body(true, 3), actor())
  await assert.rejects(store.reserve(reservation({ platform: 'weibo' })), { code: 'api_key_scope_not_granted' })
  await db.query("UPDATE plans SET status='retired'")
  await assert.rejects(store.reserve(reservation()), { code: 'plan_assignment_unavailable' })
})
