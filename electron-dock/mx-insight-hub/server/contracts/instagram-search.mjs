import { createHash } from 'node:crypto'

export const INSTAGRAM_SEARCH_KEY = 't.instagram_v3_general_search'
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' ? value : ''
const id = value => typeof value === 'string' && /^\d{1,40}(?:_\d{1,30})?$/.test(value) ? value
  : Number.isSafeInteger(value) && value > 0 ? String(value) : null
const metric = value => value != null && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null
const token = value => typeof value === 'string' && value.length <= 2048 ? value : null
const POST_FIELDS = ['id', 'pk', 'code', 'shortcode', 'media', 'caption', 'caption_text',
  'media_type', 'taken_at', 'image_versions2', 'video_versions', 'carousel_media']
const RECOMMENDATION_TYPES = ['user', 'hashtag', 'place']

function recommendation(value, type) {
  // IDs also occur on accounts/topics/places. The typed container establishes
  // their meaning, but it must never hide a post or a conflicting wrapper.
  if (!object(value) || POST_FIELDS.slice(2).some(field => Object.hasOwn(value, field))
    || RECOMMENDATION_TYPES.some(field => Object.hasOwn(value, field))) return false
  return type !== 'user' || !!((id(value.id) || id(value.pk)) && text(value.username).trim())
}

function listMedia(entries) {
  return entries.flatMap(entry => {
    if (!object(entry)) throw new Error('invalid_instagram_search_shape')
    // General search mixes media with explicitly typed recommendations. Never
    // discard a malformed post just because it also has a user or hashtag.
    if (object(entry.media)) return [entry.media]
    if (entry.code || entry.shortcode) return [entry]
    const types = RECOMMENDATION_TYPES.filter(field => Object.hasOwn(entry, field))
    if (!POST_FIELDS.some(field => Object.hasOwn(entry, field)) && types.length === 1
      && recommendation(entry[types[0]], types[0])) return []
    throw new Error('invalid_instagram_search_shape')
  })
}

function searchMedia(data) {
  const values = []
  let recognized = false, nonPostCount = 0
  // Independent containers may coexist. Validate and collect all of them;
  // an empty grid must not hide list media, nor suggestions hide a bad grid.
  for (const field of ['media_grid', 'mediaGrid']) {
    const grid = data[field]
    if (grid == null) continue
    if (!object(grid) || !Array.isArray(grid.sections)) throw new Error('invalid_instagram_search_shape')
    recognized = true
    for (const section of grid.sections) {
      const layout = section?.layout_content ?? section?.layoutContent
      if (!object(layout)) throw new Error('invalid_instagram_media_grid')
      const media = layout.medias ?? layout.media ?? []
      if (!Array.isArray(media)) throw new Error('invalid_instagram_media_grid')
      values.push(...media.map(entry => entry?.media ?? entry))
    }
  }
  if (data.items != null) {
    if (!Array.isArray(data.items)) throw new Error('invalid_instagram_search_shape')
    recognized = true
    values.push(...data.items.map(entry => entry?.media ?? entry))
  }
  if (data.list != null) {
    if (data.status !== 'ok' || !Array.isArray(data.list)) throw new Error('invalid_instagram_search_shape')
    const media = listMedia(data.list)
    recognized = true
    nonPostCount += data.list.length - media.length
    values.push(...media)
  }
  // The provider documents these separate groups as well as mixed list pages.
  // Retain their original data in the raw archive; the post contract excludes them.
  for (const [field, type] of [['users', 'user'], ['hashtags', 'hashtag'], ['places', 'place']]) {
    if (data[field] == null) continue
    if (!Array.isArray(data[field])) throw new Error('invalid_instagram_search_shape')
    for (const entry of data[field]) {
      if (object(entry) && Object.hasOwn(entry, type)) {
        if (listMedia([entry]).length) throw new Error('invalid_instagram_search_shape')
      } else if (!recommendation(entry, type)) throw new Error('invalid_instagram_search_shape')
    }
    recognized = true
    nonPostCount += data[field].length
  }
  const keywords = data.other_results?.keyword_recommendations?.keywords
  if (keywords != null) {
    if (!Array.isArray(keywords) || keywords.some(value =>
      !(typeof value === 'string' && value.trim()) && !recommendation(value, 'keyword'))) {
      throw new Error('invalid_instagram_search_shape')
    }
    recognized = true
    nonPostCount += keywords.length
  }
  if (!recognized) throw new Error('invalid_instagram_search_shape')
  return { values, nonPostCount }
}

function rendition(values) {
  return (Array.isArray(values) ? values : []).filter(value => typeof value?.url === 'string')
    .sort((a, b) => (Number(b.width) * Number(b.height) || 0) - (Number(a.width) * Number(a.height) || 0))[0]?.url
}

function instagramRow(value, capturedAt) {
  if (!object(value)) throw new Error('invalid_instagram_post_identity')
  const contentId = id(value.id) || id(value.pk)
  const shortcode = text(value.code || value.shortcode).trim()
  if (!contentId || !shortcode) throw new Error('invalid_instagram_post_identity')
  const caption = text(value.caption?.text || value.caption_text || value.caption)
  const user = value.user || value.owner || {}
  const images = [], videos = []
  for (const media of [value, ...(Array.isArray(value.carousel_media) ? value.carousel_media : [])]) {
    const image = rendition(media.image_versions2?.candidates) || text(media.display_url)
    const video = rendition(media.video_versions) || text(media.video_url)
    if (image) images.push(image)
    if (video) videos.push(video)
  }
  const timestamp = Number(value.taken_at)
  const date = timestamp > 0 ? new Date(timestamp * 1000) : null
  return { content_id: contentId, platform_name: 'instagram', title: '', text: caption, content: caption, full_text: caption,
    content_type: Number(value.media_type) === 2 ? 'video' : 'post',
    url: `https://www.instagram.com/p/${encodeURIComponent(shortcode)}/`,
    author_id: id(user.id) || id(user.pk), author_name: text(user.username || user.full_name),
    author_avatar_url: text(user.profile_pic_url || user.profile_picture_url) || null,
    created_at: date && Number.isFinite(date.getTime()) ? date.toISOString() : null, collected_at: capturedAt,
    like_count: metric(value.like_count), comment_count: metric(value.comment_count),
    view_count: metric(value.play_count ?? value.view_count),
    cover_url: images[0] || null, image_urls: JSON.stringify([...new Set(images)]), video_urls: JSON.stringify([...new Set(videos)]) }
}

export function projectInstagramSearch(result, request) {
  const root = result.publicBody?.data
  const data = object(root?.data) ? root.data : root
  if (!object(data) || (data.status && data.status !== 'ok')) throw new Error('invalid_instagram_search_shape')
  const grid = data.media_grid || data.mediaGrid
  const { values, nonPostCount } = searchMedia(data)
  const capturedAt = result.publicBody.meta.capturedAt
  const rows = [...new Map(values.map(value => {
    const row = instagramRow(value, capturedAt)
    return [row.content_id, row]
  })).values()]
  // The upstream has no count parameter. Page over its immutable paid receipt
  // before advancing next_max_id; never truncate or reacquire an overflow page.
  const rowsHash = createHash('sha256').update(JSON.stringify(rows)).digest('hex')
  const offset = request.buffer?.offset ?? 0
  if (request.buffer && (request.buffer.hash !== rowsHash || offset >= rows.length
    || offset % request.pageSize !== 0)) throw new Error('instagram_buffer_mismatch')
  const items = rows.slice(offset, offset + request.pageSize)
  const buffered = offset + items.length < rows.length
  const callId = request.buffer?.callId ?? request.archiveCallId
  if (buffered && !callId) throw new Error('instagram_page_archive_required')
  const page = object(grid) ? grid : data
  const nextValue = page.next_max_id ?? data.next_max_id
  const rankValue = data.rank_token ?? page.rank_token
  if ((nextValue != null && token(nextValue) === null) || (rankValue != null && token(rankValue) === null)) throw new Error('invalid_instagram_continuation')
  const next = token(nextValue)
  const rank = token(rankValue) || request.providerCursor?.rank_token || null
  const more = page.more_available ?? page.has_more ?? page.has_next_page ?? data.more_available ?? data.has_more ?? data.has_next_page
  if (more != null && ![true, false, 0, 1, '0', '1', 'true', 'false'].includes(more)) throw new Error('invalid_instagram_pagination')
  const expectsMore = [true, 1, '1', 'true'].includes(more)
  // A verified non-post-only page can advertise more recommendations without
  // giving a usable cursor. Report incomplete pagination, never invent a cursor
  // or quarantine the whole endpoint. Media/empty/unknown pages stay strict.
  const nonPostContinuationMissing = expectsMore && !next && nonPostCount > 0 && rows.length === 0
  if (expectsMore && !next && !nonPostContinuationMissing) throw new Error('missing_instagram_continuation')
  // A recommendation-only page can still have a valid continuation to media.
  const upstreamMore = !!next && ![false, 0, '0', 'false'].includes(more) && next !== request.providerCursor?.next_max_id
  const hasMore = request.page < 15 && (buffered || upstreamMore)
  const nextCursor = !hasMore ? null : request.encodeNext({ page: request.page + 1,
    ...(buffered ? { buffer: { callId, offset: offset + items.length, hash: rowsHash }, providerCursor: request.providerCursor }
      : { providerCursor: { next_max_id: next, ...(rank ? { rank_token: rank } : {}) } }) })
  const warnings = []
  if (nonPostContinuationMissing) warnings.push({ code: 'INSTAGRAM_NON_POST_CONTINUATION_UNAVAILABLE',
    message: 'This page contains only non-post search results, but no usable continuation was supplied. Search completeness is unknown.' })
  if (request.page === 15 && (buffered || upstreamMore)) warnings.push({ code: 'INSTAGRAM_PAGE_LIMIT_REACHED',
    message: 'The 15-page traversal limit was reached; additional results may exist.' })
  return { ...result, items, acquiredItems: rows, publicBody: { contractVersion: 'mx-insight-hub.raw-search.v1', data: { platform: 'instagram', query: request.query,
    raw_info: '[]', raw_data: JSON.stringify(items), page: { page: request.page, pageSize: request.pageSize,
      returnedCount: items.length, hasMore, nextCursor }, status: warnings.length ? 'partial' : 'ok',
    ...(warnings.length ? { warnings } : {}),
    meta: { implementation: 'hub', resultCount: items.length, upstreamCallCount: request.buffer ? 0 : 1 } }, meta: { capturedAt } } }
}
