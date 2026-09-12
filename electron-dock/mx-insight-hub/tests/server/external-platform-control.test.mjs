import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { JUSTONE_OPERATION } from '../../server/contracts/justone.mjs'
import { XIAOHONGSHU_POST_OPERATION } from '../../server/contracts/tikhub-xiaohongshu.mjs'
import {
  TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_KEY,
  XIAOHONGSHU_SEARCH_OPERATION,
} from '../../server/contracts/tikhub-xiaohongshu-search.mjs'
import { XIAOHONGSHU_USER_INFO_OPERATION } from '../../server/contracts/tikhub-xiaohongshu-user-info.mjs'
import { XIAOHONGSHU_CRAWL_OPERATION } from '../../server/contracts/tikhub-xiaohongshu-user-posts.mjs'
import {
  parseJustOneConfig,
  parseTikHubConfig,
} from '../../server/external-platforms/config.mjs'
import {
  MemoryExternalPlatformControlStore,
  PostgresExternalPlatformControlStore,
} from '../../server/external-platforms/control-store.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { TikHubGateway } from '../../server/external-platforms/tikhub-gateway.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const ENDPOINTS = [
  'taobao-tmall.product-search.v1',
  'jd.product-search.v1',
  'xiaohongshu-ec.product-search.v1',
  'xianyu.product-search.v1',
]

function runtime({ contractVerified = true, priced = true, credentialConfigured = true } = {}) {
  return {
    credentialConfigured,
    config: {
      contractVerified,
      configurationError: null,
      billing: priced ? {
        source: 'manual',
        currency: 'CNY',
        pricingAsOf: '2026-09-10T00:00:00.000Z',
        monthlyBudgetMinor: 100_000,
        monthlySubsidyBudgetMinor: 10_000,
        unitCostMinorByEndpoint: Object.fromEntries(ENDPOINTS.map((key) => [key, 5])),
      } : {
        source: 'unknown',
        currency: null,
        pricingAsOf: null,
        monthlyBudgetMinor: null,
        monthlySubsidyBudgetMinor: null,
        unitCostMinorByEndpoint: {},
      },
    },
  }
}

function priceBook(cost = 7) {
  return {
    currency: 'CNY',
    pricingAsOf: '2026-09-10T08:00:00.000Z',
    monthlyBudgetMinor: 200_000,
    monthlySubsidyBudgetMinor: 0,
    unitCostMinorByEndpoint: Object.fromEntries(ENDPOINTS.map((key) => [key, cost])),
  }
}

test('migration 060 adds immutable provider rollout, price and call-admission evidence', async () => {
  const sql = await readFile(
    new URL('../../migrations/060_external_platform_operation_control.sql', import.meta.url),
    'utf8',
  )
  assert.match(sql, /external_platform_provider_price_books/u)
  assert.match(sql, /external_platform_provider_price_book_entries/u)
  assert.match(sql, /external_platform_operation_releases/u)
  assert.match(sql, /external_platform_operation_policies/u)
  assert.match(sql, /external_platform_operation_policy_events/u)
  assert.match(sql, /'disabled', 'shadow', 'canary', 'active', 'paused'/u)
  assert.match(sql, /database active\/canary policy requires a reviewed positive price book/u)
  assert.match(sql, /operation_policy_revision bigint/u)
  assert.match(sql, /operation_release_revision bigint/u)
  assert.match(sql, /provider_price_book_version bigint/u)
  assert.match(sql, /provider_credential_revision bigint/u)
  assert.match(sql, /provider_call_safe_integer_boundaries/u)
  assert.match(sql, /external_platform_provider_calls_credential_revision_safe_check/u)
  assert.match(sql, /external_platform_provider_settings_revision_safe_check/u)
  assert.match(sql, /CHECK \(revision BETWEEN 0 AND 9007199254740991\)[\s\S]*NOT VALID/u)
  assert.match(sql, /capture_provider_call_control_evidence/u)
  assert.match(sql, /provider call control evidence is immutable/u)
  assert.match(sql, /control evidence must be complete/u)
  assert.match(
    sql,
    /operation_policy_revision IS NULL[\s\S]*provider_credential_revision IS NULL[\s\S]*operation_policy_revision IS NOT NULL[\s\S]*provider_credential_revision IS NOT NULL/u,
  )
  assert.match(sql, /external_platform_provider_calls_control_completeness_check/u)
  assert.match(sql, /external_platform_provider_calls_policy_event_fkey/u)
  assert.match(sql, /external_platform_provider_calls_release_fkey/u)
  assert.match(sql, /external_platform_provider_calls_price_book_fkey/u)
  assert.match(sql, /external platform evidence rows are append-only/u)
  assert.match(sql, /external platform version evidence is immutable/u)
  assert.doesNotMatch(sql, /CREATE INDEX IF NOT EXISTS external_platform_provider_calls_control_revision_idx/u)
  assert.match(sql, /REVOKE ALL ON TABLE control\.external_platform_operation_policies FROM PUBLIC/u)
  assert.doesNotMatch(sql, /UPDATE external_platform\.provider_calls\s+SET/iu)
})

test('missing env price evidence does not crash runtime provider construction', () => {
  const justOne = parseJustOneConfig({
    MX_INSIGHT_JUSTONE_CONFIGURED: '1',
    MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED: '1',
    MX_INSIGHT_JUSTONE_BILLING_JSON: '',
  })
  assert.equal(justOne.configurationError, null)
  assert.equal(justOne.contractVerified, true)
  assert.equal(justOne.costControlError?.code, 'cost_control_incomplete')

  const tikHub = parseTikHubConfig({
    MX_INSIGHT_TIKHUB_CONFIGURED: '1',
    MX_INSIGHT_TIKHUB_CONTRACT_VERIFIED: '1',
    MX_INSIGHT_TIKHUB_SEARCH_CONTRACT_VERIFIED: '1',
    MX_INSIGHT_TIKHUB_BILLING_JSON: '',
  })
  assert.equal(tikHub.configurationError, null)
  assert.equal(tikHub.contractVerified, true)
  assert.equal(tikHub.costControlError?.code, 'cost_control_incomplete')
})

test('Postgres control reads reject unsafe bigint evidence instead of rounding it', async () => {
  const pool = {
    async query() {
      return {
        rows: [{
          provider_key: 'justone',
          operation_key: JUSTONE_OPERATION,
          control_source: 'database',
          desired_state: 'active',
          canary_consumer_ids: [],
          revision: '9007199254740992',
          release_revision: '1',
          release_status: 'released',
          contract_version: 'mx-insight-hub.ecommerce-products.v1',
          endpoint_keys: ENDPOINTS,
          price_book_version: '1',
          price_book_source: 'database',
          price_book_status: 'reviewed',
          currency: 'CNY',
          pricing_as_of: '2026-09-10T08:00:00.000Z',
          monthly_budget_minor: '1000',
          monthly_subsidy_budget_minor: '0',
          endpoint_prices: Object.fromEntries(ENDPOINTS.map((key) => [key, 1])),
          updated_by: 'admin-token',
          updated_at: '2026-09-10T09:00:00.000Z',
        }],
      }
    },
  }
  const store = new PostgresExternalPlatformControlStore({ pool })

  await assert.rejects(
    store.describeProvider('justone', runtime()),
    (error) => error?.code === 'external_platform_control_evidence_invalid',
  )
})

test('legacy revision zero follows retained environment without turning an enabled endpoint off', async () => {
  const store = new MemoryExternalPlatformControlStore()
  const [enabled] = await store.describeProvider('justone', runtime())
  assert.equal(enabled.controlSource, 'legacy_environment')
  assert.equal(enabled.revision, 0)
  assert.equal(enabled.desiredState, 'active')
  assert.equal(enabled.effectiveState, 'active')

  const [disabled] = await store.describeProvider(
    'justone',
    { ...runtime(), config: { ...runtime().config, contractVerified: false } },
  )
  assert.equal(disabled.desiredState, 'disabled')
  assert.equal(disabled.effectiveState, 'disabled')
})

test('Admin can publish reviewed prices and activate when environment price evidence is absent', async () => {
  const store = new MemoryExternalPlatformControlStore()
  const consumerId = randomUUID()
  const missingPriceRuntime = runtime({ priced: false })
  const [before] = await store.describeProvider('justone', missingPriceRuntime)
  assert.equal(before.effectiveState, 'blocked')
  assert.deepEqual(before.blockers.map((entry) => entry.code), ['price_control_incomplete'])

  const active = await store.updatePolicy('justone', JUSTONE_OPERATION, {
    expectedRevision: 0,
    desiredState: 'active',
    reason: 'Reviewed procurement terms in Admin',
    priceBook: priceBook(),
  }, { runtime: missingPriceRuntime, actor: 'admin-token' })
  assert.equal(active.controlSource, 'database')
  assert.equal(active.revision, 1)
  assert.equal(active.release.revision, 2)
  assert.equal(active.priceBook.source, 'database')
  assert.equal(active.priceBook.status, 'reviewed')
  assert.equal(active.effectiveState, 'active')

  const admitted = await store.authorizeDispatch('justone', JUSTONE_OPERATION, {
    ...missingPriceRuntime,
    consumerId,
    credentialRevision: 3,
  })
  assert.equal(admitted.policyRevision, 1)
  assert.equal(admitted.releaseRevision, 2)
  assert.equal(admitted.priceBookVersion, 1)
  assert.equal(admitted.credentialRevision, 3)
  assert.equal(admitted.billing.unitCostMinorByEndpoint[ENDPOINTS[0]], 7)
})

test('environment credentials retain explicit revision-zero admission evidence', async () => {
  const store = new MemoryExternalPlatformControlStore()
  const admitted = await store.authorizeDispatch('justone', JUSTONE_OPERATION, {
    ...runtime(),
    consumerId: randomUUID(),
  })

  assert.equal(admitted.credentialRevision, 0)
})

test('Postgres policy update atomically publishes price, release, policy and audit event', async () => {
  const statements = []
  let releasedWith = Symbol('not released')
  let policy = {
    control_source: 'legacy_environment',
    desired_state: 'active',
    canary_consumer_ids: [],
    revision: 0,
    release_revision: 1,
  }
  let publishedPrice = null
  let eventValues = null
  const selectedRow = () => ({
    provider_key: 'justone',
    operation_key: JUSTONE_OPERATION,
    ...policy,
    updated_by: policy.control_source === 'database' ? 'source-admin' : 'migration-060',
    updated_at: '2026-09-10T09:00:00.000Z',
    release_status: 'released',
    contract_version: 'mx-insight-hub.ecommerce-products.v1',
    endpoint_keys: ENDPOINTS,
    price_book_version: publishedPrice ? 1 : 0,
    price_book_source: publishedPrice ? 'database' : 'legacy_environment',
    price_book_status: publishedPrice ? 'reviewed' : 'inherited',
    currency: publishedPrice?.currency ?? null,
    pricing_as_of: publishedPrice?.pricingAsOf ?? null,
    monthly_budget_minor: publishedPrice?.monthlyBudgetMinor ?? null,
    monthly_subsidy_budget_minor: publishedPrice?.monthlySubsidyBudgetMinor ?? null,
    endpoint_prices: publishedPrice?.endpointPrices ?? {},
  })
  const query = async (sql, values = []) => {
    statements.push({ sql, values })
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] }
    if (/SELECT control_source,[\s\S]*FOR UPDATE/u.test(sql)) return { rows: [policy] }
    if (/SELECT policy\.provider_key/u.test(sql)) return { rows: [selectedRow()] }
    if (/LOCK TABLE control\.external_platform_provider_price_books/u.test(sql)) return { rows: [] }
    if (/MAX\(version\)/u.test(sql)) return { rows: [{ version: 1 }] }
    if (/INSERT INTO control\.external_platform_provider_price_books/u.test(sql)) {
      publishedPrice = {
        currency: values[2],
        pricingAsOf: values[3],
        monthlyBudgetMinor: values[4],
        monthlySubsidyBudgetMinor: values[5],
        endpointPrices: {},
      }
      return { rows: [] }
    }
    if (/INSERT INTO control\.external_platform_provider_price_book_entries/u.test(sql)) {
      publishedPrice.endpointPrices[values[2]] = values[3]
      return { rows: [] }
    }
    if (/MAX\(release_revision\)/u.test(sql)) return { rows: [{ release_revision: 2 }] }
    if (/INSERT INTO control\.external_platform_operation_releases/u.test(sql)) return { rows: [] }
    if (/UPDATE control\.external_platform_operation_policies/u.test(sql)) {
      policy = {
        control_source: 'database',
        desired_state: values[2],
        canary_consumer_ids: values[3],
        release_revision: values[4],
        revision: policy.revision + 1,
      }
      return { rows: [{ revision: policy.revision }] }
    }
    if (/INSERT INTO control\.external_platform_operation_policy_events/u.test(sql)) {
      eventValues = values
      return { rows: [] }
    }
    throw new Error(`unexpected SQL: ${sql}`)
  }
  const client = { query, release(error) { releasedWith = error } }
  const store = new PostgresExternalPlatformControlStore({
    pool: { connect: async () => client, query },
  })
  const active = await store.updatePolicy('justone', JUSTONE_OPERATION, {
    expectedRevision: 0,
    desiredState: 'active',
    reason: 'Publish reviewed price from Admin',
    priceBook: priceBook(13),
  }, {
    actor: 'source-admin',
    runtime: runtime({ priced: false }),
  })

  assert.equal(active.controlSource, 'database')
  assert.equal(active.effectiveState, 'active')
  assert.equal(active.revision, 1)
  assert.equal(active.release.revision, 2)
  assert.equal(active.priceBook.version, 1)
  assert.equal(active.priceBook.endpointPrices[ENDPOINTS[0]], 13)
  assert.equal(eventValues.at(-1), 'Publish reviewed price from Admin')
  assert.ok(statements.some(({ sql }) => sql === 'BEGIN'))
  assert.ok(statements.some(({ sql }) => sql === 'COMMIT'))
  assert.equal(statements.some(({ sql }) => sql === 'ROLLBACK'), false)
  assert.equal(releasedWith, null)
})

test('pause is CAS-fenced, affects only new admissions and keeps the admitted revision immutable', async () => {
  const store = new MemoryExternalPlatformControlStore()
  const controlRuntime = runtime()
  const consumerId = randomUUID()
  const admitted = await store.authorizeDispatch('justone', JUSTONE_OPERATION, {
    ...controlRuntime,
    consumerId,
    credentialRevision: 0,
  })

  const paused = await store.updatePolicy('justone', JUSTONE_OPERATION, {
    expectedRevision: 0,
    desiredState: 'paused',
    reason: 'Pause new upstream dispatch during incident review',
  }, { runtime: controlRuntime })
  assert.equal(paused.revision, 1)
  assert.equal(paused.effectiveState, 'paused')
  assert.equal(admitted.policyRevision, 0)
  assert.equal(admitted.desiredState, 'active')
  await assert.rejects(
    () => store.authorizeDispatch('justone', JUSTONE_OPERATION, {
      ...controlRuntime,
      consumerId,
      credentialRevision: 0,
    }),
    (error) => error?.code === 'external_platform_operation_paused',
  )
  await assert.rejects(
    () => store.updatePolicy('justone', JUSTONE_OPERATION, {
      expectedRevision: 0,
      desiredState: 'active',
      reason: 'Stale browser write',
    }, { runtime: controlRuntime }),
    (error) => error?.code === 'external_platform_operation_revision_conflict'
      && error.details?.currentRevision === 1,
  )
  assert.equal(store.events.length, 1)
  assert.equal(store.events[0].reason, 'Pause new upstream dispatch during incident review')
})

test('database activation cannot bypass the deployment emergency gate', async () => {
  const store = new MemoryExternalPlatformControlStore()
  const controlRuntime = runtime()
  await store.updatePolicy('justone', JUSTONE_OPERATION, {
    expectedRevision: 0,
    desiredState: 'active',
    reason: 'Make the database policy authoritative',
    priceBook: priceBook(),
  }, { runtime: controlRuntime })
  const closedRuntime = runtime({ contractVerified: false, priced: false })
  const [view] = await store.describeProvider('justone', closedRuntime)
  assert.equal(view.desiredState, 'active')
  assert.equal(view.effectiveState, 'blocked')
  assert.ok(view.blockers.some((entry) => entry.code === 'deployment_gate_closed'))
  await assert.rejects(
    () => store.authorizeDispatch('justone', JUSTONE_OPERATION, {
      ...closedRuntime,
      consumerId: randomUUID(),
      credentialRevision: 1,
    }),
    (error) => error?.code === 'external_platform_operation_blocked',
  )
})

test('database activation cannot bypass an operation-specific deployment gate', async () => {
  const store = new MemoryExternalPlatformControlStore()
  const openRuntime = {
    credentialConfigured: true,
    config: {
      contractVerified: true,
      searchContractVerified: true,
      configurationError: null,
      billing: {
        source: 'unknown',
        currency: null,
        pricingAsOf: null,
        monthlyBudgetMinor: null,
        monthlySubsidyBudgetMinor: null,
        unitCostMinorByEndpoint: {},
      },
    },
  }
  await store.updatePolicy('tikhub', XIAOHONGSHU_SEARCH_OPERATION, {
    expectedRevision: 0,
    desiredState: 'active',
    reason: 'Publish search under database control',
    priceBook: {
      currency: 'CNY',
      pricingAsOf: '2026-09-10T08:00:00.000Z',
      monthlyBudgetMinor: 200_000,
      monthlySubsidyBudgetMinor: 0,
      unitCostMinorByEndpoint: { [TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_KEY]: 9 },
    },
  }, { runtime: openRuntime })

  const operations = await store.describeProvider('tikhub', {
    ...openRuntime,
    config: { ...openRuntime.config, searchContractVerified: false },
  })
  const search = operations.find((operation) => operation.operationKey === XIAOHONGSHU_SEARCH_OPERATION)
  assert.equal(search.desiredState, 'active')
  assert.equal(search.effectiveState, 'blocked')
  assert.ok(search.blockers.some((entry) => entry.code === 'deployment_gate_closed'))
})

test('gateway capability readiness follows database pause and per-consumer canary state', async () => {
  const store = new MemoryExternalPlatformControlStore()
  const allowedConsumerId = randomUUID()
  const otherConsumerId = randomUUID()
  const justOneGateway = new ExternalPlatformGateway({
    usageStore: {},
    platformStore: {},
    adapter: {},
    config: runtime().config,
    operationControlStore: store,
    logger: { warn() {} },
  })
  assert.equal((await justOneGateway.capabilities({ consumerId: allowedConsumerId })).ready, true)
  await store.updatePolicy('justone', JUSTONE_OPERATION, {
    expectedRevision: 0,
    desiredState: 'paused',
    reason: 'Pause capability advertising with dispatch',
  }, { runtime: runtime() })
  assert.equal((await justOneGateway.capabilities({ consumerId: allowedConsumerId })).ready, false)

  const tikHubConfig = {
    contractVerified: true,
    searchContractVerified: true,
    userActivityContractVerified: true,
    configurationError: null,
    searchCanaryConsumerIds: [],
    billing: {
      source: 'manual',
      currency: 'CNY',
      pricingAsOf: '2026-09-10T00:00:00.000Z',
      monthlyBudgetMinor: 100_000,
      monthlySubsidyBudgetMinor: 10_000,
      unitCostMinor: 5,
    },
  }
  await store.updatePolicy('tikhub', XIAOHONGSHU_SEARCH_OPERATION, {
    expectedRevision: 0,
    desiredState: 'canary',
    reason: 'Advertise search only to the admitted canary consumer',
    canaryConsumerIds: [allowedConsumerId],
    priceBook: {
      currency: 'CNY',
      pricingAsOf: '2026-09-10T08:00:00.000Z',
      monthlyBudgetMinor: 100_000,
      monthlySubsidyBudgetMinor: 0,
      unitCostMinorByEndpoint: { [TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_KEY]: 9 },
    },
  }, {
    runtime: { config: tikHubConfig, credentialConfigured: true },
  })
  const tikHubGateway = new TikHubGateway({
    usageStore: {},
    platformStore: {},
    adapter: { async resolveCredential() { return 'tikhub-provider-key' } },
    config: tikHubConfig,
    operationControlStore: store,
    logger: { warn() {} },
  })
  const allowed = await tikHubGateway.capabilities({ consumerId: allowedConsumerId })
  const denied = await tikHubGateway.capabilities({ consumerId: otherConsumerId })
  assert.equal(allowed.operations[XIAOHONGSHU_SEARCH_OPERATION].ready, true)
  assert.equal(allowed.operations[XIAOHONGSHU_POST_OPERATION].ready, true)
  assert.equal(allowed.operations[XIAOHONGSHU_USER_INFO_OPERATION].ready, true)
  assert.equal(allowed.operations[XIAOHONGSHU_CRAWL_OPERATION].ready, true)
  assert.equal(allowed.ready, true)
  assert.equal(denied.operations[XIAOHONGSHU_SEARCH_OPERATION].ready, false)
  assert.equal(denied.ready, false)
})

test('public capability discovery maps TikHub readiness by operation instead of provider-wide', async () => {
  const operationStore = new MemoryExternalPlatformControlStore()
  const usageStore = new MemoryStore()
  const tikHubConfig = {
    contractVerified: true,
    searchContractVerified: true,
    userActivityContractVerified: true,
    configurationError: null,
    searchCanaryConsumerIds: [],
    billing: {
      source: 'manual',
      currency: 'CNY',
      pricingAsOf: '2026-09-10T00:00:00.000Z',
      monthlyBudgetMinor: 100_000,
      monthlySubsidyBudgetMinor: 10_000,
      unitCostMinor: 5,
    },
  }
  const gateway = new TikHubGateway({
    usageStore,
    platformStore: {},
    adapter: { async resolveCredential() { return 'tikhub-provider-key' } },
    config: tikHubConfig,
    operationControlStore: operationStore,
    logger: { warn() {} },
  })
  const service = new HubService({
    store: usageStore,
    adapter: {},
    apiKeyPepper: 'operation-readiness-test-pepper-with-enough-entropy',
    externalPostCapabilities: (options) => gateway.capabilities(options),
    externalSocialSearchEnabled: true,
  })
  const tenant = await service.createTenant({ name: 'Capability Tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Capability Consumer' })
  await service.putPlatformConfiguration('xiaohongshu', {
    tenantId: tenant.id,
    consumerId: consumer.id,
    enabled: true,
  })
  for (const capability of [XIAOHONGSHU_SEARCH_OPERATION, XIAOHONGSHU_POST_OPERATION]) {
    await service.putCapabilityConfiguration(capability, {
      tenantId: tenant.id,
      consumerId: consumer.id,
      enabled: true,
    })
  }
  const key = await service.createApiKey({
    consumerId: consumer.id,
    name: 'Capability Key',
    platforms: ['xiaohongshu'],
    capabilities: [XIAOHONGSHU_SEARCH_OPERATION, XIAOHONGSHU_POST_OPERATION],
  })
  const context = await service.authenticate(key.secret)
  await operationStore.updatePolicy('tikhub', XIAOHONGSHU_SEARCH_OPERATION, {
    expectedRevision: 0,
    desiredState: 'paused',
    reason: 'Search incident while detail remains available',
  }, { runtime: { config: tikHubConfig, credentialConfigured: true } })

  const discovery = await service.capabilities(context)
  const platform = discovery.data.platforms.find((entry) => entry.platform === 'xiaohongshu')
  const byCapability = new Map(discovery.data.capabilities.map((entry) => [entry.capability, entry.ready]))
  assert.equal(platform.search.ready, false)
  assert.equal(platform.postDetail.ready, true)
  assert.equal(byCapability.get(XIAOHONGSHU_SEARCH_OPERATION), false)
  assert.equal(byCapability.get(XIAOHONGSHU_POST_OPERATION), true)
  // A paused upstream must not trap an operator after revoking a grant.
  for (const enabled of [false, true]) {
    const result = await service.putCapabilityConfiguration(XIAOHONGSHU_SEARCH_OPERATION, {
      tenantId: tenant.id,
      consumerId: consumer.id,
      enabled,
    })
    assert.equal(result.enabled, enabled)
  }
  const restored = await service.capabilities(context)
  assert.equal(restored.data.capabilities.find((entry) => entry.capability === XIAOHONGSHU_SEARCH_OPERATION).ready, false)
})

test('shadow never dispatches and canary requires an exact consumer allowlist', async () => {
  const store = new MemoryExternalPlatformControlStore()
  const controlRuntime = runtime()
  const allowed = randomUUID()
  await store.updatePolicy('justone', JUSTONE_OPERATION, {
    expectedRevision: 0,
    desiredState: 'shadow',
    reason: 'Validate the adapter without customer traffic',
  }, { runtime: controlRuntime })
  await assert.rejects(
    () => store.authorizeDispatch('justone', JUSTONE_OPERATION, {
      ...controlRuntime,
      consumerId: allowed,
    }),
    (error) => error?.code === 'external_platform_operation_shadow',
  )
  await assert.rejects(
    () => store.updatePolicy('justone', JUSTONE_OPERATION, {
      expectedRevision: 1,
      desiredState: 'canary',
      reason: 'Missing allowlist must fail',
    }, { runtime: controlRuntime }),
    (error) => error?.code === 'invalid_external_platform_operation_policy',
  )
  await store.updatePolicy('justone', JUSTONE_OPERATION, {
    expectedRevision: 1,
    desiredState: 'canary',
    reason: 'Limit dispatch to the reviewed consumer',
    canaryConsumerIds: [allowed],
    priceBook: priceBook(),
  }, { runtime: controlRuntime })
  await store.authorizeDispatch('justone', JUSTONE_OPERATION, {
    ...controlRuntime,
    consumerId: allowed,
    credentialRevision: 1,
  })
  await assert.rejects(
    () => store.authorizeDispatch('justone', JUSTONE_OPERATION, {
      ...controlRuntime,
      consumerId: randomUUID(),
      credentialRevision: 1,
    }),
    (error) => error?.code === 'external_platform_operation_canary',
  )
})

test('provider call records the policy, release, price-book and credential revisions', async () => {
  const tenantId = randomUUID()
  const consumerId = randomUUID()
  const apiKeyId = randomUUID()
  const usageRequestId = randomUUID()
  const requestFingerprint = 'a'.repeat(64)
  const usageStore = {
    requests: new Map([[usageRequestId, {
      id: usageRequestId,
      status: 'reserved',
      tenantId,
      consumerId,
      apiKeyId,
      fingerprint: requestFingerprint,
      platform: 'ecommerce',
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }]]),
  }
  const platformStore = new MemoryExternalPlatformStore({ usageStore })
  const call = await platformStore.beginProviderCall({
    tenantId,
    consumerId,
    apiKeyId,
    usageRequestId,
    operation: JUSTONE_OPERATION,
    contractVersion: 'mx-insight-hub.ecommerce-products.v1',
    endpointKey: ENDPOINTS[1],
    endpointVersion: 'v1',
    marketplace: 'jd',
    fingerprint: requestFingerprint,
    operationControl: {
      providerKey: 'justone',
      operationKey: JUSTONE_OPERATION,
      policyRevision: 4,
      releaseRevision: 3,
      priceBookVersion: 2,
      credentialRevision: 7,
      desiredState: 'active',
      billing: {},
    },
  })
  assert.equal(call.operationPolicyRevision, 4)
  assert.equal(call.operationReleaseRevision, 3)
  assert.equal(call.providerPriceBookVersion, 2)
  assert.equal(call.providerCredentialRevision, 7)
})

test('Admin policy route is source-admin protected and accepts the versioned policy payload', async () => {
  const source = await readFile(new URL('../../server/app.mjs', import.meta.url), 'utf8')
  assert.match(
    source,
    /external-platforms\/:provider\/operations\/:operation\/policy[\s\S]*?requireSourceAdmin\(principal\)/u,
  )
  assert.match(source, /externalPlatformAdmin\.updateOperationPolicy/u)
  assert.match(source, /readJson\(request, 64 \* 1024\)/u)
})
