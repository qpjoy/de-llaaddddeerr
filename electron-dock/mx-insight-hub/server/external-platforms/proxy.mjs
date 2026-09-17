import { fetch as proxyFetch, ProxyAgent } from 'undici'
import { AppError } from '../core/errors.mjs'
import { resolveProviderProxyRoute } from '../agent/control-store.mjs'

// Probe policy defaults. A probe only has to prove that the egress reaches the
// target origin, so its deadline must accommodate a healthy but high-latency
// tunnel: the business call on the same route routinely runs for tens of
// seconds. One retry absorbs a single dropped handshake without becoming a
// retry storm. Selection caching is off by default because skipping the probe
// turns a clean pre-dispatch rejection (never billed) into an ambiguous paid
// transport failure (billing unknown).
export const DEFAULT_PROXY_PROBE_POLICY = Object.freeze({
  timeoutMs: 15_000,
  attempts: 2,
  cacheTtlMs: 0,
})

// A status only disproves the route when it was produced by the proxy itself:
// 407 means the proxy refused us, and 502/503/504 are gateway failures. Every
// other status came back from api.tikhub.io and therefore proves the egress
// works — including 429 and 404, which the previous fixed allowlist treated as
// "unreachable" and which made a stable 7788 route look dead under upstream
// rate limiting.
const ROUTE_FAILURE_STATUSES = new Set([407, 502, 503, 504])

const PROBE_URL = 'https://api.tikhub.io/api/v1/xiaohongshu/app_v2/search_notes'

function boundedInteger(value, { min, max }) {
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null
}

export function resolveProbePolicy(policy) {
  return {
    timeoutMs: boundedInteger(policy?.timeoutMs, { min: 1_000, max: 60_000 })
      ?? DEFAULT_PROXY_PROBE_POLICY.timeoutMs,
    attempts: boundedInteger(policy?.attempts, { min: 1, max: 5 })
      ?? DEFAULT_PROXY_PROBE_POLICY.attempts,
    cacheTtlMs: boundedInteger(policy?.cacheTtlMs, { min: 0, max: 600_000 })
      ?? DEFAULT_PROXY_PROBE_POLICY.cacheTtlMs,
  }
}

/** Identify a route in diagnostics without ever copying proxy credentials. */
export function proxyEndpointLabel(proxyUrl) {
  if (!proxyUrl) return 'direct'
  try {
    const url = new URL(proxyUrl)
    // `host` carries hostname and port but never the userinfo component.
    return `${url.protocol}//${url.host}`
  } catch {
    return 'invalid-proxy-url'
  }
}

function errorLabel(error) {
  const name = error?.name || 'Error'
  const code = error?.code && typeof error.code === 'string' ? ` ${error.code}` : ''
  return `${name}${code}`.slice(0, 120)
}

// A binary that ships ahead of migration 095 must keep TikHub egress working
// rather than fail every paid dispatch on an unknown column; it simply falls
// back to the application probe defaults until the schema catches up.
function probeColumnsMissing(error) {
  return error?.code === '42703'
    && /\bprobe_(timeout_ms|attempts|cache_ttl_ms)\b/.test(`${error?.column || ''} ${error?.message || ''}`)
}

export class ExternalPlatformProxyStore {
  constructor(pool, deploymentEgress = {}) { this.pool = pool; this.deploymentEgress = deploymentEgress }
  async snapshot() {
    const client = await this.pool.connect()
    let probeColumns = true
    try {
      for (;;) {
        try {
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
          const binding = await client.query("SELECT * FROM control.external_platform_proxy_bindings WHERE provider_key = 'tikhub'")
          const settings = await client.query('SELECT * FROM control.agent_proxy_settings WHERE singleton = true')
          const sequences = await client.query(`SELECT sequence_key,display_name,enabled,proxy_keys,direct_fallback${probeColumns ? ',probe_timeout_ms,probe_attempts,probe_cache_ttl_ms' : ''} FROM control.agent_proxy_sequences ORDER BY sequence_key`)
          const endpoints = await client.query('SELECT proxy_key,proxy_url,enabled FROM control.agent_proxy_endpoints')
          await client.query('COMMIT')
          return {
            binding: binding.rows[0] || { egress_mode: 'system-egress', sequence_key: null, revision: 0 },
            control: {
              globalProxySequenceKey: settings.rows[0]?.global_sequence_key,
              globalEgressMode: settings.rows[0]?.egress_mode,
              deploymentEgress: this.deploymentEgress,
              proxySequences: sequences.rows.map(r => ({ sequenceKey: r.sequence_key, displayName: r.display_name, enabled: r.enabled, proxyKeys: r.proxy_keys, directFallback: r.direct_fallback, probePolicy: { timeoutMs: r.probe_timeout_ms ?? null, attempts: r.probe_attempts ?? null, cacheTtlMs: r.probe_cache_ttl_ms ?? null } })),
              proxyEndpoints: endpoints.rows.map(r => ({ proxyKey: r.proxy_key, proxyUrl: r.proxy_url, enabled: r.enabled })),
            },
          }
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {})
          if (probeColumns && probeColumnsMissing(error)) { probeColumns = false; continue }
          throw error
        }
      }
    } finally { client.release() }
  }

  // Provider override wins over the bound sequence, which wins over the
  // application default. A NULL column is "inherit", never "zero".
  #probePolicy(binding, control) {
    const sequence = (control.proxySequences || [])
      .find((candidate) => candidate.sequenceKey === binding.sequence_key)
    const inherited = sequence?.probePolicy || {}
    return {
      timeoutMs: binding.probe_timeout_ms ?? inherited.timeoutMs ?? null,
      attempts: binding.probe_attempts ?? inherited.attempts ?? null,
      cacheTtlMs: binding.probe_cache_ttl_ms ?? inherited.cacheTtlMs ?? null,
    }
  }

  async route() {
    const { binding, control } = await this.snapshot()
    const override = binding.egress_mode === 'inherit' ? undefined : binding.egress_mode === 'system-egress' ? null : binding.sequence_key
    return {
      ...resolveProviderProxyRoute({ baseUrl: 'https://api.tikhub.io' }, control, override),
      probePolicy: this.#probePolicy(binding, control),
    }
  }

  async describe() {
    const { binding, control } = await this.snapshot()
    return {
      mode: binding.egress_mode, sequenceKey: binding.sequence_key,
      revision: Number(binding.revision), updatedAt: binding.updated_at,
      probePolicy: {
        // What the operator set here, what the bound route contributes and what
        // the request will actually use, so an inherited value is never
        // mistaken for an unset one.
        override: {
          timeoutMs: binding.probe_timeout_ms ?? null,
          attempts: binding.probe_attempts ?? null,
          cacheTtlMs: binding.probe_cache_ttl_ms ?? null,
        },
        effective: resolveProbePolicy(this.#probePolicy(binding, control)),
        defaults: DEFAULT_PROXY_PROBE_POLICY,
      },
      sequences: control.proxySequences.map(({ sequenceKey, displayName, enabled, probePolicy }) => ({
        sequenceKey, displayName, enabled, probePolicy,
      })),
      recentProbeFailures: await this.recentProbeFailures().catch(() => []),
    }
  }

  async recentProbeFailures(limit = 10) {
    const { rows } = await this.pool.query(
      `SELECT route_fingerprint, attempts, created_at
         FROM control.external_platform_proxy_probe_failures
        WHERE provider_key = 'tikhub'
        ORDER BY id DESC
        LIMIT $1`,
      [Math.min(Math.max(Number(limit) || 10, 1), 50)],
    )
    return rows.map((row) => ({
      routeFingerprint: row.route_fingerprint,
      attempts: row.attempts,
      createdAt: row.created_at,
    }))
  }

  // Best-effort diagnostics for one failed dispatch. Never part of the paid
  // request's transaction and never able to fail it.
  async recordProbeFailure({ providerKey = 'tikhub', routeFingerprint = null, attempts = [] } = {}) {
    await this.pool.query(
      `INSERT INTO control.external_platform_proxy_probe_failures(provider_key, route_fingerprint, attempts)
       VALUES ($1, $2, $3::jsonb)`,
      [providerKey, routeFingerprint, JSON.stringify(attempts)],
    )
    await this.pool.query(
      `DELETE FROM control.external_platform_proxy_probe_failures
        WHERE provider_key = $1
          AND id <= COALESCE((
            SELECT id FROM control.external_platform_proxy_probe_failures
             WHERE provider_key = $1 ORDER BY id DESC OFFSET 200 LIMIT 1
          ), -1)`,
      [providerKey],
    )
  }

  async update(input) {
    const { mode, sequenceKey = null, expectedRevision, reason, probePolicy } = input || {}
    if (!['inherit','system-egress','proxy-sequence'].includes(mode)
      || (mode === 'proxy-sequence') !== (typeof sequenceKey === 'string' && sequenceKey.length > 0)
      || (mode !== 'proxy-sequence' && sequenceKey !== null)
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
      || typeof reason !== 'string' || !reason.trim() || reason.length > 1000) {
      throw new AppError(400, 'invalid_proxy_binding', 'Valid mode, sequence, revision and reason are required')
    }
    const probe = probePolicy === undefined ? null : normalizeProbePolicyInput(probePolicy)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      if (mode === 'proxy-sequence') {
        const found = await client.query('SELECT enabled FROM control.agent_proxy_sequences WHERE sequence_key=$1 FOR SHARE', [sequenceKey])
        if (found.rows[0]?.enabled !== true) throw new AppError(400, 'proxy_sequence_unavailable', 'Select an enabled Proxy Sequence')
      }
      // An omitted probePolicy leaves the stored override untouched, so the
      // existing egress-only save path keeps its exact statement and audit.
      const result = probe
        ? await client.query(`UPDATE control.external_platform_proxy_bindings
        SET egress_mode=$1,sequence_key=$2,revision=revision+1,reason=$3,updated_at=now(),
            probe_timeout_ms=$5,probe_attempts=$6,probe_cache_ttl_ms=$7
        WHERE provider_key='tikhub' AND revision=$4 RETURNING revision`,
          [mode,sequenceKey,reason.trim(),expectedRevision,probe.timeoutMs,probe.attempts,probe.cacheTtlMs])
        : await client.query(`UPDATE control.external_platform_proxy_bindings
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

// null clears an override back to inherit; a present value must be in range.
function normalizeProbePolicyInput(input) {
  if (input === null) return { timeoutMs: null, attempts: null, cacheTtlMs: null }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(400, 'invalid_proxy_probe_policy', 'Probe policy must be an object or null')
  }
  const bounds = {
    timeoutMs: { min: 1_000, max: 60_000 },
    attempts: { min: 1, max: 5 },
    cacheTtlMs: { min: 0, max: 600_000 },
  }
  const normalized = {}
  for (const [field, range] of Object.entries(bounds)) {
    const value = input[field]
    if (value == null) { normalized[field] = null; continue }
    const bounded = boundedInteger(value, range)
    if (bounded == null) {
      throw new AppError(400, 'invalid_proxy_probe_policy', `${field} must be an integer between ${range.min} and ${range.max}`)
    }
    normalized[field] = bounded
  }
  return normalized
}

// Probe only an unauthenticated fixed API URL. Never fail over a paid request,
// including on timeout, HTTP 5xx, response parse failure or unknown billing.
export function createTikHubProxyFetch(store, {
  fetchImpl = proxyFetch,
  makeAgent = url => new ProxyAgent(url),
  now = () => Date.now(),
} = {}) {
  const selection = new Map()
  return async (url, options = {}) => {
    const target = new URL(url)
    if (target.origin !== 'https://api.tikhub.io') throw new Error('Unexpected TikHub origin')
    const route = await store.route()
    const policy = resolveProbePolicy(route.probePolicy)
    const candidates = [...route.proxyUrls, ...(route.directFallback ? [null] : [])]
    if (!candidates.length) throw new AppError(503, 'proxy_route_unavailable', 'No enabled System Proxy route')
    const cached = policy.cacheTtlMs > 0 ? selection.get(route.fingerprint) : null
    const trusted = cached && cached.expiresAt > now() && candidates.includes(cached.proxyUrl)
      ? cached.proxyUrl
      : undefined
    const attempts = []
    for (const candidate of candidates) {
      const dispatcher = candidate ? makeAgent(candidate) : undefined
      try {
        // Direct-only selection needs no probe; the ordinary adapter handles it.
        if ((candidate || candidates.length > 1) && candidate !== trusted) {
          // A rejected candidate is a recorded verdict, not an exception, so
          // the only throws that escape here are the caller's own deadline and
          // the paid request itself. Neither may fail over to another proxy.
          const verdict = await probeCandidate({
            fetchImpl, dispatcher, candidate, policy, signal: options.signal, now,
          })
          attempts.push(...verdict.attempts)
          if (verdict.callerAborted) {
            await recordFailure(store, route, attempts)
            throw new AppError(
              503,
              'proxy_routes_unreachable',
              `Proxy probe deadline exceeded before business dispatch: ${summarize(attempts)}`,
              { attempts },
            )
          }
          if (!verdict.reachable) continue
        }
        if (policy.cacheTtlMs > 0) {
          selection.set(route.fingerprint, { proxyUrl: candidate, expiresAt: now() + policy.cacheTtlMs })
        }
        return await fetchImpl(url, { ...options, dispatcher })
      } finally {
        // Graceful close waits for the returned paid response body to finish.
        if (dispatcher) void dispatcher.close().catch(() => {})
      }
    }
    await recordFailure(store, route, attempts)
    throw new AppError(
      503,
      'proxy_routes_unreachable',
      `System Proxy sequence connectivity probes failed: ${summarize(attempts)}`,
      { attempts },
    )
  }
}

async function probeCandidate({ fetchImpl, dispatcher, candidate, policy, signal, now }) {
  const endpoint = proxyEndpointLabel(candidate)
  const attempts = []
  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    const startedAt = now()
    try {
      const deadline = AbortSignal.timeout(policy.timeoutMs)
      const probe = await fetchImpl(PROBE_URL, {
        dispatcher,
        method: 'GET',
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      })
      await probe.body?.cancel()
      const reachable = !ROUTE_FAILURE_STATUSES.has(probe.status)
      attempts.push({ endpoint, attempt, status: probe.status, error: null, durationMs: now() - startedAt })
      if (reachable) return { reachable: true, attempts }
    } catch (error) {
      attempts.push({ endpoint, attempt, status: null, error: errorLabel(error), durationMs: now() - startedAt })
      // The caller's own deadline is a decision about the whole dispatch, not
      // about this route: stop immediately instead of burning its remaining
      // budget on further probes or another proxy.
      if (signal?.aborted) return { reachable: false, callerAborted: true, attempts }
    }
  }
  return { reachable: false, attempts }
}

function summarize(attempts) {
  if (!attempts.length) return 'no probe was attempted'
  return attempts
    .map((entry) => `${entry.endpoint}#${entry.attempt} ${entry.status ?? entry.error} in ${entry.durationMs}ms`)
    .join(', ')
    .slice(0, 500)
}

// Diagnostics must never turn a recorded proxy failure into a different one.
async function recordFailure(store, route, attempts) {
  if (typeof store.recordProbeFailure !== 'function' || !attempts.length) return
  try {
    await store.recordProbeFailure({
      providerKey: 'tikhub',
      routeFingerprint: route.fingerprint ?? null,
      attempts,
    })
  } catch { /* the dispatch failure is the reportable outcome */ }
}
