import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createApp } from '../../server/app.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { capabilitiesForRole } from '../../server/identity/index.mjs'

async function fixture(t) {
  const store = new MemoryStore(), service = new HubService({store, adapter:{}, apiKeyPepper:'harbor-isolated-test-pepper'})
  const a = await store.createTenant({name:'Space A'}), b = await store.createTenant({name:'Space B'}), other = await store.createTenant({name:'Other'})
  const member = await store.upsertExternalIdentity({issuer:'fixture',subject:'owner',audience:'hub',displayName:'Owner'})
  const colleague = await store.upsertExternalIdentity({issuer:'fixture',subject:'colleague',audience:'hub',displayName:'Colleague'})
  const outsider = await store.upsertExternalIdentity({issuer:'fixture',subject:'outsider',audience:'hub',displayName:'Hidden person'})
  for (const [memberId,tenantId,role] of [[member.id,a.id,'owner'],[member.id,b.id,'viewer'],[colleague.id,a.id,'analyst'],[colleague.id,other.id,'owner'],[outsider.id,other.id,'owner']]) await store.grantTenantMembership({memberId,tenantId,role})
  const ca = await store.createConsumer({tenantId:a.id,name:'IP'}), cb = await store.createConsumer({tenantId:b.id,name:'IP v2'})
  store.grants.set(ca.id,['ip_risk']);store.capabilityGrants.set(ca.id,['ip.risk.subscription.query'])
  store.grants.set(cb.id,['ip_risk']);store.capabilityGrants.set(cb.id,['ip.risk.query.v2'])
  let role = 'owner'
  const portal = { resolve: async () => ({kind:'launcher-user',memberId:member.id,platformAdmin:false,tenantIds:[a.id,b.id],memberships:[{tenantId:a.id,role,capabilities:capabilitiesForRole(role)},{tenantId:b.id,role:'viewer',capabilities:capabilitiesForRole('viewer')}],portalOrigin:'https://harbor.test'}) }
  const server = createServer(createApp({store,service,adapter:{},listenerMode:'admin',harborPortal:portal}))
  await new Promise(r => server.listen(0,'127.0.0.1',r)); t.after(() => new Promise(r => {server.close(r);server.closeAllConnections()}))
  const get = path => fetch(`http://127.0.0.1:${server.address().port}/internal/v1/portal${path}`)
  return {store,a,b,other,member,colleague,ca,cb,get,setRole:value=>{role=value}}
}

test('workspace roster is selected-tenant only with authoritative role capabilities and no global identity metadata', async t => {
  const f=await fixture(t),res=await f.get(`/me/workspace?tenantId=${f.a.id}`)
  assert.equal(res.status,200);const {data}=await res.json()
  assert.equal(data.role,'owner');assert.equal(data.members.length,2)
  assert.deepEqual(data.roles.find(r=>r.role==='admin').capabilities,capabilitiesForRole('admin'))
  assert.ok(data.members.every(m=>Object.keys(m).sort().join(',')==='displayName,id,memberStatus,role,status'))
  assert.ok(!JSON.stringify(data).includes(f.other.id))
  assert.equal((await f.get(`/me/workspace?tenantId=${f.other.id}`)).status,403)
  assert.equal((await f.get('/me/workspace')).status,400)
  assert.equal((await f.get(`/me/workspace?tenantId=${f.a.id}&tenantId=${f.b.id}`)).status,400)
  f.setRole('billing');assert.equal((await f.get(`/me/workspace?tenantId=${f.a.id}`)).status,200)
})

test('usage has complete daily aggregates, strict date ranges and selected-tenant capability enforcement', async t => {
  const f=await fixture(t),today=new Date();today.setUTCHours(0,0,0,1)
  for(let i=0;i<75;i++){const id=randomUUID();f.store.requests.set(id,{id,tenantId:f.a.id,consumerId:f.ca.id,platform:'ip_risk',capability:'ip.risk.subscription.query',status:i===0?'reserved':i===1?'unknown':i===2?'released':'committed',unitsActual:1,createdAt:today.toISOString()})}
  for(const [tenantId,time] of [[f.other.id,today.toISOString()],[f.a.id,'2020-01-01T00:00:00Z']]){const id=randomUUID();f.store.requests.set(id,{id,tenantId,status:'committed',createdAt:time})}
  const res=await f.get(`/me/usage?tenantId=${f.a.id}&days=7`);assert.equal(res.status,200);const {data}=await res.json()
  assert.equal(data.requests,75);assert.equal(data.committed,72);assert.equal(data.pending,1);assert.equal(data.unknown,1);assert.equal(data.released,1)
  assert.deepEqual(data.daily,[{day:today.toISOString().slice(0,10),requests:75,committed:72}])
  assert.equal(data.recentRequests,undefined);assert.equal(data.customerBilling,undefined)
  assert.equal((await f.get(`/me/usage?tenantId=${f.other.id}`)).status,403)
  for(const q of ['days=0','days=365','days=7&days=30','from=2020-01-01'])assert.equal((await f.get(`/me/usage?tenantId=${f.a.id}&${q}`)).status,400)
  f.setRole('billing');assert.equal((await f.get(`/me/usage?tenantId=${f.a.id}`)).status,403)
})

test('Harbor OpenAPI requires an explicit accessible space; different spaces never union their products', async t => {
  const f=await fixture(t),docs=tenant=>f.get(`/documentation?path=/docs/openapi.json&tenantId=${tenant}`)
  assert.equal((await f.get('/documentation?path=/docs/openapi.json')).status,404)
  assert.equal((await docs(f.other.id)).status,403)
  const a=(await (await docs(f.a.id)).json()).data.schema,b=(await (await docs(f.b.id)).json()).data.schema
  assert.ok(a.paths['/data/ip/risk/service']);assert.equal(a.paths['/data/ip/risk/v2'],undefined)
  assert.ok(b.paths['/data/ip/risk/v2']);assert.equal(b.paths['/data/ip/risk/service'],undefined)
  assert.ok(a.paths['/data/ip/risk/subscription']);assert.ok(b.paths['/data/ip/risk/subscription'])
  assert.equal(a.paths['/data/ip/risk/service'].post.parameters[0].name,'Idempotency-Key')
  assert.equal(a.paths['/data/ip/risk/service'].post.parameters[0].required,false)
  assert.ok(a.paths['/requests/{requestId}'],'common request lookup remains documented')
  assert.ok(Object.keys(a.paths).every(p=>!p.startsWith('/internal/')&&!p.startsWith('/night-all/')&&!p.startsWith('/tools/')))
  // Split platform/capability across consumers must not manufacture an entitlement.
  f.store.capabilityGrants.set(f.ca.id,[])
  const split=await f.store.createConsumer({tenantId:f.a.id,name:'split grant'})
  f.store.capabilityGrants.set(split.id,['ip.risk.subscription.query'])
  const c=(await (await docs(f.a.id)).json()).data.schema
  assert.equal(c.paths['/data/ip/risk/service'],undefined)
  f.store.grants.set(f.ca.id,[])
  f.store.capabilityGrants.set(split.id,[])
  // No sensitive service schemas may survive the filtered path closure.
  assert.ok(!JSON.stringify(c.components).includes('queryIpRiskSubscription'))
  await f.store.setTenantStatus(f.a.id,'suspended')
  assert.equal((await docs(f.a.id)).status,403)
})

// The ordinary v1 permission must not inherit subscription metadata visibility.
test('IP subscription document follows the same OR grants as the live read route', async () => {
  const { tenantOpenApiDocument } = await import('../../server/public-docs.mjs')
  for (const capability of ['ip.risk.query.v2','ip.risk.subscription.query']) assert.ok(tenantOpenApiDocument([{platforms:['ip_risk'],capabilities:[capability]}]).paths['/data/ip/risk/subscription'])
  assert.equal(tenantOpenApiDocument([{platforms:['ip_risk'],capabilities:['ip.risk.query']}]).paths['/data/ip/risk/subscription'],undefined)
  assert.equal(tenantOpenApiDocument([{platforms:['ip_risk'],capabilities:[]},{platforms:[],capabilities:['ip.risk.subscription.query']}]).paths['/data/ip/risk/subscription'],undefined)
})
