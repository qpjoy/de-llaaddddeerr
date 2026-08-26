import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createApp } from '../../server/app.mjs'
import {
  normalizePublicOpinionRegionQuery,
  publicOpinionRegionPage,
} from '../../server/data/public-opinion.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

const ADMIN_TOKEN = 'public-opinion-regions-admin-token'
const PEPPER = 'public-opinion-regions-test-pepper-with-enough-entropy'
const ALL_INGESTED_CAPABILITY = 'public_opinion.all_ingested.read'
const FORMAL_ID = '11111111-1111-4111-8111-111111111111'
const UNCLASSIFIED_ID = '22222222-2222-4222-8222-222222222222'
const REJECTED_ID = '33333333-3333-4333-8333-333333333333'

function opinionRow(overrides = {}) {
  return {
    id: FORMAL_ID,
    title: '江苏舆情样例',
    body: '公开摘要',
    url: 'https://example.test/opinion',
    content_type: 'news',
    author_name: '江苏新闻',
    event_time: new Date('2026-08-26T01:00:00.000Z'),
    collected_at: new Date('2026-08-26T01:01:00.000Z'),
    sort_time: new Date('2026-08-26T01:00:00.000Z'),
    admin1_code: 'CN-JS',
    heat_score: '88.5',
    stable_fields: { attributes: { sourceType: 'news', sourcePlatform: 'web' } },
    source_stage: 'formal',
    quality_status: 'formal',
    quality_score: '92',
    qualification_threshold: '80',
    geography_verified: true,
    geo_scope: 'province',
    country_code: 'CN',
    country_name: '中国',
    location_label: '江苏',
    location_type: 'province',
    ...overrides,
  }
}

function regionServingIndexRows(overrides = {}) {
  return [
    {
      name: 'canonical_public_opinion_region_latest_idx',
      table_name: 'canonical_records',
      indisready: true,
      indisvalid: true,
      indislive: true,
      access_method: 'btree',
      key_count: 3,
      key_1: 'COALESCE(event_time, collected_at)',
      key_2: 'collected_at',
      key_3: 'id',
      key_4: null,
      key_1_options: 1,
      key_2_options: 1,
      key_3_options: 3,
      key_4_options: null,
      predicate: "dataset_id = 'public-opinion.province.v1'::text AND platform = 'public_opinion'::text AND object_type = 'opinion_item'::text AND deleted_at IS NULL AND collected_at IS NOT NULL",
      ...overrides.global,
    },
    {
      name: 'public_opinion_current_state_region_idx',
      table_name: 'public_opinion_current_state',
      indisready: true,
      indisvalid: true,
      indislive: true,
      access_method: 'btree',
      key_count: 3,
      key_1: 'display_admin1_code',
      key_2: 'record_id',
      key_3: 'canonical_revision',
      key_4: null,
      key_1_options: 0,
      key_2_options: 0,
      key_3_options: 0,
      key_4_options: null,
      predicate: 'display_admin1_code IS NOT NULL',
      ...overrides.display,
    },
  ]
}

async function withFixture(run) {
  const store = new MemoryStore()
  const globalListCalls = []
  const provinceListCalls = []
  store.listPublicOpinionRegionRecords = async (query) => {
    globalListCalls.push(query)
    return [
      opinionRow(),
      opinionRow({
        id: UNCLASSIFIED_ID,
        title: '未分类未评分候选',
        event_time: null,
        collected_at: new Date('2026-08-26T00:30:00.000Z'),
        sort_time: new Date('2026-08-26T00:30:00.000Z'),
        admin1_code: null,
        source_stage: 'candidate',
        quality_status: 'pending',
        quality_score: null,
        geography_verified: false,
        geo_scope: 'unknown',
        location_label: null,
        location_type: null,
      }),
      opinionRow({
        id: REJECTED_ID,
        title: '已拒绝候选',
        event_time: null,
        collected_at: new Date('2026-08-25T23:30:00.000Z'),
        sort_time: new Date('2026-08-25T23:30:00.000Z'),
        admin1_code: 'CN-BJ',
        source_stage: 'candidate',
        quality_status: 'rejected',
        quality_score: '12',
        geography_verified: false,
      }),
    ]
  }
  store.listPublicOpinionRecords = async (query) => {
    provinceListCalls.push(query)
    return [opinionRow()]
  }
  store.getPublicOpinionServingIndexStatus = async () => ({ ready: true, missing: [] })
  store.getPublicOpinionRegionServingIndexStatus = async () => ({ ready: true, missing: [] })
  store.externalSources.set('province-opinion-results', {
    id: '44444444-4444-4444-8444-444444444444',
    sourceKey: 'province-opinion-results',
    status: 'active',
    createdAt: new Date().toISOString(),
  })

  const adapter = {
    capabilities: async () => ({ data: { platforms: [], legacySearch: null } }),
    dependencies: async () => ({ status: 'up' }),
  }
  const service = new HubService({ store, adapter, apiKeyPepper: PEPPER })
  const tenant = await service.createTenant({ name: 'Public opinion regions tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Regions consumer' })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Regions key' })
  await service.putPlatformConfiguration('public_opinion', {
    tenantId: tenant.id,
    consumerId: consumer.id,
    enabled: true,
    maxRequests: 100,
    windowSeconds: 3_600,
    maxPageSize: 100,
  })
  const noGrantConsumer = await service.createConsumer({
    tenantId: tenant.id,
    name: 'Regions consumer without platform grant',
  })
  const noGrantKey = await service.createApiKey({
    consumerId: noGrantConsumer.id,
    name: 'Regions no-grant key',
  })

  const server = createServer(createApp({
    service,
    store,
    adapter,
    adminToken: ADMIN_TOKEN,
    logger: { error() {} },
  }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const call = async (path, secret = key.secret) => {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    })
    return { response, payload: await response.json() }
  }

  try {
    await run({
      store,
      service,
      tenant,
      consumer,
      key,
      noGrantKey,
      call,
      globalListCalls,
      provinceListCalls,
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('GET regions returns the stable 34-province directory under the public_opinion grant', async () => {
  await withFixture(async ({ call, noGrantKey }) => {
    const unauthenticated = await call(
      '/api/v1/data/public-opinion/regions?parentCode=CN&level=province',
      null,
    )
    assert.equal(unauthenticated.response.status, 401)

    const forbidden = await call(
      '/api/v1/data/public-opinion/regions?parentCode=CN&level=province',
      noGrantKey.secret,
    )
    assert.equal(forbidden.response.status, 403)
    assert.equal(forbidden.payload.error.code, 'platform_not_granted')

    const result = await call('/api/v1/data/public-opinion/regions?parentCode=CN&level=province')
    assert.equal(result.response.status, 200)
    assert.equal(result.payload.data.parentCode, 'CN')
    assert.equal(result.payload.data.level, 'province')
    assert.equal(result.payload.data.regions.length, 34)
    assert.equal(new Set(result.payload.data.regions.map((region) => region.code)).size, 34)
    assert.deepEqual(
      result.payload.data.regions.find((region) => region.code === 'CN-JS'),
      {
        code: 'CN-JS',
        name: '江苏',
        officialName: '江苏省',
        level: 'province',
        parentCode: 'CN',
      },
    )
    assert.ok(result.payload.data.regions.some((region) => region.code === 'CN-HK'))
    assert.ok(result.payload.data.regions.some((region) => region.code === 'CN-MO'))
  })
})

test('CN all_ingested is separately granted while the legacy province feed stays unchanged', async () => {
  await withFixture(async ({
    store,
    service,
    tenant,
    consumer,
    call,
    globalListCalls,
    provinceListCalls,
  }) => {
    const legacy = await call(
      '/api/v1/data/public-opinion/provinces/CN-JS/items?sort=latest&pageSize=20',
    )
    assert.equal(legacy.response.status, 200)
    assert.equal(legacy.payload.data.province.code, 'CN-JS')
    assert.equal(legacy.payload.data.items.length, 1)
    assert.equal('quality' in legacy.payload.data.items[0], false)
    assert.equal(provinceListCalls.length, 1)

    const path = '/api/v1/data/public-opinion/regions/CN/items'
      + '?visibility=all_ingested&sort=latest&pageSize=50'
      + '&from=2026-08-24T00%3A00%3A00%2B08%3A00'
      + '&to=2026-08-26T23%3A59%3A59%2B08%3A00'
    const forbidden = await call(path)
    assert.equal(forbidden.response.status, 403)
    assert.equal(forbidden.payload.error.code, 'capability_not_granted')
    assert.equal(globalListCalls.length, 0)

    await service.putCapabilityConfiguration(ALL_INGESTED_CAPABILITY, {
      tenantId: tenant.id,
      consumerId: consumer.id,
      enabled: true,
      maxRequests: 100,
      windowSeconds: 3_600,
    })
    const capabilities = await call('/api/v1/data/capabilities')
    assert.deepEqual(
      capabilities.payload.data.capabilities.find(
        (entry) => entry.capability === ALL_INGESTED_CAPABILITY,
      ),
      { capability: ALL_INGESTED_CAPABILITY, ready: true },
    )

    const result = await call(path)
    assert.equal(result.response.status, 200)
    assert.deepEqual(result.payload.data.visibility, {
      mode: 'all_ingested',
      qualityFiltered: false,
      corpusDefinition: 'canonical_current_safe',
    })
    assert.equal(result.payload.data.region.code, 'CN')
    assert.equal(result.payload.data.items.length, 3)
    assert.equal(result.payload.data.pageInfo.returnedCount, 3)
    assert.equal(result.payload.data.pageInfo.hasMore, false)
    assert.equal(result.payload.data.pageInfo.nextCursor, null)

    const unclassified = result.payload.data.items.find((item) => item.id === UNCLASSIFIED_ID)
    assert.equal(unclassified.province, null)
    assert.equal(unclassified.quality.stage, 'candidate')
    assert.equal(unclassified.quality.status, 'pending')
    assert.equal(unclassified.quality.score, null)
    const rejected = result.payload.data.items.find((item) => item.id === REJECTED_ID)
    assert.equal(rejected.quality.status, 'rejected')
    assert.equal(rejected.quality.score, 12)
    assert.equal(JSON.stringify(result.payload).includes('raw_payload'), false)

    assert.equal(globalListCalls.length, 1)
    assert.equal(globalListCalls[0].regionCode, 'CN')
    assert.equal(globalListCalls[0].visibility, 'all_ingested')
    assert.equal(globalListCalls[0].minQualityScore ?? null, null)
    assert.equal(globalListCalls[0].provinceCode ?? null, null)

    store.getPublicOpinionRegionServingIndexStatus = async () => {
      throw new Error('catalog unavailable')
    }
    const unavailable = await call(path)
    assert.equal(unavailable.response.status, 503)
    assert.equal(unavailable.payload.error.code, 'serving_indexes_unavailable')
  })
})

test('PostgreSQL CN all_ingested scope keeps every current safe row except deleted rows', async () => {
  const calls = []
  const store = new PostgresStore({
    async query(sql, values) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values })
      return { rows: [] }
    },
  })

  await store.listPublicOpinionRegionRecords({
    regionCode: 'CN',
    visibility: 'all_ingested',
    sort: 'latest',
    from: '2026-08-24T00:00:00.000Z',
    to: '2026-08-26T15:59:59.000Z',
    pageSize: 50,
    cursor: null,
  })

  assert.equal(calls.length, 1)
  const [{ sql }] = calls
  assert.match(sql, /record\.dataset_id = 'public-opinion\.province\.v1'/)
  assert.match(sql, /record\.platform = 'public_opinion'/)
  assert.match(sql, /record\.object_type = 'opinion_item'/)
  assert.match(sql, /record\.deleted_at IS NULL/)
  assert.match(sql, /publication\.canonical_revision = record\.current_revision/)
  assert.doesNotMatch(sql, /publication\.display_admin1_code\s*=/)
  assert.doesNotMatch(sql, /publication\.display_admin1_code IS NOT NULL/)
  assert.doesNotMatch(sql, /publication\.status\s*=/)
  assert.doesNotMatch(sql, /publication\.quality_score\s*>?=/)
  assert.match(sql, /ORDER BY coalesce\(record\.event_time, record\.collected_at\) DESC/)
  assert.doesNotMatch(
    sql,
    /raw_payload|extensions|strategy_id|run_id|llm_reason|source_item_id/i,
  )
})

test('PostgreSQL province all_ingested scope filters only the display province, never quality', async () => {
  const calls = []
  const store = new PostgresStore({
    async query(sql, values) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values })
      return { rows: [] }
    },
  })
  await store.listPublicOpinionRegionRecords({
    regionCode: 'CN-JS',
    visibility: 'all_ingested',
    sort: 'latest',
    from: '2026-08-24T00:00:00.000Z',
    to: '2026-08-26T15:59:59.000Z',
    pageSize: 50,
    cursor: null,
  })
  assert.equal(calls.length, 1)
  assert.match(calls[0].sql, /publication\.display_admin1_code = \$3/)
  assert.equal(calls[0].values[2], 'CN-JS')
  assert.doesNotMatch(calls[0].sql, /publication\.status\s*=/)
  assert.doesNotMatch(calls[0].sql, /publication\.quality_score\s*>?=/)
})

test('region feed readiness requires both the global latest and display-province index contracts', async () => {
  const statuses = async (rows) => {
    const store = new PostgresStore({
      async query(sql, values) {
        assert.match(sql, /public_opinion_current_state/)
        assert.deepEqual(values, [[
          'canonical_public_opinion_region_latest_idx',
          'public_opinion_current_state_region_idx',
        ]])
        return { rows }
      },
    })
    return store.getPublicOpinionRegionServingIndexStatus()
  }
  const ready = await statuses(regionServingIndexRows())
  assert.equal(ready.ready, true)
  assert.deepEqual(ready.missing, [])

  const drifted = await statuses(regionServingIndexRows({
    global: { key_1_options: 3 },
    display: { table_name: 'canonical_records' },
  }))
  assert.equal(drifted.ready, false)
  assert.deepEqual(drifted.missing, [
    'canonical_public_opinion_region_latest_idx',
    'public_opinion_current_state_region_idx',
  ])
})

test('all_ingested stays bounded, latest-only and cursor-bound to the exact region window', () => {
  const input = {
    visibility: 'all_ingested',
    sort: 'latest',
    from: '2026-08-24T00:00:00+08:00',
    to: '2026-08-26T23:59:59+08:00',
    pageSize: '1',
  }
  const query = normalizePublicOpinionRegionQuery('CN', input, 100, PEPPER)
  const page = publicOpinionRegionPage([
    opinionRow(),
    opinionRow({ id: UNCLASSIFIED_ID, collected_at: new Date('2026-08-26T00:30:00.000Z') }),
  ], query, PEPPER)
  assert.equal(page.items.length, 1)
  assert.equal(page.pageInfo.hasMore, true)
  assert.ok(page.pageInfo.nextCursor)

  const continued = normalizePublicOpinionRegionQuery('CN', {
    ...input,
    cursor: page.pageInfo.nextCursor,
  }, 100, PEPPER)
  assert.deepEqual(continued.cursor, {
    heatScore: null,
    sortTime: '2026-08-26T01:00:00.000Z',
    collectedAt: '2026-08-26T01:01:00.000Z',
    id: FORMAL_ID,
  })
  assert.throws(
    () => normalizePublicOpinionRegionQuery('CN-JS', {
      ...input,
      cursor: page.pageInfo.nextCursor,
    }, 100, PEPPER),
    (error) => error.code === 'invalid_cursor',
  )
  assert.throws(
    () => normalizePublicOpinionRegionQuery('CN', {
      ...input,
      to: '2026-08-27T23:59:59+08:00',
      cursor: page.pageInfo.nextCursor,
    }, 100, PEPPER),
    (error) => error.code === 'invalid_cursor',
  )
  assert.throws(
    () => normalizePublicOpinionRegionQuery('CN', {
      visibility: 'all_ingested',
      sort: 'latest',
    }, 100, PEPPER),
    (error) => error.code === 'all_ingested_scope_required',
  )
  assert.throws(
    () => normalizePublicOpinionRegionQuery('CN', { ...input, sort: 'hot' }, 100, PEPPER),
    (error) => error.code === 'invalid_sort',
  )
  assert.throws(
    () => normalizePublicOpinionRegionQuery('CN', { ...input, minQualityScore: '0' }, 100, PEPPER),
    (error) => error.code === 'unsupported_fields',
  )
})
