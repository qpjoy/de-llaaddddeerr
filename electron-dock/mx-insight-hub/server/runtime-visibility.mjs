const VISIBLE_DEPENDENCY_STATUSES = new Set(['up', 'down'])

function visibleStatus(entry) {
  return VISIBLE_DEPENDENCY_STATUSES.has(entry?.status) ? entry.status : 'unknown'
}

/**
 * Health probes and tenant-facing Runtime views expose only aggregate service
 * state. External acquisition is deliberately not probed by these endpoints;
 * older raw dependency shapes are still projected without provider details.
 */
export function runtimeVisibleDependencies(dependencies) {
  const source = dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies)
    ? dependencies
    : {}
  return {
    store: { status: visibleStatus(source.store) },
    dataService: { status: visibleStatus(source.dataService ?? source.nightAll) },
  }
}

export function runtimeVisibleProjection(runtime) {
  const source = runtime?.dependencies && typeof runtime.dependencies === 'object'
    && !Array.isArray(runtime.dependencies)
    ? runtime.dependencies
    : {}
  // Provider-backed data services are optional capability dependencies. Their
  // aggregate state may be unknown because Runtime does not probe them, and it
  // must not make the Hub API, Admin sign-in or stored data products unready.
  // PostgreSQL is the only dependency shared by every supported listener mode.
  const requiredDependencies = [source.store]

  return {
    status: {
      live: 'live',
      ready: requiredDependencies.every((entry) => entry?.status === 'up')
        ? 'ready'
        : 'not_ready',
    },
    dependencies: runtimeVisibleDependencies(runtime?.dependencies),
  }
}
