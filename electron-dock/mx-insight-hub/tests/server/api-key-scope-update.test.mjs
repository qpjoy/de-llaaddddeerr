import test from 'node:test'
import assert from 'node:assert/strict'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { productAllowed } from '../../shared/product-access.mjs'
async function setup() {
 const store = new MemoryStore()
 const service = new HubService({ store, adapter: {}, apiKeyPepper: 'test-pepper-with-enough-characters-for-scope-update' })
 const tenant = await service.createTenant({ name: 'Historical tenant' })
 const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Historical consumer' })
 await store.replaceGrants(consumer.id, ['xiaohongshu', 'source_catalog'])
 const key = await service.createApiKey({ consumerId: consumer.id, name: 'Original key', platforms: ['xiaohongshu'], capabilities: [] })
 return { store, service, key, consumer }
}
const snapshot = key => ({ scopeMode: key.scopeMode, platforms: key.platforms, capabilities: key.capabilities })
test('explicit scopes update keeps original secret, expiry, quotas and identity, with audited changes', async () => {
 const { store, service, key } = await setup()
 const prior = await store.listApiKeyPlatformEntitlements(key.id)
 await service.updateApiKeyScopes(key.id, { platforms: ['xiaohongshu', 'source_catalog'], capabilities: [], expected: snapshot(key) }, 'member-test')
 const authenticated = await service.authenticate(key.secret)
 assert.equal(authenticated.apiKey.id, key.id)
 assert.equal(authenticated.apiKey.expiresAt, key.expiresAt)
 assert.deepEqual((await store.listApiKeyPlatformEntitlements(key.id)).find(item => item.platform === 'xiaohongshu'), prior[0])
 assert.ok((await store.listApiKeys())[0].platforms.includes('source_catalog'))
 assert.equal(store.apiKeyScopeEvents.length, 1)
 assert.ok(!JSON.stringify(store.apiKeyScopeEvents).includes(key.secret))
 await assert.rejects(service.updateApiKeyScopes(key.id, { platforms: [], capabilities: [], expected: snapshot(key) }, 'member-test'), { code: 'api_key_scopes_changed' })
})
test('scopes cannot exceed consumer grants and revoked keys cannot be updated', async () => {
 const { service, key } = await setup()
 await assert.rejects(service.updateApiKeyScopes(key.id, { platforms: ['ecommerce'], capabilities: [], expected: snapshot(key) }, 'member-test'), { code: 'api_key_scope_not_granted' })
 await service.revokeApiKey(key.id)
 await assert.rejects(service.updateApiKeyScopes(key.id, { platforms: ['source_catalog'], capabilities: [], expected: snapshot(key) }, 'member-test'), { code: 'api_key_unavailable' })
})
test('product menu uses consumer grants regardless of legacy key or binding dates', () => {
 assert.ok(productAllowed('/source-catalog', [{ platforms: ['source_catalog'], capabilities: [] }]))
 assert.ok(!productAllowed('/source-catalog', [{ platforms: ['xiaohongshu'], capabilities: [] }]))
 assert.ok(!productAllowed('/data-products/xiaohongshu-note', [{ platforms: ['xiaohongshu'], capabilities: [] }, { platforms: [], capabilities: ['social.posts.search'] }]))
 assert.ok(!productAllowed('/source-catalog'))
})
