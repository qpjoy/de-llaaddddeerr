import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { HubService } from '../../server/hub-service.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { WebSearchRouteStore } from '../../server/web-search/runtime.mjs'
const connectionString=process.env.MX_INSIGHT_TEST_DATABASE_URL || ''
test('PostgreSQL search order and scopes commit atomically; concurrent intents keep one provider',{
 skip:connectionString?false:'MX_INSIGHT_TEST_DATABASE_URL is not configured (requires migration 119; disposable database only)',
},async()=>{
 const pool=new pg.Pool({connectionString,statement_timeout:15000})
 try {
  const store=new PostgresStore(pool),service=new HubService({store,adapter:{},apiKeyPepper:'web-search-postgres-disposable-test-pepper'})
  const tenant=await service.createTenant({name:`web-search-${randomUUID()}`}),consumer=await service.createConsumer({tenantId:tenant.id,name:'Search fixture'})
  const capabilities=['web.search','web.search.provider.baidu','web.search.provider.tavily']
  await service.putTenantServiceAccess(tenant.id,{platforms:['web_search'],capabilities,webSearchOrder:['tavily','baidu'],revision:0,reason:'Disposable test'},'test')
  const key=await service.createApiKey({consumerId:consumer.id,name:'Search fixture',platforms:['web_search'],capabilities,webSearchOrder:['baidu','tavily']})
  const expected={platforms:key.platforms,capabilities:key.capabilities,scopeMode:key.scopeMode,webSearchOrder:key.webSearchOrder}
  assert.deepEqual((await service.authenticate(key.secret)).apiKey.webSearchOrder,['baidu','tavily'])
  await service.updateApiKeyScopes(key.id,{platforms:key.platforms,capabilities,webSearchOrder:['tavily','baidu'],expected},'test')
  await assert.rejects(service.updateApiKeyScopes(key.id,{platforms:[],capabilities:[],webSearchOrder:[],expected},'test'),{code:'api_key_scopes_changed'})
  const after=(await store.listApiKeys(consumer.id)).find(row=>row.id===key.id)
  assert.deepEqual(after.platforms,key.platforms);assert.deepEqual(after.webSearchOrder,['tavily','baidu']);assert.equal((await service.authenticate(key.secret)).apiKey.id,key.id)
  const routes=new WebSearchRouteStore(pool),intent=randomUUID()
  const saved=await Promise.all(['baidu','tavily'].map(provider=>routes.claim(key.id,intent,{provider,order:[provider],fingerprint:'a'.repeat(64)})))
  assert.equal(saved[0].provider,saved[1].provider);assert.deepEqual(await routes.read(key.id,intent),saved[0])
 }finally{await pool.end()}
})
