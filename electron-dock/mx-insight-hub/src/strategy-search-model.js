export const STRATEGY_SEARCH_PATH = '/data-products/strategy-search'
export const STRATEGY_SEARCH_INTERFACES = [
  { id: 'search', label: '关键词搜索', description: '按关键词和目标平台获取内容，使用统一条目或兼容 raw 响应。',
    paths: ['/api/v1/data/search', '/api/v1/search/raw', '/api/v1/night-all/search/raw'],
    input: '统一接口使用 platform、query、pageSize 和可选 cursor；raw 入口保留既有请求合同。',
    output: '统一接口交付 items、pageInfo、status 和 warnings；raw 入口保留 raw_info / raw_data。',
    boundary: '每次查询针对一个目标平台。路由策略属于业务接口，修改搜索策略不会更改账号内容或账号资料接口。' },
  { id: 'crawl', label: '账号内容', description: '按账号获取其内容，沿用各平台已登记的账号标识和分页合同。',
    paths: ['/api/v1/search/crawl', '/api/v1/night-all/search/crawl'],
    input: '使用目标平台及其既有账号参数；不同平台的账号 ID、链接与分页字段不能互换。',
    output: '保持兼容响应及平台内容字段，通过返回的游标继续读取。',
    boundary: '迁移状态与关键词搜索分别管理。当前不可配置的接口保留原路由，页面只展示接入状态。' },
  { id: 'user-info', label: '账号资料', description: '查询指定账号的公开资料，保持平台账号身份和原有返回字段。',
    paths: ['/api/v1/search/user-info', '/api/v1/night-all/search/user-info'],
    input: '按接口文档提交平台和账号标识，不把关键词搜索的参数用于资料查询。',
    output: '交付账号资料与请求关联信息，保留现有兼容合同。',
    boundary: '资料查询与内容采集是独立业务接口。搜索供应商的调整不会自动迁移账号资料调用。' },
]

export const STRATEGY_PROVIDER_LABELS = { justone: 'JustOne', tikhub: 'TikHub', rapidapi: 'RapidAPI', 'night-all': 'Night-All' }
export const INSTAGRAM_STRATEGY_MODE_LABELS = { fixed: '固定供应商', priority: '优先与保底', paused: '暂停新搜索' }
export const STRATEGY_MIGRATION_LABELS = { hub_native: 'Hub 直连', conditional: '部分已迁移', night_all: '仍经 Night-All', local: '本地数据' }

export function strategySearchLink(platform, interfaceId = 'search') {
  const params = new URLSearchParams({ view: 'routing', interface: interfaceId })
  if (platform) params.set('platform', platform)
  return `#${STRATEGY_SEARCH_PATH}?${params}`
}

export function instagramStrategyOptions(row) {
  if (row?.platform !== 'instagram' || row.editable !== true || !row.policy
    || !Number.isSafeInteger(row.policy.revision) || row.policy.revision < 1) return { providers: [], modes: [] }
  const providers = ['justone', 'tikhub'].filter(value => row.providers?.includes(value))
  const modes = Object.keys(INSTAGRAM_STRATEGY_MODE_LABELS).filter(value => row.allowedModes?.includes(value)
    && (value !== 'priority' || providers.length === 2))
  return { providers, modes }
}

export function instagramStrategyUpdate(row, draft) {
  const { providers, modes } = instagramStrategyOptions(row)
  if (!modes.includes(draft.mode) || !providers.includes(draft.primaryProvider)) throw new Error('当前接口不允许此供应商策略，请刷新后重试。')
  const reason = String(draft.reason || '').trim()
  if (!reason || reason.length > 1000) throw new Error('请填写 1–1000 字的修改原因。')
  return { mode: draft.mode, primaryProvider: draft.primaryProvider,
    fallbackProvider: draft.mode === 'priority' ? providers.find(value => value !== draft.primaryProvider) : null,
    expectedRevision: row.policy.revision, reason }
}
