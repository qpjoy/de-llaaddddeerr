// Import-free TikHub Weibo Web-V2 first-level comment parser.
// The endpoint documents `max_id` continuation and an empty max_id terminal;
// every other cursor shape is treated as unknown until verified.
// 2026-11-07 live pages: a first-level comment's rootid is the comment's own
// ID; a sub-comment's rootid is its root comment. With { replies: true } the
// second argument is the requested root comment ID.
export function parseTikHubWeiboCommentPage(payload, postId, continuation = null, { replies = false } = {}) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  const invalid = reason => { const error = new Error('invalid_upstream_contract'); error.code = 'invalid_upstream_contract'; error.reason = reason; throw error }
  const idString = value => typeof value === 'string' && /^[1-9][0-9]{0,29}$/u.test(value) ? value : null
  const idNumber = value => Number.isSafeInteger(value) && value > 0 ? String(value) : null
  const metric = value => {
    if (value == null) return null
    const number = typeof value === 'string' && /^[0-9]{1,16}$/u.test(value) ? Number(value) : value
    if (!Number.isSafeInteger(number) || number < 0) invalid('comment_metrics')
    return number
  }
  const identity = (row, fields, reason) => {
    const strings = fields.map(field => idString(row?.[field])).filter(Boolean)
    if (new Set(strings).size > 1) invalid(reason)
    const numbers = fields.map(field => idNumber(row?.[field])).filter(Boolean)
    if (new Set(numbers).size > 1) invalid(reason)
    if (strings.length) {
      // A safe numeric alias is an independent identity claim. Unsafe numeric
      // values are deliberately ignored because JSON has already rounded them.
      if (numbers.length && numbers.some(value => value !== strings[0])) invalid(reason)
      return strings[0]
    }
    return numbers[0] || null
  }
  const timestamp = value => {
    // Weibo commonly emits RFC-like strings such as
    // "Mon Nov 03 09:44:56 +0800 2025", where the offset precedes the year.
    if (typeof value !== 'string' || !value.trim()
      || !/(?:^|\s)(?:Z|[+-][0-9]{4}|[+-][0-9]{2}:?[0-9]{2})(?:\s|$)/u.test(value)) return null
    const date = new Date(value)
    return Number.isFinite(date.getTime()) ? date.toISOString() : null
  }
  const validCursorInput = value => value == null || typeof value === 'string' && value.length <= 8192 && !value.includes('\0')
  if (!object(payload) || payload.code !== 200 || typeof postId !== 'string' || !/^\d{1,30}$/u.test(postId)) invalid('invalid_envelope')
  if (!object(payload.params) || String(payload.params.id) !== postId) invalid('root_id_mismatch')
  if (!object(payload.data) || !Array.isArray(payload.data.data) || payload.data.data.length > 1000) invalid('comment_rows_shape')
  if (continuation != null && (!object(continuation) || Object.keys(continuation).some(key => key !== 'max_id') || !validCursorInput(continuation.max_id))) invalid('continuation_shape')
  const rows = payload.data.data
  let previewCommentCount = 0
  for (const context of rows) {
    if (!object(context)) invalid('comment_row_shape')
    if (Array.isArray(context.comments)) previewCommentCount += context.comments.length
  }
  const comments = rows.map(raw => {
    const commentId = identity(raw, ['idstr', 'mid', 'id'], 'comment_identity_conflict')
    if (!commentId) invalid('comment_identity')
    const rootId = identity(raw, ['rootidstr', 'rootid'], 'root_id_conflict')
    // First-level rows: live 2026-11-07 rootid was the comment itself; the 11-02
    // saved sample passed with rootid = post. Either is a first-level comment.
    if (replies ? rootId && rootId !== postId : rootId && rootId !== commentId && rootId !== postId) invalid('root_id_mismatch')
    if (!object(raw.user)) invalid('author_identity')
    const authorId = identity(raw.user, ['idstr', 'id'], 'author_identity_conflict')
    if (!authorId) invalid('author_identity')
    const authorName = typeof raw.user.screen_name === 'string' ? raw.user.screen_name : typeof raw.user.name === 'string' ? raw.user.name : null
    if (!authorName) invalid('author_identity')
    const publishedAt = timestamp(raw.created_at)
    if (!publishedAt) invalid('comment_time')
    const text = typeof raw.text_raw === 'string' ? raw.text_raw : typeof raw.text === 'string' ? raw.text : null
    if (text == null) invalid('comment_text')
    return { raw, values: { commentId, text, publishedAt, publishedTime: raw.created_at,
      author: { id: authorId, name: authorName, avatarUrl: null,
        handle: authorName, profileUrl: typeof raw.user.profile_url === 'string' ? raw.user.profile_url : null },
      authorHandle: authorName, likes: metric(raw.like_counts), replies: metric(raw.total_number),
      parentExternalId: null, parentCommentId: null, parentRelationship: 'unknown', url: null,
    } }
  })
  const cursor = payload.data.max_id
  let cursorState = 'missing', nextParams = null, hasMore = null, stopReason = 'continuation_unproven'
  if (cursor === '') { cursorState = 'empty'; hasMore = false; stopReason = null }
  else if (typeof cursor === 'string' && /^[1-9][0-9]{0,29}$/u.test(cursor)) {
    cursorState = cursor === String(continuation?.max_id ?? '') ? 'repeated' : 'advancing'
    if (cursorState === 'advancing') { hasMore = true; nextParams = { max_id: cursor }; stopReason = null } else stopReason = 'continuation_unproven'
  } else if (Number.isSafeInteger(cursor) && cursor > 0) {
    const token = String(cursor); cursorState = token === String(continuation?.max_id ?? '') ? 'repeated' : 'advancing'
    if (cursorState === 'advancing') { hasMore = true; nextParams = { max_id: token }; stopReason = null } else stopReason = 'continuation_unproven'
  } else if (cursor == null || cursor === 0 || cursor === '0' || typeof cursor === 'number') cursorState = cursor == null ? 'missing' : 'unproven'
  else if (typeof cursor === 'string') cursorState = 'unproven'
  return { comments, providerPage: { hasMore, nextParams, nextPage: null, ...(stopReason ? { stopReason } : {}) },
    diagnostics: { contextRootCount: rows.length, previewCommentCount, cursorState } }
}
