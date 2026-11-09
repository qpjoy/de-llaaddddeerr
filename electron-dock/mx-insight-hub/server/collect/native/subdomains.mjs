import { readBounded, parseJson, failed, transportCause } from '../http.mjs'
import { ctIssuances } from './ct.mjs'

// Passive subdomain discovery from Certificate Transparency (integration plan
// phase 5, package 182). The delivered subfinder had only its crt.sh source
// enabled, so this is the same lookup without a Go binary: names seen in
// issued certificates for the domain, from Cert Spotter and crt.sh, merged.
// Nothing here contacts the domain's own hosts.

export const CRTSH = 'https://crt.sh'
const CRTSH_TIMEOUT_MS = 45_000
const CRTSH_MAX_BYTES = 4 * 1024 * 1024
const MAX_NAMES = 5_000
const LABEL = /^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)$/

// One SAN or common name → normalized name under `domain`, or null.
export function underDomain(raw, domain) {
  if (typeof raw !== 'string') return null
  let name = raw.trim().toLowerCase().replace(/\.$/, '')
  let wildcard = false
  if (name.startsWith('*.')) { wildcard = true; name = name.slice(2) }
  if (name !== domain && !name.endsWith(`.${domain}`)) return null
  if (name.length > 253 || !name.split('.').every(label => LABEL.test(label))) return null
  return { name, wildcard }
}

async function fromCertSpotter({ domain, maxIssuances, credential, fetchImpl }) {
  const outcome = await ctIssuances({ input: { domain, includeSubdomains: true, maxItems: maxIssuances }, credential, fetchImpl })
  if (outcome.status !== 'succeeded') {
    return { source: 'certspotter', status: 'failed', error: outcome.error?.code || 'ct_error', cooldownUntil: outcome.cooldownUntil ?? null, records: [] }
  }
  const records = outcome.result.issuances.map(issuance => ({
    names: Array.isArray(issuance.dns_names) ? issuance.dns_names : [], notBefore: issuance.not_before ?? null, notAfter: issuance.not_after ?? null,
  }))
  return { source: 'certspotter', status: outcome.dataStatus === 'partial' ? 'partial' : 'ok', certificates: records.length, pages: outcome.result.pages, records }
}

async function fromCrtSh({ domain, fetchImpl }) {
  const url = new URL('/', CRTSH)
  url.searchParams.set('q', `%.${domain}`)
  url.searchParams.set('output', 'json')
  url.searchParams.set('deduplicate', 'Y')
  let response
  try {
    response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(CRTSH_TIMEOUT_MS), headers: { accept: 'application/json' } })
  } catch (error) {
    return { source: 'crtsh', status: 'failed', error: error?.name === 'TimeoutError' ? 'crtsh_timeout' : `crtsh_${transportCause(error)}`, records: [] }
  }
  let body
  try {
    body = parseJson(await readBounded(response, CRTSH_MAX_BYTES))
  } catch (error) {
    // A domain with more history than the cap: report it, do not guess.
    return { source: 'crtsh', status: 'failed', error: error?.code === 'response_too_large' ? 'crtsh_too_large' : 'crtsh_unreadable', records: [] }
  }
  if (!response.ok || !Array.isArray(body)) return { source: 'crtsh', status: 'failed', error: `crtsh_http_${response.status}`, records: [] }
  const records = body.map(row => ({
    names: [...String(row?.name_value ?? '').split('\n'), row?.common_name].filter(Boolean),
    notBefore: typeof row?.not_before === 'string' ? `${row.not_before}Z`.replace(/ZZ$/, 'Z') : null,
    notAfter: typeof row?.not_after === 'string' ? `${row.not_after}Z`.replace(/ZZ$/, 'Z') : null,
  }))
  return { source: 'crtsh', status: 'ok', certificates: records.length, records }
}

export async function subdomains({ input, credential, fetchImpl }) {
  const runs = await Promise.all(input.sources.map(source => source === 'certspotter'
    ? fromCertSpotter({ domain: input.domain, maxIssuances: input.maxIssuances, credential, fetchImpl })
    : fromCrtSh({ domain: input.domain, fetchImpl })))
  if (runs.every(run => run.status === 'failed')) {
    const cooldownUntil = runs.find(run => run.cooldownUntil)?.cooldownUntil
    return { ...failed('subdomain_sources_failed', '所有证书透明日志来源都没有返回结果', { sources: runs.map(({ source, error }) => ({ source, error })) }),
      ...(cooldownUntil ? { cooldownUntil } : {}) }
  }
  const names = new Map()
  for (const run of runs) {
    for (const record of run.records) {
      // A name can be both the common name and a SAN (or appear as *.name
      // and name) on one certificate; it counts once per certificate.
      const hits = new Map()
      for (const raw of record.names) {
        const hit = underDomain(raw, input.domain)
        if (hit) hits.set(hit.name, (hits.get(hit.name) || false) || hit.wildcard)
      }
      for (const [name, wildcard] of hits) {
        const hit = { name, wildcard }
        const entry = names.get(hit.name) || { name: hit.name, wildcard: false, sources: new Set(), certificates: 0, firstSeen: null, lastSeen: null }
        entry.wildcard ||= hit.wildcard
        entry.sources.add(run.source)
        entry.certificates += 1
        if (record.notBefore && (!entry.firstSeen || record.notBefore < entry.firstSeen)) entry.firstSeen = record.notBefore
        if (record.notAfter && (!entry.lastSeen || record.notAfter > entry.lastSeen)) entry.lastSeen = record.notAfter
        names.set(hit.name, entry)
      }
    }
  }
  const all = [...names.values()].sort((a, b) => a.name.localeCompare(b.name))
  const list = all.slice(0, MAX_NAMES).map(entry => ({ ...entry, sources: [...entry.sources].sort() }))
  const incomplete = runs.some(run => run.status !== 'ok') || all.length > list.length
  return {
    status: 'succeeded', charge: true, itemCount: list.length,
    dataStatus: !list.length ? 'no_data' : incomplete ? 'partial' : 'success',
    result: {
      domain: input.domain, method: 'certificate_transparency', truncated: all.length > list.length,
      sources: runs.map(({ records, cooldownUntil, ...summary }) => summary),
      subdomains: list, observedAt: new Date().toISOString(),
    },
  }
}
