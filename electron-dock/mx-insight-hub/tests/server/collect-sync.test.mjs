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
import { createCollectCredentials } from '../../server/collect/runtime.mjs'
import { shodanContract } from '../../server/collect/contracts/shodan.mjs'
import { normalizeJobRequest, capabilityDefinition } from '../../server/collect/catalog.mjs'
import { dnsLookup } from '../../server/collect/native/dns.mjs'
import { rdapDomain, resetRdapBootstrap, RDAP_BOOTSTRAP_URL } from '../../server/collect/native/rdap.mjs'
import { ctIssuances } from '../../server/collect/native/ct.mjs'
import { dataAdmissionLane } from '../../server/core/data-admission.mjs'

const PEPPER = 'collect-sync-test-pepper-at-least-32-bytes'
const ADMIN_TOKEN = 'collect-sync-admin-token'
const DNS = 'collect.intel.dns.lookup'
const RDAP = 'collect.intel.rdap.domain'
const HOST = 'collect.intel.shodan.host'
const errorWith = code => Object.assign(new Error(code), { code })

// A scriptable DNS resolver: answers[type] is an array or an error code.
function fakeResolver(answers = {}) {
  const seen = { servers: null, calls: [] }
  class Resolver {
    constructor(options) { seen.options = options }
    setServers(servers) { seen.servers = servers }
  }
  for (const [type, method] of Object.entries({ A: 'resolve4', AAAA: 'resolve6', CNAME: 'resolveCname', MX: 'resolveMx', NS: 'resolveNs', TXT: 'resolveTxt', SOA: 'resolveSoa', CAA: 'resolveCaa' })) {
    Resolver.prototype[method] = async name => {
      seen.calls.push([type, name])
      const answer = answers[type] ?? 'ENODATA'
      if (typeof answer === 'string') throw errorWith(answer)
      return answer
    }
  }
  return { Resolver, seen }
}

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

function routerFetch(routes) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(url)
    calls.push({ url: target, init })
    for (const [pattern, handler] of routes) if (pattern.test(target.href)) { const answer = handler(target, init); if (answer instanceof Error) throw answer; return answer }
    return json({ error: 'not found' }, 404)
  }
  return { calls, fetchImpl }
}

async function fixture({ engines = [], fetchImpl = async () => json({}), Resolver, capabilities = [DNS, RDAP, HOST], syncWaitMs = 2_000 } = {}) {
  const ledger = new MemoryStore()
  const hub = new HubService({ store: ledger, adapter: {}, apiKeyPepper: PEPPER })
  const tenant = await hub.createTenant({ name: 'Delta' })
  const consumer = await hub.createConsumer({ tenantId: tenant.id, name: 'LCY-delta' })
  for (const capability of capabilities) await hub.putCapabilityConfiguration(capability, { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await hub.createApiKey({ consumerId: consumer.id, name: 'delta', platforms: [], capabilities })
  const context = await hub.authenticate(key.secret)
  const jobs = new MemoryCollectStore()
  const contracts = createCollectContracts()
  const credentials = createCollectCredentials(null)
  const options = { jobs, ledger, contracts, credentialsFor: credentials.read, fetchImpl, deps: Resolver ? { Resolver } : {}, logger: { error() {}, warn() {} }, pollMs: 60_000,
    policyFor: (ctx, platform) => hub.usagePolicy(ctx, platform) }
  const executor = new CollectExecutor(options)
  executor.stopped = false
  // A Public process: its inline runner is never started.
  const runner = new CollectExecutor({ ...options, owner: 'inline:test' })
  const service = new CollectService({ jobs, ledger, contracts, executor: null, runner, credentials, fetchImpl, syncWaitMs })
  for (const { credential, ...engine } of engines) {
    await service.adminCreateEngine({ enabled: true, reason: '阶段 3', ...engine }, 'tester')
    if (credential) await service.adminSetCredential(engine.id, { apiKey: credential, expectedRevision: 0, reason: '录入' }, 'tester')
  }
  return { ledger, hub, key, context, jobs, executor, runner, service }
}
const nativeEngine = (extra = {}) => ({ id: 'native.main', kind: 'native', displayName: 'Hub 原生', capacity: 2,
  routes: [{ capability: DNS }, { capability: RDAP }, { capability: 'collect.intel.ct.issuances' }], ...extra })
const shodanEngine = (extra = {}) => ({ id: 'shodan.main', kind: 'shodan', displayName: 'Shodan', capacity: 1,
  routes: [{ capability: HOST }, { capability: 'collect.intel.shodan.count' }], credential: 'shodan-test-key', ...extra })
const query = (fx, capability, input, idem = `delta-${Math.random().toString(36).slice(2, 12)}`) => fx.service.queryNow(fx.context, { capability, input }, idem)

test('catalog: names, IPs and filters are validated before anything is sent', () => {
  assert.deepEqual(normalizeJobRequest({ capability: DNS, input: { name: '_DMARC.Example.com.', types: ['mx', 'txt'] } }).item.input,
    { name: '_dmarc.example.com', types: ['MX', 'TXT'], resolver: 'alidns' })
  assert.equal(normalizeJobRequest({ capability: RDAP, input: { domain: 'bücher.de' } }).item.input.domain, 'xn--bcher-kva.de')
  assert.equal(normalizeJobRequest({ capability: HOST, input: { ip: '2001:4860:4860::8888' } }).item.input.ip, '2001:4860:4860::8888')
  for (const [capability, input] of [
    [DNS, { name: 'https://example.com' }], [DNS, { name: '8.8.8.8' }], [DNS, { name: 'localhost' }], [DNS, { name: 'printer.local' }],
    [DNS, { name: 'api.internal' }], [DNS, { name: 'hub.svc' }], [DNS, { name: 'example.com', resolver: 'system' }], [DNS, { name: 'example.com', types: ['PTR'] }],
    [RDAP, { domain: 'example.com/whois' }], [RDAP, { domain: '_x.example.com' }],
    [HOST, { ip: '10.1.2.3' }], [HOST, { ip: '127.0.0.1' }], [HOST, { ip: '192.168.1.2' }], [HOST, { ip: '100.127.0.1' }], [HOST, { ip: '::1' }],
    [HOST, { ip: 'fd00::1' }], [HOST, { ip: '::ffff:10.0.0.1' }], [HOST, { ip: 'example.com' }],
    ['collect.intel.shodan.search', { query: 'apache', facets: 'country;drop' }], ['collect.intel.shodan.search', { query: 'apache', page: 2 }],
    ['collect.intel.ct.issuances', { domain: 'example.com', maxItems: 5000 }],
  ]) assert.throws(() => normalizeJobRequest({ capability, input }), { code: 'invalid_collect_request' }, `${capability} ${JSON.stringify(input)}`)
  assert.equal(dataAdmissionLane('POST', '/api/v1/data/collect/query'), 'acquisition', '/query may call upstream inside the request')
  assert.equal(dataAdmissionLane('POST', '/api/v1/data/collect/jobs'), 'read')
})

test('DNS: a public resolver is always set; empty, missing and failed types are told apart', async () => {
  const { Resolver, seen } = fakeResolver({ A: [{ address: '93.184.215.14', ttl: 300 }], TXT: [['v=spf1 ', '-all']], MX: 'ETIMEOUT' })
  const outcome = await dnsLookup({ input: { name: 'example.com', types: ['A', 'TXT', 'MX', 'AAAA'], resolver: 'cloudflare' }, deps: { Resolver } })
  assert.deepEqual(seen.servers, ['1.1.1.1'])
  assert.deepEqual([outcome.status, outcome.dataStatus], ['succeeded', 'partial'])
  assert.deepEqual(outcome.result.records.TXT, ['v=spf1 -all'])
  assert.deepEqual(outcome.result.records.AAAA, [])
  assert.deepEqual(outcome.result.errors, { MX: 'ETIMEOUT' })
  const missing = await dnsLookup({ input: { name: 'nope.example.com', types: ['A'], resolver: 'alidns' }, deps: { Resolver: fakeResolver({ A: 'ENOTFOUND' }).Resolver } })
  assert.deepEqual([missing.dataStatus, missing.result.nxdomain], ['no_data', true])
  const down = await dnsLookup({ input: { name: 'example.com', types: ['A'], resolver: 'alidns' }, deps: { Resolver: fakeResolver({ A: 'ECONNREFUSED' }).Resolver } })
  assert.deepEqual([down.status, down.error.code], ['failed', 'dns_lookup_failed'])
})

test('RDAP: the registry comes from the IANA bootstrap; redirects stay on public https hosts', async () => {
  resetRdapBootstrap()
  const bootstrap = json({ services: [[['com', 'net'], ['https://rdap.verisign.com/com/v1/']], [['co.uk'], ['https://rdap.nominet.uk/uk/']], [['uk'], ['http://insecure.example/']]] })
  const { calls, fetchImpl } = routerFetch([
    [/data\.iana\.org/, () => bootstrap.clone()],
    [/verisign\.com\/com\/v1\/domain\/example\.com$/, () => json({ objectClassName: 'domain', ldhName: 'EXAMPLE.COM', events: [] })],
    [/verisign\.com\/com\/v1\/domain\/missing\.com$/, () => json({ errorCode: 404 }, 404)],
    [/verisign\.com\/com\/v1\/domain\/moved\.com$/, () => new Response(null, { status: 302, headers: { location: 'https://rdap.registrar.example/domain/moved.com' } })],
    [/registrar\.example\/domain\/moved\.com$/, () => json({ objectClassName: 'domain', ldhName: 'MOVED.COM' })],
    [/verisign\.com\/com\/v1\/domain\/sneaky\.com$/, () => new Response(null, { status: 302, headers: { location: 'https://10.0.0.5/domain/sneaky.com' } })],
    [/verisign\.com\/com\/v1\/domain\/busy\.com$/, () => json({}, 429, { 'retry-after': '12' })],
    [/nominet\.uk\/uk\/domain\/example\.co\.uk$/, () => json({ objectClassName: 'domain' })],
  ])
  const ok = await rdapDomain({ input: { domain: 'example.com' }, fetchImpl })
  assert.deepEqual([ok.status, ok.dataStatus, ok.result.server, ok.result.rdap.ldhName], ['succeeded', 'success', 'https://rdap.verisign.com', 'EXAMPLE.COM'])
  assert.equal((await rdapDomain({ input: { domain: 'missing.com' }, fetchImpl })).dataStatus, 'no_data')
  assert.equal((await rdapDomain({ input: { domain: 'moved.com' }, fetchImpl })).result.rdap.ldhName, 'MOVED.COM')
  assert.equal((await rdapDomain({ input: { domain: 'sneaky.com' }, fetchImpl })).error.code, 'rdap_redirect_refused')
  const busy = await rdapDomain({ input: { domain: 'busy.com' }, fetchImpl })
  assert.equal(busy.error.code, 'rdap_rate_limited')
  assert.ok(busy.cooldownUntil > Date.now() + 10_000)
  assert.equal((await rdapDomain({ input: { domain: 'example.co.uk' }, fetchImpl })).status, 'succeeded', 'longest suffix wins')
  assert.equal((await rdapDomain({ input: { domain: 'example.dev' }, fetchImpl })).error.code, 'rdap_unsupported_tld')
  assert.equal(calls.filter(call => call.url.href === RDAP_BOOTSTRAP_URL).length, 1, 'the bootstrap is cached')
  assert.ok(!calls.some(call => call.url.hostname === 'insecure.example'), 'a non-https registry is never used')
})

test('CT: issuances page with after= until the limit; rate limits cool the engine down', async () => {
  const page = (from, n) => Array.from({ length: n }, (_, index) => ({ id: String(from + index), dns_names: [`h${from + index}.example.com`] }))
  const { calls, fetchImpl } = routerFetch([[/api\.certspotter\.com/, url => {
    const after = Number(url.searchParams.get('after') || 0)
    return json(after >= 200 ? [] : page(after + 1, 100))
  }]])
  const capped = await ctIssuances({ input: { domain: 'example.com', includeSubdomains: true, maxItems: 150 }, fetchImpl, credential: 'ct-key' })
  assert.deepEqual([capped.status, capped.dataStatus, capped.itemCount], ['succeeded', 'success', 150])
  assert.equal(calls[1].url.searchParams.get('after'), '100')
  assert.equal(calls[0].url.searchParams.get('include_subdomains'), 'true')
  assert.deepEqual(calls[0].url.searchParams.getAll('expand'), ['dns_names', 'issuer'])
  assert.equal(calls[0].init.headers.authorization, 'Bearer ct-key')
  const all = await ctIssuances({ input: { domain: 'example.com', includeSubdomains: false, maxItems: 1000 }, fetchImpl: routerFetch([[/certspotter/, url => json(Number(url.searchParams.get('after') || 0) >= 200 ? [] : page(Number(url.searchParams.get('after') || 0) + 1, 100))]]).fetchImpl })
  assert.deepEqual([all.itemCount, all.dataStatus, all.result.exhausted], [200, 'success', true])
  const limited = await ctIssuances({ input: { domain: 'example.com', includeSubdomains: false, maxItems: 10 }, fetchImpl: async () => json({}, 429, { 'retry-after': '90' }) })
  assert.equal(limited.error.code, 'ct_rate_limited')
  assert.ok(limited.cooldownUntil > Date.now() + 60_000)
})

test('Shodan contract: key in the query, 404 is no data, lost answers are unknown but free the slot', async () => {
  const definition = capabilityDefinition(HOST)
  const job = { input: { ip: '8.8.8.8', history: false, minify: false } }
  const run = async answer => {
    const seen = []
    const result = await shodanContract.dispatch({ job, definition, credential: 'shodan-test-key',
      fetchImpl: async (url, init) => { seen.push(new URL(url)); if (answer instanceof Error) throw answer; return answer } })
    return { outcome: result.outcome, url: seen[0] }
  }
  const ok = await run(json({ ip_str: '8.8.8.8', data: [{ port: 53 }, { port: 443 }] }))
  assert.deepEqual([ok.outcome.status, ok.outcome.itemCount, ok.outcome.result.endpoint], ['succeeded', 2, '/shodan/host/{ip}'])
  assert.equal(ok.url.pathname, '/shodan/host/8.8.8.8')
  assert.equal(ok.url.searchParams.get('key'), 'shodan-test-key')
  assert.equal(ok.url.searchParams.has('history'), false, 'false flags are not sent')
  assert.equal(JSON.stringify(ok.outcome).includes('shodan-test-key'), false)
  assert.equal((await run(json({ error: 'No information available for that IP.' }, 404))).outcome.dataStatus, 'no_data')
  assert.equal((await run(json({ error: 'Invalid API key' }, 401))).outcome.error.code, 'shodan_auth_failed')
  assert.equal((await run(json({ error: 'Insufficient query credits' }, 403))).outcome.error.code, 'shodan_plan_insufficient')
  assert.ok((await run(json({}, 429))).outcome.cooldownUntil > Date.now())
  const lost = (await run(Object.assign(new Error('t'), { name: 'TimeoutError' }))).outcome
  assert.deepEqual([lost.status, lost.quarantine], ['unknown', null])
})

test('query: a free slot answers 200 with the result inside the request', async () => {
  const { Resolver } = fakeResolver({ A: [{ address: '93.184.215.14', ttl: 60 }] })
  const fx = await fixture({ engines: [nativeEngine()], Resolver })
  const answer = await query(fx, DNS, { name: 'example.com', types: ['A'] })
  assert.equal(answer.completed, true)
  assert.deepEqual([answer.data.job.status, answer.data.result.dataStatus, answer.data.result.payload.records.A[0].address], ['succeeded', 'success', '93.184.215.14'])
  assert.match(answer.data.result.evidence.sha256, /^[0-9a-f]{64}$/)
  const replay = await fx.service.queryNow(fx.context, { capability: DNS, input: { name: 'example.com', types: ['A'] } }, 'delta-dns-replay1')
  const again = await fx.service.queryNow(fx.context, { capability: DNS, input: { name: 'example.com', types: ['A'] } }, 'delta-dns-replay1')
  assert.deepEqual([again.replay, again.data.job.jobId], [true, replay.data.job.jobId], 'a replay returns the stored result')
  assert.equal((await fx.service.adminEngine('native.main')).slots.every(slot => !slot.jobId), true)
  await assert.rejects(fx.service.queryNow(fx.context, { capability: 'collect.ecommerce.temu.search', input: { keyword: 'x' } }, 'delta-temu-q1'), { code: 'capability_not_synchronous' })
})

test('query: without a free slot it falls back to 202 and the queue', async () => {
  const fx = await fixture({ engines: [nativeEngine({ capacity: 1 })], Resolver: fakeResolver({ A: [] }).Resolver, syncWaitMs: 300 })
  // Occupy the only slot with another job held by a live executor.
  fx.executor.stopped = true
  const first = await fx.service.submitJob(fx.context, { capability: DNS, input: { name: 'busy.example.com' } }, 'delta-dns-busy01')
  await fx.jobs.claim({ engineId: 'native.main', owner: 'someone', leaseGraceMs: 30_000 })
  const answer = await query(fx, DNS, { name: 'example.com' })
  assert.equal(answer.completed, false)
  assert.equal(answer.data.status, 'queued')
  assert.equal(answer.data.queue.position, 1)
  assert.equal((await fx.jobs.get(first.data.jobId)).status, 'running')
})

test('query: Shodan calls are paced one per second across the engine', async () => {
  const stamps = []
  const fetchImpl = async url => { stamps.push(Date.now()); return json({ ip_str: new URL(url).pathname.split('/').pop(), data: [] }) }
  const fx = await fixture({ engines: [shodanEngine()], fetchImpl })
  const first = await query(fx, HOST, { ip: '8.8.8.8' })
  const second = await query(fx, HOST, { ip: '1.1.1.1' })
  assert.deepEqual([first.completed, second.completed], [true, true])
  assert.ok(stamps[1] - stamps[0] >= 1_000, `second call waited for the pace (${stamps[1] - stamps[0]} ms)`)
  assert.equal((await fx.service.adminEngine('shodan.main')).events.filter(event => event.action === 'cooldown').length, 0, 'pacing writes no audit events')
  assert.equal(second.data.result.dataStatus, 'no_data')
})

test('read-only orphan: a lost inline query fails and frees its slot, never a quarantine', async () => {
  const fx = await fixture({ engines: [nativeEngine({ capacity: 1 })], Resolver: fakeResolver().Resolver })
  fx.executor.stopped = true
  const { data } = await fx.service.submitJob(fx.context, { capability: RDAP, input: { domain: 'example.com' } }, 'delta-rdap-lost1')
  await fx.jobs.claimJob({ jobId: data.jobId, owner: 'inline:dead', leaseGraceMs: 30_000 })
  fx.jobs.jobs.get(data.jobId).leaseUntil = new Date(Date.now() - 1).toISOString()
  fx.executor.stopped = false
  fx.executor.lastHousekeepingAt = 0
  await fx.executor.drain()
  const job = await fx.jobs.get(data.jobId)
  assert.deepEqual([job.status, job.error.code], ['failed', 'executor_lost'])
  assert.equal((await fx.service.adminEngine('native.main')).slots[0].quarantineReason, null)
})

test('HTTP: POST /query answers 200 with the result; a stopped engine is refused with 503', async () => {
  const { Resolver } = fakeResolver({ A: [{ address: '93.184.215.14', ttl: 60 }] })
  const fx = await fixture({ engines: [nativeEngine()], Resolver })
  const server = createServer(createApp({ service: fx.hub, store: fx.ledger, adapter: { dependencies: async () => ({ status: 'up' }) },
    adminToken: ADMIN_TOKEN, listenerMode: 'combined', logger: { error() {} }, collect: fx.service }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (body, idem) => fetch(`${base}/api/v1/data/collect/query`, { method: 'POST',
    headers: { authorization: `Bearer ${fx.key.secret}`, 'content-type': 'application/json', ...(idem ? { 'idempotency-key': idem } : {}) }, body: JSON.stringify(body) })
  try {
    assert.equal((await post({ capability: DNS, input: { name: 'example.com' } })).status, 400)
    const ok = await post({ capability: DNS, input: { name: 'example.com', types: ['A'] } }, 'delta-http-q0001')
    assert.equal(ok.status, 200)
    const body = await ok.json()
    assert.equal(body.data.result.payload.records.A[0].address, '93.184.215.14')
    await fx.service.adminConfigureEngine('native.main', { enabled: false, expectedRevision: 0, reason: '停用' }, 't')
    assert.equal((await post({ capability: DNS, input: { name: 'example.com' } }, 'delta-http-q0002')).status, 503)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
