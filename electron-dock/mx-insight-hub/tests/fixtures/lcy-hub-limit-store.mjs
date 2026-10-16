import { MemoryStore } from '../../server/stores/memory-store.mjs'

// Synthetic store with the deployment's immutable identity, never its secret.
export const LCY_IDENTITY = Object.freeze({
  key: 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83',
  tenant: '277bf8a4-5ed5-414d-b429-d72fcd7d36b6',
  consumer: 'be7d07fe-3d98-4db3-b00d-e5cbe5a76190',
})
export class LcyHubLimitStore extends MemoryStore {
  constructor(hubRateLimitExempt = true) { super(); this.fixtureExempt = hubRateLimitExempt }
  async createTenant(input) {
    const row = await super.createTenant(input)
    this.tenants.delete(row.id); row.id = LCY_IDENTITY.tenant; this.tenants.set(row.id, row)
    return structuredClone(row)
  }
  async createConsumer(input) {
    const row = await super.createConsumer(input), old = row.id
    row.id = LCY_IDENTITY.consumer
    this.consumers.delete(old); this.consumers.set(row.id, row)
    for (const property of ['consumerPlans', 'grants', 'capabilityGrants', 'capabilityPolicies', 'policies']) {
      const map = this[property]
      if (!(map instanceof Map)) continue
      for (const [key, value] of [...map]) if (String(key).includes(old)) {
        map.delete(key)
        map.set(String(key).replaceAll(old, row.id), JSON.parse(JSON.stringify(value).replaceAll(old, row.id)))
      }
    }
    return structuredClone(row)
  }
  async createApiKey(input) {
    if (this.fixtureKeyCreated) return super.createApiKey(input)
    this.fixtureKeyCreated = true
    const row = await super.createApiKey({ ...input, id: LCY_IDENTITY.key })
    Object.assign(this.apiKeys.get(row.id), { hubRateLimitExempt: this.fixtureExempt, accessProfile: 'managed_full' })
    return row
  }
}
