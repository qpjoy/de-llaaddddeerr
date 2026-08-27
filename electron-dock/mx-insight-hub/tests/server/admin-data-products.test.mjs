import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, test } from 'node:test'
import { createApp } from '../../server/app.mjs'
import {
  adminPublicOpinionItemResponse,
  adminTelegramChat,
  adminTelegramMessage,
  adminTelegramMessagesResponse,
  normalizeAdminTelegramContextQuery,
  normalizeAdminTelegramHistoryQuery,
} from '../../server/data/admin-data-products.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

const ADMIN_TOKEN = 'admin-data-products-token-with-enough-length'
const PEPPER = 'admin-data-products-test-pepper-with-enough-entropy'
const quiet = { error() {} }

let baseUrl
let server
let store

async function request(path, {
  token,
  method = 'GET',
  body,
} = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { response, payload: await response.json() }
}

before(async () => {
  store = new MemoryStore()
  const adapter = { dependencies: async () => ({ status: 'up' }) }
  const service = new HubService({ store, adapter, apiKeyPepper: PEPPER, logger: quiet })
  const identity = {
    enabled: true,
    async resolve(token) {
      return {
        kind: token === 'launcher-platform-admin' ? 'launcher-admin' : 'launcher-user',
        memberId: token,
        displayName: token,
        platformAdmin: token === 'launcher-platform-admin',
        tenantIds: null,
        capabilities: [],
        memberships: [],
      }
    },
  }
  server = createServer(createApp({
    service,
    store,
    adapter,
    identity,
    adminToken: ADMIN_TOKEN,
    logger: quiet,
  }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
})

test('Admin data-product routes require the break-glass admin token', async () => {
  const path = '/internal/v1/admin/data-products/telegram/chats?kind=channel'

  const anonymous = await request(path)
  assert.equal(anonymous.response.status, 401)
  assert.equal(anonymous.payload.error.code, 'admin_auth_required')

  for (const token of ['launcher-user', 'launcher-platform-admin', 'mih_live_customer_key']) {
    const launcher = await request(path, { token })
    assert.equal(launcher.response.status, 403)
    assert.equal(launcher.payload.error.code, 'admin_token_required')
  }

  const admin = await request(path, { token: ADMIN_TOKEN })
  assert.equal(admin.response.status, 200)
  assert.equal(admin.payload.data.demoMode, true)
  assert.equal(admin.payload.data.contractVersion, 'mx-insight-hub.admin-data-products.telegram-chats.v2')
})

test('every Admin data-product route rejects a Launcher platform admin', async () => {
  const routes = [
    { path: '/internal/v1/admin/data-products/telegram/chats?kind=channel' },
    { path: '/internal/v1/admin/data-products/telegram/chats/-1001001/messages' },
    {
      path: '/internal/v1/admin/data-products/telegram/search',
      method: 'POST',
      body: { query: 'data' },
    },
    { path: '/internal/v1/admin/data-products/telegram/items/20000000-0000-4000-8000-000000000001/context' },
    { path: '/internal/v1/admin/data-products/public-opinion/regions' },
    { path: '/internal/v1/admin/data-products/public-opinion/province-coverage' },
    { path: '/internal/v1/admin/data-products/public-opinion/funnel' },
    { path: '/internal/v1/admin/data-products/public-opinion/records' },
    { path: '/internal/v1/admin/data-products/public-opinion/records/30000000-0000-4000-8000-000000000004' },
    { path: '/internal/v1/admin/data-products/public-opinion/provinces/CN-JS/items' },
    { path: '/internal/v1/admin/data-products/public-opinion/items/30000000-0000-4000-8000-000000000001' },
  ]

  for (const route of routes) {
    const result = await request(route.path, {
      token: 'launcher-platform-admin',
      method: route.method,
      body: route.body,
    })
    assert.equal(result.response.status, 403, route.path)
    assert.equal(result.payload.error.code, 'admin_token_required', route.path)
  }
})

test('Memory Admin facade exposes all internal Telegram rows with source and type evidence', async () => {
  const channel = await request(
    '/internal/v1/admin/data-products/telegram/chats?kind=channel',
    { token: ADMIN_TOKEN },
  )
  assert.equal(channel.response.status, 200)
  assert.ok(channel.payload.data.items.length >= 3)
  assert.ok(channel.payload.data.items.every((item) => item.kind === 'channel'))
  assert.ok(channel.payload.data.items.some((item) => item.sourceScope === 'sqlite'))

  const group = await request(
    '/internal/v1/admin/data-products/telegram/chats?kind=group',
    { token: ADMIN_TOKEN },
  )
  assert.equal(group.response.status, 200)
  assert.equal(group.payload.data.items.length, 2)
  assert.ok(group.payload.data.items.every((item) => item.kind === 'group'))
  assert.ok(group.payload.data.items.some((item) => item.url?.includes('/+')))
  assert.ok(group.payload.data.items.some((item) => item.visibilityEvidence.urlKind === 'invite-link'))

  const unknown = await request(
    '/internal/v1/admin/data-products/telegram/chats?kind=unknown',
    { token: ADMIN_TOKEN },
  )
  assert.equal(unknown.response.status, 200)
  assert.equal(unknown.payload.data.items.length, 2)
  assert.ok(unknown.payload.data.items.every((item) => item.kind === 'unknown'))
  assert.ok(unknown.payload.data.items.every((item) => item.rawKind === 'private'))
  assert.equal(channel.payload.data.demoMode, true)
  assert.equal(group.payload.data.demoMode, true)

  const serialized = JSON.stringify([channel.payload, group.payload, unknown.payload])
  assert.doesNotMatch(serialized, /demo-private|password|credential|must-not-leak/i)
  assert.deepEqual(channel.payload.data.sourceScope, {
    mode: 'internal-mixed',
    datasets: [
      'telegram.monitor.chats.v1', 'telegram.monitor.messages.v1',
      'telegram.sqlite.chats.v1', 'telegram.sqlite.messages.v1',
    ],
    selected: 'all',
  })
})

test('Telegram sourceScope switches monitor, SQLite and mixed internal records', async () => {
  const monitor = await request(
    '/internal/v1/admin/data-products/telegram/chats?sourceScope=monitor',
    { token: ADMIN_TOKEN },
  )
  const sqlite = await request(
    '/internal/v1/admin/data-products/telegram/chats?sourceScope=sqlite',
    { token: ADMIN_TOKEN },
  )
  const all = await request(
    '/internal/v1/admin/data-products/telegram/chats?sourceScope=all',
    { token: ADMIN_TOKEN },
  )
  assert.ok(monitor.payload.data.items.every((item) => item.sourceScope === 'monitor'))
  assert.ok(sqlite.payload.data.items.every((item) => item.sourceScope === 'sqlite'))
  assert.equal(
    all.payload.data.items.length,
    monitor.payload.data.items.length + sqlite.payload.data.items.length,
  )
  assert.equal(new Set(all.payload.data.items.map((item) => item.canonicalId)).size, all.payload.data.items.length)

  const sqliteChat = sqlite.payload.data.items.find((item) => item.externalId === '-1001001')
  const mixedHistory = await request(
    `/internal/v1/admin/data-products/telegram/chats/${encodeURIComponent(sqliteChat.chatKey)}/messages?sourceScope=all`,
    { token: ADMIN_TOKEN },
  )
  assert.equal(mixedHistory.response.status, 200)
  assert.equal(mixedHistory.payload.data.chat.canonicalId, sqliteChat.canonicalId)
  assert.ok(mixedHistory.payload.data.items.some((item) => item.sourceScope === 'monitor'))
  assert.ok(mixedHistory.payload.data.items.some((item) => item.sourceScope === 'sqlite'))
  assert.equal(
    new Set(mixedHistory.payload.data.items.map((item) => item.canonicalId)).size,
    mixedHistory.payload.data.items.length,
  )

  const invalidScope = await request(
    '/internal/v1/admin/data-products/telegram/chats?sourceScope=public',
    { token: ADMIN_TOKEN },
  )
  assert.equal(invalidScope.response.status, 400)
  const invalidKind = await request(
    '/internal/v1/admin/data-products/telegram/chats?kind=private',
    { token: ADMIN_TOKEN },
  )
  assert.equal(invalidKind.response.status, 400)
  const scopeMismatch = await request(
    `/internal/v1/admin/data-products/telegram/chats/${encodeURIComponent(sqliteChat.chatKey)}/messages?sourceScope=monitor`,
    { token: ADMIN_TOKEN },
  )
  assert.equal(scopeMismatch.response.status, 400)
  assert.equal(scopeMismatch.payload.error.code, 'source_scope_mismatch')
})

test('Admin data-product reads do not reserve customer usage and do not change public API authentication', async () => {
  const before = await store.usage({})

  const telegram = await request(
    '/internal/v1/admin/data-products/telegram/chats?kind=channel',
    { token: ADMIN_TOKEN },
  )
  const opinion = await request(
    '/internal/v1/admin/data-products/public-opinion/provinces/CN-JS/items',
    { token: ADMIN_TOKEN },
  )
  assert.equal(telegram.response.status, 200)
  assert.equal(opinion.response.status, 200)
  assert.deepEqual(await store.usage({}), before)

  const publicApi = await request('/api/v1/data/telegram/chats', { token: ADMIN_TOKEN })
  assert.equal(publicApi.response.status, 401)
  assert.equal(publicApi.payload.error.code, 'invalid_api_key')
  assert.deepEqual(await store.usage({}), before)
})

test('Telegram history, search and context keep canonical ids without hiding internal chats', async () => {
  const chats = await request(
    '/internal/v1/admin/data-products/telegram/chats?kind=channel&query=科技&sourceScope=monitor',
    { token: ADMIN_TOKEN },
  )
  assert.equal(chats.response.status, 200)
  assert.equal(chats.payload.data.items.length, 1)
  const chat = chats.payload.data.items[0]

  const history = await request(
    `/internal/v1/admin/data-products/telegram/chats/${chat.canonicalId}/messages?pageSize=2`,
    { token: ADMIN_TOKEN },
  )
  assert.equal(history.response.status, 200)
  assert.equal(history.payload.data.chat.canonicalId, chat.canonicalId)
  assert.equal(history.payload.data.items.length, 2)
  assert.equal(history.payload.data.pageInfo.hasMore, true)
  assert.equal(history.payload.data.demoMode, true)
  assert.match(history.payload.data.items[0].canonicalId, /^[0-9a-f-]{36}$/i)
  assert.ok(['monitor', 'sqlite'].includes(history.payload.data.items[0].sourceScope))
  assert.match(history.payload.data.items[0].sourceDataset, /^telegram[.](monitor|sqlite)[.]messages[.]v1$/)
  assert.equal(Object.hasOwn(history.payload.data.items[0], 'lineage'), false)

  const anchorId = history.payload.data.items[0].canonicalId
  const context = await request(
    `/internal/v1/admin/data-products/telegram/items/${anchorId}/context?before=2&after=2`,
    { token: ADMIN_TOKEN },
  )
  assert.equal(context.response.status, 200)
  assert.equal(context.payload.data.anchorId, anchorId)
  assert.ok(context.payload.data.items.some((item) => item.id === anchorId))
  assert.equal(context.payload.data.stream.id, chat.externalId)
  assert.equal(context.payload.data.demoMode, true)

  const search = await request('/internal/v1/admin/data-products/telegram/search', {
    token: ADMIN_TOKEN,
    method: 'POST',
    body: { query: '数据', pageSize: 10 },
  })
  assert.equal(search.response.status, 200)
  assert.equal(search.payload.data.demoMode, true)
  assert.ok(search.payload.data.items.length >= 1)
  assert.ok(search.payload.data.items.every((item) => /^[0-9a-f-]{36}$/i.test(item.canonicalId)))
  assert.ok(search.payload.data.items.every((item) => ['monitor', 'sqlite'].includes(item.sourceScope)))
  assert.doesNotMatch(JSON.stringify(search.payload), /must-not-leak|credential|password/i)

  const privateHistory = await request(
    '/internal/v1/admin/data-products/telegram/chats/-1002998/messages',
    { token: ADMIN_TOKEN },
  )
  assert.equal(privateHistory.response.status, 200)
  assert.equal(privateHistory.payload.data.items.length, 1)

  const privateContext = await request(
    '/internal/v1/admin/data-products/telegram/items/20000000-0000-4000-8000-000000000007/context?before=1&after=1',
    { token: ADMIN_TOKEN },
  )
  assert.equal(privateContext.response.status, 200)

  const privateSearch = await request('/internal/v1/admin/data-products/telegram/search', {
    token: ADMIN_TOKEN,
    method: 'POST',
    body: { query: '消息', chatId: '-1002998' },
  })
  assert.equal(privateSearch.response.status, 200)
  assert.equal(privateSearch.payload.data.items.length, 1)
})

test('Telegram cursors and before/after context are deterministic and do not duplicate records', async () => {
  const firstChatPage = await request(
    '/internal/v1/admin/data-products/telegram/chats?kind=channel&pageSize=1',
    { token: ADMIN_TOKEN },
  )
  assert.equal(firstChatPage.response.status, 200)
  assert.equal(firstChatPage.payload.data.items.length, 1)
  assert.equal(firstChatPage.payload.data.pageInfo.hasMore, true)
  assert.ok(firstChatPage.payload.data.pageInfo.nextCursor)
  const secondChatPage = await request(
    `/internal/v1/admin/data-products/telegram/chats?kind=channel&pageSize=1&cursor=${encodeURIComponent(firstChatPage.payload.data.pageInfo.nextCursor)}`,
    { token: ADMIN_TOKEN },
  )
  assert.equal(secondChatPage.response.status, 200)
  assert.notEqual(
    secondChatPage.payload.data.items[0].canonicalId,
    firstChatPage.payload.data.items[0].canonicalId,
  )

  const chatId = '10000000-0000-4000-8000-000000000001'
  const historyIds = []
  let historyCursor = null
  for (let page = 0; page < 5; page += 1) {
    const result = await request(
      `/internal/v1/admin/data-products/telegram/chats/${chatId}/messages?pageSize=1${historyCursor ? `&cursor=${encodeURIComponent(historyCursor)}` : ''}`,
      { token: ADMIN_TOKEN },
    )
    assert.equal(result.response.status, 200)
    historyIds.push(...result.payload.data.items.map((item) => item.canonicalId))
    historyCursor = result.payload.data.pageInfo.nextCursor
    if (!historyCursor) break
  }
  assert.equal(historyIds.length, 4)
  assert.equal(new Set(historyIds).size, historyIds.length)

  const searchIds = []
  let searchCursor = null
  for (let page = 0; page < 5; page += 1) {
    const result = await request('/internal/v1/admin/data-products/telegram/search', {
      token: ADMIN_TOKEN,
      method: 'POST',
      body: { query: '数据', pageSize: 1, ...(searchCursor ? { cursor: searchCursor } : {}) },
    })
    assert.equal(result.response.status, 200)
    searchIds.push(...result.payload.data.items.map((item) => item.canonicalId))
    searchCursor = result.payload.data.pageInfo.nextCursor
    if (!searchCursor) break
  }
  assert.equal(searchIds.length, 3)
  assert.equal(new Set(searchIds).size, searchIds.length)

  const anchorSearch = await request('/internal/v1/admin/data-products/telegram/search', {
    token: ADMIN_TOKEN,
    method: 'POST',
    body: { query: '芯片', pageSize: 10 },
  })
  const anchorId = anchorSearch.payload.data.items[0].canonicalId
  const context = await request(
    `/internal/v1/admin/data-products/telegram/items/${anchorId}/context?before=1&after=1`,
    { token: ADMIN_TOKEN },
  )
  assert.equal(context.response.status, 200)
  assert.equal(context.payload.data.anchorIndex, 1)
  assert.equal(context.payload.data.storedWindow.beforeReturned, 1)
  assert.equal(context.payload.data.storedWindow.afterReturned, 1)
  assert.deepEqual(
    context.payload.data.items.map((item) => item.id),
    [
      '20000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000003',
    ],
  )

  const sqliteSearch = await request('/internal/v1/admin/data-products/telegram/search', {
    token: ADMIN_TOKEN,
    method: 'POST',
    body: { query: 'SQLite', sourceScope: 'sqlite' },
  })
  assert.equal(sqliteSearch.response.status, 200)
  assert.ok(sqliteSearch.payload.data.items.length >= 1)
  const sqliteContext = await request(
    `/internal/v1/admin/data-products/telegram/items/${sqliteSearch.payload.data.items[0].canonicalId}/context?sourceScope=sqlite`,
    { token: ADMIN_TOKEN },
  )
  assert.equal(sqliteContext.response.status, 200)
  assert.ok(sqliteContext.payload.data.items.every((item) => item.sourceScope === 'sqlite'))

  const noHit = await request('/internal/v1/admin/data-products/telegram/search', {
    token: ADMIN_TOKEN,
    method: 'POST',
    body: { query: 'definitely-no-such-public-message' },
  })
  assert.equal(noHit.response.status, 200)
  assert.deepEqual(noHit.payload.data.items, [])
  assert.equal(noHit.payload.data.pageInfo.nextCursor, null)
})

test('Telegram history pagination is independent from the bounded search context window', () => {
  const history = normalizeAdminTelegramHistoryQuery('-1001001', {})
  assert.equal(history.pageSize, 50)
  assert.equal(history.cursor, null)
  assert.equal(history.sourceScope, 'all')

  const context = normalizeAdminTelegramContextQuery(
    '20000000-0000-4000-8000-000000000001',
    {},
  )
  assert.equal(context.before, 10)
  assert.equal(context.after, 10)
  assert.equal(context.sourceScope, 'all')

  assert.throws(
    () => normalizeAdminTelegramHistoryQuery('-1001001', { pageSize: 101 }),
    (error) => error?.code === 'page_size_exceeded',
  )
})

test('Telegram Admin history returns records whose source timestamps are both null and cursors by first_seen_at', () => {
  const chat = {
    id: '41000000-0000-4000-8000-000000000001',
    dataset_id: 'telegram.sqlite.chats.v1', external_id: '-1004100',
    object_type: 'chat', content_type: 'private', title: '内部会话', url: null,
    event_time: null, collected_at: null,
    stable_fields: { attributes: { chatType: 'private' } },
  }
  const message = (id, messageId, firstSeenAt) => ({
    id, dataset_id: 'telegram.sqlite.messages.v1', external_id: `-1004100:${messageId}`,
    object_type: 'message', content_type: 'text', title: null, body: `消息 ${messageId}`,
    url: null, author_external_id: null, author_name: null,
    event_time: null, collected_at: null, first_seen_at: new Date(firstSeenAt),
    sort_time: new Date(firstSeenAt), current_revision: 1,
    stable_fields: { relations: { chatId: '-1004100', messageId: String(messageId) } },
  })
  const response = adminTelegramMessagesResponse(chat, [
    message('41000000-0000-4000-8000-000000000011', 11, '2026-08-20T00:00:00.000Z'),
    message('41000000-0000-4000-8000-000000000010', 10, '2026-08-19T00:00:00.000Z'),
  ], {
    chatId: chat.id, sourceScope: 'sqlite', pageSize: 1, cursor: null,
  })

  assert.equal(response.items.length, 1)
  assert.equal(response.items[0].eventTime, null)
  assert.equal(response.items[0].collectedAt, null)
  assert.equal(response.pageInfo.hasMore, true)
  const decoded = normalizeAdminTelegramHistoryQuery(chat.id, {
    sourceScope: 'sqlite', cursor: response.pageInfo.nextCursor,
  }).cursor
  assert.deepEqual(decoded, {
    sortTime: '2026-08-20T00:00:00.000Z',
    id: '41000000-0000-4000-8000-000000000011',
  })
})

test('public-opinion demo coverage, province feed and detail share one curated corpus', async () => {
  const regions = await request(
    '/internal/v1/admin/data-products/public-opinion/regions',
    { token: ADMIN_TOKEN },
  )
  assert.equal(regions.response.status, 200)
  assert.equal(regions.payload.data.regions.length, 34)
  assert.equal(regions.payload.data.demoMode, true)

  const coverage = await request(
    '/internal/v1/admin/data-products/public-opinion/province-coverage',
    { token: ADMIN_TOKEN },
  )
  assert.equal(coverage.response.status, 200)
  assert.equal(coverage.payload.data.provinces.length, 34)
  assert.equal(coverage.payload.data.totals.provinceCount, 34)
  assert.equal(coverage.payload.data.demoMode, true)
  const byCode = new Map(coverage.payload.data.provinces.map((entry) => [entry.province.code, entry]))
  assert.equal(byCode.get('CN-JS').availableCount, 3)
  assert.equal(byCode.get('CN-GD').availableCount, 0)
  assert.equal(byCode.get('CN-BJ').availableCount, 0)
  assert.equal(coverage.payload.data.totals.availableCount, 3)

  const jiangsu = await request(
    '/internal/v1/admin/data-products/public-opinion/provinces/CN-JS/items?pageSize=10',
    { token: ADMIN_TOKEN },
  )
  assert.equal(jiangsu.response.status, 200)
  assert.equal(jiangsu.payload.data.items.length, 3)
  assert.equal(jiangsu.payload.data.demoMode, true)

  const beijing = await request(
    '/internal/v1/admin/data-products/public-opinion/provinces/CN-BJ/items',
    { token: ADMIN_TOKEN },
  )
  assert.equal(beijing.response.status, 200)
  assert.equal(beijing.payload.data.items.length, 0)
  assert.equal(beijing.payload.data.demoMode, true)

  const detail = await request(
    `/internal/v1/admin/data-products/public-opinion/items/${jiangsu.payload.data.items[0].id}`,
    { token: ADMIN_TOKEN },
  )
  assert.equal(detail.response.status, 200)
  assert.equal(detail.payload.data.id, jiangsu.payload.data.items[0].id)
  assert.equal(detail.payload.data.demoMode, true)

  const hiddenCandidate = await request(
    '/internal/v1/admin/data-products/public-opinion/items/30000000-0000-4000-8000-000000000004',
    { token: ADMIN_TOKEN },
  )
  assert.equal(hiddenCandidate.response.status, 404)

  const candidateOverride = await request(
    '/internal/v1/admin/data-products/public-opinion/provinces/CN-GD/items?includeCandidates=all',
    { token: ADMIN_TOKEN },
  )
  assert.equal(candidateOverride.response.status, 400)
  assert.equal(candidateOverride.payload.error.code, 'unsupported_fields')
})

test('public-opinion internal funnel and browse expose non-visible rows without changing formal views', async () => {
  const funnel = await request(
    '/internal/v1/admin/data-products/public-opinion/funnel',
    { token: ADMIN_TOKEN },
  )
  assert.equal(funnel.response.status, 200)
  assert.equal(
    funnel.payload.data.canonical.active,
    funnel.payload.data.publication.withState + funnel.payload.data.publication.missingState,
  )
  assert.equal(
    funnel.payload.data.time.withEventTime,
    funnel.payload.data.time.withinWindow + funnel.payload.data.time.outsideWindow,
  )

  const excluded = await request(
    '/internal/v1/admin/data-products/public-opinion/records?reason=missing_province&pageSize=100',
    { token: ADMIN_TOKEN },
  )
  assert.equal(excluded.response.status, 200)
  assert.ok(excluded.payload.data.items.length > 0)
  assert.ok(excluded.payload.data.items.every((item) => (
    item.provinceCode === null && item.diagnostics.reasons.includes('missing_province')
  )))
  const candidate = excluded.payload.data.items.find((item) => item.sourceStage === 'candidate')
  assert.ok(candidate)

  const detail = await request(
    `/internal/v1/admin/data-products/public-opinion/records/${candidate.id}`,
    { token: ADMIN_TOKEN },
  )
  assert.equal(detail.response.status, 200)
  assert.equal(detail.payload.data.id, candidate.id)
  assert.equal(detail.payload.data.sourceStage, 'candidate')
  assert.doesNotMatch(
    JSON.stringify([funnel.payload, excluded.payload, detail.payload]),
    /credential|password|model[_A-Z]?reasoning|raw_payload|connection_string/i,
  )
})

test('a capable empty store stays non-demo and represents all 34 zero-data provinces', async () => {
  const service = new HubService({
    store: {
      async listAdminTelegramChats() { return [] },
      async listAdminPublicOpinionRecords() { return [] },
      async getAdminPublicOpinionProvinceCoverage() { return [] },
      async getAdminPublicOpinionRecord() { return null },
    },
    adapter: {},
    apiKeyPepper: PEPPER,
    logger: quiet,
  })

  const chats = await service.adminDataProductTelegramChats({ kind: 'channel' })
  assert.equal(chats.demoMode, false)
  assert.deepEqual(chats.items, [])

  const regions = await service.adminDataProductPublicOpinionRegions({})
  assert.equal(regions.demoMode, false)
  assert.equal(regions.regions.length, 34)

  const coverage = await service.adminDataProductPublicOpinionCoverage({})
  assert.equal(coverage.demoMode, false)
  assert.equal(coverage.provinces.length, 34)
  assert.ok(coverage.provinces.every((province) => province.availableCount === 0))
  assert.equal(coverage.totals.availableCount, 0)

  const province = await service.adminDataProductPublicOpinionProvince('CN-JS', {})
  assert.equal(province.demoMode, false)
  assert.deepEqual(province.items, [])
})

test('Admin Telegram projections are strict allowlists even if a store row contains secrets', () => {
  const chatRow = {
    id: '40000000-0000-4000-8000-000000000001',
    dataset_id: 'telegram.monitor.chats.v1',
    external_id: '-1004001', object_type: 'chat', content_type: 'supergroup',
    title: 'Public group', url: 'https://t.me/public_group',
    event_time: new Date('2026-08-20T00:00:00.000Z'),
    collected_at: new Date('2026-08-20T00:01:00.000Z'),
    stable_fields: {
      attributes: { chatType: 'supergroup', username: 'public_group' },
      connection: { password: 'must-not-leak' },
    },
  }
  const chat = adminTelegramChat(chatRow)
  assert.deepEqual(Object.keys(chat), [
    'canonicalId', 'chatKey', 'externalId', 'sourceDataset', 'sourceScope',
    'kind', 'rawKind', 'title', 'username', 'url', 'visibilityEvidence',
    'memberCount', 'eventTime', 'collectedAt',
  ])
  assert.equal(chat.chatKey, 'monitor:40000000-0000-4000-8000-000000000001')

  const message = adminTelegramMessage({
    id: '40000000-0000-4000-8000-000000000002',
    dataset_id: 'telegram.monitor.messages.v1', external_id: '-1004001:1',
    object_type: 'message', content_type: 'text', title: null, body: 'safe text', url: null,
    event_time: new Date('2026-08-20T00:00:00.000Z'),
    collected_at: new Date('2026-08-20T00:01:00.000Z'),
    stable_fields: {
      relations: { chatId: '-1004001', messageId: '1', internal: 'no' },
      source: { origin: 'database', password: 'must-not-leak' },
      raw: { token: 'must-not-leak' },
    },
    current_revision: 1,
  })
  assert.doesNotMatch(JSON.stringify(message), /must-not-leak|password|token|raw/i)
  assert.equal(message.canonicalId, '40000000-0000-4000-8000-000000000002')

  const noHandle = adminTelegramChat({
    ...chatRow,
    id: '40000000-0000-4000-8000-000000000003',
    url: null,
    stable_fields: { attributes: { chatType: 'supergroup' } },
  })
  assert.equal(noHandle.kind, 'group')
  assert.equal(noHandle.visibilityEvidence.urlKind, 'none')
  const unknown = adminTelegramChat({
    ...chatRow,
    id: '40000000-0000-4000-8000-000000000004',
    content_type: 'private',
    stable_fields: { attributes: { chatType: 'private', username: 'looks_public' } },
  })
  assert.equal(unknown.kind, 'unknown')
  const invite = adminTelegramChat({
    ...chatRow,
    id: '40000000-0000-4000-8000-000000000005',
    url: 'https://t.me/+privateInvite',
    stable_fields: { attributes: { chatType: 'group' } },
  })
  assert.equal(invite.url, 'https://t.me/+privateInvite')
  assert.equal(invite.visibilityEvidence.urlKind, 'invite-link')

  const opinion = adminPublicOpinionItemResponse({
    id: '40000000-0000-4000-8000-000000000006',
    title: 'Safe title', body: 'Safe summary', url: 'https://example.invalid/safe',
    content_type: 'news', author_name: 'Public source',
    event_time: new Date('2026-08-20T00:00:00.000Z'),
    collected_at: new Date('2026-08-20T00:01:00.000Z'),
    admin1_code: 'CN-JS', heat_score: '82.5', source_stage: 'formal',
    stable_fields: {
      attributes: { sourceType: 'news', sourcePlatform: 'public-web' },
      password: 'opinion-secret-sentinel',
      modelTrace: 'opinion-secret-sentinel',
    },
    extensions: { rawPayload: 'opinion-secret-sentinel' },
  })
  assert.doesNotMatch(JSON.stringify(opinion), /opinion-secret-sentinel/)
  assert.deepEqual(opinion.origin, {
    name: 'Public source', type: 'news', platform: 'public-web',
  })
})

test('PostgreSQL Telegram plans merge both datasets without a public-chat gate', async () => {
  const calls = []
  const store = new PostgresStore({
    async query(sql, values) {
      calls.push({ sql, values })
      return { rows: [] }
    },
  })

  await store.listAdminTelegramChats({ kind: 'group', query: 'open', pageSize: 20 })
  await store.listAdminTelegramMessages({
    chatExternalId: '-1004001',
    pageSize: 30,
    cursor: {
      sortTime: '2026-08-20T00:00:00.000Z',
      id: '40000000-0000-4000-8000-000000000002',
    },
  })
  await store.searchAdminTelegramMessages({ query: 'keyword', pageSize: 10 })

  const chatSql = calls[0].sql
  assert.match(chatSql, /chat\.dataset_id = ANY\(\$1::text\[\]\)/)
  assert.doesNotMatch(chatSql, /joinchat|t[.]me/)
  assert.match(chatSql, /coalesce\(chat\.event_time, chat\.collected_at, chat\.first_seen_at\) AS sort_time/)
  assert.match(chatSql, /\(coalesce\(chat\.event_time, chat\.collected_at, chat\.first_seen_at\), chat\.id\) < \(\$4::timestamptz, \$5::uuid\)/)
  assert.match(chatSql, /ORDER BY coalesce\(chat\.event_time, chat\.collected_at, chat\.first_seen_at\) DESC, chat\.id DESC/)
  assert.doesNotMatch(chatSql, /last_seen_at/)
  assert.doesNotMatch(chatSql, /coalesce\(chat\.event_time, chat\.collected_at\) IS NOT NULL/)
  assert.ok(chatSql.indexOf("IN ('group', 'megagroup', 'public_group', 'supergroup')") < chatSql.indexOf('LIMIT'))
  assert.deepEqual(calls[0].values, [[
    'telegram.monitor.chats.v1', 'telegram.sqlite.chats.v1',
  ], 'group', 'open', null, null, 21])

  const historySql = calls[1].sql
  assert.doesNotMatch(historySql, /JOIN core\.canonical_records chat/)
  assert.match(historySql, /message\.dataset_id = ANY\(\$1::text\[\]\)/)
  assert.doesNotMatch(historySql, /message\.event_time IS NOT NULL/)
  assert.match(historySql, /coalesce\(message\.event_time, message\.collected_at, message\.first_seen_at\) AS sort_time/)
  assert.match(historySql, /\(coalesce\(message\.event_time, message\.collected_at, message\.first_seen_at\), message\.id\) < \(\$3::timestamptz, \$4::uuid\)/)
  assert.match(historySql, /ORDER BY coalesce\(message\.event_time, message\.collected_at, message\.first_seen_at\) DESC, message\.id DESC/)
  assert.doesNotMatch(historySql, /last_seen_at/)
  assert.doesNotMatch(historySql, /coalesce\(message\.event_time, message\.collected_at\) IS NOT NULL/)
  assert.deepEqual(calls[1].values, [
    ['telegram.monitor.messages.v1', 'telegram.sqlite.messages.v1'],
    '-1004001',
    '2026-08-20T00:00:00.000Z',
    '40000000-0000-4000-8000-000000000002',
    31,
  ])

  const searchSql = calls[2].sql
  assert.doesNotMatch(searchSql, /JOIN core\.canonical_records chat/)
  assert.match(searchSql, /message\.dataset_id = ANY\(\$1::text\[\]\)/)
  assert.doesNotMatch(searchSql, /message\.event_time IS NOT NULL/)
  assert.match(searchSql, /coalesce\(message\.event_time, message\.collected_at, message\.first_seen_at\) AS sort_time/)
  assert.match(searchSql, /\(coalesce\(message\.event_time, message\.collected_at, message\.first_seen_at\), message\.id\) < \(\$4::timestamptz, \$5::uuid\)/)
  assert.match(searchSql, /ORDER BY coalesce\(message\.event_time, message\.collected_at, message\.first_seen_at\) DESC, message\.id DESC/)
  assert.doesNotMatch(searchSql, /last_seen_at/)
  assert.doesNotMatch(searchSql, /coalesce\(message\.event_time, message\.collected_at\) IS NOT NULL/)
  assert.deepEqual(calls[2].values, [[
    'telegram.monitor.messages.v1', 'telegram.sqlite.messages.v1',
  ], 'keyword', null, null, null, 11])

  await store.listAdminPublicOpinionRecords({
    provinceCode: 'CN-JS', sort: 'latest', pageSize: 10,
  })
  await store.getAdminPublicOpinionProvinceCoverage({
    from: '2026-08-01T00:00:00.000Z', to: '2026-08-27T00:00:00.000Z',
  })
  await store.getAdminPublicOpinionRecord('30000000-0000-4000-8000-000000000001')
  assert.equal(calls[3].values[3], 'formal')
  assert.equal(calls[3].values[4], null)
  assert.equal(calls[4].values[2], 'formal')
  assert.equal(calls[4].values[3], null)
  assert.deepEqual(calls[5].values, [
    '30000000-0000-4000-8000-000000000001', 'formal', null,
  ])
  for (const { sql } of calls.slice(3)) {
    assert.doesNotMatch(sql, /raw_payload|normalized_payload|model_reasoning|extensions/i)
  }
})

test('PostgreSQL Telegram chatKey and source scopes bind dataset-qualified selectors', async () => {
  const calls = []
  const store = new PostgresStore({
    async query(sql, values) {
      calls.push({ sql, values })
      return { rows: [] }
    },
  })
  const id = '40000000-0000-4000-8000-000000000001'
  await store.getAdminTelegramChat(`sqlite:${id}`, 'all')
  await store.getAdminTelegramMessage(id, 'monitor')
  await store.listAdminTelegramMessages({
    chatExternalId: '-1004001', sourceScope: 'sqlite', pageSize: 5,
  })

  assert.deepEqual(calls[0].values, [id, ['telegram.sqlite.chats.v1']])
  assert.deepEqual(calls[1].values, [id, ['telegram.monitor.messages.v1']])
  assert.deepEqual(calls[2].values, [
    ['telegram.sqlite.messages.v1'], '-1004001', null, null, 6,
  ])
  assert.doesNotMatch(calls.map((call) => call.sql).join('\n'), /raw_payload|normalized_payload|connection|credential/i)
})

test('a PostgreSQL-capable facade propagates store failures instead of falling back to demo', async () => {
  const unavailable = async () => { throw new Error('postgres unavailable') }
  const service = new HubService({
    store: {
      listAdminTelegramChats: unavailable,
      getAdminTelegramChat: unavailable,
      listAdminTelegramMessages: unavailable,
      searchAdminTelegramMessages: unavailable,
      getAdminTelegramMessage: unavailable,
      getCanonicalContext: unavailable,
      getAdminPublicOpinionProvinceCoverage: unavailable,
      listAdminPublicOpinionRecords: unavailable,
      getAdminPublicOpinionRecord: unavailable,
      getAdminPublicOpinionFunnel: unavailable,
      listAdminPublicOpinionBrowseRecords: unavailable,
      getAdminPublicOpinionBrowseRecord: unavailable,
    },
    adapter: {},
    apiKeyPepper: PEPPER,
    logger: quiet,
  })
  const operations = [
    () => service.adminDataProductTelegramChats({ kind: 'channel' }),
    () => service.adminDataProductTelegramMessages('-1001001', {}),
    () => service.adminDataProductTelegramSearch({ query: 'data' }),
    () => service.adminDataProductTelegramContext(
      '20000000-0000-4000-8000-000000000001',
      { before: 1, after: 1 },
    ),
    () => service.adminDataProductPublicOpinionCoverage({}),
    () => service.adminDataProductPublicOpinionFunnel({}),
    () => service.adminDataProductPublicOpinionBrowse({}),
    () => service.adminDataProductPublicOpinionBrowseItem(
      '30000000-0000-4000-8000-000000000004',
      {},
    ),
    () => service.adminDataProductPublicOpinionProvince('CN-JS', {}),
    () => service.adminDataProductPublicOpinionItem(
      '30000000-0000-4000-8000-000000000001',
      {},
    ),
  ]
  for (const operation of operations) {
    await assert.rejects(operation(), /postgres unavailable/)
  }
})
