// Business definition shared by the console, public docs and server. Upstream
// addresses, credentials and execution topology never belong here.
// Design: docs/architecture/spider_man/03-self-hosted-engines.md
export const WECHAT_SELF_HOSTED = Object.freeze({
  key: 'wechat-self-hosted',
  path: '/data-products/wechat-self-hosted',
  docs: 'wechat-self-hosted',
  label: '微信自建引擎',
  navLabel: '自建引擎',
  description: '公众号文章检索 · 排队执行',
  platform: 'social',
  capability: 'wechat.selfhosted.search',
  meterKey: 'wechat.selfhosted.search',
  apiPrefix: '/api/v1/data/wechat/self-hosted',
  // Hub official list price (CNY minor units). Plans publish their own entry.
  officialUnitPriceMinor: 10,
})

// Built-in protection values (spider_man D12). Not deployment settings.
export const WECHAT_SELF_HOSTED_LIMITS = Object.freeze({
  batchItems: 10,
  consumerOpen: 10,
  globalQueued: 30,
  queueWaitMs: 2 * 60 * 60 * 1000,
  queryLength: 100,
  limitDefault: 5,
  limitMax: 20,
  pageMax: 10,
  cacheHoursDefault: 24,
  cacheHoursMax: 24,
})

export const WECHAT_SELF_HOSTED_TERMINAL = Object.freeze(['succeeded', 'failed', 'unknown', 'cancelled', 'expired'])
