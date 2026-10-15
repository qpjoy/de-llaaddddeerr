import test from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../../server/index.mjs'
import { loadConfig } from '../../server/config.mjs'
import { TIKHUB_CONTENT_SEARCH_RECIPES } from '../../server/contracts/tikhub-content-search.mjs'

const platforms = Object.keys(TIKHUB_CONTENT_SEARCH_RECIPES)
async function runtimeFor(t) {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Offline registry/readiness must not dispatch') })
  const runtime = await createRuntime(loadConfig({ MX_INSIGHT_STORE: 'memory', MX_INSIGHT_LISTENER_MODE: 'public',
    MX_INSIGHT_API_KEY_PEPPER: 'content-registry-fixture-pepper-at-least-32-characters' }))
  runtime.service.logger = { warn() {} }
  t.after(async () => { runtime.agent.close(); await runtime.store.close(); assert.equal(network.mock.callCount(), 0) })
  return runtime
}

test('runtime binds both search entry points to each platform-owned TikHub content gateway without disturbing Weibo/Twitter dispatch', async t => {
  const runtime = await runtimeFor(t)
  for (const platform of platforms) {
    const gateway = runtime.nativeSearchGateways[platform]
    assert(gateway)
    assert.equal(gateway.providerKey, 'tikhub')
    assert.equal(gateway.platformStore.authorizationPlatform, platform)
    const calls = []
    gateway.searchContent = async (context, input) => { calls.push({ context, input }); return platform }
    const context = { fixture: platform }, input = { normalized: { platform }, body: { fixture: true } }
    assert.equal(await runtime.service.externalRawSearch(context, input), platform)
    assert.equal(await runtime.service.externalDataSearch(context, input), platform)
    assert.deepEqual(calls, [{ context, input }, { context, input }])
  }
  runtime.nativeSearchGateways.weibo.searchRaw = async () => 'weibo-original-route'
  runtime.hubSocialGateway.searchRaw = async () => 'twitter-original-route'
  assert.equal(await runtime.service.externalRawSearch({}, { normalized: { platform: 'weibo' } }), 'weibo-original-route')
  assert.equal(await runtime.service.externalDataSearch({}, { normalized: { platform: 'twitter' } }), 'twitter-original-route')
})

async function capabilityHarness(t) {
  const runtime = await runtimeFor(t), { service, store, tikHubCredentialStore: credentials, externalPlatformControlStore: controls } = runtime
  let configured = true, metadataReads = 0
  credentials.describeCredential = async provider => { assert.equal(provider, 'tikhub'); metadataReads++; return { credentialConfigured: configured } }
  const secrets = t.mock.method(credentials, 'readCredential', async () => { throw new Error('Readiness cannot reveal credentials') })
  const snapshots = t.mock.method(credentials, 'readCredentialSnapshot', async () => { throw new Error('Readiness cannot resolve credentials') })
  const legacy = t.mock.method(runtime.adapter, 'capabilities', async () => { throw new Error('Migrated capability discovery cannot depend on Night-All') })
  t.after(() => { assert.equal(secrets.mock.callCount(), 0); assert.equal(snapshots.mock.callCount(), 0); assert.equal(legacy.mock.callCount(), 0) })
  const tenant = await service.createTenant({ name: 'Four content fixture' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Platform-only content caller' })
  for (const platform of ['bilibili', 'douyin']) await service.putPlatformConfiguration(platform, { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Content-only', platforms: ['bilibili', 'douyin'], capabilities: [] })
  const context = await service.authenticate(key.secret)
  const setPolicy = async (platform, desiredState) => {
    const operation = `native.${TIKHUB_CONTENT_SEARCH_RECIPES[platform].key}`
    const config = runtime.nativeSearchGateways[platform].config
    const current = (await controls.describeProvider('tikhub', { config, credentialConfigured: true })).find(row => row.operationKey === operation)
    await controls.updatePolicy('tikhub', operation, { expectedRevision: current.revision, desiredState, reason: 'Offline content readiness fixture',
      priceBook: { currency: 'USD', pricingAsOf: '2026-10-15T00:00:00Z', monthlyBudgetMinor: 10000, monthlySubsidyBudgetMinor: 10000,
        unitCostMinorByEndpoint: { [operation]: 1 } } }, { runtime: { config, credentialConfigured: true } })
  }
  return { runtime, service, store, context, consumer, credentials, setPolicy,
    metadataReads: () => metadataReads, setConfigured: value => { configured = value } }
}

test('four-platform search readiness uses existing operation state and metadata for a platform-only key without granting native operations', async t => {
  const h = await capabilityHarness(t)
  await h.setPolicy('bilibili', 'active')
  const read = async () => (await h.service.capabilities(h.context)).data.platforms
  const rows = await read(), bili = rows.find(row => row.platform === 'bilibili'), douyin = rows.find(row => row.platform === 'douyin')
  assert.deepEqual(bili.search, { ready: true, source: 'hub', servingMode: 'live_only', contractVersion: 'night-all.data-search.v1' })
  assert.equal(bili.ready, false, 'keyword search does not claim the account compatibility paths are native-ready')
  assert.equal(douyin.search.ready, false, 'one operation does not enable another platform')
  assert.deepEqual(await h.store.listEffectiveCapabilityGrants(h.consumer.id, h.context.apiKey.id), [])
  await h.setPolicy('bilibili', 'paused')
  assert.equal((await read()).find(row => row.platform === 'bilibili').search.ready, false)
  await h.setPolicy('bilibili', 'active')
  h.setConfigured(false)
  assert.equal((await read()).find(row => row.platform === 'bilibili').search.ready, false)
})

test('content readiness excludes Test/ungranted keys and fails closed on metadata failure without supplier details', async t => {
  const h = await capabilityHarness(t)
  const before = h.metadataReads()
  const testRows = (await h.service.capabilities({ ...h.context, apiKey: { ...h.context.apiKey, environment: 'test' } })).data.platforms
  assert(testRows.every(row => row.search?.ready === false))
  assert.equal(h.metadataReads(), before)
  for (const platform of ['bilibili', 'douyin']) await h.store.setPlatformGrant(h.consumer.id, platform, false)
  assert.deepEqual((await h.service.capabilities(h.context)).data.platforms, [])
  assert.equal(h.metadataReads(), before)
  await h.store.setPlatformGrant(h.consumer.id, 'bilibili', true)
  h.credentials.describeCredential = async () => { throw new Error('synthetic-private-supplier-error') }
  const payload = await h.service.capabilities(h.context)
  assert.equal(payload.data.platforms[0].search.ready, false)
  assert.doesNotMatch(JSON.stringify(payload), /synthetic-private-supplier-error|tikhub/)
})
