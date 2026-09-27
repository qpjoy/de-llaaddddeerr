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
    return { id: endpoint?.key || `deferred:${row.platform}:app-launch`, platform: row.platform,
      catalogKeys: DIRECTORY[row.platform] ? [`source-catalog-${DIRECTORY[row.platform]}`]
        : JUSTONE_MARKETPLACE_CATALOG[row.platform] ? [JUSTONE_MARKETPLACE_CATALOG[row.platform].sourceKey] : [],
      sourceLabel: row.provider === 'tikhub' ? 'T 平台' : 'JustOne',
      capabilities: row.capabilities, status: endpoint ? 'native_contract' : 'deferred',
      hubPath: endpoint?.hubPath || null, operation: endpoint?.operation || null,
      legacyStatus: 'existing_routes_unchanged', runtimeStatus: 'not_checked',
      boundary: endpoint ? '固定单接口；默认禁用，须逐接口授权、审核价格并启用。旧搜索投影与游标尚未切换。'
        : '启动应用的端点不属于数据读取，暂不接入。',
    }
  })
  for (const [id, platform, sourceLabel, capabilities, boundary] of [
    ['rapid-twitter', 'twitter', 'RapidAPI', ['search_posts', 'post_detail', 'post_comments', 'user_info', 'user_posts', 'earliest_user_posts'], 'Python 解析、账号时间线及分页；需独立凭据、计费合同与回放测试。'],
    ['rapid-facebook', 'facebook', 'RapidAPI', ['search_posts'], 'Python 搜索与媒体归一化；需保留正文、无标题规则及游标。'],
    ['tgstat', 'telegram', 'TGStat', ['posts_search', 'channel_posts'], '独立 Telegram HTTP 服务；与 Hub 已存 Telegram 会话分开建模。'],
    ...['Exa', 'Tavily', 'Serper', 'You.com', 'SearchAPI.io', 'Firecrawl', 'SerpApi'].map(label => [label.toLowerCase(), 'web', label, ['web_search'], 'HTTP 客户端已在参考源码中；尚未迁入 Hub 的凭据、价格与返回合同。']),
    ['web-search-skill', 'web', 'web-search-skill / SearXNG', ['web_search', 'web_fetch'], 'Python 技能、自建运行环境与搜索策略；单列迁移，不作为纯 HTTP 转发。'],
    ['defuddle', 'web', 'Defuddle / direct fetch', ['web_fetch'], '网页抓取、字符集与正文提取；需 Hub 出站目标校验及独立内容合同。'],
  ]) rows.push({ id, platform, sourceLabel, capabilities, status: 'deferred', hubPath: null, operation: null,
    catalogKeys: DIRECTORY[platform] ? [`source-catalog-${DIRECTORY[platform]}`] : [],
    legacyStatus: 'existing_routes_unchanged', runtimeStatus: 'not_checked', boundary })
  return { version: snapshot.version, sourceRevision: snapshot.sourceRevision,
    incompleteInventory: snapshot.dynamicCatalogs.some(row => !row.present),
    missingCatalogs: snapshot.dynamicCatalogs.filter(row => !row.present).map(row => row.path.replace('tikhub', 'T-platform')),
    rows, summary: { sourceEndpoints: snapshot.endpoints.length, nativeContracts: native.size,
      legacyCutovers: 0, deferredGroups: rows.filter(row => row.status === 'deferred').length } }
}
