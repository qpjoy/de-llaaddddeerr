import { Resolver as NodeResolver } from 'node:dns/promises'
import { failed } from '../http.mjs'

// DNS lookups through a chosen public resolver (replaces package 181).
// The Hub host's own resolver is never used: on Internal it answers split
// and cluster-internal names that must not leak through a public API.

export const DNS_RESOLVERS = Object.freeze({
  alidns: '223.5.5.5',
  dnspod: '119.29.29.29',
  cloudflare: '1.1.1.1',
  google: '8.8.8.8',
})
export const DNS_TYPES = Object.freeze(['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'CAA'])
const METHOD = Object.freeze({ A: 'resolve4', AAAA: 'resolve6', CNAME: 'resolveCname', MX: 'resolveMx', NS: 'resolveNs', TXT: 'resolveTxt', SOA: 'resolveSoa', CAA: 'resolveCaa' })
// Answers that mean "no such record", as opposed to a lookup that failed.
const EMPTY = new Set(['ENODATA', 'ENOTFOUND', 'NOTFOUND', 'NXDOMAIN'])

export async function dnsLookup({ input, deps = {} }) {
  const Resolver = deps.Resolver || NodeResolver
  const resolver = new Resolver({ timeout: 3_000, tries: 2 })
  resolver.setServers([DNS_RESOLVERS[input.resolver]])
  const records = {}
  const errors = {}
  let nxdomain = false
  await Promise.all(input.types.map(async type => {
    try {
      const answer = await resolver[METHOD[type]](input.name, ...(type === 'A' || type === 'AAAA' ? [{ ttl: true }] : []))
      records[type] = type === 'TXT' ? answer.map(parts => parts.join('')) : answer
    } catch (error) {
      if (EMPTY.has(error?.code)) {
        records[type] = []
        if (error.code === 'ENOTFOUND' || error.code === 'NXDOMAIN') nxdomain = true
      } else errors[type] = String(error?.code || 'lookup_failed')
    }
  }))
  const found = Object.values(records).some(list => Array.isArray(list) ? list.length : Boolean(list))
  const failedTypes = Object.keys(errors)
  if (failedTypes.length === input.types.length) {
    return failed('dns_lookup_failed', `所有记录类型都查询失败（${[...new Set(Object.values(errors))].join(', ')}）`, { errors })
  }
  return {
    status: 'succeeded', charge: true, itemCount: Object.values(records).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 1), 0),
    dataStatus: failedTypes.length ? 'partial' : found ? 'success' : 'no_data',
    result: { name: input.name, resolver: { key: input.resolver, address: DNS_RESOLVERS[input.resolver] }, nxdomain: nxdomain && !found,
      records, errors, observedAt: new Date().toISOString() },
  }
}
