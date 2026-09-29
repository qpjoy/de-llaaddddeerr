import { createHash } from 'node:crypto'
import { HUB_SOCIAL_ENDPOINTS } from '../contracts/hub-social.mjs'
import { EXTERNAL_PLATFORM_OPERATION_CATALOG } from '../external-platforms/control-store.mjs'
import { NATIVE_FORWARDING_ENDPOINTS } from '../contracts/native-forwarding.mjs'
import { implementedRoutes } from '../data/source-connections.mjs'
import { QIXIN_OFFICIAL_PRICES } from '../../shared/qixin-official-prices.mjs'
import tikPrices from '../data/tikhub-reference-prices.json' with { type: 'json' }

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const native = new Map(NATIVE_FORWARDING_ENDPOINTS.map(row => [row.operation, row]))
const routes = implementedRoutes()
export const PROVISIONING_OPERATIONS = Object.entries(EXTERNAL_PLATFORM_OPERATION_CATALOG).flatMap(([provider, definitions]) => definitions.map(definition => {
  const operation = definition.operationKey
  const endpoint = native.get(operation)
  const matches = routes.filter(row => row.provider === provider && row.operation === operation)
  const enterprise = provider === 'qixin'
  const platform = endpoint?.authorizationPlatform || Object.values(HUB_SOCIAL_ENDPOINTS).find(row => row.operation === operation)?.platform || (enterprise ? 'enterprise' : operation.startsWith('ecommerce.') ? 'ecommerce' : operation === 'social.accounts.search' ? 'social' : 'xiaohongshu')
  return { id: `${provider}:${operation}`, provider, operation, label: definition.label,
    platform, capability: enterprise ? 'enterprise.query' : operation, meterKey: operation,
    contractVersion: definition.contractVersion, endpointKeys: [...definition.endpointKeys],
    blocked: definition.dispatchBlock || null, allowZeroCost: definition.allowZeroCost === true,
    products: [...new Set(matches.map(row => row.product))],
    catalogKeys: [...new Set(matches.flatMap(row => row.catalogKeys || []))],
    paths: endpoint ? [endpoint.hubPath] : [...new Set(matches.map(row => row.path))],
    scopeNote: enterprise ? '企业查询沿用整体 enterprise.query 授权；选择部分接口只限制本批定价与运行配置，不是 Key 的企业端点白名单。' : null,
  }
}))
export const PROVISIONING_CATALOG_VERSION = digest(PROVISIONING_OPERATIONS)
export const provisioningOperation = id => PROVISIONING_OPERATIONS.find(row => row.id === id)

export function officialPriceDraft(provider) {
  if (provider === 'tikhub') {
    const prices = new Map(tikPrices.rows.map(row => [row.path,row.unitPrice]))
    return { provider, available:true, sourceKind:'official', sourceUrl:tikPrices.sourceUrl, observedAt:tikPrices.observedAt,
      name:'TikHub 新账户逐接口参考价（部分核验）',
      rates:NATIVE_FORWARDING_ENDPOINTS.filter(row=>row.provider===provider && !row.key.startsWith('wechat.') && prices.has(row.path)).map(row=>({
        endpointKey:row.endpointKey,currency:tikPrices.currency,unitPrice:prices.get(row.path),billingUnit:'request',
      })) }
  }
  if (provider !== 'qixin') return { provider, available: false, reason: '尚无已核对的逐端点官方价格快照；可导入带来源的价格草稿，不能推测为统一价格。' }
  return { provider, available: true, sourceKind: 'official', sourceUrl: QIXIN_OFFICIAL_PRICES.source.split('?')[0],
    observedAt: QIXIN_OFFICIAL_PRICES.observedAt, name: '企业接口官方价格快照',
    rates: PROVISIONING_OPERATIONS.filter(row => row.provider === provider).flatMap(row => {
      const price = QIXIN_OFFICIAL_PRICES.entries.find(entry => `enterprise.api.${entry.apiId}` === row.operation)
      return price?.unitPriceMinor == null ? [] : row.endpointKeys.map(endpointKey => ({ endpointKey,
        currency: 'CNY', unitPrice: (price.unitPriceMinor / 100).toFixed(2), billingUnit: 'request' }))
    }) }
}

// Separate draft: a dated WeChat documentation price must not inherit the older
// account snapshot's URL/time or silently overwrite an operator's reviewed rate.
export function wechatOfficialPriceDraft() {
  const rows = NATIVE_FORWARDING_ENDPOINTS.filter(row => row.key.startsWith('wechat.'))
  return { provider: 'tikhub', name: '微信官方文档逐接口参考价（2026-09-29）', sourceKind: 'official',
    sourceUrl: rows[0].procurementReference.sourceUrl, observedAt: rows[0].procurementReference.observedAt,
    rates: rows.map(row => ({ endpointKey: row.endpointKey, currency: row.procurementReference.currency,
      unitPrice: row.procurementReference.unitPrice, billingUnit: 'request' })) }
}
