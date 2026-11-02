import { POST_COMMENTS_RECIPES, POST_COMMENTS_PATH, POST_COMMENTS_CAPABILITY, POST_COMMENTS_VERSION } from './post-comments.mjs'

export const postCommentsPlatforms = (scopes = null) => Object.keys(POST_COMMENTS_RECIPES).filter(platform => scopes == null
  || scopes.some(scope => scope.platforms?.includes(platform) && scope.capabilities?.includes(POST_COMMENTS_CAPABILITY)))
const text = { type: 'string', minLength: 1, maxLength: 8192 }
const count = { type: 'integer', minimum: 1, maximum: 100 }
const page = { type: 'object', properties: {
  hasMore: { type: ['boolean', 'null'] }, nextCursor: { type: ['string', 'null'] },
  returnedCount: { type: 'integer', minimum: 0 },
  paginationStatus: { enum: ['continuable', 'exhausted', 'unknown', 'limit_reached'] },
  continuationAvailable: { type: 'boolean', description: 'Twitter：可显式请求下一页；不保证该页有评论。hasMore=null 时不要自动补页。' },
}, required: ['hasMore', 'nextCursor', 'returnedCount', 'paginationStatus'], additionalProperties: true }
export const postCommentsPaths = { [POST_COMMENTS_PATH.slice('/api/v1'.length)]: { post: {
  tags: ['社媒与内容数据'], operationId: 'social_post_comments', summary: '按帖子获取评论',
  'x-mx-platform-options': postCommentsPlatforms(), 'x-mx-required-capabilities': [POST_COMMENTS_CAPABILITY],
  'x-mx-meter-key': POST_COMMENTS_CAPABILITY, 'x-mx-doc-path': '/docs/social-content',
  description: 'Hub 单帖评论接口。旧 /api/v1/search/post-comments 与 /api/v1/night-all/search/post-comments 共用此入口。count 默认 20、最大 100；使用返回的 Hub cursor 继续。每个成功交付页按 social.comments.list 结算一次，精确幂等重放不重复计费。需要目标平台及 social.comments.list 授权。',
  parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 128 } }],
  requestBody: { required: true, content: { 'application/json': { schema: {
    type: 'object', additionalProperties: false, required: ['platform'],
    anyOf: ['postId', 'post_id', 'contentId', 'content_id', 'itemId', 'item_id', 'tweetId', 'tweet_id', 'noteId', 'note_id',
      'awemeId', 'aweme_id', 'statusId', 'status_id', 'videoId', 'video_id', 'postUrn', 'post_urn', 'urn', 'url'].map(name => ({ required: [name] })),
    properties: { platform: { type: 'string', enum: postCommentsPlatforms() },
      ...Object.fromEntries(['postId', 'post_id', 'contentId', 'content_id', 'itemId', 'item_id', 'tweetId', 'tweet_id', 'noteId', 'note_id',
        'awemeId', 'aweme_id', 'statusId', 'status_id', 'videoId', 'video_id', 'postUrn', 'post_urn', 'urn', 'url'].map(name => [name, text])),
      count: { ...count, default: 20 }, limit: count, pageSize: count,
      cursor: { ...text, description: '原样使用 data.page.nextCursor。params.cursor 是同义字段。' },
      page: { type: 'integer', minimum: 1, maximum: 1000, default: 1 },
      params: { type: 'object', description: '仅允许当前平台的固定排序与续页字段；不接受 provider、凭据或请求地址。旧原生续页状态视为新遍历的起点，之后只返回 Hub 游标。' },
      businessId: { type: 'string', description: '可省略；提交时必须等于当前消费者的绑定值。' }, business_id: { type: 'string' },
      includeRaw: { type: 'boolean', default: false }, cacheMaxAgeHours: { type: 'number', minimum: 0, maximum: 720, description: '兼容字段；新采集不使用旧快照替代刷新。' },
    },
  }, example: { platform: 'twitter', postId: '2117082385997250767', count: 20, includeRaw: false } } } },
  responses: Object.fromEntries([200, 400, 401, 402, 403, 409, 429, 502, 503].map(status => [status, {
    description: status === 200 ? '评论及明确的分页状态。未知时间或指标为 null；publishedTime 保留相对发布时间原文。'
      : '稳定错误码及 requestId；未知结果先查原请求，不换键盲重试。',
    ...(status === 200 ? { content: { 'application/json': { schema: { type: 'object', properties: {
      contractVersion: { const: POST_COMMENTS_VERSION }, requestId: { type: 'string', format: 'uuid' },
      data: { type: 'object', properties: { platform: { type: 'string' }, postId: text,
        items: { type: 'array', items: { type: 'object', description: 'commentId/content_id 是评论 ID；postId/contentId 是原帖 ID。包含 text/content、author、publishedAt、publishedTime、metrics 与已取得的父评论关系。' } },
        raw_data: { type: 'string', description: 'items 的 JSON 字符串。' }, raw_info: { const: '[]' }, page, pageInfo: page,
      } },
    } } } } } : {}),
  }])),
} } }
export const postCommentsAliasPaths = Object.fromEntries(['/search/post-comments', '/night-all/search/post-comments'].map((path, index) => [path,
  { post: { ...structuredClone(postCommentsPaths['/data/social/post-comments'].post), operationId: `social_post_comments_alias_${index + 1}` } }]))
export function postCommentsGuide(scopes = null) {
  const platforms = postCommentsPlatforms(scopes)
  if (!platforms.length) return ''
  return `<h2>单帖评论</h2><p><code>POST ${POST_COMMENTS_PATH}</code>。平台：${platforms.join('、')}。旧两个 search/post-comments 入口仍可使用；新请求和重放共用同一逻辑身份。需要目标平台与 <code>social.comments.list</code> 授权，按成功交付请求计费。</p>
  <p>传 platform 和 postId、contentId 或规范帖子 URL，多个标识必须一致。count 默认 20、最大 100。Instagram 使用数字媒体 ID、shortcode 或帖子 URL；Bilibili 使用数字 AID 或 av URL；知乎使用回答 ID。短链接需要先取得平台 ID。评论 ID 是 commentId/content_id，原帖 ID 是 postId/contentId；缺失指标和确定时间为 null，publishedTime 保留已取得的相对时间。</p>
  <p>继续时原样传 <code>data.page.nextCursor</code>，保持 Key、标识、count、排序不变，使用下一页自己的 Idempotency-Key。原请求重试保持原键。分页状态区分 continuable、exhausted、unknown、limit_reached，只有明确 exhausted 才表示该遍历结束。Twitter 每次最多取得一个供应商数据页；没有缓存余量时，游标只表示可显式查询下一页，hasMore=null、paginationStatus=unknown，不保证还有评论，也不自动补页。显式查询仍可能计费。单次遍历最多 15 个上游页和 15 个交付页，游标 24 小时有效；已取得余量优先交付。不会自动展开回复，商品评价和搜索附带评论不属于此接口。</p>`
}
