import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { JustOneAdapter, JustOneRejectedError } from '../../server/adapters/justone.mjs'
import {
  JUSTONE_OPERATION, RAPIDAPI_TAOBAO_TMALL_HOST, normalizeJustOneProductSearchRequest, productAdapterId, productSearchProviders,
} from '../../server/contracts/justone.mjs'
import { EcommerceRoutingStore, ecommerceRoutingCatalog } from '../../server/external-platforms/ecommerce-routing.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { EXTERNAL_PLATFORM_OPERATION_CATALOG } from '../../server/external-platforms/control-store.mjs'
import { NATIVE_FORWARDING_ENDPOINTS, TIKHUB_COMMERCE_OPERATIONS } from '../../server/contracts/native-forwarding.mjs'
import { diagnoseEcommerceSearch } from '../../server/ops/diagnose-ecommerce-search.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const PEPPER = 'ecommerce-supplier-routing-pepper-entropy'
const PATH = '/api/v1/data/ecommerce/products/search'
const fixture = JSON.parse(await readFile(new URL('../fixtures/justone/taobao-product-search-v1.success.json', import.meta.url), 'utf8'))
const TAOBAO = { justone: productAdapterId('justone', 'taobao'), rapidapi: productAdapterId('rapidapi', 'taobao') }
const json = (body, init = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json', ...init.headers } })
const business = code => json({ code, message: 'private-provider-message', data: null, recordTime: '2026-10-29T08:00:00Z' })

function config(overrides = {}) {
  return { token: 'configured', configured: true, contractVerified: true, dispatchEnabled: true, configurationError: null,
    timeoutMs: 60_000, freshTtlMs: 60_000, staleTtlMs: 86_400_000, maxConcurrency: 32, maxConsumerConcurrency: 8,
    circuitFailureThreshold: 3, circuitOpenMs: 60_000,
    billing: { source: 'manual', currency: 'CNY', pricingAsOf: '2026-10-01T00:00:00.000Z', freeDailyCalls: null,
      monthlyBudgetMinor: 10_000, monthlySubsidyBudgetMinor: 10_000,
      unitCostMinorByEndpoint: { 'taobao-tmall.product-search.v1': 15, 'jd.product-search.v1': 15 } },
    ...overrides }
}

// Two supplier gateways over one usage store, like production. The memory
// stores share one lease map because PostgreSQL has a single lease table.
async function routed({ justone, rapidapi, route = null, justoneConfig = config() }) {
  const usageStore = new MemoryStore()
  const hub = new HubService({ store: usageStore, adapter: {}, apiKeyPepper: PEPPER })
  const tenant = await hub.createTenant({ name: 'Tenant' })
  const consumer = await hub.createConsumer({ tenantId: tenant.id, name: 'Delta' })
  await usageStore.setPlatformGrant(consumer.id, 'ecommerce', true)
  await hub.putCapabilityConfiguration(JUSTONE_OPERATION, { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await hub.createApiKey({ consumerId: consumer.id, name: 'Key', platforms: ['ecommerce'], capabilities: [JUSTONE_OPERATION] })
  await usageStore.putPolicy({ tenantId: tenant.id, consumerId: consumer.id, platform: 'ecommerce', maxRequests: 1_000, windowSeconds: 3_600, maxPageSize: 100 })
  const context = await hub.authenticate(key.secret)
  const routes = new EcommerceRoutingStore()
  if (route) await routes.update('taobao', { ...route, expectedRevision: 1, reason: 'fixture route' })
  const stores = {
    justone: new MemoryExternalPlatformStore({ usageStore, circuitFailureThreshold: justoneConfig.circuitFailureThreshold }),
    rapidapi: new MemoryExternalPlatformStore({ usageStore, providerKey: 'rapidapi', providerCircuit: 'marketplace' }),
  }
  stores.rapidapi.leases = stores.justone.leases
  const gateway = (providerKey, adapter, gatewayConfig) => new ExternalPlatformGateway({ usageStore, platformStore: stores[providerKey],
    adapter, config: gatewayConfig, providerKey, apiKeyPepper: PEPPER, reservationLeaseMs: 150_000, ecommerceRoutingStore: routes,
    logger: { warn() {}, error() {} } })
  const gateways = { justone: gateway('justone', justone, justoneConfig), rapidapi: gateway('rapidapi', rapidapi, config()) }
  gateways.justone.productSearchGateways = gateways.rapidapi.productSearchGateways = gateways
  return { usageStore, context, routes, stores, gateways }
}

function counted(responses, seen = []) {
  return { seen, fetchImpl: async (url, init) => { seen.push({ url: new URL(url), headers: init.headers }); return responses.shift()() } }
}
const justOneAdapter = (responses, seen) => new JustOneAdapter({ token: 'justone-secret-token', ...counted(responses, seen) })
const rapidAdapter = (responses, seen) => new JustOneAdapter({ credentialResolver: async () => 'rapid-secret-key',
  transport: { provider: 'rapidapi', host: RAPIDAPI_TAOBAO_TMALL_HOST }, ...counted(responses, seen) })
const search = (gateway, context, idempotencyKey, body = { marketplace: 'taobao', query: '始祖鸟', deliveryMode: 'live_only' }) =>
  gateway.search(context, { body, idempotencyKey, path: PATH })

test('only Taobao and Tmall have a second compatible supplier, and cursors bind the contract rather than the supplier', () => {
  assert.deepEqual(productSearchProviders('taobao'), ['justone', 'rapidapi'])
  assert.deepEqual(productSearchProviders('jd'), ['justone'])
  assert.equal(productAdapterId('rapidapi', 'jd'), null)
  assert.throws(() => normalizeJustOneProductSearchRequest({ marketplace: 'jd', query: 'x' }, { providerKey: 'rapidapi' }), { code: 'unsupported_product_adapter' })
  const first = normalizeJustOneProductSearchRequest({ marketplace: 'taobao', query: 'x' })
  const state = { version: 1, adapterId: TAOBAO.justone, marketplace: 'taobao', page: 2, scope: first.cursorScope, continuation: null }
  const next = normalizeJustOneProductSearchRequest({ marketplace: 'taobao', query: 'x', cursor: 'c' }, { providerKey: 'rapidapi', decodeCursor: () => state })
  assert.equal(next.adapterId, TAOBAO.rapidapi)
  assert.equal(next.page, 2)
  assert.deepEqual(next.fingerprintBody, normalizeJustOneProductSearchRequest({ marketplace: 'taobao', query: 'x', page: 2 }).fingerprintBody)
  assert.throws(() => normalizeJustOneProductSearchRequest({ marketplace: 'taobao', query: 'x', cursor: 'c' },
    { decodeCursor: () => ({ ...state, adapterId: 'native.t.example' }) }), { code: 'invalid_cursor' })
})

test('routes are fixed or priority with a distinct compatible backup, revisioned and audited', async () => {
  const routes = new EcommerceRoutingStore()
  const catalog = (await routes.catalog()).items
  assert.equal(catalog.find(row => row.marketplace === 'taobao').switchable, true)
  assert.equal(catalog.find(row => row.marketplace === 'jd').switchable, false)
  assert.equal(catalog.find(row => row.marketplace === 'taobao').mode, 'fixed')
  const bad = [
    { adapterId: TAOBAO.justone, mode: 'priority', fallbackAdapterId: TAOBAO.justone },
    { adapterId: TAOBAO.justone, mode: 'fixed', fallbackAdapterId: TAOBAO.rapidapi },
    { adapterId: TAOBAO.justone, mode: 'paused' },
    { adapterId: 'rapidapi:jd.product-search.v1' },
  ]
  for (const input of bad) await assert.rejects(routes.update('taobao', { ...input, expectedRevision: 1, reason: 'x' }), { code: 'invalid_ecommerce_route' })
  await assert.rejects(routes.update('jd', { adapterId: productAdapterId('justone', 'jd'), mode: 'priority', fallbackAdapterId: TAOBAO.rapidapi, expectedRevision: 1, reason: 'x' }), { code: 'invalid_ecommerce_route' })
  const saved = await routes.update('taobao', { adapterId: TAOBAO.justone, mode: 'priority', fallbackAdapterId: TAOBAO.rapidapi, expectedRevision: 1, reason: 'JustOne balance' })
  assert.equal(saved.revision, 2)
  assert.deepEqual(await routes.selection('taobao'), { marketplace: 'taobao', mode: 'priority', revision: 2,
    primaryAdapterId: TAOBAO.justone, primaryProvider: 'justone', fallbackAdapterId: TAOBAO.rapidapi, fallbackProvider: 'rapidapi' })
  const row = ecommerceRoutingCatalog(await routes.list()).items.find(item => item.marketplace === 'taobao')
  assert.equal(row.fallbackRoute.provider, 'rapidapi')
  assert.equal(routes.events.length, 1)
  // Older admin clients that send only adapterId keep a fixed route.
  assert.equal((await routes.update('taobao', { adapterId: TAOBAO.rapidapi, expectedRevision: 2, reason: 'fixed' })).mode, 'fixed')
})

test('the RapidAPI listing uses header authentication on its own host and treats gateway refusals as unbilled', async () => {
  const seen = []
  const adapter = rapidAdapter([() => json(fixture), () => json({ message: 'You are not subscribed to this API.' },
    { status: 403, headers: { 'x-rapidapi-proxy-response': 'true' } })], seen)
  const result = await adapter.searchProducts({ marketplace: 'taobao', query: '始祖鸟' }, { encodeCursor: () => 'next', decodeCursor: () => null })
  assert.ok(result.items.length > 0)
  assert.equal(seen[0].url.origin, `https://${RAPIDAPI_TAOBAO_TMALL_HOST}`)
  assert.equal(seen[0].url.pathname, '/api/taobao/search-item-list/v1')
  assert.equal(seen[0].url.searchParams.has('token'), false)
  assert.equal(seen[0].headers['x-rapidapi-key'], 'rapid-secret-key')
  assert.equal(seen[0].headers['x-rapidapi-host'], RAPIDAPI_TAOBAO_TMALL_HOST)
  await assert.rejects(adapter.searchProducts({ marketplace: 'taobao', query: '始祖鸟' }), error => {
    assert.ok(error instanceof JustOneRejectedError)
    assert.deepEqual([error.evidence.outcome, error.evidence.billed, error.evidence.httpStatus, error.evidence.errorCode],
      ['rejected', false, 403, 'upstream_permission_denied'])
    return true
  })
  await assert.rejects(adapter.searchProducts({ marketplace: 'jd', query: 'x' }), { code: 'unsupported_product_adapter' })
  await assert.rejects(adapter.forwardNative('j.xianyu_search_v1', { params: { keyword: 'x' } }), /only serves product search/u)
})

test('priority hands a JustOne balance refusal to the RapidAPI backup inside the same request', async () => {
  const justSeen = [], rapidSeen = []
  const state = await routed({ justone: justOneAdapter([() => business(601)], justSeen), rapidapi: rapidAdapter([() => json(fixture)], rapidSeen),
    route: { adapterId: TAOBAO.justone, mode: 'priority', fallbackAdapterId: TAOBAO.rapidapi } })
  const result = await search(state.gateways.justone, state.context, 'priority-balance-0001')
  assert.equal(result.status, 200)
  assert.equal(result.sourceMode, 'live')
  assert.ok(result.body.data.items.length > 0)
  assert.doesNotMatch(JSON.stringify(result.body), /rapidapi|justone/iu)
  const [primary] = state.stores.justone.calls.values(), [backup] = state.stores.rapidapi.calls.values()
  assert.deepEqual([primary.outcome, primary.billed, primary.businessCode, primary.callOrdinal], ['rejected', false, 601, 0])
  assert.deepEqual([backup.outcome, backup.callOrdinal, backup.usageRequestId], ['succeeded', 1, primary.usageRequestId])
  assert.equal(state.stores.justone.state.consecutiveFailures, 1, 'the refusal still counts against JustOne')
  assert.equal(state.usageStore.requests.get(primary.usageRequestId).status, 'committed')
  assert.equal(state.stores.justone.leases.size, 0, 'the hand-off and the backup both release the shared lease')
  // Exact replay returns the saved body and dispatches nothing.
  assert.deepEqual((await search(state.gateways.justone, state.context, 'priority-balance-0001')).body, result.body)
  assert.deepEqual([justSeen.length, rapidSeen.length], [1, 1])
})

test('an open JustOne circuit switches before dispatch, while fixed routes and charged or unknown results never switch', async () => {
  const open = await routed({ justone: justOneAdapter([]), rapidapi: rapidAdapter([() => json(fixture)]),
    route: { adapterId: TAOBAO.justone, mode: 'priority', fallbackAdapterId: TAOBAO.rapidapi } })
  open.stores.justone.state.circuitOpenUntil = new Date(Date.now() + 60_000).toISOString()
  assert.equal((await search(open.gateways.justone, open.context, 'priority-open-0001')).status, 200)
  assert.deepEqual([open.stores.justone.calls.size, [...open.stores.rapidapi.calls.values()][0].callOrdinal], [0, 0])

  const fixed = await routed({ justone: justOneAdapter([() => business(601)]), rapidapi: rapidAdapter([]) })
  await assert.rejects(search(fixed.gateways.justone, fixed.context, 'fixed-balance-0001'), { status: 503, code: 'external_platform_capacity_unavailable' })
  assert.equal(fixed.stores.rapidapi.calls.size, 0)

  for (const response of [() => { throw new TypeError('socket reset') }, () => json({ code: 0, message: 'ok', data: { unexpected: true }, recordTime: '2026-10-29T08:00:00Z' })]) {
    const charged = await routed({ justone: justOneAdapter([response]), rapidapi: rapidAdapter([]),
      route: { adapterId: TAOBAO.justone, mode: 'priority', fallbackAdapterId: TAOBAO.rapidapi } })
    await assert.rejects(search(charged.gateways.justone, charged.context, 'priority-charged-0001'), { status: 502 })
    assert.equal(charged.stores.rapidapi.calls.size, 0, 'unknown or billed outcomes never buy the page twice')
  }
})

test('a RapidAPI primary serves the request and its failures stay on its own Taobao breaker', async () => {
  const state = await routed({ justone: justOneAdapter([]), rapidapi: rapidAdapter([
    () => json({ message: 'Invalid API key' }, { status: 401, headers: { 'x-rapidapi-proxy-response': 'true' } })]),
  route: { adapterId: TAOBAO.rapidapi, mode: 'fixed' } })
  await assert.rejects(search(state.gateways.justone, state.context, 'rapid-primary-0001'), { status: 503, code: 'external_platform_capacity_unavailable' })
  assert.equal(state.stores.justone.calls.size, 0)
  assert.equal(await state.stores.rapidapi.providerState(), null)
  assert.equal((await state.stores.rapidapi.contractCircuitState('rapidapi', 'taobao')).consecutiveFailures, 1)
  assert.equal(state.stores.rapidapi.state.consecutiveFailures, 0, 'the supplier-wide RapidAPI breaker (Twitter) is untouched')
})

test('ecommerce supplier operations and TikHub commerce aliases are registered without changing social keys', () => {
  assert.ok(EXTERNAL_PLATFORM_OPERATION_CATALOG.rapidapi.some(row => row.operationKey === JUSTONE_OPERATION
    && row.endpointKeys.includes('taobao-tmall.product-search.v1')))
  assert.equal(TIKHUB_COMMERCE_OPERATIONS.length, 17)
  for (const operation of TIKHUB_COMMERCE_OPERATIONS) {
    const row = NATIVE_FORWARDING_ENDPOINTS.find(item => item.operation === operation)
    assert.equal(row.authorizationPlatform, 'ecommerce')
    assert.equal(row.provider, 'tikhub')
  }
  assert.equal(NATIVE_FORWARDING_ENDPOINTS.find(row => row.key === 't.api_6f94aeb043a45013').authorizationPlatform, 'social')
  const catalog = ecommerceRoutingCatalog().items
  assert.equal(catalog.find(row => row.marketplace === 'tiktok_shop').endpoints.filter(row => row.provider === 'tikhub').length, 12)
  assert.equal(catalog.find(row => row.marketplace === 'xiaohongshu_ec').endpoints.filter(row => row.provider === 'tikhub').length, 5)
})

test('ecommerce diagnostic reads only ledger metadata inside a read-only transaction', async () => {
  const queries = []
  let released = false
  const pool = { async connect() { return { async query(sql, params) {
    queries.push(sql)
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|COMMIT)\b|response_body|body_bytes|credential/u)
    if (sql.includes('ecommerce-search:meta')) return { rows: [{ observed_at: new Date(), has_routes: true, has_contract_circuits: true }] }
    if (sql.includes('ecommerce-search:routes')) return { rows: [{ route: { marketplace: 'taobao', adapter_id: TAOBAO.justone, mode: 'priority',
      fallback_adapter_id: TAOBAO.rapidapi, revision: 2, updated_at: '2026-10-29T08:00:00Z' } }] }
    if (sql.includes('ecommerce-search:calls')) return { rows: [{ provider_key: 'justone', marketplace: 'taobao', outcome: 'rejected',
      http_status: 200, business_code: 601, error_code: 'upstream_balance_exhausted', billed: false, calls: 4, last_started_at: new Date() },
    { provider_key: 'justone', marketplace: 'private-secret', outcome: 'rejected', http_status: 200, business_code: 1,
      error_code: 'private provider text', billed: false, calls: 1, last_started_at: new Date() }] }
    if (sql.includes('ecommerce-search:controls')) return { rows: [{ provider_key: 'rapidapi', desired_state: 'active', revision: '3', updated_at: new Date() }] }
    return { rows: [] }
  }, release() { released = true } } } }
  const result = await diagnoseEcommerceSearch(pool, 24)
  assert.equal(queries[0], 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(queries.at(-1), 'ROLLBACK')
  assert.equal(released, true)
  assert.deepEqual(result.routes[0], { marketplace: 'taobao', mode: 'priority', primary: TAOBAO.justone, fallback: TAOBAO.rapidapi, revision: 2, updatedAt: '2026-10-29T08:00:00.000Z' })
  assert.equal(result.recentCalls[0].businessCode, 601)
  assert.equal(result.operationControls[0].revision, 3)
  assert.doesNotMatch(JSON.stringify(result), /private/u)
  await assert.rejects(diagnoseEcommerceSearch(pool, 0), { message: 'invalid_arguments' })
})

test('migrations 167/168 add supplier modes to existing routes and seed disabled operations', { skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE }, async t => {
  const { PGlite } = await import(pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE).href)
  const db = new PGlite()
  t.after(() => db.close())
  const schema = await readFile(new URL('../../migrations/060_external_platform_operation_control.sql', import.meta.url), 'utf8')
  await db.exec('CREATE SCHEMA control')
  await db.exec(schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS control.external_platform_provider_price_books'),
    schema.indexOf('CREATE OR REPLACE FUNCTION control.reject_external_platform_append_only_mutation')))
  await db.exec(`INSERT INTO control.external_platform_provider_price_books(provider_key,version,source,status)
    VALUES('tikhub',0,'legacy_environment','inherited'),('rapidapi',0,'legacy_environment','inherited')`)
  await db.exec(await readFile(new URL('../../migrations/148_ecommerce_product_routes.sql', import.meta.url), 'utf8'))
  for (const name of ['167_ecommerce_supplier_routes.sql', '168_ecommerce_supplier_operations.sql']) {
    const migration = await readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8')
    await db.exec(migration)
    await db.exec(migration)
  }
  const pool = { query: (sql, values) => db.query(sql, values), connect: async () => ({ query: (sql, values) => db.query(sql, values), release() {} }) }
  const routes = new EcommerceRoutingStore(pool)
  assert.deepEqual(await routes.selection('jd'), { marketplace: 'jd', mode: 'fixed', revision: 1, primaryAdapterId: productAdapterId('justone', 'jd'),
    primaryProvider: 'justone', fallbackAdapterId: null, fallbackProvider: null })
  assert.equal((await routes.update('taobao', { adapterId: TAOBAO.justone, mode: 'priority', fallbackAdapterId: TAOBAO.rapidapi,
    expectedRevision: 1, reason: 'JustOne balance' })).fallback_adapter_id, TAOBAO.rapidapi)
  await assert.rejects(db.exec(`UPDATE control.ecommerce_product_routes SET mode='priority', fallback_adapter_id=NULL WHERE marketplace='jd'`))
  const { rows } = await db.query(`SELECT provider_key, desired_state FROM control.external_platform_operation_policies ORDER BY provider_key, operation_key`)
  assert.equal(rows.length, 18)
  assert.ok(rows.every(row => row.desired_state === 'disabled'))
  assert.equal((await db.query('SELECT count(*)::int AS n FROM control.external_platform_operation_policy_events')).rows[0].n, 18)
})
