import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseLosslessJson,
  SQLITE_JSON_DECODER_VERSION,
  SQLiteApiSourcePuller,
  validateSqliteApiConnection,
} from '../../server/ingest/external/sqlite-api-source.mjs'
import { ExternalSourcePuller } from '../../server/ingest/external/source-puller.mjs'
import { runExternalPullJob } from '../../server/ingest/external/sync-job.mjs'

const SECRET_TOKEN = 'test-token-must-never-leave-the-adapter'

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body) },
  }
}

function rawJsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return body },
  }
}

function messageSource(overrides = {}) {
  return {
    id: 'sqlite-message-source-id',
    sourceKey: 'telegram-sqlite-api-messages',
    displayName: 'Telegram SQLite messages',
    sourceKind: 'sqlite_api',
    datasetId: 'telegram.sqlite.messages.v1',
    platform: 'telegram',
    objectType: 'message',
    status: 'active',
    connection: {
      baseUrl: 'http://54.151.151.135:8780',
      token: SECRET_TOKEN,
      resource: 'messages',
      pageSize: 2,
    },
    ...overrides,
  }
}

function messageMapping(overrides = {}) {
  return {
    id: 'sqlite-message-map-id',
    sourceId: 'sqlite-message-source-id',
    version: 1,
    fieldMap: {
      externalId: { from: ['chat_id', 'message_id'], type: 'composite', separator: ':' },
      contentType: { from: 'message_kind' },
      body: { from: 'text' },
      authorExternalId: { from: 'sender_id' },
      authorName: { from: ['sender_name', 'sender_username'] },
      eventTime: { from: 'message_at', type: 'timestamp' },
      collectedAt: { from: 'captured_at', type: 'timestamp' },
      editedAt: { from: 'edited_at', type: 'timestamp' },
      deletedAt: { from: 'deleted_at', type: 'timestamp' },
      'relations.chatId': { from: 'chat_id' },
      'relations.messageId': { from: 'message_id' },
      'relations.groupedId': { from: 'metadata.grouped_id' },
      'metrics.views': { from: 'metadata.views', type: 'number' },
      'metrics.shares': { from: 'metadata.forwards', type: 'number' },
      ...overrides,
    },
  }
}

function rawMessage({
  chatId = -1007,
  messageId,
  messageAt,
  text = '原文完整保留：敏感词与测试词均不改写',
  deletedAt = null,
  views = 7,
  groupedId = '7001',
} = {}) {
  return {
    chat_id: chatId,
    message_id: messageId,
    sender_id: 81,
    sender_name: 'sender',
    sender_username: 'sender_handle',
    text,
    message_at: messageAt,
    edited_at: null,
    captured_at: messageAt,
    message_kind: 'text',
    media_type: null,
    reply_to_message_id: null,
    thread_id: null,
    is_outgoing: false,
    deleted_at: deletedAt,
    first_seen_account_id: 3,
    account_alias: 'collector',
    account_phone: '+8613800000003',
    chat_title: 'chat',
    chat_username: 'chat_handle',
    message_url: `https://t.me/chat_handle/${messageId}`,
    metadata: { views, forwards: 2, grouped_id: groupedId, post_author: null, forward: null },
  }
}

function createPullHarness({
  source = messageSource(), mapping = messageMapping(), responses,
  failFirstAck = false, now, initialCursor = null, timeoutMs = undefined,
}) {
  const requests = []
  const ingested = []
  const runs = new Map()
  const batches = new Map()
  let cursor = initialCursor == null ? null : structuredClone(initialCursor)
  let runNumber = 0
  let responseIndex = 0
  let failAck = failFirstAck

  const fetchImpl = async (url, options) => {
    requests.push({ url: new URL(url), options })
    const response = responses[responseIndex]
    responseIndex += 1
    if (!response) throw new Error('unexpected fetch')
    return typeof response === 'function' ? response(new URL(url), options) : jsonResponse(response)
  }

  const queue = {
    async getCursor() { return cursor },
    async saveCursor(id, position, options) {
      if (failAck && options.status === 'running' && position.cycle?.page === 2) {
        failAck = false
        throw new Error('simulated cursor acknowledgement failure')
      }
      cursor = {
        id,
        position,
        status: options.status,
        processed: (cursor?.processed ?? 0) + Number(options.processedDelta ?? 0),
        error: options.error ?? null,
        updated_at: now().toISOString(),
      }
      return cursor
    },
  }

  const store = {
    async getExternalSource() { return source },
    async getActiveMapping() { return mapping },
    async startImportRun(input) {
      const existing = [...runs.values()].find((run) => run.runKey === input.runKey && run.status === 'running')
      if (existing) return { id: existing.id, duplicateOf: null }
      runNumber += 1
      const id = `sqlite-run-${runNumber}`
      runs.set(id, { id, sourceId: input.sourceId, status: 'running', runKey: input.runKey, input })
      return { id, duplicateOf: null }
    },
    async getImportRunState(id) {
      const run = runs.get(id)
      return run && { id, sourceId: run.sourceId, status: run.status }
    },
    async getImportBatch(runId, key) { return batches.get(`${runId}:${key}`) ?? null },
    async ingestExternalRecords(input) {
      ingested.push(input)
      const deleted = input.records.filter((record) => record.deletedAt != null).length
      const result = {
        ingested: input.records.length,
        changed: input.records.length,
        deleted,
        cursorEnd: input.batch.cursorEnd,
        rowCount: input.batch.rowCount,
      }
      batches.set(`${input.importRunId}:${input.batch.key}`, {
        status: 'succeeded',
        cursorStart: input.batch.cursorStart,
        cursorEnd: input.batch.cursorEnd,
        rowCount: input.batch.rowCount,
        ingested: result.ingested,
        changed: result.changed,
        deleted,
        rejected: 0,
        pageFingerprint: input.batch.pageFingerprint,
      })
      return result
    },
    async finalizeExternalImportRun(input) {
      const run = runs.get(input.importRunId)
      if (run) run.status = input.status
      cursor = {
        id: input.cursorId,
        position: input.position,
        status: input.cursorStatus,
        processed: (cursor?.processed ?? 0) + Number(input.processedDelta ?? 0),
        error: input.error,
        updated_at: now().toISOString(),
      }
      return { cursor }
    },
    async markExternalImportCursorFailed(input) {
      cursor = {
        id: input.cursorId,
        position: input.position,
        status: 'failed',
        error: input.error,
        updated_at: now().toISOString(),
      }
      return { cursor }
    },
    async recordRejectedImportBatch() {},
  }

  const puller = new SQLiteApiSourcePuller({
    store,
    queue,
    fetchImpl,
    now,
    timeoutMs,
    logger: { warn() {} },
  })
  return {
    puller,
    queue,
    store,
    requests,
    ingested,
    runs,
    getCursor: () => cursor,
  }
}

test('SQLite API connection tests are GET-only, require health status ok, and never return the token', async () => {
  const requests = []
  const connection = messageSource().connection
  const puller = new SQLiteApiSourcePuller({
    store: {},
    queue: {},
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options })
      if (new URL(url).pathname === '/v1/health') return jsonResponse({ status: 'ok', time: '2026-08-15T00:00:00Z' })
      if (new URL(url).pathname === '/v1/stats') {
        return jsonResponse({
          chats: 4,
          messages: 12,
          active_messages: 11,
          last_24_hours: 3,
          ignored_untrusted_field: SECRET_TOKEN,
        })
      }
      return jsonResponse({ items: [], total: 12, page: 1 })
    },
  })

  const result = await puller.testConnection(connection)

  assert.equal(result.status, 'ok')
  assert.equal(result.readOnly, true)
  assert.equal(result.totalRows, 12)
  assert.deepEqual(result.stats, { chats: 4, messages: 12, activeMessages: 11, last24Hours: 3 })
  assert.equal(result.tokenConfigured, true)
  assert.equal(JSON.stringify(result).includes(SECRET_TOKEN), false)
  assert.deepEqual(requests.map((request) => request.options.method), ['GET', 'GET', 'GET'])
  assert.equal(requests[0].options.headers.Authorization, undefined)
  assert.equal(requests[1].options.headers.Authorization, `Bearer ${SECRET_TOKEN}`)
  assert.equal(requests[1].options.redirect, 'error')
  assert.equal(requests[1].url.pathname, '/v1/stats')
  assert.equal(requests[2].options.headers.Authorization, `Bearer ${SECRET_TOKEN}`)
  assert.equal(requests[2].url.searchParams.get('include_deleted'), 'true')
  assert.equal(requests[2].url.searchParams.get('page_size'), '1')
})

test('health HTTP 200 with a non-ok status and upstream auth bodies are safely rejected', async () => {
  const connection = messageSource().connection
  const unhealthy = new SQLiteApiSourcePuller({
    store: {}, queue: {}, fetchImpl: async () => jsonResponse({ status: 'unavailable' }),
  })
  await assert.rejects(
    () => unhealthy.testConnection(connection),
    (error) => error?.code === 'sqlite_api_unhealthy' && !error.message.includes(SECRET_TOKEN),
  )

  let calls = 0
  const unauthorized = new SQLiteApiSourcePuller({
    store: {},
    queue: {},
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) return jsonResponse({ status: 'ok' })
      return jsonResponse({ detail: `bad bearer ${SECRET_TOKEN}` }, 401)
    },
  })
  await assert.rejects(
    () => unauthorized.testConnection(connection),
    (error) => error?.code === 'sqlite_api_unauthorized'
      && !error.message.includes(SECRET_TOKEN)
      && !JSON.stringify(error).includes(SECRET_TOKEN),
  )

  let statsCalls = 0
  const unsafeStats = new SQLiteApiSourcePuller({
    store: {},
    queue: {},
    fetchImpl: async () => {
      statsCalls += 1
      if (statsCalls === 1) return jsonResponse({ status: 'ok' })
      return rawJsonResponse(`{
        "chats": 4,
        "messages": 9223372036854775807,
        "active_messages": 11,
        "last_24_hours": 3
      }`)
    },
  })
  await assert.rejects(
    () => unsafeStats.testConnection(connection),
    (error) => error?.code === 'sqlite_api_contract_mismatch',
  )
})

test('connection validation allows only the fixed HTTP source contract', () => {
  assert.equal(validateSqliteApiConnection(messageSource().connection), true)
  assert.throws(
    () => validateSqliteApiConnection({ ...messageSource().connection, method: 'POST' }),
    (error) => error?.code === 'unsupported_connection_fields',
  )
  assert.throws(
    () => validateSqliteApiConnection({ ...messageSource().connection, baseUrl: 'http://user:pass@example.test' }),
    (error) => error?.code === 'invalid_sqlite_api_base_url',
  )
  assert.throws(
    () => validateSqliteApiConnection({ ...messageSource().connection, baseUrl: 'http://0.0.0.0:8780' }),
    (error) => error?.code === 'invalid_sqlite_api_base_url',
  )
  assert.throws(
    () => validateSqliteApiConnection({ ...messageSource().connection, pageSize: 501 }),
    (error) => error?.code === 'invalid_sqlite_api_page_size',
  )
})

test('lossless JSON parsing preserves unsafe integer tokens at every nesting level', () => {
  const parsed = parseLosslessJson(`{
    "chat_id": -1009007199254740993,
    "safe": 9007199254740991,
    "decimal": 1.25,
    "scientificSafe": 1e3,
    "metadata": {"grouped_id": 9223372036854775807},
    "nested": [9007199254740993, {"negative": -9007199254740995}, 184467440737095516160]
  }`)

  assert.equal(parsed.chat_id, '-1009007199254740993')
  assert.equal(parsed.safe, 9007199254740991)
  assert.equal(parsed.decimal, 1.25)
  assert.equal(parsed.scientificSafe, 1_000)
  assert.equal(parsed.metadata.grouped_id, '9223372036854775807')
  assert.deepEqual(parsed.nested, [
    '9007199254740993',
    { negative: '-9007199254740995' },
    '184467440737095516160',
  ])
  assert.equal(parseLosslessJson('9007199254740992'), '9007199254740992')
  assert.equal(parseLosslessJson('-9007199254740991'), -9007199254740991)
  assert.equal(parseLosslessJson('-9007199254740992'), '-9007199254740992')
  assert.equal(parseLosslessJson('9007199254740993'), '9007199254740993')
})

test('lossless JSON parsing rejects ambiguous large decimal and exponent tokens', () => {
  for (const token of [
    '1.00000000000000001',
    '1000000000000000.01',
    '1234567890123456.1',
    '9007199254740991.1',
    '9007199254740993.5',
    '9007199254740993e0',
    '1e400',
    '1e-400',
    '1.7976931348623157e308',
  ]) {
    assert.throws(
      () => parseLosslessJson(`{"value":${token}}`),
      (error) => error?.code === 'sqlite_api_unsupported_numeric_token',
      token,
    )
  }
  assert.deepEqual(parseLosslessJson('{"decimal":1.25,"scientificSafe":1e3}'), {
    decimal: 1.25,
    scientificSafe: 1_000,
  })
  assert.deepEqual(parseLosslessJson('{"decimalInteger":1.0,"zeroUnderflow":0e-400}'), {
    decimalInteger: 1,
    zeroUnderflow: 0,
  })
})

test('lossless JSON parsing bounds integer tokens before conversion', () => {
  assert.throws(
    () => parseLosslessJson(`{"value":${'9'.repeat(129)}}`),
    (error) => error?.code === 'sqlite_api_numeric_token_too_large',
  )
})

test('lossless JSON parsing fails closed when the runtime omits primitive source context', () => {
  const parseWithoutContext = (text, reviver) => JSON.parse(
    text,
    (key, value) => reviver(key, value),
  )

  assert.throws(
    () => parseLosslessJson('{"message_id":9007199254740993}', parseWithoutContext),
    (error) => error?.code === 'sqlite_api_lossless_json_unsupported',
  )
  assert.throws(
    () => parseLosslessJson('{"message_id":7,"ratio":0.5}', parseWithoutContext),
    (error) => error?.code === 'sqlite_api_lossless_json_unsupported',
  )
})

test('a raw page containing large integer ids completes a full pull without precision loss', async () => {
  const now = () => new Date('2026-08-15T13:00:00.000Z')
  const page = `{
    "items": [{
      "chat_id": -1009007199254740993,
      "message_id": 9007199254740993,
      "sender_id": 9223372036854775807,
      "sender_name": "sender",
      "sender_username": "sender_handle",
      "text": "source text",
      "message_at": "2026-08-15T12:00:00.000Z",
      "edited_at": null,
      "captured_at": "2026-08-15T12:00:01.000Z",
      "message_kind": "text",
      "media_type": null,
      "reply_to_message_id": null,
      "thread_id": null,
      "is_outgoing": false,
      "deleted_at": null,
      "first_seen_account_id": 184467440737095516160,
      "account_alias": "collector",
      "account_phone": null,
      "chat_title": "chat",
      "chat_username": "chat_handle",
      "message_url": null,
      "metadata": {
        "views": 7,
        "forwards": 2,
        "grouped_id": 9223372036854775807,
        "nested": [9007199254740995, -9007199254740997, 3, 0.25]
      }
    }],
    "total": 1,
    "page": 1
  }`
  const harness = createPullHarness({
    now,
    responses: [() => rawJsonResponse(page)],
  })

  const result = await harness.puller.pullBatch('telegram-sqlite-api-messages')
  const record = harness.ingested[0].records[0]

  assert.equal(result.done, true)
  assert.equal(result.ingested, 1)
  assert.equal(record.externalId, '-1009007199254740993:9007199254740993')
  assert.equal(record.stableFields.author.externalId, '9223372036854775807')
  assert.equal(record.stableFields.relations.groupedId, '9223372036854775807')
  assert.equal(record.rawItem.first_seen_account_id, '184467440737095516160')
  assert.equal(
    record.parserVersion,
    `mxih-external.v1:sqlite-api:${SQLITE_JSON_DECODER_VERSION}:map1`,
  )
  assert.deepEqual(record.rawItem.metadata.nested, [
    '9007199254740995', '-9007199254740997', 3, 0.25,
  ])
})

test('preview returns value-free shapes and never exposes raw text or credentials', async () => {
  const raw = rawMessage({ messageId: 9, messageAt: '2026-08-15T12:00:00Z' })
  const source = messageSource()
  const mapping = messageMapping()
  const puller = new SQLiteApiSourcePuller({
    store: {
      getExternalSource: async () => source,
      getActiveMapping: async () => mapping,
    },
    queue: {},
    fetchImpl: async () => jsonResponse({ items: [raw], total: 1, page: 1 }),
  })

  const preview = await puller.preview(source.sourceKey, { limit: 1 })
  const serialized = JSON.stringify(preview)
  assert.equal(preview.sampleShapes[0].text.jsonType, 'string')
  assert.equal(serialized.includes(raw.text), false)
  assert.equal(serialized.includes(raw.account_phone), false)
  assert.equal(serialized.includes(SECRET_TOKEN), false)
})

test('message tombstones can only come from the explicit deleted_at field', async () => {
  const source = messageSource()
  const mapping = messageMapping({ deletedAt: { from: 'edited_at', type: 'timestamp' } })
  const puller = new SQLiteApiSourcePuller({
    store: {
      getExternalSource: async () => source,
      getActiveMapping: async () => mapping,
    },
    queue: {},
    fetchImpl: async () => { throw new Error('must not fetch') },
  })
  await assert.rejects(
    () => puller.describe(source.sourceKey),
    (error) => error?.code === 'unsafe_sqlite_api_delete_mapping',
  )
})

test('pullBatch runs an initial full scan, a two-hour overlap, then a bounded daily window', async () => {
  let clock = new Date('2026-08-15T13:00:00.000Z')
  const now = () => new Date(clock)
  const first = rawMessage({ messageId: 3, messageAt: '2026-08-15T12:00:00.000Z', views: 31 })
  const second = rawMessage({ messageId: 2, messageAt: '2026-08-15T11:30:00.000Z' })
  const deleted = rawMessage({
    messageId: 1,
    messageAt: '2026-08-15T11:00:00.000Z',
    deletedAt: '2026-08-15T12:30:00.000Z',
  })
  const incremental = rawMessage({ messageId: 4, messageAt: '2026-08-16T14:04:00.000Z' })
  const manual = rawMessage({ messageId: 5, messageAt: '2026-08-16T14:30:00.000Z' })
  const harness = createPullHarness({
    now,
    responses: [
      { items: [first, second], total: 3, page: 1 },
      { items: [deleted], total: 3, page: 2 },
      { items: [incremental], total: 1, page: 1 },
      { items: [manual], total: 1, page: 1 },
    ],
  })

  const pageOne = await harness.puller.pullBatch('telegram-sqlite-api-messages', { batchSize: 1000 })
  assert.equal(pageOne.done, false)
  assert.equal(pageOne.importRunId, 'sqlite-run-1')
  assert.equal(harness.requests[0].url.searchParams.get('include_deleted'), 'true')
  assert.equal(harness.requests[0].url.searchParams.get('end_at'), '2026-08-15T13:00:00.000Z')
  assert.equal(harness.requests[0].url.searchParams.has('start_at'), false)

  clock = new Date('2026-08-15T13:02:00.000Z')
  const pageTwo = await harness.puller.pullBatch('telegram-sqlite-api-messages', {
    batchSize: 1000,
    importRunId: pageOne.importRunId,
  })
  assert.equal(pageTwo.done, true)
  assert.equal(pageTwo.deleted, 1)
  assert.equal(harness.requests[1].url.searchParams.get('end_at'), '2026-08-15T13:00:00.000Z')
  assert.equal(harness.getCursor().status, 'idle')
  assert.equal(harness.getCursor().position.lastReconciledAt, '2026-08-15T13:00:00.000Z')
  assert.equal(harness.getCursor().position.lastDailyWindowDate, '2026-08-14')
  assert.equal(harness.getCursor().position.lastMessageAt, '2026-08-15T12:00:00.000Z')
  assert.deepEqual(harness.ingested[0].records[0].rawItem, first)
  assert.equal(harness.ingested[0].records[0].body, first.text)
  assert.equal(harness.ingested[0].records[0].externalId, '-1007:3')
  assert.equal(harness.ingested[0].records[0].metrics.views, 31)
  assert.equal(harness.ingested[0].records[0].stableFields.relations.groupedId, '7001')

  clock = new Date('2026-08-16T14:05:00.000Z')
  const overlap = await harness.puller.pullBatch('telegram-sqlite-api-messages')
  assert.equal(overlap.done, true)
  assert.equal(harness.requests[2].url.searchParams.get('start_at'), '2026-08-15T10:00:00.000Z')
  assert.equal(harness.requests[2].url.searchParams.get('end_at'), '2026-08-16T14:05:00.000Z')
  assert.equal(harness.getCursor().position.lastMessageAt, '2026-08-16T14:04:00.000Z')
  assert.equal(harness.getCursor().position.lastReconciledAt, '2026-08-15T13:00:00.000Z')
  assert.equal(harness.getCursor().position.lastDailyWindowDate, '2026-08-14')

  clock = new Date('2026-08-16T18:05:00.000Z')
  await harness.puller.pullBatch('telegram-sqlite-api-messages', { trigger: 'daily_window' })
  assert.equal(harness.requests[3].url.searchParams.get('start_at'), '2026-08-16T00:00:00.000+08:00')
  assert.equal(harness.requests[3].url.searchParams.get('end_at'), '2026-08-17T00:00:00.000+08:00')
  assert.equal(harness.getCursor().position.lastDailyWindowDate, '2026-08-16')
  assert.equal(harness.getCursor().position.lastReconciledAt, '2026-08-15T13:00:00.000Z')
})

test('manual sync remains an overlap sync after the daily-window hour', async () => {
  const now = () => new Date('2026-08-16T18:05:00.000Z')
  const harness = createPullHarness({
    now,
    initialCursor: {
      status: 'idle',
      updatedAt: '2026-08-16T18:00:00.000Z',
      position: {
        lastCompletedAt: '2026-08-16T17:55:00.000Z',
        lastMessageAt: '2026-08-16T17:50:00.000Z',
        lastDailyWindowDate: '2026-08-15',
      },
    },
    responses: [{
      items: [rawMessage({ messageId: 6, messageAt: '2026-08-16T18:04:00.000Z' })],
      total: 1,
      page: 1,
    }],
  })

  await harness.puller.pullBatch('telegram-sqlite-api-messages', { trigger: 'manual' })

  assert.equal(harness.requests[0].url.searchParams.get('start_at'), '2026-08-16T15:50:00.000Z')
  assert.equal(harness.requests[0].url.searchParams.get('end_at'), '2026-08-16T18:05:00.000Z')
  assert.equal(harness.getCursor().position.lastDailyWindowDate, '2026-08-15')
})

test('a full scan finishing before Shanghai 02:00 leaves the previous-day window due', async () => {
  const now = () => new Date('2026-08-10T17:59:00.000Z')
  const harness = createPullHarness({
    now,
    responses: [{ items: [], total: 0, page: 1 }],
  })

  await harness.puller.pullBatch('telegram-sqlite-api-messages')

  assert.equal(harness.getCursor().position.lastCompletedAt, '2026-08-10T17:59:00.000Z')
  assert.equal(harness.getCursor().position.lastDailyWindowDate, undefined)
})

test('the inclusive next-midnight boundary maps to the same canonical identity on overlap retry', async () => {
  let clock = new Date('2026-08-16T18:05:00.000Z')
  const now = () => new Date(clock)
  const boundary = rawMessage({
    messageId: 7,
    messageAt: '2026-08-16T16:00:00.000Z',
  })
  const harness = createPullHarness({
    now,
    initialCursor: {
      status: 'idle',
      updatedAt: '2026-08-16T18:00:00.000Z',
      position: {
        lastCompletedAt: '2026-08-16T17:55:00.000Z',
        lastMessageAt: '2026-08-16T15:59:00.000Z',
        lastDailyWindowDate: '2026-08-15',
      },
    },
    responses: [
      { items: [boundary], total: 1, page: 1 },
      { items: [boundary], total: 1, page: 1 },
    ],
  })

  await harness.puller.pullBatch('telegram-sqlite-api-messages', { trigger: 'daily_window' })
  clock = new Date('2026-08-16T18:10:00.000Z')
  await harness.puller.pullBatch('telegram-sqlite-api-messages', { trigger: 'schedule' })

  assert.equal(harness.requests[0].url.searchParams.get('end_at'), '2026-08-17T00:00:00.000+08:00')
  assert.equal(harness.ingested[0].records[0].externalId, '-1007:7')
  assert.equal(harness.ingested[1].records[0].externalId, '-1007:7')
  assert.equal(harness.getCursor().position.lastMessageAt, boundary.message_at)
})

test('a temporary daily-window second-page failure keeps its fixed bounds for queue retry', async () => {
  const now = () => new Date('2026-08-16T18:05:00.000Z')
  const harness = createPullHarness({
    now,
    initialCursor: {
      status: 'idle',
      updatedAt: '2026-08-16T18:00:00.000Z',
      position: {
        lastCompletedAt: '2026-08-16T17:55:00.000Z',
        lastMessageAt: '2026-08-16T17:50:00.000Z',
        lastDailyWindowDate: '2026-08-15',
      },
    },
    responses: [
      {
        items: [
          rawMessage({ messageId: 3, messageAt: '2026-08-16T12:00:00.000Z' }),
          rawMessage({ messageId: 2, messageAt: '2026-08-16T11:30:00.000Z' }),
        ],
        total: 3,
        page: 1,
      },
      () => jsonResponse({ detail: 'temporary upstream failure' }, 503),
      {
        items: [rawMessage({ messageId: 1, messageAt: '2026-08-16T11:00:00.000Z' })],
        total: 3,
        page: 2,
      },
    ],
  })

  const first = await harness.puller.pullBatch('telegram-sqlite-api-messages', { trigger: 'daily_window' })
  assert.equal(first.done, false)
  assert.equal(harness.getCursor().position.cycle.page, 2)
  assert.equal(harness.getCursor().position.cycle.startAt, '2026-08-16T00:00:00.000+08:00')
  assert.equal(harness.getCursor().position.cycle.endAt, '2026-08-17T00:00:00.000+08:00')

  await assert.rejects(
    () => harness.puller.pullBatch('telegram-sqlite-api-messages', { importRunId: first.importRunId }),
    (error) => error?.code === 'sqlite_api_request_failed' && error?.status === 503,
  )
  assert.equal(harness.getCursor().status, 'running')
  assert.equal(harness.getCursor().position.importRunId, first.importRunId)
  assert.equal(harness.getCursor().position.cycle.page, 2)
  assert.equal(harness.runs.get(first.importRunId).status, 'running')

  const retry = await harness.puller.pullBatch('telegram-sqlite-api-messages', {
    importRunId: first.importRunId,
  })
  assert.equal(retry.stale, undefined)
  assert.equal(retry.importRunId, first.importRunId)
  assert.equal(retry.done, true)
  assert.equal(harness.requests[1].url.searchParams.get('page'), '2')
  assert.equal(harness.requests[2].url.searchParams.get('page'), '2')
  assert.equal(harness.runs.get(first.importRunId).status, 'succeeded')
  assert.equal(harness.getCursor().position.lastDailyWindowDate, '2026-08-16')
})

test('a malformed continuation response retries the same page and import run', async () => {
  const now = () => new Date('2026-08-16T18:05:00.000Z')
  const harness = createPullHarness({
    now,
    responses: [
      {
        items: [
          rawMessage({ messageId: 3, messageAt: '2026-08-16T12:00:00.000Z' }),
          rawMessage({ messageId: 2, messageAt: '2026-08-16T11:30:00.000Z' }),
        ],
        total: 3,
        page: 1,
      },
      () => rawJsonResponse('{"items":['),
      {
        items: [rawMessage({ messageId: 1, messageAt: '2026-08-16T11:00:00.000Z' })],
        total: 3,
        page: 2,
      },
    ],
  })
  const continuations = []
  harness.queue.heartbeat = async () => {}
  harness.queue.enqueue = async (_queue, payload) => {
    continuations.push(payload)
    return continuations.length
  }
  const workerOptions = {
    puller: harness.puller,
    queue: harness.queue,
    signal: { aborted: false },
    logger: { log() {}, warn() {}, error() {} },
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  }

  const first = await runExternalPullJob({
    ...workerOptions,
    payload: {
      sourceKey: 'telegram-sqlite-api-messages', batchSize: 2, trigger: 'manual', chunk: 0,
    },
    job: { id: 1, attempts: 1, max_attempts: 5 },
  })
  assert.equal(first.done, false)
  assert.equal(continuations.length, 1)
  const continuationPayload = continuations[0]
  assert.equal(continuationPayload.importRunId, first.importRunId)

  await assert.rejects(
    () => runExternalPullJob({
      ...workerOptions,
      payload: continuationPayload,
      job: { id: 2, attempts: 1, max_attempts: 5 },
    }),
    (error) => error?.code === 'sqlite_api_invalid_json',
  )
  assert.equal(harness.getCursor().status, 'running')
  assert.equal(harness.getCursor().position.importRunId, first.importRunId)
  assert.equal(harness.getCursor().position.cycle.page, 2)
  assert.equal(harness.runs.get(first.importRunId).status, 'running')

  const retried = await runExternalPullJob({
    ...workerOptions,
    payload: continuationPayload,
    job: { id: 2, attempts: 2, max_attempts: 5 },
  })
  assert.equal(retried.done, true)
  assert.equal(retried.importRunId, first.importRunId)
  assert.equal(harness.runs.size, 1)
  assert.equal(harness.runs.get(first.importRunId).status, 'succeeded')
  assert.equal(harness.getCursor().status, 'idle')
  assert.deepEqual(
    harness.requests.map((request) => request.url.searchParams.get('page')),
    ['1', '2', '2'],
  )
  assert.equal(harness.requests[1].url.searchParams.get('end_at'), harness.requests[2].url.searchParams.get('end_at'))
})

test('a response body that hangs after headers is aborted without losing its retry checkpoint', {
  timeout: 1_000,
}, async () => {
  const now = () => new Date('2026-08-16T18:05:00.000Z')
  let bodyAborted = false
  const harness = createPullHarness({
    now,
    timeoutMs: 25,
    responses: [
      {
        items: [
          rawMessage({ messageId: 3, messageAt: '2026-08-16T12:00:00.000Z' }),
          rawMessage({ messageId: 2, messageAt: '2026-08-16T11:30:00.000Z' }),
        ],
        total: 3,
        page: 1,
      },
      (_url, options) => ({
        ok: true,
        status: 200,
        text() {
          return new Promise((_resolve, reject) => {
            const abort = () => {
              bodyAborted = true
              const error = new Error('response body aborted')
              error.name = 'AbortError'
              reject(error)
            }
            if (options.signal.aborted) abort()
            else options.signal.addEventListener('abort', abort, { once: true })
          })
        },
      }),
    ],
  })
  const first = await harness.puller.pullBatch('telegram-sqlite-api-messages', { batchSize: 2 })
  assert.equal(first.done, false)

  let watchdog
  try {
    await Promise.race([
      assert.rejects(
        () => harness.puller.pullBatch('telegram-sqlite-api-messages', {
          batchSize: 2,
          importRunId: first.importRunId,
        }),
        (error) => error?.status === 503 && error?.code === 'sqlite_api_response_read_failed',
      ),
      new Promise((_resolve, reject) => {
        watchdog = setTimeout(() => reject(new Error('response body timeout did not abort the read')), 500)
      }),
    ])
  } finally {
    clearTimeout(watchdog)
  }

  assert.equal(bodyAborted, true)
  assert.equal(harness.getCursor().status, 'running')
  assert.equal(harness.getCursor().position.importRunId, first.importRunId)
  assert.equal(harness.getCursor().position.cycle.page, 2)
  assert.equal(harness.runs.get(first.importRunId).status, 'running')
})

test('checkpoint reset makes the next pull a full reconciliation', async () => {
  let clock = new Date('2026-08-15T13:00:00.000Z')
  const now = () => new Date(clock)
  const source = messageSource()
  const harness = createPullHarness({
    source,
    now,
    responses: [
      { items: [rawMessage({ messageId: 1, messageAt: '2026-08-15T12:00:00.000Z' })], total: 1, page: 1 },
      { items: [rawMessage({ messageId: 2, messageAt: '2026-08-16T12:00:00.000Z' })], total: 1, page: 1 },
    ],
  })

  await harness.puller.pullBatch(source.sourceKey)
  source.status = 'paused'
  clock = new Date('2026-08-16T13:00:00.000Z')
  await harness.puller.resetCheckpoint(source.sourceKey)
  assert.equal(harness.getCursor().position.lastCompletedAt, undefined)
  assert.equal(harness.getCursor().position.lastDailyWindowDate, undefined)
  assert.equal(harness.getCursor().position.resetAt, '2026-08-16T13:00:00.000Z')

  source.status = 'active'
  await harness.puller.pullBatch(source.sourceKey)
  assert.equal(harness.requests[1].url.searchParams.has('start_at'), false)
  assert.equal(harness.requests[1].url.searchParams.get('end_at'), '2026-08-16T13:00:00.000Z')
})

test('page validation rejects malformed pagination, rows, required fields, and non-integer ids', async (t) => {
  const message = rawMessage({ messageId: 1, messageAt: '2026-08-15T12:00:00.000Z' })
  const chatSource = messageSource({
    id: 'sqlite-chat-source-id',
    sourceKey: 'telegram-sqlite-api-chats',
    datasetId: 'telegram.sqlite.chats.v1',
    objectType: 'chat',
    connection: { ...messageSource().connection, resource: 'chats' },
  })
  const validChat = { chat_id: -1007, updated_at: '2026-08-15T12:00:00+00:00' }

  const preview = (source, body) => new SQLiteApiSourcePuller({
    store: {
      getExternalSource: async () => source,
      getActiveMapping: async () => null,
    },
    queue: {},
    fetchImpl: async () => jsonResponse(body),
  }).preview(source.sourceKey, { limit: 1 })

  const cases = [
    ['negative total', messageSource(), { items: [], total: -1, page: 1 }],
    ['fractional total', messageSource(), { items: [], total: 1.5, page: 1 }],
    ['missing page', messageSource(), { items: [], total: 0 }],
    ['zero page', messageSource(), { items: [], total: 0, page: 0 }],
    ['non-object message row', messageSource(), { items: [null], total: 1, page: 1 }],
    ['fractional numeric message id', messageSource(), {
      items: [{ ...message, message_id: 1.5 }], total: 1, page: 1,
    }],
    ['non-integer string id', messageSource(), {
      items: [{ ...message, message_id: '1.5' }], total: 1, page: 1,
    }],
    ['null required message id', messageSource(), {
      items: [{ ...message, message_id: null }], total: 1, page: 1,
    }],
    ['chat missing chat_id', chatSource, { items: [{ updated_at: validChat.updated_at }], total: 1, page: 1 }],
    ['chat missing updated_at', chatSource, { items: [{ chat_id: validChat.chat_id }], total: 1, page: 1 }],
    ['chat invalid updated_at', chatSource, {
      items: [{ ...validChat, updated_at: 'not-a-timestamp' }], total: 1, page: 1,
    }],
    ['message invalid message_at', messageSource(), {
      items: [{ ...message, message_at: 'not-a-timestamp' }], total: 1, page: 1,
    }],
    ['message invalid captured_at', messageSource(), {
      items: [{ ...message, captured_at: 'not-a-timestamp' }], total: 1, page: 1,
    }],
    ['message invalid edited_at', messageSource(), {
      items: [{ ...message, edited_at: 'not-a-timestamp' }], total: 1, page: 1,
    }],
    ['message invalid deleted_at', messageSource(), {
      items: [{ ...message, deleted_at: 'not-a-timestamp' }], total: 1, page: 1,
    }],
  ]
  for (const field of ['chat_id', 'message_id', 'message_at', 'captured_at', 'deleted_at']) {
    const row = { ...message }
    delete row[field]
    cases.push([`message missing ${field}`, messageSource(), { items: [row], total: 1, page: 1 }])
  }

  for (const [name, source, body] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        () => preview(source, body),
        (error) => error?.code === 'sqlite_api_contract_mismatch',
      )
    })
  }

  await t.test('integer strings preserve ids beyond the JavaScript safe range', async () => {
    const row = rawMessage({
      chatId: '-1009007199254740993',
      messageId: '9007199254740993',
      messageAt: '2026-08-15T12:00:00.000Z',
      groupedId: '9007199254740994',
    })
    const result = await preview(messageSource(), { items: [row], total: 1, page: 1 })
    assert.equal(result.sampleShapes[0].chat_id.jsonType, 'string')
    assert.equal(result.sampleShapes[0].message_id.jsonType, 'string')
  })
})

test('contract mismatches and row rejections remain terminal operator-action failures', async () => {
  const now = () => new Date('2026-08-15T13:00:00.000Z')
  const contractHarness = createPullHarness({
    now,
    responses: [{ items: [], total: -1, page: 1 }],
  })
  await assert.rejects(
    () => contractHarness.puller.pullBatch('telegram-sqlite-api-messages'),
    (error) => error?.code === 'sqlite_api_contract_mismatch',
  )
  assert.equal(contractHarness.getCursor().status, 'failed')
  assert.equal(contractHarness.runs.get('sqlite-run-1').status, 'failed')
  assert.equal(contractHarness.getCursor().position.importRunId, undefined)

  const rejectionHarness = createPullHarness({
    now,
    mapping: messageMapping({ eventTime: { from: 'edited_at', type: 'timestamp' } }),
    responses: [{
      items: [rawMessage({ messageId: 1, messageAt: '2026-08-15T12:00:00.000Z' })],
      total: 1,
      page: 1,
    }],
  })
  await assert.rejects(
    () => rejectionHarness.puller.pullBatch('telegram-sqlite-api-messages'),
    (error) => error?.code === 'row_rejections_detected',
  )
  assert.equal(rejectionHarness.getCursor().status, 'failed')
  assert.equal(rejectionHarness.runs.get('sqlite-run-1').status, 'failed')
})

test('pullBatch fixes each cycle page size to the configured and worker batch limits', async () => {
  const now = () => new Date('2026-08-15T13:00:00.000Z')
  const base = messageSource()
  const source = messageSource({ connection: { ...base.connection, pageSize: 500 } })
  const harness = createPullHarness({
    source,
    now,
    responses: [{ items: [], total: 0, page: 1 }],
  })

  const result = await harness.puller.pullBatch(source.sourceKey, { batchSize: 17 })
  assert.equal(result.done, true)
  assert.equal(harness.requests[0].url.searchParams.get('page_size'), '17')
  assert.equal(harness.runs.get(result.importRunId).input.cursorStart.cycle.pageSize, 17)
})

test('progress reports the last completed reconciliation while preserving the no-exact-cursor blocker', async () => {
  const now = () => new Date('2026-08-15T13:00:00.000Z')
  const row = rawMessage({ messageId: 1, messageAt: '2026-08-15T12:00:00.000Z' })
  const harness = createPullHarness({
    now,
    responses: [
      { items: [row], total: 1, page: 1 },
      { items: [row], total: 1, page: 1 },
    ],
  })
  await harness.puller.pullBatch('telegram-sqlite-api-messages')
  const progress = await harness.puller.progress('telegram-sqlite-api-messages')
  assert.equal(progress.totalRows, 1)
  assert.equal(progress.sourceTotalRows, 1)
  assert.equal(progress.completedRows, 1)
  assert.equal(progress.remainingRows, 0)
  assert.equal(progress.percent, 100)
  assert.equal(progress.blocker, 'source_has_no_exact_change_cursor')
})

test('idle progress reports the completed incremental sweep separately from the full source total', async () => {
  let clock = new Date('2026-08-15T13:00:00.000Z')
  const now = () => new Date(clock)
  const full = rawMessage({ messageId: 1, messageAt: '2026-08-15T12:00:00.000Z' })
  const incremental = rawMessage({ messageId: 2, messageAt: '2026-08-15T12:30:00.000Z' })
  const harness = createPullHarness({
    now,
    responses: [
      { items: [full], total: 1, page: 1 },
      { items: [incremental], total: 1, page: 1 },
      { items: [incremental], total: 621_000, page: 1 },
    ],
  })

  await harness.puller.pullBatch('telegram-sqlite-api-messages')
  clock = new Date('2026-08-15T13:05:00.000Z')
  await harness.puller.pullBatch('telegram-sqlite-api-messages')
  const progress = await harness.puller.progress('telegram-sqlite-api-messages')

  assert.equal(progress.totalRows, 1)
  assert.equal(progress.completedRows, 1)
  assert.equal(progress.remainingRows, 0)
  assert.equal(progress.percent, 100)
  assert.equal(progress.sourceTotalRows, 621_000)
})

test('a committed page is replayed from batch evidence without refetching the mutable source page', async () => {
  const now = () => new Date('2026-08-15T13:00:00.000Z')
  const harness = createPullHarness({
    now,
    failFirstAck: true,
    responses: [{
      items: [
        rawMessage({ messageId: 2, messageAt: '2026-08-15T12:00:00.000Z' }),
        rawMessage({ messageId: 1, messageAt: '2026-08-15T11:00:00.000Z' }),
      ],
      total: 3,
      page: 1,
    }],
  })

  await assert.rejects(
    () => harness.puller.pullBatch('telegram-sqlite-api-messages'),
    (error) => error?.code === 'sqlite_api_pull_failed',
  )
  assert.equal(harness.requests.length, 1)
  assert.equal(harness.getCursor().position.importRunId, 'sqlite-run-1')
  assert.equal(harness.getCursor().position.cycle.page, 1)

  const replay = await harness.puller.pullBatch('telegram-sqlite-api-messages', {
    importRunId: 'sqlite-run-1',
  })
  assert.equal(replay.replayed, true)
  assert.equal(replay.done, false)
  assert.equal(harness.requests.length, 1)
  assert.equal(harness.getCursor().position.cycle.page, 2)
})

test('continuation failure preserves the active import run in a failed checkpoint', async () => {
  const now = () => new Date('2026-08-15T13:00:00.000Z')
  const harness = createPullHarness({
    now,
    responses: [{
      items: [
        rawMessage({ messageId: 2, messageAt: '2026-08-15T12:00:00.000Z' }),
        rawMessage({ messageId: 1, messageAt: '2026-08-15T11:00:00.000Z' }),
      ],
      total: 3,
      page: 1,
    }],
  })
  const first = await harness.puller.pullBatch('telegram-sqlite-api-messages')
  await harness.puller.markContinuationFailed(
    'telegram-sqlite-api-messages',
    first.importRunId,
    'continuation_enqueue_failed',
  )
  assert.equal(harness.getCursor().status, 'failed')
  assert.equal(harness.getCursor().position.importRunId, first.importRunId)
  assert.equal(harness.getCursor().error, 'continuation_enqueue_failed')
})

test('ambiguous finalization and failed-cursor commits retry the same idempotent operation', async () => {
  const now = () => new Date('2026-08-15T13:00:00.000Z')
  const harness = createPullHarness({
    now,
    responses: [{
      items: [rawMessage({ messageId: 1, messageAt: '2026-08-15T12:00:00.000Z' })],
      total: 1,
      page: 1,
    }],
  })
  const finalize = harness.store.finalizeExternalImportRun
  let finalizeCalls = 0
  harness.store.finalizeExternalImportRun = async (input) => {
    finalizeCalls += 1
    if (finalizeCalls === 1) {
      const error = new Error('outcome unknown')
      error.code = 'external_finalize_outcome_unknown'
      throw error
    }
    return finalize(input)
  }

  await assert.rejects(
    () => harness.puller.pullBatch('telegram-sqlite-api-messages'),
    (error) => error?.code === 'external_finalize_outcome_unknown'
      && error.externalFinalizationAttempted === true,
  )
  const replay = await harness.puller.pullBatch('telegram-sqlite-api-messages', {
    importRunId: 'sqlite-run-1',
  })
  assert.equal(replay.replayed, true)
  assert.equal(replay.done, true)
  assert.equal(finalizeCalls, 2)
  assert.equal(harness.requests.length, 1)

  // Open another unfinished run so markContinuationFailed has an owner.
  const failureHarness = createPullHarness({
    now,
    responses: [{
      items: [
        rawMessage({ messageId: 2, messageAt: '2026-08-15T12:00:00.000Z' }),
        rawMessage({ messageId: 1, messageAt: '2026-08-15T11:00:00.000Z' }),
      ],
      total: 3,
      page: 1,
    }],
  })
  const unfinished = await failureHarness.puller.pullBatch('telegram-sqlite-api-messages')
  const markFailed = failureHarness.store.markExternalImportCursorFailed
  let markCalls = 0
  failureHarness.store.markExternalImportCursorFailed = async (input) => {
    markCalls += 1
    if (markCalls === 1) {
      const error = new Error('outcome unknown')
      error.code = 'external_cursor_failure_outcome_unknown'
      throw error
    }
    return markFailed(input)
  }
  await failureHarness.puller.markContinuationFailed(
    'telegram-sqlite-api-messages',
    unfinished.importRunId,
    'continuation_enqueue_failed',
  )
  assert.equal(markCalls, 2)
  assert.equal(failureHarness.getCursor().status, 'failed')
  assert.equal(failureHarness.getCursor().position.importRunId, unfinished.importRunId)
})

test('ExternalSourcePuller routes SQLite and PostgreSQL sources without changing the worker contract', async () => {
  const calls = []
  const sqliteApiPuller = {
    pullBatch: async (...args) => { calls.push(['sqlite', ...args]); return { done: true } },
    testConnection: async () => ({ engine: 'sqlite_api' }),
  }
  const databasePuller = {
    pullBatch: async (...args) => { calls.push(['database', ...args]); return { done: true } },
    testConnection: async () => ({ engine: 'database' }),
  }
  const kinds = new Map([['sqlite-source', 'sqlite_api'], ['pg-source', 'database']])
  const puller = new ExternalSourcePuller({
    store: { getExternalSource: async (key) => ({ sourceKey: key, sourceKind: kinds.get(key) }) },
    databasePuller,
    sqliteApiPuller,
  })

  await puller.pullBatch('sqlite-source', { importRunId: 'run-1' })
  await puller.pullBatch('pg-source', { importRunId: 'run-2' })
  assert.deepEqual(calls, [
    ['sqlite', 'sqlite-source', { importRunId: 'run-1' }],
    ['database', 'pg-source', { importRunId: 'run-2' }],
  ])
  assert.deepEqual(await puller.testConnection({ baseUrl: 'http://example.test' }), { engine: 'sqlite_api' })
})
