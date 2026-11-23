import test from 'node:test'
import assert from 'node:assert/strict'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'
import { nativeForwardingEndpoint } from '../../server/contracts/native-forwarding.mjs'
import { officialProviderCatalog } from '../../server/data/provider-catalog.mjs'
import { implementedRoutes } from '../../server/data/source-connections.mjs'
import { createRapidApiProxyFetch } from '../../server/external-platforms/proxy.mjs'
import { tenantOpenApiDocument } from '../../server/public-docs.mjs'

const key = 'r.facebook_marketplace_search'
const params = { query: 'guitar', lat: 40.7128, lng: -74.006 }

test('Facebook Marketplace dispatches one fixed ecommerce query and preserves an empty page with a cursor', async () => {
  const payload = { results: [], cursor: 'next-page-marker' }
  const calls = []
  const transport = createRapidApiProxyFetch({ route: async () => ({ proxyUrls: [], directFallback: true }) }, {
    fetchImpl: async (url, options) => { calls.push({ url: new URL(url), options }); return Response.json(payload) },
  })
  const adapter = new RapidApiAdapter({ apiKey: 'test-marketplace-key', fetchImpl: transport })
  for (const invalid of [
    { query: 'guitar' }, { ...params, lat: 91 }, { ...params, lng: -181 }, { ...params, lat: '40.7128' },
    { ...params, query: ' ' }, { ...params, count: 1 }, { ...params, url: 'https://example.com' },
  ]) await assert.rejects(adapter.forwardNative(key, { params: invalid }), { status: 400 })
  assert.equal(calls.length, 0)
  const response = await adapter.forwardNative(key, { params })
  assert.deepEqual(response.publicBody.data, payload)
  assert.equal(calls.length, 1)
  const [{ url, options }] = calls
  assert.equal(url.origin + url.pathname, 'https://facebook-scraper3.p.rapidapi.com/marketplace/search')
  assert.equal(options.headers['x-rapidapi-host'], url.host)
  assert.equal(options.method, 'GET')
  assert.deepEqual(Object.fromEntries(url.searchParams), { query: 'guitar', lat: '40.7128', lng: '-74.006' })

  await adapter.forwardNative(key, { params: { ...params, cursor: payload.cursor } })
  assert.equal(calls.length, 2)
  assert.equal(calls[1].url.searchParams.get('cursor'), payload.cursor)
})

test('Facebook Marketplace refuses HTTP 200 error and malformed page envelopes', async () => {
  for (const payload of [{ error: 'supplier failure' }, { results: {} }, { results: [], cursor: 35 },
    { results: [], error: 'failed' }, { results: [], status: 'error' }]) {
    const adapter = new RapidApiAdapter({ apiKey: 'test-marketplace-key', fetchImpl: async () => Response.json(payload) })
    await assert.rejects(adapter.forwardNative(key, { params }), error =>
      error.evidence?.outcome === 'succeeded_unusable' && error.evidence.httpStatus === 200)
  }
})

test('Facebook Marketplace native docs and catalog belong to the ecommerce operation', () => {
  const { hubPath, operation, authorizationPlatform } = nativeForwardingEndpoint(key)
  assert.equal(authorizationPlatform, 'ecommerce')
  const row = officialProviderCatalog().rows.find(item => item.operation === operation)
  assert.deepEqual(row.catalogKeys, ['source-catalog-0124'])
  assert.equal(row.hubPath, hubPath)
  assert.equal(implementedRoutes().find(route => route.path === hubPath)?.keywordSearch, true)
  const documented = (platforms, capabilities) =>
    tenantOpenApiDocument([{ platforms, capabilities }]).paths[hubPath.slice('/api/v1'.length)]?.post
  assert.ok(documented(['ecommerce'], [operation]))
  assert.equal(documented(['ecommerce'], []), undefined)
  assert.equal(documented(['social'], [operation]), undefined)
})
