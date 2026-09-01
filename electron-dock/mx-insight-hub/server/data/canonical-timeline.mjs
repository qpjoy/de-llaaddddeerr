import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import {
  CANONICAL_CONTEXT_DATASETS,
  DEFAULT_CANONICAL_CONTEXT_WINDOW,
  MAX_CANONICAL_CONTEXT_WINDOW,
  canonicalEventTimeCursor,
  canonicalContextUpstreamWarning,
  publicCanonicalContextItem,
} from './canonical-context.mjs'

export const CANONICAL_TIMELINE_CONTRACT = 'mx-insight-hub.canonical-timeline.v1'
export const CANONICAL_TIMELINE_CONSISTENCY = 'live-keyset'

const TIMELINE_CURSOR_VERSION = 1
const TIMELINE_CURSOR_MAX_LENGTH = 2_048
const TIMELINE_QUERY_FIELDS = new Set(['after', 'before', 'cursor'])
const TIMELINE_DIRECTIONS = new Set(['older', 'newer'])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function signaturesMatch(left, right) {
  const leftBuffer = Buffer.from(String(left))
  const rightBuffer = Buffer.from(String(right))
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function cursorSignature(payload, secret) {
  if (typeof secret !== 'string' || !secret) {
    throw new AppError(500, 'cursor_configuration_error', 'Canonical timeline cursor signing is not configured')
  }
  return createHmac('sha256', secret).update(JSON.stringify(payload)).digest('base64url')
}

function validStreamId(value) {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 256
}

function timelineCursorPayload(position) {
  return {
    v: TIMELINE_CURSOR_VERSION,
    c: CANONICAL_TIMELINE_CONTRACT,
    a: position.anchorId,
    d: position.datasetId,
    x: position.streamId,
    o: position.direction,
    t: canonicalEventTimeCursor(position.eventTime),
    id: position.id,
    n: position.pageSize,
    q: position.scopeFingerprint,
  }
}

function validTimelineCursorPayload(payload) {
  return payload?.v === TIMELINE_CURSOR_VERSION
    && payload.c === CANONICAL_TIMELINE_CONTRACT
    && UUID_PATTERN.test(payload.a || '')
    && Object.hasOwn(CANONICAL_CONTEXT_DATASETS, payload.d)
    && validStreamId(payload.x)
    && TIMELINE_DIRECTIONS.has(payload.o)
    && typeof payload.t === 'string'
    && canonicalEventTimeCursor(payload.t) === payload.t
    && UUID_PATTERN.test(payload.id || '')
    && Number.isInteger(payload.n)
    && payload.n >= 1
    && payload.n <= MAX_CANONICAL_CONTEXT_WINDOW
    && typeof payload.q === 'string'
    && payload.q.length === 43
}

export function canonicalTimelineScopeFingerprint({ tenantId, consumerId }) {
  return createHash('sha256').update(JSON.stringify({
    v: 1,
    contract: CANONICAL_TIMELINE_CONTRACT,
    tenantId,
    consumerId,
    platform: 'telegram',
  })).digest('base64url')
}

export function encodeCanonicalTimelineCursor(position, secret) {
  const payload = timelineCursorPayload(position)
  if (!validTimelineCursorPayload(payload)) {
    throw new AppError(500, 'cursor_configuration_error', 'Canonical timeline cursor position is invalid')
  }
  return Buffer.from(
    JSON.stringify({ ...payload, s: cursorSignature(payload, secret) }),
    'utf8',
  ).toString('base64url')
}

export function decodeCanonicalTimelineCursor(value, {
  anchorId,
  maxPageSize,
  scopeFingerprint,
  secret,
}) {
  try {
    if (
      typeof value !== 'string'
      || !value
      || value.length > TIMELINE_CURSOR_MAX_LENGTH
      || !/^[A-Za-z0-9_-]+$/.test(value)
      || Buffer.from(value, 'base64url').toString('base64url') !== value
    ) throw new Error('bad cursor')
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    const payload = {
      v: parsed?.v,
      c: parsed?.c,
      a: parsed?.a,
      d: parsed?.d,
      x: parsed?.x,
      o: parsed?.o,
      t: parsed?.t,
      id: parsed?.id,
      n: parsed?.n,
      q: parsed?.q,
    }
    const validKeys = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && Object.keys(parsed).sort().join(',') === 'a,c,d,id,n,o,q,s,t,v,x'
    if (
      !validKeys
      || !validTimelineCursorPayload(payload)
      || parsed.a !== anchorId
      || parsed.q !== scopeFingerprint
      || parsed.n > maxPageSize
      || typeof parsed.s !== 'string'
      || !signaturesMatch(parsed.s, cursorSignature(payload, secret))
    ) throw new Error('bad cursor')
    return {
      anchorId: parsed.a,
      datasetId: parsed.d,
      streamId: parsed.x,
      direction: parsed.o,
      boundary: { eventTime: parsed.t, id: parsed.id },
      pageSize: parsed.n,
      scopeFingerprint: parsed.q,
    }
  } catch (error) {
    if (error instanceof AppError && error.code === 'cursor_configuration_error') throw error
    throw new AppError(400, 'invalid_cursor', 'cursor is invalid for this canonical timeline')
  }
}

function timelineWindowValue(value, field, maxPageSize) {
  if (value == null) return Math.min(DEFAULT_CANONICAL_CONTEXT_WINDOW, maxPageSize)
  const normalized = typeof value === 'number' ? String(value) : value
  if (typeof normalized !== 'string' || !/^\d+$/.test(normalized)) {
    throw new AppError(
      400,
      'invalid_request',
      `${field} must be an integer between 0 and ${MAX_CANONICAL_CONTEXT_WINDOW}`,
    )
  }
  const parsed = Number(normalized)
  if (!Number.isSafeInteger(parsed)) {
    throw new AppError(400, 'invalid_request', `${field} must be a safe integer`)
  }
  if (parsed > MAX_CANONICAL_CONTEXT_WINDOW || parsed > maxPageSize) {
    throw new AppError(
      400,
      'page_size_exceeded',
      `${field} must not exceed ${Math.min(MAX_CANONICAL_CONTEXT_WINDOW, maxPageSize)}`,
    )
  }
  return parsed
}

export function normalizeCanonicalTimelineQuery(input = {}, options) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(400, 'invalid_request', 'Timeline query parameters must be an object')
  }
  const unsupported = Object.keys(input).filter((key) => !TIMELINE_QUERY_FIELDS.has(key))
  if (unsupported.length > 0) {
    throw new AppError(400, 'unsupported_fields', `Unsupported timeline fields: ${unsupported.join(', ')}`)
  }
  const maxPageSize = Math.min(MAX_CANONICAL_CONTEXT_WINDOW, options.maxPageSize)
  if (!Number.isInteger(maxPageSize) || maxPageSize < 1) {
    throw new AppError(500, 'timeline_configuration_error', 'Canonical timeline page policy is invalid')
  }
  if (Object.hasOwn(input, 'cursor')) {
    if (Object.hasOwn(input, 'before') || Object.hasOwn(input, 'after')) {
      throw new AppError(400, 'invalid_request', 'cursor cannot be combined with before or after')
    }
    return {
      mode: 'continuation',
      cursorToken: input.cursor,
      cursor: decodeCanonicalTimelineCursor(input.cursor, {
        anchorId: options.anchorId,
        maxPageSize,
        scopeFingerprint: options.scopeFingerprint,
        secret: options.cursorSecret,
      }),
    }
  }
  return {
    mode: 'initial',
    before: timelineWindowValue(input.before, 'before', maxPageSize),
    after: timelineWindowValue(input.after, 'after', maxPageSize),
    maxPageSize,
  }
}

function upstreamFields(dataset) {
  const upstreamCompleteness = { ...dataset.upstreamCompleteness }
  return {
    upstreamCompleteness,
    warnings: [canonicalContextUpstreamWarning(upstreamCompleteness)].filter(Boolean),
  }
}

function streamFields({ anchorId, anchorIndex, datasetId, streamId, items, pageInfo }) {
  const dataset = CANONICAL_CONTEXT_DATASETS[datasetId]
  return {
    contractVersion: CANONICAL_TIMELINE_CONTRACT,
    consistency: CANONICAL_TIMELINE_CONSISTENCY,
    source: 'hub',
    anchorId,
    anchorIndex,
    stream: {
      platform: 'telegram',
      datasetId,
      objectType: dataset.objectType,
      type: dataset.streamType,
      id: streamId,
    },
    items: items.map(publicCanonicalContextItem),
    pageInfo,
    ordering: {
      fields: ['eventTime', 'canonicalId'],
      direction: 'ascending',
      quality: 'deterministic',
    },
    ...upstreamFields(dataset),
  }
}

function boundaryFor(row) {
  return { eventTime: row.event_time_cursor ?? row.event_time, id: row.id }
}

function pageCursor(position, cursorSecret) {
  return encodeCanonicalTimelineCursor(position, cursorSecret)
}

export function canonicalTimelineInitialResponse({
  anchorId,
  query,
  result,
  scopeFingerprint,
  cursorSecret,
}) {
  const { current } = result
  const olderBoundary = result.before[0] ?? current
  const newerBoundary = result.after.at(-1) ?? current
  const olderPageSize = query.before || Math.min(DEFAULT_CANONICAL_CONTEXT_WINDOW, query.maxPageSize)
  const newerPageSize = query.after || Math.min(DEFAULT_CANONICAL_CONTEXT_WINDOW, query.maxPageSize)
  const basePosition = {
    anchorId,
    datasetId: current.dataset_id,
    streamId: current.context_id,
    scopeFingerprint,
  }
  return streamFields({
    anchorId,
    anchorIndex: result.before.length,
    datasetId: current.dataset_id,
    streamId: current.context_id,
    items: [...result.before, current, ...result.after],
    pageInfo: {
      mode: 'initial',
      direction: null,
      returnedCount: result.before.length + 1 + result.after.length,
      older: {
        hasMore: result.hasMoreStoredBefore,
        cursor: result.hasMoreStoredBefore
          ? pageCursor({
              ...basePosition,
              direction: 'older',
              ...boundaryFor(olderBoundary),
              pageSize: olderPageSize,
            }, cursorSecret)
          : null,
      },
      newer: {
        hasMore: result.hasMoreStoredAfter,
        cursor: pageCursor({
          ...basePosition,
          direction: 'newer',
          ...boundaryFor(newerBoundary),
          pageSize: newerPageSize,
        }, cursorSecret),
      },
    },
  })
}

export function canonicalTimelineContinuationResponse({ query, result, cursorSecret }) {
  const position = query.cursor
  const items = result.items
  let cursor = null
  if (position.direction === 'older' && result.hasMore) {
    cursor = pageCursor({
      ...position,
      ...boundaryFor(items[0]),
    }, cursorSecret)
  }
  if (position.direction === 'newer') {
    const boundary = items.at(-1) ? boundaryFor(items.at(-1)) : position.boundary
    cursor = pageCursor({ ...position, ...boundary }, cursorSecret)
  }
  const directionInfo = { hasMore: result.hasMore, cursor }
  return streamFields({
    anchorId: position.anchorId,
    anchorIndex: null,
    datasetId: position.datasetId,
    streamId: position.streamId,
    items,
    pageInfo: {
      mode: 'continuation',
      direction: position.direction,
      returnedCount: items.length,
      older: position.direction === 'older' ? directionInfo : null,
      newer: position.direction === 'newer' ? directionInfo : null,
    },
  })
}

export function canonicalTimelineCapability(servingIndexes) {
  return {
    contractVersion: CANONICAL_TIMELINE_CONTRACT,
    ready: servingIndexes?.ready === true,
    consistency: CANONICAL_TIMELINE_CONSISTENCY,
    defaultBefore: DEFAULT_CANONICAL_CONTEXT_WINDOW,
    defaultAfter: DEFAULT_CANONICAL_CONTEXT_WINDOW,
    maxBefore: MAX_CANONICAL_CONTEXT_WINDOW,
    maxAfter: MAX_CANONICAL_CONTEXT_WINDOW,
    cursor: {
      opaque: true,
      directions: ['older', 'newer'],
      newerPolling: true,
    },
    datasets: Object.entries(CANONICAL_CONTEXT_DATASETS).map(([datasetId, dataset]) => ({
      datasetId,
      objectType: dataset.objectType,
      streamType: dataset.streamType,
      ordering: ['eventTime', 'canonicalId'],
      upstreamCompleteness: { ...dataset.upstreamCompleteness },
    })),
  }
}
