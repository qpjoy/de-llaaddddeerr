const key = 'r.facebook_marketplace_search'
export const FACEBOOK_MARKETPLACE_RAPIDAPI_ENDPOINT = Object.freeze({
  key, id: key, provider: 'rapidapi', host: 'facebook-scraper3.p.rapidapi.com',
  method: 'GET', path: '/marketplace/search', summary: '按关键词和经纬度搜索 Marketplace 商品',
  platform: 'facebook_marketplace', platformLabel: 'Facebook Marketplace', marketplace: 'facebook_marketplace', authorizationPlatform: 'ecommerce',
  operation: `native.${key}`, endpointKey: `native.${key}`, hubPath: `/api/v1/data/native/${key}`,
  schemaVersion: 'facebook-scraper3.marketplace-search.2026-11-23', status: 'fixed_read_contract', reason: null,
  sourceUrl: 'https://rapidapi.com/krasnoludkolo/api/facebook-scraper3/playground/apiendpoint_7c4176f7-5b4f-4a1e-8961-b018316fb986',
  parameters: Object.freeze([
    Object.freeze({ name: 'query', type: 'string', required: true, minLength: 1, maxLength: 200, description: '商品关键词。' }),
    Object.freeze({ name: 'lat', type: 'number', required: true, minimum: -90, maximum: 90, description: '搜索中心纬度。' }),
    Object.freeze({ name: 'lng', type: 'number', required: true, minimum: -180, maximum: 180, description: '搜索中心经度。' }),
    Object.freeze({ name: 'cursor', type: 'string', required: false, minLength: 1, maxLength: 8192, description: '上游返回的续页游标。' }),
  ]),
  fixedQuery: Object.freeze({}),
})

// The live search returned an empty array. Preserve the supplier's listing
// objects without requiring item fields that have not been observed.
export function isFacebookMarketplaceSearchPage(raw) {
  return Array.isArray(raw?.results) && !raw.error && raw.success !== false && raw.status !== 'error'
    && (raw.cursor == null || typeof raw.cursor === 'string')
}
