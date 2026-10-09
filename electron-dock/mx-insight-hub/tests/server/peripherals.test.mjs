import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import pg from 'pg'
import { PeripheralService } from '../../server/peripherals/service.mjs'
import { PeripheralStore, MemoryPeripheralStore } from '../../server/peripherals/store.mjs'
import { createPeripheralTransport } from '../../server/peripherals/transport.mjs'
import { createPeripheralRuntime } from '../../server/peripherals/runtime.mjs'
import { createApp } from '../../server/app.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { HubService } from '../../server/hub-service.mjs'

const note = 'https://www.xiaohongshu.com/explore/note-1?xsec_token=mock%2Btoken&xsec_source=app_search_result'
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const response = (op, input) => {
  const result = op === 'state' ? { undocumentedState: 'connected' }
    : op === 'note' ? { ok: true, detail: { id: 'note-1', title: 'mock', content: '完整正文' } }
      : { ok: true, type: 'search', keyword: input.keyword, page: op === 'search' ? 1 : input.expectedPage + 1, hasMore: true, count: 1, items: [{ id: 'note-1', detailInput: note }] }
  return { result, responseText: JSON.stringify(result), httpStatus: 200 }
}
async function fixture({ store, call } = {}) {
  let now = Date.now()
  const calls = []
  store ||= new MemoryPeripheralStore({ clock: () => now })
  const transport = { origins: ['http://127.0.0.1:18081'], assertOrigin() {}, async call(d, op, input) { calls.push({ d, op, input }); return call ? call(d, op, input) : response(op, input) } }
  const service = new PeripheralService({ store, transport })
  const register = async (suffix = randomUUID()) => service.register({ name: 'Mock phone', host: 'mock-host', serial: suffix, accountKey: suffix, origin: `http://${suffix}.invalid:18081` })
  const device = await register()
  const control = async (action, body = {}, id = device.id) => service.control(id, { ...body, action, revision: (await service.inspect(id)).device.revision })
  const ready = async (id = device.id) => { await service.probe(id); await control('enable', {}, id) }
  const submit = (body = {}, id = device.id) => service.submit(id, { operation: 'search', keyword: '测试关键词', idempotencyKey: randomUUID(), ...body })
  const execute = async (id = device.id) => { const claim = await service.claim(id); assert.ok(claim); await service.execute(claim); return claim.job }
  return { service, store, transport, device, control, ready, submit, execute, calls, register, advance: ms => { now += ms } }
}

test('default paused, observation never calls device; probe is only /state, current proof required to enable', async () => {
  const f = await fixture()
  assert.equal(f.device.enabled, false)
  await f.service.overview(); await f.service.inspect(f.device.id); assert.equal(f.calls.length, 0)
  await assert.rejects(f.submit(), { code: 'peripheral_unavailable' })
  await assert.rejects(f.control('enable'), { code: 'peripheral_probe_required' })
  await f.service.probe(f.device.id); assert.deepEqual(f.calls.map(c => c.op), ['state'])
  f.advance(60_001); await assert.rejects(f.control('enable'), { code: 'peripheral_probe_required' })
  await f.ready(); assert.equal((await f.service.inspect(f.device.id)).device.enabled, true)
})

test('duplicate concurrent submissions replay one durable job; key/body conflicts rejected even after completion', async () => {
  const f = await fixture(); await f.ready()
  const body = { idempotencyKey: 'same-key' }
  const jobs = await Promise.all(Array.from({ length: 20 }, () => f.submit(body)))
  assert.equal(new Set(jobs.map(j => j.id)).size, 1)
  await assert.rejects(f.submit({ ...body, keyword: 'changed' }), { code: 'peripheral_idempotency' })
  await f.execute()
  assert.equal((await f.submit(body)).status, 'succeeded')
  assert.equal(f.calls.filter(c => c.op === 'search').length, 1)
  assert.equal((await f.service.job(f.device.id, jobs[0].id)).responseText, JSON.stringify(response('search', { keyword: '测试关键词' }).result))
})

test('session pinning prevents interleaved search/detail and double /next; cooldown is completion-based', async () => {
  const f = await fixture(); await f.ready(); await f.submit(); await f.execute()
  const session = (await f.service.inspect(f.device.id)).device.session
  await assert.rejects(f.submit({ keyword: 'different' }), { code: 'peripheral_session_busy' })
  await assert.rejects(f.submit({ operation: 'note', input: note }), { code: 'peripheral_session_busy' })
  const body = { operation: 'next', sessionId: session.id, expectedPage: 1, idempotencyKey: 'page-2' }
  const next = await f.submit(body)
  assert.equal(await f.service.claim(f.device.id), null)
  await assert.rejects(f.submit({ ...body, idempotencyKey: 'another-page-2' }), { code: 'peripheral_session' })
  f.advance(2000); await f.execute()
  assert.equal((await f.submit(body)).id, next.id)
  assert.equal((await f.service.inspect(f.device.id)).device.session.page, 2)
  await assert.rejects(f.submit({ ...body, idempotencyKey: 'stale-page' }), { code: 'peripheral_session' })
  await f.control('close-session', { sessionId: session.id })
  await f.submit({ operation: 'note', input: note }); f.advance(2000); await f.execute()
  assert.deepEqual(f.calls.map(c => c.op), ['state','search','next','note'])
})

test('multiple workers contend for one device; independent devices run concurrently', async () => {
  const latch = deferred(), f = await fixture({ call: (d, op, input) => op === 'state' ? response(op) : latch.promise.then(() => response(op, input)) })
  await f.ready(); const b = await f.register(); await f.ready(b.id)
  await f.submit(); await f.submit({}, b.id)
  const peer = new PeripheralService({ store: f.store, transport: f.transport })
  await Promise.all([f.service.tick(), peer.tick()])
  await new Promise(setImmediate)
  assert.equal(f.calls.filter(c => c.op === 'search').length, 2)
  assert.equal((await f.service.inspect(f.device.id)).device.state, 'running')
  assert.equal((await f.service.inspect(b.id)).device.state, 'running')
  latch.resolve(); await Promise.all([f.service.close(), peer.close()])
})

test('timeout quarantines, cancels queued work, never retries; recovery is revision-guarded and preserves unknown', async () => {
  const f = await fixture({ call: (d, op) => op === 'state' ? response(op) : Promise.reject(new Error('timeout SECRET')) })
  await f.ready()
  const job = await f.submit({ operation: 'note', input: note }), queued = await f.submit({ operation: 'note', input: note })
  await f.execute()
  assert.equal((await f.service.job(f.device.id, job.id)).status, 'unknown')
  assert.equal((await f.service.job(f.device.id, queued.id)).status, 'cancelled')
  assert.equal(await f.service.claim(f.device.id), null)
  await assert.rejects(f.control('recover', { confirmedStopped: true, reason: 'checked' }), { code: 'peripheral_recovery' })
  f.advance(60_001); await f.service.probe(f.device.id)
  await assert.rejects(f.control('recover', { reason: 'checked' }), { code: 'peripheral_recovery' })
  const stale = (await f.service.inspect(f.device.id)).device.revision
  await f.control('recover', { confirmedStopped: true, reason: 'Old executor stopped; phone idle; no bypass' })
  await assert.rejects(f.service.control(f.device.id, { action: 'recover', revision: stale, confirmedStopped: true, reason: 'repeat' }), { code: 'peripheral_revision' })
  assert.equal((await f.service.inspect(f.device.id)).device.enabled, false)
  assert.equal((await f.service.job(f.device.id, job.id)).status, 'unknown')
  assert.equal(f.calls.filter(c => c.op === 'note').length, 1)
})

test('crashed claim expires into quarantine; old execution cannot send after expiry', async () => {
  const f = await fixture(); await f.ready(); const job = await f.submit(); const old = await f.service.claim(f.device.id)
  f.advance(60_001)
  const peer = new PeripheralService({ store: f.store, transport: f.transport })
  assert.equal(await peer.claim(f.device.id), null)
  await f.service.execute(old)
  assert.equal((await f.service.job(f.device.id, job.id)).status, 'unknown')
  assert.equal(f.calls.filter(c => c.op === 'search').length, 0)
})

test('late response is retained as late evidence, never releases a quarantined or recovered device', async () => {
  const latch = deferred(), f = await fixture({ call: (d, op, input) => op === 'state' ? response(op) : latch.promise.then(() => response(op, input)) })
  await f.ready(); const job = await f.submit(), claim = await f.service.claim(f.device.id)
  const executing = f.service.execute(claim)
  await new Promise(setImmediate); f.advance(60_001); await f.service.claim(f.device.id)
  await f.service.probe(f.device.id); await f.control('recover', { confirmedStopped: true, reason: 'Fixture simulates isolated old executor' })
  latch.resolve(); await executing
  const saved = await f.service.job(f.device.id, job.id)
  assert.equal(saved.status, 'unknown'); assert.equal(saved.lateEvidence.httpStatus, 200)
  assert.equal((await f.service.inspect(f.device.id)).device.enabled, false)
})

for (const httpStatus of [400,404,409,504]) test(`HTTP ${httpStatus} conservatively quarantines without retry or assuming physical idle`, async () => {
  const f = await fixture({ call: (d, op) => op === 'state' ? response(op) : { httpStatus, result: { ok: false, error: 'busy' }, responseText: '{"ok":false}' } })
  await f.ready(); await f.submit(); await f.execute()
  assert.equal((await f.service.inspect(f.device.id)).device.state, 'quarantined')
  assert.equal(await f.service.claim(f.device.id), null)
})

test('mismatched keyword/page/detail identity and unparseable body cannot be recorded as successful', async () => {
  for (const bad of [{ ok: true }, { ...response('search', { keyword: 'wrong' }).result }, { ...response('search', { keyword: '测试关键词' }).result, page: 7 }, null]) {
    const f = await fixture({ call: (d, op) => op === 'state' ? response(op) : { httpStatus: 200, result: bad, responseText: JSON.stringify(bad) } })
    await f.ready(); await f.submit(); await f.execute()
    assert.equal((await f.service.inspect(f.device.id)).device.state, 'quarantined')
  }
})

test('pause drains in-flight work, pending cancellation is safe, queue has backpressure and deadline', async () => {
  const f = await fixture(); await f.ready()
  const job = await f.submit({ operation: 'note', input: note }), claim = await f.service.claim(f.device.id)
  await f.control('pause'); await f.service.execute(claim)
  assert.equal((await f.service.job(f.device.id, job.id)).status, 'succeeded')
  await f.ready(); for (let i = 0; i < 20; i++) await f.submit({ operation: 'note', input: note })
  await assert.rejects(f.submit({ operation: 'note', input: note }), { status: 429 })
  const first = (await f.service.inspect(f.device.id)).jobs.find(j => j.status === 'queued')
  await f.control('cancel', { jobId: first.id })
  f.advance(300_001); assert.equal(await f.service.claim(f.device.id), null)
  assert.equal((await f.service.inspect(f.device.id)).jobs.filter(j => j.status === 'expired').length, 19)
})

test('configuration changes require pause and drain; duplicate resource registration fails', async () => {
  const f = await fixture()
  await assert.rejects(f.service.register(f.device), { code: 'peripheral_duplicate' })
  await f.ready(); await assert.rejects(f.control('configure', { ...f.device, name: 'edit' }), { code: 'peripheral_config_busy' })
  await f.control('pause'); await f.control('configure', { ...f.device, name: 'edit' })
  assert.equal((await f.service.inspect(f.device.id)).device.probe, null)
})

test('a late probe cannot attest to an edited connection', async () => {
  const latch = deferred(), f = await fixture({ call: () => latch.promise })
  const probing = f.service.probe(f.device.id)
  await new Promise(setImmediate)
  await f.control('configure', { ...f.device, origin: 'http://other.invalid:18081' })
  latch.resolve(response('state'))
  await assert.rejects(probing, { code: 'peripheral_revision' })
  assert.equal((await f.service.inspect(f.device.id)).device.probe, null)
})

test('revoked origin pauses only its device; remaining devices still dispatch', async () => {
  const f = await fixture(); await f.ready(); const other = await f.register(); await f.ready(other.id)
  await f.submit(); await f.submit({}, other.id)
  f.transport.assertOrigin = origin => { if (origin === f.device.origin) throw Error('revoked') }
  await f.service.tick(); await new Promise(setImmediate); await f.service.close()
  assert.equal((await f.service.inspect(f.device.id)).device.enabled, false)
  assert.equal((await f.service.inspect(other.id)).jobs[0].status, 'succeeded')
})

test('deploy preserves omitted origins, respects explicit empty and fails closed on lookup error', () => {
  const script = new URL('../../scripts/manage.sh', import.meta.url).pathname
  const run = body => execFileSync('bash', ['-c', `set -euo pipefail; source "$1"; ${body}`, '_', script], { encoding: 'utf8' })
  assert.equal(run('unset MX_INSIGHT_PERIPHERAL_ORIGINS; kubectl() { printf "http://phone.internal:18081"; }; preserve_existing_peripheral_runtime_config; printf "%s" "$MX_INSIGHT_PERIPHERAL_ORIGINS"'), 'http://phone.internal:18081')
  assert.equal(run('MX_INSIGHT_PERIPHERAL_ORIGINS=""; kubectl() { exit 99; }; preserve_existing_peripheral_runtime_config; printf "%s" "$MX_INSIGHT_PERIPHERAL_ORIGINS"'), '')
  assert.throws(() => run('unset MX_INSIGHT_PERIPHERAL_ORIGINS; kubectl() { return 1; }; preserve_existing_peripheral_runtime_config'), { status: 1 })
})

async function listen(t, handler) {
  const server = createServer(handler)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  return `http://127.0.0.1:${server.address().port}`
}
test('real HTTP adapter encodes detailInput exactly, rejects redirects/origin overrides and bounds malformed evidence', async t => {
  const seen = []
  const base = await listen(t, (req, res) => {
    const url = new URL(req.url, 'http://mock'); seen.push(url)
    if (url.searchParams.get('keyword') === 'redirect') { res.writeHead(302, { location: '/api/note' }); res.end(); return }
    res.setHeader('content-type','application/json'); res.end(JSON.stringify({ ok: true }))
  })
  const adapter = createPeripheralTransport({ origins: [base] })
  await adapter.call({ origin: base }, 'note', { input: note })
  assert.equal(seen[0].searchParams.get('input'), note)
  await assert.rejects(adapter.call({ origin: 'http://untrusted.invalid' }, 'search', {}), { code: 'peripheral_origin_not_allowed' })
  await assert.rejects(adapter.call({ origin: base }, 'search', { keyword: 'redirect' }))
  assert.equal(seen.length, 2)
  assert.throws(() => createPeripheralTransport({ origins: [`${base}/arbitrary`] }))
})

test('Admin Token only, public hidden, memory disabled, dependency failure does not affect admin login', async t => {
  const f = await fixture()
  const app = async (mode = 'combined', peripherals = f.service) => {
    const store = new MemoryStore(), service = new HubService({ store, adapter: {}, apiKeyPepper: 'fixture-only-pepper-at-least-32-bytes' })
    return listen(t, createApp({ store, service, adapter: {}, adminToken: 'test-admin', peripherals, listenerMode: mode,
      identity: { enabled: true, resolve: async () => ({ kind: 'launcher', platformAdmin: true, tenantIds: [], capabilities: [], memberships: [] }) }, logger: { error() {} } }))
  }
  const base = await app(), root = '/internal/v1/admin/peripherals'
  const get = (url, token) => fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} })
  assert.equal((await get(base + root)).status, 401)
  assert.equal((await get(base + root, 'launcher-admin')).status, 403)
  assert.equal((await get(base + root, 'mih_live_fixture')).status, 403)
  assert.equal((await get(base + root, 'test-admin')).status, 200)
  assert.equal(f.calls.length, 0)
  assert.equal((await get(await app('public') + root, 'test-admin')).status, 404)
  assert.equal((await (await get(await app('combined', null) + root, 'test-admin')).json()).data.available, false)
  const broken = await app('combined', { overview: () => { const error = Error('private db'); error.code = '42P01'; throw error } })
  assert.equal((await get(broken + root, 'test-admin')).status, 503)
  assert.equal((await get(broken + '/internal/v1/admin/session', 'test-admin')).status, 200)
  assert.equal(createPeripheralRuntime({ storeDriver: 'memory' }), null)
  assert.equal(createPeripheralRuntime({ storeDriver: 'postgres', listenerMode: 'public' }), null)
})

test('PostgreSQL: real concurrent connections, persisted restart, unique resources, history cursor and unknown fencing',
  { skip: !process.env.MX_INSIGHT_PERIPHERAL_TEST_DATABASE_URL }, async t => {
    const admin = new pg.Pool({ connectionString: process.env.MX_INSIGHT_PERIPHERAL_TEST_DATABASE_URL })
    const name = `mih_peripheral_test_${randomUUID().replaceAll('-', '')}`
    await admin.query(`CREATE DATABASE ${name}`)
    const url = new URL(process.env.MX_INSIGHT_PERIPHERAL_TEST_DATABASE_URL); url.pathname = `/${name}`
    const pool = new pg.Pool({ connectionString: url.href, max: 10 })
    t.after(async () => { await pool.end(); await admin.query(`DROP DATABASE ${name}`); await admin.end() })
    await pool.query(await readFile(new URL('../../migrations/139_peripheral_scheduler.sql', import.meta.url), 'utf8'))
    const f = await fixture({ store: new PeripheralStore(pool) }); await f.ready()
    const jobs = await Promise.all(Array.from({ length: 20 }, () => f.submit({ idempotencyKey: 'pg-same' })))
    assert.equal(new Set(jobs.map(j => j.id)).size, 1)
    const peer = new PeripheralService({ store: new PeripheralStore(pool), transport: f.transport })
    const claims = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? peer : f.service).claim(f.device.id)))
    assert.equal(claims.filter(Boolean).length, 1)
    const claim = claims.find(Boolean)
    await f.service.execute(claim)
    assert.equal((await peer.job(f.device.id, jobs[0].id)).status, 'succeeded')
    await assert.rejects(f.service.register(f.device), { code: 'peripheral_duplicate' })
    await f.control('close-session', { sessionId: (await peer.inspect(f.device.id)).device.session.id })
    for (let i = 0; i < 53; i++) { const j = await f.submit({ operation: 'note', input: note }); await f.control('cancel', { jobId: j.id }) }
    const page1 = await peer.inspect(f.device.id), page2 = await peer.inspect(f.device.id, page1.next)
    assert.equal(page1.jobs.length, 50); assert.equal(page2.jobs.length, 4)
    assert.equal(new Set([...page1.jobs, ...page2.jobs].map(j => j.id)).size, 54)
    const uncertain = await f.submit({ operation: 'note', input: note })
    await pool.query("UPDATE peripherals.devices SET document=jsonb_set(document,'{cooldownUntil}','0') WHERE id=$1", [f.device.id])
    await peer.claim(f.device.id)
    await pool.query("UPDATE peripherals.jobs SET document=jsonb_set(document,'{leaseUntil}','0') WHERE id=$1", [uncertain.id])
    const restarted = new PeripheralService({ store: new PeripheralStore(pool), transport: f.transport })
    assert.equal(await restarted.claim(f.device.id), null)
    assert.equal((await restarted.job(f.device.id, uncertain.id)).status, 'unknown')
    assert.equal((await restarted.inspect(f.device.id)).device.state, 'quarantined')
    const other = await f.register(); await f.ready(other.id); await f.submit({}, other.id)
    assert.ok(await restarted.claim(other.id))
  })
