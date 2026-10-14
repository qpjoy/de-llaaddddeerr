import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { VerifiedPriceSyncService } from '../../server/commercial/price-sync.mjs'
import { verifiedPriceSources } from '../../server/commercial/verified-price-sources.mjs'
import { readCustomerPriceSyncInventory } from '../../server/commercial/price-sync-customers.mjs'

const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL || ''
test('price-only batch rolls back both price systems, rejects drift, and replays one committed receipt', {
  skip: connectionString ? false : 'MX_INSIGHT_TEST_DATABASE_URL is not configured',
}, async () => {
  const pool = new pg.Pool({ connectionString, max: 2, statement_timeout: 15000 })
  const evidence = verifiedPriceSources()
  const rate = evidence.rates.find(row => row.provider === 'qixin' && row.unitPrice === '3.00')
  const sourceReader = () => ({ rates: [rate], sources: evidence.sources.filter(row => row.provider === 'qixin'), excluded: [] })
  const tenantId = randomUUID(), consumerId = randomUUID()
  const meterKey = `enterprise.api.${rate.flags.apiId}`
  try {
    await pool.query("INSERT INTO tenants(id,name) VALUES($1,'Synthetic price sync tenant')", [tenantId])
    await pool.query("INSERT INTO consumers(id,tenant_id,name,business_id) VALUES($1,$2,'Synthetic price sync caller',$3)", [consumerId, tenantId, `test:${consumerId}`])
    await pool.query(`INSERT INTO billing.tenant_billing_profiles(tenant_id,mode,default_unit_price_minor,default_currency)
      VALUES($1,'shadow',1,'CNY')`, [tenantId])
    const before = (await readCustomerPriceSyncInventory(pool, { meterKeys: [meterKey], consumerIds: [consumerId] })).consumers[0]
    const controlsBefore = (await pool.query('SELECT * FROM control.external_platform_operation_policies WHERE provider_key=$1 ORDER BY operation_key', ['qixin'])).rows
    const service = new VerifiedPriceSyncService({ pool, sourceReader })
    const batch = await service.preview()
    assert.ok(batch.summary.customer.changedPrices > 0)
    await assert.rejects(service.apply(batch.id, '0'.repeat(64)), { code: 'price_sync_hash_mismatch' })
    const failingPool = { async connect() {
      const client = await pool.connect()
      return { release: (...args) => client.release(...args), async query(sql, values) {
        if (sql.startsWith("UPDATE control.provisioning_batches SET status='completed'")) throw new Error('Synthetic late failure')
        return client.query(sql, values)
      } }
    } }
    await assert.rejects(new VerifiedPriceSyncService({ pool: failingPool, sourceReader }).apply(batch.id, batch.hash), /Synthetic late failure/)
    assert.equal((await service.batch(batch.id)).status, 'preview')
    assert.deepEqual((await readCustomerPriceSyncInventory(pool, { meterKeys: [meterKey], consumerIds: [consumerId] })).consumers[0], before)
    assert.deepEqual((await pool.query('SELECT * FROM control.external_platform_operation_policies WHERE provider_key=$1 ORDER BY operation_key', ['qixin'])).rows, controlsBefore)
    assert.equal((await pool.query('SELECT * FROM control.procurement_price_references WHERE batch_id=$1', [batch.id])).rowCount, 0)
    const result = await service.apply(batch.id, batch.hash)
    assert.equal(result.status, 'completed')
    assert.deepEqual(await service.apply(batch.id, batch.hash), result)
    const after = (await readCustomerPriceSyncInventory(pool, { meterKeys: [meterKey], consumerIds: [consumerId] })).consumers[0]
    assert.equal(after.assignment.assignedAt, before.assignment.assignedAt)
    assert.deepEqual(after.plan.limits, before.plan.limits)
    assert.equal(after.priceBook.entries.find(row => row.meterKey === meterKey).unitPriceMinor, 300)
    assert.deepEqual(after.profile, before.profile)
    assert.equal((await pool.query('SELECT * FROM api_keys WHERE consumer_id=$1', [consumerId])).rowCount, 0)
    const second = await service.preview()
    await pool.query('UPDATE billing.tenant_billing_profiles SET multiplier_ppm=900000,revision=revision+1 WHERE tenant_id=$1', [tenantId])
    await assert.rejects(service.apply(second.id, second.hash), { code: 'price_sync_changed' })
  } finally { await pool.end() }
})
