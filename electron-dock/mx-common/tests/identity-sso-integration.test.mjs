import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createServer, request as httpsRequest } from 'node:https'
import pg from 'pg'
import { createApplicationSso } from '../src/identity/sso.mjs'
import { createHarborApp } from '../../mx-dataport/apps/server/app.mjs'
import { PostgresSsoStore } from '../src/identity/postgres-store.mjs'

const connectionString=process.env.MX_SSO_TEST_DATABASE_URL

test('two ordinary applications share real Auth, with separate durable sessions and local permissions, without Hub schema', {skip:!connectionString,timeout:60000}, async t=>{
  const url=new URL(connectionString)
  assert.ok(['127.0.0.1','localhost'].includes(url.hostname) && url.pathname.includes('sso_test'))
  const {createIdentityProvider}=await import('../../mx-launcher/server/src/identity/provider.ts')
  const {IdentityRepository}=await import('../../mx-launcher/server/src/identity/repository.ts')
  const admin=new pg.Pool({connectionString}), name=`common_sso_${randomUUID().replaceAll('-','')}`
  await admin.query(`CREATE DATABASE ${name}`); url.pathname=`/${name}`
  const pool=new pg.Pool({connectionString:url.href}), dir=mkdtempSync(join(tmpdir(),'common-sso-'))
  const servers=[]; let repository, provider, unavailable=false, blocked=false, logins=0
  t.after(async()=>{
    await Promise.all(servers.map(server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections()})))
    await repository?.close(); await pool.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end()
    rmSync(dir,{recursive:true,force:true})
  })
  const schema=readFileSync(new URL('../src/identity/schema.sql',import.meta.url),'utf8')
  await pool.query(schema)
  // Distinct consumer schemas simulate separate application databases in this isolated fixture.
  await pool.query(schema.replaceAll('app_auth','second_auth'))
  await pool.query(schema.replaceAll('app_auth','third_auth'))
  repository=new IdentityRepository(url.href,'test',name,'test-rate');await repository.initialize()
  await pool.query('CREATE TABLE mx_platform_records(kind text,id text,environment text,data jsonb,PRIMARY KEY(kind,id,environment))')
  await pool.query("INSERT INTO mx_platform_records VALUES('iam-user','person','test',$1)",[{userId:'person',account:'person',status:'active',displayName:'Shared person',appAccess:{deniedAppIds:[]}}])
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',join(dir,'key'),'-out',join(dir,'cert')],{stdio:'ignore'})
  const cert=readFileSync(join(dir,'cert')),key=readFileSync(join(dir,'key'))
  async function listen(handler) {
    const server=createServer({cert,key},handler); servers.push(server)
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
    return `https://127.0.0.1:${server.address().port}`
  }
  const authOrigin=await listen((req,res)=>{
    if(unavailable && req.url.startsWith('/identity/me'))return res.writeHead(503).end('test unavailable')
    return provider.handle(req,res)
  }),issuer=`${authOrigin}/identity`
  const applications=[]
  for(const [appId,table] of [['mx-example','app_auth.browser_sso_records'],['mx-other','second_auth.browser_sso_records'],['mx-harbor','third_auth.browser_sso_records']]) {
    const app={appId,clientId:`${appId}-web`,clientSecret:randomBytes(32).toString('base64url'),audience:appId,grants:[]}
    app.origin=await listen(async(req,res)=>{
      if (appId === 'mx-harbor' && req.url.startsWith('/auth/login')) return app.bff(req,res)
      try {
        if(await app.sso.handle(req,res,new URL(req.url,app.origin)))return
        const principal=await app.sso.principal(req)
        if(!principal)return res.writeHead(401).end()
        if(req.url==='/manage'&&!principal.permissions.includes('manage'))return res.writeHead(403).end()
        res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(principal))
      } catch(error) {res.writeHead(error.status||500,{'content-type':'application/json'}).end(JSON.stringify({code:error.code,message:error.message}))}
    })
    app.settings={...app,issuer,scope:'openid mx:identity',sessionKey:randomBytes(32).toString('base64url'),caCert:cert.toString()}
    app.store=new PostgresSsoStore(pool,app.settings.sessionKey,{table})
    app.restart=()=>{
      app.sso=createApplicationSso({settings:app.settings,store:app.store,navigation:app.navigation,
        ...(appId === 'mx-harbor' ? {onAuthenticated:()=>({cookies:['__Host-mx_dataport_local=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0']})} : {}),
        resolvePrincipal:identity=>({issuer:identity.issuer,subject:identity.subject,displayName:identity.displayName,permissions:app.grants})})
      if (appId === 'mx-harbor') app.bff=createHarborApp({config:{sso:app.settings,upstream:'http://fixture-hub',gatewayToken:'fixture-gateway'},sso:app.sso,
        fetch:async(url,options)=>{assert.ok(url.endsWith('/local/resolve'));assert.deepEqual(JSON.parse(options.body),{account:app.expectedLogin ?? 'person'});return Response.json({data:{exists:false}})}})
    }
    app.restart();applications.push(app)
  }
  const account=()=>({userId:'person',displayName:'Shared person',status:'active',appAccess:{allowedAppIds:['mx-harbor'],deniedAppIds:blocked?['mx-example','mx-other']:[]}})
  const accounts={webState:repository.webState,hasLogin:repository.hasLogin.bind(repository),account:async()=>account(),authenticate:async(login,password)=>{
    if(login!=='person'||password!=='test-password')return undefined
    logins++;return account()
  },allowAttempt:async()=>true,hubIdentity:async(user,audience)=>({issuer:'mx-user-center:test',subject:`user:${user.userId}`,audience,
    principal:{userId:user.userId,kind:'user',displayName:user.displayName,scopes:['mx:admin'],organizationIds:[]}}),
    withBrowserRequest:repository.withBrowserRequest.bind(repository),browserSessions:repository.browserSessions.bind(repository),revokeBrowserSessions:repository.revokeBrowserSessions.bind(repository)}
  const pair=generateKeyPairSync('rsa',{modulusLength:2048})
  provider=createIdentityProvider({origin:authOrigin,issuer,clientId:'launcher',clientSecret:'launcher-fixture',cookieKeys:['fixture-cookie'],
    jwks:{keys:[{...pair.privateKey.export({format:'jwk'}),kid:'fixture',alg:'RS256',use:'sig'}]},applications},accounts,name=>repository.adapter(name))
  const jar=new Map()
  function request(target,{method='GET',body,headers={},cookies=true}={}) {
    return new Promise((resolve,reject)=>{
      const req=httpsRequest(target,{ca:cert,method,headers:{...(cookies?{cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; ')}:{}),...headers}},res=>{
        for(const raw of res.headers['set-cookie']||[]){const [k,v]=raw.split(';')[0].split('=');jar.set(k,v)}
        let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,text,headers:res.headers,location:res.headers.location}))
      });req.on('error',reject);req.end(body)
    })
  }
  async function login(app) {
    let step=await request(`${app.origin}/auth/sso/login`), target
    assert.equal(step.status,303,step.text)
    assert.equal(new URL(step.location).searchParams.get('scope'),'openid mx:identity')
    for(let i=0;i<12&&step.location;i++) {
      target=new URL(step.location,issuer).href
      if(new URL(target).pathname==='/auth/sso/callback')return {callback:target,result:await request(target)}
      step=await request(target)
      if(step.status===200) {
        const csrf=/name="csrf" value="([^"]+)"/.exec(step.text)?.[1]
        assert.ok(csrf,step.text)
        step=await request(target,{method:'POST',headers:{origin:authOrigin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,login:'person',password:'test-password'}).toString()})
      }
      assert.equal(step.status,303,step.text)
    }
    assert.fail('OIDC flow did not complete')
  }
  const [a,b]=applications
  const first=await login(a);assert.equal(first.result.status,303,first.result.text)
  assert.equal(first.result.location,'/?sso=ready')
  assert.equal((await request(first.callback)).status,400,'callback is single use')
  const second=await login(b);assert.equal(second.result.status,303,second.result.text)
  assert.equal(logins,1,'second application reuses Auth session')
  assert.deepEqual(JSON.parse((await request(`${a.origin}/whoami`)).text).permissions,[],'Auth admin scope does not grant product roles')
  assert.equal((await request(`${a.origin}/manage`)).status,403)
  a.grants=['manage'];assert.equal((await request(`${a.origin}/manage`)).status,200)
  assert.equal((await request(`${b.origin}/manage`)).status,403,'application authorization remains separate')
  const oldSid=jar.get('__Host-mx-example_sso');a.restart()
  assert.equal((await request(`${a.origin}/manage`)).status,200,'restart preserves the encrypted session')
  assert.equal(jar.get('__Host-mx-example_sso'),oldSid)
  const status=JSON.parse((await request(`${a.origin}/auth/sso/session`)).text)
  assert.equal((await request(`${a.origin}/whoami`,{method:'POST',headers:{origin:a.origin}})).status,403)
  assert.equal((await request(`${a.origin}/whoami`,{method:'POST',headers:{origin:a.origin,'x-mx-csrf':status.csrf}})).status,200)
  assert.equal((await request(`${a.origin}/whoami`,{method:'POST',headers:{origin:b.origin,'x-mx-csrf':status.csrf}})).status,403)
  const aSession=await a.store.get('session',oldSid), bSid=jar.get('__Host-mx-other_sso')
  const stolen=randomBytes(32).toString('base64url');await b.store.put('session',stolen,aSession,300)
  assert.equal((await request(`${b.origin}/whoami`,{cookies:false,headers:{cookie:`__Host-mx-other_sso=${stolen}`}})).status,401,'another client token cannot become an application session')
  jar.set('__Host-mx-other_sso',bSid)
  const discovery=JSON.parse((await request(`${issuer}/.well-known/openid-configuration`)).text)
  // Intercept exactly the discovered UserInfo endpoint for an outage, without altering tokens.
  const authServer=servers[0], original=authServer.listeners('request')[0]
  authServer.removeListener('request',original);authServer.on('request',(req,res)=>{
    if(unavailable && new URL(req.url,authOrigin).pathname===new URL(discovery.userinfo_endpoint).pathname)return res.writeHead(503).end('fixture outage')
    return original(req,res)
  })
  unavailable=true
  assert.equal((await request(`${a.origin}/auth/sso/session`)).status,503)
  assert.ok(await a.store.get('session',oldSid),'outage retains the existing session')
  unavailable=false
  assert.equal(JSON.parse((await request(`${a.origin}/auth/sso/session`)).text).active,true)
  // Stored transactions use atomic consume across replicas and retain original deadlines.
  const tx=randomBytes(32).toString('base64url');await a.store.put('login',tx,{state:'one-use'},300)
  const consumed=await Promise.all([a.store.get('login',tx,true),a.store.get('login',tx,true)])
  assert.equal(consumed.filter(Boolean).length,1)
  const expired=randomBytes(32).toString('base64url');await a.store.put('login',expired,{state:'expired'},-1)
  assert.equal(await a.store.update('login',expired,{state:'renewed'}),false)
  assert.equal(await a.store.get('login',expired),null)
  assert.equal((await request(`${a.origin}/auth/sso/logout`,{method:'POST',headers:{origin:a.origin,'x-mx-csrf':status.csrf}})).status,204)
  assert.equal(JSON.parse((await request(`${b.origin}/auth/sso/session`)).text).active,true,'local logout does not clear other applications')
  // Opt-in native UI starts with a checked backchannel and a browser OIDC round trip.
  assert.equal((await request(`${b.origin}/auth/sso/start`,{method:'POST',headers:{origin:b.origin}})).status,404,'legacy consumers do not expose the new endpoint')
  a.navigation={applicationForm:true};a.restart()
  const start=()=>request(`${a.origin}/auth/sso/start`,{method:'POST',headers:{origin:a.origin,'content-type':'application/json'},body:'{}'})
  assert.equal((await request(`${a.origin}/auth/sso/start`,{method:'POST',headers:{origin:b.origin}})).status,403)
  a.settings.clientSecret='not-the-registered-secret';a.restart()
  const mismatch=await start();assert.equal(mismatch.status,503);assert.equal(mismatch.location,undefined)
  assert.equal(JSON.parse(mismatch.text).code,'sso_application_unavailable')
  a.settings.clientSecret=a.clientSecret;a.restart()
  let step=await start();assert.equal(step.status,200,step.text)
  const authorization=new URL(JSON.parse(step.text).redirect)
  assert.equal(authorization.searchParams.get('mx_surface'),'application');assert.equal(authorization.searchParams.get('prompt'),'login')
  step=await request(authorization);assert.equal(step.status,303,step.text)
  step=await request(new URL(step.location,issuer));assert.equal(step.status,303,step.text)
  assert.equal(new URL(step.location).origin,a.origin,'native form returns to application instead of hosted password UI')
  const interaction=new URL(step.location);interaction.searchParams.set('state','wrong')
  assert.equal((await request(interaction)).status,400,'browser state binds the native flow')
  step=await request(step.location);assert.equal(step.location,'/?account=1#/account')
  const form=JSON.parse((await request(`${a.origin}/auth/sso/form`)).text)
  assert.ok(form.csrf&&form.formId);assert.equal(form.view,'login')
  const submit=(csrf,formId=form.formId,password='test-password')=>request(`${a.origin}/auth/sso/form`,{method:'POST',headers:{origin:a.origin,'x-mx-csrf':csrf,'content-type':'application/json'},body:JSON.stringify({action:'login',formId,login:'person',password})})
  assert.equal((await submit('wrong')).status,409)
  assert.equal((await submit(form.csrf,'another-form')).status,409)
  assert.equal((await submit(form.csrf,form.formId,'wrong')).status,401)
  step=await submit(form.csrf);assert.equal(step.status,200,step.text)
  step=await request(JSON.parse(step.text).redirect)
  for(let i=0;i<12&&step.location;i++) {
    const next=new URL(step.location,issuer)
    step=await request(next)
    if(next.pathname==='/auth/sso/callback')break
  }
  assert.equal(step.status,303,step.text);assert.equal(step.location,'/?sso=ready')
  assert.equal(JSON.parse((await request(`${a.origin}/auth/sso/session`)).text).active,true)
  // DataPort opts into password login only. Cached invite forms cannot register
  // or redeem a code, while ordinary applications keep their existing behavior.
  a.navigation={applicationForm:true,loginOnly:true};a.restart()
  const onlyStart=await request(`${a.origin}/auth/sso/start?view=register`,{method:'POST',headers:{origin:a.origin,'content-type':'application/json'},body:'{}'})
  assert.equal((await a.store.get('login',jar.get('__Host-mx-example_login'))).view,'login')
  let onlyStep=await request(JSON.parse(onlyStart.text).redirect)
  for(let i=0;i<12&&onlyStep.location;i++) {
    const next=new URL(onlyStep.location,issuer);onlyStep=await request(next)
    if(next.origin===a.origin&&next.pathname==='/auth/sso/interaction')break
  }
  assert.equal(onlyStep.location,'/?account=1#/account')
  const onlyForm=JSON.parse((await request(`${a.origin}/auth/sso/form`)).text)
  assert.equal(onlyForm.view,'login')
  const onlySubmit=body=>request(`${a.origin}/auth/sso/form`,{method:'POST',headers:{origin:a.origin,'x-mx-csrf':onlyForm.csrf,'content-type':'application/json'},body:JSON.stringify({formId:onlyForm.formId,login:'person',password:'test-password',...body})})
  const authBefore=logins
  for(const action of ['register','feishu','feishu-link']) {
    const rejected=await onlySubmit({action,inviteCode:'synthetic-invite-fixture'})
    assert.equal(rejected.status,403);assert.equal(JSON.parse(rejected.text).code,'account_registration_disabled')
  }
  const inviteRejected=await onlySubmit({action:'login',inviteCode:'synthetic-invite-fixture'})
  assert.equal(inviteRejected.status,400);assert.equal(JSON.parse(inviteRejected.text).code,'account_invitation_disabled')
  assert.equal(logins,authBefore,'disabled actions never reach Auth authentication or redemption')
  onlyStep=await onlySubmit({action:'login'})
  assert.equal(onlyStep.status,200,onlyStep.text)
  onlyStep=await request(JSON.parse(onlyStep.text).redirect)
  for(let i=0;i<12&&onlyStep.location;i++) {
    const next=new URL(onlyStep.location,issuer);onlyStep=await request(next)
    if(next.pathname==='/auth/sso/callback')break
  }
  assert.equal(onlyStep.status,303,onlyStep.text)
  assert.equal(JSON.parse((await request(`${a.origin}/auth/sso/session`)).text).active,true)
  b.navigation={applicationForm:true};b.restart()
  assert.equal((await request(`${b.origin}/auth/sso/start?view=register`,{method:'POST',headers:{origin:b.origin,'content-type':'application/json'},body:'{}'})).status,200)
  assert.equal((await b.store.get('login',jar.get('__Host-mx-other_login'))).view,'register','other applications retain invitation registration')
  // Real BFF routing + real Auth + TLS + durable PG + normal browser OIDC.
  const c=applications[2]
  c.navigation={applicationForm:true,loginOnly:true,loginAdmission:true,unifiedLogin:true};c.restart()
  const unified=(body={},headers={})=>request(`${c.origin}/auth/login`,{method:'POST',headers:{origin:c.origin,'content-type':'application/json',...headers},body:JSON.stringify({login:'person',password:'test-password',...body})})
  c.expectedLogin='unknown';assert.equal((await unified({login:'unknown'})).status,401);c.expectedLogin='person'
  jar.set('__Host-mx_dataport_local','stale-local-cookie')
  const prepared=await request(`${c.origin}/auth/login/prepare`,{method:'POST',headers:{origin:c.origin,'content-type':'application/json'},body:JSON.stringify({login:'person'})})
  assert.equal(prepared.status,200,prepared.text);assert.ok(JSON.parse(prepared.text).redirect.startsWith(authOrigin))
  const cold=await unified({inviteCode:'not-persisted'});assert.equal(cold.status,200,cold.text)
  const unifiedTx=await c.store.get('login',jar.get('__Host-mx-harbor_login'))
  assert.equal(unifiedTx.loginHint,'person');assert.ok(!JSON.stringify(unifiedTx).includes('test-password'));assert.ok(!JSON.stringify(unifiedTx).includes('not-persisted'))
  assert.ok(!JSON.parse(cold.text).redirect.includes('test-password'));assert.ok(!JSON.parse(cold.text).redirect.includes('not-persisted'))
  let cs=await request(JSON.parse(cold.text).redirect)
  for(let i=0;i<12&&cs.location;i++) {
    const next=new URL(cs.location,issuer);cs=await request(next)
    if(next.origin===c.origin&&next.pathname==='/auth/sso/interaction')break
  }
  assert.equal(cs.location,'/?account=1#/account',cs.text)
  const cf=JSON.parse((await request(`${c.origin}/auth/sso/form`)).text);assert.equal(cf.loginHint,'person')
  const ready=await request(`${c.origin}/auth/login/prepare`,{method:'POST',headers:{origin:c.origin,'content-type':'application/json'},body:JSON.stringify({login:'person'})});assert.deepEqual(JSON.parse(ready.text),{ready:true})
  assert.equal((await unified({formId:cf.formId})).status,409,'missing browser CSRF cannot authenticate')
  assert.equal((await unified({formId:cf.formId,password:'incorrect'},{'x-mx-csrf':cf.csrf})).status,401)
  const noSignup=await request(`${c.origin}/auth/sso/form`,{method:'POST',headers:{origin:c.origin,'content-type':'application/json','x-mx-csrf':cf.csrf},body:JSON.stringify({action:'register',formId:cf.formId})})
  assert.equal(noSignup.status,403,'admission does not restore registration')
  cs=await unified({formId:cf.formId,inviteCode:'already-admitted-does-not-redeem'},{'x-mx-csrf':cf.csrf});assert.equal(cs.status,200,cs.text)
  cs=await request(JSON.parse(cs.text).redirect)
  let cCallback
  for(let i=0;i<12&&cs.location;i++) {
    const next=new URL(cs.location,issuer);cs=await request(next)
    if(next.pathname==='/auth/sso/callback'){cCallback=next.href;break}
  }
  assert.equal(cs.status,303,cs.text);assert.equal(cs.location,'/?sso=ready')
  assert.equal(jar.get('__Host-mx_dataport_local'),'','MX success clears an old local identity')
  assert.equal(JSON.parse((await request(`${c.origin}/auth/sso/session`)).text).active,true)
  assert.equal((await request(cCallback)).status,400,'unified callback remains single use')
  const staleUnified=await unified({formId:'stale-form'},{'x-mx-csrf':cf.csrf});assert.equal(staleUnified.status,410,'stale submission is not replayed or silently restarted')
  blocked=true
  assert.equal(JSON.parse((await request(`${b.origin}/auth/sso/session`)).text).active,false,'upstream application ban invalidates the session')
  assert.equal((await pool.query("SELECT to_regclass('iam.members') AS members,to_regclass('public.tenants') AS tenants")).rows[0].members,null)
  assert.equal((await pool.query("SELECT to_regclass('public.tenants') AS tenants")).rows[0].tenants,null)
})
