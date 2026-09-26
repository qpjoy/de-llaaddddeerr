import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { createApp } from '../../server/app.mjs'
import { issueDemoCredential, readDemoCredential } from '../../server/core/demo-credential.mjs'
const pepper = 'demo-test-pepper-at-least-thirty-two-bytes'
async function fixture() {
  const store=new MemoryStore()
  const service=new HubService({store,adapter:{},apiKeyPepper:pepper})
  const tenant=await service.createTenant({name:'Demo tenant'})
  const consumer=await service.createConsumer({tenantId:tenant.id,name:'LCY-delta'})
  const key=await service.createApiKey({consumerId:consumer.id,name:'LCY-delta',platforms:[],capabilities:[]})
  return {store,service,key,tenant,consumer}
}
test('explicit Admin identity is isolated, created once, and renewal never expands or revives it', async () => {
  const { service, store, key, consumer } = await fixture()
  const original = await store.listApiKeyPlatformEntitlements(key.id)
  const [a, b] = await Promise.all([service.createAdminExecutionCredential(), service.createAdminExecutionCredential()])
  assert.equal(a.keyId, b.keyId)
  assert.equal(a.adminExecution, true)
  assert.notEqual(a.keyId, key.id)
  assert.notEqual(a.consumerId, consumer.id)
  assert.equal(store.apiKeys.size, 2)
  assert.equal(store.adminExecutionAudit.createdBy, 'admin-token')
  assert.ok(a.access.platforms.includes('weibo'))
  assert.ok(a.access.capabilities.includes('social.posts.search'))
  assert.deepEqual(await store.listApiKeyPlatformEntitlements(key.id), original)
  assert.equal((await service.createDemoCredential()).keyId, key.id, 'existing default remains LCY-delta')
  await store.setPlatformGrant(a.consumerId, 'weibo', false)
  assert.equal((await service.createAdminExecutionCredential()).access.platforms.includes('weibo'), false)
  await service.revokeApiKey(a.keyId)
  await assert.rejects(service.createAdminExecutionCredential(), { code: 'demo_key_unavailable' })
  await assert.rejects(service.authenticate(a.secret), { code: 'invalid_api_key' })
  assert.equal(store.apiKeys.size, 2, 'revocation must not silently create a replacement')
})

test('Admin execution creation rejects public and Launcher credentials, and performs no acquisition', async () => {
  const { service, store, key, tenant } = await fixture()
  const member = await memberFor(store, tenant.id)
  const identity = { enabled: true, resolve: async () => ({ kind: 'launcher-user', memberId: member.id, platformAdmin: true, tenantIds: null, capabilities: [] }) }
  const server = createServer(createApp({ store, service, identity, adminToken: 'demo-admin-token', logger: { error() {} } }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    for (const [credential, expected] of [[key.secret, 403], ['launcher-session', 403], ['demo-admin-token', 200]]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/internal/v1/admin/admin-execution-credential`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-mx-insight-admin-token': credential }, body: '{}' })
      assert.equal(response.status, expected)
      if (expected === 200) assert.equal((await response.json()).data.adminExecution, true)
    }
    assert.equal(store.requests.size, 0)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})
test('default demo identity preserves original key, grants and revocation',async()=>{
 const {service,key,store}=await fixture()
 const demo=await service.createDemoCredential()
 assert.equal(demo.keyId,key.id)
 assert.notEqual(demo.secret,key.secret)
 const {lastUsedAt: demoUsed, ...demoKey}=(await service.authenticate(demo.secret)).apiKey
 const {lastUsedAt: realUsed, ...realKey}=(await service.authenticate(key.secret)).apiKey
 assert.deepEqual(demoKey,realKey)
 assert.equal(store.apiKeys.size,1)
 await service.revokeApiKey(key.id)
 await assert.rejects(()=>service.authenticate(demo.secret),e=>e.code==='invalid_api_key')
})
test('tickets enforce integrity, signing pepper and expiry',()=>{
 const id='00000000-0000-4000-8000-000000000001'
 const demo=issueDemoCredential(id,pepper,1000)
 assert.equal(readDemoCredential(demo.secret,pepper,1001),id)
 assert.throws(()=>readDemoCredential(demo.secret,'different pepper',1001))
 assert.throws(()=>readDemoCredential(demo.secret+'x',pepper,1001))
 assert.throws(()=>readDemoCredential(demo.secret,pepper,demo.expiresAt))
})
test('missing default does not silently choose another tenant key',async()=>{
 const {service,key}=await fixture()
 await service.revokeApiKey(key.id)
 assert.equal((await service.createDemoCredential()).secret,null)
})
test('only admin token may issue a demo credential, not a tenant key',async()=>{
 const {service,store,key}=await fixture()
 const server=createServer(createApp({store,service,adminToken:'demo-admin-token',logger:{warn(){},error(){}}}))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const url=`http://127.0.0.1:${server.address().port}/internal/v1/admin/demo-credentials`
 try {
  for(const [headers,expected] of [[{},401],[{'x-mx-insight-admin-token':key.secret},403],[{'x-mx-insight-admin-token':'demo-admin-token'},200]]) {
   const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:'{}'})
   assert.equal(r.status,expected)
   if(expected===200) assert.equal((await r.json()).data.keyId,key.id)
  }
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})

async function memberFor(store, tenantId, role = 'owner') {
 const member = await store.upsertExternalIdentity({issuer:'test', subject:crypto.randomUUID(), audience:'hub', displayName:'Tenant operator'})
 await store.grantTenantMembership({memberId:member.id,tenantId,role})
 return member
}

test('tenant default selects only its own key and revocation invalidates an issued ticket', async () => {
 const {service,store,tenant,key} = await fixture()
 const otherTenant = await service.createTenant({name:'Other'})
 const otherConsumer = await service.createConsumer({tenantId:otherTenant.id,name:'Other'})
 const otherKey = await service.createApiKey({consumerId:otherConsumer.id,name:'Other key',platforms:[],capabilities:[]})
 const member = await memberFor(store, tenant.id)
 const scope = {memberId:member.id,tenantIds:[tenant.id]}
 const demo = await service.createDemoCredential({},scope)
 assert.equal(demo.keyId,key.id)
 assert.ok(demo.secret.startsWith('mih_tenant_demo_'))
 await assert.rejects(()=>service.authenticate(demo.secret.replace('mih_tenant_demo_', 'mih_demo_')),e=>e.code==='demo_credential_expired_or_invalid')
 assert.deepEqual(demo.choices.map(item=>item.id),[key.id])
 assert.equal((await service.authenticate(demo.secret)).apiKey.id,key.id)
 await assert.rejects(()=>service.createDemoCredential({keyId:otherKey.id},scope), e=>e.code==='demo_key_unavailable')
 await store.revokeTenantMembership({memberId:member.id,tenantId:tenant.id})
 await assert.rejects(()=>service.authenticate(demo.secret), e=>e.code==='demo_membership_revoked')
 // The original machine key and the admin demo path retain their old behavior.
 assert.equal((await service.authenticate(key.secret)).apiKey.id,key.id)
 assert.equal((await service.createDemoCredential()).keyId,key.id)
})

test('multiple tenant keys require selection and a role downgrade invalidates the temporary credential',async()=>{
 const {service,store,tenant,key,consumer}=await fixture()
 await service.createApiKey({consumerId:consumer.id,name:'Second',platforms:[],capabilities:[]})
 const member=await memberFor(store,tenant.id)
 const scope={memberId:member.id,tenantIds:[tenant.id]}
 const choice=await service.createDemoCredential({},scope)
 assert.equal(choice.secret,null)
 assert.equal(choice.choices.length,2)
 const selected=await service.createDemoCredential({keyId:key.id},scope)
 await store.grantTenantMembership({memberId:member.id,tenantId:tenant.id,role:'analyst'})
 await assert.rejects(()=>service.authenticate(selected.secret),e=>e.code==='demo_membership_revoked')
 assert.deepEqual((await service.createDemoCredential({},scope)).choices,[])
})

test('tenant HTTP selection is scoped, ignores no caller-supplied scope, and sends no-store',async()=>{
 const {service,store,tenant,key}=await fixture()
 const member=await memberFor(store,tenant.id)
 const principal={kind:'launcher-user',memberId:member.id,platformAdmin:false,tenantIds:[tenant.id],capabilities:['apikey.read','apikey.write'],memberships:[{tenantId:tenant.id,capabilities:['apikey.read','apikey.write']}]}
 const identity={enabled:true,resolve:async()=>principal}
 const server=createServer(createApp({store,service,identity,adminToken:'demo-admin-token',logger:{warn(){},error(){}}}))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const call=body=>fetch(`http://127.0.0.1:${server.address().port}/internal/v1/admin/demo-credentials`,{method:'POST',headers:{authorization:'Bearer tenant-console','content-type':'application/json'},body:JSON.stringify(body)})
 try {
  const response=await call({})
  assert.equal(response.status,200)
  assert.equal(response.headers.get('cache-control'),'no-store')
  const issued = (await response.json()).data
  assert.equal(issued.keyId,key.id)
  const misuse = await fetch(`http://127.0.0.1:${server.address().port}/internal/v1/admin/session`,{headers:{authorization:`Bearer ${issued.secret}`}})
  assert.equal(misuse.status,403)
  assert.equal((await call({tenantIds:[tenant.id]})).status,400)
  principal.memberships[0].capabilities=['apikey.read']
  assert.equal((await call({})).status,403)
 } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})

test('diagnostics distinguish a consumer grant from the unchanged key snapshot',async()=>{
 const {service,tenant,consumer,key}=await fixture()
 await service.putPlatformConfiguration('xiaohongshu',{tenantId:tenant.id,consumerId:consumer.id,enabled:true,maxRequests:1000,windowSeconds:3600,maxPageSize:100})
 const demo=await service.createDemoCredential({keyId:key.id})
 assert.deepEqual(demo.access.platforms,[])
 assert.deepEqual(demo.access.consumerPlatforms,['xiaohongshu'])
 assert.deepEqual((await service.authenticate(demo.secret)).apiKey.platforms,[])
})
