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

test('account composer follows a short page cursor with a new identity and keeps profile requests separate', async () => {
  const { StrategySearchExperience } = await view
  const previousAccess = environment.access
  environment.access = { platforms: ['twitter'], capabilities: ['social.content.crawl', 'social.profile.get'] }
  environment.identity = 'account-key'
  const cell = createStrategySearchCell('twitter'), session = new Map([['account-key', cell]]), sent = []
  let operation = 'crawl'
  cell.update({ form: { ...cell.getSnapshot().form, accountField: 'user_id', account: 'ui_batch_019', pageSize: 500 } })
  environment.send = async (_key, input, idem) => {
    sent.push({ input, idem })
    return { payload: { data: { platform: 'twitter', items: [], pageInfo: { hasMore: !input.body.cursor, nextCursor: input.body.cursor ? null : 'opaque-short-page' } } }, evidence: { requestId: `fixture-${sent.length}` } }
  }
  const render = () => StrategySearchExperience({ strategySession: session, operation })
  try {
    nodes(render()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await flush()
    assert.equal(sent[0].input.path, '/api/v1/data/social/crawl')
    assert.deepEqual(sent[0].input.body, { platform: 'twitter', user_id: 'ui_batch_019', pageSize: 500 })
    await button(render(), '读取下一页').props.onClick()
    assert.deepEqual(sent[1].input.body, { ...sent[0].input.body, cursor: 'opaque-short-page' })
    assert.notEqual(sent[1].idem, sent[0].idem)
    assert.equal(button(render(), '读取下一页'), undefined)
    operation = 'user-info'
    assert.equal(sent.length, 2, 'operation changes never dispatch')
    assert.equal(button(render(), '读取下一页'), undefined, 'content cursors cannot become profile continuation')
    nodes(render()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await flush()
    assert.equal(sent[2].input.path, '/api/v1/data/social/user-info')
    assert.deepEqual(sent[2].input.body, { platform: 'twitter', user_id: 'ui_batch_019' })
    assert.notEqual(sent[2].idem, sent[0].idem)
  } finally { environment.access = previousAccess }
})

test('Twitter parameter edits are explicit intents and next page retains the exact successful parameters', async () => {
  const { StrategySearchExperience } = await view
  const previousAccess = environment.access
  environment.access = { platforms: ['twitter'], capabilities: [] }
  environment.identity = 'twitter-key'
  const cell = createStrategySearchCell('twitter'), session = new Map([['twitter-key', cell]]), sent = []
  cell.update({ form: { ...cell.getSnapshot().form, query: '关键词' } })
  environment.send = async (_key, input, idem) => {
    sent.push({ input, idem })
    return { payload: { data: { platform: 'twitter', items: [], pageInfo: { hasMore: true, nextCursor: 'mxds1.exact-next' } } }, evidence: { requestId: `twitter-${sent.length}` } }
  }
  const render = () => StrategySearchExperience({ strategySession: session })
  const select = (name, value) => nodes(render()).find(node => node.props?.label === name).props.onChange(value)
  const submit = async () => { nodes(render()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await flush() }
  try {
    assert.equal(nodes(render()).find(node => node.props?.label === '内容类别').props.value, 'Latest')
    assert.match(label(render()), /People 返回账号/)
    await submit()
    assert.deepEqual(sent[0].input.body.params, { category: 'Latest' })
    await submit()
    assert.equal(sent[1].idem, sent[0].idem, 'same conditions explicitly replay the same intent')
    select('内容类别', 'Photos')
    select('包含时间戳', 'false')
    nodes(render()).find(node => node.type === 'input' && node.props.maxLength === 2048).props.onChange({ target: { value: 'native-filter' } })
    assert.equal(sent.length, 2, 'editing never starts a new paid request')
    assert.equal(button(render(), '读取下一页'), undefined, 'new conditions cannot follow the previous result cursor')
    await submit()
    assert.deepEqual(sent[2].input.body.params, { category: 'Photos', includeTimestamp: false, filters: 'native-filter' })
    assert.notEqual(sent[2].idem, sent[0].idem)
    await button(render(), '读取下一页').props.onClick()
    assert.deepEqual(sent[3].input.body, { ...sent[2].input.body, cursor: 'mxds1.exact-next' })
    assert.notEqual(sent[3].idem, sent[2].idem)
  } finally { environment.access = previousAccess }
})

test('Twitter admission failure retries the same intent only on click and unknown outcomes lock the new controls', async () => {
  const { StrategySearchExperience } = await view
  const previousAccess = environment.access
  environment.access = { platforms: ['twitter', 'bilibili'], capabilities: [] }
  environment.identity = 'twitter-key'
  const cell = createStrategySearchCell('twitter'), session = new Map([['twitter-key', cell]]), sent = []
  cell.update({ form: { ...cell.getSnapshot().form, query: '关键词' } })
  environment.send = async (_key, input, idem) => {
    sent.push({ input, idem })
    if (sent.length === 1) throw Object.assign(new Error('admission unavailable'), {
      code: 'usage_admission_unavailable', responseBody: { error: { code: 'usage_admission_unavailable' } },
    })
    throw unknown()
  }
  const render = () => StrategySearchExperience({ strategySession: session })
  const submit = async () => { nodes(render()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await flush() }
  try {
    await submit()
    assert.equal(sent.length, 1)
    assert.equal(searchButton(render()).props.disabled, false)
    await submit()
    assert.equal(sent[1].idem, sent[0].idem)
    assert.equal(nodes(render()).find(node => node.props?.label === '内容类别').props.disabled, true)
    assert.equal(nodes(render()).find(node => node.props?.label === '包含时间戳').props.disabled, true)
    button(render(), '哔哩哔哩').props.onClick()
    button(render(), 'Twitter / X').props.onClick()
    assert.deepEqual(cell.getSnapshot().form.twitterParams, { category: 'Latest' })
    assert.equal(searchButton(render()).props.disabled, true)
    await submit()
    assert.equal(sent.length, 2, 'unknown remains locked after platform navigation and programmatic submission')
  } finally { environment.access = previousAccess }
})
