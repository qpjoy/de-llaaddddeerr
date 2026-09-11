// Keyword account search across four social platforms.
//
// Unlike the platform-shaped resource registry, this contract normalizes: the
// four upstream shapes are wildly different (one nests a JSON *string*, one
// returns a mixed content feed) and the target is a canonical dataset, which
// needs one stable record shape.
//
// Normalizing is defensible here because the mapping is attested rather than
// guessed: every path below comes from docs/integrations/user-search-field-notes.md,
// which records the parse paths actually exercised against 557 deduplicated
// accounts. Where that evidence shows a field is unreliable -- a fans count
// that is sometimes a formatted string, a verification flag under two different
// names -- the fallback is encoded here instead of being left to each caller.
//
// Two providers serve these platforms, so the platform descriptor carries the
// provider and its envelope convention: JustOne signals success with `code: 0`,
// TikHub with `code: 200`. Confusing the two would read a failure as success.

const MAX_KEYWORD_LENGTH = 200
const MAX_PAGE = 1_000
const MAX_TEXT_LENGTH = 4_096
const MAX_ID_LENGTH = 128
const MAX_ITEMS_PER_PAGE = 200

export const SOCIAL_ACCOUNT_SEARCH_OPERATION = 'social.accounts.search'
export const SOCIAL_ACCOUNT_SEARCH_CONTRACT_VERSION = 'mx-insight-hub.social-accounts.v1'
export const SOCIAL_ACCOUNT_DATASET_ID = 'social.accounts.v1'
export const SOCIAL_ACCOUNT_AUTHORIZATION_PLATFORM = 'social'

export class SocialAccountContractError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'SocialAccountContractError'
    this.code = code
  }
}

export class SocialAccountResponseError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'SocialAccountResponseError'
    this.code = code
  }
}

function invalid(code, message) {
  throw new SocialAccountContractError(code, message)
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function valueAt(root, path) {
  let current = root
  for (const segment of path) {
    if (!plainObject(current)) return undefined
    current = current[segment]
  }
  return current
}

// Take the first usable value among several candidate keys. Two platforms
// publish the same datum under two different names, and which one appears is
// not predictable per response.
function firstOf(node, keys) {
  if (!plainObject(node)) return undefined
  for (const key of keys) {
    const value = node[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

function text(value, maxLength = MAX_TEXT_LENGTH) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed
}

function identifier(value) {
  const scalar = text(value, MAX_ID_LENGTH)
  return scalar && /^[\w.:@-]+$/u.test(scalar) ? scalar : scalar
}

function boolish(...values) {
  return values.some((value) => value === true)
}

// A count is only a count when the upstream gave a real integer. Kuaishou has
// been observed returning a display string such as "1.2万"; coercing that would
// silently invent a number, so an unusable value becomes null and the caller
// sees "unknown" rather than a wrong figure.
function exactCount(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  return null
}

// Xiaohongshu omits `fans` often enough that the display string is the only
// source. It is a rendered figure ("粉丝 1.2万"), so anything beyond the plain
// integer form stays null instead of being reconstructed by multiplication.
function fansFromSubTitle(value) {
  const scalar = text(value, 64)
  if (!scalar) return null
  const match = /^粉丝\s*(\d+)$/u.exec(scalar)
  return match ? Number.parseInt(match[1], 10) : null
}

const PLATFORMS = Object.freeze({
  xiaohongshu: Object.freeze({
    platform: 'xiaohongshu',
    label: '小红书',
    providerKey: 'justone',
    envelope: 'justone',
    endpointKey: 'xiaohongshu.account-search.v1',
    upstreamPath: '/api/xiaohongshu/search-user/v2',
    keywordParam: 'keyword',
    fixedQuery: null,
    itemsPath: ['data', 'users'],
    account(node) {
      const id = identifier(node.id)
      if (!id) return null
      return {
        userId: id,
        secUid: null,
        name: text(node.name),
        handle: text(node.red_id, MAX_ID_LENGTH),
        fans: exactCount(node.fans) ?? fansFromSubTitle(node.sub_title),
        bio: text(node.desc),
        official: boolish(node.red_official_verified),
        avatar: text(node.image, 2_048),
      }
    },
  }),

  douyin: Object.freeze({
    platform: 'douyin',
    label: '抖音',
    providerKey: 'justone',
    envelope: 'justone',
    endpointKey: 'douyin.account-search.v1',
    upstreamPath: '/api/douyin/search-user/v2',
    keywordParam: 'keyword',
    fixedQuery: null,
    itemsPath: ['data', 'business_data'],
    // `raw_data` is a JSON *string*, not an object. An entry whose string does
    // not parse, or which carries no uid, is dropped rather than failing the
    // page: the observed responses mix usable and unusable entries.
    account(node) {
      const raw = valueAt(node, ['data', 'raw_data'])
      if (typeof raw !== 'string') return null
      let parsed
      try { parsed = JSON.parse(raw) } catch { return null }
      const info = valueAt(parsed, ['user_info'])
      if (!plainObject(info)) return null
      const id = identifier(info.uid)
      if (!id) return null
      return {
        userId: id,
        secUid: text(info.sec_uid, MAX_ID_LENGTH),
        name: text(info.nickname),
        handle: text(firstOf(info, ['unique_id', 'short_id']), MAX_ID_LENGTH),
        fans: exactCount(info.follower_count)
          ?? exactCount(valueAt(parsed, ['follower_info', 'follower_count'])),
        bio: text(info.signature),
        official: boolish(info.is_verified, info.verified),
        avatar: text(valueAt(info, ['avatar_larger', 'url_list'])?.[0], 2_048),
      }
    },
  }),

  weibo: Object.freeze({
    platform: 'weibo',
    label: '微博',
    providerKey: 'tikhub',
    envelope: 'tikhub',
    endpointKey: 'weibo.account-search.v1',
    upstreamPath: '/api/v1/weibo/web_v2/fetch_user_search',
    // Weibo is the one platform whose keyword parameter is not called keyword.
    keywordParam: 'query',
    fixedQuery: null,
    itemsPath: ['data', 'parsed_data', 'users'],
    account(node) {
      const id = identifier(node.uid)
      if (!id) return null
      return {
        userId: id,
        secUid: null,
        name: text(node.name),
        handle: null,
        fans: exactCount(node.fans),
        bio: text(node.description),
        official: boolish(node.verified),
        // Weibo avatar URLs carry an expiring signature; they are stored as
        // given and must be re-fetched rather than hot-linked long term.
        avatar: text(node.avatar, 2_048),
      }
    },
  }),

  kuaishou: Object.freeze({
    platform: 'kuaishou',
    label: '快手',
    providerKey: 'tikhub',
    envelope: 'tikhub',
    endpointKey: 'kuaishou.account-search.v1',
    upstreamPath: '/api/v1/kuaishou/app/search_user_v2',
    keywordParam: 'keyword',
    // Paging is by `page`, but the endpoint rejects a request without `cursor`.
    fixedQuery: Object.freeze({ cursor: '0' }),
    // A mixed content feed, not a user list: the same account recurs across
    // entries, so identity-based de-duplication is mandatory downstream.
    itemsPath: ['data', 'mixFeeds'],
    account(node) {
      const user = valueAt(node, ['user'])
      if (!plainObject(user)) return null
      const id = identifier(user.user_id)
      if (!id) return null
      return {
        userId: id,
        secUid: text(firstOf(user, ['user_eid', 'eid']), MAX_ID_LENGTH),
        name: text(user.user_name),
        handle: null,
        fans: exactCount(user.fansCount),
        bio: text(user.user_text),
        official: boolish(user.verified),
        avatar: text(user.headurl, 2_048),
      }
    },
  }),
})

export const SOCIAL_ACCOUNT_PLATFORMS = Object.freeze(Object.keys(PLATFORMS))

export function socialAccountPlatform(platform) {
  return PLATFORMS[platform] || null
}

export function socialAccountEndpointKeys(providerKey = null) {
  return Object.freeze([...new Set(
    Object.values(PLATFORMS)
      .filter((entry) => !providerKey || entry.providerKey === providerKey)
      .map((entry) => entry.endpointKey),
  )])
}

export function normalizeSocialAccountSearchRequest(body, { deliveryModes = null } = {}) {
  if (!plainObject(body)) invalid('invalid_request', 'request body must be an object')
  const allowed = new Set(['platform', 'keyword', 'page', 'deliveryMode'])
  const unknown = Object.keys(body).filter((key) => !allowed.has(key))
  if (unknown.length > 0) {
    invalid('unsupported_request_field', `unsupported request field: ${unknown[0]}`)
  }

  const platform = typeof body.platform === 'string' ? body.platform.trim() : ''
  const descriptor = PLATFORMS[platform]
  if (!descriptor) invalid('unsupported_platform', 'platform is not supported')

  const keyword = typeof body.keyword === 'string' ? body.keyword.trim() : ''
  if (!keyword) invalid('invalid_keyword', 'keyword is required')
  if (keyword.length > MAX_KEYWORD_LENGTH) {
    invalid('invalid_keyword', `keyword must be at most ${MAX_KEYWORD_LENGTH} characters`)
  }

  let page = 1
  if (body.page !== undefined && body.page !== null && body.page !== '') {
    if (!Number.isInteger(body.page) || body.page < 1 || body.page > MAX_PAGE) {
      invalid('invalid_page', `page must be an integer between 1 and ${MAX_PAGE}`)
    }
    page = body.page
  }

  let deliveryMode = null
  if (Array.isArray(deliveryModes)) {
    deliveryMode = body.deliveryMode === undefined || body.deliveryMode === null || body.deliveryMode === ''
      ? 'cache_first'
      : body.deliveryMode
    if (!deliveryModes.includes(deliveryMode)) {
      invalid('invalid_delivery_mode', `deliveryMode must be one of ${deliveryModes.join(', ')}`)
    }
  }

  return Object.freeze({
    contractVersion: SOCIAL_ACCOUNT_SEARCH_CONTRACT_VERSION,
    operation: SOCIAL_ACCOUNT_SEARCH_OPERATION,
    platform: descriptor.platform,
    marketplace: descriptor.platform,
    providerKey: descriptor.providerKey,
    endpointKey: descriptor.endpointKey,
    endpointVersion: 'v1',
    endpointContractVersion: SOCIAL_ACCOUNT_SEARCH_CONTRACT_VERSION,
    endpointPath: descriptor.upstreamPath,
    keyword,
    page,
    deliveryMode,
    upstreamQuery: Object.freeze({
      [descriptor.keywordParam]: keyword,
      ...(descriptor.fixedQuery || {}),
      page: String(page),
    }),
    // Delivery mode is a freshness preference, not part of the logical request
    // identity, matching every other Hub acquisition contract.
    fingerprintBody: Object.freeze({
      contractVersion: SOCIAL_ACCOUNT_SEARCH_CONTRACT_VERSION,
      platform: descriptor.platform,
      keyword,
      page,
    }),
  })
}

function envelopeOutcome(raw, envelope) {
  if (!plainObject(raw)) return 'invalid'
  const code = raw.code
  if (!Number.isInteger(code)) return 'invalid'
  const successCode = envelope === 'tikhub' ? 200 : 0
  return code === successCode ? 'success' : 'rejected'
}

export function normalizeSocialAccountSearchResponse(raw, request, { capturedAt = new Date() } = {}) {
  const descriptor = PLATFORMS[request.platform]
  if (!descriptor) {
    throw new SocialAccountResponseError('unsupported_platform', 'platform is not supported')
  }
  if (envelopeOutcome(raw, descriptor.envelope) !== 'success') {
    throw new SocialAccountResponseError('invalid_upstream_envelope', 'upstream envelope is not a success')
  }
  const captured = capturedAt instanceof Date ? capturedAt : new Date(capturedAt)
  if (Number.isNaN(captured.getTime())) {
    throw new SocialAccountResponseError('invalid_captured_at', 'capturedAt must be a valid timestamp')
  }

  const rawItems = valueAt(raw, descriptor.itemsPath)
  if (rawItems !== undefined && !Array.isArray(rawItems)) {
    throw new SocialAccountResponseError('invalid_upstream_items', 'upstream item collection is not an array')
  }
  const entries = Array.isArray(rawItems) ? rawItems : []
  if (entries.length > MAX_ITEMS_PER_PAGE) {
    throw new SocialAccountResponseError('upstream_page_too_large', 'upstream returned too many accounts')
  }

  const accounts = []
  const archiveObjects = []
  const seen = new Set()
  let discardedCount = 0
  let duplicateCount = 0

  entries.forEach((node, index) => {
    const account = plainObject(node) ? descriptor.account(node) : null
    if (!account) {
      discardedCount += 1
      return
    }
    if (seen.has(account.userId)) {
      duplicateCount += 1
      return
    }
    seen.add(account.userId)
    const normalizedAccount = Object.freeze({
      id: account.userId,
      platform: descriptor.platform,
      ...account,
      profileUrl: null,
    })
    accounts.push(normalizedAccount)
    archiveObjects.push(Object.freeze({
      kind: 'item',
      rank: index + 1,
      envelopePointer: `$.${descriptor.itemsPath.join('.')}[${index}]`,
      rawItem: node,
      rawPayload: node,
      normalizedItem: normalizedAccount,
    }))
  })

  // Upstream states neither a total nor a hasMore flag on any of these four
  // endpoints. An empty page is the attested end-of-results signal; a full page
  // proves nothing, so `hasMore` stays null ("upstream did not say") exactly as
  // the product-search contract treats an unstated continuation.
  const hasMore = entries.length === 0 ? false : null

  return Object.freeze({
    publicBody: Object.freeze({
      contractVersion: SOCIAL_ACCOUNT_SEARCH_CONTRACT_VERSION,
      data: Object.freeze({
        accounts: Object.freeze(accounts),
        page: Object.freeze({
          page: request.page,
          returnedCount: accounts.length,
          discardedCount,
          duplicateCount,
          hasMore,
          nextPage: hasMore === false ? null : request.page + 1,
        }),
      }),
      meta: Object.freeze({ capturedAt: captured.toISOString() }),
    }),
    accounts,
    archiveObjects: Object.freeze(archiveObjects),
  })
}
