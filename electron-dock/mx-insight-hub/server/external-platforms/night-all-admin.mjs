import { AppError } from '../core/errors.mjs'
import { NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS } from '../contracts/night-all-legacy.mjs'

const RANGES = { '24h': 86400000, '7d': 604800000, '30d': 2592000000 }
const LABELS = { raw: '关键词内容搜索', crawl: '账号内容采集', 'user-info': '账号资料' }
export const NIGHT_ALL_COMMERCIAL_OPERATIONS = Object.keys(LABELS).map(operation => ({
  operationKey: operation, label: LABELS[operation], meterKey: operation,
  publicPath: `/api/v1/night-all/search/${operation}`, aliasPath: `/api/v1/search/${operation}`,
  upstreamPath: `/api/v1/search/${operation}`, upstreamUnitCostMinor: 0,
  billingUnit: 'request', platforms: NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS[operation],
}))

// These are logical requests with recorded connector evidence, not transport
// attempts. Preflight failures and replay HTTP traffic have no connector row.
export class NightAllPlatformAdminService {
  providerKey = 'night-all'
  constructor({ store, config, clock = () => new Date() }) { this.store = store; this.config = config; this.clock = clock }
  async overview(range = '7d') {
    const detail = await this.detail(this.providerKey, range)
    return { contractVersion: detail.contractVersion, range, generatedAt: detail.generatedAt, providers: [detail.provider] }
  }
  async detail(providerKey, range = '7d') {
    if (providerKey !== this.providerKey) throw new AppError(404, 'external_platform_not_found', 'External platform not found')
    if (!Object.hasOwn(RANGES, range)) throw new AppError(400, 'invalid_range', 'Range must be 24h, 7d or 30d')
    const now = this.clock()
    const rows = await this.store.nightAllAnalytics({ since: new Date(now.getTime() - RANGES[range]).toISOString(), until: now.toISOString() })
    const sum = key => rows.reduce((total, row) => total + Number(row[key] || 0), 0)
    const upstreamCalls = sum('upstreamCalls'), successfulHubRequests = sum('successfulHubRequests'), hubRequests = sum('hubRequests')
    const successfulUpstreamCalls = sum('successfulUpstreamCalls')
    const metrics = { hubRequests, successfulHubRequests, upstreamCalls, successfulUpstreamCalls,
      usableUpstreamCalls: sum('usableUpstreamCalls'), unknownOutcomes: sum('unknownOutcomes'),
      hubSuccessRate: hubRequests ? successfulHubRequests / hubRequests : null,
      upstreamSuccessRate: upstreamCalls ? successfulUpstreamCalls / upstreamCalls : null,
      billedCalls: 0, knownCostMinor: 0, unknownCostCalls: 0,
      avoidedUpstreamCalls: null, indeterminateBillingCalls: 0,
    }
    const billing = { currency: 'CNY', pricingSource: 'internal_service_zero_transfer_price',
      actualCostMinor: 0, grossEstimatedCostMinor: 0, unitPrices: NIGHT_ALL_COMMERCIAL_OPERATIONS.map(op => ({ endpointKey: op.operationKey, unitCostMinor: 0 })),
      recommendation: '仅表示 Night-All 对 Hub 的服务转移价为 0；不代表其内部供应商采购或基础设施免费。客户收费由 Hub 租户套餐独立确定。' }
    const provider = { key: this.providerKey, displayName: 'Night-All', configured: Boolean(this.config.baseUrl),
      status: 'unknown', description: '内部数据服务；统计已记录的逻辑请求，不含预检拒绝及重放 HTTP 次数。关键词搜索、账号内容和账号资料。',
      metrics, billing, lastObservedAt: rows.map(row => row.lastObservedAt).filter(Boolean).sort().at(-1) || null }
    return { contractVersion: 'mx-insight-hub.external-platform-admin.v1', range, generatedAt: now.toISOString(), provider,
      commercialOperations: NIGHT_ALL_COMMERCIAL_OPERATIONS, endpointStatistics: rows,
      customerBilling: { planPath: '#/plans', unit: 'request', modes: ['disabled', 'shadow', 'enforced'],
        note: '套餐分别设置 raw / crawl / user-info 单价（可为 0），分配给调用身份；租户计费模式决定是否实际扣款。相同幂等请求重放不重复收费。小红书直连分支使用 social.* 计费键。' },
      notes: { scope: '统计已留存的逻辑请求和调用证据，不包含预检拒绝、重放 HTTP 次数、data/search、回填或小红书直连。状态未知不代表故障，也不代表实时健康。',
        budget: '工作预算与费率独立。免费不会跳过权限、页大小、工作量限制或未知结果恢复。采集总预算 maxCrawlWork 可在开放能力中按调用身份与平台配置（1–5000，默认 100），单页最多 100 的限制仍生效。',
        fallback: 'Night-All 不确定结果或 502/503/504 可读取 Hub 精确快照；快照成功交付沿用既有客户请求计费语义。',
        connection: '连接与服务凭据仍由部署配置管理，不在此显示或迁移密钥。' },
    }
  }
  updateCredential() { throw new AppError(409, 'deployment_managed', 'Night-All connection credentials are deployment-managed') }
  revealCredential() { throw new AppError(409, 'deployment_managed', 'Night-All service credentials cannot be revealed here') }
  updateProviderPriceBook() { throw new AppError(409, 'customer_plan_required', 'Configure customer prices through versioned Hub plans; Night-All transfer price is zero') }
  updateOperationPolicy() { throw new AppError(409, 'legacy_policy_managed', 'Legacy policies remain consumer-scoped; provider pricing does not change crawl budgets') }
}
