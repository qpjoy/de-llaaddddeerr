import { createHash } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { normalizeTwitterSearchParameters } from './twitter-search-parameters.mjs'
import { requestFingerprint } from '../core/crypto.mjs'

export const DATA_SEARCH_V2_PATH = '/api/v2/data/search'
export const DATA_SEARCH_V1_PATH = '/api/v1/data/search'
export const DATA_SEARCH_V2_VERSION = 'mx-insight-hub.data-search.v2'
export const DATA_SEARCH_V2_PLATFORMS = Object.freeze(['facebook', 'twitter', 'instagram', 'reddit',
  'weibo', 'bilibili', 'douyin', 'kuaishou', 'zhihu', 'youtube', 'tiktok', 'xiaohongshu'])
const fields = new Set(['platform', 'query', 'pageSize', 'type', 'cursor', 'timeWindow', 'params'])
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
const invalid = message => { throw new AppError(400, 'invalid_time_window', message) }
const iso = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) invalid('from/to must be ISO timestamps with an explicit timezone')
  const day = value.slice(0, 10), time = Date.parse(value)
  if (!Number.isFinite(time) || new Date(Date.parse(day)).toISOString().slice(0, 10) !== day
    || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) invalid('Invalid timeWindow timestamp')
  return new Date(time).toISOString()
}

export function normalizeDataSearchV2(body, canonicalPlatform = value => value) {
  if (!plain(body)) throw new AppError(400, 'invalid_request', 'JSON object body is required')
  if (Object.keys(body).some(key => !fields.has(key))) throw new AppError(400, 'unsupported_fields', 'Unsupported v2 search fields')
  const platform = canonicalPlatform(body.platform)
  if (body.params !== undefined && platform !== 'twitter') throw new AppError(400, 'unsupported_fields', 'v2 params are only supported for Twitter search')
  const params = body.params !== undefined ? normalizeTwitterSearchParameters(body.params) : undefined
  if (!DATA_SEARCH_V2_PLATFORMS.includes(platform)) throw new AppError(422, 'search_v2_platform_unsupported', 'This platform has no v2 content-search contract')
  if (typeof body.query !== 'string' || !body.query.trim() || body.query.length > 500) throw new AppError(400, 'invalid_query', 'query must contain 1–500 characters')
  const pageSize = body.pageSize ?? 20, type = body.type ?? 'fresh'
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new AppError(400, 'invalid_page_size', 'pageSize must be between 1 and 100')
  if (!['fresh', 'stable'].includes(type)) throw new AppError(400, 'invalid_result_type', 'type must be fresh or stable')
  const window = body.timeWindow
  if (!plain(window) || Object.keys(window).some(key => !['from', 'to', 'timezone', 'boundary'].includes(key))) invalid('timeWindow is required and has only from/to/timezone/boundary')
  if (window.boundary !== '[from,to)') invalid('timeWindow.boundary must be [from,to)')
  if (typeof window.timezone !== 'string' || !window.timezone || window.timezone.length > 100) invalid('timeWindow.timezone must be an IANA timezone')
  try { new Intl.DateTimeFormat('en', { timeZone: window.timezone }).format() } catch { invalid('Unknown timeWindow.timezone') }
  const timeWindow = { from: iso(window.from), to: iso(window.to), timezone: window.timezone, boundary: '[from,to)' }
  if (timeWindow.from >= timeWindow.to) invalid('timeWindow.from must precede to')
  if (body.cursor != null && (typeof body.cursor !== 'string' || !body.cursor.startsWith('mxds2.') || body.cursor.length > 16384)) {
    throw new AppError(400, 'invalid_cursor', 'v2 requires its own unchanged mxds2 continuation')
  }
  return { platform, query: body.query.trim(), pageSize, type, timeWindow,
    ...(params !== undefined ? { params } : {}), ...(body.cursor ? { cursor: body.cursor } : {}) }
}

export function dataSearchV2Scope(body) {
  const { cursor: _, ...scope } = body
  return requestFingerprint({ method: 'POST', path: DATA_SEARCH_V2_PATH, body: scope })
}
export const dataSearchQueryHash = query => createHash('sha256').update(query.trim()).digest('hex')

export function prepareDataSearchV2(body, codec, now = Date.now()) {
  const scope = dataSearchV2Scope(body)
  let state = { version: DATA_SEARCH_V2_VERSION, scope, expiresAt: now + 86400000, page: 1, cursor: null }
  if (body.cursor) {
    try {
      state = codec.decode(body.cursor)
      if (state.version !== DATA_SEARCH_V2_VERSION || state.scope !== scope || state.expiresAt <= now
        || !Number.isSafeInteger(state.expiresAt) || !Number.isInteger(state.page) || state.page < 2 || state.page > 15
        || typeof state.cursor !== 'string' || !state.cursor || state.cursor.length > 8192) throw new Error('scope')
    } catch { throw new AppError(400, 'invalid_cursor', 'v2 continuation is expired or belongs to another query/window/Key') }
  }
  // v2 keys permanently identify an attempt. v1 fresh's timed re-acquisition
  // remains available only to unchanged v1 callers.
  const upstream = { platform: body.platform, query: body.query, pageSize: body.pageSize, type: 'stable',
    ...(body.platform === 'twitter' && body.params !== undefined ? { params: body.params } : {}),
    ...(state.cursor ? { cursor: state.cursor } : {}) }
  if (body.platform === 'facebook') upstream.params = {
    startDate: new Date(Date.parse(body.timeWindow.from) + 28800000).toISOString().slice(0, 10),
    endDate: new Date(Date.parse(body.timeWindow.to) + 28800000).toISOString().slice(0, 10),
  }
  return { state, upstream }
}

export function projectDataSearchV2(result, body, prepared, codec) {
  const source = result?.body?.data, page = source?.pageInfo
  if (source?.platform !== body.platform || source.query !== body.query || !Array.isArray(source?.items)
    || source.items.length > body.pageSize || !plain(page) || typeof page.hasMore !== 'boolean'
    || page.hasMore && (typeof page.nextCursor !== 'string' || !page.nextCursor)) {
    throw new AppError(502, 'search_v2_projection_unavailable', 'The saved underlying search does not have a standard page')
  }
  let missingTimestamps = 0, outsideWindow = 0
  const from = Date.parse(body.timeWindow.from), to = Date.parse(body.timeWindow.to)
  const items = source.items.filter(item => {
    const value = item?.publishedAt
    // Do not substitute collection time or an implicit host timezone.
    const time = typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ? Date.parse(value) : NaN
    if (!Number.isFinite(time)) { missingTimestamps++; return false }
    if (time < from || time >= to) { outsideWindow++; return false }
    return true
  })
  const bounded = prepared.state.page >= 15 && page.hasMore
  const hasMore = page.hasMore && !bounded
  const nextCursor = hasMore ? codec.encode({ ...prepared.state, page: prepared.state.page + 1, cursor: page.nextCursor }) : null
  const upstreamFiltering = body.platform === 'facebook' ? 'calendar_date' : 'unsupported'
  const limitations = [{ code: 'source_coverage_not_guaranteed', message: 'Search results are a bounded source traversal, not proof of complete historical coverage.' }]
  if (upstreamFiltering === 'unsupported') limitations.push({ code: 'upstream_time_filter_unsupported', message: 'This v2 search route does not apply a source-side time filter; only delivered items are filtered.' })
  else limitations.push({ code: 'upstream_date_boundary_unverified', message: 'Calendar-date filtering is available, but source date-boundary inclusivity and historical completeness are not guaranteed.' })
  if (missingTimestamps) limitations.push({ code: 'published_time_unavailable', count: missingTimestamps, message: 'Items without a verified publication timestamp were retained in source evidence and excluded from this delivery.' })
  if (bounded || source.status === 'partial') limitations.push({ code: 'source_traversal_incomplete', message: 'The underlying traversal stopped before complete source exhaustion could be established.' })
  const effectiveWindow = { ...body.timeWindow, upstreamFiltering, deliveryFiltering: 'exact',
    ...(body.platform === 'facebook' ? { upstreamTimezone: 'Asia/Shanghai', upstreamDates: prepared.upstream.params } : {}) }
  const warnings = [...(source.warnings || []), ...(missingTimestamps ? [{ code: 'PUBLISHED_TIME_UNAVAILABLE', message: 'Some acquired items could not be assigned to the requested window.' }] : [])]
  return { ...result, body: { ...result.body, data: { ...source, contractVersion: DATA_SEARCH_V2_VERSION, items,
    pageInfo: { ...page, returnedCount: items.length, hasMore, nextCursor, cursorType: hasMore ? 'opaque' : 'none' },
    status: source.status === 'partial' || missingTimestamps || bounded || upstreamFiltering === 'unsupported' ? 'partial' : source.status,
    warnings, meta: { ...(source.meta || {}), requestedWindow: body.timeWindow, effectiveWindow,
      capabilities: { upstreamFiltering, deliveryFiltering: 'exact', ordering: 'unspecified', coverageComplete: false,
        maxPages: 15, paginationVersion: 2, idempotency: 'permanent' }, limitations,
      timeFilter: { examinedCount: source.items.length, outsideWindow, missingTimestamps } } } } }
}
