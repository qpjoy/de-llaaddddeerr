import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import {
  loadConfig,
  preflightJustOneConfig,
  preflightTikHubConfig,
} from '../../server/config.mjs'
import { createRuntime } from '../../server/index.mjs'

const BASE = {
  MX_INSIGHT_LISTENER_MODE: 'public',
  MX_INSIGHT_STORE: 'memory',
  MX_INSIGHT_API_KEY_PEPPER: 'external-platform-config-test-pepper-with-entropy',
  MX_INSIGHT_JUSTONE_TOKEN: 'provider-token',
}

async function runtimeFor(environment) {
  return createRuntime(loadConfig(environment))
}

async function closeRuntime(runtime) {
  runtime.agent.close()
  await runtime.store.close()
  await runtime.pool?.end()
}

test('runtime constructs the paid adapter only after explicit contract verification', async () => {
  const awaiting = await runtimeFor(BASE)
  try {
    assert.equal(awaiting.justOneAdapter, null)
    assert.equal((await awaiting.externalPlatformGateway.capabilities()).ready, false)
  } finally {
    await closeRuntime(awaiting)
  }

  const verified = await runtimeFor({
    ...BASE,
    MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED: '1',
    MX_INSIGHT_JUSTONE_UNKNOWN_FINGERPRINT_COOLDOWN_MS: '12345',
  })
  try {
    assert.ok(verified.justOneAdapter)
    assert.equal((await verified.externalPlatformGateway.capabilities()).ready, true)
    assert.equal(verified.externalPlatformStore.uncertainCooldownMs, 12345)
  } finally {
    await closeRuntime(verified)
  }
})

test('Xiaohongshu search cutover requires its own gate after the shared TikHub contract gate', async () => {
  const detailOnly = await runtimeFor({
    ...BASE,
    MX_INSIGHT_TIKHUB_API_KEY: 'tikhub-provider-key',
    MX_INSIGHT_TIKHUB_CONTRACT_VERIFIED: '1',
  })
  try {
    assert.ok(detailOnly.tikHubAdapter)
    assert.equal(detailOnly.service.externalSocialSearchEnabled, false)
  } finally {
    await closeRuntime(detailOnly)
  }

  const searchEnabled = await runtimeFor({
    ...BASE,
    MX_INSIGHT_TIKHUB_API_KEY: 'tikhub-provider-key',
    MX_INSIGHT_TIKHUB_CONTRACT_VERIFIED: '1',
    MX_INSIGHT_TIKHUB_SEARCH_CONTRACT_VERIFIED: '1',
  })
  try {
    assert.ok(searchEnabled.tikHubAdapter)
    assert.equal(searchEnabled.service.externalSocialSearchEnabled, true)
  } finally {
    await closeRuntime(searchEnabled)
  }

  assert.throws(
    () => preflightTikHubConfig({
      ...BASE,
      MX_INSIGHT_TIKHUB_SEARCH_CONTRACT_VERIFIED: '1',
    }),
    (error) => error?.code === 'invalid_configuration'
      && /requires MX_INSIGHT_TIKHUB_CONTRACT_VERIFIED=1/u.test(error.message),
  )
})

test('verified public runtime hot-loads a database-only credential without restart', async () => {
  const runtime = await runtimeFor({
    ...BASE,
    MX_INSIGHT_JUSTONE_TOKEN: '',
    MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED: '1',
  })
  try {
    assert.equal(runtime.justOneAdapter != null, true)
    assert.equal((await runtime.externalPlatformGateway.capabilities()).ready, false)

    const first = await runtime.externalPlatformCredentialStore.updateCredential('justone', {
      apiKey: 'database-token-one',
      expectedRevision: 0,
    })
    assert.equal(first.revision, 1)
    assert.equal((await runtime.externalPlatformGateway.capabilities()).ready, true)
    assert.equal(await runtime.justOneAdapter.resolveCredential(), 'database-token-one')

    await runtime.externalPlatformCredentialStore.updateCredential('justone', {
      apiKey: 'database-token-two',
      expectedRevision: first.revision,
    })
    assert.equal(await runtime.justOneAdapter.resolveCredential(), 'database-token-two')
  } finally {
    await closeRuntime(runtime)
  }
})

test('admin runtime never constructs a credentialed JustOne adapter', async () => {
  const runtime = await runtimeFor({
    ...BASE,
    MX_INSIGHT_LISTENER_MODE: 'admin',
    MX_INSIGHT_ADMIN_TOKEN: 'admin-token-with-enough-entropy',
    MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED: '1',
  })
  try {
    assert.equal(runtime.justOneAdapter, null)
    assert.equal((await runtime.externalPlatformGateway.capabilities()).ready, false)
  } finally {
    await closeRuntime(runtime)
  }
})

test('admin session discovers the validated runtime public API origin', async () => {
  const adminToken = 'admin-token-with-enough-entropy'
  const runtime = await runtimeFor({
    ...BASE,
    MX_INSIGHT_LISTENER_MODE: 'admin',
    MX_INSIGHT_ADMIN_TOKEN: adminToken,
    MX_INSIGHT_PUBLIC_URL: 'https://Gate.Example.Test:443/',
  })
  const server = createServer(runtime.app)
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/internal/v1/admin/session`,
      { headers: { 'x-mx-insight-admin-token': adminToken } },
    )
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.data.publicApiBaseUrl, 'https://gate.example.test')
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve))
    await closeRuntime(runtime)
  }
})

test('verified database-only configuration enforces the provider timeout lease margin', async () => {
  const environment = {
    ...BASE,
    MX_INSIGHT_JUSTONE_TOKEN: '',
    MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED: '1',
    MX_INSIGHT_RESERVATION_LEASE_MS: '149999',
  }
  const config = loadConfig(environment)
  assert.equal(config.justOne.configurationError?.code, 'invalid_configuration')
  assert.match(config.justOne.configurationError?.message, /contract is verified/u)
  assert.throws(
    () => preflightJustOneConfig(environment),
    (error) => error?.code === 'invalid_configuration'
      && /plus 30000/u.test(error.message),
  )
})

test('JustOne defaults admit current consumer bursts while preserving a bounded provider budget', () => {
  const config = loadConfig(BASE)
  assert.equal(config.justOne.maxConcurrency, 32)
  assert.equal(config.justOne.maxConsumerConcurrency, 8)
  assert.equal(config.justOne.maxRequestsPerMinute, 90)
  assert.equal(config.tikHub.maxRequestsPerMinute, 120)
  assert.equal(config.tikHub.searchFreshTtlMs, 300_000)
  assert.equal(config.tikHub.searchStaleTtlMs, 86_400_000)
  assert.equal(config.tikHub.searchMaxEnrichItems, 20)
  assert.equal(config.tikHub.searchEnrichConcurrency, 2)
  assert.deepEqual(config.tikHub.searchCanaryConsumerIds, [])
})

test('TikHub search canary consumer IDs are normalized, deduplicated and fail closed', () => {
  const first = '675d277d-0000-4000-8000-000000000655'
  const second = 'a9ed1c90-0000-4000-8000-0000001001ec'
  const configured = loadConfig({
    ...BASE,
    MX_INSIGHT_TIKHUB_SEARCH_CANARY_CONSUMER_IDS: ` ${first.toUpperCase()}, ${second},${first} `,
  })
  assert.deepEqual(configured.tikHub.searchCanaryConsumerIds, [first, second])

  for (const value of [',', `${first},`, 'not-a-consumer-uuid']) {
    assert.throws(
      () => preflightTikHubConfig({
        ...BASE,
        MX_INSIGHT_TIKHUB_SEARCH_CANARY_CONSUMER_IDS: value,
      }),
      (error) => error?.code === 'invalid_configuration'
        && /comma-separated list of consumer UUIDs/u.test(error.message),
    )
  }

  const invalid = loadConfig({
    ...BASE,
    MX_INSIGHT_TIKHUB_CONTRACT_VERIFIED: '1',
    MX_INSIGHT_TIKHUB_SEARCH_CONTRACT_VERIFIED: '1',
    MX_INSIGHT_TIKHUB_SEARCH_CANARY_CONSUMER_IDS: ',',
  })
  assert.equal(invalid.tikHub.dispatchEnabled, false)
  assert.equal(invalid.tikHub.configurationError?.code, 'invalid_configuration')
  assert.deepEqual(invalid.tikHub.searchCanaryConsumerIds, [])
})

test('TikHub search quality controls are bounded and stale retention cannot precede freshness', () => {
  assert.equal(loadConfig({
    ...BASE,
    MX_INSIGHT_TIKHUB_SEARCH_MAX_ENRICH_ITEMS: '0',
  }).tikHub.searchMaxEnrichItems, 0)
  for (const [name, value, pattern] of [
    ['MX_INSIGHT_TIKHUB_SEARCH_MAX_ENRICH_ITEMS', '21', /must not exceed 20/u],
    ['MX_INSIGHT_TIKHUB_SEARCH_ENRICH_CONCURRENCY', '6', /must not exceed 5/u],
  ]) {
    assert.throws(
      () => preflightTikHubConfig({ ...BASE, [name]: value }),
      (error) => error?.code === 'invalid_configuration' && pattern.test(error.message),
    )
  }
  assert.throws(
    () => preflightTikHubConfig({
      ...BASE,
      MX_INSIGHT_TIKHUB_SEARCH_FRESH_TTL_MS: '2000',
      MX_INSIGHT_TIKHUB_SEARCH_STALE_TTL_MS: '1000',
    }),
    (error) => error?.code === 'invalid_configuration'
      && /search stale TTL must be greater than or equal to search fresh TTL/u.test(error.message),
  )
})

test('TikHub billing supports endpoint prices while retaining the legacy unit-cost fallback', () => {
  const billing = loadConfig({
    ...BASE,
    MX_INSIGHT_TIKHUB_BILLING_JSON: JSON.stringify({
      source: 'manual',
      currency: 'CNY',
      pricingAsOf: '2026-09-08T00:00:00Z',
      unitCostMinor: 5,
      unitCostMinorByEndpoint: {
        'xiaohongshu.app-v2.search-notes.v1': 7,
        'xiaohongshu.image-note-detail.v2': 11,
      },
      monthlyBudgetMinor: 100_000,
    }),
  }).tikHub.billing

  assert.equal(billing.unitCostMinor, 5)
  assert.deepEqual(billing.unitCostMinorByEndpoint, {
    'xiaohongshu.app-v2.search-notes.v1': 7,
    'xiaohongshu.image-note-detail.v2': 11,
  })
  assert.equal(billing.monthlyBudgetMinor, 100_000)

  for (const unitCostMinorByEndpoint of [
    [],
    { 'Not A Stable Endpoint': 1 },
    { 'xiaohongshu.image-note-detail.v2': -1 },
  ]) {
    assert.throws(
      () => preflightTikHubConfig({
        ...BASE,
        MX_INSIGHT_TIKHUB_BILLING_JSON: JSON.stringify({
          source: 'manual',
          currency: 'CNY',
          pricingAsOf: '2026-09-08T00:00:00Z',
          unitCostMinorByEndpoint,
        }),
      }),
      (error) => error?.code === 'invalid_configuration',
    )
  }
})

test('provider request budgets reject values outside the PostgreSQL integer contract', () => {
  for (const [name, preflight] of [
    ['MX_INSIGHT_JUSTONE_MAX_REQUESTS_PER_MINUTE', preflightJustOneConfig],
    ['MX_INSIGHT_TIKHUB_MAX_REQUESTS_PER_MINUTE', preflightTikHubConfig],
  ]) {
    assert.throws(
      () => preflight({ ...BASE, [name]: '2147483648' }),
      (error) => error?.code === 'invalid_configuration' && /must not exceed 2147483647/u.test(error.message),
    )
  }
})

test('JustOne rejects a per-consumer concurrency budget above the global budget', () => {
  const environment = {
    ...BASE,
    MX_INSIGHT_JUSTONE_MAX_CONCURRENCY: '4',
    MX_INSIGHT_JUSTONE_MAX_CONSUMER_CONCURRENCY: '8',
  }
  const config = loadConfig(environment)
  assert.equal(config.justOne.dispatchEnabled, false)
  assert.equal(config.justOne.configurationError?.code, 'invalid_configuration')
  assert.throws(
    () => preflightJustOneConfig(environment),
    (error) => error?.code === 'invalid_configuration'
      && /must not exceed/u.test(error.message),
  )
})

test('bad optional-provider configuration keeps unrelated runtime services available', async () => {
  const runtime = await runtimeFor({
    ...BASE,
    MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED: '1',
    MX_INSIGHT_JUSTONE_BILLING_JSON: '{',
  })
  try {
    assert.equal(runtime.justOneAdapter, null)
    const publicCapabilities = await runtime.externalPlatformGateway.capabilities()
    assert.equal(publicCapabilities.ready, false)
    assert.equal(Object.hasOwn(publicCapabilities, 'configurationError'), false)
    assert.equal(runtime.service != null, true)
    assert.equal(runtime.identity != null, true)
  } finally {
    await closeRuntime(runtime)
  }
})

test('an oversized provider token fails closed without preventing Hub startup', async () => {
  const environment = {
    ...BASE,
    MX_INSIGHT_JUSTONE_TOKEN: 'x'.repeat(4_097),
    MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED: '1',
  }
  const config = loadConfig(environment)
  assert.equal(config.justOne.dispatchEnabled, false)
  assert.equal(config.justOne.token, null)
  assert.equal(config.justOne.configurationError?.code, 'invalid_configuration')
  assert.match(config.justOne.configurationError?.message, /must not exceed 4096/u)
  assert.throws(
    () => preflightJustOneConfig(environment),
    (error) => error?.code === 'invalid_configuration',
  )

  const runtime = await createRuntime(config)
  try {
    assert.equal(runtime.justOneAdapter, null)
    assert.equal(runtime.service != null, true)
    assert.equal(runtime.identity != null, true)
  } finally {
    await closeRuntime(runtime)
  }
})
