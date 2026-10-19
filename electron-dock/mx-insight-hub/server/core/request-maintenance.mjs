// Opportunistic request housekeeping is shared by every gateway using a pool.
// It is not authorization/request-state caching. Explicit administrative reaps
// still call the store directly, and paid dispatch always checks current state.
const maintenanceByPool = new WeakMap()
const METHODS = new Set(['reapStaleReservations', 'reapStaleCalls'])

export function requestMaintenance(store, method = 'reapStaleReservations') {
  if (!METHODS.has(method)) throw new TypeError('Unknown request maintenance operation')
  if (typeof store?.[method] !== 'function') return Promise.resolve(0)
  // Memory/test stores keep their synchronous lifecycle semantics.
  if (!store.pool) return store[method]()
  let operations = maintenanceByPool.get(store.pool)
  if (!operations) { operations = new Map(); maintenanceByPool.set(store.pool, operations) }
  let state = operations.get(method)
  if (!state) { state = { pending: null, completedAt: null }; operations.set(method, state) }
  if (state.pending) return state.pending
  const now = Date.now()
  // The next request may start another bounded pass after this interval;
  // remaining backlog/locked rows keep conservative holds for later passes.
  // Never cache a failure, or skip after clock rollback.
  if (state.completedAt != null && now >= state.completedAt && now - state.completedAt < 1000) return Promise.resolve(0)
  state.pending = Promise.resolve().then(() => store[method]()).then(result => {
    state.completedAt = Date.now()
    return result
  }).finally(() => { state.pending = null })
  return state.pending
}
