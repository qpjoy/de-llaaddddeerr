import { createHash } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { createTikHubXiaohongshuRecord } from '../ingest/tikhub-xiaohongshu.mjs'
import { canonicalJson, sha256 } from '../ingest/normalizers.mjs'

export const XHS_RESEARCH_VERSION = 'mx-insight-hub.xiaohongshu-research.v1'
export const XHS_RESEARCH_ENDPOINTS = Object.freeze({
  note_detail: {
    name: 'note_detail', path: '/api/v1/data/xiaohongshu/notes/detail',
    aliases: ['/api/v1/xiaohongshu/pgy/get_note_detail'],
    providerPath: '/api/v1/xiaohongshu/pgy/get_note_detail', providerMethod: 'POST',
    endpointKey: 'xiaohongshu.pgy.note-detail.v1', endpointVersion: 'pgy',
    operation: 'social.posts.analytics', gate: 'researchContractVerified',
    fields: ['note_id'], label: '小红书详情与阅读量', research: true, liveOnly: true,
  },
  note_comments: {
    name: 'note_comments', path: '/api/v1/data/xiaohongshu/notes/comments',
    aliases: [], providerPath: '/api/v1/xiaohongshu/app_v2/get_note_comments', providerMethod: 'GET',
    endpointKey: 'xiaohongshu.app-v2.note-comments.v1', endpointVersion: 'app_v2',
    operation: 'social.comments.list', gate: 'researchContractVerified',
    fields: ['note_id', 'sort', 'cursor'], label: '小红书笔记评论', research: true, liveOnly: true,
  },
})
export const XHS_RESEARCH_OPERATIONS = Object.freeze(Object.values(XHS_RESEARCH_ENDPOINTS).map(entry => entry.operation))

function invalid(message) { throw new AppError(400, 'invalid_request', message) }
function unusable() { throw new AppError(502, 'invalid_upstream_contract', 'Note response does not match the released contract') }
const record = value => value && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' ? value : null
const count = value => (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null
function url(value) {
  try { const parsed = new URL(value); return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? value : null } catch { return null }
}
function timestamp(value) {
  if (value == null || value === '') return null
  const numeric = Number(value)
  const date = new Date(Number.isFinite(numeric) ? numeric * (numeric < 10_000_000_000 ? 1000 : 1) : value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

export function normalizeXhsResearchRequest(endpoint, input, { decodeCursor } = {}) {
  if (!record(input) || Object.keys(input).some(key => !endpoint.fields.includes(key))) invalid('Unsupported request fields')
  if (typeof input.note_id !== 'string' || !/^[a-f0-9]{24}$/iu.test(input.note_id)) invalid('note_id must be a 24-character hexadecimal ID')
  const noteId = input.note_id.toLowerCase()
  let providerQuery = { note_id: noteId }, publicQuery = { ...providerQuery }, page = 1, scope = null, providerCursor = null
  if (endpoint.name === 'note_comments') {
    const sort = input.sort ?? 'latest'
    if (!['latest', 'hot'].includes(sort)) invalid('sort must be latest or hot')
    publicQuery.sort = sort
    scope = createHash('sha256').update(JSON.stringify([XHS_RESEARCH_VERSION, noteId, sort])).digest('hex')
    providerQuery = { ...providerQuery, sort_strategy: sort === 'hot' ? 'like_count' : 'latest_v2', index: '0', pageArea: 'UNFOLDED' }
    if (input.cursor != null && input.cursor !== '') {
      if (typeof input.cursor !== 'string' || input.cursor.length > 8192 || !decodeCursor) invalid('Invalid comments cursor')
      let state
      try { state = decodeCursor(input.cursor) } catch { invalid('Invalid comments cursor') }
      if (!record(state) || state.scope !== scope || state.version !== XHS_RESEARCH_VERSION || !Number.isInteger(state.page)
        || state.page < 2 || state.page > 15 || typeof state.cursor !== 'string' || !state.cursor || state.cursor.length > 2048
        || count(state.index) == null || typeof state.pageArea !== 'string' || !state.pageArea || state.pageArea.length > 100) invalid('Invalid comments cursor')
      page = state.page; providerCursor = state.cursor
      Object.assign(providerQuery, { cursor: state.cursor, index: String(state.index), pageArea: state.pageArea })
      publicQuery.cursor = input.cursor
    }
  }
  return { endpoint, providerQuery, publicQuery, page, scope, providerCursor, contractVersion: XHS_RESEARCH_VERSION }
}

function business(payload) {
  if (payload?.code !== 200) unusable()
  if (payload.data === null) return null
  const envelope = payload?.data
  if (!record(envelope) || !Object.hasOwn(envelope, 'data')) unusable()
  if (envelope.success === false || (envelope.code != null && ![0, 200, '0', '200'].includes(envelope.code))) unusable()
  if (envelope.data === null) return null
  if (!record(envelope.data)) unusable()
  return envelope.data
}

function media(images) {
  return (Array.isArray(images) ? images : []).flatMap(image => {
    const source = url(typeof image === 'string' ? image : image?.url || image?.url_default || image?.urlDefault || image?.info_list?.[0]?.url)
    return source ? [{ type: 'image', url: source, width: count(image?.width), height: count(image?.height) }] : []
  })
}

export function projectXhsResearch(payload, request, capturedAt, { encodeCursor } = {}) {
  const data = business(payload)
  const base = { code: 200, meta: { status: data === null ? 'no_data' : 'ok', collectedAt: new Date(capturedAt).toISOString() } }
  if (request.endpoint.name === 'note_detail') {
    if (data === null) return { ...base, data: { item: null } }
    if (data.noteId?.toLowerCase?.() !== request.providerQuery.note_id) unusable()
    const tagsAvailable = Array.isArray(data.tags) || Array.isArray(data.tagList)
    const item = {
      platform: 'xiaohongshu', externalId: data.noteId.toLowerCase(),
      url: url(data.noteLink) || `https://www.xiaohongshu.com/explore/${data.noteId.toLowerCase()}`,
      title: text(data.title), text: text(data.content), type: text(data.type),
      publishedAt: timestamp(data.createTime), collectedAt: base.meta.collectedAt,
      author: { id: text(data.userId), name: text(data.name), avatarUrl: url(data.headPhoto) },
      tags: (Array.isArray(data.tags) ? data.tags : Array.isArray(data.tagList) ? data.tagList : []).map(tag => text(tag) || text(tag?.name)).filter(Boolean),
      media: media(data.imagesList),
      metrics: { views: count(data.readNum), impressions: count(data.impNum), liked: count(data.likeNum), collected: count(data.favNum), comments: count(data.cmtNum), shared: null },
    }
    const video = url(data.videoInfo?.url || data.videoInfo?.videoUrl || data.videoInfo?.masterUrl)
    if (video) item.media.push({ type: 'video', url: video })
    return { ...base, meta: { ...base.meta, tagsAvailable, recommendedIntervalSeconds: 5 }, data: { item } }
  }
  if (data === null) return { ...base, data: { noteId: request.providerQuery.note_id, items: [], nextCursor: null, hasMore: false } }
  if (!Array.isArray(data.comments)) unusable()
  const comment = entry => {
    if (!record(entry) || !text(entry.id || entry.comment_id) || typeof entry.content !== 'string'
      || (entry.note_id != null && entry.note_id !== request.providerQuery.note_id)) unusable()
    return {
      id: entry.id || entry.comment_id, noteId: request.providerQuery.note_id,
      text: entry.content, liked: count(entry.like_count), publishedAt: timestamp(entry.create_time),
      author: { id: text(entry.user_info?.user_id || entry.user?.user_id), name: text(entry.user_info?.nickname || entry.user?.nickname), avatarUrl: url(entry.user_info?.image || entry.user_info?.avatar || entry.user?.avatar) },
      media: media(entry.pictures), replyCount: count(entry.sub_comment_count),
      replies: Array.isArray(entry.sub_comments) ? entry.sub_comments.map(comment) : [],
    }
  }
  const items = data.comments.map(comment)
  let more = null
  if ([true, 1, '1', 'true'].includes(data.has_more)) more = true
  if ([false, 0, '0', 'false'].includes(data.has_more)) more = false
  // Incomplete continuation is visible as unknown; never guess or restart page 1.
  const canContinue = more !== false && items.length > 0 && typeof data.cursor === 'string' && data.cursor.length > 0
    && data.cursor.length <= 2048 && data.cursor !== request.providerCursor && count(data.index) != null
    && typeof data.pageArea === 'string' && data.pageArea.length > 0 && data.pageArea.length <= 100
  const nextCursor = canContinue && request.page < 15 && encodeCursor ? encodeCursor({
    version: XHS_RESEARCH_VERSION, scope: request.scope, page: request.page + 1,
    cursor: data.cursor, index: count(data.index), pageArea: data.pageArea,
  }) : null
  return { ...base, meta: { ...base.meta, page: request.page, paginationStatus: request.page === 15 && more !== false ? 'limit_reached' : nextCursor ? 'continuable' : more === false ? 'exhausted' : 'unknown' }, data: { noteId: request.providerQuery.note_id, items, nextCursor, hasMore: nextCursor ? true : more === false ? false : null } }
}

export function xhsResearchRecords(projection, request) {
  const options = { operation: request.endpoint.operation, connectorContractVersion: XHS_RESEARCH_VERSION, parserVersion: XHS_RESEARCH_VERSION, sourcePointer: '$.data.data' }
  if (request.endpoint.name === 'note_detail') return projection.data.item ? [createTikHubXiaohongshuRecord(projection.data.item, options)] : []
  const records = []
  const append = (comment, parentId = null) => {
    const item = { platform: 'xiaohongshu', externalId: comment.id, text: comment.text, author: comment.author, media: comment.media, metrics: { liked: comment.liked, comments: comment.replyCount }, publishedAt: comment.publishedAt, collectedAt: projection.meta.collectedAt }
    const record = createTikHubXiaohongshuRecord(item, options)
    record.objectType = 'comment'; record.contentType = 'comment'
    record.stableFields.attributes = { ...record.stableFields.attributes, noteId: comment.noteId, parentCommentId: parentId }
    record.rawItem = structuredClone(comment); record.rawPayloadSha256 = sha256(canonicalJson(comment))
    record.payloadSha256 = sha256(canonicalJson({ ...record.stableFields, body: record.body, externalId: record.externalId }))
    records.push(record)
    for (const reply of comment.replies) append(reply, comment.id)
  }
  for (const comment of projection.data.items) append(comment)
  return records
}
