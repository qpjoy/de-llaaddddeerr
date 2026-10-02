import { createOrder, transitionOrder, settingsInput, requestKey, fingerprint, environment, requirePayment, fields } from '@qpjoy/mx-pay'
import { PaymentStore } from './store.mjs'

export class PaymentService {
  constructor(hubStore) { this.hub = hubStore; this.store = new PaymentStore(hubStore) }
  async channels() {
    const settings = await this.store.settings()
    return { storage: this.store.pool ? 'postgres' : 'memory', live: { provider: 'manual_alipay', enabled: settings.enabled, payeeName: settings.enabled ? settings.payeeName : null }, test: { provider: 'mock', enabled: true }, minMinor: 500, maxMinor: 10_000_000, currency: 'CNY' }
  }
  async configure(body, actor) {
    const input = settingsInput(body)
    return this.store.atomic('settings', async client => {
      const current = await this.store.settings(client)
      requirePayment(body.expectedRevision === current.revision, 'payment_revision_conflict', '收款配置已改变，请刷新后重试', 409)
      // The identifier is the provider account's reconciliation identity, not a
      // display label. Keep it stable; multiple payees are a later rollout.
      requirePayment(!current.merchantAccountId || input.merchantAccountId === current.merchantAccountId, 'payment_account_immutable', '收款账户标识不可改名；更换收款主体需要独立渠道', 409)
      const result = { ...input, revision: current.revision + 1, updatedAt: new Date().toISOString(), updatedBy: actor }
      await this.store.saveSettings(result, client)
      await this.store.event({ updatedAt: result.updatedAt, revision: result.revision, status: result.enabled ? 'channel_enabled' : 'channel_disabled' }, 'configure', `config:${result.revision}`, fingerprint(input), actor, client)
      return result
    })
  }
  async create(tenantId, input, key, actor) {
    fields(input, ['environment', 'amountMinor'])
    requestKey(key); environment(input.environment)
    const hash = fingerprint(input)
    return this.store.atomic(`tenant:${tenantId}`, async client => {
      const prior = await this.store.findCreated(tenantId, input.environment, key, client)
      if (prior) { requirePayment(prior.fingerprint === hash, 'payment_idempotency_conflict', '相同请求编号不能更换金额或环境', 409); return prior.document }
      const tenant = client ? (await client.query('SELECT status FROM tenants WHERE id=$1', [tenantId])).rows[0] : await this.hub.getTenant(tenantId)
      requirePayment(tenant?.status === 'active', 'payment_tenant_unavailable', '租户不存在或已停用', 409)
      if (input.environment === 'live') {
        const billing = client ? { account: (await client.query('SELECT currency,status FROM billing.credit_accounts WHERE tenant_id=$1', [tenantId])).rows[0] } : await this.hub.getTenantBilling(tenantId)
        requirePayment(!billing.account || (billing.account.currency === 'CNY' && billing.account.status === 'active'), 'payment_wallet_unavailable', '当前钱包不支持人民币充值', 409)
      }
      const order = createOrder({ tenantId, input, settings: await this.store.settings(client), actor })
      await this.store.insert(order, key, hash, client)
      await this.store.event(order, 'create', `create:${key}`, hash, actor, client)
      return order
    })
  }
  async act(tenantId, id, action, body, key, { actor, finance = false }) {
    requestKey(key)
    const hash = fingerprint({ action, body })
    return this.store.atomic(`order:${id}`, async client => {
      const order = await this.store.order(id, tenantId, client)
      const previous = await this.store.eventFor(id, key, client)
      if (previous) { requirePayment(previous.fingerprint === hash, 'payment_idempotency_conflict', '请求编号已用于其他订单操作', 409); return order }
      const next = transitionOrder(order, action, body, { actor, finance })
      // Receipt uniqueness and wallet credit commit together. Duplicate receipts
      // roll back the new credit, including its existing balance trigger.
      if (action === 'confirm') {
        next.settlement.ledgerEntryId = await this.store.credit(next, actor, client)
      }
      await this.store.save(next, client)
      await this.store.event(next, action, key, hash, actor, client)
      return next
    })
  }
}
