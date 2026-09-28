import { AppError } from '../core/errors.mjs'
import { PROVISIONING_OPERATIONS } from './catalog.mjs'

const fail = message => { throw new AppError(400, 'invalid_price_draft', message) }
// Preserve the exact decimal reference independently of the legacy integer
// procurement budget ledger. That ledger is explicitly a conservative estimate.
export function procurementAmount(value, currency) {
  if (!['CNY', 'USD', 'EUR', 'GBP', 'HKD'].includes(currency)) fail('价格草稿目前支持 CNY/USD/EUR/GBP/HKD；其他币种须先定义最小单位')
  if (typeof value !== 'string' || !/^\d{1,9}(?:\.\d{1,6})?$/.test(value)) fail('单价须为最多六位小数的非负十进制字符串')
  const [integer, fraction = ''] = value.split('.')
  const micros = BigInt(integer) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))
  const budgetMinor = Number((micros + 9_999n) / 10_000n)
  return { unitPrice: `${BigInt(integer)}${fraction ? `.${fraction.replace(/0+$/, '')}` : ''}`.replace(/\.$/, ''),
    currency, scale: 6, amountMicros: micros.toString(), budgetMinor, rounded: micros % 10_000n !== 0n }
}

export function normalizePriceDraft(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['provider', 'name', 'sourceKind', 'sourceUrl', 'observedAt', 'rates'].includes(key))) fail('价格草稿字段无效')
  if (!['qixin', 'justone', 'tikhub', 'rapidapi'].includes(input.provider)) fail('供应商不支持逐接口采购策略')
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 128) fail('请填写草稿名称')
  if (!['official', 'contract', 'manual'].includes(input.sourceKind)) fail('请选择官方参考、账户合同或人工估价')
  let source
  try { source = new URL(input.sourceUrl) } catch { fail('请填写价格证据的 HTTP(S) 链接') }
  if (!['https:', 'http:'].includes(source.protocol) || source.username || source.password || source.search || source.hash) fail('证据链接不可包含凭据、查询参数或片段')
  if (typeof input.observedAt !== 'string' || !Number.isFinite(Date.parse(input.observedAt))) fail('价格观察时间无效')
  if (!Array.isArray(input.rates) || !input.rates.length || input.rates.length > 1000) fail('请提供 1–1000 项端点价格')
  const endpoints = new Set(PROVISIONING_OPERATIONS.filter(row => row.provider === input.provider).flatMap(row => row.endpointKeys))
  const seen = new Set()
  const rates = input.rates.map(row => {
    if (!row || Object.keys(row).some(key => !['endpointKey', 'currency', 'unitPrice', 'billingUnit'].includes(key))
      || !endpoints.has(row.endpointKey) || seen.has(row.endpointKey) || row.billingUnit !== 'request') fail('端点重复、未实现或计量单位不支持')
    seen.add(row.endpointKey)
    return { endpointKey: row.endpointKey, billingUnit: 'request', ...procurementAmount(row.unitPrice, row.currency) }
  }).sort((a, b) => a.endpointKey.localeCompare(b.endpointKey))
  return { provider: input.provider, name: input.name.trim(), sourceKind: input.sourceKind, sourceUrl: source.href,
    observedAt: new Date(input.observedAt).toISOString(), rates, costBasis: 'reference_decimal_and_conservative_minor_budget' }
}
