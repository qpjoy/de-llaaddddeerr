import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { parseInternalTrafficPolicy, createInternalTrafficPolicy, internalCircuitState, acquireTikHubRateLimit } from '../../server/core/internal-traffic-policy.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { saveKeyAccessLimit } from '../../server/stores/key-access-limits.mjs'

test('internal policy is opt-in by immutable ID; names and request flags do not match', () => {
  const apiKeyId = randomUUID(), tenantId = randomUUID()
  assert.deepEqual(parseInternalTrafficPolicy({}), { keyIds: [], tenantIds: [] })
  assert.throws(() => parseInternalTrafficPolicy({ MX_INSIGHT_INTERNAL_KEY_IDS: 'LCY-delta' }), /UUIDs/)
  const parsed = parseInternalTrafficPolicy({ MX_INSIGHT_INTERNAL_KEY_IDS: ` ${apiKeyId.toUpperCase()},${apiKeyId}` })
  assert.deepEqual(parsed.keyIds, [apiKeyId])
  assert.equal(createInternalTrafficPolicy(parsed).matches({ apiKeyId, tenantId }), true)
  assert.equal(createInternalTrafficPolicy(parsed).matches({ apiKeyId: randomUUID(), tenantId, name: 'LCY-delta', internal: true }), false)
  assert.equal(createInternalTrafficPolicy({ tenantIds: [tenantId] }).matches({ apiKeyId, tenantId }), true)
  assert.equal(createInternalTrafficPolicy({ tenantIds: [tenantId] }).matches({ apiKeyId, tenantId: randomUUID() }), false)
})

test('only rate-limit circuits get a 10-second internal deadline; shared state is unchanged', async () => {
  const apiKeyId = randomUUID(), tenantId = randomUUID()
  const store = { internalTrafficPolicy: createInternalTrafficPolicy({ keyIds: [apiKeyId] }) }
  const context = { apiKey: { id: apiKeyId }, tenant: { id: tenantId } }
  const failure = Date.now() - 11_000
  const state = { lastErrorCode: 'upstream_rate_limited', lastFailureAt: new Date(failure).toISOString(), circuitOpenUntil: new Date(failure + 60_000).toISOString() }
  assert.equal(Date.parse(internalCircuitState(store, context, state).circuitOpenUntil), failure + 10_000)
  assert.equal(Date.parse(state.circuitOpenUntil), failure + 60_000)
  const other = { ...context, apiKey: { id: randomUUID() } }
  assert.equal(internalCircuitState(store, other, state), state)
  for (const lastErrorCode of ['upstream_auth_or_balance_unavailable', 'upstream_http_error', 'invalid_contract']) {
    const unavailable = { ...state, lastErrorCode }
    assert.equal(internalCircuitState(store, context, unavailable), unavailable)
  }
  const unknownTime = { ...state, lastFailureAt: null }
  assert.equal(internalCircuitState(store, context, unknownTime), unknownTime)
  let calls = 0
  const platform = { async acquireProviderRateLimit() { calls++; return { allowed: false, retryAfterMs: 1200 } } }
  assert.equal((await acquireTikHubRateLimit(store, context, platform, {})).allowed, true)
  assert.equal(calls, 0)
  assert.equal((await acquireTikHubRateLimit(store, other, platform, {})).allowed, false)
  assert.equal(calls, 1)
})

const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL || ''
for (const driver of ['memory', 'postgres']) for (const profile of ['environment', 'managed_full']) {
  test(`${driver}/${profile}: internal quota exemption preserves scopes, plan validity, billing, replay and sibling limits`, {
    skip: driver === 'postgres' && !connectionString ? 'Requires disposable migrated PostgreSQL' : false,
  }, async () => {
    const pool = driver === 'postgres' ? new pg.Pool({ connectionString, statement_timeout: 5000 }) : null
    const store = pool ? new PostgresStore(pool) : new MemoryStore()
    const service = new HubService({ store, adapter: {}, apiKeyPepper: 'internal-traffic-test-pepper-at-least-32-bytes' })
    try {
      const tenant = await service.createTenant({ name: `internal-${randomUUID()}` })
      const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Internal caller' })
      await service.putPlatformConfiguration('xiaohongshu', { tenantId: tenant.id, consumerId: consumer.id, enabled: true, maxRequests: 1, windowSeconds: 3600, maxPageSize: 100 })
      const key = await service.createApiKey({ consumerId: consumer.id, name: 'LCY-delta', platforms: ['xiaohongshu'], capabilities: [] })
      const sibling = await service.createApiKey({ consumerId: consumer.id, name: 'LCY-delta', platforms: ['xiaohongshu'], capabilities: [] })
      const plan = await service.publishPlanVersion({ key: `internal-${randomUUID()}`, name: 'Tiny plan',
        limits: { monthlyRequests: 1, maxRequests: 1, windowSeconds: 3600, maxPageSize: 100, burstRps: 1 },
        priceBook: { key: `internal-${randomUUID()}`, currency: 'CNY', defaultMultiplierPpm: 1000000,
          entries: [{ meterKey: 'social.posts.search', unitPriceMinor: 1 }] },
      }, 'test-admin')
      const current = await service.getConsumerPlan(consumer.id)
      await service.assignConsumerPlan(consumer.id, { planVersionId: plan.versionId, expectedRevision: current.revision }, 'test-admin')
      await saveKeyAccessLimit(store, { ...key, tenantId: tenant.id, consumerId: consumer.id }, { scopeType: 'platform', scopeKey: 'xiaohongshu', totalLimit: 1, rateLimit: 1, windowSeconds: 3600, revision: 0 }, 'test-admin')
      const input = (extra = {}) => ({ requestId: randomUUID(), idempotencyKey: randomUUID(), fingerprint: 'a'.repeat(64),
        tenantId: tenant.id, consumerId: consumer.id, apiKeyId: key.id, platform: 'xiaohongshu', meterKey: 'social.posts.search',
        unitsReserved: 1, leaseExpiresAt: new Date(Date.now() + 60000), maxRequests: 1, windowStart: new Date(Date.now() - 3600000), ...extra })
      const first = input()
      await store.reserve(first)
      await assert.rejects(() => store.reserve(input({ internal: true, managedQuotaExempt: true, accessProfile: 'managed_full' })), error => error.code === 'api_key_total_limit_exceeded')
      const setProfile = async enabled => {
        if (profile === 'environment') store.internalTrafficPolicy = createInternalTrafficPolicy({ keyIds: enabled ? [key.id] : [] })
        else if (pool) await pool.query('UPDATE api_keys SET access_profile=$2 WHERE id=$1', [key.id, enabled ? 'managed_full' : 'standard'])
        else store.apiKeys.get(key.id).accessProfile = enabled ? 'managed_full' : 'standard'
      }
      await setProfile(true)
      if (profile === 'managed_full') assert.equal((await service.authenticate(key.secret)).apiKey.accessProfile, 'managed_full')
      await assert.rejects(service.createApiKey({ consumerId: consumer.id, name: 'Spoofed profile', accessProfile: 'managed_full' }), { code: 'unsupported_fields' })
      assert.equal((await store.reserve(input())).kind, 'reserved')
      assert.equal((await store.reserve(input())).kind, 'reserved')
      assert.equal((await store.reserve(first)).kind, 'in_progress')
      assert.equal((await store.reserve({ ...first, fingerprint: 'b'.repeat(64) })).kind, 'conflict')
      const snapshot = await store.quotaSnapshot({ tenantId: tenant.id, consumerId: consumer.id, apiKeyId: key.id })
      assert.equal(snapshot[0].binding.exempt, true)
      assert.equal(snapshot[0].binding.limit, null)
      assert.equal(snapshot[0].binding.remaining, null)
      assert.equal(snapshot[0].binding.used, 3)
      await assert.rejects(() => store.reserve(input({ apiKeyId: sibling.id })), error => error.code === 'consumer_quota_exceeded')
      await assert.rejects(() => store.reserve(input({ platform: 'weibo' })), error => error.status === 403)
      await assert.rejects(() => store.reserve(input({ tenantId: randomUUID() })), error => error.status === 403)
      await service.setTenantBillingProfile(tenant.id, { mode: 'enforced', multiplierPpm: 1000000 }, 'test-admin')
      await assert.rejects(() => store.reserve(input()), error => error.code === 'insufficient_credit')
      // Removing the operator allowlist restores the retained limits immediately.
      await setProfile(false)
      await assert.rejects(() => store.reserve(input()), error => error.code === 'api_key_total_limit_exceeded')
    } finally { await pool?.end() }
  })
}
