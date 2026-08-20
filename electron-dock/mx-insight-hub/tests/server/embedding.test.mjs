import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { ElasticsearchUnavailableError } from '@qpjoy/mx-common/elasticsearch'
import { CHUNKER_VERSION, chunkRecord, chunkText, estimateTokens } from '../../server/embedding/chunker.mjs'
import { buildChunkDocument } from '../../server/embedding/document.mjs'
import { EmbeddingPipeline } from '../../server/embedding/pipeline.mjs'
import { reciprocalRankFusion } from '../../server/search/queries.mjs'
import { requireSegmenterBackend } from '../../server/search/reindex-integrity.mjs'

const quiet = { log() {}, warn() {}, error() {} }

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

test('token estimation treats CJK as one token per character', () => {
  // A per-provider tokenizer would add a dependency and a failover hazard for
  // no retrieval benefit; the size only needs to be in the right neighbourhood.
  assert.equal(estimateTokens('中文八个字符啊哈'), 8)
  assert.equal(estimateTokens('hello world'), 3)
  assert.equal(estimateTokens(''), 0)
})

test('chunking is deterministic', () => {
  const text = Array.from({ length: 30 }, (_, i) => `第${i}句讲述人工智能与检索增强生成的关系。`).join('')
  // The chunk key is (record_id, chunk_index, chunker_version); non-determinism
  // would orphan rows on every re-chunk.
  assert.deepEqual(chunkText(text), chunkText(text))
})

test('chunks split on sentence boundaries, not mid-sentence', () => {
  const text = Array.from({ length: 40 }, (_, i) => `这是第${i}个句子，内容足够长以便触发切分。`).join('')
  const chunks = chunkText(text)
  assert.ok(chunks.length > 1, 'long text is split')
  for (const chunk of chunks) {
    assert.ok(chunk.length > 0)
    assert.equal(chunk, chunk.trim())
  }
})

test('consecutive chunks overlap so a boundary sentence stays retrievable', () => {
  const sentences = Array.from({ length: 40 }, (_, i) => `句子编号${i}描述了一个独立的事实。`)
  const chunks = chunkText(sentences.join(''))
  assert.ok(chunks.length >= 2)
  const tail = chunks[0].slice(-12)
  assert.ok(chunks[1].includes(tail.slice(0, 8)), 'the second chunk carries the first chunk\'s tail')
})

test('a single oversized sentence is emitted whole rather than cut', () => {
  const giant = `${'长'.repeat(900)}。`
  const chunks = chunkText(giant)
  // A chunk that starts and ends mid-sentence embeds poorly; one oversized
  // chunk costs less than several truncated ones.
  assert.equal(chunks.length, 1)
})

test('empty or whitespace-only text yields no chunks', () => {
  assert.deepEqual(chunkText(''), [])
  assert.deepEqual(chunkText('   \n\n  '), [])
})

test('the title is folded into the first chunk, not emitted alone', () => {
  const chunks = chunkRecord({ title: '建议都去学吴恩达的AI Agent', body: '正文内容。'.repeat(40), current_revision: 2 })
  // A title alone is usually too short to embed meaningfully, but it is exactly
  // the context that disambiguates the opening of the body.
  assert.ok(chunks[0].content.startsWith('建议都去学吴恩达的AI Agent'))
  assert.equal(chunks[0].sourceRevision, 2)
  assert.equal(chunks[0].chunkerVersion, CHUNKER_VERSION)
})

test('a title-only record still produces a chunk', () => {
  const chunks = chunkRecord({ title: '只有标题的记录', body: null, current_revision: 1 })
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].content, '只有标题的记录')
})

// ---------------------------------------------------------------------------
// Pipeline staging
// ---------------------------------------------------------------------------

test('chunk projection failure migration adds only narrow durable quarantine columns', async () => {
  const sql = await readFile(
    new URL('../../migrations/032_chunk_projection_failures.sql', import.meta.url),
    'utf8',
  )
  assert.match(sql, /ADD COLUMN IF NOT EXISTS projection_attempts integer NOT NULL DEFAULT 0/)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS projection_last_error text/)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS projection_failed_at timestamptz/)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS aliases_switched_at timestamptz/)
  assert.doesNotMatch(sql, /CREATE INDEX/, 'the deploy migration must not scan or lock the live chunk table for an index build')
  assert.doesNotMatch(sql, /CHECK\s*\(/, 'adding a validated CHECK would scan the live chunk table under ALTER TABLE lock')
})

test('chunk document construction is pure and carries the searchable revision', () => {
  const row = {
    id: 'c1',
    record_id: 'r1',
    chunk_index: 2,
    dataset_id: 'telegram.monitor.messages.v1',
    platform: 'telegram',
    external_id: '-1001:42',
    url: 'https://t.me/example/42',
    title: '标题',
    content: '人工智能内容',
    vector: [0.1, 0.2],
    embedding_model: 'openai:text-embedding-3-small',
    embedding_version: 1,
    chunker_version: CHUNKER_VERSION,
    source_revision: '7',
    event_time: new Date('2026-08-10T00:00:00.000Z'),
  }
  const tokens = ['人工智能', '内容']
  const rowBefore = structuredClone(row)
  const tokensBefore = [...tokens]
  const options = { tokens, createdAt: '2026-08-10T01:00:00.000Z' }

  const first = buildChunkDocument(row, options)
  const second = buildChunkDocument(row, options)

  assert.deepEqual(first, {
    id: 'c1',
    recordId: 'r1',
    chunkIndex: 2,
    datasetId: 'telegram.monitor.messages.v1',
    platform: 'telegram',
    externalId: '-1001:42',
    url: 'https://t.me/example/42',
    title: '标题',
    content: '人工智能内容',
    contentHanlp: '人工智能 内容',
    embedding: [0.1, 0.2],
    embeddingModel: 'openai:text-embedding-3-small',
    embeddingVersion: 1,
    chunkerVersion: CHUNKER_VERSION,
    sourceRevision: 7,
    eventTime: new Date('2026-08-10T00:00:00.000Z'),
    createdAt: '2026-08-10T01:00:00.000Z',
  })
  assert.deepEqual(second, first)
  assert.deepEqual(row, rowBefore)
  assert.deepEqual(tokens, tokensBefore)
})

function fakePool(handlers) {
  const client = {
    queries: [],
    async query(sql, values) {
      client.queries.push({ sql, values })
      for (const [pattern, handler] of handlers) {
        if (sql.includes(pattern)) return handler(values)
      }
      return { rows: [], rowCount: 0 }
    },
    release() {},
  }
  return { client, query: client.query, connect: async () => client }
}

test('re-chunking a changed record deletes the chunks it no longer reaches', async () => {
  const deletes = []
  const queued = []
  const pool = fakePool([
    ['AND NOT EXISTS (', () => ({
      rows: [{ id: 'r1', title: '标题', body: '短正文。'.repeat(8), current_revision: 5 }],
    })],
    ['AND (r.deleted_at IS NOT NULL', () => ({ rows: [] })],
    ['FOR UPDATE', () => ({
      rows: [{ current_revision: 5, deleted_at: null, text_length: 100 }],
    })],
    ['INSERT INTO core.chunk_projection_deletes', (values) => {
      queued.push(values)
      return { rowCount: 3 }
    }],
    ['DELETE FROM core.record_chunks', (values) => {
      deletes.push(values)
      return { rowCount: 3 }
    }],
    ['INSERT INTO core.record_chunks', () => ({ rowCount: 1 })],
  ])
  const pipeline = new EmbeddingPipeline({ pool, logger: quiet })
  const result = await pipeline.materializeChunks()

  assert.equal(result.records, 1)
  assert.equal(result.removed, 3)
  assert.equal(result.deletionsQueued, 3)
  assert.deepEqual(queued[0], ['r1', 5, CHUNKER_VERSION, result.chunks])
  const materializeQuery = pool.client.queries.find(({ sql }) => sql.includes('AND NOT EXISTS ('))
  assert.match(materializeQuery.sql, /c\.chunker_version = \$2/)
  const queueQuery = pool.client.queries.find(({ sql }) => sql.includes('INSERT INTO core.chunk_projection_deletes'))
  assert.match(queueQuery.sql, /c\.chunker_version <> \$3/)
  assert.match(queueQuery.sql, /c\.chunk_index >= \$4/)
  const [recordId, chunkerVersion, revision, newCount] = deletes[0]
  assert.equal(recordId, 'r1')
  assert.equal(chunkerVersion, CHUNKER_VERSION)
  assert.equal(revision, 5)
  // An edit that shortens a record must not leave its extra chunks behind, or
  // retrieval keeps serving text the source no longer contains.
  assert.equal(newCount, result.chunks)
  const upsert = pool.client.queries.find(({ sql }) => sql.includes('INSERT INTO core.record_chunks AS existing'))
  assert.match(upsert.sql, /existing\.source_revision IS DISTINCT FROM EXCLUDED\.source_revision/)
  assert.match(upsert.sql, /existing\.content IS DISTINCT FROM EXCLUDED\.content/)
  assert.match(upsert.sql, /projection_attempts = 0/)
  assert.match(upsert.sql, /projection_failed_at = NULL/)
})

test('tombstoned and too-short records queue every chunk document before removing PostgreSQL rows', async () => {
  const queued = []
  const deletes = []
  const pool = fakePool([
    ['AND NOT EXISTS (', () => ({ rows: [] })],
    ['AND (r.deleted_at IS NOT NULL', () => ({
      rows: [
        { id: 'r-deleted', current_revision: 9 },
        { id: 'r-short', current_revision: 6 },
      ],
    })],
    ['FOR UPDATE', ([recordId]) => ({
      rows: [{
        current_revision: recordId === 'r-deleted' ? 9 : 6,
        deleted_at: recordId === 'r-deleted' ? new Date('2026-08-10T00:00:00.000Z') : null,
        text_length: recordId === 'r-deleted' ? 100 : 8,
      }],
    })],
    ['INSERT INTO core.chunk_projection_deletes', (values) => {
      queued.push(values)
      return { rowCount: 4 }
    }],
    ['DELETE FROM core.record_chunks WHERE record_id', (values) => {
      deletes.push(values)
      return { rowCount: 4 }
    }],
  ])
  const pipeline = new EmbeddingPipeline({ pool, logger: quiet })
  const result = await pipeline.materializeChunks()

  assert.deepEqual(result, { records: 2, chunks: 0, removed: 8, deletionsQueued: 8 })
  // NULL chunker/count means every historical chunk id is copied to the durable
  // delete queue; only then are the authoritative chunk rows removed.
  assert.deepEqual(queued, [
    ['r-deleted', 9, null, null],
    ['r-short', 6, null, null],
  ])
  assert.deepEqual(deletes, [['r-deleted'], ['r-short']])
  const queueQuery = pool.client.queries.find(({ sql }) => sql.includes('INSERT INTO core.chunk_projection_deletes'))
  const deleteQuery = pool.client.queries.find(({ sql }) => sql.includes('DELETE FROM core.record_chunks WHERE record_id'))
  assert.ok(pool.client.queries.indexOf(queueQuery) < pool.client.queries.indexOf(deleteQuery))
  const retiredQuery = pool.client.queries.find(({ sql }) => sql.includes('AND (r.deleted_at IS NOT NULL'))
  assert.match(retiredQuery.sql, /coalesce\(length\(r\.body\), 0\).*< 24/s)
})

test('a stale materialization selection cannot overwrite a newer canonical revision', async () => {
  const pool = fakePool([
    ['AND NOT EXISTS (', () => ({
      rows: [{ id: 'r1', title: 'old', body: 'old body'.repeat(8), current_revision: 4 }],
    })],
    ['AND (r.deleted_at IS NOT NULL', () => ({ rows: [] })],
    ['FOR UPDATE', () => ({
      rows: [{ current_revision: 5, deleted_at: null, text_length: 100 }],
    })],
  ])
  const pipeline = new EmbeddingPipeline({ pool, logger: quiet })

  const result = await pipeline.materializeChunks()
  assert.deepEqual(result, { records: 0, chunks: 0, removed: 0, deletionsQueued: 0 })
  assert.equal(
    pool.client.queries.some(({ sql }) => sql.includes('DELETE FROM core.record_chunks')),
    false,
  )
  assert.equal(
    pool.client.queries.some(({ sql }) => sql.includes('INSERT INTO core.record_chunks')),
    false,
  )
})

test('embedding stage stops when no provider is configured', async () => {
  const pipeline = new EmbeddingPipeline({
    pool: fakePool([]),
    agent: { embeddings: { available: false } },
    logger: quiet,
  })
  const result = await pipeline.embedPending()
  assert.equal(result.embedded, 0)
  assert.match(result.skipped, /no embedding provider/)
})

test('a vector is stored in PostgreSQL so re-indexing never re-pays the model', async () => {
  const updates = []
  const pool = fakePool([
    ['FROM core.record_chunks', () => ({ rows: [{ id: 'c1', content: 'hello', source_revision: 5 }] })],
    ['UPDATE core.record_chunks', (values) => {
      updates.push(values)
      return { rowCount: 1 }
    }],
  ])
  const pipeline = new EmbeddingPipeline({
    pool,
    agent: {
      embeddings: { available: true },
      embed: async () => ({ provider: 'deepseek', model: 'embed-v1', vectors: [[0.1, 0.2]], attempts: [] }),
    },
    logger: quiet,
  })
  const result = await pipeline.embedPending()
  assert.equal(result.embedded, 1)
  assert.equal(result.provider, 'deepseek')
  const [, model, vector, sourceRevision] = updates[0]
  assert.equal(model, 'deepseek:embed-v1')
  assert.deepEqual(vector, [0.1, 0.2])
  assert.equal(sourceRevision, 5)
  const update = pool.client.queries.find(({ sql }) => sql.includes('SET embedding_model'))
  assert.match(update.sql, /source_revision = \$4/)
  assert.match(update.sql, /embedded_at IS NULL/)
})

test('an embedding response cannot attach an old vector to a newer chunk revision', async () => {
  const pool = fakePool([
    ['FROM core.record_chunks', () => ({
      rows: [{ id: 'c1', content: 'old content', source_revision: 4 }],
    })],
    ['UPDATE core.record_chunks', () => ({ rowCount: 0 })],
  ])
  const pipeline = new EmbeddingPipeline({
    pool,
    agent: {
      embeddings: { available: true },
      embed: async () => ({ provider: 'deepseek', model: 'embed-v1', vectors: [[0.1]], attempts: [] }),
    },
    logger: quiet,
  })

  const result = await pipeline.embedPending()
  assert.equal(result.embedded, 0, 'the row changed revision while the model call was in flight')
  const update = pool.client.queries.find(({ sql }) => sql.includes('SET embedding_model'))
  assert.deepEqual(update.values, ['c1', 'deepseek:embed-v1', [0.1], 4])
})

test('a permanently rejected chunk spends its durable budget without blocking successful rows', async () => {
  const marked = []
  const failures = []
  const pool = fakePool([
    ['FROM core.record_chunks c', () => ({
      rows: [
        { id: 'c1', record_id: 'r1', chunk_index: 0, content: 'a', chunker_version: CHUNKER_VERSION, source_revision: 3, vector: [1] },
        { id: 'c2', record_id: 'r1', chunk_index: 1, content: 'b', chunker_version: CHUNKER_VERSION, source_revision: 3, vector: [2] },
      ],
    })],
    ['SET projected_at = now()', (values) => {
      marked.push(values)
      return { rowCount: 1 }
    }],
    ['SET projection_attempts = chunk.projection_attempts + 1', (values) => {
      failures.push(values)
      return { rowCount: 1, rows: [{ projection_failed_at: null }] }
    }],
  ])
  const pipeline = new EmbeddingPipeline({
    pool,
    agent: { embeddings: { available: true } },
    segmenter: { segment: async () => ['a'] },
    chunkIndexSet: { readAlias: 'mx-insight-hub-chunks', writeAlias: 'mx-insight-hub-chunk-v1' },
    client: {
      bulk: async () => ({
        items: [{ index: {} }, { index: { error: { type: 'mapper_parsing_exception' } } }],
      }),
    },
    logger: quiet,
  })

  const result = await pipeline.projectPending()
  assert.equal(result.projected, 1)
  assert.equal(result.failed, 1)
  // The vector is already paid for and stored. A permanent mapper poison gets
  // a bounded projection budget rather than occupying the queue forever.
  assert.deepEqual(marked[0], [['c1'], [3]])
  assert.deepEqual(failures[0].slice(0, 2), ['c2', 3])
  const acknowledgement = pool.client.queries.find(({ sql }) => sql.includes('SET projected_at = now()'))
  assert.match(acknowledgement.sql, /chunk\.source_revision = done\.source_revision/)
})

test('chunk projection waits for the required tokenizer and resumes without recomputing its vector', async () => {
  let hanlpReady = false
  let bulkCalls = 0
  const row = {
    id: 'c1', record_id: 'r1', chunk_index: 0, content: '人工智能内容',
    chunker_version: CHUNKER_VERSION, source_revision: 3, vector: [1],
  }
  const pool = fakePool([
    ['FROM core.record_chunks c', () => ({ rows: [row] })],
    ['FROM control.search_rebuild_progress', () => ({ rows: [{ segmenter_backend: 'hanlp' }] })],
    ['SET projected_at = now()', () => ({ rowCount: 1 })],
  ])
  const strict = requireSegmenterBackend({
    async segmentWithMeta(text) {
      return hanlpReady
        ? { tokens: [String(text)], backendUsed: 'hanlp', degraded: false, errorCode: null }
        : { tokens: ['jieba'], backendUsed: 'jieba', degraded: true, errorCode: 'hanlp_timeout' }
    },
  }, {
    expectedBackend: 'hanlp',
    maxAttempts: 1,
    logger: quiet,
  })
  const pipeline = new EmbeddingPipeline({
    pool,
    agent: { embeddings: { available: true } },
    segmenter: strict,
    chunkIndexSet: { readAlias: 'mx-insight-hub-chunks', writeAlias: 'mx-insight-hub-chunk-v1' },
    client: {
      async bulk() {
        bulkCalls += 1
        return { items: [{ index: { status: 200 } }] }
      },
    },
    logger: quiet,
  })

  await assert.rejects(
    () => pipeline.projectPending(),
    (error) => error?.code === 'reindex_segmenter_degraded',
  )
  assert.equal(bulkCalls, 0)
  assert.equal(
    pool.client.queries.some(({ sql }) => sql.includes('SET projected_at = now()')),
    false,
  )
  assert.equal(
    pool.client.queries.some(({ sql }) => sql.includes('SET projection_attempts')),
    false,
    'a shared HanLP outage never spends the durable poison budget',
  )

  hanlpReady = true
  const recovered = await pipeline.projectPending()
  assert.deepEqual(recovered, { projected: 1, failed: 0 })
  assert.equal(bulkCalls, 1)
  assert.equal(
    pool.client.queries.filter(({ sql }) => sql.includes('SET projected_at = now()')).length,
    1,
  )
})

test('a mixed transient Elasticsearch bulk acknowledges successes before backing off', async () => {
  const marked = []
  const pool = fakePool([
    ['FROM core.record_chunks c', () => ({ rows: [
      { id: 'c1', record_id: 'r1', chunk_index: 0, content: 'a', chunker_version: CHUNKER_VERSION, source_revision: 3, vector: [1] },
      { id: 'c2', record_id: 'r2', chunk_index: 0, content: 'b', chunker_version: CHUNKER_VERSION, source_revision: 4, vector: [2] },
    ] })],
    ['SET projected_at = now()', (values) => {
      marked.push(values)
      return { rowCount: 1 }
    }],
  ])
  const pipeline = new EmbeddingPipeline({
    pool,
    agent: { embeddings: { available: true } },
    segmenter: { segment: async (text) => [text] },
    chunkIndexSet: { readAlias: 'mx-insight-hub-chunks', writeAlias: 'mx-insight-hub-chunk-v1' },
    client: {
      async bulk() {
        return { items: [
          { index: { status: 200 } },
          { index: { status: 429, error: { type: 'es_rejected_execution_exception' } } },
        ] }
      },
    },
    logger: quiet,
  })

  await assert.rejects(
    () => pipeline.projectPending(),
    (error) => error instanceof ElasticsearchUnavailableError,
  )
  assert.deepEqual(marked, [[['c1'], [3]]])
  assert.equal(
    pool.client.queries.some(({ sql }) => sql.includes('SET projection_attempts')),
    false,
    '429 is a shared transient failure and never spends the poison budget',
  )
})

test('chunk projection durably budgets a permanent poison and still indexes healthy rows', async () => {
  let operations = null
  const poison = {
    id: '11111111-1111-4111-8111-111111111111', record_id: 'r1', chunk_index: 0,
    content: '毒丸', chunker_version: CHUNKER_VERSION, source_revision: 3, vector: [1],
  }
  const healthy = {
    id: '22222222-2222-4222-8222-222222222222', record_id: 'r2', chunk_index: 0,
    content: '健康内容', chunker_version: CHUNKER_VERSION, source_revision: 4, vector: [2],
  }
  const failures = []
  const acknowledgements = []
  const pool = fakePool([
    ['FROM core.record_chunks c', () => ({ rows: [poison, healthy] })],
    ['FROM control.search_rebuild_progress', () => ({ rows: [{ segmenter_backend: 'hanlp' }] })],
    ['SET projection_attempts = chunk.projection_attempts + 1', (values) => {
      failures.push(values)
      return { rowCount: 1, rows: [{ projection_failed_at: null }] }
    }],
    ['SET projected_at = now()', (values) => {
      acknowledgements.push(values)
      return { rowCount: 1 }
    }],
  ])
  const strict = requireSegmenterBackend({
    async segmentWithMeta(text) {
      return String(text).includes('毒丸')
        ? { tokens: [], backendUsed: null, degraded: true, errorCode: 'hanlp_empty_response' }
        : { tokens: [String(text)], backendUsed: 'hanlp', degraded: false, errorCode: null }
    },
  }, { expectedBackend: 'hanlp', maxAttempts: 1, logger: quiet })
  const pipeline = new EmbeddingPipeline({
    pool,
    agent: { embeddings: { available: true } },
    segmenter: strict,
    chunkIndexSet: { readAlias: 'mx-insight-hub-chunks', writeAlias: 'mx-insight-hub-chunk-v1' },
    client: {
      async bulk(value) {
        operations = value
        return { items: [{ index: { status: 200 } }] }
      },
    },
    logger: quiet,
  })

  assert.deepEqual(await pipeline.projectPending(), { projected: 1, failed: 1 })
  assert.equal(failures.length, 1)
  assert.deepEqual(failures[0].slice(0, 2), [poison.id, poison.source_revision])
  assert.match(failures[0][2], /no verified backend/)
  assert.equal(failures[0][3], 5, 'the durable quarantine threshold stays bounded')
  assert.deepEqual(acknowledgements[0][0], [healthy.id])
  assert.equal(operations[0].index._id, `r2:0:${CHUNKER_VERSION}`)
  const selection = pool.client.queries.find(({ sql }) => sql.includes('FROM core.record_chunks c'))
  assert.match(selection.sql, /c\.projection_failed_at IS NULL/)
  const failureUpdate = pool.client.queries.find(({ sql }) => sql.includes('SET projection_attempts'))
  assert.match(failureUpdate.sql, /projection_failed_at = CASE/)
  assert.match(failureUpdate.sql, /chunk\.source_revision = \$2/)
})

test('chunk tombstones use idempotent external versions and acknowledge only the exact revision', async () => {
  let operations = null
  let purgeRequest = null
  const marked = []
  const pool = fakePool([
    ['FROM core.chunk_projection_deletes', () => ({
      rows: [
        { document_id: `r1:2:${CHUNKER_VERSION}`, source_revision: 7 },
        { document_id: 'r1:0:mxih-chunker.v0', source_revision: 7 },
      ],
    })],
    ['UPDATE core.chunk_projection_deletes', (values) => {
      marked.push(values)
      return { rowCount: 2 }
    }],
  ])
  const pipeline = new EmbeddingPipeline({
    pool,
    chunkIndexSet: {
      readAlias: 'mx-insight-hub-chunk',
      writeAlias: 'mx-insight-hub-chunk-v1',
    },
    client: {
      async getAlias(alias) {
        if (alias === 'mx-insight-hub-chunk-v1') {
          return {
            'mx-insight-hub-chunk-v1-000002': {
              aliases: { [alias]: { is_write_index: true } },
            },
          }
        }
        return {
          'mx-insight-hub-chunk-v1-000001': { aliases: { [alias]: {} } },
          'mx-insight-hub-chunk-v1-000002': { aliases: { [alias]: {} } },
        }
      },
      async request(method, path, body) {
        purgeRequest = { method, path, body }
        return { failures: [] }
      },
      bulk: async (ops) => {
        operations = ops
        return {
          items: [
            { delete: { status: 404 } },
            { delete: { status: 409, error: { type: 'version_conflict_engine_exception' } } },
          ],
        }
      },
    },
    logger: quiet,
  })

  const result = await pipeline.projectDeletions()
  assert.deepEqual(result, { projected: 2, failed: 0 })
  assert.equal(operations.length, 2)
  for (const operation of operations) {
    assert.equal(operation.delete._index, 'mx-insight-hub-chunk-v1')
    assert.equal(operation.delete.version, 7)
    assert.equal(operation.delete.version_type, 'external_gte')
  }
  assert.equal(purgeRequest.method, 'POST')
  assert.match(purgeRequest.path, /mx-insight-hub-chunk-v1-000001.*_delete_by_query/)
  assert.deepEqual(
    purgeRequest.body.query.bool.should[0].bool.filter[1].bool.should[0],
    { range: { sourceRevision: { lte: 7 } } },
  )
  assert.deepEqual(
    purgeRequest.body.query.bool.should[0].bool.filter[1].bool.should[1],
    { bool: { must_not: [{ exists: { field: 'sourceRevision' } }] } },
  )
  assert.deepEqual(marked[0], [
    [`r1:2:${CHUNKER_VERSION}`, 'r1:0:mxih-chunker.v0'],
    [7, 7],
  ])
  assert.match(
    pool.client.queries.find(({ sql }) => sql.includes('UPDATE core.chunk_projection_deletes')).sql,
    /deletion\.source_revision = done\.source_revision/,
  )
})

test('a cycle projects chunk deletes before calling the embedding provider', async () => {
  const order = []
  const pipeline = new EmbeddingPipeline({ pool: fakePool([]), logger: quiet })
  pipeline.materializeChunks = async () => {
    order.push('materialize')
    return { records: 1, chunks: 0 }
  }
  pipeline.projectDeletions = async () => {
    order.push('delete')
    return { projected: 1, failed: 0 }
  }
  pipeline.embedPending = async () => {
    order.push('embed')
    return { embedded: 0 }
  }
  pipeline.projectPending = async () => {
    order.push('index')
    return { projected: 0 }
  }

  await pipeline.runOnce()
  assert.deepEqual(order, ['materialize', 'delete', 'embed', 'index'])
})

test('a configured chunk index drains tombstones without an embedding provider', async () => {
  let operations = null
  const pool = fakePool([
    ['FROM core.chunk_projection_deletes', () => ({
      rows: [{ document_id: `r1:0:${CHUNKER_VERSION}`, source_revision: 8 }],
    })],
    ['UPDATE core.chunk_projection_deletes', () => ({ rowCount: 1 })],
  ])
  const pipeline = new EmbeddingPipeline({
    pool,
    agent: { embeddings: { available: false } },
    chunkIndexSet: { readAlias: 'mx-insight-hub-chunks', writeAlias: 'mx-insight-hub-chunk-v1' },
    client: {
      async bulk(ops) {
        operations = ops
        return { items: [{ delete: { status: 404 } }] }
      },
    },
    logger: quiet,
  })

  assert.equal(pipeline.enabled, true)
  const result = await pipeline.runOnce()
  assert.equal(result.deletions.projected, 1)
  assert.match(result.embedded.skipped, /no embedding provider/)
  assert.equal(operations[0].delete._id, `r1:0:${CHUNKER_VERSION}`)
})

test('document ids are deterministic so re-projection overwrites', async () => {
  let operations = null
  let purgeRequest = null
  const pool = fakePool([
    ['FROM core.record_chunks c', () => ({
      rows: [{
        id: 'c1', record_id: 'r1', chunk_index: 2, content: 'a',
        chunker_version: CHUNKER_VERSION, source_revision: 4, vector: [1],
      }],
    })],
  ])
  const pipeline = new EmbeddingPipeline({
    pool,
    agent: { embeddings: { available: true } },
    segmenter: { segment: async () => ['a'] },
    chunkIndexSet: {
      readAlias: 'mx-insight-hub-chunk',
      writeAlias: 'mx-insight-hub-chunk-v1',
    },
    client: {
      async getAlias(alias) {
        if (alias === 'mx-insight-hub-chunk-v1') {
          return {
            'mx-insight-hub-chunk-v1-000002': {
              aliases: { [alias]: { is_write_index: true } },
            },
          }
        }
        return {
          'mx-insight-hub-chunk-v1-000001': { aliases: { [alias]: {} } },
          'mx-insight-hub-chunk-v1-000002': { aliases: { [alias]: {} } },
        }
      },
      async request(method, path, body) {
        purgeRequest = { method, path, body }
        return { failures: [] }
      },
      bulk: async (ops) => {
        operations = ops
        return { items: [{ index: {} }] }
      },
    },
    logger: quiet,
  })
  await pipeline.projectPending()
  assert.equal(operations[0].index._id, `r1:2:${CHUNKER_VERSION}`)
  assert.equal(operations[0].index._index, 'mx-insight-hub-chunk-v1')
  assert.equal(operations[0].index.version, 4)
  assert.equal(operations[0].index.version_type, 'external')
  assert.equal(operations[1].sourceRevision, 4)
  const claimQuery = pool.client.queries.find(({ sql }) => sql.includes('FROM core.record_chunks c'))
  assert.match(claimQuery.sql, /r\.deleted_at IS NULL/)
  assert.match(claimQuery.sql, /c\.source_revision = r\.current_revision/)
  assert.deepEqual(
    purgeRequest.body.query.bool.should[0].bool.filter[1].bool.should[0],
    { range: { sourceRevision: { lte: 4 } } },
  )
})

test('embedding status exposes the durable deletion backlog', async () => {
  const pool = fakePool([
    ['chunks_pending_deletion', () => ({
      rows: [{
        records_pending_chunks: 0,
        chunks_pending_embedding: 0,
        chunks_pending_projection: 0,
        chunks_projection_failed: 2,
        chunks_pending_deletion: 3,
        chunks_total: 9,
        distinct_models: 1,
      }],
    })],
  ])
  const pipeline = new EmbeddingPipeline({ pool, logger: quiet })

  const status = await pipeline.status()
  assert.equal(status.chunks_pending_deletion, 3)
  assert.equal(status.chunks_projection_failed, 2)
  assert.equal(status.mixedEmbeddingModels, false)
  assert.match(pool.client.queries[0].sql, /core\.chunk_projection_deletes WHERE projected_at IS NULL/)
})

// ---------------------------------------------------------------------------
// Hybrid retrieval
// ---------------------------------------------------------------------------

test('RRF promotes a document that both retrievers found', () => {
  const lexical = [{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }]
  const vector = [{ _id: 'c' }, { _id: 'd' }]
  const fused = reciprocalRankFusion([lexical, vector])
  // "c" is rank 3 lexically and rank 1 by vector; agreement should beat "b",
  // which only one retriever found and ranked higher.
  const order = fused.map((entry) => entry.hit._id)
  assert.ok(order.indexOf('c') < order.indexOf('b'))
  assert.deepEqual(fused.find((entry) => entry.hit._id === 'c').retrievers, ['lexical', 'vector'])
})

test('RRF uses rank only, so an unbounded BM25 score cannot dominate', () => {
  // BM25 is unbounded and corpus-dependent while cosine is [-1, 1]; any fixed
  // weighting of raw scores drifts as the corpus grows.
  const lexical = [{ _id: 'a', _score: 9_999 }]
  const vector = [{ _id: 'b', _score: 0.99 }, { _id: 'a', _score: 0.98 }]
  const fused = reciprocalRankFusion([lexical, vector])
  assert.equal(fused[0].hit._id, 'a', 'agreement wins, not the larger raw score')
  assert.ok(fused[0].score < 1, 'scores are rank-derived, not raw')
})

test('RRF keeps the hit copy that carries _source', () => {
  const withoutSource = [{ _id: 'a' }]
  const withSource = [{ _id: 'a', _source: { content: 'text' } }]
  const fused = reciprocalRankFusion([withoutSource, withSource])
  assert.equal(fused[0].hit._source.content, 'text')
})
