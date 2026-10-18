import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const environment = {}
globalThis.__telegramProductUi = environment
const components = await readFile(new URL('../../src/components.jsx', import.meta.url), 'utf8')
const remoteHook = components.slice(components.indexOf('export function useRemoteData('), components.indexOf('export function PageHeading('))
const view = build({
  stdin: { contents: "export { TelegramPage } from './pages-data-products.jsx'", loader: 'js', resolveDir: fileURLToPath(new URL('../../src/', import.meta.url)) },
  bundle: true, format: 'esm', jsx: 'automatic', platform: 'node', write: false,
  plugins: [{ name: 'telegram-ui-boundaries', setup(builder) {
    builder.onResolve({ filter: /^react\/jsx-runtime$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }))
    builder.onResolve({ filter: /^react$|^@phosphor-icons\/react$|^\.\/(?:api\.js|components\.jsx)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => {
      let contents
      if (path === 'react') contents = `const env=globalThis.__telegramProductUi;
        export const useState=initial=>env.useState(initial),useRef=value=>env.useRef(value),useMemo=(fn,deps)=>env.useMemo(fn,deps),
          useCallback=(fn,deps)=>env.useMemo(()=>fn,deps),useEffect=(fn,deps)=>env.useEffect(fn,deps),useLayoutEffect=useEffect;`
      else if (path === '@phosphor-icons/react') contents = 'export const ArrowLeft=()=>null,ArrowRight=()=>null,ArrowSquareOut=()=>null,Broadcast=()=>null,ChatCircleText=()=>null,CheckCircle=()=>null,Clock=()=>null,Database=()=>null,Fire=()=>null,GlobeHemisphereWest=()=>null,Info=()=>null,MagnifyingGlass=()=>null,MapPin=()=>null,MapTrifold=()=>null,NewspaperClipping=()=>null,Pulse=()=>null,TelegramLogo=()=>null,Users=()=>null,Warning=()=>null'
      else if (path === './api.js') contents = 'export const adminApi=new Proxy({}, {get:(_,name)=>(...args)=>globalThis.__telegramProductUi.api[name](...args)})'
      else contents = `import { useState,useEffect,useCallback } from 'react'; ${remoteHook}
        export const EmptyState=()=>null,ErrorState=()=>null,LoadingState=()=>null,Modal=()=>null,PageHeading=()=>null,StatusBadge=()=>null;`
      return { contents, loader: 'js' }
    })
  } }],
}).then(({ outputFiles }) => import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`))

const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...(Array.isArray(tree.props?.children) ? tree.props.children.flat(Infinity) : [tree.props?.children]).flatMap(nodes)]
const label = tree => typeof tree === 'string' || typeof tree === 'number' ? String(tree)
  : Array.isArray(tree) ? tree.map(label).join('') : tree?.props ? label(tree.props.children) : ''
const button = (tree, text) => nodes(tree).find(node => node.type === 'button' && label(node) === text)
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const pageInfo = (nextCursor = null) => ({ returnedCount: 1, hasMore: Boolean(nextCursor), nextCursor })
const searchResult = (text, cursor = null) => ({ items: [{ canonicalId: text, text }], pageInfo: pageInfo(cursor), searchMode: 'postgres' })

async function fixture() {
  const { TelegramPage } = await view
  const hooks = [], directoryCalls = [], messageCalls = [], searchCalls = [], semanticCalls = []
  let index = 0, effects = [], dirty = true, tree
  const same = (left, right) => left && right && left.length === right.length && left.every((item, i) => Object.is(item, right[i]))
  environment.useState = initial => {
    const i = index++
    if (!(i in hooks)) hooks[i] = { value: typeof initial === 'function' ? initial() : initial }
    return [hooks[i].value, update => {
      const value = typeof update === 'function' ? update(hooks[i].value) : update
      if (!Object.is(value, hooks[i].value)) { hooks[i].value = value; dirty = true }
    }]
  }
  environment.useRef = value => { const i = index++; return hooks[i] ||= { current: value } }
  environment.useMemo = (fn, deps) => {
    const i = index++
    if (!same(hooks[i]?.deps, deps)) hooks[i] = { value: fn(), deps }
    return hooks[i].value
  }
  environment.useEffect = (fn, deps) => {
    const i = index++
    if (same(hooks[i]?.deps, deps)) return
    const cleanup = hooks[i]?.cleanup
    hooks[i] = { deps }
    effects.push(() => { cleanup?.(); hooks[i].cleanup = fn() })
  }
  const controls = {
    directory: async query => ({ items: [{ chatKey: `${query.sourceScope}:chat-${query.cursor ? 2 : 1}`, externalId: '-100123', sourceScope: query.sourceScope === 'all' ? 'monitor' : query.sourceScope, kind: 'group', title: `${query.sourceScope} chat` }], pageInfo: pageInfo(query.cursor ? null : 'directory-next') }),
    search: async body => searchResult(`${body.query}-${body.cursor || 'first'}`, body.cursor ? null : 'search-next'),
    semantic: async () => ({ items: [{ canonicalId: 'semantic-hit', text: '相关领导活动', semanticSimilarity: 0.82, chatId: '-100123' }], pageInfo: { returnedCount: 1, nextCursor: null, paginationMode: 'top_k' }, retrieval: { mode: 'semantic', coverage: 'unknown', exhaustive: false } }),
  }
  environment.api = {
    dataProductTelegramChats: (_token, query) => { directoryCalls.push(query); return controls.directory(query) },
    dataProductTelegramMessages: async (_token, chatId, query) => { messageCalls.push({ chatId, ...query }); return { items: [{ canonicalId: 'stored-message', text: 'stored transcript' }], pageInfo: pageInfo() } },
    searchDataProductTelegram: (_token, body) => { searchCalls.push(body); return controls.search(body) },
    telegramSemanticSearch: (_token, body) => { semanticCalls.push(body); return controls.semantic(body) },
  }
  const query = new URLSearchParams()
  const render = () => {
    for (let attempts = 0; dirty || !tree; attempts++) {
      assert.ok(attempts < 30, 'component effects settle')
      dirty = false; index = 0
      const element = TelegramPage({ token: 'synthetic-admin', query })
      tree = element.type(element.props)
      const pending = effects; effects = []; pending.forEach(fn => fn())
    }
    return tree
  }
  const flush = async () => { for (let i = 0; i < 4; i++) { render(); await new Promise(resolve => setImmediate(resolve)) }; return render() }
  const draft = value => nodes(render()).find(node => node.props?.['aria-label'] === '搜索全部 Telegram 消息').props.onChange({ target: { value } })
  const submit = async value => {
    draft(value)
    nodes(render()).find(node => node.type === 'form' && node.props.className === 'mih-tg-search').props.onSubmit({ preventDefault() {} })
    await flush()
  }
  const searchPager = () => nodes(render()).find(node => node.props?.onNext && node.props?.loading === false && node !== directoryPager())
  const directoryPager = () => nodes(render()).find(node => node.props?.onNext)
  await flush()
  return { render, flush, draft, submit, controls, directoryCalls, messageCalls, searchCalls, semanticCalls, searchPager, directoryPager }
}

test('Telegram initial reading is bounded and search continuation freezes the submitted conditions', async () => {
  const h = await fixture()
  assert.equal(h.directoryCalls.length, 1)
  assert.deepEqual(h.messageCalls, [{ chatId: 'all:chat-1', sourceScope: 'all', pageSize: 30 }])
  await h.submit('alpha')
  h.draft('unsubmitted beta')
  h.searchPager().props.onNext(); await h.flush()
  assert.deepEqual(h.searchCalls, [
    { query: 'alpha', sourceScope: 'all', kind: 'all', pageSize: 20 },
    { query: 'alpha', sourceScope: 'all', kind: 'all', pageSize: 20, cursor: 'search-next' },
  ])
  assert.equal(h.searchPager().props.page, 2)
  assert.match(label(h.render()), /当前条件：alpha/)
  assert.match(label(h.render()), /全部类型全局检索结果/)
  assert.match(label(h.render()), /AND \/ OR 不作为运算符/)
  h.searchPager().props.onPrevious(); await h.flush()
  assert.deepEqual(h.searchCalls[2], h.searchCalls[0])
  await h.submit('beta')
  assert.equal(h.searchPager().props.page, 1)
  assert.equal(h.searchCalls.at(-1).cursor, undefined)
  assert.equal(h.searchCalls.at(-1).query, 'beta')
})

test('failed Telegram continuation keeps the current page and retries the same cursor explicitly', async () => {
  const h = await fixture()
  await h.submit('alpha')
  h.controls.search = async () => { throw new Error('synthetic page failure') }
  h.searchPager().props.onNext(); await h.flush()
  assert.equal(h.searchPager().props.page, 1)
  assert.match(label(h.render()), /alpha-first/)
  assert.ok(nodes(h.render()).some(node => node.props?.error?.message === 'synthetic page failure'))
  h.controls.search = async () => ({ items: [], pageInfo: pageInfo('empty-but-continuable') })
  h.searchPager().props.onNext(); await h.flush()
  assert.equal(h.searchCalls.at(-1).cursor, 'search-next')
  assert.equal(h.searchPager().props.page, 2)
  assert.equal(h.searchPager().props.hasMore, true, 'an empty page with a valid continuation is not treated as exhausted')
})

test('switching Telegram source resets directory cursors atomically and discards pending search results', async () => {
  const h = await fixture()
  h.directoryPager().props.onNext(); await h.flush()
  assert.equal(h.directoryCalls.at(-1).cursor, 'directory-next')
  await h.submit('alpha')
  const pendingSearch = deferred()
  h.controls.search = () => pendingSearch.promise
  h.searchPager().props.onNext(); await h.flush()
  const beforeSwitch = h.directoryCalls.length
  button(h.render(), 'SQLite').props.onClick(); await h.flush()
  assert.deepEqual(h.directoryCalls.slice(beforeSwitch), [{ sourceScope: 'sqlite', kind: 'all', query: undefined, pageSize: 30, cursor: undefined }])
  assert.equal(h.messageCalls.some(call => call.sourceScope === 'sqlite' && call.chatId.startsWith('all:')), false)
  pendingSearch.resolve(searchResult('STALE_SEARCH')); await h.flush()
  assert.doesNotMatch(label(h.render()), /STALE_SEARCH|当前条件：alpha/)
  assert.equal(h.searchPager(), undefined)
})

test('new directory filters hide stale chats while loading and late directory responses cannot change the selected source', async () => {
  const h = await fixture()
  const oldDirectory = deferred()
  h.controls.directory = query => query.sourceScope === 'monitor' ? oldDirectory.promise
    : Promise.resolve({ items: [{ chatKey: 'sqlite:new-chat', title: 'SQLite current', kind: 'group' }], pageInfo: pageInfo() })
  button(h.render(), 'Monitor').props.onClick(); await h.flush()
  assert.doesNotMatch(label(h.render()), /all chat/)
  button(h.render(), 'SQLite').props.onClick(); await h.flush()
  oldDirectory.resolve({ items: [{ chatKey: 'monitor:old-chat', title: 'STALE_DIRECTORY', kind: 'group' }], pageInfo: pageInfo() })
  await h.flush()
  assert.doesNotMatch(label(h.render()), /STALE_DIRECTORY/)
  assert.match(label(h.render()), /SQLite current/)
  assert.equal(h.messageCalls.at(-1).chatId, 'sqlite:new-chat')
  assert.equal(h.messageCalls.some(call => call.chatId === 'monitor:old-chat'), false)
})

test('changing kind also discards a pending global search when the directory has no selected chat', async () => {
  const h = await fixture()
  h.controls.directory = async () => ({ items: [], pageInfo: pageInfo() })
  button(h.render(), '频道').props.onClick(); await h.flush()
  const pending = deferred()
  h.controls.search = () => pending.promise
  await h.submit('alpha')
  button(h.render(), '群组').props.onClick(); await h.flush()
  pending.resolve(searchResult('STALE_KIND_RESULT')); await h.flush()
  assert.doesNotMatch(label(h.render()), /STALE_KIND_RESULT|当前条件：alpha/)
  assert.equal(h.searchPager(), undefined)
})

test('Telegram RAG is manual bounded retrieval with source filters and no cursor controls', async () => {
  const h = await fixture()
  button(h.render(), 'RAG 语义').props.onClick(); await h.flush()
  assert.equal(h.semanticCalls.length, 0, 'mode selection does not dispatch a model query')
  assert.ok(nodes(h.render()).some(node => node.props?.item?.text === 'stored transcript'), 'switching search mode preserves already loaded history')
  await h.submit('领导人')
  assert.deepEqual(h.semanticCalls, [{ query: '领导人', sourceScope: 'all', topK: 20 }])
  assert.equal(h.searchCalls.length, 0)
  assert.equal(h.searchPager(), undefined)
  assert.match(label(h.render()), /相关领导活动/)
  assert.match(label(h.render()), /相似度 0\.820/)
  assert.match(label(h.render()), /覆盖率未知/)
  assert.match(label(h.render()), /不是概率/)
  assert.match(label(h.render()), /向量检索不可用时返回错误，不自动回退全文/)
  assert.doesNotMatch(label(h.render()), /ES 不可用时允许退化到 PG/)
  button(h.render(), '当前会话').props.onClick(); await h.flush()
  nodes(h.render()).find(node => node.type === 'form' && node.props.className === 'mih-tg-search').props.onSubmit({ preventDefault() {} })
  await h.flush()
  assert.deepEqual(h.semanticCalls.at(-1), { query: '领导人', chatId: '-100123', sourceScope: 'monitor', topK: 20 })
})

test('Telegram search mode changes discard stale RAG responses and never silently use literal search', async () => {
  const h = await fixture()
  const pending = deferred()
  h.controls.semantic = () => pending.promise
  button(h.render(), 'RAG 语义').props.onClick(); await h.flush()
  await h.submit('领导人')
  button(h.render(), '包含查找').props.onClick(); await h.flush()
  pending.resolve(searchResult('STALE_SEMANTIC')); await h.flush()
  assert.doesNotMatch(label(h.render()), /STALE_SEMANTIC/)
  assert.equal(h.searchCalls.length, 0)
  h.controls.semantic = async () => { throw new Error('vector unavailable') }
  button(h.render(), 'RAG 语义').props.onClick(); await h.flush()
  await h.submit('领导人')
  assert.ok(nodes(h.render()).some(node => node.props?.error?.message === 'vector unavailable'))
  assert.match(label(h.render()), /结果未确认/)
  assert.equal(h.searchCalls.length, 0)
})
