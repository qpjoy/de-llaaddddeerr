const nullableText = { type: ['string', 'null'] }
const metric = { type: ['integer', 'null'], minimum: 0, description: 'null 表示未提供，0 表示实际为零。' }
const author = { type: 'object', properties: { id: nullableText, name: nullableText, avatarUrl: nullableText } }
const media = { type: 'array', items: { type: 'object', properties: { type: { enum: ['image', 'video'] }, url: { type: 'string' }, width: metric, height: metric } } }
const comment = { type: 'object', properties: {
  id: { type: 'string' }, noteId: { type: 'string' }, text: { type: 'string' }, liked: metric,
  publishedAt: nullableText, author, media, replyCount: metric,
  replies: { type: 'array', description: '本次返回的部分内嵌回复；不保证等于 replyCount。', items: { type: 'object' } },
} }
const commonDescription = '仅接受 JSON POST；使用已授权的 Live Hub Key，业务与 Key 都必须有 xiaohongshu 平台和本操作权限。每个新请求实时获取一次，不自动缓冲、排队、重试或翻页。相同 Idempotency-Key 与相同参数重放不再次采集/计费，参数变化必须换标识。成功返回（含 no_data）计一次用量，按当前已发布并分配的套餐计费；新能力不会自动授权或改价。交付标识、时间与来源模式见 x-mx-insight-request-id / x-mx-insight-captured-at / x-mx-insight-source-mode 响应头。'
export const xhsResearchPaths = Object.fromEntries([
  ['detail', 'social.posts.analytics', '获取笔记详情与阅读量', { note_id: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' }, deliveryMode: { type: 'string', enum: ['cache_first', 'refresh'], default: 'cache_first' } }, {
    item: { type: ['object', 'null'], properties: {
      platform: { const: 'xiaohongshu' }, externalId: { type: 'string' }, url: { type: 'string' },
      title: nullableText, text: nullableText, type: nullableText, publishedAt: nullableText, collectedAt: { type: 'string', format: 'date-time' },
      tags: { type: 'array', items: { type: 'string' } }, author, media,
      metrics: { type: 'object', properties: Object.fromEntries(['views', 'impressions', 'liked', 'collected', 'comments', 'shared'].map(key => [key, metric])) },
    } },
  }, '默认缓存优先，deliveryMode=refresh 明确获取最新数据；同一上游凭据的详情采集平滑排队，默认间隔至少 5 秒，预计等待达到 60 秒返回 429 external_platform_busy 和 Retry-After。可确认未计费的拒绝最多重试一次，未知结果不重试。阅读量 metrics.views 与曝光量 metrics.impressions 分开；未提供用 null，不猜测或用点赞数替代。meta.tagsAvailable=false 时不要当作无标签，可继续使用完整正文与标签接口。查无结果返回 meta.status=no_data、data.item=null，仍计一次成功调用；不要因此自动重试。'],
  ['comments', 'social.comments.list', '获取笔记评论', {
    note_id: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' },
    sort: { type: 'string', enum: ['latest', 'hot'], default: 'latest' },
    cursor: { type: 'string', maxLength: 8192, description: '首屏省略。续页原样传入 data.nextCursor，保留 note_id/sort 并使用新的 Idempotency-Key。游标绑定当前 Key 与笔记/排序，最多 15 页。' },
  }, { noteId: { type: 'string' }, items: { type: 'array', items: comment }, nextCursor: nullableText, hasMore: { type: ['boolean', 'null'] } }, '仅 nextCursor 非空时继续；meta.paginationStatus=unknown 或 limit_reached 时停止。hasMore=null 表示无法确认。评论总量与当前页数量不同；回复仅含已返回部分。'],
].map(([path, capability, summary, properties, response, description]) => [`/data/xiaohongshu/notes/${path}`, { post: {
  operationId: `xiaohongshuNote${path === 'detail' ? 'Analytics' : 'Comments'}`, tags: ['Data products'], summary,
  description: `${commonDescription} ${description}`,
  'x-mx-required-platform': 'xiaohongshu', 'x-mx-required-capabilities': [capability],
  parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string', minLength: 8, maxLength: 128 }, description: '重试必须保留；省略时每次均视为新请求。' }],
  requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['note_id'], properties }, example: { note_id: '6a20edfa0000000021020951', ...(path === 'comments' ? { sort: 'hot' } : {}) } } } },
  responses: {
    200: { description: '成功交付或已确认无数据；metadata 不包含外部服务身份。', content: { 'application/json': { schema: {
      type: 'object', required: ['code', 'data', 'meta'], properties: {
        code: { const: 200 }, data: { type: 'object', properties: response },
        meta: { type: 'object', properties: {
          status: { enum: ['ok', 'no_data'] }, collectedAt: { type: 'string', format: 'date-time' },
          ...(path === 'detail' ? { tagsAvailable: { type: 'boolean' }, recommendedIntervalSeconds: { const: 5 } }
            : { page: { type: 'integer', minimum: 1, maximum: 15 }, paginationStatus: { enum: ['continuable', 'exhausted', 'unknown', 'limit_reached'] } }),
        } },
      },
    } } } },
    ...Object.fromEntries([400, 401, 403, 405, 409, 429, 502, 503].map(status => [status, { description: 'Hub 错误码与 requestId；结果不确定时保留原幂等标识，先查请求状态。', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } }])),
  },
} }]))
export const xhsResearchGuide = `<h3>关键词 → 热门笔记 → 阅读量与评论</h3>
<p>搜索笔记可用 sort_type=popularity_descending（点赞热度）、comment_descending（评论最多）和 time_filter；结果是关键词相关笔记，不代表全站热榜。取列表的笔记 ID，再按需要分别请求下列接口。</p>
<p><code>POST /api/v1/data/xiaohongshu/notes/detail</code>：JSON <code>{"note_id":"6a20edfa0000000021020951"}</code>；需 <code>social.posts.analytics</code>。返回 <code>data.item.text</code>、媒体、<code>metrics.views</code> 阅读量和 <code>metrics.impressions</code> 曝光量。缺失指标为 null。标签未提供时仍可调用原完整正文与标签入口。</p>
<p>详情默认 <code>deliveryMode=cache_first</code>，有效缓存直接返回；<code>refresh</code> 强制实时。服务器按上游凭据排队，默认间隔至少 <strong>5 秒</strong>、等待上限 60 秒，队列满返回 429 和 Retry-After；确认未计费的拒绝最多重试一次，超时或未知结果不重试。缓存交付仍按调用者套餐计费，合并采集不会共享其他用户的权限或计费身份。无结果 <code>meta.status=no_data</code> 也计一次成功请求；不要自动重试。每次成功请求按已分配套餐计费。</p>
<p><code>POST /api/v1/data/xiaohongshu/notes/comments</code>：JSON <code>{"note_id":"6a20edfa0000000021020951","sort":"hot"}</code>；需 <code>social.comments.list</code>。返回 <code>data.items</code> 和 <code>data.nextCursor</code>。下一页传 <code>cursor</code>，保留相同 note_id/sort 并换用新 Idempotency-Key；只在 nextCursor 非空时继续，最多 15 页。回复仅展示已取得部分。</p>
<pre>curl -X POST "$HUB_URL/api/v1/data/xiaohongshu/notes/detail" \\
  -H "Authorization: Bearer $HUB_KEY" -H "Content-Type: application/json" \\
  -H "Idempotency-Key: note-detail-request-001" \\
  --data '{"note_id":"6a20edfa0000000021020951"}'</pre>`
