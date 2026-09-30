import { WEB_SEARCH_PROVIDERS, WEB_SEARCH_PATH, WEB_SEARCH_VERSION, searchProviderKeys, webSearchProvider } from '../../shared/web-search.mjs'
import { normalizeWebSearch, providerSupports } from './contract.mjs'
import { AppError, assert } from '../core/errors.mjs'
import { requestFingerprint } from '../core/crypto.mjs'
import { WebSearchAdapter } from '../adapters/web-search.mjs'
import { ExternalPlatformGateway } from '../external-platforms/gateway.mjs'
import { ExternalPlatformAdminService } from '../external-platforms/admin.mjs'
import { createExternalPlatformStore } from '../external-platforms/store.mjs'
import { StructuredExternalPlatformCredentialStore } from '../external-platforms/structured-credentials.mjs'
import { ExternalPlatformProxyStore, createWebSearchProxyFetch } from '../external-platforms/proxy.mjs'
import { rapidApiConfig } from '../external-platforms/rapidapi-config.mjs'

export class WebSearchRouteStore {
  constructor(pool=null) {this.pool=pool;this.routes=new Map()}
  async read(apiKeyId,key) {
    if(!this.pool)return this.routes.get(`${apiKeyId}:${key}`) || null
    const {rows}=await this.pool.query('SELECT fingerprint, provider_key AS provider, route_order AS "order" FROM control.web_search_request_routes WHERE api_key_id=$1 AND idempotency_key=$2',[apiKeyId,key]);return rows[0] || null
  }
  async claim(apiKeyId,key,route) {
    if(!this.pool){const id=`${apiKeyId}:${key}`;if(!this.routes.has(id))this.routes.set(id,structuredClone(route));return this.routes.get(id)}
    await this.pool.query('INSERT INTO control.web_search_request_routes(api_key_id,idempotency_key,fingerprint,provider_key,route_order) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[apiKeyId,key,route.fingerprint,route.provider,route.order])
    return this.read(apiKeyId,key)
  }
}
export class WebSearchService {
  constructor({store,gateways,routeStore}){Object.assign(this,{store,gateways,routeStore})}
  async operationReadiness(consumerId) {
    if (!consumerId) return {}
    const capabilities = await this.store.listCapabilityGrants(consumerId)
    if (!capabilities.includes('web.search')) return {}
    const entries = await Promise.all(searchProviderKeys(capabilities).map(async key => {
      const gateway = this.gateways.get(key)
      try {
        // Admin health screens only need metadata, never decrypted keys.
        const metadata = await gateway.credentialStore?.describeCredential(key)
        const states = await gateway.nativeReadiness({consumerId,operationKeys:['web.search'],...(metadata?{credentialConfigured:metadata.credentialConfigured}:{})})
        return [webSearchProvider(key).capability,{ready:states['web.search']===true}]
      } catch { return [webSearchProvider(key).capability,{ready:false}] }
    }))
    return {...Object.fromEntries(entries),'web.search':{ready:entries.some(([,state])=>state.ready)}}
  }
  async capabilities(context) {
    const [platforms,capabilities,tenant]=await Promise.all([this.store.listEffectiveGrants(context.consumer.id,context.apiKey.id),this.store.listEffectiveCapabilityGrants(context.consumer.id,context.apiKey.id),this.store.getTenantServiceAccess(context.tenant.id)])
    const keys=context.apiKey.scopeMode==='snapshot'&&platforms.includes('web_search')&&capabilities.includes('web.search')?searchProviderKeys(capabilities):[]
    const currentKey=(await this.store.listApiKeys(context.consumer.id)).find(row=>row.id===context.apiKey.id)
    const explicit=currentKey?.webSearchOrder?.length?currentKey.webSearchOrder:tenant.webSearchOrder || []
    const order=[...new Set([...explicit,...keys])].filter(key=>keys.includes(key))
    const providers=await Promise.all(order.map(async key=>{
      const p=webSearchProvider(key), gateway=this.gateways.get(key)
      const ready=await gateway?.nativeReadiness({consumerId:context.consumer.id,operationKeys:['web.search']}).catch(()=>({}))
      return {key,label:p.label,resources:p.resources,maxResults:p.maxResults,ready:ready?.['web.search']===true}
    }))
    return {contractVersion:WEB_SEARCH_VERSION,order,providers,defaultAccess:'explicit',selection:'pre_dispatch_only'}
  }
  async search(context,{body,idempotencyKey,baiduCompatible=false}) {
    assert(typeof idempotencyKey==='string'&&/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey),400,'idempotency_key_required','Provide an Idempotency-Key with 8–128 safe characters')
    const request=normalizeWebSearch(body,{baiduCompatible})
    const fingerprint=requestFingerprint({method:'POST',path:WEB_SEARCH_PATH,body:request})
    const visible=await this.capabilities(context)
    assert(visible.providers.length>0,403,'web_search_not_granted','Web Search suppliers have not been opened for this Key')
    if(request.provider){
      assert(visible.order.includes(request.provider),403,'web_search_provider_not_granted','Supplier is not granted for this Key')
      assert(providerSupports(webSearchProvider(request.provider),request),400,'web_search_options_unsupported','Selected supplier does not support these options')
    }
    let route=await this.routeStore.read(context.apiKey.id,idempotencyKey)
    if(!route){
      const candidates=request.provider?[request.provider]:visible.order
      const selected=candidates.find(key=>visible.providers.find(p=>p.key===key)?.ready&&providerSupports(webSearchProvider(key),request))
      if(!selected)throw new AppError(503,'web_search_no_ready_provider','No authorized supplier is ready for the requested options')
      route=await this.routeStore.claim(context.apiKey.id,idempotencyKey,{fingerprint,provider:selected,order:candidates})
    }
    assert(route.fingerprint===fingerprint,409,'idempotency_conflict','Idempotency-Key was used for a different search')
    assert(visible.order.includes(route.provider),403,'web_search_provider_not_granted','Saved search supplier is no longer granted')
    // The durable choice survives order, credential and rollout changes. Only
    // the chosen gateway may replay/dispatch this intent, even after timeout.
    return this.gateways.get(route.provider).webSearch(context,{request,provider:webSearchProvider(route.provider),body,idempotencyKey,path:WEB_SEARCH_PATH})
  }
}
class SearchAdminService extends ExternalPlatformAdminService {
  async revealCredential(provider) {
    const credentials=await this.credentialStore.readCredential(provider)
    if(!credentials)throw new AppError(409,'external_platform_credential_not_revealable','No saved supplier key')
    return {credentials}
  }
  async detail(provider,range) {
    const detail=await super.detail(provider,range)
    detail.pipeline[0].description='Web Search 业务能力、供应商范围与 Key 快照共同授权。'
    detail.pipeline[3].description='完整上游响应受限归档；交付保存为请求快照，不自动抓取全文或写入 Canonical。'
    return detail
  }
}
export function createWebSearchRuntime({pool,store,controls,config}) {
  const gateways=new Map(),admins=[]
  for(const provider of WEB_SEARCH_PROVIDERS){
    const credentialStore=new StructuredExternalPlatformCredentialStore({pool,providerKey:provider.key,fields:[{name:'apiKey',label:'API Key'}],pepper:config.apiKeyPepper})
    const platformStore=createExternalPlatformStore({pool,usageStore:store,providerKey:provider.key,authorizationPlatform:'web_search'})
    const proxyStore=pool?new ExternalPlatformProxyStore(pool,config.deploymentEgress,{providerKey:provider.key}):null
    const providerConfig={...rapidApiConfig(),freshTtlMs:0}
    const adapter=pool&&config.listenerMode!=='admin'?new WebSearchAdapter({fetchImpl:createWebSearchProxyFetch(proxyStore,provider.key)}):null
    gateways.set(provider.key,new ExternalPlatformGateway({usageStore:store,platformStore,adapter,config:providerConfig,providerKey:provider.key,credentialStore,operationControlStore:controls,apiKeyPepper:config.apiKeyPepper,reservationLeaseMs:Math.max(60000,config.reservationLeaseMs)}))
    admins.push(new SearchAdminService({store:platformStore,config:providerConfig,credentialStore,operationControlStore:controls,proxyStore,durable:!!pool,providerKey:provider.key,
      metadata:{key:provider.key,displayName:provider.label,description:'Hub 直连 Web Search 供应商；租户与 Key 独立授权和排序。',capabilities:['web.search'],capabilityMatrix:[],marketplaces:[{key:'web_search',label:'Web Search'}],adapterLabel:`${provider.label} HTTP`,adapterDescription:'单次请求，不自动重试、不转发 Night-All。',billingNote:'按审核采购价预留预算；供应商实际扣费保持未知。',freshnessNote:'每次新幂等标识获取一批结果；相同标识回放原交付。'}}))
  }
  return {service:new WebSearchService({store,gateways,routeStore:new WebSearchRouteStore(pool)}),admins,gateways}
}
