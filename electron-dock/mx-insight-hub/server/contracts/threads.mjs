// Threads supplier pages projected onto Hub's existing row shapes.
//
// RapidAPI's threads-api4 relays Threads' own GraphQL pages; its structure was
// calibrated from the listing's public example responses on 2026-11-11, because
// the key available at the time was not subscribed. TikHub's Threads endpoints
// wrap the same post objects in their own envelope (threads / results /
// comments), described by its official OpenAPI text. Neither was checked with a
// live paid page: inspect the first production page after enabling a supplier.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (...values) => values.find(value => typeof value === 'string' && value.trim())?.trim() || ''
const numericId = value => typeof value === 'string' && /^\d{1,30}$/u.test(value) ? value
  : Number.isSafeInteger(value) && value > 0 ? String(value) : null
const count = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
const fail = reason => { throw new Error(`invalid_threads_response:${reason}`) }

export const THREADS_WEB_ORIGIN = 'https://www.threads.com'
const SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

// Post URLs carry a shortcode that encodes the numeric ID the suppliers need,
// so resolving a link costs no paid lookup.
export function threadsPostId(value) {
  if (typeof value !== 'string' && !Number.isSafeInteger(value)) return null
  const input = String(value).trim()
  const numeric = /^(\d{1,30})(?:_\d{1,30})?$/u.exec(input)
  if (numeric) return numeric[1]
  if (!/^[A-Za-z0-9_-]{1,16}$/u.test(input)) return null
  let id = 0n
  for (const char of input) id = id * 64n + BigInt(SHORTCODE_ALPHABET.indexOf(char))
  return id > 0n && id <= 18446744073709551615n ? String(id) : null
}

function roots(payload) {
  const found = [payload]
  for (let index = 0; index < 4 && object(found.at(-1)?.data); index++) found.push(found.at(-1).data)
  return found.reverse()
}

// Suppliers report a refusal inside an HTTP 200 body; never read that as "no results".
function assertSucceeded(payload) {
  if (!object(payload)) fail('not_object')
  for (const root of roots(payload)) {
    if (Array.isArray(root.errors) && root.errors.length) fail('errors')
    if (typeof root.status === 'string' && root.status !== 'ok') fail('status')
  }
}

const CONTAINERS = ['searchResults', 'mediaData', 'xdt_api__v1__users__search_connection']
const LISTS = ['edges', 'threads', 'results', 'comments', 'items', 'users']

// One page's entries and its page_info, wherever the supplier nested them.
function pageEntries(payload) {
  assertSucceeded(payload)
  for (const root of roots(payload)) {
    for (const candidate of [...CONTAINERS.map(name => root[name]), root]) {
      if (!object(candidate)) continue
      const list = LISTS.find(name => Array.isArray(candidate[name]))
      if (list) return { entries: candidate[list], pageInfo: object(candidate.page_info) ? candidate.page_info : null }
    }
  }
  fail('no_collection')
}

// A thread entry is one or more posts: a self-thread, or a parent and its reply.
function threadPosts(entry) {
  if (!object(entry)) fail('entry')
  const node = object(entry.node) ? entry.node : entry
  const thread = object(node.thread) ? node.thread : node
  if (Array.isArray(thread.thread_items)) return thread.thread_items.map(item => object(item?.post) ? item.post : item).filter(object)
  if (object(node.post)) return [{ ...node.post, user: node.post.user ?? node.user }]
  return [node]
}

function relationshipId(media) {
  if (media?.id == null) return null
  const id = numericId(media.id)
  if (!id) fail('comment_relationship_id')
  return id
}

const postPk = post => numericId(post.pk) ?? numericId(typeof post.id === 'string' ? post.id.split('_')[0] : post.id)
const best = list => Array.isArray(list) ? list.find(item => typeof item?.url === 'string' && item.url)?.url ?? null : null
const imageOf = media => best(media?.image_versions2?.candidates)
const videoOf = media => best(media?.video_versions)

function postMedia(post) {
  const parts = Array.isArray(post.carousel_media) && post.carousel_media.length ? post.carousel_media.filter(object) : [post]
  const videos = parts.map(videoOf).filter(Boolean)
  // A video's image candidates are its poster, not a separate picture.
  const images = parts.filter(part => !videoOf(part)).map(imageOf).filter(Boolean)
  return { images, videos, cover: imageOf(parts[0]) }
}

function postText(post) {
  const fragments = post.text_post_app_info?.text_fragments?.fragments
  return text(post.caption?.text, post.text,
    Array.isArray(fragments) ? fragments.map(row => row?.plaintext).filter(value => typeof value === 'string').join('') : '')
}

const postUrl = (post, username) => typeof post.code === 'string' && post.code && username
  ? `${THREADS_WEB_ORIGIN}/@${encodeURIComponent(username)}/post/${encodeURIComponent(post.code)}` : null
const postTime = post => {
  const time = typeof post.taken_at === 'number' ? new Date(post.taken_at * 1000) : null
  return time && Number.isFinite(time.getTime()) ? time.toISOString() : null
}

// The flat row shared by content search and account content, using the field
// names the other platforms' rows already expose to callers.
export function threadsPostRow(post, capturedAt) {
  const id = postPk(post)
  if (!id) fail('post_identity')
  const user = object(post.user) ? post.user : {}, info = object(post.text_post_app_info) ? post.text_post_app_info : {}
  const authorId = numericId(user.pk) ?? numericId(user.id), username = text(user.username)
  const body = postText(post), url = postUrl(post, username), publishedAt = postTime(post)
  const { images, videos, cover } = postMedia(post)
  const likes = count(post.like_count), replies = count(info.direct_reply_count), reposts = count(info.repost_count)
  return { id, content_id: id, external_id: id, platform_name: 'threads', content_type: 'post', source_type: 'post',
    title: '', text: body, full_text: body, content: body, url, original_url: url,
    created_at: publishedAt, published_at: publishedAt, collected_at: capturedAt,
    author_id: authorId, author_name: text(user.full_name, username), author_username: username || null, user_name: username,
    author_avatar_url: text(user.profile_pic_url) || null, profile_image_url: text(user.profile_pic_url) || null,
    like_count: likes, comment_count: replies, reply_count: replies, share_count: reposts, forward_count: reposts,
    quote_count: count(info.quote_count), view_count: null, bookmark_count: null, collect_count: null,
    cover_url: cover, image_urls: JSON.stringify(images), video_urls: JSON.stringify(videos),
    media: { images: images.map(value => ({ url: value, type: 'image' })), videos: videos.map(value => ({ url: value, playUrl: value })) },
    metadata: JSON.stringify({ code: typeof post.code === 'string' ? post.code : null, isReply: info.is_reply === true,
      replyToUsername: typeof info.reply_to_author?.username === 'string' ? info.reply_to_author.username : null }) }
}

// TikHub documents no continuation. RapidAPI can prove exhaustion with an
// explicit false; missing metadata or a broken cursor cannot prove it.
export function threadsContinuation(pageInfo, provider, currentCursor) {
  if (provider === 'tikhub' || pageInfo?.has_next_page === false) return { hasMore: false, nextParams: null, nextPage: null }
  const next = pageInfo?.end_cursor
  if (pageInfo?.has_next_page !== true || typeof next !== 'string' || !next.trim() || next.length > 8192 || next.includes('\0')) {
    return { hasMore: null, nextParams: null, nextPage: null }
  }
  if (next === currentCursor) return { hasMore: null, nextParams: null, nextPage: null, stopReason: 'repeated_cursor' }
  return { hasMore: true, nextParams: { end_cursor: next }, nextPage: null }
}

const distinct = rows => [...new Map(rows.map(row => [row.content_id, row])).values()]

export function parseThreadsSearchPage(payload, { provider, currentCursor = null, capturedAt }) {
  const { entries, pageInfo } = pageEntries(payload)
  // Later items of a thread are the author's continuation, not search matches.
  const rows = distinct(entries.map(entry => threadPosts(entry)[0]).filter(object).map(post => threadsPostRow(post, capturedAt)))
  return { rows, providerPage: threadsContinuation(pageInfo, provider, currentCursor) }
}

// The replies timeline pairs each reply with the post it answers. A self-thread
// is several posts by the same author; other accounts' posts are never its content.
export function parseThreadsAccountPage(payload, { activityType, ownerId, provider, currentCursor = null, capturedAt }) {
  const { entries, pageInfo } = pageEntries(payload)
  const posts = entries.flatMap(entry => {
    const items = threadPosts(entry)
    if (activityType === 'reposts') return items.slice(0, 1)
    const own = items.filter(post => String(post.user?.pk ?? post.user?.id) === String(ownerId))
    return activityType === 'replies'
      ? own.filter(post => post.text_post_app_info?.is_reply === true || items.indexOf(post) > 0) : own
  })
  const owner = posts.map(post => post.user).find(user => object(user) && String(user.pk ?? user.id) === String(ownerId)) ?? null
  return { rows: distinct(posts.map(post => threadsPostRow(post, capturedAt))), owner,
    providerPage: threadsContinuation(pageInfo, provider, currentCursor) }
}

export function parseThreadsProfiles(payload) {
  const { entries } = pageEntries(payload)
  return entries.filter(object).map(entry => object(entry.node) ? entry.node : object(entry.user) ? entry.user : entry)
}

// A post page lists the post itself (and, for a reply, its ancestors) before the
// replies, so the entry holding the target is skipped. Follow-up items inside
// an entry are that reply's own thread, not first-level comments.
export function parseThreadsCommentPage(payload, targetId, { provider, currentCursor = null, contentId = null }) {
  assertSucceeded(payload)
  const rapid = provider === 'rapidapi'
  if (!rapid && (provider !== 'tikhub' || payload.code !== 200)) fail('comment_provider')
  // The RapidAPI fixture uses root data.data.edges. TikHub documents a
  // comments-only list; it need not echo the target post in the first row.
  const field = rapid ? 'edges' : 'comments'
  const connection = roots(payload).find(root => Array.isArray(root[field]))
  if (!connection) fail('comment_collection')
  const groups = connection[field].map(entry => ({ posts: threadPosts(entry), focus: rapid ? numericId(entry.node?.id) : null }))
  if (rapid && !currentCursor && groups.length) {
    const { posts, focus } = groups[0]
    if ((focus && focus !== targetId) || !posts.some(post => postPk(post) === targetId)) fail('comment_target')
  }
  // Meta's Get Threads Replies example identifies the direct parent with
  // replied_to.id and the conversation root with root_post.id. The supplier
  // examples omit those optional fields. A handle alone cannot prove a post ID.
  const ancestors = new Set(), rootsSeen = new Set()
  let targetHandle = null, targetIsReply = false
  for (const { posts, focus } of groups) {
    const targetIndex = posts.findIndex(post => postPk(post) === targetId)
    if (targetIndex < 0 || (focus && focus !== targetId)) continue
    const target = posts[targetIndex]
    if (typeof target.user?.username === 'string') targetHandle = target.user.username.toLowerCase()
    const parent = relationshipId(target.replied_to)
    if (parent) ancestors.add(parent)
    const root = relationshipId(target.root_post)
    if (root) rootsSeen.add(root)
    if (targetIndex > 0 || parent || (root && root !== targetId) || target.is_reply === true || target.text_post_app_info?.is_reply === true) {
      targetIsReply = true
    }
    for (const ancestor of posts.slice(0, targetIndex)) ancestors.add(postPk(ancestor))
    for (const post of posts.slice(0, targetIndex + 1)) {
      if (post.is_reply === false || post.text_post_app_info?.is_reply === false) rootsSeen.add(postPk(post))
    }
  }
  const comments = groups.flatMap(({ posts, focus }) => {
    const index = focus ? posts.findIndex(post => postPk(post) === focus) : 0
    const post = posts[index]
    if (!object(post)) fail('comment_identity')
    const commentId = postPk(post)
    if (!commentId) fail('comment_identity')
    if (commentId === targetId || ancestors.has(commentId)) return []
    const parent = relationshipId(post.replied_to)
    if (commentId === contentId) {
      if (parent === targetId) fail('comment_root')
      return []
    }
    const user = object(post.user) ? post.user : {}, username = text(user.username), info = object(post.text_post_app_info) ? post.text_post_app_info : {}
    if ((parent && parent !== targetId) || (index > 0 && postPk(posts[index - 1]) !== targetId)
      || post.is_reply === false || info.is_reply === false
      || (targetHandle && typeof info.reply_to_author?.username === 'string' && info.reply_to_author.username.toLowerCase() !== targetHandle)) fail('comment_parent')
    const root = relationshipId(post.root_post)
    // A continuation or a comments-only list may have no target context. If
    // this row explicitly belongs to another conversation, its ancestry must
    // establish why it can still be a direct reply to the requested post.
    if (!contentId && root && root !== targetId && !targetIsReply && parent !== targetId && index === 0) fail('comment_root')
    if (root) rootsSeen.add(root)
    const { images, videos } = postMedia(post)
    return [{ raw: post, values: { commentId, text: postText(post), url: postUrl(post, username), publishedAt: postTime(post),
      author: { id: numericId(user.pk) ?? numericId(user.id), name: text(user.full_name, username) || null,
        avatarUrl: text(user.profile_pic_url) || null, handle: username || null },
      authorHandle: username || null, parentCommentId: null, likes: post.like_count, replies: info.direct_reply_count,
      metrics: { shares: count(info.repost_count), quotes: count(info.quote_count), views: null, bookmarks: null },
      media: [...images.map(value => ({ url: value, type: 'image' })), ...videos.map(value => ({ url: value, type: 'video' }))] } }]
  })
  if (rootsSeen.size > 1 || (contentId && rootsSeen.size && !rootsSeen.has(contentId) && !ancestors.has(contentId))) fail('comment_root')
  const unique = [...new Map(comments.map(row => [row.values.commentId, row])).values()]
  return { comments: unique, providerPage: threadsContinuation(connection.page_info, provider, currentCursor) }
}
