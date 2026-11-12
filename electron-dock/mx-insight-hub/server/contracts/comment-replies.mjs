import { createHash } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { NATIVE_FORWARDING_ENDPOINTS, normalizeNativeForwardingRequest } from './native-forwarding.mjs'
import { COMMENT_PROVIDER_CATALOG, COMMENT_REPLY_CONTENT_REQUIRED, commentProviderAvailable } from './comment-routes.mjs'
import { postCommentsPlatform, postId as normalizeContentId, bilibiliBvid } from './post-comments.mjs'
import { projectCommentReplyPage, COMMENT_REPLY_PROJECTION_PLATFORMS } from './comment-reply-projection.mjs'

export const COMMENT_REPLIES_VERSION = 'mx-insight-hub.comment-replies.v1'
export const COMMENT_REPLIES_CAPABILITY = 'social.comments.list'
export const COMMENT_REPLIES_PATH = '/api/v1/data/social/comment-replies'
export const COMMENT_REPLIES_ROUTE_INTERFACE = 'comment-replies'

// [platform, provider, supplier path, request mapping, continuation fields, contentId required, one supplier page per request]
// The mapping names which Hub identity fills which supplier parameter.
const definitions = [
  ['twitter', 'tikhub', '/api/v1/twitter/web/fetch_post_comments', { commentId: 'tweet_id' }, ['cursor'], false, true],
  ['weibo', 'tikhub', '/api/v1/weibo/web_v2/fetch_post_sub_comments', { commentId: 'id' }, ['max_id'], false, true],
  ['douyin', 'tikhub', '/api/v1/douyin/app/v3/fetch_video_comment_replies', { contentId: 'item_id', commentId: 'comment_id' }, ['cursor'], true, false],
  ['zhihu', 'tikhub', '/api/v1/zhihu/web/fetch_sub_comment_v5', { commentId: 'comment_id' }, ['offset'], false, false],
  ['reddit', 'tikhub', '/api/v1/reddit/app/fetch_comment_replies', { contentId: 'post_id', replyCursor: 'cursor' }, [], true, true],
  ['xiaohongshu', 'tikhub', '/api/v1/xiaohongshu/app_v2/get_note_sub_comments', { contentId: 'note_id', commentId: 'comment_id' }, ['cursor', 'index'], true, false],
  ['instagram', 'tikhub', '/api/v1/instagram/v3/get_comment_replies', { contentId: 'media_id', commentId: 'comment_id' }, ['min_id'], true, false],
  ['bilibili', 'tikhub', '/api/v1/bilibili/web/fetch_comment_reply', { contentId: 'bv_id', commentId: 'rpid' }, ['pn'], true, false],
  ['kuaishou', 'tikhub', '/api/v1/kuaishou/app/fetch_video_sub_comments', { contentId: 'photo_id', commentId: 'root_comment_id' }, ['pcursor'], true, true],
  ['threads', 'rapidapi', '/api/post/comments', { commentId: 'post_id' }, ['end_cursor'], false, true],
  ['threads', 'tikhub', '/api/v1/threads/web/fetch_post_comments', { commentId: 'post_id' }, ['end_cursor'], false, true],
]
const recipe = ([platform, provider, path, mapping, continuationFields, contentRequired, manualPagination]) => {
  const endpoint = NATIVE_FORWARDING_ENDPOINTS.find(row => row.provider === provider && row.path === path)
  if (!endpoint) throw new Error(`Missing reviewed comment reply request contract: ${platform}`)
  const verification = COMMENT_PROVIDER_CATALOG[COMMENT_REPLIES_ROUTE_INTERFACE][platform]?.[provider]
  if (!verification) throw new Error(`Comment reply supplier is not registered in the routing catalog: ${platform}/${provider}`)
  return Object.freeze({ platform, provider, path, key: endpoint.key, mapping: Object.freeze({ ...mapping }),
    continuationFields: Object.freeze([...continuationFields]), contentRequired, manualPagination, verification,
    available: COMMENT_REPLY_PROJECTION_PLATFORMS.includes(platform) && commentProviderAvailable(COMMENT_REPLIES_ROUTE_INTERFACE, platform, provider) })
}
export const COMMENT_REPLY_PROVIDER_RECIPES = Object.freeze(definitions.reduce((rows, row) => {
  rows[row[0]] = Object.freeze({ ...rows[row[0]], [row[1]]: recipe(row) })
  return rows
}, {}))
for (const [platform, providers] of Object.entries(COMMENT_PROVIDER_CATALOG[COMMENT_REPLIES_ROUTE_INTERFACE])) {
  if (Object.keys(providers).some(provider => !COMMENT_REPLY_PROVIDER_RECIPES[platform]?.[provider])) throw new Error(`Missing comment reply recipe for registered supplier: ${platform}`)
  if (Object.values(COMMENT_REPLY_PROVIDER_RECIPES[platform]).some(row => row.contentRequired !== COMMENT_REPLY_CONTENT_REQUIRED.includes(platform))) {
    throw new Error(`Comment reply contentId requirement differs from the routing catalog: ${platform}`)
  }
}
// Baseline: the supplier used when no routing policy chose one.
export const COMMENT_REPLY_RECIPES = Object.freeze(Object.fromEntries(Object.entries(COMMENT_REPLY_PROVIDER_RECIPES)
  .map(([platform, providers]) => [platform, providers.tikhub || Object.values(providers)[0]])))
export const commentReplyRecipe = (platform, provider = null) => provider == null ? COMMENT_REPLY_RECIPES[platform] || null
  : COMMENT_REPLY_PROVIDER_RECIPES[platform]?.[provider] || null

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const invalid = message => { throw new AppError(400, 'invalid_comment_replies_request', message) }
const scalar = value => typeof value === 'string' && value.length <= 8192 && !value.includes('\0') ? value.trim()
  : Number.isSafeInteger(value) && value >= 0 ? String(value) : null
const COMMENT_FIELDS = ['commentId', 'comment_id', 'rootCommentId', 'root_comment_id']
const CONTENT_FIELDS = ['contentId', 'content_id', 'postId', 'post_id', 'noteId', 'note_id', 'awemeId', 'aweme_id',
  'tweetId', 'tweet_id', 'videoId', 'video_id', 'url']
const FIELDS = new Set(['platform', 'replyRef', 'count', 'limit', 'pageSize', 'cursor', 'params', 'includeRaw',
  'businessId', 'business_id', ...COMMENT_FIELDS, ...CONTENT_FIELDS])

// Instagram shortcodes encode the numeric media ID in base64url digits.
const IG_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
export function instagramMediaId(code) {
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{1,11}$/u.test(code)) return null
  let id = 0n
  for (const char of code) id = id * 64n + BigInt(IG_ALPHABET.indexOf(char))
  return id > 0n && id <= 18446744073709551615n ? String(id) : null
}

export function commentReplyCommentId(platform, value) {
  const text = scalar(value)
  if (!text || text.length > 128) invalid('commentId must be a nonempty string or safe integer')
  if (platform === 'xiaohongshu') { if (!/^[a-f0-9]{24}$/iu.test(text)) invalid('Invalid Xiaohongshu comment ID'); return text.toLowerCase() }
  if (platform === 'reddit') {
    if (!/^(?:t1_)?[a-z0-9]{1,17}$/u.test(text)) invalid('Invalid Reddit comment ID')
    return text.startsWith('t1_') ? text : `t1_${text}`
  }
  if (!/^\d{1,30}$/u.test(text)) invalid('This platform requires a numeric comment ID')
  return text
}
function contentFrom(platform, body) {
  const ids = []
  for (const field of CONTENT_FIELDS) {
    if (body[field] == null) continue
    if (field === 'url') {
      // Reuse the comments contract: one canonical post URL per platform.
      ids.push(normalizeContentId(platform, idFromCommentsUrl(platform, body.url)))
    } else ids.push(normalizeContentId(platform, body[field]))
  }
  if (new Set(ids).size > 1) invalid('contentId aliases must identify the same post')
  return ids[0] ?? null
}
function idFromCommentsUrl(platform, value) {
  let u
  try { u = new URL(value) } catch { invalid('Invalid post URL') }
  const path = u.pathname
  const match = pattern => path.match(pattern)?.[1]
  const id = platform === 'twitter' ? match(/\/status\/(\d+)(?:\/|$)/u)
    : platform === 'reddit' ? match(/\/comments\/([a-z0-9]+)(?:\/|$)/u)
      : platform === 'xiaohongshu' ? match(/\/(?:explore|discovery\/item)\/([a-f0-9]{24})(?:\/|$)/iu)
        : platform === 'instagram' ? match(/\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)(?:\/|$)/u)
          : platform === 'threads' ? match(/\/post\/([A-Za-z0-9_-]+)(?:\/|$)/u)
          : platform === 'douyin' ? match(/\/video\/(\d+)(?:\/|$)/u)
            : platform === 'kuaishou' ? match(/\/(?:short-video|photo)\/([A-Za-z0-9_-]+)(?:\/|$)/u)
              : platform === 'zhihu' ? match(/\/answer\/(\d+)(?:\/|$)/u)
                : platform === 'bilibili' ? match(/\/video\/(av\d+|BV1[1-9A-HJ-NP-Za-km-z]{9})(?:\/|$)/u)
                  : platform === 'weibo' ? match(/\/(?:detail|status)\/(\d+)(?:\/|$)/u) : null
  if (!id) invalid('Use a canonical post URL or its platform ID; short links are not resolved automatically')
  return id
}

export function normalizeCommentRepliesRequest(body, { businessId, maxPageSize = 100, provider = null } = {}) {
  if (!object(body) || Object.keys(body).some(key => !FIELDS.has(key))) invalid('Unsupported comment replies request fields')
  for (const field of ['businessId', 'business_id']) if (body[field] != null && body[field] !== businessId) invalid('businessId must match the authenticated consumer')
  // replyRef is the object each comment item returns; it is only an alias
  // container for the same commentId/contentId fields.
  if (body.replyRef != null && (!object(body.replyRef) || Object.keys(body.replyRef).some(key => !['commentId', 'contentId', 'platform', 'cursor'].includes(key)))) invalid('replyRef must be the object returned with a comment')
  const ref = body.replyRef || {}
  const platform = postCommentsPlatform(body.platform ?? ref.platform)
  if (ref.platform != null && postCommentsPlatform(ref.platform) !== platform) invalid('replyRef belongs to another platform')
  if (!COMMENT_REPLY_RECIPES[platform]) throw new AppError(400, 'platform_operation_unsupported', 'Comment replies are not registered for this platform')
  const recipe = commentReplyRecipe(platform, provider)
  if (!recipe) throw new AppError(503, 'strategy_search_route_unavailable', 'The selected comment reply supplier is not registered for this platform', { platform, provider })
  const commentIds = [...COMMENT_FIELDS.filter(field => body[field] != null).map(field => body[field]), ...(ref.commentId != null ? [ref.commentId] : [])]
    .map(value => commentReplyCommentId(platform, value))
  if (!commentIds.length || new Set(commentIds).size !== 1) invalid('Supply one commentId; aliases must identify the same comment')
  const contentIds = [contentFrom(platform, body), ...(ref.contentId != null ? [normalizeContentId(platform, ref.contentId)] : [])].filter(Boolean)
  if (new Set(contentIds).size > 1) invalid('contentId aliases must identify the same post')
  const contentId = contentIds[0] ?? null
  if (recipe.contentRequired && !contentId) invalid(`${platform} replies also need the post contentId; pass the replyRef returned with the comment`)
  if (platform === 'instagram' && contentId && !instagramMediaId(contentId)) invalid('Instagram replies need a public post shortcode or numeric media ID')
  const counts = ['count', 'limit', 'pageSize'].filter(field => body[field] != null).map(field => {
    const n = typeof body[field] === 'string' && /^\d+$/u.test(body[field]) ? Number(body[field]) : body[field]
    if (!Number.isSafeInteger(n) || n < 1 || n > Math.min(100, maxPageSize)) invalid(`${field} must be an integer between 1 and ${Math.min(100, maxPageSize)}`)
    return n
  })
  if (new Set(counts).size > 1) invalid('Conflicting count aliases')
  const count = counts[0] ?? Math.min(20, maxPageSize)
  if (body.includeRaw != null && typeof body.includeRaw !== 'boolean') invalid('includeRaw must be boolean')
  const cursor = body.cursor == null ? null : scalar(body.cursor)
  if (body.cursor != null && (!cursor || typeof body.cursor !== 'string')) invalid('cursor must be a nonempty string')
  if (cursor && !cursor.startsWith('mxds1.')) throw new AppError(400, 'invalid_cursor', 'Use the nextCursor returned by this interface; supplier cursors are not accepted')
  // Reddit names hidden replies by the comment tree's `more` cursor, not by
  // the comment ID. It is the only supplier parameter callers may provide.
  let replyCursor = null
  if (body.params != null) {
    if (!object(body.params) || Object.keys(body.params).some(key => !(recipe.mapping.replyCursor && key === 'cursor'))) invalid('params is only accepted for the Reddit reply-tree cursor')
    replyCursor = scalar(body.params.cursor)
    if (!replyCursor || replyCursor.length > 4096) invalid('Invalid Reddit reply-tree cursor')
  }
  if (ref.cursor != null) {
    const cursor = scalar(ref.cursor)
    if (!recipe.mapping.replyCursor || !cursor || cursor.length > 4096 || replyCursor && replyCursor !== cursor) invalid('replyRef.cursor must be the Reddit reply-tree cursor returned with the comment')
    replyCursor = cursor
  }
  if (recipe.mapping.replyCursor && !replyCursor) invalid('This Reddit comment has no hidden replies to load; its replies are already in the comment page (replyRef carries a cursor only when more exist)')
  const identity = { platform, commentId: commentIds[0], contentId, count, includeRaw: body.includeRaw === true,
    ...(replyCursor ? { replyCursor } : {}) }
  const request = { ...identity, provider: recipe.provider, cursor, page: 1, operation: 'comment-replies', path: COMMENT_REPLIES_PATH,
    routeInterface: COMMENT_REPLIES_ROUTE_INTERFACE, pageSize: count, totalLimit: count, initialParams: null,
    jobs: [{ id: createHash('sha256').update(JSON.stringify(identity)).digest('hex'), provider: recipe.provider }],
    fingerprintBody: identity }
  // Validate supplier parameter types before any reservation.
  normalizeNativeForwardingRequest(recipe.key, { params: replyProviderQuery(request, recipe, null) })
  return request
}

export function replyProviderQuery(request, recipe, continuation) {
  const query = {}
  for (const [field, name] of Object.entries(recipe.mapping)) {
    const value = field === 'commentId' ? request.commentId : field === 'replyCursor' ? request.replyCursor
      : request.platform === 'bilibili' ? bilibiliBvid(request.contentId)
        : request.platform === 'instagram' ? instagramMediaId(request.contentId) : request.contentId
    if (value != null) query[name] = value
  }
  return { ...query, ...(continuation || {}),
    ...(request.platform === 'reddit' ? { need_format: false } : {}) }
}

export function buildCommentRepliesDispatch(request, job = {}, buffer = null) {
  const recipe = commentReplyRecipe(request.platform, request.provider)
  if (!recipe?.available) throw new AppError(503, 'external_platform_contract_unverified',
    'Replies on this platform require supplier response calibration before acquisition', { platform: request.platform, provider: request.provider })
  const continuation = buffer ? buffer.providerCursor : job.providerCursor ?? null
  const native = normalizeNativeForwardingRequest(recipe.key, { params: replyProviderQuery(request, recipe, continuation) })
  const endpoint = NATIVE_FORWARDING_ENDPOINTS.find(row => row.key === recipe.key)
  return { ...native, provider: recipe.provider, platform: request.platform, operationKey: endpoint.operation,
    socialCompat: { stage: 'data' }, commentReplies: { request, recipe, continuation } }
}

export const COMMENT_REPLIES_TRAVERSAL = Object.freeze({ version: COMMENT_REPLIES_VERSION, datasetId: 'social.comments.v1',
  buildStep: buildCommentRepliesDispatch, projectPage: projectCommentReplyPage, countsAsPage: () => true, resolvedDone: () => false })
