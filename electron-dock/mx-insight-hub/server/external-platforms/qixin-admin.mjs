import { AppError } from '../core/errors.mjs'
import { ExternalPlatformAdminService } from './admin.mjs'
import { ENTERPRISE_CAPABILITY, QIXIN_CATALOG } from '../contracts/enterprise.mjs'

export const QIXIN_METADATA = { key: 'qixin', displayName: '启信慧眼',
  description: '企业数据接口；双密钥签名转发，完整响应保存在 Hub。接口说明统一收录于接口文档。',
  capabilities: [ENTERPRISE_CAPABILITY], capabilityMatrix: [], marketplaces: [{ key: 'enterprise', label: '企业数据' }],
  adapterLabel: '启信慧眼 Auth 2.0', adapterDescription: '固定目录和目标地址；逐接口配置采购价与运行状态；不自动重试或轮询。',
  billingNote: '官网参考价格不代表合同价。供应商实际是否扣费保持未知；按已审核采购价预留预算。',
  freshnessNote: '按调用者与完整请求保留快照。返回捕获时间；cache_only 不访问供应商。',
}

export class QixinAdminService extends ExternalPlatformAdminService {
  async detail(provider, range) {
    const result = await super.detail(provider, range)
    result.catalog = { apiCount: QIXIN_CATALOG.api_count, categoryCount: QIXIN_CATALOG.category_count,
      syncedAt: QIXIN_CATALOG.synced_at, docsPath: '/docs/enterprise' }
    result.pipeline[0].description = '企业数据域与查询能力双授权；固定目录、参数校验与幂等。'
    result.pipeline[3].description = '完整响应与交付快照写入 PostgreSQL；响应观察进入 Canonical/outbox，不将响应数量当作企业数量。'
    return result
  }
  async revealCredential(provider) {
    if (provider !== 'qixin') throw new AppError(404, 'external_platform_not_found', 'Unknown platform')
    const credentials = await this.credentialStore.readCredential(provider)
    if (!credentials) throw new AppError(409, 'external_platform_credential_not_revealable', 'No saved credential bundle')
    return { credentials }
  }
  updateProviderPriceBook() {
    throw new AppError(400, 'enterprise_per_api_price_required', 'Configure a reviewed price for each enterprise API independently')
  }
}
