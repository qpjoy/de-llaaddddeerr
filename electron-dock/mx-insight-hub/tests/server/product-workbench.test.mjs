import test from 'node:test'
import assert from 'node:assert/strict'
import { PUBLIC_OPENAPI_DOCUMENT, publicDocsHtmlForPath, tenantDocumentPathAllowed } from '../../server/public-docs.mjs'
import { PRODUCT_WORKBENCHES, productForPath, productForDocs, productEndpoints, productConsoleRequest } from '../../shared/product-workbenches.mjs'
import { productAllowed } from '../../shared/product-access.mjs'
import { isExplicitOnlyKeyScope } from '../../shared/access-limits.mjs'
import { SHARE_LINK_RESOLVER as resolver } from '../../shared/share-link-resolver.mjs'

test('each shared workbench exposes only registered product routes and reciprocal docs', () => {
  for (const product of PRODUCT_WORKBENCHES) {
    assert.equal(productForDocs(`/docs/${product.docs}`).path, product.path)
    if (product.native) continue
    const endpoints = productEndpoints(PUBLIC_OPENAPI_DOCUMENT, product)
    assert.ok(endpoints.length, product.path)
    assert.ok(endpoints.every(endpoint => !endpoint.path.includes('/internal/')))
  }
  const search = productEndpoints(PUBLIC_OPENAPI_DOCUMENT, productForPath('/data-products/search'))
  assert.equal(search.length, 3)
  assert.equal(search.find(row => row.path.endsWith('/search')).parameters.some(row => row.name === 'Idempotency-Key'), true)
})
test('debugger encodes returned IDs/query values without allowing a caller-supplied destination', () => {
  const endpoint = { path: '/api/v1/data/source-catalog/{id}', method: 'GET', parameters: [{ name: 'id', in: 'path', required: true }, { name: 'query', in: 'query' }] }
  assert.throws(() => productConsoleRequest(endpoint, {}, ''), /id/)
  const request = productConsoleRequest(endpoint, { 'path:id': 'https://other/a?key=x', 'query:query': '自行车 & 公路' }, '')
  assert.ok(request.path.startsWith('/api/v1/data/source-catalog/https%3A'))
  assert.equal(new URL(request.path, 'https://hub.example').origin, 'https://hub.example')
  assert.equal(new URL(request.path, 'https://hub.example').searchParams.get('query'), '自行车 & 公路')
})

test('share-link product, API documentation and console share the same explicit permission', () => {
  const endpointPath = resolver.apiPath.slice('/api/v1'.length)
  const docsPath = `/docs/${resolver.docs}`
  const allowed = [{ platforms: [resolver.platform], capabilities: [resolver.capability] }]
  assert.ok(isExplicitOnlyKeyScope(resolver.capability))
  assert.ok(productAllowed(resolver.path, allowed))
  assert.ok(tenantDocumentPathAllowed(endpointPath, allowed))
  assert.match(publicDocsHtmlForPath(docsPath, { tenant: true, scopes: allowed }), /social\.share_links\.resolve/)
  assert.deepEqual(productEndpoints(PUBLIC_OPENAPI_DOCUMENT, productForPath(resolver.path)).map(row => row.path), [resolver.apiPath])
  for (const scopes of [[], [{ platforms: ['social'], capabilities: ['social.accounts.search'] }],
    [{ platforms: ['social'], capabilities: [] }, { platforms: ['douyin'], capabilities: [resolver.capability] }]]) {
    assert.equal(productAllowed(resolver.path, scopes), false)
    assert.equal(tenantDocumentPathAllowed(endpointPath, scopes), false)
    assert.equal(publicDocsHtmlForPath(docsPath, { tenant: true, scopes }), null)
  }
})
