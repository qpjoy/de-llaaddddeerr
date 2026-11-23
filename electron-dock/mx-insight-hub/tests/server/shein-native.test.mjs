import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'
import { loadConfig } from '../../server/config.mjs'
import { nativeForwardingEndpoint, normalizeNativeForwardingRequest } from '../../server/contracts/native-forwarding.mjs'
import { officialProviderCatalog } from '../../server/data/provider-catalog.mjs'
import { implementedRoutes } from '../../server/data/source-connections.mjs'
import { createRapidApiProxyFetch } from '../../server/external-platforms/proxy.mjs'
import { createRuntime } from '../../server/index.mjs'
import { tenantOpenApiDocument } from '../../server/public-docs.mjs'
import { productAllowed } from '../../shared/product-access.mjs'

const key = 'r.shein_search_products'
const params = { query: 'cotton dress' }
const page = products => ({ success: true, data: { products }, error: null })

test('SHEIN forwards one US keyword-search page to the fixed ecommerce listing and preserves its product cards', async () => {
  const calls = []
  const body = page([{ goods_id: '1001', name: 'Cotton dress', price: { sale: { amount: '18.99' } } }])
  const adapter = new RapidApiAdapter({ apiKey: 'synthetic-shein-key', fetchImpl: async (url, options) => {
    calls.push({ url, options })
    return Response.json(body)
  } })
  assert.equal(nativeForwardingEndpoint(key).authorizationPlatform, 'ecommerce')
  assert.equal(normalizeNativeForwardingRequest(key, { params }).operation, 'native.r.shein_search_products')
  for (const invalid of [{}, { query: ' ' }, { ...params, country: 'GB' }, { ...params, page: 201 },
    { ...params, limit: 0 }, { ...params, url: 'https://example.com' }]) {
    await assert.rejects(adapter.forwardNative(key, { params: invalid }), { status: 400 })
  }
  assert.equal(calls.length, 0)
  const result = await adapter.forwardNative(key, { params })
  assert.equal(calls.length, 1)
  const { url, options } = calls[0]
  assert.equal(options.method, 'GET')
  assert.equal(options.redirect, 'error')
  assert.equal(url.origin + url.pathname, 'https://shein-data-api.p.rapidapi.com/search/products')
  assert.equal(options.headers['x-rapidapi-host'], url.host)
  assert.deepEqual(Object.fromEntries(url.searchParams), { query: params.query, country: 'US', page: '1', limit: '20' })
  assert.equal(result.publicBody.endpoint, key)
  assert.deepEqual(result.publicBody.data, body)
})

test('SHEIN accepts an empty result, but HTTP 200 with a business error or malformed product page fails delivery', async () => {
  let body = page([])
  const adapter = new RapidApiAdapter({ apiKey: 'synthetic-shein-key', fetchImpl: async () => Response.json(body) })
  assert.deepEqual((await adapter.forwardNative(key, { params })).publicBody.data, body)
  for (const invalid of [{ success: false, data: null, error: { code: 'failed' } },
    { success: true, data: { products: [] }, error: { code: 'failed' } },
    { success: true, data: {} }, page([null]), page([{ name: 'Missing ID' }]), page([{ goods_id: 12, name: '  ' }])]) {
    body = invalid
    await assert.rejects(adapter.forwardNative(key, { params }), error =>
      error.evidence?.outcome === 'succeeded_unusable' && error.evidence?.httpStatus === 200)
  }
})

test('SHEIN is discoverable only under the ecommerce domain and its own native operation', () => {
  const { hubPath, operation } = nativeForwardingEndpoint(key)
  const catalog = officialProviderCatalog()
  const row = catalog.rows.find(item => item.operation === operation)
  assert.deepEqual(row.catalogKeys, ['source-catalog-0112'])
  assert.equal(row.implementation, 'fixed_contract')
  assert.equal(row.hubPath, hubPath)
  assert.equal(implementedRoutes().find(route => route.path === hubPath).keywordSearch, true)
  assert.ok(productAllowed('/data-products/ecommerce-treasure-box', [{ platforms: ['ecommerce'], capabilities: [operation] }]))
  const rapid = catalog.summary.find(provider => provider.provider === 'rapidapi')
  assert.equal(rapid.documented, catalog.rows.filter(item => item.provider === 'rapidapi' && item.documented).length)
  const entry = (platforms, capabilities) => tenantOpenApiDocument([{ platforms, capabilities }]).paths[hubPath.slice('/api/v1'.length)]?.post
  assert.ok(entry(['ecommerce'], [operation]))
  assert.equal(entry(['ecommerce'], []), undefined)
  assert.equal(entry(['social'], [operation]), undefined)
})

test('public HTTP dispatches and replays a SHEIN search with ecommerce-only grants and the governed RapidAPI transport', async t => {
  const secret = 'synthetic-shein-secret'
  const runtime = await createRuntime(loadConfig({ MX_INSIGHT_STORE: 'memory', MX_INSIGHT_LISTENER_MODE: 'public',
    MX_INSIGHT_API_KEY_PEPPER: 'shein-native-pepper-at-least-32-characters', MX_INSIGHT_RAPIDAPI_API_KEY: secret }))
  const { service, store, ecommerceRapidNativeGateway: gateway, externalPlatformControlStore: control } = runtime
  t.after(async () => { runtime.agent.close(); await store.close() })
  const { hubPath, operation } = nativeForwardingEndpoint(key)
  const tenant = await service.createTenant({ name: 'SHEIN fixture' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Ecommerce-only fixture' })
  await store.setPlatformGrant(consumer.id, 'ecommerce', true)
  await service.putCapabilityConfiguration(operation, { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const caller = await service.createApiKey({ consumerId: consumer.id, name: 'search', platforms: ['ecommerce'], capabilities: [operation] })
  const narrow = await service.createApiKey({ consumerId: consumer.id, name: 'empty', platforms: ['ecommerce'], capabilities: [] })
  const payload = page([{ goods_id: '1001', name: 'Cotton dress' }])
  let upstreamCalls = 0
  const transport = createRapidApiProxyFetch({ route: async () => ({ proxyUrls: [], directFallback: true }) }, {
    fetchImpl: async (url, options) => {
      assert.equal(new URL(url).origin, 'https://shein-data-api.p.rapidapi.com')
      assert.equal(options.headers['x-rapidapi-host'], 'shein-data-api.p.rapidapi.com')
      upstreamCalls++
      return Response.json(payload)
    },
  })
  gateway.adapter = new RapidApiAdapter({ apiKey: secret, fetchImpl: transport })
  const server = createServer(runtime.app)
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}${hubPath}`
  const send = (apiKey, id) => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${apiKey.secret}`,
    'content-type': 'application/json', 'idempotency-key': id }, body: JSON.stringify({ params }) })
  assert.equal((await send(narrow, 'shein-no-operation')).status, 403)
  assert.equal((await send(caller, 'shein-not-released')).status, 503)
  assert.equal(upstreamCalls, 0)
  await control.updatePolicy('rapidapi', operation, { expectedRevision: 1, desiredState: 'active', reason: 'fixture',
    priceBook: { currency: 'USD', pricingAsOf: '2026-11-23T00:00:00Z', monthlyBudgetMinor: 1000,
      monthlySubsidyBudgetMinor: 1000, unitCostMinorByEndpoint: { [operation]: 2 } } },
  { runtime: { config: gateway.config, credentialConfigured: true } })
  const first = await send(caller, 'shein-first-page')
  const body = await first.json()
  assert.equal(first.status, 200, JSON.stringify(body))
  assert.equal(body.endpoint, key)
  assert.deepEqual(body.data, payload)
  const replay = await send(caller, 'shein-first-page')
  assert.equal(replay.headers.get('idempotent-replay'), 'true')
  assert.deepEqual(await replay.json(), body)
  assert.equal(upstreamCalls, 1)
  const [record] = gateway.platformStore.calls.values()
  assert.equal(record.marketplace, 'shein')
  assert.equal(record.costMinor, 2)
})
