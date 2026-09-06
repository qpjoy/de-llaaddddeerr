import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowClockwise,
  ArrowRight,
  ArrowSquareOut,
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
} from '@phosphor-icons/react'
import { publicDataApi, publicDocsHref } from './api.js'
import { DropdownField, ErrorState, Field, PageHeading } from './components.jsx'

const SEARCHING_ASSET = 'assets/ecommerce-treasure-box/data-cat-searching.webp'
const PRESENTING_ASSET = 'assets/ecommerce-treasure-box/data-cat-presenting.webp'
const ECOMMERCE_DOCS_HREF = publicDocsHref('/docs/ecommerce-treasure-box')

const MARKETPLACES = [
  { value: 'taobao', label: '淘宝', catalogKey: 'source-catalog-0058', filters: '排序 · 价格' },
  { value: 'tmall', label: '天猫', catalogKey: 'source-catalog-0059', filters: '排序 · 价格' },
  { value: 'jd', label: '京东', catalogKey: 'source-catalog-0060', filters: '平台默认' },
  { value: 'xiaohongshu_ec', label: '小红书店铺', catalogKey: 'source-catalog-0064', filters: '平台默认' },
  { value: 'xianyu', label: '闲鱼', catalogKey: 'source-catalog-0073', filters: '排序' },
]

const MODE_OPTIONS = [
  { value: 'safe_demo', label: '安全演示 · 0 上游调用', description: '只使用页面内清晰标注的演示商品。' },
  { value: 'hub_live', label: '实时 Hub API · 可能计费', description: '使用 Hub consumer key 调用稳定公开契约。' },
]

const LIVE_REQUEST_STORAGE_KEY = 'mx-insight-hub.ecommerce-treasure-box.live-request.v1'
const AMBIGUOUS_LIVE_ERROR_CODES = new Set([
  'external_platform_outcome_unknown',
  'external_platform_response_unusable',
  'request_outcome_unknown',
  'upstream_outcome_unknown',
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
  live: { label: '实时上游', tone: 'live', providerCall: '是', hubUsage: '是', note: '业务码成功时记录上游计费证据' },
  fresh_cache: { label: '新鲜缓存', tone: 'cache', providerCall: '否', hubUsage: '是', note: '同一规范请求复用新鲜快照' },
  stored_fallback: { label: '存储兜底', tone: 'fallback', providerCall: '可能', hubUsage: '是', note: '可能在派发前兜底，也可能在上游失败后兜底' },
  idempotent_replay: { label: '幂等重放', tone: 'replay', providerCall: '否', hubUsage: '否', note: '相同 key + 相同请求返回原结果' },
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

const ORB_POSITIONS = [
  { x: '-188px', y: '-126px', mobileX: '-126px', mobileY: '-112px', delay: '0ms' },
  { x: '112px', y: '-142px', mobileX: '74px', mobileY: '-122px', delay: '70ms' },
  { x: '-226px', y: '20px', mobileX: '-140px', mobileY: '8px', delay: '140ms' },
  { x: '154px', y: '8px', mobileX: '92px', mobileY: '2px', delay: '210ms' },
  { x: '-174px', y: '144px', mobileX: '-108px', mobileY: '126px', delay: '280ms' },
  { x: '114px', y: '146px', mobileX: '72px', mobileY: '128px', delay: '350ms' },
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

function requestBody({ marketplace, query, sort, cursor = null }) {
  return {
    marketplace,
    query: query.normalize('NFKC').trim(),
    ...(cursor ? { cursor } : {}),
    ...(!cursor && sort ? { sort } : {}),
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

async function consumerFingerprint(apiKey) {
  if (!globalThis.crypto?.subtle) throw new Error('当前浏览器不支持安全的 consumer fingerprint，已阻止实时请求。')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(apiKey))
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

function storedRequestBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const allowed = new Set(['marketplace', 'query', 'cursor', 'sort'])
  if (Object.keys(value).some((key) => !allowed.has(key))) return null
  if (!MARKETPLACES.some(({ value: marketplace }) => marketplace === value.marketplace)) return null
  if (typeof value.query !== 'string' || !value.query.trim() || value.query.length > 200) return null
  if (value.cursor != null && (typeof value.cursor !== 'string' || value.cursor.length > 4_096)) return null
  if (value.sort != null && (typeof value.sort !== 'string' || value.sort.length > 40)) return null
  return requestBody({
    marketplace: value.marketplace,
    query: value.query,
    sort: value.sort || '',
    cursor: value.cursor || null,
  })
}

function loadLiveRequest() {
  if (typeof window === 'undefined') return null
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(LIVE_REQUEST_STORAGE_KEY) || 'null')
    const body = storedRequestBody(parsed?.body)
    if (
      !body
      || !/^treasure-[0-9a-f-]{36}$/u.test(parsed?.idempotencyKey || '')
      || !/^[0-9a-f]{64}$/u.test(parsed?.consumerFingerprint || '')
      || !['pending', 'ambiguous', 'resolved'].includes(parsed?.outcome)
    ) {
      window.sessionStorage.removeItem(LIVE_REQUEST_STORAGE_KEY)
      return null
    }
    return {
      body,
      idempotencyKey: parsed.idempotencyKey,
      consumerFingerprint: parsed.consumerFingerprint,
      // A tab refresh while fetch was pending makes the outcome ambiguous.
      outcome: parsed.outcome === 'pending' ? 'ambiguous' : parsed.outcome,
    }
  } catch {
    return null
  }
}

function persistLiveRequest(record) {
  if (typeof window === 'undefined') throw new Error('实时请求只能从浏览器发起。')
  window.sessionStorage.setItem(LIVE_REQUEST_STORAGE_KEY, JSON.stringify({
    body: record.body,
    idempotencyKey: record.idempotencyKey,
    consumerFingerprint: record.consumerFingerprint,
    outcome: record.outcome,
  }))
}

function clearPersistedLiveRequest() {
  try {
    window.sessionStorage.removeItem(LIVE_REQUEST_STORAGE_KEY)
  } catch {
    // Fingerprint comparison still prevents a stale record from being replayed
    // under another consumer if browser storage becomes unavailable.
  }
}

function ambiguousLiveFailure(error) {
  if (AMBIGUOUS_LIVE_ERROR_CODES.has(error?.code)) return true
  return error?.status == null || error?.status === 0
}

function ProductOrb({ item, index, selected, onSelect }) {
  const position = ORB_POSITIONS[index % ORB_POSITIONS.length]
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
        <Package size={25} weight="duotone" aria-hidden="true" />
      </span>
      <span>{item.title || '未命名商品'}</span>
      <small>{priceLabel(item.pricing)}</small>
    </button>
  )
}

function ResultEvidence({ product, evidence }) {
  const mode = sourceModeEvidence(evidence?.sourceMode)
  if (!product) {
    return (
      <div className="mih-treasure-empty-evidence">
        <Cube size={30} weight="duotone" aria-hidden="true" />
        <strong>点一个商品球查看证据</strong>
        <p>这里展示 Hub 归一化属性，不暴露上游凭据或原始私有字段。</p>
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
  return (
    <section className="mih-treasure-call-evidence" aria-label="本次调用证据">
      <header><Fingerprint size={18} weight="duotone" aria-hidden="true" /><strong>本次交付证据</strong></header>
      <dl>
        <div><dt>交付模式</dt><dd><span className={`mih-treasure-mode mih-treasure-mode--${mode.tone}`}>{mode.label}</span></dd></div>
        <div><dt>Hub usage</dt><dd>{mode.hubUsage}</dd></div>
        <div><dt>上游调用</dt><dd>{mode.providerCall}</dd></div>
        <div><dt>Request ID</dt><dd>{evidence?.requestId || '等待请求'}</dd></div>
        <div><dt>数据年龄</dt><dd>{Number.isFinite(Number(evidence?.ageSeconds)) ? `${evidence.ageSeconds} 秒` : '—'}</dd></div>
      </dl>
      <p>{mode.note}</p>
    </section>
  )
}

export function EcommerceTreasureBoxPage({ notify }) {
  const keyInputRef = useRef(null)
  const requestEpochRef = useRef(0)
  const requestInFlightRef = useRef(false)
  const mountedRef = useRef(true)
  const verifiedConsumerFingerprintRef = useRef(null)
  const [lastLiveRequest, setLastLiveRequest] = useState(loadLiveRequest)
  const lastLiveRequestRef = useRef(lastLiveRequest)
  const [mode, setMode] = useState(() => lastLiveRequest?.outcome === 'ambiguous' ? 'hub_live' : 'safe_demo')
  const [marketplace, setMarketplace] = useState('taobao')
  const [sort, setSort] = useState('sales_desc')
  const [query, setQuery] = useState('便携相机')
  const [hubApiKey, setHubApiKey] = useState('')
  const [chargeConfirmed, setChargeConfirmed] = useState(false)
  const [phase, setPhase] = useState('idle')
  const [products, setProducts] = useState([])
  const [selected, setSelected] = useState(null)
  const [error, setError] = useState(() => lastLiveRequest?.outcome === 'ambiguous' ? {
    message: '检测到上次实时请求在完成前中断。请填写同一个 Hub consumer API Key，并使用原 Idempotency-Key 重试；不要创建新请求。',
  } : null)
  const [evidence, setEvidence] = useState(null)
  const [capabilityGroup, setCapabilityGroup] = useState('connected')

  const sortOptions = useMemo(() => availableSorts(mode, marketplace), [marketplace, mode])
  const activeCapability = CAPABILITY_GROUPS.find((group) => group.id === capabilityGroup) || CAPABILITY_GROUPS[0]
  const visibleProducts = products.slice(0, ORB_POSITIONS.length)
  const ambiguousRetryAvailable = mode === 'hub_live' && lastLiveRequest?.outcome === 'ambiguous'
  const resolvedReplayAvailable = mode === 'hub_live' && lastLiveRequest?.outcome === 'resolved'
  const semanticsLocked = phase === 'searching' || ambiguousRetryAvailable

  useEffect(() => {
    // React development StrictMode intentionally runs setup → cleanup → setup.
    // Restore the flag in setup so that the real mounted instance can finish
    // its request instead of remaining forever in the searching pose.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestEpochRef.current += 1
      requestInFlightRef.current = false
    }
  }, [])

  const rememberLiveRequest = (record, { failClosed = false } = {}) => {
    if (failClosed) persistLiveRequest(record)
    else {
      try {
        persistLiveRequest(record)
      } catch {
        // The pre-fetch `pending` record is already durable. Leaving that
        // version in storage makes a refresh conservatively recover it as an
        // ambiguous request rather than enabling a new paid dispatch.
      }
    }
    lastLiveRequestRef.current = record
    setLastLiveRequest(record)
  }

  const forgetLiveRequest = () => {
    clearPersistedLiveRequest()
    lastLiveRequestRef.current = null
    setLastLiveRequest(null)
    verifiedConsumerFingerprintRef.current = null
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
    if (semanticsLocked) return
    setMode(value)
    setSort(availableSorts(value, marketplace)[0]?.value || '')
    setError(null)
    setEvidence(null)
    setPhase('idle')
  }

  const changeMarketplace = (value) => {
    if (semanticsLocked) return
    setMarketplace(value)
    setSort(availableSorts(mode, value)[0]?.value || '')
    setProducts([])
    setSelected(null)
    setEvidence(null)
    setPhase('idle')
  }

  const revealResults = (items, nextEvidence) => {
    setProducts(items)
    setSelected(items[0] || null)
    setEvidence(nextEvidence)
    setPhase('presenting')
  }

  const runSafeDemo = async () => {
    const epoch = beginRequest()
    if (epoch == null) return
    await new Promise((resolve) => window.setTimeout(resolve, 760))
    if (!finishRequest(epoch)) return
    const candidates = demoProducts({ marketplace, query, sort })
    revealResults(candidates.slice(0, ORB_POSITIONS.length), {
      sourceMode: 'safe_demo',
      requestId: `demo-${crypto.randomUUID()}`,
      ageSeconds: 0,
    })
    notify?.('安全演示完成：没有访问 Hub Data API，也没有产生上游费用。', 'success')
  }

  const runLive = async ({ replay = false } = {}) => {
    const apiKey = hubApiKey.trim()
    if (!apiKey) {
      keyInputRef.current?.focus()
      setError({ message: '实时模式需要 Hub consumer API Key；这里不接受 JustOne 上游密钥。' })
      return
    }
    if (!replay && !chargeConfirmed) {
      setError({ message: '请先确认：新鲜缓存未命中时，这次请求可能触发一次 JustOne 计费调用。' })
      return
    }
    const previous = lastLiveRequestRef.current
    if (!replay && previous?.outcome === 'ambiguous') {
      setError({ message: '上一请求的结果仍不确定。为避免重复计费，只能使用原 Idempotency-Key 重试。' })
      return
    }
    const body = replay ? previous?.body : requestBody({ marketplace, query, sort })
    const idempotencyKey = replay ? previous?.idempotencyKey : `treasure-${crypto.randomUUID()}`
    if (!body || !idempotencyKey) return
    const epoch = beginRequest()
    if (epoch == null) return
    setError(null)
    try {
      const fingerprint = await consumerFingerprint(apiKey)
      if (!requestIsCurrent(epoch)) return
      if (replay && previous.consumerFingerprint !== fingerprint) {
        forgetLiveRequest()
        setChargeConfirmed(false)
        setPhase('idle')
        setError({ message: '当前 Hub API Key 与待重试请求的 consumer fingerprint 不一致，旧重放已失效。请重新确认后创建新请求。' })
        finishRequest(epoch)
        return
      }
      verifiedConsumerFingerprintRef.current = fingerprint
      const requestRecord = {
        body,
        idempotencyKey,
        consumerFingerprint: fingerprint,
        outcome: 'pending',
      }
      // This durable, secret-free request ledger must be committed before
      // fetch. If storage is unavailable, fail closed rather than risk losing
      // the only safe idempotency key after a paid dispatch.
      rememberLiveRequest(requestRecord, { failClosed: true })
      const result = await publicDataApi.ecommerceProductsSearch(apiKey, body, { idempotencyKey })
      if (!finishRequest(epoch)) return
      const nextEvidence = {
        ...result.evidence,
        sourceMode: result.payload?.meta?.sourceMode || result.evidence.sourceMode,
        requestId: result.payload?.requestId || result.evidence.requestId,
        ageSeconds: result.payload?.meta?.ageSeconds ?? result.evidence.ageSeconds,
      }
      revealResults(result.payload?.data?.items || [], nextEvidence)
      rememberLiveRequest({ ...requestRecord, outcome: 'resolved' })
      setChargeConfirmed(false)
      notify?.(`商品已交付 · ${sourceModeEvidence(nextEvidence.sourceMode).label}`, 'success')
    } catch (requestError) {
      if (!finishRequest(epoch)) return
      setPhase('idle')
      setChargeConfirmed(false)
      const pending = lastLiveRequestRef.current
      if (pending?.idempotencyKey === idempotencyKey && ambiguousLiveFailure(requestError)) {
        rememberLiveRequest({ ...pending, outcome: 'ambiguous' })
        setError({
          ...requestError,
          message: `${requestError?.message || '实时请求结果不确定'}。该调用可能已经产生费用，只能使用原 Idempotency-Key 重试。`,
        })
      } else {
        forgetLiveRequest()
        setError(requestError)
      }
    }
  }

  const submit = async (event) => {
    event.preventDefault()
    setError(null)
    if (!query.trim()) {
      setError({ message: '请输入要找的商品。' })
      return
    }
    if (mode === 'safe_demo') await runSafeDemo()
    else await runLive({ replay: ambiguousRetryAvailable })
  }

  const changeHubApiKey = (value) => {
    // Once a key has been verified against the stored fingerprint, editing it
    // invalidates that replay immediately. After a refresh the raw key is not
    // retained, so the first entered value is checked on submit instead.
    if (verifiedConsumerFingerprintRef.current && value !== hubApiKey) {
      forgetLiveRequest()
      setChargeConfirmed(false)
    }
    setHubApiKey(value)
    setError(null)
  }

  return (
    <section className="mih-treasure-page">
      <PageHeading
        eyebrow="DATA PRODUCT / JUSTONE CONNECTOR / GOVERNED DELIVERY"
        title="电商数据百宝箱"
        description="小聚替你从统一 Hub 合同中找商品；来源可以更换，调用、数据、计量与证据仍保持一致。"
      >
        <a className="qp-button qp-button--outline qp-button--sm" href={ECOMMERCE_DOCS_HREF} target="_blank" rel="noreferrer">接入文档<ArrowSquareOut size={15} aria-hidden="true" /></a>
      </PageHeading>

      <div className="mih-treasure-trust-strip" role="list" aria-label="产品边界">
        <span role="listitem"><ShieldCheck size={16} weight="duotone" aria-hidden="true" /><strong>稳定合同</strong><code>mx-insight-hub.ecommerce-products.v1</code></span>
        <span role="listitem"><ShoppingBagOpen size={16} weight="duotone" aria-hidden="true" /><strong>已核验</strong>5 个 marketplace</span>
        <span role="listitem"><Database size={16} weight="duotone" aria-hidden="true" /><strong>数据链路</strong>原始归档 → canonical → ES</span>
        <a href="#/source-catalog?section=catalog&catalogView=justone-connected"><ArrowRight size={15} aria-hidden="true" />查看目录标记</a>
      </div>

      <section className="qp-panel mih-treasure-lab">
        <form className="mih-treasure-controls" onSubmit={submit}>
          <header><MagicWand size={20} weight="duotone" aria-hidden="true" /><div><strong>告诉小聚你要什么</strong><small>先选安全演示，确认交互后再发实时请求。</small></div></header>
          <DropdownField label="获取方式" value={mode} options={MODE_OPTIONS} disabled={semanticsLocked} onChange={changeMode} />
          <DropdownField label="平台" value={marketplace} options={MARKETPLACES} disabled={semanticsLocked} onChange={changeMarketplace} />
          <DropdownField label="排序" value={sort} options={sortOptions} disabled={semanticsLocked || !(mode === 'safe_demo' ? SAFE_DEMO_SORTS : SORTS)[marketplace]} onChange={setSort} />
          <Field label="搜索词" hint="最多 200 个字符；翻页与改变筛选都属于新请求。">
            <span className="mih-treasure-query"><MagnifyingGlass size={17} aria-hidden="true" /><input className="qp-input" value={query} maxLength="200" disabled={semanticsLocked} onChange={(event) => setQuery(event.target.value)} placeholder="例如：便携相机" /></span>
          </Field>
          {mode === 'hub_live' ? (
            <div className="mih-treasure-live-auth">
              <Field label="Hub consumer API Key" hint="密钥仅在组件内存；会话中只保存不可逆 fingerprint 与精确重试参数。">
                <span className="mih-treasure-key"><Key size={17} aria-hidden="true" /><input ref={keyInputRef} className="qp-input" type="password" autoComplete="off" value={hubApiKey} disabled={phase === 'searching'} onChange={(event) => changeHubApiKey(event.target.value)} placeholder="mxk_…" /></span>
              </Field>
              <label className="mih-treasure-charge-confirm"><input type="checkbox" checked={chargeConfirmed} disabled={semanticsLocked} onChange={(event) => setChargeConfirmed(event.target.checked)} /><span><strong>确认可能产生一次上游计费</strong><small>缓存命中时不会新调上游；最终以右侧 sourceMode 证据为准。</small></span></label>
            </div>
          ) : null}
          <button className="qp-button qp-button--primary mih-treasure-search" type="submit" disabled={phase === 'searching'}>
            {phase === 'searching' ? <><Sparkle className="mih-spin" size={17} aria-hidden="true" />正在掏百宝袋</> : <><MagnifyingGlass size={17} aria-hidden="true" />{mode === 'safe_demo' ? '开始零费用演示' : ambiguousRetryAvailable ? '使用原 Idempotency-Key 重试' : '确认并搜索'}</>}
          </button>
          {resolvedReplayAvailable ? <button className="qp-button qp-button--ghost qp-button--sm" type="button" disabled={phase === 'searching'} onClick={() => runLive({ replay: true })}><ArrowClockwise size={15} aria-hidden="true" />重放上一精确请求 · 不新计费</button> : null}
          <p className="mih-treasure-auth-note"><LockKey size={15} aria-hidden="true" />上游 JustOne Key 只在“外部数据平台”管理，不会进入本页面或对外响应。</p>
        </form>

        <div className={`mih-treasure-stage mih-treasure-stage--${phase}`} aria-live="polite">
          <div className="mih-treasure-stage__halo" aria-hidden="true" />
          <span className="mih-treasure-stage__provider">当前适配器 <strong>JustOne</strong></span>
          {phase === 'presenting' ? (
            <div className="mih-treasure-speech">
              <strong>{evidence?.sourceMode === 'fresh_cache' ? '缓存里刚好有一份' : evidence?.sourceMode === 'stored_fallback' ? '先给你可靠的存档' : 'Here you are'}</strong>
              <small>{products.length ? `${products.length} 件归一化商品` : '这次没有找到可用商品'}</small>
            </div>
          ) : null}
          <img
            className="mih-treasure-mascot"
            src={phase === 'searching' ? SEARCHING_ASSET : PRESENTING_ASSET}
            alt={phase === 'searching' ? '原创数据百宝猫小聚正在从数据袋中搜索' : '原创数据百宝猫小聚张开双手展示商品'}
          />
          {phase === 'searching' ? <span className="mih-treasure-searching-copy"><i /><i /><i />正在检查授权、缓存与上游状态</span> : null}
          {phase === 'presenting' ? visibleProducts.map((item, index) => <ProductOrb key={`${item.marketplace}-${item.id}-${index}`} item={item} index={index} selected={selected?.id === item.id} onSelect={setSelected} />) : null}
          {phase === 'idle' ? <p className="mih-treasure-stage__welcome"><Sparkle size={17} weight="fill" aria-hidden="true" />我会先找 Hub 已有数据，需要时才去上游。</p> : null}
        </div>

        <aside className="mih-treasure-inspector">
          <ResultEvidence product={selected} evidence={evidence} />
          <CallEvidence evidence={evidence} />
        </aside>
      </section>

      {error ? <ErrorState error={error} /> : null}

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
        <header className="mih-treasure-section__header"><div><p className="qp-kicker">ONE ENDPOINT / DIFFERENT DELIVERY</p><h2>一次调用，四种真实交付路径</h2><p>Hub 客户计量与 JustOne 上游费用是两本账，不能用一个数字代替。</p></div></header>
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
          <a href="#/api-keys"><Key size={18} weight="duotone" aria-hidden="true" /><span><strong>准备 Hub API Key</strong><small>签发给明确 consumer，并授予 ecommerce</small></span><ArrowRight size={16} aria-hidden="true" /></a>
          <a href={ECOMMERCE_DOCS_HREF} target="_blank" rel="noreferrer"><Coins size={18} weight="duotone" aria-hidden="true" /><span><strong>交给其他系统调用</strong><small>稳定请求、响应、分页与错误合同</small></span><ArrowRight size={16} aria-hidden="true" /></a>
        </div>
      </section>
    </section>
  )
}
