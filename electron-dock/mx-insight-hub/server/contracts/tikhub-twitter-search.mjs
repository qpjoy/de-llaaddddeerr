import { isPostgresSafeJsonValue, isPostgresSafeText } from '../core/postgres-json.mjs'
import { normalizeSearchMedia } from './search-content.mjs'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' ? value : ''
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,29}$/u.test(value) ? value : null
const metric = value => (typeof value === 'number' || typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value))
  && Number.isSafeInteger(Number(value)) && Number(value) >= 0 && !Object.is(value, -0) ? Number(value) : null
const array = value => Array.isArray(value) ? value : []
const url = value => typeof value === 'string' && isPostgresSafeText(value) && /^https?:\/\/[^\s]+$/u.test(value) ? value : null
const unique = values => [...new Set(values.filter(Boolean))]
function timestamp(value) {
  if (typeof value !== 'string' && typeof value !== 'number' || value === '') return null
  const numeric = typeof value === 'number' || /^\d+(?:\.\d+)?$/u.test(value)
  const date = new Date(numeric ? Number(value) < 1e12 ? Number(value) * 1000 : Number(value) : value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function mediaFor(value) {
  const media = object(value.media) ? value.media : {}
  const photos = [...array(media.photo)], videos = [...array(media.video)]
  // The same native attachment can also occur in entities.media. Preserve
  // mixed photo/video posts, without turning a video poster into a photo.
  for (const item of array(value.entities?.media)) {
    if (item?.type === 'photo') photos.push(item)
    else if (['video', 'animated_gif'].includes(item?.type)) videos.push(item)
  }
  const images = unique(photos.map(item => url(item?.media_url_https)))
  const playable = videos.map(item => {
    const variants = array(item?.variants ?? item?.video_info?.variants).filter(variant => url(variant?.url))
    const mp4 = variants.filter(variant => variant.content_type === 'video/mp4')
    const selected = (mp4.length ? mp4 : variants).slice().sort((a, b) => (metric(b.bitrate) ?? 0) - (metric(a.bitrate) ?? 0))[0]
    return url(selected?.url)
  })
  return normalizeSearchMedia({ coverUrl: videos.map(item => url(item?.media_url_https)).find(Boolean) || images[0] || null,
    images, videos: unique(playable) }, 'twitter', value)
}

export function tikHubTwitterRow(value, capturedAt) {
  if (!object(value) || !id(value.tweet_id)) throw new Error('invalid_content_search_identity')
  const contentId = value.tweet_id, author = object(value.user_info) ? value.user_info : {}
  const handle = [author.screen_name, value.screen_name].find(value => typeof value === 'string' && /^[A-Za-z0-9_]{1,15}$/u.test(value)) || null
  const content = text(value.text), media = mediaFor(value)
  const postUrl = `https://twitter.com/${handle || 'i'}/status/${contentId}`
  const row = { content_id: contentId, platform_name: 'twitter', content_type: 'post', title: '',
    text: content, content, full_text: content, url: postUrl, original_url: postUrl,
    created_at: timestamp(value.created_at), collected_at: capturedAt,
    author_id: id(author.rest_id), author_name: text(author.name) || handle || '', author_username: handle,
    author_avatar_url: url(author.avatar), like_count: metric(value.favorites),
    reply_count: metric(value.replies), comment_count: metric(value.replies), forward_count: metric(value.retweets),
    quote_count: metric(value.quotes), bookmark_count: metric(value.bookmarks), view_count: metric(value.views),
    lang: text(value.lang), cover_url: media.coverUrl, image_urls: JSON.stringify(media.images), video_urls: JSON.stringify(media.videos),
    metadata: { hashtags: array(value.entities?.hashtags).map(value => text(value?.text)).filter(Boolean) } }
  // Validate only the projected fields. Unrelated supplier metadata is kept in
  // its immutable raw archive, and must not reject an otherwise usable page.
  if (!isPostgresSafeJsonValue(row)) throw new Error('invalid_content_search_projection')
  return row
}

export function projectTikHubTwitterTimeline(data, request = {}, capturedAt) {
  if (!object(data) || !Array.isArray(data.timeline)) throw new Error('invalid_content_search_shape')
  if (data.code != null && ![0, 200, '0', '200'].includes(data.code)) throw new Error('content_search_business_rejected')
  if (data.timeline.length > 10000) throw new Error('content_search_page_too_large')
  const capture = timestamp(capturedAt)
  if (!capture) throw new Error('invalid_content_search_capture_time')
  const rows = new Map(); let duplicateCount = 0
  for (const value of data.timeline) {
    const row = tikHubTwitterRow(value, capture)
    if (rows.has(row.content_id)) duplicateCount++
    else rows.set(row.content_id, row)
  }
  const next = data.next_cursor
  if (next != null && next !== '' && (typeof next !== 'string' || !next.trim() || next.length > 4096 || !isPostgresSafeText(next))) {
    throw new Error('invalid_content_search_continuation')
  }
  const repeated = !!next && next === (request.upstreamQuery?.cursor ?? request.providerCursor?.cursor)
  const nextProviderCursor = next && !repeated ? next : null
  // A short/empty page is not exhaustion. Keep an advertised continuation;
  // absent pagination is unknown, while an explicit null/empty token ends it.
  const hasMore = nextProviderCursor ? true : repeated || Object.hasOwn(data, 'next_cursor') ? false : null
  return { rows: [...rows.values()], nextProviderCursor, hasMore, nonPostCount: 0, duplicateCount,
    sourceCount: data.timeline.length, ...(repeated ? { stopReason: 'repeated_cursor' } : {}) }
}

export function projectTikHubTwitterSearch(result, request) {
  let data = result.publicBody?.data
  if (object(data) && data.code != null && ![0, 200, '0', '200'].includes(data.code)) throw new Error('content_search_business_rejected')
  // The adapter removes the native API envelope; permit its single known
  // extra data wrapper, without searching recommendations or arbitrary trees.
  if (object(data?.data) && !Array.isArray(data.timeline) && Array.isArray(data.data.timeline)) data = data.data
  const projected = projectTikHubTwitterTimeline(data, request, result.publicBody?.meta?.capturedAt)
  return { ...result, items: projected.rows, acquiredItems: projected.rows,
    nonPostCount: projected.nonPostCount, duplicateCount: projected.duplicateCount,
    providerPage: { hasMore: projected.hasMore, nextParams: projected.nextProviderCursor ? { cursor: projected.nextProviderCursor } : null,
      nextPage: null, paginationMode: 'cursor', sourceCount: projected.sourceCount,
      ...(projected.stopReason ? { stopReason: projected.stopReason } : {}) } }
}
