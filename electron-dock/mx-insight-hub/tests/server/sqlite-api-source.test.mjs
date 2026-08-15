import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SQLiteApiSourcePuller,
  validateSqliteApiConnection,
} from '../../server/ingest/external/sqlite-api-source.mjs'
import { ExternalSourcePuller } from '../../server/ingest/external/source-puller.mjs'

const SECRET_TOKEN = 'test-token-must-never-leave-the-adapter'

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body },
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
    metadata: { views, forwards: 2, grouped_id: 'group-1', post_author: null, forward: null },
  }
}

function createPullHarness({ source = messageSource(), mapping = messageMapping(), responses, failFirstAck = false, now }) {
  const requests = []
  const ingested = []
  const runs = new Map()
  const batches = new Map()
  let cursor = null
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
    overlapMs: 60 * 60 * 1_000,
    reconciliationIntervalMs: 24 * 60 * 60 * 1_000,
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

test('pullBatch performs full reconciliation, fixes the run end, preserves raw rows, then uses overlap polling', async () => {
  let clock = new Date('2026-08-15T13:00:00.000Z')
  const now = () => new Date(clock)
  const first = rawMessage({ messageId: 3, messageAt: '2026-08-15T12:00:00.000Z', views: 31 })
  const second = rawMessage({ messageId: 2, messageAt: '2026-08-15T11:30:00.000Z' })
  const deleted = rawMessage({
    messageId: 1,
    messageAt: '2026-08-15T11:00:00.000Z',
    deletedAt: '2026-08-15T12:30:00.000Z',
  })
  const incremental = rawMessage({ messageId: 4, messageAt: '2026-08-15T12:04:00.000Z' })
  const harness = createPullHarness({
    now,
    responses: [
      { items: [first, second], total: 3, page: 1 },
      { items: [deleted], total: 3, page: 2 },
      { items: [incremental], total: 1, page: 1 },
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
  assert.equal(harness.getCursor().position.lastMessageAt, '2026-08-15T12:00:00.000Z')
  assert.deepEqual(harness.ingested[0].records[0].rawItem, first)
  assert.equal(harness.ingested[0].records[0].body, first.text)
  assert.equal(harness.ingested[0].records[0].externalId, '-1007:3')
  assert.equal(harness.ingested[0].records[0].metrics.views, 31)
  assert.equal(harness.ingested[0].records[0].stableFields.relations.groupedId, 'group-1')

  clock = new Date('2026-08-15T13:05:00.000Z')
  const overlap = await harness.puller.pullBatch('telegram-sqlite-api-messages')
  assert.equal(overlap.done, true)
  assert.equal(harness.requests[2].url.searchParams.get('start_at'), '2026-08-15T11:00:00.000Z')
  assert.equal(harness.requests[2].url.searchParams.get('end_at'), '2026-08-15T13:05:00.000Z')
  assert.equal(harness.getCursor().position.lastMessageAt, '2026-08-15T12:04:00.000Z')
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
  assert.equal(progress.completedRows, 1)
  assert.equal(progress.remainingRows, 0)
  assert.equal(progress.percent, 100)
  assert.equal(progress.blocker, 'source_has_no_exact_change_cursor')
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
