import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createApp } from '../../server/app.mjs'
import { AppError } from '../../server/core/errors.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { DatabaseSourcePuller } from '../../server/ingest/external/database-source.mjs'
import {
  TELEGRAM_MONITOR_INPUTS,
  TELEGRAM_MONITOR_WRITER_CONTRACT_DIGEST,
  TELEGRAM_MONITOR_WRITER_CONTRACT_VERSION,
  TelegramMonitorPipeline,
} from '../../server/ingest/telegram/monitor-pipeline.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import {
  encodeTelegramSearchCursor,
  normalizeTelegramMonitorQuery,
  normalizeTelegramSearchQuery,
  publicTelegramMonitorRecord,
  telegramDataSearchResponse,
} from '../../server/data/telegram-monitor.mjs'

const ADMIN_TOKEN = 'test-admin-token'
const PEPPER = 'test-pepper-with-enough-entropy'
const WRITER_CONTRACT_ATTESTATION = Object.freeze({
  confirmed: true,
  contractVersion: TELEGRAM_MONITOR_WRITER_CONTRACT_VERSION,
  contractDigest: TELEGRAM_MONITOR_WRITER_CONTRACT_DIGEST,
})

test('Telegram page size keeps the server hard cap even when policy is larger', () => {
  assert.throws(
    () => normalizeTelegramMonitorQuery({ pageSize: '101' }, 500),
    (error) => error?.code === 'page_size_exceeded',
  )
  assert.equal(normalizeTelegramMonitorQuery({}, 500).pageSize, 50)
})

test('Telegram time filters require a complete valid ISO date-time', () => {
  for (const value of ['2026-08-09', '2026-08-09 10:00:00Z', '2026-02-30T10:00:00Z', '2026-08-09T25:00:00Z']) {
    assert.throws(
      () => normalizeTelegramMonitorQuery({ from: value }),
      (error) => error?.code === 'invalid_request' && /ISO date-time/.test(error.message),
    )
  }
  assert.equal(
    normalizeTelegramMonitorQuery({ from: '2026-08-09T10:00:00+08:00' }).from,
    '2026-08-09T02:00:00.000Z',
  )
})

test('Telegram query parameters reject explicit empty values', () => {
  for (const field of ['chatId', 'cursor', 'from', 'pageSize', 'to']) {
    assert.throws(
      () => normalizeTelegramMonitorQuery({ [field]: '' }),
      (error) => error?.status === 400 && error?.code === 'invalid_request',
      `${field} should reject an explicit empty value`,
    )
  }
  assert.deepEqual(normalizeTelegramMonitorQuery({}), {
    chatId: null,
    from: null,
    to: null,
    pageSize: 50,
    cursor: null,
  })
})

test('public Telegram records enforce field types and withhold unverified link objects', () => {
  const record = publicTelegramMonitorRecord({
    external_id: '-1007:42',
    dataset_id: 'telegram.monitor.messages.v1',
    object_type: 'message',
    event_time: new Date('2026-08-10T00:00:00.000Z'),
    collected_at: new Date('2026-08-10T00:01:00.000Z'),
    stable_fields: {
      relations: { chatId: '-1007', messageId: '42', threadId: { private: true } },
      attributes: { username: 'alice', memberCount: { private: true } },
      metrics: { views: 10, likes: Number.POSITIVE_INFINITY, shares: { private: true } },
      media: { media_kind: 'image', size_bytes: 100, status: { private: true } },
      entities: [{ type: 'url', offset: 0, length: 5, url: 'https://example.test', private: 'no' }],
      links: [{ url: 'https://t.me/example', ownerAccountId: 9, credential: 'must-not-leak' }],
      source: { origin: 'database', providerKey: 'must-not-leak' },
    },
    current_revision: 2,
  })
  assert.deepEqual(record.relations, { chatId: '-1007', messageId: '42' })
  assert.deepEqual(record.attributes, { username: 'alice' })
  assert.deepEqual(record.metrics, { views: 10 })
  assert.deepEqual(record.media, { media_kind: 'image', size_bytes: 100 })
  assert.deepEqual(record.entities, [{ type: 'url', offset: 0, length: 5, url: 'https://example.test' }])
  assert.deepEqual(record.links, [])
  assert.equal(JSON.stringify(record).includes('must-not-leak'), false)
})

test('Night-All v1 Telegram search maps negative metric sentinels to null', () => {
  const response = telegramDataSearchResponse({
    query: 'sentinel',
    result: {
      mode: 'elasticsearch',
      total: 1,
      items: [{
        id: '11111111-1111-4111-8111-111111111111',
        externalId: '-1007:42',
        objectType: 'message',
        metrics: { likes: -1, comments: -1, shares: -1, views: -1, bookmarks: -1 },
      }],
    },
    pageSize: 1,
    cursor: null,
    cursorBinding: 'not-used-without-another-page',
    cursorSecret: PEPPER,
    durationMs: 0,
  })

  assert.deepEqual(response.data.items[0].metrics, {
    likes: null,
    comments: null,
    shares: null,
    views: null,
    bookmarks: null,
  })
})

test('Telegram search cursors exceed 10k safely and are bound to the normalized query and filters', () => {
  const input = {
    query: 'keyword', scope: 'messages', chatId: '-1007', authorId: 'user-1',
    from: '2026-08-01T00:00:00Z', to: '2026-08-10T23:59:59Z', pageSize: 50,
  }
  const first = normalizeTelegramSearchQuery(input, 100, PEPPER)
  const cursor = encodeTelegramSearchCursor({
    mode: 'postgres',
    pitId: null,
    searchAfter: ['2026-08-05T00:00:00.000Z', '11111111-1111-4111-8111-111111111111'],
    seen: 10_050,
  }, first.cursorBinding, PEPPER)
  const resumed = normalizeTelegramSearchQuery({ ...input, cursor }, 100, PEPPER)
  assert.equal(resumed.cursor.seen, 10_050)
  assert.deepEqual(resumed.cursor.searchAfter, [
    '2026-08-05T00:00:00.000Z',
    '11111111-1111-4111-8111-111111111111',
  ])

  const esCursor = encodeTelegramSearchCursor({
    mode: 'elasticsearch',
    pitId: 'pit-renewed',
    searchAfter: [12.5, 9_223_372_036_854_775_000, '11111111-1111-4111-8111-111111111111', 42],
    seen: 100,
  }, first.cursorBinding, PEPPER)
  assert.deepEqual(
    normalizeTelegramSearchQuery({ ...input, cursor: esCursor }, 100, PEPPER).cursor,
    {
      mode: 'elasticsearch',
      pitId: 'pit-renewed',
      searchAfter: [12.5, 9_223_372_036_854_775_000, '11111111-1111-4111-8111-111111111111', 42],
      seen: 100,
    },
  )

  for (const changed of [
    { ...input, query: 'different', cursor },
    { ...input, chatId: '-1008', cursor },
    { ...input, pageSize: 25, cursor },
  ]) {
    assert.throws(
      () => normalizeTelegramSearchQuery(changed, 100, PEPPER),
      (error) => error?.code === 'invalid_cursor',
    )
  }
})

async function withServer(app, callback) {
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await callback(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function call(baseUrl, path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { response, payload: await response.json() }
}

function telegramPipelineFixture() {
  const sources = new Map([
    ['telegram-monitor-chats', {
      id: 'source-chats', sourceKey: 'telegram-monitor-chats', displayName: 'Telegram chats',
      sourceKind: 'database', datasetId: 'telegram.monitor.chats.v1', platform: 'telegram',
      objectType: 'chat', status: 'paused', syncIntervalSeconds: 300,
      connection: {
        host: 'database.internal', port: 5432, database: 'night_all', username: 'mx_data',
        password: 'private', sslMode: 'disable', schema: 'public', table: 'tg_monitor_chats',
        cursorColumn: 'updated_at', idColumn: 'chat_id',
      },
    }],
    ['telegram-monitor-messages', {
      id: 'source-messages', sourceKey: 'telegram-monitor-messages', displayName: 'Telegram messages',
      sourceKind: 'database', datasetId: 'telegram.monitor.messages.v1', platform: 'telegram',
      objectType: 'message', status: 'paused', syncIntervalSeconds: 300,
      connection: {
        host: 'database.internal', port: 5432, database: 'night_all', username: 'mx_data',
        password: 'private', sslMode: 'disable', schema: 'public', table: 'tg_monitor_messages',
        cursorColumn: 'updated_at', idColumn: 'id',
      },
    }],
  ])
  const mappings = new Map([
    ['source-chats', [{
      id: TELEGRAM_MONITOR_INPUTS[0].builtInMappingId,
      sourceId: 'source-chats', version: 2, approved: false,
    }]],
    ['source-messages', [{
      id: TELEGRAM_MONITOR_INPUTS[1].builtInMappingId,
      sourceId: 'source-messages', version: 2, approved: false,
    }]],
  ])
  const activeMappings = new Map()
  let latestAttestation = null
  const cursors = new Map(TELEGRAM_MONITOR_INPUTS.map((input) => [
    `external:${input.sourceKey}`,
    { status: 'idle', position: {}, updatedAt: '2026-08-10T00:00:00.000Z' },
  ]))
  const calls = []
  const store = {
    getExternalSource: async (key) => sources.get(key) ?? null,
    getActiveMapping: async (sourceId) => activeMappings.get(sourceId) ?? null,
    listSourceMappings: async (sourceId) => mappings.get(sourceId) ?? [],
    listImportRuns: async (sourceId) => [{ id: `run-${sourceId}`, status: 'succeeded' }],
    getLatestPipelineWriterContractAttestation: async () => latestAttestation,
    updateExternalSourcesBatch: async (updates) => {
      calls.push(['updateBatch', structuredClone(updates)])
      for (const update of updates) {
        const source = sources.get(update.sourceKey)
        sources.set(update.sourceKey, {
          ...source,
          ...(update.status == null ? {} : { status: update.status }),
          ...(update.connection == null ? {} : { connection: update.connection }),
          ...(update.syncIntervalSeconds == null ? {} : { syncIntervalSeconds: update.syncIntervalSeconds }),
        })
      }
      return updates.map((update) => sources.get(update.sourceKey))
    },
    activateExternalSourcesWithAttestation: async (input) => {
      calls.push(['activateWithAttestation', structuredClone(input)])
      const { approvals, attestedBy } = input
      for (const approval of approvals) {
        const mapping = mappings.get(approval.sourceId).find((candidate) => (
          candidate.id === approval.mappingId && candidate.version === approval.version
        ))
        if (!mapping) throw new AppError(409, 'builtin_mapping_conflict', 'mapping changed')
        activeMappings.set(approval.sourceId, { ...mapping, approved: true })
      }
      for (const source of sources.values()) source.status = 'active'
      latestAttestation = {
        id: 'attestation-1', pipelineKey: input.pipelineKey,
        contractVersion: input.contractVersion, contractDigest: input.contractDigest,
        contractSummary: input.contractSummary, attestedBy,
        attestedAt: '2026-08-10T00:00:00.000Z',
      }
      return { sources: [...sources.values()], attestation: latestAttestation }
    },
  }
  const databasePuller = {
    withSourceLocks: async (keys, operation) => {
      calls.push(['locks', [...keys]])
      return operation()
    },
    testConnection: async (connection) => {
      calls.push(['testConnection', structuredClone(connection)])
      return { database: connection.database, user: connection.username, readOnly: true }
    },
    assertCheckpointCompatible: async (key, options) => {
      calls.push(['checkpoint', key, options?.mappingOverride?.id])
      return { compatible: true }
    },
    describe: async (key, options) => {
      calls.push(['describe', key, options?.mappingOverride?.id])
      return { issues: [] }
    },
    progress: async (key) => ({
      totalRows: key.endsWith('chats') ? 10 : 90,
      completedRows: key.endsWith('chats') ? 5 : 45,
      remainingRows: key.endsWith('chats') ? 5 : 45,
      percent: 50,
      cursor: cursors.get(`external:${key}`),
    }),
  }
  const queueClient = {
    query: async (sql) => {
      calls.push(['queueTx', sql])
      return { rows: [] }
    },
    release: () => calls.push(['queueRelease']),
  }
  const queue = {
    pool: { connect: async () => queueClient },
    getCursor: async (id) => cursors.get(id) ?? null,
    enqueue: async (queueName, payload, options) => {
      const { client, ...loggedOptions } = options
      assert.equal(client, queueClient)
      calls.push(['enqueue', queueName, structuredClone(payload), structuredClone(loggedOptions)])
      return calls.filter(([kind]) => kind === 'enqueue').length
    },
  }
  return { sources, mappings, activeMappings, cursors, calls, store, databasePuller, queue }
}

test('Telegram monitor pipeline exposes one consistent connection and fixed task contracts', async () => {
  const fixture = telegramPipelineFixture()
  const pipeline = new TelegramMonitorPipeline(fixture)
  const result = await pipeline.get()

  assert.equal(result.status, 'paused')
  assert.equal(result.configured, true)
  assert.equal(result.connectionConsistent, true)
  assert.equal(result.syncIntervalConsistent, true)
  assert.deepEqual(result.connection, {
    host: 'database.internal', port: 5432, database: 'night_all', username: 'mx_data',
    password: 'private', sslMode: 'disable',
  })
  assert.equal(result.syncIntervalSeconds, 300)
  assert.equal(result.writerContract.version, TELEGRAM_MONITOR_WRITER_CONTRACT_VERSION)
  assert.equal(result.writerContract.digest, TELEGRAM_MONITOR_WRITER_CONTRACT_DIGEST)
  assert.equal(result.writerContract.latestAttestation, null)
  assert.deepEqual(result.tasks.map((task) => ({
    role: task.role,
    sourceKey: task.sourceKey,
    table: task.table,
    cursorColumn: task.cursorColumn,
    idColumn: task.idColumn,
    builtInMappingAvailable: task.builtInMappingAvailable,
  })), [
    {
      role: 'chats',
      sourceKey: 'telegram-monitor-chats', table: 'tg_monitor_chats',
      cursorColumn: 'updated_at', idColumn: 'chat_id', builtInMappingAvailable: true,
    },
    {
      role: 'messages',
      sourceKey: 'telegram-monitor-messages', table: 'tg_monitor_messages',
      cursorColumn: 'updated_at', idColumn: 'id', builtInMappingAvailable: true,
    },
  ])
  const progress = await pipeline.progress()
  assert.equal(progress.totalRows, 100)
  assert.equal(progress.completedRows, 50)
  assert.deepEqual(progress.tasks.map((task) => task.role), ['chats', 'messages'])
  assert.equal(progress.tasks.every((task) => task.checkedAt === progress.checkedAt), true)

  const messages = fixture.sources.get('telegram-monitor-messages')
  messages.status = 'active'
  messages.syncIntervalSeconds = 60
  messages.connection = { ...messages.connection, host: 'drifted.internal', table: 'drifted_messages' }
  const drifted = await pipeline.get()
  assert.equal(drifted.status, 'mixed')
  assert.equal(drifted.configured, false)
  assert.equal(drifted.connection, null)
  assert.equal(drifted.connectionConsistent, false)
  assert.equal(drifted.syncIntervalConsistent, false)
  assert.equal(drifted.inputContractsConsistent, false)
  assert.match(drifted.configurationIssues.join(' '), /telegram-monitor-messages table/)
})

test('Telegram monitor configuration probes once and atomically injects fixed tables and cursors', async () => {
  const fixture = telegramPipelineFixture()
  const pipeline = new TelegramMonitorPipeline(fixture)
  await assert.rejects(
    () => pipeline.configure({
      connection: {
        host: 'new.internal', database: 'night_all', username: 'mx_data', password: 'private',
        schema: 'attacker', table: 'attacker_table',
      },
    }),
    (error) => error?.code === 'unsupported_pipeline_connection_fields',
  )
  await assert.rejects(
    () => pipeline.configure({ connection: { schema: 'public' } }),
    (error) => (
      error?.code === 'unsupported_pipeline_connection_fields'
      && error.message.includes('schema')
    ),
  )

  const result = await pipeline.configure({
    connection: {
      host: 'new.internal', port: 5432, database: 'night_all', username: 'mx_data',
      password: 'rotated', sslMode: 'disable',
    },
    syncIntervalSeconds: 600,
  })
  const tests = fixture.calls.filter(([kind]) => kind === 'testConnection')
  assert.equal(tests.length, 1)
  assert.equal(tests[0][1].table, 'tg_monitor_chats')
  assert.equal(tests[0][1].schema, 'public')
  assert.equal(tests[0][1].cursorColumn, 'updated_at')
  assert.equal(tests[0][1].idColumn, 'chat_id')
  const update = fixture.calls.find(([kind]) => kind === 'updateBatch')[1]
  assert.deepEqual(update.map((entry) => [
    entry.sourceKey, entry.connection.table, entry.connection.cursorColumn, entry.connection.idColumn,
  ]), [
    ['telegram-monitor-chats', 'tg_monitor_chats', 'updated_at', 'chat_id'],
    ['telegram-monitor-messages', 'tg_monitor_messages', 'updated_at', 'id'],
  ])
  assert.equal(result.connection.host, 'new.internal')
  assert.equal(result.syncIntervalSeconds, 600)
})

test('Telegram monitor activation probes before one atomic mapping, status and attestation write', async () => {
  const fixture = telegramPipelineFixture()
  let badSource = 'telegram-monitor-messages'
  fixture.databasePuller.describe = async (key, options) => {
    fixture.calls.push(['describe', key, options?.mappingOverride?.id])
    return { issues: key === badSource ? ['missing safe index'] : [] }
  }
  const pipeline = new TelegramMonitorPipeline(fixture)
  const messages = fixture.sources.get('telegram-monitor-messages')
  messages.connection = { ...messages.connection, table: 'drifted_messages' }
  await assert.rejects(
    () => pipeline.setStatus('active'),
    (error) => error?.code === 'pipeline_configuration_drift' && /table/.test(error?.details?.issues?.[0]),
  )
  messages.connection = { ...messages.connection, table: 'tg_monitor_messages' }
  messages.syncIntervalSeconds = 60
  await assert.rejects(
    () => pipeline.setStatus('active'),
    (error) => error?.code === 'pipeline_configuration_drift' && /sync interval/.test(error?.details?.issues?.join(' ')),
  )
  messages.syncIntervalSeconds = 300
  await assert.rejects(
    () => pipeline.setStatus('active'),
    (error) => error?.code === 'source_probe_failed' && error?.details?.sourceKey === badSource,
  )
  assert.equal([...fixture.sources.values()].every((source) => source.status === 'paused'), true)
  assert.equal(fixture.calls.some(([kind]) => kind === 'activateWithAttestation'), false)

  badSource = null
  await assert.rejects(
    () => pipeline.setStatus('active'),
    (error) => error?.code === 'writer_contract_attestation_required',
  )
  assert.equal(fixture.calls.some(([kind]) => kind === 'activateWithAttestation'), false)
  assert.equal([...fixture.sources.values()].every((source) => source.status === 'paused'), true)

  const activated = await pipeline.setStatus('active', {
    approvedBy: 'operator-1',
    writerContractAttestation: WRITER_CONTRACT_ATTESTATION,
  })
  assert.equal(activated.status, 'active')
  assert.equal(activated.writerContract.latestAttestation.attestedBy, 'operator-1')
  const activation = fixture.calls.find(([kind]) => kind === 'activateWithAttestation')[1]
  assert.deepEqual(activation.approvals, [
    {
      mappingId: TELEGRAM_MONITOR_INPUTS[0].builtInMappingId,
      sourceId: 'source-chats', version: 2,
    },
    {
      mappingId: TELEGRAM_MONITOR_INPUTS[1].builtInMappingId,
      sourceId: 'source-messages', version: 2,
    },
  ])
  assert.equal(activation.contractVersion, TELEGRAM_MONITOR_WRITER_CONTRACT_VERSION)
  assert.equal(activation.contractDigest, TELEGRAM_MONITOR_WRITER_CONTRACT_DIGEST)
  assert.equal(activation.attestedBy, 'operator-1')

  const paused = await pipeline.setStatus('paused')
  assert.equal(paused.status, 'paused')
  assert.equal(fixture.calls.some(([kind, updates]) => (
    kind === 'updateBatch' && updates.every((update) => update.status === 'paused')
  )), true)
})

test('Telegram monitor rejects a version-2 mapping collision instead of treating it as built in', async () => {
  const fixture = telegramPipelineFixture()
  fixture.mappings.set('source-messages', [{
    id: '11111111-1111-4111-8111-111111111111',
    sourceId: 'source-messages', version: 2, approved: false,
  }])
  const pipeline = new TelegramMonitorPipeline(fixture)
  const aggregate = await pipeline.get()
  assert.equal(aggregate.tasks.find((task) => task.role === 'messages').builtInMappingAvailable, false)
  await assert.rejects(
    () => pipeline.setStatus('active', {
      writerContractAttestation: WRITER_CONTRACT_ATTESTATION,
    }),
    (error) => error?.code === 'builtin_mapping_conflict',
  )
  assert.equal(fixture.calls.some(([kind]) => kind === 'activateWithAttestation'), false)
})

test('Telegram monitor pipeline reset replaces legacy v1 checkpoints with the fixed v2 contract', async () => {
  const fixture = telegramPipelineFixture()
  for (const input of TELEGRAM_MONITOR_INPUTS) {
    fixture.activeMappings.set(fixture.sources.get(input.sourceKey).id, {
      id: `legacy-v1-${input.role}`,
      sourceId: fixture.sources.get(input.sourceKey).id,
      version: 1,
      approved: true,
    })
    fixture.cursors.get(`external:${input.sourceKey}`).position = { mappingVersion: 1 }
  }
  fixture.databasePuller.resetCheckpoints = async (keys, { mappingOverrides }) => {
    fixture.calls.push(['resetPipeline', [...keys], structuredClone(mappingOverrides)])
    for (const key of keys) {
      fixture.cursors.get(`external:${key}`).position = {
        mappingVersion: mappingOverrides[key].version,
        contractHash: `v${mappingOverrides[key].version}:${mappingOverrides[key].id}`,
      }
    }
    return keys.map((sourceKey) => ({ sourceKey }))
  }
  fixture.databasePuller.assertCheckpointCompatible = async (key, { mappingOverride }) => {
    const position = fixture.cursors.get(`external:${key}`).position
    if (position.mappingVersion !== mappingOverride.version) {
      throw new AppError(409, 'checkpoint_contract_mismatch', 'wrong mapping checkpoint')
    }
    return { compatible: true }
  }
  const pipeline = new TelegramMonitorPipeline(fixture)
  const reset = await pipeline.resetCheckpoints('telegram-monitor')
  assert.equal(reset.resets.length, 2)
  const resetCall = fixture.calls.find(([kind]) => kind === 'resetPipeline')
  assert.deepEqual(
    Object.entries(resetCall[2]).map(([sourceKey, mapping]) => [sourceKey, mapping.id, mapping.version]),
    TELEGRAM_MONITOR_INPUTS.map((input) => [input.sourceKey, input.builtInMappingId, 2]),
  )
  const activated = await pipeline.setStatus('active', {
    writerContractAttestation: WRITER_CONTRACT_ATTESTATION,
  })
  assert.equal(activated.status, 'active')
})

test('Telegram monitor routes require the admin token and queue both active tasks with existing dedupe keys', async () => {
  const fixture = telegramPipelineFixture()
  for (const source of fixture.sources.values()) source.status = 'active'
  fixture.store.getLatestPipelineWriterContractAttestation = async () => ({
    contractVersion: TELEGRAM_MONITOR_WRITER_CONTRACT_VERSION,
    contractDigest: TELEGRAM_MONITOR_WRITER_CONTRACT_DIGEST,
  })
  const app = createApp({
    service: {}, ...fixture,
    adapter: { dependencies: async () => ({ status: 'up' }) },
    adminToken: ADMIN_TOKEN,
  })
  await withServer(app, async (baseUrl) => {
    const denied = await call(baseUrl, '/internal/v1/admin/pipelines/telegram-monitor', {
      headers: { 'x-api-key': 'mih_live_not_admin' },
    })
    assert.equal(denied.response.status, 403)
    assert.equal(denied.payload.error.code, 'admin_token_required')

    const headers = { 'x-mx-insight-admin-token': ADMIN_TOKEN }
    const aggregate = await call(baseUrl, '/internal/v1/admin/pipelines/telegram-monitor', { headers })
    assert.equal(aggregate.response.status, 200)
    assert.equal(aggregate.payload.data.tasks.length, 2)

    const synced = await call(baseUrl, '/internal/v1/admin/pipelines/telegram-monitor/sync', {
      method: 'POST', headers, body: { batchSize: 2500 },
    })
    assert.equal(synced.response.status, 202)
    assert.equal(synced.payload.data.tasks.length, 2)
  })
  const enqueues = fixture.calls.filter(([kind]) => kind === 'enqueue')
  assert.deepEqual(enqueues.map(([, queueName, payload, options]) => ({ queueName, payload, options })), [
    {
      queueName: 'external-pull',
      payload: { sourceKey: 'telegram-monitor-chats', batchSize: 2500, trigger: 'manual', chunk: 0 },
      options: { dedupeKey: 'external-pull:telegram-monitor-chats:0', priority: 220 },
    },
    {
      queueName: 'external-pull',
      payload: { sourceKey: 'telegram-monitor-messages', batchSize: 2500, trigger: 'manual', chunk: 0 },
      options: { dedupeKey: 'external-pull:telegram-monitor-messages:0', priority: 220 },
    },
  ])
})

test('Telegram monitor child sources reject generic mutations but retain read-only inspection', async () => {
  const source = {
    id: 'source-messages', sourceKey: 'telegram-monitor-messages', sourceKind: 'database',
    status: 'active', syncIntervalSeconds: 300,
  }
  let mutated = false
  const store = {
    getExternalSource: async () => source,
    createExternalSource: async () => { mutated = true },
    updateExternalSource: async () => { mutated = true },
    createSourceMapping: async () => { mutated = true },
    approveSourceMapping: async () => { mutated = true },
    listSourceMappings: async () => [],
    listImportRuns: async () => [],
  }
  const databasePuller = {
    describe: async () => ({ issues: [], columns: [] }),
    preview: async () => ({ sampleShapes: [] }),
    testSource: async () => ({ readOnly: true }),
    resetCheckpoint: async () => { mutated = true },
  }
  const app = createApp({
    service: {}, store, databasePuller,
    importer: { importFile: async () => { mutated = true } },
    queue: {
      getCursor: async () => ({ status: 'idle' }),
      enqueue: async () => { mutated = true },
    },
    adapter: { dependencies: async () => ({ status: 'up' }) },
    adminToken: ADMIN_TOKEN,
  })
  await withServer(app, async (baseUrl) => {
    const headers = { 'x-mx-insight-admin-token': ADMIN_TOKEN }
    const mutations = [
      ['/internal/v1/admin/sources', {
        method: 'POST', body: {
          sourceKey: 'telegram-monitor-messages', displayName: 'replacement', sourceKind: 'database',
        },
      }],
      ['/internal/v1/admin/sources/telegram-monitor-messages', {
        method: 'PUT', body: { status: 'paused' },
      }],
      ['/internal/v1/admin/sources/telegram-monitor-messages/mappings', {
        method: 'POST', body: { fieldMap: { externalId: { from: 'id' } } },
      }],
      ['/internal/v1/admin/sources/telegram-monitor-messages/mappings/2/approve', { method: 'POST' }],
      ['/internal/v1/admin/sources/telegram-monitor-messages/sync', { method: 'POST' }],
      ['/internal/v1/admin/sources/telegram-monitor-messages/checkpoint/reset', {
        method: 'POST', body: { confirmSourceKey: 'telegram-monitor-messages' },
      }],
      ['/internal/v1/admin/sources/telegram-monitor-messages/import?filename=input.csv', {
        method: 'POST', body: { row: 1 },
      }],
    ]
    for (const [path, options] of mutations) {
      const result = await call(baseUrl, path, { ...options, headers })
      assert.equal(result.response.status, 409, path)
      assert.equal(result.payload.error.code, 'pipeline_managed_source', path)
    }

    for (const path of [
      '/internal/v1/admin/sources/telegram-monitor-messages',
      '/internal/v1/admin/sources/telegram-monitor-messages/mappings',
      '/internal/v1/admin/sources/telegram-monitor-messages/schema',
      '/internal/v1/admin/sources/telegram-monitor-messages/preview?limit=3',
      '/internal/v1/admin/sources/telegram-monitor-messages/sync',
      '/internal/v1/admin/sources/telegram-monitor-messages/imports',
    ]) {
      const result = await call(baseUrl, path, { headers })
      assert.equal(result.response.status, 200, path)
    }
    const tested = await call(baseUrl, '/internal/v1/admin/sources/telegram-monitor-messages/test', {
      method: 'POST', headers,
    })
    assert.equal(tested.response.status, 200)
  })
  assert.equal(mutated, false)
})

test('Telegram monitor manual sync rolls back when the second task cannot be enqueued', async () => {
  const fixture = telegramPipelineFixture()
  for (const source of fixture.sources.values()) source.status = 'active'
  const staged = []
  const committed = []
  fixture.queue.enqueue = async (_name, payload, options) => {
    assert.ok(options.client)
    if (payload.sourceKey === 'telegram-monitor-messages') throw new Error('queue unavailable')
    staged.push(payload.sourceKey)
    return 1
  }
  fixture.queue.pool = {
    connect: async () => ({
      async query(sql) {
        fixture.calls.push(['queueTx', sql])
        if (sql === 'COMMIT') committed.push(...staged)
        if (sql === 'ROLLBACK') staged.length = 0
        return { rows: [] }
      },
      release() {},
    }),
  }
  const pipeline = new TelegramMonitorPipeline(fixture)
  await assert.rejects(
    () => pipeline.sync({ batchSize: 500 }),
    (error) => error?.code === 'writer_contract_attestation_required',
  )
  fixture.store.getLatestPipelineWriterContractAttestation = async () => ({
    contractVersion: TELEGRAM_MONITOR_WRITER_CONTRACT_VERSION,
    contractDigest: TELEGRAM_MONITOR_WRITER_CONTRACT_DIGEST,
  })
  await assert.rejects(
    () => pipeline.sync({ batchSize: 500 }),
    (error) => error?.code === 'pipeline_sync_enqueue_failed',
  )
  assert.deepEqual(
    fixture.calls.filter(([kind]) => kind === 'queueTx').map(([, sql]) => sql),
    ['BEGIN', 'ROLLBACK'],
  )
  assert.deepEqual(committed, [])
  assert.deepEqual(staged, [])
})

test('database source progress counts exact composite-cursor remaining rows and redacts failures', async () => {
  const queries = []
  const source = {
    id: 'source-messages', sourceKey: 'telegram-monitor-messages', sourceKind: 'database',
    connection: {
      host: 'database.internal', database: 'night_all', username: 'mx_data', password: 'private',
      sslMode: 'disable', schema: 'public', table: 'tg_monitor_messages',
      cursorColumn: 'updated_at', idColumn: 'id',
    },
  }
  const pool = {
    async query(sql, values) {
      queries.push({ sql, values })
      if (/information_schema\.columns/.test(sql)) {
        return { rows: [
          { column_name: 'updated_at', data_type: 'timestamp with time zone', udt_name: 'timestamptz', is_nullable: 'NO', ordinal_position: 1 },
          { column_name: 'id', data_type: 'bigint', udt_name: 'int8', is_nullable: 'NO', ordinal_position: 2 },
        ] }
      }
      if (/FROM pg_indexes/.test(sql)) {
        return { rows: [
          { definition: 'CREATE INDEX messages_cursor_idx ON public.tg_monitor_messages (updated_at, id)' },
          { definition: 'CREATE UNIQUE INDEX messages_pkey ON public.tg_monitor_messages (id)' },
        ] }
      }
      return { rows: [{ total_rows: '100', remaining_rows: '25' }] }
    },
    async end() {},
  }
  const puller = new DatabaseSourcePuller({
    store: {
      getExternalSource: async () => source,
      getActiveMapping: async () => null,
    },
    queue: { getCursor: async () => ({ status: 'idle', position: { cursor: '2026-08-10T00:00:00Z', lastId: '50' } }) },
    poolFactory: () => pool,
  })
  const result = await puller.progress(source.sourceKey)
  assert.deepEqual({
    totalRows: result.totalRows,
    completedRows: result.completedRows,
    remainingRows: result.remainingRows,
    percent: result.percent,
  }, { totalRows: 100, completedRows: 75, remainingRows: 25, percent: 75 })
  const remainingQuery = queries.find(({ sql }) => /remaining_rows/.test(sql))
  assert.match(remainingQuery.sql, /\("updated_at", "id"\) > \(\$1::timestamptz, \$2::bigint\)/)
  assert.deepEqual(remainingQuery.values, ['2026-08-10T00:00:00Z', '50'])

  const initialPuller = new DatabaseSourcePuller({
    store: puller.store,
    queue: { getCursor: async () => null },
    poolFactory: () => pool,
  })
  const initial = await initialPuller.progress(source.sourceKey)
  assert.equal(initial.totalRows, 100)
  assert.equal(initial.completedRows, null)
  assert.equal(initial.remainingRows, null)
  assert.equal(initial.percent, null)
  assert.equal(initial.blocker, null)

  const missingCursorPuller = new DatabaseSourcePuller({
    store: puller.store,
    queue: puller.queue,
    poolFactory: () => ({
      async query(sql) {
        if (/information_schema\.columns/.test(sql)) {
          return { rows: [
            { column_name: 'id', data_type: 'bigint', udt_name: 'int8', is_nullable: 'NO', ordinal_position: 1 },
          ] }
        }
        return { rows: [{ total_rows: '163401' }] }
      },
      async end() {},
    }),
  })
  const blocked = await missingCursorPuller.progress(source.sourceKey)
  assert.equal(blocked.totalRows, 163_401)
  assert.equal(blocked.completedRows, null)
  assert.equal(blocked.remainingRows, null)
  assert.equal(blocked.percent, null)
  assert.equal(blocked.blocker, 'source_cursor_unsafe')
  assert.deepEqual(blocked.issues, ['cursor column updated_at is missing'])

  const failedPuller = new DatabaseSourcePuller({
    store: puller.store,
    queue: puller.queue,
    poolFactory: () => ({
      async query() {
        const error = new Error('password=private host=database.internal')
        error.code = 'ECONNRESET'
        throw error
      },
      async end() {},
    }),
  })
  await assert.rejects(
    () => failedPuller.progress(source.sourceKey),
    (error) => (
      error?.code === 'source_progress_failed'
      && !error.message.includes('private')
      && !error.message.includes('database.internal')
    ),
  )
})

test('admin database source routes expose schema/preview and schedule a bounded sync', async () => {
  const calls = []
  const source = { sourceKey: 'warehouse-events', sourceKind: 'database', status: 'active' }
  const store = {
    getExternalSource: async () => source,
  }
  const databasePuller = {
    describe: async (key) => {
      calls.push(['describe', key])
      return { source: { sourceKey: key }, columns: [{ name: 'message_id', dataType: 'bigint' }], issues: [] }
    },
    preview: async (key, options) => {
      calls.push(['preview', key, options])
      return { source: { sourceKey: key }, sampleShapes: [{ message_id: { jsonType: 'number', isNull: false, serializedLength: 2 } }] }
    },
  }
  const queue = {
    getCursor: async () => ({ status: 'idle', position: { cursor: '2026-08-01T00:00:00Z', lastId: '9' } }),
    stats: async () => [{ status: 'pending', count: 0 }],
    enqueue: async (...args) => {
      calls.push(['enqueue', ...args])
      return 77
    },
  }
  const app = createApp({
    service: {}, store, databasePuller, queue,
    adapter: { dependencies: async () => ({ status: 'up' }) },
    adminToken: ADMIN_TOKEN,
  })
  await withServer(app, async (baseUrl) => {
    const headers = { 'x-mx-insight-admin-token': ADMIN_TOKEN }
    const schema = await call(baseUrl, '/internal/v1/admin/sources/warehouse-events/schema', { headers })
    assert.equal(schema.response.status, 200)
    assert.equal(schema.payload.data.columns[0].name, 'message_id')

    const preview = await call(baseUrl, '/internal/v1/admin/sources/warehouse-events/preview?limit=3', { headers })
    assert.equal(preview.response.status, 200)
    assert.equal(preview.payload.data.sampleShapes[0].message_id.jsonType, 'number')

    const sync = await call(baseUrl, '/internal/v1/admin/sources/warehouse-events/sync', {
      method: 'POST', body: { batchSize: 2500 }, headers,
    })
    assert.equal(sync.response.status, 202)
    assert.equal(sync.payload.data.jobId, 77)
  })
  assert.deepEqual(calls[0], ['describe', 'warehouse-events'])
  assert.deepEqual(calls[1], ['preview', 'warehouse-events', { limit: 3 }])
  assert.deepEqual(calls[2], ['describe', 'warehouse-events'])
  assert.deepEqual(calls[3], [
    'enqueue', 'external-pull',
    { sourceKey: 'warehouse-events', batchSize: 2500, trigger: 'manual', chunk: 0 },
    { dedupeKey: 'external-pull:warehouse-events:0', priority: 220 },
  ])
})

test('file preview stays local by default and Agent opt-in sends column names only', async () => {
  const agentCalls = []
  const preview = {
    rowCount: 1,
    columns: ['id', 'private_email'],
    inferredFieldMap: { externalId: { from: 'id' } },
    unmappedColumns: ['private_email'],
    sample: [{ raw: { id: '1', private_email: 'secret@example.test' } }],
  }
  const app = createApp({
    service: {},
    store: {},
    importer: { preview: async () => preview },
    agent: {
      suggestFieldMap: async (input) => {
        agentCalls.push(input)
        return { fieldMap: preview.inferredFieldMap, origin: 'agent', model: 'test:model' }
      },
    },
    adapter: { dependencies: async () => ({ status: 'up' }) },
    adminToken: ADMIN_TOKEN,
  })
  await withServer(app, async (baseUrl) => {
    const headers = { 'x-mx-insight-admin-token': ADMIN_TOKEN, 'content-type': 'text/csv' }
    const localResponse = await fetch(`${baseUrl}/internal/v1/admin/sources/file/preview?filename=sample.csv`, {
      method: 'POST', headers, body: 'id,private_email\n1,secret@example.test\n',
    })
    const local = await localResponse.json()
    assert.equal(localResponse.status, 200)
    assert.equal(local.data.agentRequested, false)
    assert.equal(local.data.agentDataScope, 'none')
    assert.equal(local.data.suggestion.origin, 'inferred')
    assert.equal(agentCalls.length, 0)

    const agentResponse = await fetch(`${baseUrl}/internal/v1/admin/sources/file/preview?filename=sample.csv&agent=true`, {
      method: 'POST', headers, body: 'id,private_email\n1,secret@example.test\n',
    })
    const enhanced = await agentResponse.json()
    assert.equal(agentResponse.status, 200)
    assert.equal(enhanced.data.agentRequested, true)
    assert.equal(enhanced.data.agentDataScope, 'column_names_only')
    assert.deepEqual(agentCalls, [{ columns: preview.columns, sampleRows: [] }])
    assert.equal(JSON.stringify(agentCalls).includes('secret@example.test'), false)
  })
})

test('manual sync does not fork a second run while the source cursor is running', async () => {
  let described = false
  let enqueued = false
  const app = createApp({
    service: {},
    store: {
      getExternalSource: async () => ({
        sourceKey: 'warehouse-events', sourceKind: 'database', status: 'active',
      }),
    },
    databasePuller: { describe: async () => { described = true } },
    queue: {
      getCursor: async () => ({ status: 'running' }),
      enqueue: async () => { enqueued = true },
    },
    adapter: { dependencies: async () => ({ status: 'up' }) },
    adminToken: ADMIN_TOKEN,
  })
  await withServer(app, async (baseUrl) => {
    const result = await call(baseUrl, '/internal/v1/admin/sources/warehouse-events/sync', {
      method: 'POST', headers: { 'x-mx-insight-admin-token': ADMIN_TOKEN },
    })
    assert.equal(result.response.status, 202)
    assert.deepEqual(result.payload.data, {
      sourceKey: 'warehouse-events', jobId: null, alreadyScheduled: true,
    })
  })
  assert.equal(described, false)
  assert.equal(enqueued, false)
})

test('admin-token direct source routes preflight credentials and return the stored plaintext password', async () => {
  let source = null
  let createCalls = 0
  let updateCalls = 0
  const store = {
    getExternalSource: async (key) => source?.sourceKey === key ? source : null,
    listExternalSources: async () => source ? [source] : [],
    createExternalSource: async (input) => {
      createCalls += 1
      source = { id: 'source-1', createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z', ...input }
      return source
    },
    updateExternalSource: async (_key, patch) => {
      updateCalls += 1
      source = {
        ...source,
        ...(patch.status == null ? {} : { status: patch.status }),
        ...(patch.connection == null ? {} : { connection: patch.connection }),
      }
      return source
    },
  }
  const tested = []
  const databasePuller = {
    testConnection: async (connection) => {
      tested.push(structuredClone(connection))
      if (connection.password === 'wrong-password') {
        throw new AppError(503, 'source_connection_failed', 'PostgreSQL source connection test failed')
      }
      return {
        database: connection.database,
        user: connection.username,
        serverVersion: '16.11',
        readOnly: true,
      }
    },
    testSource: async (key) => ({
      database: source.connection.database,
      user: source.connection.username,
      serverVersion: '16.11',
      readOnly: true,
    }),
  }
  const app = createApp({
    service: {}, store, databasePuller, queue: { getCursor: async () => ({ status: 'idle' }) },
    adapter: { dependencies: async () => ({ status: 'up' }) },
    adminToken: ADMIN_TOKEN,
  })
  await withServer(app, async (baseUrl) => {
    const headers = { 'x-mx-insight-admin-token': ADMIN_TOKEN }
    const direct = {
      host: 'database.internal', port: 5432, database: 'night_all', username: 'mx_data',
      password: 'first-private-password', sslMode: 'disable', schema: 'public',
      table: 'tg_monitor_messages', cursorColumn: 'updated_at', idColumn: 'id',
    }
    for (const sourceKey of ['bad key', 'bad\nkey', 'bad/key', 'A'.repeat(10), 'a'.repeat(129)]) {
      const invalidKey = await call(baseUrl, '/internal/v1/admin/sources', {
        method: 'POST', headers,
        body: { sourceKey, displayName: 'Invalid source', sourceKind: 'database', connection: direct },
      })
      assert.equal(invalidKey.response.status, 400)
      assert.equal(invalidKey.payload.error.code, 'invalid_source_key')
      assert.equal(tested.length, 0)
      assert.equal(createCalls, 0)
    }
    const failedCreate = await call(baseUrl, '/internal/v1/admin/sources', {
      method: 'POST', headers,
      body: {
        sourceKey: 'warehouse-events', displayName: 'Warehouse events', sourceKind: 'database',
        connection: { ...direct, password: 'wrong-password' },
      },
    })
    assert.equal(failedCreate.response.status, 503)
    assert.equal(failedCreate.payload.error.code, 'source_connection_failed')
    assert.equal(createCalls, 0)

    const created = await call(baseUrl, '/internal/v1/admin/sources', {
      method: 'POST', headers,
      body: {
        sourceKey: 'warehouse-events', displayName: 'Warehouse events', sourceKind: 'database',
        datasetId: 'external.warehouse-events.v1', platform: 'external', objectType: 'record', connection: direct,
      },
    })
    assert.equal(created.response.status, 201)
    assert.equal(created.payload.data.connection.password, 'first-private-password')
    assert.equal(source.status, 'paused')

    const listed = await call(baseUrl, '/internal/v1/admin/sources', { headers })
    assert.equal(listed.payload.data[0].connection.password, 'first-private-password')
    const detail = await call(baseUrl, '/internal/v1/admin/sources/warehouse-events', { headers })
    assert.equal(detail.payload.data.connection.password, 'first-private-password')

    const failedRotation = await call(baseUrl, '/internal/v1/admin/sources/warehouse-events', {
      method: 'PUT', headers, body: { connection: { password: 'wrong-password' } },
    })
    assert.equal(failedRotation.response.status, 503)
    assert.equal(source.connection.password, 'first-private-password')
    assert.equal(updateCalls, 0)

    const rotated = await call(baseUrl, '/internal/v1/admin/sources/warehouse-events', {
      method: 'PUT', headers, body: { connection: { password: 'rotated-private-password' } },
    })
    assert.equal(rotated.response.status, 200)
    assert.equal(rotated.payload.data.connection.password, 'rotated-private-password')
    assert.equal(source.connection.password, 'rotated-private-password')

    const connectionTest = await call(baseUrl, '/internal/v1/admin/sources/warehouse-events/test', {
      method: 'POST', headers,
    })
    assert.equal(connectionTest.response.status, 200)
    assert.deepEqual(connectionTest.payload.data, {
      database: 'night_all', user: 'mx_data', serverVersion: '16.11', readOnly: true,
    })

    const retiredProviderRoute = await call(baseUrl, '/internal/v1/admin/source-providers', { headers })
    assert.equal(retiredProviderRoute.response.status, 404)

    const apiKeyDenied = await call(baseUrl, '/internal/v1/admin/sources', {
      headers: { 'x-api-key': 'mih_live_fake_api_key' },
    })
    assert.equal(apiKeyDenied.response.status, 403)
    assert.equal(apiKeyDenied.payload.error.code, 'admin_token_required')
  })
  assert.equal(tested[0].password, 'wrong-password')
  assert.equal(tested[1].password, 'first-private-password')
  assert.equal(tested[2].password, 'wrong-password')
  assert.equal(tested[3].password, 'rotated-private-password')
})

test('checkpoint reset requires a paused source and exact source-key confirmation', async () => {
  const calls = []
  const source = {
    sourceKey: 'warehouse-events', sourceKind: 'database', status: 'paused',
  }
  const app = createApp({
    service: {},
    store: { getExternalSource: async () => source },
    databasePuller: {
      resetCheckpoint: async (key) => {
        calls.push(key)
        return { status: 'idle', position: { resetAt: '2026-08-10T00:00:00.000Z' } }
      },
    },
    queue: {},
    adapter: { dependencies: async () => ({ status: 'up' }) },
    adminToken: ADMIN_TOKEN,
  })
  await withServer(app, async (baseUrl) => {
    const headers = { 'x-mx-insight-admin-token': ADMIN_TOKEN }
    const denied = await call(baseUrl, '/internal/v1/admin/sources/warehouse-events/checkpoint/reset', {
      method: 'POST', headers, body: { confirmSourceKey: 'wrong-source' },
    })
    assert.equal(denied.response.status, 400)
    assert.equal(denied.payload.error.code, 'checkpoint_reset_confirmation_required')

    const reset = await call(baseUrl, '/internal/v1/admin/sources/warehouse-events/checkpoint/reset', {
      method: 'POST', headers, body: { confirmSourceKey: 'warehouse-events' },
    })
    assert.equal(reset.response.status, 200)
    assert.equal(reset.payload.data.status, 'idle')
  })
  assert.deepEqual(calls, ['warehouse-events'])
})

test('database source registration rejects a literal DSN before it can be persisted', async () => {
  let created = false
  const app = createApp({
    service: {},
    store: { createExternalSource: async () => { created = true } },
    adapter: { dependencies: async () => ({ status: 'up' }) },
    adminToken: ADMIN_TOKEN,
  })
  await withServer(app, async (baseUrl) => {
    const result = await call(baseUrl, '/internal/v1/admin/sources', {
      method: 'POST',
      headers: { 'x-mx-insight-admin-token': ADMIN_TOKEN },
      body: {
        sourceKey: 'bad', displayName: 'bad', sourceKind: 'database',
        connection: { dsn: 'postgres://user:password@private.invalid/db', table: 'messages' },
      },
    })
    assert.equal(result.response.status, 400)
    assert.equal(result.payload.error.code, 'unsupported_connection_fields')
  })
  assert.equal(created, false)
})

test('database source registration cannot replace an existing source key and cursor lineage', async () => {
  let created = false
  const app = createApp({
    service: {},
    store: {
      getExternalSource: async () => ({ sourceKey: 'warehouse-events', status: 'paused' }),
      createExternalSource: async () => { created = true },
    },
    adapter: { dependencies: async () => ({ status: 'up' }) },
    adminToken: ADMIN_TOKEN,
  })
  await withServer(app, async (baseUrl) => {
    const result = await call(baseUrl, '/internal/v1/admin/sources', {
      method: 'POST',
      headers: { 'x-mx-insight-admin-token': ADMIN_TOKEN },
      body: {
        sourceKey: 'warehouse-events', displayName: 'replacement', sourceKind: 'database',
        connection: { dsnEnv: 'TG_DATABASE_URL', table: 'replacement_table' },
      },
    })
    assert.equal(result.response.status, 409)
    assert.equal(result.payload.error.code, 'source_exists')
  })
  assert.equal(created, false)
})

test('a paused database source cannot activate before mapping and schema gates pass', async () => {
  let source = {
    id: 'source-1', sourceKey: 'warehouse-events', sourceKind: 'database', status: 'paused',
    connection: { dsnEnv: 'TG_DATABASE_URL', schema: 'public', table: 'tg_monitor_messages' },
  }
  let mapping = null
  let issues = ['mapping eventTime has no matching source column (sent_at)']
  const store = {
    getExternalSource: async () => source,
    getActiveMapping: async () => mapping,
    updateExternalSource: async (_key, patch) => {
      source = {
        ...source,
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.connection ? { connection: patch.connection } : {}),
      }
      return source
    },
  }
  const app = createApp({
    service: {}, store,
    databasePuller: {
      describe: async () => ({ issues }),
      testConnection: async () => ({ database: 'night_all', user: 'mx_data', serverVersion: '16.11', readOnly: true }),
    },
    queue: {},
    adapter: { dependencies: async () => ({ status: 'up' }) },
    adminToken: ADMIN_TOKEN,
  })
  await withServer(app, async (baseUrl) => {
    const headers = { 'x-mx-insight-admin-token': ADMIN_TOKEN }
    const configured = await call(baseUrl, '/internal/v1/admin/sources/warehouse-events', {
      method: 'PUT', headers, body: { connection: { cursorColumn: 'updated_at', idColumn: 'id' } },
    })
    assert.equal(configured.response.status, 200)
    assert.equal(configured.payload.data.status, 'paused')

    const noMapping = await call(baseUrl, '/internal/v1/admin/sources/warehouse-events', {
      method: 'PUT', headers, body: { status: 'active' },
    })
    assert.equal(noMapping.response.status, 409)
    assert.equal(noMapping.payload.error.code, 'no_approved_mapping')

    mapping = { version: 2 }
    const badSchema = await call(baseUrl, '/internal/v1/admin/sources/warehouse-events', {
      method: 'PUT', headers, body: { status: 'active' },
    })
    assert.equal(badSchema.response.status, 409)
    assert.equal(badSchema.payload.error.code, 'source_probe_failed')

    issues = []
    const activated = await call(baseUrl, '/internal/v1/admin/sources/warehouse-events', {
      method: 'PUT', headers, body: { status: 'active' },
    })
    assert.equal(activated.response.status, 200)
    assert.equal(activated.payload.data.status, 'active')
  })
})

test('a paused source can switch between legacy dsnEnv and direct credentials without ambiguous residue', async () => {
  let source = {
    id: 'source-1', sourceKey: 'warehouse-events', sourceKind: 'database', status: 'paused',
    connection: {
      dsnEnv: 'TG_DATABASE_URL', schema: 'public', table: 'tg_monitor_messages',
      cursorColumn: 'updated_at', idColumn: 'id',
    },
  }
  const tested = []
  const store = {
    getExternalSource: async () => source,
    updateExternalSource: async (_key, patch) => {
      source = { ...source, connection: patch.connection ?? source.connection }
      return source
    },
  }
  const app = createApp({
    service: {}, store,
    databasePuller: {
      testConnection: async (connection) => {
        tested.push(structuredClone(connection))
        return { database: 'night_all', user: 'mx_data', serverVersion: '16.11', readOnly: true }
      },
    },
    queue: { getCursor: async () => ({ status: 'idle' }) },
    adapter: { dependencies: async () => ({ status: 'up' }) },
    adminToken: ADMIN_TOKEN,
  })
  await withServer(app, async (baseUrl) => {
    const headers = { 'x-mx-insight-admin-token': ADMIN_TOKEN }
    const direct = await call(baseUrl, '/internal/v1/admin/sources/warehouse-events', {
      method: 'PUT', headers,
      body: { connection: {
        host: 'database.internal', port: 5432, database: 'night_all', username: 'mx_data',
        password: 'plain-password', sslMode: 'verify-ca',
      } },
    })
    assert.equal(direct.response.status, 200)
    assert.equal(direct.payload.data.connection.dsnEnv, undefined)
    assert.equal(direct.payload.data.connection.password, 'plain-password')

    const legacy = await call(baseUrl, '/internal/v1/admin/sources/warehouse-events', {
      method: 'PUT', headers, body: { connection: { dsnEnv: 'TG_DATABASE_URL' } },
    })
    assert.equal(legacy.response.status, 200)
    assert.equal(legacy.payload.data.connection.dsnEnv, 'TG_DATABASE_URL')
    for (const field of ['host', 'port', 'database', 'username', 'password', 'sslMode']) {
      assert.equal(legacy.payload.data.connection[field], undefined)
    }
  })
  assert.equal(tested[0].dsnEnv, undefined)
  assert.equal(tested[1].dsnEnv, 'TG_DATABASE_URL')
})

test('an active database source must be paused before connection metadata changes', async () => {
  const source = {
    id: 'source-1', sourceKey: 'warehouse-events', sourceKind: 'database', status: 'active',
    connection: {
      dsnEnv: 'TG_DATABASE_URL', schema: 'public', table: 'tg_monitor_messages',
      cursorColumn: 'updated_at', idColumn: 'id',
    },
  }
  let updated = false
  const app = createApp({
    service: {},
    store: {
      getExternalSource: async () => source,
      updateExternalSource: async () => { updated = true },
    },
    queue: {},
    databasePuller: {},
    adapter: { dependencies: async () => ({ status: 'up' }) },
    adminToken: ADMIN_TOKEN,
  })
  await withServer(app, async (baseUrl) => {
    const result = await call(baseUrl, '/internal/v1/admin/sources/warehouse-events', {
      method: 'PUT',
      headers: { 'x-mx-insight-admin-token': ADMIN_TOKEN },
      body: { connection: { table: 'tg_monitor_messages_v2' } },
    })
    assert.equal(result.response.status, 409)
    assert.equal(result.payload.error.code, 'source_pause_required')
  })
  assert.equal(updated, false)
})

test('a paused but draining source cannot change its connection or active mapping', async () => {
  const source = {
    id: 'source-1', sourceKey: 'warehouse-events', sourceKind: 'database', status: 'paused',
    connection: {
      dsnEnv: 'TG_DATABASE_URL', schema: 'public', table: 'tg_monitor_messages',
      cursorColumn: 'updated_at', idColumn: 'id',
    },
  }
  let mutated = false
  const app = createApp({
    service: {},
    store: {
      getExternalSource: async () => source,
      updateExternalSource: async () => { mutated = true },
      approveSourceMapping: async () => { mutated = true },
    },
    queue: { getCursor: async () => ({ status: 'running', position: { importRunId: 'run-1' } }) },
    databasePuller: { withSourceLocks: async (_keys, operation) => operation() },
    adapter: { dependencies: async () => ({ status: 'up' }) },
    adminToken: ADMIN_TOKEN,
  })
  await withServer(app, async (baseUrl) => {
    const headers = { 'x-mx-insight-admin-token': ADMIN_TOKEN }
    const connection = await call(baseUrl, '/internal/v1/admin/sources/warehouse-events', {
      method: 'PUT', headers, body: { connection: { table: 'tg_monitor_messages_v2' } },
    })
    assert.equal(connection.response.status, 409)
    assert.equal(connection.payload.error.code, 'source_draining')

    const mapping = await call(
      baseUrl,
      '/internal/v1/admin/sources/warehouse-events/mappings/2/approve',
      { method: 'POST', headers },
    )
    assert.equal(mapping.response.status, 409)
    assert.equal(mapping.payload.error.code, 'source_draining')
  })
  assert.equal(mutated, false)
})

test('an active database source must be paused before approving a new mapping', async () => {
  let approved = false
  const app = createApp({
    service: {},
    store: {
      getExternalSource: async () => ({
        id: 'source-1', sourceKey: 'warehouse-events', sourceKind: 'database', status: 'active',
      }),
      approveSourceMapping: async () => { approved = true },
    },
    queue: {},
    adapter: { dependencies: async () => ({ status: 'up' }) },
    adminToken: ADMIN_TOKEN,
  })
  await withServer(app, async (baseUrl) => {
    const result = await call(
      baseUrl,
      '/internal/v1/admin/sources/warehouse-events/mappings/2/approve',
      { method: 'POST', headers: { 'x-mx-insight-admin-token': ADMIN_TOKEN } },
    )
    assert.equal(result.response.status, 409)
    assert.equal(result.payload.error.code, 'source_pause_required')
  })
  assert.equal(approved, false)
})

function canonicalRows() {
  return [
    {
      id: '11111111-1111-4111-8111-111111111111', external_id: '-1007:43', object_type: 'message',
      content_type: 'text', title: null, body: 'newer', url: 'https://t.me/example/43',
      author_external_id: 'user-1', author_name: 'Alice', event_time: new Date('2026-08-02T00:00:00Z'),
      collected_at: new Date('2026-08-02T01:00:00Z'), current_revision: 2,
      stable_fields: { relations: { chatId: '-1007', messageId: '43' }, metrics: { views: 9 } },
      extensions: { endpointId: 'must-not-leak', raw: { businessId: 'must-not-leak' } },
      sort_time: new Date('2026-08-02T00:00:00Z'),
    },
    {
      id: '22222222-2222-4222-8222-222222222222', external_id: '-1007:42', object_type: 'message',
      content_type: 'text', title: null, body: 'older', url: null,
      author_external_id: null, author_name: null, event_time: new Date('2026-08-01T00:00:00Z'),
      collected_at: new Date('2026-08-01T01:00:00Z'), current_revision: 1,
      stable_fields: { relations: { chatId: '-1007', messageId: '42' }, metrics: { views: 4 } },
      sort_time: new Date('2026-08-01T00:00:00Z'),
    },
    {
      id: '33333333-3333-4333-8333-333333333333', external_id: '-1007:41', object_type: 'message',
      event_time: new Date('2026-07-31T00:00:00Z'), collected_at: new Date('2026-07-31T01:00:00Z'),
      stable_fields: { relations: { chatId: '-1007', messageId: '41' } },
      sort_time: new Date('2026-07-31T00:00:00Z'),
    },
  ]
}

test('public Telegram history is consumer-granted, page-bounded, keyset-paged and allowlisted', async () => {
  const store = new MemoryStore()
  const seen = []
  store.listCanonicalRecords = async (query) => {
    seen.push(query)
    return canonicalRows()
  }
  const adapter = {
    dependencies: async () => ({ status: 'up' }),
    capabilities: async () => ({ data: { platforms: [] } }),
  }
  const service = new HubService({ store, adapter, apiKeyPepper: PEPPER })
  const tenantA = await service.createTenant({ name: 'Tenant A' })
  const tenantB = await service.createTenant({ name: 'Tenant B' })
  const consumerA = await service.createConsumer({ tenantId: tenantA.id, name: 'Consumer A' })
  const consumerB = await service.createConsumer({ tenantId: tenantB.id, name: 'Consumer B' })
  const keyA = await service.createApiKey({ consumerId: consumerA.id, name: 'A' })
  const keyB = await service.createApiKey({ consumerId: consumerB.id, name: 'B' })
  await service.putPlatformConfiguration('telegram', {
    tenantId: tenantA.id, consumerId: consumerA.id, enabled: true,
    maxRequests: 10, windowSeconds: 3600, maxPageSize: 2,
  })
  const app = createApp({ service, store, adapter, adminToken: ADMIN_TOKEN })

  await withServer(app, async (baseUrl) => {
    const allowed = { authorization: `Bearer ${keyA.secret}` }
    const denied = { authorization: `Bearer ${keyB.secret}` }

    const tooLarge = await call(baseUrl, '/api/v1/data/telegram/messages?pageSize=3', { headers: allowed })
    assert.equal(tooLarge.response.status, 400)
    assert.equal(tooLarge.payload.error.code, 'page_size_exceeded')

    const unboundedText = await call(baseUrl, '/api/v1/data/telegram/messages?q=secret', { headers: allowed })
    assert.equal(unboundedText.response.status, 400)
    assert.equal(unboundedText.payload.error.code, 'unsupported_fields')

    const forbidden = await call(baseUrl, '/api/v1/data/telegram/messages?pageSize=1', { headers: denied })
    assert.equal(forbidden.response.status, 403)
    assert.equal(forbidden.payload.error.code, 'platform_not_granted')

    const first = await call(baseUrl, '/api/v1/data/telegram/messages?chatId=-1007&pageSize=2', { headers: allowed })
    assert.equal(first.response.status, 200)
    assert.equal(first.payload.data.items.length, 2)
    assert.equal(first.payload.data.pageInfo.hasMore, true)
    assert.ok(first.payload.data.pageInfo.nextCursor)
    assert.deepEqual(first.payload.data.items[0].relations, { chatId: '-1007', messageId: '43' })
    const serialized = JSON.stringify(first.payload)
    assert.equal(serialized.includes('must-not-leak'), false)
    assert.equal(serialized.includes('extensions'), false)

    const second = await call(
      baseUrl,
      `/api/v1/data/telegram/messages?pageSize=2&cursor=${encodeURIComponent(first.payload.data.pageInfo.nextCursor)}`,
      { headers: allowed },
    )
    assert.equal(second.response.status, 200)
    assert.equal(seen.at(-1).cursor.id, canonicalRows()[1].id)
    assert.equal(seen.at(-1).cursor.sortTime, '2026-08-01T00:00:00.000Z')
  })
})

test('local Telegram search keeps Night-All v1 compatibility, idempotency and strict lineage projection', async () => {
  const store = new MemoryStore()
  const contentCalls = []
  const searchQueries = {
    searchContent: async (query, options) => {
      contentCalls.push({ query, options })
      return {
        mode: 'postgres',
        hasMore: true,
        nextCursor: {
          mode: 'postgres', pitId: null,
          searchAfter: ['2026-08-10T00:00:00.000Z', '11111111-1111-4111-8111-111111111111'],
        },
        items: [{
          id: '11111111-1111-4111-8111-111111111111',
          externalId: '-1007:42',
          platform: 'telegram',
          objectType: 'message',
          contentType: 'text',
          url: 'https://t.me/example/42',
          title: null,
          body: 'keyword result',
          authorExternalId: 'user-1',
          authorName: 'Alice',
          eventTime: '2026-08-10T00:00:00.000Z',
          collectedAt: '2026-08-10T00:01:00.000Z',
          metrics: { views: 12, internalMetric: 'must-not-leak' },
          providerKey: 'must-not-leak',
          raw: { password: 'must-not-leak' },
        }],
      }
    },
    searchAuthors: async () => ({
      mode: 'postgres',
      authors: [{
        authorExternalId: 'user-1', authorName: 'Alice', username: 'alice', postCount: 3, score: 0.8,
        providerKey: 'must-not-leak',
      }],
    }),
    searchTelegramChats: async () => ({
      mode: 'postgres',
      chats: [{
        id: '-1007', title: 'Alice chat', username: 'alice_chat', url: 'https://t.me/alice_chat',
        memberCount: 20, eventTime: '2026-08-01T00:00:00.000Z',
        collectedAt: '2026-08-10T00:00:00.000Z', score: 0.9,
        providerPassword: 'must-not-leak',
      }],
    }),
  }
  const adapter = {
    search: async () => { throw new Error('Telegram local search must not call Night-All') },
    capabilities: async () => ({ data: { platforms: [] } }),
  }
  const service = new HubService({ store, adapter, apiKeyPepper: PEPPER, searchQueries })
  const tenant = await service.createTenant({ name: 'Telegram tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Telegram consumer' })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Telegram key' })
  await service.putPlatformConfiguration('telegram', {
    tenantId: tenant.id, consumerId: consumer.id, enabled: true,
    maxRequests: 20, windowSeconds: 3600, maxPageSize: 20,
  })
  const app = createApp({ service, store, adapter, adminToken: ADMIN_TOKEN })

  await withServer(app, async (baseUrl) => {
    const authorization = { authorization: `Bearer ${key.secret}` }
    const body = {
      query: 'keyword', scope: 'messages', chatId: '-1007', authorId: 'user-1',
      from: '2026-08-01T00:00:00Z', to: '2026-08-10T23:59:59Z', pageSize: 1,
    }
    const missingKey = await call(baseUrl, '/api/v1/data/telegram/search', {
      method: 'POST', headers: authorization, body,
    })
    assert.equal(missingKey.response.status, 400)
    assert.equal(missingKey.payload.error.code, 'idempotency_key_required')

    const headers = { ...authorization, 'idempotency-key': 'telegram-search-0001' }
    const first = await call(baseUrl, '/api/v1/data/telegram/search', {
      method: 'POST', headers, body,
    })
    assert.equal(first.response.status, 200)
    assert.equal(first.response.headers.get('idempotent-replay'), 'false')
    assert.equal(first.payload.data.contractVersion, 'night-all.data-search.v1')
    assert.equal(first.payload.data.meta.capability, 'search_posts')
    assert.equal(first.payload.data.meta.sourceProvider, 'mx-insight-hub')
    assert.equal(first.payload.data.meta.endpointId, 'hub-canonical-search')
    assert.deepEqual(first.payload.data.items[0].source, {
      provider: null, endpointId: 'hub-canonical-search',
    })
    assert.deepEqual(first.payload.data.items[0].metrics, {
      likes: null, comments: null, shares: null, views: 12, bookmarks: null,
    })
    assert.equal(first.payload.data.pageInfo.cursorType, 'opaque')
    assert.ok(first.payload.data.pageInfo.nextCursor)
    assert.deepEqual(first.payload.data.warnings, [{
      code: 'search_projection_degraded',
      message: 'Elasticsearch unavailable or disabled; PostgreSQL substring search was used.',
    }])
    assert.equal(JSON.stringify(first.payload).includes('must-not-leak'), false)
    assert.deepEqual(contentCalls[0], {
      query: 'keyword',
      options: {
        platform: 'telegram',
        datasetIds: ['telegram.monitor.messages.v1'],
        objectType: 'message',
        authorExternalId: 'user-1',
        chatId: '-1007',
        fromTime: '2026-08-01T00:00:00.000Z',
        toTime: '2026-08-10T23:59:59.000Z',
        size: 1,
        cursor: null,
      },
    })

    const replay = await call(baseUrl, '/api/v1/data/telegram/search', {
      method: 'POST', headers, body,
    })
    assert.equal(replay.response.status, 200)
    assert.equal(replay.response.headers.get('idempotent-replay'), 'true')
    assert.equal(contentCalls.length, 1)

    const second = await call(baseUrl, '/api/v1/data/telegram/search', {
      method: 'POST',
      headers: { ...authorization, 'idempotency-key': 'telegram-search-0003' },
      body: { ...body, cursor: first.payload.data.pageInfo.nextCursor },
    })
    assert.equal(second.response.status, 200)
    assert.equal(second.payload.data.pageInfo.pageIndex, 2)
    assert.deepEqual(contentCalls[1].options.cursor, {
      mode: 'postgres',
      pitId: null,
      searchAfter: ['2026-08-10T00:00:00.000Z', '11111111-1111-4111-8111-111111111111'],
      seen: 1,
    })

    const generic = await call(baseUrl, '/api/v1/data/search', {
      method: 'POST',
      headers: { ...authorization, 'idempotency-key': 'telegram-search-0002' },
      body: { platform: 'telegram', query: 'keyword', pageSize: 1 },
    })
    assert.equal(generic.response.status, 200)
    assert.equal(generic.payload.data.platform, 'telegram')
    assert.equal(contentCalls[2].options.objectType, 'message')

    const entities = await call(baseUrl, '/api/v1/data/telegram/entities/search?query=alice&pageSize=5', {
      headers: authorization,
    })
    assert.equal(entities.response.status, 200)
    assert.equal(entities.payload.data.items.length, 2)
    assert.equal(entities.payload.data.items[0].entityType, 'chat')
    assert.equal(JSON.stringify(entities.payload).includes('must-not-leak'), false)
  })
})

test('POST Telegram search keeps an ambiguous commit unknown and never releases it', async () => {
  const store = new MemoryStore()
  let searchCalls = 0
  let releaseCalls = 0
  const searchQueries = {
    searchContent: async () => {
      searchCalls += 1
      return { mode: 'postgres', hasMore: false, nextCursor: null, items: [] }
    },
  }
  const service = new HubService({
    store,
    adapter: { capabilities: async () => ({ data: { platforms: [] } }) },
    apiKeyPepper: PEPPER,
    searchQueries,
  })
  const tenant = await service.createTenant({ name: 'Ambiguous POST tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Ambiguous POST consumer' })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Ambiguous POST key' })
  await service.putPlatformConfiguration('telegram', {
    tenantId: tenant.id, consumerId: consumer.id, enabled: true,
    maxRequests: 10, windowSeconds: 3600, maxPageSize: 20,
  })

  const commit = store.commitRequest.bind(store)
  store.commitRequest = async (...args) => {
    await commit(...args)
    throw new Error('connection dropped after commit')
  }
  const release = store.releaseRequest.bind(store)
  store.releaseRequest = async (...args) => {
    releaseCalls += 1
    return release(...args)
  }
  const app = createApp({
    service,
    store,
    adapter: {},
    adminToken: ADMIN_TOKEN,
    logger: { error() {} },
  })

  await withServer(app, async (baseUrl) => {
    const headers = {
      authorization: `Bearer ${key.secret}`,
      'idempotency-key': 'telegram-ambiguous-commit',
    }
    const first = await call(baseUrl, '/api/v1/data/search', {
      method: 'POST', headers, body: { platform: 'telegram', query: 'agent' },
    })
    assert.equal(first.response.status, 500)
    assert.equal(first.payload.error.code, 'internal_error')

    const request = [...store.requests.values()].at(-1)
    assert.equal(request.status, 'unknown')
    assert.equal(request.errorCode, 'usage_commit_ambiguous')
    assert.equal(releaseCalls, 0)

    const retry = await call(baseUrl, '/api/v1/data/search', {
      method: 'POST', headers, body: { platform: 'telegram', query: 'agent' },
    })
    assert.equal(retry.response.status, 409)
    assert.equal(retry.payload.error.code, 'request_outcome_unknown')
    assert.equal(searchCalls, 1)
  })
})

test('usage request terminal states cannot transition back to committed or released', async () => {
  const store = new MemoryStore()
  const input = {
    requestId: 'terminal-request',
    idempotencyKey: 'terminal-request',
    fingerprint: 'fingerprint',
    tenantId: 'tenant',
    consumerId: 'consumer',
    apiKeyId: 'key',
    platform: 'telegram',
    unitsReserved: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    windowStart: new Date(0),
    maxRequests: 10,
  }
  await store.reserve(input)
  await store.commitRequest(input.requestId, {
    responseStatus: 200, responseBody: { data: { items: [] } }, unitsActual: 1, upstreamLatencyMs: 1,
  })
  await assert.rejects(
    () => store.releaseRequest(input.requestId, 'must-not-regress'),
    (error) => error?.code === 'request_state_conflict',
  )
  assert.equal(store.requests.get(input.requestId).status, 'committed')

  await store.markRequestUnknown(input.requestId, 'commit_outcome_unknown')
  await assert.rejects(
    () => store.commitRequest(input.requestId, {
      responseStatus: 200, responseBody: null, unitsActual: 1, upstreamLatencyMs: 1,
    }),
    (error) => error?.code === 'request_state_conflict',
  )
  assert.equal(store.requests.get(input.requestId).status, 'unknown')
})

test('Telegram history enforces maxRequests and commits count-only usage evidence', async () => {
  const store = new MemoryStore()
  store.listCanonicalRecords = async () => canonicalRows()
  const service = new HubService({ store, adapter: {}, apiKeyPepper: PEPPER })
  const tenant = await service.createTenant({ name: 'Metered tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Metered consumer' })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Metered key' })
  await service.putPlatformConfiguration('telegram', {
    tenantId: tenant.id, consumerId: consumer.id, enabled: true,
    maxRequests: 1, windowSeconds: 3600, maxPageSize: 10,
  })
  const context = await service.authenticate(key.secret)

  const first = await service.telegramMonitor(context, 'messages', { pageSize: '2' })
  assert.equal(first.items.length, 2)
  await assert.rejects(
    () => service.telegramMonitor(context, 'messages', { pageSize: '2' }),
    (error) => error?.status === 429 && error?.code === 'quota_exceeded',
  )
  const usage = await service.publicUsage(context, {})
  assert.equal(usage.committed, 1)
  assert.equal(usage.units, 2)
  const committed = [...store.requests.values()].find((request) => request.status === 'committed')
  assert.equal(committed.responseBody, null)
})

test('a failed Telegram history read releases its reservation so it does not consume quota', async () => {
  const store = new MemoryStore()
  let fail = true
  store.listCanonicalRecords = async () => {
    if (fail) throw new Error('temporary local read failure')
    return canonicalRows().slice(0, 1)
  }
  const service = new HubService({ store, adapter: {}, apiKeyPepper: PEPPER })
  const tenant = await service.createTenant({ name: 'Retry tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Retry consumer' })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Retry key' })
  await service.putPlatformConfiguration('telegram', {
    tenantId: tenant.id, consumerId: consumer.id, enabled: true,
    maxRequests: 1, windowSeconds: 3600, maxPageSize: 10,
  })
  const context = await service.authenticate(key.secret)

  await assert.rejects(() => service.telegramMonitor(context, 'messages', {}), /temporary local read failure/)
  fail = false
  const retry = await service.telegramMonitor(context, 'messages', {})
  assert.equal(retry.items.length, 1)
  const usage = await service.publicUsage(context, {})
  assert.equal(usage.released, 1)
  assert.equal(usage.committed, 1)
})

test('an ambiguous Telegram usage commit is retained as unknown, never released', async () => {
  const store = new MemoryStore()
  store.listCanonicalRecords = async () => canonicalRows().slice(0, 1)
  const commit = store.commitRequest.bind(store)
  store.commitRequest = async (...args) => {
    await commit(...args)
    throw new Error('connection dropped after commit')
  }
  const service = new HubService({ store, adapter: {}, apiKeyPepper: PEPPER })
  const tenant = await service.createTenant({ name: 'Ambiguous tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Ambiguous consumer' })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Ambiguous key' })
  await service.putPlatformConfiguration('telegram', {
    tenantId: tenant.id, consumerId: consumer.id, enabled: true,
    maxRequests: 2, windowSeconds: 3600, maxPageSize: 10,
  })
  const context = await service.authenticate(key.secret)

  await assert.rejects(() => service.telegramMonitor(context, 'messages', {}), /dropped after commit/)
  const request = [...store.requests.values()].at(-1)
  assert.equal(request.status, 'unknown')
  assert.equal(request.errorCode, 'usage_commit_ambiguous')
})

test('memory mode reports stored Telegram data unavailable instead of throwing', async () => {
  const store = new MemoryStore()
  const service = new HubService({ store, adapter: {}, apiKeyPepper: PEPPER })
  const tenant = await service.createTenant({ name: 'T' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'C' })
  await service.putPlatformConfiguration('telegram', {
    tenantId: tenant.id, consumerId: consumer.id, enabled: true,
  })
  await assert.rejects(
    () => service.telegramMonitor({ consumer }, 'messages', {}),
    (error) => error?.status === 503 && error?.code === 'stored_data_unavailable',
  )
})

test('PostgreSQL Telegram query uses fixed datasets and keyset predicates, never OFFSET', async () => {
  let captured
  const store = new PostgresStore({
    async query(sql, values) {
      captured = { sql, values }
      return { rows: [] }
    },
  })
  await store.listCanonicalRecords({
    datasetId: 'telegram.monitor.messages.v1', platform: 'telegram', objectType: 'message',
    pageSize: 50, chatId: '-1007', from: '2026-08-01T00:00:00Z', to: null,
    cursor: { sortTime: '2026-08-02T00:00:00Z', id: '11111111-1111-4111-8111-111111111111' },
  })
  assert.match(captured.sql, /\(event_time, id\) < \(\$7::timestamptz, \$8::uuid\)/)
  assert.match(captured.sql, /stable_fields #>> '\{relations,chatId\}'/)
  assert.equal(/\bOFFSET\b/i.test(captured.sql), false)
  assert.deepEqual(captured.values.slice(0, 4), [
    'telegram.monitor.messages.v1', 'telegram', 'message', '-1007',
  ])
  assert.equal(captured.values.at(-1), 51)
})
