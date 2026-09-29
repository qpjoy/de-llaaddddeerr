import { AppError } from '../core/errors.mjs'
import { nativeForwardingEndpoint, normalizeNativeForwardingRequest } from './native-forwarding.mjs'

export const WECHAT_SEARCH_KEY = 'wechat.search.search'
export const WECHAT_SEARCH_OPERATION = `native.${WECHAT_SEARCH_KEY}`
export const WECHAT_SEARCH_PATH = '/api/v1/data/wechat/search/search'
export const WECHAT_LEGACY_SEARCH_PLATFORMS = ['wechat_search', 'wechat_mp']

export function wechatSearchPlatform(value) {
  if (typeof value !== 'string') return null
  const platform = value.trim().toLowerCase()
  if (['wechat', 'weixin', 'wechat_search'].includes(platform)) return 'wechat_search'
  return platform === 'wechat_mp' ? platform : null
}

export function assertWechatSearchNotRetired(operation, body) {
  if (operation === 'raw' && wechatSearchPlatform(body?.platform)) {
    throw new AppError(410, 'wechat_search_route_retired', 'WeChat search has moved to the Hub data API', {
      replacement: WECHAT_SEARCH_PATH, alias: '/api/v1/search/raw',
    })
  }
}

export function normalizeWechatDataSearch(body) {
  const { type, ...input } = body
  if (type !== undefined && !['fresh', 'stable'].includes(type)) {
    throw new AppError(400, 'invalid_result_type', "type must be 'fresh' or 'stable'")
  }
  // Both historical replay hints now use the native contract's durable replay.
  // A new live acquisition always requires an explicit new Idempotency-Key.
  return normalizeWechatSearchAlias(input)
}

// Translate only the old single-query controls whose meaning is known. Never
// silently discard paid workload, filters or an old encrypted continuation.
export function normalizeWechatSearchAlias(body) {
  const platform = wechatSearchPlatform(body?.platform)
  if (!platform) throw new AppError(400, 'invalid_platform', 'A WeChat search platform is required')
  const allowed = new Set(['platform', 'keyword', 'query', 'params', 'cursor', 'page',
    'count', 'pageSize', 'limit', 'deliveryMode', 'includeDetails', 'includeComments', 'disableAutoDetails'])
  if (Object.keys(body).some(key => !allowed.has(key))) {
    throw new AppError(400, 'unsupported_request_field', 'Use one keyword and the declared WeChat params; batch and legacy workload controls are not supported', { replacement: WECHAT_SEARCH_PATH })
  }
  if (body.params != null && (typeof body.params !== 'object' || Array.isArray(body.params))) {
    throw new AppError(400, 'invalid_native_request', 'params must be an object')
  }
  for (const field of ['includeDetails', 'includeComments']) {
    if (body[field] !== undefined && body[field] !== false) throw new AppError(400, 'unsupported_request_field', 'Automatic detail or comment acquisition is not supported')
  }
  if (body.disableAutoDetails !== undefined && body.disableAutoDetails !== true) {
    throw new AppError(400, 'unsupported_request_field', 'Automatic detail acquisition is not supported')
  }
  const params = { ...(body.params || {}) }
  const keywords = [body.keyword, body.query, params.keyword].filter(value => value !== undefined)
  if (!keywords.length || keywords.some(value => typeof value !== 'string' || !value.trim())
    || new Set(keywords.map(value => value.trim())).size !== 1) {
    throw new AppError(400, 'invalid_keyword', 'Supply one consistent keyword or query')
  }
  params.keyword = keywords[0].trim()
  if (body.cursor !== undefined) {
    if (params.cursor !== undefined && params.cursor !== body.cursor) throw new AppError(400, 'invalid_cursor', 'Conflicting cursors')
    params.cursor = body.cursor
  }
  // The new API has no page-size control. Accept only the old default hint;
  // returning a native page must not promise to truncate or fill it to count.
  for (const field of ['count', 'pageSize', 'limit']) {
    if (body[field] !== undefined && ![20, '20'].includes(body[field])) {
      throw new AppError(400, 'unsupported_page_size', 'WeChat search returns one native page; remove the legacy size field or use its default 20')
    }
  }
  if (body.page !== undefined) {
    const page = typeof body.page === 'string' && /^\d+$/.test(body.page) ? Number(body.page) : body.page
    if (!Number.isSafeInteger(page) || page < 1 || (page > 1 && !params.cursor)) {
      throw new AppError(400, 'invalid_cursor', 'Continue with the new response cursor, not a page number')
    }
  }
  if (platform === 'wechat_mp') {
    if (params.business_type !== undefined && params.business_type !== 'article') throw new AppError(400, 'invalid_parameter', 'wechat_mp searches articles; use wechat_search for other categories')
    params.business_type = 'article'
  }
  const mapped = { params, ...(body.deliveryMode !== undefined ? { deliveryMode: body.deliveryMode } : {}) }
  normalizeNativeForwardingRequest(WECHAT_SEARCH_KEY, mapped)
  return { key: WECHAT_SEARCH_KEY, path: nativeForwardingEndpoint(WECHAT_SEARCH_KEY).hubPath, body: mapped }
}
