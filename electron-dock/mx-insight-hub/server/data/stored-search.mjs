import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { AppError } from '../core/errors.mjs'

const ALLOWED_FIELDS = new Set([
  'cursor', 'datasetId', 'objectType', 'pageSize', 'platform', 'query',
])
const CURSOR_VERSION = 1
const SORT_VERSION = 'score-eventTime-id-or-eventTime-id-v1'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PUBLIC_METRICS = ['likes', 'comments', 'shares', 'views', 'bookmarks', 'members']

function stringValue(value, field, maxLength, { required = false } = {}) {
  if (value == null) {
    if (required) throw new AppError(400, 'invalid_request', `${field} is required`)
    return null
  }
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new AppError(
      400,
      'invalid_request',
      `${field} must be a non-blank string of at most ${maxLength} characters`,
    )
  }
  return value.trim()
}

function pageSizeValue(value, maxPageSize) {
  const pageSize = value == null ? Math.min(20, maxPageSize) : value
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new AppError(400, 'invalid_request', 'pageSize must be a positive integer')
  }
  if (pageSize > maxPageSize) {
    throw new AppError(400, 'page_size_exceeded', `pageSize must not exceed ${maxPageSize}`)
  }
  return pageSize
}

function queryBinding(query) {
  return createHash('sha256')
    .update(JSON.stringify({
      v: CURSOR_VERSION,
      sort: SORT_VERSION,
      query: query.query,
      platform: query.platform,
      datasetId: query.datasetId,
      objectType: query.objectType,
      pageSize: query.pageSize,
    }))
    .digest('base64url')
}

function cursorSignature(payload, secret) {
  if (typeof secret !== 'string' || !secret) {
    throw new AppError(500, 'cursor_configuration_error', 'Stored search cursor signing is not configured')
  }
  return createHmac('sha256', secret).update(JSON.stringify(payload)).digest('base64url')
}

function signaturesMatch(left, right) {
  const leftBuffer = Buffer.from(String(left))
  const rightBuffer = Buffer.from(String(right))
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function validSearchAfter(mode, value) {
  if (!Array.isArray(value)) return false
  if (mode === 'postgres') {
    if (value.length !== 2 || !UUID_PATTERN.test(value[1] || '')) return false
    if (value[0] === null) return true
    if (typeof value[0] !== 'string' || value[0].length > 128) return false
    return new Date(value[0]).toISOString() === value[0]
  }
  if (value.length !== 3 || !Number.isFinite(value[0]) || !UUID_PATTERN.test(value[2] || '')) {
    return false
  }
  return value[1] === null || Number.isFinite(value[1]) || (
    typeof value[1] === 'string' && value[1].length <= 128
  )
}

export function encodeStoredSearchCursor({ mode, pitId = null, searchAfter, seen }, binding, secret) {
  const payload = {
    v: CURSOR_VERSION,
    m: mode,
    p: pitId,
    a: searchAfter,
    n: seen,
    q: binding,
  }
  return Buffer.from(
    JSON.stringify({ ...payload, s: cursorSignature(payload, secret) }),
    'utf8',
  ).toString('base64url')
}

export function decodeStoredSearchCursor(value, binding, secret) {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    const validKeys = parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
      Object.keys(parsed).sort().join(',') === 'a,m,n,p,q,s,v'
    const payload = {
      v: parsed?.v,
      m: parsed?.m,
      p: parsed?.p,
      a: parsed?.a,
      n: parsed?.n,
      q: parsed?.q,
    }
    const validMode = parsed?.m === 'elasticsearch' || parsed?.m === 'postgres'
    const validPit = parsed?.m === 'elasticsearch'
      ? typeof parsed?.p === 'string' && parsed.p.length > 0 && parsed.p.length <= 4_096
      : parsed?.p === null
    if (
      !validKeys || parsed?.v !== CURSOR_VERSION || !validMode || !validPit ||
      !validSearchAfter(parsed.m, parsed.a) || !Number.isSafeInteger(parsed?.n) || parsed.n < 1 ||
      parsed?.q !== binding || typeof parsed?.s !== 'string' ||
      !signaturesMatch(parsed.s, cursorSignature(payload, secret))
    ) {
      throw new Error('bad cursor')
    }
    return {
      mode: parsed.m,
      pitId: parsed.p,
      searchAfter: [...parsed.a],
      seen: parsed.n,
    }
  } catch {
    throw new AppError(400, 'invalid_cursor', 'cursor is invalid; return the previous search cursor unchanged')
  }
}

export function normalizeStoredSearchQuery(input, maxPageSize = 100, cursorSecret) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(400, 'invalid_request', 'JSON object body is required')
  }
  const unsupported = Object.keys(input).filter((field) => !ALLOWED_FIELDS.has(field))
  if (unsupported.length > 0) {
    throw new AppError(400, 'unsupported_fields', `Unsupported stored search fields: ${unsupported.join(', ')}`)
  }
  const validPolicyMax = Number.isInteger(maxPageSize) && maxPageSize > 0 ? maxPageSize : 100
  const normalized = {
    query: stringValue(input.query, 'query', 500, { required: true }),
    platform: stringValue(input.platform, 'platform', 64, { required: true }),
    datasetId: stringValue(input.datasetId, 'datasetId', 200),
    objectType: stringValue(input.objectType, 'objectType', 100),
    pageSize: pageSizeValue(input.pageSize, Math.min(100, validPolicyMax)),
  }
  const cursorBinding = queryBinding(normalized)
  const cursorToken = stringValue(input.cursor, 'cursor', 8_192)
  return {
    ...normalized,
    cursorBinding,
    cursorToken,
    cursor: decodeStoredSearchCursor(
      cursorToken,
      cursorBinding,
      cursorSecret,
    ),
  }
}

function isoDate(value) {
  if (value == null) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function publicMetrics(metrics) {
  return Object.fromEntries(PUBLIC_METRICS.map((key) => {
    const value = metrics?.[key]
    return [key, typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null]
  }))
}

export function publicStoredSearchItem(row) {
  return {
    id: row.id,
    datasetId: row.datasetId,
    platform: row.platform,
    objectType: row.objectType,
    contentType: row.contentType ?? null,
    externalId: row.externalId,
    url: row.url ?? null,
    title: row.title ?? null,
    text: row.body ?? null,
    author: {
      id: row.authorExternalId ?? null,
      name: row.authorName ?? null,
      username: row.authorHandle ?? null,
    },
    metrics: publicMetrics(row.metrics),
    eventTime: isoDate(row.eventTime),
    collectedAt: isoDate(row.collectedAt),
    score: typeof row.score === 'number' && Number.isFinite(row.score) ? row.score : null,
    source: 'hub',
  }
}

export function storedSearchResponse({ query, result, durationMs, cursorSecret }) {
  const items = (result.items || []).map(publicStoredSearchItem)
  const seen = query.cursor?.seen ?? 0
  const hasMore = Boolean(result.hasMore)
  return {
    data: {
      contractVersion: 'mx-insight-hub.stored-search.v1',
      source: 'hub',
      query: query.query,
      filters: {
        platform: query.platform,
        datasetId: query.datasetId,
        objectType: query.objectType,
      },
      items,
      pageInfo: {
        pageIndex: Math.floor(seen / query.pageSize) + 1,
        pageSize: query.pageSize,
        returnedCount: items.length,
        hasMore,
        nextCursor: hasMore
          ? encodeStoredSearchCursor(
              { ...result.nextCursor, seen: seen + items.length },
              query.cursorBinding,
              cursorSecret,
            )
          : null,
        cursorType: hasMore ? 'opaque' : 'none',
      },
      searchMode: result.mode,
      warnings: result.mode === 'postgres'
        ? [{
            code: 'search_projection_degraded',
            message: 'Elasticsearch unavailable or disabled; PostgreSQL substring search was used.',
          }]
        : [],
      durationMs,
    },
  }
}
