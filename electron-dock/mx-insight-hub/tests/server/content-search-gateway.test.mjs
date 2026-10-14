import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { TikHubAdapter } from '../../server/adapters/tikhub.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { nativeForwardingEndpoint } from '../../server/contracts/native-forwarding.mjs'
import { TIKHUB_CONTENT_SEARCH_RECIPES } from '../../server/contracts/tikhub-content-search.mjs'
import { RAW_SEARCH_VERSION } from '../../server/contracts/raw-search.mjs'
import { requestFingerprint } from '../../server/core/crypto.mjs'
import { createNightAllCompatibilityCursorCodec } from '../../server/external-platforms/cursor.mjs'
import { capNightAllDataSearchTraversal, prepareNightAllCompatibilityTraversal } from '../../server/data/night-all-pagination.mjs'

const fixtures = JSON.parse(await readFile(new URL('../fixtures/tikhub-content-search.json', import.meta.url), 'utf8'))
const PEPPER = 'offline-tikhub-content-search-with-sufficient-entropy'
const terminal = platform => {
  const data = structuredClone(fixtures[platform])
  if (platform === 'bilibili') data.data.numPages = 1
  if (platform === 'douyin') data.has_more = false
  if (platform === 'kuaishou') data.has_more = false
  if (platform === 'zhihu') data.paging.is_end = true
  return data
}
const biliPage = (ids, page = 1, total = page) => ({ code: 0, data: { page, numPages: total,
  result: ids.map(id => ({ id, title: `真实标题 ${id}`, description: `内容 ${id}`, review: 7, play: 0 })) } })

async function harness({ platform = 'bilibili', payload, fetchImpl, leaseMs = 120000 } = {}) {
  const store = new MemoryStore(), calls = [], historical = []
  const service = new HubService({ store, apiKeyPepper: PEPPER, adapter: {
    async legacySearch(input) { historical.push(input); throw new Error('Unexpected Night-All dispatch') },
    async search(input) { historical.push(input); throw new Error('Unexpected Night-All dispatch') },
  } })
  const tenant = await service.createTenant({ name: 'Offline content-search fixture' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Synthetic caller' })
  await store.setPlatformGrant(consumer.id, platform, true)
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Synthetic live identity', platforms: [platform], capabilities: [] })
  const context = await service.authenticate(key.secret)
  const recipe = TIKHUB_CONTENT_SEARCH_RECIPES[platform], endpoint = nativeForwardingEndpoint(recipe.key)
  const config = { configured: true, contractVerified: true, dispatchEnabled: true, timeoutMs: 100,
    freshTtlMs: 60000, staleTtlMs: 86400000, maxConcurrency: 3, maxConsumerConcurrency: 3, maxRequestsPerMinute: 100, billing: {} }
  const controls = new MemoryExternalPlatformControlStore()
  await controls.updatePolicy('tikhub', endpoint.operation, { expectedRevision: 1, desiredState: 'active', reason: 'Offline regression',
    priceBook: { currency: 'USD', pricingAsOf: '2026-10-08T00:00:00Z', monthlyBudgetMinor: 100000,
      monthlySubsidyBudgetMinor: 100000, unitCostMinorByEndpoint: { [endpoint.endpointKey]: 12 } } },
  { runtime: { config, credentialConfigured: true } })
  const adapter = new TikHubAdapter({ apiKey: 'fixture-secret', timeoutMs: 100, fetchImpl: async (url, options) => {
    const parsed = new URL(url)
    calls.push({ url: parsed, options, params: options.method === 'POST' ? JSON.parse(options.body) : Object.fromEntries(parsed.searchParams) })
    if (fetchImpl) return fetchImpl(calls.at(-1), calls.length)
    return Response.json({ code: 200, request_id: `synthetic-${calls.length}`, data: typeof payload === 'function' ? payload(calls.at(-1), calls.length) : payload ?? terminal(platform) })
  } })
  const platformStore = new MemoryExternalPlatformStore({ usageStore: store, providerKey: 'tikhub', authorizationPlatform: platform })
  const gateway = new ExternalPlatformGateway({ usageStore: store, platformStore, adapter, config, providerKey: 'tikhub',
    apiKeyPepper: PEPPER, reservationLeaseMs: leaseMs, operationControlStore: controls, logger: { warn() {} } })
  service.externalRawSearch = (context, input) => gateway.searchContent(context, input)
  service.externalDataSearch = (context, input) => gateway.searchContent(context, input)
  const invoke = (body = { platform, keyword: '城市', count: 20 }, idempotencyKey = 'content-raw-first', path = '/api/v1/night-all/search/raw') => service.nightAllCompatibilitySearch(context, { operation: 'raw', body, idempotencyKey, path })
  const invokeData = (body = { platform, query: '城市', pageSize: 20 }, idempotencyKey = 'content-data-first') => service.search(context, { body, idempotencyKey, path: '/api/v1/data/search' })
  return { store, service, platformStore, gateway, context, config, controls, recipe, calls, historical, invoke, invokeData }
}

test('all four platforms use fixed TikHub keyword endpoints for standard and both raw aliases, with immutable replay', async () => {
  for (const platform of Object.keys(TIKHUB_CONTENT_SEARCH_RECIPES)) {
    const h = await harness({ platform })
    const first = await h.invokeData()
    assert.equal(first.body.data.contractVersion, 'night-all.data-search.v1')
    assert.ok(first.body.data.items.length)
    assert.ok(first.body.data.items[0].title)
    assert.equal(first.body.data.items[0].metrics.comments, platform === 'bilibili' ? 4 : platform === 'kuaishou' ? 3 : 2)
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].url.pathname, h.recipe.path)
    assert.equal(h.calls[0].options.method, h.recipe.method)
    assert.deepEqual((await h.invokeData()).body, first.body)
    const rawBody = { platform, keyword: '城市', count: 20 }
    const raw = await h.invoke(rawBody, 'content-raw-alias')
    assert.equal(raw.body.contractVersion, RAW_SEARCH_VERSION)
    assert.ok(JSON.parse(raw.body.data.raw_data).length)
    assert.deepEqual((await h.invoke(rawBody, 'content-raw-alias', '/api/v1/search/raw')).body, raw.body)
    assert.equal(h.calls.length, 2)
    assert.equal(h.historical.length, 0)
    assert.equal(h.platformStore.ingestJobs.length, 2)
    assert.ok([...h.store.requests.values()].every(row => row.platform === platform))
  }
})

test('standard fills at most three pages, carries overflow, deduplicates delivered IDs and ingests each full archive only once', async () => {
  const h = await harness({ payload: (_call, n) => n === 1 ? biliPage(['a', 'b', 'c'], 1, 3) : n === 2 ? biliPage(['b', 'd'], 2, 3) : biliPage(['e'], 3, 3) })
  const body = { platform: 'bilibili', query: '城市', pageSize: 2 }
  const first = await h.invokeData(body, 'content-fill-first')
  assert.deepEqual(first.body.data.items.map(row => row.externalId), ['a', 'b'])
  assert.equal(h.calls.length, 1)
  assert.equal(h.platformStore.ingestJobs[0].payload.records.filter(row => row.objectType === 'post').length, 3)
  const second = await h.invokeData({ ...body, cursor: first.body.data.pageInfo.nextCursor }, 'content-fill-second')
  assert.deepEqual(second.body.data.items.map(row => row.externalId), ['c', 'd'])
  assert.equal(h.calls.length, 2)
  const third = await h.invokeData({ ...body, cursor: second.body.data.pageInfo.nextCursor }, 'content-fill-third')
  assert.deepEqual(third.body.data.items.map(row => row.externalId), ['e'])
  assert.equal(third.body.data.pageInfo.hasMore, false)
  assert.equal(h.calls.length, 3)
  assert.equal(h.platformStore.ingestJobs.length, 3)
  assert.deepEqual(h.calls.map(call => Number(call.params.page)), [1, 2, 3])
  assert.equal(h.platformStore.requests.filter(row => row.sourceMode === 'live').length, 3)
})

test('three real calls are a per-request bound, preserving remaining continuation and one public usage settlement', async () => {
  const h = await harness({ payload: (_call, n) => biliPage([String(n)], n, 10) })
  const first = await h.invokeData({ platform: 'bilibili', query: '城市', pageSize: 5 })
  assert.equal(h.calls.length, 3)
  assert.equal(first.body.data.items.length, 3)
  assert.equal(first.body.data.status, 'partial')
  assert.equal(first.body.data.pageInfo.hasMore, true)
  assert.ok(first.body.data.warnings.some(row => row.code === 'content_search_fill_stopped'))
  assert.equal(h.store.requests.size, 1)
  assert.equal([...h.store.requests.values()][0].status, 'committed')
})

test('raw batch preserves plural keyword precedence, per-query count, fixed filters and bounded direct calls', async () => {
  const h = await harness({ payload: call => biliPage([`${call.params.keyword}-1`]) })
  const result = await h.invoke({ platform: 'bilibili', keyword: 'ignored', queries: ['one', 'two'], count: 2,
    params: { order: 'click', duration: 2 } })
  assert.equal(h.calls.length, 2)
  assert.deepEqual(h.calls.map(call => call.params.keyword), ['one', 'two'])
  assert.ok(h.calls.every(call => call.params.order === 'click' && call.params.duration === '2'))
  assert.equal(result.body.data.mode, 'batch')
  assert.deepEqual(result.body.data.results.map(row => row.query), ['one', 'two'])
  assert.equal(h.store.requests.size, 1)
  assert.equal([...h.store.requests.values()][0].billingMeterKey, 'raw')
})

test('new unsupported paid options and unsigned continuation reject before receipt while exact old raw replay precedes validation', async () => {
  for (const extra of [{ includeDetails: true }, { includeComments: true }, { commentLimit: 5 }, { commentCursor: 'native' }, { cacheMaxAgeHours: 2 }]) {
    const h = await harness()
    const body = { platform: 'bilibili', keyword: '城市', count: 20, ...extra }
    const code = 'content_search_option_unsupported'
    await assert.rejects(h.invoke(body), error => error.code === code)
    assert.equal(h.calls.length, 0)
    assert.equal(h.platformStore.calls.size, 0)
    const original = await h.service.store.reserve({ requestId: randomUUID(), idempotencyKey: 'historical-raw-replay',
      fingerprint: requestFingerprint({ method: 'POST', path: '/api/v1/night-all/search/raw', body: { contractVersion: 'mx-insight-hub.night-all-compat.v1', ...body } }),
      tenantId: h.context.tenant.id, consumerId: h.context.consumer.id, apiKeyId: h.context.apiKey.id, platform: 'bilibili',
      unitsReserved: 1, leaseExpiresAt: new Date(Date.now() + 120000), windowStart: new Date(Date.now() - 60000), maxRequests: 100 })
    const archived = { data: { raw_info: '[]', raw_data: '[{"content_id":"old"}]' }, oldFormat: true }
    await h.store.commitRequest(original.request.id, { responseStatus: 200, responseBody: archived, unitsActual: 1 })
    assert.deepEqual((await h.invoke(body, 'historical-raw-replay')).body, archived)
    assert.equal(h.calls.length, 0)
  }
})

test('standard native pagination cannot bypass the signed cursor or declared page size', async () => {
  for (const params of [{ page: 3 }, { page_size: 2 }, { offset: 10 }]) {
    const h = await harness()
    await assert.rejects(h.invokeData({ platform: 'bilibili', query: '城市', pageSize: 20, params }), error => error.code === 'content_search_pagination_unsupported')
    assert.equal(h.calls.length, 0)
  }
})

test('standard stable delivery retains its route, dataset and platform meter', async () => {
  const h = await harness()
  const result = await h.invokeData({ platform: 'bilibili', query: '城市', pageSize: 20, type: 'stable' })
  assert.ok(result.body.data.items.length)
  const usage = [...h.store.requests.values()][0]
  assert.equal(usage.acquisitionRequest.path, '/api/v1/data/search')
  assert.equal(usage.billingMeterKey, 'bilibili')
  assert.equal(h.platformStore.ingestJobs[0].payload.datasetId, 'night-all.search.v1')
})

test('historical standard signed cursor replays original committed body before restart and retains old stable failure', async () => {
  for (const type of ['fresh', 'stable']) {
    for (const responseStatus of [200, 502]) {
      const h = await harness()
      const body = { platform: 'bilibili', query: '城市', pageSize: 20 }
      const codec = createNightAllCompatibilityCursorCodec(PEPPER, h.context.consumer.id)
      const traversal = prepareNightAllCompatibilityTraversal({ operation: 'data-search', platform: 'bilibili', upstreamBody: body, codec })
      const wrapped = capNightAllDataSearchTraversal({ data: { pageInfo: { pageIndex: 1, pageSize: 20, returnedCount: 0,
        hasMore: true, nextCursor: 'old-native-token', cursorType: 'opaque' }, warnings: [] } }, { platform: 'bilibili', page: 1, scope: traversal.scope, codec })
      const cursor = wrapped.data.pageInfo.nextCursor
      const id = randomUUID(), saved = responseStatus === 200 ? { original: true, requestId: id }
        : { error: { code: 'old_upstream_failure', message: 'Original saved error' }, requestId: id }
      await h.store.reserve({ requestId: id, idempotencyKey: 'historical-standard-page',
        fingerprint: requestFingerprint({ method: 'POST', path: '/api/v1/data/search', body: { ...body, cursor: 'old-native-token', type } }),
        tenantId: h.context.tenant.id, consumerId: h.context.consumer.id, apiKeyId: h.context.apiKey.id, platform: 'bilibili',
        unitsReserved: 1, leaseExpiresAt: new Date(Date.now() + 120000), windowStart: new Date(Date.now() - 60000), maxRequests: 100 })
      await h.store.commitRequest(id, { responseStatus, responseBody: saved, unitsActual: 1 })
      if (responseStatus === 200) assert.deepEqual((await h.invokeData({ ...body, type, cursor }, 'historical-standard-page')).body, saved)
      else await assert.rejects(h.invokeData({ ...body, type, cursor }, 'historical-standard-page'), error => error.code === 'old_upstream_failure' && error.status === 502)
      await assert.rejects(h.invokeData({ ...body, type, cursor }, 'historical-standard-new'), error => error.code === 'search_restart_required')
      assert.equal(h.calls.length, 0)
      assert.equal(h.historical.length, 0)
    }
  }
})

test('a filled standard delivery settles one existing customer quote across all provider receipts', async () => {
  const h = await harness({ payload: (_call, n) => biliPage([String(n)], n, 3) })
  await h.service.setTenantBillingProfile(h.context.tenant.id,
    { mode: 'enforced', multiplierPpm: 1000000, defaultUnitPriceMinor: 3, defaultCurrency: 'CNY' }, 'offline-admin')
  await h.service.addTenantCredit(h.context.tenant.id, { amountMinor: 100, currency: 'CNY', reason: 'Offline fixture' },
    { idempotencyKey: 'content-search-credit', actor: 'offline-admin' })
  const result = await h.invokeData({ platform: 'bilibili', query: '城市', pageSize: 3 })
  assert.equal(result.body.data.items.length, 3)
  assert.equal(h.calls.length, 3)
  const charges = [...h.store.customerCharges.values()]
  assert.equal(charges.length, 1)
  assert.equal(charges[0].status, 'captured')
  assert.equal(charges[0].chargedMinor, 3)
})

test('transport uncertainty never returns acquired partial results or repurchases equal work', async () => {
  const h = await harness({ fetchImpl: (_call, n) => {
    if (n === 2) throw new Error('synthetic transport lost after dispatch')
    return Response.json({ code: 200, data: biliPage(['a'], 1, 5) })
  } })
  const body = { platform: 'bilibili', query: '城市', pageSize: 2 }
  await assert.rejects(h.invokeData(body), error => ['upstream_outcome_unknown', 'request_outcome_unknown'].includes(error.code))
  assert.equal(h.calls.length, 2)
  assert.equal([...h.store.requests.values()][0].status, 'unknown')
  await assert.rejects(h.invokeData(body, 'content-data-new-idem'), error => error.code === 'request_outcome_unknown')
  assert.equal(h.calls.length, 2)
})

test('provider preview is visible partial content and missing modern metrics stay null', async () => {
  const h = await harness({ platform: 'zhihu' })
  const result = await h.invokeData()
  assert.equal(result.body.data.status, 'partial')
  assert.ok(result.body.data.warnings.some(row => row.code === 'body_completeness_unknown'))
  const preview = result.body.data.items.find(row => row.externalId === '117200001')
  assert.equal(preview.text, '仅提供摘要…')
  assert.equal(preview.metrics.likes, null)
  assert.equal(h.calls.length, 1)
})

test('buffer projection checks original archive hash before delivery and cannot echo credentials', async () => {
  const payload = biliPage(['a', 'b'])
  payload.data.result[1].description = 'fixture-secret'
  const h = await harness({ payload })
  // The first projection is credential scrubbed by the native adapter. Its full
  // restricted archive is retained unchanged for later integrity validation.
  const body = { platform: 'bilibili', query: '城市', pageSize: 1 }
  const first = await h.invokeData(body)
  assert.equal(first.body.data.items.length, 1)
  assert.equal(JSON.stringify(first.body).includes('fixture-secret'), false)
  await assert.rejects(h.invokeData({ ...body, cursor: first.body.data.pageInfo.nextCursor }, 'content-buffer-hash'), error => error.code === 'search_page_unavailable')
  assert.equal(h.calls.length, 1)
})

test('filter key ordering is canonical in cursor scope, while changed filters and Key remain invalid', async () => {
  const h = await harness({ payload: biliPage(['a', 'b']) })
  const body = { platform: 'bilibili', query: '城市', pageSize: 1, params: { order: 'click', duration: 2 } }
  const first = await h.invokeData(body)
  const cursor = first.body.data.pageInfo.nextCursor
  await assert.rejects(h.invokeData({ ...body, cursor, params: { duration: 3, order: 'click' } }, 'content-filter-change'), error => error.code === 'invalid_cursor')
  const second = await h.invokeData({ ...body, cursor, params: { duration: 2, order: 'click' } }, 'content-filter-reorder')
  assert.deepEqual(second.body.data.items.map(row => row.externalId), ['b'])
  assert.equal(h.calls.length, 1)
  const newKey = await h.service.createApiKey({ consumerId: h.context.consumer.id, name: 'Different synthetic identity', platforms: ['bilibili'], capabilities: [] })
  const otherContext = await h.service.authenticate(newKey.secret)
  await assert.rejects(h.service.search(otherContext, { body: { ...body, cursor }, idempotencyKey: 'content-key-change', path: '/api/v1/data/search' }), error => error.code === 'invalid_cursor')
  assert.equal(h.calls.length, 1)
})

test('unknown durable mark failure retains cache-only parent reservation and lease until stale reaping', async () => {
  const h = await harness({ payload: biliPage(['a', 'b']), leaseMs: 120000 })
  await h.service.setTenantBillingProfile(h.context.tenant.id,
    { mode: 'enforced', multiplierPpm: 1000000, defaultUnitPriceMinor: 3, defaultCurrency: 'CNY' }, 'offline-admin')
  await h.service.addTenantCredit(h.context.tenant.id, { amountMinor: 100, currency: 'CNY', reason: 'Offline fixture' },
    { idempotencyKey: 'content-buffer-credit', actor: 'offline-admin' })
  const body = { platform: 'bilibili', query: '城市', pageSize: 1 }
  const first = await h.invokeData(body)
  const next = { ...body, cursor: first.body.data.pageInfo.nextCursor }
  const commit = h.store.commitRequest.bind(h.store), mark = h.store.markRequestUnknown.bind(h.store), get = h.store.getRequest.bind(h.store)
  h.store.commitRequest = async () => { throw new Error('Synthetic commit unavailable') }
  h.store.markRequestUnknown = async () => { throw new Error('Synthetic unknown mark unavailable') }
  h.store.getRequest = async () => { throw new Error('Synthetic read unavailable') }
  await assert.rejects(h.invokeData(next, 'content-buffer-uncertain'), error => error.code === 'request_outcome_unknown')
  h.store.commitRequest = commit; h.store.markRequestUnknown = mark; h.store.getRequest = get
  const pending = [...h.store.requests.values()].find(row => row.idempotencyKey === 'content-buffer-uncertain')
  assert.equal(pending.status, 'reserved')
  assert.equal([...h.store.customerCharges.values()].find(row => row.usageRequestId === pending.id).status, 'reserved')
  assert.ok([...h.platformStore.leases.values()].some(row => row.ownerRequestId === pending.id))
  await assert.rejects(h.invokeData(next, 'content-buffer-other-idem'), error => error.code === 'request_in_progress')
  pending.leaseExpiresAt = new Date(Date.now() - 1).toISOString()
  await h.store.reapStaleReservations()
  assert.equal(pending.status, 'unknown')
  await assert.rejects(h.invokeData(next, 'content-buffer-after-reap'), error => error.code === 'request_outcome_unknown')
  assert.equal(h.calls.length, 1)
})

test('standard traversal never purchases a sixteenth upstream page and reports its bounded stop', async () => {
  const h = await harness({ payload: (_call, n) => biliPage([String(n)], n, 100) })
  const body = { platform: 'bilibili', query: '城市', pageSize: 3 }
  let cursor, result
  for (let page = 1; page <= 5; page++) {
    result = await h.invokeData({ ...body, ...(cursor ? { cursor } : {}) }, `content-upstream-limit-${page}`)
    cursor = result.body.data.pageInfo.nextCursor
  }
  assert.equal(h.calls.length, 15)
  assert.equal(result.body.data.pageInfo.hasMore, false)
  assert.equal(result.body.data.status, 'partial')
  assert.ok(result.body.data.warnings.some(row => row.code === 'upstream_page_limit_reached'))
})

test('fifty raw keyword jobs retain the existing work bound with fifty independently recorded receipts', async () => {
  const queries = Array.from({ length: 50 }, (_, index) => `query-${index}`)
  const h = await harness({ payload: call => biliPage([`${call.params.keyword}-1`]) })
  const result = await h.invoke({ platform: 'bilibili', queries, count: 1 })
  assert.equal(h.calls.length, 50)
  assert.equal(h.platformStore.calls.size, 50)
  assert.equal(h.platformStore.ingestJobs.length, 50)
  assert.equal(result.body.data.results.length, 50)
  assert.ok(result.body.data.results.every(row => row.success && row.items.length === 1))
  assert.equal(h.store.requests.size, 1)
  await assert.rejects(h.invoke({ platform: 'bilibili', queries: [...queries, 'fifty-one'], count: 1 }, 'content-raw-too-many'), error => error.code === 'work_budget_exceeded')
  assert.equal(h.calls.length, 50)
})
