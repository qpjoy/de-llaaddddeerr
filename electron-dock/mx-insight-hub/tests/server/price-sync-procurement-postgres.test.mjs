import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { PostgresExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { transactionPool } from '../../server/commercial/transaction.mjs'
import { applyProcurementSync, planProcurementSync, readProcurementSyncState } from '../../server/commercial/price-sync-procurement.mjs'

// Only an explicitly configured, migrated disposable database. The enclosing
// transaction is rolled back even after successful assertions; no paid calls.
const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL || ''
test('PostgreSQL price-only sync binds exact evidence and keeps versions immutable inside the caller transaction', {
  skip: connectionString ? false : 'MX_INSIGHT_TEST_DATABASE_URL is not configured',
}, async () => {
  const client = new pg.Client({ connectionString, statement_timeout: 15000, lock_timeout: 1000 })
  await client.connect()
  const operationKey = 'ecommerce.products.detail', endpointKey = 'taobao-tmall.product-detail.v1'
  const batchId = randomUUID()
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
    const control = new PostgresExternalPlatformControlStore({ pool: transactionPool(client) })
    const before = (await control.describeProvider('justone')).find(row => row.operationKey === operationKey)
    const prepared = await control.updatePolicy('justone', operationKey, {
      expectedRevision: before.revision, desiredState: 'paused', canaryConsumerIds: before.canaryConsumerIds,
      priceBook: { currency: 'CNY', pricingAsOf: '2026-10-14T00:00:00Z', monthlyBudgetMinor: 12345,
        monthlySubsidyBudgetMinor: 0, unitCostMinorByEndpoint: { [endpointKey]: 107 } }, reason: 'Isolated test setup',
    })
    const rates = [{ provider: 'justone', endpointKey, currency: 'CNY', unitPrice: '0.0038', sourceKind: 'contract',
      sourceUrl: 'https://example.com/synthetic-account-price', observedAt: '2026-10-14T00:00:00Z', sourceHash: 'a'.repeat(64),
      flags: { verified: true, priceBasis: 'contract_account_rate', accountSpecific: true, actualChargeVerified: false } }]
    const operations = await readProcurementSyncState(client, { providers: ['justone'] })
    const plan = planProcurementSync({ operations, rates })
    await client.query(`INSERT INTO control.provisioning_batches
      (id,specification,preview,preview_hash,status,created_by,expires_at)
      VALUES($1,$2,$3,$4,'preview','isolated-test',now()+interval '15 minutes')`,
    [batchId, { kind: 'price-sync' }, plan, 'synthetic-preview-hash'])
    await client.query('SAVEPOINT injected_failure')
    const failingClient = { query: (...args) => {
      if (String(args[0]).includes('INSERT INTO control.procurement_price_drafts')) throw new Error('Injected draft write failure')
      return client.query(...args)
    } }
    await assert.rejects(applyProcurementSync(failingClient, { batchId, plan }), /Injected draft write failure/)
    await client.query('ROLLBACK TO SAVEPOINT injected_failure')
    await client.query('RELEASE SAVEPOINT injected_failure')
    const rolledBack = (await control.describeProvider('justone')).find(row => row.operationKey === operationKey)
    assert.equal(rolledBack.revision, prepared.revision)
    assert.equal(rolledBack.priceBook.version, prepared.priceBook.version)
    assert.equal(rolledBack.desiredState, 'paused')
    const result = await applyProcurementSync(client, { batchId, plan })
    assert.equal(result.applied.length, 1)
    const after = (await control.describeProvider('justone')).find(row => row.operationKey === operationKey)
    assert.equal(after.desiredState, 'paused')
    assert.deepEqual(after.canaryConsumerIds, before.canaryConsumerIds)
    assert.equal(after.priceBook.monthlyBudgetMinor, 12345)
    assert.equal(after.priceBook.monthlySubsidyBudgetMinor, 0)
    assert.equal(after.priceBook.endpointPrices[endpointKey], 1)
    assert.notEqual(after.priceBook.version, prepared.priceBook.version)
    const old = (await client.query(`SELECT unit_cost_minor::text FROM control.external_platform_provider_price_book_entries
      WHERE provider_key='justone' AND price_book_version=$1 AND endpoint_key=$2`, [prepared.priceBook.version, endpointKey])).rows[0]
    assert.equal(old.unit_cost_minor, '107')
    const draft = (await client.query(`SELECT d.specification FROM control.procurement_price_references r
      JOIN control.procurement_price_drafts d ON d.id=r.draft_id WHERE r.batch_id=$1`, [batchId])).rows[0]
    assert.equal(draft.specification.rates[0].amountMicros, '3800')
    assert.equal(draft.specification.rates[0].budgetMinor, 1)
    assert.deepEqual(draft.specification.rates[0].flags, rates[0].flags)
    const next = planProcurementSync({ operations: await readProcurementSyncState(client, { providers: ['justone'] }), rates })
    assert.equal(next.updates.length, 0)
    await assert.rejects(applyProcurementSync(client, { batchId, plan }), { code: 'price_sync_changed' })
  } finally { await client.query('ROLLBACK').catch(() => {}); await client.end() }
})
