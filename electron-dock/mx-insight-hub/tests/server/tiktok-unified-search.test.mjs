import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { NightAllAdapter } from '../../server/adapters/night-all.mjs'
import { createApp } from '../../server/app.mjs'
import { isNightAllDataSearchV1Envelope } from '../../server/contracts/night-all-data-search.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { TikHubAdapter } from '../../server/adapters/tikhub.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { nativeForwardingEndpoint } from '../../server/contracts/native-forwarding.mjs'
import { RAW_SEARCH_VERSION } from '../../server/contracts/raw-search.mjs'

const DATA_PATH = '/api/v1/data/search'
const RAW_PATH = '/api/v1/night-all/search/raw'
const QUERY = '城市观察'
const TEXT = `完整正文 🚲\n${'保留获取到的内容。'.repeat(80)}`
const RAW_ROWS = JSON.stringify([{ content_id: '9223372036854775807', content: TEXT,
  image_urls: '["https://example.test/image.jpg"]', video_urls: '["https://example.test/video.mp4"]' }])
const RAW_INFO = JSON.stringify([{ user_id: '9223372036854775806', username: 'author' }])

function standardPage(input) {
  const next = !input.cursor
  return { data: { contractVersion: 'night-all.data-search.v1', platform: 'tiktok', query: input.query,
    items: [{ id: '9223372036854775807', externalId: '9223372036854775807', platform: 'tiktok',
      contentType: 'video', url: 'https://www.tiktok.com/@author/video/9223372036854775807',
      title: null, text: TEXT, publishedAt: '2026-10-15T01:00:00.000Z', collectedAt: '2026-10-15T01:01:00.000Z',
      author: { id: '9223372036854775806', name: 'author', avatarUrl: null },
      metrics: { likes: 0, comments: null, shares: 3, views: 0, bookmarks: null },
      media: { coverUrl: 'https://example.test/cover.jpg', images: ['https://example.test/image.jpg'], videos: ['https://example.test/video.mp4'] },
      source: { provider: 'tikhub', endpointId: 'private-upstream-operation' } }],
    pageInfo: { pageIndex: next ? 1 : 2, pageSize: input.pageSize, returnedCount: 1,
      hasMore: next, nextCursor: next ? 'tiktok-native-standard-continuation' : null, cursorType: next ? 'opaque' : 'none' },
    status: 'ok', warnings: [], meta: { sourceProvider: 'tikhub', endpointId: 'private-upstream-operation', providerCalls: 1 } },
  requestId: 'upstream-standard-id', traceId: 'upstream-standard-trace' }
}

function legacyPage() {
  return { data: { raw_info: RAW_INFO, raw_data: RAW_ROWS,
    page: { page: 1, pageSize: 20, returnedCount: 1, hasMore: true,
      paginationMode: 'composite', nextPage: 2, nextCursor: 'tiktok-native-raw-continuation',
      nextParams: { offset: 10, search_id: 'tiktok-search-session' } },
    meta: { resultCount: 1 } }, requestId: 'upstream-raw-id', traceId: 'upstream-raw-trace' }
}

async function harness(t, { grant = true, unknown = false } = {}) {
  const store = new MemoryStore(), calls = []
  const adapter = new NightAllAdapter({ baseUrl: 'http://night-all-fixture.invalid', fetchImpl: async (url, options) => {
    const path = new URL(url).pathname, body = JSON.parse(options.body)
    calls.push({ path, body })
    if (unknown) throw new TypeError('Synthetic transport outcome unknown')
    assert.ok([DATA_PATH, '/api/v1/search/raw'].includes(path))
    return Response.json(path === DATA_PATH ? standardPage(body) : legacyPage())
  } })
  const service = new HubService({ store, adapter, apiKeyPepper: 'tiktok-unified-test-fixture-pepper-long-enough' })
  const endpoint = nativeForwardingEndpoint('t.tiktok_web_fetch_general_search')
  const config = { configured: true, contractVerified: true, dispatchEnabled: true, timeoutMs: 100,
    freshTtlMs: 60000, staleTtlMs: 86400000, maxConcurrency: 3, maxConsumerConcurrency: 3, maxRequestsPerMinute: 100, billing: {} }
  const controls = new MemoryExternalPlatformControlStore()
  await controls.updatePolicy('tikhub', endpoint.operation, { expectedRevision: 1, desiredState: 'active', reason: 'Offline migration fixture',
    priceBook: { currency: 'USD', pricingAsOf: '2026-10-08T00:00:00Z', monthlyBudgetMinor: 100000,
      monthlySubsidyBudgetMinor: 100000, unitCostMinorByEndpoint: { [endpoint.endpointKey]: 12 } } },
  { runtime: { config, credentialConfigured: true } })
  const directAdapter = new TikHubAdapter({ apiKey: 'fixture-secret', timeoutMs: 100, fetchImpl: async url => {
    const parsed = new URL(url), body = Object.fromEntries(parsed.searchParams)
    calls.push({ path: parsed.pathname, body })
    if (unknown) throw new TypeError('Synthetic transport outcome unknown')
    const first = body.offset === '0'
    return Response.json({ code: 200, data: { data: [{ item: { id: first ? '9223372036854775807' : '9223372036854775808', desc: TEXT,
      author: { id: '9223372036854775806', nickname: 'author', uniqueId: 'author' },
      stats: { diggCount: 0, shareCount: 3, playCount: 0 }, video: { playAddr: 'https://example.test/video.mp4', cover: 'https://example.test/cover.jpg' } } }],
      has_more: first, cursor: 10, search_id: 'tiktok-native-standard-continuation' } })
  } })
  const platformStore = new MemoryExternalPlatformStore({ usageStore: store, providerKey: 'tikhub', authorizationPlatform: 'tiktok' })
  const gateway = new ExternalPlatformGateway({ usageStore: store, platformStore, adapter: directAdapter, config,
    providerKey: 'tikhub', apiKeyPepper: 'tiktok-unified-test-fixture-pepper-long-enough', reservationLeaseMs: 120000,
    operationControlStore: controls, logger: { warn() {} } })
  service.externalDataSearch = (context, input) => gateway.searchContent(context, input)
  service.externalRawSearch = (context, input) => gateway.searchContent(context, input)
  const tenant = await service.createTenant({ name: 'TikTok fixture' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'TikTok caller' })
  if (grant) await store.setPlatformGrant(consumer.id, 'tiktok', true)
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'TikTok fixture key', platforms: grant ? ['tiktok'] : [], capabilities: [] })
  const server = createServer(createApp({ store, service, adapter, listenerMode: 'public', logger: { error() {} } }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const request = async (path, body, idempotencyKey) => {
    const response = await fetch(base + path, { method: 'POST', headers: {
      authorization: `Bearer ${key.secret}`, 'content-type': 'application/json', 'idempotency-key': idempotencyKey,
    }, body: JSON.stringify(body) })
    return { response, body: await response.json() }
  }
  return { store, calls, service, tenant, consumer, request }
}

test('TikTok unified search preserves the standard contract and charges once per explicit page', async t => {
  const h = await harness(t)
  await h.service.setTenantBillingProfile(h.tenant.id, { mode: 'enforced', defaultUnitPriceMinor: 7, defaultCurrency: 'CNY' }, 'test-admin')
  await h.service.addTenantCredit(h.tenant.id, { amountMinor: 14, currency: 'CNY', reason: 'Synthetic TikTok credit' },
    { idempotencyKey: 'tiktok-fixture-credit', actor: 'test-admin' })
  const input = { platform: 'tiktok', query: QUERY, pageSize: 1, type: 'stable' }
  const first = await h.request(DATA_PATH, input, 'tiktok-standard-first')
  assert.equal(first.response.status, 200)
  assert.equal(isNightAllDataSearchV1Envelope(first.body), true)
  assert.equal(first.body.data.items[0].text, TEXT)
  assert.equal(first.body.data.items[0].externalId, '9223372036854775807')
  assert.deepEqual(first.body.data.items[0].metrics, { likes: 0, comments: null, shares: 3, views: 0, bookmarks: null })
  assert.deepEqual(first.body.data.items[0].media.videos, ['https://example.test/video.mp4'])
  assert.deepEqual(first.body.data.items[0].source, { provider: null, endpointId: null })
  assert.equal(first.body.data.raw_data, undefined)
  assert.doesNotMatch(JSON.stringify(first.body), /private-upstream-operation|tiktok-native-standard-continuation/)
  assert.match(first.body.data.pageInfo.nextCursor, /^mxds1\./)
  assert.equal(h.calls[0].path, '/api/v1/tiktok/web/fetch_general_search')
  assert.equal(h.calls[0].body.keyword, QUERY)
  const replay = await h.request(DATA_PATH, input, 'tiktok-standard-first')
  assert.equal(replay.response.headers.get('idempotent-replay'), 'true')
  assert.deepEqual(replay.body, first.body)
  assert.equal(h.calls.length, 1)
  assert.equal(h.store.customerCharges.size, 1)

  const cursor = first.body.data.pageInfo.nextCursor
  const changed = await h.request(DATA_PATH, { ...input, query: '不同查询', cursor }, 'tiktok-standard-invalid')
  assert.equal(changed.response.status, 400)
  assert.equal(changed.body.error.code, 'invalid_cursor')
  assert.equal(h.calls.length, 1)
  const next = await h.request(DATA_PATH, { ...input, cursor }, 'tiktok-standard-next')
  assert.equal(next.response.status, 200)
  assert.equal(next.body.data.pageInfo.pageIndex, 2)
  assert.equal(next.body.data.pageInfo.hasMore, false)
  assert.equal(h.calls[1].body.search_id, 'tiktok-native-standard-continuation')
  assert.equal(h.calls[1].body.offset, '10')
  assert.equal(h.calls.length, 2)
  assert.equal(h.store.customerCharges.size, 2)
  assert.equal(h.store.creditAccounts.get(h.tenant.id).availableMinor, 0)
})

test('TikTok raw aliases run the fixed TikHub search in Hub, never Night-All, and keep the raw envelope', async t => {
  const h = await harness(t), input = { platform: 'tiktok', query: QUERY, pageSize: 1 }
  const legacy = { platform: 'tiktok', keyword: QUERY, count: 20 }
  const first = await h.request(RAW_PATH, legacy, 'tiktok-raw-first')
  assert.equal(first.response.status, 200)
  assert.equal(first.body.contractVersion, RAW_SEARCH_VERSION)
  const rows = JSON.parse(first.body.data.raw_data)
  // A 20-row page is filled from both fixture pages, in order, with full text.
  assert.deepEqual(rows.map(row => row.content_id), ['9223372036854775807', '9223372036854775808'])
  assert.ok(rows.every(row => row.platform_name === 'tiktok' && row.content === TEXT))
  assert.equal(JSON.parse(first.body.data.raw_info)[0].user_id, '9223372036854775806')
  assert.deepEqual([first.body.data.page.hasMore, first.body.data.page.nextCursor], [false, null])
  assert.deepEqual(h.calls.map(call => [call.path, call.body.offset, call.body.search_id]), [
    ['/api/v1/tiktok/web/fetch_general_search', '0', ''],
    ['/api/v1/tiktok/web/fetch_general_search', '10', 'tiktok-native-standard-continuation'],
  ])
  // The other alias replays the same delivery without another purchase.
  const replay = await h.request('/api/v1/search/raw', legacy, 'tiktok-raw-first')
  assert.equal(replay.response.headers.get('idempotent-replay'), 'true')
  assert.deepEqual(replay.body, first.body)
  assert.equal(h.calls.length, 2)
  const conflict = await h.request(DATA_PATH, input, 'tiktok-raw-first')
  assert.equal(conflict.response.status, 409)
  assert.equal(conflict.body.error.code, 'idempotency_conflict')
  // A standard-search cursor cannot continue a raw traversal.
  const standard = await h.request(DATA_PATH, input, 'tiktok-mixed-standard')
  const badCursor = await h.request(RAW_PATH, { ...legacy, cursor: standard.body.data.pageInfo.nextCursor }, 'tiktok-mixed-invalid')
  assert.equal(badCursor.response.status, 400)
  assert.equal(badCursor.body.error.code, 'invalid_cursor')
  assert.ok(h.calls.every(call => call.path === '/api/v1/tiktok/web/fetch_general_search'), 'Night-All is never called')
})

test('TikTok unified entry retains platform authorization and never retries an unknown acquisition', async t => {
  const input = { platform: 'tiktok', query: QUERY }
  const denied = await harness(t, { grant: false })
  assert.equal((await denied.request(DATA_PATH, input, 'tiktok-no-platform-grant')).response.status, 403)
  assert.equal(denied.calls.length, 0)
  const h = await harness(t, { unknown: true })
  const first = await h.request(DATA_PATH, input, 'tiktok-unknown-result')
  assert.equal(first.response.status, 502)
  assert.equal(first.body.error.code, 'upstream_outcome_unknown')
  const retry = await h.request(DATA_PATH, input, 'tiktok-unknown-result')
  assert.equal(retry.response.status, 409)
  assert.equal(retry.body.error.code, 'request_outcome_unknown')
  assert.equal(h.calls.length, 1)
})
