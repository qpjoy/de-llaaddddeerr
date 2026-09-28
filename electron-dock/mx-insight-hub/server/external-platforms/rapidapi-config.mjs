import { HUB_SOCIAL_ENDPOINTS } from '../contracts/hub-social.mjs'

// New operations can be enabled only by reviewed database policies. Optional
// provider configuration must not become a login/readiness dependency.
export function rapidApiConfig(environment = {}) {
  const apiKey = typeof environment.MX_INSIGHT_RAPIDAPI_API_KEY === 'string' ? environment.MX_INSIGHT_RAPIDAPI_API_KEY.trim() : ''
  const valid = apiKey.length <= 4096 && !/[\r\n]/.test(apiKey)
  return { apiKey: valid ? apiKey : '', configured: valid && !!apiKey,
    configurationError: valid ? null : { code: 'invalid_rapidapi_credential' },
    hubSocialVerified: false, contractVerified: false, dispatchEnabled: true,
    timeoutMs: 30000, freshTtlMs: 60000, staleTtlMs: 86400000, maxConcurrency: 3,
    maxConsumerConcurrency: 2, maxRequestsPerMinute: 60, circuitFailureThreshold: 5,
    circuitOpenMs: 30000, unknownFingerprintCooldownMs: 60000, billing: {},
  }
}
export const RAPIDAPI_METADATA = {
  key: 'rapidapi', displayName: 'RapidAPI', description: 'Hub 自主社交接口；首批为 Twitter 单页搜索、账号帖子和基础资料。',
  capabilities: Object.values(HUB_SOCIAL_ENDPOINTS).map(row => row.operation),
  capabilityMatrix: [], marketplaces: [{key:'twitter',label:'Twitter / X'}],
  adapterLabel: 'Twitter AIO HTTP Adapter', adapterDescription: '固定 Host，直接 HTTP；不启动 Python，不回退 Night-All，不自动重试或补页。',
  billingNote: '逐操作审核采购价和预算；供应商实际扣费未知，不将预算估算当作实际扣费。',
  freshnessNote: '每次显式请求获取一页；相同幂等标识回放原交付。基础资料不补查 about。',
}
