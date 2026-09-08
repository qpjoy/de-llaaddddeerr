import { createHash } from 'node:crypto'

import {
  normalizeTikHubXiaohongshuNote,
  redactTikHubEnvelope,
  XIAOHONGSHU_PLATFORM,
} from './tikhub-xiaohongshu.mjs'

export const XIAOHONGSHU_SEARCH_OPERATION = 'social.posts.search'
export const XIAOHONGSHU_SEARCH_CONTRACT_VERSION = 'night-all.data-search.v1'
export const TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_KEY = 'xiaohongshu.app-v2.search-notes.v1'
export const TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_VERSION = 'app_v2'
export const TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_PATH = '/api/v1/xiaohongshu/app_v2/search_notes'

const REQUEST_FIELDS = new Set(['platform', 'query', 'pageSize', 'cursor'])
export const XIAOHONGSHU_SEARCH_MAX_QUERY_LENGTH = 500
const MAX_CURSOR_LENGTH = 8_192
const MAX_PAGE = 10_000
const MAX_PAGE_SIZE = 100
const MAX_TEXT_CODE_POINTS = 50_000
const NOTE_ID_PATTERN = /^[0-9a-f]{24}$/iu

export class TikHubXiaohongshuSearchContractError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TikHubXiaohongshuSearchContractError'
    this.code = code
  }
}

export class TikHubXiaohongshuSearchResponseError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TikHubXiaohongshuSearchResponseError'
    this.code = code
  }
}

function invalidRequest(code, message) {
  throw new TikHubXiaohongshuSearchContractError(code, message)
}

function invalidResponse(code, message) {
  throw new TikHubXiaohongshuSearchResponseError(code, message)
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyText(value, maximum, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    invalidRequest(`invalid_${field}`, `${field} must be a non-empty string of at most ${maximum} characters`)
  }
  return value.trim()
}

function pageSize(value, maximum) {
  const upperBound = maximum ?? MAX_PAGE_SIZE
  if (!Number.isInteger(upperBound) || upperBound < 1 || upperBound > MAX_PAGE_SIZE) {
    throw new TypeError(`maxPageSize must be an integer between 1 and ${MAX_PAGE_SIZE}`)
  }
  const normalized = value ?? Math.min(20, upperBound)
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > upperBound) {
    invalidRequest('invalid_page_size', `pageSize must be an integer between 1 and ${upperBound}`)
  }
  return normalized
}

function scopeFor(query, normalizedPageSize) {
  return createHash('sha256').update(JSON.stringify({
    contractVersion: XIAOHONGSHU_SEARCH_CONTRACT_VERSION,
    platform: XIAOHONGSHU_PLATFORM,
    query,
    pageSize: normalizedPageSize,
  })).digest('hex')
}

function decodedCursor(cursor, decodeCursor) {
  if (!cursor) return null
  if (typeof decodeCursor !== 'function') {
    invalidRequest('cursor_codec_required', 'a trusted cursor decoder is required')
  }
  let state
  try {
    state = decodeCursor(cursor)
  } catch {
    invalidRequest('invalid_cursor', 'cursor is invalid')
  }
  if (
    !isRecord(state)
    || state.version !== 1
    || state.platform !== XIAOHONGSHU_PLATFORM
    || !Number.isInteger(state.page)
    || state.page < 2
    || state.page > MAX_PAGE
    || typeof state.scope !== 'string'
    || (state.searchId !== null && typeof state.searchId !== 'string')
    || (state.searchSessionId !== null && typeof state.searchSessionId !== 'string')
    || (typeof state.searchId === 'string' && (!state.searchId || state.searchId.length > 2_048))
    || (typeof state.searchSessionId === 'string'
      && (!state.searchSessionId || state.searchSessionId.length > 2_048))
  ) invalidRequest('invalid_cursor', 'cursor is invalid')
  return state
}

export function normalizeXiaohongshuSearchRequest(input, { decodeCursor, maxPageSize } = {}) {
  if (!isRecord(input)) invalidRequest('invalid_request', 'request body must be an object')
  const unsupported = Object.keys(input).filter((field) => !REQUEST_FIELDS.has(field))
  if (unsupported.length > 0) {
    invalidRequest('unsupported_fields', `request contains unsupported field ${unsupported[0]}`)
  }
  if (input.platform !== XIAOHONGSHU_PLATFORM) {
    invalidRequest('invalid_platform', 'platform must be xiaohongshu')
  }
  const query = nonEmptyText(input.query, XIAOHONGSHU_SEARCH_MAX_QUERY_LENGTH, 'query')
  const normalizedPageSize = pageSize(input.pageSize, maxPageSize)
  const cursor = input.cursor == null ? null : nonEmptyText(input.cursor, MAX_CURSOR_LENGTH, 'cursor')
  const scope = scopeFor(query, normalizedPageSize)
  const state = decodedCursor(cursor, decodeCursor)
  if (state && state.scope !== scope) {
    invalidRequest('cursor_scope_mismatch', 'cursor does not belong to this search')
  }
  const page = state?.page ?? 1
  const upstreamQuery = {
    keyword: query,
    page: String(page),
    sort_type: 'time_descending',
    note_type: '不限',
    time_filter: '不限',
    source: 'explore_feed',
    ai_mode: '0',
  }
  if (state?.searchId) upstreamQuery.search_id = state.searchId
  if (state?.searchSessionId) upstreamQuery.search_session_id = state.searchSessionId

  return Object.freeze({
    contractVersion: XIAOHONGSHU_SEARCH_CONTRACT_VERSION,
    operation: XIAOHONGSHU_SEARCH_OPERATION,
    platform: XIAOHONGSHU_PLATFORM,
    query,
    pageSize: normalizedPageSize,
    page,
    cursor,
    cursorScope: scope,
    endpointKey: TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_KEY,
    endpointVersion: TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_VERSION,
    endpointPath: TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_PATH,
    upstreamQuery: Object.freeze(upstreamQuery),
    fingerprintBody: Object.freeze({
      contractVersion: XIAOHONGSHU_SEARCH_CONTRACT_VERSION,
      platform: XIAOHONGSHU_PLATFORM,
      query,
      pageSize: normalizedPageSize,
      page,
      continuationFingerprint: state
        ? createHash('sha256').update(JSON.stringify({
          searchId: state.searchId,
          searchSessionId: state.searchSessionId,
        })).digest('hex')
        : null,
    }),
  })
}

export function buildXiaohongshuSearchDispatch(input, options) {
  const request = normalizeXiaohongshuSearchRequest(input, options)
  return Object.freeze({
    request,
    method: 'GET',
    path: request.endpointPath,
    query: request.upstreamQuery,
  })
}

function responseText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function explicitBoolean(value) {
  if (typeof value === 'boolean') return value
  if (value === 0 || value === '0' || value === 'false') return false
  if (value === 1 || value === '1' || value === 'true') return true
  return null
}

function continuation(value, field) {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || value.length > 2_048) {
    invalidResponse('invalid_upstream_continuation', `TikHub returned an invalid ${field}`)
  }
  return value
}

function codePointBounded(value) {
  const normalized = responseText(value)
  if (!normalized) return { value: null, limited: false }
  const points = []
  let limited = false
  for (const point of normalized) {
    if (points.length === MAX_TEXT_CODE_POINTS) {
      limited = true
      break
    }
    const codePoint = point.codePointAt(0)
    points.push(codePoint >= 0xD800 && codePoint <= 0xDFFF ? '\uFFFD' : point)
  }
  return { value: points.join(''), limited }
}

function stableHttpsUrl(value) {
  if (typeof value !== 'string' || !value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

export function xiaohongshuBodyLengths(value) {
  const text = typeof value === 'string' ? value : ''
  const codePoints = [...text].length
  let graphemes = codePoints
  if (typeof Intl?.Segmenter === 'function') {
    graphemes = [...new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(text)].length
  }
  return Object.freeze({ codeUnits: text.length, codePoints, graphemes })
}

export function needsXiaohongshuDetail(value) {
  const lengths = xiaohongshuBodyLengths(value)
  return Object.values(lengths).includes(60)
}

function publicItem(note, capturedAt) {
  const providerItem = normalizeTikHubXiaohongshuNote({ data: note }, { capturedAt })
  if (!providerItem || !NOTE_ID_PATTERN.test(providerItem.externalId)) {
    invalidResponse('invalid_upstream_item', 'TikHub returned an invalid Xiaohongshu note item')
  }
  const body = codePointBounded(
    responseText(note.desc) || responseText(note.description) || responseText(note.content) || providerItem.text,
  )
  const text = body.value
  const lengths = xiaohongshuBodyLengths(text)
  const detailRequired = !body.limited && needsXiaohongshuDetail(text)
  const images = providerItem.media
    .filter((entry) => entry.type === 'image')
    .map((entry) => stableHttpsUrl(entry.url))
    .filter(Boolean)
  const normalized = Object.freeze({
    ...providerItem,
    text,
    author: Object.freeze({
      ...providerItem.author,
      avatarUrl: stableHttpsUrl(providerItem.author.avatarUrl),
    }),
    media: Object.freeze(images.map((url) => Object.freeze({ type: 'image', url }))),
  })
  return {
    publicItem: Object.freeze({
      id: normalized.id,
      externalId: normalized.externalId,
      platform: XIAOHONGSHU_PLATFORM,
      contentType: 'note',
      url: normalized.url,
      title: normalized.title,
      text,
      publishedAt: normalized.publishedAt,
      collectedAt: normalized.collectedAt,
      author: Object.freeze({ ...normalized.author }),
      metrics: Object.freeze({
        likes: normalized.metrics.liked,
        comments: normalized.metrics.comments,
        shares: normalized.metrics.shared,
        views: null,
        bookmarks: normalized.metrics.collected,
      }),
      media: Object.freeze({
        coverUrl: images[0] || null,
        images: Object.freeze(images),
        videos: Object.freeze([]),
      }),
      // The public shape remains byte-compatible with night-all.data-search.v1.
      // Provider identity is retained in lineage/archive evidence, not exposed.
      source: Object.freeze({ provider: null, endpointId: null }),
    }),
    normalized,
    bodyState: Object.freeze({
      completeness: body.limited ? 'safety_limited' : detailRequired ? 'provider_preview' : 'unverified_complete',
      lengths,
      detailRequired,
      safetyLimited: body.limited,
    }),
  }
}

function encodeNextCursor(request, data, encodeCursor) {
  if (typeof encodeCursor !== 'function') {
    invalidResponse('cursor_codec_required', 'a trusted cursor encoder is required')
  }
  const state = Object.freeze({
    version: 1,
    platform: XIAOHONGSHU_PLATFORM,
    page: request.page + 1,
    scope: request.cursorScope,
    searchId: continuation(data.search_id ?? data.searchId, 'search_id'),
    searchSessionId: continuation(
      data.search_session_id ?? data.searchSessionId,
      'search_session_id',
    ),
  })
  let cursor
  try {
    cursor = encodeCursor(state)
  } catch {
    invalidResponse('cursor_encoding_failed', 'next cursor could not be encoded')
  }
  if (typeof cursor !== 'string' || !cursor || cursor.length > MAX_CURSOR_LENGTH) {
    invalidResponse('cursor_encoding_failed', 'next cursor could not be encoded')
  }
  return cursor
}

export function normalizeTikHubXiaohongshuSearchResponse(raw, request, {
  encodeCursor,
  capturedAt = new Date(),
} = {}) {
  if (!request || request.contractVersion !== XIAOHONGSHU_SEARCH_CONTRACT_VERSION) {
    invalidResponse('invalid_normalized_request', 'a normalized Xiaohongshu search request is required')
  }
  if (!isRecord(raw) || raw.code !== 200 || !isRecord(raw.data) || !isRecord(raw.data.data)) {
    invalidResponse('invalid_upstream_contract', 'TikHub response did not match data.data.items[].note')
  }
  const data = raw.data.data
  if (!Array.isArray(data.items)) {
    invalidResponse('invalid_upstream_contract', 'TikHub response did not match data.data.items[].note')
  }
  if (data.items.length > request.pageSize) {
    invalidResponse('upstream_page_too_large', 'TikHub returned more items than the allowed page size')
  }
  let capturedAtIso
  try { capturedAtIso = new Date(capturedAt).toISOString() } catch {
    invalidResponse('invalid_captured_at', 'capturedAt must be a valid timestamp')
  }
  const normalized = data.items.map((wrapper) => {
    if (!isRecord(wrapper) || wrapper.model_type !== 'note' || !isRecord(wrapper.note)) {
      invalidResponse('invalid_upstream_contract', 'TikHub response did not match data.data.items[].note')
    }
    return publicItem(wrapper.note, capturedAtIso)
  })
  const hasMoreValue = explicitBoolean(data.has_more ?? data.hasMore)
  if (hasMoreValue == null && data.items.length > 0) {
    invalidResponse('invalid_upstream_pagination', 'TikHub response omitted an explicit has_more value')
  }
  const hasMore = data.items.length === 0 ? false : hasMoreValue
  const nextCursor = hasMore && request.page < MAX_PAGE
    ? encodeNextCursor(request, data, encodeCursor)
    : null
  const detailCandidates = normalized.flatMap(({ publicItem: item, bodyState }) => (
    bodyState.detailRequired ? [{
      externalId: item.externalId,
      url: item.url,
      lengths: bodyState.lengths,
    }] : []
  ))
  const safetyLimited = normalized.filter(({ bodyState }) => bodyState.safetyLimited).length
  const warnings = []
  if (detailCandidates.length > 0) warnings.push(Object.freeze({
    code: 'xiaohongshu_detail_required',
    message: `${detailCandidates.length} note bodies match the provider preview boundary`,
  }))
  if (safetyLimited > 0) warnings.push(Object.freeze({
    code: 'text_safety_limit_applied',
    message: `${safetyLimited} note bodies exceeded the 50000-code-point safety limit`,
  }))
  const publicBody = Object.freeze({
    data: Object.freeze({
      contractVersion: XIAOHONGSHU_SEARCH_CONTRACT_VERSION,
      platform: XIAOHONGSHU_PLATFORM,
      query: request.query,
      items: Object.freeze(normalized.map((entry) => entry.publicItem)),
      pageInfo: Object.freeze({
        pageIndex: request.page,
        pageSize: request.pageSize,
        returnedCount: normalized.length,
        hasMore: Boolean(nextCursor),
        nextCursor,
        cursorType: nextCursor ? 'opaque' : 'none',
      }),
      status: warnings.length > 0 ? 'partial' : 'ok',
      warnings: Object.freeze(warnings),
      meta: Object.freeze({
        capability: 'search_posts',
        capabilityStatus: warnings.length > 0 ? 'degraded' : 'ready',
        paginationMode: 'cursor',
        sourceProvider: null,
        endpointId: null,
        providerCalls: 1,
      }),
    }),
  })

  return Object.freeze({
    publicBody,
    items: publicBody.data.items,
    normalizedItems: Object.freeze(normalized.map((entry) => entry.normalized)),
    bodyStates: Object.freeze(normalized.map((entry) => entry.bodyState)),
    detailCandidates: Object.freeze(detailCandidates),
    page: publicBody.data.pageInfo,
    sanitizedEnvelope: redactTikHubEnvelope(raw),
  })
}
