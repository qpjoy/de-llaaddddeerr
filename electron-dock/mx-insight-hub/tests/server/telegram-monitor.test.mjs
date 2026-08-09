import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { normalizeTelegramMonitorQuery } from '../../server/data/telegram-monitor.mjs'

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
    { sourceKey: 'telegram-monitor-messages', batchSize: 2500, chunk: 0 },
    { dedupeKey: 'external-pull:telegram-monitor-messages:0', priority: 220 },
  ])
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
