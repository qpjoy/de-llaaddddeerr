import { createHash } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { normalizeNativeForwardingRequest } from './native-forwarding.mjs'
import { RAW_SEARCH_VERSION } from './raw-search.mjs'

export const FACEBOOK_HOST = 'facebook-scraper3.p.rapidapi.com'
export const FACEBOOK_VERSION = 'mx-insight-hub.facebook-search.v1'
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
  let state = { page: 1, expiresAt: now + 86400000, provider: null, providerCursor: null,
    startDate: date(params.start_date ?? params.startDate ?? params.start ?? params.startTime, new Date(now - 86400000 + 28800000).toISOString().slice(0, 10)),
    endDate: date(params.end_date ?? params.endDate ?? params.end ?? params.endTime, new Date(now + 28800000).toISOString().slice(0, 10)) }
  if (body.cursor) {
    try {
      state = codec.decode(body.cursor)
      if (state.version !== FACEBOOK_VERSION || state.scope !== scope || !['rapidapi', 'justone'].includes(state.provider)
        || !Number.isInteger(state.page) || state.page < 2 || state.page > 15 || !Number.isSafeInteger(state.expiresAt) || state.expiresAt <= now
        || typeof state.providerCursor !== 'string' || !state.providerCursor || state.providerCursor.length > 4096
        || date(state.startDate) !== state.startDate || date(state.endDate) !== state.endDate) throw new Error('cursor')
    } catch { throw new AppError(400, 'invalid_cursor', 'Restart Facebook search from page 1 with a new Idempotency-Key; the cursor is invalid, expired or belongs to another query/Key') }
  }
  if (state.startDate > state.endDate) invalid('Search start must not be after end')
  return { ...state, platform: 'facebook', query, pageSize, marketplace: 'facebook', deliveryMode: 'live_only',
    fingerprintBody: dataSearch ? { ...normalized, type: dataSearch.resultType }
      : { contractVersion: 'mx-insight-hub.night-all-compat.v1', ...body },
    forProvider(provider) {
      return provider === 'rapidapi' ? { endpointKey: FACEBOOK_ENDPOINT, endpointContractVersion: FACEBOOK_VERSION,
        endpointVersion: 'v1', endpointPath: '/search/posts', upstreamQuery: { query, start_date: state.startDate,
          end_date: state.endDate, ...(state.providerCursor ? { cursor: state.providerCursor } : {}) } }
        : normalizeNativeForwardingRequest(FACEBOOK_JUSTONE_KEY, { params: { keyword: query, startDate: state.startDate,
          endDate: state.endDate, ...(state.providerCursor ? { cursor: state.providerCursor } : {}) } })
    },
    encodeNext: (provider, providerCursor) => codec.encode({ ...state, version: FACEBOOK_VERSION, scope, provider,
      providerCursor, page: state.page + 1 }),
  }
}

const text = value => typeof value === 'string' ? value : ''
const metric = value => value != null && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null
function timestamp(value) {
  if (value == null || value === '') return null
  const result = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value)
  return Number.isFinite(result.getTime()) ? result.toISOString() : null
}
export function facebookRow(post, capturedAt) {
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
    created_at: timestamp(post.timestamp ?? post.created_at), collected_at: capturedAt,
    like_count: metric(post.reactions_count), comment_count: metric(post.comments_count), forward_count: metric(post.reshare_count),
    view_count: metric(post.video_view_count), image_urls: JSON.stringify(images), video_urls: JSON.stringify(videos) }
}

export function projectFacebookSearch(raw, request, provider, capturedAt) {
  const items = provider === 'justone' ? raw?.business_data ?? raw?.results : raw?.results
  if (!raw || typeof raw !== 'object' || !Array.isArray(items)) throw new Error('invalid_facebook_response')
  const rows = items.map(post => facebookRow(post, capturedAt))
  // Suppliers do not accept count. Never silently discard paid business rows.
  if (rows.length > request.pageSize) throw new Error('facebook_page_exceeds_requested_count')
  const cursor = raw.cursor || raw.next_cursor || raw.nextCursor || raw.pagination?.next_cursor || raw.pagination?.nextCursor || null
  if (cursor != null && (typeof cursor !== 'string' || cursor.length > 4096)) throw new Error('invalid_facebook_continuation')
  const hasMore = Boolean(cursor) && cursor !== request.providerCursor && request.page < 15
  return { publicBody: { contractVersion: RAW_SEARCH_VERSION, data: { platform: 'facebook', query: request.query,
    raw_info: '[]', raw_data: JSON.stringify(rows), items: rows,
    page: { page: request.page, pageSize: request.pageSize, returnedCount: rows.length, hasMore,
      nextCursor: hasMore ? request.encodeNext(provider, cursor) : null }, status: 'ok', warnings: [],
    meta: { upstreamCallCount: 1 } }, meta: { capturedAt } }, items: rows }
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
