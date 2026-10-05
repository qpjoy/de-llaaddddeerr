import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { PaymentService } from '../../server/payments/service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { createApp } from '../../server/app.mjs'
import { capabilitiesForRole } from '../../server/identity/index.mjs'

const qrImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jIUkAAAAASUVORK5CYII='
const config = { expectedRevision: 0, enabled: true, merchantAccountId: 'alipay-test-fixture', payeeName: '测试收款人', qrImage, instructions: '测试图片，不可付款' }
const finance = { actor: 'admin-token', finance: true }
async function fixture() {
  const store = new MemoryStore(), service = new HubService({ store, adapter: {}, apiKeyPepper: 'mx-pay-tests-pepper-at-least-32-bytes' })
  const tenant = await service.createTenant({ name: 'Payments test' }), other = await service.createTenant({ name: 'Other test' })
  const payments = new PaymentService(store)
  return { store, service, tenant, other, payments }
}
async function submitted(payments, tenantId, environment = 'live') {
  const created = await payments.create(tenantId, { environment, amountMinor: 10000 }, randomUUID(), 'user')
  return payments.act(tenantId, created.id, 'submit', { expectedRevision: 0, payerName: '付款人', tradeNo: 'TEST-USER-001' }, randomUUID(), { actor: 'user' })
}
function confirmation(order, tradeNo = randomUUID()) { return { expectedRevision: order.revision, tradeNo, receivedAmountMinor: order.amountMinor, feeMinor: 10, paidAt: new Date().toISOString(), note: '已检查真实账单（测试夹具）' } }

test('live recharge is idempotent, funds the existing wallet once, and supports a single invoice lifecycle', async () => {
  const { payments, service, tenant } = await fixture()
  await payments.configure(config, 'admin-token')
  const input = { environment: 'live', amountMinor: 10000 }, key = randomUUID()
  const orders = await Promise.all(Array.from({ length: 6 }, () => payments.create(tenant.id, input, key, 'user')))
  assert.equal(new Set(orders.map(row => row.id)).size, 1)
  await assert.rejects(payments.create(tenant.id, { ...input, amountMinor: 500 }, key, 'user'), { code: 'payment_idempotency_conflict' })
  let order = await payments.act(tenant.id, orders[0].id, 'submit', { expectedRevision: 0, payerName: '付款人', tradeNo: 'ALI-001' }, randomUUID(), { actor: 'user' })
  assert.equal((await service.getTenantBilling(tenant.id)).account, null)
  const confirm = confirmation(order), confirmKey = randomUUID()
  const settled = await Promise.all(Array.from({ length: 8 }, () => payments.act(tenant.id, order.id, 'confirm', confirm, confirmKey, finance)))
  order = settled[0]
  let billing = await service.getTenantBilling(tenant.id)
  assert.equal(billing.account.availableMinor, 10000); assert.equal(billing.ledger.length, 1)
  assert.equal(billing.profile.mode, 'disabled', 'recharge never turns on billing')
  assert.equal(billing.ledger[0].id, order.settlement.ledgerEntryId)
  await assert.rejects(payments.act(tenant.id, order.id, 'confirm', confirmation(order), randomUUID(), finance), { code: 'payment_state_conflict' })
  order = await payments.act(tenant.id, order.id, 'invoice-request', { expectedRevision: 2, companyName: '测试公司', taxNumber: '91310000TEST000001', email: 'finance@example.test' }, randomUUID(), { actor: 'user' })
  assert.equal((await payments.store.invoiceTasks()).live, 1)
  const issued = await payments.act(tenant.id, order.id, 'invoice-resolve', { expectedRevision: 3, status: 'issued', invoiceNumber: 'TEST-INVOICE-001', reason: '已人工交付（测试）' }, randomUUID(), finance)
  assert.equal(issued.invoice.status, 'issued')
  assert.equal((await payments.store.invoiceTasks()).live, 0)
  billing = await service.getTenantBilling(tenant.id)
  assert.equal(billing.account.availableMinor, 10000); assert.equal(billing.ledger.length, 1)
})

test('cross-tenant duplicate receipts and late failures roll back wallet and payment state', async () => {
  const { payments, service, tenant, other } = await fixture()
  await payments.configure(config, 'admin-token')
  const a = await submitted(payments, tenant.id), b = await submitted(payments, other.id)
  await payments.act(tenant.id, a.id, 'confirm', confirmation(a, 'DUPLICATE-001'), randomUUID(), finance)
  await assert.rejects(payments.act(other.id, b.id, 'confirm', confirmation(b, 'DUPLICATE-001'), randomUUID(), finance), { code: 'payment_receipt_used' })
  assert.equal((await service.getTenantBilling(other.id)).account, null)
  assert.equal((await payments.store.order(b.id)).status, 'submitted')
  const original = payments.store.event.bind(payments.store)
  payments.store.event = async () => { throw Error('simulated audit write failure') }
  await assert.rejects(payments.act(other.id, b.id, 'confirm', confirmation(b), randomUUID(), finance), /audit write failure/u)
  payments.store.event = original
  assert.equal((await service.getTenantBilling(other.id)).account, null)
  assert.equal((await payments.store.order(b.id)).status, 'submitted')
})

test('mock settlement cannot credit a live wallet; disabled channels and stale revisions fail closed', async () => {
  const { payments, service, tenant } = await fixture()
  await assert.rejects(payments.create(tenant.id, { environment: 'live', amountMinor: 500 }, randomUUID(), 'user'), { code: 'payment_channel_disabled' })
  const order = await submitted(payments, tenant.id, 'test')
  await assert.rejects(payments.act(tenant.id, order.id, 'confirm', { ...confirmation(order), expectedRevision: 0 }, randomUUID(), finance), { code: 'payment_revision_conflict' })
  const paid = await payments.act(tenant.id, order.id, 'confirm', confirmation(order), randomUUID(), finance)
  assert.equal(paid.environment, 'test'); assert.equal((await service.getTenantBilling(tenant.id)).account, null)
  assert.equal(payments.store.memory.testCredits.length, 1)
  const live = await payments.store.list({ tenantId: tenant.id, environment: 'live' })
  assert.equal(live.items.length, 0)
})

test('HTTP payment routes preserve console auth and tenant boundaries; API keys/public listener cannot settle', async t => {
  const { service, store, tenant, other, payments } = await fixture()
  const owner = { kind: 'launcher', memberId: randomUUID(), platformAdmin: false, tenantIds: [tenant.id], capabilities: capabilitiesForRole('owner'), memberships: [{ tenantId: tenant.id, role: 'owner', status: 'active' }] }
  const viewer = { ...owner, capabilities: capabilitiesForRole('viewer'), memberships: [{ tenantId: tenant.id, role: 'viewer', status: 'active' }] }
  const identity = { enabled: true, resolve: async token => token === 'owner-token' ? owner : token === 'viewer-token' ? viewer : null }
  async function listen(listenerMode) {
    const server = createServer(createApp({ service, store, identity, adminToken: 'admin-token', adapter: {}, listenerMode, logger: { error() {} } }))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
    return `http://127.0.0.1:${server.address().port}`
  }
  const base = await listen('combined'), publicBase = await listen('public')
  const root = '/internal/v1/admin/payments'
  const call = (path, { token = 'owner-token', method = 'GET', body, host = base } = {}) => fetch(`${host}${root}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: body ? JSON.stringify(body) : undefined })
  assert.equal((await call('/settings')).status, 403)
  assert.equal((await call(`/orders?environment=test&tenantId=${other.id}`)).status, 403)
  assert.equal((await call('/orders?environment=test')).status, 403)
  assert.equal((await call(`/channels?tenantId=${tenant.id}`, { token: 'viewer-token' })).status, 403)
  assert.equal((await call(`/channels?tenantId=${tenant.id}`, { token: 'mih_live_bad' })).status, 403)
  assert.equal((await call('/settings', { token: 'admin-token', host: publicBase })).status, 404)
  const created = await call(`/tenants/${tenant.id}/orders`, { method: 'POST', body: { environment: 'test', amountMinor: 500 } })
  assert.equal(created.status, 201); assert.match(created.headers.get('cache-control'), /no-store/u)
  const order = (await created.json()).data
  assert.equal((await call(`/tenants/${other.id}/orders/${order.id}`, { token: 'admin-token' })).status, 404)
  assert.equal((await call(`/tenants/${tenant.id}/orders/${order.id}/confirm`, { method: 'POST', body: confirmation(order) })).status, 403)
  assert.equal((await call(`/tenants/${tenant.id}/orders`, { method: 'POST', body: { environment: 'test', amountMinor: 500, status: 'paid' } })).status, 400)
  assert.equal((await call('/orders?environment=test&environment=live', { token: 'admin-token' })).status, 400)
  const session = await fetch(`${base}/internal/v1/admin/session`, { headers: { authorization: 'Bearer owner-token' } })
  assert.equal(session.status, 200)
  assert.equal((await payments.store.list({ tenantId: tenant.id, environment: 'test' })).items.length, 1)
})
