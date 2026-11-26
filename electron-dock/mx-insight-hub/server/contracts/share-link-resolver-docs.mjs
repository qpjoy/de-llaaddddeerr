import { SHARE_LINK_LIMITS as limits, SHARE_LINK_RESOLVER as product } from '../../shared/share-link-resolver.mjs'

const platform = { type: 'string', enum: ['douyin', 'xiaohongshu'] }
const text = { type: 'string' }
const link = { type: ['string', 'null'], description: '提取到的分享链接。文案缺少网址时为 null。' }
const count = { type: 'integer', minimum: 0, maximum: limits.maxLinks }
const resolved = {
  type: 'object', required: ['ok', 'link', 'type', 'postId', 'how'],
  properties: {
    ok: { const: true }, link, type: text, postId: { type: 'string', description: '用于详情查询的 ID，保留完整字符串。' },
    how: { enum: ['direct', 'redirect', 'body-scan'] }, uncertain: { type: 'boolean' },
  },
  oneOf: [
    { required: ['platform', 'aweme_id'], properties: { platform: { const: 'douyin' }, aweme_id: text,
      author_uid: { type: 'string', description: '分享地址带有作者 UID 时返回。' } } },
    { required: ['platform', 'note_id'], properties: { platform: { const: 'xiaohongshu' }, note_id: text, xsec_token: text } },
  ],
}
const failed = {
  type: 'object', required: ['ok', 'platform', 'link', 'code', 'error'],
  properties: { ok: { const: false }, platform, link, type: text, code: text, error: text },
}
const requestExample = { text: '分享作品 https://www.douyin.com/note/7711088087472025201' }
const jsonResponse = schema => ({ 'application/json': { schema } })
export const shareLinkPaths = {
  [product.apiPath.slice('/api/v1'.length)]: { post: {
    tags: ['External Data'], operationId: 'resolveShareLinks', summary: '解析抖音作品 ID 和小红书笔记 ID',
    'x-mx-required-platform': product.platform, 'x-mx-required-capabilities': [product.capability],
    'x-mx-doc-path': `/docs/${product.docs}`,
    description: '需要显式开通解析能力的 Live 快照 Key。一次请求可提交混合平台的分享文案。完整链接就地读取 ID，短链跟随平台跳转。每次解析计一次调用额度，费用按租户套餐或默认策略结算。查看作品详情需要另行授权并主动查询。',
    requestBody: { required: true, content: { 'application/json': {
      example: requestExample,
      schema: { type: 'object', required: ['text'], additionalProperties: false, properties: {
        text: { type: 'string', minLength: 1, maxLength: limits.maxTextLength, description: `最多 ${limits.maxLinks} 个不同的分享链接。` },
        platform: { type: 'string', enum: ['auto', ...platform.enum], default: 'auto', description: '选择单个平台时，其他平台链接会给出逐条失败原因。' },
      } },
    } } },
    responses: {
      200: { description: '按文案中的链接顺序返回，重复链接只处理一次。可同时包含成功和失败结果。', content: jsonResponse({
        type: 'object', required: ['data', 'requestId'], properties: { requestId: text, data: {
          type: 'object', required: ['results', 'total', 'succeeded', 'failed'], properties: {
            total: count, succeeded: count, failed: count, results: { type: 'array', maxItems: limits.maxLinks, items: { oneOf: [resolved, failed] } },
          },
        } },
      }) },
      ...Object.fromEntries(Object.entries({
        400: '文本、平台或链接数不符合输入要求。', 401: '请提供有效的 Hub API Key。',
        403: '当前 Key 的类型、平台或解析权限不满足要求。', 413: '请求体过大。', 429: '已达到请求限制或调用额度。',
      }).map(([status, description]) => [status, { description, content: jsonResponse({ $ref: '#/components/schemas/ErrorEnvelope' }) }])),
    },
  } },
}

export const shareLinkGuide = `<h1>${product.label}</h1>
<p>粘贴一段或多段分享文案，即可提取抖音作品 ID 和小红书笔记 ID。多个平台的链接可以一起提交。</p>
<h2>调用</h2><p><code>POST ${product.apiPath}</code> 使用 JSON 请求体。Live 快照 Key 需要 <code>${product.platform}</code> 平台与 <code>${product.capability}</code> 权限。每次请求计一次调用额度，费用按租户套餐或默认策略结算。</p>
<pre>${JSON.stringify(requestExample, null, 2)}</pre>
<p><code>text</code> 最长 ${limits.maxTextLength} 个 UTF-16 码元，每次最多 ${limits.maxLinks} 个不同链接。可选参数 <code>platform</code> 默认为 <code>auto</code>，也支持 <code>douyin</code>、<code>xiaohongshu</code>。</p>
<h2>读取结果</h2><p>从 <code>data.results</code> 逐项检查 <code>ok</code>。成功项的 <code>postId</code> 为字符串，分别与 <code>aweme_id</code> 或 <code>note_id</code> 相同。小红书链接带有 <code>xsec_token</code> 时可一并返回。<code>how</code> 记录 ID 来自完整网址、短链跳转还是页面源码；带有 <code>uncertain</code> 标记的候选需要复核。</p>
<p>失败项给出 <code>code</code> 和 <code>error</code>。在产品页面粘贴带链接的标题时，会一并提取剪贴板中的作品网址。纯文本缺少网址时，疑似抖音口令返回 <code>share_code_requires_lookup</code>，含“小红书”的文案返回 <code>share_link_required</code>。请从原作品的分享菜单复制链接。没有识别到平台或链接时结果为空。解析出 ID 只表示已识别链接，作品当前是否可读取，要在查询详情时确认。</p>
<h2>调用限流</h2><p>HTTP 429 的 <code>plan_burst_exceeded</code> 表示 Hub 在解析前检查到调用方的套餐一秒额度已满，多把 Key 共用该额度。Hub 会短暂等候即将释放的名额，持续超额时返回等待提示 <code>error.details.retryAfterMs</code>。<code>resource_admission_limited</code> 表示 Hub 的资源限制，可通过 <code>error.details.reason</code> 区分速率（<code>rate</code>）与并发（<code>concurrency</code>）等原因。</p>
<h2>查询详情</h2><p>小红书可进入「小红书笔记画卷」查看正文与标签，也可按笔记 ID 查询详情与阅读量。抖音可进入「社媒与内容数据」，使用获取单个作品的接口。两者均需对应产品的权限，手动提交后按该产品规则计费。</p>`
