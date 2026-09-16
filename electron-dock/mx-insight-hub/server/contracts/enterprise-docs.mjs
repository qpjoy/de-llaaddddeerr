import { QIXIN_CATALOG, ENTERPRISE_VERSION, enterpriseApi, enterpriseFields, enterprisePublicPrice } from './enterprise.mjs'

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const pathFor = id => `/data/enterprise/${id}/query`
const exampleFor = api => {
  const query = Object.fromEntries(enterpriseFields(api, 'query').filter(f => f.required === 1).map(f => [f.name, f.type.toLowerCase() === 'number' ? 1 : f.name === 'keyword' ? '示例企业' : `<${f.name}>`]))
  if (api.api_id === '66.35') query.keyword = '示例企业'
  if (api.api_id === '22.11') query.register_no = '<register_no>'
  return { query, ...(api.body.length ? { body: Object.fromEntries(enterpriseFields(api, 'body').filter(f => f.required === 1).map(f => [f.name, f.type.toLowerCase() === 'number' ? 1 : `<${f.name}>`])) } : {}), deliveryMode: 'live_only' }
}
const fieldSchema = field => {
  const kind = String(field.type).toLowerCase()
  const type = { string: 'string', number: 'number', object: 'object', array: 'array', boolean: 'boolean' }[kind]
  return { ...(type ? { type } : {}), description: field.brief || '',
    ...(type === 'array' ? { items: field.children?.length ? { type: 'object', properties: Object.fromEntries(field.children.map(f => [f.name, fieldSchema(f)])) } : {} } : {}),
    ...(type === 'object' && field.children?.length ? { properties: Object.fromEntries(field.children.map(f => [f.name, fieldSchema(f)])) } : {}),
  }
}
const inputSchema = fields => ({ type: 'object', additionalProperties: false,
  required: fields.filter(f => f.required === 1).map(f => f.name),
  properties: Object.fromEntries(fields.map(field => [field.name, field.type.toLowerCase() === 'number'
    ? { anyOf: [{ type: 'number' }, { type: 'string' }], description: field.brief }
    : fieldSchema(field)])),
})
const conditionalFields = { '66.35': ['keyword', 'import_keyword'], '22.11': ['kind_id', 'register_no'] }
const querySchema = api => ({ ...inputSchema(enterpriseFields(api, 'query')),
  ...(conditionalFields[api.api_id] ? { anyOf: conditionalFields[api.api_id].map(name => ({ required: [name] })) } : {}),
})

export function enterpriseOpenApiPaths() {
  return Object.fromEntries(QIXIN_CATALOG.apis.map(api => [pathFor(api.api_id), { post: {
    tags: ['企业数据'], summary: `${api.api_id} ${api.api_name}`, operationId: `enterprise_${api.api_id.replace('.', '_')}`,
    'x-mx-required-platform': 'enterprise', 'x-mx-required-capabilities': ['enterprise.query'],
    'x-mx-category': api.category_name, 'x-mx-callable': enterprisePublicPrice(api.api_id) !== null,
    description: `${enterprisePublicPrice(api.api_id) === null ? '此接口未开放调用，返回 enterprise_price_negotiated。' : ''}${api.brief} 固定接口目录，文档快照 ${QIXIN_CATALOG.synced_at.slice(0, 10)}。分页通过本接口声明的 query/body 字段提交；更换参数使用新幂等标识。费用按当前套餐结算。报告任务需显式再次查询，无自动轮询。`,
    parameters: [{ in: 'header', name: 'Idempotency-Key', required: false, description: 'live_only / refresh 时必填；同一请求重试保留，分页或新查询更换。', schema: { type: 'string', minLength: 8, maxLength: 128 } }],
    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false,
      required: ['query', 'body'].filter(section => enterpriseFields(api, section).some(field => field.required === 1)
        || (section === 'query' && conditionalFields[api.api_id])),
      properties: { query: querySchema(api),
        ...(api.body.length ? { body: inputSchema(enterpriseFields(api, 'body')) } : {}),
        method: { type: 'string', enum: api.methods, default: api.methods.includes('GET') ? 'GET' : 'POST', description: 'Hub 接口始终用 POST，此字段选择已登记的适配请求方式。' },
        deliveryMode: { type: 'string', enum: ['live_only', 'refresh', 'cache_first', 'cache_only'], default: 'live_only' },
      } }, example: exampleFor(api) } } },
    responses: { '200': { description: '精确业务响应封装于 data；meta.resultState 为 completed、no_data 或 pending，pending 不代表报告已完成。Hub 保留结果；企业响应观察的数量不等于企业数量。', content: { 'application/json': { schema: { type: 'object', properties: {
      contractVersion: { const: ENTERPRISE_VERSION }, apiId: { const: api.api_id }, requestId: { type: 'string' },
      data: { type: 'object', properties: Object.fromEntries(api.response.map(f => [f.name, fieldSchema(f)])), additionalProperties: true },
      meta: { type: 'object', properties: { capturedAt: { type: 'string', format: 'date-time' }, sourceMode: { type: 'string' }, resultState: { enum: ['completed', 'no_data', 'pending'] } } },
    } } } } },
      '400': { description: '未定义的字段、缺少必填或错误类型' }, '401': { description: '身份无效' }, '403': { description: '缺少企业数据域/查询能力授权、使用 Test Key，或接口为面议不可调用（enterprise_price_negotiated）' },
      '402': { description: '当前套餐扣费所需余额不足；检查账户及费率' },
      '404': { description: '接口未登记，或 cache_only 没有对应快照' },
      '409': { description: '幂等冲突、处理中或结果未知；勿换 Key 盲重试' }, '429': { description: '配额、速率、并发或预算已达限' },
      '502': { description: '响应拒绝、不可用或结果未知' }, '503': { description: '接口未开通或运行条件不满足' },
    },
  } }]))
}

export const ENTERPRISE_DOC_ROUTES = [
  { key: 'enterprise', path: '/docs/enterprise', label: '企业数据', section: '数据产品' },
  ...QIXIN_CATALOG.apis.map(api => ({ key: `enterprise-${api.api_id}`, path: `/docs/enterprise/${api.api_id}`,
    label: `${api.api_id} ${api.api_name}`, section: '企业数据', hiddenNavigation: true })),
]
export const enterpriseDocsPaths = key => key === 'enterprise'
  ? QIXIN_CATALOG.apis.map(api => pathFor(api.api_id)) : [pathFor(key.slice('enterprise-'.length))]

function fieldRows(fields, prefix = '') {
  return fields.map(field => `<tr><td><code>${escape(prefix + field.name)}</code></td><td>${escape(field.type)}</td><td>${field.required === 1 ? '是' : '否'}</td><td>${escape(field.brief)}</td></tr>${field.children?.length ? fieldRows(field.children, prefix + field.name + '.') : ''}`).join('')
}
const fieldsTable = fields => `<div style="overflow-x:auto"><table><thead><tr><th>字段</th><th>类型</th><th>必填/声明</th><th>说明</th></tr></thead><tbody>${fieldRows(fields)}</tbody></table></div>`

function integrationGuide() {
  const node = `// Node.js 18+，保存为 enterprise.mjs。环境变量填入 Hub 公共 API 地址和 Live Key。
import { randomUUID } from 'node:crypto'
const base = process.env.HUB_URL.replace(/\\/$/, '')
const idempotencyKey = randomUUID() // 发出前持久保存；重试复用，换页/新查询才更换
const body = { query: { keyword: '示例企业', skip: 0 }, deliveryMode: 'live_only' }
const response = await fetch(base + '/api/v1/data/enterprise/1.31/query', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + process.env.HUB_API_KEY,
    'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
  body: JSON.stringify(body), signal: AbortSignal.timeout(45000),
})
const result = await response.json()
if (!response.ok) throw new Error(JSON.stringify({ http: response.status, error: result.error, requestId: result.requestId }))
console.log(result.requestId, result.meta?.resultState, result.data)
// pending 不是报告完成；网络超时后先查请求状态，不自动生成新请求。`
  const python = `# Python 3 标准库；超时/网络异常后先核对原请求，不自动重试。
import os, json, uuid, urllib.request, urllib.error
base = os.environ['HUB_URL'].rstrip('/')
idempotency_key = str(uuid.uuid4())  # 发出前持久保存；重试必须复用
body = {'query': {'keyword': '示例企业', 'skip': 0}, 'deliveryMode': 'live_only'}
request = urllib.request.Request(base + '/api/v1/data/enterprise/1.31/query',
    data=json.dumps(body, ensure_ascii=False).encode('utf-8'), method='POST',
    headers={'Authorization': 'Bearer ' + os.environ['HUB_API_KEY'],
             'Content-Type': 'application/json', 'Idempotency-Key': idempotency_key})
try:
    with urllib.request.urlopen(request, timeout=45) as response:
        result = json.load(response)
        print(result.get('requestId'), result.get('meta', {}).get('resultState'), result.get('data'))
except urllib.error.HTTPError as error:
    print(error.code, error.read().decode('utf-8'))`
  return `<h3 id="integration">下游接入</h3><p>可以直接按照本文档接入。准备已开通 <code>enterprise</code> 与 <code>enterprise.query</code> 的 Hub Live Key，以及当前部署的 Hub 公共 API 地址 <code>HUB_URL</code>（域名/来源地址，不含 /api/v1；不是管理端口）。机器调用使用长期 Live Key，不使用浏览器临时凭据。不要把 Key 写进前端代码、URL 或公开仓库。</p>
<p>Hub 负责平台认证，下游只提交业务参数；无需 App Key、Secret Key、时间戳或签名。管理台「数据产品 → 企业数据 → 接口调试」使用相同公共接口。打开页面、阅读文档和复制示例不发起企业查询。</p>
<h4>最小示例：企业模糊搜索</h4><p>先用 1.31 查询企业，后续接口按各自字段声明传企业名称、ID 或报告 ID，不能假定每个接口都接受相同参数。以下代码运行后会真实查询，费用以当前调用者套餐为准。</p>
<details><summary>Node.js 示例</summary><pre>${escape(node)}</pre></details><details><summary>Python 示例</summary><pre>${escape(python)}</pre></details>
<h4>分页与响应</h4><p>Hub 外层没有通用 page/pageSize：把本接口声明的 <code>skip</code>、<code>page</code> 等字段放入 query 或 body。1.31 使用 query.skip 偏移量；步长按该接口说明和实际返回条数处理。每次换页生成新 Idempotency-Key，重试原页保持原标识和完全相同参数。Hub 不自动查下一页。</p>
<p>成功交付的 HTTP 状态是 200；<code>result.data.status</code> 是业务状态，二者不能混用。<code>meta.resultState</code> 为 completed（完成）、no_data（无数据）或 pending（处理中）。业务 status 200 对应 completed，201/206 对应 no_data，202/203 对应 pending。业务数据通常在 <code>result.data.data</code>，具体结构以各接口响应表为准；不能假定固定 items 字段。</p>
<h4>重试、留存与费用</h4><p>所有示例都携带 Idempotency-Key。live_only/refresh 必填，cache_first/cache_only 也建议显式传入。同一标识只对应一份完整请求；不要因超时生成新标识重复提交。请求状态：<code>GET /api/v1/requests/{requestId}</code>；未取得 requestId 时，使用原 <code>Idempotency-Key</code> 请求头访问 <code>GET /api/v1/requests/by-idempotency-key</code>。这两个 GET 不调用企业数据接口。状态 committed 可原样重放，reserved/unknown 先核对处理，不盲目新建请求。</p>
<p><code>GET /api/v1/acquisitions/{requestId}</code> 查看已交付结果与留存证据，不查询新数据。缓存和留存属于当前调用者；<code>cache_only</code> 未命中返回 404。按套餐结算成功交付的 Hub 逻辑请求；缓存命中不承诺免费，无数据或处理中也不能直接当作免费。费用、冻结和最终结算以用量与账单为准。</p>
<table><thead><tr><th>HTTP</th><th>处理方式</th></tr></thead><tbody><tr><td>400</td><td>按本接口字段表修正参数</td></tr><tr><td>401 / 403</td><td>检查 Live Key、调用者与 Key 双重授权；enterprise_price_negotiated 表示未开放接口，不能调用</td></tr><tr><td>402</td><td>检查余额与计费账户</td></tr><tr><td>409</td><td>核对幂等冲突、处理中或未知结果，保留原标识</td></tr><tr><td>429</td><td>检查配额/频率，按响应等待</td></tr><tr><td>502 / 503</td><td>保留 error.code 与 requestId 核对服务状态；不要自动反复付费查询</td></tr></tbody></table>
<p><a href="/docs/openapi.json">下载 OpenAPI 3.1 JSON</a>，其中 servers.url 为相对路径 /api/v1，生成客户端时设置 Hub 域名。以 JSON 中 x-mx-callable 判断目录是否开放；运行授权、余额与暂停状态仍由每次请求校验。目录完整不代表所有接口均已付费实测或都已授权。</p>`
}

export function enterpriseDocumentationHtml(key = 'enterprise', { tenant = false } = {}) {
  if (key === 'enterprise') return `<h2>企业数据接口</h2><p>${QIXIN_CATALOG.category_count} 类、${QIXIN_CATALOG.api_count} 个接口。原合同快照：${QIXIN_CATALOG.synced_at.slice(0, 10)}；价格及新增接口更新：2026-09-17。所有调用使用已授权的 Hub Live API Key；接口是否可用以当前开通状态为准。</p>
<p>需要同时授权 <code>enterprise</code> 与 <code>enterprise.query</code>。请求必须发往 Hub，平台签名由服务端处理。请求结果完整留存，可通过原 requestId 查看交付证据。仅浏览文档不发起数据查询。</p>
${integrationGuide()}
<label for="enterprise-filter">搜索接口名称、ID 或分类</label><input id="enterprise-filter" type="search" placeholder="例如 工商、风险、1.31" style="width:100%;padding:12px;background:var(--surface);color:inherit;border:1px solid currentColor;border-radius:8px">
<p id="enterprise-count" role="status">${QIXIN_CATALOG.api_count} 个接口</p>
${QIXIN_CATALOG.categories.map(category => `<details open data-enterprise-category><summary>${escape(category.category_name)}</summary><table><thead><tr><th>接口</th><th>说明</th>${tenant ? '' : '<th>官网参考价格</th>'}</tr></thead><tbody>${QIXIN_CATALOG.apis.filter(api => api.category_id === category.category_id).map(api => `<tr data-enterprise-api data-search="${escape(`${api.api_id} ${api.api_name} ${api.category_name}`)}"><td><a href="/docs/enterprise/${api.api_id}">${escape(api.api_id + ' ' + api.api_name)}</a></td><td>${escape(api.brief)}</td>${tenant ? '' : `<td>${escape(api.display_price)}</td>`}</tr>`).join('')}</tbody></table></details>`).join('')}
${tenant ? '' : '<p>官网标价是参考快照，不能替代合同价，也不会自动发布为 Hub 客户价格。双密钥和运行开关在外部数据平台管理。</p>'}
<script>document.getElementById('enterprise-filter').addEventListener('input', function() { const value=this.value.trim().toLowerCase(); let count=0; document.querySelectorAll('[data-enterprise-api]').forEach(row=>{row.hidden=!row.dataset.search.toLowerCase().includes(value);if(!row.hidden)count++});document.querySelectorAll('[data-enterprise-category]').forEach(group=>{group.hidden=!Array.from(group.querySelectorAll('[data-enterprise-api]')).some(row=>!row.hidden);if(value)group.open=true});document.getElementById('enterprise-count').textContent=count+' 个接口' });</script>`
  const api = enterpriseApi(key.slice('enterprise-'.length))
  const example = JSON.stringify(exampleFor(api), null, 2)
  return `<a href="/docs/enterprise">← 企业接口目录</a><h2>${escape(api.api_id)} · ${escape(api.api_name)}</h2><p>${escape(api.category_name)} · ${escape(api.brief)}</p>
${enterprisePublicPrice(api.api_id) === null ? '<p><strong>此接口未开放调用；请求返回 enterprise_price_negotiated。</strong></p>' : ''}
<h3><code>POST /api/v1${escape(pathFor(api.api_id))}</code></h3><p>Authorization: Bearer &lt;HUB_API_KEY&gt;。需要 enterprise + enterprise.query，Live Key。JSON 请求；query 与 body 保留以下文档字段，不接受目标 URL 或平台凭据。</p>
<p>deliveryMode 默认 live_only；cache_only 只读已有快照，cache_first 优先一小时内缓存，refresh 更新并允许一天内存量回退。live_only / refresh 必须带 Idempotency-Key。更换查询、页码或报告 ID 使用新标识；未知结果先查请求状态，不盲重试。</p>
<p>可选 method：${escape(api.methods.join(' / '))}，默认 ${api.methods.includes('GET') ? 'GET' : 'POST'}；Hub 路由始终 POST。报告申请和读取分别调用对应接口，202/203 表示仍待完成，不自动轮询或下载报告。</p>
<h3>query 字段</h3>${fieldsTable(enterpriseFields(api, 'query'))}
${api.body.length ? `<h3>body 字段</h3>${fieldsTable(enterpriseFields(api, 'body'))}` : ''}
${api.api_id === '66.35' ? '<p>keyword 与 import_keyword 至少提供一个。</p>' : api.api_id === '22.11' ? '<p>kind_id 与 register_no 至少提供一个。</p>' : ''}
<h3>Hub 请求示例</h3><p>先设置 HUB_URL、HUB_API_KEY 和本次新请求的 IDEMPOTENCY_KEY（8–128 字符，例如 UUID）；重试保留原值，换页或新查询更换。</p><pre>curl -X POST "$HUB_URL/api/v1${escape(pathFor(api.api_id))}" \\\n  -H "Authorization: Bearer $HUB_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \\\n  --data '${escape(example)}'</pre>
<h3>响应</h3><p>成功交付返回 HTTP 200。外层包含 contractVersion、apiId、requestId、meta 和 data。data 是完整业务响应（包括 status/message/sign/data）；以下字段均位于外层 data 中。这里的业务 status 200 为完成、201/206 为无数据、202/203 为处理中，对应 meta.resultState 的 completed/no_data/pending，不能与 HTTP 状态混淆。其他错误用 Hub 错误响应返回并留存原始证据。</p>${fieldsTable(api.response)}
<details><summary>业务响应示例（位于 Hub data 内）</summary><pre>${escape(typeof api.response_example === 'string' ? api.response_example : JSON.stringify(api.response_example, null, 2))}</pre></details>
<h3>留存与复现</h3><p>成功交付前保存完整响应、调用记录和当前调用者的快照，并排队形成 Canonical 响应观察。<code>GET /api/v1/acquisitions/{requestId}</code> 读取原交付结果，不重新查询。响应观察不是企业去重主表。费用以当前套餐和使用记录为准。</p>
<p><a href="/docs/enterprise#integration">下游接入完整指南：Node.js / Python、分页、状态与重试</a></p>
${tenant ? '' : `<p>官网参考价：${escape(api.display_price)}；标价核对于 2026-09-17（北京时间）。<a href="${escape(api.source_url)}" rel="noreferrer">启信官方文档</a>。运行使用已复核采购价；不推断供应商实际扣费。</p>`}`
}
