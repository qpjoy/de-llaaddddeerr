import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { strategySearchUsageWindow } from '../../server/data/strategy-search-usage.mjs'
import { strategySearchDataStatisticsResponse } from '../../server/data/strategy-search-data-statistics.mjs'

const window = strategySearchUsageWindow(new URLSearchParams('days=3'), new Date('2026-10-15T02:00:00Z'))

test('unsupported memory ingestion is unavailable rather than a fabricated zero', async () => {
  const store = new MemoryStore()
  const data = strategySearchDataStatisticsResponse(window, await store.strategySearchDataStatistics(window))
  assert.equal(data.available, false)
  assert.equal(data.summary, null)
  assert.deepEqual(data.items, [])
  assert.equal(data.processing.available, false)
  assert.match(data.reason, /没有持久化/)
  assert.match(data.notes.join(' '), /Twitter.*skipIngest.*不能.*零/)
})

test('data statistics preserve zero days and reject unsafe aggregate counts', () => {
  const data = strategySearchDataStatisticsResponse(window, { rows: [
    { level: 'summary', newObjects: '1', observations: '3', observedObjects: '1' },
    { level: 'total', interface: 'crawl', platform: 'douyin', objectType: 'post', newObjects: '1', observations: '3', observedObjects: '1' },
    { level: 'daily', interface: 'crawl', platform: 'douyin', objectType: 'post', day: '2026-10-14', newObjects: '1', observations: '3', observedObjects: '1' },
  ] })
  assert.equal(data.summary.newObjects, 1)
  assert.equal(data.items[0].daily[0].observations, 0)
  assert.equal(data.items[0].daily[1].observations, 3)
  assert.throws(() => strategySearchDataStatisticsResponse(window, { rows: [{ level: 'summary', newObjects: '9007199254740992' }] }), { status: 503 })
})

test('stored data statistics require Admin Token and never acquire data', async t => {
  const store = new MemoryStore()
  let reads = 0
  store.strategySearchDataStatistics = async () => { reads++; return { available: false, rows: [] } }
  const adapter = { search() { throw new Error('statistics must not acquire') } }
  const service = new HubService({ store, adapter, apiKeyPepper: 'stored-data-statistics-fixture-pepper' })
  async function listen(listenerMode, extra = {}) {
    const server = createServer(createApp({ store, service, adapter, adminToken: 'fixture-admin', listenerMode,
      logger: { error() {} }, ...extra }))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise(resolve => server.close(resolve)))
    return `http://127.0.0.1:${server.address().port}/internal/v1/admin/strategy-search/data-statistics`
  }
  const base = await listen('admin')
  assert.equal((await fetch(base)).status, 401)
  assert.equal((await fetch(base, { headers: { 'x-api-key': 'mih_live_fixture' } })).status, 403)
  const sso = { handle: async () => false, principal: async () => ({ kind: 'browser-session', platformAdmin: true }) }
  assert.equal((await fetch(await listen('admin', { sso }))).status, 403)
  const headers = { authorization: 'Bearer fixture-admin' }
  assert.equal((await fetch(`${base}?days=32`, { headers })).status, 400)
  assert.equal(reads, 0)
  const response = await fetch(base, { headers })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).data.available, false)
  assert.equal(reads, 1)
  assert.equal((await fetch(await listen('public'), { headers })).status, 404)
  assert.equal(reads, 1)
})

test('stored data statistics use bounded read-only SQL and roll back on timeout', async () => {
  const sqls = []
  let released = false
  const client = {
    async query(sql) {
      sqls.push(sql)
      if (sql.startsWith('WITH')) throw Object.assign(new Error('timeout'), { code: '57014' })
      return { rows: [] }
    }, release() { released = true },
  }
  const store = new PostgresStore({ connect: async () => client })
  await assert.rejects(store.strategySearchDataStatistics(window), { status: 503, code: 'strategy_search_data_statistics_timeout' })
  assert.equal(sqls[0], 'BEGIN READ ONLY')
  assert.match(sqls[1], /SET LOCAL statement_timeout/)
  assert.equal(sqls.at(-1), 'ROLLBACK')
  assert.equal(released, true)
})

test('SQL separates first creation, repeated revision one, later imports, updates and observations without summing unique counts', {
  skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE,
}, async t => {
  const { PGlite } = await import(pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`CREATE SCHEMA ingest; CREATE SCHEMA core;
    CREATE TABLE usage_requests (id uuid PRIMARY KEY, acquisition_request jsonb);
    CREATE TABLE ingest.ingest_runs (id uuid PRIMARY KEY, request_id uuid, connector_id text, stream_id text, started_at timestamptz, finished_at timestamptz);
    CREATE INDEX ingest_runs_stream_idx ON ingest.ingest_runs(connector_id, stream_id, started_at DESC);
    CREATE TABLE core.canonical_records (id uuid PRIMARY KEY, platform text, object_type text, first_seen_at timestamptz);
    CREATE TABLE core.record_revisions (record_id uuid, revision int, ingest_run_id uuid, valid_from timestamptz, PRIMARY KEY(record_id, revision));
    CREATE TABLE core.observations (id uuid PRIMARY KEY, record_id uuid, canonical_revision int, ingest_run_id uuid);
    CREATE INDEX observations_ingest_order_idx ON core.observations(ingest_run_id);`)
  async function run(day, path, extra = {}) {
    const requestId = randomUUID(), id = randomUUID(), startedAt = `${day}T04:00:00Z`
    await db.query('INSERT INTO usage_requests VALUES ($1,$2)', [requestId, path ? { path } : null])
    await db.query('INSERT INTO ingest.ingest_runs VALUES ($1,$2,$3,$4,$5,$6)',
      [id, requestId, extra.connector || 'night-all-legacy', extra.stream || 'douyin.night-all-compat.v1', startedAt, extra.unfinished ? null : startedAt])
    return { id, startedAt }
  }
  const first = await run('2026-10-13', '/api/v1/night-all/search/raw')
  const repeat = await run('2026-10-14', '/api/v1/night-all/search/crawl')
  const changed = await run('2026-10-14', '/api/v1/search/crawl')
  const profile = await run('2026-10-15', '/api/v1/night-all/search/user-info')
  const search = await run('2026-10-15', '/api/v1/data/search', { connector: 'external-platform:tikhub', stream: 'douyin.external-platform.v1' })
  const later = await run('2026-10-15', '/api/v1/data/search', { connector: 'night-all', stream: 'douyin.search_posts.v1' })
  const excluded = await run('2026-10-15', null)
  const unfinished = await run('2026-10-15', '/api/v1/night-all/search/raw', { unfinished: true })
  async function record(objectType, firstSeen) {
    const id = randomUUID()
    await db.query('INSERT INTO core.canonical_records VALUES ($1,$2,$3,$4)', [id, 'douyin', objectType, firstSeen])
    return id
  }
  const a = await record('post', first.startedAt), b = await record('profile', changed.startedAt)
  const c = await record('post', '2026-10-01T04:00:00Z'), imported = await record('post', '2026-10-01T04:00:00Z')
  const sameDayImported = await record('post', '2026-10-15T03:00:00Z')
  const omitted = await record('post', excluded.startedAt)
  async function version(id, number, creator, date = creator?.startedAt || '2026-10-01T04:00:00Z') {
    await db.query('INSERT INTO core.record_revisions VALUES ($1,$2,$3,$4)', [id, number, creator?.id || null, date])
  }
  await version(a, 1, first); await version(a, 2, changed); await version(a, 3, search)
  await version(b, 1, changed); await version(b, 2, profile)
  await version(c, 1, null); await version(c, 4, search)
  // A record initially created by another import cannot become new merely
  // because its unchanged first revision is later seen through an API call.
  await version(imported, 1, null); await version(omitted, 1, excluded)
  // Even a first revision attributed later on the same day cannot prove that
  // this API run originally created an already-existing canonical record.
  await version(sameDayImported, 1, search)
  for (const [observedRun, id, revision] of [
    [first, a, 1], [repeat, a, 1], [changed, a, 2], [changed, b, 1],
    [profile, b, 2], [search, a, 3], [search, c, 4], [search, imported, 1], [later, a, 3],
    [search, sameDayImported, 1],
    [excluded, omitted, 1], [unfinished, omitted, 1],
  ]) await db.query('INSERT INTO core.observations VALUES ($1,$2,$3,$4)', [randomUUID(), id, revision, observedRun.id])
  const store = new PostgresStore({ connect: async () => ({ query: (...args) => db.query(...args), release() {} }) })
  const data = strategySearchDataStatisticsResponse(window, await store.strategySearchDataStatistics(window))
  assert.deepEqual(data.summary, { newObjects: 2, updatedObjects: 3, contentRevisions: 4, observations: 10, observedObjects: 5 })
  const crawl = data.items.find(item => item.interface === 'crawl' && item.objectType === 'post')
  assert.deepEqual(crawl.total, { newObjects: 0, updatedObjects: 1, contentRevisions: 1, observations: 2, observedObjects: 1 })
  assert.equal(crawl.daily[0].observations, 0)
  assert.equal(crawl.daily[1].observations, 2)
  assert.equal(data.items.filter(item => item.objectType === 'profile').reduce((sum, item) => sum + item.total.newObjects, 0), 1)
  assert.ok(data.items.reduce((sum, item) => sum + item.total.observedObjects, 0) > data.summary.observedObjects)
  assert.deepEqual(strategySearchDataStatisticsResponse(window, await store.strategySearchDataStatistics(window)), data)
})
