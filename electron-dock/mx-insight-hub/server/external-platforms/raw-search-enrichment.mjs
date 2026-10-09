import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { AppError } from '../core/errors.mjs'
import { internalCircuitState, acquireTikHubRateLimit } from '../core/internal-traffic-policy.mjs'
import { TikHubUpstreamError } from '../adapters/tikhub.mjs'
import { normalizeNativeForwardingRequest } from '../contracts/native-forwarding.mjs'
import { WEIBO_DETAIL_KEY, mergeWeiboDetail } from '../contracts/raw-search.mjs'

// Child calls share the search's usage/wallet identity, but each has its own
// operation policy, procurement hold, rate admission and immutable receipt.
export async function enrichWeiboRawSearch({ gateway, context, request, result, delivery,
  credential, credentialRevision, providerCostControl, deadlineAt }, { clock = Date.now, wait = sleep } = {}) {
  const rows = result.items
  const candidates = rows.filter(row => request.enrichment.all || row.body_completeness === 'provider_preview')
  const unique = [...new Map(candidates.map(row => [row.content_id, row])).values()]
  const selected = request.enrichment.enabled ? unique.slice(0, request.enrichment.maxItems) : []
  const skipped = unique.slice(selected.length).map(row => ({ postId: row.content_id,
    reason: request.enrichment.enabled ? 'max_items' : 'disabled' }))
  const skipRemaining = (index, reason) => {
    for (const row of selected.slice(index)) skipped.push({ postId: row.content_id, reason })
  }
  let calls = 0, repaired = 0, admissionWaitMs = 0
  const dispatchReserveMs = (gateway.config.timeoutMs || 30_000) + 5_000
  const remainingWait = delay => {
    if (!Number.isFinite(delay) || delay < 0) return 0
    const needed = Math.max(100, Math.ceil(delay))
    if (needed > 60_000 - admissionWaitMs || clock() + needed + dispatchReserveMs >= deadlineAt) return 0
    return Math.min(needed, 5_000)
  }
  rows: for (const [index, row] of selected.entries()) {
    const body = { params: { id: row.content_id, is_get_long_text: 'true' } }
    const detail = normalizeNativeForwardingRequest(WEIBO_DETAIL_KEY, body)
    const stepDelivery = { ...delivery, operation: detail.operation }
    const dispatchFingerprint = createHash('sha256').update(JSON.stringify({ version: 'weibo-full-text.v1', id: row.content_id })).digest('hex')
    // Retry only local admission, before a paid dispatch. Release holds and
    // leases while waiting; re-read policy, circuit and budget on each pass.
    while (true) {
      if (clock() + dispatchReserveMs >= deadlineAt) {
        skipRemaining(index, 'deadline')
        break rows
      }
      let waitMs = 0
      let call, costReservation, ownsLease = false, evidence = null
      try {
        const providerState = internalCircuitState(gateway.usageStore, context,
          await gateway.platformStore.providerState(gateway.providerKey))
        const circuitDelay = Date.parse(providerState?.circuitOpenUntil) - clock()
        if (circuitDelay > 0) {
          if (providerState.lastErrorCode === 'upstream_rate_limited') waitMs = remainingWait(circuitDelay)
          if (waitMs) continue
          skipRemaining(index, 'provider_circuit_open')
          break rows
        }
        const control = await gateway.operationControlStore.authorizeDispatch(gateway.providerKey, detail.operation, {
          consumerId: context.consumer.id, config: gateway.config,
          credentialConfigured: true, credentialRevision,
        })
        const cost = providerCostControl({ billing: control.billing }, detail.endpointKey)
        const lease = await gateway.platformStore.acquireDispatchLease({
          consumerId: context.consumer.id, operation: detail.operation, fingerprint: dispatchFingerprint,
          endpointKey: detail.endpointKey, contractVersion: detail.endpointContractVersion,
          ownerRequestId: delivery.usageRequestId, expiresAt: new Date(deadlineAt),
        })
        ownsLease = lease === true || lease?.kind === 'acquired'
        if (!ownsLease) {
          skipped.push({ postId: row.content_id, reason: 'dispatch_lease_unavailable' })
          continue rows
        }
        costReservation = await gateway.platformStore.reserveProviderCostWorkflow({
          tenantId: context.tenant.id, consumerId: context.consumer.id, apiKeyId: context.apiKey.id,
          usageRequestId: delivery.usageRequestId, fingerprint: delivery.fingerprint, costControls: [cost],
        })
        const rate = await acquireTikHubRateLimit(gateway.usageStore, context, gateway.platformStore,
          { limit: gateway.config.maxRequestsPerMinute ?? 90, windowMs: 60_000 })
        if (!rate.allowed) {
          waitMs = remainingWait(rate.retryAfterMs)
          if (waitMs) continue
          skipRemaining(index, 'provider_rate_limited')
          break rows
        }
        if (clock() + dispatchReserveMs >= deadlineAt) {
          skipRemaining(index, 'deadline')
          break rows
        }
        call = await gateway.platformStore.beginProviderCall({
          tenantId: context.tenant.id, consumerId: context.consumer.id, apiKeyId: context.apiKey.id,
          usageRequestId: delivery.usageRequestId, operation: detail.operation,
          contractVersion: detail.endpointContractVersion, endpointKey: detail.endpointKey,
          endpointVersion: detail.endpointVersion, marketplace: 'weibo', fingerprint: delivery.fingerprint,
          dispatchFingerprint, callOrdinal: calls + 2, callRole: 'enrichment',
          costControl: cost, costReservationId: costReservation.id, operationControl: control,
        })
        calls++
        const started = performance.now()
        let upstream, failure
        try { upstream = await gateway.adapter.forwardNative(WEIBO_DETAIL_KEY, body, credential) }
        catch (error) { failure = error }
        const source = upstream || failure
        const providerFailure = failure instanceof TikHubUpstreamError ? failure.evidence : null
        evidence = {
          callId: call.id, delivery: stepDelivery,
          outcome: failure ? providerFailure?.outcome || 'unknown' : 'succeeded',
          billed: failure ? providerFailure?.billed ?? null : true,
          httpStatus: source?.responseArchive?.httpStatus ?? providerFailure?.httpStatus ?? null,
          businessCode: source?.responseArchive?.businessCode ?? providerFailure?.businessCode ?? null,
          costMinor: cost.costMinor, costKind: cost.costKind, currency: cost.currency,
          latencyMs: Math.max(0, Math.round(performance.now() - started)), itemCount: failure ? 0 : 1,
          errorCode: failure ? providerFailure?.errorCode || 'raw_search_detail_unknown' : null,
          affectsCircuit: failure ? providerFailure?.affectsCircuit !== false : false,
          responseArchive: source?.responseArchive, restrictedResponseArchive: source?.restrictedResponseArchive,
          upstreamEvidence: source?.upstreamEvidence, archiveObjects: source?.archiveObjects || [],
        }
        if (source?.restrictedResponseArchive) await gateway.platformStore.stageProviderEvidence(evidence)
        await gateway.platformStore.finishProviderStep(evidence)
        call = null
        if (!failure) {
          for (const candidate of rows.filter(candidate => candidate.content_id === row.content_id)) {
            try { if (mergeWeiboDetail(candidate, upstream)) repaired++ }
            catch { /* An unusable detail stays archived; the preview is explicitly incomplete. */ }
          }
        }
        if (failure && evidence.outcome === 'unknown') {
          skipRemaining(index + 1, 'previous_detail_unknown')
          break rows
        }
        break // A sent detail is never re-dispatched by the admission loop.
      } catch (error) {
        // Admission failures may leave a truthful partial result. Persistence
        // uncertainty must stop the parent; it is never another paid retry.
        if (call || error?.code === 'external_platform_call_persistence_unknown') throw error
        if (!(error instanceof AppError)) throw error
        if (!(error.code.startsWith('external_platform_operation_')
          || error.code.startsWith('external_platform_cost_')
          || error.code === 'external_platform_subsidy_budget_exhausted')) throw error
        skipRemaining(index, error.code.startsWith('external_platform_operation_') ? 'operation_unavailable'
          : error.code === 'external_platform_subsidy_budget_exhausted' ? 'subsidy_budget_exhausted' : 'cost_unavailable')
        break rows
      } finally {
        if (costReservation) await gateway.platformStore.releaseProviderCostWorkflow({
          reservationId: costReservation.id, usageRequestId: delivery.usageRequestId,
        })
        if (ownsLease) await gateway.platformStore.releaseDispatchLease({
          consumerId: context.consumer.id, operation: detail.operation, fingerprint: dispatchFingerprint,
          ownerRequestId: delivery.usageRequestId,
        })
        if (waitMs) {
          const started = clock()
          await wait(waitMs)
          admissionWaitMs += Math.max(waitMs, clock() - started)
        }
      }
    }
  }
  const incomplete = rows.filter(row => row.body_completeness === 'provider_preview').length
  // Standard data/search deliberately keeps its strict v1 response. Retain
  // admission reasons in a bounded, content/credential-free operational log;
  // a missing child receipt alone cannot explain why it was never dispatched.
  if (incomplete) gateway.logger?.warn?.(JSON.stringify({ event: 'weibo_full_text_incomplete',
    requestId: delivery.usageRequestId, detailUpstreamCalls: calls, incompleteItems: incomplete, admissionWaitMs, skipped }))
  result.publicBody.data.raw_data = JSON.stringify(rows)
  result.publicBody.data.status = incomplete ? 'partial' : 'ok'
  result.publicBody.data.meta = { ...result.publicBody.data.meta, upstreamCallCount: 1 + calls,
    enrichment: { requestedItems: candidates.length, detailUpstreamCalls: calls, detailsUsed: repaired, incompleteItems: incomplete } }
  if (incomplete) result.publicBody.data.warnings = [{ code: 'WEIBO_FULL_TEXT_INCOMPLETE', count: incomplete }]
  return result
}
