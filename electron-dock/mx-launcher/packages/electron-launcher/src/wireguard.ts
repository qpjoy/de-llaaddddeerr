import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  buildHdoRouteProbe,
  excludeLocalRoutesFromAllowedIps,
  getDarwinWireGuardLaunchDaemonStatus,
  getWireGuardTunnelStatus,
  installDarwinWireGuardLaunchDaemon,
  localCidrsForAllowedIpExclusion,
  repairWireGuardTunnelRoutes,
  renderWireGuardInterface,
  resolveWireGuardConnectionRuntime,
  setWireGuardTunnelState,
  uninstallDarwinWireGuardLaunchDaemon,
  type WireGuardServiceIdentity
} from '@qpjoy/electron-core-wireguard';
import type { LauncherRoutePlan } from '@qpjoy/mx-launcher-core';

export type ElectronLauncherWireGuardAction = 'up' | 'down' | 'restart';
export type ElectronLauncherWireGuardPathPreference = 'auto' | 'direct' | 'relay' | 'hybrid';
export type ElectronLauncherWireGuardPath = 'h2i-direct' | 'hdi-relay' | 'h2i-hybrid';

export interface ElectronLauncherWireGuardRuntimeOptions {
  userDataDir: string;
  profileName?: string;
  installDir?: string;
  bundledDir?: string | null;
  allowSystemFallback?: boolean;
  darwinLaunchDaemon?: boolean | null;
  darwinServiceIdentity?: WireGuardServiceIdentity;
  fallbackToAppManaged?: boolean | null;
}

export interface ElectronLauncherWireGuardPeerInput extends ElectronLauncherWireGuardRuntimeOptions {
  routePlan: LauncherRoutePlan;
  privateKey: string;
  dnsDomains?: string[];
  suppressWireGuardDns?: boolean | null;
  mtu?: number | null;
  pathPreference?: ElectronLauncherWireGuardPathPreference;
}

export interface ElectronLauncherWireGuardProbeInput extends ElectronLauncherWireGuardRuntimeOptions {
  targetIp: string;
  expectedInterfaceName?: string | null;
  expectedInterfaceAddresses?: string[] | null;
}

export interface ElectronLauncherWireGuardEndpointProbeInput {
  endpoint: string | null | undefined;
}

export interface ElectronLauncherWireGuardPeer {
  address: string;
  allowedIps: string[];
  config: string;
  configPath: string;
  dns: string[];
  endpoint: string;
  endpoints: string[];
  path: ElectronLauncherWireGuardPath;
  publicKey: string;
  publicKeys: string[];
  routeCidrs: string[];
  routePriorityCidrs: string[];
  routeProbe: ReturnType<typeof buildHdoRouteProbe>;
}

export function prepareLauncherWireGuardPeer(input: ElectronLauncherWireGuardPeerInput): ElectronLauncherWireGuardPeer {
  const routePlan = input.routePlan;
  const leaseIp = requiredString(routePlan.leaseIp, 'routePlan.leaseIp');
  const privateKey = requiredString(input.privateKey, 'privateKey');
  const selected = selectLauncherWireGuardPeers(routePlan, input.pathPreference ?? 'auto');
  if (selected.peers.length === 0) throw new Error('routePlan WireGuard peer is required');
  const routeCidrs = uniqueStrings(selected.routeCidrs);
  if (routeCidrs.length === 0) throw new Error('routePlan.routeCidrs is required');

  const routeProbe = buildHdoRouteProbe({ hdoCidrs: routeCidrs });
  const exclusionCidrs = localCidrsForAllowedIpExclusion(routeProbe, routeCidrs);
  const configPeers = selected.peers.map((peer) => {
    const publicKey = requiredString(peer.publicKey, `${peer.fieldPrefix}PublicKey`);
    const endpoint = requiredString(peer.endpoint, `${peer.fieldPrefix}Endpoint`);
    let allowedIps = excludeLocalRoutesFromAllowedIps(uniqueStrings(peer.routeCidrs), exclusionCidrs);
    if (allowedIps.length === 0 && process.platform === 'win32') {
      allowedIps = uniqueStrings(peer.routeCidrs);
    }
    if (allowedIps.length === 0) {
      if (selected.path === 'h2i-hybrid') return null;
      throw new Error(`${peer.name} AllowedIPs 与本机路由完全重叠，已拒绝生成会覆盖本地网络的配置。`);
    }
    return {
      name: peer.name,
      publicKey,
      endpoint,
      allowedIps,
      persistentKeepalive: 25
    };
  }).filter((peer): peer is NonNullable<typeof peer> => Boolean(peer));
  if (configPeers.length === 0) {
    throw new Error('服务端下发的 WireGuard AllowedIPs 与本机路由完全重叠，已拒绝生成会覆盖本地网络的配置。');
  }
  const allowedIps = uniqueStrings(configPeers.flatMap((peer) => peer.allowedIps));
  const routePriorityCidrs = launcherRoutePriorityCidrs(routePlan, routeCidrs);

  const suppressDns = input.suppressWireGuardDns === true;
  const dns = suppressDns ? [] : wireGuardDnsServers(routePlan.dnsServer);
  const splitDns = !suppressDns && Boolean(dns.length && input.dnsDomains?.length);
  const config = renderWireGuardInterface({
    privateKey,
    addresses: [`${leaseIp}/32`],
    dns: splitDns ? undefined : dns,
    hdoDnsServers: splitDns ? dns : undefined,
    hdoDnsDomains: splitDns ? input.dnsDomains : undefined,
    hdoRoutePriorityCidrs: routePriorityCidrs.length ? routePriorityCidrs : undefined,
    suppressInterfaceDns: splitDns,
    mtu: input.mtu,
    peers: configPeers
  });
  const configPath = writeLauncherWireGuardProfile(input, config);
  const endpoints = configPeers.map((peer) => peer.endpoint).filter(Boolean);
  const publicKeys = configPeers.map((peer) => peer.publicKey).filter(Boolean);
  return {
    address: `${leaseIp}/32`,
    allowedIps,
    config,
    configPath,
    dns,
    endpoint: endpoints[0] ?? '',
    endpoints,
    path: selected.path,
    publicKey: publicKeys[0] ?? '',
    publicKeys,
    routeCidrs,
    routePriorityCidrs,
    routeProbe
  };
}

function selectLauncherWireGuardPeers(
  routePlan: LauncherRoutePlan,
  preference: ElectronLauncherWireGuardPathPreference
): {
  path: ElectronLauncherWireGuardPath;
  routeCidrs: string[];
  peers: Array<{
    name: string;
    fieldPrefix: string;
    endpoint: string | null;
    publicKey: string | null;
    routeCidrs: string[];
  }>;
} {
  const directReady = routePlan.h2iDirectEnabled === true
    && Boolean(routePlan.h2iDirectEndpoint)
    && Boolean(routePlan.h2iDirectPublicKey);
  if (preference === 'direct') {
    return {
      path: 'h2i-direct',
      routeCidrs: routePlan.h2iDirectAllowedIps?.length ? routePlan.h2iDirectAllowedIps : routePlan.routeCidrs,
      peers: [
        {
          name: 'MX H2I Internal Direct',
          fieldPrefix: 'routePlan.h2iDirect',
          endpoint: routePlan.h2iDirectEndpoint,
          publicKey: routePlan.h2iDirectPublicKey,
          routeCidrs: routePlan.h2iDirectAllowedIps?.length ? routePlan.h2iDirectAllowedIps : routePlan.routeCidrs
        }
      ]
    };
  }
  if ((preference === 'auto' || preference === 'hybrid') && directReady) {
    const directCidrs = hybridDirectCidrs(routePlan);
    return {
      path: 'h2i-hybrid',
      routeCidrs: uniqueStrings([...routePlan.routeCidrs, ...directCidrs]),
      peers: [
        {
          name: 'MX H2I Internal Direct',
          fieldPrefix: 'routePlan.h2iDirect',
          endpoint: routePlan.h2iDirectEndpoint,
          publicKey: routePlan.h2iDirectPublicKey,
          routeCidrs: directCidrs
        },
        {
          name: 'MX HDI Domestic Relay',
          fieldPrefix: 'routePlan.domesticRelay',
          endpoint: routePlan.domesticRelayEndpoint,
          publicKey: routePlan.domesticRelayPublicKey,
          routeCidrs: routePlan.routeCidrs
        }
      ]
    };
  }
  return {
    path: 'hdi-relay',
    routeCidrs: routePlan.routeCidrs,
    peers: [
      {
        name: 'MX HDI Domestic Relay',
        fieldPrefix: 'routePlan.domesticRelay',
        endpoint: routePlan.domesticRelayEndpoint,
        publicKey: routePlan.domesticRelayPublicKey,
        routeCidrs: routePlan.routeCidrs
      }
    ]
  };
}

function hybridDirectCidrs(routePlan: LauncherRoutePlan): string[] {
  const directHosts = uniqueStrings([
    routePlan.internalControlIp,
    ipv4HostFromUrl(routePlan.internalBaseUrl)
  ].filter((value): value is string => Boolean(value)));
  return directHosts.length ? directHosts.map((host) => `${host}/32`) : uniqueStrings(routePlan.h2iDirectAllowedIps ?? []);
}

function ipv4HostFromUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const host = new URL(value).hostname;
    return isIpv4(host) ? host : null;
  } catch {
    return null;
  }
}

function launcherRoutePriorityCidrs(routePlan: LauncherRoutePlan, routeCidrs: string[]): string[] {
  const hosts = uniqueStrings([
    routePlan.domesticGatewayIp,
    routePlan.internalControlIp,
    ipv4HostFromUrl(routePlan.internalBaseUrl),
    wireGuardDnsServerHost(routePlan.dnsServer)
  ].filter((value): value is string => Boolean(value && isIpv4(value))));
  return hosts
    .filter((host) => routeCidrs.some((cidr) => cidrContainsHost(cidr, host)))
    .map((host) => `${host}/32`);
}

function wireGuardDnsServers(value: string | null | undefined): string[] {
  const server = wireGuardDnsServerHost(value);
  return server ? [server] : [];
}

function wireGuardDnsServerHost(value: string | null | undefined): string | null {
  const clean = value?.trim();
  if (!clean) return null;
  const bracket = clean.match(/^\[([^\]]+)](?::\d{1,5})?$/);
  if (bracket?.[1]) return bracket[1];
  const ipv4WithPort = clean.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/);
  if (ipv4WithPort?.[1]) return ipv4WithPort[1];
  return clean;
}

export function resolveLauncherWireGuardRuntime(input: ElectronLauncherWireGuardRuntimeOptions) {
  return resolveWireGuardConnectionRuntime({
    installDir: input.installDir ?? join(input.userDataDir, 'bin'),
    bundledDir: input.bundledDir ?? defaultBundledWireGuardDir(),
    allowSystemFallback: input.allowSystemFallback ?? false
  });
}

export async function connectLauncherWireGuardPeer(
  input: ElectronLauncherWireGuardPeerInput & { action?: ElectronLauncherWireGuardAction }
) {
  const peer = prepareLauncherWireGuardPeer(input);
  const runtime = resolveLauncherWireGuardRuntime(input);
  const action = input.action ?? 'restart';
  if (action !== 'down' && shouldUseDarwinLaunchDaemon(input, runtime)) {
    const launchDaemon = await installDarwinWireGuardLaunchDaemon({
      runtime,
      configPath: peer.configPath,
      serviceIdentity: launcherDarwinServiceIdentity(input)
    });
    const status = await waitForLauncherWireGuardStatus(runtime, peer.configPath);
    const missingRoutes = Array.isArray(status?.missingRoutes) ? status.missingRoutes.length : 0;
    const ok = launchDaemon.ok === true && status?.active === true && missingRoutes === 0;
    if (launchDaemon.ok || isDarwinAuthorizationCancelled(launchDaemon) || input.fallbackToAppManaged === false) {
      return {
        ok,
        action,
        peer,
        runtime,
        status,
        launchDaemon,
        tunnel: {
          ok: launchDaemon.ok,
          configPath: peer.configPath,
          routeLogPath: launchDaemon.routeLogPath,
          routeLogTail: launchDaemon.routeLogTail,
          message: launchDaemon.message
        },
        message: ok ? launchDaemon.message : launcherWireGuardNotReadyMessage(launchDaemon, status)
      };
    }
  }
  const tunnel = await setWireGuardTunnelState({
    runtime,
    configPath: peer.configPath,
    action
  });
  const status = await waitForLauncherWireGuardStatus(runtime, peer.configPath);
  const missingRoutes = Array.isArray(status?.missingRoutes) ? status.missingRoutes.length : 0;
  const ok = tunnel.ok === true && status?.active === true && missingRoutes === 0;
  return {
    ok,
    action,
    peer,
    runtime,
    status,
    tunnel,
    message: ok ? tunnel.message : launcherWireGuardNotReadyMessage(tunnel, status)
  };
}

async function waitForLauncherWireGuardStatus(
  runtime: ReturnType<typeof resolveWireGuardConnectionRuntime>,
  configPath: string
): Promise<ReturnType<typeof getWireGuardTunnelStatus> | null> {
  const attempts = runtime.platform === 'win32'
    ? 16
    : runtime.platform === 'darwin' && runtime.method === 'darwin-userspace'
      ? 12
      : 1;
  let status: ReturnType<typeof getWireGuardTunnelStatus> | null = null;
  for (let index = 0; index < attempts; index += 1) {
    status = safeWireGuardStatus(runtime, configPath);
    const missingRoutes = Array.isArray(status?.missingRoutes) ? status.missingRoutes.length : 0;
    if ((status?.active === true && missingRoutes === 0) || index === attempts - 1) return status;
    await delay(runtime.platform === 'darwin' && runtime.method === 'darwin-userspace' ? 350 : 500);
  }
  return status;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export async function stopLauncherWireGuardPeer(input: ElectronLauncherWireGuardRuntimeOptions) {
  const configPath = launcherWireGuardConfigPath(input);
  if (!existsSync(configPath)) {
    return {
      ok: true,
      skipped: true,
      reason: 'missing-wireguard-config',
      configPath
    };
  }
  const runtime = resolveLauncherWireGuardRuntime(input);
  if (shouldUseDarwinLaunchDaemon(input, runtime)) {
    const launchDaemonStatus = getDarwinWireGuardLaunchDaemonStatus({
      runtime,
      configPath,
      serviceIdentity: launcherDarwinServiceIdentity(input)
    });
    if (launchDaemonStatus.installed || launchDaemonStatus.loaded || launchDaemonStatus.running) {
      const launchDaemon = await uninstallDarwinWireGuardLaunchDaemon({
        runtime,
        configPath,
        serviceIdentity: launcherDarwinServiceIdentity(input)
      });
      const status = safeWireGuardStatus(runtime, configPath);
      return {
        ok: launchDaemon.ok === true,
        skipped: false,
        configPath,
        runtime,
        status,
        launchDaemon,
        tunnel: {
          ok: launchDaemon.ok,
          configPath,
          routeLogPath: launchDaemon.routeLogPath,
          routeLogTail: launchDaemon.routeLogTail,
          message: launchDaemon.message
        },
        message: launchDaemon.message
      };
    }
  }
  const tunnel = await setWireGuardTunnelState({
    runtime,
    configPath,
    action: 'down'
  });
  const status = safeWireGuardStatus(runtime, configPath);
  return {
    ok: tunnel.ok === true,
    skipped: false,
    configPath,
    runtime,
    status,
    tunnel,
    message: tunnel.message
  };
}

export async function repairLauncherWireGuardPeerRoutes(input: ElectronLauncherWireGuardRuntimeOptions) {
  const configPath = launcherWireGuardConfigPath(input);
  if (!existsSync(configPath)) {
    return {
      ok: true,
      skipped: true,
      reason: 'missing-wireguard-config',
      configPath
    };
  }
  const runtime = resolveLauncherWireGuardRuntime(input);
  const repaired = await repairWireGuardTunnelRoutes({ runtime, configPath });
  const status = safeWireGuardStatus(runtime, configPath);
  const missingRoutes = Array.isArray(status?.missingRoutes) ? status.missingRoutes : [];
  const ok = repaired.ok === true && (status?.active !== true || missingRoutes.length === 0);
  return {
    ...repaired,
    ok,
    configPath,
    runtime,
    status,
    missingRoutes,
    message: ok
      ? repaired.message
      : `${repaired.message || 'WireGuard route repair completed, but route probes are still not ready.'}${missingRoutes.length ? ` missingRoutes=${missingRoutes.join(', ')}` : ''}`
  };
}

export async function recoverLauncherWireGuardPeer(
  input: ElectronLauncherWireGuardRuntimeOptions & { reason?: string | null }
) {
  const configPath = launcherWireGuardConfigPath(input);
  if (!existsSync(configPath)) {
    return {
      ok: true,
      skipped: true,
      reason: 'missing-wireguard-config',
      recoveryReason: input.reason ?? null,
      configPath
    };
  }
  const runtime = resolveLauncherWireGuardRuntime(input);
  const status = safeWireGuardStatus(runtime, configPath);
  const missingRoutes = Array.isArray(status?.missingRoutes) ? status.missingRoutes : [];
  if (status?.active === true && missingRoutes.length === 0) {
    return {
      ok: true,
      skipped: true,
      reason: 'already-active',
      recoveryReason: input.reason ?? null,
      configPath,
      runtime,
      status
    };
  }
  if (status?.active === true && missingRoutes.length > 0) {
    const repaired = await repairLauncherWireGuardPeerRoutes(input);
    return {
      ...repaired,
      action: 'repair-routes',
      recoveryReason: input.reason ?? null
    };
  }
  if (shouldUseDarwinLaunchDaemon(input, runtime)) {
    const launchDaemon = await installDarwinWireGuardLaunchDaemon({
      runtime,
      configPath,
      serviceIdentity: launcherDarwinServiceIdentity(input)
    });
    const nextStatus = await waitForLauncherWireGuardStatus(runtime, configPath);
    const nextMissingRouteCount = Array.isArray(nextStatus?.missingRoutes) ? nextStatus.missingRoutes.length : 0;
    const ok = launchDaemon.ok === true && nextStatus?.active === true && nextMissingRouteCount === 0;
    if (launchDaemon.ok || isDarwinAuthorizationCancelled(launchDaemon) || input.fallbackToAppManaged === false) {
      return {
        ok,
        action: 'launchdaemon-recover',
        recoveryReason: input.reason ?? null,
        configPath,
        runtime,
        status: nextStatus,
        launchDaemon,
        tunnel: {
          ok: launchDaemon.ok,
          configPath,
          routeLogPath: launchDaemon.routeLogPath,
          routeLogTail: launchDaemon.routeLogTail,
          message: launchDaemon.message
        },
        message: ok ? launchDaemon.message : launcherWireGuardNotReadyMessage(launchDaemon, nextStatus)
      };
    }
  }
  const tunnel = await setWireGuardTunnelState({
    runtime,
    configPath,
    action: 'up'
  });
  const nextStatus = await waitForLauncherWireGuardStatus(runtime, configPath);
  const nextMissingRouteCount = Array.isArray(nextStatus?.missingRoutes) ? nextStatus.missingRoutes.length : 0;
  const ok = tunnel.ok === true && nextStatus?.active === true && nextMissingRouteCount === 0;
  return {
    ok,
    action: 'recover-up',
    recoveryReason: input.reason ?? null,
    configPath,
    runtime,
    status: nextStatus,
    tunnel,
    message: ok ? tunnel.message : launcherWireGuardNotReadyMessage(tunnel, nextStatus)
  };
}

export function getLauncherWireGuardPeerStatus(input: ElectronLauncherWireGuardRuntimeOptions) {
  const configPath = launcherWireGuardConfigPath(input);
  if (!existsSync(configPath)) {
    return {
      ok: false,
      active: false,
      configPath,
      error: 'WireGuard config missing'
    };
  }
  const runtime = resolveLauncherWireGuardRuntime(input);
  const status = safeWireGuardStatus(runtime, configPath);
  if (!shouldUseDarwinLaunchDaemon(input, runtime)) return status;
  const launchDaemon = getDarwinWireGuardLaunchDaemonStatus({
    runtime,
    configPath,
    serviceIdentity: launcherDarwinServiceIdentity(input)
  });
  return {
    ...(status ?? {
      ok: false,
      active: false,
      configPath,
      error: 'WireGuard status unavailable'
    }),
    launchDaemon
  };
}

export function probeLauncherWireGuardRoute(input: ElectronLauncherWireGuardProbeInput) {
  const targetIp = requiredString(input.targetIp, 'targetIp');
  const route = readRouteToTarget(targetIp);
  const interfaceName = route.interfaceName;
  const gateway = route.gateway;
  const viaLoopback = interfaceName === 'lo0' || gateway === '127.0.0.1' || gateway === '::1';
  const expected = input.expectedInterfaceName?.trim() || null;
  const expectedAddresses = uniqueStrings(input.expectedInterfaceAddresses ?? [])
    .map((address) => address.split('/')[0]?.trim() ?? '')
    .filter(isIpv4);
  const interfaceMatches = routeInterfaceMatchesExpected(interfaceName, expected, expectedAddresses);
  const viaWireGuard = Boolean(interfaceName && !viaLoopback && interfaceMatches);
  return {
    ok: viaWireGuard,
    targetIp,
    interfaceName,
    gateway,
    viaLoopback,
    expectedInterfaceName: expected,
    raw: route.raw,
    error: route.error
  };
}

export function probeLauncherWireGuardEndpoint(input: ElectronLauncherWireGuardEndpointProbeInput) {
  const endpoint = stringValue(input.endpoint);
  const host = endpointHost(endpoint);
  if (!endpoint || !host) {
    return {
      ok: false,
      endpoint: endpoint ?? null,
      host,
      interfaceName: null,
      gateway: null,
      viaProxyTun: false,
      raw: null,
      error: 'WireGuard endpoint is empty or unsupported'
    };
  }
  if (!isIpv4(host)) {
    return {
      ok: false,
      endpoint,
      host,
      interfaceName: null,
      gateway: null,
      viaProxyTun: false,
      raw: null,
      error: `endpoint host is not an IPv4 address: ${host}`
    };
  }
  const route = readRouteToTarget(host);
  const viaProxyTun = isProxyTunGateway(route.gateway);
  return {
    ok: Boolean(route.interfaceName || route.gateway) && !viaProxyTun && !route.error,
    endpoint,
    host,
    interfaceName: route.interfaceName,
    gateway: route.gateway,
    viaProxyTun,
    raw: route.raw,
    error: route.error ?? (viaProxyTun ? `endpoint route is captured by proxy TUN gateway ${route.gateway}` : null)
  };
}

export function launcherWireGuardConfigPath(input: ElectronLauncherWireGuardRuntimeOptions): string {
  const profileName = sanitizeProfileName(input.profileName ?? 'mx-h2i.conf');
  return join(input.userDataDir, 'wireguard', profileName);
}

export function defaultBundledWireGuardDir(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? process.cwd();
  const candidates = [
    join(resourcesPath, 'qpjoy-wireguard-engine'),
    join(resourcesPath, 'wireguard'),
    resolve(process.cwd(), 'resources/qpjoy-wireguard-engine'),
    resolve(process.cwd(), 'resources/wireguard')
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function writeLauncherWireGuardProfile(input: ElectronLauncherWireGuardRuntimeOptions, config: string): string {
  const configPath = launcherWireGuardConfigPath(input);
  mkdirSync(join(input.userDataDir, 'wireguard'), { recursive: true });
  writeFileSync(configPath, config, { mode: 0o600 });
  return configPath;
}

function safeWireGuardStatus(
  runtime: ReturnType<typeof resolveWireGuardConnectionRuntime>,
  configPath: string
): ReturnType<typeof getWireGuardTunnelStatus> | null {
  try {
    return getWireGuardTunnelStatus({ runtime, configPath });
  } catch {
    return null;
  }
}

function shouldUseDarwinLaunchDaemon(
  input: ElectronLauncherWireGuardRuntimeOptions,
  runtime: ReturnType<typeof resolveWireGuardConnectionRuntime>
): boolean {
  return input.darwinLaunchDaemon !== false
    && runtime.platform === 'darwin'
    && runtime.method === 'darwin-userspace';
}

function launcherDarwinServiceIdentity(input: ElectronLauncherWireGuardRuntimeOptions): WireGuardServiceIdentity {
  return input.darwinServiceIdentity ?? {
    displayName: 'Electron Launcher WireGuard',
    darwinLaunchDaemonLabelPrefix: 'com.qpjoy.electron-launcher.wireguard',
    darwinSupportRoot: '/Library/Application Support/QPJoy/Electron Launcher',
    darwinLogDir: '/Library/Logs/QPJoy-Electron-Launcher',
    darwinDaemonScriptName: 'electron-launcher-wireguard-daemon.sh',
    staleDarwinLaunchDaemonLabelPrefixes: ['com.qpjoy.electron-launcher.wireguard']
  };
}

function isDarwinAuthorizationCancelled(result: unknown): boolean {
  const message = stringValue(objectRecord(result).message) || stringValue(objectRecord(result).error) || '';
  return /user canceled|用户已取消|-128/i.test(message);
}

function launcherWireGuardNotReadyMessage(tunnel: unknown, status: unknown): string {
  const tunnelRecord = objectRecord(tunnel);
  const statusRecord = objectRecord(status);
  const parts = uniqueStrings([
    stringValue(tunnelRecord.message),
    tunnelRecord.ok === true && statusRecord.active !== true ? 'WireGuard command succeeded but tunnel status is not active yet' : null,
    stringValue(statusRecord.serviceState) ? `service=${stringValue(statusRecord.serviceState)}` : null,
    stringValue(statusRecord.error),
    stringValue(tunnelRecord.error)
  ].filter((item): item is string => Boolean(item)));
  return parts.length ? parts.join('; ') : 'WireGuard tunnel is not active yet';
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function endpointHost(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const bracket = trimmed.match(/^\[([^\]]+)](?::\d+)?$/);
  if (bracket?.[1]) return bracket[1];
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).hostname || null;
    } catch {
      return null;
    }
  }
  const parts = trimmed.split(':');
  if (parts.length === 1) return parts[0] || null;
  if (parts.length === 2) return parts[0] || null;
  return null;
}

function isProxyTunGateway(value: string | null | undefined): boolean {
  const gateway = value ? ipv4ToInt(value) : null;
  const start = ipv4ToInt('198.18.0.0');
  const end = ipv4ToInt('198.19.255.255');
  return gateway !== null && start !== null && end !== null && gateway >= start && gateway <= end;
}

function routeInterfaceMatchesExpected(
  interfaceName: string | null,
  expectedInterfaceName: string | null,
  expectedAddresses: string[]
): boolean {
  if (!interfaceName) return false;
  if (!expectedInterfaceName) {
    return expectedAddresses.length > 0
      ? interfaceHasExpectedAddress(interfaceName, expectedAddresses)
      : isWireGuardLikeInterface(interfaceName);
  }
  if (interfaceName === expectedInterfaceName) return true;

  if (/^wg/.test(interfaceName) && /^wg/.test(expectedInterfaceName)) {
    return true;
  }
  return interfaceHasExpectedAddress(interfaceName, expectedAddresses);
}

function isWireGuardLikeInterface(interfaceName: string): boolean {
  return /^utun\d+$/.test(interfaceName) || /^wg/.test(interfaceName);
}

function interfaceHasExpectedAddress(interfaceName: string, expectedAddresses: string[]): boolean {
  const ips = expectedAddresses
    .map((address) => address.split('/')[0]?.trim() ?? '')
    .filter(isIpv4);
  if (ips.length === 0) return false;
  if (process.platform !== 'darwin' && process.platform !== 'linux') return false;
  try {
    const raw = execFileSync('ifconfig', [interfaceName], { encoding: 'utf8', timeout: 2000 });
    return ips.some((ip) => raw.includes(`inet ${ip}`));
  } catch {
    return false;
  }
}

function readRouteToTarget(targetIp: string): {
  interfaceName: string | null;
  gateway: string | null;
  raw: string | null;
  error: string | null;
} {
  try {
    if (process.platform === 'darwin') {
      const raw = execFileSync('route', ['-n', 'get', targetIp], { encoding: 'utf8', timeout: 2500 });
      return {
        interfaceName: matchRouteField(raw, 'interface'),
        gateway: matchRouteField(raw, 'gateway'),
        raw,
        error: null
      };
    }
    if (process.platform === 'linux') {
      const raw = execFileSync('ip', ['route', 'get', targetIp], { encoding: 'utf8', timeout: 2500 });
      const interfaceName = raw.match(/\bdev\s+(\S+)/)?.[1] ?? null;
      const gateway = raw.match(/\bvia\s+(\S+)/)?.[1] ?? null;
      return { interfaceName, gateway, raw, error: null };
    }
    if (process.platform === 'win32') {
      return readWindowsRouteToTarget(targetIp);
    }
    return {
      interfaceName: null,
      gateway: null,
      raw: null,
      error: `route probe is not implemented on ${process.platform}`
    };
  } catch (err) {
    return {
      interfaceName: null,
      gateway: null,
      raw: null,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

function readWindowsRouteToTarget(targetIp: string): {
  interfaceName: string | null;
  gateway: string | null;
  raw: string | null;
  error: string | null;
} {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$ifaces = @{}',
    "Get-NetIPInterface -AddressFamily IPv4 | ForEach-Object { $ifaces[[string]$_.InterfaceIndex] = $_.InterfaceAlias }",
    'Get-NetRoute -AddressFamily IPv4 | ForEach-Object {',
    '  [pscustomobject]@{',
    '    DestinationPrefix = $_.DestinationPrefix;',
    '    NextHop = $_.NextHop;',
    '    InterfaceIndex = $_.InterfaceIndex;',
    '    InterfaceAlias = $ifaces[[string]$_.InterfaceIndex];',
    '    RouteMetric = $_.RouteMetric;',
    '    InterfaceMetric = $_.InterfaceMetric',
    '  }',
    '} | ConvertTo-Json -Compress'
  ].join('; ');
  try {
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8',
      timeout: 3500,
      windowsHide: true
    }).trim();
    const rows = normalizeWindowsRouteRows(JSON.parse(raw));
    const best = bestWindowsRouteForTarget(rows, targetIp);
    if (best) {
      return {
        interfaceName: best.interfaceAlias || (best.interfaceIndex ? String(best.interfaceIndex) : null),
        gateway: best.nextHop && best.nextHop !== '0.0.0.0' ? best.nextHop : null,
        raw: JSON.stringify(best),
        error: null
      };
    }
    return {
      interfaceName: null,
      gateway: null,
      raw,
      error: `no Windows route matched ${targetIp}`
    };
  } catch (err) {
    return readWindowsRoutePrintToTarget(targetIp, err);
  }
}

function readWindowsRoutePrintToTarget(targetIp: string, previousError: unknown): {
  interfaceName: string | null;
  gateway: string | null;
  raw: string | null;
  error: string | null;
} {
  try {
    const raw = execFileSync('route.exe', ['print', '-4'], {
      encoding: 'utf8',
      timeout: 3500,
      windowsHide: true
    });
    const rows = raw.split(/\r?\n/)
      .map((line) => line.trim())
      .map(parseWindowsRoutePrintLine)
      .filter((row): row is WindowsRouteRow => Boolean(row));
    const best = bestWindowsRouteForTarget(rows, targetIp);
    if (best) {
      return {
        interfaceName: best.interfaceAlias || null,
        gateway: best.nextHop && best.nextHop !== '0.0.0.0' ? best.nextHop : null,
        raw: best.raw || raw,
        error: null
      };
    }
    return {
      interfaceName: null,
      gateway: null,
      raw,
      error: `PowerShell route probe failed (${errorText(previousError)}); route.exe found no route for ${targetIp}`
    };
  } catch (err) {
    return {
      interfaceName: null,
      gateway: null,
      raw: null,
      error: `PowerShell route probe failed (${errorText(previousError)}); route.exe failed (${errorText(err)})`
    };
  }
}

type WindowsRouteRow = {
  destinationPrefix: string;
  nextHop: string | null;
  interfaceAlias: string | null;
  interfaceIndex: number | null;
  routeMetric: number;
  interfaceMetric: number;
  raw?: string | null;
};

function normalizeWindowsRouteRows(input: unknown): WindowsRouteRow[] {
  const rows = Array.isArray(input) ? input : input ? [input] : [];
  return rows.map((row) => {
    const record = row && typeof row === 'object' ? row as Record<string, unknown> : {};
    return {
      destinationPrefix: stringField(record.DestinationPrefix),
      nextHop: nullableField(record.NextHop),
      interfaceAlias: nullableField(record.InterfaceAlias),
      interfaceIndex: numericField(record.InterfaceIndex),
      routeMetric: numericField(record.RouteMetric) ?? 0,
      interfaceMetric: numericField(record.InterfaceMetric) ?? 0,
      raw: JSON.stringify(record)
    };
  }).filter((row) => Boolean(row.destinationPrefix));
}

function parseWindowsRoutePrintLine(line: string): WindowsRouteRow | null {
  const columns = line.trim().split(/\s+/);
  if (columns.length < 5 || !isIpv4(columns[0]) || !isIpv4(columns[1])) return null;
  const prefix = cidrFromAddressAndMask(columns[0], columns[1]);
  if (!prefix) return null;
  return {
    destinationPrefix: prefix,
    nextHop: columns[2] === 'On-link' ? null : columns[2] ?? null,
    interfaceAlias: columns[3] ?? null,
    interfaceIndex: null,
    routeMetric: Number(columns[4]) || 0,
    interfaceMetric: 0,
    raw: line
  };
}

function bestWindowsRouteForTarget(rows: WindowsRouteRow[], targetIp: string): WindowsRouteRow | null {
  const target = ipv4ToInt(targetIp);
  if (target === null) return null;
  const candidates = rows
    .map((row) => ({ row, parsed: parseCidr(row.destinationPrefix) }))
    .filter((entry): entry is { row: WindowsRouteRow; parsed: { network: number; prefix: number; mask: number } } =>
      Boolean(entry.parsed && (target & entry.parsed.mask) === entry.parsed.network)
    )
    .sort((a, b) => {
      if (b.parsed.prefix !== a.parsed.prefix) return b.parsed.prefix - a.parsed.prefix;
      return (a.row.routeMetric + a.row.interfaceMetric) - (b.row.routeMetric + b.row.interfaceMetric);
    });
  return candidates[0]?.row ?? null;
}

function matchRouteField(raw: string, field: string): string | null {
  const match = raw.match(new RegExp(`^\\s*${field}:\\s*(\\S+)`, 'm'));
  return match?.[1] ?? null;
}

function requiredString(value: string | null | undefined, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${field} is required`);
  return trimmed;
}

function uniqueStrings(values: readonly string[] | null | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function sanitizeProfileName(value: string): string {
  const trimmed = value.trim() || 'mx-h2i.conf';
  return trimmed.replace(/[/\\]/g, '-');
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function nullableField(value: unknown): string | null {
  const text = stringField(value);
  return text || null;
}

function numericField(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isIpv4(value: string | null | undefined): value is string {
  if (!value) return false;
  return ipv4ToInt(value) !== null;
}

function ipv4ToInt(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const number = Number(part);
    if (!Number.isInteger(number) || number < 0 || number > 255) return null;
    out = ((out << 8) | number) >>> 0;
  }
  return out >>> 0;
}

function parseCidr(value: string): { network: number; prefix: number; mask: number } | null {
  const [address, prefixText] = value.split('/');
  const ip = ipv4ToInt(address ?? '');
  const prefix = Number(prefixText);
  if (ip === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return {
    network: (ip & mask) >>> 0,
    prefix,
    mask
  };
}

function cidrContainsHost(cidr: string, host: string): boolean {
  const parsed = parseCidr(cidr);
  const ip = ipv4ToInt(host);
  if (!parsed || ip === null) return false;
  return ((ip & parsed.mask) >>> 0) === parsed.network;
}

function cidrFromAddressAndMask(address: string, maskText: string): string | null {
  const ip = ipv4ToInt(address);
  const mask = ipv4ToInt(maskText);
  if (ip === null || mask === null) return null;
  const prefix = maskToPrefix(mask);
  if (prefix === null) return null;
  return `${intToIpv4((ip & mask) >>> 0)}/${prefix}`;
}

function maskToPrefix(mask: number): number | null {
  let prefix = 0;
  let seenZero = false;
  for (let bit = 31; bit >= 0; bit -= 1) {
    const one = Boolean(mask & (1 << bit));
    if (one && seenZero) return null;
    if (one) prefix += 1;
    else seenZero = true;
  }
  return prefix;
}

function intToIpv4(value: number): string {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255
  ].join('.');
}
