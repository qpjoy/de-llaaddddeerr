import { createHash } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { normalizeNativeForwardingRequest } from './native-forwarding.mjs'
import { normalizeHubSocialRequest } from './hub-social.mjs'
import { normalizeNightAllLegacyPayload, NIGHT_ALL_COMPAT_DATASET_ID } from '../ingest/legacy-night-all.mjs'
import { refreshMappedPayloadSha256 } from '../ingest/external/mapping.mjs'
import { INSTAGRAM_SEARCH_KEY } from './instagram-search.mjs'
import { JUSTONE_INSTAGRAM_SEARCH_KEY } from './instagram-justone-search.mjs'
import { normalizeSearchContent } from './search-content.mjs'
import { prepareNightAllCompatibilityTraversal } from '../data/night-all-pagination.mjs'

export const RAW_SEARCH_VERSION = 'mx-insight-hub.raw-search.v1'
export const RAW_SEARCH_PATH = '/api/v1/night-all/search/raw'
export const RAW_SEARCH_DATASET = NIGHT_ALL_COMPAT_DATASET_ID
export const WEIBO_SEARCH_KEY = 't.weibo_web_v2_fetch_realtime_search'
export const WEIBO_DETAIL_KEY = 't.api_4f35621a9c07e539'
export { JUSTONE_INSTAGRAM_SEARCH_KEY }
export const isHubRawCursor = value => typeof value === 'string' && value.startsWith('mxraw1.')

// Migrated platforms fail closed in Hub; the remaining platforms move only
// their verified shapes. No Hub continuation may fall back to Night-All.
export function canRouteRawSearch({ platform, upstreamBody: body, pageSize }) {
  if (['facebook', 'instagram'].includes(platform)) return true // Unsupported shapes fail in Hub, never fall back to Night-All.
  if (!['weibo', 'twitter', 'instagram'].includes(platform)) return false
  if (isHubRawCursor(body.cursor)) return true
  return supportsRawSearch({ platform, upstreamBody: body, pageSize })
}

function supportsRawSearch({ platform, upstreamBody: body, pageSize }, instagramProvider = 'tikhub', instagramStrategy = false) {
  if (!['weibo', 'twitter', 'instagram'].includes(platform)) return false
  if (body.cursor || body.params?.cursor || body.page > 1) return false
  if (body.keywords != null || body.queries != null) return false
  if (body.params && Object.keys(body.params).length) return false
  if (body.includeComments || body.commentLimit != null || body.commentCursor != null
    || body.cacheMaxAgeHours != null || body.enrichConcurrency != null || body.concurrency != null) return false
  if (platform !== 'weibo' && body.includeDetails) return false
  if (platform === 'twitter' && pageSize > 50) return false
  const values = [body.keyword, body.query].filter(value => value != null)
  return values.length === 1 && typeof values[0] === 'string' && values[0].trim().length > 0
    && (platform !== 'twitter' || !['.', '..'].includes(values[0].trim()))
    && values[0].length <= 500 && (platform === 'twitter' || pageSize >= (platform === 'instagram' && (instagramProvider === 'justone' || instagramStrategy) ? 1 : 20))
}

const justOneCursor = value => typeof value === 'string' && value.trim().length > 0
  && value.length <= 2048 && !value.includes('\u0000')

export function normalizeRawSearch(normalized, codec, { cursorScope, twitterSort, twitterBuffer = false, bufferPageSize,
  instagramProvider = 'tikhub', instagramStrategy = false, historicalCodec } = {}) {
  const { platform, upstreamBody: body, pageSize } = normalized
  const justone = platform === 'instagram' && instagramProvider === 'justone'
  if (platform === 'instagram' && !['tikhub', 'justone'].includes(instagramProvider)) {
    throw new AppError(400, 'invalid_raw_search', 'Unsupported Instagram provider')
  }
  if (platform === 'instagram' && (justone || instagramStrategy) && ((typeof body.cursor === 'string' && body.cursor.startsWith('mxnc1.'))
    || (typeof body.params?.cursor === 'string' && body.params.cursor.startsWith('mxnc1.')))) {
    const historical = prepareNightAllCompatibilityTraversal({ operation: 'raw', platform,
      upstreamBody: body, codec: historicalCodec })
    return { platform, pageSize, marketplace: platform, deliveryMode: 'live_only', restartRequired: true,
      fingerprintBody: { contractVersion: 'mx-insight-hub.night-all-compat.v1', ...historical.upstreamBody } }
  }
  const withoutCursor = { ...body }
  delete withoutCursor.cursor
  if (!supportsRawSearch({ ...normalized, upstreamBody: withoutCursor }, instagramProvider, instagramStrategy) || body.page > 1
    || (platform === 'instagram' && (justone || instagramStrategy) && (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100))) {
    throw new AppError(400, 'invalid_raw_search', 'This request shape cannot use the Hub raw search continuation')
  }
  const query = (body.keyword ?? body.query).trim()
  const scope = createHash('sha256').update(JSON.stringify({ platform, query, pageSize,
    includeDetails: body.includeDetails === true, disableAutoDetails: body.disableAutoDetails === true,
    maxEnrichItems: body.maxEnrichItems ?? 20, ...(cursorScope ? { cursorScope } : {}) })).digest('hex')
  let page = 1, providerCursor = null, buffer = null, fill = null, expiresAt = Date.now() + 24 * 60 * 60_000
  let cursorProvider = justone ? 'justone' : 'tikhub'
  let taggedProvider = false
  if (body.cursor) {
    try {
      const state = codec.decode(body.cursor)
      if (state.version !== RAW_SEARCH_VERSION || state.scope !== scope || !Number.isSafeInteger(state.expiresAt)
        || state.expiresAt <= Date.now() || !Number.isInteger(state.page) || state.page < 2 || state.page > 15
        || (platform === 'twitter' && (!(twitterBuffer && state.buffer && state.providerCursor == null)
          && (typeof state.providerCursor !== 'string' || !state.providerCursor || state.providerCursor.length > 4096)))
        || (platform === 'twitter' && state.provider != null && state.provider !== 'rapidapi')
        || (state.fill != null && (platform !== 'twitter' || !twitterBuffer || state.provider !== 'rapidapi'
          || !state.fill || typeof state.fill !== 'object' || Array.isArray(state.fill)
          || Object.keys(state.fill).some(key => !['version', 'previousDeliveryId', 'upstreamPages'].includes(key))
          || state.fill.version !== 'twitter-fill.v1'
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(state.fill.previousDeliveryId)
          || !Number.isInteger(state.fill.upstreamPages) || state.fill.upstreamPages < 0 || state.fill.upstreamPages > 15))
        || (state.buffer != null && (!(platform === 'instagram' || platform === 'twitter' && twitterBuffer && state.provider === 'rapidapi')
          || !state.buffer || Array.isArray(state.buffer)
          || Object.keys(state.buffer).some(key => !['callId', 'offset', 'hash'].includes(key))
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(state.buffer.callId)
          || !Number.isSafeInteger(state.buffer.offset) || state.buffer.offset < 1
          || (!state.fill && state.buffer.offset % (bufferPageSize ?? pageSize) !== 0) || !/^[0-9a-f]{64}$/.test(state.buffer.hash)))
        || (platform === 'instagram' && state.provider != null && !['justone', 'tikhub'].includes(state.provider))
        || (platform === 'instagram' && state.provider === 'justone' && (!justone
          || (!(state.buffer && state.providerCursor == null) && !justOneCursor(state.providerCursor))))
        || (platform === 'instagram' && state.provider !== 'justone' && !(state.buffer && state.providerCursor == null) && (!state.providerCursor || typeof state.providerCursor.next_max_id !== 'string'
          || !state.providerCursor.next_max_id || state.providerCursor.next_max_id.length > 2048
          || Object.keys(state.providerCursor).some(key => !['next_max_id', 'rank_token'].includes(key))
          || (state.providerCursor.rank_token != null && (typeof state.providerCursor.rank_token !== 'string' || state.providerCursor.rank_token.length > 2048))))) throw new Error('cursor')
      ;({ page, providerCursor = null, buffer = null, fill = null, expiresAt } = state)
      if (platform === 'instagram') {
        cursorProvider = state.provider || 'tikhub'
        taggedProvider = Boolean(state.provider)
      }
    } catch { throw new AppError(400, 'invalid_cursor', 'Cursor is invalid, expired or belongs to another query/Key') }
  }
  if ((justone && cursorProvider !== 'justone') || (platform === 'instagram' && instagramStrategy && body.cursor && !taggedProvider)) {
    // Preserve the exact old ledger identity before the gateway refuses a new
    // dispatch. TikHub continuation fields must never become JustOne tokens.
    return { platform, query, page, pageSize, provider: cursorProvider, providerCursor, buffer,
      marketplace: platform, deliveryMode: 'live_only', restartRequired: true,
      fingerprintBody: { contractVersion: 'mx-insight-hub.night-all-compat.v1', ...body } }
  }
  const providerRequest = platform === 'weibo'
    ? normalizeNativeForwardingRequest(WEIBO_SEARCH_KEY, { params: { query, page } })
    : platform === 'instagram' ? justone
      ? normalizeNativeForwardingRequest(JUSTONE_INSTAGRAM_SEARCH_KEY, { params: { keyword: query,
        ...(providerCursor ? { paginationToken: providerCursor } : {}) } })
      : normalizeNativeForwardingRequest(INSTAGRAM_SEARCH_KEY, { params: { query, enable_metadata: true, ...providerCursor } })
      : normalizeHubSocialRequest('search', { platform, query, count: pageSize, ...(twitterSort ? { sort: twitterSort } : {}) })
  if (platform === 'twitter') {
    providerRequest.page = page
    providerRequest.expiresAt = expiresAt
    providerRequest.providerCursor = providerCursor
    if (providerCursor) providerRequest.upstreamQuery.cursor = providerCursor
  }
  const encodeNext = state => {
    if (justone && !(state.buffer && state.providerCursor == null) && !justOneCursor(state.providerCursor)) {
      throw new AppError(400, 'invalid_cursor', 'Instagram continuation requires a JustOne pagination token')
    }
    return codec.encode({ version: RAW_SEARCH_VERSION, scope, expiresAt,
      ...(platform === 'instagram' && (justone || instagramStrategy) ? { provider: instagramProvider } : {}),
      ...(platform === 'twitter' && twitterBuffer ? { provider: 'rapidapi' } : {}),
      page: state.page, ...(state.providerCursor ? { providerCursor: state.providerCursor } : {}),
      ...(state.buffer ? { buffer: state.buffer } : {}),
      ...(platform === 'twitter' && twitterBuffer && state.fill ? { fill: state.fill } : {}) })
  }
  return { ...providerRequest, platform, query, page, pageSize, providerCursor, buffer, fill, scopeHash: scope, providerRequest, encodeNext,
    ...(platform === 'instagram' && (justone || instagramStrategy) ? { provider: instagramProvider } : {}),
    enrichment: { enabled: body.includeDetails === true || body.disableAutoDetails !== true,
      all: body.includeDetails === true, maxItems: body.maxEnrichItems ?? 20 },
    // Same logical request and charge across both aliases, including old saved deliveries.
    fingerprintBody: { contractVersion: 'mx-insight-hub.night-all-compat.v1', ...body } }
}

const string = value => typeof value === 'string' ? value : ''
const id = value => typeof value === 'string' && /^\d{1,30}$/.test(value) ? value
  : Number.isSafeInteger(value) && value > 0 ? String(value) : null
const metric = value => value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null
export function weiboText(value) {
  return string(value).replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&#(x[\da-f]+|\d+);/gi, (match, code) => {
      const n = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code)
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match
    }).replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[key]).trim()
}
export const isWeiboPreview = value => /(?:展开(?:全文)?\s*[cＣ]?|…|\.{3})[\s\u200b\ufeff]*$/iu.test(weiboText(value))

// Comparison only: never use this representation as delivered/stored body text.
// Keep the observed emotion labels bounded; arbitrary bracketed prose is content.
export const WEIBO_TEXT_COMPARISON_POLICY = 'weibo_display_v2'
export const WEIBO_DETAIL_POLICY = 'weibo-detail-identity.v1'
const comparableWeiboText = value => value.replace(/#([^#\[\]\r\n]+)\[超话\]#/gu, '$1超话')
  .replace(/\ue627|\[(?:笑cry|打call|兔子|哈哈)\]/gu, '').replace(/[\s\u200b\ufeff]/gu, '')
export function weiboTextPrefixMatches(preview, full) {
  const prefix = preview.replace(/(?:展开(?:全文)?\s*[cＣ]?|…|\.{3})[\s\u200b\ufeff]*$/iu, '').trim()
  const strict = prefix.replace(/[\s\u200b\ufeff]/gu, '')
  if (strict && full.replace(/[\s\u200b\ufeff]/gu, '').startsWith(strict)) return true
  const comparablePrefix = comparableWeiboText(prefix)
  return comparablePrefix.length > 0 && comparableWeiboText(full).startsWith(comparablePrefix)
}

function publishedAt(value, capturedAt) {
  if (!value) return null
  const now = new Date(capturedAt)
  const text = String(value).trim()
  if (text === '刚刚') return now.toISOString()
  const ago = text.match(/^(\d+)(秒|分钟|小时)前$/)
  if (ago) return new Date(now.getTime() - Number(ago[1]) * ({ 秒: 1000, 分钟: 60000, 小时: 3600000 })[ago[2]]).toISOString()
  if (text === '半小时前') return new Date(now.getTime() - 1800000).toISOString()
  const chinaNow = new Date(now.getTime() + 8 * 3600000).toISOString()
  const dated = text.replace(/^(今天|昨天)\s*(\d{2}:\d{2})$/, (_, day, time) =>
    `${new Date(now.getTime() + 8 * 3600000 - (day === '昨天' ? 86400000 : 0)).toISOString().slice(0, 10)}T${time}:00+08:00`)
    .replace(/^(\d{2})月(\d{2})日\s*(\d{2}:\d{2})$/, `${chinaNow.slice(0, 4)}-$1-$2T$3:00+08:00`)
    .replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(?::(\d{2}))?$/, (_, date, time, seconds) => `${date}T${time}:${seconds || '00'}+08:00`)
  const date = new Date(typeof value === 'number' ? value < 1e12 ? value * 1000 : value : dated)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function weiboMetric(...values) {
  for (const value of values) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) continue
    const number = Number(value)
    if (Number.isFinite(number) && number >= 0) return number
  }
  return null
}

function weiboPostUrl(value, authorId, contentId) {
  // TikHub realtime-search fixtures use protocol-relative post_url. Keep the
  // supplier's path/query (including signed parameters), after URL validation.
  for (const candidate of [value.post_url, value.url, value.postUrl, value.web_url]) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue
    const url = candidate.trim().startsWith('//') ? `https:${candidate.trim()}` : candidate.trim()
    try {
      const parsed = new URL(url)
      if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) return url
    } catch {}
  }
  const postId = value.mblogid || value.mblogId || value.bid || contentId
  return authorId ? `https://weibo.com/${authorId}/${postId}` : null
}

export function weiboRow(value, capturedAt) {
  const contentId = id(value?.weibo_id ?? value?.idstr ?? value?.id)
  if (!contentId) throw new Error('invalid_weibo_identity')
  const user = value.user || {}
  const authorId = id(user.idstr ?? user.id ?? value.user_id) || string(value.user_url).match(/\/(?:u\/)?(\d+)(?:[/?#]|$)/)?.[1] || null
  const summary = weiboText(value.content || value.text || value.text_raw || value.longText?.content)
  const longText = weiboText(value.longText?.content)
  const full = longText && !hasExpandControl(longText) ? longText : null
  const text = full || summary
  const images = value.media?.images || value.pic_ids?.map(pic => value.pic_infos?.[pic]?.original?.url).filter(Boolean) || []
  const videos = value.media?.videos || []
  return { content_id: contentId, platform_name: 'weibo', title: '',
    summary, text, content: text, full_text: full, url: weiboPostUrl(value, authorId, contentId),
    author_id: authorId, author_name: user.screen_name || value.user_name || '',
    author_avatar_url: user.profile_image_url || value.user_avatar || null,
    created_at: publishedAt(value.created_at || value.publish_time, capturedAt), collected_at: capturedAt,
    like_count: weiboMetric(value.attitudes_count, value.like_count, value.liked_count, value.interaction?.like_count, value.interaction?.likes),
    comment_count: weiboMetric(value.comments_count, value.comment_count, value.commentCount, value.interaction?.comment_count, value.interaction?.comments),
    forward_count: weiboMetric(value.reposts_count, value.share_count, value.shared_count, value.interaction?.repost_count, value.interaction?.reposts),
    view_count: weiboMetric(value.view_count, value.viewCount, value.play_count, value.playCount, value.read_count, value.readCount, value.views_count, value.views),
    bookmark_count: weiboMetric(value.collect_count, value.collected_count),
    image_urls: JSON.stringify(images), video_urls: JSON.stringify(videos),
    body_provenance: { policy: WEIBO_DETAIL_POLICY, summary: { source: 'search', capturedAt },
      fullText: full ? { source: 'search', field: 'longText.content', capturedAt, postId: contentId, authorId } : null },
    body_completeness: full ? 'full_text' : value.isLongText === true || isWeiboPreview(text) ? 'provider_preview' : 'unverified_complete' }
}

export function projectWeiboSearch(result, request) {
  const parsed = result.publicBody?.data?.parsed_data
  const pagination = parsed?.pagination
  // Verified TikHub responses can contain pagination={}. Like the historical
  // page-based adapter, offer one continuation for a nonempty page; the supplier
  // does not accept our pageSize, so a short page does not establish exhaustion.
  const emptyPagination = pagination !== null && typeof pagination === 'object'
    && !Array.isArray(pagination) && Object.keys(pagination).length === 0
  if (!Array.isArray(parsed?.results) || parsed.parse_success === false
    || (!emptyPagination && typeof pagination?.has_next_page !== 'boolean')) throw new Error('invalid_weibo_search_shape')
  const capturedAt = result.publicBody.meta.capturedAt
  const rows = parsed.results.map(value => weiboRow(value, capturedAt))
  if (rows.length > request.pageSize) throw new Error('weibo_page_exceeds_requested_count')
  const hasMore = (emptyPagination ? rows.length > 0 : pagination.has_next_page) && request.page < 15
  return { ...result, restrictedResponseArchive: result.restrictedResponseArchive, items: rows,
    publicBody: { contractVersion: RAW_SEARCH_VERSION, data: { platform: 'weibo', query: request.query,
      raw_info: '[]', raw_data: JSON.stringify(rows), page: { page: request.page, pageSize: request.pageSize,
        returnedCount: rows.length, hasMore, nextCursor: hasMore ? request.encodeNext({ page: request.page + 1 }) : null },
      status: 'ok', meta: { implementation: 'hub', resultCount: rows.length, upstreamCallCount: 1 } }, meta: { capturedAt } } }
}

const hasExpandControl = text => /展开(?:全文)?\s*[cＣ]?[\s\u200b\ufeff]*$/iu.test(text)

// Search is a summary observation. An identity-verified detail is independently
// authoritative, including edits that are shorter or use different formatting.
export function validateWeiboDetail(row, result) {
  const raw = result.publicBody?.data
  const capturedAt = result.publicBody?.meta?.capturedAt
  let detail
  try { detail = weiboRow(raw, capturedAt) } catch { return { reasons: ['invalid_detail_identity'] } }
  const longText = weiboText(raw?.longText?.content)
  const full = longText || weiboText(raw?.text_raw)
  const reasons = []
  if (detail.content_id !== row.content_id) reasons.push('post_id_mismatch')
  if (!detail.author_id || (row.author_id && detail.author_id !== row.author_id)) reasons.push('author_id_mismatch')
  if (raw?.deleted === true || raw?.deleted === 1 || raw?.deleted_at) reasons.push('detail_unavailable')
  if (!Number.isFinite(Date.parse(capturedAt))) reasons.push('detail_timestamp_missing')
  if (!full) reasons.push('full_text_missing')
  else if (hasExpandControl(full)) reasons.push('full_text_still_preview')
  if (full && !longText && raw?.isLongText !== false) {
    reasons.push(raw?.isLongText === true ? 'long_text_missing' : 'detail_completeness_unknown')
  }
  return { reasons, full, detail, provenance: { source: 'detail',
    field: longText ? 'longText.content' : 'text_raw', capturedAt,
    postId: detail.content_id, authorId: detail.author_id },
    comparison: { prefixMatches: weiboTextPrefixMatches(row.summary ?? row.text, full),
      fullTextLonger: full.length > (row.summary ?? row.text).length } }
}

export function mergeWeiboDetail(row, result) {
  const checked = validateWeiboDetail(row, result)
  if (checked.reasons.length) return false
  const { full, detail, provenance, comparison } = checked
  row.summary ??= row.text
  row.title = ''
  row.text = row.content = row.full_text = full
  row.author_id ||= detail.author_id
  row.body_provenance = { ...row.body_provenance, policy: WEIBO_DETAIL_POLICY,
    fullText: provenance, comparison }
  row.body_completeness = 'full_text'
  return true
}

export function rawSearchRecords(body, platform, provider) {
  const records = normalizeNightAllLegacyPayload(body, platform, 'raw', {
    connectorId: `external-platform:${provider}`, parserVersion: RAW_SEARCH_VERSION,
  }).records
  if (platform === 'weibo') for (const record of records) {
    record.extensions.rawSearch = { version: RAW_SEARCH_VERSION,
      bodyCompleteness: record.rawItem.body_completeness }
    record.extensions.weiboBody = { version: 'weibo-body.v1', summary: record.rawItem.summary,
      fullText: record.rawItem.full_text, provenance: structuredClone(record.rawItem.body_provenance) }
    delete record.extensions.summary
    delete record.extensions.body_provenance
    refreshMappedPayloadSha256(record)
  }
  return records
}

// Applied only to new deliveries. Saved response snapshots and raw provider
// evidence remain immutable; account/profile names are not content titles.
export function rawSearchContentTitles(payload, platform) {
  if (!['twitter', 'facebook', 'weibo', 'instagram'].includes(platform)) return payload
  return normalizeSearchContent(payload, platform, { format: 'raw' })
}
