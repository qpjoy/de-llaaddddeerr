import { NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS } from '../contracts/night-all-legacy.mjs'
import { WECHAT_LEGACY_SEARCH_PLATFORMS } from '../contracts/wechat-search-alias.mjs'

const LABELS = {
  bilibili: '哔哩哔哩', douyin: '抖音', facebook: 'Facebook', instagram: 'Instagram',
  kuaishou: '快手', linkedin: 'LinkedIn', reddit: 'Reddit', telegram: 'Telegram',
  tiktok: 'TikTok', twitter: 'Twitter / X', weibo: '微博', xiaohongshu: '小红书',
  youtube: 'YouTube', zhihu: '知乎', wechat_search: '微信搜索', wechat_mp: '微信公众号',
}
const READ_ONLY_REASON = '当前接口尚未开放供应商策略配置；此处仅展示已有路由，不改变授权、价格或运行状态。'

function historicalPlatform(platform, operation) {
  const provider = platform === 'twitter' ? 'rapidapi' : platform === 'facebook' ? 'justone' : 'tikhub'
  return {
    platform, label: LABELS[platform], editable: false, migrationStatus: 'night_all',
    providers: [provider], readOnlyReason: READ_ONLY_REASON,
    routeSummary: `Hub 兼容入口转交 Night-All 的 /api/v1/search/${operation}，当前默认供应商为 ${provider === 'rapidapi' ? 'RapidAPI' : provider === 'justone' ? 'JustOne' : 'TikHub'}。供应商可用性由执行时检查。`,
  }
}

function searchPlatform(platform, { instagramPolicy, facebookPolicy }) {
  const row = historicalPlatform(platform, 'raw')
  if (platform === 'instagram') return {
    platform, label: LABELS[platform], editable: true, migrationStatus: 'hub_native',
    providers: ['justone', 'tikhub'], allowedModes: ['fixed', 'priority', 'paused'],
    policy: instagramPolicy == null ? null : structuredClone(instagramPolicy),
    routeSummary: '内容搜索的 data/search 与 raw 入口由 Hub 执行供应商策略。后续页绑定原供应商，历史游标不能跨供应商续页；未确认结果不会自动重试。',
  }
  if (platform === 'facebook') return {
    platform, label: LABELS[platform], editable: true, migrationStatus: 'hub_native',
    providers: ['rapidapi', 'justone'], allowedModes: ['auto', 'rapidapi', 'justone', 'paused'],
    policy: facebookPolicy == null ? null : structuredClone(facebookPolicy),
    routeSummary: '内容搜索的 data/search 与 raw 入口由 Hub 执行。auto 使用 RapidAPI 月度额度，额度不可用时按既有规则转 JustOne；游标绑定供应商，未知结果不触发切换。',
  }
  if (platform === 'twitter') return {
    ...row, migrationStatus: 'conditional',
    routeSummary: 'data/search 和 data/social/search 由 Hub 直连 RapidAPI。raw 的单关键词、每页不超过 50 条等已迁移形状由 Hub 执行；批量、复杂参数及历史兼容形状仍经 Night-All，默认同为 RapidAPI。',
  }
  if (platform === 'weibo') return {
    ...row, migrationStatus: 'conditional',
    routeSummary: '已迁移的单关键词 raw 和 data/search（首请求 pageSize 至少 20 或已有 Hub 游标）由 Hub 直连 TikHub；其他兼容形状仍经 Night-All。',
  }
  if (platform === 'xiaohongshu') return {
    ...row, migrationStatus: 'conditional',
    routeSummary: '单关键词、每页 20 条等受支持形状在 Hub 操作启用且为正式 Key 时直连 TikHub；已有 Hub 游标保持该链路。其他形状、未启用直连或测试 Key 仍走 Night-All。',
  }
  if (WECHAT_LEGACY_SEARCH_PLATFORMS.includes(platform)) return {
    ...row, migrationStatus: 'hub_native',
    routeSummary: `${platform === 'wechat_mp' ? '文章搜索' : '微信搜索'}的 data/search 与 /api/v1/search/raw 由 Hub 直连 TikHub，使用 /api/v1/data/wechat/search/search 的新合同；/api/v1/night-all/search/raw 已退役并返回 410，不回退 Night-All。`,
  }
  if (platform === 'telegram') return {
    ...row, providers: [], migrationStatus: 'local',
    routeSummary: 'Telegram 从 Hub 本地已采集数据检索。本机已核查的 po-infra 源码使用 data/canonical/search；也有 data/telegram/search 和 data/search 入口，不经过 Night-All 或社交供应商。',
  }
  return row
}

function accountPlatform(platform, operation) {
  const row = historicalPlatform(platform, operation)
  if (platform === 'twitter') return {
    ...row, migrationStatus: 'conditional',
    routeSummary: `data/social/${operation} 是 Hub 直连 RapidAPI 的 Twitter 专用合同；/search/${operation} 兼容入口仍经 Night-All，默认 RapidAPI。本机 po-infra 源码使用兼容入口，不能据此确认线上调用版本。两类入口不能视为同一响应合同。`,
  }
  if (platform === 'xiaohongshu') return {
    ...row, migrationStatus: 'conditional',
    routeSummary: operation === 'crawl'
      ? '单一账号、posts、每页 20 条及受支持游标等形状，在 Hub 操作启用且为正式 Key 时直连 TikHub；其他兼容形状仍经 Night-All。'
      : '单一账号和受支持标识等形状，在 Hub 操作启用且为正式 Key 时直连 TikHub；批量或其他兼容形状仍经 Night-All。',
  }
  return row
}

// This is an Admin product/routing inventory, not a readiness declaration.
// The compatibility sets deliberately exclude unsupported operation/platform
// pairs; provider credential state and paid dispatch remain in their gateways.
export function strategySearchCatalog({ instagramPolicy = null, facebookPolicy = null } = {}) {
  return {
    interfaces: [
      {
        id: 'search', label: '内容搜索',
        paths: ['/api/v1/data/search', '/api/v1/search/raw', '/api/v1/night-all/search/raw',
          '/api/v1/data/social/search', '/api/v1/data/canonical/search',
          '/api/v1/data/telegram/search', '/api/v1/data/wechat/search/search'],
        description: '按关键词检索平台内容。路径是本组入口合集，各平台适用范围见路由说明；兼容路径名称不代表一定由 Night-All 执行。本机已核查的 po-infra 源码使用兼容入口，线上已保存的 Instagram 故障请求使用 data/search；不能由本机源码推定生产已全量迁移或仍全走旧路径。',
        platforms: [...NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS.raw, ...WECHAT_LEGACY_SEARCH_PLATFORMS, 'telegram']
          .map(platform => searchPlatform(platform, { instagramPolicy, facebookPolicy })),
      },
      {
        id: 'crawl', label: '账号内容',
        paths: ['/api/v1/search/crawl', '/api/v1/night-all/search/crawl', '/api/v1/data/social/crawl'],
        description: '按已知账号获取内容，支持的平台与内容搜索不同。data/social/crawl 当前仅支持 Twitter；本机已核查的 po-infra 账号采集源码使用 Night-All 兼容入口。',
        platforms: NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS.crawl.map(platform => accountPlatform(platform, 'crawl')),
      },
      {
        id: 'user-info', label: '账号资料',
        paths: ['/api/v1/search/user-info', '/api/v1/night-all/search/user-info', '/api/v1/data/social/user-info'],
        description: '按已知账号获取资料，不是关键词搜账号。data/social/user-info 当前仅支持 Twitter；本机已核查的 po-infra 资料补充源码使用 Night-All 兼容入口。',
        platforms: NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS['user-info'].map(platform => accountPlatform(platform, 'user-info')),
      },
    ],
  }
}
