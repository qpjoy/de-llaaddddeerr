export function selectVisibleTenantId(tenants, requestedTenantId, { aggregateWhenEmpty = false } = {}) {
  const items = Array.isArray(tenants) ? tenants : []
  const requested = String(requestedTenantId || '')
  if (!requested && aggregateWhenEmpty) return ''
  return items.some((tenant) => tenant?.id === requested) ? requested : items[0]?.id || ''
}
