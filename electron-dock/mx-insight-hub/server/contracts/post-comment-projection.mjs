import { createHash } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { applyMapping, refreshMappedPayloadSha256 } from '../ingest/external/mapping.mjs'
import { canonicalJson } from '../ingest/normalizers.mjs'
import { projectXhsResearch, XHS_RESEARCH_ENDPOINTS } from './xiaohongshu-research.mjs'
import { projectYoutubeCommentsPage } from './youtube-comments.mjs'

// Instagram: anonymous observed shape in instagram-native.test.mjs, request
// d24f7dcf-7508-427e-b273-ac18ab161ca6. XHS/YouTube reuse their released parsers.
// A documented request endpoint alone does not verify a response projection.
export const POST_COMMENT_PROJECTION_PLATFORMS = Object.freeze(['xiaohongshu', 'instagram', 'youtube',
  'twitter', 'reddit', 'kuaishou', 'weibo', 'douyin', 'tiktok', 'zhihu', 'linkedin', 'bilibili', 'facebook'])
const TIKHUB_PLATFORMS = new Set(['xiaohongshu', 'instagram', 'youtube'])
const VERSION = 'mx-insight-hub.post-comments.v1'
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const unusable = () => { throw new AppError(502, 'invalid_upstream_contract', 'Comment response does not match the released contract') }
const scalar = value => typeof value === 'string' && value && value.length <= 8192 && !value.includes('\0') ? value
  : Number.isSafeInteger(value) ? String(value) : null
const count = value => (typeof value === 'number' || typeof value === 'string' && /^\d+$/u.test(value))
  && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null
const flag = value => [true, 1, '1', 'true'].includes(value) ? true : [false, 0, '0', 'false'].includes(value) ? false : null
function timestamp(value) {
  if (value == null || value === '') return null
  const number = typeof value === 'number' || typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : null
  const date = new Date(number === null ? value : number * (number < 10_000_000_000 ? 1000 : 1))
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
function page(nextParams, known) {
  return { hasMore: Boolean(nextParams), nextParams, nextPage: null,
    ...(!nextParams && !known ? { stopReason: 'continuation_unproven' } : {}) }
}
function canonical(row, raw, capturedAt, provider) {
  const { raw: _requestedRaw, ...stableRow } = row
  const { record } = applyMapping(stableRow, {
    externalId: { from: 'commentId' }, contentType: { from: 'objectType' }, body: { from: 'content' },
    url: { from: 'url' }, authorExternalId: { from: 'author_id' }, authorName: { from: 'author_name' },
    eventTime: { from: 'publishedAt' }, collectedAt: { from: 'collected_at' }, media: { from: 'media' },
    'metrics.likes': { from: 'like_count' }, 'metrics.comments': { from: 'reply_count' },
    'metrics.shares': { from: 'metrics.shares' }, 'metrics.views': { from: 'metrics.views' },
    'metrics.bookmarks': { from: 'metrics.bookmarks' },
  }, { platform: row.platform, objectType: 'comment' })
  if (!record) unusable()
  // Mapping normalizes scalar whitespace; comment bodies retain their complete
  // original text in both the public projection and canonical observation.
  record.body = row.content
  record.parserVersion = VERSION
  record.collectedAt = new Date(capturedAt)
  record.stableFields.connectorId = `external-platform:${provider}`
  record.stableFields.attributes = { ...record.stableFields.attributes, postId: row.postId,
    parentExternalId: row.parentExternalId, rootExternalId: row.postId, parentCommentId: row.parentCommentId || null,
    publishedTime: row.publishedTime || null }
  record.rawItem = structuredClone(raw)
  record.rawPayloadSha256 = createHash('sha256').update(canonicalJson(raw)).digest('hex')
  refreshMappedPayloadSha256(record)
  return record
}
function item(request, values, raw, capturedAt) {
  const commentId = scalar(values.commentId)
  if (!commentId || typeof values.text !== 'string' && !(values.text === null && values.media?.length)) unusable()
  const author = values.author || {}, likes = count(values.likes), replies = count(values.replies)
  const { likes: _rawLikes, replies: _rawReplies, ...publicValues } = values
  return { ...publicValues, id: `${request.platform}:comment:${commentId}`, externalId: commentId,
    commentId, content_id: commentId, postId: request.postId, contentId: request.postId,
    parentExternalId: values.parentCommentId || request.postId, rootExternalId: request.postId,
    platform: request.platform, objectType: 'comment', type: 'comment',
    content: values.text, text: values.text, full_text: values.text,
    author, author_id: author.id ?? author.channelId ?? null, author_name: author.name ?? author.displayName ?? null,
    publishedAt: values.publishedAt ?? null, collected_at: capturedAt,
    likeCount: likes, like_count: likes, replyCount: replies, reply_count: replies,
    metrics: { likes, replies, ...(values.metrics || {}) }, repliesIncluded: Boolean(values.parentCommentId),
    ...(request.includeRaw ? { raw: structuredClone(raw) } : {}) }
}

function cursorPage(data, responseKey, requestKey, continuation, explicitMore = null, extras = {}) {
  const value = data[responseKey]
  const next = value === '' || value == null ? null : scalar(value)
  if (value != null && value !== '' && !next) unusable()
  const terminal = explicitMore === false || Object.hasOwn(data, responseKey) && (value === null || value === '') && explicitMore !== true
  return page(!terminal && next && next !== scalar(continuation?.[requestKey]) ? { ...extras, [requestKey]: next } : null, terminal)
}
function list(value) { if (!Array.isArray(value) || value.length > 1000) unusable(); return value }
const author = (id, name, avatarUrl) => ({ id: scalar(id), name: typeof name === 'string' ? name : null,
  avatarUrl: typeof avatarUrl === 'string' ? avatarUrl : null })
function linkedCommentId(permalink) {
  try {
    const parsed = new URL(permalink)
    const id = parsed.searchParams.get('commentUrn')
    if (['www.linkedin.com', 'linkedin.com'].includes(parsed.hostname) && /^urn:li:comment:\([^\0]+\)$/u.test(id || '')) return id
  } catch { /* malformed provider field is handled as contract drift */ }
  unusable()
}
// These provider-specific shapes were read without a paid call from JustOne's
// official documentation sample service, /status/api-example/detail?api=<path>,
// on 2026-11-02. They are not inferred from TikHub's generic ResponseModel.
function justOne(payload, step, capturedAt) {
  const { request, continuation = null } = step.postComments, data = payload.data
  if (payload.code !== 0 || !object(data)) unusable()
  const rows = [], raws = []
  const append = (raw, values) => { rows.push(item(request, values, raw, capturedAt)); raws.push(raw) }
  let providerPage
  switch (request.platform) {
    case 'twitter':
      if (data.status !== 'ok') unusable()
      for (const raw of list(data.timeline)) {
        if (!object(raw) || raw.type !== 'tweet') unusable()
        // The requested post can appear as timeline context; it is not itself
        // a comment. All acquired business data remains in the page archive.
        if (scalar(raw.tweet_id) === request.postId) continue
        if (scalar(raw.conversation_id) !== request.postId || !scalar(raw.in_reply_to_status_id_str)) unusable()
        const user = raw.user_info || {}, parent = scalar(raw.in_reply_to_status_id_str)
        append(raw, { commentId: raw.tweet_id, text: raw.text, publishedAt: timestamp(raw.created_at),
          author: author(user.rest_id, user.name, user.avatar), authorHandle: scalar(user.screen_name),
          parentCommentId: parent && parent !== request.postId ? parent : null,
          url: `https://x.com/i/status/${scalar(raw.tweet_id)}`, likes: raw.favorites, replies: raw.replies,
          metrics: { shares: count(raw.retweets), views: count(raw.views), bookmarks: count(raw.bookmarks), quotes: count(raw.quotes) } })
      }
      providerPage = cursorPage(data, 'next_cursor', 'cursor', continuation)
      break
    case 'reddit': {
      const post = data.postInfoById, forest = post?.commentForest
      if (!object(post) || !object(forest) || scalar(post.id)?.replace(/^t3_/u, '') !== request.postId.replace(/^t3_/u, '')) unusable()
      const trees = list(forest.trees)
      for (const tree of trees) {
        if (!object(tree)) unusable()
        if (tree.node === null && object(tree.more)) continue
        const raw = tree.node, user = raw?.authorInfo || {}
        if (!object(raw) || raw.__typename !== 'Comment') unusable()
        append(tree, { commentId: raw.id, text: raw.content?.markdown, publishedAt: timestamp(raw.createdAt),
          author: author(user.id, user.name, user.iconSmall?.url), likes: null, replies: tree.childCount,
          metrics: { score: Number.isSafeInteger(raw.score) ? raw.score : null },
          parentCommentId: scalar(tree.parentId)?.replace(/^t3_/u, '') === request.postId.replace(/^t3_/u, '') ? null : scalar(tree.parentId),
          url: typeof raw.permalink === 'string' ? `https://www.reddit.com${raw.permalink}` : null })
      }
      providerPage = cursorPage({ cursor: trees.at(-1)?.more?.cursor }, 'cursor', 'cursor', continuation,
        flag(forest.pageInfo?.hasNextPage))
      break
    }
    case 'kuaishou':
      if (data.result !== 1) unusable()
      for (const raw of list(data.rootComments)) append(raw, { commentId: raw.comment_id, text: raw.content,
        publishedAt: timestamp(raw.timestamp), author: author(raw.author_id, raw.author_name, raw.headurl),
        likes: raw.likedCount, replies: raw.subCommentCount, url: request.url || null })
      providerPage = data.pcursor === 'no_more' ? page(null, true) : cursorPage(data, 'pcursor', 'pcursor', continuation)
      break
    case 'weibo':
      if (data.ok !== 1) unusable()
      for (const raw of list(data.data)) append(raw, { commentId: raw.idstr ?? raw.id, text: raw.text_raw ?? raw.text,
        publishedAt: timestamp(raw.created_at), author: author(raw.user?.idstr ?? raw.user?.id, raw.user?.screen_name, raw.user?.profile_image_url),
        likes: raw.like_counts, replies: raw.total_number, url: request.url || null })
      providerPage = [0, '0'].includes(data.max_id) ? page(null, true) : cursorPage(data, 'max_id', 'maxId', continuation)
      break
    case 'douyin':
    case 'tiktok':
      if (data.status_code !== 0) unusable()
      for (const raw of list(data.comments)) {
        if (raw.aweme_id != null && scalar(raw.aweme_id) !== request.postId) unusable()
        append(raw, { commentId: raw.cid, text: raw.text, publishedAt: timestamp(raw.create_time),
          author: author(raw.user?.uid, raw.user?.nickname, raw.user?.avatar_thumb?.url_list?.[0]),
          likes: raw.digg_count, replies: raw.reply_comment_total, url: request.url || null })
      }
      if (request.platform === 'douyin') providerPage = flag(data.has_more) === true
        ? page({ page: Number(continuation?.page || 1) + 1 }, false) : page(null, flag(data.has_more) === false)
      else providerPage = cursorPage(data, 'cursor', 'cursor', continuation, flag(data.has_more))
      break
    case 'zhihu': {
      for (const raw of list(data.data)) append(raw, { commentId: raw.id, text: raw.content,
        publishedAt: timestamp(raw.created_time), author: author(raw.author?.id, raw.author?.name, raw.author?.avatar_url),
        likes: raw.like_count, replies: raw.child_comment_count, url: typeof raw.url === 'string' ? raw.url : null,
        metrics: { dislikes: count(raw.dislike_count) } })
      const ended = flag(data.paging?.is_end)
      let offset = null
      if (ended !== true && data.paging?.next) {
        try {
          const next = new URL(data.paging.next)
          if (next.hostname !== 'www.zhihu.com' || next.pathname !== `/api/v4/comment_v5/answers/${request.postId}/root_comment`) unusable()
          offset = next.searchParams.get('offset')
        } catch { unusable() }
      }
      providerPage = cursorPage(offset ? { offset } : {}, 'offset', 'offset', continuation, ended === true ? false : ended === false ? true : null)
      break
    }
    case 'linkedin':
      for (const raw of list(data.data)) append(raw, { commentId: linkedCommentId(raw.permalink), text: raw.text,
        publishedAt: timestamp(raw.created_at), author: author(raw.commenter?.urn, raw.commenter?.name, raw.commenter?.image_url),
        likes: null, replies: null, url: raw.permalink })
      providerPage = cursorPage(data, 'pagination_token', 'paginationToken', continuation, null,
        { page: Number(continuation?.page || 1) + 1 })
      break
    case 'bilibili': {
      if (data.code !== 0 || !object(data.data)) unusable()
      const body = data.data, seen = new Set()
      for (const raw of [...(body.top_replies == null ? [] : list(body.top_replies)), ...list(body.replies)]) {
        const id = scalar(raw.rpid_str ?? raw.rpid)
        if (!id) unusable()
        if (seen.has(id)) continue
        seen.add(id)
        append(raw, { commentId: id, text: raw.content?.message, publishedAt: timestamp(raw.ctime),
          author: author(raw.member?.mid, raw.member?.uname, raw.member?.avatar), likes: raw.like, replies: raw.rcount,
          url: request.url || null })
      }
      providerPage = cursorPage({ cursor: body.cursor?.pagination_reply?.next_offset }, 'cursor', 'cursor', continuation,
        flag(body.cursor?.is_end) === true ? false : flag(body.cursor?.is_end) === false ? true : null)
      break
    }
    case 'facebook':
      for (const raw of list(data.results)) {
        if (raw.type !== 'comment') unusable()
        const media = raw.is_sticker === true && typeof raw.sticker?.image?.uri === 'string'
          ? [{ type: 'image', url: raw.sticker.image.uri, width: count(raw.sticker.image.width), height: count(raw.sticker.image.height) }] : []
        append(raw, { commentId: raw.comment_id, legacyCommentId: scalar(raw.legacy_comment_id), text: raw.message,
          parentCommentId: scalar(raw.parent_comment_id), publishedAt: timestamp(raw.created_time),
          author: author(raw.author?.id, raw.author?.name, raw.author?.profile_image), likes: null,
          replies: raw.replies_count, media, metrics: { reactions: count(raw.reactions_count) }, url: request.url || null })
      }
      providerPage = cursorPage(data, 'cursor', 'cursor', continuation)
      break
    default: unusable()
  }
  return { projected: { acquiredItems: rows, profiles: [], providerPage },
    records: rows.map((row, index) => canonical(row, raws[index], capturedAt, 'justone')) }
}

export function projectPostCommentPage(payload, step, { capturedAt }) {
  const { request, continuation = null } = step.postComments
  if (!POST_COMMENT_PROJECTION_PLATFORMS.includes(request.platform)) {
    throw new AppError(503, 'external_platform_contract_unverified', 'This platform comment response requires calibration')
  }
  if (!object(payload)) unusable()
  const provider = TIKHUB_PLATFORMS.has(request.platform) ? 'tikhub' : 'justone'
  if (step.provider !== provider) unusable()
  if (provider === 'justone') return justOne(payload, step, capturedAt)
  if (payload.code !== 200) unusable()
  const rows = [], rawRows = []
  let providerPage
  if (request.platform === 'instagram') {
    const data = payload.data
    if (!object(data) || data.status !== 'ok' || !Array.isArray(data.comments) || data.comments.length > 1000) unusable()
    for (const raw of data.comments) {
      if (!object(raw) || !scalar(raw.pk) || typeof raw.text !== 'string') unusable()
      const user = object(raw.user) ? raw.user : {}
      const authorId = scalar(user.id ?? user.pk_id ?? user.pk)
      if ((user.id != null || user.pk_id != null || user.pk != null) && authorId === null) unusable()
      rows.push(item(request, { commentId: scalar(raw.pk), text: raw.text,
        url: `https://www.instagram.com/p/${encodeURIComponent(request.postId)}/`,
        mediaId: scalar(raw.media_id), publishedAt: timestamp(raw.created_at_utc ?? raw.created_at),
        author: { id: authorId, name: typeof user.username === 'string' ? user.username : null,
          avatarUrl: typeof user.profile_pic_url === 'string' ? user.profile_pic_url : null },
        likes: raw.comment_like_count, replies: raw.child_comment_count }, raw, capturedAt))
      rawRows.push(raw)
    }
    const more = flag(data.has_more_comments), next = scalar(data.next_min_id)
    if (data.next_min_id != null && data.next_min_id !== '' && !next) unusable()
    const canContinue = more !== false && next && next !== continuation?.min_id
    providerPage = page(canContinue ? { min_id: next } : null, more === false)
  } else if (request.platform === 'xiaohongshu') {
    let nextParams = null
    const projected = projectXhsResearch(payload, { endpoint: XHS_RESEARCH_ENDPOINTS.note_comments,
      providerQuery: { note_id: request.postId }, providerCursor: continuation?.cursor,
      page: 1, scope: 'post-comments' }, capturedAt, { encodeCursor: state => {
      nextParams = { cursor: state.cursor, index: String(state.index), pageArea: state.pageArea }
      return 'continuation-available'
    } })
    const source = payload.data?.data?.comments || []
    if (source.length > 1000) unusable()
    projected.data.items.forEach((value, index) => {
      rows.push(item(request, { commentId: value.id, text: value.text, publishedAt: value.publishedAt,
        author: value.author, media: value.media, likes: value.liked, replies: value.replyCount,
        url: `https://www.xiaohongshu.com/explore/${request.postId}` }, source[index], capturedAt))
      rawRows.push(source[index])
    })
    providerPage = page(nextParams, projected.meta.paginationStatus === 'exhausted')
  } else {
    const result = projectYoutubeCommentsPage(payload, { youtube: { stage: 'comments', videoId: request.postId,
      videoIndex: 0, resolved: {}, request: { kind: 'video', includeRaw: false } } }, { capturedAt })
    result.projected.acquiredItems.forEach((value, index) => {
      rows.push(item(request, { commentId: value.commentId, videoId: request.postId, text: value.text,
        url: value.url, publishedTime: value.publishedTime, publishedAt: value.publishedAt,
        author: value.author, likes: value.likeCount, replies: value.replyCount }, payload.data.comments[index], capturedAt))
      rawRows.push(payload.data.comments[index])
    })
    const previous = result.projected.providerPage, next = previous.nextParams?.token
    providerPage = page(next && next !== continuation?.continuation_token ? { continuation_token: next } : null,
      !previous.stopReason && !next)
  }
  return { projected: { acquiredItems: rows, profiles: [], providerPage },
    records: rows.map((row, index) => canonical(row, rawRows[index], capturedAt, step.provider || 'tikhub')) }
}
