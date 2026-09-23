import { XHS_DISCOVERY_PRODUCTS, XHS_DISCOVERY_VERSION, XHS_HOT_SORTS, XHS_HOT_WINDOWS } from '../../shared/xiaohongshu-discovery.mjs'
const cursor = { type: 'string', maxLength: 8192, description: '首页省略；下一页原样传 data.pageInfo.nextCursor，保留所有筛选并换新的 Idempotency-Key。绑定当前业务、Key、接口和筛选；最多 15 页。' }
const common = '独立授权的单页实时查询。业务和当前 Live Hub Key 必须同时具备 xiaohongshu 与本操作权限。固定路由，不接受 provider、URL、token、pageNum 或原生游标。必须提供 Idempotency-Key；相同请求重试保留请求体与标识，不再次采集；新查询/续页换标识。成功交付（含空结果）计一次请求，使用客户套餐接口价或租户默认价。传输结果不确定时保留原标识，先查请求状态，不盲目新建请求。data.result 保留原生业务字段（移除凭据、服务传输信息和原生翻页坐标），不是已归一化的笔记 schema；不保证指标、稳定 ID、排名或全站热榜。缺失指标不补零，原始响应归档不会自动转成共享笔记数据。'
export const xhsDiscoveryPaths = Object.fromEntries(XHS_DISCOVERY_PRODUCTS.map(product => [product.path.slice('/api/v1'.length), { post: {
  operationId: product.id === 'hot_notes' ? 'xiaohongshuHotNotes' : 'xiaohongshuCreatorInspirations',
  tags: ['Data products'], summary: product.label, description: `${common} ${product.id === 'hot_notes'
    ? '支持关键词、蒲公英类目路径、3/7/14/30 天与 8 种排序。pageInfo.paginationStatus=next_page_probe 表示可查询下一页但无法确认存在更多内容，hasMore=null；调用下一页可能返回空结果并计费。'
    : '获取创作者热点灵感，不接受热门笔记的筛选参数。只有实际返回可用的新游标时提供 nextCursor，不根据条目数猜测游标。'}`,
  'x-mx-required-platform': 'xiaohongshu', 'x-mx-required-capabilities': [product.operation],
  parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' } }],
  requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, properties: {
    ...(product.id === 'hot_notes' ? {
      searchWord: { type: 'string', maxLength: 500, default: '' }, orderBy: { type: 'string', enum: XHS_HOT_SORTS, default: 'premium_imp_num' },
      nd: { type: 'string', enum: XHS_HOT_WINDOWS, default: 'DAY_7' },
      noteContentCategory: { type: 'string', maxLength: 200, description: '单个完整路径，例如 内容类目#美妆、内容类目#美妆#整体妆容、所属行业#母婴。类目是否支持以实际接口响应为准。' },
    } : {}), cursor,
  } }, example: product.id === 'hot_notes' ? { searchWord: '', orderBy: 'premium_imp_num', nd: 'DAY_7' } : {} } } },
  responses: { 200: { description: '业务结果与统一分页状态；不是归一化笔记列表。', content: { 'application/json': { schema: {
    type: 'object', required: ['contractVersion', 'data', 'meta'], properties: {
      contractVersion: { const: XHS_DISCOVERY_VERSION }, requestId: { type: 'string' },
      data: { type: 'object', required: ['result', 'pageInfo'], properties: { result: { type: ['object', 'array', 'null'], additionalProperties: true }, pageInfo: { type: 'object', properties: {
        page: { type: 'integer', minimum: 1, maximum: 15 }, nextCursor: { type: ['string', 'null'] }, hasMore: { type: ['boolean', 'null'], description: 'null 为未知；false 明确结束。' },
        paginationStatus: { enum: ['continuable', 'next_page_probe', 'exhausted', 'unknown', 'limit_reached'] },
      } } } }, meta: { type: 'object', properties: { status: { enum: ['ok', 'no_data', 'unknown'] }, projection: { const: 'native_fields' }, capturedAt: { type: 'string', format: 'date-time' }, collectionPath: { type: ['string', 'null'] }, returnedCount: { type: ['integer', 'null'], description: '识别到的当前页容器长度，未知为 null；不是总数。' } } },
    },
  } } } }, ...Object.fromEntries([400, 401, 403, 405, 409, 429, 502, 503].map(status => [status, { description: 'Hub 错误：400 参数/游标，403 未授权，409 幂等冲突/结果不确定，429 限制，502 返回不可用，503 运行未就绪。', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } }])) },
} }]))

export function xhsDiscoveryGuide(product) {
  const operation = xhsDiscoveryPaths[product.path.slice('/api/v1'.length)].post
  const example = operation.requestBody.content['application/json'].example
  return `<h2>${product.label}</h2><p>${product.description}</p><p><code>POST ${product.path}</code> · 权限 <code>xiaohongshu</code> + <code>${product.operation}</code></p><p>${operation.description}</p>
  <h3>请求参数</h3><table><thead><tr><th>字段</th><th>说明</th></tr></thead><tbody>${product.fields.map(([key, label, type]) => `<tr><td><code>${key}</code></td><td>${label}${Array.isArray(type) ? `：${type.join(' / ')}` : ''}</td></tr>`).join('')}</tbody></table>
  <h3>首屏示例</h3><pre>curl -X POST "$HUB_URL${product.path}" \\\n  -H "Authorization: Bearer $HUB_KEY" \\\n  -H "Content-Type: application/json" \\\n  -H "Idempotency-Key: xhs-discovery-first-001" \\\n  --data '${JSON.stringify(example)}'</pre>
  <h3>续页与停止条件</h3><p>将 <code>data.pageInfo.nextCursor</code> 原样放入顶层 <code>cursor</code>；保持接口、身份、筛选和排序不变，每页使用新 Idempotency-Key。原页重试保持原标识。游标不可与笔记画卷或另一产品混用。</p><p>空列表、<code>hasMore=false</code>、没有 nextCursor、unknown 或 limit_reached 时停止。少于某个数量不代表结束；第 15 页只是保护上限。next_page_probe 需要调用方明确选择是否继续探测，不承诺下一页非空。</p>
  <h3>结果与回放</h3><p>读取 <code>data.result</code>，Hub 元数据见 <code>meta</code>，交付证据见 <code>x-mx-insight-request-id</code> / <code>x-mx-insight-source-mode</code> / <code>idempotent-replay</code> 响应头。仅返回明确数据，不从标题/正文推导话题和指标。通过 <code>GET /api/v1/requests/{requestId}</code> 查询原请求状态。接口调试和展示视图共享本页请求，不自动采集、重试或翻页。</p>`
}
export const xhsDiscoveryPages = () => XHS_DISCOVERY_PRODUCTS.map(product => `<section class="doc-page" data-doc-page="${product.key}">${xhsDiscoveryGuide(product)}</section>`).join('\n')
