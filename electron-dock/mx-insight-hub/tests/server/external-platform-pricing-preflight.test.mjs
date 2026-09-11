import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspectExternalPlatformPricing } from '../../scripts/check-external-platform-pricing.mjs'
import { EXTERNAL_PLATFORM_OPERATION_CATALOG } from '../../server/external-platforms/control-store.mjs'

// These cases are about what the environment alone declares, so they opt out of
// the repository's seed files -- otherwise the seed would mask the very gap
// each case is checking for. A separate case below covers seed coverage.
const NO_SEED_FILES = { seedPrices: () => ({}) }
const envOnlyPricing = (environment) => inspectExternalPlatformPricing(environment, NO_SEED_FILES)

const ALL_JUSTONE_ENDPOINTS = [
  'taobao-tmall.product-search.v1',
  'jd.product-search.v1',
  'xiaohongshu-ec.product-search.v1',
  'xianyu.product-search.v1',
]

// Most cases below are about one operation's pricebook rules, so they read the
// product-search row rather than asserting on the whole provider.
function searchFindings(environment) {
  return envOnlyPricing(environment)
    .filter((finding) => finding.operationKey === 'ecommerce.products.search')
}

function justoneBilling(unitCostMinorByEndpoint) {
  return JSON.stringify({
    source: 'manual',
    currency: 'CNY',
    pricingAsOf: '2026-09-03T00:00:00Z',
    monthlyBudgetMinor: 0,
    monthlySubsidyBudgetMinor: 0,
    unitCostMinorByEndpoint,
  })
}

test('a closed contract gate is not reported: the operation is disabled, not mispriced', () => {
  assert.deepEqual(envOnlyPricing({ MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED: '0' }), [])
  assert.deepEqual(envOnlyPricing({}), [])
})

test('an open gate with no pricebook reports every endpoint of the released operation', () => {
  const findings = envOnlyPricing({
    MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED: '1',
  })

  // Every JustOne operation behind the open gate is reported, not just the
  // first, so adding a resource operation cannot quietly escape the preflight.
  assert.ok(findings.length > 0)
  for (const finding of findings) {
    assert.equal(finding.providerKey, 'justone')
    assert.equal(finding.kind, 'billing_absent')
    assert.ok(finding.missingEndpointKeys.length > 0)
  }
  const search = findings.find((finding) => finding.operationKey === 'ecommerce.products.search')
  assert.deepEqual(search.missingEndpointKeys, ALL_JUSTONE_ENDPOINTS)
})

test('the preflight covers every released operation the control plane knows about', () => {
  const reported = envOnlyPricing({ MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED: '1' })
    .map((finding) => finding.operationKey)

  assert.deepEqual(
    [...reported].sort(),
    EXTERNAL_PLATFORM_OPERATION_CATALOG.justone.map((entry) => entry.operationKey).sort(),
  )
})

test('pricing one marketplace does not release the operation: the rest stay unpriced', () => {
  const [finding] = searchFindings({
    MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED: '1',
    MX_INSIGHT_JUSTONE_BILLING_JSON: justoneBilling({ 'jd.product-search.v1': 5 }),
  })

  assert.equal(finding.kind, 'price_control_incomplete')
  assert.deepEqual(finding.missingEndpointKeys, ALL_JUSTONE_ENDPOINTS.filter((key) => key !== 'jd.product-search.v1'))
})

test('a complete pricebook clears every operation', () => {
  const everyEndpointKey = EXTERNAL_PLATFORM_OPERATION_CATALOG.justone
    .flatMap((entry) => entry.endpointKeys)
  const findings = envOnlyPricing({
    MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED: '1',
    MX_INSIGHT_JUSTONE_BILLING_JSON: justoneBilling(
      Object.fromEntries(everyEndpointKey.map((key) => [key, 5])),
    ),
  })

  assert.deepEqual(findings, [])
})

test('pricing product search alone does not release the resource operations', () => {
  const findings = envOnlyPricing({
    MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED: '1',
    MX_INSIGHT_JUSTONE_BILLING_JSON: justoneBilling(
      Object.fromEntries(ALL_JUSTONE_ENDPOINTS.map((key) => [key, 5])),
    ),
  })

  assert.ok(findings.length > 0)
  assert.equal(findings.some((finding) => finding.operationKey === 'ecommerce.products.search'), false)
  for (const finding of findings) {
    assert.equal(finding.kind, 'price_control_incomplete')
  }
})

test('a zero or negative unit price is not a price', () => {
  const [finding] = searchFindings({
    MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED: '1',
    MX_INSIGHT_JUSTONE_BILLING_JSON: justoneBilling(
      Object.fromEntries(ALL_JUSTONE_ENDPOINTS.map((key, index) => [key, index === 0 ? 0 : 5])),
    ),
  })

  assert.equal(finding.kind, 'price_control_incomplete')
  assert.deepEqual(finding.missingEndpointKeys, [ALL_JUSTONE_ENDPOINTS[0]])
})

test('reviewed budget and currency evidence is required alongside the endpoint prices', () => {
  const [finding] = searchFindings({
    MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED: '1',
    MX_INSIGHT_JUSTONE_BILLING_JSON: JSON.stringify({
      source: 'manual',
      unitCostMinorByEndpoint: Object.fromEntries(ALL_JUSTONE_ENDPOINTS.map((key) => [key, 5])),
    }),
  })

  assert.equal(finding.kind, 'price_control_incomplete')
  assert.deepEqual(finding.missingEndpointKeys, [])
  assert.deepEqual(finding.missingEvidence, [
    'currency', 'pricingAsOf', 'monthlyBudgetMinor', 'monthlySubsidyBudgetMinor',
  ])
})

test('malformed billing JSON is reported rather than silently treated as absent', () => {
  const [finding] = searchFindings({
    MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED: '1',
    MX_INSIGHT_JUSTONE_BILLING_JSON: '{not json',
  })

  assert.equal(finding.kind, 'invalid_billing_json')
})

test("TikHub's flat unit cost covers its endpoints; JustOne has no such fallback", () => {
  const tikhubFindings = envOnlyPricing({
    MX_INSIGHT_TIKHUB_CONTRACT_VERIFIED: '1',
    MX_INSIGHT_TIKHUB_BILLING_JSON: JSON.stringify({
      source: 'manual',
      currency: 'USD',
      pricingAsOf: '2026-09-07T00:00:00Z',
      unitCostMinor: 1,
      monthlyBudgetMinor: 0,
      monthlySubsidyBudgetMinor: 0,
    }),
  })
  assert.deepEqual(tikhubFindings, [])

  const [justoneFinding] = searchFindings({
    MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED: '1',
    MX_INSIGHT_JUSTONE_BILLING_JSON: JSON.stringify({
      source: 'manual',
      currency: 'CNY',
      pricingAsOf: '2026-09-03T00:00:00Z',
      monthlyBudgetMinor: 0,
      monthlySubsidyBudgetMinor: 0,
      unitCostMinor: 5,
    }),
  })
  assert.deepEqual(justoneFinding.missingEndpointKeys, ALL_JUSTONE_ENDPOINTS)
})

test('each TikHub operation is judged against its own gate', () => {
  const findings = envOnlyPricing({
    MX_INSIGHT_TIKHUB_SEARCH_CONTRACT_VERIFIED: '1',
  })

  assert.ok(findings.length > 0)
  for (const finding of findings) {
    assert.equal(finding.providerKey, 'tikhub')
    assert.equal(finding.operationKey, 'social.posts.search')
  }
})

test('an endpoint the seed file prices is not reported, because seeding runs later in the same deploy', () => {
  const environment = { MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED: '1' }

  // Without seed coverage this is a genuine gap.
  assert.ok(envOnlyPricing(environment).length > 0)

  // With it, warning here would be a false alarm: the deploy seeds these
  // prices minutes later, before anyone can call the operation.
  const seeded = inspectExternalPlatformPricing(environment, {
    seedPrices: () => Object.fromEntries(
      EXTERNAL_PLATFORM_OPERATION_CATALOG.justone
        .flatMap((entry) => entry.endpointKeys)
        .map((endpointKey) => [endpointKey, 107]),
    ),
  })
  assert.deepEqual(seeded, [])
})

test('a partial seed still reports the endpoints it leaves uncovered', () => {
  const [finding] = inspectExternalPlatformPricing(
    { MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED: '1' },
    { seedPrices: () => ({ 'jd.product-search.v1': 107 }) },
  )

  assert.equal(finding.operationKey, 'ecommerce.products.search')
  assert.deepEqual(
    finding.missingEndpointKeys,
    ALL_JUSTONE_ENDPOINTS.filter((key) => key !== 'jd.product-search.v1'),
  )
})

test('the shipped seed files price every released endpoint of both providers', () => {
  // The real files, no injection: a deploy of this repository must not warn.
  assert.deepEqual(
    inspectExternalPlatformPricing({
      MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED: '1',
      MX_INSIGHT_TIKHUB_CONTRACT_VERIFIED: '1',
      MX_INSIGHT_TIKHUB_SEARCH_CONTRACT_VERIFIED: '1',
      MX_INSIGHT_TIKHUB_USER_ACTIVITY_CONTRACT_VERIFIED: '1',
    }),
    [],
  )
})
