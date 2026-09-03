import { AppError } from '../core/errors.mjs'

const RANGE_MS = {
  '24h': 24 * 60 * 60 * 1_000,
  '7d': 7 * 24 * 60 * 60 * 1_000,
  '30d': 30 * 24 * 60 * 60 * 1_000,
}

export const JUSTONE_MARKETPLACES = [
  { key: 'taobao', label: '淘宝 / 天猫' },
  { key: 'jd', label: '京东' },
  { key: 'xiaohongshu_ec', label: '小红书电商' },
  { key: 'xianyu', label: '闲鱼' },
]

export const EXTERNAL_PLATFORM_CAPABILITY_MATRIX = [
  {
    capability: 'ecommerce.products.search',
    label: '电商商品搜索',
    hubContractVersion: 'mx-insight-hub.ecommerce-products.v1',
    providerMapping: 'direct_versioned_adapter',
    scope: 'taobao/tmall, jd, xiaohongshu_ec, xianyu',
    status: 'implemented',
    fallback: 'exact_fingerprint_snapshot',
    note: '公开接口保持 Hub 稳定格式；JustOne endpoint/version 仅作为内部映射。',
  },
  {
    capability: 'search_intent',
    label: '聚合检索意图',
    hubContractVersion: null,
    providerMapping: 'hub_orchestration',
    scope: 'cross-platform',
    status: 'planned',
    fallback: 'stored_canonical_search',
    note: '这是 Hub 编排能力，不应寻找单一外部平台的一比一接口。',
  },
  {
    capability: 'search_post_detail',
    label: '内容详情',
    hubContractVersion: null,
    providerMapping: 'platform_specific_adapters',
    scope: 'multi-platform',
    status: 'planned',
    fallback: 'stored_canonical_item',
    note: '多家平台有专用详情接口；缺口是 Hub 统一契约与逐平台验证，不是全局无接口。',
  },
  {
    capability: 'search_post_comments',
    label: '指定内容评论',
    hubContractVersion: null,
    providerMapping: 'platform_specific_adapters',
    scope: 'multi-platform',
    status: 'planned',
    fallback: 'stored_canonical_comments',
    note: '需逐平台固定 endpoint、分页与评论 schema，再由 Hub 统一输出。',
  },
  {
    capability: 'youtube_channel_comments',
    label: 'YouTube 频道评论',
    hubContractVersion: null,
    providerMapping: 'composed_no_direct_equivalent',
    scope: 'youtube',
    status: 'planned',
    fallback: 'stored_canonical_comments',
    note: '只有这一项是 YouTube 专属复合能力；需频道视频列表再逐视频取评论，并设调用预算。',
  },
]

function ratio(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null
}

function nextShanghaiMidnight(now = new Date()) {
  // Asia/Shanghai has no daylight-saving transition.  Work in the provider's
  // documented UTC+8 quota day instead of the Hub host timezone.
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1_000)
  shifted.setUTCHours(24, 0, 0, 0)
  return new Date(shifted.getTime() - 8 * 60 * 60 * 1_000).toISOString()
}

function shanghaiDayStart(now = new Date()) {
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1_000)
  shifted.setUTCHours(0, 0, 0, 0)
  return new Date(shifted.getTime() - 8 * 60 * 60 * 1_000)
}

export function externalPlatformRange(value = '7d', now = new Date()) {
  const range = value || '7d'
  if (!Object.hasOwn(RANGE_MS, range)) {
    throw new AppError(400, 'invalid_range', 'range must be 24h, 7d, or 30d')
  }
  return {
    range,
    from: new Date(now.getTime() - RANGE_MS[range]),
    to: now,
    days: RANGE_MS[range] / 86_400_000,
    bucket: range === '30d' ? 'day' : 'hour',
  }
}

function providerStatus(config, state, now) {
  if (config.configurationError) return 'misconfigured'
  if (!(config.configured ?? Boolean(config.token))) return 'not_configured'
  if (!config.contractVerified) return 'awaiting_verification'
  if (state?.circuitOpenUntil && new Date(state.circuitOpenUntil) > now) return 'circuit_open'
  if ((state?.consecutiveFailures || 0) > 0) return 'degraded'
  if (state?.lastSuccessAt) return 'healthy'
  return 'configured'
}

function costProjection(analytics, config, range) {
  const billing = config.billing
  const callsPerDay = analytics.totals.upstreamCalls / range.days
  const projectedMonthlyCalls = Math.ceil(callsPerDay * 30)
  const billedCallsPerDay = analytics.totals.billedCalls / range.days
  const projectedMonthlyBilledCalls = Math.ceil(billedCallsPerDay * 30)
  const indeterminateBillingCalls = analytics.totals.indeterminateBillingCalls
  const unknownCostCalls = analytics.totals.unknownCostCalls
  const freeDaily = billing.freeDailyCalls
  const projectedPaidCalls = indeterminateBillingCalls > 0 || freeDaily == null
    ? null
    : Math.max(0, projectedMonthlyBilledCalls - freeDaily * 30)
  const endpointCosts = Object.values(billing.unitCostMinorByEndpoint || {})
  const oneKnownPrice = endpointCosts.length === 1 ? endpointCosts[0] : null
  const incompleteCostEvidence = indeterminateBillingCalls > 0 || unknownCostCalls > 0
  const projectedMonthlyCostMinor = !incompleteCostEvidence
    && projectedPaidCalls != null
    && oneKnownPrice != null
    ? projectedPaidCalls * oneKnownPrice
    : null
  const configuredBudget = billing.monthlyBudgetMinor
  let recommendation
  if (indeterminateBillingCalls > 0) {
    recommendation = `有 ${indeterminateBillingCalls} 次上游调用的计费状态尚未确定；账单核对前不预测付费调用、月成本或充值额。`
  } else if (unknownCostCalls > 0) {
    recommendation = `有 ${unknownCostCalls} 次已计费调用缺少单价或成本证据；补齐 endpoint 价目与账单后再预测月成本。`
  } else if (billing.source === 'unknown' || endpointCosts.length === 0) {
    recommendation = 'JustOne 未公开稳定的余额/价格查询接口；先导入经核验的价目表，避免把未知成本显示为 0。'
  } else if (projectedMonthlyCostMinor == null) {
    recommendation = '各接口单价不同，需按 endpoint 调用结构预测；当前只展示已知成本，不给出伪精确充值额。'
  } else if (configuredBudget == null) {
    recommendation = `按当前调用速度预计月末产生约 ${projectedMonthlyCostMinor} 个最小货币单位；配置月预算后才能给出超支判断。`
  } else if (projectedMonthlyCostMinor <= configuredBudget) {
    recommendation = '当前预测在已配置月预算内；仍应优先使用可验证的免费额度，并保留异常调用熔断。'
  } else {
    recommendation = '当前预测将超过月预算；应先收紧异常调用和刷新策略，再评估充值，而不是用充值掩盖重复请求。'
  }
  return {
    pricingSource: billing.source,
    pricingAsOf: billing.pricingAsOf,
    currency: billing.currency,
    // Manual endpoint prices are list-price estimates. They are not a provider
    // bill and cannot prove the net charge after free quota or discounts.
    actualCostMinor: null,
    grossEstimatedCostMinor: analytics.totals.knownCostMinor,
    knownCostMinor: analytics.totals.knownCostMinor,
    unknownCostCalls,
    indeterminateBillingCalls,
    projectedMonthlyCalls,
    projectedPaidCalls,
    projectedMonthlyCostMinor,
    monthlyBudgetMinor: configuredBudget,
    confidence: incompleteCostEvidence || billing.source === 'unknown'
      ? 'unknown'
      : endpointCosts.length === 1 ? 'medium' : 'low',
    recommendation,
  }
}

function providerProjection(analytics, todayAnalytics, config, range, now) {
  const totals = analytics.totals
  const status = providerStatus(config, analytics.state, now)
  const avoidedUpstreamCalls = totals.freshCache
    + totals.storedFallbackWithoutDispatch
    + totals.idempotentReplay
    + totals.duplicateSuppressed
    + totals.circuitRejected
  const freeDailyCalls = config.billing.freeDailyCalls
  const todayBillingIndeterminate = todayAnalytics.totals.indeterminateBillingCalls > 0
  const usedToday = freeDailyCalls == null || todayBillingIndeterminate
    ? null
    : todayAnalytics.totals.billedCalls
  return {
    key: 'justone',
    displayName: 'JustOne',
    kind: 'external_data_api',
    status,
    configured: config.configured ?? Boolean(config.token),
    configuration: {
      contractVerified: Boolean(config.contractVerified),
      dispatchEligible: Boolean(
        (config.configured ?? Boolean(config.token))
        && config.contractVerified
        && !config.configurationError
      ),
      error: config.configurationError
        ? {
            code: config.configurationError.code,
            message: config.configurationError.message,
          }
        : null,
    },
    description: '由 Hub 直接对接的外部数据接口平台；凭证、endpoint 与原始响应不暴露给调用方。',
    capabilities: ['ecommerce.products.search'],
    marketplaces: JUSTONE_MARKETPLACES,
    metrics: {
      ...totals,
      avoidedUpstreamCalls,
      hubSuccessRate: ratio(totals.successfulHubRequests, totals.hubRequests),
      upstreamSuccessRate: ratio(totals.successfulUpstreamCalls, totals.upstreamCalls),
      upstreamUsableRate: ratio(totals.usableUpstreamCalls, totals.upstreamCalls),
    },
    quota: {
      source: freeDailyCalls == null ? 'unknown' : 'manual',
      freeDailyCalls,
      usedToday,
      remainingToday: freeDailyCalls == null || usedToday == null
        ? null
        : Math.max(0, freeDailyCalls - usedToday),
      resetAt: freeDailyCalls == null ? null : nextShanghaiMidnight(now),
      note: todayBillingIndeterminate
        ? '今日存在计费状态未确定的上游调用；核对前不推断已用量或剩余额度。'
        : freeDailyCalls == null
        ? '官方公开文档未声明固定每日免费额度，也未发现稳定额度查询 API。'
        : '人工维护值；接入经验证的 provider API 后可切换为 provider_api。',
    },
    billing: costProjection(analytics, config, range),
    freshness: {
      lastCallAt: totals.lastCallAt,
      lastSuccessAt: totals.lastSuccessAt,
      cacheTtlSeconds: Math.floor(config.freshTtlMs / 1_000),
      fallbackTtlSeconds: Math.floor(config.staleTtlMs / 1_000),
    },
    circuit: {
      consecutiveFailures: analytics.state?.consecutiveFailures || 0,
      openUntil: analytics.state?.circuitOpenUntil || null,
    },
  }
}

export class ExternalPlatformAdminService {
  constructor({ store, config, durable = false }) {
    this.store = store
    this.config = config
    this.durable = durable
  }

  async #data(rangeValue) {
    const now = new Date()
    const range = externalPlatformRange(rangeValue, now)
    const [analytics, todayAnalytics] = await Promise.all([
      this.store.analytics({ from: range.from, bucket: range.bucket }),
      this.store.analytics({ from: shanghaiDayStart(now), bucket: 'hour' }),
    ])
    const provider = providerProjection(analytics, todayAnalytics, this.config, range, now)
    return { now, range, analytics, provider }
  }

  async overview(rangeValue) {
    const { now, range, provider } = await this.#data(rangeValue)
    return {
      contractVersion: 'mx-insight-hub.external-platform-admin.v1',
      range: range.range,
      generatedAt: now.toISOString(),
      summary: {
        providerCount: 1,
        configuredProviders: provider.configured ? 1 : 0,
        hubRequests: provider.metrics.hubRequests,
        successfulHubRequests: provider.metrics.successfulHubRequests,
        hubSuccessRate: provider.metrics.hubSuccessRate,
        upstreamCalls: provider.metrics.upstreamCalls,
        successfulUpstreamCalls: provider.metrics.successfulUpstreamCalls,
        usableUpstreamCalls: provider.metrics.usableUpstreamCalls,
        unusableSuccesses: provider.metrics.unusableSuccesses,
        billedCalls: provider.metrics.billedCalls,
        indeterminateBillingCalls: provider.metrics.indeterminateBillingCalls,
        upstreamSuccessRate: provider.metrics.upstreamSuccessRate,
        upstreamUsableRate: provider.metrics.upstreamUsableRate,
        avoidedUpstreamCalls: provider.metrics.avoidedUpstreamCalls,
        actualCostMinor: provider.billing.actualCostMinor,
        grossEstimatedCostMinor: provider.billing.grossEstimatedCostMinor,
        knownCostMinor: provider.metrics.knownCostMinor,
        unknownCostCalls: provider.metrics.unknownCostCalls,
        currency: provider.billing.currency,
      },
      providers: [provider],
    }
  }

  async detail(providerKey, rangeValue) {
    if (providerKey !== 'justone') throw new AppError(404, 'external_platform_not_found', 'External platform not found')
    const { now, range, analytics, provider } = await this.#data(rangeValue)
    return {
      contractVersion: 'mx-insight-hub.external-platform-admin.v1',
      range: range.range,
      generatedAt: now.toISOString(),
      provider,
      pipeline: [
        {
          key: 'stable_contract',
          label: 'Hub 稳定接口',
          description: 'API Key、平台授权、统一商品 schema 与 opaque cursor。',
          status: 'ready',
        },
        {
          key: 'cost_guardrails',
          label: '调用与费用保护',
          description: '幂等、短时同查询缓存、跨 Key dispatch lease、并发上限与熔断。',
          status: 'ready',
        },
        {
          key: 'provider_adapter',
          label: '版本化 JustOne Adapter',
          description: '仅允许已核验的商品搜索 endpoint；code=0 计费与 Hub 可用响应分别记账，不盲目重试。',
          status: provider.configured ? provider.status : 'not_configured',
        },
        {
          key: 'data_lineage',
          label: '归档与数据整合',
          description: 'raw 观察按来源目录归档，随后进入 PG canonical/outbox/ES 投影链。',
          status: this.durable ? 'ready' : 'memory_only',
        },
      ],
      timeSeries: analytics.timeSeries.map((row) => ({
        ...row,
        avoidedCalls: row.freshCache
          + row.storedFallbackWithoutDispatch
          + row.idempotentReplay
          + row.duplicateSuppressed
          + row.circuitRejected,
        hubSuccessRate: ratio(row.successfulHubRequests, row.hubRequests),
      })),
      capabilities: EXTERNAL_PLATFORM_CAPABILITY_MATRIX,
      tenants: analytics.tenants.map((tenant) => ({
        ...tenant,
        grossEstimatedCostMinor: tenant.knownCostMinor,
        share: ratio(tenant.hubRequests, analytics.totals.hubRequests),
        successRate: ratio(tenant.successfulHubRequests, tenant.hubRequests),
      })),
      endpoints: analytics.endpoints.map((endpoint) => ({
        ...endpoint,
        successRate: ratio(endpoint.successfulUpstreamCalls, endpoint.upstreamCalls),
        usableRate: ratio(endpoint.usableUpstreamCalls, endpoint.upstreamCalls),
      })),
      guardrails: {
        idempotentReplays: analytics.totals.idempotentReplay,
        freshCacheHits: analytics.totals.freshCache,
        storedFallbacks: analytics.totals.storedFallback,
        storedFallbacksWithoutDispatch: analytics.totals.storedFallbackWithoutDispatch,
        storedFallbacksAfterDispatch: analytics.totals.storedFallbackAfterDispatch,
        duplicateDispatchesSuppressed: analytics.totals.duplicateSuppressed,
        circuitRejections: analytics.totals.circuitRejected,
        unknownOutcomes: analytics.totals.unknownOutcomes,
        unusableBilledResponses: analytics.totals.unusableSuccesses,
        automaticUpstreamRetries: 0,
        lastUpstreamSuccessAt: analytics.totals.lastSuccessAt,
        circuitPolicy: {
          ignoredCategories: ['request'],
          impactingCategories: ['authentication', 'capacity', 'upstream', 'transport', 'contract'],
          note: '单次请求参数错误不推进平台级熔断；认证、容量、平台故障、传输不确定与契约漂移会推进熔断。',
        },
      },
      costPlan: provider.billing,
      notes: {
        billing: 'JustOne 公开文档说明仅 code=0 计费；未发现公开余额、价目或固定免费额度 API。未知值不会按 0 展示。',
        freshness: '专用抓取接口与缓存型通用搜索必须分别建模；当前只接入已核验的商品搜索 v1。',
      },
    }
  }
}
