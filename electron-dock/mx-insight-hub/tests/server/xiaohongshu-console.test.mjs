import test from 'node:test'
import assert from 'node:assert/strict'
import { XHS_CONSOLE_ENDPOINTS as endpoints, consoleBody, consoleRequestIdentity } from '../../src/xiaohongshu-console.js'
import { PUBLIC_OPENAPI_DOCUMENT } from '../../server/public-docs.mjs'
test('console exposes only fixed Hub POST contracts with known parameters', () => {
  assert.equal(endpoints.length, 6)
  for (const endpoint of endpoints) {
    const operation = PUBLIC_OPENAPI_DOCUMENT.paths[endpoint.path.replace('/api/v1', '')]?.post
    assert.ok(operation, endpoint.path)
    let schema = operation.requestBody.content['application/json'].schema
    if (schema.$ref) schema = PUBLIC_OPENAPI_DOCUMENT.components.schemas[schema.$ref.split('/').pop()]
    for (const [key] of endpoint.fields) assert.ok(schema.properties[key], `${endpoint.id}:${key}`)
  }
  assert.throws(() => consoleBody({ id: 'https://example.com' }, {}))
})
test('required parameters, mutually alternative IDs and bounded page values validate before sending', () => {
  const search = endpoints.find(item => item.id === 'search_notes')
  assert.throws(() => consoleBody(search, {}), /关键词/)
  for (const page of [0, 16, 1.5, 'oops']) assert.throws(() => consoleBody(search, { keyword: '牛奶', page }))
  assert.deepEqual(consoleBody(search, { keyword: '牛奶', page: '2', url: 'https://elsewhere.test' }), { keyword: '牛奶', page: 2 })
  assert.throws(() => consoleBody(endpoints.find(item => item.id === 'get_user_info'), {}), /ID/)
})
test('the same business request keeps its retry identity, but a new page changes it', () => {
  const search = endpoints[1]
  assert.equal(consoleRequestIdentity(search, { keyword: '牛奶', page: 1 }), consoleRequestIdentity(search, { page: 1, keyword: '牛奶' }))
  assert.notEqual(consoleRequestIdentity(search, { page: 1 }), consoleRequestIdentity(search, { page: 2 }))
  assert.deepEqual(consoleBody(endpoints[0], { url: 'https://www.xiaohongshu.com/explore/test' }), { platform: 'xiaohongshu', url: 'https://www.xiaohongshu.com/explore/test' })
})
