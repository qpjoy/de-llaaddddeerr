import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'
import { JustOneAdapter } from '../../server/adapters/justone.mjs'
import { NightAllAFacebookAdapter, NightAllAUpstreamError, NIGHT_ALL_A_FACEBOOK_RUN_SECONDS } from '../../server/adapters/night-all-a-facebook.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { createExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { waitForFacebookSelfhostedAdmission } from '../../server/external-platforms/facebook-selfhosted-admission.mjs'
import { FACEBOOK_ENDPOINT, FACEBOOK_OPERATION, FACEBOOK_JUSTONE_KEY, FACEBOOK_SELFHOSTED_ENDPOINT, FACEBOOK_SELFHOSTED_PROVIDER,
  facebookRow, nightAllAFacebookPost, projectFacebookSearch } from '../../server/contracts/facebook-search.mjs'
import { classifyExternalPlatformIngest } from '../../server/workers/ingest.mjs'
import { facebookQuotaFixture } from '../helpers/facebook-quota.mjs'
import { FACEBOOK_STRATEGY_MODE_LABELS, strategyPolicyEditor, strategyPolicySummary } from '../../src/strategy-search-model.js'

const PEPPER = 'facebook-selfhosted-test-pepper-at-least-32-characters'
// Shape of one Night-All-A run.result item (collectors/protocol/facebook/adapter.py record()).
const record = (id, extra = {}) => ({ source_type: 'social', record_type: 'facebook.post', source_id: `facebook.post:${id}`,
  source_url: `https://www.facebook.com/${id}`, title: '正文', text: '正文', attributes: { endpoint: '/search/posts' },
  raw: { id, url: `https://www.facebook.com/${id}`, type: 'photo', message: `自建正文 ${id}`, created_time: '2026-10-30T08:00:00+00:00',
    author: { id: '42', name: 'Page', profile_picture: { uri: 'https://scontent.example/avatar.jpg' } },
    feedback: { reactions: { total: 7, breakdown: [] }, comments: { total: 3 }, shares: { total: null } },
    attachments: [{ type: 'photo', url: 'https://scontent.example/p.jpg' },
      { type: 'video', url: 'https://video.example/v.mp4', thumbnail: 'https://scontent.example/t.jpg', view_count: 99 }], ...extra } })
const runResult = (ids, cursor = null, state = 'data') => ({ items: ids.map(id => record(id)), cursor, metrics: { count: ids.length, result_state: state } })

test('Night-All-A records project into the calibrated Facebook row without inventing counts', () => {
  const row = facebookRow(nightAllAFacebookPost(record('1001')), '2026-10-31T00:00:00.000Z')
  assert.equal(row.content_id, '1001'); assert.equal(row.full_text, '自建正文 1001')
  assert.equal(row.author_id, '42'); assert.equal(row.author_name, 'Page')
  assert.equal(row.author_avatar_url, 'https://scontent.example/avatar.jpg')
  assert.equal(row.like_count, 7); assert.equal(row.comment_count, 3); assert.equal(row.share_count, null)
  assert.equal(row.view_count, 99); assert.equal(row.created_at, '2026-10-30T08:00:00.000Z')
  assert.deepEqual(JSON.parse(row.image_urls), ['https://scontent.example/p.jpg'])
  assert.deepEqual(JSON.parse(row.video_urls), ['https://video.example/v.mp4'])
  assert.equal(row.cover_url, 'https://scontent.example/t.jpg')
  assert.throws(() => nightAllAFacebookPost({ source_id: 'x' }), /invalid_facebook_identity/)
  const request = { query: 'q', page: 1, pageSize: 1, providerCursor: null, projectionVersion: 2, encodeNext: () => 'next' }
  const long = projectFacebookSearch(runResult(['1', '2'], 'c'.repeat(501)), request, FACEBOOK_SELFHOSTED_PROVIDER, '2026-10-31T00:00:00.000Z', { allowOverflow: true })
  assert.equal(long.items.length, 2); assert.equal(long.publicBody.data.page.hasMore, false)
  const short = projectFacebookSearch(runResult(['1'], 'next-page'), request, FACEBOOK_SELFHOSTED_PROVIDER, '2026-10-31T00:00:00.000Z', { allowOverflow: true })
  assert.equal(short.publicBody.providerPage.nextProviderCursor, 'next-page')
  assert.deepEqual(classifyExternalPlatformIngest({ kind: 'external-platform-result', providerKey: 'night-all-a', platform: 'facebook',
    datasetId: 'night-all.search.v1', records: [] }).hubRaw, true)
})

function nightAllA({ runs = [], submit = null, cancelStatus = 'cancelled' } = {}) {
  const calls = []
  let polls = 0
  const fetchImpl = async (url, init) => {
    const target = new URL(url), body = init.body ? JSON.parse(init.body) : null
    calls.push({ method: init.method, path: target.pathname + target.search, body })
    if (init.method === 'POST' && target.pathname === '/api/tasks') {
      if (submit) return submit()
      return Response.json({ task: { id: 7 }, run: { id: 70, status: 'queued' } }, { status: 202 })
    }
    if (init.method === 'GET' && target.pathname === '/api/runs/70') return Response.json({ id: 70, ...runs[Math.min(polls++, runs.length - 1)] })
    if (init.method === 'POST' && target.pathname === '/api/tasks/7/cancel') return Response.json({ id: 7, status: cancelStatus })
    return new Response('not found', { status: 404 })
  }
  let now = 0
  const adapter = new NightAllAFacebookAdapter({ baseUrl: 'http://100.127.0.1:8100', fetchImpl, budgetMs: 10_000,
    clock: () => now, wait: async ms => { now += ms } })
  return { adapter, calls }
}
const selfhostedRequest = (extra = {}) => ({ endpointKey: FACEBOOK_SELFHOSTED_ENDPOINT, platform: 'facebook', query: 'Unitree', page: 1, pageSize: 20,
  providerCursor: null, projectionVersion: 2, encodeNext: () => null,
  upstreamQuery: { query: 'Unitree', start_date: '2026-10-30', end_date: '2026-10-31', pages: 2 }, ...extra })

test('adapter submits one bounded Night-All-A task, polls to a terminal run and archives the exact result', async () => {
  const fake = nightAllA({ runs: [{ status: 'queued' }, { status: 'running' }, { status: 'succeeded', result: runResult(['1', '2'], null, 'partial') }] })
  const result = await fake.adapter.execute(selfhostedRequest())
  assert.deepEqual(fake.calls[0].body, { connector_id: 'facebook-protocol', capability: 'search.posts', task_type: 'query', priority: 0,
    max_attempts: 1, timeout_seconds: NIGHT_ALL_A_FACEBOOK_RUN_SECONDS, persist_results: true,
    parameters: { query: 'Unitree', start_date: '2026-10-30', end_date: '2026-10-31', pages: 2 } })
  assert.deepEqual(fake.calls.slice(1).map(call => call.path), Array(3).fill('/api/runs/70?include_result=true'))
  assert.deepEqual(result.items.map(row => row.content_id), ['1', '2'])
  assert.equal(result.publicBody.data.warnings[0].code, 'FACEBOOK_SELFHOSTED_PARTIAL')
  assert.deepEqual(JSON.parse(result.restrictedResponseArchive.bodyBytes), runResult(['1', '2'], null, 'partial'))
  assert.equal(result.upstreamEvidence.requestId, 'night-all-a-run:70')
})

test('adapter classifies refused, failed, unknown and timed-out runs without guessing', async () => {
  const outcome = async options => {
    const fake = nightAllA(options)
    const error = await fake.adapter.execute(selfhostedRequest()).catch(error => error)
    assert.ok(error instanceof NightAllAUpstreamError, String(error))
    return { ...error.evidence, calls: fake.calls }
  }
  let e = await outcome({ submit: () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) } })
  assert.equal(e.outcome, 'rejected'); assert.equal(e.errorCode, 'night_all_a_unreachable')
  e = await outcome({ submit: () => new Response('boom', { status: 502 }) })
  assert.equal(e.outcome, 'unknown')
  e = await outcome({ submit: () => Response.json({ detail: 'bad' }, { status: 422 }) })
  assert.equal(e.errorCode, 'facebook_selfhosted_invalid_input'); assert.equal(e.affectsCircuit, false)
  e = await outcome({ runs: [{ status: 'failed', error_type: 'auth_expired', error_code: 'auth_expired' }] })
  assert.equal(e.outcome, 'rejected'); assert.equal(e.errorCode, 'facebook_selfhosted_session_invalid'); assert.equal(e.affectsCircuit, true)
  e = await outcome({ runs: [{ status: 'failed', error_code: 'account_rate_limited' }] })
  assert.equal(e.httpStatus, 429); assert.equal(e.retryAfterMs, 300_000)
  e = await outcome({ runs: [{ status: 'queued' }] })
  assert.equal(e.outcome, 'rejected'); assert.equal(e.errorCode, 'night_all_a_queue_timeout')
  assert.equal(e.calls.at(-1).path, '/api/tasks/7/cancel')
  e = await outcome({ runs: [{ status: 'running' }], cancelStatus: 'running' })
  assert.equal(e.outcome, 'unknown'); assert.equal(e.errorCode, 'night_all_a_run_timeout')
  e = await outcome({ runs: [{ status: 'orphaned' }] })
  assert.equal(e.outcome, 'unknown')
  e = await outcome({ runs: [{ status: 'succeeded', result: { items: [{ source_id: 'no-raw' }], cursor: null, metrics: {} } }] })
  assert.equal(e.outcome, 'succeeded_unusable')
  const tooLong = await nightAllA().adapter.execute(selfhostedRequest({ upstreamQuery: { query: 'x'.repeat(501) } })).catch(error => error)
  assert.equal(tooLong.evidence.errorCode, 'facebook_selfhosted_invalid_input')
})

test('PostgreSQL admission is one FIFO with a cluster-wide in-flight cap and even start spacing', { skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE }, async t => {
  const { db, store } = await facebookQuotaFixture(t)
  const policy = await store.facebook()
  assert.equal(policy.selfhosted_max_concurrency, 2); assert.equal(policy.selfhosted_requests_per_minute, 12)
  const ticket = () => ({ id: randomUUID(), requestId: randomUUID(), deadline: Date.now() + 60_000 })
  const rewind = () => db.query("UPDATE control.facebook_selfhosted_admission SET last_dispatch_at=now()-interval '1 minute'")
  assert.equal((await store.admitSelfhosted(ticket(), { leaseMs: 120_000 })).reason, 'strategy_changed')
  for (const input of [{ selfhostedMaxConcurrency: 0 }, { selfhostedMaxConcurrency: 9 }, { selfhostedRequestsPerMinute: 0 }, { selfhostedRequestsPerMinute: 121 }]) {
    await assert.rejects(() => store.update('facebook', { mode: 'selfhosted', expectedRevision: policy.revision, reason: 'invalid', ...input }), /mode, revision and reason/)
  }
  const saved = await store.update('facebook', { mode: 'selfhosted', selfhostedRequestsPerMinute: 60, expectedRevision: policy.revision, reason: '恢复自建' })
  assert.equal(saved.mode, 'selfhosted'); assert.equal(saved.selfhosted_requests_per_minute, 60); assert.equal(saved.selfhosted_max_concurrency, 2)
  const [a, b, c, d] = [ticket(), ticket(), ticket(), ticket()]
  const first = await store.admitSelfhosted(a, { leaseMs: 120_000 })
  assert.equal(first.allowed, true)
  const paced = await store.admitSelfhosted(b, { leaseMs: 120_000 })
  assert.equal(paced.reason, 'paced'); assert.ok(paced.retryAfterMs > 0 && paced.retryAfterMs <= 1000)
  assert.equal((await store.admitSelfhosted(c, { leaseMs: 120_000 })).reason, 'queued')
  await rewind()
  assert.equal((await store.admitSelfhosted(c, { leaseMs: 120_000 })).reason, 'queued')
  assert.equal((await store.admitSelfhosted(b, { leaseMs: 120_000 })).allowed, true)
  await rewind()
  assert.equal((await store.admitSelfhosted(c, { leaseMs: 120_000 })).reason, 'concurrency')
  let listed = (await store.list()).find(row => row.platform === 'facebook')
  assert.equal(listed.selfhosted_in_flight, 2); assert.equal(listed.selfhosted_queue_depth, 1)
  await store.releaseSelfhosted(first)
  assert.equal((await store.admitSelfhosted(c, { leaseMs: 120_000 })).allowed, true)
  // An expired lease no longer occupies a slot, without any release call.
  await db.query(`UPDATE control.facebook_selfhosted_admission SET leases=jsonb_set(leases,'{0,expiresAt}','0'::jsonb),last_dispatch_at=now()-interval '1 minute'`)
  assert.equal((await store.admitSelfhosted(d, { leaseMs: 120_000 })).allowed, true)
  const e = ticket()
  assert.equal((await store.admitSelfhosted(e, { leaseMs: 120_000 })).reason, 'concurrency')
  await store.cancelSelfhostedWait(e)
  listed = (await store.list()).find(row => row.platform === 'facebook')
  assert.equal(listed.selfhosted_queue_depth, 0)
  assert.ok(!('selfhosted_max_concurrency' in (await store.list()).find(row => row.platform === 'twitter')))
  await store.update('facebook', { mode: 'paused', expectedRevision: saved.revision, reason: 'stop' })
  assert.equal((await store.admitSelfhosted(ticket(), { leaseMs: 120_000 })).reason, 'strategy_changed')
})

test('admission wait is bounded, releases an unreturned slot and reports Hub busy', async () => {
  let now = 0
  const events = { cancelled: 0, released: 0 }
  const policyStore = { facebook: async () => ({ mode: 'selfhosted' }), cancelSelfhostedWait: async () => { events.cancelled++ },
    releaseSelfhosted: async () => { events.released++ }, admitSelfhosted: async () => ({ allowed: false, reason: 'concurrency', retryAfterMs: 500 }) }
  const options = { policyStore, requestId: randomUUID(), deadlineAt: 200_000, budgetMs: 60_000 }
  const busy = await waitForFacebookSelfhostedAdmission(options, { clock: () => now, wait: async ms => { now += ms } }).catch(error => error)
  assert.equal(busy.code, 'external_platform_busy'); assert.equal(busy.details.stage, 'facebook_selfhosted_admission')
  assert.equal(now >= 25_000, true); assert.equal(events.cancelled, 1)
  policyStore.admitSelfhosted = async () => ({ allowed: true, token: randomUUID() })
  options.deadlineAt = Date.now() + 200_000
  const denied = await waitForFacebookSelfhostedAdmission({ ...options, revalidate: async () => { throw new Error('revoked') } }).catch(error => error)
  assert.equal(denied.code, 'facebook_selfhosted_state_unavailable'); assert.equal(events.released, 1)
  policyStore.admitSelfhosted = async () => ({ allowed: false, reason: 'strategy_changed' })
  policyStore.facebook = async () => ({ mode: 'paused' })
  assert.equal((await waitForFacebookSelfhostedAdmission(options).catch(error => error)).code, 'facebook_search_paused')
})

async function harness({ runs, mode = 'selfhosted', admit = async () => ({ allowed: true, token: randomUUID() }) } = {}) {
  const usage = new MemoryStore(), stores = {}, gateways = {}, supplierCalls = []
  const service = new HubService({ store: usage, apiKeyPepper: PEPPER, adapter: {
    async legacySearch() { throw new Error('Facebook must not reach Night-All') }, async search() { throw new Error('Facebook must not reach Night-All') } } })
  const tenant = await service.createTenant({ name: 'Self-hosted fixture' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Self-hosted fixture' })
  await service.putPlatformConfiguration('facebook', { tenantId: tenant.id, consumerId: consumer.id, enabled: true, maxRequests: 1000, windowSeconds: 3600, maxPageSize: 100 })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Facebook', platforms: ['facebook'], capabilities: [] })
  const context = await service.authenticate(key.secret)
  const controls = createExternalPlatformControlStore({ pool: null })
  const config = { configured: true, contractVerified: true, dispatchEnabled: true, timeoutMs: 1000,
    freshTtlMs: 60000, staleTtlMs: 86400000, maxConcurrency: 3, maxConsumerConcurrency: 3, maxRequestsPerMinute: 100 }
  for (const provider of ['rapidapi', 'justone']) {
    const endpointKey = provider === 'rapidapi' ? FACEBOOK_ENDPOINT : `native.${FACEBOOK_JUSTONE_KEY}`
    const operation = provider === 'rapidapi' ? FACEBOOK_OPERATION.operationKey : endpointKey
    const current = (await controls.describeProvider(provider, { config, credentialConfigured: true })).find(row => row.operationKey === operation)
    await controls.updatePolicy(provider, operation, { expectedRevision: current.revision, desiredState: 'active', reason: 'fixture',
      priceBook: { currency: 'CNY', pricingAsOf: '2026-10-10T00:00:00Z', monthlyBudgetMinor: 100000, monthlySubsidyBudgetMinor: 100000,
        unitCostMinorByEndpoint: { [endpointKey]: provider === 'rapidapi' ? 0 : 1 } } }, { runtime: { config, credentialConfigured: true } })
    const fetchImpl = async url => { supplierCalls.push(provider); throw new Error(`${url} must not be called`) }
    const adapter = provider === 'rapidapi' ? new RapidApiAdapter({ apiKey: 'fixture-only-key', fetchImpl })
      : new JustOneAdapter({ token: 'fixture-only-key', fetchImpl, logger: { warn() {}, error() {} } })
    stores[provider] = new MemoryExternalPlatformStore({ usageStore: usage, providerKey: provider, authorizationPlatform: 'facebook' })
    gateways[provider] = new ExternalPlatformGateway({ usageStore: usage, platformStore: stores[provider], adapter, config, providerKey: provider,
      operationControlStore: controls, apiKeyPepper: PEPPER, reservationLeaseMs: 120000, logger: { warn() {}, error() {}, info() {} } })
  }
  const fake = nightAllA({ runs })
  stores[FACEBOOK_SELFHOSTED_PROVIDER] = new MemoryExternalPlatformStore({ usageStore: usage, providerKey: FACEBOOK_SELFHOSTED_PROVIDER, authorizationPlatform: 'facebook' })
  const selfhosted = new ExternalPlatformGateway({ usageStore: usage, platformStore: stores[FACEBOOK_SELFHOSTED_PROVIDER], adapter: fake.adapter,
    config: { ...config, timeoutMs: 10_000, billing: { currency: 'CNY', monthlyBudgetMinor: 0, monthlySubsidyBudgetMinor: 0,
      unitCostMinorByEndpoint: { [FACEBOOK_SELFHOSTED_ENDPOINT]: 0 } } },
    providerKey: FACEBOOK_SELFHOSTED_PROVIDER, operationControlStore: { authorizeDispatch: async () => null },
    apiKeyPepper: PEPPER, reservationLeaseMs: 120000, logger: { warn() {}, error() {}, info() {} } })
  const leases = { admitted: 0, released: 0 }
  const policyStore = { facebook: async () => ({ mode, revision: 1 }), admitRapid: async () => { throw new Error('RapidAPI admission must not run') },
    admitSelfhosted: async (...args) => { const result = await admit(...args); if (result.allowed) leases.admitted++; return result },
    releaseSelfhosted: async () => { leases.released++ }, cancelSelfhostedWait: async () => {} }
  const dispatch = (ctx, input) => gateways.rapidapi.searchFacebook(ctx, input, { policyStore, fallbackGateway: gateways.justone, selfhostedGateway: selfhosted })
  service.externalRawSearch = dispatch; service.externalDataSearch = dispatch
  const raw = (body = { platform: 'facebook', query: 'Unitree', count: 20 }, idempotencyKey = 'selfhosted-raw-0001') =>
    service.nightAllCompatibilitySearch(context, { operation: 'raw', body, idempotencyKey, path: '/api/v1/night-all/search/raw' })
  const standard = (body, idempotencyKey) => service.search(context, { body, idempotencyKey, path: '/api/v1/data/search' })
  return { usage, stores, context, fake, leases, supplierCalls, raw, standard }
}

test('raw search in self-hosted mode dispatches only Night-All-A, frees its slot and replays without a new task', async () => {
  const h = await harness({ runs: [{ status: 'running' }, { status: 'succeeded', result: runResult(['11', '12']) }] })
  const first = await h.raw()
  assert.deepEqual(JSON.parse(first.body.data.raw_data).map(row => row.content_id), ['11', '12'])
  assert.deepEqual(h.supplierCalls, [])
  const call = [...h.stores[FACEBOOK_SELFHOSTED_PROVIDER].calls.values()][0]
  assert.equal(call.operation, 'selfhosted.facebook.search'); assert.equal(call.outcome, 'succeeded'); assert.equal(call.billed, false)
  assert.equal(h.stores[FACEBOOK_SELFHOSTED_PROVIDER].ingestJobs[0].payload.providerKey, 'night-all-a')
  assert.deepEqual(h.leases, { admitted: 1, released: 1 })
  assert.deepEqual((await h.raw()).body, first.body)
  assert.equal(h.fake.calls.filter(row => row.path === '/api/tasks').length, 1)
})

test('standard search fills from one Night-All-A task, records the lineage and keeps an unknown run in its slot', async () => {
  const h = await harness({ runs: [{ status: 'succeeded', result: runResult(['21', '22', '23'], 'next-cursor') }] })
  const page = await h.standard({ platform: 'facebook', query: 'Unitree', pageSize: 2 }, 'selfhosted-standard-0001')
  assert.deepEqual(page.body.data.items.map(item => item.id), ['21', '22'])
  assert.equal(page.body.data.pageInfo.hasMore, true)
  assert.equal(h.fake.calls[0].body.parameters.pages, 1)
  assert.deepEqual(h.leases, { admitted: 1, released: 1 }); assert.deepEqual(h.supplierCalls, [])
  const next = await h.standard({ platform: 'facebook', query: 'Unitree', pageSize: 2, cursor: page.body.data.pageInfo.nextCursor }, 'selfhosted-standard-0002')
  assert.deepEqual(next.body.data.items.map(item => item.id), ['23'])
  assert.equal(h.fake.calls.filter(row => row.path === '/api/tasks').at(-1).body.parameters.cursor, 'next-cursor')

  const unknown = await harness({ runs: [{ status: 'running' }], admit: async () => ({ allowed: true, token: randomUUID() }) })
  const error = await unknown.standard({ platform: 'facebook', query: 'Unitree', pageSize: 2 }, 'selfhosted-standard-0003').catch(error => error)
  assert.equal(error.code, 'facebook_selfhosted_outcome_unknown')
  assert.equal([...unknown.stores[FACEBOOK_SELFHOSTED_PROVIDER].calls.values()][0].outcome, 'unknown')
  assert.deepEqual(unknown.leases, { admitted: 1, released: 0 })
  assert.equal(unknown.fake.calls.at(-1).path, '/api/tasks/7/cancel')
})

test('a busy self-hosted queue rejects before any task and a session failure asks for an administrator', async () => {
  const busy = await harness({ admit: async () => ({ allowed: false, reason: 'queue_full' }) })
  const refused = await busy.raw().catch(error => error)
  assert.equal(refused.code, 'external_platform_busy'); assert.equal(busy.fake.calls.length, 0)
  const failed = await harness({ runs: [{ status: 'failed', error_code: 'auth_expired' }] })
  const error = await failed.standard({ platform: 'facebook', query: 'Unitree', pageSize: 5 }, 'selfhosted-standard-0004').catch(error => error)
  assert.equal(error.code, 'facebook_selfhosted_unavailable'); assert.equal(error.details.action, 'contact_administrator')
  assert.deepEqual(failed.leases, { admitted: 1, released: 1 })
})

test('admin model offers the self-hosted mode and states its limits', () => {
  const row = { platform: 'facebook', editable: true, providers: ['rapidapi', 'justone', 'night-all-a'],
    allowedModes: ['auto', 'rapidapi', 'justone', 'selfhosted', 'paused'],
    policy: { mode: 'selfhosted', revision: 3, selfhosted_max_concurrency: 2, selfhosted_requests_per_minute: 12 } }
  assert.equal(strategyPolicyEditor('search', row), 'facebook')
  const summary = strategyPolicySummary('search', row)
  assert.equal(summary.title, '自建 Night-All-A')
  assert.match(summary.description, /同时最多 2 个请求在途，每分钟最多启动 12 次/)
  assert.ok(summary.modes.includes(FACEBOOK_STRATEGY_MODE_LABELS.selfhosted))
  assert.deepEqual(summary.providers, ['rapidapi', 'justone', 'night-all-a'])
})
