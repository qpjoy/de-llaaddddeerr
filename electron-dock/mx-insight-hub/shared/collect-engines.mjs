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
    description: '调用 mx-crawler-runner 的 /v1/invocations，每次一个审核过的 adapter 进程；异步，执行器重启后可续查。每个交付包一行引擎，插槽 ID 决定调用哪个包',
    baseUrl: 'required',
    // The runner refuses every call without its bearer token.
    credential: 'required',
    defaultBaseUrl: 'http://127.0.0.1:18190',
    defaultCredentialProvider: 'collect-runner',
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
  // Phase 3: synchronous kinds. A query runs inside the request when a slot
  // is free (POST /query → 200) and falls back to the queue otherwise (202).
  native: Object.freeze({
    label: 'Hub 原生查询',
    description: 'Hub 进程内直接执行的只读查询（DNS、RDAP、证书透明日志）；同步返回，没有外部付费供应商',
    baseUrl: 'none',
    credential: 'optional',
    sync: true,
    phase: 3,
  }),
  shodan: Object.freeze({
    label: 'Shodan API',
    description: '调用 api.shodan.io 的只读接口；同步返回，按账号限速每秒 1 次，出口走 System Proxy 的 shodan 绑定',
    baseUrl: 'none',
    credential: 'required',
    defaultCredentialProvider: 'shodan',
    egressProvider: 'shodan',
    sync: true,
    phase: 3,
  }),
})

// Reviewed packages the runner can execute (mx-crawler-runner/packages.json),
// by integration slot. A runner engine's slot decides which package it calls
// and whether its calls need an overseas System Proxy binding.
export const COLLECT_RUNNER_SLOTS = Object.freeze({
  'market-195': Object.freeze({ packageId: '195', label: '小米应用商店', egressProvider: null }),
  'market-197': Object.freeze({ packageId: '197', label: 'vivo 应用商店', egressProvider: null }),
  'market-198': Object.freeze({ packageId: '198', label: '应用宝', egressProvider: null }),
  'market-216': Object.freeze({ packageId: '216', label: '百度手机助手', egressProvider: null }),
  'market-217': Object.freeze({ packageId: '217', label: '联想应用商店', egressProvider: null }),
  'market-219': Object.freeze({ packageId: '219', label: '豌豆荚', egressProvider: null }),
  'market-193': Object.freeze({ packageId: '193', label: 'Google Play', egressProvider: 'googleplay' }),
  // Phase 5: single-URL enrichment, all overseas sites behind one binding.
  'pinterest-94': Object.freeze({ packageId: '94', label: 'Pinterest', egressProvider: 'overseas' }),
  'medium-96': Object.freeze({ packageId: '96', label: 'Medium', egressProvider: 'overseas' }),
  'snapchat-98': Object.freeze({ packageId: '98', label: 'Snapchat Spotlight', egressProvider: 'overseas' }),
  'dailymotion-101': Object.freeze({ packageId: '101', label: 'Dailymotion', egressProvider: 'overseas' }),
  'kick-104': Object.freeze({ packageId: '104', label: 'Kick', egressProvider: 'overseas' }),
  'substack-105': Object.freeze({ packageId: '105', label: 'Substack', egressProvider: 'overseas' }),
  'wordpress-107': Object.freeze({ packageId: '107', label: 'WordPress.com', egressProvider: 'overseas' }),
  // Phase 6: audio metadata and audio URLs (no downloads yet).
  'xiaoyuzhou-45': Object.freeze({ packageId: '45', label: '小宇宙', egressProvider: null }),
  'ximalaya-46': Object.freeze({ packageId: '46', label: '喜马拉雅', egressProvider: null }),
  'applepodcasts-220': Object.freeze({ packageId: '220', label: 'Apple Podcasts', egressProvider: 'overseas' }),
  'librivox-222': Object.freeze({ packageId: '222', label: 'LibriVox', egressProvider: 'overseas' }),
})

// `platform` routes of the audio capabilities.
export const COLLECT_AUDIO_PLATFORM_SLOTS = Object.freeze({
  xiaoyuzhou: 'xiaoyuzhou-45', ximalaya: 'ximalaya-46', apple: 'applepodcasts-220', librivox: 'librivox-222',
})

// `site` routes of collect.web.url.details, derived from the link's host.
export const COLLECT_URL_SITE_SLOTS = Object.freeze({
  pinterest: 'pinterest-94', medium: 'medium-96', snapchat: 'snapchat-98', dailymotion: 'dailymotion-101',
  kick: 'kick-104', substack: 'substack-105', wordpress: 'wordpress-107',
})

// `market` values of collect.app.details and the slot that serves each.
export const COLLECT_APP_MARKET_SLOTS = Object.freeze({
  xiaomi: 'market-195', vivo: 'market-197', tencent: 'market-198', baidu: 'market-216',
  lenovo: 'market-217', wandoujia: 'market-219', googleplay: 'market-193',
})

// System Proxy binding an engine's calls go out through, if any: fixed per
// kind (apify, shodan) or, for runner engines, per package slot.
export function collectEgressProvider(engine) {
  if (!engine) return null
  return COLLECT_KINDS[engine.kind]?.egressProvider
    || (engine.kind === 'runner' ? COLLECT_RUNNER_SLOTS[engine.slotRef]?.egressProvider || null : null)
}

// Public capabilities served by collection engines. Keys are code-owned so
// grants, docs and pricing stay reviewable; engines bind to them in the
// console. `stage` follows the integration-slot acceptance ladder.
export const COLLECT_CAPABILITIES = Object.freeze([
  Object.freeze({
    key: 'collect.app.details',
    label: '应用商店 · 应用详情',
    description: '按市场和商店内标识（应用 ID 或包名）采集应用详情；百度手机助手（pid）和豌豆荚可附带有限的历史版本。国内市场没有评论正文。',
    platform: 'app_market',
    kinds: Object.freeze(['runner']),
    routeBy: 'market',
    routes: Object.freeze(['xiaomi', 'vivo', 'tencent', 'baidu', 'lenovo', 'wandoujia', 'googleplay']
      .map(key => Object.freeze({ key, label: COLLECT_RUNNER_SLOTS[COLLECT_APP_MARKET_SLOTS[key]].label, slotRef: COLLECT_APP_MARKET_SLOTS[key] }))),
    stage: 'candidate',
  }),
  // Phase 4d: the other Google Play operations of package 193, on the same
  // runner slot as Google Play details. `categories` never passed acceptance.
  ...[
    ['search', '关键词搜索', '按关键词搜索应用（最多 50 条）。'],
    ['reviews', '应用评论', '按包名取评论正文、评分和回复，整页读取（每页至多 150 条，最多 5 页），可用续页标记接着取。'],
    ['charts', '榜单', '按榜单类型（免费、付费、畅销）和分类取当前榜单。'],
    ['developer', '开发者应用', '按开发者名称或 ID 取其应用列表。'],
    ['suggest', '搜索联想词', '按关键词取商店的搜索联想词。'],
    ['similar', '相似应用', '按包名取商店推荐的相似应用。'],
    ['permissions', '权限说明', '按包名取应用公开声明的权限。'],
    ['datasafety', '数据安全声明', '按包名取商店展示的数据安全声明（开发者自述，不是独立审计）。'],
  ].map(([operation, label, description]) => Object.freeze({
    key: `collect.app.googleplay.${operation}`,
    label: `Google Play · ${label}`,
    description: `${description}交付包 193，经 runner 和海外出口。`,
    platform: 'app_market',
    kinds: Object.freeze(['runner']),
    slotRef: 'market-193',
    stage: 'candidate',
  })),
  // Phase 6: audio. Shows (discover) and shows plus episodes with audio URLs
  // (discover then collect, one runner invocation, one fresh run_dir).
  // Downloading audio waits for mx-static.
  ...[
    ['shows', '音频 · 节目', '按平台找节目：小宇宙按节目或单集 ID，喜马拉雅按声音 ID，Apple Podcasts 按关键词或分类榜单，LibriVox 按书目分页。返回节目元数据和 RSS / 页面地址。'],
    ['episodes', '音频 · 节目与单集', '同「音频 · 节目」的输入，再取每个节目最近的单集（页面可见范围或 RSS），返回标题、时长、发布时间和音频地址；不下载音频。'],
  ].map(([name, label, description]) => Object.freeze({
    key: `collect.audio.${name}`,
    label,
    description: `${description}交付包 45、46、220、222。`,
    platform: 'audio',
    kinds: Object.freeze(['runner']),
    routeBy: 'platform',
    routes: Object.freeze(Object.entries(COLLECT_AUDIO_PLATFORM_SLOTS)
      .map(([key, slotRef]) => Object.freeze({ key, label: COLLECT_RUNNER_SLOTS[slotRef].label, slotRef }))),
    stage: 'candidate',
  })),
  // Phase 5: one product for "fill in the details of a link we already have".
  // Routed by the link's host; never search or discovery.
  Object.freeze({
    key: 'collect.web.url.details',
    label: '网页链接 · 详情补全',
    description: '给一条已有的公开链接，取元数据、正文或媒体地址：Pinterest Pin、Medium 文章、Snapchat Spotlight、Dailymotion 视频、Kick 剪辑和回放；Substack、WordPress.com 给站点地址，取最新 2 篇。按链接域名自动选择交付包，不做搜索，不下载媒体。',
    platform: 'web_content',
    kinds: Object.freeze(['runner']),
    routeBy: 'site',
    routes: Object.freeze(Object.entries(COLLECT_URL_SITE_SLOTS)
      .map(([key, slotRef]) => Object.freeze({ key, label: COLLECT_RUNNER_SLOTS[slotRef].label, slotRef }))),
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
  // Phase 2b: overseas ecommerce search through Apify. Keyword search first;
  // sellers, offers, reviews, detail pages and CAPTCHA solving stay closed.
  Object.freeze({
    key: 'collect.ecommerce.amazon.search',
    label: 'Amazon · 商品搜索与列表',
    description: '按关键词（指定站点）或 Amazon 搜索、分类、商品链接采集商品列表（交付包 108，Apify junglee/Amazon-crawler）。',
    platform: 'ecommerce',
    kinds: Object.freeze(['apify']),
    stage: 'candidate',
  }),
  Object.freeze({
    key: 'collect.ecommerce.ebay.search',
    label: 'eBay · 多站点商品搜索',
    description: '按关键词搜索 eBay 8 个站点的商品，可按成色、价格、出售方式筛选（交付包 109，Apify automation-lab/ebay-scraper）。',
    platform: 'ecommerce',
    kinds: Object.freeze(['apify']),
    stage: 'candidate',
  }),
  Object.freeze({
    key: 'collect.ecommerce.aliexpress.search',
    label: 'AliExpress · 商品关键词搜索',
    description: '按关键词搜索 AliExpress 商品，不含详情页和评论（交付包 110，Apify khadinakbar/aliexpress-all-in-one-scraper）。',
    platform: 'ecommerce',
    kinds: Object.freeze(['apify']),
    stage: 'candidate',
  }),
  Object.freeze({
    key: 'collect.ecommerce.etsy.search',
    label: 'Etsy · 商品关键词搜索',
    description: '按关键词搜索 Etsy 商品，可按国家、价格、促销、包邮、手工筛选（交付包 113，Apify yumitori/etsy-listings-scraper）。',
    platform: 'ecommerce',
    kinds: Object.freeze(['apify']),
    stage: 'candidate',
  }),
  Object.freeze({
    key: 'collect.ecommerce.shopee.search',
    label: 'Shopee · 关键词与店铺商品列表',
    description: '按关键词或店铺链接采集 Shopee 8 个国家站的商品列表（交付包 114，Apify gio21/shopee-scraper）。',
    platform: 'ecommerce',
    kinds: Object.freeze(['apify']),
    stage: 'candidate',
  }),
  // Phase 2c: long-tail ecommerce, classifieds, site intelligence, company
  // registry and travel reviews, all through Apify with reviewed inputs.
  Object.freeze({
    key: 'collect.ecommerce.shein.listing',
    label: 'Shein · 分类与精选页商品',
    description: '按 www.shein.com 的分类或精选列表链接采集商品（交付包 112，Apify shahidirfan/shein-product-scraper）。不支持关键词。',
    platform: 'ecommerce', kinds: Object.freeze(['apify']), stage: 'candidate',
  }),
  Object.freeze({
    key: 'collect.ecommerce.flipkart.search',
    label: 'Flipkart 印度站 · 商品搜索',
    description: '按关键词或 Flipkart 分类链接采集印度站商品（交付包 123，Apify shahidirfan/Flipkart-Product-Scraper）。',
    platform: 'ecommerce', kinds: Object.freeze(['apify']), stage: 'candidate',
  }),
  Object.freeze({
    key: 'collect.ecommerce.mercadolibre.search',
    label: 'Mercado Libre · 商品搜索',
    description: '按关键词搜索拉美 9 国 Mercado Libre 商品，不含详情、评论、问答与卖家资料（交付包 118，Apify sourabhbgp/mercadolibre-scraper）。',
    platform: 'ecommerce', kinds: Object.freeze(['apify']), stage: 'candidate',
  }),
  Object.freeze({
    key: 'collect.ecommerce.fbmarketplace.search',
    label: 'Facebook Marketplace · 城市商品列表',
    description: '按指定城市的 Marketplace 搜索或分类链接采集公开商品列表，不含详情（交付包 124，Apify apify/facebook-marketplace-scraper）。',
    platform: 'ecommerce', kinds: Object.freeze(['apify']), stage: 'candidate',
  }),
  Object.freeze({
    key: 'collect.classifieds.craigslist.search',
    label: 'Craigslist · 分类信息搜索',
    description: '按地区子站的搜索链接采集分类信息帖子，可按发布天数过滤（交付包 127，Apify ivanvs/craigslist-scraper-pay-per-result）。',
    platform: 'classifieds', kinds: Object.freeze(['apify']), stage: 'candidate',
  }),
  Object.freeze({
    key: 'collect.ecommerce.shopify.catalog',
    label: 'Shopify 独立站 · 公开商品目录',
    description: '按店铺域名采集 Shopify 独立站的公开商品目录，不含库存明细（交付包 129，Apify trovevault/shopify-products-scraper）。',
    platform: 'ecommerce', kinds: Object.freeze(['apify']), stage: 'candidate',
  }),
  Object.freeze({
    key: 'collect.web.builtwith.technologies',
    label: 'BuiltWith · 网站技术栈',
    description: '按域名识别网站使用的技术（交付包 184，Apify builtwith/builtwith-official-technology-scraper）。',
    platform: 'web_intelligence', kinds: Object.freeze(['apify']), stage: 'candidate',
  }),
  Object.freeze({
    key: 'collect.company.uk.search',
    label: 'UK Companies House · 企业登记信息',
    description: '按名称关键词或公司注册号查询英国企业基础登记信息，不含高管、实际控制人、申报和抵押记录（交付包 191，Apify scrapesage/companies-house-scraper）。',
    platform: 'company_registry', kinds: Object.freeze(['apify']), stage: 'candidate',
  }),
  Object.freeze({
    key: 'collect.travel.tripcom.hotel-reviews',
    label: 'Trip.com · 酒店公开评论',
    description: '按 Trip.com 酒店详情链接采集公开评论（交付包 80，Apify knagymate/trip-com-reviews-scraper）。不含携程国内站、机票和门票。',
    platform: 'travel', kinds: Object.freeze(['apify']), stage: 'candidate',
  }),
  // Phase 3: subject tracking (network intelligence), synchronous.
  Object.freeze({
    key: 'collect.intel.dns.lookup',
    label: 'DNS · 记录查询',
    description: '经公共解析器查询域名的 A、AAAA、CNAME、MX、NS、TXT、SOA、CAA 记录（替代交付包 181）。不使用 Hub 宿主机的解析器。',
    platform: 'network_intel', kinds: Object.freeze(['native']), stage: 'candidate', sync: true,
  }),
  Object.freeze({
    key: 'collect.intel.rdap.domain',
    label: 'RDAP · 域名注册信息',
    description: '按 IANA RDAP 引导表查询域名的注册信息（替代交付包 180 的 43 端口 WHOIS）。',
    platform: 'network_intel', kinds: Object.freeze(['native']), stage: 'candidate', sync: true,
  }),
  // Phase 5: package 182's subfinder only had crt.sh enabled, i.e. a
  // certificate-transparency lookup; Hub does it natively (no Go binary).
  Object.freeze({
    key: 'collect.intel.subdomains',
    label: '子域名发现 · 证书透明日志',
    description: '汇总证书透明日志里出现过的子域名（Cert Spotter 与 crt.sh，被动查询，不探测目标主机），代替交付包 182 的 subfinder。',
    platform: 'network_intel', kinds: Object.freeze(['native']), stage: 'candidate', sync: true,
  }),
  Object.freeze({
    key: 'collect.intel.ct.issuances',
    label: '证书透明日志 · 证书签发',
    description: '经 SSLMate Cert Spotter API 查询域名（可含子域名）的证书签发记录（交付包 182 的按需查询部分）。',
    platform: 'network_intel', kinds: Object.freeze(['native']), stage: 'candidate', sync: true,
  }),
  Object.freeze({
    key: 'collect.intel.shodan.host',
    label: 'Shodan · IP 主机信息',
    description: '查询公网 IP 的开放端口、服务横幅与归属（交付包 188；不消耗查询额度）。',
    platform: 'network_intel', kinds: Object.freeze(['shodan']), stage: 'candidate', sync: true,
  }),
  Object.freeze({
    key: 'collect.intel.shodan.search',
    label: 'Shodan · 主机搜索（首页）',
    description: '按 Shodan 查询语法搜索主机，只取第一页；带过滤条件时消耗 1 个查询额度（交付包 188）。',
    platform: 'network_intel', kinds: Object.freeze(['shodan']), stage: 'candidate', sync: true,
  }),
  Object.freeze({
    key: 'collect.intel.shodan.count',
    label: 'Shodan · 结果计数与分布',
    description: '只返回匹配主机数量和可选的分布统计，不返回主机（交付包 188；不消耗查询额度）。',
    platform: 'network_intel', kinds: Object.freeze(['shodan']), stage: 'candidate', sync: true,
  }),
  Object.freeze({
    key: 'collect.intel.shodan.domain',
    label: 'Shodan · 域名子域与记录',
    description: '查询 Shodan 收录的域名子域名和 DNS 记录（交付包 188；消耗 1 个查询额度）。',
    platform: 'network_intel', kinds: Object.freeze(['shodan']), stage: 'candidate', sync: true,
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
