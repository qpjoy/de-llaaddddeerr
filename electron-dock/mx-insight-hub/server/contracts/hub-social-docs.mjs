import { HUB_SOCIAL_ENDPOINTS } from './hub-social.mjs'

export const hubSocialPaths = Object.fromEntries(Object.values(HUB_SOCIAL_ENDPOINTS).map(row => {
  const paging = row.key !== 'user-info'
  const properties = {
    platform: { type: 'string', enum: ['twitter', 'x'], default: 'twitter' },
    ...(row.key === 'search' ? {
      query: { type: 'string', minLength: 1, maxLength: 500, description: '关键词或 Twitter 查询表达式；可用 keyword 同义字段，两个字段须相同。' },
      keyword: { type: 'string', minLength: 1, maxLength: 500 },
      sort: { type: 'string', enum: ['latest', 'top'], default: 'latest' },
    } : {
      username: { type: 'string', maxLength: 16, description: '用户名（可带 @），与 userId/uid 二选一。' },
      userId: { type: 'string', pattern: '^[0-9]{1,30}$' },
      user_id: { type: 'string', pattern: '^[0-9]{1,30}$', description: 'userId 同义字段；同时提交须相同。' },
      uid: { type: 'string', pattern: '^[0-9]{1,30}$', description: 'userId 同义字段；同时提交须相同。' },
    }),
    ...(paging ? {
      count: { type: 'integer', minimum: 1, maximum: 50, default: 20, description: '单页请求量，仍受 Key 上限约束；不足不自动补页。' },
      pageSize: { type: 'integer', minimum: 1, maximum: 50, description: 'count 同义字段；同时提交须相同。' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'count 同义字段；同时提交须相同。' },
      cursor: { type: 'string', maxLength: 8192, description: '本接口返回的不透明游标，同一 Key、操作、查询、排序和 count 下原样提交；最多 15 页、整轮有效期 24 小时。旧接口游标不可混用。' },
    } : {}),
  }
  return [row.path.slice('/api/v1'.length), { post: {
    tags: ['社媒与内容数据'], operationId: `hubSocial_${row.key.replace('-', '_')}`,
    summary: `Twitter · ${row.label}（Hub 独立接口）`,
    'x-mx-required-platform': 'twitter', 'x-mx-required-capabilities': [row.operation],
    'x-mx-data-platform': 'twitter', 'x-mx-category': 'Twitter', 'x-mx-meter-key': row.operation,
    'x-mx-doc-path': '/docs/social-content',
    description: '独立的新合同，保留现有接口及授权。当前仅覆盖 Twitter；一次请求只采集一页或一次基础资料，无自动重试、补页、补详情或旧接口回退。账号内容保留该时间线中的转推。资料不含 about 补充。未知/失败响应不会伪装为空列表。raw_info/raw_data 为迁移辅助 JSON 字符串，字段和时间格式不承诺与历史接口完全相同；不能仅替换 URL 就宣称兼容。完整原始响应限管理审计；本批暂未接入已收录数据索引。新增权限、运行开关和价格独立审核，默认禁用。',
    parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 128 }, description: '相同页重试保持原标识和请求体；下一页使用新标识。未知结果禁止自动新建标识重发。' }],
    requestBody: { required: true, content: { 'application/json': {
      schema: { type: 'object', additionalProperties: false, required: ['platform'], properties,
        ...(row.key === 'search' ? { anyOf: [{ required: ['query'] }, { required: ['keyword'] }] } : { oneOf: [
          { required: ['username'], not: { anyOf: [{ required: ['userId'] }, { required: ['user_id'] }, { required: ['uid'] }] } },
          { anyOf: [{ required: ['userId'] }, { required: ['user_id'] }, { required: ['uid'] }], not: { required: ['username'] } },
        ] }),
      }, example: row.key === 'search' ? { platform: 'twitter', query: 'AI feature update', count: 20 } : { platform: 'twitter', username: 'example', ...(paging ? { count: 20 } : {}) },
    } } },
    responses: Object.fromEntries([200, 400, 401, 402, 403, 409, 429, 502, 503].map(status => [String(status), {
      description: status === 200 ? 'contractVersion、data（items、raw_info、raw_data、page、pageInfo、meta、status）、requestId。status=partial 表示丢弃了不能解析的内容；页内计数不是总数。data.meta.profileCompleteness=base_profile_without_about 表示仅基础资料。' : '失败或未知结果，保留 requestId。502 的 error.details 包含 upstreamStatus、upstreamCode（若存在）、outcome；不自动重发。',
    }])),
  } }]
}))

export function hubSocialGuide(allowed = () => true) {
  const rows = Object.values(HUB_SOCIAL_ENDPOINTS).filter(row => allowed(row.path.slice('/api/v1'.length)))
  if (!rows.length) return ''
  return `<h2>Hub 独立社媒接口</h2><p>当前覆盖 Twitter 单页搜索、账号时间线及基础资料；尚未覆盖历史全量、批量账号、about 补充和其它平台。现有调用入口保持原样。新接口是独立合同，不能仅替换 URL 或混用旧游标。</p><table><thead><tr><th>能力</th><th>POST 接口</th></tr></thead><tbody>${rows.map(row => `<tr><td>${row.label}</td><td><code>${row.path}</code></td></tr>`).join('')}</tbody></table><p>使用已授权的 Live Key 和 Idempotency-Key，一次最多一次上游采集；无自动补查、重试或旧链路回退。相同页重试保留原请求体与标识。返回 data.items、raw_info/raw_data JSON 字符串和 pageInfo；这些辅助字段并非完整历史兼容投影。完整原始证据仅供管理审计，本批不自动进入已收录数据索引。</p><p>内容搜索也可通过 <code>POST /api/v1/data/aggregate/search</code> 提交 <code>execution: "hub_only"</code> 使用同一执行层；当前仅 Twitter，需独立授权。省略 execution 保持原聚合行为。GET /api/v1/data/aggregate/sources?execution=hub_only 可只读查看范围。</p>`
}
