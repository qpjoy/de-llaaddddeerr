import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { MemoryCollectStore } from '../../server/collect/store.mjs'
import { CollectExecutor } from '../../server/collect/executor.mjs'
import { CollectService } from '../../server/collect/service.mjs'
import { createCollectContracts } from '../../server/collect/contracts/index.mjs'
import { apifyContract, APIFY_API } from '../../server/collect/contracts/apify.mjs'
import { capabilityDefinition, normalizeJobRequest } from '../../server/collect/catalog.mjs'
import { createCollectCredentials } from '../../server/collect/runtime.mjs'
import { ExternalPlatformProxyStore, createApifyProxyFetch } from '../../server/external-platforms/proxy.mjs'
import { AppError } from '../../server/core/errors.mjs'

const PEPPER = 'collect-apify-test-pepper-at-least-32-bytes'
const ADMIN_TOKEN = 'collect-apify-admin-token'
const TEMU = 'collect.ecommerce.temu.search'
const ENGINE = 'apify.main'
const ACTOR = 'dXoeNAkKt3ZRfOKvx'
const TOKEN = 'apify_api_test_token_value'
const run = (status, extra = {}) => ({ id: 'RunAbc123456', actId: ACTOR, status, buildNumber: '0.0.452', defaultDatasetId: 'DsAbc123456',
  startedAt: '2026-11-09T08:00:00.000Z', finishedAt: status === 'RUNNING' ? null : '2026-11-09T08:00:30.000Z', usageTotalUsd: 0.0123,
  userId: 'secret-user', options: { memoryMbytes: 1024 }, ...extra })
const items = n => Array.from({ length: n }, (_, index) => ({ goods_id: String(index + 1), title: `商品 ${index + 1}` }))
const refused = code => Object.assign(new TypeError('fetch failed'), { cause: { code } })

// Scriptable api.apify.com: each handler gets the parsed request.
function fakeApify(routes = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(url)
    const call = { method: init.method || 'GET', path: target.pathname, query: Object.fromEntries(target.searchParams),
      body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.authorization || null }
    calls.push(call)
    const key = Object.keys(routes).find(pattern => new RegExp(`^${pattern}$`).test(`${call.method} ${call.path}`))
    const answer = key ? routes[key](call) : { status: 404, body: { error: { type: 'record-not-found' } } }
    if (answer instanceof Error) throw answer
    return Response.json(answer.body, { status: answer.status, headers: answer.headers || {} })
  }
  return { calls, fetchImpl }
}

async function fixture({ apify = fakeApify(), engine = {}, credential = TOKEN } = {}) {
  const ledger = new MemoryStore()
  const hub = new HubService({ store: ledger, adapter: {}, apiKeyPepper: PEPPER })
  const tenant = await hub.createTenant({ name: 'Delta' })
  const consumer = await hub.createConsumer({ tenantId: tenant.id, name: 'LCY-delta' })
  await hub.putCapabilityConfiguration(TEMU, { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await hub.createApiKey({ consumerId: consumer.id, name: 'delta', platforms: [], capabilities: [TEMU] })
  const context = await hub.authenticate(key.secret)
  const jobs = new MemoryCollectStore()
  const contracts = createCollectContracts()
  const credentials = createCollectCredentials(null)
  const executor = new CollectExecutor({ jobs, ledger, contracts, credentialsFor: credentials.read, logger: { error() {}, warn() {} }, pollMs: 60_000,
    policyFor: (ctx, platform) => hub.usagePolicy(ctx, platform), fetchImpl: apify.fetchImpl })
  executor.stopped = false
  const service = new CollectService({ jobs, ledger, contracts, executor, credentials, fetchImpl: apify.fetchImpl })
  if (engine !== null) {
    await service.adminCreateEngine({ id: ENGINE, kind: 'apify', displayName: 'Apify 主账号', capacity: 2, enabled: true,
      routes: [{ capability: TEMU }], reason: '阶段 2 试点', ...engine }, 'tester')
    if (credential) await service.adminSetCredential(ENGINE, { apiKey: credential, expectedRevision: 0, reason: '录入 token' }, 'tester')
  }
  return { ledger, hub, key, context, jobs, executor, service, apify, credentials }
}

const submit = (fx, input = { keyword: 'wireless earbuds' }, idem = `delta-${Math.random().toString(36).slice(2, 12)}`) =>
  fx.service.submitJob(fx.context, { capability: TEMU, input }, idem)
async function checkNow(fx) {
  for (const job of fx.jobs.jobs.values()) if (job.phase === 'waiting') job.nextCheckAt = new Date(Date.now() - 1).toISOString()
  await fx.executor.drain()
}

test('pilot catalog: Temu, Meta Ad Library and Similarweb accept only reviewed input', () => {
  const temu = normalizeJobRequest({ capability: TEMU, input: { keyword: ' earbuds ' } })
  assert.deepEqual(temu.item.input, { keyword: 'earbuds', sort: 'relevance', maxItems: 40 })
  assert.deepEqual(temu.definition.actorInput(temu.item.input), { keyword: 'earbuds', region: 'US', sort: 'relevance', max_items: 40 })
  const meta = normalizeJobRequest({ capability: 'collect.ads.meta.library', input: { urls: ['https://www.facebook.com/SHEINOFFICIAL'], resultsLimit: 5,
    activeStatus: 'active', newerThan: '2026-10-01' } })
  assert.deepEqual(meta.definition.actorInput(meta.item.input), { startUrls: [{ url: 'https://www.facebook.com/SHEINOFFICIAL' }], resultsLimit: 5,
    activeStatus: 'active', onlyTotal: false, includeAboutPage: false, isDetailsPerAd: false, enrichWithEcommerceData: false, onlyAdsNewerThan: '2026-10-01' })
  const web = normalizeJobRequest({ capability: 'collect.web.similarweb.overview', input: { domains: ['WWW.Apify.com', 'example.org'] } })
  assert.deepEqual(web.item.input.domains, ['apify.com', 'example.org'])
  for (const [capability, input] of [
    [TEMU, { keyword: '' }], [TEMU, { keyword: 'x', maxItems: 500 }], [TEMU, { keyword: 'x', region: 'CN' }], [TEMU, { keyword: 'x', sort: 'random' }],
    ['collect.ads.meta.library', { urls: ['http://www.facebook.com/x'] }], ['collect.ads.meta.library', { urls: ['https://evil.example/x'] }],
    ['collect.ads.meta.library', { urls: ['https://facebook.com/a'], newerThan: '2026-13-01' }],
    ['collect.ads.meta.library', { urls: ['https://facebook.com/a'], newerThan: '2026-10-02', olderThan: '2026-10-01' }],
    ['collect.ads.meta.library', { urls: ['https://facebook.com/a'], isDetailsPerAd: true }],
    ['collect.web.similarweb.overview', { domains: ['https://apify.com'] }], ['collect.web.similarweb.overview', { domains: ['a.com', 'www.a.com'] }],
  ]) assert.throws(() => normalizeJobRequest({ capability, input }), { code: 'invalid_collect_request' }, `${capability} ${JSON.stringify(input)}`)
})

test('apify start: a created run waits; refusals fail; a lost answer is unknown and holds the slot', async () => {
  const definition = capabilityDefinition(TEMU)
  const job = { id: '00000000-0000-4000-8000-000000000001', input: { keyword: 'earbuds', sort: 'relevance', maxItems: 40 }, checks: 0 }
  const runDeadlineAt = new Date(Date.now() + 600_000).toISOString()
  const start = async answer => {
    const api = fakeApify({ 'POST /v2/acts/.+/runs': () => answer })
    const result = await apifyContract.start({ job, definition, credential: TOKEN, fetchImpl: api.fetchImpl, runDeadlineAt })
    return { result, call: api.calls[0] }
  }
  const created = await start({ status: 201, body: { data: run('READY') } })
  assert.equal(created.result.upstream.ref, 'RunAbc123456')
  assert.equal(created.result.upstream.state.run.userId, undefined, 'only the reviewed run fields are kept')
  assert.equal(created.call.path, `/v2/acts/${ACTOR}/runs`)
  assert.deepEqual(created.call.query, { build: '0.0.452', timeout: created.call.query.timeout, restartOnError: 'false', maxItems: '40' },
    'maxItems bounds charged records to what Hub reads (D27)')
  assert.ok(Number(created.call.query.timeout) >= 30 && Number(created.call.query.timeout) <= 540, 'Apify ends the run before Hub does')
  assert.equal(created.call.query.maxTotalChargeUsd, undefined, 'no spend cap is sent (D18)')
  assert.equal(created.call.auth, `Bearer ${TOKEN}`)
  assert.deepEqual(created.call.body, { keyword: 'earbuds', region: 'US', sort: 'relevance', max_items: 40 })
  for (const [status, code] of [[400, 'apify_input_rejected'], [401, 'apify_auth_failed'], [402, 'apify_payment_required'], [404, 'apify_actor_not_found'], [429, 'apify_rate_limited']]) {
    const { result } = await start({ status, body: { error: { type: 'x' } } })
    assert.deepEqual([result.outcome.status, result.outcome.error.code], ['failed', code])
  }
  const lost = await start({ status: 502, body: {} })
  assert.deepEqual([lost.result.outcome.status, lost.result.outcome.quarantine, lost.result.outcome.error.code], ['unknown', 'slot', 'apify_start_uncertain'])
  const foreign = await start({ status: 201, body: { data: run('READY', { actId: 'SomeoneElse1' }) } })
  assert.equal(foreign.result.outcome.status, 'unknown', 'a run of another Actor is never trusted')
  const timedOut = await start(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))
  assert.equal(timedOut.result.outcome.error.code, 'apify_start_uncertain')
  assert.equal((await start(refused('ECONNREFUSED'))).result.outcome.error.code, 'engine_unreachable')
  const egress = await start(new AppError(503, 'proxy_routes_unreachable', 'probes failed'))
  assert.deepEqual([egress.result.outcome.status, egress.result.outcome.error.code], ['failed', 'egress_unavailable'])
})

test('apify check: completeness comes from the dataset total, cost from the run', async () => {
  const definition = capabilityDefinition(TEMU)
  const input = { keyword: 'earbuds', sort: 'relevance', maxItems: 10 }
  const job = { id: 'job', input, checks: 2, upstreamRef: 'RunAbc123456' }
  const check = async (status, dataset, overrides = {}) => {
    const api = fakeApify({
      'GET /v2/actor-runs/RunAbc123456': () => ({ status: 200, body: { data: run(status) } }),
      'GET /v2/datasets/DsAbc123456/items': call => typeof dataset === 'function' ? dataset(call) : dataset,
    })
    return { result: await apifyContract.check({ job: { ...job, ...overrides }, definition, credential: TOKEN, fetchImpl: api.fetchImpl }), calls: api.calls }
  }
  assert.ok((await check('RUNNING')).result.nextCheckMs >= 5_000)
  const full = await check('SUCCEEDED', { status: 200, body: items(10), headers: { 'x-apify-pagination-total': '10' } })
  assert.deepEqual([full.result.outcome.status, full.result.outcome.dataStatus, full.result.outcome.itemCount], ['succeeded', 'success', 10])
  assert.deepEqual(full.result.outcome.cost, { provider: 'apify', usd: 0.0123, runId: 'RunAbc123456' })
  assert.deepEqual(full.calls[1].query, { format: 'json', clean: 'false', offset: '0', limit: '10' })
  assert.equal(full.result.outcome.upstreamDurationMs, 30_000)
  // The Actor overshot the request: delivering what was asked is complete.
  assert.equal((await check('SUCCEEDED', { status: 200, body: items(10), headers: { 'x-apify-pagination-total': '25' } })).result.outcome.dataStatus, 'success')
  assert.equal((await check('SUCCEEDED', { status: 200, body: items(4), headers: { 'x-apify-pagination-total': '9' } })).result.outcome.dataStatus, 'partial')
  assert.equal((await check('SUCCEEDED', { status: 200, body: [], headers: { 'x-apify-pagination-total': '0' } })).result.outcome.dataStatus, 'no_data')
  assert.equal((await check('SUCCEEDED', { status: 200, body: [...items(2), { error: 'blocked' }], headers: { 'x-apify-pagination-total': '3' } })).result.outcome.dataStatus, 'partial')
  const noTotal = await check('SUCCEEDED', { status: 200, body: items(3) })
  assert.equal(noTotal.result.outcome.result.dataset.total, null)
  assert.ok(noTotal.result.outcome.result.warnings.length)
  const timedOut = await check('TIMED-OUT', { status: 200, body: items(2), headers: { 'x-apify-pagination-total': '2' } })
  assert.deepEqual([timedOut.result.outcome.status, timedOut.result.outcome.dataStatus], ['succeeded', 'partial'])
  assert.equal((await check('TIMED-OUT', { status: 200, body: [], headers: { 'x-apify-pagination-total': '0' } })).result.outcome.error.code, 'apify_run_timed_out')
  const failedRun = await check('FAILED')
  assert.deepEqual([failedRun.result.outcome.status, failedRun.result.outcome.error.code, failedRun.result.outcome.cost.usd], ['failed', 'apify_run_failed', 0.0123])
  assert.ok((await check('SUCCEEDED', { status: 500, body: {} })).result.nextCheckMs, 'a failed dataset read is retried, the run is already finished')
  // An oversized page is read again in halves rather than failing.
  let sizes = []
  const big = await check('SUCCEEDED', call => { sizes.push(Number(call.query.limit)); return Number(call.query.limit) > 2
    ? { status: 200, body: [{ blob: 'x'.repeat(5 * 1024 * 1024) }] } : { status: 200, body: items(2), headers: { 'x-apify-pagination-total': '10' } } })
  assert.deepEqual(sizes, [10, 5, 2])
  assert.equal(big.result.outcome.dataStatus, 'partial')

  const unreadable = fakeApify({ 'GET /v2/actor-runs/RunAbc123456': () => ({ status: 404, body: {} }) })
  const lost = await apifyContract.check({ job, definition, credential: TOKEN, fetchImpl: unreadable.fetchImpl })
  assert.deepEqual([lost.outcome.status, lost.outcome.quarantine], ['unknown', 'slot'])
  const offline = await apifyContract.check({ job, definition, credential: TOKEN, fetchImpl: async () => { throw refused('ECONNRESET') } })
  assert.ok(offline.nextCheckMs > 0, 'a failed status read is retried, not decided')
})

test('apify engine end to end: credential, async run, result, cost and probe', async () => {
  const apify = fakeApify({
    'POST /v2/acts/.+/runs': () => ({ status: 201, body: { data: run('READY') } }),
    'GET /v2/actor-runs/RunAbc123456': () => ({ status: 200, body: { data: run('SUCCEEDED') } }),
    'GET /v2/datasets/DsAbc123456/items': () => ({ status: 200, body: items(3), headers: { 'x-apify-pagination-total': '3' } }),
    'GET /v2/users/me': () => ({ status: 200, body: { data: { username: 'mx-data', email: 'secret@example.com', plan: { id: 'STARTER' } } } }),
    'GET /v2/users/me/limits': () => ({ status: 200, body: { data: { monthlyUsageCycle: { endAt: '2026-12-01T00:00:00.000Z' },
      current: { monthlyUsageUsd: 12.5 }, limits: { maxMonthlyUsageUsd: 49, maxConcurrentActorJobs: 25 } } } }),
  })
  const fx = await fixture({ apify })
  const detail = await fx.service.adminEngine(ENGINE)
  assert.equal(detail.engine.baseUrl, null)
  assert.equal(detail.engine.credentialProvider, 'apify', 'the default credential key is filled in')
  assert.deepEqual([detail.credential.configured, detail.credential.revision], [true, 1])
  assert.equal(JSON.stringify(detail).includes(TOKEN), false, 'the token is never returned')
  assert.ok(detail.events.some(event => event.action === 'credential_updated'))
  const { data } = await submit(fx, { keyword: 'earbuds', maxItems: 10 })
  await fx.executor.drain()
  assert.equal(fx.jobs.jobs.get(data.jobId).upstreamRef, 'RunAbc123456')
  await checkNow(fx)
  const view = await fx.service.getJob(fx.context, data.jobId)
  assert.deepEqual([view.status, view.delivery.dataStatus, view.delivery.itemCount], ['succeeded', 'success', 3], 'the dataset held 3 of 3: complete')
  assert.equal(view.cost, undefined, 'procurement cost is not shown to callers')
  const result = await fx.service.getResult(fx.context, data.jobId)
  assert.equal(result.payload.items.length, 3)
  assert.equal(result.payload.run.id, 'RunAbc123456')
  assert.equal((await fx.service.adminJob(data.jobId)).cost.usd, 0.0123)
  assert.equal((await fx.service.adminEngines()).engines[0].stats.costUsd24h, 0.0123)
  const probe = await fx.service.adminProbe(ENGINE)
  assert.deepEqual([probe.healthy, probe.account, probe.usage.maxConcurrentRuns, probe.credential], [true, { username: 'mx-data', plan: 'STARTER' }, 25, 'configured'])
  assert.equal(JSON.stringify(probe).includes('secret@example.com'), false)
})

test('apify engine: no address, a credential is required, and missing credentials never dispatch', async () => {
  const fx = await fixture({ engine: null })
  const base = { id: 'apify.x', kind: 'apify', displayName: 'x', reason: '新建' }
  await assert.rejects(fx.service.adminCreateEngine({ ...base, baseUrl: 'http://127.0.0.1:1' }, 't'), { code: 'invalid_engine_config' })
  await assert.rejects(fx.service.adminCreateEngine({ ...base, routes: [{ capability: 'collect.app.details', routeKey: 'xiaomi' }] }, 't'), { code: 'invalid_engine_config' })
  const created = await fx.service.adminCreateEngine({ ...base, credentialProvider: 'apify-team' }, 't')
  assert.equal(created.credentialProvider, 'apify-team')
  await assert.rejects(fx.service.adminConfigureEngine('apify.x', { credentialProvider: null, expectedRevision: 0, reason: '清空' }, 't'), { code: 'invalid_engine_config' })
  await assert.rejects(fx.service.adminSetEgress('apify.x', { mode: 'system-egress', expectedRevision: 0, reason: 'x' }, 't'), { code: 'egress_unsupported' })
  // Without a stored token the job fails before anything is sent.
  const empty = await fixture({ credential: null })
  const { data } = await submit(empty)
  await empty.executor.drain()
  assert.equal((await empty.jobs.get(data.jobId)).error.code, 'engine_credential_missing')
  assert.equal(empty.apify.calls.length, 0)
})

test('apify deadline: a confirmed abort frees the slot; an unconfirmed one stays quarantined', async () => {
  for (const [abortStatus, expected] of [['ABORTED', 'failed'], ['RUNNING', 'unknown']]) {
    const apify = fakeApify({
      'POST /v2/acts/.+/runs': () => ({ status: 201, body: { data: run('READY') } }),
      'GET /v2/actor-runs/RunAbc123456': () => ({ status: 200, body: { data: run('RUNNING') } }),
      'POST /v2/actor-runs/RunAbc123456/abort': () => ({ status: 200, body: { data: run(abortStatus) } }),
    })
    const fx = await fixture({ apify })
    const { data } = await submit(fx)
    await fx.executor.drain()
    fx.jobs.jobs.get(data.jobId).runDeadlineAt = new Date(Date.now() - 60_000).toISOString()
    await checkNow(fx)
    const job = await fx.jobs.get(data.jobId)
    assert.equal(job.status, expected, abortStatus)
    assert.equal(job.error.code, 'run_deadline_exceeded')
    const slot = (await fx.service.adminEngine(ENGINE)).slots.find(row => row.slotNo === job.slotNo)
    assert.equal(Boolean(slot.quarantineReason), expected === 'unknown')
    assert.ok(apify.calls.some(call => call.path.endsWith('/abort')))
  }
})

test('apify orphan: a start whose executor vanished is unknown, never re-sent', async () => {
  const fx = await fixture()
  fx.executor.stopped = true
  const { data } = await submit(fx)
  const { job } = await fx.jobs.claim({ engineId: ENGINE, owner: 'dead-executor', dispatchLeaseMs: 60_000, leaseGraceMs: 30_000 })
  fx.executor.stopped = false
  assert.equal(job.id, data.jobId)
  fx.jobs.jobs.get(data.jobId).leaseUntil = new Date(Date.now() - 1).toISOString()
  fx.executor.lastHousekeepingAt = 0
  await fx.executor.drain()
  assert.equal((await fx.jobs.get(data.jobId)).status, 'unknown')
  assert.equal(fx.apify.calls.filter(call => call.method === 'POST').length, 0, 'Hub never starts the run a second time')
  assert.equal((await fx.service.adminEngine(ENGINE)).slots.find(slot => slot.jobId === data.jobId).quarantineReason, 'executor_lost')
})

test('System Proxy knows the apify route and refuses other origins', async () => {
  const store = new ExternalPlatformProxyStore(null, {}, { providerKey: 'apify' })
  store.route = async () => ({ proxyUrls: [], directFallback: true, fingerprint: 'direct', probePolicy: {} })
  const seen = []
  const proxied = createApifyProxyFetch(store, { fetchImpl: async url => { seen.push(String(url)); return new Response('{}') }, directFetchImpl: async url => { seen.push(String(url)); return new Response('{}') } })
  await proxied(`${APIFY_API}/v2/users/me`)
  assert.deepEqual(seen, [`${APIFY_API}/v2/users/me`])
  await assert.rejects(proxied('https://api.example.com/v2/users/me'), /Unexpected provider origin/)
})

test('HTTP: credential is write-only and the egress route reports when unavailable', async () => {
  const fx = await fixture({ credential: null })
  const server = createServer(createApp({ service: fx.hub, store: fx.ledger, adapter: { dependencies: async () => ({ status: 'up' }) },
    adminToken: ADMIN_TOKEN, listenerMode: 'combined', logger: { error() {} }, collect: fx.service }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = (path, method = 'GET', body) => fetch(`${base}${path}`, { method,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  try {
    const saved = await call(`/internal/v1/admin/collect/engines/${ENGINE}/credential`, 'PUT', { apiKey: TOKEN, expectedRevision: 0, reason: '录入' })
    assert.equal(saved.status, 200)
    const text = await saved.text()
    assert.equal(text.includes(TOKEN), false)
    assert.equal(JSON.parse(text).data.configured, true)
    const stale = await call(`/internal/v1/admin/collect/engines/${ENGINE}/credential`, 'PUT', { apiKey: 'x', expectedRevision: 0, reason: '录入' })
    assert.equal(stale.status, 409)
    const egress = await call(`/internal/v1/admin/collect/engines/${ENGINE}/egress`, 'PUT', { mode: 'system-egress', expectedRevision: 0, reason: 'x' })
    assert.equal(egress.status, 409)
    assert.equal((await fetch(`${base}/internal/v1/admin/collect/engines/${ENGINE}/credential`, { method: 'PUT' })).status, 401)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('2b ecommerce: keyword search maps to the pinned Actor input with paid extras off', () => {
  const map = (capability, input) => { const { definition, item } = normalizeJobRequest({ capability, input }); return { input: item.input, actor: definition.actorInput(item.input), limit: definition.resultLimit(item.input), definition } }
  const amazon = map('collect.ecommerce.amazon.search', { keyword: 'mechanical keyboard', marketplace: 'JP', maxItems: 45 })
  assert.deepEqual(amazon.actor.categoryOrProductUrls, [{ url: 'https://www.amazon.co.jp/s?k=mechanical%20keyboard' }])
  assert.deepEqual([amazon.actor.maxItemsPerStartUrl, amazon.actor.maxSearchPagesPerStartUrl, amazon.limit], [45, 3, 45])
  assert.deepEqual([amazon.actor.scrapeSellers, amazon.actor.maxOffers, amazon.actor.useCaptchaSolver, amazon.actor.scrapeProductVariantPrices], [false, 0, false, false])
  const links = map('collect.ecommerce.amazon.search', { urls: ['https://www.amazon.com/dp/B0TEST1234', 'https://amazon.de/s?k=x'], maxItems: 10 })
  assert.equal(links.limit, 20, 'one page per link')
  const ebay = map('collect.ecommerce.ebay.search', { keywords: ['keyboard', 'mouse'], marketplace: 'UK', maxItems: 120, condition: ['used', 'refurbished'], minPrice: 5, maxPrice: 50 })
  assert.deepEqual(ebay.actor, { searchQueries: ['keyboard', 'mouse'], marketplace: 'UK', maxProductsPerSearch: 120, maxSearchPages: 2, sort: 'best_match',
    listingType: 'all', condition: ['used', 'refurbished'], minPrice: 5, maxPrice: 50, maxRequestRetries: 3 })
  assert.equal(ebay.limit, 240)
  assert.equal('condition' in map('collect.ecommerce.ebay.search', { keywords: ['x'] }).actor, false, 'empty filters are not sent')
  const ali = map('collect.ecommerce.aliexpress.search', { keyword: 'earbuds', site: 'de.aliexpress.com', shipCountry: 'DE', maxItems: 20 })
  assert.deepEqual(ali.actor, { searchQuery: 'earbuds', maxResults: 20, detailedItems: false, includeReviews: false, site: 'de.aliexpress.com', shipCountry: 'DE' })
  const etsy = map('collect.ecommerce.etsy.search', { keywords: ['mug', 'vase'], maxItems: 100, freeShippingOnly: true })
  assert.deepEqual([etsy.actor.maxResults, etsy.actor.maxPages, etsy.actor.includeAds, etsy.actor.freeShippingOnly, etsy.actor.digitalOnly, etsy.limit], [200, 3, false, true, false, 200])
  const shopee = map('collect.ecommerce.shopee.search', { country: 'MY', keywords: ['keyboard'] })
  assert.deepEqual(shopee.actor, { country: 'MY', keywords: ['keyboard'], shopUrls: [], categoryUrls: [], maxItems: 50, priceSlicing: false, debug: false })
  const shop = map('collect.ecommerce.shopee.search', { country: 'VN', shopUrls: ['https://shopee.vn/some_shop'], maxItems: 10 })
  assert.deepEqual(shop.actor.shopUrls, ['https://shopee.vn/some_shop'])
  for (const { definition } of [amazon, ebay, ali, etsy, shopee]) assert.match(definition.apify.build, /^\d+\.\d+\.\d+$/, 'every Actor build is pinned')
})

test('2b ecommerce: anything outside the reviewed input is refused before queueing', () => {
  for (const [capability, input] of [
    ['collect.ecommerce.amazon.search', { keyword: 'x', urls: ['https://www.amazon.com/s?k=x'] }],
    ['collect.ecommerce.amazon.search', {}],
    ['collect.ecommerce.amazon.search', { keyword: 'x', marketplace: 'CN' }],
    ['collect.ecommerce.amazon.search', { urls: ['https://www.amazon.com.evil.example/s?k=x'] }],
    ['collect.ecommerce.amazon.search', { urls: ['https://www.amazon.com/dp/B0'], marketplace: 'US' }],
    ['collect.ecommerce.amazon.search', { keyword: 'x', maxItems: 101 }],
    ['collect.ecommerce.amazon.search', { keyword: 'x', scrapeSellers: true }],
    ['collect.ecommerce.ebay.search', { keywords: [] }],
    ['collect.ecommerce.ebay.search', { keywords: ['a', 'b', 'c', 'd', 'e', 'f'] }],
    ['collect.ecommerce.ebay.search', { keywords: ['a'], marketplace: 'JP' }],
    ['collect.ecommerce.ebay.search', { keywords: ['a'], condition: ['mint'] }],
    ['collect.ecommerce.ebay.search', { keywords: ['a'], minPrice: 50, maxPrice: 5 }],
    ['collect.ecommerce.aliexpress.search', { keyword: 'x', includeReviews: true }],
    ['collect.ecommerce.aliexpress.search', { keyword: 'x', shipCountry: 'usa' }],
    ['collect.ecommerce.aliexpress.search', { keyword: 'x', site: 'aliexpress.cn' }],
    ['collect.ecommerce.etsy.search', { keywords: ['x'], country: 'CN' }],
    ['collect.ecommerce.etsy.search', { keywords: ['x'], digitalOnly: true }],
    ['collect.ecommerce.etsy.search', { keywords: ['x'], onSaleOnly: 'yes' }],
    ['collect.ecommerce.shopee.search', { keywords: ['x'] }],
    ['collect.ecommerce.shopee.search', { country: 'SG', keywords: ['x'], shopUrls: ['https://shopee.sg/a'] }],
    ['collect.ecommerce.shopee.search', { country: 'SG', shopUrls: ['https://shopee.vn/a'] }],
    ['collect.ecommerce.shopee.search', { country: 'SG', keywords: ['x'], maxItems: 5 }],
  ]) assert.throws(() => normalizeJobRequest({ capability, input }), { code: 'invalid_collect_request' }, `${capability} ${JSON.stringify(input)}`)
})

test('2b ecommerce: one Apify engine serves several platforms and reads each result page by its own limit', async () => {
  const runs = new Map()
  const apify = fakeApify({
    'POST /v2/acts/.+/runs': call => {
      const actId = call.path.split('/')[3]
      const id = `Run${runs.size + 1}x${actId.slice(0, 6)}`
      runs.set(id, actId)
      return { status: 201, body: { data: run('READY', { actId, id }) } }
    },
    'GET /v2/actor-runs/.+': call => { const id = call.path.split('/').pop(); return { status: 200, body: { data: run('SUCCEEDED', { id, actId: runs.get(id) }) } } },
    'GET /v2/datasets/DsAbc123456/items': call => ({ status: 200, body: items(Number(call.query.limit)), headers: { 'x-apify-pagination-total': call.query.limit } }),
  })
  const fx = await fixture({ apify, engine: { routes: [{ capability: TEMU }, { capability: 'collect.ecommerce.ebay.search' }, { capability: 'collect.ecommerce.amazon.search' }] } })
  await fx.hub.putCapabilityConfiguration('collect.ecommerce.ebay.search', { tenantId: fx.context.tenant.id, consumerId: fx.context.consumer.id, enabled: true })
  const key = await fx.hub.createApiKey({ consumerId: fx.context.consumer.id, name: 'ebay', platforms: [], capabilities: ['collect.ecommerce.ebay.search'] })
  const ebayContext = await fx.hub.authenticate(key.secret)
  const { data } = await fx.service.submitJob(ebayContext, { capability: 'collect.ecommerce.ebay.search', input: { keywords: ['keyboard', 'mouse'], maxItems: 30 } }, 'delta-ebay-0001')
  await assert.rejects(fx.service.submitJob(ebayContext, { capability: TEMU, input: { keyword: 'x' } }, 'delta-temu-0001'), { code: 'capability_not_granted' })
  // The run must belong to the pinned Actor; the fake remembers which one it started.
  await fx.executor.drain()
  await checkNow(fx)
  const view = await fx.service.getJob(ebayContext, data.jobId)
  assert.deepEqual([view.status, view.delivery.itemCount], ['succeeded', 60])
  const read = fx.apify.calls.find(call => call.path.endsWith('/items'))
  assert.equal(read.query.limit, '60', 'two keywords × 30 items')
  assert.equal(fx.apify.calls[0].path, '/v2/acts/Y7h6Aodb7ZXkv6Ieb/runs')
})

test('2c: long-tail capabilities map to pinned Actors with enrichments and personal data off', () => {
  const map = (capability, input) => { const { definition, item } = normalizeJobRequest({ capability, input }); return { input: item.input, actor: definition.actorInput(item.input), limit: definition.resultLimit(item.input) } }
  assert.deepEqual(map('collect.ecommerce.shein.listing', { url: 'https://www.shein.com/Women-Dresses-c-1727.html', maxItems: 30 }).actor,
    { startUrl: 'https://www.shein.com/Women-Dresses-c-1727.html', results_wanted: 30 })
  assert.deepEqual(map('collect.ecommerce.flipkart.search', { url: 'https://www.flipkart.com/mobiles/pr?sid=tyy', sort: 'newest' }).actor,
    { startUrl: 'https://www.flipkart.com/mobiles/pr?sid=tyy', sort: 'newest', results_wanted: 20 })
  const meli = map('collect.ecommerce.mercadolibre.search', { country: 'BR', keyword: 'teclado' }).actor
  assert.deepEqual([meli.mode, meli.scrapeProductDetails, meli.includeReviews, meli.includeQuestions, meli.includeVariations, meli.includeSellerProfile], ['search', false, false, false, false, false])
  assert.equal(map('collect.ecommerce.fbmarketplace.search', { urls: ['https://www.facebook.com/marketplace/nyc/search/?query=desk'] }).actor.includeListingDetails, false)
  const craigslist = map('collect.classifieds.craigslist.search', { urls: ['https://seattle.craigslist.org/search/sss?query=keyboard'], maxItems: 25 })
  assert.deepEqual([craigslist.actor.maxAge, craigslist.actor.maxConcurrency, craigslist.limit], [7, 2, 25], 'the run maxItems bounds a pay-per-result Actor without its own limit')
  const shopify = map('collect.ecommerce.shopify.catalog', { domains: ['Shop.Example.com', 'www.store.io'], maxItems: 100 })
  assert.deepEqual([shopify.actor.domains, shopify.actor.includeInventoryDetails, shopify.limit], [['https://shop.example.com', 'https://store.io'], false, 200])
  assert.deepEqual(map('collect.web.builtwith.technologies', { domains: ['apify.com', 'example.org'] }).actor, { startDomains: ['apify.com', 'example.org'], maxRequestsPerCrawl: 6 })
  const uk = map('collect.company.uk.search', { companyNumbers: ['6', 'sc123456'] })
  assert.deepEqual(uk.input.companyNumbers, ['00000006', 'SC123456'])
  assert.deepEqual([uk.actor.includeOfficers, uk.actor.includePSCs, uk.actor.includeFilingHistory, uk.actor.includeCharges, uk.actor.emitOfficerRecords, uk.actor.monitoringMode, uk.limit],
    [false, false, false, false, false, false, 2])
  assert.deepEqual(map('collect.company.uk.search', { query: 'green energy', maxItems: 5 }).actor.searchQueries, ['green energy'])
  const trip = map('collect.travel.tripcom.hotel-reviews', { hotelUrl: 'https://us.trip.com/hotels/shanghai-hotel-detail-346403/x/', maxReviews: 50, since: '2026-06-01' })
  assert.deepEqual(trip.actor, { hotelUrl: 'https://us.trip.com/hotels/shanghai-hotel-detail-346403/x/', maxReviews: 50, sortBy: 'mostRecent', cutoffDate: '2026-06-01' })
})

test('2c: links outside the reviewed hosts and paths, and closed options, are refused', () => {
  for (const [capability, input] of [
    ['collect.ecommerce.shein.listing', { url: 'https://m.shein.com/x' }], ['collect.ecommerce.shein.listing', { keyword: 'dress' }],
    ['collect.ecommerce.flipkart.search', { keyword: 'x', url: 'https://www.flipkart.com/x' }], ['collect.ecommerce.flipkart.search', { url: 'https://www.amazon.in/x' }],
    ['collect.ecommerce.mercadolibre.search', { keyword: 'x' }], ['collect.ecommerce.mercadolibre.search', { country: 'US', keyword: 'x' }],
    ['collect.ecommerce.mercadolibre.search', { country: 'MX', keyword: 'x', includeReviews: true }],
    ['collect.ecommerce.fbmarketplace.search', { urls: ['https://www.facebook.com/SHEINOFFICIAL'] }],
    ['collect.ecommerce.fbmarketplace.search', { urls: ['https://www.facebook.com/marketplace/x'], includeListingDetails: true }],
    ['collect.classifieds.craigslist.search', { urls: ['https://craigslist.org/search/sss'] }],
    ['collect.classifieds.craigslist.search', { urls: ['https://seattle.craigslist.org/about/'] }],
    ['collect.classifieds.craigslist.search', { urls: ['https://seattle.craigslist.org.evil.example/search/sss'] }],
    ['collect.classifieds.craigslist.search', { urls: ['https://seattle.craigslist.org/search/sss'], maxAgeDays: 90 }],
    ['collect.ecommerce.shopify.catalog', { domains: ['https://shop.example.com'] }], ['collect.ecommerce.shopify.catalog', { domains: ['a.com'], includeInventoryDetails: true }],
    ['collect.web.builtwith.technologies', { domains: Array.from({ length: 11 }, (_, i) => `d${i}.com`) }],
    ['collect.company.uk.search', { query: 'x', companyNumbers: ['00000006'] }], ['collect.company.uk.search', { companyNumbers: ['ABC'] }],
    ['collect.company.uk.search', { query: 'x', includeOfficers: true }], ['collect.company.uk.search', { companyNumbers: ['00000006'], maxItems: 5 }],
    ['collect.travel.tripcom.hotel-reviews', { hotelUrl: 'https://hotels.ctrip.com/hotels/346403.html' }],
    ['collect.travel.tripcom.hotel-reviews', { hotelUrl: 'https://www.trip.com/flights/x' }],
    ['collect.travel.tripcom.hotel-reviews', { hotelUrl: 'https://www.trip.com/hotels/x/', maxReviews: 1000 }],
  ]) assert.throws(() => normalizeJobRequest({ capability, input }), { code: 'invalid_collect_request' }, `${capability} ${JSON.stringify(input)}`)
})
