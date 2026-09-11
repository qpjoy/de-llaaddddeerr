import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import {
  SOCIAL_ACCOUNT_AUTHORIZATION_PLATFORM,
  SOCIAL_ACCOUNT_PLATFORMS,
  SOCIAL_ACCOUNT_SEARCH_OPERATION,
  socialAccountPlatform,
} from '../../server/contracts/social-accounts.mjs'
import { EXTERNAL_PLATFORM_OPERATION_CATALOG } from '../../server/external-platforms/control-store.mjs'

const PEPPER = 'social-accounts-test-pepper-with-entropy'
const PATH = '/api/v1/data/social/accounts/search'

function config() {
  return {
    token: 'configured',
    configured: true,
    contractVerified: true,
    dispatchEnabled: true,
    configurationError: null,
    timeoutMs: 60_000,
    freshTtlMs: 60_000,
    staleTtlMs: 86_400_000,
    unknownFingerprintCooldownMs: 900_000,
    maxConcurrency: 32,
    maxConsumerConcurrency: 8,
    maxRequestsPerMinute: 50,
    circuitFailureThreshold: 3,
    circuitOpenMs: 60_000,
    billing: {
      source: 'manual',
      currency: 'CNY',
      pricingAsOf: '2026-09-01T00:00:00.000Z',
      freeDailyCalls: null,
      monthlyBudgetMinor: 100_000,
      monthlySubsidyBudgetMinor: 100_000,
      unitCostMinorByEndpoint: {
        'xiaohongshu.account-search.v1': 107,
        'douyin.account-search.v1': 107,
      },
    },
  }
}

function accountResult(body) {
  const account = {
    id: 'u1', platform: body.platform, userId: 'u1', secUid: null,
    name: '示例账号', handle: 'rid', fans: 1164, bio: '简介',
    official: true, avatar: 'https://example.invalid/a.jpg', profileUrl: null,
  }
  return {
    publicBody: {
      contractVersion: 'mx-insight-hub.social-accounts.v1',
      data: {
        accounts: [account],
        page: { page: 1, returnedCount: 1, discardedCount: 0, duplicateCount: 0, hasMore: null, nextPage: 2 },
      },
      meta: { capturedAt: new Date().toISOString() },
    },
    items: [account],
    records: [{ externalId: `${body.platform}:u1` }],
    archiveObjects: [],
  }
}

async function fixture({ adapter, capabilities = [SOCIAL_ACCOUNT_SEARCH_OPERATION] } = {}) {
  const usageStore = new MemoryStore()
  const hub = new HubService({ store: usageStore, adapter: {}, apiKeyPepper: PEPPER })
  const tenant = await hub.createTenant({ name: 'Tenant A' })
  const consumer = await hub.createConsumer({ tenantId: tenant.id, name: 'Consumer A' })
  await usageStore.setPlatformGrant(consumer.id, SOCIAL_ACCOUNT_AUTHORIZATION_PLATFORM, true)
  for (const capability of capabilities) {
    await hub.putCapabilityConfiguration(capability, {
      tenantId: tenant.id, consumerId: consumer.id, enabled: true,
    })
  }
  const key = await hub.createApiKey({
    consumerId: consumer.id,
    name: 'Key A',
    platforms: [SOCIAL_ACCOUNT_AUTHORIZATION_PLATFORM],
    capabilities,
  })
  await usageStore.putPolicy({
    tenantId: tenant.id,
    consumerId: consumer.id,
    platform: SOCIAL_ACCOUNT_AUTHORIZATION_PLATFORM,
    maxRequests: 1_000,
    windowSeconds: 3_600,
    maxPageSize: 100,
  })
  const context = await hub.authenticate(key.secret)
  // A platform store is scoped to one authorization domain by construction,
  // which is why account search runs on its own store instance in production.
  const platformStore = new MemoryExternalPlatformStore({
    usageStore,
    authorizationPlatform: SOCIAL_ACCOUNT_AUTHORIZATION_PLATFORM,
    circuitFailureThreshold: 3,
    circuitOpenMs: 60_000,
  })
  const gateway = new ExternalPlatformGateway({
    usageStore, platformStore, adapter, config: config(), apiKeyPepper: PEPPER,
    reservationLeaseMs: 150_000, logger: { warn() {} },
  })
  return { usageStore, platformStore, gateway, context, consumer }
}

test('account search is metered on the social domain, not on ecommerce', async () => {
  let dispatched = null
  const state = await fixture({
    adapter: {
      async searchAccounts(body) {
        dispatched = body
        return accountResult(body)
      },
    },
  })

  const result = await state.gateway.searchAccounts(state.context, {
    body: { platform: 'xiaohongshu', keyword: '腾讯电子签' },
    idempotencyKey: 'accounts-live-01',
    path: PATH,
  })

  assert.equal(result.sourceMode, 'live')
  assert.equal(result.body.data.accounts[0].userId, 'u1')
  assert.equal(result.body.meta.reason.code, 'live')
  assert.deepEqual(dispatched, { platform: 'xiaohongshu', keyword: '腾讯电子签' })

  // Usage is reserved against the social domain, so account traffic neither
  // consumes nor is limited by the ecommerce quota.
  const request = state.usageStore.requests.get(result.requestId)
  assert.equal(request.platform, SOCIAL_ACCOUNT_AUTHORIZATION_PLATFORM)
  assert.ok(
    JSON.stringify(request).includes(SOCIAL_ACCOUNT_SEARCH_OPERATION),
    'the reserved usage request records the account-search operation',
  )
})

test('an ecommerce-only key cannot reach account search', async () => {
  const state = await fixture({
    adapter: { async searchAccounts() { assert.fail('must not dispatch') } },
    capabilities: ['ecommerce.products.search'],
  })

  await assert.rejects(
    () => state.gateway.searchAccounts(state.context, {
      body: { platform: 'xiaohongshu', keyword: 'x' },
      idempotencyKey: 'accounts-denied-01',
      path: PATH,
    }),
    (error) => error.code === 'capability_not_granted',
  )
})

test('a caller mistake is a 400, not an internal error', async () => {
  const state = await fixture({
    adapter: { async searchAccounts() { assert.fail('must not dispatch') } },
  })

  for (const [body, code] of [
    [{ platform: 'bilibili', keyword: 'x' }, 'unsupported_platform'],
    [{ platform: 'weibo' }, 'invalid_keyword'],
    [{ platform: 'weibo', keyword: 'x', token: 'leak' }, 'unsupported_request_field'],
  ]) {
    await assert.rejects(
      () => state.gateway.searchAccounts(state.context, {
        body, idempotencyKey: 'accounts-bad-01', path: PATH,
      }),
      (error) => error.status === 400 && error.code === code,
      `${code} must surface as a 400`,
    )
  }
})

test('the same keyword and page reuse one snapshot; a different page does not', async () => {
  let calls = 0
  const state = await fixture({
    adapter: {
      async searchAccounts(body) {
        calls += 1
        return accountResult(body)
      },
    },
  })
  const body = { platform: 'xiaohongshu', keyword: '示例' }

  await state.gateway.searchAccounts(state.context, {
    body, idempotencyKey: 'accounts-page1-a', path: PATH,
  })
  const cached = await state.gateway.searchAccounts(state.context, {
    body: { ...body, deliveryMode: 'cache_first' },
    idempotencyKey: 'accounts-page1-b',
    path: PATH,
  })
  assert.equal(cached.sourceMode, 'fresh_cache')
  assert.equal(calls, 1)

  await state.gateway.searchAccounts(state.context, {
    body: { ...body, page: 2 }, idempotencyKey: 'accounts-page2-a', path: PATH,
  })
  assert.equal(calls, 2, 'a different page is a different logical request')
})

test('every platform is served by a provider that actually released its endpoint', () => {
  for (const platform of SOCIAL_ACCOUNT_PLATFORMS) {
    const descriptor = socialAccountPlatform(platform)
    const operation = EXTERNAL_PLATFORM_OPERATION_CATALOG[descriptor.providerKey]
      ?.find((entry) => entry.operationKey === SOCIAL_ACCOUNT_SEARCH_OPERATION)

    assert.ok(operation, `${descriptor.providerKey} must release ${SOCIAL_ACCOUNT_SEARCH_OPERATION}`)
    assert.ok(
      operation.endpointKeys.includes(descriptor.endpointKey),
      `${descriptor.endpointKey} must be priced under ${descriptor.providerKey}`,
    )
  }
})

test("one provider's endpoints never appear under the other", () => {
  const byProvider = Object.fromEntries(['justone', 'tikhub'].map((providerKey) => [
    providerKey,
    new Set(EXTERNAL_PLATFORM_OPERATION_CATALOG[providerKey]
      .find((entry) => entry.operationKey === SOCIAL_ACCOUNT_SEARCH_OPERATION)
      .endpointKeys),
  ]))

  assert.deepEqual([...byProvider.justone].sort(), [
    'douyin.account-search.v1', 'xiaohongshu.account-search.v1',
  ])
  assert.deepEqual([...byProvider.tikhub].sort(), [
    'kuaishou.account-search.v1', 'weibo.account-search.v1',
  ])
  // Blocking one vendor must not be able to silence the other's platforms.
  for (const endpointKey of byProvider.justone) {
    assert.equal(byProvider.tikhub.has(endpointKey), false)
  }
})

test('the gateway dispatches under whichever provider key it was built for', async () => {
  let dispatched = null
  const state = await fixture({
    adapter: {
      async searchAccounts(body) {
        dispatched = body
        return accountResult(body)
      },
    },
  })

  // The JustOne-scoped instance built by `fixture` serves its own platforms.
  assert.equal(state.gateway.providerKey, 'justone')
  const result = await state.gateway.searchAccounts(state.context, {
    body: { platform: 'douyin', keyword: '示例' },
    idempotencyKey: 'accounts-douyin-01',
    path: PATH,
  })
  assert.equal(result.sourceMode, 'live')
  assert.equal(dispatched.platform, 'douyin')

  // A second instance is the whole TikHub integration: same orchestration,
  // different provider key, adapter and credential.
  const tikhub = new ExternalPlatformGateway({
    usageStore: state.usageStore,
    platformStore: state.platformStore,
    adapter: { async searchAccounts(body) { return accountResult(body) } },
    config: config(),
    providerKey: 'tikhub',
    apiKeyPepper: PEPPER,
    reservationLeaseMs: 150_000,
    logger: { warn() {} },
  })
  assert.equal(tikhub.providerKey, 'tikhub')
})
