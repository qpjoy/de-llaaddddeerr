import { AppError } from './errors.mjs'

export const DATA_ADMISSION_DEFAULTS = Object.freeze({
  readConcurrency: 4, acquisitionConcurrency: 0, maxPending: 512, maxWaitMs: 30000,
})

export function dataAdmissionConfig(environment = {}) {
  const settings = {}
  for (const [key, name, maximum] of [
    ['readConcurrency', 'READ_CONCURRENCY', 32],
    ['acquisitionConcurrency', 'ACQUISITION_CONCURRENCY', 32],
    ['maxPending', 'MAX_PENDING', 4096],
    ['maxWaitMs', 'WAIT_MS', 30000],
  ]) {
    const variable = `MX_INSIGHT_DATA_API_${name}`
    const raw = environment[variable]
    const value = raw == null || raw === '' ? DATA_ADMISSION_DEFAULTS[key] : Number(raw)
    const minimum = key === 'acquisitionConcurrency' ? 0 : 1
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new AppError(500, 'invalid_configuration', `${variable} must be between ${minimum} and ${maximum}`)
    }
    settings[key] = value
  }
  return settings
}

// Recovery, login, payments and health never compete for data API slots.
// These lanes are execution budgets, not an authorization or billing decision.
export function dataAdmissionLane(method, pathname) {
  if (!['GET', 'POST'].includes(method)) return null
  // routeMatch accepts repeated/trailing separators. Classification must cover
  // every spelling that can reach the same expensive handler.
  pathname = pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '')
  if (method === 'GET' && [
    '/internal/v1/admin/data-browser', '/internal/v1/admin/data-browser/export',
    '/internal/v1/admin/data-browser/statistics', '/internal/v1/admin/data-center',
    '/internal/v1/admin/data-center/records',
  ].includes(pathname)) return 'read'
  if (method === 'POST' && [
    '/internal/v1/admin/data-browser/advanced/search', '/internal/v1/admin/data-browser/advanced/answer',
    '/internal/v1/admin/retrieval/search',
  ].includes(pathname)) return 'read'
  if (pathname === '/api/v1/tools/tokenize') return 'read'
  if (pathname === '/api/v2/data/search') return 'acquisition'
  if (/^\/api\/v1\/(?:search|night-all|xiaohongshu|tikhub|justone)\//.test(pathname)) return 'acquisition'
  if (!pathname.startsWith('/api/v1/data/')) return null
  // Media already has independent byte/concurrency budgets; do not occupy a
  // database execution slot for the duration of streaming an image.
  if (['/api/v1/data/posts/media', '/api/v1/data/ecommerce/products/media'].includes(pathname)) return null
  if (pathname === '/api/v1/data/post') return 'acquisition'
  if (method === 'GET' || /^\/api\/v1\/data\/(?:canonical|stored|news|public-opinion)\//.test(pathname)
    || pathname === '/api/v1/data/aggregate/preview') return 'read'
  return 'acquisition'
}

function busy(reason) {
  return new AppError(503, 'hub_data_busy', 'Hub 数据处理繁忙，请保留原参数和 Idempotency-Key，核对原请求状态后重试。', {
    layer: 'hub', stage: 'data_api_admission', reason, retryAfterMs: 1000,
    // This HTTP attempt never reached authentication/reservation. It says
    // nothing about an earlier attempt carrying the same idempotency key.
    currentAttemptStarted: false,
  })
}

// Pending requests retain only an HTTP continuation. Their bodies are not read
// or parsed here and no PG client, wallet hold or upstream slot is acquired.
// Accepted business data still uses the existing transactional durable queue.
export class DataAdmission {
  constructor(options = {}) {
    this.options = { ...DATA_ADMISSION_DEFAULTS, ...options }
    this.lanes = Object.fromEntries(['read', 'acquisition'].map(name => [name, {
      limit: this.options[`${name}Concurrency`], active: 0, pending: [],
      admitted: 0, completed: 0, rejected: 0, timedOut: 0, cancelled: 0, highWater: 0,
    }]))
  }

  acquire(name, { signal } = {}) {
    const lane = this.lanes[name]
    if (!lane) throw new TypeError('Unknown data admission lane')
    if (signal?.aborted) { lane.cancelled++; return Promise.reject(new AppError(499, 'request_cancelled', 'Request cancelled')) }
    // Upstream I/O must not occupy a second Hub-wide gate ahead of replay and
    // cache delivery. Zero disables this optional acquisition cap; the provider
    // queues and bounded PG pools still own their actual resource budgets.
    if (lane.limit === 0 || !lane.pending.length && lane.active < lane.limit) return Promise.resolve(this.activate(lane))
    if (lane.pending.length >= this.options.maxPending) { lane.rejected++; return Promise.reject(busy('queue_full')) }
    return new Promise((resolve, reject) => {
      const entry = { startedAt: Date.now(), signal, resolve, reject }
      const fail = (error, counter) => {
        const index = lane.pending.indexOf(entry)
        if (index < 0) return
        lane.pending.splice(index, 1)
        this.cleanup(entry)
        lane[counter]++
        reject(error)
      }
      entry.cancel = () => fail(new AppError(499, 'request_cancelled', 'Request cancelled'), 'cancelled')
      entry.timer = setTimeout(() => fail(busy('queue_timeout'), 'timedOut'), this.options.maxWaitMs)
      signal?.addEventListener('abort', entry.cancel, { once: true })
      lane.pending.push(entry)
      lane.highWater = Math.max(lane.highWater, lane.pending.length)
    })
  }

  cleanup(entry) {
    clearTimeout(entry.timer)
    entry.signal?.removeEventListener('abort', entry.cancel)
  }

  activate(lane) {
    lane.active++
    lane.admitted++
    let released = false
    return () => {
      if (released) return
      released = true
      lane.active--
      lane.completed++
      while (lane.active < lane.limit && lane.pending.length) {
        const entry = lane.pending.shift()
        this.cleanup(entry)
        if (entry.signal?.aborted) {
          lane.cancelled++
          entry.reject(new AppError(499, 'request_cancelled', 'Request cancelled'))
        } else if (Date.now() - entry.startedAt >= this.options.maxWaitMs) {
          lane.timedOut++
          entry.reject(busy('queue_timeout'))
        } else entry.resolve(this.activate(lane))
      }
    }
  }

  snapshot() {
    return { scope: 'process', durable: false, maxPendingPerLane: this.options.maxPending,
      maxWaitMs: this.options.maxWaitMs,
      lanes: Object.fromEntries(Object.entries(this.lanes).map(([name, lane]) => [name, {
        concurrency: lane.limit, active: lane.active, pending: lane.pending.length,
        oldestWaitMs: lane.pending.length ? Date.now() - lane.pending[0].startedAt : 0,
        admitted: lane.admitted, completed: lane.completed, rejected: lane.rejected,
        timedOut: lane.timedOut, cancelled: lane.cancelled, highWater: lane.highWater,
      }])) }
  }
}
