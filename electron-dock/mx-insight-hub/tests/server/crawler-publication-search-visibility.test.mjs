import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import test from 'node:test'
import { ElasticsearchUnavailableError } from '@qpjoy/mx-common/elasticsearch'
import { requestFingerprint } from '../../server/core/crypto.mjs'
import {
  CRAWLER_PUBLICATION_VISIBILITY_CONTRACT,
  canonicalSearchResponse,
  normalizeCanonicalSearchQuery,
  normalizeStoredSearchQuery,
  publicStoredSearchItem,
  storedSearchResponse,
} from '../../server/data/stored-search.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { buildContentDocument } from '../../server/search/document.mjs'
import { contentIndex } from '../../server/search/index-definitions.mjs'
import { DEFAULT_SEARCH_PROFILE } from '../../server/search/profiles.mjs'
import { SearchQueries } from '../../server/search/queries.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const PEPPER = 'crawler-publication-visibility-test-pepper'
const READ_ALIAS = 'mx-insight-hub-content'
const CRAWLER_PLATFORM = 'data_center_saved_records_news'
const CRAWLER_VISIBILITY = Object.freeze({
  contractVersion: CRAWLER_PUBLICATION_VISIBILITY_CONTRACT,
  eligibility: 'candidate',
})

function searchQueries({ client = null, pool = { async query() { return { rows: [] } } } } = {}) {
  return new SearchQueries({
    pool,
    client,
    segmenter: { async segment(value) { return [value] } },
    indexSet: { readAlias: READ_ALIAS },
    logger: { warn() {} },
  })
}

function searchResult() {
  return {
    mode: 'postgres', total: 0, totalRelation: 'eq', hasMore: false,
    nextCursor: null, items: [],
  }
}

function signLegacyCursor(payload) {
  const signature = createHmac('sha256', PEPPER)
    .update(JSON.stringify(payload))
    .digest('base64url')
  return Buffer.from(JSON.stringify({ ...payload, s: signature }), 'utf8').toString('base64url')
}

test('crawler visibility is added only to crawler scopes and is stable across signed cursors', () => {
  const storedTelegram = normalizeStoredSearchQuery({
    platform: 'telegram', query: '数据', pageSize: 1,
  }, 20, PEPPER)
  const preCrawlerStoredBinding = createHash('sha256').update(JSON.stringify({
    v: 2,
    sort: 'score-eventTime-id-sharddoc-or-eventTime-id-v2',
    query: '数据',
    platform: 'telegram',
    datasetId: null,
    objectType: null,
    pageSize: 1,
  })).digest('base64url')
  assert.equal(storedTelegram.crawlerPublicationVisibility, null)
  assert.equal(storedTelegram.cursorBinding, preCrawlerStoredBinding)
  assert.equal(normalizeStoredSearchQuery({
    platform: 'data_center_catalog', query: '数据', pageSize: 1,
  }, 20, PEPPER).crawlerPublicationVisibility, null)

  const storedCrawler = normalizeStoredSearchQuery({
    platform: CRAWLER_PLATFORM, query: '数据', pageSize: 1,
  }, 20, PEPPER)
  assert.deepEqual(storedCrawler.crawlerPublicationVisibility, CRAWLER_VISIBILITY)
  const preVisibilityStoredCursor = signLegacyCursor({
    v: 2,
    m: 'postgres',
    p: null,
    a: ['2026-09-10T00:00:00.000Z', '11111111-1111-4111-8111-111111111111'],
    n: 1,
    q: preCrawlerStoredBinding,
    r: null,
  })
  assert.throws(
    () => normalizeStoredSearchQuery({
      platform: CRAWLER_PLATFORM,
      query: '数据',
      pageSize: 1,
      cursor: preVisibilityStoredCursor,
    }, 20, PEPPER),
    (error) => error?.status === 400 && error?.code === 'invalid_cursor',
  )
  const storedFirstPage = storedSearchResponse({
    query: storedCrawler,
    result: {
      mode: 'postgres', hasMore: true,
      nextCursor: {
        mode: 'postgres', pitId: null,
        searchAfter: ['2026-09-10T00:00:00.000Z', '11111111-1111-4111-8111-111111111111'],
      },
      items: [{
        id: '11111111-1111-4111-8111-111111111111',
        platform: CRAWLER_PLATFORM,
        datasetId: 'data-center.saved-records.news.v1',
        objectType: 'saved_record',
        metrics: {},
      }],
    },
    durationMs: 1,
    cursorSecret: PEPPER,
  })
  const storedContinued = normalizeStoredSearchQuery({
    platform: CRAWLER_PLATFORM,
    query: '数据',
    pageSize: 1,
    cursor: storedFirstPage.data.pageInfo.nextCursor,
  }, 20, PEPPER)
  assert.equal(storedContinued.cursorBinding, storedCrawler.cursorBinding)
  assert.throws(
    () => normalizeStoredSearchQuery({
      platform: 'telegram',
      query: '数据',
      pageSize: 1,
      cursor: storedFirstPage.data.pageInfo.nextCursor,
    }, 20, PEPPER),
    (error) => error?.status === 400 && error?.code === 'invalid_cursor',
  )

  const telegram = normalizeCanonicalSearchQuery({
    platform: 'telegram', query: '数据', pageSize: 1,
  }, { platforms: ['telegram'], cursorSecret: PEPPER })
  const preCrawlerBinding = createHash('sha256').update(JSON.stringify({
    v: 2,
    sort: 'score-eventTime-id-sharddoc-or-eventTime-id-v2',
    query: '数据',
    platform: 'telegram',
    platforms: ['telegram'],
    datasetId: null,
    objectType: null,
    pageSize: 1,
    searchProfile: DEFAULT_SEARCH_PROFILE,
    requestedSort: 'newest',
  })).digest('base64url')
  assert.equal(telegram.crawlerPublicationVisibility, null)
  assert.equal(telegram.cursorBinding, preCrawlerBinding)

  const mixed = normalizeCanonicalSearchQuery({ query: '数据', pageSize: 1 }, {
    platforms: [CRAWLER_PLATFORM, 'telegram'], cursorSecret: PEPPER,
  })
  assert.deepEqual(mixed.crawlerPublicationVisibility, CRAWLER_VISIBILITY)
  assert.notEqual(mixed.cursorBinding, telegram.cursorBinding)
  const preVisibilityCanonicalBinding = createHash('sha256').update(JSON.stringify({
    v: 2,
    sort: 'score-eventTime-id-sharddoc-or-eventTime-id-v2',
    query: '数据',
    platform: null,
    platforms: [CRAWLER_PLATFORM, 'telegram'],
    datasetId: null,
    objectType: null,
    pageSize: 1,
    searchProfile: DEFAULT_SEARCH_PROFILE,
    requestedSort: 'newest',
  })).digest('base64url')
  const preVisibilityCanonicalCursor = signLegacyCursor({
    v: 2,
    m: 'elasticsearch',
    p: 'content-v5-crawler-pit',
    a: [3, '2026-09-10T00:00:00.000Z', '11111111-1111-4111-8111-111111111111', 7],
    n: 1,
    q: preVisibilityCanonicalBinding,
    r: {
      v: 1,
      appliedProfile: DEFAULT_SEARCH_PROFILE,
      tokens: ['数据'],
      backendUsed: 'hanlp',
      degraded: false,
      errorCode: null,
      indexSchema: 'content-v5',
    },
  })
  assert.throws(
    () => normalizeCanonicalSearchQuery({
      query: '数据', pageSize: 1, cursor: preVisibilityCanonicalCursor,
    }, { platforms: [CRAWLER_PLATFORM, 'telegram'], cursorSecret: PEPPER }),
    (error) => error?.status === 400 && error?.code === 'invalid_cursor',
  )

  const firstPage = canonicalSearchResponse({
    query: mixed,
    result: {
      mode: 'elasticsearch', total: 2, totalRelation: 'eq', hasMore: true,
      nextCursor: {
        mode: 'elasticsearch',
        pitId: 'content-v6-crawler-pit',
        searchAfter: [3, '2026-09-10T00:00:00.000Z', '11111111-1111-4111-8111-111111111111', 7],
        analysisState: {
          v: 1,
          appliedProfile: DEFAULT_SEARCH_PROFILE,
          tokens: ['数据'],
          backendUsed: 'hanlp',
          degraded: false,
          errorCode: null,
          indexSchema: 'content-v6',
        },
      },
      items: [{
        id: '11111111-1111-4111-8111-111111111111',
        platform: CRAWLER_PLATFORM,
        datasetId: 'data-center.saved-records.news.v1',
        objectType: 'saved_record',
        body: '数据正文',
        metrics: {},
      }],
    },
    durationMs: 1,
    cursorSecret: PEPPER,
  })
  const continued = normalizeCanonicalSearchQuery({
    query: '数据', pageSize: 1, cursor: firstPage.data.pageInfo.nextCursor,
  }, { platforms: [CRAWLER_PLATFORM, 'telegram'], cursorSecret: PEPPER })
  assert.equal(continued.cursorBinding, mixed.cursorBinding)
  assert.equal(continued.cursor.analysisState.indexSchema, 'content-v6')
  assert.throws(
    () => normalizeCanonicalSearchQuery({
      query: '数据', pageSize: 1, cursor: firstPage.data.pageInfo.nextCursor,
    }, { platforms: ['telegram'], cursorSecret: PEPPER }),
    (error) => error?.status === 400 && error?.code === 'invalid_cursor',
  )
})

test('content v6 projects the typed crawler eligibility but the public item allowlist hides it', async () => {
  const definition = contentIndex()
  assert.equal(definition.schemaVersion, 6)
  assert.equal(definition.mappings.properties.crawlerPublicationEligibility.type, 'keyword')

  const baseRow = {
    id: '11111111-1111-4111-8111-111111111111',
    dataset_id: 'data-center.saved-records.news.v1',
    current_revision: 1,
    schema_version: 'v1',
    projection_revision: 1,
    platform: CRAWLER_PLATFORM,
    object_type: 'saved_record',
    content_type: 'news.article',
    external_id: 'record-key',
    title: '标题',
    body: '正文',
    stable_fields: { crawler: { publication: { eligibility: 'candidate' } } },
  }
  const document = await buildContentDocument(baseRow, {
    segmenter: { async segment() { return [] } },
  })
  assert.equal(document.crawlerPublicationEligibility, 'candidate')
  const internal = await buildContentDocument({
    ...baseRow,
    stable_fields: { crawler: { publication: { eligibility: 'internal' } } },
  }, { segmenter: { async segment() { return [] } } })
  assert.equal(internal.crawlerPublicationEligibility, 'internal')

  for (const malformed of [' candidate ', ['candidate'], { value: 'candidate' }]) {
    const rejected = await buildContentDocument({
      ...baseRow,
      stable_fields: { crawler: { publication: { eligibility: malformed } } },
    }, { segmenter: { async segment() { return [] } } })
    assert.equal(Object.hasOwn(rejected, 'crawlerPublicationEligibility'), false)
  }

  const publicItem = publicStoredSearchItem({
    ...document,
    datasetId: document.datasetId,
    objectType: document.objectType,
    body: document.body,
  })
  assert.equal(Object.hasOwn(publicItem, 'crawlerPublicationEligibility'), false)
  assert.equal(JSON.stringify(publicItem).includes('candidate'), false)
})

test('Elasticsearch mixed-platform search preserves non-crawler rows and requires candidate crawler rows', async () => {
  const searches = []
  const client = {
    async getAlias() {
      return { 'mx-insight-hub-content-v6-current': { aliases: { [READ_ALIAS]: {} } } }
    },
    async request(method, path, body) {
      if (path.includes('/_pit?')) return { id: 'crawler-visibility-pit' }
      if (path === '/_search') {
        searches.push(body)
        return { hits: { total: { value: 0, relation: 'eq' }, hits: [] } }
      }
      if (method === 'DELETE' && path === '/_pit') return { succeeded: true }
      throw new Error(`unexpected ${method} ${path}`)
    },
  }
  const queries = searchQueries({ client })
  await queries.searchContent('数据', {
    platforms: [CRAWLER_PLATFORM, 'telegram'],
    crawlerPublicationVisibility: CRAWLER_VISIBILITY,
  })
  const filters = searches[0].query.bool.filter
  assert.deepEqual(filters[0], { terms: { platform: [CRAWLER_PLATFORM, 'telegram'] } })
  assert.deepEqual(filters[1], {
    bool: {
      should: [
        {
          bool: {
            must_not: [{ prefix: { platform: 'data_center_saved_records_' } }],
          },
        },
        {
          bool: {
            filter: [
              { prefix: { platform: 'data_center_saved_records_' } },
              { term: { crawlerPublicationEligibility: 'candidate' } },
            ],
          },
        },
      ],
      minimum_should_match: 1,
    },
  })

  await queries.searchContent('数据', { platforms: [CRAWLER_PLATFORM, 'telegram'] })
  assert.deepEqual(searches[1].query.bool.filter, [
    { terms: { platform: [CRAWLER_PLATFORM, 'telegram'] } },
  ], 'Admin/internal search remains unfiltered unless the public contract is explicitly supplied')
})

test('PostgreSQL page and exact-count paths use the same mixed-platform crawler predicate', async () => {
  const calls = []
  const pool = {
    async query(sql, values) {
      calls.push({ sql, values })
      if (/SELECT count\(\*\)::bigint AS total_count/u.test(sql)) {
        return { rows: [{ total_count: '0' }] }
      }
      return { rows: [] }
    },
  }
  await searchQueries({ pool }).searchContent('数据', {
    platforms: [CRAWLER_PLATFORM, 'telegram'],
    crawlerPublicationVisibility: CRAWLER_VISIBILITY,
    trackTotalHits: true,
  })
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.match(call.sql, /platform !~ '\^data_center_saved_records_'/u)
    assert.match(
      call.sql,
      /stable_fields #>> '\{crawler,publication,eligibility\}' = 'candidate'/u,
    )
  }

  let adminSql = null
  await searchQueries({
    pool: {
      async query(sql) {
        adminSql = sql
        return { rows: [] }
      },
    },
  }).searchContent('数据', { platforms: [CRAWLER_PLATFORM, 'telegram'] })
  assert.doesNotMatch(adminSql, /crawler,publication,eligibility/u)
})

test('crawler public search fails closed to PostgreSQL on old ES schema and on ES transport failure', async () => {
  const sqlCalls = []
  const pool = {
    async query(sql) {
      sqlCalls.push(sql)
      return { rows: [] }
    },
  }
  let elasticsearchCalls = 0
  const oldSchema = searchQueries({
    pool,
    client: {
      async getAlias() {
        return { 'mx-insight-hub-content-v5-current': { aliases: { [READ_ALIAS]: {} } } }
      },
      async request() {
        elasticsearchCalls += 1
        throw new Error('old ES schema must not serve crawler public search')
      },
    },
  })
  const fallback = await oldSchema.searchContent('数据', {
    platforms: [CRAWLER_PLATFORM, 'telegram'],
    crawlerPublicationVisibility: CRAWLER_VISIBILITY,
  })
  assert.equal(fallback.mode, 'postgres')
  assert.equal(elasticsearchCalls, 0)
  assert.match(sqlCalls[0], /crawler,publication,eligibility/u)

  await assert.rejects(
    () => oldSchema.searchContent('数据', {
      platforms: [CRAWLER_PLATFORM, 'telegram'],
      crawlerPublicationVisibility: CRAWLER_VISIBILITY,
      cursor: {
        mode: 'elasticsearch',
        pitId: 'content-v6-crawler-pit',
        searchAfter: [1, null, '11111111-1111-4111-8111-111111111111', 7],
        analysisState: {
          v: 1,
          appliedProfile: DEFAULT_SEARCH_PROFILE,
          tokens: ['数据'],
          backendUsed: 'hanlp',
          degraded: false,
          errorCode: null,
          indexSchema: 'content-v6',
        },
      },
    }),
    (error) => error?.status === 503 && error?.code === 'search_cursor_unavailable',
  )
  assert.equal(elasticsearchCalls, 0)

  const unavailable = searchQueries({
    pool,
    client: {
      async getAlias() {
        return { 'mx-insight-hub-content-v6-current': { aliases: { [READ_ALIAS]: {} } } }
      },
      async request() {
        throw new ElasticsearchUnavailableError(new Error('offline'))
      },
    },
  })
  const transportFallback = await unavailable.searchContent('数据', {
    platforms: [CRAWLER_PLATFORM, 'telegram'],
    crawlerPublicationVisibility: CRAWLER_VISIBILITY,
  })
  assert.equal(transportFallback.mode, 'postgres')
  assert.match(sqlCalls.at(-1), /crawler,publication,eligibility/u)
})

test('Hub public stored and canonical search bind crawler visibility while legacy search fails closed', async () => {
  const store = new MemoryStore()
  const reservations = []
  const reserve = store.reserve.bind(store)
  store.reserve = async (input) => {
    reservations.push(input)
    return reserve(input)
  }
  const contentCalls = []
  const service = new HubService({
    store,
    adapter: {},
    apiKeyPepper: PEPPER,
    searchQueries: {
      async searchContent(query, options) {
        contentCalls.push({ query, options })
        return searchResult()
      },
    },
  })
  const tenant = await service.createTenant({ name: 'Crawler visibility tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Crawler visibility consumer' })
  for (const platform of [CRAWLER_PLATFORM, 'telegram']) {
    await service.putPlatformConfiguration(platform, {
      tenantId: tenant.id,
      consumerId: consumer.id,
      enabled: true,
      maxRequests: 20,
      windowSeconds: 3_600,
      maxPageSize: 20,
    })
  }
  const key = await service.createApiKey({
    consumerId: consumer.id,
    name: 'Crawler visibility key',
    platforms: [CRAWLER_PLATFORM, 'telegram'],
  })
  const context = await service.authenticate(key.secret)

  const capabilities = await service.capabilities(context)
  const crawlerCapability = capabilities.data.platforms.find(
    (entry) => entry.platform === CRAWLER_PLATFORM,
  )
  assert.deepEqual(crawlerCapability, {
    platform: CRAWLER_PLATFORM,
    ready: false,
    source: 'hub',
    servingMode: 'stored',
    capabilities: ['stored_search', 'canonical_search'],
  })
  assert.equal(JSON.stringify(capabilities.data.legacySearch).includes(CRAWLER_PLATFORM), false)

  await service.canonicalSearch(context, {
    body: { query: '数据', pageSize: 1 },
    idempotencyKey: 'crawler-visibility-mixed',
    path: '/api/v1/data/canonical/search',
  })
  assert.deepEqual(contentCalls[0].options.crawlerPublicationVisibility, CRAWLER_VISIBILITY)
  assert.equal(reservations[0].fingerprint, requestFingerprint({
    method: 'POST',
    path: '/api/v1/data/canonical/search',
    body: {
      query: '数据',
      platform: null,
      platforms: [CRAWLER_PLATFORM, 'telegram'],
      datasetId: null,
      objectType: null,
      pageSize: 1,
      searchProfile: DEFAULT_SEARCH_PROFILE,
      cursor: null,
      sort: 'newest',
      type: 'fresh',
      crawlerPublicationVisibility: CRAWLER_VISIBILITY,
    },
  }))

  await service.canonicalSearch(context, {
    body: { platform: 'telegram', query: '数据', pageSize: 1 },
    idempotencyKey: 'crawler-visibility-telegram',
    path: '/api/v1/data/canonical/search',
  })
  assert.equal(Object.hasOwn(contentCalls[1].options, 'crawlerPublicationVisibility'), false)
  assert.equal(reservations[1].fingerprint, requestFingerprint({
    method: 'POST',
    path: '/api/v1/data/canonical/search',
    body: {
      query: '数据',
      platform: 'telegram',
      platforms: ['telegram'],
      datasetId: null,
      objectType: null,
      pageSize: 1,
      searchProfile: DEFAULT_SEARCH_PROFILE,
      cursor: null,
      sort: 'newest',
      type: 'fresh',
    },
  }))

  await service.storedSearch(context, {
    body: { platform: CRAWLER_PLATFORM, query: '数据', pageSize: 1 },
    idempotencyKey: 'crawler-visibility-stored',
    path: '/api/v1/data/stored/search',
  })
  assert.deepEqual(contentCalls[2].options.crawlerPublicationVisibility, CRAWLER_VISIBILITY)
  assert.equal(reservations[2].fingerprint, requestFingerprint({
    method: 'POST',
    path: '/api/v1/data/stored/search',
    body: {
      query: '数据',
      platform: CRAWLER_PLATFORM,
      datasetId: null,
      objectType: null,
      pageSize: 1,
      cursor: null,
      type: 'fresh',
      crawlerPublicationVisibility: CRAWLER_VISIBILITY,
    },
  }))

  await service.storedSearch(context, {
    body: { platform: 'telegram', query: '数据', pageSize: 1 },
    idempotencyKey: 'crawler-visibility-stored-telegram',
    path: '/api/v1/data/stored/search',
  })
  assert.equal(Object.hasOwn(contentCalls[3].options, 'crawlerPublicationVisibility'), false)
  assert.equal(reservations[3].fingerprint, requestFingerprint({
    method: 'POST',
    path: '/api/v1/data/stored/search',
    body: {
      query: '数据',
      platform: 'telegram',
      datasetId: null,
      objectType: null,
      pageSize: 1,
      cursor: null,
      type: 'fresh',
    },
  }))

  await assert.rejects(
    () => service.search(context, {
      body: { platform: CRAWLER_PLATFORM, query: '数据', pageSize: 1 },
      idempotencyKey: 'crawler-visibility-legacy',
      path: '/api/v1/data/search',
    }),
    (error) => error?.status === 400 && error?.code === 'platform_operation_unsupported',
  )
  assert.equal(contentCalls.length, 4)
  assert.equal(reservations.length, 4)
})
