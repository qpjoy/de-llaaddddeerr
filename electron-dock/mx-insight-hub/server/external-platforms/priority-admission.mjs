import { setTimeout as sleep } from 'node:timers/promises'
import { AppError } from '../core/errors.mjs'
import { concurrencyBusy } from './concurrency-admission.mjs'
import { admissionQueuePolicy, currentAdmissionLimits } from './admission-runtime.mjs'

// Supplier admission for the LCY Key in priority mode (see
// isLcySupplierPriority). It meets the same gateway concurrency and provider
// RPM as every other Key, but waits for them first instead of being refused or
// reaching the supplier unpaced. Hub quotas, budgets and shared circuits keep
// their exemption; this module only decides when the next supplier call starts.
//
// Gateways keep their own counters (`active`, `activeByConsumer`,
// `concurrencyQueue`); these helpers add `priorityActive` beside them.

// While LCY has work running or waiting in a gateway, other Keys together may
// hold at most the rest. With LCY idle they may use every slot, and a request
// already running is never preempted, so LCY can briefly wait for one to end.
export const LCY_RESERVED_SHARE = 0.8

// After a supplier rate-limit refusal, priority pacing starts at half the
// configured RPM and returns to it linearly over this window. It reads the
// shared provider state, so every process and replica slows down together.
export const RATE_LIMIT_RECOVERY_MS = 60_000

const cancelled = () => new AppError(499, 'request_cancelled', 'Request cancelled before dispatch')

/** Whether another Key must wait so priority work keeps its reserved share. */
export function ordinaryCapacityBlocked(gateway, maxConcurrency) {
  const waiting = gateway.concurrencyQueue?.priorityWaiting?.() || 0
  const running = gateway.priorityActive || 0
  if (!waiting && !running) return false
  if (waiting) return true
  return gateway.active - running >= Math.floor(maxConcurrency * (1 - LCY_RESERVED_SHARE))
}

/** Take a slot for priority work; the per-consumer cap does not apply to it. */
export function enterPriority(gateway, consumerId, maxConcurrency) {
  if (gateway.active >= maxConcurrency) return false
  gateway.active += 1
  gateway.priorityActive = (gateway.priorityActive || 0) + 1
  gateway.activeByConsumer.set(consumerId, (gateway.activeByConsumer.get(consumerId) || 0) + 1)
  return 'priority'
}

/** Call from a gateway's leave before its ordinary decrement. */
export function leavePriority(gateway, admission) {
  if (admission === 'priority') gateway.priorityActive = Math.max(0, (gateway.priorityActive || 0) - 1)
}

/**
 * Wait for a priority slot within the request's own deadline.
 *
 * The caller keeps any dispatch lease it holds: no other request with the same
 * fingerprint can dispatch meanwhile, so nothing needs reclaiming afterwards.
 * Waiting ends at the gateway's configured wait or before the dispatches still
 * to come (`dispatchReserveMs`, one upstream timeout plus 5 s by default) would
 * overrun the request, whichever is first.
 */
export async function waitForPriorityCapacity(gateway, {
  enter, leave, expiresAt, signal, details = {}, revalidate,
  dispatchReserveMs = (gateway.config.timeoutMs || 30000) + 5000,
}) {
  if (signal?.aborted) throw cancelled()
  if (!gateway.concurrencyQueue.priorityWaiting()) {
    const entered = enter()
    if (entered) return entered
  }
  const policy = admissionQueuePolicy(gateway)
  const now = gateway.admissionClock()
  const requestEnd = new Date(expiresAt).getTime() - dispatchReserveMs
  const deadline = Math.min(now + policy.maxWaitMs, Number.isFinite(requestEnd) ? requestEnd : Infinity)
  let entered = false
  try {
    await gateway.concurrencyQueue.enter({ tryEnter: () => (entered = enter()), deadline,
      maxPending: policy.maxPending, signal, details, priority: true })
    if (revalidate) await revalidate()
    if (signal?.aborted) throw cancelled()
    if (gateway.admissionClock() >= deadline) throw concurrencyBusy('concurrency_queue_timeout', details)
    return entered
  } catch (error) {
    if (entered) leave(entered)
    throw error.code === 'external_platform_busy' ? concurrencyBusy(error.details?.reason, {
      ...details, ...error.details, admissionMode: 'priority',
      activeConcurrency: gateway.active, priorityActive: gateway.priorityActive || 0,
      maxConcurrency: currentAdmissionLimits(gateway).maxConcurrency, queueDepth: gateway.concurrencyQueue.entries.length,
      maxPending: policy.maxPending,
    }) : error
  }
}

/** The RPM priority work is paced at, given the shared provider state. */
export function adaptiveRateLimit(limit, providerState, now) {
  if (providerState?.lastErrorCode !== 'upstream_rate_limited') return limit
  const failedAt = Date.parse(providerState.lastFailureAt)
  if (!Number.isFinite(failedAt)) return limit
  const elapsed = Math.max(0, now - failedAt)
  if (elapsed >= RATE_LIMIT_RECOVERY_MS) return limit
  return Math.max(1, Math.floor(limit * (0.5 + 0.5 * elapsed / RATE_LIMIT_RECOVERY_MS)))
}

/**
 * Take provider RPM tokens, waiting for them until `deadline`. `providerState`
 * may be the state or a function returning it.
 *
 * Without a deadline this is a single attempt, for callers that run their own
 * wait loop. The answer is the store's own: allowed, or the last refusal with
 * its retryAfterMs once waiting longer would pass the deadline.
 */
export async function acquirePacedProviderRate(platformStore, {
  limit, tokens = 1, windowMs = 60_000, deadline, signal, providerState,
}, { clock = Date.now, wait = sleep } = {}) {
  // A function is read only here, so ordinary callers never pay for the state.
  const state = typeof providerState === 'function' ? await providerState() : providerState
  const paced = Math.max(Math.min(tokens, limit), adaptiveRateLimit(limit, state, clock()))
  while (true) {
    if (signal?.aborted) throw cancelled()
    const rate = await platformStore.acquireProviderRateLimit({ limit: paced, tokens, windowMs })
    if (rate.allowed || !Number.isFinite(deadline) || !Number.isFinite(rate.retryAfterMs)) {
      return { ...rate, pacedLimit: paced }
    }
    const delay = Math.max(1, rate.retryAfterMs)
    if (clock() + delay >= deadline) return { ...rate, pacedLimit: paced }
    try {
      await wait(delay, undefined, { signal })
    } catch (error) {
      if (signal?.aborted) throw cancelled()
      throw error
    }
  }
}
