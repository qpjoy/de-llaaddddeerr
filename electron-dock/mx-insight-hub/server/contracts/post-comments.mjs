import { createHash } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { NATIVE_FORWARDING_ENDPOINTS, normalizeNativeForwardingRequest } from './native-forwarding.mjs'
import { youtubeCommentVideoId } from './youtube-comments.mjs'
import { projectPostCommentPage, POST_COMMENT_PROJECTION_PLATFORMS } from './post-comment-projection.mjs'

export const POST_COMMENTS_VERSION = 'mx-insight-hub.post-comments.v1'
export const POST_COMMENTS_CAPABILITY = 'social.comments.list'
export const POST_COMMENTS_PATH = '/api/v1/data/social/post-comments'
const definitions = [
  ['twitter', 'tikhub', '/api/v1/twitter/web/fetch_post_comments', 'tweet_id', ['cursor'], []],
  ['reddit', 'tikhub', '/api/v1/reddit/app/fetch_post_comments', 'post_id', ['after'], []],
  ['kuaishou', 'tikhub', '/api/v1/kuaishou/app/fetch_video_comment', 'photo_id', ['pcursor'], []],
  ['instagram', 'tikhub', '/api/v1/instagram/v3/get_post_comments', 'code', ['min_id'], ['sort_order']],
  ['weibo', 'tikhub', '/api/v1/weibo/web_v2/fetch_post_comments', 'id', ['max_id'], []],
  ['douyin', 'justone', '/api/douyin/get-video-comment/v1', 'awemeId', ['page'], []],
  ['tiktok', 'justone', '/api/tiktok/get-post-comment/v1', 'awemeId', ['cursor'], []],
  ['zhihu', 'justone', '/api/zhihu/get-answer-comments/v1', 'answerId', ['offset'], ['orderBy']],
  ['linkedin', 'justone', '/api/linkedin/get-post-comments/v1', 'postId', ['paginationToken', 'page', 'shareUrn'], ['sortOrder']],
  ['bilibili', 'justone', '/api/bilibili/get-video-comment/v2', 'aid', ['cursor'], []],
  ['facebook', 'justone', '/api/facebook/get-post-comments/v1', 'postId', ['cursor'], []],
  ['xiaohongshu', 'tikhub', '/api/v1/xiaohongshu/app_v2/get_note_comments', 'note_id', ['cursor', 'index', 'pageArea'], ['sort_strategy']],
  ['youtube', 'tikhub', '/api/v1/youtube/web_v2/get_video_comments', 'video_id', ['continuation_token'], ['sort_by', 'language_code', 'country_code']],
]
export const POST_COMMENTS_RECIPES = Object.freeze(Object.fromEntries(definitions.map(([platform, provider, path, idField, continuationFields, optionFields]) => {
  const endpoint = NATIVE_FORWARDING_ENDPOINTS.find(row => row.provider === provider && row.path === path)
  if (!endpoint) throw new Error(`Missing reviewed comment request contract: ${platform}`)
  return [platform, Object.freeze({ provider, path, key: endpoint.key, idField, continuationFields, optionFields,
    available: POST_COMMENT_PROJECTION_PLATFORMS.includes(platform) })]
})))
// Retained only to reproduce historical JustOne request fingerprints. This
// recipe is never available to dispatch or resume a traversal through TikHub.
const legacyRedditEndpoint = NATIVE_FORWARDING_ENDPOINTS.find(row => row.provider === 'justone' && row.path === '/api/reddit/get-post-comments/v1')
if (!legacyRedditEndpoint) throw new Error('Missing historical Reddit comment request contract')
const legacyRedditRecipe = Object.freeze({ provider: 'justone', key: legacyRedditEndpoint.key,
  idField: 'postId', continuationFields: ['cursor'], optionFields: [] })
const legacyKuaishouEndpoint = NATIVE_FORWARDING_ENDPOINTS.find(row => row.provider === 'justone' && row.path === '/api/kuaishou/get-video-comment/v1')
if (!legacyKuaishouEndpoint) throw new Error('Missing historical Kuaishou comment request contract')
const legacyKuaishouRecipe = Object.freeze({ provider: 'justone', key: legacyKuaishouEndpoint.key,
  idField: 'videoId', continuationFields: ['pcursor'], optionFields: [] })
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const invalid = message => { throw new AppError(400, 'invalid_post_comments_request', message) }
const scalar = value => typeof value === 'string' && value.length <= 8192 && !value.includes('\0') ? value
  : Number.isSafeInteger(value) && value >= 0 ? String(value) : null
const identityFields = ['postId', 'post_id', 'contentId', 'content_id', 'itemId', 'item_id', 'tweetId', 'tweet_id',
  'noteId', 'note_id', 'awemeId', 'aweme_id', 'statusId', 'status_id', 'videoId', 'video_id', 'postUrn', 'post_urn', 'urn']
const fields = new Set(['platform', 'url', 'count', 'limit', 'pageSize', 'page', 'cursor', 'params', 'includeRaw',
  'businessId', 'business_id', 'cacheMaxAgeHours', ...identityFields])
const aliases = { x: 'twitter', xhs: 'xiaohongshu', redbook: 'xiaohongshu', '小红书': 'xiaohongshu',
  '微博': 'weibo', '抖音': 'douyin', '快手': 'kuaishou', '知乎': 'zhihu', b站: 'bilibili' }
export function postCommentsPlatform(value) {
  const platform = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return aliases[platform] || platform
}
function integer(value, fallback, max, name) {
  const n = value == null ? fallback : typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(n) || n < 1 || n > max) invalid(`${name} must be an integer between 1 and ${max}`)
  return n
}
function postId(platform, value) {
  const text = scalar(value)?.trim()
  if (!text || text.length > 256) invalid('Post identifiers must be nonempty strings or safe integers')
  if (platform === 'youtube') { const id = youtubeCommentVideoId(text); if (!id) invalid('Invalid YouTube video ID'); return id }
  if (platform === 'reddit') {
    if (!/^(?:t3_)?[a-z0-9]{1,17}$/u.test(text)) invalid('Invalid Reddit post ID')
    return text.startsWith('t3_') ? text : `t3_${text}`
  }
  if (platform === 'xiaohongshu') { if (!/^[a-f0-9]{24}$/iu.test(text)) invalid('Invalid Xiaohongshu note ID'); return text.toLowerCase() }
  if (['twitter', 'douyin', 'tiktok', 'weibo', 'zhihu'].includes(platform) && !/^\d{1,30}$/u.test(text)) invalid('This platform requires a numeric post ID')
  if (platform === 'bilibili') { if (!/^(?:av)?\d{1,30}$/u.test(text)) invalid('Use a Bilibili numeric AID or av video URL'); return text.replace(/^av/u, '') }
  if (platform === 'instagram') {
    const numeric = /^(\d{1,20})(?:_\d{1,30})?$/u.exec(text)
    if (numeric) {
      // Instagram media IDs and shortcodes encode the same integer. Keep the
      // 64-bit identity exact: https://instaloader.github.io/module/structures.html
      let id = BigInt(numeric[1]), code = ''
      if (id < 1n || id > 18446744073709551615n) invalid('Invalid Instagram media ID')
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
      while (id) { code = alphabet[Number(id % 64n)] + code; id /= 64n }
      return code
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(text)) invalid('Use an Instagram media ID, shortcode or URL')
  }
  if (platform === 'linkedin') {
    if (!/^(?:urn:li:activity:)?\d{1,30}$/u.test(text)) invalid('Use a LinkedIn activity ID or activity URL; share and ugcPost URNs are not resolved automatically')
    return text.replace(/^urn:li:activity:/u, '')
  }
  if (['kuaishou', 'facebook'].includes(platform) && !/^[A-Za-z0-9_-]{1,128}$/u.test(text)) invalid('Invalid post ID')
  return text
}
function idFromUrl(platform, value, hasId = false) {
  let u
  try { u = new URL(value) } catch { invalid('Invalid post URL') }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port) invalid('Invalid post URL')
  const host = u.hostname.replace(/^(?:www|m|mobile)\./u, ''), path = u.pathname
  const match = (hosts, pattern) => hosts.includes(host) ? path.match(pattern)?.[1] : null
  const id = platform === 'twitter' ? match(['twitter.com', 'x.com'], /\/status\/(\d+)(?:\/|$)/u)
    : platform === 'reddit' ? match(['reddit.com'], /\/comments\/([a-z0-9]+)(?:\/|$)/u)
      : platform === 'xiaohongshu' ? match(['xiaohongshu.com'], /\/(?:explore|discovery\/item)\/([a-f0-9]{24})(?:\/|$)/iu)
        : platform === 'instagram' ? match(['instagram.com'], /\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)(?:\/|$)/u)
          : platform === 'youtube' ? youtubeCommentVideoId(value)
            : platform === 'douyin' ? match(['douyin.com'], /\/video\/(\d+)(?:\/|$)/u)
              : platform === 'tiktok' ? match(['tiktok.com'], /\/video\/(\d+)(?:\/|$)/u)
                : platform === 'kuaishou' ? match(['kuaishou.com'], /\/(?:short-video|photo)\/([A-Za-z0-9_-]+)(?:\/|$)/u)
                  : platform === 'zhihu' ? match(['zhihu.com'], /\/answer\/(\d+)(?:\/|$)/u)
                    : platform === 'bilibili' ? match(['bilibili.com'], /\/video\/(av\d+)(?:\/|$)/u)
                      : platform === 'weibo' ? match(['weibo.cn', 'weibo.com'], /\/(?:detail|status)\/(\d+)(?:\/|$)/u)
                        : platform === 'linkedin' ? match(['linkedin.com'], /(?:activity-|urn:li:activity:)(\d+)/u)
                          : platform === 'facebook' ? match(['facebook.com'], /\/(?:posts|videos)\/(\d+)(?:\/|$)/u) || (host === 'facebook.com' ? u.searchParams.get('story_fbid') : null) : null
  if (!id) {
    // Delta may carry a stable ID plus an original share link. Such a link
    // never becomes a network destination or replaces the supplied identity.
    const extraHosts = { weibo: ['weibo.cn', 'weibo.com'], xiaohongshu: ['xiaohongshu.com', 'xhslink.com'],
      douyin: ['douyin.com', 'v.douyin.com'], tiktok: ['tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'],
      kuaishou: ['kuaishou.com', 'v.kuaishou.com'], bilibili: ['bilibili.com', 'b23.tv'] }
    if (hasId && extraHosts[platform]?.includes(host)) return null
    invalid('Use a canonical post URL or its platform ID; short links are not resolved automatically')
  }
  return platform === 'instagram' ? id : postId(platform, id)
}
function paramsFor(recipe, params, rawCursor) {
  if (params == null) params = {}
  if (!object(params)) invalid('params must be an object')
  const options = {}, initialParams = {}
  for (const key of Object.keys(params).sort()) {
    if (![...recipe.optionFields, ...recipe.continuationFields].includes(key)) invalid(`Unsupported comment params field: ${key}`)
    const value = params[key]
    if (value == null || scalar(value) == null || typeof value === 'string' && value.length > 4096) invalid(`Invalid comment params field: ${key}`)
    if (recipe.continuationFields.includes(key) && typeof value === 'string' && /^mx[a-z0-9]*\./u.test(value)) {
      throw new AppError(400, 'invalid_cursor', 'A Hub cursor must use the cursor field and pass scope verification')
    }
    ;(recipe.optionFields.includes(key) ? options : initialParams)[key] = value
  }
  if (rawCursor != null) {
    const key = recipe.continuationFields[0]
    if (initialParams[key] != null && String(initialParams[key]) !== rawCursor) invalid('Conflicting comment continuation fields')
    initialParams[key] = rawCursor
  }
  if (recipe.idField === 'note_id' && initialParams.cursor && (initialParams.index == null || initialParams.pageArea == null)) invalid('Xiaohongshu continuation needs cursor, index and pageArea')
  return { options, initialParams }
}
export function normalizePostCommentsRequest(body, { businessId, maxPageSize = 100,
  allowHistoricalRedditCursor = false, allowHistoricalKuaishouCursor = false } = {}) {
  if (!object(body) || Object.keys(body).some(key => !fields.has(key))) invalid('Unsupported post comments request fields')
  for (const field of ['businessId', 'business_id']) if (body[field] != null && body[field] !== businessId) invalid('businessId must match the authenticated consumer')
  const platform = postCommentsPlatform(body.platform), recipe = POST_COMMENTS_RECIPES[platform]
  if (!recipe) throw new AppError(400, 'platform_operation_unsupported', 'Single-post comments are not registered for this platform')
  const ids = identityFields.filter(field => body[field] != null).map(field => postId(platform, body[field]))
  if (body.url != null) { const urlId = idFromUrl(platform, body.url, ids.length > 0); if (urlId) ids.push(urlId) }
  if (!ids.length || new Set(ids).size !== 1) invalid('Supply one post ID or URL; aliases must identify the same post')
  const counts = ['count', 'limit', 'pageSize'].filter(field => body[field] != null).map(field => integer(body[field], 20, Math.min(100, maxPageSize), field))
  if (new Set(counts).size > 1) invalid('Conflicting comment count aliases')
  const count = counts[0] ?? Math.min(20, maxPageSize), page = integer(body.page, 1, 1000, 'page')
  if (body.includeRaw != null && typeof body.includeRaw !== 'boolean') invalid('includeRaw must be boolean')
  if (body.cacheMaxAgeHours != null && (!Number.isFinite(body.cacheMaxAgeHours) || body.cacheMaxAgeHours < 0 || body.cacheMaxAgeHours > 720)) invalid('Invalid cacheMaxAgeHours')
  const paramCursor = object(body.params) && typeof body.params.cursor === 'string' && body.params.cursor.startsWith('mxds1.') ? body.params.cursor : null
  if (paramCursor && body.cursor != null && body.cursor !== paramCursor) invalid('Conflicting cursor aliases')
  const cursorInput = body.cursor ?? paramCursor
  const cursor = cursorInput == null ? null : scalar(cursorInput)
  if (cursorInput != null && (!cursor || typeof cursorInput !== 'string')) invalid('cursor must be a nonempty string')
  const signedCursor = cursor?.startsWith('mxds1.')
  if (cursor && /^mx[a-z0-9]*\./u.test(cursor) && !signedCursor) throw new AppError(400, 'invalid_cursor', 'Restart comments explicitly; old or foreign Hub cursors cannot be imported')
  const suppliedParams = paramCursor ? Object.fromEntries(Object.entries(body.params).filter(([key]) => key !== 'cursor')) : body.params
  const legacyRedditCursor = platform === 'reddit' && ((!signedCursor && cursor != null)
    || object(suppliedParams) && Object.hasOwn(suppliedParams, 'cursor'))
  if (legacyRedditCursor && !allowHistoricalRedditCursor) {
    throw new AppError(400, 'invalid_cursor', 'Restart Reddit comments explicitly; legacy supplier cursors cannot resume through TikHub')
  }
  // Both suppliers name this field pcursor. A raw token cannot establish its
  // supplier, so only a scoped Hub cursor may resume a new TikHub traversal.
  // An explicitly empty pcursor remains a first-page input with its old hash.
  const legacyKuaishouCursor = platform === 'kuaishou' && ((!signedCursor && cursor != null)
    || object(suppliedParams) && Object.hasOwn(suppliedParams, 'pcursor') && suppliedParams.pcursor !== '')
  if (legacyKuaishouCursor && !allowHistoricalKuaishouCursor) {
    throw new AppError(400, 'invalid_cursor', 'Restart Kuaishou comments explicitly; raw supplier cursors cannot resume through TikHub')
  }
  const validationRecipe = legacyRedditCursor ? legacyRedditRecipe : legacyKuaishouCursor ? legacyKuaishouRecipe : recipe
  const { options, initialParams } = paramsFor(validationRecipe, suppliedParams, signedCursor ? null : cursor)
  if (signedCursor && Object.keys(initialParams).length) invalid('Do not combine a Hub cursor with provider continuation parameters')
  const identity = { platform, postId: ids[0], count, includeRaw: body.includeRaw === true, options }
  const request = { ...identity, cursor, page, initialParams, operation: 'comments', path: POST_COMMENTS_PATH,
    pageSize: count, totalLimit: count, jobs: [{ id: createHash('sha256').update(JSON.stringify(identity)).digest('hex'), provider: recipe.provider }],
    fingerprintBody: { ...identity, initialParams }, ...(legacyRedditCursor ? { legacyRedditCursor: true } : {}),
    ...(legacyKuaishouCursor ? { legacyKuaishouCursor: true } : {}) }
  // Validate the fixed provider parameter types before any reservation. Runtime
  // availability is checked separately after exact historical replay.
  const normalized = normalizeNativeForwardingRequest(validationRecipe.key, { params: providerQuery(request, validationRecipe, initialParams) })
  request.options = Object.fromEntries(validationRecipe.optionFields.filter(key => normalized.upstreamQuery[key] != null).map(key => [key, normalized.upstreamQuery[key]]))
  request.initialParams = Object.fromEntries(Object.keys(initialParams).map(key => [key, normalized.upstreamQuery[key]]))
  request.fingerprintBody = { ...identity, options: request.options, initialParams: request.initialParams }
  return request
}
function providerQuery(request, recipe, continuation) {
  return { [recipe.idField]: request.postId,
    ...(request.platform === 'linkedin' ? { sortOrder: 'RELEVANCE' } : {}),
    ...request.options, ...continuation,
    ...(request.platform === 'youtube' ? { need_format: true } : {}),
    ...(request.platform === 'reddit' && recipe.provider === 'tikhub' ? { need_format: false } : {}) }
}
export function buildPostCommentsDispatch(request, job = {}, buffer = null) {
  if (request.legacyRedditCursor || request.legacyKuaishouCursor || request.legacyProviderCursor) throw new AppError(400, 'invalid_cursor', 'Historical comment cursors are replay-only')
  const recipe = POST_COMMENTS_RECIPES[request.platform]
  if (!recipe?.available) throw new AppError(503, 'external_platform_contract_unverified', 'This platform requires comment response calibration before acquisition', { platform: request.platform })
  const continuation = buffer ? buffer.providerCursor : job.providerCursor ?? request.initialParams
  const native = normalizeNativeForwardingRequest(recipe.key, { params: providerQuery(request, recipe, continuation) })
  const endpoint = NATIVE_FORWARDING_ENDPOINTS.find(row => row.key === recipe.key)
  return { ...native, provider: recipe.provider, platform: request.platform, operationKey: endpoint.operation,
    socialCompat: { stage: 'data' }, postComments: { request, recipe, continuation } }
}
export const POST_COMMENTS_TRAVERSAL = Object.freeze({ version: POST_COMMENTS_VERSION, datasetId: 'social.comments.v1',
  buildStep: buildPostCommentsDispatch, projectPage: projectPostCommentPage, countsAsPage: () => true, resolvedDone: () => false })
