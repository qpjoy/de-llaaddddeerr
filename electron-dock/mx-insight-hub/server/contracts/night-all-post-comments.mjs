import { assert } from '../core/errors.mjs'

export const NIGHT_ALL_POST_COMMENTS_OPERATION = 'post-comments'

// Stable Night-All comment coverage. Product-specific comment routes (for
// example the Xiaohongshu research contract and YouTube channel comments)
// remain separate; this list is only for the historical single-post bridge.
export const NIGHT_ALL_POST_COMMENTS_SUPPORTED_PLATFORMS = Object.freeze([
  'douyin', 'weibo', 'zhihu', 'xiaohongshu', 'twitter', 'reddit', 'tiktok',
  'instagram', 'linkedin', 'youtube',
])

const IDENTIFIER_FIELDS = [
  'itemId', 'item_id', 'postId', 'post_id', 'contentId', 'content_id',
  'awemeId', 'aweme_id', 'noteId', 'note_id', 'statusId', 'status_id',
  'tweetId', 'tweet_id', 'videoId', 'video_id', 'postUrn', 'post_urn',
  'commentId', 'comment_id', 'commentUrn', 'comment_urn', 'urn', 'url',
]

const ALLOWED_FIELDS = new Set([
  'platform', 'count', 'limit', 'pageSize', 'page', 'cursor', 'params',
  'cacheMaxAgeHours', 'includeRaw', 'businessId', 'business_id',
  ...IDENTIFIER_FIELDS,
])

const PRIVATE_PARAM = /(provider|credential|endpoint|token|secret|password|api.?key|authorization|header|cookie|session|base.?url|upstream)/iu
const HIGH_COST_PARAM = /(archive|full.?archive|all.?comments|max.?pages?|page.?count|chunk.?size|budget|crawl.?depth|concurrency|comment.?limit|max.?comments?)/iu

function identifier(value, field) {
  assert(
    (typeof value === 'string' && value.trim())
      || (typeof value === 'number' && Number.isFinite(value)),
    400,
    'invalid_request',
    `${field} is invalid`,
  )
  const normalized = String(value).trim()
  assert(normalized.length <= 2_048, 400, 'invalid_request', `${field} is invalid`)
  return normalized
}

function integer(value, field, min, max) {
  const candidate = typeof value === 'string' && value.trim() ? Number(value) : value
  assert(Number.isInteger(candidate) && candidate >= min && candidate <= max,
    400, 'invalid_request', `${field} must be an integer between ${min} and ${max}`)
  return candidate
}

function safeParams(value, path = 'params', depth = 0) {
  assert(value && typeof value === 'object' && !Array.isArray(value),
    400, 'invalid_request', 'params must be an object')
  assert(depth <= 4, 400, 'invalid_request', 'params is too deeply nested')
  const keys = Object.keys(value)
  assert(keys.length <= 100, 400, 'invalid_request', 'params has too many fields')
  for (const key of keys) {
    assert(key.length <= 128 && !PRIVATE_PARAM.test(key) && !HIGH_COST_PARAM.test(key),
      400, 'unsupported_fields', `Unsupported params field: ${path}.${key}`)
    const nested = value[key]
    if (nested && typeof nested === 'object') {
      if (Array.isArray(nested)) {
        assert(nested.length <= 100, 400, 'invalid_request', `${path}.${key} has too many values`)
        for (const [index, item] of nested.entries()) {
          if (item && typeof item === 'object') safeParams(item, `${path}.${key}[${index}]`, depth + 1)
          else assert(item == null || ['string', 'number', 'boolean'].includes(typeof item),
            400, 'invalid_request', `${path}.${key}[${index}] is invalid`)
        }
      } else safeParams(nested, `${path}.${key}`, depth + 1)
    } else {
      assert(nested == null || ['string', 'number', 'boolean'].includes(typeof nested),
        400, 'invalid_request', `${path}.${key} is invalid`)
      if (typeof nested === 'string') assert(nested.length <= 8_192, 400, 'invalid_request', `${path}.${key} is invalid`)
    }
  }
}

export function normalizeNightAllPostCommentsRequest(body, {
  businessId,
  canonicalizePlatform,
  maxPageSize = 100,
} = {}) {
  assert(body && typeof body === 'object' && !Array.isArray(body), 400, 'invalid_request', 'JSON object body is required')
  const unsupported = Object.keys(body).filter((field) => !ALLOWED_FIELDS.has(field))
  assert(unsupported.length === 0, 400, 'unsupported_fields', `Unsupported public fields: ${unsupported.join(', ')}`)

  const suppliedBusinessIds = [body.businessId, body.business_id].filter((value) => value != null)
  if (businessId != null) {
    assert(suppliedBusinessIds.every((value) => typeof value === 'string' && value.trim() === businessId),
      400, 'business_id_mismatch', 'businessId must match the authenticated Hub consumer')
  }

  const platform = canonicalizePlatform(body.platform)
  assert(platform && !['all', 'all_platforms', 'any', ''].includes(platform),
    400, 'invalid_platform', 'A single explicit platform is required')
  const upstreamBody = { ...body, platform }
  delete upstreamBody.businessId
  delete upstreamBody.business_id
  if (upstreamBody.includeRaw != null) {
    assert(upstreamBody.includeRaw === false, 400, 'unsupported_fields', 'includeRaw=true is not supported by this facade')
    delete upstreamBody.includeRaw
  }
  for (const field of ['count', 'pageSize', 'limit']) {
    if (upstreamBody[field] != null) upstreamBody[field] = integer(upstreamBody[field], field, 1, Math.min(maxPageSize, 100))
  }
  const pageSize = upstreamBody.count ?? upstreamBody.pageSize ?? upstreamBody.limit ?? 20
  assert(pageSize <= Math.min(maxPageSize, 100), 400, 'page_size_exceeded', `Page size must not exceed ${Math.min(maxPageSize, 100)}`)
  if (upstreamBody.page != null) upstreamBody.page = integer(upstreamBody.page, 'page', 1, 1_000)
  if (upstreamBody.cursor != null) {
    assert(typeof upstreamBody.cursor === 'string' && upstreamBody.cursor.trim() && upstreamBody.cursor.length <= 8_192,
      400, 'invalid_cursor', 'cursor is invalid')
  }
  if (upstreamBody.cacheMaxAgeHours != null) {
    assert(Number.isFinite(upstreamBody.cacheMaxAgeHours)
      && upstreamBody.cacheMaxAgeHours >= 0 && upstreamBody.cacheMaxAgeHours <= 720,
    400, 'invalid_request', 'cacheMaxAgeHours must be between 0 and 720')
  }
  if (upstreamBody.params != null) safeParams(upstreamBody.params)

  const present = IDENTIFIER_FIELDS.filter((field) => body[field] != null && body[field] !== '')
  assert(present.length > 0, 400, 'invalid_request', 'postId/contentId/url or a platform-specific post/comment id is required')
  for (const field of present) upstreamBody[field] = identifier(upstreamBody[field], field)
  return { platform, upstreamBody, pageSize }
}
