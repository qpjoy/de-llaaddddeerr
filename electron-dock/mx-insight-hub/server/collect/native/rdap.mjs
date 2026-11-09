import { isIP } from 'node:net'
import { readBounded, parseJson, failed, transportCause } from '../http.mjs'

// Domain registration data over RDAP (RFC 9082/9083), replacing package 180's
// port-43 WHOIS. The registry server comes from the IANA bootstrap file
// (RFC 9224), cached per process; it is never taken from caller input.

export const RDAP_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json'
const BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 10_000
const MAX_BYTES = 1024 * 1024
const MAX_REDIRECTS = 2
let cache = null

// Only public https hosts by name: never an IP literal, a port or credentials.
function safeTarget(value) {
  let url
  try { url = new URL(value) } catch { return null }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || isIP(url.hostname.replace(/^\[|\]$/g, ''))) return null
  return url
}

export async function rdapBootstrap(fetchImpl, now = Date.now()) {
  if (cache && now - cache.at < BOOTSTRAP_TTL_MS) return cache.services
  const response = await fetchImpl(RDAP_BOOTSTRAP_URL, { redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { accept: 'application/json' } })
  const body = parseJson(await readBounded(response, 2 * MAX_BYTES))
  if (!response.ok || !Array.isArray(body?.services)) throw Object.assign(new Error('RDAP bootstrap unavailable'), { code: 'rdap_bootstrap_unavailable' })
  const services = new Map()
  for (const [tlds, urls] of body.services) {
    const base = (urls || []).map(safeTarget).find(Boolean)
    if (base) for (const tld of tlds || []) services.set(String(tld).toLowerCase(), base.href.endsWith('/') ? base.href : `${base.href}/`)
  }
  cache = { at: now, services }
  return services
}

export function resetRdapBootstrap() { cache = null }

export async function rdapDomain({ input, fetchImpl }) {
  let services
  try { services = await rdapBootstrap(fetchImpl) } catch (error) {
    return failed('rdap_bootstrap_unavailable', '无法读取 IANA RDAP 引导表', { cause: error?.code || transportCause(error) })
  }
  const labels = input.domain.split('.')
  // Longest matching suffix wins (e.g. a registry for co.uk before uk).
  const base = labels.map((_, index) => labels.slice(index).join('.')).map(suffix => services.get(suffix)).find(Boolean)
  if (!base) return failed('rdap_unsupported_tld', `后缀 .${labels.at(-1)} 没有登记 RDAP 服务，暂不支持`)
  let url = new URL(`domain/${encodeURIComponent(input.domain)}`, base)
  for (let hop = 0; ; hop++) {
    let response
    try {
      response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { accept: 'application/rdap+json, application/json' } })
    } catch (error) {
      return failed('rdap_unreachable', 'RDAP 服务没有应答', { server: url.origin, cause: transportCause(error) })
    }
    if (response.status >= 300 && response.status < 400) {
      const next = safeTarget(new URL(response.headers.get('location') || '', url).href)
      if (!next || hop >= MAX_REDIRECTS) return failed('rdap_redirect_refused', 'RDAP 服务重定向到不受信任的地址或次数过多', { server: url.origin })
      url = next
      continue
    }
    let body
    try { body = parseJson(await readBounded(response, MAX_BYTES)) } catch {
      return failed('rdap_response_too_large', 'RDAP 应答超过大小上限', { server: url.origin })
    }
    if (response.status === 404) {
      return { status: 'succeeded', dataStatus: 'no_data', charge: true, itemCount: 0,
        result: { domain: input.domain, server: url.origin, found: false, observedAt: new Date().toISOString() } }
    }
    if (response.status === 429) {
      const retry = Number(response.headers.get('retry-after'))
      return { ...failed('rdap_rate_limited', 'RDAP 服务限流', { server: url.origin }), cooldownUntil: Date.now() + (Number.isFinite(retry) && retry > 0 ? Math.min(retry, 600) : 30) * 1000 }
    }
    if (!response.ok || !body || typeof body !== 'object') {
      return failed('rdap_error', `RDAP 服务返回 HTTP ${response.status}`, { server: url.origin, upstreamStatus: response.status })
    }
    return { status: 'succeeded', dataStatus: 'success', charge: true, itemCount: 1,
      result: { domain: input.domain, server: url.origin, found: true, rdap: body, observedAt: new Date().toISOString() } }
  }
}
