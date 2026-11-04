import snapshot from '../data/night-all-provider-inventory.json' with { type: 'json' }
import official from '../data/provider-official-contracts.json' with { type: 'json' }
import wechat from '../data/wechat-contracts.json' with { type: 'json' }
import { AppError } from '../core/errors.mjs'

export const NATIVE_FORWARDING_VERSION = 'mx-insight-hub.native-forwarding.v1'
const PRIVATE_PARAMS = new Set(['cookie', 'token', 'api_key', 'authorization', 'password', 'proxy'])
const FAMILY = { tikhub: 't', justone: 'j' }

// Only this reviewed, code-owned list can dispatch. The catalog/database may
// describe more candidates but can never turn a user-supplied URL into a route.
const legacyEndpoints = snapshot.endpoints
  .filter(row => row.forwarding === 'implemented_disabled')
  .map(row => {
    const key = `${FAMILY[row.provider]}.${row.id.replace(/^(tikhub|justone)_/, '')}`
    const documented = official.endpoints.find(item => item.provider === row.provider && item.method === row.method && item.path === row.path)
    // This released key shadows the newer official entry for the same route.
    // Restore its documented types/defaults without changing its legacy version,
    // scalar coercion or omitted-default fingerprint (including historical replay).
    const parameters = key === 't.instagram_v3_general_search' ? documented.parameters : row.parameters
    return Object.freeze({ ...row, key,
      platformLabel: documented?.platformLabel || row.platform, summary: documented?.summary || row.id,
      operation: `native.${key}`, endpointKey: `native.${key}`,
      hubPath: `/api/v1/data/native/${key}`,
      authorizationPlatform: row.platform === 'xianyu' ? 'ecommerce' : 'social',
      parameters: Object.freeze(parameters.filter(p => !PRIVATE_PARAMS.has(p.name)).map(p => Object.freeze({ ...p }))),
      fixedQuery: Object.freeze({ ...row.fixedQuery }),
    })
  })
const legacyPaths = new Set(legacyEndpoints.map(row => `${row.provider}:${row.method}:${row.path}`))
// The retained OpenAPI uses a $ref for CommentSortByAPI. Resolve this one
// reviewed scalar enum without changing the immutable imported snapshot.
const youtubeComments = official.endpoints.find(row => row.key === 't.api_4a6f21264dc0b4a1')
const youtubeCommentEndpoints = [Object.freeze({
  ...youtubeComments, id: youtubeComments.key, status: 'fixed_read_contract', reason: null,
  operation: `native.${youtubeComments.key}`, endpointKey: `native.${youtubeComments.key}`,
  hubPath: `/api/v1/data/native/${youtubeComments.key}`, schemaVersion: 'youtube-comments.2026-10-17',
  parameters: Object.freeze(youtubeComments.parameters.map(parameter => Object.freeze(parameter.name === 'sort_by'
    ? { ...parameter, type: 'string', enum: ['top', 'newest'] } : { ...parameter }))),
  fixedQuery: Object.freeze({}),
})]
// Keep the released social keys/scopes intact. Ecommerce gets independently
// granted operations over the same reviewed read contracts, not a product search.
const kuaishouCommerce = [
  ['t.kuaishou_ecommerce_shopping_top_list', 't.api_382901fb0fa68660'],
  ['t.kuaishou_ecommerce_brand_top_list', 't.api_fb5e49d31884ca14'],
].map(([key, originalKey]) => {
  const row = official.endpoints.find(item => item.key === originalKey)
  return Object.freeze({ ...row, key, id: key, platform: 'kuaishou_ec', platformLabel: '快手电商',
    authorizationPlatform: 'ecommerce', operation: `native.${key}`, endpointKey: `native.${key}`,
    hubPath: `/api/v1/data/native/${key}`, schemaVersion: 'hub-kuaishou-ecommerce.2026-10-13',
    parameters: Object.freeze(row.parameters.map(p => Object.freeze({ ...p,
      description: p.name === 'subTabId' ? '榜单子分类 ID，默认 0；不是页码，不支持自动翻页。'
        : p.name === 'subTabName' ? '榜单子分类名称，可留空；不是关键词或分页游标。' : p.description,
    }))), fixedQuery: Object.freeze({}),
  })
})
// TikHub's other commerce reads (2026-10-29 OpenAPI V5.3.2 has no Taobao, JD,
// Tmall or Xianyu). Same rule as Kuaishou: new ecommerce-scoped keys over the
// already reviewed read contracts; the social keys, grants and prices stay.
const TIKHUB_COMMERCE_ALIASES = Object.freeze([
  ['xiaohongshu_ec', '小红书电商', [
    ['t.xiaohongshu_ec_search_products', 't.api_6f94aeb043a45013'],
    ['t.xiaohongshu_ec_product_detail', 't.api_af8592c796087346'],
    ['t.xiaohongshu_ec_product_review_overview', 't.api_094a374db42d0d6e'],
    ['t.xiaohongshu_ec_product_reviews', 't.api_2bcbeedf12b6a511'],
    ['t.xiaohongshu_ec_product_recommendations', 't.api_05c818595f2578af'],
  ]],
  ['tiktok_shop', 'TikTok Shop', [
    ['t.tiktok_shop_search_products', 't.api_d9f21025fdc4aaad'],
    ['t.tiktok_shop_search_products_v2', 't.api_dc9d749b6b66360b'],
    ['t.tiktok_shop_search_word_suggestion', 't.api_f70db008db416d87'],
    ['t.tiktok_shop_product_detail', 't.api_9e361a984b57a2a1'],
    ['t.tiktok_shop_product_detail_v3', 't.api_8bc9561699d87cec'],
    ['t.tiktok_shop_product_reviews', 't.api_6c735bdf2e48045a'],
    ['t.tiktok_shop_seller_products', 't.api_0b679af92c244956'],
    ['t.tiktok_shop_seller_products_v2', 't.api_8d3145b11e1127a3'],
    ['t.tiktok_shop_category_list', 't.api_6b8b34bad569c539'],
    ['t.tiktok_shop_products_by_category', 't.api_2ef92f3592ed7819'],
    ['t.tiktok_shop_product_id_by_share_link', 't.api_d6392378dc0f5c0e'],
    ['t.tiktok_shop_shop_id_by_share_link', 't.api_14c36e00ad5bf081'],
  ]],
])
const tikHubCommerce = TIKHUB_COMMERCE_ALIASES.flatMap(([platform, platformLabel, rows]) => rows.map(([key, originalKey]) => {
  const row = official.endpoints.find(item => item.key === originalKey && item.status === 'fixed_read_contract')
  if (!row) throw new Error(`Reviewed TikHub contract ${originalKey} is missing`)
  return Object.freeze({ ...row, key, id: key, platform, platformLabel,
    authorizationPlatform: 'ecommerce', operation: `native.${key}`, endpointKey: `native.${key}`,
    hubPath: `/api/v1/data/native/${key}`, schemaVersion: 'hub-tikhub-ecommerce.2026-10-29',
    parameters: Object.freeze(row.parameters.map(p => Object.freeze({ ...p }))), fixedQuery: Object.freeze({}),
  })
}))
export const TIKHUB_COMMERCE_OPERATIONS = Object.freeze(tikHubCommerce.map(row => row.operation))
export const NATIVE_FORWARDING_ENDPOINTS = Object.freeze([...legacyEndpoints,
  ...youtubeCommentEndpoints,
  ...kuaishouCommerce,
  ...tikHubCommerce,
  ...wechat.endpoints.map(row => Object.freeze({ ...row, operation: `native.${row.key}`, endpointKey: `native.${row.key}` })),
  ...official.endpoints.filter(row => row.status === 'fixed_read_contract' && !legacyPaths.has(`${row.provider}:${row.method}:${row.path}`))
    .map(row => Object.freeze({ ...row, id: row.key, operation: `native.${row.key}`, endpointKey: `native.${row.key}`,
      hubPath: `/api/v1/data/native/${row.key}`, schemaVersion: official.version,
      parameters: Object.freeze(row.parameters.map(p => Object.freeze({...p}))), fixedQuery: Object.freeze({}),
    })),
])
const byKey = new Map(NATIVE_FORWARDING_ENDPOINTS.map(row => [row.key, row]))
const byPath = new Map(NATIVE_FORWARDING_ENDPOINTS.map(row => [row.hubPath, row]))
export const nativeForwardingEndpoint = key => byKey.get(key) || null
export const nativeForwardingByPath = path => byPath.get(path) || null

export function nativeForwardingOperations(provider) {
  return NATIVE_FORWARDING_ENDPOINTS.filter(row => row.provider === provider).map(row => ({
    operationKey: row.operation, label: `${row.platformLabel || row.platform} · ${row.summary || row.key}`,
    legacyGate: 'nativeForwardingVerified', contractVersion: NATIVE_FORWARDING_VERSION,
    endpointKeys: [row.endpointKey],
    ...(row.allowZeroCost ? { allowZeroCost: true } : {}),
  }))
}

export function normalizeNativeForwardingRequest(key, body, { maxPageSize = 100 } = {}) {
  const endpoint = byKey.get(key)
  if (!endpoint) throw new AppError(404, 'native_endpoint_not_found', 'Unknown native data endpoint')
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(name => !['params', 'deliveryMode'].includes(name))
    || !body.params || typeof body.params !== 'object' || Array.isArray(body.params)) {
    throw new AppError(400, 'invalid_native_request', 'Submit an object with params and optional deliveryMode')
  }
  if (body.deliveryMode !== undefined && body.deliveryMode !== 'live_only') {
    throw new AppError(400, 'invalid_delivery_mode', 'Native forwarding supports live_only')
  }
  const allowed = new Set(endpoint.parameters.map(p => p.name))
  if (key.startsWith('wechat.search.')) {
    if (typeof body.params.cursor === 'string' && body.params.cursor.trim().startsWith('mxnc1.')) {
      throw new AppError(400, 'wechat_legacy_cursor_retired', 'This legacy cursor cannot be used by the new WeChat API; explicitly restart from the first page with a new Idempotency-Key')
    }
    if (body.params.offset > 0 && !body.params.cursor) {
      throw new AppError(400, 'invalid_cursor', 'WeChat continuation requires the response cursor; offset alone cannot advance a page')
    }
  }
  if (Object.keys(body.params).some(name => !allowed.has(name))) {
    throw new AppError(400, 'unsupported_request_field', 'params contains an undeclared field')
  }
  const query = { ...endpoint.fixedQuery }
  for (const p of endpoint.parameters) {
    const value = body.params[p.name] === undefined ? (endpoint.schemaVersion && !p.required ? p.default : undefined) : body.params[p.name]
    if (value === undefined) {
      if (p.required) throw new AppError(400, 'missing_parameter', `${p.name} is required`)
      continue
    }
    // Existing v1 contracts retain their scalar coercion. New official contracts
    // validate their declared types/enums before a billable dispatch.
    if (endpoint.schemaVersion) {
      if (!matchesScalarSchema(value, p)) {
        throw new AppError(400, 'invalid_parameter', `${p.name} does not match the declared parameter contract`)
      }
    }
    if (value === null && p.anyOf?.some(schema => schema.type === 'null')) { query[p.name] = null; continue }
    if (!['string', 'number', 'boolean'].includes(typeof value)
      || (typeof value === 'number' && !Number.isFinite(value))
      || (typeof value === 'string' && (value.length > 8192 || value.includes('\u0000') || (p.required && !value.trim())))) {
      throw new AppError(400, 'invalid_parameter', `${p.name} must be a bounded scalar`)
    }
    if (['count', 'limit', 'page_size', 'first', 'last'].includes(p.name)
      && (typeof value === 'boolean' || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > maxPageSize)) {
      throw new AppError(400, 'invalid_page_size', `${p.name} must be between 1 and ${maxPageSize}`)
    }
    query[p.name] = value
  }
  if (key === 'wechat.channels.video-detail' && !['object_id', 'export_id', 'share_url'].some(name => query[name])) {
    throw new AppError(400, 'missing_parameter', 'Provide object_id, export_id or share_url')
  }
  return Object.freeze({
    key, maxPageSize, contractVersion: NATIVE_FORWARDING_VERSION, endpointContractVersion: NATIVE_FORWARDING_VERSION,
    operation: endpoint.operation, endpointKey: endpoint.endpointKey, endpointVersion: endpoint.schemaVersion || snapshot.version,
    endpointPath: endpoint.path, method: endpoint.method, marketplace: endpoint.platform,
    deliveryMode: 'live_only', upstreamQuery: Object.freeze(query),
    fingerprintBody: { contractVersion: NATIVE_FORWARDING_VERSION, key, params: query, deliveryMode: 'live_only' },
  })
}

function matchesScalarSchema(value, schema) {
  if (schema.enum && !schema.enum.includes(value)) return false
  if (schema.anyOf) return schema.anyOf.some(variant => matchesScalarSchema(value, variant))
  const validType = schema.type === 'null' ? value === null : schema.type === 'integer' ? Number.isSafeInteger(value)
    : schema.type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === schema.type
  return validType && (!schema.enum || schema.enum.includes(value))
    && !(schema.minimum != null && value < schema.minimum || schema.maximum != null && value > schema.maximum)
    && !(typeof value === 'string' && (schema.minLength != null && value.length < schema.minLength || schema.maxLength != null && value.length > schema.maxLength || schema.pattern && !new RegExp(schema.pattern).test(value)))
}

export function nativeForwardingPayload(data, request, capturedAt) {
  return { contractVersion: NATIVE_FORWARDING_VERSION, endpoint: request.key, data,
    meta: { capturedAt: new Date(capturedAt).toISOString(), projection: 'native', pagination: 'explicit_parameters' } }
}
