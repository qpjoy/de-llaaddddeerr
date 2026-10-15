import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createAcquisitionComparisonSession, acquisitionComparisonSessionFor } from '../../src/acquisition-comparison.js'
import { prepareTwitterRetry, sendTwitterRetry, checkTwitterRetry, twitterRetryPreparationValid, twitterRetryResponseIdentity } from '../../src/twitter-request-retry.js'

const oldId = 'ced3bb03-709d-438b-8d80-4deada7f8476'
const newId = 'a71c8fe2-fc05-400a-afce-3e5abcc1aed5'
const keyId = '11111111-2222-4333-8444-555555555555'
const otherId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const idem = 'twitter-new-idempotency'
const body = { platform: 'twitter', query: '("US semiconductor export" OR SMIC) AND #chipban', pageSize: 20, type: 'fresh' }
const preparation = () => ({ requestId: oldId, status: 'unknown', scope: { platform: 'twitter' },
  owner: { apiKeyId: keyId, apiKeyPrefix: 'mx_original', apiKeyLastFour: '1234' },
  requestEvidence: { idempotencyKey: 'original-idempotency', request: { method: 'POST', path: '/api/v1/data/search', body: structuredClone(body) } },
  eligibility: { allowed: true, reasonCode: 'eligible', message: '可重试' }, successor: null })
const successor = status => ({ requestId: newId, status, apiKeyId: keyId, idempotencyKey: idem,
  responseStatus: status === 'committed' ? 200 : status === 'unknown' ? 502 : null })
const options = { token: 'admin-token', requestId: oldId, newIdempotencyKey: () => idem }
const state = session => session.getSnapshot().twitterRetry
function setup({ latest = preparation(), response = null, finalStatus = 'committed', postError = null, credential = null } = {}) {
  const session = createAcquisitionComparisonSession(), calls = []
  let posted = false, current = latest
  const dependencies = {
    adminApi: {
      twitterRetryPreparation: async (token, id) => {
        calls.push(['prepare', token, id])
        return posted && finalStatus ? { ...preparation(), eligibility: { allowed: false, reasonCode: 'already_retried' }, successor: successor(finalStatus) } : structuredClone(current)
      },
      demoCredential: async (token, id) => { calls.push(['credential', token, id]); return credential || { keyId, secret: 'temporary-private-key' } },
    },
    publicDataApi: { twitterRetry: async (...args) => {
      calls.push(['post', ...args]); posted = true
      if (postError) throw postError
      return response || { status: 200, payload: { requestId: newId, data: { items: [] } },
        evidence: { requestId: newId, headerRequestId: newId, sourceMode: 'live' } }
    } },
  }
  return { session, calls, dependencies, setLatest: value => { current = value } }
}

test('prepare reads only the original request and never obtains credentials or dispatches', async () => {
  const f = setup()
  await prepareTwitterRetry(f.session, options, f.dependencies)
  assert.deepEqual(f.calls, [['prepare', 'admin-token', oldId]])
  assert.deepEqual(state(f.session).preparation.requestEvidence.request.body, body)
  assert.equal(state(f.session).attempt, null)
  for (const invalid of [
    { ...preparation(), requestId: otherId }, { ...preparation(), status: 'reserved' },
    { ...preparation(), scope: { platform: 'facebook' } },
    { ...preparation(), requestEvidence: { idempotencyKey: 'original', request: { method: 'POST', path: '/api/v1/search/raw', body } } },
    { ...preparation(), requestEvidence: { idempotencyKey: 'original', request: { method: 'POST', path: '/api/v1/data/search', body: { ...body, query: '[redacted]' } } } },
  ]) assert.equal(twitterRetryPreparationValid(invalid, oldId), false)
})

test('explicit confirmation preserves original body and identity and adds one fresh key with Retry-Of', async () => {
  const f = setup()
  await prepareTwitterRetry(f.session, options, f.dependencies)
  await sendTwitterRetry(f.session, options, f.dependencies)
  assert.deepEqual(f.calls.map(call => call[0]), ['prepare', 'prepare', 'credential', 'post', 'prepare'])
  assert.deepEqual(f.calls.find(call => call[0] === 'post'), ['post', 'temporary-private-key', body, idem, oldId])
  assert.equal(state(f.session).attempt.state, 'committed')
  assert.equal(state(f.session).attempt.requestId, newId)
  assert.equal(state(f.session).attempt.dispatched, true)
  assert.doesNotMatch(JSON.stringify(f.session.getSnapshot()), /temporary-private-key|admin-token/u)
  await sendTwitterRetry(f.session, options, f.dependencies)
  assert.equal(f.calls.filter(call => call[0] === 'post').length, 1)
})

test('denied preparation can omit saved body and original Key and never obtain credentials or dispatch', async () => {
  for (const missing of [{ owner: null, requestEvidence: { request: null } }, { requestEvidence: { request: null } }]) {
    const denied = { ...preparation(), ...missing, eligibility: { allowed: false, reasonCode: 'saved_request_unavailable', message: '历史参数不可用，不能重试。' } }
    assert.equal(twitterRetryPreparationValid(denied, oldId), true)
    const f = setup({ latest: denied })
    await prepareTwitterRetry(f.session, options, f.dependencies)
    assert.equal(state(f.session).error, null)
    assert.equal(state(f.session).preparation.eligibility.message, '历史参数不可用，不能重试。')
    await sendTwitterRetry(f.session, { ...options, newIdempotencyKey: () => assert.fail('denial cannot allocate a key') }, f.dependencies)
    assert.deepEqual(f.calls.map(call => call[0]), ['prepare'])
  }
})

test('synchronous send lock and App-owned session survive double-click and panel navigation', async () => {
  const reference = { current: null }, session = acquisitionComparisonSessionFor(reference, 'admin-token', oldId)
  const f = setup(); f.session = session
  await prepareTwitterRetry(session, options, f.dependencies)
  let release
  const wait = new Promise(resolve => { release = resolve })
  f.dependencies.adminApi.demoCredential = async () => { await wait; return { keyId, secret: 'temporary-private-key' } }
  const sending = sendTwitterRetry(session, options, f.dependencies)
  await sendTwitterRetry(session, options, f.dependencies)
  assert.equal(acquisitionComparisonSessionFor(reference, 'admin-token', oldId), session)
  assert.equal(state(session).busy, true)
  release(); await sending
  await sendTwitterRetry(acquisitionComparisonSessionFor(reference, 'admin-token', oldId), options, f.dependencies)
  assert.equal(f.calls.filter(call => call[0] === 'post').length, 1)
})

test('revalidation rejects revoked eligibility, changed source identity and existing successors before obtaining any key', async () => {
  for (const changed of [
    { ...preparation(), eligibility: { allowed: false } },
    { ...preparation(), owner: { apiKeyId: otherId } },
    { ...preparation(), requestEvidence: { ...preparation().requestEvidence, request: { ...preparation().requestEvidence.request, body: { ...body, query: 'changed' } } } },
    { ...preparation(), successor: successor('reserved') },
  ]) {
    const f = setup(); await prepareTwitterRetry(f.session, options, f.dependencies); f.setLatest(changed)
    await sendTwitterRetry(f.session, options, f.dependencies)
    assert.equal(f.calls.some(call => ['credential', 'post'].includes(call[0])), false)
    assert.equal(state(f.session).attempt.state, 'not_sent')
    assert.equal(state(f.session).attempt.dispatched, false)
  }
})

test('wrong original-key credential never dispatches and predispatch retries retain the allocated idempotency', async () => {
  const f = setup({ credential: { keyId: otherId, secret: 'wrong-secret' } })
  await prepareTwitterRetry(f.session, options, f.dependencies)
  await sendTwitterRetry(f.session, options, f.dependencies)
  assert.equal(state(f.session).attempt.state, 'not_sent')
  f.dependencies.adminApi.demoCredential = async () => ({ keyId, secret: 'original-secret' })
  await sendTwitterRetry(f.session, { ...options, newIdempotencyKey: () => assert.fail('reuse existing key') }, f.dependencies)
  assert.equal(f.calls.find(call => call[0] === 'post')[3], idem)
  assert.equal(f.calls.filter(call => call[0] === 'post').length, 1)
})

test('network uncertainty never repeats POST and only the exact successor can resolve it by read-only GET', async () => {
  const f = setup({ postError: new TypeError('network private-key-detail'), finalStatus: null })
  await prepareTwitterRetry(f.session, options, f.dependencies)
  await sendTwitterRetry(f.session, options, f.dependencies)
  assert.equal(state(f.session).attempt.state, 'uncertain')
  assert.doesNotMatch(JSON.stringify(state(f.session)), /private-key-detail/u)
  await sendTwitterRetry(f.session, options, f.dependencies)
  await checkTwitterRetry(f.session, options, f.dependencies)
  assert.equal(state(f.session).attempt.state, 'uncertain')
  for (const wrong of [{ ...successor('committed'), idempotencyKey: 'other-attempt' }, { ...successor('committed'), apiKeyId: otherId }]) {
    f.setLatest({ ...preparation(), eligibility: { allowed: false }, successor: wrong })
    await checkTwitterRetry(f.session, options, f.dependencies)
    assert.equal(state(f.session).attempt.state, 'uncertain')
  }
  f.setLatest({ ...preparation(), eligibility: { allowed: false }, successor: successor('committed') })
  await checkTwitterRetry(f.session, options, f.dependencies)
  assert.equal(state(f.session).attempt.state, 'committed')
  assert.equal(f.calls.filter(call => call[0] === 'post').length, 1)
})

test('pending and unknown successor states are shown honestly and never permit another send', async () => {
  for (const finalStatus of ['reserved', 'unknown', 'released', 'committed']) {
    const response = { status: 502, payload: { requestId: newId, error: { code: 'social_upstream_outcome_unknown' } },
      evidence: { requestId: newId, headerRequestId: newId } }
    const f = setup({ response, finalStatus })
    await prepareTwitterRetry(f.session, options, f.dependencies)
    await sendTwitterRetry(f.session, options, f.dependencies)
    assert.equal(state(f.session).attempt.state, finalStatus)
    assert.equal(state(f.session).attempt.response.status, 502, 'observed browser response is not overwritten by ledger')
    await sendTwitterRetry(f.session, options, f.dependencies)
    assert.equal(f.calls.filter(call => call[0] === 'post').length, 1)
  }
})

test('HTTP correlation requires body/header identity; ambiguous responses remain blocked without a matching ledger', async () => {
  for (const response of [
    { status: 200, payload: {}, evidence: {} },
    { status: 502, payload: { requestId: newId, error: { code: 'proxy_error' } }, evidence: { requestId: newId, headerRequestId: otherId } },
  ]) {
    const f = setup({ response, finalStatus: null })
    await prepareTwitterRetry(f.session, options, f.dependencies); await sendTwitterRetry(f.session, options, f.dependencies)
    assert.equal(state(f.session).attempt.responseRequestId, null)
    assert.equal(state(f.session).attempt.state, 'uncertain')
    await sendTwitterRetry(f.session, options, f.dependencies)
    assert.equal(f.calls.filter(call => call[0] === 'post').length, 1)
  }
  assert.equal(twitterRetryResponseIdentity({ body: { requestId: newId }, evidence: { requestId: newId, headerRequestId: newId } }), newId)
})

test('preparation finds an existing successor after page reload and does not allocate another request', async () => {
  const f = setup({ latest: { ...preparation(), eligibility: { allowed: false, message: '已有重试' }, successor: successor('unknown') } })
  await prepareTwitterRetry(f.session, options, f.dependencies)
  await sendTwitterRetry(f.session, { ...options, newIdempotencyKey: () => assert.fail('no duplicate') }, f.dependencies)
  assert.deepEqual(f.calls.map(call => call[0]), ['prepare'])
  assert.equal(state(f.session).preparation.successor.requestId, newId)
})

test('browser API uses readonly prepare GET and fixed Twitter POST with original body and Retry-Of', async t => {
  const source = (await readFile(new URL('../../src/api.js', import.meta.url), 'utf8'))
    .replaceAll('import.meta.env', '({})')
    .replace(/from '([^']+)'/gu, (_match, path) => `from ${JSON.stringify(new URL(path, new URL('../../src/api.js', import.meta.url)).href)}`)
  const api = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options })
    return Response.json({ data: preparation(), requestId: newId }, { headers: { 'x-mx-insight-request-id': otherId } })
  })
  await api.adminApi.twitterRetryPreparation('admin-token', oldId)
  assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.body, undefined)
  assert.equal(calls[0].url, `/internal/v1/admin/acquisitions/${oldId}/twitter-retry`)
  api.configurePublicApiBase('https://public-hub.example')
  const response = await api.publicDataApi.twitterRetry('original-key-ticket', body, idem, oldId)
  assert.equal(calls[1].url, 'https://public-hub.example/api/v1/data/search')
  assert.equal(calls[1].options.method, 'POST')
  assert.deepEqual(JSON.parse(calls[1].options.body), body)
  assert.equal(calls[1].options.headers.authorization, 'Bearer original-key-ticket')
  assert.equal(calls[1].options.headers['idempotency-key'], idem)
  assert.equal(calls[1].options.headers['x-mx-insight-retry-of'], oldId)
  assert.equal(response.evidence.headerRequestId, otherId, 'retain header independently to detect mismatched IDs')
})

test('rendered retry panel shows readonly preparation, explicit charge consent and locked uncertain state', async () => {
  const { transform } = await import('esbuild')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const React = await import('react')
  let source = await readFile(new URL('../../src/twitter-request-retry.jsx', import.meta.url), 'utf8')
  source = source.replace("import { useSyncExternalStore } from 'react'", 'const useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot()')
    .replace("import { adminApi, publicDataApi } from './api.js'", 'const adminApi = {}, publicDataApi = {}')
    .replace("import { ErrorState } from './components.jsx'", 'const ErrorState = ({error}) => error.message')
    .replace("from './twitter-request-retry.js'", `from ${JSON.stringify(new URL('../../src/twitter-request-retry.js', import.meta.url).href)}`)
  const compiled = (await transform(source, { loader: 'jsx', format: 'esm', jsx: 'automatic' })).code
    .replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve('react/jsx-runtime')))
  const { TwitterRequestRetry } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
  const f = setup(), render = () => renderToStaticMarkup(React.createElement(TwitterRequestRetry, { token: 'admin-token', run: { requestId: oldId }, session: f.session }))
  assert.match(render(), /准备按原参数重试 Twitter/u)
  assert.doesNotMatch(render(), /确认按当前链路重试/u)
  await prepareTwitterRetry(f.session, options, f.dependencies)
  assert.match(render(), /确认按当前链路重试（可能再次计费）/u)
  assert.match(render(), /readonly=""/iu)
  assert.match(render(), /原请求可能已经计费/u)
  await sendTwitterRetry(f.session, options, f.dependencies)
  assert.doesNotMatch(render(), /确认按当前链路重试/u)
  assert.match(render(), /只读核对重试结果/u)
  assert.match(render(), /查看新请求诊断与结算/u)
  assert.doesNotMatch(render(), /temporary-private-key/u)
  const denied = setup({ latest: { ...preparation(), owner: null, requestEvidence: { request: null },
    eligibility: { allowed: false, reasonCode: 'saved_request_unavailable', message: '历史参数不可用，不能重试。' } } })
  await prepareTwitterRetry(denied.session, options, denied.dependencies)
  const deniedHtml = renderToStaticMarkup(React.createElement(TwitterRequestRetry, { token: 'admin-token', run: { requestId: oldId }, session: denied.session }))
  assert.match(deniedHtml, /历史参数不可用，不能重试。/u)
  assert.doesNotMatch(deniedHtml, /确认按当前链路重试|<textarea/u)
})
