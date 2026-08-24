import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createApp } from '../../server/app.mjs'
import {
  CANONICAL_CONTEXT_DATASETS,
  canonicalContextCapability,
  canonicalContextResponse,
  normalizeCanonicalContextQuery,
} from '../../server/data/canonical-context.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import {
  PostgresStore,
  buildCanonicalContextStoragePlan,
} from '../../server/stores/postgres-store.mjs'

const ADMIN_TOKEN = 'canonical-context-admin-token'
const PEPPER = 'canonical-context-test-pepper-with-enough-entropy'
const ANCHOR_ID = '33333333-3333-4333-8333-333333333333'

function canonicalRow({
  id = ANCHOR_ID,
  datasetId = 'telegram.monitor.messages.v1',
  externalId = '-1007:20',
  body = 'anchor',
  eventTime = '2026-08-24T10:00:00.000Z',
  side = 'current',
} = {}) {
  return {
    side,
    id,
    dataset_id: datasetId,
    platform: 'telegram',
    object_type: 'message',
    content_type: 'text',
    external_id: externalId,
    url: null,
    title: 'Telegram chat',
    body,
    author_external_id: 'user-1',
    author_name: 'Public author',
    event_time: eventTime,
    collected_at: '2026-08-24T10:01:00.000Z',
    stable_fields: {
      attributes: { username: 'public-handle' },
      metrics: { views: 3, privateCounter: 99 },
      relations: { chatId: '-1007', messageId: externalId.split(':').at(-1) },
    },
    context_id: '-1007',
    extensions: { raw: 'must-not-leak' },
  }
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

test('canonical context query defaults to ten per side and rejects unbounded input', () => {
  assert.deepEqual(normalizeCanonicalContextQuery({}), { before: 10, after: 10 })
  assert.deepEqual(normalizeCanonicalContextQuery({ before: '0', after: '50' }), { before: 0, after: 50 })

  for (const input of [
    { before: '-1' },
    { before: '1.5' },
    { after: '51' },
    { before: ['10'] },
  ]) {
    assert.throws(
      () => normalizeCanonicalContextQuery(input),
      (error) => error.status === 400 && error.code === 'invalid_request',
    )
  }
  assert.throws(
    () => normalizeCanonicalContextQuery({ includeRaw: 'true' }),
    (error) => error.status === 400 && error.code === 'unsupported_fields',
  )
})

test('canonical context capability is dataset-scoped and reports serving readiness separately', () => {
  const capability = canonicalContextCapability({ ready: false })
  assert.equal(capability.contractVersion, 'mx-insight-hub.canonical-context.v1')
  assert.equal(capability.ready, false)
  assert.equal(capability.defaultBefore, 10)
  assert.equal(capability.defaultAfter, 10)
  assert.equal(capability.maxBefore, 50)
  assert.equal(capability.maxAfter, 50)
  assert.deepEqual(capability.datasets.map((dataset) => dataset.datasetId), [
    'telegram.monitor.messages.v1',
    'telegram.sqlite.messages.v1',
  ])
  assert.deepEqual(capability.datasets.map((dataset) => dataset.upstreamCompleteness.status), [
    'unknown',
    'bounded',
  ])
})

test('Telegram capability discovery advertises context readiness without calling Night-All', async () => {
  let indexCheckFails = false
  const warnings = []
  const service = new HubService({
    store: {
      async listGrants() { return ['telegram'] },
      async listCanonicalRecords() { return [] },
      async getCanonicalContextServingIndexStatus() {
        if (indexCheckFails) throw new Error('catalog unavailable')
        return { ready: false, missing: ['canonical_monitor_tg_messages_chat_time_idx'] }
      },
      async getCanonicalContext() { return null },
      async listCapabilityGrants() { return [] },
    },
    adapter: {
      async capabilities() { assert.fail('Telegram-only discovery must not call Night-All') },
    },
    apiKeyPepper: PEPPER,
    logger: { warn(message) { warnings.push(message) } },
  })

  const payload = await service.capabilities({ consumer: { id: 'consumer' } })
  assert.deepEqual(payload.data.platforms[0].capabilities, [
    'monitor_chats',
    'monitor_messages',
    'stored_search',
    'entity_search',
    'message_context',
  ])
  assert.equal(payload.data.platforms[0].ready, true)
  assert.equal(payload.data.platforms[0].context.ready, false)
  assert.equal(payload.data.platforms[0].context.datasets.length, 2)

  indexCheckFails = true
  const degraded = await service.capabilities({ consumer: { id: 'consumer' } })
  assert.equal(degraded.data.platforms[0].ready, true)
  assert.equal(degraded.data.platforms[0].context.ready, false)
  assert.deepEqual(warnings, ['[canonical-context] serving index status is unavailable'])

  service.store.getCanonicalContext = undefined
  const unavailable = await service.capabilities({ consumer: { id: 'consumer' } })
  assert.equal(unavailable.data.platforms[0].capabilities.includes('message_context'), false)
  assert.equal(unavailable.data.platforms[0].context, undefined)
})

test('canonical context response is one ascending safe list with an explicit stored/source boundary split', () => {
  const before = canonicalRow({
    id: '11111111-1111-4111-8111-111111111111',
    externalId: '-1007:19',
    body: 'before',
    eventTime: '2026-08-24T09:59:00.000Z',
    side: 'before',
  })
  const current = canonicalRow()
  const after = canonicalRow({
    id: '55555555-5555-4555-8555-555555555555',
    externalId: '-1007:21',
    body: 'after',
    eventTime: '2026-08-24T10:01:00.000Z',
    side: 'after',
  })
  const response = canonicalContextResponse({
    query: { before: 10, after: 10 },
    result: {
      before: [before],
      current,
      after: [after],
      hasMoreStoredBefore: false,
      hasMoreStoredAfter: true,
    },
  })

  assert.equal(response.contractVersion, 'mx-insight-hub.canonical-context.v1')
  assert.equal(response.anchorId, ANCHOR_ID)
  assert.equal(response.anchorIndex, 1)
  assert.deepEqual(response.items.map((item) => item.text), ['before', 'anchor', 'after'])
  assert.equal(response.source, 'hub')
  assert.deepEqual(response.stream, {
    platform: 'telegram',
    datasetId: 'telegram.monitor.messages.v1',
    objectType: 'message',
    type: 'chat',
    id: '-1007',
  })
  assert.deepEqual(response.storedWindow, {
    beforeRequested: 10,
    afterRequested: 10,
    beforeReturned: 1,
    afterReturned: 1,
    returnedCount: 3,
    hasMoreStoredBefore: false,
    hasMoreStoredAfter: true,
  })
  assert.deepEqual(response.ordering, {
    fields: ['eventTime', 'canonicalId'],
    direction: 'ascending',
    quality: 'deterministic',
  })
  assert.deepEqual(response.upstreamCompleteness, {
    status: 'unknown',
    basis: null,
    through: null,
  })
  assert.deepEqual(response.warnings.map((warning) => warning.code), ['upstream_completeness_unknown'])
  assert.equal(JSON.stringify(response).includes('must-not-leak'), false)
  assert.equal(JSON.stringify(response).includes('privateCounter'), false)

  const sqliteResponse = canonicalContextResponse({
    query: { before: 0, after: 0 },
    result: {
      before: [],
      current: canonicalRow({ datasetId: 'telegram.sqlite.messages.v1' }),
      after: [],
      hasMoreStoredBefore: true,
      hasMoreStoredAfter: false,
    },
  })
  assert.deepEqual(sqliteResponse.upstreamCompleteness, {
    status: 'bounded',
    basis: 'append_only_overlap',
    through: null,
  })
  assert.deepEqual(sqliteResponse.warnings.map((warning) => warning.code), ['upstream_completeness_bounded'])
})

test('canonical context endpoint is API-key/grant metered and never calls Launcher identity or an upstream adapter', async () => {
  const store = new MemoryStore()
  const contextCalls = []
  const reservations = []
  const commits = []
  const reserve = store.reserve.bind(store)
  const commitRequest = store.commitRequest.bind(store)
  store.reserve = async (input) => {
    reservations.push(input)
    return reserve(input)
  }
  store.commitRequest = async (requestId, input) => {
    commits.push(input)
    return commitRequest(requestId, input)
  }
  store.getCanonicalContextServingIndexStatus = async () => ({ ready: true, missing: [] })
  store.getCanonicalContext = async (input) => {
    contextCalls.push(input)
    return {
      before: [canonicalRow({
        id: '11111111-1111-4111-8111-111111111111',
        externalId: '-1007:19',
        eventTime: '2026-08-24T09:59:00.000Z',
        side: 'before',
      })],
      current: canonicalRow(),
      after: [],
      hasMoreStoredBefore: false,
      hasMoreStoredAfter: false,
      contextSupported: true,
    }
  }
  let identityCalls = 0
  const identity = {
    enabled: true,
    async resolve() { identityCalls += 1; throw new Error('public route called identity') },
    client: { async signIn() { identityCalls += 1; throw new Error('public route called sign-in') } },
  }
  let adapterCalls = 0
  const adapter = {
    async search() { adapterCalls += 1; throw new Error('context called upstream') },
    async capabilities() { return { data: { platforms: [] } } },
    async dependencies() { return { status: 'up' } },
  }
  const service = new HubService({ store, adapter, apiKeyPepper: PEPPER })
  const tenant = await service.createTenant({ name: 'Context tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Context consumer' })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Context key' })
  await service.putPlatformConfiguration('telegram', {
    tenantId: tenant.id,
    consumerId: consumer.id,
    enabled: true,
    maxRequests: 10,
    windowSeconds: 60,
    maxPageSize: 2,
  })
  const app = createApp({ service, store, adapter, identity, adminToken: ADMIN_TOKEN, logger: { error() {} } })

  await withServer(app, async (baseUrl) => {
    const authorization = { authorization: `Bearer ${key.secret}` }
    const result = await call(
      baseUrl,
      `/api/v1/data/canonical/items/${ANCHOR_ID}/context?before=1&after=0`,
      authorization,
    )
    assert.equal(result.response.status, 200)
    assert.equal(result.payload.data.contractVersion, 'mx-insight-hub.canonical-context.v1')
    assert.equal(result.payload.data.anchorIndex, 1)
    assert.deepEqual(contextCalls, [{ id: ANCHOR_ID, before: 1, after: 0 }])
    assert.equal(identityCalls, 0)
    assert.equal(adapterCalls, 0)
    assert.equal(reservations.length, 1)
    assert.equal(reservations[0].platform, 'telegram')
    assert.equal(reservations[0].capability, undefined)
    assert.equal(commits.length, 1)
    assert.equal(commits[0].unitsActual, 2)
    assert.equal(commits[0].responseBody, null)

    const invalid = await call(
      baseUrl,
      `/api/v1/data/canonical/items/${ANCHOR_ID}/context?before=51`,
      authorization,
    )
    assert.equal(invalid.response.status, 400)
    assert.equal(invalid.payload.error.code, 'invalid_request')
    assert.equal(contextCalls.length, 1)
  })
})

test('canonical context endpoint fails closed for missing grants, unsupported records and missing indexes', async () => {
  const store = new MemoryStore()
  let indexReady = true
  let indexCheckFails = false
  let contextResult = null
  let contextCalls = 0
  store.getCanonicalContextServingIndexStatus = async () => {
    if (indexCheckFails) throw new Error('catalog unavailable')
    return {
      ready: indexReady,
      missing: indexReady ? [] : ['canonical_monitor_tg_messages_chat_time_idx'],
    }
  }
  store.getCanonicalContext = async () => {
    contextCalls += 1
    return contextResult
  }
  const adapter = {
    async search() { throw new Error('context called upstream') },
    async capabilities() { return { data: { platforms: [] } } },
    async dependencies() { return { status: 'up' } },
  }
  const service = new HubService({ store, adapter, apiKeyPepper: PEPPER })
  const tenant = await service.createTenant({ name: 'Context failure tenant' })
  const granted = await service.createConsumer({ tenantId: tenant.id, name: 'Granted context consumer' })
  const grantedKey = await service.createApiKey({ consumerId: granted.id, name: 'Granted context key' })
  await service.putPlatformConfiguration('telegram', {
    tenantId: tenant.id,
    consumerId: granted.id,
    enabled: true,
    maxRequests: 10,
    windowSeconds: 60,
    maxPageSize: 100,
  })
  const denied = await service.createConsumer({ tenantId: tenant.id, name: 'Denied context consumer' })
  const deniedKey = await service.createApiKey({ consumerId: denied.id, name: 'Denied context key' })
  const app = createApp({ service, store, adapter, adminToken: ADMIN_TOKEN, logger: { error() {} } })

  await withServer(app, async (baseUrl) => {
    const path = `/api/v1/data/canonical/items/${ANCHOR_ID}/context`
    const deniedResult = await call(baseUrl, path, { authorization: `Bearer ${deniedKey.secret}` })
    assert.equal(deniedResult.response.status, 403)
    assert.equal(deniedResult.payload.error.code, 'platform_not_granted')
    assert.equal(contextCalls, 0)

    const authorization = { authorization: `Bearer ${grantedKey.secret}` }
    indexReady = false
    const noIndex = await call(baseUrl, path, authorization)
    assert.equal(noIndex.response.status, 503)
    assert.equal(noIndex.payload.error.code, 'serving_indexes_unavailable')
    assert.equal(JSON.stringify(noIndex.payload).includes('canonical_monitor_tg_messages'), false)
    assert.equal(contextCalls, 0)

    indexCheckFails = true
    const noIndexStatus = await call(baseUrl, path, authorization)
    assert.equal(noIndexStatus.response.status, 503)
    assert.equal(noIndexStatus.payload.error.code, 'serving_indexes_unavailable')
    assert.equal(contextCalls, 0)

    indexCheckFails = false
    indexReady = true
    contextResult = null
    const missing = await call(baseUrl, path, authorization)
    assert.equal(missing.response.status, 404)
    assert.equal(missing.payload.error.code, 'item_not_found')

    contextResult = {
      before: [],
      current: canonicalRow({ datasetId: 'telegram.future.messages.v1' }),
      after: [],
      hasMoreStoredBefore: false,
      hasMoreStoredAfter: false,
      contextSupported: false,
    }
    const unsupported = await call(baseUrl, path, authorization)
    assert.equal(unsupported.response.status, 409)
    assert.equal(unsupported.payload.error.code, 'context_not_supported')
  })
})

test('Postgres context lookup uses one bounded statement, dataset/chat partitioning and stable two-sided order', async () => {
  const queries = []
  const rows = [
    canonicalRow(),
    canonicalRow({
      id: '22222222-2222-4222-8222-222222222222',
      externalId: '-1007:19',
      eventTime: '2026-08-24T09:59:00.000Z',
      side: 'before',
    }),
    canonicalRow({
      id: '11111111-1111-4111-8111-111111111111',
      externalId: '-1007:18',
      eventTime: '2026-08-24T09:58:00.000Z',
      side: 'before',
    }),
    canonicalRow({
      id: '00000000-0000-4000-8000-000000000000',
      externalId: '-1007:17',
      eventTime: '2026-08-24T09:57:00.000Z',
      side: 'before',
    }),
    canonicalRow({
      id: '44444444-4444-4444-8444-444444444444',
      externalId: '-1007:21',
      eventTime: '2026-08-24T10:01:00.000Z',
      side: 'after',
    }),
    canonicalRow({
      id: '55555555-5555-4555-8555-555555555555',
      externalId: '-1007:22',
      eventTime: '2026-08-24T10:02:00.000Z',
      side: 'after',
    }),
  ]
  const store = new PostgresStore({
    async query(sql, values) {
      queries.push({ sql, values })
      return { rows }
    },
  })

  const result = await store.getCanonicalContext({ id: ANCHOR_ID, before: 2, after: 1 })
  assert.equal(queries.length, 1)
  assert.deepEqual(queries[0].values, [ANCHOR_ID, 3, 2])
  assert.match(queries[0].sql, /dataset_id = 'telegram\.monitor\.messages\.v1'/)
  assert.match(queries[0].sql, /dataset_id = 'telegram\.sqlite\.messages\.v1'/)
  assert.match(queries[0].sql, /stable_fields #>> '\{relations,chatId\}'/)
  assert.match(queries[0].sql, /\(r\.event_time, r\.id\) < \(a\.event_time, a\.id\)/)
  assert.match(queries[0].sql, /\(r\.event_time, r\.id\) > \(a\.event_time, a\.id\)/)
  assert.match(queries[0].sql, /ORDER BY r\.event_time DESC, r\.id DESC/)
  assert.match(queries[0].sql, /ORDER BY r\.event_time ASC, r\.id ASC/)
  assert.doesNotMatch(queries[0].sql, /raw_payload|extensions/)
  assert.deepEqual(result.before.map((row) => row.external_id), ['-1007:18', '-1007:19'])
  assert.deepEqual(result.after.map((row) => row.external_id), ['-1007:21'])
  assert.equal(result.hasMoreStoredBefore, true)
  assert.equal(result.hasMoreStoredAfter, true)
  assert.equal(result.contextSupported, true)
})

test('Postgres context index gate requires both current Telegram dataset indexes', async () => {
  const required = []
  const store = new PostgresStore({
    async query(_sql, values) {
      required.push(...values[0])
      return {
        rows: [{
          name: 'canonical_sqlite_tg_messages_chat_time_idx',
          indisready: true,
          indisvalid: true,
          indislive: true,
          access_method: 'btree',
          key_count: 3,
          key_1: "stable_fields #>> '{relations,chatId}'::text[]",
          key_2: 'event_time',
          key_3: 'id',
          key_1_options: 0,
          key_2_options: 3,
          key_3_options: 3,
          predicate: [
            "dataset_id = 'telegram.sqlite.messages.v1'::text",
            "platform = 'telegram'::text",
            "object_type = 'message'::text",
            'deleted_at IS NULL',
          ].join(' AND '),
        }],
      }
    },
  })
  const status = await store.getCanonicalContextServingIndexStatus()
  assert.deepEqual(required.sort(), [
    'canonical_monitor_tg_messages_chat_time_idx',
    'canonical_sqlite_tg_messages_chat_time_idx',
  ])
  assert.equal(status.ready, false)
  assert.deepEqual(status.missing, ['canonical_monitor_tg_messages_chat_time_idx'])
})

test('Postgres context index gate preserves case-sensitive JSON path keys', async () => {
  const store = new PostgresStore({
    async query(_sql, values) {
      return {
        rows: values[0].map((name) => ({
          name,
          indisready: true,
          indisvalid: true,
          indislive: true,
          access_method: 'btree',
          key_count: 3,
          key_1: "stable_fields #>> '{relations,chatid}'::text[]",
          key_2: 'event_time',
          key_3: 'id',
          key_1_options: 0,
          key_2_options: 3,
          key_3_options: 3,
          predicate: [
            `dataset_id = '${name.includes('monitor') ? 'telegram.monitor.messages.v1' : 'telegram.sqlite.messages.v1'}'::text`,
            "platform = 'telegram'::text",
            "object_type = 'message'::text",
            'deleted_at IS NULL',
          ].join(' AND '),
        })),
      }
    },
  })

  const status = await store.getCanonicalContextServingIndexStatus()
  assert.equal(status.ready, false)
  assert.deepEqual(status.missing.sort(), [
    'canonical_monitor_tg_messages_chat_time_idx',
    'canonical_sqlite_tg_messages_chat_time_idx',
  ])
})

test('future context datasets derive their SQL branch and index gate from one registry entry', () => {
  const futureDatasetId = 'telegram.future.messages.v1'
  const plan = buildCanonicalContextStoragePlan({
    ...CANONICAL_CONTEXT_DATASETS,
    [futureDatasetId]: {
      objectType: 'message',
      streamType: 'chat',
      servingIndexName: 'canonical_future_tg_messages_chat_time_idx',
      upstreamCompleteness: { status: 'unknown', basis: null, through: null },
    },
  })

  assert.deepEqual(
    plan.indexContracts.map((contract) => contract.datasetId),
    [...Object.keys(CANONICAL_CONTEXT_DATASETS), futureDatasetId],
  )
  assert.equal(
    plan.indexContracts.at(-1).name,
    'canonical_future_tg_messages_chat_time_idx',
  )
  assert.equal(
    plan.querySql.match(new RegExp(`dataset_id = '${futureDatasetId.replaceAll('.', '\\.')}'`, 'g')).length,
    4,
  )
  assert.match(plan.querySql, /context_2_before/)
  assert.match(plan.querySql, /context_2_after/)
})

test('context serving indexes are installed concurrently outside migrations', async () => {
  const sql = await readFile(
    new URL('../../scripts/canonical-context-serving-indexes.sql', import.meta.url),
    'utf8',
  )
  assert.match(sql, /DROP INDEX CONCURRENTLY IF EXISTS core\.canonical_monitor_tg_messages_chat_time_idx/)
  assert.match(sql, /CREATE INDEX CONCURRENTLY canonical_monitor_tg_messages_chat_time_idx/)
  assert.match(sql, /DROP INDEX CONCURRENTLY IF EXISTS core\.canonical_sqlite_tg_messages_chat_time_idx/)
  assert.match(sql, /CREATE INDEX CONCURRENTLY canonical_sqlite_tg_messages_chat_time_idx/)
  assert.match(sql, /dataset_id = 'telegram\.monitor\.messages\.v1'/)
  assert.match(sql, /dataset_id = 'telegram\.sqlite\.messages\.v1'/)
  assert.match(sql, /SELECT count\(\*\) = 2 AND bool_and\(contract_ready\)/)
  assert.doesNotMatch(sql, /CREATE INDEX CONCURRENTLY IF NOT EXISTS/)
  assert.doesNotMatch(sql, /BEGIN|COMMIT/)
  assert.deepEqual(
    [...sql.matchAll(
      /CREATE INDEX CONCURRENTLY ([a-z0-9_]+)[\s\S]*?WHERE dataset_id = '([^']+)'/g,
    )].map((match) => ({ indexName: match[1], datasetId: match[2] })),
    Object.entries(CANONICAL_CONTEXT_DATASETS).map(([datasetId, dataset]) => ({
      indexName: dataset.servingIndexName,
      datasetId,
    })),
  )
})
