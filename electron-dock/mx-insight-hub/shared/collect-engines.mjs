// Business definitions for the generic collection engines, shared by the
// console, public docs and server. Upstream addresses, credentials and
// execution topology never belong here.
// Design: docs/architecture/spider_man/07-collect-engines.md

export const COLLECT = Object.freeze({
  key: 'self-hosted-engines',
  path: '/self-hosted-engines',
  label: '自建引擎',
  description: '引擎、执行槽、队列与任务',
  apiPrefix: '/api/v1/data/collect',
  contractVersion: 'mx-insight-hub.collect.v1',
})

export const COLLECT_STATUSES = Object.freeze(['queued', 'running', 'succeeded', 'failed', 'unknown', 'cancelled', 'expired'])
export const COLLECT_TERMINAL = Object.freeze(['succeeded', 'failed', 'unknown', 'cancelled', 'expired'])
export const COLLECT_DATA_STATUSES = Object.freeze(['success', 'no_data', 'partial', 'unknown'])
export const COLLECT_BATCH_MAX = 100

// What an operator may set per engine. New engines start from the defaults.
export const COLLECT_ENGINE_BOUNDS = Object.freeze({
  capacity: Object.freeze({ min: 1, max: 64, default: 1 }),
  queueLimit: Object.freeze({ min: 1, max: 20_000, default: 500 }),
  consumerOpenLimit: Object.freeze({ min: 1, max: 5_000, default: 100 }),
  queueWaitMinutes: Object.freeze({ min: 1, max: 24 * 60, default: 120 }),
  runTimeoutSeconds: Object.freeze({ min: 5, max: 6 * 60 * 60, default: 600 }),
})

// Execution kinds the Hub knows how to drive. Each one is a contract module
// in server/collect/contracts. `phase` is the integration plan stage (06).
export const COLLECT_KINDS = Object.freeze({
  runner: Object.freeze({
    label: '独立 runner',
    description: '调用 mx-crawler-runner 的 /v1/invocations，每次一个审核过的 adapter 进程；异步，执行器重启后可续查',
    baseUrl: 'required',
    credential: 'optional',
    phase: 4,
  }),
  apify: Object.freeze({
    label: 'Apify Actor',
    description: '在 Apify 云上运行固定版本的 Actor；异步，运行 ID 落库后执行器重启可续查。地址固定为 api.apify.com，出口走 System Proxy 的 apify 绑定',
    baseUrl: 'none',
    credential: 'required',
    defaultCredentialProvider: 'apify',
    egressProvider: 'apify',
    phase: 2,
  }),
})

// Public capabilities served by collection engines. Keys are code-owned so
// grants, docs and pricing stay reviewable; engines bind to them in the
// console. `stage` follows the integration-slot acceptance ladder.
export const COLLECT_CAPABILITIES = Object.freeze([
  Object.freeze({
    key: 'collect.app.details',
    label: '应用商店 · 应用详情',
    description: '按商店内应用 ID 采集应用详情（不含评论正文和历史版本）。首个市场为小米应用商店（交付包 195）。',
    platform: 'app_market',
    kinds: Object.freeze(['runner']),
    routeBy: 'market',
    routes: Object.freeze([Object.freeze({ key: 'xiaomi', label: '小米应用商店', slotRef: 'market-195' })]),
    stage: 'candidate',
  }),
  // Integration plan phase 2a pilots (Apify). Actor and build are pinned in
  // server/collect/catalog.mjs; every input field is reviewed, never passed through.
  Object.freeze({
    key: 'collect.ecommerce.temu.search',
    label: 'Temu 美国站 · 商品关键词搜索',
    description: '按关键词搜索 Temu 美国站商品（交付包 111，Apify crw/temu-products-scraper）。',
    platform: 'ecommerce',
    kinds: Object.freeze(['apify']),
    stage: 'candidate',
  }),
  Object.freeze({
    key: 'collect.ads.meta.library',
    label: 'Meta 广告库 · 公开广告检索',
    description: '按 Facebook 主页或广告库链接检索公开广告（交付包 202，Apify apify/facebook-ads-scraper）。',
    platform: 'ad_library',
    kinds: Object.freeze(['apify']),
    stage: 'candidate',
  }),
  Object.freeze({
    key: 'collect.web.similarweb.overview',
    label: 'Similarweb · 网站流量概览',
    description: '按域名获取 Similarweb 网站流量和受众概览（交付包 185，Apify tri_angle/similarweb-scraper）。',
    platform: 'web_intelligence',
    kinds: Object.freeze(['apify']),
    stage: 'candidate',
  }),
])

export const COLLECT_CAPABILITY_KEYS = Object.freeze(COLLECT_CAPABILITIES.map(row => row.key))

export function collectCapability(key) {
  return COLLECT_CAPABILITIES.find(row => row.key === key) || null
}
