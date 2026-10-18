import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { TopicReportStore } from '../../server/insights/topic-reports.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { CRAWLER_SOURCES, crawlerSourceSpec } from '../../server/ingest/crawler/source-contract.mjs'

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const migration = name => readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8')

test('topic-report HTTP creation retains every authorized category after the database cap migration', {
  skip: !modulePath && 'Set MX_INSIGHT_TEST_PGLITE_MODULE for actual report SQL',
}, async t => {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec('CREATE TABLE tenants (id uuid PRIMARY KEY); CREATE TABLE consumers (id uuid PRIMARY KEY); CREATE TABLE api_keys (id uuid PRIMARY KEY);')
  await db.exec(await migration('067_topic_insight_reports.sql'))
  await db.exec(await migration('093_topic_report_keywords.sql'))
  // Keep usage in the existing memory fixture; report insertion and constraints
  // execute real PostgreSQL SQL instead of the historical Map-based report stub.
  const store = new MemoryStore(), errors = []
  const topicReports = new TopicReportStore({ query: (sql, values) => db.query(sql, values) })
  const service = new HubService({ store, adapter: {}, topicReports,
    apiKeyPepper: 'topic-report-http-postgres-synthetic-pepper' })
  const tenant = await service.createTenant({ name: 'Synthetic topic tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Daily politics caller' })
  const tender = crawlerSourceSpec('tender')
  for (const spec of [...CRAWLER_SOURCES, tender]) await store.createExternalSource({
    ...spec, sourceKind: 'database', status: 'paused', connection: { ...spec.locator },
  })
  const platforms = [...CRAWLER_SOURCES.map(spec => spec.platform), tender.platform].sort()
  assert.equal(platforms.length, 14)
  for (const platform of platforms) await service.putPlatformConfiguration(platform, {
    tenantId: tenant.id, consumerId: consumer.id, enabled: true, maxRequests: 100, windowSeconds: 3600, maxPageSize: 500,
  })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'All authorized categories', platforms })
  const limitedKey = await service.createApiKey({ consumerId: consumer.id, name: 'Original categories only',
    platforms: platforms.filter(platform => platform !== tender.platform) })
  const other = await service.createConsumer({ tenantId: tenant.id, name: 'Other owner' })
  const otherKey = await service.createApiKey({ consumerId: other.id, name: 'Other owner', platforms: [] })
  for (const [table, id] of [['tenants', tenant.id], ['consumers', consumer.id], ['api_keys', key.id]]) {
    await db.query(`INSERT INTO ${table} (id) VALUES ($1)`, [id])
  }
  const app = createApp({ service, store, adapter: {}, listenerMode: 'public', logger: {
    error: entry => errors.push(entry),
  } })
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { authorization: `Bearer ${key.secret}`, 'content-type': 'application/json',
    'idempotency-key': 'daily-political-brief-fourteen-categories' }
  const body = { topic: '今日政治与外交动态', keywords: ['政治', '外交', '选举'], matchMode: 'any', language: 'zh-CN',
    range: 'custom', from: '2026-10-17T00:00:00+08:00', to: '2026-10-17T01:00:00+08:00',
    sourceScope: 'selected', platforms, sampleLimit: 500 }
  const create = async (secret = key.secret) => {
    const response = await fetch(`${base}/api/v1/data/topic-reports`, { method: 'POST',
      headers: { ...headers, authorization: `Bearer ${secret}` }, body: JSON.stringify(body) })
    return { response, payload: await response.json() }
  }

  const directory = await fetch(`${base}/api/v1/data/platforms`, { headers })
  assert.equal(directory.status, 200)
  assert.deepEqual((await directory.json()).data.items.filter(row => row.authorized).map(row => row.platform).sort(), platforms)
  const failed = await create()
  assert.equal(failed.response.status, 500)
  assert.equal(failed.payload.error.code, 'internal_error')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].requestId, failed.payload.requestId, 'The failure ID locates the HTTP error log')
  assert.equal(errors[0].error.code, '23514')
  assert.equal(errors[0].error.constraint, 'topic_reports_authorized_platforms_check')
  const originalUsage = structuredClone([...store.requests.values()][0])
  assert.equal(originalUsage.status, 'released')
  assert.equal(originalUsage.errorCode, 'topic_report_create_failed')
  assert.notEqual(originalUsage.id, failed.payload.requestId, 'An unhandled create error returns the HTTP correlation ID')
  assert.equal((await db.query('SELECT count(*)::int count FROM insights.topic_reports')).rows[0].count, 0)

  await db.exec(await migration('156_topic_report_dynamic_platforms.sql'))
  const accepted = await create()
  assert.equal(accepted.response.status, 202, JSON.stringify(accepted.payload))
  assert.deepEqual(accepted.payload.data.sourceScope.platforms, platforms)
  assert.equal(accepted.payload.data.id, accepted.payload.requestId)
  assert.equal(accepted.payload.data.status, 'queued')
  assert.equal(store.requests.get(accepted.payload.requestId).status, 'committed')
  assert.deepEqual(store.requests.get(originalUsage.id), originalUsage)
  const replay = await create()
  assert.equal(replay.response.headers.get('idempotent-replay'), 'true')
  assert.deepEqual(replay.payload, accepted.payload)
  assert.equal((await db.query('SELECT count(*)::int count FROM insights.topic_reports')).rows[0].count, 1)
  const detail = await fetch(`${base}/api/v1/data/topic-reports/${accepted.payload.data.id}`, { headers })
  assert.deepEqual((await detail.json()).data.sourceScope.platforms, platforms)
  const hidden = await fetch(`${base}/api/v1/data/topic-reports/${accepted.payload.data.id}`, {
    headers: { authorization: `Bearer ${otherKey.secret}` },
  })
  assert.equal(hidden.status, 404)
  const denied = await create(limitedKey.secret)
  assert.equal(denied.response.status, 403)
  assert.equal(denied.payload.error.code, 'platform_not_granted')
  assert.equal((await db.query('SELECT count(*)::int count FROM insights.topic_reports')).rows[0].count, 1)
  assert.equal(errors.length, 1)
})
