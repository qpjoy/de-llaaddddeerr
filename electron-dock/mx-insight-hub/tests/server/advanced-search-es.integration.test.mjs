import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { AdvancedSearch } from '../../server/retrieval/search.mjs'
import { contentIndex, chunkIndex } from '../../server/search/index-definitions.mjs'

// Explicit disposable local Elasticsearch only; never infer a production URL.
// No model/HanLP/provider calls. Words and vectors below are synthetic fixtures.
const endpoint = process.env.MX_RETRIEVAL_TEST_ES_URL
test('real ES: Chinese word admission, phrase highlights and cosine-filtered hybrid retrieval', { skip: !endpoint }, async (t) => {
  const base = new URL(endpoint)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'use a disposable local Elasticsearch')
  const prefix = `mx-retrieval-test-${randomUUID()}`
  const content = `${prefix}-content`, chunks = `${prefix}-chunks`
  async function request(method, path, body) {
    const response = await fetch(new URL(path, base), {
      method, headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
    })
    const result = await response.json()
    assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(result)}`)
    return result
  }
  for (const [name, definition] of [[content, contentIndex()], [chunks, chunkIndex({ dimensions: 3 })]]) {
    await request('PUT', `/${name}`, {
      settings: { number_of_shards: 1, number_of_replicas: 0, analysis: definition.settings.analysis },
      mappings: definition.mappings,
    })
    t.after(() => request('DELETE', `/${name}`))
  }
  const samples = [
    { body: '商家的售后持续拖延，退款困难。', words: '商家 的 售后 持续 拖延 退款 困难', vector: [1, 0, 0] },
    { body: '商品寄回去了，十天了钱还没到账，也没人回复。', words: '商品 寄回 十天 钱 到账 回复', vector: [0.8, 0.6, 0] },
    { body: '销售后，拖车延误；退场贷款，困境难解。', words: '销售 后 拖车 延误 退场 贷款 困境 难解', vector: [0, 1, 0] },
  ]
  const rows = samples.map((sample) => ({
    id: randomUUID(), title: null, body: sample.body, dataset_id: 'quality-test.v1', platform: 'test',
    object_type: 'post', content_type: 'text', current_revision: 1, projection_revision: 1, stable_fields: {},
  }))
  for (const [i, row] of rows.entries()) {
    await request('PUT', `/${content}/_doc/${row.id}`, {
      id: row.id, platform: row.platform, body: row.body, bodyHanlp: samples[i].words, projectionRevision: 1,
    })
    await request('PUT', `/${chunks}/_doc/${row.id}`, {
      recordId: row.id, platform: row.platform, content: row.body, sourceRevision: 1,
      embedding: samples[i].vector, embeddingSpace: 'synthetic:3', embeddingModel: 'synthetic',
    })
  }
  await request('POST', `/${content},${chunks}/_refresh`)
  const pool = { query: async (sql) => ({ rows: sql.includes('FROM core.canonical_records') ? rows : [{ slot: 1 }] }) }
  const service = new AdvancedSearch({ pool, search: {
    indexSet: { readAlias: content }, chunkIndexSet: { readAlias: chunks },
    client: { search: (index, body) => request('POST', `/${index}/_search`, body) },
    segmenter: { segmentWithMeta: async () => ({ tokens: ['售后', '拖延', '退款', '困难'], backendUsed: 'hanlp', degraded: false }) },
  }, agent: {
    embeddings: { available: true }, embed: async () => ({ vectors: [[1, 0, 0]], model: 'synthetic' }),
  } })
  const query = '售后拖延、退款困难'
  // Prove this fixture reproduces the old standard-analyzer AND false positive.
  const old = await request('POST', `/${content}/_search`, { query: { match: { body: { query, operator: 'and' } } } })
  assert.ok(old.hits.hits.some((hit) => hit._id === rows[2].id))
  for (const operator of ['and', 'or']) {
    const result = await service.run({ query, operator })
    assert.deepEqual(result.items.map((item) => item.id), [rows[0].id])
    const highlighted = result.items[0].highlight.body.join(' ')
    const marks = [...highlighted.matchAll(/\uE000(.*?)\uE001/gu)].map((match) => match[1])
    assert.ok(marks.length > 0)
    assert.ok(marks.every((word) => ['售后', '拖延', '退款', '困难'].includes(word)), highlighted)
  }
  const result = await service.run({ query, mode: 'hybrid', minSimilarity: 0.7 })
  assert.deepEqual(new Set(result.items.map((item) => item.id)), new Set([rows[0].id, rows[1].id]))
  assert.deepEqual(result.items.find((item) => item.id === rows[1].id).retrievers, ['vector'])
  assert.ok(Math.abs(result.items.find((item) => item.id === rows[1].id).semanticSimilarity - 0.8) < 0.02)
  const strict = await service.run({ query, mode: 'semantic', minSimilarity: 0.95 })
  assert.deepEqual(strict.items.map((item) => item.id), [rows[0].id])
})
