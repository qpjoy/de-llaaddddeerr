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
} from '../../server/retrieval/search.mjs'
import { createApp } from '../../server/app.mjs'
const ids = Array.from({ length: 5 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`)
function fixture({ rows = null, vectorError = false, lexicalError = false, degradedHanlp = false } = {}) {
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
          tokens: ['售后', '困难'],
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
            hits: [
              { _id: 'chunk1', _source: { recordId: ids[0], sourceRevision: 2, content: '售后原文' } },
              { _id: 'chunk2', _source: { recordId: ids[0], sourceRevision: 2, content: '重复来源' } },
              { _id: 'chunk3', _source: { recordId: ids[2], sourceRevision: 1, content: '过时原文' } },
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
  ])
    assert.throws(
      () => parseIntent(v),
      (e) => e.code === 'invalid_search_intent',
    )
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
