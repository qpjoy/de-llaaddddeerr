import { AppError } from '../core/errors.mjs'
import { xiaohongshuImageUrl } from '../../shared/xiaohongshu-media.mjs'
import { XIAOHONGSHU_ANALYTICS_METERS } from '../../shared/product-catalog.mjs'
import { XHS_BLOGGER_NOTES_V2, projectBloggerNotesV2 } from './xiaohongshu-note-metrics.mjs'

// A separately callable page of the existing analytics service. Keep its
// optional procurement price separate from the original detail endpoint.
export const XHS_BLOGGER_NOTES_ENDPOINT = Object.freeze({
  name: 'user_notes_analytics', path: '/api/v1/data/xiaohongshu/users/notes/analytics',
  aliases: ['/api/v1/xiaohongshu/pgy/get_blogger_notes_v2'],
  providerPath: XHS_BLOGGER_NOTES_V2.providerPath, providerMethod: 'POST',
  endpointKey: XHS_BLOGGER_NOTES_V2.endpointKey, endpointVersion: XHS_BLOGGER_NOTES_V2.endpointVersion,
  operation: 'social.posts.analytics', gate: 'researchContractVerified',
  meterKey: XIAOHONGSHU_ANALYTICS_METERS[1].key,
  fields: ['user_id', 'page_number', 'page_size', 'note_type', 'order_type'],
  label: '按用户 ID 获取笔记指标', research: true, liveOnly: true,
})
const VERSION = 'mx-insight-hub.xiaohongshu-user-note-analytics.v1'
const invalid = message => { throw new AppError(400, 'invalid_request', message) }
const unusable = () => { throw new AppError(502, 'invalid_upstream_contract', 'User notes response does not match the released contract') }
const text = value => typeof value === 'string' ? value : null
function url(value) {
  try { const parsed = new URL(value); return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? value : null } catch { return null }
}

export function normalizeBloggerNotesRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !XHS_BLOGGER_NOTES_ENDPOINT.fields.includes(key))) invalid('Unsupported request fields')
  if (typeof input.user_id !== 'string' || !/^[a-f0-9]{24}$/iu.test(input.user_id)) invalid('user_id must be a 24-character hexadecimal ID')
  const providerQuery = { user_id: input.user_id.toLowerCase(), page_number: input.page_number ?? 1,
    page_size: input.page_size ?? 8, note_type: input.note_type ?? 0, order_type: input.order_type ?? 1 }
  for (const [key, min, max] of [['page_number', 1, Number.MAX_SAFE_INTEGER], ['page_size', 1, 8], ['note_type', 0, 2], ['order_type', 1, 3]]) {
    if (!Number.isSafeInteger(providerQuery[key]) || providerQuery[key] < min || providerQuery[key] > max) invalid(`${key} must be an integer between ${min} and ${max}`)
  }
  return { endpoint: XHS_BLOGGER_NOTES_ENDPOINT, providerQuery, publicQuery: { ...providerQuery },
    page: providerQuery.page_number, contractVersion: VERSION }
}

export function projectBloggerNotesPage(payload, request, capturedAt) {
  const parsed = projectBloggerNotesV2(payload)
  const { user_id: userId, page_number: page, page_size: pageSize } = request.providerQuery
  if (parsed.items.length > pageSize) unusable()
  const collectedAt = new Date(capturedAt).toISOString()
  const items = parsed.items.map((entry, index) => {
    if (entry.authorId && entry.authorId !== userId) unusable()
    const { noteInfo: note, userInfo } = payload.data.data.noteList[index]
    const user = userInfo || {}
    const image = xiaohongshuImageUrl(note.imageUrl)
    const published = typeof note.notePublishTime === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(note.notePublishTime)
      ? new Date(note.notePublishTime.replace(' ', 'T') + '+08:00') : null
    return {
      platform: 'xiaohongshu', externalId: entry.externalId, url: `https://www.xiaohongshu.com/explore/${entry.externalId}`,
      title: text(note.title), text: text(note.content), type: note.noteType === 1 ? 'image' : note.noteType === 2 ? 'video' : null,
      publishedAt: published && Number.isFinite(published.getTime()) ? published.toISOString() : null, collectedAt,
      author: { id: entry.authorId || userId, name: text(user.nickName), avatarUrl: url(user.avatar) },
      media: image ? [{ type: 'image', url: image }] : [],
      metrics: { ...entry.metrics, liked: null, comments: null, shared: null },
    }
  })
  const exhausted = items.length === 0 || (parsed.total != null && page >= Math.ceil(parsed.total / pageSize))
  const nextPage = !exhausted && page < Number.MAX_SAFE_INTEGER ? page + 1 : null
  return { code: 200, meta: { status: items.length ? 'ok' : 'no_data', collectedAt },
    data: { userId, items, total: parsed.total, page, pageSize, nextPage,
      hasMore: exhausted ? false : parsed.total == null ? null : true } }
}
