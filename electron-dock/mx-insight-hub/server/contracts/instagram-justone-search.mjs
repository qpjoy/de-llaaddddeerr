import { createHash } from 'node:crypto'
import { instagramRow } from './instagram-search.mjs'

export const JUSTONE_INSTAGRAM_SEARCH_KEY = 'j.api_7968b9ed3e986618'
const object = value => value && typeof value === 'object' && !Array.isArray(value)

// Official documentation's non-synthetic example, checkedAt 2026-10-15T00:00:09:
// https://api.justoneapi.com/status/api-example/detail?api=%2Fapi%2Finstagram%2Fgeneral-search%2Fv1
// Business data is { data: { count, items }, pagination_token }. Its output
// token is opaque; only the request parameter is named paginationToken.
function mediaForRow(value) {
  if (!object(value)) throw new Error('invalid_instagram_post_identity')
  if (value.image_versions != null && (!object(value.image_versions)
    || !Array.isArray(value.image_versions.items))) throw new Error('invalid_instagram_search_shape')
  if (value.thumbnail_url != null && typeof value.thumbnail_url !== 'string') throw new Error('invalid_instagram_search_shape')
  if (value.carousel_media != null && !Array.isArray(value.carousel_media)) throw new Error('invalid_instagram_search_shape')
  return { ...value,
    image_versions2: { candidates: value.image_versions?.items ?? [] },
    display_url: value.thumbnail_url,
    ...(Array.isArray(value.carousel_media) ? { carousel_media: value.carousel_media.map(mediaForRow) } : {}),
  }
}

export function projectJustOneInstagramSearch(result, request) {
  const root = result.publicBody?.data
  const data = root?.data
  if (!object(root) || !object(data) || !Array.isArray(data.items)
    || !Number.isSafeInteger(data.count) || data.count < 0) throw new Error('invalid_instagram_search_shape')
  // Do not infer a terminal page from a missing field or an unknown object.
  // Explicit null/empty terminal values are supported boundary semantics; the
  // public example only proves a nonempty continuation, not a terminal page.
  // A repeated nonempty token is not progress.
  const next = root.pagination_token
  if (!Object.hasOwn(root, 'pagination_token') || (next !== null && (typeof next !== 'string'
    || next.length > 2048 || (next && !next.trim()) || next.includes('\u0000')))
    || (next && next === request.providerCursor)) throw new Error('invalid_instagram_continuation')
  const capturedAt = result.publicBody.meta.capturedAt
  const rows = [...new Map(data.items.map(value => {
    const row = instagramRow(mediaForRow(value), capturedAt)
    return [row.content_id, row]
  })).values()]
  const rowsHash = createHash('sha256').update(JSON.stringify(rows)).digest('hex')
  const offset = request.buffer?.offset ?? 0
  if (request.buffer && (request.buffer.hash !== rowsHash || !Number.isSafeInteger(offset)
    || offset < 1 || offset >= rows.length || offset % request.pageSize !== 0)) {
    throw new Error('instagram_buffer_mismatch')
  }
  const items = rows.slice(offset, offset + request.pageSize)
  const buffered = offset + items.length < rows.length
  const callId = request.buffer?.callId ?? request.archiveCallId
  if (buffered && !callId) throw new Error('instagram_page_archive_required')
  const hasMore = request.page < 15 && (buffered || !!next)
  const nextCursor = !hasMore ? null : request.encodeNext({ page: request.page + 1,
    ...(buffered ? { buffer: { callId, offset: offset + items.length, hash: rowsHash }, providerCursor: request.providerCursor }
      : { providerCursor: next }) })
  const warnings = request.page === 15 && (buffered || next) ? [{ code: 'INSTAGRAM_PAGE_LIMIT_REACHED',
    message: 'The 15-page traversal limit was reached; additional results may exist.' }] : []
  const publicBody = { contractVersion: 'mx-insight-hub.raw-search.v1', data: { platform: 'instagram', query: request.query,
    raw_info: '[]', raw_data: JSON.stringify(items), page: { page: request.page, pageSize: request.pageSize,
      returnedCount: items.length, hasMore, nextCursor }, status: warnings.length ? 'partial' : 'ok',
    ...(warnings.length ? { warnings } : {}),
    meta: { implementation: 'hub', resultCount: items.length, upstreamCallCount: request.buffer ? 0 : 1 } }, meta: { capturedAt } }
  const projected = { ...result, items, acquiredItems: rows, publicBody, payload: publicBody }
  // Exact paid evidence is non-enumerable on adapter results. Preserve it for
  // persistence without exposing it in the public normalized response.
  for (const key of ['restrictedResponseArchive', 'request']) {
    const descriptor = Object.getOwnPropertyDescriptor(result, key)
    if (descriptor) Object.defineProperty(projected, key, descriptor)
  }
  return projected
}
