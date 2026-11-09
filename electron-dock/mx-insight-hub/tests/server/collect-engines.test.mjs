import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createApp } from '../../server/app.mjs'
import { HubService, businessApiScopes } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { MemoryCollectStore } from '../../server/collect/store.mjs'
import { CollectExecutor } from '../../server/collect/executor.mjs'
import { CollectService, retryAfterSeconds, estimateStart } from '../../server/collect/service.mjs'
import { createCollectContracts } from '../../server/collect/contracts/index.mjs'
import { classifyEnvelope, runnerContract } from '../../server/collect/contracts/runner.mjs'
import { normalizeJobRequest, normalizeBatchRequest, capabilityDefinition } from '../../server/collect/catalog.mjs'
import { dataAdmissionLane } from '../../server/core/data-admission.mjs'
import { COLLECT, COLLECT_CAPABILITY_KEYS } from '../../shared/collect-engines.mjs'

const PEPPER = 'collect-engines-test-pepper-at-least-32-bytes'
const ADMIN_TOKEN = 'collect-engines-admin-token'
const CAP = 'collect.app.details'
const PREFIX = COLLECT.apiPrefix
const ENGINE = 'runner.market-195'
const envelope = (status = 'success', items = [{ app_id: '108048', name: '小米商城' }]) => ({
  schema_version: '1.0', project_id: '195', source_id: '195', operation: 'collect', observed_at: '2026-11-09T08:00:00Z',
  status, result: { items }, error: status === 'error' ? { code: 'UPSTREAM_404', message: 'app not found' } : null,
})
const refused = code => Object.assign(new TypeError('fetch failed'), { cause: { code } })

// A scriptable runner: POST answers from `start`, GET answers from `state`.
function fakeRunner({ start = () => ({ status: 202, body: { data: { state: 'accepted' } } }), state = () => ({ status: 200, body: { data: { state: 'running' } } }) } = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname
    const call = { method: init.method || 'GET', path, body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.authorization || null }
    calls.push(call)
    if (path === '/v1/health') return Response.json({ data: { ok: true, version: 'runner-test', capacity: 4, running: 0,
      slots: [{ slotId: 'market-195', available: true, reason: null, operations: ['collect'] }] } })
    const answer = call.method === 'POST' ? start(call) : state(call, path.split('/').pop())
    if (answer instanceof Error) throw answer
    return Response.json(answer.body, { status: answer.status })
  }
  return { calls, fetchImpl }
}

async function fixture({ grant = true, runner = fakeRunner(), engine = {}, credentials = { 'collect-runner': 'runner-token' } } = {}) {
  const ledger = new MemoryStore()
  const hub = new HubService({ store: ledger, adapter: {}, apiKeyPepper: PEPPER })
  const tenant = await hub.createTenant({ name: 'Delta' })
  const consumer = await hub.createConsumer({ tenantId: tenant.id, name: 'LCY-delta' })
  await ledger.setPlatformGrant(consumer.id, 'app_market', true)
  await hub.putCapabilityConfiguration(CAP, { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await hub.createApiKey({ consumerId: consumer.id, name: 'delta', platforms: ['app_market'], capabilities: grant ? [CAP] : [] })
  const context = await hub.authenticate(key.secret)
  const jobs = new MemoryCollectStore()
  const contracts = createCollectContracts()
  const credentialsFor = async provider => credentials[provider] ?? null
  const executor = new CollectExecutor({ jobs, ledger, contracts, credentialsFor, logger: { error() {}, warn() {} }, pollMs: 60_000,
    policyFor: (ctx, platform) => hub.usagePolicy(ctx, platform), fetchImpl: runner.fetchImpl })
  executor.stopped = false
  const service = new CollectService({ jobs, ledger, contracts, executor, credentialsFor, fetchImpl: runner.fetchImpl })
  if (engine !== null) {
    await service.adminCreateEngine({ id: ENGINE, kind: 'runner', displayName: '小米应用商店 runner', slotRef: 'market-195',
      baseUrl: 'http://127.0.0.1:18300', routes: [{ capability: CAP, routeKey: 'xiaomi' }], enabled: true, reason: '测试引擎', ...engine }, 'tester')
  }
  return { ledger, hub, tenant, consumer, key, context, jobs, executor, service, runner }
}

const appIds = n => Array.from({ length: n }, (_, index) => String(100 + index))
const submit = (fx, ids = ['108048'], idem = `delta-${Math.random().toString(36).slice(2, 12)}`) =>
  fx.service.submitJob(fx.context, { capability: CAP, input: { market: 'xiaomi', appIds: ids } }, idem)
// Make every waiting job due now, then let the executor check them.
async function checkNow(fx) {
  for (const job of fx.jobs.jobs.values()) if (job.phase === 'waiting') job.nextCheckAt = new Date(Date.now() - 1).toISOString()
  await fx.executor.drain()
}

test('catalog: app details accepts only reviewed fields and keeps IDs as strings', () => {
  const { definition, item } = normalizeJobRequest({ capability: CAP, input: { market: 'xiaomi', appIds: ['108048', 2882303761517] } })
  assert.equal(definition.key, CAP)
  assert.deepEqual(item.input, { market: 'xiaomi', appIds: ['108048', '2882303761517'], idKind: 'id' })
  assert.equal(item.routeKey, 'xiaomi')
  assert.deepEqual(definition.runner(item.input), { operation: 'collect', params: { inputs: ['108048', '2882303761517'], input_kind: 'id', history: false,
    max_requests: 10, timeout: 70 } })
  for (const body of [
    { capability: 'collect.nope', input: {} },
    { capability: CAP, input: { market: 'huawei', appIds: ['1'] } },
    { capability: CAP, input: { market: 'xiaomi', appIds: [] } },
    { capability: CAP, input: { market: 'xiaomi', appIds: appIds(51) } },
    { capability: CAP, input: { market: 'xiaomi', appIds: ['com.xiaomi.shop'] } },
    { capability: CAP, input: { market: 'xiaomi', appIds: ['1', '1'] } },
    { capability: CAP, input: { market: 'xiaomi', appIds: ['1'], history: true } },
    { capability: CAP, input: { market: 'xiaomi', appIds: ['1'] }, extra: 1 },
  ]) assert.throws(() => normalizeJobRequest(body), { code: 'invalid_collect_request' }, JSON.stringify(body))
  const batch = normalizeBatchRequest({ capability: CAP, items: [{ input: { market: 'xiaomi', appIds: ['1'] }, clientRef: 'a' }, { input: { market: 'xiaomi', appIds: ['2'] } }] })
  assert.equal(batch.items.length, 2)
  assert.match(batch.fingerprint, /^[0-9a-f]{64}$/)
  assert.throws(() => normalizeBatchRequest({ capability: CAP, items: [{ input: { market: 'xiaomi', appIds: ['1'] }, clientRef: 'a' }, { input: { market: 'xiaomi', appIds: ['2'] }, clientRef: 'a' }] }),
    { code: 'invalid_collect_request' })
})

test('collection capabilities are public but never granted automatically', () => {
  assert.ok(COLLECT_CAPABILITY_KEYS.includes(CAP))
  assert.ok(COLLECT_CAPABILITY_KEYS.every(key => key.startsWith('collect.')))
  assert.equal(COLLECT_CAPABILITY_KEYS.some(key => businessApiScopes().capabilities.includes(key)), false)
  assert.equal(dataAdmissionLane('POST', `${PREFIX}/jobs`), 'read')
  assert.equal(dataAdmissionLane('GET', `${PREFIX}/jobs/abc`), 'read')
})

test('runner envelope: every adapter status maps to one outcome; the process has always ended', () => {
  const definition = capabilityDefinition(CAP)
  assert.deepEqual(['success', 'partial', 'no_data'].map(status => classifyEnvelope(envelope(status), definition).dataStatus), ['success', 'partial', 'no_data'])
  assert.equal(classifyEnvelope(envelope('success'), definition).itemCount, 1)
  assert.equal(classifyEnvelope(envelope('success'), definition).charge, true)
  const error = classifyEnvelope(envelope('error'), definition)
  assert.equal(error.status, 'failed')
  assert.equal(error.error.details.code, 'UPSTREAM_404')
  assert.ok(error.result, 'the adapter envelope is kept as evidence')
  assert.equal(classifyEnvelope(envelope('stopped')).error.code, 'adapter_stopped')
  const reported = classifyEnvelope(envelope('unknown'))
  assert.equal(reported.status, 'unknown')
  assert.equal(reported.quarantine, null, 'adapter-reported unknown does not hold the slot')
  assert.equal(classifyEnvelope({ nope: true }).error.code, 'adapter_output_unusable')
  assert.equal(classifyEnvelope(envelope('weird')).error.code, 'adapter_output_unusable')
})

test('runner start/check: ambiguous answers are reconciled, never guessed', async () => {
  const definition = capabilityDefinition(CAP)
  const engine = { baseUrl: 'http://127.0.0.1:18300', slotRef: 'market-195' }
  const job = { id: '00000000-0000-4000-8000-000000000001', input: { market: 'xiaomi', appIds: ['1'] }, checks: 0, upstreamState: null }
  const runDeadlineAt = new Date(Date.now() + 60_000).toISOString()
  const start = async answer => runnerContract.start({ engine, job, definition, credential: 'secret', runDeadlineAt,
    fetchImpl: async (url, init) => { if (answer instanceof Error) throw answer; return Response.json(answer.body, { status: answer.status }) } })
  const accepted = await start({ status: 202, body: { data: { state: 'accepted' } } })
  assert.deepEqual(accepted.upstream, { ref: job.id, state: { confirmed: true } })
  assert.equal((await start({ status: 200, body: { data: { state: 'completed', envelope: envelope(), durationMs: 900 } } })).outcome.status, 'succeeded')
  assert.equal((await start({ status: 429, body: { error: { code: 'busy' } } })).outcome.error.code, 'runner_busy')
  assert.equal((await start({ status: 400, body: {} })).outcome.error.code, 'upstream_rejected')
  assert.equal((await start({ status: 409, body: {} })).outcome.status, 'unknown')
  assert.equal((await start(refused('ECONNREFUSED'))).outcome.error.code, 'engine_unreachable')
  const lost = await start(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))
  assert.deepEqual(lost.upstream.state, { confirmed: false }, 'a timed-out POST may have arrived')
  assert.equal((await start({ status: 502, body: {} })).upstream.state.confirmed, false)

  const check = async (answer, overrides = {}) => runnerContract.check({ engine, job: { ...job, ...overrides }, definition, credential: null,
    fetchImpl: async () => answer instanceof Error ? Promise.reject(answer) : Response.json(answer.body, { status: answer.status }) })
  assert.ok((await check({ status: 200, body: { data: { state: 'running' } } })).nextCheckMs >= 2_000)
  assert.equal((await check({ status: 200, body: { data: { state: 'completed', envelope: envelope('no_data', []) } } })).outcome.dataStatus, 'no_data')
  assert.equal((await check({ status: 404, body: {} }, { upstreamState: { confirmed: true } })).outcome.error.code, 'runner_lost_invocation')
  assert.equal((await check({ status: 404, body: {} }, { checks: 1, upstreamState: { confirmed: false } })).outcome, undefined, 'one miss is not proof')
  assert.equal((await check({ status: 404, body: {} }, { checks: 3, upstreamState: { confirmed: false } })).outcome.error.code, 'engine_not_started')
  assert.ok((await check(refused('ECONNREFUSED'))).nextCheckMs > 0, 'a failed check is retried, not decided')
})

test('admin: engines start from validated input and routes are exclusive', async () => {
  const fx = await fixture({ engine: null })
  const base = { kind: 'runner', displayName: 'r', slotRef: 'market-195', baseUrl: 'http://127.0.0.1:18300', reason: '新建' }
  await assert.rejects(fx.service.adminCreateEngine({ ...base, id: 'Bad ID' }, 't'), { code: 'invalid_engine_config' })
  await assert.rejects(fx.service.adminCreateEngine({ ...base, id: 'runner.a', kind: 'apify' }, 't'), { code: 'invalid_engine_config' })
  await assert.rejects(fx.service.adminCreateEngine({ ...base, id: 'runner.a', baseUrl: 'https://example.com:443' }, 't'), { code: 'invalid_engine_base_url' })
  await assert.rejects(fx.service.adminCreateEngine({ ...base, id: 'runner.a', baseUrl: undefined }, 't'), { code: 'invalid_engine_config' })
  await assert.rejects(fx.service.adminCreateEngine({ ...base, id: 'runner.a', capacity: 65 }, 't'), { code: 'invalid_engine_config' })
  await assert.rejects(fx.service.adminCreateEngine({ ...base, id: 'runner.a', routes: [{ capability: CAP, routeKey: 'vivo' }] }, 't'), { code: 'invalid_engine_config' })
  const created = await fx.service.adminCreateEngine({ ...base, id: 'runner.a', routes: [{ capability: CAP, routeKey: 'xiaomi' }] }, 't')
  assert.equal(created.enabled, false, 'new engines start stopped')
  assert.equal(created.capacity, 1)
  await assert.rejects(fx.service.adminCreateEngine({ ...base, id: 'runner.a' }, 't'), { code: 'engine_exists' })
  await assert.rejects(fx.service.adminCreateEngine({ ...base, id: 'runner.b', routes: [{ capability: CAP, routeKey: 'xiaomi' }] }, 't'), { code: 'route_taken' })
  await assert.rejects(fx.service.adminConfigureEngine('runner.a', { capacity: 3, expectedRevision: 7, reason: '扩容' }, 't'), { code: 'engine_revision_conflict' })
  const grown = await fx.service.adminConfigureEngine('runner.a', { capacity: 3, expectedRevision: 0, reason: '扩容' }, 't')
  assert.equal(grown.revision, 1)
  assert.equal((await fx.service.adminEngine('runner.a')).slots.length, 3)
  const list = await fx.service.adminEngines()
  assert.equal(list.engines[0].routes[0].routeKey, 'xiaomi')
  assert.equal(list.legacy.length, 0)
})

test('submit: disabled, unrouted, ungranted and over-limit requests are refused before queueing', async () => {
  const fx = await fixture({ engine: { enabled: false, consumerOpenLimit: 2 } })
  await assert.rejects(submit(fx), { code: 'engine_disabled' })
  await fx.service.adminConfigureEngine(ENGINE, { enabled: true, expectedRevision: 0, reason: '启用' }, 't')
  await submit(fx)
  await submit(fx)
  await assert.rejects(submit(fx), { code: 'consumer_queue_full' })
  const ungranted = await fixture({ grant: false })
  await assert.rejects(submit(ungranted), { code: 'capability_not_granted' })
  const unrouted = await fixture({ engine: null })
  await assert.rejects(submit(unrouted), { code: 'capability_not_routed' })
  // Idempotency: same key and body replays, a different body conflicts.
  const replay = await fixture()
  const first = await submit(replay, ['1'], 'delta-replay-01')
  const again = await submit(replay, ['1'], 'delta-replay-01')
  assert.equal(again.replay, true)
  assert.equal(again.data.jobId, first.data.jobId)
  await assert.rejects(submit(replay, ['2'], 'delta-replay-01'), { code: 'idempotency_conflict' })
})

test('executor: capacity bounds concurrent runs and async checks finish them', async () => {
  const states = new Map()
  const runner = fakeRunner({ state: (call, id) => states.get(id) || { status: 200, body: { data: { state: 'running' } } } })
  const fx = await fixture({ runner, engine: { capacity: 2 } })
  const ids = []
  for (let index = 0; index < 5; index++) ids.push((await submit(fx, [String(index + 1)])).data.jobId)
  await fx.executor.drain()
  const posts = runner.calls.filter(call => call.method === 'POST')
  assert.equal(posts.length, 2, 'only as many dispatches as slots')
  assert.deepEqual(posts.map(call => call.body.params.inputs[0]), ['1', '2'], 'queue order is kept')
  assert.equal(posts[0].body.dispatchId, ids[0])
  assert.equal(posts[0].body.slotId, 'market-195')
  assert.ok(posts[0].body.deadlineMs > 0)
  assert.equal([...fx.jobs.jobs.values()].filter(job => job.phase === 'waiting').length, 2)
  const queued = await fx.service.getJob(fx.context, ids[4])
  assert.equal(queued.queue.position, 3)
  assert.ok(Date.parse(queued.queue.estimatedStartAt) > Date.now())

  states.set(ids[0], { status: 200, body: { data: { state: 'completed', envelope: envelope(), durationMs: 1200 } } })
  await checkNow(fx)
  const done = await fx.service.getJob(fx.context, ids[0])
  assert.equal(done.status, 'succeeded')
  assert.equal(done.delivery.dataStatus, 'success')
  assert.equal(done.delivery.itemCount, 1)
  assert.equal(done.billing.status, 'none', 'billing is off by default')
  const result = await fx.service.getResult(fx.context, ids[0])
  assert.equal(result.payload.result.items[0].app_id, '108048')
  assert.match(result.evidence.sha256, /^[0-9a-f]{64}$/)
  // The freed slot went to the third job on the next pass.
  await fx.executor.drain()
  assert.equal(runner.calls.filter(call => call.method === 'POST').length, 3)
})

test('executor: an unknown run keeps its slot until an operator recovers it', async () => {
  const runner = fakeRunner({ state: () => ({ status: 404, body: {} }) })
  const fx = await fixture({ runner })
  const first = (await submit(fx, ['1'])).data.jobId
  await submit(fx, ['2'])
  await fx.executor.drain()
  await checkNow(fx)
  assert.equal((await fx.service.getJob(fx.context, first)).status, 'unknown')
  let detail = await fx.service.adminEngine(ENGINE)
  assert.equal(detail.slots[0].quarantineReason, 'runner_lost_invocation')
  await fx.executor.drain()
  assert.equal(runner.calls.filter(call => call.method === 'POST').length, 1, 'no dispatch while the only slot is quarantined')
  await assert.rejects(fx.service.adminRecoverSlot(ENGINE, 1, { expectedRevision: detail.engine.revision, reason: 'x' }, 't'), { code: 'invalid_engine_config' })
  await fx.service.adminRecoverSlot(ENGINE, 1, { expectedRevision: detail.engine.revision, reason: '已在 runner 上确认进程退出' }, 't')
  detail = await fx.service.adminEngine(ENGINE)
  assert.equal(detail.slots[0].quarantineReason, null)
  assert.ok(detail.events.some(event => event.action === 'slot_recovered'))
  await fx.executor.drain()
  assert.equal(runner.calls.filter(call => call.method === 'POST').length, 2)
})

test('executor: a lost dispatch is reconciled with the runner instead of guessed', async () => {
  const runner = fakeRunner({ state: () => ({ status: 404, body: {} }) })
  const fx = await fixture({ runner })
  const jobId = (await submit(fx)).data.jobId
  // Another process claimed the job and died before recording the start.
  const { job } = await fx.jobs.claim({ engineId: ENGINE, owner: 'dead-executor', dispatchLeaseMs: 60_000, leaseGraceMs: 30_000 })
  assert.equal(job.id, jobId)
  fx.jobs.jobs.get(jobId).leaseUntil = new Date(Date.now() - 1).toISOString()
  fx.executor.lastHousekeepingAt = 0
  await fx.executor.drain()
  assert.equal(fx.jobs.jobs.get(jobId).phase, 'waiting')
  assert.deepEqual(fx.jobs.jobs.get(jobId).upstreamState, { confirmed: false })
  for (let attempt = 0; attempt < 3; attempt++) await checkNow(fx)
  const view = await fx.service.getJob(fx.context, jobId)
  assert.equal(view.status, 'failed')
  assert.equal(view.error.code, 'engine_not_started')
  assert.equal((await fx.service.adminEngine(ENGINE)).slots[0].jobId, null, 'a run proven never started frees its slot')
})

test('executor: refused callers, missing credentials and unreachable runners never hold a slot', async () => {
  const fx = await fixture({ runner: fakeRunner({ start: () => refused('ECONNREFUSED') }), engine: { credentialProvider: 'collect-runner' }, credentials: {} })
  const missing = (await submit(fx)).data.jobId
  await fx.executor.drain()
  assert.equal((await fx.service.getJob(fx.context, missing)).error.code, 'engine_credential_missing')
  const withCredential = await fixture({ runner: fakeRunner({ start: () => refused('ECONNREFUSED') }),
    engine: { credentialProvider: 'collect-runner' }, credentials: { 'collect-runner': 'runner-token' } })
  const unreachable = (await submit(withCredential)).data.jobId
  await withCredential.executor.drain()
  assert.equal((await withCredential.service.getJob(withCredential.context, unreachable)).error.code, 'engine_unreachable')
  assert.equal(withCredential.runner.calls[0].auth, 'Bearer runner-token')
  assert.equal((await withCredential.service.adminEngine(ENGINE)).slots[0].jobId, null)
  // A key revoked after submission is refused at dispatch.
  const revoked = await fixture()
  const jobId = (await submit(revoked)).data.jobId
  await revoked.hub.revokeApiKey(revoked.key.id)
  await revoked.executor.drain()
  assert.equal((await revoked.jobs.get(jobId)).error.code, 'api_key_unavailable')
  assert.equal(revoked.runner.calls.length, 0)
})

test('executor: with billing on, success commits and failure releases the ledger', async () => {
  const runner = fakeRunner({ start: call => call.body.params.inputs[0] === '404'
    ? { status: 200, body: { data: { state: 'completed', envelope: envelope('error') } } }
    : { status: 200, body: { data: { state: 'completed', envelope: envelope() } } } })
  const fx = await fixture({ runner, engine: { billingEnabled: true, capacity: 2 } })
  const ok = (await submit(fx, ['1'])).data.jobId
  const bad = (await submit(fx, ['404'])).data.jobId
  await fx.executor.drain()
  const okJob = await fx.jobs.get(ok)
  const badJob = await fx.jobs.get(bad)
  assert.equal(okJob.billing, 'charged')
  assert.equal(badJob.billing, 'not_charged')
  assert.ok(okJob.usageRequestId)
  const usage = await fx.ledger.getUsageRequest?.(okJob.usageRequestId)
  if (usage) assert.equal(usage.status, 'committed')
})

test('queue snapshot and polling hints scale with capacity', () => {
  const now = Date.parse('2026-11-09T00:00:00Z')
  assert.equal(estimateStart({ position: 1, capacity: 2, running: 0, medianMs: 30_000, now }), new Date(now).toISOString(), 'a free slot starts now')
  assert.equal(estimateStart({ position: 4, capacity: 2, running: 2, medianMs: 30_000, now }), new Date(now + 60_000).toISOString())
  assert.equal(estimateStart({ position: 3, capacity: 2, running: 1, medianMs: 30_000, now }), new Date(now + 30_000).toISOString())
  assert.equal(estimateStart({ position: 1, capacity: 1, running: 1, medianMs: null, now }), new Date(now + 60_000).toISOString())
  assert.equal(retryAfterSeconds([{ status: 'running' }]), 5)
  assert.equal(retryAfterSeconds([{ status: 'queued', queue: { estimatedStartAt: new Date(Date.now() + 600_000).toISOString() } }]), 60)
  assert.equal(retryAfterSeconds([{ status: 'succeeded' }]), null)
})

test('HTTP contract: 202 + Location, polling, result, capability discovery and admin guard', async () => {
  const runner = fakeRunner({ start: () => ({ status: 200, body: { data: { state: 'completed', envelope: envelope() } } }) })
  const fx = await fixture({ runner })
  const legacy = { wechat: { adminState: async () => ({ engine: { id: 'night-all.wechat-mp', enabled: true, billingEnabled: false, quarantineReason: null,
    cooling: false, cooldownUntil: null, revision: 3 }, queue: { queued: 2, runningJobId: null }, jobs: [{ status: 'succeeded' }] }) } }
  const service = new CollectService({ jobs: fx.jobs, ledger: fx.ledger, contracts: createCollectContracts(), executor: fx.executor, fetchImpl: runner.fetchImpl, legacy })
  // Hold the executor so the test decides when work runs.
  fx.executor.stopped = true
  const run = async () => { fx.executor.stopped = false; await fx.executor.drain(); fx.executor.stopped = true }
  const server = createServer(createApp({ service: fx.hub, store: fx.ledger, adapter: { dependencies: async () => ({ status: 'up' }) },
    adminToken: ADMIN_TOKEN, listenerMode: 'combined', logger: { error() {} }, collect: service }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = (path, { method = 'GET', body, headers = {}, token = fx.key.secret } = {}) => fetch(`${base}${path}`, { method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined })
  try {
    const body = { capability: CAP, input: { market: 'xiaomi', appIds: ['108048'] } }
    assert.equal((await call(`${PREFIX}/jobs`, { method: 'POST', body })).status, 400, 'Idempotency-Key is required')
    const submitted = await call(`${PREFIX}/jobs`, { method: 'POST', body, headers: { 'idempotency-key': 'delta-http-0001' } })
    assert.equal(submitted.status, 202)
    const { data } = await submitted.json()
    assert.equal(submitted.headers.get('location'), `${PREFIX}/jobs/${data.jobId}`)
    assert.ok(Number(submitted.headers.get('retry-after')) >= 5)
    const early = await call(`${PREFIX}/jobs/${data.jobId}/result`)
    assert.equal((await early.json()).error.code, 'result_not_ready')
    await run()
    assert.equal((await (await call(`${PREFIX}/jobs/${data.jobId}`)).json()).data.status, 'succeeded')
    const result = await (await call(`${PREFIX}/jobs/${data.jobId}/result`)).json()
    assert.equal(result.data.payload.status, 'success')
    assert.equal((await (await call(`${PREFIX}/jobs?limit=5&capability=${CAP}`)).json()).data.length, 1)
    const batch = await call(`${PREFIX}/batches`, { method: 'POST', headers: { 'idempotency-key': 'delta-http-batch-1' },
      body: { capability: CAP, items: [{ input: { market: 'xiaomi', appIds: ['1'] }, clientRef: 'a' }, { input: { market: 'xiaomi', appIds: ['2'] } }] } })
    assert.equal(batch.status, 202)
    const batchData = (await batch.json()).data
    assert.equal(batchData.total, 2)
    await run()
    const batchResult = await (await call(`${PREFIX}/batches/${batchData.batchId}/result`)).json()
    assert.equal(batchResult.data.complete, true)
    assert.equal(batchResult.data.items[0].clientRef, 'a')
    const capabilities = (await (await call(`${PREFIX}/capabilities`)).json()).data
    assert.deepEqual(capabilities.filter(row => row.granted || row.ready).map(row => [row.capability, row.granted, row.ready]), [[CAP, true, true]])
    assert.equal((await fetch(`${base}/internal/v1/admin/collect/engines`)).status, 401)
    assert.equal((await call('/internal/v1/admin/collect/engines', { token: fx.key.secret })).status, 403, 'a data key is not an admin')
    const admin = await (await call('/internal/v1/admin/collect/engines', { token: ADMIN_TOKEN })).json()
    assert.equal(admin.data.engines[0].id, ENGINE)
    assert.equal(admin.data.legacy[0].id, 'night-all.wechat-mp')
    assert.equal(admin.data.legacy[0].stats.queued, 2)
    const detail = await (await call(`/internal/v1/admin/collect/engines/${ENGINE}`, { token: ADMIN_TOKEN })).json()
    assert.equal(detail.data.jobs.length, 3)
    const probe = await (await call(`/internal/v1/admin/collect/engines/${ENGINE}/probe`, { method: 'POST', body: {}, token: ADMIN_TOKEN })).json()
    assert.equal(probe.data.healthy, true)
    const catalog = await (await call('/internal/v1/admin/collect/catalog', { token: ADMIN_TOKEN })).json()
    assert.equal(catalog.data.kinds[0].kind, 'runner')
    const created = await call('/internal/v1/admin/collect/engines', { method: 'POST', token: ADMIN_TOKEN,
      body: { id: 'runner.spare', kind: 'runner', displayName: '备用', baseUrl: 'http://10.0.0.8:18300', reason: '新建备用引擎' } })
    assert.equal(created.status, 201)
    const job = await (await call(`/internal/v1/admin/collect/jobs/${data.jobId}`, { token: ADMIN_TOKEN })).json()
    assert.equal(job.data.payload.status, 'success')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
