import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID,randomBytes,generateKeyPairSync } from 'node:crypto'
import { createServer,request as httpsRequest,globalAgent } from 'node:https'
import { mkdtempSync,readFileSync,readdirSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join,extname } from 'node:path'
import { execFileSync } from 'node:child_process'
import pg from 'pg'
import { createSso } from '../../server/identity/sso.mjs'
import { IdentityService,adminTokenPrincipal } from '../../server/identity/index.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { readJson } from '../../server/core/http.mjs'
import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'

const connectionString=process.env.MX_SSO_TEST_DATABASE_URL
test('native account integration: separate issuer origin, legacy mapping, reusable SDK, registration and account security',{skip:!connectionString || !process.env.MX_SSO_BROWSER_MODULE,timeout:120000},async t=>{
  const url=new URL(connectionString)
  assert.ok(['127.0.0.1','localhost'].includes(url.hostname)&&url.pathname.includes('sso_test'))
  const {createIdentityProvider}=await import('../../../mx-launcher/server/src/identity/provider.ts')
  const {IdentityRepository}=await import('../../../mx-launcher/server/src/identity/repository.ts')
  const {RegistrationRepository}=await import('../../../mx-launcher/server/src/registration/repository.ts')
  const {resolveHubInvitation}=await import('../../../mx-launcher/server/src/identity/hub-invitation.ts')
  const root=new pg.Pool({connectionString}), database=`hub_journey_${randomUUID().replaceAll('-','')}`
  await root.query(`CREATE DATABASE ${database}`);url.pathname=`/${database}`
  const pool=new pg.Pool({connectionString:url.href}), directory=mkdtempSync(join(tmpdir(),'mx-invitation-journey-'))
  let cancelFeishu=false,unavailableAccount=false;let browser,server,authServer,accounts,registration,provider,sso,origin,authOrigin,hubAuthHandler
  const previousCa=globalAgent.options.ca
  t.after(async()=>{
    await browser?.close()
    if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections()})
    if(authServer)await new Promise(resolve=>{authServer.close(resolve);authServer.closeAllConnections()})
    globalAgent.options.ca=previousCa
    await registration?.close();await accounts?.close();await pool.end();await root.query(`DROP DATABASE ${database} WITH (FORCE)`);await root.end();rmSync(directory,{recursive:true,force:true})
  })
  const migrations=new URL('../../migrations/',import.meta.url)
  const files=readdirSync(migrations)
  for(const prefix of ['001_','007_','124_','125_'])await pool.query(readFileSync(new URL(files.find(name=>name.startsWith(prefix)),migrations),'utf8'))
  await pool.query('CREATE TABLE mx_platform_records(environment text,kind text,id text,site_id text,data jsonb,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),PRIMARY KEY(environment,kind,id))')
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost','-keyout',join(directory,'key'),'-out',join(directory,'cert')],{stdio:'ignore'})
  const cert=readFileSync(join(directory,'cert')),key=readFileSync(join(directory,'key'))
  // Test-only local CA; production uses the normal verified TLS trust store.
  globalAgent.options.ca=cert
  const json=(res,status,value)=>res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify(value))
  server=createServer({cert,key},async(req,res)=>{
    try {
      const path=new URL(req.url,origin).pathname

      if(path.startsWith('/auth/sso/'))return hubAuthHandler(req,res)
      if(path==='/favicon.ico'){res.writeHead(204).end();return}
      if(path==='/internal/v1/admin/sign-in-options')return json(res,200,{data:{adminToken:true,sso:{loginUrl:'/auth/sso/login',switchUrl:'/auth/sso/login?switch=1'},launcher:{audience:'mx-insight-hub',mode:'proxied'}}})
      if(path==='/'||/^\/assets\/[A-Za-z0-9_.-]+$/.test(path)) {
        const file=new URL(`../../dist/client/${path==='/'?'index.html':path.slice(1)}`,import.meta.url)
        const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.woff2':'font/woff2'}[extname(file.pathname)] || 'application/octet-stream'
        res.writeHead(200,{'content-type':mime}).end(readFileSync(file));return
      }
      const principal=req.headers['x-mx-insight-admin-token']==='fixture-admin' ? adminTokenPrincipal() : await sso.principal(req)
      if(!principal)return json(res,401,{message:'Login required'})
      if(path==='/internal/v1/admin/session')return json(res,200,{data:{...principal,tenantInvitationsEnabled:true,productScopes:[]}})
      if(path==='/internal/v1/admin/tenant-invitations')return json(res,200,{data:req.method==='POST'?await sso.invitations.create(principal,await readJson(req)):await sso.invitations.list(principal,new URL(req.url,origin).searchParams.get('tenantId'))})
      if(path==='/internal/v1/admin/tenants')return json(res,200,{data:(await pool.query('SELECT id,name,status FROM tenants WHERE $1::uuid[] IS NULL OR id=ANY($1::uuid[])',[principal.tenantIds])).rows})
      if(path==='/internal/v1/admin/me/overview')return json(res,200,{data:{tenants:[],consumers:[]}})
      return json(res,200,{data:[]})
    }catch(error){return json(res,error.status||500,{message:error.message})}
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`https://127.0.0.1:${server.address().port}`
  authServer=createServer({cert,key},(req,res)=>{
    if(unavailableAccount && req.url==='/identity/app-account'){res.writeHead(502,{'content-type':'text/html'}).end('fixture gateway failure');return}
    if(req.url.startsWith('/fixture/feishu')) { const state=new URL(req.url,authOrigin).searchParams.get('state');res.writeHead(303,{location:`${authOrigin}/identity/feishu/callback?state=${state}&${cancelFeishu?'error=access_denied':'code=fixture-code'}`}).end();return }
    return provider.handle(req,res)
  }); await new Promise(resolve=>authServer.listen(0,'localhost',resolve));authOrigin=`https://localhost:${authServer.address().port}`
  const issuer=`${authOrigin}/identity`,clientSecret=randomBytes(32).toString('hex')
  accounts=new IdentityRepository(url.href,'test','invitation-journey','fixture-rate');await accounts.initialize()
  registration=new RegistrationRepository(url.href,'test','launcher','fixture')
  const pair=generateKeyPairSync('rsa',{modulusLength:2048})
  const app={origin,clientId:'hub',clientSecret,appId:'mx-insight-hub',audience:'mx-insight-hub'}
  provider=createIdentityProvider({origin:authOrigin,issuer,clientId:'launcher',clientSecret:'fixture-launcher',cookieKeys:['fixture-cookie-key'],jwks:{keys:[{...pair.privateKey.export({format:'jwk'}),kid:'fixture',alg:'RS256',use:'sig'}]},applications:[app,{...app,clientId:'other-app',appId:'mx-other',clientSecret:'other-secret',audience:'other'}]},accounts,name=>accounts.adapter(name),{
    policy:source=>registration.policy(source),register:input=>registration.register({...input,clientId:'launcher'}),account:(action,input)=>registration.updateAccount(action,input),feishu:async(action,input)=>{
      if(action==='info')return {enabled:true}
      if(action==='authorize')return {authorizationUrl:`${authOrigin}/fixture/feishu?state=${input.state}`,exchangeHandle:'fixture-handle'}
      if(action==='exchange'){assert.equal(input.code,'fixture-code');return {subject:'fixture:colleague',...await registration.feishuAccount('fixture:colleague')}}
      if(action==='bind')return registration.bindFeishu(input.subject,input.login,input.password)
      throw new Error('Unsupported fixture action')
    }
  })
  const identity=new IdentityService({store:new PostgresStore(pool),client:{enabled:true}})
  sso=createSso({settings:{origin,issuer,clientId:'hub',clientSecret,legacyIssuer:'mx-user-center:test',audience:'mx-insight-hub',sessionKey:randomBytes(32).toString('base64url'),caCert:cert.toString(),personalTenant:true},pool,identity,adminToken:'fixture-admin'})
  const hubStore=new PostgresStore(pool)
  hubAuthHandler=createApp({store:hubStore,service:new HubService({store:hubStore,adapter:{},apiKeyPepper:'fixture-pepper-at-least-32-characters'}),sso,identity,listenerMode:'admin'})
  await registration.updatePolicy({mode:'open',version:0})
  const old=await registration.register({transactionId:randomUUID(),clientId:'launcher',policyVersion:1,account:'ExistingHubUser',password:'ExistingPassword123!'})
  const member=randomUUID(),tenant=randomUUID()
  await pool.query("INSERT INTO iam.members(id,display_name) VALUES($1,'Original member')",[member])
  await pool.query("INSERT INTO tenants(id,name) VALUES($1,'原有企业')",[tenant])
  await pool.query("INSERT INTO iam.external_identity_bindings(id,member_id,issuer,subject,audience,auth_provider) VALUES($1,$2,'mx-user-center:test',$3,'mx-insight-hub','launcher')",[randomUUID(),member,`user:${old.userId}`])
  await pool.query("INSERT INTO iam.tenant_memberships(id,member_id,tenant_id,role) VALUES($1,$2,$3,'viewer')",[randomUUID(),member,tenant])
  const before=(await pool.query("SELECT data FROM mx_platform_records WHERE kind='iam-user' AND id=$1",[old.userId])).rows[0].data
  const {chromium}=await import(process.env.MX_SSO_BROWSER_MODULE)
  browser=await chromium.launch({channel:'chrome',headless:true})
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[]
  page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message))
  await page.goto(origin)
  await page.getByRole('textbox',{name:'账号',exact:true}).waitFor()
  assert.equal(new URL(page.url()).origin,origin,'credentials form belongs to application origin')
  assert.equal(await page.getByText('MX 统一账号',{exact:true}).count(),0)
  assert.match(await page.title(),/MX Insight Hub/)
  assert.equal(await page.locator('vite-error-overlay').count(),0)
  assert.equal(await page.locator('body').evaluate(el=>el.scrollWidth>innerWidth),false)
  await page.screenshot({path:'/tmp/mx-native-hub-login.png'})
  const form=await (await context.request.get(`${origin}/auth/sso/form`)).json()
  unavailableAccount=true
  const unavailable=await context.request.get(`${origin}/auth/sso/form`)
  assert.equal(unavailable.status(),503)
  assert.equal((await unavailable.json()).error.message,'账号服务暂不可用，请稍后重试。')
  unavailableAccount=false
  assert.equal((await context.request.post(`${origin}/auth/sso/form`,{headers:{origin:'https://invalid.test','x-mx-hub-csrf':form.csrf},data:{action:'login',formId:form.formId}})).status(),403)
  assert.equal((await context.request.post(`${origin}/auth/sso/form`,{headers:{origin,'x-mx-hub-csrf':form.csrf},data:{action:'login',formId:'stale'}})).status(),409)
  assert.equal((await context.request.post(`${authOrigin}/identity/app-account`,{data:{action:'options',input:{}}})).status(),401)
  const txCookie=(await context.cookies()).find(cookie=>cookie.name==='__Host-mx_hub_login').value
  const transaction=await sso.store.get('login',txCookie)
  const otherAuth={authorization:`Basic ${Buffer.from('other-app:other-secret').toString('base64')}`}
  assert.equal((await context.request.post(`${authOrigin}/identity/app-account`,{headers:otherAuth,data:{action:'options',input:{flow:transaction.flow}}})).status(),410,'another client cannot use Hub flow')
  await page.getByRole('textbox',{name:'账号',exact:true}).fill('ExistingHubUser')
  await page.getByLabel('密码',{exact:true}).fill('incorrect-password')
  await page.getByRole('button',{name:'登录',exact:true}).last().click()
  await page.getByText('账号或密码不正确，或账号不可用。',{exact:true}).waitFor()
  await page.getByLabel('密码',{exact:true}).fill('ExistingPassword123!')
  await page.getByRole('button',{name:'登录',exact:true}).last().click()
  await page.waitForURL(/#\/(my|dashboard)/)
  const session=await (await context.request.get(`${origin}/auth/sso/session`)).json()
  const principal=await (await context.request.get(`${origin}/internal/v1/admin/session`)).json()
  assert.equal(principal.data.memberId,member)
  assert.equal((await pool.query('SELECT role FROM iam.tenant_memberships WHERE member_id=$1',[member])).rows[0].role,'viewer')
  assert.deepEqual((await pool.query("SELECT data FROM mx_platform_records WHERE kind='iam-user' AND id=$1",[old.userId])).rows[0].data,before,'old account unchanged by login')
  assert.equal((await pool.query('SELECT count(*)::int n FROM tenants')).rows[0].n,1,'no duplicate personal tenant for existing member')
  const sid=(await context.cookies()).find(cookie=>cookie.name==='__Host-mx_hub_sso').value
  const saved=await sso.store.get('session',sid)
  assert.equal((await context.request.post(`${authOrigin}/identity/app-account`,{headers:otherAuth,data:{action:'account',input:{accessToken:saved.accessToken}}})).status(),401,'token audience is enforced')
  await page.goto(`${origin}/#/account`)
  await page.getByRole('heading',{name:'个人资料',exact:true}).waitFor()
  await page.screenshot({path:'/tmp/mx-native-hub-account.png'})
  const profileForm=page.locator('form').filter({has:page.getByLabel('显示名称')})
  await profileForm.getByLabel('显示名称').fill('我的 Hub 账号')
  await profileForm.getByLabel('当前密码').fill('ExistingPassword123!')
  await profileForm.getByRole('button',{name:'保存资料'}).click()
  await page.getByText('已保存。',{exact:true}).waitFor()
  const account=await (await context.request.get(`${origin}/auth/sso/account`)).json()
  assert.equal(account.displayName,'我的 Hub 账号');assert.equal(account.sessions.length,1)
  await page.getByText('飞书 · 未绑定',{exact:true}).click()
  await page.getByRole('link',{name:'验证账号并绑定飞书'}).click()
  await page.getByText('绑定已有账号',{exact:true}).click()
  cancelFeishu=true
  await page.getByRole('button',{name:'绑定飞书到我的账号'}).click()
  await page.getByText('飞书登录已取消或过期，请重新尝试。',{exact:true}).waitFor()
  assert.equal(new URL(page.url()).origin,origin)
  cancelFeishu=false
  await page.getByText('绑定已有账号',{exact:true}).click()
  await page.getByRole('button',{name:'绑定飞书到我的账号'}).click()
  await page.getByRole('heading',{name:'完成账号绑定'}).waitFor()
  assert.equal(new URL(page.url()).origin,origin)
  await page.getByRole('textbox',{name:'账号',exact:true}).fill('ExistingHubUser')
  await page.getByLabel('密码',{exact:true}).fill('ExistingPassword123!')
  await page.getByRole('button',{name:'验证并绑定',exact:true}).click()
  await page.waitForURL('**/#/account')
  await page.getByText('飞书 · 已绑定',{exact:true}).waitFor()
  assert.equal((await accounts.account(old.userId)).profile.externalIds.feishuSubject,'fixture:colleague')
  Object.assign(session,await (await context.request.get(`${origin}/auth/sso/session`)).json())
  const unlink=await context.request.post(`${origin}/auth/sso/account`,{headers:{origin,'x-mx-hub-csrf':session.csrf},data:{action:'unlink-feishu',currentPassword:'ExistingPassword123!'}})
  assert.equal(unlink.status(),200,await unlink.text())
  assert.equal((await accounts.account(old.userId)).profile.externalIds.feishuSubject,undefined)
  assert.equal((await context.request.post(`${origin}/auth/sso/account`,{headers:{origin,'x-mx-hub-csrf':session.csrf},data:{action:'password',currentPassword:'wrong-password',password:'NewPassword123!'}})).status(),401)
  const change=await context.request.post(`${origin}/auth/sso/account`,{headers:{origin,'x-mx-hub-csrf':session.csrf},data:{action:'password',currentPassword:'ExistingPassword123!',password:'NewPassword123!'}})
  assert.equal(change.status(),200,await change.text());assert.equal((await change.json()).signedOut,true)
  assert.equal(await accounts.authenticate('ExistingHubUser','ExistingPassword123!'),undefined)
  assert.equal((await accounts.authenticate('ExistingHubUser','NewPassword123!')).userId,old.userId)
  assert.equal((await provider.provider.AccessToken.find(saved.accessToken)),undefined,'password change revokes existing browser token')
  await page.goto(origin)
  await page.getByRole('textbox',{name:'账号',exact:true}).waitFor()
  assert.equal(new URL(page.url()).origin,origin)

  // An invitation-code customer stays in Hub; a closed policy still permits old login.
  await registration.updatePolicy({mode:'invite_code',version:1})
  const invitation=await registration.createInvitation({label:'native signup',days:1,maxUses:1})
  const fresh=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:390,height:844}}),signup=await fresh.newPage()
  signup.setDefaultTimeout(12000);signup.on('pageerror',error=>errors.push(error.message))
  await signup.goto(`${origin}/auth/sso/login?surface=application&view=register`)
  await signup.getByLabel('邀请码',{exact:true}).waitFor()
  assert.equal(await signup.locator('body').evaluate(el=>el.scrollWidth>innerWidth),false)
  await signup.screenshot({path:'/tmp/mx-native-hub-signup-mobile.png',fullPage:true,animations:'disabled'})
  await signup.getByRole('button',{name:'切换主题'}).click()
  await signup.screenshot({path:'/tmp/mx-native-hub-signup-dark.png',fullPage:true,animations:'disabled'})
  assert.equal(await signup.locator('input[name="password"]').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(37, 41, 54)')
  await signup.getByRole('textbox',{name:'账号',exact:true}).fill('NativeCustomer')
  await signup.getByLabel('密码',{exact:true}).fill('CustomerPassword123!')
  await signup.getByLabel('确认密码',{exact:true}).fill('CustomerPassword123!')
  await signup.getByLabel('邀请码',{exact:true}).fill(invitation.code)
  await signup.getByRole('button',{name:'注册并进入 Hub'}).click()
  await signup.waitForURL(/#\/(my|dashboard)/)
  const customer=await accounts.authenticate('NativeCustomer','CustomerPassword123!')
  assert.equal(customer.registration.source.appId,'mx-insight-hub')
  assert.deepEqual(customer.appAccess.deniedAppIds,['mx-h2i','luopan'])
  assert.deepEqual(customer.roleIds,['mx-user'])
  assert.equal((await pool.query('SELECT count(*)::int n FROM api_keys')).rows[0].n,0)
  await registration.updatePolicy({mode:'closed',version:2})
  const logged=await (await fresh.request.get(`${origin}/auth/sso/session`)).json()
  await fresh.request.post(`${origin}/auth/sso/logout`,{headers:{origin,'x-mx-hub-csrf':logged.csrf}})
  await signup.goto(`${origin}/auth/sso/login?surface=application`)
  await signup.waitForURL(/#\/(my|dashboard)/) // Existing Auth session is reused without displaying a form.
  const live=await (await fresh.request.get(`${origin}/auth/sso/session`)).json()
  const all=await fresh.request.post(`${origin}/auth/sso/account`,{headers:{origin,'x-mx-hub-csrf':live.csrf},data:{action:'revoke',target:'all',currentPassword:'CustomerPassword123!'}})
  assert.equal(all.status(),200,await all.text())
  await signup.goto(`${origin}/auth/sso/login?surface=application`)
  await signup.getByRole('textbox',{name:'账号',exact:true}).waitFor()
  assert.equal(await signup.getByRole('button',{name:'邀请码注册',exact:true}).count(),0)
  await signup.getByRole('textbox',{name:'账号',exact:true}).fill('NativeCustomer')
  await signup.getByLabel('密码',{exact:true}).fill('CustomerPassword123!')
  await signup.getByRole('button',{name:'登录',exact:true}).last().click()
  await signup.waitForURL(/#\/(my|dashboard)/)
  assert.equal((await pool.query('SELECT role FROM iam.tenant_memberships WHERE member_id=$1',[member])).rows[0].role,'viewer')

  // A stolen completion URL alone cannot sign another browser in.
  const handoff=await browser.newContext({ignoreHTTPSErrors:true}),handoffPage=await handoff.newPage()
  await handoffPage.goto(`${origin}/auth/sso/login?surface=application`)
  await handoffPage.getByLabel('密码',{exact:true}).waitFor()
  const handoffForm=await (await handoff.request.get(`${origin}/auth/sso/form`)).json()
  const submitted=await handoff.request.post(`${origin}/auth/sso/form`,{headers:{origin,'x-mx-hub-csrf':handoffForm.csrf},data:{action:'login',formId:handoffForm.formId,login:'NativeCustomer',password:'CustomerPassword123!'}})
  assert.equal(submitted.status(),200,await submitted.text())
  const completion=(await submitted.json()).redirect
  const stranger=await browser.newContext({ignoreHTTPSErrors:true})
  const stolen=await stranger.request.get(completion,{maxRedirects:0})
  assert.equal(stolen.status(),400)
  assert.equal((await stranger.cookies()).some(cookie=>cookie.name==='mx_identity'),false)
  await handoffPage.goto(completion)
  await handoffPage.waitForURL(/#\/(my|dashboard)/)

  const expired=await browser.newContext({ignoreHTTPSErrors:true}),expiredPage=await expired.newPage()
  await expiredPage.goto(`${origin}/auth/sso/login?surface=application`)
  await expiredPage.getByLabel('密码',{exact:true}).waitFor()
  const expiredForm=await (await expired.request.get(`${origin}/auth/sso/form`)).json()
  const expiredCookie=(await expired.cookies()).find(cookie=>cookie.name==='__Host-mx_hub_login').value
  const expiredTransaction=await sso.store.get('login',expiredCookie)
  const expiredFlow=await accounts.webState.read('app-flow',expiredTransaction.flow)
  await accounts.adapter('Interaction').destroy(expiredFlow.uid)
  const expiredPost=await expired.request.post(`${origin}/auth/sso/form`,{headers:{origin,'x-mx-hub-csrf':expiredForm.csrf},data:{action:'login',formId:expiredForm.formId,login:'NativeCustomer',password:'CustomerPassword123!'}})
  assert.equal(expiredPost.status(),410)
  assert.deepEqual(errors,[])
  console.log('Native Hub: cross-origin login, old IDs/permissions, code signup, profile/password, session reuse/revocation, CSRF/client isolation, light/dark/mobile passed')
})
