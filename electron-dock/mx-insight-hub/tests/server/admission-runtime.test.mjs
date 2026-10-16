import test from 'node:test'
import assert from 'node:assert/strict'
import { refreshAdmissionLimits, currentAdmissionLimits, deploymentAdmissionLimits } from '../../server/external-platforms/admission-runtime.mjs'

const config = Object.freeze({ maxConcurrency: 10, maxConsumerConcurrency: 10, maxRequestsPerMinute: 30 })

test('out-of-order admission reads never restore older limits or mutate deployment defaults', async () => {
  const reads = []
  const gateway = { config, providerKey: 'qixin', admissionPolicies: { resolve(provider) {
    assert.equal(provider, 'qixin')
    const read = Promise.withResolvers(); reads.push(read); return read.promise
  } } }
  const previous = refreshAdmissionLimits(gateway), latest = refreshAdmissionLimits(gateway)
  const limits = { ...deploymentAdmissionLimits(config), maxConcurrency: 12, maxConsumerConcurrency: 8, revision: 2 }
  reads[1].resolve(limits); await latest
  reads[0].resolve({ ...limits, maxConcurrency: 1, maxConsumerConcurrency: 1, revision: 1 }); await previous
  assert.deepEqual(currentAdmissionLimits(gateway), limits)
  assert.equal(Object.isFrozen(gateway.admissionLimits), true)
  assert.equal(gateway.config, config)
  assert.equal(config.maxConcurrency, 10)
})

test('policy read failures fail the new admission instead of silently reusing cached limits', async () => {
  const error = new Error('database unavailable')
  const gateway = { config, admissionLimits: { ...deploymentAdmissionLimits(config), revision: 1 },
    admissionPolicies: { async resolve() { throw error } } }
  await assert.rejects(refreshAdmissionLimits(gateway), candidate => candidate === error)
  assert.equal(gateway.admissionLimits.revision, 1)
})
