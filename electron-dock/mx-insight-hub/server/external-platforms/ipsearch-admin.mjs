import { AppError } from '../core/errors.mjs'

export class IpSearchAdminService {
  constructor(store, gateway) { this.providerKey = 'ipsearch'; this.store = store; this.gateway = gateway }
  async overview(range) { const detail = await this.detail(this.providerKey, range); return { range: detail.range, providers: [detail.provider] } }
  async detail(_key, range = '24h') {
    const duration = { '24h': 86400000, '7d': 604800000, '30d': 2592000000 }[range]
    if (!duration) throw new AppError(400, 'invalid_range', 'Invalid statistics range')
    const analytics = await this.store.analytics({ from: new Date(Date.now() - duration), bucket: 'hour' })
    const httpMetrics = await this.gateway.events.summary(new Date(Date.now() - duration))
    const credential = await this.gateway.credentialStore?.describeCredential('ipsearch')
    const readiness = await this.gateway.capabilities()
    const metrics = { ...analytics.totals,
      hubSuccessRate: analytics.totals.hubRequests ? analytics.totals.successfulHubRequests / analytics.totals.hubRequests : null,
      avoidedUpstreamCalls: analytics.totals.idempotentReplay + analytics.totals.duplicateSuppressed,
    }
    return { range, generatedAt: new Date().toISOString(), contractVersion: 'mx-insight-hub.external-platform-admin.v1',
      credential, provider: { key: 'ipsearch', displayName: 'ipsearch', configured: credential?.credentialConfigured ?? this.gateway.credentialConfigured,
        status: readiness.ready ? 'unknown' : 'disabled',
        description: 'IPv4 风险画像接入；客户费率由生效套餐决定；采购成本独立记录。', metrics,
        billing: { currency: null, actualCostMinor: null, grossEstimatedCostMinor: null, pricingSource: 'unknown' },
        lastObservedAt: metrics.lastCallAt },
      httpMetrics, timeSeries: analytics.timeSeries, tenants: analytics.tenants, endpoints: analytics.endpoints,
      notes: { connection: '凭据支持数据库保存、轮换及二次 Admin Token 查看；保存后即可由已授权的 Live Hub Key 调用，不参与 Launcher 登录或联网。',
        scope: '认证后 HTTP 事件单独记录参数、授权、配额拒绝与重放；逻辑交付及真实调用另行统计。匿名认证失败不归属租户，不推断上游计费结果。',
        budget: '客户按套餐费率计费；采购费用未知。每分钟最多 60 次，单次最多 15 秒，不自动重试。' } }
  }
  updateCredential(provider, input) {
    if (typeof input?.apiKey !== 'string' || !input.apiKey.trim() || input.apiKey.trim().length > 1024 || /\s/u.test(input.apiKey.trim())) throw new AppError(400, 'invalid_external_platform_credential', 'Invalid credential format')
    return this.gateway.credentialStore.updateCredential(provider, input, { updatedBy: 'admin-token' })
  }
  async revealCredential(provider) {
    const apiKey = await this.gateway.credentialStore.readCredential(provider)
    if (!apiKey) throw new AppError(409, 'external_platform_credential_not_revealable', 'No database credential is available')
    return { apiKey }
  }
  updateProviderPriceBook() { throw new AppError(409, 'procurement_pricing_unavailable', 'Procurement pricing is not configured; customer rates are managed in Plans') }
  updateOperationPolicy() { throw new AppError(409, 'deployment_managed', 'Operation is deployment-managed') }
}
