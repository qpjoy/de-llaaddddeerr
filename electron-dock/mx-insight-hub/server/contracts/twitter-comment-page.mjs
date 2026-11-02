// Keep this parser import-free so the exact deployed mapping can also run
// against a verified saved archive through the standalone Admin inspector.
export function parseTikHubTwitterCommentPage(payload, postId, continuation = null) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  const twitterId = value => typeof value === 'string' && /^[0-9]{1,30}$/u.test(value) ? value : null
  const count = value => (typeof value === 'number' || typeof value === 'string' && /^\d+$/u.test(value))
    && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null
  const unusable = () => {
    const error = new Error('invalid_upstream_contract')
    error.code = 'invalid_upstream_contract'
    throw error
  }
  function timestamp(value) {
    if (value == null || value === '') return null
    const number = typeof value === 'number' || typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : null
    const date = new Date(number === null ? value : number * (number < 10_000_000_000 ? 1000 : 1))
    return Number.isFinite(date.getTime()) ? date.toISOString() : null
  }
  // Verified archives: empty reply-target f33e6d06-97f0-46c2-a049-c69ccfabf41d,
  // nonempty conversation 7e7cd2d0-aa97-4aa5-a113-5a92f8b3143b. The root data
  // object is the requested post; only thread entries are comment candidates.
  if (!object(payload) || payload.code !== 200 || !twitterId(postId)) unusable()
  const data = payload.data
  if (!object(data) || !twitterId(data.id) || data.id !== postId || !twitterId(data.conversation_id)
    || !Array.isArray(data.thread) || data.thread.length > 1000) unusable()
  const comments = []
  for (const raw of data.thread) {
    if (!object(raw) || !twitterId(raw.id)) unusable()
    if (raw.id === postId || raw.id === data.conversation_id) continue
    if (raw.conversation_id !== data.conversation_id || typeof raw.text !== 'string'
      || typeof raw.created_at !== 'string' || !object(raw.author) || !twitterId(raw.author.rest_id)
      || typeof raw.author.name !== 'string') unusable()
    const publishedAt = timestamp(raw.created_at)
    if (!publishedAt) unusable()
    comments.push({ raw, values: { commentId: raw.id, text: raw.text, publishedAt,
      publishedTime: raw.created_at, conversationId: data.conversation_id,
      author: { id: raw.author.rest_id, name: raw.author.name, avatarUrl: null,
        handle: typeof raw.author.screen_name === 'string' ? raw.author.screen_name : null },
      authorHandle: typeof raw.author.screen_name === 'string' ? raw.author.screen_name : null,
      // The observed thread objects omit immediate parent IDs. Conversation
      // membership does not establish whether a row directly replies to root.
      parentExternalId: null, parentCommentId: null, parentRelationship: 'unknown',
      url: `https://x.com/i/status/${raw.id}`, likes: raw.likes, replies: raw.replies,
      metrics: { shares: count(raw.retweets), views: count(raw.views), bookmarks: count(raw.bookmarks), quotes: count(raw.quotes) },
    } })
  }
  if (data.cursor != null && (typeof data.cursor !== 'string' || data.cursor.length > 8192 || data.cursor.includes('\0'))) unusable()
  const cursor = data.cursor || null
  const nextParams = cursor && cursor !== continuation?.cursor ? { cursor } : null
  // Even the verified empty thread has a nonempty cursor. Preserve an opaque
  // token for caller-driven continuation without claiming more rows or buying
  // another page automatically. Absence/repetition is not a proven terminal.
  const providerPage = { hasMore: null, nextParams, nextPage: null,
    ...(!nextParams ? { stopReason: 'continuation_unproven' } : {}) }
  return { comments, providerPage }
}
