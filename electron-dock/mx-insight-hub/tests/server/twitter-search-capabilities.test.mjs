import assert from 'node:assert/strict'
import test from 'node:test'
import { loadConfig } from '../../server/config.mjs'
import { createRuntime } from '../../server/index.mjs'

async function harness(t, provider = 'tikhub') {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Capability discovery must not dispatch') })
  const runtime = await createRuntime({ ...loadConfig({
    MX_INSIGHT_STORE: 'memory', MX_INSIGHT_LISTENER_MODE: 'public',
    MX_INSIGHT_API_KEY_PEPPER: 'twitter-readiness-synthetic-pepper-at-least-32',
  }), twitterSearchProvider: provider })
  t.after(async () => { runtime.agent.close(); await runtime.store.close() })
  await runtime.strategySearchRoutingStore.update('search', 'twitter', { mode: 'fixed', primaryProvider: provider,
    fallbackProvider: null, expectedRevision: 1, reason: 'Offline fixed supplier policy' })
  const { service, store, externalPlatformControlStore: controls } = runtime
  const credentials = provider === 'tikhub' ? runtime.tikHubCredentialStore : runtime.rapidApiCredentialStore
  const gateway = provider === 'tikhub' ? runtime.nativeSearchGateways.twitter : runtime.hubSocialGateway
  const operation = provider === 'tikhub' ? 'native.t.twitter_web_fetch_search_timeline' : 'social.content.search'
  const endpoint = provider === 'tikhub' ? 'native.t.twitter_web_fetch_search_timeline' : 'twitter-aio.search'
  service.logger = { warn() {} }
  let configured = true, metadataReads = 0
  credentials.describeCredential = async selectedProvider => {
    assert.equal(selectedProvider, provider)
    metadataReads++
    return { credentialConfigured: configured }
  }
  const secretReads = t.mock.method(credentials, 'readCredential', async () => { throw new Error('Plaintext credentials are not needed') })
  const credentialSnapshots = t.mock.method(credentials, 'readCredentialSnapshot', async () => { throw new Error('Credential resolution is not needed') })
  const legacy = t.mock.method(runtime.adapter, 'capabilities', async () => { throw new Error('Night-All must not be consulted') })
  const tenant = await service.createTenant({ name: 'Twitter capability fixture' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Platform-only Twitter caller' })
  await service.putPlatformConfiguration('twitter', { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Platform-only', platforms: ['twitter'], capabilities: [] })
  const context = await service.authenticate(key.secret)
  const setPolicy = async (operation, desiredState) => {
    const row = (await controls.describeProvider(provider, { config: gateway.config, credentialConfigured: true }))
      .find(row => row.operationKey === operation)
    await controls.updatePolicy(provider, operation, {
      expectedRevision: row.revision, desiredState, reason: 'Offline readiness test',
      priceBook: { currency: 'USD', pricingAsOf: '2026-10-14T00:00:00Z',
        monthlyBudgetMinor: 10000, monthlySubsidyBudgetMinor: 10000,
        unitCostMinorByEndpoint: { [endpoint]: 1 } },
    }, { runtime: { config: gateway.config, credentialConfigured: true } })
  }
  const read = async (ctx = context) => (await service.capabilities(ctx)).data.platforms.find(row => row.platform === 'twitter')
  t.after(() => {
    assert.equal(network.mock.callCount(), 0)
    assert.equal(secretReads.mock.callCount(), 0)
    assert.equal(credentialSnapshots.mock.callCount(), 0)
    assert.equal(legacy.mock.callCount(), 0)
  })
  return { runtime, service, store, consumer, context, setPolicy, read, credentials, operation,
    metadataReads: () => metadataReads, setConfigured: value => { configured = value } }
}

for (const provider of ['tikhub', 'rapidapi']) test(`Twitter ${provider} search readiness uses the selected operation and credential metadata for a platform-only Key`, async t => {
  const h = await harness(t, provider)
  await h.setPolicy(h.operation, 'active')
  assert.deepEqual(await h.store.listEffectiveCapabilityGrants(h.consumer.id, h.context.apiKey.id), [])
  assert.deepEqual(await h.read(), { platform: 'twitter', ready: false,
    search: { ready: true, source: 'hub', servingMode: 'live_only', contractVersion: 'night-all.data-search.v1' } })
  await h.setPolicy(h.operation, 'paused')
  assert.equal((await h.read()).search.ready, false)
  await h.setPolicy(h.operation, 'active')
  h.setConfigured(false)
  assert.equal((await h.read()).search.ready, false)
})

test('Twitter capability discovery does not claim live readiness for Test Keys or query ungranted platforms', async t => {
  const h = await harness(t)
  await h.setPolicy(h.operation, 'active')
  const before = h.metadataReads()
  assert.equal((await h.read({ ...h.context, apiKey: { ...h.context.apiKey, environment: 'test' } })).search.ready, false)
  assert.equal(h.metadataReads(), before)
  await h.store.setPlatformGrant(h.consumer.id, 'twitter', false)
  assert.equal(await h.read(), undefined)
  assert.equal(h.metadataReads(), before)
})

test('Twitter readiness fails closed without blocking capabilities or exposing provider failures', async t => {
  const h = await harness(t)
  await h.setPolicy(h.operation, 'active')
  h.credentials.describeCredential = async () => { throw new Error('synthetic-private-provider-error') }
  const row = await h.read()
  assert.equal(row.ready, false)
  assert.equal(row.search.ready, false)
  assert.doesNotMatch(JSON.stringify(row), /synthetic-private-provider-error|rapidapi/)
})

test('auto routing and readiness use each consumer current supplier release without adding native grants', async t => {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Readiness cannot dispatch') })
  const runtime = await createRuntime({ ...loadConfig({ MX_INSIGHT_STORE: 'memory', MX_INSIGHT_LISTENER_MODE: 'public',
    MX_INSIGHT_API_KEY_PEPPER: 'auto-twitter-capability-fixture-with-32-characters' }), twitterSearchProvider: 'tikhub' })
  t.after(async () => { runtime.agent.close(); await runtime.store.close(); assert.equal(network.mock.callCount(), 0) })
  const { service, store, externalPlatformControlStore: controls } = runtime
  const tenant = await service.createTenant({ name: 'Offline auto supplier fixture' }), contexts = []
  for (const name of ['TikHub canary consumer', 'Rapid-only consumer']) {
    const consumer = await service.createConsumer({ tenantId: tenant.id, name })
    await store.setPlatformGrant(consumer.id, 'twitter', true)
    const key = await service.createApiKey({ consumerId: consumer.id, name, platforms: ['twitter'], capabilities: [] })
    contexts.push(await service.authenticate(key.secret))
  }
  for (const [provider, credentials, gateway, operation, endpoint] of [
    ['tikhub', runtime.tikHubCredentialStore, runtime.nativeSearchGateways.twitter, 'native.t.twitter_web_fetch_search_timeline', 'native.t.twitter_web_fetch_search_timeline'],
    ['rapidapi', runtime.rapidApiCredentialStore, runtime.hubSocialGateway, 'social.content.search', 'twitter-aio.search'],
  ]) {
    credentials.describeCredential = async () => ({ credentialConfigured: true })
    const row = (await controls.describeProvider(provider, { config: gateway.config, credentialConfigured: true })).find(item => item.operationKey === operation)
    await controls.updatePolicy(provider, operation, { expectedRevision: row.revision,
      desiredState: provider === 'tikhub' ? 'canary' : 'active', canaryConsumerIds: provider === 'tikhub' ? [contexts[0].consumer.id] : [],
      reason: 'Offline auto routing readiness', priceBook: { currency: 'USD', pricingAsOf: '2026-10-18T00:00:00Z',
        monthlyBudgetMinor: 10000, monthlySubsidyBudgetMinor: 10000, unitCostMinorByEndpoint: { [endpoint]: 1 } } },
    { runtime: { config: gateway.config, credentialConfigured: true } })
  }
  runtime.nativeSearchGateways.twitter.searchContent = async () => 'tikhub'
  runtime.hubSocialGateway.searchRaw = async () => 'rapidapi'
  for (const [index, ctx] of contexts.entries()) {
    assert.equal((await service.capabilities(ctx)).data.platforms.find(row => row.platform === 'twitter').search.ready, true)
    assert.deepEqual(await store.listEffectiveCapabilityGrants(ctx.consumer.id, ctx.apiKey.id), [])
    assert.equal(await service.search(ctx, { path: '/api/v1/data/search',
      body: { platform: 'twitter', query: 'unchanged query', pageSize: 20 }, idempotencyKey: `auto-caller-${index}` }), 'rapidapi')
  }
  // TikHub remains a consumer-scoped readiness fallback, not the primary
  // merely because its canary release also permits this caller.
  runtime.rapidApiCredentialStore.describeCredential = async () => ({ credentialConfigured: false })
  assert.equal((await service.capabilities(contexts[0])).data.platforms.find(row => row.platform === 'twitter').search.ready, true)
  assert.equal(await service.search(contexts[0], { path: '/api/v1/data/search',
    body: { platform: 'twitter', query: 'unchanged query', pageSize: 20 }, idempotencyKey: 'auto-tikhub-readiness-backup' }), 'tikhub')
  assert.equal((await service.capabilities(contexts[1])).data.platforms.find(row => row.platform === 'twitter').search.ready, false)
  runtime.rapidApiCredentialStore.describeCredential = async () => ({ credentialConfigured: true })
  // Saved policy is authoritative even when a previous deployment had a
  // conflicting environment override; changing it is visible without restart.
  await runtime.strategySearchRoutingStore.update('search', 'twitter', { mode: 'priority', primaryProvider: 'tikhub',
    fallbackProvider: 'rapidapi', expectedRevision: 1, reason: 'Offline reverse-priority save' })
  assert.equal(await service.search(contexts[0], { path: '/api/v1/data/search',
    body: { platform: 'twitter', query: 'same original conditions', pageSize: 20 }, idempotencyKey: 'db-policy-changed' }), 'tikhub')
  await runtime.strategySearchRoutingStore.update('search', 'twitter', { mode: 'priority', primaryProvider: 'rapidapi',
    fallbackProvider: 'tikhub', expectedRevision: 2, reason: 'Restore default priority' })
  // The same caller also has a TikHub-only product. A bulk content capability
  // failure must not overwrite Twitter's independently available Rapid route.
  const ctx = contexts[0]
  await store.setPlatformGrant(ctx.consumer.id, 'bilibili', true)
  const key = await service.createApiKey({ consumerId: ctx.consumer.id, name: 'Mixed supplier key', platforms: ['twitter', 'bilibili'], capabilities: [] })
  const mixed = await service.authenticate(key.secret)
  runtime.tikHubCredentialStore.describeCredential = async () => { throw new Error('Synthetic TikHub metadata unavailable') }
  service.logger = { warn() {} }
  const capabilities = (await service.capabilities(mixed)).data.platforms
  assert.equal(capabilities.find(row => row.platform === 'twitter').search.ready, true)
  assert.equal(capabilities.find(row => row.platform === 'bilibili').search.ready, false)
  assert.deepEqual(await service.externalContentSearchCapabilities({ consumerId: ctx.consumer.id, platforms: ['twitter'] }), { twitter: { ready: true } },
    'Twitter-only bulk capability access does not read unrelated TikHub content metadata')
  assert.equal(await service.search(mixed, { path: '/api/v1/data/search',
    body: { platform: 'twitter', query: 'unchanged query', pageSize: 20 }, idempotencyKey: 'auto-metadata-unavailable' }), 'rapidapi')
})
