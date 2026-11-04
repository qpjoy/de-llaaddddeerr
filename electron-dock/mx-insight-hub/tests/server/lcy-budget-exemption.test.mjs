import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { MemoryExternalPlatformStore, PostgresExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { memoryBudgetExempt, postgresBudgetExempt, budgetExemptionProjection } from '../../server/external-platforms/budget-exemption.mjs'
import { internalCircuitState } from '../../server/core/internal-traffic-policy.mjs'
import { LCY_IDENTITY as ids } from '../fixtures/lcy-hub-limit-store.mjs'

const identity = { apiKeyId: ids.key, tenantId: ids.tenant, consumerId: ids.consumer }
const cost = { costMinor: 5, currency: 'CNY', costKind: 'estimated', monthlyBudgetMinor: 0, monthlySubsidyBudgetMinor: 0 }
const input = () => ({ ...identity, id: randomUUID(), usageRequestId: randomUUID(), fingerprint: 'a'.repeat(64),
  operation: 'ecommerce.products.search', contractVersion: 'mx-insight-hub.ecommerce-products.v1', endpointKey: 'jd.product-search.v1', endpointVersion: 'v1', marketplace: 'jd' })
function fixture() {
  const request = input()
  const usage = { ...request, id: request.usageRequestId, status: 'reserved', platform: 'ecommerce', leaseExpiresAt: new Date(Date.now()+60000).toISOString() }
  const key = { ...identity, id: ids.key, hubRateLimitExempt: true, name: 'renamed original', status: 'active', environment: 'live', expiresAt: '2099-01-01T00:00:00Z' }
  const store = { requests: new Map([[usage.id,usage]]), apiKeys: new Map([[ids.key,key]]), tenants: new Map([[ids.tenant,{status:'active'}]]),
    consumers: new Map([[ids.consumer,{tenantId:ids.tenant,status:'active'}]]) }
  return { request, usage, key, store, platform: new MemoryExternalPlatformStore({ usageStore: store }) }
}

test('LCY skips zero/exhausted budgets for standalone and workflow costs, retaining evidence and duplicate guards', async () => {
  for (const workflow of [false,true]) {
    const f=fixture()
    f.platform.calls.set('unrelated', { providerKey:'justone',usageRequestId:randomUUID(),costMinor:null,costKind:'estimated',currency:'CNY',startedAt:new Date().toISOString() })
    const hold=workflow ? await f.platform.reserveProviderCostWorkflow({...f.request,costControls:[cost]}) : null
    const call=await f.platform.beginProviderCall({...f.request,costControl:cost,costReservationId:hold?.id})
    assert.equal(call.costMinor,5)
    assert.equal(call.costKind,'estimated')
    assert.equal(f.store.customerCharges,undefined, 'budget exemption must not manufacture a customer charge')
    await assert.rejects(f.platform.beginProviderCall({...f.request,id:randomUUID(),costControl:cost,costReservationId:hold?.id}))
    assert.equal(f.platform.calls.size,2)
    if(hold) await f.platform.releaseProviderCostWorkflow({reservationId:hold.id,usageRequestId:f.request.usageRequestId})
    f.platform.calls.delete('unrelated')
    f.key.hubRateLimitExempt=false
    const next={...f.request,id:randomUUID(),usageRequestId:randomUUID()}
    f.store.requests.set(next.usageRequestId,{...f.usage,id:next.usageRequestId})
    await assert.rejects(f.platform.reserveProviderCostWorkflow({...next,costControls:[cost]}), {code:'external_platform_cost_budget_exhausted'})
  }
})

test('LCY budget exception never accepts request flags, siblings, inactive identities or an unsaved switch', async () => {
  for(const change of [f=>{f.key.hubRateLimitExempt=false},f=>{f.key.hubRateLimitExempt=null},
    f=>{f.key.status='revoked'},f=>{f.key.environment='test'},f=>{f.key.expiresAt='2000-01-01'},
    f=>{f.store.tenants.get(ids.tenant).status='suspended'},f=>{f.store.consumers.get(ids.consumer).status='suspended'},
    f=>{f.key.consumerId=randomUUID()},f=>{f.usage.apiKeyId=randomUUID();f.store.apiKeys.set(f.usage.apiKeyId,{...f.key,id:f.usage.apiKeyId,name:'LCY-delta'})}]) {
    const f=fixture();change(f)
    assert.equal(memoryBudgetExempt(f.store,{...f.usage,hubRateLimitExempt:true}),false)
  }
  const f=fixture()
  f.platform.calls.set('own-broken', {providerKey:'justone',usageRequestId:f.usage.id,costMinor:null,costKind:'estimated',currency:'CNY',startedAt:new Date().toISOString()})
  await assert.rejects(f.platform.reserveProviderCostWorkflow({...f.request,costControls:[cost]}),{code:'external_platform_cost_evidence_incomplete'})
})

test('explicit LCY exemption projects automatic circuits without clearing shared or per-contract state', () => {
  const f=fixture(),context={apiKey:f.key,tenant:{id:ids.tenant},consumer:{id:ids.consumer}}
  for(const lastErrorCode of ['upstream_rate_limited','upstream_balance_exhausted','upstream_auth_or_balance_unavailable','upstream_transport_error','invalid_upstream_contract']) {
    const shared=Object.freeze({lastErrorCode,circuitOpenUntil:new Date(Date.now()+60000).toISOString(),consecutiveFailures:5})
    const view=internalCircuitState({},context,shared)
    assert.equal(view.circuitOpenUntil,null);assert.equal(view.hubCircuitExempt,true);assert.equal(view.consecutiveFailures,5)
    assert(shared.circuitOpenUntil)
    assert.equal(internalCircuitState({}, {...context,apiKey:{...f.key,hubRateLimitExempt:false}},shared),shared)
    assert.equal(internalCircuitState({}, {...context,apiKey:{...f.key,id:randomUUID()}},shared),shared)
  }
})

const modulePath=process.env.MX_INSIGHT_TEST_PGLITE_MODULE
test('PostgreSQL cost paths read current stored LCY authority, preserving cost controls and scope', {skip:!modulePath}, async t => {
  const {PGlite}=await import(pathToFileURL(modulePath).href),db=new PGlite();t.after(()=>db.close())
  await db.exec(`CREATE TABLE tenants(id uuid PRIMARY KEY,status text);
    CREATE TABLE consumers(id uuid PRIMARY KEY,tenant_id uuid,status text);
    CREATE TABLE api_keys(id uuid PRIMARY KEY,tenant_id uuid,consumer_id uuid,status text,environment text,expires_at timestamptz,hub_rate_limit_exempt boolean);
    CREATE TABLE usage_requests(id uuid PRIMARY KEY,tenant_id uuid,consumer_id uuid,api_key_id uuid,status text);`)
  const request=input()
  await db.query("INSERT INTO tenants VALUES($1,'active')",[ids.tenant])
  await db.query("INSERT INTO consumers VALUES($1,$2,'active')",[ids.consumer,ids.tenant])
  await db.query("INSERT INTO api_keys VALUES($1,$2,$3,'active','live','2099-01-01',true)",[ids.key,ids.tenant,ids.consumer])
  await db.query("INSERT INTO usage_requests VALUES($1,$2,$3,$4,'reserved')",[request.usageRequestId,ids.tenant,ids.consumer,ids.key])
  assert.equal(await postgresBudgetExempt(db,request),true)
  assert.equal(await postgresBudgetExempt(db,{...request,usageRequestId:randomUUID()}),false)
  const inserted=[]
  let currentAnomaly=0
  const client={release(){},async query(sql,values){
    if(sql.includes('key.hub_rate_limit_exempt AS exempt')) return db.query(sql,values)
    if(['BEGIN','COMMIT','ROLLBACK','SET LOCAL synchronous_commit TO off'].includes(sql)||sql.includes('pg_advisory_xact_lock'))return {rows:[]}
    if(/^\s*SELECT request\.id/.test(sql))return {rows:[{id:request.usageRequestId}]}
    if(sql.includes('AS known_cost_minor'))return {rows:[{...((await db.query('SELECT 1' + budgetExemptionProjection(request).replace('$3','$1'),[request.usageRequestId])).rows[0]),known_cost_minor:'999999',unknown_cost_calls:3,current_unknown_cost_calls:currentAnomaly,
      subsidy_cost_minor:'999999',reserved_cost_minor:'999999',reserved_subsidy_minor:'999999',mixed_reservation_count:2,current_mixed_reservation_count:0,
      usage_cost_minor:'0',customer_coverage_minor:null,customer_billed:false,reservation_id:null}]}
    if(sql.includes('WITH owned_request AS MATERIALIZED')){inserted.push(values);return {rows:[{id:request.id,started_at:new Date()}]}}
    if(sql.includes('INSERT INTO external_platform.provider_cost_reservations')){inserted.push(values);return {rows:[{created_at:new Date()}]}}
    if(sql.includes('UPDATE external_platform.provider_state'))return {rows:[]}
    throw Error('Unexpected SQL in cost fixture')
  }}
  const platform=new PostgresExternalPlatformStore({pool:{connect:async()=>client,query:async()=>assert.fail('unexpected reconciliation')}})
  await platform.reserveProviderCostWorkflow({...request,costControls:[cost]})
  await platform.beginProviderCall({...request,costControl:cost})
  assert.equal(inserted.length,2)
  assert.equal(inserted[1][17],5);assert.equal(inserted[1][18],'estimated');assert.equal(inserted[1][19],'CNY')
  currentAnomaly=1
  await assert.rejects(platform.reserveProviderCostWorkflow({...request,costControls:[cost]}),{code:'external_platform_cost_evidence_incomplete'})
  currentAnomaly=0
  for(const sql of ["UPDATE api_keys SET hub_rate_limit_exempt=false","UPDATE api_keys SET hub_rate_limit_exempt=null",
    "UPDATE api_keys SET hub_rate_limit_exempt=true,status='revoked'","UPDATE api_keys SET status='active',expires_at='2000-01-01'"]) {
    await db.exec(sql)
    assert.equal(await postgresBudgetExempt(db,request),false)
    await assert.rejects(platform.reserveProviderCostWorkflow({...request,costControls:[cost]}),{code:'external_platform_cost_evidence_incomplete'})
  }
  assert.equal(inserted.length,2)
})
