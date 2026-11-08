// Meanings of the response fields shared by Strategy Search interfaces. Docs
// fill a schema field's missing description from here (an explicit
// description in the schema always wins), so every returned field the test and
// downstream teams see has a meaning attached. Keys are field names; a
// `parent.name` key overrides the plain name under that parent.
export const RESPONSE_FIELD_DESCRIPTIONS = Object.freeze({
  // Envelope
  contractVersion: '响应合同版本，结构变更时会升级。',
  requestId: 'Hub 请求 ID；排查问题、按 ID 查询原请求时使用。',
  traceId: '链路追踪 ID（与 requestId 一起提供给支持人员）。',
  endpoint: '原生接口标识（仅原生/兼容响应）。',
  data: '业务数据。',
  status: 'ok 完整；partial 有后续页、部分条目被丢弃或有 warnings。',
  warnings: '非致命提示列表；按 code 判断，不影响已返回数据。',
  code: '提示或错误代码。',
  message: '可读说明。',
  meta: '执行信息（不属于业务数据）。',
  // Search / account rows
  platform: '平台标识，如 twitter、douyin、xiaohongshu。',
  platform_name: '同 platform（兼容字段）。',
  query: '本次查询的关键词（规范化后）。',
  items: '本页条目。',
  id: 'Hub 内条目 ID（平台:类型:平台 ID）。',
  externalId: '条目在平台上的原始 ID。',
  external_id: '同 externalId（兼容字段）。',
  content_id: '内容在平台上的原始 ID（兼容字段）。',
  canonicalId: 'Hub 规范化库中的条目 ID；尚未入库时为 null。',
  sourceScope: '数据来源范围（live 实时采集 / stored 已收录）。',
  contentType: '内容类型，如 post、video、note、article。',
  content_type: '同 contentType（兼容字段）。',
  activityType: '账号内容的活动类型：posts、replies、likes、answers 等（与请求 activityTypes 对应）。',
  objectType: '对象类型：user（账号资料）或 post/comment。',
  type: '条目类型。',
  url: '条目在平台上的链接；平台不提供时为 null。',
  original_url: '同 url（兼容字段）。',
  title: '标题；平台没有标题时为 null。',
  text: '完整正文。',
  content: '同 text（兼容字段）。',
  full_text: '同 text（兼容字段）。',
  publishedAt: '发布时间，ISO 8601（UTC）；只有相对时间时为 null。',
  collectedAt: '本次采集时间，ISO 8601。',
  collected_at: '同 collectedAt（兼容字段）。',
  author: '作者信息。',
  author_id: '作者在平台上的 ID。',
  author_name: '作者昵称。',
  author_avatar_url: '作者头像地址。',
  'author.id': '作者在平台上的 ID。',
  'author.name': '作者昵称。',
  'author.username': '作者用户名。',
  'author.url': '作者主页。',
  'author.avatarUrl': '作者头像地址。',
  metrics: '互动指标；未提供的指标为 null（不是 0）。',
  likes: '点赞数。', comments: '评论数。', shares: '转发/分享数。', views: '浏览/播放数。', bookmarks: '收藏数。',
  media: '媒体信息（封面、图片、视频地址）。',
  'media.coverUrl': '封面图地址。', 'media.images': '图片地址列表。', 'media.videos': '视频地址列表。',
  imageUrls: '图片地址列表。', image_urls: '图片地址列表（JSON 字符串，兼容字段）。', video_urls: '视频地址列表（JSON 字符串，兼容字段）。',
  source: '来源信息（采集通道与原始标识）。',
  user_id: '账号在平台上的 ID。', userId: '账号在平台上的 ID。',
  user_name: '账号用户名（兼容字段）。', username: '账号用户名。',
  name: '显示名/昵称。', nickname: '昵称（兼容字段）。',
  description: '账号简介。',
  avatar_url: '头像地址。', avatarUrl: '头像地址。', profile_image_url: '头像地址（兼容字段）。',
  verified: '是否认证；平台未提供为 null。',
  location: '账号填写的地区。',
  noteId: '小红书笔记 ID。',
  // Pagination
  page: '分页信息。',
  pageInfo: '分页信息（同 page，另含 pageIndex、cursorType）。',
  pageIndex: '本次交付页序号，从 1 开始。',
  pageSize: '本次请求的每页条数。',
  returnedCount: '本页实际返回条数。',
  hasMore: 'true 有后续页；false 已结束；null 不确定（不要自动补页）。',
  nextCursor: '下一页的 Hub 游标，原样作为 cursor 传入。',
  cursor: '游标（原样回传）。',
  cursorType: 'opaque 表示有 Hub 游标；none 表示没有。',
  nextParams: '下一页可直接提交的参数，通常为 { cursor }。',
  nextPage: '固定为 null，请使用 nextCursor。',
  paginationMode: '分页方式：cursor 或 page。',
  paginationStatus: 'continuable 可继续；exhausted 已结束；unknown 不确定；limit_reached 达到上限。',
  // Meta
  capability: '本次使用的业务能力。',
  capabilityStatus: '业务能力状态。',
  sourceProvider: '执行本次采集的数据通道（脱敏标识）。',
  endpointId: '执行本次采集的固定合同标识。',
  providerCalls: '本次请求实际发起的外部调用次数（0 表示全部来自已购缓冲或重放）。',
  upstreamCallCount: '实际外部调用次数（兼容字段）。',
  durationMs: '服务端处理耗时（毫秒）。',
  implementation: '执行方：hub。',
  resultCount: '本页条数。',
  // Legacy envelopes
  raw_info: '账号资料数组的 JSON 字符串（兼容旧 raw_info）。',
  raw_data: '内容条目数组的 JSON 字符串（兼容旧 raw_data）。',
  results: '批量请求时每个账号/工作项的结果。',
  mode: 'batch 表示批量请求。',
  success: '该工作项是否已开始并成功返回。',
  kind: '账号标识类型：username、id 或 url。',
  value: '账号标识值。',
})

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
// Fill missing descriptions in place, following $ref and composite schemas.
export function describeResponseFields(document, schema, dictionary = RESPONSE_FIELD_DESCRIPTIONS) {
  const visited = new Set()
  const resolve = node => {
    let guard = 0
    while (node?.$ref && guard++ < 20) node = node.$ref.split('/').slice(1).reduce((value, key) => value?.[key], document)
    return node
  }
  const visit = (node, parent) => {
    node = resolve(node)
    if (!object(node) || visited.has(node)) return
    visited.add(node)
    for (const key of ['allOf', 'oneOf', 'anyOf']) for (const variant of node[key] || []) visit(variant, parent)
    for (const [name, child] of Object.entries(node.properties || {})) {
      let target = resolve(child)
      if (object(target) && !target.description) {
        const description = dictionary[`${parent}.${name}`] || dictionary[name]
        // Inline property schemas may be one object shared by several fields;
        // copy before describing so one name never labels another field.
        if (description && child.$ref) target.description = description
        else if (description) target = node.properties[name] = { ...target, description }
      }
      visit(target, name)
      if (object(target) && target.items) visit(target.items, name)
    }
  }
  visit(schema, '')
  return schema
}
