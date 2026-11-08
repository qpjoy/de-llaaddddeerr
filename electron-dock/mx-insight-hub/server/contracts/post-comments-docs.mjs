import { POST_COMMENTS_RECIPES, POST_COMMENT_PROVIDER_RECIPES, POST_COMMENTS_PATH, POST_COMMENTS_CAPABILITY, POST_COMMENTS_VERSION } from './post-comments.mjs'
import { COMMENT_REPLY_PROVIDER_RECIPES, COMMENT_REPLIES_PATH, COMMENT_REPLIES_VERSION } from './comment-replies.mjs'
import { COMMENT_REPLY_CONTENT_REQUIRED } from './comment-routes.mjs'
import { commentResponseSchema, COMMENT_ITEM_FIELDS, COMMENT_PAGE_FIELDS } from '../../shared/comment-fields.mjs'

const granted = (platforms, scopes) => platforms.filter(platform => scopes == null
  || scopes.some(scope => scope.platforms?.includes(platform) && scope.capabilities?.includes(POST_COMMENTS_CAPABILITY)))
export const postCommentsPlatforms = (scopes = null) => granted(Object.keys(POST_COMMENTS_RECIPES), scopes)
export const commentRepliesPlatforms = (scopes = null) => granted(Object.keys(COMMENT_REPLY_PROVIDER_RECIPES), scopes)
const text = { type: 'string', minLength: 1, maxLength: 8192 }
const count = { type: 'integer', minimum: 1, maximum: 100 }
const idempotency = { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 128 },
  description: '每个新请求（包括下一页）用新的键；同一请求重试保持原键，Hub 精确重放已保存响应且不重复计费。' }
const errors = [400, 401, 402, 403, 409, 429, 502, 503]
const errorDescriptions = {
  400: '参数错误：invalid_post_comments_request / invalid_comment_replies_request、invalid_cursor、platform_operation_unsupported。',
  401: 'API Key 无效。', 402: '余额或额度不足。', 403: '缺少平台或 social.comments.list 授权。',
  409: '同一请求仍在执行（request_in_progress）或结果待核实（request_outcome_unknown）；先查询原请求，不要换键盲重试。',
  429: '本 Key 或平台限流。', 502: '来源返回的结构不符合已发布合同（invalid_upstream_contract）；不计费。',
  503: '数据通道未就绪、平台暂停（comment_acquisition_paused）或该平台尚未校准（external_platform_contract_unverified）；均在派发前返回，不计费。',
}
// Commented, anonymized example of a delivered comment page.
const commentExample = { contractVersion: POST_COMMENTS_VERSION, requestId: '0a3c1d7e-5b6f-4d2a-9c8e-1f2b3c4d5e6f', data: {
  platform: 'douyin', postId: '7290000000000000000',
  items: [{ id: 'douyin:comment:7300000000000000001', commentId: '7300000000000000001', externalId: '7300000000000000001',
    content_id: '7300000000000000001', contentId: '7290000000000000000', postId: '7290000000000000000',
    rootExternalId: '7290000000000000000', parentExternalId: '7290000000000000000', parentCommentId: null,
    platform: 'douyin', objectType: 'comment', type: 'comment', text: '完整评论正文', content: '完整评论正文', full_text: '完整评论正文',
    author: { id: '1234567890', name: '评论作者', avatarUrl: 'https://example.com/avatar.jpg' }, author_id: '1234567890', author_name: '评论作者',
    publishedAt: '2026-11-06T08:00:00.000Z', collected_at: '2026-11-07T02:00:00.000Z',
    likeCount: 12, like_count: 12, replyCount: 3, reply_count: 3, metrics: { likes: 12, replies: 3 }, repliesIncluded: false, url: null,
    replyRef: { platform: 'douyin', commentId: '7300000000000000001', contentId: '7290000000000000000' } }],
  raw_info: '[]', page: { page: 1, pageSize: 20, returnedCount: 1, duplicateCount: 0, hasMore: true, nextCursor: 'mxds1.…',
    providerCursor: 'mxds1.…', nextPage: null, nextParams: { cursor: 'mxds1.…' }, paginationMode: 'cursor', paginationStatus: 'continuable' },
  status: 'partial', warnings: [],
  meta: { implementation: 'hub', scope: 'single_post', resultCount: 1, providerCalls: 1, upstreamCallCount: 1, upstreamPages: 1,
    maxUpstreamPages: 15, paginationStatus: 'continuable', repliesIncluded: false, repliesFetched: false } } }
const replyExample = { contractVersion: COMMENT_REPLIES_VERSION, requestId: '6d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6', data: {
  platform: 'douyin', commentId: '7300000000000000001', contentId: '7290000000000000000',
  items: [{ id: 'douyin:comment:7400000000000000002', commentId: '7400000000000000002', externalId: '7400000000000000002',
    content_id: '7400000000000000002', contentId: '7290000000000000000', postId: '7290000000000000000', rootExternalId: '7290000000000000000',
    rootCommentId: '7300000000000000001', parentExternalId: '7300000000000000001', parentCommentId: '7300000000000000001', parentRelationship: 'comment',
    platform: 'douyin', objectType: 'comment', type: 'reply', text: '回复正文', content: '回复正文', full_text: '回复正文',
    author: { id: '2234567890', name: '回复作者', avatarUrl: null }, author_id: '2234567890', author_name: '回复作者',
    publishedAt: '2026-11-06T09:00:00.000Z', collected_at: '2026-11-07T02:01:00.000Z', likeCount: 1, like_count: 1,
    replyCount: 0, reply_count: 0, metrics: { likes: 1, replies: 0 }, repliesIncluded: true, url: null }],
  raw_info: '[]', page: { page: 1, pageSize: 20, returnedCount: 1, duplicateCount: 0, hasMore: false, nextCursor: null, providerCursor: null,
    nextPage: null, nextParams: null, paginationMode: 'cursor', paginationStatus: 'exhausted' }, status: 'ok', warnings: [],
  meta: { implementation: 'hub', scope: 'comment_replies', resultCount: 1, providerCalls: 1, upstreamCallCount: 1, upstreamPages: 1,
    maxUpstreamPages: 15, paginationStatus: 'exhausted' } } }
const responses = (schema, example, success) => Object.fromEntries([200, ...errors].map(status => [status, {
  description: status === 200 ? success : errorDescriptions[status],
  ...(status === 200 ? { content: { 'application/json': { schema, example } } } : {}),
}]))

const identityFields = ['postId', 'post_id', 'contentId', 'content_id', 'itemId', 'item_id', 'tweetId', 'tweet_id', 'noteId', 'note_id',
  'awemeId', 'aweme_id', 'statusId', 'status_id', 'videoId', 'video_id', 'postUrn', 'post_urn', 'urn', 'url']
export const postCommentsPaths = { [POST_COMMENTS_PATH.slice('/api/v1'.length)]: { post: {
  tags: ['社媒与内容数据'], operationId: 'social_post_comments', summary: '按帖子获取评论',
  'x-mx-platform-options': postCommentsPlatforms(), 'x-mx-required-capabilities': [POST_COMMENTS_CAPABILITY],
  'x-mx-meter-key': POST_COMMENTS_CAPABILITY, 'x-mx-doc-path': '/docs/social-content',
  description: 'Hub 单帖评论接口。旧 /api/v1/search/post-comments 与 /api/v1/night-all/search/post-comments 共用此入口。count 默认 20、最大 100；使用返回的 Hub cursor 继续。每个成功交付页按 social.comments.list 结算一次，精确幂等重放不重复计费。每条评论的 replyRef 可直接用于 /api/v1/data/social/comment-replies。',
  parameters: [idempotency],
  requestBody: { required: true, content: { 'application/json': { schema: {
    type: 'object', additionalProperties: false, required: ['platform'],
    anyOf: identityFields.map(name => ({ required: [name] })),
    properties: { platform: { type: 'string', enum: postCommentsPlatforms(), description: '目标平台；支持别名 x、xhs、小红书、抖音、快手、知乎、微博、b站。' },
      contentId: { ...text, description: '帖子 ID（推荐）。B站接受 AV/BV 号，Instagram 接受 shortcode 或数字媒体 ID，知乎为回答 ID，Reddit 为帖子 ID（可带 t3_）。' },
      url: { ...text, description: '规范帖子链接，Hub 从中解析 ID；短链接不解析。' },
      ...Object.fromEntries(identityFields.filter(name => !['contentId', 'url'].includes(name)).map(name => [name, { ...text, description: 'contentId 的兼容别名；多个标识必须指向同一帖子。' }])),
      count: { ...count, default: 20, description: '本页条数目标。Twitter、Reddit、快手、微博每次请求只取一个来源页，可能少于 count。' },
      limit: { ...count, description: 'count 的别名。' }, pageSize: { ...count, description: 'count 的别名。' },
      cursor: { ...text, description: '原样使用 data.page.nextCursor。params.cursor 是同义字段。' },
      page: { type: 'integer', minimum: 1, maximum: 1000, default: 1, description: '兼容字段；续页请使用 cursor。' },
      params: { type: 'object', description: '仅允许当前平台的固定排序与续页字段；不接受 provider、凭据或请求地址。支持导入的平台将原生续页状态视为新遍历起点，之后只返回 Hub 游标。快手非空原生 pcursor 仅允许原键历史重放，新遍历只能使用 Hub nextCursor。' },
      businessId: { type: 'string', description: '可省略；提交时必须等于当前消费者的绑定值。' }, business_id: { type: 'string' },
      includeRaw: { type: 'boolean', default: false, description: 'true 时每条评论附带来源原始对象 raw。' },
      cacheMaxAgeHours: { type: 'number', minimum: 0, maximum: 720, description: '兼容字段；新采集不使用旧快照替代刷新。' },
    },
  }, example: { platform: 'twitter', contentId: '2117082385997250767', count: 20, includeRaw: false } } } },
  responses: responses(commentResponseSchema({ version: POST_COMMENTS_VERSION }), commentExample,
    '评论及明确的分页状态。未知时间或指标为 null；publishedTime 保留相对发布时间原文。'),
} } }
export const postCommentsAliasPaths = Object.fromEntries(['/search/post-comments', '/night-all/search/post-comments'].map((path, index) => [path,
  { post: { ...structuredClone(postCommentsPaths['/data/social/post-comments'].post), operationId: `social_post_comments_alias_${index + 1}` } }]))

export const commentRepliesPaths = { [COMMENT_REPLIES_PATH.slice('/api/v1'.length)]: { post: {
  tags: ['社媒与内容数据'], operationId: 'social_comment_replies', summary: '按评论获取回复（楼中楼）',
  'x-mx-platform-options': commentRepliesPlatforms(), 'x-mx-required-capabilities': [POST_COMMENTS_CAPABILITY],
  'x-mx-meter-key': POST_COMMENTS_CAPABILITY, 'x-mx-doc-path': '/docs/social-content',
  description: `按 commentId 获取一条评论下的回复。${COMMENT_REPLY_CONTENT_REQUIRED.join('、')} 还需要该评论所属帖子的 contentId；最简单的方式是把帖子评论返回的 replyRef 原样传入。与帖子评论共用 social.comments.list 授权和计费；尚未校准的平台在派发前返回 503 external_platform_contract_unverified，不计费。`,
  parameters: [idempotency],
  requestBody: { required: true, content: { 'application/json': { schema: {
    type: 'object', additionalProperties: false,
    properties: {
      platform: { type: 'string', enum: commentRepliesPlatforms(), description: '目标平台；可省略并由 replyRef.platform 提供。' },
      replyRef: { type: 'object', additionalProperties: false, description: '帖子评论接口每条评论返回的 replyRef，原样传入。',
        properties: { platform: { type: 'string' }, commentId: text, contentId: { type: ['string', 'null'] } } },
      commentId: { ...text, description: '要查看回复的评论 ID（帖子评论返回的 commentId）。别名：comment_id、rootCommentId、root_comment_id。' },
      comment_id: text, rootCommentId: text, root_comment_id: text,
      contentId: { ...text, description: `所属帖子 ID。${COMMENT_REPLY_CONTENT_REQUIRED.join('、')} 必填；其他平台可选（提供后用于校验与入库）。别名：postId、post_id、content_id、noteId、awemeId、tweetId、videoId、url。` },
      ...Object.fromEntries(['content_id', 'postId', 'post_id', 'noteId', 'note_id', 'awemeId', 'aweme_id', 'tweetId', 'tweet_id', 'videoId', 'video_id', 'url'].map(name => [name, text])),
      count: { ...count, default: 20, description: '本页条数目标。Twitter、Reddit、快手、微博每次请求只取一个来源页。' },
      limit: count, pageSize: count,
      cursor: { ...text, description: '原样使用 data.page.nextCursor；不接受平台原生游标。' },
      params: { type: 'object', description: '仅 Reddit：params.cursor 为评论树中隐藏回复的 more 游标。', properties: { cursor: text }, additionalProperties: false },
      includeRaw: { type: 'boolean', default: false, description: 'true 时每条回复附带来源原始对象 raw。' },
      businessId: { type: 'string', description: '可省略；提交时必须等于当前消费者的绑定值。' }, business_id: { type: 'string' },
    },
  }, example: { platform: 'douyin', replyRef: { platform: 'douyin', commentId: '7300000000000000001', contentId: '7290000000000000000' }, count: 20 } } } },
  responses: responses(commentResponseSchema({ replies: true, version: COMMENT_REPLIES_VERSION }), replyExample,
    '回复及明确的分页状态。rootCommentId 为被查询的评论，parentCommentId 为直接回复对象（未知为 null）。'),
} } }

const LABELS = { twitter: 'Twitter', reddit: 'Reddit', xiaohongshu: '小红书', weibo: '微博', instagram: 'Instagram', douyin: '抖音',
  bilibili: 'B站', kuaishou: '快手', zhihu: '知乎', tiktok: 'TikTok', linkedin: 'LinkedIn', facebook: 'Facebook', youtube: 'YouTube' }
const STATUS = { verified: '可用', sample: '可用', derived: '可用（新接入）', pending: '待校准' }
const best = recipes => Object.values(recipes || {}).map(row => row.verification)
  .sort((a, b) => ['verified', 'sample', 'derived', 'pending'].indexOf(a) - ['verified', 'sample', 'derived', 'pending'].indexOf(b))[0]
const escape = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char])
function fieldTable(fields) {
  return `<table><thead><tr><th>字段</th><th>类型</th><th>说明</th></tr></thead><tbody>${fields.map(([name, schema]) =>
    `<tr><td><code>${escape(name)}</code></td><td>${escape(Array.isArray(schema.type) ? schema.type.join(' | ') : schema.type || 'const')}</td><td>${escape(schema.description || '')}</td></tr>`).join('')}</tbody></table>`
}
export function postCommentsGuide(scopes = null) {
  const platforms = postCommentsPlatforms(scopes)
  if (!platforms.length) return ''
  const replyPlatforms = commentRepliesPlatforms(scopes)
  const rows = [...new Set([...platforms, ...replyPlatforms])].map(platform => `<tr><td>${LABELS[platform] || platform}</td><td>${platforms.includes(platform) ? STATUS[best(POST_COMMENT_PROVIDER_RECIPES[platform])] : '—'}</td><td>${replyPlatforms.includes(platform) ? STATUS[best(COMMENT_REPLY_PROVIDER_RECIPES[platform])] : '—'}</td><td>${COMMENT_REPLY_CONTENT_REQUIRED.includes(platform) ? 'commentId + contentId' : replyPlatforms.includes(platform) ? 'commentId' : '—'}</td></tr>`).join('')
  return `<h2>帖子评论与评论回复</h2>
  <p><code>POST ${POST_COMMENTS_PATH}</code> 按 contentId 获取帖子一级评论；<code>POST ${COMMENT_REPLIES_PATH}</code> 按 commentId 获取该评论下的回复（楼中楼）。两者都需要目标平台与 <code>social.comments.list</code> 授权，按成功交付页计费，精确重放不重复计费。旧两个 search/post-comments 入口仍可使用。</p>
  <table><thead><tr><th>平台</th><th>帖子评论</th><th>评论回复</th><th>查回复需要</th></tr></thead><tbody>${rows}</tbody></table>
  <p>“待校准”的平台在派发前返回 503 <code>external_platform_contract_unverified</code>，不计费。“新接入”表示沿用同平台已校准的结构，首个生产页会单独核对。</p>
  <h3>调用顺序</h3>
  <ol><li>帖子评论：传 <code>platform</code> + <code>contentId</code>（或规范帖子 URL），可选 <code>count</code>（1–100）。</li>
  <li>每条评论带 <code>replyRef</code>，把它原样作为请求体字段 <code>replyRef</code> 传给评论回复接口即可，无需按平台拼参数。</li>
  <li>续页：原样传 <code>data.page.nextCursor</code> 作为 <code>cursor</code>，保持平台、ID、count 不变，并使用新的 Idempotency-Key。只有 <code>paginationStatus=exhausted</code> 表示已结束；<code>hasMore=null</code> 表示不确定，不要自动循环。</li></ol>
  <h3>评论 / 回复条目字段</h3>${fieldTable(COMMENT_ITEM_FIELDS.map(({ name, ...schema }) => [name, schema]))}
  <h3>分页字段（data.page）</h3>${fieldTable(Object.entries(COMMENT_PAGE_FIELDS))}
  <p>B站接受 AV/BV 号；Instagram 使用 shortcode 或数字媒体 ID；知乎为回答 ID；LinkedIn 为 activity ID；短链接需要先取得平台 ID。</p>`
}
