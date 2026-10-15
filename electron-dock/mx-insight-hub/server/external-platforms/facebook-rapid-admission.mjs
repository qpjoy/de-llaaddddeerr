import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { AppError } from '../core/errors.mjs'

const busy = reason => new AppError(503, 'external_platform_busy',
  `Hub Facebook 采集${reason === 'queue_full' ? '共享等待队列已满' : '等待全局采集名额超时'}，请稍后重试。`,
  { platform: 'facebook', layer: 'hub', stage: 'facebook_quota_admission', reason,
    upstreamDispatched: false, retryAfterMs: 1000 })

// All replicas join the same PostgreSQL FIFO. Polling holds no DB connection,
// quota token or new provider call; only the head can reserve included quota.
export async function waitForFacebookRapidAdmission({ policyStore, requestId, deadlineAt, timeoutMs,
  signal, revalidate, logger }, { clock = Date.now, wait = sleep } = {}) {
  const started = clock(), deadline = Math.min(started + 10000, deadlineAt - timeoutMs - 5000)
  const ticket = { id: randomUUID(), requestId, deadline }
  let admission = null, returned = false
  const log = (reason, result = {}) => {
    const reasons = ['included_quota', 'recovery_probe', 'quota_exhausted', 'rate_limited', 'strategy_changed',
      'queue_full', 'queue_timeout', 'request_cancelled', 'revalidation_failed', 'unavailable']
    const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null
    try { logger?.info?.(JSON.stringify({ event: 'facebook_rapid_admission', requestId,
      waitedMs: Math.max(0, clock() - started), probe: result.probe === true,
      used: integer(result.used), remaining: integer(result.remaining), queueDepth: integer(result.queueDepth),
      reason: reasons.includes(reason) ? reason : 'unavailable' })) }
    catch { /* Diagnostics never change acquisition or reservation behavior. */ }
  }
  try {
    while (true) {
      if (signal?.aborted) throw new AppError(499, 'request_cancelled', 'Request cancelled before dispatch')
      if (!Number.isFinite(deadline) || clock() >= deadline) throw busy('queue_timeout')
      admission = await policyStore.admitRapid(ticket)
      if (admission.allowed) {
        if (signal?.aborted) throw new AppError(499, 'request_cancelled', 'Request cancelled before dispatch')
        if (clock() >= deadline) throw busy('queue_timeout')
        await revalidate()
        if (signal?.aborted) throw new AppError(499, 'request_cancelled', 'Request cancelled before dispatch')
        if (clock() >= deadline) throw busy('queue_timeout')
        log(admission.probe ? 'recovery_probe' : 'included_quota', admission)
        returned = true
        return admission
      }
      if (admission.reason === 'queue_full' || admission.reason === 'queue_timeout') throw busy(admission.reason)
      if (admission.reason !== 'source_busy') {
        log(admission.reason || 'unavailable', admission)
        return admission
      }
      await wait(Math.min(500, deadline - clock()), undefined, { signal })
    }
  } catch (error) {
    log(signal?.aborted ? 'request_cancelled' : error.details?.reason || 'revalidation_failed', admission || {})
    if (signal?.aborted) throw new AppError(499, 'request_cancelled', 'Request cancelled before dispatch',
      { platform: 'facebook', layer: 'hub', stage: 'facebook_quota_admission', upstreamDispatched: false })
    if (!(error instanceof AppError)) throw new AppError(503, 'facebook_quota_state_unavailable',
      'Hub Facebook 全局额度状态暂不可读，请稍后重试。', { platform: 'facebook', layer: 'hub', stage: 'facebook_quota_admission', upstreamDispatched: false })
    error.details = { ...error.details, platform: 'facebook', layer: 'hub', stage: 'facebook_quota_admission', upstreamDispatched: false }
    throw error
  } finally {
    if (!admission?.allowed) {
      try { await policyStore.cancelRapidWait?.(ticket) } catch { /* Deadline also expires an abandoned waiter. */ }
    }
    if (admission?.allowed && !returned) {
      // No dispatch began. Release only this token; keep its conservative
      // reservation count, and never refund an ambiguous provider attempt.
      try { await policyStore.observeRapid(admission) } catch { /* Original lease expires without replenishing quota. */ }
    }
  }
}
