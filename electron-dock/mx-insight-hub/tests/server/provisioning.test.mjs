import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { ProvisioningService } from '../../server/commercial/provisioning.mjs'
import { PROVISIONING_OPERATIONS, officialPriceDraft } from '../../server/commercial/catalog.mjs'
import { normalizePriceDraft, procurementAmount } from '../../server/commercial/price-drafts.mjs'
import { transactionPool } from '../../server/commercial/transaction.mjs'
import { createApp } from '../../server/app.mjs'
const operation = PROVISIONING_OPERATIONS.find(row => row.id === 'justone:native.j.douyin_search_video_v4')
async function fixture() {
  const store = new MemoryStore(), control = new MemoryExternalPlatformControlStore()
  const adapter = { search: () => { throw Error('No upstream work during provisioning') } }
  const service = new HubService({ store, adapter, apiKeyPepper: 'synthetic-provisioning-pepper-only-long' })
  const tenant = await service.createTenant({ name: 'Test tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Test consumer' })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Target' })
  const sibling = await service.createApiKey({ consumerId: consumer.id, name: 'Sibling' })
  const provision = new ProvisioningService({ service, control, runtime: async () => ({ credentialConfigured: true, config: { timeoutMs: 1000 } }) })
  const draft = await provision.createDraft({ provider: 'justone', name: 'Account contract', sourceKind: 'contract', sourceUrl: 'https://example.com/prices', observedAt: '2026-09-26',
    rates: operation.endpointKeys.map(endpointKey => ({ endpointKey, currency: 'CNY', unitPrice: '0.0038', billingUnit: 'request' })) })
  const spec = { keyId: key.id, operationIds: [operation.id], draftId: draft.id, monthlyBudgetMinor: 10000, monthlySubsidyBudgetMinor: 0,
    currency: 'CNY', salePrices: { [operation.id]: 10 }, acknowledgeRounding: true, reason: 'Explicit bounded test provisioning' }
  return { store, service, control, provision, spec, draft, key, sibling, consumer, tenant, adapter }
}
test('exact procurement references preserve sub-cent prices; unsupported or duplicate rates fail closed', () => {
  assert.deepEqual(procurementAmount('0.003800','USD'), { unitPrice:'0.0038',currency:'USD',scale:6,amountMicros:'3800',budgetMinor:1,rounded:true })
  const { available: _, ...official } = officialPriceDraft('qixin')
  assert.equal(normalizePriceDraft(official).rates.length, 260)
  assert.throws(() => procurementAmount('0.0000001','USD'))
  assert.throws(() => procurementAmount('1','JPY'))
})
test('atomic provisioning preserves key secrets, sibling scopes, wallets and unrelated rates; replay applies once', async () => {
  const f = await fixture()
  const secrets = [...f.store.apiKeys].map(([id,row])=>[id,row.digest,row.expiresAt])
  const wallet = structuredClone([f.store.creditAccounts,f.store.creditLedgerEntries,f.store.customerCharges])
  const preview = await f.provision.preview(f.spec)
  assert.equal(preview.preview.canApply, true, JSON.stringify(preview.preview.rows[0].blockers))
  assert.equal((await f.store.listGrants(f.consumer.id)).length,0)
  const result = await f.provision.apply(preview.id)
  assert.equal(result.status,'completed')
  assert.deepEqual(await f.provision.apply(preview.id),result)
  const keys = await f.store.listApiKeys()
  assert.deepEqual(keys.find(row=>row.id===f.key.id).capabilities,[operation.capability])
  assert.deepEqual(keys.find(row=>row.id===f.sibling.id).capabilities,[])
  assert.deepEqual([...f.store.apiKeys].map(([id,row])=>[id,row.digest,row.expiresAt]),secrets)
  assert.deepEqual([f.store.creditAccounts,f.store.creditLedgerEntries,f.store.customerCharges],wallet)
  const view=(await f.control.describeProvider('justone',{credentialConfigured:true})).find(row=>row.operationKey===operation.operation)
  assert.equal(view.desiredState,'canary'); assert.deepEqual(view.canaryConsumerIds,[f.consumer.id])
  assert.equal(f.control.events.length,1)
  assert.equal((await f.store.getConsumerPlan(f.consumer.id)).priceBook.entries[0].unitPriceMinor,10)
  assert.equal(f.provision.references.length,1)
})
test('stale and paused previews cannot expand grants; expired previews do not publish plans', async () => {
  const f=await fixture(), preview=await f.provision.preview(f.spec)
  const row=f.control.rows.get(operation.id); row.desiredState='paused'; row.revision++
  await assert.rejects(f.provision.apply(preview.id),{code:'provisioning_changed'})
  const next=await f.provision.preview(f.spec)
  assert.equal(next.preview.canApply,false)
  await assert.rejects(f.provision.apply(next.id),{code:'provisioning_blocked'})
  f.provision.batches.get(next.id).expiresAt='2000-01-01'
  await assert.rejects(f.provision.apply(next.id),{code:'provisioning_expired'})
  assert.equal(f.store.plans.length,1); assert.deepEqual(await f.store.listGrants(f.consumer.id),[])
})
test('failure after simulated policy write rolls back all metadata; same saved preview remains retryable', async () => {
  const f=await fixture(), preview=await f.provision.preview(f.spec)
  const original=f.provision.write.bind(f.provision)
  f.provision.write=async (...args)=>{ await original(...args); throw Error('Injected before commit') }
  await assert.rejects(f.provision.apply(preview.id),/Injected/)
  assert.equal(f.control.events.length,0); assert.equal(f.store.plans.length,1)
  assert.deepEqual(await f.store.listGrants(f.consumer.id),[])
  assert.equal((await f.provision.batch(preview.id)).status,'preview')
  f.provision.write=original
  assert.equal((await f.provision.apply(preview.id)).status,'completed')
})
test('missing price and unacknowledged rounding are blockers; negotiated enterprise endpoints stay blocked',async()=>{
  const f=await fixture()
  const missing=await f.provision.preview({...f.spec,draftId:null})
  assert.ok(missing.preview.rows[0].blockers.includes('procurement_price_missing'))
  const rounding=await f.provision.preview({...f.spec,acknowledgeRounding:false})
  assert.ok(rounding.preview.rows[0].blockers.includes('rounding_acknowledgment_required'))
  const blocked=PROVISIONING_OPERATIONS.find(row=>row.blocked)
  const negotiated=await f.provision.preview({...f.spec,operationIds:[blocked.id],salePrices:{}})
  assert.ok(negotiated.preview.rows[0].blockers.includes(blocked.blocked))
})
test('savepoint facade never commits the surrounding transaction and rejects concurrent nested leases',async()=>{
  const calls=[],pool=transactionPool({query:async sql=>calls.push(sql)})
  const client=await pool.connect(); await client.query('BEGIN')
  await assert.rejects(pool.connect(),/Concurrent/)
  await client.query('UPDATE fixture'); await client.query('COMMIT');client.release()
  const second=await pool.connect();await second.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await second.query('ROLLBACK');second.release()
  assert.deepEqual(calls,['SAVEPOINT provisioning_1','UPDATE fixture','RELEASE SAVEPOINT provisioning_1','SAVEPOINT provisioning_2','ROLLBACK TO SAVEPOINT provisioning_2','RELEASE SAVEPOINT provisioning_2'])
})
test('provisioning routes require an Admin token and use no-store',async t=>{
  const f=await fixture()
  const server=createServer(createApp({service:f.service,store:f.store,adapter:f.adapter,provisioning:f.provision,adminToken:'fixture-admin',identity:{enabled:true,resolve:async()=>({kind:'launcher',platformAdmin:true,capabilities:['membership.write']})}}))
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close())
  const url=`http://127.0.0.1:${server.address().port}/internal/v1/admin/provisioning/catalog`
  const denied=await fetch(url);assert.equal(denied.status,401)
  const member=await fetch(url,{headers:{authorization:'Bearer synthetic-launcher-session'}});assert.equal(member.status,403)
  const allowed=await fetch(url,{headers:{'x-mx-insight-admin-token':'fixture-admin'}})
  assert.equal(allowed.status,200);assert.match(allowed.headers.get('cache-control'),/no-store/)
  assert.ok((await allowed.json()).data.operations.length>300)
})

test('an existing plan exception, tenant multiplier and procurement price survive additive scope changes',async()=>{
  const f=await fixture()
  const initial=await f.service.publishPlanVersion({key:'existing-test-price',name:'Existing exception',limits:{monthlyRequests:12345,maxPageSize:45},priceBook:{key:'existing-test-price',currency:'CNY',defaultMultiplierPpm:1000000,entries:[{meterKey:'ip.risk.query',unitPriceMinor:47},{meterKey:operation.meterKey,unitPriceMinor:0}]}},'test')
  await f.service.assignConsumerPlan(f.consumer.id,{planVersionId:initial.versionId,expectedRevision:1},'test')
  await f.store.replaceTenantBillingProfile({tenantId:f.tenant.id,mode:'shadow',multiplierPpm:800000,updatedBy:'test'})
  await f.control.updatePolicy(operation.provider,operation.operation,{expectedRevision:1,desiredState:'active',priceBook:{currency:'CNY',pricingAsOf:'2026-09-20',monthlyBudgetMinor:1234,monthlySubsidyBudgetMinor:50,unitCostMinorByEndpoint:Object.fromEntries(operation.endpointKeys.map(key=>[key,8]))},reason:'Existing reviewed exception'},{runtime:{credentialConfigured:true}})
  const spec={...f.spec,salePrices:{},draftId:null}
  const preview=await f.provision.preview(spec)
  assert.equal(preview.preview.rows[0].replacePrice,false)
  assert.equal(preview.preview.rows[0].effectivePrice.quotedMinor,0)
  await f.provision.apply(preview.id)
  assert.equal((await f.store.getConsumerPlan(f.consumer.id)).versionId,initial.versionId)
  assert.equal((await f.store.getTenantBilling(f.tenant.id)).profile.multiplierPpm,800000)
  const current=(await f.control.describeProvider('justone',{credentialConfigured:true})).find(row=>row.operationKey===operation.operation)
  assert.equal(current.priceBook.monthlyBudgetMinor,1234)
  assert.equal(current.priceBook.endpointPrices[operation.endpointKeys[0]],8)
  assert.equal(current.desiredState,'active')
})

test('provider-sized explicit batches exceed 128 scopes without granting sibling Keys or future endpoints',async()=>{
  const f=await fixture()
  const {available,...spec}=officialPriceDraft('tikhub')
  assert.equal(available,true)
  const draft=await f.provision.createDraft(spec)
  const keys=new Set(draft.spec.rates.filter(row=>row.budgetMinor>0).map(row=>row.endpointKey))
  const operations=PROVISIONING_OPERATIONS.filter(row=>row.provider==='tikhub'&&row.endpointKeys.every(key=>keys.has(key)))
  assert.ok(operations.length>400)
  const batch=await f.provision.preview({...f.spec,operationIds:operations.map(row=>row.id),draftId:draft.id,salePrices:{}})
  assert.equal(batch.preview.canApply,true,JSON.stringify(batch.preview.rows.filter(row=>row.blockers.length).map(row=>row.blockers)))
  const receipt=await f.provision.apply(batch.id)
  assert.equal(receipt.applied.length,operations.length)
  const after=await f.store.listApiKeys()
  assert.equal(after.find(row=>row.id===f.key.id).capabilities.length,operations.length)
  assert.deepEqual(after.find(row=>row.id===f.sibling.id).capabilities,[])
  assert.deepEqual(await f.provision.apply(batch.id),receipt)
})
