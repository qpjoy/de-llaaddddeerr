// Customer-facing contract documentation. Keep supplier mappings in operator docs.
import { IP_RISK_VERSION } from './ip-risk.mjs'

const nullable = (type, description, extra = {}) => ({ type: [type, 'null'], description, ...extra })
export const ipRiskFields = {
  proxy_type: nullable('string', '代理识别结果文本。字段名虽为 type，也可能返回“是”等识别结果，不是布尔值或固定类型枚举。空值归一化为 null，不能单凭 null 判定安全。'),
  risk_score: nullable('number', '综合风险评分，结合风险行为、标签、代理及发生时间等证据。评分可按业务定制；Hub 不声明固定范围或分级阈值，0 是有效值。'),
  risk_level: nullable('string', '风险等级文本，例如“中风险”。评级可定制，不是 Hub 固定枚举；缺失为 null。'),
  rapid_rotation_probability_percent: nullable('number', '秒拨行为概率：快速拨号或频繁切换网络地址的异常特征。数值越大表示可能性越高。单位为百分数，51 表示 51%，不是 0.51；0 是有效值。', { minimum: 0, maximum: 100 }),
  human_probability_percent: nullable('number', '访问流量由真人产生的概率，越接近 0 越偏向自动化行为。通常评分为 0–99；Hub 可接受 0–100 的有效百分数。不是可信身份认证结果。', { minimum: 0, maximum: 100 }),
  risk_tags: nullable('array', '风险行为标签。[] 表示返回了空标签集合；null 表示缺失或不可用。标签是观察线索，不是对当前使用者的定性。', {
    items: { type: 'object', required: ['code', 'name', 'last_seen'], properties: {
      code: nullable('string', '标签标识，例如 highRiskDevice。开放字符串，不对未列出的标签报错。'),
      name: nullable('string', '标签显示名称，例如“高危设备”。可为空，不应依赖中文名称作为稳定标识。'),
      last_seen: nullable('string', '该标签最近一次观测时间。常见格式 yyyy-MM-dd HH:mm:ss，保留原始时间文本；未声明时区，不应直接当 UTC。与本次查询时间不同。'),
    } },
  }),
}
const metaProperties = {
  sourceMode: { type: 'string', enum: ['live', 'idempotent_replay'], description: 'live 为本次查询；idempotent_replay 为显式幂等标识的已完成结果重放。' },
  pricingStatus: { type: 'string', const: 'plan_based', description: '费用根据当前调用者的生效套餐确定。' },
  chargeStatus: { type: 'string', const: 'see_usage', description: '精确金额与扣费状态查看使用记录/账单；不是扣费成功断言。' },
}
export const ipRiskResponseSchema = {
  type: 'object', required: ['contractVersion', 'requestId', 'data', 'meta'], properties: {
    contractVersion: { type: 'string', const: IP_RISK_VERSION, description: 'Hub 返回结构版本。' },
    requestId: { type: 'string', description: '逻辑请求编号，用于用量查询及结果核对。' },
    data: { type: 'object', required: ['ip', 'status', 'data', 'warnings'], properties: {
      ip: { type: 'string', format: 'ipv4', description: '本次查询的 IPv4。' },
      status: { type: 'string', enum: ['success', 'partial', 'no_data'], description: 'success：存在有效画像且无字段警告；partial：保留可用字段并列出警告；no_data：没有可用画像，不等于无风险。' },
      data: { type: ['object', 'null'], description: '画像对象；no_data 时可为 null 或包含空字段的对象。', required: Object.keys(ipRiskFields), properties: ipRiskFields },
      warnings: { type: 'array', items: { type: 'string' }, description: '字段质量提示：FIELD_MISSING:<字段> 表示缺失；FIELD_INVALID:<字段> 表示格式不可用。[] 表示无字段警告，不表示低风险。' },
    } },
    meta: { type: 'object', properties: {
      ...metaProperties,
      capturedAt: { type: 'string', format: 'date-time', description: 'Hub 获取画像的时间，ISO 8601；重放保留原时间，不是风险行为发生时间。' },
      originSourceMode: { type: 'string', description: '单条重放时附带原交付来源，例如 live。' },
    } },
  },
}
const errorSchema = { type: 'object', required: ['code', 'message'], properties: {
  code: { type: 'string', description: 'Hub 错误标识，用于程序判断。' },
  message: { type: 'string', description: '错误说明，不应作为稳定判断条件。' },
} }
export const ipRiskBatchSchema = {
  type: 'object', required: ['contractVersion', 'batchId', 'data', 'meta'], properties: {
    contractVersion: ipRiskResponseSchema.properties.contractVersion,
    batchId: { type: 'string', description: '批次编号，用于核对批次与各项请求。' },
    data: { type: 'array', description: '与输入 ips 顺序和数量一致，包括重复 IP。每项独立成功或失败。', items: {
      type: 'object', required: ['index', 'ip', 'status'], properties: {
        index: { type: 'integer', minimum: 0, description: '输入数组下标，从 0 开始。' },
        ip: { type: 'string', format: 'ipv4', description: '该项输入 IP。' },
        status: { type: 'integer', description: '该项 HTTP 语义状态码；200 是可用响应，其他值按失败处理。' },
        response: { description: '成功时为完整单条响应；查询失败也可能在 response.error 中提供错误。', oneOf: [ipRiskResponseSchema, { type: 'object', required: ['error'], properties: { error: errorSchema, requestId: { type: 'string' } } }] },
        error: { ...errorSchema, description: '未派发、配额不足等异常的错误对象，与 response 按实际情况返回。' },
        requestId: { type: 'string', description: '部分异常在项顶层附带请求编号；成功时在 response.requestId。未受理项可能没有编号。' },
      },
    } },
    meta: { type: 'object', properties: { ...metaProperties,
      requestedItems: { type: 'integer', description: '输入 IP 项数，含重复项。' },
      succeededItems: { type: 'integer', description: 'status=200 的项数，含 partial/no_data；不表示低风险项数。' },
    } },
  },
}
export const ipRiskExample = {
  contractVersion: IP_RISK_VERSION, requestId: '11111111-1111-4111-8111-111111111111',
  data: { ip: '1.1.1.1', status: 'success', data: {
    proxy_type: '是', risk_score: 90, risk_level: '中风险', rapid_rotation_probability_percent: 0,
    human_probability_percent: 51, risk_tags: [{ code: 'highRiskDevice', name: '高危设备', last_seen: '2024-05-10 12:17:26' }],
  }, warnings: [] },
  meta: { capturedAt: '2026-09-15T00:00:00.000Z', sourceMode: 'live', pricingStatus: 'plan_based', chargeStatus: 'see_usage' },
}
export const ipRiskBatchExample = {
  contractVersion: IP_RISK_VERSION, batchId: '22222222-2222-4222-8222-222222222222',
  data: [{ index: 0, ip: '1.1.1.1', status: 200, response: ipRiskExample },
    { index: 1, ip: '8.8.8.8', status: 429, error: { code: 'api_key_rate_limit_exceeded', message: 'Item could not be completed' } }],
  meta: { sourceMode: 'live', pricingStatus: 'plan_based', chargeStatus: 'see_usage', requestedItems: 2, succeededItems: 1 },
}
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const table = rows => `<table><thead><tr><th>字段</th><th>类型</th><th>含义</th></tr></thead><tbody>${rows.map(([name, type, description]) => `<tr><td><code>${escape(name)}</code></td><td>${escape(type)}</td><td>${escape(description)}</td></tr>`).join('')}</tbody></table>`
const schemaRows = (properties, prefix = '') => Object.entries(properties).map(([name, schema]) => [prefix + name, [].concat(schema.type || 'object').join(' / '), schema.description || '见下方字段说明'])
const tags = [
  ['垃圾注册', '自动化或虚假注册线索'], ['短信轰炸', '验证码申请异常密集'], ['黄牛', '自动化重复下单线索'], ['薅羊毛', '优惠领取作弊线索'],
  ['垃圾信息', '账号发布垃圾内容线索'], ['网络异常设备', '关联网络异常的设备'], ['篡改设备', '设备参数修改线索'], ['虚假设备', '模拟设备或浏览器线索'],
  ['高危设备', '群控或检测规避线索'], ['疑似虚假号码', '关联疑似虚假号码'], ['疑似高危状态号码', '关联异常号码状态'], ['高风险手机号', '关联风险手机号'],
  ['网络爬虫', '高频网页采集线索'], ['端口扫描', '端口或漏洞探测线索'], ['匿名通信', '公开匿名代理线索'], ['hosing', '机房或云服务地址标记，保留该拼写'], ['tor', '多节点匿名网络'], ['relay', '专用中继服务'],
]
export function ipRiskDocumentationHtml() {
  return `<section class="doc-page" data-doc-page="ip-risk"><h2>IP 风险画像</h2>
<p>查询 IPv4 的代理识别、风险评分、秒拨概率、真人概率和风险标签。单条与批量共用相同画像结构；字段不保证每次都有值。</p>
<h3>认证与请求</h3><p>使用已授权的 Hub Live API Key：Authorization: Bearer &lt;HUB_API_KEY&gt;（也可使用 x-api-key）。要求 ip_risk 数据域与 ip.risk.query 操作同时授权。JSON UTF-8，请求方式为 POST；Body 不接受 key、域名、IPv6 或额外字段。</p>
${table([['ip', 'string · 单条必填', 'POST /api/v1/data/ip/risk：一个 IPv4，首尾空格会去除。'], ['ips', 'string[] · 批量必填', 'POST /api/v1/data/ip/risk/batch：1–100 个 IPv4，保留顺序及重复项。任一格式无效则整个请求拒绝。']])}
<pre><code>POST /api/v1/data/ip/risk\n{"ip":"1.1.1.1"}\n\nPOST /api/v1/data/ip/risk/batch\n{"ips":["1.1.1.1","8.8.8.8"]}</code></pre>
<p>普通请求不需要请求去重标识，每次提交都是新查询。高级调用者可选用 Idempotency-Key（8–128 个字母、数字或 . _ : -，首字符为字母或数字）重放已完成的成功结果；修改参数应换新标识。结果未知时保留请求编号核对，不连续重试。</p>
<h3>单条返回结构</h3>${table(schemaRows(ipRiskResponseSchema.properties))}${table(schemaRows(ipRiskResponseSchema.properties.data.properties, 'data.'))}
<h3>画像字段 · data.data</h3>${table(schemaRows(ipRiskFields, 'data.data.'))}
<h3>风险标签子字段</h3>${table(schemaRows(ipRiskFields.risk_tags.items.properties, 'risk_tags[].'))}
<p>以下为常见标签含义示例；code 是开放标识，不根据名称猜测编码，也不把标签列表作为固定枚举。标签可同时出现。</p>${table(tags.map(([name, description]) => [name, '标签名称 / 标记', description]))}
<h3>响应元信息 · meta</h3>${table(schemaRows(ipRiskResponseSchema.properties.meta.properties, 'meta.'))}
<h3>单条示例（仅展示结构，不代表该 IP 的真实画像）</h3><pre><code>${escape(JSON.stringify(ipRiskExample, null, 2))}</code></pre>
<h3>批量返回与部分失败</h3><p>HTTP 200 仅表示批次完成，请逐项检查 data[i].status。成功项的 data[i].response 与单条返回完全同构，画像位于 data[i].response.data.data。每项可能返回 response.error 或顶层 error。最多 3 并发，60 秒预算；预算不足未派发项返回 504 / batch_deadline_not_dispatched，不自动补跑。</p>
${table(schemaRows(ipRiskBatchSchema.properties))}${table(schemaRows(ipRiskBatchSchema.properties.data.items.properties, 'data[i].'))}${table(schemaRows(ipRiskBatchSchema.properties.meta.properties, 'meta.'))}
<pre><code>${escape(JSON.stringify(ipRiskBatchExample, null, 2))}</code></pre>
<h3>空值、警告与错误</h3><p>null 不等于 0，也不代表安全。概率已转成数字并去掉百分号；缺失字段返回 FIELD_MISSING，非法字段返回 FIELD_INVALID。partial 保留可用字段；no_data 表示无画像。无法识别的结果会返回错误，不伪装成成功。风险评分和评级不提供统一阈值。</p>
${table([['200', 'HTTP', '单条有效、部分有效或无数据；批量须逐项判断。'], ['400', 'HTTP', 'invalid_ip_request / invalid_ip_batch / invalid_idempotency_key：检查参数。'], ['401 / 403', 'HTTP', '认证失效、授权不足或使用了 Test Key。'], ['402', 'HTTP / 批量项', 'insufficient_credit：当前套餐扣费所需余额不足。'], ['409', 'HTTP / 批量项', '请求冲突、处理中、未完成批次或结果未知；保留编号核对。'], ['429', 'HTTP / 批量项', 'Key 次数、频率、配额或服务容量限制。'], ['502 / 503', 'HTTP / 批量项', '查询失败、服务不可用或持久化结果未知。'], ['504', '批量项', '预算不足，未派发该项。']])}
<p>错误使用 error.code 与 error.message，受理后的请求通常有 requestId；不要依赖错误文案进行程序分支。费用按当前生效套餐：单条成功交付计一次（含有效 no_data），批量逐成功项结算；确定失败释放冻结，结果未知待对账。已授权但未配置价格的接口保持免费。精确费用见使用记录与账单。</p></section>`
}
