// How many API processes share this pod, and this process's share of a
// pod-wide limit.
//
// The Public API runs several processes behind one host port (see
// server/core/api-processes.mjs). Limits that protect an upstream provider --
// gateway concurrency, pending waiters, product-image relays -- are kept in
// process memory, so each process takes its share and the pod as a whole still
// honours what the operator configured. Budgets documented as per process (the
// data API execution lanes, connection pools) are sized separately.

let processes = 1

export function setApiProcessCount(count) {
  const value = Math.floor(Number(count))
  processes = Number.isFinite(value) && value > 1 ? value : 1
}

export function apiProcessCount() {
  return processes
}

/** This process's share of a pod-wide limit: rounded up, never below 1. */
export function processShareOf(limit) {
  if (processes === 1) return limit
  const value = Number(limit)
  if (!Number.isFinite(value) || value <= 0) return limit
  return Math.max(1, Math.ceil(value / processes))
}
