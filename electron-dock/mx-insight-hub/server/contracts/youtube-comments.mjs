import { createHash } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { NATIVE_FORWARDING_ENDPOINTS, normalizeNativeForwardingRequest } from './native-forwarding.mjs'
import { applyMapping, refreshMappedPayloadSha256 } from '../ingest/external/mapping.mjs'
import { canonicalJson } from '../ingest/normalizers.mjs'

export const YOUTUBE_COMMENTS_VERSION = 'mx-insight-hub.youtube-comments.v1'
export const YOUTUBE_COMMENTS_CAPABILITY = 'social.comments.list'
export const YOUTUBE_COMMENT_PATHS = Object.freeze({ video: '/api/v1/data/youtube/comments', channel: '/api/v1/data/youtube/channel-comments' })
const VIDEO = /^[A-Za-z0-9_-]{11}$/u
const CHANNEL = /^UC[A-Za-z0-9_-]{22}$/u
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const invalid = message => { throw new AppError(400, 'invalid_youtube_comments_request', message) }
const unusable = () => { throw new Error('invalid_youtube_comments_response') }
const scalar = value => typeof value === 'string' && value.trim() && value.length <= 8192 && !value.includes('\0') ? value.trim() : null
const integer = (value, fallback, max, name) => {
  const n = value ?? fallback
  if (!Number.isSafeInteger(n) || n < 1 || n > max) invalid(`${name} must be an integer between 1 and ${max}`)
  return n
}
function aliases(input, names, normalize = scalar) {
  const values = names.filter(name => input[name] != null).map(name => {
    const value = normalize(input[name]); if (!value) invalid(`Invalid ${name}`); return value
  })
  if (new Set(values).size > 1) invalid(`Conflicting aliases: ${names.join(', ')}`)
  return values[0] || null
}
function youtubeUrl(value) {
  try {
    const u = new URL(value)
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port
      || !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(u.hostname)) return null
    return u
  } catch { return null }
}
export function youtubeCommentVideoId(value) {
  if (typeof value !== 'string') return null
  if (VIDEO.test(value.trim())) return value.trim()
  const u = youtubeUrl(value)
  if (!u) return null
  const parts = u.pathname.split('/').filter(Boolean)
  const id = u.hostname === 'youtu.be' ? parts.length === 1 && parts[0]
    : u.pathname === '/watch' ? u.searchParams.get('v')
      : ['shorts', 'live', 'embed'].includes(parts[0]) && parts.length === 2 ? parts[1] : null
  return typeof id === 'string' && VIDEO.test(id) ? id : null
}
function channelUrl(value) {
  const u = youtubeUrl(value)
  if (!u || u.hostname === 'youtu.be' || u.search || u.hash) return null
  const parts = u.pathname.split('/').filter(Boolean)
  if (parts.length === 2 && parts[0] === 'channel' && CHANNEL.test(parts[1])) return `https://www.youtube.com/channel/${parts[1]}`
  if (parts.length === 1 && /^@[\p{L}\p{N}_.%-]{1,100}$/u.test(parts[0])
    || parts.length === 2 && ['c', 'user'].includes(parts[0]) && /^[\p{L}\p{N}_.%-]{1,100}$/u.test(parts[1])) return `https://www.youtube.com/${parts.join('/')}`
  return null
}
const OPTION_FIELDS = ['sortBy', 'sort_by', 'languageCode', 'language_code', 'countryCode', 'country_code']
const COMMON = ['platform', 'businessId', 'business_id', 'includeRaw', 'params', 'cursor', 'page', 'maxComments', 'max_comments', 'count', 'pageSize', 'limit', ...OPTION_FIELDS]
const VIDEO_FIELDS = ['videoId', 'video_id', 'postId', 'post_id', 'contentId', 'content_id', 'url']
const CHANNEL_FIELDS = ['channelId', 'channel_id', 'channelUrl', 'channel_url', 'url', 'maxVideos', 'max_videos']
export function normalizeYoutubeCommentsRequest(kind, body, { maxPageSize = 100, businessId = null } = {}) {
  if (!YOUTUBE_COMMENT_PATHS[kind] || !object(body)) invalid('A supported YouTube comments request is required')
  if (Object.keys(body).some(key => ![...COMMON, ...(kind === 'video' ? VIDEO_FIELDS : CHANNEL_FIELDS)].includes(key))) invalid('Unsupported comments request field')
  if (body.platform != null && body.platform !== 'youtube') invalid('platform must be youtube')
  if (body.includeRaw != null && typeof body.includeRaw !== 'boolean') invalid('includeRaw must be boolean')
  for (const key of ['businessId', 'business_id']) if (body[key] != null && body[key] !== businessId) invalid('businessId must match the authenticated consumer')
  if (body.params != null && (!object(body.params) || Object.keys(body.params).some(key => !OPTION_FIELDS.includes(key)))) invalid('params accepts only sort, language and country options')
  const options = { ...body.params }
  for (const key of OPTION_FIELDS) if (body[key] != null) {
    if (options[key] != null && options[key] !== body[key]) invalid(`Conflicting ${key}`)
    options[key] = body[key]
  }
  const sortBy = aliases(options, ['sortBy', 'sort_by']) || 'top'
  const languageCode = aliases(options, ['languageCode', 'language_code']) || 'zh-CN'
  const countryCode = aliases(options, ['countryCode', 'country_code']) || 'US'
  if (!['top', 'newest'].includes(sortBy) || !/^[a-z]{2,3}(?:-[A-Za-z]{2,8})?$/u.test(languageCode) || !/^[A-Z]{2}$/u.test(countryCode)) invalid('Invalid sort, language or country')
  const requestedCount = aliases(body, ['maxComments', 'max_comments', 'count', 'pageSize', 'limit'], value => Number.isSafeInteger(value) && value > 0 ? value : null)
  const maxComments = integer(requestedCount, Math.min(50, maxPageSize), Math.min(100, maxPageSize), 'maxComments')
  let videoId = null, channelId = null, url = null, maxVideos = 1
  if (kind === 'video') {
    videoId = aliases(body, VIDEO_FIELDS, youtubeCommentVideoId)
    if (!videoId) invalid('videoId, postId, contentId or a YouTube video URL is required')
  } else {
    channelId = aliases(body, ['channelId', 'channel_id'], value => typeof value === 'string' && CHANNEL.test(value.trim()) ? value.trim() : null)
    url = aliases(body, ['channelUrl', 'channel_url', 'url'], channelUrl)
    const urlId = url?.startsWith('https://www.youtube.com/channel/') ? url.split('/').at(-1) : null
    if (channelId && url && channelId !== urlId) invalid('channelId and channelUrl must identify the same channel')
    channelId ||= urlId
    if (!channelId && !url) invalid('A YouTube channelId or channelUrl is required')
    if (channelId) url = `https://www.youtube.com/channel/${channelId}`
    maxVideos = integer(aliases(body, ['maxVideos', 'max_videos'], value => Number.isSafeInteger(value) ? value : null), 5, 20, 'maxVideos')
  }
  const cursor = body.cursor == null ? null : scalar(body.cursor)
  if (body.cursor != null && !cursor) invalid('Invalid cursor')
  const page = integer(body.page, 1, 15, 'page')
  const identity = { kind, videoId, channelId, channelUrl: url, maxVideos, maxComments, sortBy, languageCode, countryCode, includeRaw: body.includeRaw === true }
  return { ...identity, platform: 'youtube', operation: 'comments', path: YOUTUBE_COMMENT_PATHS[kind],
    contractVersion: YOUTUBE_COMMENTS_VERSION, pageSize: maxComments, totalLimit: maxComments,
    page, cursor, jobs: [{ id: hash(identity), provider: 'tikhub' }], fingerprintBody: identity }
}

const ENDPOINT_PATHS = Object.freeze({ resolve: '/api/v1/youtube/web_v2/get_channel_id', videos: '/api/v1/youtube/web_v2/get_channel_videos', comments: '/api/v1/youtube/web_v2/get_video_comments' })
export function buildYoutubeCommentsDispatch(request, job, buffer = null) {
  const resolved = job.resolvedIdentity || { channelId: request.channelId, videos: [], videoCursor: null, videoPages: 0, discoveryDone: false }
  const continuation = buffer ? buffer.providerCursor : job.providerCursor
  const stage = request.kind === 'video' ? 'comments' : !resolved.channelId ? 'resolve' : !resolved.discoveryDone ? 'videos' : 'comments'
  const endpoint = NATIVE_FORWARDING_ENDPOINTS.find(row => row.provider === 'tikhub' && row.path === ENDPOINT_PATHS[stage])
  if (!endpoint) throw new AppError(503, 'external_platform_contract_unverified', 'YouTube comments require the reviewed provider contract')
  const videoIndex = continuation?.videoIndex || 0
  const videoId = request.videoId || resolved.videos[videoIndex]?.videoId
  const params = stage === 'resolve' ? { channel_url: request.channelUrl }
    : { language_code: request.languageCode, country_code: request.countryCode, need_format: true,
      ...(stage === 'videos' ? { channel_id: resolved.channelId, ...(resolved.videoCursor ? { continuation_token: resolved.videoCursor } : {}) }
        : { video_id: videoId, sort_by: request.sortBy, ...(continuation?.token ? { continuation_token: continuation.token } : {}) }) }
  const native = normalizeNativeForwardingRequest(endpoint.key, { params })
  return { ...native, provider: 'tikhub', platform: 'youtube', operationKey: endpoint.operation,
    socialCompat: { stage: stage === 'comments' ? 'data' : 'resolve' }, youtube: { stage, videoId, videoIndex, resolved, request } }
}

function token(data) {
  const present = Object.hasOwn(data, 'continuation_token') || Object.hasOwn(data, 'continuationToken')
  const values = ['continuation_token', 'continuationToken'].filter(key => data[key] != null && data[key] !== '').map(key => scalar(data[key]))
  if (values.some(value => !value) || new Set(values).size > 1) unusable()
  return { token: values[0] || null, known: present }
}
const exactCount = value => {
  if (typeof value === 'string' && /^\d+$/u.test(value)) value = Number(value)
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}
function canonical(row, raw, capturedAt, type) {
  const { raw: _requestedRaw, ...stableRow } = row
  const { record } = applyMapping(stableRow, { externalId: { from: 'content_id' }, body: { from: 'content' },
    url: { from: 'url' }, authorExternalId: { from: 'author_id' }, authorName: { from: 'author_name' },
    collectedAt: { from: 'collected_at' }, 'metrics.likes': { from: 'like_count' }, 'metrics.comments': { from: 'reply_count' } },
  { platform: 'youtube', objectType: type })
  if (!record) unusable()
  record.contentType = type === 'comment' ? 'comment' : 'video'
  record.collectedAt = new Date(capturedAt)
  record.parserVersion = YOUTUBE_COMMENTS_VERSION
  record.stableFields.connectorId = 'external-platform:tikhub'
  record.stableFields.attributes = { ...record.stableFields.attributes, ...(row.videoId ? { videoId: row.videoId, parentExternalId: row.videoId, rootExternalId: row.videoId } : {}), publishedTime: row.publishedTime || null }
  record.rawItem = raw
  record.rawPayloadSha256 = createHash('sha256').update(canonicalJson(raw)).digest('hex')
  refreshMappedPayloadSha256(record)
  return record
}
export function projectYoutubeCommentsPage(payload, step, { capturedAt }) {
  if (!object(payload) || payload.code !== 200 || !object(payload.data)) unusable()
  const { stage, request, resolved, videoId, videoIndex } = step.youtube, data = payload.data
  const projected = { acquiredItems: [], profiles: [], providerPage: { hasMore: false, nextParams: null, nextPage: null } }, records = []
  if (stage === 'resolve') {
    if (!CHANNEL.test(data.channel_id)) unusable()
    projected.resolvedIdentity = { ...resolved, channelId: data.channel_id }
  } else if (stage === 'videos') {
    if (!Array.isArray(data.videos) || data.videos.length > 1000) unusable()
    const videos = [...resolved.videos], seen = new Set(videos.map(row => row.videoId))
    let unselectedVideos = false
    for (const raw of data.videos) {
      const id = raw?.video_id ?? raw?.videoId ?? raw?.id
      if (!object(raw) || !VIDEO.test(id)) unusable()
      const video = { videoId: id, title: typeof raw.title === 'string' ? raw.title : '', url: `https://www.youtube.com/watch?v=${id}` }
      if (!seen.has(id) && videos.length < request.maxVideos) { seen.add(id); videos.push(video) }
      else if (!seen.has(id)) unselectedVideos = true
      records.push(canonical({ content_id: id, content: video.title, url: video.url, author_id: resolved.channelId, collected_at: capturedAt }, raw, capturedAt, 'post'))
    }
    const next = token(data), pages = resolved.videoPages + 1
    const repeated = next.token && (next.token === resolved.videoCursor || resolved.videoTokens?.includes(next.token))
    projected.resolvedIdentity = { ...resolved, videos, videoPages: pages, videoCursor: next.token,
      videoTokens: [...(resolved.videoTokens || []), ...(next.token ? [next.token] : [])],
      discoveryDone: !next.token || repeated || videos.length >= request.maxVideos || pages >= 5,
      discoveryPartial: repeated || !next.known || pages >= 5 && Boolean(next.token), channelHasMoreVideos: unselectedVideos || Boolean(next.token) }
    if (!videos.length && projected.resolvedIdentity.discoveryDone) projected.resolvedIdentity.emptyChannel = true
  } else {
    if (!Array.isArray(data.comments) || data.comments.length > 1000 || !VIDEO.test(videoId)) unusable()
    for (const raw of data.comments) {
      const commentId = scalar(raw?.comment_id ?? raw?.commentId ?? raw?.id)
      if (!object(raw) || !commentId || commentId.length > 256 || typeof (raw.content ?? raw.text) !== 'string') unusable()
      const author = object(raw.author) ? raw.author : {}
      const row = { id: `youtube:comment:${commentId}`, content_id: commentId, externalId: commentId, commentId, videoId,
        platform: 'youtube', objectType: 'comment', type: 'comment', content: raw.content ?? raw.text,
        text: raw.content ?? raw.text, full_text: raw.content ?? raw.text,
        url: `https://www.youtube.com/watch?v=${videoId}&lc=${encodeURIComponent(commentId)}`,
        publishedTime: typeof (raw.published_time ?? raw.publishedAt) === 'string' ? raw.published_time ?? raw.publishedAt : null,
        publishedAt: null, collected_at: capturedAt,
        likeCount: exactCount(raw.like_count), replyCount: exactCount(raw.reply_count),
        like_count: exactCount(raw.like_count), reply_count: exactCount(raw.reply_count),
        author_id: scalar(author.channel_id ?? author.channelId), author_name: scalar(author.display_name ?? author.name),
        author: { channelId: scalar(author.channel_id ?? author.channelId), displayName: scalar(author.display_name ?? author.name),
          channelUrl: scalar(author.channel_url), avatarUrl: scalar(author.avatar_url) },
        repliesIncluded: false, ...(request.includeRaw ? { raw } : {}) }
      projected.acquiredItems.push(row); records.push(canonical(row, raw, capturedAt, 'comment'))
    }
    const next = token(data)
    const nextParams = next.token ? { videoIndex, token: next.token }
      : request.kind === 'channel' && videoIndex + 1 < resolved.videos.length ? { videoIndex: videoIndex + 1, token: null } : null
    projected.providerPage = { hasMore: Boolean(nextParams), nextParams, nextPage: null,
      ...(!next.known ? { stopReason: 'continuation_unproven' } : {}) }
  }
  return { projected, records }
}

// Selected only by the server-owned workflow kind, never by request JSON.
export const YOUTUBE_COMMENTS_TRAVERSAL = Object.freeze({
  version: YOUTUBE_COMMENTS_VERSION, datasetId: 'social.comments.v1', maxResolves: 6,
  buildStep: buildYoutubeCommentsDispatch, projectPage: projectYoutubeCommentsPage,
  countsAsPage: step => step.youtube.stage !== 'resolve',
  resolvedDone: job => job.resolvedIdentity?.emptyChannel === true,
})
