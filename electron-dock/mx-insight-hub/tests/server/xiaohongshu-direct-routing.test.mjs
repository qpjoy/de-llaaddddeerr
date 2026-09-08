import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createApp } from '../../server/app.mjs'
import { requestFingerprint } from '../../server/core/crypto.mjs'
import { createExternalPlatformCursorCodec } from '../../server/external-platforms/cursor.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const PEPPER = 'xiaohongshu-routing-test-pepper-with-entropy'
const MODERN_PATH = '/api/v1/data/search'
const LEGACY_PATHS = {
  raw: '/api/v1/night-all/search/raw',
  crawl: '/api/v1/night-all/search/crawl',
  'user-info': '/api/v1/night-all/search/user-info',
}

function modernEnvelope({ platform = 'xiaohongshu', query = 'AI', pageSize = 20 } = {}) {
  return {
    data: {
      contractVersion: 'night-all.data-search.v1',
      platform,
      query,
      items: [{
        id: `${platform}:post-one`,
        externalId: 'post-one',
        platform,
        contentType: 'normal',
        url: null,
        title: query,
        text: query,
        publishedAt: '2026-09-08T00:00:00.000Z',
        collectedAt: '2026-09-08T00:01:00.000Z',
        author: { id: 'author-one', name: 'Alice', avatarUrl: null },
        metrics: { likes: 1, comments: 2, shares: 3, views: 4, bookmarks: 5 },
        media: { coverUrl: null, images: [], videos: [] },
        source: { provider: null, endpointId: null },
      }],
      pageInfo: {
        pageIndex: 1,
        pageSize,
        returnedCount: 1,
        hasMore: false,
        nextCursor: null,
        cursorType: 'none',
      },
      status: 'ok',
      warnings: [],
      meta: {
        capability: 'search_posts',
        capabilityStatus: 'ready',
        paginationMode: 'composite',
        providerCalls: 1,
        durationMs: 1,
      },
    },
    requestId: 'night-all-modern-request',
    traceId: 'night-all-modern-trace',
  }
}

function legacyEnvelope() {
  return {
    data: {
      raw_info: '[]',
      raw_data: JSON.stringify([{
        content_id: 'post-one',
        text: 'legacy result',
        full_text: 'legacy result',
        content: 'legacy result',
        published_at: 1_788_825_600,
        collected_at: 1_788_825_660,
        author_id: 'author-one',
        author_name: 'Alice',
      }]),
      page: {
        page: 1,
        pageSize: 20,
        returnedCount: 1,
        hasMore: false,
        nextCursor: null,
      },
      meta: { resultCount: 1 },
    },
    requestId: 'night-all-legacy-request',
    traceId: 'night-all-legacy-trace',
  }
}

function legacyCapabilities() {
  const supported = ['xiaohongshu']
  return {
    contractVersion: 'night-all.legacy-search-capabilities.v1',
    operations: {
      raw: { supportedPlatforms: supported, readyPlatforms: supported },
      crawl: { supportedPlatforms: supported, readyPlatforms: supported },
      'user-info': { supportedPlatforms: supported, readyPlatforms: supported },
    },
  }
}

async function routingFixture({ directEnabled = true } = {}) {
  const store = new MemoryStore()
  const directCalls = []
  const searchCalls = []
  const legacyCalls = []
  const capabilityCalls = []
  const legacyCapabilityCalls = []
  const postCapabilityCalls = []
  const reserveCalls = []

  const adapter = {
    async search({ body, businessId }) {
      searchCalls.push({ body: structuredClone(body), businessId })
      const payload = modernEnvelope(body)
      return { payload, raw: structuredClone(payload) }
    },
    async legacySearch({ operation, body, businessId }) {
      legacyCalls.push({ operation, body: structuredClone(body), businessId })
      const payload = legacyEnvelope()
      return { payload, raw: structuredClone(payload) }
    },
    async legacySearchCapabilities(platforms) {
      legacyCapabilityCalls.push(structuredClone(platforms))
      return legacyCapabilities()
    },
    async capabilities(platforms) {
      capabilityCalls.push(structuredClone(platforms))
      return {
        data: {
          platforms: platforms.map((platform) => ({ platform, ready: true })),
          legacySearch: legacyCapabilities(),
        },
      }
    },
  }

  const externalSocialSearch = async (_context, input) => {
    directCalls.push(structuredClone(input))
    return {
      status: 200,
      body: input.responseMode === 'legacy'
        ? legacyEnvelope()
        : modernEnvelope(input.body),
      requestId: `direct-${directCalls.length}`,
      replay: false,
      sourceMode: 'live',
    }
  }
  const externalPostCapabilities = async () => {
    postCapabilityCalls.push(true)
    return {
      platform: 'xiaohongshu',
      ready: true,
      servingMode: 'live_with_stored_fallback',
      contractVersion: 'mx-insight-hub.xiaohongshu-post.v1',
    }
  }
  const service = new HubService({
    store,
    adapter,
    apiKeyPepper: PEPPER,
    externalPostCapabilities,
    externalSocialSearch,
    externalSocialSearchEnabled: directEnabled,
    logger: { warn() {} },
  })
  const tenant = await service.createTenant({ name: 'Routing tenant' })
  const consumer = await service.createConsumer({
    tenantId: tenant.id,
    name: 'Routing consumer',
    businessId: 'xiaohongshu-routing-consumer',
  })
  await store.setPlatformGrant(consumer.id, 'xiaohongshu', true)
  await store.putPolicy({
    tenantId: tenant.id,
    consumerId: consumer.id,
    platform: 'xiaohongshu',
    maxRequests: 1_000,
    windowSeconds: 3_600,
    maxPageSize: 100,
  })
  const liveKey = await service.createApiKey({
    consumerId: consumer.id,
    name: 'Routing live key',
    environment: 'live',
    platforms: ['xiaohongshu'],
  })
  const testKey = await service.createApiKey({
    consumerId: consumer.id,
    name: 'Routing test key',
    environment: 'test',
    platforms: ['xiaohongshu'],
  })
  const liveContext = await service.authenticate(liveKey.secret)
  const testContext = await service.authenticate(testKey.secret)
  const cursor = createExternalPlatformCursorCodec(PEPPER, consumer.id).encode({
    version: 1,
    platform: 'xiaohongshu',
    page: 2,
    scope: 'search-scope',
    searchId: 'provider-search-id',
    searchSessionId: null,
  })

  const reserve = store.reserve.bind(store)
  store.reserve = async (input) => {
    reserveCalls.push(structuredClone(input))
    return reserve(input)
  }

  return {
    service,
    consumer,
    liveContext,
    testContext,
    cursor,
    directCalls,
    searchCalls,
    legacyCalls,
    capabilityCalls,
    legacyCapabilityCalls,
    postCapabilityCalls,
    reserveCalls,
  }
}

async function modernSearch(state, idempotencyKey, body) {
  return state.service.search(state.liveContext, {
    body,
    idempotencyKey,
    path: MODERN_PATH,
  })
}

async function legacySearch(state, idempotencyKey, operation, body) {
  return state.service.nightAllCompatibilitySearch(state.liveContext, {
    operation,
    body,
    idempotencyKey,
    path: LEGACY_PATHS[operation],
  })
}

test('modern Xiaohongshu routing sends only the fixed first page and Hub cursor to direct TikHub', async () => {
  const state = await routingFixture()

  await modernSearch(state, 'modern-direct-first', {
    platform: 'xhs',
    query: 'first page',
  })
  await modernSearch(state, 'modern-direct-cursor', {
    platform: 'xiaohongshu',
    query: 'continued page',
    cursor: state.cursor,
  })
  await modernSearch(state, 'modern-nightall-cursor', {
    platform: 'xiaohongshu',
    query: 'old cursor',
    cursor: 'night-all-next-cursor',
  })
  await modernSearch(state, 'modern-nightall-size', {
    platform: 'xiaohongshu',
    query: 'different page size',
    pageSize: 10,
  })

  assert.equal(state.directCalls.length, 2)
  assert.deepEqual(state.directCalls[0].body, {
    platform: 'xiaohongshu',
    query: 'first page',
    pageSize: 20,
  })
  assert.deepEqual(state.directCalls[1].body, {
    platform: 'xiaohongshu',
    query: 'continued page',
    pageSize: 20,
    cursor: state.cursor,
  })
  assert.equal(state.directCalls.every((call) => call.responseMode === 'modern'), true)

  assert.deepEqual(state.searchCalls, [{
    body: {
      platform: 'xiaohongshu',
      query: 'old cursor',
      pageSize: 20,
      cursor: 'night-all-next-cursor',
    },
    businessId: state.consumer.businessId,
  }, {
    body: {
      platform: 'xiaohongshu',
      query: 'different page size',
      pageSize: 10,
    },
    businessId: state.consumer.businessId,
  }])
})

test('test keys keep new Xiaohongshu searches on the historical path while issued direct cursors stay pinned', async () => {
  const state = await routingFixture()

  await state.service.search(state.testContext, {
    body: { platform: 'xiaohongshu', query: 'test-key first page' },
    idempotencyKey: 'test-key-modern-first',
    path: MODERN_PATH,
  })
  await state.service.nightAllCompatibilitySearch(state.testContext, {
    operation: 'raw',
    body: { platform: 'xiaohongshu', query: 'test-key legacy first page' },
    idempotencyKey: 'test-key-legacy-first',
    path: LEGACY_PATHS.raw,
  })

  assert.equal(state.directCalls.length, 0)
  assert.equal(state.searchCalls.length, 1)
  assert.equal(state.legacyCalls.length, 1)

  await state.service.search(state.testContext, {
    body: {
      platform: 'xiaohongshu',
      query: 'test-key continued page',
      cursor: state.cursor,
    },
    idempotencyKey: 'test-key-modern-cursor',
    path: MODERN_PATH,
  })

  assert.equal(state.directCalls.length, 1)
  assert.equal(state.directCalls[0].body.cursor, state.cursor)
})

test('rollout rollback sends new first pages to Night-All but keeps existing direct cursors on TikHub', async () => {
  const state = await routingFixture({ directEnabled: false })

  await modernSearch(state, 'rollback-modern-first', {
    platform: 'xiaohongshu', query: 'new modern first page',
  })
  await legacySearch(state, 'rollback-legacy-first', 'raw', {
    platform: 'xiaohongshu', query: 'new legacy first page',
  })
  await modernSearch(state, 'rollback-modern-cursor', {
    platform: 'xiaohongshu', query: 'existing modern traversal', cursor: state.cursor,
  })
  await legacySearch(state, 'rollback-legacy-cursor', 'raw', {
    platform: 'xiaohongshu', query: 'existing legacy traversal', cursor: state.cursor,
  })

  assert.equal(state.searchCalls.length, 1)
  assert.equal(state.legacyCalls.length, 1)
  assert.deepEqual(state.directCalls.map((call) => call.responseMode), ['modern', 'legacy'])
  assert.equal(state.directCalls.every((call) => call.body.cursor === state.cursor), true)
})

test('legacy routing limits direct TikHub to a single raw query and its own continuation', async () => {
  const state = await routingFixture()

  await legacySearch(state, 'legacy-direct-query', 'raw', {
    platform: 'xiaohongshu',
    query: 'single query',
  })
  await legacySearch(state, 'legacy-direct-cursor', 'raw', {
    platform: 'xhs',
    keyword: 'continued query',
    cursor: state.cursor,
  })

  const fallbackCases = [{
    key: 'legacy-old-cursor',
    operation: 'raw',
    body: { platform: 'xiaohongshu', query: 'old cursor', cursor: 'night-all-next-cursor' },
  }, {
    key: 'legacy-batch-query',
    operation: 'raw',
    body: { platform: 'xiaohongshu', queries: ['one', 'two'] },
  }, {
    key: 'legacy-details-on',
    operation: 'raw',
    body: { platform: 'xiaohongshu', query: 'details', includeDetails: true },
  }, {
    key: 'legacy-comments-on',
    operation: 'raw',
    body: { platform: 'xiaohongshu', query: 'comments', includeComments: true },
  }, {
    key: 'legacy-long-query',
    operation: 'raw',
    body: { platform: 'xiaohongshu', query: '长'.repeat(501) },
  }, {
    key: 'legacy-crawl-user',
    operation: 'crawl',
    body: { platform: 'xiaohongshu', username: 'alice' },
  }, {
    key: 'legacy-user-info',
    operation: 'user-info',
    body: { platform: 'xiaohongshu', username: 'alice' },
  }]
  for (const candidate of fallbackCases) {
    await legacySearch(state, candidate.key, candidate.operation, candidate.body)
  }

  assert.equal(state.directCalls.length, 2)
  assert.deepEqual(state.directCalls[0], {
    body: { platform: 'xiaohongshu', query: 'single query', pageSize: 20 },
    enrichment: { includeDetails: false, disableAutoDetails: false },
    idempotencyKey: 'legacy-direct-query',
    path: LEGACY_PATHS.raw,
    responseMode: 'legacy',
    fingerprintBody: {
      contractVersion: 'mx-insight-hub.night-all-compat.v1',
      platform: 'xiaohongshu',
      query: 'single query',
    },
    replayWindowMs: null,
  })
  assert.deepEqual(state.directCalls[1].body, {
    platform: 'xiaohongshu',
    query: 'continued query',
    pageSize: 20,
    cursor: state.cursor,
  })
  assert.equal(state.legacyCalls.length, fallbackCases.length)
  assert.deepEqual(state.legacyCalls.map((call) => call.operation), fallbackCases.map((entry) => entry.operation))
  assert.equal(state.legacyCalls.every((call) => call.businessId === state.consumer.businessId), true)
  assert.equal(state.legacyCapabilityCalls.length, fallbackCases.length)
})

test('direct and fallback routes preserve replay windows and historical fingerprint bodies', async () => {
  const state = await routingFixture()

  await modernSearch(state, 'fingerprint-fresh-direct', {
    platform: 'xhs',
    query: 'fresh direct',
  })
  await modernSearch(state, 'fingerprint-stable-direct', {
    platform: 'xiaohongshu',
    query: 'stable direct',
    type: 'stable',
  })
  await legacySearch(state, 'fingerprint-legacy-direct', 'raw', {
    platform: 'xhs',
    keyword: 'legacy direct',
  })
  await modernSearch(state, 'fingerprint-fresh-fallback', {
    platform: 'xiaohongshu',
    query: 'fresh fallback',
    cursor: 'night-all-next-cursor',
  })
  await modernSearch(state, 'fingerprint-stable-fallback', {
    platform: 'xiaohongshu',
    query: 'stable fallback',
    pageSize: 10,
    type: 'stable',
  })
  await legacySearch(state, 'fingerprint-legacy-fallback', 'raw', {
    platform: 'xiaohongshu',
    query: 'legacy fallback',
    cursor: 'night-all-next-cursor',
  })

  const [freshDirect, stableDirect, legacyDirect] = state.directCalls
  assert.equal(freshDirect.replayWindowMs, 120_000)
  assert.deepEqual(freshDirect.fingerprintBody, {
    platform: 'xiaohongshu',
    query: 'fresh direct',
    pageSize: 20,
    type: 'fresh',
  })
  assert.equal(stableDirect.replayWindowMs, null)
  assert.deepEqual(stableDirect.fingerprintBody, {
    platform: 'xiaohongshu',
    query: 'stable direct',
    pageSize: 20,
    type: 'stable',
  })
  assert.equal(legacyDirect.replayWindowMs, null)
  assert.deepEqual(legacyDirect.fingerprintBody, {
    contractVersion: 'mx-insight-hub.night-all-compat.v1',
    platform: 'xiaohongshu',
    keyword: 'legacy direct',
  })

  const freshFallback = state.reserveCalls.find((call) => call.idempotencyKey === 'fingerprint-fresh-fallback')
  const stableFallback = state.reserveCalls.find((call) => call.idempotencyKey === 'fingerprint-stable-fallback')
  const legacyFallback = state.reserveCalls.find((call) => call.idempotencyKey === 'fingerprint-legacy-fallback')
  assert.equal(freshFallback.replayWindowMs, 120_000)
  assert.equal(freshFallback.fingerprint, requestFingerprint({
    method: 'POST',
    path: MODERN_PATH,
    body: {
      platform: 'xiaohongshu',
      query: 'fresh fallback',
      pageSize: 20,
      cursor: 'night-all-next-cursor',
      type: 'fresh',
    },
  }))
  assert.equal(stableFallback.replayWindowMs, null)
  assert.equal(stableFallback.fingerprint, requestFingerprint({
    method: 'POST',
    path: MODERN_PATH,
    body: {
      platform: 'xiaohongshu',
      query: 'stable fallback',
      pageSize: 10,
      type: 'stable',
    },
  }))
  assert.equal(legacyFallback.replayWindowMs, null)
  assert.equal(legacyFallback.fingerprint, requestFingerprint({
    method: 'POST',
    path: LEGACY_PATHS.raw,
    body: {
      contractVersion: 'mx-insight-hub.night-all-compat.v1',
      platform: 'xiaohongshu',
      query: 'legacy fallback',
      cursor: 'night-all-next-cursor',
    },
  }))
  assert.equal(state.searchCalls.every((call) => call.body.type === undefined), true)
})

test('direct-enabled capabilities merge search_posts without hiding Night-All-only XHS operations', async () => {
  const state = await routingFixture()

  const live = await state.service.capabilities(state.liveContext)
  const testKey = await state.service.capabilities(state.testContext)

  assert.deepEqual(state.capabilityCalls, [['xiaohongshu'], ['xiaohongshu']])
  assert.deepEqual(state.legacyCapabilityCalls, [])
  assert.equal(state.postCapabilityCalls.length, 2)
  assert.deepEqual(live.data.platforms, [{
    platform: 'xiaohongshu',
    ready: true,
    capabilities: ['search_posts'],
    search: {
      ready: true,
      source: 'hub',
      servingMode: 'live_with_stored_fallback',
      contractVersion: 'night-all.data-search.v1',
    },
  }])
  assert.deepEqual(testKey.data.platforms, [{
    platform: 'xiaohongshu',
    ready: true,
    capabilities: ['search_posts'],
    search: {
      ready: false,
      source: 'hub',
      servingMode: 'live_with_stored_fallback',
      contractVersion: 'night-all.data-search.v1',
    },
  }])
  assert.deepEqual(live.data.legacySearch, legacyCapabilities())
  assert.deepEqual(testKey.data.legacySearch, legacyCapabilities())
})

test('legacy HTTP route keeps live/stale source-mode vocabulary across direct cache and replay modes', async () => {
  const cases = [{ sourceMode: 'live', expected: 'live' }, {
    sourceMode: 'fresh_cache', expected: 'live',
  }, {
    sourceMode: 'stored_fallback', expected: 'stale',
  }, {
    sourceMode: 'idempotent_replay', originSourceMode: 'stored_fallback', expected: 'stale', replay: true,
  }]
  let index = 0
  const service = {
    async authenticate() { return { tenant: {}, consumer: {}, apiKey: {} } },
    async nightAllCompatibilitySearch() {
      const candidate = cases[index++]
      return {
        status: 200,
        body: legacyEnvelope(),
        requestId: `00000000-0000-4000-8000-00000000000${index}`,
        replay: candidate.replay === true,
        sourceMode: candidate.sourceMode,
        ...(candidate.originSourceMode ? { originSourceMode: candidate.originSourceMode } : {}),
        capturedAt: '2026-09-08T00:00:00.000Z',
        staleAgeSeconds: 60,
      }
    },
  }
  const server = createServer(createApp({
    service,
    store: {},
    adapter: {},
    adminToken: null,
    listenerMode: 'public',
    logger: { warn() {}, error() {} },
  }))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    for (const [caseIndex, candidate] of cases.entries()) {
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}${LEGACY_PATHS.raw}`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer mih_live_route-test',
            'content-type': 'application/json',
            'idempotency-key': `legacy-header-${caseIndex}`,
          },
          body: JSON.stringify({ platform: 'xiaohongshu', query: 'headers' }),
        },
      )
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('x-mx-insight-source-mode'), candidate.expected)
      assert.equal(response.headers.get('idempotent-replay'), String(candidate.replay === true))
      assert.equal(response.headers.has('warning'), candidate.expected === 'stale')
      assert.equal(response.headers.get('age'), '60')
      await response.arrayBuffer()
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
