import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import pg from 'pg'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { createApp } from '../../server/app.mjs'
import { normalizeBillingProfile } from '../../server/billing/contracts.mjs'

async function fixture(store = new MemoryStore()) {
  const service = new HubService({ store, adapter: {}, apiKeyPepper: 'tenant-default-price-tests-pepper-at-least-32' })
  const tenant = await service.createTenant({ name: `Default price ${randomUUID()}` })
  async function caller() {
    const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Caller' })
    await service.putPlatformConfiguration('weibo', { tenantId: tenant.id, consumerId: consumer.id, enabled: true, maxRequests: 1000, maxPageSize: 100 })
    const key = await service.createApiKey({ consumerId: consumer.id, name: 'Original key', platforms: ['weibo'], capabilities: [] })
    return { consumer, key, context: await service.authenticate(key.secret) }
  }
  const first = await caller(), second = await caller()
  const setPrice = async (price, mode = 'enforced', multiplierPpm = null) => service.setTenantBillingProfile(tenant.id, {
    mode, multiplierPpm, defaultUnitPriceMinor: price, defaultCurrency: 'CNY',
    ...((await service.getTenantBilling(tenant.id)).profile.revision ? { expectedRevision: (await service.getTenantBilling(tenant.id)).profile.revision } : {}),
  }, 'test-admin')
  const credit = async (amountMinor = 1000) => service.addTenantCredit(tenant.id, { amountMinor, currency: 'CNY', reason: 'Isolated test credit' }, { actor: 'test', idempotencyKey: randomUUID() })
  return { store, service, tenant, first, second, setPrice, credit }
}
function request(caller, meterKey = 'weibo') {
  return { requestId: randomUUID(), idempotencyKey: randomUUID(), fingerprint: randomUUID().replaceAll('-', '').padEnd(64, '0'),
    tenantId: caller.context.tenant.id, consumerId: caller.consumer.id, apiKeyId: caller.key.id,
    platform: 'weibo', meterKey, unitsReserved: 1, maxRequests: 1000,
    windowStart: new Date(Date.now() - 3600000), leaseExpiresAt: new Date(Date.now() + 60000) }
}
const commit = (store, req) => store.commitRequest(req.requestId, { responseStatus: 200, responseBody: { data: { items: [] } }, unitsActual: 1 })
async function overridePlan(f, caller, price) {
  const suffix = randomUUID()
  const plan = await f.service.publishPlanVersion({ key: `plan-${suffix}`, name: 'Explicit exception', limits: { monthlyRequests: 1000, maxPageSize: 100 },
    priceBook: { key: `rates-${suffix}`, currency: 'CNY', defaultMultiplierPpm: 2_000_000, entries: [{ meterKey: 'weibo', unitPriceMinor: price }] } }, 'test')
  await f.service.assignConsumerPlan(caller.consumer.id, { planVersionId: plan.versionId, expectedRevision: (await f.service.getConsumerPlan(caller.consumer.id)).revision }, 'test')
  return plan
}
async function exercise(f) {
  const before = await f.service.getConsumerPlan(f.first.consumer.id)
  assert.equal((await f.service.getTenantBilling(f.tenant.id)).profile.defaultUnitPriceMinor, 0)
  await f.setPrice(0)
  const free = request(f.first)
  await f.store.reserve(free); await commit(f.store, free)
  assert.equal((await f.service.getTenantBilling(f.tenant.id)).account, null)
  await f.setPrice(10, 'enforced', 3_000_000)
  await assert.rejects(f.store.reserve(request(f.first)), { code: 'insufficient_credit' })
  await f.credit()
  // No priced plan required; existing and newly used callers inherit the same price.
  const one = request(f.first), two = request(f.second)
  await f.store.reserve(one); await f.store.reserve(two)
  assert.equal((await f.service.getTenantBilling(f.tenant.id)).account.heldMinor, 20)
  assert.equal((await f.store.reserve(one)).kind, 'in_progress')
  // Save via an older client which omits default price: preserve it.
  const profile = (await f.service.getTenantBilling(f.tenant.id)).profile
  await f.service.setTenantBillingProfile(f.tenant.id, { mode: 'enforced', multiplierPpm: null, expectedRevision: profile.revision }, 'old-client')
  assert.equal((await f.service.getTenantBilling(f.tenant.id)).profile.defaultUnitPriceMinor, 10)
  await f.setPrice(20)
  await commit(f.store, one); await f.store.releaseRequest(two.requestId, 'definitive_failure')
  assert.equal((await f.store.reserve(one)).kind, 'replay')
  assert.equal((await f.service.getTenantBilling(f.tenant.id)).account.availableMinor, 990)
  const pending = request(f.first)
  await f.store.reserve(pending); await f.store.markRequestUnknown(pending.requestId, 'outcome_unknown')
  assert.equal((await f.service.getTenantBilling(f.tenant.id)).account.heldMinor, 20)
  await f.service.reconcileUnknownCustomerCharge(pending.requestId, { disposition: 'release', reason: 'Test confirms no delivery' }, { actor: 'test', idempotencyKey: randomUUID() })
  await overridePlan(f, f.first, 0)
  const explicitFree = request(f.first); await f.store.reserve(explicitFree); await commit(f.store, explicitFree)
  assert.equal((await f.service.getTenantBilling(f.tenant.id)).account.availableMinor, 990)
  await overridePlan(f, f.first, 15)
  const exception = request(f.first); await f.store.reserve(exception); await commit(f.store, exception)
  assert.equal((await f.service.getTenantBilling(f.tenant.id)).account.availableMinor, 960, 'plan override retains its original 2x multiplier')
  const noOverride = request(f.first, 'other.meter'); await f.store.reserve(noOverride); await commit(f.store, noOverride)
  assert.equal((await f.service.getTenantBilling(f.tenant.id)).account.availableMinor, 940, 'fallback ignores a consumer plan multiplier')
  await f.setPrice(0)
  const defaultFree = request(f.second); await f.store.reserve(defaultFree); await commit(f.store, defaultFree)
  assert.equal((await f.service.getTenantBilling(f.tenant.id)).account.availableMinor, 940)
  const oldPaid = request(f.first); await f.store.reserve(oldPaid); await commit(f.store, oldPaid)
  assert.equal((await f.service.getTenantBilling(f.tenant.id)).account.availableMinor, 910, 'zero fallback does not overwrite existing explicit prices')
  assert.equal((await f.service.authenticate(f.first.key.secret)).apiKey.id, f.first.key.id)
  assert.deepEqual((await f.service.getConsumerPlan(f.second.consumer.id)).versionId, before.versionId)
  await assert.rejects(f.store.reserve({ ...request(f.second), platform: 'bilibili' }), error => error.status === 403)
}

test('tenant default and exact zero/paid overrides preserve legacy keys, accounting and retries', async () => exercise(await fixture()))

test('shadow/default disabled, preview and revision/currency validation', async () => {
  const f = await fixture()
  await f.credit()
  await f.setPrice(10, 'shadow')
  const req = request(f.first); await f.store.reserve(req); await commit(f.store, req)
  assert.equal(f.store.customerCharges.get(req.requestId).quotedMinor, 10)
  assert.equal((await f.service.getTenantBilling(f.tenant.id)).account.availableMinor, 1000)
  await f.setPrice(10, 'disabled')
  const disabled = request(f.first); await f.store.reserve(disabled); await commit(f.store, disabled)
  assert.equal(f.store.customerCharges.has(disabled.requestId), false)
  await f.setPrice(10)
  const preview = await f.service.aggregatePreview(f.first.context, { query: 'test' })
  assert.equal(preview.estimatedMinor, 10)
  assert.equal(preview.items[0].priceStatus, 'tenant_default')
  assert.equal(preview.parentChargeMinor, 0)
  const parent = { ...request(f.first), platform: null, capability: 'data.canonical-search', meterKey: 'data.aggregate.refresh', authorizationPlatforms: ['weibo'] }
  await f.store.reserve(parent)
  assert.equal(f.store.customerCharges.has(parent.requestId), false, 'positive default cannot charge the live aggregate parent')
  const profile = (await f.service.getTenantBilling(f.tenant.id)).profile
  await assert.rejects(f.service.setTenantBillingProfile(f.tenant.id, { mode: 'enforced', expectedRevision: profile.revision - 1, defaultUnitPriceMinor: 20 }, 'test'), { code: 'billing_profile_revision_conflict' })
  await assert.rejects(f.service.setTenantBillingProfile(f.tenant.id, { mode: 'enforced', expectedRevision: profile.revision, defaultUnitPriceMinor: 10, defaultCurrency: 'USD' }, 'test'), { code: 'wallet_currency_conflict' })
  for (const value of [-1, null, 0.1, '10', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => normalizeBillingProfile({ mode: 'enforced', defaultUnitPriceMinor: value }))
})

test('billing HTTP writes stay admin-only and defaults are readable customer prices', async t => {
  const f = await fixture()
  const server = createServer(createApp({ service: f.service, store: f.store, adminToken: 'local-test-admin', logger: { error() {} } }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/internal/v1/admin/tenants/${f.tenant.id}/billing`
  const body = JSON.stringify({ mode: 'enforced', defaultUnitPriceMinor: 10, defaultCurrency: 'CNY' })
  assert.equal((await fetch(url + '/profile', { method: 'PUT', headers: { 'content-type': 'application/json' }, body })).status, 401)
  const response = await fetch(url + '/profile', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-mx-insight-admin-token': 'local-test-admin' }, body })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).data.defaultUnitPriceMinor, 10)
  assert.equal((await f.service.getConsumerPlan(f.first.consumer.id)).priceBook ?? null, null)
})

test('PostgreSQL tenant fallback snapshots, zero overrides and immutable ledger', {
  skip: process.env.MX_INSIGHT_TEST_DATABASE_URL ? false : 'Requires isolated PostgreSQL with migrations through 105',
}, async () => {
  const pool = new pg.Pool({ connectionString: process.env.MX_INSIGHT_TEST_DATABASE_URL, statement_timeout: 10000 })
  try {
    const f = await fixture(new PostgresStore(pool))
    await exercise(f)
    const { rows } = await pool.query("SELECT * FROM billing.customer_charges WHERE tenant_id=$1 AND pricing_snapshot->>'priceSource'='tenant_default' ORDER BY created_at", [f.tenant.id])
    assert.equal(Number(rows[0].unit_price_minor), 10)
    assert.equal(Number(rows[0].charged_minor), 10)
    assert.equal(rows[0].price_book_id, null)
    assert.ok(rows[0].pricing_snapshot.billingProfileRevision > 0)
    await assert.rejects(pool.query('UPDATE billing.customer_charges SET unit_price_minor=1 WHERE id=$1', [rows[0].id]), { code: '55000' })
    const concurrent = await fixture(new PostgresStore(pool))
    await concurrent.setPrice(10)
    await concurrent.credit(30)
    const attempts = Array.from({ length: 8 }, () => request(concurrent.first))
    const results = await Promise.allSettled(attempts.map(input => concurrent.store.reserve(input)))
    assert.equal(results.filter(row => row.status === 'fulfilled').length, 3)
    assert.ok(results.filter(row => row.status === 'rejected').every(row => row.reason.code === 'insufficient_credit'))
    assert.equal((await concurrent.service.getTenantBilling(concurrent.tenant.id)).account.availableMinor, 0)
    assert.equal((await concurrent.service.getTenantBilling(concurrent.tenant.id)).account.heldMinor, 30)
    await f.setPrice(10)
    const parent = { ...request(f.second), platform: null, capability: 'data.canonical-search', meterKey: 'data.aggregate.refresh', authorizationPlatforms: ['weibo'] }
    await f.store.reserve(parent)
    assert.equal((await pool.query('SELECT id FROM billing.customer_charges WHERE usage_request_id=$1', [parent.requestId])).rowCount, 0)
  } finally { await pool.end() }
})
