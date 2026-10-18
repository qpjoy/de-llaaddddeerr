import { AppError } from '../core/errors.mjs'
import { RAW_SEARCH_VERSION } from '../contracts/raw-search.mjs'
import { TIKHUB_CONTENT_SEARCH_VERSION } from '../contracts/tikhub-content-search.mjs'
import { createDataSearchCursorCodec } from '../external-platforms/cursor.mjs'
import { assertTwitterSearchAvailable } from './twitter-search-availability.mjs'

const TIKHUB_RECIPE = 't.twitter_web_fetch_search_timeline'
const owned = (row, context) => row && row.tenantId === context.tenant.id
  && row.consumerId === context.consumer.id && row.apiKeyId === context.apiKey.id && row.platform === 'twitter'

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

export function createTwitterSearchRouter({ usageStore, rapidGateway, tikHubGateway, apiKeyPepper, provider = 'auto', resolveProvider = null }) {
  if (!['auto', 'rapidapi', 'tikhub'].includes(provider)) throw new AppError(500, 'invalid_configuration', 'Invalid Twitter search supplier')
  return async (context, input) => {
    const cursorProvider = twitterSearchCursorProvider(input.normalized.cursor, { apiKeyPepper, context })
    const existing = input.idempotencyKey
      ? await usageStore.getUsageRequestByIdempotencyKey(context.consumer.id, input.idempotencyKey) : null
    const previous = owned(existing, context) ? existing : null
    const selected = previous ? await savedProvider(previous, { usageStore, rapidGateway, tikHubGateway })
      : input.retryOfRequestId != null ? 'rapidapi' : cursorProvider
        || (provider === 'auto' ? await resolveProvider?.(context) ?? 'tikhub' : provider)
    if (!['rapidapi', 'tikhub'].includes(selected)) throw new AppError(503, 'twitter_search_unavailable', 'Twitter search routing is unavailable')
    if (selected === 'tikhub' && input.retryOfRequestId != null) {
      throw new AppError(400, 'uncertain_retry_not_supported', 'This search supplier does not support an unknown-result retry override')
    }
    if (cursorProvider && cursorProvider !== selected) {
      throw new AppError(409, 'idempotency_conflict', 'Idempotency-Key belongs to a different search continuation')
    }
    // Historical same-key replies and explicit RapidAPI retry acknowledgements
    // are validated by their original gateway before any new dispatch. For a
    // new intent, check all known standard-query outcomes across suppliers.
    if (!previous && input.retryOfRequestId == null) await assertTwitterSearchAvailable({ usageStore, context, query: input.normalized.query })
    return selected === 'tikhub' ? tikHubGateway.searchContent(context, input) : rapidGateway.searchRaw(context, input)
  }
}
