import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import {
  SOCIAL_ACCOUNT_AUTHORIZATION_PLATFORM,
  SOCIAL_ACCOUNT_PLATFORMS,
  SOCIAL_ACCOUNT_SEARCH_OPERATION,
  socialAccountPlatform,
} from '../../server/contracts/social-accounts.mjs'

const PEPPER = 'social-accounts-http-pepper-with-entropy'
const PATH = '/api/v1/data/social/accounts/search'

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return `http://127.0.0.1:${port}`
}

function stubGateway(providerKey, seen) {
  return {
    providerKey,
    async searchAccounts(context, { body }) {
      seen.push({ providerKey, platform: body.platform })
      return {
        status: 200,
        replay: false,
        sourceMode: 'live',
        requestId: '11111111-1111-4111-8111-111111111111',
        capturedAt: new Date().toISOString(),
        staleAgeSeconds: 0,
        body: {
          contractVersion: 'mx-insight-hub.social-accounts.v1',
          data: { accounts: [], page: { page: 1, returnedCount: 0, hasMore: false, nextPage: null } },
          meta: { sourceMode: 'live', reason: { code: 'live', scope: 'upstream' } },
        },
      }
    },
  }
}

async function harness() {
  const usageStore = new MemoryStore()
  const service = new HubService({ store: usageStore, adapter: {}, apiKeyPepper: PEPPER })
  const tenant = await service.createTenant({ name: 'T' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'C' })
  await usageStore.setPlatformGrant(consumer.id, SOCIAL_ACCOUNT_AUTHORIZATION_PLATFORM, true)
  await service.putCapabilityConfiguration(SOCIAL_ACCOUNT_SEARCH_OPERATION, {
    tenantId: tenant.id, consumerId: consumer.id, enabled: true,
  })
  const apiKey = await service.createApiKey({
    consumerId: consumer.id,
    name: 'K',
    platforms: [SOCIAL_ACCOUNT_AUTHORIZATION_PLATFORM],
    capabilities: [SOCIAL_ACCOUNT_SEARCH_OPERATION],
  })
  await usageStore.putPolicy({
    tenantId: tenant.id,
    consumerId: consumer.id,
    platform: SOCIAL_ACCOUNT_AUTHORIZATION_PLATFORM,
    maxRequests: 1_000,
    windowSeconds: 3_600,
    maxPageSize: 100,
  })

  const seen = []
  const app = createApp({
    service,
    store: usageStore,
    adapter: {},
    adminToken: null,
    socialAccountGateway: stubGateway('justone', seen),
    socialAccountTikHubGateway: stubGateway('tikhub', seen),
    listenerMode: 'public',
    logger: { error() {} },
  })
  const server = createServer(app)
  const baseUrl = await listen(server)
  return {
    seen,
    server,
    async call(body) {
      const response = await fetch(`${baseUrl}${PATH}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey.secret}`,
          'content-type': 'application/json',
          'idempotency-key': `http-${body.platform || 'none'}-000001`,
        },
        body: JSON.stringify(body),
      })
      return { response, payload: await response.json() }
    },
  }
}

test('each platform reaches the provider its contract declares', async (t) => {
  const state = await harness()
  t.after(() => state.server.close())

  for (const platform of SOCIAL_ACCOUNT_PLATFORMS) {
    const { response } = await state.call({ platform, keyword: '腾讯电子签' })
    assert.equal(response.status, 200, `${platform} must dispatch`)
  }

  // The route must not send a platform to the wrong vendor's gateway, which
  // would spend the wrong credential and bill the wrong cost ledger.
  assert.deepEqual(state.seen, SOCIAL_ACCOUNT_PLATFORMS.map((platform) => ({
    providerKey: socialAccountPlatform(platform).providerKey,
    platform,
  })))
  assert.deepEqual(
    [...new Set(state.seen.map((entry) => entry.providerKey))].sort(),
    ['justone', 'tikhub'],
    'both vendors are actually exercised',
  )
})

test('an unknown platform is rejected before any gateway is chosen', async (t) => {
  const state = await harness()
  t.after(() => state.server.close())

  const { response, payload } = await state.call({ platform: 'bilibili', keyword: 'x' })
  assert.equal(response.status, 400)
  assert.equal(payload.error.code, 'unsupported_platform')
  assert.deepEqual(state.seen, [], 'no gateway was invoked')
})

test('the reason code travels in the response header', async (t) => {
  const state = await harness()
  t.after(() => state.server.close())

  const { response } = await state.call({ platform: 'weibo', keyword: 'x' })
  assert.equal(response.headers.get('x-mx-insight-reason'), 'live')
  assert.equal(response.headers.get('x-mx-insight-source-mode'), 'live')
})
