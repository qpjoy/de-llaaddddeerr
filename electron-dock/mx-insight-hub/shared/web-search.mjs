// Public product names and authorization identifiers; credentials/egress stay server-side.
export const WEB_SEARCH_VERSION = 'mx-insight-hub.web-search.v1'
export const WEB_SEARCH_PATH = '/api/v1/data/web-search/search'
export const WEB_SEARCH_PROVIDERS = Object.freeze([
  ['baidu', '百度 AI 搜索', ['web','image','video']],
  ['exa', 'Exa', ['web']],
  ['tavily', 'Tavily', ['web']],
  ['serper', 'Serper', ['web']],
  ['you', 'You.com', ['web']],
  ['searchapi', 'SearchAPI', ['web']],
  ['firecrawl', 'Firecrawl', ['web']],
  ['serpapi', 'SerpApi', ['web']],
].map(([key,label,resources]) => Object.freeze({key,label,resources, capability:`web.search.provider.${key}`, endpointKey:`${key}.web-search`, maxResults:key==='baidu'?50:20})))
export const webSearchProvider = key => WEB_SEARCH_PROVIDERS.find(row => row.key === key)
export const searchProviderKeys = capabilities => WEB_SEARCH_PROVIDERS.filter(row => capabilities?.includes(row.capability)).map(row => row.key)
export function withWebSearchProviders(form, order) {
  const capabilities = (form.capabilities || []).filter(scope => !scope.startsWith('web.search.provider.'))
  return {...form, webSearchOrder:order, platforms:[...new Set([...(form.platforms || []), ...(order.length?['web_search']:[])])],
    capabilities:[...new Set([...capabilities,...(order.length?['web.search']:[]),...order.map(key=>webSearchProvider(key).capability)])]}
}
