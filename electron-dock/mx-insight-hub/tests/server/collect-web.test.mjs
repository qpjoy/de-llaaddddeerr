import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HubService, businessApiScopes } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { MemoryCollectStore } from '../../server/collect/store.mjs'
import { CollectExecutor } from '../../server/collect/executor.mjs'
import { CollectService } from '../../server/collect/service.mjs'
import { createCollectContracts } from '../../server/collect/contracts/index.mjs'
import { normalizeJobRequest, capabilityDefinition } from '../../server/collect/catalog.mjs'
import { subdomains, underDomain } from '../../server/collect/native/subdomains.mjs'
import { createProviderProxySelector } from '../../server/external-platforms/proxy.mjs'
import { COLLECT_CAPABILITIES, COLLECT_URL_SITE_SLOTS, collectEgressProvider } from '../../shared/collect-engines.mjs'

// Integration plan phase 5: link enrichment on the runner, subdomains native.
const PEPPER = 'collect-web-test-pepper-at-least-32-bytes'
const URL_CAP = 'collect.web.url.details'
const SUB_CAP = 'collect.intel.subdomains'
const normalize = (capability, input) => normalizeJobRequest({ capability, input })
const rejects = (input, field = 'url') => assert.throws(() => normalize(URL_CAP, input), { code: 'invalid_collect_request' }, `${JSON.stringify(input)} (${field})`)
const record = (target, data, status = 'success') => ({ schema_version: '1.0', project_id: 'x', source_id: 'x', operation: 'collect', observed_at: '2026-11-09T08:00:00Z',
  status: status === 'success' ? 'success' : 'error', result: { id: 1, target, status, data }, error: null })

test('url details: each site accepts only its own hosts and accepted link shapes', () => {
  const accepted = [
    ['https://www.pinterest.com/pin/858146903966145189/', 'pinterest', 'https://www.pinterest.com/pin/858146903966145189/'],
    ['https://uk.pinterest.com/pin/858146903966145189/?utm=1#x', 'pinterest', 'https://uk.pinterest.com/pin/858146903966145189/'],
    ['https://pin.it/4aBcD9x', 'pinterest', 'https://pin.it/4aBcD9x'],
    ['https://medium.com/@sarperavci/two-million-hackthebox-write-up-7433944f4f04?source=rss', 'medium', 'https://medium.com/@sarperavci/two-million-hackthebox-write-up-7433944f4f04'],
    ['https://medium.com/p/7433944f4f04', 'medium', 'https://medium.com/p/7433944f4f04'],
    ['https://author.medium.com/a-title-7433944f4f04', 'medium', 'https://author.medium.com/a-title-7433944f4f04'],
    ['https://www.snapchat.com/spotlight/W7_EDlXWTBiXAEEniNoMPwAAYZGtpbXFp', 'snapchat', 'https://www.snapchat.com/spotlight/W7_EDlXWTBiXAEEniNoMPwAAYZGtpbXFp'],
    ['https://www.dailymotion.com/video/xhfpjn', 'dailymotion', 'https://www.dailymotion.com/video/xhfpjn'],
    ['https://dai.ly/xhfpjn', 'dailymotion', 'https://dai.ly/xhfpjn'],
    ['https://kick.com/mxddy?clip=clip_01GYXVB5Y8PWAPWCWMSBCFB05X&ref=share', 'kick', 'https://kick.com/mxddy?clip=clip_01GYXVB5Y8PWAPWCWMSBCFB05X'],
    ['https://kick.com/mxddy/clips/clip_01GYXVB5Y8PWAPWCWMSBCFB05X', 'kick', 'https://kick.com/mxddy/clips/clip_01GYXVB5Y8PWAPWCWMSBCFB05X'],
    ['https://kick.com/xqc/videos/0d0ef7a2-1d07-4f0a-9c47-7e7e2f1f4b1e', 'kick', 'https://kick.com/xqc/videos/0d0ef7a2-1d07-4f0a-9c47-7e7e2f1f4b1e'],
    ['https://oneusefulthing.substack.com/', 'substack', 'https://oneusefulthing.substack.com'],
    ['https://19thcentury.wordpress.com/', 'wordpress', 'https://19thcentury.wordpress.com'],
  ]
  for (const [url, site, canonical] of accepted) {
    const { item, definition } = normalize(URL_CAP, { url })
    assert.deepEqual(item.input, { site, url: canonical }, url)
    assert.equal(item.routeKey, site)
    // The runner owns work_dir; Hub sends the link and the package timeout only.
    assert.deepEqual(definition.runner(item.input), { operation: 'collect', params: { target: canonical, timeout: 110 } })
  }
  rejects({ url: 'http://medium.com/p/7433944f4f04' })
  rejects({ url: 'https://medium.com:8443/p/7433944f4f04' })
  rejects({ url: 'https://user:pw@kick.com/x/clips/clip_01GYXVB5Y8' })
  rejects({ url: 'https://kick.com/xqc' }) // live channel: never accepted
  rejects({ url: 'https://medium.com/@author' }) // a profile, not an article
  rejects({ url: 'https://www.pinterest.com/someone/boards/' })
  rejects({ url: 'https://oneusefulthing.substack.com/p/a-post' })
  rejects({ url: 'https://www.oneusefulthing.org/' }) // custom domain: arbitrary host
  rejects({ url: 'https://www.wordpress.com/' })
  rejects({ url: 'https://public-api.wordpress.com/' })
  rejects({ url: 'https://10.0.0.8/pin/1' })
  rejects({ url: 'https://pinterest.com.evil.example/pin/123456' })
  rejects({ url: 'https://www.youtube.com/watch?v=x' })
  rejects({ url: 'https://www.dailymotion.com/video/xhfpjn', timeout: 5 }, 'extra field')
  rejects({ url: `https://www.dailymotion.com/video/xhfpjn?${'a'.repeat(2_100)}` })
})

test('url details: item counts follow each package result; failures count zero', () => {
  const count = capabilityDefinition(URL_CAP).itemCount
  assert.equal(count(record('https://www.pinterest.com/pin/1/', { messages: [[2, 'x'], [3, 'https://i.pinimg.com/a.jpg', {}], [3, 'b', {}]] })), 2)
  assert.equal(count(record('https://medium.com/p/7433944f4f04', { title: 't', markdown: '# t' })), 1)
  assert.equal(count(record('https://dai.ly/xhfpjn', { id: 'xhfpjn', title: 't' })), 1)
  assert.equal(count(record('https://oneusefulthing.substack.com', { posts: [{ id: 1 }, { id: 2 }] })), 2)
  assert.equal(count(record('https://19thcentury.wordpress.com', { articles: [{}, {}] })), 2)
  assert.equal(count(record('https://dai.ly/xhfpjn', null, 'failed')), 0)
})

test('url details and subdomains are public candidates, never auto-granted', () => {
  const urlCap = COLLECT_CAPABILITIES.find(row => row.key === URL_CAP)
  assert.deepEqual(urlCap.routes.map(route => [route.key, route.slotRef]), Object.entries(COLLECT_URL_SITE_SLOTS))
  for (const route of urlCap.routes) assert.equal(collectEgressProvider({ kind: 'runner', slotRef: route.slotRef }), 'overseas')
  for (const key of [URL_CAP, SUB_CAP]) {
    assert.equal(COLLECT_CAPABILITIES.find(row => row.key === key).stage, 'candidate')
    assert.equal(businessApiScopes().capabilities.includes(key), false)
  }
})

async function fixture({ egressFor = async () => 'http://127.0.0.1:7788', start = () => ({ status: 202, body: { data: { state: 'accepted' } } }) } = {}) {
  const ledger = new MemoryStore()
  const hub = new HubService({ store: ledger, adapter: {}, apiKeyPepper: PEPPER })
  const tenant = await hub.createTenant({ name: 'Delta' })
  const consumer = await hub.createConsumer({ tenantId: tenant.id, name: 'LCY-delta' })
  await ledger.setPlatformGrant(consumer.id, 'web_content', true)
  await hub.putCapabilityConfiguration(URL_CAP, { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await hub.createApiKey({ consumerId: consumer.id, name: 'delta', platforms: ['web_content'], capabilities: [URL_CAP] })
  const context = await hub.authenticate(key.secret)
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ path: new URL(url).pathname, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null })
    return Response.json(start().body, { status: start().status })
  }
  const jobs = new MemoryCollectStore()
  const contracts = createCollectContracts()
  const credentialsFor = async () => 'runner-token-0123456789abcdef'
  const executor = new CollectExecutor({ jobs, ledger, contracts, credentialsFor, logger: { error() {}, warn() {} }, pollMs: 60_000,
    policyFor: (ctx, platform) => hub.usagePolicy(ctx, platform), fetchImpl, deps: { egressFor } })
  executor.stopped = false
  const service = new CollectService({ jobs, ledger, contracts, executor, credentialsFor, fetchImpl,
    egressStores: { overseas: { describe: async () => ({ mode: 'proxy-sequence', sequenceKey: 'tikhub-internal-7788', revision: 1, sequences: [], recentProbeFailures: [] }) } } })
  for (const [site, slotRef] of Object.entries(COLLECT_URL_SITE_SLOTS)) {
    await service.adminCreateEngine({ kind: 'runner', id: `runner.${slotRef}`, displayName: site, slotRef, baseUrl: 'http://127.0.0.1:18190', enabled: true,
      routes: [{ capability: URL_CAP, routeKey: site }], reason: '测试引擎' }, 'tester')
  }
  return { context, jobs, executor, service, calls }
}

test('url details: the link picks the engine; every call carries the overseas proxy', async () => {
  const selected = []
  const fx = await fixture({ egressFor: async provider => { selected.push(provider); return 'http://127.0.0.1:7788' } })
  await assert.rejects(fx.service.adminCreateEngine({ kind: 'runner', id: 'runner.wrong', displayName: 'x', slotRef: 'kick-104', baseUrl: 'http://127.0.0.1:18190',
    routes: [{ capability: URL_CAP, routeKey: 'medium' }], reason: '错配' }, 't'), { code: 'invalid_engine_config' })
  await fx.service.submitJob(fx.context, { capability: URL_CAP, input: { url: 'https://dai.ly/xhfpjn' } }, 'web-dailymotion-1')
  await fx.service.submitJob(fx.context, { capability: URL_CAP, input: { url: 'https://medium.com/p/7433944f4f04' } }, 'web-medium-001')
  await fx.executor.drain()
  const posts = fx.calls.filter(call => call.method === 'POST')
  assert.deepEqual(posts.map(call => call.body.slotId).sort(), ['dailymotion-101', 'medium-96'])
  assert.ok(posts.every(call => call.body.proxyUrl === 'http://127.0.0.1:7788'))
  assert.deepEqual(selected, ['overseas', 'overseas'])
  assert.equal((await fx.service.adminEngine('runner.medium-96')).egress.provider, 'overseas')
})

// Scripted Cert Spotter and crt.sh answers.
function ctFetch({ certspotter = 'ok', crtsh = 'ok' } = {}) {
  const calls = []
  const fetchImpl = async url => {
    const target = new URL(url)
    calls.push(target.hostname)
    if (target.hostname === 'api.certspotter.com') {
      if (certspotter === 'down') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
      if (certspotter === '429') return new Response('{}', { status: 429, headers: { 'retry-after': '30' } })
      if (target.searchParams.get('after')) return Response.json([])
      return Response.json([
        { id: '11', dns_names: ['example.com', '*.example.com', 'api.example.com'], not_before: '2025-01-01T00:00:00Z', not_after: '2025-04-01T00:00:00Z' },
        { id: '12', dns_names: ['API.example.com.', 'mail.example.com', 'other.org', 'notexample.com'], not_before: '2024-06-01T00:00:00Z', not_after: '2026-06-01T00:00:00Z' },
      ])
    }
    if (crtsh === 'timeout') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    return Response.json([
      { id: 1, common_name: 'old.example.com', name_value: 'old.example.com\nwww.example.com', not_before: '2019-01-01T00:00:00', not_after: '2019-04-01T00:00:00' },
      { id: 2, common_name: 'evil.com', name_value: 'evil.com\nexample.com.evil.com', not_before: '2020-01-01T00:00:00', not_after: '2020-02-01T00:00:00' },
    ])
  }
  return { calls, fetchImpl }
}

test('subdomains: both CT sources merge into names under the domain only', async () => {
  const { item } = normalize(SUB_CAP, { domain: 'Example.COM' })
  assert.deepEqual(item.input, { domain: 'example.com', sources: ['certspotter', 'crtsh'], maxIssuances: 500 })
  const { fetchImpl, calls } = ctFetch()
  const outcome = await subdomains({ input: item.input, fetchImpl })
  assert.equal(outcome.status, 'succeeded')
  assert.equal(outcome.dataStatus, 'success')
  const names = Object.fromEntries(outcome.result.subdomains.map(entry => [entry.name, entry]))
  assert.deepEqual(Object.keys(names), ['api.example.com', 'example.com', 'mail.example.com', 'old.example.com', 'www.example.com'])
  assert.equal(names['example.com'].wildcard, true)
  assert.deepEqual(names['api.example.com'].sources, ['certspotter'])
  assert.equal(names['api.example.com'].certificates, 2)
  assert.equal(names['api.example.com'].firstSeen, '2024-06-01T00:00:00Z')
  assert.equal(names['api.example.com'].lastSeen, '2026-06-01T00:00:00Z')
  assert.deepEqual(names['old.example.com'], { name: 'old.example.com', wildcard: false, sources: ['crtsh'], certificates: 1, firstSeen: '2019-01-01T00:00:00Z', lastSeen: '2019-04-01T00:00:00Z' })
  assert.equal(outcome.itemCount, 5)
  assert.deepEqual(new Set(calls), new Set(['api.certspotter.com', 'crt.sh']), 'only CT services are contacted, never the domain')
})

test('subdomains: one failed source is partial, both failed is a failure, inputs are bounded', async () => {
  const partial = await subdomains({ input: { domain: 'example.com', sources: ['certspotter', 'crtsh'], maxIssuances: 100 }, fetchImpl: ctFetch({ crtsh: 'timeout' }).fetchImpl })
  assert.equal(partial.dataStatus, 'partial')
  assert.deepEqual(partial.result.sources.map(source => [source.source, source.status, source.error ?? null]), [['certspotter', 'ok', null], ['crtsh', 'failed', 'crtsh_timeout']])
  const both = await subdomains({ input: { domain: 'example.com', sources: ['certspotter', 'crtsh'], maxIssuances: 100 }, fetchImpl: ctFetch({ certspotter: '429', crtsh: 'timeout' }).fetchImpl })
  assert.equal(both.status, 'failed')
  assert.equal(both.error.code, 'subdomain_sources_failed')
  assert.ok(both.cooldownUntil > Date.now(), 'a Cert Spotter limit paces the engine')
  const only = normalize(SUB_CAP, { domain: 'example.com', sources: ['crtsh'], maxIssuances: 10 })
  assert.deepEqual(only.item.input.sources, ['crtsh'])
  for (const input of [{ domain: 'corp.internal' }, { domain: '10.0.0.1' }, { domain: 'example.com', sources: ['shodan'] }, { domain: 'example.com', maxIssuances: 5_000 }, { domain: 'example.com', depth: 3 }]) {
    assert.throws(() => normalize(SUB_CAP, input), { code: 'invalid_collect_request' }, JSON.stringify(input))
  }
  assert.equal(underDomain('*.API.Example.com.', 'example.com').name, 'api.example.com')
  assert.equal(underDomain('example.com.attacker.net', 'example.com'), null)
  assert.equal(underDomain('bad label.example.com', 'example.com'), null)
})

test('overseas binding: the selector probes a neutral endpoint through the bound proxies', async () => {
  const probes = []
  const store = { route: async () => ({ proxyUrls: ['http://127.0.0.1:7788'], directFallback: false, fingerprint: 'f', probePolicy: { timeoutMs: 1000, attempts: 1, cacheTtlMs: 0 } }) }
  const select = createProviderProxySelector(store, { providerKey: 'overseas', makeAgent: url => ({ url, close: async () => {} }),
    fetchImpl: async (url, { dispatcher }) => { probes.push(`${url} via ${dispatcher.url}`); return new Response(null, { status: 204 }) } })
  assert.equal(await select(), 'http://127.0.0.1:7788')
  assert.deepEqual(probes, ['https://www.gstatic.com/generate_204 via http://127.0.0.1:7788'])
})
