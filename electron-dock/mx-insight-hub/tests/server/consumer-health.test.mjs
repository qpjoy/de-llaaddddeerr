// The shared-layer health view. Its whole reason to exist is that most reasons
// a call is refused belong to the consumer, not to the key that made the call:
// a blocked provider operation and a spent consumer window reject every key
// alike. These tests pin that the endpoint reports the shared facts, counts
// quota the way admission counts it, and is scoped to the consumer's tenant.

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const ADMIN_TOKEN = 'consumer-health-admin-token'
const PEPPER = 'consumer-health-test-pepper-at-least-32-bytes'

async function fixture({ externalPlatformCapabilities } = {}) {
  const store = new MemoryStore()
  const service = new HubService({
    store,
    adapter: {},
    apiKeyPepper: PEPPER,
    ...(externalPlatformCapabilities ? { externalPlatformCapabilities } : {}),
  })
  const tenant = await service.createTenant({ name: 'Health tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Health consumer' })
  return { store, service, tenant, consumer }
}

test('the shared view reports the consumer ceiling every key draws from', async () => {
  const { service, tenant, consumer } = await fixture()
  await service.putPlatformConfiguration('xiaohongshu', {
    tenantId: tenant.id,
    consumerId: consumer.id,
    enabled: true,
    maxRequests: 10,
    windowSeconds: 3_600,
    maxPageSize: 100,
  })

  const health = await service.getConsumerHealth(consumer.id)
  const scope = health.quota.find((entry) => entry.scope === 'xiaohongshu')
  assert.ok(scope, 'a granted platform appears in the shared view')
  assert.equal(scope.limitScope, 'consumer')
  assert.equal(scope.limit, 10)
  assert.equal(scope.remaining, 10)
})

test('the shared ceiling is shared: one key\'s traffic shows up against the other', async () => {
  const { store, service, tenant, consumer } = await fixture()
  await service.putPlatformConfiguration('xiaohongshu', {
    tenantId: tenant.id,
    consumerId: consumer.id,
    enabled: true,
    maxRequests: 10,
    windowSeconds: 3_600,
    maxPageSize: 100,
  })
  const first = await service.createApiKey({
    consumerId: consumer.id, name: 'First', platforms: ['xiaohongshu'], capabilities: [],
  })
  await service.createApiKey({
    consumerId: consumer.id, name: 'Second', platforms: ['xiaohongshu'], capabilities: [],
  })

  const context = await service.authenticate(first.secret)
  await store.reserve({
    requestId: randomUUID(),
    tenantId: context.tenant.id,
    consumerId: context.consumer.id,
    apiKeyId: context.apiKey.id,
    idempotencyKey: randomUUID(),
    fingerprint: '1'.repeat(64),
    platform: 'xiaohongshu',
    unitsReserved: 1,
    requiredAuthorizationScopes: [{ type: 'platform', key: 'xiaohongshu' }],
    leaseExpiresAt: new Date(Date.now() + 120_000),
  })

  // The second key made no calls at all, yet has one fewer call available.
  // This is precisely the fact a per-key view cannot show.
  const health = await service.getConsumerHealth(consumer.id)
  const scope = health.quota.find((entry) => entry.scope === 'xiaohongshu')
  assert.equal(scope.used, 1)
  assert.equal(scope.remaining, 9)
  assert.equal(health.keys.total, 2)
  assert.equal(health.keys.active, 2)
})

test('a blocked provider operation is reported only when this consumer is granted it', async () => {
  const blocked = {
    operations: {
      'ecommerce.products.search': { ready: false, effectiveState: 'blocked' },
      'social.accounts.search': { ready: false, effectiveState: 'blocked' },
    },
  }
  const { service, tenant, consumer } = await fixture({
    externalPlatformCapabilities: async () => blocked,
  })
  await service.putCapabilityConfiguration('ecommerce.products.search', {
    tenantId: tenant.id,
    consumerId: consumer.id,
    enabled: true,
    maxRequests: 100,
    windowSeconds: 60,
  })

  const health = await service.getConsumerHealth(consumer.id)
  assert.deepEqual(
    health.blockedOperations.map((entry) => entry.operation),
    ['ecommerce.products.search'],
    'an operation this consumer cannot call is an operator concern, not theirs',
  )
  assert.equal(health.blockedOperations[0].effectiveState, 'blocked')
})

test('a provider that cannot answer degrades the operation rows, not the whole view', async () => {
  const { service, tenant, consumer } = await fixture({
    externalPlatformCapabilities: async () => { throw new Error('provider unreachable') },
  })
  await service.putPlatformConfiguration('xiaohongshu', {
    tenantId: tenant.id,
    consumerId: consumer.id,
    enabled: true,
    maxRequests: 10,
    windowSeconds: 3_600,
    maxPageSize: 100,
  })

  const health = await service.getConsumerHealth(consumer.id)
  assert.deepEqual(health.blockedOperations, [])
  assert.ok(health.quota.some((entry) => entry.scope === 'xiaohongshu'), 'quota still renders')
})

test('expiring keys are counted, so rotation starts before the key stops working', async () => {
  const { service, tenant, consumer } = await fixture()
  await service.putPlatformConfiguration('xiaohongshu', {
    tenantId: tenant.id, consumerId: consumer.id, enabled: true,
    maxRequests: 10, windowSeconds: 3_600, maxPageSize: 100,
  })
  await service.createApiKey({
    consumerId: consumer.id, name: 'Soon', platforms: ['xiaohongshu'], capabilities: [], expiresInDays: 3,
  })
  await service.createApiKey({
    consumerId: consumer.id, name: 'Later', platforms: ['xiaohongshu'], capabilities: [], expiresInDays: 180,
  })

  const health = await service.getConsumerHealth(consumer.id)
  assert.equal(health.keys.total, 2)
  assert.equal(health.keys.expiringSoon, 1)
  assert.equal(health.keys.unusable, 0)
})

test('the health route is scoped to the consumer\'s tenant', async (t) => {
  const { store, service, consumer } = await fixture()
  const identity = {
    enabled: true,
    async resolve(token) {
      if (token === 'platform-admin') {
        return {
          kind: 'launcher-user',
          memberId: 'member-admin',
          displayName: 'Platform admin',
          platformAdmin: true,
          tenantIds: null,
          capabilities: [],
          memberships: [],
        }
      }
      if (token === 'other-tenant-user') {
        return {
          kind: 'launcher-user',
          memberId: 'member-other',
          displayName: 'Other tenant user',
          platformAdmin: false,
          tenantIds: [],
          capabilities: [],
          memberships: [],
        }
      }
      return null
    },
  }
  const app = createApp({
    service, store, adapter: {}, identity, adminToken: ADMIN_TOKEN, logger: { error() {} },
  })
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const call = (token) => fetch(
    `${baseUrl}/internal/v1/admin/consumers/${consumer.id}/health`,
    { headers: { authorization: `Bearer ${token}` } },
  )

  const denied = await call('other-tenant-user')
  assert.equal(denied.status, 403)

  const allowed = await call('platform-admin')
  assert.equal(allowed.status, 200)
  const payload = await allowed.json()
  assert.equal(payload.data.consumer.id, consumer.id)
  assert.ok(Array.isArray(payload.data.quota))
  assert.ok(Array.isArray(payload.data.blockedOperations))
})

test('an unknown consumer is a 404, not an empty health view', async () => {
  const { service } = await fixture()
  await assert.rejects(
    () => service.getConsumerHealth(randomUUID()),
    (error) => error?.status === 404 && error?.code === 'consumer_not_found',
  )
})
