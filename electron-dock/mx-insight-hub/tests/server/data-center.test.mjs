import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createApp } from '../../server/app.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { DEFAULT_SEARCH_PROFILE, publicSearchProfile, resolveSearchProfile } from '../../server/search/profiles.mjs'

const ADMIN_TOKEN = 'data-center-admin-token'
const quiet = { error() {} }

async function withApp({ store, listenerMode = 'combined', identity = null }, operation) {
  const app = createApp({
    service: {},
    store,
    adapter: {},
    adminToken: ADMIN_TOKEN,
    listenerMode,
    identity,
    logger: quiet,
  })
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    await operation(baseUrl)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('Data Center route is admin-token-only, validates filters, and stays off the public listener', async () => {
  const calls = []
  const store = {
    async dataCenter(filters) {
      calls.push(filters)
      return {
        stats: { datasetCount: 0, activeRecordCount: 0, revisionCount: 0, deletedRecordCount: 0 },
        datasets: [],
        records: [],
        pageSize: filters.pageSize,
      }
    },
  }

  await withApp({ store }, async (baseUrl) => {
    const unauthorized = await fetch(`${baseUrl}/internal/v1/admin/data-center`)
    assert.equal(unauthorized.status, 401)

    const launcherOnly = await fetch(`${baseUrl}/internal/v1/admin/data-center`, {
      headers: { authorization: 'Bearer launcher-session' },
    })
    assert.equal(launcherOnly.status, 401)

    const response = await fetch(
      `${baseUrl}/internal/v1/admin/data-center?datasetId=%20telegram.messages.v1%20&platform=telegram&objectType=message&pageSize=25`,
      { headers: { 'x-mx-insight-admin-token': ADMIN_TOKEN } },
    )
    assert.equal(response.status, 200)
    const responseData = (await response.json()).data
    assert.deepEqual({ ...responseData, searchCapabilities: undefined }, {
      stats: { datasetCount: 0, activeRecordCount: 0, revisionCount: 0, deletedRecordCount: 0 },
      datasets: [],
      records: [],
      pageSize: 25,
      searchCapabilities: undefined,
    })
    assert.equal(responseData.searchCapabilities.indexSchema, 'content-v5')
    assert.equal(responseData.searchCapabilities.activeIndexSchema, null)
    assert.equal(responseData.searchCapabilities.ready, false)
    assert.equal(responseData.searchCapabilities.defaultProfile, DEFAULT_SEARCH_PROFILE)
    assert.ok(responseData.searchCapabilities.profiles.some((profile) => profile.id === 'canonical.legacy-or.v1'))
    assert.equal(
      responseData.searchCapabilities.profiles.find((profile) => profile.id === 'canonical.zh-recall.v1').ready,
      false,
    )
    assert.deepEqual(calls, [{
      datasetId: 'telegram.messages.v1',
      platform: 'telegram',
      objectType: 'message',
      pageSize: 25,
    }])

    const defaults = await fetch(`${baseUrl}/internal/v1/admin/data-center`, {
      headers: { 'x-mx-insight-admin-token': ADMIN_TOKEN },
    })
    assert.equal(defaults.status, 200)
    assert.equal((await defaults.json()).data.pageSize, 50)
    assert.deepEqual(calls[1], { datasetId: null, platform: null, objectType: null, pageSize: 50 })

    for (const pageSize of ['0', '101', '1.5', 'not-a-number']) {
      const invalid = await fetch(`${baseUrl}/internal/v1/admin/data-center?pageSize=${pageSize}`, {
        headers: { 'x-mx-insight-admin-token': ADMIN_TOKEN },
      })
      assert.equal(invalid.status, 400)
      assert.equal((await invalid.json()).error.code, 'invalid_page_size')
    }
    assert.equal(calls.length, 2)
  })

  const identity = {
    enabled: true,
    async resolve() {
      return { kind: 'launcher-user', platformAdmin: true, capabilities: [], memberships: [] }
    },
  }
  await withApp({ store, identity }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/internal/v1/admin/data-center`, {
      headers: { authorization: 'Bearer launcher-session' },
    })
    assert.equal(response.status, 403)
    assert.equal((await response.json()).error.code, 'admin_token_required')
  })

  await withApp({ store, listenerMode: 'public' }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/internal/v1/admin/data-center`, {
      headers: { 'x-mx-insight-admin-token': ADMIN_TOKEN },
    })
    assert.equal(response.status, 404)
  })
})

test('MemoryStore exposes an empty authoritative catalog', async () => {
  const store = new MemoryStore()
  assert.deepEqual(await store.dataCenter({ pageSize: 17 }), {
    stats: { datasetCount: 0, activeRecordCount: 0, revisionCount: 0, deletedRecordCount: 0 },
    datasets: [],
    records: [],
    pageSize: 17,
  })
  const source = await store.createExternalSource({
    sourceKey: 'local-upload',
    displayName: 'Local upload',
    sourceKind: 'file',
    datasetId: 'external.local-upload.v1',
    platform: 'external',
    objectType: 'record',
    connection: { fileMode: 'upload' },
  })
  assert.deepEqual(await store.getExternalSource('local-upload'), source)
  assert.deepEqual(await store.listExternalSources(), [source])
  assert.deepEqual(await store.dataCenterRecords(), {
    items: [], total: 0, hasMore: false, nextCursor: null,
  })
})

test('Data Center record browser pages PostgreSQL and searches the ES projection', async () => {
  const browseCalls = []
  const searchCalls = []
  const store = {
    async dataCenterRecords(filters) {
      browseCalls.push(filters)
      const lastPage = filters.page === 3
      return {
        items: [{ id: 'record-1', datasetId: 'external.canyie.v1', body: '本地正文' }],
        total: 63,
        hasMore: !lastPage,
        nextCursor: lastPage
          ? null
          : { sortTime: '2026-08-12T01:02:03.000Z', id: '11111111-1111-4111-8111-111111111111' },
      }
    },
    async dataCenterRecordsByIds(ids) {
      assert.deepEqual(ids, ['record-2'])
      return [{
        id: 'record-2', body: '完整、未脱敏正文',
        stableFields: { source: { sourceKey: 'private-source' } },
        extensions: { private_note: 'admin-visible' },
      }]
    },
  }
  const search = {
    queries: {
      async searchContent(query, options) {
        searchCalls.push({ query, options })
        const profile = resolveSearchProfile(options.searchProfile, { audience: 'admin' })
        const matchedBranch = profile.queryPlan[0].branch
        return {
          mode: 'elasticsearch',
          items: [{
            id: 'record-2', body: '命中的正文',
            highlight: { body: ['<em>命中</em>的正文'] },
            matchEvidence: [matchedBranch],
          }],
          total: 31,
          hasMore: options.offset !== 30,
          nextCursor: options.offset == null
            ? { mode: 'elasticsearch', pitId: 'pit-1', searchAfter: [1, 'record-2'] }
            : null,
          searchExecution: {
            requestedProfile: profile.id,
            appliedProfile: profile.id,
            profile: publicSearchProfile(profile),
            queryAnalysis: {
              tokens: ['命中'], tokenCount: 1, truncated: false,
              backendUsed: 'hanlp', degraded: false, errorCode: null,
            },
            matchedBranches: [matchedBranch],
            warning: profile.warning,
          },
        }
      },
    },
  }
  const app = createApp({
    service: {}, store, adapter: {}, search,
    adminToken: ADMIN_TOKEN, listenerMode: 'combined', logger: quiet,
  })
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const headers = { 'x-mx-insight-admin-token': ADMIN_TOKEN }
  try {
    const first = await fetch(
      `${baseUrl}/internal/v1/admin/data-center/records?datasetId=external.canyie.v1&pageSize=25`,
      { headers },
    )
    assert.equal(first.status, 200)
    const firstBody = (await first.json()).data
    assert.equal(firstBody.mode, 'postgres')
    assert.deepEqual(firstBody.pageInfo, {
      page: 1,
      pageSize: 25,
      total: 63,
      totalPages: 3,
      hasMore: true,
      nextCursor: firstBody.pageInfo.nextCursor,
    })
    assert.equal(typeof firstBody.pageInfo.nextCursor, 'string')
    assert.deepEqual(browseCalls[0], {
      datasetId: 'external.canyie.v1', platform: null, objectType: null,
      sort: 'newest', pageSize: 25, cursor: null, page: null,
    })

    const second = await fetch(
      `${baseUrl}/internal/v1/admin/data-center/records?datasetId=external.canyie.v1&pageSize=25&cursor=${encodeURIComponent(firstBody.pageInfo.nextCursor)}`,
      { headers },
    )
    assert.equal(second.status, 200)
    assert.equal((await second.clone().json()).data.pageInfo.page, 2)
    assert.deepEqual(browseCalls[1].cursor, {
      sortTime: '2026-08-12T01:02:03.000Z', id: '11111111-1111-4111-8111-111111111111',
    })

    const jumped = await fetch(
      `${baseUrl}/internal/v1/admin/data-center/records?datasetId=external.canyie.v1&pageSize=25&page=3`,
      { headers },
    )
    assert.equal(jumped.status, 200)
    assert.deepEqual((await jumped.json()).data.pageInfo, {
      page: 3, pageSize: 25, total: 63, totalPages: 3, hasMore: false, nextCursor: null,
    })
    assert.deepEqual(browseCalls[2], {
      datasetId: 'external.canyie.v1', platform: null, objectType: null,
      sort: 'newest', pageSize: 25, cursor: null, page: 3,
    })

    const related = await fetch(
      `${baseUrl}/internal/v1/admin/data-center/records?datasetId=public-opinion.province.v1&q=%E9%83%A8%E7%BD%B2&relatedProvince=%E5%8F%B0%E6%B9%BE&provinceRelation=any&sort=newest&pageSize=10`,
      { headers },
    )
    assert.equal(related.status, 200)
    const relatedBody = (await related.json()).data
    assert.equal(relatedBody.mode, 'postgres-related')
    assert.deepEqual(relatedBody.provinceFilter, {
      province: { code: 'CN-TW', name: '台湾' },
      relation: 'any',
      relationStatusScope: 'accepted-or-proposed',
      includesRecallHints: true,
      qualityGateApplied: false,
      keywordMode: 'postgres-substring',
    })
    assert.deepEqual(browseCalls[3], {
      datasetId: 'public-opinion.province.v1', platform: null, objectType: null,
      query: '部署', relatedAdmin1Code: 'CN-TW', relatedProvinceNames: ['台湾', '台湾省'],
      provinceRelation: 'any', sort: 'newest',
      pageSize: 10, cursor: null, page: null,
    })
    assert.equal(searchCalls.length, 0)

    const mentioned = await fetch(
      `${baseUrl}/internal/v1/admin/data-center/records?relatedProvince=CN-TW&provinceRelation=related`,
      { headers },
    )
    assert.equal(mentioned.status, 200)
    assert.equal((await mentioned.json()).data.provinceFilter.relation, 'related')
    assert.equal(browseCalls[4].provinceRelation, 'related')

    const oldest = await fetch(
      `${baseUrl}/internal/v1/admin/data-center/records?sort=oldest&pageSize=10`,
      { headers },
    )
    assert.equal(oldest.status, 200)
    assert.equal(browseCalls[5].sort, 'oldest')

    for (const [queryString, code] of [
      ['relatedProvince=火星', 'invalid_related_province'],
      ['provinceRelation=event', 'invalid_request'],
      ['relatedProvince=CN-JS&provinceRelation=nearby', 'invalid_province_relation'],
      ['relatedProvince=CN-JS&sort=relevance', 'invalid_sort'],
      ['relatedProvince=CN-JS&q=江苏&searchProfile=canonical.phrase.v1', 'invalid_request'],
    ]) {
      const invalid = await fetch(
        `${baseUrl}/internal/v1/admin/data-center/records?${queryString}`,
        { headers },
      )
      assert.equal(invalid.status, 400)
      assert.equal((await invalid.json()).error.code, code)
    }

    const searched = await fetch(
      `${baseUrl}/internal/v1/admin/data-center/records?q=%E5%91%BD%E4%B8%AD&platform=twitter&pageSize=10`,
      { headers },
    )
    assert.equal(searched.status, 200)
    const searchBody = (await searched.json()).data
    assert.equal(searchBody.mode, 'elasticsearch')
    assert.equal(searchBody.items[0].body, '完整、未脱敏正文')
    assert.equal(searchBody.items[0].extensions.private_note, 'admin-visible')
    assert.deepEqual(searchBody.items[0].highlight, { body: ['<em>命中</em>的正文'] })
    assert.deepEqual(searchBody.items[0].matchEvidence, ['raw_phrase'])
    assert.equal(searchBody.searchExecution.requestedProfile, DEFAULT_SEARCH_PROFILE)
    assert.equal(searchBody.searchExecution.appliedProfile, DEFAULT_SEARCH_PROFILE)
    assert.equal(searchBody.searchExecution.queryAnalysis.backendUsed, 'hanlp')
    assert.equal(searchBody.searchExecution.queryAnalysis.degraded, false)
    assert.deepEqual(searchBody.searchExecution.queryAnalysis.tokens, ['命中'])
    assert.deepEqual(searchBody.searchExecution.matchedBranches, ['raw_phrase'])
    assert.deepEqual(searchBody.searchExecution.sample.request, {
      query: '命中',
      searchProfile: DEFAULT_SEARCH_PROFILE,
      platform: 'twitter',
      datasetId: null,
      objectType: null,
      pageSize: 10,
    })
    assert.equal(searchBody.searchExecution.sample.response.items[0].text, '完整、未脱敏正文')
    assert.equal(JSON.stringify(searchBody.searchExecution.sample).includes('private_note'), false)
    assert.equal(JSON.stringify(searchBody.searchExecution.sample).includes('private-source'), false)
    assert.deepEqual(searchCalls[0], {
      query: '命中',
      options: {
        datasetId: null, platform: 'twitter', objectType: null, size: 10, cursor: null,
        // Newest-first by default: relevance ranking under a 时间 column reads
        // as unsorted data rather than as ranked data.
        offset: null, sort: 'newest', searchProfile: DEFAULT_SEARCH_PROFILE, trackTotalHits: true,
      },
    })
    assert.deepEqual(searchBody.pageInfo, {
      page: 1,
      pageSize: 10,
      total: 31,
      totalPages: 4,
      hasMore: true,
      nextCursor: searchBody.pageInfo.nextCursor,
      maxDirectPage: 4,
    })

    const jumpedSearch = await fetch(
      `${baseUrl}/internal/v1/admin/data-center/records?q=%E5%91%BD%E4%B8%AD&platform=twitter&pageSize=10&page=3`,
      { headers },
    )
    assert.equal(jumpedSearch.status, 200)
    assert.deepEqual((await jumpedSearch.json()).data.pageInfo, {
      page: 3, pageSize: 10, total: 31, totalPages: 4, hasMore: true, nextCursor: null,
      maxDirectPage: 4,
    })
    assert.deepEqual(searchCalls[1], {
      query: '命中',
      options: {
        datasetId: null, platform: 'twitter', objectType: null, size: 10, cursor: null,
        offset: 20, sort: 'newest', searchProfile: DEFAULT_SEARCH_PROFILE, trackTotalHits: true,
      },
    })

    for (const invalidPage of ['0', '-1', '1.5', 'not-a-number']) {
      const invalid = await fetch(
        `${baseUrl}/internal/v1/admin/data-center/records?page=${invalidPage}`,
        { headers },
      )
      assert.equal(invalid.status, 400)
      assert.equal((await invalid.json()).error.code, 'invalid_page')
    }
    const mixedPagination = await fetch(
      `${baseUrl}/internal/v1/admin/data-center/records?page=2&cursor=${encodeURIComponent(firstBody.pageInfo.nextCursor)}`,
      { headers },
    )
    assert.equal(mixedPagination.status, 400)
    assert.equal((await mixedPagination.json()).error.code, 'invalid_request')

    const deepSearchPage = await fetch(
      `${baseUrl}/internal/v1/admin/data-center/records?q=%E5%91%BD%E4%B8%AD&pageSize=10&page=1001`,
      { headers },
    )
    assert.equal(deepSearchPage.status, 400)
    assert.equal((await deepSearchPage.json()).error.code, 'search_page_out_of_range')

    const invalidProfile = await fetch(
      `${baseUrl}/internal/v1/admin/data-center/records?q=%E5%91%BD%E4%B8%AD&searchProfile=custom.dsl`,
      { headers },
    )
    assert.equal(invalidProfile.status, 400)
    assert.equal((await invalidProfile.json()).error.code, 'invalid_search_profile')

    const ignoredProfile = await fetch(
      `${baseUrl}/internal/v1/admin/data-center/records?searchProfile=canonical.phrase.v1`,
      { headers },
    )
    assert.equal(ignoredProfile.status, 400)
    assert.equal((await ignoredProfile.json()).error.code, 'invalid_request')

    const profileCursorMismatch = await fetch(
      `${baseUrl}/internal/v1/admin/data-center/records?q=%E5%91%BD%E4%B8%AD&platform=twitter&pageSize=10&searchProfile=canonical.phrase.v1&cursor=${encodeURIComponent(searchBody.pageInfo.nextCursor)}`,
      { headers },
    )
    assert.equal(profileCursorMismatch.status, 400)
    assert.equal((await profileCursorMismatch.json()).error.code, 'invalid_cursor')

    const adminProfile = await fetch(
      `${baseUrl}/internal/v1/admin/data-center/records?q=%E5%91%BD%E4%B8%AD&searchProfile=canonical.cjk-bigram.v1&pageSize=10`,
      { headers },
    )
    assert.equal(adminProfile.status, 200)
    assert.equal((await adminProfile.json()).data.searchExecution.requestedProfile, 'canonical.cjk-bigram.v1')
    assert.equal(searchCalls.at(-1).options.searchProfile, 'canonical.cjk-bigram.v1')

    const mismatched = await fetch(
      `${baseUrl}/internal/v1/admin/data-center/records?datasetId=other&pageSize=25&cursor=${encodeURIComponent(firstBody.pageInfo.nextCursor)}`,
      { headers },
    )
    assert.equal(mismatched.status, 400)
    assert.equal((await mismatched.json()).error.code, 'invalid_cursor')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('PostgresStore aggregates canonical truth and returns only safe record fields', async () => {
  const calls = []
  const store = new PostgresStore({
    async query(sql, values) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values })
      if (sql.includes('GROUP BY dataset_id')) {
        return {
          rows: [{
            dataset_id: 'telegram.messages.v1',
            platforms: ['telegram'],
            object_types: ['message'],
            content_types: ['text/plain'],
            active_record_count: '4',
            deleted_record_count: '2',
            revision_count: '9',
            last_collected_at: '2026-08-12T01:02:03.000Z',
            last_event_at: '2026-08-12T01:00:00.000Z',
          }],
        }
      }
      if (sql.includes('FROM core.canonical_records')) {
        return {
          rows: [{
            id: '11111111-1111-4111-8111-111111111111',
            dataset_id: 'telegram.messages.v1',
            platform: 'telegram',
            object_type: 'message',
            content_type: 'text/plain',
            external_id: '-1001:42',
            title: 'Safe title',
            current_revision: 3,
            event_time: '2026-08-12T01:00:00.000Z',
            collected_at: '2026-08-12T01:02:03.000Z',
            deleted_at: null,
            body: 'must not escape',
            stable_fields: { credential: 'must not escape' },
            extensions: { raw: 'must not escape' },
          }],
        }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    },
  })

  const result = await store.dataCenter({
    datasetId: 'telegram.messages.v1',
    platform: 'telegram',
    objectType: 'message',
    pageSize: 25,
  })

  assert.deepEqual(result, {
    stats: { datasetCount: 1, activeRecordCount: 4, revisionCount: 9, deletedRecordCount: 2 },
    datasets: [{
      datasetId: 'telegram.messages.v1',
      platforms: ['telegram'],
      objectTypes: ['message'],
      contentTypes: ['text/plain'],
      activeRecordCount: 4,
      deletedRecordCount: 2,
      revisionCount: 9,
      lastCollectedAt: '2026-08-12T01:02:03.000Z',
      lastEventAt: '2026-08-12T01:00:00.000Z',
    }],
    records: [{
      id: '11111111-1111-4111-8111-111111111111',
      datasetId: 'telegram.messages.v1',
      platform: 'telegram',
      objectType: 'message',
      contentType: 'text/plain',
      externalId: '-1001:42',
      title: 'Safe title',
      currentRevision: 3,
      eventTime: '2026-08-12T01:00:00.000Z',
      collectedAt: '2026-08-12T01:02:03.000Z',
      deletedAt: null,
    }],
    pageSize: 25,
  })
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].values, ['telegram.messages.v1', 'telegram', 'message'])
  assert.deepEqual(calls[1].values, ['telegram.messages.v1', 'telegram', 'message', 25])
  assert.match(calls[1].sql, /LIMIT \$4/)
  assert.doesNotMatch(calls.map((call) => call.sql).join('\n'), /\bbody\b|raw_payload|extensions|stable_fields|credential/i)
  assert.doesNotMatch(JSON.stringify(result.records), /must not escape/)
})

test('PostgresStore keyset-pages full canonical records for the Admin browser', async () => {
  const calls = []
  const store = new PostgresStore({
    async query(sql, values) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values })
      if (sql.includes('count(*)::bigint AS total')) return { rows: [{ total: '3' }] }
      return {
        rows: [
          {
            id: '22222222-2222-4222-8222-222222222222',
            dataset_id: 'external.canyie.v1', platform: 'twitter', object_type: 'post',
            content_type: null, external_id: '1962355370623652093', url: 'https://x.com/canyie/status/1',
            title: null, body: '正文一', author_external_id: '1192067927777742848', author_name: null,
            current_revision: 1, event_time: '2025-09-01T03:22:33.000Z',
            collected_at: '2025-11-21T03:14:24.000Z', deleted_at: null,
            sort_time: '2025-09-01T03:22:33.000Z',
          },
          {
            id: '11111111-1111-4111-8111-111111111111',
            dataset_id: 'external.canyie.v1', platform: 'twitter', object_type: 'post',
            content_type: null, external_id: 'older', url: null, title: null, body: '正文二',
            author_external_id: null, author_name: null, current_revision: 1,
            event_time: '2025-08-01T00:00:00.000Z', collected_at: null, deleted_at: null,
            sort_time: '2025-08-01T00:00:00.000Z',
          },
        ],
      }
    },
  })
  const result = await store.dataCenterRecords({
    datasetId: 'external.canyie.v1', platform: 'twitter', objectType: 'post', pageSize: 1,
    cursor: { sortTime: '2026-01-01T00:00:00.000Z', id: '33333333-3333-4333-8333-333333333333' },
  })
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].body, '正文一')
  assert.equal(result.items[0].externalId, '1962355370623652093')
  assert.equal(Object.hasOwn(result.items[0], 'publication'), false)
  assert.equal(result.total, 3)
  assert.equal(result.hasMore, true)
  assert.deepEqual(result.nextCursor, {
    sortTime: '2025-09-01T03:22:33.000Z', id: '22222222-2222-4222-8222-222222222222',
  })
  assert.deepEqual(calls[0].values, ['external.canyie.v1', 'twitter', 'post'])
  assert.deepEqual(calls[1].values, [
    'external.canyie.v1', 'twitter', 'post',
    '2026-01-01T00:00:00.000Z', '33333333-3333-4333-8333-333333333333', 2,
  ])
  assert.match(calls[1].sql, /^WITH page AS MATERIALIZED/)
  assert.match(calls[1].sql, /JOIN core\.canonical_records r ON r\.id = page\.id/)
  assert.match(calls[1].sql, /LEFT JOIN core\.public_opinion_current_state publication/)
  assert.match(calls[1].sql, /publication\.canonical_revision = r\.current_revision/)
  assert.match(calls[1].sql, /r\.dataset_id = 'public-opinion\.province\.v1'/)
  assert.match(calls[1].sql, /ORDER BY coalesce\(r\.event_time, r\.collected_at, r\.last_seen_at, r\.first_seen_at\) DESC, r\.id DESC/)
})

test('PostgresStore filters Admin records by explicit province relations without a quality gate', async () => {
  const calls = []
  const store = new PostgresStore({
    async query(sql, values) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values })
      if (sql.includes('count(*)::bigint AS total')) return { rows: [{ total: '1' }] }
      return {
        rows: [{
          id: '11111111-1111-4111-8111-111111111111',
          dataset_id: 'public-opinion.province.v1', platform: 'public_opinion',
          object_type: 'opinion_item', external_id: 'opinion-1', title: '江苏相关记录',
          current_revision: 1, sort_time: '2026-08-25T12:00:00.000Z',
          related_admin1_matches: ['event', 'recall', 'related'],
        }],
      }
    },
  })

  const result = await store.dataCenterRecords({
    datasetId: 'public-opinion.province.v1',
    query: '相关',
    relatedAdmin1Code: 'CN-JS',
    relatedProvinceNames: ['江苏', '江苏省'],
    provinceRelation: 'any',
    sort: 'newest',
    pageSize: 20,
  })

  assert.equal(result.total, 1)
  assert.deepEqual(result.items[0].relatedProvinceMatches, ['event', 'recall', 'related'])
  assert.deepEqual(calls[0].values, [
    'public-opinion.province.v1', '相关', 'CN-JS', ['江苏', '江苏省'],
  ])
  assert.deepEqual(calls[1].values, [
    'public-opinion.province.v1', '相关', 'CN-JS', ['江苏', '江苏省'], 21,
  ])
  for (const { sql } of calls) {
    assert.match(sql, /LEFT JOIN core\.record_revisions revision_filter/)
    assert.match(sql, /LEFT JOIN core\.public_opinion_current_state publication_filter/)
    assert.match(sql, /publication_filter\.event_admin1_code = \$3::text/)
    assert.match(sql, /politicalTerrorProvinceSuggestion/)
    assert.match(sql, /raw,raw,reportAttribution/)
    assert.match(sql, /report_attribution ->> 'basis' = 'publisher_registry'/)
    assert.match(sql, /geography\.related_admin1_codes/)
    assert.match(sql, /related_assertion\.task_id = publication_filter\.materialized_from_task_id/)
    assert.match(sql, /related_assertion\.canonical_revision = r\.current_revision/)
    assert.match(sql, /related_assertion\.source_object_revision_id = publication_filter\.source_object_revision_id/)
    assert.match(sql, /related_assertion\.status IN \('accepted', 'proposed'\)/)
    assert.match(sql, /related_task\.status = 'succeeded'/)
    assert.doesNotMatch(sql, /related_assertion\.status IN \([^)]*(?:rejected|superseded)/)
    assert.doesNotMatch(sql, /publication_filter\.(?:quality_score|qualification_threshold)/)
  }
  assert.match(calls[1].sql, /r\.external_id ILIKE '%' \|\| \$2 \|\| '%'/)
  assert.match(calls[1].sql, /AS related_admin1_matches/)
  assert.match(calls[1].sql, /ORDER BY page\.sort_time DESC, page\.id DESC/)
})

test('Data Center full records expose only revision-fenced bounded publication state', async () => {
  const recordId = '11111111-1111-4111-8111-111111111111'
  const publication = {
    sourceStage: 'candidate',
    status: 'qualified',
    qualityScore: 91,
    qualificationThreshold: 80,
    eventAdmin1Code: 'CN-JS',
    publisherAdmin1Code: 'CN-BJ',
    displayAdmin1Code: 'CN-JS',
    geographyVerified: true,
    geoScope: 'province',
    countryCode: 'CN',
    locationLabel: '南京市',
    locationType: 'city',
    countryName: '中国',
    assessedAt: '2026-08-25T14:22:00.000Z',
  }
  const row = {
    id: recordId,
    dataset_id: 'public-opinion.province.v1',
    platform: 'public_opinion',
    object_type: 'opinion_item',
    external_id: 'opinion-1',
    current_revision: 3,
    projection_revision: 4,
    sort_time: '2026-08-25T14:00:00.000Z',
    publication_record_id: recordId,
    publication_source_stage: 'candidate',
    publication_status: 'qualified',
    publication_quality_score: '91',
    publication_qualification_threshold: '80',
    publication_event_admin1_code: 'CN-JS',
    publication_publisher_admin1_code: 'CN-BJ',
    publication_display_admin1_code: 'CN-JS',
    publication_geography_verified: true,
    publication_geo_scope: 'province',
    publication_country_code: 'CN',
    publication_location_label: '南京市',
    publication_location_type: 'city',
    publication_country_name: '中国',
    publication_assessed_at: '2026-08-25T14:22:00.000Z',
    publication_quality_flags: ['must-not-escape'],
    publication_analysis_version: 'must-not-escape',
  }
  const calls = []
  const store = new PostgresStore({
    async query(sql, values) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values })
      if (sql.includes('count(*)::bigint AS total')) return { rows: [{ total: '1' }] }
      return { rows: [row] }
    },
  })

  const page = await store.dataCenterRecords({ pageSize: 50 })
  assert.deepEqual(page.items[0].publication, publication)
  const [byId] = await store.dataCenterRecordsByIds([recordId])
  assert.deepEqual(byId.publication, publication)
  assert.equal(JSON.stringify(page.items[0].publication).includes('must-not-escape'), false)

  const detailQueries = calls.filter((call) => !call.sql.includes('count(*)::bigint AS total'))
  assert.equal(detailQueries.length, 2)
  for (const { sql } of detailQueries) {
    assert.match(sql, /LEFT JOIN core\.public_opinion_current_state publication/)
    assert.match(sql, /publication\.record_id = r\.id/)
    assert.match(sql, /publication\.canonical_revision = r\.current_revision/)
    assert.match(sql, /r\.dataset_id = 'public-opinion\.province\.v1'/)
    assert.doesNotMatch(
      sql,
      /publication\.(?:quality_flags|rejection_codes|analysis_version|taxonomy_version|rule_version|prompt_version|materialized_from_task_id|source_object_revision_id)/,
    )
  }

  const genericStore = new PostgresStore({
    async query() {
      return { rows: [{
        id: recordId,
        dataset_id: 'external.generic.v1',
        platform: 'external',
        object_type: 'record',
        external_id: 'generic-1',
        current_revision: 1,
        publication_record_id: null,
      }] }
    },
  })
  const [generic] = await genericStore.dataCenterRecordsByIds([recordId])
  assert.equal(Object.hasOwn(generic, 'publication'), false)
})

test('PostgresStore supports direct 1-based Admin page offsets with an exact total', async () => {
  const calls = []
  const store = new PostgresStore({
    async query(sql, values) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values })
      if (sql.includes('count(*)::bigint AS total')) return { rows: [{ total: '3' }] }
      return {
        rows: [{
          id: '11111111-1111-4111-8111-111111111111',
          dataset_id: 'external.canyie.v1', platform: 'twitter', object_type: 'post',
          external_id: 'last', body: '最后一条', current_revision: 1,
          event_time: '2025-08-01T00:00:00.000Z', sort_time: '2025-08-01T00:00:00.000Z',
        }],
      }
    },
  })

  const result = await store.dataCenterRecords({
    datasetId: 'external.canyie.v1', platform: 'twitter', objectType: 'post',
    pageSize: 1, page: 3,
  })
  assert.equal(result.total, 3)
  assert.equal(result.items.length, 1)
  assert.equal(result.hasMore, false)
  assert.equal(result.nextCursor, null)
  assert.deepEqual(calls[1].values, ['external.canyie.v1', 'twitter', 'post', 2, 2])
  assert.match(calls[1].sql, /LIMIT \$4 OFFSET \$5/)

  await store.dataCenterRecords({
    datasetId: 'external.canyie.v1', sort: 'oldest', pageSize: 1,
    cursor: {
      sortTime: '2025-01-01T00:00:00.000Z',
      id: '00000000-0000-4000-8000-000000000001',
    },
  })
  assert.match(calls[3].sql, /\) > \(\$2::timestamptz, \$3::uuid\)/)
  assert.match(calls[3].sql, /ORDER BY coalesce\(r\.event_time, r\.collected_at, r\.last_seen_at, r\.first_seen_at\) ASC, r\.id ASC/)
  assert.match(calls[3].sql, /ORDER BY page\.sort_time ASC, page\.id ASC/)
})
