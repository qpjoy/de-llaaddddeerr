import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { crawlerDiscoveryCandidates, runCrawlerDiscovery } from '../../server/ingest/crawler/discovery.mjs'
import { crawlerSourceSpec, crawlerSourceSpecForKey, crawlerWriterContractForSpec, CRAWLER_SOURCES, CRAWLER_WRITER_CONTRACT_DIGEST } from '../../server/ingest/crawler/source-contract.mjs'
import { savedRecordCategoryCatalog } from '../../server/data/saved-record-categories.mjs'
import { DatabaseSourcePuller } from '../../server/ingest/external/database-source.mjs'
import { normalizeTopicReportRequest, buildTopicReport } from '../../server/insights/topic-reports.mjs'
import { PUBLIC_OPENAPI_DOCUMENT, tenantOpenApiDocument } from '../../server/public-docs.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { createApp } from '../../server/app.mjs'

function relation(type, overrides = {}) {
  return { schema: 'public', table: `saved_records_${type}`, relationKind: 'r', isPartition: true,
    isLeaf: true, parentSchema: 'public', parentTable: 'saved_records', parentRelationKind: 'p',
    parentPartitionKey: 'LIST (source_type)', partitionBound: `FOR VALUES IN ('${type}')`, ...overrides }
}
function source(spec) {
  return { ...spec, id: spec.sourceId, sourceKind: 'database', status: 'paused', connection: {
    host: 'source.test', port: 5432, database: 'data', username: 'reader', password: 'secret', sslMode: 'require', ...spec.locator,
  } }
}

test('category identities are stable and reject malformed or ambiguous source types', () => {
  for (const type of ['education', 'sports_2026', 'health_care', 'constructor', 'a'.repeat(38)]) {
    const spec = crawlerSourceSpec(type)
    assert.ok(spec.platform.length <= 64)
    assert.deepEqual(crawlerSourceSpecForKey(spec.sourceKey), spec)
    assert.deepEqual(crawlerSourceSpec(type), spec)
    assert.equal(crawlerWriterContractForSpec(spec).pipelineKey, `night-all-saved-records:${type}`)
    assert.notEqual(crawlerWriterContractForSpec(spec).digest, CRAWLER_WRITER_CONTRACT_DIGEST)
  }
  for (const type of ['Science', 'local-news', '_news', 'a__b', 'a'.repeat(39), "x'); DROP TABLE a; --"]) {
    assert.equal(crawlerSourceSpec(type), null)
  }
  assert.equal(crawlerWriterContractForSpec(CRAWLER_SOURCES[0]).digest, CRAWLER_WRITER_CONTRACT_DIGEST)
})

test('discovery registers only exact single-value leaves; default and drift stay visible and blocked', () => {
  const candidates = crawlerDiscoveryCandidates([
    relation('education'), relation('sports', { table: 'unexpected' }),
    relation('health', { isLeaf: false }), relation('default', { partitionBound: 'DEFAULT' }),
    relation('multi', { partitionBound: "FOR VALUES IN ('one', 'two')" }),
  ], ['climate'])
  assert.deepEqual(candidates[0].issues, [])
  assert.equal(candidates[0].spec.platform, 'data_center_saved_records_education')
  assert.ok(candidates.slice(1).every(candidate => candidate.issues.length > 0))
  assert.equal(candidates.at(-1).sourceType, 'climate')
})

test('database discovery uses a bounded read-only catalog query and always closes its pool', async () => {
  let options, ended = false
  const sql = []
  const input = source(CRAWLER_SOURCES[0])
  const puller = new DatabaseSourcePuller({
    store: { getExternalSource: async () => input, getActiveMapping: async () => null },
    poolFactory: value => { options = value; return {
      query: async query => { sql.push(query); return { rows: [relation('education')] } },
      end: async () => { ended = true },
    } },
  })
  const result = await puller.discoverCrawlerCategories(input.sourceKey)
  assert.equal(result.candidates[0].sourceType, 'education')
  assert.equal(options.options, '-c default_transaction_read_only=on')
  assert.equal(options.statement_timeout, 5000)
  assert.match(sql[0], /pg_inherits/)
  assert.match(sql[0], /LIMIT 501/)
  assert.equal(ended, true)
})

test('registration commits source and unapproved mapping together and blocks latent grants', async () => {
  for (const blocked of [false, true]) {
    const statements = []
    const client = { release() {}, query: async (sql, values) => {
      statements.push({ sql, values })
      if (sql.includes('SELECT 1 FROM platform_grants')) return { rows: blocked ? [{}] : [] }
      if (sql.includes('INSERT INTO catalog.external_sources')) return { rows: [{
        id: values[0], source_key: values[1], status: 'paused', connection: values[7],
      }] }
      return { rows: [] }
    } }
    const store = new PostgresStore({ connect: async () => client })
    const operation = store.registerCrawlerSource(crawlerSourceSpec('education'), source(CRAWLER_SOURCES[0]))
    if (blocked) {
      await assert.rejects(operation, error => error.code === 'crawler_scope_conflict')
      assert.ok(statements.some(({ sql }) => sql === 'ROLLBACK'))
      assert.ok(!statements.some(({ sql }) => sql.includes('INSERT INTO catalog.external_sources')))
    } else {
      await operation
      assert.ok(statements.some(({ sql }) => sql === 'COMMIT'))
      const mapping = statements.find(({ sql }) => sql.includes('INSERT INTO catalog.source_mappings'))
      assert.ok(mapping)
      assert.doesNotMatch(mapping.sql, /approved_at/)
    }
    assert.ok(statements.some(({ sql }) => sql.includes('LOCK TABLE platform_grants')))
    assert.ok(!statements.some(({ sql }) => /INSERT INTO (platform_grants|api_key_platform_entitlements)/.test(sql)))
  }
})

test('known category catalog includes ungranted entries without credentials or physical metadata', async () => {
  const spec = crawlerSourceSpec('education')
  const store = { listExternalSources: async () => [source(spec)], getCrawlerDiscoveryState: async () => ({
    checkedAt: '2026-09-17T00:00:00Z', items: [{ sourceType: 'health', table: 'private.table', issues: ['private schema'] }],
  }) }
  const catalog = await savedRecordCategoryCatalog(store, [spec.platform, 'data_center_saved_records_health'])
  assert.equal(catalog.items.length, 15)
  assert.equal(catalog.items.find(item => item.id === 'education').authorized, true)
  assert.equal(catalog.items.find(item => item.id === 'health').authorized, false)
  assert.equal(catalog.items.find(item => item.id === 'news').authorized, false)
  assert.doesNotMatch(JSON.stringify(catalog), /secret|source.test|private.table|Night-All|checkpoint|sourceKey/)
  assert.equal((await savedRecordCategoryCatalog(store, [spec.platform])).revision, catalog.revision)
  assert.notEqual((await savedRecordCategoryCatalog(store, [])).revision, catalog.revision)
})

test('topic reports accept more than thirteen registered granted categories and retain all category rankings', () => {
  const availablePlatforms = [...CRAWLER_SOURCES, crawlerSourceSpec('education')].map(spec => spec.platform)
  const request = normalizeTopicReportRequest({ topic: '类别统计', sourceScope: 'selected', platforms: availablePlatforms }, {
    availablePlatforms, allowedPlatforms: availablePlatforms,
  })
  assert.equal(request.platforms.length, 14)
  assert.throws(() => normalizeTopicReportRequest({ topic: '类别统计', sourceScope: 'selected', platforms: availablePlatforms }, {
    availablePlatforms, allowedPlatforms: availablePlatforms.slice(0, 13),
  }), error => error.code === 'platform_not_granted')
  const report = buildTopicReport({ topic: '类别统计', language: 'zh-CN', range_start: '2026-09-01', range_end: '2026-09-17' }, {
    terms: ['类别'], rows: availablePlatforms.map((platform, index) => ({
      id: `record-${index}`, platform, title: '类别统计', body: '类别统计内容', sort_time: '2026-09-10T00:00:00Z', stable_fields: {}, total_matches: '14',
    })),
  })
  assert.equal(report.coverage.categoryCount, 14)
  assert.equal(PUBLIC_OPENAPI_DOCUMENT.components.schemas.CreateTopicReportRequest.properties.platforms.maxItems, undefined)
  const docs = tenantOpenApiDocument([{ platforms: [availablePlatforms.at(-1)], capabilities: [] }])
  assert.ok(docs.paths['/data/saved-records/categories'])
  assert.ok(docs.paths['/data/topic-reports'])
})

test('public directory authenticates, exposes new categories, honors Key snapshots and rejects extra query fields', async () => {
  const store = new MemoryStore()
  const adapter = { capabilities: async () => ({ data: { platforms: [] } }) }
  const service = new HubService({ store, adapter, apiKeyPepper: 'test-category-pepper-at-least-thirty-two-bytes' })
  const tenant = await service.createTenant({ name: 'Category test' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Caller' })
  const news = crawlerSourceSpec('news'), education = crawlerSourceSpec('education')
  for (const spec of [news, education]) await store.createExternalSource(source(spec))
  await service.putPlatformConfiguration(news.platform, { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Before education', platforms: [news.platform] })
  await service.putPlatformConfiguration(education.platform, { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const app = createApp({ store, service, adapter, adminToken: 'category-test-admin', logger: { error() {} } })
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/v1/data/platforms`
    assert.equal((await fetch(url)).status, 401)
    const headers = { authorization: `Bearer ${key.secret}` }
    const response = await fetch(url, { headers })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal((await fetch(url.replace('/data/platforms', '/data/saved-records/categories'), { headers })).status, 200)
    const { data } = await response.json()
    assert.equal(data.items.find(item => item.id === 'news').authorized, true)
    assert.equal(data.items.find(item => item.id === 'education').authorized, false)
    assert.equal((await fetch(`${url}?source=private`, { headers })).status, 400)
  } finally { await new Promise(resolve => server.close(resolve)) }
})


test('daily discovery reuses persisted successful time across restarts', async () => {
  for (const fresh of [true, false]) {
    let calls = 0
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10)
    await runCrawlerDiscovery({ signal: controller.signal,
      store: { getCrawlerDiscoveryState: async () => ({ checkedAt: new Date(Date.now() - (fresh ? 1000 : 2 * 86400000)).toISOString() }) },
      pipeline: { discover: async () => { calls += 1; controller.abort() } },
    })
    clearTimeout(timer)
    assert.equal(calls, fresh ? 0 : 1)
  }
})
