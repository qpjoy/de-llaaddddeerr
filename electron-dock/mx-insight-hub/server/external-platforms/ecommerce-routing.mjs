import { JUSTONE_ENDPOINTS, ECOMMERCE_PRODUCT_SEARCH_CONTRACT_VERSION, justOneProductAdapterId } from '../contracts/justone.mjs'
import { NATIVE_FORWARDING_ENDPOINTS } from '../contracts/native-forwarding.mjs'
import { AppError } from '../core/errors.mjs'

const labels = { taobao: '淘宝', tmall: '天猫', jd: '京东', xianyu: '闲鱼', xiaohongshu_ec: '小红书电商',
  douyin_ec: '抖音电商', kuaishou_ec: '快手电商', pinduoduo: '拼多多' }
const marketplace = platform => platform.replaceAll('-', '_')

// Internal inventory only. Native contracts are not interchangeable product
// adapters; importing one must never silently change a unified search route.
export function ecommerceRoutingCatalog(policies = []) {
  const native = NATIVE_FORWARDING_ENDPOINTS.filter(row => row.authorizationPlatform === 'ecommerce')
  const markets = [...new Set([...Object.keys(labels), ...native.map(row => marketplace(row.platform))])]
  return { items: markets.map(key => {
    const adapter = Object.hasOwn(JUSTONE_ENDPOINTS, key) ? JUSTONE_ENDPOINTS[key] : null
    const policy = policies.find(row => row.marketplace === key)
    const candidate = adapter ? { id: justOneProductAdapterId(key), provider: 'justone', upstreamPath: adapter.path } : null
    const endpoints = native.filter(row => marketplace(row.platform) === (key === 'tmall' ? 'taobao' : key))
    return { marketplace: key, label: labels[key] || endpoints[0]?.platformLabel || key,
      defaultRoute: adapter ? { id: policy?.adapter_id ?? candidate.id, provider: 'justone', adapter: adapter.endpointKey,
        upstreamPath: adapter.path, adapterVersion: adapter.contractVersion,
        contractVersion: ECOMMERCE_PRODUCT_SEARCH_CONTRACT_VERSION,
        hubPath: '/api/v1/data/ecommerce/products/search' } : null,
      switchable: false,
      switchReason: adapter ? 'single_compatible_adapter' : 'no_product_search_adapter',
      candidates: candidate ? [candidate] : [],
      revision: policy?.revision ?? 0, reason: policy?.reason ?? null,
      configurationValid: Boolean(candidate && policy?.adapter_id === candidate.id),
      updatedAt: policy?.updated_at ?? null,
      endpoints: endpoints.map(row => ({ key: row.key, provider: row.provider, upstreamPath: row.path,
        hubPath: row.hubPath, summary: row.summary, operation: row.operation,
        contractVersion: 'mx-insight-hub.native-forwarding.v1', adapterStatus: 'native_only' })),
    }
  }) }
}

export class EcommerceRoutingStore {
  constructor(pool = null) {
    this.pool = pool
    this.policies = new Map(Object.keys(JUSTONE_ENDPOINTS).map(marketplace => [marketplace, {
      marketplace, adapter_id: justOneProductAdapterId(marketplace), revision: 1, reason: 'initial_route', updated_at: null,
    }]))
    this.events = []
  }
  async list() {
    return this.pool ? (await this.pool.query('SELECT * FROM control.ecommerce_product_routes ORDER BY marketplace')).rows
      : [...this.policies.values()].map(row => ({ ...row }))
  }
  async catalog() { return ecommerceRoutingCatalog(await this.list()) }
  async select(marketplace) {
    if (!justOneProductAdapterId(marketplace)) return null
    let policy
    try {
      policy = this.pool ? (await this.pool.query('SELECT adapter_id FROM control.ecommerce_product_routes WHERE marketplace=$1', [marketplace])).rows[0]
        : this.policies.get(marketplace)
    } catch {
      throw new AppError(503, 'ecommerce_route_unavailable', 'Product route configuration is unavailable')
    }
    if (!policy || policy.adapter_id !== justOneProductAdapterId(marketplace)) {
      throw new AppError(503, 'ecommerce_route_unavailable', 'The configured product adapter is unavailable')
    }
    return policy.adapter_id
  }
  async update(marketplace, input) {
    if (!input || Array.isArray(input) || Object.keys(input).some(key => !['adapterId', 'expectedRevision', 'reason'].includes(key))
      || !justOneProductAdapterId(marketplace) || input.adapterId !== justOneProductAdapterId(marketplace)
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
      || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 1000) {
      throw new AppError(400, 'invalid_ecommerce_route', 'Select a compatible product adapter, revision and change reason')
    }
    if (!this.pool) {
      const old = this.policies.get(marketplace)
      if (old?.revision !== input.expectedRevision) throw new AppError(409, 'ecommerce_route_revision_conflict', 'Route changed; refresh before saving')
      const row = { ...old, adapter_id: input.adapterId, revision: old.revision + 1, reason: input.reason.trim(), updated_at: new Date().toISOString() }
      this.policies.set(marketplace, row); this.events.push({ ...row, actor: 'admin-token' })
      return row
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const { rows: [row] } = await client.query(`UPDATE control.ecommerce_product_routes
        SET adapter_id=$1, revision=revision+1, reason=$2, updated_at=now()
        WHERE marketplace=$3 AND revision=$4 RETURNING *`, [input.adapterId, input.reason.trim(), marketplace, input.expectedRevision])
      if (!row) throw new AppError(409, 'ecommerce_route_revision_conflict', 'Route changed; refresh before saving')
      await client.query(`INSERT INTO control.ecommerce_product_route_events(marketplace,revision,actor,policy)
        VALUES($1,$2,'admin-token',$3::jsonb)`, [marketplace, row.revision, JSON.stringify(row)])
      await client.query('COMMIT')
      return row
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    finally { client.release() }
  }
}
