import { nativeForwardingByPath } from './native-forwarding.mjs'
import { hubSocialByPath } from './hub-social.mjs'
import { QIXIN_CATALOG } from './enterprise.mjs'
import { customerRequestPrice } from '../billing/contracts.mjs'
const enterprises = new Set(QIXIN_CATALOG.apis.map(api => api.api_id))
export function servicePriceDefinition(path) {
  const social = hubSocialByPath(path)
  if (social) return { platform:social.platform, capabilities:[social.operation], meterKey:social.operation }
  const native = nativeForwardingByPath(path)
  if (native) return { platform:native.authorizationPlatform, capabilities:[native.operation], meterKey:native.operation }
  const enterprise = /^\/api\/v1\/data\/enterprise\/([0-9]+\.[0-9]+)\/query$/.exec(path)
  if (enterprise && enterprises.has(enterprise[1])) return { platform:'enterprise', capabilities:['enterprise.query'], meterKey:`enterprise.api.${enterprise[1]}` }
  if (path === '/api/v1/data/ip/risk' || path === '/api/v1/data/ip/risk/batch') return { platform:'ip_risk', capabilities:['ip.risk.query'], meterKey:'ip.risk.query', unit:'ip' }
  if (path === '/api/v1/data/ecommerce/products/search') return { platform:'ecommerce', capabilities:['ecommerce.products.search'], meterKey:'ecommerce.products.search' }
  return null
}
export function customerServiceQuote(path, definition, plan, profile) {
  const price = customerRequestPrice(plan?.priceBook, profile, definition.meterKey)
  const entry = plan?.priceBook?.entries.find(row => row.meterKey === definition.meterKey)
  return { contractVersion:'mx-insight-hub.service-pricing.v1', path, currency:price.currency,
    hubPrice:{ label:'Hub 官方定价', scope:'current_price_book', published:Boolean(entry), unitPriceMinor:entry?.unitPriceMinor ?? null },
    accountPrice:{ unitPriceMinor:profile?.mode === 'enforced' ? price.quotedMinor : 0,
      configuredUnitPriceMinor:price.quotedMinor, status:profile?.mode !== 'enforced' ? 'billing_disabled' : entry ? 'contract' : 'account_default',
      multiplierPpm:entry ? price.multiplierPpm : null },
    billingUnit:definition.unit || 'request', planVersionId:plan?.versionId || null,
    observedAt:new Date().toISOString(), estimateOnly:true, dispatches:0,
    notice:'Hub 官方定价取自当前已发布价格表；账户执行价按当前合同与计费状态计算。未发布单价不代表免费；查询不锁价，发送时重新校验。' }
}
