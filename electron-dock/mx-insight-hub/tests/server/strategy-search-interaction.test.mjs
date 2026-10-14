import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createStrategySearchCell, recordStrategyAttempt } from '../../src/strategy-search-experience-model.js'

const require = createRequire(import.meta.url)
const environment = { identity: 'original-key', key: 'synthetic-key', access: { platforms: ['kuaishou', 'zhihu', 'bilibili'], capabilities: [] } }
globalThis.__strategyInteraction = environment
const view = build({
  stdin: { contents: "export { StrategySearchExperience } from './strategy-search-experience.jsx'", loader: 'js', resolveDir: fileURLToPath(new URL('../../src/', import.meta.url)) },
  bundle: true, format: 'esm', jsx: 'automatic', platform: 'node', write: false,
  plugins: [{ name: 'interaction-boundaries', setup(builder) {
    builder.onResolve({ filter: /^react\/jsx-runtime$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }))
    builder.onResolve({ filter: /^react$/ }, () => ({ path: 'hooks', namespace: 'fixture' }))
    builder.onResolve({ filter: /^@phosphor-icons\/react$/ }, () => ({ path: 'icons', namespace: 'fixture' }))
    builder.onResolve({ filter: /\/(?:demo-credentials|api|components|wechat-product|admin-execution-evidence)\.(?:jsx|js)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => {
      let contents
      if (path === 'hooks') contents = 'export const useRef = value => ({current:value}), useEffect = () => {}, useState = value => [value,()=>{}], useSyncExternalStore = (_,get) => get()'
      else if (path === 'icons') contents = 'export const Check=()=>null, MagnifyingGlass=()=>null, ArrowDown=()=>null, ArrowUpRight=()=>null, Image=()=>null'
      else if (path.includes('demo-credentials')) contents = 'const env=globalThis.__strategyInteraction; export const useDemoApiKey=()=>[env.key],useDemoIdentity=()=>env.identity,useDemoAccessSnapshot=()=>env.access'
      else if (path.includes('api.js')) contents = 'const env=globalThis.__strategyInteraction; export const publicDataApi={productRequest:(...args)=>env.send(...args),requestByIdempotencyKey:(...args)=>env.lookup(...args)}'
      else contents = 'export const DropdownField=()=>null,ErrorState=()=>null,formatDate=value=>value,WechatResult=()=>null,AdminExecutionEvidence=()=>null'
      return { contents, loader: 'js' }
    })
  } }],
}).then(({ outputFiles }) => import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`))

const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...(Array.isArray(tree.props?.children) ? tree.props.children.flat(Infinity) : [tree.props?.children]).flatMap(nodes)]
const label = tree => typeof tree === 'string' || typeof tree === 'number' ? String(tree)
  : Array.isArray(tree) ? tree.map(label).join('') : tree?.props ? label(tree.props.children) : ''
const button = (tree, text) => nodes(tree).find(node => node.type === 'button' && label(node).includes(text))
const searchButton = tree => nodes(tree).find(node => node.type === 'button' && node.props.type == null)
const flush = () => new Promise(resolve => setImmediate(resolve))
const unknown = () => Object.assign(new Error('Synthetic saved outcome is unknown'), {
  code: 'request_outcome_unknown', requestId: 'http-correlation', details: { requestId: 'ledger-original' }, responseBody: { error: { code: 'request_outcome_unknown' } },
})
async function fixture() {
  environment.identity = 'original-key'
  const { StrategySearchExperience } = await view
  const session = new Map([['original-key', createStrategySearchCell('kuaishou')]]), sent = [], lookups = []
  environment.send = async (_key, input, idem) => {
    sent.push({ input, idem })
    if (input.body.platform !== 'bilibili') throw unknown()
    return { payload: { data: { platform: 'bilibili', query: input.body.query, items: [], pageInfo: { hasMore: false } } }, evidence: { requestId: 'bilibili-received' } }
  }
  environment.lookup = async (_key, idem) => { lookups.push(idem); return { payload: { data: { id: 'ledger-original', status: 'unknown', platform: 'kuaishou' } } } }
  const render = () => StrategySearchExperience({ strategySession: session })
  const submit = async () => { nodes(render()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await flush() }
  const select = platformLabel => button(render(), platformLabel).props.onClick()
  const query = value => nodes(render()).find(node => node.type === 'input' && node.props.placeholder?.includes('搜索关键词')).props.onChange({ target: { value } })
  return { session, sent, lookups, render, submit, select, query }
}

test('actual composer handlers keep unknown original intent locked while other platform cards and explicit searches work', async () => {
  const h = await fixture()
  h.query('原始关键词')
  await h.submit()
  const original = h.sent[0], cell = h.session.get('original-key')
  assert.equal(h.sent.length, 1)
  assert.equal(nodes(h.render()).find(node => node.type === 'fieldset').props.disabled, undefined)
  assert.equal(searchButton(h.render()).props.disabled, true)
  assert.match(label(h.render()), /幂等键/u)
  assert.match(label(h.render()), /Hub 请求 ID.*ledger-original/u)

  h.select('知乎')
  assert.equal(h.sent.length, 1, 'platform selection never dispatches')
  assert.equal(searchButton(h.render()).props.disabled, false)
  assert.equal(button(h.render(), '只读核对原请求状态'), undefined)
  h.query('知乎关键词')
  await h.submit()
  assert.equal(h.sent.length, 2)
  assert.equal(h.sent[1].input.body.platform, 'zhihu')
  assert.notEqual(h.sent[1].idem, original.idem)

  h.select('哔哩哔哩')
  assert.equal(h.sent.length, 2)
  await h.submit()
  assert.equal(h.sent.length, 3)
  assert.equal(h.sent[2].input.body.platform, 'bilibili')

  h.select('快手')
  assert.equal(cell.getSnapshot().form.query, '原始关键词')
  assert.equal(searchButton(h.render()).props.disabled, true)
  await h.submit()
  assert.equal(h.sent.length, 3, 'even programmatic submit cannot retry unknown work')
  await button(h.render(), '只读核对原请求状态').props.onClick()
  assert.deepEqual(h.lookups, [original.idem])
  assert.equal(searchButton(h.render()).props.disabled, true)
  assert.equal(cell.getSnapshot().attempts.values().next().value.state, 'uncertain')
})

test('identity changes and navigation preserve their own unresolved attempts and read-only check resolves only the original ID', async () => {
  const h = await fixture()
  h.query('关键词')
  await h.submit()
  environment.identity = 'other-key'
  h.select('快手'); h.query('另一个身份')
  assert.equal(searchButton(h.render()).props.disabled, false)
  assert.equal(button(h.render(), '只读核对原请求状态'), undefined)
  environment.identity = 'original-key'
  assert.equal(searchButton(h.render()).props.disabled, true)
  environment.lookup = async () => ({ payload: { data: { id: 'wrong-ledger', status: 'committed', platform: 'kuaishou' } } })
  await button(h.render(), '只读核对原请求状态').props.onClick()
  assert.equal(searchButton(h.render()).props.disabled, true)
  environment.lookup = async () => ({ payload: { data: { id: 'ledger-original', status: 'committed', platform: 'kuaishou' } } })
  await button(h.render(), '只读核对原请求状态').props.onClick()
  assert.equal(searchButton(h.render()).props.disabled, false)
  assert.equal(h.sent.length, 1, 'resolution is read-only and never triggers replay')
})

test('debugger unknown attempt uses durable error details and blocks only its selected platform after remount', async () => {
  const h = await fixture(), cell = h.session.get('original-key')
  recordStrategyAttempt(cell, { idempotencyKey: 'debugger-original', state: 'failed', requestId: 'http-correlation', error: unknown(),
    input: { method: 'POST', path: '/api/v1/search/raw', body: { platform: 'kuaishou', keyword: '调试关键词', count: 20 } } })
  assert.equal(searchButton(h.render()).props.disabled, true)
  h.select('哔哩哔哩'); h.query('新关键词')
  assert.equal(searchButton(h.render()).props.disabled, false)
  h.select('快手')
  assert.equal(cell.getSnapshot().form.query, '调试关键词')
  assert.equal(searchButton(h.render()).props.disabled, true)
  const attempt = cell.getSnapshot().attempts.values().next().value
  assert.equal(attempt.requestId, 'ledger-original')
  assert.equal(attempt.idempotencyKey, 'debugger-original')
  assert.equal(h.sent.length, 0)
})

test('platform choice stays independent while an original read-only status lookup completes', async () => {
  const h = await fixture()
  h.query('待核实关键词')
  await h.submit()
  let finish
  environment.lookup = () => new Promise(resolve => { finish = resolve })
  const checking = button(h.render(), '只读核对原请求状态').props.onClick()
  h.select('哔哩哔哩')
  assert.equal(h.session.get('original-key').getSnapshot().form.platform, 'bilibili')
  finish({ payload: { data: { id: 'ledger-original', status: 'committed', platform: 'kuaishou' } } })
  await checking
  assert.equal(h.session.get('original-key').getSnapshot().form.platform, 'bilibili')
  assert.equal(h.session.get('original-key').getSnapshot().outcomeNote, null)
  assert.equal(h.sent.length, 1)
  h.select('快手')
  assert.equal(button(h.render(), '只读核对原请求状态'), undefined)
})
