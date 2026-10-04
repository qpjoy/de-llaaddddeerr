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

const connectionString=process.env.MX_SSO_TEST_DATABASE_URL
for(const uiPath of ['/', '/admin/']) test(`enterprise invitation journey at ${uiPath}: trusted Auth proof, original registration, browser signup, explicit accept and tenant return`,{skip:!connectionString,timeout:90000},async t=>{
  const url=new URL(connectionString)
  assert.ok(['127.0.0.1','localhost'].includes(url.hostname)&&url.pathname.includes('sso_test'))
  const {createIdentityProvider}=await import('../../../mx-launcher/server/src/identity/provider.ts')
  const {IdentityRepository}=await import('../../../mx-launcher/server/src/identity/repository.ts')
  const {RegistrationRepository}=await import('../../../mx-launcher/server/src/registration/repository.ts')
  const {resolveHubInvitation}=await import('../../../mx-launcher/server/src/identity/hub-invitation.ts')
  const root=new pg.Pool({connectionString}), database=`hub_journey_${randomUUID().replaceAll('-','')}`
  await root.query(`CREATE DATABASE ${database}`);url.pathname=`/${database}`
  const pool=new pg.Pool({connectionString:url.href}), directory=mkdtempSync(join(tmpdir(),'mx-invitation-journey-'))
  let server,accounts,registration,provider,sso,origin
  const pendingRequests=new Set()
  const previousCa=globalAgent.options.ca
  t.after(async()=>{
    if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections()})
    await Promise.all([...pendingRequests])
    globalAgent.options.ca=previousCa
    await registration?.close();await accounts?.close();await pool.end();await root.query(`DROP DATABASE ${database} WITH (FORCE)`);await root.end();rmSync(directory,{recursive:true,force:true})
  })
  const migrations=new URL('../../migrations/',import.meta.url)
  const files=readdirSync(migrations)
  for(const prefix of ['001_','007_','124_','125_'])await pool.query(readFileSync(new URL(files.find(name=>name.startsWith(prefix)),migrations),'utf8'))
  await pool.query('CREATE TABLE mx_platform_records(environment text,kind text,id text,site_id text,data jsonb,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),PRIMARY KEY(environment,kind,id))')
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',join(directory,'key'),'-out',join(directory,'cert')],{stdio:'ignore'})
  const cert=readFileSync(join(directory,'cert')),key=readFileSync(join(directory,'key'))
  // Test-only local CA; production uses the normal verified TLS trust store.
  globalAgent.options.ca=cert
  const json=(res,status,value)=>res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify(value))
  server=createServer({cert,key},async(req,res)=>{
    let complete
    const pending=new Promise(resolve=>{complete=resolve});pendingRequests.add(pending)
    try {
      let path=new URL(req.url,origin).pathname
      if(uiPath==='/admin/' && path==='/'){res.writeHead(302,{location:'/admin/'}).end();return}
      if(uiPath==='/admin/' && path.startsWith('/admin/'))path=path.slice('/admin'.length)
      if(path.startsWith('/identity/'))return await provider.handle(req,res)
      if(await sso.handle(req,res,new URL(req.url,origin)))return
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
    }catch(error){if(!res.destroyed)return json(res,error.status||500,{message:error.message})}
    finally{pendingRequests.delete(pending);complete()}
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`https://127.0.0.1:${server.address().port}`
  const issuer=`${origin}/identity`,clientSecret=randomBytes(32).toString('hex')
  accounts=new IdentityRepository(url.href,'test','invitation-journey','fixture-rate');await accounts.initialize()
  registration=new RegistrationRepository(url.href,'test','launcher','fixture')
  const pair=generateKeyPairSync('rsa',{modulusLength:2048})
  const app={origin,clientId:'hub',clientSecret,appId:'mx-insight-hub',audience:'mx-insight-hub'}
  provider=createIdentityProvider({origin,issuer,clientId:'launcher',clientSecret:'fixture-launcher',cookieKeys:['fixture-cookie-key'],jwks:{keys:[{...pair.privateKey.export({format:'jwk'}),kid:'fixture',alg:'RS256',use:'sig'}]},applications:[app]},accounts,name=>accounts.adapter(name),{
    policy:source=>registration.policy(source),register:input=>registration.register({...input,clientId:'launcher'})
  })
  const identity=new IdentityService({store:new PostgresStore(pool),client:{enabled:true}})
  sso=createSso({settings:{origin,issuer,clientId:'hub',clientSecret,legacyIssuer:'mx-user-center:test',audience:'mx-insight-hub',sessionKey:randomBytes(32).toString('base64url'),caCert:cert.toString(),personalTenant:true},pool,identity,adminToken:'fixture-admin'})
  const invitation=await sso.invitations.create(adminTokenPrincipal(),{requestId:randomUUID(),tenantName:'A 公司',role:'owner',label:'首位负责人',days:7,allowRegistration:true})
  const token=new URLSearchParams(new URL(invitation.url).hash.split('?')[1]).get('invitation'),jar=new Map()
  const request=(path,{method='GET',body,headers={}}={})=>new Promise((resolve,reject)=>{
    const req=httpsRequest(new URL(path,origin),{ca:cert,method,headers:{cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; '),...headers}},res=>{
      for(const value of res.headers['set-cookie']||[]){const [k,v]=value.split(';')[0].split('=');jar.set(k,v)}
      let text='';res.on('data',chunk=>{text+=chunk});res.on('end',()=>resolve({status:res.statusCode,location:res.headers.location,text}))
    });req.on('error',reject);req.end(body)
  })
  assert.equal((await request('/auth/sso/invitation/start',{method:'POST',headers:{origin:'https://wrong.test'},body:JSON.stringify({token})})).status,403)
  assert.equal((await request('/auth/sso/invitation/start',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({token})})).status,200)
  const started=await request('/auth/sso/login?invitation=1'),handle=new URL(started.location).searchParams.get('mx_invitation')
  assert.ok(handle && handle!==jar.get('__Host-mx_hub_invitation'),'registration context cannot serve as the membership bearer')
  assert.equal((await resolveHubInvitation(app,issuer,handle)).invitationId,invitation.id)
  await assert.rejects(resolveHubInvitation({...app,clientSecret:'wrong-secret'},issuer,handle))
  await sso.invitations.revoke(adminTokenPrincipal(),invitation.id)
  await assert.rejects(resolveHubInvitation(app,issuer,handle),'revocation invalidates an already opened signup context')

  if(!process.env.MX_SSO_BROWSER_MODULE)return
  const {chromium}=await import(process.env.MX_SSO_BROWSER_MODULE)
  const browser=await chromium.launch({channel:'chrome',headless:true})
  try {
    const adminContext=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}})
    adminContext.setDefaultTimeout(10000)
    await adminContext.addInitScript(()=>sessionStorage.setItem('mx-insight-hub.admin-token','fixture-admin'))
    const adminPage=await adminContext.newPage(),errors=[]
    adminPage.on('pageerror',error=>errors.push(error.message))
    adminPage.on('console',message=>{if(message.type()==='error')errors.push({message:message.text(),url:message.location().url})})
    await adminPage.goto(`${origin}/#/team`)
    await adminPage.getByRole('button',{name:'邀请成员',exact:true}).click()
    // The first tenant is available; this journey invites into that exact original tenant.
    await adminPage.getByRole('textbox',{name:/^邀请备注/}).fill('邀请新同事')
    const [created]=await Promise.all([adminPage.waitForResponse(response=>response.url().endsWith('/internal/v1/admin/tenant-invitations') && response.request().method()==='POST'),adminPage.getByRole('button',{name:'生成邀请链接',exact:true}).click()])
    assert.equal(created.status(),200,await created.text())
    const link=await adminPage.getByRole('textbox',{name:/^一次性邀请链接/}).inputValue()
    await adminPage.screenshot({animations:'disabled',path:'/tmp/mx-enterprise-invite-created.png'})
    const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:960}}),page=await context.newPage()
    context.setDefaultTimeout(10000)
    page.on('pageerror',error=>errors.push(error.message))
    page.on('console',message=>{if(message.type()==='error')errors.push({message:message.text(),url:message.location().url})})
    await page.goto(link)
    await page.getByRole('link',{name:'登录或注册后继续'}).waitFor()
    assert.match(await page.title(),/MX Insight Hub/)
    assert.equal(await page.locator('vite-error-overlay').count(),0)
    assert.ok(!page.url().includes('invitation='),'secret fragment removed after exchanging for HttpOnly context')
    await page.screenshot({animations:'disabled',path:'/tmp/mx-enterprise-join-desktop.png'})
    await page.getByRole('link',{name:'登录或注册后继续'}).click()
    await page.getByRole('button',{name:'注册',exact:true}).click()
    assert.equal(await page.locator('#inviteCode').count(),0,'no second registration code')
    await page.getByRole('textbox',{name:'账号',exact:true}).fill('InvitedColleague');await page.getByLabel('密码',{exact:true}).fill('InvitationPassword123!');await page.getByLabel('确认密码',{exact:true}).fill('InvitationPassword123!')
    await page.getByRole('button',{name:'注册并进入 Hub',exact:true}).click()
    await page.waitForURL('**/#/join')
    await page.getByRole('button',{name:'确认接受并加入'}).waitFor()
    assert.equal((await pool.query('SELECT count(*)::int n FROM tenants')).rows[0].n,1,'invited signup does not create a personal tenant')
    assert.equal((await pool.query('SELECT count(*)::int n FROM iam.tenant_memberships')).rows[0].n,0,'login alone is not acceptance')
    await page.setViewportSize({width:390,height:844});await page.reload()
    await page.getByRole('button',{name:'确认接受并加入'}).waitFor()
    assert.equal(await page.locator('body').evaluate(el=>el.scrollWidth>innerWidth),false)
    await page.screenshot({animations:'disabled',path:'/tmp/mx-enterprise-join-mobile.png'})
    await page.getByRole('button',{name:'切换亮暗主题'}).click()
    await page.screenshot({animations:'disabled',path:'/tmp/mx-enterprise-join-dark.png'})
    const status=await (await context.request.get(`${origin}/auth/sso/invitation`)).json()
    assert.equal((await context.request.post(`${origin}/auth/sso/invitation/accept`,{headers:{origin,'x-mx-hub-csrf':'wrong'}})).status(),403)
    // Cookies are shared across tabs. A stale page must never accept another invitation silently.
    const stale=await context.request.post(`${origin}/auth/sso/invitation/accept`,{headers:{origin,'x-mx-hub-csrf':status.csrf},data:{invitationId:randomUUID()}})
    assert.equal(stale.status(),409)
    assert.equal((await pool.query('SELECT count(*)::int n FROM iam.tenant_memberships')).rows[0].n,0)
    await page.getByRole('button',{name:'确认接受并加入'}).click()
    await page.waitForURL(`**/#/my?tenantId=${invitation.tenantId}`)
    const memberships=(await pool.query('SELECT * FROM iam.tenant_memberships')).rows
    assert.equal(memberships.length,1);assert.equal(memberships[0].member_id,status.user.memberId);assert.equal(memberships[0].role,'viewer')
    const replay=await context.request.post(`${origin}/auth/sso/invitation/accept`,{headers:{origin,'x-mx-hub-csrf':status.csrf},data:{invitationId:status.invitation.id}})
    assert.equal(replay.status(),200);assert.equal((await replay.json()).alreadyMember,true)
    const mxUsers=(await pool.query("SELECT data FROM mx_platform_records WHERE kind='iam-user'")).rows
    assert.equal(mxUsers.length,1);assert.deepEqual(mxUsers[0].data.roleIds,['mx-user'])
    assert.equal(mxUsers[0].data.registration.source.appId,'mx-insight-hub')
    assert.equal(mxUsers[0].data.registration.source.clientId,'hub')
    assert.deepEqual(mxUsers[0].data.appAccess.deniedAppIds,['mx-h2i','luopan'])
    assert.equal((await pool.query('SELECT count(*)::int n FROM api_keys')).rows[0].n,0)
    assert.deepEqual(errors,[])
    console.log('Enterprise browser journey: admin creates link, no extra signup code, original tenant, explicit acceptance, mobile/dark theme, no new keys or JS errors')

    // A normal Hub signup uses its own mode, without an enterprise invitation or second code.
    await registration.updatePolicy({mode:'invite_code',hubMode:'open',version:0})
    const publicContext=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1280,height:900}}),signup=await publicContext.newPage()
    publicContext.setDefaultTimeout(10000)
    signup.on('pageerror',error=>errors.push(error.message))
    await signup.goto(`${origin}/auth/sso/login`)
    await signup.getByRole('link',{name:'创建账号',exact:true}).click()
    assert.equal(await signup.locator('#inviteCode').count(),0)
    await signup.screenshot({animations:'disabled',path:'/tmp/mx-hub-open-signup.png'})
    await signup.locator('#login').fill('PublicHubCustomer');await signup.locator('#password').fill('PublicPassword123!');await signup.locator('#passwordConfirm').fill('PublicPassword123!')
    await signup.locator('form').evaluate(form=>{const input=document.createElement('input');input.type='hidden';input.name='source';input.value=JSON.stringify({appId:'mx-launcher',clientId:'spoofed'});form.append(input)})
    await signup.getByRole('button',{name:'注册并继续',exact:true}).click()
    await signup.waitForURL('**/#/dashboard?range=24h')
    const customer=(await pool.query("SELECT data FROM mx_platform_records WHERE kind='iam-user' AND data->>'account'='PublicHubCustomer'")).rows[0].data
    assert.deepEqual(customer.registration.source,{issuer,clientId:'hub',appId:'mx-insight-hub',appOrigin:origin})
    assert.equal(customer.registration.policyVersion,1)
    assert.deepEqual(customer.appAccess.deniedAppIds,['mx-h2i','luopan'])
    assert.equal((await pool.query('SELECT count(*)::int n FROM tenants')).rows[0].n,2,'ordinary Hub signup follows the existing personal-space policy')
    assert.equal((await pool.query('SELECT count(*)::int n FROM api_keys')).rows[0].n,0)
    await registration.updatePolicy({mode:'invite_code',hubMode:'closed',version:1})
    await publicContext.clearCookies()
    await signup.goto(`${origin}/auth/sso/login`)
    await signup.locator('#login').waitFor()
    assert.equal(await signup.getByRole('link',{name:'创建账号',exact:true}).count(),0)
    await signup.locator('#login').fill('PublicHubCustomer');await signup.locator('#password').fill('PublicPassword123!')
    await signup.getByRole('button',{name:'登录并继续',exact:true}).click()
    await signup.waitForURL('**/#/dashboard?range=24h')
    assert.deepEqual(errors,[])
    console.log('Hub open signup: application mode, trusted origin ignores browser spoofing, personal space without API keys, default network denial')
  }finally{await browser.close()}
})
