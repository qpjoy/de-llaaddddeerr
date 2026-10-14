import { createHash } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { TikHubUpstreamError } from '../adapters/tikhub.mjs'
import { normalizeTikHubContentSearchRequest, projectTikHubContentSearch, TIKHUB_CONTENT_SEARCH_VERSION } from '../contracts/tikhub-content-search.mjs'
import { rawSearchRecords, RAW_SEARCH_DATASET } from '../contracts/raw-search.mjs'
import { isInternalTraffic, internalCircuitState } from '../core/internal-traffic-policy.mjs'
import { ContentSearchStateStore } from './content-search-store.mjs'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const unavailable = () => new AppError(409, 'search_page_unavailable', 'The saved content page cannot be continued; restart explicitly')
const uncertain = () => {
  const error = new AppError(503, 'request_outcome_unknown', 'The content-search outcome is unknown; verify the saved request before retrying')
  Object.defineProperty(error, 'preserveReservation', { value: true })
  return error
}
const knownAdmission = error => error instanceof AppError && error.status !== 403 && (
  /^external_platform_(?:operation_|cost_)/u.test(error.code)
  || error.status === 409 && error.code === 'external_platform_response_unusable'
  || ['external_platform_not_configured', 'external_platform_circuit_open', 'external_platform_rate_limited',
    'external_platform_subsidy_budget_exhausted', 'external_platform_busy', 'content_search_deadline'].includes(error.code))

export async function runContentSearch({ gateway, context, request, delivery, deadlineAt, signal,
  resolveCredential, revalidateIdentity, enterCapacity, leaveCapacity, providerCostControl, buildResponse }, { clock = Date.now } = {}) {
  if (request.restartRequired) throw new AppError(409, 'search_restart_required', 'This platform now searches directly in Hub; restart from page 1 with a new Idempotency-Key. Historical cursors cannot be converted.')
  if (request.unsupportedNativeCursor) throw new AppError(400, 'content_search_pagination_unsupported', 'Native continuation parameters cannot replace the signed Hub cursor; restart explicitly')
  if (request.body.params != null && (typeof request.body.params !== 'object' || Array.isArray(request.body.params))) {
    throw new AppError(400, 'unsupported_fields', 'Content-search params must be an object')
  }
  // Search-only execution never silently drops an explicit paid enrichment intent.
  if (request.body.includeDetails === true || request.body.includeComments === true || request.body.commentCursor != null
    || request.body.commentLimit != null || request.body.cacheMaxAgeHours != null) {
    throw new AppError(400, 'content_search_option_unsupported', 'Direct content search does not execute paid detail/comments or cache-hint options; use the dedicated data product or explicitly remove these options')
  }
  const defaults = { page: 1, offset: 0, cursor: 0, search_id: '', backtrace: '', pcursor: '', search_hash_id: '' }
  for (const [name, expected] of Object.entries(defaults)) {
    if (Object.hasOwn(request.params, name) && String(request.params[name]) !== String(expected)) {
      throw new AppError(400, 'content_search_pagination_unsupported', 'Native continuation parameters cannot replace the signed Hub cursor; restart explicitly')
    }
  }
  for (const name of ['page_size', 'limit']) {
    if (Object.hasOwn(request.params, name) && Number(request.params[name]) !== request.pageSize) {
      throw new AppError(400, 'content_search_pagination_unsupported', 'Native page size must equal the public request page size')
    }
  }
  if (Object.hasOwn(request.params, 'keyword') && request.params.keyword !== request.queries[0]) {
    throw new AppError(400, 'unsupported_fields', 'Use the public keyword/query field for content search')
  }
  const sample = normalizeTikHubContentSearchRequest({ platform: request.platform, query: request.queries[0],
    pageSize: request.pageSize, params: request.params, maxQueryLength: request.standard ? 500 : 2048 })
  const store = gateway.platformStore, stateStore = new ContentSearchStateStore(store, sample)
  const identity = { tenantId: context.tenant.id, consumerId: context.consumer.id, apiKeyId: context.apiKey.id,
    path: request.standard ? '/api/v1/data/search' : '/api/v1/night-all/search/raw', scopeHash: request.scopeHash }
  if (await stateStore.unknownFor(delivery, identity.path)) throw new AppError(409, 'request_outcome_unknown', 'A previous equal search has an unknown outcome')
  const history = await stateStore.historyFor({ ...identity, previousDeliveryId: request.previousDeliveryId,
    jobCount: request.queries.length, totalLimit: request.totalLimit })
  const state = history.state || { jobs: request.queries.map(query => ({ query, providerCursor: null,
    providerPage: 1, upstreamPages: 0, started: false, done: false, buffer: null })) }
  if (state.jobs.some((job, index) => job.query !== request.queries[index] || !Number.isInteger(job.upstreamPages)
    || job.upstreamPages < 0 || job.upstreamPages > 15 || !Number.isInteger(job.providerPage) || job.providerPage < 1
    || typeof job.done !== 'boolean' || typeof job.started !== 'boolean')) throw unavailable()
  const rowsByJob = request.queries.map(() => []), seen = history.seenIds, sources = [], warnings = [], started = performance.now()
  const parentLease = { consumerId: context.consumer.id, fingerprint: delivery.fingerprint,
    ownerRequestId: delivery.usageRequestId, expiresAt: new Date(deadlineAt).toISOString() }
  const childLease = { ...parentLease, operation: sample.operation, endpointKey: sample.endpointKey, contractVersion: sample.endpointContractVersion }
  const maxCalls = request.standard ? 3 : 50
  let calls = 0, bytes = 0, capturedAt = null, ownsParent = false, ownsChild = false, entered = false
  let currentCall = null, currentEvidence = null, costReservation = null, settledFailure = false, retainLease = false, stopped = false
  let phase = 'admission'
  const logUnknown = error => {
    try {
      const classes = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AppError', 'TikHubUpstreamError']
      const name = error?.name, code = error?.code
      gateway.logger?.warn?.({ requestId: delivery.usageRequestId, callId: currentCall?.id ?? null, phase,
        errorClass: classes.includes(name) ? name : 'Error',
        sqlState: typeof code === 'string' && /^[0-9A-Z]{5}$/u.test(code) ? code : null },
      'content search outcome is unknown')
    } catch { /* Logging must never change the original unknown/hold handling. */ }
  }
  const enoughTime = () => Number.isFinite(deadlineAt) && clock() + (gateway.config.timeoutMs || 30000) + 5000 < deadlineAt
  const warn = (code, message) => { if (!warnings.some(row => row.code === code)) warnings.push({ code, message }) }
  const stop = reason => { stopped = true; warn('content_search_fill_stopped', `The bounded content search stopped before another dispatch (${reason}); acquired results were retained.`) }
  const markUnknown = async () => {
    try { await gateway.usageStore.markRequestUnknown(delivery.usageRequestId, 'external_platform_persistence_unknown') }
    catch {
      try {
        const saved = await gateway.usageStore.getRequest(delivery.usageRequestId, delivery.consumerId)
        if (['unknown', 'committed'].includes(saved?.status)) return
      } catch { /* Retain both existing leases until their original deadline. */ }
      retainLease = true
    }
  }
  const consume = (projected, source, job, index, offset = 0, expectedHash = null) => {
    const rows = projected.acquiredItems, rowsHash = hash(rows)
    if (expectedHash && expectedHash !== rowsHash || !Number.isSafeInteger(offset) || offset < 0 || offset > rows.length) throw unavailable()
    sources.push({ callId: source.callId, bodySize: source.bodySize, bodySha256: source.bodySha256,
      capturedAt: source.capturedAt, rowsHash, own: source.own === true })
    capturedAt = source.capturedAt
    let position = offset
    while (position < rows.length && rowsByJob[index].length < request.pageSize) {
      const row = rows[position++]
      if (seen[index].has(row.content_id)) continue
      seen[index].add(row.content_id)
      rowsByJob[index].push(row)
    }
    if (projected.nonPostCount) warn('non_post_items_excluded', 'The provider returned non-content entries; these were excluded from content results.')
    if (rows.some(row => ['provider_preview', 'title_only'].includes(row.body_completeness))) {
      warn('body_completeness_unknown', 'Some returned content is a provider preview; full text was not independently acquired.')
    }
    if (position < rows.length) job.buffer = { callId: source.callId, offset: position, hash: rowsHash,
      // The manifest must be a JSON tree. Reusing this object under both job
      // and buffer makes the strict persistence guard reject a paid overflow.
      providerCursor: job.providerCursor == null ? null : { ...job.providerCursor }, providerPage: job.providerPage }
    else {
      job.buffer = null
      const next = projected.providerPage
      job.done = next.hasMore === false || !next.nextParams || job.upstreamPages >= 15
      if (job.upstreamPages >= 15 && next.hasMore !== false && next.nextParams) {
        warn('upstream_page_limit_reached', 'The content-search traversal reached its upstream page limit; restart explicitly.')
      }
      job.providerCursor = next.nextParams
      job.providerPage = next.nextPage || job.providerPage + 1
      if (next.hasMore == null) {
        warn('pagination_completeness_unknown', 'The provider did not prove further pagination; no automatic continuation was purchased.')
        if (!rows.length || !next.nextParams) job.done = true
        job.manualContinuation = true
      } else job.manualContinuation = false
    }
  }
  try {
    if (!await stateStore.acquireDeliveryLease(parentLease)) throw new AppError(409, 'request_in_progress', 'An equal content-search delivery is in progress')
    ownsParent = true
    if (await stateStore.unknownFor(delivery, identity.path)) throw new AppError(409, 'request_outcome_unknown', 'A previous equal search has an unknown outcome')
    for (const [index, job] of state.jobs.entries()) {
      // Only an already saved incomplete page can be continued explicitly.
      // Incomplete metadata discovered while consuming a buffer must stop this
      // request before another paid call.
      job.manualContinuation = false
      if (job.buffer) {
        const page = await stateStore.pageFor({ ...identity, callId: job.buffer.callId })
        if (!page) throw unavailable()
        if (bytes + page.bodySize > 12582912) { stop('archive_byte_limit'); break }
        bytes += page.bodySize
        const acquiredRequest = normalizeTikHubContentSearchRequest({ platform: request.platform, query: job.query,
          pageSize: request.pageSize, params: request.params, page: job.buffer.providerPage,
          providerCursor: job.buffer.providerCursor, maxQueryLength: request.standard ? 500 : 2048 })
        const projected = projectTikHubContentSearch({ publicBody: { data: page.payload.data, meta: { capturedAt: page.capturedAt } } }, acquiredRequest)
        consume(projected, { ...page, callId: job.buffer.callId }, job, index, job.buffer.offset, job.buffer.hash)
      }
      const tokens = new Set()
      while (rowsByJob[index].length < request.pageSize && !job.buffer && !job.done && !job.manualContinuation) {
        if (calls >= maxCalls) { stop('dispatch_limit'); break }
        if (job.upstreamPages >= 15) { job.done = true; stop('upstream_page_limit'); break }
        if (bytes + 8388608 > 12582912) { stop('archive_byte_limit'); break }
        if (!enoughTime()) { stop('deadline'); break }
        const token = JSON.stringify(job.providerCursor)
        if (tokens.has(token)) { job.done = true; stop('repeated_cursor'); break }
        const nativeRequest = normalizeTikHubContentSearchRequest({ platform: request.platform, query: job.query,
          pageSize: request.pageSize, params: request.params, page: job.providerPage, providerCursor: job.providerCursor,
          maxQueryLength: request.standard ? 500 : 2048 })
        try {
          phase = 'admission'
          if (signal?.aborted) throw new AppError(499, 'request_cancelled', 'Request cancelled before dispatch')
          context = await revalidateIdentity({ operation: nativeRequest.operation, totalLimit: request.totalLimit })
          const states = await Promise.all([store.providerState('tikhub'), store.contractCircuitState?.('tikhub', request.platform)])
          states[0] = internalCircuitState(gateway.usageStore, context, states[0])
          if (states.some(row => row?.circuitOpenUntil && Date.parse(row.circuitOpenUntil) > clock())) throw new AppError(503, 'external_platform_circuit_open', 'The content-search supplier circuit is open')
          const credential = await resolveCredential()
          if (!credential.ready) throw new AppError(503, 'external_platform_not_configured', 'Content search is unavailable')
          const control = await gateway.operationControlStore.authorizeDispatch('tikhub', nativeRequest.operation,
            { consumerId: context.consumer.id, config: gateway.config, credentialConfigured: true, credentialRevision: credential.revision })
          const lease = await store.acquireDispatchLease(childLease)
          if (lease !== true && lease?.kind !== 'acquired') throw new AppError(409,
            lease?.reason === 'unknown' ? 'request_outcome_unknown' : lease?.reason === 'succeeded_unusable' ? 'external_platform_response_unusable' : 'request_in_progress',
            'The procurement result is pending or unavailable; verify the original request')
          ownsChild = true
          if (!entered) {
            if (!await enterCapacity({ delivery, expiresAt: new Date(deadlineAt), signal, platform: request.platform })) throw new AppError(503, 'external_platform_busy', 'Content-search capacity is occupied')
            entered = true
          }
          const cost = providerCostControl(control?.billing ? { billing: control.billing } : gateway.config, nativeRequest.endpointKey)
          costReservation = await store.reserveProviderCostWorkflow({ ...delivery, costControls: [cost] })
          const rate = isInternalTraffic(gateway.usageStore, context) ? { allowed: true }
            : await store.acquireProviderRateLimit({ limit: gateway.config.maxRequestsPerMinute ?? 90, windowMs: 60000 })
          if (!rate.allowed) throw new AppError(429, 'external_platform_rate_limited', 'Content-search rate limit is exhausted')
          if (signal?.aborted) throw new AppError(499, 'request_cancelled', 'Request cancelled before dispatch')
          if (!enoughTime()) throw new AppError(503, 'content_search_deadline', 'Content-search deadline reached before dispatch')
          currentEvidence = null
          phase = 'begin_call'
          currentCall = await store.beginProviderCall({ ...delivery, operation: nativeRequest.operation,
            contractVersion: nativeRequest.endpointContractVersion, endpointKey: nativeRequest.endpointKey,
            endpointVersion: nativeRequest.endpointVersion, marketplace: request.platform, callOrdinal: calls,
            callRole: calls ? 'enrichment' : 'primary', dispatchFingerprint: delivery.fingerprint,
            costControl: cost.costMinor === 0 ? null : cost, costReservationId: costReservation.id, operationControl: control })
          calls++; job.upstreamPages++; job.started = true; tokens.add(token)
          const callStart = performance.now()
          let result, projected
          try {
            phase = 'provider_request'
            result = await gateway.adapter.forwardNative(request.recipe.key, { params: nativeRequest.upstreamQuery }, { credential: credential.credential })
            phase = 'project_response'
            try { projected = projectTikHubContentSearch(result, nativeRequest) }
            catch { throw new TikHubUpstreamError('Content-search response could not be normalized', {
              outcome: 'succeeded_unusable', billed: true, httpStatus: 200, businessCode: 200,
              errorCode: 'invalid_content_search_contract', affectsCircuit: true,
            }, result) }
          } catch (error) {
            if (!(error instanceof TikHubUpstreamError)) throw error
            const evidence = error.evidence, status = evidence.httpStatus === 429 ? 429 : 502
            currentEvidence = { ...evidence, callId: currentCall.id, delivery, costMinor: cost.costMinor,
              costKind: cost.costKind, currency: cost.currency, latencyMs: Math.round(performance.now() - callStart),
              responseArchive: error.responseArchive, restrictedResponseArchive: error.restrictedResponseArchive,
              upstreamEvidence: error.upstreamEvidence, archiveObjects: error.archiveObjects }
            const code = evidence.outcome === 'unknown' ? 'upstream_outcome_unknown' : evidence.outcome === 'succeeded_unusable' ? 'external_platform_response_unusable' : 'external_platform_rejected'
            phase = 'finish_failure'
            await store.finishFailure({ ...currentEvidence, failureResponseStatus: status,
              failureResponseBody: { error: { code, message: 'Content-search acquisition failed; inspect its saved outcome', details: { outcome: evidence.outcome } }, requestId: delivery.usageRequestId } })
            currentCall = null; settledFailure = true
            throw new AppError(status, code, 'Content-search acquisition failed; inspect its saved outcome', { outcome: evidence.outcome })
          }
          phase = 'validate_evidence'
          const receipt = result.restrictedResponseArchive
          currentEvidence = { callId: currentCall.id, delivery, outcome: 'succeeded', billed: true, httpStatus: 200, businessCode: 200,
            costMinor: cost.costMinor, costKind: cost.costKind, currency: cost.currency,
            latencyMs: Math.round(performance.now() - callStart), itemCount: projected.acquiredItems.length,
            responseArchive: result.responseArchive, restrictedResponseArchive: receipt,
            upstreamEvidence: result.upstreamEvidence, archiveObjects: result.archiveObjects, affectsCircuit: false }
          if (!receipt || receipt.bodySize > 8388608) throw unavailable()
          phase = 'stage_evidence'
          await store.stageProviderEvidence(currentEvidence)
          phase = 'normalize_ingest'
          const records = rawSearchRecords({ data: { raw_info: '[]', raw_data: JSON.stringify(projected.acquiredItems), page: {}, meta: {} } }, request.platform, 'tikhub')
          phase = 'finish_step'
          await store.finishProviderStep({ ...currentEvidence, ingestJob: { payload: { kind: 'external-platform-result', providerKey: 'tikhub',
            consumerId: context.consumer.id, datasetId: request.standard ? 'night-all.search.v1' : RAW_SEARCH_DATASET,
            platform: request.platform, requestId: delivery.usageRequestId, queryFingerprint: delivery.fingerprint,
            providerCallId: currentCall.id, records }, dedupeKey: `external-platform:tikhub:${currentCall.id}`, priority: 100 } })
          bytes += receipt.bodySize
          const callId = currentCall.id; currentCall = null
          phase = 'assemble_page'
          consume(projected, { ...receipt, callId, own: true }, job, index)
          if (job.manualContinuation) break
        } catch (error) {
          if (currentCall || error.code === 'external_platform_call_persistence_unknown') {
            logUnknown(error)
            if (currentCall) await store.markPersistenceUnknown({ callId: currentCall.id, delivery, ...(currentEvidence || {}) }).catch(() => {})
            await markUnknown(); throw uncertain()
          }
          if (knownAdmission(error) && sources.length) { stop(error.code); break }
          throw error
        } finally {
          if (costReservation) await store.releaseProviderCostWorkflow({ reservationId: costReservation.id, usageRequestId: delivery.usageRequestId }).catch(() => {})
          costReservation = null
          if (ownsChild && !retainLease) await store.releaseDispatchLease(childLease).catch(() => {})
          ownsChild = false
        }
      }
      if (stopped) break
    }
    if (!sources.length) throw new AppError(503, 'content_search_unavailable', 'No content page could be acquired within the bounded request')
    phase = 'build_delivery'
    const responseBody = buildResponse({ rowsByJob, state, calls, warnings })
    const sourceMode = calls ? 'live' : clock() - Date.parse(capturedAt) <= gateway.config.freshTtlMs ? 'fresh_cache' : 'stored_fallback'
    try {
      phase = 'commit_delivery'
      await stateStore.commitDelivery({ ...identity, delivery, responseBody, sources, capturedAt, sourceMode,
        usageUnitsActual: request.standard ? rowsByJob.flat().length : 1,
        latencyMs: Math.round(performance.now() - started), manifest: { version: TIKHUB_CONTENT_SEARCH_VERSION,
          scopeHash: request.scopeHash, previousDeliveryId: history.previousDeliveryId, state,
          deliveredIds: rowsByJob.map(rows => rows.map(row => row.content_id)) } })
    } catch (error) { logUnknown(error); await markUnknown(); throw uncertain() }
    return { status: 200, body: responseBody, requestId: delivery.usageRequestId, replay: false, sourceMode, capturedAt }
  } catch (error) {
    if (calls && !settledFailure) {
      if (!error.preserveReservation) logUnknown(error)
      await markUnknown()
      if (!error.preserveReservation) throw uncertain()
    }
    throw error
  } finally {
    if (ownsParent && !retainLease) await stateStore.releaseDeliveryLease(parentLease).catch(() => {})
    if (entered) leaveCapacity()
  }
}
