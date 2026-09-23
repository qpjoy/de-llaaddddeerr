import { createHash } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { XHS_DISCOVERY_VERSION, XHS_DISCOVERY_PRODUCTS, XHS_HOT_SORTS, XHS_HOT_WINDOWS, discoveryCollection } from '../../shared/xiaohongshu-discovery.mjs'
export { XHS_DISCOVERY_VERSION }
export const XHS_DISCOVERY_ENDPOINTS = Object.freeze(Object.fromEntries(XHS_DISCOVERY_PRODUCTS.map(product => [product.id, {
  ...product, name: product.id, fields: product.fields.map(field => field[0]),
  provider: product.id === 'hot_notes' ? 'justone' : 'tikhub',
  providerPath: product.id === 'hot_notes' ? '/api/xiaohongshu/hot-search/v1' : '/api/v1/xiaohongshu/app_v2/get_creator_hot_inspiration_feed',
  endpointKey: product.id === 'hot_notes' ? 'xiaohongshu.hot-search.v1' : 'xiaohongshu.app-v2.creator-inspiration.v1',
  endpointVersion: product.id === 'hot_notes' ? 'v1' : 'app_v2', providerMethod: 'GET',
  gate: 'discoveryContractVerified', discovery: true, research: true, liveOnly: true,
}])))
export const XHS_DISCOVERY_OPERATIONS = XHS_DISCOVERY_PRODUCTS.map(product => product.operation)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const invalid = message => { throw new AppError(400, 'invalid_request', message) }
const unusable = () => { throw new AppError(502, 'invalid_upstream_contract', 'Discovery response has no usable business envelope') }

export function normalizeXhsDiscoveryRequest(id, body, { decodeCursor } = {}) {
  const endpoint = XHS_DISCOVERY_ENDPOINTS[id]
  if (!endpoint || !object(body) || Object.keys(body).some(key => !endpoint.fields.includes(key))) invalid('Unsupported discovery request fields')
  const publicQuery = {}, providerQuery = {}
  if (id === 'hot_notes') {
    const searchWord = body.searchWord ?? '', orderBy = body.orderBy ?? 'premium_imp_num', nd = body.nd ?? 'DAY_7'
    if (typeof searchWord !== 'string' || searchWord.length > 500 || !XHS_HOT_SORTS.includes(orderBy) || !XHS_HOT_WINDOWS.includes(nd)) invalid('Invalid keyword, orderBy or nd')
    Object.assign(publicQuery, { searchWord: searchWord.trim(), orderBy, nd })
    if (body.noteContentCategory != null && body.noteContentCategory !== '') {
      if (typeof body.noteContentCategory !== 'string' || body.noteContentCategory.length > 200 || !/^(内容类目|所属行业)#[^#\r\n]+(?:#[^#\r\n]+)?$/u.test(body.noteContentCategory.trim())) invalid('Invalid noteContentCategory path')
      publicQuery.noteContentCategory = body.noteContentCategory.trim()
    }
    Object.assign(providerQuery, publicQuery, { pageNum: 1 })
  }
  const scope = createHash('sha256').update(JSON.stringify([XHS_DISCOVERY_VERSION, id, publicQuery])).digest('hex')
  let page = 1, providerCursor = null
  if (body.cursor != null && body.cursor !== '') {
    if (typeof body.cursor !== 'string' || body.cursor.length > 8192 || !decodeCursor) invalid('Invalid discovery cursor')
    let state
    try { state = decodeCursor(body.cursor) } catch { invalid('Invalid discovery cursor') }
    if (!object(state) || state.version !== XHS_DISCOVERY_VERSION || state.scope !== scope || !Number.isInteger(state.page) || state.page < 2 || state.page > 15) invalid('Cursor does not match this query')
    page = state.page
    if (id === 'hot_notes') providerQuery.pageNum = page
    else {
      if (typeof state.cursor !== 'string' || !state.cursor || state.cursor.length > 4096) invalid('Invalid inspiration cursor')
      providerCursor = state.cursor; providerQuery.cursor = providerCursor
    }
    publicQuery.cursor = body.cursor
  }
  // TikHub explicitly documents cursor="" for page one.
  if (id === 'creator_inspiration' && page === 1) providerQuery.cursor = ''
  return { endpoint, publicQuery, providerQuery, upstreamQuery: providerQuery, page, scope, providerCursor,
    contractVersion: XHS_DISCOVERY_VERSION, endpointContractVersion: XHS_DISCOVERY_VERSION,
    endpointKey: endpoint.endpointKey, endpointVersion: endpoint.endpointVersion, endpointPath: endpoint.providerPath,
    marketplace: 'xiaohongshu', deliveryMode: 'live_only',
    fingerprintBody: { contractVersion: XHS_DISCOVERY_VERSION, id, ...publicQuery } }
}

export function projectXhsDiscovery(raw, request, capturedAt, { encodeCursor } = {}) {
  if (!object(raw) || raw.code !== (request.endpoint.provider === 'justone' ? 0 : 200) || !Object.hasOwn(raw, 'data')) unusable()
  let business = raw.data
  // Only unwrap explicit service envelopes, never arbitrary nested data.
  for (let depth = 0; depth < 2 && object(business); depth++) {
    if (business.success === false || (Object.hasOwn(business, 'code') && ![0, 200, '0', '200'].includes(business.code))) unusable()
    if (Object.hasOwn(business, 'data') && (Object.hasOwn(business, 'success') || Object.hasOwn(business, 'code'))) business = business.data
    else break
  }
  if (business !== null && !object(business) && !Array.isArray(business)) unusable()
  const collection = discoveryCollection(business)
  const empty = collection?.items.length === 0
  const unknown = business == null || (object(business) && Object.keys(business).length === 0)
  const flag = business?.has_more ?? business?.hasMore
  const more = [true, 1, '1', 'true'].includes(flag) ? true : [false, 0, '0', 'false'].includes(flag) ? false : null
  const nativeCursor = business?.next_cursor ?? business?.nextCursor ?? business?.cursor
  const nativeNext = typeof nativeCursor === 'string' && nativeCursor.length > 0 && nativeCursor.length <= 4096 && nativeCursor !== request.providerCursor ? nativeCursor : null
  const continuable = !empty && more !== false && (request.endpoint.id === 'hot_notes'
    ? collection?.items.length > 0 || more === true
    : Boolean(nativeNext))
  const nextCursor = continuable && request.page < 15 && encodeCursor ? encodeCursor({ version: XHS_DISCOVERY_VERSION, scope: request.scope, page: request.page + 1, ...(nativeNext ? { cursor: nativeNext } : {}) }) : null
  const result = structuredClone(business)
  if (object(result)) for (const field of ['cursor', 'next_cursor', 'nextCursor', 'pageNum', 'request_id', 'requestId', 'router', 'cache_url', 'docs', 'support']) delete result[field]
  return { contractVersion: XHS_DISCOVERY_VERSION, data: { result, pageInfo: {
    page: request.page, nextCursor, hasMore: empty || more === false ? false : more === true && nextCursor ? true : null,
    paginationStatus: empty || more === false ? 'exhausted' : continuable && request.page === 15 ? 'limit_reached'
      : nextCursor ? request.endpoint.id === 'hot_notes' && more === null ? 'next_page_probe' : 'continuable' : 'unknown',
  } }, meta: { capturedAt: new Date(capturedAt).toISOString(), status: empty ? 'no_data' : unknown ? 'unknown' : 'ok',
    projection: 'native_fields', collectionPath: collection?.path ?? null, returnedCount: collection?.items.length ?? null } }
}
