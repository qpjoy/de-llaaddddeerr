import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadConfig, preflightJustOneConfig } from '../../server/config.mjs'
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
