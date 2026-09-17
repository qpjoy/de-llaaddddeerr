import assert from 'node:assert/strict'
import test from 'node:test'
import { canCompareAcquisition, createAcquisitionComparison, comparisonOutcome } from '../../src/acquisition-comparison.js'

const body = { platform: 'xiaohongshu', keyword: '澳大利亚旅游 穷游攻略', page: 1, count: 20 }
const run = {
  requestId: 'original-request', owner: { apiKeyId: 'original-key' }, scope: { platform: 'xiaohongshu' },
  requestEvidence: { idempotencyKey: 'original-idempotency' },
  costLineage: { providerCalls: [{ providerKey: 'tikhub', operation: 'social.posts.search', requestCall: true }] },
}

test('historical input is marked manual; comparison binds original identity and a new idempotency key', () => {
  const input = structuredClone(run)
  const result = createAcquisitionComparison(input, JSON.stringify(body), 'compare-new-1')
  assert.deepEqual(result.body, body)
  assert.equal(result.parameterSource, 'manual')
  assert.equal(result.keyId, run.owner.apiKeyId)
  assert.equal(result.originalRequestId, run.requestId)
  assert.equal(result.path, '/api/v1/night-all/search/raw')
  assert.deepEqual(input, run)
  assert.throws(() => createAcquisitionComparison(run, JSON.stringify(body), 'original-idempotency'))
})

test('saved exact inputs distinguish edits and unsupported operations cannot masquerade as a raw retry', () => {
  const saved = { ...run, requestEvidence: { ...run.requestEvidence, request: { method: 'POST', path: '/api/v1/night-all/search/raw', body } } }
  assert.equal(createAcquisitionComparison(saved, JSON.stringify(body), 'compare-new-2').parameterSource, 'saved')
  assert.equal(createAcquisitionComparison(saved, JSON.stringify({ ...body, keyword: '不同关键词' }), 'compare-new-3').parameterSource, 'manual')
  assert.equal(canCompareAcquisition({ ...run, owner: {} }), false)
  assert.equal(canCompareAcquisition({ ...run, scope: { platform: 'other' } }), false)
  assert.equal(canCompareAcquisition({ ...run, costLineage: { providerCalls: [] } }), false)
  for (const text of ['bad json', '[]', JSON.stringify({ ...body, count: 30 }), JSON.stringify({ ...body, page: 2 }), JSON.stringify({ ...body, authorization: 'must-not-send' }), JSON.stringify({ ...body, params: {} })]) {
    assert.throws(() => createAcquisitionComparison(run, text, 'compare-new-4'))
  }
})


test('in-progress, unknown and missing response bodies retain the same retry identity', () => {
  for (const code of ['request_in_progress', 'request_outcome_unknown', 'external_platform_outcome_unknown', 'internal_error']) {
    assert.equal(comparisonOutcome({ body: { error: { code } } }), 'uncertain')
  }
  assert.equal(comparisonOutcome({ status: 502, body: null }), 'uncertain')
  assert.equal(comparisonOutcome({ status: 502, body: { error: { code: 'external_platform_rejected' } } }), 'received')
  assert.equal(comparisonOutcome({ status: 200, body: { data: [] } }), 'received')
})


test('stored request parameters cannot be overwritten by a later replay', async () => {
  const { MemoryStore } = await import('../../server/stores/memory-store.mjs')
  const store = new MemoryStore()
  store.requests.set('request', { id: 'request', status: 'reserved' })
  const original = { method: 'POST', path: '/api/v1/night-all/search/raw', body: { ...body } }
  await store.saveAcquisitionRequest('request', original)
  original.body.keyword = 'changed after saving'
  await store.saveAcquisitionRequest('request', original)
  assert.equal(store.requests.get('request').acquisitionRequest.body.keyword, body.keyword)
  store.requests.get('request').status = 'committed'
  await store.saveAcquisitionRequest('request', original)
  assert.equal(store.requests.get('request').acquisitionRequest.body.keyword, body.keyword)
})
