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

test('stored aggregate continues the actual ES time-sort tuple through the HTTP contract', async () => {
  const secondId = '22222222-2222-4222-8222-222222222222'
  const requests = []
  const hit = (id, time, shard) => ({ _source: { id, platform: 'weibo', objectType: 'post', body: '自行车', eventTime: time },
    _score: 1, sort: [time, id, shard] })
  const first = hit(id, '2026-09-25T00:00:00.000Z', 1)
  const second = hit(secondId, null, 2)
  const client = { request: async (method, path, body) => {
    if (path.includes('/_pit?')) return { id: 'aggregate-time-pit' }
    if (path === '/_pit') return {}
    assert.equal(path, '/_search')
    requests.push(body)
    assert.equal(body.sort.length, 2, 'PIT adds the third _shard_doc field')
    return { hits: { hits: body.search_after ? [second] : [first, second] } }
  } }
  const searchQueries = new SearchQueries({ pool: {}, client, segmenter: { segment: async text => [text] }, indexSet: { readAlias: 'test' }, logger: null })
  const { service, store, adapter, key, calls } = await setup({ platforms: ['weibo'], searchQueries })
  const server = createServer(createApp({ service, store, adapter, adminToken: 'test-admin', logger: { error() {} } }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const input = { query: '自行车', mode: 'stored', platforms: ['weibo'], objectTypes: ['post'], pageSize: 1 }
    const send = async (body, keyId) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/data/aggregate/search`, {
        method: 'POST', headers: { authorization: `Bearer ${key.secret}`, 'content-type': 'application/json', 'idempotency-key': keyId }, body: JSON.stringify(body),
      })
      return { status: response.status, body: await response.json() }
    }
    const a = await send(input, 'stored-es-first')
    assert.equal(a.status, 200)
    const next = { ...input, cursor: a.body.data.pageInfo.nextCursor }
    const b = await send(next, 'stored-es-second')
    assert.equal(b.status, 200, JSON.stringify(b.body))
    assert.deepEqual(requests[1].search_after, first.sort)
    assert.deepEqual(b.body.data.items.map(row => row.id), [secondId])
    assert.equal(b.body.data.pageInfo.nextCursor, null)
    assert.deepEqual((await send(next, 'stored-es-second')).body, b.body)
    assert.equal(requests.length, 2, 'exact retry replays the committed page')
    assert.equal((await send({ ...next, query: 'other' }, 'stored-es-changed')).status, 400)
    assert.equal(calls.length, 0)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

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
  assert.deepEqual(result.body.data.sources, [{ platform: 'telegram', mode: 'stored', status: 'ok', returnedCount: 1 }])
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

test('live continuation advances only unfinished sources, binds identity/scope and replays each paid page', async () => {
  const { service, context, adapter, store } = await setup({ platforms: ['weibo', 'douyin'] })
  const calls = []
  adapter.search = async ({ body }) => {
    calls.push(body)
    const page = Number(body.cursor || 1)
    return { payload: { data: { items: [{ id: `${body.platform}-${page}`, title: `Page ${page}` }], pageInfo: {
      hasMore: body.platform === 'weibo' && page < 3, nextCursor: body.platform === 'weibo' && page < 3 ? String(page + 1) : null,
    } } }, raw: {} }
  }
  const path = '/api/v1/data/aggregate/search', body = { query: 'news', platforms: ['weibo', 'douyin'] }
  const first = await service.aggregateSearch(context, { path, body, idempotencyKey: 'paged-live-first' })
  const cursor = first.body.data.pageInfo.nextCursor
  assert.match(cursor, /^mxag1\./)
  assert.equal(first.body.data.pageInfo.hasMore, true)
  assert.ok(cursor.length < 1024)
  assert.equal(first.body.data.sources.find(source => source.platform === 'douyin').hasMore, false)
  const secondInput = { path, body: { ...body, cursor }, idempotencyKey: 'paged-live-second' }
  const second = await service.aggregateSearch(context, secondInput)
  assert.equal(second.body.data.pageInfo.pageIndex, 2)
  assert.deepEqual(second.body.data.items.map(item => item.externalId), ['weibo-2'])
  assert.equal(second.body.data.sources.find(source => source.platform === 'douyin').carried, true)
  assert.deepEqual(calls.map(call => [call.platform, call.cursor || '1']), [['douyin', '1'], ['weibo', '1'], ['weibo', '2']])
  assert.equal((await service.aggregateSearch(context, secondInput)).replay, true)
  // Even a client submitting a new parent key for the same cursor must reuse
  // the stable child page, including after the normal fresh replay TTL.
  const pageChild = [...store.requests.values()].find(row => row.acquisitionRequest?.body?.type === 'stable')
  assert.ok(pageChild)
  pageChild.createdAt = '2020-01-01T00:00:00.000Z'
  const fork = await service.aggregateSearch(context, { ...secondInput, idempotencyKey: 'paged-live-second-again' })
  assert.equal(calls.length, 3)
  const third = await service.aggregateSearch(context, { path, body: { ...body, cursor: second.body.data.pageInfo.nextCursor }, idempotencyKey: 'paged-live-third' })
  assert.equal(third.body.data.pageInfo.pageIndex, 3)
  assert.equal(third.body.data.pageInfo.hasMore, false)
  assert.equal(third.body.data.pageInfo.nextCursor, null)
  await service.aggregateSearch(context, { path, body: { ...body, cursor: fork.body.data.pageInfo.nextCursor }, idempotencyKey: 'paged-live-third-again' })
  assert.equal(calls.length, 4, 'forked parent cursors keep the same root/page child identity')
  for (const changed of [{ query: 'changed' }, { platforms: ['weibo'] }, { objectTypes: ['post'] }, { pageSize: 10 }, { cursor: `${cursor}x` }]) {
    await assert.rejects(service.aggregateSearch(context, { ...secondInput, body: { ...secondInput.body, ...changed }, idempotencyKey: `bad-cursor-${JSON.stringify(changed).length}` }), { code: 'invalid_cursor' })
  }
  const otherKey = await service.createApiKey({ consumerId: context.consumer.id, name: 'other', platforms: ['weibo', 'douyin'] })
  await assert.rejects(service.aggregateSearch(await service.authenticate(otherKey.secret), { ...secondInput, idempotencyKey: 'cross-key-live-cursor' }), { code: 'invalid_cursor' })
  assert.equal(calls.length, 4)
  await service.aggregateSearch(context, { path, body, idempotencyKey: 'paged-live-refresh' })
  assert.equal(calls.length, 6, 'explicit cursor-less refresh starts a new round')
})

test('live pagination does not advertise guessed continuations or retry unknown sources', async () => {
  const { service, context, adapter } = await setup({ platforms: ['weibo', 'douyin', 'bilibili'] })
  const calls = []
  adapter.search = async ({ body }) => {
    calls.push(body.platform)
    if (body.platform === 'douyin') throw new AppError(502, 'upstream_outcome_unknown', 'ambiguous')
    return { payload: { data: { items: [{ id: body.cursor || 'one' }], pageInfo: {
      hasMore: !body.cursor, nextCursor: body.platform === 'weibo' && !body.cursor ? 'next' : null,
    } } }, raw: {} }
  }
  const path = '/api/v1/data/aggregate/search', body = { query: 'news' }
  const first = await service.aggregateSearch(context, { path, body, idempotencyKey: 'partial-live-first' })
  assert.equal(first.body.data.status, 'partial')
  const second = await service.aggregateSearch(context, { path, body: { ...body, cursor: first.body.data.pageInfo.nextCursor }, idempotencyKey: 'partial-live-second' })
  assert.deepEqual(calls, ['bilibili', 'douyin', 'weibo', 'weibo'])
  assert.equal(second.body.data.sources.find(row => row.platform === 'douyin').carried, true)
  assert.equal(second.body.data.status, 'partial')
  assert.equal(second.body.data.pageInfo.nextCursor, null)
})

test('live continuation fails closed if a committed child is missing, without dispatching any source', async () => {
  const { service, context, adapter, store } = await setup()
  let calls = 0
  adapter.search = async () => { calls++; return { payload: { data: { items: [{ id: 'one' }], pageInfo: { hasMore: true, nextCursor: 'next' } } }, raw: {} } }
  const path = '/api/v1/data/aggregate/search', body = { query: 'news', platforms: ['weibo'] }
  const first = await service.aggregateSearch(context, { path, body, idempotencyKey: 'missing-child-first' })
  store.requests.delete(first.body.data.sources[0].requestId)
  await assert.rejects(service.aggregateSearch(context, { path, body: { ...body, cursor: first.body.data.pageInfo.nextCursor }, idempotencyKey: 'missing-child-next' }), { code: 'aggregate_continuation_unavailable' })
  assert.equal(calls, 1)
})

test('product continuation restores its own page cursor without exposing it or changing the product request contract', async () => {
  const { service, context, store } = await setup({ platforms: ['ecommerce'], capabilities: ['ecommerce.products.search'] })
  const requests = []
  const products = async (ctx, input) => {
    requests.push(input.body)
    const first = !input.body.cursor
    const requestId = first ? id : '22222222-2222-4222-8222-222222222222'
    const responseBody = { data: { items: [{ id: first ? 'product-one' : 'product-two', title: 'Shoes' }], page: { hasMore: first, nextCursor: first ? 'opaque-product-page-2' : null } } }
    // Simulate the existing product gateway's committed delivery evidence.
    store.requests.set(requestId, { id: requestId, tenantId: ctx.tenant.id, consumerId: ctx.consumer.id, apiKeyId: ctx.apiKey.id, status: 'committed', responseStatus: 200, responseBody })
    return { status: 200, requestId, body: responseBody }
  }
  const input = { path: '/api/v1/data/aggregate/search', body: { query: 'shoes', platforms: ['taobao'] }, products }
  const first = await service.aggregateSearch(context, { ...input, idempotencyKey: 'product-page-first' })
  assert.doesNotMatch(JSON.stringify(first.body), /opaque-product-page-2/)
  const second = await service.aggregateSearch(context, { ...input, body: { ...input.body, cursor: first.body.data.pageInfo.nextCursor }, idempotencyKey: 'product-page-second' })
  assert.deepEqual(requests[1], { marketplace: 'taobao', query: 'shoes', deliveryMode: 'live_only', cursor: 'opaque-product-page-2' })
  assert.equal(second.body.data.pageInfo.nextCursor, null)
  assert.equal(second.body.data.items[0].externalId, 'taobao:product-two')
})
