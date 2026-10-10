import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,randomBytes} from 'node:crypto'
import {readFile,readdir} from 'node:fs/promises'
import {createServer} from 'node:http'
import pg from 'pg'
import {harborRoute} from '../../server/portal/harbor.mjs'
import {SsoStore} from '../../server/identity/sso-store.mjs'
import {createApp} from '../../server/app.mjs'
import {HubService} from '../../server/hub-service.mjs'
import {MemoryStore} from '../../server/stores/memory-store.mjs'
test('Portal allowlist rejects admin, supplier, money and document bypass paths',()=>{
 for(const path of ['/runtime','/commerce/delivery','/commerce/tenants/abc/acceptance-orders','/../admin/session','/api-keys/abc/reveal'])assert.throws(()=>harborRoute('GET',path,new URLSearchParams()),{status:404})
 assert.throws(()=>harborRoute('POST','/commerce/products',new URLSearchParams()),{status:404})
 assert.throws(()=>harborRoute('GET','/documentation',new URLSearchParams('path=/docs/procurement')),{status:404})
 assert.equal(harborRoute('GET','/documentation',new URLSearchParams('path=/docs/openapi.json')),'/internal/v1/admin/documentation')
})
test('Public listener never opens portal; admin listener uses only verified customer scope',async t=>{
 const store=new MemoryStore(),service=new HubService({store,adapter:{},apiKeyPepper:'fixture-long-pepper-for-harbor'})
 const principal={kind:'launcher-user',memberId:randomUUID(),displayName:'Harbor fixture',platformAdmin:false,tenantIds:[],memberships:[],capabilities:[],portalOrigin:'https://harbor.example.test'}
 let resolutions=0;const portal={resolve:async()=>{resolutions++;return principal}}
 for(const listenerMode of ['public','admin']){
  const server=createServer(createApp({store,service,adapter:{},listenerMode,harborPortal:portal}));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections()}));const base=`http://127.0.0.1:${server.address().port}`
  const response=await fetch(base+'/internal/v1/portal/session');assert.equal(response.status,listenerMode==='public'?404:200)
  if(response.ok){const {data}=await response.json();assert.equal(data.platformAdmin,false);assert.deepEqual(data.tenantIds,[]);assert.equal(data.publicApiBaseUrl,principal.portalOrigin);assert.equal(data.tenantInvitationsEnabled,false)}
  for(const path of ['/internal/v1/portal/runtime','/internal/v1/portal/commerce/delivery','/internal/v1/admin/session'])assert.notEqual((await fetch(base+path,{headers:{'x-mx-harbor-subject':'root'}})).status,200,path)
 }assert.equal(resolutions,1)
})
const connectionString=process.env.MX_SSO_TEST_DATABASE_URL
test('Shared identity binding reuses Hub member and tenant, preserves platform admin and serializes simultaneous onboarding',{skip:!connectionString},async t=>{
 const target=new URL(connectionString);assert.ok(['127.0.0.1','localhost'].includes(target.hostname)&&target.pathname.includes('sso_test'))
 const admin=new pg.Pool({connectionString}),name=`harbor_mapping_${randomUUID().replaceAll('-','')}`;await admin.query(`CREATE DATABASE ${name}`);target.pathname=`/${name}`;const pool=new pg.Pool({connectionString:target.href}),sessions=new SsoStore(pool,randomBytes(32).toString('base64url'))
 t.after(async()=>{await pool.end();await admin.query(`DROP DATABASE ${name}`);await admin.end()})
 const dir=new URL('../../migrations/',import.meta.url),files=await readdir(dir);for(const prefix of ['001_','007_','124_'])await pool.query(await readFile(new URL(files.find(f=>f.startsWith(prefix)),dir),'utf8'))
 const canonical={issuer:'mx-user-center:test',subject:'user:original',audience:'mx-insight-hub',principal:{displayName:'Original'}},args={issuer:'https://auth.example.test/identity',subject:'original',clientId:'hub',canonical,personalTenant:true}
 const original=await sessions.provision(args);await pool.query("INSERT INTO iam.platform_admins(member_id,granted_via) VALUES($1,'explicit Hub role')",[original]);const before=await pool.query('SELECT * FROM iam.tenant_memberships')
 assert.equal(await sessions.provision({...args,clientId:'harbor',canonical:{...canonical,audience:'mx-harbor'},sharedAudience:'mx-insight-hub'}),original)
 assert.deepEqual((await pool.query('SELECT * FROM iam.tenant_memberships')).rows,before.rows);assert.equal((await pool.query('SELECT * FROM iam.platform_admins')).rowCount,1)
 const fresh={...args,subject:'new',canonical:{...canonical,subject:'user:new'}}
 const [hub,harbor]=await Promise.all([sessions.provision(fresh),sessions.provision({...fresh,clientId:'harbor',canonical:{...fresh.canonical,audience:'mx-harbor'},sharedAudience:'mx-insight-hub'})]);assert.equal(hub,harbor);assert.equal((await pool.query('SELECT * FROM iam.tenant_memberships WHERE member_id=$1',[hub])).rowCount,1)
 await pool.query("UPDATE iam.members SET status='suspended' WHERE id=$1",[original]);await assert.rejects(sessions.provision({...args,clientId:'harbor',sharedAudience:'mx-insight-hub'}),{status:403})
})

test('optional Portal config is loaded at request time and missing/corrupt enrollment cannot break Hub startup',async t=>{
 const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path')
 const {createHarborPortal}=await import('../../server/portal/harbor.mjs')
 const root=mkdtempSync(join(tmpdir(),'hub-harbor-config-'));t.after(()=>rmSync(root,{recursive:true,force:true}))
 const profileFile=join(root,'profile.json'),tokenFile=join(root,'gateway-token')
 const hubSettings={issuer:'https://auth.example.test/identity',audience:'mx-insight-hub',legacyIssuer:'mx-user-center:test'}
 const portal=createHarborPortal({pool:{},store:{},profileFile,tokenFile,hubSettings})
 await assert.rejects(portal.resolve({headers:{}}),{status:503,code:'portal_unavailable'})
 const profile={appId:'mx-harbor',origin:'https://harbor.minsight-ai.com',issuer:hubSettings.issuer,audience:'mx-harbor',clientId:'mx-harbor-web',clientSecret:'s'.repeat(43),sessionKey:'k'.repeat(43)}
 writeFileSync(profileFile,JSON.stringify(profile),{mode:0o600});writeFileSync(tokenFile,'g'.repeat(43),{mode:0o600})
 await assert.rejects(portal.resolve({headers:{'x-mx-harbor-gateway':'wrong'}}),{status:401,code:'portal_auth_required'})
 await assert.rejects(portal.resolve({headers:{'x-mx-harbor-gateway':'g'.repeat(43)}}),{status:401,code:'portal_session_required'})
 writeFileSync(tokenFile,'n'.repeat(43))
 await assert.rejects(portal.resolve({headers:{'x-mx-harbor-gateway':'g'.repeat(43)}}),{status:401,code:'portal_auth_required'})
 writeFileSync(profileFile,JSON.stringify({...profile,audience:hubSettings.audience}))
 await assert.rejects(portal.resolve({headers:{}}),{status:503,code:'portal_unavailable'})
 writeFileSync(profileFile,'{"private":"broken-sensitive')
 await assert.rejects(portal.resolve({headers:{}}),error=>error.status===503&&!error.message.includes('sensitive'))
 rmSync(profileFile);rmSync(tokenFile)
 await assert.rejects(portal.resolve({headers:{}}),{status:503,code:'portal_unavailable'})
})
