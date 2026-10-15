import { createHash } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { normalizeNativeForwardingRequest } from './native-forwarding.mjs'
import { RAW_SEARCH_VERSION } from './raw-search.mjs'

export const FACEBOOK_HOST = 'facebook-scraper3.p.rapidapi.com'
export const FACEBOOK_VERSION = 'mx-insight-hub.facebook-search.v1'
export const FACEBOOK_PROJECTION_VERSION = 2
export const FACEBOOK_ENDPOINT = 'facebook-scraper3.search'
export const FACEBOOK_JUSTONE_KEY = 'j.facebook_post_search_v1'
export const FACEBOOK_OPERATION = Object.freeze({ operationKey: 'social.facebook.search', label: 'Facebook 帖子搜索',
  legacyGate: 'hubSocialVerified', contractVersion: FACEBOOK_VERSION, endpointKeys: [FACEBOOK_ENDPOINT], allowZeroCost: true })
const dateFields = ['start_date', 'startDate', 'start', 'startTime', 'end_date', 'endDate', 'end', 'endTime']
const invalid = message => { throw new AppError(400, 'invalid_facebook_search', message) }
function date(value, fallback) {
  if (value == null || value === '') return fallback
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:$|[T ])/.test(value)) invalid('Search dates must use YYYY-MM-DD or ISO timestamps')
  const day = value.slice(0, 10)
  if (!Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) invalid('Invalid search date')
  return day
}

export function normalizeFacebookSearch(normalized, codec, dataSearch = null, now = Date.now()) {
  const body = dataSearch ? { ...normalized, count: normalized.pageSize } : normalized.upstreamBody
  if (body.params != null && (typeof body.params !== 'object' || Array.isArray(body.params))) invalid('params must be an object containing search dates')
  const params = body.params || {}
  const queries = [body.query, body.keyword, ...(body.queries || []), ...(body.keywords || [])].filter(v => v != null)
  if (queries.length !== 1 || typeof queries[0] !== 'string' || !queries[0].trim() || queries[0].length > 2000) invalid('Submit one Facebook search query per request')
  if (Object.keys(params).some(k => !dateFields.includes(k)) || body.page > 1
    || body.includeDetails || body.includeComments || body.commentCursor || body.commentLimit != null
    || body.cacheMaxAgeHours != null) invalid('Unsupported Facebook search options; continue with the returned Hub cursor')
  const pageSize = normalized.pageSize
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) invalid('Page size must be between 1 and 100')
  const query = queries[0].trim()
  // Keep an omitted date window stable across midnight and pagination.
  const suppliedDates = Object.fromEntries(dateFields.filter(k => params[k] != null).map(k => [k, params[k]]))
  const scope = createHash('sha256').update(JSON.stringify({ query, pageSize, dates: suppliedDates, format: dataSearch?.resultType || 'raw' })).digest('hex')
  let state = { page: 1, expiresAt: now + 86400000, provider: null, providerCursor: null, projectionVersion: FACEBOOK_PROJECTION_VERSION,
    startDate: date(params.start_date ?? params.startDate ?? params.start ?? params.startTime, new Date(now - 86400000 + 28800000).toISOString().slice(0, 10)),
    endDate: date(params.end_date ?? params.endDate ?? params.end ?? params.endTime, new Date(now + 28800000).toISOString().slice(0, 10)) }
  if (body.cursor) {
    try {
      state = codec.decode(body.cursor)
      if (state.version !== FACEBOOK_VERSION || state.scope !== scope || !['rapidapi', 'justone'].includes(state.provider)
        || (state.projectionVersion !== undefined && ![1, FACEBOOK_PROJECTION_VERSION].includes(state.projectionVersion))
        || !Number.isInteger(state.page) || state.page < 2 || state.page > 15 || !Number.isSafeInteger(state.expiresAt) || state.expiresAt <= now
        || (!(dataSearch && state.buffer && state.providerCursor == null)
          && (typeof state.providerCursor !== 'string' || !state.providerCursor || state.providerCursor.length > 4096))
        || (state.fill != null && (!dataSearch || !state.fill || typeof state.fill !== 'object' || Array.isArray(state.fill)
          || Object.keys(state.fill).some(key => !['version', 'previousDeliveryId', 'upstreamPages'].includes(key))
          || state.fill.version !== 'facebook-fill.v1'
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(state.fill.previousDeliveryId)
          || !Number.isInteger(state.fill.upstreamPages) || state.fill.upstreamPages < 0 || state.fill.upstreamPages > 15))
        || (state.buffer != null && (!state.fill || !state.buffer || typeof state.buffer !== 'object' || Array.isArray(state.buffer)
          || Object.keys(state.buffer).some(key => !['callId', 'offset', 'hash'].includes(key))
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(state.buffer.callId)
          || !Number.isSafeInteger(state.buffer.offset) || state.buffer.offset < 1 || state.buffer.offset > 10000
          || !/^[0-9a-f]{64}$/.test(state.buffer.hash)))
        || date(state.startDate) !== state.startDate || date(state.endDate) !== state.endDate) throw new Error('cursor')
      state = { ...state, projectionVersion: state.projectionVersion ?? 1 }
    } catch { throw new AppError(400, 'invalid_cursor', 'Restart Facebook search from page 1 with a new Idempotency-Key; the cursor is invalid, expired or belongs to another query/Key') }
  }
  if (state.startDate > state.endDate) invalid('Search start must not be after end')
  return { ...state, platform: 'facebook', query, pageSize, scopeHash: scope, resultType: dataSearch?.resultType,
    standardSearch: Boolean(dataSearch), marketplace: 'facebook', deliveryMode: 'live_only',
    fingerprintBody: dataSearch ? { ...normalized, type: dataSearch.resultType }
      : { contractVersion: 'mx-insight-hub.night-all-compat.v1', ...body },
    forProvider(provider) {
      return provider === 'rapidapi' ? { endpointKey: FACEBOOK_ENDPOINT, endpointContractVersion: FACEBOOK_VERSION,
        endpointVersion: 'v1', endpointPath: '/search/posts', upstreamQuery: { query, start_date: state.startDate,
          end_date: state.endDate, ...(state.providerCursor ? { cursor: state.providerCursor } : {}) },
          ...(dataSearch ? { standardSearch: true, allowOverflow: true } : {}) }
        : normalizeNativeForwardingRequest(FACEBOOK_JUSTONE_KEY, { params: { keyword: query, startDate: state.startDate,
          endDate: state.endDate, ...(state.providerCursor ? { cursor: state.providerCursor } : {}) } })
    },
    encodeNext: (provider, providerCursor) => codec.encode({ ...state, version: FACEBOOK_VERSION, scope, provider,
      providerCursor, page: state.page + 1 }),
    encodeFillNext: ({ provider, providerCursor, buffer, previousDeliveryId, upstreamPages }) => codec.encode({
      version: FACEBOOK_VERSION, scope, provider, providerCursor, page: state.page + 1, expiresAt: state.expiresAt,
      projectionVersion: state.projectionVersion,
      startDate: state.startDate, endDate: state.endDate, ...(buffer ? { buffer } : {}),
      fill: { version: 'facebook-fill.v1', previousDeliveryId, upstreamPages },
    }),
  }
}

const text = value => typeof value === 'string' ? value : ''
const legacyMetric = value => value != null && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null
function legacyTimestamp(value) {
  if (value == null || value === '') return null
  const result = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value)
  return Number.isFinite(result.getTime()) ? result.toISOString() : null
}
// Frozen projection for unversioned/v1 cursors. Buffered rows are hash-bound;
// changing this function or its helpers would invalidate already paid pages.
export function facebookRowV1(post, capturedAt) {
  const id = post?.post_id ?? post?.postId ?? post?.id
  if (!((typeof id === 'string' && id.length > 0 && id.length <= 200) || (Number.isSafeInteger(id) && id > 0))) throw new Error('invalid_facebook_identity')
  const author = post.author || post.user || {}
  const urls = values => [...new Set(values.flat().map(v => typeof v === 'string' ? v : v?.uri || v?.url).filter(Boolean))]
  const images = urls([post.image, ...(post.album_preview || []), post.video_thumbnail].filter(Boolean))
  const files = post.video_files && !Array.isArray(post.video_files) ? Object.values(post.video_files) : post.video_files || []
  const videos = urls([post.video, ...files].filter(Boolean))
  const content = text(post.message ?? post.text ?? post.content)
  return { ...post, content_id: String(id), platform_name: 'facebook', title: '', text: content, content, full_text: content,
    url: text(post.url ?? post.post_url), author_id: String(author.id ?? post.author_id ?? ''),
    author_name: text(author.name ?? post.author_title), author_avatar_url: text(author.profile_picture_url),
    created_at: legacyTimestamp(post.timestamp ?? post.created_at), collected_at: capturedAt,
    like_count: legacyMetric(post.reactions_count), comment_count: legacyMetric(post.comments_count), forward_count: legacyMetric(post.reshare_count),
    view_count: legacyMetric(post.video_view_count), image_urls: JSON.stringify(images), video_urls: JSON.stringify(videos) }
}

const object = value => value != null && typeof value === 'object' && !Array.isArray(value)
const firstText = (...values) => values.find(value => typeof value === 'string' && value.trim()) || ''
// A present null means unknown. Only an absent provider field falls back to a
// legacy normalized alias; invalid measurements must never become real zero.
const firstValue = (...values) => values.find(value => value !== undefined)
function metric(value) {
  if (typeof value === 'string') {
    if (!/^\d+(?:\.0+)?$/u.test(value.trim())) return null
    value = Number(value)
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}
function timestamp(value) {
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/u.test(value.trim())) value = Number(value)
  if (typeof value !== 'string' && typeof value !== 'number' || value === '') return null
  if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) return null
  const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
function identity(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value
    : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : ''
}
function references(value) {
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try { value = JSON.parse(value) } catch { return [] }
  }
  return Array.isArray(value) ? value : value == null ? [] : [value]
}
function mediaReference(value, image = false) {
  const reference = typeof value === 'string' ? value : object(value)
    ? firstText(...(image ? [value.image_file_uri] : []), value.uri, value.url) : ''
  if (!reference) return ''
  try {
    const parsed = new URL(reference, reference.startsWith('//') ? 'https://facebook.invalid' : undefined)
    // These are post/photo landing pages, not acquired downloadable media.
    // Keep them in the original supplier fields and post URL, never invent CDN.
    if ((parsed.hostname === 'facebook.com' || parsed.hostname.endsWith('.facebook.com'))
      && /^\/(?:photo(?:\.php)?(?:\/|$)|photos(?:\/|$)|posts(?:\/|$)|watch(?:\/|$)|reel(?:\/|$)|permalink\.php$|story\.php$)/iu.test(parsed.pathname)) return ''
  } catch { /* Retain previously supported opaque references without guessing. */ }
  return reference
}
const mediaUrls = (values, image = false) => [...new Set(values.flatMap(references).map(value => mediaReference(value, image)).filter(Boolean))]

export function facebookRow(post, capturedAt) {
  if (!object(post)) throw new Error('invalid_facebook_identity')
  const id = identity(post.post_id ?? post.postId ?? post.id ?? post.content_id)
  if (!id) throw new Error('invalid_facebook_identity')
  const author = object(post.author) ? post.author : {}, user = object(post.user) ? post.user : {}
  const content = firstText(post.full_text, post.message, post.text, post.content)
  const shares = metric(firstValue(post.reshare_count, post.forward_count, post.share_count))
  const files = object(post.video_files) ? Object.values(post.video_files) : post.video_files
  const videos = mediaUrls([post.video, files, post.video_hd_file, post.video_sd_file, ...references(post.video_urls)])
  const cover = mediaReference(post.video_thumbnail, true) || mediaReference(firstText(post.cover_url, post.coverUrl), true)
  let images = mediaUrls([post.image, ...references(post.album_preview), ...references(post.image_urls), post.video_thumbnail], true)
  if (videos.length && cover) images = images.filter(url => url !== cover)
  return { ...post, content_id: id, platform_name: 'facebook', title: '', text: content, content, full_text: content,
    url: firstText(post.url, post.post_url, post.original_url),
    author_id: identity(firstValue(author.id, user.id, post.author_id)),
    author_name: firstText(author.name, user.name, post.author_name, post.user_name, post.author_title),
    author_avatar_url: firstText(author.profile_picture_url, user.profile_picture_url, post.author_avatar_url),
    created_at: timestamp(firstValue(post.timestamp, post.created_at, post.created_time)), collected_at: capturedAt,
    like_count: metric(firstValue(post.reactions_count, post.like_count)),
    comment_count: metric(firstValue(post.comments_count, post.comment_count, post.reply_count)),
    // Canonical's historical map prefers share_count to forward_count. Publish
    // the same calibrated measurement under both aliases, never a stale copy.
    forward_count: shares, share_count: shares,
    view_count: metric(firstValue(post.video_view_count, post.view_count)), bookmark_count: metric(post.bookmark_count),
    cover_url: cover || null, image_urls: JSON.stringify(images), video_urls: JSON.stringify(videos) }
}

// The standard view separates an explicit video poster from real photos.
// Keep the raw row and every supplier URL intact; neither a first-photo guess
// nor a Facebook landing-page URL establishes a downloadable media asset.
function facebookStandardMediaV1(row) {
  const urls = value => [...new Set(JSON.parse(value || '[]').filter(value => typeof value === 'string'))]
  const images = urls(row.image_urls), videos = urls(row.video_urls)
  const poster = row.video_thumbnail
  const explicit = typeof poster === 'string' ? poster : poster?.uri || poster?.url
  const coverUrl = text(explicit) || text(row.cover_url) || text(row.coverUrl) || null
  return { coverUrl, images: videos.length && coverUrl ? images.filter(url => url !== coverUrl) : images, videos }
}

export function facebookStandardMedia(row, { projectionVersion = FACEBOOK_PROJECTION_VERSION } = {}) {
  if (projectionVersion === 1) return facebookStandardMediaV1(row)
  const videos = mediaUrls(references(row.video_urls)), coverUrl = mediaReference(row.video_thumbnail, true)
    || mediaReference(firstText(row.cover_url, row.coverUrl), true) || null
  let images = mediaUrls(references(row.image_urls), true)
  if (videos.length && coverUrl) images = images.filter(url => url !== coverUrl)
  return { coverUrl, images, videos }
}

export function projectFacebookSearch(raw, request, provider, capturedAt, { allowOverflow = false } = {}) {
  const items = provider === 'justone' ? raw?.business_data ?? raw?.results : raw?.results
  if (!raw || typeof raw !== 'object' || !Array.isArray(items)) throw new Error('invalid_facebook_response')
  if (items.length > 10000) throw new Error('facebook_page_too_large')
  const row = request.projectionVersion === 1 ? facebookRowV1 : facebookRow
  const rows = items.map(post => row(post, capturedAt))
  // Suppliers do not accept count. Never silently discard paid business rows.
  if (rows.length > request.pageSize && !allowOverflow) throw new Error('facebook_page_exceeds_requested_count')
  const cursor = raw.cursor || raw.next_cursor || raw.nextCursor || raw.pagination?.next_cursor || raw.pagination?.nextCursor || null
  if (cursor != null && (typeof cursor !== 'string' || cursor.length > 4096)) throw new Error('invalid_facebook_continuation')
  const hasMore = Boolean(cursor) && cursor !== request.providerCursor && request.page < 15
  const publicBody = { contractVersion: RAW_SEARCH_VERSION, data: { platform: 'facebook', query: request.query,
    raw_info: '[]', raw_data: JSON.stringify(rows), items: rows,
    page: { page: request.page, pageSize: request.pageSize, returnedCount: rows.length, hasMore,
      nextCursor: hasMore ? request.encodeNext(provider, cursor) : null }, status: 'ok', warnings: [],
    meta: { upstreamCallCount: 1 } }, meta: { capturedAt } }
  if (allowOverflow) Object.defineProperty(publicBody, 'providerPage', { enumerable: false,
    value: { nextProviderCursor: cursor && cursor !== request.providerCursor ? cursor : null } })
  return { publicBody, items: rows }
}

export function facebookJustOneArchives(objects, endpointVersion) {
  return (objects || []).map(object => {
    if (object.capturedDate) return object
    const capturedDate = new Date(object.rawItem.capturedAt).toISOString().slice(0, 10)
    return { ...object, marketplace: 'facebook', endpointVersion, capturedDate,
      sourceKey: 'source-catalog-0088', payloadSha256: object.rawPayloadSha256, rawPayload: object.rawItem,
      archivePath: `justone/facebook/search/${endpointVersion}/${capturedDate}/responses/${object.rawPayloadSha256}.json` }
  })
}
