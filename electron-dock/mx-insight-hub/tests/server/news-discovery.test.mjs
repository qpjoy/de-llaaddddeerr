import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { normalizeNewsQuery, newsCursor, newsWhere, publicNewsArticle, newsCatalog, NewsDiscoveryStore } from '../../server/data/news-discovery.mjs'
import { classificationEvidence, classifyCatalogByRule, validateCatalogSuggestion, CatalogClassifier } from '../../server/agent/catalog-classifier.mjs'
import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const NEWS = 'data_center_saved_records_news', FINANCE = 'data_center_saved_records_finance'
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const entry = { id: id(90), sourceKey: 'source-catalog-0022', canonicalName: '新浪新闻', sourceKind: 'platform', aliases: ['新浪'], revision: 1, majorCategory: '新闻', scenarios: ['新闻资讯'] }
const options = { platforms: [NEWS, FINANCE], identity: ['consumer', 'key'], secret: 'test-news-cursor-pepper' }
const record = { id: id(1), platform: NEWS, current_revision: 1, title: '新闻测试', body: '完整正文', url: 'https://example.test/news?token=private&lang=zh',
  event_time: null, collected_at: '2026-09-23T00:00:00Z', stable_fields: { crawler: { lineage: { publisher: { code: 'sina', name: '新浪' } } } } }

test('news filters reject scope widening, calendar mistakes and changed cursor identity', () => {
  for (const input of [{ platforms: [NEWS] }, { pageSize: 0 }, { sourceCodes: ['a,b'] }, { catalogEntryIds: ['sina'] }, { from: '2026-02-30T00:00:00Z' }, { from: '2026-01-01T24:00:00Z' }]) {
    assert.throws(() => normalizeNewsQuery(input, options), { status: 400 })
  }
  assert.throws(() => normalizeNewsQuery({ categories: ['social'] }, options), { status: 403 })
  const query = normalizeNewsQuery({ query: '100%_A', pageSize: 1 }, options)
  const cursor = newsCursor({ id: id(1), sort_time: record.collected_at }, query, options.secret)
  assert.equal(normalizeNewsQuery({ query: '100%_A', pageSize: 1, cursor }, options).boundary.id, id(1))
  for (const changed of [{ identity: ['consumer', 'another-key'] }, { platforms: [NEWS] }]) {
    assert.throws(() => normalizeNewsQuery({ query: '100%_A', pageSize: 1, cursor }, { ...options, ...changed }), { code: 'invalid_cursor' })
  }
  assert.throws(() => normalizeNewsQuery({ query: 'other', pageSize: 1, cursor }, options), { code: 'invalid_cursor' })
  const where = newsWhere(query)
  assert.deepEqual(where.values, [[FINANCE, NEWS], '%100\\%\\_A%'])
  assert.ok(!where.sql.includes('100%'))
})

test('public news projection preserves stored business text and explicit completeness without raw lineage', () => {
  const row = { ...record, catalog_name: 'token=secret-from-admin-notes', news_raw: { attributes: { summary: '原文摘要', source_topics: ['科技', '科技'], body_status: 'full_text' } }, raw_response: { secret: 'do-not-deliver' } }
  const list = publicNewsArticle(row)
  assert.equal(list.source.name, '新浪')
  assert.equal(list.summary, '原文摘要')
  assert.deepEqual(list.topics, ['科技'])
  assert.equal(list.contentExtent, 'full_text')
  assert.equal(list.url, 'https://example.test/news?lang=zh')
  assert.equal(list.body, undefined)
  assert.equal(publicNewsArticle(row, { detail: true }).body, record.body)
  assert.equal(publicNewsArticle(record).contentExtent, 'unknown')
  assert.equal(list.publishedAt, null)
  const invalidDate = { ...record, stable_fields: { crawler: { publishedAt: { normalized: '2026-02-30', status: 'invalid', precision: 'date' } } } }
  assert.equal(publicNewsArticle(invalidDate).publishedDate, null)
  assert.equal(publicNewsArticle(invalidDate).publishedAtPrecision, null)
  assert.equal(publicNewsArticle({ ...invalidDate, stable_fields: { crawler: { publishedAt: { normalized: '2026-02-28', status: 'date-only', precision: 'date' } } } }).publishedDate, '2026-02-28')
  assert.doesNotMatch(JSON.stringify(list), /do-not-deliver|stable_fields|raw_response|secret-from-admin/)
  assert.deepEqual(newsCatalog([entry, { ...entry, sourceKind: 'provider' }, { ...entry, archivedAt: new Date() }]).map(row => row.id), [entry.id])
})

test('source classification uses structured evidence, disallows invented IDs and does not expose full URLs', () => {
  assert.equal(classifyCatalogByRule(record, [entry]).entryId, entry.id)
  assert.equal(classifyCatalogByRule({ ...record, stable_fields: {}, title: '新浪被报道' }, [entry]), null)
  const evidence = classificationEvidence({ ...record, body: 'a'.repeat(5000) })
  assert.equal(evidence.bodyExcerpt.length, 3000)
  assert.equal(evidence.sourceHost, 'example.test')
  assert.doesNotMatch(JSON.stringify(evidence), /private|token/)
  assert.equal(validateCatalogSuggestion(JSON.stringify({ entryId: entry.id, confidence: 0.9, explanation: '名称匹配' }), [entry]).entryId, entry.id)
  for (const proposal of [{ entryId: id(99), confidence: 0.9, explanation: 'invented' }, { entryId: null, confidence: 2, explanation: '' }, { entryId: entry.id, confidence: 1, explanation: '', publish: true }]) {
    assert.throws(() => validateCatalogSuggestion(JSON.stringify(proposal), [entry]), { code: 'classification_invalid_response' })
  }
})

test('news HTTP requests preserve grants, billing replay, explicit dispatch and Admin-only classification', async () => {
  const store = new MemoryStore(), queries = []
  const adapter = { capabilities: async () => ({ data: { platforms: [] } }), dependencies: async () => ({ status: 'up' }) }
  const service = new HubService({ store, adapter, apiKeyPepper: 'test-news-http-pepper-at-least-32-bytes', newsDiscovery: {
    async search(query) { queries.push(query); return { items: [], pageInfo: { returnedCount: 0, hasMore: false, nextCursor: null } } },
    async article(articleId, platforms) { assert.deepEqual(platforms, [NEWS]); throw Object.assign(new Error('not visible'), { status: 404, code: 'news_article_not_found' }) },
  } })
  const tenant = await service.createTenant({ name: 'News test' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Reader' })
  await service.putPlatformConfiguration(NEWS, { tenantId: tenant.id, consumerId: consumer.id, enabled: true, maxRequests: 100, windowSeconds: 60, maxPageSize: 50 })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'News', platforms: [NEWS] })
  let adminReads = 0
  const app = createApp({ service, store, adapter, adminToken: 'news-admin-only', logger: { error() {} }, catalogClassifier: { records: async () => { adminReads++; return { items: [] } } } })
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const call = async (path, body, extra = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${key.secret}`, ...(body ? { 'content-type': 'application/json', 'idempotency-key': 'news-http-first' } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined })
    return { response, payload: await response.json() }
  }
  try {
    const metadata = await call('/api/v1/data/news/sources')
    assert.equal(metadata.response.status, 200)
    assert.equal(metadata.payload.data.coverage, 'not_measured')
    assert.equal(queries.length, 0)
    assert.equal((await call('/api/v1/data/news/search', {})).response.status, 200)
    const replay = await call('/api/v1/data/news/search', {})
    assert.equal(replay.response.headers.get('idempotent-replay'), 'true')
    assert.equal(queries.length, 1)
    assert.deepEqual(queries[0].platforms, [NEWS])
    assert.equal((await call('/api/v1/data/news/search', { query: 'changed' })).response.status, 409)
    assert.equal((await call('/api/v1/data/news/search', { categories: ['finance'] })).response.status, 403)
    assert.equal((await call('/api/v1/data/news/search', {}, { 'idempotency-key': '' })).response.status, 400)
    assert.equal((await call('/internal/v1/admin/agent/catalog-classifier/records')).response.status, 403)
    assert.equal(adminReads, 0)
    assert.equal((await call('/internal/v1/admin/agent/catalog-classifier/records', null, { authorization: 'Bearer news-admin-only' })).response.status, 200)
    assert.equal(adminReads, 1)
    await store.revokeApiKey(key.id)
    assert.equal((await call('/api/v1/data/news/search', {})).response.status, 401)
    assert.equal(queries.length, 1)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

// Optional real PostgreSQL/WASM verification. Supply an installed PGlite module path;
// this creates only an in-memory database and never opens DATABASE_URL or a live source.
test('PostgreSQL news search, legacy projection, review conflicts and Agent idempotency', { skip: !process.env.MX_NEWS_TEST_PGLITE_MODULE }, async () => {
  const { PGlite } = await import(process.env.MX_NEWS_TEST_PGLITE_MODULE)
  const db = new PGlite()
  const pool = { query: (...args) => db.query(...args), connect: async () => ({ query: (...args) => db.query(...args), release() {} }) }
  try {
    await db.exec('CREATE SCHEMA core; CREATE SCHEMA catalog; CREATE SCHEMA ingest; CREATE TABLE ingest.ingest_runs (id uuid PRIMARY KEY)')
    const coreSql = await readFile(new URL('../../migrations/005_ingest_core_outbox.sql', import.meta.url), 'utf8')
    const catalogSql = await readFile(new URL('../../migrations/036_source_catalog.sql', import.meta.url), 'utf8')
    for (const [sql, name] of [[coreSql, 'core.canonical_records'], [coreSql, 'core.record_revisions'], [catalogSql, 'catalog.source_catalog_entries']]) {
      const ddl = sql.slice(sql.indexOf(`CREATE TABLE IF NOT EXISTS ${name}`))
      await db.exec(ddl.slice(0, ddl.indexOf('\n);') + 3))
    }
    await db.exec(await readFile(new URL('../../migrations/110_record_catalog_classification.sql', import.meta.url), 'utf8'))
    await db.query(`INSERT INTO catalog.source_catalog_entries (id, source_key, canonical_name, aliases, major_category, scenarios, regions)
      VALUES ($1, $2, $3, $4, '新闻', ARRAY['新闻资讯'], ARRAY['中国'])`, [entry.id, entry.sourceKey, entry.canonicalName, entry.aliases])
    const insert = async (n, overrides = {}) => {
      const row = { ...record, id: id(n), ...overrides }
      await db.query(`INSERT INTO core.canonical_records (id,dataset_id,platform,object_type,external_id,schema_version,content_type,title,body,collected_at,event_time,stable_fields)
        VALUES ($1::uuid,'test.v1',$2,'article',$1::text,'v1',$3,$4,$5,$6,$7,$8)`, [row.id, row.platform, row.content_type || 'news.article', row.title, row.body, row.collected_at, row.event_time, row.stable_fields])
      await db.query(`INSERT INTO core.record_revisions (record_id,revision,payload_sha256,normalized_payload,parser_version)
        VALUES ($1,1,$2,$3,'v1')`, [row.id, 'a'.repeat(64), { attributes: { summary: '保留的历史摘要', source_topics: ['科技'], body_status: 'summary' }, private: 'secret-do-not-deliver' }])
    }
    await insert(1); await insert(2, { platform: FINANCE }); await insert(3, { content_type: 'forum.post' }); await insert(4, { content_type: 'news.resolved' })
    await insert(5, { content_type: 'bbc.article', stable_fields: { crawler: { lineage: { collector: { connectorId: 'bbc-news-openweb' } } } } })
    await insert(6, { content_type: 'bbc.article' }); await insert(7, { stable_fields: { crawler: { lineage: { qualityStatus: 'rejected' } } } })
    const news = new NewsDiscoveryStore(pool)
    const scoped = { ...options, platforms: [NEWS] }
    const first = await news.search(normalizeNewsQuery({ pageSize: 2 }, scoped), scoped.secret)
    assert.deepEqual(first.items.map(row => row.id), [id(5), id(4)])
    assert.equal(first.items[0].summary, '保留的历史摘要')
    assert.equal(first.items[0].contentExtent, 'summary')
    const second = await news.search(normalizeNewsQuery({ pageSize: 2, cursor: first.pageInfo.nextCursor }, scoped), scoped.secret)
    assert.deepEqual(second.items.map(row => row.id), [id(1)])
    assert.equal(second.pageInfo.hasMore, false)
    await assert.rejects(news.article(id(2), [NEWS]), { status: 404 })
    assert.equal((await news.search(normalizeNewsQuery({ timeField: 'publishedAt' }, scoped), scoped.secret)).items.length, 0)
    assert.equal((await news.facets(normalizeNewsQuery({}, scoped))).sampledRecords, 3)
    await insert(8, { collected_at: '2026-09-23T00:00:00.000123Z' })
    await insert(9, { collected_at: '2026-09-23T00:00:00.000122Z' })
    const microFilters = { pageSize: 1, from: '2026-09-23T00:00:00.000100Z', to: '2026-09-23T00:00:00.000200Z' }
    const microFirst = await news.search(normalizeNewsQuery(microFilters, scoped), scoped.secret)
    assert.deepEqual(microFirst.items.map(row => row.id), [id(8)])
    const microNext = await news.search(normalizeNewsQuery({ ...microFilters, cursor: microFirst.pageInfo.nextCursor }, scoped), scoped.secret)
    assert.deepEqual(microNext.items.map(row => row.id), [id(9)], 'cursor must preserve PG microseconds, not skip the rest of a millisecond')
    const catalogStore = { listSourceCatalogEntries: async () => [entry] }
    const ruleAgent = new CatalogClassifier({ pool, store: catalogStore, agent: { refresh() { throw new Error('rules must not need an Agent') } } })
    const proposal = await ruleAgent.propose({ recordId: id(1), recordRevision: 1, requestKey: 'rule-known-source', useAgent: true }, 'test-admin')
    assert.equal(proposal.method, 'rule')
    assert.equal(proposal.status, 'proposed')
    await ruleAgent.review(proposal.id, { decision: 'accept', expectedBindingRevision: 0 }, 'test-admin')
    assert.equal((await news.search(normalizeNewsQuery({ catalogEntryIds: [entry.id] }, scoped), scoped.secret)).items[0].source.catalogEntryId, entry.id)
    await db.query('UPDATE core.canonical_records SET current_revision = 2 WHERE id = $1', [id(1)])
    assert.equal((await news.search(normalizeNewsQuery({ catalogEntryIds: [entry.id] }, scoped), scoped.secret)).items.length, 0)
    const next = await ruleAgent.propose({ recordId: id(1), recordRevision: 2, requestKey: 'rule-next-revision' }, 'test-admin')
    const workbench = await ruleAgent.records({ query: '新闻测试', binding: 'all' })
    assert.equal(workbench.items.find(row => row.id === id(1)).binding_revision, 1)
    await assert.rejects(ruleAgent.review(next.id, { decision: 'accept', expectedBindingRevision: 0 }, 'test-admin'), { code: 'classification_binding_conflict' })
    await ruleAgent.review(next.id, { decision: 'accept', expectedBindingRevision: 1 }, 'test-admin')
    const { PostgresStore } = await import('../../server/stores/postgres-store.mjs')
    let relatedSql
    const catalogReader = new PostgresStore({ async query(sql) { relatedSql ||= sql; return { rows: [] } } })
    await catalogReader.sourceCatalogRelatedData(entry)
    const matchedSql = relatedSql.slice(0, relatedSql.indexOf('), matched_records AS')) + ') SELECT id FROM matched_record_ids'
    assert.deepEqual((await db.query(matchedSql, [['新浪'], entry.id])).rows.map(row => row.id), [id(1)], 'catalog governance sees reviewed bindings')
    const stale = await ruleAgent.propose({ recordId: id(4), recordRevision: 1, requestKey: 'rule-stale-entry' }, 'test-admin')
    await db.query('UPDATE catalog.source_catalog_entries SET revision = 2 WHERE id = $1', [entry.id])
    await assert.rejects(ruleAgent.review(stale.id, { decision: 'accept', expectedBindingRevision: 0 }, 'test-admin'), { code: 'classification_stale' })
    let calls = 0
    const agent = { refresh: async () => true, status: () => ({ bindings: [{ kind: 'chat', sequenceKey: 'configured-chat' }] }),
      complete: async (messages, config) => { calls++; assert.equal(config.sequenceKey, 'configured-chat'); assert.equal(config.proxyUrl, undefined); throw Error('ambiguous provider timeout') } }
    const classifier = new CatalogClassifier({ pool, store: catalogStore, agent })
    const request = { recordId: id(5), recordRevision: 1, requestKey: 'agent-unknown-request', useAgent: true }
    await assert.rejects(classifier.propose(request, 'test-admin'), { code: 'classification_outcome_unknown' })
    assert.equal((await classifier.propose(request, 'test-admin')).status, 'unknown')
    assert.equal(calls, 1)
    agent.complete = async (messages, config) => {
      calls++; assert.equal(config.sequenceKey, 'configured-chat')
      assert.doesNotMatch(messages[1].content, /secret-do-not-deliver|normalized_payload/)
      return { payload: { choices: [{ message: { content: JSON.stringify({ entryId: entry.id, confidence: 0.8, explanation: '需要人工核对的来源建议' }) } }] }, provider: 'test', model: 'test-model' }
    }
    const successful = await classifier.propose({ ...request, requestKey: 'agent-new-explicit-request' }, 'test-admin')
    assert.equal(successful.status, 'proposed')
    assert.equal(successful.method, 'agent')
    assert.equal(successful.sequenceKey, 'configured-chat')
    assert.equal((await classifier.propose({ ...request, requestKey: 'agent-new-explicit-request' }, 'test-admin')).id, successful.id)
    assert.equal(calls, 2)
    assert.equal((await news.article(id(5), [NEWS])).article.source.bindingStatus, 'unmapped', 'Agent proposal alone cannot change a binding')
  } finally { await db.close() }
})
