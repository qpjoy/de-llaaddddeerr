import { createHash } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { TikHubUpstreamError } from '../adapters/tikhub.mjs'
import { normalizeNativeForwardingRequest } from '../contracts/native-forwarding.mjs'
import { WEIBO_DETAIL_KEY, mergeWeiboDetail } from '../contracts/raw-search.mjs'

// Child calls share the search's usage/wallet identity, but each has its own
// operation policy, procurement hold, rate admission and immutable receipt.
export async function enrichWeiboRawSearch({ gateway, context, request, result, delivery,
  credential, credentialRevision, providerCostControl, deadlineAt }) {
  const rows = result.items
  const candidates = rows.filter(row => request.enrichment.all || row.body_completeness === 'provider_preview')
  const unique = [...new Map(candidates.map(row => [row.content_id, row])).values()]
  const selected = request.enrichment.enabled ? unique.slice(0, request.enrichment.maxItems) : []
  let calls = 0, repaired = 0
  for (const row of selected) {
    if (Date.now() + (gateway.config.timeoutMs || 30_000) + 5_000 >= deadlineAt) break
    const body = { params: { id: row.content_id, is_get_long_text: 'true' } }
    const detail = normalizeNativeForwardingRequest(WEIBO_DETAIL_KEY, body)
    const stepDelivery = { ...delivery, operation: detail.operation }
    const dispatchFingerprint = createHash('sha256').update(JSON.stringify({ version: 'weibo-full-text.v1', id: row.content_id })).digest('hex')
    let call, costReservation, ownsLease = false, evidence = null
    try {
      const providerState = await gateway.platformStore.providerState(gateway.providerKey)
      if (providerState?.circuitOpenUntil && new Date(providerState.circuitOpenUntil).getTime() > Date.now()) break
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
      if (!ownsLease) continue
      costReservation = await gateway.platformStore.reserveProviderCostWorkflow({
        tenantId: context.tenant.id, consumerId: context.consumer.id, apiKeyId: context.apiKey.id,
        usageRequestId: delivery.usageRequestId, fingerprint: delivery.fingerprint, costControls: [cost],
      })
      const rate = await gateway.platformStore.acquireProviderRateLimit({ limit: gateway.config.maxRequestsPerMinute ?? 90, windowMs: 60_000 })
      if (!rate.allowed) break
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
      if (failure && evidence.outcome === 'unknown') break
    } catch (error) {
      // Admission failures may leave a truthful partial result. Persistence
      // uncertainty must stop the parent; it is never another paid retry.
      if (call || error?.code === 'external_platform_call_persistence_unknown') throw error
      if (!(error instanceof AppError)) throw error
      if (!(error.code.startsWith('external_platform_operation_')
        || error.code.startsWith('external_platform_cost_')
        || error.code === 'external_platform_subsidy_budget_exhausted')) throw error
      break
    } finally {
      if (costReservation) await gateway.platformStore.releaseProviderCostWorkflow({
        reservationId: costReservation.id, usageRequestId: delivery.usageRequestId,
      })
      if (ownsLease) await gateway.platformStore.releaseDispatchLease({
        consumerId: context.consumer.id, operation: detail.operation, fingerprint: dispatchFingerprint,
        ownerRequestId: delivery.usageRequestId,
      })
    }
  }
  const incomplete = rows.filter(row => row.body_completeness === 'provider_preview').length
  result.publicBody.data.raw_data = JSON.stringify(rows)
  result.publicBody.data.status = incomplete ? 'partial' : 'ok'
  result.publicBody.data.meta = { ...result.publicBody.data.meta, upstreamCallCount: 1 + calls,
    enrichment: { requestedItems: candidates.length, detailUpstreamCalls: calls, detailsUsed: repaired, incompleteItems: incomplete } }
  if (incomplete) result.publicBody.data.warnings = [{ code: 'WEIBO_FULL_TEXT_INCOMPLETE', count: incomplete }]
  return result
}
