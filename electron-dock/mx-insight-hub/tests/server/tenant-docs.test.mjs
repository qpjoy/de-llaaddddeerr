import test from 'node:test'
import assert from 'node:assert/strict'
import { publicDocsHtmlForPath, tenantOpenApiDocument, PUBLIC_OPENAPI_DOCUMENT } from '../../server/public-docs.mjs'
import { normalizeJobRequest } from '../../server/collect/catalog.mjs'

test('collect product documentation follows each capability grant and shows executable examples', () => {
  const path = '/docs/ecommerce-treasure-box'
  const capabilities = ['collect.ecommerce.fbmarketplace.search', 'collect.classifieds.craigslist.search', 'collect.ecommerce.shopify.search']
  for (const capability of capabilities) {
    const options = { tenant: true, scopes: [{ platforms: [], capabilities: [capability] }] }
    assert.ok(publicDocsHtmlForPath('/docs', options).includes(`href="${path}"`))
    const body = publicDocsHtmlForPath(path, options).match(/<main>([\s\S]*?)<\/main>/)[1]
    const examples = [...body.matchAll(/<code>(\{"capability":.*?\})<\/code>/g)].map(match => JSON.parse(match[1]))
    assert.deepEqual(examples.map(item => item.capability), [capability])
    const { definition } = normalizeJobRequest(examples[0])
    assert.ok(body.includes(`POST /api/v1/data/collect/${definition.sync ? 'query' : 'jobs'}`))
    assert.equal(body.includes('data.result.payload.items'), Boolean(definition.sync))
    for (const field of ['data.links.self', 'data.links.result', 'data.payload.items', 'Idempotency-Key']) assert.ok(body.includes(field), field)
    assert.ok(!body.includes('/api/v1/data/ecommerce/products/search'))
  }
  const searchOnly = { tenant: true, scopes: [{ platforms: ['ecommerce'], capabilities: ['ecommerce.products.search'] }] }
  assert.doesNotMatch(publicDocsHtmlForPath(path, searchOnly), /collect\.(?:ecommerce|classifieds)\./)
  assert.equal(publicDocsHtmlForPath(path, { tenant: true, scopes: [{ platforms: ['ecommerce', 'classifieds'], capabilities: [] }] }), null)
})

test('news tenants receive all five integration contracts and source/category/article ID guidance', () => {
 const scopes = [{ platforms: ['data_center_saved_records_news'], capabilities: [] }]
 const document = tenantOpenApiDocument(scopes)
 const html = publicDocsHtmlForPath('/docs/news-discovery', { tenant: true, scopes })
 for (const path of ['/data/news/source-options', '/data/news/sources', '/data/news/search', '/data/news/articles/{id}', '/data/news/facets']) {
  assert.ok(document.paths[path], path)
  assert.ok(html.includes(`/api/v1${path}`), path)
 }
 for (const value of ['data.items[].key', 'data.categories[].id', 'data.items[].id', 'data.pageInfo.nextCursor']) assert.ok(html.includes(value), value)
 assert.equal(publicDocsHtmlForPath('/docs/news-discovery', { tenant: true, scopes: [] }), null)
 assert.ok(!tenantOpenApiDocument([{ platforms: ['source_catalog'], capabilities: [] }]).paths['/data/news/source-options'])
})

test('tenant pages omit operator navigation and reject direct hidden pages', () => {
  const html = publicDocsHtmlForPath('/docs', { tenant: true })
  for (const path of ['/docs/tools', '/docs/evidence', '/docs/night-all', '/docs/search']) {
    assert.equal(publicDocsHtmlForPath(path, { tenant: true }), null)
    assert.ok(publicDocsHtmlForPath(path))
    assert.ok(!html.includes(`href="${path}"`))
  }
  assert.match(html, /数据服务/)
  assert.doesNotMatch(html, /J Platform|T Platform/)
  const native = publicDocsHtmlForPath('/docs/tikhub/search_notes', { tenant: true })
  assert.match(native, /\/api\/v1\/xiaohongshu\/app_v2\/search_notes/)
  assert.doesNotMatch(native, /https:\/\/docs.tikhub/)
  assert.match(native, /data-theme="light"/)
})

test('tenant schema preserves product contracts and all referenced schemas without internal endpoints', () => {
  const doc = tenantOpenApiDocument()
  assert.ok(doc.paths['/xiaohongshu/app_v2/search_notes'])
  assert.ok(doc.paths['/data/post'])
  assert.ok(!doc.paths['/tools/tokenize'])
  assert.ok(doc.paths['/data/source-catalog'])
  const visit = value => {
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref' && child.startsWith('#/')) assert.ok(child.slice(2).split('/').reduce((node, part) => node?.[part], doc), child)
      else visit(child)
    }
  }
  visit(doc)
  assert.ok(PUBLIC_OPENAPI_DOCUMENT.paths['/tools/tokenize'])
})

test('search-only tenant sees matching product/native docs and schemas', () => {
  const scopes = [{ platforms: ['xiaohongshu'], capabilities: ['social.posts.search', 'compat.xiaohongshu.app_v2'] }]
  const html = publicDocsHtmlForPath('/docs', { tenant: true, scopes })
  assert.ok(html.includes('href="/docs/xiaohongshu-note"'))
  for (const path of ['/docs/telegram', '/docs/ecommerce-treasure-box', '/docs/tikhub/get_user_info']) {
    assert.ok(!html.includes(`href="${path}"`))
    assert.equal(publicDocsHtmlForPath(path, { tenant: true, scopes }), null)
  }
  const doc = tenantOpenApiDocument(scopes)
  assert.ok(doc.paths['/xiaohongshu/app_v2/search_notes'])
  assert.ok(!doc.paths['/data/post'])
  const product = publicDocsHtmlForPath('/docs/xiaohongshu-note', { tenant: true, scopes })
  assert.doesNotMatch(product, /上游|供应方|采购|外部平台/)
  assert.match(product, /keyword/)
  assert.match(product, /Idempotency-Key/)
})
test('scope combinations stay within one consumer and empty access hides products', () => {
  const scopes = [{ platforms: ['xiaohongshu'], capabilities: [] }, { platforms: ['ecommerce'], capabilities: ['social.posts.search', 'compat.xiaohongshu.app_v2'] }]
  assert.equal(publicDocsHtmlForPath('/docs/tikhub/search_notes', { tenant: true, scopes }), null)
  assert.ok(!tenantOpenApiDocument(scopes).paths['/xiaohongshu/app_v2/search_notes'])
  assert.equal(publicDocsHtmlForPath('/docs/xiaohongshu-note', { tenant: true, scopes: [] }), null)
})

 test('catalog docs and schema follow same-consumer grants, including item extra scope', () => {
 const scopes = [{ platforms: ['source_catalog'], capabilities: [] }]
 assert.ok(publicDocsHtmlForPath('/docs/source-catalog', { tenant: true, scopes }))
 const doc = tenantOpenApiDocument(scopes)
 assert.ok(doc.paths['/data/source-catalog'])
 assert.ok(doc.paths['/data/source-catalog/metadata'])
 assert.ok(!doc.paths['/data/source-catalog/{id}/items'])
 assert.ok(!tenantOpenApiDocument([...scopes, { platforms: ['mobile_commerce'], capabilities: [] }]).paths['/data/source-catalog/{id}/items'])
 assert.ok(tenantOpenApiDocument([{ platforms: ['source_catalog', 'mobile_commerce'], capabilities: [] }]).paths['/data/source-catalog/{id}/items'])
 assert.equal(publicDocsHtmlForPath('/docs/source-catalog', { tenant: true, scopes: [] }), null)
 })
