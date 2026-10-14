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

export const FACEBOOK_STRATEGY_MODE_LABELS = {
  auto: '额度优先：RapidAPI → JustOne', rapidapi: '固定：仅 RapidAPI', justone: '固定：仅 JustOne', paused: '暂停新搜索',
}

export function strategyPolicyEditor(interfaceId, row) {
  if (interfaceId !== 'search') return null
  const instagram = instagramStrategyOptions(row)
  if (instagram.providers.length && instagram.modes.length) return 'instagram'
  if (row?.platform === 'facebook' && row.editable === true && row.policy
    && Number.isSafeInteger(row.policy.revision) && row.policy.revision > 0
    && Object.hasOwn(FACEBOOK_STRATEGY_MODE_LABELS, row.policy.mode)
    && ['rapidapi', 'justone'].every(provider => row.providers?.includes(provider))
    && row.allowedModes?.includes(row.policy.mode)) return 'facebook'
  return null
}

// A registered route and a configurable strategy are different facts. Only the
// two reviewed search policy editors can expose writes; inventory is read-only.
export function strategyPolicySummary(interfaceId, row) {
  const editor = strategyPolicyEditor(interfaceId, row)
  const providerLabel = provider => STRATEGY_PROVIDER_LABELS[provider] || provider || '未提供'
  if (!row) return { title: '尚未选择目标平台', mode: '未提供', description: '选择业务接口和平台后查看策略。', providers: [], modes: [], editor: null }
  if (editor === 'instagram') {
    const policy = row.policy, { providers, modes } = instagramStrategyOptions(row)
    const primary = providerLabel(policy.primaryProvider), fallback = providerLabel(policy.fallbackProvider)
    const current = policy.mode === 'priority'
      ? { title: `优先 ${primary} → 保底 ${fallback}`, mode: '优先与保底', description: '仅在首请求尚未派发且优先供应商未通过准入时选用保底供应商；400、超时、未知结果与已付费不可用结果不会触发自动切换。' }
      : policy.mode === 'paused'
        ? { title: '暂停新的 Instagram 搜索', mode: '暂停', description: '停止新的采集；已保存请求保留既有回放规则，原供应商设置保持不变。' }
        : { title: `固定 ${primary}`, mode: '固定供应商', description: `新搜索仅使用 ${primary}。该供应商未就绪时返回具体原因，不自动转到其他供应商。` }
    return { ...current, editor, providers, modes: modes.map(mode => INSTAGRAM_STRATEGY_MODE_LABELS[mode]), revision: policy.revision }
  }
  if (editor === 'facebook') {
    const policy = row.policy
    const current = policy.mode === 'auto'
      ? { title: 'RapidAPI 额度优先 → JustOne 保底', mode: '额度优先', description: '优先使用 RapidAPI 套餐额度；额度不可用时按现有规则转 JustOne。已派发的请求仅确认 429 时可按既有规则使用保底，400、超时和未知结果不会触发自动重试。' }
      : policy.mode === 'paused'
        ? { title: '暂停新的 Facebook 搜索', mode: '暂停', description: '停止新的搜索采集，保留原额度记录与已保存请求。' }
        : { title: `固定 ${providerLabel(policy.mode)}`, mode: '固定供应商', description: `新搜索仅使用 ${providerLabel(policy.mode)}；此模式不启用另一供应商作为保底。` }
    return { ...current, editor, providers: ['rapidapi', 'justone'],
      modes: row.allowedModes.filter(mode => Object.hasOwn(FACEBOOK_STRATEGY_MODE_LABELS, mode)).map(mode => FACEBOOK_STRATEGY_MODE_LABELS[mode]), revision: policy.revision }
  }
  if (row.platform === 'twitter') return { title: '仅 RapidAPI', mode: '已登记路由 · 只读',
    description: 'Twitter 仅使用 RapidAPI。兼容入口的迁移状态独立展示，当前没有已接入的可切换供应商。', providers: ['rapidapi'], modes: [], editor: null }
  if (row.migrationStatus === 'local') return { title: 'Hub 已收录数据', mode: '本地检索 · 只读',
    description: '读取已采集数据，不选择付费搜索供应商。', providers: [], modes: [], editor: null }
  return { title: row.providers?.length === 1 ? `已登记供应商：${providerLabel(row.providers[0])}` : '沿用当前路由',
    mode: row.editable ? '策略尚未就绪' : '已登记路由 · 只读',
    description: row.editable ? '尚未读取到完整、可编辑的策略与修订。请刷新策略；不会根据供应商目录模拟切换。'
      : row.readOnlyReason || '此业务接口当前没有已验证的供应商切换策略，沿用现有路由。',
    providers: row.providers || [], modes: [], editor: null }
}
