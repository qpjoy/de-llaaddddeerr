import test from 'node:test'
import assert from 'node:assert/strict'
import { enterpriseOpenApiPaths, enterpriseDocumentationHtml } from '../../server/contracts/enterprise-docs.mjs'
import { normalizeEnterpriseRequest } from '../../server/contracts/enterprise.mjs'
import { tenantOpenApiDocument } from '../../server/public-docs.mjs'
import { enterpriseAccessIssues, enterpriseConsoleEndpoints, enterpriseConsoleFields, enterpriseConsoleBody, enterpriseRequestIdentity } from '../../src/enterprise-console.js'
import { productAllowed } from '../../shared/product-access.mjs'

const endpoints = enterpriseConsoleEndpoints({ paths: enterpriseOpenApiPaths() })
const byId = id => endpoints.find(endpoint => endpoint.id === id)
test('all debugger forms derive valid requests from the published contract, including body and alternative fields', () => {
  assert.equal(endpoints.length, 274)
  assert.equal(endpoints.filter(endpoint => endpoint.callable).length, 260)
  for (const endpoint of endpoints) {
    const values = Object.fromEntries(['query', 'body'].flatMap(section => Object.entries(endpoint.example[section] || {}).map(([name, value]) => [`${section}.${name}`, value])))
    const body = enterpriseConsoleBody(endpoint, values)
    assert.doesNotThrow(() => normalizeEnterpriseRequest(endpoint.id, body), endpoint.id)
    assert.match(endpoint.path, /^\/api\/v1\/data\/enterprise\/\d+\.\d+\/query$/)
  }
  const bodyEndpoint = byId('42.3')
  assert.equal(bodyEndpoint.schema.properties.method.default, 'POST')
  assert.ok(enterpriseConsoleFields(bodyEndpoint, 'body').length)
  assert.throws(() => enterpriseConsoleBody(byId('66.35'), {}), /至少填写/)
  assert.throws(() => enterpriseConsoleBody(byId('1.31'), {}), /query.keyword/)
  assert.throws(() => enterpriseConsoleBody(byId('1.31'), { 'query.keyword': '示例', 'query.skip': 'NaN' }), /有效数字/)
})
test('exact request identity retains retries and separates page, delivery mode and API changes', () => {
  const endpoint = byId('1.31')
  const body = enterpriseConsoleBody(endpoint, { 'query.keyword': '示例', 'query.skip': 0 })
  assert.equal(body.query.skip, '0')
  assert.equal(enterpriseRequestIdentity(endpoint, body), enterpriseRequestIdentity(endpoint, { deliveryMode: body.deliveryMode, method: body.method, query: { skip: '0', keyword: '示例' } }))
  assert.notEqual(enterpriseRequestIdentity(endpoint, body), enterpriseRequestIdentity(endpoint, { ...body, query: { ...body.query, skip: '10' } }))
  assert.notEqual(enterpriseRequestIdentity(endpoint, body), enterpriseRequestIdentity(endpoint, { ...body, deliveryMode: 'cache_only' }))
  assert.notEqual(enterpriseRequestIdentity(endpoint, body), enterpriseRequestIdentity(byId('1.2'), body))
  assert.equal(enterpriseConsoleBody(endpoint, { 'query.keyword': '示例', 'query.skip': '9007199254740993' }).query.skip, '9007199254740993')
})
test('product navigation, current-Key access and tenant docs all require both enterprise grants', () => {
  const access = { platforms: ['enterprise'], capabilities: ['enterprise.query'] }
  assert.equal(productAllowed('/data-products/enterprise', [access]), true)
  const split = [{ platforms: ['enterprise'], capabilities: [] }, { platforms: [], capabilities: ['enterprise.query'] }]
  assert.equal(productAllowed('/data-products/enterprise', split), false)
  assert.equal(enterpriseConsoleEndpoints(tenantOpenApiDocument(split)).length, 0)
  assert.equal(enterpriseConsoleEndpoints(tenantOpenApiDocument([access])).length, 274)
  assert.deepEqual(enterpriseAccessIssues(access), [])
  assert.equal(enterpriseAccessIssues({ ...access, capabilities: [], consumerCapabilities: ['enterprise.query'] }).length, 1)
  assert.match(enterpriseAccessIssues({ ...access, capabilities: [], consumerCapabilities: ['enterprise.query'] })[0], /所选 Key/)
  assert.equal(enterpriseAccessIssues(undefined).length, 1)
  assert.deepEqual(enterpriseAccessIssues(null), [])
  assert.equal(byId('55.82').callable, false)
})
test('integration docs explain complete Hub-only requests, business status, pagination and safe recovery', () => {
  const html = enterpriseDocumentationHtml('enterprise', { tenant: true })
  for (const text of ['Python', 'Node.js', 'HUB_API_KEY', 'query.skip', 'result.data.status', 'meta.resultState', '/api/v1/requests/by-idempotency-key', 'Idempotency-Key', 'enterprise.query', 'x-mx-callable']) assert.ok(html.includes(text), text)
  assert.match(enterpriseDocumentationHtml('enterprise-1.31'), /成功交付返回 HTTP 200/)
  assert.equal(byId('1.31').example.query.keyword, '示例企业')
})
