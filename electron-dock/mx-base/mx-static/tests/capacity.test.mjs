import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planCapacity, DEFAULT_SLO } from '../src/capacity.mjs'

test('the stated service level turns into permits with burst headroom', () => {
  const plan = planCapacity({ assetQps: 10, assetP95Ms: 200, videoViewers: 30 })
  // 10 QPS x 200 ms = 2 concurrent asset reads; x4 burst = 8, floored at 16.
  assert.equal(plan.limits.maxAssetStreams, 16)
  assert.equal(plan.limits.maxVideoStreams, 60)
  assert.ok(plan.limits.maxReads >= 32)
  assert.equal(plan.feasible, true)
  assert.deepEqual(plan.warnings, [])
})

test('permits scale with the promise, not with a fixed default', () => {
  const small = planCapacity({ assetQps: 10, videoViewers: 30 })
  const large = planCapacity({ assetQps: 400, assetP95Ms: 250, videoViewers: 200, linkMbps: 10000, diskReadMbps: 2000 })
  assert.ok(large.limits.maxAssetStreams > small.limits.maxAssetStreams)
  assert.equal(large.limits.maxVideoStreams, 400)
  assert.equal(large.feasible, true)
})

test('an SLO the hardware cannot carry is reported, not silently accepted', () => {
  // 200 viewers x 8 Mbps = 1.6 Gbps on a 1 Gbps link.
  const plan = planCapacity({ videoViewers: 200, videoBitrateKbps: 8000, linkMbps: 1000 })
  assert.equal(plan.feasible, false)
  assert.match(plan.warnings.join(' '), /link: the SLO needs 1\d{3} Mbps/)
  assert.ok(plan.budget.linkUtilisation > 1)
})

test('a slow disk is caught even when the link is fine', () => {
  const plan = planCapacity({ videoViewers: 60, videoBitrateKbps: 4000, linkMbps: 10000, diskReadMbps: 30 })
  assert.equal(plan.feasible, false)
  assert.match(plan.warnings.join(' '), /^disk:/)
})

test('the bandwidth budget is the SLO restated in bits, so it can be checked', () => {
  const plan = planCapacity({ assetQps: 10, assetSizeKb: 200, videoViewers: 30, videoBitrateKbps: 3000 })
  assert.equal(plan.budget.videoMbps, 90)          // 30 x 3 Mbps
  assert.equal(plan.budget.assetMbps, 16.4)        // 10 x 200 KiB x 8 bits
  assert.equal(plan.budget.totalMbps, 106.4)
  assert.equal(plan.budget.linkUtilisation, 0.106) // of a 1 Gbps link
})

test('nonsense input is refused rather than producing nonsense permits', () => {
  for (const bad of [{ assetQps: 0 }, { videoViewers: -1 }, { linkMbps: NaN }, { burst: 'four' }])
    assert.throws(() => planCapacity(bad), /must be a positive number/)
  assert.equal(planCapacity().feasible, true)
  assert.deepEqual(planCapacity().slo, DEFAULT_SLO)
})
