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

import { productAllowed, withIpRiskProductScopes } from '../../shared/product-access.mjs'
import { tenantOpenApiDocument, publicDocsHtmlForPath } from '../../server/public-docs.mjs'
test('IP-only tenant product preset exposes menu and docs, without expanding an old Key', async () => {
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
 assert.deepEqual(await store.listEffectiveCapabilityGrants(consumer.id, key.id), [])
 await service.updateApiKeyScopes(key.id, { platforms: ['ip_risk'], capabilities: ['ip.risk.query'], expected: { scopeMode: key.scopeMode, platforms: key.platforms, capabilities: key.capabilities } }, 'admin')
 assert.deepEqual(await store.listEffectiveCapabilityGrants(consumer.id, key.id), ['ip.risk.query'])
 assert.equal((await service.authenticate(key.secret)).apiKey.id, key.id)
})
