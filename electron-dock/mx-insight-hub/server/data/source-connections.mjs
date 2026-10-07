import { WEB_SEARCH_PROVIDERS, WEB_SEARCH_PATH } from '../../shared/web-search.mjs'
import { NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS } from '../contracts/night-all-legacy.mjs'
import { HUB_SOCIAL_ENDPOINTS } from '../contracts/hub-social.mjs'
import { providerMigrationSnapshot } from './provider-migration.mjs'
import { NATIVE_FORWARDING_ENDPOINTS } from '../contracts/native-forwarding.mjs'
import { WECHAT_LEGACY_SEARCH_PLATFORMS, WECHAT_SEARCH_PATH, WECHAT_SEARCH_KEY } from '../contracts/wechat-search-alias.mjs'
import { officialProviderCatalog, providerCatalogKeys } from './provider-catalog.mjs'
import { XHS_DISCOVERY_ENDPOINTS } from '../contracts/xiaohongshu-discovery.mjs'
import { SOCIAL_ACCOUNT_PLATFORMS, socialAccountPlatform } from '../contracts/social-accounts.mjs'
import { JUSTONE_RESOURCE_CATALOG } from '../contracts/justone-resources.mjs'
import { JUSTONE_MARKETPLACE_CATALOG } from '../ingest/justone.mjs'
import { PUBLIC_OPINION_DATASET_ID } from './public-opinion.mjs'
import { XIAOHONGSHU_CAPABILITIES } from '../../shared/product-catalog.mjs'
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
const PROVIDER_LABELS = { rapidapi: 'RapidAPI', tikhub: 'T 平台', justone: 'JustOne', 'night-all': 'Night-All', 'night-all-a': 'Night-All-A', qixin: '启信慧眼（启信宝）', ipsearch: 'ipsearch' }

function route(id, fields) {
  return {
    id, catalogKeys: [], datasets: [], sourceKeys: [], mode: 'live',
    defaultRule: '固定合同路由；执行时仍校验授权、凭据、策略和价格。',
    keywordSearch: false, ...fields,
  }
}

export function implementedRoutes(sources = []) {
  const rows = WEB_SEARCH_PROVIDERS.map(p=>route(`web-search-${p.key}`,{provider:p.key,providerLabel:p.label,product:'Web Search',operation:'web.search',platform:'web_search',path:WEB_SEARCH_PATH,catalogKeys:p.key==='baidu'?['source-catalog-0135']:[],keywordSearch:true,defaultRule:'按租户与 Key 的渠道范围和顺序选择；发送后不切换，不转发 Night-All。',evidence:'server/web-search/contract.mjs'}))
  for (const endpoint of Object.values(HUB_SOCIAL_ENDPOINTS)) rows.push(route(`hub-social-${endpoint.key}`, {
    platform: endpoint.platform, catalogKeys: [catalogKey(endpoint.platform)], provider: endpoint.provider,
    product: '社媒与内容数据', operation: endpoint.operation, path: endpoint.path, keywordSearch: endpoint.key === 'search',
    defaultRule: 'Hub 自主接口；首批 Twitter 单页/基础资料，无 Night-All 回退。独立授权和采购策略，默认禁用；尚未完全覆盖旧合同。',
    evidence: 'server/contracts/hub-social.mjs',
  }))
  for (const endpoint of NATIVE_FORWARDING_ENDPOINTS) rows.push(route(`native-${endpoint.key}`, {
    platform: endpoint.platform, catalogKeys: providerCatalogKeys(endpoint.platform),
    provider: endpoint.provider, product: endpoint.key.startsWith('wechat.') ? (endpoint.platform === 'wechat_mp' ? '微信公众号' : endpoint.platformLabel) : endpoint.authorizationPlatform === 'ecommerce' ? '电商数据' : '社媒与内容数据', operation: endpoint.operation, path: endpoint.hubPath,
    keywordSearch: ['wechat.search.search', 'wechat.search.search-videos', 'wechat.channels.search-channel-videos'].includes(endpoint.key),
    defaultRule: endpoint.key.startsWith('wechat.') ? 'Hub 微信直连合同；逐接口审核价格、授权与启用；旧微信搜索不再转发，旧游标不可复用，无自动补查或重试。' : '固定单接口转发；默认禁用，逐接口审核价格、授权与启用。旧搜索接口和游标不切换，无自动补查或重试。',
    evidence: 'server/contracts/native-forwarding.mjs',
  }))
  for (const endpoint of Object.values(XHS_DISCOVERY_ENDPOINTS)) rows.push(route(endpoint.key, {
    platform: 'xiaohongshu', catalogKeys: [catalogKey('xiaohongshu')], provider: endpoint.provider,
    product: endpoint.label, operation: endpoint.operation, path: endpoint.path, keywordSearch: endpoint.id === 'hot_notes',
    defaultRule: '独立单页操作；固定数据来源，原生业务字段投影与完整受限归档；不自动查询、不推断笔记身份。',
    evidence: 'server/contracts/xiaohongshu-discovery.mjs',
  }))
  for (const platform of WECHAT_LEGACY_SEARCH_PLATFORMS) rows.push(route(`wechat-search-alias-${platform}`, {
    platform, catalogKeys: [catalogKey(platform)], provider: 'tikhub', product: platform === 'wechat_mp' ? '微信公众号' : '微信搜一搜',
    operation: `native.${WECHAT_SEARCH_KEY}`, path: '/api/v1/search/raw', keywordSearch: true,
    defaultRule: `转入 ${WECHAT_SEARCH_PATH} 并返回新合同；公众号默认文章分类。与直接调用共用授权、价格和幂等；旧 Night-All 微信搜索已停用。`,
    evidence: 'server/contracts/wechat-search-alias.mjs',
  }))
  for (const platform of WECHAT_LEGACY_SEARCH_PLATFORMS) {
    for (const [kind, path] of [['search', '/api/v1/data/search'], ['aggregate', '/api/v1/data/aggregate/search']]) rows.push(route(`wechat-${kind}-${platform}`, {
      platform, catalogKeys: [catalogKey(platform)], provider: 'tikhub', product: '数据搜索',
      operation: `native.${WECHAT_SEARCH_KEY}`, path, keywordSearch: true,
      defaultRule: kind === 'aggregate' ? '微信实时子请求调用 Hub 新搜索，精简 items 映射为聚合结果；独立新权限、定价及单页游标，不回退 Night-All，不自动入库。'
        : `转入 ${WECHAT_SEARCH_PATH}，返回原生新合同；与短路径共用权限、价格和幂等，不回退 Night-All。`,
      evidence: 'server/data/aggregate-search.mjs',
    }))
  }
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
    defaultRule: '非已迁移直连形状委托内部数据服务，微信实时搜索除外（已停用）；此看板不请求上游能力目录，支持范围与健康不作静态推断。',
    evidence: 'server/adapters/night-all.mjs',
  }))
  for (const { key: operation, path, label } of XIAOHONGSHU_CAPABILITIES.filter(row => row.key !== 'social.posts.search')) rows.push(route(`xiaohongshu-${operation}`, {
    platform: 'xiaohongshu', catalogKeys: [catalogKey('xiaohongshu')], provider: 'tikhub',
    product: '小红书笔记画卷', operation, path, label,
    defaultRule: ['social.posts.analytics', 'social.comments.list'].includes(operation)
      ? '固定版本详情或单页评论合同；独立授权、定价与运行开关，不自动补查或重试。'
      : '已迁移且符合直连形状的请求走 T 平台；兼容入口的其他形状与历史游标保留原分支。',
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
  }), route('ip-risk-subscription', { platform:'ip_risk', provider:null, product:'IP 风险画像 · 空间订阅', operation:'ip.risk.subscription.query', path:'/api/v1/data/ip/risk/service', defaultRule:'空间共享订阅；按产品服务版本交付，不自动切换上游。', evidence:'server/contracts/ip-risk-product-docs.mjs' }), route('ip-risk-baidu-v2', {
    platform: 'ip_risk', provider: 'baidu-ip', product: 'IP 风险画像 · 百度 v2 订阅',
    operation: 'ip.risk.query.v2', path: '/api/v1/data/ip/risk/v2',
    defaultRule: '有效订阅按 IP × 渠道逐项扣量；网页参考渠道，共享限流，无自动回退。',
    evidence: 'server/contracts/ip-risk-v2-docs.mjs',
  }))
  rows.push(route('virtual-supermarket', {
    platform: 'virtual_supermarket', provider: null, product: '虚拟超市',
    operation: 'storefront.search', path: '/api/v1/data/virtual-supermarket/search',
    mode: 'stored', keywordSearch: true,
    defaultRule: '仅搜索已上架商品；从手机电商捕获发布，独立权限与店面版本，不触发采集。',
    evidence: 'server/data/virtual-supermarket.mjs',
  }), route('news-discovery', {
    platform: '分类存量授权范围', provider: null, product: '新闻发现',
    operation: 'news.search', path: '/api/v1/data/news/search',
    mode: 'stored', keywordSearch: true,
    defaultRule: '按目录 UUID、结构化来源、类别和时间读取已入库新闻；目录不授予数据权限，待归类来源保留。',
    evidence: 'server/data/news-discovery.mjs',
  }), route('topic-reports', {
    platform: '分类存量授权范围', provider: null, product: '专题洞察',
    operation: 'topic-reports.read', path: '/api/v1/data/topic-reports',
    mode: 'stored', keywordSearch: true,
    defaultRule: '检索调用方自己的既有报告；创建报告是独立操作，读列表不调用 Agent 或上游。',
    evidence: 'server/insights/topic-reports.mjs',
  }))
  return rows
}

export function sourceConnectionSnapshot(entries, sources, { now = new Date(), operations = [] } = {}) {
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
      operationControls: operations.filter(operation => operation.provider === provider && (operation.operation === item.operation || provider === 'qixin' && item.operation === 'enterprise.query'))
        .map(operation => ({ operation: operation.operation, revision: operation.current.revision, desiredState: operation.current.desiredState,
          effectiveState: operation.current.effectiveState, reviewedPrice: operation.current.priceBook.source === 'database' && operation.current.priceBook.status === 'reviewed' && operation.current.priceBook.ready,
          blockers: operation.current.blockers.map(blocker => blocker.code) })),
      runtimeStatus: 'not_checked',
    }
  })
  return {
    contractVersion: 'mx-insight-hub.source-connections.v1',
    generatedAt: now.toISOString(), reviewedAt: '2026-09-26',
    scope: 'implemented_contracts_and_registered_cleaning_sources',
    migration: providerMigrationSnapshot(),
    officialCatalog: officialProviderCatalog(operations),
    routes,
    summary: {
      routes: routes.length,
      catalogEntries: new Set(routes.flatMap(item => item.catalogKeys).filter(key => !byKey.get(key)?.archivedAt)).size,
      keywordRoutes: routes.filter(item => item.keywordSearch).length,
      registeredInputs: new Set(routes.flatMap(item => item.inputs.filter(input => input.registered).map(input => input.key))).size,
    },
  }
}
