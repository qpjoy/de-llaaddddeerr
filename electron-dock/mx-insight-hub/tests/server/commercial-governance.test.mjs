import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import pg from 'pg'
import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { providerPricingTemplate } from '../../server/external-platforms/pricing-template.mjs'
import { capabilityCatalog, catalogDifference, syncCapabilityCatalog } from '../../server/data/capability-catalog.mjs'
import { consumptionQuery, consumptionPage } from '../../server/billing/consumption.mjs'
import { PRODUCT_BUNDLES, withProductScopes } from '../../shared/product-catalog.mjs'

async function fixture(store = new MemoryStore()) {
  let calls = 0
  const service = new HubService({ store, apiKeyPepper: 'governance-regression-pepper-at-least-32', adapter: {
    search: async () => { calls++; return { payload: { data: { items: [{ id: 'result', title: 'Test' }], pageInfo: { hasMore: false } } }, raw: {} } },
  } })
  const tenant = await service.createTenant({ name: 'Existing customer' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Existing caller' })
  await service.putPlatformConfiguration('weibo', { tenantId: tenant.id, consumerId: consumer.id, enabled: true, maxPageSize: 50 })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Original live key', platforms: ['weibo'], capabilities: [] })
  const suffix = randomUUID()
  const plan = await service.publishPlanVersion({ key: `existing-${suffix}`, name: 'Existing contract', limits: { monthlyRequests: 1000, maxPageSize: 50 },
    priceBook: { key: `cny-${suffix}`, currency: 'CNY', entries: [{ meterKey: 'weibo', unitPriceMinor: 10 }, { meterKey: 'data.canonical-search', unitPriceMinor: 700 }] } }, 'test')
  await service.assignConsumerPlan(consumer.id, { planVersionId: plan.versionId, expectedRevision: (await service.getConsumerPlan(consumer.id)).revision }, 'test')
  await service.setTenantBillingProfile(tenant.id, { mode: 'enforced', multiplierPpm: 1200000 }, 'test')
  await service.addTenantCredit(tenant.id, { amountMinor: 10000, currency: 'CNY', reason: 'Fixture' }, { actor: 'test', idempotencyKey: randomUUID() })
  return { store, service, tenant, consumer, key, context: await service.authenticate(key.secret), calls: () => calls }
}

test('catalog sync only changes generated metadata and is idempotent; scopes are explicit subsets', async () => {
  const catalog = capabilityCatalog()
  assert.deepEqual(catalog.issues, [])
  assert.ok(catalog.entries.some(row => row.definition.operation === 'social.comments.list'))
  const persisted = new Map(), writes = []
  const db = { query: async (sql, values) => {
    if (sql.startsWith('SELECT')) return { rows: [...persisted.values()] }
    writes.push(sql)
    assert.match(sql, /control\.capability_inventory/)
    assert.doesNotMatch(sql, /\b(?:api_keys|consumers|tenant_billing_profiles|customer_price_books|credit_accounts|credit_ledger_entries)\b/)
    if (sql.startsWith('INSERT')) persisted.set(values[0], { id: values[0], hash: values[3], status: 'registered' })
    return { rows: [] }
  } }
  const dry = await syncCapabilityCatalog(db, { sources: [] })
  assert.equal(writes.length, 0)
  assert.equal(dry.differences.length, catalog.entries.length)
  await syncCapabilityCatalog(db, { sources: [], dryRun: false })
  assert.deepEqual((await syncCapabilityCatalog(db, { sources: [] })).differences, [])
  assert.equal(catalogDifference(catalog, [{ id: 'old', hash: 'old', status: 'registered' }]).at(-1).action, 'retire')
  const form = { platforms: ['weibo'], capabilities: ['old.scope'] }
  const next = withProductScopes(form, 'xiaohongshu', { platforms: ['xiaohongshu'], capabilities: ['social.comments.list'] })
  assert.deepEqual(next.capabilities, ['old.scope', 'social.comments.list'])
  assert.deepEqual(form, { platforms: ['weibo'], capabilities: ['old.scope'] })
  assert.equal(PRODUCT_BUNDLES[0].capabilities.length, 6)
  const pending = await syncCapabilityCatalog({ query: async () => { throw Object.assign(new Error('missing inventory'), { code: '42P01' }) } }, { sources: [] })
  assert.equal(pending.migrationRequired, true)
  assert.equal(pending.differences.length, catalog.entries.length)
})

test('read-only aggregate quote preserves existing account, key, price, grants and wallet; parent never adds canonical charge', async () => {
  const f = await fixture()
  const before = { plan: await f.service.getConsumerPlan(f.consumer.id), key: await f.service.authenticate(f.key.secret), wallet: await f.service.getTenantBilling(f.tenant.id) }
  const body = { query: '新闻', platforms: ['weibo'] }
  const preview = await f.service.aggregatePreview(f.context, body)
  assert.equal(preview.estimatedMinor, 12)
  assert.equal(preview.items[0].meterKey, 'weibo')
  assert.equal(preview.parentChargeMinor, 0)
  assert.equal(f.calls(), 0)
  assert.equal(f.store.requests.size, 0)
  assert.deepEqual(await f.service.getConsumerPlan(f.consumer.id), before.plan)
  assert.deepEqual(await f.service.getTenantBilling(f.tenant.id), before.wallet)
  const { lastUsedAt: _beforeUsed, ...originalKey } = before.key.apiKey
  const { lastUsedAt: _afterUsed, ...retainedKey } = (await f.service.authenticate(f.key.secret)).apiKey
  assert.deepEqual(retainedKey, originalKey)
  await assert.rejects(f.service.aggregatePreview(f.context, { ...body, platforms: ['xiaohongshu'] }), { code: 'platform_not_granted' })
  const request = { body, path: '/api/v1/data/aggregate/search', idempotencyKey: 'existing-key-aggregate' }
  const response = await f.service.aggregateSearch(f.context, request)
  await f.service.aggregateSearch(f.context, request)
  assert.equal(f.calls(), 1)
  assert.equal(f.store.customerCharges.has(response.requestId), false)
  assert.equal((await f.service.getTenantBilling(f.tenant.id)).account.availableMinor, 9988)
  const page = await f.service.listTenantConsumption(f.tenant.id, consumptionQuery({}, f.tenant.id))
  assert.equal(page.items.length, 1)
  assert.equal(page.items[0].chargedMinor, 12)
  assert.deepEqual(page.items[0].events.map(row => row.kind), ['hold', 'capture'])
  assert.equal(page.items[0].events[1].availableDeltaMinor, 0)
})

test('consumption pagination keeps complete charge events even when raw ledger limit splits them; cursors are tenant bound', async () => {
  const f = await fixture()
  for (let n = 0; n < 3; n++) await f.service.aggregateSearch(f.context, { body: { query: `新闻${n}` }, path: '/api/v1/data/aggregate/search', idempotencyKey: `paginate-query-${n}` })
  assert.equal((await f.service.getTenantBilling(f.tenant.id, { ledgerLimit: 1 })).ledger.length, 1)
  const seen = new Set(); let cursor
  do {
    const page = await f.service.listTenantConsumption(f.tenant.id, consumptionQuery({ limit: 1, ...(cursor ? { cursor } : {}) }, f.tenant.id))
    assert.equal(page.items[0].events.length, 2)
    assert.equal(seen.has(page.items[0].id), false)
    seen.add(page.items[0].id); cursor = page.pageInfo.nextCursor
    if (cursor) assert.throws(() => consumptionQuery({ cursor }, randomUUID()), { code: 'invalid_cursor' })
  } while (cursor)
  assert.equal(seen.size, 3)
  const other = await f.service.createTenant({ name: 'Other tenant' })
  assert.deepEqual((await f.service.listTenantConsumption(other.id, { limit: 20 })).items, [])
  const precise = '2026-09-23 04:00:00.123456+00'
  const row = { id: randomUUID(), createdAt: '2026-09-23T04:00:00.123Z', cursorTime: precise }
  const pgPage = consumptionPage([row, { ...row, id: randomUUID() }], f.tenant.id, 1)
  assert.equal(consumptionQuery({ cursor: pgPage.pageInfo.nextCursor }, f.tenant.id).before.createdAt, precise)
  assert.equal(Object.hasOwn(pgPage.items[0], 'cursorTime'), false)
})

test('procurement template preserves independent rates and pauses; previews are read-only and revision fenced', async () => {
  const store = new MemoryExternalPlatformControlStore()
  const runtime = { config: {}, credentialConfigured: true }
  const list = () => store.describeProvider('tikhub', runtime)
  let ops = await list()
  const target = ops.find(row => row.operationKey === 'social.posts.analytics')
  const input = { currency: 'USD', pricingAsOf: '2026-09-23', unitCostMinor: 2, monthlyBudgetMinor: 10000,
    monthlySubsidyBudgetMinor: 5000, operationKeys: [target.operationKey], reason: 'Reviewed contract', dryRun: true }
  const before = structuredClone(store.rows)
  let preview = await providerPricingTemplate(store, 'tikhub', ops, input, runtime)
  assert.deepEqual(store.rows, before)
  assert.equal(store.pricingTemplates, undefined)
  const result = await providerPricingTemplate(store, 'tikhub', ops, { ...input, dryRun: false, previewToken: preview.previewToken }, runtime)
  assert.equal(result.applied.length, 1)
  ops = await list()
  assert.equal(ops.find(row => row.operationKey === target.operationKey).desiredState, target.desiredState)
  const inheritedPreview = await providerPricingTemplate(store, 'tikhub', ops, { ...input, unitCostMinor: 3 }, runtime)
  assert.equal(inheritedPreview.rows[0].inherited, true)
  const inheritedResult = await providerPricingTemplate(store, 'tikhub', ops, { ...input, unitCostMinor: 3, dryRun: false, previewToken: inheritedPreview.previewToken }, runtime)
  assert.equal(inheritedResult.applied.length, 1)
  assert.equal(inheritedResult.templateVersion, 2)
  ops = await list()
  const manual = ops.find(row => row.operationKey === target.operationKey)
  await store.updatePolicy('tikhub', target.operationKey, { desiredState: 'paused', expectedRevision: manual.revision, reason: 'Manual exception', priceBook: {
    currency: 'USD', pricingAsOf: '2026-09-23', monthlyBudgetMinor: 9000, monthlySubsidyBudgetMinor: 3000,
    unitCostMinorByEndpoint: Object.fromEntries(manual.release.endpointKeys.map(key => [key, 7])),
  } }, { runtime })
  ops = await list()
  preview = await providerPricingTemplate(store, 'tikhub', ops, input, runtime)
  assert.equal(preview.rows[0].action, 'preserve')
  const preserved = await providerPricingTemplate(store, 'tikhub', ops, { ...input, dryRun: false, previewToken: preview.previewToken }, runtime)
  assert.equal(preserved.applied.length, 0)
  assert.ok(Object.values((await list()).find(row => row.operationKey === target.operationKey).priceBook.endpointPrices).every(value => value === 7))
  await assert.rejects(providerPricingTemplate(store, 'tikhub', ops, { ...input, unitCostMinor: 3, dryRun: false, previewToken: preview.previewToken }, runtime), { code: 'pricing_preview_changed' })
})

test('new read endpoints require correct identities and never dispatch a paid call', async t => {
  const f = await fixture()
  const server = createServer(createApp({ store: f.store, service: f.service, adminToken: 'governance-admin', logger: { error() {} } }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  assert.equal((await fetch(base + '/internal/v1/admin/capability-catalog')).status, 401)
  assert.equal((await fetch(base + '/internal/v1/admin/capability-catalog', { headers: { 'x-mx-insight-admin-token': 'governance-admin' } })).status, 200)
  const response = await fetch(base + '/api/v1/data/aggregate/preview', { method: 'POST', headers: { authorization: `Bearer ${f.key.secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ query: '新闻' }) })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).data.estimatedMinor, 12)
  assert.equal(f.calls(), 0)
  assert.equal(f.store.requests.size, 0)
})

test('PostgreSQL inventory sync preserves commercial state and live parent has no customer charge', {
  skip: process.env.MX_INSIGHT_TEST_DATABASE_URL ? false : 'MX_INSIGHT_TEST_DATABASE_URL is not configured (requires migrations through 104)',
}, async () => {
  const pool = new pg.Pool({ connectionString: process.env.MX_INSIGHT_TEST_DATABASE_URL, statement_timeout: 10000 })
  try {
    const f = await fixture(new PostgresStore(pool))
    const snapshot = async () => ({
      key: (await pool.query('SELECT * FROM api_keys WHERE id=$1', [f.key.id])).rows,
      plan: await f.service.getConsumerPlan(f.consumer.id), wallet: await f.service.getTenantBilling(f.tenant.id),
      grants: await f.store.listGrants(f.consumer.id),
    })
    const before = await snapshot()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await syncCapabilityCatalog(client, { dryRun: false })
      assert.deepEqual((await syncCapabilityCatalog(client)).differences, [])
      await client.query('ROLLBACK')
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
    assert.deepEqual(await snapshot(), before)
    assert.equal((await f.service.aggregatePreview(f.context, { query: '新闻' })).estimatedMinor, 12)
    assert.deepEqual(await snapshot(), before)
    const request = { body: { query: '新闻' }, path: '/api/v1/data/aggregate/search', idempotencyKey: randomUUID() }
    const result = await f.service.aggregateSearch(f.context, request)
    await f.service.aggregateSearch(f.context, request)
    assert.equal(f.calls(), 1)
    assert.equal((await pool.query('SELECT billing_meter_key FROM usage_requests WHERE id=$1', [result.requestId])).rows[0].billing_meter_key, null)
    assert.equal((await f.service.getTenantBilling(f.tenant.id)).account.availableMinor, 9988)
    const consumption = await f.service.listTenantConsumption(f.tenant.id, { limit: 1 })
    assert.equal(consumption.items[0].chargedMinor, 12)
    assert.deepEqual(consumption.items[0].events.map(row => row.kind), ['hold', 'capture'])
  } finally { await pool.end() }
})
