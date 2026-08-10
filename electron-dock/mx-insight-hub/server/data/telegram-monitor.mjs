import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { AppError } from '../core/errors.mjs'

// Stable public resources backed by the two server-side Telegram monitor
// tables. Dataset ids are Hub-owned names: neither the upstream database nor
// its physical table names are part of the consumer contract.
export const TELEGRAM_MONITOR_RESOURCES = Object.freeze({
  chats: Object.freeze({ datasetId: 'telegram.monitor.chats.v1', objectType: 'chat' }),
  messages: Object.freeze({ datasetId: 'telegram.monitor.messages.v1', objectType: 'message' }),
})

const ALLOWED_QUERY_FIELDS = new Set(['chatId', 'cursor', 'from', 'pageSize', 'to'])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ISO_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/
const PUBLIC_METRICS = Object.freeze({
  likes: 'number', comments: 'number', shares: 'number', views: 'number', bookmarks: 'number', members: 'number',
})
const PUBLIC_ATTRIBUTES = Object.freeze({
  username: 'string', chatType: 'string', memberCount: 'number', isOutgoing: 'boolean',
})
const PUBLIC_RELATIONS = Object.freeze({
  chatId: 'string', messageId: 'string', replyToMessageId: 'string', threadId: 'string', groupedId: 'string',
})
const PUBLIC_MEDIA = Object.freeze({
  media_kind: 'string', status: 'string', telegram_id: 'string', file_name: 'string',
  extension: 'string', mime_type: 'string', size_bytes: 'number',
})
const PUBLIC_ENTITY = Object.freeze({
  type: 'string', offset: 'number', length: 'number', url: 'string', user_id: 'number',
})
const SEARCH_SCOPES = new Set(['messages', 'chats', 'all'])
const SEARCH_FIELDS = new Set(['authorId', 'chatId', 'cursor', 'from', 'matchMode', 'pageSize', 'query', 'scope', 'to'])
const ENTITY_SEARCH_FIELDS = new Set(['query', 'pageSize'])

function stringValue(value, field, maxLength) {
  if (value == null) return null
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new AppError(400, 'invalid_request', `${field} must be a non-blank string of at most ${maxLength} characters`)
  }
  return value.trim()
}

function timestampValue(value, field) {
  if (value == null) return null
  if (typeof value !== 'string') {
    throw new AppError(400, 'invalid_request', `${field} must be an ISO date-time`)
  }
  const match = ISO_DATE_TIME_PATTERN.exec(value)
  if (!match) {
    throw new AppError(400, 'invalid_request', `${field} must be an ISO date-time`)
  }
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match
  const datePartsAreValid = Number(month) >= 1
    && Number(month) <= 12
    && Number(day) >= 1
    && Number(day) <= new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate()
    && Number(hour) <= 23
    && Number(minute) <= 59
    && Number(second) <= 59
    && (offsetHour == null || (Number(offsetHour) <= 23 && Number(offsetMinute) <= 59))
  if (!datePartsAreValid) {
    throw new AppError(400, 'invalid_request', `${field} must be an ISO date-time`)
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(400, 'invalid_request', `${field} must be an ISO date-time`)
  }
  return parsed.toISOString()
}

function pageSizeValue(value, maxPageSize) {
  if (value == null) return Math.min(50, maxPageSize)
  if (!/^\d+$/.test(String(value))) {
    throw new AppError(400, 'invalid_request', 'pageSize must be a positive integer')
  }
  const pageSize = Number(value)
  if (pageSize < 1 || pageSize > maxPageSize) {
    throw new AppError(400, 'page_size_exceeded', `pageSize must be between 1 and ${maxPageSize}`)
  }
  return pageSize
}

export function telegramMonitorResource(name) {
  const resource = TELEGRAM_MONITOR_RESOURCES[name]
  if (!resource) {
    throw new AppError(404, 'resource_not_found', 'Telegram resource must be chats or messages')
  }
  return resource
}

export function encodeTelegramCursor({ sortTime, id }) {
  return Buffer.from(JSON.stringify({ v: 1, t: new Date(sortTime).toISOString(), id }), 'utf8').toString('base64url')
}

export function decodeTelegramCursor(value) {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    const date = new Date(parsed?.t)
    if (parsed?.v !== 1 || Number.isNaN(date.getTime()) || !UUID_PATTERN.test(parsed?.id || '')) throw new Error('bad cursor')
    return { sortTime: date.toISOString(), id: parsed.id }
  } catch {
    throw new AppError(400, 'invalid_cursor', 'cursor is invalid; return the previous page cursor unchanged')
  }
}

const SEARCH_CURSOR_VERSION = 2
const SEARCH_SORT_VERSION = 'es-score-eventTime-id-sharddoc-pg-eventTime-id-v2'

function telegramSearchBinding(query) {
  return createHash('sha256')
    .update(JSON.stringify({
      v: SEARCH_CURSOR_VERSION,
      sort: SEARCH_SORT_VERSION,
      query: query.query,
      scope: query.scope,
      matchMode: query.matchMode,
      chatId: query.chatId,
      authorId: query.authorId,
      from: query.from,
      to: query.to,
      pageSize: query.pageSize,
    }))
    .digest('base64url')
}

function cursorSignature(payload, secret) {
  if (typeof secret !== 'string' || !secret) {
    throw new AppError(500, 'cursor_configuration_error', 'Telegram search cursor signing is not configured')
  }
  return createHmac('sha256', secret).update(JSON.stringify(payload)).digest('base64url')
}

function signaturesMatch(left, right) {
  const leftBuffer = Buffer.from(String(left))
  const rightBuffer = Buffer.from(String(right))
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

export function encodeTelegramSearchCursor({ mode, pitId = null, searchAfter, seen }, binding, secret) {
  const payload = {
    v: SEARCH_CURSOR_VERSION,
    m: mode,
    p: pitId,
    a: searchAfter,
    n: seen,
    q: binding,
  }
  return Buffer.from(JSON.stringify({ ...payload, s: cursorSignature(payload, secret) }), 'utf8').toString('base64url')
}

export function decodeTelegramSearchCursor(value, binding, secret) {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    const validKeys = parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
      Object.keys(parsed).sort().join(',') === 'a,m,n,p,q,s,v'
    const payload = { v: parsed?.v, m: parsed?.m, p: parsed?.p, a: parsed?.a, n: parsed?.n, q: parsed?.q }
    const validMode = parsed?.m === 'elasticsearch' || parsed?.m === 'postgres'
    const validPit = parsed?.m === 'elasticsearch'
      ? typeof parsed?.p === 'string' && parsed.p.length > 0 && parsed.p.length <= 4_096
      : parsed?.p === null
    const validSort = parsed?.m === 'elasticsearch'
      ? Array.isArray(parsed?.a) && parsed.a.length === 4 &&
        Number.isFinite(parsed.a[0]) && Number.isFinite(parsed.a[3])
      : Array.isArray(parsed?.a) && parsed.a.length === 2
    const sortTime = parsed?.a?.[parsed?.m === 'elasticsearch' ? 1 : 0]
    const id = parsed?.a?.[parsed?.m === 'elasticsearch' ? 2 : 1]
    const validTime = parsed?.m === 'elasticsearch'
      ? sortTime === null || Number.isFinite(sortTime) || (typeof sortTime === 'string' && sortTime.length <= 128)
      : sortTime === null || (typeof sortTime === 'string' && new Date(sortTime).toISOString() === sortTime)
    if (
      !validKeys || parsed?.v !== SEARCH_CURSOR_VERSION || !validMode || !validPit ||
      !validSort || !validTime ||
      !UUID_PATTERN.test(id || '') || !Number.isSafeInteger(parsed?.n) || parsed.n < 1 ||
      parsed?.q !== binding || typeof parsed?.s !== 'string' ||
      !signaturesMatch(parsed.s, cursorSignature(payload, secret))
    ) {
      throw new Error('bad cursor')
    }
    return {
      mode: parsed.m,
      pitId: parsed.p,
      searchAfter: parsed.m === 'elasticsearch'
        ? [...parsed.a]
        : [sortTime, id],
      seen: parsed.n,
    }
  } catch {
    throw new AppError(400, 'invalid_cursor', 'cursor is invalid; return the previous search cursor unchanged')
  }
}

/** Validate the richer Hub-local Telegram search contract. */
export function normalizeTelegramSearchQuery(input, maxPageSize = 100, cursorSecret) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(400, 'invalid_request', 'JSON object body is required')
  }
  const unsupported = Object.keys(input).filter((key) => !SEARCH_FIELDS.has(key))
  if (unsupported.length > 0) {
    throw new AppError(400, 'unsupported_fields', `Unsupported Telegram search fields: ${unsupported.join(', ')}`)
  }
  const query = stringValue(input.query, 'query', 500)
  if (!query) throw new AppError(400, 'invalid_request', 'query is required')
  const scope = input.scope == null ? 'messages' : stringValue(input.scope, 'scope', 16)
  if (!SEARCH_SCOPES.has(scope)) {
    throw new AppError(400, 'invalid_request', 'scope must be messages, chats, or all')
  }
  const matchMode = input.matchMode == null ? 'full_text' : stringValue(input.matchMode, 'matchMode', 32)
  if (matchMode !== 'full_text') {
    throw new AppError(400, 'unsupported_match_mode', 'Only full_text is currently supported for content search')
  }
  const from = timestampValue(input.from, 'from')
  const to = timestampValue(input.to, 'to')
  if (from && to && from > to) throw new AppError(400, 'invalid_request', 'from must not be later than to')
  const validPolicyMax = Number.isInteger(maxPageSize) && maxPageSize > 0 ? maxPageSize : 100
  const normalized = {
    query,
    scope,
    matchMode,
    chatId: stringValue(input.chatId, 'chatId', 256),
    authorId: stringValue(input.authorId, 'authorId', 256),
    from,
    to,
    pageSize: pageSizeValue(input.pageSize, Math.min(100, validPolicyMax)),
  }
  const cursorBinding = telegramSearchBinding(normalized)
  return {
    ...normalized,
    cursorBinding,
    cursor: decodeTelegramSearchCursor(
      stringValue(input.cursor, 'cursor', 8192),
      cursorBinding,
      cursorSecret,
    ),
  }
}

export function normalizeTelegramEntityQuery(input, maxPageSize = 100) {
  const unsupported = Object.keys(input || {}).filter((key) => !ENTITY_SEARCH_FIELDS.has(key))
  if (unsupported.length > 0) {
    throw new AppError(400, 'unsupported_fields', `Unsupported Telegram entity search fields: ${unsupported.join(', ')}`)
  }
  const query = stringValue(input?.query, 'query', 200)
  if (!query) throw new AppError(400, 'invalid_request', 'query is required')
  const validPolicyMax = Number.isInteger(maxPageSize) && maxPageSize > 0 ? maxPageSize : 100
  return {
    query,
    pageSize: pageSizeValue(input?.pageSize, Math.min(100, validPolicyMax)),
  }
}

/** Validate the complete public query allowlist before it reaches SQL. */
export function normalizeTelegramMonitorQuery(input, maxPageSize = 100) {
  const unsupported = Object.keys(input || {}).filter((key) => !ALLOWED_QUERY_FIELDS.has(key))
  if (unsupported.length > 0) {
    throw new AppError(400, 'unsupported_fields', `Unsupported query fields: ${unsupported.join(', ')}`)
  }
  const from = timestampValue(input?.from, 'from')
  const to = timestampValue(input?.to, 'to')
  if (from && to && from > to) throw new AppError(400, 'invalid_request', 'from must not be later than to')
  const validPolicyMax = Number.isInteger(maxPageSize) && maxPageSize > 0 ? maxPageSize : 100
  const effectiveMax = Math.min(100, validPolicyMax)
  return {
    chatId: stringValue(input?.chatId, 'chatId', 256),
    from,
    to,
    pageSize: pageSizeValue(input?.pageSize, effectiveMax),
    cursor: decodeTelegramCursor(stringValue(input?.cursor, 'cursor', 1024)),
  }
}

function safeObject(source, schema) {
  const result = {}
  for (const [key, expectedType] of Object.entries(schema)) {
    const value = source?.[key]
    if (
      value !== null && value !== undefined &&
      typeof value === expectedType &&
      (expectedType !== 'number' || Number.isFinite(value))
    ) {
      result[key] = value
    }
  }
  return result
}

function safeMedia(source) {
  return safeObject(source, PUBLIC_MEDIA)
}

function safeEntities(source) {
  if (!Array.isArray(source)) return []
  return source.slice(0, 200).map((entity) => safeObject(entity, PUBLIC_ENTITY))
}

/**
 * Deliberate allowlist for the public record shape.
 *
 * `extensions`, raw payloads, connector ids and source lineage never enter the
 * response, even when the foreign row contains an innocuous-looking wrapper
 * around credentials or provider metadata.
 */
export function publicTelegramMonitorRecord(row) {
  const stable = row.stable_fields || {}
  return {
    id: row.external_id,
    externalId: row.external_id,
    platform: 'telegram',
    objectType: row.object_type,
    contentType: row.content_type ?? null,
    title: row.title ?? null,
    text: row.body ?? null,
    url: row.url ?? null,
    author: {
      id: row.author_external_id ?? null,
      name: row.author_name ?? null,
      username: stable.attributes?.username ?? stable.author?.handle ?? null,
    },
    relations: safeObject(stable.relations, PUBLIC_RELATIONS),
    attributes: safeObject(stable.attributes, PUBLIC_ATTRIBUTES),
    metrics: safeObject(stable.metrics, PUBLIC_METRICS),
    media: safeMedia(stable.media),
    entities: safeEntities(stable.entities),
    // The production probe proved only that `links` is an array; it did not
    // establish a field-level contract for the objects inside it. Returning
    // them verbatim would turn any future collector-only field into a public
    // API field. Keep the slot stable but empty until an explicit allowlist is
    // backed by source-schema evidence.
    links: [],
    eventTime: row.event_time ? new Date(row.event_time).toISOString() : null,
    collectedAt: row.collected_at ? new Date(row.collected_at).toISOString() : null,
    editedAt: stable.editedAt ? new Date(stable.editedAt).toISOString() : null,
    lineage: {
      datasetId: row.dataset_id,
      origin: stable.source?.origin === 'database' ? 'hub-direct' : 'hub-import',
    },
    dataVersion: String(row.current_revision ?? 1),
  }
}

export function publicTelegramMonitorPage(rows, pageSize) {
  const hasMore = rows.length > pageSize
  const pageRows = hasMore ? rows.slice(0, pageSize) : rows
  const last = pageRows.at(-1)
  return {
    items: pageRows.map(publicTelegramMonitorRecord),
    pageInfo: {
      returnedCount: pageRows.length,
      hasMore,
      nextCursor: hasMore && last
        ? encodeTelegramCursor({ sortTime: last.sort_time, id: last.id })
        : null,
    },
  }
}

/** Convert the customer-safe search projection into Night-All data-search v1. */
export function telegramDataSearchResponse({
  query,
  result,
  pageSize,
  cursor,
  cursorBinding,
  cursorSecret,
  durationMs,
}) {
  const rows = result.items || []
  const items = rows.map((row) => ({
    id: row.id,
    externalId: row.externalId,
    platform: 'telegram',
    contentType: row.contentType ?? row.objectType ?? 'message',
    url: row.url ?? null,
    title: row.title ?? null,
    text: row.body ?? null,
    publishedAt: row.eventTime ? new Date(row.eventTime).toISOString() : null,
    collectedAt: row.collectedAt ? new Date(row.collectedAt).toISOString() : null,
    author: {
      id: row.authorExternalId ?? null,
      name: row.authorName ?? null,
      avatarUrl: row.authorAvatarUrl ?? null,
    },
    metrics: Object.fromEntries(
      ['likes', 'comments', 'shares', 'views', 'bookmarks'].map((key) => {
        const value = row.metrics?.[key]
        return [key, typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null]
      }),
    ),
    media: { coverUrl: null, images: [], videos: [] },
    // Night-All v1 deliberately restricts this field to its three upstream
    // provider enums. Hub is the serving plane, not another upstream provider,
    // so null is the only strictly compatible and non-misleading value.
    source: { provider: null, endpointId: 'hub-canonical-search' },
  }))
  const seen = cursor?.seen ?? 0
  const hasMore = Boolean(result.hasMore)
  const nextCursor = hasMore
    ? encodeTelegramSearchCursor(
        { ...result.nextCursor, seen: seen + items.length },
        cursorBinding,
        cursorSecret,
      )
    : null
  return {
    data: {
      contractVersion: 'night-all.data-search.v1',
      platform: 'telegram',
      query,
      items,
      pageInfo: {
        pageIndex: Math.floor(seen / pageSize) + 1,
        pageSize,
        returnedCount: items.length,
        hasMore,
        nextCursor,
        cursorType: hasMore ? 'opaque' : 'none',
      },
      status: 'ok',
      warnings: result.mode === 'postgres'
        ? [{
            code: 'search_projection_degraded',
            message: 'Elasticsearch unavailable or disabled; PostgreSQL substring search was used.',
          }]
        : [],
      meta: {
        capability: 'search_posts',
        capabilityStatus: 'ready',
        paginationMode: 'cursor',
        sourceProvider: 'mx-insight-hub',
        endpointId: 'hub-canonical-search',
        providerCalls: 0,
        durationMs,
      },
    },
  }
}
