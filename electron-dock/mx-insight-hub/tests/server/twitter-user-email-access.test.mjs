import assert from 'node:assert/strict'
import test from 'node:test'
import { issueApiKey } from '../../server/core/crypto.mjs'
import { PLATFORM, REVEAL_CAPABILITY, SEARCH_CAPABILITY } from '../../server/data/twitter-user-email/contract.mjs'
import { TwitterUserEmailSearch } from '../../server/data/twitter-user-email/search.mjs'
import { businessApiScopes, HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { LCY_IDENTITY, LcyHubLimitStore } from '../fixtures/lcy-hub-limit-store.mjs'

const pepper = 'twitter-user-email-access-test-local-pepper'
const snapshot = ({ scopeMode, platforms, capabilities }) => ({ scopeMode, platforms, capabilities })

async function fixture(store = new MemoryStore()) {
  const version = { id: 1, uniqueMappings: 1, publishedAt: '2026-01-01T00:00:00Z', partitionCount: 1 }
  const row = { username: 'david_example', email_local: 'example', domain: 'example.org', dup_count: 1 }
  const client = {
    async query(sql, params) {
      if (!params) return { rows: [] } // Transaction control and local statement timeout.
      assert.deepEqual(params, ['david', 20])
      return { rows: [row] }
    },
    release() {},
  }
  const audit = []
  const dictionary = new TwitterUserEmailSearch({
    pool: { connect: async () => client, query: async (_sql, params) => { audit.push(params); return { rows: [] } } },
    store: { activeVersion: async () => version }, hmacKey: pepper,
  })
  const service = new HubService({ store, adapter: {}, apiKeyPepper: pepper, twitterUserEmail: dictionary })
  const tenant = await service.createTenant({ name: 'Dictionary tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Dictionary consumer' })
  return { service, store, audit, scope: { tenantId: tenant.id, consumerId: consumer.id } }
}

test('LCY and other authorized Keys return complete addresses by default and audit the actual disclosure', async () => {
  const { service, scope, audit } = await fixture(new LcyHubLimitStore())
  const capabilities = [SEARCH_CAPABILITY]
  await service.putPlatformConfiguration(PLATFORM, scope)
  for (const capability of capabilities) await service.putCapabilityConfiguration(capability, scope)
  const input = { consumerId: scope.consumerId, name: 'LCY-delta', platforms: [PLATFORM], capabilities }
  const original = await service.createApiKey(input), sibling = await service.createApiKey(input)
  assert.equal(original.id, LCY_IDENTITY.key)
  const demo = await service.createDemoCredential({ keyId: original.id })
  const originalContext = await service.authenticate(demo.secret)
  const siblingContext = await service.authenticate(sibling.secret)
  assert.equal((await service.twitterUserEmailMetadata(originalContext)).defaultReveal, true)
  assert.equal((await service.twitterUserEmailMetadata(siblingContext)).defaultReveal, true)
  const query = { mode: 'prefix', query: 'david' }
  for (const [context, body, revealed] of [
    [originalContext, query, true], [originalContext, { ...query, reveal: false }, false],
    [siblingContext, query, true], [siblingContext, { ...query, reveal: false }, false],
  ]) {
    const result = await service.twitterUserEmailSearch(context, body)
    assert.equal(result.meta.revealed, revealed)
    assert.equal(result.items[0].emailMasked, !revealed)
    assert.equal(result.items[0].email, revealed ? 'example@example.org' : 'ex***@example.org')
    const record = audit.at(-1)
    assert.equal(record[4], context.apiKey.id)
    assert.match(record[7], /^[a-f0-9]{64}$/)
    assert.equal(record[10], revealed ? 1 : 0)
  }
})

test('dictionary access requires both scopes and accepts legacy reveal grants on existing Keys', async () => {
  const { service, scope } = await fixture()
  await service.putPlatformConfiguration('telegram', scope)
  const original = await service.createApiKey({ consumerId: scope.consumerId, name: 'Existing key', platforms: ['telegram'] })
  const demoContext = async () => service.authenticate((await service.createDemoCredential({ keyId: original.id })).secret)
  await assert.rejects(service.twitterUserEmailMetadata(await demoContext()), { status: 403, code: 'platform_not_granted' })

  await service.putPlatformConfiguration(PLATFORM, scope)
  await service.putCapabilityConfiguration(SEARCH_CAPABILITY, scope)
  const configuration = await service.getPlatformConfiguration(scope)
  assert.ok(configuration.availableCapabilities.some(row => row.capability === SEARCH_CAPABILITY))
  assert.ok(!configuration.availableCapabilities.some(row => row.capability === REVEAL_CAPABILITY))
  await assert.rejects(service.twitterUserEmailMetadata(await demoContext()), { status: 403, code: 'platform_not_granted' })

  const platforms = [...original.platforms, PLATFORM]
  const domainOnly = await service.updateApiKeyScopes(original.id, { platforms, capabilities: [], expected: snapshot(original) }, 'admin')
  await assert.rejects(service.twitterUserEmailMetadata(await demoContext()), { status: 403, code: 'capability_not_granted' })
  const searchKey = await service.updateApiKeyScopes(original.id, { platforms, capabilities: [SEARCH_CAPABILITY], expected: snapshot(domainOnly) }, 'admin')
  const context = await demoContext()
  assert.equal((await service.authenticate(original.secret)).apiKey.id, context.apiKey.id)
  assert.equal((await service.twitterUserEmailMetadata(context)).version.id, 1)
  const query = { mode: 'prefix', query: 'david' }
  assert.equal((await service.twitterUserEmailSearch(context, query)).items[0].email, 'example@example.org')
  assert.equal((await service.twitterUserEmailSearch(context, { ...query, reveal: true })).items[0].email, 'example@example.org')
  await service.putCapabilityConfiguration(REVEAL_CAPABILITY, scope)
  assert.ok((await service.getPlatformConfiguration(scope)).availableCapabilities.some(row => row.capability === REVEAL_CAPABILITY))
  await service.updateApiKeyScopes(original.id, { platforms, capabilities: [SEARCH_CAPABILITY, REVEAL_CAPABILITY], expected: snapshot(searchKey) }, 'admin')
  assert.equal((await service.twitterUserEmailSearch(await demoContext(), { ...query, reveal: true })).items[0].email, 'example@example.org')
})

test('implicit scope selection and dynamic keys do not expose a caller’s dictionary grants', async () => {
  const { service, store, scope } = await fixture()
  await service.putPlatformConfiguration('telegram', scope)
  await service.putPlatformConfiguration(PLATFORM, scope)
  for (const capability of [SEARCH_CAPABILITY, REVEAL_CAPABILITY]) await service.putCapabilityConfiguration(capability, scope)
  const regular = await service.createApiKey({ consumerId: scope.consumerId, name: 'Default key' })
  const legacyAll = await service.createApiKey({ consumerId: scope.consumerId, name: 'Legacy preset key', scopePreset: 'legacy_all' })
  assert.ok(legacyAll.platforms.includes('telegram'))
  const admin = await service.createAdminExecutionCredential()
  for (const scopes of [regular, legacyAll, businessApiScopes(), admin.access]) {
    assert.ok(!scopes.platforms.includes(PLATFORM))
    assert.ok(!scopes.capabilities.includes(SEARCH_CAPABILITY))
    assert.ok(!scopes.capabilities.includes(REVEAL_CAPABILITY))
  }
  const issued = issueApiKey(pepper)
  await store.createApiKey({ ...issued, ...scope, name: 'Dynamic key', expiresAt: new Date(Date.now() + 60_000).toISOString() })
  const dynamic = await service.authenticate(issued.plaintext)
  await assert.rejects(service.twitterUserEmailMetadata(dynamic), { status: 403, code: 'snapshot_key_required' })
})

test('opting an existing managed-size profile into the dictionary preserves separate raw WeChat entitlements and limits', async () => {
  const { service, store, scope } = await fixture()
  const managed = businessApiScopes()
  await store.replaceGrants(scope.consumerId, [...managed.platforms, PLATFORM])
  for (const capability of [...managed.capabilities, SEARCH_CAPABILITY]) await service.putCapabilityConfiguration(capability, scope)

  // Seed the raw materialized snapshot in the same shape as deployment sync.
  const key = await store.createApiKey({
    ...issueApiKey(pepper), ...scope, name: 'Existing managed snapshot', expiresAt: '2099-01-01T00:00:00Z',
    platformEntitlements: managed.platforms.map((platform, index) => ({ platform, maxRequests: 10 + index, windowSeconds: 60, maxPageSize: 5 })),
    capabilityEntitlements: managed.capabilities.map(capability => ({ capability, maxRequests: 10, windowSeconds: 60 })),
  })
  const before = await store.listApiKeyPlatformEntitlements(key.id)
  assert.ok(before.some(row => row.platform === 'weixin') && before.some(row => row.platform === 'wechat_search'))
  const updated = await service.updateApiKeyScopes(key.id, {
    platforms: [...key.platforms, PLATFORM], capabilities: [...key.capabilities, SEARCH_CAPABILITY], expected: snapshot(key),
  }, 'admin')
  assert.deepEqual(updated.capabilities, [...key.capabilities, SEARCH_CAPABILITY].sort())
  const after = await store.listApiKeyPlatformEntitlements(key.id)
  assert.ok(after.some(row => row.platform === PLATFORM))
  assert.deepEqual(after.filter(row => row.platform !== PLATFORM), before)
})
