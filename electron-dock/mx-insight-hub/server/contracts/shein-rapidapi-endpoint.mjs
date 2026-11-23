// RapidAPI's SHEIN Data API documents the US keyword-search contract at
// https://rapidapi.com/belchiorarkad-FqvHs2EDOtP/api/shein-data-api/tutorials/build-a-shein-price-drop-tracker-in-python
const key = 'r.shein_search_products'
export const SHEIN_RAPIDAPI_SEARCH_ENDPOINT = Object.freeze({
  key, id: key, provider: 'rapidapi', host: 'shein-data-api.p.rapidapi.com',
  method: 'GET', path: '/search/products', summary: 'SHEIN 美国站商品关键词搜索',
  platform: 'shein', platformLabel: 'SHEIN', marketplace: 'shein', authorizationPlatform: 'ecommerce',
  operation: `native.${key}`, endpointKey: `native.${key}`, hubPath: `/api/v1/data/native/${key}`,
  schemaVersion: 'shein-data-api.search.2026-11-23', status: 'fixed_read_contract', reason: null,
  sourceUrl: 'https://rapidapi.com/belchiorarkad-FqvHs2EDOtP/api/shein-data-api/playground/apiendpoint_a11fb5ba-a228-438c-b58a-8f976638bd4c',
  parameters: Object.freeze([
    Object.freeze({ name: 'query', type: 'string', required: true, minLength: 1, maxLength: 200, description: '商品关键词。' }),
    Object.freeze({ name: 'country', type: 'string', required: false, default: 'US', enum: ['US'], description: '美国站。' }),
    Object.freeze({ name: 'page', type: 'integer', required: false, default: 1, minimum: 1, maximum: 200, description: '从 1 开始的页码。' }),
    Object.freeze({ name: 'limit', type: 'integer', required: false, default: 20, minimum: 1, maximum: 100, description: '每页商品数，上限受 Hub 调用配置约束。' }),
  ]),
  fixedQuery: Object.freeze({}),
})

export function isSheinProductSearchPage(raw) {
  return raw?.success === true && raw.error == null && Array.isArray(raw.data?.products)
    && raw.data.products.every(product => {
      const id = product?.goods_id
      const hasId = typeof id === 'string' ? id.trim().length > 0 : Number.isSafeInteger(id) && id > 0
      return hasId && typeof product.name === 'string' && product.name.trim().length > 0
    })
}
