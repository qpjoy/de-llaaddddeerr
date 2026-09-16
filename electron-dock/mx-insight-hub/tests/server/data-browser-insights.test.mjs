import test from 'node:test'
import assert from 'node:assert/strict'
import { browserStatistics, browserStatement, browseData, parseBrowserQuery } from '../../server/data/browser.mjs'
import { metricNumber, recordPresentation, sourceTags } from '../../shared/data-browser-presentation.mjs'
const parse = (s = '') => parseBrowserQuery(new URLSearchParams(s))
const fixture = () => {
  const calls = []
  return { calls, pool: { async connect() { return { async query(sql, values) { calls.push({ sql, values }); return { rows: sql.startsWith('WITH') ? [{ total: '43', items: [] }] : [] } }, release() {} } } } }
}
test('statistics use exact matching scope, with no page, payload or ordering dependency', () => {
  const f = parse('view=accounts&platform=x&tag=a&q=100%25_&from=2026-09-01&to=2026-09-16&objectType=post&contentType=video&page=20')
  const q = browserStatement(f, { statistics: true })
  assert.match(q.text, /count\(\*\)::bigint/)
  assert.match(q.text, /GROUP BY r.platform/)
  assert.match(q.text, /deleted_at IS NULL/)
  assert.match(q.text, /Asia\/Shanghai/)
  assert.doesNotMatch(q.text, /LIMIT|OFFSET|ORDER BY|left\(r.body/)
  assert.deepEqual(q.values, ['x', '["a"]', 'post', 'video', '2026-09-01', '2026-09-16', '%100\\%\\_%'])
  const hotspots = browserStatement(parse('view=hotspots'), { statistics: true })
  assert.match(hotspots.text, /count\(DISTINCT r.id\) >= 2/)
  assert.match(hotspots.text, /r.event_time <= now\(\)/)
})
test('statistics coalesce across page/sort changes, expire, and keep scopes separate', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const store = fixture()
  const first = await browserStatistics(store, parse('view=accounts'))
  first.total = 999
  const second = await browserStatistics(store, parse('view=accounts&page=5&pageSize=50&sort=activity'))
  assert.equal(second.total, 43)
  assert.equal(second.totalStatus, 'exact')
  assert.equal(store.calls.filter((q) => q.sql.startsWith('WITH')).length, 1)
  await browserStatistics(store, parse('view=contents'))
  t.mock.timers.tick(120_001)
  await browserStatistics(store, parse('view=accounts'))
  assert.equal(store.calls.filter((q) => q.sql.startsWith('WITH')).length, 3)
})
test('a blocked statistics request cannot consume the two page-read slots', async () => {
  const rejectors = []
  const store = { pool: { connect: () => new Promise((resolve, reject) => rejectors.push(reject)) } }
  const count = browserStatistics(store, parse()).catch((e) => e.message)
  const sameCount = browserStatistics(store, parse('page=2')).catch((e) => e.message)
  const one = browseData(store, parse()).catch((e) => e.message)
  const two = browseData(store, parse()).catch((e) => e.message)
  assert.equal(rejectors.length, 3)
  await assert.rejects(browserStatistics(store, parse('platform=x')), { code: 'data_browser_busy' })
  rejectors.forEach((reject) => reject(new Error('offline')))
  assert.deepEqual(await Promise.all([count, sameCount, one, two]), ['offline', 'offline', 'offline', 'offline'])
  store.pool = fixture().pool
  assert.equal((await browserStatistics(store, parse())).total, 43)
})
test('empty metrics are unknown, observed zero survives, and malformed fields cannot become metrics', () => {
  for (const value of [null, undefined, '', '10万', {}, [], true, -1, Infinity, 'NaN']) assert.equal(metricNumber(value), null)
  assert.equal(metricNumber(0), 0)
  assert.equal(metricNumber('0'), 0)
  const p = recordPresentation({ stable_fields: { author: { avatarUrl: 'javascript:alert(1)' }, tags: ['a', 'a', 42], metrics: { likes: 0, comments: null, views: '42' }, media: { images: [{ url: 'https://example.com/cover.png' }] } } })
  assert.equal(p.avatar, null)
  assert.equal(p.cover, 'https://example.com/cover.png')
  assert.equal(p.metrics.likes, 0)
  assert.equal(p.metrics.comments, null)
  assert.equal(p.followers, null)
  assert.deepEqual(p.tags, ['a'])
  assert.deepEqual(sourceTags({ observation: { tags: ['旅行'] } }), ['旅行'])
})
test('account summary exposes coverage and source-tag provenance, not inferred Agent metrics', () => {
  const sql = browserStatement(parse('platform=x&account=a&summary=true')).text
  assert.match(sql, /'coverage',count\(likes\)/)
  assert.match(sql, /'value',sum\(likes\)/)
  assert.doesNotMatch(sql, /COALESCE\(sum/)
  assert.match(sql, /count\(DISTINCT m.id\)/)
  assert.match(sql, /stored-content-descriptive-v1/)
  assert.match(sql, /ORDER BY month DESC LIMIT 24/)
})
