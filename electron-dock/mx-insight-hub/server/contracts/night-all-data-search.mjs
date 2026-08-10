const ITEM_KEYS = [
  'id', 'externalId', 'platform', 'contentType', 'url', 'title', 'text',
  'publishedAt', 'collectedAt', 'author', 'metrics', 'media', 'source',
]
const PAGE_KEYS = ['pageIndex', 'pageSize', 'returnedCount', 'hasMore', 'nextCursor', 'cursorType']
const RESULT_KEYS = ['contractVersion', 'platform', 'query', 'items', 'pageInfo', 'status', 'warnings', 'meta']
const META_KEYS = [
  'capability', 'capabilityStatus', 'paginationMode', 'sourceProvider',
  'endpointId', 'providerCalls', 'durationMs', 'error',
]

const PROVIDERS = new Set(['tikhub', 'rapidapi', 'justone'])
const CAPABILITY_STATUSES = new Set(['declared', 'catalogued', 'ready', 'degraded', 'disabled'])
const PAGINATION_MODES = new Set(['cursor', 'compound', 'page', 'offset', 'composite', 'none', 'unknown'])

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactObject(value, required, optional = []) {
  if (!plainObject(value)) return false
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key))
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function nullableString(value) {
  return value === null || typeof value === 'string'
}

function nullableNonEmptyString(value) {
  return value === null || nonEmptyString(value)
}

function nullableTimestamp(value) {
  if (value === null) return true
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return false
  return Number.isFinite(Date.parse(value))
}

function boundedInteger(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum
}

function nullableMetric(value) {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

function validAuthor(value) {
  return exactObject(value, ['id', 'name', 'avatarUrl'])
    && nullableString(value.id)
    && nullableString(value.name)
    && nullableString(value.avatarUrl)
}

function validMetrics(value) {
  const keys = ['likes', 'comments', 'shares', 'views', 'bookmarks']
  return exactObject(value, keys) && keys.every((key) => nullableMetric(value[key]))
}

function validMedia(value) {
  return exactObject(value, ['coverUrl', 'images', 'videos'])
    && nullableString(value.coverUrl)
    && Array.isArray(value.images) && value.images.every((entry) => typeof entry === 'string')
    && Array.isArray(value.videos) && value.videos.every((entry) => typeof entry === 'string')
}

function validSource(value) {
  return exactObject(value, ['provider', 'endpointId'])
    && (value.provider === null || PROVIDERS.has(value.provider))
    && nullableString(value.endpointId)
}

function validItem(value) {
  return exactObject(value, ITEM_KEYS)
    && nonEmptyString(value.id)
    && nullableString(value.externalId)
    && nonEmptyString(value.platform)
    && nullableString(value.contentType)
    && nullableString(value.url)
    && nullableString(value.title)
    && nullableString(value.text)
    && nullableTimestamp(value.publishedAt)
    && nullableTimestamp(value.collectedAt)
    && validAuthor(value.author)
    && validMetrics(value.metrics)
    && validMedia(value.media)
    && validSource(value.source)
}

function validPageInfo(value) {
  return exactObject(value, PAGE_KEYS)
    && boundedInteger(value.pageIndex, 1, Number.MAX_SAFE_INTEGER)
    && boundedInteger(value.pageSize, 0, 100)
    && boundedInteger(value.returnedCount, 0, 100)
    && typeof value.hasMore === 'boolean'
    && nullableString(value.nextCursor)
    && (value.cursorType === 'opaque' || value.cursorType === 'none')
}

function validWarning(value) {
  return exactObject(value, ['code', 'message'])
    && nonEmptyString(value.code)
    && nonEmptyString(value.message)
}

function validError(value) {
  return exactObject(value, ['code', 'message', 'statusCode'])
    && nonEmptyString(value.code)
    && nonEmptyString(value.message)
    && boundedInteger(value.statusCode, 400, 599)
}

function validMeta(value) {
  if (!exactObject(value, [], META_KEYS)) return false
  if (value.capability !== undefined && value.capability !== 'search_posts') return false
  if (value.capabilityStatus !== undefined && !CAPABILITY_STATUSES.has(value.capabilityStatus)) return false
  if (value.paginationMode !== undefined && !PAGINATION_MODES.has(value.paginationMode)) return false
  if (value.sourceProvider !== undefined && !nullableNonEmptyString(value.sourceProvider)) return false
  if (value.endpointId !== undefined && !nullableNonEmptyString(value.endpointId)) return false
  if (value.providerCalls !== undefined && !boundedInteger(value.providerCalls, 0, Number.MAX_SAFE_INTEGER)) return false
  if (value.durationMs !== undefined && !boundedInteger(value.durationMs, 0, Number.MAX_SAFE_INTEGER)) return false
  return value.error === undefined || validError(value.error)
}

function validPlatformResult(value) {
  return exactObject(value, RESULT_KEYS)
    && value.contractVersion === 'night-all.data-search.v1'
    && nonEmptyString(value.platform)
    && nonEmptyString(value.query)
    && Array.isArray(value.items) && value.items.every(validItem)
    && validPageInfo(value.pageInfo)
    && new Set(['ok', 'partial', 'failed']).has(value.status)
    && Array.isArray(value.warnings) && value.warnings.every(validWarning)
    && validMeta(value.meta)
}

/**
 * Exact single-platform response variant of Night-All's DataSearchResponseSchema.
 * Hub's public route deliberately accepts one platform, so the multi-result union
 * member is not an upstream response this adapter may serve.
 */
export function isNightAllDataSearchV1Envelope(value) {
  return exactObject(value, ['data'], ['requestId', 'traceId'])
    && (value.requestId === undefined || typeof value.requestId === 'string')
    && (value.traceId === undefined || typeof value.traceId === 'string')
    && validPlatformResult(value.data)
}
