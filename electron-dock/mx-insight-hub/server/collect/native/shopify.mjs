import { pinnedPublicHttpsAgent } from '../../external-platforms/media.mjs'
import { failed, parseJson, readBounded, transportCause } from '../http.mjs'

const SEARCH = `query ShopProducts($keyword: String!, $first: Int!, $after: String) {
  search(query: $keyword, types: [PRODUCT], first: $first, after: $after) {
    nodes { ... on Product { id title handle onlineStoreUrl priceRange { minVariantPrice { amount currencyCode } } } }
    pageInfo { hasNextPage endCursor }
  }
}`

function product(node) {
  const money = node?.priceRange?.minVariantPrice
  if (typeof node?.id !== 'string' || !/^gid:\/\/shopify\/Product\/\d+$/.test(node.id)
    || typeof node.title !== 'string' || !node.title || typeof node.handle !== 'string' || !node.handle
    || !(node.onlineStoreUrl === null || (typeof node.onlineStoreUrl === 'string' && node.onlineStoreUrl.startsWith('https://')))
    || typeof money?.amount !== 'string' || !/^\d+(?:\.\d+)?$/.test(money.amount)
    || typeof money.currencyCode !== 'string' || !/^[A-Z]{3}$/.test(money.currencyCode)) return null
  return { id: node.id, title: node.title, handle: node.handle, onlineStoreUrl: node.onlineStoreUrl,
    priceRange: { minVariantPrice: { amount: money.amount, currencyCode: money.currencyCode } } }
}

export async function shopifySearch({ input, fetchImpl, deps = {} }) {
  const { domain, keyword, maxItems, after = null } = input
  const url = new URL(`https://${domain}/api/2026-10/graphql.json`)
  const signal = AbortSignal.timeout(12_000)
  let dispatcher
  try {
    dispatcher = await pinnedPublicHttpsAgent(url, { signal, lookup: deps.lookup })
    const response = await fetchImpl(url, { dispatcher, signal, redirect: 'error', method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query: SEARCH, variables: { keyword, first: maxItems, after } }) })
    if (!response.ok) return failed('shopify_upstream_error', '店铺 Storefront API 未接受查询', { upstreamStatus: response.status })
    const body = parseJson(await readBounded(response, 512 * 1024))
    if (body?.errors?.length) return failed('shopify_query_error', '店铺 Storefront API 返回查询错误')
    const search = body?.data?.search
    const page = search?.pageInfo
    const validCursor = typeof page?.endCursor === 'string' && page.endCursor.length > 0 && page.endCursor.length <= 2_048
    if (!Array.isArray(search?.nodes) || search.nodes.length > maxItems || typeof page?.hasNextPage !== 'boolean'
      || !(validCursor || (page.endCursor === null && !page.hasNextPage))) {
      return failed('shopify_invalid_response', '店铺未返回有效的 Shopify 商品搜索结果')
    }
    const items = search.nodes.map(product)
    if (items.includes(null)) return failed('shopify_invalid_response', '店铺返回的 Shopify 商品字段无效')
    return { status: 'succeeded', dataStatus: items.length ? 'success' : 'no_data', charge: true, itemCount: items.length,
      result: { domain, keyword, items, pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor } } }
  } catch (error) {
    return failed('shopify_request_failed', '无法从该公开域名读取 Shopify 商品搜索结果', { cause: transportCause(error) })
  } finally {
    await dispatcher?.destroy()
  }
}
