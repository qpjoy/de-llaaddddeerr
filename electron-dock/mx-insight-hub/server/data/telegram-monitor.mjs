import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { AppError } from '../core/errors.mjs'

// Stable public resources backed by the two server-side Telegram monitor
// tables. Dataset ids are Hub-owned names: neither the upstream database nor
// its physical table names are part of the consumer contract.
export const TELEGRAM_MONITOR_RESOURCES = Object.freeze({
  chats: Object.freeze({ datasetId: 'telegram.monitor.chats.v1', objectType: 'chat' }),
  messages: Object.freeze({ datasetId: 'telegram.monitor.messages.v1', objectType: 'message' }),
})

const ALLOWED_QUERY_FIELDS = new Set([
  'chatId', 'cursor', 'from', 'kind', 'pageSize', 'query', 'sourceScope', 'to',
])
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
const SEARCH_FIELDS = new Set([
  'authorId', 'chatId', 'cursor', 'from', 'matchMode', 'pageSize', 'query',
  'scope', 'sourceScope', 'to',
])
const ENTITY_SEARCH_FIELDS = new Set(['query', 'pageSize'])
const SOURCE_SCOPES = new Set(['all', 'monitor', 'sqlite'])
const CHAT_KINDS = new Set(['all', 'channel', 'group', 'unknown'])
const CHANNEL_TYPES = new Set(['broadcast', 'channel', 'public_channel'])
const GROUP_TYPES = new Set(['group', 'megagroup', 'public_group', 'supergroup'])

export const TELEGRAM_STORED_DATASETS = Object.freeze({
  monitor: Object.freeze({
    chats: 'telegram.monitor.chats.v1',
    messages: 'telegram.monitor.messages.v1',
  }),
  sqlite: Object.freeze({
    chats: 'telegram.sqlite.chats.v1',
    messages: 'telegram.sqlite.messages.v1',
  }),
})

function enumValue(value, field, allowed, fallback) {
  if (value == null) return fallback
  const normalized = stringValue(value, field, 32)?.toLowerCase()
  if (!allowed.has(normalized)) {
    throw new AppError(400, 'invalid_request', `${field} is not supported`)
  }
  return normalized
}

export function telegramStoredDatasetIds(sourceScope, resource) {
  if (sourceScope === 'monitor' || sourceScope === 'sqlite') {
    return [TELEGRAM_STORED_DATASETS[sourceScope][resource]]
  }
  return [
    TELEGRAM_STORED_DATASETS.monitor[resource],
    TELEGRAM_STORED_DATASETS.sqlite[resource],
  ]
}

export function telegramSourceScopeForDataset(datasetId) {
  if (datasetId === TELEGRAM_STORED_DATASETS.monitor.chats
      || datasetId === TELEGRAM_STORED_DATASETS.monitor.messages) return 'monitor'
  if (datasetId === TELEGRAM_STORED_DATASETS.sqlite.chats
      || datasetId === TELEGRAM_STORED_DATASETS.sqlite.messages) return 'sqlite'
  return null
}

function publicTelegramChatKind(row) {
  const value = row?.stable_fields?.attributes?.chatType ?? row?.content_type
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (CHANNEL_TYPES.has(normalized)) return 'channel'
  if (GROUP_TYPES.has(normalized)) return 'group'
  return 'unknown'
}

function publicTelegramUrl(value, sourceScope) {
  if (sourceScope !== 'sqlite') return value ?? null
  if (typeof value !== 'string' || !value.trim() || value.length > 2_048) return null
  try {
    const parsed = new URL(value.trim())
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null
    if ([...parsed.searchParams.keys()].some(
      (key) => /(?:auth|credential|key|password|secret|signature|token)/i.test(key),
    )) return null
    return parsed.toString()
  } catch {
    return null
  }
}

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

const PRODUCT_CURSOR_VERSION = 2
const PRODUCT_CURSOR_MAX_LENGTH = 2_048

function telegramProductCursorBinding(query, resourceName) {
  return createHash('sha256').update(JSON.stringify({
    v: PRODUCT_CURSOR_VERSION,
    contract: `mx-insight-hub.data-products.telegram-${resourceName}.v1`,
    resource: resourceName,
    sourceScope: query.sourceScope,
    ...(resourceName === 'chats'
      ? { kind: query.kind, query: query.query }
      : { chatId: query.chatId, from: query.from, to: query.to }),
    pageSize: query.pageSize,
  })).digest('base64url')
}

function productCursorSignature(payload, secret) {
  if (typeof secret !== 'string' || !secret) {
    throw new AppError(500, 'cursor_configuration_error', 'Telegram product cursor signing is not configured')
  }
  return createHmac('sha256', secret).update(JSON.stringify(payload)).digest('base64url')
}

function encodeTelegramProductCursor({ sortTime, id }, binding, secret) {
  const payload = {
    v: PRODUCT_CURSOR_VERSION,
    q: binding,
    t: new Date(sortTime).toISOString(),
    id,
  }
  if (!UUID_PATTERN.test(id || '')) {
    throw new AppError(500, 'cursor_configuration_error', 'Telegram product cursor row is invalid')
  }
  return Buffer.from(
    JSON.stringify({ ...payload, s: productCursorSignature(payload, secret) }),
    'utf8',
  ).toString('base64url')
}

function decodeTelegramProductCursor(value, binding, secret) {
  if (!value) return null
  try {
    if (
      typeof value !== 'string'
      || value.length > PRODUCT_CURSOR_MAX_LENGTH
      || !/^[A-Za-z0-9_-]+$/.test(value)
      || Buffer.from(value, 'base64url').toString('base64url') !== value
    ) throw new Error('bad cursor')
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    const payload = { v: parsed?.v, q: parsed?.q, t: parsed?.t, id: parsed?.id }
    const validKeys = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && Object.keys(parsed).sort().join(',') === 'id,q,s,t,v'
    const validSortTime = typeof parsed?.t === 'string'
      && new Date(parsed.t).toISOString() === parsed.t
    if (
      !validKeys
      || parsed.v !== PRODUCT_CURSOR_VERSION
      || parsed.q !== binding
      || !validSortTime
      || !UUID_PATTERN.test(parsed.id || '')
      || typeof parsed.s !== 'string'
      || !signaturesMatch(parsed.s, productCursorSignature(payload, secret))
    ) throw new Error('bad cursor')
    return { sortTime: parsed.t, id: parsed.id }
  } catch {
    throw new AppError(400, 'invalid_cursor', 'cursor is invalid for this Telegram product query')
  }
}

const SEARCH_CURSOR_VERSION = 3
const SEARCH_SORT_VERSION = 'es-score-eventTime-id-sharddoc-pg-eventTime-id-v2'
const SEARCH_ANALYSIS_STATE_VERSION = 1
const SEARCH_ANALYSIS_BACKENDS = new Set(['hanlp', 'jieba', 'bigram'])
const SEARCH_ANALYSIS_MAX_TOKENS = 512
const SEARCH_ANALYSIS_MAX_TOKEN_LENGTH = 512
const SEARCH_ANALYSIS_MAX_TOTAL_LENGTH = 2_048

function telegramSearchBinding(query, { includeSourceScope = false } = {}) {
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
      ...(includeSourceScope ? { sourceScope: query.sourceScope } : {}),
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

function validSearchAnalysisState(mode, value) {
  if (mode === 'postgres') return value === null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (Object.keys(value).sort().join(',') !== 'appliedProfile,backendUsed,degraded,errorCode,tokens,v') {
    return false
  }
  if (
    value.v !== SEARCH_ANALYSIS_STATE_VERSION ||
    typeof value.appliedProfile !== 'string' ||
    !value.appliedProfile.trim() ||
    value.appliedProfile.length > 128 ||
    typeof value.degraded !== 'boolean' ||
    !(value.backendUsed === null || SEARCH_ANALYSIS_BACKENDS.has(value.backendUsed)) ||
    !(value.errorCode === null || (typeof value.errorCode === 'string' && value.errorCode.length <= 64)) ||
    !Array.isArray(value.tokens) ||
    value.tokens.length > SEARCH_ANALYSIS_MAX_TOKENS
  ) {
    return false
  }
  let totalLength = 0
  for (const token of value.tokens) {
    if (typeof token !== 'string' || !token.trim()) return false
    const length = [...token].length
    if (length > SEARCH_ANALYSIS_MAX_TOKEN_LENGTH) return false
    totalLength += length
    if (totalLength > SEARCH_ANALYSIS_MAX_TOTAL_LENGTH) return false
  }
  return true
}

export function encodeTelegramSearchCursor({
  mode,
  pitId = null,
  searchAfter,
  seen,
  analysisState = null,
}, binding, secret) {
  if (!validSearchAnalysisState(mode, analysisState)) {
    throw new AppError(
      500,
      'cursor_configuration_error',
      'Telegram search cursor analysis state is missing or invalid',
    )
  }
  const payload = {
    v: SEARCH_CURSOR_VERSION,
    m: mode,
    p: pitId,
    a: searchAfter,
    n: seen,
    q: binding,
    r: analysisState,
  }
  return Buffer.from(JSON.stringify({ ...payload, s: cursorSignature(payload, secret) }), 'utf8').toString('base64url')
}

export function decodeTelegramSearchCursor(value, binding, secret) {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    const validKeys = parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
      Object.keys(parsed).sort().join(',') === 'a,m,n,p,q,r,s,v'
    const payload = {
      v: parsed?.v,
      m: parsed?.m,
      p: parsed?.p,
      a: parsed?.a,
      n: parsed?.n,
      q: parsed?.q,
      r: parsed?.r,
    }
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
      !validSearchAnalysisState(parsed.m, parsed.r) ||
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
      analysisState: parsed.r == null
        ? null
        : { ...parsed.r, tokens: [...parsed.r.tokens] },
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
    sourceScope: enumValue(input.sourceScope, 'sourceScope', SOURCE_SCOPES, 'monitor'),
  }
  // A missing sourceScope is the original Monitor-only v1 contract. Keep its
  // v3 cursor binding byte-for-byte compatible; the additive multi-source
  // contract is entered only when callers opt in with sourceScope.
  const cursorBinding = telegramSearchBinding(normalized, {
    includeSourceScope: input.sourceScope != null,
  })
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
export function normalizeTelegramMonitorQuery(
  input,
  maxPageSize = 100,
  resourceName = null,
  cursorSecret,
) {
  const unsupported = Object.keys(input || {}).filter((key) => !ALLOWED_QUERY_FIELDS.has(key))
  if (unsupported.length > 0) {
    throw new AppError(400, 'unsupported_fields', `Unsupported query fields: ${unsupported.join(', ')}`)
  }
  const from = timestampValue(input?.from, 'from')
  const to = timestampValue(input?.to, 'to')
  if (from && to && from > to) throw new AppError(400, 'invalid_request', 'from must not be later than to')
  const validPolicyMax = Number.isInteger(maxPageSize) && maxPageSize > 0 ? maxPageSize : 100
  const effectiveMax = Math.min(100, validPolicyMax)
  const extendedChatQuery = resourceName === 'chats' && (
    input?.sourceScope != null || input?.kind != null || input?.query != null
  )
  if (extendedChatQuery) {
    const unsupported = ['chatId', 'from', 'to'].filter((field) => input?.[field] != null)
    if (unsupported.length > 0) {
      throw new AppError(400, 'unsupported_fields', `Unsupported Telegram chat fields: ${unsupported.join(', ')}`)
    }
  }
  if (resourceName === 'messages') {
    const unsupported = ['kind', 'query'].filter((field) => input?.[field] != null)
    if (unsupported.length > 0) {
      throw new AppError(400, 'unsupported_fields', `Unsupported Telegram message fields: ${unsupported.join(', ')}`)
    }
  }
  const chatId = stringValue(input?.chatId, 'chatId', 256)
  const qualifiedChatScope = resourceName === 'messages'
    ? /^(monitor|sqlite):/i.exec(chatId || '')?.[1]?.toLowerCase() ?? null
    : null
  const requestedSourceScope = enumValue(
    input?.sourceScope,
    'sourceScope',
    SOURCE_SCOPES,
    qualifiedChatScope ?? 'monitor',
  )
  const normalized = {
    chatId,
    from,
    to,
    kind: enumValue(input?.kind, 'kind', CHAT_KINDS, 'all'),
    query: stringValue(input?.query, 'query', 200),
    sourceScope: requestedSourceScope,
    pageSize: pageSizeValue(input?.pageSize, effectiveMax),
  }
  const extendedCursor = input?.sourceScope != null
    || extendedChatQuery
    || qualifiedChatScope !== null
  const cursorToken = stringValue(
    input?.cursor,
    'cursor',
    extendedCursor ? PRODUCT_CURSOR_MAX_LENGTH : 1_024,
  )
  if (!extendedCursor) return { ...normalized, cursor: decodeTelegramCursor(cursorToken) }
  const binding = telegramProductCursorBinding(normalized, resourceName)
  return {
    ...normalized,
    cursorBinding: binding,
    cursorToken,
    cursor: decodeTelegramProductCursor(cursorToken, binding, cursorSecret),
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
  const sourceScope = telegramSourceScopeForDataset(row.dataset_id)
  return {
    canonicalId: row.id ?? null,
    id: row.external_id,
    externalId: row.external_id,
    platform: 'telegram',
    objectType: row.object_type,
    contentType: row.content_type ?? null,
    title: row.title ?? null,
    text: row.body ?? null,
    url: publicTelegramUrl(row.url, sourceScope),
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
    sourceScope,
    ...(row.object_type === 'chat' && row.id && sourceScope
      ? { chatKey: `${sourceScope}:${row.id}`, kind: publicTelegramChatKind(row) }
      : {}),
    dataVersion: String(row.current_revision ?? 1),
  }
}

export function publicTelegramMonitorPage(
  rows,
  pageSize,
  { cursorBinding = null, cursorSecret = null } = {},
) {
  const hasMore = rows.length > pageSize
  const pageRows = hasMore ? rows.slice(0, pageSize) : rows
  const last = pageRows.at(-1)
  return {
    items: pageRows.map(publicTelegramMonitorRecord),
    pageInfo: {
      returnedCount: pageRows.length,
      hasMore,
      nextCursor: hasMore && last
        ? cursorBinding
          ? encodeTelegramProductCursor(
              { sortTime: last.sort_time, id: last.id },
              cursorBinding,
              cursorSecret,
            )
          : encodeTelegramCursor({ sortTime: last.sort_time, id: last.id })
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
  const items = rows.map((row) => {
    const sourceScope = telegramSourceScopeForDataset(row.datasetId)
    return {
      id: row.id,
      canonicalId: row.id,
      externalId: row.externalId,
      sourceScope,
      platform: 'telegram',
      contentType: row.contentType ?? row.objectType ?? 'message',
      url: publicTelegramUrl(row.url, sourceScope),
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
    }
  })
  const seen = cursor?.seen ?? 0
  const hasMore = Boolean(result.hasMore)
  const nextCursor = hasMore
    ? encodeTelegramSearchCursor(
        { ...result.nextCursor, seen: seen + items.length },
        cursorBinding,
        cursorSecret,
      )
    : null
  const requestedProfile = result.searchExecution?.requestedProfile
  const appliedProfile = result.searchExecution?.appliedProfile
  const profileDegraded = result.mode === 'elasticsearch'
    && typeof requestedProfile === 'string'
    && typeof appliedProfile === 'string'
    && requestedProfile !== appliedProfile
  const warnings = result.mode === 'postgres'
    ? [{
        code: 'search_projection_degraded',
        message: 'Elasticsearch unavailable or disabled; PostgreSQL substring search was used.',
      }]
    : []
  if (profileDegraded) {
    warnings.push({
      code: 'search_profile_degraded',
      message: `Requested search profile ${requestedProfile} was not available; ${appliedProfile} was applied.`,
    })
  }
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
      warnings,
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
