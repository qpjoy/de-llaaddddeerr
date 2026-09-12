// What a tenant sees after signing in.
//
// The operator console answers "which of all tenants is in trouble". A tenant
// asks a narrower question -- "can my integration call right now" -- and the
// answer must be assembled from their own memberships, never from a tenant id
// the caller supplies. These tests pin that boundary first, because getting it
// wrong turns a self-service page into cross-tenant disclosure.

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { capabilitiesForRole } from '../../server/identity/index.mjs'

const ADMIN_TOKEN = 'tenant-overview-admin-token'
const PEPPER = 'tenant-overview-test-pepper-at-least-32-bytes'

async function fixture({ externalPlatformCapabilities } = {}) {
  const store = new MemoryStore()
  const service = new HubService({
    store,
    adapter: {},
    apiKeyPepper: PEPPER,
    ...(externalPlatformCapabilities ? { externalPlatformCapabilities } : {}),
  })
  // Two tenants, so "my tenants" is a real filter rather than "everything".
  const mine = await service.createTenant({ name: '我的租户' })
  const theirs = await service.createTenant({ name: '别人的租户' })
  const myConsumer = await service.createConsumer({ tenantId: mine.id, name: '我的调用者' })
  const theirConsumer = await service.createConsumer({ tenantId: theirs.id, name: '别人的调用者' })
  for (const [tenantId, consumerId] of [[mine.id, myConsumer.id], [theirs.id, theirConsumer.id]]) {
    await service.putPlatformConfiguration('xiaohongshu', {
      tenantId, consumerId, enabled: true, maxRequests: 20, windowSeconds: 3_600, maxPageSize: 100,
    })
  }
  return { store, service, mine, theirs, myConsumer, theirConsumer }
}

function identityFor(tenantId, { role = 'analyst' } = {}) {
  return {
    enabled: true,
    async resolve(token) {
      if (token === 'tenant-user') {
        return {
          kind: 'launcher-user',
          memberId: 'member-tenant-user',
          displayName: 'Tenant user',
          platformAdmin: false,
          tenantIds: [tenantId],
          capabilities: [...capabilitiesForRole(role)],
          memberships: [{
            id: randomUUID(),
            memberId: 'member-tenant-user',
            tenantId,
            role,
            status: 'active',
            capabilities: [...capabilitiesForRole(role)],
          }],
        }
      }
      if (token === 'stranger') {
        return {
          kind: 'launcher-user',
          memberId: 'member-stranger',
          displayName: 'Stranger',
          platformAdmin: false,
          tenantIds: [],
          capabilities: [],
          memberships: [],
        }
      }
      return null
    },
  }
}

async function serve(t, { store, service, identity }) {
  const app = createApp({
    service, store, adapter: {}, identity, adminToken: ADMIN_TOKEN, logger: { error() {} },
  })
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  return (token, search = '') => fetch(`${baseUrl}/internal/v1/admin/me/overview${search}`, {
    headers: { authorization: `Bearer ${token}` },
  })
}

test('a tenant sees their own tenant, assembled from their membership', async (t) => {
  const { store, service, mine } = await fixture()
  const call = await serve(t, { store, service, identity: identityFor(mine.id) })

  const response = await call('tenant-user')
  assert.equal(response.status, 200)
  const { data } = await response.json()
  assert.equal(data.tenants.length, 1)
  assert.equal(data.tenants[0].id, mine.id)
  assert.equal(data.tenants[0].name, '我的租户')
  assert.equal(data.tenants[0].consumers.length, 1)
  assert.equal(data.tenants[0].consumers[0].consumer.name, '我的调用者')
})

test('naming another tenant is refused rather than quietly widening the view', async (t) => {
  const { store, service, mine, theirs } = await fixture()
  const call = await serve(t, { store, service, identity: identityFor(mine.id) })

  const response = await call('tenant-user', `?tenantId=${theirs.id}`)
  assert.equal(response.status, 403)
  const payload = await response.json()
  // Refused by the tenant filter, before any capability is even consulted: the
  // principal has no standing in that tenant at all.
  assert.equal(payload.error.code, 'tenant_not_permitted')
})

test('a member with no memberships gets an empty view, not everyone else\'s', async (t) => {
  const { store, service, mine } = await fixture()
  const call = await serve(t, { store, service, identity: identityFor(mine.id) })

  // 'stranger' authenticates successfully but holds nothing. The correct,
  // boring outcome is an empty answer -- never a fallback to unscoped data, and
  // never a 403, because "you are signed in and hold no access yet" is exactly
  // what a newly invited member needs to be told.
  const response = await call('stranger')
  assert.equal(response.status, 200)
  const { data } = await response.json()
  assert.deepEqual(data.tenants, [])
})

test('a membership without usage.read does not pull its tenant into the view', async (t) => {
  const { store, service, mine } = await fixture()
  // A role that cannot read usage must not have its tenant assembled here just
  // because the membership exists.
  const identity = {
    enabled: true,
    async resolve(token) {
      if (token !== 'tenant-user') return null
      return {
        kind: 'launcher-user',
        memberId: 'member-tenant-user',
        displayName: 'Capability-less member',
        platformAdmin: false,
        tenantIds: [mine.id],
        capabilities: [],
        memberships: [{
          id: randomUUID(),
          memberId: 'member-tenant-user',
          tenantId: mine.id,
          role: 'custom',
          status: 'active',
          capabilities: ['consumer.read'],
        }],
      }
    },
  }
  const call = await serve(t, { store, service, identity })

  const response = await call('tenant-user')
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).data.tenants, [])
})

test('the break-glass admin token holds no memberships, so it sees nothing here', async (t) => {
  const { store, service, mine } = await fixture()
  const call = await serve(t, { store, service, identity: identityFor(mine.id) })

  const response = await call(ADMIN_TOKEN)
  assert.equal(response.status, 200)
  const { data } = await response.json()
  // Not a bug: the admin token is unscoped precisely because it belongs to no
  // tenant. It reads the operator console, or names a tenant explicitly.
  assert.deepEqual(data.tenants, [])
})

test('the admin token may still name a tenant explicitly', async (t) => {
  const { store, service, mine } = await fixture()
  const call = await serve(t, { store, service, identity: identityFor(mine.id) })

  const response = await call(ADMIN_TOKEN, `?tenantId=${mine.id}`)
  assert.equal(response.status, 200)
  const { data } = await response.json()
  assert.equal(data.tenants.length, 1)
  assert.equal(data.tenants[0].id, mine.id)
})

test('the tenant view reports the same blockers the operator view reports', async (t) => {
  const blocked = {
    operations: { 'ecommerce.products.search': { ready: false, effectiveState: 'blocked' } },
  }
  const { store, service, mine, myConsumer } = await fixture({
    externalPlatformCapabilities: async () => blocked,
  })
  await service.putCapabilityConfiguration('ecommerce.products.search', {
    tenantId: mine.id, consumerId: myConsumer.id, enabled: true, maxRequests: 20, windowSeconds: 60,
  })
  const call = await serve(t, { store, service, identity: identityFor(mine.id) })

  const { data } = await (await call('tenant-user')).json()
  const consumer = data.tenants[0].consumers[0]
  assert.deepEqual(
    consumer.blockedOperations.map((entry) => entry.operation),
    ['ecommerce.products.search'],
  )
  // Same shape the operator console reads, so the two can never disagree.
  const direct = await service.getConsumerHealth(myConsumer.id)
  assert.deepEqual(consumer.blockedOperations, direct.blockedOperations)
  assert.deepEqual(consumer.quota, direct.quota)
})

test('unsupported query fields are rejected rather than silently ignored', async (t) => {
  const { store, service, mine } = await fixture()
  const call = await serve(t, { store, service, identity: identityFor(mine.id) })

  const response = await call('tenant-user', '?tenantId=' + mine.id + '&range=24h')
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, 'unsupported_fields')
})

test('a viewer may read their own access without holding apikey.read', async (t) => {
  const { store, service, mine } = await fixture()
  const call = await serve(t, { store, service, identity: identityFor(mine.id, { role: 'viewer' }) })

  const response = await call('tenant-user')
  assert.equal(response.status, 200)
  const { data } = await response.json()
  // Counts and ceilings, never key material -- which is why usage.read is the
  // right gate here and apikey.read is not required.
  const consumer = data.tenants[0].consumers[0]
  assert.deepEqual(Object.keys(consumer.keys).sort(), ['active', 'expiringSoon', 'total', 'unusable'])
})
