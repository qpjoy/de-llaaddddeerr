import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { NightAllAService, NightAllADispatchStore, nightAllAConfig } from '../../server/external-platforms/night-all-a.mjs'
import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { MultiExternalPlatformAdminService } from '../../server/external-platforms/admin.mjs'
import { readFile } from 'node:fs/promises'

class Journal {
  rows = new Map()
  async reserve(input) {
    if (this.rows.has(input.key)) return { fresh: false, row: this.rows.get(input.key) }
    const row = { ...input, state: 'reserved' }; this.rows.set(input.key, row)
    return { fresh: true, row }
  }
  async finish(id, state, response) { const row = [...this.rows.values()].find(row => row.id === id); Object.assign(row, { state, response }) }
  async get(id) { return [...this.rows.values()].find(row => row.id === id) }
  async list() { return { available: true, items: [...this.rows.values()] } }
}
const config = nightAllAConfig({ MX_INSIGHT_NIGHT_ALL_A_ENABLED: '1', MX_INSIGHT_NIGHT_ALL_A_WRITES_ENABLED: '1' })
const input = { body: { connector_id: 'china-news', capability: 'news.collect', parameters: {} }, reason: 'test' }
const context = { idempotencyKey: 'unique-request-key-123' }

test('optional config is fail-closed without breaking startup; catalog is complete and no secret is exposed', async () => {
  for (const url of ['http://example.com', 'http://100.127.0.1:8100/api', 'http://user:pass@100.127.0.1:8100', 'http://100.127.0.1:8100/?a=1']) {
    assert.equal(nightAllAConfig({ MX_INSIGHT_NIGHT_ALL_A_BASE_URL: url, MX_INSIGHT_NIGHT_ALL_A_ENABLED: '1' }).enabled, false)
  }
  const service = new NightAllAService({ config: { ...config, sessionCookie: 'secret-cookie', csrfToken: 'secret-csrf' }, fetchImpl: () => { throw Error('must not probe') } })
  const detail = await service.detail('night-all-a')
  assert.equal(Object.keys(detail.catalog.openapi.paths).length, 83)
  assert.equal(Object.values(detail.catalog.openapi.paths).flatMap(Object.keys).length, 117)
  assert.doesNotMatch(JSON.stringify(detail), /secret-cookie|secret-csrf/)
  assert.equal(detail.provider.status, 'unknown')
  await assert.rejects(new NightAllAService().dispatch('health'), { code: 'night_all_a_disabled' })
})

test('durable reservation prevents concurrent duplicates, replays JSON and rejects key reuse', async () => {
  let calls = 0
  const service = new NightAllAService({ config, journal: new Journal(), fetchImpl: async (url, options) => {
    calls++; assert.equal(String(url), 'http://100.127.0.1:8100/api/tasks')
    assert.equal(options.redirect, 'error'); assert.equal(options.headers.authorization, undefined)
    assert.equal(JSON.parse(options.body).max_attempts, 1)
    return new Response(JSON.stringify({ task: { id: 5 }, run: { id: 8 } }), { status: 202 })
  } })
  const responses = await Promise.allSettled([service.dispatch('createTask', input, context), service.dispatch('createTask', input, context)])
  assert.equal(calls, 1)
  assert(responses.some(item => item.status === 'fulfilled'))
  const replay = await service.dispatch('createTask', input, context)
  assert.equal(replay.replay, true); assert.equal(replay.data.run.id, 8)
  await assert.rejects(service.dispatch('createTask', { ...input, body: { ...input.body, capability: 'other' } }, context), { code: 'night_all_a_idempotency_conflict' })
  assert.equal(calls, 1)
})

test('timeout, 5xx, oversized, malformed JSON and persistence failure quarantine writes without retry', async () => {
  for (const mode of ['network', 'server', 'malformed', 'oversized', 'persistence']) {
    let calls = 0
    const journal = new Journal()
    if (mode === 'persistence') journal.finish = async () => { throw Error('database down') }
    const service = new NightAllAService({ config, journal, fetchImpl: async () => {
      calls++
      if (mode === 'network') throw Error('secret-url-must-not-leak')
      if (mode === 'malformed') return new Response('<html>login</html>')
      if (mode === 'oversized') return new Response('x'.repeat(4 * 1024 * 1024 + 1))
      return new Response('{"task":{"id":5}}', { status: mode === 'server' ? 503 : 202 })
    } })
    await assert.rejects(service.dispatch('createTask', input, context), error => error.code === 'night_all_a_outcome_unknown' && Boolean(error.details.dispatchId))
    await assert.rejects(service.dispatch('createTask', input, context), { code: 'night_all_a_outcome_unknown' })
    assert.equal(calls, 1, mode)
  }
})

test('fixed operations, path IDs, query fields, write switch and missing PG fail before dispatch', async () => {
  let calls = 0
  const service = new NightAllAService({ config, fetchImpl: async () => { calls++; return new Response('{}') } })
  await assert.rejects(service.dispatch('credentials'), { code: 'night_all_a_operation_not_allowed' })
  await assert.rejects(service.dispatch('task', { id: '../credentials' }), { code: 'invalid_night_all_a_request' })
  await assert.rejects(service.dispatch('records', { query: { url: 'http://attacker' } }), { code: 'invalid_night_all_a_request' })
  await assert.rejects(service.dispatch('health', { headers: {} }), { code: 'invalid_night_all_a_request' })
  await assert.rejects(service.dispatch('createTask', input, context), { code: 'night_all_a_journal_unavailable' })
  await assert.rejects(new NightAllAService({ config: { ...config, writesEnabled: false } }).dispatch('createTask', input, context), { code: 'night_all_a_writes_disabled' })
  assert.equal(calls, 0)
  await service.dispatch('records', { query: { limit: 10, source_type: 'news' } })
  assert.equal(calls, 1)
})

test('deadline aborts a pending submission and blocks a repeated key', async () => {
  let aborted = false
  const service = new NightAllAService({ config, journal: new Journal(), timeoutMs: 10,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(Error('aborted')) }, { once: true })),
  })
  await assert.rejects(service.dispatch('createTask', input, context), { code: 'night_all_a_outcome_unknown' })
  assert.equal(aborted, true)
  await assert.rejects(service.dispatch('createTask', input, context), { code: 'night_all_a_outcome_unknown' })
})

test('run observations use fixed read-only routes and preserve log content', async () => {
  const calls = []
  const service = new NightAllAService({ config, fetchImpl: async (url, options) => {
    calls.push([String(url), options.method])
    return new Response(JSON.stringify({ items: [{ level: 'info', message: '已保存 5 条新闻', step_id: 1 }] }))
  } })
  for (const operation of ['runLogs', 'runSteps', 'runArtifacts']) {
    const result = await service.dispatch(operation, { id: 42 })
    assert.equal(result.data.items[0].message, '已保存 5 条新闻')
  }
  assert.deepEqual(calls, ['logs', 'steps', 'artifacts'].map(path => [`http://100.127.0.1:8100/api/runs/42/${path}`, 'GET']))
  await assert.rejects(service.dispatch('runLogs', { id: '../credentials' }), { code: 'invalid_night_all_a_request' })
  assert.equal((await new NightAllADispatchStore(null).list()).available, false)
  assert.equal((await new NightAllADispatchStore({ query: async () => { throw Error('database unavailable') } }).list()).available, false)
})

test('admin HTTP routes reject anonymous access; catalog and health do not call upstream', async () => {
  let calls = 0
  const nightAllA = new NightAllAService({ config, fetchImpl: async () => { calls++; return new Response('{"ok":true}') } })
  const service = new HubService({ store: new MemoryStore(), adapter: {}, apiKeyPepper: 'test-pepper-at-least-thirty-two-bytes' })
  const server = createServer(createApp({ service, adminToken: 'test-admin', nightAllA, externalPlatformAdmin: new MultiExternalPlatformAdminService([nightAllA]) }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const path = '/internal/v1/admin/external-platforms/night-all-a'
    const denied = await fetch(base + path + '/dispatch/health', { method: 'POST', body: '{}' })
    assert([401, 403].includes(denied.status)); assert.equal(calls, 0)
    const headers = { 'x-mx-insight-admin-token': 'test-admin' }
    assert.equal((await fetch(base + path, { headers })).status, 200)
    const historyDenied = await fetch(base + path + '/dispatches')
    assert([401, 403].includes(historyDenied.status))
    const history = await fetch(base + path + '/dispatches', { headers })
    assert.equal(history.status, 200)
    assert.equal((await history.json()).data.available, false)
    assert.equal(calls, 0)
    const allowed = await fetch(base + path + '/dispatch/health', { method: 'POST', headers, body: '{}' })
    assert.equal(allowed.status, 200); assert.equal(calls, 1)
    assert.deepEqual((await allowed.json()).data.data, { ok: true })
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('PostgreSQL journal survives service recreation and enforces unique command identity', { skip: !process.env.MX_ECOMMERCE_TEST_DATABASE_URL }, async () => {
  const { default: pg } = await import('pg')
  const pool = new pg.Pool({ connectionString: process.env.MX_ECOMMERCE_TEST_DATABASE_URL, max: 1 })
  const client = await pool.connect()
  try {
    // Temp table shadows production names for this one connection; no real rows are changed.
    const sql = await readFile(new URL('../../migrations/084_night_all_a_dispatch.sql', import.meta.url), 'utf8')
    await client.query(sql.replace('CREATE TABLE night_all_a_dispatches', 'CREATE TEMP TABLE night_all_a_dispatches'))
    let calls = 0
    const fetchImpl = async () => { calls++; return new Response('{"task":{"id":7}}', { status: 202 }) }
    const first = new NightAllAService({ config, journal: new NightAllADispatchStore(client), fetchImpl })
    const result = await first.dispatch('createTask', input, context)
    const restarted = new NightAllAService({ config, journal: new NightAllADispatchStore(client), fetchImpl })
    assert.equal((await restarted.dispatch('createTask', input, context)).replay, true)
    assert.equal((await restarted.journal.get(result.dispatchId)).state, 'completed')
    assert.equal((await restarted.journal.list()).items[0].response.data.task.id, 7)
    assert.equal(calls, 1)
  } finally { client.release(); await pool.end() }
})
