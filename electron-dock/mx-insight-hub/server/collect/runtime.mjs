import { createExternalPlatformCredentialStore } from '../external-platforms/credentials-store.mjs'
import { ExternalPlatformProxyStore, createApifyProxyFetch } from '../external-platforms/proxy.mjs'
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
  const fetchFor = kind => kind === 'apify' ? apifyFetch : globalThis.fetch
  const executor = config.listenerMode === 'public' ? null : new CollectExecutor({
    jobs, ledger, contracts, credentialsFor: credentials.read, fetchFor, logger,
    policyFor: (context, platform) => hub.usagePolicy(context, platform),
  })
  const service = new CollectService({ jobs, ledger, contracts, executor, credentials, fetchFor,
    egressStores: apifyEgress ? { apify: apifyEgress } : {}, legacy })
  return { jobs, executor, service }
}
