import { createHash } from 'node:crypto'
import { AppError } from '../core/errors.mjs'

export const HUB_SOCIAL_VERSION = 'mx-insight-hub.social-data.v1'
export const HUB_SOCIAL_ENDPOINTS = Object.freeze(Object.fromEntries([
  ['search', 'social.content.search', '内容搜索'],
  ['crawl', 'social.content.crawl', '账号内容'],
  ['user-info', 'social.profile.get', '账号资料'],
].map(([key, operation, label]) => [key, Object.freeze({ key, operation, label,
  path: `/api/v1/data/social/${key}`, platform: 'twitter', provider: 'rapidapi',
  endpointKey: `twitter-aio.${key}`, contractVersion: HUB_SOCIAL_VERSION,
})])))
export const hubSocialByPath = path => Object.values(HUB_SOCIAL_ENDPOINTS).find(row => row.path === path)
export const HUB_SOCIAL_OPERATIONS = Object.values(HUB_SOCIAL_ENDPOINTS).map(row => ({
  operationKey: row.operation, label: row.label, legacyGate: 'hubSocialVerified',
  contractVersion: HUB_SOCIAL_VERSION, endpointKeys: [row.endpointKey],
}))
const fail = message => { throw new AppError(400, 'invalid_social_request', message) }
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const scalar = (value, name, max = 500) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${name} must be a non-empty string of at most ${max} characters`)
  return value.trim()
}
function alias(body, names) {
  const values = names.filter(name => body[name] !== undefined).map(name => scalar(body[name], name))
  if (new Set(values).size > 1) fail(`${names.join('/')} must agree`)
  return values[0]
}

export function normalizeHubSocialRequest(operation, body, { maxPageSize = 50, decodeCursor, now = Date.now() } = {}) {
  const endpoint = HUB_SOCIAL_ENDPOINTS[operation]
  if (!endpoint) throw new AppError(404, 'not_found', 'Unknown social operation')
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('JSON object body is required')
  const allowed = operation === 'search'
    ? ['platform', 'query', 'keyword', 'count', 'pageSize', 'limit', 'cursor', 'sort']
    : ['platform', 'username', 'userId', 'user_id', 'uid', ...(operation === 'crawl' ? ['count', 'pageSize', 'limit', 'cursor'] : [])]
  if (Object.keys(body).some(key => !allowed.includes(key))) fail('Unsupported social request field')
  if (!['twitter', 'x'].includes(body.platform)) throw new AppError(400, 'social_platform_not_implemented', 'This Hub-owned operation currently supports twitter only; no legacy fallback is performed')
  const counts = ['count', 'pageSize', 'limit'].filter(key => body[key] !== undefined).map(key => body[key])
  if (counts.some(n => !Number.isInteger(n) || n < 1 || n > Math.min(50, maxPageSize)) || new Set(counts).size > 1) fail(`count/pageSize/limit must agree and be between 1 and ${Math.min(50, maxPageSize)}`)
  const count = operation === 'user-info' ? 1 : counts[0] ?? 20
  if (count > maxPageSize) fail('Page size exceeds this Key limit')
  let query, username, userId, sort
  if (operation === 'search') {
    query = alias(body, ['query', 'keyword'])
    if (!query) fail('query or keyword is required')
    if (query === '.' || query === '..') fail('query cannot be a URL dot segment')
    sort = body.sort ?? 'latest'
    if (!['latest', 'top'].includes(sort)) fail('sort must be latest or top')
  } else {
    username = body.username === undefined ? undefined : scalar(body.username, 'username', 16).replace(/^@/, '')
    userId = alias(body, ['userId', 'user_id', 'uid'])
    if (!!username === !!userId) fail('Provide exactly one username or userId/uid')
    if (username && !/^[A-Za-z0-9_]{1,15}$/.test(username)) fail('Invalid Twitter username')
    if (userId && !/^[0-9]{1,30}$/.test(userId)) fail('userId must be a numeric string')
  }
  const identity = { version: HUB_SOCIAL_VERSION, operation, platform: 'twitter', query: query ?? null,
    username: username?.toLowerCase() ?? null, userId: userId ?? null, count, sort: sort ?? null }
  const queryHash = hash(identity)
  let providerCursor = null, page = 1, expiresAt = now + 24 * 60 * 60 * 1000
  if (body.cursor !== undefined) {
    try {
      const state = decodeCursor(scalar(body.cursor, 'cursor', 8192))
      if (state.version !== HUB_SOCIAL_VERSION || state.queryHash !== queryHash || !Number.isSafeInteger(state.expiresAt) || state.expiresAt <= now
        || !Number.isInteger(state.page) || state.page < 2 || state.page > 15
        || typeof state.providerCursor !== 'string' || !state.providerCursor || state.providerCursor.length > 4096) throw new Error('cursor')
      ;({ providerCursor, page, expiresAt } = state)
    } catch { throw new AppError(400, 'invalid_cursor', 'Cursor is invalid, expired or belongs to another query/Key; explicitly restart the search') }
  }
  const upstreamQuery = operation === 'search' ? { count, category: sort === 'top' ? 'Top' : 'Latest', includeTimestamp: 'false' }
    : operation === 'crawl' ? { count, ...(username ? { username } : {}) } : userId ? { ids: userId } : {}
  if (providerCursor) upstreamQuery.cursor = providerCursor
  const endpointPath = operation === 'search' ? `/search/${encodeURIComponent(query)}`
    : operation === 'crawl' ? `/user/${userId || '-1'}/tweets`
      : userId ? '/user/users/by/ids' : `/user/by/username/${encodeURIComponent(username)}`
  return { ...identity, queryHash, page, expiresAt, providerCursor, endpointPath, upstreamQuery,
    endpointKey: endpoint.endpointKey, endpointVersion: 'twitter-aio.hub.v1', endpointContractVersion: HUB_SOCIAL_VERSION,
    marketplace: 'twitter', deliveryMode: 'live_only',
    fingerprintBody: { ...identity, cursor: body.cursor ?? null },
  }
}

const object = value => value && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' ? value : ''
const identifier = value => typeof value === 'string' && /^[0-9]{1,30}$/.test(value) ? value : null
const integer = value => value !== null && value !== '' && value !== undefined && /^(0|[1-9][0-9]*)$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : null
function timestamp(value) {
  if (value === undefined || value === null || value === '') return null
  const date = new Date(typeof value === 'number' ? value < 1e12 ? value * 1000 : value : value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
function profile(user) {
  if (!object(user) || user.__typename === 'UserUnavailable') return null
  const legacy = user.legacy || {}, core = user.core || {}
  const id = identifier(user.rest_id || legacy.id_str)
  if (!id) return null
  const username = text(legacy.screen_name || core.screen_name)
  return { id, userId: id, platform: 'twitter', objectType: 'user', username,
    name: text(legacy.name || core.name), description: text(legacy.description),
    avatarUrl: text(legacy.profile_image_url_https || legacy.profile_image_url || user.avatar?.image_url),
    url: username ? `https://twitter.com/${username}` : null, followers: integer(legacy.followers_count),
    following: integer(legacy.friends_count), posts: integer(legacy.statuses_count),
    verified: user.is_blue_verified ?? legacy.verified ?? null, location: text(legacy.location),
    createdAt: timestamp(legacy.created_at || core.created_at),
  }
}
function post(result) {
  const tweet = result?.tweet || result
  if (!object(tweet)) return null
  const legacy = tweet.legacy
  const id = identifier(tweet.rest_id || legacy?.id_str)
  if (!id || !object(legacy)) return null
  const author = profile(tweet.core?.user_results?.result)
  const note = tweet.note_tweet?.note_tweet_results?.result
  const content = text(note?.text || note?.richtext?.text || legacy.full_text || legacy.text)
  const media = legacy.extended_entities?.media || legacy.entities?.media || []
  const images = [], videos = []
  for (const item of Array.isArray(media) ? media : []) {
    if (item.media_url_https || item.media_url) images.push(item.media_url_https || item.media_url)
    const variants = (item.video_info?.variants || []).filter(v => v.content_type === 'video/mp4' && typeof v.url === 'string')
    variants.sort((a,b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0))
    if (variants[0]) videos.push(variants[0].url)
  }
  return { id, platform: 'twitter', objectType: 'post', title: null, content, summary: content,
    url: `https://twitter.com/${author?.username || 'i'}/status/${id}`,
    publishedAt: timestamp(legacy.created_at_timestamp || legacy.created_at), author,
    metrics: { likes: integer(legacy.favorite_count), replies: integer(legacy.reply_count),
      shares: integer(legacy.retweet_count), quotes: integer(legacy.quote_count), views: integer(tweet.views?.count), bookmarks: integer(legacy.bookmark_count) },
    tags: (legacy.entities?.hashtags || []).map(tag => text(tag.text)).filter(Boolean), imageUrls: images, videoUrls: videos,
  }
}
function rawProfile(item) {
  return { user_id: item.userId, user_name: item.username, nickname: item.name, platform_name: 'twitter',
    description: item.description, avatar_url: item.avatarUrl, profile_image_url: item.avatarUrl,
    url: item.url, followers_count: item.followers, friends_count: item.following, statuses_count: item.posts,
    location: item.location, verified: item.verified, created_at: item.createdAt }
}
function rawPost(item) {
  return { content_id: item.id, platform_name: 'twitter', title: '', content: item.content, full_text: item.content,
    url: item.url, original_url: item.url, created_at: item.publishedAt, author_id: item.author?.userId ?? null,
    author_avatar_url: item.author?.avatarUrl ?? null, like_count: item.metrics.likes, reply_count: item.metrics.replies,
    forward_count: item.metrics.shares, quote_count: item.metrics.quotes, view_count: item.metrics.views,
    image_urls: JSON.stringify(item.imageUrls), video_urls: JSON.stringify(item.videoUrls),
    metadata: JSON.stringify({ user_screen_name: item.author?.username ?? null, hashtags: item.tags }) }
}

export function normalizeTwitterResponse(payload, request, { encodeCursor, capturedAt = new Date().toISOString() } = {}) {
  const root = object(payload?.data) ? payload.data : payload
  if (!object(root)) throw new Error('invalid_response_shape')
  if ((Array.isArray(payload?.errors) && payload.errors.length) || (Array.isArray(root.errors) && root.errors.length)) throw new Error('upstream_business_errors')
  let items = [], profiles = [], next = null, duplicateCount = 0, discardedCount = 0
  if (request.operation === 'user-info') {
    const candidates = root.users || [root.user?.result || root.user_result_by_screen_name?.result || root.result]
    if (!Array.isArray(candidates)) throw new Error('invalid_profile_shape')
    profiles = candidates.map(user => profile(user?.result || user)).filter(Boolean)
    if (profiles.length !== 1) throw new Error('profile_unavailable_or_ambiguous')
    if (profiles.some(user => request.userId ? user.userId !== request.userId : user.username.toLowerCase() !== request.username)) throw new Error('profile_identity_mismatch')
    items = profiles
  } else {
    // Follow only known timeline containers, never quoted/related tweet trees.
    const pending = [root], entries = []
    let recognized = false
    for (let index = 0; index < pending.length && index < 10000; index++) {
      const node = pending[index]
      if (!object(node)) continue
      if (Array.isArray(node.entries)) { recognized = true; entries.push(...node.entries) }
      if (Array.isArray(node.instructions)) { if (!node.instructions.length) recognized = true; pending.push(...node.instructions) }
      if (node.type === 'TimelineTerminateTimeline') recognized = true
      for (const key of ['search_by_raw_query', 'search_timeline', 'timeline', 'user', 'result']) if (object(node[key])) pending.push(node[key])
    }
    if (!recognized || pending.length > 10000) throw new Error('invalid_timeline_shape')
    const seen = new Set()
    const contents = entries.map(entry => ({ id: entry.entryId, content: entry.content }))
    for (let index = 0; index < contents.length && index < 10000; index++) {
      const {id, content} = contents[index]
      if (!object(content)) continue
      if (['Bottom', 'ShowMore'].includes(content.cursorType) || /^cursor-(bottom|showMore)/.test(id || '')) {
        if (typeof content.value === 'string') next = content.value
        continue
      }
      if (Array.isArray(content.items)) contents.push(...content.items.map(item => ({ id: item.entryId, content: item.item || item })))
      const result = content.itemContent?.tweet_results?.result
      if (!result) continue
      const item = post(result)
      if (!item) { discardedCount++; continue }
      if (seen.has(item.id)) { duplicateCount++; continue }
      seen.add(item.id); items.push(item)
    }
    if (contents.length > 10000) throw new Error('timeline_too_large')
    if (items.length > request.count) throw new Error('upstream_page_exceeds_requested_count')
    const account = profile(root.user?.result)
    if (request.operation === 'crawl' && account && (request.userId ? account.userId !== request.userId : account.username.toLowerCase() !== request.username)) throw new Error('profile_identity_mismatch')
    if (account) profiles = [account]
  }
  if (next && (next.length > 4096 || next === request.providerCursor || !items.length || request.page >= 15)) next = null
  const cursor = next ? encodeCursor({ version: HUB_SOCIAL_VERSION, queryHash: request.queryHash,
    page: request.page + 1, expiresAt: request.expiresAt, providerCursor: next }) : null
  return { contractVersion: HUB_SOCIAL_VERSION, data: { platform: 'twitter', items,
    raw_info: JSON.stringify(profiles.map(rawProfile)), raw_data: JSON.stringify(request.operation === 'user-info' ? [] : items.map(rawPost)),
    page: { page: request.page, pageSize: request.count, returnedCount: items.length, duplicateCount, discardedCount, hasMore: !!cursor, nextCursor: cursor },
    pageInfo: { hasMore: !!cursor, nextCursor: cursor },
    meta: { implementation: 'hub', resultCount: items.length, upstreamCallCount: 1, capturedAt,
      profileCompleteness: request.operation === 'user-info' ? 'base_profile_without_about' : undefined },
    status: discardedCount ? 'partial' : 'ok',
  }, meta: { capturedAt } }
}
