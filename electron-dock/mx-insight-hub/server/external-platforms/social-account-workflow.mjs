import { refreshAdmissionLimits } from './admission-runtime.mjs'
import { openCircuitError, upstreamCapacityError } from './availability-errors.mjs'
import { createHash } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { isPostgresSafeJsonValue } from '../core/postgres-json.mjs'
import { createCredentialEchoRedactor } from '../core/credential-redaction.mjs'
import { isHubRateLimitExempt, isInternalTraffic, internalCircuitState } from '../core/internal-traffic-policy.mjs'
import { TikHubUpstreamError } from '../adapters/tikhub.mjs'
import { RapidApiUpstreamError } from '../adapters/rapidapi.mjs'
import { JustOneUpstreamError } from '../adapters/justone.mjs'
import { buildHubSocialCompatDispatch, projectHubSocialCompatResponse } from '../contracts/hub-social-compat.mjs'
import { normalizeNightAllLegacyPayload } from '../ingest/legacy-night-all.mjs'
import { SocialSearchStateStore } from './social-search-store.mjs'
import { YOUTUBE_COMMENTS_TRAVERSAL } from '../contracts/youtube-comments.mjs'

const VERSION = 'mx-insight-hub.social-compat.v1'
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const unavailable = () => new AppError(409, 'search_page_unavailable', 'The saved account page cannot be continued; restart explicitly')
const uncertain = () => {
  const error = new AppError(503, 'request_outcome_unknown', 'The account acquisition outcome is unknown; inspect the saved request before retrying')
  Object.defineProperty(error, 'preserveReservation', { value: true })
  return error
}
const knownAdmission = error => error instanceof AppError && error.status !== 403 && (
  /^external_platform_(?:operation_|cost_)/u.test(error.code)
  || ['external_admission_policy_unavailable', 'external_platform_not_configured', 'external_platform_circuit_open', 'external_platform_rate_limited',
    'external_platform_subsidy_budget_exhausted', 'external_platform_busy', 'social_search_deadline'].includes(error.code))
const descriptor = request => ({ provider: request.provider, operation: request.operationKey || request.procurementOperation || request.operation,
  endpointKey: request.endpointKey, endpointVersion: request.endpointVersion, contractVersion: request.endpointContractVersion })
const sourceRows = (projected, operation) => operation === 'user-info' ? projected.profiles : projected.acquiredItems
const rowId = (row, operation) => operation === 'user-info' || row.objectType === 'user' ? row.user_id : row.content_id
function publicPayload(value, credential) {
  const redact = createCredentialEchoRedactor(credential)
  const visit = item => typeof item === 'string' ? redact(item) : Array.isArray(item) ? item.map(visit)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, nested]) => [redact(key), visit(nested)])) : item
  return visit(value)
}
function archiveObjects(result, step, callId) {
  if (result.archiveObjects?.length) return result.archiveObjects.map(({ rawItem, rawPayloadSha256, ...row }) => ({ ...row,
    payloadSha256: row.payloadSha256 ?? rawPayloadSha256, rawPayload: row.rawPayload ?? rawItem ?? null }))
  const archive = result.responseArchive
  if (!archive?.payloadSha256) return []
  return [{ kind: 'response', marketplace: step.platform, endpointVersion: step.endpointVersion,
    capturedDate: new Date(archive.capturedAt).toISOString().slice(0, 10),
    archivePath: `${step.provider}/${step.platform}/${descriptor(step).operation}/${callId}`,
    envelopePointer: '$', sourceKey: callId, payloadSha256: archive.payloadSha256, rawPayload: archive.rawPayload }]
}
function persistedEvidence(source) {
  const object = source.archiveObjects?.find(row => row.kind === 'response')
  const rawPayload = object?.rawPayload ?? object?.rawItem ?? null
  const response = rawPayload?.response
  return { responseArchive: source.responseArchive ?? (object ? {
    contractState: object.contractState || response?.contractState || 'unknown',
    httpStatus: response?.httpStatus ?? null, businessCode: response?.businessCode ?? null,
    contentType: object.contentType ?? response?.contentType ?? null,
    bodySize: object.bodySize ?? response?.bodySize ?? null,
    payloadSha256: object.payloadSha256 ?? object.rawPayloadSha256 ?? null, rawPayload,
    capturedAt: rawPayload?.capturedAt ?? source.restrictedResponseArchive?.capturedAt,
  } : null), restrictedResponseArchive: source.restrictedResponseArchive,
  upstreamEvidence: source.upstreamEvidence ?? (object ? {
    requestId: object.upstreamRequestId ?? response?.requestId ?? null,
    recordTime: object.upstreamRecordTime ?? response?.recordTime ?? null,
  } : null) }
}

function projectPage(payload, step, operation, capturedAt, traversal = null) {
  const custom = traversal?.projectPage(payload, step, { capturedAt })
  const projected = custom?.projected ?? projectHubSocialCompatResponse(payload, step, { capturedAt })
  if (!isPostgresSafeJsonValue(projected) || !Array.isArray(projected.acquiredItems) || !Array.isArray(projected.profiles)
    || sourceRows(projected, operation).some(row => typeof rowId(row, operation) !== 'string' || !rowId(row, operation))) throw new Error('invalid_social_projection')
  const records = custom?.records ?? normalizeNightAllLegacyPayload({ data: { raw_info: JSON.stringify(projected.profiles),
    raw_data: JSON.stringify(projected.acquiredItems.filter(row => row.objectType !== 'user')), page: {}, meta: {} } }, step.platform, operation,
    { connectorId: `external-platform:${step.provider}`, parserVersion: VERSION }).records
  if (!records.every(record => Object.entries(record).every(([name, value]) => isPostgresSafeJsonValue(
    ['eventTime', 'collectedAt', 'editedAt', 'deletedAt'].includes(name) && value instanceof Date ? value.toISOString() : value,
  )))) throw new Error('invalid_social_projection')
  return { projected, records }
}

// Account traversal uses the same acquisition rules as data/search: a durable
// receipt per paid call, a bounded fill, archived overflow, and one final hold.
export async function runSocialAccountWorkflow({ gateway, context, request, delivery, deadlineAt, signal,
  resolveCredential, revalidateIdentity, enterCapacity, leaveCapacity, providerCostControl, buildResponse,
  workflowKind = 'social-account' }, { clock = Date.now } = {}) {
  if (!['social-account', 'youtube-comments'].includes(workflowKind)) throw new TypeError('Unknown traversal kind')
  const traversal = workflowKind === 'youtube-comments' ? YOUTUBE_COMMENTS_TRAVERSAL : null
  const store = gateway.platformStore, provider = gateway.providerKey
  const stateStore = new SocialSearchStateStore({ [provider]: store }, { platform: request.platform, workflowKind })
  const identity = { tenantId: context.tenant.id, consumerId: context.consumer.id, apiKeyId: context.apiKey.id,
    path: traversal ? request.path : `/api/v1/data/social/${request.operation}`, scopeHash: request.scopeHash }
  const history = await stateStore.historyFor({ ...identity, previousDeliveryId: request.previousDeliveryId,
    jobCount: request.jobs.length, totalLimit: request.totalLimit })
  const state = history.state || { jobs: request.jobs.map(job => ({ query: job.id, providerCursor: null,
    providerPage: 1, upstreamPages: 0, started: false, done: false, buffer: null, resolvedIdentity: null, profiles: [], dispatchedTokens: [] })) }
  if (state.jobs.some((job, index) => job.query !== request.jobs[index].id)) throw unavailable()
  const rowsByJob = request.jobs.map(() => []), seen = history.seenIds, sources = [], warnings = [], started = performance.now()
  const parentLease = { consumerId: context.consumer.id, fingerprint: delivery.fingerprint,
    ownerRequestId: delivery.usageRequestId, expiresAt: new Date(deadlineAt).toISOString() }
  let calls = 0, bytes = 0, capturedAt = null, ownsParent = false, entered = false
  let currentCall = null, currentEvidence = null, costReservation = null, childLease = null, settledFailure = false, retainLease = false, stopped = false
  const enoughTime = () => Number.isFinite(deadlineAt) && clock() + (gateway.config.timeoutMs || 30000) + 5000 < deadlineAt
  const warn = (code, message) => { if (!warnings.some(row => row.code === code)) warnings.push({ code, message }) }
  const stop = reason => { stopped = true; warn('social_page_fill_stopped', `Account acquisition paused before another dispatch (${reason}); continue with nextCursor when present.`) }
  const markUnknown = async () => {
    try { await gateway.usageStore.markRequestUnknown(delivery.usageRequestId, 'external_platform_persistence_unknown') }
    catch {
      try { if (['unknown', 'committed'].includes((await gateway.usageStore.getRequest(delivery.usageRequestId, delivery.consumerId))?.status)) return } catch { /* Preserve the existing hold and lease. */ }
      retainLease = true
    }
  }
  const buildStep = (index, job, buffer = null) => traversal ? traversal.buildStep(request, job, buffer) : buildHubSocialCompatDispatch(request.jobs[index], {
    page: buffer?.providerPage ?? job.providerPage, nextParams: buffer ? buffer.providerCursor : job.providerCursor,
    resolvedIdentity: job.resolvedIdentity, pageSize: request.pageSize,
  })
  const consume = (projected, source, job, index, step, offset = 0, expectedHash = null) => {
    const rows = sourceRows(projected, request.operation), rowsHash = hash(rows)
    if (expectedHash && expectedHash !== rowsHash || !Number.isSafeInteger(offset) || offset < 0 || offset > rows.length) throw unavailable()
    sources.push({ callId: source.callId, bodySize: source.bodySize, bodySha256: source.bodySha256,
      capturedAt: source.capturedAt, rowsHash, own: source.own === true, expected: descriptor(step) })
    capturedAt = source.capturedAt
    // Relationship pages are delivered through the same bounded rows/overflow
    // path. Keep only the owner profile in traversal state, not undisclosed or
    // previously delivered followers from the complete acquired page.
    if (!step.socialCompat.recipe?.profiles) job.profiles = [...new Map([...job.profiles, ...projected.profiles].map(row => [row.user_id, row])).values()]
    if (step.socialCompat.stage === 'resolve') {
      if (!projected.resolvedIdentity || hash(projected.resolvedIdentity) === hash(job.resolvedIdentity)) throw unavailable()
      job.resolvedIdentity = structuredClone(projected.resolvedIdentity)
      if (traversal?.resolvedDone(job)) job.done = true
      return 0
    }
    let position = offset, added = 0
    const limit = request.operation === 'user-info' ? 1 : request.pageSize
    while (position < rows.length && rowsByJob[index].length < limit) {
      const row = rows[position++], id = rowId(row, request.operation)
      if (seen[index].has(id)) {
        if (traversal) job.duplicateCount = (job.duplicateCount || 0) + 1
        continue
      }
      seen[index].add(id); rowsByJob[index].push(row); added++
    }
    if (position < rows.length) job.buffer = { callId: source.callId, offset: position, hash: rowsHash,
      providerCursor: structuredClone(job.providerCursor), providerPage: job.providerPage,
      projectionHash: hash(projected), expected: descriptor(step) }
    else {
      job.buffer = null
      const next = projected.providerPage
      if (next.stopReason === 'continuation_unproven' && traversal) warn('pagination_completeness_unknown', 'The upstream response did not prove comment continuation; acquired rows were retained.')
      else if (next.stopReason) warn('upstream_pagination_stopped', 'The upstream continuation did not advance; acquired rows were retained. Restart explicitly to traverse again.')
      job.done = request.operation === 'user-info' || next.hasMore === false || !next.nextParams || job.upstreamPages >= 15
      job.providerCursor = structuredClone(next.nextParams ?? null)
      job.providerPage = next.nextPage || job.providerPage + 1
      if (!job.done && job.dispatchedTokens?.includes(hash({ endpoint: step.endpointKey,
        cursor: job.providerCursor, identity: job.resolvedIdentity }))) {
        job.done = true
        job.providerCursor = null
        warn('repeated_cursor', 'The upstream repeated an earlier continuation; acquired rows were retained. Restart explicitly to traverse again.')
      }
      if (job.upstreamPages >= 15 && next.hasMore && next.nextParams) warn('upstream_page_limit_reached', 'The account traversal reached its upstream page limit; restart explicitly.')
      if (next.hasMore == null) {
        warn('pagination_completeness_unknown', 'The upstream response did not prove continuation; no additional page was purchased automatically.')
        job.manualContinuation = true
      }
    }
    return added
  }
  try {
    if (!await stateStore.acquireDeliveryLease(parentLease)) throw new AppError(409, 'request_in_progress', 'An equal account delivery is in progress')
    ownsParent = true
    for (const [index, job] of state.jobs.entries()) {
      if (traversal) job.duplicateCount = 0
      job.manualContinuation = false
      job.dispatchedTokens ||= []
      if (job.buffer) {
        const step = buildStep(index, job, job.buffer)
        const page = await stateStore.pageFor({ ...identity, callId: job.buffer.callId, expected: descriptor(step) })
        if (!page) throw unavailable()
        if (bytes + page.bodySize > 12582912) { stop('archive_byte_limit'); break }
        bytes += page.bodySize
        const { projected } = projectPage(page.payload, step, request.operation, page.capturedAt, traversal)
        // Acquired public projections exclude credential echoes. A raw replay
        // that differs anywhere (including profiles) cannot serve that buffer.
        if (hash(projected) !== job.buffer.projectionHash) throw unavailable()
        consume(projected, { ...page, callId: job.buffer.callId }, job, index, step, job.buffer.offset, job.buffer.hash)
      }
      const tokens = new Set(job.dispatchedTokens); let noProgress = 0, resolves = 0
      while (rowsByJob[index].length < (request.operation === 'user-info' ? 1 : request.pageSize) && !job.buffer && !job.done && !job.manualContinuation) {
        if (calls >= 50) { stop('dispatch_limit'); break }
        if (job.upstreamPages >= 15) { job.done = true; stop('upstream_page_limit'); break }
        if (bytes + (provider === 'rapidapi' ? 4194304 : 8388608) > 12582912) { stop('archive_byte_limit'); break }
        if (!enoughTime()) { stop('deadline'); break }
        const step = buildStep(index, job), expected = descriptor(step)
        const callDelivery = { ...delivery, operation: expected.operation }
        const token = hash({ endpoint: step.endpointKey, cursor: job.providerCursor, identity: job.resolvedIdentity })
        if (tokens.has(token)) { job.done = true; warn('repeated_cursor', 'The upstream repeated its continuation; restart explicitly.'); break }
        if (step.socialCompat.stage === 'resolve' && ++resolves > (traversal?.maxResolves ?? 3)) throw unavailable()
        try {
          if (signal?.aborted) throw new AppError(499, 'request_cancelled', 'Request cancelled before dispatch')
          context = await revalidateIdentity({ totalLimit: request.totalLimit })
          const states = await Promise.all([store.providerState(provider), store.contractCircuitState?.(provider, request.platform)])
          if (provider === 'tikhub' || isHubRateLimitExempt(context)) states[0] = internalCircuitState(gateway.usageStore, context, states[0])
          const blocked = await openCircuitError({ store, state: states[0], contract: states[1], now: clock(), config: gateway.config,
            message: 'Account acquisition is temporarily unavailable', marketplace: request.platform })
          if (blocked) throw blocked
          const credential = await resolveCredential()
          if (!credential.ready) throw new AppError(503, 'external_platform_not_configured', 'Account acquisition is unavailable')
          const control = await gateway.operationControlStore.authorizeDispatch(provider, expected.operation,
            { consumerId: context.consumer.id, config: gateway.config, credentialConfigured: true, credentialRevision: credential.revision })
          const pendingLease = { ...parentLease, operation: expected.operation, endpointKey: expected.endpointKey, contractVersion: expected.contractVersion }
          const lease = await store.acquireDispatchLease(pendingLease)
          if (lease !== true && lease?.kind !== 'acquired') throw new AppError(409, lease?.reason === 'unknown' ? 'request_outcome_unknown' : 'request_in_progress', 'The acquisition is pending; inspect the original request')
          childLease = pendingLease
          if (entered === 'exempt' && !isHubRateLimitExempt(context)) {
            leaveCapacity(entered); entered = false
          }
          if (!entered) {
            if (!(entered = await enterCapacity({ delivery, expiresAt: new Date(deadlineAt), signal, platform: request.platform }))) throw new AppError(503, 'external_platform_busy', 'Account acquisition capacity is occupied')
          }
          const cost = providerCostControl(control?.billing ? { billing: control.billing } : gateway.config, expected.endpointKey)
          costReservation = await store.reserveProviderCostWorkflow({ ...delivery, costControls: [cost] })
          const rate = isHubRateLimitExempt(context) || (provider === 'tikhub' && isInternalTraffic(gateway.usageStore, context)) ? { allowed: true }
            : await store.acquireProviderRateLimit({ limit: (await refreshAdmissionLimits(gateway)).maxRequestsPerMinute ?? 90, windowMs: 60000 })
          if (!rate.allowed) throw new AppError(429, 'external_platform_rate_limited', 'Account acquisition rate limit is exhausted')
          if (signal?.aborted) throw new AppError(499, 'request_cancelled', 'Request cancelled before dispatch')
          if (!enoughTime()) throw new AppError(503, 'social_search_deadline', 'Account acquisition deadline reached before dispatch')
          currentEvidence = null
          currentCall = await store.beginProviderCall({ ...delivery, operation: expected.operation,
            contractVersion: expected.contractVersion, endpointKey: expected.endpointKey, endpointVersion: expected.endpointVersion,
            marketplace: request.platform, callOrdinal: calls, callRole: calls ? 'enrichment' : 'primary',
            dispatchFingerprint: delivery.fingerprint, costControl: cost.costMinor === 0 ? null : cost,
            costReservationId: costReservation.id, operationControl: control })
          calls++; job.started = true; tokens.add(token); job.dispatchedTokens.push(token)
          if (traversal ? traversal.countsAsPage(step) : step.socialCompat.stage !== 'resolve') job.upstreamPages++
          const callStart = performance.now()
          let result, projected, records
          const businessCode = provider === 'rapidapi' ? null : provider === 'justone' ? 0 : 200
          const billed = provider === 'rapidapi' ? null : true
          try {
            result = provider === 'rapidapi'
              ? await gateway.adapter.execute(step, { credential: credential.credential, encodeCursor: () => null })
              : await gateway.adapter.forwardNative(step.key, { params: step.upstreamQuery }, { credential: credential.credential })
            const receipt = result.restrictedResponseArchive
            const payload = receipt?.bodyBytes ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(receipt.bodyBytes).replace(/^\uFEFF/u, '')) : null
            try { ({ projected, records } = projectPage(publicPayload(payload, credential.credential), step, request.operation, receipt?.capturedAt, traversal)) }
            catch {
              const evidence = { outcome: 'succeeded_unusable', billed, httpStatus: 200, businessCode, errorCode: 'invalid_social_contract', affectsCircuit: true }
              if (provider === 'rapidapi') throw new RapidApiUpstreamError(evidence, result)
              throw new TikHubUpstreamError('Account response could not be normalized', evidence, result)
            }
          } catch (error) {
            if (!(error instanceof TikHubUpstreamError || error instanceof RapidApiUpstreamError || error instanceof JustOneUpstreamError)) throw error
            const evidence = error.evidence
            const accountNotFound = error instanceof RapidApiUpstreamError && provider === 'rapidapi'
              && step.endpointKey === 'twitter-aio.user-info' && step.operation === 'user-info'
              && evidence.outcome === 'rejected' && evidence.errorCode === 'social_account_not_found'
            const status = accountNotFound ? 404 : evidence.httpStatus === 429 ? 429 : 502
            const failureDetails = { ...(evidence.httpStatus === 429 ? upstreamCapacityError(evidence).details : {}),
              ...(accountNotFound ? { platform: 'twitter', stage: 'account_lookup' } : {}), outcome: evidence.outcome, retryable: false }
            currentEvidence = { ...evidence, callId: currentCall.id, delivery: callDelivery, costMinor: cost.costMinor,
              costKind: cost.costKind, currency: cost.currency, latencyMs: Math.round(performance.now() - callStart),
              ...persistedEvidence(error), archiveObjects: archiveObjects(error, step, currentCall.id) }
            const code = accountNotFound ? 'social_account_not_found' : evidence.outcome === 'unknown' ? 'upstream_outcome_unknown' : evidence.outcome === 'succeeded_unusable' ? 'external_platform_response_unusable' : 'external_platform_rejected'
            const message = accountNotFound ? 'The upstream provider reported that the Twitter account was not found'
              : 'Account acquisition failed; inspect its saved outcome'
            await store.finishFailure({ ...currentEvidence, failureResponseStatus: status,
              failureResponseBody: { error: { code, message, details: failureDetails }, requestId: delivery.usageRequestId } })
            currentCall = null; settledFailure = true
            throw new AppError(status, code, message, failureDetails)
          }
          const receipt = result.restrictedResponseArchive
          currentEvidence = { callId: currentCall.id, delivery: callDelivery, outcome: 'succeeded', billed, httpStatus: 200, businessCode,
            costMinor: cost.costMinor, costKind: cost.costKind, currency: cost.currency,
            latencyMs: Math.round(performance.now() - callStart), itemCount: sourceRows(projected, request.operation).length,
            ...persistedEvidence(result), archiveObjects: archiveObjects(result, step, currentCall.id), affectsCircuit: false }
          if (!receipt || receipt.bodySize > 8388608) throw unavailable()
          await store.stageProviderEvidence(currentEvidence)
          await store.finishProviderStep({ ...currentEvidence, ingestJob: { payload: { kind: 'external-platform-result', providerKey: provider,
            consumerId: context.consumer.id, datasetId: traversal?.datasetId ?? 'night-all.search.v1', platform: request.platform,
            requestId: delivery.usageRequestId, queryFingerprint: delivery.fingerprint, providerCallId: currentCall.id, records },
          dedupeKey: `external-platform:${provider}:${currentCall.id}`, priority: 100 } })
          bytes += receipt.bodySize
          const callId = currentCall.id; currentCall = null
          const added = consume(projected, { ...receipt, callId, own: true }, job, index, step)
          if (step.socialCompat.stage !== 'resolve') {
            noProgress = added ? 0 : noProgress + 1
            if (noProgress >= 3 && !job.done) { stop('no_new_items'); break }
          }
        } catch (error) {
          if (currentCall || error.code === 'external_platform_call_persistence_unknown') {
            if (currentCall) await store.markPersistenceUnknown({ callId: currentCall.id, delivery, ...(currentEvidence || {}) }).catch(() => {})
            await markUnknown(); throw uncertain()
          }
          if (knownAdmission(error) && sources.length) { stop(error.code); break }
          throw error
        } finally {
          if (costReservation) await store.releaseProviderCostWorkflow({ reservationId: costReservation.id, usageRequestId: delivery.usageRequestId }).catch(() => {})
          costReservation = null
          if (childLease && !retainLease) await store.releaseDispatchLease(childLease).catch(() => {})
          childLease = null
        }
      }
      if (stopped) break
    }
    if (!sources.length) throw new AppError(503, 'social_data_unavailable', 'No account page could be acquired within this request')
    const responseBody = buildResponse({ rowsByJob, state, calls, warnings })
    const sourceMode = calls ? 'live' : clock() - Date.parse(capturedAt) <= gateway.config.freshTtlMs ? 'fresh_cache' : 'stored_fallback'
    try {
      await stateStore.commitDelivery({ ...identity, delivery, responseBody, sources, capturedAt, sourceMode,
        usageUnitsActual: 1, latencyMs: Math.round(performance.now() - started), manifest: { version: traversal?.version ?? VERSION,
          scopeHash: request.scopeHash, previousDeliveryId: history.previousDeliveryId, state,
          deliveredIds: rowsByJob.map(rows => rows.map(row => rowId(row, request.operation))) } })
    } catch { await markUnknown(); throw uncertain() }
    return { status: 200, body: responseBody, requestId: delivery.usageRequestId, replay: false, sourceMode, capturedAt }
  } catch (error) {
    if (calls && !settledFailure) { await markUnknown(); if (!error.preserveReservation) throw uncertain() }
    throw error
  } finally {
    if (ownsParent && !retainLease) await stateStore.releaseDeliveryLease(parentLease).catch(() => {})
    if (entered) leaveCapacity(entered)
  }
}
