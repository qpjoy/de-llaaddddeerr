import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { HUB_SOCIAL_ENDPOINTS, normalizeHubSocialRequest, normalizeTwitterResponse } from '../../server/contracts/hub-social.mjs'
import { RapidApiAdapter, TWITTER_AIO_HOST } from '../../server/adapters/rapidapi.mjs'
import { rapidApiConfig } from '../../server/external-platforms/rapidapi-config.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { createApp } from '../../server/app.mjs'
import { PUBLIC_OPENAPI_DOCUMENT, tenantOpenApiDocument } from '../../server/public-docs.mjs'
import { aggregateSourceCatalog, normalizeAggregateRequest } from '../../server/data/aggregate-search.mjs'
import { productAllowed } from '../../shared/product-access.mjs'
import { productEndpoints, productForPath } from '../../shared/product-workbenches.mjs'

const PEPPER = 'hub-social-synthetic-test-only-pepper-long-enough'
const SECRET = 'fixture-social-credential-no-live-key'
const USER = { rest_id: '42', legacy: { screen_name: 'example', name: 'Example', followers_count: 0, friends_count: 5 } }
const tweet = id => ({ rest_id: id, legacy: { full_text: '完整正文 #话题', favorite_count: 0, reply_count: 2, created_at: '2026-09-28T00:00:00Z', entities: { hashtags: [{ text: '话题' }] } },
  core: { user_results: { result: USER } }, note_tweet: { note_tweet_results: { result: { text: '完整长正文，不能截断\n#话题' } } } })
const entry = id => ({ entryId: `tweet-${id}`, content: { itemContent: { tweet_results: { result: tweet(id) } } } })
const timeline = (ids = ['1'], cursor = 'vendor-page-2') => ({ data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [{ entries: [
  ...ids.map(entry), ...(cursor ? [{ entryId: 'cursor-bottom-0', content: { cursorType: 'Bottom', value: cursor } }] : []),
] }] } } } } })
const profile = () => ({ data: { user: { result: USER } } })
const normalize = (body = {}, operation = 'search', options) => normalizeHubSocialRequest(operation, { platform: 'twitter', ...(operation === 'search' ? { query: 'test' } : { username: 'example' }), ...body }, options)

test('new request contract bounds one page, rejects hidden upstream parameters and binds cursors', () => {
  assert.equal(normalize({ keyword: 'test', pageSize: 20 }).count, 20)
  assert.equal(normalize({ platform: 'x', query: 'AI / 中文? #"x"' }).endpointPath, '/search/AI%20%2F%20%E4%B8%AD%E6%96%87%3F%20%23%22x%22')
  assert.equal(normalize({ username: '@Example' }, 'crawl').username, 'example')
  for (const body of [{ url: 'https://untrusted.invalid' }, { provider: 'other' }, { timeout: 100 }, { count: 0 }, { count: 51 }, { count: '20' }, { count: 1, limit: 2 }, { keyword: 'different' }, { sort: 'invalid' }, { query: '..' }]) assert.throws(() => normalize(body), { status: 400 })
  assert.throws(() => normalize({ platform: 'facebook' }), { code: 'social_platform_not_implemented' })
  assert.throws(() => normalize({ count: 20 }, 'search', { maxPageSize: 10 }), { status: 400 })
  assert.throws(() => normalize({ userId: '42' }, 'crawl'), { status: 400 })
  assert.throws(() => normalize({ count: 20 }, 'user-info'), { status: 400 })
  let state
  const first = normalize()
  normalizeTwitterResponse(timeline(), first, { encodeCursor: value => { state = value; return 'opaque' } })
  assert.equal(normalize({ cursor: 'opaque' }, 'search', { decodeCursor: () => state }).page, 2)
  for (const bad of [{ ...state, expiresAt: undefined }, { ...state, expiresAt: 1 }, { ...state, page: 16 }, { ...state, queryHash: 'changed' }]) assert.throws(() => normalize({ cursor: 'opaque' }, 'search', { decodeCursor: () => bad }), { code: 'invalid_cursor' })
})

test('normalization keeps full body, zero metrics, deduplicates and never consumes quoted tweets', () => {
  const data = timeline(['1', '1'])
  data.data.search_by_raw_query.search_timeline.timeline.instructions[0].entries[0].content.itemContent.tweet_results.result.quoted_status_result = { result: tweet('quoted') }
  const result = normalizeTwitterResponse(data, normalize(), { encodeCursor: () => 'opaque' })
  assert.equal(result.data.items.length, 1)
  assert.equal(result.data.items[0].title, null)
  assert.equal(result.data.items[0].metrics.likes, 0)
  assert.equal(result.data.items[0].metrics.views, null)
  assert.equal(result.data.items[0].content, '完整长正文，不能截断\n#话题')
  assert.equal(result.data.page.duplicateCount, 1)
  assert.equal(JSON.parse(result.data.raw_data)[0].title, '')
  assert.deepEqual(result.data.items[0].tags, ['话题'])
  assert.throws(() => normalizeTwitterResponse({ data: { message: 'not a timeline' } }, normalize()), /invalid_timeline_shape/)
  assert.throws(() => normalizeTwitterResponse({ data: { timeline: { instructions: [{ error: 'failed' }] } } }, normalize()), /invalid_timeline_shape/)
  assert.throws(() => normalizeTwitterResponse({ ...timeline([], null), errors: [{ message: 'bad query' }] }, normalize()), /upstream_business_errors/)
  assert.equal(normalizeTwitterResponse(timeline([], null), normalize()).data.items.length, 0)
  assert.throws(() => normalizeTwitterResponse(timeline(['1','2'], null), normalize({ count: 1 })), /exceeds_requested_count/)
  assert.throws(() => normalizeTwitterResponse(profile(), normalize({ username: 'another' }, 'user-info')), /identity_mismatch/)
  const info = normalizeTwitterResponse(profile(), normalize({}, 'user-info'))
  assert.equal(info.data.meta.profileCompleteness, 'base_profile_without_about')
  assert.equal(info.data.items[0].followers, 0)
  const retweetTimeline = { data: { user: { result: { ...USER, timeline: { timeline: { instructions: [{ entries: [entry('3')] }] } } } } } }
  retweetTimeline.data.user.result.timeline.timeline.instructions[0].entries[0].content.itemContent.tweet_results.result.core.user_results.result = { ...USER, rest_id: '43', legacy: { screen_name: 'other' } }
  assert.equal(normalizeTwitterResponse(retweetTimeline, normalize({}, 'crawl')).data.items.length, 1, 'account time line may contain retweets by other authors')
})

test('direct HTTP contracts perform exactly one fixed-host call without about or Python', async () => {
  for (const operation of ['search', 'crawl', 'user-info']) {
    let calls = 0
    const request = normalize({}, operation)
    const wire = JSON.stringify(operation === 'user-info' ? profile() : timeline(['1'], null))
    const adapter = new RapidApiAdapter({ apiKey: SECRET, fetchImpl: async (url, options) => {
      calls++
      assert.equal(url.host, TWITTER_AIO_HOST)
      assert.equal(url.pathname, request.endpointPath)
      assert.equal(options.method, 'GET')
      assert.equal(options.headers['x-rapidapi-key'], SECRET)
      assert.equal(options.redirect, 'error')
      if (operation === 'search') assert.equal(url.searchParams.get('category'), 'Latest')
      return new Response(wire, { headers: { 'x-rapidapi-request-id': 'synthetic-upstream-id' } })
    } })
    const result = await adapter.execute(request)
    assert.equal(calls, 1)
    assert.equal(result.publicBody.data.items.length, 1)
    assert.equal(result.restrictedResponseArchive.bodyBytes.toString(), wire)
    assert.equal(result.upstreamEvidence.requestId, 'synthetic-upstream-id')
    assert.doesNotMatch(JSON.stringify(result.responseArchive), /完整长正文/)
    assert.equal(Object.keys(result).includes('restrictedResponseArchive'), false)
  }
  const byId = normalizeHubSocialRequest('user-info', { platform: 'twitter', uid: '42' })
  assert.equal(byId.endpointPath, '/user/users/by/ids')
  assert.deepEqual(byId.upstreamQuery, { ids: '42' })
  assert.equal(normalizeTwitterResponse({ data: { users: [{ result: USER }] } }, byId).data.items[0].id, '42')
})

test('upstream rejection, unusable success, size/timeout and credential echoes never trigger retry', async () => {
  for (const scenario of ['400','502','bad-json','bad-shape','size','timeout','secret-code']) {
    let calls = 0
    const adapter = new RapidApiAdapter({ apiKey: SECRET, timeoutMs: 10, fetchImpl: async (_url, {signal}) => {
      calls++
      if (scenario === 'timeout') return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      if (scenario === 'size') return new Response('x', { headers: { 'content-length': String(5 * 1024 * 1024) } })
      if (scenario === 'bad-json') return new Response('{')
      if (scenario === 'bad-shape') return Response.json({ data: { error: 'failed' } })
      return Response.json({ error: { code: scenario === 'secret-code' ? SECRET : 'INVALID_QUERY', message: SECRET } }, { status: scenario === '502' ? 502 : 400 })
    } })
    await assert.rejects(adapter.execute(normalize()), error => {
      assert.equal(error.name, 'RapidApiUpstreamError')
      assert.equal(error.evidence.billed, null)
      assert.doesNotMatch(JSON.stringify(error), new RegExp(SECRET))
      assert.equal(error.evidence.outcome, ['400','secret-code'].includes(scenario) ? 'rejected' : ['502','timeout'].includes(scenario) ? 'unknown' : 'succeeded_unusable')
      return true
    })
    assert.equal(calls, 1)
  }
})

async function harness({ enabled = true, grant = true, outcome = 'success' } = {}) {
  const store = new MemoryStore()
  const legacyCalls = []
  const legacy = { search: async input => { legacyCalls.push(input); return { status: 200, data: { platform: 'twitter', raw_info: '[]', raw_data: '[]' } } } }
  const service = new HubService({ store, adapter: legacy, apiKeyPepper: PEPPER })
  const tenant = await service.createTenant({ name: 'Social fixture' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Synthetic social caller' })
  await store.setPlatformGrant(consumer.id, 'twitter', true)
  for (const endpoint of Object.values(HUB_SOCIAL_ENDPOINTS)) await service.putCapabilityConfiguration(endpoint.operation, { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const apiKey = await service.createApiKey({ consumerId: consumer.id, name: 'Fixture', platforms: ['twitter'], capabilities: grant ? Object.values(HUB_SOCIAL_ENDPOINTS).map(row => row.operation) : [] })
  const context = await service.authenticate(apiKey.secret)
  const config = { ...rapidApiConfig(), configured: true, timeoutMs: 50 }
  const control = new MemoryExternalPlatformControlStore()
  for (const endpoint of Object.values(HUB_SOCIAL_ENDPOINTS)) if (enabled) await control.updatePolicy('rapidapi', endpoint.operation, {
    expectedRevision: 1, desiredState: 'active', reason: 'Synthetic fixture only', priceBook: {
      currency: 'USD', pricingAsOf: '2026-09-28T00:00:00Z', monthlyBudgetMinor: 100000, monthlySubsidyBudgetMinor: 100000,
      unitCostMinorByEndpoint: { [endpoint.endpointKey]: 1 },
    },
  }, { runtime: { config, credentialConfigured: true } })
  let calls = 0
  const adapter = new RapidApiAdapter({ apiKey: SECRET, fetchImpl: async url => {
    calls++
    if (outcome === 'unknown') throw new Error('connection lost after dispatch')
    if (outcome === 'rejected') return Response.json({ code: 'BAD_QUERY', message: 'synthetic' }, { status: 400 })
    if (url.pathname.includes('/user/by/')) return Response.json(profile())
    return Response.json(timeline([String(calls)], calls < 2 ? 'page-2' : null))
  } })
  const platformStore = new MemoryExternalPlatformStore({ usageStore: store, providerKey: 'rapidapi', authorizationPlatform: 'twitter', uncertainCooldownMs: 900000 })
  const gateway = new ExternalPlatformGateway({ usageStore: store, platformStore, adapter, config, providerKey: 'rapidapi',
    apiKeyPepper: PEPPER, reservationLeaseMs: 150000, operationControlStore: control, logger: { warn() {} } })
  const query = { operation: 'search', body: { platform: 'twitter', query: 'test', count: 20 }, idempotencyKey: 'social-fixture-first-page', path: HUB_SOCIAL_ENDPOINTS.search.path }
  return { gateway, query, context, store, platformStore, service, apiKey, legacy, legacyCalls, calls: () => calls }
}

test('all three gateways enforce grants and disabled policies; committed pages replay forever', async () => {
  for (const options of [{ grant: false }, { enabled: false }]) {
    const h = await harness(options)
    await assert.rejects(h.gateway.socialData(h.context, h.query))
    assert.equal(h.calls(), 0)
  }
  for (const endpoint of Object.values(HUB_SOCIAL_ENDPOINTS)) {
    const h = await harness()
    const input = { ...h.query, operation: endpoint.key, path: endpoint.path, body: endpoint.key === 'search' ? h.query.body : { platform: 'twitter', username: 'example' } }
    const first = await h.gateway.socialData(h.context, input)
    const replay = await h.gateway.socialData(h.context, input)
    assert.equal(first.status, 200)
    assert.equal(first.body.data.items.length, 1)
    assert.deepEqual(replay.body, first.body)
    assert.equal(replay.replay, true)
    assert.equal(h.calls(), 1)
    assert.equal(h.legacyCalls.length, 0)
    assert.equal([...h.platformStore.calls.values()][0].billed, null)
  }
})

test('failed/unknown requests retain evidence and cannot redispatch via same identity', async () => {
  for (const outcome of ['unknown','rejected']) {
    const h = await harness({ outcome })
    let first
    await assert.rejects(h.gateway.socialData(h.context, h.query), error => { first = error; return true })
    assert.equal(first.details.outcome, outcome)
    if (outcome === 'rejected') { assert.equal(first.details.upstreamStatus, 400); assert.equal(first.details.upstreamCode, 'BAD_QUERY') }
    await assert.rejects(h.gateway.socialData(h.context, h.query))
    assert.equal(h.calls(), 1)
    assert.equal(h.legacyCalls.length, 0)
  }
})

test('new cursors bind query, count, Key and operation; valid continuation works once', async () => {
  const h = await harness()
  const first = await h.gateway.socialData(h.context, h.query)
  const cursor = first.body.data.pageInfo.nextCursor
  for (const change of [{ query: 'different' }, { count: 10 }]) await assert.rejects(h.gateway.socialData(h.context, { ...h.query, body: { ...h.query.body, cursor, ...change }, idempotencyKey: `social-changed-${Object.keys(change)[0]}` }), { code: 'invalid_cursor' })
  const otherKey = await h.service.createApiKey({ consumerId: h.context.consumer.id, name: 'Other fixture key', platforms: ['twitter'], capabilities: ['social.content.search'] })
  const otherContext = await h.service.authenticate(otherKey.secret)
  await assert.rejects(h.gateway.socialData(otherContext, { ...h.query, body: { ...h.query.body, cursor }, idempotencyKey: 'social-changed-key' }), { code: 'invalid_cursor' })
  await assert.rejects(h.gateway.socialData(h.context, { ...h.query, operation: 'crawl', path: HUB_SOCIAL_ENDPOINTS.crawl.path, body: { platform: 'twitter', username: 'example', cursor }, idempotencyKey: 'social-changed-operation' }), { code: 'invalid_cursor' })
  const secondQuery = { ...h.query, body: { ...h.query.body, cursor }, idempotencyKey: 'social-second-page' }
  const second = await h.gateway.socialData(h.context, secondQuery)
  assert.equal(second.body.data.page.page, 2)
  assert.equal(second.body.data.page.hasMore, false)
  await h.gateway.socialData(h.context, secondQuery)
  assert.equal(h.calls(), 2)
})

test('aggregate opt-in uses the same gateway with separate child billing and bound continuation', async () => {
  const h = await harness()
  const source = await h.service.aggregateSources(h.context, 'hub_only')
  assert.deepEqual(source.sources[0].routes.map(row => row.kind), ['hub_social'])
  assert.deepEqual((await h.service.aggregateSources(h.context)).sources[0].routes.map(row => row.kind), ['posts'])
  assert.throws(() => normalizeAggregateRequest({ query: 'test', execution: 'hub_only' }, aggregateSourceCatalog(['twitter'], [])), { status: 400 })
  const preview = await h.service.aggregatePreview(h.context, { query: 'test', execution: 'hub_only' })
  assert.equal(preview.items[0].meterKey, 'social.content.search')
  assert.equal(preview.dispatches, 0)
  const query = { body: { query: 'test', execution: 'hub_only', platforms: ['twitter'] }, path: '/api/v1/data/aggregate/search', idempotencyKey: 'aggregate-social-first-page', hubSocial: (context, input) => h.gateway.socialData(context, input) }
  const first = await h.service.aggregateSearch(h.context, query)
  assert.equal(first.body.data.items.length, 1)
  assert.equal(first.body.data.sources[0].status, 'ok')
  assert.equal(first.body.data.items[0].text, '完整长正文，不能截断\n#话题')
  const replay = await h.service.aggregateSearch(h.context, query)
  assert.deepEqual(replay.body, first.body)
  assert.equal(h.calls(), 1)
  const cursor = first.body.data.pageInfo.nextCursor
  assert.ok(cursor)
  await assert.rejects(h.service.aggregateSearch(h.context, { ...query, body: { query: 'test', platforms: ['twitter'], cursor }, idempotencyKey: 'aggregate-social-invalid-mode' }), { code: 'invalid_cursor' })
  const next = { ...query, body: { ...query.body, cursor }, idempotencyKey: 'aggregate-social-next-page' }
  const second = await h.service.aggregateSearch(h.context, next)
  assert.equal(second.body.data.items.length, 1)
  await h.service.aggregateSearch(h.context, { ...next, idempotencyKey: 'aggregate-social-next-replay' })
  assert.equal(h.calls(), 2)
  assert.equal(h.legacyCalls.length, 0)
})

test('HTTP routes and authenticated docs expose only the new granted interfaces', async () => {
  const h = await harness()
  const server = createServer(createApp({ service: h.service, store: h.store, adapter: h.legacy, hubSocialGateway: h.gateway, adminToken: 'test-admin', logger: { error() {} } }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const base = `http://127.0.0.1:${server.address().port}`
    const options = { method: 'POST', headers: { authorization: `Bearer ${h.apiKey.secret}`, 'content-type': 'application/json', 'idempotency-key': 'http-social-first-page' }, body: JSON.stringify(h.query.body) }
    const response = await fetch(base + h.query.path, options)
    assert.equal(response.status, 200, await response.text())
    assert.equal((await fetch(base + h.query.path, options)).headers.get('idempotent-replay'), 'true')
    assert.equal((await fetch(base + h.query.path + '?url=invalid', options)).status, 400)
    const sources = await fetch(base + '/api/v1/data/aggregate/sources?execution=hub_only', { headers: options.headers })
    assert.equal(sources.status, 200)
    assert.equal((await sources.json()).data.sources[0].routes[0].kind, 'hub_social')
    assert.equal(h.calls(), 1)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  const scopes = [{ platforms: ['twitter'], capabilities: ['social.content.search'] }]
  const docs = tenantOpenApiDocument(scopes)
  assert.ok(docs.paths['/data/social/search'])
  assert.equal(docs.paths['/data/social/crawl'], undefined)
  assert.equal(productAllowed('/data-products/social-content', scopes), true)
  assert.equal(productEndpoints(docs, productForPath('/data-products/social-content')).length, 1)
  assert.ok(PUBLIC_OPENAPI_DOCUMENT.paths['/data/aggregate/search'].post.requestBody.content['application/json'].schema.properties.execution)
})

test('enforced aggregate billing charges the new child meter once and adds no parent purchase', async () => {
  const h = await harness()
  const plan = await h.service.publishPlanVersion({
    key: 'social-paid-fixture', name: 'Synthetic social prices',
    limits: { monthlyRequests: 10000, maxPageSize: 100, burstRps: 100 },
    priceBook: { key: 'social-paid-fixture', currency: 'CNY', defaultMultiplierPpm: 1000000,
      entries: [{ meterKey: 'social.content.search', billingUnit: 'request', unitPriceMinor: 7 }] },
  }, 'test-admin')
  const current = await h.service.getConsumerPlan(h.context.consumer.id)
  await h.service.assignConsumerPlan(h.context.consumer.id, { planVersionId: plan.versionId, expectedRevision: current.revision }, 'test-admin')
  await h.service.setTenantBillingProfile(h.context.tenant.id, { mode: 'enforced', multiplierPpm: 1000000 }, 'test-admin')
  await h.service.addTenantCredit(h.context.tenant.id, { amountMinor: 100, currency: 'CNY', reason: 'Synthetic billing fixture' }, { idempotencyKey: 'social-credit-fixture', actor: 'test-admin' })
  const query = { body: { query: 'test', execution: 'hub_only', platforms: ['twitter'] }, path: '/api/v1/data/aggregate/search', idempotencyKey: 'aggregate-social-billed-page', hubSocial: (context, input) => h.gateway.socialData(context, input) }
  await h.service.aggregateSearch(h.context, query)
  await h.service.aggregateSearch(h.context, query)
  const charges = [...h.store.customerCharges.values()]
  const child = charges.find(row => row.meterKey === 'social.content.search')
  assert.equal(child.chargedMinor, 7)
  assert.equal(child.status, 'captured')
  assert.equal(charges.reduce((sum, row) => sum + row.chargedMinor, 0), 7)
  assert.equal(h.calls(), 1)
  const procurement = [...h.platformStore.calls.values()][0]
  assert.equal(procurement.endpointKey, 'twitter-aio.search')
  assert.equal(procurement.currency, 'USD')
  assert.equal(procurement.costKind, 'estimated')
  assert.equal(procurement.billed, null, 'customer settlement does not prove supplier billing')
})
