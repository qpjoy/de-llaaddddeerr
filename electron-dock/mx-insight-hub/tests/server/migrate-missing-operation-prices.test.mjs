import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { adminClient, bootstrapOnly, failureDiagnostic, migrate, parseArgs, planOperation } from '../../scripts/migrate-missing-operation-prices.mjs'
import { EXTERNAL_PLATFORM_OPERATION_CATALOG, MemoryExternalPlatformControlStore, normalizePriceBook } from '../../server/external-platforms/control-store.mjs'
import { BaiduIpAdminService } from '../../server/external-platforms/baidu-ip-admin.mjs'
import { MultiExternalPlatformAdminService } from '../../server/external-platforms/admin.mjs'
import { IpSearchAdminService } from '../../server/external-platforms/ipsearch-admin.mjs'
import { NightAllPlatformAdminService } from '../../server/external-platforms/night-all-admin.mjs'
import { NightAllAService } from '../../server/external-platforms/night-all-a.mjs'

const operationKey = 'native.t.douyin_search_fetch_video_search_v1'
const timestamp = '2026-10-06T12:00:00Z'

test('targeted price repair selects exact operations and rejects missing inventory before writes', async () => {
  const search = 'native.wechat.search.search'
  const detail = 'native.wechat.mp.article-detail'
  const videos = 'native.wechat.search.search-videos'
  const keys = [search, detail, videos, operationKey]
  const writes = []
  const admin = async (path, body) => {
    if (body) { writes.push(path); return { effectiveState: 'active', revision: 2 } }
    if (path.endsWith('external-platforms?range=24h')) return { providers: [{ key: 'tikhub' }] }
    return { operations: keys.map(key => operation({ operationKey: key,
      release: { status: 'released', endpointKeys: [key] },
      priceBook: { endpointPrices: { [key]: null } } })), provider: { billing: {} } }
  }
  const options = parseArgs(['--provider', 'tikhub', '--operation', search, '--operation', detail,
    '--operation', search, '--missing-budget-minor', '100000', '--apply'])
  assert.deepEqual(options.operations, [search, detail])
  const audit = keys.map(key => event({ operation_key: key }))
  const result = await migrate({ options, admin, audit })
  assert.equal(result.summary.confirmedWrites, 2)
  assert.deepEqual(result.plans.map(row => row.operationKey), [search, detail])
  assert.ok(writes.every(path => [search, detail].some(key => path.endsWith(`/${key}/policy`))))
  writes.length = 0
  await assert.rejects(migrate({ options: { ...options, operations: [search, 'native.wechat.missing'] }, admin, audit }),
    /Selected operation not found; no writes attempted/)
  assert.equal(writes.length, 0)
  assert.throws(() => parseArgs(['--all', '--operation', search, '--missing-budget-minor', '100000']), /requires --provider/)
  assert.throws(() => parseArgs(['--provider', 'tikhub', '--operation', 'native.wechat.*', '--missing-budget-minor', '100000']), /Invalid --operation/)
})

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

test('automatic defaults fill unavailable and paused operations but preserve manual states and prices', () => {
  for (const state of ['paused', 'disabled', 'canary', 'shadow', 'active']) {
    const op = operation({ desiredState: state, canaryConsumerIds: ['existing-consumer'],
      release: { status: 'released', endpointKeys: ['paid', 'missing'] },
      priceBook: { currency: 'USD', endpointPrices: { paid: 17, missing: null }, monthlyBudgetMinor: 0 },
      blockers: [{ code: 'credential_missing' }] })
    const result = plan(op, { defaults: true, events: [event({ actor: 'operator', desired_state: state })] })
    assert.equal(result.body.desiredState, state)
    assert.deepEqual(result.body.priceBook.unitCostMinorByEndpoint, { paid: 17, missing: 1 })
    assert.equal(result.body.priceBook.monthlyBudgetMinor, 0)
    if (state === 'canary') assert.deepEqual(result.body.canaryConsumerIds, ['existing-consumer'])
  }
})

test('automatic defaults activate already priced bootstrap operations, then become a no-op', () => {
  const op = operation({ priceBook: { currency: 'USD', ready: true, endpointPrices: { [operationKey]: 5 } } })
  const result = plan(op, { defaults: true })
  assert.equal(result.body.desiredState, 'active')
  assert.equal(result.body.priceBook.unitCostMinorByEndpoint[operationKey], 5)
  assert.equal(plan({ ...op, desiredState: 'active' }, { defaults: true }).action, 'skip')
  assert.equal(plan(op, { defaults: true, events: [event({ actor: 'operator' })] }).action, 'skip')
})

test('automatic defaults validate against every priced provider contract, including future optional endpoints', async () => {
  const controls = new MemoryExternalPlatformControlStore()
  let validated = 0
  for (const [provider, definitions] of Object.entries(EXTERNAL_PLATFORM_OPERATION_CATALOG)) {
    if (provider === 'baidu-ip') continue // independent subscription channel, not operation pricing
    for (const op of await controls.describeProvider(provider)) {
      const result = planOperation(op, { provider, defaults: true, defaultCurrency: 'CNY',
        missingBudgetMinor: 100000, pricingAsOf: timestamp })
      if (result.action !== 'apply') continue
      const definition = definitions.find(row => row.operationKey === op.operationKey)
      normalizePriceBook(result.body.priceBook, definition)
      validated++
    }
  }
  assert.ok(validated > 1000)
})

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
  await assert.rejects(admin(`/internal/v1/admin/external-platforms/tikhub/operations/${operationKey}/policy`, {}), /revision_conflict/)
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

test('real mixed provider registry skips non-pricing services and still migrates TikHub', async () => {
  const ipsearch = new IpSearchAdminService({ analytics: async () => ({ totals: { hubRequests: 0,
    idempotentReplay: 0, duplicateSuppressed: 0 } }) }, {
    events: { summary: async () => ({}) }, capabilities: async () => ({ ready: false }),
  })
  const nightAll = new NightAllPlatformAdminService({ store: { nightAllAnalytics: async () => [] }, config: {} })
  const nightAllA = new NightAllAService({ config: { enabled: false } })
  const baiduIp = new BaiduIpAdminService({ policy: async () => ({ enabled: true }) }, { analytics: async () => ({ totals: {} }) })
  // Reproduce the actual heterogeneous DTOs that the old script treated as errors.
  assert.equal((await ipsearch.detail('ipsearch')).operations, undefined)
  assert.equal((await nightAll.detail('night-all')).operations, undefined)
  assert.equal((await baiduIp.detail('baidu-ip')).operations, undefined)
  const collectorOperations = (await nightAllA.detail('night-all-a')).operations
  assert.ok(collectorOperations.length > 0)
  assert.ok(collectorOperations.every(row => !row.operationKey))
  let writes = 0
  const registry = new MultiExternalPlatformAdminService([ipsearch, baiduIp, nightAll, nightAllA, {
    providerKey: 'tikhub',
    overview: async () => ({ providers: [{ key: 'tikhub', metrics: {}, billing: {} }] }),
    detail: async () => ({ operations: [operation()], provider: { billing: {} } }),
    updateOperationPolicy: async (_provider, key) => {
      assert.equal(key, operationKey)
      writes++
      return { effectiveState: 'active', revision: 2 }
    },
  }])
  const detailReads = []
  const admin = async (path, body) => {
    const parts = path.split('?')[0].split('/').filter(Boolean)
    if (body) return registry.updateOperationPolicy(parts[4], parts[6], body)
    if (parts.length === 4) return registry.overview('24h')
    detailReads.push(parts[4])
    return registry.detail(parts[4], '24h')
  }
  const report = await migrate({ options: parseArgs(['--all', '--missing-budget-minor', '100000', '--apply']), admin, audit: [event()] })
  assert.deepEqual(detailReads, ['tikhub'])
  assert.equal(writes, 1)
  assert.equal(report.summary.errors, 0)
  assert.deepEqual(report.skipped.map(row => [row.provider, row.reason]), [
    ['ipsearch', 'provider_has_no_operation_pricing'],
    ['baidu-ip', 'provider_has_no_operation_pricing'],
    ['night-all', 'provider_has_no_operation_pricing'],
    ['night-all-a', 'provider_has_no_operation_pricing'],
  ])
})

test('a missing priced-provider inventory still stops before all writes and names the provider', async () => {
  const admin = async (path, body) => {
    assert.equal(body, undefined)
    if (path.endsWith('external-platforms?range=24h')) return { providers: [{ key: 'tikhub' }, { key: 'justone' }] }
    return path.includes('/tikhub?') ? { operations: [operation()] } : {}
  }
  await assert.rejects(migrate({ options: parseArgs(['--all', '--missing-budget-minor', '100000', '--apply']), admin, audit: [event()] }), error => {
    assert.equal(failureDiagnostic(error), '[operation_inventory] Missing operation inventory: justone')
    return true
  })
})

test('safe diagnostics identify HTTP and transport failures without credential or response contents', async () => {
  const path = '/internal/v1/admin/external-platforms?range=24h'
  const cases = [
    { run: async () => ({ ok: false, status: 401, json: async () => ({ error: { code: 'unauthorized', message: 'secret-token' } }) }), expected: /HTTP 401, code=unauthorized/ },
    { run: async () => ({ ok: false, status: 502, json: async () => { throw new Error('secret-token HTML') } }), expected: /HTTP 502, code=unavailable/ },
    { run: async () => { throw new Error('postgres://user:secret-token@host/db', { cause: { code: 'ECONNREFUSED' } }) }, expected: /transport failure \(ECONNREFUSED\)/ },
  ]
  for (const entry of cases) {
    const admin = adminClient('http://127.0.0.1:18151', 'secret-token', entry.run)
    await assert.rejects(admin(path), error => {
      const diagnostic = failureDiagnostic(error)
      assert.match(diagnostic, entry.expected)
      assert.match(diagnostic, /\[admin_request\] GET \/internal\/v1\/admin\/external-platforms/)
      assert.doesNotMatch(diagnostic, /secret-token|postgres:/)
      return true
    })
  }
  assert.doesNotMatch(failureDiagnostic(new Error('secret-token')), /secret-token/)
})

test('the exact stdin CLI mode prints the missing configuration instead of blanket Error', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-', '--all', '--missing-budget-minor', '100000'], {
    input: readFileSync(new URL('../../scripts/migrate-missing-operation-prices.mjs', import.meta.url), 'utf8'), encoding: 'utf8',
    env: { ...process.env, MX_INSIGHT_ADMIN_BASE_URL: 'http://127.0.0.1:18151', MX_INSIGHT_ADMIN_TOKEN: 'secret-token', DATABASE_URL: '' },
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /\[audit_read\] DATABASE_URL is required/)
  assert.doesNotMatch(result.stderr, /secret-token|Failed: Error\./)
  assert.equal(result.stdout, '')
})
