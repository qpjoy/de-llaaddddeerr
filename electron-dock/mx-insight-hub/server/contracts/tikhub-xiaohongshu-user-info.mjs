import { redactCredentialEcho } from '../core/credential-redaction.mjs'
import { isNightAllLegacyEnvelope } from './night-all-legacy.mjs'

export const XIAOHONGSHU_USER_INFO_OPERATION = 'social.users.resolve'
export const XIAOHONGSHU_USER_INFO_CONTRACT_VERSION = 'night-all.compat.user-info.v1'
export const TIKHUB_XIAOHONGSHU_SEARCH_USERS_ENDPOINT_KEY = 'xiaohongshu.app-v2.search-users.v1'
export const TIKHUB_XIAOHONGSHU_SEARCH_USERS_ENDPOINT_PATH = '/api/v1/xiaohongshu/app_v2/search_users'
export const TIKHUB_XIAOHONGSHU_USER_INFO_ENDPOINT_KEY = 'xiaohongshu.app-v2.get-user-info.v1'
export const TIKHUB_XIAOHONGSHU_USER_INFO_ENDPOINT_PATH = '/api/v1/xiaohongshu/app_v2/get_user_info'
export const TIKHUB_XIAOHONGSHU_USER_ENDPOINT_VERSION = 'app_v2'

const USER_ID_PATTERN = /^[0-9a-f]{24}$/iu
const PROFILE_HOSTS = new Set([
  'xiaohongshu.com', 'www.xiaohongshu.com',
  'xhslink.com', 'www.xhslink.com',
  'xhslink.cn', 'www.xhslink.cn',
])
const MAX_IDENTIFIER_LENGTH = 2_048

export class TikHubXiaohongshuUserInfoContractError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TikHubXiaohongshuUserInfoContractError'
    this.code = code
  }
}

function invalid(code, message) {
  throw new TikHubXiaohongshuUserInfoContractError(code, message)
}

function record(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function metric(value) {
  if (value == null || value === '') return 0
  const parsed = Number(String(value).replace(/,/gu, ''))
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function safeHttpsUrl(value, { profile = false, providerCredential = null } = {}) {
  const normalized = text(value)
  if (!normalized || normalized.length > MAX_IDENTIFIER_LENGTH) return null
  try {
    const credentialSafe = redactCredentialEcho(normalized, providerCredential)
    const url = new URL(credentialSafe)
    const hostname = url.hostname.toLowerCase()
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || (url.port && url.port !== '443')
      || !hostname
      || (profile && !PROFILE_HOSTS.has(hostname))
    ) return null
    url.hostname = hostname
    return url.toString()
  } catch {
    return null
  }
}

function officialProfileUrl(value) {
  const normalized = text(value)
  if (!normalized || normalized.length > MAX_IDENTIFIER_LENGTH) {
    invalid('invalid_user_profile_url', 'profile URL must use an official Xiaohongshu host')
  }
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
    // Provider-bound share_text may require xsec_token and other signed query
    // material. It is never copied into the public profile projection.
    return url.toString()
  } catch (error) {
    if (error instanceof TikHubXiaohongshuUserInfoContractError) throw error
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

function identifier(kind, value) {
  const normalized = typeof value === 'number' && Number.isFinite(value)
    ? String(value) : text(value)
  if (!normalized || normalized.length > MAX_IDENTIFIER_LENGTH) {
    invalid('invalid_user_identifier', 'Xiaohongshu user identifier is invalid')
  }
  if (kind === 'user_id') {
    if (!USER_ID_PATTERN.test(normalized)) {
      invalid('invalid_user_id', 'Xiaohongshu user_id must be exactly 24 hexadecimal characters')
    }
    return { kind, value: normalized.toLowerCase() }
  }
  if (kind === 'profile_url') return { kind, value: officialProfileUrl(normalized) }
  return { kind, value: normalized.replace(/^@+/u, '') }
}

function uniqueIdentifiers(input) {
  const candidates = [
    ...values(input, ['userId', 'user_id', 'uid', 'userIds']).map((value) => identifier('user_id', value)),
    ...values(input, ['username', 'usernames']).map((value) => identifier('username', value)),
    ...values(input, ['url', 'profileUrl', 'profile_url', 'urls']).map((value) => identifier('profile_url', value)),
  ]
  const seen = new Set()
  return candidates.filter(({ kind, value }) => {
    const key = `${kind}:${value.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function normalizedInteger(value, fallback, minimum, maximum, field) {
  const normalized = value ?? fallback
  if (!Number.isInteger(normalized) || normalized < minimum || normalized > maximum) {
    invalid('invalid_request', `${field} must be an integer between ${minimum} and ${maximum}`)
  }
  return normalized
}

export function profileCallForIdentifier(identifierValue) {
  if (!record(identifierValue)) invalid('invalid_user_identifier', 'Xiaohongshu user identifier is invalid')
  if (identifierValue.kind === 'username') {
    return {
      role: 'resolve',
      endpointPath: TIKHUB_XIAOHONGSHU_SEARCH_USERS_ENDPOINT_PATH,
      query: { keyword: identifierValue.value, page: '1' },
    }
  }
  return {
    role: 'profile',
    endpointPath: TIKHUB_XIAOHONGSHU_USER_INFO_ENDPOINT_PATH,
    query: identifierValue.kind === 'user_id'
      ? { user_id: identifierValue.value }
      : { share_text: identifierValue.value },
  }
}

export function buildXiaohongshuUserInfoPlan(input) {
  if (!record(input) || input.platform !== 'xiaohongshu') {
    invalid('invalid_platform', 'platform must be xiaohongshu')
  }
  if (input.cursor != null || input.params != null || input.concurrency != null) {
    invalid('unsupported_fields', 'Xiaohongshu user info does not accept continuation or concurrency controls')
  }
  const allIdentifiers = uniqueIdentifiers(input)
  if (allIdentifiers.length === 0) {
    invalid('invalid_request', 'A Xiaohongshu user identifier is required')
  }
  if (allIdentifiers.length !== 1) {
    invalid(
      'multiple_user_identifiers_not_supported',
      'Hub-native Xiaohongshu user info currently accepts exactly one user identifier',
    )
  }
  const pageSize = normalizedInteger(input.limit ?? input.count ?? input.pageSize, 20, 1, 100, 'pageSize')
  const page = normalizedInteger(input.page, 1, 1, 1, 'page')
  const offset = (page - 1) * pageSize
  const identifiers = allIdentifiers.slice(offset, offset + pageSize)
  return Object.freeze({
    identifiers: Object.freeze(identifiers),
    calls: Object.freeze(identifiers.map(profileCallForIdentifier)),
    page: Object.freeze({
      page,
      pageSize,
      returnedCount: 0,
      hasMore: offset + identifiers.length < allIdentifiers.length,
      nextCursor: null,
      providerCursor: null,
      nextParams: null,
      nextPage: offset + identifiers.length < allIdentifiers.length ? page + 1 : null,
      paginationMode: 'page',
    }),
  })
}

function normalizedUserId(value) {
  const normalized = text(value)
  return normalized && USER_ID_PATTERN.test(normalized) ? normalized.toLowerCase() : null
}

export function normalizeTikHubXiaohongshuSearchUsersResponse(raw, requestedUsername, {
  providerCredential = null,
} = {}) {
  const users = raw?.data?.data?.users
  if (!record(raw) || raw.code !== 200 || !Array.isArray(users)) {
    invalid('invalid_upstream_contract', 'TikHub search users response did not match data.data.users')
  }
  if (users.length > 100) {
    invalid('upstream_page_too_large', 'TikHub returned too many user candidates')
  }
  const expected = text(requestedUsername)?.replace(/^@+/u, '').toLocaleLowerCase('zh-CN')
  const matches = users.filter((user) => {
    if (!record(user) || !normalizedUserId(user.id ?? user.user_id ?? user.userId)) return false
    return [user.red_id, user.redId, user.username, user.user_name, user.name, user.nickname]
      .some((value) => text(value)?.replace(/^@+/u, '').toLocaleLowerCase('zh-CN') === expected)
  })
  const candidatesById = new Map(matches.map((user) => [
    normalizedUserId(user.id ?? user.user_id ?? user.userId), user,
  ]))
  if (candidatesById.size === 0) {
    invalid('upstream_user_unavailable', 'TikHub returned no exact usable user for the requested username')
  }
  if (candidatesById.size > 1) {
    invalid('upstream_user_ambiguous', 'TikHub returned multiple exact users for the requested username')
  }
  const candidate = [...candidatesById.values()][0]
  return Object.freeze({
    userId: normalizedUserId(candidate.id ?? candidate.user_id ?? candidate.userId),
    username: text(candidate.red_id ?? candidate.redId ?? candidate.username) || '',
    displayName: text(candidate.name ?? candidate.nickname) || '',
    avatarUrl: safeHttpsUrl(candidate.image ?? candidate.avatar ?? candidate.avatar_url, { providerCredential }),
  })
}

function profileData(raw) {
  const outer = raw?.data
  const nested = record(outer?.data) ? outer.data : null
  const basic = record(nested?.basic_info) ? nested.basic_info
    : record(nested?.basicInfo) ? nested.basicInfo
      : record(outer?.basic_info) ? outer.basic_info
        : null
  return basic || nested || (record(outer) ? outer : null)
}

function interactions(raw) {
  const outer = raw?.data
  const nested = record(outer?.data) ? outer.data : null
  const list = Array.isArray(nested?.interactions) ? nested.interactions
    : Array.isArray(outer?.interactions) ? outer.interactions : []
  const result = {}
  for (const entry of list) {
    if (!record(entry)) continue
    const key = text(entry.type ?? entry.name)
    if (key) result[key.toLowerCase()] = metric(entry.count ?? entry.value)
  }
  return result
}

function firstMetric(source, aliases, interactionMetrics) {
  for (const alias of aliases) {
    if (source[alias] != null && source[alias] !== '') return metric(source[alias])
    if (interactionMetrics[alias.toLowerCase()] != null) return interactionMetrics[alias.toLowerCase()]
  }
  return 0
}

export function normalizeTikHubXiaohongshuUserInfoResponse(raw, {
  expectedUserId = null,
  capturedAt = new Date(),
  providerCredential = null,
} = {}) {
  if (!record(raw) || raw.code !== 200) {
    invalid('invalid_upstream_contract', 'TikHub user info response is invalid')
  }
  const source = profileData(raw)
  if (!source) invalid('invalid_upstream_contract', 'TikHub user info response omitted profile data')
  const userId = normalizedUserId(
    source.user_id ?? source.userId ?? source.id,
  )
  if (!userId) invalid('invalid_upstream_contract', 'TikHub user info response omitted a valid user_id')
  if (expectedUserId && userId !== expectedUserId.toLowerCase()) {
    invalid('upstream_identity_mismatch', 'TikHub returned a different Xiaohongshu user')
  }
  const captured = new Date(capturedAt)
  if (!Number.isFinite(captured.getTime())) invalid('invalid_captured_at', 'capturedAt must be a valid timestamp')
  const interactionMetrics = interactions(raw)
  const username = text(source.red_id ?? source.redId ?? source.user_name ?? source.username) || ''
  const name = text(source.nickname ?? source.name ?? source.display_name) || username
  const profileUrl = `https://www.xiaohongshu.com/user/profile/${userId}`
  return Object.freeze({
    user_id: userId,
    user_name: username,
    platform_name: 'xiaohongshu',
    name,
    description: text(source.desc ?? source.description ?? source.bio) || '',
    location: text(source.ip_location ?? source.ipLocation ?? source.location) || '',
    followers_count: firstMetric(source, ['followers_count', 'follower_count', 'fans', 'fans_count'], interactionMetrics),
    following_count: firstMetric(source, ['following_count', 'follows', 'follow_count'], interactionMetrics),
    verified: source.verified === true,
    blue_verified: source.blue_verified === true || source.blueVerified === true || source.verified === true,
    profile_image_url: safeHttpsUrl(
      source.images ?? source.image ?? source.avatar ?? source.avatar_url ?? source.avatarUrl,
      { providerCredential },
    ) || '',
    url: profileUrl,
    original_url: profileUrl,
    created_at: null,
    created_time: null,
    updated_time: null,
    crawled_at: Math.floor(captured.getTime() / 1_000),
    metrics: Object.freeze({
      interactions: firstMetric(source, ['interaction', 'interactions', 'liked_count'], interactionMetrics),
      notes: firstMetric(source, ['note_count', 'notes_count', 'notes'], interactionMetrics),
    }),
  })
}

export function toNightAllXiaohongshuUserInfoEnvelope(profiles, page, {
  providerCalls,
  durationMs,
} = {}) {
  if (!Array.isArray(profiles) || !record(page)) {
    invalid('invalid_projection', 'profiles and page are required')
  }
  const finalPage = {
    page: page.page,
    pageSize: page.pageSize,
    returnedCount: profiles.length,
    hasMore: page.hasMore === true,
    nextCursor: null,
    providerCursor: null,
    nextParams: null,
    nextPage: page.hasMore === true ? page.nextPage : null,
    paginationMode: 'page',
  }
  const warnings = profiles.length === 0 ? [{
    code: 'STANDARD_PAYLOAD_EMPTY',
    message: 'Provider call completed but no usable standard raw_info/raw_data rows were produced.',
  }] : []
  const envelope = {
    data: {
      platform: 'xiaohongshu',
      source: 'mx-insight-hub',
      raw_info: JSON.stringify(profiles),
      raw_data: '[]',
      page: finalPage,
      meta: {
        responseShape: 'standard_raw_payload',
        rawInfoCount: profiles.length,
        rawDataCount: 0,
        resultCount: profiles.length,
        providerCalls: Number.isSafeInteger(providerCalls) ? providerCalls : 0,
        durationMs: Number.isSafeInteger(durationMs) ? durationMs : 0,
      },
      ...(warnings.length > 0 ? { warnings } : {}),
    },
  }
  if (!isNightAllLegacyEnvelope(envelope)) {
    invalid('invalid_projection', 'Xiaohongshu user info could not satisfy the legacy envelope')
  }
  return Object.freeze(envelope)
}
