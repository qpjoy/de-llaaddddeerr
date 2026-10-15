import { createHash } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { NATIVE_FORWARDING_ENDPOINTS, normalizeNativeForwardingRequest } from './native-forwarding.mjs'
import { normalizeTwitterResponse, HUB_SOCIAL_VERSION } from './hub-social.mjs'
import { facebookRow } from './facebook-search.mjs'
import { normalizeNightAllSocialItem } from './night-all-social-fields.mjs'
import { HUB_SOCIAL_COMPAT_PLATFORMS } from '../../shared/social-account-contract.mjs'
export { HUB_SOCIAL_COMPAT_PLATFORMS } from '../../shared/social-account-contract.mjs'

export const HUB_SOCIAL_COMPAT_VERSION = 'mx-insight-hub.social-account-compat.v1'
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (...values) => values.find(value => typeof value === 'string' && value.trim())?.trim() || ''
const id = (...values) => values.map(value => Number.isSafeInteger(value) ? String(value) : value).find(value => typeof value === 'string' && value.trim() && value.length <= 2048 && !value.includes('\0'))?.trim() || ''
const fail = (code, message) => { throw new AppError(400, code, message) }
const badResponse = message => { throw new AppError(502, 'invalid_social_response', message) }
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const canonical = value => ({ x: 'twitter', tw: 'twitter', xhs: 'xiaohongshu', redbook: 'xiaohongshu', red: 'xiaohongshu', ig: 'instagram', ins: 'instagram', insta: 'instagram', li: 'linkedin', rednote: 'xiaohongshu', fb: 'facebook', yt: 'youtube', b站: 'bilibili', dy: 'douyin', ks: 'kuaishou' })[String(value).trim().toLowerCase()] || String(value).trim().toLowerCase()
const nativePath = path => {
  const row = NATIVE_FORWARDING_ENDPOINTS.find(row => row.path === path)
  if (!row) throw new Error(`Missing reviewed account endpoint ${path}`)
  return row
}
const recipe = (path, identity, cursor = null, pagination = 'cursor', extra = {}) => ({ endpoint: nativePath(path), identity, cursor, pagination, ...extra })
// Fixed reviewed read routes only. No user-selected URL, supplier or fallback.
const RECIPES = {
  twitter: { profile: 'rapidapi', posts: 'rapidapi' },
  facebook: {
    profile: recipe('/api/facebook/get-profile-id/v1', 'url', null, 'none'),
    posts: recipe('/api/facebook/get-profile-posts/v1', 'profileId', 'cursor'),
  },
  instagram: {
    profile: recipe('/api/v1/instagram/v2/fetch_user_info', ['username', 'user_id'], null, 'none'),
    posts: recipe('/api/v1/instagram/v3/get_user_posts', 'username', 'after', 'cursor', { limit: 'first' }),
    reels: recipe('/api/v1/instagram/v2/fetch_user_reels', ['username', 'user_id'], 'pagination_token'),
    stories: recipe('/api/v1/instagram/v2/fetch_user_stories', ['username', 'user_id'], null, 'none'),
    tagged_posts: recipe('/api/v1/instagram/v2/fetch_user_tagged_posts', ['username', 'user_id'], 'pagination_token'),
    highlights: recipe('/api/v1/instagram/v2/fetch_user_highlights', ['username', 'user_id'], null, 'none'),
    followers: recipe('/api/v1/instagram/v2/fetch_user_followers', ['username', 'user_id'], 'pagination_token', 'cursor', { profiles: true }),
    following: recipe('/api/v1/instagram/v2/fetch_user_following', ['username', 'user_id'], 'pagination_token', 'cursor', { profiles: true }),
  },
  bilibili: {
    profile: recipe('/api/v1/bilibili/web/fetch_user_profile', 'uid', null, 'none'),
    posts: recipe('/api/v1/bilibili/web/fetch_user_post_videos', 'uid', 'pn', 'page', { limit: 'ps' }),
  },
  douyin: {
    profile: recipe('/api/v1/douyin/web/handler_user_profile', 'sec_user_id', null, 'none'),
    lookup: recipe('/api/v1/douyin/web/handler_user_profile_v2', 'unique_id', null, 'none'),
    posts: recipe('/api/v1/douyin/app/v3/fetch_user_post_videos', 'sec_user_id', 'max_cursor', 'cursor', { limit: 'count' }),
    likes: recipe('/api/v1/douyin/app/v3/fetch_user_like_videos', 'sec_user_id', 'max_cursor', 'cursor', { limit: 'counts' }),
  },
  kuaishou: {
    profile: recipe('/api/v1/kuaishou/app/fetch_one_user_v2', 'user_id', null, 'none'),
    posts: recipe('/api/v1/kuaishou/app/fetch_user_post_v2', 'user_id', 'pcursor'),
  },
  weibo: {
    profile: recipe('/api/v1/weibo/web_v2/fetch_user_info', ['custom', 'uid'], null, 'none'),
    posts: recipe('/api/v1/weibo/web_v2/fetch_user_posts', 'uid', 'since_id', 'page', { pageParam: 'page' }),
    original_posts: recipe('/api/v1/weibo/web_v2/fetch_user_original_posts', 'uid', 'since_id', 'page', { pageParam: 'page' }),
  },
  xiaohongshu: {
    profile: recipe('/api/v1/xiaohongshu/app_v2/get_user_info', ['share_text', 'user_id'], null, 'none'),
    lookup: recipe('/api/v1/xiaohongshu/app_v2/search_users', 'keyword', null, 'none'),
    posts: recipe('/api/v1/xiaohongshu/app_v2/get_user_posted_notes', ['share_text', 'user_id'], 'cursor'),
    likes: recipe('/api/v1/xiaohongshu/app_v2/get_user_faved_notes', ['share_text', 'user_id'], 'cursor'),
  },
  youtube: {
    profile: recipe('/api/v1/youtube/web/get_channel_info', 'channel_id', null, 'none'),
    lookup: recipe('/api/v1/youtube/web_v2/get_channel_id', 'channel_url', null, 'none'),
    posts: recipe('/api/v1/youtube/web_v2/get_channel_videos', 'channel_id', 'continuation_token', 'cursor', { defaults: { need_format: true } }),
  },
  zhihu: {
    profile: recipe('/api/v1/zhihu/web/fetch_user_info', 'user_url_token', null, 'none'),
    posts: recipe('/api/v1/zhihu/web/fetch_user_articles', 'user_url_token', 'offset', 'offset', { limit: 'limit' }),
    answers: recipe('/api/v1/zhihu/web/fetch_user_answers', 'user_url_token', 'offset', 'offset', { limit: 'limit' }),
  },
  tiktok: {
    profile: recipe('/api/v1/tiktok/app/v3/handler_user_profile', ['unique_id', 'sec_user_id'], null, 'none'),
    posts: recipe('/api/v1/tiktok/app/v3/fetch_user_post_videos', ['unique_id', 'sec_user_id'], 'max_cursor', 'cursor', { limit: 'count' }),
    likes: recipe('/api/v1/tiktok/app/v3/fetch_user_like_videos', 'sec_user_id', 'max_cursor', 'cursor', { limit: 'counts' }),
    reposts: recipe('/api/v1/tiktok/web/fetch_user_repost', 'secUid', 'cursor', 'cursor', { limit: 'count' }),
  },
  linkedin: {
    profile: recipe('/api/v1/linkedin/web_v2/get_user_profile', 'url', null, 'none'),
    posts: recipe('/api/v1/linkedin/web_v2/get_user_posts', 'url', 'pagination_token', 'offset', { offset: 'start', offsetStep: 50 }),
    company_posts: recipe('/api/v1/linkedin/web_v2/get_company_posts', 'url', 'pagination_token', 'offset', { offset: 'start', offsetStep: 50 }),
  },
  reddit: {
    profile: recipe('/api/v1/reddit/app/fetch_user_profile', 'username', null, 'none'),
    posts: recipe('/api/v1/reddit/app/fetch_user_posts', 'username', 'after'),
    comments: recipe('/api/v1/reddit/app/fetch_user_comments', 'username', 'after', 'cursor', { limit: 'page_size' }),
  },
}
export const HUB_SOCIAL_COMPAT_ACTIVITIES = Object.freeze(Object.fromEntries(Object.entries(RECIPES).map(([platform, rows]) => [platform, Object.freeze(Object.keys(rows).filter(key => !['profile', 'lookup'].includes(key)))])))

const COMMON = ['platform', 'businessId', 'business_id', 'count', 'pageSize', 'page_size', 'limit', 'page', 'cursor', 'concurrency', 'params', 'includeRaw', 'cacheMaxAgeHours', 'username', 'usernames', 'userId', 'userIds', 'user_id', 'uid', 'url', 'urls', 'profileUrl', 'profile_url', 'channelId', 'channel_id', 'channelUrl', 'channel_url']
const ID_ALIASES = ['uid', 'userId', 'user_id', 'userIds', 'sec_user_id', 'secUid', 'sec_uid', 'rest_id', 'restId', 'user_url_token', 'userUrlToken', 'channelId', 'channel_id', 'profileId', 'profile_id']
const USER_ALIASES = ['username', 'usernames', 'screen_name', 'screenName', 'unique_id', 'uniqueId']
const URL_ALIASES = ['url', 'urls', 'profileUrl', 'profile_url', 'channelUrl', 'channel_url']
const CONTROL = new Set(['cursor', 'nextCursor', 'next_cursor', 'providerCursor', 'provider_cursor'])
function integer(value, field, min, max) {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value
  if (!Number.isSafeInteger(number) || number < min || number > max) fail('invalid_social_request', `${field} must be between ${min} and ${max}`)
  return number
}
function list(body, fields) {
  return fields.flatMap(field => {
    const value = body[field]
    if (value == null || value === '') return []
    const values = Array.isArray(value) ? value : [value]
    if (!values.length || values.length > 100) fail('invalid_social_request', `${field} must be a bounded non-empty list`)
    return values.map(value => { const normalized = id(value); if (!normalized) fail('invalid_social_request', `${field} is invalid`); return normalized })
  })
}
function normalizeIdentity(platform, kind, value) {
  if (platform === 'twitter' && kind !== 'url') {
    value = value.replace(/^@+/, '')
    kind = /^\d+$/.test(value) ? 'id' : 'username'
    if (kind === 'username' && !/^[A-Za-z0-9_]{1,15}$/.test(value)) fail('invalid_social_request', 'Invalid Twitter username')
    if (kind === 'id' && !/^\d{1,30}$/.test(value)) fail('invalid_social_request', 'Invalid Twitter user ID')
    if (kind === 'username') value = value.toLowerCase()
  }
  if (kind === 'username') value = value.replace(/^@+/, '')
  if (kind === 'url') {
    let url
    try { url = new URL(value) } catch { fail('invalid_social_request', 'Invalid account URL') }
    const hosts = { twitter: ['twitter.com', 'x.com'], facebook: ['facebook.com'], instagram: ['instagram.com'], bilibili: ['bilibili.com', 'b23.tv'], douyin: ['douyin.com'], kuaishou: ['kuaishou.com'], weibo: ['weibo.com', 'weibo.cn'], xiaohongshu: ['xiaohongshu.com', 'xhslink.com', 'xhslink.cn'], youtube: ['youtube.com', 'youtu.be'], zhihu: ['zhihu.com'], tiktok: ['tiktok.com'], linkedin: ['linkedin.com'], reddit: ['reddit.com'] }[platform]
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || !hosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) fail('invalid_social_request', 'Account URL must use the requested platform host')
    const path = url.pathname.split('/').filter(Boolean)
    const token = platform === 'twitter' || platform === 'instagram' ? path[0]
      : platform === 'bilibili' && /^\d+$/.test(path[0] || '') ? path[0]
      : platform === 'weibo' ? path.at(-1) : platform === 'zhihu' && ['people', 'org'].includes(path[0]) ? path[1]
      : platform === 'reddit' && ['user', 'u'].includes(path[0]) ? path[1]
      : platform === 'youtube' && path[0] === 'channel' ? path[1]
      : platform === 'douyin' && path[0] === 'user' ? path[1]
      : platform === 'tiktok' && path[0]?.startsWith('@') ? path[0]
      : platform === 'kuaishou' && path[0] === 'profile' ? path[1]
      : platform === 'xiaohongshu' && path[0] === 'user' && path[1] === 'profile' ? path[2] : null
    if (token) {
      let decoded
      try { decoded = decodeURIComponent(token) } catch { fail('invalid_social_request', 'Invalid account URL encoding') }
      return normalizeIdentity(platform, ['twitter', 'instagram', 'reddit', 'tiktok'].includes(platform) ? 'username' : 'id', decoded)
    }
  }
  if (platform === 'youtube' && kind === 'username') return { kind: 'url', value: `https://www.youtube.com/@${value}` }
  if (platform === 'linkedin' && kind !== 'url') return { kind: 'url', value: `https://www.linkedin.com/in/${value}` }
  if (['reddit', 'zhihu'].includes(platform) && kind === 'id') kind = 'username'
  return { kind, value }
}
export function normalizeHubSocialCompatRequest(operation, body, { maxPageSize = 500, businessId = null } = {}) {
  if (!['crawl', 'user-info'].includes(operation)) fail('invalid_social_request', 'Unknown social account operation')
  if (!object(body)) fail('invalid_social_request', 'JSON object body is required')
  const allowed = new Set([...COMMON, ...(operation === 'crawl' ? ['activityTypes'] : [])])
  if (Object.keys(body).some(key => !allowed.has(key))) fail('unsupported_fields', 'Unsupported social account field')
  const platform = canonical(body.platform)
  if (!HUB_SOCIAL_COMPAT_PLATFORMS.includes(platform)) fail('social_platform_not_implemented', 'Unsupported account platform')
  for (const key of ['businessId', 'business_id']) if (body[key] != null && (typeof body[key] !== 'string' || businessId != null && body[key].trim() !== businessId)) fail('business_id_mismatch', 'businessId must match the authenticated Hub consumer')
  if (body.includeRaw != null && body.includeRaw !== false) fail('unsupported_fields', 'includeRaw=true is not supported by this facade')
  const counts = Object.fromEntries(['count', 'pageSize', 'page_size', 'limit'].filter(key => body[key] != null).map(key => [key, integer(body[key], key, 1, Number.MAX_SAFE_INTEGER)]))
  if (counts.pageSize != null && counts.page_size != null && counts.pageSize !== counts.page_size) fail('invalid_social_request', 'pageSize/page_size must agree')
  const requested = operation === 'user-info' ? counts.limit ?? counts.count ?? counts.pageSize ?? counts.page_size : counts.count ?? counts.pageSize ?? counts.page_size ?? counts.limit
  const pageSize = integer(requested ?? 20, 'pageSize', 1, Math.min(500, maxPageSize))
  const page = integer(body.page ?? 1, 'page', 1, 15)
  if (body.concurrency != null) integer(body.concurrency, 'concurrency', 1, 20)
  if (body.cacheMaxAgeHours != null && (typeof body.cacheMaxAgeHours !== 'number' || !Number.isFinite(body.cacheMaxAgeHours) || body.cacheMaxAgeHours < 0 || body.cacheMaxAgeHours > 720)) fail('invalid_social_request', 'cacheMaxAgeHours is invalid')
  if (body.params != null && !object(body.params)) fail('invalid_social_request', 'params must be an object')
  const params = { ...(body.params || {}) }
  const cursors = [body.cursor, params.cursor].filter(value => value != null && value !== '')
  if (cursors.some(value => typeof value !== 'string' || value.length > 8192) || new Set(cursors).size > 1) fail('invalid_cursor', 'cursor is invalid or conflicting')
  const cursor = cursors[0] ?? null
  if (page !== 1 && !cursor) fail('invalid_cursor', 'Use the Hub nextCursor to continue an account request')
  delete params.cursor
  for (const key of ['pcursor', 'after', 'before', 'max_id', 'end_cursor', 'continuation_token', 'continuationToken', 'pagination_token', 'paginationToken', 'since_id', 'max_cursor']) {
    if (params[key] != null && !['', '0', 0].includes(params[key])) fail('invalid_cursor', 'Use the Hub nextCursor rather than a supplier cursor')
    delete params[key]
  }
  const identities = new Map()
  for (const source of [body, params]) for (const [kind, aliases] of [['id', ID_ALIASES], ['username', USER_ALIASES], ['url', URL_ALIASES]]) {
    for (const value of list(source, aliases)) { const identity = normalizeIdentity(platform, kind, value); identities.set(`${identity.kind}:${identity.value}`, identity) }
  }
  if (!identities.size) fail('invalid_social_request', 'An account identifier is required')
  for (const key of [...ID_ALIASES, ...USER_ALIASES, ...URL_ALIASES]) delete params[key]
  if (Object.keys(params).some(key => /provider|credential|endpoint|api.?key|secret|password|auth|proxy|cookie|headers?|timeout|budget|chunk|max.*pages?|total.?count|include.?raw|debug/i.test(key) || /^(count|limit|page.?size|page|page.?number|page.?no|first|last|ps|pn|concurrency)$/i.test(key) || CONTROL.has(key))) fail('unsupported_fields', 'Private and workload controls cannot be sent as supplier parameters')
  const activities = operation === 'user-info' ? ['profile'] : body.activityTypes ?? ['posts']
  if (!Array.isArray(activities) || !activities.length || activities.length > 20 || activities.some(value => typeof value !== 'string' || !RECIPES[platform][value] || ['profile', 'lookup'].includes(value) && operation === 'crawl')) fail('unsupported_activity_type', 'Unsupported activity type for this platform')
  if (identities.size * activities.length > 50 || operation === 'crawl' && identities.size * activities.length * pageSize > 5000) fail('social_work_limit_exceeded', 'Account request exceeds the bounded work limit')
  const jobs = [...identities.values()].flatMap(identity => [...new Set(activities)].map(activityType => {
    const provider = platform === 'twitter' ? 'rapidapi' : platform === 'facebook' ? 'justone' : 'tikhub'
    const job = { platform, provider, operation, activityType, identity, params }
    // Validate all public parameters before any profile lookup can be charged.
    const recipes = [RECIPES[platform][activityType], RECIPES[platform].profile, RECIPES[platform].lookup].filter(value => object(value))
    const permitted = new Set(recipes.flatMap(row => row.endpoint.parameters.map(value => value.name)))
    if (Object.keys(params).some(key => !permitted.has(key))) fail('unsupported_fields', 'Unsupported account parameter')
    const normalizedJob = { ...job, id: hash(job), query: identity.value }
    // Preflight the eventual data step as well as the profile/lookup. Malformed
    // filters must fail before the first billable identity lookup.
    buildHubSocialCompatDispatch(normalizedJob, { pageSize, resolvedIdentity: { ...identity, username: identity.kind === 'username' ? identity.value : null, lookupComplete: true, profileReady: true } })
    return normalizedJob
  }))
  const identity = { contractVersion: HUB_SOCIAL_COMPAT_VERSION, operation, platform, pageSize, jobs }
  return { ...identity, platforms: [platform], page, cursor, includeRaw: false, fingerprintBody: { ...identity, cursor } }
}

function accountValue(job, resolvedIdentity) { return resolvedIdentity || job.identity }
function identityParams(row, identity, platform) {
  const names = Array.isArray(row.identity) ? row.identity : [row.identity]
  let name = names.length === 1 ? names[0] : identity.kind === 'id' ? names[1] : names[0]
  let value = name === 'username' && identity.username ? identity.username : identity.value
  if (name === 'url' && platform === 'facebook' && identity.kind !== 'url') value = `https://www.facebook.com/${value}`
  if (name === 'username' && identity.kind === 'url') fail('invalid_social_request', 'A username is required')
  return { [name]: value }
}
export function buildHubSocialCompatDispatch(job, { page = 1, nextParams = null, resolvedIdentity = null, pageSize = 20 } = {}) {
  const config = RECIPES[job.platform]
  if (!config) fail('social_platform_not_implemented', 'Unsupported account platform')
  const identity = accountValue(job, resolvedIdentity)
  const needProfile = job.operation === 'crawl' && !resolvedIdentity?.profileReady
  let stage = needProfile ? 'resolve' : 'data', kind = needProfile || job.operation === 'user-info' ? 'profile' : job.activityType
  if (kind === 'profile' && !resolvedIdentity?.lookupComplete && config.lookup && (
    job.platform === 'youtube' && identity.kind !== 'id' || job.platform === 'xiaohongshu' && identity.kind === 'username' || job.platform === 'douyin' && identity.kind === 'username')) { kind = 'lookup'; stage = 'resolve' }
  const row = kind === 'profile' && job.platform === 'douyin' && identity.kind === 'id' && /^\d+$/.test(identity.value)
    ? recipe('/api/v1/douyin/web/fetch_user_profile_by_uid', 'uid', null, 'none')
    : kind === 'profile' && job.platform === 'linkedin' && identity.kind === 'url' && new URL(identity.value).pathname.startsWith('/company/')
      ? recipe('/api/v1/linkedin/web_v2/get_company_profile', 'url', null, 'none') : config[kind]
  if (job.platform === 'twitter') {
    const profile = kind === 'profile'
    const userId = identity.kind === 'id' ? identity.value : null, username = identity.kind === 'username' ? identity.value : null
    if (!userId && !username) fail('invalid_social_request', 'Twitter account identity is invalid')
    return { provider: 'rapidapi', operation: profile ? 'user-info' : 'crawl', platform: 'twitter', marketplace: 'twitter',
      operationKey: profile ? 'social.profile.get' : 'social.content.crawl', endpointKey: `twitter-aio.${profile ? 'user-info' : 'crawl'}`, endpointVersion: 'twitter-aio.hub.v1', endpointContractVersion: HUB_SOCIAL_VERSION, contractVersion: HUB_SOCIAL_VERSION,
      endpointPath: profile ? userId ? '/user/users/by/ids' : `/user/by/username/${encodeURIComponent(username)}` : `/user/${userId || '-1'}/tweets`,
      upstreamQuery: profile ? userId ? { ids: userId } : {} : { count: Math.min(50, pageSize), ...(username ? { username } : {}), ...(nextParams || {}) },
      username, userId, count: Math.min(50, pageSize), page, expiresAt: Date.now() + 86400000, queryHash: job.id,
      providerCursor: nextParams?.cursor || null, accountCompatibility: true, allowOverflow: true, deliveryMode: 'live_only',
      socialCompat: { job, stage, kind, page, pageSize, resolvedIdentity },
    }
  }
  if (!object(row)) fail('unsupported_activity_type', 'Unsupported account operation')
  const parameterNames = new Set(row.endpoint.parameters.map(value => value.name))
  const params = Object.fromEntries(Object.entries(job.params).filter(([key]) => parameterNames.has(key)))
  Object.assign(params, row.defaults || {}, identityParams(row, identity, job.platform))
  if (row.limit) params[row.limit] = Math.min(50, pageSize)
  if (row.pagination === 'page') params[row.pageParam || row.cursor] = page
  if (row.pagination === 'offset') params[row.offset || row.cursor] = (page - 1) * (row.offsetStep || Math.min(50, pageSize))
  if (nextParams) {
    const allowed = new Set([row.cursor, row.pageParam, row.offset].filter(Boolean))
    if (!object(nextParams) || Object.keys(nextParams).some(key => !allowed.has(key))) fail('invalid_cursor', 'Invalid account continuation state')
    Object.assign(params, nextParams)
  }
  // Only Hub-generated identity/pagination values are coerced to the reviewed
  // provider scalar type; caller-supplied filters retain strict validation.
  const generated = new Set([...(Array.isArray(row.identity) ? row.identity : [row.identity]), row.limit, row.cursor, row.pageParam, row.offset].filter(Boolean))
  for (const field of row.endpoint.parameters) {
    if (!generated.has(field.name) || params[field.name] == null) continue
    if (field.type === 'string' && ['number', 'boolean'].includes(typeof params[field.name])) params[field.name] = String(params[field.name])
    if (field.type === 'integer' && typeof params[field.name] === 'string' && /^-?\d+$/.test(params[field.name]) && Number.isSafeInteger(Number(params[field.name]))) params[field.name] = Number(params[field.name])
  }
  const native = normalizeNativeForwardingRequest(row.endpoint.key, { params }, { maxPageSize: 100 })
  return { ...native, provider: row.endpoint.provider, platform: job.platform,
    socialCompat: { job, stage, kind, page, pageSize, resolvedIdentity, recipe: { cursor: row.cursor, pagination: row.pagination, pageParam: row.pageParam, offset: row.offset, offsetStep: row.offsetStep, profiles: row.profiles } },
  }
}

const get = (value, path) => path.split('.').reduce((node, key) => node?.[key], value)
function roots(payload) {
  const found = [payload]
  for (let index = 0; index < 4; index++) { const current = found.at(-1); if (!object(current?.data)) break; found.push(current.data) }
  return found
}
const collectionPaths = {
  facebook: ['business_data', 'results', 'posts', 'items'],
  instagram: ['items', 'posts', 'users', 'reels', 'stories', 'highlights', 'edges', 'user.edge_owner_to_timeline_media.edges', 'user.edge_felix_video_timeline.edges', 'edge_owner_to_timeline_media.edges'],
  bilibili: ['list.vlist', 'vlist', 'archives', 'items', 'videos'],
  douyin: ['aweme_list', 'items'], kuaishou: ['feeds', 'photos', 'list', 'items'], weibo: ['list', 'statuses', 'cards', 'items'],
  xiaohongshu: ['notes', 'items', 'note_list'], youtube: ['videos', 'items', 'contents'], zhihu: ['data', 'items', 'articles', 'answers'],
  tiktok: ['aweme_list', 'itemList', 'item_list', 'items'], linkedin: ['posts', 'items', 'elements', 'results'], reddit: ['children', 'posts', 'comments', 'items', 'edges'],
}
function collection(payload, platform) {
  for (const root of roots(payload).reverse()) {
    if (Array.isArray(root)) return root
    for (const path of collectionPaths[platform]) { const items = get(root, path); if (Array.isArray(items)) return items }
  }
  if (Array.isArray(payload?.data)) return payload.data
  badResponse('Account response contains no recognized collection')
}
function unwrap(value, platform) {
  if (!object(value)) badResponse('Account item is not an object')
  let item = object(value.node) ? value.node : value
  if (platform === 'reddit' && object(item.data)) item = item.data
  if (platform === 'weibo' && object(item.mblog)) item = item.mblog
  if (platform === 'xiaohongshu') item = item.note || item.note_card || item
  if (platform === 'youtube') item = item.videoRenderer || item.video || item
  if (platform === 'kuaishou') item = object(item.feed) ? { ...item, ...item.feed } : object(item.photo) ? { ...item, ...item.photo } : item
  return item
}
function profileObjects(payload) {
  const rows = []
  for (const root of roots(payload).reverse()) {
    for (const path of ['user', 'user_info', 'userInfo', 'userInfo.user', 'userInfo.stats', 'user_info.user', 'user_result', 'profile', 'author', 'channel', 'channel_info', 'profile_info', 'basic_info', 'basicInfo']) {
      const value = get(root, path)
      if (object(value)) rows.push(object(value.user) ? { ...value.user, stats: value.stats || value.user.stats || {} } : { ...value, interactions: value.interactions || root.interactions || [] })
    }
    if (object(root)) rows.push(root)
  }
  return rows
}
function profileRow(value, platform, capturedAt) {
  const interactions = Object.fromEntries((Array.isArray(value.interactions) ? value.interactions : []).filter(object).map(entry => [entry.type || entry.name, entry.count ?? entry.value]))
  const legacy = value.legacy || {}, stats = value.stats || value.statistics || {}, basic = value.basic_info || value.basicInfo || {}
  const identityFields = ['user_id', 'userId', 'userid', 'uid', 'sec_uid', 'secUid', 'rest_id', 'id_str', 'id', 'pk', 'mid', 'channel_id', 'channelId', 'profile_id', 'profileId']
  if (identityFields.some(key => typeof value[key] === 'number' && !Number.isSafeInteger(value[key]))) badResponse('Account identity was not represented losslessly')
  const userId = id(value.user_id, value.userId, value.userid, value.uid, value.sec_uid, value.secUid, value.rest_id, value.id_str, value.id, value.pk, value.mid, value.channel_id, value.channelId, value.channel?.channel_id, value.profile_id, value.profileId, value.url_token, value.company_id, value.entityUrn, basic.user_id)
  const username = text(value.username, value.user_name, value.screen_name, value.unique_id, value.uniqueId, value.red_id, legacy.screen_name, value.publicIdentifier, platform === 'reddit' ? value.name : null)
  if (!userId && !username) return null
  const metric = (...values) => { for (const value of values) if ((typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value)) && Number.isSafeInteger(Number(value)) && Number(value) >= 0) return Number(value); return null }
  const avatar = text(value.avatar_url, value.avatarUrl, value.avatar, value.profile_pic_url, value.profile_image_url_https, value.profile_image_url, value.face, value.headurl, legacy.profile_image_url_https, value.images, value.image, value.avatar_thumb?.url_list?.[0], value.avatar_medium?.url_list?.[0], basic.imageb, basic.images)
  const links = { twitter: `https://twitter.com/${username}`, facebook: `https://www.facebook.com/${userId || username}`, instagram: `https://www.instagram.com/${username}/`, bilibili: `https://space.bilibili.com/${userId}`, douyin: `https://www.douyin.com/user/${userId}`, kuaishou: `https://www.kuaishou.com/profile/${userId}`, weibo: `https://weibo.com/u/${userId}`, xiaohongshu: `https://www.xiaohongshu.com/user/profile/${userId}`, youtube: `https://www.youtube.com/channel/${userId}`, zhihu: `https://www.zhihu.com/people/${value.url_token || userId || username}`, tiktok: `https://www.tiktok.com/@${username}`, linkedin: `https://www.linkedin.com/in/${username}`, reddit: `https://www.reddit.com/user/${username}` }
  const url = text(value.profile_url, value.profileUrl, value.url, value.link, value.channel_url) || links[platform]
  const followers = metric(value.followers_count, value.follower_count, value.fans, value.fans_count, value.followers, value.followerCount, stats.followerCount, stats.follower_count, legacy.followers_count, interactions.fans, interactions.followers)
  const following = metric(value.following_count, value.friends_count, value.following, value.followingCount, stats.followingCount, legacy.friends_count, interactions.follows, interactions.following)
  const posts = metric(value.statuses_count, value.aweme_count, value.post_count, value.notes_count, value.videoCount, stats.videoCount, legacy.statuses_count, value.note_count, interactions.notes)
  const name = text(value.nickname, value.name, value.screen_name, value.full_name, value.fullName, value.channel_name, legacy.name, basic.nickname, username)
  const description = text(value.description, value.signature, value.bio, value.biography, value.intro, value.desc, legacy.description, basic.desc)
  return { user_id: userId || username, user_name: username, username, name, nickname: name, platform_name: platform, platform,
    description, avatar_url: avatar, profile_image_url: avatar, url, original_url: url,
    followers_count: followers, follower_count: followers, friends_count: following, following_count: following, statuses_count: posts,
    location: text(value.location, value.ip_location, legacy.location), verified: value.verified ?? value.is_verified ?? value.is_blue_verified ?? legacy.verified ?? null,
    blue_verified: value.is_blue_verified ?? null, created_at: value.created_at ?? legacy.created_at ?? null, collected_at: capturedAt,
    metadata: JSON.stringify({ source: 'hub', sec_user_id: id(value.sec_user_id, value.sec_uid, value.secUid), user_url_token: id(value.url_token, value.user_url_token) }),
  }
}
function validateProfileIdentity(source, profile, desired, platform) {
  const stableIds = [profile.user_id, source.uid, source.sec_uid, source.sec_user_id, source.secUid,
    source.rest_id, source.id, source.channel_id, source.channelId, source.pk, source.mid].map(String)
  if (desired.kind === 'id' && !stableIds.includes(desired.value)) badResponse('Account profile identity does not match the requested account')
  const fields = {
    instagram: ['username'], tiktok: ['unique_id', 'uniqueId', 'username'], douyin: ['unique_id', 'uniqueId'],
    reddit: ['name', 'username'], zhihu: ['url_token', 'user_url_token'],
    linkedin: ['publicIdentifier', 'username', 'public_identifier', 'universal_name', 'universalName'],
  }[platform]
  if (!fields || desired.kind === 'id') return
  let expected = desired.value
  if (desired.kind === 'url') {
    const segments = new URL(expected).pathname.split('/').filter(Boolean)
    if (platform !== 'linkedin' || !['in', 'company'].includes(segments[0]) || !segments[1]) return
    expected = segments[1]
  }
  const handles = fields.map(key => source[key]).filter(value => typeof value === 'string' && value.trim())
  if (platform === 'linkedin') for (const candidate of [source.profile_url, source.profileUrl, source.url]) {
    try { const url = new URL(candidate); if (url.hostname === 'linkedin.com' || url.hostname.endsWith('.linkedin.com')) handles.push(url.pathname.split('/').filter(Boolean).at(-1)) } catch { /* Not a canonical profile URL. */ }
  }
  if (!handles.some(value => value.replace(/^@+/, '').toLowerCase() === expected.replace(/^@+/, '').toLowerCase())) badResponse('Account profile username does not match the requested account')
}
function isoTime(value) {
  if (value == null || value === '') return null
  const number = typeof value === 'number' || typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : null
  const time = new Date(number == null ? value : number < 1e12 ? number * 1000 : number)
  return Number.isFinite(time.getTime()) ? time.toISOString() : null
}
const unixTime = value => { const iso = isoTime(value); return iso ? Math.floor(Date.parse(iso) / 1000) : null }
function modernProfile(row) {
  if (typeof row.user_id !== 'string' || !row.user_id || row.user_id.length > 256) badResponse('Account profile identity is invalid')
  return { ...row, id: `${row.platform_name}:${row.user_id}`, userId: row.user_id,
    displayName: row.name || row.nickname || row.user_name || '', avatarUrl: row.profile_image_url || row.avatar_url || '',
    profileUrl: row.url || '', sourceProvider: null, createdAt: isoTime(row.created_at),
    created_at: unixTime(row.created_at), collected_at: unixTime(row.collected_at),
    created_time: unixTime(row.created_at), updated_time: null, crawled_at: unixTime(row.collected_at),
    metrics: { followers: row.followers_count ?? null, following: row.following_count ?? row.friends_count ?? null,
      posts: row.statuses_count ?? null, likes: row.liked_count ?? null },
  }
}
function modernContent(row, platform, activityType) {
  if (typeof row.content_id !== 'string' || !row.content_id || row.content_id.length > 256) badResponse('Account content identity is invalid')
  const publishedAt = isoTime(row.published_at || row.created_at)
  return { ...row, id: `${platform}:${row.content_id}`, externalId: row.content_id, platform,
    type: row.content_type || 'post', objectType: 'post', activityType, source: null, sourceProvider: null,
    author: { id: row.author_id || null, name: row.author_name || null, avatarUrl: row.author_avatar_url || null },
    publishedAt, published_at: unixTime(publishedAt), collectedAt: isoTime(row.collected_at), collected_at: unixTime(row.collected_at), coverUrl: row.cover_url || null,
    metrics: { likes: row.like_count ?? null, comments: row.comment_count ?? row.reply_count ?? null,
      shares: row.share_count ?? row.forward_count ?? null, views: row.view_count ?? null, bookmarks: row.bookmark_count ?? null },
  }
}
function rawContent(item, platform, activityType, capturedAt) {
  if (platform === 'facebook') return { ...facebookRow(item, capturedAt), activityType }
  if (platform === 'bilibili' && !item.id) item = { ...item, id: id(item.aid, item.bvid) }
  if (platform === 'instagram' && !item.id) item = { ...item, id: id(item.pk, item.code, item.shortcode) }
  const identityFields = ['id', 'idstr', 'mid', 'cid', 'pk', 'post_id', 'postId', 'aweme_id', 'note_id', 'noteId', 'video_id', 'videoId', 'photo_id', 'photoId', 'comment_id', 'item_id', 'itemId', 'aid', 'bvid', 'urn', 'post_urn', 'postUrn', 'activity_urn', 'activityUrn', 'entityUrn', 'entity_urn', ...(platform === 'reddit' ? ['name'] : [])]
  if (identityFields.some(key => typeof item[key] === 'number' && !Number.isSafeInteger(item[key]))) badResponse('Account identity was not represented losslessly')
  if (!identityFields.some(key => id(item[key]))) badResponse('Account content has no stable upstream identity')
  // Retain Night-All's field/media mapping, but never its guessed IDs or array scan.
  const normalized = normalizeNightAllSocialItem(item, { platform, capability: activityType === 'comments' ? 'user_comments' : 'user_posts' })
  const externalId = id(normalized.external_id)
  if (!externalId) badResponse('Account content has no stable upstream identity')
  const { raw: _raw, ...fields } = normalized
  return { ...fields, id: externalId, content_id: externalId, platform_name: platform, content_type: normalized.source_type,
    activityType, content: normalized.text, full_text: normalized.text, created_at: normalized.published_at,
    collected_at: capturedAt, original_url: normalized.url, reply_count: normalized.comment_count, forward_count: normalized.share_count,
    bookmark_count: normalized.collect_count, profile_image_url: normalized.author_avatar_url, user_name: normalized.author_name,
    image_urls: JSON.stringify(normalized.media.images.map(item => item.url).filter(Boolean)),
    video_urls: JSON.stringify(normalized.media.videos.map(item => item.playUrl || item.url).filter(Boolean)),
    metadata: JSON.stringify({ activityType }),
  }
}
function continuation(payload, request, rowCount) {
  const { recipe: row, page } = request.socialCompat
  if (!row?.cursor || row.pagination === 'none') return { hasMore: false, nextParams: null, nextPage: page + 1 }
  const objects = roots(payload).reverse().flatMap(value => [value, value?.paging, value?.pagination, value?.page_info, value?.pageInfo, value?.user?.edge_owner_to_timeline_media?.page_info]).filter(object)
  const tokenNames = [row.cursor, 'nextCursor', 'next_cursor', 'next_max_id', 'nextMaxId', 'next_offset', 'nextOffset', 'continuation', 'continuationToken', 'continuation_token', 'pagination_token', 'end_cursor', 'after', 'pcursor', 'max_cursor', 'since_id', 'cursor']
  let next = null, explicitMore = null
  for (const value of objects) {
    for (const key of ['has_more', 'hasMore', 'more', 'has_next_page']) if (value[key] != null) {
      if (![true, false, 1, 0, '1', '0', 'true', 'false'].includes(value[key])) badResponse('Invalid upstream continuation flag')
      const flag = [true, 1, '1', 'true'].includes(value[key])
      if (explicitMore !== null && explicitMore !== flag) badResponse('Conflicting upstream continuation flags')
      explicitMore = flag
    }
    if (value.is_end != null) {
      if (![true, false, 1, 0, '1', '0', 'true', 'false'].includes(value.is_end)) badResponse('Invalid upstream continuation flag')
      const flag = ![true, 1, '1', 'true'].includes(value.is_end)
      if (explicitMore !== null && explicitMore !== flag) badResponse('Conflicting upstream continuation flags')
      explicitMore = flag
    }
    if (next == null) for (const key of tokenNames) if (value[key] != null && value[key] !== '') {
      if (!['string', 'number'].includes(typeof value[key]) || typeof value[key] === 'number' && !Number.isSafeInteger(value[key]) || String(value[key]).length > 8192 || String(value[key]).includes('\0')) badResponse('Invalid upstream continuation token')
      next = value[key]; break
    }
  }
  if (request.platform === 'xiaohongshu') {
    // App V2 user notes put the continuation on the last note, not the
    // envelope. This is the same source used by the retained XHS crawl contract.
    const notes = payload?.data?.data?.notes
    const noteCursor = Array.isArray(notes) ? notes.at(-1)?.cursor : null
    if (noteCursor != null && (typeof noteCursor !== 'string' || !noteCursor || noteCursor.length > 2048)) badResponse('Invalid user-note cursor')
    if (noteCursor) next = noteCursor
  }
  if (['0', 'no_more', 'no-more', '-1'].includes(String(next))) {
    if (explicitMore === true) badResponse('Upstream announced more rows with a terminal continuation token')
    next = null
  }
  if (explicitMore === false) next = null
  const nextParams = {}
  if (row.pagination === 'page') {
    const pageName = row.pageParam || row.cursor
    const more = explicitMore === true || next != null || rowCount > 0 && explicitMore !== false
    if (more) { nextParams[pageName] = page + 1; if (row.cursor !== pageName && next != null) nextParams[row.cursor] = next }
  } else if (row.pagination === 'offset') {
    if (next != null) nextParams[row.cursor] = next
    if (explicitMore === true || next != null) nextParams[row.offset || row.cursor] ??= Number(request.upstreamQuery[row.offset || row.cursor] || 0) + (row.offsetStep || rowCount)
  } else if (next != null) nextParams[row.cursor] = next
  if (explicitMore === true && !Object.keys(nextParams).length) badResponse('Upstream announced more rows without a continuation token')
  const currentToken = request.upstreamQuery[row.cursor]
  const repeated = next != null && currentToken != null && String(next) === String(currentToken)
  const regressed = row.pagination === 'offset' && row.offset == null && next != null && Number.isFinite(Number(next)) && Number(next) < Number(currentToken || 0)
  if (repeated || regressed) return { hasMore: false, nextParams: null, nextPage: page + 1, stopReason: repeated ? 'repeated_cursor' : 'regressing_cursor' }
  const hasMore = explicitMore == null && next == null && rowCount > 0 ? null : Object.keys(nextParams).length > 0
  return { hasMore, nextParams: Object.keys(nextParams).length ? nextParams : null, nextPage: page + 1 }
}
export function projectHubSocialCompatResponse(payload, request, { capturedAt = new Date().toISOString() } = {}) {
  const context = request.socialCompat
  if (!context) throw new TypeError('A normalized social compatibility request is required')
  const { job, stage, kind, page } = context
  if (job.platform === 'twitter') {
    const response = normalizeTwitterResponse(payload, request, { encodeCursor: () => null, capturedAt, allowOverflow: true })
    const profiles = JSON.parse(response.data.raw_info).map(row => modernProfile({ ...row, platform: 'twitter', name: row.nickname, username: row.user_name, following_count: row.friends_count, original_url: row.url, collected_at: capturedAt }))
    const acquiredItems = JSON.parse(response.data.raw_data).map(row => {
      const item = response.data.items.find(item => item.id === row.content_id)
      return modernContent({ ...row, text: row.content, published_at: row.created_at, collected_at: capturedAt,
        author_name: item?.author?.name || item?.author?.username || '', user_name: item?.author?.username || '',
        bookmark_count: item?.metrics.bookmarks ?? null, media: { images: (item?.imageUrls || []).map(url => ({ url, type: 'image' })), videos: (item?.videoUrls || []).map(url => ({ url, playUrl: url })) },
      }, 'twitter', job.activityType)
    })
    const next = response.providerPage?.nextProviderCursor
    const account = profiles[0]
    return { acquiredItems, profiles, providerPage: { hasMore: next ? true : response.providerPage?.stopReason ? false : acquiredItems.length ? null : false, nextParams: next ? { cursor: next } : null, nextPage: page + 1, ...(response.providerPage?.stopReason ? { stopReason: response.providerPage.stopReason } : {}) },
      ...(stage === 'resolve' ? { resolvedIdentity: { kind: 'id', value: account?.user_id || request.userId, username: account?.user_name || request.username, lookupComplete: true, profileReady: true } } : {}) }
  }
  if (kind === 'lookup' || kind === 'profile') {
    let candidates = profileObjects(payload)
    if (kind === 'lookup' && job.platform === 'xiaohongshu') {
      candidates = roots(payload).flatMap(value => Array.isArray(value?.users) ? value.users : [])
      const exact = candidates.filter(value => [value.red_id, value.username, value.user_name].some(candidate => typeof candidate === 'string' && candidate.replace(/^@+/, '').toLowerCase() === job.identity.value.toLowerCase()))
      if (exact.length !== 1) badResponse('Account username lookup was unavailable or ambiguous')
      candidates = exact
    }
    let source, profile
    for (const candidate of candidates) { const normalized = profileRow(candidate, job.platform, capturedAt); if (normalized) { source = candidate; profile = normalized; break } }
    if (!profile) badResponse('Account profile has no stable identity')
    const desired = context.resolvedIdentity || job.identity
    if (kind === 'profile' || kind === 'lookup' && job.platform === 'douyin') validateProfileIdentity(source, profile, desired, job.platform)
    const value = job.platform === 'douyin' || job.platform === 'tiktok' ? id(source.sec_user_id, source.sec_uid, source.secUid, profile.user_id)
      : job.platform === 'zhihu' ? id(source.url_token, source.user_url_token, profile.user_id)
      : job.platform === 'linkedin' || job.platform === 'reddit' ? desired.value : profile.user_id
    const resolvedIdentity = { kind: ['linkedin'].includes(job.platform) ? 'url' : job.platform === 'reddit' ? 'username' : 'id', value,
      username: profile.user_name, lookupComplete: true, profileReady: kind === 'profile' }
    return { acquiredItems: [], profiles: [modernProfile(profile)], providerPage: { hasMore: false, nextParams: null, nextPage: page + 1 }, ...(stage === 'resolve' ? { resolvedIdentity } : {}) }
  }
  const rows = collection(payload, job.platform).map(value => unwrap(value, job.platform))
  const seen = new Set(), acquiredItems = [], profiles = []
  for (const value of rows) {
    const row = context.recipe?.profiles ? profileRow(value, job.platform, capturedAt) : rawContent(value, job.platform, job.activityType, capturedAt)
    if (!row) badResponse('Account row is unavailable')
    const key = row.content_id || row.user_id
    if (seen.has(key)) continue
    seen.add(key)
    if (context.recipe?.profiles) {
      profiles.push(modernProfile(row))
      acquiredItems.push({ ...modernProfile(row), objectType: 'user', activityType: job.activityType })
    } else acquiredItems.push(modernContent(row, job.platform, job.activityType))
  }
  return { acquiredItems, profiles, providerPage: continuation(payload, request, rows.length) }
}
