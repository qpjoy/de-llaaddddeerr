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
const PUBLIC_METRICS = ['likes', 'comments', 'shares', 'views', 'bookmarks', 'members']
const PUBLIC_ATTRIBUTES = ['username', 'chatType', 'memberCount']
const PUBLIC_RELATIONS = ['chatId', 'messageId', 'replyToMessageId']

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

function safeObject(source, keys) {
  const result = {}
  for (const key of keys) {
    const value = source?.[key]
    if (value !== null && value !== undefined && (typeof value !== 'number' || Number.isFinite(value))) {
      result[key] = value
    }
  }
  return result
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
    platform: 'telegram',
    objectType: row.object_type,
    contentType: row.content_type ?? null,
    title: row.title ?? null,
    text: row.body ?? null,
    url: row.url ?? null,
    author: {
      id: row.author_external_id ?? null,
      name: row.author_name ?? null,
    },
    relations: safeObject(stable.relations, PUBLIC_RELATIONS),
    attributes: safeObject(stable.attributes, PUBLIC_ATTRIBUTES),
    metrics: safeObject(stable.metrics, PUBLIC_METRICS),
    eventTime: row.event_time ? new Date(row.event_time).toISOString() : null,
    collectedAt: row.collected_at ? new Date(row.collected_at).toISOString() : null,
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
