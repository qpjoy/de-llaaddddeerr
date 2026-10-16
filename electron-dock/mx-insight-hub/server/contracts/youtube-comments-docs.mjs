import { YOUTUBE_COMMENT_PATHS, YOUTUBE_COMMENTS_CAPABILITY, YOUTUBE_COMMENTS_VERSION } from './youtube-comments.mjs'

const text = { type: 'string', minLength: 1, maxLength: 8192 }
const count = { type: 'integer', minimum: 1, maximum: 100 }
const options = {
  sortBy: { type: 'string', enum: ['top', 'newest'], default: 'top' }, sort_by: { type: 'string', enum: ['top', 'newest'] },
  languageCode: { type: 'string', default: 'zh-CN' }, language_code: { type: 'string' },
  countryCode: { type: 'string', default: 'US' }, country_code: { type: 'string' },
}
const page = { type: 'object', required: ['hasMore', 'nextCursor', 'returnedCount'], properties: {
  page: { type: 'integer', minimum: 1, maximum: 15 }, pageSize: count,
  returnedCount: { type: 'integer', minimum: 0 }, hasMore: { type: 'boolean' },
  nextCursor: { type: ['string', 'null'] }, providerCursor: { type: ['string', 'null'], description: 'nextCursor 的兼容别名，仍是 Hub 游标。' },
}, additionalProperties: true }
const comments = { type: 'array', items: { type: 'object', additionalProperties: true,
  description: '评论业务投影；videoId 关联所属视频。供应商未返回的指标为 null，明确取得的零为 0；publishedTime 保留原文，不把相对时间伪造为确定时间。' } }

export const youtubeCommentsPaths = Object.fromEntries(Object.entries(YOUTUBE_COMMENT_PATHS).map(([kind, path]) => {
  const ids = kind === 'video' ? ['videoId', 'video_id', 'postId', 'post_id', 'contentId', 'content_id', 'url']
    : ['channelId', 'channel_id', 'channelUrl', 'channel_url', 'url']
  return [path.slice('/api/v1'.length), { post: {
    tags: ['社媒与内容数据'], operationId: `youtube_${kind}_comments`,
    summary: kind === 'video' ? 'YouTube 按视频取评论' : 'YouTube 频道视频的评论',
    'x-mx-required-platform': 'youtube', 'x-mx-required-capabilities': [YOUTUBE_COMMENTS_CAPABILITY],
    'x-mx-data-platform': 'youtube', 'x-mx-category': 'YouTube', 'x-mx-meter-key': YOUTUBE_COMMENTS_CAPABILITY,
    'x-mx-doc-path': '/docs/social-content',
    description: 'Hub 直接调用已审核的上游数据合同，不经过 Night-All。每个成功交付请求按 social.comments.list 结算一次；内部采购逐调用独立记账。maxComments 是整个响应的评论上限，不是每视频上限；全量已取得原始页归档、规范化入库，溢出评论保存在本轮分页状态中。一次遍历最多 15 个数据上游页和 15 个响应页，另允许一次频道解析；游标有效期 24 小时。hasMore=false 伴随 warnings 不证明供应商数据已耗尽。需要 youtube 平台、social.comments.list 能力及相关采购操作的凭据、价格和启用状态；不自动扩大授权。旧 Night-All/原生供应商游标不能混用，无故障回退或自动重试。',
    parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 128 },
      description: '同一逻辑页重试保持原标识和请求体；下一页使用新标识。未知结果先查原请求，不能换标识盲重试。' }],
    requestBody: { required: true, content: { 'application/json': {
      schema: { type: 'object', additionalProperties: false, anyOf: ids.map(name => ({ required: [name] })), properties: {
        ...Object.fromEntries(ids.map(name => [name, text])), platform: { const: 'youtube' },
        businessId: { type: 'string', description: '可省略；提交时须与当前消费者绑定值相同。' }, business_id: { type: 'string' },
        maxComments: { ...count, default: 50, description: '本响应全部视频合计的评论上限，仍受 Key 页大小上限约束；不足不证明结束。' },
        max_comments: count, count, pageSize: count, limit: count,
        ...(kind === 'channel' ? { maxVideos: { type: 'integer', minimum: 1, maximum: 20, default: 5,
          description: '本轮选择的频道视频窗口，不是整个频道历史；每次续页保持不变。' }, max_videos: { type: 'integer', minimum: 1, maximum: 20 } } : {}),
        ...options, params: { type: 'object', additionalProperties: false, properties: options },
        includeRaw: { type: 'boolean', default: false, description: '只影响已声明的业务字段；不暴露原始供应商审计包或凭据。' },
        cursor: { ...text, description: '原样使用 data.pageInfo.nextCursor；保持身份、参数、上限和 Key 不变。' },
        page: { type: 'integer', minimum: 1, maximum: 15, default: 1 },
      }, description: '多个同义字段同时出现必须等价；频道接口不接受视频 URL。params 仅支持排序、语言、地区，不能提交原生 continuation_token、provider 或上游路径。' },
      example: kind === 'video' ? { videoId: 'dQw4w9WgXcQ', maxComments: 50 }
        : { channelUrl: 'https://www.youtube.com/@example', maxVideos: 5, maxComments: 50 },
    } } },
    responses: Object.fromEntries([200, 400, 401, 402, 403, 409, 429, 502, 503].map(status => [status, {
      description: status === 200 ? '本页评论及 Hub 分页状态。频道 results 按视频分组，只含本页评论；顶层游标控制继续。partial 或 warnings 应保留展示，不能当作成功空列表。'
        : '稳定错误码和 requestId；失败或未知不自动重试，也不回退 Night-All。',
      ...(status === 200 ? { content: { 'application/json': { schema: { type: 'object', required: ['contractVersion', 'data', 'requestId'], properties: {
        contractVersion: { const: YOUTUBE_COMMENTS_VERSION }, requestId: { type: 'string', format: 'uuid' },
        data: { type: 'object', required: ['platform', 'items', 'raw_data', 'page', 'pageInfo', 'status', 'warnings'], properties: {
          platform: { const: 'youtube' }, items: comments, comments,
          raw_data: { type: 'string', description: '本页 items 的 JSON 字符串，兼容下游记录计数。' }, raw_info: { const: '[]' },
          page, pageInfo: page, status: { enum: ['ok', 'partial'] }, warnings: { type: 'array', items: { type: 'object', additionalProperties: true } },
          results: { type: 'array', items: { type: 'object', additionalProperties: true } },
          meta: { type: 'object', additionalProperties: true },
        }, additionalProperties: true },
      } } } } } : {}),
    }])),
  } }]
}))

export function youtubeCommentsGuide(allowed = () => true) {
  const rows = Object.entries(youtubeCommentsPaths).filter(([path]) => allowed(path))
  if (!rows.length) return ''
  return `<h2>YouTube 评论</h2><table><thead><tr><th>用途</th><th>POST 接口</th></tr></thead><tbody>${rows.map(([path, value]) => `<tr><td>${value.post.summary}</td><td><code>/api/v1${path}</code></td></tr>`).join('')}</tbody></table>
  <p>按帖子取评论使用 videoId、postId 或视频 URL；频道入口接受 channelId/channelUrl，先选择最多 maxVideos 个视频。maxComments 限制整个响应的评论总数（默认 50、最大 100，并受 Key 限制），不是每视频上限。旧 Night-All 频道接口会忽略 maxComments，新接口实际执行此限制。</p>
  <p>两者需要 youtube 平台及 social.comments.list 能力，按成功交付请求结算。data.items 为评论数组，data.raw_data 为同一数组的 JSON 字符串；频道 results 按视频分组。使用 data.pageInfo.nextCursor 继续，保持参数不变并为下一页使用新 Idempotency-Key；原请求重试保持原标识。保留 partial/warnings，不按返回条数判断结束。旧游标不能导入，不自动展开评论回复，不回退 Night-All。</p>
  <p>单视频示例：<code>{"videoId":"dQw4w9WgXcQ","maxComments":50}</code>。频道示例：<code>{"channelUrl":"https://www.youtube.com/@example","maxVideos":5,"maxComments":50}</code>。生产开放还需凭据、相关采购操作与审核价格；接口文档可见不代表已启用。</p>`
}
