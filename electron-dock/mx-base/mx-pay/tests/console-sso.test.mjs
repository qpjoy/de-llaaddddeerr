import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes, generateKeyPairSync, createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createServer, request as httpsRequest } from 'node:https'
import pg from 'pg'
import { createPaymentConsole } from '../server/console.mjs'
import { createApp } from '../server/app.mjs'
import { PaymentCenter } from '../server/service.mjs'
import { migrate } from '../server/migrate.mjs'
import { PostgresSsoStore } from '@qpjoy/mx-common/identity/postgres'

const connectionString = process.env.MX_SSO_TEST_DATABASE_URL
test('payment console: real Launcher OIDC, dedicated PG, scoped reads, durable sessions and machine availability during Auth outage', { skip: !connectionString, timeout: 60000 }, async t => {
  const url = new URL(connectionString)
  assert.ok(['127.0.0.1','localhost'].includes(url.hostname) && url.pathname.includes('sso_test'))
  const { createIdentityProvider } = await import('../../../mx-launcher/server/src/identity/provider.ts')
  const { IdentityRepository } = await import('../../../mx-launcher/server/src/identity/repository.ts')
  const admin = new pg.Pool({ connectionString }), names = [], pools = [], servers = []
  const dir = mkdtempSync(join(tmpdir(), 'pay-console-sso-'))
  let repository, provider, handler, unavailable = false, blocked = false
  t.after(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections() })))
    await repository?.close(); await Promise.all(pools.map(pool => pool.end()))
    for (const name of names) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`)
    await admin.end(); rmSync(dir, { recursive: true, force: true })
  })
  async function database(label) {
    const name = `${label}_${randomUUID().replaceAll('-','')}`; names.push(name)
    await admin.query(`CREATE DATABASE ${name}`)
    const target = new URL(url); target.pathname = `/${name}`
    const pool = new pg.Pool({ connectionString: target.href }); pools.push(pool)
    return { pool, url: target.href }
  }
  const auth = await database('auth_fixture'), payment = await database('pay_console')
  await migrate(payment.url, { log() {} })
  repository = new IdentityRepository(auth.url, 'test', 'pay-sso', 'fixture'); await repository.initialize()
  await auth.pool.query('CREATE TABLE mx_platform_records(kind text,id text,environment text,data jsonb,PRIMARY KEY(kind,id,environment))')
  await auth.pool.query("INSERT INTO mx_platform_records VALUES('iam-user','person','test',$1)", [{ userId: 'person', status: 'active', displayName: 'Payment viewer', appAccess: { deniedAppIds: [] } }])
  execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',join(dir,'key'),'-out',join(dir,'cert')], { stdio: 'ignore' })
  const cert = readFileSync(join(dir,'cert')), key = readFileSync(join(dir,'key'))
  async function listen(callback) {
    const server = createServer({ cert, key }, callback); servers.push(server)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    return `https://127.0.0.1:${server.address().port}`
  }
  let userinfoPath
  const authOrigin = await listen((req,res) => unavailable && new URL(req.url, 'https://fixture').pathname === userinfoPath
    ? res.writeHead(503).end('fixture outage') : provider.handle(req,res))
  const origin = await listen((req,res) => handler(req,res)), issuer = `${authOrigin}/identity`
  const settings = { appId: 'mx-pay', origin, issuer, clientId: 'mx-pay-web', clientSecret: randomBytes(32).toString('base64url'),
    audience: 'mx-pay', scope: 'openid mx:identity', sessionKey: randomBytes(32).toString('base64url'), caCert: cert.toString() }
  const access = [], service = new PaymentCenter(payment.pool), store = new PostgresSsoStore(payment.pool, settings.sessionKey)
  const restart = () => { handler = createPaymentConsole({ settings, access, sessionPool: payment.pool, service, logger: { error() {} } }) }
  restart()
  const person = () => ({ userId: 'person', displayName: 'Payment viewer', status: 'active', appAccess: { deniedAppIds: blocked ? ['mx-pay'] : [] } })
  const accounts = { webState: repository.webState, account: async () => person(),
    authenticate: async (login,password) => login === 'person' && password === 'test-password' ? person() : undefined,
    allowAttempt: async () => true, hubIdentity: async (user,audience) => ({ issuer: 'mx-user-center:test', subject: `user:${user.userId}`, audience,
      principal: { userId: user.userId, kind: 'user', displayName: user.displayName, scopes: ['mx:admin'], organizationIds: [] } }),
    withBrowserRequest: repository.withBrowserRequest.bind(repository), browserSessions: repository.browserSessions.bind(repository), revokeBrowserSessions: repository.revokeBrowserSessions.bind(repository) }
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  provider = createIdentityProvider({ origin: authOrigin, issuer, clientId: 'launcher', clientSecret: 'launcher-fixture', cookieKeys: ['fixture-cookie'],
    jwks: { keys: [{ ...pair.privateKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' }] }, applications: [settings] }, accounts, name => repository.adapter(name))
  const secret = randomBytes(32).toString('base64url')
  const machine = { id: 'hub-test', appId: 'mx-insight-hub', environment: 'test', scopes: ['orders.read','orders.write','events.read','events.ack'], hash: createHash('sha256').update(secret).digest() }
  const apiOrigin = await listen(createApp({ service, credentials: [machine], logger: { error() {} } }))
  const paymentOrder = await service.create(machine, { businessOrderId: 'hub-recharge:stable-intent', customerRef: 'tenant-original', initiatorRef: 'member-original', amountMinor: 1000 }, 'stable-payment-request')
  await service.create({ ...machine, appId: 'another-app' }, { businessOrderId: 'hidden-order', customerRef: 'hidden-customer', amountMinor: 1200 }, 'another-request')
  const jar = new Map()
  function request(target, { method = 'GET', body, headers = {}, cookies = true } = {}) {
    return new Promise((resolve,reject) => {
      const req = httpsRequest(target, { ca: cert, method, headers: { ...(cookies ? { cookie: [...jar].map(([k,v]) => `${k}=${v}`).join('; ') } : {}), ...headers } }, res => {
        for (const raw of res.headers['set-cookie'] || []) { const [k,v] = raw.split(';')[0].split('='); jar.set(k,v) }
        let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers, location: res.headers.location }))
      }); req.on('error', reject); req.end(body)
    })
  }
  const discovery = JSON.parse((await request(`${issuer}/.well-known/openid-configuration`)).text)
  userinfoPath = new URL(discovery.userinfo_endpoint).pathname
  const ordersPath = `${origin}/console/v1/orders?appId=mx-insight-hub&environment=test`
  assert.equal((await request(ordersPath)).status, 401)
  let step = await request(`${origin}/auth/sso/login`), callback
  assert.equal(step.status, 303)
  for (let i = 0; i < 12 && step.location; i++) {
    const target = new URL(step.location, issuer).href
    if (new URL(target).pathname === '/auth/sso/callback') { callback = target; step = await request(target); break }
    step = await request(target)
    if (step.status === 200) {
      const csrf = /name="csrf" value="([^"]+)"/.exec(step.text)?.[1]; assert.ok(csrf, step.text)
      step = await request(target, { method: 'POST', headers: { origin: authOrigin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf, login: 'person', password: 'test-password' }).toString() })
    }
    assert.equal(step.status, 303, step.text)
  }
  assert.ok(callback); assert.equal(step.status, 303, step.text)
  assert.equal((await request(callback)).status, 400, 'callback is single-use')
  assert.equal((await request(ordersPath)).status, 403, 'Auth admin is not a payment viewer')
  access.push({ issuer, subject: 'person', clientId: settings.clientId, appId: 'mx-insight-hub', environment: 'test', role: 'viewer' })
  const listed = await request(ordersPath); assert.equal(listed.status, 200, listed.text)
  assert.deepEqual(JSON.parse(listed.text).data.items.map(order => order.id), [paymentOrder.id])
  assert.doesNotMatch(listed.text, /tenant-original|member-original|hidden-order|checkout/)
  assert.equal((await request(ordersPath.replace('test','live'))).status, 403)
  assert.equal((await request(`${apiOrigin}/v1/identity`)).status, 401, 'human cookie cannot authorize the machine API')
  assert.equal((await request(`${origin}/console/v1/me`, { cookies: false, headers: { authorization: `Bearer ${secret}` } })).status, 401)
  const sid = jar.get('__Host-mx-pay_sso'); restart()
  assert.equal((await request(ordersPath)).status, 200, 'session survives console restart')
  assert.ok(await store.get('session', sid))
  unavailable = true; restart() // clear only the short verification cache
  assert.equal((await request(ordersPath)).status, 503)
  assert.ok(await store.get('session', sid), 'Auth outage preserves local session')
  assert.equal((await request(`${apiOrigin}/health/ready`)).status, 200)
  assert.equal((await request(`${apiOrigin}/v1/orders/${paymentOrder.id}`, { headers: { authorization: `Bearer ${secret}` } })).status, 200)
  unavailable = false
  const session = JSON.parse((await request(`${origin}/auth/sso/session`)).text)
  assert.equal(session.active, true)
  assert.equal((await request(`${origin}/auth/sso/logout`, { method: 'POST', headers: { origin } })).status, 403)
  assert.equal((await request(`${origin}/auth/sso/logout`, { method: 'POST', headers: { origin: 'https://other.test', 'x-mx-csrf': session.csrf } })).status, 403)
  blocked = true
  assert.equal(JSON.parse((await request(`${origin}/auth/sso/session`)).text).active, false)
  assert.equal((await payment.pool.query("SELECT to_regclass('public.tenants') AS tenants, to_regclass('public.mx_platform_records') AS launcher")).rows[0].tenants, null)
  assert.equal((await payment.pool.query('SELECT count(*)::int AS n FROM pay.orders')).rows[0].n, 2, 'SSO never writes money')
})
