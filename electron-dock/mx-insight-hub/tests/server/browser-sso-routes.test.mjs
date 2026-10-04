import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createApp } from '../../server/app.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { HubService } from '../../server/hub-service.mjs'

for (const listenerMode of ['admin', 'public']) test(`SSO route isolation and explicit credential precedence on ${listenerMode}`, async t => {
  let cookieCalls = 0, handlerCalls = 0
  const store = new MemoryStore()
  const principal = { kind: 'launcher-user', memberId: 'fixture', displayName: 'SSO fixture', platformAdmin: false, tenantIds: [], capabilities: [], memberships: [] }
  const sso = { principal: async () => { cookieCalls++; return principal }, handle: async (_req, res, url) => {
    if (!url.pathname.startsWith('/auth/sso/')) return false
    handlerCalls++;res.writeHead(200).end('sso');return true
  } }
  const service = new HubService({ store, adapter: {}, apiKeyPepper: 'test-pepper-at-least-32-characters-long' })
  const server = createServer(createApp({ store, service, identity: { enabled: true, resolve: async () => null }, adminToken: 'test-admin-token', sso, listenerMode }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  let r = await fetch(`${base}/auth/sso/session`)
  assert.equal(r.status,listenerMode==='admin'?200:404)
  assert.equal(handlerCalls,listenerMode==='admin'?1:0)
  r=await fetch(`${base}/internal/v1/admin/session`)
  assert.equal(r.status,listenerMode==='admin'?200:404)
  assert.equal(cookieCalls,listenerMode==='admin'?1:0)
  if(listenerMode==='public')return
  assert.equal((await r.json()).data.memberId,'fixture')
  for(const headers of [{authorization:'Bearer invalid'},{authorization:'Basic invalid'},{'x-api-key':'mih_live_invalid'}]) {
    const before=cookieCalls;r=await fetch(`${base}/internal/v1/admin/session`,{headers})
    assert.ok([401,403].includes(r.status));assert.equal(cookieCalls,before,'bad explicit credential never falls back to ambient cookie')
  }
  r=await fetch(`${base}/internal/v1/admin/session`,{headers:{'x-mx-insight-admin-token':'test-admin-token'}})
  assert.equal((await r.json()).data.kind,'admin-token');assert.equal(cookieCalls,1)
})

for (const listenerMode of ['admin','public']) test(`tenant invitation routes preserve listener isolation and resolved principal on ${listenerMode}`,async t=>{
  const store=new MemoryStore(), calls=[]
  const principal={kind:'launcher-user',memberId:'fixture-owner',platformAdmin:false,tenantIds:['tenant-a'],capabilities:['membership.write'],memberships:[]}
  let signedIn=false
  const invitations={}
  for(const method of ['list','create','revoke']) invitations[method]=async(...args)=>{calls.push({method,args});return {operation:method}}
  const sso={handle:async()=>false,principal:async()=>signedIn?principal:null,invitations}
  const service=new HubService({store,adapter:{},apiKeyPepper:'test-pepper-at-least-32-characters-long'})
  const server=createServer(createApp({store,service,identity:{enabled:true,resolve:async()=>null},adminToken:'fixture-admin',sso,listenerMode}))
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
  const base=`http://127.0.0.1:${server.address().port}/internal/v1/admin/tenant-invitations`
  let response=await fetch(base)
  assert.equal(response.status,listenerMode==='admin'?401:404);assert.equal(calls.length,0)
  signedIn=true
  const body={tenantId:'tenant-a',label:'Colleague',role:'viewer'}
  for(const [method,suffix,requestBody,operation] of [['GET','?tenantId=tenant-a',null,'list'],['POST','',body,'create'],['POST','/revoke',{id:'invite-a'},'revoke']]) {
    response=await fetch(base+suffix,{method,headers:requestBody?{'content-type':'application/json'}:{},...(requestBody?{body:JSON.stringify(requestBody)}:{})})
    if(listenerMode==='public'){assert.equal(response.status,404);continue}
    assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store')
    assert.equal((await response.json()).data.operation,operation)
    assert.deepEqual(calls.at(-1),{method:operation,args:[principal,operation==='list'?'tenant-a':operation==='create'?body:'invite-a']})
  }
  assert.equal(calls.length,listenerMode==='admin'?3:0)
  if(listenerMode==='admin') {
    response=await fetch(base,{headers:{authorization:'Bearer invalid'}})
    assert.ok([401,403].includes(response.status));assert.equal(calls.length,3)
  }
})
