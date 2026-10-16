import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { NightAllAdapter } from '../../server/adapters/night-all.mjs'
import { UpstreamRejectedError } from '../../server/core/errors.mjs'
import { nightAllFailureEvidence, nightAllRateLimitEvidence, nightAllRejectionError } from '../../server/data/night-all-failure-evidence.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { createApp } from '../../server/app.mjs'

const rateLimit = { layer: 'night_all_ingress', scope: 'data-search', keyType: 'ip', limit: 120,
  windowMs: 60000, resetAt: '2026-10-15T12:00:30.000Z', retryAfterSeconds: 30, dispatched: false }
const rejectedBody = { requestId: 'synthetic-request', error: { code: 'RATE_LIMITED', message: 'PRIVATE',
  details: { rateLimit, token: 'PRIVATE', host: 'private.invalid' } } }

test('rate-limit metadata is bounded and header countdown wins without retaining arbitrary details', () => {
  const evidence = nightAllRateLimitEvidence(new Headers({ 'retry-after': '15', 'x-rate-limit-limit': '100',
    'x-rate-limit-remaining': '0', 'x-rate-limit-reset': '1792065630', authorization: 'PRIVATE' }), rejectedBody)
  assert.equal(evidence.retryAfterSeconds, 15)
  assert.equal(evidence.limit, 100)
  assert.equal(evidence.remaining, 0)
  assert.equal(evidence.layer, 'night_all_ingress')
  assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE|private.invalid|token|host|authorization/)
  const now = Date.parse('2026-10-15T12:00:00Z')
  assert.equal(nightAllRateLimitEvidence(new Headers({ 'retry-after': 'Thu, 15 Oct 2026 12:00:20 GMT' }), null, { now }).retryAfterSeconds, 20)
  for (const value of ['-1', '1.5', '86401', 'Infinity', 'PRIVATE', 'Thu, 15 Oct 2026 12:00:20 GMT PRIVATE']) {
    assert.equal(nightAllRateLimitEvidence(new Headers({ 'retry-after': value })), null)
  }
  assert.equal(nightAllRateLimitEvidence(new Headers(), { error: { details: { rateLimit: {
    layer: 'provider', scope: 'PRIVATE', keyType: 'PRIVATE', limit: true, windowMs: -1,
    retryAfterSeconds: '30', resetAt: 'PRIVATE', dispatched: false,
  } } } }), null)
})

test('only a confirmed undispatched Night-All ingress rejection is labeled as ingress', () => {
  const output = (body, correlation = {}, status = 429) => nightAllRejectionError(new UpstreamRejectedError(status, body,
    { rateLimit: nightAllRateLimitEvidence(new Headers(), body), ...correlation }), status, 'hub-request')
  const confirmed = output(rejectedBody)
  assert.equal(confirmed.details.upstreamLayer, 'night_all_ingress')
  assert.equal(confirmed.details.retryAfterMs, 30000)
  for (const body of [
    { error: { code: 'RATE_LIMITED' } },
    { error: { code: 'RATE_LIMITED', details: { errors: [{ details: { rateLimit } }] } } },
    { error: { code: 'OTHER_ERROR', details: { rateLimit } } },
    { error: { code: 'RATE_LIMITED', details: { rateLimit: { ...rateLimit, dispatched: true } } } },
  ]) assert.equal(output(body).details.upstreamLayer, undefined)
  assert.equal(output(rejectedBody, {}, 503).details.upstreamLayer, undefined)
  const headerOnly = output({ error: { code: 'RATE_LIMITED' } }, { rateLimit: { retryAfterSeconds: 10 } })
  assert.equal(headerOnly.details.retryAfterMs, 10000)
  assert.equal(headerOnly.details.upstreamLayer, undefined)
})

test('adapter retains safe limits for JSON, invalid JSON and non-JSON 429 without retry', async () => {
  for (const [contentType, text] of [['application/json', JSON.stringify(rejectedBody)], ['application/json', 'invalid'], ['text/html', '<h1>PRIVATE</h1>']]) {
    let calls = 0
    const adapter = new NightAllAdapter({ baseUrl: 'http://synthetic.invalid', fetchImpl: async () => {
      calls++
      return new Response(text, { status: 429, headers: { 'content-type': contentType, 'retry-after': '8', 'x-request-id': 'header-request' } })
    } })
    await assert.rejects(adapter.search({ body: { platform: 'tiktok', query: 'test' }, businessId: 'fixture' }), error => {
      assert.ok(error instanceof UpstreamRejectedError)
      const evidence = nightAllFailureEvidence(error)
      assert.equal(evidence.httpStatus, 429)
      assert.equal(evidence.rateLimit.retryAfterSeconds, 8)
      assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE|private.invalid/)
      return true
    })
    assert.equal(calls, 1)
  }
})

function successBody() {
  return { requestId: 'night-success', traceId: 'trace-success', data: {
    contractVersion: 'night-all.data-search.v1', platform: 'tiktok', query: 'success', items: [],
    pageInfo: { pageIndex: 1, pageSize: 20, returnedCount: 0, hasMore: false, nextCursor: null, cursorType: 'none' },
    status: 'ok', warnings: [], meta: { capability: 'search_posts', capabilityStatus: 'ready', paginationMode: 'none', providerCalls: 1, durationMs: 1 },
  } }
}

// A still-historical platform keeps this regression independent of Reddit/YouTube cutover.
async function harness(t) {
  const store = new MemoryStore(), calls = new Map()
  const adapter = new NightAllAdapter({ baseUrl: 'http://synthetic.invalid', fetchImpl: async (_url, options) => {
    const { query } = JSON.parse(options.body)
    calls.set(query, (calls.get(query) || 0) + 1)
    if (query === 'unknown') throw new TypeError('fixture connection reset')
    if (query === 'success') return Response.json(successBody())
    if (['partial', 'failed'].includes(query)) {
      const body = successBody()
      body.data.status = query
      return Response.json(body)
    }
    return Response.json(query === 'rejected503' ? { error: { code: 'UNAVAILABLE' } } : rejectedBody,
      { status: query === 'rejected503' ? 503 : 429, headers: { 'retry-after': '12', 'x-rate-limit-limit': '120', 'x-rate-limit-remaining': '0' } })
  } })
  const service = new HubService({ store, adapter, apiKeyPepper: 'fixture-pepper' })
  const tenant = await store.createTenant({ name: 'Fixture tenant' })
  const consumer = await store.createConsumer({ tenantId: tenant.id, name: 'Fixture consumer', businessId: 'fixture' })
  await store.replaceGrants(consumer.id, ['tiktok'])
  await store.putPolicy({ tenantId: tenant.id, consumerId: consumer.id, platform: 'tiktok', maxRequests: 100, windowSeconds: 3600, maxPageSize: 100 })
  const issued = await service.createApiKey({ consumerId: consumer.id, name: 'Fixture Key', platforms: ['tiktok'] })
  const server = createServer(createApp({ service, store, adapter, adminToken: 'fixture-admin', logger: { error() {} } }))
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const call = async (query, key = `fixture-${query}`) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/data/search`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${issued.secret}`, 'idempotency-key': key },
      body: JSON.stringify({ platform: 'tiktok', query, pageSize: 20 }) })
    return { response, body: await response.json() }
  }
  return { store, adapter, calls, call }
}

test('HTTP data/search preserves 429, retry countdown, safe connector evidence and released settlement', async t => {
  const h = await harness(t)
  const first = await h.call('limited')
  assert.equal(first.response.status, 429)
  assert.equal(first.response.headers.get('retry-after'), '12')
  assert.equal(first.body.error.code, 'night_all_rejected')
  assert.equal(first.body.error.details.retryAfterMs, 12000)
  assert.equal(first.body.error.details.upstreamLayer, 'night_all_ingress')
  assert.equal(h.calls.get('limited'), 1)
  const saved = h.store.requests.get(first.body.requestId)
  assert.equal(saved.status, 'released')
  assert.equal(saved.errorCode, 'night_all_http_429')
  assert.notEqual(saved.unitsActual, 1)
  assert.equal(h.store.customerCharges.size, 0)
  const [call] = [...h.store.connectorCalls.values()]
  assert.equal(call.operation, 'data-search')
  assert.equal(call.requestId, first.body.requestId)
  assert.equal(call.outcome, 'failed')
  assert.equal(call.httpStatus, 429)
  assert.equal(call.failureEvidence.rateLimit.retryAfterSeconds, 12)
  assert.equal(call.failureEvidence.rateLimit.dispatched, false)
  assert.doesNotMatch(JSON.stringify(first.body), /PRIVATE|private.invalid|keyType|resetAt|windowMs/)
  assert.doesNotMatch(JSON.stringify(call.failureEvidence), /PRIVATE|private.invalid/)
  // Retain the historical explicit-retry rule; no retry occurred automatically.
  const second = await h.call('limited')
  assert.equal(second.response.status, 429)
  assert.equal(h.calls.get('limited'), 2)
  assert.equal(h.store.connectorCalls.size, 2)
})

test('HTTP unknown stays held, success replays once, and non-429 rejection keeps its original status', async t => {
  const h = await harness(t)
  const unknown = await h.call('unknown')
  assert.equal(unknown.response.status, 502)
  assert.equal(unknown.body.error.code, 'upstream_outcome_unknown')
  assert.equal(h.store.requests.get(unknown.body.requestId).status, 'unknown')
  assert.equal((await h.call('unknown')).response.status, 409)
  assert.equal(h.calls.get('unknown'), 1)
  assert.equal([...h.store.connectorCalls.values()].find(call => call.requestId === unknown.body.requestId).outcome, 'unknown')
  let commits = 0
  const commit = h.store.commitRequest.bind(h.store)
  h.store.commitRequest = async (...args) => { commits++; return commit(...args) }
  const success = await h.call('success')
  assert.equal(success.response.status, 200)
  assert.equal(h.store.requests.get(success.body.requestId).status, 'committed')
  assert.equal([...h.store.connectorCalls.values()].find(call => call.requestId === success.body.requestId).outcome, 'complete')
  assert.deepEqual((await h.call('success')).body, success.body)
  assert.equal(h.calls.get('success'), 1)
  assert.equal(commits, 1)
  const rejected = await h.call('rejected503')
  assert.equal(rejected.response.status, 502)
  assert.equal(h.store.requests.get(rejected.body.requestId).status, 'released')
  assert.equal(h.calls.get('rejected503'), 1)
})

test('diagnostic storage failures do not override success, rejection or unknown acquisition states', async t => {
  const h = await harness(t)
  h.store.recordConnectorFailureEvidence = async () => { throw new Error('fixture diagnostic failure') }
  h.store.finishConnectorCall = async () => { throw new Error('fixture diagnostic failure') }
  for (const [query, httpStatus, state] of [['limited', 429, 'released'], ['success', 200, 'committed'], ['unknown', 502, 'unknown']]) {
    const result = await h.call(query)
    assert.equal(result.response.status, httpStatus)
    assert.equal(h.store.requests.get(result.body.requestId).status, state)
    assert.equal(h.calls.get(query), 1)
  }
})

test('HTTP 200 partial and failed business results retain their connector outcome without changing settlement', async t => {
  const h = await harness(t)
  for (const status of ['partial', 'failed']) {
    const result = await h.call(status)
    assert.equal(result.response.status, 200)
    assert.equal(result.body.data.status, status)
    assert.equal(h.store.requests.get(result.body.requestId).status, 'committed')
    const connector = [...h.store.connectorCalls.values()].find(call => call.requestId === result.body.requestId)
    assert.equal(connector.outcome, status)
    assert.equal(connector.businessStatus, status)
    assert.equal(connector.httpStatus, 200)
    assert.equal(connector.failureKind, status === 'failed' ? 'business' : null)
    assert.equal(h.calls.get(status), 1)
  }
})

test('an unexpected adapter error closes its diagnostic connector before the original internal release', async t => {
  const h = await harness(t)
  let calls = 0
  h.adapter.search = async () => { calls++; throw new Error('fixture unexpected adapter failure') }
  const result = await h.call('internal')
  assert.equal(result.response.status, 500)
  assert.equal([...h.store.requests.values()][0].status, 'released')
  const [connector] = [...h.store.connectorCalls.values()]
  assert.equal(connector.outcome, 'failed')
  assert.equal(connector.failureKind, 'internal')
  assert.equal(connector.errorCode, 'internal_error')
  assert.equal(calls, 1)
})
