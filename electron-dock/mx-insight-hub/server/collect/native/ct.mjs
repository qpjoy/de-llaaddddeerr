import { readBounded, parseJson, failed, transportCause } from '../http.mjs'

// Certificate issuances from Certificate Transparency via SSLMate Cert Spotter
// (the on-demand half of package 182; the monitoring half needs persistent
// state and waits for the runner). Works unauthenticated within Cert Spotter's
// free allowance; an engine credential, when set, is sent as a Bearer token.

export const CERTSPOTTER_API = 'https://api.certspotter.com'
const REQUEST_TIMEOUT_MS = 15_000
const MAX_PAGES = 10
const ID = /^[0-9]{1,30}$/

export async function ctIssuances({ input, credential, fetchImpl }) {
  const items = []
  let after = null
  let pages = 0
  let exhausted = false
  while (items.length < input.maxItems && pages < MAX_PAGES) {
    const url = new URL('/v1/issuances', CERTSPOTTER_API)
    url.searchParams.set('domain', input.domain)
    if (input.includeSubdomains) url.searchParams.set('include_subdomains', 'true')
    url.searchParams.append('expand', 'dns_names')
    url.searchParams.append('expand', 'issuer')
    if (after) url.searchParams.set('after', after)
    let response
    try {
      response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { accept: 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}) } })
    } catch (error) {
      if (!items.length) return failed('ct_unreachable', 'Cert Spotter 没有应答', { cause: transportCause(error) })
      break
    }
    let body
    try { body = parseJson(await readBounded(response, 4 * 1024 * 1024)) } catch { body = undefined }
    if (response.status === 429) {
      const retry = Number(response.headers.get('retry-after'))
      const cooldownUntil = Date.now() + (Number.isFinite(retry) && retry > 0 ? Math.min(retry, 3_600) : 60) * 1000
      if (!items.length) return { ...failed('ct_rate_limited', 'Cert Spotter 限流（免费额度用完时也会这样）'), cooldownUntil }
      break
    }
    if (response.status === 401 || response.status === 403) return failed('ct_auth_failed', 'Cert Spotter 拒绝了凭据')
    if (response.status === 400) return failed('ct_query_rejected', 'Cert Spotter 拒绝了查询', { upstreamCode: body?.code ?? null })
    if (!response.ok || !Array.isArray(body)) {
      if (!items.length) return failed('ct_error', `Cert Spotter 返回 HTTP ${response.status}`, { upstreamStatus: response.status })
      break
    }
    pages++
    items.push(...body.slice(0, input.maxItems - items.length))
    const last = body.at(-1)?.id
    if (!body.length || typeof last !== 'string' || !ID.test(last)) { exhausted = true; break }
    after = last
  }
  const complete = exhausted || items.length >= input.maxItems
  return {
    status: 'succeeded', charge: true, itemCount: items.length,
    dataStatus: !items.length ? 'no_data' : complete ? 'success' : 'partial',
    result: { domain: input.domain, includeSubdomains: input.includeSubdomains, source: 'sslmate-certspotter', pages, exhausted,
      issuances: items, observedAt: new Date().toISOString() },
  }
}
