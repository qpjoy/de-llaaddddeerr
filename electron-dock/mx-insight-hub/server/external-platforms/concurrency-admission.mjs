import { AppError } from '../core/errors.mjs'

export const DEFAULT_CONCURRENCY_QUEUE = Object.freeze({ maxWaitMs: 10000, maxPending: 32, reservedForeground: 4 })

export function concurrencyBusy(reason, details = {}) {
  return new AppError(429, 'external_platform_busy', '请求排队容量已满或等待超时，请稍后再试', {
    upstreamDispatched: false, reason, retryAfterMs: 1000, ...details,
  })
}

// This queue belongs to the same process as the concurrency counter. It holds
// only pending HTTP continuations, never paid jobs or database connections.
// FIFO among eligible callers; a consumer at its own limit cannot block others.
export class ConcurrencyAdmissionQueue {
  constructor({ clock = Date.now } = {}) { this.clock = clock; this.entries = [] }

  enter({ tryEnter, deadline, maxPending, signal }) {
    if (signal?.aborted) return Promise.reject(new AppError(499, 'request_cancelled', 'Request cancelled before dispatch'))
    if (!Number.isFinite(deadline) || deadline <= this.clock()) return Promise.reject(concurrencyBusy('concurrency_queue_timeout'))
    if (this.entries.length >= maxPending) return Promise.reject(concurrencyBusy('concurrency_queue_full', { queueDepth: this.entries.length }))
    return new Promise((resolve, reject) => {
      const item = { tryEnter, deadline, signal, finish: (error) => {
        clearTimeout(item.timer)
        signal?.removeEventListener('abort', item.cancel)
        this.entries = this.entries.filter(entry => entry !== item)
        if (error) reject(error)
        else resolve()
      } }
      item.cancel = () => { item.finish(new AppError(499, 'request_cancelled', 'Request cancelled before dispatch')); this.drain() }
      item.timer = setTimeout(() => { item.finish(concurrencyBusy('concurrency_queue_timeout')); this.drain() }, deadline - this.clock())
      signal?.addEventListener('abort', item.cancel, { once: true })
      this.entries.push(item)
      this.drain()
    })
  }

  drain() {
    for (const item of [...this.entries]) {
      if (item.signal?.aborted) item.finish(new AppError(499, 'request_cancelled', 'Request cancelled before dispatch'))
      else if (this.clock() >= item.deadline) item.finish(concurrencyBusy('concurrency_queue_timeout'))
      else if (item.tryEnter()) item.finish()
    }
  }
}
