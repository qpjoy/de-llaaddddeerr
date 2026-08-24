import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { normalizeChinaProvince } from './china-provinces.mjs'

export const PUBLIC_OPINION_PLATFORM = 'public_opinion'
export const PUBLIC_OPINION_DATASET_ID = 'public-opinion.province.v1'
export const PUBLIC_OPINION_OBJECT_TYPE = 'opinion_item'

const ALLOWED_QUERY_FIELDS = new Set(['cursor', 'from', 'pageSize', 'sort', 'to'])
const SORTS = new Set(['hot', 'latest'])
const CURSOR_VERSION = 2
const MAX_CURSOR_LENGTH = 8_192
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ISO_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/

function timestampValue(value, field) {
  if (value == null) return null
  if (typeof value !== 'string' || !ISO_DATE_TIME_PATTERN.test(value)) {
    throw new AppError(400, 'invalid_request', `${field} must be an ISO date-time`)
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(400, 'invalid_request', `${field} must be an ISO date-time`)
  }
  return parsed.toISOString()
}

function pageSizeValue(value, maxPageSize) {
  if (value == null) return Math.min(20, maxPageSize)
  if (!/^\d+$/.test(String(value))) {
    throw new AppError(400, 'invalid_request', 'pageSize must be a positive integer')
  }
  const pageSize = Number(value)
  if (pageSize < 1 || pageSize > Math.min(100, maxPageSize)) {
    throw new AppError(400, 'page_size_exceeded', `pageSize must be between 1 and ${Math.min(100, maxPageSize)}`)
  }
  return pageSize
}

function bindingFor(query) {
  return createHash('sha256').update(JSON.stringify({
    v: CURSOR_VERSION,
    platform: PUBLIC_OPINION_PLATFORM,
    datasetId: PUBLIC_OPINION_DATASET_ID,
    objectType: PUBLIC_OPINION_OBJECT_TYPE,
    provinceCode: query.province.code,
    sort: query.sort,
    from: query.from,
    to: query.to,
    pageSize: query.pageSize,
  })).digest('base64url')
}

function signature(payload, secret) {
  if (typeof secret !== 'string' || !secret) {
    throw new AppError(500, 'cursor_configuration_error', 'Province opinion cursor signing is not configured')
  }
  return createHmac('sha256', secret).update(JSON.stringify(payload)).digest('base64url')
}

function signaturesMatch(left, right) {
  const leftBuffer = Buffer.from(String(left))
  const rightBuffer = Buffer.from(String(right))
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function cursorPayload(position, binding) {
  return {
    v: CURSOR_VERSION,
    q: binding,
    h: position.heatScore ?? null,
    t: position.sortTime,
    c: position.collectedAt ?? null,
    id: position.id,
  }
}

export function encodePublicOpinionCursor(position, binding, secret) {
  const payload = cursorPayload(position, binding)
  return Buffer.from(JSON.stringify({ ...payload, s: signature(payload, secret) }), 'utf8').toString('base64url')
}

export function decodePublicOpinionCursor(value, { sort, binding, secret }) {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    const payload = {
      v: parsed?.v,
      q: parsed?.q,
      h: parsed?.h,
      t: parsed?.t,
      c: parsed?.c,
      id: parsed?.id,
    }
    const validKeys = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && Object.keys(parsed).sort().join(',') === 'c,h,id,q,s,t,v'
    const validSortTime = typeof parsed?.t === 'string'
      && new Date(parsed.t).toISOString() === parsed.t
    const validCollected = sort === 'latest'
      ? typeof parsed?.c === 'string' && new Date(parsed.c).toISOString() === parsed.c
      : parsed?.c === null
    const validHeat = sort === 'hot'
      ? typeof parsed?.h === 'string' && /^-?\d+(?:\.\d+)?$/.test(parsed.h)
      : parsed?.h === null
    if (
      !validKeys || parsed.v !== CURSOR_VERSION || parsed.q !== binding
      || !validSortTime || !validCollected || !validHeat || !UUID_PATTERN.test(parsed.id || '')
      || typeof parsed.s !== 'string' || !signaturesMatch(parsed.s, signature(payload, secret))
    ) throw new Error('bad cursor')
    return {
      heatScore: parsed.h,
      sortTime: parsed.t,
      collectedAt: parsed.c,
      id: parsed.id,
    }
  } catch {
    throw new AppError(400, 'invalid_cursor', 'cursor is invalid; return the previous page cursor unchanged')
  }
}

export function normalizePublicOpinionQuery(provinceInput, input = {}, maxPageSize = 100, cursorSecret) {
  const province = normalizeChinaProvince(provinceInput)
  if (!province) {
    throw new AppError(400, 'invalid_province', 'province must be a supported ISO 3166-2:CN code or province name')
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(400, 'invalid_request', 'query parameters must be an object')
  }
  const unsupported = Object.keys(input).filter((field) => !ALLOWED_QUERY_FIELDS.has(field))
  if (unsupported.length > 0) {
    throw new AppError(400, 'unsupported_fields', `Unsupported province opinion fields: ${unsupported.join(', ')}`)
  }
  const sort = input.sort == null ? 'hot' : String(input.sort).trim()
  if (!SORTS.has(sort)) throw new AppError(400, 'invalid_sort', 'sort must be hot or latest')
  const from = timestampValue(input.from, 'from')
  const to = timestampValue(input.to, 'to')
  if (from && to && from > to) throw new AppError(400, 'invalid_request', 'from must not be later than to')
  const validPolicyMax = Number.isInteger(maxPageSize) && maxPageSize > 0 ? maxPageSize : 100
  const normalized = {
    province,
    sort,
    from,
    to,
    pageSize: pageSizeValue(input.pageSize, validPolicyMax),
  }
  const cursorBinding = bindingFor(normalized)
  if (input.cursor != null && typeof input.cursor !== 'string') {
    throw new AppError(400, 'invalid_request', 'cursor must be a string')
  }
  if (input.cursor?.length > MAX_CURSOR_LENGTH) {
    throw new AppError(400, 'invalid_cursor', `cursor must not exceed ${MAX_CURSOR_LENGTH} characters`)
  }
  const cursorToken = input.cursor == null ? null : input.cursor.trim()
  if (input.cursor != null && !cursorToken) {
    throw new AppError(400, 'invalid_request', 'cursor must be a non-blank string')
  }
  return {
    ...normalized,
    cursorBinding,
    cursorToken,
    cursor: decodePublicOpinionCursor(cursorToken, { sort, binding: cursorBinding, secret: cursorSecret }),
  }
}

function iso(value) {
  return value == null ? null : new Date(value).toISOString()
}

function numberValue(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function publicOpinionItem(row) {
  const province = normalizeChinaProvince(row.admin1_code)
  const attributes = row.stable_fields?.attributes || {}
  return {
    id: row.id,
    title: row.title ?? null,
    summary: row.body ?? null,
    url: row.url ?? null,
    publishedAt: iso(row.event_time),
    collectedAt: iso(row.collected_at),
    province: province ? { code: province.code, name: province.name } : null,
    heatScore: numberValue(row.heat_score),
    origin: {
      name: row.author_name ?? null,
      type: typeof attributes.sourceType === 'string' ? attributes.sourceType : row.content_type ?? null,
      platform: typeof attributes.sourcePlatform === 'string' ? attributes.sourcePlatform : null,
    },
  }
}

export function publicOpinionPage(rows, query, cursorSecret) {
  const hasMore = rows.length > query.pageSize
  const pageRows = hasMore ? rows.slice(0, query.pageSize) : rows
  const last = pageRows.at(-1)
  const nextPosition = !last ? null : query.sort === 'hot'
    ? {
        heatScore: String(last.heat_score),
        sortTime: iso(last.sort_time ?? last.event_time ?? last.collected_at),
        collectedAt: null,
        id: last.id,
      }
    : {
        heatScore: null,
        sortTime: iso(last.sort_time ?? last.event_time ?? last.collected_at),
        collectedAt: iso(last.collected_at),
        id: last.id,
      }
  return {
    contractVersion: 'mx-insight-hub.public-opinion.v1',
    province: { code: query.province.code, name: query.province.name },
    sort: query.sort,
    items: pageRows.map(publicOpinionItem),
    pageInfo: {
      returnedCount: pageRows.length,
      hasMore,
      nextCursor: hasMore && nextPosition
        ? encodePublicOpinionCursor(nextPosition, query.cursorBinding, cursorSecret)
        : null,
    },
  }
}

export function normalizePublicOpinionItemId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new AppError(400, 'invalid_request', 'item id must be a UUID')
  }
  return value
}
