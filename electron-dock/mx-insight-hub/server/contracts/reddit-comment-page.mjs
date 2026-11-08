// Import-free so the same parser can verify a saved, hash-checked Admin archive.
// Verified contract from usage 7eb265f4-5c2c-4d15-91d5-7dc7fed83b61:
// all three saved terminal Comment trees passed this same parser against the
// saved request target before integration into the runtime projector.
// With { rootCommentId } the page is one comment's hidden replies: a placeholder
// under that comment continues it, and depth-0 rows are not post comments.
export function parseTikHubRedditCommentPage(payload, postId, continuation = null, { rootCommentId = null } = {}) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.includes('\0') ? value : null
  const postIdentity = value => typeof value === 'string' && /^(?:t3_)?[a-z0-9]{1,17}$/u.test(value)
    ? value.replace(/^t3_/u, '') : null
  const commentIdentity = value => typeof value === 'string' && /^(?:t1_)?[a-z0-9]{1,17}$/u.test(value)
    ? `t1_${value.replace(/^t1_/u, '')}` : null
  const count = value => Number.isSafeInteger(value) && value >= 0
  const unusable = (reason = 'invalid_envelope') => {
    const error = new Error('invalid_upstream_contract')
    error.code = 'invalid_upstream_contract'
    error.reason = reason
    throw error
  }
  const url = value => {
    try {
      const parsed = new URL(value)
      return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : null
    } catch { return null }
  }
  const root = postIdentity(postId), post = payload?.data?.postInfoById, forest = post?.commentForest
  if (!object(payload) || payload.code !== 200) unusable()
  if (!root || !object(post) || postIdentity(post.id) !== root) unusable('root_id_mismatch')
  if (!object(forest) || !Array.isArray(forest.trees) || forest.trees.length > 1000) unusable('forest_shape')
  if (forest.pageInfo != null && !object(forest.pageInfo)) unusable('pagination_shape')
  if (continuation != null && !object(continuation)) unusable('continuation_shape')
  const moreFlag = forest.pageInfo?.hasNextPage
  if (moreFlag != null && typeof moreFlag !== 'boolean') unusable('pagination_shape')
  if (forest.pageInfo?.commentCount != null && !count(forest.pageInfo.commentCount)) unusable('pagination_shape')

  // Unknown nested reply placeholders must not turn into a false exhausted
  // result. Preserve them in raw; do not guess their IDs or expand their URLs.
  let inspectedNodes = 0
  function hiddenMore(value, depth = 0) {
    if (++inspectedNodes > 30000 || depth > 24) unusable('structure_limit')
    if (!object(value) && !Array.isArray(value)) return false
    let found = false
    for (const [key, child] of Object.entries(value)) {
      if (key === 'more' && child != null && child !== false && child !== '') found = true
      if (object(child) || Array.isArray(child)) found = hiddenMore(child, depth + 1) || found
    }
    return found
  }

  const comments = [], children = new Map(), childCounts = new Map(), replyCursors = new Map()
  let unresolved = false, nextCursor = null
  // Only the declared fetch_comment_replies cursor form (^commenttree:) counts.
  const moreCursor = more => typeof more?.cursor === 'string' && /^commenttree:/u.test(more.cursor) && more.cursor.length <= 4096 && !more.cursor.includes('\0') ? more.cursor : null
  for (const tree of forest.trees) {
    if (!object(tree) || !count(tree.childCount) || !count(tree.depth)
      || tree.more != null && !object(tree.more)) unusable('tree_shape')
    unresolved = hiddenMore(tree) || unresolved
    if (tree.node === null && object(tree.more)) {
      // Live pages 2026-11-07: a depth-0 placeholder without parent loads the
      // next batch of top-level comments (fetch_comment_replies, same forest
      // shape); a placeholder under t1_ loads that comment's hidden replies.
      const cursor = moreCursor(tree.more)
      if (cursor && (rootCommentId ? commentIdentity(tree.parentId) === rootCommentId : tree.depth === 0 && tree.parentId == null)) nextCursor = cursor
      else if (cursor && typeof tree.parentId === 'string' && commentIdentity(tree.parentId)) replyCursors.set(commentIdentity(tree.parentId), cursor)
      continue
    }
    const node = tree.node
    if (!object(node)) unusable('comment_node')
    // A post context entry is never a comment. Namespaces distinguish a real
    // t1 comment from a t3 post even if their base36 suffixes happen to match.
    if (postIdentity(node.id) === root && (node.id.startsWith('t3_') || node.__typename !== 'Comment')) continue
    const commentId = commentIdentity(node.id), user = node.authorInfo
    const publishedAt = typeof node.createdAt === 'string' ? new Date(node.createdAt) : null
    if (node.__typename !== 'Comment') unusable('comment_type')
    if (!commentId) unusable('comment_identity')
    if (!object(node.content) || typeof node.content.markdown !== 'string') unusable('comment_text')
    if (!object(user) || !text(user.id) || typeof user.name !== 'string') unusable('author_identity')
    if (!publishedAt || !Number.isFinite(publishedAt.getTime())) unusable('comment_time')
    if (node.isScoreHidden != null && typeof node.isScoreHidden !== 'boolean'
      || node.isRemoved != null && typeof node.isRemoved !== 'boolean'
      || node.score != null && !Number.isSafeInteger(node.score)) unusable('comment_metrics')

    let parentExternalId = null, parentCommentId = null, parentRelationship = 'unknown'
    if (tree.parentId != null) {
      if (postIdentity(tree.parentId) === root) {
        parentExternalId = postId
        parentRelationship = 'post'
      } else if (typeof tree.parentId === 'string' && tree.parentId.startsWith('t1_') && commentIdentity(tree.parentId)) {
        parentExternalId = parentCommentId = commentIdentity(tree.parentId)
        parentRelationship = 'comment'
        if (parentCommentId === commentId) unusable('parent_identity')
        if (!children.has(parentCommentId)) children.set(parentCommentId, new Set())
        children.get(parentCommentId).add(commentId)
      } else unusable('parent_identity')
    }
    // permalink is optional evidence. Only expose a Reddit URL whose post and
    // comment suffix match this row, never an unrelated supplied destination.
    let permalink = null
    if (node.permalink != null) {
      if (typeof node.permalink !== 'string' || node.permalink.length > 4096) unusable('comment_url')
      try {
        const parsed = new URL(node.permalink, 'https://www.reddit.com')
        const match = parsed.pathname.match(/\/comments\/([a-z0-9]+)\/[^/]*\/([a-z0-9]+)(?:\/|$)/u)
        if (!['reddit.com', 'www.reddit.com', 'old.reddit.com', 'm.reddit.com'].includes(parsed.hostname)
          || !url(parsed.href) || parsed.port || !match || match[1] !== root || commentIdentity(match[2]) !== commentId) unusable('comment_url')
        permalink = parsed.href
      } catch { unusable('comment_url') }
    }
    childCounts.set(commentId, Math.max(childCounts.get(commentId) || 0, tree.childCount))
    comments.push({ raw: tree, values: { commentId, text: node.content.markdown, publishedAt: publishedAt.toISOString(),
      publishedTime: node.createdAt, author: { id: user.id, name: user.name, avatarUrl: url(user.iconSmall?.url) },
      likes: null, replies: tree.childCount, metrics: { score: node.isScoreHidden === true ? null : node.score ?? null },
      parentExternalId, parentCommentId, parentRelationship, url: permalink,
      ...(typeof node.isRemoved === 'boolean' ? { isRemoved: node.isRemoved } : {}) } })
  }
  for (const [commentId, expected] of childCounts) if (expected > (children.get(commentId)?.size || 0) && !replyCursors.has(commentId)) unresolved = true
  for (const row of comments) { const cursor = replyCursors.get(row.values.commentId); if (cursor) row.values.replyCursor = cursor }
  // `after` is never used for continuation; only the top-level placeholder's
  // cursor (sent to fetch_comment_replies) continues this post's comments.
  const nextParams = nextCursor && ![continuation?.cursor, continuation?.after].includes(nextCursor) ? { cursor: nextCursor } : null
  const terminal = !nextParams && moreFlag === false && !unresolved
  return { comments, providerPage: { hasMore: nextParams ? true : terminal ? false : null, nextParams, nextPage: null,
    ...(!nextParams && !terminal ? { stopReason: 'continuation_unproven' } : {}) } }
}
