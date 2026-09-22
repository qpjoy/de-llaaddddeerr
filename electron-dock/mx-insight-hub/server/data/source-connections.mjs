import { NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS } from '../contracts/night-all-legacy.mjs'
import { SOCIAL_ACCOUNT_PLATFORMS, socialAccountPlatform } from '../contracts/social-accounts.mjs'
import { JUSTONE_RESOURCE_CATALOG } from '../contracts/justone-resources.mjs'
import { JUSTONE_MARKETPLACE_CATALOG } from '../ingest/justone.mjs'
import { PUBLIC_OPINION_DATASET_ID } from './public-opinion.mjs'
import { CRAWLER_SOURCES, crawlerSourceSpecForKey } from '../ingest/crawler/source-contract.mjs'

// Read-only implementation inventory, not a dispatch registry or a grant.
// Stable catalog keys survive operator renames; hints never create a route.
const SOCIAL_CATALOG = {
  douyin: '0001', kuaishou: '0002', xiaohongshu: '0004', weibo: '0005',
  bilibili: '0006', zhihu: '0007', wechat_mp: '0025', wechat_search: '0026',
  tiktok: '0085', twitter: '0086', instagram: '0087', facebook: '0088',
  youtube: '0089', reddit: '0090', linkedin: '0091',
}
const catalogKey = platform => SOCIAL_CATALOG[platform] ? `source-catalog-${SOCIAL_CATALOG[platform]}` : null
const CANONICAL_PATH = '/api/v1/data/canonical/search'
const PROVIDER_LABELS = { tikhub: 'T 平台', justone: 'JustOne', 'night-all': 'Night-All', 'night-all-a': 'Night-All-A', qixin: '启信慧眼（启信宝）', ipsearch: 'ipsearch' }

function route(id, fields) {
  return {
    id, catalogKeys: [], datasets: [], sourceKeys: [], mode: 'live',
    defaultRule: '固定合同路由；执行时仍校验授权、凭据、策略和价格。',
    keywordSearch: false, ...fields,
  }
}

function implementedRoutes(sources) {
  const rows = []
  for (const [operation, platforms] of Object.entries(NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS)) {
    for (const platform of platforms) rows.push(route(`legacy-${platform}-${operation}`, {
      platform, catalogKeys: [catalogKey(platform)].filter(Boolean), provider: 'night-all',
      product: '社交内容与账号', operation, mode: 'compatibility',
      path: `/api/v1/search/${operation}`, keywordSearch: operation === 'raw',
      defaultRule: platform === 'xiaohongshu'
        ? '历史游标、批量或未迁移形状保留此分支；已迁移形状走 Hub 直连，非自动故障切换。'
        : '现行历史兼容入口；平台支持取自 Hub 固定合同，实时可用性待请求验证。',
      evidence: 'server/contracts/night-all-legacy.mjs',
    }))
  }
  rows.push(route('xiaohongshu-posts', {
    platform: 'xiaohongshu', catalogKeys: [catalogKey('xiaohongshu')], provider: 'tikhub',
    product: '小红书笔记画卷', operation: 'social.posts.search', path: '/api/v1/data/search',
    datasets: ['social.posts.v1'], keywordSearch: true,
    defaultRule: '符合直连条件的新搜索走 T 平台；历史 mxnc1 游标与未迁移形状保持原路由。',
    evidence: 'server/hub-service.mjs',
  }))
  rows.push(route('data-search-adapter', {
    platform: '按 /api/v1/data/capabilities 返回的平台', provider: 'night-all',
    product: '跨平台内容', operation: 'data.search', path: '/api/v1/data/search',
    keywordSearch: true, mode: 'compatibility',
    defaultRule: '非已迁移直连形状委托内部数据服务；此看板不请求上游能力目录，支持范围与健康不作静态推断。',
    evidence: 'server/adapters/night-all.mjs',
  }))
  for (const [operation, path, label] of [
    ['social.posts.resolve', '/api/v1/data/post', '小红书笔记详情'],
    ['social.users.resolve', '/api/v1/search/user-info', '小红书用户资料'],
    ['social.users.posts', '/api/v1/search/crawl', '小红书用户笔记'],
  ]) rows.push(route(`xiaohongshu-${operation}`, {
    platform: 'xiaohongshu', catalogKeys: [catalogKey('xiaohongshu')], provider: 'tikhub',
    product: '小红书笔记画卷', operation, path, label,
    defaultRule: '已迁移且符合直连形状的请求走 T 平台；兼容入口的其他形状与历史游标保留原分支。',
    evidence: 'server/hub-service.mjs',
  }))
  for (const platform of SOCIAL_ACCOUNT_PLATFORMS) {
    const spec = socialAccountPlatform(platform)
    rows.push(route(`accounts-${platform}`, {
      platform, catalogKeys: [catalogKey(platform)].filter(Boolean), provider: spec.providerKey,
      product: '社交账号', operation: 'social.accounts.search', keywordSearch: true,
      path: '/api/v1/data/social/accounts/search', datasets: ['social.accounts.v1'],
      evidence: 'server/contracts/social-accounts.mjs',
    }))
  }
  for (const [platform, catalog] of Object.entries(JUSTONE_MARKETPLACE_CATALOG)) {
    rows.push(route(`products-${platform}`, {
      platform, catalogKeys: [catalog.sourceKey], provider: 'justone', product: '电商数据',
      operation: 'ecommerce.products.search', keywordSearch: true,
      path: '/api/v1/data/ecommerce/products/search', datasets: ['ecommerce.products.v1'],
      defaultRule: '指定单平台才采集；全部平台只读已存商品。天猫通过淘宝合同限定商城。',
      evidence: 'server/ingest/justone.mjs',
    }))
  }
  for (const resource of Object.values(JUSTONE_RESOURCE_CATALOG)) {
    rows.push(route(`resource-${resource.resourceKey}`, {
      platform: resource.marketplaces.join(' / '),
      catalogKeys: resource.marketplaces.map(value => JUSTONE_MARKETPLACE_CATALOG[value]?.sourceKey).filter(Boolean),
      provider: 'justone', product: '电商数据', operation: resource.operationKey,
      label: resource.label, path: resource.hubPath,
      defaultRule: `固定资源接口；默认版本 ${resource.defaultVersion}，不是通用关键词搜索。`,
      evidence: 'server/contracts/justone-resources.mjs',
    }))
  }
  for (const [scope, sourcePrefix, label] of [
    ['monitor', 'telegram-monitor', 'Telegram monitor'],
    ['sqlite', 'telegram-sqlite-api', 'Telegram SQLite API'],
  ]) rows.push(route(`telegram-${scope}`, {
    platform: 'telegram', catalogKeys: ['source-catalog-0160', 'source-catalog-0161'],
    product: 'Telegram 会话', provider: null, label, mode: 'stored', keywordSearch: true,
    operation: 'canonical.search', path: CANONICAL_PATH,
    sourceKeys: ['chats', 'messages'].map(role => `${sourcePrefix}-${role}`),
    datasets: ['chats', 'messages'].map(role => `telegram.${scope}.${role}.v1`),
    defaultRule: '两个来源并列清洗入库；会话按来源与聊天标识隔离，查询不触发 Telegram 采集。',
    evidence: `server/ingest/telegram/${scope}-pipeline.mjs`,
  }))
  rows.push(route('public-opinion', {
    platform: 'public_opinion', provider: 'night-all', product: '全国舆情',
    operation: 'canonical.search', path: CANONICAL_PATH, mode: 'stored', keywordSearch: true,
    sourceKeys: ['province-opinion-results'], datasets: [PUBLIC_OPINION_DATASET_ID],
    defaultRule: '清洗 monitor_strategy_results；读取 Hub 发布数据，不在检索时调用 Night-All 搜索。',
    evidence: 'server/ingest/province/source-contract.mjs',
  }))
  rows.push(route('mobile-commerce', {
    platform: 'mobile_commerce', provider: null, label: '手机电商采集库', product: '手机电商 / 虚拟超市',
    catalogKeys: ['source-catalog-0001', 'source-catalog-0002', 'source-catalog-0058', 'source-catalog-0062', 'source-catalog-0063', 'source-catalog-0073'],
    operation: 'canonical.search', path: CANONICAL_PATH, mode: 'stored', keywordSearch: true,
    sourceKeys: ['mobile-commerce-collected-items'], datasets: ['mobile-commerce.collected-items.v1'],
    defaultRule: '读取 mb_collected_items 清洗结果；虚拟超市另按上架状态提供专用读取。',
    evidence: 'server/ingest/mobile-commerce/source-contract.mjs',
  }))
  const specs = new Map(CRAWLER_SOURCES.map(spec => [spec.sourceKey, spec]))
  for (const source of sources) {
    const spec = crawlerSourceSpecForKey(source.sourceKey)
    if (spec) specs.set(spec.sourceKey, spec)
  }
  for (const spec of specs.values()) rows.push(route(`saved-${spec.sourceType}`, {
    platform: spec.platform, provider: 'night-all-a', product: '分类存量 / 专题洞察',
    label: spec.displayName, operation: 'canonical.search', path: CANONICAL_PATH,
    mode: 'stored', keywordSearch: true, sourceKeys: [spec.sourceKey], datasets: [spec.datasetId],
    defaultRule: '分类清洗入库后搜索；分类存在不证明凤凰网等具体站点已接入，站点需记录级目录映射证据。',
    evidence: 'server/ingest/crawler/source-contract.mjs',
  }))
  rows.push(route('enterprise', {
    platform: 'enterprise', catalogKeys: ['source-catalog-0175'], provider: 'qixin', product: '企业数据',
    operation: 'enterprise.query', path: '/api/v1/data/enterprise/{apiId}/query',
    defaultRule: '按明确 apiId 和参数查询；未公开定价的接口禁用，不纳入通用全文搜索。',
    evidence: 'server/contracts/enterprise.mjs',
  }), route('ip-risk', {
    platform: 'ip_risk', provider: 'ipsearch', product: 'IP 风险画像',
    operation: 'ip.risk.query', path: '/api/v1/data/ip/risk',
    defaultRule: '按 IPv4 查询；私有风险结果不进入共享 canonical 检索。',
    evidence: 'server/contracts/ip-risk.mjs',
  }))
  rows.push(route('virtual-supermarket', {
    platform: 'virtual_supermarket', provider: null, product: '虚拟超市',
    operation: 'storefront.search', path: '/api/v1/data/virtual-supermarket/search',
    mode: 'stored', keywordSearch: true,
    defaultRule: '仅搜索已上架商品；从手机电商捕获发布，独立权限与店面版本，不触发采集。',
    evidence: 'server/data/virtual-supermarket.mjs',
  }), route('topic-reports', {
    platform: '分类存量授权范围', provider: null, product: '专题洞察',
    operation: 'topic-reports.read', path: '/api/v1/data/topic-reports',
    mode: 'stored', keywordSearch: true,
    defaultRule: '检索调用方自己的既有报告；创建报告是独立操作，读列表不调用 Agent 或上游。',
    evidence: 'server/insights/topic-reports.mjs',
  }))
  return rows
}

export function sourceConnectionSnapshot(entries, sources, { now = new Date() } = {}) {
  const byKey = new Map(entries.map(entry => [entry.sourceKey, entry]))
  const sourceByKey = new Map(sources.map(source => [source.sourceKey, source]))
  const routes = implementedRoutes(sources).map(item => {
    const { provider, ...safe } = item
    return {
      ...safe,
      sourceProviderLabel: PROVIDER_LABELS[provider] || item.label || 'Hub 已存数据',
      sourceLabel: item.label || PROVIDER_LABELS[provider] || 'Hub 已存数据',
      platformLabel: item.catalogKeys.map(key => byKey.get(key)?.canonicalName).filter(Boolean).join(' / ') || item.platform,
      catalogKeys: item.catalogKeys.filter(key => byKey.has(key)),
      inputs: item.sourceKeys.map(key => {
        const source = sourceByKey.get(key)
        // Never spread a source row: it contains connection credentials.
        return { key, registered: Boolean(source), status: source?.status || 'not_registered' }
      }),
      runtimeStatus: 'not_checked',
    }
  })
  return {
    contractVersion: 'mx-insight-hub.source-connections.v1',
    generatedAt: now.toISOString(), reviewedAt: '2026-09-22',
    scope: 'implemented_contracts_and_registered_cleaning_sources',
    routes,
    summary: {
      routes: routes.length,
      catalogEntries: new Set(routes.flatMap(item => item.catalogKeys).filter(key => !byKey.get(key)?.archivedAt)).size,
      keywordRoutes: routes.filter(item => item.keywordSearch).length,
      registeredInputs: new Set(routes.flatMap(item => item.inputs.filter(input => input.registered).map(input => input.key))).size,
    },
  }
}
