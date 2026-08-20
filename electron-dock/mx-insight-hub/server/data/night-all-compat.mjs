import { AppError, UpstreamAmbiguousError, UpstreamRejectedError, assert } from '../core/errors.mjs'
import { NIGHT_ALL_LEGACY_OPERATIONS, parseNightAllLegacyArray } from '../contracts/night-all-legacy.mjs'

const COMMON_FIELDS = new Set([
  'businessId', 'business_id', 'platform', 'count', 'pageSize', 'limit', 'page',
  'cursor', 'concurrency', 'params', 'includeRaw',
])

const OPERATION_FIELDS = {
  raw: new Set([
    'keyword', 'query', 'keywords', 'queries', 'disableAutoDetails',
    'includeDetails', 'includeComments', 'commentLimit', 'cacheMaxAgeHours',
    'maxEnrichItems', 'commentCursor', 'enrichConcurrency',
  ]),
  crawl: new Set([
    'username', 'usernames', 'userId', 'userIds', 'user_id', 'uid',
    'channelUrl', 'channel_url', 'channelId', 'channel_id', 'url', 'urls',
    'activityTypes', 'cacheMaxAgeHours',
  ]),
  'user-info': new Set([
    'username', 'usernames', 'userId', 'userIds', 'user_id', 'uid',
    'url', 'profileUrl', 'profile_url', 'urls',
  ]),
}

const PRIVATE_PARAMETER = /(provider|credential|endpoint|capability|module.?code|business.?id|availability|billing|token|secret|password|authori[sz]ation|api.?key|access.?key|private.?key|proxy|headers?|cookies?|session(?:id|key|cookie)?|bearer|base.?url|webhook|callback.?url|timeout|include.?raw|debug)/iu
const HIGH_COST_PARAMETER = /^(archive|full.?archive|all.?tweets|archive.?limit|total.?count|max.*pages?|page.?count|chunk.?size|budget|crawl.?depth)$/iu
const WORKLOAD_PARAMETER = /^(count|limit|page.?size|page|page.?number|page.?no|concurrency|include.?details|include.?comments|disable.?auto.?details|comment.?limit|max.?enrich.?items|enrich.?concurrency|cache.?max.?age.?hours)$/iu
const MAX_MULTI_VALUE_COUNT = 100
const MAX_UPSTREAM_JOBS_PER_REQUEST = 50
const MAX_IDENTIFIER_LENGTH = 2_048
const FALLBACK_WINDOWS_MS = {
  raw: 15 * 60 * 1_000,
  crawl: 60 * 60 * 1_000,
  'user-info': 60 * 60 * 1_000,
}
const OPERATION_PAGE_SIZE_LIMIT = {
  raw: 1_000,
  crawl: 100,
  'user-info': 100,
}
const SAFE_CONTINUATION_PARAMETER_KEYS = new Set([
  'cursor', 'pcursor', 'after', 'maxid', 'endcursor', 'continuationtoken',
  'nextmaxid', 'ranktoken', 'searchid', 'searchsessionid', 'searchhashid',
  'backtrace', 'offset', 'nextoffset', 'start', 'paginationtoken',
  'pagetoken', 'nextpagetoken',
])

function hasValue(value) {
  if (typeof value === 'string') return Boolean(value.trim())
  if (typeof value === 'number') return Number.isFinite(value)
  return Array.isArray(value) && value.length > 0
}

function isLinkedInPersonalProfileUrl(value) {
  if (typeof value !== 'string') return false
  try {
    const parsed = new URL(value)
    return ['http:', 'https:'].includes(parsed.protocol)
      && (parsed.hostname === 'linkedin.com' || parsed.hostname.endsWith('.linkedin.com'))
      && /^\/in\/[^/]+/u.test(parsed.pathname)
  } catch {
    return false
  }
}

function normalizeIdentifier(value, field, { allowNumber = false } = {}) {
  if (allowNumber && typeof value === 'number' && Number.isFinite(value)) return String(value)
  assert(
    typeof value === 'string' && value.trim() && value.length <= MAX_IDENTIFIER_LENGTH,
    400,
    'invalid_request',
    `${field} is invalid`,
  )
  return value
}

function normalizeIdentifierArray(value, field) {
  assert(
    Array.isArray(value) && value.length > 0 && value.length <= MAX_MULTI_VALUE_COUNT,
    400,
    'invalid_request',
    `${field} must be a non-empty string or a bounded string array`,
  )
  assert(
    value.every((entry) => typeof entry === 'string' && entry.trim() && entry.length <= MAX_IDENTIFIER_LENGTH),
    400,
    'invalid_request',
    `${field} contains an invalid value`,
  )
  return value
}

function normalizedInteger(value, field, min, max) {
  const candidate = typeof value === 'string' && value.trim() ? Number(value) : value
  assert(
    Number.isInteger(candidate) && candidate >= min && candidate <= max,
    400,
    'invalid_request',
    `${field} must be an integer between ${min} and ${max}`,
  )
  return candidate
}

function privateParameterPath(value, prefix = 'params', state = { nodes: 0, maxArrayLength: 100 }, depth = 0) {
  state.nodes += 1
  if (depth > 8 || state.nodes > 1_000) return prefix
  if (typeof value === 'string') return value.length <= 8_192 ? null : prefix
  if (!value || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    if (value.length > state.maxArrayLength) return prefix
    for (let index = 0; index < value.length; index += 1) {
      const child = privateParameterPath(value[index], `${prefix}[${index}]`, state, depth + 1)
      if (child) return child
    }
    return null
  }
  for (const [key, nested] of Object.entries(value)) {
    const path = `${prefix}.${key}`
    const normalizedKey = key.replace(/[_-]/gu, '').toLowerCase()
    if (prefix === 'params' && SAFE_CONTINUATION_PARAMETER_KEYS.has(normalizedKey)) {
      const safeScalar = (
        (typeof nested === 'string' && nested.length > 0 && nested.length <= 8_192)
        || (typeof nested === 'number' && Number.isFinite(nested))
      )
      if (!safeScalar) return path
      continue
    }
    if (
      PRIVATE_PARAMETER.test(key)
      || HIGH_COST_PARAMETER.test(key)
      || WORKLOAD_PARAMETER.test(key)
      || /^(auth|authentication|authheader|authconfig|authparams|authdata)$/iu.test(key)
    ) return path
    const child = privateParameterPath(nested, path, state, depth + 1)
    if (child) return child
  }
  return null
}

function effectivePageSize(operation, body) {
  if (operation === 'user-info') return body.limit ?? body.count ?? body.pageSize ?? 20
  return body.count ?? body.pageSize ?? body.limit ?? 20
}

/**
 * Preserve Night-All's familiar field names while enforcing the Hub boundary:
 * one granted platform, bounded work, consumer-owned business identity, and no
 * caller-selected provider/credential/endpoint controls.
 */
export function normalizeNightAllCompatibilityRequest(operation, body, {
  businessId,
  canonicalizePlatform,
  maxPageSize,
}) {
  assert(NIGHT_ALL_LEGACY_OPERATIONS.has(operation), 404, 'not_found', 'Route not found')
  assert(body && typeof body === 'object' && !Array.isArray(body), 400, 'invalid_request', 'JSON object body is required')

  const allowed = new Set([...COMMON_FIELDS, ...OPERATION_FIELDS[operation]])
  const unsupported = Object.keys(body).filter((field) => !allowed.has(field))
  assert(unsupported.length === 0, 400, 'unsupported_fields', `Unsupported public fields: ${unsupported.join(', ')}`)

  const suppliedBusinessIds = [body.businessId, body.business_id].filter((value) => value != null)
  assert(
    suppliedBusinessIds.every((value) => typeof value === 'string' && value.trim() === businessId),
    400,
    'business_id_mismatch',
    'businessId must match the authenticated Hub consumer',
  )
  assert(businessId.length <= 128, 500, 'invalid_consumer_business_id', 'The Hub consumer businessId exceeds Night-All limits')

  const platform = canonicalizePlatform(body.platform)
  const upstreamBody = { ...body, platform }
  delete upstreamBody.businessId
  delete upstreamBody.business_id
  if (upstreamBody.includeRaw != null) {
    assert(upstreamBody.includeRaw === false, 400, 'unsupported_fields', 'includeRaw=true is not supported by this facade')
    // Legacy clients commonly send the default explicitly. Accepting false is
    // compatibility-only; raw/debug serving remains a Hub-owned policy.
    delete upstreamBody.includeRaw
  }

  for (const field of ['count', 'pageSize', 'limit']) {
    if (upstreamBody[field] == null) continue
    upstreamBody[field] = normalizedInteger(upstreamBody[field], field, 1, Number.MAX_SAFE_INTEGER)
  }
  const pageSize = effectivePageSize(operation, upstreamBody)
  const effectivePageSizeLimit = Math.min(maxPageSize, OPERATION_PAGE_SIZE_LIMIT[operation])
  assert(pageSize <= effectivePageSizeLimit, 400, 'page_size_exceeded', `Page size must not exceed ${effectivePageSizeLimit}`)
  if (upstreamBody.page != null) {
    upstreamBody.page = normalizedInteger(upstreamBody.page, 'page', 1, 1_000)
  }
  if (upstreamBody.concurrency != null) {
    upstreamBody.concurrency = normalizedInteger(upstreamBody.concurrency, 'concurrency', 1, 20)
  }
  if (upstreamBody.cacheMaxAgeHours != null) {
    assert(
      Number.isFinite(upstreamBody.cacheMaxAgeHours)
        && upstreamBody.cacheMaxAgeHours >= 0
        && upstreamBody.cacheMaxAgeHours <= 720,
      400,
      'invalid_request',
      'cacheMaxAgeHours must be between 0 and 720',
    )
  }
  for (const field of ['disableAutoDetails', 'includeDetails', 'includeComments']) {
    if (upstreamBody[field] != null) {
      assert(typeof upstreamBody[field] === 'boolean', 400, 'invalid_request', `${field} must be a boolean`)
    }
  }
  if (upstreamBody.commentLimit != null) {
    upstreamBody.commentLimit = normalizedInteger(upstreamBody.commentLimit, 'commentLimit', 1, 100)
  }
  if (upstreamBody.maxEnrichItems != null) {
    upstreamBody.maxEnrichItems = normalizedInteger(upstreamBody.maxEnrichItems, 'maxEnrichItems', 1, 20)
  }
  if (upstreamBody.enrichConcurrency != null) {
    upstreamBody.enrichConcurrency = normalizedInteger(upstreamBody.enrichConcurrency, 'enrichConcurrency', 1, 5)
  }
  if (upstreamBody.commentCursor != null) {
    assert(
      typeof upstreamBody.commentCursor === 'string'
        && upstreamBody.commentCursor.trim()
        && upstreamBody.commentCursor.length <= 8_192,
      400,
      'invalid_request',
      'commentCursor is invalid',
    )
  }
  if (upstreamBody.activityTypes != null) {
    assert(
      Array.isArray(upstreamBody.activityTypes)
        && upstreamBody.activityTypes.length > 0
        && upstreamBody.activityTypes.length <= 100
        && upstreamBody.activityTypes.every((value) => typeof value === 'string' && value.trim() && value.length <= 128),
      400,
      'invalid_request',
      'activityTypes must be a bounded non-empty string array',
    )
  }
  if (upstreamBody.cursor != null) {
    assert(typeof upstreamBody.cursor === 'string' && upstreamBody.cursor.trim() && upstreamBody.cursor.length <= 8_192, 400, 'invalid_cursor', 'cursor is invalid')
  }
  if (upstreamBody.params != null) {
    assert(upstreamBody.params && typeof upstreamBody.params === 'object' && !Array.isArray(upstreamBody.params), 400, 'invalid_request', 'params must be an object')
    const privatePath = privateParameterPath(
      upstreamBody.params,
      'params',
      { nodes: 0, maxArrayLength: effectivePageSizeLimit },
    )
    assert(!privatePath, 400, 'unsupported_fields', `Unsupported public field: ${privatePath}`)
  }

  if (operation === 'raw') {
    const singularFields = ['keyword', 'query'].filter((field) => hasValue(upstreamBody[field]))
    const pluralFields = ['keywords', 'queries'].filter((field) => hasValue(upstreamBody[field]))
    const fields = [...singularFields, ...pluralFields]
    assert(fields.length > 0, 400, 'invalid_request', 'keyword or query is required')
    for (const field of singularFields) upstreamBody[field] = normalizeIdentifier(upstreamBody[field], field)
    for (const field of pluralFields) upstreamBody[field] = normalizeIdentifierArray(upstreamBody[field], field)
    const queryCount = singularFields.length
      + pluralFields.reduce((sum, field) => sum + upstreamBody[field].length, 0)
    assert(
      queryCount <= MAX_UPSTREAM_JOBS_PER_REQUEST,
      400,
      'work_budget_exceeded',
      `Query count must not exceed ${MAX_UPSTREAM_JOBS_PER_REQUEST}`,
    )
    assert(
      queryCount * pageSize <= effectivePageSizeLimit,
      400,
      'work_budget_exceeded',
      `Query count multiplied by page size must not exceed ${effectivePageSizeLimit}`,
    )
  } else {
    const fields = operation === 'crawl'
      ? ['username', 'usernames', 'userId', 'userIds', 'user_id', 'uid', 'channelUrl', 'channel_url', 'channelId', 'channel_id', 'url', 'urls']
      : ['username', 'usernames', 'userId', 'userIds', 'user_id', 'uid', 'url', 'profileUrl', 'profile_url', 'urls']
    const supplied = fields.filter((field) => hasValue(upstreamBody[field]))
    assert(supplied.length > 0, 400, 'invalid_request', 'A user or channel identifier is required')
    const arrays = new Set(['usernames', 'userIds', 'urls'])
    const numericAliases = new Set(['username', 'userId', 'user_id', 'uid', 'channelId', 'channel_id'])
    for (const field of supplied) {
      upstreamBody[field] = arrays.has(field)
        ? normalizeIdentifierArray(upstreamBody[field], field)
        : normalizeIdentifier(upstreamBody[field], field, { allowNumber: numericAliases.has(field) })
    }
    const identifierCount = supplied.reduce(
      (sum, field) => sum + (arrays.has(field) ? upstreamBody[field].length : 1),
      0,
    )
    if (operation === 'user-info' && platform === 'linkedin') {
      const identifiers = supplied.flatMap((field) => (
        arrays.has(field) ? upstreamBody[field] : [upstreamBody[field]]
      ))
      assert(
        identifiers.every(isLinkedInPersonalProfileUrl),
        400,
        'invalid_request',
        'LinkedIn user-info requires a complete /in/ personal profile URL',
      )
      // The deployed Night-All contract accepts these URLs through its legacy
      // username fields and maps HTTP values to the provider's `url` parameter.
      // Keep the newer aliases at the Hub edge without requiring an upstream
      // schema change.
      for (const field of fields) delete upstreamBody[field]
      if (identifiers.length === 1) upstreamBody.username = identifiers[0]
      else upstreamBody.usernames = identifiers
    }
    assert(identifierCount <= MAX_MULTI_VALUE_COUNT, 400, 'work_budget_exceeded', `Identifier count must not exceed ${MAX_MULTI_VALUE_COUNT}`)
    if (operation === 'crawl') {
      const activityTypeCount = upstreamBody.activityTypes?.length || 1
      assert(
        identifierCount <= MAX_UPSTREAM_JOBS_PER_REQUEST,
        400,
        'work_budget_exceeded',
        `Identifier count must not exceed ${MAX_UPSTREAM_JOBS_PER_REQUEST}`,
      )
      assert(
        identifierCount * pageSize * activityTypeCount <= effectivePageSizeLimit,
        400,
        'work_budget_exceeded',
        `Crawl work must not exceed ${effectivePageSizeLimit}`,
      )
    }
  }

  return { platform, upstreamBody, pageSize }
}

export function nightAllCompatibilityFallbackWindowMs(operation) {
  return FALLBACK_WINDOWS_MS[operation]
}

export function nightAllCompatibilityItemCount(payload) {
  const rawInfo = parseNightAllLegacyArray(payload?.data?.raw_info) || []
  const rawData = parseNightAllLegacyArray(payload?.data?.raw_data) || []
  return Math.max(rawInfo.length, rawData.length, 1)
}

export function canUseNightAllCompatibilityFallback(error) {
  if (error instanceof UpstreamAmbiguousError) return true
  return error instanceof UpstreamRejectedError && [502, 503, 504].includes(error.status)
}

export function nightAllCompatibilityBusinessOutcome(payload) {
  const warnings = Array.isArray(payload?.data?.warnings) ? payload.data.warnings : []
  const results = Array.isArray(payload?.data?.results) ? payload.data.results : []
  // Night-All emits STANDARD_PAYLOAD_EMPTY after a successful provider call
  // that deterministically returned no usable rows. That empty answer is a
  // valid last-good value; treating it as partial could resurrect older,
  // non-empty results during a later outage.
  const substantiveWarnings = warnings.filter((warning) => (
    (typeof warning === 'string' ? warning : warning?.code) !== 'STANDARD_PAYLOAD_EMPTY'
  ))
  const partial = substantiveWarnings.length > 0
    || results.some((entry) => entry?.error || entry?.success === false)
  return partial ? 'partial' : 'complete'
}

export function compatibilityUpstreamEvidence(error) {
  if (error instanceof UpstreamAmbiguousError) {
    return {
      outcome: 'unknown',
      errorCode: error.cause?.name === 'InvalidUpstreamResponseError'
        ? `night_all_${error.cause.code}`
        : 'night_all_outcome_unknown',
    }
  }
  if (error instanceof UpstreamRejectedError) {
    return { outcome: 'rejected', errorCode: `night_all_http_${error.status}` }
  }
  return { outcome: 'unknown', errorCode: 'night_all_internal_error' }
}

export function staleSnapshotAgeSeconds(snapshot, now = Date.now()) {
  return Math.max(0, Math.floor((now - new Date(snapshot.capturedAt).getTime()) / 1_000))
}

export function assertUsableNightAllCompatibilitySnapshot(snapshot, now = Date.now()) {
  if (!snapshot || new Date(snapshot.staleUntil).getTime() <= now) {
    throw new AppError(503, 'night_all_unavailable', 'Night-All is unavailable and no usable exact Hub snapshot exists')
  }
  return snapshot
}
