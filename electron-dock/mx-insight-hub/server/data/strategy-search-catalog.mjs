import { NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS } from '../contracts/night-all-legacy.mjs'
import { WECHAT_LEGACY_SEARCH_PLATFORMS } from '../contracts/wechat-search-alias.mjs'
import { HUB_SOCIAL_COMPAT_CRAWL_PLATFORMS, HUB_SOCIAL_COMPAT_PROFILE_PLATFORMS } from '../../shared/social-account-contract.mjs'

const LABELS = {
  bilibili: '哔哩哔哩', douyin: '抖音', facebook: 'Facebook', instagram: 'Instagram',
  kuaishou: '快手', linkedin: 'LinkedIn', reddit: 'Reddit', telegram: 'Telegram',
  tiktok: 'TikTok', twitter: 'Twitter / X', weibo: '微博', xiaohongshu: '小红书',
  youtube: 'YouTube', zhihu: '知乎', wechat_search: '微信搜索', wechat_mp: '微信公众号',
}
const READ_ONLY_REASON = '此业务接口的兼容请求仍由 Night-All 选路；Hub 尚未接管该组合的供应商切换。供应商目录中的其他接口不能直接替换现有请求、响应或分页合同。'

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
    routeSummary: '内容搜索的 data/search 与 raw 入口由 Hub 执行。auto 使用 RapidAPI 月度额度，额度不可用时按既有规则转 JustOne；标准搜索先消费已采购余量，再有界补齐当前页，raw 保持既有分页。游标绑定供应商，未知结果不触发切换。',
  }
  if (['bilibili', 'douyin', 'kuaishou', 'zhihu'].includes(platform)) return {
    ...row, migrationStatus: 'hub_native',
    readOnlyReason: '关键词内容搜索由 Hub 执行已适配的固定 TikHub 合同，当前没有接入同一合同的第二供应商；不能仅改目录名称切换。账号内容与账号资料独立保留兼容链路。',
    routeSummary: 'data/search 与两个 raw 入口的关键词内容搜索、已声明筛选和关键词批量由 Hub 直连 TikHub；完整已采购页归档后按 Hub 游标交付，不再转交 Night-All。历史游标须遵循原回放及明确重启边界；crawl 和 user-info 的迁移状态分别显示。',
  }
  if (['reddit', 'youtube'].includes(platform)) return {
    ...row, migrationStatus: 'conditional',
    readOnlyReason: '标准内容搜索由 Hub 执行固定 TikHub 合同，当前没有已接入的第二供应商策略；两个 raw 兼容入口仍走原链路。操作状态、凭据和采购准入独立检查，目录不代表线上已经部署或实时可用。',
    routeSummary: 'POST /api/v1/data/search 的新内容搜索由 Hub 直连 TikHub，保留原标准请求与 items/pageInfo 合同，不转发或失败回退到 Night-All。POST /api/v1/search/raw 与 /api/v1/night-all/search/raw 继续原 Night-All 链路。已保存交付精确重放；旧 mxnc1 游标的新派发返回 409 search_restart_required，由调用方明确使用新 Idempotency-Key 从首页开始。新分页只回传本接口的 Hub 游标；账号内容和资料状态分别显示。',
  }
  if (platform === 'twitter') return {
    ...row, migrationStatus: 'conditional',
    readOnlyReason: 'Twitter 当前固定使用 RapidAPI，尚无接入此业务合同的第二供应商。统一入口已直连，复杂 raw 仍可能经过 Night-All；两种执行路径不等于两个可切换供应商。',
    routeSummary: 'data/search 和 data/social/search 由 Hub 直连 RapidAPI。raw 的单关键词、每页不超过 50 条等已迁移形状由 Hub 执行；批量、复杂参数及历史兼容形状仍经 Night-All，默认同为 RapidAPI。',
  }
  if (platform === 'weibo') return {
    ...row, migrationStatus: 'conditional',
    readOnlyReason: '已迁移形状使用 TikHub；其余形状仍走兼容链路。尚无第二个已接入同一合同的供应商，不能仅通过修改默认名称切换。',
    routeSummary: '已迁移的单关键词 raw 和 data/search（首请求 pageSize 至少 20 或已有 Hub 游标）由 Hub 直连 TikHub；其他兼容形状仍经 Night-All。',
  }
  if (platform === 'xiaohongshu') return {
    ...row, migrationStatus: 'conditional',
    readOnlyReason: '当前已接入的搜索形状使用 TikHub；其他形状仍遵循兼容路由。其他平台原生接口需完成参数、响应、分页及费用适配后才能作为本合同的可选供应商。',
    routeSummary: '单关键词、每页 20 条等受支持形状在 Hub 操作启用且为正式 Key 时直连 TikHub；已有 Hub 游标保持该链路。其他形状、未启用直连或测试 Key 仍走 Night-All。',
  }
  if (WECHAT_LEGACY_SEARCH_PLATFORMS.includes(platform)) return {
    ...row, migrationStatus: 'hub_native',
    readOnlyReason: '微信搜索当前固定使用已接入专项合同的 TikHub，没有第二供应商保底。已退役的 Night-All 微信搜索不会作为失败回退。',
    routeSummary: `${platform === 'wechat_mp' ? '文章搜索' : '微信搜索'}的 data/search 与 /api/v1/search/raw 由 Hub 直连 TikHub，使用 /api/v1/data/wechat/search/search 的新合同；/api/v1/night-all/search/raw 已退役并返回 410，不回退 Night-All。`,
  }
  if (platform === 'telegram') return {
    ...row, providers: [], migrationStatus: 'local',
    readOnlyReason: 'Telegram 在此检索 Hub 已收录数据，没有付费上游供应商选路。数据采集配置与此搜索接口分别管理。',
    routeSummary: 'Telegram 从 Hub 本地已采集数据检索。本机已核查的 po-infra 源码使用 data/canonical/search；也有 data/telegram/search 和 data/search 入口，不经过 Night-All 或社交供应商。',
  }
  return row
}

function accountPlatform(platform, operation) {
  const row = historicalPlatform(platform, operation)
  const legacy = NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS[operation].includes(platform)
  return {
    ...row, migrationStatus: 'hub_native',
    readOnlyReason: 'Hub 账号接口按已审核的平台及活动合同执行固定路由，当前未提供可互换的供应商策略。关键词搜索的供应商配置不会改变账号内容或资料路由；操作状态、凭据和准入仍独立检查。',
    routeSummary: `POST /api/v1/data/social/${operation} 由 Hub 执行账号解析、字段适配及托管分页，不转交 Night-All。保留已声明的账号参数别名及 raw_info/raw_data 字符串，并提供 items、page/pageInfo；使用新接口返回的游标。${legacy
      ? platform === 'xiaohongshu' ? '旧 /search 与 /night-all/search 入口继续保持原先按请求形状直连或转发的规则。'
        : '旧 /search 与 /night-all/search 入口仍经 Night-All，供下游逐步切换。'
      : '旧兼容入口未声明此平台与业务组合，不能据此认为旧入口也新增支持。'}目录表示已实现合同，不代表当前线上已部署或供应商已验证可用。`,
  }
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
        description: '按已知账号获取内容。data/social/crawl 由 Hub 执行，要求平台及 social.content.crawl 授权；单页上限 500，仍受 Key 上限约束。旧兼容入口保持原路由和原平台范围，迁移从第一页开始。',
        platforms: HUB_SOCIAL_COMPAT_CRAWL_PLATFORMS.map(platform => accountPlatform(platform, 'crawl')),
      },
      {
        id: 'user-info', label: '账号资料',
        paths: ['/api/v1/search/user-info', '/api/v1/night-all/search/user-info', '/api/v1/data/social/user-info'],
        description: '按已知账号获取资料，不是关键词搜账号。data/social/user-info 由 Hub 执行，要求平台及 social.profile.get 授权；旧兼容入口保持原路由和原平台范围。接口可见不会自动增加调用权限。',
        platforms: HUB_SOCIAL_COMPAT_PROFILE_PLATFORMS.map(platform => accountPlatform(platform, 'user-info')),
      },
    ],
  }
}
