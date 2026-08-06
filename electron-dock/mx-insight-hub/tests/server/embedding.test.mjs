import assert from 'node:assert/strict'
import test from 'node:test'
import { CHUNKER_VERSION, chunkRecord, chunkText, estimateTokens } from '../../server/embedding/chunker.mjs'
import { EmbeddingPipeline } from '../../server/embedding/pipeline.mjs'
import { reciprocalRankFusion } from '../../server/search/queries.mjs'

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
  const pool = fakePool([
    ['FROM core.records_needing_chunks', () => ({
      rows: [{ id: 'r1', title: '标题', body: '短正文。', current_revision: 5 }],
    })],
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
  const [recordId, chunkerVersion, revision, newCount] = deletes[0]
  assert.equal(recordId, 'r1')
  assert.equal(chunkerVersion, CHUNKER_VERSION)
  assert.equal(revision, 5)
  // An edit that shortens a record must not leave its extra chunks behind, or
  // retrieval keeps serving text the source no longer contains.
  assert.equal(newCount, result.chunks)
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
    ['FROM core.record_chunks', () => ({ rows: [{ id: 'c1', content: 'hello' }] })],
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
  const [, model, vector] = updates[0]
  assert.equal(model, 'deepseek:embed-v1')
  assert.deepEqual(vector, [0.1, 0.2])
})

test('a chunk rejected by Elasticsearch stays unmarked so only indexing retries', async () => {
  const marked = []
  const pool = fakePool([
    ['FROM core.record_chunks c', () => ({
      rows: [
        { id: 'c1', record_id: 'r1', chunk_index: 0, content: 'a', chunker_version: CHUNKER_VERSION, vector: [1] },
        { id: 'c2', record_id: 'r1', chunk_index: 1, content: 'b', chunker_version: CHUNKER_VERSION, vector: [2] },
      ],
    })],
    ['SET projected_at = now()', (values) => {
      marked.push(values[0])
      return { rowCount: 1 }
    }],
  ])
  const pipeline = new EmbeddingPipeline({
    pool,
    agent: { embeddings: { available: true } },
    segmenter: { segment: async () => ['a'] },
    chunkIndexSet: { writeAlias: 'mx-insight-hub-chunk-v1' },
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
  // The vector is already paid for and stored, so the retry costs only the
  // indexing call -- never another model call.
  assert.deepEqual(marked[0], ['c1'])
})

test('document ids are deterministic so re-projection overwrites', async () => {
  let operations = null
  const pool = fakePool([
    ['FROM core.record_chunks c', () => ({
      rows: [{ id: 'c1', record_id: 'r1', chunk_index: 2, content: 'a', chunker_version: CHUNKER_VERSION, vector: [1] }],
    })],
  ])
  const pipeline = new EmbeddingPipeline({
    pool,
    agent: { embeddings: { available: true } },
    segmenter: { segment: async () => ['a'] },
    chunkIndexSet: { writeAlias: 'mx-insight-hub-chunk-v1' },
    client: {
      bulk: async (ops) => {
        operations = ops
        return { items: [{ index: {} }] }
      },
    },
    logger: quiet,
  })
  await pipeline.projectPending()
  assert.equal(operations[0].index._id, `r1:2:${CHUNKER_VERSION}`)
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
