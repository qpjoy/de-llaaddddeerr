// Bounded, value-free telemetry for maintenance workers only. Never retain SQL,
// source text, vectors, credentials or exception messages.
const WINDOW_MS = 300_000
const BUCKET_MS = 10_000

export class IndexingMetrics {
  constructor(now = Date.now) {
    this.now = now
    this.startedAt = now()
    this.buckets = new Map()
    this.active = new Set()
    this.lastError = null
  }
  async measure(stage, action) {
    const call = { stage, at: this.now() }
    this.active.add(call)
    let failed = false
    try { return await action() }
    catch (error) {
      failed = true
      // Codes from dependencies are not guaranteed to be safe for disclosure.
      const status = Number(error?.status ?? error?.statusCode ?? error?.cause?.status)
      this.lastError = { stage, at: this.now(), kind: status === 429 ? 'rate_limit' : status >= 500 ? 'unavailable' : 'failed' }
      throw error
    } finally {
      this.active.delete(call)
      const end = this.now(), key = Math.floor(end / BUCKET_MS) * BUCKET_MS
      if (!this.buckets.has(key)) this.buckets.set(key, {})
      const bucket = this.buckets.get(key)
      const row = bucket[stage] ||= { calls: 0, failed: 0, ms: 0, maxMs: 0 }
      const ms = Math.max(0, end - call.at)
      row.calls++; row.failed += Number(failed); row.ms += ms; row.maxMs = Math.max(row.maxMs, ms)
      this.prune(end)
    }
  }
  prune(now) { for (const key of this.buckets.keys()) if (key < now - WINDOW_MS) this.buckets.delete(key) }
  snapshot() {
    const now = this.now(), stages = {}
    this.prune(now)
    for (const bucket of this.buckets.values()) for (const [key, row] of Object.entries(bucket)) {
      const stage = stages[key] ||= { calls: 0, failed: 0, ms: 0, maxMs: 0 }
      stage.calls += row.calls; stage.failed += row.failed; stage.ms += row.ms; stage.maxMs = Math.max(stage.maxMs, row.maxMs)
    }
    return { sampledAt: now, windowSeconds: Math.min(300, (now - this.startedAt) / 1000), stages,
      active: [...this.active].slice(0, 64).map(({ stage, at }) => ({ stage, since: at })),
      lastError: this.lastError?.at >= now - WINDOW_MS ? this.lastError : null }
  }
}

// Bind unobserved methods to the original object (private fields / pg release
// semantics are retained). Only promise-returning methods explicitly listed
// here are wrapped; this is not used on the request/forwarding path.
export function observeMethods(target, metrics, stage, methods) {
  if (!target || !metrics) return target
  const cache = new Map()
  return new Proxy(target, { get(object, key) {
    const value = Reflect.get(object, key, object)
    if (typeof value !== 'function') return value
    if (!cache.has(key)) cache.set(key, methods.includes(key)
      ? (...args) => metrics.measure(stage, () => value.apply(object, args))
      : value.bind(object))
    return cache.get(key)
  } })
}

export function observePool(pool, metrics) {
  const observed = observeMethods(pool, metrics, 'postgres', ['query', 'connect'])
  return new Proxy(observed, { get(object, key) {
    if (key === 'connect') return async (...args) => observeMethods(await observed.connect(...args), metrics, 'postgres', ['query'])
    return Reflect.get(object, key)
  } })
}

// Samples are acknowledged progress, never rows merely scanned or claimed.
// A resumed run starts with a new baseline, so old progress cannot inflate ETA.
export class ProgressRate {
  constructor() { this.samples = []; this.key = null }
  reset() { this.samples = []; this.key = null }
  estimate({ key, processed, remaining, at = Date.now(), blocked = null }) {
    if (blocked) { this.reset(); return { seconds: null, rate: null, reason: blocked } }
    if (this.key !== key || processed < (this.samples.at(-1)?.processed ?? 0)) { this.samples = []; this.key = key }
    if (!this.samples.length || at - this.samples.at(-1).at >= 5000) this.samples.push({ at, processed })
    while (this.samples.length > 2 && this.samples[1].at < at - WINDOW_MS) this.samples.shift()
    if (this.samples.length > 64) this.samples.splice(0, this.samples.length - 64)
    if (remaining === 0) return { seconds: 0, rate: null, reason: 'finishing' }
    const first = this.samples[0], elapsed = (at - first.at) / 1000, delta = processed - first.processed
    if (elapsed < 30 || this.samples.length < 2) return { seconds: null, rate: null, reason: 'warming' }
    const rate = delta > 0 ? delta / elapsed : null
    const lastChange = this.samples.findLast((sample, i) => i > 0 && sample.processed > this.samples[i - 1].processed)
    if (!rate || !lastChange || at - lastChange.at > 90_000) return { seconds: null, rate: null, reason: 'stalled' }
    return { seconds: remaining == null ? null : Math.ceil(remaining / rate), rate,
      reason: remaining == null ? 'unknown_total' : 'estimated', windowSeconds: elapsed }
  }
}

export function mergeWorkerMetrics(workers, now = Date.now()) {
  const stages = {}, active = [], errors = []
  let sampledAt = 0, reportingWorkers = 0
  for (const worker of workers) {
    const metrics = worker.telemetry
    if (!metrics?.sampledAt || now - metrics.sampledAt > 45_000) continue
    reportingWorkers++; sampledAt = Math.max(sampledAt, metrics.sampledAt)
    for (const [key, row] of Object.entries(metrics.stages || {})) {
      const stage = stages[key] ||= { calls: 0, failed: 0, ms: 0, maxMs: 0 }
      stage.calls += row.calls; stage.failed += row.failed; stage.ms += row.ms; stage.maxMs = Math.max(stage.maxMs, row.maxMs)
    }
    active.push(...(metrics.active || []).map((call) => ({ ...call, worker: worker.id.slice(0, 8) })))
    if (metrics.lastError) errors.push(metrics.lastError)
  }
  return { sampledAt: sampledAt || null, stages, active, reportingWorkers,
    lastError: errors.sort((a, b) => b.at - a.at)[0] || null }
}
