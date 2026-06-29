import { isIP } from 'node:net';
import type { LauncherRoutePlan } from '@qpjoy/mx-launcher-core';

import { classifyLauncherIpv4Address } from './network-diagnostics.js';
import {
  probeLauncherWireGuardEndpoint,
  probeLauncherWireGuardRoute
} from './wireguard.js';

export type ElectronLauncherStandaloneDataPlaneState =
  | 'lease-missing'
  | 'lease-active'
  | 'data-plane-pending'
  | 'proxy-tun-captured'
  | 'route-mismatch'
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
  if (state === 'proxy-tun-captured' || state === 'route-mismatch') return 'error';
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
