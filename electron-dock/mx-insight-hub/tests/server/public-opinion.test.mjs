import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createApp } from '../../server/app.mjs'
import {
  normalizePublicOpinionQuery,
  publicOpinionItem,
  publicOpinionPage,
} from '../../server/data/public-opinion.mjs'
import { publicStoredSearchItem } from '../../server/data/stored-search.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

const ADMIN_TOKEN = 'public-opinion-admin-token'
const PEPPER = 'public-opinion-test-pepper-with-enough-entropy'
const FIRST_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_ID = '22222222-2222-4222-8222-222222222222'

function row(overrides = {}) {
  return {
    id: FIRST_ID,
    title: '江苏舆情样例',
    body: '公开摘要',
    url: 'https://example.test/item',
    content_type: 'social',
    author_name: '江苏新闻广播',
    event_time: new Date('2026-08-23T03:00:00.000Z'),
    collected_at: new Date('2026-08-23T03:01:00.000Z'),
    admin1_code: 'CN-JS',
    heat_score: '88.5',
    stable_fields: {
      attributes: { sourceType: 'social', sourcePlatform: 'douyin', llmLabel: 'private-label' },
    },
    ...overrides,
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

test('province taxonomy normalizes Jiangsu and cursors are bound to province and sort', () => {
  const query = normalizePublicOpinionQuery('江苏省', { sort: 'hot', pageSize: '1' }, 10, PEPPER)
  assert.deepEqual(query.province, { code: 'CN-JS', name: '江苏', officialName: '江苏省' })
  const page = publicOpinionPage([
    row(),
    row({ id: SECOND_ID, heat_score: '70', event_time: new Date('2026-08-22T03:00:00.000Z') }),
  ], query, PEPPER)
  assert.equal(page.items.length, 1)
  assert.ok(page.pageInfo.nextCursor)

  const continued = normalizePublicOpinionQuery('CN-JS', {
    sort: 'hot', pageSize: '1', cursor: page.pageInfo.nextCursor,
  }, 10, PEPPER)
  assert.deepEqual(continued.cursor, {
    heatScore: '88.5',
    sortTime: '2026-08-23T03:00:00.000Z',
    collectedAt: null,
    id: FIRST_ID,
  })
  assert.throws(
    () => normalizePublicOpinionQuery('浙江', {
      sort: 'hot', pageSize: '1', cursor: page.pageInfo.nextCursor,
    }, 10, PEPPER),
    (error) => error.code === 'invalid_cursor',
  )
  assert.throws(
    () => normalizePublicOpinionQuery('江苏', {
      sort: 'latest', pageSize: '1', cursor: page.pageInfo.nextCursor,
    }, 10, PEPPER),
    (error) => error.code === 'invalid_cursor',
  )
  assert.throws(
    () => normalizePublicOpinionQuery('江苏', { cursor: 'x'.repeat(8_193) }, 10, PEPPER),
    (error) => error.code === 'invalid_cursor',
  )

  const latestQuery = normalizePublicOpinionQuery('江苏', { sort: 'latest', pageSize: '1' }, 10, PEPPER)
  const collectedAt = new Date('2026-08-23T04:00:00.000Z')
  const latestPage = publicOpinionPage([
    row({ event_time: null, collected_at: collectedAt, sort_time: collectedAt }),
    row({ id: SECOND_ID, event_time: null, collected_at: new Date('2026-08-23T03:30:00.000Z') }),
  ], latestQuery, PEPPER)
  const latestContinued = normalizePublicOpinionQuery('CN-JS', {
    sort: 'latest', pageSize: '1', cursor: latestPage.pageInfo.nextCursor,
  }, 10, PEPPER)
  assert.deepEqual(latestContinued.cursor, {
    heatScore: null,
    sortTime: '2026-08-23T04:00:00.000Z',
    collectedAt: '2026-08-23T04:00:00.000Z',
    id: FIRST_ID,
  })
})

test('public province item is a strict allowlist', () => {
  const item = publicOpinionItem({
    ...row(),
    strategy_id: 'must-not-leak',
    run_id: 'must-not-leak',
    source_id: 'must-not-leak',
    source_table: 'must-not-leak',
    source_item_id: 'must-not-leak',
    raw: { secret: 'must-not-leak' },
    extensions: { secret: 'must-not-leak' },
    stable_fields: {
      attributes: {
        sourceType: 'social', sourcePlatform: 'douyin',
        llmLabel: 'must-not-leak', llmReason: 'must-not-leak',
      },
    },
  })
  assert.deepEqual(item, {
    id: FIRST_ID,
    title: '江苏舆情样例',
    summary: '公开摘要',
    url: 'https://example.test/item',
    publishedAt: '2026-08-23T03:00:00.000Z',
    collectedAt: '2026-08-23T03:01:00.000Z',
    province: { code: 'CN-JS', name: '江苏' },
    heatScore: 88.5,
    origin: { name: '江苏新闻广播', type: 'social', platform: 'douyin' },
  })
  assert.equal(JSON.stringify(item).includes('must-not-leak'), false)

  const unpublished = publicOpinionItem(row({
    event_time: null,
    collected_at: new Date('2026-08-23T04:00:00.000Z'),
  }))
  assert.equal(unpublished.publishedAt, null)
})

test('public opinion global search keeps the generic shape but masks upstream row identity', () => {
  const item = publicStoredSearchItem({
    id: FIRST_ID,
    datasetId: 'public-opinion.province.v1',
    platform: 'public_opinion',
    objectType: 'opinion_item',
    externalId: 'night-all-source-row-secret',
    eventTime: null,
    collectedAt: '2026-08-23T04:00:00.000Z',
  })
  assert.equal(item.externalId, FIRST_ID)
  assert.equal(JSON.stringify(item).includes('night-all-source-row-secret'), false)
})

test('PostgreSQL province reads have fixed corpus scope, total-order cursors and no private columns', async () => {
  const calls = []
  const store = new PostgresStore({
    async query(sql, values) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values })
      return { rows: [] }
    },
  })
  await store.listPublicOpinionRecords({
    provinceCode: 'CN-JS',
    sort: 'hot',
    pageSize: 20,
    cursor: {
      heatScore: '88.5',
      sortTime: '2026-08-23T03:00:00.000Z',
      id: FIRST_ID,
    },
  })
  await store.listPublicOpinionRecords({
    provinceCode: 'CN-JS',
    sort: 'latest',
    pageSize: 10,
    cursor: {
      sortTime: '2026-08-23T03:00:00.000Z',
      collectedAt: '2026-08-23T03:01:00.000Z',
      id: FIRST_ID,
    },
  })
  await store.getPublicOpinionRecord(FIRST_ID)

  assert.equal(calls.length, 3)
  assert.match(calls[0].sql, /dataset_id = 'public-opinion\.province\.v1'/)
  assert.match(calls[0].sql, /platform = 'public_opinion'/)
  assert.match(calls[0].sql, /object_type = 'opinion_item'/)
  assert.match(calls[0].sql, /admin1_code = \$1/)
  assert.match(calls[0].sql, /\(heat_score, coalesce\(event_time, collected_at\), id\) < \(\$4::numeric, \$5::timestamptz, \$6::uuid\)/)
  assert.match(calls[1].sql, /\(coalesce\(event_time, collected_at\), collected_at, id\) < \(\$5::timestamptz, \$6::timestamptz, \$4::uuid\)/)
  assert.match(calls[2].sql, /deleted_at IS NULL/)
  assert.deepEqual(calls[0].values, [
    'CN-JS', null, null, '88.5', '2026-08-23T03:00:00.000Z', FIRST_ID, 21,
  ])
  assert.deepEqual(calls[1].values, [
    'CN-JS', null, null, FIRST_ID,
    '2026-08-23T03:00:00.000Z', '2026-08-23T03:01:00.000Z', 11,
  ])
  for (const { sql } of calls) {
    assert.doesNotMatch(sql, /raw_payload|extensions|strategy_id|run_id|llm_reason|source_item_id/i)
  }
})

test('PostgreSQL serving readiness requires both exact canonical indexes to be ready and valid', async () => {
  const store = new PostgresStore({
    async query(sql, values) {
      assert.match(sql, /table_rel\.relname = 'canonical_records'/)
      assert.deepEqual(values, [[
        'canonical_province_opinion_hot_idx',
        'canonical_province_opinion_latest_idx',
      ]])
      return {
        rows: [
          {
            name: 'canonical_province_opinion_hot_idx',
            indisready: true,
            indisvalid: true,
            indislive: true,
            access_method: 'btree',
            key_count: 4,
            key_1: 'admin1_code',
            key_2: 'heat_score DESC NULLS LAST',
            key_3: 'COALESCE(event_time, collected_at) DESC NULLS LAST',
            key_4: 'id DESC',
            predicate: "dataset_id = 'public-opinion.province.v1'::text AND platform = 'public_opinion'::text AND object_type = 'opinion_item'::text AND deleted_at IS NULL AND admin1_code IS NOT NULL AND heat_score IS NOT NULL AND collected_at IS NOT NULL",
          },
          {
            name: 'canonical_province_opinion_latest_idx',
            indisready: true,
            indisvalid: true,
            indislive: true,
            access_method: 'btree',
            key_count: 4,
            key_1: 'admin1_code',
            key_2: 'event_time DESC NULLS LAST',
            key_3: 'collected_at DESC NULLS LAST',
            key_4: 'id DESC',
            predicate: "dataset_id = 'public-opinion.province.v1'::text AND platform = 'public_opinion'::text AND object_type = 'opinion_item'::text AND deleted_at IS NULL AND admin1_code IS NOT NULL AND collected_at IS NOT NULL",
          },
        ],
      }
    },
  })
  const status = await store.getPublicOpinionServingIndexStatus()
  assert.equal(status.ready, false)
  assert.deepEqual(status.missing, ['canonical_province_opinion_latest_idx'])
})

test('public province routes enforce grants, paginate safely and keep public_opinion local to Hub', async () => {
  const store = new MemoryStore()
  const listCalls = []
  store.listPublicOpinionRecords = async (input) => {
    listCalls.push(input)
    return input.cursor
      ? [row({ id: SECOND_ID, heat_score: '70', event_time: new Date('2026-08-22T03:00:00.000Z') })]
      : [row(), row({ id: SECOND_ID, heat_score: '70', event_time: new Date('2026-08-22T03:00:00.000Z') })]
  }
  store.getPublicOpinionRecord = async (id) => id === FIRST_ID ? row() : null
  let servingReady = false
  store.getPublicOpinionServingIndexStatus = async () => ({
    ready: servingReady,
    missing: servingReady ? [] : ['canonical_province_opinion_hot_idx'],
  })
  store.externalSources.set('province-opinion-results', {
    id: '33333333-3333-4333-8333-333333333333',
    sourceKey: 'province-opinion-results',
    status: 'paused',
    createdAt: new Date().toISOString(),
  })
  const upstreamCapabilityCalls = []
  const upstreamSearchCalls = []
  const adapter = {
    capabilities: async (platforms) => {
      upstreamCapabilityCalls.push(platforms)
      return { data: { platforms: [], legacySearch: null } }
    },
    search: async (...args) => {
      upstreamSearchCalls.push(args)
      return { payload: { data: { items: [] } }, raw: { data: { items: [] } } }
    },
    dependencies: async () => ({ status: 'up' }),
  }
  const service = new HubService({ store, adapter, apiKeyPepper: PEPPER })
  const tenant = await service.createTenant({ name: 'Province tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Province consumer' })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Province key' })
  await service.putPlatformConfiguration('public_opinion', {
    tenantId: tenant.id,
    consumerId: consumer.id,
    enabled: true,
    maxRequests: 20,
    windowSeconds: 60,
    maxPageSize: 1,
  })
  const noGrantConsumer = await service.createConsumer({ tenantId: tenant.id, name: 'No grant consumer' })
  const noGrantKey = await service.createApiKey({ consumerId: noGrantConsumer.id, name: 'No grant key' })
  const app = createApp({ service, store, adapter, adminToken: ADMIN_TOKEN, logger: { error() {} } })

  await withServer(app, async (baseUrl) => {
    const unauthorized = await call(baseUrl, '/api/v1/data/public-opinion/provinces/CN-JS/items')
    assert.equal(unauthorized.response.status, 401)

    const forbidden = await call(
      baseUrl,
      '/api/v1/data/public-opinion/provinces/CN-JS/items',
      { authorization: `Bearer ${noGrantKey.secret}` },
    )
    assert.equal(forbidden.response.status, 403)
    assert.equal(forbidden.payload.error.code, 'platform_not_granted')

    const headers = { authorization: `Bearer ${key.secret}` }
    const invalid = await call(baseUrl, '/api/v1/data/public-opinion/provinces/火星/items', headers)
    assert.equal(invalid.response.status, 400)
    assert.equal(invalid.payload.error.code, 'invalid_province')

    const capabilities = await call(baseUrl, '/api/v1/data/capabilities', headers)
    assert.equal(capabilities.response.status, 200)
    const platform = capabilities.payload.data.platforms.find((entry) => entry.platform === 'public_opinion')
    assert.deepEqual(platform.capabilities, ['province_feed', 'item_detail', 'stored_search'])
    assert.equal(platform.ready, false)
    assert.deepEqual(upstreamCapabilityCalls, [])

    const legacySearch = await fetch(`${baseUrl}/api/v1/data/search`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key.secret}`,
        'content-type': 'application/json',
        'idempotency-key': 'province-search-unsupported-1',
      },
      body: JSON.stringify({ platform: 'public_opinion', query: '江苏', pageSize: 1 }),
    })
    const legacyPayload = await legacySearch.json()
    assert.equal(legacySearch.status, 400)
    assert.equal(legacyPayload.error.code, 'platform_operation_unsupported')
    assert.deepEqual(upstreamSearchCalls, [])

    const notReady = await call(
      baseUrl,
      '/api/v1/data/public-opinion/provinces/CN-JS/items?sort=hot&pageSize=1',
      headers,
    )
    assert.equal(notReady.response.status, 503)
    assert.equal(notReady.payload.error.code, 'serving_indexes_unavailable')
    assert.equal(JSON.stringify(notReady.payload).includes('canonical_province_opinion'), false)
    assert.deepEqual(listCalls, [])
    servingReady = true

    const first = await call(
      baseUrl,
      '/api/v1/data/public-opinion/provinces/%E6%B1%9F%E8%8B%8F/items?sort=hot&pageSize=1',
      headers,
    )
    assert.equal(first.response.status, 200)
    assert.equal(first.payload.data.items.length, 1)
    assert.ok(first.payload.data.pageInfo.nextCursor)
    assert.equal(listCalls[0].provinceCode, 'CN-JS')
    assert.equal(listCalls[0].sort, 'hot')

    const next = await call(
      baseUrl,
      `/api/v1/data/public-opinion/provinces/CN-JS/items?sort=hot&pageSize=1&cursor=${encodeURIComponent(first.payload.data.pageInfo.nextCursor)}`,
      headers,
    )
    assert.equal(next.response.status, 200)
    assert.equal(next.payload.data.items[0].id, SECOND_ID)
    assert.equal(listCalls[1].cursor.id, FIRST_ID)

    const detail = await call(baseUrl, `/api/v1/data/public-opinion/items/${FIRST_ID}`, headers)
    assert.equal(detail.response.status, 200)
    assert.equal(detail.payload.data.province.code, 'CN-JS')
    const missing = await call(baseUrl, `/api/v1/data/public-opinion/items/${SECOND_ID}`, headers)
    assert.equal(missing.response.status, 404)
    assert.equal(missing.payload.error.code, 'item_not_found')
  })
})
