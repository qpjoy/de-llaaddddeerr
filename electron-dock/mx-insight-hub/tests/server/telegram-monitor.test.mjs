import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { ProviderRegistry } from '../../server/ingest/external/provider-registry.mjs'
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

test('admin database source routes expose schema/preview and schedule a bounded sync', async () => {
  const calls = []
  const source = { sourceKey: 'telegram-monitor-messages', sourceKind: 'database', status: 'active' }
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
    const schema = await call(baseUrl, '/internal/v1/admin/sources/telegram-monitor-messages/schema', { headers })
    assert.equal(schema.response.status, 200)
    assert.equal(schema.payload.data.columns[0].name, 'message_id')

    const preview = await call(baseUrl, '/internal/v1/admin/sources/telegram-monitor-messages/preview?limit=3', { headers })
    assert.equal(preview.response.status, 200)
    assert.equal(preview.payload.data.sampleShapes[0].message_id.jsonType, 'number')

    const sync = await call(baseUrl, '/internal/v1/admin/sources/telegram-monitor-messages/sync', {
      method: 'POST', body: { batchSize: 2500 }, headers,
    })
    assert.equal(sync.response.status, 202)
    assert.equal(sync.payload.data.jobId, 77)
  })
  assert.deepEqual(calls[0], ['describe', 'telegram-monitor-messages'])
  assert.deepEqual(calls[1], ['preview', 'telegram-monitor-messages', { limit: 3 }])
  assert.deepEqual(calls[2], ['describe', 'telegram-monitor-messages'])
  assert.deepEqual(calls[3], [
    'enqueue', 'external-pull',
    { sourceKey: 'telegram-monitor-messages', batchSize: 2500, trigger: 'manual', chunk: 0 },
    { dedupeKey: 'external-pull:telegram-monitor-messages:0', priority: 220 },
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
        sourceKey: 'telegram-monitor-messages', sourceKind: 'database', status: 'active',
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
    const result = await call(baseUrl, '/internal/v1/admin/sources/telegram-monitor-messages/sync', {
      method: 'POST', headers: { 'x-mx-insight-admin-token': ADMIN_TOKEN },
    })
    assert.equal(result.response.status, 202)
    assert.deepEqual(result.payload.data, {
      sourceKey: 'telegram-monitor-messages', jobId: null, alreadyScheduled: true,
    })
  })
  assert.equal(described, false)
  assert.equal(enqueued, false)
})

test('provider admin routes preflight secrets and require referenced sources to be paused and drained', async () => {
  const store = new MemoryStore()
  let referenced = []
  store.listExternalSources = async () => referenced
  const providerRegistry = new ProviderRegistry({ store, masterKey: '33'.repeat(32) })
  const databasePuller = {
    testProviderCredentials: async (credentials) => ({
      database: credentials.database,
      user: credentials.username,
      serverVersion: '16.11',
      readOnly: true,
    }),
    testProvider: async (key) => ({
      provider: await providerRegistry.get(key),
      connection: { database: 'night_all', user: 'mx_data', serverVersion: '16.11', readOnly: true },
    }),
  }
  const app = createApp({
    service: {}, store, providerRegistry, databasePuller, queue: {},
    adapter: { dependencies: async () => ({ status: 'up' }) },
    adminToken: ADMIN_TOKEN,
  })
  await withServer(app, async (baseUrl) => {
    const headers = { 'x-mx-insight-admin-token': ADMIN_TOKEN }
    const types = await call(baseUrl, '/internal/v1/admin/source-provider-types', { headers })
    assert.equal(types.response.status, 200)
    assert.equal(types.payload.data[0].available, true)

    const created = await call(baseUrl, '/internal/v1/admin/source-providers', {
      method: 'POST', headers,
      body: {
        providerKey: 'night-all-pg', displayName: 'Night-All', providerType: 'postgresql',
        config: {
          host: 'database.internal', port: 5432, database: 'night_all', username: 'mx_data', sslMode: 'disable',
        },
        password: 'first-private-password',
      },
    })
    assert.equal(created.response.status, 201)
    assert.equal(created.payload.data.secretConfigured, true)
    assert.equal(JSON.stringify(created.payload).includes('first-private-password'), false)
    assert.equal('encryptedSecret' in created.payload.data, false)

    referenced = [{ sourceKey: 'telegram-monitor-messages', providerKey: 'night-all-pg', status: 'active' }]
    const activeRotation = await call(baseUrl, '/internal/v1/admin/source-providers/night-all-pg', {
      method: 'PUT', headers, body: { password: 'rotated-private-password' },
    })
    assert.equal(activeRotation.response.status, 409)
    assert.equal(activeRotation.payload.error.code, 'provider_pause_required')
    assert.equal((await providerRegistry.resolveCredentials('night-all-pg')).password, 'first-private-password')

    referenced[0].status = 'paused'
    const rotated = await call(baseUrl, '/internal/v1/admin/source-providers/night-all-pg', {
      method: 'PUT', headers, body: { password: 'rotated-private-password' },
    })
    assert.equal(rotated.response.status, 200)
    assert.equal((await providerRegistry.resolveCredentials('night-all-pg')).password, 'rotated-private-password')
    assert.equal(JSON.stringify(rotated.payload).includes('rotated-private-password'), false)

    const coordinates = await call(baseUrl, '/internal/v1/admin/source-providers/night-all-pg', {
      method: 'PUT', headers,
      body: {
        config: {
          host: 'other.internal', port: 5432, database: 'night_all', username: 'mx_data', sslMode: 'disable',
        },
      },
    })
    assert.equal(coordinates.response.status, 200)
    assert.equal(coordinates.payload.data.config.host, 'other.internal')

    const deletion = await call(baseUrl, '/internal/v1/admin/source-providers/night-all-pg', {
      method: 'DELETE', headers,
    })
    assert.equal(deletion.response.status, 409)
    assert.equal(deletion.payload.error.code, 'provider_in_use')

    const tested = await call(baseUrl, '/internal/v1/admin/source-providers/night-all-pg/test', {
      method: 'POST', headers,
    })
    assert.equal(tested.response.status, 200)
    assert.deepEqual(tested.payload.data.connection, {
      database: 'night_all', user: 'mx_data', serverVersion: '16.11', readOnly: true,
    })

    const listed = await call(baseUrl, '/internal/v1/admin/source-providers', { headers })
    const serialized = JSON.stringify(listed.payload)
    assert.equal(serialized.includes('first-private-password'), false)
    assert.equal(serialized.includes('rotated-private-password'), false)
    assert.equal(serialized.includes('ciphertext'), false)
  })
})

test('checkpoint reset requires a paused source and exact source-key confirmation', async () => {
  const calls = []
  const source = {
    sourceKey: 'telegram-monitor-messages', sourceKind: 'database', status: 'paused',
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
    const denied = await call(baseUrl, '/internal/v1/admin/sources/telegram-monitor-messages/checkpoint/reset', {
      method: 'POST', headers, body: { confirmSourceKey: 'wrong-source' },
    })
    assert.equal(denied.response.status, 400)
    assert.equal(denied.payload.error.code, 'checkpoint_reset_confirmation_required')

    const reset = await call(baseUrl, '/internal/v1/admin/sources/telegram-monitor-messages/checkpoint/reset', {
      method: 'POST', headers, body: { confirmSourceKey: 'telegram-monitor-messages' },
    })
    assert.equal(reset.response.status, 200)
    assert.equal(reset.payload.data.status, 'idle')
  })
  assert.deepEqual(calls, ['telegram-monitor-messages'])
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
      getExternalSource: async () => ({ sourceKey: 'telegram-monitor-messages', status: 'paused' }),
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
        sourceKey: 'telegram-monitor-messages', displayName: 'replacement', sourceKind: 'database',
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
    id: 'source-1', sourceKey: 'telegram-monitor-messages', sourceKind: 'database', status: 'paused',
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
    databasePuller: { describe: async () => ({ issues }) },
    queue: {},
    adapter: { dependencies: async () => ({ status: 'up' }) },
    adminToken: ADMIN_TOKEN,
  })
  await withServer(app, async (baseUrl) => {
    const headers = { 'x-mx-insight-admin-token': ADMIN_TOKEN }
    const configured = await call(baseUrl, '/internal/v1/admin/sources/telegram-monitor-messages', {
      method: 'PUT', headers, body: { connection: { cursorColumn: 'updated_at', idColumn: 'id' } },
    })
    assert.equal(configured.response.status, 200)
    assert.equal(configured.payload.data.status, 'paused')

    const noMapping = await call(baseUrl, '/internal/v1/admin/sources/telegram-monitor-messages', {
      method: 'PUT', headers, body: { status: 'active' },
    })
    assert.equal(noMapping.response.status, 409)
    assert.equal(noMapping.payload.error.code, 'no_approved_mapping')

    mapping = { version: 2 }
    const badSchema = await call(baseUrl, '/internal/v1/admin/sources/telegram-monitor-messages', {
      method: 'PUT', headers, body: { status: 'active' },
    })
    assert.equal(badSchema.response.status, 409)
    assert.equal(badSchema.payload.error.code, 'source_probe_failed')

    issues = []
    const activated = await call(baseUrl, '/internal/v1/admin/sources/telegram-monitor-messages', {
      method: 'PUT', headers, body: { status: 'active' },
    })
    assert.equal(activated.response.status, 200)
    assert.equal(activated.payload.data.status, 'active')
  })
})

test('an active database source must be paused before connection metadata changes', async () => {
  const source = {
    id: 'source-1', sourceKey: 'telegram-monitor-messages', sourceKind: 'database', status: 'active',
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
    const result = await call(baseUrl, '/internal/v1/admin/sources/telegram-monitor-messages', {
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
    id: 'source-1', sourceKey: 'telegram-monitor-messages', sourceKind: 'database', status: 'paused',
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
    const connection = await call(baseUrl, '/internal/v1/admin/sources/telegram-monitor-messages', {
      method: 'PUT', headers, body: { connection: { table: 'tg_monitor_messages_v2' } },
    })
    assert.equal(connection.response.status, 409)
    assert.equal(connection.payload.error.code, 'source_draining')

    const mapping = await call(
      baseUrl,
      '/internal/v1/admin/sources/telegram-monitor-messages/mappings/2/approve',
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
        id: 'source-1', sourceKey: 'telegram-monitor-messages', sourceKind: 'database', status: 'active',
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
      '/internal/v1/admin/sources/telegram-monitor-messages/mappings/2/approve',
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
