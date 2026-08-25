import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  normalizeCanonicalSearchQuery,
  normalizeStoredSearchQuery,
  publicStoredSearchItem,
  storedSearchResponse,
} from '../../server/data/stored-search.mjs'
import { requestFingerprint } from '../../server/core/crypto.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { contentIndex } from '../../server/search/index-definitions.mjs'
import { DEFAULT_SEARCH_PROFILE } from '../../server/search/profiles.mjs'
import { SearchQueries } from '../../server/search/queries.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const PEPPER = 'public-opinion-search-visibility-test-pepper'
const READ_ALIAS = 'mx-insight-hub-content'

function searchQueries({ client = null, pool = { async query() { return { rows: [] } } } } = {}) {
  return new SearchQueries({
    pool,
    client,
    segmenter: { async segment(value) { return [value] } },
    indexSet: { readAlias: READ_ALIAS },
    logger: { warn() {} },
  })
}

function elasticsearchCapture() {
  const searches = []
  return {
    searches,
    client: {
      async getAlias() {
        return { 'mx-insight-hub-content-v5-current': { aliases: { [READ_ALIAS]: {} } } }
      },
      async request(method, path, body) {
        if (path.includes('/_pit?')) return { id: `pit-${searches.length + 1}` }
        if (path === '/_search') {
          searches.push(body)
          return { pit_id: `pit-${searches.length}-renewed`, hits: { total: { value: 0, relation: 'eq' }, hits: [] } }
        }
        if (method === 'DELETE' && path === '/_pit') return { succeeded: true }
        throw new Error(`unexpected ${method} ${path}`)
      },
    },
  }
}

test('public-opinion exact filters are scoped, normalized and preserve the legacy default binding', () => {
  const defaults = normalizeStoredSearchQuery({
    platform: 'public_opinion', query: '处置', pageSize: 20,
  }, 100, PEPPER)
  const legacyBinding = createHash('sha256').update(JSON.stringify({
    v: 2,
    sort: 'score-eventTime-id-sharddoc-or-eventTime-id-v2',
    query: '处置',
    platform: 'public_opinion',
    datasetId: null,
    objectType: null,
    pageSize: 20,
  })).digest('base64url')
  assert.equal(defaults.cursorBinding, legacyBinding)
  assert.deepEqual(defaults.publicOpinionVisibility, {
    candidateMode: 'formal', minQualityScore: null, provinceCode: null,
    countryCode: null, location: null, from: null, to: null, explicit: false,
  })

  const qualified = normalizeStoredSearchQuery({
    platform: 'public_opinion', query: '处置', includeCandidates: 'qualified', province: '江苏',
  }, 100, PEPPER)
  assert.deepEqual(qualified.publicOpinionVisibility, {
    candidateMode: 'qualified', minQualityScore: 80, provinceCode: 'CN-JS',
    countryCode: null, location: null, from: null, to: null, explicit: true,
  })
  assert.notEqual(qualified.cursorBinding, defaults.cursorBinding)

  assert.throws(
    () => normalizeStoredSearchQuery({
      platform: 'xiaohongshu', query: '处置', province: '江苏',
    }, 100, PEPPER),
    (error) => error.status === 400 && error.code === 'invalid_request',
  )
  assert.throws(
    () => normalizeCanonicalSearchQuery({ query: '处置', includeCandidates: 'qualified' }, {
      platforms: ['public_opinion'], cursorSecret: PEPPER,
    }),
    (error) => error.status === 400 && error.code === 'invalid_request',
  )
  assert.throws(
    () => normalizeStoredSearchQuery({
      platform: 'public_opinion', query: '处置', includeCandidates: 'all',
      from: '2026-08-24T00:00:00Z', to: '2026-08-25T00:00:00Z',
    }, 100, PEPPER),
    (error) => error.status === 400 && error.code === 'candidate_scope_required',
  )
  const all = normalizeStoredSearchQuery({
    platform: 'public_opinion', query: '处置', includeCandidates: 'all', province: '江苏省',
    from: '2026-08-24T00:00:00Z', to: '2026-08-25T00:00:00Z',
  }, 100, PEPPER)
  assert.deepEqual(all.publicOpinionVisibility, {
    candidateMode: 'all', minQualityScore: null, provinceCode: 'CN-JS',
    countryCode: null, location: null,
    from: '2026-08-24T00:00:00.000Z', to: '2026-08-25T00:00:00.000Z', explicit: true,
  })
  const overseas = normalizeStoredSearchQuery({
    platform: 'public_opinion', query: '处置', includeCandidates: 'all', countryCode: 'ss',
    location: '南苏丹', from: '2026-08-24T00:00:00Z', to: '2026-08-25T00:00:00Z',
  }, 100, PEPPER)
  assert.equal(overseas.publicOpinionVisibility.countryCode, 'SS')
  assert.equal(overseas.publicOpinionVisibility.location, '南苏丹')
})

test('public-opinion cursors round-trip their content-v5 PIT provenance without changing the query binding', () => {
  const query = normalizeStoredSearchQuery({
    platform: 'public_opinion', query: '处置', pageSize: 1,
  }, 100, PEPPER)
  const response = storedSearchResponse({
    query,
    result: {
      mode: 'elasticsearch',
      hasMore: true,
      nextCursor: {
        mode: 'elasticsearch',
        pitId: 'content-v5-pit',
        searchAfter: [1, '2026-08-24T00:00:00.000Z', '11111111-1111-4111-8111-111111111111', 7],
        analysisState: {
          v: 1,
          appliedProfile: DEFAULT_SEARCH_PROFILE,
          tokens: ['处置'],
          backendUsed: 'hanlp',
          degraded: false,
          errorCode: null,
          indexSchema: 'content-v5',
        },
      },
      items: [{
        id: '11111111-1111-4111-8111-111111111111',
        platform: 'public_opinion', datasetId: 'public-opinion.province.v1',
        objectType: 'opinion_item', body: '正文', metrics: {},
      }],
    },
    durationMs: 1,
    cursorSecret: PEPPER,
  })
  const continued = normalizeStoredSearchQuery({
    platform: 'public_opinion', query: '处置', pageSize: 1,
    cursor: response.data.pageInfo.nextCursor,
  }, 100, PEPPER)
  assert.equal(continued.cursorBinding, query.cursorBinding)
  assert.equal(continued.cursor.analysisState.indexSchema, 'content-v5')
})

test('content v5 maps publication state as typed fields and the public item allowlist hides it', () => {
  const publication = contentIndex().mappings.properties.publication.properties
  assert.equal(publication.stage.type, 'keyword')
  assert.equal(publication.status.type, 'keyword')
  assert.equal(publication.qualityScore.type, 'short')
  assert.equal(publication.displayAdmin1.type, 'keyword')
  assert.equal(publication.geographyVerified.type, 'boolean')
  assert.equal(publication.effectiveTime.type, 'date')
  assert.equal(publication.locationLabel.type, 'keyword')
  assert.equal(publication.locationType.type, 'keyword')
  assert.equal(publication.countryName.type, 'keyword')
  assert.equal(publication.countryCode.type, 'keyword')

  const item = publicStoredSearchItem({
    id: '11111111-1111-4111-8111-111111111111',
    platform: 'public_opinion', datasetId: 'public-opinion.province.v1',
    objectType: 'opinion_item', contentType: 'news', body: '正文', metrics: {},
    authorExternalId: 'hidden-author', authorName: 'hidden-name', authorHandle: 'hidden-handle',
    publication: {
      stage: 'candidate', status: 'qualified', qualityScore: 90,
      displayAdmin1: 'CN-JS', geographyVerified: true,
    },
  })
  assert.equal(Object.hasOwn(item, 'publication'), false)
  assert.equal(Object.hasOwn(item, 'quality'), false)
  assert.equal(Object.hasOwn(item, 'location'), false)
  assert.equal(Object.hasOwn(item, 'author'), false)
  assert.equal(Object.hasOwn(item, 'contentType'), false)

  const candidate = publicStoredSearchItem({
    id: item.id,
    platform: 'public_opinion', datasetId: 'public-opinion.province.v1',
    objectType: 'opinion_item', contentType: 'news', body: '正文', metrics: {},
    authorExternalId: 'hidden-author', authorName: 'hidden-name', authorHandle: 'hidden-handle',
    publication: {
      stage: 'candidate', status: 'qualified', qualityScore: 90,
      displayAdmin1: 'CN-JS', geographyVerified: true,
      locationLabel: '江苏', locationType: 'province', countryName: '中国', countryCode: 'CN',
      qualityFlags: ['must-not-leak'], providerId: 'must-not-leak',
    },
  }, { includeCandidateMetadata: true })
  assert.deepEqual(candidate.quality, {
    stage: 'candidate', status: 'qualified', score: 90, geographyVerified: true,
  })
  assert.deepEqual(candidate.location, {
    provinceCode: 'CN-JS', label: '江苏', type: 'province', country: '中国', countryCode: 'CN',
  })
  assert.equal(Object.hasOwn(candidate, 'author'), false)
  assert.equal(Object.hasOwn(candidate, 'contentType'), false)
  assert.equal(Object.hasOwn(candidate, 'sourceName'), false)
  assert.equal(JSON.stringify(candidate).includes('must-not-leak'), false)
})

test('Elasticsearch visibility keeps other platforms and applies formal, qualified and bounded-all gates', async () => {
  const { client, searches } = elasticsearchCapture()
  const queries = searchQueries({ client })
  const cases = [
    {
      candidateMode: 'formal', minQualityScore: null, provinceCode: null, from: null, to: null,
    },
    {
      candidateMode: 'qualified', minQualityScore: 80, provinceCode: 'CN-JS', from: null, to: null,
    },
    {
      candidateMode: 'all', minQualityScore: null, provinceCode: 'CN-JS',
      from: '2026-08-24T00:00:00.000Z', to: '2026-08-25T00:00:00.000Z',
    },
    {
      candidateMode: 'all', minQualityScore: null, provinceCode: null,
      countryCode: 'SS', location: '南苏丹',
      from: '2026-08-24T00:00:00.000Z', to: '2026-08-25T00:00:00.000Z',
    },
  ]
  for (const visibility of cases) {
    await queries.searchContent('处置', {
      platforms: ['public_opinion', 'telegram'],
      publicOpinionVisibility: visibility,
    })
  }

  for (const body of searches) {
    const gate = body.query.bool.filter.at(-1)
    assert.deepEqual(gate.bool.should[0], {
      bool: { must_not: [{ term: { platform: 'public_opinion' } }] },
    })
    const publicBranch = gate.bool.should[1].bool.filter
    assert.deepEqual(publicBranch[0], { term: { platform: 'public_opinion' } })
    assert.deepEqual(publicBranch[1].bool.should[0].bool.filter.slice(0, 2), [
      { term: { 'publication.stage': 'formal' } },
      { term: { 'publication.status': 'formal' } },
    ])
  }
  const qualifiedBranch = searches[1].query.bool.filter.at(-1).bool.should[1].bool.filter
  assert.deepEqual(qualifiedBranch[2], { term: { 'publication.displayAdmin1': 'CN-JS' } })
  assert.deepEqual(qualifiedBranch[1].bool.should[1].bool.filter, [
    { term: { 'publication.stage': 'candidate' } },
    { term: { 'publication.status': 'qualified' } },
    { range: { 'publication.qualityScore': { gte: 80 } } },
  ])
  const allBranch = searches[2].query.bool.filter.at(-1).bool.should[1].bool.filter
  assert.deepEqual(allBranch[1].bool.should[0].bool.filter.at(-1), {
    range: {
      eventTime: {
        gte: '2026-08-24T00:00:00.000Z',
        lte: '2026-08-25T00:00:00.000Z',
      },
    },
  })
  assert.deepEqual(allBranch[1].bool.should[1].bool.filter.at(-1), {
    range: {
      'publication.effectiveTime': {
        gte: '2026-08-24T00:00:00.000Z',
        lte: '2026-08-25T00:00:00.000Z',
      },
    },
  })
  const overseasBranch = searches[3].query.bool.filter.at(-1).bool.should[1].bool.filter
  assert.deepEqual(overseasBranch.slice(2), [
    { term: { 'publication.countryCode': 'SS' } },
    { term: { 'publication.locationLabel': '南苏丹' } },
  ])
})

test('PostgreSQL page and exact count share the revision-fenced visibility predicate while Admin stays unchanged', async () => {
  const calls = []
  const pool = {
    async query(sql, values) {
      calls.push({ sql, values })
      if (/SELECT count\(\*\)::bigint AS total_count/.test(sql)) {
        return { rows: [{ total_count: '0' }] }
      }
      return { rows: [] }
    },
  }
  const visibility = {
    candidateMode: 'qualified', minQualityScore: 85, provinceCode: 'CN-JS',
    from: null, to: null,
  }
  await searchQueries({ pool }).searchContent('处置', {
    platform: 'public_opinion', trackTotalHits: true, publicOpinionVisibility: visibility,
  })
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.match(call.sql, /LEFT JOIN core\.public_opinion_current_state publication/)
    assert.match(call.sql, /publication\.canonical_revision = core\.canonical_records\.current_revision/)
    assert.match(call.sql, /platform <> 'public_opinion'/)
    assert.match(call.sql, /publication\.source_stage = 'formal' AND publication\.status = 'formal'/)
    assert.match(call.sql, /publication\.status = 'qualified'/)
    assert.match(call.sql, /coalesce\(event_time, collected_at\)/)
    assert.match(call.sql, /publication\.country_code/)
    assert.match(call.sql, /publication\.location_label/)
    assert.deepEqual(JSON.parse(call.values.at(-1)), visibility)
  }

  let adminSql = null
  await searchQueries({
    pool: {
      async query(sql) {
        adminSql = sql
        return { rows: [] }
      },
    },
  }).searchContent('处置', { platform: 'public_opinion' })
  assert.doesNotMatch(adminSql, /public_opinion_current_state|publication\.source_stage/)
})

test('visibility falls back before v5 cutover and never replays an unmarked Elasticsearch PIT', async () => {
  const sqlCalls = []
  const pool = {
    async query(sql) {
      sqlCalls.push(sql)
      return { rows: [] }
    },
  }
  let elasticsearchCalls = 0
  const queries = searchQueries({
    pool,
    client: {
      async getAlias() {
        return { 'mx-insight-hub-content-v4-current': { aliases: { [READ_ALIAS]: {} } } }
      },
      async request() {
        elasticsearchCalls += 1
        throw new Error('Elasticsearch must not be queried before content-v5 is active')
      },
    },
  })
  const visibility = {
    candidateMode: 'formal', minQualityScore: null, provinceCode: null,
    countryCode: null, location: null, from: null, to: null,
  }
  const fallback = await queries.searchContent('处置', {
    platform: 'public_opinion', publicOpinionVisibility: visibility,
  })
  assert.equal(fallback.mode, 'postgres')
  assert.equal(elasticsearchCalls, 0)
  assert.equal(sqlCalls.length, 1)

  const readyQueries = searchQueries({
    pool,
    client: {
      async getAlias() {
        return { 'mx-insight-hub-content-v5-current': { aliases: { [READ_ALIAS]: {} } } }
      },
      async request() {
        elasticsearchCalls += 1
        throw new Error('An old PIT must be rejected before Elasticsearch search')
      },
    },
  })
  await assert.rejects(
    () => readyQueries.searchContent('处置', {
      platform: 'public_opinion',
      publicOpinionVisibility: visibility,
      cursor: {
        mode: 'elasticsearch', pitId: 'legacy-v4-pit', searchAfter: [1, null, 'id', 1],
        analysisState: {
          v: 1, appliedProfile: 'canonical.balanced.v1', tokens: ['处置'],
          backendUsed: 'hanlp', degraded: false, errorCode: null,
        },
      },
    }),
    (error) => error?.status === 503 && error?.code === 'search_cursor_unavailable',
  )
  assert.equal(elasticsearchCalls, 0)
})

test('Hub public-opinion fingerprints bind the publication contract while cursor defaults stay compatible', async () => {
  const store = new MemoryStore()
  const reservations = []
  const reserve = store.reserve.bind(store)
  store.reserve = async (input) => {
    reservations.push(input)
    return reserve(input)
  }
  const contentCalls = []
  const searchQueries = {
    async searchContent(query, options) {
      contentCalls.push({ query, options })
      return {
        mode: 'postgres', total: 0, totalRelation: 'eq', hasMore: false,
        nextCursor: null, items: [],
      }
    },
  }
  const service = new HubService({
    store,
    adapter: {},
    apiKeyPepper: PEPPER,
    searchQueries,
  })
  const tenant = await service.createTenant({ name: 'Visibility fingerprint tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Visibility fingerprint consumer' })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Visibility fingerprint key' })
  for (const platform of ['public_opinion', 'telegram']) {
    await service.putPlatformConfiguration(platform, {
      tenantId: tenant.id,
      consumerId: consumer.id,
      enabled: true,
      maxRequests: 20,
      windowSeconds: 3_600,
      maxPageSize: 20,
    })
  }
  const context = await service.authenticate(key.secret)

  await service.storedSearch(context, {
    body: { platform: 'public_opinion', query: '处置', pageSize: 1 },
    idempotencyKey: 'visibility-stored-default',
    path: '/api/v1/data/stored/search',
  })
  assert.equal(reservations[0].fingerprint, requestFingerprint({
    method: 'POST',
    path: '/api/v1/data/stored/search',
    body: {
      query: '处置', platform: 'public_opinion', datasetId: null, objectType: null,
      pageSize: 1, cursor: null, type: 'fresh',
      publicOpinionVisibility: {
        contractVersion: 'public-opinion.publication-visibility.v1', mode: 'formal',
      },
    },
  }))
  assert.notEqual(reservations[0].fingerprint, requestFingerprint({
    method: 'POST',
    path: '/api/v1/data/stored/search',
    body: {
      query: '处置', platform: 'public_opinion', datasetId: null, objectType: null,
      pageSize: 1, cursor: null, type: 'fresh',
    },
  }))

  await service.canonicalSearch(context, {
    body: { query: '处置', pageSize: 1 },
    idempotencyKey: 'visibility-canonical-default',
    path: '/api/v1/data/canonical/search',
  })
  assert.equal(reservations[1].fingerprint, requestFingerprint({
    method: 'POST',
    path: '/api/v1/data/canonical/search',
    body: {
      query: '处置', platform: null, platforms: ['public_opinion', 'telegram'],
      datasetId: null, objectType: null, pageSize: 1,
      searchProfile: DEFAULT_SEARCH_PROFILE, cursor: null, sort: 'newest', type: 'fresh',
      publicOpinionVisibility: {
        contractVersion: 'public-opinion.publication-visibility.v1', mode: 'formal',
      },
    },
  }))
  assert.equal(contentCalls[0].options.publicOpinionVisibility.candidateMode, 'formal')
  assert.equal(contentCalls[1].options.publicOpinionVisibility.candidateMode, 'formal')

  await service.canonicalSearch(context, {
    body: {
      platform: 'public_opinion', query: '处置', pageSize: 1,
      includeCandidates: 'all', countryCode: 'ss', location: '南苏丹',
      from: '2026-08-24T00:00:00Z', to: '2026-08-25T00:00:00Z',
    },
    idempotencyKey: 'visibility-canonical-explicit',
    path: '/api/v1/data/canonical/search',
  })
  assert.equal(reservations[2].fingerprint, requestFingerprint({
    method: 'POST',
    path: '/api/v1/data/canonical/search',
    body: {
      query: '处置', platform: 'public_opinion', platforms: ['public_opinion'],
      datasetId: null, objectType: null, pageSize: 1,
      searchProfile: DEFAULT_SEARCH_PROFILE, cursor: null, sort: 'newest', type: 'fresh',
      publicOpinionVisibility: {
        contractVersion: 'public-opinion.publication-visibility.v1', mode: 'all',
      },
      includeCandidates: 'all', minQualityScore: null, province: null,
      countryCode: 'SS', location: '南苏丹',
      from: '2026-08-24T00:00:00.000Z', to: '2026-08-25T00:00:00.000Z',
    },
  }))
})
