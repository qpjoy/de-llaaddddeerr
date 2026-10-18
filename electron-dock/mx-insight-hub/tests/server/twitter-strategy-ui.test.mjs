import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const environment = { state: [], index: 0, sends: [], refreshes: 0, notices: [] }
globalThis.__twitterStrategyUi = environment
const view = build({
  stdin: { contents: "export { TwitterSearchPolicyForm } from './strategy-search.jsx'", loader: 'js', resolveDir: fileURLToPath(new URL('../../src/', import.meta.url)) },
  bundle: true, format: 'esm', jsx: 'automatic', platform: 'node', write: false,
  plugins: [{ name: 'management-boundaries', setup(builder) {
    builder.onResolve({ filter: /^react\/jsx-runtime$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }))
    builder.onResolve({ filter: /^react$|^@phosphor-icons\/react$/ }, args => ({ path: args.path, namespace: 'fixture' }))
    builder.onResolve({ filter: /\/(?:api|components|product-workbench|product-management|strategy-search-experience|strategy-data-statistics|platform-search-policy|strategy-search-experience-model)\.(?:jsx|js)$|\/product-workbenches\.mjs$|\.css$/ }, args => ({ path: args.path, namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => {
      let contents = ''
      if (path === 'react') contents = `const env = globalThis.__twitterStrategyUi;
        export const useState = initial => { const i=env.index++; if (!(i in env.state)) env.state[i]=initial; return [env.state[i], value => { env.state[i]=value }] };
        export const useCallback=fn=>fn,useRef=value=>({current:value})`
      else if (path === '@phosphor-icons/react') contents = 'export const ArrowRight=()=>null,MagnifyingGlass=()=>null,User=()=>null,Users=()=>null'
      else if (path.endsWith('/api.js')) contents = `export const publicDocsHref=value=>value, adminApi={ updateTwitterSearchStrategy: async (...args) => {
        const env=globalThis.__twitterStrategyUi; env.sends.push(args); if (env.failure) throw env.failure; return { revision:10 }; } }`
      else if (path.endsWith('/components.jsx')) contents = 'export const DropdownField=()=>null,ErrorState=()=>null,Field=()=>null,LoadingState=()=>null,PageHeading=()=>null,useRemoteData=()=>({})'
      else if (path.endsWith('/product-workbenches.mjs')) contents = 'export const productForPath=()=>null'
      else if (path.endsWith('/product-workbench.jsx')) contents = 'export const ProductApiConsole=()=>null'
      else if (path.endsWith('/product-management.jsx')) contents = 'export const ProductViewTabs=()=>null,ProductIntegrationGuide=()=>null,ProductManagement=()=>null'
      else if (path.endsWith('/strategy-search-experience.jsx')) contents = 'export const StrategySearchExperience=()=>null,useStrategySearchState=()=>({})'
      else if (path.endsWith('/strategy-data-statistics.jsx')) contents = 'export const StrategyDataStatistics=()=>null'
      else if (path.endsWith('/platform-search-policy.jsx')) contents = 'export const FacebookSearchPolicyForm=()=>null'
      else if (path.endsWith('/strategy-search-experience-model.js')) contents = 'export const recordStrategyAttempt=()=>{}'
      return { contents, loader: 'js' }
    })
  } }],
}).then(({ outputFiles }) => import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`))

const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...(Array.isArray(tree.props?.children) ? tree.props.children.flat(Infinity) : [tree.props?.children]).flatMap(nodes)]
const text = tree => typeof tree === 'string' || typeof tree === 'number' ? String(tree)
  : Array.isArray(tree) ? tree.map(text).join('') : tree?.props ? text(tree.props.children) : ''
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && text(node).includes(label))
const row = { platform: 'twitter', editable: true, providers: ['rapidapi', 'tikhub'], allowedModes: ['fixed', 'priority', 'paused'],
  policy: { mode: 'priority', primaryProvider: 'rapidapi', fallbackProvider: 'tikhub', revision: 9 } }

async function fixture() {
  Object.assign(environment, { state: [], index: 0, sends: [], refreshes: 0, notices: [], failure: null })
  const { TwitterSearchPolicyForm } = await view
  const render = () => { environment.index = 0; return TwitterSearchPolicyForm({ token: 'synthetic-admin', row,
    onSaved: () => { environment.refreshes++ }, notify: message => { environment.notices.push(message) } }) }
  const select = (label, value) => nodes(render()).find(node => node.props?.label?.startsWith(label)).props.onChange(value)
  const reason = value => nodes(render()).find(node => node.type === 'input').props.onChange({ target: { value } })
  const save = () => render().props.onSubmit({ preventDefault() {} })
  return { render, select, reason, save }
}

test('actual Twitter form saves only explicit edits with audited CAS and exact standard endpoint scope', async () => {
  const h = await fixture()
  assert.match(text(h.render()), /\/api\/v1\/data\/search.*\/api\/v2\/data\/search/)
  assert.match(text(h.render()), /raw 搜索、社交账号内容和账号资料接口保留原路由/)
  assert.equal(button(h.render(), '保存 Twitter').props.disabled, true)
  h.select('优先供应商', 'tikhub')
  h.select('策略方式', 'fixed')
  h.reason('  测试固定 TikHub  ')
  assert.equal(environment.sends.length, 0, 'editing or rendering never issues a supplier or policy request')
  assert.equal(button(h.render(), '保存 Twitter').props.disabled, false)
  await h.save()
  assert.deepEqual(environment.sends, [['synthetic-admin', { mode: 'fixed', primaryProvider: 'tikhub', fallbackProvider: null,
    expectedRevision: 9, reason: '测试固定 TikHub' }]])
  assert.equal(environment.refreshes, 1)
  assert.deepEqual(environment.notices, ['Twitter 标准搜索策略已保存'])
})

test('revision conflict freezes stale Twitter edits until an explicit refresh and does not resubmit', async () => {
  const h = await fixture()
  environment.failure = Object.assign(new Error('Policy revision changed'), { status: 409, code: 'strategy_revision_conflict' })
  h.reason('已核对')
  await h.save()
  assert.equal(environment.sends.length, 1)
  assert.match(text(h.render()), /本次未覆盖/)
  assert.equal(button(h.render(), '保存 Twitter').props.disabled, true)
  assert.equal(nodes(h.render()).find(node => node.props?.label === '策略方式').props.disabled, true)
  await h.save()
  assert.equal(environment.sends.length, 1, 'stale expectedRevision cannot silently overwrite or automatically retry')
  button(h.render(), '刷新策略并重新填写').props.onClick()
  assert.equal(environment.refreshes, 1)
  assert.equal(environment.notices.length, 0, 'conflict is never presented as saved')
})

test('pause explains purchased-buffer replay and does not pretend to cancel previous deliveries', async () => {
  const h = await fixture()
  h.select('策略方式', 'paused')
  h.reason('暂停供应商采购')
  assert.match(text(h.render()), /已有游标需要的后续采购/)
  assert.match(text(h.render()), /已完成响应的重放和已购缓冲数据仍可交付/)
  await h.save()
  assert.equal(environment.sends[0][1].mode, 'paused')
  assert.equal(environment.sends[0][1].fallbackProvider, null)
})

test('Twitter admin helper sends the audited policy to its own management endpoint', async () => {
  const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('../../src/api.js', import.meta.url))],
    bundle: true, format: 'esm', platform: 'node', write: false, define: { 'import.meta.env': '{}' } })
  const { adminApi } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`)
  const savedFetch = globalThis.fetch, requests = []
  globalThis.fetch = async (url, options) => { requests.push({ url, options }); return new Response(JSON.stringify({ revision: 10 }), { status: 200, headers: { 'content-type': 'application/json' } }) }
  const body = { mode: 'priority', primaryProvider: 'rapidapi', fallbackProvider: 'tikhub', expectedRevision: 9, reason: '保留 RapidAPI 优先' }
  try {
    await adminApi.updateTwitterSearchStrategy('synthetic-admin', body)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, '/internal/v1/admin/strategy-search/search/twitter')
    assert.equal(requests[0].options.method, 'PUT')
    assert.equal(requests[0].options.headers['x-mx-insight-admin-token'], 'synthetic-admin')
    assert.deepEqual(JSON.parse(requests[0].options.body), body)
  } finally { globalThis.fetch = savedFetch }
})
