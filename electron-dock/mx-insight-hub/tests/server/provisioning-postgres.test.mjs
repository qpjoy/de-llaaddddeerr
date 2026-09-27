import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { HubService } from '../../server/hub-service.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { PostgresExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { ProvisioningService } from '../../server/commercial/provisioning.mjs'
import { PROVISIONING_OPERATIONS } from '../../server/commercial/catalog.mjs'
// Use a migrated disposable test database, never production. Deliberately uses
// the real store transactions/savepoints and immutable audit triggers.
const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL || ''
test('PostgreSQL provisioning commits all metadata once and rolls back a late failure', {
  skip: connectionString ? false : 'MX_INSIGHT_TEST_DATABASE_URL is not configured',
}, async () => {
  const pool = new pg.Pool({ connectionString, statement_timeout: 15000 })
  try {
    const store = new PostgresStore(pool), control = new PostgresExternalPlatformControlStore({ pool })
    const service = new HubService({ store, adapter: {}, apiKeyPepper: 'isolated-provisioning-test-pepper-at-least-32' })
    const tenant = await service.createTenant({ name: `provision-${randomUUID()}` })
    const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Provision test consumer' })
    const key = await service.createApiKey({ consumerId: consumer.id, name: 'Provision test key' })
    const operation = PROVISIONING_OPERATIONS.find(row => row.id === 'justone:native.j.douyin_search_video_v4')
    const runtime = async () => ({ credentialConfigured: true, config: { timeoutMs: 1000 } })
    const provision = new ProvisioningService({ service, control, runtime })
    const draft = await provision.createDraft({ provider: 'justone', name: 'Synthetic price evidence', sourceKind: 'manual', sourceUrl: 'https://example.com/prices', observedAt: '2026-09-26',
      rates: operation.endpointKeys.map(endpointKey => ({ endpointKey, currency: 'CNY', unitPrice: '0.0038', billingUnit: 'request' })) })
    const spec = { keyId: key.id, operationIds: [operation.id], draftId: draft.id, overrideProcurement: [operation.id], salePrices: { [operation.id]: 10 }, currency: 'CNY', monthlyBudgetMinor: 10000, monthlySubsidyBudgetMinor: 0, acknowledgeRounding: true, reason: 'Isolated integration test' }
    const before = await control.describeProvider('justone', await runtime())
    const batch = await provision.preview(spec)
    assert.equal(batch.preview.canApply, true)
    const original = provision.write.bind(provision)
    provision.write = async (...args) => { await original(...args); throw Error('late integration failure') }
    await assert.rejects(provision.apply(batch.id), /late integration failure/)
    assert.deepEqual(await control.describeProvider('justone', await runtime()), before)
    assert.deepEqual(await store.listGrants(consumer.id), [])
    assert.equal((await provision.batch(batch.id)).status, 'preview')
    provision.write = original
    const result = await provision.apply(batch.id)
    assert.equal(result.status, 'completed')
    assert.deepEqual(await provision.apply(batch.id), result)
    assert.ok((await store.listApiKeys(consumer.id))[0].capabilities.includes(operation.capability))
    assert.equal((await store.getConsumerPlan(consumer.id)).priceBook.entries.find(row => row.meterKey === operation.meterKey).unitPriceMinor, 10)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM control.procurement_price_references WHERE batch_id=$1', [batch.id])).rows[0].n, 1)
  } finally { await pool.end() }
})
