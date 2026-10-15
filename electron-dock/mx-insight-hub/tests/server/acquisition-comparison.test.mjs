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

// Matches getAdminDeliveredRun's owner/scope/requestEvidence/providerCall projection.
const instagramRun = (body = { platform: 'instagram', query: '原查询', pageSize: 20 }) => ({
  ...savedRun('/api/v1/data/search', body), scope: { platform: 'instagram' },
  costLineage: { providerCalls: [{ usageRequestId: run.requestId, requestCall: true,
    providerKey: 'tikhub', operation: 'native.t.instagram_v3_general_search',
    endpointKey: 'native.t.instagram_v3_general_search', contractVersion: 'mx-insight-hub.native-forwarding.v1',
    outcome: 'rejected', httpStatus: 400 }] },
})

test('Instagram comparison accepts only saved data-search parameters tied to its original native call', () => {
  for (const parameters of [
    { platform: 'instagram', query: ' 原查询 ', pageSize: 20 },
    { platform: 'ig', query: '原查询', pageSize: 30, type: 'stable', cursor: 'mxds1.original-opaque-cursor' },
    { platform: 'instagram', query: '原查询', pageSize: null, type: null, cursor: null },
  ]) {
    const original = instagramRun(parameters)
    assert.equal(comparisonUnavailableReason(original), null)
    const before = structuredClone(original)
    for (const savedOnly of [false, true]) {
      const attempt = createAcquisitionComparison(original, JSON.stringify(parameters), 'instagram-new-request', { savedOnly })
      assert.equal(attempt.path, '/api/v1/data/search')
      assert.equal(attempt.method, 'POST')
      assert.equal(attempt.keyId, run.owner.apiKeyId)
      assert.equal(attempt.parameterSource, 'saved')
      assert.deepEqual(attempt.body, parameters)
      const edited = JSON.stringify({ ...parameters, query: '手动重构' })
      assert.throws(() => createAcquisitionComparison(original, edited, 'instagram-new-request', { savedOnly, verifiedBody: edited }), /保存的原参数/)
    }
    assert.throws(() => createAcquisitionComparison(original, JSON.stringify(parameters), run.requestEvidence.idempotencyKey))
    assert.deepEqual(original, before)
  }
})

test('Instagram comparison refuses missing snapshots, foreign or incomplete call evidence, and alternate routes', () => {
  const original = instagramRun()
  const evidence = original.costLineage.providerCalls[0]
  for (const patch of [{ usageRequestId: 'another-request' }, { requestCall: false, deliveredSource: true },
    { providerKey: 'rapidapi' }, { operation: 'social.posts.search' }, { endpointKey: 'native.other' },
    { contractVersion: null }, { contractVersion: 'unverified-contract' }]) {
    const invalid = { ...original, costLineage: { providerCalls: [{ ...evidence, ...patch }] } }
    assert.ok(comparisonUnavailableReason(invalid))
    assert.throws(() => createAcquisitionComparison(invalid, JSON.stringify(original.requestEvidence.request.body), 'instagram-new-request'))
  }
  for (const request of [null, { method: 'POST', path: '/api/v1/data/search', bodyOmitted: 'oversize' },
    { method: 'POST', path: '/api/v1/data/search', body: { platform: 'instagram', query: '[redacted]' } },
    ...['/api/v1/search/raw', '/api/v1/night-all/search/raw', '/api/v1/data/native/t.instagram_v3_general_search',
      '/api/v1/data/search?provider=tikhub', 'https://untrusted.invalid/search'].map(path => ({ ...original.requestEvidence.request, path })),
    { ...original.requestEvidence.request, method: 'GET' },
  ]) {
    const invalid = { ...original, requestEvidence: { ...original.requestEvidence, request } }
    assert.ok(comparisonUnavailableReason(invalid))
    assert.throws(() => createAcquisitionComparison(invalid, JSON.stringify(original.requestEvidence.request.body), 'instagram-new-request'))
  }
})

test('unsupported Instagram saved parameters never obtain a credential or dispatch', async () => {
  const valid = instagramRun().requestEvidence.request.body
  for (const patch of [{ params: {} }, { provider: 'tikhub' }, { page: 2 }, { keyword: 'another' },
    { platform: 'xiaohongshu' }, { query: '' }, { pageSize: 1 }, { pageSize: '20' }, { pageSize: 101 },
    { type: 'note' }, { cursor: 'mxec2.xhs-cursor' }, { cursor: 'mxnc1.historical-cursor' }]) {
    const original = instagramRun({ ...valid, ...patch })
    const session = createAcquisitionComparisonSession(original)
    await sendAcquisitionComparison(session, { token: 'admin', original }, {
      adminApi: { demoCredential: () => assert.fail('invalid parameters must not obtain credentials') },
      publicDataApi: { acquisitionComparison: () => assert.fail('invalid parameters must not dispatch') },
    })
    assert.ok(session.getSnapshot().error)
    assert.deepEqual(session.getSnapshot().attempts, [])
  }
})

test('Instagram uncertainty never reposts, even after the fresh replay window or with a changed retry state', async t => {
  let now = Date.parse('2026-10-14T12:00:00Z')
  t.mock.method(Date, 'now', () => now)
  for (const type of [undefined, null, 'fresh', 'stable']) {
    const original = instagramRun({ platform: 'instagram', query: '原查询', pageSize: 20, ...(type === undefined ? {} : { type }) })
    const session = createAcquisitionComparisonSession(original)
    const calls = []
    let credentials = 0
    const dependencies = {
      adminApi: { demoCredential: async (_token, keyId) => {
        credentials++
        return { keyId, secret: 'temporary-instagram-key' }
      } },
      publicDataApi: { acquisitionComparison: async (...args) => {
        calls.push(args)
        throw new TypeError('transport interrupted after possible upstream success')
      } },
    }
    const options = { token: 'admin', original, newIdempotencyKey: () => 'instagram-new-request' }
    await sendAcquisitionComparison(session, options, dependencies)
    const pending = session.getSnapshot().attempts[0]
    assert.equal(pending.state, 'uncertain')
    for (const elapsed of [0, 120_001, 24 * 60 * 60_000]) {
      now += elapsed
      await sendAcquisitionComparison(session, { ...options, newIdempotencyKey: () => assert.fail('no new attempt during uncertainty') }, dependencies)
      await sendAcquisitionComparison(session, { ...options, retry: pending }, dependencies)
      await sendAcquisitionComparison(session, { ...options, retry: { ...pending, state: 'not_sent' } }, dependencies)
      assert.equal(calls.length, 1, 'same-key POST must not repeat a possibly completed paid call')
      assert.equal(credentials, 1)
      assert.equal(session.getSnapshot().attempts[0].state, 'uncertain')
      assert.match(session.getSnapshot().error.message, /只读核查/)
    }
    assert.deepEqual(calls[0], ['temporary-instagram-key', original.requestEvidence.request.body,
      'instagram-new-request', '/api/v1/data/search', 'POST'])
    assert.equal(session.getSnapshot().attempts.length, 1)
    assert.equal(JSON.stringify(session.getSnapshot()).includes('temporary-instagram-key'), false)
  }
})

const instagramResponseId = '11111111-2222-4333-8444-555555555555'
const instagramSuccess = { data: { contractVersion: 'night-all.data-search.v1', platform: 'instagram', query: '原查询',
  items: [], pageInfo: { pageIndex: 1, pageSize: 20, returnedCount: 0, hasMore: false, nextCursor: null, cursorType: 'none' },
  status: 'ok', warnings: [], meta: {} }, requestId: instagramResponseId }

test('Instagram treats JSON proxy errors and malformed successful responses as uncertain and never unlocks another POST', async () => {
  for (const [status, payload, evidence = {}] of [
    [502, { message: 'Gateway timeout' }], [504, { message: 'Gateway timeout' }], [502, {}], [504, {}],
    [502, { error: { code: 'gateway_timeout', message: 'Proxy error' } }],
    [504, { requestId: instagramResponseId, error: { code: 'gateway_timeout', message: 'Proxy error' } }, { requestId: instagramResponseId }],
    [200, {}], [200, []], [200, { data: [] }],
    [200, { requestId: instagramResponseId, data: {} }, { requestId: instagramResponseId }],
    [200, { ...instagramSuccess, data: { ...instagramSuccess.data, pageInfo: {} } }, { requestId: instagramResponseId }],
    [200, instagramSuccess, { requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }],
  ]) {
    const original = instagramRun()
    const session = createAcquisitionComparisonSession(original)
    let calls = 0
    const dependencies = {
      adminApi: { demoCredential: async (_token, keyId) => ({ keyId, secret: 'fixture-key' }),
        acquisitionHistory: async () => { throw new Error('no committed receipt') } },
      publicDataApi: { acquisitionComparison: async () => { calls++; return { status, payload, evidence } } },
    }
    const options = { token: 'admin', original, newIdempotencyKey: () => 'instagram-new-request' }
    await sendAcquisitionComparison(session, options, dependencies)
    assert.equal(session.getSnapshot().attempts[0].state, 'uncertain')
    assert.deepEqual(session.getSnapshot().attempts[0].delivered.body, payload)
    await sendAcquisitionComparison(session, { ...options, newIdempotencyKey: () => assert.fail('untrusted JSON must not unlock a new key') }, dependencies)
    await sendAcquisitionComparison(session, { ...options, retry: session.getSnapshot().attempts[0] }, dependencies)
    assert.equal(calls, 1)
  }
})

test('Instagram confirms only its exact committed terminal history when a proxy response was ambiguous', async () => {
  const original = instagramRun()
  const committed = { requestId: instagramResponseId, status: 'committed', owner: original.owner,
    requestEvidence: { idempotencyKey: 'instagram-new-request' },
    delivered: { responseStatus: 200, responseBody: instagramSuccess } }
  for (const [history, confirmed] of [[committed, true],
    [{ ...committed, requestId: 'different-request' }, false],
    [{ ...committed, status: 'reserved' }, false],
    [{ ...committed, owner: { apiKeyId: 'different-key' } }, false],
    [{ ...committed, requestEvidence: { idempotencyKey: 'different-idempotency' } }, false],
    [{ ...committed, delivered: { responseStatus: 200, responseBody: {} } }, false],
    [{ ...committed, delivered: { responseStatus: 503, responseBody: { error: { code: 'external_platform_outcome_unknown', message: 'Unknown' } } } }, false],
  ]) {
    const session = createAcquisitionComparisonSession(original)
    let calls = 0
    await sendAcquisitionComparison(session, { token: 'admin', original, newIdempotencyKey: () => 'instagram-new-request' }, {
      adminApi: { demoCredential: async (_token, keyId) => ({ keyId, secret: 'fixture-key' }), acquisitionHistory: async () => history },
      publicDataApi: { acquisitionComparison: async () => { calls++; return { status: 504,
        payload: { message: 'Gateway timeout' }, evidence: { requestId: instagramResponseId } } } },
    })
    assert.equal(session.getSnapshot().attempts[0].state, confirmed ? 'received' : 'uncertain')
    assert.equal(session.getSnapshot().attempts[0].delivered.status, 504, 'the observed browser response stays intact')
    assert.equal(calls, 1, 'history verification never redispatches')
    assert.equal(Boolean(session.getSnapshot().attempts[0].history), confirmed)
  }
})

test('Instagram still recognizes correlated Hub success and terminal error envelopes without history', async () => {
  for (const [status, payload] of [[200, instagramSuccess], [502, { requestId: instagramResponseId,
    error: { code: 'external_platform_rejected', message: 'External data platform rejected the request' } }]]) {
    const original = instagramRun()
    const session = createAcquisitionComparisonSession(original)
    await sendAcquisitionComparison(session, { token: 'admin', original, newIdempotencyKey: () => 'instagram-new-request' }, {
      adminApi: { demoCredential: async (_token, keyId) => ({ keyId, secret: 'fixture-key' }),
        acquisitionHistory: async () => { throw new Error('history temporarily unavailable') } },
      publicDataApi: { acquisitionComparison: async () => ({ status, payload, evidence: { requestId: instagramResponseId } }) },
    })
    assert.equal(session.getSnapshot().attempts[0].state, 'received')
  }
})

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
  assert.match(comparisonResultMessage({ delivered: { status: 504 }, history: { delivered: { responseStatus: 200, sourceMode: 'live' } } }), /浏览器收到 HTTP 504，账本记录的最终交付为 HTTP 200/u)
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
