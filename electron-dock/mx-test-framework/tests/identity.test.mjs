import assert from 'node:assert/strict'
import test from 'node:test'
import { loadConfig } from '../server/config.mjs'
import { directClientAddress } from '../server/core/http.mjs'
import { createIdentity } from '../server/identity/index.mjs'
import { LauncherIdentityClient } from '../server/identity/launcher-client.mjs'

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const inactive = () => json({ active: false })

const active = (id = 'user-1') =>
  json({
    active: true,
    audience: 'mx-sdk',
    subject: `subject-${id}`,
    principal: { principalId: id, displayName: `User ${id}` },
  })

const isUnauthorized = (error) => error?.status === 401 && error?.code === 'unauthorized'

test('runtime configuration reaches the Launcher client', () => {
  const config = loadConfig({
    MXT_STORE: 'memory',
    MXT_LAUNCHER_NEGATIVE_CACHE_TTL_MS: '41',
    MXT_LAUNCHER_INTROSPECTION_WINDOW_MS: '42',
    MXT_LAUNCHER_INTROSPECTION_MAX_STARTS: '43',
    MXT_LAUNCHER_INTROSPECTION_MAX_IN_FLIGHT: '44',
    MXT_LAUNCHER_INTROSPECTION_MAX_STARTS_PER_SOURCE: '48',
    MXT_LAUNCHER_INTROSPECTION_MAX_IN_FLIGHT_PER_SOURCE: '49',
    MXT_LAUNCHER_PASSWORD_LOGIN_WINDOW_MS: '45',
    MXT_LAUNCHER_PASSWORD_LOGIN_MAX_STARTS: '46',
    MXT_LAUNCHER_PASSWORD_LOGIN_MAX_IN_FLIGHT: '47',
    MXT_LAUNCHER_PASSWORD_LOGIN_MAX_STARTS_PER_SOURCE: '50',
    MXT_LAUNCHER_PASSWORD_LOGIN_MAX_IN_FLIGHT_PER_SOURCE: '51',
  })
  const identity = createIdentity({ store: {}, config, logger: null })

  assert.equal(identity.launcher.negativeCacheTtlMs, 41)
  assert.equal(identity.launcher.rateWindowMs, 42)
  assert.equal(identity.launcher.maxStartsPerWindow, 43)
  assert.equal(identity.launcher.maxInFlightEntries, 44)
  assert.equal(identity.launcher.maxStartsPerSourcePerWindow, 48)
  assert.equal(identity.launcher.maxInFlightPerSource, 49)
  assert.equal(identity.launcher.passwordLoginRateWindowMs, 45)
  assert.equal(identity.launcher.passwordLoginMaxStartsPerWindow, 46)
  assert.equal(identity.launcher.passwordLoginMaxInFlight, 47)
  assert.equal(identity.launcher.passwordLoginMaxStartsPerSourcePerWindow, 50)
  assert.equal(identity.launcher.passwordLoginMaxInFlightPerSource, 51)
})

test('security budgets trust only the direct socket peer, never X-Forwarded-For', () => {
  assert.equal(
    directClientAddress({
      socket: { remoteAddress: '10.0.0.5' },
      headers: { 'x-forwarded-for': '203.0.113.9' },
    }),
    '10.0.0.5',
  )
  assert.equal(directClientAddress({ headers: { 'x-forwarded-for': '203.0.113.9' } }), null)
})

test('password login accepts nested and legacy flat Launcher token envelopes', async () => {
  for (const [payload, expected] of [
    [{ token: { access_token: 'nested-token', expires_in: 61 } }, ['nested-token', 61]],
    [{ access_token: 'flat-token', expires_in: 62 }, ['flat-token', 62]],
  ]) {
    const client = new LauncherIdentityClient({
      baseUrl: 'http://launcher.test',
      audience: 'mx-sdk',
      fetchImpl: async (url) => {
        assert.match(url, /\/internal\/v1\/sdk\/oauth\/token$/u)
        return json(payload)
      },
    })

    const login = await client.passwordLogin({ username: 'legal-user', password: 'correct' })
    assert.deepEqual([login.token, login.expiresIn], expected)
  }
})

test('password login rejects a malformed nested token as a Launcher contract error', async () => {
  const client = new LauncherIdentityClient({
    baseUrl: 'http://launcher.test',
    audience: 'mx-sdk',
    fetchImpl: async () => json({ token: { access_token: { value: 'not-a-string' } } }),
  })

  await assert.rejects(
    client.passwordLogin({ username: 'legal-user', password: 'correct' }),
    (error) => error?.status === 502 && error?.code === 'launcher_contract',
  )
})

test('SDK introspection uses Launcher userId as the local principalId', async () => {
  const client = new LauncherIdentityClient({
    baseUrl: 'http://launcher.test',
    audience: 'mx-sdk',
    fetchImpl: async () =>
      json({
        introspection: {
          active: true,
          audience: 'mx-sdk',
          subject: 'user:usr-launcher-1',
          principal: { kind: 'user', userId: 'usr-launcher-1', roles: ['mx-user'] },
        },
      }),
  })

  const principal = await client.introspect('issued-token')
  assert.equal(principal.id, 'usr-launcher-1')
  assert.equal(principal.subject, 'user:usr-launcher-1')
})

test('service admin login stays local when Launcher identity is enabled', async () => {
  const adminToken = 'service-admin-token-that-never-leaves-mx-auto'
  let launcherCalls = 0
  const config = loadConfig({
    MXT_STORE: 'memory',
    MXT_ADMIN_TOKEN: adminToken,
    MXT_LAUNCHER_URL: 'http://launcher.test',
    MXT_LAUNCHER_AUDIENCE: 'mx-sdk',
  })
  config.launcher.fetchImpl = async () => {
    launcherCalls += 1
    throw new Error('service admin credentials must not reach Launcher')
  }
  const identity = createIdentity({ store: {}, config, logger: null })

  const login = await identity.login({ username: 'admin', password: adminToken })

  assert.deepEqual(login, {
    token: adminToken,
    expiresIn: null,
    member: {
      principalId: 'service-admin',
      displayName: '服务管理员',
      role: 'admin',
    },
  })
  assert.equal(launcherCalls, 0)
})

test('service admin token is never forwarded when the admin username is wrong', async () => {
  const adminToken = 'service-admin-token-that-never-leaves-mx-auto'
  let launcherCalls = 0
  const config = loadConfig({
    MXT_STORE: 'memory',
    MXT_ADMIN_TOKEN: adminToken,
    MXT_LAUNCHER_URL: 'http://launcher.test',
    MXT_LAUNCHER_AUDIENCE: 'mx-sdk',
  })
  config.launcher.fetchImpl = async () => {
    launcherCalls += 1
    throw new Error('service admin credentials must not reach Launcher')
  }
  const identity = createIdentity({ store: {}, config, logger: null })

  await assert.rejects(
    identity.login({ username: 'Admin', password: adminToken }),
    (error) => error?.status === 401 && error?.code === 'invalid_credentials',
  )
  assert.equal(launcherCalls, 0)
})

test('one hostile source cannot starve a different source password login', async () => {
  let calls = 0
  const client = new LauncherIdentityClient({
    baseUrl: 'http://launcher.test',
    audience: 'mx-sdk',
    passwordLoginMaxStartsPerWindow: 10,
    passwordLoginMaxStartsPerSourcePerWindow: 2,
    fetchImpl: async (_url, init) => {
      calls += 1
      const { username } = JSON.parse(init.body)
      return username === 'legal-user'
        ? json({ access_token: 'legal-token', expires_in: 60 })
        : json({ error: 'invalid_credentials' }, 401)
    },
  })

  for (const username of ['bogus-1', 'bogus-2']) {
    await assert.rejects(
      client.passwordLogin({ username, password: 'wrong' }, '10.0.0.1'),
      (error) => error?.status === 401,
    )
  }
  await assert.rejects(
    client.passwordLogin({ username: 'bogus-3', password: 'wrong' }, '10.0.0.1'),
    (error) => error?.status === 429,
  )

  const login = await client.passwordLogin(
    { username: 'legal-user', password: 'correct' },
    '10.0.0.2',
  )
  assert.equal(login.token, 'legal-token')
  assert.equal(calls, 3)
})

test('one targeted username cannot starve a different credential', async () => {
  let calls = 0
  const client = new LauncherIdentityClient({
    baseUrl: 'http://launcher.test',
    audience: 'mx-sdk',
    passwordLoginMaxStartsPerWindow: 10,
    passwordLoginMaxStartsPerSourcePerWindow: 2,
    fetchImpl: async (_url, init) => {
      calls += 1
      const { username } = JSON.parse(init.body)
      return username === 'different-user'
        ? json({ access_token: 'different-token' })
        : json({ error: 'invalid_credentials' }, 401)
    },
  })

  for (const source of ['10.0.1.1', '10.0.1.2']) {
    await assert.rejects(
      client.passwordLogin({ username: 'target-user', password: 'wrong' }, source),
      (error) => error?.status === 401,
    )
  }
  await assert.rejects(
    client.passwordLogin({ username: 'target-user', password: 'wrong' }, '10.0.1.3'),
    (error) => error?.status === 429 && error?.details?.scope === 'key',
  )

  const login = await client.passwordLogin(
    { username: 'different-user', password: 'correct' },
    '10.0.1.4',
  )
  assert.equal(login.token, 'different-token')
  assert.equal(calls, 3)
})

test('one hostile source cannot starve a different source valid token', async () => {
  let calls = 0
  const client = new LauncherIdentityClient({
    baseUrl: 'http://launcher.test',
    audience: 'mx-sdk',
    maxStartsPerWindow: 10,
    maxStartsPerSourcePerWindow: 2,
    fetchImpl: async (_url, init) => {
      calls += 1
      const { token } = JSON.parse(init.body)
      return token === 'legal-token' ? active('legal-user') : inactive()
    },
  })

  for (const token of ['junk-1', 'junk-2']) {
    await assert.rejects(client.introspect(token, '10.0.0.1'), isUnauthorized)
  }
  await assert.rejects(client.introspect('junk-3', '10.0.0.1'), (error) => error?.status === 429)

  assert.equal((await client.introspect('legal-token', '10.0.0.2')).id, 'legal-user')
  assert.equal(calls, 3)
})

test('multi-source floods still stop at the global emergency ceilings', async () => {
  let oauthCalls = 0
  const loginClient = new LauncherIdentityClient({
    baseUrl: 'http://launcher.test',
    audience: 'mx-sdk',
    passwordLoginMaxStartsPerWindow: 3,
    passwordLoginMaxStartsPerSourcePerWindow: 2,
    fetchImpl: async () => {
      oauthCalls += 1
      return json({ error: 'invalid_credentials' }, 401)
    },
  })
  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(
      loginClient.passwordLogin(
        { username: `bogus-${index}`, password: 'wrong' },
        `10.0.0.${index + 1}`,
      ),
      (error) => error?.status === 401,
    )
  }
  await assert.rejects(
    loginClient.passwordLogin({ username: 'legal', password: 'correct' }, '10.0.0.9'),
    (error) => error?.status === 429 && error?.details?.scope === 'global',
  )
  assert.equal(oauthCalls, 3)

  let introspectionCalls = 0
  const tokenClient = new LauncherIdentityClient({
    baseUrl: 'http://launcher.test',
    audience: 'mx-sdk',
    maxStartsPerWindow: 3,
    maxStartsPerSourcePerWindow: 2,
    fetchImpl: async () => {
      introspectionCalls += 1
      return inactive()
    },
  })
  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(
      tokenClient.introspect(`junk-${index}`, `10.0.1.${index + 1}`),
      isUnauthorized,
    )
  }
  await assert.rejects(
    tokenClient.introspect('otherwise-valid', '10.0.1.9'),
    (error) => error?.status === 429 && error?.details?.scope === 'global',
  )
  assert.equal(introspectionCalls, 3)
})

test('random invalid credentials cannot amplify the public login route without bound', async () => {
  let calls = 0
  let now = 5_000
  const client = new LauncherIdentityClient({
    baseUrl: 'http://launcher.test',
    audience: 'mx-sdk',
    passwordLoginRateWindowMs: 1_000,
    passwordLoginMaxStartsPerWindow: 3,
    now: () => now,
    fetchImpl: async (url) => {
      assert.match(url, /\/internal\/v1\/sdk\/oauth\/token$/u)
      calls += 1
      return json({ error: 'invalid_credentials' }, 401)
    },
  })

  for (const username of ['random-1', 'random-2', 'random-3']) {
    await assert.rejects(
      client.passwordLogin({ username, password: 'wrong' }),
      (error) => error?.status === 401 && error?.code === 'invalid_credentials',
    )
  }

  const overflow = await Promise.allSettled(
    Array.from({ length: 100 }, (_, index) =>
      client.passwordLogin({ username: `unique-${index}`, password: `wrong-${index}` }),
    ),
  )
  assert.ok(
    overflow.every(
      (result) =>
        result.status === 'rejected' &&
        result.reason?.status === 429 &&
        result.reason?.code === 'launcher_login_rate_limited',
    ),
  )
  assert.equal(calls, 3, 'rate-limited password attempts must not reach Launcher OAuth')

  now += 1_000
  await assert.rejects(
    client.passwordLogin({ username: 'after-window', password: 'wrong' }),
    (error) => error?.status === 401,
  )
  assert.equal(calls, 4)
})

test('one legal login has independent OAuth and introspection budgets', async () => {
  let oauthCalls = 0
  let introspectionCalls = 0
  const config = loadConfig({
    MXT_STORE: 'memory',
    MXT_LAUNCHER_URL: 'http://launcher.test',
    MXT_LAUNCHER_AUDIENCE: 'mx-sdk',
    MXT_LAUNCHER_PASSWORD_LOGIN_MAX_STARTS: '1',
    MXT_LAUNCHER_INTROSPECTION_MAX_STARTS: '1',
  })
  config.launcher.fetchImpl = async (url, init) => {
    if (url.endsWith('/internal/v1/sdk/oauth/token')) {
      oauthCalls += 1
      return json({ token: { access_token: 'issued-token', expires_in: 60 } })
    }
    assert.match(url, /\/internal\/v1\/sdk\/identity\/introspect$/u)
    assert.deepEqual(JSON.parse(init.body), { token: 'issued-token', audience: 'mx-sdk' })
    introspectionCalls += 1
    return active('legal-user')
  }
  let member = null
  const identity = createIdentity({
    config,
    logger: null,
    store: {
      getMember: async () => member,
      touchMember: async () => {},
      upsertMember: async (value) => {
        member = value
        return value
      },
    },
  })

  const login = await identity.login({
    username: 'legal-user',
    password: 'correct',
    source: '10.0.2.1',
  })
  assert.equal(login.token, 'issued-token')
  assert.equal(login.expiresIn, 60)
  assert.equal(login.member.role, 'viewer')
  assert.equal(oauthCalls, 1)
  assert.equal(introspectionCalls, 1)

  // The first authenticated request uses the positive decision cache even
  // though both one-start test budgets are now exhausted.
  assert.equal((await identity.resolve(login.token, '10.0.2.1')).id, 'legal-user')
  assert.equal(oauthCalls, 1)
  assert.equal(introspectionCalls, 1)
})

test('password in-flight limits isolate one source and retain a global ceiling', async () => {
  let calls = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const client = new LauncherIdentityClient({
    baseUrl: 'http://launcher.test',
    audience: 'mx-sdk',
    passwordLoginMaxStartsPerWindow: 10,
    passwordLoginMaxInFlight: 2,
    passwordLoginMaxInFlightPerSource: 1,
    fetchImpl: async () => {
      calls += 1
      await gate
      return json({ error: 'invalid_credentials' }, 401)
    },
  })

  const first = client.passwordLogin({ username: 'first', password: 'wrong' }, '10.0.0.1')
  await assert.rejects(
    client.passwordLogin({ username: 'same-source', password: 'wrong' }, '10.0.0.1'),
    (error) =>
      error?.status === 503 &&
      error?.code === 'launcher_login_busy' &&
      error?.details?.scope === 'key',
  )
  const otherSource = client.passwordLogin(
    { username: 'other-source', password: 'wrong' },
    '10.0.0.2',
  )
  await assert.rejects(
    client.passwordLogin({ username: 'global-overflow', password: 'wrong' }, '10.0.0.3'),
    (error) =>
      error?.status === 503 &&
      error?.code === 'launcher_login_busy' &&
      error?.details?.scope === 'global',
  )
  assert.equal(calls, 2)

  release()
  const settled = await Promise.allSettled([first, otherSource])
  assert.ok(settled.every((result) => result.status === 'rejected' && result.reason?.status === 401))
  await assert.rejects(
    client.passwordLogin({ username: 'after-settle', password: 'wrong' }, '10.0.0.1'),
    (error) => error?.status === 401,
  )
  assert.equal(calls, 3)
})

test('repeated invalid tokens use one Launcher introspection during the negative TTL', async () => {
  let calls = 0
  const client = new LauncherIdentityClient({
    baseUrl: 'http://launcher.test',
    audience: 'mx-sdk',
    fetchImpl: async () => {
      calls += 1
      return inactive()
    },
  })

  await assert.rejects(client.introspect('invalid-token'), isUnauthorized)
  await assert.rejects(client.introspect('invalid-token'), isUnauthorized)

  assert.equal(calls, 1)
})

test('concurrent requests for one invalid token share the same introspection', async () => {
  let calls = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const client = new LauncherIdentityClient({
    baseUrl: 'http://launcher.test',
    audience: 'mx-sdk',
    fetchImpl: async () => {
      calls += 1
      await gate
      return inactive()
    },
  })

  const settled = Promise.allSettled([
    client.introspect('same-invalid-token'),
    client.introspect('same-invalid-token'),
    client.introspect('same-invalid-token'),
  ])
  assert.equal(calls, 1)
  release()

  const results = await settled
  assert.ok(results.every((result) => result.status === 'rejected' && isUnauthorized(result.reason)))
  assert.equal(calls, 1)
})

test('an invalid decision is retried after its TTL and a successful token keeps positive caching', async () => {
  let calls = 0
  let now = 1_000
  let tokenIsActive = false
  const client = new LauncherIdentityClient({
    baseUrl: 'http://launcher.test',
    audience: 'mx-sdk',
    negativeCacheTtlMs: 3_000,
    now: () => now,
    fetchImpl: async () => {
      calls += 1
      return tokenIsActive ? active('eventually-valid') : inactive()
    },
  })

  await assert.rejects(client.introspect('eventual-token'), isUnauthorized)
  now += 2_999
  await assert.rejects(client.introspect('eventual-token'), isUnauthorized)
  assert.equal(calls, 1)

  tokenIsActive = true
  now += 1
  const principal = await client.introspect('eventual-token')
  assert.equal(principal.id, 'eventually-valid')
  assert.equal(calls, 2)

  assert.deepEqual(await client.introspect('eventual-token'), principal)
  assert.equal(calls, 2, 'successful tokens retain the existing positive cache behavior')
})

test('transient Launcher failures are never negative-cached', async () => {
  let calls = 0
  const client = new LauncherIdentityClient({
    baseUrl: 'http://launcher.test',
    audience: 'mx-sdk',
    fetchImpl: async () => {
      calls += 1
      return json({ error: 'temporary' }, 503)
    },
  })

  await assert.rejects(client.introspect('valid-but-provider-is-down'), (error) => error?.status === 503)
  await assert.rejects(client.introspect('valid-but-provider-is-down'), (error) => error?.status === 503)
  assert.equal(calls, 2)
})

test('many unique tokens are fail-fast after the global start-rate budget is exhausted', async () => {
  let calls = 0
  let now = 5_000
  const client = new LauncherIdentityClient({
    baseUrl: 'http://launcher.test',
    audience: 'mx-sdk',
    rateWindowMs: 1_000,
    maxStartsPerWindow: 3,
    now: () => now,
    fetchImpl: async () => {
      calls += 1
      return inactive()
    },
  })

  for (const token of ['junk-1', 'junk-2', 'junk-3']) {
    await assert.rejects(client.introspect(token), isUnauthorized)
  }

  const overflow = await Promise.allSettled(
    Array.from({ length: 100 }, (_, index) => client.introspect(`unique-overflow-${index}`)),
  )
  assert.ok(
    overflow.every(
      (result) =>
        result.status === 'rejected' &&
        result.reason?.status === 429 &&
        result.reason?.code === 'launcher_rate_limited',
    ),
  )
  assert.equal(calls, 3, 'rate-limited unique tokens must not reach Launcher')

  // Cache hits do not consume another start and preserve their auth meaning.
  await assert.rejects(client.introspect('junk-1'), isUnauthorized)
  assert.equal(calls, 3)

  now += 1_000
  await assert.rejects(client.introspect('after-window'), isUnauthorized)
  assert.equal(calls, 4, 'a new window admits introspection again')
})

test('the digest-keyed decision cache has a hard entry limit', async () => {
  let calls = 0
  const client = new LauncherIdentityClient({
    baseUrl: 'http://launcher.test',
    audience: 'mx-sdk',
    maxCacheEntries: 2,
    maxStartsPerWindow: 10,
    fetchImpl: async () => {
      calls += 1
      return inactive()
    },
  })

  for (const token of ['oldest', 'second', 'third']) {
    await assert.rejects(client.introspect(token), isUnauthorized)
  }
  await assert.rejects(client.introspect('second'), isUnauthorized)
  assert.equal(calls, 3, 'a retained digest still uses the negative cache')

  await assert.rejects(client.introspect('oldest'), isUnauthorized)
  assert.equal(calls, 4, 'the oldest digest was evicted when the bound was reached')
})

test('token in-flight limits isolate one source, dedupe a token and retain a global ceiling', async () => {
  let calls = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const client = new LauncherIdentityClient({
    baseUrl: 'http://launcher.test',
    audience: 'mx-sdk',
    maxInFlightEntries: 2,
    maxInFlightPerSource: 1,
    fetchImpl: async () => {
      calls += 1
      await gate
      return active('admitted')
    },
  })

  const first = client.introspect('admitted-token', '10.0.0.1')
  const duplicate = client.introspect('admitted-token', '10.0.0.1')
  await assert.rejects(
    client.introspect('same-source-token', '10.0.0.1'),
    (error) =>
      error?.status === 503 &&
      error?.code === 'launcher_busy' &&
      error?.details?.scope === 'key',
  )
  const otherSource = client.introspect('other-source-token', '10.0.0.2')
  await assert.rejects(
    client.introspect('global-overflow-token', '10.0.0.3'),
    (error) =>
      error?.status === 503 &&
      error?.code === 'launcher_busy' &&
      error?.details?.scope === 'global',
  )
  assert.equal(calls, 2)

  release()
  const [firstPrincipal, duplicatePrincipal, otherPrincipal] = await Promise.all([
    first,
    duplicate,
    otherSource,
  ])
  assert.equal(firstPrincipal.id, 'admitted')
  assert.deepEqual(duplicatePrincipal, firstPrincipal)
  assert.deepEqual(otherPrincipal, firstPrincipal)
  assert.equal(calls, 2)
})
