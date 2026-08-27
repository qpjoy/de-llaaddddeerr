import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import {
  adminPublicOpinionBrowseResponse,
  normalizeAdminPublicOpinionBrowseQuery,
} from './admin-data-products.mjs'

const CONTRACT_VERSION = 'mx-insight-hub.data-products.public-opinion-records.v1'
const CURSOR_VERSION = 1
const MAX_CURSOR_LENGTH = 2_048
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function cursorBinding(query) {
  return createHash('sha256').update(JSON.stringify({
    v: CURSOR_VERSION,
    contract: CONTRACT_VERSION,
    from: query.from,
    to: query.to,
    query: query.query,
    reason: query.reason,
    stage: query.stage,
    status: query.status,
    province: query.province,
    scope: query.scope,
    time: query.time,
    heat: query.heat,
    pageSize: query.pageSize,
  })).digest('base64url')
}

function signature(payload, secret) {
  if (typeof secret !== 'string' || !secret) {
    throw new AppError(
      500,
      'cursor_configuration_error',
      'Public-opinion diagnostics cursor signing is not configured',
    )
  }
  return createHmac('sha256', secret).update(JSON.stringify(payload)).digest('base64url')
}

function signaturesMatch(left, right) {
  const leftBuffer = Buffer.from(String(left))
  const rightBuffer = Buffer.from(String(right))
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function cursorPayload(position, binding) {
  const sortTime = new Date(position.sortTime).toISOString()
  if (!UUID_PATTERN.test(position.id || '')) {
    throw new AppError(500, 'cursor_configuration_error', 'Public-opinion diagnostics cursor row is invalid')
  }
  return { v: CURSOR_VERSION, q: binding, t: sortTime, id: position.id }
}

export function encodePublicOpinionDiagnosticsCursor(position, binding, secret) {
  const payload = cursorPayload(position, binding)
  return Buffer.from(
    JSON.stringify({ ...payload, s: signature(payload, secret) }),
    'utf8',
  ).toString('base64url')
}

export function decodePublicOpinionDiagnosticsCursor(value, binding, secret) {
  if (!value) return null
  try {
    if (
      typeof value !== 'string'
      || value.length > MAX_CURSOR_LENGTH
      || !/^[A-Za-z0-9_-]+$/.test(value)
      || Buffer.from(value, 'base64url').toString('base64url') !== value
    ) throw new Error('bad cursor')
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    const payload = {
      v: parsed?.v,
      q: parsed?.q,
      t: parsed?.t,
      id: parsed?.id,
    }
    const validKeys = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && Object.keys(parsed).sort().join(',') === 'id,q,s,t,v'
    const validSortTime = typeof parsed?.t === 'string'
      && new Date(parsed.t).toISOString() === parsed.t
    if (
      !validKeys
      || parsed.v !== CURSOR_VERSION
      || parsed.q !== binding
      || !validSortTime
      || !UUID_PATTERN.test(parsed.id || '')
      || typeof parsed.s !== 'string'
      || !signaturesMatch(parsed.s, signature(payload, secret))
    ) throw new Error('bad cursor')
    return { sortTime: parsed.t, id: parsed.id }
  } catch {
    throw new AppError(400, 'invalid_cursor', 'cursor is invalid for this diagnostics query')
  }
}

export function normalizePublicOpinionDiagnosticsBrowseQuery(
  input = {},
  maxPageSize = 100,
  cursorSecret,
  now = new Date(),
) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(400, 'invalid_request', 'public-opinion diagnostics query must be an object')
  }
  const { cursor: rawCursor, ...withoutCursor } = input
  const validMaxPageSize = Number.isInteger(maxPageSize) && maxPageSize > 0
    ? Math.min(100, maxPageSize)
    : 100
  const query = normalizeAdminPublicOpinionBrowseQuery({
    ...withoutCursor,
    pageSize: withoutCursor.pageSize ?? Math.min(50, validMaxPageSize),
  }, now)
  if (query.pageSize > validMaxPageSize) {
    throw new AppError(
      400,
      'page_size_exceeded',
      `pageSize must not exceed ${validMaxPageSize}`,
    )
  }
  if (rawCursor != null && (typeof rawCursor !== 'string' || !rawCursor.trim())) {
    throw new AppError(400, 'invalid_request', 'cursor must be a non-blank string')
  }
  if (typeof rawCursor === 'string' && rawCursor.length > MAX_CURSOR_LENGTH) {
    throw new AppError(400, 'invalid_cursor', `cursor must not exceed ${MAX_CURSOR_LENGTH} characters`)
  }
  const cursorToken = rawCursor == null ? null : rawCursor.trim()
  const binding = cursorBinding(query)
  return {
    ...query,
    cursorBinding: binding,
    cursorToken,
    cursor: decodePublicOpinionDiagnosticsCursor(cursorToken, binding, cursorSecret),
  }
}

export function publicOpinionDiagnosticsBrowseResponse(rows, query, cursorSecret) {
  const response = adminPublicOpinionBrowseResponse(rows, query)
  const hasMore = rows.length > query.pageSize
  const last = (hasMore ? rows.slice(0, query.pageSize) : rows).at(-1)
  const publicResponse = {
    ...response,
    contractVersion: CONTRACT_VERSION,
    pageInfo: {
      ...response.pageInfo,
      nextCursor: hasMore && last
        ? encodePublicOpinionDiagnosticsCursor(
            { sortTime: last.sort_time, id: last.id },
            query.cursorBinding,
            cursorSecret,
          )
        : null,
    },
  }
  delete publicResponse.demoMode
  return publicResponse
}
