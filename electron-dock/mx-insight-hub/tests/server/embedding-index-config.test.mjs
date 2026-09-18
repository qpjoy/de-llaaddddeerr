import assert from 'node:assert/strict'
import test from 'node:test'
import { loadConfig } from '../../server/config.mjs'
import { createSearch } from '../../server/search/index.mjs'
import { EmbeddingPipeline } from '../../server/embedding/pipeline.mjs'

test('search and an already constructed worker adopt database dimensions without restart', () => {
  const config = loadConfig({
    MX_INSIGHT_STORE: 'memory',
    MX_INSIGHT_ADMIN_TOKEN: 'test-admin',
    MX_INSIGHT_API_KEY_PEPPER: 'test-pepper-at-least-32-characters',
  })
  config.common.embedding = { model: null, dimensions: null }
  const search = createSearch({ pool: {}, config: config.common })
  const pipeline = new EmbeddingPipeline({
    pool: {}, agent: {}, client: {}, getChunkIndexSet: () => search.chunkIndexSet,
  })
  assert.equal(search.chunkIndexSet, null)
  assert.equal(pipeline.enabled, false)
  Object.assign(config.common.embedding, { model: 'Qwen/Qwen3-Embedding-0.6B', dimensions: 512 })
  assert.equal(search.chunkIndexSet.mappings.properties.embedding.dims, 512)
  assert.equal(search.queries.chunkIndexSet.mappings.properties.embedding.dims, 512)
  assert.equal(pipeline.chunkIndexSet.mappings.properties.embedding.dims, 512)
  assert.equal(pipeline.enabled, true)
})

test('first enable creates only an empty index and refuses incompatible or recoverable data', async () => {
  const { prepareEmptyChunkIndex, chunkIndex } = await import('../../server/search/index.mjs')
  const indexSet = chunkIndex({ dimensions: 512 })
  for (const scenario of ['new', 'ready', 'wrong-dimensions', 'vectors', 'unaliased', 'missing-empty', 'missing-populated', 'wrong-backend', 'hanlp-down']) {
    const calls = []
    const pool = { async connect() { return {
      async query(sql) {
        calls.push(sql)
        if (sql.includes('SELECT segmenter_backend')) return { rows: [{
          segmenter_backend: scenario === 'ready' ? 'hanlp' : scenario === 'wrong-backend' ? 'fallback' : null,
        }] }
        return { rows: [{ has_vectors: scenario === 'vectors' }] }
      }, release() {},
    } } }
    const client = {
      async request(method, path) {
        if (path.endsWith('/_refresh')) { assert.equal(method, 'POST'); return {} }
        assert.equal(method, 'GET')
        if (path.endsWith('/_count')) return { count: scenario === 'missing-populated' ? 1 : 0 }
        if (['ready', 'wrong-dimensions', 'missing-empty', 'missing-populated', 'wrong-backend', 'hanlp-down'].includes(scenario)) return {
          [indexSet.currentIndex]: { mappings: { properties: {
            embedding: { dims: scenario === 'wrong-dimensions' ? 1024 : 512 },
            embeddingSpace: { type: 'keyword' },
          } } },
        }
        throw Object.assign(new Error('not found'), { status: 404 })
      },
      async indexExists() { return scenario === 'unaliased' },
      async putIndexTemplate() { calls.push('template') },
      async createIndex(name, body) {
        calls.push('create')
        assert.equal(name, indexSet.currentIndex)
        assert.equal(body.mappings.properties.embedding.dims, 512)
        assert.equal(body.aliases[indexSet.writeAlias].is_write_index, true)
      },
    }
    const operation = () => prepareEmptyChunkIndex({ pool, client, indexSet, segmenter: {
      async segmentWithMeta() { return { backendUsed: scenario === 'hanlp-down' ? 'fallback' : 'hanlp' } },
    } })
    if (['wrong-dimensions', 'vectors', 'unaliased', 'missing-populated', 'wrong-backend', 'hanlp-down'].includes(scenario)) {
      await assert.rejects(operation)
      assert.ok(!calls.includes('create'))
    } else {
      await operation()
      assert.equal(calls.includes('create'), scenario === 'new')
    }
    assert.ok(calls.some((call) => call.includes('pg_advisory_unlock')))
    assert.ok(!calls.some((call) => /DELETE|canonical_records/.test(call)))
    const writes = calls.filter((call) => call.includes('INSERT INTO control.search_rebuild_progress'))
    assert.equal(writes.length, ['new', 'missing-empty'].includes(scenario) ? 1 : 0)
    assert.ok(writes.every((call) => !call.includes('reconciled_through')))
  }
})
