// Pure parser for TikHub's Weibo first-level post-comments response.
// Keep this import-free so the Admin inspector can concatenate it into stdin.
export function parseTikHubWeiboCommentPage(payload, postId, continuation = null) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  const fail = reason => { const error = new Error('invalid_upstream_contract'); error.code = error.message; error.reason = reason; throw error }
  const identity = value => typeof value === 'string' && /^[1-9][0-9]{0,29}$/u.test(value)
    ? value : Number.isSafeInteger(value) && value > 0 ? String(value) : null
  const count = value => Number.isSafeInteger(value) && value >= 0
  const date = value => { if (typeof value !== 'string' || !value.trim()) fail('comment_time'); const parsed = new Date(value); if (!Number.isFinite(parsed.getTime())) fail('comment_time'); return parsed.toISOString() }
  if (!object(payload) || payload.code !== 200 || !object(payload.params) || payload.params.id !== postId
    || !object(payload.data) || payload.data.ok !== 1 || !Array.isArray(payload.data.data) || payload.data.data.length > 1000
    || typeof postId !== 'string' || !/^[1-9][0-9]{0,29}$/u.test(postId)) fail('invalid_envelope')
  if (continuation !== null && (!object(continuation) || Object.keys(continuation).some(key => key !== 'max_id')
    || continuation.max_id != null && (typeof continuation.max_id !== 'string' || !/^[0-9]{1,30}$/u.test(continuation.max_id)))) fail('continuation_shape')
  let previewCommentCount = 0
  if (payload.data.rootComment != null) {
    if (!Array.isArray(payload.data.rootComment) || payload.data.rootComment.length > 1000) fail('preview_shape')
  }
  const contextRootCount = Array.isArray(payload.data.rootComment) ? payload.data.rootComment.length : 0
  const comments = payload.data.data.map(raw => {
    if (!object(raw) || !identity(raw.idstr) || raw.mid !== raw.idstr || raw.rootidstr !== raw.idstr
      || raw.id != null && !Number.isSafeInteger(raw.id) && typeof raw.id !== 'number'
      || raw.rootid != null && !Number.isSafeInteger(raw.rootid) && typeof raw.rootid !== 'number') fail('comment_identity')
    if (raw.id != null && Number.isSafeInteger(raw.id) && raw.id > 0 && String(raw.id) !== raw.idstr) fail('comment_identity_conflict')
    if (raw.rootid != null && Number.isSafeInteger(raw.rootid) && raw.rootid > 0 && String(raw.rootid) !== raw.rootidstr) fail('comment_identity_conflict')
    if (typeof raw.text_raw !== 'string' && typeof raw.text !== 'string') fail('comment_text')
    const user = raw.user
    if (!object(user) || !identity(user.idstr) || typeof user.screen_name !== 'string') fail('author_identity')
    if (user.id != null && Number.isSafeInteger(user.id) && user.id > 0 && String(user.id) !== user.idstr) fail('author_identity_conflict')
    const publishedAt = date(raw.created_at)
    if (!count(raw.like_counts) || !count(raw.total_number)) fail('comment_metrics')
    if (raw.comments != null) {
      if (!Array.isArray(raw.comments) || raw.comments.length > 1000) fail('preview_shape')
      previewCommentCount += raw.comments.length
    }
    return { raw, values: { commentId: raw.idstr, text: typeof raw.text_raw === 'string' ? raw.text_raw : raw.text,
      publishedAt, publishedTime: raw.created_at, author: { id: user.idstr, name: user.screen_name,
        avatarUrl: typeof user.profile_url === 'string' ? user.profile_url : null }, likes: raw.like_counts,
      replies: raw.total_number, parentExternalId: null, parentCommentId: null, parentRelationship: 'unknown', url: null } }
  })
  const cursor = payload.data.max_id
  let cursorState = 'missing', nextParams = null, hasMore = null, stopReason = 'continuation_unproven'
  if (cursor === '') { cursorState = 'empty'; hasMore = false; stopReason = null }
  else if (cursor === null) cursorState = 'null'
  else if (cursor === undefined) cursorState = 'missing'
  else if (typeof cursor === 'number') cursorState = Number.isSafeInteger(cursor) ? cursor === 0 ? 'zero' : 'invalid' : 'unsafe_number'
  else if (typeof cursor === 'string' && /^[0-9]{1,30}$/u.test(cursor)) {
    cursorState = cursor === '0' ? 'zero' : continuation?.max_id === cursor ? 'repeated' : 'advancing'
    if (cursorState === 'advancing') nextParams = { max_id: cursor }
  } else cursorState = 'invalid'
  return { comments, providerPage: { hasMore, nextParams, nextPage: null, ...(stopReason ? { stopReason } : {}) },
    diagnostics: { previewRootCount: comments.filter(comment => Array.isArray(comment.raw.comments) && comment.raw.comments.length > 0).length,
      previewCommentCount, contextRootCount, cursorState } }
}
