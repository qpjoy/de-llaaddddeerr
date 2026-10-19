import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { createApp } from '../../server/app.mjs'
import { AppError } from '../../server/core/errors.mjs'
import { createTelegramSemanticProxy, telegramSemanticInternalUrl,
  TELEGRAM_SEMANTIC_PATH as PATH, TELEGRAM_SEMANTIC_INTERNAL_PATH as INTERNAL } from '../../server/retrieval/telegram-semantic-proxy.mjs'

async function fixture() {
  const store = new MemoryStore(), calls = []
  const adapter = { capabilities: async () => ({ data: { platforms: [] } }) }
  const engine = { run: async query => {
    calls.push(query)
    return { items: [{ id: '00000000-0000-4000-8000-000000000001', semanticSimilarity: 0.8 }],
      retrieval: { mode: 'semantic', coverage: 'unknown', exhaustive: false },
      pageInfo: { pageSize: query.topK, returnedCount: 1, nextCursor: null, cursorType: 'none', paginationMode: 'top_k' } }
  } }
  const service = new HubService({ store, adapter, apiKeyPepper: 'telegram-semantic-test-only-pepper', telegramSemantic: engine })
  const tenant = await service.createTenant({ name: 'TG semantic test' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Reader' })
  const policy = { tenantId: tenant.id, consumerId: consumer.id, enabled: true, maxRequests: 100, windowSeconds: 3600, maxPageSize: 5 }
  await service.putPlatformConfiguration('telegram', policy)
  const apiKey = await service.createApiKey({ consumerId: consumer.id, name: 'TG', platforms: ['telegram'] })
  const context = await service.authenticate(apiKey.secret)
  return { store, service, context, engine, calls, apiKey, policy, adapter }
}
const input = { body: { query: '领导人' }, idempotencyKey: 'semantic-request-1' }

test('semantic delivery uses TG policy, a single durable billing identity and immutable replay', async () => {
  const f = await fixture()
  const first = await f.service.telegramSemanticSearch(f.context, input)
  assert.equal(first.status, 200); assert.equal(first.body.data.contractVersion, 'mx-insight-hub.telegram-semantic.v1')
  assert.equal(first.body.data.pageInfo.pageSize, 5)
  assert.equal(first.body.data.retrieval.exhaustive, false)
  // A delivered semantic request remains the same purchase after the legacy
  // full-text 120-second freshness window; a lost Public reply must not rerun it.
  f.store.requests.get(first.requestId).completedAt = '2000-01-01T00:00:00.000Z'
  const replay = await f.service.telegramSemanticSearch(f.context, input)
  assert.equal(replay.replay, true); assert.deepEqual(replay.body, first.body); assert.equal(f.calls.length, 1)
  const request = await f.store.getRequest(first.requestId)
  assert.equal(request.status, 'committed'); assert.equal(request.unitsActual, 1)
  await assert.rejects(f.service.telegramSemanticSearch(f.context, { ...input, body: { query: 'changed' } }), { code: 'idempotency_conflict' })
  await assert.rejects(f.service.telegramSemanticSearch(f.context, { ...input, body: { query: '领导人', topK: 6 } }), { code: 'page_size_exceeded' })
  assert.equal(f.calls.length, 1)
})

test('a second key for the same consumer cannot take over a semantic idempotency identity', async () => {
  const f = await fixture()
  await f.service.telegramSemanticSearch(f.context, input)
  const sibling = await f.service.createApiKey({ consumerId: f.context.consumer.id, name: 'TG sibling', platforms: ['telegram'] })
  const siblingContext = await f.service.authenticate(sibling.secret)
  await assert.rejects(f.service.telegramSemanticSearch(siblingContext, input), { code: 'idempotency_conflict' })
  assert.equal(f.calls.length, 1)
})

test('revoked TG grants, test keys and invalid fields cannot reach embedding, including replay', async () => {
  const f = await fixture()
  await f.service.telegramSemanticSearch(f.context, input)
  await assert.rejects(f.service.telegramSemanticSearch(f.context, { ...input, body: { query: '领导人', cursor: 'fake' } }), { code: 'invalid_request' })
  await assert.rejects(f.service.telegramSemanticSearch({ ...f.context, apiKey: { ...f.context.apiKey, environment: 'test' } }, input), { code: 'test_key_not_supported' })
  await f.service.putPlatformConfiguration('telegram', { ...f.policy, enabled: false })
  await assert.rejects(f.service.telegramSemanticSearch(f.context, input), { code: 'platform_not_granted' })
  assert.equal(f.calls.length, 1)
})

test('semantic execution timeout and ambiguous commit retain durable unknown and never recompute under the same key', async () => {
  const f = await fixture()
  let executionCount = 0
  f.engine.run = async () => { executionCount++; throw new AppError(503, 'semantic_timeout', 'temporary') }
  await assert.rejects(f.service.telegramSemanticSearch(f.context, input), error => {
    assert.equal(error.status, 503); assert.equal(error.code, 'semantic_search_outcome_unknown')
    assert.match(error.details.requestId, /^[0-9a-f-]{36}$/u); return true
  })
  await assert.rejects(f.service.telegramSemanticSearch(f.context, input), { code: 'request_outcome_unknown' })
  assert.equal(executionCount, 1)
  assert.equal([...f.store.requests.values()].find(row => row.idempotencyKey === input.idempotencyKey).status, 'unknown')
  f.engine.run = async () => ({ items: [], retrieval: { exhaustive: false }, pageInfo: {} })
  const commit = f.store.commitRequest.bind(f.store)
  f.store.commitRequest = async (...args) => { await commit(...args); throw new Error('lost commit reply') }
  await assert.rejects(f.service.telegramSemanticSearch(f.context, { ...input, idempotencyKey: 'semantic-ambiguous' }), /lost commit reply/)
  f.engine.run = async () => assert.fail('unknown delivery must not recompute embedding')
  await assert.rejects(f.service.telegramSemanticSearch(f.context, { ...input, idempotencyKey: 'semantic-ambiguous' }), { code: 'request_outcome_unknown' })
})

test('known semantic preflight unavailable or retrieval-slot busy releases a request without claiming an embedding dispatch', async () => {
  for (const [code, status] of [['semantic_unavailable', 503], ['retrieval_busy', 429]]) {
    const f = await fixture(); let preflights = 0
    f.engine.run = async () => { preflights++; throw new AppError(status, code, 'preflight stopped before embedding') }
    await assert.rejects(f.service.telegramSemanticSearch(f.context, input), { code, status })
    await assert.rejects(f.service.telegramSemanticSearch(f.context, input), { code, status })
    assert.equal(preflights, 2)
    assert.ok([...f.store.requests.values()].every(row => row.status === 'released'))
  }
})

async function listen(t, app) {
  const server = createServer(app)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return `http://127.0.0.1:${server.address().port}`
}

test('Public delegates only TG semantic operation; Internal reauthenticates and meters exactly once', async t => {
  const f = await fixture()
  const options = { service: f.service, store: f.store, adapter: f.adapter, adminToken: 'test-admin-only', logger: { error() {} } }
  const internal = await listen(t, createApp({ ...options, listenerMode: 'admin' }))
  const proxy = createTelegramSemanticProxy({ baseUrl: internal })
  let delegated = 0
  const publicUrl = await listen(t, createApp({ ...options, listenerMode: 'public', telegramSemanticProxy: async request => { delegated++; return proxy(request) } }))
  const send = (base, path, key = f.apiKey.secret, body = input.body) => fetch(`${base}${path}`, { method: 'POST', headers: {
    authorization: `Bearer ${key}`, 'content-type': 'application/json', 'idempotency-key': input.idempotencyKey,
  }, body: JSON.stringify(body) })
  const first = await send(publicUrl, PATH)
  assert.equal(first.status, 200); assert.equal(first.headers.get('idempotent-replay'), 'false')
  const payload = await first.json()
  const second = await send(publicUrl, PATH)
  assert.equal(second.status, 200); assert.equal(second.headers.get('idempotent-replay'), 'true')
  assert.deepEqual(await second.json(), payload); assert.equal(f.calls.length, 1)
  assert.equal((await send(publicUrl, INTERNAL)).status, 404)
  assert.equal((await send(internal, PATH)).status, 404)
  assert.equal((await send(internal, INTERNAL, 'test-admin-only')).status, 401)
  assert.equal((await send(publicUrl, '/internal/v1/admin/data-products/telegram/semantic-search')).status, 404)
  assert.equal((await send(publicUrl, PATH, f.apiKey.secret, { query: '领导人', provider: 'caller-controlled' })).status, 400)
  assert.equal((await send(publicUrl, PATH, f.apiKey.secret, { query: '领导人', topK: 51 })).status, 400)
  assert.equal((await send(publicUrl, `${PATH}?query=ignored`)).status, 400)
  assert.equal(delegated, 2, 'invalid requests fail before the internal proxy')
  assert.equal(f.calls.length, 1)
})

test('real HTTP proxy bounds complete response time and bytes without redispatch; legal maximum Chinese result fits', async t => {
  const timers = []; let requests = 0
  t.after(() => timers.forEach(clearTimeout))
  const body = { data: { contractVersion: 'mx-insight-hub.telegram-semantic.v1', items: Array.from({ length: 50 }, () => ({
    title: '中'.repeat(500), text: '中'.repeat(12000), snippet: '中'.repeat(1600),
  })) }, requestId: '00000000-0000-4000-8000-000000000001' }
  let mode = 'legal'
  const url = await listen(t, (_request, response) => {
    requests++
    response.writeHead(200, { 'content-type': 'application/json', 'idempotent-replay': 'false' })
    if (mode === 'slow') {
      response.write('{')
      timers.push(setTimeout(() => { if (!response.destroyed) response.end('}') }, 500))
    } else if (mode === 'large') response.end('x'.repeat(4 * 1024 * 1024 + 1))
    else response.end(JSON.stringify(body))
  })
  const proxy = createTelegramSemanticProxy({ baseUrl: url, timeoutMs: 1000 })
  const result = await proxy({ apiKey: 'synthetic-only', ...input })
  assert.equal(result.status, 200); assert.equal(result.body.data.items.length, 50)
  assert.ok(Buffer.byteLength(JSON.stringify(body)) > 2 * 1024 * 1024)
  mode = 'large'
  await assert.rejects(proxy({ apiKey: 'synthetic-only', ...input }), { code: 'semantic_search_outcome_unknown' })
  mode = 'slow'
  const bounded = createTelegramSemanticProxy({ baseUrl: url, timeoutMs: 30 })
  await assert.rejects(bounded({ apiKey: 'synthetic-only', ...input }), { code: 'semantic_search_outcome_unknown' })
  assert.equal(requests, 3, 'each requested delivery dispatches exactly once, even after body failure')
})

test('a real HTTP redirect cannot forward customer credentials or dispatch to a second executor', async t => {
  let firstCalls = 0, secondCalls = 0
  const target = await listen(t, (_request, response) => { secondCalls++; response.end('{}') })
  const redirect = await listen(t, (_request, response) => { firstCalls++; response.writeHead(307, { location: target }); response.end() })
  const proxy = createTelegramSemanticProxy({ baseUrl: redirect })
  await assert.rejects(proxy({ apiKey: 'synthetic-only', ...input }), { code: 'semantic_search_outcome_unknown' })
  assert.equal(firstCalls, 1); assert.equal(secondCalls, 0)
})

test('Public preserves bounded executor Retry-After for backoff and the proxy rejects unbounded header values', async t => {
  const f = await fixture()
  f.engine.run = async () => { throw new AppError(429, 'retrieval_busy', 'busy before embedding', { retryAfterMs: 2500 }) }
  const options = { service: f.service, store: f.store, adapter: f.adapter, adminToken: 'test-admin-only', logger: { error() {} } }
  const internal = await listen(t, createApp({ ...options, listenerMode: 'admin' }))
  const publicUrl = await listen(t, createApp({ ...options, listenerMode: 'public',
    telegramSemanticProxy: createTelegramSemanticProxy({ baseUrl: internal }) }))
  const response = await fetch(`${publicUrl}${PATH}`, { method: 'POST', headers: {
    authorization: `Bearer ${f.apiKey.secret}`, 'content-type': 'application/json', 'idempotency-key': input.idempotencyKey,
  }, body: JSON.stringify(input.body) })
  assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '3')
  assert.equal((await response.json()).error.code, 'retrieval_busy')
  for (const retryAfter of ['0', '86400', '86401', '-1', 'tomorrow', '1.5']) {
    const proxy = createTelegramSemanticProxy({ baseUrl: 'http://internal.test', fetchImpl: async () => new Response(JSON.stringify({
      error: { code: 'retrieval_busy', message: 'busy' }, requestId: '00000000-0000-4000-8000-000000000001',
    }), { status: 429, headers: { 'retry-after': retryAfter } }) })
    assert.equal((await proxy({ apiKey: 'synthetic-only', ...input })).retryAfter, ['0', '86400'].includes(retryAfter) ? retryAfter : null)
  }
})

test('executor transport never follows redirects, retries dispatch or exposes upstream errors/credentials', async () => {
  let calls = 0
  const proxy = createTelegramSemanticProxy({ baseUrl: 'http://internal.test', fetchImpl: async (url, options) => {
    calls++; assert.equal(url.pathname, INTERNAL); assert.equal(options.redirect, 'error')
    assert.deepEqual(Object.keys(options.headers).sort(), ['authorization', 'content-type', 'idempotency-key'])
    throw new Error('credential-sentinel and internal hostname')
  } })
  await assert.rejects(proxy({ apiKey: 'credential-sentinel', ...input }), error => {
    assert.equal(error.code, 'semantic_search_outcome_unknown'); assert.doesNotMatch(error.message, /sentinel|hostname/); return true
  })
  assert.equal(calls, 1)
  assert.equal(telegramSemanticInternalUrl({}), null)
  assert.match(telegramSemanticInternalUrl({ KUBERNETES_SERVICE_HOST: 'x' }), /^http:\/\/mx-insight-hub-admin\./)
  for (const baseUrl of ['http://key@internal.test', 'http://internal.test/other', 'file:///tmp/test']) {
    assert.throws(() => createTelegramSemanticProxy({ baseUrl: baseUrl }))
  }
})
