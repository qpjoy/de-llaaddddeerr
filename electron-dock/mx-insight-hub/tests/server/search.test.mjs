import assert from 'node:assert/strict'
import test from 'node:test'
import { fallbackSegment } from '@qpjoy/mx-common/segmenter'
import { ElasticsearchError, ElasticsearchUnavailableError } from '@qpjoy/mx-common/elasticsearch'
import { contentIndex, chunkIndex } from '../../server/search/index-definitions.mjs'
import { ensureCurrentChunkIndex, ensureCurrentContentIndex } from '../../server/search/index.mjs'
import { buildContentDocument } from '../../server/search/document.mjs'
import { authorNameQuery, SearchQueries } from '../../server/search/queries.mjs'
import { SearchProjector } from '../../server/search/projector.mjs'
import { purgeStaleCurrentStateCopies } from '../../server/search/current-state.mjs'

const segmenter = { segment: async (text) => fallbackSegment(text) }

function searchHit(id, score, eventTime, shardDoc = 0) {
  return {
    _id: id,
    _score: score,
    sort: [score, eventTime, id, shardDoc],
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
  assert.equal(result.items.length, 2)
  assert.equal(result.hasMore, true)
  assert.equal(result.totalRelation, 'gte')
  assert.deepEqual(result.nextCursor, {
    mode: 'elasticsearch',
    pitId: 'pit-renewed',
    searchAfter: hits[1].sort,
  })
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
  assert.equal(captured.values[9], '33333333-3333-4333-8333-333333333333')
  assert.equal(captured.values[10], null)
  assert.equal(result.hasMore, true)
  assert.deepEqual(result.nextCursor.searchAfter, [null, rows[0].id])
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
  assert.equal(definition.writeAlias, 'mx-insight-hub-content-v3')
  assert.equal(definition.currentIndex, 'mx-insight-hub-content-v3-current')
  assert.equal(definition.bootstrapIndex, definition.currentIndex)
  assert.equal(definition.settings['index.lifecycle.name'], undefined)
  assert.equal(definition.settings['index.lifecycle.rollover_alias'], undefined)
})

test('content mapping carries the author fields the projector writes', () => {
  const { properties } = contentIndex().mappings
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
  assert.equal(properties.authorHandleSubstring.type, 'wildcard')
  assert.equal(properties.chatId.type, 'keyword')
  assert.equal(properties.replyToMessageId.type, 'keyword')
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
  const calls = { templates: [], creates: [], bulks: [], aliasActions: [] }
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

function currentSnapshotPool(matchSql, rows, { deletions = [] } = {}) {
  const queries = []
  let released = false
  const connection = {
    async query(sql, values) {
      queries.push({ sql, values })
      if (sql.includes(matchSql)) return { rows }
      if (sql.includes('FROM core.chunk_projection_deletes')) return { rows: deletions }
      return { rows: [], rowCount: 0 }
    },
    release() { released = true },
  }
  return {
    pool: { async connect() { return connection } },
    queries,
    get released() { return released },
  }
}

test('content current index atomically replaces v1/v2 read memberships with v3 PostgreSQL truth', async () => {
  const indexSet = contentIndex()
  const oldV1 = 'mx-insight-hub-content-v1-000001'
  const oldV2 = 'mx-insight-hub-content-v2-000001'
  const harness = currentIndexHarness(indexSet, {
    [oldV1]: { [indexSet.readAlias]: {}, 'mx-insight-hub-content-v1': { is_write_index: true } },
    [oldV2]: { [indexSet.readAlias]: {}, 'mx-insight-hub-content-v2': { is_write_index: true } },
  })
  const live = canonicalRow()
  const deleted = canonicalRow({
    id: '22222222-2222-4222-8222-222222222222',
    projection_revision: 4,
    deleted_at: new Date('2026-08-10T00:00:00.000Z'),
  })
  const snapshot = currentSnapshotPool('FROM core.canonical_records', [live, deleted])

  const result = await ensureCurrentContentIndex({
    client: harness.client,
    pool: snapshot.pool,
    segmenter,
    indexSet,
    logger: { info() {}, warn() {} },
  })

  assert.equal(result.rebuilt, true)
  assert.equal(result.currentIndex, 'mx-insight-hub-content-v3-current')
  assert.equal(harness.calls.templates.length, 1)
  assert.equal(harness.calls.templates[0].body.template.aliases, undefined, 'partial rebuild is never exposed by a template alias')
  assert.equal(harness.calls.templates[0].body.template.settings['index.lifecycle.name'], undefined)
  assert.equal(harness.calls.creates[0].index, indexSet.currentIndex)
  assert.equal(harness.calls.bulks.length, 2, 'snapshot is replayed after the alias cutover')
  assert.equal(harness.calls.bulks[0][0].index.version_type, 'external_gte')
  assert.equal(harness.calls.bulks[0][2].delete.version_type, 'external_gte')

  assert.equal(harness.calls.aliasActions.length, 1, 'all aliases move in one cluster-state update')
  const actions = harness.calls.aliasActions[0]
  assert.ok(actions.some(({ remove }) => remove?.index === oldV1 && remove.alias === indexSet.readAlias))
  assert.ok(actions.some(({ remove }) => remove?.index === oldV2 && remove.alias === indexSet.readAlias))
  assert.ok(actions.some(({ add }) => add?.index === indexSet.currentIndex && add.alias === 'mx-insight-hub-content-v1'))
  assert.deepEqual(Object.keys(harness.aliasResponse(indexSet.readAlias)), [indexSet.currentIndex])
  assert.ok(snapshot.queries.some(({ sql }) => sql.includes('pg_advisory_lock')))
  assert.ok(snapshot.queries.some(({ sql }) => sql.includes('pg_advisory_unlock')))
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
  assert.equal(action.index.version_type, 'external')
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
        noteRank: 4,
      },
    }),
    { segmenter },
  )
  assert.deepEqual(Object.keys(document.extensions), ['noteRank'])
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
        if (alias === 'mx-insight-hub-content-v3') {
          return {
            [backingIndices[2]]: {
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
  assert.match(cleanupRequest.path, /mx-insight-hub-content-v1-000001,mx-insight-hub-content-v2-000001\/_delete_by_query/)
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
  assert.equal(bulkBody[0].delete._index, backingIndices[2])
  assert.equal(bulkBody[0].delete.version, 4, 'the tombstone uses current PostgreSQL state')
  assert.equal(bulkBody[0].delete.version_type, 'external_gte')
})

test('projector turns a stale delete into the current restored document', async () => {
  const row = canonicalRow({ projection_revision: 5, deleted_at: null })
  const backingIndices = [
    'mx-insight-hub-content-v1-000001',
    'mx-insight-hub-content-v2-000001',
    'mx-insight-hub-content-v3-current',
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
        if (alias === 'mx-insight-hub-content-v3') {
          return {
            [backingIndices[2]]: {
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
  assert.match(cleanupRequest.path, /mx-insight-hub-content-v1-000001,mx-insight-hub-content-v2-000001\/_delete_by_query/)
  assert.equal(bulkBody.length, 2)
  assert.equal(bulkBody[0].index._index, backingIndices[2])
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
