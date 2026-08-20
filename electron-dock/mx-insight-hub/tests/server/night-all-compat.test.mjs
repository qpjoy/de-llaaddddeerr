import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NightAllAdapter } from '../../server/adapters/night-all.mjs'
import {
  buildNightAllLegacySearchCapabilities,
  NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS,
} from '../../server/contracts/night-all-legacy.mjs'
import {
  canUseNightAllCompatibilityFallback,
  nightAllCompatibilityBusinessOutcome,
  normalizeNightAllCompatibilityRequest,
} from '../../server/data/night-all-compat.mjs'
import { UpstreamAmbiguousError, UpstreamRejectedError } from '../../server/core/errors.mjs'
import {
  NIGHT_ALL_COMPAT_DATASET_ID,
  normalizeNightAllLegacyPayload,
} from '../../server/ingest/legacy-night-all.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function envelope({ warning = false } = {}) {
  return {
    data: {
      raw_info: JSON.stringify([{
        user_id: 'user-1',
        username: 'alice',
        provider: 'private-provider',
        credentialToken: 'secret',
      }]),
      raw_data: JSON.stringify([{
        content_id: 'post-1',
        text: 'hello',
        published_at: 1_780_675_695,
        collected_at: 1_780_707_610,
        author_id: 'user-1',
        author_name: 'Alice',
        endpointId: 'private-endpoint',
      }]),
      page: {
        page: 1,
        pageSize: 20,
        returnedCount: 1,
        hasMore: false,
        nextCursor: null,
      },
      meta: { resultCount: 1, provider: 'private-provider' },
      ...(warning ? { warnings: [{ code: 'PARTIAL_RESULT' }] } : {}),
    },
    requestId: 'night-all-request',
    traceId: 'night-all-trace',
  }
}

function legacySearchCapabilities({
  rawSupported = ['xiaohongshu'],
  rawReady = rawSupported,
  crawlSupported = ['xiaohongshu'],
  crawlReady = crawlSupported,
  userInfoSupported = ['xiaohongshu'],
  userInfoReady = userInfoSupported,
} = {}) {
  return {
    contractVersion: 'night-all.legacy-search-capabilities.v1',
    operations: {
      raw: { supportedPlatforms: rawSupported, readyPlatforms: rawReady },
      crawl: { supportedPlatforms: crawlSupported, readyPlatforms: crawlReady },
      'user-info': { supportedPlatforms: userInfoSupported, readyPlatforms: userInfoReady },
    },
  }
}

test('legacy adapter preserves the complete Night-All data envelope', async () => {
  let forwarded
  const adapter = new NightAllAdapter({
    baseUrl: 'http://night-all.invalid',
    fetchImpl: async (url, options) => {
      assert.equal(new URL(url).pathname, '/api/v1/search/raw')
      forwarded = JSON.parse(options.body)
      return response(envelope())
    },
  })

  const result = await adapter.legacySearch({
    operation: 'raw',
    body: { platform: 'xiaohongshu', query: 'hello' },
    businessId: 'consumer-business',
  })
  assert.equal(forwarded.businessId, 'consumer-business')
  assert.equal(result.payload.traceId, 'night-all-trace')
  assert.equal(result.payload.data.meta.provider, 'private-provider')
  assert.equal(JSON.parse(result.payload.data.raw_info)[0].credentialToken, 'secret')
  assert.equal(JSON.parse(result.payload.data.raw_data)[0].endpointId, 'private-endpoint')
  assert.deepEqual(result.payload, result.raw)
})

test('legacy adapter treats a successful but invalid envelope as outcome unknown', async () => {
  const adapter = new NightAllAdapter({
    baseUrl: 'http://night-all.invalid',
    fetchImpl: async () => response({ data: { raw_info: '{}', raw_data: '[]', page: {}, meta: {} } }),
  })
  await assert.rejects(
    () => adapter.legacySearch({
      operation: 'user-info',
      body: { platform: 'twitter', username: 'alice' },
      businessId: 'consumer-business',
    }),
    (error) => error?.name === 'UpstreamAmbiguousError'
      && error?.cause?.name === 'InvalidUpstreamResponseError'
      && error?.cause?.code === 'invalid_upstream_contract',
  )
})

test('legacy adapter deadline covers a response body that stalls after headers', async () => {
  const adapter = new NightAllAdapter({
    baseUrl: 'http://night-all.invalid',
    timeoutMs: 10,
    fetchImpl: async (_url, options) => {
      const body = new ReadableStream({
        start(controller) {
          options.signal.addEventListener('abort', () => {
            controller.error(new DOMException('aborted', 'AbortError'))
          }, { once: true })
        },
      })
      return new Response(body, { headers: { 'content-type': 'application/json' } })
    },
  })
  await assert.rejects(
    () => adapter.legacySearch({
      operation: 'raw',
      body: { platform: 'twitter', query: 'AI' },
      businessId: 'consumer-business',
    }),
    (error) => error?.name === 'UpstreamAmbiguousError',
  )
})

test('capabilities adapter uses the Hub-pinned legacy matrix without Night-All discovery', async () => {
  const requestedPaths = []
  const adapter = new NightAllAdapter({
    baseUrl: 'http://night-all.invalid',
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname
      requestedPaths.push(pathname)
      assert.equal(pathname, '/api/v1/data/capabilities')
      return response({
        data: {
          platforms: [
            { platform: 'xiaohongshu', ready: true },
            { platform: 'twitter', ready: true },
            { platform: 'facebook', ready: false },
          ],
        },
      })
    },
  })

  const payload = await adapter.capabilities(['xiaohongshu', 'facebook'])
  assert.deepEqual(requestedPaths, ['/api/v1/data/capabilities'])
  assert.deepEqual(payload.data.platforms.map((entry) => entry.platform), ['xiaohongshu', 'facebook'])
  assert.deepEqual(payload.data.legacySearch.operations, {
    raw: {
      supportedPlatforms: ['facebook', 'xiaohongshu'],
      readyPlatforms: ['facebook', 'xiaohongshu'],
    },
    crawl: {
      supportedPlatforms: ['facebook', 'xiaohongshu'],
      readyPlatforms: ['facebook', 'xiaohongshu'],
    },
    'user-info': {
      supportedPlatforms: ['facebook', 'xiaohongshu'],
      readyPlatforms: ['facebook', 'xiaohongshu'],
    },
  })
})

test('Hub-pinned legacy capabilities expose every operation and filter caller grants', () => {
  const matrix = buildNightAllLegacySearchCapabilities(['xhs', 'xiaohongshu', 'telegram', 'twitter'])
  assert.deepEqual(Object.keys(matrix.operations), ['raw', 'crawl', 'user-info'])
  assert.deepEqual(matrix.operations.raw, {
    supportedPlatforms: ['twitter', 'xiaohongshu'],
    readyPlatforms: ['twitter', 'xiaohongshu'],
  })
  assert.deepEqual(matrix.operations.crawl, {
    supportedPlatforms: ['twitter', 'xiaohongshu'],
    readyPlatforms: ['twitter', 'xiaohongshu'],
  })
  assert.deepEqual(matrix.operations['user-info'], {
    supportedPlatforms: ['twitter', 'xiaohongshu'],
    readyPlatforms: ['twitter', 'xiaohongshu'],
  })
  assert.equal(Object.values(matrix.operations).some(({ supportedPlatforms }) => (
    supportedPlatforms.includes('telegram')
  )), false)
  assert.equal(NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS.raw.includes('telegram'), false)
})

test('compatibility request keeps legacy aliases but enforces the Hub trust boundary', () => {
  const options = {
    businessId: 'consumer-business',
    canonicalizePlatform: (value) => value === 'xhs' ? 'xiaohongshu' : value,
    maxPageSize: 50,
  }
  const normalized = normalizeNightAllCompatibilityRequest('raw', {
    businessId: 'consumer-business',
    platform: 'xhs',
    keyword: 'AI',
    count: 20,
    params: { cursor: 'opaque', search_id: 'upstream-search', authorFilter: 'alice' },
  }, options)
  assert.equal(normalized.platform, 'xiaohongshu')
  assert.equal(normalized.upstreamBody.businessId, undefined)
  assert.equal(normalized.upstreamBody.params.search_id, 'upstream-search')
  assert.equal(normalized.upstreamBody.params.authorFilter, 'alice')

  assert.throws(
    () => normalizeNightAllCompatibilityRequest('raw', {
      businessId: 'another-tenant', platform: 'xhs', keyword: 'AI',
    }, options),
    (error) => error?.code === 'business_id_mismatch',
  )
  assert.throws(
    () => normalizeNightAllCompatibilityRequest('raw', {
      platform: 'xhs', keyword: 'AI', params: { provider: 'tikhub' },
    }, options),
    (error) => error?.code === 'unsupported_fields',
  )
  for (const params of [
    { apiKey: 'caller-credential' },
    { api_key: 'caller-credential' },
    { httpProxy: 'http://caller-proxy.invalid' },
    { useHttpProxy: true },
    { headers: { authorization: 'Bearer caller-token' } },
    { cookie: 'session=caller' },
    { access_token: 'caller-token' },
    { session: 'caller-session' },
    { capability: 'forced-provider-endpoint' },
    { moduleCode: 'forced-module' },
    { options: [{ apiKey: 'nested-caller-credential' }] },
    { nested: [{ headers: { authorization: 'Bearer nested-token' } }] },
    { archive: true, archiveLimit: 500 },
    { fullArchive: true },
    { allTweets: true, totalCount: 500 },
    { maxVideoPages: 50 },
    { count: 1_000 },
    { page_size: 1_000 },
    { limit: 1_000, commentLimit: 20 },
    { maxEnrichItems: 100 },
  ]) {
    assert.throws(
      () => normalizeNightAllCompatibilityRequest('raw', {
        platform: 'xhs', keyword: 'AI', params,
      }, options),
      (error) => error?.code === 'unsupported_fields',
    )
  }
  const continuation = normalizeNightAllCompatibilityRequest('raw', {
    platform: 'xhs',
    keyword: 'AI',
    params: {
      search_id: 'search-2',
      search_session_id: 'session-2',
      search_hash_id: 'hash-2',
      continuation_token: 'continue-2',
      next_max_id: 'max-2',
      rank_token: 'rank-2',
      pcursor: 'page-2',
      backtrace: 'trace-2',
      offset: 20,
      pagination_token: 'page-token-2',
    },
  }, options)
  assert.equal(continuation.upstreamBody.params.search_session_id, 'session-2')
  assert.equal(continuation.upstreamBody.params.continuation_token, 'continue-2')
  const explicitDefault = normalizeNightAllCompatibilityRequest('raw', {
    platform: 'xhs', keyword: 'AI', includeRaw: false,
  }, options)
  assert.equal(explicitDefault.upstreamBody.includeRaw, undefined)
  assert.throws(
    () => normalizeNightAllCompatibilityRequest('raw', {
      platform: 'xhs', keyword: 'AI', includeRaw: true,
    }, options),
    (error) => error?.code === 'unsupported_fields',
  )
  assert.throws(
    () => normalizeNightAllCompatibilityRequest('raw', {
      platform: 'xhs', keyword: 'AI', params: { ids: Array.from({ length: 51 }, (_, index) => `id-${index}`) },
    }, options),
    (error) => error?.code === 'unsupported_fields',
  )
  assert.throws(
    () => normalizeNightAllCompatibilityRequest('crawl', {
      platform: 'twitter', username: 'alice', count: 51,
    }, options),
    (error) => error?.code === 'page_size_exceeded',
  )
  assert.throws(
    () => normalizeNightAllCompatibilityRequest('raw', {
      platform: 'xhs', keyword: 'AI', includeDetails: 'yes',
    }, options),
    (error) => error?.code === 'invalid_request',
  )
  assert.throws(
    () => normalizeNightAllCompatibilityRequest('crawl', {
      platform: 'twitter', username: 'alice', count: 101,
    }, { ...options, maxPageSize: 500 }),
    (error) => error?.code === 'page_size_exceeded',
  )
  assert.equal(normalizeNightAllCompatibilityRequest('raw', {
    platform: 'twitter', keyword: 'AI', count: 500,
  }, { ...options, maxPageSize: 500 }).pageSize, 500)

  const coerced = normalizeNightAllCompatibilityRequest('crawl', {
    platform: 'twitter', user_id: 12345, channel_id: 67890,
    count: '20', page: '2', concurrency: '3', channel_url: 'https://example.test/channel',
  }, { ...options, maxPageSize: 100 })
  assert.equal(coerced.upstreamBody.user_id, '12345')
  assert.equal(coerced.upstreamBody.channel_id, '67890')
  assert.equal(coerced.upstreamBody.count, 20)
  assert.equal(coerced.upstreamBody.page, 2)
  assert.equal(coerced.upstreamBody.concurrency, 3)

  for (const field of ['url', 'profileUrl', 'profile_url']) {
    const profileUrl = `https://www.linkedin.com/in/${field}`
    const linkedIn = normalizeNightAllCompatibilityRequest('user-info', {
      platform: 'linkedin',
      [field]: profileUrl,
    }, options)
    assert.equal(linkedIn.upstreamBody.username, profileUrl)
    assert.equal(linkedIn.upstreamBody[field], undefined)
  }
  const linkedInBatch = normalizeNightAllCompatibilityRequest('user-info', {
    platform: 'linkedin',
    urls: ['https://www.linkedin.com/in/one', 'https://www.linkedin.com/in/two'],
  }, options)
  assert.deepEqual(linkedInBatch.upstreamBody.usernames, [
    'https://www.linkedin.com/in/one',
    'https://www.linkedin.com/in/two',
  ])
  assert.equal(linkedInBatch.upstreamBody.urls, undefined)
  for (const invalidLinkedInIdentifier of [
    { username: 'satyanadella' },
    { url: 'https://www.linkedin.com/company/microsoft' },
  ]) {
    assert.throws(
      () => normalizeNightAllCompatibilityRequest('user-info', {
        platform: 'linkedin',
        ...invalidLinkedInIdentifier,
      }, options),
      (error) => error?.code === 'invalid_request',
    )
  }

  const enriched = normalizeNightAllCompatibilityRequest('raw', {
    platform: 'twitter', keyword: 'AI', cacheMaxAgeHours: 24,
    maxEnrichItems: 10, commentCursor: 'next-comment', enrichConcurrency: 2,
  }, options)
  assert.equal(enriched.upstreamBody.maxEnrichItems, 10)
  assert.throws(
    () => normalizeNightAllCompatibilityRequest('raw', {
      platform: 'twitter', keyword: ['AI'],
    }, options),
    (error) => error?.code === 'invalid_request',
  )
  assert.throws(
    () => normalizeNightAllCompatibilityRequest('raw', {
      platform: 'twitter', queries: Array.from({ length: 51 }, (_, index) => `query-${index}`),
    }, options),
    (error) => error?.code === 'work_budget_exceeded',
  )
  assert.throws(
    () => normalizeNightAllCompatibilityRequest('raw', {
      platform: 'twitter', queries: ['one', 'two', 'three'], count: 20,
    }, options),
    (error) => error?.code === 'work_budget_exceeded',
  )
  assert.throws(
    () => normalizeNightAllCompatibilityRequest('crawl', {
      platform: 'twitter', usernames: ['one', 'two'], count: 20,
      activityTypes: ['posts', 'replies'],
    }, options),
    (error) => error?.code === 'work_budget_exceeded',
  )
})

test('business outcome and fallback rules distinguish partial and caller failures', () => {
  assert.equal(nightAllCompatibilityBusinessOutcome(envelope()), 'complete')
  assert.equal(nightAllCompatibilityBusinessOutcome(envelope({ warning: true })), 'partial')
  const empty = envelope()
  empty.data.raw_info = '[]'
  empty.data.raw_data = '[]'
  empty.data.warnings = [{ code: 'STANDARD_PAYLOAD_EMPTY', message: 'empty' }]
  assert.equal(nightAllCompatibilityBusinessOutcome(empty), 'complete')
  const failedBatch = envelope()
  failedBatch.data.results = [{ success: false }]
  assert.equal(nightAllCompatibilityBusinessOutcome(failedBatch), 'partial')
  assert.equal(canUseNightAllCompatibilityFallback(new UpstreamAmbiguousError('timeout')), true)
  assert.equal(canUseNightAllCompatibilityFallback(new UpstreamRejectedError(503, {})), true)
  assert.equal(canUseNightAllCompatibilityFallback(new UpstreamRejectedError(400, {})), false)
  assert.equal(canUseNightAllCompatibilityFallback(new UpstreamRejectedError(429, {})), false)
})

test('legacy raw/profile records enter one canonical compatibility dataset', () => {
  const payload = envelope()
  const normalized = normalizeNightAllLegacyPayload(payload, 'telegram', 'crawl')
  assert.equal(NIGHT_ALL_COMPAT_DATASET_ID, 'night-all.compat.v1')
  assert.equal(normalized.records.length, 2)

  const profile = normalized.records.find((record) => record.objectType === 'profile')
  const post = normalized.records.find((record) => record.objectType === 'post')
  assert.equal(profile.externalId, 'user-1')
  assert.equal(post.externalId, 'post-1')
  assert.equal(post.body, 'hello')
  assert.equal(post.eventTime.toISOString(), '2026-06-05T16:08:15.000Z')
  assert.equal(post.stableFields.relations.messageId, 'post-1')
  assert.equal(post.extensions.compatibilityOperation, undefined)

  const fromRawOperation = normalizeNightAllLegacyPayload(payload, 'telegram', 'raw')
    .records.find((record) => record.objectType === 'post')
  assert.equal(fromRawOperation.payloadSha256, post.payloadSha256)
  assert.deepEqual(fromRawOperation.extensions, post.extensions)

  const withFullText = envelope()
  const fullTextRows = JSON.parse(withFullText.data.raw_data)
  fullTextRows[0].text = 'truncated'
  fullTextRows[0].full_text = 'complete message body'
  withFullText.data.raw_data = JSON.stringify(fullTextRows)
  const fullTextPost = normalizeNightAllLegacyPayload(withFullText, 'twitter', 'raw')
    .records.find((record) => record.objectType === 'post')
  assert.equal(fullTextPost.body, 'complete message body')
})

async function compatibilityFixture({ grants = ['xiaohongshu'] } = {}) {
  const store = new MemoryStore()
  const jobs = []
  const commitLive = store.commitCompatibilityLiveDelivery.bind(store)
  store.commitCompatibilityLiveDelivery = async (callId, input) => {
    jobs.push(input.job)
    return commitLive(callId, input)
  }
  const tenant = await store.createTenant({ name: 'Tenant' })
  const consumer = await store.createConsumer({
    tenantId: tenant.id,
    name: 'Consumer',
    businessId: 'compat-consumer',
  })
  await store.replaceGrants(consumer.id, grants)
  for (const platform of grants) {
    await store.putPolicy({
      tenantId: tenant.id,
      consumerId: consumer.id,
      platform,
      maxRequests: 100,
      windowSeconds: 3_600,
      maxPageSize: 100,
    })
  }

  let mode = 'complete'
  let calls = 0
  let compatibilityCapabilities = legacySearchCapabilities()
  let compatibilityCapabilitiesError = null
  let capabilityCalls = 0
  const adapter = {
    async legacySearchCapabilities() {
      capabilityCalls += 1
      if (compatibilityCapabilitiesError) throw compatibilityCapabilitiesError
      return structuredClone(compatibilityCapabilities)
    },
    async legacySearch({ body, businessId }) {
      calls += 1
      assert.equal(businessId, 'compat-consumer')
      if (mode === 'unavailable') throw new UpstreamRejectedError(503, { requestId: 'failed-upstream' })
      if (mode === 'timeout') throw new UpstreamAmbiguousError('timeout', { name: 'AbortError' })
      if (mode === 'contract') {
        const cause = new Error('invalid_upstream_contract')
        cause.name = 'InvalidUpstreamResponseError'
        cause.code = 'invalid_upstream_contract'
        throw new UpstreamAmbiguousError('invalid success envelope', cause)
      }
      const payload = envelope({ warning: mode === 'partial' })
      if (mode === 'empty') {
        payload.data.raw_info = '[]'
        payload.data.raw_data = '[]'
        payload.data.meta.resultCount = 0
        payload.data.warnings = [{ code: 'STANDARD_PAYLOAD_EMPTY', message: 'empty' }]
        return { payload, raw: structuredClone(payload) }
      }
      const records = JSON.parse(payload.data.raw_data)
      records[0].text = mode === 'partial' ? 'partial-new' : body.query
      payload.data.raw_data = JSON.stringify(records)
      return { payload, raw: structuredClone(payload) }
    },
  }
  const service = new HubService({ store, adapter, apiKeyPepper: 'test-pepper' })
  const context = { tenant, consumer, apiKey: { id: '00000000-0000-4000-8000-000000000001' } }
  return {
    store,
    service,
    context,
    setMode(value) { mode = value },
    setCompatibilityCapabilities(value) { compatibilityCapabilities = value },
    setCompatibilityCapabilitiesError(value) { compatibilityCapabilitiesError = value },
    capabilityCalls() { return capabilityCalls },
    calls() { return calls },
    jobs,
  }
}

test('compatibility rejects unsupported and unavailable platform operations before durable dispatch', async () => {
  const fixture = await compatibilityFixture()
  fixture.setCompatibilityCapabilities(legacySearchCapabilities({ rawSupported: [], rawReady: [] }))
  await assert.rejects(
    () => compatibilityCall(fixture, 'compat-unsupported-001'),
    (error) => error?.status === 400 && error?.code === 'platform_operation_unsupported',
  )
  assert.equal(fixture.calls(), 0)
  assert.equal(fixture.store.requests.size, 0)
  assert.equal(fixture.store.connectorCalls.size, 0)

  fixture.setCompatibilityCapabilities(legacySearchCapabilities({ rawReady: [] }))
  await assert.rejects(
    () => compatibilityCall(fixture, 'compat-unavailable-001'),
    (error) => error?.status === 503 && error?.code === 'platform_operation_unavailable',
  )
  assert.equal(fixture.calls(), 0)
  assert.equal(fixture.store.requests.size, 0)
  assert.equal(fixture.store.connectorCalls.size, 0)
})

test('compatibility fails closed on a missing matrix and never redirects local Telegram to stored search', async () => {
  const missing = await compatibilityFixture()
  missing.setCompatibilityCapabilities(null)
  await assert.rejects(
    () => compatibilityCall(missing, 'compat-matrix-missing-001'),
    (error) => error?.status === 503 && error?.code === 'compatibility_capabilities_unavailable',
  )
  assert.equal(missing.calls(), 0)
  assert.equal(missing.store.requests.size, 0)

  const incomplete = await compatibilityFixture()
  const incompleteMatrix = legacySearchCapabilities()
  delete incompleteMatrix.operations.crawl
  incomplete.setCompatibilityCapabilities(incompleteMatrix)
  await assert.rejects(
    () => compatibilityCall(incomplete, 'compat-matrix-incomplete-001'),
    (error) => error?.status === 503 && error?.code === 'compatibility_capabilities_unavailable',
  )
  assert.equal(incomplete.calls(), 0)
  assert.equal(incomplete.store.requests.size, 0)

  const telegram = await compatibilityFixture({ grants: ['telegram'] })
  telegram.setCompatibilityCapabilities(legacySearchCapabilities())
  await assert.rejects(
    () => telegram.service.nightAllCompatibilitySearch(telegram.context, {
      operation: 'raw',
      path: '/api/v1/night-all/search/raw',
      idempotencyKey: 'compat-telegram-local-001',
      body: { platform: 'telegram', keyword: 'AI', count: 20 },
    }),
    (error) => error?.status === 400 && error?.code === 'platform_operation_unsupported',
  )
  assert.equal(telegram.calls(), 0)
  assert.equal(telegram.store.requests.size, 0)
  assert.equal(telegram.store.connectorCalls.size, 0)
})

test('public capabilities identify Hub-local Telegram without adding it to Night-All legacy support', async () => {
  const service = new HubService({
    store: {
      async listGrants() { return ['telegram'] },
      async listCanonicalRecords() { return [] },
      async listCapabilityGrants() { return [] },
    },
    adapter: {
      async capabilities() {
        assert.fail('Telegram-only discovery must not call Night-All')
      },
    },
    apiKeyPepper: 'test-pepper',
  })

  const payload = await service.capabilities({ consumer: { id: 'consumer' } })
  assert.deepEqual(payload.data.platforms, [{
    platform: 'telegram',
    ready: true,
    source: 'hub',
    servingMode: 'stored',
    capabilities: ['monitor_chats', 'monitor_messages', 'stored_search', 'entity_search'],
  }])
  assert.equal(payload.data.legacySearch, null)
})

test('public capabilities canonicalize platform grant aliases before Night-All filtering', async () => {
  let allowedPlatforms
  const service = new HubService({
    store: {
      async listGrants() { return ['xhs'] },
      async listCapabilityGrants() { return [] },
    },
    adapter: {
      async capabilities(allowed) {
        allowedPlatforms = allowed
        return { data: { platforms: [], legacySearch: legacySearchCapabilities() } }
      },
    },
    apiKeyPepper: 'test-pepper',
  })

  await service.capabilities({ consumer: { id: 'consumer-1' } })
  assert.deepEqual(allowedPlatforms, ['xiaohongshu'])
})

function compatibilityCall(fixture, idempotencyKey, query = 'AI') {
  return fixture.service.nightAllCompatibilitySearch(fixture.context, {
    operation: 'raw',
    path: '/api/v1/night-all/search/raw',
    idempotencyKey,
    body: { platform: 'xiaohongshu', query, count: 20 },
  })
}

test('compatibility service records complete live data and returns exact stale fallback', async () => {
  const fixture = await compatibilityFixture()
  const live = await compatibilityCall(fixture, 'compat-live-001')
  assert.equal(live.sourceMode, 'live')
  assert.equal(JSON.parse(live.body.data.raw_data)[0].text, 'AI')
  assert.equal(fixture.store.compatibilitySnapshots.size, 1)
  assert.match(fixture.jobs[0].dedupeKey, /^night-all-compat-result:[0-9a-f-]{36}$/)
  assert.equal(fixture.jobs[0].payload.connectorCallId, fixture.jobs[0].dedupeKey.split(':')[1])
  assert.notEqual(fixture.jobs[0].payload.connectorCallId, fixture.jobs[0].payload.requestId)

  fixture.setMode('unavailable')
  const stale = await compatibilityCall(fixture, 'compat-stale-001')
  assert.equal(stale.sourceMode, 'stale')
  assert.equal(JSON.parse(stale.body.data.raw_data)[0].text, 'AI')
  assert.equal(fixture.calls(), 2)

  const replay = await compatibilityCall(fixture, 'compat-stale-001')
  assert.equal(replay.replay, true)
  assert.equal(replay.sourceMode, 'stale')
  assert.equal(fixture.calls(), 2)

  const calls = [...fixture.store.connectorCalls.values()]
  assert.deepEqual(calls.map((call) => [call.outcome, call.sourceMode]), [
    ['complete', 'live'],
    ['failed', 'stale'],
  ])
})

test('a compatibility idempotency key permanently replays its one paid dispatch', async () => {
  const fixture = await compatibilityFixture()
  const live = await compatibilityCall(fixture, 'compat-permanent-replay')
  const [request] = fixture.store.requests.values()
  request.completedAt = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString()
  fixture.setMode('unavailable')
  fixture.setCompatibilityCapabilitiesError(new TypeError('capability endpoint unavailable'))

  const replay = await compatibilityCall(fixture, 'compat-permanent-replay')
  assert.equal(replay.replay, true)
  assert.deepEqual(replay.body, live.body)
  assert.equal(replay.sourceMode, live.sourceMode)
  assert.equal(replay.capturedAt, live.capturedAt)
  assert.equal(fixture.capabilityCalls(), 1)
  assert.equal(fixture.calls(), 1)
  assert.equal(fixture.store.connectorCalls.size, 1)
})

test('a capability failure rechecks an idempotency key inserted after the initial lookup', async () => {
  const fixture = await compatibilityFixture()
  const live = await compatibilityCall(fixture, 'compat-raced-replay')
  const lookup = fixture.store.getUsageRequestByIdempotencyKey.bind(fixture.store)
  let lookups = 0
  fixture.store.getUsageRequestByIdempotencyKey = async (...args) => {
    lookups += 1
    if (lookups === 1) return null
    return lookup(...args)
  }
  fixture.setCompatibilityCapabilitiesError(new TypeError('capability endpoint unavailable'))

  const replay = await compatibilityCall(fixture, 'compat-raced-replay')
  assert.equal(lookups, 2)
  assert.equal(replay.replay, true)
  assert.deepEqual(replay.body, live.body)
  assert.equal(fixture.calls(), 1)
})

test('a released compatibility key must pass capability precheck before redispatch', async () => {
  for (const capabilityMode of ['down', 'unsupported']) {
    const fixture = await compatibilityFixture()
    fixture.setMode('unavailable')
    await assert.rejects(
      () => compatibilityCall(fixture, `compat-released-${capabilityMode}`),
      (error) => error?.code === 'night_all_rejected',
    )
    const [request] = fixture.store.requests.values()
    assert.equal(request.status, 'released')
    assert.equal(fixture.calls(), 1)

    fixture.setMode('complete')
    if (capabilityMode === 'down') {
      fixture.setCompatibilityCapabilitiesError(new TypeError('capability endpoint unavailable'))
    } else {
      fixture.setCompatibilityCapabilities(legacySearchCapabilities({ rawSupported: [], rawReady: [] }))
    }
    await assert.rejects(
      () => compatibilityCall(fixture, `compat-released-${capabilityMode}`),
      (error) => capabilityMode === 'down'
        ? error?.code === 'compatibility_capabilities_unavailable'
        : error?.code === 'platform_operation_unsupported',
    )
    assert.equal(request.status, 'released')
    assert.equal(fixture.calls(), 1)
    assert.equal(fixture.store.connectorCalls.size, 1)
    assert.equal(fixture.capabilityCalls(), 2)
  }
})

test('decisive idempotency states remain independent of capability availability', async () => {
  for (const [status, code] of [
    ['reserved', 'request_in_progress'],
    ['unknown', 'request_outcome_unknown'],
  ]) {
    const fixture = await compatibilityFixture()
    await compatibilityCall(fixture, `compat-existing-${status}`)
    const [request] = fixture.store.requests.values()
    request.status = status
    fixture.setCompatibilityCapabilitiesError(new TypeError('capability endpoint unavailable'))
    await assert.rejects(
      () => compatibilityCall(fixture, `compat-existing-${status}`),
      (error) => error?.code === code,
    )
    assert.equal(fixture.capabilityCalls(), 1)
    assert.equal(fixture.calls(), 1)
  }

  const conflict = await compatibilityFixture()
  await compatibilityCall(conflict, 'compat-existing-conflict', 'first')
  conflict.setCompatibilityCapabilitiesError(new TypeError('capability endpoint unavailable'))
  await assert.rejects(
    () => compatibilityCall(conflict, 'compat-existing-conflict', 'different'),
    (error) => error?.code === 'idempotency_conflict',
  )
  assert.equal(conflict.capabilityCalls(), 1)
  assert.equal(conflict.calls(), 1)
})

test('an invalid HTTP 2xx envelope is unknown and cannot redispatch the same key', async () => {
  const fixture = await compatibilityFixture()
  fixture.setMode('contract')
  await assert.rejects(
    () => compatibilityCall(fixture, 'compat-invalid-success'),
    (error) => error?.code === 'upstream_outcome_unknown',
  )
  await assert.rejects(
    () => compatibilityCall(fixture, 'compat-invalid-success'),
    (error) => error?.code === 'request_outcome_unknown',
  )
  assert.equal(fixture.calls(), 1)
  const [request] = fixture.store.requests.values()
  const [call] = fixture.store.connectorCalls.values()
  assert.equal(request.status, 'unknown')
  assert.equal(call.outcome, 'unknown')
  assert.equal(call.failureKind, 'contract')
  assert.equal(call.errorCode, 'night_all_invalid_upstream_contract')
})

test('an invalid HTTP 2xx envelope may use the exact last-good snapshot', async () => {
  const fixture = await compatibilityFixture()
  await compatibilityCall(fixture, 'compat-contract-live')
  fixture.setMode('contract')
  const stale = await compatibilityCall(fixture, 'compat-contract-stale')
  assert.equal(stale.sourceMode, 'stale')
  const call = [...fixture.store.connectorCalls.values()].at(-1)
  assert.equal(call.outcome, 'unknown')
  assert.equal(call.sourceMode, 'stale')
  assert.equal(call.failureKind, 'contract')
})

test('partial live responses never replace the last complete compatibility snapshot', async () => {
  const fixture = await compatibilityFixture()
  await compatibilityCall(fixture, 'compat-complete-001')
  fixture.setMode('partial')
  const partial = await compatibilityCall(fixture, 'compat-partial-001')
  assert.equal(partial.sourceMode, 'live')
  assert.equal(JSON.parse(partial.body.data.raw_data)[0].text, 'partial-new')
  assert.equal(fixture.store.compatibilitySnapshots.size, 1)
  const partialEvidence = [...fixture.store.connectorCalls.values()].at(-1)
  assert.equal(partialEvidence.outcome, 'partial')
  assert.equal(partialEvidence.failureKind, 'business')
  assert.equal(partialEvidence.errorCode, 'night_all_partial_result')

  fixture.setMode('timeout')
  const stale = await compatibilityCall(fixture, 'compat-after-partial')
  assert.equal(stale.sourceMode, 'stale')
  assert.equal(JSON.parse(stale.body.data.raw_data)[0].text, 'AI')
})

test('a confirmed empty live result replaces an older non-empty snapshot', async () => {
  const fixture = await compatibilityFixture()
  await compatibilityCall(fixture, 'compat-nonempty-001')
  fixture.setMode('empty')
  const empty = await compatibilityCall(fixture, 'compat-empty-001')
  assert.equal(JSON.parse(empty.body.data.raw_data).length, 0)

  fixture.setMode('unavailable')
  const stale = await compatibilityCall(fixture, 'compat-empty-stale')
  assert.equal(stale.sourceMode, 'stale')
  assert.equal(JSON.parse(stale.body.data.raw_data).length, 0)
})

test('compatibility fallback never crosses an exact request fingerprint', async () => {
  const fixture = await compatibilityFixture()
  await compatibilityCall(fixture, 'compat-query-a1', 'query-a')
  fixture.setMode('unavailable')
  await assert.rejects(
    () => compatibilityCall(fixture, 'compat-query-b1', 'query-b'),
    (error) => error?.status === 502 && error?.code === 'night_all_rejected',
  )
  assert.equal(fixture.store.compatibilitySnapshots.size, 1)
})

test('a fallback lookup failure closes ambiguous evidence and holds usage unknown', async () => {
  const fixture = await compatibilityFixture()
  fixture.setMode('timeout')
  fixture.store.findUsableCompatibilitySnapshot = async () => {
    throw new Error('database unavailable')
  }

  await assert.rejects(
    () => compatibilityCall(fixture, 'compat-lookup-failure-001'),
    (error) => error?.code === 'compatibility_store_unavailable' && error?.status === 503,
  )
  const [request] = fixture.store.requests.values()
  const [call] = fixture.store.connectorCalls.values()
  assert.equal(request.status, 'unknown')
  assert.equal(request.errorCode, 'night_all_outcome_unknown')
  assert.equal(call.outcome, 'unknown')
  assert.equal(call.errorCode, 'night_all_outcome_unknown')
})

test('a persistence failure closes connector evidence and holds usage as unknown', async () => {
  const fixture = await compatibilityFixture()
  fixture.store.commitCompatibilityLiveDelivery = async () => {
    throw new Error('queue insert failed before commit')
  }
  await assert.rejects(
    () => compatibilityCall(fixture, 'compat-persist-failure'),
    /queue insert failed/,
  )
  const request = [...fixture.store.requests.values()].at(-1)
  const call = [...fixture.store.connectorCalls.values()].at(-1)
  assert.equal(request.status, 'unknown')
  assert.equal(call.outcome, 'complete')
  assert.equal(call.errorCode, 'compatibility_persistence_failed')
  assert.ok(call.completedAt)
})
