import assert from 'node:assert/strict'
import test from 'node:test'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'

const secret='PRIVATE-query-cursor-authorization-sql-detail'
async function fixture({ method, loggerThrows=false, wrapped=false, malicious=false, pageSize=1, pages=null }={}) {
  const usage=new MemoryStore(), pepper='twitter-failure-logging-offline-pepper'
  const service=new HubService({store:usage,adapter:{},apiKeyPepper:pepper})
  const tenant=await service.createTenant({name:'Offline logging fixture'})
  const consumer=await service.createConsumer({tenantId:tenant.id,name:'Offline consumer'})
  await usage.setPlatformGrant(consumer.id,'twitter',true)
  const key=await service.createApiKey({consumerId:consumer.id,name:'Offline key',platforms:['twitter'],capabilities:[]})
  const context=await service.authenticate(key.secret)
  await service.setTenantBillingProfile(tenant.id,{mode:'enforced',multiplierPpm:1000000,defaultUnitPriceMinor:1,defaultCurrency:'CNY'},'offline-admin')
  await service.addTenantCredit(tenant.id,{amountMinor:100,currency:'CNY',reason:'Offline test'},
    {idempotencyKey:'offline-logging-credit',actor:'offline-admin'})
  const controls=new MemoryExternalPlatformControlStore()
  const config={configured:true,dispatchEnabled:true,contractVerified:true,timeoutMs:100,freshTtlMs:60000,staleTtlMs:86400000,
    maxConcurrency:3,maxConsumerConcurrency:3,maxRequestsPerMinute:100,billing:{}}
  await controls.updatePolicy('rapidapi','social.content.search',{expectedRevision:1,desiredState:'active',reason:'Offline fixture',
    priceBook:{currency:'USD',pricingAsOf:'2026-10-15T00:00:00Z',monthlyBudgetMinor:100000,monthlySubsidyBudgetMinor:100000,
      unitCostMinorByEndpoint:{'twitter-aio.search':1}}},{runtime:{config,credentialConfigured:true}})
  const store=new MemoryExternalPlatformStore({usageStore:usage,providerKey:'rapidapi',authorizationPlatform:'twitter',circuitFailureThreshold:100})
  let calls=0
  const adapter=new RapidApiAdapter({apiKey:secret,timeoutMs:100,fetchImpl:async()=>{
    calls++
    const page=pages?.[calls-1] || {ids:['1'],next:null}
    return Response.json({entries:[
      ...page.ids.map(id=>({content:{itemContent:{tweet_results:{result:{rest_id:id,legacy:{full_text:secret}}}}}})),
      ...(page.next?[{content:{cursorType:'Bottom',value:page.next}}]:[]),
    ]})
  }})
  const logs=[]
  const gateway=new ExternalPlatformGateway({usageStore:usage,platformStore:store,adapter,config,providerKey:'rapidapi',
    apiKeyPepper:pepper,operationControlStore:controls,reservationLeaseMs:120000,
    logger:{warn:(record,message)=>{logs.push({record,message});if(loggerThrows) throw new Error(secret)},error(){}}})
  const failure=Object.assign(new TypeError(secret),{code:malicious?secret:'55P03',detail:secret,query:secret,parameters:[secret]})
  if(malicious) failure.name=secret
  if(method) store[method]=async()=>{throw wrapped?Object.assign(new Error(secret),{code:'external_platform_call_persistence_unknown',cause:failure}):failure}
  const body={platform:'twitter',query:secret,pageSize,type:'stable'}
  const invoke=({cursor,idempotencyKey='same-offline-failure-key'}={})=>gateway.searchRaw(context,{
    body:{...body,...(cursor?{cursor}:{})},normalized:{platform:'twitter',query:secret,pageSize,...(cursor?{cursor}:{})},
    idempotencyKey,dataSearch:{resultType:'stable',replayWindowMs:null}})
  return {usage,store,logs,invoke,calls:()=>calls}
}

for(const [method,phase] of [['stageProviderEvidence','stage_evidence'],['finishProviderStep','finish_step'],['commitTwitterFillDelivery','commit_delivery']]) {
  test(`Twitter ${phase} failure logs metadata once while preserving unknown, hold and no automatic retry`,async()=>{
    const f=await fixture({method,wrapped:method==='stageProviderEvidence'})
    await assert.rejects(f.invoke(),{code:'request_outcome_unknown'})
    const saved=[...f.usage.requests.values()][0]
    assert.equal(saved.status,'unknown');assert.equal(saved.errorCode,'external_platform_persistence_unknown')
    assert.equal(f.usage.customerCharges.get(saved.id).status,'unknown')
    assert.equal(f.calls(),1);assert.equal(f.logs.length,1)
    assert.equal(f.logs[0].record.event,'twitter_search_outcome_unknown')
    assert.equal(f.logs[0].record.phase,phase);assert.equal(f.logs[0].record.sqlState,'55P03')
    assert.equal(f.logs[0].record.requestId,saved.id)
    assert.deepEqual(Object.keys(f.logs[0].record).sort(),['callId','errorClass','event','phase','requestId','sqlState'])
    assert.doesNotMatch(JSON.stringify(f.logs),new RegExp(secret,'u'))
    const held=structuredClone(f.usage.customerCharges.get(saved.id))
    await assert.rejects(f.invoke(),{code:'request_outcome_unknown'})
    assert.equal(f.calls(),1);assert.equal(f.logs.length,1)
    assert.deepEqual(f.usage.customerCharges.get(saved.id),held)
  })
}

test('unrecognized exception properties and a throwing logger cannot change the unknown settlement',async()=>{
  const f=await fixture({method:'finishProviderStep',malicious:true,loggerThrows:true})
  await assert.rejects(f.invoke(),{code:'request_outcome_unknown'})
  const saved=[...f.usage.requests.values()][0]
  assert.equal(saved.status,'unknown');assert.equal(f.usage.customerCharges.get(saved.id).status,'unknown')
  assert.equal(f.logs[0].record.errorClass,'Error');assert.equal(f.logs[0].record.sqlState,null)
  assert.equal(f.calls(),1);assert.doesNotMatch(JSON.stringify(f.logs),new RegExp(secret,'u'))
})

test('successful Twitter delivery emits no new failure log and captures once',async()=>{
  const f=await fixture(), result=await f.invoke()
  assert.equal(result.status,200);assert.equal(f.calls(),1);assert.equal(f.logs.length,0)
  assert.equal(f.usage.customerCharges.get(result.requestId).status,'captured')
  const replay=await f.invoke()
  assert.equal(replay.requestId,result.requestId);assert.equal(f.calls(),1);assert.equal(f.logs.length,0)
})

for(const outcome of ['busy','error']) {
  test(`Twitter ${outcome} cost cleanup delivers purchased partial content without another paid page and keeps continuation`,async()=>{
    const f=await fixture({pageSize:2,pages:[{ids:['1'],next:'private-bottom-token'},{ids:['2'],next:null}]})
    const release=f.store.releaseProviderCostWorkflow.bind(f.store), cleanup=[]
    f.store.releaseProviderCostWorkflow=async input=>{
      cleanup.push(input)
      if(outcome==='error') throw Object.assign(new Error(secret),{code:'55P03'})
      return false
    }
    const result=await f.invoke(), data=result.body.data
    assert.equal(f.calls(),1,'cleanup may not re-enter blocking acquisition admission')
    assert.equal(cleanup.length,1);assert.equal(cleanup[0].bestEffortRelease,true)
    assert.deepEqual(data.items.map(row=>row.id),['1'])
    assert.equal(data.status,'partial');assert.ok(data.warnings.some(row=>row.code==='TWITTER_PAGE_FILL_STOPPED'))
    assert.equal(data.pageInfo.hasMore,true);assert.match(data.pageInfo.nextCursor,/^mxds1\./u)
    assert.equal(f.usage.requests.get(result.requestId).status,'committed')
    assert.equal(f.usage.customerCharges.get(result.requestId).status,'captured')
    assert.equal([...f.store.costReservations.values()].filter(row=>row.usageRequestId===result.requestId)[0].status,'active',
      'unconfirmed release must remain conservative; no ledger mutation')
    assert.equal(f.logs.length,0,'nonfatal cleanup does not pretend the delivered outcome is unknown')
    f.store.releaseProviderCostWorkflow=release
    const next=await f.invoke({cursor:data.pageInfo.nextCursor,idempotencyKey:'explicit-next-page-key'})
    assert.deepEqual(next.body.data.items.map(row=>row.id),['2']);assert.equal(f.calls(),2)
  })
}

test('successful cost cleanup keeps the existing multi-page fill and one customer settlement',async()=>{
  const f=await fixture({pageSize:2,pages:[{ids:['1'],next:'private-bottom-token'},{ids:['2'],next:null}]})
  const result=await f.invoke()
  assert.equal(f.calls(),2);assert.deepEqual(result.body.data.items.map(row=>row.id),['1','2'])
  assert.equal(result.body.data.warnings.some(row=>row.code==='TWITTER_PAGE_FILL_STOPPED'),false)
  assert.equal(f.usage.customerCharges.size,1);assert.equal(f.usage.customerCharges.get(result.requestId).status,'captured')
  assert.ok([...f.store.costReservations.values()].every(row=>row.status==='released'))
})

for(const page of [{ids:['1'],next:'private-next'},{ids:['1','2'],next:'private-next'},{ids:['1'],next:null}]) {
  test(`failed cleanup does not degrade a ${page.ids.length>1?'buffered':'complete'} page`,async()=>{
    const f=await fixture({pageSize:1,pages:[page]})
    f.store.releaseProviderCostWorkflow=async()=>false
    const result=await f.invoke()
    assert.equal(result.body.data.warnings.some(row=>row.code==='TWITTER_PAGE_FILL_STOPPED'),false)
    assert.equal(f.calls(),1);assert.equal(f.usage.customerCharges.get(result.requestId).status,'captured')
  })
}
