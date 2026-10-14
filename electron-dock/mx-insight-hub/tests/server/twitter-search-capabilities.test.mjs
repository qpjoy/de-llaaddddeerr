import assert from 'node:assert/strict'
import test from 'node:test'
import { loadConfig } from '../../server/config.mjs'
import { createRuntime } from '../../server/index.mjs'

async function harness(t) {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Capability discovery must not dispatch') })
  const runtime = await createRuntime(loadConfig({
    MX_INSIGHT_STORE: 'memory', MX_INSIGHT_LISTENER_MODE: 'public',
    MX_INSIGHT_API_KEY_PEPPER: 'twitter-readiness-synthetic-pepper-at-least-32',
  }))
  t.after(async () => { runtime.agent.close(); await runtime.store.close() })
  const { service, store, hubSocialGateway, externalPlatformControlStore: controls, rapidApiCredentialStore: credentials } = runtime
  service.logger = { warn() {} }
  let configured = true, metadataReads = 0
  credentials.describeCredential = async provider => {
    assert.equal(provider, 'rapidapi')
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
    const row = (await controls.describeProvider('rapidapi', { config: hubSocialGateway.config, credentialConfigured: true }))
      .find(row => row.operationKey === operation)
    await controls.updatePolicy('rapidapi', operation, {
      expectedRevision: row.revision, desiredState, reason: 'Offline readiness test',
      priceBook: { currency: 'USD', pricingAsOf: '2026-10-14T00:00:00Z',
        monthlyBudgetMinor: 10000, monthlySubsidyBudgetMinor: 10000,
        unitCostMinorByEndpoint: { 'twitter-aio.search': 1 } },
    }, { runtime: { config: hubSocialGateway.config, credentialConfigured: true } })
  }
  const read = async (ctx = context) => (await service.capabilities(ctx)).data.platforms.find(row => row.platform === 'twitter')
  t.after(() => {
    assert.equal(network.mock.callCount(), 0)
    assert.equal(secretReads.mock.callCount(), 0)
    assert.equal(credentialSnapshots.mock.callCount(), 0)
    assert.equal(legacy.mock.callCount(), 0)
  })
  return { runtime, service, store, consumer, context, setPolicy, read, credentials,
    metadataReads: () => metadataReads, setConfigured: value => { configured = value } }
}

test('Twitter standard search readiness uses only its operation and credential metadata for a platform-only Key', async t => {
  const h = await harness(t)
  await h.setPolicy('social.content.search', 'active')
  assert.deepEqual(await h.store.listEffectiveCapabilityGrants(h.consumer.id, h.context.apiKey.id), [])
  assert.deepEqual(await h.read(), { platform: 'twitter', ready: false,
    search: { ready: true, source: 'hub', servingMode: 'live_only', contractVersion: 'night-all.data-search.v1' } })
  await h.setPolicy('social.content.search', 'paused')
  assert.equal((await h.read()).search.ready, false)
  await h.setPolicy('social.content.search', 'active')
  h.setConfigured(false)
  assert.equal((await h.read()).search.ready, false)
})

test('Twitter capability discovery does not claim live readiness for Test Keys or query ungranted platforms', async t => {
  const h = await harness(t)
  await h.setPolicy('social.content.search', 'active')
  const before = h.metadataReads()
  assert.equal((await h.read({ ...h.context, apiKey: { ...h.context.apiKey, environment: 'test' } })).search.ready, false)
  assert.equal(h.metadataReads(), before)
  await h.store.setPlatformGrant(h.consumer.id, 'twitter', false)
  assert.equal(await h.read(), undefined)
  assert.equal(h.metadataReads(), before)
})

test('Twitter readiness fails closed without blocking capabilities or exposing provider failures', async t => {
  const h = await harness(t)
  await h.setPolicy('social.content.search', 'active')
  h.credentials.describeCredential = async () => { throw new Error('synthetic-private-provider-error') }
  const row = await h.read()
  assert.equal(row.ready, false)
  assert.equal(row.search.ready, false)
  assert.doesNotMatch(JSON.stringify(row), /synthetic-private-provider-error|rapidapi/)
})
