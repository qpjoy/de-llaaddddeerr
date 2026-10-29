import {
  JUSTONE_ENDPOINTS, ECOMMERCE_PRODUCT_SEARCH_CONTRACT_VERSION, RAPIDAPI_TAOBAO_TMALL_HOST,
  justOneProductAdapterId, productAdapterId, productAdapterProvider, productSearchProviders,
} from '../contracts/justone.mjs'
import { NATIVE_FORWARDING_ENDPOINTS } from '../contracts/native-forwarding.mjs'
import { AppError } from '../core/errors.mjs'

const labels = { taobao: '淘宝', tmall: '天猫', jd: '京东', xianyu: '闲鱼', xiaohongshu_ec: '小红书电商',
  douyin_ec: '抖音电商', kuaishou_ec: '快手电商', tiktok_shop: 'TikTok Shop', pinduoduo: '拼多多' }
const channels = { justone: 'JustOne 直连 · api.justoneapi.com', rapidapi: `RapidAPI · ${RAPIDAPI_TAOBAO_TMALL_HOST}` }
export const ECOMMERCE_ROUTE_MODES = Object.freeze(['fixed', 'priority'])
const marketplace = platform => platform.replaceAll('-', '_')

// A route names a primary supplier and, under `priority`, one backup. Both
// must serve the marketplace's reviewed endpoint contract.
function validPolicy(key, row) {
  const primary = productAdapterProvider(row?.adapter_id, key)
  const mode = row?.mode ?? 'fixed'
  if (!primary || !ECOMMERCE_ROUTE_MODES.includes(mode)) return false
  if (mode === 'fixed') return row.fallback_adapter_id == null
  const fallback = productAdapterProvider(row.fallback_adapter_id, key)
  return Boolean(fallback) && fallback !== primary
}

const candidate = (provider, key) => ({ id: productAdapterId(provider, key), provider, channel: channels[provider],
  upstreamPath: JUSTONE_ENDPOINTS[key].path })

// Internal inventory only. Native contracts are not interchangeable product
// adapters; importing one must never silently change a unified search route.
export function ecommerceRoutingCatalog(policies = []) {
  const native = NATIVE_FORWARDING_ENDPOINTS.filter(row => row.authorizationPlatform === 'ecommerce')
  const markets = [...new Set([...Object.keys(labels), ...native.map(row => marketplace(row.platform))])]
  return { items: markets.map(key => {
    const adapter = Object.hasOwn(JUSTONE_ENDPOINTS, key) ? JUSTONE_ENDPOINTS[key] : null
    const policy = policies.find(row => row.marketplace === key)
    const candidates = productSearchProviders(key).map(provider => candidate(provider, key))
    const valid = Boolean(adapter && validPolicy(key, policy))
    const primary = valid ? productAdapterProvider(policy.adapter_id, key) : 'justone'
    const fallback = valid && policy.mode === 'priority' ? productAdapterProvider(policy.fallback_adapter_id, key) : null
    const endpoints = native.filter(row => marketplace(row.platform) === (key === 'tmall' ? 'taobao' : key))
    return { marketplace: key, label: labels[key] || endpoints[0]?.platformLabel || key,
      defaultRoute: adapter ? { id: policy?.adapter_id ?? candidates[0].id, provider: primary, channel: channels[primary],
        adapter: adapter.endpointKey, upstreamPath: adapter.path, adapterVersion: adapter.contractVersion,
        contractVersion: ECOMMERCE_PRODUCT_SEARCH_CONTRACT_VERSION,
        hubPath: '/api/v1/data/ecommerce/products/search' } : null,
      mode: valid ? policy.mode ?? 'fixed' : 'fixed',
      fallbackRoute: fallback ? candidate(fallback, key) : null,
      switchable: candidates.length > 1,
      switchReason: candidates.length > 1 ? 'multiple_suppliers' : adapter ? 'single_compatible_adapter' : 'no_product_search_adapter',
      candidates,
      revision: policy?.revision ?? 0, reason: policy?.reason ?? null,
      configurationValid: valid,
      updatedAt: policy?.updated_at ?? null,
      endpoints: endpoints.map(row => ({ key: row.key, provider: row.provider, upstreamPath: row.path,
        hubPath: row.hubPath, summary: row.summary, operation: row.operation,
        contractVersion: 'mx-insight-hub.native-forwarding.v1', adapterStatus: 'native_only' })),
    }
  }) }
}

const unavailable = message => new AppError(503, 'ecommerce_route_unavailable', message)

export class EcommerceRoutingStore {
  constructor(pool = null) {
    this.pool = pool
    this.policies = new Map(Object.keys(JUSTONE_ENDPOINTS).map(marketplace => [marketplace, {
      marketplace, adapter_id: justOneProductAdapterId(marketplace), mode: 'fixed', fallback_adapter_id: null,
      revision: 1, reason: 'initial_route', updated_at: null,
    }]))
    this.events = []
  }
  async list() {
    return this.pool ? (await this.pool.query('SELECT * FROM control.ecommerce_product_routes ORDER BY marketplace')).rows
      : [...this.policies.values()].map(row => ({ ...row }))
  }
  async catalog() { return ecommerceRoutingCatalog(await this.list()) }

  // The authoritative route for one new acquisition: which supplier goes first
  // and, under priority, which one may take over. Fails closed when the stored
  // policy is unreadable or names an unregistered adapter.
  async selection(marketplace) {
    if (!justOneProductAdapterId(marketplace)) return null
    let policy
    try {
      policy = this.pool ? (await this.pool.query(`SELECT * FROM control.ecommerce_product_routes WHERE marketplace=$1`, [marketplace])).rows[0]
        : this.policies.get(marketplace)
    } catch {
      throw unavailable('Product route configuration is unavailable')
    }
    if (!validPolicy(marketplace, policy)) throw unavailable('The configured product adapter is unavailable')
    const mode = policy.mode ?? 'fixed'
    return Object.freeze({ marketplace, mode, revision: policy.revision,
      primaryAdapterId: policy.adapter_id, primaryProvider: productAdapterProvider(policy.adapter_id, marketplace),
      fallbackAdapterId: mode === 'priority' ? policy.fallback_adapter_id : null,
      fallbackProvider: mode === 'priority' ? productAdapterProvider(policy.fallback_adapter_id, marketplace) : null })
  }
  async select(marketplace) { return (await this.selection(marketplace))?.primaryAdapterId ?? null }

  async update(marketplace, input) {
    const mode = input?.mode ?? 'fixed'
    const fallbackAdapterId = input?.fallbackAdapterId ?? null
    if (!input || Array.isArray(input)
      || Object.keys(input).some(key => !['adapterId', 'mode', 'fallbackAdapterId', 'expectedRevision', 'reason'].includes(key))
      || !justOneProductAdapterId(marketplace)
      || !validPolicy(marketplace, { adapter_id: input.adapterId, mode, fallback_adapter_id: fallbackAdapterId })
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
      || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 1000) {
      throw new AppError(400, 'invalid_ecommerce_route', 'Select compatible suppliers, revision and change reason')
    }
    if (!this.pool) {
      const old = this.policies.get(marketplace)
      if (old?.revision !== input.expectedRevision) throw new AppError(409, 'ecommerce_route_revision_conflict', 'Route changed; refresh before saving')
      const row = { ...old, adapter_id: input.adapterId, mode, fallback_adapter_id: fallbackAdapterId,
        revision: old.revision + 1, reason: input.reason.trim(), updated_at: new Date().toISOString() }
      this.policies.set(marketplace, row); this.events.push({ ...row, actor: 'admin-token' })
      return row
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const { rows: [row] } = await client.query(`UPDATE control.ecommerce_product_routes
        SET adapter_id=$1, mode=$2, fallback_adapter_id=$3, revision=revision+1, reason=$4, updated_at=now()
        WHERE marketplace=$5 AND revision=$6 RETURNING *`,
      [input.adapterId, mode, fallbackAdapterId, input.reason.trim(), marketplace, input.expectedRevision])
      if (!row) throw new AppError(409, 'ecommerce_route_revision_conflict', 'Route changed; refresh before saving')
      await client.query(`INSERT INTO control.ecommerce_product_route_events(marketplace,revision,actor,policy)
        VALUES($1,$2,'admin-token',$3::jsonb)`, [marketplace, row.revision, JSON.stringify(row)])
      await client.query('COMMIT')
      return row
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    finally { client.release() }
  }
}
