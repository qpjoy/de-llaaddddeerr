import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DELIVERY_REASON_CODES,
  KNOWN_DELIVERY_REASON_CODES,
  describeDeliveryReason,
} from '../../server/external-platforms/delivery-reason.mjs'

test('healthy deliveries carry a reason too, so silence never has to be interpreted', () => {
  assert.deepEqual(describeDeliveryReason({ sourceMode: 'live' }), {
    code: 'live',
    scope: 'upstream',
    summary: 'Served from a fresh upstream call.',
    degraded: false,
    liveAttempted: true,
  })
  assert.equal(describeDeliveryReason({ sourceMode: 'fresh_cache' }).code, 'fresh_cache_hit')
  assert.equal(describeDeliveryReason({ sourceMode: 'fresh_cache' }).degraded, false)
  assert.equal(describeDeliveryReason({ sourceMode: 'idempotent_replay' }).code, 'idempotent_replay')
})

test('a control-plane fallback names the subsystem that refused dispatch and carries its blockers', () => {
  const reason = describeDeliveryReason({
    sourceMode: 'stored_fallback',
    fallbackReason: 'external_platform_operation_blocked',
    detail: { blockers: [{ code: 'price_control_incomplete', endpointKeys: ['jd.product-search.v1'] }] },
  })

  assert.equal(reason.code, 'external_platform_operation_blocked')
  assert.equal(reason.scope, 'operation_control')
  assert.equal(reason.degraded, true)
  // No upstream call was made, so no money was spent on this delivery.
  assert.equal(reason.liveAttempted, false)
  assert.deepEqual(reason.detail.blockers, [
    { code: 'price_control_incomplete', endpointKeys: ['jd.product-search.v1'] },
  ])
})

test('an upstream failure is the one degraded family that already attempted a paid call', () => {
  const reason = describeDeliveryReason({
    sourceMode: 'stored_fallback',
    fallbackReason: 'upstream_daily_quota_exceeded',
  })

  assert.equal(reason.code, 'upstream_daily_quota_exceeded')
  assert.equal(reason.scope, 'upstream')
  assert.equal(reason.liveAttempted, true)
  assert.equal(reason.degraded, true)
})

test('a caller-chosen cache delivery is attributed to the delivery policy, not to a failure', () => {
  const reason = describeDeliveryReason({
    sourceMode: 'stored_fallback',
    fallbackReason: 'cache_only',
  })

  assert.equal(reason.scope, 'delivery_policy')
  assert.equal(reason.liveAttempted, false)
})

test('an unclassified source mode stays silent rather than inventing an explanation', () => {
  assert.equal(describeDeliveryReason({ sourceMode: 'duplicate_suppressed' }), null)
  assert.equal(describeDeliveryReason({}), null)
})

test('empty detail is dropped so the field is present only when it carries evidence', () => {
  const reason = describeDeliveryReason({
    sourceMode: 'stored_fallback',
    fallbackReason: 'external_platform_operation_blocked',
    detail: { blockers: null },
  })
  assert.equal(Object.hasOwn(reason, 'detail'), false)
})

test('every operation-control rejection code has a matching reason entry', () => {
  for (const state of ['disabled', 'shadow', 'paused', 'canary', 'blocked']) {
    const code = `external_platform_operation_${state}`
    assert.ok(
      KNOWN_DELIVERY_REASON_CODES.has(code),
      `${code} must be explainable in both the fallback and the rejection path`,
    )
  }
  assert.ok(DELIVERY_REASON_CODES.includes('live'))
})
