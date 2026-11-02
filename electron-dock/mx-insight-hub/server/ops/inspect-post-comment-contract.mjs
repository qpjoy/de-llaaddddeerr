import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

// Standalone for node --input-type=module - in the Admin image. Only Node and
// pg are needed; importing the Hub runtime could initialize live acquisitions.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SHA = /^[0-9a-f]{64}$/u
const MAX_BYTES = 4 * 1024 * 1024
const MAX_CALLS = 3
const MAX_NODES = 2048
const MAX_DEPTH = 18
const ARRAY_SAMPLE = 3
const PLATFORMS = ['twitter', 'reddit', 'xiaohongshu', 'instagram', 'weibo', 'kuaishou', 'douyin', 'tiktok', 'zhihu', 'linkedin', 'bilibili', 'facebook', 'youtube']
const TWITTER_ID = /^[0-9]{1,30}$/u
const ENDPOINTS = new Map([
  ['t.api_3cd88a6621a01120', 'twitter'], ['t.api_e85913faa8a9029b', 'twitter'],
  ['t.api_c7f50cf300d63960', 'reddit'], ['t.api_e0a2654e9c191a80', 'reddit'],
  ['t.api_327bbf0cae41de55', 'xiaohongshu'], ['t.api_a73099aa86339bcd', 'xiaohongshu'],
  ['t.api_4167d40172ce25ef', 'instagram'], ['t.api_4896d158e6531d9a', 'instagram'],
  ['t.api_a731f338e761b83d', 'instagram'], ['t.api_6e1e36a528c640f0', 'instagram'],
  ['t.api_631f7f6fd007cba9', 'weibo'], ['t.api_11c128f19504d074', 'weibo'], ['t.api_ac75edddcf5bb304', 'weibo'],
  ['t.api_3cb972ba91c8fe44', 'kuaishou'], ['t.api_114d6681f5418d50', 'kuaishou'],
  ['t.api_bc64c9d98dbf724c', 'kuaishou'], ['t.api_f973535c4b9eb212', 'kuaishou'],
  ['t.api_66d197a7b49540e0', 'douyin'], ['t.api_c4ad87355da7b05b', 'douyin'],
  ['t.api_7a24a4d8dc7fb54a', 'douyin'], ['t.api_dc6671ca374a2b50', 'douyin'],
  ['t.api_3de44b8d36948304', 'tiktok'], ['t.api_e48e80353b6ea227', 'tiktok'],
  ['t.api_b5754058e6bb3788', 'tiktok'], ['t.api_855e0a66a0445413', 'tiktok'],
  ['t.api_6a6b1264eaeadebe', 'zhihu'], ['t.api_34e4e3b6f5f6bd08', 'zhihu'], ['t.api_e600b5687771bb94', 'zhihu'],
  ['t.api_3d411f1de502487a', 'linkedin'],
  ['t.api_98678099e0d97c80', 'bilibili'], ['t.api_6804f428149d7463', 'bilibili'], ['t.api_a220bb02f7703d52', 'bilibili'],
  ['t.api_4a6f21264dc0b4a1', 'youtube'], ['t.api_3157845728b61b99', 'youtube'],
  ['t.api_17b46693b61cac46', 'youtube'], ['t.api_057e82b4a9f1f864', 'youtube'],
  ['j.api_bcedccd1a73cc8f2', 'twitter'], ['j.api_9f1806a48fde0794', 'reddit'],
  ['j.api_68e20c179ed05353', 'xiaohongshu'], ['j.api_c76bf22b2bd6bb8c', 'xiaohongshu'],
  ['j.api_73ecd0cbee82a704', 'instagram'], ['j.api_26a06d53682a6436', 'instagram'],
  ['j.api_19390f4ea0fef847', 'weibo'], ['j.api_e0c0bbd6b8e0784c', 'kuaishou'],
  ['j.api_cfe7c89d64177567', 'douyin'], ['j.api_04007fb4086c8339', 'douyin'],
  ['j.api_9302e45524da8400', 'tiktok'], ['j.api_fb885a90fa0de5f7', 'tiktok'],
  ['j.api_b221354f6d520f65', 'zhihu'], ['j.api_1fe06da16a2084a6', 'zhihu'],
  ['j.api_c8002ed17df8381a', 'linkedin'], ['j.api_f5a166f0a03822f8', 'bilibili'],
  ['j.api_471d1e0392427a79', 'facebook'], ['j.api_bfbd0dbef00c6edf', 'facebook'],
  ['j.api_524acfcc9a583248', 'youtube'], ['j.api_7e174f644bd5536b', 'youtube'],
].map(([key, platform]) => [`native.${key}`, { provider: key.startsWith('t.') ? 'tikhub' : 'justone', platform }]))
ENDPOINTS.set('xiaohongshu.app-v2.note-comments.v1', { provider: 'tikhub', platform: 'xiaohongshu' })

// Unknown keys use anonymous aliases, including when traversing their children.
// Explicit Twitter shape inspection additionally lists schema-like keys directly
// on a recognized $.data tweet object. It never lists dynamic nested map keys.
// Scalar strings/numbers (IDs, text, URLs, cursors) are never returned.
const KEYS = new Set(`code status status_code success message msg data result results response business_data
  comments comment comment_list commentList list items rows edges node nodes children replies reply sub_comments subComments
  sub_comment_list sub_comment_count subCommentCount comment_count commentCount reply_count replyCount total total_count count
  id id_str cid comment_id commentId content_id contentId post_id postId tweet_id tweetId aweme_id item_id note_id video_id
  root_id rootId parent_id parentId reply_id replyId parent_comment_id parentCommentId reply_to_comment_id rpid oid bvid aid
  text full_text content body desc message title description text_raw rich_text contentText comment_text commentText
  user user_info userInfo author author_info authorInfo owner member profile user_results user_result core legacy rest_id
  uid user_id userId userid unique_id sec_uid nickname nick_name name username screen_name display_name displayName
  mid uname avatar avatar_url avatarUrl avatar_thumb profile_image_url_https profile_url url link permalink
  create_time createTime created_at createdAt created_time created_time_utc published_at publishedAt published_time publishedTime
  time timestamp ctime created_utc date duration datePublished date_created
  like_count likeCount likes digg_count diggCount reply_count replyCount replies_count repliesCount child_comment_count
  sub_comment_count subCommentCount favorite_count retweet_count quote_count reply_count bookmark_count score ups downs reactions reaction_count
  stats statistics metrics vote_count votes upvote_count upvotes like_num likes_count likedCount
  has_more hasMore has_next hasNext more hasNextPage hasPreviousPage is_end isEnd is_last isLast
  cursor next_cursor nextCursor cursor_type cursorType max_id max_id_type since_id next_max_id min_id pcursor
  continuation_token continuationToken continuation next next_page nextPage next_url nextUrl next_offset offset page page_size pageSize
  page_info pageInfo paging pagination end_cursor endCursor start_cursor startCursor after before index pageArea
  sort sort_by sortBy total_pages totalPages is_empty isEmpty
  data_type kind type __typename result_type typename entryType itemType
  threaded_conversation_with_injections_v2 timeline instructions entries entryId sortIndex item itemContent items
  tweet_results tweetResult tweet result content displayType moduleItems moduleEntryId cursor value bottom top
  conversation_id_str in_reply_to_status_id_str in_reply_to_user_id_str quoted_status_result
  visionCommentList rootComments hotComments authorId authorName headurl headUrl commentId timestamp likedCount subCommentCount
  feed_id photo_id photoId counts continuation_endpoint continuationEndpoint continuationCommand token
  publishedTimeText runs simpleText textDisplay textOriginal authorDisplayName authorChannelId authorProfileImageUrl
  authorText authorThumbnail thumbnails width height videoId commentRenderer commentThreadRenderer commentViewModel
  commentSurfaceEntityPayload engagementToolbar authorEndpoint browseEndpoint browseId navigationEndpoint
  endpoints contentPagination nextPageToken pageToken statusCode totalNumber total_count total_number
  pageInfo commentsCount comments_count media_id shortcode pk user_id_str comment_like_count edge_media_to_parent_comment
  edge_threaded_comments edge_liked_by edge_media_to_comment
  ok rootComment root postInfoById commentForest trees childCount depth markdown iconSmall favorites favorites_count
  conversation_id author_id author_name parentId prefixedName commenter created_datetime like_cnt comment_cnt
  pagination_token pagination_reply next_offset prev_cursor prevCursor subCommentsMap thread_urn thread_id
  rpid_str oid_str root_str parent_str mid_str idstr rootid rootidstr like dislike_count child_comments
  child_comment_next_offset reply_comment_id reply_root_comment_id url_list face sign icon images image_list pictures
  authorVerified isRemoved isInitiallyCollapsed isArchived isLocked isScoreHidden
  thread threads tweets reply_tweets reply_to reply_to_status_id reply_to_tweet_id replying_to
  in_reply_to_status_id in_reply_to_tweet_id in_reply_to_user_id inReplyToStatusId conversation
  quoted_tweet retweeted_tweet media entities extended_entities attachments urls photos videos`.split(/\s+/u).filter(Boolean))
const CONTINUATIONS = new Set(`cursor next_cursor nextCursor max_id since_id next_max_id pcursor continuation_token continuationToken
  continuation next next_page nextPage next_url nextUrl next_offset end_cursor endCursor after before token nextPageToken pageToken
  pagination_token pagination_reply prev_cursor prevCursor child_comment_next_offset`.split(/\s+/u))
const SIGNALS = new Set(`has_more hasMore has_next hasNext more hasNextPage hasPreviousPage is_end isEnd is_last isLast is_empty isEmpty`.split(/\s+/u))
const choice = (value, choices) => value == null ? null : choices.includes(value) ? value : 'other'
const status = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null
const hash = value => createHash('sha256').update(value).digest('hex')
const kind = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
const POST_IDS = new Set(`id id_str rest_id tweet_id tweetId post_id postId content_id contentId
  conversation_id conversation_id_str in_reply_to_status_id in_reply_to_status_id_str in_reply_to_tweet_id
  inReplyToStatusId reply_to_status_id reply_to_tweet_id parent_id parentId root_id rootId`.split(/\s+/u))
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const idRelation = (value, target) => value == null ? 'null' : typeof value === 'number' && !Number.isSafeInteger(value)
  ? 'unsafe_number' : typeof value !== 'string' && typeof value !== 'number' ? 'not_an_id'
    : String(value) === target ? 'same' : 'different'

export function summarizePostCommentPayload(payload, { twitterPostId = null } = {}) {
  if (twitterPostId !== null && (typeof twitterPostId !== 'string' || !TWITTER_ID.test(twitterPostId))) throw new Error('invalid_twitter_post_id')
  const fields = new Map()
  const unknownNames = new Map(), envelopeKeys = []
  const twitterEnvelope = twitterPostId !== null && object(payload?.data)
    && (typeof payload.data.id === 'string' || typeof payload.data.id === 'number')
    && typeof payload.data.text === 'string' && object(payload.data.author)
  let nodes = 0, unknownKeys = 0, truncated = false, sampledArrays = 0, observedArrays = 0
  function visit(value, path, key, depth) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) { truncated = true; return }
    const type = kind(value)
    if (!fields.has(path)) fields.set(path, { path, types: {}, observations: 0 })
    const entry = fields.get(path)
    entry.types[type] = (entry.types[type] || 0) + 1
    entry.observations++
    if (twitterPostId !== null && POST_IDS.has(key)) {
      const relation = idRelation(value, twitterPostId)
      entry.requestedPostRelation = { ...entry.requestedPostRelation, [relation]: (entry.requestedPostRelation?.[relation] || 0) + 1 }
    }
    if (CONTINUATIONS.has(key)) {
      const state = value == null ? 'null' : value === '' ? 'empty_string' : type === 'string' ? 'nonempty_string'
        : type === 'number' ? 'number' : type
      entry.continuation = { ...entry.continuation, [state]: (entry.continuation?.[state] || 0) + 1 }
    }
    if (SIGNALS.has(key) && (typeof value === 'boolean' || value === 0 || value === 1)) {
      const state = typeof value === 'boolean' ? String(value) : value === 0 ? 'zero' : 'one'
      entry.signals = { ...entry.signals, [state]: (entry.signals?.[state] || 0) + 1 }
    }
    if (Array.isArray(value)) {
      observedArrays++
      entry.arrayLength = { min: Math.min(entry.arrayLength?.min ?? value.length, value.length), max: Math.max(entry.arrayLength?.max ?? value.length, value.length) }
      if (value.length > ARRAY_SAMPLE) sampledArrays++
      for (const nested of value.slice(0, ARRAY_SAMPLE)) visit(nested, `${path}[]`, '', depth + 1)
    } else if (value && typeof value === 'object') {
      // JSON input cannot contain getters or cycles. Unknown containers must be
      // traversed too: skipping one could hide the entire comment list.
      for (const name of Object.keys(value)) {
        if (nodes >= MAX_NODES) { truncated = true; break }
        if (KEYS.has(name)) visit(value[name], `${path}.${name}`, name, depth + 1)
        else {
          unknownKeys++
          if (!unknownNames.has(name)) unknownNames.set(name, `[unknown${unknownNames.size + 1}]`)
          const anonymousPath = `${path}${unknownNames.get(name)}`
          if (twitterEnvelope && path === '$.data') envelopeKeys.push({ path: anonymousPath,
            name: /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(name) ? name : '[redacted]' })
          visit(value[name], anonymousPath, '', depth + 1)
        }
      }
    }
  }
  visit(payload, '$', '', 0)
  return { fields: [...fields.values()], unknownKeys, observedArrays, sampledArrays, arraySampleLimit: ARRAY_SAMPLE,
    ...(twitterPostId === null ? {} : { twitterShape: {
      comparisonTarget: 'operator_supplied_post_id',
      envelopeState: twitterEnvelope ? 'tweet_object' : 'unrecognized',
      unlistedEnvelopeKeys: envelopeKeys,
      rootIdRelation: twitterEnvelope ? idRelation(payload.data.id, twitterPostId) : 'missing',
      conversationIdRelation: twitterEnvelope && Object.hasOwn(payload.data, 'conversation_id')
        ? idRelation(payload.data.conversation_id, twitterPostId) : 'missing',
      repliesCountState: !twitterEnvelope || !Number.isSafeInteger(payload.data.replies) ? 'unknown'
        : payload.data.replies === 0 ? 'zero' : payload.data.replies > 0 ? 'positive' : 'negative',
    } }),
    truncated, boundary: 'Bounded structural samples, with anonymous paths for unknown keys. Explicit Twitter shape mode lists schema-like keys only on a recognized data tweet object and compares IDs to the operator-supplied post ID. No scalar payload string or numeric values are returned. Missing fields do not establish the complete response contract.' }
}

export function inspectPostCommentArchive(row, options) {
  if (!row || row.body_size == null) return { state: 'archive_missing' }
  if (row.body_size > MAX_BYTES || row.actual_body_size > MAX_BYTES) return { state: 'archive_too_large', maxBytes: MAX_BYTES }
  const bytes = row.body_bytes instanceof Uint8Array ? Buffer.from(row.body_bytes) : null
  if (!bytes || bytes.length !== row.body_size || bytes.length !== row.actual_body_size
    || !SHA.test(row.body_sha256 || '') || hash(bytes) !== row.body_sha256) return { state: 'archive_integrity_failed' }
  let payload
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { return { state: 'archive_not_json', hashVerified: true, byteLength: bytes.length } }
  return { state: 'archive_verified', hashVerified: true, byteLength: bytes.length, ...summarizePostCommentPayload(payload, options) }
}

export async function inspectPostCommentContract(pool, requestId, { twitterPostId = null } = {}) {
  if (!UUID.test(requestId || '')) throw new Error('invalid_request_id')
  if (twitterPostId !== null && (typeof twitterPostId !== 'string' || !TWITTER_ID.test(twitterPostId))) throw new Error('invalid_twitter_post_id')
  const client = await pool.connect()
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'")
    const { rows: usages } = await client.query(`SELECT /* post-comment-contract:usage */
      platform,status,response_status FROM public.usage_requests WHERE id=$1::uuid`, [requestId])
    if (usages.length !== 1) throw new Error('request_not_found')
    const { rows } = await client.query(`SELECT /* post-comment-contract:calls */
      id,provider_key,marketplace,endpoint_key,outcome,http_status,business_code,billed,error_code
      FROM external_platform.provider_calls WHERE usage_request_id=$1::uuid
      ORDER BY started_at,id LIMIT 4`, [requestId])
    const calls = []
    for (const [ordinal, row] of rows.slice(0, MAX_CALLS).entries()) {
      const endpoint = ENDPOINTS.get(row.endpoint_key)
      const recognized = endpoint?.provider === row.provider_key && endpoint?.platform === row.marketplace
      let archive = { state: 'unrecognized_comment_endpoint' }
      if (recognized) {
        const { rows: archives } = await client.query(`SELECT /* post-comment-contract:archive */
          r.body_size,r.body_sha256,octet_length(r.body_bytes) AS actual_body_size,
          CASE WHEN r.body_size <= $3::integer AND octet_length(r.body_bytes) <= $3::integer
            THEN r.body_bytes ELSE NULL END AS body_bytes
          FROM external_platform.provider_calls c
          LEFT JOIN control.external_platform_restricted_raw_responses r ON r.provider_call_id=c.id
          WHERE c.usage_request_id=$1::uuid AND c.id=$2::uuid`, [requestId, row.id, MAX_BYTES])
        archive = inspectPostCommentArchive(archives[0], row.provider_key === 'tikhub'
          && row.endpoint_key === 'native.t.api_3cd88a6621a01120' ? { twitterPostId } : undefined)
      }
      calls.push({ ordinal: ordinal + 1, provider: choice(row.provider_key, ['tikhub', 'justone', 'rapidapi']),
        platform: choice(row.marketplace, PLATFORMS), endpoint: recognized ? row.endpoint_key : 'other',
        outcome: choice(row.outcome, ['pending', 'succeeded', 'succeeded_unusable', 'rejected', 'unknown']),
        httpStatus: status(row.http_status), businessCode: [0, 200, 201, 302, 400, 401, 402, 403, 404, 429, 500, 601].includes(row.business_code) ? row.business_code : null,
        billed: typeof row.billed === 'boolean' ? row.billed : null,
        errorCode: choice(row.error_code, ['upstream_balance_exhausted', 'upstream_rate_limited', 'invalid_upstream_contract', 'upstream_rejected',
          'upstream_timeout', 'invalid_upstream_content_type', 'external_platform_response_unusable']), archive })
    }
    return { revision: 'post-comment-contract-inspection.v2', requestId,
      usage: { platform: choice(usages[0].platform, [...PLATFORMS, 'social', 'ecommerce']), status: choice(usages[0].status, ['reserved', 'committed', 'released', 'unknown']), httpStatus: status(usages[0].response_status) },
      calls, callsTruncated: rows.length > MAX_CALLS, callLimit: MAX_CALLS, nativeCallEvidencePresent: rows.length > 0,
      supplierHttpCallsMade: 0,
      boundary: 'Read-only saved Hub supplier evidence. No HTTP, retries, grants, settings, billing or historical receipts are changed. Missing rows do not prove absence of an upstream dispatch through Night-All.' }
  } finally {
    let rollbackError
    try { await client.query('ROLLBACK') } catch (error) { rollbackError = error }
    client.release(rollbackError)
    if (rollbackError) throw new Error('inspection_read_failed')
  }
}

if (process.argv[1] === '-' || (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  let pool
  try {
    const [flag, requestId, shapeFlag, twitterPostId, extra] = process.argv.slice(2)
    if (flag !== '--request-id' || extra || !UUID.test(requestId || '')
      || (shapeFlag !== undefined && (shapeFlag !== '--twitter-post-id' || !TWITTER_ID.test(twitterPostId || '')))) throw new Error('invalid_arguments')
    if (!process.env.DATABASE_URL) throw new Error('database_url_required')
    const { default: pg } = await import('pg')
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, query_timeout: 6000,
      options: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000' })
    console.log(JSON.stringify(await inspectPostCommentContract(pool, requestId, { twitterPostId: twitterPostId ?? null }), null, 2))
  } catch (error) {
    const safe = ['invalid_arguments', 'database_url_required', 'request_not_found', 'invalid_request_id'].includes(error?.message)
      ? error.message : 'post_comment_contract_inspection_failed'
    console.error(JSON.stringify({ error: safe })); process.exitCode = 1
  } finally { await pool?.end() }
}
