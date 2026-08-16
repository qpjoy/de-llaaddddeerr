import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createApp } from '../../server/app.mjs'
import {
  canonicalSearchResponse,
  normalizeCanonicalSearchQuery,
} from '../../server/data/stored-search.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const ADMIN_TOKEN = 'canonical-search-admin-token'
const PEPPER = 'canonical-search-test-pepper-with-enough-entropy'
const FIRST_ID = '11111111-1111-4111-8111-111111111111'

async function withServer(app, run) {
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function call(baseUrl, path, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { response, payload: await response.json() }
}

function canonicalItem(overrides = {}) {
  return {
    id: FIRST_ID,
    datasetId: 'telegram.sqlite.messages.v1',
    platform: 'telegram',
    objectType: 'message',
    contentType: 'text',
    externalId: '-1007:1',
    title: 'Agent update',
    body: 'Canonical cross-source result',
    metrics: { views: 3, privateCounter: 9 },
    eventTime: '2026-08-10T00:00:00.000Z',
    collectedAt: '2026-08-10T00:01:00.000Z',
    score: 8.5,
    extensions: { raw: 'must-not-leak' },
    ...overrides,
  }
}

test('canonical response exposes exact totals and withholds totalPages for a lower-bound total', () => {
  const query = normalizeCanonicalSearchQuery(
    { query: 'agent', pageSize: 20 },
    { platforms: ['xiaohongshu', 'telegram'], maxPageSize: 50, cursorSecret: PEPPER },
  )
  const exact = canonicalSearchResponse({
    query,
    result: { mode: 'elasticsearch', total: 41, totalRelation: 'eq', hasMore: false, items: [] },
    durationMs: 2,
    cursorSecret: PEPPER,
  })
  assert.deepEqual(exact.data.scope.platforms, ['telegram', 'xiaohongshu'])
  assert.equal(exact.data.pageInfo.totalCount, 41)
  assert.equal(exact.data.pageInfo.totalRelation, 'eq')
  assert.equal(exact.data.pageInfo.totalPages, 3)

  const lowerBound = canonicalSearchResponse({
    query,
    result: { mode: 'elasticsearch', total: 10_000, totalRelation: 'gte', hasMore: false, items: [] },
    durationMs: 2,
    cursorSecret: PEPPER,
  })
  assert.equal(lowerBound.data.pageInfo.totalCount, 10_000)
  assert.equal(lowerBound.data.pageInfo.totalRelation, 'gte')
  assert.equal(lowerBound.data.pageInfo.totalPages, null)
})

test('canonical endpoint searches one authorized global projection with filters, totals and scoped cursors', async () => {
  const store = new MemoryStore()
  const canonicalReservations = []
  const reserve = store.reserve.bind(store)
  store.reserve = async (input) => {
    if (input.capability === 'data.canonical-search') canonicalReservations.push(input)
    return reserve(input)
  }
  const contentCalls = []
  const upstreamCalls = []
  const searchQueries = {
    searchContent: async (query, options) => {
      contentCalls.push({ query, options })
      const global = options.platforms.length > 1
      return {
        mode: 'elasticsearch',
        total: global ? 5 : 1,
        totalRelation: 'eq',
        hasMore: global,
        nextCursor: global ? {
          mode: 'elasticsearch',
          pitId: 'canonical-pit',
          searchAfter: [8.5, '2026-08-10T00:00:00.000Z', FIRST_ID],
        } : null,
        items: [canonicalItem()],
      }
    },
  }
  const adapter = {
    search: async (input) => {
      upstreamCalls.push(input)
      return { payload: { data: { items: [] } }, raw: { data: { items: [] } } }
    },
    capabilities: async () => ({ data: { platforms: [] } }),
    dependencies: async () => ({ status: 'up' }),
  }
  const service = new HubService({ store, adapter, apiKeyPepper: PEPPER, searchQueries })
  const tenant = await service.createTenant({ name: 'Canonical search tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Canonical search consumer' })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Canonical search key' })
  await service.putPlatformConfiguration('xiaohongshu', {
    tenantId: tenant.id,
    consumerId: consumer.id,
    enabled: true,
    maxRequests: 8,
    windowSeconds: 60,
    maxPageSize: 5,
  })
  await service.putPlatformConfiguration('telegram', {
    tenantId: tenant.id,
    consumerId: consumer.id,
    enabled: true,
    maxRequests: 3,
    windowSeconds: 120,
    maxPageSize: 2,
  })
  const noGrantConsumer = await service.createConsumer({ tenantId: tenant.id, name: 'No grant consumer' })
  const noGrantKey = await service.createApiKey({ consumerId: noGrantConsumer.id, name: 'No grant key' })
  const app = createApp({ service, store, adapter, adminToken: ADMIN_TOKEN, logger: { error() {} } })

  await withServer(app, async (baseUrl) => {
    const authorization = { authorization: `Bearer ${key.secret}` }
    const body = {
      query: 'agent update',
      datasetId: 'telegram.sqlite.messages.v1',
      objectType: 'message',
      pageSize: 1,
    }

    const capabilities = await call(baseUrl, '/api/v1/data/capabilities', { headers: authorization })
    assert.equal(capabilities.response.status, 200)
    assert.equal(
      capabilities.payload.data.capabilities.some((entry) => entry.capability === 'data.canonical-search'),
      false,
    )

    const noGrants = await call(baseUrl, '/api/v1/data/canonical/search', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${noGrantKey.secret}`,
        'idempotency-key': 'canonical-no-grants',
      },
      body: { query: 'agent' },
    })
    assert.equal(noGrants.response.status, 403)
    assert.equal(noGrants.payload.error.code, 'platform_not_granted')

    const ungranted = await call(baseUrl, '/api/v1/data/canonical/search', {
      method: 'POST',
      headers: { ...authorization, 'idempotency-key': 'canonical-ungranted' },
      body: { ...body, platform: 'twitter' },
    })
    assert.equal(ungranted.response.status, 403)
    assert.equal(ungranted.payload.error.code, 'platform_not_granted')

    const tooLarge = await call(baseUrl, '/api/v1/data/canonical/search', {
      method: 'POST',
      headers: { ...authorization, 'idempotency-key': 'canonical-page-large' },
      body: { ...body, pageSize: 3 },
    })
    assert.equal(tooLarge.response.status, 400)
    assert.equal(tooLarge.payload.error.code, 'page_size_exceeded')

    const loosePlatformCannotWidenBucket = await call(baseUrl, '/api/v1/data/canonical/search', {
      method: 'POST',
      headers: { ...authorization, 'idempotency-key': 'canonical-loose-platform-page' },
      body: { ...body, platform: 'xiaohongshu', pageSize: 3 },
    })
    assert.equal(loosePlatformCannotWidenBucket.response.status, 400)
    assert.equal(loosePlatformCannotWidenBucket.payload.error.code, 'page_size_exceeded')

    const physicalControl = await call(baseUrl, '/api/v1/data/canonical/search', {
      method: 'POST',
      headers: { ...authorization, 'idempotency-key': 'canonical-no-index' },
      body: { ...body, index: 'private-index' },
    })
    assert.equal(physicalControl.response.status, 400)
    assert.equal(physicalControl.payload.error.code, 'unsupported_fields')
    assert.equal(contentCalls.length, 0)

    const headers = { ...authorization, 'idempotency-key': 'canonical-page-one' }
    const first = await call(baseUrl, '/api/v1/data/canonical/search', {
      method: 'POST', headers, body,
    })
    assert.equal(first.response.status, 200)
    assert.equal(first.response.headers.get('idempotent-replay'), 'false')
    assert.equal(first.payload.data.contractVersion, 'mx-insight-hub.canonical-search.v1')
    assert.deepEqual(first.payload.data.scope.platforms, ['telegram', 'xiaohongshu'])
    assert.deepEqual(first.payload.data.filters, {
      platform: null,
      datasetId: 'telegram.sqlite.messages.v1',
      objectType: 'message',
    })
    assert.equal(first.payload.data.pageInfo.totalCount, 5)
    assert.equal(first.payload.data.pageInfo.totalRelation, 'eq')
    assert.equal(first.payload.data.pageInfo.totalPages, 5)
    assert.ok(first.payload.data.pageInfo.nextCursor)
    assert.equal(JSON.stringify(first.payload).includes('must-not-leak'), false)
    assert.deepEqual(contentCalls[0], {
      query: 'agent update',
      options: {
        platforms: ['telegram', 'xiaohongshu'],
        datasetId: 'telegram.sqlite.messages.v1',
        objectType: 'message',
        size: 1,
        cursor: null,
        strictRelevance: true,
        trackTotalHits: true,
      },
    })
    assert.equal(upstreamCalls.length, 0)
    assert.equal(canonicalReservations[0].maxRequests, 3)
    const firstWindowSeconds = (Date.now() - canonicalReservations[0].windowStart.getTime()) / 1_000
    assert.ok(firstWindowSeconds >= 119 && firstWindowSeconds <= 121, 'canonical bucket uses the longest grant window')

    const replay = await call(baseUrl, '/api/v1/data/canonical/search', {
      method: 'POST', headers, body,
    })
    assert.equal(replay.response.status, 200)
    assert.equal(replay.response.headers.get('idempotent-replay'), 'true')
    assert.equal(contentCalls.length, 1)

    const status = await call(baseUrl, `/api/v1/requests/${first.payload.requestId}`, {
      headers: authorization,
    })
    assert.equal(status.response.status, 200)
    assert.equal(status.payload.data.capability, 'data.canonical-search')

    const selected = await call(baseUrl, '/api/v1/data/canonical/search', {
      method: 'POST',
      headers: { ...authorization, 'idempotency-key': 'canonical-loose-platform-only' },
      body: { ...body, platform: 'xiaohongshu', datasetId: 'night-all.search.v1' },
    })
    assert.equal(selected.response.status, 200)
    assert.deepEqual(contentCalls[1].options.platforms, ['xiaohongshu'])
    assert.deepEqual(selected.payload.data.scope.platforms, ['xiaohongshu'])

    // Two xiaohongshu-only calls still use the stable canonical bucket's
    // strictest grant-set policy (telegram maxRequests=3), rather than filling
    // the same bucket under xiaohongshu's looser maxRequests=8.
    const selectedAgain = await call(baseUrl, '/api/v1/data/canonical/search', {
      method: 'POST',
      headers: { ...authorization, 'idempotency-key': 'canonical-strict-quota' },
      body: { ...body, platform: 'xiaohongshu', query: 'another query' },
    })
    assert.equal(selectedAgain.response.status, 200)
    assert.equal(canonicalReservations[2].maxRequests, 3)
    assert.deepEqual(contentCalls[2].options.platforms, ['xiaohongshu'])

    const strictestQuota = await call(baseUrl, '/api/v1/data/canonical/search', {
      method: 'POST',
      headers: { ...authorization, 'idempotency-key': 'canonical-strict-quota-exceeded' },
      body: { ...body, platform: 'xiaohongshu', query: 'quota boundary' },
    })
    assert.equal(strictestQuota.response.status, 429)
    assert.equal(strictestQuota.payload.error.code, 'quota_exceeded')
    assert.equal(strictestQuota.payload.error.details.capability, 'data.canonical-search')
    assert.equal(strictestQuota.payload.error.details.maxRequests, 3)
    assert.equal(contentCalls.length, 3)

    await service.putPlatformConfiguration('xiaohongshu', {
      tenantId: tenant.id,
      consumerId: consumer.id,
      enabled: false,
      maxRequests: 8,
      windowSeconds: 60,
      maxPageSize: 5,
    })
    const staleScopeCursor = await call(baseUrl, '/api/v1/data/canonical/search', {
      method: 'POST',
      headers: { ...authorization, 'idempotency-key': 'canonical-scope-changed' },
      body: { ...body, cursor: first.payload.data.pageInfo.nextCursor },
    })
    assert.equal(staleScopeCursor.response.status, 400)
    assert.equal(staleScopeCursor.payload.error.code, 'invalid_cursor')
    assert.equal(contentCalls.length, 3)
  })
})
