import { searchUpstream } from './providers.mjs'
import { AppError, assert } from '../core/errors.mjs'
import { WEB_SEARCH_VERSION, webSearchProvider } from '../../shared/web-search.mjs'
const object = value => value && typeof value === 'object' && !Array.isArray(value)
function fields(value, allowed) { assert(object(value) && Object.keys(value).every(k=>allowed.includes(k)),400,'invalid_web_search_request','Unknown Web Search fields') }
export function normalizeWebSearch(body, { baiduCompatible = false } = {}) {
  if (baiduCompatible) {
    fields(body,['messages','resource_type_filter','edition','search_filter','search_recency_filter'])
    assert(Array.isArray(body.messages) && body.messages.length===1 && body.messages[0]?.role==='user',400,'invalid_web_search_request','Provide one user message')
    fields(body.messages[0],['role','content'])
    if (body.search_filter) {
      fields(body.search_filter,['match','range'])
      if(body.search_filter.match) fields(body.search_filter.match,['site'])
      if(body.search_filter.range) {fields(body.search_filter.range,['page_time']); if(body.search_filter.range.page_time) fields(body.search_filter.range.page_time,['gte','lte'])}
    }
    assert(body.resource_type_filter == null || Array.isArray(body.resource_type_filter),400,'invalid_web_search_request','resource_type_filter must be an array')
    const dates=body.search_filter?.range?.page_time
    body={query:body.messages[0].content,provider:'baidu',resources:body.resource_type_filter?.map(row=>{fields(row,['type','top_k']);return {type:row.type,limit:row.top_k}}),edition:body.edition,
      sites:body.search_filter?.match?.site,from:dates?.gte || undefined,to:dates?.lte || undefined,recency:body.search_recency_filter}
  }
  fields(body,['query','provider','resources','limit','edition','sites','from','to','recency'])
  assert(typeof body.query==='string' && body.query.trim().length>0 && body.query.length<=2000 && !body.query.includes('\0'),400,'invalid_web_search_request','query must contain 1–2000 characters')
  assert(body.provider==null || !!webSearchProvider(body.provider),400,'invalid_web_search_provider','Unknown search provider')
  assert(body.limit==null || Number.isInteger(body.limit) && body.limit>=1 && body.limit<=50,400,'invalid_web_search_request','limit must be 1–50')
  assert(!(body.limit!=null && body.resources!=null),400,'invalid_web_search_request','Use either limit or resources')
  const resources=body.resources ?? [{type:'web',limit:body.limit ?? 10}]
  assert(Array.isArray(resources) && resources.length>=1 && resources.length<=3,400,'invalid_web_search_request','Provide 1–3 resource types')
  const seen=new Set()
  for (const row of resources) {
    fields(row,['type','limit']);const max={web:50,image:30,video:10}[row.type]
    assert(max && !seen.has(row.type) && Number.isInteger(row.limit) && row.limit>=1 && row.limit<=max,400,'invalid_web_search_request','Invalid or duplicate resource limit');seen.add(row.type)
  }
  const sites=body.sites ?? []
  assert(Array.isArray(sites) && sites.length<=20 && sites.every(s=>typeof s==='string' && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(s)),400,'invalid_web_search_request','sites must be up to 20 domain names')
  const date=s=>typeof s==='string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10)===s
  assert((body.from==null && body.to==null) || (date(body.from)&&date(body.to)&&body.from<=body.to),400,'invalid_web_search_request','Provide both from and to as valid YYYY-MM-DD dates')
  const recency=body.recency==='noTimeLimit'?null:body.recency ?? null
  assert(recency===null || ['week','month','semiyear','year'].includes(recency),400,'invalid_web_search_request','Unsupported recency')
  assert(!(recency && body.from),400,'invalid_web_search_request','Choose date range or recency')
  assert(!(body.from || recency || sites.length) || seen.has('web'),400,'invalid_web_search_request','Site and date filters require web results')
  const edition=body.edition ?? 'standard'
  assert(['standard','lite'].includes(edition),400,'invalid_web_search_request','Unsupported edition')
  return {query:body.query.trim(),provider:body.provider ?? null,resources:[...resources].sort((a,b)=>a.type.localeCompare(b.type)),sites:[...new Set(sites.map(s=>s.toLowerCase()))].sort(),from:body.from ?? null,to:body.to ?? null,recency,edition}
}
export function providerSupports(provider, request) {
  return request.resources.every(r=>provider.resources.includes(r.type) && r.limit<=({web:provider.maxResults,image:30,video:10}[r.type])) &&
    (provider.key==='baidu' || (!request.sites.length && !request.from && !request.recency && request.edition==='standard'))
}
export function gatewayWebSearchRequest(request, provider, maxPageSize) {
  const size=request.resources.reduce((sum,r)=>sum+r.limit,0)
  assert(size<=maxPageSize,400,'page_size_exceeded','Requested results exceed the Key page limit')
  assert(providerSupports(provider,request),400,'web_search_options_unsupported','Selected supplier does not support these options')
  return {request,provider,endpointKey:provider.endpointKey,endpointPath:new URL(searchUpstream(provider.key).url).pathname,endpointContractVersion:WEB_SEARCH_VERSION,endpointVersion:WEB_SEARCH_VERSION,
    marketplace:'web_search',deliveryMode:'live_only',pageSize:size,fingerprintBody:{...request,provider:provider.key}}
}
export function validateSearchOrder(value, capabilities) {
  assert(Array.isArray(value) && value.length<=8 && new Set(value).size===value.length && value.every(key=>webSearchProvider(key) && capabilities.includes(webSearchProvider(key).capability)),400,'invalid_web_search_order','Search order must contain distinct, explicitly granted suppliers')
  return [...value]
}
export function buildSearchHttp(provider, request, key) {
  const limit=request.resources.find(row=>row.type==='web')?.limit ?? 10
  const url=new URL(searchUpstream(provider.key).url), headers={'content-type':'application/json'}, q=request.query
  let body,method='POST'
  if (provider.key==='baidu') {headers.Authorization=`Bearer ${key}`;body={messages:[{role:'user',content:q}],edition:request.edition,resource_type_filter:request.resources.map(r=>({type:r.type,top_k:r.limit}))};
    if(request.sites.length || request.from) body.search_filter={...(request.sites.length?{match:{site:request.sites}}:{}),...(request.from?{range:{page_time:{gte:request.from,lte:request.to}}}:{})};if(request.recency)body.search_recency_filter=request.recency
  } else if(provider.key==='exa') {headers['x-api-key']=key;body={query:q,type:'auto',numResults:limit}}
  else if(provider.key==='tavily') {headers.Authorization=`Bearer ${key}`;body={query:q,max_results:limit,search_depth:'basic',include_answer:false,include_raw_content:false,include_images:false,auto_parameters:false}}
  else if(provider.key==='serper') {headers['x-api-key']=key;body={q,num:limit}}
  else if(provider.key==='you') {headers['x-api-key']=key;body={query:q,count:limit}}
  else if(provider.key==='firecrawl') {headers.Authorization=`Bearer ${key}`;body={query:q,limit,sources:[{type:'web'}]}}
  else {method='GET';url.searchParams.set('engine','google');url.searchParams.set('q',q);url.searchParams.set('num',String(limit));if(provider.key==='searchapi')headers.Authorization=`Bearer ${key}`;else {url.searchParams.set('api_key',key);url.searchParams.set('output','json')}}
  return {url,options:{method,headers,...(body?{body:JSON.stringify(body)}:{})}}
}
function httpUrl(value) {try {const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null}catch{return null}}
export function normalizeSearchResponse(raw, provider, request, capturedAt) {
  if(!object(raw) || raw.error || raw.error_code || raw.success===false) throw new Error('upstream_business_error')
  const rows=provider.key==='baidu'?raw.references:provider.key==='serper'?raw.organic:provider.key==='you'?raw.results?.web:
    provider.key==='searchapi'||provider.key==='serpapi'?raw.organic_results:provider.key==='firecrawl'?(Array.isArray(raw.data)?raw.data:raw.data?.web):raw.results
  if(!Array.isArray(rows)) throw new Error('unrecognized_search_response')
  const counts=new Map(),items=[]
  for(const row of rows) {
    if(!object(row))throw new Error('invalid_search_item')
    const url=httpUrl(row.url ?? row.link),type=row.type ?? 'web'
    if(!url || !['web','image','video'].includes(type))throw new Error('invalid_search_item')
    const budget=request.resources.find(r=>r.type===type)?.limit ?? 0
    if((counts.get(type)||0)>=budget)continue
    const title=row.title ?? '', snippet=row.content ?? row.snippet ?? row.description ?? (Array.isArray(row.snippets)?row.snippets.join('\n'):'')
    if(typeof title!=='string'||typeof snippet!=='string')throw new Error('invalid_search_item')
    counts.set(type,(counts.get(type)||0)+1)
    items.push({type,title:title.slice(0,2000),url,snippet:snippet.slice(0,8000),publishedAt:typeof(row.date ?? row.publishedDate)==='string'?(row.date ?? row.publishedDate):null})
  }
  return {data:{query:request.query,provider:provider.key,items},meta:{contractVersion:WEB_SEARCH_VERSION,capturedAt,empty:items.length===0,fullText:false}}
}
