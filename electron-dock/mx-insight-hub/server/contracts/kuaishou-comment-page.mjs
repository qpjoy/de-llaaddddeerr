// All 11 roots in saved App usage 16eb4f8e-7d1d-40e2-8593-02570ee3fd37
// passed this same parser against the saved request and response echo.
// Keep import-free for concatenation into the read-only Admin inspector.
export function parseTikHubKuaishouCommentPage(payload, postId, continuation = null) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  const unusable = (reason = 'invalid_envelope') => {
    const error = new Error('invalid_upstream_contract')
    error.code = 'invalid_upstream_contract'
    error.reason = reason
    throw error
  }
  const identity = value => typeof value === 'string' && /^[1-9][0-9]{0,29}$/u.test(value) ? value
    : Number.isSafeInteger(value) && value > 0 ? String(value) : null
  function metric(value) {
    if (value == null) return null
    const number = typeof value === 'string' && /^[0-9]+$/u.test(value) ? Number(value) : value
    if (!Number.isSafeInteger(number) || number < 0) unusable('comment_metrics')
    return number
  }
  function timestamp(value) {
    const number = typeof value === 'string' && /^[0-9]+$/u.test(value) ? Number(value) : value
    if (!Number.isSafeInteger(number) || number <= 0) unusable('comment_time')
    const date = new Date(number < 10_000_000_000 ? number * 1000 : number)
    if (!Number.isFinite(date.getTime())) unusable('comment_time')
    return date.toISOString()
  }
  function avatar(value) {
    if (value == null) return null
    if (typeof value !== 'string') unusable('author_avatar')
    try {
      const parsed = new URL(value)
      return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : null
    } catch { return null }
  }
  const validCursor = value => typeof value === 'string' && value.length <= 8192
    && !value.includes('\0') && (value === '' || Boolean(value.trim()))
  if (!object(payload) || payload.code !== 200 || !object(payload.data) || payload.data.result !== 1) unusable()
  if (typeof postId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(postId)
    || !object(payload.params) || payload.params.photo_id !== postId) unusable('root_id_mismatch')
  const data = payload.data
  if (!Array.isArray(data.rootComments) || data.rootComments.length > 1000) unusable('root_comments_shape')
  if (continuation != null && (!object(continuation) || Object.keys(continuation).some(key => key !== 'pcursor')
    || continuation.pcursor != null && !validCursor(continuation.pcursor))) unusable('continuation_shape')
  if (data.pcursor != null && !validCursor(data.pcursor)) unusable('pagination_shape')

  // subCommentsMap contains previews, not another complete comment page.
  // Keep it in the original response archive; do not emit preview rows or use
  // their count/cursor as the root comment's reply count or page continuation.
  let previewRootCount = 0, previewCommentCount = 0
  if (data.subCommentsMap != null) {
    if (!object(data.subCommentsMap)) unusable('preview_shape')
    const previews = Object.values(data.subCommentsMap)
    if (previews.length > 1000) unusable('structure_limit')
    previewRootCount = previews.length
    for (const preview of previews) {
      if (!object(preview) || !Array.isArray(preview.subComments)) unusable('preview_shape')
      if (preview.subComments.length > 1000 || (previewCommentCount += preview.subComments.length) > 5000) unusable('structure_limit')
      if (preview.subComments.some(row => !object(row))) unusable('preview_shape')
    }
  }
  const comments = data.rootComments.map(raw => {
    if (!object(raw) || !identity(raw.comment_id)) unusable('comment_identity')
    if (typeof raw.content !== 'string') unusable('comment_text')
    if (!identity(raw.author_id) || typeof raw.author_name !== 'string') unusable('author_identity')
    const publishedAt = timestamp(raw.timestamp)
    return { raw, values: { commentId: identity(raw.comment_id), text: raw.content, publishedAt,
      publishedTime: typeof raw.time === 'string' ? raw.time : null,
      author: { id: identity(raw.author_id), name: raw.author_name, avatarUrl: avatar(raw.headurl) },
      likes: metric(raw.likedCount), replies: metric(raw.subCommentCount),
      // The rootComments container establishes a direct parent. reply_to and
      // user_id have not established comment/author identity and remain raw.
      // The internal numeric photo_id may exceed safe integer precision and
      // differ from the public eID. Never coerce it into the requested target.
      parentExternalId: postId, parentCommentId: null, parentRelationship: 'post', url: null,
    } }
  })
  const cursorState = data.pcursor === undefined ? 'missing' : data.pcursor === null ? 'null'
    : data.pcursor === '' ? 'empty' : data.pcursor === 'no_more' ? 'sentinel_unverified'
      : data.pcursor === continuation?.pcursor ? 'repeated' : 'advancing'
  const nextParams = cursorState === 'advancing' ? { pcursor: data.pcursor } : null
  // App docs establish pcursor continuation but do not prove an exhausted
  // response sentinel. Even no_more is stopped conservatively, not imported
  // as terminal evidence from a different supplier or a search endpoint.
  return { comments, providerPage: { hasMore: null, nextParams, nextPage: null,
    ...(!nextParams ? { stopReason: 'continuation_unproven' } : {}) },
  diagnostics: { previewRootCount, previewCommentCount, cursorState } }
}
