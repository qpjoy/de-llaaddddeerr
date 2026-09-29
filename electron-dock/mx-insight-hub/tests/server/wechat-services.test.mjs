import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import snapshot from '../../server/data/wechat-contracts.json' with { type: 'json' }
import { NATIVE_FORWARDING_ENDPOINTS } from '../../server/contracts/native-forwarding.mjs'
import { nativeDocPath } from '../../server/contracts/native-forwarding-docs.mjs'
import { publicDocsHtmlForPath, tenantOpenApiDocument, PUBLIC_OPENAPI_DOCUMENT } from '../../server/public-docs.mjs'
import { productAllowed } from '../../shared/product-access.mjs'
import { productCategory } from '../../shared/product-navigation.mjs'
import { WECHAT_PRODUCTS, wechatServices } from '../../shared/wechat.mjs'
import { implementedRoutes } from '../../server/data/source-connections.mjs'
import { officialProviderCatalog } from '../../server/data/provider-catalog.mjs'
import { wechatOfficialPriceDraft } from '../../server/commercial/catalog.mjs'
import { serviceCatalogPage } from '../../server/data/service-catalog.mjs'
import { SOURCE_CATALOG_SEED } from '../../server/data/source-catalog-seed.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { TIKHUB_XIAOHONGSHU_OFFICIAL_ENDPOINTS } from '../../server/contracts/tikhub-xiaohongshu-official.mjs'

test('WeChat documentation and products follow exact same-consumer grants with no supplier metadata', () => {
  for (const product of WECHAT_PRODUCTS) {
    const services=wechatServices(product), capability=services[0].operation
    const scopes=[{platforms:['social'],capabilities:[capability]}]
    assert.equal(productAllowed(`/data-products/${product.key}`,scopes),true)
    assert.equal(productAllowed(`/data-products/${product.key}`,[{platforms:['social'],capabilities:[]},{platforms:['wechat_mp'],capabilities:[capability]}]),false)
    assert.equal(productCategory(`/data-products/${product.key}`).key,'services')
    const schema=tenantOpenApiDocument(scopes)
    assert.deepEqual(Object.keys(schema.paths).filter(path=>path.startsWith('/data/wechat/')),[services[0].hubPath.slice(7)])
    const html=publicDocsHtmlForPath(`/docs/${product.key}`,{tenant:true,scopes})
    assert.ok(html);assert.doesNotMatch(html,/TikHub|JustOne|api\.tikhub|docs\.tikhub|采购价/iu)
    for (const row of services) {
      const endpoint=NATIVE_FORWARDING_ENDPOINTS.find(item=>item.key===row.key)
      const page=publicDocsHtmlForPath(nativeDocPath(endpoint),{tenant:true,scopes})
      assert.equal(Boolean(page),row.operation===capability)
      if(page) { assert.match(page,/params 字段/);assert.doesNotMatch(page,/TikHub|JustOne|api\.tikhub|docs\.tikhub/iu) }
    }
  }
  assert.equal(productCategory('/data-products/xiaohongshu-note').key,'services')
  assert.equal(productCategory('/data-products/news').key,'applications')
})

test('WeChat catalog unifies publisher identities while separating runtime, procurement and storage', () => {
  const routes=implementedRoutes().filter(row=>row.id.startsWith('native-wechat.'))
  assert.equal(routes.length,26)
  assert.ok(routes.every(row=>row.catalogKeys.length===1 && !row.datasets.length))
  const catalog=officialProviderCatalog().rows.filter(row=>row.operation?.startsWith('native.wechat.'))
  assert.equal(catalog.length,26)
  assert.ok(catalog.every(row=>row.implementation==='fixed_contract' && row.effectiveState==='not_checked' && row.runtimeStatus==='not_checked'))
  const draft=wechatOfficialPriceDraft(), rates=draft.rates
  assert.equal(draft.sourceUrl,'https://api.tikhub.io/openapi.json')
  assert.equal(draft.observedAt,'2026-09-29')
  assert.equal(rates.filter(row=>row.unitPrice==='0.010000').length,25)
  assert.equal(rates.find(row=>row.endpointKey==='native.wechat.demo.article-sample').unitPrice,'0.000000')
  const page=serviceCatalogPage(SOURCE_CATALOG_SEED,{filters:{query:'微信公众号'},pageSize:100},'fixture-secret-long-enough')
  assert.ok(page.items.some(row=>row.products.some(product=>product.path==='/data-products/wechat-mp')))
  assert.doesNotMatch(JSON.stringify(page),/TikHub|JustOne|procurementReference/iu)
  const sql=readFileSync(new URL('../../migrations/118_wechat_services.sql',import.meta.url),'utf8')
  assert.equal(snapshot.endpoints.length,26)
  assert.ok(snapshot.endpoints.every(row=>sql.includes(`native.${row.key}`)))
  assert.match(sql,/'disabled'/);assert.doesNotMatch(sql,/UPDATE |INSERT INTO control\.(?:api_keys|capability_grants|platform_grants|plans)/)
})

test('compatibility readiness enumerates only its actual endpoints even alongside hundreds of unrelated operations', async () => {
  const endpoints=Object.values(TIKHUB_XIAOHONGSHU_OFFICIAL_ENDPOINTS)
  const operations=Object.fromEntries(endpoints.map(row=>[row.operation,{ready:true,effectiveState:'active'}]))
  const unrelated=Object.fromEntries(Array.from({length:900},(_,i)=>[`native.j.api_${i}`,{ready:false,effectiveState:'disabled'}]))
  const service=new HubService({store:new MemoryStore(),adapter:{},apiKeyPepper:'wechat-fixture-only-pepper-long-enough',
    externalPostCapabilities:async()=>({ready:false,operations}),externalPlatformCapabilities:async()=>({operations:unrelated})})
  let config=await service.getPlatformConfiguration({})
  let compat=config.availableCapabilities.find(row=>row.capability==='compat.xiaohongshu.app_v2')
  assert.equal(compat.ready,true);assert.equal(compat.endpoints.length,endpoints.length)
  assert.ok(compat.endpoints.every(row=>!row.operation.startsWith('native.')))
  operations['social.posts.search']={ready:false,effectiveState:'disabled'}
  config=await service.getPlatformConfiguration({});compat=config.availableCapabilities.find(row=>row.capability==='compat.xiaohongshu.app_v2')
  assert.equal(compat.ready,false);assert.equal(compat.endpoints.filter(row=>!row.ready).length,1)
})

test('WeChat migrated alias discovery uses exact new grants and removes historical directory routes',()=>{
  const allowed=tenantOpenApiDocument([{platforms:['social'],capabilities:['native.wechat.search.search']}])
  assert.ok(allowed.paths['/search/raw'])
  assert.equal(allowed.paths['/data/search'].post['x-mx-required-capabilities'][0], 'native.wechat.search.search')
  assert.ok(allowed.paths['/data/wechat/search/search'])
  for(const scopes of [
    [{platforms:['wechat_search'],capabilities:[]}],
    [{platforms:['social'],capabilities:['native.wechat.search.search-videos']}],
    [{platforms:['social'],capabilities:[]},{platforms:['wechat_search'],capabilities:['native.wechat.search.search']}],
  ]) {
    const paths = tenantOpenApiDocument(scopes).paths
    assert.equal(paths['/search/raw'],undefined)
    assert.equal(paths['/data/search'],undefined)
  }
  assert.ok(PUBLIC_OPENAPI_DOCUMENT.paths['/night-all/search/{operation}'].post.responses[410])
  const routes=implementedRoutes()
  assert.equal(routes.filter(row=>row.id.startsWith('wechat-search-alias-')).length,2)
  for (const platform of ['wechat_mp', 'wechat_search']) {
    assert.equal(routes.find(row => row.id === `wechat-search-${platform}`).operation, 'native.wechat.search.search')
    assert.equal(routes.find(row => row.id === `wechat-aggregate-${platform}`).path, '/api/v1/data/aggregate/search')
    assert.equal(productAllowed('/data-products/search', [{platforms:[platform], capabilities:[]}]), true)
  }
  assert.ok(!routes.some(row=>['legacy-wechat_mp-raw','legacy-wechat_search-raw'].includes(row.id)))
})
