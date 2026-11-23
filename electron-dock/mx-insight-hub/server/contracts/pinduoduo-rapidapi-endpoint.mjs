const key = 'r.pinduoduo_search_products'
export const PINDUODUO_RAPIDAPI_SEARCH_ENDPOINT = Object.freeze({
  key, id: key, provider: 'rapidapi', host: 'pinduoduo1.p.rapidapi.com',
  method: 'GET', path: '/pinduoduo/search', summary: '拼多多商品关键词搜索',
  platform: 'pinduoduo', platformLabel: '拼多多', marketplace: 'pinduoduo', authorizationPlatform: 'ecommerce',
  operation: `native.${key}`, endpointKey: `native.${key}`, hubPath: `/api/v1/data/native/${key}`,
  schemaVersion: 'pinduoduo1.search.2026-11-23', status: 'fixed_read_contract', reason: null,
  sourceUrl: 'https://rapidapi.com/chuyenhangsieutocvn/api/pinduoduo1/playground/apiendpoint_f51cf272-e79a-4e60-aaad-d73b01dc2bca',
  parameters: Object.freeze([
    Object.freeze({ name: 'keyword', type: 'string', required: true, minLength: 1, maxLength: 200, description: '商品搜索关键词。' }),
    Object.freeze({ name: 'page', type: 'integer', required: false, default: 1, minimum: 1, description: '页码。首次请求从 1 开始。' }),
  ]),
  fixedQuery: Object.freeze({}),
})

// The live result has current/page_size but no total or terminal marker.
// A short page, including the observed 9 of 10 products, does not establish an end.
export function isPinduoduoProductSearchPage(raw, requestedPage) {
  const page = raw?.data?.pagination
  return raw?.success === true && raw.code === 0
    && Number.isSafeInteger(page?.current) && page.current === requestedPage
    && Number.isSafeInteger(page.page_size) && page.page_size > 0
    && Array.isArray(raw.data.items) && raw.data.items.every(product => {
      const id = product?.goods_id
      return (Number.isSafeInteger(id) && id > 0 || typeof id === 'string' && /^[1-9]\d*$/.test(id))
        && typeof product.goods_name === 'string' && product.goods_name.trim().length > 0
    })
}
