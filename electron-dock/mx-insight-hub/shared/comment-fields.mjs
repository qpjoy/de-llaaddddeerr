// Public field registry for comment and reply items. Docs (OpenAPI schema and
// field tables), the interface debugger and the product display read this one
// list; a contract test keeps every projected field documented here.
const s = (type, description, extra = {}) => ({ type, description, ...extra })
const nullable = type => [type, 'null']

export const COMMENT_ITEM_FIELDS = Object.freeze([
  ['id', s('string', 'Hub 稳定 ID，格式 `{platform}:comment:{commentId}`。')],
  ['commentId', s('string', '评论在平台上的原始 ID，查回复时作为 commentId 传入。')],
  ['externalId', s('string', '同 commentId，规范化入库时的外部 ID。')],
  ['content_id', s('string', '同 commentId（兼容旧 raw_data 字段名）。')],
  ['contentId', s(nullable('string'), '评论所属帖子的规范化 ID；回复接口在调用方未提供且来源未给出时为 null。')],
  ['postId', s(nullable('string'), '同 contentId（兼容字段）。')],
  ['rootExternalId', s(nullable('string'), '所属帖子 ID，同 contentId。')],
  ['parentExternalId', s(nullable('string'), '直接父对象 ID：一级评论为帖子 ID，回复为被回复的评论 ID；无法确定时为 null。')],
  ['parentCommentId', s(nullable('string'), '直接父评论 ID；一级评论为 null，回复为被回复的评论；来源未给出关系时为 null。')],
  ['parentRelationship', s('string', '父关系的可信度：post（一级评论）、comment（明确回复某评论）、unknown（同一会话但未给出直接父级）。仅部分平台返回。', { enum: ['post', 'comment', 'unknown'] })],
  ['rootCommentId', s('string', '仅回复接口：被查询回复的那条评论 ID（即请求中的 commentId）。')],
  ['replyRef', s('object', '仅帖子评论接口：原样传给 /api/v1/data/social/comment-replies 即可查询这条评论的回复。', {
    properties: { platform: s('string', '平台'), commentId: s('string', '评论 ID'), contentId: s(nullable('string'), '所属帖子 ID'),
      cursor: s('string', '仅 Reddit：该评论还有未展开的回复时出现') } })],
  ['replyCursor', s('string', '仅 Reddit：该评论有未展开回复时的回复游标（已包含在 replyRef.cursor 中）。')],
  ['replyToUser', s('object', '被回复的用户（快手回复），评论 ID 未知时用于判断回复对象。', { properties: {
    id: s(nullable('string'), '被回复用户 ID'), name: s(nullable('string'), '被回复用户昵称') } })],
  ['isRemoved', s('boolean', 'Reddit：评论已被删除或移除时为 true。')],
  ['platform', s('string', '平台标识，如 twitter、douyin、xiaohongshu。')],
  ['objectType', s('string', '固定为 comment。', { const: 'comment' })],
  ['type', s('string', 'comment（帖子一级评论）或 reply（评论回复接口返回的回复）。', { enum: ['comment', 'reply'] })],
  ['text', s(nullable('string'), '评论完整正文（保留原始空白与换行）；纯图片/贴纸评论可能为 null。')],
  ['content', s(nullable('string'), '同 text（兼容字段）。')],
  ['full_text', s(nullable('string'), '同 text（兼容字段）。')],
  ['author', s('object', '评论作者。', { properties: {
    id: s(nullable('string'), '作者在平台上的 ID'), name: s(nullable('string'), '作者昵称/显示名'),
    avatarUrl: s(nullable('string'), '头像地址'), handle: s(nullable('string'), '作者用户名（Twitter、微博等）'),
    profileUrl: s(nullable('string'), '作者主页（部分平台）'), channelId: s(nullable('string'), 'YouTube 频道 ID'),
    displayName: s(nullable('string'), 'YouTube 显示名') } })],
  ['author_id', s(nullable('string'), '同 author.id（兼容字段）。')],
  ['author_name', s(nullable('string'), '同 author.name（兼容字段）。')],
  ['authorHandle', s(nullable('string'), '作者用户名（Twitter、微博）。')],
  ['publishedAt', s(nullable('string'), '发布时间，ISO 8601（UTC）；平台只给相对时间时为 null。', { format: 'date-time' })],
  ['publishedTime', s(nullable('string'), '平台原始时间文本，如 “2 days ago” 或微博时间串；只在来源给出时返回。')],
  ['collected_at', s('string', '本次采集时间，ISO 8601。', { format: 'date-time' })],
  ['likeCount', s(nullable('integer'), '点赞数；平台未提供为 null（不是 0）。')],
  ['like_count', s(nullable('integer'), '同 likeCount（兼容字段）。')],
  ['replyCount', s(nullable('integer'), '回复数（平台显示的总数，不代表本页已返回的回复）。')],
  ['reply_count', s(nullable('integer'), '同 replyCount（兼容字段）。')],
  ['metrics', s('object', '互动指标；未提供的指标为 null。', { properties: {
    likes: s(nullable('integer'), '点赞'), replies: s(nullable('integer'), '回复'),
    score: s(nullable('integer'), 'Reddit 得分（可为负；隐藏时为 null）'), shares: s(nullable('integer'), '转发（Twitter）'),
    views: s(nullable('integer'), '浏览（Twitter）'), bookmarks: s(nullable('integer'), '收藏（Twitter）'),
    quotes: s(nullable('integer'), '引用（Twitter）'), dislikes: s(nullable('integer'), '点踩（知乎）'),
    reactions: s(nullable('integer'), '表情回应总数（Facebook）') } })],
  ['repliesIncluded', s(nullable('boolean'), '该行本身是否是回复：true 为回复，false 为一级评论，null 为关系未知。')],
  ['url', s(nullable('string'), '评论或所属帖子的链接；平台不提供时为 null。')],
  ['media', s('array', '评论附带的图片/贴纸（小红书、Facebook 等），每项含 type、url，可能含 width、height。', { items: { type: 'object' } })],
  ['conversationId', s('string', 'Twitter 会话根帖 ID。')],
  ['mediaId', s(nullable('string'), 'Instagram 媒体 ID。')],
  ['videoId', s('string', 'YouTube 视频 ID。')],
  ['legacyCommentId', s(nullable('string'), 'Facebook 旧版评论 ID。')],
  ['raw', s('object', '仅 includeRaw=true：该评论的来源原始对象，字段随来源平台变化。')],
].map(([name, schema]) => Object.freeze({ name, ...schema })))

export const COMMENT_PAGE_FIELDS = Object.freeze({
  page: s('integer', '本次交付页序号，从 1 开始。'),
  pageSize: s('integer', '本次请求的 count。'),
  returnedCount: s('integer', '本页实际返回条数。'),
  duplicateCount: s('integer', '跨页去重丢弃的重复条数。'),
  hasMore: s(nullable('boolean'), 'true 有后续页；false 已确认结束；null 未知（来源未证明续页或已结束），不要自动补页。'),
  nextCursor: s(nullable('string'), '下一页的 Hub 游标，原样作为 cursor 传入；24 小时有效，绑定 Key、平台、ID、count 和数据通道。'),
  providerCursor: s(nullable('string'), '同 nextCursor（兼容字段）。'),
  nextPage: s('null', '固定为 null，请使用 nextCursor。'),
  nextParams: s(nullable('object'), '{ cursor: nextCursor }，便于原样提交。'),
  paginationMode: s('string', '固定为 cursor。'),
  paginationStatus: s('string', 'continuable 可继续；exhausted 已结束；unknown 不确定；limit_reached 达到 15 页上限。', { enum: ['continuable', 'exhausted', 'unknown', 'limit_reached'] }),
  continuationAvailable: s('boolean', '每次只取一个来源页的平台（Twitter、Reddit、快手、微博）返回：是否可显式请求下一页。'),
})

export function commentItemSchema({ replies = false } = {}) {
  const properties = Object.fromEntries(COMMENT_ITEM_FIELDS
    .filter(field => replies ? field.name !== 'replyRef' : field.name !== 'rootCommentId')
    .map(({ name, ...schema }) => [name, schema]))
  return { type: 'object', additionalProperties: true, required: ['id', 'commentId', 'platform', 'objectType', 'type', 'text', 'author', 'metrics'],
    description: replies ? '一条回复。rootCommentId 是被查询的评论；parentCommentId 是直接回复对象。' : '一条帖子一级评论。replyRef 可直接用于查询回复。',
    properties }
}

export function commentPageSchema() {
  return { type: 'object', required: ['hasMore', 'nextCursor', 'returnedCount', 'paginationStatus'], additionalProperties: true,
    properties: structuredClone(COMMENT_PAGE_FIELDS) }
}

export function commentResponseSchema({ replies = false, version }) {
  const item = commentItemSchema({ replies }), page = commentPageSchema()
  return { type: 'object', required: ['contractVersion', 'data', 'requestId'], properties: {
    contractVersion: { const: version, description: '响应合同版本。' },
    requestId: { type: 'string', format: 'uuid', description: 'Hub 请求 ID；排查和查询原请求时使用。' },
    data: { type: 'object', properties: {
      platform: s('string', '平台。'),
      ...(replies ? { commentId: s('string', '被查询回复的评论 ID。'), contentId: s(nullable('string'), '所属帖子 ID（调用方提供或来源给出）。') }
        : { postId: s('string', '规范化后的帖子 ID。') }),
      items: { type: 'array', items: item, description: replies ? '本页回复。' : '本页评论。' },
      [replies ? 'replies' : 'comments']: { type: 'array', items: { type: 'object' }, description: '同 items（兼容字段）。' },
      raw_data: s('string', 'items 的 JSON 字符串（兼容旧 raw_data）。'),
      raw_info: { const: '[]', description: '固定为 "[]"。' },
      page, pageInfo: { ...page, description: '同 page，另含 pageIndex 与 cursorType（opaque | none）。' },
      status: s('string', 'ok 完整；partial 有后续页或有 warnings。', { enum: ['ok', 'partial'] }),
      warnings: { type: 'array', description: '非致命提示，如 pagination_completeness_unknown、page_limit_reached。', items: { type: 'object', properties: {
        code: s('string', '提示代码'), message: s('string', '说明') } } },
      meta: { type: 'object', description: '执行信息。', properties: {
        implementation: { const: 'hub' }, scope: s('string', replies ? 'comment_replies' : 'single_post'),
        resultCount: s('integer', '本页条数'), providerCalls: s('integer', '本次请求实际发起的外部调用次数（0 表示全部来自已购缓冲或重放）'),
        upstreamCallCount: s('integer', '实际外部调用次数（兼容字段）'), upstreamPages: s('integer', '该遍历累计已取得的来源页数'),
        maxUpstreamPages: s('integer', '来源页上限（15）'), paginationStatus: s('string', '同 page.paginationStatus'),
        ...(replies ? {} : { repliesIncluded: s('boolean', '本页是否含有回复行'), repliesFetched: { const: false, description: '本接口不展开回复；请用评论回复接口' } }) } },
    } },
  } }
}
