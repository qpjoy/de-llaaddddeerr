import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { AppError } from '../core/errors.mjs'

// Longest a request queues for a Night-All-A slot. With the 60 s run budget it
// keeps one self-hosted search inside Delta's 90 s client timeout.
export const FACEBOOK_SELFHOSTED_MAX_WAIT_MS = 25_000
// A lease outlives a timed-out run until Night-All-A's own container timeout
// has certainly stopped it; an unconfirmed cancel never frees a slot early.
export const FACEBOOK_SELFHOSTED_LEASE_GRACE_MS = 60_000

const detail = { platform: 'facebook', layer: 'hub', stage: 'facebook_selfhosted_admission', upstreamDispatched: false }
const busy = (reason, retryAfterMs = 1000) => new AppError(503, 'external_platform_busy',
  `Hub 自建 Facebook 采集${reason === 'queue_full' ? '等待队列已满' : '等待并发名额超时'}，请稍后重试。`,
  { ...detail, reason, retryAfterMs })

// All replicas join one PostgreSQL FIFO. Polling holds no connection or slot;
// only the queue head may take a slot, and only when spacing allows a start.
export async function waitForFacebookSelfhostedAdmission({ policyStore, requestId, deadlineAt, budgetMs, signal, revalidate, logger },
  { clock = Date.now, wait = sleep } = {}) {
  const started = clock(), deadline = Math.min(started + FACEBOOK_SELFHOSTED_MAX_WAIT_MS, deadlineAt - budgetMs - 5000)
  const ticket = { id: randomUUID(), requestId, deadline }, leaseMs = budgetMs + FACEBOOK_SELFHOSTED_LEASE_GRACE_MS
  let admission = null, returned = false, lastReason = null
  const log = reason => {
    try { logger?.info?.(JSON.stringify({ event: 'facebook_selfhosted_admission', requestId, reason,
      waitedMs: Math.max(0, clock() - started), inFlight: admission?.inFlight ?? null, queueDepth: admission?.queueDepth ?? null })) }
    catch { /* Diagnostics never change admission. */ }
  }
  try {
    while (true) {
      if (signal?.aborted) throw new AppError(499, 'request_cancelled', 'Request cancelled before dispatch')
      if (!Number.isFinite(deadline) || clock() >= deadline) throw busy('queue_timeout')
      admission = await policyStore.admitSelfhosted(ticket, { leaseMs })
      if (admission.allowed) {
        await revalidate?.()
        if (signal?.aborted) throw new AppError(499, 'request_cancelled', 'Request cancelled before dispatch')
        log('admitted')
        returned = true
        return admission
      }
      lastReason = admission.reason
      if (['queue_full', 'queue_timeout'].includes(admission.reason)) throw busy(admission.reason)
      if (admission.reason === 'strategy_changed') {
        const policy = await policyStore.facebook()
        if (policy.mode === 'paused') throw new AppError(503, 'facebook_search_paused', 'Facebook search is paused', detail)
        throw new AppError(503, 'facebook_search_capacity_unavailable', 'The Facebook search strategy changed while waiting', detail)
      }
      await wait(Math.max(50, Math.min(admission.retryAfterMs ?? 500, 1000, deadline - clock())), undefined, { signal })
    }
  } catch (error) {
    log(signal?.aborted ? 'request_cancelled' : error.details?.reason || lastReason || 'unavailable')
    if (signal?.aborted) throw new AppError(499, 'request_cancelled', 'Request cancelled before dispatch', detail)
    if (!(error instanceof AppError)) throw new AppError(503, 'facebook_selfhosted_state_unavailable',
      'Hub 自建 Facebook 采集名额状态暂不可读，请稍后重试。', detail)
    error.details = { ...error.details, ...detail }
    throw error
  } finally {
    if (!admission?.allowed) {
      try { await policyStore.cancelSelfhostedWait?.(ticket) } catch { /* The deadline also expires an abandoned waiter. */ }
    }
    // Admitted but not returned (revalidation failed): no task was submitted.
    if (admission?.allowed && !returned) await policyStore.releaseSelfhosted(admission).catch(() => {})
  }
}
