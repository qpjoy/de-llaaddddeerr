import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { HubService, businessApiScopes } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { MemoryCollectStore } from '../../server/collect/store.mjs'
import { CollectExecutor } from '../../server/collect/executor.mjs'
import { CollectService } from '../../server/collect/service.mjs'
import { createCollectContracts } from '../../server/collect/contracts/index.mjs'
import { runnerContract } from '../../server/collect/contracts/runner.mjs'
import { normalizeJobRequest, capabilityDefinition } from '../../server/collect/catalog.mjs'
import { createProviderProxySelector } from '../../server/external-platforms/proxy.mjs'
import { COLLECT_APP_MARKET_SLOTS, COLLECT_CAPABILITIES, COLLECT_RUNNER_SLOTS, collectEgressProvider } from '../../shared/collect-engines.mjs'

// Integration plan phase 4: app markets and Google Play on mx-crawler-runner.
const PEPPER = 'collect-runner-test-pepper-at-least-32-bytes'
const DETAILS = 'collect.app.details'
const GP = operation => `collect.app.googleplay.${operation}`
const GP_KEYS = ['search', 'reviews', 'charts', 'developer', 'suggest', 'similar', 'permissions', 'datasafety'].map(GP)
const sdk = (items, status = 'success') => ({ schema_version: '1.0', project_id: '195', source_id: '195', operation: 'collect', observed_at: '2026-11-09T08:00:00Z',
  status, result: { source_row_id: 195, platform: 'xiaomi', status, data: { items, outcomes: [] }, warnings: [], error: null }, error: null })
const normalize = (capability, input) => normalizeJobRequest({ capability, input })
const rejects = (capability, input) => assert.throws(() => normalize(capability, input), { code: 'invalid_collect_request' }, JSON.stringify(input))

function fakeRunner({ start = () => ({ status: 202, body: { data: { state: 'accepted' } } }), state = () => ({ status: 200, body: { data: { state: 'running' } } }),
  abort = () => ({ status: 200, body: { data: { state: 'completed', failure: { code: 'aborted' } } } }), slots = Object.keys(COLLECT_RUNNER_SLOTS) } = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname
    const call = { method: init.method || 'GET', path, body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.authorization || null }
    calls.push(call)
    if (path === '/v1/health') {
      return Response.json({ data: { ok: true, version: '0.1.0', capacity: 8, running: 0,
        slots: slots.map(slotId => ({ slotId, available: slotId !== 'market-216', reason: slotId === 'market-216' ? 'integrity_mismatch' : null, operations: ['collect'] })) } })
    }
    const answer = call.method === 'POST' ? (path.endsWith('/abort') ? abort(call) : start(call)) : state(call, path.split('/').pop())
    if (answer instanceof Error) throw answer
    return Response.json(answer.body, { status: answer.status })
  }
  return { calls, fetchImpl }
}

async function fixture({ runner = fakeRunner(), egressFor = async () => null, engines = [] } = {}) {
  const ledger = new MemoryStore()
  const hub = new HubService({ store: ledger, adapter: {}, apiKeyPepper: PEPPER })
  const tenant = await hub.createTenant({ name: 'Delta' })
  const consumer = await hub.createConsumer({ tenantId: tenant.id, name: 'LCY-delta' })
  await ledger.setPlatformGrant(consumer.id, 'app_market', true)
  for (const capability of [DETAILS, ...GP_KEYS]) await hub.putCapabilityConfiguration(capability, { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await hub.createApiKey({ consumerId: consumer.id, name: 'delta', platforms: ['app_market'], capabilities: [DETAILS, ...GP_KEYS] })
  const context = await hub.authenticate(key.secret)
  const jobs = new MemoryCollectStore()
  const contracts = createCollectContracts()
  const credentialsFor = async provider => (provider === 'collect-runner' ? 'runner-token-0123456789abcdef' : null)
  const executor = new CollectExecutor({ jobs, ledger, contracts, credentialsFor, logger: { error() {}, warn() {} }, pollMs: 60_000,
    policyFor: (ctx, platform) => hub.usagePolicy(ctx, platform), fetchImpl: runner.fetchImpl, deps: { egressFor } })
  executor.stopped = false
  const egressStores = { googleplay: { describe: async () => ({ mode: 'proxy-sequence', sequenceKey: 'tikhub-internal-7788', revision: 1, sequences: [], recentProbeFailures: [] }) } }
  const service = new CollectService({ jobs, ledger, contracts, executor, credentialsFor, fetchImpl: runner.fetchImpl, egressStores })
  for (const engine of engines) {
    await service.adminCreateEngine({ kind: 'runner', baseUrl: 'http://127.0.0.1:18190', enabled: true, reason: '测试引擎', ...engine }, 'tester')
  }
  return { ledger, hub, context, jobs, executor, service, runner }
}

const XIAOMI = { id: 'runner.market-195', displayName: '小米', slotRef: 'market-195', routes: [{ capability: DETAILS, routeKey: 'xiaomi' }] }
const PLAY = { id: 'runner.market-193', displayName: 'Google Play', slotRef: 'market-193',
  routes: [{ capability: DETAILS, routeKey: 'googleplay' }, ...GP_KEYS.map(capability => ({ capability, routeKey: '' }))] }
const submit = (fx, capability, input, idem = `delta-${Math.random().toString(36).slice(2, 12)}`) => fx.service.submitJob(fx.context, { capability, input }, idem)
async function checkNow(fx) {
  for (const job of fx.jobs.jobs.values()) if (job.phase === 'waiting') job.nextCheckAt = new Date(Date.now() - 1).toISOString()
  await fx.executor.drain()
}

test('catalog: every market has its own identifier rules; history only where the package supports it', () => {
  assert.deepEqual(Object.keys(COLLECT_APP_MARKET_SLOTS), capabilityDefinition(DETAILS).routes.map(route => route.key))
  const cases = [
    ['xiaomi', { appIds: ['1359'] }, 'id'], ['vivo', { appIds: ['1'] }, 'id'], ['tencent', { appIds: ['com.tencent.mm'] }, 'package'],
    ['baidu', { appIds: ['com.tencent.mm'] }, 'package'], ['baidu', { appIds: ['123'], idKind: 'pid' }, 'pid'], ['baidu', { appIds: ['9'], idKind: 'docid' }, 'docid'],
    ['lenovo', { appIds: ['com.tencent.mm'] }, 'package'], ['wandoujia', { appIds: ['280151'] }, 'id'],
  ]
  for (const [market, input, kind] of cases) {
    const { item, definition } = normalize(DETAILS, { market, ...input })
    assert.equal(item.routeKey, market)
    assert.equal(item.input.idKind, kind)
    const call = definition.runner(item.input)
    assert.equal(call.operation, 'collect')
    assert.equal(call.params.input_kind, kind)
    assert.ok(call.params.max_requests >= 10 && call.params.max_requests <= 200)
    assert.ok(!('work_dir' in call.params) && !('proxy' in call.params), 'runner-owned parameters never come from Hub')
  }
  // Bounded history: Baidu by pid, Wandoujia by id, at most 10 apps x 5 versions.
  const history = normalize(DETAILS, { market: 'wandoujia', appIds: ['1', '2'], history: true, historyLimit: 5 })
  assert.deepEqual(history.definition.runner(history.item.input).params, { inputs: ['1', '2'], input_kind: 'id', history: true, history_limit: 5, max_requests: 16, timeout: 76 })
  const big = normalize(DETAILS, { market: 'xiaomi', appIds: Array.from({ length: 50 }, (_, index) => String(index + 1)) })
  assert.deepEqual([big.definition.runner(big.item.input).params.max_requests, big.definition.runner(big.item.input).params.timeout], [150, 210])
  rejects(DETAILS, { market: 'baidu', appIds: ['com.tencent.mm'], history: true })
  rejects(DETAILS, { market: 'xiaomi', appIds: ['1'], history: true })
  rejects(DETAILS, { market: 'wandoujia', appIds: Array.from({ length: 11 }, (_, index) => String(index + 1)), history: true })
  rejects(DETAILS, { market: 'wandoujia', appIds: ['1'], history: true, historyLimit: 6 })
  rejects(DETAILS, { market: 'tencent', appIds: ['12345'] })
  rejects(DETAILS, { market: 'vivo', appIds: ['com.vivo.app'] })
  rejects(DETAILS, { market: 'vivo', appIds: ['1'], idKind: 'package' })
  rejects(DETAILS, { market: 'lenovo', appIds: ['https://www.lenovomm.com/app/1'] })
  rejects(DETAILS, { market: 'xiaomi', appIds: ['1'], country: 'us' })
  rejects(DETAILS, { market: 'xiaomi', appIds: ['1'], work_dir: '/etc' })
})

test('catalog: Google Play details is one app per call; the other operations are reviewed whitelists', () => {
  const details = normalize(DETAILS, { market: 'googleplay', appIds: ['com.google.android.apps.translate'], country: 'JP', lang: 'ja' })
  assert.deepEqual(details.definition.runner(details.item.input), { operation: 'app', params: { app_id: 'com.google.android.apps.translate', country: 'jp', lang: 'ja' } })
  rejects(DETAILS, { market: 'googleplay', appIds: ['a.b', 'c.d'] })
  rejects(DETAILS, { market: 'googleplay', appIds: ['com.whatsapp'], country: 'usa' })
  const calls = {
    search: [{ term: 'translator', num: 5 }, { operation: 'search', params: { term: 'translator', num: 5, country: 'us', lang: 'en' } }],
    reviews: [{ appId: 'com.whatsapp', sort: 'rating', maxPages: 2, nextPageToken: 'CsQBCoAB', lang: 'zh-CN' },
      { operation: 'reviews', params: { app_id: 'com.whatsapp', sort: 'rating', max_pages: 2, next_page_token: 'CsQBCoAB', country: 'us', lang: 'zh-CN' } }],
    charts: [{ collection: 'GROSSING', category: 'GAME_ACTION' }, { operation: 'list', params: { collection: 'GROSSING', category: 'GAME_ACTION', num: 20, country: 'us', lang: 'en' } }],
    developer: [{ developerId: 'Google LLC' }, { operation: 'developer', params: { developer_id: 'Google LLC', num: 20, country: 'us', lang: 'en' } }],
    suggest: [{ term: 'pay' }, { operation: 'suggest', params: { term: 'pay', country: 'us', lang: 'en' } }],
    similar: [{ appId: 'com.whatsapp' }, { operation: 'similar', params: { app_id: 'com.whatsapp', country: 'us', lang: 'en' } }],
    permissions: [{ appId: 'com.whatsapp' }, { operation: 'permissions', params: { app_id: 'com.whatsapp', country: 'us', lang: 'en' } }],
    datasafety: [{ appId: 'com.whatsapp' }, { operation: 'datasafety', params: { app_id: 'com.whatsapp', lang: 'en' } }],
  }
  for (const [operation, [input, expected]] of Object.entries(calls)) {
    const { item, definition } = normalize(GP(operation), input)
    assert.equal(item.routeKey, '')
    assert.deepEqual(definition.runner(item.input), expected, operation)
  }
  rejects(GP('search'), { term: 'x', num: 51 })
  rejects(GP('reviews'), { appId: 'com.whatsapp', maxPages: 6 })
  rejects(GP('reviews'), { appId: 'com.whatsapp', sort: 'oldest' })
  rejects(GP('charts'), { collection: 'TOP_NEW' })
  rejects(GP('charts'), { category: 'game action' })
  rejects(GP('datasafety'), { appId: 'com.whatsapp', country: 'us' })
  rejects(GP('similar'), { appId: 'whatsapp' })
  rejects(GP('search'), { term: 'x', proxy: 'http://evil:1' })
  rejects(GP('search'), { term: 'x', node_path: '/bin/sh' })
  // Item counts read the SDK object the adapters return.
  assert.equal(capabilityDefinition(DETAILS).itemCount(sdk([{ a: 1 }, { a: 2 }])), 2)
  assert.equal(capabilityDefinition(GP('search')).itemCount(sdk([])), 0)
})

test('Google Play capabilities are public, never auto-granted, and need the market-193 slot and its proxy binding', () => {
  for (const key of GP_KEYS) {
    const capability = COLLECT_CAPABILITIES.find(row => row.key === key)
    assert.equal(capability.slotRef, 'market-193')
    assert.deepEqual(capability.kinds, ['runner'])
    assert.equal(capability.stage, 'candidate')
    assert.equal(businessApiScopes().capabilities.includes(key), false)
  }
  assert.equal(collectEgressProvider({ kind: 'runner', slotRef: 'market-193' }), 'googleplay')
  assert.equal(collectEgressProvider({ kind: 'runner', slotRef: 'market-195' }), null)
  assert.equal(collectEgressProvider({ kind: 'apify', slotRef: null }), 'apify')
})

test('admin: a runner engine only takes the capabilities its package slot serves', async () => {
  const fx = await fixture({ engines: [XIAOMI] })
  await assert.rejects(fx.service.adminCreateEngine({ kind: 'runner', id: 'runner.wrong', displayName: 'x', slotRef: 'market-195', baseUrl: 'http://127.0.0.1:18190',
    routes: [{ capability: GP('search'), routeKey: '' }], reason: '错配' }, 't'), { code: 'invalid_engine_config', message: /market-193/ })
  await assert.rejects(fx.service.adminCreateEngine({ kind: 'runner', id: 'runner.wrong', displayName: 'x', slotRef: 'market-197', baseUrl: 'http://127.0.0.1:18190',
    routes: [{ capability: DETAILS, routeKey: 'xiaomi' }], reason: '错配' }, 't'), { code: 'invalid_engine_config' })
  // Moving an engine to another slot may not strand its routes.
  await assert.rejects(fx.service.adminConfigureEngine(XIAOMI.id, { slotRef: 'market-197', expectedRevision: 0, reason: '改插槽' }, 't'), { code: 'invalid_engine_config' })
  const play = await fx.service.adminCreateEngine({ kind: 'runner', baseUrl: 'http://127.0.0.1:18190', enabled: true, reason: '新建', ...PLAY }, 't')
  assert.equal(play.credentialProvider, 'collect-runner', 'runner engines default to the shared runner token')
  const detail = await fx.service.adminEngine(PLAY.id)
  assert.equal(detail.egress.provider, 'googleplay')
  assert.equal(detail.egress.sequenceKey, 'tikhub-internal-7788')
  assert.equal((await fx.service.adminEngine(XIAOMI.id)).egress, null, 'domestic markets go direct')
  await assert.rejects(fx.service.adminConfigureEngine(PLAY.id, { credentialProvider: null, expectedRevision: 0, reason: '去掉凭据' }, 't'), { code: 'invalid_engine_config' })
})

test('start: Google Play calls carry the selected proxy, domestic calls never do; a dead binding fails before the runner', async () => {
  const selected = []
  const fx = await fixture({ engines: [XIAOMI, PLAY], egressFor: async provider => { selected.push(provider); return 'http://127.0.0.1:7788' } })
  await submit(fx, DETAILS, { market: 'xiaomi', appIds: ['1359'] })
  await submit(fx, GP('search'), { term: 'translator' })
  await fx.executor.drain()
  const posts = fx.runner.calls.filter(call => call.method === 'POST')
  const bySlot = Object.fromEntries(posts.map(call => [call.body.slotId, call.body]))
  assert.equal(bySlot['market-195'].proxyUrl, undefined)
  assert.equal(bySlot['market-193'].proxyUrl, 'http://127.0.0.1:7788')
  assert.equal(bySlot['market-193'].operation, 'search')
  assert.deepEqual(selected, ['googleplay'])
  assert.ok(posts.every(call => call.auth === 'Bearer runner-token-0123456789abcdef'))

  const dead = await fixture({ engines: [PLAY], egressFor: async () => { throw Object.assign(new Error('down'), { code: 'proxy_routes_unreachable' }) } })
  const { data } = await submit(dead, GP('suggest'), { term: 'pay' })
  await dead.executor.drain()
  const job = await dead.jobs.get(data.jobId)
  assert.equal(job.status, 'failed')
  assert.equal(job.error.code, 'egress_unavailable')
  assert.equal(dead.runner.calls.length, 0)
  assert.equal((await dead.service.adminEngine(PLAY.id)).slots[0].jobId, null)
})

test('runner endings: envelopes, runner failures and refusals map to outcomes that never hold a slot', async () => {
  const answers = new Map()
  const runner = fakeRunner({
    start: call => {
      const [first] = call.body.params.inputs
      if (first === '424') return { status: 424, body: { error: { code: 'package_unavailable' } } }
      if (first === '404') return { status: 404, body: { error: { code: 'slot_unknown' } } }
      return { status: 202, body: { data: { state: 'accepted' } } }
    },
    state: (call, id) => answers.get(id) || { status: 200, body: { data: { state: 'running' } } },
  })
  const fx = await fixture({ runner, engines: [{ ...XIAOMI, capacity: 4 }] })
  const ok = (await submit(fx, DETAILS, { market: 'xiaomi', appIds: ['1359'] })).data.jobId
  const late = (await submit(fx, DETAILS, { market: 'xiaomi', appIds: ['2'] })).data.jobId
  const refusedPackage = (await submit(fx, DETAILS, { market: 'xiaomi', appIds: ['424'] })).data.jobId
  const refusedSlot = (await submit(fx, DETAILS, { market: 'xiaomi', appIds: ['404'] })).data.jobId
  await fx.executor.drain()
  answers.set(ok, { status: 200, body: { data: { state: 'completed', durationMs: 4200, envelope: sdk([{ app: { app_id: '1359', name: 'QQ' } }]) } } })
  answers.set(late, { status: 200, body: { data: { state: 'completed', durationMs: 90_000, envelope: null, failure: { code: 'deadline_exceeded', message: 'stopped' } } } })
  await checkNow(fx)
  const done = await fx.jobs.get(ok)
  assert.equal(done.status, 'succeeded')
  assert.equal(done.result.itemCount, 1)
  assert.equal((await fx.jobs.result(ok)).payload.result.data.items[0].app.name, 'QQ')
  assert.equal((await fx.jobs.get(late)).error.code, 'runner_deadline_exceeded')
  assert.equal((await fx.jobs.get(refusedPackage)).error.code, 'runner_package_unavailable')
  assert.equal((await fx.jobs.get(refusedSlot)).error.code, 'runner_slot_unknown')
  assert.ok((await fx.service.adminEngine(XIAOMI.id)).slots.every(slot => slot.jobId === null && !slot.quarantineReason))
})

test('deadline: a confirmed runner abort is a plain failure, an unconfirmed one stays unknown', async () => {
  for (const [abort, expected] of [
    [() => ({ status: 200, body: { data: { state: 'completed', failure: { code: 'aborted' } } } }), 'failed'],
    [() => ({ status: 503, body: { error: { code: 'runner_closing' } } }), 'unknown'],
  ]) {
    const fx = await fixture({ runner: fakeRunner({ abort }), engines: [XIAOMI] })
    const { data } = await submit(fx, DETAILS, { market: 'xiaomi', appIds: ['1'] })
    await fx.executor.drain()
    const job = fx.jobs.jobs.get(data.jobId)
    job.runDeadlineAt = new Date(Date.now() - 120_000).toISOString()
    await checkNow(fx)
    const settled = await fx.jobs.get(data.jobId)
    assert.equal(settled.status, expected)
    assert.equal(settled.error.code, 'run_deadline_exceeded')
    assert.ok(fx.runner.calls.some(call => call.path.endsWith('/abort')))
  }
})

test('probe: an engine is healthy only when the runner can run its package', async () => {
  const fx = await fixture({ engines: [XIAOMI, { id: 'runner.market-216', displayName: '百度', slotRef: 'market-216', routes: [{ capability: DETAILS, routeKey: 'baidu' }] }] })
  const good = await fx.service.adminProbe(XIAOMI.id)
  assert.equal(good.healthy, true)
  assert.equal(good.slot.slotId, 'market-195')
  const tampered = await fx.service.adminProbe('runner.market-216')
  assert.equal(tampered.healthy, false)
  assert.equal(tampered.slot.reason, 'integrity_mismatch')
  const missing = await runnerContract.probe({ engine: { slotRef: 'market-999', baseUrl: 'http://127.0.0.1:18190' }, credential: 't', fetchImpl: fakeRunner().fetchImpl })
  assert.equal(missing.healthy, false)
  assert.equal(missing.error, 'slot_not_on_runner')
})

test('proxy selector: probes the bound sequence, caches the verdict and never returns a dead proxy', async () => {
  let routeCalls = 0
  const store = {
    route: async () => { routeCalls += 1; return { proxyUrls: ['http://127.0.0.1:7788', 'http://127.0.0.1:7890'], directFallback: false, fingerprint: 'fp', probePolicy: { timeoutMs: 1000, attempts: 1, cacheTtlMs: 60_000 } } },
    recordProbeFailure: async () => {},
  }
  const probes = []
  const fetchImpl = async (url, { dispatcher }) => { probes.push(dispatcher.url); return new Response(null, { status: dispatcher.url.includes('7788') ? 502 : 200 }) }
  const select = createProviderProxySelector(store, { providerKey: 'googleplay', fetchImpl, makeAgent: url => ({ url, close: async () => {} }) })
  assert.equal(await select(), 'http://127.0.0.1:7890')
  assert.equal(await select(), 'http://127.0.0.1:7890')
  assert.deepEqual(probes, ['http://127.0.0.1:7788', 'http://127.0.0.1:7890'], 'second call is served from the cache')
  assert.equal(routeCalls, 2)
  const allDead = createProviderProxySelector({ ...store, route: async () => ({ ...(await store.route()), proxyUrls: ['http://127.0.0.1:7788'] }) },
    { providerKey: 'googleplay', fetchImpl, makeAgent: url => ({ url, close: async () => {} }) })
  await assert.rejects(allDead(), { code: 'proxy_routes_unreachable' })
  const direct = createProviderProxySelector({ route: async () => ({ proxyUrls: [], directFallback: true, fingerprint: 'd', probePolicy: {} }) }, { providerKey: 'googleplay' })
  assert.equal(await direct(), null)
})

// Protocol check against the real runner when the monorepo has it: Hub's
// executor drives mx-crawler-runner over HTTP with a test adapter package.
const RUNNER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../mx-base/mx-crawler-runner')
test('end to end with mx-crawler-runner: submit, run, check, result', { skip: !existsSync(join(RUNNER_ROOT, 'src', 'runner.mjs')) && 'mx-crawler-runner not present' }, async () => {
  const { Runner } = await import(pathToFileURL(join(RUNNER_ROOT, 'src', 'runner.mjs')).href)
  const { loadCatalog, treeHash } = await import(pathToFileURL(join(RUNNER_ROOT, 'src', 'catalog.mjs')).href)
  const { createRunnerServer } = await import(pathToFileURL(join(RUNNER_ROOT, 'src', 'http.mjs')).href)
  const dir = mkdtempSync(join(tmpdir(), 'hub-runner-e2e-'))
  cpSync(join(RUNNER_ROOT, 'tests', 'fixtures', 'echo'), join(dir, 'packages', 'echo'), { recursive: true })
  writeFileSync(join(dir, 'packages.json'), JSON.stringify({ catalogVersion: 1, packages: { 'market-195': { packageId: 'echo', root: 'packages/echo', interpreter: 'node',
    entry: 'adapter.mjs', operations: ['collect'], inject: { work_dir: 'work' }, sha256: treeHash(join(dir, 'packages', 'echo')).sha256 } } }))
  const runner = new Runner({ slots: loadCatalog(join(dir, 'packages.json')), dataDir: join(dir, 'data'), logger: () => {} })
  await runner.init()
  const server = createRunnerServer({ runner, token: 'runner-token-0123456789abcdef', logger: () => {} })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  try {
    const fx = await fixture({ runner: { fetchImpl: globalThis.fetch, calls: [] }, engines: [{ ...XIAOMI, baseUrl: `http://127.0.0.1:${server.address().port}` }] })
    assert.equal((await fx.service.adminProbe(XIAOMI.id)).healthy, true)
    const { data } = await submit(fx, DETAILS, { market: 'xiaomi', appIds: ['1359', '108048'] })
    await fx.executor.drain()
    for (let attempt = 0; attempt < 100 && (await fx.jobs.get(data.jobId)).status === 'running'; attempt++) {
      await new Promise(done => setTimeout(done, 50))
      await checkNow(fx)
    }
    const job = await fx.jobs.get(data.jobId)
    assert.equal(job.status, 'succeeded')
    const { payload } = await fx.jobs.result(data.jobId)
    assert.equal(payload.status, 'success')
    assert.deepEqual(payload.result.params.inputs, ['1359', '108048'])
    assert.equal(payload.result.params.input_kind, 'id')
    assert.match(payload.result.params.work_dir, new RegExp(`${data.jobId}/data$`), 'the runner, not Hub, owns the work directory')
  } finally {
    server.close()
    await runner.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
