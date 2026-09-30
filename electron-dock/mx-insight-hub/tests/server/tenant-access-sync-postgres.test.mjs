import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { HubService } from '../../server/hub-service.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
const connectionString=process.env.MX_INSIGHT_TEST_DATABASE_URL || ''
test('PostgreSQL tenant synchronization preserves extra Key scopes and limits and rejects stale reviewed removal',{
 skip:connectionString?false:'MX_INSIGHT_TEST_DATABASE_URL is not configured (disposable database with migration 119 required)',
},async()=>{
 const pool=new pg.Pool({connectionString,statement_timeout:15000})
 try {
  const store=new PostgresStore(pool),service=new HubService({store,adapter:{},apiKeyPepper:'tenant-access-postgres-disposable-test-pepper'})
  const tenant=await service.createTenant({name:`access-${randomUUID()}`}),consumer=await service.createConsumer({tenantId:tenant.id,name:'Existing caller'})
  await service.putCapabilityConfiguration('nlp.tokenize',{tenantId:tenant.id,consumerId:consumer.id,enabled:true,maxRequests:7,windowSeconds:60})
  const key=await service.createApiKey({consumerId:consumer.id,name:'Existing key',capabilities:['nlp.tokenize']})
  const limits=await store.listApiKeyCapabilityEntitlements(key.id)
  const grant={revision:0,platforms:['ip_risk'],capabilities:['ip.risk.query'],reason:'Tenant addition'}
  const addition=await service.previewTenantServiceAccess(tenant.id,grant)
  await service.putTenantServiceAccess(tenant.id,{...grant,previewToken:addition.previewToken},'test')
  assert.deepEqual(await store.listEffectiveCapabilityGrants(consumer.id,key.id),['ip.risk.query','nlp.tokenize'])
  assert.equal((await store.listApiKeyCapabilityEntitlements(key.id)).find(row=>row.capability==='nlp.tokenize').maxRequests,limits[0].maxRequests)
  const removal={...await store.getTenantServiceAccess(tenant.id),platforms:[],capabilities:[],reason:'Tenant removal'}
  const preview=await service.previewTenantServiceAccess(tenant.id,removal)
  await service.createApiKey({consumerId:consumer.id,name:'Concurrent key',capabilities:['nlp.tokenize']})
  await assert.rejects(service.putTenantServiceAccess(tenant.id,{...removal,previewToken:preview.previewToken,confirmRemovals:true},'test'),{code:'tenant_access_preview_changed'})
  assert.equal((await store.getTenantServiceAccess(tenant.id)).revision,1)
  const reviewed=await service.previewTenantServiceAccess(tenant.id,removal)
  await service.putTenantServiceAccess(tenant.id,{...removal,previewToken:reviewed.previewToken,confirmRemovals:true},'test')
  assert.deepEqual(await store.listEffectiveCapabilityGrants(consumer.id,key.id),['nlp.tokenize'])
  assert.deepEqual((await store.listApiKeyCapabilityEntitlements(key.id)).map(r=>r.capability),['nlp.tokenize'])
  assert.equal((await service.authenticate(key.secret)).apiKey.id,key.id)
  assert.equal((await store.listApiKeys(consumer.id)).find(k=>k.id===key.id).expiresAt,key.expiresAt)
  const events=await pool.query('SELECT count(*)::integer AS count FROM api_key_scope_events WHERE api_key_id=$1',[key.id])
  assert.equal(events.rows[0].count,2)
 }finally{await pool.end()}
})
