import assert from 'node:assert/strict'
import test from 'node:test'
import { NEWS_ENDPOINTS, newsConsoleRequest, nextNewsConsoleRequest } from '../../src/news-console.js'
import { newsOpenApiPaths } from '../../server/contracts/news-discovery-docs.mjs'

test('news debugger covers every public news operation with the actual HTTP method', () => {
  assert.equal(NEWS_ENDPOINTS.length, Object.keys(newsOpenApiPaths).length)
  for (const endpoint of NEWS_ENDPOINTS) assert.ok(newsOpenApiPaths[endpoint.path.replace('/api/v1', '')][endpoint.method.toLowerCase()])
})

test('source IDs, article IDs and category IDs keep their separate roles', () => {
  const filters = { catalogEntryIds: ['94d36773-8912-5b8e-a593-8d0dcdaac8a3'], categories: ['news'], pageSize: 10 }
  const search = newsConsoleRequest('search', filters)
  filters.catalogEntryIds.push('26a27c11-e5ec-5087-8c62-fe42dc0590f8')
  assert.equal(search.body.catalogEntryIds.length, 1, 'request is a fixed snapshot')
  assert.equal(newsConsoleRequest('source-options', filters).body, undefined)
  assert.equal(newsConsoleRequest('sources', filters).method, 'GET')
  assert.throws(() => newsConsoleRequest('articles', filters, '腾讯新闻'))
  assert.throws(() => newsConsoleRequest('unknown', filters))
  const detail = newsConsoleRequest('articles', filters, '20000000-0000-4000-8000-000000000001')
  assert.equal(detail.body, undefined)
  assert.equal(detail.path, '/api/v1/data/news/articles/20000000-0000-4000-8000-000000000001')
})

test('pagination preserves the committed filter snapshot and does not carry search cursor into facets', () => {
  const request = newsConsoleRequest('search', { query: '新能源', catalogEntryIds: ['source'], pageSize: 10 })
  const payload = { data: { pageInfo: { hasMore: true, nextCursor: 'opaque-cursor' } } }
  assert.deepEqual(nextNewsConsoleRequest({ request, payload }).body, { ...request.body, cursor: 'opaque-cursor' })
  assert.equal(request.body.cursor, undefined)
  assert.equal(nextNewsConsoleRequest({ request, payload: { data: { pageInfo: { hasMore: false } } } }), null)
  assert.equal(newsConsoleRequest('facets', { ...request.body, cursor: 'opaque-cursor' }).body.cursor, undefined)
})
