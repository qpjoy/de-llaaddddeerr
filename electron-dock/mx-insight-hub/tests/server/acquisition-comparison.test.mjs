import assert from 'node:assert/strict'
import test from 'node:test'
import { canCompareAcquisition, createAcquisitionComparison, comparisonOutcome, comparisonUnavailableReason, createAcquisitionComparisonSession, acquisitionComparisonSessionFor, sendAcquisitionComparison, comparisonResultMessage, XHS_NATIVE_SEARCH_PATH } from '../../src/acquisition-comparison.js'

const body = { platform: 'xiaohongshu', keyword: '澳大利亚旅游 穷游攻略', page: 1, count: 20 }
const run = {
  requestId: 'original-request', owner: { apiKeyId: 'original-key' }, scope: { platform: 'xiaohongshu' },
  requestEvidence: { idempotencyKey: 'original-idempotency' },
  costLineage: { providerCalls: [{ providerKey: 'tikhub', operation: 'social.posts.search', requestCall: true }] },
}

test('historical input is marked manual; comparison binds original identity and a new idempotency key', () => {
  const input = structuredClone(run)
  const result = createAcquisitionComparison(input, JSON.stringify(body), 'compare-new-1')
  assert.deepEqual(result.body, body)
  assert.equal(result.parameterSource, 'manual')
  assert.equal(result.keyId, run.owner.apiKeyId)
  assert.equal(result.originalRequestId, run.requestId)
  assert.equal(result.path, '/api/v1/night-all/search/raw')
  assert.deepEqual(input, run)
  assert.throws(() => createAcquisitionComparison(run, JSON.stringify(body), 'original-idempotency'))
})

test('saved exact inputs distinguish edits and unsupported operations cannot masquerade as a raw retry', () => {
  const saved = { ...run, requestEvidence: { ...run.requestEvidence, request: { method: 'POST', path: '/api/v1/night-all/search/raw', body } } }
  assert.equal(createAcquisitionComparison(saved, JSON.stringify(body), 'compare-new-2').parameterSource, 'saved')
  assert.equal(createAcquisitionComparison(saved, JSON.stringify({ ...body, keyword: '不同关键词' }), 'compare-new-3').parameterSource, 'manual')
  assert.equal(canCompareAcquisition({ ...run, owner: {} }), false)
  assert.equal(canCompareAcquisition({ ...run, scope: { platform: 'other' } }), false)
  assert.equal(canCompareAcquisition({ ...run, costLineage: { providerCalls: [] } }), false)
  for (const text of ['bad json', '[]', JSON.stringify({ ...body, count: 30 }), JSON.stringify({ ...body, page: 2 }), JSON.stringify({ ...body, authorization: 'must-not-send' }), JSON.stringify({ ...body, params: {} })]) {
    assert.throws(() => createAcquisitionComparison(run, text, 'compare-new-4'))
  }
})


test('in-progress, unknown and missing response bodies retain the same retry identity', () => {
  for (const code of ['request_in_progress', 'request_outcome_unknown', 'external_platform_outcome_unknown', 'internal_error']) {
    assert.equal(comparisonOutcome({ body: { error: { code } } }), 'uncertain')
  }
  assert.equal(comparisonOutcome({ status: 502, body: null }), 'uncertain')
  assert.equal(comparisonOutcome({ status: 502, body: { error: { code: 'external_platform_rejected' } } }), 'received')
  assert.equal(comparisonOutcome({ status: 200, body: { data: [] } }), 'received')
})


test('stored request parameters cannot be overwritten by a later replay', async () => {
  const { MemoryStore } = await import('../../server/stores/memory-store.mjs')
  const store = new MemoryStore()
  store.requests.set('request', { id: 'request', status: 'reserved' })
  const original = { method: 'POST', path: '/api/v1/night-all/search/raw', body: { ...body } }
  await store.saveAcquisitionRequest('request', original)
  original.body.keyword = 'changed after saving'
  await store.saveAcquisitionRequest('request', original)
  assert.equal(store.requests.get('request').acquisitionRequest.body.keyword, body.keyword)
  store.requests.get('request').status = 'committed'
  await store.saveAcquisitionRequest('request', original)
  assert.equal(store.requests.get('request').acquisitionRequest.body.keyword, body.keyword)
})

const savedRun = (path, body, method = 'POST') => ({ ...run, requestEvidence: { ...run.requestEvidence, request: { method, path, body } } })

test('saved data-search, raw aliases and App V2 search retain their exact route, method, parameters and original Key', () => {
  const examples = [
    ['/api/v1/data/search', { platform: 'xiaohongshu', query: '旅行攻略', pageSize: 20, type: 'note' }],
    ['/api/v1/search/raw', { ...body, businessId: 'original-business' }],
    [XHS_NATIVE_SEARCH_PATH, { keyword: '旅行攻略', page: '1', sort_type: 'time_descending', note_type: '不限', time_filter: '不限', source: 'explore_feed', ai_mode: '0' }, 'GET'],
    [XHS_NATIVE_SEARCH_PATH, { keyword: '旅行攻略', page: '1', ai_mode: '0' }, 'POST'],
    [XHS_NATIVE_SEARCH_PATH, { keyword: '旅行攻略', page: null, search_id: null, ai_mode: null }, 'POST'],
    [XHS_NATIVE_SEARCH_PATH, { keyword: '旅行攻略', page: '', search_id: '', search_session_id: null, sort_type: '', ai_mode: '' }, 'GET'],
  ]
  for (const [path, parameters, method = 'POST'] of examples) {
    const original = savedRun(path, parameters, method)
    const attempt = createAcquisitionComparison(original, JSON.stringify(parameters), 'comparison-new', { savedOnly: true })
    assert.equal(attempt.path, path)
    assert.equal(attempt.method, method)
    assert.equal(attempt.keyId, run.owner.apiKeyId)
    assert.equal(attempt.parameterSource, 'saved')
    assert.deepEqual(attempt.body, parameters)
    assert.throws(() => createAcquisitionComparison(original, JSON.stringify({ ...parameters, keyword: 'edited' }), 'comparison-new', { savedOnly: true }))
  }
  for (const request of [
    { method: 'POST', path: '/api/v1/data/search', bodyOmitted: 'oversize' },
    { method: 'POST', path: '/api/v1/data/search', body: { platform: 'xiaohongshu', query: '[redacted]' } },
    { method: 'GET', path: '/api/v1/data/search', body },
    { method: 'POST', path: 'https://untrusted.invalid/search', body },
    { method: 'POST', path: `${XHS_NATIVE_SEARCH_PATH}?injected=true`, body },
  ]) {
    const original = { ...run, requestEvidence: { request } }
    assert.ok(comparisonUnavailableReason(original, { savedOnly: true }))
    assert.throws(() => createAcquisitionComparison(original, JSON.stringify(body), 'comparison-new', { savedOnly: true }))
  }
  assert.ok(comparisonUnavailableReason(run, { savedOnly: true }))
})

test('comparison session retains pending identity across tab/lookup remounts and isolates Admin sessions', () => {
  const reference = { current: null }
  const first = acquisitionComparisonSessionFor(reference, 'admin-one', run.requestId)
  first.update({ attempts: [{ state: 'uncertain', idempotencyKey: 'comparison-pending' }] })
  const other = acquisitionComparisonSessionFor(reference, 'admin-one', 'other-request')
  assert.equal(other.getSnapshot().attempts.length, 0)
  assert.equal(acquisitionComparisonSessionFor(reference, 'admin-one', run.requestId), first)
  assert.equal(acquisitionComparisonSessionFor(reference, 'admin-two', run.requestId).getSnapshot().attempts.length, 0)
})

test('explicit dispatch is locked and a transport-ambiguous retry renews credential but retains exact request identity', async () => {
  const original = savedRun(XHS_NATIVE_SEARCH_PATH, { keyword: '旅行攻略', page: '1', ai_mode: '0' }, 'GET')
  const session = createAcquisitionComparisonSession(original)
  let release
  const barrier = new Promise(resolve => { release = resolve })
  let credentials = 0, ids = 0
  const calls = []
  const dependencies = {
    adminApi: {
      demoCredential: async (token, keyId) => { credentials++; await barrier; return { keyId, secret: `temporary-secret-${credentials}` } },
      acquisitionHistory: async () => { throw new Error('read unavailable') },
    },
    publicDataApi: { acquisitionComparison: async (...args) => {
      calls.push(args)
      if (calls.length === 1) throw new TypeError('network interrupted')
      return { status: 502, payload: { error: { code: 'external_platform_rejected' } }, evidence: { requestId: 'new-request', sourceMode: 'live', idempotentReplay: true } }
    } },
  }
  const options = { token: 'admin', original, savedOnly: true, newIdempotencyKey: () => `comparison-${++ids}` }
  const sending = sendAcquisitionComparison(session, options, dependencies)
  await sendAcquisitionComparison(session, options, dependencies)
  assert.equal(session.getSnapshot().busy, true)
  assert.equal(credentials, 1)
  release()
  await sending
  assert.equal(calls.length, 1)
  assert.equal(session.getSnapshot().attempts[0].state, 'uncertain')
  await sendAcquisitionComparison(session, options, dependencies)
  assert.equal(ids, 1)
  await sendAcquisitionComparison(session, { ...options, retry: session.getSnapshot().attempts[0] }, dependencies)
  assert.equal(calls.length, 2)
  assert.notEqual(calls[0][0], calls[1][0])
  assert.deepEqual(calls[0].slice(1), calls[1].slice(1))
  assert.equal(calls[1][3], XHS_NATIVE_SEARCH_PATH)
  assert.equal(calls[1][4], 'GET')
  const final = session.getSnapshot()
  assert.equal(final.attempts.length, 1)
  assert.equal(final.attempts[0].state, 'received')
  assert.equal(final.attempts[0].delivered.status, 502)
  assert.equal(final.attempts[0].delivered.evidence.requestId, 'new-request')
  assert.ok(final.attempts[0].historyError)
  assert.equal(JSON.stringify(final).includes('temporary-secret'), false)
  assert.equal(final.busy, false)
})

test('a wrong original identity cannot dispatch; cache and idempotent success never claim upstream recovery', async () => {
  const original = savedRun('/api/v1/data/search', { platform: 'xiaohongshu', query: '旅行攻略', pageSize: 20 })
  const session = createAcquisitionComparisonSession(original)
  await sendAcquisitionComparison(session, { token: 'admin', original, newIdempotencyKey: () => 'comparison-new' }, {
    adminApi: { demoCredential: async () => ({ keyId: 'another-key', secret: 'wrong-secret' }) },
    publicDataApi: { acquisitionComparison: () => assert.fail('wrong identity must not dispatch') },
  })
  assert.equal(session.getSnapshot().attempts[0].state, 'not_sent')
  for (const evidence of [{ sourceMode: 'fresh_cache' }, { sourceMode: 'stored_fallback' }, { sourceMode: 'live', idempotentReplay: true }]) {
    assert.match(comparisonResultMessage({ delivered: { status: 200, evidence } }), /不能据此确认上游恢复/u)
  }
  assert.match(comparisonResultMessage({ delivered: { status: 502, evidence: { sourceMode: 'live' } } }), /仍未成功/u)
  assert.match(comparisonResultMessage({ delivered: { status: 200, evidence: { sourceMode: 'live' } } }), /本次实时请求成功/u)
})

test('retry admission and transport errors cannot resolve an earlier unknown paid request or replace its request ID', async () => {
  const original = savedRun(XHS_NATIVE_SEARCH_PATH, { keyword: '旅行攻略', page: '1' }, 'GET')
  for (const status of [401, 403, 404, 429, 500, 502]) {
    const session = createAcquisitionComparisonSession(original)
    const attempt = { ...createAcquisitionComparison(original, JSON.stringify(original.requestEvidence.request.body), 'pending-idempotency'), state: 'uncertain', delivered: { status: 503, body: { error: { code: 'request_outcome_unknown' } }, evidence: { requestId: 'original-pending-request' } } }
    session.update({ attempts: [attempt] })
    const dependencies = {
      adminApi: {
        demoCredential: async (_token, keyId) => ({ keyId, secret: 'temporary-key' }),
        acquisitionHistory: async () => ({ requestId: 'retry-http-id', owner: { apiKeyId: 'another-key' }, requestEvidence: { idempotencyKey: 'another-request' }, delivered: { responseStatus: status } }),
      },
      publicDataApi: { acquisitionComparison: async () => { throw Object.assign(new Error('retry rejected'), { status, responseBody: { error: { code: 'request_rejected' } }, evidence: { requestId: 'retry-http-id' } }) } },
    }
    await sendAcquisitionComparison(session, { token: 'admin', original, retry: attempt }, dependencies)
    const result = session.getSnapshot().attempts[0]
    assert.equal(result.state, 'uncertain')
    assert.equal(result.delivered.evidence.requestId, 'original-pending-request')
    assert.equal(result.retryCheck.status, status)
    assert.equal(result.history, undefined)
    await sendAcquisitionComparison(session, { token: 'admin', original, newIdempotencyKey: () => assert.fail('must not create new paid identity') }, dependencies)
  }
})

test('matching committed history can resolve an ambiguous retry even when it was the first actual dispatch', async () => {
  const original = savedRun('/api/v1/data/search', { platform: 'xiaohongshu', query: '旅行攻略', pageSize: 20 })
  const session = createAcquisitionComparisonSession(original)
  const attempt = { ...createAcquisitionComparison(original, JSON.stringify(original.requestEvidence.request.body), 'pending-idempotency'), state: 'uncertain' }
  session.update({ attempts: [attempt] })
  await sendAcquisitionComparison(session, { token: 'admin', original, retry: attempt }, {
    adminApi: {
      demoCredential: async (_token, keyId) => ({ keyId, secret: 'temporary-key' }),
      acquisitionHistory: async () => ({ requestId: 'committed-request', owner: { apiKeyId: attempt.keyId }, requestEvidence: { idempotencyKey: attempt.idempotencyKey }, delivered: { responseStatus: 200 } }),
    },
    publicDataApi: { acquisitionComparison: async () => ({ status: 200, payload: { data: [] }, evidence: { requestId: 'committed-request', sourceMode: 'live', idempotentReplay: false } }) },
  })
  assert.equal(session.getSnapshot().attempts[0].state, 'received')
  assert.equal(session.getSnapshot().attempts[0].delivered.evidence.requestId, 'committed-request')
})

test('an older unsent attempt cannot bypass the lock for a different unresolved paid request', async () => {
  const original = savedRun('/api/v1/data/search', { platform: 'xiaohongshu', query: '旅行攻略', pageSize: 20 })
  const session = createAcquisitionComparisonSession(original)
  const first = { ...createAcquisitionComparison(original, JSON.stringify(original.requestEvidence.request.body), 'older-unsent-key'), state: 'not_sent' }
  const second = { ...createAcquisitionComparison(original, JSON.stringify(original.requestEvidence.request.body), 'unknown-paid-key'), state: 'uncertain' }
  session.update({ attempts: [first, second] })
  const calls = []
  const dependencies = {
    adminApi: {
      demoCredential: async (_token, keyId) => { calls.push('credential'); return { keyId, secret: 'temporary-key' } },
      acquisitionHistory: async () => { throw new Error('history unavailable') },
    },
    publicDataApi: { acquisitionComparison: async (_secret, _body, key) => { calls.push(key); return { status: 502, payload: { error: { code: 'external_platform_rejected' } }, evidence: { requestId: 'resolved-request', idempotentReplay: true } } } },
  }
  await sendAcquisitionComparison(session, { token: 'admin', original, retry: first }, dependencies)
  assert.deepEqual(calls, [])
  assert.equal(session.getSnapshot().attempts[0].state, 'not_sent')
  assert.equal(session.getSnapshot().attempts[1].state, 'uncertain')
  await sendAcquisitionComparison(session, { token: 'admin', original, retry: second }, dependencies)
  assert.deepEqual(calls, ['credential', 'unknown-paid-key'])
  assert.equal(session.getSnapshot().attempts[1].state, 'received')
  await sendAcquisitionComparison(session, { token: 'admin', original, retry: first }, dependencies)
  assert.deepEqual(calls, ['credential', 'unknown-paid-key', 'credential', 'older-unsent-key'])
})
