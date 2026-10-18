// PostgreSQL's delivery lease is shared across supplier stores. Mirror that
// ownership in memory without sharing supplier calls, costs or other platforms.
const leasesByUsageStore = new WeakMap()

export function twitterDeliveryLeases(usageStore) {
  if (!leasesByUsageStore.has(usageStore)) leasesByUsageStore.set(usageStore, new Map())
  return leasesByUsageStore.get(usageStore)
}
