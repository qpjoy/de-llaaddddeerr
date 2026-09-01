import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import {
  encodeTelegramSearchCursor,
  normalizeTelegramSearchQuery,
} from '../../server/data/telegram-monitor.mjs'
import { canonicalEventTimeCursor } from '../../server/data/canonical-context.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const ADMIN_TOKEN = 'canonical-timeline-admin-token'
const PEPPER = 'canonical-timeline-test-pepper-with-enough-entropy'
const ANCHOR_ID = '40000000-0000-4000-8000-000000000004'
const OTHER_ANCHOR_ID = '90000000-0000-4000-8000-000000000009'
const DATASET_ID = 'telegram.monitor.messages.v1'
const CHAT_ID = '-100700'

function messageRow(sequence, overrides = {}) {
  const suffix = String(sequence).padStart(12, '0')
  const minute = String(sequence).padStart(2, '0')
  return {
    side: 'current',
    id: `40000000-0000-4000-8000-${suffix}`,
    dataset_id: DATASET_ID,
    platform: 'telegram',
    object_type: 'message',
    content_type: 'text',
    external_id: `${CHAT_ID}:${sequence}`,
    url: null,
    title: 'Public Telegram chat',
    body: `message-${sequence}`,
    author_external_id: `user-${sequence}`,
    author_name: `Author ${sequence}`,
    event_time: `2026-08-24T10:${minute}:00.000Z`,
    collected_at: `2026-08-24T11:${minute}:00.000Z`,
    context_id: CHAT_ID,
    stable_fields: {
      attributes: { username: `public-${sequence}`, privateToken: 'private-attribute-sentinel' },
      metrics: { views: sequence, privateCounter: 999 },
      relations: { chatId: CHAT_ID, messageId: String(sequence), privateRelation: 'hidden' },
    },
    raw_payload: { secret: 'raw-payload-sentinel' },
    extensions: { secret: 'extensions-sentinel' },
    lineage: { source: 'lineage-sentinel' },
    ...overrides,
  }
}

function compareBoundary(row, boundary) {
  return canonicalEventTimeCursor(row.event_time).localeCompare(boundary.eventTime)
    || row.id.localeCompare(boundary.id)
}

function timelineDataStore(store) {
  const rows = Array.from({ length: 7 }, (_, index) => messageRow(index + 1))
  const state = {
    anchorAvailable: true,
    contextResult: null,
    indexReady: true,
    indexThrows: false,
  }
  const contextCalls = []
  const pageCalls = []

  store.getCanonicalContextServingIndexStatus = async () => {
    if (state.indexThrows) throw new Error('index catalog unavailable')
    return {
      ready: state.indexReady,
      missing: state.indexReady ? [] : ['canonical_monitor_tg_messages_chat_time_idx'],
    }
  }
  store.getCanonicalContext = async (input) => {
    contextCalls.push(structuredClone(input))
    if (state.contextResult) return structuredClone(state.contextResult)
    if (!state.anchorAvailable || input.id !== ANCHOR_ID) return null
    const anchorIndex = rows.findIndex((row) => row.id === ANCHOR_ID)
    const beforeCandidates = rows.slice(0, anchorIndex)
    const afterCandidates = rows.slice(anchorIndex + 1)
    return {
      current: { ...structuredClone(rows[anchorIndex]), side: 'current' },
      before: structuredClone(beforeCandidates.slice(-input.before)).map((row) => ({ ...row, side: 'before' })),
      after: structuredClone(afterCandidates.slice(0, input.after)).map((row) => ({ ...row, side: 'after' })),
      hasMoreStoredBefore: beforeCandidates.length > input.before,
      hasMoreStoredAfter: afterCandidates.length > input.after,
      contextSupported: true,
    }
  }
  store.getCanonicalTimelinePage = async (input) => {
    pageCalls.push(structuredClone(input))
    assert.equal(input.datasetId, DATASET_ID)
    assert.equal(input.contextId, CHAT_ID)
    const candidates = rows.filter((row) => {
      const comparison = compareBoundary(row, input.boundary)
      return input.direction === 'older' ? comparison < 0 : comparison > 0
    })
    const selected = input.direction === 'older'
      ? candidates.slice(-input.pageSize)
      : candidates.slice(0, input.pageSize)
    return {
      items: structuredClone(selected),
      hasMore: candidates.length > selected.length,
    }
  }

  return { rows, state, contextCalls, pageCalls }
}

async function withServer(app, run) {
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function call(baseUrl, path, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, { headers })
  return { response, payload: await response.json() }
}

async function post(baseUrl, path, { headers = {}, body }) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { response, payload: await response.json() }
}

async function timelineFixture({ maxPageSize = 50 } = {}) {
  const store = new MemoryStore()
  store.listCanonicalRecords = async () => []
  const data = timelineDataStore(store)
  const reservations = []
  const commits = []
  const reserve = store.reserve.bind(store)
  const commitRequest = store.commitRequest.bind(store)
  store.reserve = async (input) => {
    reservations.push(structuredClone(input))
    return reserve(input)
  }
  store.commitRequest = async (requestId, input) => {
    commits.push(structuredClone(input))
    return commitRequest(requestId, input)
  }

  let identityCalls = 0
  const identity = {
    enabled: true,
    async resolve() {
      identityCalls += 1
      throw new Error('public timeline called Launcher identity')
    },
    client: {
      async signIn() {
        identityCalls += 1
        throw new Error('public timeline called Launcher sign-in')
      },
    },
  }
  let upstreamCalls = 0
  const adapter = {
    async search() {
      upstreamCalls += 1
      throw new Error('public timeline called an upstream adapter')
    },
    async capabilities() { return { data: { platforms: [] } } },
    async dependencies() { return { status: 'up' } },
  }
  const searchCalls = []
  const searchQueries = {
    async searchContent(query, options) {
      searchCalls.push({ query, options: structuredClone(options) })
      const anchor = data.rows[3]
      return {
        mode: 'postgres',
        hasMore: false,
        nextCursor: null,
        items: [{
          id: anchor.id,
          datasetId: anchor.dataset_id,
          platform: anchor.platform,
          objectType: anchor.object_type,
          contentType: anchor.content_type,
          externalId: anchor.external_id,
          url: anchor.url,
          title: anchor.title,
          body: anchor.body,
          authorExternalId: anchor.author_external_id,
          authorName: anchor.author_name,
          eventTime: anchor.event_time,
          collectedAt: anchor.collected_at,
          metrics: anchor.stable_fields.metrics,
        }],
      }
    },
  }
  const service = new HubService({ store, adapter, apiKeyPepper: PEPPER, searchQueries })
  const tenant = await service.createTenant({ name: 'Canonical timeline tenant' })
  const granted = await service.createConsumer({ tenantId: tenant.id, name: 'Timeline consumer A' })
  const grantedKey = await service.createApiKey({ consumerId: granted.id, name: 'Timeline key A' })
  await service.putPlatformConfiguration('telegram', {
    tenantId: tenant.id,
    consumerId: granted.id,
    enabled: true,
    maxRequests: 1_000,
    windowSeconds: 60,
    maxPageSize,
  })

  const otherGranted = await service.createConsumer({ tenantId: tenant.id, name: 'Timeline consumer B' })
  const otherGrantedKey = await service.createApiKey({ consumerId: otherGranted.id, name: 'Timeline key B' })
  await service.putPlatformConfiguration('telegram', {
    tenantId: tenant.id,
    consumerId: otherGranted.id,
    enabled: true,
    maxRequests: 1_000,
    windowSeconds: 60,
    maxPageSize,
  })

  const denied = await service.createConsumer({ tenantId: tenant.id, name: 'Timeline denied consumer' })
  const deniedKey = await service.createApiKey({ consumerId: denied.id, name: 'Timeline denied key' })
  const app = createApp({ service, store, adapter, identity, adminToken: ADMIN_TOKEN, logger: { error() {} } })
  return {
    app,
    store,
    data,
    reservations,
    commits,
    granted,
    grantedKey,
    otherGranted,
    otherGrantedKey,
    deniedKey,
    identityCalls: () => identityCalls,
    upstreamCalls: () => upstreamCalls,
    searchCalls,
  }
}

function timelinePath(anchorId = ANCHOR_ID, query = '') {
  return `/api/v1/data/canonical/items/${anchorId}/timeline${query ? `?${query}` : ''}`
}

function authorization(key) {
  return { authorization: `Bearer ${key.secret}` }
}

function cursorQuery(cursor, extra = '') {
  return `cursor=${encodeURIComponent(cursor)}${extra}`
}

function assertNoPrivateProjection(value) {
  const forbiddenKeys = new Set([
    'extensions', 'lineage', 'raw', 'rawPayload', 'raw_payload', 'stableFields', 'stable_fields',
  ])
  const visit = (candidate) => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit)
      return
    }
    if (!candidate || typeof candidate !== 'object') return
    for (const [key, nested] of Object.entries(candidate)) {
      assert.equal(forbiddenKeys.has(key), false, `public timeline leaked private field ${key}`)
      visit(nested)
    }
  }
  visit(value)
  const serialized = JSON.stringify(value)
  for (const sentinel of [
    'raw-payload-sentinel',
    'extensions-sentinel',
    'lineage-sentinel',
    'private-attribute-sentinel',
    'privateCounter',
    'privateRelation',
  ]) {
    assert.equal(serialized.includes(sentinel), false, `public timeline leaked ${sentinel}`)
  }
}

function tamperCursorDirection(cursor) {
  const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  const flip = (value) => {
    if (!value || typeof value !== 'object') return false
    for (const key of Object.keys(value)) {
      if (value[key] === 'older' || value[key] === 'newer') {
        value[key] = value[key] === 'older' ? 'newer' : 'older'
        return true
      }
      if (flip(value[key])) return true
    }
    return false
  }
  assert.equal(flip(parsed), true, 'timeline cursor must carry its direction')
  return Buffer.from(JSON.stringify(parsed), 'utf8').toString('base64url')
}

function telegramSearchCursor() {
  const query = normalizeTelegramSearchQuery({
    query: 'message',
    scope: 'messages',
    sourceScope: 'monitor',
    pageSize: 2,
  }, 50, PEPPER)
  return encodeTelegramSearchCursor({
    mode: 'postgres',
    pitId: null,
    searchAfter: ['2026-08-24T10:04:00.000Z', ANCHOR_ID],
    seen: 2,
    analysisState: null,
  }, query.cursorBinding, PEPPER)
}

test('public canonical timeline requires an API key and Telegram grant, meters safe local rows, and never calls Launcher or upstream', async () => {
  const fixture = await timelineFixture()
  await withServer(fixture.app, async (baseUrl) => {
    const noKey = await call(baseUrl, timelinePath())
    assert.equal(noKey.response.status, 401)
    assert.equal(noKey.payload.error.code, 'api_key_required')

    const noGrant = await call(baseUrl, timelinePath(), authorization(fixture.deniedKey))
    assert.equal(noGrant.response.status, 403)
    assert.equal(noGrant.payload.error.code, 'platform_not_granted')
    assert.equal(fixture.data.contextCalls.length, 0)

    const capabilities = await call(
      baseUrl,
      '/api/v1/data/capabilities',
      authorization(fixture.grantedKey),
    )
    assert.equal(capabilities.response.status, 200)
    const telegram = capabilities.payload.data.platforms.find((platform) => platform.platform === 'telegram')
    assert.ok(telegram, JSON.stringify(capabilities.payload))
    assert.equal(telegram.capabilities.includes('message_timeline'), true)
    assert.equal(telegram.timeline.contractVersion, 'mx-insight-hub.canonical-timeline.v1')
    assert.equal(telegram.timeline.ready, true)

    const result = await call(
      baseUrl,
      timelinePath(ANCHOR_ID, 'before=1&after=1'),
      authorization(fixture.grantedKey),
    )
    assert.equal(result.response.status, 200)
    assert.equal(result.payload.data.contractVersion, 'mx-insight-hub.canonical-timeline.v1')
    assert.equal(result.payload.data.consistency, 'live-keyset')
    assert.equal(result.payload.data.source, 'hub')
    assert.equal(result.payload.data.anchorId, ANCHOR_ID)
    assert.equal(result.payload.data.anchorIndex, 1)
    assert.deepEqual(result.payload.data.items.map((item) => item.id), [
      fixture.data.rows[2].id,
      fixture.data.rows[3].id,
      fixture.data.rows[4].id,
    ])
    assert.deepEqual(result.payload.data.items.map((item) => item.text), [
      'message-3',
      'message-4',
      'message-5',
    ])
    assert.deepEqual(result.payload.data.stream, {
      platform: 'telegram',
      datasetId: DATASET_ID,
      objectType: 'message',
      type: 'chat',
      id: CHAT_ID,
    })
    assert.equal(result.payload.data.pageInfo.returnedCount, 3)
    assert.equal(result.payload.data.pageInfo.mode, 'initial')
    assert.equal(result.payload.data.pageInfo.direction, null)
    assert.equal(typeof result.payload.data.pageInfo.older.cursor, 'string')
    assert.equal(typeof result.payload.data.pageInfo.newer.cursor, 'string')
    assertNoPrivateProjection(result.payload.data)

    assert.equal(fixture.reservations.length, 1)
    assert.equal(fixture.reservations[0].platform, 'telegram')
    assert.equal(fixture.reservations[0].capability, undefined)
    assert.equal(fixture.commits.length, 1)
    assert.equal(fixture.commits[0].unitsActual, 3)
    assert.equal(fixture.commits[0].responseBody, null)
    assert.equal(fixture.identityCalls(), 0)
    assert.equal(fixture.upstreamCalls(), 0)
  })
})

test('a Telegram search canonicalId opens a timeline and its returned cursors continue both sides', async () => {
  const fixture = await timelineFixture()
  await withServer(fixture.app, async (baseUrl) => {
    const headers = authorization(fixture.grantedKey)
    const search = await post(baseUrl, '/api/v1/data/telegram/search', {
      headers: { ...headers, 'idempotency-key': 'timeline-search-anchor-0001' },
      body: {
        query: 'message-4',
        scope: 'messages',
        sourceScope: 'monitor',
        chatId: CHAT_ID,
        pageSize: 1,
      },
    })
    assert.equal(search.response.status, 200)
    assert.equal(search.payload.data.items.length, 1)
    const anchorId = search.payload.data.items[0].canonicalId
    assert.equal(anchorId, ANCHOR_ID)
    assert.deepEqual(fixture.searchCalls, [{
      query: 'message-4',
      options: {
        platform: 'telegram',
        datasetIds: [DATASET_ID],
        objectType: 'message',
        authorExternalId: null,
        chatId: CHAT_ID,
        fromTime: null,
        toTime: null,
        size: 1,
        cursor: null,
      },
    }])

    const initial = await call(
      baseUrl,
      timelinePath(anchorId, 'before=1&after=1'),
      headers,
    )
    assert.equal(initial.response.status, 200)
    assert.equal(initial.payload.data.anchorId, anchorId)
    assert.deepEqual(initial.payload.data.items.map((item) => item.id), fixture.data.rows.slice(2, 5).map((row) => row.id))

    const older = await call(
      baseUrl,
      timelinePath(anchorId, cursorQuery(initial.payload.data.pageInfo.older.cursor)),
      headers,
    )
    const newer = await call(
      baseUrl,
      timelinePath(anchorId, cursorQuery(initial.payload.data.pageInfo.newer.cursor)),
      headers,
    )
    assert.equal(older.response.status, 200)
    assert.equal(newer.response.status, 200)
    assert.deepEqual(older.payload.data.items.map((item) => item.id), [fixture.data.rows[1].id])
    assert.deepEqual(newer.payload.data.items.map((item) => item.id), [fixture.data.rows[5].id])
    assert.equal(fixture.upstreamCalls(), 0)
  })
})

test('canonical timeline cursors traverse both directions exclusively without gaps or duplicates and keep a pollable newer edge', async () => {
  const fixture = await timelineFixture()
  await withServer(fixture.app, async (baseUrl) => {
    const headers = authorization(fixture.grantedKey)
    const initial = await call(baseUrl, timelinePath(ANCHOR_ID, 'before=2&after=1'), headers)
    assert.equal(initial.response.status, 200)
    assert.equal(initial.payload.data.anchorIndex, 2)
    assert.deepEqual(initial.payload.data.items.map((item) => item.id), fixture.data.rows.slice(1, 5).map((row) => row.id))
    assert.equal(initial.payload.data.pageInfo.direction, null)
    assert.equal(initial.payload.data.pageInfo.older.hasMore, true)
    assert.equal(initial.payload.data.pageInfo.newer.hasMore, true)

    const olderCursor = initial.payload.data.pageInfo.older.cursor
    const newerCursor = initial.payload.data.pageInfo.newer.cursor
    const older = await call(baseUrl, timelinePath(ANCHOR_ID, cursorQuery(olderCursor)), headers)
    assert.equal(older.response.status, 200)
    assert.equal(older.payload.data.anchorIndex, null)
    assert.equal(older.payload.data.pageInfo.mode, 'continuation')
    assert.equal(older.payload.data.pageInfo.direction, 'older')
    assert.deepEqual(older.payload.data.items.map((item) => item.id), [fixture.data.rows[0].id])
    assert.deepEqual(older.payload.data.pageInfo.older, { hasMore: false, cursor: null })
    assert.equal(older.payload.data.pageInfo.newer, null)

    const newer = await call(baseUrl, timelinePath(ANCHOR_ID, cursorQuery(newerCursor)), headers)
    assert.equal(newer.response.status, 200)
    assert.equal(newer.payload.data.anchorIndex, null)
    assert.equal(newer.payload.data.pageInfo.mode, 'continuation')
    assert.equal(newer.payload.data.pageInfo.direction, 'newer')
    assert.deepEqual(newer.payload.data.items.map((item) => item.id), [fixture.data.rows[5].id])
    assert.equal(newer.payload.data.pageInfo.older, null)
    assert.equal(newer.payload.data.pageInfo.newer.hasMore, true)
    assert.equal(typeof newer.payload.data.pageInfo.newer.cursor, 'string')

    const newest = await call(
      baseUrl,
      timelinePath(ANCHOR_ID, cursorQuery(newer.payload.data.pageInfo.newer.cursor)),
      headers,
    )
    assert.equal(newest.response.status, 200)
    assert.deepEqual(newest.payload.data.items.map((item) => item.id), [fixture.data.rows[6].id])
    assert.equal(newest.payload.data.pageInfo.newer.hasMore, false)
    assert.equal(typeof newest.payload.data.pageInfo.newer.cursor, 'string')

    const emptyPoll = await call(
      baseUrl,
      timelinePath(ANCHOR_ID, cursorQuery(newest.payload.data.pageInfo.newer.cursor)),
      headers,
    )
    assert.equal(emptyPoll.response.status, 200)
    assert.deepEqual(emptyPoll.payload.data.items, [])
    assert.equal(emptyPoll.payload.data.pageInfo.newer.hasMore, false)
    assert.equal(emptyPoll.payload.data.pageInfo.newer.cursor, newest.payload.data.pageInfo.newer.cursor)

    const combined = [
      ...older.payload.data.items,
      ...initial.payload.data.items,
      ...newer.payload.data.items,
      ...newest.payload.data.items,
    ].map((item) => item.id)
    assert.deepEqual(combined, fixture.data.rows.map((row) => row.id))
    assert.equal(new Set(combined).size, combined.length)
    assert.deepEqual(fixture.data.pageCalls.map((input) => ({
      direction: input.direction,
      boundary: input.boundary,
      pageSize: input.pageSize,
    })), [
      {
        direction: 'older',
        boundary: {
          eventTime: canonicalEventTimeCursor(fixture.data.rows[1].event_time),
          id: fixture.data.rows[1].id,
        },
        pageSize: 2,
      },
      {
        direction: 'newer',
        boundary: {
          eventTime: canonicalEventTimeCursor(fixture.data.rows[4].event_time),
          id: fixture.data.rows[4].id,
        },
        pageSize: 1,
      },
      {
        direction: 'newer',
        boundary: {
          eventTime: canonicalEventTimeCursor(fixture.data.rows[5].event_time),
          id: fixture.data.rows[5].id,
        },
        pageSize: 1,
      },
      {
        direction: 'newer',
        boundary: {
          eventTime: canonicalEventTimeCursor(fixture.data.rows[6].event_time),
          id: fixture.data.rows[6].id,
        },
        pageSize: 1,
      },
    ])
  })
})

test('timeline cursors reject tampering, path or authorization changes, search-cursor confusion, duplicate cursors, and query overrides', async () => {
  const fixture = await timelineFixture({ maxPageSize: 2 })
  await withServer(fixture.app, async (baseUrl) => {
    const headers = authorization(fixture.grantedKey)
    const initial = await call(baseUrl, timelinePath(ANCHOR_ID, 'before=2&after=1'), headers)
    assert.equal(initial.response.status, 200)
    const cursor = initial.payload.data.pageInfo.older.cursor
    const pageCallsBeforeRejections = fixture.data.pageCalls.length

    const cases = [
      {
        name: 'different path anchor',
        path: timelinePath(OTHER_ANCHOR_ID, cursorQuery(cursor)),
        headers,
        code: 'invalid_cursor',
      },
      {
        name: 'different granted consumer',
        path: timelinePath(ANCHOR_ID, cursorQuery(cursor)),
        headers: authorization(fixture.otherGrantedKey),
        code: 'invalid_cursor',
      },
      {
        name: 'tampered direction',
        path: timelinePath(ANCHOR_ID, cursorQuery(tamperCursorDirection(cursor))),
        headers,
        code: 'invalid_cursor',
      },
      {
        name: 'Telegram search cursor',
        path: timelinePath(ANCHOR_ID, cursorQuery(telegramSearchCursor())),
        headers,
        code: 'invalid_cursor',
      },
      {
        name: 'cursor mixed with first-page before',
        path: timelinePath(ANCHOR_ID, cursorQuery(cursor, '&before=1')),
        headers,
        code: 'invalid_request',
      },
      {
        name: 'cursor mixed with first-page after',
        path: timelinePath(ANCHOR_ID, cursorQuery(cursor, '&after=1')),
        headers,
        code: 'invalid_request',
      },
      {
        name: 'cursor page-size override',
        path: timelinePath(ANCHOR_ID, cursorQuery(cursor, '&pageSize=1')),
        headers,
        code: 'unsupported_fields',
      },
      {
        name: 'cursor query override',
        path: timelinePath(ANCHOR_ID, cursorQuery(cursor, '&query=message')),
        headers,
        code: 'unsupported_fields',
      },
      {
        name: 'two direction-specific cursor fields',
        path: timelinePath(
          ANCHOR_ID,
          `olderCursor=${encodeURIComponent(cursor)}&newerCursor=${encodeURIComponent(cursor)}`,
        ),
        headers,
        code: 'unsupported_fields',
      },
      {
        name: 'duplicate cursor parameters',
        path: timelinePath(
          ANCHOR_ID,
          `cursor=${encodeURIComponent(cursor)}&cursor=${encodeURIComponent(cursor)}`,
        ),
        headers,
        code: 'invalid_request',
      },
      {
        name: 'unknown field',
        path: timelinePath(ANCHOR_ID, 'includeRaw=true'),
        headers,
        code: 'unsupported_fields',
      },
      {
        name: 'explicit empty initial window',
        path: timelinePath(ANCHOR_ID, 'before='),
        headers,
        code: 'invalid_request',
      },
      {
        name: 'initial window above granted page policy',
        path: timelinePath(ANCHOR_ID, 'before=3&after=1'),
        headers,
        code: 'page_size_exceeded',
      },
    ]

    for (const candidate of cases) {
      const result = await call(baseUrl, candidate.path, candidate.headers)
      assert.equal(result.response.status, 400, candidate.name)
      assert.equal(result.payload.error.code, candidate.code, candidate.name)
    }
    assert.equal(fixture.data.pageCalls.length, pageCallsBeforeRejections)
  })
})

test('a token-contained continuation survives anchor deletion while unsupported datasets and missing indexes fail closed', async () => {
  const fixture = await timelineFixture()
  await withServer(fixture.app, async (baseUrl) => {
    const headers = authorization(fixture.grantedKey)
    const initial = await call(baseUrl, timelinePath(ANCHOR_ID, 'before=2&after=1'), headers)
    assert.equal(initial.response.status, 200)
    const olderCursor = initial.payload.data.pageInfo.older.cursor
    const contextCalls = fixture.data.contextCalls.length

    fixture.data.state.anchorAvailable = false
    const continuation = await call(
      baseUrl,
      timelinePath(ANCHOR_ID, cursorQuery(olderCursor)),
      headers,
    )
    assert.equal(continuation.response.status, 200)
    assert.deepEqual(continuation.payload.data.items.map((item) => item.id), [fixture.data.rows[0].id])
    assert.equal(fixture.data.contextCalls.length, contextCalls)

    fixture.data.state.indexReady = false
    const missingIndex = await call(
      baseUrl,
      timelinePath(ANCHOR_ID, cursorQuery(olderCursor)),
      headers,
    )
    assert.equal(missingIndex.response.status, 503)
    assert.equal(missingIndex.payload.error.code, 'serving_indexes_unavailable')
    assert.equal(JSON.stringify(missingIndex.payload).includes('canonical_monitor_tg_messages'), false)

    fixture.data.state.indexReady = true
    const deletedInitial = await call(baseUrl, timelinePath(), headers)
    assert.equal(deletedInitial.response.status, 404)
    assert.equal(deletedInitial.payload.error.code, 'item_not_found')

    fixture.data.state.anchorAvailable = true
    fixture.data.state.contextResult = {
      current: messageRow(4, {
        dataset_id: 'telegram.future.messages.v1',
        context_id: 'future-chat',
      }),
      before: [],
      after: [],
      hasMoreStoredBefore: false,
      hasMoreStoredAfter: false,
      contextSupported: false,
    }
    const unsupported = await call(baseUrl, timelinePath(), headers)
    assert.equal(unsupported.response.status, 409)
    assert.equal(unsupported.payload.error.code, 'context_not_supported')
  })
})
