import assert from 'node:assert/strict'
import test from 'node:test'
import { fallbackSegment } from '@qpjoy/mx-common/segmenter'
import { ElasticsearchError, ElasticsearchUnavailableError } from '@qpjoy/mx-common/elasticsearch'
import { contentIndex, chunkIndex } from '../../server/search/index-definitions.mjs'
import {
  cachingSegmenter,
  mapWithConcurrency,
  ensureCurrentChunkIndex,
  ensureCurrentContentIndex,
  ensureSearchIndices,
} from '../../server/search/index.mjs'
import { buildContentDocument } from '../../server/search/document.mjs'
import { authorNameQuery, SearchQueries } from '../../server/search/queries.mjs'
import {
  DEFAULT_SEARCH_PROFILE,
  POSTGRES_SEARCH_PROFILE,
  resolveSearchProfile,
  searchCapabilities,
} from '../../server/search/profiles.mjs'
import { SearchProjector } from '../../server/search/projector.mjs'
import { purgeStaleCurrentStateCopies } from '../../server/search/current-state.mjs'
import {
  requiredReindexBackend,
  requireSegmenterBackend,
} from '../../server/search/reindex-integrity.mjs'

const segmenter = { segment: async (text) => fallbackSegment(text) }

function searchHit(id, score, eventTime, shardDoc = 0, matchedQueries = []) {
  return {
    _id: id,
    _score: score,
    sort: [score, eventTime, id, shardDoc],
    matched_queries: matchedQueries,
    _source: { id, externalId: id, eventTime, body: 'keyword' },
  }
}

function contentSearch({ pool = { query: async () => ({ rows: [] }) }, client = null, logger = null } = {}) {
  return new SearchQueries({
    pool,
    client,
    segmenter,
    indexSet: { readAlias: 'mx-insight-hub-content-read-v2' },
    logger,
  })
}

function canonicalRow(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    dataset_id: 'night-all.search.v1',
    platform: 'xiaohongshu',
    object_type: 'post',
    external_id: '6a6c52df000000002800b10a',
    schema_version: 'content.v1',
    payload_sha256: 'a'.repeat(64),
    content_type: 'normal',
    url: 'https://www.xiaohongshu.com/explore/6a6c52df000000002800b10a',
    title: '建议都去学吴恩达的AI Agent',
    body: '希望可以帮到你～ #大模型 #agent',
    author_external_id: '64cb45cb000000000e0252b5',
    author_name: '美丽的AI搬运工',
    event_time: new Date('2026-07-31T07:46:39.000Z'),
    collected_at: new Date('2026-08-06T11:20:25.000Z'),
    first_seen_at: new Date('2026-08-06T11:20:25.000Z'),
    last_seen_at: new Date('2026-08-06T11:20:25.000Z'),
    latitude: null,
    longitude: null,
    country_code: null,
    admin1_code: null,
    admin2_code: null,
    current_revision: 1,
    projection_revision: 3,
    stable_fields: {
      author: { externalId: '64cb45cb000000000e0252b5', name: '美丽的AI搬运工', avatarUrl: 'https://x/a.jpg' },
      media: { images: ['a', 'b'], videos: [] },
      metrics: { likes: 143, comments: 113, shares: 19, bookmarks: 135 },
    },
    extensions: {},
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Segmentation
// ---------------------------------------------------------------------------

test('fallback segmentation emits CJK bigrams so substrings stay findable', () => {
  const tokens = fallbackSegment('人工智能')
  assert.ok(tokens.includes('人工'), 'leading bigram is present')
  assert.ok(tokens.includes('智能'), 'trailing bigram is present')
  assert.ok(tokens.includes('工智'), 'straddling bigram is present')
})

test('fallback segmentation keeps latin words and drops bare hashtag markers', () => {
  const tokens = fallbackSegment('学 AI Agent #大模型')
  assert.ok(tokens.includes('ai'))
  assert.ok(tokens.includes('agent'))
  assert.ok(tokens.includes('大模'), 'the CJK tag text is bigrammed')
  // A lone "#" would appear in almost every social post and discriminate
  // nothing, so it must not reach the `tokens` keyword facet.
  assert.ok(!tokens.includes('#'), 'no bare sigil token')
})

test('fallback segmentation keeps latin hashtags and handles as single tokens', () => {
  const tokens = fallbackSegment('#AIAgent @user')
  assert.ok(tokens.includes('#aiagent'))
  assert.ok(tokens.includes('@user'))
})

test('strict reindex derives its required backend from the deployed process config', () => {
  assert.equal(requiredReindexBackend({ hanlpUrl: 'http://hanlp:8000' }), 'hanlp')
  assert.equal(requiredReindexBackend({}), 'jieba')
  assert.equal(
    requiredReindexBackend({ backend: 'jieba', hanlpUrl: 'http://hanlp:8000' }),
    'jieba',
    'an explicit backend overrides HanLP auto-discovery',
  )
  assert.equal(requiredReindexBackend({ backend: 'fallback', hanlpUrl: 'http://hanlp:8000' }), 'bigram')
  assert.throws(
    () => requiredReindexBackend({ backend: 'hanlp', hanlpUrl: null }),
    /requires MX_COMMON_HANLP_URL/,
  )
})

test('strict reindex segmentation retries transient HanLP degradation but never returns fallback tokens', async () => {
  const responses = [
    { tokens: ['jieba:first'], backendUsed: 'jieba', degraded: true, errorCode: 'hanlp_http_error' },
    { tokens: ['jieba:second'], backendUsed: 'jieba', degraded: true, errorCode: 'hanlp_timeout' },
    { tokens: ['人工智能'], backendUsed: 'hanlp', degraded: false, errorCode: null },
  ]
  const sleeps = []
  const strict = requireSegmenterBackend({
    async segmentWithMeta() { return responses.shift() },
  }, {
    expectedBackend: 'hanlp',
    retryDelayMs: 5,
    busyRetryDelayMs: 5,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    logger: { warn() {} },
  })

  assert.deepEqual(await strict.segment('人工智能'), ['人工智能'])
  assert.deepEqual(sleeps, [5, 10], 'retry delay is bounded and exponential')
})

test('a busy tokenizer earns a longer wait than a malformed one', async () => {
  const sleeps = []
  const strict = requireSegmenterBackend({
    async segmentWithMeta() {
      return { tokens: ['jieba'], backendUsed: 'jieba', degraded: true, errorCode: 'hanlp_http_error' }
    },
  }, {
    expectedBackend: 'hanlp',
    maxAttempts: 3,
    retryDelayMs: 10,
    busyRetryDelayMs: 500,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    logger: { warn() {} },
  })

  await assert.rejects(() => strict.segment('人工智能'), /reindex requires hanlp/)
  // Retrying at the malformed-response cadence would keep the inference queue
  // full; backing off further is what lets it drain under concurrency.
  assert.deepEqual(sleeps, [500, 1_000])
})

test('strict reindex accepts tokenless punctuation without invoking a fallback backend', async () => {
  let calls = 0
  const strict = requireSegmenterBackend({
    async segmentWithMeta() {
      calls += 1
      return { tokens: [], backendUsed: 'bigram', degraded: true, errorCode: 'hanlp_empty_response' }
    },
  }, { expectedBackend: 'hanlp', logger: { warn() {} } })

  assert.deepEqual(await strict.segment('…… 🎉'), [])
  assert.equal(calls, 0)
})

test('strict HanLP reindex fails closed after bounded fallback attempts', async () => {
  let attempts = 0
  const strict = requireSegmenterBackend({
    async segmentWithMeta() {
      attempts += 1
      return { tokens: ['jieba'], backendUsed: 'jieba', degraded: true, errorCode: 'hanlp_http_error' }
    },
  }, {
    expectedBackend: 'hanlp',
    retryDelayMs: 0,
    sleep: async () => {},
    logger: { warn() {} },
  })

  await assert.rejects(
    () => strict.segment('人工智能'),
    (error) => error?.code === 'reindex_segmenter_degraded'
      && error.expectedBackend === 'hanlp'
      && error.actualBackend === 'jieba',
  )
  // Bounded, and deliberately more patient than before: a rebuild now issues
  // several segmentation calls at once, so a transient queue must not be
  // mistaken for a permanently degraded backend.
  assert.equal(attempts, 6)
})

test('strict reindex projection rejects a degraded document before its bulk write', async () => {
  const indexSet = contentIndex()
  const harness = currentIndexHarness(indexSet, {
    [indexSet.currentIndex]: {
      [indexSet.readAlias]: {},
      [indexSet.writeAlias]: { is_write_index: true },
    },
  })
  harness.client.clusterHealth = async () => ({ status: 'yellow' })
  const strict = requireSegmenterBackend({
    async segmentWithMeta() {
      return { tokens: ['jieba'], backendUsed: 'jieba', degraded: true, errorCode: 'hanlp_http_error' }
    },
  }, {
    expectedBackend: 'hanlp',
    maxAttempts: 1,
    sleep: async () => {},
    logger: { warn() {} },
  })
  const report = await ensureSearchIndices({
    client: harness.client,
    pool: currentSnapshotPool('FROM core.canonical_records', [canonicalRow()]).pool,
    segmenter: strict,
    indexSet,
    chunkIndexSet: null,
  }, { logger: { log() {}, error() {}, warn() {} } })

  assert.match(report.error, /reindex requires hanlp tokens but received jieba/)
  assert.equal(harness.calls.bulks.length, 0, 'fallback tokens never reach Elasticsearch')
})

test('strict projector startup fails fast so reconciliation is retried by its supervisor', async () => {
  const failure = new Error('cluster unavailable during startup')
  const logger = { log() {}, error() {}, warn() {} }
  await assert.rejects(
    () => ensureSearchIndices({
      client: { async clusterHealth() { throw failure } },
    }, { logger, failOnError: true }),
    (error) => error === failure,
  )

  assert.deepEqual(
    await ensureSearchIndices({ client: null }, { logger, failOnError: true }),
    { enabled: false, reason: 'MX_COMMON_ELASTICSEARCH_URL is not configured' },
    'strict worker startup does not change the shared ES-optional contract',
  )
})

test('strict projector startup also fails fast on a reported mapping conflict', async () => {
  const indexSet = contentIndex()
  const harness = currentIndexHarness(indexSet, {
    [indexSet.currentIndex]: {
      [indexSet.readAlias]: {},
      [indexSet.writeAlias]: { is_write_index: true },
    },
  })
  harness.client.clusterHealth = async () => ({ status: 'yellow' })
  harness.client.putMapping = async () => {
    throw new ElasticsearchError(400, { error: { reason: 'incompatible content field' } })
  }

  await assert.rejects(
    () => ensureSearchIndices({
      client: harness.client,
      pool: currentSnapshotPool('FROM core.canonical_records', []).pool,
      segmenter: { async segment() { return [] } },
      indexSet,
      chunkIndexSet: null,
    }, { logger: { log() {}, error() {}, warn() {} }, failOnError: true }),
    /Content index mapping conflict: incompatible content field/,
  )
})

test('content search uses PIT search_after beyond the 10k window and ignores total relation gte', async () => {
  const calls = []
  const hits = [
    searchHit('33333333-3333-4333-8333-333333333333', 9.5, '2026-08-03T00:00:00.000Z', 3),
    searchHit('22222222-2222-4222-8222-222222222222', 8.5, '2026-08-02T00:00:00.000Z', 2),
    searchHit('11111111-1111-4111-8111-111111111111', 7.5, '2026-08-01T00:00:00.000Z', 1),
  ]
  const client = {
    async request(method, path, body) {
      calls.push({ method, path, body })
      if (path.includes('/_pit?')) return { id: 'pit-original' }
      if (path === '/_search') {
        return { pit_id: 'pit-renewed', hits: { total: { value: 10_000, relation: 'gte' }, hits } }
      }
      throw new Error(`unexpected ${method} ${path}`)
    },
  }

  const result = await contentSearch({ client }).searchContent('keyword', { size: 2 })
  const search = calls.find((entry) => entry.path === '/_search')
  assert.equal(Object.hasOwn(search.body, 'from'), false)
  assert.equal(Object.hasOwn(search.body, 'search_after'), false)
  assert.equal(search.body.size, 3)
  assert.deepEqual(search.body.sort, [
    { _score: { order: 'desc' } },
    { eventTime: { order: 'desc', missing: '_last', format: 'strict_date_time' } },
    { id: { order: 'desc' } },
  ])
  assert.deepEqual(search.body.query.bool.should[0].multi_match.fields, [
    'title^3', 'body', 'chatUsername^2',
  ])
  assert.equal(search.body.query.bool.should[0].multi_match.type, 'phrase')
  assert.deepEqual(search.body.query.bool.should[1].multi_match.fields, [
    'titleHanlp^3', 'bodyHanlp', 'chatUsernameHanlp^2',
  ])
  assert.equal(search.body.query.bool.should[1].multi_match.operator, 'and')
  assert.deepEqual(search.body.highlight.fields.chatUsername, {})
  assert.deepEqual(search.body.highlight.fields.chatUsernameHanlp, {})
  assert.ok(search.body._source.excludes.includes('chatUsernameHanlp'))
  assert.equal(result.items.length, 2)
  assert.equal(result.hasMore, true)
  assert.equal(result.totalRelation, 'gte')
  assert.deepEqual(result.nextCursor, {
    mode: 'elasticsearch',
    pitId: 'pit-renewed',
    searchAfter: hits[1].sort,
    analysisState: {
      v: 1,
      appliedProfile: DEFAULT_SEARCH_PROFILE,
      tokens: ['keyword'],
      backendUsed: null,
      degraded: false,
      errorCode: null,
    },
  })
})

test('offset content search asks Elasticsearch for an exact total and closes its one-page PIT', async () => {
  const calls = []
  const hits = [
    searchHit('33333333-3333-4333-8333-333333333333', 9.5, '2026-08-03T00:00:00.000Z', 3),
    searchHit('22222222-2222-4222-8222-222222222222', 8.5, '2026-08-02T00:00:00.000Z', 2),
    searchHit('11111111-1111-4111-8111-111111111111', 7.5, '2026-08-01T00:00:00.000Z', 1),
  ]
  const client = {
    async request(method, path, body) {
      calls.push({ method, path, body })
      if (path.includes('/_pit?')) return { id: 'pit-offset' }
      if (path === '/_search') {
        return { pit_id: 'pit-offset-renewed', hits: { total: { value: 237, relation: 'eq' }, hits } }
      }
      if (method === 'DELETE' && path === '/_pit') return { succeeded: true }
      throw new Error(`unexpected ${method} ${path}`)
    },
  }

  const result = await contentSearch({ client }).searchContent('人工智能', {
    size: 2,
    offset: 40,
    trackTotalHits: true,
  })
  const search = calls.find((entry) => entry.path === '/_search')
  assert.equal(search.body.from, 40)
  assert.equal(search.body.size, 2, 'offset pages must not request limit + 1 past max_result_window')
  assert.equal(search.body.track_total_hits, true)
  assert.equal(Object.hasOwn(search.body, 'search_after'), false)
  assert.equal(result.total, 237)
  assert.equal(result.totalRelation, 'eq')
  assert.equal(result.hasMore, true)
  assert.equal(result.items.length, 2)
  assert.equal(result.nextCursor, null, 'offset pages never expose a cursor tied to a closed PIT')
  assert.deepEqual(
    calls.find((entry) => entry.method === 'DELETE' && entry.path === '/_pit')?.body,
    { id: 'pit-offset-renewed' },
  )
})

test('offset search stays inside the Elasticsearch 10k result-window boundary', async () => {
  const calls = []
  const hits = Array.from({ length: 50 }, (_, index) => (
    searchHit(`record-${index}`, 100 - index, `2026-08-${String(28 - (index % 20)).padStart(2, '0')}T00:00:00.000Z`, index)
  ))
  const client = {
    async request(method, path, body) {
      calls.push({ method, path, body })
      if (path.includes('/_pit?')) return { id: 'pit-window-boundary' }
      if (path === '/_search') {
        return {
          pit_id: 'pit-window-boundary-renewed',
          hits: { total: { value: 10_001, relation: 'eq' }, hits },
        }
      }
      if (method === 'DELETE' && path === '/_pit') return { succeeded: true }
      throw new Error(`unexpected ${method} ${path}`)
    },
  }

  const result = await contentSearch({ client }).searchContent('边界', { size: 50, offset: 9_950 })
  const search = calls.find((entry) => entry.path === '/_search')
  assert.equal(search.body.from, 9_950)
  assert.equal(search.body.size, 50)
  assert.equal(search.body.from + search.body.size, 10_000)
  assert.equal(search.body.track_total_hits, true, 'offset mode always needs an exact total')
  assert.equal(result.items.length, 50)
  assert.equal(result.hasMore, true, 'exact total, not an extra hit, proves another result exists')
})

test('explicit relaxed relevance remains available while strict relevance is the default', async () => {
  const searches = []
  const client = {
    async request(method, path, body) {
      if (path.includes('/_pit?')) return { id: `pit-${searches.length}` }
      if (path === '/_search') {
        searches.push(body)
        return { hits: { total: { value: 0, relation: 'eq' }, hits: [] } }
      }
      if (method === 'DELETE' && path === '/_pit') return { succeeded: true }
      throw new Error(`unexpected ${method} ${path}`)
    },
  }
  const queries = contentSearch({ client })
  await queries.searchContent('人工智能')
  await queries.searchContent('人工智能', { strictRelevance: false })

  assert.equal(searches[0].query.bool.should[0].multi_match.type, 'phrase')
  assert.equal(searches[0].query.bool.should[1].multi_match.operator, 'and')
  assert.equal(searches[1].query.bool.should[0].multi_match.type, 'best_fields')
  assert.equal(searches[1].query.bool.should[1].multi_match.operator, undefined)
})

test('search profile registry exposes a bounded public allowlist and keeps diagnostics admin-only', () => {
  const publicCapabilities = searchCapabilities()
  assert.equal(publicCapabilities.indexSchema, 'content-v4')
  assert.equal(publicCapabilities.defaultProfile, DEFAULT_SEARCH_PROFILE)
  assert.deepEqual(publicCapabilities.profiles.map((entry) => entry.id), [
    'canonical.balanced.v1',
    'canonical.phrase.v1',
    'canonical.terms-all.v1',
    'canonical.zh-recall.v1',
    'canonical.title-prefix.v1',
  ])
  assert.match(
    publicCapabilities.profiles.find((entry) => entry.id === DEFAULT_SEARCH_PROFILE).summary,
    /HanLP\/pre-segmented.*AND/i,
  )
  assert.match(
    publicCapabilities.profiles.find((entry) => entry.id === 'canonical.zh-recall.v1').summary,
    /low-weight recall/i,
  )
  const prefixProfile = publicCapabilities.profiles.find((entry) => entry.id === 'canonical.title-prefix.v1')
  assert.equal(prefixProfile.maxPrefixChars, 12)
  assert.match(prefixProfile.warning, /12 characters/i)
  assert.equal(
    publicCapabilities.profiles.some((entry) => entry.id === 'canonical.legacy-or.v1'),
    false,
  )

  const adminCapabilities = searchCapabilities({ audience: 'admin' })
  assert.ok(adminCapabilities.profiles.some((entry) => entry.id === 'canonical.cjk-bigram.v1'))
  assert.ok(adminCapabilities.profiles.some((entry) => entry.id === 'canonical.legacy-or.v1'))
  assert.equal(adminCapabilities.fallbackProfile.id, POSTGRES_SEARCH_PROFILE)
  assert.equal(resolveSearchProfile(null).id, DEFAULT_SEARCH_PROFILE)
  assert.throws(
    () => resolveSearchProfile('canonical.legacy-or.v1'),
    (error) => error?.code === 'invalid_search_profile' && error?.status === 400,
  )
  assert.throws(
    () => resolveSearchProfile('custom.analyzer'),
    (error) => error?.code === 'invalid_search_profile' && error?.status === 400,
  )
})

test('named content profiles compile to fixed fields and operators', async () => {
  const searches = []
  const client = {
    async getAlias(alias) {
      return { [`${alias}-v4-current`]: { aliases: { [alias]: {} } } }
    },
    async request(method, path, body) {
      if (path.includes('/_pit?')) return { id: `pit-${searches.length}` }
      if (path === '/_search') {
        searches.push(body)
        return { hits: { total: { value: 0, relation: 'eq' }, hits: [] } }
      }
      if (method === 'DELETE' && path === '/_pit') return { succeeded: true }
      throw new Error(`unexpected ${method} ${path}`)
    },
  }
  const queries = contentSearch({ client })
  const profileIds = [
    'canonical.phrase.v1',
    'canonical.terms-all.v1',
    'canonical.zh-recall.v1',
    'canonical.title-prefix.v1',
    'canonical.cjk-bigram.v1',
    'canonical.legacy-or.v1',
  ]
  for (const searchProfile of profileIds) {
    await queries.searchContent('人工智能', { searchProfile })
  }

  assert.deepEqual(searches[0].query.bool.should.map((entry) => entry.multi_match._name), ['raw_phrase'])
  assert.deepEqual(searches[1].query.bool.should.map((entry) => entry.multi_match._name), ['terms_all'])
  assert.equal(searches[1].query.bool.should[0].multi_match.operator, 'and')
  assert.deepEqual(searches[2].query.bool.should.map((entry) => entry.multi_match._name), [
    'raw_phrase', 'terms_all', 'cjk_phrase',
  ])
  assert.equal(searches[2].query.bool.should[2].multi_match.boost, 0.75)
  assert.ok(searches[2].query.bool.should[2].multi_match.fields.includes('body.cjk'))
  assert.deepEqual(searches[3].query.bool.should.map((entry) => entry.multi_match._name), ['title_prefix'])
  assert.deepEqual(searches[3].query.bool.should[0].multi_match.fields, [
    'title.prefix^5', 'authorName.prefix^3', 'authorHandle.prefix^3',
    'username.prefix^3', 'chatUsername.prefix^3',
  ])
  assert.deepEqual(searches[4].query.bool.should.map((entry) => entry.multi_match._name), ['cjk_phrase'])
  assert.deepEqual(searches[5].query.bool.should.map((entry) => entry.multi_match._name), [
    'legacy_raw_or', 'legacy_terms_or',
  ])
  assert.equal(searches[5].query.bool.should[0].multi_match.type, 'best_fields')
  assert.equal(searches[5].query.bool.should[1].multi_match.operator, undefined)

  await assert.rejects(
    () => queries.searchContent('人工智能', { searchProfile: 'arbitrary.dsl' }),
    (error) => error?.code === 'invalid_search_profile' && error?.status === 400,
  )
})

test('v4-only profiles fail closed until the read alias serves content-v4', async () => {
  let backing = 'mx-insight-hub-content-v3-current'
  const client = {
    async getAlias(alias) {
      return { [backing]: { aliases: { [alias]: {} } } }
    },
    async request(method, path) {
      if (path.includes('/_pit?')) return { id: 'pit-v4-ready' }
      if (path === '/_search') return { hits: { total: { value: 0, relation: 'eq' }, hits: [] } }
      if (method === 'DELETE' && path === '/_pit') return { succeeded: true }
      throw new Error(`unexpected ${method} ${path}`)
    },
  }
  const queries = new SearchQueries({
    pool: { query: async () => ({ rows: [] }) },
    client,
    segmenter,
    indexSet: { readAlias: 'mx-insight-hub-content' },
    logger: null,
  })

  const before = await queries.searchCapabilities({ audience: 'admin' })
  assert.equal(before.activeIndexSchema, 'content-v3')
  assert.equal(before.ready, false)
  assert.equal(before.profiles.find((entry) => entry.id === DEFAULT_SEARCH_PROFILE).ready, true)
  assert.equal(before.profiles.find((entry) => entry.id === 'canonical.zh-recall.v1').ready, false)
  await assert.rejects(
    () => queries.searchContent('人工智能', { searchProfile: 'canonical.zh-recall.v1' }),
    (error) => error?.status === 503
      && error?.code === 'search_profile_unavailable'
      && error?.details?.requiredIndexSchema === 'content-v4',
  )

  backing = 'mx-insight-hub-content-v4-current'
  const after = await queries.searchCapabilities({ audience: 'admin' })
  assert.equal(after.activeIndexSchema, 'content-v4')
  assert.equal(after.ready, true)
  assert.equal(after.profiles.find((entry) => entry.id === 'canonical.zh-recall.v1').ready, true)
  const result = await queries.searchContent('人工智能', { searchProfile: 'canonical.title-prefix.v1' })
  assert.equal(result.searchExecution.appliedProfile, 'canonical.title-prefix.v1')
})

test('degraded query analysis is bounded and falls back to phrase without using incompatible tokens', async () => {
  const tokens = Array.from({ length: 600 }, (_, index) => `词${index}${'长'.repeat(200)}`)
  let searchBody = null
  const queries = new SearchQueries({
    pool: { query: async () => ({ rows: [] }) },
    client: {
      async request(method, path, body) {
        if (path.includes('/_pit?')) return { id: 'pit-analysis' }
        if (path === '/_search') {
          searchBody = body
          return {
            hits: {
              total: { value: 2, relation: 'eq' },
              hits: [
                searchHit(
                  '11111111-1111-4111-8111-111111111111',
                  9,
                  '2026-08-01T00:00:00.000Z',
                  1,
                  ['raw_phrase', 'physical_index_name'],
                ),
                searchHit(
                  '22222222-2222-4222-8222-222222222222',
                  8,
                  '2026-07-31T00:00:00.000Z',
                  2,
                  ['raw_phrase'],
                ),
              ],
            },
          }
        }
        if (method === 'DELETE' && path === '/_pit') return { succeeded: true }
        throw new Error(`unexpected ${method} ${path}`)
      },
    },
    segmenter: {
      async segmentWithMeta() {
        return { tokens, backendUsed: 'hanlp', degraded: true, errorCode: 'hanlp_timeout' }
      },
    },
    indexSet: { readAlias: 'content' },
    logger: null,
  })

  const result = await queries.searchContent('人工智能', { size: 1 })
  assert.equal(result.searchExecution.requestedProfile, DEFAULT_SEARCH_PROFILE)
  assert.equal(result.searchExecution.appliedProfile, 'canonical.phrase.v1')
  assert.equal(result.searchExecution.queryAnalysis.backendUsed, 'hanlp')
  assert.equal(result.searchExecution.queryAnalysis.degraded, true)
  assert.equal(result.searchExecution.queryAnalysis.errorCode, 'hanlp_timeout')
  assert.equal(result.searchExecution.queryAnalysis.tokenCount, 600)
  assert.ok(result.searchExecution.queryAnalysis.tokens.length <= 64)
  assert.equal(result.searchExecution.queryAnalysis.truncated, true)
  assert.equal(result.hasMore, true)
  assert.ok(result.nextCursor.analysisState.tokens.length <= 64)
  assert.ok(Buffer.byteLength(result.nextCursor.analysisState.tokens.join(''), 'utf8') <= 512)
  assert.ok(Buffer.byteLength(JSON.stringify(result.nextCursor.analysisState), 'utf8') < 1_024)
  assert.deepEqual(result.searchExecution.matchedBranches, ['raw_phrase'])
  assert.deepEqual(result.items[0].matchEvidence, ['raw_phrase'])
  assert.deepEqual(searchBody.query.bool.should.map((entry) => entry.multi_match._name), ['raw_phrase'])
  assert.equal(JSON.stringify(searchBody.query).includes('titleHanlp'), false)
  assert.match(result.searchExecution.warning, /pre-segmented fields built under different tokenizer provenance/)
  assert.equal(JSON.stringify(result).includes('physical_index_name'), false)
})

test('every segmentation-dependent profile fails soft to the fixed phrase plan without querying HanLP fields', async () => {
  const searches = []
  const queries = new SearchQueries({
    pool: { query: async () => ({ rows: [] }) },
    client: {
      async getAlias(alias) {
        return { [`${alias}-v4-current`]: { aliases: { [alias]: {} } } }
      },
      async request(method, path, body) {
        if (path.includes('/_pit?')) return { id: `pit-degraded-${searches.length}` }
        if (path === '/_search') {
          searches.push(body)
          return { hits: { total: { value: 0, relation: 'eq' }, hits: [] } }
        }
        if (method === 'DELETE' && path === '/_pit') return { succeeded: true }
        throw new Error(`unexpected ${method} ${path}`)
      },
    },
    segmenter: {
      async segmentWithMeta() {
        return {
          tokens: ['人工', '智能'],
          backendUsed: 'jieba',
          degraded: true,
          errorCode: 'hanlp_busy',
        }
      },
    },
    indexSet: { readAlias: 'content' },
    logger: null,
  })
  const profiles = [
    DEFAULT_SEARCH_PROFILE,
    'canonical.terms-all.v1',
    'canonical.zh-recall.v1',
    'canonical.legacy-or.v1',
  ]

  for (const searchProfile of profiles) {
    const result = await queries.searchContent('人工智能', { searchProfile })
    assert.equal(result.searchExecution.requestedProfile, searchProfile)
    assert.equal(result.searchExecution.appliedProfile, 'canonical.phrase.v1')
    assert.equal(result.searchExecution.queryAnalysis.backendUsed, 'jieba')
    assert.equal(result.searchExecution.queryAnalysis.degraded, true)
    assert.equal(result.searchExecution.queryAnalysis.errorCode, 'hanlp_busy')
    assert.match(result.searchExecution.warning, /canonical\.phrase\.v1 was applied/)
  }
  for (const body of searches) {
    assert.deepEqual(body.query.bool.should.map((entry) => entry.multi_match._name), ['raw_phrase'])
    assert.equal(JSON.stringify(body.query).includes('Hanlp'), false)
  }
})

test('Elasticsearch cursor pages reuse the first analysis state without calling the segmenter again', async () => {
  let segmentCalls = 0
  const searchBodies = []
  const hits = [
    searchHit('22222222-2222-4222-8222-222222222222', 8, '2026-08-02T00:00:00.000Z', 2),
    searchHit('11111111-1111-4111-8111-111111111111', 7, '2026-08-01T00:00:00.000Z', 1),
  ]
  const queries = new SearchQueries({
    pool: { query: async () => ({ rows: [] }) },
    client: {
      async request(method, path, body) {
        if (path.includes('/_pit?')) return { id: 'pit-frozen-analysis' }
        if (path === '/_search') {
          searchBodies.push(body)
          return searchBodies.length === 1
            ? { pit_id: 'pit-frozen-analysis', hits: { total: { value: 2, relation: 'eq' }, hits } }
            : { pit_id: 'pit-frozen-analysis', hits: { total: { value: 2, relation: 'eq' }, hits: [] } }
        }
        if (method === 'DELETE' && path === '/_pit') return { succeeded: true }
        throw new Error(`unexpected ${method} ${path}`)
      },
    },
    segmenter: {
      async segmentWithMeta() {
        segmentCalls += 1
        if (segmentCalls > 1) throw new Error('segmenter must not run for a cursor page')
        return { tokens: ['人工智能'], backendUsed: 'hanlp', degraded: false, errorCode: null }
      },
    },
    indexSet: { readAlias: 'content' },
    logger: null,
  })

  const first = await queries.searchContent('人工智能', { size: 1 })
  const second = await queries.searchContent('人工智能', { size: 1, cursor: first.nextCursor })
  assert.equal(segmentCalls, 1)
  assert.equal(first.nextCursor.analysisState.appliedProfile, DEFAULT_SEARCH_PROFILE)
  assert.deepEqual(first.nextCursor.analysisState.tokens, ['人工智能'])
  assert.equal(second.searchExecution.queryAnalysis.backendUsed, 'hanlp')
  assert.equal(second.searchExecution.appliedProfile, DEFAULT_SEARCH_PROFILE)
  assert.deepEqual(searchBodies[1].search_after, first.nextCursor.searchAfter)
  assert.equal(searchBodies[1].query.bool.should[1].multi_match.query, '人工智能')
})

test('analysis state rejects oversized tokenizer evidence before opening a PIT', async () => {
  let elasticsearchCalls = 0
  const queries = new SearchQueries({
    pool: { query: async () => ({ rows: [] }) },
    client: {
      async request() {
        elasticsearchCalls += 1
        throw new Error('Elasticsearch must not be called for oversized analysis')
      },
    },
    segmenter: {
      async segmentWithMeta() {
        return {
          tokens: Array.from({ length: 5 }, (_, index) => `${index}${'词'.repeat(500)}`),
          backendUsed: 'hanlp',
          degraded: false,
          errorCode: null,
        }
      },
    },
    indexSet: { readAlias: 'content' },
    logger: null,
  })

  await assert.rejects(
    () => queries.searchContent('人工智能'),
    (error) => error?.status === 503 && error?.code === 'search_analysis_unavailable',
  )
  assert.equal(elasticsearchCalls, 0)
})

test('canonical content search applies the granted-platform intersection, strict terms and exact totals', async () => {
  const calls = []
  const client = {
    async request(method, path, body) {
      calls.push({ method, path, body })
      if (path.includes('/_pit?')) return { id: 'canonical-pit' }
      if (path === '/_search') {
        return { pit_id: 'canonical-pit-2', hits: { total: { value: 23, relation: 'eq' }, hits: [] } }
      }
      if (method === 'DELETE' && path === '/_pit') return { succeeded: true }
      throw new Error(`unexpected ${method} ${path}`)
    },
  }

  const result = await contentSearch({ client }).searchContent('人工 智能', {
    platforms: ['telegram', 'xiaohongshu'],
    datasetId: 'telegram.sqlite.messages.v1',
    objectType: 'message',
    strictRelevance: true,
    trackTotalHits: true,
  })
  const search = calls.find((entry) => entry.path === '/_search')
  assert.equal(search.body.track_total_hits, true)
  assert.equal(search.body.query.bool.should[0].multi_match.type, 'phrase')
  assert.equal(search.body.query.bool.should[1].multi_match.operator, 'and')
  assert.deepEqual(search.body.query.bool.filter, [
    { terms: { platform: ['telegram', 'xiaohongshu'] } },
    { term: { datasetId: 'telegram.sqlite.messages.v1' } },
    { term: { objectType: 'message' } },
  ])
  assert.equal(result.total, 23)
  assert.equal(result.totalRelation, 'eq')
})

test('PIT pagination excludes records inserted between pages without duplicating or losing snapshot rows', async () => {
  const liveRows = [
    searchHit('44444444-4444-4444-8444-444444444444', 10, '2026-08-04T00:00:00.000Z', 4),
    searchHit('33333333-3333-4333-8333-333333333333', 9, '2026-08-03T00:00:00.000Z', 3),
    searchHit('22222222-2222-4222-8222-222222222222', 8, '2026-08-02T00:00:00.000Z', 2),
    searchHit('11111111-1111-4111-8111-111111111111', 7, '2026-08-01T00:00:00.000Z', 1),
  ]
  let snapshot = null
  let pitVersion = 1
  const searchBodies = []
  const closed = []
  const client = {
    async request(method, path, body) {
      if (path.includes('/_pit?')) {
        snapshot = liveRows.map((row) => structuredClone(row))
        return { id: 'pit-1' }
      }
      if (path === '/_search') {
        searchBodies.push(body)
        const start = body.search_after
          ? snapshot.findIndex((row) => JSON.stringify(row.sort) === JSON.stringify(body.search_after)) + 1
          : 0
        pitVersion += 1
        return {
          pit_id: `pit-${pitVersion}`,
          hits: { total: { value: snapshot.length, relation: 'eq' }, hits: snapshot.slice(start, start + body.size) },
        }
      }
      if (method === 'DELETE' && path === '/_pit') {
        closed.push(body.id)
        return { succeeded: true }
      }
      throw new Error(`unexpected ${method} ${path}`)
    },
  }
  const queries = contentSearch({ client })
  const first = await queries.searchContent('keyword', { size: 2 })
  liveRows.unshift(searchHit('55555555-5555-4555-8555-555555555555', 11, '2026-08-05T00:00:00.000Z', 5))
  const second = await queries.searchContent('keyword', { size: 2, cursor: first.nextCursor })

  assert.deepEqual(
    [...first.items, ...second.items].map((item) => item.id),
    snapshot.map((row) => row._source.id),
  )
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 4)
  assert.deepEqual(searchBodies[1].search_after, first.nextCursor.searchAfter)
  assert.equal(second.hasMore, false)
  assert.deepEqual(closed, ['pit-3'])
})

test('PostgreSQL content fallback uses the same stable null-aware keyset and never OFFSET', async () => {
  let captured
  const rows = [
    {
      id: '22222222-2222-4222-8222-222222222222', dataset_id: 'telegram.monitor.messages.v1',
      platform: 'telegram', object_type: 'message', external_id: '-1007:2', event_time: null,
      collected_at: null, stable_fields: {},
    },
    {
      id: '11111111-1111-4111-8111-111111111111', dataset_id: 'telegram.monitor.messages.v1',
      platform: 'telegram', object_type: 'message', external_id: '-1007:1', event_time: null,
      collected_at: null, stable_fields: {},
    },
  ]
  const pool = {
    async query(sql, values) {
      captured = { sql, values }
      return { rows }
    },
  }
  const result = await contentSearch({ pool }).searchContent('keyword', {
    platform: 'telegram', size: 1,
    cursor: {
      mode: 'postgres', pitId: null,
      searchAfter: [null, '33333333-3333-4333-8333-333333333333'],
    },
  })
  assert.equal(/\bOFFSET\b/i.test(captured.sql), false)
  assert.match(captured.sql, /ORDER BY event_time DESC NULLS LAST, id DESC/)
  assert.match(
    captured.sql,
    /\(stable_fields #>> '\{attributes,chatUsername\}'\) ILIKE '%' \|\| \$1 \|\| '%'/,
  )
  assert.equal(captured.values[9], '33333333-3333-4333-8333-333333333333')
  assert.equal(captured.values[10], null)
  assert.equal(result.hasMore, true)
  assert.deepEqual(result.nextCursor.searchAfter, [null, rows[0].id])
  assert.equal(result.searchExecution.requestedProfile, DEFAULT_SEARCH_PROFILE)
  assert.equal(result.searchExecution.appliedProfile, POSTGRES_SEARCH_PROFILE)
  assert.equal(result.searchExecution.queryAnalysis.backendUsed, null)
  assert.equal(result.searchExecution.queryAnalysis.degraded, true)
  assert.equal(result.searchExecution.queryAnalysis.errorCode, 'search_projection_degraded')
  assert.match(result.searchExecution.warning, /PostgreSQL substring/i)
  assert.deepEqual(result.items[0].matchEvidence, ['postgres_substring'])
})

test('PostgreSQL offset search returns an exact total without exposing a keyset cursor', async () => {
  let captured
  const rows = [
    {
      id: '22222222-2222-4222-8222-222222222222', dataset_id: 'telegram.sqlite.messages.v1',
      platform: 'telegram', object_type: 'message', external_id: '-1007:2', event_time: null,
      collected_at: null, stable_fields: {}, total_count: '57',
    },
    {
      id: '11111111-1111-4111-8111-111111111111', dataset_id: 'telegram.sqlite.messages.v1',
      platform: 'telegram', object_type: 'message', external_id: '-1007:1', event_time: null,
      collected_at: null, stable_fields: {}, total_count: '57',
    },
  ]
  const pool = {
    async query(sql, values) {
      captured = { sql, values }
      return { rows }
    },
  }

  const result = await contentSearch({ pool }).searchContent('人工智能', {
    platform: 'telegram',
    size: 1,
    offset: 25,
    trackTotalHits: true,
  })
  assert.match(captured.sql, /count\(\*\) OVER \(\) AS total_count/)
  assert.match(captured.sql, /OFFSET \$14/)
  assert.equal(captured.values[12], 1, 'offset pages fetch exactly the requested page size')
  assert.equal(captured.values[13], 25)
  assert.equal(result.total, 57)
  assert.equal(result.totalRelation, 'eq')
  assert.equal(result.hasMore, true)
  assert.equal(result.nextCursor, null)
  assert.equal(result.items.length, 1)
})

test('PostgreSQL offset search keeps the exact total when the requested page is empty', async () => {
  const calls = []
  const pool = {
    async query(sql, values) {
      calls.push({ sql, values })
      if (/SELECT count\(\*\)::bigint AS total_count/.test(sql)) {
        return { rows: [{ total_count: '57' }] }
      }
      return { rows: [] }
    },
  }

  const result = await contentSearch({ pool }).searchContent('人工智能', {
    platform: 'telegram',
    size: 20,
    offset: 80,
    trackTotalHits: true,
  })
  assert.equal(calls.length, 2, 'only an empty page needs the exact-count fallback query')
  assert.equal(result.total, 57)
  assert.equal(result.totalRelation, 'eq')
  assert.equal(result.hasMore, false)
  assert.deepEqual(result.items, [])
})

test('content search rejects mixing offset and cursor pagination', async () => {
  await assert.rejects(
    () => contentSearch().searchContent('人工智能', {
      offset: 20,
      cursor: {
        mode: 'postgres', pitId: null,
        searchAfter: [null, '33333333-3333-4333-8333-333333333333'],
      },
    }),
    (error) => error?.code === 'incompatible_search_pagination' && error?.status === 400,
  )
})

test('PostgreSQL canonical fallback counts the full filtered set before applying its cursor', async () => {
  let captured
  const pool = {
    async query(sql, values) {
      captured = { sql, values }
      return {
        rows: [{
          id: '11111111-1111-4111-8111-111111111111',
          dataset_id: 'telegram.sqlite.messages.v1',
          platform: 'telegram',
          object_type: 'message',
          external_id: '-1007:1',
          event_time: new Date('2026-08-10T00:00:00.000Z'),
          collected_at: new Date('2026-08-10T00:01:00.000Z'),
          stable_fields: {},
          total_count: '7',
        }],
      }
    },
  }
  const result = await contentSearch({ pool }).searchContent('agent', {
    platforms: ['telegram', 'xiaohongshu'],
    datasetId: 'telegram.sqlite.messages.v1',
    size: 20,
    trackTotalHits: true,
    cursor: {
      mode: 'postgres', pitId: null,
      searchAfter: ['2026-08-11T00:00:00.000Z', '22222222-2222-4222-8222-222222222222'],
    },
  })
  assert.match(captured.sql, /count\(\*\) OVER \(\) AS total_count/)
  assert.match(captured.sql, /\$12::text\[\] IS NULL OR platform = ANY\(\$12::text\[\]\)/)
  assert.deepEqual(captured.values[11], ['telegram', 'xiaohongshu'])
  assert.equal(result.total, 7)
  assert.equal(result.totalRelation, 'eq')
})

test('an existing Elasticsearch cursor never silently degrades to PostgreSQL', async () => {
  let pgCalls = 0
  const queries = contentSearch({
    pool: { query: async () => { pgCalls += 1; return { rows: [] } } },
    client: {
      request: async () => { throw new ElasticsearchUnavailableError(new Error('offline')) },
    },
  })
  await assert.rejects(
    () => queries.searchContent('keyword', {
      cursor: {
        mode: 'elasticsearch', pitId: 'pit-1',
        searchAfter: [1, '2026-08-01T00:00:00.000Z', '11111111-1111-4111-8111-111111111111', 1],
      },
    }),
    (error) => error?.code === 'search_cursor_unavailable' && error?.status === 503,
  )
  assert.equal(pgCalls, 0)
})

test('an expired PIT is reported as an expired cursor instead of restarting on PostgreSQL', async () => {
  let pgCalls = 0
  const queries = contentSearch({
    pool: { query: async () => { pgCalls += 1; return { rows: [] } } },
    client: {
      request: async () => {
        throw new ElasticsearchError(404, { error: { type: 'search_context_missing_exception' } })
      },
    },
  })
  await assert.rejects(
    () => queries.searchContent('keyword', {
      cursor: {
        mode: 'elasticsearch', pitId: 'expired-pit',
        searchAfter: [1, '2026-08-01T00:00:00.000Z', '11111111-1111-4111-8111-111111111111', 1],
      },
    }),
    (error) => error?.code === 'search_cursor_expired' && error?.status === 410,
  )
  assert.equal(pgCalls, 0)
})

// ---------------------------------------------------------------------------
// Index definitions
// ---------------------------------------------------------------------------

test('content index derives read alias, write alias and bootstrap index', () => {
  const definition = contentIndex()
  assert.equal(definition.readAlias, 'mx-insight-hub-content')
  assert.equal(definition.writeAlias, 'mx-insight-hub-content-v4')
  assert.equal(definition.currentIndex, 'mx-insight-hub-content-v4-current')
  assert.equal(definition.bootstrapIndex, definition.currentIndex)
  assert.equal(definition.settings['index.lifecycle.name'], undefined)
  assert.equal(definition.settings['index.lifecycle.rollover_alias'], undefined)
})

test('content mapping carries the author fields the projector writes', () => {
  const { properties } = contentIndex().mappings
  assert.equal(properties.title.fields.prefix.analyzer, 'mx_edge_ngram')
  assert.equal(properties.title.fields.prefix.search_analyzer, 'mx_edge_ngram_search')
  assert.equal(properties.title.fields.cjk.analyzer, 'mx_cjk_bigram')
  assert.equal(properties.body.fields.cjk.analyzer, 'mx_cjk_bigram')
  // The original template had no author fields at all, which under
  // `dynamic: strict` would have rejected every document.
  assert.ok(properties.authorName, 'authorName is mapped')
  assert.ok(properties.authorName.fields.keyword, 'exact match sub-field')
  assert.ok(properties.authorName.fields.prefix, 'prefix sub-field')
  assert.ok(properties.authorName.fields.bigram, 'CJK bigram sub-field')
  assert.equal(properties.authorNameHanlp.analyzer, 'mx_presegmented')
  assert.equal(properties.authorExternalId.type, 'keyword')
  assert.ok(properties.username.fields.bigram, 'Telegram usernames use the ranked name mapping')
  assert.equal(properties.usernameHanlp.analyzer, 'mx_presegmented')
  assert.equal(properties.usernameSubstring.type, 'wildcard')
  assert.ok(properties.chatUsername.fields.bigram, 'chat usernames use the ranked name mapping')
  assert.equal(properties.chatUsernameHanlp.analyzer, 'mx_presegmented')
  assert.equal(properties.chatUsernameSubstring.type, 'wildcard')
  assert.equal(properties.authorHandleSubstring.type, 'wildcard')
  assert.equal(properties.chatId.type, 'keyword')
  assert.equal(properties.replyToMessageId.type, 'keyword')
  assert.equal(properties.mediaType.type, 'keyword')
  assert.equal(properties.mediaSizeBytes.type, 'long')
  assert.equal(properties.entityTypes.type, 'keyword')
})

test('chunk index is not created without configured embedding dimensions', () => {
  assert.equal(chunkIndex({ dimensions: null }), null)
  const withDims = chunkIndex({ dimensions: 1024 })
  assert.equal(withDims.mappings.properties.embedding.dims, 1024)
  assert.equal(withDims.mappings.properties.embedding.index, true)
  assert.equal(withDims.currentIndex, 'mx-insight-hub-chunk-v1-current')
  assert.equal(withDims.settings['index.lifecycle.name'], undefined)
})

function currentIndexHarness(indexSet, memberships) {
  const aliasesByIndex = new Map(
    Object.entries(memberships).map(([index, aliases]) => [index, new Map(Object.entries(aliases))]),
  )
  const calls = { templates: [], creates: [], bulks: [], aliasActions: [], readAliasesDuringBulk: [] }
  const existing = new Set(Object.keys(memberships))
  const aliasResponse = (pattern) => {
    const matches = pattern.endsWith('*')
      ? (alias) => alias.startsWith(pattern.slice(0, -1))
      : (alias) => alias === pattern
    const response = {}
    for (const [index, aliases] of aliasesByIndex) {
      const selected = Object.fromEntries([...aliases].filter(([alias]) => matches(alias)))
      if (Object.keys(selected).length > 0) response[index] = { aliases: selected }
    }
    if (Object.keys(response).length === 0) {
      const error = new Error('alias missing')
      error.status = 404
      throw error
    }
    return response
  }
  const client = {
    async putIndexTemplate(name, body) {
      calls.templates.push({ name, body })
    },
    async getAlias(alias) {
      return aliasResponse(alias)
    },
    async indexExists(index) {
      return existing.has(index)
    },
    async createIndex(index, body) {
      existing.add(index)
      aliasesByIndex.set(index, new Map())
      calls.creates.push({ index, body })
      return { acknowledged: true }
    },
    async putMapping() {},
    async bulk(operations) {
      calls.bulks.push(operations)
      calls.readAliasesDuringBulk.push(Object.keys(aliasResponse(indexSet.readAlias)).sort())
      return {
        errors: false,
        items: operations
          .filter((operation) => operation.index || operation.delete)
          .map((operation) => operation.index
            ? { index: { status: 200 } }
            : { delete: { status: 404 } }),
      }
    },
    async request(method, path, body) {
      assert.equal(method, 'POST')
      assert.equal(path, '/_aliases')
      calls.aliasActions.push(body.actions)
      for (const action of body.actions) {
        if (action.remove) aliasesByIndex.get(action.remove.index)?.delete(action.remove.alias)
        if (action.add) {
          const aliases = aliasesByIndex.get(action.add.index) || new Map()
          aliases.set(action.add.alias, { ...(action.add.is_write_index ? { is_write_index: true } : {}) })
          aliasesByIndex.set(action.add.index, aliases)
        }
      }
      return { acknowledged: true }
    },
  }
  return { client, calls, aliasResponse }
}

function currentSnapshotPool(matchSql, rows, {
  deletions = [],
  rebuildProgress = null,
  changedRows = [],
} = {}) {
  const queries = []
  const served = new Set()
  let released = false
  const buildStartedAt = new Date('2026-08-18T00:00:00.000Z')
  const connection = {
    async query(sql, values) {
      queries.push({ sql, values })
      // The rebuild cursor: `SELECT` reports any resumable progress, `INSERT`
      // opens a new one and returns the watermark the catch-up pass filters on.
      if (sql.includes('FROM control.search_rebuild_progress')) {
        return { rows: rebuildProgress ? [rebuildProgress] : [] }
      }
      if (sql.includes('INSERT INTO control.search_rebuild_progress')) {
        return { rows: [{ build_started_at: buildStartedAt }] }
      }
      if (sql.includes('UPDATE control.search_rebuild_progress')) return { rows: [], rowCount: 1 }
      if (sql.includes(matchSql)) {
        // The catch-up pass is a delta scan keyed on the build watermark; it
        // must not replay the whole corpus a second time. Each pass yields its
        // page once, then reports exhaustion so paging terminates.
        const delta = values?.[2] != null
        if (served.has(delta)) return { rows: [] }
        served.add(delta)
        return { rows: delta ? changedRows : rows }
      }
      if (sql.includes('FROM core.chunk_projection_deletes')) return { rows: deletions }
      return { rows: [], rowCount: 0 }
    },
    release() { released = true },
  }
  return {
    pool: { async connect() { return connection } },
    queries,
    buildStartedAt,
    get released() { return released },
  }
}

test('content current index atomically replaces v1-v3 read memberships with v4 PostgreSQL truth', async () => {
  const indexSet = contentIndex()
  const oldV1 = 'mx-insight-hub-content-v1-000001'
  const oldV2 = 'mx-insight-hub-content-v2-000001'
  const oldV3 = 'mx-insight-hub-content-v3-current'
  const harness = currentIndexHarness(indexSet, {
    [oldV1]: { [indexSet.readAlias]: {}, 'mx-insight-hub-content-v1': { is_write_index: true } },
    [oldV2]: { [indexSet.readAlias]: {}, 'mx-insight-hub-content-v2': { is_write_index: true } },
    [oldV3]: { [indexSet.readAlias]: {}, 'mx-insight-hub-content-v3': { is_write_index: true } },
  })
  const live = canonicalRow()
  const deleted = canonicalRow({
    id: '22222222-2222-4222-8222-222222222222',
    projection_revision: 4,
    deleted_at: new Date('2026-08-10T00:00:00.000Z'),
  })
  // One record is written while the build pass is scanning; the catch-up pass
  // exists to pick exactly that up once the aliases have moved.
  const snapshot = currentSnapshotPool('FROM core.canonical_records', [live, deleted], {
    changedRows: [live],
  })
  const progress = []

  const result = await ensureCurrentContentIndex({
    client: harness.client,
    pool: snapshot.pool,
    segmenter,
    indexSet,
    logger: { info() {}, warn() {} },
    onProgress: async (event) => progress.push(event),
  })

  assert.equal(result.rebuilt, true)
  assert.equal(result.currentIndex, 'mx-insight-hub-content-v4-current')
  assert.equal(harness.calls.templates.length, 1)
  assert.equal(harness.calls.templates[0].body.template.aliases, undefined, 'partial rebuild is never exposed by a template alias')
  assert.equal(harness.calls.templates[0].body.template.settings['index.lifecycle.name'], undefined)
  assert.equal(harness.calls.creates[0].index, indexSet.currentIndex)
  assert.equal(harness.calls.bulks.length, 2, 'the delta is replayed after the alias cutover')
  // The second pass is bounded by the build watermark rather than rescanning
  // the corpus: at this size a full second pass would double a multi-hour run.
  const canonicalScans = snapshot.queries.filter((entry) => entry.sql.includes('FROM core.canonical_records'))
  assert.equal(canonicalScans[0].values[2], null, 'the build pass scans everything')
  assert.equal(
    canonicalScans.at(-1).values[2].toISOString(),
    snapshot.buildStartedAt.toISOString(),
    'the catch-up pass scans only what changed after the build began',
  )
  assert.deepEqual(
    harness.calls.readAliasesDuringBulk[0],
    [oldV1, oldV2, oldV3],
    'v1-v3 remain readable until the first complete v4 snapshot has succeeded',
  )
  assert.deepEqual(harness.calls.readAliasesDuringBulk[1], [indexSet.currentIndex])
  assert.equal(harness.calls.bulks[0][0].index.version_type, 'external_gte')
  assert.equal(harness.calls.bulks[0][2].delete.version_type, 'external_gte')

  assert.equal(harness.calls.aliasActions.length, 1, 'all aliases move in one cluster-state update')
  const actions = harness.calls.aliasActions[0]
  assert.ok(actions.some(({ remove }) => remove?.index === oldV1 && remove.alias === indexSet.readAlias))
  assert.ok(actions.some(({ remove }) => remove?.index === oldV2 && remove.alias === indexSet.readAlias))
  assert.ok(actions.some(({ remove }) => remove?.index === oldV3 && remove.alias === indexSet.readAlias))
  assert.ok(actions.some(({ add }) => add?.index === indexSet.currentIndex && add.alias === 'mx-insight-hub-content-v1'))
  assert.ok(actions.some(({ add }) => add?.index === indexSet.currentIndex && add.alias === 'mx-insight-hub-content-v3'))
  assert.deepEqual(Object.keys(harness.aliasResponse(indexSet.readAlias)), [indexSet.currentIndex])
  assert.ok(snapshot.queries.some(({ sql }) => sql.includes('pg_advisory_lock')))
  assert.ok(snapshot.queries.some(({ sql }) => sql.includes('pg_advisory_unlock')))
  assert.equal(snapshot.released, true)
  assert.deepEqual(progress, [
    { projection: 'content', pass: 'build', processed: 2 },
    // One changed record, not the whole corpus over again.
    { projection: 'content', pass: 'catch-up', processed: 1 },
  ])
})

test('Projector lock heartbeat loss aborts a rebuild before alias cutover', async () => {
  const indexSet = contentIndex()
  const oldIndex = 'mx-insight-hub-content-v3-current'
  const harness = currentIndexHarness(indexSet, {
    [oldIndex]: {
      [indexSet.readAlias]: {},
      'mx-insight-hub-content-v3': { is_write_index: true },
    },
  })
  const snapshot = currentSnapshotPool('FROM core.canonical_records', [canonicalRow()])
  const sessionLost = Object.assign(new Error('full-reindex lock session terminated'), { code: '57P01' })
  let heartbeats = 0

  await assert.rejects(
    () => ensureCurrentContentIndex({
      client: harness.client,
      pool: snapshot.pool,
      segmenter,
      indexSet,
      logger: { info() {}, warn() {} },
      onProgress: async () => {
        heartbeats += 1
        throw sessionLost
      },
    }),
    (error) => error === sessionLost,
  )

  assert.equal(heartbeats, 1)
  assert.equal(harness.calls.bulks.length, 1, 'no later snapshot batch or pass runs after lock loss')
  assert.equal(harness.calls.aliasActions.length, 0, 'a task without the global lock never cuts aliases over')
  assert.deepEqual(Object.keys(harness.aliasResponse(indexSet.readAlias)), [oldIndex])
  assert.equal(snapshot.released, true)
})

test('chunk current index rebuild reuses stored vectors and removes the legacy read backing', async () => {
  const indexSet = chunkIndex({ dimensions: 3 })
  const old = 'mx-insight-hub-chunk-v1-000001'
  const harness = currentIndexHarness(indexSet, {
    [old]: { [indexSet.readAlias]: {}, [indexSet.writeAlias]: { is_write_index: true } },
  })
  const row = {
    id: '33333333-3333-4333-8333-333333333333',
    record_id: canonicalRow().id,
    chunk_index: 0,
    content: 'already embedded chunk content',
    chunker_version: 'v1',
    source_revision: 7,
    embedding_model: 'local:model',
    embedding_version: 1,
    vector: [0.1, 0.2, 0.3],
    created_at: new Date('2026-08-09T00:00:00.000Z'),
    dataset_id: 'night-all.search.v1',
    platform: 'telegram',
    external_id: '42',
    url: null,
    title: 'title',
    event_time: new Date('2026-08-09T00:00:00.000Z'),
  }
  const deletion = { document_id: `${row.record_id}:2:old-chunker`, source_revision: 7 }
  const snapshot = currentSnapshotPool('FROM core.record_chunks', [row], {
    deletions: [deletion],
    // The chunk was re-embedded while the build pass was scanning.
    changedRows: [row],
  })

  await ensureCurrentChunkIndex({
    client: harness.client,
    pool: snapshot.pool,
    segmenter,
    indexSet,
    logger: { info() {}, warn() {} },
  })

  assert.equal(harness.calls.bulks.length, 4, 'both passes replay live chunks and durable tombstones')
  const [action, document] = harness.calls.bulks[0]
  assert.equal(action.index._index, 'mx-insight-hub-chunk-v1-current')
  assert.equal(action.index._id, `${row.record_id}:0:v1`)
  assert.equal(action.index.version_type, 'external_gte')
  assert.deepEqual(document.embedding, row.vector, 'rebuild reads PostgreSQL vectors without invoking a model')
  assert.equal(document.sourceRevision, 7)
  assert.deepEqual(harness.calls.bulks[1], [{
    delete: {
      _index: indexSet.currentIndex,
      _id: deletion.document_id,
      version: 7,
      version_type: 'external_gte',
    },
  }])
  const deletionQuery = snapshot.queries.find(({ sql }) => sql.includes('FROM core.chunk_projection_deletes'))
  assert.doesNotMatch(deletionQuery.sql, /projected_at IS NULL/, 'acknowledged tombstones also rebuild current truth')
  assert.deepEqual(Object.keys(harness.aliasResponse(indexSet.readAlias)), [indexSet.currentIndex])
  assert.ok(harness.calls.aliasActions[0].some(({ remove }) => remove?.index === old && remove.alias === indexSet.readAlias))
})

test('same-revision chunk reindex replaces fallback contentHanlp with verified tokens', async () => {
  const indexSet = chunkIndex({ dimensions: 3 })
  const harness = currentIndexHarness(indexSet, {
    [indexSet.currentIndex]: {
      [indexSet.readAlias]: {},
      [indexSet.writeAlias]: { is_write_index: true },
    },
  })
  const row = {
    id: '33333333-3333-4333-8333-333333333333',
    record_id: canonicalRow().id,
    chunk_index: 0,
    content: '人工智能',
    chunker_version: 'v1',
    source_revision: 7,
    embedding_model: 'local:model',
    embedding_version: 1,
    vector: [0.1, 0.2, 0.3],
    created_at: new Date('2026-08-09T00:00:00.000Z'),
    dataset_id: 'night-all.search.v1',
    platform: 'telegram',
    external_id: '42',
    url: null,
    title: 'title',
    event_time: new Date('2026-08-09T00:00:00.000Z'),
  }
  const indexed = new Map()
  harness.client.bulk = async (operations) => {
    const items = []
    for (let index = 0; index < operations.length; index += 1) {
      const action = operations[index]
      if (!action.index) continue
      const document = operations[index + 1]
      const previous = indexed.get(action.index._id)
      const sameVersionAccepted = action.index.version_type === 'external_gte'
      const accepted = !previous
        || action.index.version > previous.version
        || (action.index.version === previous.version && sameVersionAccepted)
      if (accepted) {
        indexed.set(action.index._id, { version: action.index.version, document })
        items.push({ index: { status: 200 } })
      } else {
        items.push({ index: { status: 409, error: { type: 'version_conflict_engine_exception' } } })
      }
      index += 1
    }
    return { errors: items.some((item) => item.index.error), items }
  }

  const rebuild = (tokens) => ensureCurrentChunkIndex({
    client: harness.client,
    pool: currentSnapshotPool('FROM core.record_chunks', [row]).pool,
    segmenter: { segment: async () => tokens },
    indexSet,
    logger: { info() {}, warn() {} },
  })
  const documentId = `${row.record_id}:0:v1`

  await rebuild(['fallback-token'])
  assert.equal(indexed.get(documentId).document.contentHanlp, 'fallback-token')
  await rebuild(['人工智能'])
  assert.equal(
    indexed.get(documentId).document.contentHanlp,
    '人工智能',
    'external_gte accepts the same source revision so re-segmentation is not a no-op',
  )
})

test('an active current index is reconciled after a crash between alias switch and second pass', async () => {
  const indexSet = contentIndex()
  const harness = currentIndexHarness(indexSet, {
    [indexSet.currentIndex]: {
      [indexSet.readAlias]: {},
      'mx-insight-hub-content-v1': { is_write_index: true },
      [indexSet.writeAlias]: { is_write_index: true },
    },
  })
  const snapshot = currentSnapshotPool('FROM core.canonical_records', [
    canonicalRow({ projection_revision: 8, title: 'committed during the cutover window' }),
  ])

  const result = await ensureCurrentContentIndex({
    client: harness.client,
    pool: snapshot.pool,
    segmenter,
    indexSet,
    logger: { info() {}, warn() {} },
  })

  assert.equal(result.rebuilt, false)
  assert.equal(result.indexed, 1)
  assert.equal(harness.calls.aliasActions.length, 0, 'the aliases were already switched')
  assert.equal(harness.calls.bulks.length, 1, 'active startup repairs a missed second pass')
  assert.equal(harness.calls.bulks[0][0].index.version, 8)
  assert.equal(harness.calls.bulks[0][0].index.version_type, 'external_gte')
})

test('current-state cleanup supports a caller-selected revision field', async () => {
  let requestBody = null
  const indexSet = {
    readAlias: 'chunks',
    writeAlias: 'chunks-v1',
  }
  const client = {
    async getAlias(alias) {
      if (alias === indexSet.writeAlias) {
        return { 'chunks-v1-000002': { aliases: { [alias]: { is_write_index: true } } } }
      }
      return {
        'chunks-v1-000001': { aliases: { [alias]: {} } },
        'chunks-v1-000002': { aliases: { [alias]: {} } },
      }
    },
    async request(_method, _path, body) {
      requestBody = body
      return { failures: [] }
    },
  }

  const result = await purgeStaleCurrentStateCopies({
    client,
    indexSet,
    documents: [{ id: 'record-1:chunk-0', version: 7 }],
    versionField: 'sourceRevision',
  })
  assert.equal(result.currentIndex, 'chunks-v1-000002')
  assert.deepEqual(result.staleIndices, ['chunks-v1-000001'])
  assert.deepEqual(
    requestBody.query.bool.should[0].bool.filter[1],
    {
      bool: {
        should: [
          { range: { sourceRevision: { lte: 7 } } },
          { bool: { must_not: [{ exists: { field: 'sourceRevision' } }] } },
        ],
        minimum_should_match: 1,
      },
    },
  )
})

// ---------------------------------------------------------------------------
// Document projection
// ---------------------------------------------------------------------------

test('content document carries author, metrics and segmented text', async () => {
  const document = await buildContentDocument(canonicalRow(), { segmenter })
  assert.equal(document.authorName, '美丽的AI搬运工')
  assert.equal(document.authorAvatarUrl, 'https://x/a.jpg')
  assert.deepEqual(document.metrics, { likes: 143, comments: 113, shares: 19, bookmarks: 135 })
  assert.equal(document.mediaCount, 2)
  assert.equal(document.hasVideo, false)
  assert.ok(document.titleHanlp.includes(' '), 'segmented title is whitespace delimited')
  assert.ok(document.authorNameHanlp.includes(' '), 'author name has a dedicated segmented copy')
  assert.equal(document.projectionRevision, 3)
})

test('content projection serializes field segmentation for a single-slot HanLP service', async () => {
  let active = 0
  let maxActive = 0
  const calls = []
  const serialSegmenter = {
    async segmentWithMeta(text) {
      calls.push(text)
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setImmediate(resolve))
      active -= 1
      return {
        tokens: fallbackSegment(text),
        backendUsed: 'hanlp',
        degraded: false,
        errorCode: null,
      }
    },
  }

  await buildContentDocument(canonicalRow({
    stable_fields: {
      author: { handle: 'alice' },
      attributes: { username: 'channel', chatUsername: 'chat' },
    },
  }), { segmenter: serialSegmenter })

  assert.equal(maxActive, 1)
  assert.deepEqual(calls, [
    '建议都去学吴恩达的AI Agent',
    '希望可以帮到你～ #大模型 #agent',
    '美丽的AI搬运工',
    'channel',
    'chat',
  ])
})

test('content projection stops retrying HanLP fields after one degraded result', async () => {
  const calls = []
  const fallbackCalls = []
  const shortCircuitSegmenter = {
    fallbackSegmenter: {
      async segment(text) {
        fallbackCalls.push(text)
        return [`jieba:${text}`]
      },
    },
    async segmentWithMeta(text) {
      calls.push(text)
      return {
        tokens: [`jieba:${text}`],
        backendUsed: 'jieba',
        degraded: true,
        errorCode: 'hanlp_timeout',
      }
    },
  }

  const document = await buildContentDocument(canonicalRow({
    stable_fields: {
      author: { handle: 'alice' },
      attributes: { username: 'channel', chatUsername: 'chat' },
    },
  }), { segmenter: shortCircuitSegmenter })

  assert.deepEqual(calls, ['建议都去学吴恩达的AI Agent'])
  assert.deepEqual(fallbackCalls, [
    '希望可以帮到你～ #大模型 #agent',
    '美丽的AI搬运工',
    'channel',
    'chat',
  ])
  assert.equal(document.titleHanlp, 'jieba:建议都去学吴恩达的AI Agent')
  assert.equal(document.bodyHanlp, 'jieba:希望可以帮到你～ #大模型 #agent')
  assert.equal(document.authorNameHanlp, 'jieba:美丽的AI搬运工')
  assert.equal(document.usernameHanlp, 'jieba:channel')
  assert.equal(document.chatUsernameHanlp, 'jieba:chat')
})

test('Telegram document promotes fixed relation, media and entity fields before the initial index build', async () => {
  const editedAt = new Date('2026-08-09T10:20:30.000Z')
  const document = await buildContentDocument(canonicalRow({
    dataset_id: 'telegram.monitor.messages.v1',
    platform: 'telegram',
    object_type: 'message',
    author_name: '中文频道管理员',
    stable_fields: {
      author: { name: '中文频道管理员', handle: 'alice_admin' },
      attributes: { username: '中文频道', isOutgoing: false },
      relations: {
        chatId: -1007,
        messageId: 42,
        replyToMessageId: 41,
        threadId: 7,
        groupedId: 99,
      },
      media: {
        media_kind: 'image',
        mime_type: 'image/jpeg',
        extension: 'JPG',
        file_name: 'sample.jpg',
        size_bytes: 2048,
      },
      entities: [
        { type: 'text_url', url: 'https://example.test/a', user_id: 8 },
        { type: 'mention', user_id: 8 },
      ],
      editedAt,
      metrics: { views: 12 },
    },
  }), { segmenter })

  assert.equal(document.username, '中文频道')
  assert.equal(document.usernameSubstring, '中文频道')
  assert.equal(document.authorHandleSubstring, 'alice_admin')
  assert.ok(document.usernameHanlp.includes(' '), 'username has a dedicated segmented copy')
  assert.equal(document.chatId, '-1007')
  assert.equal(document.messageId, '42')
  assert.equal(document.replyToMessageId, '41')
  assert.equal(document.threadId, '7')
  assert.equal(document.groupedId, '99')
  assert.equal(document.isOutgoing, false)
  assert.equal(document.mediaKind, 'image')
  assert.equal(document.mediaMimeType, 'image/jpeg')
  assert.equal(document.mediaExtension, 'jpg')
  assert.equal(document.mediaFileName, 'sample.jpg')
  assert.equal(document.mediaSizeBytes, 2048)
  assert.deepEqual(document.entityTypes, ['text_url', 'mention'])
  assert.deepEqual(document.entityUserIds, ['8'])
  assert.deepEqual(document.entityUrls, ['https://example.test/a'])
  assert.equal(document.editedAt, editedAt)
})

test('provider lineage never reaches the customer-facing projection', async () => {
  const document = await buildContentDocument(
    canonicalRow({
      extensions: {
        providerId: 'tikhub',
        credentialId: 'cred-1',
        sourceEndpointId: 'ep-9',
        account_phone: '+8613800000003',
        account_alias: '采集三号',
        first_seen_account_id: 3,
        noteRank: 4,
      },
    }),
    { segmenter },
  )
  assert.deepEqual(Object.keys(document.extensions), ['noteRank'])
})

test('SQLite API records keep the shared external stream in the ES projection', async () => {
  const document = await buildContentDocument(canonicalRow({
    dataset_id: 'telegram.sqlite.messages.v1',
    platform: 'telegram',
    object_type: 'message',
    stable_fields: {
      attributes: {
        chatUsername: '中文频道',
        mediaType: 'MessageMediaPhoto',
      },
      source: { origin: 'sqlite_api', sourceKey: 'telegram-sqlite-api-messages' },
    },
  }), { segmenter })

  assert.equal(document.source.connectorId, 'external:telegram-sqlite-api-messages')
  assert.equal(document.source.streamId, 'telegram.external.v1')
  assert.equal(document.chatUsername, '中文频道')
  assert.equal(document.chatUsernameSubstring, '中文频道')
  assert.ok(document.chatUsernameHanlp.includes(' '))
  assert.equal(document.mediaType, 'MessageMediaPhoto')
  assert.equal(document.mediaKind, 'image')
  assert.equal(document.mediaCount, 1)
})

test('location is only emitted when both coordinates are known', async () => {
  const withoutGeo = await buildContentDocument(canonicalRow(), { segmenter })
  assert.equal(withoutGeo.location, undefined)
  const withGeo = await buildContentDocument(
    canonicalRow({ latitude: 31.23, longitude: 121.47 }),
    { segmenter },
  )
  assert.deepEqual(withGeo.location, [121.47, 31.23], 'Elasticsearch expects [lon, lat]')
})

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

test('author query confines substring wildcard matching to its native field and ranks exact matches first', () => {
  const query = authorNameQuery('admin', fallbackSegment('admin'))
  const serialized = JSON.stringify(query)
  assert.ok(!serialized.includes('"fuzzy"'), 'no fuzzy clause')
  const exact = query.bool.should.find((clause) => clause.term?.['authorName.keyword'])
  assert.equal(exact.term['authorName.keyword'].boost, 10)
  assert.ok(serialized.includes('authorNameHanlp'), 'segmented matching uses the dedicated HanLP field')
  assert.ok(serialized.includes('authorHandle.bigram'), 'handles support a Chinese mid-string match')
  assert.equal(
    query.bool.should.find((clause) => clause.match?.authorNameHanlp).match.authorNameHanlp.operator,
    'and',
  )
  assert.equal(
    query.bool.should.find((clause) => clause.match?.['authorName.bigram']).match['authorName.bigram'].operator,
    'and',
  )
  const substring = query.bool.should.find((clause) => clause.wildcard?.authorHandleSubstring)
  assert.equal(substring.wildcard.authorHandleSubstring.value, '*admin*')
  assert.equal(substring.wildcard.authorHandleSubstring.case_insensitive, true)
})

test('Telegram chat lookup uses raw exact/prefix fields and the dedicated username HanLP field', async () => {
  let body = null
  const queries = contentSearch({
    client: {
      async search(_index, request) {
        body = request
        return { hits: { hits: [] } }
      },
    },
  })
  await queries.searchTelegramChats('中文频道')
  const serialized = JSON.stringify(body.query)
  assert.ok(serialized.includes('username.keyword'))
  assert.ok(serialized.includes('username.prefix'))
  assert.ok(serialized.includes('username.bigram'))
  assert.ok(serialized.includes('usernameHanlp'))
  assert.ok(serialized.includes('usernameSubstring'))
  assert.ok(!serialized.includes('"fuzzy"'))
  assert.equal(
    body.query.bool.should.find((clause) => clause.match?.usernameHanlp).match.usernameHanlp.operator,
    'and',
  )
  assert.ok(body.query.bool.should.some((clause) => clause.match_phrase?.title))
})

test('chunk lexical retrieval requires every segmented term instead of matching one CJK character', async () => {
  let body = null
  const queries = new SearchQueries({
    pool: { query: async () => ({ rows: [] }) },
    client: {
      async search(_index, request) {
        body = request
        return { hits: { hits: [] } }
      },
    },
    segmenter,
    indexSet: { readAlias: 'content' },
    chunkIndexSet: { readAlias: 'chunks' },
    logger: null,
  })

  await queries.semanticSearch('人工智能')
  assert.equal(body.query.bool.should[0].match.content.operator, 'and')
  assert.equal(body.query.bool.should[1].match.contentHanlp.operator, 'and')
})

// ---------------------------------------------------------------------------
// Projector
// ---------------------------------------------------------------------------

function fakePool(handlers) {
  return {
    queries: [],
    async query(sql, values) {
      this.queries.push({ sql, values })
      for (const [pattern, handler] of handlers) {
        if (sql.includes(pattern)) return handler(values)
      }
      return { rows: [], rowCount: 0 }
    },
  }
}

test('projector treats a version conflict as delivered, not failed', async () => {
  const row = canonicalRow()
  const updates = []
  const pool = fakePool([
    ["SET status = 'claimed'", () => ({
      rows: [{ id: 7, aggregate_id: row.id, event_type: 'upsert', projection_revision: 3, attempts: 1 }],
    })],
    ['FROM core.canonical_records WHERE id = ANY', () => ({ rows: [row] })],
    ['INSERT INTO outbox.projection_runs', () => ({ rows: [{ id: 1 }] })],
    ["SET status = 'delivered'", (values) => {
      updates.push(['delivered', values[0]])
      return { rows: [], rowCount: 1 }
    }],
  ])

  let bulkBody = null
  const projector = new SearchProjector({
    pool,
    segmenter,
    indexSet: contentIndex(),
    logger: { log() {}, warn() {}, error() {} },
    client: {
      async bulk(operations) {
        bulkBody = operations
        // 409 means the index already holds this revision or newer: the
        // projection is at least as fresh as this event, so redelivery after a
        // crash must not burn the event's retry budget.
        return { errors: true, items: [{ index: { _id: row.id, status: 409, error: { type: 'version_conflict_engine_exception' } } }] }
      },
    },
  })

  const result = await projector.projectBatch()
  assert.equal(result.delivered, 1)
  assert.equal(result.failed, 0)
  assert.deepEqual(updates[0], ['delivered', [7]])

  const [action] = bulkBody
  assert.equal(action.index.version_type, 'external')
  assert.equal(action.index.version, 3, 'external version guards against out-of-order delivery')
  const deliveredUpdate = pool.queries.find(({ sql }) => sql.includes("SET status = 'delivered'"))
  assert.match(deliveredUpdate.sql, /status = 'claimed'/)
  assert.match(deliveredUpdate.sql, /locked_by = \$2/)
  assert.equal(deliveredUpdate.values[1], projector.workerId)
})

test('projector turns a stale upsert into a versioned delete for a current tombstone', async () => {
  const row = canonicalRow({
    projection_revision: 4,
    deleted_at: new Date('2026-08-10T00:00:00.000Z'),
  })
  const delivered = []
  const backingIndices = [
    'mx-insight-hub-content-v1-000001',
    'mx-insight-hub-content-v2-000001',
    'mx-insight-hub-content-v3-current',
    'mx-insight-hub-content-v4-current',
  ]
  let cleanupRequest = null
  let bulkBody = null
  const pool = fakePool([
    ["SET status = 'claimed'", () => ({
      rows: [{ id: 8, aggregate_id: row.id, event_type: 'upsert', projection_revision: 3, attempts: 1 }],
    })],
    ['FROM core.canonical_records WHERE id = ANY', () => ({ rows: [row] })],
    ['INSERT INTO outbox.projection_runs', () => ({ rows: [{ id: 1 }] })],
    ["SET status = 'delivered'", (values) => {
      delivered.push(values[0])
      return { rows: [], rowCount: 1 }
    }],
  ])
  const projector = new SearchProjector({
    pool,
    segmenter,
    indexSet: contentIndex(),
    logger: { log() {}, warn() {}, error() {} },
    client: {
      async getAlias(alias) {
        if (alias === 'mx-insight-hub-content-v4') {
          return {
            [backingIndices[3]]: {
              aliases: { [alias]: { is_write_index: true } },
            },
          }
        }
        assert.equal(alias, 'mx-insight-hub-content')
        return Object.fromEntries(backingIndices.map((index) => [index, { aliases: {} }]))
      },
      async request(method, path, body) {
        cleanupRequest = { method, path, body }
        return { deleted: 1, version_conflicts: 0, failures: [] }
      },
      async bulk(operations) {
        bulkBody = operations
        return {
          errors: false,
          items: operations.map(({ delete: action }) => ({
            delete: { _id: action._id, _index: action._index, status: 200 },
          })),
        }
      },
    },
  })

  const result = await projector.projectBatch()
  assert.equal(result.delivered, 1)
  assert.equal(result.failed, 0)
  assert.deepEqual(delivered, [[8]])
  assert.equal(cleanupRequest.method, 'POST')
  assert.match(cleanupRequest.path, /mx-insight-hub-content-v1-000001,mx-insight-hub-content-v2-000001,mx-insight-hub-content-v3-current\/_delete_by_query/)
  assert.deepEqual(
    cleanupRequest.body.query.bool.should[0].bool.filter,
    [
      { ids: { values: [row.id] } },
      {
        bool: {
          should: [
            { range: { projectionRevision: { lte: 4 } } },
            { bool: { must_not: [{ exists: { field: 'projectionRevision' } }] } },
          ],
          minimum_should_match: 1,
        },
      },
    ],
  )
  assert.equal(bulkBody.length, 1)
  assert.equal(bulkBody[0].delete._index, backingIndices[3])
  assert.equal(bulkBody[0].delete.version, 4, 'the tombstone uses current PostgreSQL state')
  assert.equal(bulkBody[0].delete.version_type, 'external_gte')
})

test('projector turns a stale delete into the current restored document', async () => {
  const row = canonicalRow({ projection_revision: 5, deleted_at: null })
  const backingIndices = [
    'mx-insight-hub-content-v1-000001',
    'mx-insight-hub-content-v2-000001',
    'mx-insight-hub-content-v3-current',
    'mx-insight-hub-content-v4-current',
  ]
  let cleanupRequest = null
  let bulkBody = null
  const pool = fakePool([
    ["SET status = 'claimed'", () => ({
      rows: [{ id: 9, aggregate_id: row.id, event_type: 'delete', projection_revision: 4, attempts: 1 }],
    })],
    ['FROM core.canonical_records WHERE id = ANY', () => ({ rows: [row] })],
    ['INSERT INTO outbox.projection_runs', () => ({ rows: [{ id: 1 }] })],
    ["SET status = 'delivered'", () => ({ rows: [], rowCount: 1 })],
  ])
  const projector = new SearchProjector({
    pool,
    segmenter,
    indexSet: contentIndex(),
    logger: { log() {}, warn() {}, error() {} },
    client: {
      async getAlias(alias) {
        if (alias === 'mx-insight-hub-content-v4') {
          return {
            [backingIndices[3]]: {
              aliases: { [alias]: { is_write_index: true } },
            },
          }
        }
        return Object.fromEntries(backingIndices.map((index) => [index, { aliases: {} }]))
      },
      async request(method, path, body) {
        cleanupRequest = { method, path, body }
        return { deleted: 1, version_conflicts: 0, failures: [] }
      },
      async bulk(operations) {
        bulkBody = operations
        return { errors: false, items: [{ index: { _id: row.id, status: 200 } }] }
      },
    },
  })

  const result = await projector.projectBatch()
  assert.equal(result.delivered, 1)
  assert.equal(result.failed, 0)
  assert.match(cleanupRequest.path, /mx-insight-hub-content-v1-000001,mx-insight-hub-content-v2-000001,mx-insight-hub-content-v3-current\/_delete_by_query/)
  assert.equal(bulkBody.length, 2)
  assert.equal(bulkBody[0].index._index, backingIndices[3])
  assert.equal(bulkBody[0].index.version, 5)
  assert.equal(bulkBody[0].index.version_type, 'external')
  assert.equal(bulkBody[1].id, row.id)
})

test('projector emits one operation and delivers every event for one aggregate', async () => {
  const row = canonicalRow({ projection_revision: 5 })
  const delivered = []
  let bulkBody = null
  const pool = fakePool([
    ["SET status = 'claimed'", () => ({
      rows: [
        { id: 10, aggregate_id: row.id, event_type: 'upsert', projection_revision: 4, attempts: 1 },
        { id: 11, aggregate_id: row.id, event_type: 'upsert', projection_revision: 5, attempts: 1 },
      ],
    })],
    ['FROM core.canonical_records WHERE id = ANY', () => ({ rows: [row] })],
    ['INSERT INTO outbox.projection_runs', () => ({ rows: [{ id: 1 }] })],
    ["SET status = 'delivered'", (values) => {
      delivered.push(values[0])
      return { rows: [], rowCount: 2 }
    }],
  ])
  const projector = new SearchProjector({
    pool,
    segmenter,
    indexSet: contentIndex(),
    logger: { log() {}, warn() {}, error() {} },
    client: {
      async bulk(operations) {
        bulkBody = operations
        return { errors: false, items: [{ index: { _id: row.id, status: 200 } }] }
      },
    },
  })

  const result = await projector.projectBatch()
  assert.equal(result.claimed, 2)
  assert.equal(result.delivered, 2)
  assert.equal(result.failed, 0)
  assert.equal(bulkBody.length, 2, 'one bulk action plus one document body')
  assert.deepEqual(delivered, [[10, 11]])
})

test('projector emits a versioned delete when the canonical record no longer exists', async () => {
  const aggregateId = 'deadbeef-0000-4000-8000-000000000000'
  const delivered = []
  let bulkBody = null
  const pool = fakePool([
    ["SET status = 'claimed'", () => ({
      rows: [{ id: 12, aggregate_id: aggregateId, event_type: 'upsert', projection_revision: 6, attempts: 1 }],
    })],
    ['FROM core.canonical_records WHERE id = ANY', () => ({ rows: [] })],
    ['INSERT INTO outbox.projection_runs', () => ({ rows: [{ id: 1 }] })],
    ["SET status = 'delivered'", (values) => {
      delivered.push(values[0])
      return { rows: [], rowCount: 1 }
    }],
  ])
  const projector = new SearchProjector({
    pool,
    segmenter,
    indexSet: contentIndex(),
    logger: { log() {}, warn() {}, error() {} },
    client: {
      async bulk(operations) {
        bulkBody = operations
        return { errors: false, items: [{ delete: { _id: aggregateId, status: 404 } }] }
      },
    },
  })

  const result = await projector.projectBatch()
  assert.equal(result.delivered, 1)
  assert.equal(result.failed, 0)
  assert.deepEqual(delivered, [[12]])
  assert.equal(bulkBody[0].delete.version, 6)
  assert.equal(bulkBody[0].delete.version_type, 'external_gte')
})

test('projector failure transition is fenced by the current lease owner', async () => {
  const row = canonicalRow()
  const pool = fakePool([
    ["SET status = 'claimed'", () => ({
      rows: [{ id: 13, aggregate_id: row.id, event_type: 'upsert', projection_revision: 3, attempts: 1 }],
    })],
    ['FROM core.canonical_records WHERE id = ANY', () => ({ rows: [row] })],
    ['INSERT INTO outbox.projection_runs', () => ({ rows: [{ id: 1 }] })],
    ['SET status = $2', () => ({ rowCount: 1 })],
  ])
  const projector = new SearchProjector({
    pool,
    segmenter,
    indexSet: contentIndex(),
    logger: { log() {}, warn() {}, error() {} },
    client: {
      async bulk() {
        return {
          errors: true,
          items: [{ index: { _id: row.id, status: 400, error: { type: 'illegal_argument_exception' } } }],
        }
      },
    },
  })

  const result = await projector.projectBatch()
  assert.equal(result.delivered, 0)
  assert.equal(result.failed, 1)
  const failedUpdate = pool.queries.find(({ sql }) => sql.includes('SET status = $2'))
  assert.match(failedUpdate.sql, /status = 'claimed'/)
  assert.match(failedUpdate.sql, /locked_by = \$4/)
  assert.equal(failedUpdate.values[3], projector.workerId)
})

test('a worker that lost its lease cannot report another owner event as delivered', async () => {
  const row = canonicalRow()
  const pool = fakePool([
    ["SET status = 'claimed'", () => ({
      rows: [{ id: 14, aggregate_id: row.id, event_type: 'upsert', projection_revision: 3, attempts: 1 }],
    })],
    ['FROM core.canonical_records WHERE id = ANY', () => ({ rows: [row] })],
    ['INSERT INTO outbox.projection_runs', () => ({ rows: [{ id: 1 }] })],
    ["SET status = 'delivered'", () => ({ rowCount: 0 })],
  ])
  const projector = new SearchProjector({
    pool,
    segmenter,
    indexSet: contentIndex(),
    logger: { log() {}, warn() {}, error() {} },
    client: {
      async bulk() {
        return { items: [{ index: { _id: row.id, status: 200 } }] }
      },
    },
  })

  const result = await projector.projectBatch()
  assert.deepEqual(result, { claimed: 1, delivered: 0, failed: 0 })
  const finishedRun = pool.queries.find(({ sql }) => sql.includes('UPDATE outbox.projection_runs'))
  assert.equal(finishedRun.values[1], 0, 'audit count reflects the fenced transition, not the ES response')
})

test('projector returns the whole batch when the cluster is unreachable', async () => {
  const { ElasticsearchUnavailableError } = await import('@qpjoy/mx-common/elasticsearch')
  const released = []
  const pool = fakePool([
    ["SET status = 'claimed'", () => ({
      rows: [{ id: 11, aggregate_id: canonicalRow().id, event_type: 'upsert', projection_revision: 1, attempts: 1 }],
    })],
    ['FROM core.canonical_records WHERE id = ANY', () => ({ rows: [canonicalRow()] })],
    ['INSERT INTO outbox.projection_runs', () => ({ rows: [{ id: 1 }] })],
    ["SET status = 'pending', leased_until = NULL, locked_by = NULL,\n              attempts = GREATEST", (values) => {
      released.push(values)
      return { rows: [], rowCount: 1 }
    }],
  ])
  const projector = new SearchProjector({
    pool,
    segmenter,
    indexSet: contentIndex(),
    logger: { log() {}, warn() {}, error() {} },
    client: {
      bulk: async () => {
        throw new ElasticsearchUnavailableError(new Error('ECONNREFUSED'))
      },
    },
  })

  await assert.rejects(() => projector.projectBatch(), ElasticsearchUnavailableError)
  // An outage is not the events' fault; their attempt counter is rolled back so
  // a long outage cannot dead-letter a healthy backlog.
  assert.deepEqual(released[0], [[11], projector.workerId])
  const releaseUpdate = pool.queries.find(({ sql }) => sql.includes('attempts = GREATEST'))
  assert.match(releaseUpdate.sql, /status = 'claimed'/)
  assert.match(releaseUpdate.sql, /locked_by = \$2/)
})


test('an interrupted rebuild resumes from its cursor instead of discarding the partial index', async () => {
  const indexSet = contentIndex()
  const harness = currentIndexHarness(indexSet, {
    'mx-insight-hub-content-v3-current': { [indexSet.readAlias]: {} },
  })
  // The partial v4 index survived the interruption; it serves no alias.
  harness.client.indexExists = async (index) => index === indexSet.currentIndex
  const remaining = canonicalRow({ id: '44444444-4444-4444-8444-444444444444' })
  const snapshot = currentSnapshotPool('FROM core.canonical_records', [remaining], {
    rebuildProgress: {
      last_record_id: '11111111-1111-4111-8111-111111111111',
      processed: 120_000,
      build_started_at: new Date('2026-08-17T00:00:00.000Z'),
    },
  })
  const progress = []

  const result = await ensureCurrentContentIndex({
    client: harness.client,
    pool: snapshot.pool,
    segmenter,
    indexSet,
    logger: { log() {}, info() {}, warn() {} },
    onProgress: async (event) => progress.push(event),
  })

  assert.equal(result.rebuilt, true)
  // The hours already spent are not thrown away.
  assert.equal(harness.calls.creates.length, 0, 'a resumable partial index is never recreated')
  const scans = snapshot.queries.filter((entry) => entry.sql.includes('FROM core.canonical_records'))
  assert.equal(
    scans[0].values[0],
    '11111111-1111-4111-8111-111111111111',
    'the build pass restarts after the last durably indexed record',
  )
  // Progress continues from the recorded count rather than resetting to zero.
  assert.equal(progress[0].processed, 120_001)
  // The catch-up watermark is the original build start, not this attempt's.
  assert.equal(scans.at(-1).values[2].toISOString(), '2026-08-17T00:00:00.000Z')
})

test('a partial index with no recorded cursor is still rebuilt from scratch', async () => {
  const indexSet = contentIndex()
  const harness = currentIndexHarness(indexSet, {
    'mx-insight-hub-content-v3-current': { [indexSet.readAlias]: {} },
  })
  let deleted = null
  harness.client.indexExists = async (index) => index === indexSet.currentIndex
  harness.client.request = async (method, path, body) => {
    if (method === 'DELETE') { deleted = path; return { acknowledged: true } }
    assert.equal(path, '/_aliases')
    for (const action of body.actions) void action
    return { acknowledged: true }
  }
  const snapshot = currentSnapshotPool('FROM core.canonical_records', [canonicalRow()])

  await ensureCurrentContentIndex({
    client: harness.client,
    pool: snapshot.pool,
    segmenter,
    indexSet,
    logger: { log() {}, info() {}, warn() {} },
  })

  // Unknown provenance: the snapshot could be partial in ways nothing recorded.
  assert.equal(deleted, `/${indexSet.currentIndex}`)
  assert.equal(harness.calls.creates[0].index, indexSet.currentIndex)
})

test('segmentation is memoised across records, passes and projections', async () => {
  let calls = 0
  const counting = {
    async segmentWithMeta(text) {
      calls += 1
      return { tokens: [String(text)], backendUsed: 'hanlp', degraded: false, errorCode: null }
    },
    async segment(text) { return (await this.segmentWithMeta(text)).tokens },
  }
  const cached = cachingSegmenter(counting)

  assert.deepEqual(await cached.segment('吴恩达'), ['吴恩达'])
  assert.deepEqual(await cached.segment('吴恩达'), ['吴恩达'])
  assert.deepEqual((await cached.segmentWithMeta('吴恩达')).tokens, ['吴恩达'])
  // Repeating a HanLP round trip for identical input is the dominant waste in a
  // rebuild; author names and chat titles repeat across every message.
  assert.equal(calls, 1)

  await cached.segment('人工智能')
  assert.equal(calls, 2)
  assert.equal(cached.stats().size, 2)
})


test('batch segmentation runs concurrently, in order, and never outruns its limit', async () => {
  let inFlight = 0
  let peak = 0
  const order = []
  const items = Array.from({ length: 12 }, (unused, index) => index)

  const results = await mapWithConcurrency(items, 4, async (item) => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    // Reverse the durations so completion order differs from input order.
    await new Promise((resolve) => setTimeout(resolve, (12 - item) % 5))
    order.push(item)
    inFlight -= 1
    return item * 2
  })

  // Order is load-bearing: the bulk body pairs each action line with the
  // document line after it, so a shuffled result would mis-attach documents.
  assert.deepEqual(results, items.map((item) => item * 2))
  assert.notDeepEqual(order, items, 'the work really did overlap')
  // Concurrency above the tokenizer's slot count only manufactures 429s.
  assert.ok(peak > 1, 'work overlapped')
  assert.ok(peak <= 4, `limit exceeded: ${peak}`)
})

test('a concurrency of one is exactly the previous serial behaviour', async () => {
  let peak = 0
  let inFlight = 0
  const results = await mapWithConcurrency([1, 2, 3], 1, async (item) => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 1))
    inFlight -= 1
    return item
  })
  assert.deepEqual(results, [1, 2, 3])
  assert.equal(peak, 1)
})
