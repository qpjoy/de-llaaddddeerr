import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { createApp } from '../../server/app.mjs'
import { AdmissionPolicyStore } from '../../server/external-platforms/admission-policy.mjs'

const defaults = { maxConcurrency: 10, maxConsumerConcurrency: 10, maxRequestsPerMinute: 30, maxWaitMs: 5000, maxPending: 64 }
const options = () => ({ defaultsByProvider: { qixin: { ...defaults }, tikhub: { ...defaults, maxRequestsPerMinute: 50 } } })
const actor = () => ({ actor: 'admin-token', requestId: randomUUID() })
const body = (expectedRevision = 0, changes = {}) => ({ expectedRevision, reason: 'Reviewed provider capacity', limits: { ...defaults, maxRequestsPerMinute: 60, ...changes } })

test('admission policy reads inherit without writes; saved settings are provider-scoped, audited and CAS protected', async () => {
  const store = new AdmissionPolicyStore(options())
  const inherited = await store.read('qixin')
  assert.deepEqual(inherited, { providerKey: 'qixin', source: 'deployment', revision: 0, limits: defaults,
    defaults, updatedAt: null, scope: { rate: 'provider_shared', concurrency: 'gateway_instance' } })
  inherited.limits.maxConcurrency = 200
  inherited.defaults.maxConcurrency = 200
  assert.equal((await store.resolve('qixin')).maxConcurrency, 10)
  assert.equal(store.rows.size, 0)
  assert.equal(store.events.length, 0)
  const competing = await Promise.allSettled([store.save('qixin', body(), actor()), store.save('qixin', body(0, { maxRequestsPerMinute: 90 }), actor())])
  assert.equal(competing.filter(row => row.status === 'fulfilled').length, 1)
  assert.equal(competing.find(row => row.status === 'rejected').reason.code, 'external_admission_policy_changed')
  assert.equal((await store.read('qixin')).source, 'database')
  assert.equal((await store.resolve('qixin')).maxRequestsPerMinute, 60)
  assert.equal((await store.resolve('qixin')).revision, 1)
  assert.equal((await store.read('tikhub')).source, 'deployment')
  assert.equal((await store.resolve('tikhub')).maxRequestsPerMinute, 50)
  assert.equal(store.events.length, 1)
  assert.deepEqual(store.events[0].previousLimits, defaults)
  assert.equal(store.events[0].previousSource, 'deployment')
  await store.save('qixin', body(1, { maxRequestsPerMinute: 30 }), actor())
  assert.equal((await store.read('qixin')).source, 'database')
  assert.equal(store.events[1].previousSource, 'database')
})

test('admission policy rejects unknown fields, unsupported providers, invalid ranges and non-admin changes', async () => {
  const store = new AdmissionPolicyStore(options())
  for (const input of [null, [], { ...body(), desiredState: 'active' }, { ...body(), priceBook: {} },
    { ...body(), hubRateLimitExempt: true }, { ...body(), reason: '' }, { ...body(), reason: 'x'.repeat(1001) },
    { ...body(), expectedRevision: '0' }, { ...body(), expectedRevision: -1 }, { ...body(), expectedRevision: 2147483647 },
    { ...body(), limits: {} }, body(0, { rateLimitBurst: 20 }), body(0, { maxConcurrency: 0 }),
    body(0, { maxConsumerConcurrency: 11 }), body(0, { maxRequestsPerMinute: 60001 }),
    body(0, { maxWaitMs: 60001 }), body(0, { maxPending: 257 }), body(0, { maxPending: 2.5 })]) {
    await assert.rejects(store.save('qixin', input, actor()), { code: 'invalid_external_admission_policy' })
  }
  await assert.rejects(store.save('qixin', body(), { ...actor(), actor: 'launcher-user' }), { code: 'admin_token_required' })
  await assert.rejects(store.save('qixin', body(), { actor: 'admin-token' }), { code: 'invalid_external_admission_policy' })
  for (const provider of ['missing', '__proto__', 'constructor']) {
    await assert.rejects(store.read(provider), { code: 'external_admission_provider_not_found' })
    await assert.rejects(store.save(provider, body(), actor()), { code: 'external_admission_provider_not_found' })
  }
  assert.equal(store.events.length, 0)
})

test('admission policy storage outage or malformed stored limits fail closed instead of restoring deployment defaults', async () => {
  const store = new AdmissionPolicyStore({ ...options(), pool: { async query() { throw new Error('database unavailable') }, async connect() { throw new Error('connection unavailable') } } })
  await assert.rejects(store.read('qixin'), { status: 503, code: 'external_admission_policy_unavailable' })
  await assert.rejects(store.resolve('qixin'), { status: 503, code: 'external_admission_policy_unavailable' })
  await assert.rejects(store.save('qixin', body(), actor()), { status: 503, code: 'external_admission_policy_unavailable' })
  const broken = new AdmissionPolicyStore({ ...options(), pool: { async query() { return { rows: [{ revision: 1, max_concurrency: 0 }] } } } })
  await assert.rejects(broken.resolve('qixin'), { code: 'external_admission_policy_unavailable' })
})

test('existing high deployment ceilings remain readable while explicit database writes obey the editor bounds', async () => {
  const legacy = { maxConcurrency: 512, maxConsumerConcurrency: 1024, maxRequestsPerMinute: 120000,
    maxWaitMs: 120000, maxPending: 512 }
  const store = new AdmissionPolicyStore({ defaultsByProvider: { tikhub: legacy } })
  assert.deepEqual((await store.read('tikhub')).limits, legacy)
  assert.equal(store.events.length, 0)
  await assert.rejects(store.save('tikhub', { ...body(), limits: legacy }, actor()), { code: 'invalid_external_admission_policy' })
  const saved = await store.save('tikhub', body(), actor())
  assert.deepEqual(saved.defaults, legacy)
  assert.deepEqual(saved.limits, body().limits)
  assert.deepEqual(store.events[0].previousLimits, legacy)
})

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
test('PostgreSQL admission policies persist across instances, preserve counters, and roll back when the immutable audit cannot be written', { skip: !modulePath }, async t => {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite(); t.after(() => db.close())
  await db.exec(`CREATE SCHEMA control;
    CREATE SCHEMA external_platform;
    CREATE TABLE external_platform.provider_rate_buckets(provider_key text PRIMARY KEY,tokens numeric);
    INSERT INTO external_platform.provider_rate_buckets VALUES ('qixin',3);
    CREATE TABLE control.external_platform_operation_policies(provider_key text,desired_state text);
    INSERT INTO control.external_platform_operation_policies VALUES ('qixin','paused');`)
  await db.exec(await readFile(new URL('../../migrations/154_external_platform_admission_policy.sql', import.meta.url), 'utf8'))
  const query = (...args) => db.query(...args)
  const pool = { query, async connect() { return { query, release() {} } } }
  const first = new AdmissionPolicyStore({ ...options(), pool })
  const second = new AdmissionPolicyStore({ ...options(), pool })
  assert.equal((await first.read('qixin')).source, 'deployment')
  assert.equal((await db.query('SELECT count(*)::int AS count FROM control.external_platform_admission_policies')).rows[0].count, 0)
  assert.equal((await first.save('qixin', body(), actor())).revision, 1)
  assert.equal((await second.resolve('qixin')).maxRequestsPerMinute, 60)
  await assert.rejects(second.save('qixin', body(), actor()), { code: 'external_admission_policy_changed' })
  await second.save('qixin', body(1, { maxConcurrency: 20, maxConsumerConcurrency: 12 }), actor())
  assert.equal((await first.resolve('qixin')).maxConsumerConcurrency, 12)
  assert.equal((await first.resolve('qixin')).revision, 2)
  assert.equal((await db.query('SELECT count(*)::int AS count FROM control.external_platform_admission_policy_events')).rows[0].count, 2)
  await assert.rejects(db.query("UPDATE control.external_platform_admission_policy_events SET reason='changed'"), /immutable/)
  await assert.rejects(db.query('DELETE FROM control.external_platform_admission_policy_events'), /immutable/)
  await db.exec(`CREATE FUNCTION control.reject_admission_fixture_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture audit failure'; END$$;
    CREATE TRIGGER reject_admission_fixture_audit BEFORE INSERT ON control.external_platform_admission_policy_events
    FOR EACH ROW EXECUTE FUNCTION control.reject_admission_fixture_audit();`)
  await assert.rejects(first.save('qixin', body(2, { maxRequestsPerMinute: 90 }), actor()), { code: 'external_admission_policy_unavailable' })
  assert.equal((await first.resolve('qixin')).revision, 2)
  assert.equal((await first.resolve('qixin')).maxRequestsPerMinute, 60)
  assert.equal((await db.query('SELECT tokens::int AS tokens FROM external_platform.provider_rate_buckets')).rows[0].tokens, 3)
  assert.equal((await db.query('SELECT desired_state FROM control.external_platform_operation_policies')).rows[0].desired_state, 'paused')
  await assert.rejects(db.query("UPDATE control.external_platform_admission_policies SET max_consumer_concurrency=200 WHERE provider_key='qixin'"), /check constraint/)
})

test('admission policy HTTP requires Admin Token, remains private on Public, and rejects unauthorized or stale saves', async t => {
  const policies = new AdmissionPolicyStore(options())
  async function listen(listenerMode = 'combined', available = true) {
    const server = createServer(createApp({ service: {}, store: {}, adapter: {}, listenerMode,
      externalAdmissionPolicies: available ? policies : null, adminToken: 'local-admission-policy-admin', logger: { error() {} },
      identity: { enabled: true, async resolve(token) { return { kind: 'launcher-user', memberId: token,
        platformAdmin: token === 'platform-admin', capabilities: [], memberships: [], tenantIds: [] } } },
    }))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise(resolve => server.close(resolve)))
    return `http://127.0.0.1:${server.address().port}/internal/v1/admin/external-platforms/qixin/admission-policy`
  }
  const url = await listen(), publicUrl = await listen('public'), unavailable = await listen('combined', false)
  const headers = { 'x-mx-insight-admin-token': 'local-admission-policy-admin', 'content-type': 'application/json' }
  for (const method of ['GET', 'PUT']) {
    const extra = method === 'PUT' ? { body: JSON.stringify(body()) } : {}
    assert.equal((await fetch(url, { method, ...extra })).status, 401)
    for (const token of ['tenant-admin', 'platform-admin', 'mih_live_example']) {
      assert.equal((await fetch(url, { method, headers: { authorization: `Bearer ${token}` }, ...extra })).status, 403)
    }
    assert.equal((await fetch(publicUrl, { method, headers, ...extra })).status, 404)
    assert.equal((await fetch(unavailable, { method, headers, ...extra })).status, 503)
    assert.equal((await fetch(url + '?rate=90', { method, headers, ...extra })).status, 400)
  }
  assert.equal(policies.events.length, 0)
  const read = await fetch(url, { headers })
  assert.equal(read.status, 200)
  assert.match(read.headers.get('cache-control'), /no-store/)
  assert.equal((await read.json()).data.source, 'deployment')
  assert.equal(policies.events.length, 0)
  const invalid = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ ...body(), priceBook: {} }) })
  assert.equal(invalid.status, 400)
  const saved = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(body()) })
  assert.equal(saved.status, 200)
  assert.match(saved.headers.get('cache-control'), /no-store/)
  assert.equal((await saved.json()).data.revision, 1)
  assert.ok(policies.events[0].requestId)
  const stale = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(body()) })
  assert.equal(stale.status, 409)
  assert.match(stale.headers.get('cache-control'), /no-store/)
  assert.equal((await stale.json()).error.code, 'external_admission_policy_changed')
  assert.equal(policies.events.length, 1)
})
