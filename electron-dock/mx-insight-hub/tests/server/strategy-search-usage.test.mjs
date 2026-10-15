import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { strategySearchUsageWindow, strategySearchUsageResponse } from '../../server/data/strategy-search-usage.mjs'

const window = strategySearchUsageWindow(new URLSearchParams('days=3'), new Date('2026-10-15T02:00:00Z'))
const rawPath = '/api/v1/night-all/search/raw'
const dataPath = '/api/v1/data/search'

function fixtures() {
  return [
    { id: randomUUID(), createdAt: '2026-10-12T15:59:59.000Z', platform: 'tiktok', path: rawPath },
    { id: randomUUID(), createdAt: '2026-10-12T16:00:00.000Z', platform: 'tiktok', path: rawPath },
    { id: randomUUID(), createdAt: '2026-10-13T15:59:59.000Z', platform: 'tiktok', path: '/api/v1/search/raw' },
    { id: randomUUID(), createdAt: '2026-10-14T16:00:00.000Z', platform: 'tiktok', path: dataPath },
    { id: randomUUID(), createdAt: '2026-10-15T16:00:00.000Z', platform: 'tiktok', path: rawPath },
    { id: randomUUID(), createdAt: '2026-10-14T16:00:00.000Z', platform: 'tiktok', path: null },
    { id: randomUUID(), createdAt: '2026-10-14T16:00:00.000Z', platform: 'tiktok', path: '/api/v1/tools/tokenize' },
    { id: randomUUID(), createdAt: '2026-10-13T16:00:00.000Z', platform: null, path: '/api/v1/data/canonical/search' },
    { id: randomUUID(), createdAt: '2026-10-14T16:00:00.000Z', platform: 'social', path: '/api/v1/data/wechat/search/search' },
  ]
}

function seedMemory(records) {
  const store = new MemoryStore()
  for (const record of records) store.requests.set(record.id, {
    ...record, status: 'committed', acquisitionRequest: record.path ? { path: record.path } : null,
  })
  // Multiple Night-All call receipts attached to one logical request count once.
  for (const record of [records[1], records[1], records[3]]) {
    const id = randomUUID()
    store.connectorCalls.set(id, { id, requestId: record.id })
  }
  return store
}

test('usage window uses Shanghai midnight, includes today, and bounds/validates the read', () => {
  assert.equal(window.from, '2026-10-12T16:00:00.000Z')
  assert.equal(window.to, '2026-10-15T16:00:00.000Z')
  assert.deepEqual(window.days, ['2026-10-13', '2026-10-14', '2026-10-15'])
  assert.equal(strategySearchUsageWindow(new URLSearchParams(), new Date('2026-10-14T16:00:00Z')).throughDay, '2026-10-15')
  for (const query of ['days=0', 'days=32', 'days=7.5', 'days=-1', 'days=07', 'days=7&days=8', 'provider=tikhub']) {
    assert.throws(() => strategySearchUsageWindow(new URLSearchParams(query)), { status: 400 })
  }
})

test('recorded request counts merge aliases, zero-fill days, exclude missing paths and deduplicate legacy evidence', async () => {
  const store = seedMemory(fixtures())
  const before = structuredClone([...store.requests.values()])
  const data = strategySearchUsageResponse(window, await store.strategySearchUsage(window))
  const raw = data.items.find(row => row.path === rawPath)
  assert.deepEqual(raw.paths, ['/api/v1/search/raw', rawPath])
  assert.equal(raw.total, 2)
  assert.equal(raw.nightAllRequests, 1)
  assert.deepEqual(raw.daily, [
    { day: '2026-10-13', requests: 2, nightAllRequests: 1 },
    { day: '2026-10-14', requests: 0, nightAllRequests: 0 },
    { day: '2026-10-15', requests: 0, nightAllRequests: 0 },
  ])
  assert.equal(raw.platforms[0].platform, 'tiktok')
  assert.deepEqual(raw.platforms[0].daily, raw.daily)
  assert.equal(data.items.find(row => row.path === dataPath).total, 1)
  assert.equal(data.items.find(row => row.path === '/api/v1/data/canonical/search').platforms[0].platform, 'unspecified')
  const wechat = data.items.find(row => row.path === '/api/v1/data/wechat/search/search')
  assert.equal(wechat.total, 1)
  assert.equal(wechat.platforms[0].platform, 'social')
  assert.equal(data.items.find(row => row.path === dataPath).platforms.some(row => row.platform.startsWith('wechat')), false)
  assert.equal(data.items.find(row => row.path === '/api/v1/night-all/search/crawl').total, 0)
  assert.match(data.notes.join(' '), /不能区分.*HTTP/)
  assert.match(data.notes.join(' '), /缺少.*历史记录不计入/)
  assert.match(data.notes.join(' '), /微信.*账本平台为 social.*不能区分三个实际入口/)
  assert.deepEqual([...store.requests.values()], before)
  assert.deepEqual(strategySearchUsageResponse(window, await store.strategySearchUsage(window)), data)
})

test('unsafe usage aggregates fail without returning rounded or misleading counts', () => {
  for (const requests of ['9007199254740992', '-1', 'NaN']) {
    assert.throws(() => strategySearchUsageResponse(window, [{ day: '2026-10-13', path: rawPath, platform: 'tiktok', requests, nightAllRequests: 0 }]), { status: 503 })
  }
  assert.throws(() => strategySearchUsageResponse(window, [{ day: '2026-10-13', path: rawPath, platform: 'tiktok', requests: 1, nightAllRequests: 2 }]), { status: 503 })
})

test('statistics require Admin Token, remain off the public listener, and never acquire data', async t => {
  const store = seedMemory(fixtures())
  let reads = 0
  const originalRead = store.strategySearchUsage.bind(store)
  store.strategySearchUsage = async (...args) => { reads++; return originalRead(...args) }
  const adapter = { search() { throw new Error('statistics must not search') } }
  const service = new HubService({ store, adapter, apiKeyPepper: 'strategy-search-usage-fixture-pepper' })
  const sso = { handle: async () => false,
    principal: async () => ({ kind: 'browser-session', platformAdmin: true, memberships: [] }) }
  async function serverFor(listenerMode, extra = {}) {
    const server = createServer(createApp({ store, service, adapter, adminToken: 'fixture-admin',
      listenerMode, logger: { error() {} }, ...extra }))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise(resolve => server.close(resolve)))
    return `http://127.0.0.1:${server.address().port}/internal/v1/admin/strategy-search/usage`
  }
  const base = await serverFor('admin')
  assert.equal((await fetch(base)).status, 401)
  assert.equal((await fetch(base, { headers: { 'x-api-key': 'mih_live_fixture' } })).status, 403)
  assert.equal((await fetch(await serverFor('admin', { sso }))).status, 403)
  const headers = { authorization: 'Bearer fixture-admin' }
  assert.equal((await fetch(`${base}?days=32`, { headers })).status, 400)
  assert.equal(reads, 0)
  const response = await fetch(`${base}?days=7`, { headers })
  assert.equal(response.status, 200)
  const { data } = await response.json()
  assert.equal(data.timeZone, 'Asia/Shanghai')
  assert.equal(data.days.length, 7)
  assert.ok(data.items.every(row => row.daily.length === 7))
  assert.equal(reads, 1)
  assert.equal((await fetch(await serverFor('public'), { headers })).status, 404)
  assert.equal(reads, 1)
})

test('Postgres statistics keep a bounded read-only transaction and release on timeout', async () => {
  const statements = []
  let released = false
  const client = {
    async query(sql) {
      statements.push(sql)
      if (sql.startsWith('SELECT')) throw Object.assign(new Error('timeout'), { code: '57014' })
      return { rows: [] }
    },
    release() { released = true },
  }
  const store = new PostgresStore({ connect: async () => client })
  await assert.rejects(store.strategySearchUsage(window), { status: 503, code: 'strategy_search_usage_timeout' })
  assert.equal(statements[0], 'BEGIN READ ONLY')
  assert.match(statements[1], /SET LOCAL statement_timeout/)
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.ok(released)
})

test('actual PostgreSQL aggregation matches memory at date boundaries and does not multiply legacy receipts', {
  skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE,
}, async t => {
  const { PGlite } = await import(pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`CREATE SCHEMA serving;
    CREATE TABLE usage_requests (id uuid PRIMARY KEY, created_at timestamptz, platform text, acquisition_request jsonb);
    CREATE TABLE serving.connector_calls (id uuid PRIMARY KEY, usage_request_id uuid REFERENCES usage_requests(id));`)
  const records = fixtures()
  for (const record of records) await db.query(
    'INSERT INTO usage_requests VALUES ($1, $2, $3, $4::jsonb)',
    [record.id, record.createdAt, record.platform, record.path ? JSON.stringify({ path: record.path }) : null],
  )
  for (const record of [records[1], records[1], records[3]]) {
    await db.query('INSERT INTO serving.connector_calls VALUES ($1, $2)', [randomUUID(), record.id])
  }
  const pool = { connect: async () => ({ query: (...args) => db.query(...args), release() {} }) }
  const store = new PostgresStore(pool)
  const memory = seedMemory(records)
  assert.deepEqual(strategySearchUsageResponse(window, await store.strategySearchUsage(window)),
    strategySearchUsageResponse(window, await memory.strategySearchUsage(window)))
  assert.equal((await db.query('SELECT count(*)::int AS count FROM usage_requests')).rows[0].count, records.length)
})
