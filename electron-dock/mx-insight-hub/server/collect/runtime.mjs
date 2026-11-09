import { createExternalPlatformCredentialStore } from '../external-platforms/credentials-store.mjs'
import { ExternalPlatformProxyStore, createApifyProxyFetch, createProviderProxySelector, createShodanProxyFetch } from '../external-platforms/proxy.mjs'
import { COLLECT_RUNNER_SLOTS } from '../../shared/collect-engines.mjs'
import { createCollectContracts } from './contracts/index.mjs'
import { CollectExecutor } from './executor.mjs'
import { CollectService } from './service.mjs'
import { createCollectStore } from './store.mjs'

// Engine credentials live in the shared provider credential store (migration
// 052), referenced by provider key; never in engine config or MX_* env.
export function createCollectCredentials(pool) {
  const stores = new Map()
  const store = provider => {
    if (!stores.has(provider)) stores.set(provider, createExternalPlatformCredentialStore({ pool, providerKey: provider }))
    return stores.get(provider)
  }
  return {
    read: provider => store(provider).readCredential(provider),
    describe: provider => store(provider).describeCredential(provider),
    update: (provider, input, actor) => store(provider).updateCredential(provider, input, { updatedBy: actor }),
  }
}

// Public processes accept and read jobs; only Admin (or a combined process)
// runs the executor. The store arbitrates slots either way.
export function createCollectRuntime({ config, pool, ledger, hub, legacy = {}, logger = console }) {
  const jobs = createCollectStore(pool)
  const contracts = createCollectContracts()
  const credentials = createCollectCredentials(pool)
  // api.apify.com goes out through the `apify` System Proxy binding (D19,
  // migration 184). Without a database (memory mode) calls go direct.
  const apifyEgress = pool ? new ExternalPlatformProxyStore(pool, config.deploymentEgress, { providerKey: 'apify' }) : null
  const apifyFetch = apifyEgress ? createApifyProxyFetch(apifyEgress) : globalThis.fetch
  // api.shodan.io likewise goes out through the `shodan` binding (migration 185).
  const shodanEgress = pool ? new ExternalPlatformProxyStore(pool, config.deploymentEgress, { providerKey: 'shodan' }) : null
  const shodanFetch = shodanEgress ? createShodanProxyFetch(shodanEgress) : globalThis.fetch
  const fetchFor = kind => kind === 'apify' ? apifyFetch : kind === 'shodan' ? shodanFetch : globalThis.fetch
  // Runner slots that need overseas egress (googleplay: migration 186,
  // overseas: 187): Hub picks the proxy from the binding and passes it with
  // each invocation. The runner shares the Hub node's network, so
  // 127.0.0.1:7788 means the same listener to both. Memory mode: direct.
  const runnerEgress = Object.fromEntries(pool ? [...new Set(Object.values(COLLECT_RUNNER_SLOTS).map(slot => slot.egressProvider).filter(Boolean))]
    .map(provider => [provider, new ExternalPlatformProxyStore(pool, config.deploymentEgress, { providerKey: provider })]) : [])
  const selectors = Object.fromEntries(Object.entries(runnerEgress).map(([provider, store]) => [provider, createProviderProxySelector(store, { providerKey: provider })]))
  const egressFor = async provider => (selectors[provider] ? selectors[provider]() : null)
  const options = { jobs, ledger, contracts, credentialsFor: credentials.read, fetchFor, logger, deps: { egressFor },
    policyFor: (context, platform) => hub.usagePolicy(context, platform) }
  const executor = config.listenerMode === 'public' ? null : new CollectExecutor(options)
  // Public processes run synchronous queries inline with an executor that is
  // never started; slots are still arbitrated in PG.
  const runner = executor || new CollectExecutor(options)
  const service = new CollectService({ jobs, ledger, contracts, executor, runner, credentials, fetchFor,
    egressStores: { ...(apifyEgress ? { apify: apifyEgress } : {}), ...(shodanEgress ? { shodan: shodanEgress } : {}),
      ...runnerEgress }, legacy })
  return { jobs, executor, service }
}
