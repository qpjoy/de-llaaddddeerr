import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { AppError } from '../../server/core/errors.mjs'
import {
  TELEGRAM_SQLITE_INPUTS,
  TELEGRAM_SQLITE_MAPPING_VERSION,
  TELEGRAM_SQLITE_PIPELINE_KEY,
  TELEGRAM_SQLITE_STRATEGY,
  TelegramSQLitePipeline,
} from '../../server/ingest/telegram/sqlite-pipeline.mjs'

const TOKEN = 'sqlite-api-test-secret'
const V1_BUILT_IN_MAPPING_IDS = Object.freeze({
  chats: 'e360ebf5-f353-4338-a16f-087a29290959',
  messages: 'a89be04c-4a9c-4f75-b234-f9b75e89e56f',
})

function pipelineFixture() {
  const sources = new Map(TELEGRAM_SQLITE_INPUTS.map((input) => [input.sourceKey, {
    id: `source-${input.role}`,
    sourceKey: input.sourceKey,
    displayName: `Telegram SQLite ${input.role}`,
    sourceKind: 'sqlite_api',
    datasetId: input.datasetId,
    platform: 'telegram',
    objectType: input.objectType,
    status: 'paused',
    syncIntervalSeconds: 300,
    connection: {
      baseUrl: 'http://sqlite.test:8780',
      token: TOKEN,
      resource: input.resource,
      pageSize: input.pageSize,
    },
  }]))
  const mappings = new Map(TELEGRAM_SQLITE_INPUTS.map((input) => [
    `source-${input.role}`,
    [{
      id: input.builtInMappingId,
      sourceId: `source-${input.role}`,
      version: input.builtInMappingVersion,
      approved: false,
    }],
  ]))
  const activeMappings = new Map()
  const cursors = new Map(TELEGRAM_SQLITE_INPUTS.map((input) => [
    `external:${input.sourceKey}`,
    {
      status: 'idle',
      position: {},
      updatedAt: '2026-08-15T00:00:00.000Z',
      error: `must redact ${TOKEN}`,
    },
  ]))
  const calls = []
  const store = {
    getExternalSource: async (sourceKey) => sources.get(sourceKey) ?? null,
    getActiveMapping: async (sourceId) => activeMappings.get(sourceId) ?? null,
    listSourceMappings: async (sourceId) => mappings.get(sourceId) ?? [],
    listImportRuns: async (sourceId) => [{
      id: `run-${sourceId}`,
      status: 'failed',
      error: `upstream ${TOKEN}`,
    }],
    updateExternalSourcesBatch: async (updates) => {
      calls.push(['updateBatch', structuredClone(updates)])
      for (const update of updates) {
        const source = sources.get(update.sourceKey)
        if (!source) throw new AppError(404, 'source_not_found', 'missing source')
        sources.set(update.sourceKey, {
          ...source,
          ...(update.status == null ? {} : { status: update.status }),
          ...(update.connection == null ? {} : { connection: structuredClone(update.connection) }),
          ...(update.syncIntervalSeconds == null
            ? {}
            : { syncIntervalSeconds: update.syncIntervalSeconds }),
        })
      }
      return updates.map((update) => sources.get(update.sourceKey))
    },
    approveSourceMappingsBatch: async ({ approvals, approvedBy }) => {
      calls.push(['approveBatch', structuredClone(approvals), approvedBy])
      return approvals.map((approval) => {
        const mapping = mappings.get(approval.sourceId)?.find((candidate) => (
          candidate.id === approval.mappingId && candidate.version === approval.version
        ))
        if (!mapping) throw new AppError(409, 'builtin_mapping_conflict', 'mapping changed')
        const approved = { ...mapping, approved: true, approvedBy }
        activeMappings.set(approval.sourceId, approved)
        return approved
      })
    },
  }
  const sqliteApiPuller = {
    withSourceLocks: async (keys, operation) => {
      calls.push(['locks', [...keys]])
      return operation()
    },
    testConnection: async (connection) => {
      calls.push(['testConnection', structuredClone(connection)])
      return {
        baseUrl: connection.baseUrl,
        resource: connection.resource,
        pageSize: connection.pageSize,
        tokenConfigured: true,
        status: 'ok',
        readOnly: true,
      }
    },
    describe: async (sourceKey, options = {}) => {
      calls.push(['describe', sourceKey, options.mappingOverride?.id ?? null])
      return { issues: [], warnings: ['eventual reconciliation'] }
    },
    assertCheckpointCompatible: async (sourceKey, options = {}) => {
      calls.push(['checkpoint', sourceKey, options.mappingOverride?.id ?? null])
      return { compatible: true }
    },
    resetCheckpoints: async (sourceKeys, { mappingOverrides }) => {
      calls.push(['reset', [...sourceKeys], structuredClone(mappingOverrides)])
      return sourceKeys.map((sourceKey) => ({ sourceKey, status: 'idle' }))
    },
    progress: async (sourceKey) => {
      const chats = sourceKey.endsWith('chats')
      return {
        totalRows: chats ? 10 : 90,
        completedRows: chats ? 5 : 45,
        remainingRows: chats ? 5 : 45,
        percent: 50,
        cursor: cursors.get(`external:${sourceKey}`),
      }
    },
  }
  const queueClient = {
    query: async (sql) => {
      calls.push(['queueTx', sql])
      return { rows: [] }
    },
    release: (error) => calls.push(['queueRelease', error?.message ?? null]),
  }
  const queue = {
    pool: { connect: async () => queueClient },
    getCursor: async (cursorId) => cursors.get(cursorId) ?? null,
    enqueue: async (queueName, payload, options) => {
      assert.equal(options.client, queueClient)
      const { client: _client, ...safeOptions } = options
      calls.push(['enqueue', queueName, structuredClone(payload), structuredClone(safeOptions)])
      return calls.filter(([kind]) => kind === 'enqueue').length
    },
  }
  return {
    sources,
    mappings,
    activeMappings,
    cursors,
    calls,
    store,
    sqliteApiPuller,
    queue,
  }
}

test('Telegram SQLite pipeline exposes fixed inputs and never returns its bearer token', async () => {
  const fixture = pipelineFixture()
  const result = await new TelegramSQLitePipeline(fixture).get()

  assert.equal(result.pipelineKey, TELEGRAM_SQLITE_PIPELINE_KEY)
  assert.equal(result.status, 'paused')
  assert.equal(result.configured, true)
  assert.deepEqual(result.connection, {
    baseUrl: 'http://sqlite.test:8780',
    tokenConfigured: true,
  })
  assert.deepEqual(result.strategy, TELEGRAM_SQLITE_STRATEGY)
  assert.equal(result.strategy.initialSync, 'full')
  assert.equal(result.strategy.incrementalSync, '2h_overlap')
  assert.equal(result.strategy.overlapSeconds, 7_200)
  assert.deepEqual(result.strategy.dailyWindow, {
    timezone: 'Asia/Shanghai',
    hour: 2,
    window: 'previous_calendar_day',
  })
  assert.equal(result.strategy.reconciliation, 'manual_full_align')
  assert.equal(Object.hasOwn(result.strategy, 'fullReconcileIntervalSeconds'), false)
  assert.deepEqual(result.tasks.map((task) => ({
    role: task.role,
    sourceKey: task.sourceKey,
    endpoint: task.endpoint,
    datasetId: task.datasetId,
    resource: task.source.connection.resource,
    pageSize: task.source.connection.pageSize,
    tokenConfigured: task.source.connection.tokenConfigured,
  })), [
    {
      role: 'chats', sourceKey: 'telegram-sqlite-api-chats', endpoint: '/v1/chats',
      datasetId: 'telegram.sqlite.chats.v1', resource: 'chats', pageSize: 500,
      tokenConfigured: true,
    },
    {
      role: 'messages', sourceKey: 'telegram-sqlite-api-messages', endpoint: '/v1/messages?include_deleted=true',
      datasetId: 'telegram.sqlite.messages.v1', resource: 'messages', pageSize: 500,
      tokenConfigured: true,
    },
  ])
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes(TOKEN), false)
  assert.equal(serialized.includes('"token"'), false)
  assert.match(result.tasks[0].cursor.error, /\[redacted\]/)
  assert.match(result.tasks[0].latestRun.error, /\[redacted\]/)
})

test('Telegram SQLite configure preserves a blank token and injects fixed child contracts', async () => {
  const fixture = pipelineFixture()
  const pipeline = new TelegramSQLitePipeline(fixture)

  await assert.rejects(
    () => pipeline.configure({ connection: { resource: 'messages' } }),
    (error) => error?.code === 'unsupported_pipeline_connection_fields',
  )
  const result = await pipeline.configure({
    connection: { baseUrl: 'https://sqlite.example.test', token: '' },
    syncIntervalSeconds: 600,
  })

  const tested = fixture.calls
    .filter(([kind]) => kind === 'testConnection')
    .map((call) => call[1])
  assert.deepEqual(tested, TELEGRAM_SQLITE_INPUTS.map((input) => ({
    baseUrl: 'https://sqlite.example.test',
    token: TOKEN,
    resource: input.resource,
    pageSize: 500,
  })))
  const update = fixture.calls.find(([kind]) => kind === 'updateBatch')[1]
  assert.deepEqual(update.map((entry) => ({
    sourceKey: entry.sourceKey,
    resource: entry.connection.resource,
    pageSize: entry.connection.pageSize,
    token: entry.connection.token,
    interval: entry.syncIntervalSeconds,
  })), [
    {
      sourceKey: 'telegram-sqlite-api-chats', resource: 'chats', pageSize: 500,
      token: TOKEN, interval: 600,
    },
    {
      sourceKey: 'telegram-sqlite-api-messages', resource: 'messages', pageSize: 500,
      token: TOKEN, interval: 600,
    },
  ])
  assert.equal(result.connection.baseUrl, 'https://sqlite.example.test')
  assert.equal(result.connection.tokenConfigured, true)
  assert.equal(result.syncIntervalSeconds, 600)
  assert.equal(JSON.stringify(result).includes(TOKEN), false)
})

test('Telegram SQLite activation gates both mappings, probes and checkpoints under source locks', async () => {
  const fixture = pipelineFixture()
  const pipeline = new TelegramSQLitePipeline(fixture)
  let blockedSource = 'telegram-sqlite-api-messages'
  fixture.sqliteApiPuller.describe = async (sourceKey, options = {}) => {
    fixture.calls.push(['describe', sourceKey, options.mappingOverride?.id ?? null])
    return { issues: sourceKey === blockedSource ? ['upstream shape mismatch'] : [] }
  }

  await assert.rejects(
    () => pipeline.setStatus('active'),
    (error) => error?.code === 'source_probe_failed' && error.details.sourceKey === blockedSource,
  )
  assert.equal(fixture.calls.some(([kind]) => kind === 'approveBatch'), false)
  assert.equal([...fixture.sources.values()].every((source) => source.status === 'paused'), true)

  blockedSource = null
  const result = await pipeline.setStatus('active', { approvedBy: 'operator-1' })
  assert.equal(result.status, 'active')
  assert.equal(fixture.calls.filter(([kind]) => kind === 'testConnection').length, 2)
  assert.deepEqual(
    fixture.calls.filter(([kind]) => kind === 'checkpoint').map(([, sourceKey, mappingId]) => [sourceKey, mappingId]),
    TELEGRAM_SQLITE_INPUTS.map((input) => [input.sourceKey, input.builtInMappingId]),
  )
  const approval = fixture.calls.find(([kind]) => kind === 'approveBatch')
  assert.equal(approval[2], 'operator-1')
  assert.deepEqual(approval[1], TELEGRAM_SQLITE_INPUTS.map((input) => ({
    mappingId: input.builtInMappingId,
    sourceId: `source-${input.role}`,
    version: TELEGRAM_SQLITE_MAPPING_VERSION,
  })))
  assert.equal([...fixture.activeMappings.values()].every((mapping) => mapping.approved), true)
  assert.equal([...fixture.sources.values()].every((source) => source.status === 'active'), true)
  assert.deepEqual(
    fixture.calls.filter(([kind]) => kind === 'locks').at(-1)[1],
    TELEGRAM_SQLITE_INPUTS.map((input) => input.sourceKey),
  )
})

test('Telegram SQLite activation upgrades only the known v1 built-in mappings', async () => {
  const fixture = pipelineFixture()
  for (const input of TELEGRAM_SQLITE_INPUTS) {
    fixture.activeMappings.set(`source-${input.role}`, {
      id: V1_BUILT_IN_MAPPING_IDS[input.role],
      sourceId: `source-${input.role}`,
      version: 1,
      approved: true,
    })
  }

  const result = await new TelegramSQLitePipeline(fixture).setStatus('active', {
    approvedBy: 'mapping-upgrader',
  })

  assert.equal(result.status, 'active')
  assert.deepEqual(
    [...fixture.activeMappings.values()].map((mapping) => [mapping.id, mapping.version]),
    TELEGRAM_SQLITE_INPUTS.map((input) => [input.builtInMappingId, TELEGRAM_SQLITE_MAPPING_VERSION]),
  )
  assert.equal(fixture.calls.find(([kind]) => kind === 'approveBatch')[2], 'mapping-upgrader')

  const conflicted = pipelineFixture()
  conflicted.activeMappings.set('source-messages', {
    id: 'custom-mapping', sourceId: 'source-messages', version: 1, approved: true,
  })
  await assert.rejects(
    () => new TelegramSQLitePipeline(conflicted).setStatus('active'),
    (error) => error?.code === 'builtin_mapping_conflict',
  )
})

test('Telegram SQLite pause stops both sources immediately and drains before reconfiguration', async () => {
  const fixture = pipelineFixture()
  for (const source of fixture.sources.values()) source.status = 'active'
  fixture.cursors.get('external:telegram-sqlite-api-messages').status = 'running'
  const pipeline = new TelegramSQLitePipeline(fixture)

  const paused = await pipeline.setStatus('paused')
  assert.equal(paused.status, 'paused')
  assert.equal(paused.draining, true)
  assert.equal(fixture.calls.some(([kind]) => kind === 'locks'), false)
  assert.equal([...fixture.sources.values()].every((source) => source.status === 'paused'), true)
  await assert.rejects(
    () => pipeline.configure({ syncIntervalSeconds: 900 }),
    (error) => error?.code === 'source_draining',
  )

  fixture.cursors.get('external:telegram-sqlite-api-messages').status = 'idle'
  const configured = await pipeline.configure({ syncIntervalSeconds: 900 })
  assert.equal(configured.draining, false)
  assert.equal(configured.syncIntervalSeconds, 900)
})

test('Telegram SQLite manual sync enqueues both tasks atomically with durable dedupe keys', async () => {
  const fixture = pipelineFixture()
  for (const source of fixture.sources.values()) source.status = 'active'
  const result = await new TelegramSQLitePipeline(fixture).sync({ batchSize: 400 })

  assert.deepEqual(
    fixture.calls.filter(([kind]) => kind === 'queueTx').map(([, sql]) => sql),
    ['BEGIN', 'COMMIT'],
  )
  assert.deepEqual(fixture.calls.filter(([kind]) => kind === 'enqueue').map((call) => ({
    queue: call[1],
    payload: call[2],
    options: call[3],
  })), TELEGRAM_SQLITE_INPUTS.map((input) => ({
    queue: 'external-pull',
    payload: { sourceKey: input.sourceKey, batchSize: 400, trigger: 'manual', chunk: 0 },
    options: { dedupeKey: `external-pull:${input.sourceKey}:0`, priority: 220 },
  })))
  assert.deepEqual(result.tasks.map((task) => task.alreadyScheduled), [false, false])
  assert.deepEqual(result.strategy, TELEGRAM_SQLITE_STRATEGY)

  const failed = pipelineFixture()
  for (const source of failed.sources.values()) source.status = 'active'
  failed.queue.enqueue = async (_queueName, payload, options) => {
    assert.ok(options.client)
    if (payload.sourceKey.endsWith('messages')) throw new Error('queue unavailable')
    return 1
  }
  await assert.rejects(
    () => new TelegramSQLitePipeline(failed).sync(),
    (error) => error?.code === 'pipeline_sync_enqueue_failed',
  )
  assert.deepEqual(
    failed.calls.filter(([kind]) => kind === 'queueTx').map(([, sql]) => sql),
    ['BEGIN', 'ROLLBACK'],
  )
})

test('Telegram SQLite reset uses both built-in mappings and progress aggregates both resources', async () => {
  const fixture = pipelineFixture()
  const pipeline = new TelegramSQLitePipeline(fixture)

  await assert.rejects(
    () => pipeline.resetCheckpoints('wrong-pipeline'),
    (error) => error?.code === 'checkpoint_reset_confirmation_required',
  )
  const reset = await pipeline.resetCheckpoints(TELEGRAM_SQLITE_PIPELINE_KEY)
  assert.equal(reset.resets.length, 2)
  assert.deepEqual(reset.strategy, TELEGRAM_SQLITE_STRATEGY)
  const resetCall = fixture.calls.find(([kind]) => kind === 'reset')
  assert.deepEqual(resetCall[1], TELEGRAM_SQLITE_INPUTS.map((input) => input.sourceKey))
  assert.deepEqual(
    Object.entries(resetCall[2]).map(([sourceKey, mapping]) => [sourceKey, mapping.id, mapping.version]),
    TELEGRAM_SQLITE_INPUTS.map((input) => [
      input.sourceKey, input.builtInMappingId, TELEGRAM_SQLITE_MAPPING_VERSION,
    ]),
  )

  const progress = await pipeline.progress()
  assert.equal(progress.totalRows, 100)
  assert.equal(progress.completedRows, 50)
  assert.equal(progress.remainingRows, 50)
  assert.equal(progress.percent, 50)
  assert.deepEqual(progress.tasks.map((task) => task.role), ['chats', 'messages'])
  assert.equal(progress.tasks.every((task) => task.checkedAt === progress.checkedAt), true)
})

test('Telegram SQLite v2 migration promotes search fields and installs scoped query indexes', async () => {
  const sql = await readFile(new URL('../../migrations/025_telegram_sqlite_search_mapping.sql', import.meta.url), 'utf8')

  assert.match(sql, /"title":\{"from":"chat_title"\}/u)
  assert.match(sql, /"contentType":\{"from":\["media_type","message_kind"\]\}/u)
  assert.match(sql, /"attributes\.chatUsername":\{"from":"chat_username"\}/u)
  assert.match(sql, /"attributes\.mediaType":\{"from":"media_type"\}/u)
  for (const input of TELEGRAM_SQLITE_INPUTS) {
    assert.match(sql, new RegExp(input.builtInMappingId, 'u'))
  }
  for (const indexName of [
    'canonical_sqlite_tg_messages_chat_time_idx',
    'canonical_sqlite_tg_messages_deleted_idx',
    'canonical_sqlite_tg_messages_chat_username_trgm_idx',
    'canonical_sqlite_tg_messages_media_type_idx',
  ]) {
    assert.match(sql, new RegExp(indexName, 'u'))
  }
})


test('one task failing its diagnostics never blanks the other task', async () => {
  const fixture = pipelineFixture()
  fixture.sqliteApiPuller.progress = async (sourceKey) => {
    if (sourceKey.endsWith('messages')) {
      throw new AppError(503, 'sqlite_api_unavailable', 'SQLite API did not return a response (ECONNREFUSED)')
    }
    return { totalRows: 10, completedRows: 5, remainingRows: 5, percent: 50, cursor: null }
  }

  const progress = await new TelegramSQLitePipeline(fixture).progress()
  const [chats, messages] = progress.tasks
  assert.deepEqual(progress.tasks.map((task) => task.role), ['chats', 'messages'])

  // The healthy task keeps reporting everything it knows.
  assert.equal(chats.totalRows, 10)
  assert.equal(chats.percent, 50)

  // The failed one carries its own diagnosis rather than a 503 for the page.
  assert.equal(messages.blocker, 'sqlite_api_unavailable')
  assert.match(messages.probeError.message, /ECONNREFUSED/)
  assert.equal(messages.totalRows, null)

  // Aggregates stay honest: an unknown total is not silently counted as zero.
  assert.equal(progress.totalRows, null)
  assert.equal(progress.percent, null)
  assert.equal(progress.tasks.every((task) => task.checkedAt === progress.checkedAt), true)
})


test('resuming a failed task clears the status without replaying its checkpoint', async () => {
  const fixture = pipelineFixture()
  const checkpoint = { cycle: null, lastMessageAt: '2026-08-17T00:00:00.000Z', lastSweepRows: 23_000 }
  fixture.cursors.set('external:telegram-sqlite-api-chats', {
    id: 'external:telegram-sqlite-api-chats', status: 'idle', position: { lastSweepRows: 124 },
  })
  fixture.cursors.set('external:telegram-sqlite-api-messages', {
    id: 'external:telegram-sqlite-api-messages',
    status: 'failed',
    position: checkpoint,
    error: 'sqlite_api_unavailable',
  })
  const saved = []
  fixture.queue.saveCursor = async (id, position, options) => {
    saved.push({ id, position, options })
    return { id, position, ...options }
  }

  const result = await new TelegramSQLitePipeline(fixture).resumeFailedTasks()

  // Only the failed task is touched.
  assert.equal(saved.length, 1)
  assert.equal(saved[0].id, 'external:telegram-sqlite-api-messages')
  assert.equal(saved[0].options.status, 'idle')
  assert.equal(saved[0].options.error, null)
  // The durable position survives: recovering from a network blip must not cost
  // a full re-read, which is what a checkpoint reset would have meant.
  assert.deepEqual(saved[0].position, checkpoint)
  assert.equal(saved[0].options.processedDelta, 0)

  const messages = result.tasks.find((task) => task.sourceKey.endsWith('messages'))
  assert.equal(messages.resumed, true)
  assert.equal(messages.clearedError, 'sqlite_api_unavailable')
  const chats = result.tasks.find((task) => task.sourceKey.endsWith('chats'))
  assert.equal(chats.resumed, false)
})

test('a draining task is never resumed out from under itself', async () => {
  const fixture = pipelineFixture()
  fixture.cursors.set('external:telegram-sqlite-api-messages', {
    id: 'external:telegram-sqlite-api-messages', status: 'running', position: {},
  })
  await assert.rejects(
    () => new TelegramSQLitePipeline(fixture).resumeFailedTasks(),
    (error) => error.code === 'source_draining',
  )
})


test('a run silent past the threshold is recovered from its checkpoint', async () => {
  const fixture = pipelineFixture()
  const checkpoint = { cycle: { mode: 'incremental', page: 47 }, lastSweepRows: 23_000 }
  fixture.cursors.set('external:telegram-sqlite-api-chats', {
    id: 'external:telegram-sqlite-api-chats', status: 'idle', position: {},
    updated_at: new Date().toISOString(),
  })
  // The worker died two days ago; the cursor still claims to be running, which
  // makes isDue false and freezes the paired task too.
  fixture.cursors.set('external:telegram-sqlite-api-messages', {
    id: 'external:telegram-sqlite-api-messages',
    status: 'running',
    position: checkpoint,
    updated_at: new Date(Date.now() - 48 * 3_600_000).toISOString(),
  })
  const saved = []
  fixture.queue.saveCursor = async (id, position, options) => {
    saved.push({ id, position, options })
    return { id, position, ...options }
  }

  const result = await new TelegramSQLitePipeline(fixture).resumeFailedTasks()

  assert.equal(saved.length, 1)
  assert.equal(saved[0].options.status, 'idle')
  // The durable checkpoint is what makes this cheap: no re-read, no reset.
  assert.deepEqual(saved[0].position, checkpoint)
  const messages = result.tasks.find((task) => task.sourceKey.endsWith('messages'))
  assert.equal(messages.resumed, true)
  assert.equal(messages.from, 'abandoned_run')
  assert.ok(messages.silentForMs > 47 * 3_600_000)
})

test('a run still within the threshold is left alone', async () => {
  const fixture = pipelineFixture()
  fixture.cursors.set('external:telegram-sqlite-api-messages', {
    id: 'external:telegram-sqlite-api-messages',
    status: 'running',
    position: {},
    // One cycle old: this is a live batch, not a lost one.
    updated_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  })

  await assert.rejects(
    () => new TelegramSQLitePipeline(fixture).resumeFailedTasks(),
    (error) => {
      assert.equal(error.code, 'source_draining')
      // Naming the task saves an operator from guessing which half is busy.
      assert.deepEqual(error.details.sourceKeys, ['telegram-sqlite-api-messages'])
      return true
    },
  )
})
