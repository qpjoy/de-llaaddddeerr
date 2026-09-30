import { createHash, randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { TikHubUpstreamError } from '../adapters/tikhub.mjs'
import { XHS_BLOGGER_NOTES_V2 as contract, needsNoteMetrics, projectBloggerNotesV2, mergeBloggerNoteMetrics } from '../contracts/xiaohongshu-note-metrics.mjs'

const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export async function supplementNoteMetrics({ projection, context, delivery, adapter, platformStore,
  credential, authorize, queue, queuePolicy, timeoutMs, maxRequestsPerMinute, signal }) {
  if (!needsNoteMetrics(projection.data.item)) return
  const meta = projection.meta.metricsSupplement = { status: 'missing_author', pagesFetched: 0, total: null }
  const userId = projection.data.item.author.id
  if (typeof userId !== 'string' || !/^[a-f0-9]{24}$/iu.test(userId)) return
  const deadline = Date.now() + contract.budgetMs
  const seen = new Set()
  const scope = fingerprint(['blogger-notes-v2', credential])
  for (let page = 1; page <= contract.maxPages; page++) {
    if (signal?.aborted) { meta.status = 'cancelled'; return }
    if (Date.now() + timeoutMs > deadline) { meta.status = 'time_limit'; return }
    let costReservation, ticket, call, ownsLease = false
    let outcome = 'failed'
    const dispatchFingerprint = fingerprint([contract.contractVersion, scope, userId.toLowerCase(), page])
    const pageDelivery = { ...delivery, snapshotFingerprint: dispatchFingerprint }
    try {
      // Recheck current price/grants/control before waiting and again before
      // each paid page. No price inheritance from the detail endpoint.
      let admission = await authorize()
      ticket = await queue.enter({ scope, id: randomUUID(),
        fingerprint: fingerprint([delivery.usageRequestId, page]), policy: queuePolicy,
        deadline: Math.min(deadline - timeoutMs, Date.now() + queuePolicy.maxWaitMs), leaseMs: timeoutMs + 30000, signal })
      admission = await authorize()
      if (signal?.aborted) { meta.status = 'cancelled'; return }
      if (Date.now() + timeoutMs > deadline) { meta.status = 'time_limit'; return }
      const lease = await platformStore.acquireDispatchLease({ consumerId: context.consumer.id,
        operation: delivery.operation, fingerprint: dispatchFingerprint, endpointKey: contract.endpointKey,
        contractVersion: contract.contractVersion, ownerRequestId: delivery.usageRequestId,
        expiresAt: new Date(Date.now() + timeoutMs + 30000) })
      ownsLease = lease === true || lease?.kind === 'acquired'
      if (!ownsLease) { meta.status = 'temporarily_unavailable'; return }
      costReservation = await platformStore.reserveProviderCostWorkflow({
        tenantId: context.tenant.id, consumerId: context.consumer.id, apiKeyId: context.apiKey.id,
        usageRequestId: delivery.usageRequestId, fingerprint: delivery.fingerprint, costControls: [admission.costControl],
      })
      const rate = await platformStore.acquireProviderRateLimit({ limit: maxRequestsPerMinute, tokens: 1, windowMs: 60000 })
      if (!rate.allowed) { meta.status = 'temporarily_unavailable'; return }
      const permit = await queue.transition(scope, { ...ticket, type: 'dispatch', leaseMs: timeoutMs + 30000,
        jitterMs: Math.floor(Math.random() * queuePolicy.jitterMs) })
      if (permit.kind !== 'acquired') { meta.status = 'temporarily_unavailable'; return }
      call = await platformStore.beginProviderCall({
        tenantId: context.tenant.id, consumerId: context.consumer.id, apiKeyId: context.apiKey.id,
        usageRequestId: delivery.usageRequestId, operation: delivery.operation,
        contractVersion: contract.contractVersion, endpointKey: contract.endpointKey, endpointVersion: contract.endpointVersion,
        marketplace: 'xiaohongshu', fingerprint: delivery.fingerprint, dispatchFingerprint,
        callOrdinal: page + 1, callRole: 'enrichment', costControl: admission.costControl,
        costReservationId: costReservation.id, ...(admission.operationControl ? { operationControl: admission.operationControl } : {}),
      })
      const startedAt = performance.now()
      let upstream, parsed, error, dispatched = false
      try {
        if (signal?.aborted) throw new AppError(499, 'request_cancelled', 'Request cancelled before dispatch')
        dispatched = true
        upstream = await adapter.getXiaohongshuBloggerNotesV2(userId, page, { credential })
        parsed = projectBloggerNotesV2(upstream.payload)
        const match = parsed.items.find(item => item.externalId === projection.data.item.externalId)
        if (match?.authorId && match.authorId !== userId.toLowerCase()) throw new AppError(502, 'invalid_upstream_contract', 'Note author does not match')
      } catch (caught) { error = caught }
      const providerError = error instanceof TikHubUpstreamError
      const evidence = upstream || (providerError ? error : {})
      const settlement = {
        callId: call.id, delivery: pageDelivery,
        outcome: !dispatched ? 'rejected' : providerError ? error.evidence.outcome : error ? (upstream ? 'succeeded_unusable' : 'unknown') : 'succeeded',
        billed: !dispatched ? false : providerError ? error.evidence.billed : upstream ? true : null,
        costMinor: admission.costControl.costMinor, costKind: admission.costControl.costKind, currency: admission.costControl.currency,
        httpStatus: providerError ? error.evidence.httpStatus : upstream?.responseArchive?.httpStatus,
        businessCode: providerError ? error.evidence.businessCode : upstream?.responseArchive?.businessCode,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)), itemCount: parsed?.items.length ?? null,
        errorCode: error?.code || (providerError ? error.evidence.errorCode : null),
        responseArchive: evidence.responseArchive, restrictedResponseArchive: evidence.restrictedResponseArchive,
        upstreamEvidence: evidence.upstreamEvidence, archiveObjects: evidence.archiveObjects,
        affectsCircuit: dispatched && (providerError ? error.evidence.affectsCircuit !== false : Boolean(error)),
      }
      // Settlement persists the exact page even when projection fails. Never
      // swallow persistence failures or retry an accepted/unknown paid page.
      try { await platformStore.finishProviderStep(settlement) } catch (persistenceError) {
        outcome = 'unknown'
        await platformStore.finishProviderStep({ ...settlement, outcome: 'unknown', affectsCircuit: true })
        throw persistenceError
      }
      outcome = settlement.outcome === 'unknown' ? 'unknown' : error ? 'failed' : 'succeeded'
      if (error) { meta.status = !dispatched ? 'cancelled' : 'temporarily_unavailable'; return }
      meta.pagesFetched++
      meta.total = parsed.total
      const match = parsed.items.find(item => item.externalId === projection.data.item.externalId)
      if (match) {
        mergeBloggerNoteMetrics(projection, match, { page, capturedAt: new Date(upstream.capturedAt).toISOString() })
        return { providerCallId: call.id, sourcePointer: `$.data.data.noteList[${parsed.items.indexOf(match)}].noteInfo`,
          contractVersion: contract.contractVersion }
      }
      if (!parsed.items.length) { meta.status = 'not_found'; return }
      const previous = seen.size
      for (const item of parsed.items) seen.add(item.externalId)
      if (seen.size === previous) { meta.status = 'repeated_page'; return }
      if (parsed.total != null && seen.size >= parsed.total) { meta.status = 'not_found'; return }
    } catch (error) {
      if (call || error.code === 'external_platform_call_persistence_unknown' || !(error instanceof AppError)) throw error
      meta.status = error.code === 'external_platform_cost_control_unavailable' ? 'not_configured' : 'temporarily_unavailable'
      return
    } finally {
      if (costReservation) await platformStore.releaseProviderCostWorkflow({ reservationId: costReservation.id, usageRequestId: delivery.usageRequestId })
      if (ownsLease) await platformStore.releaseDispatchLease({ consumerId: context.consumer.id, operation: delivery.operation,
        fingerprint: dispatchFingerprint, ownerRequestId: delivery.usageRequestId })
      await queue.finish(ticket, outcome)
    }
  }
  meta.status = 'page_limit'
}
