import { hasNoContentTitle } from './social-content-title.mjs'

export const DOUYIN_MEDIA_POLICY = 'douyin-video-cover.v1'
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const mediaUrl = value => typeof value === 'string' ? value
  : object(value) ? value.url || value.playUrl || value.play_url || null : null
function array(value) {
  if (Array.isArray(value)) return value
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : [] } catch { return [] }
}

// A poster is not a second attachment. Do not infer a poster from the first
// image, compare CDN paths without their query, or erase genuine mixed media.
export function normalizeSearchMedia(media, platform, item = {}) {
  if (platform !== 'douyin' || !object(media)) return media
  const kind = String(item.contentType || item.content_type || item.media_type || item.type || '').toLowerCase()
  if (/profile|user|account/.test(String(item.objectType || '').toLowerCase())) return media
  if (/image|photo|picture|gallery|carousel|mixed|profile|account|图文|图集|图片/.test(kind)) return media
  // Production evidence confirms type "4" here. Other numeric provider types
  // are not classified by guessing their meaning (for example photo/live posts).
  if (/^\d+$/.test(kind) && kind !== '4') return media
  const videos = array(media.videos)
  if (!videos.some(mediaUrl)) return media
  const covers = [media.coverUrl, media.cover_url, item.coverUrl, item.cover_url,
    ...videos.flatMap(video => object(video) ? [video.coverUrl, video.cover_url, video.thumbnailUrl, video.thumbnail_url] : [])]
    .filter(value => typeof value === 'string' && value.length > 0)
  if (!covers.length || !Array.isArray(media.images)) return media
  const posters = new Set(covers)
  const images = media.images.filter(image => !posters.has(mediaUrl(image)))
  if (images.length === media.images.length) return media
  return { ...media, coverUrl: media.coverUrl || covers[0], images }
}

function rawRow(row, platform) {
  if (!object(row)) return row
  let result = hasNoContentTitle(platform, row) ? { ...row, title: '' } : row
  if (platform !== 'douyin') return result
  const media = { ...(object(row.media) ? row.media : {}),
    coverUrl: row.cover_url ?? row.coverUrl ?? row.media?.coverUrl ?? null,
    videos: array(row.video_urls ?? row.videos ?? row.media?.videos) }
  let poster = null
  for (const key of ['image_urls', 'images']) {
    if (!Object.hasOwn(row, key)) continue
    const source = { ...media, images: array(row[key]) }
    const normalized = normalizeSearchMedia(source, platform, row)
    if (normalized !== source) {
      result = { ...result, [key]: typeof row[key] === 'string' ? JSON.stringify(normalized.images) : normalized.images }
      poster ||= normalized.coverUrl
    }
  }
  const nested = object(row.media) ? normalizeSearchMedia(row.media, platform, row) : row.media
  if (nested !== row.media) {
    result = { ...result, media: nested }
    poster ||= nested.coverUrl
  }
  // Keep the existing poster fields; older rows with only video-level poster
  // metadata gain a cover without adding that URL to their image attachments.
  if (!row.cover_url && !row.coverUrl && poster) result.cover_url = poster
  return result
}

// One content policy for the modern search contract and the legacy raw view.
// This runs before committing a NEW delivery, never on immutable replay bodies.
export function normalizeSearchContent(payload, platform, { format = 'data' } = {}) {
  if (format === 'data') {
    if (!Array.isArray(payload?.data?.items)) return payload
    return { ...payload, data: { ...payload.data, items: payload.data.items.map(item => {
      if (!object(item)) return item
      return { ...item, ...(hasNoContentTitle(platform, item) ? { title: null } : {}),
        ...(object(item.media) ? { media: normalizeSearchMedia(item.media, platform, item) } : {}) }
    }) } }
  }
  const result = structuredClone(payload)
  const visit = data => {
    if (!object(data)) return
    if (typeof data.raw_data === 'string') {
      let rows
      try { rows = JSON.parse(data.raw_data) } catch { /* Retain unrecognized optional child evidence. */ }
      if (Array.isArray(rows)) {
        const normalized = rows.map(row => rawRow(row, platform))
        if (normalized.some((row, index) => row !== rows[index])) data.raw_data = JSON.stringify(normalized)
      }
    } else if (Array.isArray(data.raw_data)) data.raw_data = data.raw_data.map(row => rawRow(row, platform))
    if (Array.isArray(data.items)) data.items = data.items.map(row => rawRow(row, platform))
    for (const child of Array.isArray(data.results) ? data.results : []) visit(child?.data || child)
  }
  visit(result?.data)
  return result
}
