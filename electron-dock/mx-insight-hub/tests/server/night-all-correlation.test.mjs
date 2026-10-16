import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NightAllAdapter } from '../../server/adapters/night-all.mjs'
import { UpstreamAmbiguousError } from '../../server/core/errors.mjs'
import { nightAllFailureEvidence } from '../../server/data/night-all-failure-evidence.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const HUB_ID = '7c686127-a835-473a-80eb-e14241194c90'
const headers = { 'content-type': 'application/json', 'x-request-id': 'req_observed', 'x-trace-id': 'trace_observed' }
const crawl = adapter => adapter.legacySearch({ operation: 'crawl',
  body: { platform: 'twitter', username: 'synthetic', count: 20 }, businessId: 'synthetic', requestId: HUB_ID })

function stalledResponse(signal, status = 200) {
  return new Response(new ReadableStream({ start(controller) {
    signal.addEventListener('abort', () => controller.error(new DOMException('private-abort-message', 'AbortError')), { once: true })
  } }), { status, headers })
}

for (const [label, response] of [
  ['body timeout after 200 headers', signal => stalledResponse(signal)],
  ['body timeout after 503 headers', signal => stalledResponse(signal, 503)],
  ['invalid JSON success', () => new Response('private-invalid-json', { headers })],
  ['invalid content type success', () => new Response('private-html-body', { headers: { ...headers, 'content-type': 'text/html' } })],
  ['invalid success envelope', () => new Response('{"requestId":"private-body-id","data":{}}', { headers })],
  ['body stream failure', () => new Response(new ReadableStream({ start(controller) {
    controller.error(new TypeError('private-stream-message'))
  } }), { headers })],
]) {
  test(`${label} retains only observed bounded response correlation and remains unknown`, async () => {
    let calls = 0
    const adapter = new NightAllAdapter({ baseUrl: 'http://synthetic.invalid', timeoutMs: 5,
      fetchImpl: async (_url, options) => { calls++; return response(options.signal) } })
    await assert.rejects(crawl(adapter), error => {
      assert.ok(error instanceof UpstreamAmbiguousError)
      assert.equal(error.upstreamRequestId, 'req_observed')
      assert.equal(error.upstreamTraceId, 'trace_observed')
      assert.equal(error.upstreamHttpStatus, label.includes('503') ? 503 : 200)
      const evidence = nightAllFailureEvidence(error)
      assert.equal(evidence.requestId, 'req_observed')
      assert.equal(evidence.httpStatus, error.upstreamHttpStatus)
      assert.doesNotMatch(JSON.stringify(evidence), /private|7c686127/)
      return true
    })
    assert.equal(calls, 1)
  })
}

test('pre-header timeout sends Hub identity but does not claim it was observed upstream', async () => {
  let calls = 0
  const adapter = new NightAllAdapter({ baseUrl: 'http://synthetic.invalid', timeoutMs: 5,
    fetchImpl: async (url, options) => {
      calls++
      assert.equal(url, 'http://synthetic.invalid/api/v1/search/crawl')
      assert.equal(options.headers['x-request-id'], HUB_ID)
      assert.deepEqual(JSON.parse(options.body), { platform: 'twitter', username: 'synthetic', count: 20, businessId: 'synthetic' })
      return new Promise((resolve, reject) => options.signal.addEventListener('abort',
        () => reject(new DOMException('private-timeout', 'AbortError')), { once: true }))
    } })
  await assert.rejects(crawl(adapter), error => {
    assert.ok(error instanceof UpstreamAmbiguousError)
    assert.equal(error.upstreamRequestId, null)
    assert.equal(error.upstreamTraceId, null)
    assert.equal(error.upstreamHttpStatus, null)
    assert.deepEqual(nightAllFailureEvidence(error), { version: 1, requestId: null,
      traceId: null, httpStatus: null, truncated: false, errors: [] })
    return true
  })
  assert.equal(calls, 1)
})

test('unsafe response correlations are discarded and invalid outgoing identity never dispatches', async () => {
  const adapter = new NightAllAdapter({ baseUrl: 'http://synthetic.invalid', fetchImpl: async () => new Response('{}', {
    headers: { 'content-type': 'application/json', 'x-request-id': 'https://private.invalid/token', 'x-trace-id': 'x'.repeat(161) },
  }) })
  await assert.rejects(crawl(adapter), error => {
    assert.equal(error.upstreamRequestId, null)
    assert.equal(error.upstreamTraceId, null)
    assert.doesNotMatch(JSON.stringify(nightAllFailureEvidence(error)), /private|xxxxx/)
    return true
  })
  const invalid = new NightAllAdapter({ baseUrl: 'http://synthetic.invalid', fetchImpl: () => assert.fail('invalid identity dispatched') })
  await assert.rejects(invalid.search({ body: {}, requestId: 'client-controlled-id' }), TypeError)
})

async function fixture(mode, stage) {
  const store = new MemoryStore()
  const tenant = await store.createTenant({ name: 'Synthetic tenant' })
  const consumer = await store.createConsumer({ tenantId: tenant.id, name: 'Synthetic consumer', businessId: 'synthetic' })
  const platform = mode === 'crawl' ? 'twitter' : 'linkedin'
  await store.replaceGrants(consumer.id, [platform])
  await store.putPolicy({ tenantId: tenant.id, consumerId: consumer.id, platform,
    maxRequests: 100, windowSeconds: 3600, maxPageSize: 100 })
  const outgoing = []
  const adapter = new NightAllAdapter({ baseUrl: 'http://synthetic.invalid', timeoutMs: 5,
    fetchImpl: async (url, options) => {
      outgoing.push({ url, headers: options.headers, body: JSON.parse(options.body) })
      if (stage === 'body') return stalledResponse(options.signal)
      return new Promise((resolve, reject) => options.signal.addEventListener('abort',
        () => reject(new DOMException('private-timeout', 'AbortError')), { once: true }))
    } })
  const service = new HubService({ store, adapter, apiKeyPepper: 'synthetic-pepper' })
  const issued = await service.createApiKey({ consumerId: consumer.id, name: 'Synthetic key', platforms: [platform] })
  const context = await service.authenticate(issued.secret)
  const input = { idempotencyKey: 'correlation-unknown-key',
    ...(mode === 'crawl' ? { operation: 'crawl', path: '/api/v1/night-all/search/crawl', body: { platform, username: 'synthetic', count: 20 } }
      : { path: '/api/v1/data/search', body: { platform, query: 'synthetic', pageSize: 20 } }) }
  return { store, outgoing, run: () => mode === 'crawl'
    ? service.nightAllCompatibilitySearch(context, input) : service.search(context, input) }
}

for (const mode of ['crawl', 'standard']) for (const stage of ['headers', 'body']) {
  test(`${mode} ${stage} timeout keeps one dispatch and original unknown identity with private diagnostics`, async () => {
    const f = await fixture(mode, stage)
    let originalId
    await assert.rejects(f.run(), error => {
      assert.equal(error.status, 502)
      assert.equal(error.code, 'upstream_outcome_unknown')
      originalId = error.details.requestId
      assert.deepEqual(error.details, { requestId: originalId })
      assert.doesNotMatch(JSON.stringify(error), /req_observed|trace_observed|private/)
      return true
    })
    await assert.rejects(f.run(), error => error.status === 409
      && error.code === 'request_outcome_unknown' && error.details.requestId === originalId)
    assert.equal(f.outgoing.length, 1)
    assert.equal(f.outgoing[0].headers['x-request-id'], originalId)
    assert.equal(Object.hasOwn(f.outgoing[0].body, 'requestId'), false)
    const request = f.store.requests.get(originalId)
    const [call] = f.store.connectorCalls.values()
    assert.equal(request.status, 'unknown')
    assert.equal(request.errorCode, 'night_all_outcome_unknown')
    assert.equal(request.responseBody, null)
    assert.equal(call.outcome, 'unknown')
    assert.equal(call.failureKind, 'timeout')
    assert.equal(call.httpStatus, stage === 'body' ? 200 : null)
    assert.equal(call.nightAllRequestId, stage === 'body' ? 'req_observed' : null)
    if (stage === 'body') {
      assert.equal(call.failureEvidence.requestId, call.nightAllRequestId)
      assert.equal(call.failureEvidence.httpStatus, call.httpStatus)
      assert.doesNotMatch(JSON.stringify(call.failureEvidence), /private/)
    } else assert.equal(call.failureEvidence, undefined)
  })
}

test('failed persistence of observed response evidence cannot release or redispatch an unknown request', async () => {
  for (const mode of ['crawl', 'standard']) {
    const f = await fixture(mode, 'body')
    f.store.recordConnectorFailureEvidence = async () => { throw new Error('private-storage-error') }
    await assert.rejects(f.run(), { code: 'upstream_outcome_unknown' })
    await assert.rejects(f.run(), { code: 'request_outcome_unknown' })
    assert.equal(f.outgoing.length, 1)
    const [request] = f.store.requests.values()
    assert.equal(request.status, 'unknown')
  }
})
