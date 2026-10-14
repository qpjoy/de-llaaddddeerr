import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { applyCustomerPriceSync, planCustomerPriceSync, readCustomerPriceSyncInventory } from '../../server/commercial/price-sync-customers.mjs'
import { applyCustomerRestore, planCustomerRestore, readCustomerRestoreInventory } from '../../server/commercial/price-sync-restore-customers.mjs'

const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL || ''
const meter = 'native.restore.test', other = 'native.restore.other', kept = 'native.restore.kept'
const rate = unitPrice => ({ currency: 'CNY', unit: 'request', unitPrice, source: { kind: 'synthetic' } })

async function fixture(client, { fallbackOnly = false } = {}) {
  const tenantId = randomUUID(), consumerId = randomUUID(), oldPlanId = randomUUID(), oldVersionId = randomUUID()
  const oldBookId = fallbackOnly ? null : randomUUID(), sourceId = randomUUID()
  await client.query("INSERT INTO tenants(id,name) VALUES($1,'Synthetic restore tenant')", [tenantId])
  await client.query("INSERT INTO consumers(id,tenant_id,name,business_id) VALUES($1,$2,'Synthetic restore caller',$3)", [consumerId, tenantId, `test:${consumerId}`])
  await client.query(`INSERT INTO billing.tenant_billing_profiles(tenant_id,mode,default_unit_price_minor,default_currency,multiplier_ppm)
    VALUES($1,'shadow',1,'CNY',250000) ON CONFLICT(tenant_id) DO UPDATE SET mode='shadow',default_unit_price_minor=1,
    multiplier_ppm=250000,revision=billing.tenant_billing_profiles.revision+1`, [tenantId])
  await client.query("INSERT INTO plans(id,plan_key,name,status) VALUES($1,$2,'Original restore plan','active')", [oldPlanId, `test-${oldPlanId}`])
  if (oldBookId) {
    await client.query(`INSERT INTO billing.customer_price_books(id,price_book_key,version,currency,default_multiplier_ppm,status)
      VALUES($1,$2,1,'CNY',500000,'draft')`, [oldBookId, `test-${oldBookId}`])
    await client.query(`INSERT INTO billing.customer_price_entries(price_book_id,meter_key,unit_price_minor)
      VALUES($1,$2,1),($1,$3,35)`, [oldBookId, meter, kept])
    await client.query("UPDATE billing.customer_price_books SET status='published',published_at=now(),published_by='test' WHERE id=$1", [oldBookId])
  }
  await client.query(`INSERT INTO plan_versions(id,plan_id,version,status,limits,pricing,customer_price_book_id,published_at)
    VALUES($1,$2,1,'published','{"monthlyRequests":500,"maxPageSize":40}','{"components":[{"kind":"existing"}]}',$3,now())`, [oldVersionId, oldPlanId, oldBookId])
  await client.query(`UPDATE consumer_plan_assignments SET plan_version_id=$2,assigned_at='2020-09-01T00:00:00.123456Z',
    assigned_by='test',revision=revision+1 WHERE consumer_id=$1`, [consumerId, oldVersionId])
  const meterKeys = fallbackOnly ? [meter] : [meter, other]
  const before = await readCustomerPriceSyncInventory(client, { meterKeys, consumerIds: [consumerId] })
  const forward = planCustomerPriceSync(before, { ratesByMeter: { [meter]: rate('0.20'), ...(fallbackOnly ? {} : { [other]: rate('0.30') }) } })
  const receipt = await applyCustomerPriceSync(client, forward.changes[0], { batchId: sourceId })
  const sourceBatch = { id: sourceId, specification: { kind: 'price-sync' }, status: 'completed', preview: { customer: forward },
    result: { batchId: sourceId, status: 'completed', customers: [receipt] } }
  return { tenantId, consumerId, oldBookId, oldVersionId, sourceBatch, receipt,
    selections: [{ consumerId, meterKeys: [meter] }] }
}

test('PostgreSQL targeted restore clones published terms and preserves quota epoch, unrelated prices, profile and history', {
  skip: connectionString ? false : 'MX_INSIGHT_TEST_DATABASE_URL is not configured',
}, async () => {
  const pool = new pg.Pool({ connectionString, statement_timeout: 10_000 }), client = await pool.connect()
  let fixtureIds, restoredId
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
    fixtureIds = await fixture(client)
    const { tenantId, consumerId, oldBookId, oldVersionId, sourceBatch, receipt, selections } = fixtureIds
    const keyId = randomUUID(), usageId = randomUUID()
    await client.query(`INSERT INTO api_keys(id,tenant_id,consumer_id,name,key_digest,key_prefix,last_four,environment)
      VALUES($1,$2,$3,'Synthetic restore key',$4,'test','test','test')`, [keyId, tenantId, consumerId, keyId.replaceAll('-', '').repeat(2)])
    await client.query(`INSERT INTO usage_requests(id,tenant_id,consumer_id,api_key_id,idempotency_key,fingerprint,platform,status,billing_meter_key)
      VALUES($1,$2,$3,$4,$5,$6,'native','reserved',$7)`, [usageId, tenantId, consumerId, keyId, usageId, 'a'.repeat(64), meter])
    await client.query("UPDATE usage_requests SET status='committed',completed_at=now() WHERE id=$1", [usageId])
    const historicalCharge = (await client.query('SELECT * FROM billing.customer_charges WHERE usage_request_id=$1', [usageId])).rows
    assert.equal(historicalCharge.length, 1)
    assert.equal(historicalCharge[0].status, 'captured')
    assert.equal(Number(historicalCharge[0].quoted_minor), 5)
    const previous = (await client.query('SELECT * FROM plan_versions WHERE id=ANY($1::uuid[]) ORDER BY id', [[oldVersionId, receipt.planVersionId]])).rows
    const previousEntries = (await client.query('SELECT * FROM billing.customer_price_entries WHERE price_book_id=ANY($1::uuid[]) ORDER BY id', [[oldBookId, receipt.priceBookId]])).rows
    const profile = (await client.query('SELECT * FROM billing.tenant_billing_profiles WHERE tenant_id=$1', [tenantId])).rows
    const auditsBefore = (await client.query('SELECT * FROM consumer_plan_assignment_events WHERE consumer_id=$1 ORDER BY id', [consumerId])).rows
    const inventory = await readCustomerRestoreInventory(client, { sourceBatch, selections })
    const plan = planCustomerRestore({ sourceBatch, inventory, selections })
    assert.equal(plan.blocked.length, 0)
    const receipts = await applyCustomerRestore(client, { batchId: randomUUID(), sourceBatch, plan })
    assert.equal(receipts.length, 1)
    restoredId = receipts[0].planVersionId
    assert.equal(receipts[0].assignedAt, '2020-09-01T00:00:00.123456Z')
    assert.equal(receipts[0].revision, receipt.revision + 1)
    const after = (await readCustomerPriceSyncInventory(client, { meterKeys: [meter, other, kept], consumerIds: [consumerId] })).consumers[0]
    assert.equal(after.priceBook.entries.find(row => row.meterKey === meter).unitPriceMinor, 1)
    assert.equal(after.priceBook.entries.find(row => row.meterKey === other).unitPriceMinor, 30)
    assert.equal(after.priceBook.entries.find(row => row.meterKey === kept).unitPriceMinor, 35)
    assert.equal(after.priceBook.defaultMultiplierPpm, 500_000)
    assert.deepEqual(after.plan.limits, inventory.consumers[0].plan.limits)
    assert.deepEqual(after.plan.pricing.components, [{ kind: 'existing' }])
    assert.deepEqual((await client.query('SELECT * FROM billing.tenant_billing_profiles WHERE tenant_id=$1', [tenantId])).rows, profile)
    assert.deepEqual((await client.query('SELECT * FROM plan_versions WHERE id=ANY($1::uuid[]) ORDER BY id', [[oldVersionId, receipt.planVersionId]])).rows, previous)
    assert.deepEqual((await client.query('SELECT * FROM billing.customer_price_entries WHERE price_book_id=ANY($1::uuid[]) ORDER BY id', [[oldBookId, receipt.priceBookId]])).rows, previousEntries)
    assert.deepEqual((await client.query('SELECT * FROM billing.customer_charges WHERE usage_request_id=$1', [usageId])).rows, historicalCharge)
    const auditsAfter = (await client.query('SELECT * FROM consumer_plan_assignment_events WHERE consumer_id=$1 ORDER BY id', [consumerId])).rows
    assert.equal(auditsAfter.length, auditsBefore.length + 1)
    assert.deepEqual(auditsAfter.filter(row => auditsBefore.some(before => before.id === row.id)), auditsBefore)
    const fresh = await readCustomerRestoreInventory(client, { sourceBatch, selections })
    assert.equal(planCustomerRestore({ sourceBatch, inventory: fresh, selections }).blocked[0].reason, 'source_assignment_changed')
    await client.query('ROLLBACK')
    assert.equal((await client.query('SELECT id FROM consumers WHERE id=$1', [consumerId])).rowCount, 0)
    assert.equal((await client.query('SELECT id FROM plan_versions WHERE id=$1', [restoredId])).rowCount, 0)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
    await pool.end()
  }
})

test('PostgreSQL fallback restore creates a null book and rejects changed fallback before writing', {
  skip: connectionString ? false : 'MX_INSIGHT_TEST_DATABASE_URL is not configured',
}, async () => {
  const pool = new pg.Pool({ connectionString, statement_timeout: 10_000 }), client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
    const { tenantId, consumerId, sourceBatch, selections, receipt } = await fixture(client, { fallbackOnly: true })
    const inventory = await readCustomerRestoreInventory(client, { sourceBatch, selections })
    const plan = planCustomerRestore({ sourceBatch, inventory, selections })
    assert.deepEqual(plan.changes[0].entries, [])
    await client.query('SAVEPOINT before_restore')
    await client.query('UPDATE billing.tenant_billing_profiles SET default_unit_price_minor=2,revision=revision+1 WHERE tenant_id=$1', [tenantId])
    await assert.rejects(applyCustomerRestore(client, { batchId: randomUUID(), sourceBatch, plan }), { code: 'customer_restore_stale' })
    assert.equal((await client.query('SELECT plan_version_id FROM consumer_plan_assignments WHERE consumer_id=$1', [consumerId])).rows[0].plan_version_id, receipt.planVersionId)
    await client.query('ROLLBACK TO SAVEPOINT before_restore')
    const applied = await applyCustomerRestore(client, { batchId: randomUUID(), sourceBatch, plan })
    assert.equal(applied[0].priceBookId, null)
    const after = (await readCustomerPriceSyncInventory(client, { meterKeys: [meter], consumerIds: [consumerId] })).consumers[0]
    assert.equal(after.priceBook, null)
    assert.equal(after.profile.defaultUnitPriceMinor, 1)
    assert.equal(after.profile.multiplierPpm, 250_000)
    assert.equal(after.assignment.assignedAt, '2020-09-01T00:00:00.123456Z')
    await client.query('ROLLBACK')
    assert.equal((await client.query('SELECT id FROM plan_versions WHERE id=$1', [applied[0].planVersionId])).rowCount, 0)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
    await pool.end()
  }
})
