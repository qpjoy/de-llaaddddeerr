// Import-free so saved restricted archives can use the same reviewed parser.
// Derived from Twitter AIO / TwittrAPI's documented TweetDetail raw layout:
// https://www.twittrapi.com/docs/reference/tweet-tweetid-replies
// https://www.twittrapi.com/docs/reference/tweet-tweetid
// The replies endpoint has no published response example or paid calibration.
export function parseRapidApiTwitterCommentPage(payload, subjectId, continuation = null) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  const id = value => typeof value === 'string' && /^\d{1,30}$/u.test(value) ? value : null
  const count = value => (typeof value === 'number' || typeof value === 'string' && /^\d+$/u.test(value))
    && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null
  const unusable = () => { const error = new Error('invalid_upstream_contract'); error.code = 'invalid_upstream_contract'; throw error }
  const instructions = payload?.data?.threaded_conversation_with_injections_v2?.instructions
  if (!object(payload) || !id(subjectId) || !Array.isArray(instructions) || instructions.length > 1000
    || Array.isArray(payload.errors) && payload.errors.length) unusable()
  const comments = [], roots = new Set(), seen = new Set()
  let bottom = null

  function append(itemContent, inConversation) {
    if (!object(itemContent)) unusable()
    if (itemContent.promotedMetadata) return
    const result = itemContent.tweet_results?.result
    if (!object(result)) {
      if (itemContent.itemType === 'TimelineTweet') unusable()
      return
    }
    const raw = result.__typename === 'TweetWithVisibilityResults' ? result.tweet : result
    // Unavailable/deleted tweets are not fabricated into empty comments.
    if (!object(raw)) unusable()
    if (['TweetTombstone', 'TweetUnavailable'].includes(raw.__typename)) return
    const legacy = raw.legacy, commentId = id(raw.rest_id ?? legacy?.id_str)
    if (!object(legacy) || !commentId || legacy.id_str != null && legacy.id_str !== commentId) unusable()
    const conversationId = id(legacy.conversation_id_str), parent = id(legacy.in_reply_to_status_id_str)
    if (legacy.conversation_id_str != null && !conversationId || legacy.in_reply_to_status_id_str != null && !parent) unusable()
    if (commentId === subjectId || commentId === conversationId || seen.has(commentId)) return
    // A flat detail timeline also includes ancestors and recommendations. Only
    // explicit direct replies establish membership outside conversation modules.
    if (!inConversation && parent !== subjectId) return
    if (raw.promotedMetadata) return
    const note = raw.note_tweet?.note_tweet_results?.result
    const text = note?.text ?? note?.richtext?.text ?? legacy.full_text
    if (typeof text !== 'string') unusable()
    const publishedAt = typeof legacy.created_at === 'string' ? new Date(legacy.created_at) : null
    if (publishedAt && !Number.isFinite(publishedAt.getTime())) unusable()
    const user = raw.core?.user_results?.result, author = object(user?.legacy) ? user.legacy : {}, core = user?.core ?? {}
    const authorName = author.name ?? core.name, authorHandle = author.screen_name ?? core.screen_name
    const avatar = author.profile_image_url_https ?? author.profile_image_url ?? user?.avatar?.image_url
    const handle = typeof authorHandle === 'string' ? authorHandle : null
    if (conversationId) roots.add(conversationId)
    if (roots.size > 1) unusable()
    seen.add(commentId)
    comments.push({ raw, values: { commentId, text, publishedAt: publishedAt?.toISOString() ?? null,
      publishedTime: typeof legacy.created_at === 'string' ? legacy.created_at : null, conversationId,
      author: { id: id(user?.rest_id ?? author.id_str), name: typeof authorName === 'string' ? authorName : null,
        avatarUrl: typeof avatar === 'string' ? avatar : null, handle },
      authorHandle: handle, parentExternalId: parent,
      parentCommentId: parent && parent !== conversationId ? parent : null,
      parentRelationship: !parent || !conversationId ? 'unknown' : parent === conversationId ? 'post' : 'comment',
      url: `https://x.com/i/status/${commentId}`, likes: count(legacy.favorite_count), replies: count(legacy.reply_count),
      metrics: { shares: count(legacy.retweet_count), views: count(raw.views?.count),
        bookmarks: count(legacy.bookmark_count), quotes: count(legacy.quote_count) },
    } })
  }
  function entry(row) {
    if (!object(row) || !object(row.content)) unusable()
    const content = row.content
    if (content.cursorType === 'Bottom') {
      if (typeof content.value !== 'string' || content.value.length > 8192 || content.value.includes('\0')) unusable()
      bottom = content.value || null
      return
    }
    if (typeof row.entryId === 'string' && row.entryId.startsWith('conversationthread-')) {
      if (!Array.isArray(content.items) || content.items.length > 1000) unusable()
      for (const child of content.items) append(child?.item?.itemContent, true)
    } else if (typeof row.entryId === 'string' && row.entryId.startsWith('tweet-')) append(content.itemContent, false)
  }
  for (const instruction of instructions) {
    if (!object(instruction)) unusable()
    if (instruction.type === 'TimelineAddEntries') {
      if (!Array.isArray(instruction.entries) || instruction.entries.length > 1000) unusable()
      for (const row of instruction.entries) entry(row)
    } else if (instruction.type === 'TimelineReplaceEntry') entry(instruction.entry)
    // The official TweetDetail sample includes this metadata-only instruction.
    // Other instructions (notably AddToModule) can carry paid business rows,
    // but have no reviewed replies layout yet. Preserve their archive and fail
    // instead of publishing a silently truncated or falsely exhausted page.
    else if (instruction.type !== 'TimelineClearCache'
      || Object.keys(instruction).some(key => !['type', '__typename'].includes(key))) unusable()
  }
  // Official pagination stops on absent/repeated Bottom cursors or pages with
  // no business entries. Never buy extra pages to fill Hub's requested count.
  const repeated = bottom && bottom === continuation?.cursor
  const nextParams = comments.length && bottom && !repeated ? { cursor: bottom } : null
  return { comments, conversationId: [...roots][0] ?? null,
    providerPage: { hasMore: Boolean(nextParams), nextParams, nextPage: null,
      ...(repeated ? { stopReason: 'continuation_repeated' } : {}) } }
}
