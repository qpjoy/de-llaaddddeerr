import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { isIP } from 'node:net';
import type { LauncherRoutePlan } from '@qpjoy/mx-launcher-core';

import { classifyLauncherIpv4Address } from './network-diagnostics.js';
import {
  acquireElectronLauncherProcessLease,
  releaseElectronLauncherProcessLease
} from './process-lease.js';
import {
  buildElectronLauncherNetworkOwnershipRegistry,
  type ElectronLauncherNetworkOwnershipClaim,
  type ElectronLauncherNetworkOwnershipRegistry,
  type ElectronLauncherNetworkOwnershipRoute
} from './network-ownership-registry.js';
import {
  connectLauncherWireGuardPeer,
  getLauncherWireGuardPeerStatus,
  stopLauncherWireGuardPeer,
  type ElectronLauncherWireGuardPathPreference,
  type ElectronLauncherWireGuardRuntimeOptions,
  probeLauncherWireGuardEndpoint,
  probeLauncherWireGuardRoute
} from './wireguard.js';

export type ElectronLauncherStandaloneDataPlaneState =
  | 'lease-missing'
  | 'lease-active'
  | 'data-plane-pending'
  | 'proxy-tun-captured'
  | 'ownership-conflict'
  | 'route-mismatch'
  | 'service-unreachable'
  | 'network-ready';

export type ElectronLauncherStandaloneDataPlaneSeverity = 'ok' | 'info' | 'warning' | 'error';

export type ElectronLauncherStandaloneDataPlaneProbeTarget =
  | 'lease-ip'
  | 'internal-control'
  | 'domestic-gateway'
  | 'service-vip'
  | 'dns-server';

export interface ElectronLauncherStandaloneDataPlaneInput {
  routePlan?: LauncherRoutePlan | null;
  leaseIp?: string | null;
  serviceVip?: string | null;
  dnsServer?: string | null;
  internalControlIp?: string | null;
  domesticGatewayIp?: string | null;
  endpoint?: string | null;
  requiredProbeTargets?: ElectronLauncherStandaloneDataPlaneProbeTarget[] | null;
  expectedInterfaceName?: string | null;
  expectedInterfaceAddresses?: string[] | null;
  wireGuardActive?: boolean | null;
}

export interface ElectronLauncherStandaloneOwnershipInput {
  ownerId?: string | null;
  productId?: string | null;
  instanceId?: string | null;
  displayName?: string | null;
  priority?: number | null;
  metadata?: Record<string, unknown> | null;
  dnsHosts?: string[] | null;
  dnsZones?: string[] | null;
  routeCidrs?: string[] | null;
  reverseProxyRoutes?: ElectronLauncherNetworkOwnershipRoute[] | null;
  existingClaims?: ElectronLauncherNetworkOwnershipClaim[] | null;
}

export interface ElectronLauncherStandaloneOwnershipState {
  statePath: string;
  claims: ElectronLauncherNetworkOwnershipClaim[];
  registry: ElectronLauncherNetworkOwnershipRegistry;
  updatedAt: string;
}

export interface ElectronLauncherStandaloneOwnershipClaimOptions {
  statePath?: string | null;
  existingClaims?: ElectronLauncherNetworkOwnershipClaim[] | null;
  failOnOwnershipConflicts?: boolean | null;
}

export interface ElectronLauncherStandaloneOwnershipClaimResult
  extends ElectronLauncherStandaloneOwnershipState {
  claimed: boolean;
}

export interface ElectronLauncherStandaloneDataPlaneApplyInput
  extends ElectronLauncherWireGuardRuntimeOptions, ElectronLauncherStandaloneOwnershipInput {
  routePlan: LauncherRoutePlan;
  privateKey: string;
  dnsDomains?: string[] | null;
  suppressWireGuardDns?: boolean | null;
  mtu?: number | null;
  pathPreference?: ElectronLauncherWireGuardPathPreference;
  action?: 'up' | 'restart';
  requiredProbeTargets?: ElectronLauncherStandaloneDataPlaneProbeTarget[] | null;
  failOnOwnershipConflicts?: boolean | null;
  dataPlaneProbeAttempts?: number | null;
  dataPlaneProbeIntervalMs?: number | null;
  ownershipStatePath?: string | null;
  skipOwnershipState?: boolean | null;
}

export interface ElectronLauncherStandaloneDataPlaneApplyResult {
  ok: boolean;
  state: ElectronLauncherStandaloneDataPlaneState;
  diagnostics: ElectronLauncherStandaloneDataPlaneDiagnostics;
  ownershipClaim: ElectronLauncherNetworkOwnershipClaim;
  ownershipRegistry: ElectronLauncherNetworkOwnershipRegistry;
  wireGuard: Awaited<ReturnType<typeof connectLauncherWireGuardPeer>> | null;
  message: string;
}

export interface ElectronLauncherStandaloneDataPlaneStopInput
  extends ElectronLauncherWireGuardRuntimeOptions {
  routePlan?: LauncherRoutePlan | null;
  ownerId?: string | null;
  ownershipStatePath?: string | null;
  skipOwnershipState?: boolean | null;
}

export interface ElectronLauncherStandaloneDataPlaneStopResult {
  ok: boolean;
  wireGuard: Awaited<ReturnType<typeof stopLauncherWireGuardPeer>>;
  message: string;
}

interface WireGuardApplyLike {
  ok?: boolean | null;
  status?: unknown;
  peer?: {
    endpoint?: string | null;
  } | null;
}

interface StandaloneOwnershipStateFile {
  version: 1;
  claims: ElectronLauncherNetworkOwnershipClaim[];
  updatedAt: string;
}

interface StandaloneOwnershipLockFile {
  version: 1;
  pid: number;
  token: string;
  createdAt: string;
  expiresAt: string;
}

interface StandaloneOwnershipClaimRegistration {
  claimed: boolean;
  claims: ElectronLauncherNetworkOwnershipClaim[];
  registry: ElectronLauncherNetworkOwnershipRegistry;
}

const STANDALONE_OWNERSHIP_LOCK_WAIT_MS = 2_000;
const STANDALONE_OWNERSHIP_LOCK_LEASE_MS = 15_000;
const STANDALONE_OWNERSHIP_LOCK_RETRY_MS = 20;

export interface ElectronLauncherStandaloneRouteProbe {
  target: ElectronLauncherStandaloneDataPlaneProbeTarget;
  label: string;
  address: string;
  required: boolean;
  ok: boolean;
  viaWireGuard: boolean;
  viaLoopback: boolean;
  viaProxyTun: boolean;
  interfaceName: string | null;
  gateway: string | null;
  expectedInterfaceName: string | null;
  error: string | null;
  raw: string | null;
}

export interface ElectronLauncherStandaloneEndpointProbe {
  endpoint: string;
  host: string | null;
  ok: boolean;
  viaProxyTun: boolean;
  interfaceName: string | null;
  gateway: string | null;
  error: string | null;
}

export interface ElectronLauncherStandaloneDataPlaneDiagnostics {
  ok: boolean;
  state: ElectronLauncherStandaloneDataPlaneState;
  severity: ElectronLauncherStandaloneDataPlaneSeverity;
  message: string;
  productId: string | null;
  leaseIp: string | null;
  serviceVip: string | null;
  dnsServer: string | null;
  internalControlIp: string | null;
  domesticGatewayIp: string | null;
  probes: ElectronLauncherStandaloneRouteProbe[];
  endpoint: ElectronLauncherStandaloneEndpointProbe | null;
  updatedAt: string;
}

interface ProbeTarget {
  target: ElectronLauncherStandaloneDataPlaneProbeTarget;
  label: string;
  address: string | null;
  required: boolean;
}

export function diagnoseElectronLauncherStandaloneDataPlane(
  input: ElectronLauncherStandaloneDataPlaneInput
): ElectronLauncherStandaloneDataPlaneDiagnostics {
  const routePlan = input.routePlan ?? null;
  const leaseIp = ipv4OrNull(input.leaseIp) ?? ipv4OrNull(routePlan?.leaseIp);
  const serviceVip = ipv4OrNull(input.serviceVip) ?? ipv4OrNull(routePlan?.serviceVip);
  const dnsServer = dnsServerHost(input.dnsServer) ?? dnsServerHost(routePlan?.dnsServer);
  const internalControlIp = ipv4OrNull(input.internalControlIp) ?? ipv4OrNull(routePlan?.internalControlIp);
  const domesticGatewayIp = ipv4OrNull(input.domesticGatewayIp) ?? ipv4OrNull(routePlan?.domesticGatewayIp);
  const endpoint = stringValue(input.endpoint)
    ?? stringValue(routePlan?.domesticRelayEndpoint)
    ?? stringValue(routePlan?.h2iDirectEndpoint);

  if (!leaseIp && !routePlan) {
    return buildDiagnostics({
      state: 'lease-missing',
      severity: 'info',
      message: 'Launcher lease has not been issued yet.',
      productId: null,
      leaseIp,
      serviceVip,
      dnsServer,
      internalControlIp,
      domesticGatewayIp,
      probes: [],
      endpoint: null
    });
  }

  const expectedInterfaceName = stringValue(input.expectedInterfaceName);
  const expectedInterfaceAddresses = input.expectedInterfaceAddresses ?? (leaseIp ? [leaseIp] : []);
  const requiredTargets = input.requiredProbeTargets
    ? new Set(input.requiredProbeTargets)
    : null;
  const requiredProbe = (target: ElectronLauncherStandaloneDataPlaneProbeTarget, address: string | null) =>
    Boolean(address) && (!requiredTargets || requiredTargets.has(target));
  const probes = [
    probeRouteTarget({
      target: 'lease-ip',
      label: 'Lease IP self route',
      address: leaseIp,
      required: requiredProbe('lease-ip', leaseIp)
    }, expectedInterfaceName, expectedInterfaceAddresses),
    probeRouteTarget({
      target: 'internal-control',
      label: 'Internal control plane',
      address: internalControlIp,
      required: requiredProbe('internal-control', internalControlIp)
    }, expectedInterfaceName, expectedInterfaceAddresses),
    probeRouteTarget({
      target: 'domestic-gateway',
      label: 'Domestic DNS relay',
      address: domesticGatewayIp,
      required: requiredProbe('domestic-gateway', domesticGatewayIp)
    }, expectedInterfaceName, expectedInterfaceAddresses),
    probeRouteTarget({
      target: 'service-vip',
      label: 'Product service VIP',
      address: serviceVip,
      required: requiredProbe('service-vip', serviceVip)
    }, expectedInterfaceName, expectedInterfaceAddresses),
    probeRouteTarget({
      target: 'dns-server',
      label: 'WireGuard DNS server',
      address: dnsServer,
      required: requiredProbe('dns-server', dnsServer)
    }, expectedInterfaceName, expectedInterfaceAddresses)
  ].filter((probe): probe is ElectronLauncherStandaloneRouteProbe => Boolean(probe));

  const endpointProbe = endpoint ? normalizeEndpointProbe(probeLauncherWireGuardEndpoint({ endpoint })) : null;
  const requiredProbes = probes.filter((probe) => probe.required);
  const failedProbes = requiredProbes.filter((probe) => !probe.ok);
  const proxyProbe = requiredProbes.find((probe) => probe.viaProxyTun) ?? null;
  const endpointProxyCaptured = endpointProbe?.viaProxyTun === true;
  const wireGuardActive = input.wireGuardActive === true;
  const state = dataPlaneState({
    leaseIp,
    failedProbes,
    proxyCaptured: Boolean(proxyProbe || endpointProxyCaptured),
    wireGuardActive
  });

  return buildDiagnostics({
    state,
    severity: dataPlaneSeverity(state),
    message: dataPlaneMessage({
      state,
      proxyProbe,
      endpointProbe,
      failedProbes
    }),
    productId: stringValue(routePlan?.productId),
    leaseIp,
    serviceVip,
    dnsServer,
    internalControlIp,
    domesticGatewayIp,
    probes,
    endpoint: endpointProbe
  });
}

export async function applyElectronLauncherStandaloneDataPlane(
  input: ElectronLauncherStandaloneDataPlaneApplyInput
): Promise<ElectronLauncherStandaloneDataPlaneApplyResult> {
  const ownershipClaim = buildElectronLauncherStandaloneOwnershipClaim(input.routePlan, input);
  const registration = input.skipOwnershipState === true
    ? standaloneOwnershipClaimRegistration(
        [],
        ownershipClaim,
        input.existingClaims ?? [],
        input.failOnOwnershipConflicts !== false
      )
    : registerStandaloneOwnershipClaim(
        input.ownershipStatePath,
        ownershipClaim,
        input.existingClaims ?? [],
        input.failOnOwnershipConflicts !== false
      );
  if (!registration.claimed) {
    const ownershipRegistry = registration.registry;
    const diagnostics = ownershipConflictDiagnostics(input.routePlan, ownershipRegistry);
    return {
      ok: false,
      state: diagnostics.state,
      diagnostics,
      ownershipClaim,
      ownershipRegistry,
      wireGuard: null,
      message: diagnostics.message
    };
  }

  const wireGuard = await connectLauncherWireGuardPeer({
    ...input,
    action: input.action ?? 'restart',
    dnsDomains: input.dnsDomains ?? [],
    suppressWireGuardDns: input.suppressWireGuardDns,
    pathPreference: input.pathPreference
  });
  const diagnostics = await waitForStandaloneDataPlaneDiagnostics(input, wireGuard);
  const finalOwnershipClaim: ElectronLauncherNetworkOwnershipClaim = {
    ...ownershipClaim,
    state: diagnostics.ok ? 'active' : 'connecting',
    updatedAt: new Date().toISOString()
  };
  let finalStateClaims = registration.claims;
  if (input.skipOwnershipState !== true) {
    finalStateClaims = writeStandaloneOwnershipClaim(input.ownershipStatePath, finalOwnershipClaim);
  }
  const finalOwnershipRegistry = buildElectronLauncherNetworkOwnershipRegistry([
    ...finalStateClaims.filter((claim) => claim.ownerId !== ownershipClaim.ownerId),
    ...(input.existingClaims ?? []),
    finalOwnershipClaim
  ]);
  return {
    ok: wireGuard.ok === true && diagnostics.ok,
    state: diagnostics.state,
    diagnostics,
    ownershipClaim: finalOwnershipClaim,
    ownershipRegistry: finalOwnershipRegistry,
    wireGuard,
    message: diagnostics.ok ? 'Launcher standalone data plane is ready.' : diagnostics.message
  };
}

export async function stopElectronLauncherStandaloneDataPlane(
  input: ElectronLauncherStandaloneDataPlaneStopInput
): Promise<ElectronLauncherStandaloneDataPlaneStopResult> {
  const wireGuard = await stopLauncherWireGuardPeer(input);
  // Keep the claim when teardown is incomplete. Releasing it early lets a
  // second product make decisions from a false "owner is gone" snapshot while
  // the first product's service, routes, or NRPT rules are still live.
  if (wireGuard.ok === true && input.skipOwnershipState !== true && input.ownerId) {
    releaseStandaloneOwnershipClaim(input.ownershipStatePath, input.ownerId);
  }
  return {
    ok: wireGuard.ok === true,
    wireGuard,
    message: wireGuard.message ?? (wireGuard.ok ? 'Launcher standalone data plane stopped.' : 'Launcher standalone data plane stop failed.')
  };
}

export function readElectronLauncherStandaloneOwnershipState(statePath?: string | null): ElectronLauncherStandaloneOwnershipState {
  const file = canonicalStandaloneOwnershipStatePath(statePath, false);
  const claims = readStandaloneOwnershipClaimsFromFile(file, false);
  return standaloneOwnershipState(file, claims);
}

export function upsertElectronLauncherStandaloneOwnershipClaim(
  claim: ElectronLauncherNetworkOwnershipClaim,
  statePath?: string | null
): ElectronLauncherStandaloneOwnershipState {
  const file = canonicalStandaloneOwnershipStatePath(statePath, true);
  const claims = writeStandaloneOwnershipClaim(file, claim);
  return standaloneOwnershipState(file, claims);
}

export function claimElectronLauncherStandaloneOwnershipClaim(
  claim: ElectronLauncherNetworkOwnershipClaim,
  options: ElectronLauncherStandaloneOwnershipClaimOptions = {}
): ElectronLauncherStandaloneOwnershipClaimResult {
  const file = canonicalStandaloneOwnershipStatePath(options.statePath, true);
  const registration = registerStandaloneOwnershipClaim(
    file,
    claim,
    options.existingClaims ?? [],
    options.failOnOwnershipConflicts !== false
  );
  return {
    ...standaloneOwnershipState(file, registration.claims),
    claimed: registration.claimed,
    registry: registration.registry
  };
}

export function releaseElectronLauncherStandaloneOwnershipClaim(
  ownerId: string,
  statePath?: string | null
): ElectronLauncherStandaloneOwnershipState {
  const file = canonicalStandaloneOwnershipStatePath(statePath, true);
  const claims = releaseStandaloneOwnershipClaim(file, ownerId);
  return standaloneOwnershipState(file, claims);
}

export function buildElectronLauncherStandaloneOwnershipClaim(
  routePlan: LauncherRoutePlan,
  input: ElectronLauncherStandaloneOwnershipInput = {}
): ElectronLauncherNetworkOwnershipClaim {
  const productId = stringValue(input.productId) ?? stringValue(routePlan.productId) ?? 'launcher';
  const instanceId = stringValue(input.instanceId) ?? stringValue(routePlan.leaseIp);
  const ownerId = stringValue(input.ownerId) ?? `${productId}:${instanceId ?? 'local'}`;
  const dnsHosts = uniqueStrings(input.dnsHosts ?? []);
  const dnsZones = uniqueStrings(input.dnsZones ?? []);
  const routeCidrs = uniqueStrings(input.routeCidrs ?? []);
  const productRouteCidrs = routeCidrs.length
    ? routeCidrs
    : uniqueStrings(routePlan.routeCidrs ?? []);
  return {
    ownerId,
    productId,
    instanceId,
    displayName: stringValue(input.displayName) ?? productId,
    state: 'connecting',
    priority: normalizePriority(input.priority),
    leaseIp: ipv4OrNull(routePlan.leaseIp),
    gatewayIp: ipv4OrNull(routePlan.internalControlIp) ?? ipv4OrNull(routePlan.domesticGatewayIp),
    dnsHosts,
    dnsZones,
    routeCidrs: productRouteCidrs,
    reverseProxyRoutes: input.reverseProxyRoutes ?? [],
    metadata: {
      launcherMode: routePlan.launcherMode,
      serviceVip: routePlan.serviceVip,
      snapshotId: routePlan.snapshotId,
      dnsServer: routePlan.dnsServer,
      ...(input.metadata ?? {})
    },
    updatedAt: new Date().toISOString()
  };
}

function probeRouteTarget(
  target: ProbeTarget,
  expectedInterfaceName: string | null,
  expectedInterfaceAddresses: string[]
): ElectronLauncherStandaloneRouteProbe | null {
  const address = ipv4OrNull(target.address);
  if (!address) return null;
  const route = probeLauncherWireGuardRoute({
    targetIp: address,
    expectedInterfaceName,
    expectedInterfaceAddresses
  });
  const viaProxyTun = isProxyTunAddress(route.gateway);
  const selfRouteOk = target.target === 'lease-ip' && route.viaLoopback && !viaProxyTun && !route.error;
  return {
    target: target.target,
    label: target.label,
    address,
    required: target.required,
    ok: selfRouteOk || (route.ok && !viaProxyTun && !route.error),
    viaWireGuard: route.ok,
    viaLoopback: route.viaLoopback,
    viaProxyTun,
    interfaceName: route.interfaceName,
    gateway: route.gateway,
    expectedInterfaceName: route.expectedInterfaceName,
    error: route.error,
    raw: route.raw
  };
}

function normalizeEndpointProbe(
  probe: ReturnType<typeof probeLauncherWireGuardEndpoint>
): ElectronLauncherStandaloneEndpointProbe {
  return {
    endpoint: probe.endpoint ?? '',
    host: probe.host,
    ok: probe.ok,
    viaProxyTun: probe.viaProxyTun,
    interfaceName: probe.interfaceName,
    gateway: probe.gateway,
    error: probe.error
  };
}

function dataPlaneState(input: {
  leaseIp: string | null;
  failedProbes: ElectronLauncherStandaloneRouteProbe[];
  proxyCaptured: boolean;
  wireGuardActive: boolean;
}): ElectronLauncherStandaloneDataPlaneState {
  if (!input.leaseIp) return 'lease-missing';
  if (input.proxyCaptured) return 'proxy-tun-captured';
  if (input.failedProbes.length === 0) return 'network-ready';
  return input.wireGuardActive ? 'route-mismatch' : 'data-plane-pending';
}

function dataPlaneSeverity(state: ElectronLauncherStandaloneDataPlaneState): ElectronLauncherStandaloneDataPlaneSeverity {
  if (state === 'network-ready') return 'ok';
  if (state === 'lease-missing' || state === 'lease-active') return 'info';
  if (state === 'ownership-conflict' || state === 'proxy-tun-captured' || state === 'route-mismatch' || state === 'service-unreachable') return 'error';
  return 'warning';
}

function dataPlaneMessage(input: {
  state: ElectronLauncherStandaloneDataPlaneState;
  proxyProbe: ElectronLauncherStandaloneRouteProbe | null;
  endpointProbe: ElectronLauncherStandaloneEndpointProbe | null;
  failedProbes: ElectronLauncherStandaloneRouteProbe[];
}): string {
  if (input.state === 'lease-missing') return 'Launcher lease has not been issued yet.';
  if (input.state === 'network-ready') {
    return 'Launcher lease and local data-plane routes are both ready.';
  }
  if (input.state === 'ownership-conflict') {
    return 'Another launcher owner already claims the same DNS, route, or reverse-proxy resource.';
  }
  if (input.state === 'service-unreachable') {
    return 'Launcher route proof is ready, but the product service VIP is not reachable yet.';
  }
  if (input.state === 'proxy-tun-captured') {
    if (input.proxyProbe) {
      return `${input.proxyProbe.label} is captured by proxy TUN gateway ${input.proxyProbe.gateway ?? 'unknown'}; keep Launcher internal CIDRs on the WireGuard/direct route.`;
    }
    return `WireGuard endpoint is captured by proxy TUN gateway ${input.endpointProbe?.gateway ?? 'unknown'}; endpoint traffic must stay outside Clash/mihomo TUN.`;
  }
  const names = input.failedProbes.map((probe) => probe.label).join(', ');
  if (input.state === 'route-mismatch') {
    return `WireGuard is active but route proof is not ready: ${names || 'no required routes'}.`;
  }
  return `Launcher lease is active, but privileged WireGuard/data-plane apply is still pending: ${names || 'no route proof'}.`;
}

async function waitForStandaloneDataPlaneDiagnostics(
  input: ElectronLauncherStandaloneDataPlaneApplyInput,
  wireGuard: Awaited<ReturnType<typeof connectLauncherWireGuardPeer>>
): Promise<ElectronLauncherStandaloneDataPlaneDiagnostics> {
  const attempts = Math.max(1, Math.min(30, Math.floor(input.dataPlaneProbeAttempts ?? 12)));
  const intervalMs = Math.max(250, Math.min(5000, Math.floor(input.dataPlaneProbeIntervalMs ?? 1000)));
  let diagnostics = standaloneDiagnosticsForWireGuard(input, wireGuard);
  for (let index = 1; index < attempts && !diagnostics.ok; index += 1) {
    await delay(intervalMs);
    const status = getLauncherWireGuardPeerStatus(input);
    diagnostics = standaloneDiagnosticsForWireGuard(input, {
      ...wireGuard,
      ok: wireGuard.ok === true || status?.active === true,
      status
    });
  }
  return diagnostics;
}

function standaloneDiagnosticsForWireGuard(
  input: ElectronLauncherStandaloneDataPlaneApplyInput,
  wireGuard: WireGuardApplyLike
): ElectronLauncherStandaloneDataPlaneDiagnostics {
  const status = objectRecord(wireGuard.status);
  return diagnoseElectronLauncherStandaloneDataPlane({
    routePlan: input.routePlan,
    leaseIp: input.routePlan.leaseIp,
    serviceVip: input.routePlan.serviceVip,
    dnsServer: input.routePlan.dnsServer,
    endpoint: wireGuard.peer?.endpoint,
    requiredProbeTargets: input.requiredProbeTargets,
    expectedInterfaceName: stringValue(status?.realInterfaceName) || stringValue(status?.interfaceName),
    expectedInterfaceAddresses: Array.isArray(status?.addresses) ? status.addresses.filter((item): item is string => typeof item === 'string') : [input.routePlan.leaseIp],
    wireGuardActive: wireGuard.ok === true || status?.active === true
  });
}

function ownershipConflictDiagnostics(
  routePlan: LauncherRoutePlan,
  registry: ElectronLauncherNetworkOwnershipRegistry
): ElectronLauncherStandaloneDataPlaneDiagnostics {
  const conflict = registry.conflicts[0];
  return buildDiagnostics({
    state: 'ownership-conflict',
    severity: 'error',
    message: conflict
      ? `Launcher ownership conflict on ${conflict.resource}:${conflict.key} (${conflict.reason}).`
      : 'Launcher ownership conflict detected.',
    productId: stringValue(routePlan.productId),
    leaseIp: ipv4OrNull(routePlan.leaseIp),
    serviceVip: ipv4OrNull(routePlan.serviceVip),
    dnsServer: dnsServerHost(routePlan.dnsServer),
    internalControlIp: ipv4OrNull(routePlan.internalControlIp),
    domesticGatewayIp: ipv4OrNull(routePlan.domesticGatewayIp),
    probes: [],
    endpoint: null
  });
}

function defaultStandaloneOwnershipStatePath(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'QPJoy', 'Electron Launcher', 'standalone-ownership.json');
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || homedir(), 'QPJoy', 'Electron Launcher', 'standalone-ownership.json');
  }
  return join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'qpjoy-electron-launcher', 'standalone-ownership.json');
}

function readStandaloneOwnershipClaimsFromFile(
  file: string,
  failOnInvalidState: boolean
): ElectronLauncherNetworkOwnershipClaim[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<StandaloneOwnershipStateFile>;
    if (!Array.isArray(parsed.claims)) {
      if (failOnInvalidState) throw new Error('claims must be an array');
      return [];
    }
    const claims = parsed.claims.filter(
      (claim): claim is ElectronLauncherNetworkOwnershipClaim => Boolean(claim?.ownerId)
    );
    if (failOnInvalidState && claims.length !== parsed.claims.length) {
      throw new Error('one or more claims are missing ownerId');
    }
    return claims;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    if (failOnInvalidState) {
      throw new Error(`Cannot safely update standalone ownership state ${file}: ${errorMessage(error)}`);
    }
    return [];
  }
}

function registerStandaloneOwnershipClaim(
  statePath: string | null | undefined,
  claim: ElectronLauncherNetworkOwnershipClaim,
  existingClaims: ElectronLauncherNetworkOwnershipClaim[],
  failOnOwnershipConflicts: boolean
): StandaloneOwnershipClaimRegistration {
  const file = canonicalStandaloneOwnershipStatePath(statePath, true);
  return withStandaloneOwnershipLock(file, () => {
    const currentClaims = readStandaloneOwnershipClaimsFromFile(file, true);
    const registration = standaloneOwnershipClaimRegistration(
      currentClaims,
      claim,
      existingClaims,
      failOnOwnershipConflicts
    );
    if (registration.claimed) {
      writeStandaloneOwnershipState(file, registration.claims);
    }
    return registration;
  });
}

function standaloneOwnershipClaimRegistration(
  currentClaims: ElectronLauncherNetworkOwnershipClaim[],
  claim: ElectronLauncherNetworkOwnershipClaim,
  existingClaims: ElectronLauncherNetworkOwnershipClaim[],
  failOnOwnershipConflicts: boolean
): StandaloneOwnershipClaimRegistration {
  const candidateClaims = [
    ...currentClaims.filter((row) => row.ownerId !== claim.ownerId),
    claim
  ];
  const registry = buildElectronLauncherNetworkOwnershipRegistry([
    ...currentClaims.filter((row) => row.ownerId !== claim.ownerId),
    ...existingClaims,
    claim
  ]);
  const claimed = !failOnOwnershipConflicts || registry.conflicts.length === 0;
  return {
    claimed,
    claims: claimed ? candidateClaims : currentClaims,
    registry
  };
}

function writeStandaloneOwnershipClaim(
  statePath: string | null | undefined,
  claim: ElectronLauncherNetworkOwnershipClaim
): ElectronLauncherNetworkOwnershipClaim[] {
  const file = canonicalStandaloneOwnershipStatePath(statePath, true);
  return withStandaloneOwnershipLock(file, () => {
    const claims = [
      ...readStandaloneOwnershipClaimsFromFile(file, true).filter((row) => row.ownerId !== claim.ownerId),
      claim
    ];
    writeStandaloneOwnershipState(file, claims);
    return claims;
  });
}

function releaseStandaloneOwnershipClaim(
  statePath: string | null | undefined,
  ownerId: string
): ElectronLauncherNetworkOwnershipClaim[] {
  const file = canonicalStandaloneOwnershipStatePath(statePath, true);
  return withStandaloneOwnershipLock(file, () => {
    const claims = readStandaloneOwnershipClaimsFromFile(file, true).filter((row) => row.ownerId !== ownerId);
    writeStandaloneOwnershipState(file, claims);
    return claims;
  });
}

function writeStandaloneOwnershipState(file: string, claims: ElectronLauncherNetworkOwnershipClaim[]): void {
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const payload = JSON.stringify({
    version: 1,
    claims,
    updatedAt: new Date().toISOString()
  }, null, 2);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, payload, { encoding: 'utf8' });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, file);
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original write error.
      }
    }
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }
}

function standaloneOwnershipState(
  file: string,
  claims: ElectronLauncherNetworkOwnershipClaim[]
): ElectronLauncherStandaloneOwnershipState {
  return {
    statePath: file,
    claims,
    registry: buildElectronLauncherNetworkOwnershipRegistry(claims),
    updatedAt: new Date().toISOString()
  };
}

function canonicalStandaloneOwnershipStatePath(
  statePath: string | null | undefined,
  ensureDirectory: boolean
): string {
  const absolute = resolve(statePath || defaultStandaloneOwnershipStatePath());
  const directory = dirname(absolute);
  if (ensureDirectory) mkdirSync(directory, { recursive: true });
  try {
    return join(realpathSync.native(directory), basename(absolute));
  } catch {
    return absolute;
  }
}

function withStandaloneOwnershipLock<T>(file: string, task: () => T): T {
  const legacyLockPath = `${file}.lock`;
  const lock = acquireElectronLauncherProcessLease(legacyLockPath, {
    waitMs: STANDALONE_OWNERSHIP_LOCK_WAIT_MS,
    retryMs: STANDALONE_OWNERSHIP_LOCK_RETRY_MS,
    metadata: { statePath: file }
  });
  try {
    reconcileLegacyStandaloneOwnershipLock(legacyLockPath);
    return task();
  } finally {
    releaseElectronLauncherProcessLease(lock);
  }
}

function reconcileLegacyStandaloneOwnershipLock(lockPath: string): void {
  let raw = '';
  let modifiedAt = 0;
  try {
    raw = readFileSync(lockPath, 'utf8');
    modifiedAt = statSync(lockPath).mtimeMs;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  const parsed = parseStandaloneOwnershipLock(raw);
  const stale = parsed
    ? !processExists(parsed.pid)
    : Date.now() - modifiedAt >= STANDALONE_OWNERSHIP_LOCK_LEASE_MS;
  if (!stale) {
    throw new Error(
      `Timed out acquiring standalone ownership lock ${lockPath}; a legacy launcher process still holds it.`
    );
  }
  unlinkSync(lockPath);
}

function parseStandaloneOwnershipLock(raw: string): StandaloneOwnershipLockFile | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StandaloneOwnershipLockFile>;
    return parsed.version === 1
      && Number.isInteger(parsed.pid)
      && Number(parsed.pid) > 0
      && typeof parsed.token === 'string'
      && Boolean(parsed.token)
      && typeof parsed.createdAt === 'string'
      && Number.isFinite(Date.parse(parsed.createdAt))
      && typeof parsed.expiresAt === 'string'
      && Number.isFinite(Date.parse(parsed.expiresAt))
      ? parsed as StandaloneOwnershipLockFile
      : null;
  } catch {
    return null;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(directory, 'r');
    fsyncSync(descriptor);
  } catch {
    // Windows does not consistently allow opening/fsyncing directories. The
    // state file itself was fsynced before the atomic rename.
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Best-effort durability barrier only.
      }
    }
  }
}

function errorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function buildDiagnostics(input: {
  state: ElectronLauncherStandaloneDataPlaneState;
  severity: ElectronLauncherStandaloneDataPlaneSeverity;
  message: string;
  productId: string | null;
  leaseIp: string | null;
  serviceVip: string | null;
  dnsServer: string | null;
  internalControlIp: string | null;
  domesticGatewayIp: string | null;
  probes: ElectronLauncherStandaloneRouteProbe[];
  endpoint: ElectronLauncherStandaloneEndpointProbe | null;
}): ElectronLauncherStandaloneDataPlaneDiagnostics {
  return {
    ok: input.state === 'network-ready',
    state: input.state,
    severity: input.severity,
    message: input.message,
    productId: input.productId,
    leaseIp: input.leaseIp,
    serviceVip: input.serviceVip,
    dnsServer: input.dnsServer,
    internalControlIp: input.internalControlIp,
    domesticGatewayIp: input.domesticGatewayIp,
    probes: input.probes,
    endpoint: input.endpoint,
    updatedAt: new Date().toISOString()
  };
}

function isProxyTunAddress(value: string | null | undefined): boolean {
  return Boolean(value && classifyLauncherIpv4Address(value) === 'proxy-fake-ip');
}

function normalizePriority(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 100;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return values
    .map((value) => String(value || '').trim())
    .filter((value, index, rows) => Boolean(value) && rows.indexOf(value) === index);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function dnsServerHost(value: string | null | undefined): string | null {
  const clean = stringValue(value);
  if (!clean) return null;
  const bracket = clean.match(/^\[([^\]]+)](?::\d{1,5})?$/);
  if (bracket?.[1]) return ipv4OrNull(bracket[1]);
  const ipv4WithPort = clean.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/);
  if (ipv4WithPort?.[1]) return ipv4OrNull(ipv4WithPort[1]);
  return ipv4OrNull(clean);
}

function ipv4OrNull(value: string | null | undefined): string | null {
  const clean = stringValue(value);
  return clean && isIP(clean) === 4 ? clean : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
