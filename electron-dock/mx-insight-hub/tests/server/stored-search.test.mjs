import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createApp } from '../../server/app.mjs'
import { normalizeStoredSearchQuery, storedSearchResponse } from '../../server/data/stored-search.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const ADMIN_TOKEN = 'stored-search-admin-token'
const PEPPER = 'stored-search-test-pepper-with-enough-entropy'
const FIRST_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_ID = '22222222-2222-4222-8222-222222222222'

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

function canonicalItem(id) {
  return {
    id,
    datasetId: 'night-all.search.v1',
    platform: 'xiaohongshu',
    objectType: 'post',
    contentType: 'normal',
    externalId: `external-${id.slice(0, 4)}`,
    url: 'https://example.invalid/post',
    title: 'Stored result',
    body: 'Hub canonical body',
    authorExternalId: 'author-1',
    authorName: 'Alice',
    authorHandle: 'alice',
    metrics: { likes: 3, views: 7, internalCounter: 99 },
    eventTime: '2026-08-10T00:00:00.000Z',
    collectedAt: '2026-08-10T00:01:00.000Z',
    score: 1.25,
    source: { connectorId: 'must-not-leak', password: 'must-not-leak' },
    extensions: { raw: 'must-not-leak' },
    highlight: { body: ['must-not-leak'] },
  }
}

test('stored search cursor carries an Elasticsearch PIT without exposing it as a caller control', () => {
  const query = normalizeStoredSearchQuery({
    platform: 'xiaohongshu', query: 'agent', datasetId: 'night-all.search.v1', pageSize: 1,
  }, 10, PEPPER)
  const response = storedSearchResponse({
    query,
    result: {
      mode: 'elasticsearch',
      hasMore: true,
      nextCursor: {
        mode: 'elasticsearch',
        pitId: 'opaque-pit-id',
        searchAfter: [1.25, '2026-08-10T00:00:00.000Z', FIRST_ID],
      },
      items: [canonicalItem(FIRST_ID)],
    },
    durationMs: 4,
    cursorSecret: PEPPER,
  })
  const next = normalizeStoredSearchQuery({
    platform: 'xiaohongshu',
    query: 'agent',
    datasetId: 'night-all.search.v1',
    pageSize: 1,
    cursor: response.data.pageInfo.nextCursor,
  }, 10, PEPPER)

  assert.deepEqual(next.cursor, {
    mode: 'elasticsearch',
    pitId: 'opaque-pit-id',
    searchAfter: [1.25, '2026-08-10T00:00:00.000Z', FIRST_ID],
    seen: 1,
  })
  assert.deepEqual(response.data.warnings, [])
  assert.equal(response.data.searchMode, 'elasticsearch')
})

test('stored search is platform-granted, idempotent, opaque and never accepts physical search controls', async () => {
  const store = new MemoryStore()
  const contentCalls = []
  const upstreamCalls = []
  const searchQueries = {
    searchContent: async (query, options) => {
      contentCalls.push({ query, options })
      const secondPage = Boolean(options.cursor)
      return {
        mode: 'postgres',
        hasMore: !secondPage,
        nextCursor: secondPage ? null : {
          mode: 'postgres',
          pitId: null,
          searchAfter: ['2026-08-10T00:00:00.000Z', FIRST_ID],
        },
        items: [canonicalItem(secondPage ? SECOND_ID : FIRST_ID)],
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
  const tenant = await service.createTenant({ name: 'Stored search tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Stored search consumer' })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Stored search key' })
  await service.putPlatformConfiguration('xiaohongshu', {
    tenantId: tenant.id,
    consumerId: consumer.id,
    enabled: true,
    maxRequests: 10,
    windowSeconds: 3_600,
    maxPageSize: 2,
  })
  const app = createApp({
    service,
    store,
    adapter,
    adminToken: ADMIN_TOKEN,
    logger: { error() {} },
  })

  await withServer(app, async (baseUrl) => {
    const authorization = { authorization: `Bearer ${key.secret}` }
    const body = {
      platform: 'xhs',
      query: 'agent',
      datasetId: 'night-all.search.v1',
      objectType: 'post',
      pageSize: 1,
    }

    const missingKey = await call(baseUrl, '/api/v1/data/stored/search', {
      method: 'POST', headers: authorization, body,
    })
    assert.equal(missingKey.response.status, 400)
    assert.equal(missingKey.payload.error.code, 'idempotency_key_required')

    const ungranted = await call(baseUrl, '/api/v1/data/stored/search', {
      method: 'POST',
      headers: { ...authorization, 'idempotency-key': 'stored-ungranted-1' },
      body: { ...body, platform: 'twitter' },
    })
    assert.equal(ungranted.response.status, 403)
    assert.equal(ungranted.payload.error.code, 'platform_not_granted')

    const wildcard = await call(baseUrl, '/api/v1/data/stored/search', {
      method: 'POST',
      headers: { ...authorization, 'idempotency-key': 'stored-wildcard-1' },
      body: { ...body, platform: 'all' },
    })
    assert.equal(wildcard.response.status, 400)
    assert.equal(wildcard.payload.error.code, 'invalid_platform')

    for (const field of ['database', 'index', 'dsl', 'script']) {
      const rejected = await call(baseUrl, '/api/v1/data/stored/search', {
        method: 'POST',
        headers: { ...authorization, 'idempotency-key': `stored-reject-${field}` },
        body: { ...body, [field]: field === 'dsl' ? { match_all: {} } : 'private-target' },
      })
      assert.equal(rejected.response.status, 400)
      assert.equal(rejected.payload.error.code, 'unsupported_fields')
    }
    assert.equal(contentCalls.length, 0)
    assert.equal(upstreamCalls.length, 0)

    const tooLarge = await call(baseUrl, '/api/v1/data/stored/search', {
      method: 'POST',
      headers: { ...authorization, 'idempotency-key': 'stored-page-too-large' },
      body: { ...body, pageSize: 3 },
    })
    assert.equal(tooLarge.response.status, 400)
    assert.equal(tooLarge.payload.error.code, 'page_size_exceeded')

    const headers = { ...authorization, 'idempotency-key': 'stored-search-page-one' }
    const first = await call(baseUrl, '/api/v1/data/stored/search', {
      method: 'POST', headers, body,
    })
    assert.equal(first.response.status, 200)
    assert.equal(first.response.headers.get('idempotent-replay'), 'false')
    assert.equal(first.payload.data.contractVersion, 'mx-insight-hub.stored-search.v1')
    assert.equal(first.payload.data.source, 'hub')
    assert.equal(first.payload.data.searchMode, 'postgres')
    assert.deepEqual(first.payload.data.filters, {
      platform: 'xiaohongshu', datasetId: 'night-all.search.v1', objectType: 'post',
    })
    assert.equal(first.payload.data.items[0].source, 'hub')
    assert.deepEqual(first.payload.data.items[0].author, {
      id: 'author-1', name: 'Alice', username: 'alice',
    })
    assert.deepEqual(first.payload.data.items[0].metrics, {
      likes: 3, comments: null, shares: null, views: 7, bookmarks: null, members: null,
    })
    assert.ok(first.payload.data.pageInfo.nextCursor)
    assert.equal(first.payload.data.pageInfo.cursorType, 'opaque')
    assert.equal(JSON.stringify(first.payload).includes('must-not-leak'), false)
    assert.deepEqual(contentCalls[0], {
      query: 'agent',
      options: {
        platform: 'xiaohongshu',
        datasetId: 'night-all.search.v1',
        objectType: 'post',
        size: 1,
        cursor: null,
      },
    })
    assert.equal(upstreamCalls.length, 0)

    const replay = await call(baseUrl, '/api/v1/data/stored/search', {
      method: 'POST', headers, body,
    })
    assert.equal(replay.response.status, 200)
    assert.equal(replay.response.headers.get('idempotent-replay'), 'true')
    assert.equal(contentCalls.length, 1)

    const changedFilter = await call(baseUrl, '/api/v1/data/stored/search', {
      method: 'POST',
      headers: { ...authorization, 'idempotency-key': 'stored-cursor-filter' },
      body: { ...body, datasetId: 'another.dataset', cursor: first.payload.data.pageInfo.nextCursor },
    })
    assert.equal(changedFilter.response.status, 400)
    assert.equal(changedFilter.payload.error.code, 'invalid_cursor')

    const cursorPayload = JSON.parse(
      Buffer.from(first.payload.data.pageInfo.nextCursor, 'base64url').toString('utf8'),
    )
    cursorPayload.q = 'tampered-binding'
    const tamperedCursor = Buffer.from(JSON.stringify(cursorPayload), 'utf8').toString('base64url')
    const tampered = await call(baseUrl, '/api/v1/data/stored/search', {
      method: 'POST',
      headers: { ...authorization, 'idempotency-key': 'stored-cursor-tamper' },
      body: { ...body, cursor: tamperedCursor },
    })
    assert.equal(tampered.response.status, 400)
    assert.equal(tampered.payload.error.code, 'invalid_cursor')
    assert.equal(contentCalls.length, 1)

    const second = await call(baseUrl, '/api/v1/data/stored/search', {
      method: 'POST',
      headers: { ...authorization, 'idempotency-key': 'stored-search-page-two' },
      body: { ...body, cursor: first.payload.data.pageInfo.nextCursor },
    })
    assert.equal(second.response.status, 200)
    assert.equal(second.payload.data.pageInfo.pageIndex, 2)
    assert.equal(second.payload.data.pageInfo.nextCursor, null)
    assert.deepEqual(contentCalls[1].options.cursor, {
      mode: 'postgres',
      pitId: null,
      searchAfter: ['2026-08-10T00:00:00.000Z', FIRST_ID],
      seen: 1,
    })

    const usage = await call(baseUrl, '/api/v1/usage', { headers: authorization })
    assert.equal(usage.payload.data.committed, 2)
    assert.equal(usage.payload.data.units, 2)

    const generic = await call(baseUrl, '/api/v1/data/search', {
      method: 'POST',
      headers: { ...authorization, 'idempotency-key': 'existing-search-still-upstream' },
      body: { platform: 'xiaohongshu', query: 'agent', pageSize: 1 },
    })
    assert.equal(generic.response.status, 200)
    assert.equal(upstreamCalls.length, 1)
    assert.equal(contentCalls.length, 2)
  })
})
