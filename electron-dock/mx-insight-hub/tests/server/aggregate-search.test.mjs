import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { HubService } from '../../server/hub-service.mjs'
import { createApp } from '../../server/app.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { AppError } from '../../server/core/errors.mjs'
import { aggregateSourceCatalog, normalizeAggregateRequest, refreshAggregate } from '../../server/data/aggregate-search.mjs'
import { normalizeCanonicalSearchQuery, canonicalSearchResponse } from '../../server/data/stored-search.mjs'
import { SearchQueries } from '../../server/search/queries.mjs'

const pepper = 'aggregate-search-test-pepper-with-enough-entropy'
const id = '11111111-1111-4111-8111-111111111111'
async function setup({ platforms = ['weibo', 'telegram'], capabilities = [], searchQueries = null } = {}) {
  const calls = []
  const store = new MemoryStore()
  const adapter = { search: async input => {
    calls.push(input)
    return { payload: { data: { items: [{ id: 'live-1', title: '实时新闻', text: '最新正文', privateToken: 'never-return' }], pageInfo: { hasMore: false } } }, raw: { items: [] } }
  } }
  const service = new HubService({ store, adapter, apiKeyPepper: pepper, searchQueries })
  const tenant = await service.createTenant({ name: 'aggregate test' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'caller' })
  for (const platform of platforms) await service.putPlatformConfiguration(platform, { tenantId: tenant.id, consumerId: consumer.id, enabled: true, maxRequests: 100, windowSeconds: 60, maxPageSize: 100 })
  for (const capability of capabilities) await service.putCapabilityConfiguration(capability, { tenantId: tenant.id, consumerId: consumer.id, enabled: true, maxRequests: 100, windowSeconds: 60 })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'aggregate key', platforms, capabilities })
  return { store, service, adapter, calls, key, context: await service.authenticate(key.secret) }
}

test('aggregate source discovery is grant-scoped and does not advertise private IP/company data', async () => {
  const sources = aggregateSourceCatalog(['weibo', 'telegram', 'ip', 'enterprise', 'xiaohongshu', 'ecommerce'], [])
  assert.deepEqual(sources.map(row => row.platform), [...Object.keys((await import('../../server/contracts/justone.mjs')).JUSTONE_ENDPOINTS), 'telegram', 'weibo', 'xiaohongshu'])
  assert.equal(sources.find(row => row.platform === 'xiaohongshu').refresh, false)
  assert.equal(sources.find(row => row.platform === 'taobao').refresh, false)
  assert.equal(sources.find(row => row.platform === 'weibo').refresh, true)
  assert.doesNotMatch(JSON.stringify(sources), /justone|tikhub|night-all|endpoint|credential/i)
  assert.equal(normalizeAggregateRequest({ query: '新闻' }, sources).mode, 'refresh')
  assert.throws(() => normalizeAggregateRequest({ query: '新闻', platforms: ['facebook'] }, sources), { code: 'platform_not_granted' })
  assert.throws(() => normalizeAggregateRequest({ query: '新闻', filters: { tags: ['新闻'] } }, sources), { code: 'refresh_filters_unsupported' })
  assert.throws(() => normalizeAggregateRequest({ query: '新闻', platforms: ['telegram'] }, sources), { code: 'refresh_unavailable' })
})

test('default live aggregate works without the stored search layer; replay is durable and never redispatches', async () => {
  const { service, context, calls, store } = await setup()
  const input = { body: { query: '新闻' }, path: '/api/v1/data/aggregate/search', idempotencyKey: 'aggregate-live-test' }
  const first = await service.aggregateSearch(context, input)
  assert.equal(first.status, 200)
  assert.equal(first.body.data.mode, 'refresh')
  assert.equal(first.body.data.items[0].title, '实时新闻')
  assert.equal(first.body.data.items[0].platform, 'weibo')
  assert.equal(first.body.data.status, 'partial')
  assert.equal(first.body.data.sources.find(row => row.platform === 'telegram').status, 'unsupported')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].body.platform, 'weibo')
  assert.doesNotMatch(JSON.stringify(first.body), /never-return|privateToken/)
  const replay = await service.aggregateSearch(context, input)
  assert.equal(replay.replay, true)
  assert.deepEqual(replay.body, first.body)
  assert.equal(calls.length, 1)
  assert.equal(store.requests.get(first.requestId).unitsActual, 0)
  await assert.rejects(service.aggregateSearch(context, { ...input, body: { query: '不同关键词' } }), { code: 'idempotency_conflict' })
})

test('single and multiple selections dispatch exactly their authorized live routes', async () => {
  const { service, context, calls } = await setup({ platforms: ['weibo', 'douyin', 'bilibili'] })
  const path = '/api/v1/data/aggregate/search'
  await service.aggregateSearch(context, { path, idempotencyKey: 'aggregate-single', body: { query: '新闻', platforms: ['weibo'] } })
  assert.deepEqual(calls.map(call => call.body.platform), ['weibo'])
  calls.length = 0
  await service.aggregateSearch(context, { path, idempotencyKey: 'aggregate-multi', body: { query: '新闻', platforms: ['douyin', 'bilibili'] } })
  assert.deepEqual(calls.map(call => call.body.platform).sort(), ['bilibili', 'douyin'])
  calls.length = 0
  await assert.rejects(service.aggregateSearch(context, { path, idempotencyKey: 'aggregate-forbidden', body: { query: '新闻', platforms: ['facebook'] } }), { code: 'platform_not_granted' })
  assert.equal(calls.length, 0)
})

test('stored aggregate applies all facets before paging, omits expensive totals, and never calls upstream', async () => {
  const searches = []
  const { service, context, calls } = await setup({ searchQueries: { searchContent: async (query, options) => {
    searches.push(options)
    return { mode: 'postgres', items: [{ id, platform: 'telegram', objectType: 'message', body: '存量内容' }], hasMore: false }
  } } })
  const input = { path: '/api/v1/data/aggregate/search', idempotencyKey: 'aggregate-stored', body: {
    mode: 'stored', query: '新闻', platforms: ['telegram'], objectTypes: ['chat', 'message'], filters: { tags: ['新闻', '中国'], from: '2026-09-20T00:00:00+08:00' },
  } }
  const result = await service.aggregateSearch(context, input)
  assert.equal(result.body.data.mode, 'stored')
  assert.deepEqual(searches[0].platforms, ['telegram'])
  assert.deepEqual(searches[0].objectTypes, ['chat', 'message'])
  assert.deepEqual(searches[0].tags, ['中国', '新闻'])
  assert.equal(searches[0].fromTime, '2026-09-19T16:00:00.000Z')
  assert.equal(searches[0].trackTotalHits, false)
  assert.equal(calls.length, 0)
})

test('marketplace selection maps to ecommerce authorization and exact stored facets', async () => {
  const searches = []
  const { service, context } = await setup({ platforms: ['ecommerce'], capabilities: ['ecommerce.products.search'], searchQueries: { searchContent: async (q, options) => {
    searches.push(options)
    return { mode: 'postgres', hasMore: false, items: [{ id, platform: 'ecommerce', externalId: 'taobao:one', objectType: 'product', title: '商品' }] }
  } } })
  const sources = await service.aggregateSources(context)
  assert.ok(sources.sources.some(source => source.platform === 'taobao' && source.refresh))
  const body = { query: '鞋', mode: 'stored', platforms: ['taobao', 'jd'] }
  const result = await service.aggregateSearch(context, { body, path: '/api/v1/data/aggregate/search', idempotencyKey: 'aggregate-marketplaces' })
  assert.deepEqual(searches[0].platforms, ['ecommerce'])
  assert.deepEqual(searches[0].marketplaces, ['jd', 'taobao'])
  assert.equal(result.body.data.items[0].platform, 'taobao')
  const dispatched = []
  const live = await service.aggregateSearch(context, { body: { ...body, mode: 'refresh' }, path: '/api/v1/data/aggregate/search', idempotencyKey: 'aggregate-marketplaces-live', products: async (ctx, input) => {
    assert.equal(ctx.apiKey.id, context.apiKey.id)
    dispatched.push(input.body)
    return { status: 200, requestId: id, body: { data: { items: [{ id: 'one', title: '实时商品' }] } } }
  } })
  assert.deepEqual(dispatched.map(body => body.marketplace).sort(), ['jd', 'taobao'])
  assert.ok(dispatched.every(body => body.deliveryMode === 'live_only'))
  assert.equal(live.body.data.items.length, 2)
  assert.equal(searches.length, 1, 'live mode never searches stored data')
})

test('aggregate facets bind the signed cursor without changing the original canonical contract', () => {
  const options = { platforms: ['telegram'], cursorSecret: pepper, aggregateScope: { contract: 'aggregate.v1', objectTypes: ['message'], tags: ['one'] } }
  const query = normalizeCanonicalSearchQuery({ query: 'news' }, options)
  const first = canonicalSearchResponse({ query, cursorSecret: pepper, durationMs: 1, result: { items: [{ id }], hasMore: true, nextCursor: { mode: 'postgres', searchAfter: ['2026-09-20T00:00:00.000Z', id] } } })
  assert.ok(normalizeCanonicalSearchQuery({ query: 'news', cursor: first.data.pageInfo.nextCursor }, options).cursor)
  assert.throws(() => normalizeCanonicalSearchQuery({ query: 'news', cursor: first.data.pageInfo.nextCursor }, { ...options, aggregateScope: { ...options.aggregateScope, tags: ['two'] } }), { code: 'invalid_cursor' })
  assert.throws(() => normalizeCanonicalSearchQuery({ query: 'news', objectTypes: ['message'] }, options), { code: 'unsupported_fields' })
})

test('live fan-out is bounded, preserves successful results and does not retry unknown outcomes', async () => {
  let active = 0, peak = 0, calls = 0
  const sources = aggregateSourceCatalog(['weibo', 'douyin', 'bilibili'], [])
  const query = normalizeAggregateRequest({ query: 'news' }, sources)
  const result = await refreshAggregate(query, { requestId: id, concurrency: 2, search: async input => {
    calls++; active++; peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 5)); active--
    if (input.body.platform === 'douyin') throw new AppError(502, 'upstream_outcome_unknown', 'private supplier error', { requestId: 'unknown-child' })
    return { status: 200, requestId: input.body.platform, body: { data: { items: [{ id: 'same-id', title: input.body.platform }] } } }
  } })
  assert.equal(peak, 2); assert.equal(calls, 3); assert.equal(result.items.length, 2)
  assert.equal(result.sources.find(source => source.platform === 'douyin').status, 'unknown')
  assert.doesNotMatch(JSON.stringify(result), /private supplier|upstream_outcome/)
})

test('stored facets are sent to ES and PostgreSQL rather than filtering returned pages', async () => {
  const requests = []
  const client = { request: async (method, path, body) => {
    requests.push({ path, body })
    if (path.includes('/_pit?')) return { id: 'pit-test' }
    if (path === '/_search') return { hits: { hits: [] } }
    if (path === '/_pit') return {}
    throw new Error(path)
  } }
  const params = { objectTypes: ['post', 'article'], tags: ['one', 'two'], fromTime: '2026-09-20T00:00:00Z', skipTotalHits: true }
  const make = (pool, client) => new SearchQueries({ pool, client, segmenter: { segment: async text => [text] }, indexSet: { readAlias: 'test' }, logger: null })
  const result = await make({}, client).searchContent('news', params)
  assert.equal(result.total, null, 'an uncounted result is not an exact zero')
  const filters = requests.find(request => request.path === '/_search').body.query.bool.filter
  assert.equal(requests.find(request => request.path === '/_search').body.track_total_hits, false)
  assert.ok(filters.some(filter => JSON.stringify(filter) === JSON.stringify({ terms: { objectType: ['post', 'article'] } })))
  assert.ok(filters.some(filter => filter.term?.tags === 'one'))
  assert.ok(filters.some(filter => filter.term?.tags === 'two'))
  let sql, values
  await make({ query: async (text, args) => { sql = text; values = args; return { rows: [] } } }, null).searchContent('news', params)
  assert.match(sql, /jsonb_array_elements_text/)
  assert.deepEqual(JSON.parse(values.at(-1)), { objectTypes: ['post', 'article'], tags: ['one', 'two'], marketplaces: [] })
  assert.ok(sql.indexOf('jsonb_array_elements_text') < sql.indexOf('LIMIT'))
  assert.doesNotMatch(sql, /count\(\*\)/)
})

test('new HTTP routes require an API key, and expose both sources and actual live results', async () => {
  const { service, store, adapter, key } = await setup()
  const server = createServer(createApp({ service, store, adapter, adminToken: 'test-admin', logger: { error() {} } }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/v1/data/aggregate`
    assert.equal((await fetch(`${base}/sources`)).status, 401)
    assert.equal((await fetch(`${base}/sources`, { headers: { 'x-mx-insight-admin-token': 'test-admin' } })).status, 401)
    const headers = { authorization: `Bearer ${key.secret}`, 'content-type': 'application/json', 'idempotency-key': 'aggregate-http-live' }
    const sources = await fetch(`${base}/sources`, { headers })
    assert.equal(sources.status, 200)
    const response = await fetch(`${base}/search`, { method: 'POST', headers, body: JSON.stringify({ query: '新闻', platforms: ['weibo'] }) })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).data.items.length, 1)
  } finally { await new Promise(resolve => server.close(resolve)) }
})
