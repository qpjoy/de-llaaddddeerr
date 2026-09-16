import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { browseData, browserStatement, parseBrowserQuery } from '../../server/data/browser.mjs'
import { createApp } from '../../server/app.mjs'

const parse = (query = '') => parseBrowserQuery(new URLSearchParams(query))
function poolFixture({ failure = null } = {}) {
  const calls = []
  return { calls, pool: { async connect() { return {
    async query(sql, values) {
      calls.push({ sql, values })
      if (sql.startsWith('WITH')) {
        if (failure) throw failure
        return { rows: [{ total: 1, items: [{ platform: 'xiaohongshu', account_id: 'a', name: 'A' }] }] }
      }
      return { rows: [] }
    }, release(destroy) { calls.push({ release: true, destroy }) },
  } } } }
}

test('filters reject unrestricted DSL, duplicate keys and unscoped account IDs', () => {
  for (const query of ['dsl={}', 'page=0', 'page=501', 'pageSize=51', 'account=a', 'id=invalid', 'view=agent', 'q=a&q=b']) {
    assert.throws(() => parse(query), { code: 'invalid_browser_query' })
  }
  assert.equal(parse('platform=x&account=a').account, 'a')
})

test('SQL binds literals, scopes identity and excludes deleted records; list uses bounded body', () => {
  const injection = "'; DROP TABLE core.canonical_records; --"
  const statement = browserStatement(parse(`view=accounts&platform=x&q=${encodeURIComponent(injection)}`))
  assert.ok(!statement.text.includes(injection))
  assert.ok(statement.values.some((value) => typeof value === 'string' && value.includes('DROP TABLE')))
  assert.match(statement.text, /r.deleted_at IS NULL/)
  assert.match(statement.text, /GROUP BY r.platform/)
  assert.match(statement.text, /NULLIF\(r.author_external_id, ''\)/)
  assert.match(browserStatement(parse()).text, /left\(r.body, 200\)/)
  assert.match(browserStatement(parse('id=11111111-1111-4111-8111-111111111111')).text, /SELECT r\.\*/)
})

test('hotspot evidence excludes future and undated records; tags are type guarded and deduplicated', () => {
  const { text } = browserStatement(parse('view=hotspots'))
  assert.match(text, /r.event_time <= now\(\)/)
  assert.match(text, /interval '7 days'/)
  assert.match(text, /count\(DISTINCT r.id\)/)
  assert.match(text, /jsonb_typeof\(tag.value\) = 'string'/)
  assert.match(text, /jsonb_typeof\(r.stable_fields->'tags'\) = 'array'/)
})

test('read transaction has a timeout, releases connection, and exposes no executed Agent claim', async () => {
  const store = poolFixture()
  const result = await browseData(store, parse())
  assert.equal(result.evidence.analysis, 'not_integrated')
  assert.equal(result.total, 1)
  assert.match(store.calls[0].sql, /READ ONLY/)
  assert.match(store.calls[1].sql, /3000ms/)
  assert.equal(store.calls.at(-2).sql, 'COMMIT')
  assert.equal(store.calls.at(-1).release, true)
})

test('query timeout rolls back and fails independently; no fabricated empty success', async () => {
  const store = poolFixture({ failure: Object.assign(new Error('timeout'), { code: '57014' }) })
  await assert.rejects(browseData(store, parse()), { code: 'data_browser_timeout' })
  assert.equal(store.calls.at(-2).sql, 'ROLLBACK')
  assert.equal(store.calls.at(-1).release, true)
  await assert.rejects(browseData({}, parse()), { code: 'data_browser_unavailable' })
})

test('browser endpoint requires Admin Token and is absent on public listener', async () => {
  for (const listenerMode of ['combined', 'public']) {
    const store = poolFixture()
    const server = createServer(createApp({ store, service: {}, adapter: {}, adminToken: 'browser-test', listenerMode, logger: { error() {} } }))
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const url = `http://127.0.0.1:${server.address().port}/internal/v1/admin/data-browser`
      const denied = await fetch(url)
      assert.ok([401, 404].includes(denied.status))
      const response = await fetch(url, { headers: { 'x-mx-insight-admin-token': 'browser-test' } })
      assert.equal(response.status, listenerMode === 'public' ? 404 : 200)
      const exportDenied = await fetch(`${url}/export?format=csv`)
      assert.ok([401, 404].includes(exportDenied.status))
      const exported = await fetch(`${url}/export?view=accounts&format=json&maxRows=2`, { headers: { 'x-mx-insight-admin-token': 'browser-test' } })
      assert.equal(exported.status, listenerMode === 'public' ? 404 : 200)
      if (listenerMode !== 'public') {
        const file = (await exported.json()).data
        assert.equal(JSON.parse(file.content).items[0].name, 'A')
        const invalid = await fetch(`${url}/export?maxRows=999999`, { headers: { 'x-mx-insight-admin-token': 'browser-test' } })
        assert.equal(invalid.status, 400)
      }
      if (listenerMode === 'public') assert.equal(store.calls.length, 0)
    } finally { await new Promise((resolve) => server.close(resolve)) }
  }
})

test('admission reserves only two browser reads and releases slots on connection failure', async () => {
  const rejects = []
  const store = { pool: { connect: () => new Promise((resolve, reject) => rejects.push(reject)) } }
  const first = browseData(store, parse()).catch((error) => error.message)
  const second = browseData(store, parse()).catch((error) => error.message)
  await assert.rejects(browseData(store, parse()), { code: 'data_browser_busy' })
  rejects.forEach((reject) => reject(new Error('offline')))
  assert.deepEqual(await Promise.all([first, second]), ['offline', 'offline'])
  store.pool = poolFixture().pool
  assert.equal((await browseData(store, parse())).total, 1)
})

test('account source-tag summary uses all matching records rather than current page', () => {
  const { text } = browserStatement(parse('view=contents&platform=x&account=a&summary=true'))
  assert.match(text, /FROM matches m CROSS JOIN/)
  assert.match(text, /AS account_summary/)
  assert.match(text, /count\(DISTINCT m.id\)/)
})

test('accounts keep only the latest name candidate instead of accumulating every historical name', () => {
  const { text } = browserStatement(parse('view=accounts'))
  assert.doesNotMatch(text, /array_agg/i)
  assert.match(text, /selected AS MATERIALIZED/)
  assert.match(text, /LEFT JOIN LATERAL/)
  assert.match(text, /ORDER BY r.collected_at DESC NULLS LAST, r.id DESC LIMIT 1/)
})

test('aggregate budget is isolated and completed pages are reused without sharing mutable objects', async () => {
  const store = poolFixture()
  const filters = parse('view=accounts')
  const first = await browseData(store, filters)
  first.items[0].name = 'mutated by caller'
  const second = await browseData(store, filters)
  assert.equal(second.items[0].name, 'A')
  assert.equal(store.calls.filter((call) => call.sql?.startsWith('WITH')).length, 1)
  assert.match(store.calls[1].sql, /15000ms/)
  assert.equal(second.evidence.cacheMaxAgeSeconds, 30)
  assert.ok(second.evidence.computedAt)
  await browseData(store, parse('view=accounts&platform=another'))
  assert.equal(store.calls.filter((call) => call.sql?.startsWith('WITH')).length, 2)
})

test('identical aggregate requests share one query and failed work can be retried', async () => {
  const store = poolFixture()
  await Promise.all(Array.from({ length: 8 }, () => browseData(store, parse('view=hotspots'))))
  assert.equal(store.calls.filter((call) => call.sql?.startsWith('WITH')).length, 1)
  const failing = poolFixture({ failure: Object.assign(new Error('timeout'), { code: '57014' }) })
  await assert.rejects(browseData(failing, parse('view=accounts')), { code: 'data_browser_timeout' })
  failing.pool = poolFixture().pool
  assert.equal((await browseData(failing, parse('view=accounts'))).total, 1)
})

test('aggregate cache expires and does not cross store boundaries', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const store = poolFixture()
  const other = poolFixture()
  const filters = parse('view=accounts')
  await browseData(store, filters)
  await browseData(other, filters)
  assert.equal(other.calls.filter((call) => call.sql?.startsWith('WITH')).length, 1)
  t.mock.timers.tick(30_001)
  await browseData(store, filters)
  assert.equal(store.calls.filter((call) => call.sql?.startsWith('WITH')).length, 2)
})

test('content page never counts or materializes all large payloads before pagination', () => {
  const { text, values } = browserStatement(parse('view=contents&pageSize=20'))
  assert.match(text, /page_ids AS MATERIALIZED/)
  assert.match(text, /coalesce\(r.event_time, r.collected_at, r.last_seen_at, r.first_seen_at\)/)
  assert.ok(text.indexOf('LIMIT') < text.indexOf('left(r.body'))
  assert.doesNotMatch(text, /count\(\*\)/)
  assert.ok(values.includes(21))
})

test('typed filters, local dates, wildcard literal handling and date validation', () => {
  assert.throws(() => parse('from=2026-03-10&to=2026-03-01'), { code: 'invalid_browser_query' })
  assert.throws(() => parse('from=2026-02-30'), { code: 'invalid_browser_query' })
  const { text, values } = browserStatement(parse('objectType=post&contentType=video&from=2026-09-01&to=2026-09-16&q=100%25_'))
  assert.match(text, /r.object_type = \$/)
  assert.match(text, /r.content_type = \$/)
  assert.match(text, /Asia\/Shanghai/)
  assert.ok(values.includes('%100\\%\\_%'))
})

test('hasMore uses the lookahead row while total remains explicitly uncomputed', async () => {
  const store = { pool: { async connect() { return { async query(sql) {
    return { rows: sql.startsWith('WITH') ? [{ total: null, items: [{ id: 1 }, { id: 2 }, { id: 3 }] }] : [] }
  }, release() {} } } } }
  const result = await browseData(store, parse('pageSize=2'))
  assert.equal(result.hasMore, true)
  assert.equal(result.items.length, 2)
  assert.equal(result.total, null)
  assert.equal(result.totalStatus, 'not_computed')
})
