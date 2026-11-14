import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { loadConfig } from '../../server/config.mjs'
import { createRuntime } from '../../server/index.mjs'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'
import { THREADS_SCRAPER_RAPIDAPI_ENDPOINTS as endpoints } from '../../server/contracts/threads-rapidapi-endpoints.mjs'
import { publicDocsHtmlForPath, tenantOpenApiDocument } from '../../server/public-docs.mjs'
import { productEndpoints, productForPath } from '../../shared/product-workbenches.mjs'
import { provisioningOperation } from '../../server/commercial/catalog.mjs'
import { officialProviderCatalog } from '../../server/data/provider-catalog.mjs'

test('the admin listing and tenant social workbench expose the nine separately authorized and documented reads', () => {
  const operations = endpoints.map(row => row.operation)
  const catalog = officialProviderCatalog()
  const scraper = catalog.rows.filter(row => operations.includes(row.operation))
  assert.equal(scraper.length, 9)
  assert.equal(catalog.summary.find(row => row.provider === 'rapidapi').documented, 9)
  const scopes = [{ platforms: ['social'], capabilities: operations }]
  const workbench = productForPath('/data-products/social-content')
  const visible = productEndpoints(tenantOpenApiDocument(scopes), workbench)
  for (const row of endpoints) {
    const entry = visible.find(item => item.path === row.hubPath)
    const admin = provisioningOperation(`rapidapi:${row.operation}`)
    assert.equal(admin.capability, row.operation)
    assert.equal(admin.meterKey, row.operation)
    assert.ok(admin.products.includes('社媒与内容数据'))
    assert.equal(entry['x-mx-meter-key'], row.operation)
    assert.equal(entry['x-mx-category'], 'Threads')
    assert.equal(entry['x-mx-endpoint-key'], row.key)
    assert.match(publicDocsHtmlForPath(entry['x-mx-doc-path'], { tenant: true, scopes }), new RegExp(`endpoint=${row.key}`))
  }
  const one = productEndpoints(tenantOpenApiDocument([{ platforms: ['social'], capabilities: [operations[0]] }]), workbench)
  assert.deepEqual(one.filter(row => row.path.includes('threads_scraper_')).map(row => row.path), [endpoints[0].hubPath])
})

test('public HTTP Threads native media enforces the social grant, prices, URL/code, supplier envelope and replay', async t => {
  const secret = 'synthetic-rapid-credential'
  const runtime = await createRuntime(loadConfig({ MX_INSIGHT_STORE: 'memory', MX_INSIGHT_LISTENER_MODE: 'public',
    MX_INSIGHT_API_KEY_PEPPER: 'threads-native-pepper-at-least-32-characters', MX_INSIGHT_RAPIDAPI_API_KEY: secret }))
  const { service, store, threadsNativeGateway: gateway, externalPlatformControlStore: control } = runtime
  t.after(async () => { runtime.agent.close(); await store.close() })
  const endpoint = endpoints.find(row => row.key.endsWith('_post_media'))
  const { operation } = endpoint
  const calls = []
  const payload = { status: 'ok', data: { media: [{ images: [], optional: null }] } }
  gateway.adapter = new RapidApiAdapter({ apiKey: secret, fetchImpl: async (url, request) => {
    calls.push(Object.fromEntries(url.searchParams))
    assert.equal(url.origin + url.pathname, 'https://threads-scraper.p.rapidapi.com/api/v1/explore/post-media')
    assert.equal(request.headers['x-rapidapi-host'], url.hostname)
    return Response.json(payload)
  } })
  const tenant = await service.createTenant({ name: 'Threads native fixture' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Social-only caller' })
  await store.setPlatformGrant(consumer.id, 'social', true)
  await service.putCapabilityConfiguration(operation, { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const caller = await service.createApiKey({ consumerId: consumer.id, name: 'media', platforms: ['social'], capabilities: [operation] })
  const other = await service.createApiKey({ consumerId: consumer.id, name: 'narrow', platforms: ['social'], capabilities: [] })
  const server = createServer(runtime.app)
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const auth = key => ({ authorization: `Bearer ${key.secret}` })
  const send = (params, id, key = caller) => fetch(origin + endpoint.hubPath, { method: 'POST', headers: { ...auth(key),
    'content-type': 'application/json', 'idempotency-key': id }, body: JSON.stringify({ params }) })
  const code = 'C8O-JbtAKrp'
  const link = `https://www.threads.net/@sample/post/${code}`
  const pricing = origin + '/api/v1/data/services/pricing?path=' + encodeURIComponent(endpoint.hubPath)
  assert.equal((await fetch(pricing, { headers: auth(other) })).status, 403)
  const quoted = await fetch(pricing, { headers: auth(caller) })
  assert.equal(quoted.status, 200)
  assert.equal((await quoted.json()).data.dispatches, 0)
  assert.equal((await send({ code }, 'threads-native-no-grant', other)).status, 403)
  const ready = async () => {
    const r = await fetch(origin + '/api/v1/data/capabilities', { headers: auth(caller) })
    assert.equal(r.status, 200)
    return (await r.json()).data.capabilities.find(row => row.capability === operation).ready
  }
  assert.equal(await ready(), false)
  await control.updatePolicy('rapidapi', operation, { expectedRevision: 1, desiredState: 'active', reason: 'fixture',
    priceBook: { currency: 'USD', pricingAsOf: '2026-11-13T00:00:00Z', monthlyBudgetMinor: 1000,
      monthlySubsidyBudgetMinor: 1000, unitCostMinorByEndpoint: { [endpoint.endpointKey]: 2 } } },
  { runtime: { config: gateway.config, credentialConfigured: true } })
  assert.equal(await ready(), true)
  assert.equal((await send({ url: 'https://example.invalid/post/abcde' }, 'threads-native-bad-url')).status, 400)
  assert.equal(calls.length, 0)
  for (const [id, params] of [['threads-native-media-url', { url: link }], ['threads-native-media-code', { code }]]) {
    const response = await send(params, id)
    const delivered = await response.json()
    assert.equal(response.status, 200, JSON.stringify(delivered))
    assert.equal(delivered.endpoint, endpoint.key)
    assert.deepEqual(delivered.data, payload)
    const replay = await send(params, id)
    assert.equal(replay.headers.get('idempotent-replay'), 'true')
    assert.deepEqual(await replay.json(), delivered)
  }
  assert.deepEqual(calls, [{ url: link }, { code }])
  assert.ok([...gateway.platformStore.calls.values()].every(row => row.marketplace === 'threads-scraper' && row.costMinor === 2))
})
