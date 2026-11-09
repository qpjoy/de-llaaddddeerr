import { Resolver as NodeResolver } from 'node:dns/promises'
import { failed } from '../http.mjs'
import { DNS_RESOLVERS } from '../native/dns.mjs'
import { rdapBootstrap } from '../native/rdap.mjs'

// Read-only queries Hub runs itself (integration plan phase 3): DNS, RDAP and
// Certificate Transparency. Each capability supplies its own `native.run`.
// Nothing keeps running upstream after a call, so a lost dispatch is a plain
// failure that frees its slot (readOnly), never a quarantine.

export const nativeContract = Object.freeze({
  kind: 'native',
  mode: 'sync',
  reconcilable: false,
  readOnly: true,

  normalizeBaseUrl() {
    throw Object.assign(new Error('native engines run inside Hub and take no address'), { code: 'invalid_engine_config' })
  },
  normalizeConfig(config) {
    if (config && Object.keys(config).length) throw Object.assign(new Error('native engines take no extra configuration'), { code: 'invalid_engine_config' })
    return {}
  },

  async dispatch({ job, definition, credential, fetchImpl, deps }) {
    if (typeof definition.native?.run !== 'function') return { outcome: failed('engine_kind_unsupported', '该能力不能由 Hub 原生执行') }
    try {
      return { outcome: await definition.native.run({ input: job.input, credential, fetchImpl, deps }) }
    } catch (error) {
      return { outcome: failed('native_query_failed', '查询执行异常', { cause: String(error?.code || error?.message || error).slice(0, 200) }) }
    }
  },

  // Read-only: one DNS answer from a public resolver and the IANA bootstrap.
  async probe({ fetchImpl, deps = {} }) {
    const started = Date.now()
    const checks = {}
    try {
      const resolver = new (deps.Resolver || NodeResolver)({ timeout: 3_000, tries: 1 })
      resolver.setServers([DNS_RESOLVERS.alidns])
      checks.dns = (await resolver.resolve4('iana.org')).length > 0
    } catch (error) { checks.dns = false; checks.dnsError = String(error?.code || 'failed') }
    try { checks.rdapBootstrap = (await rdapBootstrap(fetchImpl)).size > 0 } catch (error) { checks.rdapBootstrap = false; checks.rdapError = String(error?.code || 'failed') }
    return { baseUrl: null, reachable: true, httpStatus: null, healthy: checks.dns && checks.rdapBootstrap, durationMs: Date.now() - started, checks }
  },
})
