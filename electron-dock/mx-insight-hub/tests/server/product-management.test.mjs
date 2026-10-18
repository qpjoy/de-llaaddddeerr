import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readProductManagement, productManagementOperations } from '../../server/operations/product-management.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { ExternalAdmissionPolicyStore } from '../../server/external-platforms/admission-policy.mjs'
import { QIXIN_CONFIG } from '../../server/contracts/enterprise.mjs'
import { createApp } from '../../server/app.mjs'

function fixture() {
  const consumer = { id: randomUUID(), tenantId: randomUUID(), name: 'Synthetic customer', status: 'active' }
  const plan = { status: 'active', versionStatus: 'published', versionId: randomUUID(), priceBook: {
    id: randomUUID(), key: 'synthetic', version: 1, currency: 'CNY', defaultMultiplierPpm: 1000000,
    entries: [{ meterKey: 'enterprise.api.1.43', unitPriceMinor: 12 },
      { meterKey: 'enterprise.api.1.31', unitPriceMinor: 0 }, { meterKey: 'youtube', unitPriceMinor: 3 }],
  } }
  const billing = { profile: { mode: 'enforced', multiplierPpm: 500000, defaultUnitPriceMinor: 7, defaultCurrency: 'USD' } }
  const store = { async listConsumers() { return [consumer] }, async getConsumerPlan() { return plan }, async getTenantBilling() { return billing } }
  const control = new MemoryExternalPlatformControlStore()
  const platformAdmin = { async provisioningContext(provider) { return { control, runtime: {
    config: provider === 'qixin' ? QIXIN_CONFIG : {}, credentialConfigured: false,
  } } } }
  const limits = { maxConcurrency: 10, maxConsumerConcurrency: 10, maxRequestsPerMinute: 30, maxWaitMs: 10000, maxPending: 32 }
  const admissionPolicies = new ExternalAdmissionPolicyStore({ defaultsByProvider: Object.fromEntries(
    ['qixin', 'tikhub', 'rapidapi', 'justone', 'ipsearch', 'baidu-ip'].map(key => [key, limits])) })
  return { consumer, plan, billing, store, platformAdmin, admissionPolicies, control }
}

test('product management scopes operations, quotes actual customer precedence, and never treats unknown price as zero', async () => {
  const f = fixture(), input = { ...f, path: '/data-products/enterprise' }
  const initial = await readProductManagement(input)
  assert.deepEqual(initial.providers.map(row => row.key), ['qixin'])
  assert.equal(initial.providers[0].admission.source, 'deployment')
  assert.ok(initial.customerPrices.every(row => row.status === 'select_consumer' && row.unitPriceMinor === null))
  const snapshot = JSON.stringify({ plan: f.plan, billing: f.billing })
  const result = await readProductManagement({ ...input, consumerId: f.consumer.id })
  const paid = result.customerPrices.find(row => row.meterKey === 'enterprise.api.1.43')
  assert.equal(paid.unitPriceMinor, 6)
  assert.equal(paid.currency, 'CNY')
  assert.equal(paid.status, 'contract')
  assert.deepEqual(paid.paths, ['/api/v1/data/enterprise/1.43/query'])
  const zero = result.customerPrices.find(row => row.meterKey === 'enterprise.api.1.31')
  assert.equal(zero.unitPriceMinor, 0)
  assert.equal(zero.status, 'contract')
  const fallback = result.customerPrices.find(row => row.status === 'account_default')
  assert.equal(fallback.unitPriceMinor, 7, 'tenant default never inherits the plan discount')
  assert.equal(fallback.currency, 'USD', 'no implicit currency conversion')
  assert.equal(JSON.stringify({ plan: f.plan, billing: f.billing }), snapshot)
  assert.equal(f.control.events.length, 0)
  assert.equal(f.admissionPolicies.events.length, 0)
  assert.ok(result.providers[0].operations.some(row => row.procurementReferences.some(price => price.actualChargeVerified === false)))
  assert.equal(JSON.stringify(result).includes('apiKey'), false)
  f.billing.profile.mode = 'shadow'
  const shadow = await readProductManagement({ ...input, consumerId: f.consumer.id })
  assert.equal(shadow.customerPrices.find(row => row.meterKey === paid.meterKey).configuredUnitPriceMinor, 6)
  assert.equal(shadow.customerPrices.find(row => row.meterKey === paid.meterKey).unitPriceMinor, 0)
  f.plan.status = 'paused'
  assert.ok((await readProductManagement({ ...input, consumerId: f.consumer.id })).customerPrices.every(row => row.unitPriceMinor === null && row.status === 'plan_unavailable'))
})

test('standard search and account meters remain separate from native acquisition prices and IP subscription units', async () => {
  const f = fixture()
  const result = await readProductManagement({ ...f, path: '/data-products/strategy-search', consumerId: f.consumer.id })
  assert.equal(result.customerPrices.find(row => row.meterKey === 'youtube').unitPriceMinor, 2, 'ordinary billing rounding is reused')
  assert.ok(result.customerPrices.some(row => row.meterKey === 'social.content.crawl'))
  assert.ok(result.customerPrices.some(row => row.meterKey === 'social.profile.get'))
  assert.ok(result.providers.find(row => row.key === 'tikhub').operations.some(row => row.operationKey.includes('youtube')))
  const ip = await readProductManagement({ ...f, path: '/data-products/ip-risk', consumerId: f.consumer.id })
  assert.deepEqual(ip.providers.map(row => row.key), ['ipsearch', 'baidu-ip'])
  assert.equal(ip.customerPrices.find(row => row.status === 'subscription').unitPriceMinor, null)
  assert.ok(ip.providers.every(row => row.operations.length === 0), 'dedicated IP channel controls are not generic operation switches')
  for (const [path, prefix] of [['wechat-mp', 'native.wechat.mp.'], ['wechat-channels', 'native.wechat.channels.']]) {
    const scoped = productManagementOperations(`/data-products/${path}`).operations
    assert.ok(scoped.length > 0)
    assert.ok(scoped.every(row => row.operation.startsWith(prefix) || row.operation.startsWith('native.wechat.demo.')))
  }
  await assert.rejects(readProductManagement({ ...f, path: '/data-products/unknown' }), { status: 404 })
  await assert.rejects(readProductManagement({ ...f, path: '/data-products/enterprise', consumerId: randomUUID() }), { status: 404 })
})

test('one unavailable provider remains explicit and cannot leak its runtime credential or fabricated prices', async () => {
  const f = fixture()
  f.platformAdmin.provisioningContext = async () => { throw new Error('private upstream credential should never appear') }
  f.admissionPolicies.read = async () => { throw new Error('private database URL') }
  const result = await readProductManagement({ ...f, path: '/data-products/enterprise' })
  assert.equal(result.providers[0].admission, null)
  assert.deepEqual(result.providers[0].operations, [])
  assert.equal(result.providers[0].error.code, 'product_operations_unavailable')
  assert.equal(JSON.stringify(result).includes('private'), false)
})

test('management inventory is Admin Token only, private on Public, strictly filtered and never dispatches', async t => {
  const f = fixture()
  const servers = []
  t.after(async () => Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))))
  async function listen(listenerMode) {
    const server = createServer(createApp({ service: {}, store: f.store, adapter: {}, listenerMode,
      externalPlatformAdmin: f.platformAdmin, externalAdmissionPolicies: f.admissionPolicies,
      adminToken: 'synthetic-product-admin', logger: { error() {} }, identity: { enabled: true,
        async resolve() { return { kind: 'launcher-user', platformAdmin: true, capabilities: [], memberships: [], tenantIds: [] } } } }))
    servers.push(server)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${server.address().port}/internal/v1/admin/data-products/management`
  }
  const base = await listen('combined'), publicBase = await listen('public')
  const path = '?path=%2Fdata-products%2Fenterprise', headers = { 'x-mx-insight-admin-token': 'synthetic-product-admin' }
  assert.equal((await fetch(base + path)).status, 401)
  assert.equal((await fetch(base + path, { headers: { authorization: 'Bearer launcher-admin' } })).status, 403)
  assert.equal((await fetch(publicBase + path, { headers })).status, 404)
  assert.equal((await fetch(base + path + '&unexpected=true', { headers })).status, 400)
  assert.equal((await fetch(base + path + '&path=/data-products/web-search', { headers })).status, 400)
  const response = await fetch(base + path, { headers })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal((await response.json()).data.product.label, '企业数据')
  assert.equal(f.control.events.length + f.admissionPolicies.events.length, 0)
})
