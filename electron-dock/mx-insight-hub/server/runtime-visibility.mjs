const VISIBLE_DEPENDENCY_STATUSES = new Set(['up', 'down'])

function visibleStatus(entry) {
  return VISIBLE_DEPENDENCY_STATUSES.has(entry?.status) ? entry.status : 'unknown'
}

/**
 * Health probes and tenant-facing Runtime views expose only aggregate service
 * state. Provider names, endpoint details and internal failure strings remain
 * available from the raw Admin-token Runtime API.
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
  const requiredDependencies = runtime?.listenerMode === 'admin'
    ? [source.store]
    : Object.values(source)

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
