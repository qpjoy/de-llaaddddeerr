import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createSearchAdmissionDispositionSession, searchAdmissionDispositionSessionFor,
  canConfirmSearchAdmissionDisposition, searchAdmissionDispositionValid } from '../../src/search-admission-disposition.js'

const id = '567255e8-fef1-4471-9dd9-1247f068bc99'
const otherId = '730a3f06-3c06-42c1-a096-108e790b811d'
const token = 'test-admin-token'
const scope = { platform: 'twitter', tenantId: '11111111-1111-4111-8111-111111111111',
  consumerId: '22222222-2222-4222-8222-222222222222', apiKeyId: '33333333-3333-4333-8333-333333333333', query: 'saved query' }
const prepared = () => ({ requestId: id, scope: { ...scope }, revision: 'original-revision',
  eligibility: { allowed: true, reasonCode: null, message: '可以确认恢复后续采集。' }, disposition: null, upstreamDispatched: false })
const saved = () => ({ ...prepared(), eligibility: { allowed: false, message: '已保存' },
  disposition: { effective: true, actor: 'admin-token', reason: '接受未知风险，恢复后续采集', createdAt: '2026-10-28T08:00:00.000Z' } })
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function fixture({ read = async () => prepared(), write = async () => saved(), session = null } = {}) {
  const calls = []
  const api = {
    async searchAdmissionDisposition(...args) { calls.push(['GET', ...args]); return read(...args) },
    async dispositionSearchAdmission(...args) { calls.push(['POST', ...args]); return write(...args) },
  }
  const store = session ? searchAdmissionDispositionSessionFor(session, token, id, api)
    : createSearchAdmissionDispositionSession({ token, requestId: id }, api)
  return { store, calls, api }
}
async function ready(store) {
  await store.read()
  store.setReason(' 接受未知风险，恢复后续采集 ')
  store.openConfirmation()
}

test('preparation is GET only; explicit reason and confirmation authorize exactly the reviewed request and revision', async () => {
  const { store, calls } = fixture()
  await store.confirm()
  assert.deepEqual(calls, [])
  await store.read()
  assert.deepEqual(calls, [['GET', token, id]])
  assert.equal(canConfirmSearchAdmissionDisposition(store.getSnapshot()), false)
  store.setReason('确认恢复')
  await store.confirm()
  assert.equal(calls.length, 1, 'a reason alone is not confirmation')
  store.openConfirmation()
  await store.confirm()
  assert.deepEqual(calls[1], ['POST', token, id, { revision: 'original-revision', reason: '确认恢复', acceptUnknownRisk: true }])
  assert.equal(store.getSnapshot().outcome, 'confirmed')
  assert.equal(store.getSnapshot().data.upstreamDispatched, false)
  store.openConfirmation(); await store.confirm()
  assert.equal(calls.length, 2)
  assert.doesNotMatch(JSON.stringify(store.getSnapshot()), /test-admin-token/u)
})

test('concurrent clicks cannot duplicate reads or writes', async () => {
  const get = deferred(), post = deferred()
  const { store, calls } = fixture({ read: () => get.promise, write: () => post.promise })
  const first = store.read(); await store.read()
  get.resolve(prepared()); await first
  store.setReason('确认解除当前阻塞'); store.openConfirmation()
  const sending = store.confirm(); await store.confirm(); await store.read()
  assert.deepEqual(calls.map(call => call[0]), ['GET', 'POST'])
  store.setReason('不能改写已提交原因')
  assert.equal(store.getSnapshot().attempt.reason, '确认解除当前阻塞')
  post.resolve(saved()); await sending
})

test('lost write response retains the original revision and only reads until saved disposition is confirmed', async () => {
  let current = prepared()
  const { store, calls } = fixture({ read: async () => current, write: async () => { throw new TypeError('Network response lost') } })
  await ready(store); await store.confirm()
  assert.equal(store.getSnapshot().outcome, 'uncertain')
  assert.equal(store.getSnapshot().attempt.revision, 'original-revision')
  current = { ...prepared(), revision: 'newer-revision' }
  await store.read()
  assert.equal(store.getSnapshot().outcome, 'uncertain', 'no saved disposition is not proof of failed write')
  assert.equal(store.getSnapshot().attempt.revision, 'original-revision')
  store.openConfirmation(); await store.confirm()
  assert.equal(calls.filter(call => call[0] === 'POST').length, 1)
  current = saved(); await store.read()
  assert.equal(store.getSnapshot().outcome, 'confirmed')
  assert.equal(store.getSnapshot().attempt.revision, 'original-revision')
})

test('invalid or mismatched write responses never claim success or permit another write', async () => {
  for (const response of [prepared(), { ...saved(), requestId: otherId }, { ...saved(), upstreamDispatched: true },
    { ...saved(), scope: { ...scope, query: 'different query' } }, { ...saved(), disposition: {} }]) {
    const { store, calls } = fixture({ write: async () => response })
    await ready(store); await store.confirm()
    assert.equal(store.getSnapshot().outcome, 'uncertain')
    store.openConfirmation(); await store.confirm()
    assert.equal(calls.filter(call => call[0] === 'POST').length, 1)
  }
})

test('denial, invalid identity, absent token, or failed recheck cannot authorize a mutation', async () => {
  for (const response of [{ ...prepared(), eligibility: { allowed: false, message: '仍在处理中' } },
    { ...prepared(), requestId: otherId }, { ...prepared(), scope: { ...scope, apiKeyId: null } },
    { ...prepared(), revision: '' }, { ...prepared(), upstreamDispatched: true }]) {
    const { store, calls } = fixture({ read: async () => response })
    await ready(store); await store.confirm()
    assert.equal(calls.filter(call => call[0] === 'POST').length, 0)
  }
  const noToken = createSearchAdmissionDispositionSession({ token: '', requestId: id }, {
    searchAdmissionDisposition() { assert.fail('no token must not access API') },
  })
  await noToken.read()
  let fail = false
  const { store, calls } = fixture({ read: async () => { if (fail) throw new Error('read failed'); return prepared() } })
  await ready(store); fail = true; await store.read(); store.openConfirmation(); await store.confirm()
  assert.equal(calls.filter(call => call[0] === 'POST').length, 0)
})

test('a stale revision rejection requires a new GET and explicit confirmation before trying its new revision', async () => {
  let current = prepared(), reject = true
  const { store, calls } = fixture({ read: async () => current, write: async () => {
    if (reject) throw Object.assign(new Error('revision changed'), { status: 409 })
    return saved()
  } })
  await ready(store); await store.confirm()
  assert.equal(store.getSnapshot().outcome, 'rejected')
  store.openConfirmation(); await store.confirm()
  assert.equal(calls.filter(call => call[0] === 'POST').length, 1)
  current = { ...prepared(), revision: 'reviewed-new-revision' }
  await store.read()
  assert.equal(calls.filter(call => call[0] === 'POST').length, 1)
  reject = false; store.openConfirmation(); await store.confirm()
  assert.equal(calls.at(-1)[3].revision, 'reviewed-new-revision')
})

test('changing token or request isolates pending read and write completions', async () => {
  for (const change of [{ token: 'new-admin-token', requestId: id }, { token, requestId: otherId }]) {
    const session = {}, read = deferred()
    const f = fixture({ session, read: () => read.promise })
    const waiting = f.store.read()
    const next = searchAdmissionDispositionSessionFor(session, change.token, change.requestId, f.api)
    read.resolve(prepared()); await waiting
    assert.equal(next.getSnapshot().data, null)
    assert.equal(next.getSnapshot().outcome, 'idle')
    assert.notEqual(next, f.store)
  }
  const session = {}, write = deferred(), f = fixture({ session, write: () => write.promise })
  await ready(f.store); const pending = f.store.confirm()
  const next = searchAdmissionDispositionSessionFor(session, 'new-admin-token', id, f.api)
  write.resolve(saved()); await pending
  assert.equal(next.getSnapshot().data, null)
  assert.equal(next.getSnapshot().attempt, null)
  assert.equal(searchAdmissionDispositionSessionFor(session, 'new-admin-token', id, f.api), next)
})

test('read-only rechecks after an uncertain write cannot retarget its original scope', async () => {
  let current = prepared()
  const { store } = fixture({ read: async () => current, write: async () => { throw new Error('lost response') } })
  await ready(store); await store.confirm()
  current = { ...saved(), scope: { ...scope, consumerId: otherId } }
  await store.read()
  assert.equal(store.getSnapshot().outcome, 'uncertain')
  assert.equal(store.getSnapshot().data.disposition, null)
})

test('browser transport uses the fixed Admin endpoint and token for GET and POST without public dispatch', async t => {
  const source = (await readFile(new URL('../../src/api.js', import.meta.url), 'utf8'))
    .replaceAll('import.meta.env', '({})')
    .replace(/from '([^']+)'/gu, (_match, path) => `from ${JSON.stringify(new URL(path, new URL('../../src/api.js', import.meta.url)).href)}`)
  const { adminApi } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push({ url, options }); return Response.json({ data: prepared() }) })
  await adminApi.searchAdmissionDisposition(token, id)
  const body = { revision: 'revision', reason: '确认解除阻塞', acceptUnknownRisk: true }
  await adminApi.dispositionSearchAdmission(token, id, body)
  assert.deepEqual(calls.map(call => call.url), Array(2).fill(`/internal/v1/admin/acquisitions/${id}/search-admission-disposition`))
  assert.deepEqual(calls.map(call => call.options.method), ['GET', 'POST'])
  assert.equal(calls[0].options.body, undefined)
  assert.deepEqual(JSON.parse(calls[1].options.body), body)
  assert.ok(calls.every(call => call.options.headers['x-mx-insight-admin-token'] === token))
})

test('DTO validation permits explanatory denials but never treats missing mutation evidence as success', () => {
  assert.equal(searchAdmissionDispositionValid({ requestId: id, eligibility: { allowed: false }, disposition: null, upstreamDispatched: false }, id), true)
  assert.equal(searchAdmissionDispositionValid(saved(), id), true)
  assert.equal(searchAdmissionDispositionValid({ ...saved(), disposition: { ...saved().disposition, createdAt: 'invalid' } }, id), false)
  assert.equal(searchAdmissionDispositionValid({ ...saved(), disposition: { ...saved().disposition, effective: undefined } }, id), false)
})

test('a saved but ineffective disposition is retained as stale and never authorizes another write', async () => {
  const stale = { ...saved(), disposition: { ...saved().disposition, effective: false } }
  for (const initialWrite of [false, true]) {
    const { store, calls } = fixture({ read: async () => initialWrite ? prepared() : stale, write: async () => stale })
    if (initialWrite) { await ready(store); await store.confirm() } else await store.read()
    assert.equal(store.getSnapshot().outcome, 'stale')
    assert.equal(store.getSnapshot().data.disposition.reason, stale.disposition.reason)
    assert.equal(canConfirmSearchAdmissionDisposition(store.getSnapshot()), false)
    store.openConfirmation(); await store.confirm()
    assert.equal(calls.filter(call => call[0] === 'POST').length, initialWrite ? 1 : 0)
  }
})

test('rendered panel separates read-only preparation, explicit confirmation, uncertain response, and saved outcome', async () => {
  const { transform } = await import('esbuild')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const React = await import('react')
  let source = await readFile(new URL('../../src/search-admission-disposition.jsx', import.meta.url), 'utf8')
  source = source.replace("import { useEffect, useSyncExternalStore } from 'react'", 'const useEffect = () => {}; const useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot()')
    .replace("import { adminApi } from './api.js'", 'const adminApi = {}')
    .replace("import { ConfirmDialog, ErrorState } from './components.jsx'", 'const ErrorState = ({error}) => error.message; const ConfirmDialog = ({title,description,confirmLabel,children}) => <div role="alertdialog"><h2>{title}</h2><p>{description}</p>{children}<button>{confirmLabel}</button></div>')
    .replace("from './search-admission-disposition.js'", `from ${JSON.stringify(new URL('../../src/search-admission-disposition.js', import.meta.url).href)}`)
  const compiled = (await transform(source, { loader: 'jsx', format: 'esm', jsx: 'automatic' })).code
    .replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve('react/jsx-runtime')))
  const { SearchAdmissionDisposition } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
  let current = prepared()
  const session = {}, f = fixture({ session, read: async () => current, write: async () => { throw new Error('lost response') } })
  const render = () => renderToStaticMarkup(React.createElement(SearchAdmissionDisposition, { token, run: { requestId: id }, session }))
  assert.match(render(), /查看后续采集恢复条件/u)
  assert.doesNotMatch(render(), /解除此历史请求的阻塞…|alertdialog/u)
  await ready(f.store)
  const confirmation = render()
  assert.match(confirmation, /role="alertdialog"/u)
  assert.match(confirmation, /确认接受未知风险并解除此阻塞/u)
  for (const phrase of ['不补回原页', '后续调度可能产生正常费用', '其他阻塞请求仍独立生效', '保留旧 unknown 状态和账务']) assert.ok(confirmation.includes(phrase))
  await f.store.confirm()
  assert.match(render(), /操作结果尚未确认/u)
  assert.match(render(), /original-revision/u)
  assert.doesNotMatch(render(), /解除此历史请求的阻塞…|已确认解除/u)
  current = saved(); await f.store.read()
  assert.match(render(), /已确认解除该历史请求/u)
  assert.match(render(), /其他阻塞请求仍可能阻挡/u)
  assert.doesNotMatch(render(), /解除此历史请求的阻塞…|<textarea/u)
  current = { ...saved(), scope: { ...scope, query: null }, disposition: { ...saved().disposition, effective: false } }
  await f.store.read()
  assert.match(render(), /当前保护仍生效/u)
  assert.match(render(), /接受未知风险，恢复后续采集/u)
  assert.doesNotMatch(render(), /已确认解除该历史请求|解除此历史请求的阻塞…|<textarea/u)
  current = { ...saved(), disposition: { ...saved().disposition, effective: undefined } }
  await f.store.read()
  assert.match(render(), /尚未核实处置当前是否有效/u)
  assert.doesNotMatch(render(), /已确认解除该历史请求/u)
})
