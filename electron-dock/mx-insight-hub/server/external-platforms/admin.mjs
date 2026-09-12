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

export const TIKHUB_XIAOHONGSHU_CAPABILITY_MATRIX = [
  {
    capability: 'social.posts.search',
    label: '小红书笔记搜索',
    hubContractVersion: 'night-all.data-search.v1',
    providerMapping: 'direct_versioned_adapter',
    scope: 'xiaohongshu',
    status: 'implemented',
    fallback: 'exact_fingerprint_snapshot',
    note: '固定 20 条分页并使用 Hub 不透明游标；60 字预览边界按预算调用详情补全。',
  },
  {
    capability: 'social.posts.resolve',
    label: '小红书笔记详情',
    hubContractVersion: 'mx-insight-hub.social-post.v1',
    providerMapping: 'direct_versioned_adapter',
    scope: 'xiaohongshu',
    status: 'implemented',
    fallback: 'exact_fingerprint_snapshot',
    note: '接受官方笔记链接，输出 Hub 稳定正文、标签、作者、指标与媒体引用。',
  },
  {
    capability: 'social.users.resolve',
    label: '小红书用户检索与资料',
    hubContractVersion: 'night-all.compat.user-info.v1',
    providerMapping: 'direct_versioned_adapter',
    upstreamEndpoint: 'search_users + get_user_info',
    upstreamVersion: 'App V2',
    scope: 'xiaohongshu',
    status: 'implemented',
    fallback: 'exact_fingerprint_snapshot',
    note: 'search_users 按关键词解析用户，get_user_info 按用户 ID 或分享文本读取资料；两者保留官方兼容 envelope。',
  },
  {
    capability: 'social.users.posts',
    label: '小红书用户发布笔记',
    hubContractVersion: 'night-all.compat.crawl.v1',
    providerMapping: 'direct_versioned_adapter',
    upstreamEndpoint: 'get_user_posted_notes',
    upstreamVersion: 'App V2',
    scope: 'xiaohongshu',
    status: 'implemented',
    fallback: 'exact_fingerprint_snapshot',
    note: 'get_user_posted_notes 按用户读取已发布笔记，使用 Hub 不透明游标并在第 15 页终止。',
  },
]

const JUSTONE_METADATA = Object.freeze({
  key: 'justone',
  displayName: 'JustOne',
  description: '由 Hub 直接对接的外部电商数据接口平台；凭证、endpoint 与原始响应不暴露给调用方。',
  capabilities: ['ecommerce.products.search'],
  capabilityMatrix: EXTERNAL_PLATFORM_CAPABILITY_MATRIX,
  marketplaces: JUSTONE_MARKETPLACES,
  adapterLabel: '版本化 JustOne Adapter',
  adapterDescription: '仅允许已核验的商品搜索 endpoint；业务成功与 Hub 可用响应分别记账，不盲目重试。',
  billingNote: '供应商公开资料未提供可验证的账户净账单 API；未知成本不会按 0 展示。',
  freshnessNote: '专用抓取接口与缓存型通用搜索分别建模；当前只接入已核验的商品搜索版本。',
})

const TIKHUB_METADATA = Object.freeze({
  key: 'tikhub',
  displayName: 'TikHub',
  description: 'Hub 直连的小红书数据 Provider；客户只看 Hub 合同、授权、用量与缓存状态。',
  capabilities: [
    'social.posts.search',
    'social.posts.resolve',
    'social.users.resolve',
    'social.users.posts',
  ],
  capabilityMatrix: TIKHUB_XIAOHONGSHU_CAPABILITY_MATRIX,
  marketplaces: [{ key: 'xiaohongshu', label: '小红书' }],
  adapterLabel: '版本化 TikHub Adapter',
  adapterDescription: '固定 App V2 笔记搜索/详情、用户检索/资料与发布笔记 endpoint，校验响应身份并区分无效身份、容量、认证和契约漂移。',
  billingNote: '按已核验人工价目记录上游标价；Hub 缓存命中不会重复触发上游调用。',
  freshnessNote: '搜索页与详情分别按精确指纹缓存；只有新鲜详情会参与正文补全，搜索异常时才显式回退保留期内的搜索快照。',
})

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

function costProjection(analytics, config, range, providerName = '外部平台') {
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
  const configuredEndpointCosts = Object.values(billing.unitCostMinorByEndpoint || {})
  const endpointCosts = configuredEndpointCosts.length > 0
    ? configuredEndpointCosts
    : billing.unitCostMinor == null ? [] : [billing.unitCostMinor]
  const oneKnownPrice = endpointCosts.length === 1 ? endpointCosts[0] : null
  const unitPrices = configuredEndpointCosts.length > 0
    ? Object.entries(billing.unitCostMinorByEndpoint)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([endpointKey, unitCostMinor]) => ({ endpointKey, unitCostMinor }))
    : billing.unitCostMinor == null
      ? []
      : [{ endpointKey: 'legacy-default', unitCostMinor: billing.unitCostMinor }]
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
    recommendation = `${providerName} 尚未配置经核验的价目证据；先录入带日期的价目表，避免把未知成本显示为 0。`
  } else if (projectedMonthlyCostMinor == null) {
    recommendation = '各接口单价不同，需按 endpoint 调用结构预测；当前只展示已知成本，不给出伪精确充值额。'
  } else if (configuredBudget == null) {
    recommendation = `按当前调用速度预计月末产生约 ${projectedMonthlyCostMinor} 个最小货币单位；配置成本线后才能给出超支判断。`
  } else if (projectedMonthlyCostMinor <= configuredBudget) {
    recommendation = '当前预测在已配置上游成本线内；仍应优先使用可验证的免费额度，并保留异常调用熔断。'
  } else {
    recommendation = '当前预测将超过上游成本线；已明确按次计费的请求继续服务并逐次记账，补贴流量保持预算保护，同时排查重复请求。'
  }
  return {
    pricingSource: billing.source,
    pricingAsOf: billing.pricingAsOf,
    currency: billing.currency,
    unitPrices,
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

function providerProjection(analytics, todayAnalytics, config, range, now, metadata = JUSTONE_METADATA) {
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
    key: metadata.key,
    displayName: metadata.displayName,
    kind: 'external_data_api',
    status,
    configured: config.configured ?? Boolean(config.token),
    configuration: {
      contractVerified: Boolean(config.contractVerified),
      ...(typeof config.searchContractVerified === 'boolean'
        ? { searchContractVerified: config.searchContractVerified }
        : {}),
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
    description: metadata.description,
    capabilities: metadata.capabilities,
    marketplaces: metadata.marketplaces,
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
    billing: costProjection(analytics, config, range, metadata.displayName),
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

function fallbackCredential(config) {
  return {
    source: 'environment',
    revision: 0,
    credentialConfigured: Boolean(config.configured ?? config.token ?? config.apiKey),
    revealable: false,
    updatedAt: null,
  }
}

export class ExternalPlatformAdminService {
  constructor({
    store,
    config,
    credentialStore = null,
    operationControlStore = null,
    durable = false,
    providerKey = 'justone',
    metadata = null,
  }) {
    this.store = store
    this.config = config
    this.credentialStore = credentialStore
    this.operationControlStore = operationControlStore
    this.durable = durable
    this.providerKey = providerKey
    this.metadata = metadata || (providerKey === 'tikhub' ? TIKHUB_METADATA : JUSTONE_METADATA)
  }

  #assertProvider(providerKey) {
    if (providerKey !== this.providerKey) {
      throw new AppError(404, 'external_platform_not_found', 'External platform not found')
    }
  }

  #requireCredentialStore() {
    if (!this.credentialStore) {
      throw new AppError(
        503,
        'external_platform_credential_store_unavailable',
        'External platform credential storage is unavailable',
      )
    }
    return this.credentialStore
  }

  #requireOperationControlStore() {
    if (!this.operationControlStore) {
      throw new AppError(
        503,
        'external_platform_control_store_unavailable',
        'External platform operation control is unavailable',
      )
    }
    return this.operationControlStore
  }

  async #credential(providerKey = this.providerKey) {
    this.#assertProvider(providerKey)
    if (!this.credentialStore) return fallbackCredential(this.config)
    return this.credentialStore.describeCredential(providerKey)
  }

  async #data(rangeValue) {
    const now = new Date()
    const range = externalPlatformRange(rangeValue, now)
    const [analytics, todayAnalytics, credential] = await Promise.all([
      this.store.analytics({ from: range.from, bucket: range.bucket }),
      this.store.analytics({ from: shanghaiDayStart(now), bucket: 'hour' }),
      this.#credential(),
    ])
    const describedOperations = this.operationControlStore
      ? await this.operationControlStore.describeProvider(this.providerKey, {
          config: this.config,
          credentialConfigured: credential.credentialConfigured,
        })
      : []
    // How much of each operation's monthly procurement budget is already
    // committed. This is the cap the gateway actually enforces -- the price
    // book bound to the operation, falling back to deployment billing exactly
    // as dispatch does -- which is not the same thing as the provider-level
    // billing shown in the cost panel. Reporting only the latter is how an
    // operator ends up staring at "未知" while calls fail on a real budget.
    const operations = await Promise.all(describedOperations.map(async (operation) => {
      // priceBook here is already the effective pricing: describeProvider
      // resolves a database price book against the deployment billing exactly
      // as dispatch does, so reading it avoids re-deciding which source wins.
      const priceBook = operation.priceBook
      const budget = typeof this.store.describeCostBudget === 'function' && priceBook
        ? await this.store.describeCostBudget({
            currency: priceBook.currency,
            monthlyBudgetMinor: priceBook.monthlyBudgetMinor,
          })
        : null
      return { ...operation, budget }
    }))
    const provider = providerProjection(analytics, todayAnalytics, {
      ...this.config,
      configured: credential.credentialConfigured,
    }, range, now, this.metadata)
    provider.operationControl = {
      operationCount: operations.length,
      effectiveStates: Object.fromEntries(operations.map((operation) => [
        operation.operationKey,
        operation.effectiveState,
      ])),
    }
    return { now, range, analytics, provider, credential, operations }
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
    this.#assertProvider(providerKey)
    const { now, range, analytics, provider, credential, operations } = await this.#data(rangeValue)
    return {
      contractVersion: 'mx-insight-hub.external-platform-admin.v1',
      range: range.range,
      generatedAt: now.toISOString(),
      provider,
      credential,
      operations,
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
          label: this.metadata.adapterLabel,
          description: this.metadata.adapterDescription,
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
      capabilities: this.metadata.capabilityMatrix,
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
        billing: this.metadata.billingNote,
        freshness: this.metadata.freshnessNote,
      },
    }
  }

  async updateCredential(providerKey, input) {
    this.#assertProvider(providerKey)
    return this.#requireCredentialStore().updateCredential(providerKey, input, {
      updatedBy: 'admin-token',
    })
  }

  async updateOperationPolicy(providerKey, operationKey, input) {
    this.#assertProvider(providerKey)
    const credential = await this.#credential(providerKey)
    return this.#requireOperationControlStore().updatePolicy(providerKey, operationKey, input, {
      actor: 'admin-token',
      runtime: {
        config: this.config,
        credentialConfigured: credential.credentialConfigured,
      },
    })
  }

  // One price book for the whole provider.
  //
  // Pricing per operation is the exception, not the rule: a provider quotes one
  // rate and one monthly commitment, and making an operator retype that into
  // every operation is how a deployment ends up with one operation still on a
  // zero budget, refusing calls for no visible reason. So this applies the same
  // evidence everywhere, and per-operation editing stays available for the
  // genuine exceptions.
  //
  // Each operation is still written through the ordinary policy path, so every
  // one gets its own audit event, its own revision check and its own blockers.
  // Nothing here bypasses the control plane; it just stops the typing.
  async updateProviderPriceBook(providerKey, input) {
    this.#assertProvider(providerKey)
    const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (!reason) {
      throw new AppError(400, 'invalid_request', 'reason is required')
    }
    const unitCostMinor = body.unitCostMinor
    if (!Number.isSafeInteger(unitCostMinor) || unitCostMinor <= 0) {
      throw new AppError(400, 'invalid_request', 'unitCostMinor must be a positive integer')
    }
    // Budgets may be stated in calls, which is how a provider quotes them and
    // how an operator reasons about them. The control plane stores money.
    const budgetMinor = (callsField, minorField) => {
      const calls = body[callsField]
      if (Number.isSafeInteger(calls) && calls >= 0) return calls * unitCostMinor
      const minor = body[minorField]
      if (Number.isSafeInteger(minor) && minor >= 0) return minor
      throw new AppError(400, 'invalid_request', `${callsField} or ${minorField} is required`)
    }
    const monthlyBudgetMinor = budgetMinor('monthlyBudgetCalls', 'monthlyBudgetMinor')
    const monthlySubsidyBudgetMinor = budgetMinor('monthlySubsidyBudgetCalls', 'monthlySubsidyBudgetMinor')

    const credential = await this.#credential(providerKey)
    const runtime = { config: this.config, credentialConfigured: credential.credentialConfigured }
    const controlStore = this.#requireOperationControlStore()
    const operations = await controlStore.describeProvider(providerKey, runtime)
    const only = Array.isArray(body.operationKeys) && body.operationKeys.length > 0
      ? new Set(body.operationKeys.map(String))
      : null

    const applied = []
    const skipped = []
    for (const operation of operations) {
      if (only && !only.has(operation.operationKey)) continue
      const endpointKeys = operation.release?.endpointKeys || []
      if (endpointKeys.length === 0) {
        skipped.push({ operationKey: operation.operationKey, reason: 'release_declares_no_endpoints' })
        continue
      }
      try {
        const updated = await controlStore.updatePolicy(providerKey, operation.operationKey, {
          // The desired state is preserved, never raised: pricing a provider
          // must not switch on an operation somebody deliberately paused.
          desiredState: operation.desiredState,
          expectedRevision: operation.revision,
          reason,
          ...(operation.desiredState === 'canary'
            ? { canaryConsumerIds: operation.canaryConsumerIds || [] }
            : {}),
          priceBook: {
            currency: body.currency,
            pricingAsOf: body.pricingAsOf,
            monthlyBudgetMinor,
            monthlySubsidyBudgetMinor,
            unitCostMinorByEndpoint: Object.fromEntries(
              endpointKeys.map((endpointKey) => [endpointKey, unitCostMinor]),
            ),
          },
        }, { actor: 'admin-token', runtime })
        applied.push({
          operationKey: operation.operationKey,
          priceBookVersion: updated?.priceBook?.version ?? null,
          effectiveState: updated?.effectiveState ?? null,
        })
      } catch (error) {
        // One operation failing must not silently abandon the rest, and must
        // not be reported as success.
        skipped.push({
          operationKey: operation.operationKey,
          reason: error?.code || 'update_failed',
          message: error?.message || null,
        })
      }
    }
    return { applied, skipped, monthlyBudgetMinor, monthlySubsidyBudgetMinor, unitCostMinor }
  }

  async revealCredential(providerKey) {
    this.#assertProvider(providerKey)
    const store = this.#requireCredentialStore()
    const status = await store.describeCredential(providerKey)
    if (status.source !== 'database') {
      throw new AppError(
        409,
        'external_platform_credential_not_revealable',
        'Environment-managed credentials cannot be revealed by the Hub',
      )
    }
    const apiKey = await store.readCredential(providerKey)
    if (!apiKey) {
      throw new AppError(
        404,
        'external_platform_credential_not_found',
        'The external platform has no saved credential',
      )
    }
    return { apiKey }
  }
}

function summed(providers, field) {
  return providers.reduce((total, provider) => total + Number(provider.metrics?.[field] || 0), 0)
}

function sumKnownValues(providers, read) {
  const values = providers.map(read).filter((value) => Number.isFinite(value))
  return values.length === providers.length && values.length > 0
    ? values.reduce((total, value) => total + value, 0)
    : null
}

/**
 * One admin surface over independently isolated provider stores.  A failure in
 * one provider's analytics is reported on that provider's detail request and
 * cannot change another provider's credential, circuit or usage ledger.
 */
export class MultiExternalPlatformAdminService {
  constructor(services) {
    this.services = new Map(services.map((service) => [service.providerKey, service]))
  }

  #service(providerKey) {
    const service = this.services.get(providerKey)
    if (!service) throw new AppError(404, 'external_platform_not_found', 'External platform not found')
    return service
  }

  async overview(rangeValue) {
    const views = await Promise.all([...this.services.values()].map((service) => service.overview(rangeValue)))
    const providers = views.flatMap((view) => view.providers || [])
    const hubRequests = summed(providers, 'hubRequests')
    const successfulHubRequests = summed(providers, 'successfulHubRequests')
    const upstreamCalls = summed(providers, 'upstreamCalls')
    const successfulUpstreamCalls = summed(providers, 'successfulUpstreamCalls')
    const usableUpstreamCalls = summed(providers, 'usableUpstreamCalls')
    const currencies = [...new Set(providers.map((provider) => provider.billing?.currency).filter(Boolean))]
    const aggregateCurrency = currencies.length === 1 ? currencies[0] : null
    const aggregateCosts = currencies.length <= 1
    return {
      contractVersion: 'mx-insight-hub.external-platform-admin.v1',
      range: views[0]?.range || rangeValue || '7d',
      generatedAt: new Date().toISOString(),
      summary: {
        providerCount: providers.length,
        configuredProviders: providers.filter((provider) => provider.configured).length,
        hubRequests,
        successfulHubRequests,
        hubSuccessRate: ratio(successfulHubRequests, hubRequests),
        upstreamCalls,
        successfulUpstreamCalls,
        usableUpstreamCalls,
        unusableSuccesses: summed(providers, 'unusableSuccesses'),
        billedCalls: summed(providers, 'billedCalls'),
        indeterminateBillingCalls: summed(providers, 'indeterminateBillingCalls'),
        upstreamSuccessRate: ratio(successfulUpstreamCalls, upstreamCalls),
        upstreamUsableRate: ratio(usableUpstreamCalls, upstreamCalls),
        avoidedUpstreamCalls: summed(providers, 'avoidedUpstreamCalls'),
        actualCostMinor: aggregateCosts
          ? sumKnownValues(providers, (provider) => provider.billing?.actualCostMinor)
          : null,
        grossEstimatedCostMinor: aggregateCosts
          ? sumKnownValues(providers, (provider) => provider.billing?.grossEstimatedCostMinor)
          : null,
        knownCostMinor: aggregateCosts ? summed(providers, 'knownCostMinor') : null,
        unknownCostCalls: summed(providers, 'unknownCostCalls'),
        currency: aggregateCurrency,
      },
      providers,
    }
  }

  detail(providerKey, rangeValue) {
    return this.#service(providerKey).detail(providerKey, rangeValue)
  }

  updateCredential(providerKey, input) {
    return this.#service(providerKey).updateCredential(providerKey, input)
  }

  updateOperationPolicy(providerKey, operationKey, input) {
    return this.#service(providerKey).updateOperationPolicy(providerKey, operationKey, input)
  }

  updateProviderPriceBook(providerKey, input) {
    return this.#service(providerKey).updateProviderPriceBook(providerKey, input)
  }

  revealCredential(providerKey) {
    return this.#service(providerKey).revealCredential(providerKey)
  }
}
