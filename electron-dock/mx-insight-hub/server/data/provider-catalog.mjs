import official from './provider-official-contracts.json' with { type: 'json' }
import { NATIVE_FORWARDING_ENDPOINTS } from '../contracts/native-forwarding.mjs'
import { PROVIDER_CATALOG_ADDITIONS } from './provider-catalog-additions.mjs'
import tikPrices from './tikhub-reference-prices.json' with { type: 'json' }

// Explicit platform identities, not substring matches against editable labels.
const DIRECTORY = {
  douyin:['0001'], kuaishou:['0002'], wechat_channels:['0003'], 'weixin-channels':['0003'],
  xiaohongshu:['0004'], 'xiaohongshu-pgy':['0004'], weibo:['0005'], bilibili:['0006'], zhihu:['0007'],
  douban:['0009'], toutiao:['0010'], xigua:['0011'], wechat_mp:['0025'], weixin:['0025'], wechat_search:['0026'],
  taobao:['0058','0059'], jd:['0060'], 'douyin-ec':['0062'], 'xiaohongshu-ec':['0064'], '1688':['0069'], xianyu:['0073'],
  tiktok:['0085'], twitter:['0086'], instagram:['0087'], facebook:['0088'], youtube:['0089'], reddit:['0090'],
  linkedin:['0091'], threads:['0092'], amazon:['0108'], aliexpress:['0110'], shopee:['0114'], 'tiktok-shop':['0126'], telegram:['0160','0161'],
}
export const providerCatalogKeys = platform => DIRECTORY[platform] ? DIRECTORY[platform].map(id => `source-catalog-${id}`)
  : PROVIDER_CATALOG_ADDITIONS.some(row=>row.sourceKey===`source-platform-${platform}`) ? [`source-platform-${platform}`] : []

export function officialProviderCatalog(operations = []) {
  const referencePrices = new Map(tikPrices.rows.map(row=>[row.path,row.unitPrice]))
  const native = new Map(NATIVE_FORWARDING_ENDPOINTS.map(row => [`${row.provider}:${row.method}:${row.path}`,row]))
  const policies = new Map(operations.map(row => [`${row.provider}:${row.operation}`,row.current]))
  const rows = official.endpoints.map(row => {
    const endpoint = native.get(`${row.provider}:${row.method}:${row.path}`)
    const policy = endpoint && policies.get(`${row.provider}:${endpoint.operation}`)
    return { provider:row.provider, platform:row.platform, label:row.platformLabel || row.platform,
      summary:row.summary, method:row.method, sourcePath:row.path, sourceUrl:row.sourceUrl,
      catalogKeys:providerCatalogKeys(row.platform), documented:true, hubPath:endpoint?.hubPath || null,
      operation:endpoint?.operation || null, implementation:endpoint ? 'fixed_contract' : 'documented_only',
      reason:endpoint ? null : row.reason, effectiveState:policy?.effectiveState || 'not_checked',
      priceReviewed:policy?.priceBook?.source === 'database' && policy?.priceBook?.status === 'reviewed' && policy?.priceBook?.ready === true,
      procurementReference:row.provider === 'tikhub' && referencePrices.has(row.path) ? {currency:tikPrices.currency,unitPrice:referencePrices.get(row.path),sourceUrl:tikPrices.sourceUrl,observedAt:tikPrices.observedAt} : null,
      runtimeStatus:'not_checked' }
  })
  return { version:official.version, observedAt:official.observedAt, rows,
    summary:['tikhub','justone'].map(provider => { const items=rows.filter(row=>row.provider===provider); return {
      provider, documented:items.length, platforms:new Set(items.map(row=>row.platform)).size,
      implemented:items.filter(row=>row.hubPath).length, active:items.filter(row=>row.effectiveState==='active').length,
      canary:items.filter(row=>row.effectiveState==='canary').length,
      unmappedPlatforms:[...new Set(items.filter(row=>!row.catalogKeys.length).map(row=>row.platform))],
    } }), collection:official.collection }
}
