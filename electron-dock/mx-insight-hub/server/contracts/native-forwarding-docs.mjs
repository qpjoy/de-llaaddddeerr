import { NATIVE_FORWARDING_ENDPOINTS } from './native-forwarding.mjs'
const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
export const nativeDocPath = row => `/docs/${row.authorizationPlatform === 'ecommerce' ? 'ecommerce-treasure-box' : 'social-content'}/native/${row.key}`
export const NATIVE_DOC_ROUTES = NATIVE_FORWARDING_ENDPOINTS.map(row=>({ key:`native-${row.key}`, path:nativeDocPath(row), label:row.summary || row.key, section:'数据服务', hiddenNavigation:true, nativeKey:row.key }))
export function nativeDocPaths(key) {
  return NATIVE_FORWARDING_ENDPOINTS.filter(row=>key === 'social-content' ? row.authorizationPlatform === 'social' : key === 'ecommerce-treasure-box' ? row.authorizationPlatform === 'ecommerce' : key === `native-${row.key}`).map(row=>row.hubPath.slice('/api/v1'.length))
}

export const nativeForwardingPaths = Object.fromEntries(NATIVE_FORWARDING_ENDPOINTS.map(row => [
  row.hubPath.slice('/api/v1'.length), { post: {
    tags: [row.authorizationPlatform === 'ecommerce' ? '电商数据' : '社媒与内容数据'], operationId: `native_${row.key.replaceAll('.', '_')}`,
    summary: `${row.platformLabel || row.platform} · ${row.summary || row.key}`, 'x-mx-required-platform': row.authorizationPlatform,
    'x-mx-data-platform': row.platform, 'x-mx-category': row.platformLabel || row.platform,
    'x-mx-meter-key': row.operation,
    'x-mx-doc-path': nativeDocPath(row),
    'x-mx-required-capabilities': [row.operation],
    description: '固定单接口原生数据查询，一次请求最多一次采集。需要独立操作授权与启用；data 完整保留业务字段，不归一化为搜索列表。仅 live_only，无自动分页、重试、补详情或存量回退。按接口参数显式翻页，每页使用新 Idempotency-Key；同页重试保持原请求和标识。不会替换现有 search/raw、crawl、user-info 合同。',
    parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 128 } }],
    requestBody: { required: true, content: { 'application/json': { schema: {
      type: 'object', additionalProperties: false, required: ['params'], properties: {
        deliveryMode: { type: 'string', enum: ['live_only'], default: 'live_only' },
        params: { type: 'object', additionalProperties: false, required: row.parameters.filter(p => p.required).map(p => p.name),
          properties: Object.fromEntries(row.parameters.map(p => [p.name, row.schemaVersion ? Object.fromEntries(Object.entries(p).filter(([key]) => !['name','required'].includes(key))) : { description: p.description || '', oneOf: [
            { type: 'string', maxLength: 8192, ...(p.required ? { minLength: 1 } : {}) }, { type: 'number' }, { type: 'boolean' },
          ] }])) },
      },
    } } } },
    responses: Object.fromEntries([200, 400, 401, 402, 403, 409, 429, 502, 503].map(status => [String(status), {
      description: status === 200 ? '原生 data、contractVersion、endpoint、requestId 与采集时间；没有推测的总数或 canonical 条目。' : '请求失败；未知结果禁止自动重发。',
    }])),
  } },
]))

export function nativeEndpointGuide(key) {
  const row = NATIVE_FORWARDING_ENDPOINTS.find(item=>`native-${item.key}` === key)
  if (!row) return ''
  const product = row.authorizationPlatform === 'ecommerce' ? 'ecommerce-treasure-box' : 'social-content'
  return `<h2>${escape(row.platformLabel || row.platform)} · ${escape(row.summary || row.key)}</h2><p><a href="/#/data-products/${product}?endpoint=${encodeURIComponent(row.key)}">打开本接口调试与 Hub 定价 →</a></p>
  <h3>POST <code>${row.hubPath}</code></h3><p>使用 Hub Live Key 与 Idempotency-Key。每次只查询此接口的一页；参数放入 JSON 的 params 对象，deliveryMode 固定 live_only。没有自动翻页、重试或关联查询。</p>
  <h3>Hub 官方定价</h3><p>官方定价来自当前 Hub 已发布价格表，账户执行价包含合同倍率或折扣。<code>GET /api/v1/data/services/pricing?path=${encodeURIComponent(row.hubPath)}</code> 用当前 Key 读取两项价格，不采集、不扣费，不锁定执行价格。未发布单价不代表免费。</p>
  <div style="overflow:auto"><table><thead><tr><th>params 字段</th><th>类型</th><th>必填</th><th>默认 / 可选值</th><th>说明</th></tr></thead><tbody>${row.parameters.map(p=>`<tr><td><code>${escape(p.name)}</code></td><td>${escape(p.type || 'scalar')}</td><td>${p.required?'是':'否'}</td><td>${escape(p.enum?.join(' / ') || (p.default ?? '—'))}</td><td>${escape(p.description || '按字段声明填写')}</td></tr>`).join('')}</tbody></table></div>
  <h3>响应与分页</h3><p>外层为 data + requestId；data 包含 contractVersion、endpoint、业务 data 和 meta.capturedAt。业务数据结构随接口版本不同，不保证统一 items、总数或分页字段。按接口返回的分页参数显式请求后续页，每页新建 Idempotency-Key；相同页重试保留原标识和参数。</p><p>400 修正参数；403 检查 Key 平台与操作授权；402 检查余额；429 等待限额恢复；409/502/503 保留 requestId 核对原请求，勿自动新建请求重试。接口授权、运行启用及余额在发送时独立检查。</p>`
}

export function nativeServiceGuide(key, allowed = () => true) {
  const rows=NATIVE_FORWARDING_ENDPOINTS.filter(row=>(key==='social-content' ? row.authorizationPlatform==='social' : row.authorizationPlatform==='ecommerce') && allowed(row.hubPath.slice('/api/v1'.length)))
  const platforms=[...new Set(rows.map(row=>row.platformLabel || row.platform))].sort()
  return `<h2>${key==='social-content'?'社媒与内容数据':'电商数据接口'}</h2><p>通过 Hub 查询内容、账号、评论、趋势或商品数据。当前文档范围包含 ${rows.length} 个固定接口，调用仍由所选 Key 权限、运行开关与账户余额决定。</p><p><a href="/#/data-products/${key}">打开接口调试、平台筛选与 Hub 官方定价 →</a></p><h3>平台与接口</h3><table><thead><tr><th>平台</th><th>接口数</th><th>接口文档示例</th></tr></thead><tbody>${platforms.map(platform=>{const matches=rows.filter(row=>(row.platformLabel || row.platform)===platform);return `<tr><td>${escape(platform)}</td><td>${matches.length}</td><td><a href="${nativeDocPath(matches[0])}">${escape(matches[0].summary || matches[0].key)}</a></td></tr>`}).join('')}</tbody></table><p>完整授权接口与字段定义见 <a href="/docs/openapi.json">OpenAPI JSON</a>。选择具体接口后，可在调试页面直接跳转对应文档。所有采集均需点击发送，浏览、筛选和读取价格不会采集数据。</p>`
}

export function nativeForwardingGuide() {
  return `<section class="doc-page" data-doc-page="native-data"><h2>原生数据接口</h2>
  <p>单接口执行层已迁入 Hub，三个历史搜索合同仍保持原路由。目录可见与接口启用、当前 Key 授权分别校验。</p>
  <p>提交 params 与 Idempotency-Key。data 保留原生业务字段；游标、页码、时间窗口由调用方按当前接口显式提交。没有隐藏的补详情、补页、重试或供应商切换。</p>
  <p>新增接口默认禁用，需要管理员逐接口审核价格、启用，并给调用者及 Key 授予对应操作。已有 Key 不会自动获得新权限。</p>
  <p><a href="/#/source-catalog">数据源目录与迁移进度</a> · <a href="/docs/aggregate-search">聚合搜索合同</a></p>
  <pre><code>POST /api/v1/data/native/j.douyin_search_video_v4
Authorization: Bearer &lt;HUB_API_KEY&gt;
Idempotency-Key: native-page-001
{"params":{"keyword":"自行车","sortType":"_2","publishTime":"_0","duration":"_0","page":1}}</code></pre>
  <p>上述返回是原生交付，不能作为旧 search/raw 响应直接替换。旧接口切换还需完成字段、错误、游标及计费兼容验证。</p>
  <table><thead><tr><th>平台</th><th>Hub 接口（POST）</th><th>必填参数</th></tr></thead><tbody>${NATIVE_FORWARDING_ENDPOINTS.map(row => `<tr><td>${row.platform}</td><td><code>${row.hubPath}</code></td><td>${row.parameters.filter(p => p.required).map(p => p.name).join('、') || '见参数合同'}</td></tr>`).join('')}</tbody></table></section>`
}
