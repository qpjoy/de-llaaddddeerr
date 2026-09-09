import { createHash } from 'node:crypto'

import { isNightAllLegacyEnvelope } from './night-all-legacy.mjs'
import {
  normalizeTikHubXiaohongshuNoteResult,
  XIAOHONGSHU_PLATFORM,
} from './tikhub-xiaohongshu.mjs'

export const XIAOHONGSHU_CRAWL_OPERATION = 'social.users.posts'
export const XIAOHONGSHU_CRAWL_CONTRACT_VERSION = 'night-all.compat.crawl.v1'
export const TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_KEY = 'xiaohongshu.app-v2.get-user-posted-notes.v1'
export const TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_PATH = '/api/v1/xiaohongshu/app_v2/get_user_posted_notes'
export const TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_VERSION = 'app_v2'
export const XIAOHONGSHU_CRAWL_MAX_PAGES = 15

const USER_ID_PATTERN = /^[0-9a-f]{24}$/iu
const MAX_CURSOR_LENGTH = 8_192
const MAX_PROVIDER_CURSOR_LENGTH = 2_048
const MAX_IDENTIFIER_LENGTH = 2_048
const MAX_PAGE_SIZE = 100
const PROFILE_HOSTS = new Set([
  'xiaohongshu.com', 'www.xiaohongshu.com',
  'xhslink.com', 'www.xhslink.com',
  'xhslink.cn', 'www.xhslink.cn',
])

export class TikHubXiaohongshuUserPostsContractError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TikHubXiaohongshuUserPostsContractError'
    this.code = code
  }
}

function invalid(code, message) {
  throw new TikHubXiaohongshuUserPostsContractError(code, message)
}

function record(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyText(value, maximum, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    invalid('invalid_request', `${field} must be a non-empty string of at most ${maximum} characters`)
  }
  return value.trim()
}

function officialProfileUrl(value) {
  const normalized = nonEmptyText(value, MAX_IDENTIFIER_LENGTH, 'profile URL')
  try {
    const url = new URL(normalized)
    const hostname = url.hostname.toLowerCase()
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || (url.port && url.port !== '443')
      || !PROFILE_HOSTS.has(hostname)
    ) invalid('invalid_user_profile_url', 'profile URL must use an official Xiaohongshu host')
    url.hostname = hostname
    // Keep provider-bound signed share parameters; the public profile
    // projection is rebuilt from the verified user_id and never echoes them.
    return url.toString()
  } catch (error) {
    if (error instanceof TikHubXiaohongshuUserPostsContractError) throw error
    invalid('invalid_user_profile_url', 'profile URL must use an official Xiaohongshu host')
  }
}

function values(input, names) {
  const output = []
  for (const name of names) {
    const value = input[name]
    if (Array.isArray(value)) output.push(...value)
    else if (value != null && value !== '') output.push(value)
  }
  return output
}

function normalizedIdentity(kind, value) {
  const normalized = typeof value === 'number' && Number.isFinite(value)
    ? String(value) : nonEmptyText(value, MAX_IDENTIFIER_LENGTH, kind)
  if (kind === 'user_id') {
    if (!USER_ID_PATTERN.test(normalized)) {
      invalid('invalid_user_id', 'Xiaohongshu user_id must be exactly 24 hexadecimal characters')
    }
    return { kind, value: normalized.toLowerCase() }
  }
  if (kind === 'profile_url') return { kind, value: officialProfileUrl(normalized) }
  const username = normalized.replace(/^@+/u, '')
  if (!username) invalid('invalid_request', 'username is invalid')
  return { kind, value: username }
}

function singleIdentity(input) {
  const candidates = [
    ...values(input, ['userId', 'user_id', 'uid', 'userIds']).map((value) => normalizedIdentity('user_id', value)),
    ...values(input, ['username', 'usernames']).map((value) => normalizedIdentity('username', value)),
    ...values(input, ['url', 'urls']).map((value) => normalizedIdentity('profile_url', value)),
  ]
  const unique = new Map(candidates.map((entry) => [`${entry.kind}:${entry.value.toLowerCase()}`, entry]))
  if (unique.size === 0) invalid('invalid_request', 'A Xiaohongshu user identifier is required')
  if (unique.size !== 1) {
    invalid(
      'multiple_user_identifiers_not_supported',
      'Hub-native Xiaohongshu crawl currently accepts exactly one user identifier',
    )
  }
  return [...unique.values()][0]
}

function boundedInteger(value, fallback, minimum, maximum, field) {
  const normalized = value ?? fallback
  if (!Number.isInteger(normalized) || normalized < minimum || normalized > maximum) {
    invalid('invalid_request', `${field} must be an integer between ${minimum} and ${maximum}`)
  }
  return normalized
}

function scopeFor(identity, pageSize) {
  return createHash('sha256').update(JSON.stringify({
    contractVersion: XIAOHONGSHU_CRAWL_CONTRACT_VERSION,
    platform: XIAOHONGSHU_PLATFORM,
    identity,
    pageSize,
    activityType: 'posts',
  })).digest('hex')
}

function requestCursor(input) {
  if (input.params != null && (!record(input.params) || Object.keys(input.params).some((key) => key !== 'cursor'))) {
    invalid('unsupported_fields', 'crawl params may contain only an opaque cursor')
  }
  const direct = input.cursor == null || input.cursor === '' ? null
    : nonEmptyText(input.cursor, MAX_CURSOR_LENGTH, 'cursor')
  const nested = input.params?.cursor == null || input.params.cursor === '' ? null
    : nonEmptyText(input.params.cursor, MAX_CURSOR_LENGTH, 'params.cursor')
  if (direct && nested && direct !== nested) invalid('invalid_cursor', 'cursor values conflict')
  return direct || nested
}

function decodeState(cursor, decodeCursor, scope) {
  if (!cursor) return null
  if (typeof decodeCursor !== 'function') invalid('cursor_codec_required', 'a trusted cursor decoder is required')
  let state
  try { state = decodeCursor(cursor) } catch { invalid('invalid_cursor', 'cursor is invalid') }
  if (
    !record(state)
    || state.version !== 1
    || state.operation !== XIAOHONGSHU_CRAWL_OPERATION
    || state.platform !== XIAOHONGSHU_PLATFORM
    || state.scope !== scope
    || !Number.isInteger(state.page)
    || state.page < 2
    || state.page > XIAOHONGSHU_CRAWL_MAX_PAGES
    || typeof state.providerCursor !== 'string'
    || !state.providerCursor
    || state.providerCursor.length > MAX_PROVIDER_CURSOR_LENGTH
    || typeof state.resolvedUserId !== 'string'
    || !USER_ID_PATTERN.test(state.resolvedUserId)
  ) invalid('invalid_cursor', 'cursor is invalid or does not belong to this crawl')
  return state
}

export function normalizeXiaohongshuCrawlRequest(input, { decodeCursor, maxPageSize = MAX_PAGE_SIZE } = {}) {
  if (!record(input) || input.platform !== XIAOHONGSHU_PLATFORM) {
    invalid('invalid_platform', 'platform must be xiaohongshu')
  }
  if (!Number.isInteger(maxPageSize) || maxPageSize < 1 || maxPageSize > MAX_PAGE_SIZE) {
    throw new TypeError(`maxPageSize must be an integer between 1 and ${MAX_PAGE_SIZE}`)
  }
  if (input.activityTypes != null && (
    !Array.isArray(input.activityTypes)
    || input.activityTypes.length !== 1
    || input.activityTypes[0] !== 'posts'
  )) invalid('unsupported_activity_type', 'Hub-native Xiaohongshu crawl supports only activityTypes=["posts"]')
  if (input.concurrency != null && input.concurrency !== 1) {
    invalid('unsupported_fields', 'Hub-native Xiaohongshu crawl uses one bounded user workflow')
  }
  const identity = singleIdentity(input)
  // Keep the historical crawl alias precedence used by the compatibility
  // request normalizer. Otherwise a body such as { count: 20, limit: 10 }
  // can be selected for direct routing with pageSize=20 and then rejected by
  // this contract after interpreting the same request as pageSize=10.
  const pageSize = boundedInteger(input.count ?? input.pageSize ?? input.limit, 20, 1, maxPageSize, 'pageSize')
  // TikHub get_user_posted_notes exposes no page-size parameter. Supporting a
  // smaller value would either drop paid rows/cursor positions or require a
  // durable server-side spill buffer; a larger value would silently underfill.
  if (pageSize !== 20) {
    invalid('unsupported_page_size', 'Hub-native Xiaohongshu crawl currently requires pageSize=20')
  }
  const scope = scopeFor(identity, pageSize)
  const cursor = requestCursor(input)
  const state = decodeState(cursor, decodeCursor, scope)
  const suppliedPage = input.page == null ? null : boundedInteger(
    input.page, 1, 1, XIAOHONGSHU_CRAWL_MAX_PAGES, 'page',
  )
  if (!state && suppliedPage != null && suppliedPage !== 1) {
    invalid('cursor_required', 'Random crawl pages are not supported; use the opaque nextCursor')
  }
  if (state && suppliedPage != null && suppliedPage !== 1 && suppliedPage !== state.page) {
    invalid('cursor_page_mismatch', 'page does not match the opaque cursor')
  }
  return Object.freeze({
    contractVersion: XIAOHONGSHU_CRAWL_CONTRACT_VERSION,
    operation: XIAOHONGSHU_CRAWL_OPERATION,
    identity: Object.freeze(identity),
    pageSize,
    page: state?.page ?? 1,
    cursor,
    scope,
    providerCursor: state?.providerCursor ?? null,
    resolvedUserId: state?.resolvedUserId?.toLowerCase() ?? null,
  })
}

function explicitBoolean(value, field) {
  if (typeof value === 'boolean') return value
  if (value === 0 || value === '0' || value === 'false') return false
  if (value === 1 || value === '1' || value === 'true') return true
  invalid('invalid_upstream_pagination', `TikHub returned an invalid ${field}`)
}

function providerHasMore(raw, data, itemCount) {
  const values = [raw?.data?.has_more, raw?.data?.hasMore, data.has_more, data.hasMore]
    .filter((value) => value != null && value !== '')
    .map((value) => explicitBoolean(value, 'has_more'))
  if (new Set(values).size > 1) invalid('invalid_upstream_pagination', 'TikHub returned conflicting has_more values')
  if (itemCount === 0) {
    if (values[0] === true) invalid('invalid_upstream_pagination', 'TikHub advertised another page after an empty page')
    return false
  }
  return values[0] ?? null
}

function noteCursor(note) {
  const value = note?.cursor
  if (value == null || value === '') return null
  if (typeof value !== 'string' || value.length > MAX_PROVIDER_CURSOR_LENGTH) {
    invalid('invalid_upstream_pagination', 'TikHub returned an invalid note cursor')
  }
  return value
}

function encodedNextCursor(request, resolvedUserId, providerCursor, encodeCursor) {
  if (typeof encodeCursor !== 'function') invalid('cursor_codec_required', 'a trusted cursor encoder is required')
  let cursor
  try {
    cursor = encodeCursor({
      version: 1,
      operation: XIAOHONGSHU_CRAWL_OPERATION,
      platform: XIAOHONGSHU_PLATFORM,
      page: request.page + 1,
      scope: request.scope,
      providerCursor,
      resolvedUserId,
    })
  } catch {
    invalid('cursor_encoding_failed', 'next cursor could not be encoded')
  }
  if (typeof cursor !== 'string' || !cursor || cursor.length > MAX_CURSOR_LENGTH) {
    invalid('cursor_encoding_failed', 'next cursor could not be encoded')
  }
  return cursor
}

export function normalizeTikHubXiaohongshuUserPostsResponse(raw, request, {
  resolvedUserId,
  encodeCursor,
  capturedAt = new Date(),
  providerCredential = null,
} = {}) {
  if (!request || request.contractVersion !== XIAOHONGSHU_CRAWL_CONTRACT_VERSION) {
    invalid('invalid_normalized_request', 'a normalized Xiaohongshu crawl request is required')
  }
  if (!USER_ID_PATTERN.test(String(resolvedUserId || ''))) {
    invalid('invalid_resolved_user', 'a verified Xiaohongshu user_id is required')
  }
  const data = raw?.data?.data
  if (!record(raw) || raw.code !== 200 || !record(raw.data) || !record(data) || !Array.isArray(data.notes)) {
    invalid('invalid_upstream_contract', 'TikHub response did not match data.data.notes')
  }
  if (data.notes.length > request.pageSize) {
    invalid('upstream_page_too_large', 'TikHub returned more user notes than the requested page size')
  }
  const captured = new Date(capturedAt)
  if (!Number.isFinite(captured.getTime())) invalid('invalid_captured_at', 'capturedAt must be a valid timestamp')
  const normalized = data.notes.map((note) => {
    if (!record(note)) invalid('invalid_upstream_item', 'TikHub returned an invalid Xiaohongshu note')
    const result = normalizeTikHubXiaohongshuNoteResult(
      { data: note },
      { capturedAt: captured, providerCredential },
    )
    if (!result) invalid('invalid_upstream_item', 'TikHub returned an invalid Xiaohongshu note')
    return result
  })
  const lastCursor = noteCursor(data.notes.at(-1))
  const explicitHasMore = providerHasMore(raw, data, normalized.length)
  const hasMore = explicitHasMore ?? Boolean(lastCursor)
  if (hasMore && !lastCursor) {
    invalid('invalid_upstream_pagination', 'TikHub advertised another page without a note cursor')
  }
  if (hasMore && request.providerCursor && lastCursor === request.providerCursor) {
    invalid('invalid_upstream_pagination', 'TikHub user-note cursor did not advance')
  }
  const pageLimitReached = hasMore && request.page >= XIAOHONGSHU_CRAWL_MAX_PAGES
  const nextCursor = hasMore && !pageLimitReached
    ? encodedNextCursor(request, resolvedUserId.toLowerCase(), lastCursor, encodeCursor)
    : null
  const warnings = []
  if (pageLimitReached) warnings.push({
    code: 'PAGE_LIMIT_REACHED',
    message: `Xiaohongshu crawl pagination is limited to ${XIAOHONGSHU_CRAWL_MAX_PAGES} pages.`,
  })
  return Object.freeze({
    items: Object.freeze(normalized.map((entry) => entry.item)),
    page: Object.freeze({
      page: request.page,
      pageSize: request.pageSize,
      returnedCount: normalized.length,
      hasMore: Boolean(nextCursor),
      nextCursor,
      providerCursor: lastCursor,
      nextPage: nextCursor ? request.page + 1 : null,
      paginationMode: nextCursor ? 'cursor' : 'none',
    }),
    warnings: Object.freeze(warnings),
  })
}

function epoch(value) {
  if (value == null) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? Math.floor(date.getTime() / 1_000) : null
}

function legacyPost(item) {
  const images = (Array.isArray(item.media) ? item.media : [])
    .filter((entry) => entry?.type === 'image' && typeof entry.url === 'string')
    .map((entry) => entry.url)
  return {
    content_id: item.externalId,
    post_id: item.externalId,
    note_id: item.externalId,
    content_type: 'note',
    title: item.title || '',
    text: item.text || '',
    full_text: item.text || '',
    content: item.text || '',
    url: item.url || '',
    original_url: item.url || '',
    published_at: epoch(item.publishedAt),
    collected_at: epoch(item.collectedAt),
    author_id: item.author?.id || '',
    author_name: item.author?.name || '',
    author_avatar_url: item.author?.avatarUrl || '',
    image_urls: JSON.stringify(images),
    video_urls: '[]',
    like_count: item.metrics?.liked ?? 0,
    comment_count: item.metrics?.comments ?? 0,
    share_count: item.metrics?.shared ?? 0,
    bookmark_count: item.metrics?.collected ?? 0,
  }
}

export function toNightAllXiaohongshuCrawlEnvelope(profile, posts, {
  providerCalls = 0,
  durationMs = 0,
} = {}) {
  if (!record(profile) || !posts || !Array.isArray(posts.items) || !record(posts.page)) {
    invalid('invalid_projection', 'profile and user posts are required')
  }
  const rows = posts.items.map(legacyPost)
  const page = {
    page: posts.page.page,
    pageSize: posts.page.pageSize,
    returnedCount: rows.length,
    hasMore: posts.page.hasMore === true,
    nextCursor: posts.page.nextCursor || null,
    providerCursor: null,
    nextParams: null,
    nextPage: posts.page.nextCursor ? posts.page.nextPage : null,
    paginationMode: posts.page.nextCursor ? 'cursor' : 'none',
  }
  const envelope = {
    data: {
      platform: XIAOHONGSHU_PLATFORM,
      source: 'mx-insight-hub',
      raw_info: JSON.stringify([profile]),
      raw_data: JSON.stringify(rows),
      page,
      meta: {
        responseShape: 'standard_raw_payload',
        rawInfoCount: 1,
        rawDataCount: rows.length,
        resultCount: rows.length,
        providerCalls: Number.isSafeInteger(providerCalls) ? providerCalls : 0,
        durationMs: Number.isSafeInteger(durationMs) ? durationMs : 0,
      },
      ...(posts.warnings?.length ? { warnings: [...posts.warnings] } : {}),
    },
  }
  if (!isNightAllLegacyEnvelope(envelope)) {
    invalid('invalid_projection', 'Xiaohongshu crawl could not satisfy the legacy envelope')
  }
  return Object.freeze(envelope)
}
