import test from 'node:test'
import assert from 'node:assert/strict'
import { publicDocsHtmlForPath, tenantOpenApiDocument, PUBLIC_OPENAPI_DOCUMENT } from '../../server/public-docs.mjs'

test('tenant pages omit operator navigation and reject direct hidden pages', () => {
  const html = publicDocsHtmlForPath('/docs', { tenant: true })
  for (const path of ['/docs/tools', '/docs/evidence', '/docs/night-all', '/docs/source-catalog', '/docs/search']) {
    assert.equal(publicDocsHtmlForPath(path, { tenant: true }), null)
    assert.ok(publicDocsHtmlForPath(path))
    assert.ok(!html.includes(`href="${path}"`))
  }
  assert.match(html, /J 平台/)
  assert.match(html, /T 平台/)
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
  assert.ok(!doc.paths['/data/source-catalog'])
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
