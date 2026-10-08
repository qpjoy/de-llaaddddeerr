import { WEB_SEARCH_PROVIDERS, WEB_SEARCH_PATH } from '../../shared/web-search.mjs'
import snapshot from './night-all-provider-inventory.json' with { type: 'json' }
import { NATIVE_FORWARDING_ENDPOINTS } from '../contracts/native-forwarding.mjs'
import { JUSTONE_MARKETPLACE_CATALOG } from '../ingest/justone.mjs'

const DIRECTORY = { douyin: '0001', kuaishou: '0002', xiaohongshu: '0004', weibo: '0005', bilibili: '0006', zhihu: '0007',
  wechat_mp: '0025', wechat_search: '0026', tiktok: '0085', twitter: '0086', instagram: '0087',
  facebook: '0088', youtube: '0089', reddit: '0090', linkedin: '0091', telegram: '0160' }

// Planning evidence is deliberately separate from implementedRoutes and from
// operator-authored coverage. Reading this list never contacts a supplier.
export function providerMigrationSnapshot() {
  const native = new Map(NATIVE_FORWARDING_ENDPOINTS.filter(row => !row.schemaVersion).map(row => [`${row.provider}:${row.id}`, row]))
  const rows = snapshot.endpoints.map(row => {
    const endpoint = native.get(`${row.provider}:${row.id}`)
    const rawCutover = ['t.weibo_web_v2_fetch_realtime_search', 't.instagram_v3_general_search'].includes(endpoint?.key)
    return { id: endpoint?.key || `deferred:${row.platform}:app-launch`, platform: row.platform,
      catalogKeys: DIRECTORY[row.platform] ? [`source-catalog-${DIRECTORY[row.platform]}`]
        : JUSTONE_MARKETPLACE_CATALOG[row.platform] ? [JUSTONE_MARKETPLACE_CATALOG[row.platform].sourceKey] : [],
      sourceLabel: row.provider === 'tikhub' ? 'T 平台' : 'JustOne',
      capabilities: row.capabilities, status: endpoint ? 'native_contract' : 'deferred',
      hubPath: endpoint?.hubPath || null, operation: endpoint?.operation || null,
      legacyStatus: rawCutover ? 'hub_raw_subset' : 'existing_routes_unchanged', runtimeStatus: 'not_checked',
      boundary: rawCutover ? '单关键词 raw 与 data/search 的 20–100 页大小请求由 Hub 直连，微博按需补全文，普通帖子不生成标题；旧游标和复杂形状仍走历史链路。操作、凭据和价格须就绪。'
        : endpoint ? '固定单接口；默认禁用，须逐接口授权、审核价格并启用。旧搜索投影与游标尚未切换。'
        : '启动应用的端点不属于数据读取，暂不接入。',
    }
  })
  for (const [id, platform, sourceLabel, capabilities, boundary] of [
    ['rapid-twitter', 'twitter', 'RapidAPI', ['search_posts', 'post_detail', 'post_comments', 'user_info', 'user_posts', 'earliest_user_posts'], '单关键词 raw 搜索复用 Hub 直连适配器与空标题规则；复杂查询和其他历史操作仍分阶段迁移。'],
    ['rapid-facebook', 'facebook', 'RapidAPI', ['search_posts'], 'Python 搜索与媒体归一化尚未迁移；新 raw 交付的内容空标题规则已在 Hub 执行。'],
    ['tgstat', 'telegram', 'TGStat', ['posts_search', 'channel_posts'], '独立 Telegram HTTP 服务；与 Hub 已存 Telegram 会话分开建模。'],
    ['web-search-skill', 'web', 'web-search-skill / SearXNG', ['web_search', 'web_fetch'], 'Python 技能、自建运行环境与搜索策略；单列迁移，不作为纯 HTTP 转发。'],
    ['defuddle', 'web', 'Defuddle / direct fetch', ['web_fetch'], '网页抓取、字符集与正文提取；需 Hub 出站目标校验及独立内容合同。'],
  ]) rows.push({ id, platform, sourceLabel, capabilities, status: 'deferred', hubPath: null, operation: null,
    catalogKeys: DIRECTORY[platform] ? [`source-catalog-${DIRECTORY[platform]}`] : [],
    legacyStatus: id === 'rapid-twitter' ? 'hub_raw_subset' : 'existing_routes_unchanged', runtimeStatus: 'not_checked', boundary })
  for (const p of WEB_SEARCH_PROVIDERS) rows.push({id:`web-search:${p.key}`,platform:'web_search',sourceLabel:p.label,capabilities:['web_search'],status:'native_contract',hubPath:WEB_SEARCH_PATH,operation:'web.search',catalogKeys:p.key==='baidu'?['source-catalog-0135']:[],legacyStatus:'existing_routes_unchanged',runtimeStatus:'not_checked',boundary:'Hub 直连搜索合同；默认禁用，凭据、价格与授权需显式配置。不会调用 Night-All 或自动提取全文。'})
  return { version: snapshot.version, sourceRevision: snapshot.sourceRevision,
    incompleteInventory: snapshot.dynamicCatalogs.some(row => !row.present),
    missingCatalogs: snapshot.dynamicCatalogs.filter(row => !row.present).map(row => row.path.replace('tikhub', 'T-platform')),
    rows, summary: { sourceEndpoints: snapshot.endpoints.length, nativeContracts: native.size,
      legacyCutovers: 0, partialLegacyCutovers: rows.filter(row => row.legacyStatus === 'hub_raw_subset').length,
      deferredGroups: rows.filter(row => row.status === 'deferred').length } }
}
