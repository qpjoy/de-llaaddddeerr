import { createHash } from 'node:crypto'
import {
  createCredentialEchoRedactor,
  redactCredentialEcho,
} from '../core/credential-redaction.mjs'
import { isPostgresSafeJsonValue } from '../core/postgres-json.mjs'

export const JUSTONE_PROVIDER_KEY = 'justone'
export const JUSTONE_OPERATION = 'ecommerce.products.search'
// Unchanged endpoint descriptors stay on this baseline. Quarantine revisions
// are endpoint-scoped so fixing one marketplace cannot unlock another.
export const JUSTONE_CONTRACT_VERSION = 'justone.product-search.v1'
export const ECOMMERCE_PRODUCT_SEARCH_CONTRACT_VERSION = 'mx-insight-hub.ecommerce-products.v1'
// `live_only` is the counterpart of `cache_only`: it never serves stored data.
// `refresh` still falls back to an exact snapshot when acquisition fails, which
// is the right default for a data product but wrong for a caller composing its
// own product, who needs to know that it did not get a fresh read.
export const ECOMMERCE_DELIVERY_MODES = Object.freeze([
  'cache_only', 'cache_first', 'refresh', 'live_only',
])

export const JUSTONE_TAOBAO_TMALL_CONTRACT_VERSION = 'justone.product-search.v2'
// Hub request contracts whose dispatches produce provider-call evidence. Kept
// here rather than imported to avoid a cycle with the resource registry.
const JUSTONE_EVIDENCE_CONTRACT_VERSIONS = new Set([
  ECOMMERCE_PRODUCT_SEARCH_CONTRACT_VERSION,
  'mx-insight-hub.ecommerce-resource.v1',
  'mx-insight-hub.social-accounts.v1',
])

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

// Pagination evidence is endpoint-scoped on purpose: one marketplace's counter
// shape must never be read out of another marketplace's response. Each entry
// names the exact reviewed location of the upstream page counters, so adding a
// marketplace is a fixture plus one descriptor, not a change to the extractor.
function pageCounters({ path, currentKey, totalPagesKey }) {
  return Object.freeze({
    path: Object.freeze([...path]),
    currentKey,
    totalPagesKey,
  })
}

function endpoint({
  endpointKey,
  path,
  itemPaths,
  contractVersion = JUSTONE_CONTRACT_VERSION,
  sortMap = null,
  tmall = false,
  pagination = null,
  projectItem = null,
}) {
  return Object.freeze({
    endpointKey,
    endpointVersion: 'v1',
    contractVersion,
    method: 'GET',
    path,
    itemPaths: Object.freeze(itemPaths.map((segments) => Object.freeze([...segments]))),
    sortMap,
    tmall,
    pagination,
    // Most marketplaces return a flat product object and need none of this.
    // One returns a render tree, where the product's fields are several levels
    // down and prices arrive as styled text runs, so it declares how to reach a
    // flat item before the shared field mapping runs.
    projectItem,
  })
}

// Xianyu answers a search with a render tree rather than a product list: the
// element is a view node, and the product's own fields sit at
// `data.item.main`, with most of them under `exContent` and the detail link one
// level above it. Reviewed against a live response on 2026-09-12.
//
// Prices there are styled text runs -- an array of segments carrying `text`
// alongside font and colour -- rather than numbers, because the payload
// describes how to draw the price, not what it is. The amount is recovered by
// joining the segments in order and taking the first numeric run, which is
// deliberately indifferent to how the vendor splits them: "¥" + "1999",
// "1999" + ".00" and "¥1999" + "起" all yield the same answer.
function xianyuPriceAmount(value) {
  if (value === null || value === undefined) return null
  const joined = Array.isArray(value)
    ? value
        .map((segment) => (plainObject(segment) ? segment.text : segment))
        .filter((text) => typeof text === 'string' || typeof text === 'number')
        .join('')
    : String(value)
  const amount = /\d+(?:\.\d+)?/u.exec(joined)
  return amount ? amount[0] : null
}

function projectXianyuItem(element) {
  const main = valueAt(element, ['data', 'item', 'main'])
  if (!plainObject(main)) return null
  const exContent = plainObject(main.exContent) ? main.exContent : {}
  return {
    // Everything the shared mapping already understands by name -- itemId,
    // title, picUrl -- passes straight through.
    ...exContent,
    // And the rest is renamed to the vocabulary that mapping expects, rather
    // than widening every marketplace's field list with Xianyu's spellings.
    price: xianyuPriceAmount(exContent.price),
    originPrice: xianyuPriceAmount(exContent.oriPrice),
    itemUrl: main.targetUrl,
    itemLoc: exContent.area,
    sellerName: exContent.userNickName,
    // `want` is a wishlist count, not a sales count, so it is deliberately not
    // mapped onto `sales`: a number under the wrong name is worse than none.
  }
}

// `data` is intentionally untyped in the upstream OpenAPI documents. These
// paths are the small set of fixture shapes the Hub accepts. A new upstream
// shape must arrive with a reviewed fixture and an explicit addition here.
export const JUSTONE_ENDPOINTS = Object.freeze({
  taobao: endpoint({
    endpointKey: 'taobao-tmall.product-search.v1',
    path: '/api/taobao/search-item-list/v1',
    itemPaths: [['data', 'model', 'itemList'], ['data', 'items'], ['data', 'itemList']],
    contractVersion: JUSTONE_TAOBAO_TMALL_CONTRACT_VERSION,
    sortMap: TAOBAO_SORTS,
    pagination: pageCounters({ path: ['data', 'model', 'page'], currentKey: 'pageNo', totalPagesKey: 'totalPages' }),
  }),
  tmall: endpoint({
    endpointKey: 'taobao-tmall.product-search.v1',
    path: '/api/taobao/search-item-list/v1',
    itemPaths: [['data', 'model', 'itemList'], ['data', 'items'], ['data', 'itemList']],
    contractVersion: JUSTONE_TAOBAO_TMALL_CONTRACT_VERSION,
    sortMap: TAOBAO_SORTS,
    tmall: true,
    pagination: pageCounters({ path: ['data', 'model', 'page'], currentKey: 'pageNo', totalPagesKey: 'totalPages' }),
  }),
  jd: endpoint({
    endpointKey: 'jd.product-search.v1',
    path: '/api/jd/search-item-list/v1',
    itemPaths: [['data', 'items'], ['data', 'list'], ['data', 'products']],
    // Reviewed against tests/fixtures/justone/jd-product-search-v1.success.json,
    // whose envelope carries data.currentPage/data.totalPages alongside the items.
    pagination: pageCounters({ path: ['data'], currentKey: 'currentPage', totalPagesKey: 'totalPages' }),
  }),
  xiaohongshu_ec: endpoint({
    endpointKey: 'xiaohongshu-ec.product-search.v1',
    path: '/api/xiaohongshu-ec/search-products/v1',
    itemPaths: [['data', 'items'], ['data', 'products']],
  }),
  xianyu: endpoint({
    endpointKey: 'xianyu.product-search.v1',
    path: '/api/xianyu/search-item-list/v1',
    // Reviewed against tests/fixtures/justone/xianyu-product-search-v1.success.json,
    // captured from a live response on 2026-09-12.
    itemPaths: [['data', 'resultList']],
    projectItem: projectXianyuItem,
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

// The provider's OpenAPI enum is wider than its documented table: it also lists
// 101, 202, 300, 404 and 503. None of those is classified here.
//
// 202 in particular has two conflicting in-house readings -- one internal
// collector treats it as "this item does not support this endpoint", another
// integration document as "token invalid" -- and the provider's own usage guide
// documents neither, while attributing "token invalid" to 100. Guessing between
// those would send triage in opposite directions, so an unattested code stays
// `unknown`, which is already never auto-retried. Classify one only when the
// provider states its meaning.

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

export function assertBoundedJson(value, depth = 0, state = { nodes: 0 }) {
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

function normalizedDeliveryMode(value) {
  if (value === undefined || value === null || value === '') return 'cache_first'
  if (typeof value !== 'string' || !ECOMMERCE_DELIVERY_MODES.includes(value)) {
    throw new JustOneContractError(
      'invalid_delivery_mode',
      `deliveryMode must be one of ${ECOMMERCE_DELIVERY_MODES.join(', ')}`,
    )
  }
  return value
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
  const allowed = new Set(['marketplace', 'query', 'page', 'cursor', 'sort', 'price', 'deliveryMode'])
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
  const deliveryMode = normalizedDeliveryMode(body.deliveryMode)
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
    deliveryMode,
    page,
    sort,
    price,
    cursor,
    cursorScope: scope,
    endpointKey: descriptor.endpointKey,
    endpointVersion: descriptor.endpointVersion,
    endpointContractVersion: descriptor.contractVersion,
    endpointPath: descriptor.path,
    upstreamQuery: Object.freeze(upstreamQuery),
    maxPageSize: normalizedMaxPageSize(maxPageSize),
    fingerprintBody: Object.freeze({
      // Delivery mode controls whether Hub may refresh this data; it does not
      // change the logical query/snapshot identity. Idempotent replay always
      // wins over a later attempt to change this preference with the same key.
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

// A keys-and-types outline of a response, for diagnosing a shape the contract
// does not yet accept.
//
// Six levels because the deepest accepted shape today is data.model.itemList[],
// and the item's own field names are the point: they are what a reviewed
// fixture has to reproduce.
//
// Values are never included. The point is to learn where an item array lives
// so a reviewed fixture and an explicit path can be added, and that question is
// answered entirely by structure -- while the values would be product data, and
// on some marketplaces personal data.
export function describeResponseShape(value, { depth = 6 } = {}) {
  if (Array.isArray(value)) {
    return depth <= 0 ? `array[${value.length}]` : {
      __array: value.length,
      __item: value.length > 0 ? describeResponseShape(value[0], { depth: depth - 1 }) : null,
    }
  }
  if (value === null) return 'null'
  if (typeof value !== 'object') return typeof value
  if (depth <= 0) return 'object'
  const shape = {}
  // Bounded so a wide response cannot produce an unbounded log line.
  for (const key of Object.keys(value).slice(0, 40)) {
    shape[key] = describeResponseShape(value[key], { depth: depth - 1 })
  }
  return shape
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
  // The declared paths are deliberately a closed set: a new upstream shape is
  // supposed to arrive with a reviewed fixture rather than be guessed at here.
  // That policy is only followable if the shape can be seen, so the outline
  // travels with the error for the dispatcher to log.
  const error = new JustOneResponseContractError(
    'invalid_upstream_items',
    'upstream item list is missing',
  )
  error.observedShape = describeResponseShape(raw)
  error.triedPaths = descriptor.itemPaths.map((path) => path.join('.'))
  throw error
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

function safeUrl(value, secret = null) {
  if (typeof value !== 'string' || !value || value.length > 2_048) return null
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return null
    if (url.toString().length > 2_048) return null
    // Signed query parameters and fragments are provider business data. Keep
    // the URL byte-for-byte unless it actually echoes the credential used by
    // this Hub request; field names such as signature/token are not secrets by
    // themselves.
    return redactCredentialEcho(value, secret)
  } catch {
    return null
  }
}

function firstUrl(object, keys, secret = null) {
  if (!plainObject(object)) return null
  for (const key of keys) {
    if (!own(object, key)) continue
    const url = safeUrl(object[key], secret)
    if (url) return url
  }
  return null
}

function imageUrls(item, secret = null) {
  const result = []
  const seen = new Set()
  const add = (value) => {
    const candidate = plainObject(value)
      ? firstUrl(value, ['url', 'imageUrl', 'image_url', 'src'], secret)
      : safeUrl(value, secret)
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

export function normalizeJustOneProductItem(rawItem, marketplace, { secret = null } = {}) {
  const descriptor = JUSTONE_ENDPOINTS[marketplace]
  if (!plainObject(rawItem) || !descriptor) return null
  // A marketplace that returns a render tree flattens it here first. The
  // original element is what gets archived as evidence; only the normalized
  // product is projected.
  const item = descriptor.projectItem ? descriptor.projectItem(rawItem) : rawItem
  if (!plainObject(item)) return null
  const id = firstScalar(item, PRODUCT_ID_FIELDS[marketplace], 256)
  if (!id) return null
  const shopObject = firstObject(item, ['shop', 'seller', 'merchant'])
  const priceObject = firstObject(item, ['priceInfo', 'price_info', 'pricing'])
  const shopId = firstScalar(item, ['shopId', 'shop_id', 'sellerId', 'seller_id', 'userId', 'user_id'], 256)
    || firstScalar(shopObject, ['id', 'shopId', 'sellerId', 'userId'], 256)
  const shopName = firstScalar(item, ['shopName', 'shop_name', 'sellerName', 'seller_name'], 512)
    || firstScalar(shopObject, ['name', 'shopName', 'sellerName'], 512)
  const currentPrice = firstScalar(item, [
    'discntPriceYuan', 'discountPrice', 'currentPrice', 'salePrice', 'priceZKYuanDouble', 'price',
  ], 128) || firstScalar(priceObject, ['current', 'sale', 'amount', 'price'], 128)
  const originalPrice = firstScalar(item, [
    'priceYuan', 'price_yuan', 'priceYuanDouble', 'originPrice', 'originalPrice', 'listPrice',
  ], 128) || firstScalar(priceObject, ['original', 'list', 'originalPrice'], 128)

  return Object.freeze({
    id,
    marketplace,
    title: firstScalar(item, ['itemName', 'item_name', 'title', 'name', 'productName'], 4_096),
    url: firstUrl(
      item,
      ['url', 'itemUrl', 'item_url', 'detailUrl', 'detail_url', 'auctionUrl'],
      secret,
    ),
    pricing: Object.freeze({
      current: currentPrice,
      original: originalPrice,
      currency: firstScalar(item, ['currency', 'currencyCode'], 16) || 'CNY',
    }),
    shop: Object.freeze({ id: shopId, name: shopName }),
    images: Object.freeze(imageUrls(item, secret)),
    signals: Object.freeze({
      sales: firstScalar(item, ['orderPayUV', 'sales', 'saleCount', 'soldCount', 'volume'], 128),
      reviewCount: firstScalar(item, ['commentCount', 'comment_count', 'reviewCount'], 128),
      location: firstScalar(item, ['itemLoc', 'item_loc', 'sellerLoc', 'seller_loc', 'location'], 512),
    }),
    attributes: Object.freeze({
      brand: firstScalar(item, ['brand', 'brandName', 'brand_name'], 512),
      category: firstScalar(item, ['category', 'categoryName', 'category_name'], 512),
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

// Only the descriptor pinned to this exact marketplace may supply counters, so
// a shape borrowed from another marketplace's envelope can never issue a cursor.
// A missing or self-inconsistent counter block stays null ("upstream did not
// say"), which is deliberately different from false ("upstream said no more").
function explicitPageHasMore(raw, request) {
  const descriptor = JUSTONE_ENDPOINTS[request.marketplace]?.pagination
  if (!descriptor) return null
  const counters = valueAt(raw, descriptor.path)
  if (!plainObject(counters)) return null
  const current = counters[descriptor.currentKey]
  const totalPages = counters[descriptor.totalPagesKey]
  if (
    !Number.isInteger(current)
    || !Number.isInteger(totalPages)
    || current < 1
    || totalPages < 1
    || current > totalPages
    || current !== request.page
  ) return null
  return current < totalPages
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

export function redactJustOnePrivateFields(value, { secret = null } = {}) {
  if (!isPostgresSafeJsonValue(value)) return null
  let cloned
  try {
    cloned = structuredClone(value)
  } catch {
    // Never retain an unredacted operational projection when cloning a deeply
    // nested provider payload is unsafe. The adapter separately preserves the
    // exact bounded response bytes in restricted storage.
    return null
  }
  if (typeof secret !== 'string' || !secret) return cloned
  const scrub = createCredentialEchoRedactor(secret)
  if (typeof cloned === 'string') return scrub(cloned)
  if (!cloned || typeof cloned !== 'object') return cloned

  // Iterate instead of recursing so a deeply nested but byte-bounded provider
  // response cannot exhaust the JavaScript stack. No business key is removed:
  // only the exact request credential is replaced wherever it was echoed.
  const pending = [cloned]
  while (pending.length > 0) {
    const current = pending.pop()
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        const nested = current[index]
        if (typeof nested === 'string') current[index] = scrub(nested)
        else if (nested && typeof nested === 'object') pending.push(nested)
      }
      continue
    }
    for (const [key, nested] of Object.entries(current)) {
      const safeKey = scrub(key)
      if (safeKey !== key) {
        delete current[key]
        current[safeKey] = nested
      }
      if (typeof nested === 'string') current[safeKey] = scrub(nested)
      else if (nested && typeof nested === 'object') pending.push(nested)
    }
  }
  return cloned
}

function responseBusinessContext(raw, itemPath, secret) {
  const context = redactJustOnePrivateFields(raw, { secret })
  let parent = context
  for (const segment of itemPath.slice(0, -1)) parent = parent?.[segment]
  const itemKey = itemPath.at(-1)
  if (plainObject(parent) && Array.isArray(parent[itemKey])) {
    // Each item is preserved separately in sourceItem. Avoid copying the whole
    // result set into every canonical record while retaining all call-level
    // business fields, including pagination and session identifiers.
    parent[itemKey] = []
  }
  return context
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
  // Provider-call evidence is contract-agnostic: search and the platform-shaped
  // resources both produce one call record per dispatch, and losing that record
  // for resources would leave paid calls without an audit trail.
  if (!request || !JUSTONE_EVIDENCE_CONTRACT_VERSIONS.has(request.contractVersion)) {
    throw new JustOneResponseContractError('invalid_normalized_request', 'a normalized Hub request is required')
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
  const businessContext = responseBusinessContext(raw, extracted.path, secret)
  const items = []
  let discardedCount = 0
  for (const [index, rawItem] of extracted.items.entries()) {
    assertBoundedJson(rawItem)
    const projectedItem = normalizeJustOneProductItem(rawItem, request.marketplace, { secret })
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
      responseBusinessContext: businessContext,
    }))
    if (normalizedItem) items.push(normalizedItem)
    else discardedCount += 1
  }

  const explicitHasMore = explicitBoolean(raw, [
    ['data', 'hasMore'], ['data', 'has_more'],
    ['data', 'page', 'hasMore'], ['data', 'page', 'has_more'],
  ]) ?? explicitPageHasMore(raw, request)
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
