import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { NATIVE_FORWARDING_ENDPOINTS, nativeForwardingEndpoint, normalizeNativeForwardingRequest } from '../../server/contracts/native-forwarding.mjs'
import { JustOneAdapter } from '../../server/adapters/justone.mjs'
import { TikHubAdapter } from '../../server/adapters/tikhub.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { EXTERNAL_PLATFORM_OPERATION_CATALOG, MemoryExternalPlatformControlStore, PostgresExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { createApp } from '../../server/app.mjs'
import { providerMigrationSnapshot } from '../../server/data/provider-migration.mjs'
import { tenantOpenApiDocument } from '../../server/public-docs.mjs'

const PEPPER = 'native-forward-test-only-pepper-long-enough'
const JKEY = 'j.douyin_search_video_v4'
const TKEY = 't.douyin_search_fetch_video_search_v1'
const body = { params: { keyword: '自行车', page: 1, sortType: '_2' } }
const DATA = { rows: [{ id: 'one', title: '', body: '完整正文\n#话题', unknown: { nested: [false, 0, null] } }], nextCursor: 'opaque-vendor-cursor' }

test('source inventory is bounded and does not claim a legacy cutover or supplier health', () => {
  const snapshot = providerMigrationSnapshot()
  assert.equal(snapshot.summary.sourceEndpoints, 51)
  assert.equal(snapshot.summary.nativeContracts, 50)
  assert.equal(snapshot.summary.legacyCutovers, 0)
  assert.equal(snapshot.incompleteInventory, true)
  assert.equal(NATIVE_FORWARDING_ENDPOINTS.filter(r => r.provider === 'justone' && !r.schemaVersion).length, 11)
  assert.equal(NATIVE_FORWARDING_ENDPOINTS.filter(r => r.provider === 'tikhub' && !r.schemaVersion).length, 39)
  assert.ok(snapshot.rows.every(r => r.runtimeStatus === 'not_checked'))
  assert.deepEqual(snapshot.rows.find(r => r.platform === 'xianyu').catalogKeys, ['source-catalog-0073'])
  assert.ok(!NATIVE_FORWARDING_ENDPOINTS.some(r => r.path.includes('open_douyin_app')))
  const visible = tenantOpenApiDocument([{ platforms: ['social'], capabilities: [nativeForwardingEndpoint(JKEY).operation] }])
  assert.deepEqual(Object.keys(visible.paths).filter(p => p.startsWith('/data/native/')), [`/data/native/${JKEY}`])
})

test('fixed endpoints reject arbitrary destinations, credentials, nested params and alternate delivery modes', () => {
  for (const bad of [ { params: { keyword: 'x', token: 'private' } }, { params: { keyword: ['x'] } },
    { params: { keyword: 'x' }, url: 'https://example.invalid' }, { params: {}, deliveryMode: 'refresh' },
    { params: { keyword: null } } ]) assert.throws(() => normalizeNativeForwardingRequest(JKEY, bad), { status: 400 })
  assert.throws(() => normalizeNativeForwardingRequest('https://example.invalid', body), { status: 404 })
  assert.throws(() => normalizeNativeForwardingRequest('t.tiktok_web_fetch_general_search', { params: { keyword: 'x', cookie: 'secret' } }), { status: 400 })
  assert.throws(() => normalizeNativeForwardingRequest('j.social_cross_platform_search_v1_weibo', { params: { keyword: 'x' } }), { code: 'missing_parameter' })
  const request = normalizeNativeForwardingRequest('j.social_cross_platform_search_v1_wechat_mp', { params: { keyword: 'x', start: '2026-09-25 00:00:00', end: '2026-09-26 00:00:00' } })
  assert.equal(request.upstreamQuery.source, 'WEIXIN')
  const paged = nativeForwardingEndpoint('t.instagram_v3_get_user_followers')
  for (const count of [0, -1, 21, true, 'NaN']) {
    assert.throws(() => normalizeNativeForwardingRequest(paged.key, { params: { username: 'fixture', count } }, { maxPageSize: 20 }), { code: 'invalid_page_size' })
  }
  assert.equal(normalizeNativeForwardingRequest(paged.key, { params: { username: 'fixture', count: '20' } }, { maxPageSize: 20 }).upstreamQuery.count, '20')
})

test('deploying code before migration 112 preserves established provider visibility but refuses new dispatch', async () => {
  for (const provider of ['justone', 'tikhub']) {
    const definitions = EXTERNAL_PLATFORM_OPERATION_CATALOG[provider]
    const existing = definitions.filter(row => !row.operationKey.startsWith('native.'))
    const rows = existing.map(row => ({ provider_key: provider, operation_key: row.operationKey,
      control_source: 'database', desired_state: 'active', revision: '1', release_revision: '1',
      release_status: 'released', contract_version: row.contractVersion, endpoint_keys: row.endpointKeys,
      price_book_version: '1', price_book_source: 'database', price_book_status: 'reviewed', currency: 'CNY',
      pricing_as_of: '2026-09-26', monthly_budget_minor: '100000', monthly_subsidy_budget_minor: '0',
      endpoint_prices: Object.fromEntries(row.endpointKeys.map(key => [key, '12'])) }))
    const control = new PostgresExternalPlatformControlStore({ pool: { query: async (_sql, params) => ({ rows: params.length === 1 ? rows : rows.filter(row => row.operation_key === params[1]) }) } })
    const views = await control.describeProvider(provider, { credentialConfigured: true })
    assert.equal(views.filter(row => row.effectiveState === 'active').length, existing.length)
    const native = views.filter(row => row.operationKey.startsWith('native.'))
    assert.ok(native.every(row => row.migrationRequired && row.effectiveState === 'disabled' && row.revision === 0))
    await assert.rejects(control.authorizeDispatch(provider, native[0].operationKey, { credentialConfigured: true }), { status: 503 })
  }
})

test('both suppliers dispatch fixed method/path once, preserve business data and exact restricted bytes', async () => {
  for (const [key, Adapter, code, credential] of [[JKEY, JustOneAdapter, 0, { token: 'fixture-j-secret' }], [TKEY, TikHubAdapter, 200, { apiKey: 'fixture-t-secret' }]]) {
    let calls = 0
    const wire = ` {"code":${code},"message":"ok","recordTime":"2026-09-26","data":${JSON.stringify(DATA)}}\n`
    const adapter = new Adapter({ ...credential, fetchImpl: async (url, options) => {
      calls++
      const expected = nativeForwardingEndpoint(key)
      assert.equal(new URL(url).pathname, expected.path)
      assert.equal(options.method, expected.method)
      assert.equal(options.redirect, 'error')
      if (code === 200) assert.deepEqual(JSON.parse(options.body), { keyword: '自行车', cursor: 0, search_id: 'first-session' })
      else assert.equal(new URL(url).searchParams.get('sortType'), '_2')
      return new Response(wire, { headers: { 'content-type': 'application/json' } })
    } })
    const result = await adapter.forwardNative(key, code === 0 ? body : { params: { keyword: '自行车', cursor: 0, search_id: 'first-session' } })
    assert.equal(calls, 1)
    assert.deepEqual(result.publicBody.data, DATA)
    assert.equal(result.items.length, 0)
    assert.equal(result.records.length, 0)
    assert.equal(result.restrictedResponseArchive.bodyText, wire)
    assert.equal(result.restrictedResponseArchive.bodySha256, createHash('sha256').update(wire).digest('hex'))
  }
})

test('TikHub native GET preserves an opaque pagination token without a request body', async () => {
  const key = 't.instagram_v3_get_user_posts'
  const after = 'end+/cursor==&part=2'
  let calls = 0
  const adapter = new TikHubAdapter({ apiKey: 'fixture-native-secret', fetchImpl: async (url, options) => {
    calls++
    assert.equal(options.method, 'GET')
    assert.equal(options.body, undefined)
    assert.equal(new URL(url).pathname, nativeForwardingEndpoint(key).path)
    assert.equal(new URL(url).searchParams.get('after'), after)
    return Response.json({ code: 200, data: DATA })
  } })
  const result = await adapter.forwardNative(key, { params: { username: 'fixture', after, count: 20 } })
  assert.deepEqual(result.publicBody.data, DATA)
  assert.equal(calls, 1)
})

async function harness({ key = JKEY, grant = true, enabled = true, outcome = 'success' } = {}) {
  const endpoint = nativeForwardingEndpoint(key)
  const usageStore = new MemoryStore()
  const service = new HubService({ store: usageStore, adapter: {}, apiKeyPepper: PEPPER })
  const tenant = await service.createTenant({ name: 'Native fixture' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Native caller' })
  await usageStore.setPlatformGrant(consumer.id, endpoint.authorizationPlatform, true)
  await service.putCapabilityConfiguration(endpoint.operation, { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const apiKey = await service.createApiKey({ consumerId: consumer.id, name: 'Fixture', platforms: [endpoint.authorizationPlatform], capabilities: grant ? [endpoint.operation] : [] })
  const context = await service.authenticate(apiKey.secret)
  const config = { configured: true, contractVerified: true, dispatchEnabled: true, timeoutMs: 50,
    freshTtlMs: 60000, staleTtlMs: 86400000, maxConcurrency: 3, maxConsumerConcurrency: 3,
    maxRequestsPerMinute: 100, billing: {} }
  const control = new MemoryExternalPlatformControlStore()
  const priceBook = { currency: 'CNY', pricingAsOf: '2026-09-26T00:00:00.000Z', monthlyBudgetMinor: 100000,
    monthlySubsidyBudgetMinor: 100000, unitCostMinorByEndpoint: { [endpoint.endpointKey]: 12 } }
  if (enabled) await control.updatePolicy(endpoint.provider, endpoint.operation, {
    expectedRevision: 1, desiredState: 'active', reason: 'Synthetic fixture, no live calls', priceBook,
  }, { runtime: { config, credentialConfigured: true } })
  let calls = 0
  const Adapter = endpoint.provider === 'justone' ? JustOneAdapter : TikHubAdapter
  const adapter = new Adapter({ token: 'fixture-j', apiKey: 'fixture-t', timeoutMs: 50, fetchImpl: async () => {
    calls++
    if (outcome === 'unknown') throw new Error('connection closed after send')
    const code = outcome === 'rejected' ? (endpoint.provider === 'justone' ? 301 : 400) : endpoint.provider === 'justone' ? 0 : 200
    return Response.json({ code, message: 'fixture', recordTime: '2026-09-26', data: DATA })
  } })
  const platformStore = new MemoryExternalPlatformStore({ usageStore, providerKey: endpoint.provider,
    authorizationPlatform: endpoint.authorizationPlatform, uncertainCooldownMs: 900000 })
  const gateway = new ExternalPlatformGateway({ usageStore, platformStore, adapter, config, providerKey: endpoint.provider,
    apiKeyPepper: PEPPER, reservationLeaseMs: 150000, operationControlStore: control, logger: { warn() {} } })
  const query = { key, body: key === JKEY ? body : { params: { keyword: '自行车' } }, idempotencyKey: 'native-fixture-page-001', path: endpoint.hubPath }
  return { gateway, query, context, usageStore, platformStore, calls: () => calls, service, apiKey, endpoint, control, config }
}

test('native discovery follows Key grants, operation state and exact canary membership without acquisition', async () => {
  const h = await harness()
  h.service.externalNativeCapabilities = options => h.gateway.nativeReadiness(options)
  const readiness = async () => (await h.service.capabilities(h.context)).data.capabilities.find(row => row.capability === h.endpoint.operation)?.ready
  assert.equal(await readiness(), true)
  await h.control.updatePolicy('justone', h.endpoint.operation, {
    expectedRevision: 2, desiredState: 'canary', canaryConsumerIds: ['00000000-0000-4000-8000-000000000001'],
    reason: 'Synthetic canary excludes this consumer',
  }, { runtime: { config: h.config, credentialConfigured: true } })
  assert.equal(await readiness(), false)
  await h.control.updatePolicy('justone', h.endpoint.operation, {
    expectedRevision: 3, desiredState: 'canary', canaryConsumerIds: [h.context.consumer.id],
    reason: 'Synthetic canary includes this consumer',
  }, { runtime: { config: h.config, credentialConfigured: true } })
  assert.equal(await readiness(), true)
  h.gateway.credentialStore = { resolveCredential() { throw new Error('metadata must not decrypt credentials') } }
  assert.equal((await h.gateway.nativeReadiness({ consumerId: h.context.consumer.id, operationKeys: [h.endpoint.operation], credentialConfigured: true }))[h.endpoint.operation], true)
  const denied = await harness({ grant: false })
  denied.service.externalNativeCapabilities = () => { throw new Error('ungranted operation should not request readiness') }
  assert.ok(!(await denied.service.capabilities(denied.context)).data.capabilities.some(row => row.capability === denied.endpoint.operation))
  assert.equal(h.calls(), 0)
})

test('native forwarding enforces Key snapshots and disabled controls before dispatch', async () => {
  for (const options of [{ grant: false }, { enabled: false }]) {
    const h = await harness(options)
    await assert.rejects(h.gateway.forwardNative(h.context, h.query), error => [403, 503].includes(error.status))
    assert.equal(h.calls(), 0)
  }
  const h = await harness()
  await assert.rejects(h.gateway.forwardNative(h.context, { ...h.query, idempotencyKey: null }), { code: 'idempotency_key_required' })
  assert.equal(h.calls(), 0)
})

test('committed native replay is byte-equivalent and does not repeat acquisition or canonical ingestion', async () => {
  for (const key of [JKEY, TKEY]) {
    const h = await harness({ key })
    const first = await h.gateway.forwardNative(h.context, h.query)
    const replay = await h.gateway.forwardNative(h.context, h.query)
    assert.equal(first.status, 200)
    assert.equal(replay.replay, true)
    assert.deepEqual(replay.body, first.body)
    assert.deepEqual(first.body.data, DATA)
    assert.equal(h.calls(), 1)
    const call = [...h.platformStore.calls.values()][0]
    assert.equal(call.operation, h.endpoint.operation)
    assert.equal(call.endpointKey, h.endpoint.endpointKey)
    assert.equal(call.costMinor, 12)
    await assert.rejects(h.gateway.forwardNative(h.context, { ...h.query, body: { params: { keyword: 'changed' } } }), { code: 'idempotency_conflict' })
  }
})

test('unknown and definitive failure keep the same request from redispatching, for both suppliers', async () => {
  for (const key of [JKEY, TKEY]) for (const outcome of ['unknown', 'rejected']) {
    const h = await harness({ key, outcome })
    await assert.rejects(h.gateway.forwardNative(h.context, h.query))
    await assert.rejects(h.gateway.forwardNative(h.context, h.query))
    assert.equal(h.calls(), 1)
    assert.equal(h.platformStore.calls.size, 1)
    if (outcome === 'unknown') assert.equal([...h.platformStore.calls.values()][0].billed, null)
  }
})

test('public native route uses the governed gateway while unknown paths cannot become a proxy', async t => {
  const h = await harness()
  const server = createServer(createApp({ store: h.usageStore, service: h.service, adapter: {},
    socialAccountGateway: h.gateway, listenerMode: 'public', logger: { error() {} } }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}${h.endpoint.hubPath}`
  const request = { method: 'POST', headers: { authorization: `Bearer ${h.apiKey.secret}`, 'content-type': 'application/json', 'idempotency-key': h.query.idempotencyKey }, body: JSON.stringify(body) }
  assert.equal((await fetch(url, { ...request, headers: {} })).status, 401)
  assert.equal((await fetch(url + '?url=https://example.invalid', request)).status, 400)
  const response = await fetch(url, request)
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).data, DATA)
  assert.equal((await fetch(url.replace(JKEY, 'j.unknown'), request)).status, 404)
  assert.equal(h.calls(), 1)
})
