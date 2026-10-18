import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { start } from '../apps/server/index.mjs'

// The Configuration must come from the openid-client the shared module loads:
// a checkout of mx-common has its own copy (the image has only mx-rig's).
const commonRoot = join(dirname(fileURLToPath(import.meta.resolve('@qpjoy/mx-common/identity/sso'))), '..', '..')
const ownCopy = join(commonRoot, 'node_modules', 'openid-client', 'build', 'index.js')
const oidc = await import(existsSync(ownCopy) ? pathToFileURL(ownCopy).href : 'openid-client')

// docs/25 P4: signing in to Rig through the platform's unified authentication.
// The real shared module (@qpjoy/mx-common/identity/sso) runs against a small
// stand-in OIDC provider; Rig turns what it verifies into its own sessions.

const ISSUER = 'https://auth.rig.test/identity'
const ORIGIN = 'https://rig.test'
const CLIENT = { id: 'mx-rig-web', secret: 'test-client-secret' }
const b64url = (value) => Buffer.from(value).toString('base64url')

/** Just enough of oidc-provider: authorize (driven by the test), token, userinfo, JWKS. */
async function provider(t) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const codes = new Map()
  const tokens = new Map()
  const state = { down: false }
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/jwks') return json(200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] })
    if (url.pathname === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(body)
      const grant = codes.get(form.get('code'))
      codes.delete(form.get('code'))
      // RFC 6749 §2.3.1: each half is form-encoded before Basic.
      const basic = Buffer.from(String(req.headers.authorization).replace(/^Basic /, ''), 'base64').toString().split(':').map(decodeURIComponent).join(':')
      if (!grant || basic !== `${CLIENT.id}:${CLIENT.secret}` || createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== grant.challenge)
        return json(400, { error: 'invalid_grant' })
      const access = `at-${randomBytes(12).toString('hex')}`
      tokens.set(access, { user: grant.user, revoked: false })
      const now = Math.floor(Date.now() / 1000)
      const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' }))
      const claims = b64url(JSON.stringify({ iss: ISSUER, sub: grant.user.id, aud: CLIENT.id, iat: now, exp: now + 3600, nonce: grant.nonce }))
      const signature = sign('sha256', Buffer.from(`${head}.${claims}`), privateKey).toString('base64url')
      return json(200, { access_token: access, token_type: 'Bearer', expires_in: 3600, id_token: `${head}.${claims}.${signature}` })
    }
    if (url.pathname === '/me') {
      if (state.down) return json(500, { error: 'server_error' })
      const record = tokens.get(String(req.headers.authorization).replace(/^Bearer /, ''))
      // As oidc-provider answers (RFC 6750 §3): the challenge header says why.
      if (!record || record.revoked) {
        res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer error="invalid_token"' })
        return res.end(JSON.stringify({ error: 'invalid_token' }))
      }
      const { id, name } = record.user
      return json(200, {
        sub: id,
        mx_identity: { subject: `user:${id}`, audience: 'mx-rig', issuer: 'mx-user-center:test', principal: { userId: id, kind: 'user', displayName: name, scopes: ['auth.read'], organizationIds: [] } }
      })
    }
    json(404, {})
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const configuration = new oidc.Configuration(
    { issuer: ISSUER, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, userinfo_endpoint: `${base}/me`, jwks_uri: `${base}/jwks`, id_token_signing_alg_values_supported: ['RS256'] },
    CLIENT.id,
    { client_secret: CLIENT.secret, id_token_signed_response_alg: 'RS256' },
    oidc.ClientSecretBasic(CLIENT.secret)
  )
  oidc.allowInsecureRequests(configuration)
  return {
    configuration,
    state,
    /** The person signs in at Auth: a code for this authorization request. */
    authorize(location, user) {
      const asked = new URL(location)
      assert.equal(asked.searchParams.get('redirect_uri'), `${ORIGIN}/auth/sso/callback`)
      assert.equal(asked.searchParams.get('code_challenge_method'), 'S256')
      const code = randomBytes(16).toString('hex')
      codes.set(code, { user, nonce: asked.searchParams.get('nonce'), challenge: asked.searchParams.get('code_challenge') })
      return { code, state: asked.searchParams.get('state') }
    },
    revokeAll() {
      for (const record of tokens.values()) record.revoked = true
    }
  }
}

/** A browser on the public entrance: Host is the SSO origin, cookies kept per name. */
function browser(origin, host = new URL(ORIGIN).host) {
  const jar = new Map()
  const call = (method, path, { headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const target = new URL(path, origin)
      const req = httpRequest(
        target,
        { method, headers: { host, ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers } },
        (res) => {
          for (const line of [res.headers['set-cookie'] ?? []].flat()) {
            const [pair, ...attributes] = line.split(';')
            const [name, value] = [pair.slice(0, pair.indexOf('=')).trim(), pair.slice(pair.indexOf('=') + 1).trim()]
            if (attributes.some((a) => /max-age=0/i.test(a.trim())) || !value) jar.delete(name)
            else jar.set(name, value)
          }
          let text = ''
          res.on('data', (chunk) => (text += chunk))
          res.on('end', () => {
            let json = null
            try {
              json = JSON.parse(text)
            } catch {}
            resolve({ status: res.statusCode, location: res.headers.location, cookies: res.headers['set-cookie'] ?? [], text, json })
          })
        }
      )
      req.once('error', reject)
      req.end(body ? JSON.stringify(body) : undefined)
    })
  return { call, jar }
}

async function rig(t, idp) {
  const root = await mkdtemp(join(tmpdir(), 'mx-rig-sso-'))
  const runtime = await start(
    { MX_RIG_ADMIN_TOKEN: 'test-only-rig-secret', MX_RIG_HOST: '127.0.0.1', MX_RIG_PORT: '0', MX_RIG_STORE: 'memory', MX_RIG_STATE_DIR: root, MX_RIG_ARTIFACTS_DIR: join(root, 'artifacts') },
    {
      schedule: false,
      ssoSettings: { appId: 'mx-rig', origin: ORIGIN, issuer: ISSUER, clientId: CLIENT.id, clientSecret: CLIENT.secret, audience: 'mx-rig', sessionKey: randomBytes(32).toString('base64url') },
      oidcConfiguration: idp.configuration,
      ssoVerifyEveryMs: 0
    }
  )
  t.after(() => runtime.close())
  return runtime
}

const USER = { id: 'u-42', name: '测试员' }

/** The whole browser journey: Rig → Auth → back to Rig, logged in. */
async function signInThroughAuth(page, idp, user = USER) {
  const started = await page.call('GET', '/auth/sso/login?ui=/rig/')
  assert.equal(started.status, 303)
  const { code, state } = idp.authorize(started.location, user)
  return page.call('GET', `/auth/sso/callback?code=${code}&state=${state}`)
}

test('the web workbench: signed in through Auth, the member Rig already knows, one role source', async (t) => {
  const idp = await provider(t)
  const runtime = await rig(t, idp)
  const page = browser(runtime.origin)
  const methods = await page.call('GET', '/api/rig/v1/auth-methods')
  assert.deepEqual(methods.json, { sso: { enabled: true, origin: ORIGIN }, password: false }, 'the public entrance offers only SSO')
  const back = await signInThroughAuth(page, idp)
  assert.equal(back.status, 303, back.text)
  assert.equal(back.location, '/rig/?sso=ready')
  assert.ok(page.jar.has('mx_rig_session') && page.jar.has('__Host-mx-rig_sso'))
  assert.ok(back.cookies.some((cookie) => /^mx_rig_session=rig_s1_/.test(cookie) && /HttpOnly/.test(cookie) && /Secure/.test(cookie)))
  const me = await page.call('GET', '/api/rig/v1/me')
  assert.deepEqual([me.status, me.json.principal.id, me.json.principal.auth, me.json.principal.role], [200, 'user:u-42', 'sso', 'viewer'])
  // The same `user:<id>` a Launcher password sign-in resolves to: an admin's role change applies.
  const admin = browser(runtime.origin, '127.0.0.1')
  const raised = await admin.call('PATCH', '/api/v1/members/user%3Au-42', { headers: { authorization: 'Bearer test-only-rig-secret' }, body: { role: 'operator' } })
  assert.equal(raised.status, 200, raised.text)
  assert.equal((await page.call('GET', '/api/rig/v1/me')).json.principal.role, 'operator')
  // Signing out ends the Rig session and the shared module's browser session.
  const out = await page.call('POST', '/api/rig/v1/logout', { headers: { origin: ORIGIN }, body: {} })
  assert.equal(out.status, 200)
  assert.ok(!page.jar.has('mx_rig_session') && !page.jar.has('__Host-mx-rig_sso'))
})

test('what the public entrance refuses, and what the internal address still allows', async (t) => {
  const idp = await provider(t)
  const runtime = await rig(t, idp)
  const outside = browser(runtime.origin)
  for (const [method, path] of [['POST', '/api/rig/v1/login'], ['POST', '/api/rig/v1/native-login'], ['POST', '/api/v1/auth/login'], ['GET', '/readyz'], ['GET', '/healthz'], ['POST', '/runner/v1/runs:claim'], ['POST', '/webhooks/v1/git/demo'], ['GET', '/test-center/']]) {
    const answer = await outside.call(method, path, method === 'POST' ? { body: { account: 'admin', password: 'test-only-rig-secret' } } : {})
    assert.equal(answer.status, 404, `${method} ${path} on the public entrance`)
  }
  // A foreign page cannot act with the session.
  await signInThroughAuth(outside, idp)
  assert.equal((await outside.call('POST', '/api/rig/v1/logout', { headers: { origin: 'https://evil.example' }, body: {} })).status, 403)
  // Inside, passwords and the service admin keep working, and the methods say so.
  const inside = browser(runtime.origin, '127.0.0.1')
  assert.deepEqual((await inside.call('GET', '/api/rig/v1/auth-methods')).json, { sso: { enabled: true, origin: ORIGIN }, password: true })
  assert.equal((await inside.call('POST', '/api/rig/v1/login', { body: { account: 'admin', password: 'test-only-rig-secret' } })).status, 200)
})

test('the desktop: system browser, a one-time code to its loopback, redeemed only with its verifier', async (t) => {
  const idp = await provider(t)
  const runtime = await rig(t, idp)
  const desktop = browser(runtime.origin, '127.0.0.1')
  const journey = async () => {
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const state = randomBytes(32).toString('base64url')
    const page = browser(runtime.origin)
    const start = await page.call('GET', `/auth/desktop/start?challenge=${challenge}&port=45678&state=${state}`)
    assert.equal(start.status, 303)
    assert.equal(start.location, '/auth/sso/login?ui=%2Frig%2F')
    const back = await signInThroughAuth(page, idp)
    assert.match(back.location, /^\/auth\/desktop\/complete\?code=[A-Za-z0-9_-]{43}$/)
    assert.ok(!page.jar.has('__Host-mx-rig_desktop'), 'the hand-off cookie is spent')
    const complete = await page.call('GET', back.location)
    const loopback = new URL(complete.location)
    assert.deepEqual([loopback.origin, loopback.pathname, loopback.searchParams.get('state')], ['http://127.0.0.1:45678', '/callback', state])
    return { code: loopback.searchParams.get('code'), verifier, page }
  }
  // Only the desktop that holds the verifier; once; never from a web page.
  const stolen = await journey()
  assert.equal((await desktop.call('POST', '/api/rig/v1/desktop-login', { body: { code: stolen.code, verifier: randomBytes(32).toString('base64url') } })).status, 401)
  assert.equal((await desktop.call('POST', '/api/rig/v1/desktop-login', { body: { code: stolen.code, verifier: stolen.verifier } })).status, 401, 'a code is burnt by a wrong verifier')
  const real = await journey()
  assert.equal((await desktop.call('POST', '/api/rig/v1/desktop-login', { headers: { origin: ORIGIN }, body: { code: real.code, verifier: real.verifier } })).status, 403)
  const signed = await desktop.call('POST', '/api/rig/v1/desktop-login', { body: { code: real.code, verifier: real.verifier } })
  assert.equal(signed.status, 200, signed.text)
  assert.match(signed.json.token, /^rig_s1_/)
  assert.equal(signed.json.member.principalId, 'user:u-42')
  assert.equal((await desktop.call('POST', '/api/rig/v1/desktop-login', { body: { code: real.code, verifier: real.verifier } })).status, 401, 'used once')
  const me = await desktop.call('GET', '/api/rig/v1/me', { headers: { authorization: `Bearer ${signed.json.token}` } })
  assert.deepEqual([me.json.principal.id, me.json.principal.auth], ['user:u-42', 'sso'])
  // The desktop holds its own copy: signing out of the web page leaves it signed in.
  await real.page.call('POST', '/api/rig/v1/logout', { headers: { origin: ORIGIN }, body: {} })
  assert.equal((await desktop.call('GET', '/api/rig/v1/me', { headers: { authorization: `Bearer ${signed.json.token}` } })).status, 200)
  // A start request that is not a desktop's is refused before Auth is involved.
  assert.equal((await browser(runtime.origin).call('GET', '/auth/desktop/start?challenge=x&port=80&state=y')).status, 400)
  assert.equal((await browser(runtime.origin).call('GET', `/auth/desktop/complete?code=${'a'.repeat(43)}`)).status, 410)
})

test('Auth decides: a revoked account stops at the next request; Auth unreachable keeps a fresh session', async (t) => {
  const idp = await provider(t)
  const runtime = await rig(t, idp)
  const page = browser(runtime.origin)
  await signInThroughAuth(page, idp)
  assert.equal((await page.call('GET', '/api/rig/v1/me')).status, 200)
  idp.state.down = true
  assert.equal((await page.call('GET', '/api/rig/v1/me')).status, 200, 'verified a moment ago: Auth being down does not sign anyone out')
  idp.state.down = false
  idp.revokeAll()
  const revoked = await page.call('GET', '/api/rig/v1/me')
  assert.equal(revoked.status, 401)
  idp.state.down = true
  assert.equal((await page.call('GET', '/api/rig/v1/me')).status, 401, 'and the Rig session is gone for good')
})

test('without a profile there is no SSO, and nothing else changes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mx-rig-nosso-'))
  const runtime = await start(
    { MX_RIG_ADMIN_TOKEN: 'test-only-rig-secret', MX_RIG_HOST: '127.0.0.1', MX_RIG_PORT: '0', MX_RIG_STORE: 'memory', MX_RIG_STATE_DIR: root, MX_RIG_ARTIFACTS_DIR: join(root, 'artifacts'), MX_RIG_SSO_PROFILE: join(root, 'absent.json') },
    { schedule: false }
  )
  t.after(() => runtime.close())
  const page = browser(runtime.origin, '127.0.0.1')
  assert.deepEqual((await page.call('GET', '/api/rig/v1/auth-methods')).json, { sso: { enabled: false }, password: true })
  assert.equal((await page.call('GET', '/auth/sso/login')).status, 404)
  assert.equal((await page.call('POST', '/api/rig/v1/desktop-login', { body: { code: 'x', verifier: 'y' } })).status, 404)
  assert.equal((await page.call('GET', '/readyz')).status, 200)
})

test('the desktop module end to end: the system browser follows the redirects, the desktop redeems', async (t) => {
  const { browserSignIn, startUrl } = await import('../apps/desktop/browser-sign-in.mjs')
  const idp = await provider(t)
  const runtime = await rig(t, idp)
  const desktop = browser(runtime.origin, '127.0.0.1')
  const opened = []
  // The system browser: Rig on the public entrance, Auth, back, then the loopback.
  const systemBrowser = async (url) => {
    opened.push(url)
    const target = new URL(url)
    assert.equal(target.origin, ORIGIN)
    const page = browser(runtime.origin)
    const start = await page.call('GET', `${target.pathname}${target.search}`)
    const login = await page.call('GET', start.location)
    const { code, state } = idp.authorize(login.location, USER)
    const back = await page.call('GET', `/auth/sso/callback?code=${code}&state=${state}`)
    const complete = await page.call('GET', back.location)
    const loopback = await fetch(complete.location)
    assert.equal(loopback.status, 200)
    assert.match(await loopback.text(), /已登录 MX Rig/)
  }
  const result = await browserSignIn({
    ssoOrigin: ORIGIN,
    openExternal: (url) => void systemBrowser(url),
    redeem: async (body) => (await desktop.call('POST', '/api/rig/v1/desktop-login', { body })).json
  })
  assert.match(result.token, /^rig_s1_/)
  assert.equal(result.member.principalId, 'user:u-42')
  assert.match(opened[0], /^https:\/\/rig\.test\/auth\/desktop\/start\?challenge=[A-Za-z0-9_-]{43}&port=\d+&state=[A-Za-z0-9_-]{43}$/)
  for (const bad of ['http://rig.test', 'https://user:pw@rig.test', 'https://rig.test/other', 'javascript:alert(1)'])
    assert.throws(() => startUrl(bad, { challenge: 'c', port: 1, state: 's' }), /统一认证地址无效/, bad)
})

test('the loopback listener answers only its own callback, and gives up on time or on cancel', async () => {
  const { browserSignIn } = await import('../apps/desktop/browser-sign-in.mjs')
  let started
  const waiting = browserSignIn({
    ssoOrigin: ORIGIN,
    openExternal: (url) => (started = new URL(url)),
    redeem: async ({ code }) => ({ token: `redeemed:${code}` }),
    timeoutMs: 2000
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  const port = started.searchParams.get('port')
  const state = started.searchParams.get('state')
  // Another tab's state, a malformed code, another path: refused, still waiting.
  assert.equal((await fetch(`http://127.0.0.1:${port}/callback?code=${'a'.repeat(43)}&state=${'b'.repeat(43)}`)).status, 400)
  assert.equal((await fetch(`http://127.0.0.1:${port}/callback?code=short&state=${state}`)).status, 400)
  assert.equal((await fetch(`http://127.0.0.1:${port}/other`)).status, 404)
  assert.equal((await fetch(`http://127.0.0.1:${port}/callback?code=${'c'.repeat(43)}&state=${state}`)).status, 200)
  assert.deepEqual(await waiting, { token: `redeemed:${'c'.repeat(43)}` })
  await assert.rejects(fetch(`http://127.0.0.1:${port}/callback`), 'closed after one answer')
  await assert.rejects(browserSignIn({ ssoOrigin: ORIGIN, openExternal: () => {}, redeem: async () => ({}), timeoutMs: 100 }), /超时/)
  const abort = new AbortController()
  let openedAfterCancel = false
  const cancelled = browserSignIn({ ssoOrigin: ORIGIN, openExternal: () => (openedAfterCancel = true), redeem: async () => ({}), signal: abort.signal })
  abort.abort()
  await assert.rejects(cancelled, /已取消/)
  assert.equal(openedAfterCancel, false, 'cancelled before the browser opened: it does not open')
})

test("the gateway example and the server's own allowlist say the same", async () => {
  const { readFileSync } = await import('node:fs')
  const { publicPath } = await import('../apps/server/index.mjs')
  const example = readFileSync(new URL('../deploy/gateway/internal-nginx.conf.example', import.meta.url), 'utf8')
  const blocks = [...example.matchAll(/location (=|\^~) (\S+)\s*\{\s*(return 404|proxy_pass)/g)].map(([, kind, path, action]) => ({ kind, path, open: action === 'proxy_pass' }))
  assert.ok(blocks.length >= 10)
  for (const { kind, path, open } of blocks) {
    const probe = kind === '^~' ? `${path}probe` : path
    assert.equal(publicPath(probe), open, `${probe}: the gateway ${open ? 'forwards' : 'refuses'} it, so must Rig`)
  }
  for (const inside of ['/runner/v1/runs:claim', '/webhooks/v1/git/demo', '/readyz', '/test-center/', '/artifacts/x'])
    assert.equal(publicPath(inside), false, `${inside} stays inside`)
})
