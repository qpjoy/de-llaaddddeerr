import assert from 'node:assert/strict'
import test from 'node:test'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { writeTenantAccess } from '../../server/stores/tenant-service-access.mjs'

test('tenant grants synchronize, inherit, synchronize snapshots, preserve separate admin grants and reject stale saves', async () => {
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
  assert.deepEqual(await store.listEffectiveCapabilityGrants(first.id,oldKey.id),['nlp.tokenize','social.posts.search'])
  assert.deepEqual(await store.listCapabilityGrants(isolated.id),[])
  const next = await create()
  assert.deepEqual(await store.listCapabilityGrants(next.id),['social.posts.search'])
  assert.equal((await store.getCapabilityPolicy(next.id,'social.posts.search')).maxRequests,42)
  const key = await service.createApiKey({consumerId:next.id,name:'Search',platforms:['xiaohongshu'],capabilities:['social.posts.search']})
  await assert.rejects(service.createApiKey({consumerId:next.id,name:'Escalation',capabilities:['nlp.tokenize']}))
  await assert.rejects(service.putTenantServiceAccess(tenant.id,configuration,'admin'),e=>e.code==='revision_conflict')
  assert.equal(store.tenantServiceAccessEvents.length,1)
  const removal = {...configuration,revision:1,platforms:[],capabilities:[]}
  const preview = await service.previewTenantServiceAccess(tenant.id,removal)
  await service.putTenantServiceAccess(tenant.id,{...removal,previewToken:preview.previewToken,confirmRemovals:true},'admin')
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

import { productAllowed, withIpRiskProductScopes } from '../../shared/product-access.mjs'
import { tenantOpenApiDocument, publicDocsHtmlForPath } from '../../server/public-docs.mjs'
test('IP-only tenant product preset exposes menu and docs, including an existing Key', async () => {
 const store = new MemoryStore()
 const service = new HubService({ store, adapter: {}, apiKeyPepper: 'ip-tenant-access-test-pepper-at-least-32-bytes' })
 const tenant = await service.createTenant({ name: 'IP only' })
 const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'IP consumer' })
 await service.putPlatformConfiguration('ip_risk', { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
 const key = await service.createApiKey({ consumerId: consumer.id, name: 'Old IP key', platforms: ['ip_risk'], capabilities: [] })
 const scopes = async () => [{ platforms: await store.listGrants(consumer.id), capabilities: await store.listCapabilityGrants(consumer.id) }]
 assert.equal(productAllowed('/data-products/ip-risk', await scopes()), false)
 assert.equal(tenantOpenApiDocument(await scopes()).paths['/data/ip/risk'], undefined)
 const form = withIpRiskProductScopes({ platforms: ['ip_risk'], capabilities: [], revision: 0, reason: 'Enable IP product', maxRequests: 42, windowSeconds: 3600, maxPageSize: 20, maxCrawlWork: 50 })
 assert.deepEqual(form.platforms, ['ip_risk'])
 assert.deepEqual(form.capabilities, ['ip.risk.query'])
 await service.putTenantServiceAccess(tenant.id, form, 'admin')
 const access = await scopes()
 assert.equal(productAllowed('/data-products/ip-risk', access), true)
 assert.equal(productAllowed('/data-products/xiaohongshu-note', access), false)
 const schema = tenantOpenApiDocument(access)
 assert.ok(schema.paths['/data/ip/risk']); assert.ok(schema.paths['/data/ip/risk/batch'])
 const html = publicDocsHtmlForPath('/docs/ip-risk', { tenant: true, scopes: access })
 assert.match(html, /IP 风险画像/u); assert.doesNotMatch(html, /ipsearch|ipdatacloud/u)
 assert.deepEqual(await store.listEffectiveCapabilityGrants(consumer.id, key.id), ['ip.risk.query'])
 assert.equal((await service.authenticate(key.secret)).apiKey.id, key.id)
})

async function fixture() {
 const store=new MemoryStore(),service=new HubService({store,adapter:{},apiKeyPepper:'tenant-sync-test-pepper-at-least-32-bytes'})
 const tenant=await service.createTenant({name:'Sync tenant'})
 const consumer=await service.createConsumer({tenantId:tenant.id,name:'First'})
 const second=await service.createConsumer({tenantId:tenant.id,name:'Second'})
 await service.putCapabilityConfiguration('nlp.tokenize',{tenantId:tenant.id,consumerId:consumer.id,enabled:true,maxRequests:7,windowSeconds:90})
 const a=await service.createApiKey({consumerId:consumer.id,name:'Extra scope',capabilities:['nlp.tokenize']})
 const b=await service.createApiKey({consumerId:second.id,name:'Empty old key',capabilities:[]})
 const input={revision:0,platforms:['web_search'],capabilities:['web.search','web.search.provider.baidu','web.search.provider.exa'],webSearchOrder:['exa','baidu'],reason:'Enable search'}
 return {store,service,tenant,consumer,second,a,b,input}
}

test('tenant save fills every existing Key, preserves secrets, quotas, extra scopes, status and independent search order',async()=>{
 const {store,service,tenant,consumer,a,b,input}=await fixture()
 const aRecord=structuredClone(store.apiKeys.get(a.id)), quota=await store.listApiKeyCapabilityEntitlements(a.id)
 await store.revokeApiKey(b.id)
 const preview=await service.previewTenantServiceAccess(tenant.id,input)
 assert.equal(preview.keyCount,2);assert.equal(preview.changedKeyCount,2)
 assert.deepEqual(preview.keys.find(k=>k.id===a.id).preserved.capabilities,['nlp.tokenize'])
 assert.equal(JSON.stringify(preview).includes(a.secret),false)
 assert.equal(store.tenantServiceAccessEvents.length,0)
 await service.putTenantServiceAccess(tenant.id,{...input,previewToken:preview.previewToken},'operator')
 assert.equal((await service.authenticate(a.secret)).apiKey.id,a.id)
 assert.equal(store.apiKeys.get(a.id).expiresAt,aRecord.expiresAt)
 assert.equal(store.apiKeys.get(a.id).digest,aRecord.digest)
 assert.deepEqual((await store.listApiKeyCapabilityEntitlements(a.id)).find(r=>r.capability==='nlp.tokenize'),quota[0])
 assert.equal(store.apiKeys.get(b.id).status,'revoked')
 assert.deepEqual((await store.listApiKeys()).find(k=>k.id===b.id).capabilities,input.capabilities.slice().sort())
 // A later subset Key can be caught up by explicitly re-saving the tenant.
 const subset=await service.createApiKey({consumerId:consumer.id,name:'Later subset',capabilities:['nlp.tokenize']})
 const current=await store.getTenantServiceAccess(tenant.id)
 const catchup=await service.previewTenantServiceAccess(tenant.id,{...current,reason:'Catch up old keys'})
 assert.equal(catchup.changedKeyCount,1)
 await service.putTenantServiceAccess(tenant.id,{...current,reason:'Catch up old keys',previewToken:catchup.previewToken},'operator')
 assert.ok((await store.listEffectiveCapabilityGrants(consumer.id,subset.id)).includes('web.search'))
 const key=(await store.listApiKeys()).find(k=>k.id===a.id)
 await service.updateApiKeyScopes(a.id,{platforms:key.platforms,capabilities:key.capabilities,webSearchOrder:['baidu','exa'],expected:key},'operator')
 const next={...await store.getTenantServiceAccess(tenant.id),webSearchOrder:['baidu','exa'],reason:'Tenant order'}
 await service.putTenantServiceAccess(tenant.id,next,'operator')
 assert.deepEqual(store.apiKeys.get(a.id).webSearchOrder,['baidu','exa'])
})

test('removal requires exact reviewed impact; retained and unrelated Key scopes survive',async()=>{
 const {store,service,tenant,consumer,a,input}=await fixture()
 await service.putTenantServiceAccess(tenant.id,input,'operator')
 const removal={...await store.getTenantServiceAccess(tenant.id),capabilities:['web.search','web.search.provider.baidu'],webSearchOrder:['baidu'],reason:'Remove Exa'}
 const preview=await service.previewTenantServiceAccess(tenant.id,removal)
 assert.deepEqual(preview.removed.capabilities,['web.search.provider.exa'])
 assert.deepEqual(preview.keys.find(k=>k.id===a.id).removed.capabilities,['web.search.provider.exa'])
 await assert.rejects(service.putTenantServiceAccess(tenant.id,removal,'operator'),{code:'tenant_access_removal_confirmation_required'})
 await assert.rejects(service.putTenantServiceAccess(tenant.id,{...removal,previewToken:preview.previewToken},'operator'),{code:'tenant_access_removal_confirmation_required'})
 assert.ok((await store.listEffectiveCapabilityGrants(consumer.id,a.id)).includes('web.search.provider.exa'))
 await service.putTenantServiceAccess(tenant.id,{...removal,previewToken:preview.previewToken,confirmRemovals:true},'operator')
 assert.deepEqual(await store.listEffectiveCapabilityGrants(consumer.id,a.id),['nlp.tokenize','web.search','web.search.provider.baidu'])
 assert.equal((await store.listApiKeyCapabilityEntitlements(a.id)).some(row=>row.capability==='web.search.provider.exa'),false)
 assert.equal(store.apiKeyScopeEvents.at(-1).actor,'operator')
})

test('preview rejects a changed Key inventory or scope and performs no partial writes',async()=>{
 const {store,service,tenant,consumer,a,input}=await fixture()
 await service.putTenantServiceAccess(tenant.id,input,'operator')
 const removal={...await store.getTenantServiceAccess(tenant.id),platforms:[],capabilities:[],webSearchOrder:[],reason:'Remove tenant search'}
 const preview=await service.previewTenantServiceAccess(tenant.id,removal)
 await service.createApiKey({consumerId:consumer.id,name:'Created after review',capabilities:[]})
 await assert.rejects(service.putTenantServiceAccess(tenant.id,{...removal,previewToken:preview.previewToken,confirmRemovals:true},'operator'),{code:'tenant_access_preview_changed'})
 const refreshed=await service.previewTenantServiceAccess(tenant.id,removal)
 const key=(await store.listApiKeys()).find(k=>k.id===a.id)
 await service.updateApiKeyScopes(a.id,{platforms:key.platforms,capabilities:key.capabilities.filter(s=>s!=='web.search.provider.exa'),expected:key},'operator')
 await assert.rejects(service.putTenantServiceAccess(tenant.id,{...removal,previewToken:refreshed.previewToken,confirmRemovals:true},'operator'),{code:'tenant_access_preview_changed'})
 assert.equal((await store.getTenantServiceAccess(tenant.id)).revision,1)
 assert.ok((await store.listCapabilityGrants(consumer.id)).includes('web.search.provider.exa'))
 assert.equal(store.tenantServiceAccessEvents.length,1)
})

test('legacy Key becomes a usable explicit snapshot without losing separate grants',async()=>{
 const {store,service,tenant,consumer,a,input}=await fixture()
 store.apiKeys.get(a.id).scopeMode='legacy_dynamic'
 const old=await store.listApiKeyCapabilityEntitlements(a.id)
 await service.putTenantServiceAccess(tenant.id,input,'operator')
 assert.equal(store.apiKeys.get(a.id).scopeMode,'snapshot')
 assert.deepEqual((await store.listApiKeyCapabilityEntitlements(a.id)).find(r=>r.capability==='nlp.tokenize'),old[0])
 assert.ok((await store.listEffectiveCapabilityGrants(consumer.id,a.id)).includes('web.search.provider.baidu'))
})

test('Postgres Key audit failure rolls back the entire tenant synchronization',async()=>{
 const queries=[]
 const db={release(){},async query(sql){
  queries.push(sql)
  if(sql.startsWith('SELECT configuration'))return {rows:[]}
  if(sql.startsWith('SELECT id FROM consumers'))return {rows:[{id:'consumer'}]}
  if(sql.startsWith('SELECT k.id,'))return {rows:[{id:'key',consumer_id:'consumer',consumer_name:'Caller',name:'Existing',status:'active',expires_at:'2030-01-01',scope_mode:'snapshot',web_search_order:[]}]}
  if(sql.startsWith('INSERT INTO api_key_scope_events'))throw new Error('audit unavailable')
  return {rows:[]}
 }}
 await assert.rejects(writeTenantAccess({connect:async()=>db},'tenant',{revision:0,platforms:[],capabilities:['nlp.tokenize'],reason:'sync',maxRequests:10,windowSeconds:60},'operator'),/audit unavailable/)
 assert.ok(queries.some(q=>q.startsWith('INSERT INTO capability_grants')))
 assert.ok(queries.some(q=>q.startsWith('INSERT INTO api_key_capability_entitlements')))
 assert.equal(queries.at(-1),'ROLLBACK')
 assert.equal(queries.includes('COMMIT'),false)
 assert.equal(queries.some(q=>q.startsWith('INSERT INTO tenant_service_access(')),false)
})
