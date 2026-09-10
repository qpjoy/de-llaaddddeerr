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
