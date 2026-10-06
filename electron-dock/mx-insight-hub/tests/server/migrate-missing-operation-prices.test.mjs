import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adminClient, bootstrapOnly, migrate, parseArgs, planOperation } from '../../scripts/migrate-missing-operation-prices.mjs'
import { MemoryExternalPlatformControlStore, normalizePriceBook } from '../../server/external-platforms/control-store.mjs'

const operationKey = 'native.t.douyin_search_fetch_video_search_v1'
const timestamp = '2026-10-06T12:00:00Z'
function event(overrides = {}) {
  return { provider_key: 'tikhub', operation_key: operationKey, revision: 1, previous_revision: null,
    desired_state: 'disabled', actor: 'migration-112', reason: 'Review procurement price and activate explicitly', ...overrides }
}
function operation(overrides = {}) {
  return { operationKey, controlSource: 'database', desiredState: 'disabled', effectiveState: 'disabled', revision: 1,
    release: { status: 'released', endpointKeys: [operationKey] },
    priceBook: { source: 'legacy_environment', status: 'incomplete', currency: null, endpointPrices: { [operationKey]: null } },
    blockers: [{ code: 'price_control_incomplete' }], ...overrides }
}
function plan(op = operation(), overrides = {}) {
  return planOperation(op, { provider: 'tikhub', events: [event()], defaultCurrency: 'USD',
    defaultCurrencySource: 'provider_seed', missingBudgetMinor: 100000, pricingAsOf: timestamp, ...overrides })
}

test('recovers bootstrap-disabled missing prices using one cent and explicit missing budgets', () => {
  const result = plan()
  assert.equal(result.body.desiredState, 'active')
  assert.equal(result.body.expectedRevision, 1)
  assert.deepEqual(result.body.priceBook, { currency: 'USD', pricingAsOf: timestamp,
    monthlyBudgetMinor: 100000, monthlySubsidyBudgetMinor: 100000, unitCostMinorByEndpoint: { [operationKey]: 1 } })
  assert.match(result.body.reason, /provisional procurement/)
  normalizePriceBook(result.body.priceBook, { endpointKeys: [operationKey] })
})

test('preserves original currency, partial prices, optional prices and explicit zero budgets', () => {
  const result = plan(operation({ release: { status: 'released', endpointKeys: ['priced', 'missing'], optionalEndpointKeys: ['optional'] },
    priceBook: { currency: 'CNY', endpointPrices: { priced: 107, optional: 25, unrelated: 99 }, monthlyBudgetMinor: 0, monthlySubsidyBudgetMinor: 75000 } }))
  assert.deepEqual(result.body.priceBook, { currency: 'CNY', pricingAsOf: timestamp,
    monthlyBudgetMinor: 0, monthlySubsidyBudgetMinor: 75000, unitCostMinorByEndpoint: { priced: 107, missing: 1, optional: 25 } })
  assert.deepEqual(result.filledEndpointKeys, ['missing'])
  assert.deepEqual(result.filledBudgetFields, [])
})

test('preserves free and explicitly zero-priced endpoints, ready operations and non-price blockers', () => {
  for (const price of [0, 8]) assert.equal(plan(operation({ priceBook: { endpointPrices: { [operationKey]: price } } })).action, 'skip')
  for (const desiredState of ['paused', 'shadow']) assert.equal(plan(operation({ desiredState })).reason, 'operator_state_preserved')
  for (const code of ['credential_missing', 'reservation_lease_too_short', 'enterprise_price_unpublished', 'release_not_active']) {
    assert.match(plan(operation({ blockers: [{ code: 'price_control_incomplete' }, { code }] })).reason, /other_blockers/)
  }
  assert.equal(plan(operation({ release: { status: 'retired' } })).reason, 'release_unavailable')
  assert.equal(plan(operation({ blockers: [] })).reason, 'no_price_blocker')
})

test('never resumes manual disable, including a later automatic price seed or incomplete audit', () => {
  const manual = event({ revision: 2, previous_revision: 1, actor: 'admin-token', reason: 'Incident stop' })
  const seed = event({ revision: 3, previous_revision: 2, actor: 'admin-token',
    reason: 'Seeded reviewed default price book from seeds/pricebooks/tikhub.json' })
  assert.equal(plan(operation({ revision: 3 }), { events: [event(), manual, seed] }).reason, 'manual_or_unproven_disable')
  assert.equal(plan(operation({ revision: 3 }), { events: [event(), seed] }).reason, 'manual_or_unproven_disable')
  assert.equal(plan(operation(), { events: [] }).reason, 'manual_or_unproven_disable')
  assert.equal(bootstrapOnly(operation({ revision: 2 }), [event(), { ...seed, revision: 2, previous_revision: 1 }], 'tikhub'), true)
})

test('repairs active/canary pricing without expanding the allowlist or changing state', () => {
  const canaryConsumerIds = ['00000000-0000-4000-8000-000000000001']
  for (const desiredState of ['active', 'canary']) {
    const result = plan(operation({ desiredState, effectiveState: 'blocked', canaryConsumerIds }))
    assert.equal(result.body.desiredState, desiredState)
    if (desiredState === 'canary') assert.deepEqual(result.body.canaryConsumerIds, canaryConsumerIds)
  }
})

test('does not invent currency, re-label existing prices, or interpret 0.01 as a yen/dinar unit', () => {
  assert.equal(plan(operation(), { defaultCurrency: null }).reason, 'currency_unknown')
  assert.equal(plan(operation({ release: { status: 'released', endpointKeys: ['a', 'b'] },
    priceBook: { endpointPrices: { a: 2 } } })).reason, 'currency_unknown_for_existing_prices')
  for (const currency of ['JPY', 'KWD']) assert.equal(plan(operation({ priceBook: { currency } })).reason, 'currency_not_two_decimal')
  assert.equal(plan(operation(), { missingBudgetMinor: null }).reason, 'missing_budget_policy_required')
})

test('Admin transport permits only local HTTP or HTTPS and never follows redirects', async () => {
  assert.throws(() => adminClient('http://remote.example', 'secret'), /HTTPS/)
  assert.throws(() => adminClient('https://user:pass@example.org', 'secret'), /origin/)
  let calls = 0
  const admin = adminClient('http://127.0.0.1:18151', 'secret', async (_url, init) => {
    calls++
    assert.equal(init.redirect, 'error')
    assert.equal(init.method, 'PUT')
    return { ok: false, status: 409, json: async () => ({ error: { code: 'revision_conflict' } }) }
  })
  await assert.rejects(admin('/internal/test', {}), /revision_conflict/)
  assert.equal(calls, 1)
})

test('CLI requires explicit scope and missing budget policy; preview is the default', () => {
  assert.throws(() => parseArgs(['--all']), /missing-budget/)
  assert.throws(() => parseArgs(['--all', '--provider', 'tikhub']), /Choose/)
  assert.equal(parseArgs(['--all', '--missing-budget-minor', '100000']).apply, false)
})

test('all-provider preview plans all reads before writes and reports unknown-currency providers', async () => {
  const calls = []
  const admin = async (path, body) => {
    calls.push({ path, body })
    if (path.endsWith('external-platforms?range=24h')) return { providers: [{ key: 'tikhub' }, { key: 'justone' }, { key: 'exa' }] }
    return { operations: [operation()], provider: { billing: {} } }
  }
  const report = await migrate({ options: parseArgs(['--all', '--missing-budget-minor', '100000']), admin,
    audit: ['tikhub', 'justone', 'exa'].map(provider_key => event({ provider_key })), now: () => timestamp })
  assert.deepEqual(report.plans.map(row => row.body.priceBook.currency), ['USD', 'CNY'])
  assert.equal(report.skipped[0].reason, 'currency_unknown')
  assert.equal(calls.length, 4)
  assert.ok(calls.every(call => !call.body))
})

test('apply uses the real control policy validator and rerunning cannot duplicate writes', async () => {
  const store = new MemoryExternalPlatformControlStore()
  const runtime = { config: { billing: {}, reservationLeaseMs: 150000 }, credentialConfigured: true }
  const before = (await store.describeProvider('tikhub', runtime)).find(row => row.operationKey === operationKey)
  const audit = [event({ revision: before.revision })]
  let writes = 0
  const admin = async (path, body) => {
    if (body) { writes++; return store.updatePolicy('tikhub', operationKey, body, { actor: 'admin-token', runtime }) }
    if (path.endsWith('external-platforms?range=24h')) return { providers: [{ key: 'tikhub' }] }
    return { operations: (await store.describeProvider('tikhub', runtime)).filter(row => row.operationKey === operationKey), provider: { billing: {} } }
  }
  const options = parseArgs(['--all', '--missing-budget-minor', '100000', '--apply'])
  const first = await migrate({ options, admin, audit })
  assert.equal(first.summary.confirmedWrites, 1)
  assert.equal(first.results[0].effectiveState, 'active')
  assert.equal(first.summary.errors, 0)
  const second = await migrate({ options, admin, audit })
  assert.equal(second.plans.length, 0)
  assert.equal(writes, 1)
})

test('conflict/unknown write stops the batch, reports partial progress and never retries', async () => {
  let writes = 0
  const admin = async (path, body) => {
    if (body) { writes++; if (writes === 2) throw new Error('Timeout'); return { effectiveState: 'active', revision: 2 } }
    if (path.endsWith('external-platforms?range=24h')) return { providers: [{ key: 'tikhub' }] }
    return { operations: ['a', 'b', 'c'].map(operationKey => operation({ operationKey })), provider: { billing: {} } }
  }
  const report = await migrate({ options: parseArgs(['--all', '--missing-budget-minor', '100000', '--apply']),
    admin, audit: ['a', 'b', 'c'].map(operation_key => event({ operation_key })) })
  assert.equal(writes, 2)
  assert.deepEqual(report.summary, { planned: 3, skipped: 0, confirmedWrites: 1, errors: 1, unattempted: 1 })
  assert.equal(report.errors[0].reason, 'write_not_confirmed')
})

test('concurrent operator price/state changes win over a stale migration plan', async () => {
  const store = new MemoryExternalPlatformControlStore()
  const runtime = { config: { billing: {}, reservationLeaseMs: 150000 }, credentialConfigured: true }
  const before = (await store.describeProvider('tikhub', runtime)).find(row => row.operationKey === operationKey)
  const admin = async (path, body) => {
    if (body) {
      await store.updatePolicy('tikhub', operationKey, { expectedRevision: before.revision,
        desiredState: 'paused', reason: 'Concurrent operator pause',
        priceBook: { currency: 'USD', pricingAsOf: timestamp, monthlyBudgetMinor: 70000,
          monthlySubsidyBudgetMinor: 0, unitCostMinorByEndpoint: { [operationKey]: 20 } } }, { runtime })
      return store.updatePolicy('tikhub', operationKey, body, { runtime })
    }
    if (path.endsWith('external-platforms?range=24h')) return { providers: [{ key: 'tikhub' }] }
    return { operations: [before], provider: { billing: {} } }
  }
  const report = await migrate({ options: parseArgs(['--all', '--missing-budget-minor', '100000', '--apply']),
    admin, audit: [event({ revision: before.revision })] })
  assert.equal(report.summary.confirmedWrites, 0)
  assert.equal(report.summary.errors, 1)
  const after = (await store.describeProvider('tikhub', runtime)).find(row => row.operationKey === operationKey)
  assert.equal(after.desiredState, 'paused')
  assert.equal(after.priceBook.endpointPrices[operationKey], 20)
  assert.equal(after.priceBook.monthlySubsidyBudgetMinor, 0)
})

test('a saved operation that becomes blocked is reported separately from successful readiness', async () => {
  const admin = async (path, body) => {
    if (body) return { effectiveState: 'blocked', revision: 2, blockers: [{ code: 'credential_missing' }] }
    if (path.endsWith('external-platforms?range=24h')) return { providers: [{ key: 'tikhub' }] }
    return { operations: [operation()], provider: { billing: {} } }
  }
  const report = await migrate({ options: parseArgs(['--all', '--missing-budget-minor', '100000', '--apply']), admin, audit: [event()] })
  assert.equal(report.summary.confirmedWrites, 1)
  assert.equal(report.summary.errors, 1)
  assert.equal(report.errors[0].reason, 'saved_but_not_ready')
  assert.equal(report.summary.unattempted, 0)
})
