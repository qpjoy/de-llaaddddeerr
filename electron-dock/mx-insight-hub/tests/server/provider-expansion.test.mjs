import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import official from '../../server/data/provider-official-contracts.json' with { type:'json' }
import prices from '../../server/data/tikhub-reference-prices.json' with { type:'json' }
import { NATIVE_FORWARDING_ENDPOINTS as endpoints, nativeForwardingEndpoint, normalizeNativeForwardingRequest } from '../../server/contracts/native-forwarding.mjs'
import { nativeDocPath } from '../../server/contracts/native-forwarding-docs.mjs'
import { publicDocsHtmlForPath, tenantOpenApiDocument } from '../../server/public-docs.mjs'
import { enterpriseDocumentationHtml } from '../../server/contracts/enterprise-docs.mjs'
import { officialProviderCatalog, providerCatalogKeys } from '../../server/data/provider-catalog.mjs'
import { officialPriceDraft, PROVISIONING_OPERATIONS } from '../../server/commercial/catalog.mjs'
import { normalizePriceDraft } from '../../server/commercial/price-drafts.mjs'
import { customerServiceQuote, servicePriceDefinition } from '../../server/contracts/service-pricing.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { createApp } from '../../server/app.mjs'
import { TikHubAdapter } from '../../server/adapters/tikhub.mjs'
import { JustOneAdapter } from '../../server/adapters/justone.mjs'
import { productAllowed, PRODUCT_ACCESS } from '../../shared/product-access.mjs'

const T='t.api_5ac0f5ab2a7b1f98', J='j.api_94ac939c44fe1d61'
test('official snapshot has reproducible sources; every added dispatch is a fixed bounded read contract',()=>{
  assert.equal(official.collection.justonePages,293)
  assert.deepEqual(official.collection.justoneErrors,[])
  assert.ok(official.sources.every(row=>/^[a-f0-9]{64}$/.test(row.sha256)))
  assert.equal(official.endpoints.length,1343)
  assert.equal(endpoints.filter(row=>row.schemaVersion).length,987)
  assert.equal(endpoints.filter(row=>!row.schemaVersion).length,50)
  assert.equal(new Set(endpoints.map(row=>row.hubPath)).size,endpoints.length)
  for (const platform of ['taobao','jd','xianyu','douyin-ec','xiaohongshu-ec','1688','aliexpress','shopee','tiktok-shop','amazon']) {
    const rows=endpoints.filter(row=>row.provider==='justone'&&row.platform===platform)
    assert.ok(rows.length>0,platform)
    assert.ok(rows.every(row=>row.authorizationPlatform==='ecommerce'),platform)
  }
  const sql=readFileSync(new URL('../../migrations/114_official_provider_contracts.sql',import.meta.url),'utf8')
  for(const row of endpoints.filter(row=>row.schemaVersion)) {
    assert.equal(row.method,'GET');assert.ok(row.path.startsWith('/api/'))
    assert.ok(!row.parameters.some(p=>/^(token|cookie|authorization|api_key|password)$/i.test(p.name)))
    assert.ok(sql.includes(row.operation));assert.ok(PROVISIONING_OPERATIONS.some(op=>op.operation===row.operation))
  }
  assert.match(sql,/'disabled'/);assert.doesNotMatch(sql,/INSERT INTO (?:control\.)?(?:api_keys|capability_grants|platform_grants)/i)
})

test('new typed contracts enforce enum/type/bounds/defaults and never silently coerce explicit null',()=>{
  const key='t.api_b67133dea0ce0e42'
  assert.deepEqual(normalizeNativeForwardingRequest(key,{params:{}}).upstreamQuery,{app_name:'aweme',type:0})
  for(const params of [{type:'1'},{type:2},{type:null},{app_name:'other'},{secret:'bad'}]) assert.throws(()=>normalizeNativeForwardingRequest(key,{params}),{status:400})
  assert.equal(normalizeNativeForwardingRequest(key,{params:{app_name:'toutiao',type:1}}).upstreamQuery.type,1)
})

test('new contracts on both providers preserve exact data with one dispatch and server-only credentials',async()=>{
  for(const [key,Adapter,code] of [[T,TikHubAdapter,200],[J,JustOneAdapter,0]]){
    let calls=0
    const data={items:[{id:'fixture',unknown:[0,null,false]}],cursor:'opaque+cursor=='}
    const adapter=new Adapter({apiKey:'fixture-secret',token:'fixture-secret',fetchImpl:async(url,options)=>{
      calls++;assert.equal(new URL(url).pathname,nativeForwardingEndpoint(key).path)
      assert.equal(options.method,'GET');assert.equal(options.body,undefined)
      assert.equal(new URL(url).searchParams.get('itemId'),'fixture-id')
      return Response.json({code,message:'ok',recordTime:'2026-09-27',data})
    }})
    const result=await adapter.forwardNative(key,{params:{itemId:'fixture-id'}})
    assert.equal(calls,1);assert.deepEqual(result.publicBody.data,data)
    assert.doesNotMatch(JSON.stringify(result.publicBody),/fixture-secret|tikhub|justone/i)
  }
})

test('per-interface docs and OpenAPI use the same exact grants; customer docs contain Hub pricing only',()=>{
  const endpoint=nativeForwardingEndpoint(T), scopes=[{platforms:['social'],capabilities:[endpoint.operation]}]
  const doc=tenantOpenApiDocument(scopes)
  assert.deepEqual(Object.keys(doc.paths).filter(p=>p.startsWith('/data/native/')),[endpoint.hubPath.slice(7)])
  const html=publicDocsHtmlForPath(nativeDocPath(endpoint),{tenant:true,scopes})
  assert.match(html,/Hub 官方定价/);assert.match(html,/params 字段/);assert.match(html,/endpoint=t.api_5ac0f5ab2a7b1f98/)
  assert.doesNotMatch(html,/tikhub|justone|procurement|采购价|api\.tikhub/i)
  assert.equal(publicDocsHtmlForPath(nativeDocPath(nativeForwardingEndpoint(J)),{tenant:true,scopes}),null)
  for(const options of [{tenant:true},{tenant:false},{tenant:true,procurementEvidence:true}]){
    const enterprise=enterpriseDocumentationHtml('enterprise-1.31',options)
    assert.match(enterprise,/Hub 官方定价/);assert.doesNotMatch(enterprise,/启信官方文档|官网参考价|open\.qixin|api\.qixin|Admin 采购参考/)
  }
  assert.match(enterpriseDocumentationHtml('enterprise-1.31',{procurementEvidence:true}),/Admin 采购参考/)
  for (const [platform,path] of [['social','/data-products/social-content'],['ecommerce','/data-products/ecommerce-treasure-box']]) {
    assert.deepEqual(PRODUCT_ACCESS[path].any.filter(value=>value.startsWith('native.')),endpoints.filter(row=>row.authorizationPlatform===platform).map(row=>row.operation))
  }
  const both=['social','ecommerce']
  assert.equal(productAllowed('/data-products/social-content',[{platforms:both,capabilities:[nativeForwardingEndpoint(J).operation]}]),false)
  assert.equal(productAllowed('/data-products/ecommerce-treasure-box',[{platforms:both,capabilities:[nativeForwardingEndpoint(T).operation]}]),false)
})

test('account price snapshot preserves decimals and incompleteness; it never synthesizes missing JustOne prices',()=>{
  assert.equal(prices.complete,false);assert.equal(prices.collection.capturedPaths,1360)
  assert.equal(prices.rows.length,972)
  assert.ok(new Set(prices.rows.map(r=>r.unitPrice)).size>5)
  const {available,...spec}=officialPriceDraft('tikhub')
  assert.equal(available,true)
  const draft=normalizePriceDraft(spec)
  assert.equal(draft.rates.length,710)
  const subcent=draft.rates.find(row=>row.unitPrice==='0.001')
  assert.equal(subcent.amountMicros,'1000');assert.equal(subcent.budgetMinor,1);assert.equal(subcent.rounded,true)
  assert.equal(officialPriceDraft('justone').available,false)
})

test('catalog distinguishes declared coverage, fixed contracts, runtime state and Admin price evidence',()=>{
  const catalog=officialProviderCatalog([])
  assert.equal(catalog.rows.length,1343);assert.ok(catalog.rows.every(row=>row.effectiveState==='not_checked'))
  assert.deepEqual(providerCatalogKeys('lemon8'),['source-platform-lemon8'])
  assert.ok(catalog.rows.some(row=>row.procurementReference?.unitPrice==='0.0010'))
  assert.ok(catalog.rows.some(row=>row.implementation==='documented_only'&&row.hubPath===null))
})

test('Hub published, explicit zero, fallback and account discount quotes follow actual billing semantics',()=>{
  const path=nativeForwardingEndpoint(T).hubPath, def=servicePriceDefinition(path)
  const plan={versionId:'v1',priceBook:{currency:'CNY',defaultMultiplierPpm:1_000_000,entries:[{meterKey:def.meterKey,unitPriceMinor:10}]}}
  const profile={mode:'enforced',multiplierPpm:800000,defaultUnitPriceMinor:5,defaultCurrency:'CNY'}
  const quote=customerServiceQuote(path,def,plan,profile)
  assert.equal(quote.hubPrice.unitPriceMinor,10);assert.equal(quote.accountPrice.unitPriceMinor,8)
  plan.priceBook.entries[0].unitPriceMinor=0
  assert.equal(customerServiceQuote(path,def,plan,profile).accountPrice.unitPriceMinor,0)
  plan.priceBook.entries=[]
  const fallback=customerServiceQuote(path,def,plan,profile)
  assert.equal(fallback.hubPrice.published,false);assert.equal(fallback.hubPrice.unitPriceMinor,null)
  assert.equal(fallback.accountPrice.unitPriceMinor,5);assert.equal(fallback.accountPrice.multiplierPpm,null)
  assert.equal(customerServiceQuote(path,def,plan,{...profile,mode:'disabled'}).accountPrice.unitPriceMinor,0)
})

test('non-Admin price reads enforce Key and consumer intersection and perform no acquisition or billing',async t=>{
  const store=new MemoryStore(),service=new HubService({store,adapter:{},apiKeyPepper:'fixture-provider-pricing-long-enough-pepper'})
  const tenant=await service.createTenant({name:'price fixture'}), consumer=await service.createConsumer({tenantId:tenant.id,name:'caller'})
  const endpoint=nativeForwardingEndpoint(T)
  await service.putPlatformConfiguration('social',{tenantId:tenant.id,consumerId:consumer.id,enabled:true})
  await service.putCapabilityConfiguration(endpoint.operation,{tenantId:tenant.id,consumerId:consumer.id,enabled:true})
  const key=await service.createApiKey({consumerId:consumer.id,name:'key',platforms:['social'],capabilities:[endpoint.operation]})
  const zero=await service.createApiKey({consumerId:consumer.id,name:'narrow',platforms:['social'],capabilities:[]})
  const server=createServer(createApp({service,store,adminToken:'fixture-admin'}))
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close())
  const url=`http://127.0.0.1:${server.address().port}/api/v1/data/services/pricing?path=${encodeURIComponent(endpoint.hubPath)}`
  const before=JSON.stringify([store.usageRequests,store.customerCharges,store.creditLedgerEntries])
  assert.equal((await fetch(url)).status,401)
  assert.equal((await fetch(url,{headers:{authorization:`Bearer ${zero.secret}`}})).status,403)
  const result=await fetch(url,{headers:{authorization:`Bearer ${key.secret}`}})
  assert.equal(result.status,200);assert.match(result.headers.get('cache-control'),/no-store/)
  const body=await result.json();assert.equal(body.data.hubPrice.label,'Hub 官方定价');assert.equal(body.data.dispatches,0)
  assert.doesNotMatch(JSON.stringify(body),/tikhub|justone|procurement|sourceUrl/i)
  assert.equal((await fetch(url+'&path=x',{headers:{authorization:`Bearer ${key.secret}`}})).status,400)
  await service.putCapabilityConfiguration(endpoint.operation,{tenantId:tenant.id,consumerId:consumer.id,enabled:false})
  assert.equal((await fetch(url,{headers:{authorization:`Bearer ${key.secret}`}})).status,403)
  assert.equal(JSON.stringify([store.usageRequests,store.customerCharges,store.creditLedgerEntries]),before)
})
