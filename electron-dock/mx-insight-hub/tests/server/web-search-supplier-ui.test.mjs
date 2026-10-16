import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import test from 'node:test'
import { WEB_SEARCH_PROVIDERS } from '../../shared/web-search.mjs'

const require = createRequire(import.meta.url)
let viewsPromise
function views() {
  viewsPromise ||= build({
    stdin: {
      contents: "export { ExternalProxyPanel } from './external-proxy-panel.jsx'; export { StructuredCredentialPanel } from './structured-credential-panel.jsx'; export { WebSearchManagement } from './web-search-management.jsx'",
      loader: 'js', resolveDir: fileURLToPath(new URL('../../src/', import.meta.url)),
    },
    bundle: true, loader: { '.css': 'empty' }, define: { 'import.meta.env': '{}' }, format: 'esm', jsx: 'automatic', platform: 'node', write: false,
    plugins: [{ name: 'shared-react', setup(builder) {
      builder.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }))
    } }],
  }).then(({ outputFiles }) => import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`))
  return viewsPromise
}

const credential = {
  fields: [{ name: 'apiKey', label: 'API Key' }], source: 'database', revision: 3,
  credentialConfigured: true, revealable: true,
  // Ordinary detail must never fill a secret, even if an unexpected value arrives.
  apiKey: 'unexpected-plaintext-fixture',
}
const proxy = { mode: 'system-egress', revision: 2, sequences: [] }
function Panel({ title, subtitle, children }) {
  return createElement('section', null, createElement('h2', null, title), createElement('p', null, subtitle), children)
}

test('Web Search management requires an Admin Token session and exposes all suppliers without a calling Key', async () => {
  const { WebSearchManagement } = await views()
  for (const session of [
    null,
    { kind: 'launcher-user', platformAdmin: true },
    { kind: 'launcher-user', platformAdmin: false },
    { kind: 'admin-token', platformAdmin: false },
  ]) {
    assert.equal(renderToStaticMarkup(createElement(WebSearchManagement, { token: 'admin-session-fixture', session })), '')
  }
  // No DemoCredentialProvider or selected caller: supplier management uses
  // the administrator identity and never inherits a customer's channel scope.
  const html = renderToStaticMarkup(createElement(WebSearchManagement, {
    token: 'admin-session-fixture', session: { kind: 'admin-token', platformAdmin: true },
  }))
  for (const { label } of WEB_SEARCH_PROVIDERS) assert.ok(html.includes(`>${label}</button>`), label)
  assert.match(html, /供应商管理/u)
  assert.match(html, /正在读取 百度 AI 搜索 配置/u)
  assert.doesNotMatch(html, /admin-session-fixture|unexpected-plaintext-fixture/u)
})

test('each Web Search supplier renders its own proxy scope rather than a TikHub fallback', async () => {
  const { ExternalProxyPanel } = await views()
  for (const { key, label } of WEB_SEARCH_PROVIDERS) {
    const html = renderToStaticMarkup(createElement(ExternalProxyPanel, { provider: key, proxy, token: 'admin-session-fixture', Panel }))
    assert.ok(html.includes(`${label} 出网代理`), key)
    assert.ok(html.includes(`仅影响 ${label}。`), key)
    assert.ok(html.includes(`探测策略覆盖（仅 ${label}）`), key)
    assert.doesNotMatch(html, /TikHub/u, key)
  }
})

test('TikHub keeps its own proxy label and unknown providers never inherit that label', async () => {
  const { ExternalProxyPanel } = await views()
  for (const [provider, label] of [['tikhub', 'TikHub'], ['qixin', '启信慧眼'], ['rapidapi', 'RapidAPI'], ['future-provider', 'future-provider']]) {
    const html = renderToStaticMarkup(createElement(ExternalProxyPanel, { provider, proxy, token: 'admin-session-fixture', Panel }))
    assert.ok(html.includes(`${label} 出网代理`), provider)
    if (provider !== 'tikhub') assert.doesNotMatch(html, /TikHub/u, provider)
  }
  const source = await readFile(new URL('../../src/external-proxy-panel.jsx', import.meta.url), 'utf8')
  assert.match(source, /updateExternalPlatformProxy\(token, provider, \{/u, 'saving still targets the selected provider')
})

test('all Web Search token editors start masked, blank and explicitly describe database replacement', async () => {
  const { StructuredCredentialPanel } = await views()
  for (const { key, label } of WEB_SEARCH_PROVIDERS) {
    const html = renderToStaticMarkup(createElement(StructuredCredentialPanel, { token: 'admin-session-fixture', provider: key, credential }))
    assert.ok(html.includes(`${label} · API 密钥管理`), key)
    assert.match(html, /Hub 数据库/u)
    assert.match(html, /type="password"/u)
    assert.match(html, /value=""/u)
    assert.match(html, /输入新密钥并保存即可替换/u)
    assert.match(html, /再次验证 Admin Token/u)
    assert.doesNotMatch(html, /unexpected-plaintext-fixture|admin-session-fixture/u)
    assert.match(html, /type="submit" disabled="">保存到数据库/u)
    assert.match(html, /type="button">查看 \/ 复制/u)
  }
})

test('missing credential metadata disables edits and reveal rather than submitting an empty bundle', async () => {
  const { StructuredCredentialPanel } = await views()
  const html = renderToStaticMarkup(createElement(StructuredCredentialPanel, {
    token: 'admin-session-fixture', provider: 'baidu', credential: {},
  }))
  assert.match(html, /状态未知/u)
  assert.match(html, /未读取到凭据字段/u)
  assert.match(html, /type="submit" disabled="">保存到数据库/u)
  assert.match(html, /type="button" disabled="">查看 \/ 复制/u)
})

test('credential source distinguishes an empty environment fallback from a configured environment key', async () => {
  const { StructuredCredentialPanel } = await views()
  for (const [configured, label] of [[false, '未配置'], [undefined, '未知'], [true, '部署环境']]) {
    const html = renderToStaticMarkup(createElement(StructuredCredentialPanel, {
      token: 'admin-session-fixture', provider: 'tavily',
      credential: { ...credential, source: 'environment', credentialConfigured: configured, revealable: false },
    }))
    assert.ok(html.includes(`当前来源：${label}`))
    if (configured === true) assert.match(html, /当前环境来源的密钥不可查看/u)
    else assert.doesNotMatch(html, /部署环境|当前环境来源的密钥不可查看/u)
    assert.match(html, /type="button" disabled="">查看 \/ 复制/u)
  }
})

test('provider, session and credential revision changes discard the entire secret editor subtree', async () => {
  const { StructuredCredentialPanel } = await views()
  const props = { token: 'admin-a', provider: 'baidu', credential }
  const initialKey = StructuredCredentialPanel(props).key
  for (const changed of [
    { ...props, provider: 'tavily' },
    { ...props, token: 'admin-b' },
    { ...props, credential: { ...credential, revision: 4 } },
  ]) assert.notEqual(StructuredCredentialPanel(changed).key, initialKey)
  assert.equal(StructuredCredentialPanel({ ...props, credential: { ...credential } }).key, initialKey)

  const source = await readFile(new URL('../../src/structured-credential-panel.jsx', import.meta.url), 'utf8')
  assert.match(source, /revealExternalPlatformCredential\(token, provider, adminToken\)[\s\S]*?if \(!mounted\.current\) return/u)
  assert.match(source, /setAdminToken\(''\); setValues\(null\); setVisible\(false\); onClose\(\)/u)
  assert.doesNotMatch(source, /localStorage|sessionStorage|console\./u)
  const detail = await readFile(new URL('../../src/pages-external-platforms.jsx', import.meta.url), 'utf8')
  assert.match(detail, /<PlatformDetail key=\{`\$\{token\}:\$\{provider\}`\}/u, 'a provider change cannot briefly reuse another supplier detail')
})
