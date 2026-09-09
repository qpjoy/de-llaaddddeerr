import { createHash } from 'node:crypto'

import {
  TIKHUB_XIAOHONGSHU_ENDPOINT_KEY,
  TIKHUB_XIAOHONGSHU_ENDPOINT_PATH,
  TIKHUB_XIAOHONGSHU_ENDPOINT_VERSION,
  XIAOHONGSHU_POST_OPERATION,
} from './tikhub-xiaohongshu.mjs'
import {
  TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_KEY,
  TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_PATH,
  TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_VERSION,
  XIAOHONGSHU_SEARCH_OPERATION,
} from './tikhub-xiaohongshu-search.mjs'
import {
  TIKHUB_XIAOHONGSHU_SEARCH_USERS_ENDPOINT_KEY,
  TIKHUB_XIAOHONGSHU_SEARCH_USERS_ENDPOINT_PATH,
  TIKHUB_XIAOHONGSHU_USER_ENDPOINT_VERSION,
  TIKHUB_XIAOHONGSHU_USER_INFO_ENDPOINT_KEY,
  TIKHUB_XIAOHONGSHU_USER_INFO_ENDPOINT_PATH,
  XIAOHONGSHU_USER_INFO_OPERATION,
} from './tikhub-xiaohongshu-user-info.mjs'
import {
  TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_KEY,
  TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_PATH,
  TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_VERSION,
  XIAOHONGSHU_CRAWL_OPERATION,
} from './tikhub-xiaohongshu-user-posts.mjs'

export const TIKHUB_XIAOHONGSHU_OFFICIAL_CONTRACT_VERSION = 'tikhub.app-v2.compat.v1'
export const TIKHUB_XIAOHONGSHU_OFFICIAL_MAX_PAGES = 15

const MAX_TEXT = 8_192
const MAX_KEYWORD = 500
const MAX_CONTINUATION = 2_048
const USER_OR_NOTE_ID = /^[0-9a-f]{24}$/iu
const SEARCH_NOTE_SORT_TYPES = new Set([
  'general',
  'time_descending',
  'popularity_descending',
  'comment_descending',
  'collect_descending',
  'english_preferred',
])
const SEARCH_NOTE_TYPES = new Set(['不限', '视频笔记', '普通笔记', '直播笔记'])
const SEARCH_NOTE_TIME_FILTERS = new Set(['不限', '一天内', '一周内', '半年内'])

export const TIKHUB_XIAOHONGSHU_OFFICIAL_ENDPOINTS = Object.freeze({
  detail: Object.freeze({
    name: 'detail',
    endpointKey: TIKHUB_XIAOHONGSHU_ENDPOINT_KEY,
    endpointVersion: TIKHUB_XIAOHONGSHU_ENDPOINT_VERSION,
    path: TIKHUB_XIAOHONGSHU_ENDPOINT_PATH,
    operation: XIAOHONGSHU_POST_OPERATION,
    gate: 'contractVerified',
    fields: Object.freeze(['note_id', 'share_text']),
  }),
  search_notes: Object.freeze({
    name: 'search_notes',
    endpointKey: TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_KEY,
    endpointVersion: TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_VERSION,
    path: TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_PATH,
    operation: XIAOHONGSHU_SEARCH_OPERATION,
    gate: 'searchContractVerified',
    fields: Object.freeze([
      'keyword', 'page', 'sort_type', 'note_type', 'time_filter',
      'search_id', 'search_session_id', 'source', 'ai_mode',
    ]),
  }),
  search_users: Object.freeze({
    name: 'search_users',
    endpointKey: TIKHUB_XIAOHONGSHU_SEARCH_USERS_ENDPOINT_KEY,
    endpointVersion: TIKHUB_XIAOHONGSHU_USER_ENDPOINT_VERSION,
    path: TIKHUB_XIAOHONGSHU_SEARCH_USERS_ENDPOINT_PATH,
    operation: XIAOHONGSHU_USER_INFO_OPERATION,
    gate: 'userActivityContractVerified',
    fields: Object.freeze(['keyword', 'page', 'search_id', 'source']),
  }),
  get_user_info: Object.freeze({
    name: 'get_user_info',
    endpointKey: TIKHUB_XIAOHONGSHU_USER_INFO_ENDPOINT_KEY,
    endpointVersion: TIKHUB_XIAOHONGSHU_USER_ENDPOINT_VERSION,
    path: TIKHUB_XIAOHONGSHU_USER_INFO_ENDPOINT_PATH,
    operation: XIAOHONGSHU_USER_INFO_OPERATION,
    gate: 'userActivityContractVerified',
    fields: Object.freeze(['user_id', 'share_text']),
  }),
  get_user_posted_notes: Object.freeze({
    name: 'get_user_posted_notes',
    endpointKey: TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_KEY,
    endpointVersion: TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_VERSION,
    path: TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_PATH,
    operation: XIAOHONGSHU_CRAWL_OPERATION,
    gate: 'userActivityContractVerified',
    fields: Object.freeze(['user_id', 'share_text', 'cursor']),
  }),
})

export const TIKHUB_XIAOHONGSHU_OFFICIAL_ENDPOINT_BY_PATH = Object.freeze(
  Object.fromEntries(Object.values(TIKHUB_XIAOHONGSHU_OFFICIAL_ENDPOINTS)
    .map((endpoint) => [endpoint.path, endpoint])),
)

export class TikHubXiaohongshuOfficialContractError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TikHubXiaohongshuOfficialContractError'
    this.code = code
  }
}

function invalid(code, message) {
  throw new TikHubXiaohongshuOfficialContractError(code, message)
}

function record(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requiredText(value, field, maximum = MAX_TEXT) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    invalid('invalid_request', `${field} must be a non-empty string of at most ${maximum} characters`)
  }
  return value
}

function optionalText(value, field, maximum = MAX_TEXT) {
  if (value == null || value === '') return null
  return requiredText(value, field, maximum)
}

function officialEnum(value, field, allowed, fallback) {
  const normalized = optionalText(value, field) || fallback
  if (!allowed.has(normalized)) {
    invalid(`invalid_${field}`, `${field} is not supported by the App V2 contract`)
  }
  return normalized
}

function page(value) {
  if (value == null || value === '') return 1
  if (typeof value !== 'string' || !/^[0-9]+$/u.test(value)) {
    invalid('invalid_page', `page must be an integer between 1 and ${TIKHUB_XIAOHONGSHU_OFFICIAL_MAX_PAGES}`)
  }
  const normalized = Number(value)
  if (!Number.isSafeInteger(normalized)
    || normalized < 1
    || normalized > TIKHUB_XIAOHONGSHU_OFFICIAL_MAX_PAGES) {
    invalid('invalid_page', `page must be an integer between 1 and ${TIKHUB_XIAOHONGSHU_OFFICIAL_MAX_PAGES}`)
  }
  return normalized
}

function identityQuery(query, idField) {
  const identifier = optionalText(query[idField], idField, MAX_CONTINUATION)
  const shareText = optionalText(query.share_text, 'share_text')
  if (!identifier && !shareText) invalid('invalid_request', `${idField} or share_text is required`)
  if (identifier && !USER_OR_NOTE_ID.test(identifier)) {
    invalid('invalid_request', `${idField} must be exactly 24 hexadecimal characters`)
  }
  // TikHub's App V2 contract gives the immutable ID precedence when callers
  // send both selectors. Canonicalize to that one selector so the provider
  // query, idempotency binding and snapshot identity all describe the request
  // TikHub will actually execute.
  return identifier
    ? { [idField]: identifier.toLowerCase() }
    : { share_text: shareText }
}

function scopeFor(query) {
  return createHash('sha256').update(JSON.stringify({
    contractVersion: TIKHUB_XIAOHONGSHU_OFFICIAL_CONTRACT_VERSION,
    endpointKey: TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_KEY,
    query,
  })).digest('hex')
}

function postedNotesRequest(query, decodeCursor) {
  const identity = identityQuery(query, 'user_id')
  const scope = scopeFor(identity)
  const publicCursor = optionalText(query.cursor, 'cursor')
  if (!publicCursor) {
    return { query: identity, publicQuery: identity, page: 1, scope, providerCursor: null }
  }
  if (typeof decodeCursor !== 'function') invalid('cursor_codec_required', 'a trusted cursor decoder is required')
  let state
  try { state = decodeCursor(publicCursor) } catch { invalid('invalid_cursor', 'cursor is invalid') }
  if (!record(state)
    || state.version !== 1
    || state.contractVersion !== TIKHUB_XIAOHONGSHU_OFFICIAL_CONTRACT_VERSION
    || state.endpointKey !== TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_KEY
    || state.scope !== scope
    || !Number.isInteger(state.page)
    || state.page < 2
    || state.page > TIKHUB_XIAOHONGSHU_OFFICIAL_MAX_PAGES
    || typeof state.providerCursor !== 'string'
    || !state.providerCursor
    || state.providerCursor.length > MAX_CONTINUATION) {
    invalid('invalid_cursor', 'cursor is invalid or does not belong to this user-post traversal')
  }
  return {
    query: { ...identity, cursor: state.providerCursor },
    publicQuery: { ...identity, cursor: publicCursor },
    page: state.page,
    scope,
    providerCursor: state.providerCursor,
  }
}

export function normalizeTikHubXiaohongshuOfficialRequest(endpointName, query, { decodeCursor } = {}) {
  const endpoint = TIKHUB_XIAOHONGSHU_OFFICIAL_ENDPOINTS[endpointName]
  if (!endpoint) invalid('unsupported_endpoint', 'Xiaohongshu App V2 endpoint is not supported')
  if (!record(query)) invalid('invalid_request', 'query must be an object')
  const unsupported = Object.keys(query).filter((field) => !endpoint.fields.includes(field))
  if (unsupported.length > 0) invalid('unsupported_fields', `${unsupported[0]} query parameter is not allowed`)

  let normalized
  if (endpointName === 'detail') {
    normalized = { query: identityQuery(query, 'note_id'), page: 1 }
  } else if (endpointName === 'get_user_info') {
    normalized = { query: identityQuery(query, 'user_id'), page: 1 }
  } else if (endpointName === 'get_user_posted_notes') {
    normalized = postedNotesRequest(query, decodeCursor)
  } else if (endpointName === 'search_notes') {
    const normalizedPage = page(query.page)
    const aiMode = query.ai_mode == null || query.ai_mode === '' ? '0' : query.ai_mode
    if (typeof aiMode !== 'string' || !['0', '1'].includes(aiMode)) {
      invalid('invalid_ai_mode', 'ai_mode must be 0 or 1')
    }
    normalized = {
      page: normalizedPage,
      query: {
        keyword: requiredText(query.keyword, 'keyword', MAX_KEYWORD),
        page: String(normalizedPage),
        sort_type: officialEnum(query.sort_type, 'sort_type', SEARCH_NOTE_SORT_TYPES, 'general'),
        note_type: officialEnum(query.note_type, 'note_type', SEARCH_NOTE_TYPES, '不限'),
        time_filter: officialEnum(query.time_filter, 'time_filter', SEARCH_NOTE_TIME_FILTERS, '不限'),
        ...(optionalText(query.search_id, 'search_id', MAX_CONTINUATION)
          ? { search_id: query.search_id } : {}),
        ...(optionalText(query.search_session_id, 'search_session_id', MAX_CONTINUATION)
          ? { search_session_id: query.search_session_id } : {}),
        source: optionalText(query.source, 'source') || 'explore_feed',
        ai_mode: aiMode,
      },
    }
  } else {
    const normalizedPage = page(query.page)
    normalized = {
      page: normalizedPage,
      query: {
        keyword: requiredText(query.keyword, 'keyword', MAX_KEYWORD),
        page: String(normalizedPage),
        ...(optionalText(query.search_id, 'search_id', MAX_CONTINUATION)
          ? { search_id: query.search_id } : {}),
        source: optionalText(query.source, 'source') || 'explore_feed',
      },
    }
  }
  const providerQuery = Object.freeze({ ...normalized.query })
  const publicQuery = Object.freeze({ ...(normalized.publicQuery || normalized.query) })
  return Object.freeze({
    contractVersion: TIKHUB_XIAOHONGSHU_OFFICIAL_CONTRACT_VERSION,
    endpoint,
    providerQuery,
    publicQuery,
    page: normalized.page,
    scope: normalized.scope || null,
    providerCursor: normalized.providerCursor || null,
  })
}

function boolean(value, field) {
  if (typeof value === 'boolean') return value
  if (value === 0 || value === '0' || value === 'false') return false
  if (value === 1 || value === '1' || value === 'true') return true
  invalid('invalid_upstream_pagination', `TikHub returned an invalid ${field}`)
}

function continuation(value, field) {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || value.length > MAX_CONTINUATION) {
    invalid('invalid_upstream_pagination', `TikHub returned an invalid ${field}`)
  }
  return value
}

function own(recordValue, names) {
  if (!record(recordValue)) return []
  return names.flatMap((name) => Object.hasOwn(recordValue, name)
    ? [{ owner: recordValue, name, value: recordValue[name] }]
    : [])
}

export function projectTikHubXiaohongshuOfficialPostedNotes(payload, request, { encodeCursor } = {}) {
  if (!record(payload) || payload.code !== 200 || !record(payload.data) || !record(payload.data.data)
    || !Array.isArray(payload.data.data.notes)) {
    invalid('invalid_upstream_contract', 'TikHub response did not match data.data.notes')
  }
  if (!request || request.endpoint?.name !== 'get_user_posted_notes') {
    invalid('invalid_request', 'a normalized get_user_posted_notes request is required')
  }
  const outer = payload.data
  const inner = outer.data
  const notes = inner.notes
  const hasMoreFields = [...own(outer, ['has_more', 'hasMore']), ...own(inner, ['has_more', 'hasMore'])]
  const hasMoreValues = hasMoreFields.map((entry) => boolean(entry.value, 'has_more'))
  if (new Set(hasMoreValues).size > 1) {
    invalid('invalid_upstream_pagination', 'TikHub returned conflicting has_more values')
  }
  const cursorFields = [
    ...own(outer, ['cursor', 'next_cursor', 'nextCursor']),
    ...own(inner, ['cursor', 'next_cursor', 'nextCursor']),
    ...(notes.length > 0 ? own(notes.at(-1), ['cursor']) : []),
  ]
  const cursors = cursorFields.map((entry) => continuation(entry.value, entry.name)).filter(Boolean)
  if (new Set(cursors).size > 1) {
    invalid('invalid_upstream_pagination', 'TikHub returned conflicting continuation cursors')
  }
  const providerCursor = cursors[0] || null
  const providerHasMore = hasMoreValues[0] ?? Boolean(providerCursor)
  if (notes.length === 0 && providerHasMore) {
    invalid('invalid_upstream_pagination', 'TikHub advertised another page after an empty page')
  }
  if (providerHasMore && !providerCursor) {
    invalid('invalid_upstream_pagination', 'TikHub advertised another page without a cursor')
  }
  if (providerHasMore && request.providerCursor && providerCursor === request.providerCursor) {
    invalid('invalid_upstream_pagination', 'TikHub user-note cursor did not advance')
  }
  const limitReached = providerHasMore && request.page >= TIKHUB_XIAOHONGSHU_OFFICIAL_MAX_PAGES
  let nextCursor = null
  if (providerHasMore && !limitReached) {
    if (typeof encodeCursor !== 'function') invalid('cursor_codec_required', 'a trusted cursor encoder is required')
    try {
      nextCursor = encodeCursor({
        version: 1,
        contractVersion: TIKHUB_XIAOHONGSHU_OFFICIAL_CONTRACT_VERSION,
        endpointKey: TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_KEY,
        scope: request.scope,
        page: request.page + 1,
        providerCursor,
      })
    } catch {
      invalid('cursor_encoding_failed', 'next cursor could not be encoded')
    }
  }
  const projected = structuredClone(payload)
  const projectedOuter = projected.data
  const projectedInner = projectedOuter.data
  const projectedNotes = projectedInner.notes
  for (const field of hasMoreFields) {
    const owner = field.owner === outer ? projectedOuter : projectedInner
    if (limitReached) owner[field.name] = false
  }
  for (const field of cursorFields) {
    let owner
    if (field.owner === outer) owner = projectedOuter
    else if (field.owner === inner) owner = projectedInner
    else owner = projectedNotes.at(-1)
    owner[field.name] = nextCursor
  }
  return Object.freeze({
    payload: projected,
    providerCursor,
    nextCursor,
    providerHasMore,
    limitReached,
    itemCount: notes.length,
  })
}
