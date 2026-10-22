import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { MemorySelfHostedStore } from '../../server/self-hosted/store.mjs'
import { WechatSelfHostedExecutor } from '../../server/self-hosted/executor.mjs'
import { WechatSelfHostedService } from '../../server/self-hosted/service.mjs'
import {
  WECHAT_ENGINE_ID, DEFAULT_ENGINE_BASE_URL, classifyEngineResponse, classifyTransportError,
  normalizeEngineBaseUrl, normalizeSearchItem, normalizeBatchRequest, estimateStart, nightAllSearchBody, retryAfterSeconds,
} from '../../server/self-hosted/wechat-contract.mjs'
import { dataAdmissionLane } from '../../server/core/data-admission.mjs'
import { WECHAT_SELF_HOSTED, WECHAT_SELF_HOSTED_LIMITS } from '../../shared/wechat-self-hosted.mjs'
import { PUBLIC_OPENAPI_DOCUMENT, PUBLIC_DOCS_ROUTES } from '../../server/public-docs.mjs'
import { capabilityCatalog } from '../../server/data/capability-catalog.mjs'
import { servicePriceDefinition } from '../../server/contracts/service-pricing.mjs'
import { productAllowed } from '../../shared/product-access.mjs'

const PEPPER = 'wechat-self-hosted-test-pepper-at-least-32-bytes'
const ADMIN_TOKEN = 'wechat-self-hosted-admin-token'
const CAP = WECHAT_SELF_HOSTED.capability
const PREFIX = WECHAT_SELF_HOSTED.apiPrefix
const ROWS = [{ title: '<em>人工智能</em> 周报', url: 'https://mp.weixin.qq.com/s/example', published_at: 1761200000 }]
const live = (rows = ROWS, cache = { status: 'miss', fetchedAt: '2026-10-23T02:00:00.000Z' }) => Response.json({
  data: { raw_info: '[]', raw_data: JSON.stringify(rows), page: { page: 1, returnedCount: rows.length }, meta: { cache } }, requestId: 'na-1',
})

function engines(billingEnabled = false) {
  return new MemorySelfHostedStore({ engines: [{ id: WECHAT_ENGINE_ID, baseUrl: DEFAULT_ENGINE_BASE_URL, billingEnabled }] })
}

async function fixture({ grant = true, fetchImpl, limits, billing = false } = {}) {
  const ledger = new MemoryStore()
  const hub = new HubService({ store: ledger, adapter: {}, apiKeyPepper: PEPPER })
  const tenant = await hub.createTenant({ name: 'Delta' })
  const consumer = await hub.createConsumer({ tenantId: tenant.id, name: 'LCY-delta' })
  await ledger.setPlatformGrant(consumer.id, WECHAT_SELF_HOSTED.platform, true)
  await hub.putCapabilityConfiguration(CAP, { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await hub.createApiKey({ consumerId: consumer.id, name: 'delta', platforms: [WECHAT_SELF_HOSTED.platform], capabilities: grant ? [CAP] : [] })
  const context = await hub.authenticate(key.secret)
  const jobs = engines(billing)
  const calls = []
  const executor = new WechatSelfHostedExecutor({ jobs, ledger, logger: { error() {} }, pollMs: 60_000,
    policyFor: (ctx, platform) => hub.usagePolicy(ctx, platform),
    fetchImpl: async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return fetchImpl ? fetchImpl(url, init) : live() } })
  const service = new WechatSelfHostedService({ jobs, ledger, executor, ...(limits ? { limits } : {}) })
  return { ledger, hub, tenant, consumer, key, context, jobs, executor, service, calls }
}

async function drain(executor) {
  executor.stopped = false
  executor.ready = Promise.resolve()
  await executor.tick()
}

test('request normalization keeps only the documented fields and bounds', () => {
  assert.deepEqual(normalizeSearchItem({ query: '  人工智能 ' }).input, { query: '人工智能', limit: 5, page: 1, cacheMaxAgeHours: 24 })
  assert.throws(() => normalizeSearchItem({ query: '' }), { code: 'invalid_wechat_self_hosted_request' })
  assert.throws(() => normalizeSearchItem({ query: 'a', limit: 21 }), { code: 'invalid_wechat_self_hosted_request' })
  assert.throws(() => normalizeSearchItem({ query: 'a', provider: 'sogou' }), { code: 'invalid_wechat_self_hosted_request' })
  assert.throws(() => normalizeBatchRequest({ items: Array.from({ length: 11 }, () => ({ query: 'a' })) }), { code: 'invalid_wechat_self_hosted_request' })
  assert.throws(() => normalizeBatchRequest({ items: [{ clientRef: 'x', query: 'a' }, { clientRef: 'x', query: 'b' }] }), { code: 'invalid_wechat_self_hosted_request' })
  const body = nightAllSearchBody({ query: 'q', limit: 5, page: 2, cacheMaxAgeHours: 0 })
  assert.equal(body.platform, 'wechat_mp')
  assert.equal(body.params.provider, 'sogou')
  assert.equal(body.cacheMaxAgeHours, 0)
})

test('engine address accepts loopback, private and in-cluster names only', () => {
  assert.equal(normalizeEngineBaseUrl('http://127.0.0.1:13141/'), 'http://127.0.0.1:13141')
  assert.equal(normalizeEngineBaseUrl('http://192.168.1.2:13141'), 'http://192.168.1.2:13141')
  assert.equal(normalizeEngineBaseUrl('http://night-all-legacy.mx-insight-hub.svc.cluster.local:13141'),
    'http://night-all-legacy.mx-insight-hub.svc.cluster.local:13141')
  for (const value of ['http://8.8.8.8:13141', 'http://example.com:13141', 'http://127.0.0.1', 'http://u:p@127.0.0.1:13141',
    'http://127.0.0.1:13141/api', 'ftp://127.0.0.1:13141', 'http://127.0.0.1:13141/?x=1', '']) {
    assert.throws(() => normalizeEngineBaseUrl(value), { code: 'invalid_engine_base_url' }, value)
  }
})

test('Night-All answers map to the billing and quarantine rules', () => {
  const text = body => JSON.stringify(body)
  const ok = classifyEngineResponse({ status: 200, text: text({ data: { raw_data: JSON.stringify(ROWS), meta: { cache: { status: 'miss' } } } }) })
  assert.deepEqual([ok.status, ok.sourceMode, ok.charge, ok.result.items.length], ['succeeded', 'live', true, 1])
  const fresh = classifyEngineResponse({ status: 200, text: text({ data: { raw_data: '[]', meta: { cache: { status: 'fresh' } } } }) })
  assert.deepEqual([fresh.status, fresh.sourceMode, fresh.charge], ['succeeded', 'fresh_cache', true])
  const spider = classifyEngineResponse({ status: 200, now: 1000, text: text({ data: { raw_data: '[]', meta: { cache: { status: 'stale', reason: 'sogou_anti_spider', retryAfterMs: 60_000 } } } }) })
  assert.deepEqual([spider.status, spider.sourceMode, spider.charge, spider.cooldownUntil, spider.quarantine], ['succeeded', 'stored_fallback', false, 61_000, undefined])
  const staleFailure = classifyEngineResponse({ status: 200, text: text({ data: { raw_data: '[]', meta: { cache: { status: 'stale', reason: 'temporary_failure' } } } }) })
  assert.deepEqual([staleFailure.status, staleFailure.charge, Boolean(staleFailure.quarantine), Boolean(staleFailure.result)], ['unknown', false, true, true])
  const limited = classifyEngineResponse({ status: 429, now: 0, text: text({ error: { code: 'SOGOU_RATE_LIMITED', details: { retryAfterMs: 5_000 } } }) })
  assert.deepEqual([limited.status, limited.error.code, limited.cooldownUntil], ['failed', 'upstream_cooldown', 5_000])
  assert.equal(classifyEngineResponse({ status: 503, text: text({ error: { code: 'SOGOU_TEMPORARILY_UNAVAILABLE', details: { cause: 'PROCESS_TIMEOUT' } } }) }).status, 'unknown')
  assert.equal(classifyEngineResponse({ status: 503, text: text({ error: { code: 'SOGOU_TEMPORARILY_UNAVAILABLE', details: { cause: 'CRAWLER_FAILED' } } }) }).status, 'failed')
  assert.equal(classifyEngineResponse({ status: 400, text: text({ error: { code: 'BAD' } }) }).status, 'failed')
  assert.equal(classifyEngineResponse({ status: 302, text: '' }).status, 'failed')
  assert.equal(classifyEngineResponse({ status: 500, text: 'oops' }).status, 'unknown')
  assert.equal(classifyTransportError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })).status, 'failed')
  assert.equal(classifyTransportError(Object.assign(new Error('t'), { name: 'TimeoutError' })).status, 'unknown')
  assert.equal(classifyTransportError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })).status, 'unknown')
})

test('start estimates use the recent median and any cooldown', () => {
  const now = Date.parse('2026-10-23T00:00:00Z')
  assert.equal(estimateStart({ position: 1, now }), new Date(now).toISOString())
  assert.equal(estimateStart({ position: 2, medianMs: 30_000, now }), new Date(now + 40_000).toISOString())
  assert.equal(estimateStart({ position: 1, cooldownUntil: now + 60_000, now }), new Date(now + 60_000).toISOString())
  assert.equal(estimateStart({ position: 1, runningSince: now - 20_000, medianMs: 30_000, now }), new Date(now + 20_000).toISOString())
})

test('submission is idempotent, bounded and only one job runs at a time', async () => {
  const { service, context, jobs } = await fixture({ limits: { ...WECHAT_SELF_HOSTED_LIMITS, consumerOpen: 3, globalQueued: 3 } })
  const first = await service.submitJob(context, { query: '人工智能' }, 'delta-key-0001')
  assert.equal(first.replay, false)
  assert.equal(first.data.status, 'queued')
  assert.equal(first.data.queue.position, 1)
  const again = await service.submitJob(context, { query: '人工智能' }, 'delta-key-0001')
  assert.deepEqual([again.replay, again.data.jobId], [true, first.data.jobId])
  await assert.rejects(service.submitJob(context, { query: '新能源' }, 'delta-key-0001'), { code: 'idempotency_conflict' })
  const batch = await service.submitBatch(context, { items: [{ clientRef: 'a', query: 'x' }, { clientRef: 'b', query: 'y' }] }, 'delta-batch-001')
  assert.deepEqual(batch.data.jobs.map(job => job.queue.position), [2, 3])
  await assert.rejects(service.submitJob(context, { query: 'z' }, 'delta-key-0002'), { code: 'engine_queue_full' })

  const owners = await Promise.all(['a', 'b', 'c', 'd'].map(owner => jobs.claim({ engineId: WECHAT_ENGINE_ID, owner })))
  assert.equal(owners.filter(row => row.job).length, 1, 'four concurrent claims dispatch exactly one job')
})

test('with billing on, a granted caller is charged once for a live result and can read it', async () => {
  const { service, context, executor, ledger, jobs, calls } = await fixture({ billing: true })
  const { data } = await service.submitJob(context, { query: '人工智能', limit: 3 }, 'delta-live-0001')
  await drain(executor)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${DEFAULT_ENGINE_BASE_URL}/api/v1/search/raw`)
  assert.equal(calls[0].body.limit, 3)
  const job = await jobs.get(data.jobId)
  assert.deepEqual([job.status, job.sourceMode, job.billing], ['succeeded', 'live', 'charged'])
  assert.equal(ledger.requests.get(job.usageRequestId).status, 'committed')
  const result = await service.getResult(context, data.jobId)
  assert.equal(result.items[0].url, ROWS[0].url)
  assert.equal((await jobs.engine(WECHAT_ENGINE_ID)).activeJobId, null)
})

test('stale fallback is readable but not charged; unknown quarantines without charge', async () => {
  let answer = () => live(ROWS, { status: 'stale', reason: 'sogou_anti_spider', retryAfterMs: 1 })
  const { service, context, executor, ledger, jobs } = await fixture({ fetchImpl: () => answer(), billing: true })
  const stale = await service.submitJob(context, { query: 'a' }, 'delta-stale-001')
  await drain(executor)
  const staleJob = await jobs.get(stale.data.jobId)
  assert.deepEqual([staleJob.status, staleJob.sourceMode, staleJob.billing], ['succeeded', 'stored_fallback', 'not_charged'])
  assert.equal(ledger.requests.get(staleJob.usageRequestId).status, 'released')
  assert.match((await service.getResult(context, stale.data.jobId)).notice, /旧结果/)

  await new Promise(resolve => setTimeout(resolve, 5))
  answer = () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }) }
  const timedOut = await service.submitJob(context, { query: 'b' }, 'delta-unknown-01')
  const waiting = await service.submitJob(context, { query: 'c' }, 'delta-waiting-01')
  await drain(executor)
  const unknownJob = await jobs.get(timedOut.data.jobId)
  assert.deepEqual([unknownJob.status, unknownJob.billing], ['unknown', 'pending_review'])
  assert.equal(ledger.requests.get(unknownJob.usageRequestId).status, 'unknown')
  const engine = await jobs.engine(WECHAT_ENGINE_ID)
  assert.equal(engine.quarantineReason, 'upstream_timeout')
  assert.equal((await jobs.get(waiting.data.jobId)).status, 'queued', 'a quarantined engine dispatches nothing more')
  await assert.rejects(service.submitJob(context, { query: 'd' }, 'delta-blocked-01'), { code: 'engine_attention_required' })

  answer = () => live()
  await service.adminRecover({ expectedRevision: engine.revision, reason: '已确认进程退出' }, 'admin')
  await drain(executor)
  assert.equal((await jobs.get(waiting.data.jobId)).status, 'succeeded')
})

test('dispatch re-checks the key: a revoked grant fails before any upstream call', async () => {
  const { service, context, executor, jobs, calls, hub, consumer, tenant } = await fixture()
  const { data } = await service.submitJob(context, { query: 'a' }, 'delta-revoke-01')
  await hub.putCapabilityConfiguration(CAP, { tenantId: tenant.id, consumerId: consumer.id, enabled: false })
  await drain(executor)
  const job = await jobs.get(data.jobId)
  assert.deepEqual([job.status, job.error.code, job.billing, calls.length], ['failed', 'capability_not_granted', 'none', 0])
  assert.equal((await jobs.engine(WECHAT_ENGINE_ID)).activeJobId, null)
})

test('billing off (default) only forwards: no ledger rows, unknown still quarantines', async () => {
  let answer = () => live()
  const { service, context, executor, ledger, jobs, calls } = await fixture({ fetchImpl: () => answer() })
  assert.equal((await jobs.engine(WECHAT_ENGINE_ID)).billingEnabled, false)
  const { data } = await service.submitJob(context, { query: '人工智能' }, 'delta-forward-01')
  await drain(executor)
  const job = await jobs.get(data.jobId)
  assert.deepEqual([job.status, job.sourceMode, job.billing, job.usageRequestId, calls.length], ['succeeded', 'live', 'none', null, 1])
  assert.equal(ledger.requests.size, 0, 'the usage ledger is never touched')
  assert.equal((await service.getResult(context, data.jobId)).items.length, 1)

  answer = () => new Response('oops', { status: 502 })
  const lost = await service.submitJob(context, { query: 'b' }, 'delta-forward-02')
  await drain(executor)
  assert.deepEqual([(await jobs.get(lost.data.jobId)).status, (await jobs.get(lost.data.jobId)).billing], ['unknown', 'none'])
  assert.equal((await jobs.engine(WECHAT_ENGINE_ID)).quarantineReason, 'upstream_server_error')
  assert.equal(ledger.requests.size, 0)
})

test('an idle executor never takes the engine lock', async () => {
  const { service, context, executor, jobs } = await fixture()
  let claims = 0
  const claim = jobs.claim.bind(jobs)
  jobs.claim = input => { claims++; return claim(input) }
  await drain(executor)
  await drain(executor)
  assert.equal(claims, 0, 'no queued work: only the lock-free readiness read')
  await service.submitJob(context, { query: 'a' }, 'delta-idle-0001')
  await drain(executor)
  assert.equal(claims, 1)
})

test('Retry-After follows the estimated start within 5-60 seconds', () => {
  const now = Date.parse('2026-10-23T00:00:00Z')
  const queued = seconds => ({ status: 'queued', queue: { estimatedStartAt: new Date(now + seconds * 1000).toISOString() } })
  assert.equal(retryAfterSeconds([queued(1)], now), 5)
  assert.equal(retryAfterSeconds([queued(30)], now), 30)
  assert.equal(retryAfterSeconds([queued(900)], now), 60)
  assert.equal(retryAfterSeconds([queued(900), { status: 'running' }], now), 5)
  assert.equal(retryAfterSeconds([{ status: 'succeeded' }], now), null)
})

test('submission without the capability is refused', async () => {
  const { service, context } = await fixture({ grant: false })
  await assert.rejects(service.submitJob(context, { query: 'a' }, 'delta-nogrant-1'), { code: 'capability_not_granted' })
})

test('a restarted executor records the interrupted run as unknown and quarantines', async () => {
  const { service, context, jobs, ledger, hub } = await fixture()
  const { data } = await service.submitJob(context, { query: 'a' }, 'delta-restart-01')
  await jobs.claim({ engineId: WECHAT_ENGINE_ID, owner: 'old-process' })
  const executor = new WechatSelfHostedExecutor({ jobs, ledger, logger: { error() {} }, pollMs: 60_000,
    policyFor: (ctx, platform) => hub.usagePolicy(ctx, platform), fetchImpl: async () => live() })
  executor.start()
  await executor.ready
  await executor.close()
  assert.equal((await jobs.get(data.jobId)).status, 'unknown')
  assert.equal((await jobs.engine(WECHAT_ENGINE_ID)).quarantineReason, 'executor_restarted')
})

test('admin configuration is revisioned, validated and refuses a busy address change', async () => {
  const { service, context, jobs } = await fixture()
  const state = await service.adminState()
  assert.equal(state.engine.baseUrl, DEFAULT_ENGINE_BASE_URL)
  await assert.rejects(service.adminConfigure({ baseUrl: 'http://8.8.8.8:13141', enabled: true, expectedRevision: 0, reason: '测试' }, 'admin'),
    { code: 'invalid_engine_base_url' })
  await assert.rejects(service.adminConfigure({ baseUrl: DEFAULT_ENGINE_BASE_URL, enabled: true, expectedRevision: 9, reason: '测试' }, 'admin'),
    { code: 'engine_revision_conflict' })
  await service.submitJob(context, { query: 'a' }, 'delta-busy-0001')
  await jobs.claim({ engineId: WECHAT_ENGINE_ID, owner: 'x' })
  await assert.rejects(service.adminConfigure({ baseUrl: 'http://192.168.1.2:13141', enabled: true, expectedRevision: 0, reason: '换机' }, 'admin'),
    { code: 'engine_busy' })
  const disabled = await service.adminConfigure({ baseUrl: DEFAULT_ENGINE_BASE_URL, enabled: false, expectedRevision: 0, reason: '维护' }, 'admin')
  assert.deepEqual([disabled.enabled, disabled.billingEnabled, disabled.revision], [false, false, 1])
  const charging = await service.adminConfigure({ baseUrl: DEFAULT_ENGINE_BASE_URL, enabled: false, billingEnabled: true, expectedRevision: 1, reason: '开启计费' }, 'admin')
  assert.deepEqual([charging.billingEnabled, charging.revision], [true, 2])
  await assert.rejects(service.adminConfigure({ baseUrl: DEFAULT_ENGINE_BASE_URL, enabled: true, billingEnabled: 'yes', expectedRevision: 2, reason: '错误' }, 'admin'),
    { code: 'invalid_engine_config' })
  await assert.rejects(service.submitJob(context, { query: 'b' }, 'delta-disabled1'), { code: 'engine_disabled' })
})

test('HTTP contract: 202 + Location, polling, result and admin guard', async () => {
  const { service, key, executor, hub, ledger } = await fixture()
  const server = createServer(createApp({ service: hub, store: ledger, adapter: { dependencies: async () => ({ status: 'up' }) },
    adminToken: ADMIN_TOKEN, listenerMode: 'combined', logger: { error() {} }, wechatSelfHosted: service }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = (path, { method = 'GET', body, headers = {} } = {}) => fetch(`${base}${path}`, { method,
    headers: { authorization: `Bearer ${key.secret}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined })
  try {
    const missing = await call(`${PREFIX}/jobs`, { method: 'POST', body: { query: 'a' } })
    assert.equal(missing.status, 400)
    const submitted = await call(`${PREFIX}/jobs`, { method: 'POST', body: { query: '人工智能' }, headers: { 'idempotency-key': 'delta-http-0001' } })
    assert.equal(submitted.status, 202)
    const { data } = await submitted.json()
    assert.equal(submitted.headers.get('location'), `${PREFIX}/jobs/${data.jobId}`)
    assert.ok(Number(submitted.headers.get('retry-after')) >= 5)
    const early = await call(`${PREFIX}/jobs/${data.jobId}/result`)
    assert.equal(early.status, 409)
    assert.equal((await early.json()).error.code, 'result_not_ready')
    await drain(executor)
    const status = await call(`${PREFIX}/jobs/${data.jobId}`)
    assert.equal((await status.json()).data.status, 'succeeded')
    const result = await call(`${PREFIX}/jobs/${data.jobId}/result`)
    assert.equal((await result.json()).data.items.length, 1)
    const listed = await call(`${PREFIX}/jobs?limit=5`)
    assert.equal((await listed.json()).data.length, 1)
    const anonymous = await fetch(`${base}/internal/v1/admin/wechat-self-hosted`)
    assert.equal(anonymous.status, 401)
    const admin = await fetch(`${base}/internal/v1/admin/wechat-self-hosted`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })
    assert.equal(admin.status, 200)
    assert.equal((await admin.json()).data.jobs.length, 1)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('the product is registered for docs, pricing, admission and catalog', () => {
  assert.equal(dataAdmissionLane('POST', `${PREFIX}/jobs`), 'read')
  assert.ok(PUBLIC_OPENAPI_DOCUMENT.paths['/data/wechat/self-hosted/jobs'].post)
  assert.ok(PUBLIC_DOCS_ROUTES.some(route => route.key === WECHAT_SELF_HOSTED.docs))
  assert.deepEqual(servicePriceDefinition(`${PREFIX}/jobs`), { platform: 'social', capabilities: [CAP], meterKey: CAP })
  assert.equal(servicePriceDefinition(`${PREFIX}/jobs/{jobId}`), null)
  assert.equal(capabilityCatalog().issues.filter(issue => issue.id.includes(WECHAT_SELF_HOSTED.key)).length, 0)
  assert.equal(productAllowed(WECHAT_SELF_HOSTED.path, [{ platforms: ['social'], capabilities: [CAP] }]), true)
  assert.equal(productAllowed(WECHAT_SELF_HOSTED.path, [{ platforms: ['social'], capabilities: ['native.wechat.search.search'] }]), false)
})
