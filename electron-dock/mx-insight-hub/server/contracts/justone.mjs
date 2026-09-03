import { createHash } from 'node:crypto'

export const JUSTONE_PROVIDER_KEY = 'justone'
export const JUSTONE_OPERATION = 'ecommerce.products.search'
export const JUSTONE_CONTRACT_VERSION = 'justone.product-search.v1'
export const ECOMMERCE_PRODUCT_SEARCH_CONTRACT_VERSION = 'mx-insight-hub.ecommerce-products.v1'

const MAX_QUERY_LENGTH = 200
const MAX_CURSOR_LENGTH = 4_096
const MAX_PAGE = 1_000
const DEFAULT_MAX_PAGE_SIZE = 100
const MAX_JSON_DEPTH = 32
const MAX_JSON_NODES = 50_000
const MAX_POSTGRES_INTEGER = 2_147_483_647
const PRICE_PATTERN = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/u

const TAOBAO_SORTS = Object.freeze({
  relevance: '_coefp',
  sales_desc: '_sale',
  price_asc: 'bid',
  price_desc: '_bid',
})

const XIANYU_SORTS = Object.freeze({
  relevance: 'active',
  recent: 'recent',
  seller_credit: 'credit',
  price_asc: 'price_asc',
  price_desc: 'price_desc',
  price_drop: 'price_drop',
  newest: 'newest',
})

function endpoint({ endpointKey, path, itemPaths, sortMap = null, tmall = false }) {
  return Object.freeze({
    endpointKey,
    endpointVersion: 'v1',
    method: 'GET',
    path,
    itemPaths: Object.freeze(itemPaths.map((segments) => Object.freeze([...segments]))),
    sortMap,
    tmall,
  })
}

// `data` is intentionally untyped in the upstream OpenAPI documents. These
// paths are the small set of fixture shapes the Hub accepts. A new upstream
// shape must arrive with a reviewed fixture and an explicit addition here.
export const JUSTONE_ENDPOINTS = Object.freeze({
  taobao: endpoint({
    endpointKey: 'taobao-tmall.product-search.v1',
    path: '/api/taobao/search-item-list/v1',
    itemPaths: [['data', 'items'], ['data', 'itemList']],
    sortMap: TAOBAO_SORTS,
  }),
  tmall: endpoint({
    endpointKey: 'taobao-tmall.product-search.v1',
    path: '/api/taobao/search-item-list/v1',
    itemPaths: [['data', 'items'], ['data', 'itemList']],
    sortMap: TAOBAO_SORTS,
    tmall: true,
  }),
  jd: endpoint({
    endpointKey: 'jd.product-search.v1',
    path: '/api/jd/search-item-list/v1',
    itemPaths: [['data', 'items'], ['data', 'list']],
  }),
  xiaohongshu_ec: endpoint({
    endpointKey: 'xiaohongshu-ec.product-search.v1',
    path: '/api/xiaohongshu-ec/search-products/v1',
    itemPaths: [['data', 'items'], ['data', 'products']],
  }),
  xianyu: endpoint({
    endpointKey: 'xianyu.product-search.v1',
    path: '/api/xianyu/search-item-list/v1',
    itemPaths: [['data', 'items'], ['data', 'list']],
    sortMap: XIANYU_SORTS,
  }),
})

export const JUSTONE_SUPPORTED_MARKETPLACES = Object.freeze(Object.keys(JUSTONE_ENDPOINTS))

export const JUSTONE_BUSINESS_CODES = Object.freeze({
  100: Object.freeze({ category: 'authentication', errorCode: 'upstream_auth_invalid' }),
  301: Object.freeze({ category: 'collection', errorCode: 'upstream_collection_failed' }),
  302: Object.freeze({ category: 'rate_limit', errorCode: 'upstream_rate_limited' }),
  303: Object.freeze({ category: 'quota', errorCode: 'upstream_daily_quota_exceeded' }),
  400: Object.freeze({ category: 'request', errorCode: 'invalid_request' }),
  500: Object.freeze({ category: 'upstream', errorCode: 'upstream_internal_error' }),
  600: Object.freeze({ category: 'authorization', errorCode: 'upstream_permission_denied' }),
  601: Object.freeze({ category: 'balance', errorCode: 'upstream_balance_exhausted' }),
  602: Object.freeze({ category: 'quota', errorCode: 'upstream_token_limit_exceeded' }),
})

export class JustOneContractError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'JustOneContractError'
    this.code = code
  }
}

export class JustOneResponseContractError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'JustOneResponseContractError'
    this.code = code
  }
}

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value === undefined ? null : value)
}

function assertBoundedJson(value, depth = 0, state = { nodes: 0 }) {
  state.nodes += 1
  if (depth > MAX_JSON_DEPTH || state.nodes > MAX_JSON_NODES) {
    throw new JustOneResponseContractError(
      'upstream_payload_too_complex',
      'upstream payload exceeds structural limits',
    )
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertBoundedJson(entry, depth + 1, state)
  } else if (plainObject(value)) {
    for (const entry of Object.values(value)) assertBoundedJson(entry, depth + 1, state)
  }
}

function normalizedText(value, { maxLength, name, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new JustOneContractError(`invalid_${name}`, `${name} is required`)
    return null
  }
  if (typeof value !== 'string') {
    throw new JustOneContractError(`invalid_${name}`, `${name} must be a string`)
  }
  const text = value.normalize('NFKC').trim()
  if (!text && required) throw new JustOneContractError(`invalid_${name}`, `${name} is required`)
  if (!text) return null
  if (maxLength && text.length > maxLength) {
    throw new JustOneContractError(`invalid_${name}`, `${name} is too long`)
  }
  return text
}

function normalizedPage(value) {
  if (value === undefined || value === null || value === '') return 1
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE) {
    throw new JustOneContractError('invalid_page', `page must be an integer between 1 and ${MAX_PAGE}`)
  }
  return value
}

function normalizedMaxPageSize(value) {
  const parsed = value ?? DEFAULT_MAX_PAGE_SIZE
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000) {
    throw new TypeError('maxPageSize must be an integer between 1 and 1000')
  }
  return parsed
}

function normalizedPrice(value, name) {
  if (value === undefined) return null
  if (typeof value !== 'string' || !PRICE_PATTERN.test(value)) {
    throw new JustOneContractError(
      'invalid_price',
      `price.${name} must be a decimal string with up to 12 integer and 8 fractional digits`,
    )
  }
  return value
}

function priceUnits(value) {
  const [integer, fraction = ''] = value.split('.')
  return BigInt(`${integer}${fraction.padEnd(8, '0')}`)
}

function normalizedPriceRange(value, marketplace) {
  if (value === undefined) return Object.freeze({ min: null, max: null })
  if (!plainObject(value)) throw new JustOneContractError('invalid_price', 'price must be an object')
  const unknown = Object.keys(value).filter((key) => !['min', 'max'].includes(key))
  if (unknown.length > 0) throw new JustOneContractError('invalid_price', 'price contains unsupported fields')
  if (!['taobao', 'tmall'].includes(marketplace)) {
    throw new JustOneContractError('unsupported_price_filter', 'price filters are not supported for this marketplace')
  }
  const min = normalizedPrice(value.min, 'min')
  const max = normalizedPrice(value.max, 'max')
  if (min !== null && max !== null && priceUnits(min) > priceUnits(max)) {
    throw new JustOneContractError('invalid_price', 'price.min must not exceed price.max')
  }
  return Object.freeze({ min, max })
}

function defaultSort(marketplace) {
  if (marketplace === 'taobao' || marketplace === 'tmall') return 'sales_desc'
  if (marketplace === 'xianyu') return 'relevance'
  return null
}

function normalizedSort(value, marketplace, descriptor) {
  if (!descriptor.sortMap) {
    if (value !== undefined && value !== null && value !== '') {
      throw new JustOneContractError('unsupported_sort', 'sort is not supported for this marketplace')
    }
    return null
  }
  const result = normalizedText(value, { maxLength: 40, name: 'sort' }) || defaultSort(marketplace)
  if (!own(descriptor.sortMap, result)) {
    throw new JustOneContractError('unsupported_sort', 'sort is not supported for this marketplace')
  }
  return result
}

function cursorScope({ marketplace, query, sort, price }) {
  return sha256(JSON.stringify({
    marketplace,
    query,
    sort,
    price: { min: price.min, max: price.max },
  }))
}

function decodedCursor(cursor, decodeCursor) {
  if (!cursor) return null
  if (typeof decodeCursor !== 'function') {
    throw new JustOneContractError('cursor_codec_required', 'a trusted cursor decoder is required')
  }
  let state
  try {
    state = decodeCursor(cursor)
  } catch {
    throw new JustOneContractError('invalid_cursor', 'cursor is invalid')
  }
  if (
    !plainObject(state)
    || state.version !== 1
    || typeof state.marketplace !== 'string'
    || !Number.isInteger(state.page)
    || state.page < 1
    || state.page > MAX_PAGE
    || typeof state.scope !== 'string'
    || (state.continuation !== null && typeof state.continuation !== 'string')
    || (typeof state.continuation === 'string' && state.continuation.length > 2_048)
  ) {
    throw new JustOneContractError('invalid_cursor', 'cursor is invalid')
  }
  return state
}

function safeCursor(value) {
  return normalizedText(value, { maxLength: MAX_CURSOR_LENGTH, name: 'cursor' })
}

export function normalizeJustOneProductSearchRequest(body, {
  decodeCursor,
  // Accepted for a symmetric gateway codec interface. Encoding is performed
  // only while producing a response, never while validating a request.
  encodeCursor: _encodeCursor,
  maxPageSize,
} = {}) {
  if (!plainObject(body)) throw new JustOneContractError('invalid_request', 'request body must be an object')
  const allowed = new Set(['marketplace', 'query', 'page', 'cursor', 'sort', 'price'])
  const unknown = Object.keys(body).filter((key) => !allowed.has(key))
  if (unknown.length > 0) {
    throw new JustOneContractError('unsupported_request_field', `unsupported request field: ${unknown[0]}`)
  }

  const marketplace = normalizedText(body.marketplace, {
    maxLength: 40,
    name: 'marketplace',
    required: true,
  })
  const descriptor = JUSTONE_ENDPOINTS[marketplace]
  if (!descriptor) throw new JustOneContractError('unsupported_marketplace', 'marketplace is not supported')
  const query = normalizedText(body.query, { maxLength: MAX_QUERY_LENGTH, name: 'query', required: true })
  const sort = normalizedSort(body.sort, marketplace, descriptor)
  const price = normalizedPriceRange(body.price, marketplace)
  const cursor = safeCursor(body.cursor)
  if (cursor && body.page !== undefined && body.page !== null) {
    throw new JustOneContractError('invalid_pagination', 'cursor and page are mutually exclusive')
  }
  const scope = cursorScope({ marketplace, query, sort, price })
  const state = decodedCursor(cursor, decodeCursor)
  if (state && (state.marketplace !== marketplace || state.scope !== scope)) {
    throw new JustOneContractError('cursor_scope_mismatch', 'cursor does not belong to this search')
  }
  const page = state?.page ?? normalizedPage(body.page)
  if (marketplace === 'xiaohongshu_ec' && page > 1 && !state?.continuation) {
    throw new JustOneContractError('continuation_required', 'a valid cursor is required after the first page')
  }

  const upstreamQuery = { keyword: query, page: String(page) }
  if (descriptor.sortMap) upstreamQuery.sort = descriptor.sortMap[sort]
  if (descriptor.tmall) upstreamQuery.tmall = 'true'
  if (price.min !== null) upstreamQuery.startPrice = price.min
  if (price.max !== null) upstreamQuery.endPrice = price.max
  if (marketplace === 'xiaohongshu_ec' && state?.continuation) {
    upstreamQuery.searchId = state.continuation
  }

  return Object.freeze({
    contractVersion: ECOMMERCE_PRODUCT_SEARCH_CONTRACT_VERSION,
    operation: JUSTONE_OPERATION,
    marketplace,
    query,
    page,
    sort,
    price,
    cursor,
    cursorScope: scope,
    endpointKey: descriptor.endpointKey,
    endpointVersion: descriptor.endpointVersion,
    endpointPath: descriptor.path,
    upstreamQuery: Object.freeze(upstreamQuery),
    maxPageSize: normalizedMaxPageSize(maxPageSize),
    fingerprintBody: Object.freeze({
      contractVersion: ECOMMERCE_PRODUCT_SEARCH_CONTRACT_VERSION,
      marketplace,
      query,
      page,
      sort,
      price,
      continuationFingerprint: state?.continuation ? sha256(state.continuation) : null,
    }),
  })
}

export function buildJustOneProductSearchDispatch(body, options) {
  const request = normalizeJustOneProductSearchRequest(body, options)
  return Object.freeze({
    request,
    method: 'GET',
    path: request.endpointPath,
    query: request.upstreamQuery,
  })
}

export function classifyJustOneBusinessCode(code) {
  if (!Number.isInteger(code) || code === 0) return null
  const known = JUSTONE_BUSINESS_CODES[code]
  return Object.freeze({
    businessCode: code,
    category: known?.category || 'unknown',
    errorCode: known?.errorCode || 'upstream_business_error',
    // A paid upstream call may already have run. The adapter never turns the
    // provider's "retry" wording into an automatic redispatch decision.
    retryable: false,
  })
}

export function inspectJustOneEnvelope(payload) {
  if (
    !plainObject(payload)
    || !Number.isInteger(payload.code)
    || payload.code < -MAX_POSTGRES_INTEGER - 1
    || payload.code > MAX_POSTGRES_INTEGER
    || !own(payload, 'data')
    || !own(payload, 'message')
    || !own(payload, 'recordTime')
    || (payload.message !== null && typeof payload.message !== 'string')
    || (payload.recordTime !== null && typeof payload.recordTime !== 'string')
    || (own(payload, 'requestId') && typeof payload.requestId !== 'string')
  ) return Object.freeze({ outcome: 'invalid', classification: null })
  if (payload.code === 0) return Object.freeze({ outcome: 'success', classification: null })
  return Object.freeze({
    outcome: 'rejected',
    classification: classifyJustOneBusinessCode(payload.code),
  })
}

function valueAt(root, path) {
  let current = root
  for (const segment of path) {
    if (!plainObject(current) || !own(current, segment)) return undefined
    current = current[segment]
  }
  return current
}

export function extractJustOneProductSearchItems(raw, marketplace) {
  const descriptor = JUSTONE_ENDPOINTS[marketplace]
  if (!descriptor) throw new JustOneResponseContractError('unsupported_marketplace', 'marketplace is not supported')
  const inspected = inspectJustOneEnvelope(raw)
  if (inspected.outcome !== 'success') {
    throw new JustOneResponseContractError(
      inspected.outcome === 'rejected' ? 'upstream_business_error' : 'invalid_upstream_envelope',
      'upstream did not return a valid successful envelope',
    )
  }
  for (const path of descriptor.itemPaths) {
    const items = valueAt(raw, path)
    if (Array.isArray(items)) {
      return Object.freeze({ items, path: Object.freeze([...path]) })
    }
  }
  throw new JustOneResponseContractError('invalid_upstream_items', 'upstream item list is missing')
}

function scalarText(value, maxLength = 4_096) {
  if (value === null || value === undefined) return null
  if (!['string', 'number', 'boolean'].includes(typeof value)) return null
  const text = String(value).normalize('NFKC').trim()
  return text ? text.slice(0, maxLength) : null
}

function firstScalar(object, keys, maxLength) {
  if (!plainObject(object)) return null
  for (const key of keys) {
    if (!own(object, key)) continue
    const value = scalarText(object[key], maxLength)
    if (value !== null) return value
  }
  return null
}

function firstObject(object, keys) {
  if (!plainObject(object)) return null
  for (const key of keys) {
    if (plainObject(object[key])) return object[key]
  }
  return null
}

function safeUrl(value) {
  const text = scalarText(value, 2_048)
  if (!text) return null
  try {
    const url = new URL(text)
    if (!['http:', 'https:'].includes(url.protocol)) return null
    url.username = ''
    url.password = ''
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (privateKey(key)) {
        url.searchParams.delete(key)
      }
    }
    const normalized = url.toString()
    return normalized.length <= 2_048 ? normalized : null
  } catch {
    return null
  }
}

function firstUrl(object, keys) {
  if (!plainObject(object)) return null
  for (const key of keys) {
    if (!own(object, key)) continue
    const url = safeUrl(object[key])
    if (url) return url
  }
  return null
}

function imageUrls(item) {
  const result = []
  const seen = new Set()
  const add = (value) => {
    const candidate = plainObject(value)
      ? firstUrl(value, ['url', 'imageUrl', 'image_url', 'src'])
      : safeUrl(value)
    if (!candidate || seen.has(candidate)) return
    seen.add(candidate)
    result.push(candidate)
  }
  for (const key of ['imageUrls', 'image_urls', 'picUrlList', 'images', 'pics', 'imageList']) {
    const values = item?.[key]
    if (Array.isArray(values)) values.slice(0, 20).forEach(add)
    else if (values !== undefined) add(values)
  }
  for (const key of ['picUrlFull', 'pic_url_full', 'picUrl', 'pic_url', 'imageUrl', 'image_url']) {
    add(item?.[key])
  }
  return result.slice(0, 20)
}

const PRODUCT_ID_FIELDS = Object.freeze({
  taobao: ['itemId', 'item_id', 'productId', 'product_id', 'goodsId', 'goods_id', 'id'],
  tmall: ['itemId', 'item_id', 'productId', 'product_id', 'goodsId', 'goods_id', 'id'],
  jd: ['skuId', 'sku_id', 'itemId', 'item_id', 'wareId', 'ware_id', 'productId', 'id'],
  xiaohongshu_ec: ['goodsId', 'goods_id', 'productId', 'product_id', 'itemId', 'id'],
  xianyu: ['itemId', 'item_id', 'productId', 'product_id', 'goodsId', 'goods_id', 'id'],
})

export function normalizeJustOneProductItem(rawItem, marketplace) {
  if (!plainObject(rawItem) || !JUSTONE_ENDPOINTS[marketplace]) return null
  const id = firstScalar(rawItem, PRODUCT_ID_FIELDS[marketplace], 256)
  if (!id) return null
  const shopObject = firstObject(rawItem, ['shop', 'seller', 'merchant'])
  const priceObject = firstObject(rawItem, ['priceInfo', 'price_info', 'pricing'])
  const shopId = firstScalar(rawItem, ['shopId', 'shop_id', 'sellerId', 'seller_id', 'userId', 'user_id'], 256)
    || firstScalar(shopObject, ['id', 'shopId', 'sellerId', 'userId'], 256)
  const shopName = firstScalar(rawItem, ['shopName', 'shop_name', 'sellerName', 'seller_name'], 512)
    || firstScalar(shopObject, ['name', 'shopName', 'sellerName'], 512)
  const currentPrice = firstScalar(rawItem, [
    'discntPriceYuan', 'discountPrice', 'currentPrice', 'salePrice', 'priceZKYuanDouble', 'price',
  ], 128) || firstScalar(priceObject, ['current', 'sale', 'amount', 'price'], 128)
  const originalPrice = firstScalar(rawItem, [
    'priceYuan', 'price_yuan', 'priceYuanDouble', 'originPrice', 'originalPrice', 'listPrice',
  ], 128) || firstScalar(priceObject, ['original', 'list', 'originalPrice'], 128)

  return Object.freeze({
    id,
    marketplace,
    title: firstScalar(rawItem, ['itemName', 'item_name', 'title', 'name', 'productName'], 4_096),
    url: firstUrl(rawItem, ['url', 'itemUrl', 'item_url', 'detailUrl', 'detail_url', 'auctionUrl']),
    pricing: Object.freeze({
      current: currentPrice,
      original: originalPrice,
      currency: firstScalar(rawItem, ['currency', 'currencyCode'], 16) || 'CNY',
    }),
    shop: Object.freeze({ id: shopId, name: shopName }),
    images: Object.freeze(imageUrls(rawItem)),
    signals: Object.freeze({
      sales: firstScalar(rawItem, ['orderPayUV', 'sales', 'saleCount', 'soldCount', 'volume'], 128),
      reviewCount: firstScalar(rawItem, ['commentCount', 'comment_count', 'reviewCount'], 128),
      location: firstScalar(rawItem, ['itemLoc', 'item_loc', 'sellerLoc', 'seller_loc', 'location'], 512),
    }),
    attributes: Object.freeze({
      brand: firstScalar(rawItem, ['brand', 'brandName', 'brand_name'], 512),
      category: firstScalar(rawItem, ['category', 'categoryName', 'category_name'], 512),
    }),
  })
}

function explicitBoolean(raw, paths) {
  for (const path of paths) {
    const value = valueAt(raw, path)
    if (typeof value === 'boolean') return value
  }
  return null
}

function explicitContinuation(raw) {
  for (const path of [
    ['data', 'searchId'], ['data', 'search_id'], ['searchId'], ['search_id'],
  ]) {
    const value = scalarText(valueAt(raw, path), 2_048)
    if (value) return value
  }
  return null
}

function capturedAtIso(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now())
  if (Number.isNaN(date.getTime())) {
    throw new JustOneResponseContractError('invalid_captured_at', 'capturedAt must be a valid timestamp')
  }
  return date.toISOString()
}

function encodeNextCursor(request, continuation, encodeCursor) {
  const state = Object.freeze({
    version: 1,
    marketplace: request.marketplace,
    page: request.page + 1,
    scope: request.cursorScope,
    continuation,
  })
  if (typeof encodeCursor !== 'function') {
    throw new JustOneResponseContractError(
      'cursor_codec_required',
      'a trusted cursor encoder is required',
    )
  }
  let encoded
  try {
    encoded = encodeCursor(state)
  } catch {
    throw new JustOneResponseContractError('cursor_encoding_failed', 'next cursor could not be encoded')
  }
  if (typeof encoded !== 'string' || !encoded || encoded.length > MAX_CURSOR_LENGTH) {
    throw new JustOneResponseContractError('cursor_encoding_failed', 'next cursor could not be encoded')
  }
  return encoded
}

const PRIVATE_KEY = /^(?:access[_-]?token|api[_-]?key|auth|authorization|bearer|billing|client[_-]?secret|cookie|credential|credentials|endpoint[_-]?id|jwt|key|password|passwd|provider|provider[_-]?id|provider[_-]?metadata|search[_-]?id|secret|session(?:[_-]?(?:id|key|token))?|sid|sig|sign|signature|set[_-]?cookie|ticket|token|upstream[_-]?url)$/iu

function privateKey(value) {
  const text = String(value)
  if (PRIVATE_KEY.test(text)) return true
  const compact = text.replace(/[^a-z0-9]/giu, '').toLowerCase()
  return /(?:apikey|authorization|cookie|credential|jwt|password|passwd|secret|sessionid|sessionkey|signature|token)$/u.test(compact)
}

function sanitizedString(value, secret) {
  let result = value
  if (secret) result = result.split(secret).join('[REDACTED]')
  result = result.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
  result = result.replace(
    /\b(token|api[_-]?key|session(?:[_-]?id)?|sid|sign(?:ature)?|sig|cookie|secret|password)=([^\s&;,]+)/giu,
    '$1=[REDACTED]',
  )
  if (!/^https?:\/\//iu.test(result)) return result
  try {
    const url = new URL(result)
    url.username = ''
    url.password = ''
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (privateKey(key)) url.searchParams.set(key, '[REDACTED]')
    }
    return url.toString()
  } catch {
    return result
  }
}

function redactPrivateFields(value, secret, depth) {
  if (depth > MAX_JSON_DEPTH) return '[REDACTED_DEPTH]'
  if (typeof value === 'string') return sanitizedString(value, secret)
  if (Array.isArray(value)) return value.map((entry) => redactPrivateFields(entry, secret, depth + 1))
  if (!plainObject(value)) return value
  const entries = []
  for (const [key, nested] of Object.entries(value)) {
    if (privateKey(key)) continue
    entries.push([key, redactPrivateFields(nested, secret, depth + 1)])
  }
  return Object.fromEntries(entries)
}

export function redactJustOnePrivateFields(value, { secret = null } = {}) {
  return redactPrivateFields(value, secret, 0)
}

/**
 * Build the one response-level observation that anchors every paid dispatch,
 * including an empty page or a response the Hub cannot project. Item archives
 * are additional evidence; they are never the only record of the call.
 */
export function createJustOneCallArchiveObject(raw, request, {
  capturedAt,
  httpStatus = null,
  outcome = 'success',
  businessCode = null,
  billed = null,
  errorCode = null,
  bodySha256 = null,
  bodySize = null,
  contentType = null,
  contractState = null,
  secret = null,
} = {}) {
  if (!request || request.contractVersion !== ECOMMERCE_PRODUCT_SEARCH_CONTRACT_VERSION) {
    throw new JustOneResponseContractError('invalid_normalized_request', 'a normalized search request is required')
  }
  const envelope = raw === undefined || raw === null
    ? null
    : redactJustOnePrivateFields(raw, { secret })
  const rawItem = {
    kind: 'provider_call_evidence',
    schemaVersion: 1,
    capturedAt: capturedAtIso(capturedAt),
    request: {
      marketplace: request.marketplace,
      endpointKey: request.endpointKey,
      endpointVersion: request.endpointVersion,
      page: request.page,
      fingerprintSha256: sha256(canonicalJson(request.fingerprintBody)),
    },
    response: {
      outcome,
      httpStatus: Number.isInteger(httpStatus) ? httpStatus : null,
      businessCode: Number.isInteger(businessCode) ? businessCode : null,
      billed: typeof billed === 'boolean' ? billed : null,
      errorCode: scalarText(errorCode, 256),
      requestId: plainObject(envelope) ? scalarText(envelope.requestId, 512) : null,
      recordTime: plainObject(envelope) ? scalarText(envelope.recordTime, 512) : null,
      bodySha256: /^[a-f0-9]{64}$/u.test(bodySha256 || '') ? bodySha256 : null,
      bodySize: Number.isSafeInteger(bodySize)
        && bodySize >= 0
        && bodySize <= MAX_POSTGRES_INTEGER
        ? bodySize
        : null,
      contentType: scalarText(contentType, 256),
      contractState: scalarText(contractState, 128),
      envelope,
    },
  }
  const rawPayloadSha256 = sha256(canonicalJson(rawItem))
  return Object.freeze({
    kind: 'response',
    rawPointer: '$',
    envelopePointer: '$',
    rank: null,
    rawPayloadSha256,
    payloadSha256: rawPayloadSha256,
    bodySize: rawItem.response.bodySize,
    contentType: rawItem.response.contentType,
    contractState: rawItem.response.contractState,
    upstreamRequestId: rawItem.response.requestId,
    upstreamRecordTime: rawItem.response.recordTime,
    rawItem,
    rawPayload: rawItem,
    normalizedItem: null,
  })
}

export function normalizeJustOneProductSearchResponse(raw, request, {
  encodeCursor,
  capturedAt,
  httpStatus = 200,
  bodySha256 = null,
  bodySize = null,
  contentType = null,
  contractState = 'accepted',
  secret = null,
} = {}) {
  if (!request || request.contractVersion !== ECOMMERCE_PRODUCT_SEARCH_CONTRACT_VERSION) {
    throw new JustOneResponseContractError('invalid_normalized_request', 'a normalized search request is required')
  }
  assertBoundedJson(raw)
  const extracted = extractJustOneProductSearchItems(raw, request.marketplace)
  if (extracted.items.length > request.maxPageSize) {
    throw new JustOneResponseContractError('upstream_page_too_large', 'upstream returned too many items')
  }
  const archiveObjects = [createJustOneCallArchiveObject(raw, request, {
    capturedAt,
    httpStatus,
    outcome: 'success',
    businessCode: 0,
    billed: true,
    bodySha256,
    bodySize,
    contentType,
    contractState,
    secret,
  })]
  const items = []
  let discardedCount = 0
  for (const [index, rawItem] of extracted.items.entries()) {
    assertBoundedJson(rawItem)
    const projectedItem = normalizeJustOneProductItem(rawItem, request.marketplace)
    const normalizedItem = projectedItem
      ? redactJustOnePrivateFields(projectedItem, { secret })
      : null
    const archivedRawItem = redactJustOnePrivateFields(rawItem, { secret })
    const rawPayloadSha256 = sha256(canonicalJson(archivedRawItem))
    archiveObjects.push(Object.freeze({
      kind: 'item',
      rawPointer: '$',
      envelopePointer: `$.${extracted.path.join('.')}[${index}]`,
      rank: index + 1,
      rawPayloadSha256,
      payloadSha256: rawPayloadSha256,
      rawItem: archivedRawItem,
      rawPayload: archivedRawItem,
      normalizedItem,
    }))
    if (normalizedItem) items.push(normalizedItem)
    else discardedCount += 1
  }

  const explicitHasMore = explicitBoolean(raw, [
    ['data', 'hasMore'], ['data', 'has_more'],
    ['data', 'page', 'hasMore'], ['data', 'page', 'has_more'],
  ])
  let hasMore = extracted.items.length === 0 ? false : explicitHasMore
  let nextCursor = null
  // The provider's public OpenAPI leaves response data untyped. A non-empty
  // page alone does not prove that another page exists, so Hub issues a
  // continuation only when the pinned response explicitly says hasMore=true.
  if (extracted.items.length > 0 && explicitHasMore === true && request.page < MAX_PAGE) {
    const previousContinuation = request.upstreamQuery.searchId || null
    const continuation = request.marketplace === 'xiaohongshu_ec'
      ? previousContinuation || explicitContinuation(raw)
      : null
    if (request.marketplace === 'xiaohongshu_ec' && !continuation) {
      if (explicitHasMore === true) {
        throw new JustOneResponseContractError(
          'missing_upstream_continuation',
          'upstream marked the page as incomplete without a continuation',
        )
      }
    } else {
      nextCursor = encodeNextCursor(request, continuation, encodeCursor)
    }
  }
  if (!nextCursor && hasMore === true) hasMore = null

  const publicBody = Object.freeze({
    contractVersion: ECOMMERCE_PRODUCT_SEARCH_CONTRACT_VERSION,
    data: Object.freeze({
      items: Object.freeze(items),
      page: Object.freeze({
        page: request.page,
        returnedCount: items.length,
        discardedCount,
        hasMore,
        nextCursor,
      }),
    }),
    meta: Object.freeze({ capturedAt: capturedAtIso(capturedAt) }),
  })

  return Object.freeze({
    publicBody,
    items: publicBody.data.items,
    archiveObjects: Object.freeze(archiveObjects),
    page: publicBody.data.page,
    upstreamEvidence: Object.freeze({
      requestId: archiveObjects[0].upstreamRequestId,
      recordTime: archiveObjects[0].upstreamRecordTime,
    }),
  })
}
