import assert from 'node:assert/strict'
import test from 'node:test'
import { sealApiKey, openApiKey } from '../../server/core/key-vault.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
const pepper = 'key-vault-tests-strong-domain-separated-pepper'
test('vault binds ciphertext to key ID and encryption secret', () => {
 const sealed = sealApiKey('secret','id',pepper)
 assert.equal(sealed.includes('secret'),false)
 assert.equal(openApiKey(sealed,'id',pepper),'secret')
 assert.throws(()=>openApiKey(sealed,'other',pepper))
 assert.throws(()=>openApiKey(sealed,'id','other-pepper'))
})
test('new keys are recoverable and audited, historical/revoked keys cannot be revealed', async () => {
 const store=new MemoryStore()
 const service=new HubService({store,adapter:{},apiKeyPepper:pepper})
 const tenant=await service.createTenant({name:'Tenant'})
 const consumer=await service.createConsumer({tenantId:tenant.id,name:'Caller'})
 const issued=await service.createApiKey({consumerId:consumer.id,name:'Key'})
 assert.equal((await service.revealApiKey(issued.id,'member')).secret,issued.secret)
 assert.equal(store.apiKeyRevealEvents.length,1)
 assert.equal(JSON.stringify(await store.listApiKeys()).includes(issued.secret),false)
 const envelope=await store.readApiKeyVault(issued.id)
 store.apiKeyVault.delete(issued.id)
 await assert.rejects(service.revealApiKey(issued.id,'member'),e=>e.code==='api_key_not_recoverable')
 store.apiKeyVault.set(issued.id,envelope)
 await service.revokeApiKey(issued.id)
 await assert.rejects(service.revealApiKey(issued.id,'member'),e=>e.code==='api_key_unavailable')
 assert.equal(store.apiKeyRevealEvents.length,1)
})

test('reveal HTTP endpoint requires password, same member and fresh tenant permission', async () => {
 const {createServer}=await import('node:http')
 const {createApp}=await import('../../server/app.mjs')
 const {AppError}=await import('../../server/core/errors.mjs')
 const store=new MemoryStore()
 const service=new HubService({store,adapter:{},apiKeyPepper:pepper})
 const tenant=await service.createTenant({name:'Tenant'})
 const consumer=await service.createConsumer({tenantId:tenant.id,name:'Caller'})
 const issued=await service.createApiKey({consumerId:consumer.id,name:'Key'})
 const member={memberId:'member',platformAdmin:false,tenantIds:[tenant.id],memberships:[{tenantId:tenant.id,role:'owner'}]}
 let verified=member
 const identity={enabled:true,resolve:async token=>token==='session'?member:verified,client:{signIn:async ({password})=>{
   if(password!=='correct') throw new AppError(401,'invalid_credentials','Incorrect password')
   return {token:'fresh'}
 }}}
 const server=createServer(createApp({service,store,identity,adminToken:'admin',logger:{error(){}}}))
 await new Promise(r=>server.listen(0,'127.0.0.1',r))
 const call=async password=>{
   const response=await fetch(`http://127.0.0.1:${server.address().port}/internal/v1/admin/api-keys/${issued.id}/reveal`,{method:'POST',headers:{'x-mx-insight-admin-token':'session','content-type':'application/json'},body:JSON.stringify({username:'user',password})})
   return {status:response.status,cache:response.headers.get('cache-control'),body:await response.json()}
 }
 try {
   assert.equal((await call('wrong')).status,401)
   verified={...member,memberId:'other'}
   assert.equal((await call('correct')).status,403)
   verified={...member,tenantIds:[],memberships:[]}
   assert.equal((await call('correct')).status,403)
   verified=member
   const result=await call('correct')
   assert.equal(result.status,200)
   assert.equal(result.body.data.secret,issued.secret)
   assert.match(result.cache,/no-store/)
   assert.equal(store.apiKeyRevealEvents.length,1)
 } finally {await new Promise(r=>server.close(r))}
})
