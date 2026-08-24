type DarwinNetworkServiceSnapshot = Record<string, unknown> & {
  name?: unknown;
};

type DarwinCleanupOnlyService = {
  name: string;
  pacUrl: string;
};

export type DarwinExternalApplyPhase = 'prepared' | 'privileged-handoff' | 'readback-started';

export function currentDarwinExternalApplyPhase(value: unknown): DarwinExternalApplyPhase | null {
  return value === 'prepared' || value === 'privileged-handoff' || value === 'readback-started'
    ? value
    : null;
}

export function darwinExternalApplyAbortAllowed(
  value: unknown,
  execution: 'not-started' | 'authorization-canceled' = 'not-started'
): boolean {
  const phase = currentDarwinExternalApplyPhase(value);
  if (phase === 'readback-started') return false;
  if (execution === 'authorization-canceled') {
    return phase === 'prepared' || phase === 'privileged-handoff';
  }
  return phase === 'prepared';
}

export function mergeDarwinPreviousState(
  previous: unknown,
  current: unknown,
  ownedPacUrl?: unknown
): Record<string, unknown> {
  const previousState = objectRecord(previous);
  const snapshots = serviceSnapshots(previousState.services);
  const knownNames = new Set(snapshots.map(serviceName).filter(Boolean));
  const ownedUrl = stringValue(ownedPacUrl);
  const cleanupOnly = cleanupOnlyServices(previousState.cleanupOnlyServices);
  const cleanupNames = new Set(cleanupOnly.map((service) => service.name));

  for (const service of serviceSnapshots(objectRecord(current).services)) {
    const name = serviceName(service);
    if (!name || knownNames.has(name)) continue;
    // A renamed/recreated macOS service can inherit the PAC that MX already
    // applied. That is not a pre-MX snapshot and must never become restore
    // state, otherwise disconnect would reinstall a dead local PAC URL.
    if (ownedUrl && stringValue(service.url) === ownedUrl) {
      if (!cleanupNames.has(name)) {
        cleanupOnly.push({ name, pacUrl: ownedUrl });
        cleanupNames.add(name);
      }
      continue;
    }
    // A cleanup-only service that has since moved to another owner's PAC is
    // no longer ours to snapshot, apply, or restore.
    if (cleanupNames.has(name)) {
      const index = cleanupOnly.findIndex((item) => item.name === name);
      if (index >= 0) cleanupOnly.splice(index, 1);
      cleanupNames.delete(name);
      continue;
    }
    snapshots.push(service);
    knownNames.add(name);
  }

  return {
    ...previousState,
    services: snapshots,
    cleanupOnlyServices: cleanupOnly
  };
}

export function currentDarwinResolverDomains(domains: unknown): string[] {
  if (!Array.isArray(domains)) return [];
  return [...new Set(domains
    .map((domain) => typeof domain === 'string'
      ? domain.trim().toLowerCase().replace(/^\.+|\.+$/g, '')
      : '')
    .filter((domain) => /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(domain))
  )].sort((left, right) => left.length - right.length || left.localeCompare(right));
}

export function intersectDarwinManagedServiceNames(baseline: unknown, current: unknown): string[] {
  const live = new Set(serviceNames(current));
  return serviceNames(baseline).filter((name) => live.has(name));
}

export function currentDarwinCleanupOnlyServices(previous: unknown): DarwinCleanupOnlyService[] {
  return cleanupOnlyServices(objectRecord(previous).cleanupOnlyServices);
}

export function darwinPacVerificationRowsReady(rows: unknown): boolean {
  if (!Array.isArray(rows)) return false;
  const live = rows.filter((row) => objectRecord(row).ignored !== true);
  return live.length > 0 && live.every((row) => objectRecord(row).applied === true);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}

function serviceSnapshots(value: unknown): DarwinNetworkServiceSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.filter((service): service is DarwinNetworkServiceSnapshot =>
    Boolean(service && typeof service === 'object' && serviceName(service))
  );
}

function cleanupOnlyServices(value: unknown): DarwinCleanupOnlyService[] {
  if (!Array.isArray(value)) return [];
  const rows: DarwinCleanupOnlyService[] = [];
  const names = new Set<string>();
  for (const item of value) {
    const row = objectRecord(item);
    const name = stringValue(row.name);
    const pacUrl = stringValue(row.pacUrl);
    if (!name || !pacUrl || names.has(name)) continue;
    rows.push({ name, pacUrl });
    names.add(name);
  }
  return rows;
}

function serviceName(service: DarwinNetworkServiceSnapshot): string {
  return typeof service.name === 'string' ? service.name.trim() : '';
}

function serviceNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((name) => typeof name === 'string' ? name.trim() : '')
    .filter(Boolean))];
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
