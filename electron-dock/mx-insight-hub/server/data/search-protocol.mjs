import { AppError } from '../core/errors.mjs'
import { createDataSearchV2CursorCodec } from '../external-platforms/cursor.mjs'
import { prepareDataSearchV2, projectDataSearchV2 } from '../contracts/data-search-v2.mjs'
import { SearchProtocolStore } from './search-protocol-store.mjs'

const restoredError = error => new AppError(error.status, error.code, error.message, error.details)
const snapshotError = error => ({ status: error.status || 503, code: error.code || 'search_v2_unavailable',
  message: error instanceof AppError ? error.message : 'The v2 search could not complete', details: error.details || {} })
const uncertain = requestId => new AppError(409, 'request_outcome_unknown',
  'The v2 delivery outcome is unresolved; retain the original request and key',
  { ...(requestId ? { requestId } : {}), automaticRetryAllowed: false })

export async function executeDataSearchV2({ store, context, body, idempotencyKey, pepper, execute }) {
  const protocol = new SearchProtocolStore(store)
  const lease = await protocol.begin(context, { version: 2, body, idempotencyKey })
  if (lease.kind === 'replay') return { ...lease.result, replay: true, sourceMode: 'idempotent_replay', originSourceMode: lease.result.sourceMode }
  if (lease.kind === 'failure') throw restoredError(lease.error)
  const codec = createDataSearchV2CursorCodec(pepper, `${context.consumer.id}:${context.apiKey.id}`)
  let underlying = null, projecting = false
  try {
    const prepared = prepareDataSearchV2(body, codec)
    underlying = await execute(prepared.upstream)
    projecting = true
    const result = projectDataSearchV2(underlying, body, prepared, codec)
    await protocol.finish(lease.input, { state: 'complete', result, usageRequestId: underlying.requestId })
    return result
  } catch (error) {
    let saved, lookupFailed = false
    try { saved = await store.getUsageRequestByIdempotencyKey(context.consumer.id, idempotencyKey) }
    catch { lookupFailed = true /* Cannot prove an unsent outcome; retain the protocol guard. */ }
    const requestId = underlying?.requestId || saved?.id || error.details?.requestId
    const unknown = projecting || lookupFailed || saved?.status === 'unknown' || saved?.status === 'reserved'
      || /unknown|ambiguous|persistence/u.test(error.code || '') || !(error instanceof AppError)
    try {
      await protocol.finish(lease.input, { state: unknown ? 'unknown' : saved?.status === 'committed' ? 'failed' : 'retryable',
        error: snapshotError(error), usageRequestId: saved?.id || underlying?.requestId || null })
    } catch {
      // A possibly committed projection remains owned by its original binding.
      // Never remove a lease or acquire again to repair a persistence failure.
      throw uncertain(requestId)
    }
    if (unknown) throw uncertain(requestId)
    throw error
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
    await protocol.finish(lease.input).catch(() => {})
  }
}

export function publicSearchProtocolStatus(binding) {
  const state = binding.state === 'running' && Date.parse(binding.leaseExpiresAt) <= Date.now() ? 'unknown' : binding.state
  return { version: 2, state, acquisitionRequestId: binding.usageRequestId || null,
    deliveryConfirmed: state === 'complete', automaticRetryAllowed: state === 'retryable',
    ...(state === 'unknown' ? { errorCode: 'request_outcome_unknown' } : {}) }
}
