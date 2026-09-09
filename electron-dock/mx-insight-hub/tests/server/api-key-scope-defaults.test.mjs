import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { issueApiKey } from '../../server/core/crypto.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const PEPPER = 'api-key-scope-default-test-pepper-with-enough-entropy'
const APP_V2_CAPABILITIES = [
  'compat.xiaohongshu.app_v2',
  'social.posts.resolve',
  'social.posts.search',
  'social.users.resolve',
  'social.users.posts',
]

async function fixture() {
  const store = new MemoryStore()
  const service = new HubService({ store, adapter: {}, apiKeyPepper: PEPPER })
  const tenant = await service.createTenant({ name: 'Scope-default tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Scope-default consumer' })
  await service.putPlatformConfiguration('xiaohongshu', {
    tenantId: tenant.id,
    consumerId: consumer.id,
    enabled: true,
  })
  for (const capability of APP_V2_CAPABILITIES) {
    await service.putCapabilityConfiguration(capability, {
      tenantId: tenant.id,
      consumerId: consumer.id,
      enabled: true,
    })
  }
  return { store, service, tenant, consumer }
}

test('new snapshot API keys default to zero scope and accept explicit empty scope', async () => {
  const { store, service, consumer } = await fixture()

  const defaultKey = await service.createApiKey({ consumerId: consumer.id, name: 'Default closed key' })
  assert.equal(defaultKey.scopeMode, 'snapshot')
  assert.deepEqual(defaultKey.platforms, [])
  assert.deepEqual(defaultKey.capabilities, [])
  assert.deepEqual(await store.listEffectiveGrants(consumer.id, defaultKey.id), [])
  assert.deepEqual(await store.listEffectiveCapabilityGrants(consumer.id, defaultKey.id), [])

  const explicitEmptyKey = await service.createApiKey({
    consumerId: consumer.id,
    name: 'Explicitly empty key',
    platforms: [],
    capabilities: [],
  })
  assert.equal(explicitEmptyKey.scopeMode, 'snapshot')
  assert.deepEqual(explicitEmptyKey.platforms, [])
  assert.deepEqual(explicitEmptyKey.capabilities, [])
})

test('legacy_all preserves the former selection behavior without creating a dynamic key', async () => {
  const { service, consumer } = await fixture()

  const key = await service.createApiKey({
    consumerId: consumer.id,
    name: 'Explicit legacy selection',
    scopePreset: 'legacy_all',
  })
  assert.equal(key.scopeMode, 'snapshot')
  assert.deepEqual(key.platforms, ['xiaohongshu'])
  assert.deepEqual(key.capabilities, ['nlp.tokenize', ...APP_V2_CAPABILITIES].sort())

  await assert.rejects(
    service.createApiKey({
      consumerId: consumer.id,
      name: 'Ambiguous legacy selection',
      scopePreset: 'legacy_all',
      platforms: [],
    }),
    (error) => error?.status === 400 && error?.code === 'invalid_request',
  )
  await assert.rejects(
    service.createApiKey({
      consumerId: consumer.id,
      name: 'Unknown preset',
      scopePreset: 'everything',
    }),
    (error) => error?.status === 400 && error?.code === 'invalid_request',
  )
})

test('grandfathered legacy_dynamic keys continue to follow consumer grants', async () => {
  const { store, consumer, tenant } = await fixture()
  const issued = issueApiKey(PEPPER)
  const legacyKey = await store.createApiKey({
    ...issued,
    tenantId: tenant.id,
    consumerId: consumer.id,
    name: 'Grandfathered dynamic key',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  })

  assert.equal(legacyKey.scopeMode, 'legacy_dynamic')
  assert.deepEqual(await store.listEffectiveGrants(consumer.id, legacyKey.id), ['xiaohongshu'])
  assert.deepEqual(
    await store.listEffectiveCapabilityGrants(consumer.id, legacyKey.id),
    ['nlp.tokenize', ...APP_V2_CAPABILITIES].sort(),
  )
})

test('migration 062 grandfathers paid operation scopes into existing consumer and snapshot-key grants', async () => {
  const migration = await readFile(fileURLToPath(new URL(
    '../../migrations/062_xiaohongshu_app_v2_capability_grandfather.sql',
    import.meta.url,
  )), 'utf8')

  for (const [platform, capability] of [
    ['xiaohongshu', 'compat.xiaohongshu.app_v2'],
    ['xiaohongshu', 'social.posts.search'],
    ['xiaohongshu', 'social.users.resolve'],
    ['xiaohongshu', 'social.users.posts'],
    ['ecommerce', 'ecommerce.products.search'],
  ]) {
    assert.ok(migration.includes(`('${platform}', '${capability}')`))
  }
  assert.match(migration, /INSERT INTO capability_grants/u)
  assert.match(migration, /INSERT INTO consumer_capability_policies/u)
  assert.match(migration, /INSERT INTO api_key_capability_entitlements[\s\S]*?scope_mode = 'snapshot'/u)
  assert.match(migration, /capability_mapping\.platform = platform_entitlement\.platform/u)
  assert.match(
    migration,
    /capability_policy\.max_requests,[\s\S]*?capability_policy\.window_seconds[\s\S]*?JOIN consumer_capability_policies capability_policy/u,
  )
  assert.doesNotMatch(
    migration,
    /SELECT api_key_record\.id,[\s\S]*?platform_entitlement\.max_requests,[\s\S]*?platform_entitlement\.window_seconds/u,
  )
  assert.match(migration, /SET LOCAL lock_timeout = '5s'/u)
  assert.match(migration, /SET LOCAL statement_timeout = '2min'/u)
  assert.doesNotMatch(migration, /LOCK TABLE/u)
})
