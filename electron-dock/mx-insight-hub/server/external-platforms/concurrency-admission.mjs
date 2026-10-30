import { AppError } from '../core/errors.mjs'

export const DEFAULT_CONCURRENCY_QUEUE = Object.freeze({ maxWaitMs: 30000, maxPending: 256, reservedForeground: 4 })

export function concurrencyBusy(reason, details = {}) {
  const business = { enterprise: '企业数据', ecommerce: '电商数据', xiaohongshu: '小红书数据',
    ip_risk: 'IP 风险数据', web_search: '网页搜索' }[details.platform] || '数据'
  const cause = reason === 'concurrency_queue_full' ? '等待队列已满'
    : reason === 'concurrency_queue_timeout' ? '等待并发名额超时' : '并发名额暂不可用'
  return new AppError(429, 'external_platform_busy', `Hub 处理${business}请求时${cause}，尚未调用上游，请稍后重试`, {
    ...details, layer: 'hub', stage: 'concurrency_admission',
    upstreamDispatched: false, reason, retryAfterMs: 1000,
  })
}

// This queue belongs to the same process as the concurrency counter. It holds
// only pending HTTP continuations, never paid jobs or database connections.
// FIFO among eligible callers; a consumer at its own limit cannot block others.
// Priority entries (the LCY Key in priority mode) are offered a slot first.
export class ConcurrencyAdmissionQueue {
  constructor({ clock = Date.now } = {}) { this.clock = clock; this.entries = [] }

  enter({ tryEnter, deadline, maxPending, signal, details = {}, priority = false }) {
    if (signal?.aborted) return Promise.reject(new AppError(499, 'request_cancelled', 'Request cancelled before dispatch'))
    if (!Number.isFinite(deadline) || deadline <= this.clock()) return Promise.reject(concurrencyBusy('concurrency_queue_timeout', details))
    if (this.entries.length >= maxPending) return Promise.reject(concurrencyBusy('concurrency_queue_full', { ...details, queueDepth: this.entries.length }))
    return new Promise((resolve, reject) => {
      const item = { tryEnter, deadline, signal, details, priority, settled: false, finish: (error) => {
        if (item.settled) return
        item.settled = true
        clearTimeout(item.timer)
        signal?.removeEventListener('abort', item.cancel)
        this.entries = this.entries.filter(entry => entry !== item)
        if (error) reject(error)
        else resolve()
      } }
      item.cancel = () => { item.finish(new AppError(499, 'request_cancelled', 'Request cancelled before dispatch')); this.drain() }
      item.timer = setTimeout(() => { item.finish(concurrencyBusy('concurrency_queue_timeout', details)); this.drain() }, deadline - this.clock())
      signal?.addEventListener('abort', item.cancel, { once: true })
      this.entries.push(item)
      this.drain()
    })
  }

  priorityWaiting() {
    return this.entries.reduce((count, item) => count + (item.priority && !item.settled ? 1 : 0), 0)
  }

  drain() {
    const ordered = [...this.entries.filter(item => item.priority), ...this.entries.filter(item => !item.priority)]
    for (const item of ordered) {
      if (item.settled) continue
      if (item.signal?.aborted) item.finish(new AppError(499, 'request_cancelled', 'Request cancelled before dispatch'))
      else if (this.clock() >= item.deadline) item.finish(concurrencyBusy('concurrency_queue_timeout', item.details))
      else {
        try { if (item.tryEnter()) item.finish() }
        catch (error) { item.finish(error) }
      }
    }
  }
}
