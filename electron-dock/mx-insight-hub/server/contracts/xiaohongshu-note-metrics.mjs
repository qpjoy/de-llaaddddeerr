import { AppError } from '../core/errors.mjs'

// Internal supplementary acquisition; it uses the existing analytics grant and
// customer request, but requires its own explicitly reviewed procurement price.
export const XHS_BLOGGER_NOTES_V2 = Object.freeze({
  endpointKey: 'xiaohongshu.pgy.blogger-notes.v2',
  providerPath: '/api/v1/xiaohongshu/pgy/get_blogger_notes_v2',
  endpointVersion: 'pgy_v2',
  contractVersion: 'mx-insight-hub.xiaohongshu-note-metrics.v1',
  pageSize: 8, maxPages: 15, budgetMs: 90000,
})

const record = value => value && typeof value === 'object' && !Array.isArray(value)
const count = value => (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)))
  && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null
const id = value => typeof value === 'string' && /^[a-f0-9]{24}$/iu.test(value) ? value.toLowerCase() : null
const invalid = () => { throw new AppError(502, 'invalid_upstream_contract', 'Note metrics response does not match the released contract') }

export function needsNoteMetrics(item) {
  return Boolean(item) && ([item.metrics?.views, item.metrics?.impressions].some(value => value == null)
    || ![item.metrics?.views, item.metrics?.impressions].some(value => value > 0))
}

export function projectBloggerNotesV2(payload) {
  if (payload?.code !== 200) invalid()
  if (payload.data === null) return { items: [], total: null }
  const envelope = payload.data
  if (!record(envelope) || envelope.success === false
    || (envelope.code != null && ![0, 200, '0', '200'].includes(envelope.code))) invalid()
  if (envelope.data === null) return { items: [], total: null }
  const data = envelope.data
  if (!record(data) || !Array.isArray(data.noteList) || data.noteList.length > XHS_BLOGGER_NOTES_V2.pageSize) invalid()
  const items = data.noteList.map(entry => {
    const note = entry?.noteInfo
    if (!record(note) || !id(note.noteId)) invalid()
    if (entry.userInfo?.userId != null && !id(entry.userInfo.userId)) invalid()
    return {
      externalId: id(note.noteId), authorId: id(entry.userInfo?.userId),
      metrics: { views: count(note.readNum), impressions: count(note.impNum),
        collected: count(note.favNum), engaged: count(note.engageNum) },
    }
  })
  return { items, total: count(data.total) }
}

export function mergeBloggerNoteMetrics(projection, match, { page, capturedAt }) {
  const item = projection.data.item
  if (match.externalId !== item.externalId || (match.authorId && match.authorId !== item.author.id?.toLowerCase())) invalid()
  const whollyEmpty = Object.values(item.metrics).every(value => value == null || value === 0)
  const emptyReach = ![item.metrics.views, item.metrics.impressions].some(value => value > 0)
  const sources = Object.fromEntries(Object.entries(item.metrics).map(([key, value]) => [key, value == null ? null : 'detail']))
  // An entirely empty detail metric set is an upstream placeholder in this
  // case. V2 does not supply individual likes/comments/shares; do not derive
  // those from engageNum or retain its placeholder zeroes as verified counts.
  if (whollyEmpty && Object.values(match.metrics).some(value => value > 0)) {
    for (const key of Object.keys(item.metrics)) { item.metrics[key] = null; sources[key] = null }
  }
  for (const [key, value] of Object.entries(match.metrics)) {
    if (value != null && (key === 'engaged' || (emptyReach && ['views', 'impressions'].includes(key)) || item.metrics[key] == null || whollyEmpty)) {
      item.metrics[key] = value
      sources[key] = 'blogger_notes_v2'
    }
  }
  projection.meta.metricSources = sources
  projection.meta.metricsSupplement = { ...projection.meta.metricsSupplement, status: 'matched', matchedPage: page, collectedAt: capturedAt }
}
