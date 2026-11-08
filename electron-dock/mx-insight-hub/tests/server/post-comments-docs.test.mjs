import test from 'node:test'
import assert from 'node:assert/strict'
import { PUBLIC_OPENAPI_DOCUMENT, tenantOpenApiDocument, publicDocsHtmlForPath } from '../../server/public-docs.mjs'
import { servicePriceDefinition } from '../../server/contracts/service-pricing.mjs'
import { implementedRoutes } from '../../server/data/source-connections.mjs'
import { productAllowed } from '../../shared/product-access.mjs'
import { POST_COMMENTS_PATH, POST_COMMENTS_RECIPES, POST_COMMENT_PROVIDER_RECIPES } from '../../server/contracts/post-comments.mjs'

test('canonical comments and both aliases expose the actual count and identity contract', () => {
  for (const path of ['/data/social/post-comments', '/search/post-comments', '/night-all/search/post-comments']) {
    const operation = PUBLIC_OPENAPI_DOCUMENT.paths[path].post
    const schema = operation.requestBody.content['application/json'].schema
    assert.equal(schema.additionalProperties, false)
    assert.equal(schema.properties.count.default, 20)
    assert.equal(schema.properties.count.maximum, 100)
    assert.ok(schema.properties.contentId)
    assert.equal(schema.properties.platform.enum.length, 13)
    assert.equal(operation.responses[200].content['application/json'].schema.properties.contractVersion.const, 'mx-insight-hub.post-comments.v1')
    assert.equal(servicePriceDefinition('/api/v1' + path).meterKey, 'social.comments.list')
  }
})

test('tenant comment visibility requires platform and capability in the same scope', () => {
  for (const platform of Object.keys(POST_COMMENTS_RECIPES)) {
    const scopes = [{ platforms: [platform], capabilities: ['social.comments.list'] }]
    const entry = tenantOpenApiDocument(scopes).paths['/data/social/post-comments'].post
    assert.deepEqual(entry.requestBody.content['application/json'].schema.properties.platform.enum, [platform])
    assert.ok(productAllowed('/data-products/social-content', scopes))
    assert.match(publicDocsHtmlForPath('/docs/social-content', { tenant: true, scopes }), /data\/social\/post-comments/)
  }
  for (const scopes of [[{ platforms: ['twitter'], capabilities: [] }],
    [{ platforms: ['twitter'], capabilities: [] }, { platforms: ['telegram'], capabilities: ['social.comments.list'] }]]) {
    assert.equal(tenantOpenApiDocument(scopes).paths['/data/social/post-comments'], undefined)
  }
})

test('all platform inventory rows identify Hub execution and every registered supplier', () => {
  const rows = implementedRoutes().filter(row => row.path === POST_COMMENTS_PATH)
  assert.equal(rows.length, Object.values(POST_COMMENT_PROVIDER_RECIPES).reduce((sum, recipes) => sum + Object.keys(recipes).length, 0))
  for (const platform of Object.keys(POST_COMMENTS_RECIPES)) {
    assert(rows.some(row => row.platform === platform && row.provider === POST_COMMENTS_RECIPES[platform].provider), `${platform} baseline row`)
  }
  for (const row of rows) {
    assert.equal(row.verification, POST_COMMENT_PROVIDER_RECIPES[row.platform][row.provider].verification)
    assert.equal(row.operation, 'social.comments.list')
    assert.deepEqual(row.datasets, ['social.comments.v1'])
  }
})
