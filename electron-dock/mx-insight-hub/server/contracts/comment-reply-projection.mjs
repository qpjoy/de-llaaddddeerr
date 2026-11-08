import { AppError } from '../core/errors.mjs'
import { parseTikHubTwitterCommentPage } from './twitter-comment-page.mjs'
import { parseTikHubWeiboCommentPage } from './weibo-comment-page.mjs'
import { parseTikHubRedditCommentPage } from './reddit-comment-page.mjs'
import { parseTikHubKuaishouReplyPage } from './kuaishou-comment-page.mjs'
import { postCommentItem, postCommentRecord, douyinCommentRows, douyinCursorPage, projectZhihuCommentList,
  bilibiliReplyRows, bilibiliPage } from './post-comment-projection.mjs'

// Reply parsers, calibrated with live TikHub pages on 2026-11-07 (paid samples
// authorized by the user; raw pages kept outside the repository):
// - Twitter: same endpoint and parser as comments, asked for the comment's own
//   tweet ID; 36 thread rows parsed (direct parent not stated).
// - Douyin: reply_id = root comment, reply_to_reply_id = direct target ("0" for
//   the root); 5/5 replies with has_more 0.
// - Kuaishou: data.subComments rows, reply_to is a user; 4/4 with "no_more".
// - Bilibili: data.data.replies with page {num,size,count}; parent names the
//   direct target; 20 rows on page 1 of 2,267.
// - Instagram: page 1 data.child_comments + next_min_child_cursor; page 2 came
//   back as data.comments + next_min_id (ISO times); 17/17 distinct, no overlap.
// - Reddit: fetch_comment_replies answers a tree cursor with the same comment
//   forest (verified on the post's load-more cursor).
// - Weibo, Xiaohongshu: live reply pages were empty (envelope verified); rows
//   follow the same platform's comment objects. Zhihu: TikHub rejected the
//   Zhihu Web endpoints during calibration (unbilled), rows follow comment_v5.
export const COMMENT_REPLY_PROJECTION_PLATFORMS = Object.freeze(['twitter', 'weibo', 'douyin', 'zhihu', 'reddit', 'kuaishou',
  'bilibili', 'instagram', 'xiaohongshu'])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const scalar = value => typeof value === 'string' && value && value.length <= 8192 && !value.includes('\0') ? value
  : Number.isSafeInteger(value) ? String(value) : null
function timestamp(value) {
  if (value == null || value === '') return null
  const number = typeof value === 'number' || typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : null
  const date = new Date(number === null ? value : number * (number < 10_000_000_000 ? 1000 : 1))
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
const unusable = () => { throw new AppError(502, 'invalid_upstream_contract', 'Comment reply response does not match the released contract') }

function itemRequest(request, contentId = request.contentId) {
  return { platform: request.platform, postId: contentId ?? null, includeRaw: request.includeRaw, url: null }
}
function finish(request, { rows, raws, providerPage, capturedAt, provider, contentId = request.contentId, records = null }) {
  const items = rows.map(row => ({ ...row, type: 'reply', rootCommentId: request.commentId }))
  // Canonical comment records need their post. Without it the full page stays
  // in the restricted archive and the delivered rows are unchanged.
  const saved = contentId ? records ?? items.map((row, index) => postCommentRecord(row, raws[index], capturedAt, provider)) : []
  return { projected: { acquiredItems: items, profiles: [], providerPage }, records: saved }
}

function twitter(payload, request, continuation, capturedAt) {
  let parsed
  try { parsed = parseTikHubTwitterCommentPage(payload, request.commentId, continuation) } catch { unusable() }
  // The conversation root is the post this comment belongs to.
  const contentId = request.contentId ?? scalar(payload.data?.conversation_id)
  if (request.contentId && scalar(payload.data?.conversation_id) !== request.contentId) unusable()
  const rows = parsed.comments.map(({ raw, values }) => postCommentItem(itemRequest(request, contentId), values, raw, capturedAt))
  return finish(request, { rows, raws: parsed.comments.map(row => row.raw), providerPage: parsed.providerPage, capturedAt, provider: 'tikhub', contentId })
}
function weibo(payload, request, continuation, capturedAt) {
  let parsed
  try { parsed = parseTikHubWeiboCommentPage(payload, request.commentId, continuation, { replies: true }) } catch { unusable() }
  const rows = parsed.comments.map(({ raw, values }) => postCommentItem(itemRequest(request), values, raw, capturedAt))
  return finish(request, { rows, raws: parsed.comments.map(row => row.raw), providerPage: parsed.providerPage, capturedAt, provider: 'tikhub' })
}
function douyin(payload, request, continuation, capturedAt) {
  const data = payload.data
  if (!object(data) || data.status_code != null && data.status_code !== 0) unusable()
  if (data.comments != null && !Array.isArray(data.comments)) unusable()
  const rows = [], raws = [], req = itemRequest(request)
  douyinCommentRows(data.comments ?? [], { request: req, awemeId: request.contentId,
    append: (raw, values) => { rows.push(postCommentItem(req, values, raw, capturedAt)); raws.push(raw) },
    valuesFor: raw => {
      // reply_id names the root comment; reply_to_reply_id is "0" for a
      // direct reply and otherwise the reply being answered.
      const root = scalar(raw.reply_id), target = scalar(raw.reply_to_reply_id)
      if (root && root !== '0' && root !== request.commentId) unusable()
      const parent = target && target !== '0' ? target : request.commentId
      return { parentCommentId: parent, parentExternalId: parent, parentRelationship: 'comment' }
    } })
  return finish(request, { rows, raws, providerPage: douyinCursorPage(data, continuation), capturedAt, provider: 'tikhub' })
}
function zhihu(payload, request, continuation, capturedAt) {
  if (object(payload.params) && payload.params.comment_id != null && scalar(payload.params.comment_id) !== request.commentId) unusable()
  let data = payload.data
  if (object(data) && !Array.isArray(data.data) && object(data.data) && Array.isArray(data.data.data)) data = data.data
  const result = projectZhihuCommentList(data, { request: itemRequest(request), continuation, capturedAt, provider: 'tikhub',
    nextPath: `/api/v4/comment_v5/comment/${request.commentId}/child_comment`,
    valuesFor: raw => {
      const root = scalar(raw.reply_root_comment_id), target = scalar(raw.reply_comment_id)
      if (root && root !== request.commentId) unusable()
      const parent = target || request.commentId
      return { parentCommentId: parent, parentExternalId: parent, parentRelationship: 'comment' }
    } })
  return finish(request, { rows: result.projected.acquiredItems, raws: [], providerPage: result.projected.providerPage,
    capturedAt, provider: 'tikhub', records: result.records })
}


function parsed(request, result, { capturedAt, provider = 'tikhub', valuesFor = () => ({}) }) {
  const req = itemRequest(request)
  const rows = result.comments.map(({ raw, values }) => postCommentItem(req, { ...values, ...valuesFor(values) }, raw, capturedAt))
  return finish(request, { rows, raws: result.comments.map(row => row.raw), providerPage: result.providerPage, capturedAt, provider })
}
function reddit(payload, request, continuation, capturedAt) {
  let result
  try { result = parseTikHubRedditCommentPage(payload, request.contentId, continuation, { rootCommentId: request.commentId }) } catch { unusable() }
  // Rows without a stated parent are inside the requested comment's subtree.
  return parsed(request, result, { capturedAt, valuesFor: values => values.parentCommentId ? {} : { parentRelationship: 'unknown' } })
}
function kuaishou(payload, request, continuation, capturedAt) {
  let result
  try { result = parseTikHubKuaishouReplyPage(payload, { photoId: request.contentId, rootCommentId: request.commentId }, continuation) } catch { unusable() }
  return parsed(request, result, { capturedAt })
}
function bilibili(payload, request, continuation, capturedAt) {
  const data = payload.data
  if (!object(data) || data.code !== 0 || !object(data.data)) unusable()
  const root = data.data.root
  if (root != null && scalar(root.rpid_str ?? root.rpid) !== request.commentId) unusable()
  const rows = [], raws = [], req = itemRequest(request)
  bilibiliReplyRows(data.data.replies, { request: req, append: (raw, values) => { rows.push(postCommentItem(req, values, raw, capturedAt)); raws.push(raw) },
    valuesFor: raw => {
      const rootId = scalar(raw.root_str ?? raw.root), parentId = scalar(raw.parent_str ?? raw.parent)
      if (rootId !== request.commentId) unusable()
      const parent = parentId && parentId !== '0' ? parentId : request.commentId
      return { parentCommentId: parent, parentExternalId: parent, parentRelationship: 'comment' }
    } })
  return finish(request, { rows, raws, providerPage: bilibiliPage(data.data.page, rows.length, continuation), capturedAt, provider: 'tikhub' })
}
function instagram(payload, request, continuation, capturedAt) {
  const data = payload.data
  if (!object(data)) unusable()
  // Two observed page shapes for the same reply list (see header).
  const first = Array.isArray(data.child_comments), list = first ? data.child_comments : data.comments
  if (!Array.isArray(list) || list.length > 1000 || data.status != null && data.status !== 'ok') unusable()
  const rows = [], raws = [], req = itemRequest(request)
  for (const raw of list) {
    const id = scalar(raw?.pk ?? raw?.id), user = object(raw?.user) ? raw.user : {}
    if (!object(raw) || !id || typeof raw.text !== 'string') unusable()
    const root = scalar(raw.parent_comment_id)
    if (root && root !== request.commentId) unusable()
    const target = scalar(raw.replied_to_comment_id)
    const parent = target || (root ? request.commentId : null)
    rows.push(postCommentItem(req, { commentId: id, text: raw.text,
      publishedAt: timestamp(raw.created_at_utc ?? raw.created_at), mediaId: scalar(raw.media_id),
      author: { id: scalar(user.id ?? user.pk), name: typeof user.username === 'string' ? user.username : null,
        avatarUrl: typeof user.profile_pic_url === 'string' ? user.profile_pic_url : null },
      likes: raw.comment_like_count ?? raw.like_count, replies: raw.reply_count ?? null,
      parentCommentId: parent, parentExternalId: parent, parentRelationship: parent ? 'comment' : 'unknown',
      url: null }, raw, capturedAt))
    raws.push(raw)
  }
  const cursor = first ? data.next_min_child_cursor : data.next_min_id
  if (cursor != null && (typeof cursor !== 'string' || cursor.length > 8192)) unusable()
  const more = first ? data.has_more_head_child_comments === true || data.has_more_tail_child_comments === true : Boolean(cursor)
  const next = more && cursor && cursor !== continuation?.min_id ? { min_id: cursor } : null
  const terminal = first ? data.has_more_head_child_comments === false && data.has_more_tail_child_comments === false : !cursor
  return finish(request, { rows, raws, providerPage: { hasMore: next ? true : terminal ? false : null, nextParams: next, nextPage: null,
    ...(!next && !terminal ? { stopReason: 'continuation_unproven' } : {}) }, capturedAt, provider: 'tikhub' })
}
function xiaohongshu(payload, request, continuation, capturedAt) {
  let data = payload.data
  if (object(data) && object(data.data)) data = data.data
  if (!object(data) || !Array.isArray(data.comments) || data.comments.length > 1000) unusable()
  const rows = [], raws = [], req = { ...itemRequest(request), url: `https://www.xiaohongshu.com/explore/${request.contentId}` }
  for (const raw of data.comments) {
    const id = scalar(raw?.id ?? raw?.comment_id), user = object(raw?.user_info) ? raw.user_info : object(raw?.user) ? raw.user : {}
    if (!object(raw) || !id || typeof raw.content !== 'string' || raw.note_id != null && raw.note_id !== request.contentId) unusable()
    const target = scalar(raw.target_comment?.id)
    const parent = target || request.commentId
    const avatar = [user.image, user.avatar, user.images].find(value => typeof value === 'string') ?? null
    rows.push(postCommentItem(req, { commentId: id, text: raw.content, publishedAt: timestamp(raw.create_time ?? raw.time),
      author: { id: scalar(user.user_id ?? user.userid), name: typeof user.nickname === 'string' ? user.nickname : null, avatarUrl: avatar },
      likes: raw.like_count, replies: raw.sub_comment_count ?? null,
      parentCommentId: parent, parentExternalId: parent, parentRelationship: 'comment', url: req.url }, raw, capturedAt))
    raws.push(raw)
  }
  // The live empty page carried has_more=false and no cursor field; a next-page
  // token location is not established, so has_more=true stops as unknown.
  const more = [true, 1, '1', 'true'].includes(data.has_more), ended = [false, 0, '0', 'false'].includes(data.has_more)
  return finish(request, { rows, raws, providerPage: { hasMore: ended ? false : null, nextParams: null, nextPage: null,
    ...(!ended || more ? { stopReason: 'continuation_unproven' } : {}) }, capturedAt, provider: 'tikhub' })
}

export function projectCommentReplyPage(payload, step, { capturedAt }) {
  const { request, continuation = null } = step.commentReplies
  if (!COMMENT_REPLY_PROJECTION_PLATFORMS.includes(request.platform)) {
    throw new AppError(503, 'external_platform_contract_unverified', 'This platform reply response requires calibration')
  }
  if (!object(payload) || step.provider !== 'tikhub' || payload.code !== 200) unusable()
  if (request.platform === 'twitter') return twitter(payload, request, continuation, capturedAt)
  if (request.platform === 'weibo') return weibo(payload, request, continuation, capturedAt)
  if (request.platform === 'douyin') return douyin(payload, request, continuation, capturedAt)
  if (request.platform === 'reddit') return reddit(payload, request, continuation, capturedAt)
  if (request.platform === 'kuaishou') return kuaishou(payload, request, continuation, capturedAt)
  if (request.platform === 'bilibili') return bilibili(payload, request, continuation, capturedAt)
  if (request.platform === 'instagram') return instagram(payload, request, continuation, capturedAt)
  if (request.platform === 'xiaohongshu') return xiaohongshu(payload, request, continuation, capturedAt)
  return zhihu(payload, request, continuation, capturedAt)
}
