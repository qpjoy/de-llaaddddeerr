import { NATIVE_FORWARDING_ENDPOINTS } from './native-forwarding.mjs'

export const nativeForwardingPaths = Object.fromEntries(NATIVE_FORWARDING_ENDPOINTS.map(row => [
  row.hubPath.slice('/api/v1'.length), { post: {
    tags: ['原生数据接口'], operationId: `native_${row.key.replaceAll('.', '_')}`,
    summary: `${row.platform} · ${row.key}`, 'x-mx-required-platform': row.authorizationPlatform,
    'x-mx-required-capabilities': [row.operation],
    description: '固定单接口原生数据查询，一次请求最多一次采集。需要独立操作授权与启用；data 完整保留业务字段，不归一化为搜索列表。仅 live_only，无自动分页、重试、补详情或存量回退。按接口参数显式翻页，每页使用新 Idempotency-Key；同页重试保持原请求和标识。不会替换现有 search/raw、crawl、user-info 合同。',
    parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 128 } }],
    requestBody: { required: true, content: { 'application/json': { schema: {
      type: 'object', additionalProperties: false, required: ['params'], properties: {
        deliveryMode: { type: 'string', enum: ['live_only'], default: 'live_only' },
        params: { type: 'object', additionalProperties: false, required: row.parameters.filter(p => p.required).map(p => p.name),
          properties: Object.fromEntries(row.parameters.map(p => [p.name, { oneOf: [
            { type: 'string', maxLength: 8192, ...(p.required ? { minLength: 1 } : {}) }, { type: 'number' }, { type: 'boolean' },
          ] }])) },
      },
    } } } },
    responses: Object.fromEntries([200, 400, 401, 402, 403, 409, 429, 502, 503].map(status => [String(status), {
      description: status === 200 ? '原生 data、contractVersion、endpoint、requestId 与采集时间；没有推测的总数或 canonical 条目。' : '请求失败；未知结果禁止自动重发。',
    }])),
  } },
]))

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
