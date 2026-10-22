import { createSelfHostedStore } from './store.mjs'
import { WechatSelfHostedExecutor } from './executor.mjs'
import { WechatSelfHostedService } from './service.mjs'
import { WECHAT_ENGINE_ID, DEFAULT_ENGINE_BASE_URL } from './wechat-contract.mjs'

const originOf = value => { try { return new URL(value).origin } catch { return null } }

// Public processes accept and read jobs; only Admin (or a combined process)
// runs the executor. The store arbitrates the engine slot either way.
export function createWechatSelfHostedRuntime({ config, pool, ledger, hub, logger = console }) {
  const jobs = createSelfHostedStore(pool, { engines: [{ id: WECHAT_ENGINE_ID, baseUrl: DEFAULT_ENGINE_BASE_URL }] })
  const legacyOrigin = originOf(config.nightAll?.baseUrl)
  const token = config.nightAll?.serviceToken || null
  // The legacy Night-All service token only goes to the origin it was issued for.
  const serviceTokenFor = baseUrl => token && legacyOrigin && originOf(baseUrl) === legacyOrigin ? token : null
  const executor = config.listenerMode === 'public' ? null : new WechatSelfHostedExecutor({
    jobs, ledger, serviceTokenFor, logger, policyFor: (context, platform) => hub.usagePolicy(context, platform),
  })
  return { jobs, executor, service: new WechatSelfHostedService({ jobs, ledger, executor }) }
}
