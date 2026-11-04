import { AppError, SearchAdmissionNotStartedError } from '../core/errors.mjs'
import { createDataSearchV2CursorCodec } from '../external-platforms/cursor.mjs'
import { prepareDataSearchV2, projectDataSearchV2 } from '../contracts/data-search-v2.mjs'
import { SearchProtocolStore } from './search-protocol-store.mjs'
import { currentDatabaseLane, hubDatabaseFailure, runInDatabaseLane } from '../core/postgres-pool.mjs'

const restoredError = error => new AppError(error.status, error.code, error.message, error.details)
const snapshotError = error => ({ status: error.status || 503, code: error.code || 'search_v2_unavailable',
  message: error instanceof AppError ? error.message : 'The v2 search could not complete', details: error.details || {} })
// The outcome lookup and the binding/lease write run in the top lane: a request
// shed under load must still be recorded, or its expired lease would later read
// as an unresolved search and block the same query.
const asControlWork = operation => runInDatabaseLane('default', operation)
const uncertain = requestId => new AppError(409, 'request_outcome_unknown',
  'The v2 delivery outcome is unresolved; retain the original request and key',
  { ...(requestId ? { requestId } : {}), automaticRetryAllowed: false })

// A new page held back only by an equal search still in flight was never
// dispatched. Hub waits for that search itself and then admits this one, so a
// caller normally never sees its refusal. 40 seconds outlasts a blocker that
// runs into the 30-second supplier deadline, and still leaves this page's own
// run inside Delta's 90-second client timeout; a longer wait would let Delta
// time out mid-purchase. Past it the original 409 is returned unchanged.
export const SEARCH_ADMISSION_WAIT_MS = 40_000
const SEARCH_ADMISSION_POLL_MS = 1_000
const waitsForInFlight = error => error?.code === 'search_admission_blocked'
  && error.details?.dispatchState === 'not_started' && error.details.automaticRetryAllowed === true
  && error.details.retrySameRequest === true
const pause = (ms, signal) => new Promise(resolve => {
  const timer = setTimeout(done, ms)
  function done() { clearTimeout(timer); signal?.removeEventListener?.('abort', done); resolve() }
  signal?.addEventListener?.('abort', done, { once: true })
})

export async function executeDataSearchV2({ admissionWaitMs = 0, signal = null, sleep = pause, now = Date.now, ...options }) {
  const deadline = now() + admissionWaitMs
  for (;;) {
    try { return await attemptDataSearchV2(options) }
    catch (error) {
      // An explicit retry acknowledgement is claimed once; it never waits here.
      const remaining = deadline - now()
      if (!waitsForInFlight(error) || options.retryOfRequestId != null || remaining <= 0 || signal?.aborted) throw error
      await sleep(Math.min(SEARCH_ADMISSION_POLL_MS, remaining), signal)
      if (signal?.aborted) throw error
    }
  }
}

async function attemptDataSearchV2({ store, context, body, idempotencyKey, pepper, execute, retryOfRequestId = null, retryStore = null }) {
  const protocol = new SearchProtocolStore(store)
  const lease = await protocol.begin(context, { version: 2, body, idempotencyKey, retryOfRequestId, retryStore, apiKeyPepper:pepper })
  if (lease.kind === 'replay') return { ...lease.result, replay: true, sourceMode: 'idempotent_replay', originSourceMode: lease.result.sourceMode }
  if (lease.kind === 'failure') throw restoredError(lease.error)
  const codec = createDataSearchV2CursorCodec(pepper, `${context.consumer.id}:${context.apiKey.id}`)
  let underlying = null, projecting = false
  try {
    const prepared = prepareDataSearchV2(body, codec)
    underlying = await execute(prepared.upstream, { retryOfRequestId:lease.retryOfRequestId,
      acknowledgedRequestIds:lease.acknowledgedRequestIds || [] })
    projecting = true
    const result = projectDataSearchV2(underlying, body, prepared, codec)
    await protocol.finish(lease.input, { state: 'complete', result, usageRequestId: underlying.requestId })
    return result
  } catch (error) {
    let saved, lookupFailed = false
    try { saved = await asControlWork(() => store.getUsageRequestByIdempotencyKey(context.consumer.id, idempotencyKey)) }
    catch { lookupFailed = true /* Cannot prove an unsent outcome; retain the protocol guard. */ }
    // A trusted pre-reserve error identifies another attempt's blocker. Never
    // present that UUID as this page's own receipt if protocol persistence fails.
    const requestId = underlying?.requestId || saved?.id
      || (error instanceof SearchAdmissionNotStartedError ? null : error.details?.requestId)
    const unstarted = error instanceof SearchAdmissionNotStartedError && !projecting && !underlying && !lookupFailed && !saved
    // Still in the admission lane: this request never reserved usage, so a
    // database-pressure failure here precedes any dispatch. Hub shed it; the
    // same key may be sent again. A lost reservation COMMIT is an AppError
    // with a persistence code and stays unknown.
    const shed = !projecting && !underlying && !lookupFailed && !saved
      && currentDatabaseLane() === 'admission' && Boolean(hubDatabaseFailure(error))
    const failure = shed ? new AppError(503, 'hub_database_unavailable',
      'Hub is busy and did not start this search; retry the same request and Idempotency-Key after Retry-After',
      { layer: 'hub', stage: 'database', currentAttemptStarted: false, retryAfterMs: 1000 })
      : unstarted ? new AppError(409, 'search_admission_blocked',
      'This search was not admitted; retry only the same request and Idempotency-Key after the blocking request is resolved',
      { dispatchState: 'not_started', automaticRetryAllowed: true, retrySameRequest: true, retryAfterSeconds: 300,
        ...(error.details?.blockingRequestId || error.details?.requestId
          ? { blockingRequestId: error.details.blockingRequestId || error.details.requestId } : {}) }) : error
    const unknown = !unstarted && !shed && (projecting || lookupFailed || saved?.status === 'unknown' || saved?.status === 'reserved'
      || /unknown|ambiguous|persistence/u.test(error.code || '') || !(error instanceof AppError))
    try {
      await asControlWork(() => protocol.finish(lease.input, { state: unknown ? 'unknown' : saved?.status === 'committed' ? 'failed' : 'retryable',
        error: snapshotError(failure), usageRequestId: saved?.id || underlying?.requestId || null }))
    } catch {
      // A possibly committed projection remains owned by its original binding.
      // Never remove a lease or acquire again to repair a persistence failure.
      throw uncertain(requestId)
    }
    if (unknown) throw uncertain(requestId)
    throw failure
  }
}

export async function guardDataSearchV1({ store, context, body, idempotencyKey, execute }) {
  const protocol = new SearchProtocolStore(store)
  const lease = await protocol.begin(context, { version: 1, body, idempotencyKey })
  if (lease.kind === 'legacy') return execute()
  try { return await execute() }
  finally {
    // A retained lease blocks only a future cross-version acquisition. Never
    // turn an already delivered legacy response into an error on cleanup.
    await asControlWork(() => protocol.finish(lease.input)).catch(() => {})
  }
}

export function publicSearchProtocolStatus(binding) {
  const state = binding.state === 'running' && Date.parse(binding.leaseExpiresAt) <= Date.now() ? 'unknown' : binding.state
  return { version: 2, state, acquisitionRequestId: binding.usageRequestId || null,
    deliveryConfirmed: state === 'complete', automaticRetryAllowed: state === 'retryable',
    ...(state === 'unknown' ? { errorCode: 'request_outcome_unknown' } : {}) }
}
