import assert from 'node:assert/strict'
import test from 'node:test'
import { createTwitterSearchRouter, resolveTwitterSearchProvider, twitterSearchCursorProvider } from '../../server/data/twitter-search-routing.mjs'
import { createDataSearchCursorCodec, createRawSearchCursorCodec } from '../../server/external-platforms/cursor.mjs'
import { RAW_SEARCH_VERSION } from '../../server/contracts/raw-search.mjs'
import { TIKHUB_CONTENT_SEARCH_VERSION } from '../../server/contracts/tikhub-content-search.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { HubService } from '../../server/hub-service.mjs'

const pepper = 'offline-twitter-provider-routing-32-characters'
const context = { tenant: { id: 'tenant' }, consumer: { id: 'consumer' }, apiKey: { id: 'key' } }
const codec = createDataSearchCursorCodec(pepper, 'consumer:key')
const recipe = 't.twitter_web_fetch_search_timeline'
const nativeState = { version: TIKHUB_CONTENT_SEARCH_VERSION, provider: 'tikhub', platform: 'twitter', recipe }
function harness(provider = 'tikhub') {
  const requests = new Map(), calls = []
  const usageStore = { requests, getUsageRequestForRetry: async id => [...requests.values()].find(row => row.id === id), getUsageRequestByIdempotencyKey: async (_, key) => requests.get(key) }
  const rapidGateway = { platformStore: { calls: new Map() }, searchRaw: async (...args) => { calls.push(['rapidapi', ...args]); return 'rapidapi' } }
  const tikHubGateway = { platformStore: { calls: new Map() }, searchContent: async (...args) => { calls.push(['tikhub', ...args]); return 'tikhub' } }
  return { requests, calls, rapidGateway, tikHubGateway, usageStore,
    route: createTwitterSearchRouter({ usageStore, rapidGateway, tikHubGateway, apiKeyPepper: pepper, provider }) }
}
const input = extras => ({ normalized: { platform: 'twitter', query: 'unchanged query', pageSize: 20 },
  body: { platform: 'twitter', query: 'unchanged query', pageSize: 20 }, dataSearch: { resultType: 'stable' },
  idempotencyKey: 'routing-test-key', ...extras })
const row = extras => ({ id: 'saved-request', tenantId: 'tenant', consumerId: 'consumer', apiKeyId: 'key', platform: 'twitter',
  status: 'committed', acquisitionRequest: { path: '/api/v1/data/search', body: { query: 'unchanged query' } }, ...extras })

test('automatic supplier readiness prefers RapidAPI and does not inspect TikHub when RapidAPI is ready', async () => {
  const calls = [], options = { context, operation: 'search_posts' }
  const resolved = await resolveTwitterSearchProvider({ options, capabilities: async (provider, receivedOptions) => {
    calls.push(provider)
    assert.strictEqual(receivedOptions, options)
    return { ready: true }
  } })
  assert.deepEqual(resolved, { provider: 'rapidapi', ready: true })
  assert.deepEqual(calls, ['rapidapi'])
})

test('automatic supplier readiness uses TikHub only when RapidAPI is unavailable or its readiness check fails', async () => {
  for (const rapidUnavailable of [async () => ({ ready: false }), async () => { throw new Error('readiness lookup failed') }]) {
    const calls = [], options = { context, operation: 'search_posts' }
    const resolved = await resolveTwitterSearchProvider({ provider: 'auto', options,
      capabilities: async (provider, receivedOptions) => {
        calls.push(provider)
        assert.strictEqual(receivedOptions, options)
        return provider === 'rapidapi' ? rapidUnavailable() : { ready: true }
      } })
    assert.deepEqual(resolved, { provider: 'tikhub', ready: true })
    assert.deepEqual(calls, ['rapidapi', 'tikhub'])
  }
})

test('automatic supplier readiness keeps RapidAPI unavailable when neither supplier is ready', async () => {
  for (const unavailable of [async () => ({ ready: false }), async () => { throw new Error('readiness lookup failed') }]) {
    const calls = []
    assert.deepEqual(await resolveTwitterSearchProvider({ capabilities: async provider => {
      calls.push(provider)
      return unavailable()
    } }), { provider: 'rapidapi', ready: false })
    assert.deepEqual(calls, ['rapidapi', 'tikhub'])
  }
})

test('fixed supplier readiness forwards options and preserves unavailable results without fallback', async () => {
  for (const provider of ['rapidapi', 'tikhub']) {
    const calls = [], options = { context, operation: 'search_posts' }
    assert.deepEqual(await resolveTwitterSearchProvider({ provider, options,
      capabilities: async (selected, receivedOptions) => {
        calls.push(selected)
        assert.strictEqual(receivedOptions, options)
        return { ready: false, reason: 'operation_disabled' }
      } }), { provider, ready: false, reason: 'operation_disabled' })
    assert.deepEqual(calls, [provider])
  }
})

test('fixed supplier readiness propagates the original error without inspecting another supplier', async () => {
  for (const provider of ['rapidapi', 'tikhub']) {
    const calls = [], error = new Error('fixed provider readiness failed')
    await assert.rejects(resolveTwitterSearchProvider({ provider, capabilities: async selected => {
      calls.push(selected)
      throw error
    } }), received => received === error)
    assert.deepEqual(calls, [provider])
  }
})

test('the router defaults new requests to RapidAPI when no readiness resolver is installed', async () => {
  const h = harness(), request = input(), original = structuredClone(request)
  const route = createTwitterSearchRouter({ usageStore: h.usageStore, rapidGateway: h.rapidGateway,
    tikHubGateway: h.tikHubGateway, apiKeyPepper: pepper })
  assert.equal(await route(context, request), 'rapidapi')
  assert.deepEqual(request, original)
  assert.strictEqual(h.calls[0][2], request)
})

test('automatic readiness fallback preserves the request and leaves existing TikHub cursors and replay pinned', async () => {
  const h = harness(), checks = [], options = { context, operation: 'search_posts' }
  let rapidReady = false
  const route = createTwitterSearchRouter({ usageStore: h.usageStore, rapidGateway: h.rapidGateway,
    tikHubGateway: h.tikHubGateway, apiKeyPepper: pepper,
    resolveProvider: async ctx => {
      assert.strictEqual(ctx, context)
      return (await resolveTwitterSearchProvider({ options, capabilities: async (provider, receivedOptions) => {
        checks.push(provider)
        assert.strictEqual(receivedOptions, options)
        return { ready: provider === 'rapidapi' ? rapidReady : true }
      } })).provider
    } })
  const request = input(), original = structuredClone(request)
  assert.equal(await route(context, request), 'tikhub')
  assert.deepEqual(request, original)
  assert.strictEqual(h.calls[0][2], request)
  assert.deepEqual(checks, ['rapidapi', 'tikhub'])

  rapidReady = true
  const continuation = input({ normalized: { ...input().normalized, cursor: codec.encode(nativeState) } })
  assert.equal(await route(context, continuation), 'tikhub')
  h.requests.set('routing-test-key', row({ acquisitionRequest: {
    searchProvider: 'tikhub', searchContractVersion: TIKHUB_CONTENT_SEARCH_VERSION } }))
  assert.equal(await route(context, request), 'tikhub')
  assert.deepEqual(checks, ['rapidapi', 'tikhub'], 'recovered RapidAPI readiness cannot move an existing TikHub page')

  h.requests.clear()
  assert.equal(await route(context, input({ idempotencyKey: 'new-after-rapidapi-recovery' })), 'rapidapi')
  assert.deepEqual(checks, ['rapidapi', 'tikhub', 'rapidapi'])
})

test('new standard searches use the selected Hub supplier without mutating any public conditions', async () => {
  for (const provider of ['tikhub', 'rapidapi']) {
    const h = harness(provider), request = input(), original = structuredClone(request)
    assert.equal(await h.route(context, request), provider)
    assert.deepEqual(request, original)
    assert.strictEqual(h.calls[0][1], context)
    assert.strictEqual(h.calls[0][2], request)
  }
  assert.throws(() => harness('other'), { code: 'invalid_configuration' })
})

test('unsupported Twitter options cannot reach a selected TikHub gateway or a rejected-response fallback', async () => {
  for (const params of [{ category: 'Photos' }, { category: 'Videos' }, { filters: 'lang:zh' }, { includeTimestamp: true }]) {
    const h = harness('tikhub'), request = input({ normalized: { ...input().normalized, params } })
    await assert.rejects(h.route(context, request), { code: 'twitter_search_parameters_unsupported' })
    assert.equal(h.calls.length, 0)
    const rapid = harness('rapidapi')
    const route = createTwitterSearchRouter({ usageStore: rapid.usageStore, rapidGateway: rapid.rapidGateway,
      tikHubGateway: rapid.tikHubGateway, apiKeyPepper: pepper, provider: 'rapidapi',
      policyStore: { get: async () => ({ mode: 'priority', primaryProvider: 'rapidapi', fallbackProvider: 'tikhub', revision: 1 }) } })
    assert.equal(await route(context, request), 'rapidapi')
    assert.equal(rapid.calls[0][3].rejectedFallback, null)
  }
})

test('malformed retry headers never reach a database UUID lookup before the gateway validates them', async () => {
  const h = harness('rapidapi')
  h.usageStore.getUsageRequestForRetry = async () => assert.fail('malformed UUID must not be queried')
  for (const retryOfRequestId of ['bad', '', ['bad']]) await h.route(context, input({ retryOfRequestId }))
  assert.equal(h.calls.length, 3)
})

test('automatic availability selection is only used for a new unpinned request and never retried after dispatch', async () => {
  const h = harness(), selected = []
  const route = createTwitterSearchRouter({ usageStore: h.usageStore, rapidGateway: h.rapidGateway, tikHubGateway: h.tikHubGateway,
    apiKeyPepper: pepper, provider: 'auto', resolveProvider: async ctx => { selected.push(ctx.consumer.id); return 'rapidapi' } })
  assert.equal(await route(context, input()), 'rapidapi')
  assert.deepEqual(selected, ['consumer'])
  h.requests.set('routing-test-key', row({ acquisitionRequest: { searchProvider: 'tikhub', searchContractVersion: TIKHUB_CONTENT_SEARCH_VERSION } }))
  assert.equal(await route(context, input()), 'tikhub')
  assert.deepEqual(selected, ['consumer'])
  h.requests.clear()
  assert.equal(await route(context, input({ normalized: { ...input().normalized, cursor: codec.encode(nativeState) } })), 'tikhub')
  assert.deepEqual(selected, ['consumer'])
  h.rapidGateway.searchRaw = async () => { throw Object.assign(new Error('saved supplier refusal'), { code: 'social_upstream_rejected' }) }
  await assert.rejects(route(context, input()), { code: 'social_upstream_rejected' })
  assert.equal(h.calls.filter(([provider]) => provider === 'tikhub').length, 2, 'no post-dispatch fallback to TikHub')
})

test('authenticated cursor versions pin both suppliers independently of the current deployment preference', async () => {
  for (const provider of ['tikhub', 'rapidapi']) {
    const h = harness(provider)
    for (const state of [{ version: RAW_SEARCH_VERSION }, { version: RAW_SEARCH_VERSION, provider: 'rapidapi' }, nativeState]) {
      const cursor = codec.encode(state)
      const request = input({ normalized: { ...input().normalized, cursor } })
      assert.equal(await h.route(context, request), state === nativeState ? 'tikhub' : 'rapidapi')
    }
  }
})

test('legacy mxnc1 remains under the original gateway, while malformed or cross-key mxds1 cannot select a supplier', async () => {
  const h = harness()
  assert.equal(await h.route(context, input({ normalized: { ...input().normalized, cursor: 'mxnc1.legacy-placeholder' } })), 'rapidapi')
  const invalid = [
    'mxds1.not-authenticated',
    createDataSearchCursorCodec(pepper, 'consumer:other-key').encode(nativeState),
    createRawSearchCursorCodec(pepper, 'consumer:key').encode(nativeState),
    codec.encode({ ...nativeState, recipe: 't.another_recipe' }),
    codec.encode({ ...nativeState, platform: 'weibo' }),
    codec.encode({ ...nativeState, provider: 'rapidapi' }),
    codec.encode({ version: RAW_SEARCH_VERSION, provider: 'tikhub' }),
  ]
  for (const cursor of invalid) await assert.rejects(h.route(context, input({ normalized: { ...input().normalized, cursor } })), { code: 'invalid_cursor' })
  assert.equal(h.calls.length, 1)
})

test('old same-key attempts keep RapidAPI replay and fresh renewal semantics before considering other-query guards', async () => {
  const h = harness()
  h.requests.set('routing-test-key', row())
  h.requests.set('other-key', row({ id: 'unresolved', status: 'unknown' }))
  assert.equal(await h.route(context, input()), 'rapidapi')
  for (const status of ['unknown', 'reserved', 'released']) {
    h.requests.set('routing-test-key', row({ status }))
    assert.equal(await h.route(context, input()), 'rapidapi', 'the owning gateway resolves its immutable status without new supplier selection')
  }
})

test('TikHub content manifests and owned receipts pin existing requests even after an operator rolls back the default', async () => {
  const h = harness('rapidapi')
  h.requests.set('routing-test-key', row({ status: 'released', acquisitionRequest: {
    searchProvider: 'tikhub', searchContractVersion: TIKHUB_CONTENT_SEARCH_VERSION } }))
  assert.equal(await h.route(context, input()), 'tikhub', 'pre-dispatch failures retain the reserved provider without a provider call')
  h.requests.set('routing-test-key', row({ acquisitionRequest: { contentSearch: { version: TIKHUB_CONTENT_SEARCH_VERSION } } }))
  assert.equal(await h.route(context, input()), 'tikhub')
  h.requests.set('routing-test-key', row())
  h.tikHubGateway.platformStore.calls.set('call', { usageRequestId: 'saved-request', tenantId: 'tenant', consumerId: 'consumer', apiKeyId: 'key',
    providerKey: 'tikhub', operation: `native.${recipe}`, endpointKey: `native.${recipe}` })
  assert.equal(await h.route(context, input()), 'tikhub')
  h.tikHubGateway.platformStore.calls.get('call').apiKeyId = 'other-key'
  assert.equal(await h.route(context, input()), 'rapidapi')
})

test('new intent checks equal in-flight queries across suppliers without replaying arbitrary historical rows', async () => {
  const h = harness()
  h.requests.set('older-key', row({ status: 'reserved', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }))
  await assert.rejects(h.route(context, input()), error => error.code === 'request_in_progress'
    && error.details.requestId === 'saved-request' && error.details.automaticRetryAllowed === false)
  assert.equal(h.calls.length, 0)
  h.requests.get('older-key').status = 'unknown'
  assert.equal(await h.route(context, input()), 'tikhub', 'an ended unknown receipt does not block a new intent')
  h.requests.get('older-key').status = 'reserved'
  h.requests.get('older-key').acquisitionRequest.body.query = 'unrelated'
  assert.equal(await h.route(context, input()), 'tikhub')
})

test('explicit legacy manual retry remains with its original validating gateway', async () => {
  const h = harness()
  h.requests.set('older-key', row({ status: 'unknown' }))
  const request = input({ retryOfRequestId: 'saved-request' })
  assert.equal(await h.route(context, request), 'rapidapi')
  assert.strictEqual(h.calls[0][2], request)
})

test('the public service preserves the existing explicit Twitter retry header when selecting its Hub-owned route', async () => {
  const store = new MemoryStore(), requests = []
  const service = new HubService({ store, apiKeyPepper: pepper,
    externalDataSearch: async (_, request) => { requests.push(request); return { requestId: 'offline-route-only' } } })
  const tenant = await service.createTenant({ name: 'Offline retry compatibility' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Existing Twitter consumer' })
  await store.setPlatformGrant(consumer.id, 'twitter', true)
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Existing Twitter key', platforms: ['twitter'], capabilities: [] })
  const ctx = await service.authenticate(key.secret), retryOfRequestId = '60799f1f-47f9-4ae1-81bb-8c08eb22b6f4'
  await service.search(ctx, { path: '/api/v1/data/search', body: input().body,
    idempotencyKey: 'existing-explicit-retry', retryOfRequestId })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].retryOfRequestId, retryOfRequestId)
  assert.equal(requests[0].dataSearch.resultType, 'fresh')
})

test('a caller cannot combine an old receipt identity with another supplier continuation', async () => {
  const h = harness()
  h.requests.set('routing-test-key', row())
  await assert.rejects(h.route(context, input({ normalized: { ...input().normalized, cursor: codec.encode(nativeState) } })), { code: 'idempotency_conflict' })
  assert.equal(h.calls.length, 0)
})

test('a TikHub attempt cannot silently accept the legacy supplier retry override', async () => {
  const h = harness()
  h.requests.set('routing-test-key', row({ status: 'unknown', acquisitionRequest: {
    searchProvider: 'tikhub', searchContractVersion: TIKHUB_CONTENT_SEARCH_VERSION } }))
  await assert.rejects(h.route(context, input({ retryOfRequestId: 'saved-request' })), { code: 'uncertain_retry_not_supported' })
  assert.equal(h.calls.length, 0)
})

test('Postgres receipt routing projects only owned operation metadata and remains read-only', async () => {
  const h = harness('rapidapi'), queries = []
  h.requests.set('routing-test-key', row())
  h.usageStore.pool = { async query(sql, args) { queries.push({ sql, args }); return { rows: [{ provider: 'tikhub', operation: `native.${recipe}`, endpoint: `native.${recipe}` }] } } }
  assert.equal(await h.route(context, input()), 'tikhub')
  assert.deepEqual(queries[0].args, ['saved-request', 'tenant', 'consumer', 'key'])
  assert.match(queries[0].sql, /^SELECT DISTINCT provider_key/u)
  assert.doesNotMatch(queries[0].sql, /INSERT|UPDATE|DELETE/u)
})
