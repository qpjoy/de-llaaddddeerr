import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { AdvancedSearch } from '../../server/retrieval/search.mjs'
import { TelegramSemanticSearch, normalizeTelegramSemanticQuery } from '../../server/retrieval/telegram-semantic.mjs'

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const postgres = { skip: !modulePath && 'Set MX_INSIGHT_TEST_PGLITE_MODULE for actual PostgreSQL validation' }
const id = number => `60000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const time = fraction => `2026-10-18T12:00:00.${fraction}Z`
const model = 'fixture:test-embedding'
const failure = (code, status = 400) => error => error.code === code && error.status === status

test('Telegram semantic input is bounded, strict and distinct from Boolean and paginated search', () => {
  assert.deepEqual(normalizeTelegramSemanticQuery({ query: ' 测试语义 ' }), {
    query: '测试语义', sourceScope: 'all', chatId: null, authorId: null,
    from: null, to: null, topK: 20, minSimilarity: null,
  })
  assert.equal(normalizeTelegramSemanticQuery({ query: 'test' }, 7).topK, 7)
  assert.equal(normalizeTelegramSemanticQuery({ query: 'test', topK: 50 }, 100).topK, 50)
  assert.throws(() => normalizeTelegramSemanticQuery({ query: 'test', topK: 8 }, 7), failure('page_size_exceeded'))
  for (const body of [
    { query: '' }, { query: 'x'.repeat(501) }, { query: '\u0000' }, { query: '\ud800' },
    { query: 'test', topK: 0 }, { query: 'test', topK: 51 }, { query: 'test', topK: '20' },
    { query: 'test', topK: 1.5 }, { query: 'test', minSimilarity: 1.1 }, { query: 'test', minSimilarity: -1.1 },
    { query: 'test', minSimilarity: null }, { query: 'test', sourceScope: 'future' },
    { query: 'test', chatId: '' }, { query: 'test', authorId: 'a'.repeat(257) },
    ...['cursor', 'operator', 'fuzzy', 'mode', 'platform', 'datasetIds', 'objectType', 'knn'].map(key => ({ query: 'test', [key]: 'x' })),
  ]) assert.throws(() => normalizeTelegramSemanticQuery(body), failure('invalid_request'), JSON.stringify(body))
  for (const value of [-1, 0, 1]) assert.equal(normalizeTelegramSemanticQuery({ query: 'test', minSimilarity: value }).minSimilarity, value)
})

test('Telegram semantic time bounds validate real calendar values and preserve inclusive microseconds', () => {
  const query = normalizeTelegramSemanticQuery({ query: 'test', from: '2026-10-18T20:00:00.123456+08:00', to: time('123456') })
  assert.equal(query.from, time('123456'))
  assert.equal(query.to, time('123456'))
  assert.equal(normalizeTelegramSemanticQuery({ query: 'test', from: '2024-02-29T00:00:00Z' }).from, '2024-02-29T00:00:00.000000Z')
  for (const from of ['2026-02-29T00:00:00Z', '2026-10-18', '2026-10-18T00:00:00',
    '2026-10-18T24:00:00Z', '2026-10-18T00:00:00.1234567Z', '2026-10-18T00:00:00+99:99', '0000-01-01T00:00:00Z']) {
    assert.throws(() => normalizeTelegramSemanticQuery({ query: 'test', from }), failure('invalid_request'))
  }
  assert.throws(() => normalizeTelegramSemanticQuery({ query: 'test', from: time('000002'), to: time('000001') }), failure('invalid_request'))
})

function hit(number, { chunkIndex = 0, revision = 1, score = 0.9, embeddingModel = model, ...overrides } = {}) {
  return { _id: `${id(number)}:${chunkIndex}:fixture-v1`, _score: score, _source: {
    recordId: id(number), sourceRevision: revision, chunkerVersion: 'fixture-v1', embeddingModel,
    content: 'UNTRUSTED ES CONTENT', credentials: 'NOT PUBLIC', ...overrides,
  } }
}

async function fixture(t) {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`CREATE SCHEMA core; CREATE SCHEMA retrieval;
    CREATE TABLE core.canonical_records (
      id uuid PRIMARY KEY, dataset_id text NOT NULL, platform text NOT NULL,
      object_type text NOT NULL, external_id text NOT NULL, content_type text,
      url text,title text,body text,author_external_id text,author_name text,event_time timestamptz,
      stable_fields jsonb NOT NULL DEFAULT '{}',current_revision integer NOT NULL,deleted_at timestamptz
    );
    CREATE TABLE core.record_chunks (
      record_id uuid NOT NULL,chunk_index integer NOT NULL,content text NOT NULL,
      chunker_version text NOT NULL,embedding_model text,embedded_at timestamptz,source_revision integer NOT NULL,vector real[],
      UNIQUE(record_id,chunk_index,chunker_version)
    );
    CREATE TABLE retrieval.request_slots (kind text,slot integer,token uuid,lease_until timestamptz,PRIMARY KEY(kind,slot));
    INSERT INTO retrieval.request_slots(kind,slot) VALUES ('search',1);`)
  const calls = { queries: [], searches: [], embeddings: 0 }
  const state = { response: { hits: { hits: [] }, _shards: { failed: 0 }, timed_out: false } }
  const pool = { async query(sql, values) {
    calls.queries.push({ sql, values })
    return db.query(sql, values)
  } }
  const agent = { embeddings: { available: true }, async embed(texts, options) {
    calls.embeddings++
    assert.equal(options.priority, 'interactive')
    assert.deepEqual(texts, ['test'])
    if (state.embeddingError) throw state.embeddingError
    return { vectors: [[0.1, 0.2]], model: 'test-embedding', provider: 'fixture' }
  } }
  const advancedSearch = new AdvancedSearch({ pool, agent, search: {
    chunkIndexSet: { readAlias: 'fixture-chunks-read' },
    client: { async search(index, body) {
      calls.searches.push({ index, body })
      if (state.searchError) throw state.searchError
      return state.response
    } },
  } })
  const service = new TelegramSemanticSearch({ pool, advancedSearch })
  async function insert(number, {
    dataset = 'telegram.monitor.messages.v1', platform = 'telegram', objectType = 'message',
    chatId = '-1001', author = 'user1', event = time('123456'), deleted = null, revision = 1,
    chunkRevision = revision, vector = [0.1, 0.2], embeddedAt = time('000000'),
    embeddingModel = model, title = `title ${number}`, body = `current body ${number}`,
    snippet = `current chunk ${number}`, url = 'https://t.me/example/1',
  } = {}) {
    await db.query(`INSERT INTO core.canonical_records
      (id,dataset_id,platform,object_type,external_id,content_type,url,title,body,author_external_id,author_name,
      event_time,stable_fields,current_revision,deleted_at) VALUES ($1,$2,$3,$4,$5,'text',$6,$7,$8,$9,'Name',$10,$11,$12,$13)`, [
      id(number),dataset,platform,objectType,`-1001:${number}`,url,title,body,author,event,
      { relations: { chatId }, attributes: { username: 'tg_user' }, extensions: { credentials: 'SECRET' }, source: { secret: 'SECRET' }, editedAt: 'INVALID' },revision,deleted,
    ])
    await db.query(`INSERT INTO core.record_chunks
      (record_id,chunk_index,content,chunker_version,embedding_model,embedded_at,source_revision,vector)
      VALUES ($1,0,$2,'fixture-v1',$3,$4,$5,$6)`, [id(number),snippet,embeddingModel,embeddedAt,chunkRevision,vector])
  }
  const run = input => service.run(normalizeTelegramSemanticQuery({ query: 'test', ...input }))
  const released = async () => assert.equal((await db.query('SELECT token FROM retrieval.request_slots')).rows[0].token, null)
  return { db, pool, calls, state, agent, advancedSearch, service, insert, run, released }
}

test('Telegram semantic retrieval prefilters scope, reuses embedding cache and verifies canonical evidence with actual SQL', postgres, async t => {
  const f = await fixture(t)
  await f.insert(1)
  await f.insert(2, { dataset: 'telegram.sqlite.messages.v1' })
  await f.insert(3, { deleted: time('123456') })
  await f.insert(4, { platform: 'other' })
  await f.insert(5, { dataset: 'other.messages.v1' })
  await f.insert(6, { objectType: 'chat' })
  await f.insert(7, { revision: 2, chunkRevision: 1 })
  await f.insert(8, { revision: 2 })
  await f.insert(9, { embeddedAt: null })
  await f.insert(10, { vector: null })
  await f.insert(11, { vector: [0.1, 0.2, 0.3] })
  await f.insert(12, { embeddingModel: 'fixture:other-model' })
  await f.insert(13, { chatId: '-other' })
  await f.insert(14, { author: 'other' })
  await f.insert(15, { event: time('123455') })
  await f.insert(16, { event: time('123457') })
  await f.insert(17, { event: null })
  await f.insert(18, { dataset: 'telegram.sqlite.messages.v1', event: time('123456') })
  await f.db.query(`INSERT INTO core.record_chunks SELECT record_id,1,'best current chunk',chunker_version,
    embedding_model,embedded_at,source_revision,vector FROM core.record_chunks WHERE record_id=$1`, [id(1)])
  f.state.response.hits.hits = [hit(1, { score: 0.7 }), hit(1, { chunkIndex: 1, score: 0.99 }),
    ...Array.from({ length: 17 }, (_, index) => hit(index + 2)), hit(19)]
  const result = await f.run({ sourceScope: 'all', chatId: '-1001', authorId: 'user1', from: time('123456'), to: time('123456') })
  assert.deepEqual(result.items.map(item => item.canonicalId), [id(1), id(2), id(18)])
  assert.equal(result.items[0].snippet, 'best current chunk')
  assert.equal(result.items[0].semanticSimilarity, 0.98)
  assert.equal(result.items[0].revision, 1)
  assert.equal(result.items[0].eventTime, time('123456'))
  assert.equal(result.items[0].chatId, '-1001')
  assert.deepEqual(result.items[0].author, { id: 'user1', name: 'Name', username: 'tg_user' })
  assert.equal(result.items[1].sourceScope, 'sqlite')
  const json = JSON.stringify(result)
  for (const secret of ['UNTRUSTED ES', 'credentials', 'SECRET', 'INVALID', 'snapshotId', 'hasMore']) assert.ok(!json.includes(secret), secret)
  assert.equal(result.retrieval.validatedChunks, 4)
  assert.equal(result.retrieval.validatedRecords, 3)
  assert.equal(result.retrieval.chatFilter, 'post_filter_candidates')
  assert.equal(result.retrieval.exhaustive, false)
  assert.equal(result.retrieval.coverage, 'unknown')
  assert.ok(result.retrieval.warnings.some(warning => warning.code === 'semantic_chat_post_filter'))
  assert.deepEqual(result.pageInfo, { paginationMode: 'top_k', returnedCount: 3, topK: 20, nextCursor: null, cursorType: 'none' })
  const es = f.calls.searches[0]
  assert.equal(es.index, 'fixture-chunks-read')
  assert.equal(es.body.size, 100)
  assert.equal(es.body.knn.k, 100)
  assert.equal(es.body.knn.num_candidates, 200)
  assert.deepEqual(es.body.knn.filter, [
    { term: { platform: 'telegram' } }, { term: { objectType: 'message' } },
    { terms: { datasetId: ['telegram.monitor.messages.v1', 'telegram.sqlite.messages.v1'] } },
    { range: { eventTime: { gte: time('123'), lte: time('123') } } },
    { term: { accountId: 'user1' } }, { term: { embeddingSpace: 'test-embedding:2' } },
  ])
  assert.ok(!JSON.stringify(es.body.knn.filter).includes('chatId'))
  const second = await f.run({ sourceScope: 'monitor', topK: 1, minSimilarity: 0.9 })
  assert.deepEqual(second.items.map(item => item.canonicalId), [id(1)])
  assert.equal(f.calls.embeddings, 1)
  assert.equal(f.calls.searches[1].body.knn.similarity, 0.9)
  assert.ok(!f.calls.queries.some(call => call.sql.includes('search_snapshots')))
  await f.released()
})

test('Telegram semantic projection bounds PG text, sanitizes URLs and keeps nullable fields explicit', postgres, async t => {
  const f = await fixture(t)
  await f.insert(1, { dataset: 'telegram.sqlite.messages.v1', title: '😀'.repeat(501), body: '😀'.repeat(12001), snippet: '😀'.repeat(1601), url: 'https://private.example/?token=SECRET' })
  await f.insert(2, { title: null, body: null, chatId: null, author: null, event: null, url: null })
  f.state.response.hits.hits = [hit(1), hit(2, { score: 0.5 })]
  const { items } = await f.run({ minSimilarity: 0 })
  assert.equal([...items[0].title].length, 500)
  assert.equal([...items[0].text].length, 12000)
  assert.equal([...items[0].snippet].length, 1600)
  for (const field of ['titleTruncated', 'textTruncated', 'snippetTruncated']) assert.equal(items[0][field], true)
  assert.equal(items[0].url, null)
  assert.equal(items[0].id, items[0].canonicalId)
  assert.equal(items[1].title, null)
  assert.equal(items[1].text, null)
  assert.equal(items[1].chatId, null)
  assert.equal(items[1].eventTime, null)
  assert.equal(items[1].semanticSimilarity, 0)
  await f.released()
})

test('Telegram semantic healthy empty hits stay non-exhaustive and malformed or stale candidates cannot become evidence', postgres, async t => {
  const f = await fixture(t)
  await f.insert(1)
  const empty = await f.run({})
  assert.deepEqual(empty.items, [])
  assert.equal(empty.retrieval.coverage, 'unknown')
  assert.equal(empty.retrieval.exhaustive, false)
  const good = hit(1)
  f.state.response.hits.hits = [
    { ...good, _id: 'fake' }, { ...good, _id: `${id(1)}:2147483648:fixture-v1` },
    { ...good, _id: `${id(1)}:1:fixture-v1` }, hit(1, { recordId: id(2) }),
    hit(1, { revision: 0 }), hit(1, { revision: 2 }), hit(1, { score: null }),
    hit(1, { score: NaN }), hit(1, { score: 1.1 }), hit(1, { score: -0.1 }),
    hit(1, { embeddingModel: 'fixture:other-model' }), hit(1, { chunkerVersion: 'other-v1' }),
  ]
  const rejected = await f.run({})
  assert.deepEqual(rejected.items, [])
  assert.equal(rejected.retrieval.discardedCandidates, f.state.response.hits.hits.length)
  f.state.response.hits.hits = [hit(1, { score: 0 })]
  const negative = await f.run({ minSimilarity: -1 })
  assert.equal(negative.items[0].semanticSimilarity, -1)
  await f.released()
})

test('Telegram semantic retrieval bounds candidate SQL to 100 and topK while reporting candidate limitation', postgres, async t => {
  const f = await fixture(t)
  await f.insert(1)
  f.state.response.hits.hits = [...Array.from({ length: 100 }, () => hit(1)), hit(2)]
  const result = await f.run({ topK: 1 })
  assert.equal(result.items.length, 1)
  assert.equal(result.retrieval.candidateChunks, 100)
  assert.equal(result.retrieval.candidateLimitReached, true)
  assert.equal(JSON.parse(f.calls.queries.find(call => call.sql.includes('jsonb_to_recordset')).values[0]).length, 100)
  await f.released()
})

test('Telegram semantic partial ES failures and provider errors never fall back to fabricated or lexical success', postgres, async t => {
  const f = await fixture(t)
  await f.insert(1)
  for (const hits of [[], [hit(1)]]) {
    for (const flags of [{ timed_out: true }, { _shards: { failed: 1 } }]) {
      f.state.response = { hits: { hits }, ...flags }
      await assert.rejects(f.run({}), failure('semantic_timeout', 503))
      await f.released()
    }
  }
  f.state.searchError = new Error('private credentials leaked by provider')
  await assert.rejects(f.run({}), error => failure('semantic_search_failed', 503)(error) && !error.message.includes('credentials'))
  await f.released()
  f.state.searchError = null
  f.state.response = { hits: { hits: [] } }
  f.agent.embeddings = { available: true }
  f.state.embeddingError = new Error('provider failed')
  await assert.rejects(f.run({}), failure('semantic_search_failed', 503))
  await f.released()
  f.state.embeddingError = null
  assert.deepEqual((await f.run({})).items, [])
  assert.equal(f.calls.embeddings, 3, 'failed embedding is evicted before retry')
  f.agent.embeddings.available = false
  await assert.rejects(f.run({}), failure('semantic_unavailable', 503))
  await f.released()
})

test('Telegram semantic admission rejects missing configuration or occupied slots before embeddings', postgres, async t => {
  const f = await fixture(t)
  await assert.rejects(new TelegramSemanticSearch({ pool: f.pool }).run(normalizeTelegramSemanticQuery({ query: 'test' })), failure('semantic_unavailable', 503))
  await f.db.exec(`UPDATE retrieval.request_slots SET lease_until=now()+interval '1 minute'`)
  await assert.rejects(f.run({}), failure('retrieval_busy', 429))
  assert.equal(f.calls.embeddings, 0)
  assert.equal(f.calls.searches.length, 0)
})
