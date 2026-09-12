import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowClockwise,
  ArrowRight,
  ArrowSquareOut,
  CaretLeft,
  CaretRight,
  ChartLineUp,
  CheckCircle,
  Coins,
  Cube,
  Database,
  Fingerprint,
  Key,
  LockKey,
  MagicWand,
  MagnifyingGlass,
  Package,
  ShieldCheck,
  ShoppingBagOpen,
  Sparkle,
  WarningCircle,
} from '@phosphor-icons/react'
import { publicApiOrigin, publicDataApi, publicDocsHref } from './api.js'
import { DropdownField, Field, PageHeading } from './components.jsx'
import { productMediaLoader } from './product-media-loader.js'

const SEARCHING_ASSET = 'assets/ecommerce-treasure-box/data-cat-searching.webp'
const PRESENTING_ASSET = 'assets/ecommerce-treasure-box/data-cat-presenting.webp'

const MARKETPLACES = [
  { value: 'taobao', label: '淘宝', catalogKey: 'source-catalog-0058', filters: '排序 · 价格' },
  { value: 'tmall', label: '天猫', catalogKey: 'source-catalog-0059', filters: '排序 · 价格' },
  { value: 'jd', label: '京东', catalogKey: 'source-catalog-0060', filters: '平台默认' },
  { value: 'xiaohongshu_ec', label: '小红书店铺', catalogKey: 'source-catalog-0064', filters: '平台默认' },
  { value: 'xianyu', label: '闲鱼', catalogKey: 'source-catalog-0073', filters: '排序' },
]

const MODE_OPTIONS = [
  { value: 'safe_demo', label: '安全演示 · 0 Hub / 0 上游', description: '浏览器本地策略沙盘；只使用清晰标注的页面示例。' },
  { value: 'hub_live', label: 'Hub 开放 API · 真实调用', description: '同一把开放能力 API Key，无需另签产品 Key；由交付策略决定只读存量或允许新采集。' },
]

const DELIVERY_MODE_OPTIONS = [
  { value: 'cache_only', label: '只读 Hub 存量 · 0 上游调用', description: '只返回精确缓存或存档；没有存量时明确提示。' },
  { value: 'cache_first', label: '智能交付 · 缓存优先', description: '优先新鲜缓存，未命中时可能发起一次外部采集。' },
  { value: 'refresh', label: '重新采集 · 可能产生上游成本', description: '绕过新鲜缓存，明确尝试从外部平台获取最新数据。' },
]
const DELIVERY_MODES = new Set(DELIVERY_MODE_OPTIONS.map(({ value }) => value))

const DEMO_DELIVERY_MODE_OPTIONS = [
  { value: 'cache_only', label: '模拟 cache_only · 只读存量', description: '只在浏览器沙盘中演练精确存量命中或无存量停止。' },
  { value: 'cache_first', label: '模拟 cache_first · 缓存优先', description: '模拟无新鲜存量后使用页面 fixture 返回结果；不会访问 Hub 或上游。' },
  { value: 'refresh', label: '模拟 refresh · 重新采集', description: '模拟绕过缓存并使用页面 fixture 返回结果；不会访问 Hub 或上游。' },
]

const DEMO_CACHE_ONLY_SCENE_OPTIONS = [
  { value: 'no_inventory', label: '无精确存量 · 演练 404', description: '模拟 stored_snapshot_not_found，并在上游调用前停止。' },
  { value: 'stored_hit', label: '存在演示存档 · 演练命中', description: '使用浏览器内页面 fixture 模拟精确存档命中。' },
]
const DEMO_CACHE_ONLY_SCENES = new Set(DEMO_CACHE_ONLY_SCENE_OPTIONS.map(({ value }) => value))

const LEGACY_LIVE_REQUEST_STORAGE_KEY = 'mx-insight-hub.ecommerce-treasure-box.live-request.v1'
const LIVE_REQUEST_STORAGE_KEY = 'mx-insight-hub.ecommerce-treasure-box.live-request.v2'
const LIVE_REQUEST_AUDIT_STORAGE_KEY = 'mx-insight-hub.ecommerce-treasure-box.live-request-audit.v1'
const MAX_LIVE_REQUEST_AUDIT_RECORDS = 8
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const DISPLAY_PAGE_SIZE_OPTIONS = [
  { value: '3', label: '3 件 / 页' },
  { value: '6', label: '6 件 / 页' },
  { value: '9', label: '9 件 / 页' },
]
const AMBIGUOUS_LIVE_ERROR_CODES = new Set([
  'external_platform_outcome_unknown',
  'request_outcome_unknown',
  'request_in_progress',
  'upstream_outcome_unknown',
])
const COMMITTED_LIVE_ERROR_CODES = new Set([
  'external_platform_response_unusable',
  'external_platform_rejected',
])

const SORTS = {
  taobao: [
    { value: 'sales_desc', label: '销量优先' },
    { value: 'relevance', label: '相关度' },
    { value: 'price_asc', label: '价格从低到高' },
    { value: 'price_desc', label: '价格从高到低' },
  ],
  tmall: [
    { value: 'sales_desc', label: '销量优先' },
    { value: 'relevance', label: '相关度' },
    { value: 'price_asc', label: '价格从低到高' },
    { value: 'price_desc', label: '价格从高到低' },
  ],
  xianyu: [
    { value: 'relevance', label: '活跃优先' },
    { value: 'recent', label: '最近更新' },
    { value: 'seller_credit', label: '卖家信用' },
    { value: 'price_asc', label: '价格从低到高' },
    { value: 'price_desc', label: '价格从高到低' },
    { value: 'price_drop', label: '降价优先' },
    { value: 'newest', label: '最新发布' },
  ],
}

// The browser-only sample has enough evidence for these orderings. Do not
// advertise credit, recency or price-drop sorting when the sample cannot prove
// those fields.
const SAFE_DEMO_SORTS = {
  taobao: SORTS.taobao,
  tmall: SORTS.tmall,
  xianyu: SORTS.xianyu.filter(({ value }) => ['relevance', 'price_asc', 'price_desc'].includes(value)),
}

const SOURCE_MODE_LABELS = {
  stored_inventory: { label: '已存历史记录', tone: 'teal', hubUsage: '只读 usage', providerCall: '0', note: '本调用身份的已提交商品记录' },
  live: { label: '实时上游', tone: 'live', providerCall: '是', hubUsage: '是', note: '当前记录 Hub usage 与内部采购成本证据；客户计价待 Hub price book' },
  fresh_cache: { label: '新鲜缓存', tone: 'cache', providerCall: '否', hubUsage: '是', note: '同一规范请求复用新鲜快照' },
  stored_fallback: { label: '存储兜底', tone: 'fallback', providerCall: '可能', hubUsage: '是', note: '可能在派发前兜底，也可能在上游失败后兜底' },
  idempotent_replay: { label: '幂等重放', tone: 'replay', providerCall: '否', hubUsage: '否', note: '相同 Idempotency-Key + 相同请求返回原结果' },
  safe_demo: { label: '安全演示', tone: 'demo', providerCall: '否', hubUsage: '否', note: '浏览器内演示数据，不访问 Hub Data API' },
}

const DEMO_PRODUCTS = [
  { id: 'demo-taobao-camera', marketplace: 'taobao', title: '便携影像记录套装', keywords: ['便携相机', '相机'], pricing: { current: '899.00', currency: 'CNY' }, shop: { name: '示例数码店' }, signals: { sales: '2.4k', reviewCount: '318', location: '杭州' }, attributes: { brand: 'Demo Lens', category: '数码影像' } },
  { id: 'demo-taobao-camera-mini', marketplace: 'taobao', title: '便携相机迷你套装', keywords: ['便携相机', '相机'], pricing: { current: '629.00', currency: 'CNY' }, shop: { name: '示例影像馆' }, signals: { sales: '3.1k', reviewCount: '486', location: '深圳' }, attributes: { brand: 'Demo Snap', category: '数码影像' } },
  { id: 'demo-taobao-camera-vlog', marketplace: 'taobao', title: '便携相机 Vlog 组合', keywords: ['便携相机', '相机'], pricing: { current: '1099.00', currency: 'CNY' }, shop: { name: '示例创作装备店' }, signals: { sales: '1.9k', reviewCount: '275', location: '广州' }, attributes: { brand: 'Demo Vivid', category: '影像创作' } },
  { id: 'demo-taobao-camera-pocket', marketplace: 'taobao', title: '口袋便携相机', keywords: ['便携相机', '相机'], pricing: { current: '759.00', currency: 'CNY' }, shop: { name: '示例随拍店' }, signals: { sales: '4.2k', reviewCount: '631', location: '苏州' }, attributes: { brand: 'Demo Pocket', category: '数码影像' } },
  { id: 'demo-taobao-camera-retro', marketplace: 'taobao', title: '复古便携相机礼盒', keywords: ['便携相机', '相机'], pricing: { current: '529.00', currency: 'CNY' }, shop: { name: '示例复古相机铺' }, signals: { sales: '1.4k', reviewCount: '192', location: '厦门' }, attributes: { brand: 'Demo Retro', category: '数码影像' } },
  { id: 'demo-taobao-camera-outdoor', marketplace: 'taobao', title: '户外防抖便携相机', keywords: ['便携相机', '相机'], pricing: { current: '1399.00', currency: 'CNY' }, shop: { name: '示例户外数码店' }, signals: { sales: '860', reviewCount: '144', location: '成都' }, attributes: { brand: 'Demo Trail', category: '户外影像' } },
  { id: 'demo-tmall-coffee', marketplace: 'tmall', title: '低温萃取咖啡组合', keywords: ['咖啡', '冷萃'], pricing: { current: '79.90', currency: 'CNY' }, shop: { name: '示例食品旗舰店' }, signals: { sales: '8.1k', reviewCount: '1.2k', location: '上海' }, attributes: { brand: 'Demo Roast', category: '食品饮料' } },
  { id: 'demo-jd-headphones', marketplace: 'jd', title: '降噪头戴式耳机', keywords: ['耳机', '降噪'], pricing: { current: '459.00', currency: 'CNY' }, shop: { name: '示例自营店' }, signals: { sales: '5.6k', reviewCount: '860', location: '北京' }, attributes: { brand: 'Demo Audio', category: '影音设备' } },
  { id: 'demo-xhs-skincare', marketplace: 'xiaohongshu_ec', title: '轻盈保湿护理套装', keywords: ['护肤', '保湿'], pricing: { current: '219.00', currency: 'CNY' }, shop: { name: '示例品牌店' }, signals: { sales: '980', reviewCount: '206', location: '广州' }, attributes: { brand: 'Demo Care', category: '个护美妆' } },
  { id: 'demo-xianyu-keyboard', marketplace: 'xianyu', title: '九成新机械键盘', keywords: ['键盘', '二手数码'], pricing: { current: '268.00', currency: 'CNY' }, shop: { name: '示例闲置卖家' }, signals: { sales: null, reviewCount: '42', location: '成都' }, attributes: { brand: 'Demo Keys', category: '二手数码' } },
  { id: 'demo-taobao-light', marketplace: 'taobao', title: '桌面氛围灯', keywords: ['台灯', '氛围灯'], pricing: { current: '129.00', currency: 'CNY' }, shop: { name: '示例家居店' }, signals: { sales: '1.8k', reviewCount: '289', location: '深圳' }, attributes: { brand: 'Demo Glow', category: '家居生活' } },
]

const CAPABILITY_GROUPS = [
  {
    id: 'connected',
    title: 'Hub 已接入并核验',
    description: '同一 Hub operation 下的 5 个 marketplace；可实时、缓存、兜底与幂等重放。',
    tone: 'connected',
    items: ['淘宝商品搜索 V1', '天猫商品搜索 V1', '京东商品搜索 V1', '小红书电商商品搜索 V1', '闲鱼商品搜索 V1'],
  },
  {
    id: 'ecommerce',
    title: '官方电商能力 · 待 Hub 契约',
    description: '官方目录存在不等于 Hub 已开放；每一项仍需 fixture、归一化、归档和计费语义评审。',
    tone: 'planned',
    items: ['淘宝 / 天猫 V2 搜索', '商品详情', '评论与问答', '店铺商品', '京东价格与详情', '抖音电商 / SKU', '得物', '1688', 'AliExpress', 'Temu', 'Shopee', 'TikTok Shop', 'Amazon'],
  },
  {
    id: 'content',
    title: '官方内容与平台族 · 待产品化',
    description: '后续按独立 Hub 数据产品吸纳，不混入商品搜索合同。',
    tone: 'catalog',
    items: ['小红书 / 蒲公英', '抖音 / 星图', '快手', '微信公众号 / 视频号', '微博', 'B站', 'YouTube', 'Reddit', 'X / LinkedIn', 'Instagram / Facebook', '知乎 / 头条', '豆瓣 / IMDb', '贝壳', 'LLM 聚合'],
  },
]

function marketplaceLabel(value) {
  return MARKETPLACES.find((item) => item.value === value)?.label || value || '平台未知'
}

function priceLabel(pricing = {}) {
  const amount = pricing.current || pricing.original
  if (!amount) return '价格待核验'
  return String(pricing.currency || '').toUpperCase() === 'CNY' ? `¥ ${amount}` : `${pricing.currency || ''} ${amount}`.trim()
}

function sourceModeEvidence(mode) {
  return SOURCE_MODE_LABELS[mode] || {
    label: mode || '尚未调用', tone: 'unknown', providerCall: '—', hubUsage: '—', note: '完成一次请求后显示真实交付路径',
  }
}

function ecommerceErrorPresentation(error) {
  const code = error?.code || ''
  if (!code) {
    return {
      title: error?.message || '商品数据暂时没有交付',
      description: '请调整输入后再试；页面不会因为这条提示自动发起外部采集。',
      operatorAction: false,
    }
  }
  if (code === 'external_platform_response_unusable') {
    if (error?.status === 409) {
      return {
        title: 'JustOne 响应格式隔离仍在生效',
        description: '这次 409 在访问 JustOne 前已被 Hub 拦截，没有新增 JustOne 调用或上游采购计费；最初触发 succeeded_unusable 隔离的调用仍可能已经计费。请查看上游运行状态并处理响应归档，不要连续重试。',
        operatorAction: true,
      }
    }
    return {
      title: '外部数据已返回，但暂时无法整理成 Hub 商品',
      description: 'Hub 没有展示不符合稳定合同的数据。该调用可能已产生内部采购成本；请保留原请求标识，不要换 Idempotency-Key 或连续重试，并交由管理员核查响应归档。',
      operatorAction: true,
    }
  }
  if (code === 'stored_snapshot_not_found') {
    return {
      title: 'Hub 里还没有这组条件的存量商品（不是路由 404）',
      description: 'Public API 已正常处理请求；本次只读检查没有命中精确存量，也没有调用 JustOne 或产生新的上游成本。可以换条件、查看安全演示，或明确切换到“重新采集”。',
      operatorAction: false,
    }
  }
  if (code === 'request_outcome_unknown' && error?.status === 409) {
    return {
      title: '同类实时请求仍在未决隔离期',
      description: '本次尝试在上游派发前停止，没有新增外部采集；早先的请求结果仍可能未知。页面不会循环重试；选择“重新采集”并再次点击后，会先自动只读核对，只有 Hub 明确返回 unknown 与旧 Request ID 时才申请一次受控新尝试。',
      operatorAction: true,
    }
  }
  if (['external_platform_outcome_unknown', 'request_outcome_unknown', 'upstream_outcome_unknown'].includes(code)) {
    return {
      title: '这次实时请求的结果暂时无法确认',
      description: '请求可能已经发往外部平台。原请求条件与 Idempotency-Key 已写入本地账本；选择“重新采集”并点击后，页面会先自动做零上游查询。reserved 或核对失败会停止；只有 Hub 明确返回 unknown 与旧 Request ID 时才申请一次受控新尝试。',
      operatorAction: true,
    }
  }
  if (code === 'request_in_progress') {
    return {
      title: '同一实时请求仍在处理中',
      description: '本次尝试没有新增外部采集。请等待页面按本地幂等账本做只读查询；不要 POST 原请求或并发创建新的请求标识。零费用演示不受影响。',
      operatorAction: true,
    }
  }
  if (code === 'resolved_replay_not_verified') {
    return {
      title: '当前 API Key 无法核验原请求归属',
      description: '页面只执行了只读状态查询；未能证明本地账本对应当前调用身份下已提交的 ecommerce 请求，因此没有发送重放 POST，也没有访问 JustOne。本地账本会继续保留。',
      operatorAction: false,
    }
  }
  if (code === 'external_platform_not_configured') {
    return {
      title: '实时数据源尚未配置完成',
      description: '当前也没有可交付的精确缓存或存档。请管理员前往“数据清洗中心 → 外部数据平台”检查凭据和发布门禁；这不是客户端 API Key 失效。',
      operatorAction: true,
    }
  }
  if (['external_platform_unavailable', 'external_platform_circuit_open'].includes(code)) {
    return {
      title: '实时商品数据暂不可用',
      description: 'Hub 当前没有可交付的精确存档。请稍后重试同一请求，不要连续刷新；也可以先使用零费用演示查看产品交互。',
      operatorAction: true,
    }
  }
  if (['external_platform_capacity_exceeded', 'external_platform_capacity_unavailable'].includes(code)) {
    return {
      title: '外部数据容量暂不可用',
      description: '请稍后重试，或请管理员检查外部平台额度与可用性；无需更换 Hub API Key。',
      operatorAction: true,
    }
  }
  if (code === 'external_platform_busy') {
    return {
      title: '实时请求较多，请稍后再试',
      description: 'Hub 已在派发前保护上游，本次没有新增外部采集。请退避后按原条件重试。',
      operatorAction: true,
    }
  }
  // Each quota layer needs a different response, so each gets its own message:
  // a window recovers on its own, a monthly ceiling does not, and a burst limit
  // means slow down rather than wait.
  if (code === 'consumer_quota_exceeded') {
    return {
      title: '当前调用身份的 Hub 请求额度已用完',
      description: '等待计量窗口恢复，或由管理员在「套餐与配额」调整该调用身份在此数据域的额度。',
      operatorAction: false,
    }
  }
  if (code === 'api_key_quota_exceeded') {
    return {
      title: '这把 API Key 自己的额度已用完',
      description: 'Key 的上限比调用身份更严，且在签发时冻结。改用同一调用身份下额度更宽的 Key，或请管理员审核后签发替代 Key。',
      operatorAction: false,
    }
  }
  if (code === 'plan_window_quota_exceeded') {
    return {
      title: '套餐的滑动窗口额度已用完',
      description: '等待窗口恢复即可；这是套餐层的限额，不是这把 Key 的问题。',
      operatorAction: false,
    }
  }
  if (code === 'plan_month_quota_exceeded') {
    return {
      title: '套餐的月度额度已用完',
      description: '等待窗口没有用——要到下一个计费周期才会重置，或请管理员升级套餐。',
      operatorAction: true,
    }
  }
  if (code === 'plan_burst_exceeded') {
    return {
      title: '瞬时请求速率过高',
      description: '额度本身没有用完，降低发起速率后立即可以继续。',
      operatorAction: false,
    }
  }
  if (code === 'external_platform_rejected') {
    return {
      title: '外部数据服务拒绝了本次查询',
      description: '请检查平台、关键词、排序和价格条件后再提交。若条件有效，请保留页面展示的错误证据并联系管理员，不要连续自动重试。',
      operatorAction: true,
    }
  }
  if (code === 'invalid_api_key') {
    return {
      title: '开放能力 API Key 无效或已失效',
      description: error?.message || '请使用当前 Hub 实例签发的完整 Live Key；不要填写列表掩码、Admin Token 或外部平台密钥。',
      operatorAction: false,
    }
  }
  if (code === 'platform_not_granted') {
    return {
      title: '此调用身份尚未开通电商数据',
      description: error?.message || '请先为 consumer 授予 ecommerce，再签发明确包含该范围的新 API Key；新增授权不会扩大旧 snapshot Key。',
      operatorAction: false,
    }
  }
  if (code === 'test_key_not_supported') {
    return {
      title: 'Test Key 不能用于实时电商采集',
      description: 'Test 前缀不是隔离沙箱。请改用已授权 ecommerce 的 mih_live_ Key；零费用演示无需 Key。',
      operatorAction: false,
    }
  }
  return {
    title: '商品数据暂时没有交付',
    description: '请保留页面展示的错误码与请求证据，稍后再试；若持续出现，请交由管理员核查。页面不会自动发起新的外部采集。',
    operatorAction: true,
  }
}

function requestBody({ marketplace, query, sort, deliveryMode = 'cache_first', cursor = null, page, price }) {
  return {
    marketplace,
    query: query.normalize('NFKC').trim(),
    deliveryMode,
    ...(cursor ? { cursor } : page != null ? { page: Number(page) } : {}),
    ...(sort ? { sort } : {}),
    ...(price ? { price } : {}),
  }
}

function sameLogicalRequestBody(left, right) {
  if (!left || !right) return false
  return ['marketplace', 'query', 'cursor', 'sort', 'page'].every((field) => (
    (left[field] || null) === (right[field] || null)
  )) && JSON.stringify(left.price || null) === JSON.stringify(right.price || null)
}

function orbPosition(index, total) {
  if (total <= 1) {
    return { x: '-49px', y: '-152px', mobileX: '-39px', mobileY: '-126px', delay: '0ms' }
  }
  const angle = (-120 + (index * 360) / total) * (Math.PI / 180)
  return {
    x: `${Math.round(-49 + Math.cos(angle) * 198)}px`,
    y: `${Math.round(-12 + Math.sin(angle) * 148)}px`,
    mobileX: `${Math.round(-39 + Math.cos(angle) * 132)}px`,
    mobileY: `${Math.round(-4 + Math.sin(angle) * 122)}px`,
    delay: `${index * 55}ms`,
  }
}

function availableSorts(mode, marketplace) {
  const options = (mode === 'safe_demo' ? SAFE_DEMO_SORTS : SORTS)[marketplace]
  return options || [{ value: '', label: mode === 'safe_demo' ? '演示数据不支持排序' : '平台默认排序' }]
}

function demoSearchText(item) {
  return [
    item.title,
    item.shop?.name,
    item.attributes?.brand,
    item.attributes?.category,
    item.signals?.location,
    ...(item.keywords || []),
  ].filter(Boolean).join('\n').normalize('NFKC').toLocaleLowerCase('zh-CN')
}

function demoMetric(value) {
  const text = String(value || '').trim().toLocaleLowerCase('en-US')
  const number = Number.parseFloat(text.replace(/[^\d.]/gu, ''))
  if (!Number.isFinite(number)) return 0
  if (text.endsWith('k')) return number * 1_000
  if (text.endsWith('w') || text.endsWith('万')) return number * 10_000
  return number
}

function demoProducts({ marketplace, query, sort }) {
  const normalizedQuery = query.normalize('NFKC').trim().toLocaleLowerCase('zh-CN')
  const terms = normalizedQuery.split(/\s+/u).filter(Boolean)
  const scoped = DEMO_PRODUCTS.filter((item) => (
    item.marketplace === marketplace
      && terms.every((term) => demoSearchText(item).includes(term))
  ))
  if (sort === 'price_asc' || sort === 'price_desc') {
    const direction = sort === 'price_asc' ? 1 : -1
    scoped.sort((left, right) => direction * (demoMetric(left.pricing?.current) - demoMetric(right.pricing?.current)))
  } else if (sort === 'sales_desc') {
    scoped.sort((left, right) => demoMetric(right.signals?.sales) - demoMetric(left.signals?.sales))
  }
  return scoped
}

function safeDemoScenario({ demoDeliveryMode, demoCacheOnlyScene, candidates }) {
  const commonEvidence = {
    sourceMode: 'safe_demo',
    demoDeliveryMode,
    demoScenario: demoDeliveryMode === 'cache_only'
      ? demoCacheOnlyScene
      : demoDeliveryMode === 'cache_first' ? 'fresh_miss' : 'cache_bypass',
    simulatedSourceMode: null,
    simulatedErrorCode: null,
    ageSeconds: null,
  }
  const page = (items) => ({
    page: 1,
    returnedCount: items.length,
    hasMore: false,
    nextCursor: null,
  })

  if (demoDeliveryMode === 'cache_only' && demoCacheOnlyScene === 'no_inventory') {
    return {
      products: [],
      page: page([]),
      evidence: {
        ...commonEvidence,
        simulatedErrorCode: 'stored_snapshot_not_found',
        demoTitle: '沙盘：无精确存量，已安全停止',
        demoDescription: '模拟 404 stored_snapshot_not_found；页面没有查询当前 Hub，也没有访问 JustOne。',
        demoTrace: [
          '模拟检查精确存量（不查询当前 Hub）',
          '模拟结果：没有匹配快照',
          '按 cache_only 停止 · 实际 0 Hub / 0 上游',
        ],
      },
    }
  }

  if (demoDeliveryMode === 'cache_only') {
    return {
      products: candidates,
      page: page(candidates),
      evidence: {
        ...commonEvidence,
        simulatedSourceMode: 'stored_fallback',
        demoTitle: '沙盘：模拟精确存档命中',
        demoDescription: `${candidates.length} 件页面示例；这是浏览器演示存档，不是当前 Hub 存量。`,
        demoTrace: [
          '载入浏览器内演示存档（不查询当前 Hub）',
          '模拟精确存档命中，按 cache_only 返回',
          '实际 0 Hub / 0 上游',
        ],
      },
    }
  }

  if (demoDeliveryMode === 'refresh') {
    return {
      products: candidates,
      page: page(candidates),
      evidence: {
        ...commonEvidence,
        simulatedSourceMode: 'live',
        demoTitle: '沙盘：模拟重新采集成功',
        demoDescription: `${candidates.length} 件页面示例；沙盘模拟绕过缓存，但没有发出真实请求。`,
        demoTrace: [
          '模拟 refresh 绕过新鲜缓存',
          '使用页面 fixture 模拟一次已授权上游响应',
          '实际 0 Hub / 0 上游',
        ],
      },
    }
  }

  return {
    products: candidates,
    page: page(candidates),
    evidence: {
      ...commonEvidence,
      simulatedSourceMode: 'live',
      demoTitle: '沙盘：模拟缓存未命中后交付',
      demoDescription: `${candidates.length} 件页面示例；沙盘用 fixture 代替可能的上游响应。`,
      demoTrace: [
        '模拟 cache_first 检查新鲜存量（不查询当前 Hub）',
        '模拟结果：没有新鲜快照，可进入上游分支',
        '使用页面 fixture 返回 · 实际 0 Hub / 0 上游',
      ],
    },
  }
}

function safeDemoIdleMessage(demoDeliveryMode, demoCacheOnlyScene) {
  if (demoDeliveryMode === 'cache_only' && demoCacheOnlyScene === 'no_inventory') {
    return '将演练无精确存量时的 cache_only 404；不访问 Hub 或上游。'
  }
  if (demoDeliveryMode === 'cache_only') {
    return '将用浏览器演示存档模拟 cache_only 命中；不访问当前 Hub。'
  }
  if (demoDeliveryMode === 'refresh') {
    return '将用页面 fixture 模拟 refresh；不会访问 Hub 或上游。'
  }
  return '将用页面 fixture 模拟 cache_first 的缓存未命中分支；不会访问 Hub 或上游。'
}

async function apiKeyFingerprint(apiKey) {
  if (!globalThis.crypto?.subtle) throw new Error('当前浏览器不支持安全的 API Key fingerprint，已阻止实时请求。')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(apiKey))
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

function storedRequestBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.page != null && (!Number.isInteger(value.page) || value.page < 1 || value.page > 1000 || value.cursor)) return null
  if (value.price != null && (typeof value.price !== 'object' || Array.isArray(value.price) || Object.keys(value.price).some(key => !['min', 'max'].includes(key) || typeof value.price[key] !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value.price[key])))) return null
  const allowed = new Set(['marketplace', 'query', 'deliveryMode', 'cursor', 'sort', 'page', 'price'])
  if (Object.keys(value).some((key) => !allowed.has(key))) return null
  if (!MARKETPLACES.some(({ value: marketplace }) => marketplace === value.marketplace)) return null
  if (typeof value.query !== 'string' || !value.query.trim() || value.query.length > 200) return null
  if (value.cursor != null && (typeof value.cursor !== 'string' || value.cursor.length > 4_096)) return null
  if (value.sort != null && (typeof value.sort !== 'string' || value.sort.length > 40)) return null
  if (value.deliveryMode != null && !DELIVERY_MODES.has(value.deliveryMode)) return null
  return requestBody({
    marketplace: value.marketplace,
    query: value.query,
    sort: value.sort || '',
    // Browser records written before deliveryMode existed preserve the old
    // cache-first behavior. This is an in-place, non-destructive migration.
    deliveryMode: value.deliveryMode || 'cache_first',
    cursor: value.cursor || null,
    page: value.page,
    price: value.price,
  })
}

export function normalizedStoredLiveRequest(parsed) {
  const body = storedRequestBody(parsed?.body)
  const keyFingerprint = parsed?.keyFingerprint || parsed?.consumerFingerprint
  const requestId = typeof parsed?.requestId === 'string' && REQUEST_ID_PATTERN.test(parsed.requestId.trim())
    ? parsed.requestId.trim()
    : null
  const committedErrorCode = parsed?.outcome === 'resolved' && COMMITTED_LIVE_ERROR_CODES.has(parsed?.committedErrorCode)
    ? parsed.committedErrorCode
    : null
  if (
    !body
    || !/^treasure-[0-9a-f-]{36}$/u.test(parsed?.idempotencyKey || '')
    || !/^[0-9a-f]{64}$/u.test(keyFingerprint || '')
    || !['pending', 'ambiguous', 'resolved'].includes(parsed?.outcome)
  ) return null
  return {
    body,
    idempotencyKey: parsed.idempotencyKey,
    keyFingerprint,
    ...(requestId ? { requestId } : {}),
    ...(committedErrorCode ? { committedErrorCode } : {}),
    ...(parsed?.migratedFromV1 === true ? { migratedFromV1: true } : {}),
    // A tab refresh while fetch was pending makes the outcome ambiguous.
    outcome: parsed.outcome === 'pending' ? 'ambiguous' : parsed.outcome,
  }
}

export function liveRequestRecoveryDecision({
  status = '',
  httpStatus = 0,
  errorCode = '',
} = {}) {
  if (status === 'committed') return 'replay'
  if (status === 'released') return 'unlock'
  if (status === 'reserved') return 'hold_reserved'
  if (status === 'unknown') return 'hold_unknown'
  if (httpStatus === 404 && errorCode === 'request_not_found') return 'clear_orphan'
  if (httpStatus === 404 && errorCode === 'not_found') return 'deployment_mismatch'
  return 'hold'
}

export function liveRequestStorageDecision(parsed, { legacy = false } = {}) {
  const record = normalizedStoredLiveRequest(parsed)
  if (!record) return { action: 'remove', record: null }
  if (legacy) return { action: 'migrate', record: { ...record, migratedFromV1: true } }
  return { action: 'keep', record }
}

function removeStoredLiveRequest(key) {
  try {
    window.sessionStorage.removeItem(key)
  } catch {
    // In-memory state remains fail-closed when browser storage is unavailable.
  }
}

function loadLiveRequest() {
  if (typeof window === 'undefined') return null
  for (const storageKey of [LIVE_REQUEST_STORAGE_KEY, LEGACY_LIVE_REQUEST_STORAGE_KEY]) {
    let serialized
    try {
      serialized = window.sessionStorage.getItem(storageKey)
    } catch {
      return null
    }
    if (!serialized) continue
    let parsed
    try {
      parsed = JSON.parse(serialized)
    } catch {
      removeStoredLiveRequest(storageKey)
      continue
    }
    const decision = liveRequestStorageDecision(parsed, {
      legacy: storageKey === LEGACY_LIVE_REQUEST_STORAGE_KEY,
    })
    if (decision.action === 'remove') {
      removeStoredLiveRequest(storageKey)
      continue
    }
    if (decision.action === 'migrate') {
      try {
        persistLiveRequest(decision.record)
      } catch {
        // Keep the valid v1 record when v2 migration cannot be persisted.
      }
    }
    return decision.record
  }
  return null
}

function persistLiveRequest(record) {
  if (typeof window === 'undefined') throw new Error('实时请求只能从浏览器发起。')
  window.sessionStorage.setItem(LIVE_REQUEST_STORAGE_KEY, JSON.stringify({
    version: 2,
    body: record.body,
    idempotencyKey: record.idempotencyKey,
    keyFingerprint: record.keyFingerprint,
    ...(REQUEST_ID_PATTERN.test(record.requestId || '') ? { requestId: record.requestId } : {}),
    ...(record.outcome === 'resolved' && COMMITTED_LIVE_ERROR_CODES.has(record.committedErrorCode)
      ? { committedErrorCode: record.committedErrorCode }
      : {}),
    ...(record.migratedFromV1 === true ? { migratedFromV1: true } : {}),
    outcome: record.outcome,
  }))
  removeStoredLiveRequest(LEGACY_LIVE_REQUEST_STORAGE_KEY)
}

function clearPersistedLiveRequest() {
  removeStoredLiveRequest(LIVE_REQUEST_STORAGE_KEY)
  removeStoredLiveRequest(LEGACY_LIVE_REQUEST_STORAGE_KEY)
}

function archiveLiveRequest(record, { requestId, serverStatus }) {
  if (typeof window === 'undefined') throw new Error('实时请求审计只能保存到浏览器会话。')
  const normalized = normalizedStoredLiveRequest({
    ...record,
    ...(requestId ? { requestId } : {}),
    outcome: 'ambiguous',
  })
  if (!normalized) throw new Error('旧请求审计信息无效，已阻止新的实时请求。')

  let existing = []
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(LIVE_REQUEST_AUDIT_STORAGE_KEY) || '[]')
    if (Array.isArray(parsed)) {
      existing = parsed.flatMap((entry) => {
        const request = normalizedStoredLiveRequest({ ...entry, outcome: 'ambiguous' })
        if (!request) return []
        return [{
          ...request,
          serverStatus: entry.serverStatus === 'unknown' ? 'unknown' : 'unverified',
          archivedAt: typeof entry.archivedAt === 'string' ? entry.archivedAt : null,
        }]
      })
    }
  } catch {
    // A damaged audit list is replaced with the current sanitized record.
  }
  window.sessionStorage.setItem(LIVE_REQUEST_AUDIT_STORAGE_KEY, JSON.stringify([
    ...existing.slice(-(MAX_LIVE_REQUEST_AUDIT_RECORDS - 1)),
    {
      ...normalized,
      serverStatus: serverStatus === 'unknown' ? 'unknown' : 'unverified',
      archivedAt: new Date().toISOString(),
    },
  ]))
}

function ambiguousLiveFailure(error) {
  // Every 409 is a server-side suppression result for this browser attempt.
  // It may have been blocked by another idempotency key or a global contract
  // quarantine, so treating it as a no-confirmation replay can dispatch for
  // the first time after the lease expires. A fresh 409 is released and any
  // later Live attempt must be confirmed again; stored ambiguity is resolved
  // only through the read-only request-status endpoint.
  if (error?.status === 409) return false
  if (AMBIGUOUS_LIVE_ERROR_CODES.has(error?.code)) return true
  return error?.status == null || error?.status === 0
}

function HubProductImage({ apiKey, requestId, item }) {
  const [source, setSource] = useState(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setSource(null)
    setFailed(false)
    if (!apiKey || !requestId || !item?.id || !item?.images?.length) return undefined
    const controller = new AbortController()
    let objectUrl = null
    productMediaLoader.load(() => publicDataApi.ecommerceProductImage(apiKey, {
      requestId,
      itemId: item.id,
      imageIndex: 0,
    }, { signal: controller.signal }), { signal: controller.signal }).then((blob) => {
      if (controller.signal.aborted) return
      objectUrl = URL.createObjectURL(blob)
      setSource(objectUrl)
    }).catch((error) => {
      if (error?.name !== 'AbortError') setFailed(true)
    })
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [apiKey, item?.id, item?.images?.length, requestId])

  return source && !failed
    ? <img src={source} alt="" aria-hidden="true" onError={() => setFailed(true)} />
    : <Package size={25} weight="duotone" aria-hidden="true" />
}

function ProductOrb({ item, index, total, selected, onSelect, apiKey, requestId }) {
  const position = orbPosition(index, total)
  return (
    <button
      className={`mih-treasure-orb${selected ? ' is-selected' : ''}`}
      style={{
        '--orb-x': position.x,
        '--orb-y': position.y,
        '--orb-x-mobile': position.mobileX,
        '--orb-y-mobile': position.mobileY,
        '--orb-delay': position.delay,
      }}
      type="button"
      onClick={() => onSelect(item)}
      aria-label={`查看 ${item.title || item.id} 的属性`}
    >
      <span className="mih-treasure-orb__visual">
        <HubProductImage apiKey={apiKey} requestId={requestId} item={item} />
      </span>
      <span>{item.title || '未命名商品'}</span>
      <small>{priceLabel(item.pricing)}</small>
    </button>
  )
}

function ResultEvidence({ product, evidence }) {
  const mode = sourceModeEvidence(evidence?.sourceMode)
  if (!product) {
    const simulatedMiss = evidence?.sourceMode === 'safe_demo'
      && evidence?.simulatedErrorCode === 'stored_snapshot_not_found'
    return (
      <div className="mih-treasure-empty-evidence">
        <Cube size={30} weight="duotone" aria-hidden="true" />
        <strong>{simulatedMiss ? '沙盘无存量，没有商品返回' : '选择商品查看证据'}</strong>
        <p>{simulatedMiss ? '这是浏览器本地的 cache_only 404 演练，不代表刚刚查询过当前 Hub。' : '这里展示 Hub 归一化属性，不暴露上游凭据或原始私有字段。'}</p>
      </div>
    )
  }
  return (
    <div className="mih-treasure-evidence">
      <header>
        <span className={`mih-treasure-mode mih-treasure-mode--${mode.tone}`}>{mode.label}</span>
        <small>{marketplaceLabel(product.marketplace)}</small>
      </header>
      <h2>{product.title || '未命名商品'}</h2>
      <strong className="mih-treasure-evidence__price">{priceLabel(product.pricing)}</strong>
      <dl>
        <div><dt>商品 ID</dt><dd>{product.id || '—'}</dd></div>
        <div><dt>店铺</dt><dd>{product.shop?.name || '—'}</dd></div>
        <div><dt>品牌</dt><dd>{product.attributes?.brand || '—'}</dd></div>
        <div><dt>分类</dt><dd>{product.attributes?.category || '—'}</dd></div>
        <div><dt>销量信号</dt><dd>{product.signals?.sales || '—'}</dd></div>
        <div><dt>评价信号</dt><dd>{product.signals?.reviewCount || '—'}</dd></div>
        <div><dt>位置</dt><dd>{product.signals?.location || '—'}</dd></div>
      </dl>
      {product.url ? <a className="qp-button qp-button--ghost qp-button--sm" href={product.url} target="_blank" rel="noreferrer">查看源页面<ArrowSquareOut size={14} aria-hidden="true" /></a> : null}
    </div>
  )
}

function CallEvidence({ evidence }) {
  const mode = sourceModeEvidence(evidence?.sourceMode)
  const safeDemo = evidence?.sourceMode === 'safe_demo'
  const simulatedResult = evidence?.simulatedErrorCode
    ? `模拟 404 · ${evidence.simulatedErrorCode}`
    : evidence?.simulatedSourceMode
      ? `模拟 ${evidence.simulatedSourceMode}`
      : '等待演练'
  return (
    <section className="mih-treasure-call-evidence" aria-label="本次调用证据">
      <header><Fingerprint size={18} weight="duotone" aria-hidden="true" /><strong>本次交付证据</strong></header>
      <dl>
        <div><dt>交付模式</dt><dd><span className={`mih-treasure-mode mih-treasure-mode--${mode.tone}`}>{mode.label}</span></dd></div>
        {safeDemo ? <div><dt>沙盘策略</dt><dd><code>{evidence?.demoDeliveryMode || '等待选择'}</code></dd></div> : null}
        {safeDemo ? <div><dt>模拟结果</dt><dd>{simulatedResult}</dd></div> : null}
        <div><dt>{safeDemo ? '真实 Hub usage' : 'Hub usage'}</dt><dd>{mode.hubUsage}</dd></div>
        <div><dt>{safeDemo ? '实际上游调用' : '上游调用'}</dt><dd>{mode.providerCall}</dd></div>
        <div><dt>{safeDemo ? '演示运行 ID' : 'Request ID'}</dt><dd>{safeDemo ? evidence?.demoRunId || '等待演练' : evidence?.requestId || '等待请求'}</dd></div>
        <div><dt>数据年龄</dt><dd>{safeDemo ? '不适用（页面示例）' : Number.isFinite(Number(evidence?.ageSeconds)) ? `${evidence.ageSeconds} 秒` : '—'}</dd></div>
      </dl>
      <p>{mode.note}</p>
      {safeDemo && Array.isArray(evidence?.demoTrace) ? (
        <ol className="mih-treasure-demo-trace" aria-label="本地模拟步骤">
          {evidence.demoTrace.map((step) => <li key={step}>{step}</li>)}
        </ol>
      ) : null}
    </section>
  )
}

function TreasureProductError({ error, mode, onUseSafeDemo }) {
  const presentation = ecommerceErrorPresentation(error)
  const serverDetails = error?.details == null
    ? null
    : typeof error.details === 'string' ? error.details : JSON.stringify(error.details)
  return (
    <section className="mih-treasure-product-error" role="alert">
      <WarningCircle size={30} weight="duotone" aria-hidden="true" />
      <div className="mih-treasure-product-error__copy">
        <strong>{presentation.title}</strong>
        <p>{presentation.description}</p>
        <small>
          {error?.code ? <>错误码 <code>{error.code}</code></> : '本次操作未完成'}
          {error?.requestId ? <> · Request ID <code>{error.requestId}</code></> : null}
        </small>
        {serverDetails ? <small>服务端 details <code>{serverDetails}</code></small> : null}
      </div>
      <div className="mih-treasure-product-error__actions">
        {mode !== 'safe_demo' ? <button className="qp-button qp-button--outline qp-button--sm" type="button" onClick={onUseSafeDemo}>转到零费用演示</button> : null}
        {presentation.operatorAction ? <a className="qp-button qp-button--ghost qp-button--sm" href="#/external-platforms?provider=justone&range=24h">查看上游运行状态<ArrowRight size={14} aria-hidden="true" /></a> : null}
      </div>
    </section>
  )
}

export function EcommerceTreasureBoxPage({ notify }) {
  const keyInputRef = useRef(null)
  const requestEpochRef = useRef(0)
  const requestInFlightRef = useRef(false)
  const keyVerificationInFlightRef = useRef(false)
  const mountedRef = useRef(true)
  const verifiedKeyFingerprintRef = useRef(null)
  const [lastLiveRequest, setLastLiveRequest] = useState(loadLiveRequest)
  const lastLiveRequestRef = useRef(lastLiveRequest)
  const [recoveryStatus, setRecoveryStatus] = useState(null)
  const [mode, setMode] = useState('hub_live')
  const [demoDeliveryMode, setDemoDeliveryMode] = useState('cache_first')
  const [demoCacheOnlyScene, setDemoCacheOnlyScene] = useState('no_inventory')
  const [deliveryMode, setDeliveryMode] = useState('refresh')
  const [marketplace, setMarketplace] = useState('taobao')
  const [sort, setSort] = useState('sales_desc')
  const [query, setQuery] = useState('便携相机')
  const [hubApiKey, setHubApiKey] = useState('')
  const [keyCheck, setKeyCheck] = useState({ status: 'idle', fingerprint: null, message: '尚未验证' })
  const [checkingKey, setCheckingKey] = useState(false)
  const [phase, setPhase] = useState('idle')
  const [products, setProducts] = useState([])
  const [resultPage, setResultPage] = useState(null)
  const [view, setView] = useState('list')
  const [browse, setBrowse] = useState('acquire')
  const [upstreamPage, setUpstreamPage] = useState('1')
  const [minPrice, setMinPrice] = useState('')
  const [maxPrice, setMaxPrice] = useState('')
  const resultScopeRef = useRef(null)
  const storedOnly = browse === 'stored' || marketplace === 'all'
  const [displayPageSize, setDisplayPageSize] = useState('6')
  const [displayPage, setDisplayPage] = useState(0)
  const [selected, setSelected] = useState(null)
  const [error, setError] = useState(null)
  const [evidence, setEvidence] = useState(null)
  const [capabilityGroup, setCapabilityGroup] = useState('connected')

  const sortOptions = useMemo(() => availableSorts(mode, marketplace), [marketplace, mode])
  const activeCapability = CAPABILITY_GROUPS.find((group) => group.id === capabilityGroup) || CAPABILITY_GROUPS[0]
  const pageSize = Number(displayPageSize)
  const displayPageCount = Math.max(1, Math.ceil(products.length / pageSize))
  const visibleProducts = products.slice(displayPage * pageSize, (displayPage + 1) * pageSize)
  const hasAmbiguousLiveRequest = lastLiveRequest?.outcome === 'ambiguous'
  const currentLiveBody = useMemo(
    () => requestBody({ marketplace, query, sort, deliveryMode, page: upstreamPage, price: ['taobao', 'tmall'].includes(marketplace) && (minPrice !== '' || maxPrice !== '') ? { ...(minPrice !== '' ? { min: minPrice } : {}), ...(maxPrice !== '' ? { max: maxPrice } : {}) } : undefined }),
    [deliveryMode, marketplace, query, sort, upstreamPage, minPrice, maxPrice],
  )
  const resultScope = JSON.stringify([mode, storedOnly, marketplace, query, sort, minPrice, maxPrice, hubApiKey, deliveryMode])
  const resolvedReplayAvailable = mode === 'hub_live' && lastLiveRequest?.outcome === 'resolved'
  const semanticsLocked = phase === 'searching'
  const providerRequestBlockedByAmbiguity = mode === 'hub_live'
    && hasAmbiguousLiveRequest
    && deliveryMode === 'cache_first'

  useEffect(() => {
    // React development StrictMode intentionally runs setup → cleanup → setup.
    // Restore the flag in setup so that the real mounted instance can finish
    // its request instead of remaining forever in the searching pose.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestEpochRef.current += 1
      requestInFlightRef.current = false
      keyVerificationInFlightRef.current = false
    }
  }, [])

  const rememberLiveRequest = (record, { failClosed = false } = {}) => {
    const remembered = { ...record }
    if (REQUEST_ID_PATTERN.test(remembered.requestId || '')) remembered.requestId = remembered.requestId.trim()
    else delete remembered.requestId
    if (failClosed) persistLiveRequest(remembered)
    else {
      try {
        persistLiveRequest(remembered)
      } catch {
        // The pre-fetch `pending` record is already durable. Leaving that
        // version in storage makes a refresh conservatively recover it as an
        // ambiguous request rather than enabling another provider dispatch
        // that may consume quota or procurement cost.
      }
    }
    lastLiveRequestRef.current = remembered
    setLastLiveRequest(remembered)
  }

  const forgetLiveRequest = () => {
    clearPersistedLiveRequest()
    lastLiveRequestRef.current = null
    setLastLiveRequest(null)
    setRecoveryStatus(null)
  }

  const beginRequest = () => {
    if (requestInFlightRef.current) return null
    requestInFlightRef.current = true
    const epoch = requestEpochRef.current + 1
    requestEpochRef.current = epoch
    setPhase('searching')
    return epoch
  }

  const requestIsCurrent = (epoch) => mountedRef.current && requestEpochRef.current === epoch

  const finishRequest = (epoch) => {
    if (!requestIsCurrent(epoch)) return false
    requestInFlightRef.current = false
    return true
  }

  const changeMode = (value) => {
    if (phase === 'searching') return
    setMode(value)
    if (value === 'hub_live') setDeliveryMode('refresh')
    const nextSorts = availableSorts(value, marketplace)
    if (!nextSorts.some(({ value: option }) => option === sort)) setSort(nextSorts[0]?.value || '')
    setError(null)
    setEvidence(null)
    setProducts([])
    setSelected(null)
    setResultPage(null)
    setDisplayPage(0)
    setPhase('idle')
  }

  const changeDeliveryMode = (value) => {
    if (phase === 'searching' || !DELIVERY_MODES.has(value)) return
    setDeliveryMode(value)
    setError(null)
    setEvidence(null)
    setProducts([])
    setSelected(null)
    setResultPage(null)
    setDisplayPage(0)
    setPhase('idle')
  }

  const changeDemoDeliveryMode = (value) => {
    if (phase === 'searching' || !DELIVERY_MODES.has(value)) return
    setDemoDeliveryMode(value)
    setError(null)
    setEvidence(null)
    setProducts([])
    setSelected(null)
    setResultPage(null)
    setDisplayPage(0)
    setPhase('idle')
  }

  const changeDemoCacheOnlyScene = (value) => {
    if (phase === 'searching' || !DEMO_CACHE_ONLY_SCENES.has(value)) return
    setDemoCacheOnlyScene(value)
    setError(null)
    setEvidence(null)
    setProducts([])
    setSelected(null)
    setResultPage(null)
    setDisplayPage(0)
    setPhase('idle')
  }

  const checkAmbiguousRequestStatus = async ({
    apiKeyOverride,
    fingerprintOverride,
    requestedBody = null,
  } = {}) => {
    const pending = lastLiveRequestRef.current
    const apiKey = String(apiKeyOverride || hubApiKey).trim()
    const fingerprint = fingerprintOverride || keyCheck.fingerprint
    const refreshRequested = requestedBody?.deliveryMode === 'refresh'
    if (requestInFlightRef.current || pending?.outcome !== 'ambiguous') return { action: 'stop' }
    if (!apiKey || !fingerprint || verifiedKeyFingerprintRef.current !== fingerprint) {
      setError({ message: '请先完成零费用 Key 验证。验证成功后，页面会自动用本地幂等账本核对原请求；无需查找或填写 Request ID。' })
      return { action: 'stop' }
    }

    const epoch = beginRequest()
    if (epoch == null) return { action: 'stop' }
    setError(null)
    setRecoveryStatus('checking')
    try {
      const result = await publicDataApi.requestByIdempotencyKey(apiKey, pending.idempotencyKey)
      if (!finishRequest(epoch)) return
      setPhase('idle')
      const status = String(result.payload?.data?.status || '').toLowerCase()
      const recoveryDecision = liveRequestRecoveryDecision({ status })
      const resultRequestId = result.payload?.data?.id
      const verifiedRequestId = typeof resultRequestId === 'string' && REQUEST_ID_PATTERN.test(resultRequestId)
        ? resultRequestId
        : null
      const requestId = verifiedRequestId || pending.requestId
      if (recoveryDecision === 'replay') {
        setMode('hub_live')
        setMarketplace(pending.body.marketplace)
        setQuery(pending.body.query)
        setDeliveryMode(pending.body.deliveryMode || 'cache_first')
        setSort(pending.body.sort || availableSorts('hub_live', pending.body.marketplace)[0]?.value || '')
        rememberLiveRequest({ ...pending, ...(requestId ? { requestId } : {}), outcome: 'resolved' })
        setRecoveryStatus('replaying')
        notify?.('原请求已确认 committed，正在自动读取已提交结果；不会新增 Hub usage 或外部采集。', 'success')
        await runLive({ replay: true, apiKeyOverride: apiKey, fingerprintOverride: fingerprint })
        return { action: 'handled' }
      }
      if (recoveryDecision === 'unlock') {
        forgetLiveRequest()
        setRecoveryStatus('released')
        notify?.('原预留已确认 released，正在使用新的 Idempotency-Key 继续本次重新采集。', 'success')
        return { action: refreshRequested ? 'continue' : 'stop' }
      }
      if (recoveryDecision === 'hold_reserved') {
        rememberLiveRequest({ ...pending, ...(requestId ? { requestId } : {}), outcome: 'ambiguous' })
        setRecoveryStatus('reserved')
        setError({
          status: 409,
          code: 'request_in_progress',
          ...(requestId ? { requestId } : {}),
          message: 'Hub 仍将原请求标记为 reserved，可能仍在执行。本次不会并发创建新的外部采集；稍后再次点击即可自动核对。',
        })
        return { action: 'stop' }
      }
      if (recoveryDecision === 'hold_unknown') {
        rememberLiveRequest({ ...pending, ...(requestId ? { requestId } : {}), outcome: 'ambiguous' })
        setRecoveryStatus('unknown')
        const sameRequest = sameLogicalRequestBody(requestedBody, pending.body)
        if (refreshRequested && (!sameRequest || verifiedRequestId)) {
          try {
            archiveLiveRequest(pending, { requestId, serverStatus: 'unknown' })
          } catch (auditError) {
            setError({
              status: 409,
              code: 'local_audit_unavailable',
              ...(requestId ? { requestId } : {}),
              message: auditError.message,
            })
            return { action: 'stop' }
          }
          forgetLiveRequest()
          setRecoveryStatus('uncertain_repeat')
          setError(null)
          notify?.('旧 unknown 请求已保留到本地审计；正在开启一次新的受控采集尝试。', 'success')
          return {
            action: 'continue',
            ...(sameRequest ? { retryOfRequestId: verifiedRequestId } : {}),
          }
        }
        setError({
          status: 409,
          code: 'request_outcome_unknown',
          ...(requestId ? { requestId } : {}),
          message: sameRequest && !verifiedRequestId
            ? 'Hub 已确认原请求为 unknown，但没有返回可用于受控重试的 Request ID；本次不会创建新的外部采集。'
            : 'Hub 已将原请求标记为 unknown；选择“重新采集”并点击主按钮后，页面才会保留旧审计并开启一次新尝试。',
        })
        return { action: 'stop' }
      }
      rememberLiveRequest({ ...pending, ...(requestId ? { requestId } : {}), outcome: 'ambiguous' })
      setRecoveryStatus('unknown_status')
      setError({
        ...(requestId ? { requestId } : {}),
        message: 'Hub 返回了未识别的请求状态。本地审计账本会继续保留，本次不会发起新的外部采集。',
      })
      return { action: 'stop' }
    } catch (statusError) {
      if (!finishRequest(epoch)) return
      setPhase('idle')
      const recoveryDecision = liveRequestRecoveryDecision({
        httpStatus: statusError?.status,
        errorCode: statusError?.code,
      })
      if (recoveryDecision === 'clear_orphan') {
        forgetLiveRequest()
        setRecoveryStatus('orphan_cleared')
        setError(null)
        notify?.('旧未决账本已由 Hub 明确确认为不存在，正在继续本次重新采集。', 'success')
        return { action: refreshRequested ? 'continue' : 'stop' }
      }
      const deploymentMismatch = recoveryDecision === 'deployment_mismatch'
      setRecoveryStatus(deploymentMismatch ? 'deployment_mismatch' : [403, 404].includes(statusError?.status) ? 'not_accessible' : 'lookup_failed')
      setError({
        ...statusError,
        message: deploymentMismatch
          ? '当前 Public API 尚未提供按幂等键查询路由。请先完成与页面同版本的部署；本地账本会保留，页面不会 POST 或访问 JustOne。'
          : [403, 404].includes(statusError?.status)
          ? '当前调用身份无法核对这条旧幂等记录。本地审计账本会继续保留，本次不会 POST 或创建新的外部采集。'
          : `${statusError?.message || '原请求状态查询失败'}。本地审计账本仍保留；本次 GET 没有创建 Hub usage 或调用外部平台。`,
      })
      return { action: 'stop' }
    }
  }

  const verifyResolvedReplayOwnership = async ({ apiKey, pending }) => {
    if (requestInFlightRef.current || pending?.outcome !== 'resolved') return null
    const epoch = beginRequest()
    if (epoch == null) return null
    setError(null)
    setRecoveryStatus('replay_checking')
    try {
      const result = pending.requestId
        ? await publicDataApi.requestStatus(apiKey, pending.requestId)
        : await publicDataApi.requestByIdempotencyKey(apiKey, pending.idempotencyKey)
      if (!finishRequest(epoch)) return null
      setPhase('idle')
      const status = String(result.payload?.data?.status || '').toLowerCase()
      const platform = String(result.payload?.data?.platform || '').toLowerCase()
      const resultRequestId = result.payload?.data?.id
      const verifiedRequestId = typeof resultRequestId === 'string' && REQUEST_ID_PATTERN.test(resultRequestId)
        ? resultRequestId
        : null
      const sameRequestId = !pending.requestId || verifiedRequestId === pending.requestId
      if (status !== 'committed' || platform !== 'ecommerce' || !verifiedRequestId || !sameRequestId) {
        setRecoveryStatus('replay_blocked')
        setError({
          status: 409,
          code: 'resolved_replay_not_verified',
          ...(verifiedRequestId ? { requestId: verifiedRequestId } : {}),
          details: {
            lookupStatus: status || 'missing',
            lookupPlatform: platform || 'missing',
            ...(pending.requestId ? { expectedRequestId: pending.requestId } : {}),
            ...(verifiedRequestId ? { actualRequestId: verifiedRequestId } : {}),
          },
          message: '只读核验未能确认原请求属于当前 API Key 且已经 committed。',
        })
        return null
      }
      rememberLiveRequest({ ...pending, requestId: verifiedRequestId, outcome: 'resolved' })
      setRecoveryStatus('replay_verified')
      notify?.('原请求归属与 committed 状态已通过只读核验；正在精确读取已提交结果。', 'success')
      return { requestId: verifiedRequestId }
    } catch (statusError) {
      if (!finishRequest(epoch)) return null
      setPhase('idle')
      setRecoveryStatus('replay_blocked')
      setError({
        status: statusError?.status,
        code: 'resolved_replay_not_verified',
        ...(statusError?.requestId ? { requestId: statusError.requestId } : {}),
        details: {
          ...(statusError?.details && typeof statusError.details === 'object' && !Array.isArray(statusError.details)
            ? statusError.details
            : {}),
          ...(statusError?.code ? { lookupErrorCode: statusError.code } : {}),
        },
        message: '当前 API Key 无法只读核验原请求；本地账本已保留，本次不会发送重放 POST。',
      })
      return null
    }
  }

  const changeMarketplace = (value) => {
    if (semanticsLocked) return
    setMarketplace(value)
    setUpstreamPage('1')
    if (value === 'all') { setBrowse('stored'); setMode('hub_live') }
    setSort(availableSorts(mode, value)[0]?.value || '')
    setProducts([])
    setSelected(null)
    setEvidence(null)
    setResultPage(null)
    setDisplayPage(0)
    setPhase('idle')
  }

  const changeSort = (value) => {
    if (semanticsLocked) return
    setSort(value)
  }

  const changeQuery = (value) => {
    if (semanticsLocked) return
    setQuery(value)
  }

  const revealResults = (items, nextEvidence, nextPage = null, append = false) => {
    items = items.map(item => ({ ...item, _evidence: item._evidence || nextEvidence }))
    setProducts(previous => append ? [...previous, ...items] : items)
    resultScopeRef.current = resultScope
    setSelected(items[0] || null)
    setEvidence(nextEvidence)
    setResultPage(nextPage)
    setDisplayPage(0)
    setPhase('presenting')
  }

  const showDisplayPage = (nextPage) => {
    const bounded = Math.max(0, Math.min(displayPageCount - 1, nextPage))
    setDisplayPage(bounded)
    setSelected(products[bounded * pageSize] || null)
  }

  const runSafeDemo = async () => {
    const epoch = beginRequest()
    if (epoch == null) return
    await new Promise((resolve) => window.setTimeout(resolve, 760))
    if (!finishRequest(epoch)) return
    const candidates = demoProducts({ marketplace, query, sort })
    const scenario = safeDemoScenario({ demoDeliveryMode, demoCacheOnlyScene, candidates })
    revealResults(scenario.products, {
      ...scenario.evidence,
      demoRunId: `demo-${crypto.randomUUID()}`,
    }, scenario.page)
    notify?.(`安全策略沙盘完成：${scenario.evidence.demoTitle}；实际没有访问 Hub Data API，也没有创建 Hub usage 或外部采集。`, 'success')
  }

  const runLive = async ({ replay = false, apiKeyOverride, fingerprintOverride, bodyOverride, append = false } = {}) => {
    if (storedOnly || marketplace === 'all') return
    const requestedBody = bodyOverride || currentLiveBody
    const apiKey = String(apiKeyOverride || hubApiKey).trim()
    if (!apiKey) {
      keyInputRef.current?.focus()
      setError({ message: '实时模式使用“API Keys”已签发的开放能力 API Key；无需电商专用 Key，也不接受 JustOne 上游密钥。' })
      return
    }
    const providerMayRun = deliveryMode !== 'cache_only'
    const refreshRequested = !replay && deliveryMode === 'refresh'
    let fingerprint = fingerprintOverride || keyCheck.fingerprint
    if (
      !fingerprint
      || verifiedKeyFingerprintRef.current !== fingerprint
    ) {
      const verification = await verifyHubApiKey()
      if (!verification) return
      fingerprint = verification.fingerprint
    }
    let previous = lastLiveRequestRef.current
    let retryOfRequestId = null
    if (replay && previous?.outcome !== 'resolved') {
      setError({ message: '原请求尚未确认 committed。页面只会先做零上游状态核对；reserved 或 unknown 状态不能从浏览器 POST 重放。' })
      return
    }
    if (replay) {
      const verifiedReplay = await verifyResolvedReplayOwnership({ apiKey, pending: previous })
      if (!verifiedReplay) return
      previous = lastLiveRequestRef.current
    }
    if (!replay && providerMayRun && previous?.outcome === 'ambiguous') {
      if (!refreshRequested) {
        setError({ message: '上一请求的结果仍不确定。可以继续只读 Hub 存量；如需新的外部采集，请选择“重新采集”后点击主按钮。' })
        return
      }
      const recovery = await checkAmbiguousRequestStatus({
        apiKeyOverride: apiKey,
        fingerprintOverride: fingerprint,
        requestedBody,
      })
      if (recovery?.action !== 'continue') return
      previous = lastLiveRequestRef.current
      retryOfRequestId = recovery.retryOfRequestId || null
    }
    const body = replay ? previous?.body : requestedBody
    const idempotencyKey = replay ? previous?.idempotencyKey : `treasure-${crypto.randomUUID()}`
    if (!body || !idempotencyKey) return
    const tracksProviderRisk = replay || body.deliveryMode !== 'cache_only'
    const requestRecord = {
      body,
      idempotencyKey,
      keyFingerprint: fingerprint,
      ...(replay && previous?.requestId ? { requestId: previous.requestId } : {}),
      // Only a status-confirmed committed request can enter replay. Keep that
      // durable fact even if fetching the stored response is interrupted.
      outcome: replay ? 'resolved' : 'pending',
    }
    const epoch = beginRequest()
    if (epoch == null) return
    setError(null)
    try {
      if (!requestIsCurrent(epoch)) return
      verifiedKeyFingerprintRef.current = fingerprint
      if (tracksProviderRisk) {
        // Persist before any request that can reach a provider. A cache-only
        // read cannot dispatch, so it must not overwrite an older ambiguous
        // request that still needs exact reconciliation.
        rememberLiveRequest(requestRecord, { failClosed: true })
      }
      const result = await publicDataApi.ecommerceProductsSearch(apiKey, body, {
        idempotencyKey,
        ...(retryOfRequestId ? { retryOfRequestId } : {}),
      })
      if (!finishRequest(epoch)) return
      const nextEvidence = {
        ...result.evidence,
        sourceMode: result.payload?.meta?.sourceMode || result.evidence.sourceMode,
        requestId: result.payload?.requestId || result.evidence.requestId,
        ageSeconds: result.payload?.meta?.ageSeconds ?? result.evidence.ageSeconds,
      }
      revealResults(result.payload?.data?.items || [], nextEvidence, result.payload?.data?.page || null, append)
      if (tracksProviderRisk) rememberLiveRequest({
        ...requestRecord,
        requestId: nextEvidence.requestId || requestRecord.requestId,
        outcome: 'resolved',
      })
      setRecoveryStatus(null)
      notify?.(`商品已交付 · ${sourceModeEvidence(nextEvidence.sourceMode).label}`, 'success')
    } catch (requestError) {
      if (!finishRequest(epoch)) return
      setPhase('idle')
      const pending = lastLiveRequestRef.current
      if (!replay && tracksProviderRisk && pending?.idempotencyKey === idempotencyKey && ambiguousLiveFailure(requestError)) {
        rememberLiveRequest({
          ...pending,
          ...(requestError?.requestId ? { requestId: requestError.requestId } : {}),
          outcome: 'ambiguous',
        })
        setError({
          ...requestError,
          message: `${requestError?.message || '实时请求结果不确定'}。该调用可能已经发起外部采集并产生内部采购成本；原请求已保留，仍可另外使用“只读 Hub 存量”。`,
        })
      } else {
        // Authentication or policy changes do not prove that an earlier
        // ambiguous provider attempt failed. Keep that request locked until a
        // read-only status check resolves it; only ordinary, non-ambiguous
        // failures may clear the local request ledger.
        const stableCommittedFailure = tracksProviderRisk
          && requestError?.status === 502
          && COMMITTED_LIVE_ERROR_CODES.has(requestError?.code)
        const priorCommittedUnusable = requestError?.status === 409
          && requestError?.code === 'external_platform_response_unusable'
          && previous?.outcome === 'resolved'
          && previous?.committedErrorCode === 'external_platform_response_unusable'
        if (stableCommittedFailure) {
          const durableRequestId = REQUEST_ID_PATTERN.test(requestError?.details?.requestId || '')
            ? requestError.details.requestId
            : requestError?.requestId
          rememberLiveRequest({
            ...requestRecord,
            ...(durableRequestId ? { requestId: durableRequestId } : {}),
            committedErrorCode: requestError.code,
            outcome: 'resolved',
          })
        } else if (priorCommittedUnusable) {
          // The fresh attempt was rejected before provider dispatch by the
          // endpoint quarantine. Restore the first committed-unusable ledger
          // that the temporary pending record replaced.
          rememberLiveRequest(previous)
        } else if (
          tracksProviderRisk
          && !replay
        ) forgetLiveRequest()
        if (requestError?.code === 'invalid_api_key') {
          verifiedKeyFingerprintRef.current = null
          setKeyCheck({
            status: 'invalid',
            fingerprint: null,
            message: 'Key 已失效或不属于当前 Public API 实例，请在同一实例重新签发完整 secret',
          })
          setError({
            ...requestError,
            message: '开放能力 API Key 认证失败。请确认页面和 Key 来自同一 Hub 实例；列表掩码、Admin token 与 JustOne key 均不可调用。',
          })
        } else if (requestError?.code === 'platform_not_granted') {
          setKeyCheck({
            status: 'missing_grant',
            fingerprint: null,
            message: 'Key 有效，但 ecommerce 授权已被撤销；请到开放能力重新授予',
          })
          setError({
            ...requestError,
            message: '该 Key 的 snapshot 没有 ecommerce，或所属调用身份已撤权；授权后请签发明确包含该范围的新 Key。',
          })
        } else {
          setError(requestError)
        }
      }
    }
  }

  const loadStored = async (append = false) => {
    const epoch = beginRequest()
    if (epoch == null) return
    setError(null)
    try {
      const result = await publicDataApi.ecommerceStoredItems(hubApiKey.trim(), {
        marketplace, query: query.trim(), pageSize: '20',
        ...(append && resultPage?.nextCursor ? { cursor: resultPage.nextCursor } : {}),
      })
      if (!finishRequest(epoch)) return
      const data = result.payload.data
      revealResults(data.items.map(row => ({ ...row.product, _evidence: { sourceMode: 'stored_inventory', requestId: row.requestId, capturedAt: row.capturedAt || row.recordedAt } })), { sourceMode: 'stored_inventory' }, data.pageInfo, append)
    } catch (failure) {
      if (!finishRequest(epoch)) return
      setError(failure)
      setPhase('presenting')
    }
  }
  const canContinue = phase !== 'searching' && products.length > 0 && resultScopeRef.current === resultScope && (storedOnly || !hasAmbiguousLiveRequest)
    && mode === 'hub_live' && resultPage?.hasMore !== false
    && (storedOnly ? Boolean(resultPage?.nextCursor) : (Boolean(resultPage?.nextCursor) || (marketplace !== 'xiaohongshu_ec' && Number(resultPage?.page || 1) < 1000)))
  const loadNext = () => {
    if (!canContinue) return
    if (storedOnly) { void loadStored(true); return }
    const { page, cursor, ...filters } = currentLiveBody
    void runLive({ append: true, bodyOverride: { ...filters, ...(resultPage?.nextCursor ? { cursor: resultPage.nextCursor } : { page: Number(resultPage?.page || 1) + 1 }) } })
  }

  const submit = async (event) => {
    event.preventDefault()
    setError(null)
    if (storedOnly) { await loadStored(); return }
    if (!query.trim()) {
      setError({ message: '请输入要找的商品。' })
      return
    }
    if (mode === 'safe_demo') await runSafeDemo()
    else await runLive()
  }

  const changeHubApiKey = (value) => {
    // A resolved replay can be discarded when the credential changes. An
    // ambiguous request remains locked when only the credential changes. A
    // controlled repeat is available only after an explicit refresh action
    // and an automatic GET that verifies the old unknown ID.
    if (verifiedKeyFingerprintRef.current && value !== hubApiKey) {
      if (lastLiveRequestRef.current?.outcome !== 'ambiguous') forgetLiveRequest()
    }
    verifiedKeyFingerprintRef.current = null
    setProducts([])
    setSelected(null)
    setResultPage(null)
    setEvidence(null)
    setHubApiKey(value)
    setKeyCheck({ status: 'idle', fingerprint: null, message: 'Key 已改变，请重新做零费用验证' })
    setError(null)
  }

  const verifyHubApiKey = async () => {
    const apiKey = hubApiKey.trim()
    if (!apiKey) {
      keyInputRef.current?.focus()
      setKeyCheck({ status: 'invalid', fingerprint: null, message: '请粘贴签发时显示的完整 Hub Public API secret' })
      return null
    }
    if (apiKey.includes('****')) {
      setKeyCheck({ status: 'invalid', fingerprint: null, message: '这是列表中的掩码标识，不能用于调用；请重新签发并复制只显示一次的完整 secret' })
      return null
    }
    if (apiKey.startsWith('mih_test_')) {
      setKeyCheck({
        status: 'invalid',
        fingerprint: null,
        message: hasAmbiguousLiveRequest
          ? '历史 Test Key 不能核对或恢复外部请求；请改用该调用身份当前有效的 mih_live_ Key，页面会自动处理未决账本'
          : 'Test 前缀当前只是兼容标签，并非隔离沙箱；外部电商采集只接受 mih_live_ Key',
      })
      return null
    }
    if (!/^mih_live_/u.test(apiKey)) {
      setKeyCheck({ status: 'invalid', fingerprint: null, message: 'Hub Public API secret 应以 mih_live_ 开头；不要填写列表掩码、Admin token 或 JustOne key' })
      return null
    }
    if (keyVerificationInFlightRef.current) return null
    keyVerificationInFlightRef.current = true
    setCheckingKey(true)
    setError(null)
    try {
      const [fingerprint, result] = await Promise.all([
        apiKeyFingerprint(apiKey),
        publicDataApi.capabilities(apiKey),
      ])
      const platforms = Array.isArray(result.payload?.data?.platforms) ? result.payload.data.platforms : []
      const ecommerce = platforms.find((entry) => (
        (typeof entry === 'string' ? entry : entry?.platform) === 'ecommerce'
      ))
      if (!ecommerce) {
        verifiedKeyFingerprintRef.current = null
        setKeyCheck({ status: 'missing_grant', fingerprint, message: 'Key 有效，但其 snapshot 未包含 ecommerce，或 consumer 已撤权' })
        return null
      }
      verifiedKeyFingerprintRef.current = fingerprint
      if (typeof ecommerce !== 'object' || ecommerce.ready !== true) {
        setKeyCheck({
          status: 'degraded',
          fingerprint,
          message: 'Key 与 ecommerce 授权有效；当前上游未就绪，仍可尝试缓存、存档或精确重放',
        })
      } else {
        setKeyCheck({
          status: 'ready',
          fingerprint,
          message: 'Key 有效 · ecommerce 已授权 · 当前路由就绪',
        })
      }
      notify?.('开放能力 API Key 预检通过：没有创建 Hub usage，也没有发起外部采集。', 'success')
      return { apiKey, fingerprint }
    } catch (checkError) {
      verifiedKeyFingerprintRef.current = null
      const message = checkError?.code === 'invalid_api_key'
        ? '不是当前 Public API 实例可用的完整 secret：不要粘贴列表中的掩码、Admin token 或 JustOne key；内存模式重启后需重新签发'
        : checkError?.message || 'Key 验证失败'
      setKeyCheck({ status: 'invalid', fingerprint: null, message })
      return null
    } finally {
      keyVerificationInFlightRef.current = false
      setCheckingKey(false)
    }
  }

  return (
    <section className="mih-treasure-page">
      <PageHeading
        eyebrow="DATA PRODUCT / JUSTONE CONNECTOR / GOVERNED DELIVERY"
        title="电商数据"
        description="小聚替你从统一 Hub 合同中找商品；来源未来可替换或扩展，调用、数据、计量与证据仍保持一致。"
      >
        <a className="qp-button qp-button--outline qp-button--sm" href={publicDocsHref('/docs/ecommerce-treasure-box')} target="_blank" rel="noreferrer">接入文档<ArrowSquareOut size={15} aria-hidden="true" /></a>
      </PageHeading>

      <div className="mih-treasure-trust-strip" role="list" aria-label="产品边界">
        <span role="listitem"><ShieldCheck size={16} weight="duotone" aria-hidden="true" /><strong>稳定合同</strong><code>mx-insight-hub.ecommerce-products.v1</code></span>
        <span role="listitem"><ShoppingBagOpen size={16} weight="duotone" aria-hidden="true" /><strong>已核验</strong>5 个 marketplace</span>
        <span role="listitem"><Database size={16} weight="duotone" aria-hidden="true" /><strong>数据链路</strong>原始归档 → canonical → ES</span>
        <a href="#/source-catalog?section=catalog&catalogView=justone-connected"><ArrowRight size={15} aria-hidden="true" />查看目录标记</a>
      </div>

      <section className="qp-panel mih-treasure-lab">
        {error ? <TreasureProductError error={error} mode={mode} onUseSafeDemo={() => changeMode('safe_demo')} /> : null}
        <form className="mih-treasure-controls" onSubmit={submit}>
          <header><MagicWand size={20} weight="duotone" aria-hidden="true" /><div><strong>告诉小聚你要什么</strong><small>选择交付策略，验证 API Key 后开始采集。</small></div></header>
          <DropdownField label="获取方式" value={mode} options={MODE_OPTIONS} disabled={phase === 'searching' || storedOnly} onChange={changeMode} />
          {mode === 'safe_demo' ? (
            <>
              <DropdownField label="模拟交付策略" value={demoDeliveryMode} options={DEMO_DELIVERY_MODE_OPTIONS} disabled={phase === 'searching'} onChange={changeDemoDeliveryMode} />
              {demoDeliveryMode === 'cache_only' ? <DropdownField label="cache_only 演练场景" value={demoCacheOnlyScene} options={DEMO_CACHE_ONLY_SCENE_OPTIONS} disabled={phase === 'searching'} onChange={changeDemoCacheOnlyScene} /> : null}
              <div className="mih-treasure-demo-boundary" role="status">
                <ShieldCheck size={17} weight="duotone" aria-hidden="true" />
                <span><strong>浏览器本地策略沙盘 · 实际 0 Hub / 0 上游</strong><small>不读取当前 Hub 存量，不发 JustOne 请求，不创建 Hub usage。证据始终记录真实 <code>sourceMode=safe_demo</code>；缓存或实时结果只会标作“模拟”。</small></span>
              </div>
            </>
          ) : <DropdownField label="交付策略" value={deliveryMode} options={DELIVERY_MODE_OPTIONS} disabled={phase === 'searching' || storedOnly} onChange={changeDeliveryMode} />}
          <DropdownField label="数据范围" value={storedOnly ? 'stored' : 'acquire'} options={[{ value: 'acquire', label: '按平台采集' }, { value: 'stored', label: '浏览已存数据' }]} disabled={semanticsLocked || marketplace === 'all'} onChange={value => { setBrowse(value); if (value === 'stored') setMode('hub_live') }} />
          <DropdownField label="平台" value={marketplace} options={[...MARKETPLACES, { value: 'all', label: '全部平台 · 仅已存数据' }]} disabled={semanticsLocked} onChange={changeMarketplace} />
          <DropdownField label="排序" value={sort} options={sortOptions} disabled={semanticsLocked || storedOnly || !(mode === 'safe_demo' ? SAFE_DEMO_SORTS : SORTS)[marketplace]} onChange={changeSort} />
          {view === 'treasure' ? <DropdownField label="百宝箱陈列数量" value={displayPageSize} options={DISPLAY_PAGE_SIZE_OPTIONS} disabled={semanticsLocked} onChange={(value) => { setDisplayPageSize(value); setDisplayPage(0); setSelected(products[0] || null) }} /> : null}
          <Field label="搜索词" hint={storedOnly ? "按商品标题筛选本调用身份的已存记录；留空显示全部。" : "上游搜索词；刷新从指定页开始，下滑加载后续数据页。"}>
            <span className="mih-treasure-query"><MagnifyingGlass size={17} aria-hidden="true" /><input className="qp-input" value={query} maxLength="200" disabled={semanticsLocked} onChange={(event) => changeQuery(event.target.value)} placeholder="例如：便携相机" /></span>
          </Field>
          {!storedOnly && mode === 'hub_live' ? <>
            <Field label="起始数据页" hint={marketplace === 'xiaohongshu_ec' ? '小红书从第 1 页开始，再使用上游 continuation。' : '刷新从此页重新采集；下一页使用独立幂等键。'}><input className="qp-input" type="number" min="1" max="1000" value={marketplace === 'xiaohongshu_ec' ? '1' : upstreamPage} disabled={semanticsLocked || marketplace === 'xiaohongshu_ec'} onChange={event => setUpstreamPage(event.target.value)} /></Field>
            {['taobao', 'tmall'].includes(marketplace) ? <div className="mih-commerce-price"><Field label="最低价"><input className="qp-input" type="number" min="0" value={minPrice} disabled={semanticsLocked} onChange={event => setMinPrice(event.target.value)} /></Field><Field label="最高价"><input className="qp-input" type="number" min="0" value={maxPrice} disabled={semanticsLocked} onChange={event => setMaxPrice(event.target.value)} /></Field></div> : null}
          </> : null}
          {storedOnly ? <p>仅查询当前调用身份已提交的商品记录，按入库请求时间倒序、同批按上游顺序展示。不会调用上游。</p> : null}
          {mode === 'hub_live' ? (
            <div className="mih-treasure-live-auth">
              <Field label="开放能力 API Key" hint="就是客户端从“API Keys”获得的同一把 Hub Public API secret；签发时必须显式包含 ecommerce，新增授权不会扩大旧 snapshot Key。">
                <span className="mih-treasure-key"><Key size={17} aria-hidden="true" /><input ref={keyInputRef} className="qp-input" type="password" autoComplete="off" value={hubApiKey} disabled={phase === 'searching' || checkingKey} onChange={(event) => changeHubApiKey(event.target.value)} placeholder="mih_live_…" /></span>
              </Field>
              <div className={`mih-treasure-key-check mih-treasure-key-check--${keyCheck.status}`} role="status" aria-live="polite">
                <span><ShieldCheck size={16} weight="duotone" aria-hidden="true" />{keyCheck.message}</span>
                <button className="qp-button qp-button--ghost qp-button--sm" type="button" disabled={!hubApiKey.trim() || checkingKey || phase === 'searching'} onClick={verifyHubApiKey}>{checkingKey ? '验证中' : '零费用验证 Key'}</button>
                <a href="#/api-keys">签发 / 轮换 API Key<ArrowRight size={13} aria-hidden="true" /></a>
              </div>
              <p className="mih-treasure-public-origin"><Database size={15} weight="duotone" aria-hidden="true" />本页调用 Public API：<code>{publicApiOrigin()}</code><small>由部署项 <code>MX_INSIGHT_PUBLIC_URL</code> 下发；它不是 JustOne 地址。</small></p>
              {deliveryMode === 'cache_only' ? (
                <div className="mih-treasure-cache-guarantee"><ShieldCheck size={17} weight="duotone" aria-hidden="true" /><span><strong>只读保障：本次不会调用外部平台</strong><small>只查同一调用身份下的精确缓存或存档；命中会记录 Hub usage，未命中会明确提示，不会偷偷切到 JustOne。</small></span></div>
              ) : null}
            </div>
          ) : null}
          {hasAmbiguousLiveRequest ? (
            <div className="mih-treasure-recovery-note" role="status">
              <Fingerprint size={17} weight="duotone" aria-hidden="true" />
              <span>
                <strong>上一次外部采集请求仍待核查</strong>
                <small>{mode === 'safe_demo'
                  ? '原请求与 Idempotency-Key 会继续保留，但不影响本地安全演示。'
                  : recoveryStatus === 'checking'
                    ? '正在自动用本地幂等账本做只读 GET 核对；无需输入 Request ID，也不会在核对阶段访问 JustOne。'
                    : recoveryStatus === 'reserved'
                      ? '服务端仍为 reserved，原请求可能正在执行；本次已停止，不会并发创建新的外部采集。稍后再次点击即可自动核对。'
                      : recoveryStatus === 'unknown'
                        ? '服务端已确认 unknown；选择“重新采集”并点击主按钮后，页面会保留旧审计并申请一次受控新尝试。'
                        : recoveryStatus === 'deployment_mismatch'
                          ? 'Public API 查询路由与页面版本不一致；本地账本继续保留，先完成同版本部署，浏览器不会 POST。'
                        : recoveryStatus === 'not_accessible'
                          ? '当前 Key 无法读取旧记录；本地账本继续保留，本次不会创建新的外部采集。'
                          : deliveryMode === 'refresh'
                            ? '选择条件后点击主按钮即可：页面会先自动只读核对；明确 unknown 时保留旧审计，再由 Hub 受控开启一次新尝试。reserved 或核对失败仍会安全停止。'
                            : deliveryMode === 'cache_only'
                              ? '可以直接读取 Hub 存量；只读请求不会覆盖这条未决审计，也不会访问 JustOne。'
                              : 'cache_first 不会绕过未决请求；如需明确新采集，请改选“重新采集”后点击主按钮。'}</small>
              </span>
            </div>
          ) : null}
          {recoveryStatus === 'replaying' ? <div className="mih-treasure-recovery-note mih-treasure-recovery-note--resolved" role="status"><CheckCircle size={17} weight="duotone" aria-hidden="true" /><span><strong>原请求已确认 committed</strong><small>正在自动使用相同 body 与 Idempotency-Key 读取原结果；不会新增 Hub usage 或外部采集。</small></span></div> : null}
          {recoveryStatus === 'released' ? <div className="mih-treasure-recovery-note mih-treasure-recovery-note--resolved" role="status"><CheckCircle size={17} weight="duotone" aria-hidden="true" /><span><strong>原预留已确认 released</strong><small>本地未决锁已解除；本次重新采集会使用新的 Idempotency-Key。</small></span></div> : null}
          {recoveryStatus === 'orphan_cleared' ? <div className="mih-treasure-recovery-note mih-treasure-recovery-note--resolved" role="status"><CheckCircle size={17} weight="duotone" aria-hidden="true" /><span><strong>孤儿未决账本已安全清理</strong><small>Hub 明确返回 request_not_found；这不是通用路由 404，本次重新采集可以继续。</small></span></div> : null}
          {lastLiveRequest?.outcome === 'resolved' && lastLiveRequest.committedErrorCode === 'external_platform_response_unusable' ? <div className="mih-treasure-recovery-note mih-treasure-recovery-note--resolved" role="status"><Fingerprint size={17} weight="duotone" aria-hidden="true" /><span><strong>首次 committed-unusable 账本已保留</strong><small>该调用的响应无法归一化，可能已有上游采购成本；精确重放只读取已提交错误，不会再次访问 JustOne。{lastLiveRequest.requestId ? <> Request ID <code>{lastLiveRequest.requestId}</code></> : null}</small></span></div> : null}
          <button className="qp-button qp-button--primary mih-treasure-search" type="submit" disabled={phase === 'searching' || checkingKey || (!storedOnly && providerRequestBlockedByAmbiguity)}>
            {phase === 'searching' ? <><Sparkle className="mih-spin" size={17} aria-hidden="true" />正在处理</> : <><MagnifyingGlass size={17} aria-hidden="true" />{storedOnly ? '查询已存电商数据' : mode === 'safe_demo' ? (demoDeliveryMode === 'cache_only' && demoCacheOnlyScene === 'no_inventory' ? '演练无存量 cache_only' : '运行本地策略沙盘') : providerRequestBlockedByAmbiguity ? '改为重新采集或只读存量' : deliveryMode === 'cache_only' ? '读取 Hub 存量' : deliveryMode === 'refresh' ? (hasAmbiguousLiveRequest ? '自动核对后重新采集' : '重新采集最新数据') : '调用开放 API'}</>}
          </button>
          {resolvedReplayAvailable ? <button className="qp-button qp-button--ghost qp-button--sm" type="button" disabled={phase === 'searching'} onClick={() => runLive({ replay: true })}><ArrowClockwise size={15} aria-hidden="true" />读取已提交的原结果 · 幂等 POST / 0 新增 usage / 外部采集</button> : null}
          <p className="mih-treasure-auth-note"><LockKey size={15} aria-hidden="true" />这里使用普通 Hub Public API secret，不是供应方 Key；它必须在签发时包含 ecommerce entitlement。列表掩码不能调用，供应方密钥只在“外部数据平台”管理。</p>
        </form>

        <section className="mih-commerce-results">
          <div className="mih-commerce-toolbar" role="group" aria-label="电商数据视图">
            <button type="button" className="qp-button qp-button--outline" aria-pressed={view === 'list'} onClick={() => setView('list')}>列表视图</button>
            <button type="button" className="qp-button qp-button--outline" aria-pressed={view === 'treasure'} onClick={() => setView('treasure')}>百宝箱视图</button>
            <span>{products.length} 条已载入</span>
            <button type="button" className="qp-button qp-button--ghost" disabled={phase === 'searching' || checkingKey} onClick={() => { if (storedOnly) void loadStored(); else if (mode === 'safe_demo') void runSafeDemo(); else void runLive() }}>{storedOnly ? '刷新已存列表' : '刷新当前查询'}</button>
          </div>
          {view === 'list' ? <div className="mih-commerce-feed" tabIndex="0" aria-label="商品列表" onScroll={event => {
            const element = event.currentTarget
            if (element.scrollTop > 0 && element.scrollHeight - element.scrollTop - element.clientHeight < 100 && resultPage?.nextCursor && !error) loadNext()
          }}>
            <div className="mih-commerce-grid">{products.map((item, index) => <button type="button" className="mih-commerce-card" key={`${item._evidence?.requestId}-${item.id}-${index}`} onClick={() => setSelected(item)}>
              <div className="mih-commerce-card-image"><HubProductImage item={item} apiKey={mode === 'hub_live' ? hubApiKey.trim() : ''} requestId={item._evidence?.requestId} /></div>
              <small>{MARKETPLACES.find(platform => platform.value === item.marketplace)?.label || item.marketplace}</small>
              <strong>{item.title}</strong><b>{priceLabel(item.pricing)}</b>
              {item._evidence?.capturedAt ? <time>{new Date(item._evidence.capturedAt).toLocaleString()}</time> : null}
            </button>)}</div>
            {!products.length ? <p className="mih-commerce-empty">{phase === 'searching' ? '正在读取数据…' : '选择平台和条件后开始。全部平台只浏览已存数据。'}</p> : null}
          </div> : (
        <div className={`mih-treasure-stage mih-treasure-stage--${phase}`} aria-live="polite">
          <div className="mih-treasure-stage__halo" aria-hidden="true" />
          <span className="mih-treasure-stage__provider">{mode === 'safe_demo' ? <>本地策略沙盘 <strong>不连接 Hub / JustOne</strong></> : <>当前唯一上游候选 <strong>JustOne</strong></>}</span>
          {phase === 'presenting' ? (
            <div className="mih-treasure-speech">
              <strong>{evidence?.sourceMode === 'safe_demo' ? evidence.demoTitle : products.length ? (evidence?.sourceMode === 'fresh_cache' ? '缓存里刚好有一份' : evidence?.sourceMode === 'stored_fallback' ? '先给你可靠的存档' : 'Here you are') : '这次没有找到商品'}</strong>
              <small>{evidence?.sourceMode === 'safe_demo' ? evidence.demoDescription : products.length ? `${products.length} 件归一化商品 · 陈列 ${displayPage + 1}/${displayPageCount}` : '这是正常空结果，可以换关键词或平台；交付证据仍会保留'}</small>
            </div>
          ) : null}
          <img
            className="mih-treasure-mascot"
            src={phase === 'searching' ? SEARCHING_ASSET : PRESENTING_ASSET}
            alt={phase === 'searching' ? '原创数据百宝猫小聚正在从数据袋中搜索' : '原创数据百宝猫小聚张开双手展示商品'}
          />
          {phase === 'searching' ? <span className="mih-treasure-searching-copy"><i /><i /><i />{mode === 'safe_demo' ? '正在本地演练交付策略 · 不访问 Hub 或上游' : '正在检查授权、Hub 存量与交付策略'}</span> : null}
          {phase === 'presenting' ? visibleProducts.map((item, index) => <ProductOrb key={`${item.marketplace}-${item.id}-${displayPage}-${index}`} item={item} index={index} total={visibleProducts.length} selected={selected?.id === item.id} onSelect={setSelected} apiKey={mode === 'hub_live' ? hubApiKey.trim() : ''} requestId={item._evidence?.requestId || evidence?.requestId} />) : null}
          {phase === 'presenting' && products.length ? (
            <nav className="mih-treasure-pagination" aria-label="商品陈列分页">
              <button type="button" aria-label="上一陈列页" disabled={displayPage === 0} onClick={() => showDisplayPage(displayPage - 1)}><CaretLeft size={15} aria-hidden="true" /></button>
              <span><strong>{displayPage + 1} / {displayPageCount}</strong><small>数据页 {resultPage?.page || 1} · 本批 {products.length} 件 · 每页 {pageSize}</small></span>
              <button type="button" aria-label="下一陈列页" disabled={displayPage >= displayPageCount - 1} onClick={() => showDisplayPage(displayPage + 1)}><CaretRight size={15} aria-hidden="true" /></button>
            </nav>
          ) : null}
          {phase === 'idle' ? (
            <p className="mih-treasure-stage__welcome">
              <Sparkle size={17} weight="fill" aria-hidden="true" />
              {mode === 'safe_demo' ? safeDemoIdleMessage(demoDeliveryMode, demoCacheOnlyScene) : deliveryMode === 'cache_only' ? '我只找 Hub 的精确存量，本次不会访问外部平台。' : deliveryMode === 'refresh' ? '已选择重新采集；点击搜索会尝试访问当前合格上游。' : '我会先找 Hub 新鲜数据，需要时才去上游。'}
            </p>
          ) : null}
        </div>
)}
          <div className="mih-commerce-footer">
            <button type="button" className="qp-button qp-button--outline" disabled={!canContinue} onClick={loadNext}>{phase === 'searching' ? '正在加载…' : storedOnly ? '加载更多已存数据' : resultPage?.nextCursor ? '加载下一数据页' : '尝试下一数据页'}</button>
            <small>{resultScopeRef.current !== resultScope && products.length ? '条件已变化，请重新查询。' : resultPage?.hasMore === false ? '本次分页已结束。' : storedOnly ? '按时间浏览已存记录，不触发采集。' : '下滑加载已确认的下一页；上游未给出分页标记时，可手动尝试下一页。刷新请点击左侧采集按钮。'}</small>
          </div>
        </section>

        <aside className="mih-treasure-inspector">
          <ResultEvidence product={selected} evidence={selected?._evidence || evidence} />
          <CallEvidence evidence={selected?._evidence || evidence} />
        </aside>
      </section>

      <section className="mih-treasure-section">
        <header className="mih-treasure-section__header">
          <div><p className="qp-kicker">UPSTREAM API ATLAS</p><h2>JustOne 接口星图</h2><p>先看 Hub 做到了什么，再看官方目录还可以吸纳什么；“存在”不等于“已接”。</p></div>
          <a className="qp-button qp-button--ghost qp-button--sm" href="https://docs.justoneapi.com/zh/api/" target="_blank" rel="noreferrer">官方接口目录<ArrowSquareOut size={14} aria-hidden="true" /></a>
        </header>
        <div className="mih-treasure-atlas-tabs" role="group" aria-label="接口星图分组">
          {CAPABILITY_GROUPS.map((group) => <button key={group.id} className={capabilityGroup === group.id ? 'is-selected' : ''} type="button" aria-pressed={capabilityGroup === group.id} onClick={() => setCapabilityGroup(group.id)}><span>{group.title}</span><small>{group.items.length}</small></button>)}
        </div>
        <article className={`qp-panel mih-treasure-capability mih-treasure-capability--${activeCapability.tone}`}>
          <header><span><CheckCircle size={21} weight="duotone" aria-hidden="true" /></span><div><h3>{activeCapability.title}</h3><p>{activeCapability.description}</p></div></header>
          <div>{activeCapability.items.map((item) => <span key={item}>{item}</span>)}</div>
          <footer><ShieldCheck size={16} aria-hidden="true" />目录快照复核于 2026-09-06；新增运行时能力必须先固定响应 fixture 与版本合同。</footer>
        </article>
      </section>

      <section className="mih-treasure-section">
        <header className="mih-treasure-section__header"><div><p className="qp-kicker">ONE ENDPOINT / DIFFERENT DELIVERY</p><h2>一次调用，四种真实交付路径</h2><p>Hub usage、供应方采购成本与客户计价是三套逻辑；客户只使用同一把 API Key。</p></div></header>
        <div className="qp-data-table mih-table-wrap mih-treasure-cost-table">
          <table className="mih-table">
            <thead><tr><th>sourceMode</th><th>用户拿到什么</th><th>新 Hub usage</th><th>新上游调用</th><th>处理原则</th></tr></thead>
            <tbody>
              {Object.entries(SOURCE_MODE_LABELS).filter(([key]) => key !== 'safe_demo').map(([key, value]) => <tr key={key}><td><code>{key}</code></td><td><span className={`mih-treasure-mode mih-treasure-mode--${value.tone}`}>{value.label}</span></td><td>{value.hubUsage}</td><td>{value.providerCall}</td><td>{value.note}</td></tr>)}
            </tbody>
          </table>
        </div>
        <div className="mih-treasure-next-links">
          <a href="#/external-platforms?provider=justone&range=24h"><ChartLineUp size={18} weight="duotone" aria-hidden="true" /><span><strong>看真实调用与成本</strong><small>请求量、上游派发、成功率、租户排行</small></span><ArrowRight size={16} aria-hidden="true" /></a>
          <a href="#/api-keys"><Key size={18} weight="duotone" aria-hidden="true" /><span><strong>获取开放能力 API Key</strong><small>一把 Key 的调用身份授予 ecommerce 后即可调用</small></span><ArrowRight size={16} aria-hidden="true" /></a>
          <a href={publicDocsHref('/docs/ecommerce-treasure-box')} target="_blank" rel="noreferrer"><Coins size={18} weight="duotone" aria-hidden="true" /><span><strong>交给其他系统调用</strong><small>稳定请求、响应、分页与错误合同</small></span><ArrowRight size={16} aria-hidden="true" /></a>
        </div>
      </section>
    </section>
  )
}
