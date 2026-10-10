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
import { normalizeWechatSearchAlias, WECHAT_SEARCH_PATH } from '../../server/contracts/wechat-search-alias.mjs'
import { NightAllAdapter } from '../../server/adapters/night-all.mjs'
import { aggregateSourceCatalog } from '../../server/data/aggregate-search.mjs'
import { buildNightAllLegacySearchCapabilities } from '../../server/contracts/night-all-legacy.mjs'
import { wechatAggregatePage } from '../../server/data/wechat-search.mjs'

const PEPPER = 'native-forward-test-only-pepper-long-enough'
const JKEY = 'j.douyin_search_video_v4'
const TKEY = 't.douyin_search_fetch_video_search_v1'
const body = { params: { keyword: '自行车', page: 1, sortType: '_2' } }
const DATA = { rows: [{ id: 'one', title: '', body: '完整正文\n#话题', unknown: { nested: [false, 0, null] } }], nextCursor: 'opaque-vendor-cursor' }

test('source inventory records the Facebook search cutover without inventing supplier health', () => {
  const snapshot = providerMigrationSnapshot()
  assert.equal(snapshot.summary.sourceEndpoints, 51)
  assert.equal(snapshot.summary.nativeContracts, 50)
  assert.equal(snapshot.summary.legacyCutovers, 2)
  assert.ok(snapshot.rows.filter(row => row.legacyStatus === 'hub_search_cutover').every(row => row.platform === 'facebook'))
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

async function harness({ key = JKEY, grant = true, enabled = true, outcome = 'success', data = DATA } = {}) {
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
    monthlySubsidyBudgetMinor: 100000, unitCostMinorByEndpoint: { [endpoint.endpointKey]: endpoint.allowZeroCost ? 0 : 12 } }
  if (enabled) await control.updatePolicy(endpoint.provider, endpoint.operation, {
    expectedRevision: 1, desiredState: 'active', reason: 'Synthetic fixture, no live calls', priceBook,
  }, { runtime: { config, credentialConfigured: true } })
  let calls = 0
  const dispatched = []
  const Adapter = endpoint.provider === 'justone' ? JustOneAdapter : TikHubAdapter
  const adapter = new Adapter({ token: 'fixture-j', apiKey: 'fixture-t', timeoutMs: 50, fetchImpl: async (_url, options) => {
    calls++
    dispatched.push(options.body ? JSON.parse(options.body) : null)
    if (outcome === 'unknown') throw new Error('connection closed after send')
    const code = outcome === 'rejected' ? (endpoint.provider === 'justone' ? 301 : 400) : endpoint.provider === 'justone' ? 0 : 200
    return Response.json({ code, message: 'fixture', recordTime: '2026-09-26', data: typeof data === 'function' ? data(dispatched.at(-1), calls) : data })
  } })
  const platformStore = new MemoryExternalPlatformStore({ usageStore, providerKey: endpoint.provider,
    authorizationPlatform: endpoint.authorizationPlatform, uncertainCooldownMs: 900000 })
  const gateway = new ExternalPlatformGateway({ usageStore, platformStore, adapter, config, providerKey: endpoint.provider,
    apiKeyPepper: PEPPER, reservationLeaseMs: 150000, operationControlStore: control, logger: { warn() {} } })
  const query = { key, body: key === JKEY ? body : { params: key === 'wechat.demo.article-sample' ? {} : { keyword: '自行车' } }, idempotencyKey: 'native-fixture-page-001', path: endpoint.hubPath }
  return { gateway, query, context, usageStore, platformStore, calls: () => calls, dispatched, service, apiKey, endpoint, control, config }
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

test('WeChat covers every reviewed official path with fixed neutral routes, precise IDs and one dispatch', async () => {
  const { default: snapshot } = await import('../../server/data/wechat-contracts.json', { with: { type: 'json' } })
  const { WECHAT_SERVICES } = await import('../../shared/wechat.mjs')
  assert.equal(snapshot.endpoints.length, 26)
  assert.equal(WECHAT_SERVICES.length, 26)
  assert.doesNotMatch(JSON.stringify(WECHAT_SERVICES), /tikhub|justone|procurement|sourceUrl/i)
  for (const endpoint of snapshot.endpoints) {
    const params = Object.fromEntries(endpoint.parameters.filter(p => p.required).map(p => [p.name,
      p.name === 'username' ? endpoint.platform === 'wechat_channels' ? 'v2_1234567890@finder' : 'gh_example'
        : p.name === 'url' ? 'https://mp.weixin.qq.com/s/example'
          : p.name === 'keyword' ? '城市观察'
            : p.name === 'channel_id' ? 'sphExample' : '14941130915890399732']))
    if (endpoint.key === 'wechat.channels.video-detail') params.object_id = '14941130915890399732'
    const normalized = normalizeNativeForwardingRequest(endpoint.key, { params })
    let calls = 0
    const wire = '{"code":200,"docs":"https://docs.tikhub.io/private","support":"TikHub","data":{"docID":14941130915890399732,"text":"完整正文","count":2,"next_offset":"A+/=="}}'
    const adapter = new TikHubAdapter({ apiKey: 'fixture-wechat-secret', fetchImpl: async (url, options) => {
      calls++
      assert.equal(new URL(url).pathname, endpoint.path)
      assert.equal(options.method, endpoint.method)
      assert.equal(options.redirect, 'error')
      if (endpoint.method === 'POST') assert.deepEqual(JSON.parse(options.body), normalized.upstreamQuery)
      else assert.equal(options.body, undefined)
      return new Response(wire, { headers: { 'content-type': 'application/json' } })
    } })
    const result = await adapter.forwardNative(endpoint.key, { params })
    assert.equal(calls, 1)
    assert.equal(result.publicBody.data.docID, '14941130915890399732')
    assert.equal(result.publicBody.data.count, 2)
    assert.ok(result.archiveObjects.every(row => row.marketplace === endpoint.platform && row.archivePath.includes(`/tikhub/${endpoint.platform}/`)))
    assert.equal(result.publicBody.data.next_offset, 'A+/==')
    assert.doesNotMatch(JSON.stringify(result.publicBody), /TikHub|fixture-wechat-secret|docs\.tikhub/i)
    assert.equal(result.restrictedResponseArchive.bodyText, wire)
    assert.equal(result.restrictedResponseArchive.bodySha256, createHash('sha256').update(wire).digest('hex'))
  }
})

test('WeChat validates nullable scalars, enums, page limits and URL/identifier contracts before dispatch', () => {
  const key = 'wechat.search.search'
  for (const params of [{keyword:'x',sort:'unsupported'}, {keyword:'x',cursor:{}}, {keyword:'x',token:'x'}, {keyword:'x',offset:-1}]) {
    assert.throws(() => normalizeNativeForwardingRequest(key,{params}), {status:400})
  }
  const request = normalizeNativeForwardingRequest(key,{params:{keyword:'x',sort:1,publish_time:'week',cursor:null,raw:false}})
  assert.equal(request.upstreamQuery.sort,1)
  assert.equal(request.upstreamQuery.cursor,null)
  assert.equal(request.upstreamQuery.raw,false)
  assert.throws(()=>normalizeNativeForwardingRequest('wechat.channels.video-detail',{params:{}}),{code:'missing_parameter'})
  assert.throws(()=>normalizeNativeForwardingRequest('wechat.mp.article-detail-h5',{params:{url:'https://evil.invalid/path'}}),{status:400})
  assert.throws(()=>normalizeNativeForwardingRequest('wechat.mp.account-articles',{params:{username:'gh_example',page_size:50}},{maxPageSize:20}),{status:400})
  assert.throws(()=>normalizeNativeForwardingRequest('wechat.demo.article-sample',{params:{url:'https://mp.weixin.qq.com/s/other'}}),{status:400})
})

test('WeChat gateway preserves authorization, disabled rollout, exact replay and neutral failures', async () => {
  const key='wechat.search.search'
  const denied=await harness({key,grant:false})
  await assert.rejects(denied.gateway.forwardNative(denied.context,denied.query),{status:403});assert.equal(denied.calls(),0)
  const disabled=await harness({key,enabled:false})
  await assert.rejects(disabled.gateway.forwardNative(disabled.context,disabled.query),{status:503});assert.equal(disabled.calls(),0)
  const h=await harness({key})
  const first=await h.gateway.forwardNative(h.context,h.query)
  const again=await h.gateway.forwardNative(h.context,h.query)
  assert.equal(first.status,200);assert.equal(again.replay,true);assert.equal(h.calls(),1)
  assert.deepEqual(first.body,again.body)
  assert.doesNotMatch(JSON.stringify(first.body.meta),/upstream|provider|TikHub/i)
  for(const outcome of ['unknown','rejected']) {
    const failed=await harness({key,outcome})
    await assert.rejects(failed.gateway.forwardNative(failed.context,failed.query), error => {
      assert.ok(error.status>=400);assert.doesNotMatch(error.message+JSON.stringify(error.details),/tikhub|fixture-t/i);return true
    })
    assert.equal(failed.calls(),1)
  }
})

test('free WeChat sample records zero procurement cost without a billed supplier call', async () => {
  for (const outcome of ['success', 'unknown', 'rejected']) {
    const h=await harness({key:'wechat.demo.article-sample',outcome})
    if (outcome==='success') await h.gateway.forwardNative(h.context,h.query)
    else await assert.rejects(h.gateway.forwardNative(h.context,h.query))
    assert.equal(h.calls(),1)
    const call=[...h.platformStore.calls.values()][0]
    assert.equal(call.billed,false)
    assert.equal(call.costMinor,0)
  }
})

test('WeChat demo requires exact Key authorization and sufficient Hub credit despite zero procurement cost', async () => {
  const denied=await harness({key:'wechat.demo.article-sample',grant:false})
  await assert.rejects(denied.gateway.forwardNative(denied.context,denied.query),{status:403,code:'capability_not_granted'})
  assert.equal(denied.calls(),0)

  const h=await harness({key:'wechat.demo.article-sample'})
  const plan=await h.service.publishPlanVersion({
    key:'wechat-demo-paid-fixture',name:'Synthetic demo customer price',
    limits:{monthlyRequests:100,maxPageSize:100,burstRps:100},
    priceBook:{key:'wechat-demo-paid-fixture',currency:'CNY',defaultMultiplierPpm:1_000_000,
      entries:[{meterKey:h.endpoint.operation,billingUnit:'request',unitPriceMinor:7}]},
  },'test-admin')
  const current=await h.service.getConsumerPlan(h.context.consumer.id)
  await h.service.assignConsumerPlan(h.context.consumer.id,{planVersionId:plan.versionId,expectedRevision:current.revision},'test-admin')
  await h.service.setTenantBillingProfile(h.context.tenant.id,{mode:'enforced',multiplierPpm:1_000_000},'test-admin')
  await assert.rejects(h.gateway.forwardNative(h.context,h.query),{status:402,code:'insufficient_credit'})
  assert.equal(h.calls(),0)
  assert.equal(h.platformStore.calls.size,0)

  await h.service.addTenantCredit(h.context.tenant.id,{amountMinor:7,currency:'CNY',reason:'Synthetic fixture credit'},
    {idempotencyKey:'wechat-demo-fixture-credit',actor:'test-admin'})
  const first=await h.gateway.forwardNative(h.context,h.query)
  const replay=await h.gateway.forwardNative(h.context,h.query)
  assert.equal(first.status,200);assert.equal(replay.replay,true)
  assert.deepEqual(first.body,replay.body)
  assert.equal(h.calls(),1)
  assert.equal(h.usageStore.creditAccounts.get(h.context.tenant.id).availableMinor,0)
  assert.equal(h.usageStore.customerCharges.size,1)
  const charge=[...h.usageStore.customerCharges.values()][0]
  assert.equal(charge.status,'captured');assert.equal(charge.chargedMinor,7)
  const call=[...h.platformStore.calls.values()][0]
  assert.equal(call.billed,false);assert.equal(call.costMinor,0)
  await assert.rejects(h.gateway.forwardNative(h.context,{...h.query,idempotencyKey:'wechat-demo-next-request'}),
    {status:402,code:'insufficient_credit'})
  assert.equal(h.calls(),1)
})

test('PostgreSQL reviewed zero price applies only to the registered free WeChat contract', async () => {
  for (const key of ['wechat.demo.article-sample','wechat.search.search']) {
    const endpoint=nativeForwardingEndpoint(key)
    const definition=EXTERNAL_PLATFORM_OPERATION_CATALOG.tikhub.find(item=>item.operationKey===endpoint.operation)
    const row={provider_key:'tikhub',operation_key:endpoint.operation,control_source:'database',desired_state:'active',
      revision:'1',release_revision:'1',release_status:'released',contract_version:definition.contractVersion,
      endpoint_keys:[endpoint.endpointKey],price_book_version:'1',price_book_source:'database',price_book_status:'reviewed',
      currency:'USD',pricing_as_of:'2026-09-29',monthly_budget_minor:'100000',monthly_subsidy_budget_minor:'0',
      endpoint_prices:{[endpoint.endpointKey]:'0'}}
    const control=new PostgresExternalPlatformControlStore({pool:{query:async()=>({rows:[row]})}})
    if(endpoint.allowZeroCost) {
      const state=await control.authorizeDispatch('tikhub',endpoint.operation,{credentialConfigured:true})
      assert.ok(state)
    } else await assert.rejects(control.authorizeDispatch('tikhub',endpoint.operation,{credentialConfigured:true}))
  }
})

test('WeChat raw alias maps one explicit keyword and rejects incompatible legacy controls before dispatch', () => {
  const base={platform:'weixin',keyword:'自行车',count:20,params:{raw:false}}
  const mapped=normalizeWechatSearchAlias(base)
  assert.equal(mapped.path,WECHAT_SEARCH_PATH)
  assert.deepEqual(mapped.body,{params:{keyword:'自行车',raw:false}})
  assert.equal(normalizeWechatSearchAlias({platform:'wechat_mp',query:'自行车'}).body.params.business_type,'article')
  assert.equal(normalizeWechatSearchAlias({...base,page:2,cursor:'new-page-cursor'}).body.params.cursor,'new-page-cursor')
  for(const input of [
    {...base,query:'different'}, {...base,keywords:['a','b']}, {...base,count:1}, {...base,page:2},
    {...base,cursor:'mxnc1.retired'}, {...base,params:{cursor:'mxnc1.retired'}}, {...base,params:{offset:20}},
    {...base,includeDetails:true}, {...base,includeComments:true}, {...base,disableAutoDetails:false},
    {...base,params:{provider:'private'}}, {...base,params:[]}, {...base,deliveryMode:'refresh'},
    {...base,platform:'wechat_mp',params:{business_type:'account'}}, {...base,cursor:'new',params:{cursor:'other'}},
  ]) assert.throws(()=>normalizeWechatSearchAlias(input),{status:400})
  assert.throws(()=>normalizeNativeForwardingRequest('wechat.search.search',{params:{keyword:'x',cursor:'mxnc1.retired'}}),{code:'wechat_legacy_cursor_retired'})
})

async function wechatAliasApp(t,h,{gateway=true}={}) {
  h.service.externalWechatSearch = gateway ? (context, input) => h.gateway.forwardNative(context, input) : null
  h.service.externalNativeCapabilities = options => h.gateway.nativeReadiness(options)
  let historicalCalls=0
  h.service.adapter=new NightAllAdapter({baseUrl:'http://retired-fixture.invalid',fetchImpl:async()=>{
    historicalCalls++;throw new Error('WeChat must never reach the historical connector')
  }})
  const server=createServer(createApp({store:h.usageStore,service:h.service,adapter:h.service.adapter,
    socialAccountTikHubGateway:gateway?h.gateway:null,listenerMode:'public',logger:{error(){}}}))
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise(resolve=>server.close(resolve)))
  const base=`http://127.0.0.1:${server.address().port}`
  return {historicalCalls:()=>historicalCalls,request:(path,body,key='wechat-alias-fixture-001',auth=true)=>fetch(base+path,{
    method:'POST',headers:{...(auth?{authorization:`Bearer ${h.apiKey.secret}`} : {}),'content-type':'application/json','idempotency-key':key},body:JSON.stringify(body),
  })}
}

test('WeChat historical public alias and native path share the new response, billing identity and exact replay',async t=>{
  const h=await harness({key:'wechat.search.search'}), app=await wechatAliasApp(t,h)
  const body={platform:'wechat_search',keyword:'自行车',count:20}
  const response=await app.request('/api/v1/search/raw',body)
  assert.equal(response.status,200)
  const first=await response.json()
  assert.equal(first.endpoint,'wechat.search.search');assert.deepEqual(first.data,DATA)
  assert.equal(first.data.raw_data,undefined);assert.doesNotMatch(JSON.stringify(first),/tikhub|sourceProvider|standard_raw_payload/i)
  const replay=await app.request(WECHAT_SEARCH_PATH,{params:{keyword:'自行车'}})
  assert.equal(replay.status,200);assert.equal(replay.headers.get('idempotent-replay'),'true')
  assert.deepEqual(await replay.json(),first)
  for(const platform of ['wechat','weixin',' WECHAT_SEARCH ']) {
    const alias=await app.request('/api/v1/search/raw',{...body,platform})
    assert.equal(alias.status,200);assert.deepEqual(await alias.json(),first)
  }
  assert.equal(h.calls(),1);assert.equal(h.usageStore.requests.size,1);assert.equal(app.historicalCalls(),0)
  const conflict=await app.request('/api/v1/search/raw',{...body,keyword:'changed'})
  assert.equal(conflict.status,409);assert.equal(h.calls(),1)
})

test('retired WeChat routes and invalid continuations never replay old results or dispatch either connector',async t=>{
  const h=await harness({key:'wechat.search.search'}), app=await wechatAliasApp(t,h)
  for(const platform of ['wechat_search','wechat_mp','wechat','weixin']) {
    const response=await app.request('/api/v1/night-all/search/raw',{platform,keyword:'自行车'})
    assert.equal(response.status,410)
    assert.equal((await response.json()).error.details.replacement,WECHAT_SEARCH_PATH)
    await assert.rejects(h.service.nightAllCompatibilitySearch(h.context,{operation:'raw',body:{platform},idempotencyKey:'old-attempt'}),{status:410})
    assert.throws(()=>h.service.adapter.search({body:{platform}}),{status:410})
    assert.throws(()=>h.service.adapter.legacySearch({operation:'raw',body:{platform}}),{status:410})
  }
  assert.equal((await app.request('/api/v1/search/raw',{platform:'wechat',keyword:'x',cursor:'mxnc1.retired'})).status,400)
  assert.equal((await app.request('/api/v1/search/raw?cursor=old',{platform:'wechat',keyword:'x'})).status,400)
  assert.equal((await app.request('/api/v1/night-all/search/raw',{platform:'wechat',keyword:'x'},'no-auth',false)).status,401)
  assert.equal(h.calls(),0);assert.equal(app.historicalCalls(),0);assert.equal(h.usageStore.requests.size,0)
})

test('WeChat alias fails closed for missing Key grants, disabled operation or unavailable gateway',async t=>{
  for(const options of [{grant:false,status:403},{enabled:false,status:503},{gateway:false,status:503}]) {
    const h=await harness({key:'wechat.search.search',...options}), app=await wechatAliasApp(t,h,options)
    const response=await app.request('/api/v1/search/raw',{platform:'wechat_search',keyword:'自行车'})
    assert.equal(response.status,options.status)
    assert.equal(h.calls(),0);assert.equal(app.historicalCalls(),0)
  }
})

test('WeChat raw alias reserves the customer price before dispatch and charges only once across paths',async t=>{
  const h=await harness({key:'wechat.search.search'}), app=await wechatAliasApp(t,h)
  await h.service.setTenantBillingProfile(h.context.tenant.id,{mode:'enforced',defaultUnitPriceMinor:7,defaultCurrency:'CNY'},'test-admin')
  const body={platform:'wechat_search',keyword:'自行车'}
  assert.equal((await app.request('/api/v1/search/raw',body)).status,402)
  assert.equal(h.calls(),0);assert.equal(app.historicalCalls(),0)
  await h.service.addTenantCredit(h.context.tenant.id,{amountMinor:7,currency:'CNY',reason:'Synthetic alias credit'},
    {idempotencyKey:'wechat-alias-fixture-credit',actor:'test-admin'})
  assert.equal((await app.request('/api/v1/search/raw',body)).status,200)
  const replay=await app.request(WECHAT_SEARCH_PATH,{params:{keyword:'自行车'}})
  assert.equal(replay.status,200);assert.equal(replay.headers.get('idempotent-replay'),'true')
  assert.equal(h.calls(),1);assert.equal(h.usageStore.customerCharges.size,1)
  assert.equal([...h.usageStore.customerCharges.values()][0].chargedMinor,7)
  assert.equal(h.usageStore.creditAccounts.get(h.context.tenant.id).availableMinor,0)
  assert.equal((await app.request('/api/v1/search/raw',body,'wechat-alias-next-intent')).status,402)
  assert.equal(h.calls(),1)
})

test('WeChat migration leaves other raw platforms and crawl/user-info HTTP routes on their existing handlers',async t=>{
  const h=await harness({key:'wechat.search.search'}), app=await wechatAliasApp(t,h)
  const seen=[]
  h.service.nightAllCompatibilitySearch=async(_context,input)=>{
    seen.push(input);return {status:200,body:{data:{raw_data:'[]'},requestId:'legacy-fixture'},requestId:'fixture',replay:false}
  }
  for(const path of ['/api/v1/search/raw','/api/v1/night-all/search/raw','/api/v1/search/crawl','/api/v1/night-all/search/user-info']) {
    const body={platform:'douyin',keyword:'x'}
    const response=await app.request(path,body)
    assert.equal(response.status,200);assert.equal((await response.json()).requestId,'legacy-fixture')
    assert.deepEqual(seen.at(-1).body,body)
    assert.equal(seen.at(-1).path,`/api/v1/night-all/search/${path.split('/').at(-1)}`)
  }
  assert.equal(h.calls(),0)
})

test('WeChat cutover preserves a previously used idempotency key instead of purchasing the search again',async t=>{
  const h=await harness({key:'wechat.search.search'}), app=await wechatAliasApp(t,h)
  const old={id:'retired-fixture-request',apiKeyId:h.context.apiKey.id,consumerId:h.context.consumer.id,
    fingerprint:'old-wechat-contract-fingerprint',status:'committed',responseBody:{data:{raw_data:'[]'}}}
  h.usageStore.requests.set(old.id,old)
  h.usageStore.requestsByScope.set(`${h.context.consumer.id}:wechat-alias-fixture-001`,old.id)
  const response=await app.request('/api/v1/search/raw',{platform:'wechat_search',keyword:'自行车'})
  assert.equal(response.status,409);assert.equal((await response.json()).error.code,'idempotency_conflict')
  assert.deepEqual(h.usageStore.requests.get(old.id),old)
  assert.equal(h.calls(),0);assert.equal(app.historicalCalls(),0)
})

test('WeChat retirement removes historical live discovery while retaining stored aggregate search',()=>{
  const grants=['wechat_mp','wechat_search','douyin']
  const legacy=buildNightAllLegacySearchCapabilities(grants)
  assert.deepEqual(legacy.operations.raw.supportedPlatforms,['douyin'])
  const sources=aggregateSourceCatalog(grants,[])
  for(const platform of ['wechat_mp','wechat_search']) {
    const source=sources.find(row=>row.platform===platform)
    assert.equal(source.stored,true);assert.equal(source.refresh,false);assert.deepEqual(source.routes,[])
  }
  assert.equal(sources.find(row=>row.platform==='douyin').refresh,true)
})

test('data/search WeChat uses the native contract and shares replay with raw and native paths', async t => {
  const h = await harness({ key: 'wechat.search.search' }), app = await wechatAliasApp(t, h)
  const input = { platform: 'wechat_mp', query: '自行车', pageSize: 20, type: 'stable', params: { raw: false } }
  const first = await app.request('/api/v1/data/search', input)
  assert.equal(first.status, 200)
  const payload = await first.json()
  assert.equal(payload.endpoint, 'wechat.search.search')
  for (const [path, body] of [[WECHAT_SEARCH_PATH, { params: { keyword: '自行车', business_type: 'article', raw: false } }],
    ['/api/v1/search/raw', { platform: 'wechat_mp', query: '自行车', params: { raw: false } }]]) {
    const replay = await app.request(path, body)
    assert.equal(replay.status, 200)
    assert.equal(replay.headers.get('idempotent-replay'), 'true')
    assert.deepEqual(await replay.json(), payload)
  }
  for (const body of [{ ...input, type: 'other' }, { ...input, cursor: 'mxnc1.old' }, { ...input, pageSize: 5 }]) {
    assert.equal((await app.request('/api/v1/data/search', body, 'invalid-data-search')).status, 400)
  }
  assert.equal((await app.request('/api/v1/data/search?cursor=old', input)).status, 400)
  assert.equal(h.calls(), 1); assert.equal(app.historicalCalls(), 0)
})

test('data/search fails closed for WeChat permissions, runtime and balance without Night-All fallback', async t => {
  for (const options of [{ grant: false, status: 403 }, { enabled: false, status: 503 }, { gateway: false, status: 503 }, { balance: true, status: 402 }]) {
    const h = await harness({ key: 'wechat.search.search', ...options }), app = await wechatAliasApp(t, h, options)
    if (options.balance) await h.service.setTenantBillingProfile(h.context.tenant.id, { mode: 'enforced', defaultUnitPriceMinor: 7, defaultCurrency: 'CNY' }, 'test-admin')
    assert.equal((await app.request('/api/v1/data/search', { platform: 'wechat', query: '自行车' })).status, options.status)
    assert.equal(h.calls(), 0); assert.equal(app.historicalCalls(), 0)
  }
})

test('aggregate WeChat discovery separates native live permission from stored platform grants', async t => {
  const h = await harness({ key: 'wechat.search.search' })
  await wechatAliasApp(t, h)
  const sources = (await h.service.aggregateSources(h.context)).sources
  for (const platform of ['wechat_mp', 'wechat_search']) {
    const source = sources.find(row => row.platform === platform)
    assert.equal(source.refresh, true); assert.equal(source.stored, false)
    assert.equal(source.routes[0].operation, h.endpoint.operation)
    assert.equal((await h.service.aggregateSources(h.context, 'hub_only')).sources.find(row => row.platform === platform).refresh, true)
  }
  await assert.rejects(h.service.aggregatePreview(h.context, { query: '自行车', platforms: ['wechat_mp'], mode: 'stored' }), { status: 403 })
  await assert.rejects(h.service.aggregatePreview(h.context, { query: 'x'.repeat(101), platforms: ['wechat_mp'] }), { status: 400 })
  const preview = await h.service.aggregatePreview(h.context, { query: '自行车', platforms: ['wechat_mp'] })
  assert.equal(preview.items[0].meterKey, h.endpoint.operation)
  assert.equal(preview.items[0].readiness, 'ready')
  assert.equal(h.calls(), 0)
})

test('aggregate WeChat maps only declared items, preserves native continuation and charges one child per page', async t => {
  const h = await harness({ key: 'wechat.search.search', data: params => ({
    keyword: params.keyword, items: [{ docID: params.cursor ? '9223372036854775806' : '9223372036854775807',
      title: '<em>自行车</em>观察', desc: '内容摘要', jumpInfo: { nickName: '测试公众号', url: 'https://mp.weixin.qq.com/s/fixture' } }],
    categories: [{ word: '全部' }, { word: '文章' }], continue_flag: params.cursor ? 0 : 1,
    cursor: params.cursor ? '' : 'fixture-next-page', total: null,
  }) }), app = await wechatAliasApp(t, h)
  await h.service.setTenantBillingProfile(h.context.tenant.id, { mode: 'enforced', defaultUnitPriceMinor: 7, defaultCurrency: 'CNY' }, 'test-admin')
  await h.service.addTenantCredit(h.context.tenant.id, { amountMinor: 14, currency: 'CNY', reason: 'Synthetic aggregate credit' }, { idempotencyKey: 'wechat-aggregate-credit', actor: 'test-admin' })
  const input = { query: '自行车', platforms: ['wechat_mp'], execution: 'hub_only' }
  const preview = await h.service.aggregatePreview(h.context, input)
  assert.equal(preview.estimatedMinor, 7); assert.equal(preview.parentChargeMinor, 0)
  const first = await app.request('/api/v1/data/aggregate/search', input, 'wechat-aggregate-first')
  assert.equal(first.status, 200)
  const payload = await first.json(), data = payload.data
  assert.equal(data.items.length, 1); assert.equal(data.items[0].title, '自行车观察')
  assert.equal(data.items[0].externalId, '9223372036854775807')
  assert.equal(data.items[0].objectType, 'article'); assert.equal(data.items[0].author.name, '测试公众号')
  assert.equal(data.items[0].source, 'hub'); assert.equal(data.pageInfo.hasMore, true)
  assert.match(data.pageInfo.nextCursor, /^mxag1\./)
  assert.doesNotMatch(JSON.stringify(payload), /tikhub|sourceProvider|fixture-next-page/)
  assert.equal(h.dispatched[0].raw, false); assert.equal(h.dispatched[0].business_type, 'article')
  assert.equal(h.usageStore.customerCharges.size, 1)
  const replay = await app.request('/api/v1/data/aggregate/search', input, 'wechat-aggregate-first')
  assert.deepEqual(await replay.json(), payload); assert.equal(h.calls(), 1)
  assert.equal((await app.request('/api/v1/data/aggregate/search', { ...input, query: 'changed', cursor: data.pageInfo.nextCursor }, 'wechat-aggregate-invalid')).status, 400)
  const next = await app.request('/api/v1/data/aggregate/search', { ...input, cursor: data.pageInfo.nextCursor }, 'wechat-aggregate-second')
  const page2 = await next.json()
  assert.equal(next.status, 200); assert.equal(page2.data.pageInfo.hasMore, false)
  assert.equal(h.dispatched[1].cursor, 'fixture-next-page')
  assert.equal(h.calls(), 2); assert.equal(h.usageStore.customerCharges.size, 2)
  assert.equal(h.usageStore.creditAccounts.get(h.context.tenant.id).availableMinor, 0)
  const emptyWallet = await app.request('/api/v1/data/aggregate/search', input, 'wechat-aggregate-new-round')
  assert.equal((await emptyWallet.json()).data.sources[0].status, 'unavailable')
  assert.equal(h.calls(), 2); assert.equal(app.historicalCalls(), 0)
})

test('WeChat aggregate empty/malformed pages never invent category results or repeat a cursor', () => {
  const body = data => ({ endpoint: 'wechat.search.search', data })
  const route = { platform: 'wechat_search', cursor: 'same-cursor' }
  const empty = wechatAggregatePage(body({ items: [], categories: [{ title: '全部' }], no_more: '没有结果', continue_flag: 1, cursor: 'next' }), route)
  assert.deepEqual(empty.items, []); assert.equal(empty.pageInfo.hasMore, false)
  assert.throws(() => wechatAggregatePage(body({ categories: [{ title: '全部' }] }), route), { status: 502 })
  const repeated = wechatAggregatePage(body({ items: [{ title: '结果' }], continue_flag: 1, cursor: 'same-cursor' }), route)
  assert.equal(repeated.pageInfo.nextCursor, null)
})

test('aggregate malformed WeChat delivery retains paid child evidence and never redispatches on replay', async t => {
  const h = await harness({ key: 'wechat.search.search', data: { categories: [{ title: '全部' }] } })
  const app = await wechatAliasApp(t, h)
  const input = { query: '自行车', platforms: ['wechat_search'] }
  const first = await app.request('/api/v1/data/aggregate/search', input, 'wechat-malformed-round')
  const payload = await first.json()
  assert.equal(payload.data.sources[0].status, 'unavailable')
  const child = h.usageStore.requests.get(payload.data.sources[0].requestId)
  assert.equal(child.status, 'committed')
  assert.equal(child.responseBody.endpoint, 'wechat.search.search')
  assert.equal(payload.data.items.length, 0)
  const replay = await app.request('/api/v1/data/aggregate/search', input, 'wechat-malformed-round')
  assert.deepEqual(await replay.json(), payload)
  assert.equal(h.calls(), 1); assert.equal(app.historicalCalls(), 0)
})
