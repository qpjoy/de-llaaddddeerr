// Import-free so saved restricted archives can use the same reviewed parser.
// Derived from Twitter AIO / TwittrAPI's documented TweetDetail raw layout:
// https://www.twittrapi.com/docs/reference/tweet-tweetid-replies
// https://www.twittrapi.com/docs/reference/tweet-tweetid
// The raw TweetDetail sample includes the focal tweet and reply modules. It is
// also the documented layout of /replies (without focal/ancestor context).
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
  const entries = []
  for (const instruction of instructions) {
    if (!object(instruction)) unusable()
    if (instruction.type === 'TimelineAddEntries') {
      if (!Array.isArray(instruction.entries) || instruction.entries.length > 1000) unusable()
      entries.push(...instruction.entries)
    } else if (instruction.type === 'TimelineReplaceEntry') entries.push(instruction.entry)
    // The official TweetDetail sample includes this metadata-only instruction.
    // Unknown instructions can contain paid rows: fail rather than silently
    // truncate the page. Their complete response remains in the raw archive.
    else if (instruction.type !== 'TimelineClearCache'
      || Object.keys(instruction).some(key => !['type', '__typename'].includes(key))) unusable()
  }
  function rawTweet(itemContent) {
    if (!object(itemContent)) unusable()
    if (itemContent.promotedMetadata) return null
    const result = itemContent.tweet_results?.result
    if (!object(result)) {
      if (itemContent.itemType === 'TimelineTweet') unusable()
      return null
    }
    const raw = result.__typename === 'TweetWithVisibilityResults' ? result.tweet : result
    // Unavailable/deleted tweets are not fabricated into empty comments.
    if (!object(raw)) unusable()
    if (['TweetTombstone', 'TweetUnavailable'].includes(raw.__typename) || raw.promotedMetadata) return null
    return raw
  }
  // TweetDetail's top-level tweet entries contain the focal tweet and its
  // ancestors. Establish that context before reading modules: entry order is
  // presentation metadata, not proof that an earlier row is an ancestor.
  const contextTweets = new Map()
  for (const row of entries) {
    if (!object(row) || !object(row.content)) unusable()
    if (typeof row.entryId !== 'string' || !row.entryId.startsWith('tweet-')) continue
    const raw = rawTweet(row.content.itemContent)
    if (!raw) continue
    const tweetId = id(raw.rest_id ?? raw.legacy?.id_str)
    if (row.entryId === `tweet-${subjectId}` && tweetId !== subjectId) unusable()
    if (tweetId) contextTweets.set(tweetId, raw)
  }
  const focal = contextTweets.get(subjectId), focalRoot = id(focal?.legacy?.conversation_id_str)
  const ancestors = new Set()
  let ancestor = id(focal?.legacy?.in_reply_to_status_id_str)
  while (ancestor) {
    if (ancestor === subjectId || ancestors.has(ancestor)) unusable()
    ancestors.add(ancestor)
    ancestor = id(contextTweets.get(ancestor)?.legacy?.in_reply_to_status_id_str)
  }
  if (focalRoot) roots.add(focalRoot)

  function append(itemContent, inConversation) {
    const raw = rawTweet(itemContent)
    if (!raw) return
    const legacy = raw.legacy, commentId = id(raw.rest_id ?? legacy?.id_str)
    if (!object(legacy) || !commentId || legacy.id_str != null && legacy.id_str !== commentId) unusable()
    const conversationId = id(legacy.conversation_id_str), parent = id(legacy.in_reply_to_status_id_str)
    if (legacy.conversation_id_str != null && !conversationId || legacy.in_reply_to_status_id_str != null && !parent) unusable()
    if (commentId === subjectId || commentId === conversationId || ancestors.has(commentId) || seen.has(commentId)) return
    // A flat detail timeline also includes ancestors and recommendations. Only
    // explicit direct replies establish membership outside conversation modules.
    if (!inConversation && parent !== subjectId) return
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
  for (const row of entries) entry(row)
  // Official pagination stops on absent/repeated Bottom cursors or pages with
  // no business entries. Never buy extra pages to fill Hub's requested count.
  const repeated = bottom && bottom === continuation?.cursor
  const nextParams = comments.length && bottom && !repeated ? { cursor: bottom } : null
  return { comments, conversationId: [...roots][0] ?? null,
    providerPage: { hasMore: Boolean(nextParams), nextParams, nextPage: null,
      ...(repeated ? { stopReason: 'continuation_repeated' } : {}) } }
}
