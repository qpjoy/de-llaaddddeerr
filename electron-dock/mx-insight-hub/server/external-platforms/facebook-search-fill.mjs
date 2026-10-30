import { refreshAdmissionLimits } from './admission-runtime.mjs'
import { acquireSupplierRate, bypassesSupplierLimits, isHubRateLimitExempt, internalCircuitState } from '../core/internal-traffic-policy.mjs'
import { createHash } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { openCircuitError } from './availability-errors.mjs'
import { RapidApiUpstreamError } from '../adapters/rapidapi.mjs'
import { JustOneUpstreamError } from '../adapters/justone.mjs'
import { FACEBOOK_OPERATION, FACEBOOK_JUSTONE_KEY, projectFacebookSearch, facebookJustOneArchives } from '../contracts/facebook-search.mjs'
import { projectDataSearch } from '../contracts/hub-data-search.mjs'
import { rawSearchRecords } from '../contracts/raw-search.mjs'
import { waitForFacebookRapidAdmission } from './facebook-rapid-admission.mjs'

const MAX_PAGES = 15, MAX_BYTES = 12 * 1024 * 1024
const PAGE_BYTES = { rapidapi: 4 * 1024 * 1024, justone: 8 * 1024 * 1024 }
const hash = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex')
const unavailable = () => new AppError(409, 'search_page_unavailable', 'The saved Facebook page cannot be continued; restart explicitly')
const uncertain = () => {
  const error = new AppError(503, 'request_outcome_unknown', 'The Facebook delivery outcome is unknown; verify its saved request before retrying')
  Object.defineProperty(error, 'preserveReservation', { value: true })
  return error
}
const knownAdmission = error => error instanceof AppError && error.status !== 403 && (
  /^external_platform_(?:operation_|cost_)/u.test(error.code)
  || ['external_admission_policy_unavailable', 'external_platform_not_configured', 'external_platform_circuit_open', 'external_platform_rate_limited',
    'external_platform_subsidy_budget_exhausted', 'external_platform_busy', 'facebook_search_paused',
    'facebook_search_capacity_unavailable', 'search_restart_required'].includes(error.code))

function rapidArchives(result, step, callId) {
  if (result.archiveObjects?.length) return result.archiveObjects
  const archive = result.responseArchive
  if (!archive?.payloadSha256) return []
  return [{ kind: 'response', marketplace: 'facebook', endpointVersion: step.endpointVersion,
    capturedDate: new Date(archive.capturedAt).toISOString().slice(0, 10),
    archivePath: `rapidapi/facebook/social.facebook.search/${callId}`, envelopePointer: '$', sourceKey: callId,
    payloadSha256: archive.payloadSha256, rawPayload: archive.rawPayload }]
}

// Standard search alone combines full paid pages. Supplier selection, monthly
// allowance and confirmed-429 fallback remain separate from page assembly.
export async function runFacebookSearchFill({ gateway, gateways, context, delivery, request, policyStore,
  deadlineAt, signal, resolveCredential, enterCapacity, leaveCapacity, revalidateIdentity,
  providerCostControl, persistedCallEvidence, publicFailure }, { clock = Date.now } = {}) {
  const store = gateway.platformStore, stores = Object.fromEntries(Object.entries(gateways).map(([key, value]) => [key, value.platformStore]))
  const started = performance.now(), identity = { tenantId: context.tenant.id, consumerId: context.consumer.id,
    apiKeyId: context.apiKey.id, path: '/api/v1/data/search', query: request.query, pageSize: request.pageSize,
    type: request.resultType, scopeHash: request.scopeHash, startDate: request.startDate, endDate: request.endDate, stores }
  const history = await store.facebookDeliveredIdsFor({ ...identity, previousDeliveryId: request.fill?.previousDeliveryId })
  const seen = new Set(history.ids), rows = [], sources = [], tokens = new Set()
  let provider = request.provider, pinned = Boolean(request.provider), providerCursor = request.providerCursor ?? null
  // A legacy JustOne cursor may follow a paid RapidAPI 429 on its first page.
  // Its predecessor is unknown, so count that possible extra acquisition.
  const legacyFallbackAllowance = !request.fill && request.provider === 'justone' ? 1 : 0
  let upstreamPages = request.fill?.upstreamPages ?? Math.max(0, request.page - 1) + legacyFallbackAllowance
  if (!request.fill && upstreamPages >= MAX_PAGES) throw new AppError(409, 'search_restart_required',
    'The legacy Facebook continuation has reached its conservative acquisition limit; restart explicitly')
  let calls = 0, bytes = 0, capturedAt = null, buffer = null, stopReason = null
  let ownsLease = false, retainLease = false, hadSucceeded = false, settledFailure = false
  const parentLease = { consumerId: context.consumer.id, operation: FACEBOOK_OPERATION.operationKey,
    fingerprint: delivery.fingerprint, ownerRequestId: delivery.usageRequestId, expiresAt: new Date(deadlineAt) }
  const markUnknown = async () => {
    try { await gateway.usageStore.markRequestUnknown(delivery.usageRequestId, 'external_platform_persistence_unknown'); return }
    catch {
      try {
        const saved = await gateway.usageStore.getRequest(delivery.usageRequestId, delivery.consumerId)
        if (['unknown', 'committed'].includes(saved?.status)) return
      } catch { /* Hold arbitration and customer funds until durable recovery. */ }
      retainLease = true
    }
  }
  const consume = (publicBody, source, inputCursor, offset = 0, expectedHash = null) => {
    const full = publicBody.data.items
    if (!Array.isArray(full) || full.length > 10000) throw unavailable()
    const rowsHash = hash(full)
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > full.length
      || expectedHash && (expectedHash !== rowsHash || offset < 1 || offset >= full.length)) throw unavailable()
    sources.push({ callId: source.callId, providerKey: source.providerKey, bodySize: source.bodySize,
      bodySha256: source.bodySha256, capturedAt: source.capturedAt, rowsHash })
    capturedAt = source.capturedAt
    let position = offset
    while (position < full.length && rows.length < request.pageSize) {
      const row = full[position++]
      if (seen.has(row.content_id)) continue
      seen.add(row.content_id)
      rows.push(structuredClone(row))
    }
    if (position < full.length) {
      buffer = { callId: source.callId, offset: position, hash: rowsHash }
      providerCursor = inputCursor
    } else {
      buffer = null
      providerCursor = publicBody.providerPage?.nextProviderCursor ?? null
      if (providerCursor && (providerCursor === inputCursor || tokens.has(providerCursor))) {
        providerCursor = null
        stopReason = 'repeated_cursor'
      }
    }
  }
  try {
    const claim = await store.acquireFacebookFillDeliveryLease(parentLease)
    if (claim !== true && claim?.kind !== 'acquired') throw new AppError(409, 'request_in_progress', 'An equal Facebook delivery is in progress')
    ownsLease = true
    if (request.buffer) {
      const archived = await store.facebookPageFor({ ...identity, callId: request.buffer.callId, sourceProvider: provider })
      if (!archived || archived.bodySize > PAGE_BYTES[provider]) throw unavailable()
      bytes += archived.bodySize
      const payload = provider === 'justone' ? archived.payload?.data : archived.payload
      let full
      try { full = projectFacebookSearch(payload, { ...request, encodeNext: () => null }, provider,
        archived.capturedAt, { allowOverflow: true }).publicBody }
      catch { throw unavailable() }
      consume(full, { ...archived, callId: request.buffer.callId }, providerCursor, request.buffer.offset, request.buffer.hash)
    }
    while (rows.length < request.pageSize && !buffer) {
      if (providerCursor && tokens.has(providerCursor)) { stopReason = 'repeated_cursor'; providerCursor = null; break }
      if (upstreamPages >= MAX_PAGES) { stopReason = 'upstream_page_limit'; break }
      if (sources.length && !providerCursor) break
      let currentCall = null, evidence = null, costReservation = null, childLease = null, entered = false
      let admission = null, observationFailed = false, sourceProvider = null
      try {
        if (signal?.aborted) throw new AppError(499, 'request_cancelled', 'Request cancelled before dispatch')
        context = await revalidateIdentity()
        const policy = await policyStore.facebook()
        if (policy.mode === 'paused') throw new AppError(503, 'facebook_search_paused', 'Facebook search is paused')
        provider ||= policy.mode === 'justone' ? 'justone' : 'rapidapi'
        sourceProvider = provider
        const target = gateways[provider]
        if (!target) throw new AppError(503, 'external_platform_not_configured', 'Facebook supplier is unavailable')
        if (bytes + PAGE_BYTES[provider] > MAX_BYTES) { stopReason = 'archive_byte_limit'; break }
        if (!Number.isFinite(deadlineAt) || clock() + (target.config.timeoutMs || 30000) + 5000 >= deadlineAt) { stopReason = 'deadline'; break }
        const base = request.forProvider(provider), operation = provider === 'rapidapi' ? FACEBOOK_OPERATION.operationKey : base.operation
        const stepDelivery = { ...delivery, operation }
        const authorizeStep = async () => {
          context = await revalidateIdentity()
          if ((await policyStore.facebook()).mode === 'paused') throw new AppError(503, 'facebook_search_paused', 'Facebook search is paused')
          const shared = await target.platformStore.providerState(provider)
          const state = isHubRateLimitExempt(context) ? internalCircuitState(gateway.usageStore, context, shared) : shared
          const contract = await target.platformStore.contractCircuitState?.(provider, 'facebook')
          const blocked = await openCircuitError({ store: target.platformStore, state, contract, now: clock(), config: target.config,
            message: 'Facebook supplier is temporarily unavailable', marketplace: 'facebook' })
          if (blocked) throw blocked
          const credential = await resolveCredential(provider)
          if (!credential.ready) throw new AppError(503, 'external_platform_not_configured', 'Facebook supplier is unavailable')
          const control = await target.operationControlStore.authorizeDispatch(provider, operation, {
            consumerId: context.consumer.id, config: target.config, credentialConfigured: true, credentialRevision: credential.revision })
          const cost = providerCostControl(control?.billing ? { billing: control.billing } : target.config, base.endpointKey, provider === 'rapidapi')
          return { credential, control, cost }
        }
        let authorization = await authorizeStep()
        const sourceLease = { ...parentLease, operation, endpointKey: base.endpointKey, contractVersion: base.endpointContractVersion }
        const lease = await target.platformStore.acquireDispatchLease({ ...sourceLease, ownedDeliveryLease: provider === 'rapidapi' })
        if (lease !== true && lease?.kind !== 'acquired') {
          const code = lease?.reason === 'unknown' ? 'request_outcome_unknown'
            : lease?.reason === 'succeeded_unusable' ? 'external_platform_response_unusable' : 'request_in_progress'
          throw new AppError(409, code, 'An equal Facebook search is pending or has an unresolved result')
        }
        if (provider !== 'rapidapi') childLease = sourceLease
        if (!(entered = await enterCapacity(provider, { lease: { ...sourceLease, ownedDeliveryLease: provider === 'rapidapi' },
          expiresAt: new Date(deadlineAt), signal, canWait: !sources.length,
          revalidate: async () => { authorization = await authorizeStep(); return context } }))) {
          throw new AppError(503, 'external_platform_busy', 'Facebook supplier capacity is occupied')
        }
        let { credential, control, cost } = authorization
        costReservation = cost.costMinor === 0 ? null : await target.platformStore.reserveProviderCostWorkflow({ ...delivery, costControls: [cost] })
        const rate = await acquireSupplierRate(context, target.platformStore, { limit: (await refreshAdmissionLimits(target)).maxRequestsPerMinute ?? 90,
          windowMs: 60000, signal, providerState: () => target.platformStore.providerState(provider),
          deadline: deadlineAt - (target.config.timeoutMs || 30000) - 5000 })
        if (!rate.allowed) throw new AppError(429, 'external_platform_rate_limited', 'Facebook supplier rate limit is exhausted')
        if (provider === 'rapidapi') {
          admission = await waitForFacebookRapidAdmission({ policyStore, rateLimitExempt: () => bypassesSupplierLimits(context), requestId: delivery.usageRequestId,
            deadlineAt, timeoutMs: target.config.timeoutMs || 30000, signal, logger: gateway.logger,
            revalidate: async () => {
              const latest = await authorizeStep()
              if (JSON.stringify(latest.cost) !== JSON.stringify(cost)) throw new AppError(503,
                'external_platform_cost_control_unavailable', 'Procurement controls changed while waiting')
              credential = latest.credential; control = latest.control
              const claim = await target.platformStore.acquireDispatchLease({ ...sourceLease, ownedDeliveryLease: true })
              if (claim !== true && claim?.kind !== 'acquired') throw new AppError(409,
                claim?.reason === 'unknown' ? 'request_outcome_unknown' : claim?.reason === 'succeeded_unusable'
                  ? 'external_platform_response_unusable' : 'request_in_progress', 'Dispatch protection changed while waiting')
            } })
          if (!admission.allowed) {
            if ((await policyStore.facebook()).mode === 'paused') throw new AppError(503, 'facebook_search_paused', 'Facebook search is paused')
            throw new AppError(503, pinned ? 'search_restart_required' : 'facebook_search_capacity_unavailable',
              'Facebook search capacity is temporarily unavailable')
          }
        }
        if (signal?.aborted) throw new AppError(499, 'request_cancelled', 'Request cancelled before dispatch')
        if (clock() + (target.config.timeoutMs || 30000) + 5000 >= deadlineAt) { stopReason = 'deadline'; break }
        const inputCursor = providerCursor, step = { ...request, ...base, providerCursor: inputCursor, encodeNext: () => null,
          standardSearch: true, allowOverflow: true, upstreamQuery: { ...base.upstreamQuery } }
        delete step.upstreamQuery.cursor
        if (inputCursor) step.upstreamQuery.cursor = inputCursor
        currentCall = await target.platformStore.beginProviderCall({ ...stepDelivery,
          contractVersion: base.endpointContractVersion, endpointKey: base.endpointKey, endpointVersion: base.endpointVersion,
          marketplace: 'facebook', dispatchFingerprint: delivery.fingerprint, callOrdinal: calls, callRole: calls ? 'enrichment' : 'primary',
          costControl: cost.costMinor === 0 ? null : cost, costReservationId: costReservation?.id ?? null, operationControl: control })
        calls++; upstreamPages++
        if (inputCursor) tokens.add(inputCursor)
        const callStarted = performance.now()
        let result, failure = null
        try {
          result = provider === 'rapidapi'
            ? await target.adapter.execute(step, { credential: credential.credential })
            : await target.adapter.forwardNative(FACEBOOK_JUSTONE_KEY, { params: step.upstreamQuery }, { credential: credential.credential })
          if (provider === 'justone') {
            const projected = projectFacebookSearch(result.publicBody.data, step, provider, result.publicBody.meta.capturedAt, { allowOverflow: true })
            result = { ...result, restrictedResponseArchive: result.restrictedResponseArchive,
              archiveObjects: facebookJustOneArchives(result.archiveObjects, base.endpointVersion), ...projected }
          }
        } catch (error) {
          if (!(error instanceof RapidApiUpstreamError || error instanceof JustOneUpstreamError)) {
            if (!result) throw error
            error = new JustOneUpstreamError('JustOneSucceededUnusableError', 'Facebook response could not be normalized', {
              outcome: 'succeeded_unusable', billed: true, httpStatus: 200, businessCode: 0, errorCode: 'invalid_facebook_response',
            }, facebookJustOneArchives(result.archiveObjects, base.endpointVersion), result.restrictedResponseArchive)
          }
          failure = error
        }
        const source = result && !failure ? result : failure
        const persisted = persistedCallEvidence(source)
        const archiveObjects = provider === 'rapidapi' ? rapidArchives(source, base, currentCall.id)
          : facebookJustOneArchives(source.archiveObjects, base.endpointVersion)
        const probe = provider === 'rapidapi' && admission?.probe === true
        evidence = { callId: currentCall.id, delivery: stepDelivery, outcome: failure ? failure.evidence.outcome : 'succeeded',
          billed: failure ? failure.evidence.billed ?? null : provider === 'rapidapi' ? null : true,
          httpStatus: persisted.responseArchive?.httpStatus ?? failure?.evidence.httpStatus ?? 200,
          businessCode: persisted.responseArchive?.businessCode ?? failure?.evidence.businessCode ?? (provider === 'justone' ? 0 : null),
          costMinor: probe ? null : cost.costMinor, costKind: probe ? 'unknown' : cost.costKind, currency: probe ? null : cost.currency,
          latencyMs: Math.round(performance.now() - callStarted), itemCount: failure ? 0 : result.items.length,
          errorCode: failure?.evidence.errorCode ?? null, affectsCircuit: failure ? failure.evidence.affectsCircuit !== false : false,
          ...persisted, archiveObjects }
        if (provider === 'rapidapi') {
          try { await policyStore.observeRapid(admission, failure?.evidence.quota ?? result?.quota) }
          catch { observationFailed = true; gateway.logger?.warn?.('[external-platform] Facebook quota observation is unavailable; its admission remains reserved') }
        }
        if (failure) {
          const policyNow = await policyStore.facebook()
          const mayFallback = provider === 'rapidapi' && failure.evidence.httpStatus === 429
            && failure.evidence.outcome === 'rejected' && policyNow.mode === 'auto' && !pinned && !inputCursor && upstreamPages < MAX_PAGES
          if (mayFallback) {
            await target.platformStore.finishProviderStep({ ...evidence, affectsCircuit: false })
            currentCall = null
            provider = 'justone'
            continue
          }
          const mapped = publicFailure(failure)
          await target.platformStore.finishFailure({ ...evidence, failureResponseStatus: mapped.status,
            failureResponseBody: { error: { code: mapped.code, message: mapped.message,
              details: { ...mapped.details, requestId: delivery.usageRequestId } }, requestId: delivery.usageRequestId } })
          currentCall = null
          settledFailure = true
          throw mapped
        }
        hadSucceeded = true
        const receipt = result.restrictedResponseArchive
        if (!receipt || receipt.bodySize > PAGE_BYTES[provider] || !result.publicBody.providerPage) throw unavailable()
        bytes += receipt.bodySize
        const records = rawSearchRecords(result.publicBody, 'facebook', provider, { projectionVersion: request.projectionVersion })
        await target.platformStore.stageProviderEvidence(evidence)
        await target.platformStore.finishProviderStep({ ...evidence, ingestJob: { payload: { kind: 'external-platform-result',
          providerKey: provider, consumerId: context.consumer.id, datasetId: 'night-all.search.v1', platform: 'facebook',
          requestId: delivery.usageRequestId, queryFingerprint: delivery.fingerprint, providerCallId: currentCall.id, records },
          dedupeKey: `external-platform:${provider}:${currentCall.id}`, priority: 100 } })
        const callId = currentCall.id
        currentCall = null
        pinned = true
        consume(result.publicBody, { callId, providerKey: provider, bodySize: receipt.bodySize,
          bodySha256: receipt.bodySha256, capturedAt: receipt.capturedAt }, inputCursor)
        if (observationFailed) { stopReason = 'quota_observation_unavailable'; break }
      } catch (error) {
        const target = gateways[provider]
        if (currentCall || error?.code === 'external_platform_call_persistence_unknown') {
          if (currentCall) await target.platformStore.markPersistenceUnknown({ callId: currentCall.id, delivery, ...(evidence || {}),
            errorCode: evidence?.errorCode ?? 'external_platform_persistence_unknown' }).catch(() => {})
          await markUnknown()
          throw uncertain()
        }
        if (knownAdmission(error)) {
          const policy = await policyStore.facebook()
          const hubQueueBusy = error.code === 'external_platform_busy' && error.details?.layer === 'hub'
          if (!hubQueueBusy && provider === 'rapidapi' && !pinned && !providerCursor && policy.mode === 'auto' && gateways.justone) {
            provider = 'justone'
            continue
          }
          if (sources.length) { stopReason = error.code; break }
        }
        if (!sources.length && error.details?.stage === 'facebook_quota_admission') {
          await target.platformStore.rejectWithoutDispatch({ delivery, sourceMode: 'unavailable',
            status: error.status || 503, errorCode: error.code })
        }
        throw error
      } finally {
        // The source provider may have switched after a confirmed rejection;
        // release resources on the provider that owned the current step.
        const target = gateways[sourceProvider]
        if (costReservation) await target.platformStore.releaseProviderCostWorkflow({ reservationId: costReservation.id,
          usageRequestId: delivery.usageRequestId }).catch(() => {})
        if (childLease) await target.platformStore.releaseDispatchLease(childLease).catch(() => {})
        if (entered) leaveCapacity(sourceProvider, entered)
        if (admission && !observationFailed) await policyStore.observeRapid(admission).catch(() => {})
      }
    }
    if (!sources.length) throw new AppError(503, 'facebook_search_capacity_unavailable', 'No Facebook page could be acquired within the bounded search')
    if ((buffer || providerCursor) && request.page >= MAX_PAGES) stopReason ||= 'public_page_limit'
    else if (!buffer && providerCursor && upstreamPages >= MAX_PAGES) stopReason ||= 'upstream_page_limit'
    const more = Boolean(buffer || providerCursor) && request.page < MAX_PAGES && (Boolean(buffer) || upstreamPages < MAX_PAGES)
    const nextCursor = more ? request.encodeFillNext({ provider, providerCursor, buffer,
      previousDeliveryId: delivery.usageRequestId, upstreamPages }) : null
    const warnings = stopReason ? [{ code: 'FACEBOOK_PAGE_FILL_STOPPED', message: 'Facebook returned available items because its bounded continuation stopped.' }] : []
    const raw = { publicBody: { data: { platform: 'facebook', query: request.query, items: rows, raw_info: '[]', raw_data: JSON.stringify(rows),
      page: { page: request.page, pageSize: request.pageSize, returnedCount: rows.length, hasMore: more, nextCursor },
      status: warnings.length ? 'partial' : 'ok', warnings, meta: { upstreamCallCount: calls } }, meta: { capturedAt } }, items: rows }
    const projected = projectDataSearch(raw, request), responseBody = { data: projected.data, requestId: delivery.usageRequestId }
    const sourceMode = calls ? 'live' : clock() - Date.parse(capturedAt) <= gateway.config.freshTtlMs ? 'fresh_cache' : 'stored_fallback'
    try {
      await store.commitFacebookFillDelivery({ delivery, responseBody, capturedAt, usageUnitsActual: rows.length, sourceMode,
        latencyMs: Math.round(performance.now() - started), ...identity,
        lineage: { version: 'facebook-fill.v1', scopeHash: request.scopeHash, previousDeliveryId: history.previousDeliveryId,
          upstreamPages, startDate: request.startDate, endDate: request.endDate }, sources })
    } catch { await markUnknown(); throw uncertain() }
    return { status: 200, body: responseBody, requestId: delivery.usageRequestId, replay: false, sourceMode, capturedAt,
      staleAgeSeconds: Math.max(0, Math.floor((clock() - Date.parse(capturedAt)) / 1000)) }
  } catch (error) {
    if (hadSucceeded && !settledFailure) {
      await markUnknown()
      if (!error.preserveReservation) throw uncertain()
    }
    throw error
  } finally {
    if (ownsLease && !retainLease) await store.releaseDispatchLease(parentLease).catch(() => {})
  }
}
