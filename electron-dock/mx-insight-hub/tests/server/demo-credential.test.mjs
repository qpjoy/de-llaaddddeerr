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
