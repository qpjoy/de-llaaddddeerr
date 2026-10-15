import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { PostgresExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { transactionPool } from '../../server/commercial/transaction.mjs'
import { applyProcurementSync, normalizeProcurementSyncRate, planProcurementSync, readProcurementSyncState } from '../../server/commercial/price-sync-procurement.mjs'
import { applyProcurementRestore, planProcurementRestore } from '../../server/commercial/price-sync-restore-procurement.mjs'

const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL || ''
test('PostgreSQL targeted restoration creates immutable history, restores exact evidence and rejects later manual revisions', {
  skip: connectionString ? false : 'MX_INSIGHT_TEST_DATABASE_URL is not configured',
}, async () => {
  const client = new pg.Client({ connectionString, statement_timeout: 15000, lock_timeout: 1000 })
  await client.connect()
  const operationKey = 'ecommerce.products.detail', endpointKey = 'taobao-tmall.product-detail.v1'
  const sourceId = randomUUID(), restoreId = randomUUID(), priorId = randomUUID(), draftId = randomUUID()
  const selections = [`justone:${operationKey}`]
  const insertBatch = (id, kind, preview = {}) => client.query(`INSERT INTO control.provisioning_batches
    (id,specification,preview,preview_hash,status,created_by,expires_at)
    VALUES($1,$2,$3,'isolated-fixture','preview','isolated-test',now()+interval '15 minutes')`, [id, { kind }, preview])
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
    const control = new PostgresExternalPlatformControlStore({ pool: transactionPool(client) })
    const find = async () => (await control.describeProvider('justone')).find(row => row.operationKey === operationKey)
    const before = await find()
    const prepared = await control.updatePolicy('justone', operationKey, {
      expectedRevision: before.revision, desiredState: 'paused', canaryConsumerIds: before.canaryConsumerIds,
      priceBook: { currency: 'CNY', pricingAsOf: '2026-10-01T00:00:00Z', monthlyBudgetMinor: 12345,
        monthlySubsidyBudgetMinor: 0, unitCostMinorByEndpoint: { [endpointKey]: 1 } }, reason: 'Isolated restore fixture',
    })
    const oldExact = normalizeProcurementSyncRate({ provider: 'justone', endpointKey, currency: 'CNY', unitPrice: '0.0038', sourceKind: 'contract',
      sourceUrl: 'https://example.com/synthetic-prior-contract', observedAt: '2026-10-01T00:00:00Z', sourceHash: 'b'.repeat(64),
      flags: { verified: true, priceBasis: 'contract_account_rate', accountSpecific: true } })
    await insertBatch(priorId, 'isolated-reference')
    await client.query(`INSERT INTO control.procurement_price_drafts
      (id,provider_key,specification,specification_hash,created_by) VALUES($1,'justone',$2,'isolated-fixture','isolated-test')`,
    [draftId, { rates: [oldExact] }])
    await client.query(`INSERT INTO control.procurement_price_references
      (provider_key,operation_key,price_book_version,draft_id,batch_id) VALUES('justone',$1,$2,$3,$4)`,
    [operationKey, prepared.priceBook.version, draftId, priorId])
    const rates = [{ ...oldExact, unitPrice: '0.20', observedAt: '2026-10-14T00:00:00Z', sourceHash: 'a'.repeat(64) }]
    const procurement = planProcurementSync({ operations: await readProcurementSyncState(client, { providers: ['justone'] }), rates })
    const preview = { kind: 'price-sync', procurement }
    await insertBatch(sourceId, 'price-sync', preview)
    const result = { batchId: sourceId, status: 'completed', procurement: await applyProcurementSync(client, { batchId: sourceId, plan: procurement }) }
    await client.query(`UPDATE control.provisioning_batches SET status='completed',result=$2,applied_at=now() WHERE id=$1`, [sourceId, result])
    const sourceBatch = (await client.query('SELECT id,status,preview,result FROM control.provisioning_batches WHERE id=$1', [sourceId])).rows[0]
    const synced = await find()
    assert.equal(synced.priceBook.endpointPrices[endpointKey], 20)
    const plan = planProcurementRestore({ sourceBatch, selections,
      operations: await readProcurementSyncState(client, { providers: ['justone'] }) })
    assert.equal(plan.updates.length, 1)
    await insertBatch(restoreId, 'price-sync-restore', plan)

    await client.query('SAVEPOINT later_operator_edit')
    await control.updatePolicy('justone', operationKey, { expectedRevision: synced.revision, desiredState: 'disabled',
      canaryConsumerIds: synced.canaryConsumerIds, reason: 'Isolated later manual edit' })
    const changedPlan = planProcurementRestore({ sourceBatch, selections,
      operations: await readProcurementSyncState(client, { providers: ['justone'] }) })
    assert.equal(changedPlan.updates.length, 0)
    assert.equal(changedPlan.skipped[0].reason, 'operation_changed_after_source_batch')
    await assert.rejects(applyProcurementRestore(client, { batchId: restoreId, sourceBatch, plan }), { code: 'price_restore_changed' })
    await client.query('ROLLBACK TO SAVEPOINT later_operator_edit')
    await client.query('RELEASE SAVEPOINT later_operator_edit')

    await client.query('SAVEPOINT interrupted_restore')
    const failingClient = { query: (...args) => {
      if (String(args[0]).includes('INSERT INTO control.procurement_price_drafts')) throw new Error('Injected restore draft failure')
      return client.query(...args)
    } }
    await assert.rejects(applyProcurementRestore(failingClient, { batchId: restoreId, sourceBatch, plan }), /Injected restore draft failure/)
    await client.query('ROLLBACK TO SAVEPOINT interrupted_restore')
    await client.query('RELEASE SAVEPOINT interrupted_restore')
    assert.equal((await find()).priceBook.version, synced.priceBook.version)
    assert.equal((await find()).revision, synced.revision)

    const restored = await applyProcurementRestore(client, { batchId: restoreId, sourceBatch, plan })
    assert.equal(restored.applied.length, 1)
    const after = await find()
    assert.equal(after.desiredState, 'paused')
    assert.deepEqual(after.canaryConsumerIds, synced.canaryConsumerIds)
    assert.equal(after.priceBook.monthlyBudgetMinor, 12345)
    assert.equal(after.priceBook.monthlySubsidyBudgetMinor, 0)
    assert.equal(after.priceBook.endpointPrices[endpointKey], 1)
    assert.notEqual(after.priceBook.version, prepared.priceBook.version)
    assert.notEqual(after.priceBook.version, synced.priceBook.version)
    const restoredState = (await readProcurementSyncState(client, { providers: ['justone'] })).find(row => row.operationKey === operationKey)
    assert.deepEqual(restoredState.exactRates, [oldExact])
    const historical = (await client.query(`SELECT price_book_version::text,unit_cost_minor::text
      FROM control.external_platform_provider_price_book_entries WHERE provider_key='justone'
      AND endpoint_key=$1 AND price_book_version=ANY($2::bigint[]) ORDER BY price_book_version`,
    [endpointKey, [prepared.priceBook.version, synced.priceBook.version]])).rows
    assert.deepEqual(historical.map(row => row.unit_cost_minor), ['1', '20'])
    const savedSource = (await client.query('SELECT id,status,preview,result FROM control.provisioning_batches WHERE id=$1', [sourceId])).rows[0]
    assert.deepEqual(savedSource, sourceBatch)
    await assert.rejects(applyProcurementRestore(client, { batchId: restoreId, sourceBatch, plan }), { code: 'price_restore_changed' })
  } finally { await client.query('ROLLBACK').catch(() => {}); await client.end() }
})
