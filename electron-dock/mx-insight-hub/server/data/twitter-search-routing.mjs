import { AppError, SearchAdmissionNotStartedError } from '../core/errors.mjs'
import { RAW_SEARCH_VERSION } from '../contracts/raw-search.mjs'
import { TIKHUB_CONTENT_SEARCH_VERSION } from '../contracts/tikhub-content-search.mjs'
import { createDataSearchCursorCodec } from '../external-platforms/cursor.mjs'
import { assertTwitterSearchAvailable } from './twitter-search-availability.mjs'
import { pinTwitterSearchFallback, assertTwitterSearchFallback } from '../external-platforms/twitter-search-fallback.mjs'
import { effectiveTwitterSearchParameters, twitterParametersSupportTikHub, twitterTikHubParameters } from '../contracts/twitter-search-parameters.mjs'

const TIKHUB_RECIPE = 't.twitter_web_fetch_search_timeline'
const owned = (row, context) => row && row.tenantId === context.tenant.id
  && row.consumerId === context.consumer.id && row.apiKeyId === context.apiKey.id && row.platform === 'twitter'

export async function resolveTwitterSearchProvider({ provider = 'auto', policy = null, capabilities, options }) {
  const route = policy ?? { mode: provider === 'auto' ? 'priority' : 'fixed',
    primaryProvider: provider === 'auto' ? 'rapidapi' : provider, fallbackProvider: 'tikhub' }
  if (route.mode === 'paused') return { provider: route.primaryProvider, ready: false }
  if (route.mode === 'fixed') return { provider: route.primaryProvider, ...await capabilities(route.primaryProvider, options) }
  // Initial selection uses readiness. A definitive first-page RapidAPI 400
  // has a separate, receipt-backed handoff within the same delivery below.
  const primary = await capabilities(route.primaryProvider, options).catch(() => ({ ready: false }))
  if (primary.ready) return { provider: route.primaryProvider, ready: true }
  const fallback = await capabilities(route.fallbackProvider, options).catch(() => ({ ready: false }))
  return fallback.ready ? { provider: route.fallbackProvider, ready: true } : { provider: route.primaryProvider, ready: false }
}

export function twitterSearchCursorProvider(cursor, { apiKeyPepper, context }) {
  if (!cursor) return null
  // The old gateway authenticates mxnc1 and preserves its original replay and
  // explicit restart boundary; it must never become a TikHub continuation.
  if (typeof cursor === 'string' && cursor.startsWith('mxnc1.')) return 'rapidapi'
  try {
    const state = createDataSearchCursorCodec(apiKeyPepper, `${context.consumer.id}:${context.apiKey.id}`).decode(cursor)
    if (state.version === RAW_SEARCH_VERSION && (state.provider == null || state.provider === 'rapidapi')) return 'rapidapi'
    if (state.version === TIKHUB_CONTENT_SEARCH_VERSION && state.provider === 'tikhub'
      && state.platform === 'twitter' && state.recipe === TIKHUB_RECIPE) return 'tikhub'
  } catch { /* Do not use unauthenticated JSON or a prefix to select a supplier. */ }
  throw new AppError(400, 'invalid_cursor', 'The Twitter search cursor is invalid or belongs to another Key')
}

async function savedProvider(row, { usageStore, rapidGateway, tikHubGateway }) {
  if (row.acquisitionRequest?.searchProvider === 'tikhub'
    && row.acquisitionRequest?.searchContractVersion === TIKHUB_CONTENT_SEARCH_VERSION) return 'tikhub'
  if (row.acquisitionRequest?.contentSearch?.version === TIKHUB_CONTENT_SEARCH_VERSION) return 'tikhub'
  let calls
  if (usageStore.pool) {
    calls = (await usageStore.pool.query(`SELECT DISTINCT provider_key AS provider,operation,endpoint_key AS endpoint
      FROM external_platform.provider_calls
      WHERE usage_request_id=$1 AND tenant_id=$2 AND consumer_id=$3 AND api_key_id=$4`,
    [row.id, row.tenantId, row.consumerId, row.apiKeyId])).rows
  } else {
    calls = [rapidGateway, tikHubGateway].flatMap(gateway => [...(gateway?.platformStore?.calls?.values() || [])])
      .filter(call => call.usageRequestId === row.id && call.tenantId === row.tenantId
        && call.consumerId === row.consumerId && call.apiKeyId === row.apiKeyId)
      .map(call => ({ provider: call.providerKey, operation: call.operation, endpoint: call.endpointKey }))
  }
  if (calls.some(call => call.provider === 'tikhub' && call.operation === `native.${TIKHUB_RECIPE}`
    && call.endpoint === `native.${TIKHUB_RECIPE}`)) return 'tikhub'
  // Pre-cutover standard requests, including old Night-All receipts without a
  // provider call row, keep the original gateway's fingerprint/replay rules.
  return 'rapidapi'
}

export function createTwitterSearchRouter({ usageStore, rapidGateway, tikHubGateway, apiKeyPepper, provider = 'auto', resolveProvider = null, policyStore = null }) {
  if (!['auto', 'rapidapi', 'tikhub'].includes(provider)) throw new AppError(500, 'invalid_configuration', 'Invalid Twitter search supplier')
  const assertSearchDispatchAllowed = policyStore ? async () => {
    if ((await policyStore.get('search', 'twitter')).mode === 'paused') {
      throw new AppError(503, 'strategy_search_paused', 'Twitter search is paused')
    }
  } : null
  return async (context, input) => {
    const cursorProvider = twitterSearchCursorProvider(input.normalized.cursor, { apiKeyPepper, context })
    const existing = input.idempotencyKey
      ? await usageStore.getUsageRequestByIdempotencyKey(context.consumer.id, input.idempotencyKey) : null
    const previous = owned(existing, context) ? existing : null
    const retryId = typeof input.retryOfRequestId === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.retryOfRequestId.trim())
      ? input.retryOfRequestId.trim() : null
    const retrySource = !previous && retryId
      ? await usageStore.getUsageRequestForRetry(retryId, context.consumer.id) : null
    const original = previous || (owned(retrySource, context) ? retrySource : null)
    if (original && !input.normalized.cursor) {
      // Saved omitted options meant Top before this extension. Trusted route
      // metadata distinguishes newer implicit Latest requests without changing
      // either historical body fingerprints or manual-retry identities.
      input = { ...input, twitterSearchParameters: effectiveTwitterSearchParameters(
        original.acquisitionRequest?.twitterSearchParameters ?? input.normalized.params,
        original.acquisitionRequest?.twitterSearchParameters ? 'Latest' : 'Top') }
    }
    const searchParameters = effectiveTwitterSearchParameters(input.twitterSearchParameters ?? input.normalized.params)
    const selected = previous ? await savedProvider(previous, { usageStore, rapidGateway, tikHubGateway })
      : input.retryOfRequestId != null ? 'rapidapi' : cursorProvider
        || (provider === 'auto' ? await resolveProvider?.(context) ?? 'rapidapi' : provider)
    if (!['rapidapi', 'tikhub'].includes(selected)) throw new AppError(503, 'twitter_search_unavailable', 'Twitter search routing is unavailable')
    if (selected === 'tikhub' && input.retryOfRequestId != null) {
      throw new AppError(400, 'uncertain_retry_not_supported', 'This search supplier does not support an unknown-result retry override')
    }
    if (cursorProvider && cursorProvider !== selected) {
      throw new AppError(409, 'idempotency_conflict', 'Idempotency-Key belongs to a different search continuation')
    }
    if (selected === 'tikhub') twitterTikHubParameters(searchParameters)
    // Historical same-key replies and explicit RapidAPI retry acknowledgements
    // are validated by their original gateway before any new dispatch. For a
    // new intent, check all known standard-query outcomes across suppliers.
    if (!previous && input.retryOfRequestId == null) {
      try { await assertTwitterSearchAvailable({ usageStore, context, query: input.normalized.query,
        excludeRequestIds:input.acknowledgedRequestIds || [] }) }
      catch (error) {
        // This check precedes either supplier's gateway and usage reserve.
        // Preserve the old blocker while explicitly identifying this attempt
        // as unstarted; other database/transport errors remain uncertain.
        if (error instanceof AppError && ['request_outcome_unknown', 'request_in_progress'].includes(error.code)) {
          throw new SearchAdmissionNotStartedError(error.status, error.code, error.message, error.details)
        }
        throw error
      }
    }
    let fallbackPolicy = null
    const permitsRejectedFallback = policy => policy?.mode === 'priority'
      && policy.primaryProvider === 'rapidapi' && policy.fallbackProvider === 'tikhub'
    const providerStores = [rapidGateway.platformStore, tikHubGateway.platformStore]
    const rejectedFallback = selected === 'rapidapi' && !cursorProvider && !input.retryOfRequestId
      && twitterParametersSupportTikHub(searchParameters) && policyStore ? {
      // Capture only when a new acquisition begins. Saved replies must not
      // depend on current strategy availability or acquire another quote.
      begin: async () => { fallbackPolicy = await policyStore.get('search', 'twitter') },
      allowed: async () => {
        const current = await policyStore.get('search', 'twitter')
        return permitsRejectedFallback(fallbackPolicy) && permitsRejectedFallback(current) && current.revision === fallbackPolicy.revision
      },
      prepare: ({ delivery, callId }) => pinTwitterSearchFallback({ usageStore, rapidStore: rapidGateway.platformStore, providerStores, delivery, callId }),
      run: async ({ delivery, deadlineAt }) => {
        return tikHubGateway.searchContent(context, input, { assertSearchDispatchAllowed,
          twitterFallback: { delivery, deadlineAt, assertParentLease: () => assertTwitterSearchFallback({
            usageStore, rapidStore: rapidGateway.platformStore, providerStores, delivery }) } })
      },
    } : null
    return selected === 'tikhub' ? tikHubGateway.searchContent(context, input, { assertSearchDispatchAllowed })
      : rapidGateway.searchRaw(context, input, { assertSearchDispatchAllowed, rejectedFallback })
  }
}
