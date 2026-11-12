import { AppError } from '../core/errors.mjs'
import { COMMENT_INTERFACES, commentProviders, commentRoutePlatforms, defaultCommentRoute } from '../contracts/comment-routes.mjs'

export const STRATEGY_SEARCH_PROVIDERS = Object.freeze(['justone', 'tikhub', 'rapidapi'])
export const STRATEGY_SEARCH_MODES = Object.freeze(['fixed', 'priority', 'paused'])
const PROVIDERS_BY_PLATFORM = Object.freeze({
  instagram: Object.freeze(['justone', 'tikhub']),
  twitter: Object.freeze(['rapidapi', 'tikhub']),
  facebook: Object.freeze(['justone']),
  threads: Object.freeze(['rapidapi', 'tikhub']),
})
// Threads is the one platform whose account interfaces are also routed.
const THREADS_ROUTED_INTERFACES = Object.freeze(['search', 'crawl', 'user-info'])
const defaultThreadsRow = interfaceId => ({ interface_key: interfaceId, platform: 'threads', mode: 'priority', primary_provider: 'rapidapi',
  fallback_provider: 'tikhub', revision: 1, reason: 'default_route', updated_at: null })

// Registered suppliers for one business interface on one platform. Comment
// interfaces read the reviewed comment catalog; a pending supplier is still
// registered (selectable once calibrated) but requests fail before dispatch.
export function strategyRouteProviders(interfaceId, platform) {
  if (COMMENT_INTERFACES.includes(interfaceId)) return Object.keys(commentProviders(interfaceId, platform) || {})
  if (platform === 'threads') return THREADS_ROUTED_INTERFACES.includes(interfaceId) ? PROVIDERS_BY_PLATFORM.threads : []
  if (platform === 'facebook') return ['crawl', 'user-info'].includes(interfaceId) ? PROVIDERS_BY_PLATFORM.facebook : []
  return interfaceId === 'search' ? PROVIDERS_BY_PLATFORM[platform] || [] : []
}
const editable = (interfaceId, platform) => strategyRouteProviders(interfaceId, platform).length > 0
const validRoute = row => {
  if (!row || !editable(row.interface_key, row.platform) || !STRATEGY_SEARCH_MODES.includes(row.mode)) return false
  const providers = strategyRouteProviders(row.interface_key, row.platform)
  if (row.platform === 'facebook' && row.mode === 'priority') return false
  return providers.includes(row.primary_provider)
    && (row.mode === 'priority'
      ? providers.includes(row.fallback_provider) && row.fallback_provider !== row.primary_provider
      : row.fallback_provider === null)
    && Number.isSafeInteger(row.revision) && row.revision >= 1
}
const defaultCommentRow = (interfaceId, platform) => {
  const route = defaultCommentRoute(interfaceId, platform)
  return route && { interface_key: interfaceId, platform, mode: route.mode, primary_provider: route.primaryProvider,
    fallback_provider: route.fallbackProvider, revision: 1, reason: 'default_route', updated_at: null }
}

const policy = row => ({ interface: row.interface_key, platform: row.platform, mode: row.mode,
  primaryProvider: row.primary_provider, fallbackProvider: row.fallback_provider,
  revision: row.revision, reason: row.reason, updatedAt: row.updated_at ?? null })
const unavailable = () => new AppError(503, 'strategy_search_route_unavailable', 'Strategy search configuration is unavailable')

// This store selects configuration only. The gateway owns cursor pinning and
// pre-dispatch readiness; priority never authorizes retry after a supplier call.
export class StrategySearchRoutingStore {
  constructor(pool = null) {
    this.pool = pool
    this.policies = new Map([['search/instagram', {
      interface_key: 'search', platform: 'instagram', mode: 'fixed', primary_provider: 'justone',
      fallback_provider: null, revision: 1, reason: 'initial_route', updated_at: null,
    }], ['search/twitter', {
      interface_key: 'search', platform: 'twitter', mode: 'priority', primary_provider: 'rapidapi',
      fallback_provider: 'tikhub', revision: 1, reason: 'initial_route', updated_at: null,
    }]])
    for (const interfaceId of ['crawl', 'user-info']) this.policies.set(`${interfaceId}/facebook`, {
      interface_key: interfaceId, platform: 'facebook', mode: 'fixed', primary_provider: 'justone',
      fallback_provider: null, revision: 1, reason: 'initial_route', updated_at: null,
    })
    for (const interfaceId of COMMENT_INTERFACES) for (const platform of commentRoutePlatforms(interfaceId)) {
      this.policies.set(`${interfaceId}/${platform}`, defaultCommentRow(interfaceId, platform))
    }
    for (const interfaceId of THREADS_ROUTED_INTERFACES) this.policies.set(`${interfaceId}/threads`, defaultThreadsRow(interfaceId))
    this.events = []
  }

  async list() {
    let rows
    try {
      rows = this.pool ? (await this.pool.query('SELECT * FROM control.strategy_search_routes ORDER BY interface_key,platform')).rows
        : [...this.policies.values()]
    } catch { throw unavailable() }
    // Comment routes without a saved row run on the reviewed default.
    for (const interfaceId of COMMENT_INTERFACES) for (const platform of commentRoutePlatforms(interfaceId)) {
      if (!rows.some(row => row.interface_key === interfaceId && row.platform === platform)) rows.push(defaultCommentRow(interfaceId, platform))
    }
    for (const interfaceId of THREADS_ROUTED_INTERFACES) {
      if (!rows.some(row => row.interface_key === interfaceId && row.platform === 'threads')) rows.push(defaultThreadsRow(interfaceId))
    }
    if (rows.some(row => !validRoute(row))) throw unavailable()
    return rows.map(policy)
  }

  async get(interfaceId, platform) {
    if (!editable(interfaceId, platform)) return null
    let row
    try {
      row = this.pool ? (await this.pool.query(`SELECT * FROM control.strategy_search_routes
        WHERE interface_key=$1 AND platform=$2`, [interfaceId, platform])).rows[0]
        : this.policies.get(`${interfaceId}/${platform}`)
    } catch { throw unavailable() }
    if (!row && COMMENT_INTERFACES.includes(interfaceId)) row = defaultCommentRow(interfaceId, platform)
    if (!row && platform === 'threads') row = defaultThreadsRow(interfaceId)
    if (!validRoute(row)) throw unavailable()
    return policy(row)
  }

  async update(interfaceId, platform, input) {
    if (!editable(interfaceId, platform)) {
      throw new AppError(400, 'strategy_search_route_read_only', 'This interface and platform retain their existing routing policy')
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['mode', 'primaryProvider', 'fallbackProvider', 'expectedRevision', 'reason'].includes(key))
      || !validRoute({ interface_key: interfaceId, platform, mode: input.mode,
        primary_provider: input.primaryProvider, fallback_provider: input.fallbackProvider, revision: input.expectedRevision })
      || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 1000) {
      throw new AppError(400, 'invalid_strategy_search_route', 'Select a compatible strategy, revision and change reason')
    }
    const conflict = () => new AppError(409, 'strategy_search_route_revision_conflict', 'Route changed; refresh before saving')
    if (!this.pool) {
      const key = `${interfaceId}/${platform}`
      const old = this.policies.get(key)
      if (old?.revision !== input.expectedRevision) throw conflict()
      const row = { ...old, mode: input.mode, primary_provider: input.primaryProvider,
        fallback_provider: input.fallbackProvider, revision: old.revision + 1,
        reason: input.reason.trim(), updated_at: new Date().toISOString() }
      this.policies.set(key, row)
      this.events.push({ ...policy(row), actor: 'admin-token' })
      return policy(row)
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const { rows: [row] } = await client.query(`UPDATE control.strategy_search_routes
        SET mode=$1,primary_provider=$2,fallback_provider=$3,revision=revision+1,reason=$4,updated_at=now()
        WHERE interface_key=$5 AND platform=$6 AND revision=$7 RETURNING *`,
      [input.mode, input.primaryProvider, input.fallbackProvider, input.reason.trim(), interfaceId, platform, input.expectedRevision])
      if (!row) throw conflict()
      const result = policy(row)
      await client.query(`INSERT INTO control.strategy_search_route_events(interface_key,platform,revision,actor,policy)
        VALUES($1,$2,$3,'admin-token',$4::jsonb)`, [interfaceId, platform, row.revision, JSON.stringify(result)])
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    finally { client.release() }
  }
}

// Check the top-level business operation, never a nested profile-resolution step.
// Invoke only before fresh procurement: replay and purchased carry stay readable.
export async function assertFacebookAccountEnabled(store, interfaceId, platform) {
  if (platform !== 'facebook' || !['crawl', 'user-info'].includes(interfaceId)) return
  const route = await store?.get(interfaceId, platform)
  if (!route) throw unavailable()
  if (route.mode === 'paused') throw new AppError(503, 'facebook_account_paused',
    `Facebook ${interfaceId === 'crawl' ? 'account content' : 'account profile'} acquisition is paused`,
    { platform, interface: interfaceId, upstreamDispatched: false })
}

// Comment interfaces: pausing stops new supplier purchases only. Exact replay
// and already purchased buffered rows stay deliverable, like Facebook accounts.
export async function assertCommentRouteEnabled(store, request) {
  const threadsRoute = request?.platform === 'threads' && THREADS_ROUTED_INTERFACES.includes(request.routeInterface)
  if (!COMMENT_INTERFACES.includes(request?.routeInterface) && !threadsRoute) return
  const route = await store?.get(request.routeInterface, request.platform)
  if (!route) throw unavailable()
  if (threadsRoute && route.mode === 'paused') throw new AppError(503, 'threads_acquisition_paused', 'Threads acquisition is paused for this interface',
    { platform: 'threads', interface: request.routeInterface, upstreamDispatched: false })
  if (route.mode === 'paused') throw new AppError(503, 'comment_acquisition_paused',
    request.routeInterface === 'comment-replies' ? 'Comment reply acquisition is paused for this platform' : 'Comment acquisition is paused for this platform',
    { platform: request.platform, interface: request.routeInterface, upstreamDispatched: false })
}
