import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { TikHubAdapter } from '../../server/adapters/tikhub.mjs'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { nativeForwardingEndpoint, NATIVE_FORWARDING_ENDPOINTS } from '../../server/contracts/native-forwarding.mjs'
import { TIKHUB_CONTENT_SEARCH_RECIPES } from '../../server/contracts/tikhub-content-search.mjs'
import { POST_COMMENTS_PATH, POST_COMMENTS_RECIPES } from '../../server/contracts/post-comments.mjs'
import { fillPageOption, takeFillPage, withSinglePage } from '../../server/contracts/single-page-delivery.mjs'
import { normalizeDataSearchV2, prepareDataSearchV2 } from '../../server/contracts/data-search-v2.mjs'
import { createDataSearchV2CursorCodec } from '../../server/external-platforms/cursor.mjs'

const PEPPER = 'offline-single-page-delivery-with-sufficient-entropy'
const config = { configured: true, contractVerified: true, nativeForwardingVerified: true, dispatchEnabled: true, timeoutMs: 100,
  freshTtlMs: 60000, staleTtlMs: 86400000, maxConcurrency: 3, maxConsumerConcurrency: 3, maxRequestsPerMinute: 1000, billing: {} }
const priceBook = endpointKey => ({ currency: 'USD', pricingAsOf: '2026-11-11T00:00:00Z', monthlyBudgetMinor: 100000,
  monthlySubsidyBudgetMinor: 100000, unitCostMinorByEndpoint: { [endpointKey]: 1 } })

// One synthetic supplier item per page, always with a further page.
const pages = {
  bilibili: n => ({ code: 0, data: { page: n, numPages: 10, result: [{ id: String(n), title: `标题 ${n}`, description: `内容 ${n}`, review: 0, play: 0 }] } }),
  kuaishou: n => ({ mixFeeds: [{ itemType: 'feed_photo', feed: { photoId: `photo-${n}`, caption: `完整正文 ${n}` } }],
    pcursor: `next-${n}`, has_more: true }),
  zhihu: n => ({ data: [{ type: 'search_result', object: { id: String(n), type: 'article', title: `标题 ${n}`, content: `<p>完整正文 ${n}</p>` } }],
    paging: { is_end: false, next: `https://api.zhihu.com/search_v3?offset=${n * 20}&search_hash_id=fixture-session` } }),
}

async function contentHarness(platform, payload = (_call, n) => pages[platform](n)) {
  const calls = [], store = new MemoryStore()
  const service = new HubService({ store, apiKeyPepper: PEPPER, adapter: {
    async legacySearch() { throw new Error('Unexpected Night-All dispatch') },
    async search() { throw new Error('Unexpected Night-All dispatch') },
  } })
  const tenant = await service.createTenant({ name: 'Offline single-page fixture' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Synthetic caller' })
  for (const name of [platform, 'linkedin']) await store.setPlatformGrant(consumer.id, name, true)
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Synthetic key', platforms: [platform, 'linkedin'], capabilities: [] })
  const context = await service.authenticate(key.secret)
  const endpoint = nativeForwardingEndpoint(TIKHUB_CONTENT_SEARCH_RECIPES[platform].key)
  const controls = new MemoryExternalPlatformControlStore()
  await controls.updatePolicy('tikhub', endpoint.operation, { expectedRevision: 1, desiredState: 'active', reason: 'Offline regression',
    priceBook: priceBook(endpoint.endpointKey) }, { runtime: { config, credentialConfigured: true } })
  const adapter = new TikHubAdapter({ apiKey: 'fixture-secret', timeoutMs: 100, fetchImpl: async (url, options) => {
    const parsed = new URL(url)
    calls.push({ params: options.method === 'POST' ? JSON.parse(options.body) : Object.fromEntries(parsed.searchParams) })
    return Response.json({ code: 200, request_id: `synthetic-${calls.length}`, data: payload(calls.at(-1), calls.length) })
  } })
  const platformStore = new MemoryExternalPlatformStore({ usageStore: store, providerKey: 'tikhub', authorizationPlatform: platform })
  const gateway = new ExternalPlatformGateway({ usageStore: store, platformStore, adapter, config, providerKey: 'tikhub',
    apiKeyPepper: PEPPER, reservationLeaseMs: 150000, operationControlStore: controls, logger: { warn() {} } })
  service.externalDataSearch = (current, input) => gateway.searchContent(current, input)
  const search = (body, idempotencyKey) => service.search(context, { body, idempotencyKey, path: '/api/v1/data/search' })
  return { store, service, calls, search }
}

test('fillPage parsing keeps the default, rejects non-booleans and never changes an absent or true request', () => {
  assert.equal(fillPageOption({ platform: 'zhihu' }), true)
  assert.equal(fillPageOption({ fillPage: true }), true)
  assert.equal(fillPageOption({ fillPage: false }), false)
  for (const value of ['false', 0, null, {}]) assert.throws(() => fillPageOption({ fillPage: value }), { code: 'invalid_fill_page' })
  assert.deepEqual(takeFillPage({ platform: 'x', fillPage: false }), { body: { platform: 'x' }, singlePage: true })
  assert.deepEqual(takeFillPage({ platform: 'x', fillPage: true }), { body: { platform: 'x' }, singlePage: false })
  const body = { platform: 'x' }
  assert.equal(takeFillPage(body).body, body)
  const request = { fingerprintBody: { a: 1 }, other: true }
  assert.equal(withSinglePage(request, false), request)
  assert.deepEqual(withSinglePage(request, true), { fingerprintBody: { a: 1, fillPage: false }, other: true, singlePage: true })
})

for (const platform of Object.keys(pages)) {
  test(`${platform} standard search with fillPage=false buys one supplier page per request and keeps cursors mode-independent`, async () => {
    const h = await contentHarness(platform)
    const body = { platform, query: '城市', pageSize: 5 }
    const first = await h.search({ ...body, fillPage: false }, `${platform}-single-1`)
    assert.equal(h.calls.length, 1)
    assert.equal(first.body.data.items.length, 1)
    assert.equal(first.body.data.pageInfo.hasMore, true)
    assert.equal(first.body.data.meta.providerCalls, 1)
    assert.equal(first.body.data.warnings.some(row => row.code === 'content_search_fill_stopped'), false)
    const second = await h.search({ ...body, fillPage: false, cursor: first.body.data.pageInfo.nextCursor }, `${platform}-single-2`)
    assert.equal(h.calls.length, 2)
    assert.equal(second.body.data.items.length, 1)
    assert.notEqual(second.body.data.items[0].id, first.body.data.items[0].id)
    // A single-page cursor continues in the default (filling) mode, too.
    const filled = await h.search({ ...body, cursor: second.body.data.pageInfo.nextCursor }, `${platform}-filled-3`)
    assert.equal(filled.body.data.items.length, 5)
    assert.equal(h.calls.length, 7)
    // Same key and body replays; the other mode under that key is a conflict.
    assert.deepEqual((await h.search({ ...body, fillPage: false }, `${platform}-single-1`)).body, first.body)
    assert.equal(h.calls.length, 7)
    await assert.rejects(h.search(body, `${platform}-single-1`), { code: 'idempotency_conflict' })
  })
}

test('the default request still fills, and an explicit fillPage=true keeps its existing idempotency identity', async () => {
  const h = await contentHarness('kuaishou')
  const body = { platform: 'kuaishou', query: '城市', pageSize: 5 }
  const filled = await h.search(body, 'kuaishou-default-fill')
  assert.equal(filled.body.data.items.length, 5)
  assert.equal(h.calls.length, 5)
  const replay = await h.search({ ...body, fillPage: true }, 'kuaishou-default-fill')
  assert.equal(replay.replay, true)
  assert.deepEqual(replay.body, filled.body)
  assert.equal(h.calls.length, 5)
})

test('single-page delivery serves saved overflow without a supplier call before buying the next page', async () => {
  const h = await contentHarness('bilibili', (_call, n) => ({ code: 0, data: { page: n, numPages: 3,
    result: (n === 1 ? ['a', 'b', 'c'] : [`p${n}`]).map(id => ({ id, title: `标题 ${id}`, description: `内容 ${id}`, review: 0, play: 0 })) } }))
  const body = { platform: 'bilibili', query: '城市', pageSize: 2, fillPage: false }
  const first = await h.search(body, 'bilibili-overflow-1')
  assert.deepEqual(first.body.data.items.map(row => row.externalId), ['a', 'b'])
  const second = await h.search({ ...body, cursor: first.body.data.pageInfo.nextCursor }, 'bilibili-overflow-2')
  assert.deepEqual(second.body.data.items.map(row => row.externalId), ['c'])
  assert.equal(second.body.data.meta.providerCalls, 0)
  assert.equal(second.body.data.pageInfo.hasMore, true)
  assert.equal(h.calls.length, 1)
  const third = await h.search({ ...body, cursor: second.body.data.pageInfo.nextCursor }, 'bilibili-overflow-3')
  assert.deepEqual(third.body.data.items.map(row => row.externalId), ['p2'])
  assert.equal(h.calls.length, 2)
})

test('fillPage rejects invalid values and routes that cannot honor it before any reservation', async () => {
  const h = await contentHarness('zhihu')
  await assert.rejects(h.search({ platform: 'zhihu', query: '城市', fillPage: 'false' }, 'zhihu-invalid-fill'), { code: 'invalid_fill_page' })
  await assert.rejects(h.search({ platform: 'linkedin', query: '城市', fillPage: false }, 'linkedin-single-page'), { code: 'fill_page_unsupported' })
  assert.equal(h.calls.length, 0)
  assert.equal(h.store.requests.size, 0)
})

test('WeChat search accepts a validated fillPage without passing it to its strict single-page contract', async () => {
  const h = await contentHarness('zhihu')
  const seen = []
  h.service.externalWechatSearch = async (_context, input) => { seen.push(input); return { status: 200, body: { data: {} }, requestId: 'synthetic', replay: false } }
  await h.search({ platform: 'wechat_search', query: '城市', fillPage: false }, 'wechat-single-page')
  assert.equal(seen.length, 1)
  assert.equal(Object.hasOwn(seen[0], 'fillPage'), false)
  await assert.rejects(h.search({ platform: 'wechat_search', query: '城市', fillPage: 1 }, 'wechat-invalid-fill'), { code: 'invalid_fill_page' })
})

test('v2 carries fillPage to its v1 page without binding the v2 cursor to the mode', () => {
  const window = { from: '2026-11-10T00:00:00.000+08:00', to: '2026-11-11T00:00:00.000+08:00', timezone: 'Asia/Shanghai', boundary: '[from,to)' }
  const base = { platform: 'kuaishou', query: '城市', pageSize: 20, timeWindow: window }
  const single = normalizeDataSearchV2({ ...base, fillPage: false })
  assert.equal(single.fillPage, false)
  assert.equal(Object.hasOwn(normalizeDataSearchV2({ ...base, fillPage: true }), 'fillPage'), false)
  const codec = createDataSearchV2CursorCodec(PEPPER, 'consumer:key')
  const prepared = prepareDataSearchV2(single, codec)
  assert.equal(prepared.upstream.fillPage, false)
  assert.equal(Object.hasOwn(prepareDataSearchV2(normalizeDataSearchV2(base), codec).upstream, 'fillPage'), false)
  const cursor = codec.encode({ ...prepared.state, page: 2, cursor: 'mxds1.synthetic' })
  assert.equal(prepareDataSearchV2(normalizeDataSearchV2({ ...base, cursor }), codec).state.page, 2)
  assert.throws(() => normalizeDataSearchV2({ ...base, fillPage: 'no' }), { code: 'invalid_fill_page' })
})

async function twitterFixture(pageList) {
  const usage = new MemoryStore()
  const service = new HubService({ store: usage, adapter: {}, apiKeyPepper: PEPPER })
  const tenant = await service.createTenant({ name: 'Offline Twitter single-page fixture' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Offline consumer' })
  await usage.setPlatformGrant(consumer.id, 'twitter', true)
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Offline key', platforms: ['twitter'], capabilities: [] })
  const context = await service.authenticate(key.secret)
  const controls = new MemoryExternalPlatformControlStore()
  await controls.updatePolicy('rapidapi', 'social.content.search', { expectedRevision: 1, desiredState: 'active', reason: 'Offline fixture',
    priceBook: priceBook('twitter-aio.search') }, { runtime: { config, credentialConfigured: true } })
  const store = new MemoryExternalPlatformStore({ usageStore: usage, providerKey: 'rapidapi', authorizationPlatform: 'twitter' })
  let calls = 0
  const adapter = new RapidApiAdapter({ apiKey: 'fixture-secret', timeoutMs: 100, fetchImpl: async () => {
    const page = pageList[calls++] || { ids: [], next: null }
    return Response.json({ entries: [
      ...page.ids.map(id => ({ content: { itemContent: { tweet_results: { result: { rest_id: id, legacy: { full_text: `tweet ${id}` } } } } } })),
      ...(page.next ? [{ content: { cursorType: 'Bottom', value: page.next } }] : []),
    ] })
  } })
  const gateway = new ExternalPlatformGateway({ usageStore: usage, platformStore: store, adapter, config, providerKey: 'rapidapi',
    apiKeyPepper: PEPPER, operationControlStore: controls, reservationLeaseMs: 150000, logger: { warn() {}, error() {} } })
  const invoke = ({ cursor, fillPage, idempotencyKey }) => {
    const normalized = { platform: 'twitter', query: 'fixture', pageSize: 3, ...(cursor ? { cursor } : {}), ...(fillPage === false ? { fillPage } : {}) }
    return gateway.searchRaw(context, { body: { ...normalized, type: 'stable' }, normalized, idempotencyKey,
      dataSearch: { resultType: 'stable', replayWindowMs: null } }, {})
  }
  return { invoke, calls: () => calls }
}

test('Twitter RapidAPI search with fillPage=false returns its first page; the default still fills the page', async () => {
  const list = [{ ids: ['1'], next: 'n1' }, { ids: ['2'], next: 'n2' }, { ids: ['3'], next: 'n3' }, { ids: ['4'], next: null }]
  const filled = await twitterFixture(list)
  const all = await filled.invoke({ idempotencyKey: 'twitter-default-fill' })
  assert.deepEqual(all.body.data.items.map(row => row.id), ['1', '2', '3'])
  assert.equal(filled.calls(), 3)
  const single = await twitterFixture(list)
  const first = await single.invoke({ fillPage: false, idempotencyKey: 'twitter-single-1' })
  assert.deepEqual(first.body.data.items.map(row => row.id), ['1'])
  assert.equal(first.body.data.pageInfo.hasMore, true)
  assert.equal(first.body.data.warnings.some(row => row.code === 'TWITTER_PAGE_FILL_STOPPED'), false)
  assert.equal(single.calls(), 1)
  const second = await single.invoke({ fillPage: false, cursor: first.body.data.pageInfo.nextCursor, idempotencyKey: 'twitter-single-2' })
  assert.deepEqual(second.body.data.items.map(row => row.id), ['2'])
  assert.equal(single.calls(), 2)
})

async function commentsHarness(payload) {
  const calls = [], store = new MemoryStore(), platform = 'youtube', provider = POST_COMMENTS_RECIPES[platform].provider
  const service = new HubService({ store, apiKeyPepper: PEPPER, adapter: { async legacySearch() { throw new Error('Night-All must never be called') } } })
  const tenant = await service.createTenant({ name: 'Offline comments' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Comments caller' })
  await store.setPlatformGrant(consumer.id, platform, true)
  await store.putPolicy({ tenantId: tenant.id, consumerId: consumer.id, platform, maxRequests: 10000,
    windowSeconds: 3600, maxPageSize: 100, maxCrawlWork: 1000 })
  await service.putCapabilityConfiguration('social.comments.list', { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Synthetic comments key', platforms: [platform], capabilities: ['social.comments.list'] })
  const controls = new MemoryExternalPlatformControlStore()
  const endpoint = NATIVE_FORWARDING_ENDPOINTS.find(row => row.provider === provider && row.path === POST_COMMENTS_RECIPES[platform].path)
  await controls.updatePolicy(provider, endpoint.operation, { expectedRevision: 1, desiredState: 'active', reason: 'Synthetic comments regression',
    priceBook: priceBook(endpoint.endpointKey) }, { runtime: { config, credentialConfigured: true } })
  const adapter = new TikHubAdapter({ apiKey: 'fixture-secret', timeoutMs: 100, fetchImpl: async url => {
    calls.push(Object.fromEntries(new URL(url).searchParams))
    return Response.json(payload(calls.length))
  } })
  const platformStore = new MemoryExternalPlatformStore({ usageStore: store, providerKey: provider, authorizationPlatform: platform })
  const gateway = new ExternalPlatformGateway({ usageStore: store, platformStore, adapter, config, providerKey: provider,
    apiKeyPepper: PEPPER, reservationLeaseMs: 150000, operationControlStore: controls, logger: { warn() {} } })
  service.externalPostComments = (current, input) => gateway.postComments(current, { ...input, platform, path: POST_COMMENTS_PATH })
  return { service, store, calls, secret: key.secret }
}

test('post comments over HTTP accept fillPage=false, buy one supplier page and continue with the returned cursor', async t => {
  const comment = id => ({ comment_id: id, content: `完整评论 ${id}`, published_time: '2 days ago', like_count: '0', reply_count: '0',
    author: { channel_id: 'UC' + 'a'.repeat(22), display_name: '作者' } })
  const h = await commentsHarness(n => ({ code: 200, data: { comments: [comment(`c${n}`)], continuation_token: `token-${n}` } }))
  const server = createServer(createApp({ service: h.service, store: h.store, listenerMode: 'public', logger: { error() {} } }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const post = async (body, key) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${POST_COMMENTS_PATH}`, { method: 'POST', headers: {
      authorization: `Bearer ${h.secret}`, 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  const body = { platform: 'youtube', contentId: 'dQw4w9WgXcQ', count: 3 }
  const first = await post({ ...body, fillPage: false }, 'comments-single-1')
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.deepEqual(first.body.data.items.map(row => row.commentId), ['c1'])
  assert.equal(first.body.data.page.hasMore, true)
  assert.equal(h.calls.length, 1)
  const second = await post({ ...body, fillPage: false, cursor: first.body.data.page.nextCursor }, 'comments-single-2')
  assert.deepEqual(second.body.data.items.map(row => row.commentId), ['c2'])
  assert.equal(h.calls.length, 2)
  const conflict = await post(body, 'comments-single-1')
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error.code, 'idempotency_conflict')
  const filled = await post(body, 'comments-default-fill')
  assert.equal(filled.body.data.items.length, 3)
  assert.equal(h.calls.length, 5)
  const invalid = await post({ ...body, fillPage: 'no' }, 'comments-invalid-fill')
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.error.code, 'invalid_fill_page')
})
