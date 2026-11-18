import assert from 'node:assert/strict'
import test from 'node:test'
import { HubService, businessApiScopes, lcyFullApiScopes } from '../../server/hub-service.mjs'
import { MemoryCollectStore } from '../../server/collect/store.mjs'
import { CollectExecutor } from '../../server/collect/executor.mjs'
import { CollectService } from '../../server/collect/service.mjs'
import { createCollectContracts } from '../../server/collect/contracts/index.mjs'
import { LCY_IDENTITY, LcyHubLimitStore } from '../fixtures/lcy-hub-limit-store.mjs'

const CAPABILITY = 'collect.app.details'
const PLATFORM = 'app_market'
const request = { capability: CAPABILITY, input: { market: 'xiaomi', appIds: ['108048'] } }

test('LCY catalog grants reach collection ledger reservation while ordinary sibling and platform revocation stay restricted', async () => {
  // Synthetic identity and snapshots only; disable the separate rate exemption
  // so this exercises ordinary reserve authorization and quota enforcement.
  const ledger = new LcyHubLimitStore(false)
  const hub = new HubService({ store: ledger, adapter: {}, apiKeyPepper: 'lcy-collect-test-pepper-at-least-32-bytes' })
  const tenant = await hub.createTenant({ name: 'Synthetic tenant' })
  const consumer = await hub.createConsumer({ tenantId: tenant.id, name: 'Synthetic consumer' })
  const full = lcyFullApiScopes()
  await ledger.replaceGrants(consumer.id, full.platforms)
  for (const capability of full.capabilities) {
    await ledger.putCapabilityConfiguration({ tenantId: tenant.id, consumerId: consumer.id,
      capability, enabled: true, maxRequests: 1000, windowSeconds: 3600 })
  }
  const key = await hub.createApiKey({ consumerId: consumer.id, name: 'Renamed original', ...full })
  const ordinary = await hub.createApiKey({ consumerId: consumer.id, name: 'LCY-delta', ...businessApiScopes() })
  const context = await hub.authenticate(key.secret)
  const sibling = await hub.authenticate(ordinary.secret)
  assert.equal(context.apiKey.id, LCY_IDENTITY.key)
  assert.equal(context.tenant.id, LCY_IDENTITY.tenant)
  assert.equal(context.consumer.id, LCY_IDENTITY.consumer)
  assert.notEqual(sibling.apiKey.id, LCY_IDENTITY.key)

  const calls = []
  // This transport never opens a socket, including the loopback runner URL.
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: JSON.parse(init.body) })
    return Response.json({ data: { state: 'completed', envelope: {
      schema_version: '1.0', project_id: '195', source_id: '195', operation: 'collect',
      observed_at: '2026-11-18T00:00:00Z', status: 'success', error: null,
      result: { items: [{ app_id: '108048', name: 'Synthetic app' }] },
    } } })
  }
  const jobs = new MemoryCollectStore()
  const contracts = createCollectContracts()
  const executor = new CollectExecutor({ jobs, ledger, contracts, fetchImpl,
    credentialsFor: async () => 'synthetic-runner-key',
    policyFor: (owner, platform) => hub.usagePolicy(owner, platform) })
  // Explicit drain only: no background interval or service is started.
  const service = new CollectService({ jobs, ledger, contracts, executor: null, fetchImpl })
  await service.adminCreateEngine({ id: 'runner.lcy-authorization', kind: 'runner',
    displayName: 'Synthetic runner', slotRef: 'market-195', baseUrl: 'http://127.0.0.1:18300',
    routes: [{ capability: CAPABILITY, routeKey: 'xiaomi' }], enabled: true,
    billingEnabled: true, reason: 'Offline authorization regression' }, 'test')

  await assert.rejects(service.submitJob(sibling, request, 'lcy-collect-ordinary'), { code: 'capability_not_granted' })
  assert.equal(jobs.jobs.size, 0)
  assert.equal(ledger.requests.size, 0)
  assert.equal(calls.length, 0)

  const submitted = await service.submitJob(context, request, 'lcy-collect-complete')
  executor.stopped = false
  await executor.drain()
  const completed = await jobs.get(submitted.data.jobId)
  assert.equal(completed.status, 'succeeded', completed.error?.message)
  assert.equal(completed.billing, 'charged')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'POST')
  assert.deepEqual(calls[0].body.params.inputs, ['108048'])
  const usage = await ledger.getUsageRequestByIdempotencyKey(consumer.id, `col-${completed.id}`)
  assert.equal(usage.id, completed.usageRequestId)
  assert.equal(usage.apiKeyId, LCY_IDENTITY.key)
  assert.equal(usage.platform, PLATFORM)
  assert.equal(usage.billingMeterKey, CAPABILITY)
  assert.equal(usage.status, 'committed')
  assert.deepEqual(ledger.usageAuthorizationScopes.get(usage.id), [
    { type: 'platform', key: PLATFORM }, { type: 'capability', key: CAPABILITY },
  ])

  // Capability prechecks still pass, but the real ledger must reject a missing
  // platform grant before dispatch, even for the exact LCY identity.
  await ledger.setPlatformGrant(consumer.id, PLATFORM, false)
  const revoked = await service.submitJob(context, request, 'lcy-collect-platform-revoked')
  await executor.drain()
  const refused = await jobs.get(revoked.data.jobId)
  assert.equal(refused.status, 'failed')
  assert.equal(refused.error.code, 'api_key_scope_not_granted')
  assert.equal(refused.billing, 'none')
  assert.equal(refused.usageRequestId, null)
  assert.equal(ledger.requests.size, 1)
  assert.equal(calls.length, 1, 'platform revocation must stop the mock collector before dispatch')
})
