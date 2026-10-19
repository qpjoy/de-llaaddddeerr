import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, request } from 'node:http'
import { setTimeout as delay, setImmediate as tick } from 'node:timers/promises'
import { PassThrough } from 'node:stream'
import { createApp } from '../../server/app.mjs'
import { AppError } from '../../server/core/errors.mjs'
import { DataAdmission, dataAdmissionConfig, dataAdmissionLane } from '../../server/core/data-admission.mjs'
import { loadConfig } from '../../server/config.mjs'
import { bodyReadTimeoutMs, readJson } from '../../server/core/http.mjs'

const context = { consumer: { id: 'consumer' }, apiKey: { id: 'key' } }
const result = { status: 200, body: { data: { items: [] } }, replay: false, requestId: 'business-id' }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
async function until(predicate) {
  const deadline = Date.now() + 5000
  while (!predicate()) { if (Date.now() > deadline) assert.fail('condition did not become true'); await delay(5) }
}
async function fixture(t, { service = {}, admission = new DataAdmission(), ...options } = {}) {
  const app = createApp({ service: { authenticate: async () => context, ...service }, store: {}, adapter: {},
    dataAdmission: admission, adminToken: 'local-fixture', logger: { error() {} }, ...options })
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (path, body = {}) => fetch(base + path, { method: 'POST',
    headers: { authorization: 'Bearer mih_live_fixture', 'content-type': 'application/json', 'idempotency-key': 'same-original-key' }, body: JSON.stringify(body) })
  return { base, post, admission }
}

test('300 simultaneous canonical HTTP requests wait before authentication and all drain under four execution slots', async t => {
  const blocked = deferred()
  let authenticated = 0, active = 0, peak = 0, completed = 0
  const f = await fixture(t, { service: {
    authenticate: async () => { authenticated++; return context },
    canonicalSearch: async (_context, input) => {
      assert.equal(input.idempotencyKey, 'same-original-key')
      active++; peak = Math.max(peak, active)
      await blocked.promise; await tick(); active--; completed++
      return result
    },
  } })
  t.after(() => blocked.resolve())
  let firstFailure
  const requests = []
  for (let i = 0; i < 300; i++) {
    requests.push(f.post('/api/v1/data/canonical/search', { query: `fixture-${i}` })
      .catch(error => { firstFailure ??= error; return null }))
    // Allow the loopback listener to accept SYNs between groups; all handlers
    // remain blocked, so 300 requests still overlap at the application gate.
    if (i % 10 === 9) await delay(5)
  }
  await until(() => {
    if (firstFailure) throw firstFailure.cause || firstFailure
    return f.admission.snapshot().lanes.read.pending === 296
  })
  assert.equal(authenticated, 4)
  assert.equal(f.admission.snapshot().lanes.read.active, 4)
  blocked.resolve()
  const responses = await Promise.all(requests)
  assert.ok(responses.every(r => r.status === 200))
  await Promise.all(responses.map(r => r.json()))
  assert.equal(completed, 300); assert.equal(peak, 4)
  assert.deepEqual([f.admission.snapshot().lanes.read.active, f.admission.snapshot().lanes.read.pending], [0, 0])
})

test('FIFO bounded waiting, timeout, cancellation and double release never leak a slot or run expired work', async () => {
  const admission = new DataAdmission({ readConcurrency: 1, maxPending: 2, maxWaitMs: 30 })
  const first = await admission.acquire('read')
  const controller = new AbortController()
  const cancelled = admission.acquire('read', { signal: controller.signal })
  const expired = admission.acquire('read')
  await assert.rejects(admission.acquire('read'), error => error.code === 'hub_data_busy' && error.details.reason === 'queue_full')
  controller.abort()
  await assert.rejects(cancelled, { code: 'request_cancelled' })
  await assert.rejects(expired, error => error.details.reason === 'queue_timeout')
  first(); first()
  const order = []
  const hold = await admission.acquire('read')
  const a = admission.acquire('read').then(release => { order.push('a'); release() })
  const b = admission.acquire('read').then(release => { order.push('b'); release() })
  hold(); await Promise.all([a, b])
  assert.deepEqual(order, ['a', 'b'])
  assert.deepEqual(admission.snapshot().lanes.read, {
    concurrency: 1, active: 0, pending: 0, oldestWaitMs: 0, admitted: 4, completed: 4,
    rejected: 1, timedOut: 1, cancelled: 1, highWater: 2,
  })
})

test('default forwarding has no extra whole-request cap ahead of saved replay, cache or history', async t => {
  const blocked = deferred()
  let live = 0, replayed = 0, cached = 0
  const f = await fixture(t, { service: {
    search: async (_context, { body, idempotencyKey }) => {
      assert.equal(idempotencyKey, 'same-original-key')
      if (body.mode === 'replay') { replayed++; return { ...result, replay: true } }
      if (body.mode === 'cache') { cached++; return { ...result, sourceMode: 'fresh_cache' } }
      live++; await blocked.promise; return result
    },
  }, acquisitionHistory: { getPublicDeliveredRun: async () => ({ items: [{ id: 'saved-record' }] }) } })
  t.after(() => blocked.resolve())
  const active = Array.from({ length: 40 }, () => f.post('/api/v1/data/search', { mode: 'live' }))
  await until(() => live === 40)
  assert.equal(f.admission.snapshot().lanes.acquisition.concurrency, 0)
  assert.equal(f.admission.snapshot().lanes.acquisition.pending, 0)
  const replay = await f.post('/api/v1/data/search', { mode: 'replay' })
  assert.equal(replay.status, 200); assert.equal(replay.headers.get('idempotent-replay'), 'true')
  await replay.json()
  const cache = await f.post('/api/v1/data/search', { mode: 'cache' })
  assert.equal(cache.status, 200); assert.equal(cache.headers.get('x-mx-insight-source-mode'), 'fresh_cache')
  await cache.json()
  const history = await fetch(f.base + '/api/v1/acquisitions/business-id')
  assert.equal(history.status, 200)
  assert.deepEqual((await history.json()).data.items, [{ id: 'saved-record' }])
  assert.equal(live, 40); assert.equal(replayed, 1); assert.equal(cached, 1)
  assert.equal(f.admission.snapshot().lanes.acquisition.active, 40)
  blocked.resolve()
  await Promise.all((await Promise.all(active)).map(r => r.json()))
  assert.equal(f.admission.snapshot().lanes.acquisition.active, 0)
})

test('a full read queue preserves acquisition, health, original receipt, sign-in and Admin pressure access', async t => {
  const blocked = deferred()
  const admission = new DataAdmission({ readConcurrency: 1, maxPending: 1, maxWaitMs: 5000 })
  const f = await fixture(t, { admission, service: {
    canonicalSearch: async () => { await blocked.promise; return result }, search: async () => result,
    requestStatusByIdempotencyKey: async (_context, key) => ({ status: 'unknown', key }),
  } })
  t.after(() => blocked.resolve())
  const a = f.post('/api/v1/data/canonical/search')
  await until(() => admission.snapshot().lanes.read.active === 1)
  const b = f.post('/api/v1/data/canonical/search')
  await until(() => admission.snapshot().lanes.read.pending === 1)
  const rejected = await f.post('/api/v1/data/canonical/search')
  assert.equal(rejected.status, 503); assert.equal(rejected.headers.get('retry-after'), '1')
  const details = (await rejected.json()).error.details
  assert.equal(details.currentAttemptStarted, false)
  assert.equal(details.automaticRetryAllowed, undefined)
  assert.equal(details.upstreamDispatched, undefined)
  assert.equal((await f.post('/api/v1/data/search')).status, 200)
  assert.equal((await fetch(f.base + '/health/live')).status, 200)
  assert.equal((await fetch(f.base + '/internal/v1/admin/sign-in-options')).status, 200)
  const status = await fetch(f.base + '/api/v1/requests/by-idempotency-key', { headers: { 'idempotency-key': 'same-original-key' } })
  assert.deepEqual((await status.json()).data, { status: 'unknown', key: 'same-original-key' })
  const pressure = await fetch(f.base + '/internal/v1/admin/data-pressure', { headers: { authorization: 'Bearer local-fixture' } })
  assert.equal(pressure.status, 200)
  assert.equal((await pressure.json()).data.admission.lanes.read.pending, 1)
  assert.equal((await fetch(f.base + '/internal/v1/admin/data-pressure')).status, 401)
  blocked.resolve(); await Promise.all([a, b])
})

test('queued disconnect does not authenticate; active disconnect keeps slot until settlement finishes', async t => {
  const blocked = deferred()
  let authCalls = 0
  const admission = new DataAdmission({ acquisitionConcurrency: 1 })
  const f = await fixture(t, { admission, service: {
    authenticate: async () => { authCalls++; return context },
    search: async () => { await blocked.promise; return result },
  } })
  t.after(() => blocked.resolve())
  const start = () => {
    const client = request(f.base + '/api/v1/data/search', { method: 'POST' })
    client.on('error', () => {}); client.end('{}'); return client
  }
  const active = start(); t.after(() => active.destroy())
  await until(() => authCalls === 1)
  const queued = start(); t.after(() => queued.destroy())
  await until(() => admission.snapshot().lanes.acquisition.pending === 1)
  queued.destroy()
  await until(() => admission.snapshot().lanes.acquisition.pending === 0)
  assert.equal(authCalls, 1)
  active.destroy(); await delay(20)
  assert.equal(admission.snapshot().lanes.acquisition.active, 1)
  blocked.resolve()
  await until(() => admission.snapshot().lanes.acquisition.active === 0)
})

test('queued requests recheck current authorization and handler errors always release admission', async t => {
  const blocked = deferred()
  let revoked = false, calls = 0
  const admission = new DataAdmission({ readConcurrency: 1 })
  const f = await fixture(t, { admission, service: {
    authenticate: async () => { if (revoked) throw new AppError(403, 'revoked', 'revoked'); return context },
    canonicalSearch: async () => { calls++; await blocked.promise; throw new AppError(503, 'fixture_failure', 'fixture') },
  } })
  t.after(() => blocked.resolve())
  const first = f.post('/api/v1/data/canonical/search')
  await until(() => calls === 1)
  const second = f.post('/api/v1/data/canonical/search')
  await until(() => admission.snapshot().lanes.read.pending === 1)
  revoked = true; blocked.resolve()
  assert.equal((await first).status, 503); assert.equal((await second).status, 403)
  assert.equal(calls, 1); assert.equal(admission.snapshot().lanes.read.active, 0)
})

test('route classification and configuration bound data work without gating identity, payment or recovery', () => {
  for (const path of ['/auth/sso/login', '/api/v1/requests/id', '/api/v1/acquisitions/id',
    '/internal/v1/admin/sign-in', '/internal/v1/portal/local/login', '/internal/v1/admin/payments', '/health/ready']) {
    assert.equal(dataAdmissionLane('GET', path), null)
    assert.equal(dataAdmissionLane('POST', path), null)
  }
  assert.equal(dataAdmissionLane('OPTIONS', '/api/v1/data/search'), null)
  assert.equal(dataAdmissionLane('POST', '/api/v2/data/search'), 'acquisition')
  assert.equal(dataAdmissionLane('POST', '/api/v1/search/raw'), 'acquisition')
  assert.equal(dataAdmissionLane('GET', '/api/v1/data/canonical/items/id/timeline'), 'read')
  assert.equal(dataAdmissionLane('GET', '/api/v1//data/canonical/items/id/context/'), 'read')
  assert.equal(dataAdmissionLane('GET', '/internal/v1/admin/data-center/records'), 'read')
  assert.equal(dataAdmissionLane('POST', '/internal/v1/admin/retrieval/search'), 'read')
  assert.equal(dataAdmissionLane('POST', '/internal/v1/admin/data-browser/advanced/answer'), 'read')
  const env = { MX_INSIGHT_ADMIN_TOKEN: 'fixture', MX_INSIGHT_API_KEY_PEPPER: 'fixture' }
  const config = loadConfig(env)
  assert.deepEqual(config.dataAdmission, dataAdmissionConfig())
  assert.equal(config.dataAdmission.acquisitionConcurrency, 0)
  assert.equal(config.dataAdmission.maxWaitMs, 30000)
  assert.equal(loadConfig({ ...env, MX_INSIGHT_DATA_API_ACQUISITION_CONCURRENCY: '8' }).dataAdmission.acquisitionConcurrency, 8)
  assert.deepEqual(config.ingestWorker, { concurrency: 1, postBatchDelayMs: 100 })
  assert.deepEqual(config.projectorWorker, { postBatchDelayMs: 250 })
  for (const [name, bad] of [
    ['MX_INSIGHT_DATA_API_READ_CONCURRENCY', '33'], ['MX_INSIGHT_DATA_API_WAIT_MS', '30001'],
    ['MX_INSIGHT_DATA_API_MAX_PENDING', '0'], ['MX_INSIGHT_DATA_API_MAX_PENDING', 'NaN'],
    ['MX_INSIGHT_DATA_API_ACQUISITION_CONCURRENCY', '-1'], ['MX_INSIGHT_DATA_API_READ_CONCURRENCY', '0'],
    ['MX_INSIGHT_INGEST_WORKER_CONCURRENCY', '5'], ['MX_INSIGHT_PROJECTOR_WORKER_DELAY_MS', '-1'],
  ]) assert.throws(() => loadConfig({ ...env, [name]: bad }), { code: 'invalid_configuration' })
})

test('data body timeout terminates the reader before execution and ordinary small bodies retain validation', async () => {
  const stalled = new PassThrough()
  stalled[bodyReadTimeoutMs] = 20
  stalled.write('{')
  await assert.rejects(readJson(stalled), { code: 'request_body_timeout' })
  assert.equal(stalled.destroyed, true)
  const valid = new PassThrough()
  valid[bodyReadTimeoutMs] = 20
  valid.end('{"fixture":true}')
  assert.deepEqual(await readJson(valid), { fixture: true })
  const oversized = new PassThrough()
  oversized[bodyReadTimeoutMs] = 20
  oversized.end('{"fixture":true}')
  await assert.rejects(readJson(oversized, 2), { code: 'payload_too_large' })
})
