import { isIP } from 'node:net';

export type ElectronLauncherNetworkOwnerState = 'connecting' | 'active' | 'stale' | 'released';
export type ElectronLauncherNetworkOwnershipResource = 'dns-host' | 'dns-zone' | 'route-cidr' | 'reverse-proxy-route';

export interface ElectronLauncherNetworkOwnershipRoute {
  routeId?: string | null;
  host: string;
  dnsTarget?: string | null;
  targetUrl?: string | null;
  tlsMode?: string | null;
  authRequired?: boolean | null;
  enabled?: boolean | null;
}

export interface ElectronLauncherNetworkOwnershipClaim {
  ownerId: string;
  productId?: string | null;
  instanceId?: string | null;
  displayName?: string | null;
  state?: ElectronLauncherNetworkOwnerState | null;
  priority?: number | null;
  leaseIp?: string | null;
  gatewayIp?: string | null;
  dnsHosts?: string[] | null;
  dnsZones?: string[] | null;
  routeCidrs?: string[] | null;
  reverseProxyRoutes?: ElectronLauncherNetworkOwnershipRoute[] | null;
  metadata?: Record<string, unknown> | null;
  updatedAt?: string | null;
}

export interface ElectronLauncherNetworkOwner {
  ownerId: string;
  productId: string | null;
  instanceId: string | null;
  displayName: string | null;
  state: ElectronLauncherNetworkOwnerState;
  priority: number;
  leaseIp: string | null;
  gatewayIp: string | null;
  metadata: Record<string, unknown> | null;
  updatedAt: string | null;
}

export interface ElectronLauncherNetworkOwnershipEntry {
  resource: ElectronLauncherNetworkOwnershipResource;
  key: string;
  ownerId: string;
  productId: string | null;
  priority: number;
  state: ElectronLauncherNetworkOwnerState;
  value: string;
  target?: string | null;
  route?: ElectronLauncherNetworkOwnershipRoute | null;
}

export interface ElectronLauncherNetworkOwnershipConflict {
  resource: ElectronLauncherNetworkOwnershipResource;
  key: string;
  owners: string[];
  reason: string;
}

export interface ElectronLauncherNetworkOwnershipRegistry {
  owners: ElectronLauncherNetworkOwner[];
  dnsHosts: ElectronLauncherNetworkOwnershipEntry[];
  dnsZones: ElectronLauncherNetworkOwnershipEntry[];
  routeCidrs: ElectronLauncherNetworkOwnershipEntry[];
  reverseProxyRoutes: ElectronLauncherNetworkOwnershipEntry[];
  conflicts: ElectronLauncherNetworkOwnershipConflict[];
}

export function buildElectronLauncherNetworkOwnershipRegistry(
  claims: ElectronLauncherNetworkOwnershipClaim[]
): ElectronLauncherNetworkOwnershipRegistry {
  const normalized = claims
    .map(normalizeClaim)
    .filter((claim): claim is NormalizedOwnershipClaim => Boolean(claim));
  const owners = normalized.map((claim) => claim.owner);
  const dnsHosts = sortEntries(normalized.flatMap((claim) => claim.dnsHosts));
  const dnsZones = sortEntries(normalized.flatMap((claim) => claim.dnsZones));
  const routeCidrs = sortEntries(normalized.flatMap((claim) => claim.routeCidrs));
  const reverseProxyRoutes = sortEntries(normalized.flatMap((claim) => claim.reverseProxyRoutes));
  const conflicts = [
    ...duplicateKeyConflicts('dns-host', dnsHosts),
    ...duplicateKeyConflicts('dns-zone', dnsZones),
    ...duplicateRouteConflicts(routeCidrs),
    ...duplicateReverseProxyRouteConflicts(reverseProxyRoutes)
  ];
  return {
    owners,
    dnsHosts,
    dnsZones,
    routeCidrs,
    reverseProxyRoutes,
    conflicts
  };
}

export function resolveElectronLauncherDnsOwner(
  registry: ElectronLauncherNetworkOwnershipRegistry,
  hostname: string
): ElectronLauncherNetworkOwnershipEntry | null {
  const host = normalizeDomain(hostname);
  if (!host) return null;
  const exact = sortEntries(registry.dnsHosts.filter((entry) => entry.key === host))[0];
  if (exact) return exact;
  const zones = registry.dnsZones
    .filter((entry) => host === entry.key || host.endsWith(`.${entry.key}`))
    .sort((left, right) => right.key.length - left.key.length || entrySort(left, right));
  return zones[0] || null;
}

export function mergedElectronLauncherDnsZones(registry: ElectronLauncherNetworkOwnershipRegistry): string[] {
  return uniqueStrings(registry.dnsZones.map((entry) => entry.key));
}

export function mergedElectronLauncherReverseProxyRoutes(
  registry: ElectronLauncherNetworkOwnershipRegistry
): ElectronLauncherNetworkOwnershipRoute[] {
  const byHost = new Map<string, ElectronLauncherNetworkOwnershipRoute>();
  for (const entry of sortEntries(registry.reverseProxyRoutes)) {
    if (!entry.route || byHost.has(entry.key)) continue;
    byHost.set(entry.key, entry.route);
  }
  return [...byHost.values()];
}

interface NormalizedOwnershipClaim {
  owner: ElectronLauncherNetworkOwner;
  dnsHosts: ElectronLauncherNetworkOwnershipEntry[];
  dnsZones: ElectronLauncherNetworkOwnershipEntry[];
  routeCidrs: ElectronLauncherNetworkOwnershipEntry[];
  reverseProxyRoutes: ElectronLauncherNetworkOwnershipEntry[];
}

function normalizeClaim(input: ElectronLauncherNetworkOwnershipClaim): NormalizedOwnershipClaim | null {
  const ownerId = normalizeOwnerId(input.ownerId);
  if (!ownerId) return null;
  const state = normalizeState(input.state);
  if (state === 'released') return null;
  const priority = normalizePriority(input.priority);
  const productId = nullableString(input.productId);
  const owner: ElectronLauncherNetworkOwner = {
    ownerId,
    productId,
    instanceId: nullableString(input.instanceId),
    displayName: nullableString(input.displayName),
    state,
    priority,
    leaseIp: normalizeIpv4(input.leaseIp),
    gatewayIp: normalizeIpv4(input.gatewayIp),
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : null,
    updatedAt: nullableString(input.updatedAt)
  };
  const entryBase = {
    ownerId,
    productId,
    priority,
    state
  };
  return {
    owner,
    dnsHosts: uniqueStrings((input.dnsHosts || []).map(normalizeDomain))
      .map((host) => ({
        ...entryBase,
        resource: 'dns-host',
        key: host,
        value: host,
        target: owner.gatewayIp || owner.leaseIp
      })),
    dnsZones: uniqueStrings((input.dnsZones || []).map(normalizeDomain))
      .map((zone) => ({
        ...entryBase,
        resource: 'dns-zone',
        key: zone,
        value: zone,
        target: owner.gatewayIp || owner.leaseIp
      })),
    routeCidrs: uniqueStrings((input.routeCidrs || []).map(normalizeIpv4Cidr))
      .map((cidr) => ({
        ...entryBase,
        resource: 'route-cidr',
        key: cidr,
        value: cidr,
        target: owner.leaseIp
      })),
    reverseProxyRoutes: normalizeRoutes(input.reverseProxyRoutes).map((route) => ({
      ...entryBase,
      resource: 'reverse-proxy-route',
      key: route.host,
      value: route.host,
      target: route.targetUrl || route.dnsTarget || owner.gatewayIp || owner.leaseIp,
      route
    }))
  };
}

function duplicateKeyConflicts(
  resource: ElectronLauncherNetworkOwnershipResource,
  entries: ElectronLauncherNetworkOwnershipEntry[]
): ElectronLauncherNetworkOwnershipConflict[] {
  const conflicts: ElectronLauncherNetworkOwnershipConflict[] = [];
  for (const group of groupEntries(entries).values()) {
    const owners = uniqueStrings(group.map((entry) => entry.ownerId));
    if (owners.length <= 1) continue;
    const highest = group[0]?.priority ?? 0;
    const samePriorityOwners = uniqueStrings(group.filter((entry) => entry.priority === highest).map((entry) => entry.ownerId));
    if (samePriorityOwners.length > 1) {
      conflicts.push({
        resource,
        key: group[0].key,
        owners,
        reason: 'same-priority owners claim the same resource'
      });
    }
  }
  return conflicts;
}

function duplicateRouteConflicts(entries: ElectronLauncherNetworkOwnershipEntry[]): ElectronLauncherNetworkOwnershipConflict[] {
  const conflicts = duplicateKeyConflicts('route-cidr', entries);
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const left = entries[i];
      const right = entries[j];
      if (left.ownerId === right.ownerId || left.key === right.key) continue;
      if (cidrOverlaps(left.key, right.key)) {
        conflicts.push({
          resource: 'route-cidr',
          key: `${left.key} <> ${right.key}`,
          owners: uniqueStrings([left.ownerId, right.ownerId]),
          reason: 'route CIDRs overlap'
        });
      }
    }
  }
  return conflicts;
}

function duplicateReverseProxyRouteConflicts(entries: ElectronLauncherNetworkOwnershipEntry[]): ElectronLauncherNetworkOwnershipConflict[] {
  const conflicts: ElectronLauncherNetworkOwnershipConflict[] = [];
  for (const group of groupEntries(entries).values()) {
    const owners = uniqueStrings(group.map((entry) => entry.ownerId));
    if (owners.length <= 1) continue;
    const targets = uniqueStrings(group
      .map((entry) => nullableString(entry.target))
      .filter((target): target is string => Boolean(target)));
    if (targets.length > 1) {
      conflicts.push({
        resource: 'reverse-proxy-route',
        key: group[0].key,
        owners,
        reason: 'same host maps to different upstream targets'
      });
    }
  }
  return conflicts;
}

function groupEntries(entries: ElectronLauncherNetworkOwnershipEntry[]): Map<string, ElectronLauncherNetworkOwnershipEntry[]> {
  const groups = new Map<string, ElectronLauncherNetworkOwnershipEntry[]>();
  for (const entry of sortEntries(entries)) {
    const group = groups.get(entry.key) || [];
    group.push(entry);
    groups.set(entry.key, group);
  }
  return groups;
}

function sortEntries<T extends ElectronLauncherNetworkOwnershipEntry>(entries: T[]): T[] {
  return [...entries].sort(entrySort);
}

function entrySort(left: ElectronLauncherNetworkOwnershipEntry, right: ElectronLauncherNetworkOwnershipEntry): number {
  return right.priority - left.priority
    || stateRank(right.state) - stateRank(left.state)
    || left.key.localeCompare(right.key)
    || left.ownerId.localeCompare(right.ownerId);
}

function stateRank(state: ElectronLauncherNetworkOwnerState): number {
  if (state === 'active') return 3;
  if (state === 'connecting') return 2;
  if (state === 'stale') return 1;
  return 0;
}

function normalizeRoutes(routes: ElectronLauncherNetworkOwnershipRoute[] | null | undefined): ElectronLauncherNetworkOwnershipRoute[] {
  return (routes || [])
    .map((route): ElectronLauncherNetworkOwnershipRoute | null => {
      const host = normalizeDomain(route?.host);
      if (!host || route.enabled === false) return null;
      return {
        ...route,
        host,
        dnsTarget: normalizeIpv4(route.dnsTarget) || nullableString(route.dnsTarget),
        targetUrl: nullableString(route.targetUrl),
        tlsMode: nullableString(route.tlsMode),
        authRequired: route.authRequired === true,
        enabled: true
      };
    })
    .filter((route): route is ElectronLauncherNetworkOwnershipRoute => route !== null);
}

function normalizeOwnerId(value: unknown): string | null {
  const text = nullableString(value);
  if (!text) return null;
  return text.replace(/[^a-zA-Z0-9_.:-]/g, '-').slice(0, 160) || null;
}

function normalizeState(value: unknown): ElectronLauncherNetworkOwnerState {
  if (value === 'connecting' || value === 'active' || value === 'stale' || value === 'released') return value;
  return 'active';
}

function normalizePriority(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 100;
}

function normalizeDomain(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/^\.+|\.+$/g, '')
    : '';
}

function normalizeIpv4(value: unknown): string | null {
  const text = nullableString(value);
  return text && isIP(text) === 4 ? text : null;
}

function normalizeIpv4Cidr(value: unknown): string {
  const text = nullableString(value);
  if (!text) return '';
  const [rawIp, rawPrefix] = text.split('/');
  if (isIP(rawIp) !== 4) return '';
  const prefix = rawPrefix === undefined ? 32 : Number(rawPrefix);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return '';
  return `${rawIp}/${prefix}`;
}

function cidrOverlaps(left: string, right: string): boolean {
  const leftRange = cidrRange(left);
  const rightRange = cidrRange(right);
  if (!leftRange || !rightRange) return false;
  return leftRange.start <= rightRange.end && rightRange.start <= leftRange.end;
}

function cidrRange(cidr: string): { start: number; end: number } | null {
  const [ip, rawPrefix] = cidr.split('/');
  if (isIP(ip) !== 4) return null;
  const prefix = Number(rawPrefix);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const base = ipv4ToNumber(ip);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const start = (base & mask) >>> 0;
  const hostMask = (~mask) >>> 0;
  return {
    start,
    end: (start | hostMask) >>> 0
  };
}

function ipv4ToNumber(ip: string): number {
  return ip.split('.')
    .map((part) => Number(part))
    .reduce((acc, part) => ((acc << 8) + part) >>> 0, 0);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
