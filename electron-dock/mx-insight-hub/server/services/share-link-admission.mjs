import { setTimeout as delay } from 'node:timers/promises'
import { DataAdmission } from '../core/data-admission.mjs'
import { AppError } from '../core/errors.mjs'

export function assertShareLinkConnected(signal) {
  if (signal?.aborted) throw new AppError(499, 'request_cancelled', 'Share link request was cancelled')
}

function burstWaitMs(error) {
  const ms = error?.details?.retryAfterMs
  return error instanceof AppError && error.status === 429 && error.code === 'plan_burst_exceeded'
    && Number.isInteger(ms) && ms > 0 ? ms : Infinity
}

export class ShareLinkAdmission {
  #groups = new Map()

  constructor({ waitBudgetMs = 160, maxWaitersPerConsumer = 16, now = () => performance.now(),
    sleep = (ms, signal) => delay(ms, undefined, { signal }) } = {}) {
    this.waitBudgetMs = waitBudgetMs
    this.maxWaitersPerConsumer = maxWaitersPerConsumer
    this.now = now
    this.sleep = sleep
  }

  async reserve(consumerId, signal, attempt, revalidate) {
    assertShareLinkConnected(signal)
    let lastError
    let retryAt = 0
    let group = this.#groups.get(consumerId)
    // A database checkout or an authorization read does not predict when a
    // quota slot opens. Let arrivals use normal admission during that I/O.
    if (group?.count >= this.maxWaitersPerConsumer) return attempt()
    if (!group?.sleeping) {
      try { return await attempt() }
      catch (error) {
        const wait = burstWaitMs(error)
        if (wait > this.waitBudgetMs) throw error
        lastError = error
        retryAt = this.now() + wait
      }
    }

    // Start a FIFO only after a definite pre-reservation burst refusal. Its
    // sole slot covers reserve(), never the resolver or a platform request.
    group = this.#groups.get(consumerId)
    if (!group) {
      group = { count: 0, sleeping: false, nextSlotAt: 0, turns: new DataAdmission({ readConcurrency: 1,
        maxPending: this.maxWaitersPerConsumer - 1, maxWaitMs: this.waitBudgetMs }) }
      this.#groups.set(consumerId, group)
    }
    if (group.count >= this.maxWaitersPerConsumer) {
      if (lastError) throw lastError
      return attempt()
    }
    const deadline = this.now() + this.waitBudgetMs
    group.count++
    let release
    try {
      try { release = await group.turns.acquire('read', { signal }) }
      catch (error) {
        if (error.code !== 'hub_data_busy') throw error
      }
      for (let attempts = lastError ? 1 : 0; release; attempts++) {
        assertShareLinkConnected(signal)
        // If the previous commit filled the window, the store already knows
        // when the oldest slot can expire. The next reserve remains authoritative.
        if (group.nextSlotAt <= deadline) retryAt = Math.max(retryAt, group.nextSlotAt)
        const wait = Math.ceil(retryAt - this.now())
        if (wait > 0) {
          group.sleeping = true
          try { await this.sleep(wait, signal) }
          catch (error) { assertShareLinkConnected(signal); throw error }
          finally { group.sleeping = false }
        }
        assertShareLinkConnected(signal)
        if (this.now() > deadline) break
        await revalidate()
        assertShareLinkConnected(signal)
        if (this.now() > deadline) break
        try {
          const reservation = await attempt()
          group.nextSlotAt = reservation?.nextPlanBurstSlotAt ?? 0
          return reservation
        }
        catch (error) {
          const waitMs = burstWaitMs(error)
          retryAt = this.now() + waitMs
          if (attempts >= 2 || retryAt > deadline) throw error
          lastError = error
        }
      }
    } finally {
      release?.()
      if (--group.count === 0) this.#groups.delete(consumerId)
    }
    if (lastError) throw lastError
    // This caller joined a known wait before its first reserve. An expired
    // local timer cannot establish that the database would reject it.
    assertShareLinkConnected(signal)
    await revalidate()
    assertShareLinkConnected(signal)
    return attempt()
  }
}
