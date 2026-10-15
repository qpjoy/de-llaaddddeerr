import assert from 'node:assert/strict'
import test from 'node:test'
import { webSearchGuide, webSearchPaths } from '../../server/web-search/docs.mjs'
import { normalizeWebSearch, gatewayWebSearchRequest, normalizeSearchResponse, providerSupports } from '../../server/web-search/contract.mjs'
import { WEB_SEARCH_PROVIDERS, webSearchProvider } from '../../shared/web-search.mjs'
import { publicDocsHtmlForPath, tenantOpenApiDocument } from '../../server/public-docs.mjs'

const search = webSearchPaths['/data/web-search/search'].post
const compatible = webSearchPaths['/data/web-search/compatible/baidu'].post
const searchContent = search.requestBody.content['application/json']

test('documented requests validate and the Baidu alias keeps the explicit intent', () => {
  for (const provider of WEB_SEARCH_PROVIDERS) {
    const request = normalizeWebSearch(searchContent.example)
    assert.equal(gatewayWebSearchRequest(request, provider, 100).request.query, searchContent.example.query)
  }
  const alias = normalizeWebSearch(compatible.requestBody.content['application/json'].example, { baiduCompatible: true })
  assert.deepEqual(alias, normalizeWebSearch({ ...searchContent.example, provider: 'baidu' }))
  assert.notDeepEqual(alias, normalizeWebSearch(searchContent.example))
  assert.throws(() => normalizeWebSearch({ query: 'AI', from: '', to: '' }), { code: 'invalid_web_search_request' })
  assert.deepEqual(normalizeWebSearch({ messages: [{ role: 'user', content: 'AI' }], search_filter: { range: { page_time: { gte: '', lte: '' } } } }, { baiduCompatible: true }),
    normalizeWebSearch({ query: 'AI', provider: 'baidu' }))
})

test('OpenAPI quantity and compatible-field constraints agree with request validation', () => {
  const canonical = searchContent.schema
  assert.equal(canonical.additionalProperties, false)
  assert.deepEqual(canonical.not, { required: ['limit', 'resources'] })
  for (const branch of canonical.properties.resources.items.oneOf) {
    const type = branch.properties.type.const
    const limit = branch.properties.limit.maximum
    assert.doesNotThrow(() => normalizeWebSearch({ query: 'AI', resources: [{ type, limit }] }))
    assert.throws(() => normalizeWebSearch({ query: 'AI', resources: [{ type, limit: limit + 1 }] }), { code: 'invalid_web_search_request' })
  }
  assert.throws(() => gatewayWebSearchRequest(normalizeWebSearch({ query: 'AI', resources: [{ type: 'web', limit: 5 }, { type: 'image', limit: 3 }, { type: 'video', limit: 2 }] }), webSearchProvider('baidu'), 9), { code: 'page_size_exceeded' })
  for (const provider of WEB_SEARCH_PROVIDERS.filter(row => row.key !== 'baidu')) {
    assert.throws(() => gatewayWebSearchRequest(normalizeWebSearch({ query: 'AI', limit: 21 }), provider, 100), { code: 'web_search_options_unsupported' })
  }
  const alias = compatible.requestBody.content['application/json'].schema
  assert.equal(alias.additionalProperties, false)
  assert.equal(alias.properties.messages.items.additionalProperties, false)
  assert.deepEqual(alias.properties.resource_type_filter.items.required, ['type', 'top_k'])
  assert.deepEqual(Object.keys(alias.properties.search_filter.properties), ['match', 'range'])
  assert.equal(searchContent.examples, undefined, 'OpenAPI media example and examples must not coexist')
})

test('response examples match normalization and distinguish immutable body from replay headers', () => {
  const response = search.responses[200].content['application/json']
  const example = response.example
  const normalized = normalizeSearchResponse({ references: [{ title: example.data.items[0].title, url: example.data.items[0].url, content: example.data.items[0].snippet }] },
    webSearchProvider('baidu'), normalizeWebSearch(searchContent.example), example.meta.capturedAt)
  assert.deepEqual(example.data, normalized.data)
  for (const [key, value] of Object.entries(normalized.meta)) assert.deepEqual(example.meta[key], value)
  assert.deepEqual(response.schema.properties.data.properties.items.items.properties.publishedAt.type, ['string', 'null'])
  assert.deepEqual(response.schema.properties.meta.properties.sourceMode.enum, ['live'])
  assert.deepEqual(search.responses[200].headers['x-mx-insight-source-mode'].schema.enum, ['live', 'idempotent_replay'])
  for (const status of [400, 401, 402, 403, 409, 429, 502, 503]) assert(search.responses[status].content['application/json'].schema.properties.error)
})

test('public and tenant documentation exposes recovery without weakening tenant discovery', () => {
  const scope = { platforms: ['web_search'], capabilities: ['web.search', 'web.search.provider.tavily'] }
  for (const html of [webSearchGuide, publicDocsHtmlForPath('/docs/web-search'), publicDocsHtmlForPath('/docs/web-search', { tenant: true, scopes: [scope] })]) {
    for (const text of ['curl --max-time 60 -i', '/api/v1/requests/by-idempotency-key', 'idempotent-replay', 'X-MX-Insight-Retry-Of', '不是始终默认百度', 'href="/docs/openapi.json"']) assert(html.includes(text), text)
    assert(!html.includes('href="/openapi.json"'))
  }
  assert.equal(publicDocsHtmlForPath('/docs/web-search', { tenant: true, scopes: [] }), null)
  const doc = tenantOpenApiDocument([scope])
  assert.deepEqual(doc.paths['/data/web-search/search'].post.requestBody.content['application/json'].schema.properties.provider.enum, ['tavily'])
  assert.equal(doc.paths['/data/web-search/compatible/baidu'], undefined)
  assert(doc.paths['/data/web-search/search'].post.responses[200].content['application/json'].schema.properties.data)
})

test('Tavily-only tenant can copy the default OpenAPI request without needing a Baidu grant', () => {
  const doc = tenantOpenApiDocument([{ platforms: ['web_search'], capabilities: ['web.search', 'web.search.provider.tavily'] }])
  const content = doc.paths['/data/web-search/search'].post.requestBody.content['application/json']
  assert.deepEqual(content.schema.properties.provider.enum, ['tavily'])
  assert.equal(content.example.provider, undefined)
  assert.equal(content.examples, undefined, 'no unfiltered Baidu-only named requests')
  const request = normalizeWebSearch(content.example)
  assert(request.provider === null || content.schema.properties.provider.enum.includes(request.provider))
  assert.equal(providerSupports(webSearchProvider('tavily'), request), true)
  assert.doesNotThrow(() => gatewayWebSearchRequest(request, webSearchProvider('tavily'), 10))
})
