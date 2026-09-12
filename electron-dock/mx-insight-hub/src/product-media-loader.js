// One product page renders up to nine images. Keep one page fully parallel and
// leave headroom for a selected item/history preview without an avoidable 429.
const DEFAULT_CONCURRENCY = 12
const BUSY_BACKOFF_MS = Object.freeze([250, 1_000])
const PENDING_BACKOFF_MS = Object.freeze([500, 1000, 2000, 4000, 8000, 8000, 8000, 8000])

function abortError() {
  if (typeof DOMException === 'function') return new DOMException('The operation was aborted', 'AbortError')
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

function wait(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds)
    function done() {
      signal?.removeEventListener('abort', aborted)
      resolve()
    }
    function aborted() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      reject(abortError())
    }
    signal?.addEventListener('abort', aborted, { once: true })
  })
}

function retryableBusy(error) {
  return error?.status === 429 && error?.code === 'external_media_busy'
}

export function createProductMediaLoader({
  maxConcurrency = DEFAULT_CONCURRENCY,
  backoffMs = BUSY_BACKOFF_MS,
  pendingBackoffMs = PENDING_BACKOFF_MS,
} = {}) {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 32) {
    throw new TypeError('maxConcurrency must be an integer between 1 and 32')
  }
  const queue = []
  let active = 0

  const pump = () => {
    while (active < maxConcurrency && queue.length > 0) {
      const entry = queue.shift()
      entry.signal?.removeEventListener('abort', entry.cancelQueued)
      if (entry.signal?.aborted) {
        entry.reject(abortError())
        continue
      }
      active += 1
      ;(async () => {
        for (let attempt = 0; ; attempt += 1) {
          if (entry.signal?.aborted) throw abortError()
          try {
            return await entry.operation(entry.signal)
          } catch (error) {
            const pending = error?.status === 503 && error?.code === 'external_media_pending'
            const delays = pending ? pendingBackoffMs : backoffMs
            if ((!pending && !retryableBusy(error)) || attempt >= delays.length) throw error
            await wait(delays[attempt], entry.signal)
          }
        }
      })().then(
        (value) => {
          active = Math.max(0, active - 1)
          pump()
          entry.resolve(value)
        },
        (error) => {
          active = Math.max(0, active - 1)
          pump()
          entry.reject(error)
        },
      )
    }
  }

  return Object.freeze({
    load(operation, { signal } = {}) {
      if (typeof operation !== 'function') return Promise.reject(new TypeError('operation must be a function'))
      if (signal?.aborted) return Promise.reject(abortError())
      return new Promise((resolve, reject) => {
        const entry = { operation, signal, resolve, reject, cancelQueued: null }
        entry.cancelQueued = () => {
          const index = queue.indexOf(entry)
          if (index < 0) return
          queue.splice(index, 1)
          reject(abortError())
        }
        signal?.addEventListener('abort', entry.cancelQueued, { once: true })
        queue.push(entry)
        pump()
      })
    },
    stats() {
      return Object.freeze({ active, queued: queue.length, maxConcurrency })
    },
  })
}

export const productMediaLoader = createProductMediaLoader()
