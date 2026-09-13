import assert from 'node:assert/strict'
import test from 'node:test'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { writeTenantAccess } from '../../server/stores/tenant-service-access.mjs'

test('tenant grants synchronize, inherit, constrain snapshots, preserve separate admin grants and reject stale saves', async () => {
  const store = new MemoryStore()
  const service = new HubService({ store, adapter: {}, apiKeyPepper: 'tenant-access-test-pepper-at-least-32-bytes' })
  const tenant = await service.createTenant({ name: 'Tenant' })
  const other = await service.createTenant({ name: 'Other' })
  const create = (tenantId=tenant.id) => service.createConsumer({tenantId,name:'Caller'})
  const first = await create()
  const isolated = await create(other.id)
  await service.putCapabilityConfiguration('nlp.tokenize',{tenantId:tenant.id,consumerId:first.id,enabled:true})
  const oldKey = await service.createApiKey({consumerId:first.id,name:'Old',capabilities:['nlp.tokenize']})
  const configuration = {platforms:['xiaohongshu'],capabilities:['social.posts.search'],revision:0,reason:'Approved search',maxRequests:42,windowSeconds:3600,maxPageSize:20,maxCrawlWork:50}
  await service.putTenantServiceAccess(tenant.id,configuration,'admin')
  assert.deepEqual(await store.listCapabilityGrants(first.id),['nlp.tokenize','social.posts.search'])
  assert.deepEqual(await store.listEffectiveCapabilityGrants(first.id,oldKey.id),['nlp.tokenize'])
  assert.deepEqual(await store.listCapabilityGrants(isolated.id),[])
  const next = await create()
  assert.deepEqual(await store.listCapabilityGrants(next.id),['social.posts.search'])
  assert.equal((await store.getCapabilityPolicy(next.id,'social.posts.search')).maxRequests,42)
  const key = await service.createApiKey({consumerId:next.id,name:'Search',platforms:['xiaohongshu'],capabilities:['social.posts.search']})
  await assert.rejects(service.createApiKey({consumerId:next.id,name:'Escalation',capabilities:['nlp.tokenize']}))
  await assert.rejects(service.putTenantServiceAccess(tenant.id,configuration,'admin'),e=>e.code==='revision_conflict')
  assert.equal(store.tenantServiceAccessEvents.length,1)
  await service.putTenantServiceAccess(tenant.id,{...configuration,revision:1,platforms:[],capabilities:[]},'admin')
  assert.deepEqual(await store.listEffectiveCapabilityGrants(next.id,key.id),[])
  assert.deepEqual(await store.listEffectiveGrants(next.id,key.id),[])
  assert.deepEqual(await store.listCapabilityGrants(first.id),['nlp.tokenize'])
  assert.deepEqual(await store.listCapabilityGrants((await create()).id),[])
})

test('Postgres tenant grant failure rolls back grants, configuration and audit', async () => {
  const queries=[]
  let released=false
  const db={release(){released=true},async query(sql){
    queries.push(sql)
    if(sql.startsWith('SELECT configuration')) return {rows:[]}
    if(sql.startsWith('SELECT id FROM consumers')) return {rows:[{id:'consumer'}]}
    if(sql.startsWith('INSERT INTO consumer_capability_policies')) throw new Error('policy failed')
    return {rows:[]}
  }}
  await assert.rejects(writeTenantAccess({connect:async()=>db},'tenant',{revision:0,platforms:[],capabilities:['nlp.tokenize'],reason:'test',maxRequests:1,windowSeconds:60},'admin'),/policy failed/)
  assert.equal(queries.at(-1),'ROLLBACK')
  assert.equal(queries.includes('COMMIT'),false)
  assert.equal(queries.some(q=>q.startsWith('INSERT INTO tenant_service_access')),false)
  assert.equal(released,true)
})
