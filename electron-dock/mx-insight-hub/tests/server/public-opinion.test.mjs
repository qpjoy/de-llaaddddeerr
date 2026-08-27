import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createApp } from '../../server/app.mjs'
import {
  normalizePublicOpinionCoverageQuery,
  normalizePublicOpinionDetailQuery,
  normalizePublicOpinionQuery,
  publicOpinionCoverage,
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

function servingIndexRows(overrides = {}) {
  const predicatePrefix = "dataset_id = 'public-opinion.province.v1'::text AND platform = 'public_opinion'::text AND object_type = 'opinion_item'::text AND deleted_at IS NULL AND admin1_code IS NOT NULL"
  return [
    {
      name: 'canonical_province_opinion_hot_idx',
      indisready: true,
      indisvalid: true,
      indislive: true,
      access_method: 'btree',
      key_count: 4,
      key_1: 'admin1_code',
      key_2: 'heat_score',
      key_3: 'COALESCE(event_time, collected_at)',
      key_4: 'id',
      key_1_options: 0,
      key_2_options: 1,
      key_3_options: 1,
      key_4_options: 3,
      predicate: `${predicatePrefix} AND heat_score IS NOT NULL AND collected_at IS NOT NULL`,
      ...overrides.hot,
    },
    {
      name: 'canonical_province_opinion_latest_idx',
      indisready: true,
      indisvalid: true,
      indislive: true,
      access_method: 'btree',
      key_count: 4,
      key_1: 'admin1_code',
      key_2: 'COALESCE(event_time, collected_at)',
      key_3: 'collected_at',
      key_4: 'id',
      key_1_options: 0,
      key_2_options: 1,
      key_3_options: 1,
      key_4_options: 3,
      predicate: `${predicatePrefix} AND collected_at IS NOT NULL`,
      ...overrides.latest,
    },
  ]
}

async function servingIndexStatus(overrides = {}) {
  const store = new PostgresStore({
    async query(sql, values) {
      assert.match(sql, /table_rel\.relname = 'canonical_records'/)
      assert.match(sql, /index_meta\.indoption\[0\]::integer AS key_1_options/)
      assert.deepEqual(values, [[
        'canonical_province_opinion_hot_idx',
        'canonical_province_opinion_latest_idx',
      ]])
      return { rows: servingIndexRows(overrides) }
    },
  })
  return store.getPublicOpinionServingIndexStatus()
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

test('candidate visibility is opt-in, quality bounded and all requires a list time window', () => {
  const formal = normalizePublicOpinionQuery('江苏', {}, 100, PEPPER)
  assert.equal(formal.candidateMode, 'formal')
  assert.equal(formal.minQualityScore, null)
  assert.equal('quality' in publicOpinionPage([row()], formal, PEPPER).items[0], false)

  const qualified = normalizePublicOpinionQuery('江苏', {
    includeCandidates: 'qualified', minQualityScore: '85',
  }, 100, PEPPER)
  assert.equal(qualified.candidateMode, 'qualified')
  assert.equal(qualified.minQualityScore, 85)
  const qualifiedItem = publicOpinionPage([row({
    source_stage: 'candidate',
    quality_status: 'qualified',
    quality_score: 91,
    qualification_threshold: 85,
    geography_verified: true,
  })], qualified, PEPPER).items[0]
  assert.deepEqual(qualifiedItem.quality, {
    stage: 'candidate', status: 'qualified', score: 91, threshold: 85, geographyVerified: true,
  })

  const trueAlias = normalizePublicOpinionQuery('江苏', { includeCandidates: 'true' }, 100, PEPPER)
  assert.equal(trueAlias.candidateMode, 'qualified')
  assert.equal(trueAlias.minQualityScore, 80)
  assert.throws(
    () => normalizePublicOpinionQuery('江苏', { minQualityScore: '80' }, 100, PEPPER),
    (error) => error.code === 'invalid_request',
  )
  assert.throws(
    () => normalizePublicOpinionQuery('江苏', { includeCandidates: 'all' }, 100, PEPPER),
    (error) => error.code === 'candidate_scope_required',
  )
  const all = normalizePublicOpinionQuery('江苏', {
    includeCandidates: 'all',
    from: '2026-08-24T00:00:00Z',
    to: '2026-08-25T23:59:59Z',
  }, 100, PEPPER)
  assert.equal(all.candidateMode, 'all')
  assert.equal(all.minQualityScore, null)

  assert.equal(normalizePublicOpinionDetailQuery({ includeCandidates: 'all' }).candidateMode, 'all')
})

test('province coverage requires a bounded window and returns full safe coverage', () => {
  assert.throws(
    () => normalizePublicOpinionCoverageQuery({}),
    (error) => error.code === 'invalid_request',
  )
  const query = normalizePublicOpinionCoverageQuery({
    from: '2026-08-24T00:00:00Z',
    to: '2026-08-25T23:59:59Z',
    includeCandidates: 'qualified',
    minQualityScore: '80',
    targetPerProvince: '10',
  })
  const coverage = publicOpinionCoverage([{
    province_code: 'CN-JS',
    formal_count: '4',
    qualified_candidate_count: '7',
    candidate_count: '12',
    verified_count: '9',
    average_quality_score: '88.5',
    raw_payload: 'must-not-leak',
    provider_id: 'must-not-leak',
  }], query)
  assert.equal(coverage.contractVersion, 'mx-insight-hub.public-opinion.coverage.v1')
  assert.equal(coverage.includeCandidates, 'qualified')
  assert.equal(coverage.provinces.length, 34)
  assert.equal(coverage.featuredProvinceCodes.length, 8)
  const jiangsu = coverage.provinces.find((item) => item.province.code === 'CN-JS')
  assert.equal(jiangsu.availableCount, 11)
  assert.equal(jiangsu.qualifiedCandidateRate, 0.583)
  assert.equal(jiangsu.verifiedRate, 0.818)
  assert.equal(jiangsu.shortfall, 0)
  assert.equal(jiangsu.meetsTarget, true)
  assert.equal(JSON.stringify(coverage).includes('must-not-leak'), false)
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

  const candidate = publicOpinionItem({
    ...row(),
    source_stage: 'candidate',
    quality_status: 'qualified',
    quality_score: '91',
    qualification_threshold: '80',
    geography_verified: true,
    location_label: '南京',
    location_type: 'city',
    country_name: '中国',
    country_code: 'CN',
    geo_scope: 'province',
    provider_id: 'must-not-leak',
    endpoint_id: 'must-not-leak',
    credential_id: 'must-not-leak',
    business_id: 'must-not-leak',
    availability_mode: 'must-not-leak',
  }, { includeQuality: true })
  assert.deepEqual(candidate.quality, {
    stage: 'candidate', status: 'qualified', score: 91, threshold: 80, geographyVerified: true,
  })
  assert.deepEqual(candidate.location, {
    label: '南京', type: 'city', country: '中国', countryCode: 'CN', geoScope: 'province',
  })
  assert.deepEqual(candidate.origin, { name: null, type: null, platform: null })
  assert.equal(JSON.stringify(candidate).includes('must-not-leak'), false)
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
    candidateMode: 'qualified',
    minQualityScore: 85,
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
  await store.getPublicOpinionProvinceCoverage({
    from: '2026-08-23T00:00:00.000Z',
    to: '2026-08-24T00:00:00.000Z',
    candidateMode: 'qualified',
    minQualityScore: 80,
  })

  assert.equal(calls.length, 4)
  assert.match(calls[0].sql, /dataset_id = 'public-opinion\.province\.v1'/)
  assert.match(calls[0].sql, /platform = 'public_opinion'/)
  assert.match(calls[0].sql, /object_type = 'opinion_item'/)
  assert.match(calls[0].sql, /publication\.display_admin1_code = \$1/)
  assert.doesNotMatch(calls[0].sql, /coalesce\(publication\.display_admin1_code, record\.admin1_code\)/)
  assert.match(calls[0].sql, /CASE WHEN publication\.source_stage = 'candidate'[\s\S]+coalesce\(record\.event_time, record\.collected_at\)[\s\S]+ELSE record\.event_time/)
  assert.match(calls[0].sql, /publication\.canonical_revision = record\.current_revision/)
  assert.match(calls[0].sql, /publication\.source_stage = 'formal'/)
  assert.match(calls[0].sql, /publication\.source_stage = 'candidate'/)
  assert.match(calls[0].sql, /\(record\.heat_score, coalesce\(record\.event_time, record\.collected_at\), record\.id\) < \(\$6::numeric, \$7::timestamptz, \$8::uuid\)/)
  assert.match(calls[1].sql, /\(coalesce\(record\.event_time, record\.collected_at\), record\.collected_at, record\.id\) < \(\$7::timestamptz, \$8::timestamptz, \$6::uuid\)/)
  assert.match(calls[2].sql, /deleted_at IS NULL/)
  assert.deepEqual(calls[0].values, [
    'CN-JS', null, null, 'qualified', 85,
    '88.5', '2026-08-23T03:00:00.000Z', FIRST_ID, 21,
  ])
  assert.deepEqual(calls[1].values, [
    'CN-JS', null, null, 'formal', null, FIRST_ID,
    '2026-08-23T03:00:00.000Z', '2026-08-23T03:01:00.000Z', 11,
  ])
  assert.deepEqual(calls[2].values, [FIRST_ID, 'formal', null])
  assert.deepEqual(calls[3].values, [
    '2026-08-23T00:00:00.000Z', '2026-08-24T00:00:00.000Z', 'qualified', 80,
  ])
  assert.match(calls[3].sql, /AS qualified_candidate_count/)
  assert.match(calls[3].sql, /AS verified_count/)
  assert.match(calls[3].sql, /CASE WHEN publication\.source_stage = 'candidate'[\s\S]+coalesce\(record\.event_time, record\.collected_at\)[\s\S]+ELSE record\.event_time/)
  for (const { sql } of calls) {
    assert.doesNotMatch(sql, /raw_payload|extensions|strategy_id|run_id|llm_reason|source_item_id/i)
  }
})

test('PostgreSQL serving readiness accepts exact expressions, sort options and predicates', async () => {
  const status = await servingIndexStatus()
  assert.equal(status.ready, true)
  assert.deepEqual(status.missing, [])
})

test('PostgreSQL serving readiness rejects expression and sort-option drift', async () => {
  const status = await servingIndexStatus({
    latest: { key_2: 'event_time' },
  })
  assert.equal(status.ready, false)
  assert.deepEqual(status.missing, ['canonical_province_opinion_latest_idx'])

  const wrongNullOrder = await servingIndexStatus({
    hot: { key_2_options: 3 },
  })
  assert.equal(wrongNullOrder.ready, false)
  assert.deepEqual(wrongNullOrder.missing, ['canonical_province_opinion_hot_idx'])
})

test('public province routes enforce grants, paginate safely and keep public_opinion local to Hub', async () => {
  const store = new MemoryStore()
  const listCalls = []
  store.listPublicOpinionRecords = async (input) => {
    listCalls.push(input)
    if (input.candidateMode !== 'formal') {
      return [row({
        source_stage: 'candidate',
        quality_status: 'qualified',
        quality_score: '91',
        qualification_threshold: String(input.minQualityScore ?? 80),
        geography_verified: true,
        location_label: '南京',
        location_type: 'city',
        country_name: '中国',
        country_code: 'CN',
        geo_scope: 'province',
      })]
    }
    return input.cursor
      ? [row({ id: SECOND_ID, heat_score: '70', event_time: new Date('2026-08-22T03:00:00.000Z') })]
      : [row(), row({ id: SECOND_ID, heat_score: '70', event_time: new Date('2026-08-22T03:00:00.000Z') })]
  }
  const detailCalls = []
  store.getPublicOpinionRecord = async (id, query) => {
    detailCalls.push({ id, query })
    if (id !== FIRST_ID) return null
    if (query?.candidateMode !== 'formal') {
      return row({
        source_stage: 'candidate', quality_status: 'qualified', quality_score: '91',
        qualification_threshold: String(query.minQualityScore ?? 80), geography_verified: true,
      })
    }
    return row()
  }
  const coverageCalls = []
  store.getPublicOpinionProvinceCoverage = async (input) => {
    coverageCalls.push(input)
    return [{
      province_code: 'CN-JS', formal_count: 4, qualified_candidate_count: 7,
      candidate_count: 12, verified_count: 9, average_quality_score: 88.5,
    }]
  }
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
    assert.deepEqual(platform.capabilities, [
      'province_feed',
      'province_coverage',
      'region_catalog',
      'region_feed',
      'item_detail',
      'stored_search',
      'diagnostics',
    ])
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
    assert.equal('quality' in first.payload.data.items[0], false)
    assert.equal('location' in first.payload.data.items[0], false)
    assert.equal(listCalls[0].provinceCode, 'CN-JS')
    assert.equal(listCalls[0].sort, 'hot')
    assert.equal(listCalls[0].candidateMode, 'formal')

    const next = await call(
      baseUrl,
      `/api/v1/data/public-opinion/provinces/CN-JS/items?sort=hot&pageSize=1&cursor=${encodeURIComponent(first.payload.data.pageInfo.nextCursor)}`,
      headers,
    )
    assert.equal(next.response.status, 200)
    assert.equal(next.payload.data.items[0].id, SECOND_ID)
    assert.equal(listCalls[1].cursor.id, FIRST_ID)

    const qualified = await call(
      baseUrl,
      '/api/v1/data/public-opinion/provinces/CN-JS/items?includeCandidates=qualified&minQualityScore=85',
      headers,
    )
    assert.equal(qualified.response.status, 200)
    assert.equal(listCalls[2].candidateMode, 'qualified')
    assert.equal(listCalls[2].minQualityScore, 85)
    assert.equal(qualified.payload.data.items[0].quality.status, 'qualified')
    assert.equal(qualified.payload.data.items[0].location.label, '南京')
    assert.equal(JSON.stringify(qualified.payload).includes('source_stage'), false)

    const unboundedAll = await call(
      baseUrl,
      '/api/v1/data/public-opinion/provinces/CN-JS/items?includeCandidates=all',
      headers,
    )
    assert.equal(unboundedAll.response.status, 400)
    assert.equal(unboundedAll.payload.error.code, 'candidate_scope_required')
    assert.equal(listCalls.length, 3)

    const boundedAll = await call(
      baseUrl,
      '/api/v1/data/public-opinion/provinces/CN-JS/items?includeCandidates=all&from=2026-08-24T00%3A00%3A00Z&to=2026-08-25T23%3A59%3A59Z',
      headers,
    )
    assert.equal(boundedAll.response.status, 200)
    assert.equal(listCalls[3].candidateMode, 'all')
    assert.equal(listCalls[3].from, '2026-08-24T00:00:00.000Z')

    const coverage = await call(
      baseUrl,
      '/api/v1/data/public-opinion/province-coverage?from=2026-08-24T00%3A00%3A00Z&to=2026-08-25T23%3A59%3A59Z&includeCandidates=qualified&minQualityScore=80&targetPerProvince=10',
      headers,
    )
    assert.equal(coverage.response.status, 200)
    assert.equal(coverageCalls.length, 1)
    assert.equal(coverageCalls[0].candidateMode, 'qualified')
    assert.equal(coverage.payload.data.provinces.length, 34)
    assert.equal(coverage.payload.data.provinces[0].province.code, 'CN-BJ')
    assert.equal(JSON.stringify(coverage.payload).includes('provider_id'), false)

    const detail = await call(baseUrl, `/api/v1/data/public-opinion/items/${FIRST_ID}`, headers)
    assert.equal(detail.response.status, 200)
    assert.equal(detail.payload.data.province.code, 'CN-JS')
    assert.equal('quality' in detail.payload.data, false)
    assert.equal(detailCalls[0].query.candidateMode, 'formal')
    const candidateDetail = await call(
      baseUrl,
      `/api/v1/data/public-opinion/items/${FIRST_ID}?includeCandidates=qualified&minQualityScore=85`,
      headers,
    )
    assert.equal(candidateDetail.response.status, 200)
    assert.equal(candidateDetail.payload.data.quality.score, 91)
    assert.equal(detailCalls[1].query.candidateMode, 'qualified')
    const missing = await call(baseUrl, `/api/v1/data/public-opinion/items/${SECOND_ID}`, headers)
    assert.equal(missing.response.status, 404)
    assert.equal(missing.payload.error.code, 'item_not_found')
  })
})
