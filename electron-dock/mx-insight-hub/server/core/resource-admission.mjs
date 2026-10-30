import { AppError } from './errors.mjs'

// Execution protection is independent of financial/legacy supplier exemptions.
// Per API process, not a promise of cluster QPS or supplier throughput.
export const RESOURCE_DEFAULTS = Object.freeze({ maxConcurrency: 256, maxKeyConcurrency: 32,
  requestsPerSecond: 1000, keyRequestsPerSecond: 100 })
export const RESOURCE_BOUNDS = Object.freeze({ maxConcurrency: 4096, maxKeyConcurrency: 4096,
  requestsPerSecond: 100000, keyRequestsPerSecond: 100000 })
const fail = (scope, reason, retryAfterMs = 1000) => new AppError(429, 'resource_admission_limited',
  'Hub 数据产品资源限速，请保留原参数和 Idempotency-Key 后重试。', {
    layer: 'hub', stage: 'resource_admission', scope, reason, retryAfterMs,
    currentAttemptStarted: false, executionScope: 'api_process',
  })

export class ResourceAdmission {
  constructor({ policy, classify, clock = performance.now.bind(performance), maxKeys = 10000 } = {}) {
    this.policy = policy; this.classify = classify; this.clock = clock; this.maxKeys = maxKeys
    this.buckets = new Map(); this.nextSweep = 0
    this.counts = { admitted: 0, rejected: 0, completed: 0, active: 0 }
  }
  acquire({ method, pathname, keyId }) {
    const target = this.classify(method, pathname)
    if (!target) return () => {}
    const now = this.clock()
    if (now >= this.nextSweep) {
      for (const [id, value] of this.buckets) if (!value.active && now - value.at >= 1000) this.buckets.delete(id)
      this.nextSweep = now + 5000
    }
    const view = this.policy.current()
    const scopes = [{ id: 'default', limits: view.defaults }, ...view.rules.filter(rule =>
      (rule.keyId === '*' || rule.keyId === keyId) &&
      (rule.kind === 'product' ? rule.target === target.product : rule.target === target.api))]
    const candidates = scopes.flatMap(scope => [
      { id: `${scope.id}:shared`, scope: scope.id, concurrency: scope.limits.maxConcurrency, rate: scope.limits.requestsPerSecond },
      { id: `${scope.id}:key:${keyId}`, scope: scope.id, concurrency: scope.limits.maxKeyConcurrency, rate: scope.limits.keyRequestsPerSecond },
    ])
    // All checks are synchronous and atomic within this process. A rejected
    // request consumes no token or concurrency in any other matching scope.
    try {
      for (const row of candidates) {
        row.bucket = this.buckets.get(row.id) || { active: 0, tokens: row.rate, at: now }
        const bucket = row.bucket
        row.tokens = Math.min(row.rate, bucket.tokens + Math.max(0, now - bucket.at) * row.rate / 1000)
        if (bucket.active >= row.concurrency) throw fail(row.scope, 'concurrency')
        if (row.tokens < 1) throw fail(row.scope, 'rate', Math.ceil((1 - row.tokens) * 1000 / row.rate))
      }
      const newBuckets = candidates.filter(row => !this.buckets.has(row.id)).length
      if (this.buckets.size + newBuckets > this.maxKeys) throw fail('default', 'counter_capacity')
    } catch (error) { this.counts.rejected++; this.lastRejected = { scope: error.details?.scope, reason: error.details?.reason, observedAt: new Date().toISOString() }; throw error }
    for (const row of candidates) {
      row.bucket.active++; row.bucket.tokens = row.tokens - 1; row.bucket.at = now
      this.buckets.set(row.id, row.bucket)
    }
    this.counts.admitted++; this.counts.active++
    let released = false
    return () => {
      if (released) return
      released = true
      for (const row of candidates) row.bucket.active--
      this.counts.active--; this.counts.completed++
    }
  }
  snapshot() { return { scope: 'api_process', algorithm: 'token_bucket', queue: false,
    ...this.counts, lastRejected: this.lastRejected || null, counters: this.buckets.size, policy: this.policy.status() } }
}
