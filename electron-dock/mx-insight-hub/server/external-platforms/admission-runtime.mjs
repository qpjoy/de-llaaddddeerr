import { DEFAULT_CONCURRENCY_QUEUE } from './concurrency-admission.mjs'

// Provider RPM is shared by the durable provider bucket. Concurrency belongs
// to each gateway instance; these values must never be operation-specific.
export function deploymentAdmissionLimits(config) {
  return Object.freeze({
    maxConcurrency: config.maxConcurrency,
    maxConsumerConcurrency: config.maxConsumerConcurrency ?? config.maxConcurrency,
    maxRequestsPerMinute: config.maxRequestsPerMinute,
    maxWaitMs: config.concurrencyQueue?.maxWaitMs ?? DEFAULT_CONCURRENCY_QUEUE.maxWaitMs,
    maxPending: config.concurrencyQueue?.maxPending ?? DEFAULT_CONCURRENCY_QUEUE.maxPending,
  })
}

export function currentAdmissionLimits(gateway) {
  return gateway.admissionLimits || deploymentAdmissionLimits(gateway.config)
}

export async function refreshAdmissionLimits(gateway) {
  if (!gateway.admissionPolicies) return currentAdmissionLimits(gateway)
  const next = await gateway.admissionPolicies.resolve(gateway.providerKey || 'tikhub')
  // Concurrent DB reads can finish out of order. Never restore an older policy
  // after this process has observed a newer revision, or mutate shared config.
  if (!gateway.admissionLimits || next.revision > gateway.admissionLimits.revision) {
    gateway.admissionLimits = Object.freeze({ ...next })
    gateway.concurrencyQueue?.drain()
  }
  return gateway.admissionLimits
}

export function admissionQueuePolicy(gateway) {
  const limits = currentAdmissionLimits(gateway)
  return { ...DEFAULT_CONCURRENCY_QUEUE, ...gateway.config.concurrencyQueue,
    maxWaitMs: limits.maxWaitMs, maxPending: limits.maxPending }
}
