import { assert } from '../core/errors.mjs'

export const NIGHT_ALL_POST_DETAIL_OPERATION = 'post-detail'

// This is the stable social-platform set accepted by Night-All's post-detail
// contract. Provider readiness remains a runtime concern; the list only
// controls the compatibility boundary exposed by Hub.
export const NIGHT_ALL_POST_DETAIL_SUPPORTED_PLATFORMS = Object.freeze([
  'douyin', 'weibo', 'zhihu', 'xiaohongshu', 'twitter', 'reddit', 'tiktok',
  'instagram', 'facebook', 'linkedin', 'youtube', 'xianyu',
])

const IDENTIFIER_FIELDS = [
  'itemId', 'item_id', 'postId', 'post_id', 'contentId', 'content_id',
  'awemeId', 'aweme_id', 'noteId', 'note_id', 'statusId', 'status_id',
  'tweetId', 'tweet_id', 'videoId', 'video_id', 'postUrn', 'post_urn',
  'commentUrn', 'comment_urn', 'urn', 'url',
]

const ALLOWED_FIELDS = new Set([
  'platform', 'count', 'limit', 'pageSize', 'page', 'params',
  'cacheMaxAgeHours', 'includeRaw', 'businessId', 'business_id',
  ...IDENTIFIER_FIELDS,
])

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

export function normalizeNightAllPostDetailRequest(body, {
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
  const pageSize = upstreamBody.count ?? upstreamBody.pageSize ?? upstreamBody.limit ?? 1
  assert(pageSize <= Math.min(maxPageSize, 100), 400, 'page_size_exceeded', `Page size must not exceed ${Math.min(maxPageSize, 100)}`)
  if (upstreamBody.page != null) upstreamBody.page = integer(upstreamBody.page, 'page', 1, 1_000)
  if (upstreamBody.cacheMaxAgeHours != null) {
    assert(Number.isFinite(upstreamBody.cacheMaxAgeHours)
      && upstreamBody.cacheMaxAgeHours >= 0 && upstreamBody.cacheMaxAgeHours <= 720,
    400, 'invalid_request', 'cacheMaxAgeHours must be between 0 and 720')
  }
  if (upstreamBody.params != null) {
    assert(upstreamBody.params && typeof upstreamBody.params === 'object' && !Array.isArray(upstreamBody.params),
      400, 'invalid_request', 'params must be an object')
    assert(Object.keys(upstreamBody.params).every((key) => !/(provider|credential|endpoint|token|secret|password|api.?key|authorization|header|cookie|session|base.?url)/iu.test(key)),
      400, 'unsupported_fields', 'Provider and credential controls are not public fields')
  }

  const present = IDENTIFIER_FIELDS.filter((field) => body[field] != null && body[field] !== '')
  assert(present.length > 0, 400, 'invalid_request', 'postId/contentId/url or a platform-specific post id is required')
  for (const field of present) upstreamBody[field] = identifier(upstreamBody[field], field)
  return { platform, upstreamBody, pageSize }
}
