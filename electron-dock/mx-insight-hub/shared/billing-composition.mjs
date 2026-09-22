import { QIXIN_OFFICIAL_PRICES } from './qixin-official-prices.mjs'
const XHS_V1 = { key: 'xiaohongshu', version: 1, name: '小红书笔记', currency: 'CNY',
  entries: ['social.posts.search', 'social.posts.resolve', 'social.users.resolve', 'social.users.posts']
    .map(meterKey => ({ meterKey, unitPriceMinor: 10, billingUnit: 'request' })) }
export const BILLING_FEATURES = [
  {
    key: 'qixin', version: QIXIN_OFFICIAL_PRICES.version, name: '启信宝真实价格套餐', currency: 'CNY',
    pricingAsOf: QIXIN_OFFICIAL_PRICES.observedAt, source: QIXIN_OFFICIAL_PRICES.source,
    entries: QIXIN_OFFICIAL_PRICES.entries.filter(entry => entry.unitPriceMinor !== null)
      .map(entry => ({ meterKey: `enterprise.api.${entry.apiId}`, unitPriceMinor: entry.unitPriceMinor, billingUnit: 'request' })),
  },
  {
    key: 'ip-risk', version: 1, name: 'IP 风险画像', currency: 'CNY',
    entries: [{ meterKey: 'ip.risk.query', unitPriceMinor: 5, billingUnit: 'request' }],
  },
  {
    key: 'xiaohongshu', version: 2, name: '小红书笔记画卷', currency: 'CNY',
    entries: ['social.posts.search', 'social.posts.resolve', 'social.users.resolve', 'social.users.posts', 'social.posts.analytics', 'social.comments.list']
      .map(meterKey => ({ meterKey, unitPriceMinor: 10, billingUnit: 'request' })),
  },
]

// Flatten once at publication. Explicit editor entries are the entire final table,
// not a patch: deleting an inherited meter must not silently put it back.
export function compileBillingComponents(components, plans, currency, finalEntries = []) {
  if (!Array.isArray(components) || components.length > 32) throw new Error('套餐组合最多包含 32 项')
  const rates = new Map()
  const sources = []
  const conflicts = new Set()
  const seen = new Set()
  for (const component of components) {
    let source, id, reference
    if (component?.type === 'feature' && Object.keys(component).every(key => ['type', 'key', 'version', 'multiplierPpm'].includes(key))) {
      source = [...BILLING_FEATURES, XHS_V1].find(item => item.key === component.key && item.version === component.version)
      id = `feature:${component.key}:${component.version}`
      if (source) reference = { type: 'feature', key: source.key, version: source.version, name: source.name }
    } else if (component?.type === 'plan' && Object.keys(component).every(key => ['type', 'versionId'].includes(key))) {
      const plan = plans.find(item => item.versionId === component.versionId && item.versionStatus === 'published' && item.priceBook)
      if (plan) {
        source = plan.priceBook
        reference = { type: 'plan', key: plan.key, versionId: plan.versionId, version: plan.version, name: plan.name }
      }
      id = `plan:${component.versionId}`
    }
    if (!source) throw new Error('套餐来源不存在、未发布或没有费率')
    if (seen.has(id)) throw new Error('同一套餐来源不能重复选择')
    seen.add(id)
    if (source.currency !== currency) throw new Error('不能组合不同币种的套餐')
    const multiplier = component.multiplierPpm ?? 1_000_000
    if (!Number.isSafeInteger(multiplier) || multiplier < 0 || multiplier > 100_000_000) throw new Error('产品倍率必须为 0–100 倍的整数 ppm')
    if (Object.hasOwn(component, 'multiplierPpm')) reference.multiplierPpm = multiplier
    if (source.pricingAsOf) { reference.pricingAsOf = source.pricingAsOf; reference.source = source.source }
    sources.push(reference)
    for (const entry of source.entries) {
      const scaled = (BigInt(entry.unitPriceMinor) * BigInt(multiplier) + 999_999n) / 1_000_000n
      if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('调整后的价格超出安全整数范围')
      const adjusted = { ...entry, unitPriceMinor: Number(scaled) }
      const previous = rates.get(entry.meterKey)
      if (previous && (previous.unitPriceMinor !== adjusted.unitPriceMinor
        || (previous.billingUnit || 'request') !== (entry.billingUnit || 'request'))) conflicts.add(entry.meterKey)
      rates.set(entry.meterKey, adjusted)
    }
  }
  if (finalEntries.length) return { entries: finalEntries.map(entry => ({ ...entry })), components: sources }
  if (conflicts.size) throw new Error(`重复接口存在费率冲突，请显式填写最终价格：${[...conflicts].join(', ')}`)
  return { entries: [...rates.values()].sort((a, b) => a.meterKey.localeCompare(b.meterKey)), components: sources }
}
