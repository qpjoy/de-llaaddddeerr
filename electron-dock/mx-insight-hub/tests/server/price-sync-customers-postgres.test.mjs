import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { applyCustomerPriceSync, planCustomerPriceSync, readCustomerPriceSyncInventory } from '../../server/commercial/price-sync-customers.mjs'

const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL || ''

test('PostgreSQL price migration retains immutable terms and quota epoch, audits once, and fully rolls back', {
  skip: connectionString ? false : 'MX_INSIGHT_TEST_DATABASE_URL is not configured',
}, async () => {
  const pool = new pg.Pool({ connectionString, statement_timeout: 10_000 })
  const client = await pool.connect()
  const tenantId = randomUUID(), consumerId = randomUUID(), oldPlanId = randomUUID(), oldVersionId = randomUUID(), oldBookId = randomUUID()
  const meterKey = 'native.price_sync.test', batchId = `test-${randomUUID()}`
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
    await client.query("INSERT INTO tenants(id,name) VALUES($1,'Synthetic price migration')", [tenantId])
    await client.query("INSERT INTO consumers(id,tenant_id,name,business_id) VALUES($1,$2,'Synthetic caller',$3)", [consumerId, tenantId, `test:${consumerId}`])
    await client.query(`INSERT INTO billing.tenant_billing_profiles(tenant_id,mode,default_unit_price_minor,default_currency)
      VALUES($1,'shadow',1,'CNY') ON CONFLICT(tenant_id) DO UPDATE SET mode='shadow',default_unit_price_minor=1,revision=billing.tenant_billing_profiles.revision+1`, [tenantId])
    await client.query("INSERT INTO plans(id,plan_key,name,status) VALUES($1,$2,'Original synthetic plan','active')", [oldPlanId, `test-${oldPlanId}`])
    await client.query(`INSERT INTO billing.customer_price_books(id,price_book_key,version,currency,status)
      VALUES($1,$2,1,'CNY','draft')`, [oldBookId, `test-${oldBookId}`])
    await client.query(`INSERT INTO billing.customer_price_entries(price_book_id,meter_key,unit_price_minor)
      VALUES($1,$2,1),($1,'native.price_sync.keep',35)`, [oldBookId, meterKey])
    await client.query("UPDATE billing.customer_price_books SET status='published',published_at=now(),published_by='test' WHERE id=$1", [oldBookId])
    await client.query(`INSERT INTO plan_versions(id,plan_id,version,status,limits,pricing,customer_price_book_id,published_at)
      VALUES($1,$2,1,'published','{"monthlyRequests":500,"maxPageSize":40}','{"components":[{"kind":"existing"}]}',$3,now())`, [oldVersionId, oldPlanId, oldBookId])
    await client.query(`UPDATE consumer_plan_assignments SET plan_version_id=$2,assigned_at='2020-09-01T00:00:00.123456Z',
      assigned_by='test',revision=revision+1 WHERE consumer_id=$1`, [consumerId, oldVersionId])
    const profileBefore = (await client.query('SELECT * FROM billing.tenant_billing_profiles WHERE tenant_id=$1', [tenantId])).rows
    const oldBefore = (await client.query('SELECT * FROM plan_versions WHERE id=$1', [oldVersionId])).rows
    const auditsBefore = Number((await client.query('SELECT count(*) AS count FROM consumer_plan_assignment_events WHERE consumer_id=$1', [consumerId])).rows[0].count)
    const inventory = await readCustomerPriceSyncInventory(client, { meterKeys: [meterKey], consumerIds: [consumerId] })
    const change = planCustomerPriceSync(inventory, { ratesByMeter: { [meterKey]: { currency: 'CNY', unit: 'request', unitPrice: '0.20', source: { kind: 'synthetic' } } } }).changes[0]
    const result = await applyCustomerPriceSync(client, change, { batchId })
    assert.equal(result.status, 'applied')
    const after = (await readCustomerPriceSyncInventory(client, { meterKeys: [meterKey], consumerIds: [consumerId] })).consumers[0]
    assert.equal(after.assignment.assignedAt, '2020-09-01T00:00:00.123456Z')
    assert.equal(after.assignment.revision, inventory.consumers[0].assignment.revision + 1)
    assert.deepEqual(after.plan.limits, inventory.consumers[0].plan.limits)
    assert.deepEqual(after.plan.pricing.components, inventory.consumers[0].plan.pricing.components)
    assert.equal(after.priceBook.entries.find(row => row.meterKey === meterKey).unitPriceMinor, 20)
    assert.equal(after.priceBook.entries.find(row => row.meterKey === 'native.price_sync.keep').unitPriceMinor, 35)
    assert.deepEqual((await client.query('SELECT * FROM plan_versions WHERE id=$1', [oldVersionId])).rows, oldBefore)
    assert.deepEqual((await client.query('SELECT * FROM billing.tenant_billing_profiles WHERE tenant_id=$1', [tenantId])).rows, profileBefore)
    assert.equal(Number((await client.query('SELECT unit_price_minor FROM billing.customer_price_entries WHERE price_book_id=$1 AND meter_key=$2', [oldBookId, meterKey])).rows[0].unit_price_minor), 1)
    assert.equal((await applyCustomerPriceSync(client, change, { batchId })).status, 'already_applied')
    assert.equal(Number((await client.query('SELECT count(*) AS count FROM consumer_plan_assignment_events WHERE consumer_id=$1', [consumerId])).rows[0].count), auditsBefore + 1)
    await client.query('SAVEPOINT protected_rows')
    await assert.rejects(client.query('UPDATE billing.customer_price_entries SET unit_price_minor=2 WHERE price_book_id=$1', [oldBookId]), { code: '55000' })
    await client.query('ROLLBACK TO SAVEPOINT protected_rows')
    await assert.rejects(client.query("UPDATE plan_versions SET limits='{}' WHERE id=$1", [oldVersionId]), { code: '55000' })
    await client.query('ROLLBACK TO SAVEPOINT protected_rows')
    await client.query('ROLLBACK')
    assert.equal((await client.query('SELECT id FROM consumers WHERE id=$1', [consumerId])).rowCount, 0)
    assert.equal((await client.query('SELECT id FROM plan_versions WHERE id=$1', [result.planVersionId])).rowCount, 0)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
    await pool.end()
  }
})
