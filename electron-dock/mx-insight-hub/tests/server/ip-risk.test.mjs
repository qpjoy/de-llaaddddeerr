import test from 'node:test'
import assert from 'node:assert/strict'
import { IpSearchAdapter } from '../../server/adapters/ipsearch.mjs'
import { IpRiskGateway } from '../../server/external-platforms/ip-risk-gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { normalizeIpRiskRequest, normalizeIpRiskResponse } from '../../server/contracts/ip-risk.mjs'
import { tenantOpenApiDocument, publicDocsHtmlForPath } from '../../server/public-docs.mjs'
import { createServer } from 'node:http'
import { createRuntime } from '../../server/index.mjs'
import { loadConfig } from '../../server/config.mjs'

const payload = { code: 200, data: { risk: { proxy: '否', risk_score: 0, risk_level: '', mb_rate: '0%', real: '70%', risk_tag: [] } } }
async function fixture(fetchImpl, grant = true) {
  const store = new MemoryStore()
  const hub = new HubService({ store, adapter: {}, apiKeyPepper: 'ip-risk-test-pepper-at-least-32-characters' })
  const tenant = await hub.createTenant({ name: 'IP tenant' })
  const consumer = await hub.createConsumer({ tenantId: tenant.id, name: 'IP consumer' })
  if (grant) {
    await store.setPlatformGrant(consumer.id, 'ip_risk', true)
    await hub.putCapabilityConfiguration('ip.risk.query', { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  }
  const key = await hub.createApiKey({ consumerId: consumer.id, name: 'IP key', platforms: grant ? ['ip_risk'] : [], capabilities: grant ? ['ip.risk.query'] : [] })
  const context = await hub.authenticate(key.secret)
  const platformStore = new MemoryExternalPlatformStore({ usageStore: store, providerKey: 'ipsearch', authorizationPlatform: 'ip_risk' })
  const adapter = new IpSearchAdapter({ apiKey: 'secret-not-public', fetchImpl })
  return { store, platformStore, context, gateway: new IpRiskGateway({ usageStore: store, platformStore, adapter, enabled: true }) }
}
const request = { body: { ip: '1.1.1.1' }, idempotencyKey: 'ip-test-0001', path: '/api/v1/data/ip/risk' }

test('IPv4 contract is strict and preserves zero, unknowns and percentages', () => {
  for (const body of [{ ip: 'localhost' }, { ip: '::1' }, { ip: '1.1.1.1', key: 'x' }]) assert.throws(() => normalizeIpRiskRequest(body))
  const result = normalizeIpRiskResponse(payload)
  assert.equal(result.status, 'success'); assert.equal(result.data.risk_score, 0); assert.equal(result.data.human_probability_percent, 70)
  assert.equal(result.data.risk_level, null)
})
test('only granted keys dispatch; successful calls archive exact evidence and replay without dispatch or billing', async () => {
  let calls = 0
  const fetchImpl = async (url, options) => { calls++; assert.equal(options.redirect, 'error'); assert.equal(new URLSearchParams(options.body).get('key'), 'secret-not-public'); return new Response(JSON.stringify(payload)) }
  const denied = await fixture(fetchImpl, false)
  await assert.rejects(denied.gateway.query(denied.context, request), { status: 403 }); assert.equal(calls, 0)
  const f = await fixture(fetchImpl)
  const result = await f.gateway.query(f.context, request)
  assert.equal(result.status, 200); assert.equal(calls, 1)
  assert.equal(f.platformStore.restrictedResponseArchives.size, 1)
  assert.equal(result.body.meta.chargeStatus, 'not_charged')
  assert.ok(!JSON.stringify(result.body).match(/ipsearch|ipdatacloud|secret-not-public/u))
  const replay = await f.gateway.query(f.context, request)
  assert.equal(replay.replay, true); assert.equal(calls, 1)
  assert.equal(replay.body.meta.sourceMode, 'idempotent_replay')
  await assert.rejects(f.gateway.query(f.context, { ...request, body: { ip: '8.8.8.8' } }), { status: 409 })
  assert.equal(calls, 1)
})
test('ambiguous transport never retries, including a new equal request identity', async () => {
  let calls = 0
  const f = await fixture(async () => { calls++; throw new Error('secret-not-public') })
  const result = await f.gateway.query(f.context, request)
  assert.equal(result.status, 502)
  await assert.rejects(f.gateway.query(f.context, request), { status: 409 })
  await assert.rejects(f.gateway.query(f.context, { ...request, idempotencyKey: 'ip-test-0002' }), { status: 409 })
  assert.equal(calls, 1)
})
test('disabled provider leaves Hub identity available and dispatches nothing', async () => {
  const f = await fixture(async () => { throw new Error('must not dispatch') })
  f.gateway.enabled = false
  await assert.rejects(f.gateway.query(f.context, request), { status: 503 })
  assert.equal(f.platformStore.calls.size, 0)
})

test('schema drift retains raw evidence; failed persistence cannot trigger another dispatch', async () => {
  const drift = await fixture(async () => new Response('{"code":200,"data":{"other_product":1}}'))
  assert.equal((await drift.gateway.query(drift.context, request)).status, 502)
  assert.equal(drift.platformStore.restrictedResponseArchives.size, 1)
  assert.equal([...drift.platformStore.calls.values()][0].outcome, 'succeeded_unusable')
  let calls = 0
  const f = await fixture(async () => { calls++; return new Response(JSON.stringify(payload)) })
  f.platformStore.commitLiveDelivery = async () => { throw new Error('database failed') }
  await assert.rejects(f.gateway.query(f.context, request), { code: 'ip_query_outcome_unknown' })
  assert.equal([...f.platformStore.calls.values()][0].outcome, 'unknown')
  assert.equal(f.platformStore.restrictedResponseArchives.size, 1)
  await assert.rejects(f.gateway.query(f.context, request), { status: 409 })
  assert.equal(calls, 1)
})

test('concurrent duplicate dispatch is suppressed and HTTP attempts include permission refusals', async () => {
  let release, entered
  const ready = new Promise(resolve => { entered = resolve })
  const response = new Promise(resolve => { release = resolve })
  let calls = 0
  const f = await fixture(async () => { calls++; entered(); return response })
  const first = f.gateway.query(f.context, request)
  await ready
  await assert.rejects(f.gateway.query(f.context, request), { status: 409 })
  release(new Response(JSON.stringify(payload)))
  await first
  await f.store.setPlatformGrant(f.context.consumer.id, 'ip_risk', false)
  await assert.rejects(f.gateway.query(f.context, request), { status: 403 })
  assert.equal(calls, 1)
  const events = await f.gateway.events.summary(new Date(0))
  assert.equal(events.authenticatedHttpRequests, 3)
  assert.ok(events.byStatus.some(row => row.status === 403 && row.count === 1))
})

test('tenant documentation requires both scopes in the same consumer and never discloses provider', () => {
  const denied = tenantOpenApiDocument([{ platforms: ['ip_risk'], capabilities: [] }, { platforms: [], capabilities: ['ip.risk.query'] }])
  assert.equal(denied.paths['/data/ip/risk'], undefined)
  const scopes = [{ platforms: ['ip_risk'], capabilities: ['ip.risk.query'] }]
  assert.ok(tenantOpenApiDocument(scopes).paths['/data/ip/risk'])
  const html = publicDocsHtmlForPath('/docs/ip-risk', { tenant: true, scopes })
  assert.match(html, /\/api\/v1\/data\/ip\/risk/u)
  assert.doesNotMatch(html, /ipsearch|ipdatacloud/u)
})

test('real Hub HTTP route authenticates, serves a neutral contract and isolates the optional provider', async () => {
  const runtime = await createRuntime(loadConfig({ MX_INSIGHT_STORE: 'memory', MX_INSIGHT_LISTENER_MODE: 'public',
    MX_INSIGHT_API_KEY_PEPPER: 'ip-risk-http-test-pepper-at-least-32-characters', MX_INSIGHT_IPSEARCH_ENABLED: '1', MX_INSIGHT_IPSEARCH_API_KEY: 'test-only-provider-key' }))
  const server = createServer(runtime.app)
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const origin = `http://127.0.0.1:${server.address().port}`
    let calls = 0
    runtime.ipRiskGateway.adapter.fetch = async () => { calls++; return new Response(JSON.stringify(payload)) }
    const tenant = await runtime.service.createTenant({ name: 'HTTP test' })
    const consumer = await runtime.service.createConsumer({ tenantId: tenant.id, name: 'HTTP consumer' })
    await runtime.store.setPlatformGrant(consumer.id, 'ip_risk', true)
    await runtime.service.putCapabilityConfiguration('ip.risk.query', { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
    const key = await runtime.service.createApiKey({ consumerId: consumer.id, name: 'HTTP key', platforms: ['ip_risk'], capabilities: ['ip.risk.query'] })
    const options = { method: 'POST', headers: { authorization: `Bearer ${key.secret}`, 'content-type': 'application/json', 'idempotency-key': 'ip-http-test-001' }, body: JSON.stringify(request.body) }
    const result = await fetch(origin + request.path, options)
    assert.equal(result.status, 200)
    assert.equal((await result.json()).data.ip, '1.1.1.1')
    const replay = await fetch(origin + request.path, options)
    assert.equal(replay.headers.get('idempotent-replay'), 'true'); await replay.text()
    assert.equal(calls, 1)
    await runtime.store.setPlatformGrant(consumer.id, 'ip_risk', false)
    const refused = await fetch(origin + request.path, options)
    assert.equal(refused.status, 403); await refused.text()
    assert.equal(calls, 1)
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve))
    runtime.agent.close(); await runtime.store.close()
  }
})

test('batch preserves order and duplicates, meters each item and replays without dispatch', async () => {
  let calls = 0
  const f = await fixture(async () => { calls++; return new Response(JSON.stringify(payload)) })
  const input = { body: { ips: ['1.1.1.1', '8.8.8.8', '1.1.1.1'] }, idempotencyKey: 'batch-tests-001', path: '/api/v1/data/ip/risk/batch' }
  const result = await f.gateway.batch.query(f.context, input)
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.data.map(item => item.ip), input.body.ips)
  assert.deepEqual(result.body.data.map(item => item.status), [200, 200, 200])
  assert.equal(calls, 3)
  assert.equal(f.platformStore.restrictedResponseArchives.size, 3)
  const replay = await f.gateway.batch.query(f.context, input)
  assert.equal(replay.replay, true); assert.equal(calls, 3)
  assert.equal((await f.gateway.events.summary(new Date(0))).authenticatedHttpRequests, 2)
  await assert.rejects(f.gateway.batch.query(f.context, { ...input, body: { ips: ['1.1.1.1'] } }), { status: 409 })
  await assert.rejects(f.gateway.batch.query(f.context, { ...input, body: { ips: ['1.1.1.1', '::1'] } }), { status: 400 })
  await f.store.setPlatformGrant(f.context.consumer.id, 'ip_risk', false)
  await assert.rejects(f.gateway.batch.query(f.context, input), { status: 403 })
  assert.equal(calls, 3)
})

test('batch uncertain duplicates do not redispatch and completed failures remain replayable', async () => {
  let calls = 0
  const f = await fixture(async () => { calls++; throw new Error('transport ambiguity') })
  const input = { body: { ips: ['1.1.1.1', '1.1.1.1'] }, idempotencyKey: 'batch-unknown-001', path: '/api/v1/data/ip/risk/batch' }
  const result = await f.gateway.batch.query(f.context, input)
  assert.deepEqual(result.body.data.map(item => item.status), [502, 409])
  assert.equal(calls, 1)
  assert.equal((await f.gateway.batch.query(f.context, input)).replay, true)
  assert.equal(calls, 1)
})

test('saved credential enables only the IP product and rotation is read on every dispatch', async () => {
  const { MemoryExternalPlatformCredentialStore } = await import('../../server/external-platforms/credentials-store.mjs')
  const { IpSearchAdminService } = await import('../../server/external-platforms/ipsearch-admin.mjs')
  const seen = []
  const f = await fixture(async (_url, options) => { seen.push(new URLSearchParams(options.body).get('key')); return new Response(JSON.stringify(payload)) })
  f.gateway.enabled = false
  f.gateway.credentialStore = new MemoryExternalPlatformCredentialStore({ providerKey: 'ipsearch' })
  assert.equal((await f.gateway.capabilities()).ready, false)
  const admin = new IpSearchAdminService(f.platformStore, f.gateway)
  await admin.updateCredential('ipsearch', { apiKey: 'key-one', expectedRevision: 0 })
  assert.equal((await f.gateway.capabilities()).ready, true)
  await f.gateway.query(f.context, request)
  await admin.updateCredential('ipsearch', { apiKey: 'key-two', expectedRevision: 1 })
  await f.gateway.query(f.context, { ...request, idempotencyKey: 'rotation-test-002' })
  assert.deepEqual(seen, ['key-one', 'key-two'])
  assert.deepEqual(await admin.revealCredential('ipsearch'), { apiKey: 'key-two' })
  assert.ok(!JSON.stringify(await admin.detail('ipsearch')).includes('key-two'))
  await assert.rejects(admin.updateCredential('ipsearch', { apiKey: 'key-three', expectedRevision: 1 }), { status: 409 })
})

test('console credential save/reveal requires Admin Token; saved key powers single and batch HTTP routes', async () => {
  const adminToken = 'ip-test-admin-token-at-least-32-characters'
  const runtime = await createRuntime(loadConfig({ MX_INSIGHT_STORE: 'memory', MX_INSIGHT_LISTENER_MODE: 'combined', MX_INSIGHT_ADMIN_TOKEN: adminToken,
    MX_INSIGHT_API_KEY_PEPPER: 'ip-test-admin-pepper-at-least-32-characters' }))
  const server = createServer(runtime.app)
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const origin = `http://127.0.0.1:${server.address().port}`
    const credentialPath = origin + '/internal/v1/admin/external-platforms/ipsearch/credential'
    const adminHeaders = { 'x-mx-insight-admin-token': adminToken, 'content-type': 'application/json' }
    const denied = await fetch(credentialPath, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: 'test-key', expectedRevision: 0 }) })
    assert.equal(denied.status, 401); await denied.text()
    const saved = await fetch(credentialPath, { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ apiKey: 'test-key', expectedRevision: 0 }) })
    assert.equal(saved.status, 200)
    assert.equal((await saved.json()).data.source, 'database')
    const refused = await fetch(credentialPath + '/reveal', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ adminToken: 'incorrect' }) })
    assert.equal(refused.status, 403); await refused.text()
    const reveal = await fetch(credentialPath + '/reveal', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ adminToken }) })
    assert.equal(reveal.status, 200); assert.match(reveal.headers.get('cache-control'), /no-store/u)
    assert.equal((await reveal.json()).data.apiKey, 'test-key')
    let calls = 0
    runtime.ipRiskGateway.adapter.fetch = async (_url, options) => { calls++; assert.equal(new URLSearchParams(options.body).get('key'), 'test-key'); return new Response(JSON.stringify(payload)) }
    const tenant = await runtime.service.createTenant({ name: 'Saved-key tenant' })
    const consumer = await runtime.service.createConsumer({ tenantId: tenant.id, name: 'Saved-key consumer' })
    await runtime.store.setPlatformGrant(consumer.id, 'ip_risk', true)
    await runtime.service.putCapabilityConfiguration('ip.risk.query', { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
    const key = await runtime.service.createApiKey({ consumerId: consumer.id, name: 'Saved-key test', platforms: ['ip_risk'], capabilities: ['ip.risk.query'] })
    const headers = { authorization: `Bearer ${key.secret}`, 'content-type': 'application/json', 'idempotency-key': 'saved-key-batch-01' }
    const result = await fetch(origin + '/api/v1/data/ip/risk/batch', { method: 'POST', headers, body: JSON.stringify({ ips: ['1.1.1.1', '8.8.8.8'] }) })
    assert.equal(result.status, 200)
    const response = await result.json()
    assert.equal(response.meta.succeededItems, 2); assert.equal(calls, 2)
    assert.ok(!JSON.stringify(response).match(/ipsearch|ipdatacloud|test-key/u))
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve))
    runtime.agent.close(); await runtime.store.close()
  }
})
