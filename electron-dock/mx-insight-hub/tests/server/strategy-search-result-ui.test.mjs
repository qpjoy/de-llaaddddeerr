import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const require = createRequire(import.meta.url)
const view = build({
  stdin: { contents: "export { StrategySearchResult } from './strategy-search-experience.jsx'", loader: 'js', resolveDir: fileURLToPath(new URL('../../src/', import.meta.url)) },
  bundle: true, define: { 'import.meta.env': '{}' }, format: 'esm', jsx: 'automatic', platform: 'node', write: false, loader: { '.css': 'empty' },
  plugins: [{ name: 'shared-react', setup(builder) {
    builder.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }))
  } }],
}).then(({ outputFiles }) => import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`))

test('search cards preserve complete acquired body and distinguish missing metrics from zero', async () => {
  const { StrategySearchResult } = await view
  const body = '完整正文。'.repeat(150) + '<script>正文中的文本</script>'
  const html = renderToStaticMarkup(createElement(StrategySearchResult, { payload: { data: {
    platform: 'tiktok', query: '测试词', status: 'ok', items: [{ id: 'one', text: body,
      author: { name: '测试作者' }, metrics: { likes: 0, comments: null }, media: {}, url: 'javascript:alert(1)' }],
  } } }))
  assert.ok(html.includes('完整正文。'.repeat(150)))
  assert.match(html, /&lt;script&gt;正文中的文本&lt;\/script&gt;/u)
  assert.match(html, /点赞 <b>0<\/b>/u)
  assert.match(html, /评论 <b>未提供<\/b>/u)
  assert.doesNotMatch(html, /href="javascript:|<script>/u)
})

test('WeChat category navigation never becomes a content count or guessed unified items', async () => {
  const { StrategySearchResult } = await view
  const html = renderToStaticMarkup(createElement(StrategySearchResult, { payload: {
    endpoint: 'wechat.search.search', data: { categories: [{ title: '此分类不是搜索条目' }], continue_flag: 1, cursor: 'opaque' },
  } }))
  assert.match(html, /微信原生业务响应/u)
  assert.doesNotMatch(html, /此分类不是搜索条目|本页返回 1 条/u)
})

test('Facebook photo landing pages stay original links while explicit mixed-media images remain visible', async () => {
  const { StrategySearchResult } = await view
  const photo = 'https://www.facebook.com/photo.php?fbid=123&set=fixture'
  const image = 'https://example.test/actual-photo.jpg'
  const html = renderToStaticMarkup(createElement(StrategySearchResult, { payload: { data: {
    platform: 'facebook', items: [{ id: 'mixed', text: '正文', metrics: {},
      media: { coverUrl: photo, images: [photo, image], videos: ['https://example.test/video.mp4'] } }],
  } } }))
  assert.match(html, /href="https:\/\/www\.facebook\.com\/photo\.php\?fbid=123&amp;set=fixture"/u)
  assert.match(html, /查看配图/u)
  assert.match(html, /<img[^>]+src="https:\/\/example\.test\/actual-photo\.jpg"/u)
  assert.doesNotMatch(html, /<img[^>]+src="https:\/\/www\.facebook\.com\/photo\.php/u)
})
