import test from 'node:test'
import assert from 'node:assert/strict'
import { PUBLIC_OPENAPI_DOCUMENT } from '../../server/public-docs.mjs'
import { PRODUCT_WORKBENCHES, productForPath, productForDocs, productEndpoints, productConsoleRequest } from '../../shared/product-workbenches.mjs'

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
