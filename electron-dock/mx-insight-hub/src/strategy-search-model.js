import { THREADS_SCRAPER_ROUTE } from '../shared/threads-search-routing.mjs'

export const STRATEGY_SEARCH_PATH = '/data-products/strategy-search'
export const STRATEGY_SEARCH_INTERFACES = [
  { id: 'search', label: '关键词搜索', description: '按关键词和目标平台获取内容，使用统一条目或兼容 raw 响应。',
    paths: ['/api/v1/data/search', '/api/v2/data/search', '/api/v1/search/raw', '/api/v1/night-all/search/raw'],
    input: '统一接口使用 platform、query、pageSize 和可选 cursor；raw 入口保留既有请求合同。',
    output: '统一接口交付 items、pageInfo、status 和 warnings；raw 入口保留 raw_info / raw_data。',
    boundary: '每次查询针对一个目标平台。路由策略属于业务接口，修改搜索策略不会更改账号内容或账号资料接口。' },
  { id: 'crawl', label: '账号内容', description: '按账号获取其内容，沿用各平台已登记的账号标识和分页合同。',
    paths: ['/api/v1/data/social/crawl', '/api/v1/search/crawl', '/api/v1/night-all/search/crawl'],
    input: 'Hub 接口接受 platform、username / userId / user_id / uid，以及 count / pageSize / page_size / limit；批量账号和平台特定参数见详细文档。',
    output: 'Hub 返回 items、raw_info / raw_data JSON 字符串及 page / pageInfo；只按返回的 nextCursor 续页，短页不代表结束。',
    boundary: 'Hub 接口需要当前平台及 social.content.crawl 授权。旧转发入口保留；从旧接口切换时从第一页开始，不混用旧游标。' },
  { id: 'user-info', label: '账号资料', description: '查询指定账号的公开资料，保持平台账号身份和原有返回字段。',
    paths: ['/api/v1/data/social/user-info', '/api/v1/search/user-info', '/api/v1/night-all/search/user-info'],
    input: 'Hub 接口接受 platform 与 username / userId / user_id / uid；各平台的 ID 与用户名不可互换，批量别名见详细文档。',
    output: '交付账号资料 items、raw_info JSON 字符串及请求关联信息，缺失字段与真实零值分别保留。',
    boundary: 'Hub 接口需要当前平台及 social.profile.get 授权。资料查询与内容采集独立管理，旧转发入口继续保留。' },
  { id: 'post-detail', label: '帖子详情', description: '按帖子标识或原文链接获取一篇 Threads 帖子。',
    paths: ['/api/v1/data/social/post-detail'],
    input: 'platform 为 threads，contentId 接受数字帖子 ID 或短码，也可通过 url 传入帖子链接。',
    output: 'data.item 包含正文、作者、媒体、发布时间和已提供的互动指标。',
    boundary: '需要 threads 平台及 social.posts.resolve 授权。此接口每次查询一篇帖子。' },
  { id: 'post-comments', label: '帖子评论', description: '按 contentId（帖子 ID）或帖子链接获取一级评论，每条评论附带可直接用于查回复的 replyRef。',
    paths: ['/api/v1/data/social/post-comments', '/api/v1/search/post-comments', '/api/v1/night-all/search/post-comments'],
    input: 'platform 与 contentId（或 postId、平台专用 ID、规范帖子 URL），可选 count（1–100，默认 20）与 cursor。',
    output: '交付 items（评论）、page / pageInfo 分页状态和 warnings；每条评论含 commentId、正文、作者、时间、互动量与 replyRef。',
    boundary: '需要当前平台及 social.comments.list 授权。供应商按「管理」中的平台策略选择，游标固定原供应商。' },
  { id: 'comment-replies', label: '评论回复', description: '按 commentId 获取评论下的回复（楼中楼）；直接传评论返回的 replyRef 即可。',
    paths: ['/api/v1/data/social/comment-replies'],
    input: 'platform 与 commentId；抖音、小红书、快手、B站、Instagram、Reddit 还需要所属帖子的 contentId（replyRef 已包含）。',
    output: '交付 items（回复），每条含 rootCommentId（被查询的评论）、parentCommentId（直接回复对象，未知为 null）及分页状态。',
    boundary: '与帖子评论共用 social.comments.list 授权与计费。尚未校准的平台在派发前返回 external_platform_contract_unverified，不计费。' },
]
export const STRATEGY_OPERATION_OPTIONS = STRATEGY_SEARCH_INTERFACES.map(({ id, label }) => ({ value: id, label }))
export const STRATEGY_COMMENT_INTERFACES = ['post-comments', 'comment-replies']
export const COMMENT_VERIFICATION_LABELS = { verified: '已用付费样本验证', sample: '按供应商官方样例校准', derived: '沿用同平台已校准结构', pending: '待校准 · 暂不派发' }
export const COMMENT_STRATEGY_MODE_LABELS = { fixed: '固定供应商', priority: '优先与保底', paused: '暂停新采购' }

export function commentRouteOptions(row) {
  if (!row?.editable || !row.policy || !Number.isSafeInteger(row.policy.revision) || row.policy.revision < 1) return { providers: [], modes: [] }
  const providers = (row.providers || []).filter(provider => row.providerVerification?.[provider])
  const modes = Object.keys(COMMENT_STRATEGY_MODE_LABELS).filter(mode => row.allowedModes?.includes(mode) && (mode !== 'priority' || providers.length > 1))
  return { providers, modes }
}

export function commentRouteUpdate(row, draft) {
  const { providers, modes } = commentRouteOptions(row)
  if (!modes.includes(draft.mode) || !providers.includes(draft.primaryProvider)) throw new Error('当前平台不允许此供应商策略，请刷新后重试。')
  const fallbackProvider = draft.mode === 'priority' ? draft.fallbackProvider : null
  if (draft.mode === 'priority' && (!providers.includes(fallbackProvider) || fallbackProvider === draft.primaryProvider)) throw new Error('请选择与优先供应商不同的保底供应商。')
  const reason = String(draft.reason || '').trim()
  if (!reason || reason.length > 1000) throw new Error('请填写 1–1000 字的修改原因。')
  return { mode: draft.mode, primaryProvider: draft.primaryProvider, fallbackProvider, expectedRevision: row.policy.revision, reason }
}

export const STRATEGY_PROVIDER_LABELS = { justone: 'JustOne', tikhub: 'TikHub', rapidapi: 'RapidAPI', [THREADS_SCRAPER_ROUTE]: 'RapidAPI · Threads Scraper', 'night-all': 'Night-All', 'night-all-a': 'Night-All-A 自建' }
export function strategySupplierLabel(provider, platform) {
  if (platform === 'threads' && provider === 'rapidapi') return 'RapidAPI · Threads API（threads-api4）'
  return STRATEGY_PROVIDER_LABELS[provider] || provider || '未提供'
}
export const INSTAGRAM_STRATEGY_MODE_LABELS = { fixed: '固定供应商', priority: '优先与保底', paused: '暂停新搜索' }
export const TWITTER_STRATEGY_MODE_LABELS = { fixed: '固定供应商', priority: '优先与保底', paused: '暂停新采购' }
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

export function twitterStrategyOptions(row) {
  if (row?.platform !== 'twitter' || row.editable !== true || !row.policy
    || !Number.isSafeInteger(row.policy.revision) || row.policy.revision < 1) return { providers: [], modes: [] }
  const providers = ['rapidapi', 'tikhub'].filter(value => row.providers?.includes(value))
  const modes = Object.keys(TWITTER_STRATEGY_MODE_LABELS).filter(value => row.allowedModes?.includes(value)
    && (value !== 'priority' || providers.length === 2))
  return { providers, modes }
}

export function twitterStrategyUpdate(row, draft) {
  const { providers, modes } = twitterStrategyOptions(row)
  if (!modes.includes(draft.mode) || !providers.includes(draft.primaryProvider)) throw new Error('当前接口不允许此供应商策略，请刷新后重试。')
  const reason = String(draft.reason || '').trim()
  if (!reason || reason.length > 1000) throw new Error('请填写 1–1000 字的修改原因。')
  return { mode: draft.mode, primaryProvider: draft.primaryProvider,
    fallbackProvider: draft.mode === 'priority' ? providers.find(value => value !== draft.primaryProvider) : null,
    expectedRevision: row.policy.revision, reason }
}

export const FACEBOOK_STRATEGY_MODE_LABELS = {
  auto: '额度优先：RapidAPI → JustOne', rapidapi: '固定：仅 RapidAPI', justone: '固定：仅 JustOne',
  selfhosted: '自建：仅 Night-All-A', paused: '暂停新搜索',
}
export const FACEBOOK_SELFHOSTED_LIMITS = { concurrency: [1, 8], requestsPerMinute: [1, 120] }

export function strategyPolicyEditor(interfaceId, row) {
  if (STRATEGY_COMMENT_INTERFACES.includes(interfaceId) || row?.platform === 'threads') {
    const { providers, modes } = commentRouteOptions(row)
    return providers.includes(row?.policy?.primaryProvider) && modes.includes(row.policy.mode) ? 'comment-route' : null
  }
  if (['crawl', 'user-info'].includes(interfaceId) && row?.platform === 'facebook'
    && row.editable === true && ['fixed', 'paused'].includes(row.policy?.mode)
    && row.policy.primaryProvider === 'justone' && row.policy.fallbackProvider === null
    && Number.isSafeInteger(row.policy.revision) && row.policy.revision > 0
    && row.providers?.includes('justone')
    && ['fixed', 'paused'].every(mode => row.allowedModes?.includes(mode))) return 'facebook-account'
  if (interfaceId !== 'search') return null
  const instagram = instagramStrategyOptions(row)
  if (instagram.providers.length && instagram.modes.length) return 'instagram'
  const twitter = twitterStrategyOptions(row)
  if (twitter.providers.includes(row?.policy?.primaryProvider) && twitter.modes.includes(row?.policy?.mode)
    && (row.policy.mode !== 'priority' || twitter.providers.includes(row.policy.fallbackProvider)
      && row.policy.fallbackProvider !== row.policy.primaryProvider)) return 'twitter'
  if (row?.platform === 'facebook' && row.editable === true && row.policy
    && Number.isSafeInteger(row.policy.revision) && row.policy.revision > 0
    && Object.hasOwn(FACEBOOK_STRATEGY_MODE_LABELS, row.policy.mode)
    && ['rapidapi', 'justone'].every(provider => row.providers?.includes(provider))
    && row.allowedModes?.includes(row.policy.mode)) return 'facebook'
  return null
}

// A registered route and a configurable strategy are different facts. Only the
// reviewed policy editors can expose writes; other inventory stays read-only.
export function strategyPolicySummary(interfaceId, row) {
  const editor = strategyPolicyEditor(interfaceId, row)
  const providerLabel = provider => strategySupplierLabel(provider, row?.platform)
  if (!row) return { title: '尚未选择目标平台', mode: '未提供', description: '选择业务接口和平台后查看策略。', providers: [], modes: [], editor: null }
  if (editor === 'comment-route') {
    const policy = row.policy, { providers, modes } = commentRouteOptions(row)
    const primary = providerLabel(policy.primaryProvider), fallback = providerLabel(policy.fallbackProvider)
    const level = provider => COMMENT_VERIFICATION_LABELS[row.providerVerification?.[provider]] || '未登记'
    const current = policy.mode === 'priority'
      ? { title: `优先 ${primary} → 保底 ${fallback}`, mode: '优先与保底', description: `首请求派发前，${primary} 的凭据、操作开关或价格未就绪时改用已就绪的 ${fallback}。已派发后的拒绝、超时、未知结果或不可解析响应不会自动换供应商重买；游标固定原供应商。` }
      : policy.mode === 'paused'
        ? { title: `暂停新的${row.platform === 'threads' && !STRATEGY_COMMENT_INTERFACES.includes(interfaceId) ? `Threads ${STRATEGY_SEARCH_INTERFACES.find(item => item.id === interfaceId)?.label || ''}` : interfaceId === 'comment-replies' ? '评论回复' : '帖子评论'}采购`, mode: '暂停', description: '停止新的供应商采购，包括续页需要的后续采购；已完成响应的精确重放和已购缓冲数据仍可交付。' }
        : { title: `固定 ${primary}`, mode: '固定供应商', description: `新请求仅使用 ${primary}（${level(policy.primaryProvider)}）。该供应商未就绪时返回具体原因，不自动切换。` }
    return { ...current, editor, providers, modes: modes.map(mode => COMMENT_STRATEGY_MODE_LABELS[mode]), revision: policy.revision,
      verification: providers.map(provider => `${providerLabel(provider)}：${level(provider)}`) }
  }
  if (editor === 'facebook-account') {
    const label = interfaceId === 'crawl' ? '账号内容' : '账号资料'
    return { editor, title: `${row.policy.mode === 'paused' ? '已暂停' : '已启用'} Facebook ${label}`,
      mode: row.policy.mode === 'paused' ? '暂停新采购' : '启用', providers: ['justone'],
      modes: ['启用', '暂停新采购'], revision: row.policy.revision,
      description: `仅控制 Facebook ${label}业务的新采购，包括需要再次采集的分页及旧兼容入口；保留历史响应重放和已购缓冲。账号内容的前置资料解析只受账号内容开关控制。上游接口单独暂停仍会阻止其调用。` }
  }
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
        : policy.mode === 'selfhosted'
          ? { title: '自建 Night-All-A', mode: '自建采集', description: `新搜索只派发到自建 Night-All-A，不转付费供应商。全集群同时最多 ${policy.selfhosted_max_concurrency ?? 2} 个请求在途，每分钟最多启动 ${policy.selfhosted_requests_per_minute ?? 12} 次；名额已满时在请求时限内排队，超时返回忙碌。` }
          : { title: `固定 ${providerLabel(policy.mode)}`, mode: '固定供应商', description: `新搜索仅使用 ${providerLabel(policy.mode)}；此模式不启用另一供应商作为保底。` }
    return { ...current, editor, providers: ['rapidapi', 'justone', ...(row.providers.includes('night-all-a') ? ['night-all-a'] : [])],
      modes: row.allowedModes.filter(mode => Object.hasOwn(FACEBOOK_STRATEGY_MODE_LABELS, mode)).map(mode => FACEBOOK_STRATEGY_MODE_LABELS[mode]), revision: policy.revision }
  }
  if (editor === 'twitter') {
    const policy = row.policy, { providers, modes } = twitterStrategyOptions(row)
    const primary = providerLabel(policy.primaryProvider), fallback = providerLabel(policy.fallbackProvider)
    const current = policy.mode === 'priority'
      ? { title: `优先 ${primary} → 保底 ${fallback}`, mode: '优先与保底', description: policy.primaryProvider === 'rapidapi'
        ? '优先供应商凭据或操作策略未就绪时使用保底；无游标的新搜索在尚未取得成功源页、RapidAPI 明确返回 HTTP 400 时，也可原条件转 TikHub 一次。超时、未知结果、成功响应不可用及其他错误不会触发自动切换。'
        : '仅在新请求尚未派发、优先供应商凭据或操作策略未就绪时使用已就绪的保底供应商；TikHub 的400、超时、未知结果及成功响应不可用均不触发自动切换。' }
      : policy.mode === 'paused'
        ? { title: '暂停 Twitter 新采购', mode: '暂停', description: '暂停新供应商采购，包括已有游标需要的后续采购；已完成响应的重放与已购缓冲数据仍可交付。' }
        : { title: `固定 ${primary}`, mode: '固定供应商', description: `新搜索仅使用 ${primary}。该供应商未就绪时返回具体原因，不自动转到其他供应商。` }
    return { ...current, editor, providers, modes: modes.map(mode => TWITTER_STRATEGY_MODE_LABELS[mode]), revision: policy.revision }
  }
  if (row.platform === 'twitter' && interfaceId !== 'search') return { title: '仅 RapidAPI', mode: '已登记路由 · 只读',
    description: 'Twitter 账号接口保留原 RapidAPI 路由，不受标准内容搜索策略控制。兼容入口的迁移状态独立展示。', providers: ['rapidapi'], modes: [], editor: null }
  if (row.migrationStatus === 'local') return { title: 'Hub 已收录数据', mode: '本地检索 · 只读',
    description: '读取已采集数据，不选择付费搜索供应商。', providers: [], modes: [], editor: null }
  return { title: row.providers?.length === 1 ? `已登记供应商：${providerLabel(row.providers[0])}` : '沿用当前路由',
    mode: row.editable ? '策略尚未就绪' : '已登记路由 · 只读',
    description: row.editable ? '尚未读取到完整、可编辑的策略与修订。请刷新策略；不会根据供应商目录模拟切换。'
      : row.readOnlyReason || '此业务接口当前没有已验证的供应商切换策略，沿用现有路由。',
    providers: row.providers || [], modes: [], editor: null }
}
