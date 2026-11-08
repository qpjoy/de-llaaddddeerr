import { AppError } from '../core/errors.mjs'

// Selects the supplier gateway for one comment request before any purchase.
// - A signed Hub cursor resumes only on the supplier that issued it.
// - Otherwise the saved Strategy Search policy decides. `priority` uses the
//   fallback only when the primary is not ready (credential, operation state,
//   price) and the fallback is; it never retries after a supplier was called.
// - A paused policy still routes to the primary so exact replays and bought
//   buffered rows stay readable; the workflow refuses new purchases.
export function createCommentRouter({ interfaceId, gateways, policyStore, platformFor, recipeFor, cursorProvider, invoke, logger = null }) {
  async function ready(platform, provider, context) {
    const recipe = recipeFor(platform, provider), gateway = gateways[platform]?.[provider]
    if (!recipe?.available || !gateway) return false
    const operation = `native.${recipe.key}`
    try {
      const readiness = await gateway.nativeReadiness({ consumerId: context.consumer.id, operationKeys: [operation] })
      return readiness[operation] === true
    } catch (error) {
      logger?.warn?.(`[comment-routing] readiness unavailable for ${platform}/${provider}: ${error.code || error.name}`)
      return false
    }
  }
  async function select(context, platform, body) {
    const platformGateways = gateways[platform]
    if (!platformGateways) throw new AppError(400, 'platform_operation_unsupported', 'Comments are not registered for this platform')
    const pinned = cursorProvider(body, { gateway: Object.values(platformGateways)[0], context })
    if (pinned) {
      const provider = pinned === 'baseline' ? recipeFor(platform, null)?.provider : pinned
      if (!platformGateways[provider]) throw new AppError(400, 'invalid_cursor', 'The cursor belongs to a supplier that no longer serves this platform; restart explicitly')
      return { provider, reason: 'cursor' }
    }
    const route = await policyStore.get(interfaceId, platform)
    if (!route) throw new AppError(503, 'strategy_search_route_unavailable', 'Comment routing configuration is unavailable')
    if (route.mode === 'priority' && route.fallbackProvider && !await ready(platform, route.primaryProvider, context)
      && await ready(platform, route.fallbackProvider, context)) return { provider: route.fallbackProvider, reason: 'fallback' }
    return { provider: route.primaryProvider, reason: route.mode }
  }
  return async (context, input) => {
    const platform = platformFor(input.body)
    const { provider, reason } = await select(context, platform, input.body)
    const gateway = gateways[platform]?.[provider]
    if (!gateway) throw new AppError(503, 'strategy_search_route_unavailable', 'The selected comment supplier is unavailable', { platform, provider })
    return invoke(gateway, context, { ...input, platform, routing: { interface: interfaceId, provider, reason } })
  }
}
