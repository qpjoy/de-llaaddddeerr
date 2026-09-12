import { fetch as proxyFetch, ProxyAgent } from 'undici'
import { AppError } from '../core/errors.mjs'
import { resolveProviderProxyRoute } from '../agent/control-store.mjs'

export class ExternalPlatformProxyStore {
  constructor(pool, deploymentEgress = {}) { this.pool = pool; this.deploymentEgress = deploymentEgress }
  async snapshot() {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const binding = await client.query("SELECT * FROM control.external_platform_proxy_bindings WHERE provider_key = 'tikhub'")
      const settings = await client.query('SELECT * FROM control.agent_proxy_settings WHERE singleton = true')
      const sequences = await client.query('SELECT sequence_key,display_name,enabled,proxy_keys,direct_fallback FROM control.agent_proxy_sequences ORDER BY sequence_key')
      const endpoints = await client.query('SELECT proxy_key,proxy_url,enabled FROM control.agent_proxy_endpoints')
      await client.query('COMMIT')
      return {
        binding: binding.rows[0] || { egress_mode: 'system-egress', sequence_key: null, revision: 0 },
        control: {
          globalProxySequenceKey: settings.rows[0]?.global_sequence_key,
          globalEgressMode: settings.rows[0]?.egress_mode,
          deploymentEgress: this.deploymentEgress,
          proxySequences: sequences.rows.map(r => ({ sequenceKey: r.sequence_key, displayName: r.display_name, enabled: r.enabled, proxyKeys: r.proxy_keys, directFallback: r.direct_fallback })),
          proxyEndpoints: endpoints.rows.map(r => ({ proxyKey: r.proxy_key, proxyUrl: r.proxy_url, enabled: r.enabled })),
        },
      }
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    finally { client.release() }
  }
  async route() {
    const { binding, control } = await this.snapshot()
    const override = binding.egress_mode === 'inherit' ? undefined : binding.egress_mode === 'system-egress' ? null : binding.sequence_key
    return resolveProviderProxyRoute({ baseUrl: 'https://api.tikhub.io' }, control, override)
  }
  async describe() {
    const { binding, control } = await this.snapshot()
    return {
      mode: binding.egress_mode, sequenceKey: binding.sequence_key,
      revision: Number(binding.revision), updatedAt: binding.updated_at,
      sequences: control.proxySequences.map(({ sequenceKey, displayName, enabled }) => ({ sequenceKey, displayName, enabled })),
    }
  }
  async update(input) {
    const { mode, sequenceKey = null, expectedRevision, reason } = input || {}
    if (!['inherit','system-egress','proxy-sequence'].includes(mode)
      || (mode === 'proxy-sequence') !== (typeof sequenceKey === 'string' && sequenceKey.length > 0)
      || (mode !== 'proxy-sequence' && sequenceKey !== null)
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
      || typeof reason !== 'string' || !reason.trim() || reason.length > 1000) {
      throw new AppError(400, 'invalid_proxy_binding', 'Valid mode, sequence, revision and reason are required')
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      if (mode === 'proxy-sequence') {
        const found = await client.query('SELECT enabled FROM control.agent_proxy_sequences WHERE sequence_key=$1 FOR SHARE', [sequenceKey])
        if (found.rows[0]?.enabled !== true) throw new AppError(400, 'proxy_sequence_unavailable', 'Select an enabled Proxy Sequence')
      }
      const result = await client.query(`UPDATE control.external_platform_proxy_bindings
        SET egress_mode=$1,sequence_key=$2,revision=revision+1,reason=$3,updated_at=now()
        WHERE provider_key='tikhub' AND revision=$4 RETURNING revision`, [mode,sequenceKey,reason.trim(),expectedRevision])
      if (!result.rowCount) throw new AppError(409, 'proxy_revision_conflict', 'Proxy settings changed; refresh before saving')
      await client.query(`INSERT INTO control.external_platform_proxy_events(provider_key,revision,egress_mode,sequence_key,actor,reason)
        VALUES ('tikhub',$1,$2,$3,'admin-token',$4)`, [result.rows[0].revision,mode,sequenceKey,reason.trim()])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    finally { client.release() }
    return this.describe()
  }
}

// Probe only an unauthenticated fixed API URL. Never fail over a paid request,
// including on timeout, HTTP 5xx, response parse failure or unknown billing.
export function createTikHubProxyFetch(store, { fetchImpl = proxyFetch, makeAgent = url => new ProxyAgent(url) } = {}) {
  return async (url, options = {}) => {
    const target = new URL(url)
    if (target.origin !== 'https://api.tikhub.io') throw new Error('Unexpected TikHub origin')
    const route = await store.route()
    const candidates = [...route.proxyUrls, ...(route.directFallback ? [null] : [])]
    if (!candidates.length) throw new AppError(503, 'proxy_route_unavailable', 'No enabled System Proxy route')
    for (const candidate of candidates) {
      const dispatcher = candidate ? makeAgent(candidate) : undefined
      let selected = false
      try {
        // Direct-only selection needs no probe; the ordinary adapter handles it.
        if (candidate || candidates.length > 1) {
          const signal = options.signal
            ? AbortSignal.any([options.signal, AbortSignal.timeout(5000)])
            : AbortSignal.timeout(5000)
          const probe = await fetchImpl('https://api.tikhub.io/api/v1/xiaohongshu/app_v2/search_notes', {
            dispatcher, method: 'GET', redirect: 'error', signal,
          })
          await probe.body?.cancel()
          if (![200,401,403,422].includes(probe.status)) continue
        }
        selected = true
        return await fetchImpl(url, { ...options, dispatcher })
      } catch (error) {
        if (selected) throw error
        if (options.signal?.aborted) throw new AppError(503, 'proxy_routes_unreachable', 'Proxy probe deadline exceeded before business dispatch')
      } finally {
        // Graceful close waits for the returned paid response body to finish.
        if (dispatcher) void dispatcher.close().catch(() => {})
      }
    }
    throw new AppError(503, 'proxy_routes_unreachable', 'System Proxy sequence connectivity probes failed')
  }
}
