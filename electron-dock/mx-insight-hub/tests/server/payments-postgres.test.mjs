import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { PaymentService } from '../../server/payments/service.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL || ''
test('PostgreSQL payments: concurrent settlement, receipt uniqueness, test isolation and late rollback', {
  skip: connectionString ? false : 'Disposable PostgreSQL with migration 122 required',
}, async () => {
  const pool = new pg.Pool({ connectionString, max: 12, statement_timeout: 15000 })
  try {
    const tenantId = randomUUID(), otherId = randomUUID()
    await pool.query("INSERT INTO tenants(id,name) VALUES ($1,'mx-pay PG test'),($2,'mx-pay other test')", [tenantId, otherId])
    const store = new PostgresStore(pool), payments = new PaymentService(store)
    const current = await payments.store.settings()
    await payments.configure({ expectedRevision: current.revision, enabled: true, merchantAccountId: current.merchantAccountId || 'pg-test-payee', payeeName: 'Test payee', qrImage: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jIUkAAAAASUVORK5CYII=', instructions: 'Test only' }, 'test-admin')
    const finance = { actor: 'test-admin', finance: true }
    async function pending(id, environment = 'live') {
      const order = await payments.create(id, { environment, amountMinor: 1200 }, randomUUID(), 'test-user')
      return payments.act(id, order.id, 'submit', { expectedRevision: 0, payerName: 'Test payer', tradeNo: 'PAY-USER-123' }, randomUUID(), { actor: 'test-user' })
    }
    const a = await pending(tenantId), b = await pending(otherId), mock = await pending(tenantId, 'test')
    const receipt = randomUUID(), confirmKey = randomUUID()
    const confirm = { expectedRevision: 1, tradeNo: receipt, receivedAmountMinor: 1200, feeMinor: 0, paidAt: new Date().toISOString(), note: 'PG test settlement' }
    const results = await Promise.all(Array.from({ length: 6 }, () => payments.act(tenantId, a.id, 'confirm', confirm, confirmKey, finance)))
    assert.equal(new Set(results.map(row => row.settlement.ledgerEntryId)).size, 1)
    assert.equal((await pool.query('SELECT available_minor FROM billing.credit_accounts WHERE tenant_id=$1', [tenantId])).rows[0].available_minor, '1200')
    await assert.rejects(payments.act(otherId, b.id, 'confirm', confirm, randomUUID(), finance), { code: 'payment_receipt_used' })
    assert.equal((await pool.query('SELECT id FROM billing.credit_accounts WHERE tenant_id=$1', [otherId])).rowCount, 0)
    assert.equal((await payments.store.order(b.id)).status, 'submitted')
    const original = payments.store.event.bind(payments.store)
    payments.store.event = async () => { throw Error('late audit failure') }
    await assert.rejects(payments.act(otherId, b.id, 'confirm', { ...confirm, tradeNo: randomUUID() }, randomUUID(), finance), /late audit failure/u)
    payments.store.event = original
    assert.equal((await pool.query('SELECT id FROM billing.credit_accounts WHERE tenant_id=$1', [otherId])).rowCount, 0)
    const testPaid = await payments.act(tenantId, mock.id, 'confirm', confirm, randomUUID(), finance)
    assert.equal((await pool.query('SELECT available_minor FROM billing.credit_accounts WHERE tenant_id=$1', [tenantId])).rows[0].available_minor, '1200')
    assert.equal((await pool.query('SELECT id FROM mx_pay.test_credits WHERE order_id=$1', [mock.id])).rows[0].id, testPaid.settlement.ledgerEntryId)
    const invoice = await payments.act(tenantId, a.id, 'invoice-request', { expectedRevision: 2, companyName: 'PG test company', taxNumber: '91310000TEST000001', email: 'test@example.test' }, randomUUID(), { actor: 'test-user' })
    assert.equal(invoice.invoice.status, 'requested')
    await assert.rejects(pool.query("UPDATE mx_pay.orders SET document=jsonb_set(document,'{amountMinor}','500') WHERE id=$1", [a.id]), /immutable|rewritten/u)
    await assert.rejects(pool.query('DELETE FROM mx_pay.events WHERE order_id=$1', [a.id]), /append-only/u)
    const listed = await payments.store.list({ environment: 'live', tenantId, invoiceStatus: 'requested' })
    assert.equal(listed.items.length, 1); assert.equal(listed.items[0].checkout, undefined)
    // A reconstructed service sees committed orders (not process-local memory).
    assert.equal((await new PaymentService(new PostgresStore(pool)).store.order(a.id)).status, 'paid')
  } finally { await pool.end() }
})
