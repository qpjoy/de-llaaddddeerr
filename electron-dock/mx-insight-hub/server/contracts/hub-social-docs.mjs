import { HUB_SOCIAL_ENDPOINTS } from './hub-social.mjs'
import { HUB_SOCIAL_COMPAT_CRAWL_PLATFORMS, HUB_SOCIAL_COMPAT_PROFILE_PLATFORMS } from '../../shared/social-account-contract.mjs'

const accountPlatforms = operation => operation === 'crawl' ? HUB_SOCIAL_COMPAT_CRAWL_PLATFORMS : HUB_SOCIAL_COMPAT_PROFILE_PLATFORMS
const accountCapability = operation => operation === 'crawl' ? 'social.content.crawl' : 'social.profile.get'
export const hubSocialAccountPlatforms = (operation, scopes = null) => accountPlatforms(operation).filter(platform => scopes == null
  || scopes.some(scope => scope.platforms?.includes(platform) && scope.capabilities?.includes(accountCapability(operation))))

const metric = { type: ['number', 'null'], minimum: 0, description: '明确取得的零为 0；没有提供的值为 null。' }
const accountProfileSchema = { type: 'object', additionalProperties: true, description: '兼容扁平账号资料字段；保留当前平台已声明的其他业务字段。',
  properties: {
    user_id: { type: 'string' }, objectType: { const: 'user' }, user_name: { type: 'string' }, username: { type: 'string' }, name: { type: 'string' }, nickname: { type: 'string' },
    platform: { type: 'string' }, platform_name: { type: 'string' }, description: { type: 'string' },
    avatar_url: { type: 'string' }, profile_image_url: { type: 'string' }, url: { type: 'string' }, original_url: { type: 'string' },
    followers_count: metric, follower_count: metric, friends_count: metric, following_count: metric, statuses_count: metric,
    verified: { type: ['boolean', 'null'] }, location: { type: 'string' }, collected_at: { type: 'string', format: 'date-time' }, metadata: { type: 'string', description: '业务元数据 JSON 字符串。' },
  } }
const accountContentSchema = { type: 'object', additionalProperties: true, description: '兼容扁平内容字段；不同平台保持已声明的时间、媒体和业务字段。',
  properties: {
    id: { type: 'string' }, content_id: { type: 'string' }, external_id: { type: 'string' }, platform: { type: 'string' }, platform_name: { type: 'string' },
    content: { type: 'string' }, full_text: { type: 'string' }, text: { type: 'string' }, title: { type: ['string', 'null'] },
    content_type: { type: 'string' }, activityType: { type: 'string' }, author_id: { type: ['string', 'null'] }, author_name: { type: ['string', 'null'] }, author_avatar_url: { type: ['string', 'null'] },
    url: { type: ['string', 'null'] }, original_url: { type: ['string', 'null'] }, collected_at: { type: 'string', format: 'date-time' },
    like_count: metric, comment_count: metric, reply_count: metric, share_count: metric, forward_count: metric, view_count: metric, collect_count: metric, bookmark_count: metric,
    image_urls: { type: 'string', description: '图片 URL 数组的 JSON 字符串；空数组为 "[]"。' },
    video_urls: { type: 'string', description: '视频 URL 数组的 JSON 字符串；空数组为 "[]"。' }, metadata: { type: 'string', description: '业务元数据 JSON 字符串。' },
  } }
const accountPageSchema = { type: 'object', additionalProperties: true, required: ['page', 'pageSize', 'returnedCount', 'hasMore', 'nextCursor'],
  properties: { page: { type: 'integer', minimum: 1, maximum: 15 }, pageIndex: { type: 'integer', minimum: 1, maximum: 15 },
    pageSize: { type: 'integer', minimum: 1, maximum: 500 }, returnedCount: { type: 'integer', minimum: 0 }, hasMore: { type: 'boolean' },
    nextCursor: { type: ['string', 'null'], description: '下一页不透明游标；无可继续页面时为 null。若 warnings 含 pagination_completeness_unknown，无法继续不等于确认耗尽。' },
    providerCursor: { type: ['string', 'null'], description: '历史字段名；仅为同一个 Hub nextCursor 的兼容别名，不是原生游标。' },
    nextParams: { type: ['object', 'null'], properties: { cursor: { type: 'string' } } }, nextPage: { type: 'null' }, paginationMode: { const: 'cursor' },
  } }

function accountResponseSchema(operation) {
  const items = { type: 'array', items: operation === 'user-info' ? accountProfileSchema : { anyOf: [accountContentSchema, accountProfileSchema] } }
  return { type: 'object', required: ['contractVersion', 'data', 'requestId'], properties: {
    contractVersion: { const: 'mx-insight-hub.social-compat.v1', description: '新账号请求合同。原 Twitter 游标或已保存原幂等交付可能仍返回历史 mx-insight-hub.social-data.v1；该分支保持原字段，按原合同解析。' }, requestId: { type: 'string', format: 'uuid' },
    data: { type: 'object', required: ['platform', 'items', 'raw_info', 'raw_data', 'page', 'pageInfo', 'status', 'warnings', 'meta'], properties: {
      platform: { type: 'string' }, items, raw_info: { type: 'string', description: '账号资料数组的 JSON 字符串。' },
      raw_data: { type: 'string', description: operation === 'user-info' ? '资料查询保留 "[]"。' : '本页业务条目数组的 JSON 字符串；followers/following 是 objectType=user、user_id 的账号条目，没有 content_id。不能将整段字符串视为一个条目。' },
      page: accountPageSchema, pageInfo: accountPageSchema, status: { enum: ['ok', 'partial'] },
      warnings: { type: 'array', items: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' } }, additionalProperties: true } },
      meta: { type: 'object', properties: { implementation: { const: 'hub' }, resultCount: { type: 'integer', minimum: 0 }, upstreamCallCount: { type: 'integer', minimum: 0 }, providerCalls: { type: 'integer', minimum: 0 } }, additionalProperties: true },
      mode: { const: 'batch' }, results: { type: 'array', description: '多账号或活动组合的逐工作项结果。顶层 page/pageInfo 控制整个请求续页。', items: { type: 'object', properties: {
        platform: { type: 'string' }, kind: { type: 'string' }, value: { type: 'string' }, success: { type: 'boolean' }, items,
        raw_info: { type: 'string' }, raw_data: { type: 'string' }, page: accountPageSchema,
      }, additionalProperties: true } },
    }, additionalProperties: true },
  }, additionalProperties: true }
}

function accountOperation(row) {
  const identifier = { type: 'string', minLength: 1, maxLength: 2048 }
  const identifiers = { oneOf: [identifier, { type: 'array', minItems: 1, maxItems: 100, items: identifier }], description: '单账号或同一平台的账号列表；账号标识应来自对应平台，不能填内部任务 ID。' }
  const properties = {
    platform: { type: 'string', enum: accountPlatforms(row.key), description: '一次请求只选择一个平台；已发布的平台别名继续兼容，响应使用规范平台名。' },
    businessId: { type: 'string', deprecated: true, description: '历史兼容字段；可省略。提交时必须等于当前认证消费者绑定的值，不能改变调用身份。' },
    business_id: { type: 'string', deprecated: true, description: 'businessId 的历史别名；同样受当前认证身份绑定。' },
    username: { ...identifier, description: '平台用户名；Twitter 支持 @ 前缀。与平台账号 ID 的含义不同。' },
    usernames: identifiers,
    userId: { ...identifier, description: '平台账号 ID。Twitter 非数字兼容值按用户名解析；Hub 内部任务 ID 不能保证存在对应平台账号。' },
    userIds: identifiers, user_id: identifier, uid: identifier,
    url: identifier, urls: identifiers, profileUrl: identifier, profile_url: identifier,
    channelId: identifier, channel_id: identifier, channelUrl: identifier, channel_url: identifier,
    count: { type: 'integer', minimum: 1, maximum: 500, default: 20, description: `逻辑页上限，仍受当前 Key 页大小上限约束。兼容优先级 ${row.key === 'crawl' ? 'count > pageSize > page_size > limit' : 'limit > count > pageSize > page_size'}；pageSize 与 page_size 同时出现须相同。不足一页不代表没有后续。` },
    pageSize: { type: 'integer', minimum: 1, maximum: 500 }, page_size: { type: 'integer', minimum: 1, maximum: 500 }, limit: { type: 'integer', minimum: 1, maximum: 500 },
    cursor: { type: 'string', maxLength: 8192, description: '原样回传 data.pageInfo.nextCursor（兼容 data.page.nextCursor）。不解析、不改写，不与旧转发接口或内容搜索游标混用；原平台、账号、过滤条件、页大小及 Key 必须保持一致。' },
    page: { type: 'integer', minimum: 1, maximum: 15, default: 1, description: '首页为 1；后续页由 Hub 游标决定，不能单独递增页码跳页。' },
    params: { type: 'object', description: '仅接受对应平台、活动类型中已审核的业务参数；未知参数会在派发前拒绝。不得提交 provider、endpoint、凭据或原生分页游标。' },
    concurrency: { type: 'integer', minimum: 1, maximum: 20, description: '兼容接收的历史提示，不覆盖 Hub 的实际并发、准入或采购保护。' },
    cacheMaxAgeHours: { type: 'number', minimum: 0, maximum: 720, description: '兼容接收的历史提示，不承诺强制缓存命中，也不覆盖 Hub 请求幂等规则。' },
    includeRaw: { type: 'boolean', enum: [false], default: false, description: '保留 false/省略的兼容行为；raw_info/raw_data 始终是业务投影 JSON 字符串，不公开供应凭据或原始审计包。' },
    ...(row.key === 'crawl' ? { activityTypes: { type: 'array', items: { type: 'string' }, default: ['posts'], description: '默认账号发布内容 posts。其他活动必须为该平台已声明的类型，不能把一个平台的活动复制到另一个平台。' } } : {}),
  }
  return {
    tags: ['社媒与内容数据'], operationId: `hubSocial_${row.key.replace('-', '_')}`,
    summary: `${row.label}（Hub 账号接口）`, 'x-mx-platform-options': accountPlatforms(row.key),
    'x-mx-required-capabilities': [accountCapability(row.key)], 'x-mx-category': '账号数据',
    'x-mx-meter-key': accountCapability(row.key), 'x-mx-doc-path': '/docs/strategy-search',
    description: 'Hub 执行账号解析、字段投影及分页，保留已声明的历史账号参数和 raw_info/raw_data JSON 字符串，新增统一 items、page/pageInfo。旧转发入口继续保留；下游切换新接口须从第一页开始。授权要求同一 Key 同时具备目标平台和本操作 capability，不自动开通权限。逻辑页优先消费已取得余量并去重，再在允许范围内继续获取；最多 15 个公开页，游标保留 24 小时，页大小不是保证返回条数。短页或空页应读取 hasMore/nextCursor，不能按条数判定结束。未提供指标为 null，真实零值为 0。失败或未知不会伪装为成功空列表，也不会自动新建请求重试。',
    parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 128 }, description: '同一页面重试保持原标识与原请求体；下一页使用新标识。未知结果先只读核对，不自动换标识重发。' }],
    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['platform'],
      properties, anyOf: ['username', 'usernames', 'userId', 'userIds', 'user_id', 'uid', 'url', 'urls', 'profileUrl', 'profile_url', 'channelId', 'channel_id', 'channelUrl', 'channel_url', 'params'].map(name => ({ required: [name] })) },
      example: { platform: 'twitter', username: 'example', ...(row.key === 'crawl' ? { pageSize: 20 } : {}) } } } },
    responses: Object.fromEntries([200, 400, 401, 402, 403, 409, 429, 502, 503].map(status => [String(status), {
      description: status === 200 ? 'contractVersion、data（platform、items、raw_info、raw_data、page、pageInfo、meta、status、warnings）与 requestId。raw_info/raw_data 是 JSON 字符串；items 是数组，posts 等为内容条目，followers/following 和账号资料为账号条目。page/pageInfo 的 hasMore 与 nextCursor 同步。returnedCount 只描述本页，不代表账号总内容数。' : '稳定错误码与 requestId；请求未知时先查询原请求状态。400 为参数或游标错误，403 为授权，429 为准入限制；不通过自动重试绕开限制。',
      ...(status === 200 ? { content: { 'application/json': { schema: accountResponseSchema(row.key) } } } : {}),
    }])),
  }
}

export const hubSocialPaths = Object.fromEntries(Object.values(HUB_SOCIAL_ENDPOINTS).map(row => {
  if (row.key !== 'search') return [row.path.slice('/api/v1'.length), { post: accountOperation(row) }]
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

export function hubSocialGuide(allowed = () => true, scopes = null) {
  const rows = Object.values(HUB_SOCIAL_ENDPOINTS).filter(row => allowed(row.path.slice('/api/v1'.length)))
  if (!rows.length) return ''
  return `<h2>Hub 社媒与账号接口</h2><table><thead><tr><th>能力</th><th>POST 接口</th><th>已授权平台</th></tr></thead><tbody>${rows.map(row => `<tr><td>${row.label}</td><td><code>${row.path}</code></td><td>${row.key === 'search' ? 'twitter' : hubSocialAccountPlatforms(row.key, scopes).join('、')}</td></tr>`).join('')}</tbody></table>
    ${rows.some(row => row.key !== 'search') ? '<p>账号内容和资料由 Hub 执行。保留已声明的账号标识别名、raw_info/raw_data JSON 字符串，并提供统一 items、page/pageInfo。账号内容需要目标平台及 social.content.crawl，资料需要目标平台及 social.profile.get；接口可见不等于当前 Key 已开通。详细参数、活动类型及迁移示例见<a href="/docs/strategy-search">策略搜索接入指南</a>。</p><p>从旧转发入口切换需从第一页开始，不混用旧游标。后续页面原样回传 nextCursor，保持账号、平台、过滤条件和页大小，每页使用新 Idempotency-Key。短页不代表结束；只读核对未知请求，不能自动新建请求重试。完整字段仍可在响应 JSON 中查看。</p>' : ''}
    ${rows.some(row => row.key === 'search') ? '<p>此处 social/search 保留既有 Twitter 搜索合同；统一关键词检索优先使用 /api/v1/data/search，二者游标不互换。Hub-only 聚合搜索的范围继续以 GET /api/v1/data/aggregate/sources?execution=hub_only 的当前授权结果为准。</p>' : ''}`
}
