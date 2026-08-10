import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, beforeEach, test } from 'node:test'
import { NightAllAdapter } from '../../server/adapters/night-all.mjs'
import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { IdentityService, LauncherIdentityClient, scopeTenantFilter } from '../../server/identity/index.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const ADMIN_TOKEN = 'test-admin-token-with-enough-length'
const PEPPER = 'test-pepper-with-enough-entropy'
const AUDIENCE = 'mx-insight-hub'

let baseUrl
let server
let store
let identity
let launcherState

// One place to describe what Launcher would answer. Every test rewrites this
// rather than stubbing the Hub's own code, so the tests exercise the real
// introspection parsing and the real scoping path.
function launcherResponse({ active = true, kind = 'user', subject, scopes = [], displayName }) {
  return {
    introspection: {
      active,
      issuer: 'mx-user-center:internal',
      audience: AUDIENCE,
      subject,
      scopes,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      principal: {
        principalId: subject,
        kind,
        tenantId: 'launcher-tenant',
        orgIds: ['org_default'],
        displayName: displayName || subject,
        userId: subject,
        roles: [],
        scopes,
      },
    },
  }
}

before(async () => {
  store = new MemoryStore()

  const launcherFetch = async () => {
    if (launcherState.unavailable) throw new Error('ECONNREFUSED')
    return new Response(JSON.stringify(launcherState.payload), {
      status: launcherState.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  identity = new IdentityService({
    store,
    client: new LauncherIdentityClient({
      baseUrl: 'http://launcher.invalid',
      audience: AUDIENCE,
      // No caching in tests: a cached positive result would mask the very
      // revocation and scope-change behaviour these tests assert.
      cacheTtlMs: 0,
      fetchImpl: launcherFetch,
      logger: { warn() {} },
    }),
    adminScopes: ['insight-hub.admin'],
    logger: { warn() {} },
  })

  const service = new HubService({
    store,
    adapter: new NightAllAdapter({ baseUrl: 'http://night-all.invalid', fetchImpl: async () => {
      throw new Error('not used')
    } }),
    apiKeyPepper: PEPPER,
  })

  const app = createApp({ service, store, adapter: { dependencies: async () => ({ status: 'up' }) }, identity, adminToken: ADMIN_TOKEN })
  server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
})

beforeEach(() => {
  launcherState = { payload: launcherResponse({ subject: 'user-1' }) }
})

function callAdmin(path, { token = ADMIN_TOKEN, method = 'GET', body } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

// ---------------------------------------------------------------------------
// The admin token is unchanged
// ---------------------------------------------------------------------------

test('the admin token still has unscoped access', async () => {
  const response = await callAdmin('/internal/v1/admin/session')
  assert.equal(response.status, 200)
  const { data } = await response.json()
  assert.equal(data.kind, 'admin-token')
  assert.equal(data.scoped, false)
  assert.equal(data.tenantIds, null)
})

test('the admin token works while Launcher is unreachable', async () => {
  launcherState = { unavailable: true }
  // This is the break-glass property: an identity-provider outage must not lock
  // operators out of the Hub console.
  const response = await callAdmin('/internal/v1/admin/tenants')
  assert.equal(response.status, 200)
})

test('the admin token manages multiple tenants and assigns consumers explicitly', async () => {
  const tenantA = await (await callAdmin('/internal/v1/admin/tenants', {
    method: 'POST', body: { name: 'Admin Tenant A' },
  })).json()
  const tenantB = await (await callAdmin('/internal/v1/admin/tenants', {
    method: 'POST', body: { name: 'Admin Tenant B' },
  })).json()

  const renamed = await callAdmin(`/internal/v1/admin/tenants/${tenantB.data.id}`, {
    method: 'PUT', body: { name: 'Admin Tenant B Renamed' },
  })
  assert.equal(renamed.status, 200)
  assert.equal((await renamed.json()).data.name, 'Admin Tenant B Renamed')

  const tenants = await (await callAdmin('/internal/v1/admin/tenants')).json()
  assert.equal(tenants.data.some((tenant) => tenant.id === tenantA.data.id), true)
  assert.equal(tenants.data.some((tenant) => tenant.id === tenantB.data.id && tenant.name === 'Admin Tenant B Renamed'), true)

  const consumerA = await (await callAdmin('/internal/v1/admin/consumers', {
    method: 'POST', body: { tenantId: tenantA.data.id, name: 'Consumer A' },
  })).json()
  const consumerB = await (await callAdmin('/internal/v1/admin/consumers', {
    method: 'POST', body: { tenantId: tenantB.data.id, name: 'Consumer B' },
  })).json()
  assert.equal(consumerA.data.tenantId, tenantA.data.id)
  assert.equal(consumerB.data.tenantId, tenantB.data.id)

  const missingTenant = await callAdmin('/internal/v1/admin/consumers', {
    method: 'POST', body: { name: 'Unscoped Consumer' },
  })
  assert.equal(missingTenant.status, 400)
  assert.equal((await missingTenant.json()).error.code, 'invalid_request')
})

test('an unknown credential is rejected when Launcher is unreachable', async () => {
  launcherState = { unavailable: true }
  const response = await callAdmin('/internal/v1/admin/tenants', { token: 'mx-v1-something' })
  // 503, not 401: the token may be perfectly valid and we simply cannot tell.
  // Answering 401 would send a legitimate user to re-authenticate against a
  // service that is down.
  assert.equal(response.status, 503)
  const { error } = await response.json()
  assert.equal(error.code, 'launcher_unavailable')
})

// ---------------------------------------------------------------------------
// Just-in-time provisioning grants identity, never entitlement
// ---------------------------------------------------------------------------

test('a first-time user signs in but receives no tenant access', async () => {
  launcherState = { payload: launcherResponse({ subject: 'newcomer', displayName: 'New Comer' }) }
  const session = await callAdmin('/internal/v1/admin/session', { token: 'mx-v1-newcomer' })
  assert.equal(session.status, 200)
  const { data } = await session.json()
  assert.equal(data.kind, 'launcher-user')
  assert.equal(data.displayName, 'New Comer')
  assert.equal(data.platformAdmin, false)
  assert.deepEqual(data.tenantIds, [])
  assert.deepEqual(data.capabilities, [])

  // Authentication succeeded; authorization did not follow automatically.
  const consumers = await callAdmin('/internal/v1/admin/consumers', { token: 'mx-v1-newcomer' })
  assert.equal(consumers.status, 403)
})

test('an inactive token is rejected', async () => {
  launcherState = { payload: launcherResponse({ subject: 'user-1', active: false }) }
  const response = await callAdmin('/internal/v1/admin/session', { token: 'mx-v1-expired' })
  assert.equal(response.status, 401)
})

test('a service-account principal cannot sign in to the console', async () => {
  launcherState = { payload: launcherResponse({ subject: 'svc-1', kind: 'service-account' }) }
  const response = await callAdmin('/internal/v1/admin/session', { token: 'mx-v1-service' })
  // Machine credentials must not inherit a person's console scope; Hub API
  // consumers use Hub-issued API keys instead.
  assert.equal(response.status, 403)
  const { error } = await response.json()
  assert.equal(error.code, 'principal_kind_not_allowed')
})

test('a token minted for another audience is rejected', async () => {
  const payload = launcherResponse({ subject: 'user-1' })
  payload.introspection.audience = 'some-other-product'
  launcherState = { payload }
  const response = await callAdmin('/internal/v1/admin/session', { token: 'mx-v1-wrong-audience' })
  assert.equal(response.status, 401)
})

// ---------------------------------------------------------------------------
// Tenant scoping
// ---------------------------------------------------------------------------

test('a member sees only the tenant they were granted', async () => {
  const tenantA = await (await callAdmin('/internal/v1/admin/tenants', {
    method: 'POST', body: { name: 'Tenant A' },
  })).json()
  const tenantB = await (await callAdmin('/internal/v1/admin/tenants', {
    method: 'POST', body: { name: 'Tenant B' },
  })).json()

  launcherState = { payload: launcherResponse({ subject: 'scoped-user' }) }
  const session = await (await callAdmin('/internal/v1/admin/session', { token: 'mx-v1-scoped' })).json()

  const grant = await callAdmin('/internal/v1/admin/members/memberships', {
    method: 'POST',
    body: { memberId: session.data.memberId ?? (await firstMemberId()), tenantId: tenantA.data.id, role: 'admin' },
  })
  assert.equal(grant.status, 201)

  const scopedSession = await (await callAdmin('/internal/v1/admin/session', { token: 'mx-v1-scoped' })).json()
  assert.deepEqual(scopedSession.data.tenantIds, [tenantA.data.id])

  const tenants = await (await callAdmin('/internal/v1/admin/tenants', { token: 'mx-v1-scoped' })).json()
  assert.equal(tenants.data.length, 1)
  assert.equal(tenants.data[0].id, tenantA.data.id)

  const renameDenied = await callAdmin(`/internal/v1/admin/tenants/${tenantA.data.id}`, {
    token: 'mx-v1-scoped',
    method: 'PUT',
    body: { name: 'Admin cannot rename' },
  })
  assert.equal(renameDenied.status, 403)
  assert.equal((await renameDenied.json()).error.code, 'insufficient_capability')

  // Asking for a tenant outside the grant is denied explicitly rather than
  // returned empty, so the response cannot be used to probe which ids exist.
  const denied = await callAdmin(
    `/internal/v1/admin/consumers?tenantId=${tenantB.data.id}`,
    { token: 'mx-v1-scoped' },
  )
  assert.equal(denied.status, 403)
  const { error } = await denied.json()
  assert.equal(error.code, 'tenant_not_permitted')
})

test('a tenant owner can rename only their tenant and cannot create another tenant', async () => {
  const tenantA = await (await callAdmin('/internal/v1/admin/tenants', {
    method: 'POST', body: { name: 'Owner Tenant' },
  })).json()
  const tenantB = await (await callAdmin('/internal/v1/admin/tenants', {
    method: 'POST', body: { name: 'Other Tenant' },
  })).json()
  launcherState = { payload: launcherResponse({ subject: 'tenant-owner' }) }
  const session = await (await callAdmin('/internal/v1/admin/session', { token: 'mx-v1-owner' })).json()
  const grant = await callAdmin('/internal/v1/admin/members/memberships', {
    method: 'POST',
    body: { memberId: session.data.memberId, tenantId: tenantA.data.id, role: 'owner' },
  })
  assert.equal(grant.status, 201)

  const renamed = await callAdmin(`/internal/v1/admin/tenants/${tenantA.data.id}`, {
    token: 'mx-v1-owner', method: 'PUT', body: { name: 'Owner Tenant Renamed' },
  })
  assert.equal(renamed.status, 200)

  const outside = await callAdmin(`/internal/v1/admin/tenants/${tenantB.data.id}`, {
    token: 'mx-v1-owner', method: 'PUT', body: { name: 'Not Allowed' },
  })
  assert.equal(outside.status, 403)
  assert.equal((await outside.json()).error.code, 'tenant_not_permitted')

  const create = await callAdmin('/internal/v1/admin/tenants', {
    token: 'mx-v1-owner', method: 'POST', body: { name: 'Sneaky Tenant' },
  })
  assert.equal(create.status, 403)
  assert.equal((await create.json()).error.code, 'platform_admin_required')

  for (const path of [
    '/internal/v1/ops/summary',
    '/internal/v1/admin/sources',
    '/internal/v1/admin/agent',
    '/internal/v1/admin/backfill',
    '/internal/v1/admin/members',
    '/internal/v1/admin/retrieval',
  ]) {
    const denied = await callAdmin(path, { token: 'mx-v1-owner' })
    assert.equal(denied.status, 403)
    assert.equal((await denied.json()).error.code, 'platform_admin_required')
  }
  const retrievalSearch = await callAdmin('/internal/v1/admin/retrieval/search', {
    token: 'mx-v1-owner', method: 'POST', body: { query: 'must stay platform scoped' },
  })
  assert.equal(retrievalSearch.status, 403)
  assert.equal((await retrievalSearch.json()).error.code, 'platform_admin_required')
})

test('tenant capabilities come from the role held in the target tenant', async () => {
  const tenantA = (await (await callAdmin('/internal/v1/admin/tenants', {
    method: 'POST', body: { name: 'Mixed Role Owner Tenant' },
  })).json()).data
  const tenantB = (await (await callAdmin('/internal/v1/admin/tenants', {
    method: 'POST', body: { name: 'Mixed Role Viewer Tenant' },
  })).json()).data
  const consumerA = (await (await callAdmin('/internal/v1/admin/consumers', {
    method: 'POST', body: { tenantId: tenantA.id, name: 'Owner Consumer' },
  })).json()).data
  const consumerB = (await (await callAdmin('/internal/v1/admin/consumers', {
    method: 'POST', body: { tenantId: tenantB.id, name: 'Viewer Consumer' },
  })).json()).data
  const keyA = (await (await callAdmin('/internal/v1/admin/api-keys', {
    method: 'POST', body: { consumerId: consumerA.id, name: 'Owner Key' },
  })).json()).data
  const keyB = (await (await callAdmin('/internal/v1/admin/api-keys', {
    method: 'POST', body: { consumerId: consumerB.id, name: 'Viewer Key' },
  })).json()).data

  launcherState = { payload: launcherResponse({ subject: 'mixed-role-user' }) }
  const firstSession = (await (await callAdmin('/internal/v1/admin/session', {
    token: 'mx-v1-mixed-role',
  })).json()).data
  for (const [tenantId, role] of [[tenantA.id, 'owner'], [tenantB.id, 'viewer']]) {
    const grant = await callAdmin('/internal/v1/admin/members/memberships', {
      method: 'POST',
      body: { memberId: firstSession.memberId, tenantId, role },
    })
    assert.equal(grant.status, 201)
  }

  const session = (await (await callAdmin('/internal/v1/admin/session', {
    token: 'mx-v1-mixed-role',
  })).json()).data
  const ownerMembership = session.memberships.find((membership) => membership.tenantId === tenantA.id)
  const viewerMembership = session.memberships.find((membership) => membership.tenantId === tenantB.id)
  assert.equal(ownerMembership.capabilities.includes('tenant.write'), true)
  assert.equal(ownerMembership.capabilities.includes('consumer.write'), true)
  assert.equal(viewerMembership.capabilities.includes('tenant.write'), false)
  assert.equal(viewerMembership.capabilities.includes('consumer.write'), false)

  const ownerConsumer = await callAdmin('/internal/v1/admin/consumers', {
    token: 'mx-v1-mixed-role', method: 'POST',
    body: { tenantId: tenantA.id, name: 'Allowed Owner Consumer' },
  })
  assert.equal(ownerConsumer.status, 201)

  const deniedRequests = [
    callAdmin(`/internal/v1/admin/tenants/${tenantB.id}`, {
      token: 'mx-v1-mixed-role', method: 'PUT', body: { name: 'Viewer Cannot Rename' },
    }),
    callAdmin('/internal/v1/admin/consumers', {
      token: 'mx-v1-mixed-role', method: 'POST',
      body: { tenantId: tenantB.id, name: 'Viewer Cannot Create' },
    }),
    callAdmin('/internal/v1/admin/members/memberships', {
      token: 'mx-v1-mixed-role', method: 'POST',
      body: { memberId: firstSession.memberId, tenantId: tenantB.id, role: 'owner' },
    }),
    callAdmin(`/internal/v1/admin/api-keys?consumerId=${consumerB.id}`, {
      token: 'mx-v1-mixed-role',
    }),
    callAdmin(`/internal/v1/admin/api-keys/${keyB.id}/revoke`, {
      token: 'mx-v1-mixed-role', method: 'POST',
    }),
    callAdmin('/internal/v1/admin/platforms/xiaohongshu', {
      token: 'mx-v1-mixed-role', method: 'PUT',
      body: { tenantId: tenantB.id, consumerId: consumerB.id, enabled: true },
    }),
  ]
  for (const responsePromise of deniedRequests) {
    const response = await responsePromise
    assert.equal(response.status, 403)
    assert.equal((await response.json()).error.code, 'insufficient_capability')
  }

  const visibleKeys = (await (await callAdmin('/internal/v1/admin/api-keys', {
    token: 'mx-v1-mixed-role',
  })).json()).data
  assert.equal(visibleKeys.some((key) => key.id === keyA.id), true)
  assert.equal(visibleKeys.some((key) => key.id === keyB.id), false)
})

test('scoped dashboard counts only mixed-role tenants and weights latency by committed usage', async () => {
  const create = async (path, body) => {
    const response = await callAdmin(path, { method: 'POST', body })
    assert.equal(response.status, 201)
    return (await response.json()).data
  }
  const ownerTenant = await create('/internal/v1/admin/tenants', { name: 'Dashboard Owner Tenant' })
  const viewerTenant = await create('/internal/v1/admin/tenants', { name: 'Dashboard Viewer Tenant' })
  const hiddenTenant = await create('/internal/v1/admin/tenants', { name: 'Dashboard Hidden Tenant' })
  const ownerConsumer = await create('/internal/v1/admin/consumers', {
    tenantId: ownerTenant.id, name: 'Dashboard Owner Consumer',
  })
  const viewerConsumer = await create('/internal/v1/admin/consumers', {
    tenantId: viewerTenant.id, name: 'Dashboard Viewer Consumer',
  })
  const hiddenConsumer = await create('/internal/v1/admin/consumers', {
    tenantId: hiddenTenant.id, name: 'Dashboard Hidden Consumer',
  })
  const ownerKey = await create('/internal/v1/admin/api-keys', {
    consumerId: ownerConsumer.id, name: 'Dashboard Owner Key',
  })
  const viewerKey = await create('/internal/v1/admin/api-keys', {
    consumerId: viewerConsumer.id, name: 'Dashboard Viewer Key',
  })
  const hiddenKey = await create('/internal/v1/admin/api-keys', {
    consumerId: hiddenConsumer.id, name: 'Dashboard Hidden Key',
  })
  const revokedKey = await create('/internal/v1/admin/api-keys', {
    consumerId: ownerConsumer.id, name: 'Dashboard Revoked Key',
  })
  assert.equal((await callAdmin(`/internal/v1/admin/api-keys/${revokedKey.id}/revoke`, {
    method: 'POST',
  })).status, 200)

  launcherState = { payload: launcherResponse({ subject: 'dashboard-scoped-user' }) }
  const firstSession = (await (await callAdmin('/internal/v1/admin/session', {
    token: 'mx-v1-dashboard-scoped',
  })).json()).data
  for (const [tenantId, role] of [[ownerTenant.id, 'owner'], [viewerTenant.id, 'viewer']]) {
    assert.equal((await callAdmin('/internal/v1/admin/members/memberships', {
      method: 'POST', body: { memberId: firstSession.memberId, tenantId, role },
    })).status, 201)
  }

  const recordUsage = async ({ tenant, consumer, key, index, status, latency }) => {
    const requestId = `dashboard-${tenant.id}-${index}`
    await store.reserve({
      requestId,
      idempotencyKey: requestId,
      fingerprint: requestId,
      tenantId: tenant.id,
      consumerId: consumer.id,
      apiKeyId: key.id,
      platform: 'xiaohongshu',
      unitsReserved: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      windowStart: new Date(0),
      maxRequests: Number.POSITIVE_INFINITY,
    })
    if (status === 'committed') {
      await store.commitRequest(requestId, {
        responseStatus: 200,
        responseBody: null,
        unitsActual: 1,
        upstreamLatencyMs: latency,
      })
    } else {
      await store.releaseRequest(requestId, 'upstream_rejected')
    }
  }

  await recordUsage({
    tenant: ownerTenant, consumer: ownerConsumer, key: ownerKey,
    index: 'committed', status: 'committed', latency: 100,
  })
  for (let index = 0; index < 2; index += 1) {
    await recordUsage({
      tenant: ownerTenant, consumer: ownerConsumer, key: ownerKey,
      index: `released-${index}`, status: 'released',
    })
  }
  for (let index = 0; index < 3; index += 1) {
    await recordUsage({
      tenant: viewerTenant, consumer: viewerConsumer, key: viewerKey,
      index: `committed-${index}`, status: 'committed', latency: 500,
    })
  }
  await recordUsage({
    tenant: hiddenTenant, consumer: hiddenConsumer, key: hiddenKey,
    index: 'must-not-leak', status: 'committed', latency: 999,
  })

  const scopedResponse = await callAdmin('/internal/v1/admin/dashboard', {
    token: 'mx-v1-dashboard-scoped',
  })
  assert.equal(scopedResponse.status, 200)
  const scoped = (await scopedResponse.json()).data
  assert.deepEqual({
    tenants: scoped.tenants,
    consumers: scoped.consumers,
    activeApiKeys: scoped.activeApiKeys,
    requests: scoped.requests,
    committed: scoped.committed,
    released: scoped.released,
    averageUpstreamLatencyMs: scoped.averageUpstreamLatencyMs,
  }, {
    tenants: 2,
    consumers: 2,
    activeApiKeys: 2,
    requests: 6,
    committed: 4,
    released: 2,
    averageUpstreamLatencyMs: 400,
  })

  const admin = (await (await callAdmin('/internal/v1/admin/dashboard')).json()).data
  assert.deepEqual(admin, await store.dashboard(), 'admin token remains platform-wide')
  assert.ok(admin.tenants > scoped.tenants)
  assert.ok(admin.consumers > scoped.consumers)
  assert.ok(admin.activeApiKeys > scoped.activeApiKeys)
})

// ---------------------------------------------------------------------------
// Platform admin follows the Launcher scope in both directions
// ---------------------------------------------------------------------------

test('an allowlisted Launcher scope confers platform admin, and losing it revokes', async () => {
  launcherState = { payload: launcherResponse({ subject: 'ops-user', scopes: ['insight-hub.admin'] }) }
  const granted = await (await callAdmin('/internal/v1/admin/session', { token: 'mx-v1-ops' })).json()
  assert.equal(granted.data.platformAdmin, true)
  assert.equal(granted.data.tenantIds, null, 'a platform admin is unscoped')

  const tenant = await callAdmin('/internal/v1/admin/tenants', {
    token: 'mx-v1-ops', method: 'POST', body: { name: 'Launcher Platform Admin Tenant' },
  })
  assert.equal(tenant.status, 201)
  const tenantId = (await tenant.json()).data.id
  const renamed = await callAdmin(`/internal/v1/admin/tenants/${tenantId}`, {
    token: 'mx-v1-ops', method: 'PUT', body: { name: 'Launcher Platform Admin Renamed' },
  })
  assert.equal(renamed.status, 200)
  for (const path of [
    '/internal/v1/ops/summary',
    '/internal/v1/admin/agent',
    '/internal/v1/admin/members',
    '/internal/v1/admin/retrieval',
  ]) {
    assert.equal((await callAdmin(path, { token: 'mx-v1-ops' })).status, 200)
  }

  // Scope removed upstream: the next sign-in must drop the Hub privilege too,
  // otherwise the grant is a ratchet that only ever accumulates.
  launcherState = { payload: launcherResponse({ subject: 'ops-user', scopes: [] }) }
  const revoked = await (await callAdmin('/internal/v1/admin/session', { token: 'mx-v1-ops' })).json()
  assert.equal(revoked.data.platformAdmin, false)
})

test('a non-allowlisted scope confers nothing', async () => {
  launcherState = { payload: launcherResponse({ subject: 'other-user', scopes: ['rbac.manage', 'sdk.identity.read'] }) }
  const { data } = await (await callAdmin('/internal/v1/admin/session', { token: 'mx-v1-other' })).json()
  assert.equal(data.platformAdmin, false)
})

// ---------------------------------------------------------------------------
// Unit-level scoping contract
// ---------------------------------------------------------------------------

test('scopeTenantFilter separates "denied" from "no membership"', () => {
  const unscoped = { tenantIds: null }
  assert.equal(scopeTenantFilter(unscoped, 'any-tenant'), 'any-tenant')

  const noMembership = { tenantIds: [] }
  assert.throws(() => scopeTenantFilter(noMembership, null), /no active tenant membership/)

  const scoped = { tenantIds: ['t1', 't2'] }
  assert.equal(scopeTenantFilter(scoped, 't2'), 't2')
  assert.deepEqual(scopeTenantFilter(scoped, null), ['t1', 't2'])
  assert.throws(() => scopeTenantFilter(scoped, 't3'), /cannot access that tenant/)
})

async function firstMemberId() {
  const members = await (await callAdmin('/internal/v1/admin/members')).json()
  return members.data[members.data.length - 1].id
}

// ---------------------------------------------------------------------------
// Sign-in discovery
// ---------------------------------------------------------------------------

test('sign-in options are readable without authentication', async () => {
  // The console must learn how to sign in before it can sign in. The response
  // carries only the Launcher address and audience -- both needed to
  // authenticate, neither secret, and no Hub state.
  const response = await fetch(`${baseUrl}/internal/v1/admin/sign-in-options`)
  assert.equal(response.status, 200)
  const { data } = await response.json()
  assert.equal(data.adminToken, true)
})

test('sign-in options advertise the proxied Launcher form when configured', async () => {
  const response = await fetch(`${baseUrl}/internal/v1/admin/sign-in-options`)
  const { data } = await response.json()
  // The browser needs no Launcher address of its own: the exchange goes through
  // this server, which is the only way it can work when Launcher is reachable
  // only on the internal network.
  assert.equal(data.launcher.mode, 'proxied')
  assert.equal(data.launcher.audience, AUDIENCE)
  assert.equal(data.launcher.url, undefined, 'no internal address is leaked to the browser')
})

test('an unconfigured Launcher says so instead of hiding the form silently', async () => {
  const { createApp } = await import('../../server/app.mjs')
  const bare = createApp({
    service: { authenticate: async () => null },
    store,
    adapter: { dependencies: async () => ({ status: 'up' }) },
    identity: null,
    adminToken: ADMIN_TOKEN,
  })
  const server2 = createServer(bare)
  await new Promise((resolve) => server2.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(
      `http://127.0.0.1:${server2.address().port}/internal/v1/admin/sign-in-options`,
    )
    const { data } = await response.json()
    assert.equal(data.launcher, null)
    assert.match(data.launcherUnavailableReason, /MX_INSIGHT_LAUNCHER_URL/)
  } finally {
    await new Promise((resolve) => server2.close(resolve))
  }
})

test('sign-in forwards credentials to Launcher and returns only the token', async () => {
  let seen = null
  const proxied = new LauncherIdentityClient({
    baseUrl: 'http://launcher.invalid',
    audience: AUDIENCE,
    logger: { warn() {} },
    fetchImpl: async (url, options) => {
      seen = { url, body: JSON.parse(options.body), headers: options.headers }
      // The real Launcher nests it: `{ token: { access_token, ... } }`. Reading
      // `payload.token` naively yields the wrapper OBJECT, which stringifies to
      // "[object Object]" and is then reported as an unknown token.
      return new Response(
        JSON.stringify({ token: { access_token: 'mx-v1-real-token', expires_at: 'later' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  })

  const issued = await proxied.signIn({ username: 'test', password: 'secret', clientIp: '203.0.113.9' })
  assert.equal(issued.token, 'mx-v1-real-token')
  assert.equal(typeof issued.token, 'string')
  assert.match(seen.url, /\/internal\/v1\/sdk\/oauth\/token$/)
  assert.equal(seen.body.grant_type, 'password')
  // Audience must be the Hub's; Launcher defaults to mx-sdk, which the Hub then
  // rejects on introspection.
  assert.equal(seen.body.audience, AUDIENCE)
  // The caller's address is forwarded so Launcher's per-source throttle still
  // discriminates between users rather than seeing only the Hub.
  assert.equal(seen.headers['x-forwarded-for'], '203.0.113.9')
})

test('a wrong password stays a 401 while a provider failure becomes 503', async () => {
  const make = (status) => new LauncherIdentityClient({
    baseUrl: 'http://launcher.invalid',
    audience: AUDIENCE,
    logger: { warn() {} },
    fetchImpl: async () => new Response('{}', { status, headers: { 'content-type': 'application/json' } }),
  })
  await assert.rejects(
    () => make(401).signIn({ username: 'a', password: 'b' }),
    (error) => error.status === 401 && error.code === 'invalid_credentials',
  )
  // Not the user's problem to retype a password over.
  await assert.rejects(
    () => make(500).signIn({ username: 'a', password: 'b' }),
    (error) => error.status === 503,
  )
  await assert.rejects(
    () => make(429).signIn({ username: 'a', password: 'b' }),
    (error) => error.status === 429,
  )
})

test('a response without a usable token string is rejected, not passed through', async () => {
  const client = new LauncherIdentityClient({
    baseUrl: 'http://launcher.invalid',
    audience: AUDIENCE,
    logger: { warn() {} },
    // Wrapper object only, no access_token inside: must not be handed back as
    // if it were a credential.
    fetchImpl: async () => new Response(JSON.stringify({ token: { audience: AUDIENCE } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }),
  })
  await assert.rejects(
    () => client.signIn({ username: 'a', password: 'b' }),
    /did not return a token/,
  )
})
