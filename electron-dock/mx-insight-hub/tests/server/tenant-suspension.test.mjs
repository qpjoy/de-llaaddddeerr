// Suspending a tenant is the reversible way to stop it calling.
//
// The only thing that makes this feature worth having is that it actually
// stops traffic. A console that says "已停用" while keys keep spending money
// upstream would be worse than having no button at all -- so the first and
// most important test drives real authentication, not the status field.

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const ADMIN_TOKEN = 'tenant-suspension-admin-token'
const PEPPER = 'tenant-suspension-test-pepper-at-least-32-bytes'

async function fixture() {
  const store = new MemoryStore()
  const service = new HubService({ store, adapter: {}, apiKeyPepper: PEPPER })
  const tenant = await service.createTenant({ name: 'Suspendable tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Consumer' })
  await service.putPlatformConfiguration('xiaohongshu', {
    tenantId: tenant.id, consumerId: consumer.id, enabled: true,
    maxRequests: 100, windowSeconds: 3_600, maxPageSize: 100,
  })
  const issued = await service.createApiKey({
    consumerId: consumer.id, name: 'Key', platforms: ['xiaohongshu'], capabilities: [],
  })
  return { store, service, tenant, consumer, issued }
}

test('suspending a tenant stops every key under it, and resuming restores them', async () => {
  const { service, tenant, issued } = await fixture()

  // Works before.
  const before = await service.authenticate(issued.secret)
  assert.equal(before.tenant.id, tenant.id)

  const suspended = await service.setTenantStatus(tenant.id, { status: 'suspended' })
  assert.equal(suspended.status, 'suspended')

  // The whole point: the key is untouched and still "active", yet cannot call.
  // And it says why -- "invalid, expired, or revoked" would be three wrong
  // statements that send the caller to rotate a key that is fine.
  await assert.rejects(
    () => service.authenticate(issued.secret),
    (error) => error?.status === 403 && error?.code === 'tenant_suspended',
    'a suspended tenant admits no traffic, and the refusal explains itself',
  )
  const key = (await service.listApiKeys()).find((candidate) => candidate.id === issued.id)
  assert.equal(key.status, 'active', 'suspension does not revoke keys, so it can be undone')

  const resumed = await service.setTenantStatus(tenant.id, { status: 'active' })
  assert.equal(resumed.status, 'active')
  const after = await service.authenticate(issued.secret)
  assert.equal(after.apiKey.id, issued.id, 'the same key works again, unchanged')
})

test('suspension destroys nothing: consumers, keys and grants survive it', async () => {
  const { service, store, tenant, consumer, issued } = await fixture()
  await service.setTenantStatus(tenant.id, { status: 'suspended' })

  assert.equal((await service.listConsumers(tenant.id)).length, 1)
  assert.equal((await service.listApiKeys(consumer.id)).length, 1)
  assert.deepEqual(await store.listGrants(consumer.id), ['xiaohongshu'])
  // Reversibility is the entire difference between this and a delete.
  await service.setTenantStatus(tenant.id, { status: 'active' })
  assert.ok(await service.authenticate(issued.secret))
})

test('an unknown status is refused rather than written to the database', async () => {
  const { service, tenant } = await fixture()
  for (const status of ['deleted', 'disabled', '', null, 'ACTIVE']) {
    await assert.rejects(
      () => service.setTenantStatus(tenant.id, { status }),
      (error) => error?.status === 400,
      `${JSON.stringify(status)} is not a tenant status`,
    )
  }
  assert.equal((await service.listTenants()).find((t) => t.id === tenant.id).status, 'active')
})

test('suspending an unknown tenant is a 404', async () => {
  const { service } = await fixture()
  await assert.rejects(
    () => service.setTenantStatus(randomUUID(), { status: 'suspended' }),
    (error) => error?.status === 404 && error?.code === 'tenant_not_found',
  )
})

test('the status route requires tenant.write in that tenant', async (t) => {
  const { store, service, tenant } = await fixture()
  const identity = {
    enabled: true,
    async resolve(token) {
      if (token === 'owner') {
        return {
          kind: 'launcher-user',
          memberId: 'member-owner',
          displayName: 'Owner',
          platformAdmin: false,
          tenantIds: [tenant.id],
          capabilities: ['tenant.write'],
          memberships: [{ tenantId: tenant.id, role: 'owner', status: 'active', capabilities: ['tenant.write'] }],
        }
      }
      if (token === 'analyst') {
        return {
          kind: 'launcher-user',
          memberId: 'member-analyst',
          displayName: 'Analyst',
          platformAdmin: false,
          tenantIds: [tenant.id],
          capabilities: ['usage.read'],
          memberships: [{ tenantId: tenant.id, role: 'analyst', status: 'active', capabilities: ['usage.read'] }],
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
  const call = (token, status) => fetch(`${baseUrl}/internal/v1/admin/tenants/${tenant.id}/status`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  })

  // Reading usage is not the same as being able to stop the account.
  assert.equal((await call('analyst', 'suspended')).status, 403)
  assert.equal((await service.listTenants())[0].status, 'active')

  assert.equal((await call('owner', 'suspended')).status, 200)
  assert.equal((await service.listTenants())[0].status, 'suspended')

  const resumed = await call(ADMIN_TOKEN, 'active')
  assert.equal(resumed.status, 200)
  assert.equal((await resumed.json()).data.status, 'active')
})

test('a genuinely bad key is still refused as a bad key', async () => {
  const { service, tenant } = await fixture()
  await service.setTenantStatus(tenant.id, { status: 'suspended' })

  // The suspension explanation must not become a blanket answer: an unknown
  // secret reveals nothing about which tenants exist or what state they are in.
  await assert.rejects(
    () => service.authenticate('mih_live_deadbeef_not-a-real-secret'),
    (error) => error?.status === 401 && error?.code === 'invalid_api_key',
  )
  await assert.rejects(
    () => service.authenticate(''),
    (error) => error?.status === 401 && error?.code === 'api_key_required',
  )
})

test('a revoked key under a suspended tenant is still reported as revoked', async () => {
  const { service, tenant, issued } = await fixture()
  await service.revokeApiKey(issued.id)
  await service.setTenantStatus(tenant.id, { status: 'suspended' })

  // Suspension explains only keys that would otherwise have worked. A revoked
  // key is a credential problem and must not be re-labelled as a tenant one.
  await assert.rejects(
    () => service.authenticate(issued.secret),
    (error) => error?.status === 401 && error?.code === 'invalid_api_key',
  )
})

test('an older store without the explanation still refuses, just less precisely', async () => {
  const { service, store, tenant, issued } = await fixture()
  await service.setTenantStatus(tenant.id, { status: 'suspended' })
  // The explanation is optional, so a store predating it must keep working
  // rather than crash on a missing method.
  store.explainApiKeyRejection = undefined

  await assert.rejects(
    () => service.authenticate(issued.secret),
    (error) => error?.status === 401 && error?.code === 'invalid_api_key',
  )
})
