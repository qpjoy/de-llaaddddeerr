import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { TopicReportStore, normalizeTopicReportRequest } from '../../server/insights/topic-reports.mjs'
import { CRAWLER_SOURCES, crawlerSourceSpec } from '../../server/ingest/crawler/source-contract.mjs'

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const options = { skip: !modulePath && 'Set MX_INSIGHT_TEST_PGLITE_MODULE for actual PostgreSQL constraints' }
const platforms = [...CRAWLER_SOURCES, crawlerSourceSpec('tender'), crawlerSourceSpec('education')].map(spec => spec.platform)
const migration = name => readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8')
const upgrade = db => migration('156_topic_report_dynamic_platforms.sql').then(sql => db.exec(sql))

async function fixture(t) {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite(); t.after(() => db.close())
  await db.exec(`CREATE TABLE tenants (id uuid PRIMARY KEY); CREATE TABLE consumers (id uuid PRIMARY KEY);
    CREATE TABLE api_keys (id uuid PRIMARY KEY);`)
  for (const name of ['067_topic_insight_reports.sql', '093_topic_report_keywords.sql']) await db.exec(await migration(name))
  const owner = { tenantId: randomUUID(), consumerId: randomUUID(), apiKeyId: randomUUID() }
  for (const [table, id] of [['tenants', owner.tenantId], ['consumers', owner.consumerId], ['api_keys', owner.apiKeyId]]) {
    await db.query(`INSERT INTO ${table} (id) VALUES ($1)`, [id])
  }
  const store = new TopicReportStore({ query: (sql, values) => db.query(sql, values) })
  const input = normalizeTopicReportRequest({ topic: '动态类别专题', keywords: ['类别'], range: '7d' }, {
    availablePlatforms: platforms, allowedPlatforms: platforms, now: new Date('2026-10-17T00:00:00Z'),
  })
  return { db, store, owner, input }
}

test('topic-report migration removes the obsolete thirteen-category cap without changing existing reports', options, async t => {
  const { db, store, owner, input } = await fixture(t)
  const original = await store.create({ ...input, platforms: platforms.slice(0, 13) }, { owner })
  const snapshot = (await db.query('SELECT to_jsonb(report) AS value FROM insights.topic_reports report WHERE id=$1', [original.id])).rows[0].value
  await assert.rejects(store.create({ ...input, platforms: platforms.slice(0, 14) }, { owner }), {
    code: '23514', constraint: 'topic_reports_authorized_platforms_check',
  })
  await upgrade(db)
  for (const count of [14, 15]) {
    const report = await store.create({ ...input, platforms: platforms.slice(0, count) }, { owner })
    assert.equal(report.status, 'queued')
    assert.deepEqual(report.sourceScope.platforms, platforms.slice(0, count))
  }
  const beforeReapply = (await db.query('SELECT to_jsonb(report) AS value FROM insights.topic_reports report ORDER BY id')).rows
  await upgrade(db)
  assert.deepEqual((await db.query('SELECT to_jsonb(report) AS value FROM insights.topic_reports report ORDER BY id')).rows, beforeReapply)
  assert.deepEqual((await db.query('SELECT to_jsonb(report) AS value FROM insights.topic_reports report WHERE id=$1', [original.id])).rows[0].value, snapshot)
})

test('dynamic topic-report scope keeps nonempty, ownership, status and time constraints', options, async t => {
  const { db, store, owner, input } = await fixture(t)
  await upgrade(db)
  await assert.rejects(store.create({ ...input, platforms: [] }, { owner }), {
    code: '23514', constraint: 'topic_reports_authorized_platforms_check',
  })
  await assert.rejects(store.create({ ...input, platforms: null }, { owner }), { code: '23502', column: 'authorized_platforms' })
  await assert.rejects(store.create(input, { owner: { tenantId: owner.tenantId } }), { code: '23514', constraint: 'topic_reports_check1' })
  await assert.rejects(store.create({ ...input, rangeEnd: input.rangeStart }, { owner }), { code: '23514', constraint: 'topic_reports_check' })
  const report = await store.create(input, { owner })
  await assert.rejects(db.query('UPDATE insights.topic_reports SET status=$2 WHERE id=$1', [report.id, 'unreviewed']), {
    code: '23514', constraint: 'topic_reports_status_check',
  })
  assert.equal((await store.get(report.id, { consumerId: owner.consumerId })).status, 'queued')
  assert.equal((await db.query('SELECT count(*)::int count FROM insights.topic_reports')).rows[0].count, 1)
})

test('real topic-report get and list preserve owner isolation for expanded category scopes', options, async t => {
  const { db, store, owner, input } = await fixture(t)
  await upgrade(db)
  const report = await store.create(input, { owner })
  const stranger = randomUUID()
  assert.equal((await store.get(report.id, { consumerId: owner.consumerId })).sourceScope.platforms.length, 15)
  assert.equal(await store.get(report.id, { consumerId: stranger }), null)
  const filter = { keyword: '类别', platform: platforms.at(-1), status: 'queued' }
  assert.equal((await store.list({ ...filter, consumerId: owner.consumerId })).items[0].id, report.id)
  assert.deepEqual((await store.list({ ...filter, consumerId: stranger })).items, [])
})
