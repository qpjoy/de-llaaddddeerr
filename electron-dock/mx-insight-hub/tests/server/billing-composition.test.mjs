import test from 'node:test'
import assert from 'node:assert/strict'
import { compileBillingComponents } from '../../shared/billing-composition.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const feature = key => ({ type: 'feature', key, version: 1 })
const body = (key, components, entries) => ({
  key, name: key, components,
  limits: { monthlyRequests: 10000, maxPageSize: 100, burstRps: 100 },
  priceBook: { key, currency: 'CNY', defaultMultiplierPpm: 1000000, ...(entries ? { entries } : {}) },
})

test('published composition flattens rates and pins source versions without repricing existing callers', async () => {
  const service = new HubService({ store: new MemoryStore(), adapter: {}, apiKeyPepper: 'composition-test-pepper-at-least-32-bytes' })
  const tenant = await service.createTenant({ name: 'Tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Old Xiaohongshu customer' })
  const old = await service.publishPlanVersion(body('social', [feature('xiaohongshu')]), 'admin')
  const current = await service.getConsumerPlan(consumer.id)
  await service.assignConsumerPlan(consumer.id, { planVersionId: old.versionId, expectedRevision: current.revision }, 'admin')
  const combination = await service.publishPlanVersion(body('combined', [{ type: 'plan', versionId: old.versionId }, feature('ip-risk')]), 'admin')
  assert.equal(combination.priceBook.entries.length, 5)
  assert.equal(combination.priceBook.entries.find(entry => entry.meterKey === 'ip.risk.query').unitPriceMinor, 5)
  assert.equal(combination.priceBook.entries.find(entry => entry.meterKey === 'social.posts.search').unitPriceMinor, 10)
  assert.equal(combination.pricing.components[0].versionId, old.versionId)
  assert.equal((await service.getConsumerPlan(consumer.id)).versionId, old.versionId)
  await service.publishPlanVersion(body('social', [], [{ meterKey: 'social.posts.search', unitPriceMinor: 20 }]), 'admin')
  assert.equal((await service.getConsumerPlan(consumer.id)).priceBook.entries.find(entry => entry.meterKey === 'social.posts.search').unitPriceMinor, 10)
  const assigned = await service.getConsumerPlan(consumer.id)
  await service.assignConsumerPlan(consumer.id, { planVersionId: combination.versionId, expectedRevision: assigned.revision }, 'admin')
  assert.equal((await service.getConsumerPlan(consumer.id)).priceBook.entries.find(entry => entry.meterKey === 'social.posts.search').unitPriceMinor, 10)
  assert.equal((await service.listPlans()).find(plan => plan.versionId === combination.versionId).pricing.components[0].versionId, old.versionId)
})

test('composition rejects ambiguous sources, mixed currencies, duplicates and unresolved price conflicts', () => {
  const plan = { key: 'custom', name: 'Custom', version: 1, versionId: 'version-a', versionStatus: 'published', priceBook: { currency: 'CNY', entries: [{ meterKey: 'ip.risk.query', unitPriceMinor: 10 }] } }
  const components = [feature('ip-risk'), { type: 'plan', versionId: plan.versionId }]
  assert.throws(() => compileBillingComponents(components, [plan], 'CNY'), /冲突/)
  assert.throws(() => compileBillingComponents([feature('ip-risk')], [], 'USD'), /币种/)
  assert.throws(() => compileBillingComponents([feature('ip-risk'), feature('ip-risk')], [], 'CNY'), /重复/)
  assert.throws(() => compileBillingComponents([{ type: 'plan', versionId: 'missing' }], [], 'CNY'), /不存在/)
  assert.throws(() => compileBillingComponents([{ ...feature('ip-risk'), version: 99 }], [], 'CNY'), /不存在/)
  const final = [{ meterKey: 'ip.risk.query', unitPriceMinor: 7, billingUnit: 'request' }]
  assert.deepEqual(compileBillingComponents(components, [plan], 'CNY', final).entries, final)
  assert.deepEqual(compileBillingComponents([feature('xiaohongshu')], [], 'CNY', final).entries, final, 'explicit editor table is complete; deleted source meters do not reappear')
})

test('260 official Qixin rates can be adjusted, combined, published and assigned without changing existing prices or grants', async () => {
  const service = new HubService({ store: new MemoryStore(), adapter: {}, apiKeyPepper: 'composition-test-pepper-at-least-32-bytes' })
  const tenant = await service.createTenant({ name: 'Qixin customer' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'LCY-delta fixture' })
  const old = await service.publishPlanVersion(body('existing', [feature('ip-risk'), feature('xiaohongshu')]), 'admin')
  const qixin = { ...feature('qixin'), multiplierPpm: 1_200_000 }
  const result = await service.publishPlanVersion(body('enterprise-combined', [{ type: 'plan', versionId: old.versionId }, qixin]), 'admin')
  assert.equal(result.priceBook.entries.length, 265)
  const rates = new Map(result.priceBook.entries.map(entry => [entry.meterKey, entry.unitPriceMinor]))
  assert.equal(rates.get('enterprise.api.47.51'), 360)
  assert.equal(rates.get('enterprise.api.36.99'), 0)
  assert.ok(!rates.has('enterprise.api.55.82'), 'negotiated API is excluded')
  assert.equal(rates.get('ip.risk.query'), 5)
  assert.equal(rates.get('social.posts.resolve'), 10)
  assert.equal(result.pricing.components[1].multiplierPpm, 1_200_000)
  assert.ok(result.pricing.components[1].pricingAsOf)
  const current = await service.getConsumerPlan(consumer.id)
  await service.assignConsumerPlan(consumer.id, { planVersionId: result.versionId, expectedRevision: current.revision }, 'admin')
  assert.equal((await service.getConsumerPlan(consumer.id)).priceBook.entries.length, 265)
  assert.deepEqual(await service.store.listGrants(consumer.id), [])
  const discounted = compileBillingComponents([{ ...qixin, multiplierPpm: 900_000 }], [], 'CNY')
  assert.equal(discounted.entries.find(entry => entry.meterKey === 'enterprise.api.47.51').unitPriceMinor, 270)
  assert.throws(() => compileBillingComponents([{ ...qixin, multiplierPpm: -1 }], [], 'CNY'), /倍率/)
})
