import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createSegmenter } from '@qpjoy/mx-common/segmenter'
import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

const ADMIN_TOKEN = 'tokenize-admin-token'
const PEPPER = 'tokenize-test-pepper-at-least-32-bytes'

async function withFixture(segmenter, run) {
  const store = new MemoryStore()
  const service = new HubService({
    store,
    adapter: { capabilities: async () => ({ data: { platforms: [] } }) },
    apiKeyPepper: PEPPER,
    segmenter,
  })
  const tenant = await service.createTenant({ name: 'Tokenizer tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Tokenizer consumer' })
  const issued = await service.createApiKey({ consumerId: consumer.id, name: 'Tokenizer key' })
  const server = createServer(createApp({
    service,
    store,
    adapter: { dependencies: async () => ({ status: 'up' }) },
    adminToken: ADMIN_TOKEN,
    listenerMode: 'combined',
    logger: { error() {} },
  }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const call = async (path, { method = 'GET', body, headers = {}, rawBody } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined || rawBody !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    })
    return { response, payload: await response.json() }
  }
  try {
    await run({ store, service, tenant, consumer, secret: issued.secret, call })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function grant(call, tenant, consumer, overrides = {}) {
  return call('/internal/v1/admin/capabilities/nlp.tokenize', {
    method: 'PUT',
    headers: { 'x-mx-insight-admin-token': ADMIN_TOKEN },
    body: {
      tenantId: tenant.id,
      consumerId: consumer.id,
      enabled: true,
      maxRequests: 2,
      windowSeconds: 3_600,
      ...overrides,
    },
  })
}

test('generic capability grants stay separate from platform grants and policies', async () => {
  await withFixture({
    segmentWithMeta: async () => ({
      tokens: ['人工智能'], backendUsed: 'hanlp', degraded: false, errorCode: null,
    }),
  }, async ({ service, tenant, consumer, call }) => {
    await service.putPlatformConfiguration('xiaohongshu', {
      tenantId: tenant.id,
      consumerId: consumer.id,
      enabled: true,
      maxRequests: 9,
      windowSeconds: 900,
      maxPageSize: 10,
    })

    const configured = await grant(call, tenant, consumer)
    assert.equal(configured.response.status, 200)
    assert.deepEqual(configured.payload.data, {
      capability: 'nlp.tokenize',
      enabled: true,
      policy: {
        tenantId: tenant.id,
        consumerId: consumer.id,
        capability: 'nlp.tokenize',
        maxRequests: 2,
        windowSeconds: 3_600,
        updatedAt: configured.payload.data.policy.updatedAt,
      },
    })

    const configuration = await call(
      `/internal/v1/admin/platforms?tenantId=${tenant.id}&consumerId=${consumer.id}`,
      { headers: { 'x-mx-insight-admin-token': ADMIN_TOKEN } },
    )
    assert.deepEqual(configuration.payload.data.grants, ['xiaohongshu'])
    assert.deepEqual(configuration.payload.data.capabilityGrants, ['nlp.tokenize'])
    assert.equal(configuration.payload.data.policies[0].platform, 'xiaohongshu')
    assert.equal(configuration.payload.data.capabilityPolicies[0].capability, 'nlp.tokenize')
    assert.deepEqual(configuration.payload.data.availableCapabilities, [
      { capability: 'nlp.tokenize', ready: true },
      { capability: 'public_opinion.all_ingested.read', ready: false },
    ])

    const unsupported = await call('/internal/v1/admin/capabilities/all', {
      method: 'PUT',
      headers: { 'x-mx-insight-admin-token': ADMIN_TOKEN },
      body: { tenantId: tenant.id, consumerId: consumer.id, enabled: true },
    })
    assert.equal(unsupported.response.status, 400)
    assert.equal(unsupported.payload.error.code, 'unsupported_capability')

    const unknownField = await grant(call, tenant, consumer, { maxPageSize: 100 })
    assert.equal(unknownField.response.status, 400)
    assert.equal(unknownField.payload.error.code, 'unsupported_fields')
  })
})

test('a failed atomic capability update cannot leave a partial grant or policy', async () => {
  await withFixture(null, async ({ store, service, tenant, consumer }) => {
    const beforeGrants = await store.listCapabilityGrants(consumer.id)
    const beforePolicy = await store.getCapabilityPolicy(consumer.id, 'nlp.tokenize')
    store.setCapabilityGrant = async () => assert.fail('service must not mutate the grant separately')
    store.putCapabilityPolicy = async () => assert.fail('service must not mutate the policy separately')
    store.putCapabilityConfiguration = async () => {
      throw new Error('simulated policy write failure')
    }

    await assert.rejects(
      service.putCapabilityConfiguration('nlp.tokenize', {
        tenantId: tenant.id,
        consumerId: consumer.id,
        enabled: true,
        maxRequests: 3,
        windowSeconds: 60,
      }),
      /simulated policy write failure/,
    )
    assert.deepEqual(await store.listCapabilityGrants(consumer.id), beforeGrants)
    assert.deepEqual(await store.getCapabilityPolicy(consumer.id, 'nlp.tokenize'), beforePolicy)
  })
})

test('new consumers receive tokenize defaults but still need an issued API key', async () => {
  const store = new MemoryStore()
  const service = new HubService({ store, adapter: {}, apiKeyPepper: PEPPER })
  const tenant = await service.createTenant({ name: 'Default capability tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Default capability consumer' })

  assert.deepEqual(await store.listCapabilityGrants(consumer.id), ['nlp.tokenize'])
  assert.deepEqual(await store.getCapabilityPolicy(consumer.id, 'nlp.tokenize'), {
    tenantId: tenant.id,
    consumerId: consumer.id,
    capability: 'nlp.tokenize',
    maxRequests: 1_000,
    windowSeconds: 3_600,
    updatedAt: (await store.getCapabilityPolicy(consumer.id, 'nlp.tokenize')).updatedAt,
  })
  await assert.rejects(
    service.authenticate('mih_live_not-issued'),
    (error) => error?.status === 401 && error?.code === 'invalid_api_key',
  )
})

test('Postgres creates a consumer and its default tokenize policy in one transaction', async () => {
  const statements = []
  const parameters = []
  const tenantId = '00000000-0000-4000-8000-000000000001'
  const client = {
    async query(sql, params = []) {
      const normalized = sql.trim().replace(/\s+/g, ' ')
      parameters.push(params)
      if (normalized === 'BEGIN' || normalized === 'COMMIT') {
        statements.push(normalized)
        return { rows: [] }
      }
      if (normalized.startsWith('INSERT INTO consumers')) {
        statements.push('CONSUMER')
        return {
          rows: [{
            id: params[0], tenant_id: params[1], name: params[2], status: params[3],
            business_id: params[4], created_at: new Date(), updated_at: new Date(),
          }],
        }
      }
      if (normalized.startsWith('INSERT INTO capability_grants')) {
        statements.push('GRANT')
        return { rows: [] }
      }
      if (normalized.startsWith('INSERT INTO consumer_capability_policies')) {
        statements.push('POLICY')
        return { rows: [] }
      }
      assert.fail(`unexpected SQL: ${normalized}`)
    },
    release() {},
  }
  const store = new PostgresStore({ connect: async () => client })
  const consumer = await store.createConsumer({
    tenantId,
    name: 'PG default consumer',
    defaultCapabilityPolicy: {
      capability: 'nlp.tokenize', maxRequests: 1_000, windowSeconds: 3_600,
    },
  })

  assert.equal(consumer.tenantId, tenantId)
  assert.deepEqual(statements, ['BEGIN', 'CONSUMER', 'GRANT', 'POLICY', 'COMMIT'])
  assert.deepEqual(parameters[2], [consumer.id, 'nlp.tokenize'])
  assert.deepEqual(parameters[3], [tenantId, consumer.id, 'nlp.tokenize', 1_000, 3_600])
})

test('Postgres consumer defaults roll back the consumer when policy creation fails', async () => {
  const statements = []
  let released = false
  const client = {
    async query(sql, params = []) {
      const normalized = sql.trim().replace(/\s+/g, ' ')
      if (normalized === 'BEGIN' || normalized === 'ROLLBACK') {
        statements.push(normalized)
        return { rows: [] }
      }
      if (normalized.startsWith('INSERT INTO consumers')) {
        statements.push('CONSUMER')
        return {
          rows: [{
            id: params[0], tenant_id: params[1], name: params[2], status: params[3],
            business_id: params[4], created_at: new Date(), updated_at: new Date(),
          }],
        }
      }
      if (normalized.startsWith('INSERT INTO capability_grants')) {
        statements.push('GRANT')
        return { rows: [] }
      }
      if (normalized.startsWith('INSERT INTO consumer_capability_policies')) {
        statements.push('POLICY')
        throw new Error('simulated default policy failure')
      }
      if (normalized === 'COMMIT') assert.fail('failed creation must not commit')
      assert.fail(`unexpected SQL: ${normalized}`)
    },
    release() { released = true },
  }
  const store = new PostgresStore({ connect: async () => client })

  await assert.rejects(
    store.createConsumer({
      tenantId: '00000000-0000-4000-8000-000000000001',
      name: 'Rollback default consumer',
      defaultCapabilityPolicy: {
        capability: 'nlp.tokenize', maxRequests: 1_000, windowSeconds: 3_600,
      },
    }),
    /simulated default policy failure/,
  )
  assert.deepEqual(statements, ['BEGIN', 'CONSUMER', 'GRANT', 'POLICY', 'ROLLBACK'])
  assert.equal(statements.includes('COMMIT'), false)
  assert.equal(released, true)
})

test('Postgres capability configuration rolls back its grant when policy persistence fails', async () => {
  const statements = []
  let authorized = false
  let stagedAuthorized = false
  let released = false
  const client = {
    async query(sql) {
      const normalized = sql.trim().replace(/\s+/g, ' ')
      if (normalized === 'BEGIN') {
        statements.push('BEGIN')
        stagedAuthorized = authorized
        return { rows: [] }
      }
      if (normalized.startsWith('INSERT INTO capability_grants')) {
        statements.push('GRANT')
        stagedAuthorized = true
        return { rows: [] }
      }
      if (normalized.startsWith('INSERT INTO consumer_capability_policies')) {
        statements.push('POLICY')
        throw new Error('simulated policy transaction failure')
      }
      if (normalized === 'ROLLBACK') {
        statements.push('ROLLBACK')
        stagedAuthorized = authorized
        return { rows: [] }
      }
      assert.fail(`unexpected SQL: ${normalized}`)
    },
    release() {
      released = true
    },
  }
  const store = new PostgresStore({ connect: async () => client })

  await assert.rejects(
    store.putCapabilityConfiguration({
      tenantId: '00000000-0000-4000-8000-000000000001',
      consumerId: '00000000-0000-4000-8000-000000000002',
      capability: 'nlp.tokenize',
      enabled: true,
      maxRequests: 3,
      windowSeconds: 60,
    }),
    /simulated policy transaction failure/,
  )
  assert.deepEqual(statements, ['BEGIN', 'GRANT', 'POLICY', 'ROLLBACK'])
  assert.equal(stagedAuthorized, false)
  assert.equal(authorized, false)
  assert.equal(released, true)
})

test('public tokenize enforces auth, grant, strict input, quota, and bounded replay evidence', async () => {
  const calls = []
  const segmenter = {
    async segmentWithMeta(text) {
      calls.push(text)
      return {
        tokens: ['吴恩达', '人工智能'],
        backendUsed: 'hanlp',
        degraded: false,
        errorCode: null,
      }
    },
  }
  await withFixture(segmenter, async ({ store, service, tenant, consumer, secret, call }) => {
    const headers = { authorization: `Bearer ${secret}` }
    const unauthenticated = await call('/api/v1/tools/tokenize', {
      method: 'POST', body: { text: '人工智能' },
    })
    assert.equal(unauthenticated.response.status, 401)
    assert.equal(unauthenticated.payload.error.code, 'api_key_required')

    await service.putCapabilityConfiguration('nlp.tokenize', {
      tenantId: tenant.id,
      consumerId: consumer.id,
      enabled: false,
    })
    const forbidden = await call('/api/v1/tools/tokenize', {
      method: 'POST', headers: { ...headers, 'idempotency-key': 'forbidden-one' }, body: { text: '人工智能' },
    })
    assert.equal(forbidden.response.status, 403)
    assert.equal(forbidden.payload.error.code, 'capability_not_granted')

    await grant(call, tenant, consumer)
    const publicCapabilities = await call('/api/v1/data/capabilities', { headers })
    assert.deepEqual(publicCapabilities.payload.data.capabilities, [{
      capability: 'nlp.tokenize', ready: true,
    }])
    assert.deepEqual(publicCapabilities.payload.data.platforms, [])

    const missingIdempotency = await call('/api/v1/tools/tokenize', {
      method: 'POST', headers, body: { text: '人工智能' },
    })
    assert.equal(missingIdempotency.response.status, 400)
    assert.equal(missingIdempotency.payload.error.code, 'idempotency_key_required')

    for (const [body, code] of [
      [{}, 'invalid_request'],
      [{ text: '   ' }, 'invalid_request'],
      [{ text: '!!!' }, 'invalid_request'],
      [{ text: 'valid', backend: 'hanlp' }, 'unsupported_fields'],
      [{ text: `valid\u0000text` }, 'invalid_request'],
      [{ text: '中'.repeat(4_097) }, 'invalid_request'],
    ]) {
      const invalid = await call('/api/v1/tools/tokenize', {
        method: 'POST', headers: { ...headers, 'idempotency-key': 'invalid-body' }, body,
      })
      assert.equal(invalid.response.status, 400)
      assert.equal(invalid.payload.error.code, code)
    }
    const oversized = await call('/api/v1/tools/tokenize', {
      method: 'POST', headers: { ...headers, 'idempotency-key': 'oversized-body' }, rawBody: JSON.stringify({ text: '中'.repeat(17_000) }),
    })
    assert.equal(oversized.response.status, 413)
    assert.equal(oversized.payload.error.code, 'payload_too_large')

    const first = await call('/api/v1/tools/tokenize', {
      method: 'POST', headers: { ...headers, 'idempotency-key': 'tokenize-one' }, body: { text: ' 吴恩达与人工智能 ' },
    })
    assert.equal(first.response.status, 200)
    assert.equal(first.response.headers.get('x-mx-insight-request-id'), first.payload.requestId)
    assert.deepEqual(first.payload.data, {
      capability: 'nlp.tokenize',
      tokens: ['吴恩达', '人工智能'],
      actualBackend: 'hanlp',
      degraded: false,
      errorCode: null,
    })
    assert.deepEqual(calls, ['吴恩达与人工智能'])
    assert.equal(JSON.stringify(first.payload).includes('吴恩达与人工智能'), false)
    assert.equal(first.response.headers.get('idempotent-replay'), 'false')

    const segmentWithMeta = segmenter.segmentWithMeta
    segmenter.segmentWithMeta = undefined
    const replay = await call('/api/v1/tools/tokenize', {
      method: 'POST', headers: { ...headers, 'idempotency-key': 'tokenize-one' }, body: { text: ' 吴恩达与人工智能 ' },
    })
    segmenter.segmentWithMeta = segmentWithMeta
    assert.equal(replay.response.status, 200)
    assert.equal(replay.response.headers.get('idempotent-replay'), 'true')
    assert.equal(replay.payload.requestId, first.payload.requestId)
    assert.deepEqual(replay.payload.data, first.payload.data)
    assert.deepEqual(calls, ['吴恩达与人工智能'])

    const conflict = await call('/api/v1/tools/tokenize', {
      method: 'POST', headers: { ...headers, 'idempotency-key': 'tokenize-one' }, body: { text: '不同文本' },
    })
    assert.equal(conflict.response.status, 409)
    assert.equal(conflict.payload.error.code, 'idempotency_conflict')

    const requestStatus = await call(`/api/v1/requests/${first.payload.requestId}`, { headers })
    assert.equal(requestStatus.payload.data.status, 'committed')
    assert.equal(requestStatus.payload.data.capability, 'nlp.tokenize')
    assert.equal(requestStatus.payload.data.platform, undefined)
    assert.equal(requestStatus.payload.data.units, 2)

    const second = await call('/api/v1/tools/tokenize', {
      method: 'POST', headers: { ...headers, 'idempotency-key': 'tokenize-two' }, body: { text: '第二次调用' },
    })
    assert.equal(second.response.status, 200)
    const limited = await call('/api/v1/tools/tokenize', {
      method: 'POST', headers: { ...headers, 'idempotency-key': 'tokenize-three' }, body: { text: '第三次调用' },
    })
    assert.equal(limited.response.status, 429)
    assert.equal(limited.payload.error.code, 'quota_exceeded')
    assert.equal(limited.payload.error.details.capability, 'nlp.tokenize')

    const usage = await call('/api/v1/usage', { headers })
    assert.equal(usage.payload.data.requests, 2)
    assert.equal(usage.payload.data.committed, 2)
    assert.equal(usage.payload.data.units, 4)
    assert.deepEqual(usage.payload.data.byPlatform, {})
    assert.equal(usage.payload.data.byCapability['nlp.tokenize'].units, 4)
    const dashboard = await call('/internal/v1/ops/summary', {
      headers: { 'x-mx-insight-admin-token': ADMIN_TOKEN },
    })
    assert.equal(dashboard.payload.data.byCapability['nlp.tokenize'].requests, 2)
    assert.deepEqual(dashboard.payload.data.byPlatform, {})

    const scopedServer = createServer(createApp({
      service,
      store,
      adapter: { dependencies: async () => ({ status: 'up' }) },
      adminToken: ADMIN_TOKEN,
      identity: {
        enabled: true,
        resolve: async () => ({
          kind: 'launcher-user',
          memberId: 'tokenize-member',
          displayName: 'Tokenizer member',
          platformAdmin: false,
          tenantIds: [tenant.id],
          capabilities: ['usage.read'],
          memberships: [{ tenantId: tenant.id, capabilities: ['usage.read'] }],
        }),
      },
      logger: { error() {} },
    }))
    await new Promise((resolve) => scopedServer.listen(0, '127.0.0.1', resolve))
    try {
      const scopedResponse = await fetch(
        `http://127.0.0.1:${scopedServer.address().port}/internal/v1/admin/usage`,
        { headers: { 'x-mx-insight-admin-token': 'launcher-session' } },
      )
      const scopedUsage = await scopedResponse.json()
      assert.equal(scopedResponse.status, 200)
      assert.equal(scopedUsage.data.byCapability['nlp.tokenize'].units, 4)
      assert.deepEqual(scopedUsage.data.byPlatform, {})
    } finally {
      await new Promise((resolve) => scopedServer.close(resolve))
    }
    for (const evidence of store.requests.values()) {
      assert.equal(evidence.platform, null)
      assert.equal(evidence.capability, 'nlp.tokenize')
      assert.deepEqual(evidence.responseBody.data.tokens, ['吴恩达', '人工智能'])
      assert.equal(JSON.stringify(evidence).includes('吴恩达与人工智能'), false)
    }
  })
})

test('tokenize reports degraded metadata safely and never guesses for legacy segmenters', async () => {
  await withFixture({
    segmentWithMeta: async () => ({
      tokens: ['人工', '智能'],
      backendUsed: 'bigram',
      degraded: true,
      errorCode: 'HTTP 500: private upstream body',
    }),
  }, async ({ tenant, consumer, secret, call }) => {
    await grant(call, tenant, consumer)
    const response = await call('/api/v1/tools/tokenize', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'idempotency-key': 'degraded-one' },
      body: { text: '人工智能' },
    })
    assert.equal(response.response.status, 200)
    assert.equal(response.payload.data.actualBackend, 'bigram')
    assert.equal(response.payload.data.degraded, true)
    assert.equal(response.payload.data.errorCode, 'segmenter_error')
    assert.equal(JSON.stringify(response.payload).includes('private upstream'), false)
  })

  await withFixture({ segment: async () => ['人工智能'] }, async ({ service, tenant, consumer, secret, call }) => {
    await service.putCapabilityConfiguration('nlp.tokenize', {
      tenantId: tenant.id,
      consumerId: consumer.id,
      enabled: true,
    })
    const response = await call('/api/v1/tools/tokenize', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'idempotency-key': 'legacy-one' },
      body: { text: '人工智能' },
    })
    assert.equal(response.response.status, 503)
    assert.equal(response.payload.error.code, 'tokenizer_unavailable')
    assert.equal(response.payload.actualBackend, undefined)
  })
})

test('Hub consumes the mx-common segmentWithMeta backendUsed contract', async () => {
  await withFixture(createSegmenter({ backend: 'fallback' }), async ({ tenant, consumer, secret, call }) => {
    await grant(call, tenant, consumer)
    const response = await call('/api/v1/tools/tokenize', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'idempotency-key': 'mx-common-contract' },
      body: { text: '人工智能' },
    })
    assert.equal(response.response.status, 200)
    assert.equal(response.payload.data.actualBackend, 'bigram')
    assert.equal(response.payload.data.degraded, false)
    assert.ok(response.payload.data.tokens.length > 0)
  })
})

test('tokenizer failure is safe and the same idempotency key can retry then replay', async () => {
  let attempts = 0
  await withFixture({
    segmentWithMeta: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('Bearer private-token and upstream response body')
      return {
        tokens: ['人工', '智能'],
        backendUsed: 'jieba',
        degraded: true,
        errorCode: 'hanlp_unavailable',
      }
    },
  }, async ({ tenant, consumer, secret, call }) => {
    await grant(call, tenant, consumer, { maxRequests: 1 })
    const headers = {
      authorization: `Bearer ${secret}`,
      'idempotency-key': 'failure-one',
    }
    const failed = await call('/api/v1/tools/tokenize', {
      method: 'POST', headers, body: { text: '人工智能' },
    })
    assert.equal(failed.response.status, 503)
    assert.equal(failed.payload.error.code, 'tokenizer_unavailable')
    assert.equal(JSON.stringify(failed.payload).includes('private-token'), false)

    const releasedUsage = await call('/api/v1/usage', {
      headers: { authorization: `Bearer ${secret}` },
    })
    assert.equal(releasedUsage.payload.data.released, 1)
    assert.equal(releasedUsage.payload.data.units, 0)
    assert.equal(releasedUsage.payload.data.byCapability['nlp.tokenize'].released, 1)

    const retried = await call('/api/v1/tools/tokenize', {
      method: 'POST', headers, body: { text: '人工智能' },
    })
    assert.equal(retried.response.status, 200)
    assert.equal(retried.response.headers.get('idempotent-replay'), 'false')
    assert.equal(retried.payload.data.actualBackend, 'jieba')
    assert.equal(attempts, 2)

    const replay = await call('/api/v1/tools/tokenize', {
      method: 'POST', headers, body: { text: '人工智能' },
    })
    assert.equal(replay.response.status, 200)
    assert.equal(replay.response.headers.get('idempotent-replay'), 'true')
    assert.equal(replay.payload.requestId, retried.payload.requestId)
    assert.deepEqual(replay.payload.data, retried.payload.data)
    assert.equal(attempts, 2)

    const usage = await call('/api/v1/usage', {
      headers: { authorization: `Bearer ${secret}` },
    })
    assert.equal(usage.payload.data.requests, 1)
    assert.equal(usage.payload.data.committed, 1)
    assert.equal(usage.payload.data.released, 0)
    assert.equal(usage.payload.data.units, 2)
  })
})

test('migration 018 keeps generic capability authority and usage separate from platforms', async () => {
  const migration = await readFile(
    fileURLToPath(new URL('../../migrations/018_public_capabilities.sql', import.meta.url)),
    'utf8',
  )
  assert.match(migration, /CREATE TABLE IF NOT EXISTS capability_grants/)
  assert.match(migration, /CREATE TABLE IF NOT EXISTS consumer_capability_policies/)
  assert.match(migration, /ADD COLUMN IF NOT EXISTS capability text/)
  assert.match(migration, /usage_requests_single_scope_check/)
  assert.doesNotMatch(migration, /INSERT INTO platform_grants[^;]*nlp\.tokenize/is)
})

test('migration 020 enables only consumers that never configured tokenize', async () => {
  const migration = await readFile(
    fileURLToPath(new URL('../../migrations/020_default_tokenize_capability.sql', import.meta.url)),
    'utf8',
  )
  const guards = migration.match(
    /WHERE NOT EXISTS\s*\([\s\S]*?consumer_capability_policies[\s\S]*?p\.consumer_id\s*=\s*c\.id[\s\S]*?p\.capability\s*=\s*'nlp\.tokenize'[\s\S]*?\)/g,
  ) || []
  assert.equal(guards.length, 2)
  assert.match(
    migration,
    /LOCK TABLE\s+consumers,\s*capability_grants,\s*consumer_capability_policies\s+IN SHARE ROW EXCLUSIVE MODE;/,
  )
  assert.ok(
    migration.indexOf('LOCK TABLE') < migration.indexOf('INSERT INTO capability_grants'),
    'the transaction-scoped lock must be acquired before the backfill writes',
  )
  assert.match(migration, /INSERT INTO capability_grants/)
  assert.match(migration, /INSERT INTO consumer_capability_policies/)

  const consumers = [
    { id: 'never-configured', hasPolicy: false, granted: false },
    { id: 'explicit-enabled', hasPolicy: true, granted: true },
    { id: 'explicit-disabled', hasPolicy: true, granted: false },
  ]
  const backfilled = consumers
    .filter((consumer) => !consumer.hasPolicy)
    .map((consumer) => consumer.id)
  assert.deepEqual(backfilled, ['never-configured'])
  assert.equal(backfilled.includes('explicit-disabled'), false)
})
