import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isIP } from 'node:net';
import type { LauncherRoutePlan } from '@qpjoy/mx-launcher-core';

import { classifyLauncherIpv4Address } from './network-diagnostics.js';
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

export interface ElectronLauncherStandaloneDataPlaneApplyInput
  extends ElectronLauncherWireGuardRuntimeOptions, ElectronLauncherStandaloneOwnershipInput {
  routePlan: LauncherRoutePlan;
  privateKey: string;
  dnsDomains?: string[] | null;
  suppressWireGuardDns?: boolean | null;
  mtu?: number | null;
  pathPreference?: ElectronLauncherWireGuardPathPreference;
  action?: 'up' | 'restart';
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
  const probes = [
    probeRouteTarget({
      target: 'lease-ip',
      label: 'Lease IP self route',
      address: leaseIp,
      required: Boolean(leaseIp)
    }, expectedInterfaceName, expectedInterfaceAddresses),
    probeRouteTarget({
      target: 'internal-control',
      label: 'Internal control plane',
      address: internalControlIp,
      required: Boolean(internalControlIp)
    }, expectedInterfaceName, expectedInterfaceAddresses),
    probeRouteTarget({
      target: 'domestic-gateway',
      label: 'Domestic DNS relay',
      address: domesticGatewayIp,
      required: Boolean(domesticGatewayIp)
    }, expectedInterfaceName, expectedInterfaceAddresses),
    probeRouteTarget({
      target: 'service-vip',
      label: 'Product service VIP',
      address: serviceVip,
      required: Boolean(serviceVip)
    }, expectedInterfaceName, expectedInterfaceAddresses),
    probeRouteTarget({
      target: 'dns-server',
      label: 'WireGuard DNS server',
      address: dnsServer,
      required: Boolean(dnsServer)
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
  const stateClaims = input.skipOwnershipState === true ? [] : readStandaloneOwnershipClaims(input.ownershipStatePath);
  const ownershipRegistry = buildElectronLauncherNetworkOwnershipRegistry([
    ...stateClaims.filter((claim) => claim.ownerId !== ownershipClaim.ownerId),
    ...(input.existingClaims ?? []),
    ownershipClaim
  ]);
  if (ownershipRegistry.conflicts.length > 0 && input.failOnOwnershipConflicts !== false) {
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
  if (input.skipOwnershipState !== true) {
    writeStandaloneOwnershipClaim(input.ownershipStatePath, ownershipClaim);
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
  if (input.skipOwnershipState !== true) {
    writeStandaloneOwnershipClaim(input.ownershipStatePath, finalOwnershipClaim);
  }
  const finalOwnershipRegistry = buildElectronLauncherNetworkOwnershipRegistry([
    ...stateClaims.filter((claim) => claim.ownerId !== ownershipClaim.ownerId),
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
  if (input.skipOwnershipState !== true && input.ownerId) {
    releaseStandaloneOwnershipClaim(input.ownershipStatePath, input.ownerId);
  }
  return {
    ok: wireGuard.ok === true,
    wireGuard,
    message: wireGuard.message ?? (wireGuard.ok ? 'Launcher standalone data plane stopped.' : 'Launcher standalone data plane stop failed.')
  };
}

export function readElectronLauncherStandaloneOwnershipState(statePath?: string | null): ElectronLauncherStandaloneOwnershipState {
  const file = statePath || defaultStandaloneOwnershipStatePath();
  const claims = readStandaloneOwnershipClaims(file);
  return {
    statePath: file,
    claims,
    registry: buildElectronLauncherNetworkOwnershipRegistry(claims),
    updatedAt: new Date().toISOString()
  };
}

export function upsertElectronLauncherStandaloneOwnershipClaim(
  claim: ElectronLauncherNetworkOwnershipClaim,
  statePath?: string | null
): ElectronLauncherStandaloneOwnershipState {
  writeStandaloneOwnershipClaim(statePath, claim);
  return readElectronLauncherStandaloneOwnershipState(statePath);
}

export function releaseElectronLauncherStandaloneOwnershipClaim(
  ownerId: string,
  statePath?: string | null
): ElectronLauncherStandaloneOwnershipState {
  releaseStandaloneOwnershipClaim(statePath, ownerId);
  return readElectronLauncherStandaloneOwnershipState(statePath);
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
    : routePlan.leaseCidr
      ? [routePlan.leaseCidr]
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
      dnsServer: routePlan.dnsServer
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

function readStandaloneOwnershipClaims(statePath?: string | null): ElectronLauncherNetworkOwnershipClaim[] {
  try {
    const parsed = JSON.parse(readFileSync(statePath || defaultStandaloneOwnershipStatePath(), 'utf8')) as Partial<StandaloneOwnershipStateFile>;
    return Array.isArray(parsed.claims)
      ? parsed.claims.filter((claim): claim is ElectronLauncherNetworkOwnershipClaim => Boolean(claim?.ownerId))
      : [];
  } catch {
    return [];
  }
}

function writeStandaloneOwnershipClaim(statePath: string | null | undefined, claim: ElectronLauncherNetworkOwnershipClaim): void {
  const file = statePath || defaultStandaloneOwnershipStatePath();
  const claims = [
    ...readStandaloneOwnershipClaims(file).filter((row) => row.ownerId !== claim.ownerId),
    claim
  ];
  writeStandaloneOwnershipState(file, claims);
}

function releaseStandaloneOwnershipClaim(statePath: string | null | undefined, ownerId: string): void {
  const file = statePath || defaultStandaloneOwnershipStatePath();
  const claims = readStandaloneOwnershipClaims(file).filter((row) => row.ownerId !== ownerId);
  writeStandaloneOwnershipState(file, claims);
}

function writeStandaloneOwnershipState(file: string, claims: ElectronLauncherNetworkOwnershipClaim[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({
    version: 1,
    claims,
    updatedAt: new Date().toISOString()
  }, null, 2), { mode: 0o600 });
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
