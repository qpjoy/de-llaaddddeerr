import { AppError } from '../core/errors.mjs'
import { productForPath } from '../../shared/product-workbenches.mjs'
import { WECHAT_PRODUCTS } from '../../shared/wechat.mjs'
import { XIAOHONGSHU_ANALYTICS_METERS } from '../../shared/product-catalog.mjs'
import { PROVISIONING_OPERATIONS, officialPriceDraft, wechatOfficialPriceDraft } from '../commercial/catalog.mjs'
import { customerRequestPrice } from '../billing/contracts.mjs'
import { TIKHUB_CONTENT_SEARCH_RECIPES } from '../contracts/tikhub-content-search.mjs'

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const social = row => row.operation.startsWith('social.') || row.platform === 'social'
const names = { qixin: '启信宝', tikhub: 'TikHub', justone: 'JustOne', rapidapi: 'RapidAPI',
  ipsearch: 'IPSearch', 'baidu-ip': '百度 IP v2' }
const referencePrices = new Map()
for (const source of [officialPriceDraft('qixin'), officialPriceDraft('tikhub'), wechatOfficialPriceDraft()]) {
  for (const rate of source.rates || []) referencePrices.set(`${source.provider}:${rate.endpointKey}`, {
    endpointKey: rate.endpointKey, unitPrice: rate.unitPrice, currency: rate.currency,
    billingUnit: rate.billingUnit, sourceUrl: source.sourceUrl, observedAt: source.observedAt,
    actualChargeVerified: false,
  })
}
const accountMeters = [
  { meterKey: 'social.content.crawl', label: 'Hub 账号内容', paths: ['/api/v1/data/social/crawl'] },
  { meterKey: 'social.profile.get', label: 'Hub 账号资料', paths: ['/api/v1/data/social/user-info'] },
]

// This inventory describes management scope, never a route or a grant. A
// provider shared by two products must retain the same admission policy.
export function productManagementOperations(path) {
  const product = productForPath(path)
  if (!product) throw new AppError(404, 'data_product_not_found', 'Unknown data product')
  const wechat = WECHAT_PRODUCTS.find(row => path === `/data-products/${row.key}`)
  let predicate = row => row.products.includes(product.label)
  if (path.endsWith('/enterprise')) predicate = row => row.provider === 'qixin'
  else if (path.endsWith('/ecommerce-treasure-box') || path.endsWith('/virtual-supermarket')) predicate = row => row.platform === 'ecommerce'
  else if (path.endsWith('/web-search')) predicate = row => row.operation === 'web.search'
  else if (wechat) predicate = row => row.operation.startsWith(`native.wechat.${wechat.group}.`) || wechat.group === 'mp' && row.operation.startsWith('native.wechat.demo.')
  else if (['/data-products/strategy-search', '/data-products/social-content', '/data-products/search'].includes(path)) predicate = social
  return { product, operations: PROVISIONING_OPERATIONS.filter(predicate).map(row => ({ ...row,
    paths: row.provider === 'qixin' ? [`/api/v1/data/enterprise/${row.operation.slice('enterprise.api.'.length)}/query`] : row.paths,
  })) }
}

function priceMeters(product, operations) {
  const definitions = new Map(operations.map(row => [row.meterKey, {
    meterKey: row.meterKey, label: row.label, paths: row.paths, billingUnit: 'request',
  }]))
  if (['/data-products/strategy-search', '/data-products/search'].includes(product.path)) {
    // Standard content search bills by platform; its native acquisition
    // operation has a different meter. Never display a native quote as the
    // standard data/search price or multiply it by guessed upstream pages.
    for (const platform of [...new Set(['twitter', 'facebook', 'instagram', 'weibo', ...Object.keys(TIKHUB_CONTENT_SEARCH_RECIPES)])]) {
      definitions.set(platform, { meterKey: platform, label: `标准内容搜索 · ${platform}`,
        paths: ['/api/v1/data/search'], billingUnit: 'request' })
    }
    definitions.set('raw', { meterKey: 'raw', label: '历史关键词搜索 · 非小红书',
      paths: ['/api/v1/search/raw', '/api/v1/night-all/search/raw'], billingUnit: 'request' })
  }
  if (['/data-products/strategy-search', '/data-products/social-content', '/data-products/search'].includes(product.path)) {
    for (const row of accountMeters) definitions.set(row.meterKey, { ...row, billingUnit: 'request' })
  }
  if (product.path.endsWith('/xiaohongshu-note')) {
    for (const row of XIAOHONGSHU_ANALYTICS_METERS) definitions.set(row.key, {
      meterKey: row.key, label: row.label || row.key, paths: [row.path], billingUnit: 'request',
    })
  }
  if (product.path.endsWith('/ip-risk')) {
    definitions.set('ip.risk.query', { meterKey: 'ip.risk.query', label: 'IP 风险画像 · 按次',
      paths: ['/api/v1/data/ip/risk'], billingUnit: 'ip' })
    definitions.set('ip.risk.subscription.v2', { meterKey: 'ip.risk.subscription.v2', label: 'IP 风险画像 · 订阅权益',
      paths: ['/api/v1/data/ip/risk/v2'], billingUnit: 'ip', subscription: true })
  }
  return [...definitions.values()]
}

function quote(row, selection) {
  const base = { ...row, currency: null, unitPriceMinor: null, configuredUnitPriceMinor: null,
    multiplierPpm: null, planVersionId: selection?.plan?.versionId || null }
  if (row.subscription) return { ...base, status: 'subscription' }
  if (!selection) return { ...base, status: 'select_consumer' }
  const { plan, billing } = selection
  if (!plan || plan.status !== 'active' || plan.versionStatus !== 'published' || !billing?.profile) {
    return { ...base, status: 'plan_unavailable' }
  }
  const price = customerRequestPrice(plan.priceBook, billing.profile, row.meterKey)
  const entry = plan.priceBook?.entries?.find(item => item.meterKey === row.meterKey)
  return { ...base, currency: price.currency, configuredUnitPriceMinor: price.quotedMinor,
    unitPriceMinor: billing.profile.mode === 'enforced' ? price.quotedMinor : 0,
    multiplierPpm: entry ? price.multiplierPpm : null,
    status: billing.profile.mode !== 'enforced' ? 'billing_disabled' : entry ? 'contract' : 'account_default' }
}

export async function readProductManagement({ path, consumerId, store, platformAdmin, admissionPolicies }) {
  const { product, operations } = productManagementOperations(path)
  if (consumerId && !uuid(consumerId)) throw new AppError(400, 'invalid_consumer_id', 'A valid consumer ID is required')
  const consumers = (await store.listConsumers()).map(({ id, name, tenantId, status }) => ({ id, name, tenantId, status }))
  let selection = null
  if (consumerId) {
    const consumer = consumers.find(row => row.id === consumerId)
    if (!consumer) throw new AppError(404, 'consumer_not_found', 'Consumer not found')
    const [plan, billing] = await Promise.all([store.getConsumerPlan(consumerId), store.getTenantBilling(consumer.tenantId, { ledgerLimit: 0 })])
    selection = { consumer, plan, billing }
  }
  const keys = [...new Set(operations.map(row => row.provider))]
  if (product.path.endsWith('/ip-risk')) keys.push('ipsearch', 'baidu-ip')
  const providers = await Promise.all(keys.map(async key => {
    const definitions = operations.filter(row => row.provider === key)
    let views = [], error = null, admission = null
    if (definitions.length) {
      try {
        const context = await platformAdmin.provisioningContext(key)
        const all = await context.control.describeProvider(key, context.runtime)
        views = all.filter(row => definitions.some(definition => definition.operation === row.operationKey))
          .map(row => {
            const definition = definitions.find(definition => definition.operation === row.operationKey)
            return { ...row, paths: definition.paths,
              procurementReferences: definition.endpointKeys.flatMap(endpoint => referencePrices.get(`${key}:${endpoint}`) || []) }
          })
      } catch {
        // Never expose credential/runtime objects or raw database errors.
        error = { code: 'product_operations_unavailable', message: '当前接口运行与采购价格信息不可用，请检查服务运行配置。' }
      }
    }
    try { admission = admissionPolicies ? await admissionPolicies.read(key) : null }
    catch { error ||= { code: 'admission_policy_unavailable', message: '当前限速配置不可用，请刷新后再操作。' } }
    return { key, label: names[key] || key, admission, operations: views, error }
  }))
  const notes = [
    '限频由同一供应商的所有产品共享；并发是每个网关实例的容量，不是集群总并发。修改会影响其他使用此供应商的产品。',
    '上游价格按实际供应商调用计算，下游价格按业务计费项计算；一次业务查询可能对应多次上游调用，不直接相减推算利润，也不换算币种。',
    '运行价目表中的最小货币单位用于采购预算估算，可能向上取整；官方参考价保留原始小数和观察日期，二者都不是本次供应商实际扣费。实扣请查使用记录。',
    '价格仅供当前配置核对，不代表已授权或可调用；发送时重新校验套餐、Key、余额及运行状态。查看页面、刷新和保存设置不会采集数据。',
    'LCY-delta 已开启的 Hub 限制豁免继续适用；供应商实际限流、已购额度、计费及未知结果保护不由本页的速率设置解除。',
  ]
  if (keys.includes('rapidapi')) notes.push('Facebook RapidAPI 已购额度和单笔派发记账顺序继续生效；这里调整普通网关并发不改变该账本。')
  if (keys.includes('tikhub')) notes.push('小红书 PGY 有独立的共享派发队列、去重与未知结果保护；普通网关设置不会改写专用队列。')
  if (product.path.endsWith('/ip-risk')) notes.push('IP 外层 Hub 限速与百度渠道的每日额度、最小间隔和冷却分别生效；订阅价格和权益在 IP 商品/订阅管理中查看。')
  if (!keys.length) notes.push('此产品以已收录或派生数据为主，暂无可配置的供应商采集限速；下方保留现有治理工具入口。')
  return { product: { path: product.path, label: product.label }, observedAt: new Date().toISOString(), consumers,
    customer: selection ? { consumerId, tenantId: selection.consumer.tenantId, name: selection.consumer.name,
      planVersionId: selection.plan?.versionId || null, planStatus: selection.plan?.status || null,
      billingMode: selection.billing?.profile?.mode || null } : null,
    providers, customerPrices: priceMeters(product, operations).map(row => quote(row, selection)), notes }
}
