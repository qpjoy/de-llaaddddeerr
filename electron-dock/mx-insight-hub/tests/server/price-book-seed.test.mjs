import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { priceBookForOperation } from '../../scripts/provision-price-books.mjs'
import {
  EXTERNAL_PLATFORM_OPERATION_CATALOG,
  MemoryExternalPlatformControlStore,
} from '../../server/external-platforms/control-store.mjs'

const FILE_PATH = new URL('../../seeds/pricebooks/justone.json', import.meta.url)

async function priceBookFile() {
  return JSON.parse(await readFile(FILE_PATH, 'utf8'))
}

function runtime() {
  return {
    config: {
      contractVerified: true,
      billing: { source: 'unknown', currency: null, pricingAsOf: null, unitCostMinorByEndpoint: {} },
    },
    credentialConfigured: true,
  }
}

test('the checked-in price book covers every released endpoint key', async () => {
  const file = await priceBookFile()
  for (const definition of EXTERNAL_PLATFORM_OPERATION_CATALOG.justone) {
    const narrowed = priceBookForOperation(file, definition.endpointKeys)
    assert.ok(
      narrowed.ok,
      `seeds/pricebooks/justone.json is missing a price for ${narrowed.missing?.join(', ')}`,
    )
    assert.deepEqual(
      Object.keys(narrowed.priceBook.unitCostMinorByEndpoint).sort(),
      [...definition.endpointKeys].sort(),
      'each operation receives exactly its own endpoint keys',
    )
  }
})

test('a missing price is reported rather than seeded as zero', async () => {
  const file = await priceBookFile()
  const narrowed = priceBookForOperation(
    { ...file, unitCostMinorByEndpoint: { ...file.unitCostMinorByEndpoint, 'jd.product-search.v1': 0 } },
    ['jd.product-search.v1', 'taobao-tmall.product-search.v1'],
  )
  assert.equal(narrowed.ok, false)
  assert.deepEqual(narrowed.missing, ['jd.product-search.v1'])
})

test('seeding the repository price book clears price_control_incomplete', async () => {
  const file = await priceBookFile()
  const store = new MemoryExternalPlatformControlStore()
  const definition = EXTERNAL_PLATFORM_OPERATION_CATALOG.justone[0]

  const [before] = await store.describeProvider('justone', runtime())
  assert.equal(before.effectiveState, 'blocked')
  assert.ok(before.blockers.some((blocker) => blocker.code === 'price_control_incomplete'))
  assert.equal(before.priceBook.source, 'legacy_environment')

  const narrowed = priceBookForOperation(file, definition.endpointKeys)
  const seeded = await store.updatePolicy('justone', definition.operationKey, {
    desiredState: before.desiredState,
    expectedRevision: before.revision,
    reason: 'Seeded reviewed default price book',
    priceBook: narrowed.priceBook,
  }, { actor: 'deploy', runtime: runtime() })

  assert.equal(seeded.priceBook.source, 'database')
  assert.equal(seeded.priceBook.status, 'reviewed')
  assert.equal(seeded.effectiveState, 'active')
  assert.deepEqual(seeded.blockers, [])
})

test('a price set afterwards is not walked back by a later seed', async () => {
  const file = await priceBookFile()
  const store = new MemoryExternalPlatformControlStore()
  const definition = EXTERNAL_PLATFORM_OPERATION_CATALOG.justone[0]
  const narrowed = priceBookForOperation(file, definition.endpointKeys)

  const seeded = await store.updatePolicy('justone', definition.operationKey, {
    desiredState: 'active',
    expectedRevision: 0,
    reason: 'first deploy seed',
    priceBook: narrowed.priceBook,
  }, { actor: 'deploy', runtime: runtime() })

  // Somebody then raises the real price in the Admin UI.
  const operatorPrice = Object.fromEntries(
    definition.endpointKeys.map((endpointKey) => [endpointKey, 37]),
  )
  const edited = await store.updatePolicy('justone', definition.operationKey, {
    desiredState: 'active',
    expectedRevision: seeded.revision,
    reason: 'operator corrected the procurement price',
    priceBook: { ...narrowed.priceBook, unitCostMinorByEndpoint: operatorPrice },
  }, { actor: 'admin-token', runtime: runtime() })
  assert.deepEqual(edited.priceBook.endpointPrices, operatorPrice)

  // The next deploy sees source === 'database' and must skip this operation.
  const [current] = await store.describeProvider('justone', runtime())
  assert.equal(current.priceBook.source, 'database')
  assert.deepEqual(current.priceBook.endpointPrices, operatorPrice)
})

test('seeding never resumes a paused operation', async () => {
  const file = await priceBookFile()
  const store = new MemoryExternalPlatformControlStore()
  const definition = EXTERNAL_PLATFORM_OPERATION_CATALOG.justone[0]
  const narrowed = priceBookForOperation(file, definition.endpointKeys)

  const paused = await store.updatePolicy('justone', definition.operationKey, {
    desiredState: 'paused',
    expectedRevision: 0,
    reason: 'incident stop',
  }, { actor: 'admin-token', runtime: runtime() })
  assert.equal(paused.desiredState, 'paused')

  const seeded = await store.updatePolicy('justone', definition.operationKey, {
    desiredState: paused.desiredState,
    expectedRevision: paused.revision,
    reason: 'Seeded reviewed default price book',
    priceBook: narrowed.priceBook,
  }, { actor: 'deploy', runtime: runtime() })

  assert.equal(seeded.desiredState, 'paused')
  assert.equal(seeded.effectiveState, 'paused')
  assert.equal(seeded.priceBook.source, 'database')
})

test('the seeded budgets are positive, because zero blocks every subsidized call', async () => {
  const file = await priceBookFile()
  const unitCosts = Object.values(file.unitCostMinorByEndpoint)
  const highestUnitCost = Math.max(...unitCosts)

  // Both ceilings apply only to traffic Hub absorbs itself (a consumer with no
  // wallet-backed charge). Zero means "absorb nothing", which rejects every
  // such call with external_platform_cost_budget_exhausted -- the
  // blocked-on-day-one state this seed exists to prevent.
  for (const [minorField, callsField] of [
    ['monthlyBudgetMinor', 'monthlyBudgetCalls'],
    ['monthlySubsidyBudgetMinor', 'monthlySubsidyBudgetCalls'],
  ]) {
    const calls = file[callsField]
    const minor = file[minorField]
    const stated = Number.isSafeInteger(calls) ? calls * highestUnitCost : minor
    assert.ok(
      Number.isSafeInteger(stated) && stated > 0,
      `${callsField}/${minorField} must give a positive ceiling, not ${stated}`,
    )
    // The ceiling has to cover more than a single call, or the first request of
    // the month exhausts it.
    assert.ok(
      stated >= highestUnitCost,
      `${callsField}/${minorField} must cover at least one call at the highest unit price`,
    )
  }
})

test('a call budget is converted at the operation\'s highest unit price', async () => {
  const file = await priceBookFile()
  assert.ok(
    Number.isSafeInteger(file.monthlyBudgetCalls),
    'the seed states its budget in calls, which is what the provider bills',
  )

  const endpointKeys = ['taobao-tmall.product-search.v1', 'jd.product-search.v1']
  const highest = Math.max(...endpointKeys.map((key) => file.unitCostMinorByEndpoint[key]))
  const { priceBook } = priceBookForOperation(file, endpointKeys)

  assert.equal(priceBook.monthlyBudgetMinor, file.monthlyBudgetCalls * highest)
  assert.equal(priceBook.monthlyBudgetMinor / highest, file.monthlyBudgetCalls)
})

test('an explicit minor-unit budget is still honoured, and calls win per field', () => {
  const base = {
    currency: 'CNY',
    pricingAsOf: '2026-09-11T00:00:00Z',
    unitCostMinorByEndpoint: { 'a.v1': 107 },
  }
  const keys = ['a.v1']

  // A file that predates the call notation keeps working unchanged.
  const minorOnly = priceBookForOperation(
    { ...base, monthlyBudgetMinor: 123_456, monthlySubsidyBudgetMinor: 999 }, keys,
  ).priceBook
  assert.equal(minorOnly.monthlyBudgetMinor, 123_456)
  assert.equal(minorOnly.monthlySubsidyBudgetMinor, 999)

  // The two fields are independent: one may be stated in calls, the other not.
  const mixed = priceBookForOperation(
    { ...base, monthlyBudgetCalls: 10, monthlyBudgetMinor: 1, monthlySubsidyBudgetMinor: 7 }, keys,
  ).priceBook
  assert.equal(mixed.monthlyBudgetMinor, 1_070, 'calls win over minor for the same field')
  assert.equal(mixed.monthlySubsidyBudgetMinor, 7)
})
