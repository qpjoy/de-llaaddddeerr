import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import {
  AdvancedSearch,
  parseIntent,
  matchesScope,
  searchFilters,
  withRetrievalSlot,
  lexicalQuery,
  lexicalHighlight,
} from '../../server/retrieval/search.mjs'
import { createApp } from '../../server/app.mjs'
import { isPostgresSafeJsonValue, isPostgresSafeText } from '../../server/core/postgres-json.mjs'
const ids = Array.from({ length: 5 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`)
function fixture({ rows = null, vectorError = false, lexicalError = false, degradedHanlp = false, queryTokens = ['售后', '困难'], vectorHits = null } = {}) {
  const calls = [],
    snapshots = new Map()
  const records =
    rows ||
    ids.slice(0, 3).map((id, i) => ({
      id,
      platform: 'douyin',
      dataset_id: 'posts.v1',
      object_type: 'post',
      content_type: 'video',
      external_id: `post-${i}`,
      author_external_id: 'a1',
      author_name: '作者',
      title: `售后问题 ${i}`,
      body: '来源材料需要引用，本地测试数据。',
      current_revision: 2,
      projection_revision: 3,
      stable_fields: { tags: ['售后'] },
    }))
  const pool = {
    async query(sql, args = []) {
      calls.push({ sql, args })
      if (sql.startsWith('UPDATE retrieval.request_slots')) return { rows: [{ slot: 1 }] }
      if (sql.startsWith('INSERT INTO retrieval.search_snapshots')) {
        assert.ok(isPostgresSafeJsonValue(args[1]), 'query must be valid PostgreSQL jsonb')
        assert.ok(isPostgresSafeJsonValue(JSON.parse(args[2])), 'evidence must be valid PostgreSQL jsonb')
        snapshots.set(args[0], { query: args[1], evidence: JSON.parse(args[2]) })
        return { rows: [] }
      }
      if (sql.startsWith('SELECT query,evidence'))
        return { rows: snapshots.has(args[0]) ? [snapshots.get(args[0])] : [] }
      if (sql.includes('FROM core.canonical_records')) return { rows: records }
      return { rows: [] }
    },
  }
  const search = {
    indexSet: { readAlias: 'content' },
    chunkIndexSet: { readAlias: 'chunks' },
    segmenter: {
      async segmentWithMeta() {
        return {
          tokens: queryTokens,
          backendUsed: degradedHanlp ? 'jieba' : 'hanlp',
          degraded: degradedHanlp,
        }
      },
    },
    client: {
      async search(index, body) {
        calls.push({ index, body })
        if (index === 'content') {
          if (lexicalError) throw Error('offline')
          return {
            hits: {
              total: { value: 3, relation: 'eq' },
              hits: ids.slice(0, 3).map((id) => ({
                _id: id,
                _source: { projectionRevision: 3 },
                highlight: { body: ['\uE000售后\uE001困难'] },
              })),
            },
          }
        }
        if (vectorError) throw Error('offline')
        return {
          hits: {
            hits: vectorHits || [
              { _id: 'chunk1', _score: 0.91, _source: { recordId: ids[0], sourceRevision: 2, content: '售后原文' } },
              { _id: 'chunk2', _score: 0.89, _source: { recordId: ids[0], sourceRevision: 2, content: '重复来源' } },
              { _id: 'chunk3', _score: 0.8, _source: { recordId: ids[2], sourceRevision: 1, content: '过时原文' } },
            ],
          },
        }
      },
    },
  }
  const agent = {
    available: true,
    embeddings: { available: true },
    async embed() {
      return { vectors: [[0.1, 0.2]], model: 'test-embedding' }
    },
    async complete() {
      return {
        payload: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  claims: [{ text: '售后问题', citations: [ids[0]] }],
                  limitations: '仅所选证据',
                }),
              },
            },
          ],
        },
      }
    },
  }
  return {
    service: new AdvancedSearch({ pool, search, agent }),
    pool,
    search,
    agent,
    calls,
    records,
    snapshots,
  }
}
test('intent rejects raw DSL, excessive candidates, invalid calendar dates and unscoped account', () => {
  for (const v of [
    { query: 'x', dsl: {} },
    { query: 'x', topK: 101 },
    { query: 'x', from: '2026-02-30' },
    { query: 'x', account: '1' },
    { query: 'x', operator: 'phrase', fuzzy: true },
    { query: 'x', mode: 'semantic', minSimilarity: 1.01 },
    { query: 'x', mode: 'hybrid', minSimilarity: '-0.1' },
    { query: 'x', mode: 'hybrid', minSimilarity: -1.01 },
    { query: 'x', mode: 'fulltext', minSimilarity: 0.7 },
    { query: 'x', mode: 'semantic', fuzzy: true },
    { query: 'x', mode: 'semantic', operator: 'or' },
    { query: 'bad\u0000query' },
    { query: 'bad\uD83D' },
    { query: 'x', tag: 'bad\uDC00' },
    { query: 'x', datasetId: 'bad\u0000scope' },
  ])
    assert.throws(
      () => parseIntent(v),
      (e) => e.code === 'invalid_search_intent',
    )
})
test('emoji at preview/snippet/answer boundaries remains valid evidence in every search mode', async () => {
  const body = '文'.repeat(299) + '😀' + '文'.repeat(698) + '😀' + '文'.repeat(598) + '𠮷末尾'
  // Both truncation lengths previously produced lone surrogates and a jsonb
  // insertion error. Real canonical text is valid; truncation introduced it.
  assert.equal(isPostgresSafeText(body), true)
  assert.equal(isPostgresSafeText(body.slice(0, 300)), false)
  assert.equal(isPostgresSafeText(body.slice(0, 1600)), false)
  for (const mode of ['semantic', 'fulltext', 'hybrid']) {
    const f = fixture({ vectorHits: [{
      _id: 'emoji-chunk', _score: 0.91,
      _source: { recordId: ids[0], sourceRevision: 2, content: body },
    }] })
    f.records[0].body = body
    const result = await f.service.run({ query: '甜美的女孩子 😀', mode })
    const item = result.items.find((row) => row.id === ids[0])
    assert.equal(item.bodyPreview, body.slice(0, 299))
    assert.equal(item.snippet, body.slice(0, 1599))
    assert.ok(isPostgresSafeText(item.bodyPreview))
    assert.ok(isPostgresSafeText(item.snippet))
    assert.deepEqual(f.snapshots.get(result.snapshotId).evidence, JSON.parse(JSON.stringify(result.items)))
    assert.equal(f.records[0].body, body, 'canonical content stays intact')
    const complete = f.agent.complete
    f.agent.complete = async (messages) => {
      const evidence = JSON.parse(messages[1].content).evidence[0]
      assert.equal(evidence.text, body.slice(0, 999))
      assert.ok(isPostgresSafeText(evidence.text))
      return complete()
    }
    await f.service.answer({ snapshotId: result.snapshotId, ids: [ids[0]] })
    assert.equal(f.service.active, 0)
  }
})
test('emoji fully inside a preview is preserved and omitted API mode remains fulltext', async () => {
  const f = fixture()
  f.records[0].body = '文'.repeat(298) + '😀后文'
  const result = await f.service.run({ query: '售后 😀' })
  assert.equal(result.items[0].bodyPreview, '文'.repeat(298) + '😀')
  assert.equal(result.mode, 'fulltext')
  assert.equal(f.calls.some((c) => c.index === 'chunks'), false)
  assert.deepEqual((await f.service.capabilities()).modes, ['semantic', 'fulltext', 'hybrid'])
})
test('hard filters apply to canonical current truth and both recall branches', () => {
  const q = parseIntent({
    query: 'x',
    platform: 'douyin',
    account: 'a1',
    tag: '售后',
    from: '2026-09-01',
    to: '2026-09-01',
  })
  const row = {
    platform: 'douyin',
    object_type: 'post',
    author_external_id: 'a1',
    stable_fields: { tags: ['售后'] },
    event_time: '2026-08-31T16:00:00Z',
  }
  assert.equal(matchesScope(row, q), true)
  assert.equal(matchesScope({ ...row, event_time: '2026-09-01T16:00:00Z' }, q), false)
  assert.equal(matchesScope({ ...row, deleted_at: new Date() }, q), false)
  assert.ok(searchFilters(q, { chunks: true }).some((f) => f.term?.accountId === 'a1'))
  assert.ok(searchFilters(q).some((f) => f.bool?.should))
})
test('RRF merges record identities; stale revisions and tombstones cannot become evidence', async () => {
  const f = fixture()
  f.records[1].deleted_at = new Date()
  f.records[2].projection_revision = 4
  const result = await f.service.run({ query: '售后困难', mode: 'hybrid', platform: 'douyin' })
  assert.deepEqual(
    result.items.map((i) => i.id),
    [ids[0]],
  )
  assert.deepEqual(result.items[0].retrievers, ['lexical', 'vector'])
  assert.equal(result.accounts[0].contents.length, 1)
  assert.equal(result.omittedStale, 2)
  const knn = f.calls.find((c) => c.index === 'chunks').body.knn
  assert.ok(knn.filter.some((f) => f.term?.embeddingSpace === 'test-embedding:2'))
})
test('vector failure is explicit while strict HanLP failure never falls back', async () => {
  const f = fixture({ vectorError: true }),
    result = await f.service.run({ query: '售后困难', mode: 'hybrid' })
  assert.equal(result.mode, 'fulltext')
  assert.match(result.degraded, /未更换分词器/)
  const strict = fixture({ degradedHanlp: true })
  await assert.rejects(strict.service.run({ query: '售后' }), (e) => e.code === 'reindex_segmenter_degraded')
  assert.equal(
    strict.calls.some((c) => c.index),
    false,
  )
})
test('phrase mode does not require HanLP and raw markup remains text evidence', async () => {
  const f = fixture({ degradedHanlp: true })
  f.records[0].title = '<img src=x onerror=alert(1)>'
  const result = await f.service.run({ query: '售后', operator: 'phrase' })
  assert.equal(result.items[0].title, '<img src=x onerror=alert(1)>')
  assert.equal(
    f.calls.find((c) => c.index === 'content').body.query.bool.should[0].multi_match.type,
    'phrase',
  )
})
test('partial ES results fail closed and release request slots', async () => {
  const f = fixture()
  f.search.client.search = async () => ({ timed_out: true, hits: { hits: [] } })
  await assert.rejects(
    f.service.run({ query: 'x', operator: 'phrase' }),
    (e) => e.code === 'fulltext_search_timeout',
  )
  assert.equal(f.service.active, 0)
  assert.ok(f.calls.some((c) => c.sql?.includes('SET token=NULL')))
})
test('global capacity rejects before any model invocation', async () => {
  let called = false
  await assert.rejects(
    withRetrievalSlot({ query: async () => ({ rows: [] }) }, 'search', async () => {
      called = true
    }),
    (e) => e.code === 'retrieval_busy',
  )
  assert.equal(called, false)
})
test('answer requires snapshot-bound evidence and refuses forged citations', async () => {
  const f = fixture(),
    result = await f.service.run({ query: '售后' })
  await assert.rejects(
    f.service.answer({ snapshotId: result.snapshotId, ids: [ids[4]] }),
    (e) => e.code === 'invalid_evidence',
  )
  f.agent.complete = async () => ({
    payload: {
      choices: [
        {
          message: {
            content: JSON.stringify({ claims: [{ text: '伪造', citations: [ids[4]] }], limitations: '' }),
          },
        },
      ],
    },
  })
  await assert.rejects(
    f.service.answer({ snapshotId: result.snapshotId, ids: [ids[0]] }),
    (e) => e.code === 'invalid_citation',
  )
})
test('answer checks source before and after generation', async () => {
  const f = fixture(),
    result = await f.service.run({ query: '售后' })
  assert.equal((await f.service.answer({ snapshotId: result.snapshotId, ids: [ids[0]] })).claims.length, 1)
  const complete = f.agent.complete
  f.agent.complete = async () => {
    f.records[0].deleted_at = new Date()
    return complete()
  }
  await assert.rejects(
    f.service.answer({ snapshotId: result.snapshotId, ids: [ids[0]] }),
    (e) => e.code === 'evidence_changed',
  )
})
test('advanced search and vector control remain Admin-only; public listener has no access', async (t) => {
  for (const listenerMode of ['combined', 'public']) {
    let calls = 0
    const app = createApp({
      store: {},
      service: {},
      adapter: {},
      adminToken: 'retrieval-test-admin',
      listenerMode,
      advancedSearch: {
        capabilities: async () => {
          calls++
          return { fulltext: true }
        },
      },
      retrievalControl: {
        status: async () => {
          calls++
          return {}
        },
      },
      logger: { error() {} },
    })
    const server = createServer(app)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.after(() => new Promise((r) => server.close(r)))
    const base = `http://127.0.0.1:${server.address().port}`
    for (const path of ['/data-browser/advanced/capabilities', '/retrieval/control']) {
      assert.notEqual((await fetch(base + '/internal/v1/admin' + path)).status, 200)
      const authorized = await fetch(base + '/internal/v1/admin' + path, {
        headers: { 'x-mx-insight-admin-token': 'retrieval-test-admin' },
      })
      assert.equal(authorized.status, listenerMode === 'public' ? 404 : 200)
    }
    assert.equal(calls, listenerMode === 'public' ? 0 : 2)
  }
})

test('query vectors are cached only for the current runtime router', async () => {
  const f = fixture()
  let requests = 0
  f.agent.embed = async () => {
    requests++
    return { vectors: [[0.1, 0.2]], model: 'test-embedding' }
  }
  await f.service.run({ query: '售后困难', mode: 'hybrid' })
  await f.service.run({ query: '售后困难', mode: 'hybrid' })
  assert.equal(requests, 1)
  f.agent.embeddings = { available: true }
  await f.service.run({ query: '售后困难', mode: 'hybrid' })
  assert.equal(requests, 2)
})

test('account profile evidence groups under its platform identity when author is absent',async()=>{
  const f=fixture();f.records[0].object_type='profile';f.records[0].external_id='profile-a';f.records[0].author_external_id=null
  const result=await f.service.run({query:'售后',operator:'phrase'})
  assert.equal(result.accounts.find(a=>a.id==='profile-a').platform,'douyin')
})

test('Chinese AND/OR cannot be bypassed by unordered standard-analyzer character matches', async () => {
  for (const operator of ['and', 'or']) {
    for (const fuzzy of [false, true]) {
      const f = fixture({ queryTokens: ['售后', '拖延', '、', '退款', '困难'] })
      const result = await f.service.run({ query: '售后拖延、退款困难', operator, fuzzy })
      const query = f.calls.find((c) => c.index === 'content').body.query
      const branches = query.bool.should
      assert.deepEqual(result.retrieval.terms, ['售后', '拖延', '退款', '困难'])
      const words = branches.find((b) => b.multi_match?.fields.includes('bodyHanlp')).multi_match
      assert.equal(words.operator, operator)
      assert.equal(words.query, '售后 拖延 退款 困难')
      // This is the admission path that previously matched long economic news
      // containing the same scattered characters without any complete terms.
      const raw = branches.filter((b) => b.multi_match?.fields.includes('body'))
      assert.equal(raw.length, 1)
      assert.equal(raw[0].multi_match.type, 'phrase')
      assert.equal(raw[0].multi_match.fuzziness, undefined)
      if (fuzzy) {
        for (const clause of branches.at(-1).bool[operator === 'and' ? 'must' : 'should'])
          assert.deepEqual(clause.multi_match.fields, ['titleHanlp^3', 'bodyHanlp'])
      }
    }
  }
})

test('highlight query uses adjacent complete words and never incompatible HanLP offsets', () => {
  const q = parseIntent({ query: '售后拖延、退款困难' })
  const highlight = lexicalHighlight(q, ['售后', '拖延', '退款', '困难'])
  assert.deepEqual(highlight.fields.body.highlight_query.bool.should, [
    { match_phrase: { body: '售后' } }, { match_phrase: { body: '拖延' } },
    { match_phrase: { body: '退款' } }, { match_phrase: { body: '困难' } },
  ])
  assert.equal(highlight.fields.body.matched_fields, undefined)
  const phrase = parseIntent({ query: '售后拖延', operator: 'phrase' })
  assert.deepEqual(lexicalHighlight(phrase, []).fields.body.highlight_query.bool.should, [{ match_phrase: { body: '售后拖延' } }])
  assert.equal(lexicalQuery(phrase, []).bool.should[0].multi_match.type, 'phrase')
})

test('whole-word search retains legitimate single-character queries and mixed-language terms', async () => {
  const f = fixture({ queryTokens: ['车', 'API', '退款', '车', '，'] })
  const result = await f.service.run({ query: '车 API退款' })
  assert.deepEqual(result.retrieval.terms, ['车', 'API', '退款'])
  const words = f.calls.find((c) => c.index === 'content').body.query.bool.should[0].multi_match
  assert.equal(words.query, '车 API 退款')
})

test('excess terms are rejected instead of silently dropping AND constraints', async () => {
  const f = fixture({ queryTokens: Array.from({ length: 65 }, (_, i) => `词${i}`) })
  await assert.rejects(f.service.run({ query: '很多词项' }), (e) => e.code === 'too_many_search_terms')
  assert.equal(f.calls.some((c) => c.index), false)
})

test('semantic-only contrast runs no lexical search or HanLP and revalidates current evidence', async () => {
  const f = fixture({ lexicalError: true, degradedHanlp: true })
  const result = await f.service.run({ query: '退货一直没人处理', mode: 'semantic' })
  assert.equal(result.mode, 'semantic')
  assert.deepEqual(result.items.map((i) => i.id), [ids[0]])
  assert.deepEqual(result.items[0].retrievers, ['vector'])
  assert.equal(f.calls.some((c) => c.index === 'content'), false)
  assert.equal(result.lexicalTotal, null)
  assert.equal(result.retrieval.semanticRecords, 1)
  assert.equal(result.retrieval.lexicalRecords, 0)
  assert.equal(result.retrieval.embeddingSpace, 'test-embedding:2')
  assert.ok(Math.abs(result.items[0].semanticSimilarity - 0.82) < 1e-10)
})

test('semantic-only errors never silently return fulltext, and release capacity', async () => {
  const f = fixture({ vectorError: true })
  await assert.rejects(f.service.run({ query: '退款', mode: 'semantic' }), (e) => e.code === 'semantic_search_failed')
  assert.equal(f.calls.some((c) => c.index === 'content'), false)
  assert.equal(f.service.active, 0)
  assert.ok(f.calls.some((c) => c.sql?.includes('SET token=NULL')))
})

test('cosine cutoff applies before fusion and snapshot storage; weak vectors cannot become evidence', async () => {
  const f = fixture({ vectorHits: [
    { _id: 'strong', _score: 0.9, _source: { recordId: ids[0], sourceRevision: 2, content: '有效证据' } },
    { _id: 'weak', _score: 0.7, _source: { recordId: ids[1], sourceRevision: 2, content: '弱相关' } },
    { _id: 'missing-score', _source: { recordId: ids[2], sourceRevision: 2, content: '未知分数' } },
  ] })
  const result = await f.service.run({ query: '退款', mode: 'semantic', minSimilarity: 0.6 })
  assert.equal(f.calls.find((c) => c.index === 'chunks').body.knn.similarity, 0.6)
  assert.deepEqual(result.items.map((i) => i.id), [ids[0]])
  assert.deepEqual(f.snapshots.get(result.snapshotId).evidence.map((i) => i.id), [ids[0]])
  await assert.rejects(f.service.answer({ snapshotId: result.snapshotId, ids: [ids[1]] }), (e) => e.code === 'invalid_evidence')
})

test('cutoff is optional and does not turn similarity into probability or suppress lexical matches', async () => {
  const f = fixture()
  const ordinary = await f.service.run({ query: '退款', mode: 'hybrid' })
  assert.equal(f.calls.find((c) => c.index === 'chunks').body.knn.similarity, undefined)
  assert.equal(ordinary.retrieval.overlapRecords, 1)
  const strict = await f.service.run({ query: '退款', mode: 'hybrid', minSimilarity: 0.99 })
  assert.equal(strict.retrieval.semanticStatus, 'no_matches')
  assert.equal(strict.degraded, null)
  assert.equal(strict.items.length, 3)
  assert.ok(strict.items.every((i) => i.retrievers.length === 1 && i.retrievers[0] === 'lexical'))
})

test('no semantic matches is distinct from model failure and does not fill the requested count', async () => {
  const f = fixture({ vectorHits: [] })
  const result = await f.service.run({ query: '没有资料的问题', mode: 'semantic', topK: 30 })
  assert.equal(result.returned, 0)
  assert.equal(result.retrieval.semanticStatus, 'no_matches')
  assert.equal(result.degraded, null)
  const failed = fixture({ vectorError: true })
  const fallback = await failed.service.run({ query: '退款', mode: 'hybrid' })
  assert.equal(fallback.retrieval.semanticStatus, 'unavailable')
  assert.equal(fallback.mode, 'fulltext')
})

test('cosine thresholds include boundary rounding and retain negative similarity honestly', async () => {
  const f = fixture({ vectorHits: [
    { _id: 'boundary', _score: 0.85, _source: { recordId: ids[0], sourceRevision: 2, content: '边界值' } },
    { _id: 'negative', _score: 0.45, _source: { recordId: ids[1], sourceRevision: 2, content: '负相似度' } },
  ] })
  const boundary = await f.service.run({ query: '退款', mode: 'semantic', minSimilarity: 0.7 })
  assert.deepEqual(boundary.items.map((item) => item.id), [ids[0]])
  const broad = await f.service.run({ query: '退款', mode: 'semantic', minSimilarity: -0.2 })
  assert.equal(broad.items.length, 2)
  assert.ok(broad.items[1].semanticSimilarity < 0)
})
