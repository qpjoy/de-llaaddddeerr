import { readBounded, parseJson, failed, unknown, notDelivered, transportCause, MAX_RESULT_BYTES } from '../http.mjs'

// Shodan REST API (package 188), synchronous and read-only. Calls go to
// api.shodan.io through the `shodan` System Proxy binding (migration 185).
// The account allows one request per second: every finished call paces the
// engine (silent PG cooldown, shared by every process) for minIntervalMs.
// The key travels as Shodan requires (query string) and is never stored or
// echoed; error details carry no URL.

export const SHODAN_API = 'https://api.shodan.io'
const REQUEST_TIMEOUT_MS = 20_000
const EGRESS_REFUSED = new Set(['proxy_routes_unreachable', 'proxy_route_unavailable'])

async function call(fetchImpl, path, query, credential) {
  const url = new URL(path, SHODAN_API)
  for (const [key, value] of Object.entries(query)) if (value !== null && value !== undefined) url.searchParams.set(key, String(value))
  url.searchParams.set('key', credential)
  const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { accept: 'application/json' } })
  return { status: response.status, headers: response.headers, body: parseJson(await readBounded(response, MAX_RESULT_BYTES)) }
}

const upstreamMessage = body => typeof body?.error === 'string' ? body.error.slice(0, 300) : null

export const shodanContract = Object.freeze({
  kind: 'shodan',
  mode: 'sync',
  reconcilable: false,
  readOnly: true,
  minIntervalMs: 1_100,

  normalizeBaseUrl() {
    throw Object.assign(new Error('Shodan engines use the fixed api.shodan.io address'), { code: 'invalid_engine_config' })
  },
  normalizeConfig(config) {
    if (config && Object.keys(config).length) throw Object.assign(new Error('shodan engines take no extra configuration'), { code: 'invalid_engine_config' })
    return {}
  },

  async dispatch({ job, definition, credential, fetchImpl }) {
    const request = definition.shodan(job.input)
    let answer
    try {
      answer = await call(fetchImpl, request.path, request.query, credential)
    } catch (error) {
      if (EGRESS_REFUSED.has(error?.code)) return { outcome: failed('egress_unavailable', 'System Proxy 出口不可用，请求未发出', { cause: error.code }) }
      if (notDelivered(error)) return { outcome: failed('engine_unreachable', '无法连接 Shodan，请求未送达', { cause: transportCause(error) }) }
      if (error?.code === 'response_too_large') return { outcome: failed('shodan_response_too_large', 'Shodan 应答超过大小上限') }
      // Nothing keeps running upstream, but a lost answer may still have used
      // a query credit: unknown for billing review, the slot is free.
      return { outcome: unknown('shodan_response_lost', 'Shodan 应答丢失，查询额度是否已扣除未知', { cause: transportCause(error) }, null) }
    }
    const { status, body } = answer
    const message = upstreamMessage(body)
    if (status === 200 && body && typeof body === 'object') {
      const itemCount = request.count ? request.count(body) : 1
      return { outcome: { status: 'succeeded', charge: true, itemCount, dataStatus: itemCount === 0 ? 'no_data' : 'success',
        result: { source: 'shodan', endpoint: request.endpoint, operation: request.operation, data: body, observedAt: new Date().toISOString() } } }
    }
    // Shodan answers 404 for an IP or domain it has no data on.
    if (status === 404) {
      return { outcome: { status: 'succeeded', charge: true, itemCount: 0, dataStatus: 'no_data',
        result: { source: 'shodan', endpoint: request.endpoint, operation: request.operation, data: null, message, observedAt: new Date().toISOString() } } }
    }
    if (status === 401) return { outcome: failed('shodan_auth_failed', 'Shodan 拒绝了 API Key') }
    if (status === 402 || status === 403) return { outcome: failed('shodan_plan_insufficient', message || 'Shodan 账号套餐或额度不支持该查询', { upstreamStatus: status }) }
    if (status === 400) return { outcome: failed('shodan_query_rejected', message || 'Shodan 拒绝了查询', { upstreamStatus: status }) }
    if (status === 429) return { outcome: { ...failed('shodan_rate_limited', 'Shodan 限流'), cooldownUntil: Date.now() + 5_000 } }
    return { outcome: unknown('shodan_server_error', `Shodan 返回 HTTP ${status}，查询额度是否已扣除未知`, { upstreamStatus: status }, null) }
  },

  // GET /api-info is free: plan and remaining credits.
  async probe({ credential, fetchImpl }) {
    const started = Date.now()
    if (!credential) return { baseUrl: SHODAN_API, reachable: false, httpStatus: null, healthy: false, durationMs: 0, error: 'credential_missing' }
    try {
      const { status, body } = await call(fetchImpl, '/api-info', {}, credential)
      const ok = status === 200 && body && typeof body === 'object'
      return { baseUrl: SHODAN_API, reachable: true, httpStatus: status, healthy: ok, durationMs: Date.now() - started,
        account: ok ? { plan: typeof body.plan === 'string' ? body.plan : null } : null,
        usage: ok ? { queryCredits: Number.isInteger(body.query_credits) ? body.query_credits : null,
          scanCredits: Number.isInteger(body.scan_credits) ? body.scan_credits : null } : null,
        error: ok ? null : status === 401 ? 'credential_rejected' : `http_${status}` }
    } catch (error) {
      return { baseUrl: SHODAN_API, reachable: false, httpStatus: null, healthy: false, durationMs: Date.now() - started,
        error: EGRESS_REFUSED.has(error?.code) ? 'egress_unavailable' : error?.name === 'TimeoutError' ? 'timeout' : transportCause(error) }
    }
  },
})
