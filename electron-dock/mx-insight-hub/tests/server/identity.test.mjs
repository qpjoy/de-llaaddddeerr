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

test('a scoped member cannot create a tenant', async () => {
  launcherState = { payload: launcherResponse({ subject: 'scoped-user' }) }
  const response = await callAdmin('/internal/v1/admin/tenants', {
    token: 'mx-v1-scoped',
    method: 'POST',
    body: { name: 'Sneaky Tenant' },
  })
  assert.equal(response.status, 403)
})

// ---------------------------------------------------------------------------
// Platform admin follows the Launcher scope in both directions
// ---------------------------------------------------------------------------

test('an allowlisted Launcher scope confers platform admin, and losing it revokes', async () => {
  launcherState = { payload: launcherResponse({ subject: 'ops-user', scopes: ['insight-hub.admin'] }) }
  const granted = await (await callAdmin('/internal/v1/admin/session', { token: 'mx-v1-ops' })).json()
  assert.equal(granted.data.platformAdmin, true)
  assert.equal(granted.data.tenantIds, null, 'a platform admin is unscoped')

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
