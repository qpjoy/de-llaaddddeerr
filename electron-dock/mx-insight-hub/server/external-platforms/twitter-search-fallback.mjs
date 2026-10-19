import { AppError } from '../core/errors.mjs'
import { TIKHUB_CONTENT_SEARCH_VERSION } from '../contracts/tikhub-content-search.mjs'
import { twitterDeliveryLeases } from './twitter-delivery-leases.mjs'

const VERSION = 'rapidapi-400.v1'
const OPERATION = 'social.content.search'
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
const fail = () => new AppError(409, 'twitter_search_fallback_unavailable', 'The saved Twitter rejection cannot authorize supplier fallback')
const sameOwner = (row, delivery) => row && ['tenantId', 'consumerId', 'apiKeyId'].every(key => row[key] === delivery[key])

function validate({ usage, calls, lease, now }, delivery, callId, requireMarker) {
  if (!uuid(delivery?.usageRequestId) || !['tenantId', 'consumerId', 'apiKeyId'].every(key => uuid(delivery[key]))
    || !/^[0-9a-f]{64}$/u.test(delivery.fingerprint || '') || delivery.twitterManualRetry || delivery.retryOfRequestId) throw fail()
  const acquisition = usage?.acquisitionRequest, body = acquisition?.body
  if (!sameOwner(usage, delivery) || usage.id !== delivery.usageRequestId || usage.status !== 'reserved'
    || usage.platform !== 'twitter' || usage.fingerprint !== delivery.fingerprint
    || acquisition?.path !== '/api/v1/data/search' || !body
    || typeof body.query !== 'string' || !body.query.trim() || body.cursor || body.params?.cursor
    || body.page > 1 || acquisition.twitterFill || acquisition.contentSearch) throw fail()
  // usage.platform is the admitted canonical value; the saved body preserves
  // caller aliases such as "x" and must not be rewritten to authorize fallback.
  if (!lease || lease.ownerRequestId !== delivery.usageRequestId || !(Date.parse(lease.expiresAt) > now)) throw fail()
  // This is a one-time first-page handoff, never a continuation or a second
  // fallback after TikHub was already contacted. Count all calls, not just the
  // ones whose ownership/provider happen to match the expected rejection.
  if (calls.length !== 1) throw fail()
  const call = calls[0]
  if (!sameOwner(call, delivery) || call.id !== callId || call.usageRequestId !== delivery.usageRequestId
    || call.providerKey !== 'rapidapi' || call.operation !== OPERATION || call.endpointKey !== 'twitter-aio.search'
    || call.marketplace !== 'twitter' || call.fingerprint !== delivery.fingerprint || call.callOrdinal !== 0
    || call.outcome !== 'rejected' || call.httpStatus !== 400 || !Number.isFinite(Date.parse(call.completedAt))
    || call.retryOfRequestId || call.twitterManualRetry) throw fail()
  const marker = acquisition.twitterFallback
  if (requireMarker || marker != null) {
    if (marker?.version !== VERSION || marker.callId !== callId || acquisition.searchProvider !== 'tikhub'
      || acquisition.searchContractVersion !== TIKHUB_CONTENT_SEARCH_VERSION) throw fail()
  } else if (acquisition.searchProvider != null && acquisition.searchProvider !== 'rapidapi') throw fail()
  return { version: VERSION, callId }
}

function memoryEvidence({ usageStore, rapidStore, providerStores = [], delivery }) {
  const stores = [...new Set([rapidStore, ...providerStores].filter(Boolean))]
  if (!stores.length || stores.some(store => store.usageStore !== usageStore)) throw fail()
  const calls = stores.flatMap(store => [...(store.calls?.values() || [])])
    .filter(call => call.usageRequestId === delivery.usageRequestId)
  return { usage: usageStore.requests?.get(delivery.usageRequestId), calls,
    lease: twitterDeliveryLeases(usageStore).get([delivery.consumerId, OPERATION, delivery.fingerprint].join('\0')),
    now: Date.now() }
}

async function databaseEvidence(client, delivery) {
  // Lock the original usage row and its still-owned parent lease. Neither a
  // committed receipt nor an expired/foreign lease can become a new attempt.
  const usage = (await client.query(`SELECT id,tenant_id AS "tenantId",consumer_id AS "consumerId",api_key_id AS "apiKeyId",
    platform,status,fingerprint,acquisition_request AS "acquisitionRequest" FROM usage_requests WHERE id=$1 FOR UPDATE`,
  [delivery.usageRequestId])).rows[0]
  const calls = (await client.query(`SELECT id,usage_request_id AS "usageRequestId",tenant_id AS "tenantId",
    consumer_id AS "consumerId",api_key_id AS "apiKeyId",provider_key AS "providerKey",operation,
    endpoint_key AS "endpointKey",marketplace,request_fingerprint AS fingerprint,call_ordinal AS "callOrdinal",
    outcome,http_status AS "httpStatus",completed_at AS "completedAt",retry_of_usage_request_id AS "retryOfRequestId"
    FROM external_platform.provider_calls WHERE usage_request_id=$1 FOR SHARE`, [delivery.usageRequestId])).rows
  const lease = (await client.query(`SELECT owner_request_id AS "ownerRequestId",expires_at AS "expiresAt",
    clock_timestamp() AS "databaseNow" FROM external_platform.dispatch_leases
    WHERE consumer_id=$1 AND operation=$2 AND request_fingerprint=$3 FOR UPDATE`,
  [delivery.consumerId, OPERATION, delivery.fingerprint])).rows[0]
  return { usage, calls, lease, now: lease ? new Date(lease.databaseNow).getTime() : Date.now() }
}

async function transaction(pool, work) {
  const client = await pool.connect()
  let committing = false, releaseError
  try {
    await client.query('BEGIN')
    const result = await work(client)
    committing = true
    await client.query('COMMIT')
    return result
  } catch (error) {
    if (committing) releaseError = error
    else await client.query('ROLLBACK').catch(error => { releaseError = error })
    throw error
  } finally { client.release(releaseError) }
}

// Called only after finishProviderStep durably saves the original rejection.
// Keep its request ID/key/fingerprint/hold and exact input; pin only the internal
// supplier choice before TikHub dispatch so a lost acknowledgement cannot send
// the same attempt back to RapidAPI.
export async function pinTwitterSearchFallback(options) {
  const { usageStore, delivery, callId } = options
  if (!uuid(callId) || !uuid(delivery?.usageRequestId)) throw fail()
  if (!usageStore.pool) {
    const evidence = memoryEvidence(options)
    const marker = validate(evidence, delivery, callId, false)
    evidence.usage.acquisitionRequest = { ...evidence.usage.acquisitionRequest,
      searchProvider: 'tikhub', searchContractVersion: TIKHUB_CONTENT_SEARCH_VERSION, twitterFallback: marker }
    return structuredClone(marker)
  }
  return transaction(usageStore.pool, async client => {
    const evidence = await databaseEvidence(client, delivery)
    const marker = validate(evidence, delivery, callId, false)
    await client.query(`UPDATE usage_requests SET acquisition_request=acquisition_request || $2::jsonb WHERE id=$1`,
    [delivery.usageRequestId, JSON.stringify({ searchProvider: 'tikhub', searchContractVersion: TIKHUB_CONTENT_SEARCH_VERSION,
      twitterFallback: marker })])
    return marker
  })
}

// Initial TikHub workflow entry borrows the RapidAPI parent lease instead of
// releasing/reacquiring it. This assertion must happen before any TikHub call.
export async function assertTwitterSearchFallback(options) {
  const { usageStore, delivery } = options
  if (!uuid(delivery?.usageRequestId)) throw fail()
  const check = evidence => validate(evidence, delivery, evidence.usage?.acquisitionRequest?.twitterFallback?.callId, true)
  if (!usageStore.pool) return structuredClone(check(memoryEvidence(options)))
  return transaction(usageStore.pool, async client => check(await databaseEvidence(client, delivery)))
}
