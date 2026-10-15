import { WEB_SEARCH_PROVIDERS, WEB_SEARCH_VERSION } from '../../shared/web-search.mjs'

const providerKeys = WEB_SEARCH_PROVIDERS.map(provider => provider.key)
const recencies = ['week', 'month', 'semiyear', 'year', 'noTimeLimit']
const resourceLimits = { web: 50, image: 30, video: 10 }
const dateSchema = { type: 'string', format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }
const sitesSchema = {
  type: 'array', maxItems: 20,
  description: '域名数组，如 example.com，不带协议、路径或通配符。空数组表示不限制。',
  items: { type: 'string', pattern: '^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\\.)+[a-zA-Z]{2,63}$' },
}
const resourcesSchema = limitField => ({
  type: 'array', minItems: 1, maxItems: 3,
  description: '每种 type 只能出现一次。百度 web/image/video 上限分别为 50/30/10；其余渠道只支持 web，最多 20。所有结果数量之和受当前 Key 页大小额度限制。',
  items: {
    type: 'object', required: ['type', limitField], additionalProperties: false,
    properties: { type: { type: 'string', enum: Object.keys(resourceLimits) }, [limitField]: { type: 'integer', minimum: 1, maximum: 50 } },
    oneOf: Object.entries(resourceLimits).map(([type, maximum]) => ({ properties: { type: { const: type }, [limitField]: { maximum } } })),
  },
})
const searchSchema = {
  type: 'object', required: ['query'], additionalProperties: false,
  not: { required: ['limit', 'resources'] },
  description: 'JSON 正文，不接受 URL 查询参数。limit 与 resources 互斥；from/to 成对且 from ≤ to，不能与有效 recency 同用；站点/日期筛选要求包含 web。',
  properties: {
    query: { type: 'string', minLength: 1, maxLength: 2000, description: '非空搜索文本，去除首尾空白，不允许 NUL。' },
    provider: { type: 'string', enum: providerKeys, description: '可选固定渠道。省略时按 capabilities.data.order 在派发前选择首个就绪且支持参数的渠道；百度不是强制全局默认。' },
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: '仅网页数量上限，非百度最多 20，不保证返回足量。未传 resources 时使用。' },
    resources: resourcesSchema('limit'),
    edition: { type: 'string', enum: ['standard', 'lite'], default: 'standard', description: 'lite 仅百度支持；其他渠道接受 standard 默认值，不发送百度 edition 参数。' },
    sites: sitesSchema,
    from: { ...dateSchema, description: '百度网页起始日期，须同时提供 to；不用时省略，不能传空字符串。' },
    to: { ...dateSchema, description: '百度网页结束日期，须同时提供 from，且不早于 from。' },
    recency: { type: 'string', enum: recencies, description: '百度网页相对时间范围；noTimeLimit 等同不筛选。有效范围不可与 from/to 同用。' },
  },
}
const baiduSchema = {
  type: 'object', required: ['messages'], additionalProperties: false,
  description: '仅兼容已列出的百度输入字段；响应始终使用 Hub 合同。不能传 stream、model、tools 或多轮 messages。',
  properties: {
    messages: { type: 'array', minItems: 1, maxItems: 1, items: {
      type: 'object', required: ['role', 'content'], additionalProperties: false,
      properties: { role: { type: 'string', enum: ['user'] }, content: searchSchema.properties.query },
    } },
    resource_type_filter: resourcesSchema('top_k'), edition: searchSchema.properties.edition,
    search_filter: { type: 'object', additionalProperties: false, properties: {
      match: { type: 'object', additionalProperties: false, properties: { site: sitesSchema } },
      range: { type: 'object', additionalProperties: false, properties: {
        page_time: { type: 'object', additionalProperties: false, properties: {
          gte: { type: 'string', description: 'YYYY-MM-DD；与 lte 成对。两者均为空字符串时表示不筛选。' },
          lte: { type: 'string', description: 'YYYY-MM-DD；不得早于 gte。' },
        } },
      } },
    } },
    search_recency_filter: searchSchema.properties.recency,
  },
}
// Keep the executable default valid for every granted provider subset.
// Baidu-specific examples belong in the explanatory guide and guarded alias.
const searchExample = { query: '人工智能', limit: 10 }
const resourceExample = { query: '新能源汽车', provider: 'baidu', resources: [{ type: 'web', limit: 5 }, { type: 'image', limit: 3 }, { type: 'video', limit: 2 }] }
const capabilitiesExample = { data: {
  contractVersion: WEB_SEARCH_VERSION, order: ['baidu', 'tavily'],
  providers: [
    { key: 'baidu', label: '百度 AI 搜索', resources: ['web', 'image', 'video'], maxResults: 50, ready: true },
    { key: 'tavily', label: 'Tavily', resources: ['web'], maxResults: 20, ready: false },
  ],
  defaultAccess: 'explicit', selection: 'pre_dispatch_only',
} }
const responseExample = {
  data: { query: '人工智能', provider: 'baidu', items: [{ type: 'web', title: '示例资料', url: 'https://example.com/article', snippet: '示例摘要；此处不是线上搜索结果。', publishedAt: null }] },
  meta: { contractVersion: WEB_SEARCH_VERSION, capturedAt: '2026-10-13T02:00:00.000Z', empty: false, fullText: false,
    servedAt: '2026-10-13T02:00:01.000Z', sourceMode: 'live', ageSeconds: 1 },
  requestId: '00000000-0000-4000-8000-000000000001',
}
const resultSchema = {
  type: 'object', required: ['data', 'meta', 'requestId'], properties: {
    data: { type: 'object', required: ['query', 'provider', 'items'], properties: {
      query: { type: 'string' }, provider: { type: 'string', enum: providerKeys },
      items: { type: 'array', description: '允许空数组；不提供页码、cursor 或自动翻页。数量是上限，不承诺补足。', items: {
        type: 'object', required: ['type', 'title', 'url', 'snippet', 'publishedAt'], properties: {
          type: { type: 'string', enum: ['web', 'image', 'video'] }, title: { type: 'string', maxLength: 2000 },
          url: { type: 'string', format: 'uri', pattern: '^https?://' },
          snippet: { type: 'string', maxLength: 8000, description: '摘要；可能为空，不是网页全文。' },
          publishedAt: { type: ['string', 'null'], description: '原始日期文本或 null；不保证 ISO 格式或时区。' },
        },
      } },
    } },
    meta: { type: 'object', required: ['contractVersion', 'capturedAt', 'empty', 'fullText', 'servedAt', 'sourceMode', 'ageSeconds'], properties: {
      contractVersion: { type: 'string', const: WEB_SEARCH_VERSION },
      capturedAt: { type: 'string', format: 'date-time', description: '采集记录时间，不是来源页面发布时间。' },
      servedAt: { type: 'string', format: 'date-time', description: '原交付生成时间，精确回放不刷新。' },
      sourceMode: { type: 'string', enum: ['live'], description: '原交付来源；回放保持原正文，须读取 idempotent-replay 响应头判断本次是否回放。' },
      ageSeconds: { type: 'integer', minimum: 0 }, empty: { type: 'boolean' }, fullText: { type: 'boolean', const: false },
      reason: { type: 'object', additionalProperties: true, description: '可选交付说明；客户端应容忍新增元数据。' },
    } },
    requestId: { type: 'string', format: 'uuid', description: '原持久请求 ID，可用于 GET /api/v1/requests/{requestId} 核对。' },
  },
}
const capabilitySchema = { type: 'object', required: ['data'], properties: { data: {
  type: 'object', required: ['contractVersion', 'order', 'providers', 'defaultAccess', 'selection'], properties: {
    contractVersion: { type: 'string', const: WEB_SEARCH_VERSION },
    order: { type: 'array', items: { type: 'string', enum: providerKeys }, description: '当前 Key 的有效顺序。可能为空；不是始终以百度开头。' },
    providers: { type: 'array', items: { type: 'object', required: ['key', 'label', 'resources', 'maxResults', 'ready'], properties: {
      key: { type: 'string', enum: providerKeys }, label: { type: 'string' },
      resources: { type: 'array', items: { type: 'string', enum: ['web', 'image', 'video'] } },
      maxResults: { type: 'integer', description: '网页上限，不是 Key 总额度。百度图片/视频上限另为 30/10。' },
      ready: { type: 'boolean', description: '当前配置预检查结果，不保证下一次请求的余额、预算、并发、网络或业务结果。' },
    } } },
    defaultAccess: { type: 'string', const: 'explicit' }, selection: { type: 'string', const: 'pre_dispatch_only' },
  },
} } }
const errorSchema = { type: 'object', required: ['error', 'requestId'], properties: {
  error: { type: 'object', required: ['code', 'message'], properties: {
    code: { type: 'string' }, message: { type: 'string' }, details: { type: 'object', additionalProperties: true },
  } }, requestId: { type: 'string', format: 'uuid' },
} }
const errorDescriptions = {
  400: '参数不合法：idempotency_key_required、invalid_web_search_request、invalid_web_search_provider、web_search_options_unsupported 或 page_size_exceeded。',
  401: 'Hub Key 缺失、无效或过期。',
  402: '账户计费或余额准入未通过；以 error.code 为准。',
  403: 'web_search_not_granted、web_search_provider_not_granted、platform_not_granted、capability_not_granted 或 test_key_not_supported。',
  409: 'idempotency_conflict、request_in_progress 或 request_outcome_unknown；保留原参数和标识，先核对状态。',
  429: '请求额度、并发、限流或渠道拒绝；以 error.code 为准，不自动换标识重试。',
  502: 'web_search_upstream_rejected、web_search_upstream_outcome_unknown 或 web_search_upstream_response_unusable；派发后不自动换渠道。',
  503: 'web_search_no_ready_provider、web_search_unavailable、web_search_egress_unavailable 或操作、预算、熔断等准入阻断。',
}
const errorResponses = Object.fromEntries(Object.entries(errorDescriptions).map(([status, description]) => [status, {
  description, content: { 'application/json': { schema: errorSchema } },
}]))
const resultHeaders = {
  'idempotent-replay': { description: 'true 表示精确回放原交付，false 表示首次交付。错误响应不保证携带此头。', schema: { type: 'string', enum: ['true', 'false'] } },
  'x-mx-insight-request-id': { description: '原持久请求 UUID。', schema: { type: 'string', format: 'uuid' } },
  'x-mx-insight-source-mode': { description: '回放时为 idempotent_replay，正文仍保持原值。', schema: { type: 'string', enum: ['live', 'idempotent_replay'] } },
}
const responses = { 200: { description: 'Hub 统一结果。空 items 是成功结果，不触发补量、下一渠道或 AI 答案。示例为合成数据。', headers: resultHeaders,
  content: { 'application/json': { schema: resultSchema, example: responseExample } } }, ...errorResponses }
const parameter = {
  name: 'Idempotency-Key', in: 'header', required: true,
  description: '同一业务意图保存同一标识和请求正文。建议字母或数字开头，便于状态查询；新标识表示新的潜在计费意图。',
  schema: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9._:-]{8,128}$' }, example: 'delta-web-20261013-001',
}
const base = { tags: ['Web Search'], 'x-mx-required-platform': 'web_search', 'x-mx-required-capabilities': ['web.search'], 'x-mx-doc-path': '/docs/web-search' }
export const webSearchPaths = {
  '/data/web-search/search': { post: {
    ...base, operationId: 'webSearch', summary: '全网搜索',
    description: '使用 Hub Live API Key 显式提交一次搜索。省略渠道按当前授权顺序选择，固定渠道仅尝试该渠道。派发后超时、失败或空结果均不自动重试或切换。回放沿用原 Key、参数与 Idempotency-Key；未知结果先用请求状态 GET 核对。无分页、全文抓取或 AI 答案生成。',
    parameters: [parameter], 'x-mx-meter-key': 'web.search',
    requestBody: { required: true, content: { 'application/json': { schema: searchSchema, example: searchExample } } }, responses,
  } },
  '/data/web-search/capabilities': { get: {
    ...base, operationId: 'webSearchCapabilities', summary: '当前 Key 的搜索渠道与顺序',
    description: '使用 Hub Key 读取当前有效权限和配置状态，不触发搜索或搜索计费。不需要 Idempotency-Key，不接受查询参数。无权限时可返回空 order/providers；ready=false 表示已获授权但尚未就绪。',
    responses: { 200: { description: '当前 Key 实时视图；示例不代表任何线上账户的实际权限或就绪状态。',
      headers: { 'cache-control': { schema: { type: 'string' }, description: 'private, no-store' } },
      content: { 'application/json': { schema: capabilitySchema, example: capabilitiesExample } } },
    400: errorResponses[400], 401: errorResponses[401], 403: errorResponses[403], 503: errorResponses[503] },
  } },
  '/data/web-search/compatible/baidu': { post: {
    ...base, 'x-mx-required-capabilities': ['web.search', 'web.search.provider.baidu'],
    operationId: 'webSearchBaiduInput', summary: '百度请求形状接入 · Hub 统一响应',
    description: '接受单条 user message 及已列出的百度搜索字段。仍使用 Hub Live API Key，返回 data.items，不返回百度原生 references。与显式固定百度的统一请求在规范化语义相同、同 Key、同幂等标识时共用交付；省略渠道的请求是不同意图。',
    parameters: [parameter], 'x-mx-meter-key': 'web.search',
    requestBody: { required: true, content: { 'application/json': { schema: baiduSchema,
      example: { messages: [{ role: 'user', content: '人工智能' }], resource_type_filter: [{ type: 'web', top_k: 10 }], edition: 'standard' },
    } } }, responses,
  } },
}

const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const code = value => `<pre><code>${escape(value)}</code></pre>`
const json = value => code(JSON.stringify(value, null, 2))
const table = (headers, rows) => `<table><thead><tr>${headers.map(v => `<th>${escape(v)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(v => `<td>${escape(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
const curlSearch = `# 保存此标识和正文；核对/重试不要重新生成标识。
HUB_URL='https://hub.minsight-ai.com'
IDEMPOTENCY_KEY='delta-web-20261013-001'
curl --max-time 60 -i "$HUB_URL/api/v1/data/web-search/search" \\
  -H "Authorization: Bearer $HUB_API_KEY" \\
  -H 'Content-Type: application/json' \\
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \\
  --data '{"query":"人工智能","provider":"baidu","limit":10}'`

export const webSearchGuide = `<h2>Web Search · Delta 接入</h2>
<p>Hub 提供一次性网页、图片和视频搜索，返回来源链接与摘要。Delta 只保存 <strong>Hub Live API Key</strong>，以 <code>Authorization: Bearer &lt;Hub Key&gt;</code> 调用；渠道凭据由 Hub 管理。所有示例均为合成数据，不代表线上账户已授权或渠道已验收。本页与 <a href="/docs/openapi.json">OpenAPI</a> 属于登录后的控制台文档，可从「接口文档」进入；业务 API 使用 Hub Key。</p>
<h3>1. 先读取当前 Key 的能力</h3>
${code(`curl -sS 'https://hub.minsight-ai.com/api/v1/data/web-search/capabilities' \\
  -H "Authorization: Bearer $HUB_API_KEY"`)}
${json(capabilitiesExample)}
<p>此 GET 不调用搜索、不需要幂等头、不接受查询参数。<code>order</code> 是当前 Key 的顺序；<code>providers</code> 只列当前有效授权渠道。空数组表示尚未开放。<code>ready=false</code> 表示已授权但配置未就绪，应由管理员检查渠道凭据与操作配置；无需重复授权。<code>ready=true</code> 只是当前预检查通过，发送时仍检查额度、余额、预算、并发与网络。</p>
<p>新租户与普通新 Key 默认没有搜索权限，需要 <code>web_search</code>、<code>web.search</code> 及所选 <code>web.search.provider.&lt;渠道&gt;</code> 的 Consumer/Key 有效交集。管理员维护的特殊托管 Key 按其授权策略处理。Test Key 不可执行真实搜索。</p>
<h3>2. 发送一次搜索</h3>
${code(curlSearch)}
<p>示例固定百度；只有该 Key 已授权且百度已就绪才可执行。移除 <code>provider</code> 按 <code>order</code> 选择首个支持参数且就绪的渠道，<strong>不是始终默认百度</strong>。Key 独立顺序优先，否则沿用租户顺序；排序不授予权限。候选筛选仅在派发前发生，一旦派发，超时、失败和空结果都不会自动换渠道或再次发送。</p>
${table(['方法', '路径', '用途'], [
  ['GET', '/api/v1/data/web-search/capabilities', '读取当前 Key 能力与顺序'],
  ['POST', '/api/v1/data/web-search/search', '统一搜索，JSON 正文 + Idempotency-Key'],
  ['POST', '/api/v1/data/web-search/compatible/baidu', '百度输入形状，仍返回 Hub 统一结果'],
])}
<h3>3. 请求字段与渠道边界</h3>
${table(['字段', '规则'], [
  ['query', '必填，1–2000 字符，不能全为空白或含 NUL；首尾空白会去除。'],
  ['provider', `可选：${providerKeys.join(' / ')}。以 capabilities 为当前权限依据。`],
  ['limit', '默认 10，只请求 web；与 resources 互斥。百度最多 50，其他渠道最多 20。'],
  ['resources', '1–3 个 {type,limit}，type 不可重复；百度 web/image/video 分别最多 50/30/10。总量还受 Key 页大小限制。'],
  ['sites', '最多 20 个域名，如 example.com；不接受 URL、IP 或通配符；空数组不筛选。仅百度。'],
  ['from / to', '成对有效 YYYY-MM-DD，from ≤ to；不用时省略，不传空字符串。仅百度网页。'],
  ['recency', 'week / month / semiyear / year；noTimeLimit 等同省略。不可与有效 from/to 同用。仅百度网页。'],
  ['edition', 'standard（默认）或 lite。lite 仅百度；其他渠道接受 standard 默认值。'],
])}
<p>非空站点与时间条件必须请求 web 资源；不保证图片/视频按网页日期过滤。其他七个渠道只支持 web，最多 20 条，不支持百度筛选或 lite；显式选择不支持的渠道会返回 <code>400 web_search_options_unsupported</code>。自动选择会先排除不支持者，没有候选返回 <code>503 web_search_no_ready_provider</code>。未知字段不静默丢弃；不支持 page、cursor、stream、自动全文抓取或 AI 答案生成。</p>
<p>多资源请求示例（合计 10 条上限，不再传 limit）：</p>
${json(resourceExample)}
<h3>4. 读取结果与回放证据</h3>
${json(responseExample)}
<p><code>data.provider</code> 是实际选定渠道。<code>items[].type/title/url/snippet/publishedAt</code> 分别表示类型、标题、HTTP(S) 来源链接、摘要和原日期文本。日期未知为 null，不保证 ISO 格式；摘要可能为空。数量是上限，<code>items=[]</code> 与 <code>meta.empty=true</code> 是正式成功结果，不应自动补搜。<code>capturedAt</code> 是采集记录时间，不是页面发布时间；<code>fullText=false</code>。</p>
${table(['响应头', '含义'], [
  ['x-mx-insight-request-id', '原持久请求 ID，保存用于诊断与状态核对。'],
  ['idempotent-replay', 'true 为回放；false 为首次交付。错误响应不保证提供。'],
  ['x-mx-insight-source-mode', '首次 live，回放 idempotent_replay。'],
])}
<p>相同 Key、相同规范化语义和相同幂等标识回放原交付；正文及原时间保持不变，判断本次回放必须读响应头。渠道顺序变化也不会改变该意图绑定的渠道；当前权限被撤销后回放同样受阻。计费项为 <code>web.search</code>，客户价格以该账户的当前价格为准；文档不声明固定单价。</p>
<h3>5. 超时、错误与状态核对</h3>
<p>为每个业务意图持久保存 Key 身份、请求正文和 8–128 位 <code>Idempotency-Key</code>（字母、数字、点、下划线、冒号或短横线；建议字母/数字开头）。建议客户端总超时从 60 秒起配置，并结合网关环境调整；这不是完成时限保证。客户端超时或连接中断不证明服务端取消，也不证明未计费。不要自动生成新标识或改用另一个渠道。</p>
${code(`# 未收到 requestId 时，用原幂等标识核对；GET 不会发起搜索。
curl -sS "$HUB_URL/api/v1/requests/by-idempotency-key" \\
  -H "Authorization: Bearer $HUB_API_KEY" \\
  -H "Idempotency-Key: $IDEMPOTENCY_KEY"

# 已取得持久 requestId 时：
curl -sS "$HUB_URL/api/v1/requests/$REQUEST_ID" \\
  -H "Authorization: Bearer $HUB_API_KEY"`)}
<p>读取 <code>data.status</code>：<code>reserved</code> 仍在处理中，稍后再查 GET；<code>committed</code> 可用原 Key、原正文与原幂等标识取回原交付（可能是保存的错误，不代表成功）；<code>released</code> 表示原预留已释放，不等于保证可用同一标识重发；<code>unknown</code> 保留未知结果，交给管理员核对，不自动另发。状态接口只返回状态，不返回原搜索正文；按当前 Consumer 隔离。<code>request_not_found</code> 仅表示未找到当前 Consumer 的持久记录，不能据此盲目创建新付费请求。Web Search 未实现电商的 <code>X-MX-Insight-Retry-Of</code> 强制重采流程。</p>
${table(['HTTP', '常见错误与处理'], [
  ['400', 'invalid_web_search_request / idempotency_key_required / web_search_options_unsupported / page_size_exceeded：修正字段或结果总量。'],
  ['401 / 403', '核对 Hub Live Key 状态、Consumer/Key 的搜索及渠道授权；不要传渠道原始 Key。'],
  ['402 / 429', '账户余额、调用额度、并发或限流；保留标识，按 error.code 处理，不自动重新购买。'],
  ['409', 'idempotency_conflict：相同标识不能改参数；request_in_progress / request_outcome_unknown：先查询状态。'],
  ['502', 'web_search_upstream_rejected / web_search_upstream_outcome_unknown / web_search_upstream_response_unusable：保留错误与 requestId，核对原请求。'],
  ['503', 'web_search_no_ready_provider：无符合参数的就绪授权渠道；其他操作/网络/预算阻断请管理员检查。'],
])}
${json({ error: { code: 'request_in_progress', message: 'An equal request is already in progress', details: { requestId: responseExample.requestId } }, requestId: responseExample.requestId })}
<h3>6. 从百度输入形状迁移</h3>
${json(webSearchPaths['/data/web-search/compatible/baidu'].post.requestBody.content['application/json'].example)}
<p>将上例发送至 <code>/api/v1/data/web-search/compatible/baidu</code>，仍使用 Hub Key 和幂等头。只接受一条 user message；<code>resource_type_filter[].top_k</code> 对应 resources[].limit，<code>search_filter.match.site</code> 对应 sites，<code>search_filter.range.page_time.gte/lte</code> 对应 from/to，<code>search_recency_filter</code> 对应 recency。此兼容入口允许 gte/lte 都为空字符串表示不筛选。响应是 Hub 的 <code>data.items</code>，不是百度原生 references。与显式 <code>provider=baidu</code> 的统一请求语义相同时可共用原交付；省略 provider 的自动选择请求是不同意图，不能复用同一标识互换。</p>`
