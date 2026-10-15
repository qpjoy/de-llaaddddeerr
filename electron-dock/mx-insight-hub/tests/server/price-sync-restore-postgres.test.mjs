import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { VerifiedPriceSyncService } from '../../server/commercial/price-sync.mjs'
import { PriceSyncRestoreService } from '../../server/commercial/price-sync-restore.mjs'
import { verifiedPriceSources } from '../../server/commercial/verified-price-sources.mjs'
import { PostgresExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { readCustomerPriceSyncInventory } from '../../server/commercial/price-sync-customers.mjs'
import { auditPriceSyncAccess } from '../../server/ops/audit-price-sync-access.mjs'

const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL || ''
test('complete price restore is atomic, source-preserving and idempotent; access audit uses a read-only transaction', {
  skip: connectionString ? false : 'MX_INSIGHT_TEST_DATABASE_URL is not configured',
}, async () => {
  const pool = new pg.Pool({ connectionString, max: 2, statement_timeout: 15000 })
  const evidence = verifiedPriceSources(), rate = evidence.rates.find(row => row.provider === 'qixin' && row.unitPrice === '3.00')
  const operationKey = `enterprise.api.${rate.flags.apiId}`, tenantId = randomUUID(), consumerId = randomUUID()
  const control = new PostgresExternalPlatformControlStore({ pool })
  const policy = async () => (await control.describeProvider('qixin')).find(row => row.operationKey === operationKey)
  try {
    const before = await policy()
    await control.updatePolicy('qixin', operationKey, { expectedRevision: before.revision, desiredState: before.desiredState,
      canaryConsumerIds: before.canaryConsumerIds, reason: 'Isolated restore fixture', priceBook: { currency: 'CNY', pricingAsOf: '2026-10-01',
        monthlyBudgetMinor: 10000, monthlySubsidyBudgetMinor: 10000, unitCostMinorByEndpoint: { [rate.endpointKey]: 1 } } })
    await pool.query("INSERT INTO tenants(id,name) VALUES($1,'Synthetic restore')", [tenantId])
    await pool.query("INSERT INTO consumers(id,tenant_id,name,business_id) VALUES($1,$2,'Synthetic restore consumer',$3)", [consumerId, tenantId, `test:${consumerId}`])
    await pool.query("INSERT INTO billing.tenant_billing_profiles(tenant_id,mode,default_unit_price_minor,default_currency) VALUES($1,'shadow',1,'CNY')", [tenantId])
    const forward = new VerifiedPriceSyncService({ pool, sourceReader: () => ({ rates: [rate], sources: evidence.sources.filter(row => row.provider === 'qixin'), excluded: [] }) })
    const preview = await forward.preview(), migrated = await forward.apply(preview.id, preview.hash)
    const sourceBefore = await forward.batch(preview.id)
    const customerBefore = (await readCustomerPriceSyncInventory(pool, { meterKeys: [operationKey], consumerIds: [consumerId] })).consumers[0]
    const procurementBefore = await policy()
    const auditClient = await pool.connect()
    try {
      await auditClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const audit = await auditPriceSyncAccess(auditClient, preview.id)
      assert.equal(audit.status, 'completed'); assert.equal(audit.businessCalls, 0)
      assert.equal(audit.customers.accounts.find(row => row.consumerId === consumerId).mode, 'shadow')
      assert.equal(audit.procurement.stateChangesDuringMigration.length, 0)
      await auditClient.query('COMMIT')
    } finally { await auditClient.query('ROLLBACK').catch(() => {}); auditClient.release() }
    const service = new PriceSyncRestoreService({ pool })
    const restore = await service.preview(preview.id, { reason: 'Synthetic selective recovery',
      procurement: [`qixin:${operationKey}`], customers: [{ consumerId, meterKeys: [operationKey] }] })
    assert.equal(restore.summary.canApply, true)
    const failingPool = { async connect() {
      const client = await pool.connect()
      return { release: (...args) => client.release(...args), async query(sql, values) {
        if (sql.startsWith("UPDATE control.provisioning_batches SET status='completed'")) throw new Error('Synthetic restore late failure')
        return client.query(sql, values)
      } }
    } }
    await assert.rejects(new PriceSyncRestoreService({ pool: failingPool }).apply(restore.id, restore.hash), /Synthetic restore late failure/)
    assert.equal((await service.batch(restore.id)).status, 'preview')
    assert.deepEqual(await policy(), procurementBefore)
    assert.deepEqual((await readCustomerPriceSyncInventory(pool, { meterKeys: [operationKey], consumerIds: [consumerId] })).consumers[0], customerBefore)
    const result = await service.apply(restore.id, restore.hash)
    assert.equal(result.status, 'completed')
    assert.equal((await policy()).priceBook.endpointPrices[rate.endpointKey], 1)
    const after = (await readCustomerPriceSyncInventory(pool, { meterKeys: [operationKey], consumerIds: [consumerId] })).consumers[0]
    assert.equal(after.assignment.assignedAt, customerBefore.assignment.assignedAt)
    assert.deepEqual(after.plan.limits, customerBefore.plan.limits)
    assert.equal(after.priceBook, null)
    assert.equal(after.profile.defaultUnitPriceMinor, 1)
    assert.deepEqual(await service.apply(restore.id, restore.hash), result)
    assert.deepEqual((await forward.batch(preview.id)).result, migrated)
    assert.deepEqual((await forward.batch(preview.id)).preview, sourceBefore.preview)
    const stale = await service.preview(preview.id, { reason: 'Cannot restore twice as a new batch', customers: [{ consumerId, meterKeys: [operationKey] }] })
    assert.equal(stale.summary.canApply, false)
    await assert.rejects(service.apply(stale.id, stale.hash), { code: 'price_restore_blocked' })
    await pool.query("UPDATE control.provisioning_batches SET preview=jsonb_set(preview,'{version}','99') WHERE id=$1", [preview.id])
    await assert.rejects(service.preview(preview.id, { reason: 'Altered evidence must fail', procurement: [`qixin:${operationKey}`] }), { code: 'price_restore_source_invalid' })
    await assert.rejects(auditPriceSyncAccess(pool, preview.id), /hashes do not match/)
    await pool.query('UPDATE control.provisioning_batches SET preview=$2 WHERE id=$1', [preview.id, sourceBefore.preview])
  } finally { await pool.end() }
})
