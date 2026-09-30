import { WEB_SEARCH_PROVIDERS } from '../../shared/web-search.mjs'
const urls={'baidu': 'https://qianfan.baidubce.com/v2/ai_search/web_search', 'exa': 'https://api.exa.ai/search', 'tavily': 'https://api.tavily.com/search', 'serper': 'https://google.serper.dev/search', 'you': 'https://ydc-index.io/v1/search', 'searchapi': 'https://www.searchapi.io/api/v1/search', 'firecrawl': 'https://api.firecrawl.dev/v2/search', 'serpapi': 'https://serpapi.com/search.json'}
export const SEARCH_UPSTREAMS=WEB_SEARCH_PROVIDERS.map(p=>({...p,url:urls[p.key]}))
export const searchUpstream=key=>SEARCH_UPSTREAMS.find(p=>p.key===key)
