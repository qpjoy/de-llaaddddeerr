import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createServer, request as httpsRequest } from 'node:https'
import pg from 'pg'
import { SsoStore } from '../../server/identity/sso-store.mjs'
import { createSso } from '../../server/identity/sso.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { IdentityService } from '../../server/identity/index.mjs'

const connectionString = process.env.MX_SSO_TEST_DATABASE_URL

test('Hub SSO: real HTTPS OIDC + PostgreSQL, reuse, concurrent onboarding, restart, CSRF, replay and ban', { skip: !connectionString }, async t => {
  assert.ok(new URL(connectionString).pathname.includes('sso_test'))
  const { createIdentityProvider } = await import('../../../mx-launcher/server/src/identity/provider.ts')
  const { IdentityRepository } = await import('../../../mx-launcher/server/src/identity/repository.ts')
  const admin = new pg.Pool({ connectionString }), dbName = `hub_sso_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE ${dbName}`)
  const dbUrl = new URL(connectionString); dbUrl.pathname = `/${dbName}`
  const pool = new pg.Pool({ connectionString: dbUrl.href }), store = new PostgresStore(pool)
  const directory = mkdtempSync(join(tmpdir(), 'hub-sso-'))
  let repository, server
  t.after(async () => {
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    await repository?.close(); await pool.end(); await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`); await admin.end(); rmSync(directory, { recursive: true, force: true })
  })
  const migrations = new URL('../../migrations/', import.meta.url)
  for (const prefix of ['001_', '007_', '124_']) {
    const file = readdirSync(migrations).find(v => v.startsWith(prefix)); await pool.query(readFileSync(new URL(file, migrations), 'utf8'))
  }
  repository = new IdentityRepository(dbUrl.href, 'test', dbName, 'test-rate-key'); await repository.initialize()
  await pool.query('CREATE TABLE mx_platform_records(kind text,id text,environment text,data jsonb,PRIMARY KEY(kind,id,environment))')
  for (const id of ['existing','new-user']) await pool.query("INSERT INTO mx_platform_records VALUES('iam-user',$1,'test',$2)", [id,{userId:id,status:'active',displayName:id,appAccess:{deniedAppIds:[]}}])
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(directory, 'key'), '-out', join(directory, 'cert')], { stdio: 'ignore' })
  const cert = readFileSync(join(directory, 'cert')), key = readFileSync(join(directory, 'key'))
  let provider, sso, activeUser = 'existing', blocked = false, scopes = []
  server = createServer({ cert, key }, async (req, res) => {
    try {
      if (req.url.startsWith('/identity/')) return await provider.handle(req, res)
      if (await sso.handle(req, res, new URL(req.url, origin))) return
      const principal = await sso.principal(req)
      res.writeHead(principal ? 200 : 401, { 'content-type': 'application/json' }).end(JSON.stringify(principal))
    } catch (error) { res.writeHead(error.status || 500).end(JSON.stringify({ code: error.code, message: error.message })) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `https://127.0.0.1:${server.address().port}`, issuer = `${origin}/identity`
  const canonical = id => ({ issuer: 'mx-user-center:test', subject: `user:${id}`, audience: 'mx-insight-hub', authProvider: 'oidc', principal: { userId: id, principalId: `user:${id}`, kind: 'user', displayName: '同名成员', organizationIds: [], launcherTenantId: null, scopes } })
  const account = id => ({ userId: id, displayName: id, status: 'active', appAccess: { deniedAppIds: blocked ? ['mx-insight-hub'] : [] } })
  const accounts = { webState: repository.webState, account: async id => account(id), authenticate: async (login, password) => password === 'pass1234' ? account(login) : undefined, allowAttempt: async () => true, hubIdentity: async user => canonical(user.userId),
    withBrowserRequest: repository.withBrowserRequest.bind(repository), browserSessions: repository.browserSessions.bind(repository), revokeBrowserSessions: repository.revokeBrowserSessions.bind(repository) }
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  provider = createIdentityProvider({ origin, issuer, clientId: 'launcher', clientSecret: randomBytes(32).toString('hex'), cookieKeys: ['key1','key2'], jwks: { keys: [{ ...pair.privateKey.export({ format: 'jwk' }), kid: 'test', alg: 'RS256', use: 'sig' }] }, applications: [{ origin, clientId: 'hub', clientSecret: 'hub-test-secret', appId: 'mx-insight-hub', audience: 'mx-insight-hub' }] }, accounts, name => repository.adapter(name), {
    policy: async () => ({ mode: 'invite_code', version: 0 }),
    feishu: async (action, input) => {
      if (action === 'info') return { enabled: true }
      if (action === 'authorize') return { authorizationUrl: `${origin}/fake-feishu?state=${input.state}`, exchangeHandle: 'fixture-handle' }
      if (action === 'exchange') { assert.equal(input.code, 'verified-feishu-code'); return { subject: 'tenant:openid', userId: 'existing' } }
      throw new Error('Unexpected Web binding request')
    }
  })
  const settings = { origin, issuer, clientId: 'hub', clientSecret: 'hub-test-secret', legacyIssuer: 'mx-user-center:test', audience: 'mx-insight-hub', sessionKey: randomBytes(32).toString('base64url'), caCert: cert.toString(), personalTenant: true }
  const identity = new IdentityService({ store, client: { enabled: true } })
  const restart = () => { sso = createSso({ settings, pool, identity }) }; restart()
  const original = await store.upsertExternalIdentity({ ...canonical('existing'), displayName: 'Existing customer' })
  const tenant = await store.createTenant({ name: 'Original tenant' })
  await pool.query("INSERT INTO iam.tenant_memberships(id,member_id,tenant_id,role) VALUES($1,$2,$3,'viewer')", [randomUUID(), original.id, tenant.id])
  const jar = new Map(), cookieHeaders = []
  const request = (path, { method = 'GET', body, headers = {}, useCookies = true } = {}) => new Promise((resolve, reject) => {
    const req = httpsRequest(new URL(path, origin), { ca: cert, method, headers: { ...(useCookies ? { cookie: [...jar].map(([k,v])=>`${k}=${v}`).join('; ') } : {}), ...headers } }, res => {
      cookieHeaders.push(...(res.headers['set-cookie'] || []))
      for (const raw of res.headers['set-cookie'] || []) { const [name,value] = raw.split(';')[0].split('='); jar.set(name,value) }
      let text = ''; res.on('data', chunk => text += chunk); res.on('end', ()=>resolve({ status: res.statusCode, text, location: res.headers.location }))
    }); req.on('error',reject); req.end(body)
  })
  async function login() {
    let step = await request('/auth/sso/login?switch=1')
    assert.equal(step.status,303,step.text)
    step = await request(step.location); assert.equal(step.status,303,step.text)
    const interaction = step.location
    step = await request(interaction); assert.equal(step.status,200,step.text)
    const csrf = /name="csrf" value="([^"]+)"/.exec(step.text)[1]
    step = await request(interaction, { method:'POST', headers:{origin,'content-type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({csrf,login:activeUser,password:'pass1234'}).toString() })
    assert.equal(step.status,303,step.text)
    for(let i=0;i<8 && !step.location?.includes('/auth/sso/callback');i++) {
      step = await request(step.location)
      if(step.status===200 && step.text.includes('<form method="post"')) {
        const action=/<form method="post" action="([^"]+)"/.exec(step.text)[1]
        const fields=new URLSearchParams([...step.text.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map(m=>[m[1],m[2]]))
        step=await request(action,{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:fields.toString()})
      }
    }
    assert.ok(step.location?.includes('/auth/sso/callback'),JSON.stringify(step))
    const callback = step.location
    step=await request(callback); assert.equal(step.status,303,step.text)
    assert.equal((await request(callback)).status,400,'callback replay rejected')
  }
  await login()
  assert.ok(cookieHeaders.some(value => value.startsWith('__Host-mx_hub_sso=') && /Max-Age=2592000/i.test(value)), 'Hub cookie persists for 30 days')
  assert.ok(cookieHeaders.some(value => value.startsWith('mx_identity=') && Date.parse(/expires=([^;]+)/i.exec(value)?.[1] || '') - Date.now() > 29 * 86400000), 'Auth cookie survives browser restart for 30 days')
  const monthSession = await sso.store.get('session', jar.get('__Host-mx_hub_sso'))
  assert.ok(monthSession.accessToken, 'provider access token is retained only in the encrypted server session')
  let principal = JSON.parse((await request('/principal')).text)
  assert.equal(principal.memberId,original.id); assert.deepEqual(principal.tenantIds,[tenant.id]); assert.equal(principal.memberships[0].role,'viewer')
  restart(); principal=JSON.parse((await request('/principal')).text); assert.equal(principal.memberId,original.id)
  assert.equal((await request('/principal',{method:'POST',headers:{origin}})).status,403)
  const session=JSON.parse((await request('/auth/sso/session')).text)
  scopes=['mx:hub:admin']
  let delegated=JSON.parse((await request('/principal',{method:'POST',headers:{origin,'x-mx-hub-csrf':session.csrf}})).text)
  assert.equal(delegated.platformAdmin,true); assert.equal(delegated.tenantIds,null)
  scopes=['mx:pay:admin','mx:admin']
  delegated=JSON.parse((await request('/principal',{method:'POST',headers:{origin,'x-mx-hub-csrf':session.csrf}})).text)
  assert.equal(delegated.platformAdmin,false,'central revocation checked on writes; another application role is not Hub administration')
  assert.deepEqual(delegated.tenantIds,[tenant.id]); scopes=[]

  assert.equal((await request('/principal',{method:'POST',headers:{origin,'x-mx-hub-csrf':session.csrf}})).status,200)
  assert.equal((await request('/principal',{method:'POST',headers:{origin:'https://evil.invalid','x-mx-hub-csrf':session.csrf}})).status,403)
  activeUser='new-user';await login()
  principal=JSON.parse((await request('/principal')).text);assert.notEqual(principal.memberId, original.id, 'display names never merge identities');assert.equal(principal.memberships.length,1);assert.equal(principal.memberships[0].role,'owner');assert.equal(principal.platformAdmin,false)
  await Promise.all(Array.from({length:6},()=>sso.store.provision({issuer,subject:'racing',clientId:'hub',canonical:canonical('racing'),personalTenant:true})))
  assert.equal(Number((await pool.query("SELECT count(*) AS n FROM iam.external_identity_bindings WHERE subject='user:racing'")).rows[0].n),1)
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM tenants')).rows[0].n),3)
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM consumers')).rows[0].n),0)
  const encrypted=(await pool.query('SELECT payload FROM iam.browser_sso_records')).rows
  assert.ok(encrypted.every(r=>!r.payload.includes('accessToken')))
  sso = createSso({ settings: { ...settings, legacyIssuer: 'mx-user-center:wrong-environment' }, pool, identity })
  assert.equal((await request('/principal')).status, 401, 'canonical issuer must match the explicitly configured original authority')
  sso = createSso({ settings: { ...settings, audience: 'wrong-audience' }, pool, identity })
  assert.equal((await request('/principal')).status, 401, 'canonical audience must match')
  restart()
  await request('/auth/sso/login')
  assert.equal((await request('/auth/sso/callback?code=not-issued&state=wrong')).status,400,'state mismatch cannot redeem a code')
  assert.equal((await request('/principal')).status,200,'failed login leaves the prior valid session intact')
  // Browser-bound upstream OAuth cannot be resumed by another browser or replayed.
  let step=await request('/auth/sso/login?switch=1');step=await request(step.location)
  const feishuInteraction=step.location;step=await request(feishuInteraction)
  assert.match(step.text,/使用飞书登录/)
  const csrf=/name="csrf" value="([^"]+)"/.exec(step.text)[1]
  step=await request(feishuInteraction,{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,intent:'feishu-link'}).toString()})
  // Auth now navigates through its CSP-safe Feishu continuation page.
  assert.equal(step.status,200,step.text)
  const feishuUrl=/id="feishu-continue" href="([^"]+)"/.exec(step.text)?.[1]?.replaceAll('&amp;','&')
  assert.ok(feishuUrl,step.text)
  const upstreamState=new URL(feishuUrl).searchParams.get('state')
  const externalCallback=`/identity/feishu/callback?state=${upstreamState}&code=verified-feishu-code`
  assert.equal((await request(externalCallback,{useCookies:false})).status,400)
  step=await request(externalCallback);assert.equal(step.status,303,step.text)
  const bindingPage=await request(step.location);assert.match(bindingPage.text,/飞书身份已验证/);assert.match(bindingPage.text,/验证账号并绑定/)
  assert.equal((await request(externalCallback)).status,400,'upstream callback replay rejected')
  if (process.env.MX_SSO_BROWSER_MODULE) {
    const { chromium } = await import(process.env.MX_SSO_BROWSER_MODULE)
    const browser = await chromium.launch({ channel: 'chrome', headless: true })
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 960 } })
      const page = await context.newPage(), errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(`${origin}/auth/sso/login?switch=1`)
      await page.getByRole('button', { name: '使用飞书登录', exact: true }).waitFor()
      await page.screenshot({ path: '/tmp/mx-sso-login-desktop.png' })
      await page.getByRole('link', { name: '使用邀请码注册', exact: true }).click()
      await page.setViewportSize({ width: 390, height: 844 })
      assert.equal(await page.locator('body').evaluate(el => el.scrollWidth > innerWidth), false)
      await page.screenshot({ path: '/tmp/mx-sso-register-mobile.png' })
      await page.getByRole('link', { name: '已有账号，返回登录', exact: true }).click()
      await page.getByText('绑定已有账号', {exact:true}).click()
      await page.getByRole('button', { name: '绑定飞书到已有 MX 账号', exact: true }).click()
      await page.waitForURL('**/fake-feishu?*')
      const state = new URL(page.url()).searchParams.get('state')
      await page.goto(`${origin}/identity/feishu/callback?state=${state}&code=verified-feishu-code`)
      await page.getByRole('button', { name: '验证账号并绑定', exact: true }).waitFor()
      assert.equal(await page.locator('body').evaluate(el => el.scrollWidth > innerWidth), false)
      await page.screenshot({ path: '/tmp/mx-sso-feishu-bind-mobile.png' })
      assert.deepEqual(errors, [])
      console.log('Browser login / registration / Feishu binding: 1440px and 390px, no overflow or JS errors')
      const signIn = async tab => {
        await tab.goto(`${origin}/auth/sso/login?switch=1`)
        await tab.locator('#login').fill('existing'); await tab.locator('#password').fill('pass1234')
        await tab.getByRole('button', {name:'登录并继续',exact:true}).click()
        await tab.waitForURL(url => url.searchParams.get('sso') === 'ready')
      }
      await signIn(page)
      const otherContext = await browser.newContext({ignoreHTTPSErrors:true}), otherPage = await otherContext.newPage()
      await signIn(otherPage)
      await page.setViewportSize({width:1440,height:900})
      await page.goto(`${origin}/identity/sessions`)
      assert.equal(await page.locator('header').count(),1)
      await page.screenshot({path:'/tmp/mx-browser-sessions-desktop.png'})
      await page.emulateMedia({colorScheme:'dark'})
      await page.reload()
      assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).colorScheme),'dark')
      await page.screenshot({path:'/tmp/mx-browser-sessions-dark.png'})
      await page.emulateMedia({colorScheme:'light'})
      await page.setViewportSize({width:390,height:844})
      await page.reload()
      assert.equal(await page.locator('body').evaluate(el => el.scrollWidth > innerWidth),false)
      await page.screenshot({path:'/tmp/mx-browser-sessions-mobile.png'})
      await page.locator('article').filter({hasNotText:'当前浏览器'}).first().getByRole('button',{name:'退出此浏览器'}).click()
      assert.equal((await (await otherContext.request.get(`${origin}/auth/sso/session`)).json()).active,false)
      assert.equal((await (await context.request.get(`${origin}/auth/sso/session`)).json()).active,true)
      await page.getByRole('button',{name:'退出全部网页登录',exact:true}).click()
      await page.getByText('撤销已保存。', {exact:false}).waitFor()
      assert.equal((await (await context.request.get(`${origin}/auth/sso/session`)).json()).active,false)
      assert.deepEqual(errors,[])
      await otherContext.close()
      console.log('Browser session management: own sessions, selective/global logout, desktop/mobile, no overflow or JS errors')
    } finally { await browser.close() }
  }
  // Switching the login issuer must not evict an already issued private session.
  // Also cover the records created before the issuer field was introduced.
  const sid=jar.get('__Host-mx_hub_sso'), saved=await sso.store.get('session',sid)
  delete saved.issuer
  await sso.store.remove('session',sid);await sso.store.put('session',sid,saved,300)
  const switchedSettings={...settings,issuer:'https://new-public.invalid/identity',previousProviders:[{issuer:settings.issuer,clientId:settings.clientId,clientSecret:settings.clientSecret,caCert:settings.caCert}]}
  sso=createSso({settings:switchedSettings,pool,identity})
  assert.equal((await request('/principal')).status,200,'pre-upgrade private cookie survives public configuration migration')
  restart()
  const sessionsPage = await request('/identity/sessions')
  assert.equal(sessionsPage.status,200,sessionsPage.text)
  assert.match(sessionsPage.text,/退出全部网页登录/)
  const securityCsrf = /name="csrf" value="([^"]+)"/.exec(sessionsPage.text)[1]
  const revoke = (csrf, actionOrigin = origin) => request('/identity/sessions',{method:'POST',headers:{origin:actionOrigin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,target:'all'}).toString()})
  assert.equal((await revoke('wrong')).status,403)
  assert.equal((await revoke(securityCsrf,'https://evil.invalid')).status,403)
  const beforeRevoke = JSON.parse((await request('/auth/sso/session')).text)
  assert.equal((await request('/principal')).status,200,'warm the old read cache')
  assert.equal((await revoke(securityCsrf)).status,303)
  assert.equal((await request('/principal',{method:'POST',headers:{origin,'x-mx-hub-csrf':beforeRevoke.csrf}})).status,401,'writes must bypass stale positive cache after global logout')
  assert.equal((await request('/principal')).status,401,'a known invalid session must not regain access through the old read cache')
  assert.equal(JSON.parse((await request('/auth/sso/session')).text).active,false)
  await login()
  const afterRevoke = JSON.parse((await request('/auth/sso/session')).text)
  assert.equal(afterRevoke.active,true,'fresh authentication succeeds after global logout')
  await pool.query("UPDATE mx_platform_records SET data=jsonb_set(data,'{webSessionsInvalidBefore}',to_jsonb($1::text)) WHERE kind='iam-user' AND id=$2",[new Date().toISOString(),activeUser])
  assert.equal((await request('/principal',{method:'POST',headers:{origin,'x-mx-hub-csrf':afterRevoke.csrf}})).status,401,'password fence invalidates the provider token behind Hub cookie')
  assert.equal(JSON.parse((await request('/auth/sso/session')).text).active,false)
  await login()
  assert.equal(JSON.parse((await request('/principal')).text).memberId, principal.memberId,'reauthentication preserves the same original member')
  blocked=true;restart();assert.equal((await request('/principal')).status,401)
  const finalSession=JSON.parse((await request('/auth/sso/session')).text)
  assert.equal((await request('/auth/sso/logout',{method:'POST',headers:{origin,'x-mx-hub-csrf':finalSession.csrf}})).status,204)
  assert.equal((await request('/principal')).status,401)
})
