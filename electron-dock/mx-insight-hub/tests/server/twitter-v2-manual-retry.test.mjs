import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'
import { createTwitterSearchRouter } from '../../server/data/twitter-search-routing.mjs'
import { SearchProtocolStore } from '../../server/data/search-protocol-store.mjs'
import { twitterProtocolRetryIntents } from '../../server/external-platforms/twitter-manual-retry.mjs'

const pepper='v2-manual-twitter-retry-fixture-pepper'
const BODY={platform:'twitter',query:'synthetic policy summit',pageSize:1,type:'fresh',timeWindow:{
  from:'2026-10-16T16:00:00.000Z',to:'2026-10-18T16:00:00.000Z',timezone:'Asia/Shanghai',boundary:'[from,to)'}}
const timeline=ids=>({entries:ids.map(id=>({content:{itemContent:{tweet_results:{result:{rest_id:String(id),
  legacy:{full_text:`Post ${id}`,created_at:'Sat Oct 17 01:00:00 +0000 2026'}}}}}}))})

async function fixture() {
  const usage=new MemoryStore(),service=new HubService({store:usage,adapter:{},apiKeyPepper:pepper})
  const tenant=await service.createTenant({name:'v2 retry fixture'}),consumer=await service.createConsumer({tenantId:tenant.id,name:'v2 retry consumer'})
  await usage.setPlatformGrant(consumer.id,'twitter',true)
  const key=await service.createApiKey({consumerId:consumer.id,name:'v2 retry key',platforms:['twitter'],capabilities:[]})
  const context=await service.authenticate(key.secret),controls=new MemoryExternalPlatformControlStore()
  const config={configured:true,dispatchEnabled:true,contractVerified:true,timeoutMs:100,freshTtlMs:60000,staleTtlMs:86400000,
    maxConcurrency:3,maxConsumerConcurrency:3,maxRequestsPerMinute:100,billing:{}}
  await controls.updatePolicy('rapidapi','social.content.search',{expectedRevision:1,desiredState:'active',reason:'Offline v2 fixture',
    priceBook:{currency:'USD',pricingAsOf:'2026-10-15T00:00:00Z',monthlyBudgetMinor:100000,monthlySubsidyBudgetMinor:100000,
      unitCostMinorByEndpoint:{'twitter-aio.search':1}}},{runtime:{config,credentialConfigured:true}})
  const store=new MemoryExternalPlatformStore({usageStore:usage,providerKey:'rapidapi',authorizationPlatform:'twitter',circuitFailureThreshold:100})
  let reply=async()=>{throw new Error('synthetic ambiguous request')},calls=0,fallbackCalls=0
  const adapter=new RapidApiAdapter({apiKey:'synthetic',timeoutMs:100,fetchImpl:async()=>{calls++;return Response.json(await reply())}})
  const gateway=new ExternalPlatformGateway({usageStore:usage,platformStore:store,adapter,config,providerKey:'rapidapi',apiKeyPepper:pepper,
    operationControlStore:controls,reservationLeaseMs:120000,logger:{warn(){},error(){}}})
  service.twitterRetryStore=store
  service.externalDataSearch=createTwitterSearchRouter({usageStore:usage,rapidGateway:gateway,
    tikHubGateway:{platformStore:{calls:new Map()},searchContent:async()=>{fallbackCalls++;throw new Error('unexpected supplier switch')}},
    apiKeyPepper:pepper,provider:'rapidapi'})
  const invoke=(idempotencyKey, retryOfRequestId, body=BODY, caller=context)=>service.search(caller,
    {path:'/api/v2/data/search',body,idempotencyKey,...(retryOfRequestId?{retryOfRequestId}:{})})
  const original=async()=>{await assert.rejects(invoke('original-v2-unknown-key'),{code:'request_outcome_unknown'});
    return [...usage.requests.values()].find(row=>row.idempotencyKey==='original-v2-unknown-key')}
  return {usage,store,service,gateway,context,key,invoke,original,reply:value=>{reply=value},calls:()=>calls,fallbackCalls:()=>fallbackCalls}
}

test('explicit v2 retry preserves the full window and unknown hold, records one successor and continues its paid cursor',async()=>{
  const f=await fixture()
  await f.service.setTenantBillingProfile(f.context.tenant.id,{mode:'enforced',multiplierPpm:1000000,defaultUnitPriceMinor:1,defaultCurrency:'CNY'},'test-admin')
  await f.service.addTenantCredit(f.context.tenant.id,{amountMinor:100,currency:'CNY',reason:'Offline v2 retry'},
    {idempotencyKey:'v2-retry-credit',actor:'test-admin'})
  const old=await f.original(),before=structuredClone(old),charge=structuredClone(f.usage.customerCharges.get(old.id))
  f.reply(async()=>timeline([1,2]))
  const first=await f.invoke('v2-explicit-successor',old.id)
  assert.equal(first.status,200);assert.equal(first.body.data.contractVersion,'mx-insight-hub.data-search.v2')
  assert.deepEqual(first.body.data.meta.requestedWindow,BODY.timeWindow)
  assert.deepEqual(first.body.data.items.map(item=>item.id),['1'])
  assert.equal(f.calls(),2);assert.equal(f.fallbackCalls(),0)
  assert.equal(await f.store.twitterManualRetryOwnerFor(old.id),first.requestId)
  assert.deepEqual(f.usage.requests.get(old.id),before);assert.deepEqual(f.usage.customerCharges.get(old.id),charge)
  for(const retryOf of [undefined,old.id]) assert.deepEqual((await f.invoke('v2-explicit-successor',retryOf)).body,first.body)
  await assert.rejects(f.invoke('v2-explicit-rival',old.id),{code:'uncertain_retry_not_allowed'})
  const next=await f.invoke('v2-successor-next-page',undefined,{...BODY,cursor:first.body.data.pageInfo.nextCursor})
  assert.deepEqual(next.body.data.items.map(item=>item.id),['2']);assert.equal(f.calls(),2)
  assert.equal(twitterProtocolRetryIntents(f.usage).size,1)
  const recovery=await f.service.twitterSearchRecovery(f.context,old.id)
  assert.equal(recovery.successor.requestId,first.requestId);assert.deepEqual(recovery.delivery.body,first.body)
  assert.equal(recovery.request.path,'/api/v2/data/search');assert.deepEqual(recovery.request.body,BODY)
  if(process.env.MX_INSIGHT_WRITE_RECOVERY_FIXTURE) await writeFile(process.env.MX_INSIGHT_WRITE_RECOVERY_FIXTURE,JSON.stringify({
    originalKey:'original-v2-unknown-key',payload:BODY,receipt:{data:{id:old.id,platform:'twitter',status:'unknown',
      searchProtocol:{version:2,state:'unknown',acquisitionRequestId:old.id}}},data:recovery},null,2))
})

test('v2 retry pre-dispatch refusal reserves one stable intent and only that key may resume',async()=>{
  const f=await fixture(),old=await f.original(),before=structuredClone(old)
  f.store.state.circuitOpenUntil=new Date(Date.now()+60000).toISOString()
  await assert.rejects(f.invoke('v2-resume-only-this-key',old.id),{code:'external_platform_circuit_open'})
  assert.equal(twitterProtocolRetryIntents(f.usage).size,1);assert.equal(f.calls(),1)
  const unstarted=[...f.usage.requests.values()].find(row=>row.idempotencyKey==='v2-resume-only-this-key')
  assert.equal(unstarted.status,'released')
  assert.equal([...f.store.calls.values()].some(call=>call.usageRequestId===unstarted.id),false)
  const pending=await f.service.twitterSearchRecovery(f.context,old.id)
  assert.equal(pending.successor.state,'retryable');assert.equal(pending.successor.requestId,unstarted.id);assert.equal(pending.delivery,null)
  await assert.rejects(f.invoke('v2-new-key-must-not-fork',old.id),{code:'uncertain_retry_not_allowed'})
  const inner={platform:'twitter',query:BODY.query,pageSize:1,type:'stable'}
  await assert.rejects(f.gateway.searchRaw(f.context,{body:inner,normalized:inner,idempotencyKey:'v1-cannot-fork-v2-intent',
    retryOfRequestId:old.id,dataSearch:{resultType:'stable',replayWindowMs:null}}),{code:'uncertain_retry_not_allowed'})
  f.store.state.circuitOpenUntil=null;f.reply(async()=>timeline([1]))
  assert.equal((await f.invoke('v2-resume-only-this-key')).status,200)
  assert.equal(f.calls(),2);assert.deepEqual(f.usage.requests.get(old.id),before)
})

test('v2 retry requires exact v2 evidence and rejects changed scope, committed projection unknown and missing receipts',async()=>{
  const f=await fixture(),old=await f.original()
  for(const patch of [{query:'changed'},{pageSize:2},{type:'stable'},
    {timeWindow:{...BODY.timeWindow,to:'2026-10-18T17:00:00.000Z'}}]) {
    await assert.rejects(f.invoke(`v2-denied-${randomUUID()}`,old.id,{...BODY,...patch}),{code:'uncertain_retry_not_allowed'})
  }
  await assert.rejects(f.invoke('v2-missing-receipt',randomUUID()),{code:'uncertain_retry_not_allowed'})
  const otherKey=await f.service.createApiKey({consumerId:f.context.consumer.id,name:'Another v2 Key',platforms:['twitter'],capabilities:[]})
  const other=await f.service.authenticate(otherKey.secret)
  await assert.rejects(f.invoke('v2-different-api-key',old.id,BODY,other),{code:'uncertain_retry_not_allowed'})
  await assert.rejects(f.service.twitterSearchRecovery(other,old.id),{code:'request_not_found'})
  await assert.rejects(f.invoke('v2-non-twitter-retry',old.id,{...BODY,platform:'facebook'}),{code:'uncertain_retry_not_supported'})
  old.status='committed'
  await assert.rejects(f.invoke('v2-committed-projection',old.id),{code:'uncertain_retry_not_allowed'})
  assert.equal(f.calls(),1);assert.equal(twitterProtocolRetryIntents(f.usage).size,0)
})

test('v2 successful receipts replay without the retry header or the original remaining unknown',async()=>{
  const f=await fixture(),old=await f.original()
  f.reply(async()=>timeline([1]))
  const result=await f.invoke('v2-permanent-retry-receipt',old.id)
  old.status='committed' // Independent resolution cannot invalidate a saved successor delivery.
  for(const retryOf of [undefined,old.id]) assert.deepEqual((await f.invoke('v2-permanent-retry-receipt',retryOf)).body,result.body)
  await assert.rejects(f.invoke('v2-permanent-retry-receipt',randomUUID()),{code:'uncertain_retry_not_allowed'})
  assert.equal(f.calls(),2)
})

test('v2 recovery returns an already complete original v2 delivery without creating a retry',async()=>{
  const f=await fixture()
  f.reply(async()=>timeline([1]))
  const result=await f.invoke('v2-original-complete')
  const recovered=await f.service.twitterSearchRecovery(f.context,result.requestId)
  assert.equal(recovered.state,'complete');assert.equal(recovered.successor,null)
  assert.deepEqual(recovered.delivery,{requestId:result.requestId,status:200,body:result.body})
  assert.equal(f.calls(),1);assert.equal(twitterProtocolRetryIntents(f.usage).size,0)
})

test('v2 retry unknown chains remain one-to-one and recovery follows the last explicitly authorized delivery',async()=>{
  const f=await fixture(),old=await f.original()
  await assert.rejects(f.invoke('v2-first-retry-unknown',old.id),{code:'request_outcome_unknown'})
  const next=[...f.usage.requests.values()].find(row=>row.idempotencyKey==='v2-first-retry-unknown')
  f.reply(async()=>timeline([1]))
  const last=await f.invoke('v2-second-explicit-retry',next.id)
  assert.equal(f.calls(),3)
  await assert.rejects(f.invoke('v2-fork-old-parent',old.id),{code:'uncertain_retry_not_allowed'})
  const recovery=await f.service.twitterSearchRecovery(f.context,old.id)
  assert.equal(recovery.successor.requestId,last.requestId);assert.deepEqual(recovery.delivery.body,last.body)
  assert.equal(f.usage.requests.get(old.id).status,'unknown');assert.equal(next.status,'unknown')
})

test('simultaneous v2 retry clicks and lost responses retain one durable key and one successor acquisition',async()=>{
  const f=await fixture(),old=await f.original()
  let entered,release
  const started=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve})
  f.reply(async()=>{entered();await gate;return timeline([1])})
  const first=f.invoke('v2-concurrent-successor',old.id)
  await started
  try {
    await assert.rejects(f.invoke('v2-concurrent-successor'),{code:'request_in_progress'})
    await assert.rejects(f.invoke('v2-concurrent-other-key',old.id),{code:'uncertain_retry_not_allowed'})
  } finally {release()}
  const result=await first
  assert.equal(f.calls(),2);assert.equal(twitterProtocolRetryIntents(f.usage).size,1)
  assert.deepEqual((await f.invoke('v2-concurrent-successor')).body,result.body)
  assert.equal(f.calls(),2)
})

test('retrying a later unknown cursor page retains the earlier acknowledged unknown lineage',async()=>{
  const f=await fixture(),old=await f.original()
  f.reply(async()=>timeline([1,2,3]))
  const retry=await f.invoke('v2-retry-root-with-carry',old.id)
  const nextBody={...BODY,cursor:retry.body.data.pageInfo.nextCursor}
  const commit=f.store.commitTwitterFillDelivery.bind(f.store)
  f.store.commitTwitterFillDelivery=async()=>{throw new Error('synthetic cursor delivery failure')}
  await assert.rejects(f.invoke('v2-later-cursor-unknown',undefined,nextBody),{code:'request_outcome_unknown'})
  const later=[...f.usage.requests.values()].find(row=>row.idempotencyKey==='v2-later-cursor-unknown')
  assert.equal(later.status,'unknown')
  f.store.commitTwitterFillDelivery=commit
  const recovered=await f.invoke('v2-retry-later-cursor',later.id,nextBody)
  assert.deepEqual(recovered.body.data.items.map(item=>item.id),['2'])
  assert.equal(f.calls(),2,'the already-acquired carry is reused without another supplier request')
  const binding=await new SearchProtocolStore(f.usage).binding(f.context,'v2-retry-later-cursor')
  assert.deepEqual(new Set(binding.acknowledgedRequestIds),new Set([old.id,later.id]))
  const last=await f.invoke('v2-later-next-cursor',undefined,{...BODY,cursor:recovered.body.data.pageInfo.nextCursor})
  assert.deepEqual(last.body.data.items.map(item=>item.id),['3']);assert.equal(f.calls(),2)
  assert.equal(f.usage.requests.get(old.id).status,'unknown');assert.equal(later.status,'unknown')
})
