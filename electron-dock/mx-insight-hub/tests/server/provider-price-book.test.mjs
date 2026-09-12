// One price book for the whole provider.
//
// A provider quotes one rate and one monthly commitment. Making an operator
// retype that into every operation is how a deployment ends up with a single
// operation still on a zero budget, refusing calls for no visible reason --
// which is exactly the failure this exists to remove. So the common case is one
// action, and per-operation editing stays for genuine exceptions.

import assert from 'node:assert/strict'
import test from 'node:test'
import { parseJustOneConfig } from '../../server/external-platforms/config.mjs'
import { ExternalPlatformAdminService } from '../../server/external-platforms/admin.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'

function justOneConfig() {
  return parseJustOneConfig({
    MX_INSIGHT_JUSTONE_CONFIGURED: '1',
    MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED: '1',
  })
}

function service() {
  return new ExternalPlatformAdminService({
    store: new MemoryExternalPlatformStore(),
    config: justOneConfig(),
    operationControlStore: new MemoryExternalPlatformControlStore(),
  })
}

const BASE = Object.freeze({
  currency: 'CNY',
  pricingAsOf: '2026-09-12',
  unitCostMinor: 107,
  monthlyBudgetCalls: 70_000,
  monthlySubsidyBudgetCalls: 70_000,
  reason: '按 2026-09 合同统一录入采购价目',
})

test('one publish prices every operation of the provider', async () => {
  const admin = service()
  const result = await admin.updateProviderPriceBook('justone', BASE)

  assert.ok(result.applied.length > 1, 'more than one operation was priced')
  assert.deepEqual(result.skipped, [])
  // Calls are what the operator states; the control plane stores money.
  assert.equal(result.monthlyBudgetMinor, 70_000 * 107)
  assert.equal(result.monthlySubsidyBudgetMinor, 70_000 * 107)

  const detail = await admin.detail('justone', '24h')
  for (const operation of detail.operations) {
    assert.equal(operation.priceBook.monthlyBudgetMinor, 70_000 * 107, operation.operationKey)
    assert.equal(operation.priceBook.currency, 'CNY', operation.operationKey)
    for (const endpointKey of operation.release.endpointKeys) {
      assert.equal(
        operation.priceBook.endpointPrices?.[endpointKey] ?? operation.priceBook.unitCostMinorByEndpoint?.[endpointKey],
        107,
        `${operation.operationKey}/${endpointKey}`,
      )
    }
  }
})

test('a per-operation override survives, and re-publishing overwrites it', async () => {
  const admin = service()
  await admin.updateProviderPriceBook('justone', BASE)

  const before = await admin.detail('justone', '24h')
  const target = before.operations[0]
  await admin.updateOperationPolicy('justone', target.operationKey, {
    desiredState: target.desiredState,
    expectedRevision: target.revision,
    reason: '这个操作单独收紧到 0',
    priceBook: {
      currency: 'CNY',
      pricingAsOf: '2026-09-12',
      monthlyBudgetMinor: 0,
      monthlySubsidyBudgetMinor: 0,
      unitCostMinorByEndpoint: Object.fromEntries(
        target.release.endpointKeys.map((endpointKey) => [endpointKey, 107]),
      ),
    },
  })

  const customized = await admin.detail('justone', '24h')
  const narrowed = customized.operations.find((row) => row.operationKey === target.operationKey)
  assert.equal(narrowed.priceBook.monthlyBudgetMinor, 0, 'the customization took effect')
  const untouched = customized.operations.find((row) => row.operationKey !== target.operationKey)
  assert.equal(untouched.priceBook.monthlyBudgetMinor, 70_000 * 107, 'others keep the common value')

  // Re-publishing the common book is a deliberate overwrite, which is the
  // model the console states: set the common value, then re-customize.
  await admin.updateProviderPriceBook('justone', { ...BASE, reason: '重新统一' })
  const reapplied = await admin.detail('justone', '24h')
  assert.equal(
    reapplied.operations.find((row) => row.operationKey === target.operationKey).priceBook.monthlyBudgetMinor,
    70_000 * 107,
  )
})

test('pricing a provider never switches an operation on', async () => {
  const admin = service()
  const before = await admin.detail('justone', '24h')
  const desiredBefore = Object.fromEntries(
    before.operations.map((operation) => [operation.operationKey, operation.desiredState]),
  )

  await admin.updateProviderPriceBook('justone', BASE)

  const after = await admin.detail('justone', '24h')
  for (const operation of after.operations) {
    assert.equal(
      operation.desiredState,
      desiredBefore[operation.operationKey],
      `${operation.operationKey} keeps the state an operator chose`,
    )
  }
})

test('incomplete evidence is refused rather than written as zero', async () => {
  const admin = service()
  for (const body of [
    { ...BASE, reason: '' },
    { ...BASE, unitCostMinor: 0 },
    { ...BASE, unitCostMinor: -1 },
    { currency: 'CNY', pricingAsOf: '2026-09-12', unitCostMinor: 107, reason: 'no budget stated' },
  ]) {
    await assert.rejects(
      () => admin.updateProviderPriceBook('justone', body),
      (error) => error?.status === 400,
      JSON.stringify(body).slice(0, 80),
    )
  }
  const detail = await admin.detail('justone', '24h')
  assert.ok(
    detail.operations.every((operation) => operation.priceBook.monthlyBudgetMinor == null),
    'nothing was written',
  )
})

test('a budget may also be stated directly in minor units', async () => {
  const admin = service()
  const result = await admin.updateProviderPriceBook('justone', {
    currency: 'CNY',
    pricingAsOf: '2026-09-12',
    unitCostMinor: 107,
    monthlyBudgetMinor: 500_000,
    monthlySubsidyBudgetMinor: 0,
    reason: '按金额录入',
  })
  assert.equal(result.monthlyBudgetMinor, 500_000)
  assert.equal(result.monthlySubsidyBudgetMinor, 0)
})

// The routes talk to the multi-provider facade, not to a single provider's
// service. A method added to one and not the other compiles, passes unit tests,
// and fails only in the running console -- which is exactly how this one was
// found.
test('the multi-provider facade forwards every operation the single service exposes', async () => {
  const { MultiExternalPlatformAdminService } = await import('../../server/external-platforms/admin.mjs')
  const single = service()
  const facade = new MultiExternalPlatformAdminService([single])

  const forwarded = [
    'overview', 'detail', 'updateCredential', 'updateOperationPolicy',
    'revealCredential', 'updateProviderPriceBook',
  ]
  for (const method of forwarded) {
    assert.equal(typeof facade[method], 'function', `facade forwards ${method}`)
    assert.equal(typeof single[method], 'function', `service implements ${method}`)
  }

  // And it actually reaches the provider rather than merely existing.
  const result = await facade.updateProviderPriceBook('justone', BASE)
  assert.ok(result.applied.length > 0)
})
