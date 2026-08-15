import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createApp } from '../../server/app.mjs'
import { TELEGRAM_SQLITE_INPUTS } from '../../server/ingest/telegram/sqlite-pipeline.mjs'

const ADMIN_TOKEN = 'test-admin-token'
const UPSTREAM_TOKEN = 'sqlite-upstream-secret'

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

function routeFixture() {
  const sources = new Map(TELEGRAM_SQLITE_INPUTS.map((input) => [input.sourceKey, {
    id: `source-${input.role}`,
    sourceKey: input.sourceKey,
    displayName: `Telegram SQLite ${input.role}`,
    sourceKind: 'sqlite_api',
    datasetId: input.datasetId,
    platform: 'telegram',
    objectType: input.objectType,
    status: 'active',
    syncIntervalSeconds: 300,
    connection: {
      baseUrl: 'http://sqlite.test:8780',
      token: UPSTREAM_TOKEN,
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
      approved: true,
    }],
  ]))
  const cursors = new Map(TELEGRAM_SQLITE_INPUTS.map((input) => [
    `external:${input.sourceKey}`,
    { status: 'idle', position: {}, updatedAt: '2026-08-15T00:00:00.000Z' },
  ]))
  const calls = []
  let genericMutations = 0

  const store = {
    listExternalSources: async () => [...sources.values()],
    getExternalSource: async (sourceKey) => sources.get(sourceKey) ?? null,
    getActiveMapping: async (sourceId) => mappings.get(sourceId)?.[0] ?? null,
    listSourceMappings: async (sourceId) => mappings.get(sourceId) ?? [],
    listImportRuns: async (sourceId) => [{
      id: `run-${sourceId}`,
      status: 'failed',
      error: `Bearer ${UPSTREAM_TOKEN}`,
    }],
    updateExternalSourcesBatch: async (updates) => {
      calls.push(['updateBatch', structuredClone(updates)])
      for (const update of updates) {
        const source = sources.get(update.sourceKey)
        sources.set(update.sourceKey, {
          ...source,
          ...(update.status == null ? {} : { status: update.status }),
        })
      }
      return updates.map((update) => sources.get(update.sourceKey))
    },
    updateExternalSource: async () => { genericMutations += 1 },
    createSourceMapping: async () => { genericMutations += 1 },
    approveSourceMapping: async () => { genericMutations += 1 },
  }

  const queueClient = {
    query: async (sql) => {
      calls.push(['queueTx', sql])
      return { rows: [] }
    },
    release() {},
  }
  const queue = {
    pool: { connect: async () => queueClient },
    getCursor: async (cursorId) => cursors.get(cursorId) ?? null,
    enqueue: async (queueName, payload, options) => {
      assert.equal(options.client, queueClient)
      calls.push(['enqueue', queueName, structuredClone(payload)])
      return calls.filter(([kind]) => kind === 'enqueue').length
    },
  }
  const sqliteApiPuller = {
    withSourceLocks: async (_sourceKeys, operation) => operation(),
    describe: async (sourceKey) => {
      calls.push(['describe', sourceKey])
      return { issues: [] }
    },
    progress: async () => ({
      totalRows: 1,
      completedRows: 1,
      remainingRows: 0,
      percent: 100,
    }),
  }

  const app = createApp({
    service: {},
    store,
    queue,
    sqliteApiPuller,
    adapter: { dependencies: async () => ({ status: 'up' }) },
    adminToken: ADMIN_TOKEN,
    logger: { error() {} },
  })
  return { app, calls, sources, genericMutations: () => genericMutations }
}

test('Telegram SQLite pipeline and source reads are Admin-Token-only and redact the upstream token', async () => {
  const fixture = routeFixture()
  await withServer(fixture.app, async (baseUrl) => {
    const denied = await call(baseUrl, '/internal/v1/admin/pipelines/telegram-sqlite', {
      headers: { 'x-api-key': 'mih_live_not_admin' },
    })
    assert.equal(denied.response.status, 403)
    assert.equal(denied.payload.error.code, 'admin_token_required')

    const headers = { 'x-mx-insight-admin-token': ADMIN_TOKEN }
    const pipeline = await call(baseUrl, '/internal/v1/admin/pipelines/telegram-sqlite', { headers })
    assert.equal(pipeline.response.status, 200)
    assert.equal(pipeline.payload.data.tasks.length, 2)
    assert.equal(pipeline.payload.data.connection.tokenConfigured, true)
    assert.equal(JSON.stringify(pipeline.payload).includes(UPSTREAM_TOKEN), false)

    const list = await call(baseUrl, '/internal/v1/admin/sources', { headers })
    assert.equal(list.response.status, 200)
    assert.equal(list.payload.data.length, 2)
    for (const source of list.payload.data) {
      assert.equal(source.connection.tokenConfigured, true)
      assert.equal(Object.hasOwn(source.connection, 'token'), false)
    }
    assert.equal(JSON.stringify(list.payload).includes(UPSTREAM_TOKEN), false)

    const detail = await call(
      baseUrl,
      '/internal/v1/admin/sources/telegram-sqlite-api-messages',
      { headers },
    )
    assert.equal(detail.response.status, 200)
    assert.equal(detail.payload.data.connection.tokenConfigured, true)
    assert.equal(Object.hasOwn(detail.payload.data.connection, 'token'), false)
    assert.equal(JSON.stringify(detail.payload).includes(UPSTREAM_TOKEN), false)
  })
})

test('Telegram SQLite child sources reject every generic mutation route', async () => {
  const fixture = routeFixture()
  await withServer(fixture.app, async (baseUrl) => {
    const headers = { 'x-mx-insight-admin-token': ADMIN_TOKEN }
    const sourceKey = 'telegram-sqlite-api-messages'
    const mutations = [
      [`/internal/v1/admin/sources/${sourceKey}`, {
        method: 'PUT', body: { status: 'paused' },
      }],
      [`/internal/v1/admin/sources/${sourceKey}/sync`, {
        method: 'POST', body: { batchSize: 100 },
      }],
      [`/internal/v1/admin/sources/${sourceKey}/checkpoint/reset`, {
        method: 'POST', body: { confirmSourceKey: sourceKey },
      }],
      [`/internal/v1/admin/sources/${sourceKey}/mappings`, {
        method: 'POST', body: { fieldMap: { externalId: { from: 'message_id' } } },
      }],
      [`/internal/v1/admin/sources/${sourceKey}/mappings/1/approve`, {
        method: 'POST', body: {},
      }],
    ]

    for (const [path, options] of mutations) {
      const result = await call(baseUrl, path, { ...options, headers })
      assert.equal(result.response.status, 409, path)
      assert.equal(result.payload.error.code, 'pipeline_managed_source', path)
    }
  })
  assert.equal(fixture.genericMutations(), 0)
})

test('Telegram SQLite status and sync routes remain Admin-only and invoke the fixed pipeline', async () => {
  const fixture = routeFixture()
  await withServer(fixture.app, async (baseUrl) => {
    for (const [path, body] of [
      ['/internal/v1/admin/pipelines/telegram-sqlite/sync', { batchSize: 125 }],
      ['/internal/v1/admin/pipelines/telegram-sqlite/status', { status: 'paused' }],
    ]) {
      const denied = await call(baseUrl, path, {
        method: 'POST', body, headers: { 'x-api-key': 'mih_live_not_admin' },
      })
      assert.equal(denied.response.status, 403, path)
      assert.equal(denied.payload.error.code, 'admin_token_required', path)
    }

    const headers = { 'x-mx-insight-admin-token': ADMIN_TOKEN }
    const synced = await call(baseUrl, '/internal/v1/admin/pipelines/telegram-sqlite/sync', {
      method: 'POST', body: { batchSize: 125 }, headers,
    })
    assert.equal(synced.response.status, 202)
    assert.deepEqual(
      synced.payload.data.tasks.map((task) => task.sourceKey),
      TELEGRAM_SQLITE_INPUTS.map((input) => input.sourceKey),
    )

    const paused = await call(baseUrl, '/internal/v1/admin/pipelines/telegram-sqlite/status', {
      method: 'POST', body: { status: 'paused' }, headers,
    })
    assert.equal(paused.response.status, 200)
    assert.equal(paused.payload.data.status, 'paused')
  })

  const enqueues = fixture.calls.filter(([kind]) => kind === 'enqueue')
  assert.deepEqual(enqueues.map(([, queueName, payload]) => ({ queueName, payload })),
    TELEGRAM_SQLITE_INPUTS.map((input) => ({
      queueName: 'external-pull',
      payload: {
        sourceKey: input.sourceKey,
        batchSize: 125,
        trigger: 'manual',
        chunk: 0,
      },
    })))
  assert.equal(fixture.calls.filter(([kind]) => kind === 'updateBatch').length, 1)
})
