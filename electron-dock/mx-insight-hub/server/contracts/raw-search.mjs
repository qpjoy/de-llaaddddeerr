import { createHash } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { normalizeNativeForwardingRequest } from './native-forwarding.mjs'
import { normalizeHubSocialRequest } from './hub-social.mjs'
import { normalizeNightAllLegacyPayload, NIGHT_ALL_COMPAT_DATASET_ID } from '../ingest/legacy-night-all.mjs'
import { refreshMappedPayloadSha256 } from '../ingest/external/mapping.mjs'
import { INSTAGRAM_SEARCH_KEY } from './instagram-search.mjs'
import { hasNoContentTitle } from './social-content-title.mjs'

export const RAW_SEARCH_VERSION = 'mx-insight-hub.raw-search.v1'
export const RAW_SEARCH_PATH = '/api/v1/night-all/search/raw'
export const RAW_SEARCH_DATASET = NIGHT_ALL_COMPAT_DATASET_ID
export const WEIBO_SEARCH_KEY = 't.weibo_web_v2_fetch_realtime_search'
export const WEIBO_DETAIL_KEY = 't.api_4f35621a9c07e539'
export const isHubRawCursor = value => typeof value === 'string' && value.startsWith('mxraw1.')

// Only verified request shapes move. Existing Night-All continuations remain
// pinned there; a Hub continuation must never fall back to the old provider.
export function canRouteRawSearch({ platform, upstreamBody: body, pageSize }) {
  if (!['weibo', 'twitter', 'instagram'].includes(platform)) return false
  if (isHubRawCursor(body.cursor)) return true
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
    && values[0].length <= 500 && (platform === 'twitter' || pageSize >= 20)
}

export function normalizeRawSearch(normalized, codec, { cursorScope } = {}) {
  const { platform, upstreamBody: body, pageSize } = normalized
  const withoutCursor = { ...body }
  delete withoutCursor.cursor
  if (!canRouteRawSearch({ ...normalized, upstreamBody: withoutCursor }) || body.page > 1) {
    throw new AppError(400, 'invalid_raw_search', 'This request shape cannot use the Hub raw search continuation')
  }
  const query = (body.keyword ?? body.query).trim()
  const scope = createHash('sha256').update(JSON.stringify({ platform, query, pageSize,
    includeDetails: body.includeDetails === true, disableAutoDetails: body.disableAutoDetails === true,
    maxEnrichItems: body.maxEnrichItems ?? 20, ...(cursorScope ? { cursorScope } : {}) })).digest('hex')
  let page = 1, providerCursor = null, expiresAt = Date.now() + 24 * 60 * 60_000
  if (body.cursor) {
    try {
      const state = codec.decode(body.cursor)
      if (state.version !== RAW_SEARCH_VERSION || state.scope !== scope || !Number.isSafeInteger(state.expiresAt)
        || state.expiresAt <= Date.now() || !Number.isInteger(state.page) || state.page < 2 || state.page > 15
        || (platform === 'twitter' && (typeof state.providerCursor !== 'string' || !state.providerCursor || state.providerCursor.length > 4096))
        || (platform === 'instagram' && (!state.providerCursor || typeof state.providerCursor.next_max_id !== 'string'
          || !state.providerCursor.next_max_id || state.providerCursor.next_max_id.length > 2048
          || Object.keys(state.providerCursor).some(key => !['next_max_id', 'rank_token'].includes(key))
          || (state.providerCursor.rank_token != null && (typeof state.providerCursor.rank_token !== 'string' || state.providerCursor.rank_token.length > 2048))))) throw new Error('cursor')
      ;({ page, providerCursor = null, expiresAt } = state)
    } catch { throw new AppError(400, 'invalid_cursor', 'Cursor is invalid, expired or belongs to another query/Key') }
  }
  const providerRequest = platform === 'weibo'
    ? normalizeNativeForwardingRequest(WEIBO_SEARCH_KEY, { params: { query, page } })
    : platform === 'instagram' ? normalizeNativeForwardingRequest(INSTAGRAM_SEARCH_KEY, { params: { query, enable_metadata: true, ...providerCursor } })
      : normalizeHubSocialRequest('search', { platform, query, count: pageSize })
  if (platform === 'twitter') {
    providerRequest.page = page
    providerRequest.expiresAt = expiresAt
    providerRequest.providerCursor = providerCursor
    if (providerCursor) providerRequest.upstreamQuery.cursor = providerCursor
  }
  const encodeNext = state => codec.encode({ version: RAW_SEARCH_VERSION, scope, expiresAt,
    page: state.page, ...(state.providerCursor ? { providerCursor: state.providerCursor } : {}) })
  return { ...providerRequest, platform, query, page, pageSize, providerCursor, providerRequest, encodeNext,
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

export function weiboRow(value, capturedAt) {
  const contentId = id(value?.weibo_id ?? value?.idstr ?? value?.id)
  if (!contentId) throw new Error('invalid_weibo_identity')
  const user = value.user || {}
  const authorId = id(user.idstr ?? user.id ?? value.user_id) || string(value.user_url).match(/\/(?:u\/)?(\d+)(?:[/?#]|$)/)?.[1] || null
  const text = weiboText(value.longText?.content || value.text_raw || value.content || value.text)
  const images = value.media?.images || value.pic_ids?.map(pic => value.pic_infos?.[pic]?.original?.url).filter(Boolean) || []
  const videos = value.media?.videos || []
  return { content_id: contentId, platform_name: 'weibo', title: '',
    text, content: text, full_text: text, url: value.post_url || value.url || (authorId ? `https://weibo.com/${authorId}/${value.mblogid || contentId}` : null),
    author_id: authorId, author_name: user.screen_name || value.user_name || '',
    author_avatar_url: user.profile_image_url || value.user_avatar || null,
    created_at: publishedAt(value.created_at || value.publish_time, capturedAt), collected_at: capturedAt,
    like_count: metric(value.attitudes_count ?? value.interaction?.like_count ?? value.interaction?.likes),
    comment_count: metric(value.comments_count ?? value.interaction?.comment_count ?? value.interaction?.comments),
    forward_count: metric(value.reposts_count ?? value.interaction?.repost_count ?? value.interaction?.reposts),
    image_urls: JSON.stringify(images), video_urls: JSON.stringify(videos),
    body_completeness: value.isLongText === true && !value.longText?.content || isWeiboPreview(text) ? 'provider_preview' : 'unverified_complete' }
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

export function mergeWeiboDetail(row, result) {
  const raw = result.publicBody?.data
  const detail = weiboRow(raw, result.publicBody.meta.capturedAt)
  const full = weiboText(raw?.longText?.content || raw?.text_raw)
  const prefix = row.text.replace(/(?:展开(?:全文)?\s*[cＣ]?|…|\.{3})[\s\u200b\ufeff]*$/iu, '').trim().replace(/[\s\u200b\ufeff]/gu, '')
  if (detail.content_id !== row.content_id || (row.author_id && detail.author_id !== row.author_id)
    || !full || full.length <= row.text.length || isWeiboPreview(full)
    || !full.replace(/[\s\u200b\ufeff]/gu, '').startsWith(prefix)) return false
  row.title = ''
  row.text = row.content = row.full_text = full
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
    refreshMappedPayloadSha256(record)
  }
  return records
}

// Applied only to new deliveries. Saved response snapshots and raw provider
// evidence remain immutable; account/profile names are not content titles.
export function rawSearchContentTitles(payload, platform) {
  if (!['twitter', 'facebook', 'weibo', 'instagram'].includes(platform)) return payload
  const body = structuredClone(payload)
  const visit = data => {
    if (!data || typeof data !== 'object') return
    if (typeof data.raw_data === 'string') {
      let rows
      try { rows = JSON.parse(data.raw_data) } catch { /* Preserve unrecognized optional child data. */ }
      if (Array.isArray(rows)) data.raw_data = JSON.stringify(rows.map(row => row && typeof row === 'object' && !Array.isArray(row) && hasNoContentTitle(platform, row) ? { ...row, title: '' } : row))
    }
    if (Array.isArray(data.items)) data.items = data.items.map(row => row && typeof row === 'object' && !Array.isArray(row) && hasNoContentTitle(platform, row) ? { ...row, title: '' } : row)
    for (const child of Array.isArray(data.results) ? data.results : []) visit(child?.data || child)
  }
  visit(body.data)
  return body
}
