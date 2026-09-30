const nullableText = { type: ['string', 'null'] }
const metric = { type: ['integer', 'null'], minimum: 0, description: 'null 表示未提供；0 是本次来源返回值，不表示已用其他接口核验。' }
const author = { type: 'object', properties: { id: nullableText, name: nullableText, avatarUrl: nullableText } }
const media = { type: 'array', items: { type: 'object', properties: { type: { enum: ['image', 'video'] }, url: { type: 'string' }, width: metric, height: metric } } }
const comment = { type: 'object', properties: {
  id: { type: 'string' }, noteId: { type: 'string' }, text: { type: 'string' }, liked: metric,
  publishedAt: nullableText, author, media, replyCount: metric,
  replies: { type: 'array', description: '本次返回的部分内嵌回复；不保证等于 replyCount。', items: { type: 'object' } },
} }
const commonDescription = '仅接受 JSON POST；使用已授权的 Live Hub Key，业务与 Key 都必须有 xiaohongshu 平台和本操作权限。相同 Idempotency-Key 与相同参数重放不再次采集/计费，参数变化必须换标识。成功返回（含 no_data）计一次用量，按当前已发布并分配的套餐计费；新能力不会自动授权或改价。交付标识、时间与来源模式见 x-mx-insight-request-id / x-mx-insight-captured-at / x-mx-insight-source-mode 响应头。'
export const xhsResearchPaths = Object.fromEntries([
  ['detail', 'social.posts.analytics', '获取笔记详情与阅读量', { note_id: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' }, deliveryMode: { type: 'string', enum: ['cache_first', 'refresh'], default: 'cache_first' } }, {
    item: { type: ['object', 'null'], properties: {
      platform: { const: 'xiaohongshu' }, externalId: { type: 'string' }, url: { type: 'string' },
      title: nullableText, text: nullableText, type: nullableText, publishedAt: nullableText, collectedAt: { type: 'string', format: 'date-time' },
      tags: { type: 'array', items: { type: 'string' } }, author, media,
      metrics: { type: 'object', properties: { ...Object.fromEntries(['views', 'impressions', 'liked', 'collected', 'comments', 'shared'].map(key => [key, metric])), engaged: { ...metric, deprecated: true, description: '仅历史补数交付可能包含；新详情请求不自动补数。' } } },
    } },
  }, '默认缓存优先，deliveryMode=refresh 明确获取最新数据；详情采集平滑排队，默认间隔至少 5 秒，预计等待达到 60 秒返回 429 external_platform_busy 和 Retry-After。可确认未计费的详情拒绝最多重试一次，未知结果不重试。仅查询原详情；指标缺失或全为零都不会自动查询博主列表或补数。需要其他指标时，由用户调用 /data/xiaohongshu/users/notes/analytics 并指定 user_id 和页码。meta.tagsAvailable=false 时不要当作无标签，可继续使用完整正文与标签接口。查无结果返回 meta.status=no_data、data.item=null，仍计一次成功调用；不要因此自动重试。旧幂等标识保留历史交付，可能含 metricsSupplement；新请求不会命中旧自动补数快照。'],
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
          ...(path === 'detail' ? { tagsAvailable: { type: 'boolean' }, recommendedIntervalSeconds: { const: 5 },
            metricSources: { type: 'object', deprecated: true, description: '仅历史交付重放。', additionalProperties: { enum: ['detail', 'blogger_notes_v2', null] } },
            metricsSupplement: { type: 'object', deprecated: true, description: '仅历史自动补数交付重放；新详情请求不包含此字段。', properties: {
              status: { enum: ['matched', 'missing_author', 'not_configured', 'not_found', 'repeated_page', 'page_limit', 'time_limit', 'cancelled', 'temporarily_unavailable'], description: '全部状态仅用于历史自动补数交付重放。' },
              pagesFetched: { type: 'integer', minimum: 0 }, total: metric,
              matchedPage: { type: 'integer', minimum: 1 }, collectedAt: { type: 'string', format: 'date-time' },
            } },
          }
            : { page: { type: 'integer', minimum: 1, maximum: 15 }, paginationStatus: { enum: ['continuable', 'exhausted', 'unknown', 'limit_reached'] } }),
        } },
      },
    } } } },
    ...Object.fromEntries([400, 401, 403, 405, 409, 429, 502, 503].map(status => [status, { description: 'Hub 错误码与 requestId；结果不确定时保留原幂等标识，先查请求状态。', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } }])),
  },
} }]))
xhsResearchPaths['/data/xiaohongshu/users/notes/analytics'] = { post: {
  operationId: 'xiaohongshuUserNoteAnalytics', tags: ['Data products'], summary: '按用户 ID 获取一页笔记与指标',
  description: `${commonDescription} 与按 note_id 查详情的接口并列，共用 social.posts.analytics 权限，客户计费键独立为 social.users.notes.analytics（每页一次）；原详情仍用 social.posts.analytics（每次一次）。输入 user_id，每次实时查询指定一页；无固定页数上限，不自动翻页、补详情或重试上游。返回 total 与 nextPage，空页停止；total 未提供时 hasMore=null，非空页可按 nextPage 显式继续。新页更换幂等标识；同参数原标识仍重放原交付。未提供的点赞/评论/分享为 null，engaged 是总互动量，不能反推各项。此列表不保证包含完整正文。服务未配置时返回 503，管理员需核对该分页服务的独立采购价格。`,
  'x-mx-required-platform': 'xiaohongshu', 'x-mx-required-capabilities': ['social.posts.analytics'],
  'x-mx-billing-meter': 'social.users.notes.analytics',
  parameters: xhsResearchPaths['/data/xiaohongshu/notes/detail'].post.parameters,
  requestBody: { required: true, content: { 'application/json': { schema: {
    type: 'object', additionalProperties: false, required: ['user_id'], properties: {
      user_id: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' },
      page_number: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, default: 1 },
      page_size: { type: 'integer', minimum: 1, maximum: 8, default: 8 },
      note_type: { type: 'integer', enum: [0, 1, 2], default: 0, description: '0 全部，1 图文，2 视频。' },
      order_type: { type: 'integer', enum: [1, 2, 3], default: 1, description: '1 最新，2 阅读最多，3 互动最多。' },
    },
  }, example: { user_id: '624560f5000000000100ffab', page_number: 1, page_size: 8, note_type: 0, order_type: 1 } } } },
  responses: { ...xhsResearchPaths['/data/xiaohongshu/notes/detail'].post.responses,
    200: { description: '一页笔记与指标，或已确认空页；均计一次成功调用。', content: { 'application/json': { schema: {
      type: 'object', required: ['code', 'meta', 'data'], properties: {
        code: { const: 200 }, meta: { type: 'object', properties: { status: { enum: ['ok', 'no_data'] }, collectedAt: { type: 'string', format: 'date-time' } } },
        data: { type: 'object', properties: {
          userId: { type: 'string' }, page: { type: 'integer', minimum: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 8 },
          total: metric, nextPage: { type: ['integer', 'null'], minimum: 2 }, hasMore: { type: ['boolean', 'null'] },
          items: { type: 'array', items: { type: 'object', properties: {
            platform: { const: 'xiaohongshu' }, externalId: { type: 'string' }, url: { type: 'string' },
            title: nullableText, text: nullableText, type: { enum: ['image', 'video', null] },
            publishedAt: nullableText, collectedAt: { type: 'string', format: 'date-time' }, author, media,
            metrics: { type: 'object', properties: Object.fromEntries(['views', 'impressions', 'collected', 'engaged', 'liked', 'comments', 'shared'].map(key => [key, metric])) },
          } } },
        } },
      },
    } } } },
  },
} }
export const xhsResearchGuide = `<h3>关键词 → 热门笔记 → 阅读量与评论</h3>
<p>搜索笔记可用 sort_type=popularity_descending（点赞热度）、comment_descending（评论最多）和 time_filter；结果是关键词相关笔记，不代表全站热榜。取列表的笔记 ID，再按需要分别请求下列接口。</p>
<p><code>POST /api/v1/data/xiaohongshu/notes/detail</code>：JSON <code>{"note_id":"6a20edfa0000000021020951"}</code>；需 <code>social.posts.analytics</code>。返回 <code>data.item.text</code>、媒体、<code>metrics.views</code> 阅读量和 <code>metrics.impressions</code> 曝光量。缺失指标为 null。标签未提供时仍可调用原完整正文与标签入口。</p>
<p><code>POST /api/v1/data/xiaohongshu/users/notes/analytics</code>：JSON <code>{"user_id":"624560f5000000000100ffab","page_number":1,"page_size":8,"note_type":0,"order_type":1}</code>；与详情共用 <code>social.posts.analytics</code>。每次实时查询指定的一页博主笔记与指标，返回 <code>data.items / total / nextPage</code>。不自动翻页，页码无固定上限；下一页更换请求标识，空页停止。每页成功请求（含空页）独立计一次客户用量。原“获取用户笔记”接口及其游标、权限保持不变。</p>
<p>按 note_id 查询详情不会自动补数，即使阅读/曝光缺失或全为零。需要阅读、曝光、收藏、总互动量时，用户自行调用 user_id 列表接口并分页寻找目标笔记。旧幂等标识仍重放历史交付（可能含 metricsSupplement）；新建请求才执行当前合同。两个入口使用同一授权能力；详情按 social.posts.analytics 计价，博主列表按 social.users.notes.analytics 每页独立计价。</p>
<p>详情默认 <code>deliveryMode=cache_first</code>，有效缓存直接返回；<code>refresh</code> 强制实时。服务器按上游凭据排队，默认间隔至少 <strong>5 秒</strong>、等待上限 60 秒，队列满返回 429 和 Retry-After；确认未计费的拒绝最多重试一次，超时或未知结果不重试。缓存交付仍按调用者套餐计费，合并采集不会共享其他用户的权限或计费身份。无结果 <code>meta.status=no_data</code> 也计一次成功请求；不要自动重试。每次成功请求按已分配套餐计费。</p>
<p><code>POST /api/v1/data/xiaohongshu/notes/comments</code>：JSON <code>{"note_id":"6a20edfa0000000021020951","sort":"hot"}</code>；需 <code>social.comments.list</code>。返回 <code>data.items</code> 和 <code>data.nextCursor</code>。下一页传 <code>cursor</code>，保留相同 note_id/sort 并换用新 Idempotency-Key；只在 nextCursor 非空时继续，最多 15 页。回复仅展示已取得部分。</p>
<pre>curl -X POST "$HUB_URL/api/v1/data/xiaohongshu/notes/detail" \\
  -H "Authorization: Bearer $HUB_KEY" -H "Content-Type: application/json" \\
  -H "Idempotency-Key: note-detail-request-001" \\
  --data '{"note_id":"6a20edfa0000000021020951"}'</pre>`
