import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PRODUCT_WORKBENCHES } from '../../shared/product-workbenches.mjs'
import { productManagementLinks } from '../../shared/product-management.mjs'

const require = createRequire(import.meta.url)
const views = build({
  stdin: { contents: "export * from './product-management.jsx'", loader: 'js', resolveDir: fileURLToPath(new URL('../../src/', import.meta.url)) },
  bundle: true, define: { 'import.meta.env': '{}' }, format: 'esm', jsx: 'automatic', platform: 'node', write: false,
  plugins: [{ name: 'shared-react', setup(builder) {
    builder.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }))
  } }],
}).then(({ outputFiles }) => import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`))

test('management tab and body are absent for tenants, SSO admins and incomplete admin sessions', async () => {
  const { ProductViewTabs, ProductManagement } = await views
  for (const session of [null, { kind: 'launcher-user', platformAdmin: true }, { kind: 'admin-token', platformAdmin: false }]) {
    const props = { session, label: '聚合搜索', path: '/data-products/search', value: 'management', onChange() {} }
    assert.equal(renderToStaticMarkup(createElement(ProductManagement, props)), '')
    const tabs = renderToStaticMarkup(createElement(ProductViewTabs, props))
    assert.doesNotMatch(tabs, />管理</u)
    for (const label of ['接口调试', '产品展示', '接入指南']) assert.ok(tabs.includes(label))
  }
})

test('all products have navigable governed management without credentials or mutation forms', async () => {
  const { ProductViewTabs, ProductManagement } = await views
  const session = { kind: 'admin-token', platformAdmin: true }
  for (const product of PRODUCT_WORKBENCHES.filter(row => row.path.startsWith('/data-products/'))) {
    const props = { session, path: product.path, label: product.label, value: 'management', onChange() {} }
    assert.match(renderToStaticMarkup(createElement(ProductViewTabs, props)), /aria-pressed="true">管理</u)
    const html = renderToStaticMarkup(createElement(ProductManagement, props))
    assert.match(html, /使用记录/u)
    assert.doesNotMatch(html, /<form|<input|Authorization|Bearer/u)
    assert.ok(productManagementLinks(product.path).every(link => link.href.startsWith('#/')))
  }
  assert.ok(productManagementLinks('/data-products/search').some(link => link.href.includes('strategy-search?view=routing')))
  assert.ok(productManagementLinks('/data-products/virtual-supermarket').some(link => link.href.endsWith('mode=catalog')))
})
