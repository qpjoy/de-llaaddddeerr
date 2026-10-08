export const INSTAGRAM_SEARCH_KEY = 't.instagram_v3_general_search'
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' ? value : ''
const id = value => typeof value === 'string' && /^\d{1,40}(?:_\d{1,30})?$/.test(value) ? value
  : Number.isSafeInteger(value) && value > 0 ? String(value) : null
const metric = value => value != null && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null
const token = value => typeof value === 'string' && value.length <= 2048 ? value : null

function rendition(values) {
  return (Array.isArray(values) ? values : []).filter(value => typeof value?.url === 'string')
    .sort((a, b) => (Number(b.width) * Number(b.height) || 0) - (Number(a.width) * Number(a.height) || 0))[0]?.url
}

function instagramRow(value, capturedAt) {
  const contentId = id(value.id) || id(value.pk)
  if (!contentId || !(value.code || value.shortcode)) throw new Error('invalid_instagram_post_identity')
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
    url: `https://www.instagram.com/p/${encodeURIComponent(value.code || value.shortcode)}/`,
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
  let values
  if (Array.isArray(grid?.sections)) {
    values = grid.sections.flatMap(section => {
      const layout = section.layout_content || section.layoutContent
      if (!object(layout)) throw new Error('invalid_instagram_media_grid')
      const media = layout.medias || layout.media || []
      if (!Array.isArray(media)) throw new Error('invalid_instagram_media_grid')
      return media.map(entry => entry.media || entry)
    })
  } else if (Array.isArray(data.items)) values = data.items.map(entry => entry.media || entry)
  else if (Array.isArray(data.other_results?.keyword_recommendations?.keywords)) values = []
  else throw new Error('invalid_instagram_search_shape')
  const capturedAt = result.publicBody.meta.capturedAt
  const rows = [...new Map(values.map(value => {
    const row = instagramRow(value, capturedAt)
    return [row.content_id, row]
  })).values()]
  // Never silently discard paid business records to fit the requested page.
  if (rows.length > request.pageSize) throw new Error('instagram_page_exceeds_requested_count')
  const page = object(grid) ? grid : data
  const nextValue = page.next_max_id ?? data.next_max_id
  const rankValue = data.rank_token ?? page.rank_token
  if ((nextValue != null && token(nextValue) === null) || (rankValue != null && token(rankValue) === null)) throw new Error('invalid_instagram_continuation')
  const next = token(nextValue)
  const rank = token(rankValue) || request.providerCursor?.rank_token || null
  const more = page.more_available ?? page.has_more ?? page.has_next_page ?? data.more_available ?? data.has_more
  if (more != null && ![true, false, 0, 1, '0', '1', 'true', 'false'].includes(more)) throw new Error('invalid_instagram_pagination')
  const expectsMore = [true, 1, '1', 'true'].includes(more)
  if (expectsMore && !next) throw new Error('missing_instagram_continuation')
  const hasMore = rows.length > 0 && request.page < 15 && !!next
    && ![false, 0, '0', 'false'].includes(more) && next !== request.providerCursor?.next_max_id
  const nextCursor = hasMore ? request.encodeNext({ page: request.page + 1,
    providerCursor: { next_max_id: next, ...(rank ? { rank_token: rank } : {}) } }) : null
  return { ...result, items: rows, publicBody: { contractVersion: 'mx-insight-hub.raw-search.v1', data: { platform: 'instagram', query: request.query,
    raw_info: '[]', raw_data: JSON.stringify(rows), page: { page: request.page, pageSize: request.pageSize,
      returnedCount: rows.length, hasMore, nextCursor }, status: 'ok',
    meta: { implementation: 'hub', resultCount: rows.length, upstreamCallCount: 1 } }, meta: { capturedAt } } }
}
