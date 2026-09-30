import assert from 'node:assert/strict'
import test from 'node:test'
import { WEB_SEARCH_PROVIDERS, webSearchProvider } from '../../shared/web-search.mjs'
import { normalizeWebSearch, gatewayWebSearchRequest, normalizeSearchResponse, buildSearchHttp } from '../../server/web-search/contract.mjs'
import { WebSearchAdapter } from '../../server/adapters/web-search.mjs'
import { WebSearchService, WebSearchRouteStore } from '../../server/web-search/runtime.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { rapidApiConfig } from '../../server/external-platforms/rapidapi-config.mjs'
import { tenantOpenApiDocument } from '../../server/public-docs.mjs'
import { productAllowed } from '../../shared/product-access.mjs'
const PEPPER='web-search-synthetic-test-pepper-never-live', SECRET='synthetic-supplier-key'
const rows=[{title:'Example',url:'https://example.com/',content:'Search snippet'}]
const response=(key,items=rows)=>key==='baidu'?{references:items}:key==='serper'?{organic:items}:key==='you'?{results:{web:items}}:['searchapi','serpapi'].includes(key)?{organic_results:items}:key==='firecrawl'?{success:true,data:{web:items}}:{results:items}
async function harness({providers=['baidu','tavily'],outcome='success',enabled=true}={}){
 const store=new MemoryStore(),service=new HubService({store,apiKeyPepper:PEPPER,adapter:{search(){throw Error('Night-All must never run')}}})
 const tenant=await service.createTenant({name:'Web fixture'}),consumer=await service.createConsumer({tenantId:tenant.id,name:'Web caller'})
 await store.setPlatformGrant(consumer.id,'web_search',true)
 for(const scope of ['web.search',...providers.map(p=>webSearchProvider(p).capability)])await service.putCapabilityConfiguration(scope,{tenantId:tenant.id,consumerId:consumer.id,enabled:true})
 const key=await service.createApiKey({consumerId:consumer.id,name:'Search Key',platforms:['web_search'],capabilities:['web.search',...providers.map(p=>webSearchProvider(p).capability)],webSearchOrder:providers})
 const context=await service.authenticate(key.secret),controls=new MemoryExternalPlatformControlStore(),gateways=new Map(),calls=[]
 const config={...rapidApiConfig(),configured:true}
 for(const provider of WEB_SEARCH_PROVIDERS){
  if(enabled)await controls.updatePolicy(provider.key,'web.search',{expectedRevision:1,desiredState:'active',reason:'Synthetic test',priceBook:{currency:'USD',pricingAsOf:'2026-09-30T00:00:00Z',monthlyBudgetMinor:100000,monthlySubsidyBudgetMinor:100000,unitCostMinorByEndpoint:{[provider.endpointKey]:1}}},{runtime:{config,credentialConfigured:true}})
  const adapter=new WebSearchAdapter({apiKey:SECRET,fetchImpl:async()=>{calls.push(provider.key);if(outcome==='unknown')throw Error('connection lost');if(outcome==='rejected')return Response.json({error:'bad query'},{status:400});return Response.json(response(provider.key,outcome==='empty'?[]:rows))}})
  gateways.set(provider.key,new ExternalPlatformGateway({usageStore:store,platformStore:new MemoryExternalPlatformStore({usageStore:store,providerKey:provider.key,authorizationPlatform:'web_search'}),adapter,config,providerKey:provider.key,apiKeyPepper:PEPPER,operationControlStore:controls,reservationLeaseMs:150000,logger:console}))
 }
 const search=new WebSearchService({store,gateways,routeStore:new WebSearchRouteStore()})
 return {store,service,context,consumer,tenant,key,search,calls,controls,config}
}
test('Baidu supplied shape normalizes empty filters and noTimeLimit; invalid/hidden parameters fail',()=>{
 const r=normalizeWebSearch({messages:[{role:'user',content:'AI'}],resource_type_filter:[{type:'web',top_k:50},{type:'image',top_k:30},{type:'video',top_k:10}],edition:'standard',search_filter:{match:{site:[]},range:{page_time:{gte:'',lte:''}}},search_recency_filter:'noTimeLimit'},{baiduCompatible:true})
 assert.throws(()=>normalizeWebSearch({messages:[{role:'user',content:'AI'}],resource_type_filter:'invalid'},{baiduCompatible:true}),{status:400})
 assert.equal(r.provider,'baidu');const wire=JSON.parse(buildSearchHttp(webSearchProvider('baidu'),r,SECRET).options.body);assert.equal(wire.search_recency_filter,undefined);assert.equal(wire.search_filter,undefined)
 for(const body of [{query:''},{query:'x',url:'https://bad.invalid'},{query:'x',from:'2026-02-30',to:'2026-03-01'},{query:'x',resources:[{type:'web',limit:0}]},{query:'x',sites:['127.0.0.1']}])assert.throws(()=>normalizeWebSearch(body),{status:400})
})
test('all eight direct adapters issue one request and preserve restricted evidence without extracting full text',async()=>{
 for(const provider of WEB_SEARCH_PROVIDERS){let calls=0
  const adapter=new WebSearchAdapter({apiKey:SECRET,fetchImpl:async(url,options)=>{calls++;assert.equal(options.redirect,'error');assert.doesNotMatch(options.body||'',/scrapeOptions|"contents"|extraction/);return Response.json(response(provider.key))}})
  const out=await adapter.execute(gatewayWebSearchRequest(normalizeWebSearch({query:'AI'}),provider,100));assert.equal(calls,1);assert.equal(out.publicBody.data.items.length,1);assert.equal(out.publicBody.meta.fullText,false);assert(out.restrictedResponseArchive.bodyBytes.length>0);assert(!JSON.stringify(out).includes(SECRET))
 }
})
test('empty recognized rows succeed; unknown shape, unsafe URL and business errors do not become empty success',()=>{
 const p=webSearchProvider('baidu'),q=normalizeWebSearch({query:'AI'})
 assert.equal(normalizeSearchResponse({references:[]},p,q,new Date().toISOString()).meta.empty,true)
 for(const raw of [{},{references:[],error_code:1},{references:[{url:'javascript:alert(1)'}]}])assert.throws(()=>normalizeSearchResponse(raw,p,q))
})
test('personalized scope, saved ordering, immutable replay and fixed Baidu alias dedup',async()=>{
 const h=await harness();const input={body:{query:'AI'},idempotencyKey:'web-search-fixture'}
 assert.deepEqual((await h.search.capabilities(h.context)).order,['baidu','tavily'])
 assert.equal((await h.search.operationReadiness(h.consumer.id))['web.search.provider.baidu'].ready,true)
 const first=await h.search.search(h.context,input);assert.equal(first.status,200);assert.equal(first.body.data.provider,'baidu')
 const saved=h.store.apiKeys.get(h.key.id);saved.webSearchOrder=['tavily','baidu']
 assert.deepEqual((await h.search.search(h.context,input)).body,first.body);assert.deepEqual(h.calls,['baidu'])
 await assert.rejects(h.search.search(h.context,{...input,body:{query:'different'}}),{code:'idempotency_conflict'})
 const explicit={body:{query:'alias',provider:'baidu'},idempotencyKey:'web-search-baidu-alias'}
 const original=await h.search.search(h.context,explicit)
 const alias=await h.search.search(h.context,{body:{messages:[{role:'user',content:'alias'}]},idempotencyKey:explicit.idempotencyKey,baiduCompatible:true})
 assert.deepEqual(alias.body,original.body);assert.deepEqual(h.calls,['baidu','baidu'])
 await h.service.putCapabilityConfiguration('web.search.provider.baidu',{tenantId:h.tenant.id,consumerId:h.consumer.id,enabled:false})
 await assert.rejects(h.search.search(h.context,input),{code:'web_search_provider_not_granted'})
})
test('empty, rejected and unknown responses never advance to the next supplier',async()=>{
 for(const outcome of ['empty','rejected','unknown']){const h=await harness({outcome});const input={body:{query:'AI'},idempotencyKey:`web-search-${outcome}`}
  if(outcome==='empty'){assert.equal((await h.search.search(h.context,input)).body.data.items.length,0);await h.search.search(h.context,input)}
  else {await assert.rejects(h.search.search(h.context,input));await assert.rejects(h.search.search(h.context,input))}
  assert.deepEqual(h.calls,['baidu'])
 }
})
test('disabled suppliers make no request; unauthorized supplier and test keys cannot dispatch',async()=>{
 const disabled=await harness({enabled:false});await assert.rejects(disabled.search.search(disabled.context,{body:{query:'AI'},idempotencyKey:'web-disabled-test'}),{code:'web_search_no_ready_provider'});assert.equal(disabled.calls.length,0)
 const h=await harness({providers:['baidu']});await assert.rejects(h.search.search(h.context,{body:{query:'AI',provider:'tavily'},idempotencyKey:'web-denied-test'}),{status:403});assert.equal(h.calls.length,0)
 const key=await h.service.createApiKey({consumerId:h.consumer.id,name:'Empty'}),ctx=await h.service.authenticate(key.secret);assert.deepEqual((await h.search.capabilities(ctx)).providers,[])
 const testKey=await h.service.createApiKey({consumerId:h.consumer.id,name:'Test',environment:'test',platforms:['web_search'],capabilities:['web.search','web.search.provider.baidu']});const testCtx=await h.service.authenticate(testKey.secret)
 await assert.rejects(h.search.search(testCtx,{body:{query:'AI'},idempotencyKey:'web-test-key-denied'}),{status:403});assert.equal(h.calls.length,0)
})
test('tenant grants do not expand existing keys; order edits compare-and-swap atomically',async()=>{
 const h=await harness({providers:['baidu']});await h.service.putCapabilityConfiguration('web.search.provider.tavily',{tenantId:h.tenant.id,consumerId:h.consumer.id,enabled:true})
 assert.deepEqual((await h.search.capabilities(h.context)).order,['baidu'])
 await assert.rejects(h.service.updateApiKeyScopes(h.key.id,{platforms:[],capabilities:[],webSearchOrder:[],expected:{scopeMode:'snapshot',platforms:h.key.platforms,capabilities:h.key.capabilities,webSearchOrder:['tavily']}},'fixture'),{code:'api_key_scopes_changed'})
 assert.deepEqual((await h.store.listApiKeys(h.consumer.id))[0].platforms,['web_search'])
})
test('product navigation and tenant OpenAPI expose only authorized search channels',()=>{
 const scope={platforms:['web_search'],capabilities:['web.search','web.search.provider.tavily']}
 assert(productAllowed('/data-products/web-search',[scope]));assert(!productAllowed('/data-products/web-search',[{...scope,capabilities:['web.search']}]))
 const doc=tenantOpenApiDocument([scope]);assert(!doc.paths['/data/web-search/compatible/baidu']);assert.deepEqual(doc.paths['/data/web-search/search'].post.requestBody.content['application/json'].schema.properties.provider.enum,['tavily'])
 assert(!tenantOpenApiDocument([]).paths['/data/web-search/search'])
})

import { createServer } from 'node:http'
import { createApp } from '../../server/app.mjs'
import { createWebSearchRuntime } from '../../server/web-search/runtime.mjs'
import { MultiExternalPlatformAdminService } from '../../server/external-platforms/admin.mjs'
import { PROVISIONING_OPERATIONS } from '../../server/commercial/catalog.mjs'
test('HTTP search, alias and capabilities require Hub Key; suppliers save/reveal only after second Admin token',async()=>{
 const h=await harness(),runtime=createWebSearchRuntime({pool:null,store:h.store,controls:h.controls,config:{apiKeyPepper:PEPPER,listenerMode:'admin',reservationLeaseMs:150000}})
 const admin=new MultiExternalPlatformAdminService(runtime.admins)
 const server=createServer(createApp({service:h.service,store:h.store,adapter:{},webSearchService:h.search,externalPlatformAdmin:admin,adminToken:'fixture-admin',logger:{error(){}}}))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 try {
  const base=`http://127.0.0.1:${server.address().port}`
  const publicHeaders={authorization:`Bearer ${h.key.secret}`,'content-type':'application/json','idempotency-key':'web-http-fixture'}
  const input={method:'POST',headers:publicHeaders,body:JSON.stringify({query:'AI',provider:'baidu'})}
  assert.equal((await fetch(base+'/api/v1/data/web-search/capabilities')).status,401)
  const caps=await fetch(base+'/api/v1/data/web-search/capabilities',{headers:publicHeaders});assert.match(caps.headers.get('cache-control'),/no-store/);assert.deepEqual((await caps.json()).data.order,['baidu','tavily'])
  const first=await fetch(base+'/api/v1/data/web-search/search',input);assert.equal(first.status,200,await first.text())
  const alias=await fetch(base+'/api/v1/data/web-search/compatible/baidu',{...input,body:JSON.stringify({messages:[{role:'user',content:'AI'}]})});assert.equal(alias.status,200);assert.equal(alias.headers.get('idempotent-replay'),'true');assert.deepEqual(h.calls,['baidu'])
  assert.equal((await fetch(base+'/api/v1/data/web-search/search?url=invalid',input)).status,400)
  const credentialPath=base+'/internal/v1/admin/external-platforms/baidu/credential',headers={'x-mx-insight-admin-token':'fixture-admin','content-type':'application/json'}
  assert.equal((await fetch(credentialPath,{method:'PUT',headers:publicHeaders,body:JSON.stringify({credentials:{apiKey:SECRET},expectedRevision:0})})).status,403)
  const saved=await fetch(credentialPath,{method:'PUT',headers,body:JSON.stringify({credentials:{apiKey:SECRET},expectedRevision:0})});assert.equal(saved.status,200,await saved.text())
  const describe=await admin.detail('baidu','24h');assert(!JSON.stringify(describe).includes(SECRET));assert.equal(describe.credential.credentialConfigured,true)
  assert.equal((await fetch(credentialPath+'/reveal',{method:'POST',headers,body:JSON.stringify({adminToken:'wrong'})})).status,403)
  const reveal=await fetch(credentialPath+'/reveal',{method:'POST',headers,body:JSON.stringify({adminToken:'fixture-admin'})});assert.equal(reveal.status,200);assert.match(reveal.headers.get('cache-control'),/no-store/);assert.equal((await reveal.json()).data.credentials.apiKey,SECRET)
  assert.deepEqual(h.calls,['baidu'],'metadata and credential operations never search')
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})
test('concurrent same intent dispatches once; a new intent honors the changed Key order',async()=>{
 const h=await harness(),input={body:{query:'concurrent'},idempotencyKey:'web-concurrent-intent'}
 const replies=await Promise.allSettled([h.search.search(h.context,input),h.search.search(h.context,input)])
 assert(replies.some(r=>r.status==='fulfilled'));assert.deepEqual(h.calls,['baidu'])
 h.store.apiKeys.get(h.key.id).webSearchOrder=['tavily','baidu']
 const next=await h.search.search(h.context,{...input,idempotencyKey:'web-new-ordered-intent'})
 assert.equal(next.body.data.provider,'tavily');assert.deepEqual(h.calls,['baidu','tavily'])
})
test('bulk provisioning uses the Web Search domain and grants the explicitly chosen supplier',()=>{
 for(const p of WEB_SEARCH_PROVIDERS){const row=PROVISIONING_OPERATIONS.find(row=>row.id===`${p.key}:web.search`);assert.equal(row.platform,'web_search');assert.equal(row.capability,'web.search');assert.deepEqual(row.additionalCapabilities,[p.capability]);assert.equal(row.meterKey,'web.search')}
})
