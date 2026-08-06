import assert from 'node:assert/strict'
import test from 'node:test'
import { fallbackSegment } from '@qpjoy/mx-common/segmenter'
import { ensureIndexSet } from '@qpjoy/mx-common/elasticsearch'
import { contentIndex, chunkIndex } from '../../server/search/index-definitions.mjs'
import { buildContentDocument } from '../../server/search/document.mjs'
import { authorNameQuery } from '../../server/search/queries.mjs'
import { SearchProjector } from '../../server/search/projector.mjs'

const segmenter = { segment: async (text) => fallbackSegment(text) }

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

// ---------------------------------------------------------------------------
// Index definitions
// ---------------------------------------------------------------------------

test('content index derives read alias, write alias and bootstrap index', () => {
  const definition = contentIndex()
  assert.equal(definition.readAlias, 'mx-insight-hub-content')
  assert.equal(definition.writeAlias, 'mx-insight-hub-content-v1')
  assert.equal(definition.bootstrapIndex, 'mx-insight-hub-content-v1-000001')
  assert.equal(definition.settings['index.lifecycle.rollover_alias'], 'mx-insight-hub-content-v1')
})

test('content mapping carries the author fields the projector writes', () => {
  const { properties } = contentIndex().mappings
  // The original template had no author fields at all, which under
  // `dynamic: strict` would have rejected every document.
  assert.ok(properties.authorName, 'authorName is mapped')
  assert.ok(properties.authorName.fields.keyword, 'exact match sub-field')
  assert.ok(properties.authorName.fields.prefix, 'prefix sub-field')
  assert.ok(properties.authorName.fields.bigram, 'CJK bigram sub-field')
  assert.equal(properties.authorExternalId.type, 'keyword')
})

test('chunk index is not created without configured embedding dimensions', () => {
  assert.equal(chunkIndex({ dimensions: null }), null)
  const withDims = chunkIndex({ dimensions: 1024 })
  assert.equal(withDims.mappings.properties.embedding.dims, 1024)
  assert.equal(withDims.mappings.properties.embedding.index, true)
})

test('ensureIndexSet bootstraps a write index when the alias is absent', async () => {
  const calls = []
  const client = {
    putIlmPolicy: async (name) => calls.push(['ilm', name]),
    putIndexTemplate: async (name) => calls.push(['template', name]),
    aliasExists: async () => false,
    createIndex: async (index, body) => {
      calls.push(['create', index])
      assert.equal(body.aliases['mx-insight-hub-content-v1'].is_write_index, true)
      return { acknowledged: true }
    },
    putMapping: async () => assert.fail('must not patch mappings on a fresh alias'),
  }
  const result = await ensureIndexSet(client, contentIndex(), { logger: { info() {} } })
  assert.equal(result.createdBootstrapIndex, true)
  assert.deepEqual(calls.map(([kind]) => kind), ['ilm', 'template', 'create'])
})

test('ensureIndexSet reports an incompatible mapping change instead of throwing', async () => {
  const client = {
    putIlmPolicy: async () => {},
    putIndexTemplate: async () => {},
    aliasExists: async () => true,
    createIndex: async () => assert.fail('existing alias must not be recreated'),
    putMapping: async () => {
      const error = new Error('mapper conflict')
      error.status = 400
      error.body = { error: { reason: 'mapper [title] cannot be changed' } }
      Object.setPrototypeOf(error, (await import('@qpjoy/mx-common/elasticsearch')).ElasticsearchError.prototype)
      throw error
    },
  }
  const result = await ensureIndexSet(client, contentIndex(), { logger: { warn() {} } })
  assert.match(result.mappingConflict, /cannot be changed/)
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
  assert.equal(document.projectionRevision, 3)
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

test('author query avoids wildcard and fuzzy, ranking exact matches first', () => {
  const query = authorNameQuery('搬运工', fallbackSegment('搬运工'))
  const serialized = JSON.stringify(query)
  assert.ok(!serialized.includes('"wildcard"'), 'no wildcard clause')
  assert.ok(!serialized.includes('"fuzzy"'), 'no fuzzy clause')
  const exact = query.bool.should.find((clause) => clause.term?.['authorName.keyword'])
  assert.equal(exact.term['authorName.keyword'].boost, 10)
})

// ---------------------------------------------------------------------------
// Projector
// ---------------------------------------------------------------------------

function fakePool(handlers) {
  return {
    queries: [],
    async query(sql, values) {
      this.queries.push(sql)
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
})

test('projector retires an event whose canonical record no longer exists', async () => {
  const failures = []
  const pool = fakePool([
    ["SET status = 'claimed'", () => ({
      rows: [{ id: 9, aggregate_id: 'deadbeef-0000-4000-8000-000000000000', event_type: 'upsert', projection_revision: 1, attempts: 1 }],
    })],
    ['FROM core.canonical_records WHERE id = ANY', () => ({ rows: [] })],
    ['INSERT INTO outbox.projection_runs', () => ({ rows: [{ id: 1 }] })],
    ['SET status = $2', (values) => {
      failures.push(values)
      return { rows: [], rowCount: 1 }
    }],
  ])
  const projector = new SearchProjector({
    pool,
    segmenter,
    indexSet: contentIndex(),
    logger: { log() {}, warn() {}, error() {} },
    client: { bulk: async () => assert.fail('nothing to index') },
  })

  const result = await projector.projectBatch()
  assert.equal(result.failed, 1)
  // Retried forever it would never succeed, so it goes straight to the dead
  // letter rather than cycling through the retry budget first.
  assert.equal(failures[0][1], 'dead')
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
  assert.deepEqual(released[0], [[11]])
})
