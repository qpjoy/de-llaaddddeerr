import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, win32 as pathWin32 } from 'node:path';
import { gunzipSync } from 'node:zlib';

export type HdoMeshRole = 'domestic' | 'home' | 'user' | 'oversea' | 'service';

export interface HdoMeshAddressPlan {
  homeCidr: string;
  userCidr: string;
  serviceCidr: string;
  domesticIp: string;
  defaultListenPort: number;
}

export interface WireGuardPeer {
  name?: string;
  publicKey: string;
  presharedKey?: string | null;
  allowedIps: string[];
  endpoint?: string | null;
  persistentKeepalive?: number | null;
}

export interface WireGuardInterface {
  privateKey: string;
  addresses: string[];
  listenPort?: number | null;
  dns?: string[];
  hdoDnsServers?: string[];
  hdoDnsDomains?: string[];
  hdoRoutePriorityCidrs?: string[];
  suppressInterfaceDns?: boolean;
  mtu?: number | null;
  peers: WireGuardPeer[];
}

export interface WireGuardKeyPair {
  privateKey: string;
  publicKey: string;
}

export interface WireGuardCliStatus {
  available: boolean;
  command: string;
  version?: string | null;
  error?: string | null;
}

export type WireGuardCliSource = 'installed' | 'bundled' | 'system' | 'missing';

export type WireGuardToolName = 'wg' | 'wg-quick' | 'wireguard-go' | 'wireguard' | 'bash';

export type WireGuardTunnelAction = 'up' | 'down' | 'restart';

export type WireGuardPrivilegedExecution = 'not-started' | 'started' | 'authorization-canceled';

export interface WireGuardRuntimeStatus {
  target: string;
  available: boolean;
  source: WireGuardCliSource;
  command: string | null;
  bundledPath: string | null;
  installedPath: string | null;
  systemPath: string | null;
  error?: string | null;
}

export interface WireGuardRuntimeOptions {
  installDir: string;
  bundledDir?: string | null;
  commandName?: string;
  allowSystemFallback?: boolean;
}

export interface WireGuardToolStatus {
  target: string;
  name: WireGuardToolName;
  available: boolean;
  source: WireGuardCliSource;
  command: string | null;
  bundledPath: string | null;
  installedPath: string | null;
  systemPath: string | null;
  error?: string | null;
}

export interface WireGuardConnectionRuntimeOptions extends WireGuardRuntimeOptions {
  platform?: NodeJS.Platform;
}

export interface WireGuardConnectionRuntimeStatus {
  target: string;
  platform: NodeJS.Platform;
  available: boolean;
  method: 'wg-quick' | 'darwin-userspace' | 'windows-service' | 'missing';
  wg: WireGuardRuntimeStatus;
  wgQuick: WireGuardToolStatus | null;
  wireGuardGo: WireGuardToolStatus | null;
  bash: WireGuardToolStatus | null;
  windowsWireGuard: WireGuardToolStatus | null;
  warnings: string[];
  error?: string | null;
}

export interface WireGuardServiceIdentity {
  displayName?: string;
  darwinLaunchDaemonLabelPrefix?: string;
  darwinSupportRoot?: string;
  darwinLogDir?: string;
  darwinDaemonScriptName?: string;
  staleDarwinLaunchDaemonLabelPrefixes?: string[];
  darwinExtraInstallShell?: string | null;
  darwinExtraUninstallShell?: string | null;
}

export interface WireGuardTunnelCommand {
  action: WireGuardTunnelAction;
  platform: NodeJS.Platform;
  configPath: string;
  command: string;
  args: string[];
  displayCommand: string;
  needsAdmin: boolean;
  runtime: WireGuardConnectionRuntimeStatus;
  env?: Record<string, string>;
}

export interface WireGuardTunnelResult {
  ok: boolean;
  authorizationCanceled?: boolean;
  action: WireGuardTunnelAction;
  mode: string;
  configPath: string;
  command: string;
  routeLogPath?: string | null;
  routeLogTail?: string | null;
  stdout?: string;
  stderr?: string;
  message: string;
  runtime: WireGuardConnectionRuntimeStatus;
}

export interface WireGuardRouteRepairResult {
  ok: boolean;
  authorizationCanceled?: boolean;
  privilegedExecution?: WireGuardPrivilegedExecution;
  mode: string;
  configPath: string;
  interfaceName: string | null;
  realInterfaceName: string | null;
  command: string;
  routeLogPath?: string | null;
  routeLogTail?: string | null;
  stdout?: string;
  stderr?: string;
  message: string;
  runtime: WireGuardConnectionRuntimeStatus;
}

export interface WireGuardLaunchDaemonStatus {
  ok: boolean;
  supported: boolean;
  installed: boolean;
  loaded: boolean;
  running: boolean;
  mode: string;
  label: string | null;
  plistPath: string | null;
  supportDir: string | null;
  daemonScriptPath: string | null;
  configPath: string;
  stdout?: string;
  stderr?: string;
  error?: string | null;
  runtime: WireGuardConnectionRuntimeStatus;
}

export interface WireGuardLaunchDaemonResult extends WireGuardLaunchDaemonStatus {
  authorizationCanceled?: boolean;
  privilegedExecution?: WireGuardPrivilegedExecution;
  command: string;
  routeLogPath?: string | null;
  routeLogTail?: string | null;
  message: string;
}

export interface WireGuardPeerRuntimeStatus {
  publicKey: string;
  endpoint: string | null;
  allowedIps: string[];
  latestHandshakeAt: string | null;
  latestHandshakeSeconds: number | null;
  transferRxBytes: number;
  transferTxBytes: number;
  persistentKeepalive: number | null;
}

export interface WireGuardRouteProbeStatus {
  cidr: string;
  target: string;
  expectedInterface: string;
  actualInterface: string | null;
  ok: boolean;
  raw: string | null;
  error?: string | null;
}

export interface WireGuardTunnelStatus {
  ok: boolean;
  active: boolean;
  mode: WireGuardConnectionRuntimeStatus['method'];
  interfaceName: string | null;
  realInterfaceName: string | null;
  configPath: string;
  addresses: string[];
  allowedIps: string[];
  missingRoutes: string[];
  routeProbes: WireGuardRouteProbeStatus[];
  routeLogPath: string | null;
  routeLogTail: string | null;
  peers: WireGuardPeerRuntimeStatus[];
  routes: string[];
  ifconfig: string | null;
  rawDump: string | null;
  runtime: WireGuardConnectionRuntimeStatus;
  serviceState?: string | null;
  error?: string | null;
  // True only when this result actually observed whether the tunnel is up.
  // A probe that timed out reports active:false like a stopped tunnel does,
  // and callers must be able to tell the two apart before tearing anything
  // down. Undefined on platforms/paths that always observe directly.
  activeObserved?: boolean;
}

export interface WireGuardWindowsNrptNamespaceStatus {
  namespace: string;
  expectedNameServers: string[];
  installedNameServers: string[];
  ownedRuleCount: number;
  legacyAmbiguousRuleCount: number;
  foreignOwners: string[];
  ready: boolean;
}

export interface WireGuardWindowsNrptExpectedRule {
  namespace: string;
  nameServers: string[];
}

export interface WireGuardWindowsNrptRuleSnapshot {
  namespace?: string | null;
  nameServers?: string[] | string | null;
  comment?: string | null;
  displayName?: string | null;
}

export interface WireGuardWindowsNrptSnapshot {
  queryPolicy?: string | null;
  enableDaForAllNetworks?: string | null;
  rules?: WireGuardWindowsNrptRuleSnapshot[] | WireGuardWindowsNrptRuleSnapshot | null;
  pendingOwners?: string[] | string | null;
  legacyMigrationAuthorized?: boolean | null;
}

export interface WireGuardWindowsNrptStatus {
  supported: boolean;
  configured: boolean;
  ready: boolean;
  source: 'live-powershell';
  state: 'ready' | 'not-configured' | 'global-disabled' | 'global-restore-pending' | 'rules-missing' | 'name-server-mismatch' | 'owned-rules-stale' | 'legacy-ambiguous' | 'probe-failed';
  tunnelName: string;
  comment: string;
  queryPolicy: string | null;
  enableDaForAllNetworks: string | null;
  globalReady: boolean;
  globalRestorePending: boolean;
  pendingGlobalOwners: string[];
  totalOwnedRuleCount: number;
  unexpectedOwnedNamespaces: string[];
  legacyMigrationAuthorized: boolean;
  legacyAmbiguousRuleCount: number;
  legacyAmbiguousNamespaces: string[];
  namespaces: WireGuardWindowsNrptNamespaceStatus[];
  missingNamespaces: string[];
  mismatchedNamespaces: string[];
  error: string | null;
}

export interface HdoLocalRoute {
  cidr: string;
  source: 'darwin-netstat' | 'linux-ip-route' | 'windows-route-print';
  interfaceName?: string | null;
  gateway?: string | null;
  raw?: string | null;
}

export interface DarwinDefaultRoute {
  gateway: string;
  interfaceName: string;
  flags: string;
  raw: string;
}

export interface HdoRouteConflict {
  localCidr: string;
  hdoCidr: string;
}

export interface HdoRouteProbe {
  platform: NodeJS.Platform;
  generatedAt: string;
  hdoCidrs: string[];
  localCidrs: string[];
  routes: HdoLocalRoute[];
  conflicts: HdoRouteConflict[];
  warnings: string[];
  canUseDefaultMesh: boolean;
}

export interface HdoSharedPort {
  id?: string;
  label: string;
  port: number;
  protocol: 'tcp' | 'udp';
  visibility: 'private' | 'trusted-mesh' | 'public';
}

export interface HdoMeshAclRule {
  id?: string;
  sourceRole: HdoMeshRole | 'any';
  targetRole: HdoMeshRole | 'any';
  protocol: 'tcp' | 'udp' | 'any';
  ports: number[];
  action: 'allow' | 'deny';
}

export const HDO_MESH_DEFAULTS: HdoMeshAddressPlan = {
  homeCidr: '100.88.0.0/16',
  userCidr: '100.89.0.0/16',
  serviceCidr: '100.90.0.0/16',
  domesticIp: '100.88.0.1',
  defaultListenPort: 51888
};

export const HDO_MESH_ROUTE_CIDRS = [
  '100.88.0.0/16',
  '100.89.0.0/16',
  '100.90.0.0/16',
  '100.91.0.0/16'
];

const DARWIN_HDO_PRIORITY_ROUTE_PREFIX = 20;
const DARWIN_HDO_MIN_PRIORITY_ROUTE_PREFIX = 16;
const DARWIN_HDO_MAX_PRIORITY_ROUTES_PER_CIDR = 64;
const WINDOWS_NRPT_SHARED_STATE_RELATIVE_PATH = 'QPJoy\\NRPT\\global-state.json';
const WINDOWS_NRPT_MUTEX_NAME = 'Global\\QPJoy.MXLauncher.NRPT.v1';

export const HDO_COMMON_TRUSTED_PORTS: HdoSharedPort[] = [
  { label: 'SSH', port: 22, protocol: 'tcp', visibility: 'trusted-mesh' },
  { label: 'HTTP', port: 80, protocol: 'tcp', visibility: 'trusted-mesh' },
  { label: 'HTTPS', port: 443, protocol: 'tcp', visibility: 'trusted-mesh' },
  { label: 'Vite', port: 5173, protocol: 'tcp', visibility: 'trusted-mesh' },
  { label: 'Dev 3000', port: 3000, protocol: 'tcp', visibility: 'trusted-mesh' },
  { label: 'Dev 8000', port: 8000, protocol: 'tcp', visibility: 'trusted-mesh' },
  { label: 'Dev 8080', port: 8080, protocol: 'tcp', visibility: 'trusted-mesh' },
  { label: 'Postgres', port: 5432, protocol: 'tcp', visibility: 'private' },
  { label: 'MySQL', port: 3306, protocol: 'tcp', visibility: 'private' }
];

export function renderWireGuardInterface(config: WireGuardInterface): string {
  assertNonEmpty(config.privateKey, 'privateKey');
  if (config.addresses.length === 0) {
    throw new Error('at least one interface address is required');
  }

  const lines = [
    '[Interface]',
    `Address = ${config.addresses.join(', ')}`,
    `PrivateKey = ${config.privateKey}`
  ];
  if (config.listenPort) lines.push(`ListenPort = ${config.listenPort}`);
  if (config.dns?.length && !config.suppressInterfaceDns) lines.push(`DNS = ${config.dns.join(', ')}`);
  if (config.hdoDnsServers?.length) lines.push(`# HDO DNS Servers = ${config.hdoDnsServers.join(', ')}`);
  if (config.hdoDnsDomains?.length) lines.push(`# HDO DNS Domains = ${config.hdoDnsDomains.join(', ')}`);
  if (config.hdoRoutePriorityCidrs?.length) {
    lines.push(`# HDO Route Priority CIDRs = ${config.hdoRoutePriorityCidrs.join(', ')}`);
  }
  if (config.mtu) lines.push(`MTU = ${config.mtu}`);

  for (const peer of config.peers) {
    lines.push('', ...renderWireGuardPeer(peer).trimEnd().split('\n'));
  }

  return lines.join('\n') + '\n';
}

export function renderWireGuardPeer(peer: WireGuardPeer): string {
  assertNonEmpty(peer.publicKey, 'peer.publicKey');
  if (peer.allowedIps.length === 0) {
    throw new Error('peer.allowedIps is required');
  }

  const lines: string[] = [];
  if (peer.name) lines.push(`# ${peer.name}`);
  lines.push('[Peer]');
  lines.push(`PublicKey = ${peer.publicKey}`);
  if (peer.presharedKey) lines.push(`PresharedKey = ${peer.presharedKey}`);
  lines.push(`AllowedIPs = ${peer.allowedIps.join(', ')}`);
  if (peer.endpoint) lines.push(`Endpoint = ${peer.endpoint}`);
  if (peer.persistentKeepalive) lines.push(`PersistentKeepalive = ${peer.persistentKeepalive}`);
  return lines.join('\n') + '\n';
}

export function endpoint(host: string, port = HDO_MESH_DEFAULTS.defaultListenPort): string {
  const trimmed = host.trim();
  if (!trimmed) throw new Error('endpoint host is required');
  return `${trimmed}:${port}`;
}

export function renderHdoClientWireGuardConfig(input: {
  privateKey: string;
  address: string;
  listenPort?: number | null;
  domesticPublicKey: string;
  domesticEndpoint: string;
  allowedIps?: string[];
  directPeers?: WireGuardPeer[];
  dns?: string[];
  dnsDomains?: string[];
  splitDns?: boolean;
  mtu?: number | null;
  persistentKeepalive?: number | null;
}): string {
  const splitDns = input.splitDns === true && Boolean(input.dns?.length && input.dnsDomains?.length);
  return renderWireGuardInterface({
    privateKey: input.privateKey,
    addresses: [input.address],
    listenPort: input.listenPort,
    dns: splitDns ? undefined : input.dns,
    hdoDnsServers: splitDns ? input.dns : undefined,
    hdoDnsDomains: input.dnsDomains,
    suppressInterfaceDns: splitDns,
    mtu: input.mtu,
    peers: [
      {
        name: 'HDO Domestic',
        publicKey: input.domesticPublicKey,
        allowedIps: input.allowedIps?.length ? input.allowedIps : HDO_MESH_ROUTE_CIDRS,
        endpoint: input.domesticEndpoint,
        persistentKeepalive: input.persistentKeepalive ?? 25
      },
      ...(input.directPeers ?? [])
    ]
  });
}

export function excludeLocalRoutesFromAllowedIps(
  allowedIps: string[],
  localCidrs: string[]
): string[] {
  const exclusions = localCidrs
    .map((cidr) => normalizeCidr(cidr))
    .filter((cidr): cidr is string => Boolean(cidr) && cidr !== '0.0.0.0/0')
    .map((cidr) => cidrRange(cidr))
    .filter((range): range is { start: number; end: number } => Boolean(range));
  if (exclusions.length === 0) return [...allowedIps];

  const out: string[] = [];
  for (const allowedIp of allowedIps) {
    const normalized = normalizeCidr(allowedIp);
    const baseRange = normalized ? cidrRange(normalized) : null;
    if (!normalized || !baseRange) {
      out.push(allowedIp);
      continue;
    }

    let ranges = [baseRange];
    for (const exclusion of exclusions) {
      ranges = ranges.flatMap((range) => subtractRange(range, exclusion));
      if (ranges.length === 0) break;
    }
    for (const range of ranges) {
      out.push(...rangeToCidrs(range.start, range.end));
    }
  }
  return uniqueStrings(out);
}

export function localCidrsForAllowedIpExclusion(
  routeProbe: Pick<HdoRouteProbe, 'localCidrs' | 'routes'>,
  hdoCidrs = HDO_MESH_ROUTE_CIDRS
): string[] {
  const hdoRanges = hdoCidrs
    .map((cidr) => normalizeCidr(cidr))
    .filter((cidr): cidr is string => Boolean(cidr))
    .map((cidr) => cidrRange(cidr))
    .filter((range): range is { start: number; end: number } => Boolean(range));
  const existingHdoRouteCidrs = new Set(
    routeProbe.routes
      .filter((route) => routeLooksLikeExistingHdoRoute(route, hdoRanges))
      .map((route) => normalizeCidr(route.cidr))
      .filter((cidr): cidr is string => Boolean(cidr))
  );
  return routeProbe.localCidrs.filter((cidr) => {
    const normalized = normalizeCidr(cidr);
    return Boolean(normalized && !existingHdoRouteCidrs.has(normalized));
  });
}

export function detectWireGuardCli(command = 'wg'): WireGuardCliStatus {
  try {
    const version = execFileSync(command, ['--version'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true
    }).trim();
    return { available: true, command, version };
  } catch (err) {
    return { available: false, command, error: errorMessage(err) };
  }
}

export function resolveWireGuardRuntime(options: WireGuardRuntimeOptions): WireGuardRuntimeStatus {
  const commandName = options.commandName ?? defaultWireGuardCommandName();
  const target = platformArchKey();
  const installedPath = join(options.installDir, commandName);
  if (existsSync(installedPath)) {
    return {
      target,
      available: true,
      source: 'installed',
      command: installedPath,
      bundledPath: null,
      installedPath,
      systemPath: null
    };
  }

  const bundledPath = findBundledWireGuardCli(options.bundledDir ?? null);
  if (bundledPath) {
    try {
      const command = installBundledWireGuardCli(bundledPath, options.installDir, commandName);
      return {
        target,
        available: true,
        source: 'bundled',
        command,
        bundledPath,
        installedPath: command,
        systemPath: null
      };
    } catch (err) {
      return {
        target,
        available: false,
        source: 'missing',
        command: null,
        bundledPath,
        installedPath,
        systemPath: null,
        error: errorMessage(err)
      };
    }
  }

  if (options.allowSystemFallback) {
    const systemPath = findSystemWireGuardTool('wg', commandName);
    if (systemPath) {
      return {
        target,
        available: true,
        source: 'system',
        command: systemPath,
        bundledPath: null,
        installedPath: null,
        systemPath
      };
    }
  }

  return {
    target,
    available: false,
    source: 'missing',
    command: null,
    bundledPath: null,
    installedPath: null,
    systemPath: null,
    error: `missing bundled WireGuard CLI for ${target}`
  };
}

export function resolveWireGuardConnectionRuntime(
  options: WireGuardConnectionRuntimeOptions
): WireGuardConnectionRuntimeStatus {
  const platform = options.platform ?? process.platform;
  const target = platformArchKey();
  const warnings: string[] = [];
  const wg = resolveWireGuardRuntime(options);

  if (platform === 'win32') {
    const windowsWireGuard = resolveWireGuardTool({
      name: 'wireguard',
      commandName: 'wireguard.exe',
      installDir: options.installDir,
      bundledDir: options.bundledDir,
      allowSystemFallback: options.allowSystemFallback
    });
    if (!windowsWireGuard.available) {
      warnings.push('缺少 wireguard.exe，无法安装 Windows WireGuard tunnel service。');
    }
    return {
      target,
      platform,
      available: windowsWireGuard.available,
      method: windowsWireGuard.available ? 'windows-service' : 'missing',
      wg,
      wgQuick: null,
      wireGuardGo: null,
      bash: null,
      windowsWireGuard,
      warnings,
      error: windowsWireGuard.available ? null : windowsWireGuard.error
    };
  }

  const wgQuick = resolveWireGuardTool({
    name: 'wg-quick',
    commandName: 'wg-quick',
    installDir: options.installDir,
    bundledDir: options.bundledDir,
    allowSystemFallback: options.allowSystemFallback
  });
  const wireGuardGo = resolveWireGuardTool({
    name: 'wireguard-go',
    commandName: 'wireguard-go',
    installDir: options.installDir,
    bundledDir: options.bundledDir,
    allowSystemFallback: options.allowSystemFallback
  });
  const bash = platform === 'darwin'
    ? resolveWireGuardTool({
        name: 'bash',
        commandName: 'bash',
        installDir: options.installDir,
        bundledDir: options.bundledDir,
        allowSystemFallback: options.allowSystemFallback
      })
    : null;

  if (!wg.available) warnings.push('缺少 wg，无法给 WireGuard 接口下发 peer 配置。');
  if (!wgQuick.available) warnings.push('缺少 wg-quick，无法从 conf 自动创建和启停 WireGuard 接口。');
  if (platform === 'darwin' && !wireGuardGo.available) {
    warnings.push('macOS 需要 wireguard-go 用户态引擎来创建 utun 隧道。');
  }
  if (platform === 'darwin' && !bash?.available) {
    warnings.push('macOS wg-quick 需要 Bash 4+；客户机不能依赖系统自带 Bash 3.2。');
  }

  const wgQuickAvailable = Boolean(
    wg.available &&
    wgQuick.available &&
    (platform !== 'darwin' || (wireGuardGo.available && bash?.available))
  );
  const darwinUserspaceAvailable = Boolean(platform === 'darwin' && wg.available && wireGuardGo.available);
  const available = wgQuickAvailable || darwinUserspaceAvailable;
  return {
    target,
    platform,
    available,
    method: wgQuickAvailable ? 'wg-quick' : (darwinUserspaceAvailable ? 'darwin-userspace' : 'missing'),
    wg,
    wgQuick,
    wireGuardGo,
    bash,
    windowsWireGuard: null,
    warnings,
    error: available ? null : warnings[0] ?? 'WireGuard runtime unavailable'
  };
}

export function buildWireGuardTunnelCommand(input: {
  runtime: WireGuardConnectionRuntimeStatus;
  configPath: string;
  action: WireGuardTunnelAction;
  windowsNrptRules?: WireGuardWindowsNrptExpectedRule[] | null;
}): WireGuardTunnelCommand {
  const { runtime, configPath, action } = input;
  if (!configPath.trim()) throw new Error('configPath is required');

  if (runtime.platform === 'win32') {
    const command = runtime.windowsWireGuard?.command;
    if (!command) throw new Error(runtime.error ?? 'wireguard.exe unavailable');
    let profile: ReturnType<typeof parseWireGuardProfile> | null = null;
    try {
      profile = parseWireGuardProfile(configPath);
    } catch (err) {
      if (action !== 'down') throw err;
    }
    const tunnelName = profile?.interfaceName ?? wireGuardInterfaceName(configPath);
    const routeLogPath = wireGuardRouteLogPath(configPath, tunnelName);
    const wireGuardArgs = action === 'down'
      ? ['/uninstalltunnelservice', tunnelName]
      : ['/installtunnelservice', configPath];
    const scriptPaths = windowsPowerShellScriptPaths(configPath, tunnelName, action);
    const profileNrptRules = profile ? windowsNrptRulesFromProfile(profile) : [];
    const suppliedNrptRules = normalizeWindowsNrptExpectedRules(input.windowsNrptRules ?? []);
    const nrptRules = action === 'down' && profileNrptRules.length === 0
      ? suppliedNrptRules
      : profileNrptRules;
    const endpointBypassOwnerKey = windowsEndpointBypassOwnerKey(configPath, tunnelName);
    const scripts = windowsElevatedStartProcessScripts(
      command,
      wireGuardArgs,
      action,
      tunnelName,
      nrptRules,
      profileNrptRules.length > 0,
      profile ? windowsRouteRulesFromProfile(profile) : [],
      profile?.addresses ?? [],
      profile?.endpointHosts ?? [],
      endpointBypassOwnerKey,
      scriptPaths.elevated,
      routeLogPath
    );
    writePowerShellScriptFile(scriptPaths.elevated, scripts.elevated);
    writePowerShellScriptFile(scriptPaths.wrapper, scripts.wrapper);
    const powershell = windowsPowerShellCommand();
    return {
      action,
      platform: runtime.platform,
      configPath,
      command: powershell,
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPaths.wrapper],
      displayCommand: `${powershell} -NoProfile -ExecutionPolicy Bypass -File <wireguard-uac-wrapper.ps1>`,
      needsAdmin: true,
      runtime
    };
  }

  if (runtime.platform === 'darwin' && runtime.method === 'darwin-userspace') {
    return buildDarwinUserspaceTunnelCommand(runtime, configPath, action);
  }

  const wgQuick = runtime.wgQuick?.command;
  if (!wgQuick) throw new Error(runtime.error ?? 'wg-quick unavailable');
  const env = wireGuardQuickEnv(runtime);
  const shellCommand = runtime.platform === 'darwin'
    ? darwinWgQuickShellCommand(configPath, action, env, wgQuick)
    : action === 'restart'
      ? linuxWgQuickRestartShellCommand(configPath, env, wgQuick)
    : [
        ...Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`),
        shellQuote(wgQuick),
        action,
        shellQuote(configPath)
      ].join(' ');

  if (runtime.platform === 'darwin') {
    const script = `do shell script ${appleScriptString(shellCommand)} with administrator privileges`;
    return {
      action,
      platform: runtime.platform,
      configPath,
      command: 'osascript',
      args: ['-e', script],
      displayCommand: `osascript -e ${shellQuote(script)}`,
      needsAdmin: true,
      runtime,
      env
    };
  }

  const needsAdmin = typeof process.getuid === 'function' && process.getuid() !== 0;
  if (action === 'restart') {
    return {
      action,
      platform: runtime.platform,
      configPath,
      command: 'sh',
      args: ['-lc', shellCommand],
      displayCommand: needsAdmin ? `sudo sh -lc ${shellQuote(shellCommand)}` : shellCommand,
      needsAdmin,
      runtime
    };
  }
  const displayCommand = needsAdmin
    ? ['sudo', 'env', ...Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`), shellQuote(wgQuick), action, shellQuote(configPath)].join(' ')
    : shellCommand;
  return {
    action,
    platform: runtime.platform,
    configPath,
    command: wgQuick,
    args: [action, configPath],
    displayCommand,
    needsAdmin,
    runtime,
    env
  };
}

function linuxWgQuickRestartShellCommand(
  configPath: string,
  env: Record<string, string>,
  wgQuick: string
): string {
  const commandPrefix = [
    ...Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`),
    shellQuote(wgQuick)
  ].join(' ');
  return [
    'set -e',
    `${commandPrefix} down ${shellQuote(configPath)} >/dev/null 2>&1 || true`,
    `${commandPrefix} up ${shellQuote(configPath)}`
  ].join('\n');
}

export async function setWireGuardTunnelState(input: {
  runtime: WireGuardConnectionRuntimeStatus;
  configPath: string;
  action: WireGuardTunnelAction;
  windowsNrptRules?: WireGuardWindowsNrptExpectedRule[] | null;
}): Promise<WireGuardTunnelResult> {
  let command: WireGuardTunnelCommand;
  try {
    command = buildWireGuardTunnelCommand(input);
  } catch (err) {
    return {
      ok: false,
      action: input.action,
      mode: input.runtime.method,
      configPath: input.configPath,
      command: '',
      routeLogPath: wireGuardRouteLogPathFromConfig(input.configPath),
      routeLogTail: readTextTail(wireGuardRouteLogPathFromConfig(input.configPath)),
      message: errorMessage(err),
      runtime: input.runtime
    };
  }
  if (!command.runtime.available) {
    return {
      ok: false,
      action: input.action,
      mode: command.runtime.method,
      configPath: input.configPath,
      command: command.displayCommand,
      routeLogPath: wireGuardRouteLogPathFromConfig(input.configPath),
      routeLogTail: readTextTail(wireGuardRouteLogPathFromConfig(input.configPath)),
      message: command.runtime.error ?? 'WireGuard runtime unavailable',
      runtime: command.runtime
    };
  }
  if (command.needsAdmin && command.platform !== 'darwin' && command.platform !== 'win32') {
    return {
      ok: false,
      action: input.action,
      mode: 'needs-root',
      configPath: input.configPath,
      command: command.displayCommand,
      routeLogPath: wireGuardRouteLogPathFromConfig(input.configPath),
      routeLogTail: readTextTail(wireGuardRouteLogPathFromConfig(input.configPath)),
      message: '启停 WireGuard 需要 root 权限，请复制命令执行。',
      runtime: command.runtime
    };
  }

  let result: { stdout: string; stderr: string };
  try {
    result = await execFileAsync(command.command, command.args, {
      env: command.env ? { ...process.env, ...command.env } : process.env
    });
  } catch (err) {
    const authorizationCanceled = isWireGuardAuthorizationCancelled(command, err);
    return {
      ok: false,
      authorizationCanceled,
      action: input.action,
      mode: command.runtime.method,
      configPath: input.configPath,
      command: command.displayCommand,
      routeLogPath: wireGuardRouteLogPathFromConfig(input.configPath),
      routeLogTail: readTextTail(wireGuardRouteLogPathFromConfig(input.configPath)),
      message: wireGuardCommandErrorMessage(command, err),
      runtime: command.runtime
    };
  }
  return {
    ok: true,
    action: input.action,
    mode: command.runtime.method,
    configPath: input.configPath,
    command: command.displayCommand,
    routeLogPath: wireGuardRouteLogPathFromConfig(input.configPath),
    routeLogTail: readTextTail(wireGuardRouteLogPathFromConfig(input.configPath)),
    stdout: result.stdout,
    stderr: result.stderr,
    message: input.action === 'down'
      ? '已停止 WireGuard peer。'
      : (input.action === 'restart' ? '已更新并启动 WireGuard peer。' : '已启动 WireGuard peer。'),
    runtime: command.runtime
  };
}

export async function repairWireGuardTunnelRoutes(input: {
  runtime: WireGuardConnectionRuntimeStatus;
  configPath: string;
  darwinExtraRepairShell?: string | null;
  beforeDarwinPrivilegedCommand?: () => void;
}): Promise<WireGuardRouteRepairResult> {
  const profile = parseWireGuardProfile(input.configPath);
  const realInterfaceName = resolveWireGuardRealInterface(input.runtime, profile.interfaceName, profile.addresses);
  const baseResult = {
    mode: input.runtime.method,
    configPath: input.configPath,
    interfaceName: profile.interfaceName,
    realInterfaceName,
    command: '',
    routeLogPath: wireGuardRouteLogPath(input.configPath, profile.interfaceName),
    routeLogTail: readTextTail(wireGuardRouteLogPath(input.configPath, profile.interfaceName)),
    privilegedExecution: 'not-started' as const,
    runtime: input.runtime
  };
  if (!input.runtime.available) {
    return {
      ...baseResult,
      ok: false,
      message: input.runtime.error ?? 'WireGuard runtime unavailable'
    };
  }
  if (input.runtime.platform === 'win32') {
    const nrptRules = windowsNrptRulesFromProfile(profile);
    const routeRules = windowsRouteRulesFromProfile(profile);
    if (nrptRules.length === 0 && routeRules.length === 0 && !isMxH2iTunnel(profile.interfaceName)) {
      return {
        ...baseResult,
        ok: false,
        message: '当前 WireGuard 配置没有可修复的 HDO route 或 split DNS 规则。'
      };
    }
    const serviceState = readWindowsTunnelServiceState(profile.interfaceName).serviceState;
    if (serviceState !== 'RUNNING') {
      return {
        ...baseResult,
        ok: false,
        message: 'WireGuard 未运行，请先连接 HDO 网络。'
      };
    }
    const command = buildWindowsRepairCommand(
      input.runtime,
      input.configPath,
      nrptRules,
      routeRules,
      profile.addresses,
      profile.endpointHosts
    );
    try {
      const result = await execFileAsync(command.command, command.args, {
        env: command.env ? { ...process.env, ...command.env } : process.env
      });
      return {
        ...baseResult,
        ok: true,
        privilegedExecution: 'started',
        command: command.displayCommand,
        routeLogTail: readTextTail(baseResult.routeLogPath),
        stdout: result.stdout,
        stderr: result.stderr,
        message: routeRules.length > 0
          ? '已修复 HDO Windows 路由和 split DNS 优先级。'
          : '已修复 HDO split DNS 优先级。'
      };
    } catch (err) {
      const authorizationCanceled = isWireGuardAuthorizationCancelled(command, err);
      return {
        ...baseResult,
        ok: false,
        authorizationCanceled,
        privilegedExecution: authorizationCanceled ? 'authorization-canceled' : 'started',
        command: command.displayCommand,
        routeLogTail: readTextTail(baseResult.routeLogPath),
        message: wireGuardCommandErrorMessage(command, err)
      };
    }
  }
  if (input.runtime.platform !== 'darwin' || input.runtime.method !== 'darwin-userspace') {
    return {
      ...baseResult,
      ok: false,
      message: '当前平台暂不需要 HDO 路由修复。'
    };
  }
  if (!realInterfaceName) {
    return {
      ...baseResult,
      ok: false,
      message: '未找到当前 HDO WireGuard utun，请先启动 WireGuard。'
    };
  }

  const routeInstallCidrs = darwinRouteInstallCidrs(profile.allowedIps, profile.routePriorityCidrs);
  const routeCleanupCidrs = uniqueStrings([
    ...routeInstallCidrs,
    ...darwinStalePriorityRouteCidrs(profile.allowedIps)
  ]);
  const routeDownCommands = routeCleanupCidrs
    .filter((cidr) => cidr.includes('/'))
    .map((cidr) => darwinRouteDeleteCommand(cidr));
  const routeUpCommands = routeInstallCidrs
    .filter((cidr) => cidr.includes('/'))
    .map((cidr) => [
      darwinRouteInstallCommand(cidr, shellQuote(realInterfaceName)),
      darwinRouteEnsureCommand(cidr, shellQuote(realInterfaceName)),
      darwinRouteProbeLogCommand(cidr, shellQuote(realInterfaceName), '"$ROUTE_LOG"')
    ].join('\n'));
  const shellCommand = [
    'set -e',
    ...darwinRouteLogSetupLines(input.configPath, profile.interfaceName, 'repair-routes'),
    `echo ${shellQuote('realInterface=')}${shellQuote(realInterfaceName)} >> "$ROUTE_LOG" 2>&1`,
    `ifconfig ${shellQuote(realInterfaceName)} >/dev/null`,
    ...darwinEndpointBypassCommands(profile.endpointHosts, '"$ROUTE_LOG"'),
    ...routeDownCommands,
    ...routeUpCommands,
    ...(input.darwinExtraRepairShell ? [input.darwinExtraRepairShell] : [])
  ].join('\n');
  const script = `do shell script ${appleScriptString(shellCommand)} with administrator privileges`;
  const repairCommand: WireGuardTunnelCommand = {
    action: 'up',
    platform: input.runtime.platform,
    configPath: input.configPath,
    command: 'osascript',
    args: ['-e', script],
    displayCommand: `osascript -e ${shellQuote(script)}`,
    needsAdmin: true,
    runtime: input.runtime
  };
  input.beforeDarwinPrivilegedCommand?.();
  try {
    const result = await execFileAsync('osascript', ['-e', script]);
    return {
      ...baseResult,
      ok: true,
      privilegedExecution: 'started',
      command: repairCommand.displayCommand,
      routeLogTail: readTextTail(baseResult.routeLogPath),
      stdout: result.stdout,
      stderr: result.stderr,
      message: `已把 HDO 路由重新绑定到 ${realInterfaceName}。`
    };
  } catch (err) {
    const authorizationCanceled = isWireGuardAuthorizationCancelled(repairCommand, err);
    return {
      ...baseResult,
      ok: false,
      authorizationCanceled,
      privilegedExecution: authorizationCanceled ? 'authorization-canceled' : 'started',
      command: repairCommand.displayCommand,
      routeLogTail: readTextTail(baseResult.routeLogPath),
      message: wireGuardCommandErrorMessage(repairCommand, err)
    };
  }
}

export function getDarwinWireGuardLaunchDaemonStatus(input: {
  runtime: WireGuardConnectionRuntimeStatus;
  configPath: string;
  serviceIdentity?: WireGuardServiceIdentity;
}): WireGuardLaunchDaemonStatus {
  const base = wireGuardLaunchDaemonUnsupportedStatus(input.runtime, input.configPath);
  if (input.runtime.platform !== 'darwin' || input.runtime.method !== 'darwin-userspace') return base;
  try {
    const assets = darwinLaunchDaemonAssets(input.runtime, input.configPath, {
      writeSetConfig: false,
      serviceIdentity: input.serviceIdentity
    });
    const print = tryExecFile('launchctl', ['print', `system/${assets.label}`]);
    const stdout = print.stdout.trim();
    const stderr = print.stderr.trim();
    const running = /\bpid\s*=\s*\d+/i.test(stdout) || /\bstate\s*=\s*running\b/i.test(stdout);
    return {
      ok: true,
      supported: true,
      installed: existsSync(assets.plistPath),
      loaded: print.ok,
      running,
      mode: input.runtime.method,
      label: assets.label,
      plistPath: assets.plistPath,
      supportDir: assets.supportDir,
      daemonScriptPath: assets.daemonScriptPath,
      configPath: input.configPath,
      stdout,
      stderr,
      error: print.ok ? null : (stderr || print.error || null),
      runtime: input.runtime
    };
  } catch (err) {
    return {
      ...base,
      supported: true,
      error: errorMessage(err)
    };
  }
}

export async function installDarwinWireGuardLaunchDaemon(input: {
  runtime: WireGuardConnectionRuntimeStatus;
  configPath: string;
  serviceIdentity?: WireGuardServiceIdentity;
  beforeDarwinPrivilegedCommand?: () => void;
}): Promise<WireGuardLaunchDaemonResult> {
  const base = getDarwinWireGuardLaunchDaemonStatus(input);
  if (!base.supported) {
    return {
      ...base,
      ok: false,
      privilegedExecution: 'not-started',
      command: '',
      message: '当前平台不支持 WireGuard LaunchDaemon。'
    };
  }
  if (!input.runtime.available) {
    return {
      ...base,
      ok: false,
      privilegedExecution: 'not-started',
      command: '',
      message: input.runtime.error ?? 'WireGuard runtime unavailable'
    };
  }
  let assets: DarwinLaunchDaemonAssets;
  let script: string;
  let displayCommand: string;
  try {
    assets = darwinLaunchDaemonAssets(input.runtime, input.configPath, {
      writeSetConfig: true,
      serviceIdentity: input.serviceIdentity
    });
    const shellCommand = darwinLaunchDaemonInstallShell(assets, input.serviceIdentity?.darwinExtraInstallShell);
    script = `do shell script ${appleScriptString(shellCommand)} with administrator privileges`;
    displayCommand = `osascript -e ${shellQuote(script)}`;
  } catch (err) {
    const status = getDarwinWireGuardLaunchDaemonStatus(input);
    return {
      ...status,
      ok: false,
      privilegedExecution: 'not-started',
      command: 'osascript -e <install-wireguard-launchdaemon>',
      routeLogPath: wireGuardRouteLogPathFromConfig(input.configPath),
      routeLogTail: readTextTail(wireGuardRouteLogPathFromConfig(input.configPath)),
      message: wireGuardCommandErrorMessage({
        action: 'up',
        platform: input.runtime.platform,
        configPath: input.configPath,
        command: 'osascript',
        args: ['-e', '<install-wireguard-launchdaemon>'],
        displayCommand: 'osascript -e <install-wireguard-launchdaemon>',
        needsAdmin: true,
        runtime: input.runtime
      }, err)
    };
  }

  input.beforeDarwinPrivilegedCommand?.();
  try {
    const result = await execFileAsync('osascript', ['-e', script]);
    const { status, tunnelStatus } = await waitForDarwinLaunchDaemonReady(input);
    const tunnelActive = tunnelStatus?.active === true && (tunnelStatus.missingRoutes?.length ?? 0) === 0;
    return {
      ...status,
      ok: tunnelActive || status.running || status.loaded,
      privilegedExecution: 'started',
      command: displayCommand,
      routeLogPath: assets.routeLogPath,
      routeLogTail: readTextTail(assets.routeLogPath),
      stdout: result.stdout,
      stderr: result.stderr,
      message: tunnelActive || status.running
        ? `已安装并启动 ${assets.displayName} 系统守护。`
        : (status.loaded
            ? `已安装 ${assets.displayName} 系统守护，正在等待 tunnel 就绪。`
            : `已安装 ${assets.displayName} 系统守护，但 launchd 尚未报告运行状态。`)
    };
  } catch (err) {
    const status = getDarwinWireGuardLaunchDaemonStatus(input);
    const command: WireGuardTunnelCommand = {
      action: 'up',
      platform: input.runtime.platform,
      configPath: input.configPath,
      command: 'osascript',
      args: ['-e', script],
      displayCommand,
      needsAdmin: true,
      runtime: input.runtime
    };
    const authorizationCanceled = isWireGuardAuthorizationCancelled(command, err);
    return {
      ...status,
      ok: false,
      authorizationCanceled,
      privilegedExecution: authorizationCanceled ? 'authorization-canceled' : 'started',
      command: displayCommand,
      routeLogPath: assets.routeLogPath,
      routeLogTail: readTextTail(assets.routeLogPath),
      message: wireGuardCommandErrorMessage(command, err)
    };
  }
}

async function waitForDarwinLaunchDaemonReady(input: {
  runtime: WireGuardConnectionRuntimeStatus;
  configPath: string;
  serviceIdentity?: WireGuardServiceIdentity;
}): Promise<{
  status: WireGuardLaunchDaemonStatus;
  tunnelStatus: WireGuardTunnelStatus | null;
}> {
  let status = getDarwinWireGuardLaunchDaemonStatus(input);
  let tunnelStatus: WireGuardTunnelStatus | null = null;

  for (let i = 0; i < 40; i += 1) {
    status = getDarwinWireGuardLaunchDaemonStatus(input);
    try {
      tunnelStatus = getWireGuardTunnelStatus(input);
    } catch {
      tunnelStatus = null;
    }
    if (tunnelStatus?.active === true && (tunnelStatus.missingRoutes?.length ?? 0) === 0) {
      return { status, tunnelStatus };
    }
    await sleep(i < 8 ? 250 : 500);
  }

  return { status, tunnelStatus };
}

export async function uninstallDarwinWireGuardLaunchDaemon(input: {
  runtime: WireGuardConnectionRuntimeStatus;
  configPath: string;
  serviceIdentity?: WireGuardServiceIdentity;
}): Promise<WireGuardLaunchDaemonResult> {
  const base = getDarwinWireGuardLaunchDaemonStatus(input);
  if (!base.supported) {
    return {
      ...base,
      ok: false,
      privilegedExecution: 'not-started',
      command: '',
      message: '当前平台不支持 WireGuard LaunchDaemon。'
    };
  }
  let assets: DarwinLaunchDaemonAssets | null = null;
  let command: WireGuardTunnelCommand | null = null;
  let privilegedExecution: WireGuardPrivilegedExecution = 'not-started';
  try {
    assets = darwinLaunchDaemonAssets(input.runtime, input.configPath, {
      writeSetConfig: false,
      serviceIdentity: input.serviceIdentity
    });
    const shellCommand = darwinLaunchDaemonUninstallShell(assets, input.serviceIdentity?.darwinExtraUninstallShell);
    const script = `do shell script ${appleScriptString(shellCommand)} with administrator privileges`;
    const displayCommand = `osascript -e ${shellQuote(script)}`;
    command = {
      action: 'down',
      platform: input.runtime.platform,
      configPath: input.configPath,
      command: 'osascript',
      args: ['-e', script],
      displayCommand,
      needsAdmin: true,
      runtime: input.runtime
    };
    privilegedExecution = 'started';
    const result = await execFileAsync('osascript', ['-e', script]);
    const status = getDarwinWireGuardLaunchDaemonStatus(input);
    return {
      ...status,
      ok: !status.loaded && !status.installed,
      authorizationCanceled: false,
      privilegedExecution,
      command: displayCommand,
      routeLogPath: assets.routeLogPath,
      routeLogTail: readTextTail(assets.routeLogPath),
      stdout: result.stdout,
      stderr: result.stderr,
      message: `已卸载 ${assets.displayName} 系统守护。`
    };
  } catch (err) {
    const status = getDarwinWireGuardLaunchDaemonStatus(input);
    const authorizationCanceled = privilegedExecution === 'started'
      && command !== null
      && isWireGuardAuthorizationCancelled(command, err);
    return {
      ...status,
      ok: false,
      authorizationCanceled,
      privilegedExecution: authorizationCanceled ? 'authorization-canceled' : privilegedExecution,
      command: command?.displayCommand || 'osascript -e <uninstall-wireguard-launchdaemon>',
      routeLogPath: assets?.routeLogPath || wireGuardRouteLogPathFromConfig(input.configPath),
      routeLogTail: readTextTail(assets?.routeLogPath || wireGuardRouteLogPathFromConfig(input.configPath)),
      message: wireGuardCommandErrorMessage(command || {
        action: 'down',
        platform: input.runtime.platform,
        configPath: input.configPath,
        command: 'osascript',
        args: ['-e', '<uninstall-wireguard-launchdaemon>'],
        displayCommand: 'osascript -e <uninstall-wireguard-launchdaemon>',
        needsAdmin: true,
        runtime: input.runtime
      }, err)
    };
  }
}

export function getWireGuardTunnelStatus(input: {
  runtime: WireGuardConnectionRuntimeStatus;
  configPath: string;
}): WireGuardTunnelStatus {
  const profile = parseWireGuardProfile(input.configPath);
  if (input.runtime.platform === 'win32') {
    return getWindowsWireGuardTunnelStatusByName({
      runtime: input.runtime,
      configPath: input.configPath,
      tunnelName: profile.interfaceName,
      addresses: profile.addresses,
      allowedIps: profile.allowedIps
    });
  }
  const realInterfaceName = resolveWireGuardRealInterface(
    input.runtime,
    profile.interfaceName,
    profile.addresses
  );
  const status: WireGuardTunnelStatus = {
    ok: true,
    active: false,
    mode: input.runtime.method,
    interfaceName: profile.interfaceName,
    realInterfaceName,
    configPath: input.configPath,
    addresses: profile.addresses,
    allowedIps: uniqueStrings(profile.allowedIps),
    missingRoutes: [],
    routeProbes: [],
    routeLogPath: wireGuardRouteLogPath(input.configPath, profile.interfaceName),
    routeLogTail: readTextTail(wireGuardRouteLogPath(input.configPath, profile.interfaceName)),
    peers: [],
    routes: [],
    ifconfig: null,
    rawDump: null,
    runtime: input.runtime
  };
  if (!input.runtime.available) {
    return {
      ...status,
      ok: false,
      error: input.runtime.error ?? input.runtime.warnings[0] ?? 'WireGuard runtime unavailable'
    };
  }
  if (!realInterfaceName) return status;
  const wg = input.runtime.wg.command;
  if (!wg) return { ...status, ok: false, error: 'wg unavailable' };

  const dump = shouldSkipWireGuardDump(input.runtime)
    ? {
        ok: false,
        stdout: '',
        stderr: '',
        error: 'wg show requires elevated access; using interface state only'
      }
    : tryExecFile(wg, ['show', realInterfaceName, 'dump']);
  if (dump.ok) {
    const rawDump = dump.stdout.trim();
    const peers = parseWireGuardDump(rawDump);
    const routes = detectInterfaceRoutes(realInterfaceName);
    const routeProbes = darwinRouteProbeResults(
      profile.allowedIps,
      realInterfaceName,
      profile.routePriorityCidrs,
      profile.addresses
    );
    return {
      ...status,
      active: true,
      peers,
      rawDump,
      routes,
      routeProbes,
      missingRoutes: routeProbes.length
        ? routeProbes.filter((probe) => !probe.ok).map((probe) => probe.cidr)
        : missingInterfaceRoutes(input.runtime, profile.allowedIps, routes, profile.routePriorityCidrs),
      routeLogTail: readTextTail(status.routeLogPath),
      ifconfig: readInterfaceState(realInterfaceName)
    };
  }

  const routes = detectInterfaceRoutes(realInterfaceName);
  const ifconfig = readInterfaceState(realInterfaceName);
  const routeProbes = darwinRouteProbeResults(
    profile.allowedIps,
    realInterfaceName,
    profile.routePriorityCidrs,
    profile.addresses
  );
  const hasConfiguredAddress = Boolean(
    ifconfig && profile.addresses.some((address) => ifconfig.includes(`inet ${address.split('/')[0]}`))
  );
  if (ifconfig && interfaceStateIsUp(ifconfig) && hasConfiguredAddress) {
    return {
      ...status,
      active: true,
      peers: [],
      rawDump: null,
      routes,
      routeProbes,
      missingRoutes: routeProbes.length
        ? routeProbes.filter((probe) => !probe.ok).map((probe) => probe.cidr)
        : missingInterfaceRoutes(input.runtime, profile.allowedIps, routes, profile.routePriorityCidrs),
      routeLogTail: readTextTail(status.routeLogPath),
      ifconfig
    };
  }
  return {
    ...status,
    ok: false,
    error: dump.stderr.trim() || dump.error || `wg show ${realInterfaceName} failed`,
    routes,
    routeProbes,
    missingRoutes: routeProbes.length
      ? routeProbes.filter((probe) => !probe.ok).map((probe) => probe.cidr)
      : missingInterfaceRoutes(input.runtime, profile.allowedIps, routes, profile.routePriorityCidrs),
    routeLogTail: readTextTail(status.routeLogPath),
    ifconfig
  };
}

export function getWindowsWireGuardTunnelStatusByName(input: {
  runtime: WireGuardConnectionRuntimeStatus;
  configPath: string;
  tunnelName?: string | null;
  addresses?: string[] | null;
  allowedIps?: string[] | null;
}): WireGuardTunnelStatus {
  const interfaceName = input.tunnelName?.trim() || wireGuardInterfaceName(input.configPath);
  const addresses = uniqueStrings(input.addresses ?? []);
  const allowedIps = uniqueStrings(input.allowedIps ?? []);
  const routeLogPath = wireGuardRouteLogPath(input.configPath, interfaceName);
  const base: WireGuardTunnelStatus = {
    ok: true,
    active: false,
    mode: input.runtime.method,
    interfaceName,
    realInterfaceName: interfaceName,
    configPath: input.configPath,
    addresses,
    allowedIps,
    missingRoutes: [],
    routeProbes: [],
    routeLogPath,
    routeLogTail: readTextTail(routeLogPath),
    peers: [],
    routes: [],
    ifconfig: null,
    rawDump: null,
    runtime: input.runtime
  };
  if (input.runtime.platform !== 'win32') {
    return {
      ...base,
      ok: false,
      activeObserved: false,
      error: `Windows tunnel status is unavailable on ${input.runtime.platform}`
    };
  }
  const wg = input.runtime.wg?.command;
  if (wg) {
    const dump = tryExecFile(wg, ['show', interfaceName, 'dump']);
    if (dump.ok) {
      const rawDump = dump.stdout.trim();
      return {
        ...base,
        active: true,
        activeObserved: true,
        serviceState: 'RUNNING',
        peers: parseWireGuardDump(rawDump),
        rawDump,
        routes: detectInterfaceRoutes(interfaceName),
        ifconfig: readInterfaceState(interfaceName)
      };
    }
  }
  const machineState = readWindowsTunnelMachineState(interfaceName);
  return {
    ...base,
    ok: machineState.ok,
    active: machineState.serviceState === 'RUNNING',
    // active:false is only a claim about the tunnel when the service query
    // actually answered. Otherwise it is just the field's default.
    activeObserved: machineState.serviceStateKnown,
    serviceState: machineState.serviceState,
    routes: machineState.routes,
    ifconfig: machineState.adapters.length > 0
      ? JSON.stringify(machineState.adapters)
      : null,
    error: machineState.error
  };
}

export async function getWindowsWireGuardNrptStatus(input: {
  runtime: WireGuardConnectionRuntimeStatus;
  configPath: string;
  probeTimeoutMs?: number;
  expectedRules?: WireGuardWindowsNrptExpectedRule[] | null;
}): Promise<WireGuardWindowsNrptStatus | null> {
  if (input.runtime.platform !== 'win32') return null;
  let profile: ReturnType<typeof parseWireGuardProfile> | null = null;
  try {
    profile = parseWireGuardProfile(input.configPath);
  } catch {
    // A profile may already be gone during upgrade/uninstall. The tunnel name
    // still gives us an exact ownership tag, so continue probing the live
    // machine-wide NRPT table with an empty desired state.
  }
  const profileRules = profile ? windowsNrptRulesFromProfile(profile) : [];
  const expectedRules = profileRules.length > 0
    ? profileRules
    : normalizeWindowsNrptExpectedRules(input.expectedRules ?? []);
  const tunnelName = profile?.interfaceName ?? wireGuardInterfaceName(input.configPath);
  const product = windowsTunnelProductLabels(tunnelName);
  const comment = `${product.commentPrefix} ${tunnelName}`;
  const legacyStateRelativePath = `${product.programDataDir}\\nrpt-global-${tunnelName}.json`;
  // The 3 s this used to default to did not cover the work on a slow machine:
  // PowerShell engine start alone measured ~1.2 s on a field box, before
  // Get-DnsClientNrptGlobal/Rule (CIM cmdlets, comparable in cost to
  // Get-NetAdapter, which took ~1.8 s there) had run at all. A probe that runs
  // out of budget reports state:'probe-failed', which blocks split-DNS
  // readiness and holds the connection at tunnel-only. The mutex wait stays
  // capped at 1.5 s -- that is contention control, not a work budget.
  const probeTimeoutMs = normalizeTimeoutMs(input.probeTimeoutMs, 8000);
  const mutexTimeoutMs = Math.max(25, Math.min(1500, probeTimeoutMs - 250));

  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    ...windowsNrptMutexPowerShellLines(),
    `$hdoNrptMutex = Enter-HdoNrptMutex ${mutexTimeoutMs}`,
    'try {',
    '$global = Get-DnsClientNrptGlobal -ErrorAction Stop',
    '$rules = @(Get-DnsClientNrptRule -ErrorAction Stop)',
    '$rows = @($rules | ForEach-Object { [pscustomobject]@{ namespace = [string]$_.Namespace; nameServers = @($_.NameServers | ForEach-Object { [string]$_ }); comment = [string]$_.Comment; displayName = [string]$_.DisplayName } })',
    `$statePath = Join-Path $env:ProgramData ${powerShellString(WINDOWS_NRPT_SHARED_STATE_RELATIVE_PATH)}`,
    `$legacyStatePath = Join-Path $env:ProgramData ${powerShellString(legacyStateRelativePath)}`,
    '$legacyMigrationAuthorized = Test-Path $legacyStatePath -ErrorAction Stop',
    '$pendingOwners = @()',
    'if (Test-Path $statePath -ErrorAction Stop) {',
    '  $state = Get-Content -Path $statePath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop',
    '  $pendingOwners = @($state.Owners | ForEach-Object { [string]$_ } | Where-Object { $_ })',
    '} elseif (Test-Path $legacyStatePath -ErrorAction Stop) {',
    '  Get-Content -Path $legacyStatePath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop | Out-Null',
    `  $pendingOwners = @(${powerShellString(comment)})`,
    '}',
    '[pscustomobject]@{',
    '  queryPolicy = if ($null -eq $global) { $null } else { [string]$global.QueryPolicy }',
    '  enableDaForAllNetworks = if ($null -eq $global) { $null } else { [string]$global.EnableDAForAllNetworks }',
    '  pendingOwners = $pendingOwners',
    '  legacyMigrationAuthorized = [bool]$legacyMigrationAuthorized',
    '  rules = $rows',
    '} | ConvertTo-Json -Depth 8 -Compress',
    '} finally {',
    '  Exit-HdoNrptMutex $hdoNrptMutex',
    '}'
  ].join('\r\n');
  let result: { stdout: string; stderr: string };
  try {
    result = await execFileAsync(windowsPowerShellCommand(), [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script
    ], {
      timeoutMs: probeTimeoutMs
    });
  } catch (err) {
    return windowsNrptProbeFailure(
      tunnelName,
      comment,
      commandOutputMessage(err) || errorMessage(err) || 'Get-DnsClientNrptRule failed',
      expectedRules
    );
  }
  try {
    return parseWindowsNrptProbeResult(JSON.parse(result.stdout), tunnelName, expectedRules);
  } catch (err) {
    return windowsNrptProbeFailure(
      tunnelName,
      comment,
      `Invalid Windows NRPT probe output: ${errorMessage(err)}`,
      expectedRules
    );
  }
}

export function evaluateWindowsWireGuardNrptStatus(input: {
  tunnelName: string;
  expectedRules: WireGuardWindowsNrptExpectedRule[];
  snapshot: WireGuardWindowsNrptSnapshot;
}): WireGuardWindowsNrptStatus {
  const tunnelName = input.tunnelName;
  const comment = `${windowsTunnelProductLabels(tunnelName).commentPrefix} ${tunnelName}`;
  const legacyComment = windowsLegacyNrptComment(tunnelName);
  const ownsUntaggedRules = false;
  const ownedComments = new Set(
    [comment, legacyComment]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toLowerCase())
  );
  const rules = normalizeWindowsNrptRuleSnapshots(input.snapshot.rules);
  const expectedRules = input.expectedRules.map((rule) => ({
    namespace: normalizeWindowsNrptNamespace(rule.namespace),
    nameServers: normalizeWindowsNrptNameServers(rule.nameServers)
  })).filter((rule) => Boolean(rule.namespace && rule.nameServers.length));
  const legacyMigrationAuthorized = input.snapshot.legacyMigrationAuthorized === true;
  const expectedNamespaceSet = new Set(expectedRules.map((rule) => rule.namespace));
  const isLegacyMigrationCandidate = (
    rule: Required<WireGuardWindowsNrptRuleSnapshot>
  ): boolean => {
    if (!legacyMigrationAuthorized || rule.comment || rule.displayName) {
      return false;
    }
    const expected = expectedRules.find((row) => row.namespace === rule.namespace);
    return Boolean(expected && stringSetsEqual(expected.nameServers, normalizeWindowsNrptNameServers(rule.nameServers)));
  };
  const isOwnedRule = (rule: Required<WireGuardWindowsNrptRuleSnapshot>): boolean => {
    const ruleComment = rule.comment ?? '';
    const displayName = rule.displayName ?? '';
    return ownedComments.has(ruleComment.toLowerCase())
      || ownedComments.has(displayName.toLowerCase())
      || (ownsUntaggedRules && !ruleComment && !displayName && expectedNamespaceSet.has(rule.namespace ?? ''))
      || isLegacyMigrationCandidate(rule);
  };
  const ownedRules = rules.filter(isOwnedRule);
  const unexpectedOwnedNamespaces = uniqueStrings(ownedRules
    .flatMap((rule) => rule.namespace ? [rule.namespace] : [])
    .filter((namespace) => !expectedNamespaceSet.has(namespace)))
    .sort();
  const pendingGlobalOwners = normalizeWindowsNrptTextList(input.snapshot.pendingOwners);
  const globalRestorePending = legacyMigrationAuthorized || pendingGlobalOwners
    .some((owner) => ownedComments.has(owner.toLowerCase()));

  const namespaces = expectedRules.map((expected): WireGuardWindowsNrptNamespaceStatus => {
    const matches = rules.filter((rule) => rule.namespace === expected.namespace);
    const owned = matches.filter(isOwnedRule);
    const legacyAmbiguous = matches.filter((rule) =>
      !rule.comment
      && !rule.displayName
      && !isLegacyMigrationCandidate(rule)
    );
    const installedNameServers = normalizeWindowsNrptNameServers(owned.flatMap((rule) => rule.nameServers));
    const foreign = matches.filter((rule) => !owned.includes(rule));
    const foreignOwners = uniqueStrings(foreign
      .map((rule) => rule.comment || rule.displayName || '<untagged>'))
      .sort();
    const foreignNameServerConflict = foreign.some(
      (rule) => !stringSetsEqual(expected.nameServers, normalizeWindowsNrptNameServers(rule.nameServers))
    );
    return {
      namespace: expected.namespace,
      expectedNameServers: expected.nameServers,
      installedNameServers,
      ownedRuleCount: owned.length,
      legacyAmbiguousRuleCount: legacyAmbiguous.length,
      foreignOwners,
      ready: owned.length > 0
        && stringSetsEqual(expected.nameServers, installedNameServers)
        && !foreignNameServerConflict
        && legacyAmbiguous.length === 0
    };
  });
  const queryPolicy = nullableText(input.snapshot.queryPolicy);
  const enableDaForAllNetworks = nullableText(input.snapshot.enableDaForAllNetworks);
  const configured = expectedRules.length > 0 || ownedRules.length > 0 || globalRestorePending;
  const globalReady = expectedRules.length === 0 || (
    queryPolicy?.toLowerCase() === 'queryboth'
    && /^(enablealways|enableda|true|enable|enabled)$/i.test(enableDaForAllNetworks ?? '')
  );
  const missingNamespaces = namespaces.filter((row) => row.ownedRuleCount === 0).map((row) => row.namespace);
  const mismatchedNamespaces = namespaces
    .filter((row) => row.ownedRuleCount > 0 && !row.ready)
    .map((row) => row.namespace);
  const legacyAmbiguousNamespaces = namespaces
    .filter((row) => row.legacyAmbiguousRuleCount > 0)
    .map((row) => row.namespace);
  const legacyAmbiguousRuleCount = namespaces
    .reduce((total, row) => total + row.legacyAmbiguousRuleCount, 0);
  const ready = globalReady
    && missingNamespaces.length === 0
    && mismatchedNamespaces.length === 0
    && unexpectedOwnedNamespaces.length === 0
    && legacyAmbiguousRuleCount === 0
    && !(expectedRules.length === 0 && globalRestorePending);
  const state: WireGuardWindowsNrptStatus['state'] = !configured
    ? 'not-configured'
    : !globalReady
    ? 'global-disabled'
    : expectedRules.length === 0 && globalRestorePending
      ? 'global-restore-pending'
      : legacyAmbiguousRuleCount > 0
        ? 'legacy-ambiguous'
        : missingNamespaces.length > 0
          ? 'rules-missing'
          : mismatchedNamespaces.length > 0
            ? 'name-server-mismatch'
            : unexpectedOwnedNamespaces.length > 0
              ? 'owned-rules-stale'
              : 'ready';
  return {
    supported: true,
    configured,
    ready,
    source: 'live-powershell',
    state,
    tunnelName,
    comment,
    queryPolicy,
    enableDaForAllNetworks,
    globalReady,
    globalRestorePending,
    pendingGlobalOwners,
    totalOwnedRuleCount: ownedRules.length,
    unexpectedOwnedNamespaces,
    legacyMigrationAuthorized,
    legacyAmbiguousRuleCount,
    legacyAmbiguousNamespaces,
    namespaces,
    missingNamespaces,
    mismatchedNamespaces,
    error: null
  };
}

function parseWindowsNrptProbeResult(
  value: unknown,
  tunnelName: string,
  expectedRules: WireGuardWindowsNrptExpectedRule[]
): WireGuardWindowsNrptStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('NRPT probe result is not an object');
  }
  const row = value as Record<string, unknown>;
  return evaluateWindowsWireGuardNrptStatus({
    tunnelName,
    expectedRules,
    snapshot: {
      queryPolicy: nullableText(row.queryPolicy),
      enableDaForAllNetworks: nullableText(row.enableDaForAllNetworks),
      pendingOwners: normalizeWindowsNrptTextList(row.pendingOwners),
      legacyMigrationAuthorized: row.legacyMigrationAuthorized === true,
      rules: normalizeWindowsNrptRuleSnapshots(row.rules)
    }
  });
}

function windowsNrptProbeFailure(
  tunnelName: string,
  comment: string,
  error: string,
  expectedRules: WireGuardWindowsNrptExpectedRule[] = []
): WireGuardWindowsNrptStatus {
  const namespaces = expectedRules.map((rule) => ({
    namespace: normalizeWindowsNrptNamespace(rule.namespace),
    expectedNameServers: normalizeWindowsNrptNameServers(rule.nameServers),
    installedNameServers: [],
    ownedRuleCount: 0,
    legacyAmbiguousRuleCount: 0,
    foreignOwners: [],
    ready: false
  }));
  return {
    supported: true,
    configured: expectedRules.length > 0,
    ready: false,
    source: 'live-powershell',
    state: 'probe-failed',
    tunnelName,
    comment,
    queryPolicy: null,
    enableDaForAllNetworks: null,
    globalReady: false,
    globalRestorePending: false,
    pendingGlobalOwners: [],
    totalOwnedRuleCount: 0,
    unexpectedOwnedNamespaces: [],
    legacyMigrationAuthorized: false,
    legacyAmbiguousRuleCount: 0,
    legacyAmbiguousNamespaces: [],
    namespaces,
    missingNamespaces: namespaces.map((row) => row.namespace),
    mismatchedNamespaces: [],
    error
  };
}

function normalizeWindowsNrptRuleSnapshots(value: unknown): Array<Required<WireGuardWindowsNrptRuleSnapshot>> {
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  return rows.flatMap((entry): Array<Required<WireGuardWindowsNrptRuleSnapshot>> => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    const namespace = normalizeWindowsNrptNamespace(row.namespace);
    if (!namespace) return [];
    return [{
      namespace,
      nameServers: normalizeWindowsNrptNameServers(row.nameServers),
      comment: nullableText(row.comment) ?? '',
      displayName: nullableText(row.displayName) ?? ''
    }];
  });
}

function normalizeWindowsNrptNamespace(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeWindowsNrptNameServers(value: unknown): string[] {
  const rows = Array.isArray(value) ? value.flat(Infinity) : value === null || value === undefined ? [] : [value];
  return uniqueStrings(rows
    .flatMap((entry) => String(entry).split(','))
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean))
    .sort();
}

function normalizeWindowsNrptTextList(value: unknown): string[] {
  const rows = Array.isArray(value) ? value.flat(Infinity) : value === null || value === undefined ? [] : [value];
  return uniqueStrings(rows.map((entry) => String(entry).trim()).filter(Boolean)).sort();
}

function stringSetsEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

export function findBundledWireGuardCli(bundledDir?: string | null): string | null {
  return findBundledWireGuardTool('wg', bundledDir);
}

export function installBundledWireGuardCli(sourcePath: string, installDir: string, commandName = defaultWireGuardCommandName()): string {
  return installBundledWireGuardTool(sourcePath, installDir, commandName);
}

export function findBundledWireGuardTool(name: WireGuardToolName, bundledDir?: string | null): string | null {
  const packageDir = optionalWireGuardEnginePackageDir();
  const roots = [bundledDir, packageDir].filter((row): row is string => Boolean(row));
  const key = platformArchKey();
  const aliases = key.endsWith('-x64') ? [key, key.replace('-x64', '-amd64')] : [key];
  const names = bundledToolNames(name);
  const candidates = roots.flatMap((root) =>
    aliases.flatMap((alias) => names.map((candidateName) => join(root, alias, candidateName)))
  );
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function installBundledWireGuardTool(sourcePath: string, installDir: string, commandName: string): string {
  mkdirSync(installDir, { recursive: true });
  const target = join(installDir, commandName);
  if (sourcePath.endsWith('.gz')) {
    writeFileSync(target, gunzipSync(readFileSync(sourcePath)));
  } else {
    copyFileSync(sourcePath, target);
  }
  chmodSync(target, 0o755);
  return target;
}

export function generateWireGuardKeyPairWithCli(command = 'wg'): WireGuardKeyPair {
  const status = detectWireGuardCli(command);
  if (!status.available) {
    throw new Error(status.error ? `wg CLI unavailable: ${status.error}` : 'wg CLI unavailable');
  }
  const privateKey = execFileSync(command, ['genkey'], {
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true
  }).trim();
  const publicKey = execFileSync(command, ['pubkey'], {
    encoding: 'utf8',
    input: privateKey + '\n',
    timeout: 3000,
    windowsHide: true
  }).trim();
  return { privateKey, publicKey };
}

export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function detectLocalRoutes(platform = process.platform): HdoLocalRoute[] {
  if (platform === 'darwin') {
    const raw = execFileSync('netstat', ['-rn', '-f', 'inet'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true
    });
    return parseDarwinNetstatRoutes(raw);
  }
  if (platform === 'linux') {
    const raw = execFileSync('ip', ['-4', 'route', 'show'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true
    });
    return parseLinuxIpRoutes(raw);
  }
  if (platform === 'win32') {
    const raw = execFileSync('route', ['print', '-4'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true
    });
    return parseWindowsRoutePrint(raw);
  }
  throw new Error(`unsupported platform for route detection: ${platform}`);
}

export function buildHdoRouteProbe(input: {
  platform?: NodeJS.Platform;
  hdoCidrs?: string[];
  localCidrs?: string[];
  routes?: HdoLocalRoute[];
  now?: string;
} = {}): HdoRouteProbe {
  const platform = input.platform ?? process.platform;
  const warnings: string[] = [];
  let routes = input.routes ?? [];
  if (!input.routes) {
    try {
      routes = detectLocalRoutes(platform);
    } catch (err) {
      warnings.push(`本地路由探测失败：${errorMessage(err)}`);
    }
  }
  const hdoCidrs = uniqueStrings(
    (input.hdoCidrs ?? HDO_MESH_ROUTE_CIDRS).map((cidr) => normalizeCidr(cidr)).filter(isString)
  );
  const hdoRanges = hdoCidrs
    .map((cidr) => cidrRange(cidr))
    .filter((range): range is { start: number; end: number } => Boolean(range));
  const routeCidrs = routes
    .filter((row) => !routeLooksLikeExistingHdoRoute(row, hdoRanges))
    .filter((row) => !routeLooksLikeProxyTunCaptureRoute(row))
    .map((row) => normalizeCidr(row.cidr))
    .filter(isString);
  const localCidrs = uniqueStrings([
    ...routeCidrs,
    ...(input.localCidrs ?? []).map((cidr) => normalizeCidr(cidr)).filter(isString)
  ]).filter((cidr) => cidr !== '0.0.0.0/0');
  const conflicts = findCidrConflicts(localCidrs, hdoCidrs);
  if (conflicts.length > 0) {
    warnings.push('本机已有路由与 HDO 默认网段重叠，建议在服务端为该 mesh 切换 overlay 网段后再下发配置。');
  }
  return {
    platform,
    generatedAt: input.now ?? new Date().toISOString(),
    hdoCidrs,
    localCidrs,
    routes,
    conflicts,
    warnings,
    canUseDefaultMesh: conflicts.length === 0
  };
}

export function findCidrConflicts(localCidrs: string[], hdoCidrs = HDO_MESH_ROUTE_CIDRS): HdoRouteConflict[] {
  const conflicts: HdoRouteConflict[] = [];
  for (const localCidr of localCidrs) {
    for (const hdoCidr of hdoCidrs) {
      if (cidrsOverlap(localCidr, hdoCidr)) conflicts.push({ localCidr, hdoCidr });
    }
  }
  return conflicts;
}

export function cidrsOverlap(a: string, b: string): boolean {
  const ar = cidrRange(a);
  const br = cidrRange(b);
  if (!ar || !br) return false;
  return ar.start <= br.end && br.start <= ar.end;
}

function cidrContains(parent: string, child: string): boolean {
  const parentRange = cidrRange(parent);
  const childRange = cidrRange(child);
  if (!parentRange || !childRange) return false;
  return parentRange.start <= childRange.start && parentRange.end >= childRange.end;
}

function priorityIpv4CidrsAtPrefix(cidr: string, targetPrefix: number): string[] {
  const parsed = parseIpv4Cidr(normalizeCidr(cidr) ?? cidr);
  if (!parsed) return [];
  if (parsed.prefix >= targetPrefix) {
    return [normalizeCidr(`${intToIpv4(parsed.network)}/${parsed.prefix}`) ?? cidr];
  }
  if (parsed.prefix < DARWIN_HDO_MIN_PRIORITY_ROUTE_PREFIX) return [];
  const count = 2 ** (targetPrefix - parsed.prefix);
  if (!Number.isFinite(count) || count <= 0 || count > DARWIN_HDO_MAX_PRIORITY_ROUTES_PER_CIDR) return [];
  const size = 2 ** (32 - targetPrefix);
  return Array.from({ length: count }, (_, index) =>
    `${intToIpv4((parsed.network + index * size) >>> 0)}/${targetPrefix}`
  );
}

export function normalizeCidr(value: string): string | null {
  const parsed = parseIpv4Cidr(value);
  if (!parsed) return null;
  return `${intToIpv4(parsed.network)}/${parsed.prefix}`;
}

export function parseDarwinNetstatRoutes(raw: string): HdoLocalRoute[] {
  const routes: HdoLocalRoute[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('Routing') || trimmed.startsWith('Internet') || trimmed.startsWith('Destination')) {
      continue;
    }
    const columns = trimmed.split(/\s+/);
    const cidr = routeDestinationToCidr(columns[0]);
    if (!cidr || cidr === '0.0.0.0/0') continue;
    routes.push({
      cidr,
      source: 'darwin-netstat',
      gateway: columns[1] ?? null,
      interfaceName: columns[3] ?? null,
      raw: trimmed
    });
  }
  return uniqueRoutes(routes);
}

export function parseDarwinDefaultRoutes(raw: string): DarwinDefaultRoute[] {
  const routes: DarwinDefaultRoute[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('Destination')) continue;
    const columns = trimmed.split(/\s+/);
    if (columns[0] !== 'default' || columns.length < 4) continue;
    routes.push({
      gateway: columns[1] ?? '',
      flags: columns[2] ?? '',
      interfaceName: columns[3] ?? '',
      raw: trimmed
    });
  }
  return routes;
}

export function selectDarwinPhysicalDefaultRoute(raw: string): DarwinDefaultRoute | null {
  return parseDarwinDefaultRoutes(raw).find((route) =>
    isIpv4(route.gateway)
      && !isProxyTunIpv4(route.gateway)
      && !/^(?:utun|lo)\d*$/i.test(route.interfaceName)
  ) ?? null;
}

export function parseLinuxIpRoutes(raw: string): HdoLocalRoute[] {
  const routes: HdoLocalRoute[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const columns = trimmed.split(/\s+/);
    const cidr = routeDestinationToCidr(columns[0]);
    if (!cidr || cidr === '0.0.0.0/0') continue;
    const devIndex = columns.indexOf('dev');
    const viaIndex = columns.indexOf('via');
    routes.push({
      cidr,
      source: 'linux-ip-route',
      interfaceName: devIndex >= 0 ? columns[devIndex + 1] ?? null : null,
      gateway: viaIndex >= 0 ? columns[viaIndex + 1] ?? null : null,
      raw: trimmed
    });
  }
  return uniqueRoutes(routes);
}

export function parseWindowsRoutePrint(raw: string): HdoLocalRoute[] {
  const routes: HdoLocalRoute[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const columns = trimmed.split(/\s+/);
    if (columns.length < 5 || !isIpv4(columns[0]) || !isIpv4(columns[1])) continue;
    const cidr = cidrFromAddressAndMask(columns[0], columns[1]);
    if (!cidr || cidr === '0.0.0.0/0') continue;
    routes.push({
      cidr,
      source: 'windows-route-print',
      gateway: columns[2] ?? null,
      interfaceName: columns[3] ?? null,
      raw: trimmed
    });
  }
  return uniqueRoutes(routes);
}

function buildDarwinUserspaceTunnelCommand(
  runtime: WireGuardConnectionRuntimeStatus,
  configPath: string,
  action: WireGuardTunnelAction
): WireGuardTunnelCommand {
  const wg = runtime.wg.command;
  const wireGuardGo = runtime.wireGuardGo?.command;
  if (!wg || !wireGuardGo) throw new Error(runtime.error ?? 'darwin userspace WireGuard runtime unavailable');

  const profile = prepareDarwinUserspaceProfile(configPath);
  const nameFile = `/var/run/wireguard/${profile.interfaceName}.name`;
  const pidFile = `/var/run/wireguard/${profile.interfaceName}.pid`;
  const logFile = `/var/run/wireguard/${profile.interfaceName}.log`;
  const routeInstallCidrs = darwinRouteInstallCidrs(profile.allowedIps, profile.routePriorityCidrs);
  const routeCleanupCidrs = uniqueStrings([
    ...profile.allowedIps.map((cidr) => normalizeCidr(cidr) ?? cidr),
    ...routeInstallCidrs,
    ...darwinStalePriorityRouteCidrs(profile.allowedIps)
  ]);
  const routeUpCommands = routeInstallCidrs
    .filter((cidr) => cidr.includes('/'))
    .map((cidr) => [
      darwinRouteDeleteCommand(cidr),
      darwinRouteInstallCommand(cidr, '"$REAL_INTERFACE"'),
      darwinRouteEnsureCommand(cidr, '"$REAL_INTERFACE"'),
      darwinRouteProbeLogCommand(cidr, '"$REAL_INTERFACE"', '"$ROUTE_LOG"')
    ].join('\n'));
  const routeDownCommands = routeCleanupCidrs
    .filter((cidr) => cidr.includes('/'))
    .map((cidr) => darwinRouteDeleteCommand(cidr));
  const selfRouteIps = uniqueStrings(profile.addresses
    .map((address) => address.split('/')[0] ?? address)
    .filter(isIpv4));
  const selfRouteUpCommands = selfRouteIps.map((ip) => [
    darwinSelfRouteInstallCommand(ip),
    darwinSelfRouteProbeLogCommand(ip, '"$ROUTE_LOG"')
  ].join('\n'));
  const selfRouteDownCommands = selfRouteIps.map((ip) => darwinSelfRouteDeleteCommand(ip));
  const anchorIp = darwinUserspaceAnchorIp(profile.interfaceName, selfRouteIps);
  const anchorUpCommand = darwinUserspaceAnchorInstallCommand(anchorIp);
  const anchorDownCommand = darwinUserspaceAnchorDeleteCommand(anchorIp);
  const endpointCleanupCommands = darwinEndpointBypassCleanupCommands(profile.endpointHosts, '"$ROUTE_LOG"');
  const addressCommands = profile.addresses.map(darwinUserspaceInterfaceAddressInstallCommand);
  const addressDownCommands = profile.addresses.map((address) => {
    const ip = address.split('/')[0] ?? address;
    if (address.includes(':')) return `ifconfig "$REAL_INTERFACE" inet6 ${shellQuote(ip)} -alias >/dev/null 2>&1 || true`;
    return `ifconfig "$REAL_INTERFACE" inet ${shellQuote(ip)} ${shellQuote(ip)} -alias >/dev/null 2>&1 || ifconfig "$REAL_INTERFACE" inet ${shellQuote(ip)} -alias >/dev/null 2>&1 || true`;
  });
  const primaryAddress = profile.addresses[0]?.split('/')[0] ?? '';
  const staleHdoInterfaceCleanupLines = darwinStaleUserspaceInterfaceCleanupLines(
    [...selfRouteDownCommands, ...routeDownCommands],
    primaryAddress
  );
  const finalStartValidationCommands = [
    `if [ -n "$WIREGUARD_GO_PID" ] && ! kill -0 "$WIREGUARD_GO_PID" >/dev/null 2>&1; then echo "wireguard-go exited after route configuration" >&2; tail -n 40 ${shellQuote(logFile)} >&2 2>/dev/null || true; exit 1; fi`,
    ...(primaryAddress ? [
      `ifconfig "$REAL_INTERFACE" 2>/dev/null | grep -q ${shellQuote(`inet ${primaryAddress}`)} || { echo "wireguard interface lost primary address ${primaryAddress}" >&2; ifconfig "$REAL_INTERFACE" >&2 2>/dev/null || true; exit 1; }`
    ] : [])
  ];
  const dnsStatePath = join(dirname(configPath), `${profile.interfaceName}.dns.state`);
  const dnsRestoreCommands = darwinDnsRestoreCommands(shellQuote(dnsStatePath), '"$ROUTE_LOG"');
  const dnsSetCommands = darwinDnsSetCommands(profile.dnsServers, profile.dnsDomains, shellQuote(dnsStatePath), '"$ROUTE_LOG"');
  const stopLines = [
    ...darwinRouteLogSetupLines(configPath, profile.interfaceName, action === 'down' ? 'down' : 'restart-stop'),
    'mkdir -p /var/run/wireguard',
    `REAL_INTERFACE="$(cat ${shellQuote(nameFile)} 2>/dev/null || true)"`,
    `if [ -z "$REAL_INTERFACE" ] && [ -n ${shellQuote(primaryAddress)} ]; then for candidate in $(ifconfig -l 2>/dev/null); do if ifconfig "$candidate" 2>/dev/null | grep -q ${shellQuote(`inet ${primaryAddress}`)}; then REAL_INTERFACE="$candidate"; break; fi; done; fi`,
    `if [ -z "$REAL_INTERFACE" ]; then for candidate in $(ifconfig -l 2>/dev/null); do if ifconfig "$candidate" 2>/dev/null | grep -q ${shellQuote(`inet ${anchorIp}`)}; then REAL_INTERFACE="$candidate"; break; fi; done; fi`,
    `if [ -n "$REAL_INTERFACE" ]; then REAL_INTERFACE_STATE="$(ifconfig "$REAL_INTERFACE" 2>/dev/null || true)"; REAL_INTERFACE_OWNED=0; if [ -n ${shellQuote(primaryAddress)} ] && printf '%s\\n' "$REAL_INTERFACE_STATE" | grep -q ${shellQuote(`inet ${primaryAddress}`)}; then REAL_INTERFACE_OWNED=1; fi; if [ "$REAL_INTERFACE_OWNED" != "1" ] && printf '%s\\n' "$REAL_INTERFACE_STATE" | grep -q ${shellQuote(`inet ${anchorIp}`)}; then REAL_INTERFACE_OWNED=1; fi; if [ "$REAL_INTERFACE_OWNED" != "1" ]; then echo ${shellQuote('skipStaleRealInterfaceBeforeStop=')}"$REAL_INTERFACE" >> "$ROUTE_LOG" 2>&1; REAL_INTERFACE=""; fi; fi`,
    `echo ${shellQuote('realInterfaceBeforeStop=')}"$REAL_INTERFACE" >> "$ROUTE_LOG" 2>&1`,
    ...dnsRestoreCommands,
    ...endpointCleanupCommands,
    `if [ -n "$REAL_INTERFACE" ]; then`,
    ...selfRouteDownCommands.map((line) => `  ${line}`),
    ...routeDownCommands.map((line) => `  ${line}`),
    ...addressDownCommands.map((line) => `  ${line}`),
    `  ${anchorDownCommand}`,
    '  ifconfig "$REAL_INTERFACE" down >/dev/null 2>&1 || true',
    '  rm -f "/var/run/wireguard/$REAL_INTERFACE.sock"',
    'fi',
    `if [ -s ${shellQuote(pidFile)} ]; then`,
    `  WIREGUARD_GO_PID="$(cat ${shellQuote(pidFile)} 2>/dev/null || true)"`,
    '  if [ -n "$WIREGUARD_GO_PID" ]; then',
    '    kill "$WIREGUARD_GO_PID" >/dev/null 2>&1 || true',
    '    i=0; while kill -0 "$WIREGUARD_GO_PID" >/dev/null 2>&1 && [ "$i" -lt 20 ]; do sleep 0.1; i=$((i + 1)); done',
    '    kill -9 "$WIREGUARD_GO_PID" >/dev/null 2>&1 || true',
    '  fi',
    'fi',
    `if [ -n ${shellQuote(primaryAddress)} ]; then for candidate in $(ifconfig -l 2>/dev/null); do if ifconfig "$candidate" 2>/dev/null | grep -q ${shellQuote(`inet ${primaryAddress}`)}; then REAL_INTERFACE="$candidate"; ${addressDownCommands.join('; ')}; ifconfig "$candidate" down >/dev/null 2>&1 || true; rm -f "/var/run/wireguard/$candidate.sock"; fi; done; fi`,
    `for candidate in $(ifconfig -l 2>/dev/null); do if ifconfig "$candidate" 2>/dev/null | grep -q ${shellQuote(`inet ${anchorIp}`)}; then REAL_INTERFACE="$candidate"; ${anchorDownCommand}; ifconfig "$candidate" down >/dev/null 2>&1 || true; rm -f "/var/run/wireguard/$candidate.sock"; fi; done`,
    ...staleHdoInterfaceCleanupLines,
    `if command -v pgrep >/dev/null 2>&1; then for stale_pid in $(pgrep -x wireguard-go 2>/dev/null || true); do stale_command="$(ps -p "$stale_pid" -o command= 2>/dev/null || true)"; printf '%s\\n' "$stale_command" | grep -F ${shellQuote(wireGuardGo)} >/dev/null 2>&1 && kill "$stale_pid" >/dev/null 2>&1 || true; done; fi`,
    `rm -f ${shellQuote(nameFile)} ${shellQuote(pidFile)}`
  ];
  const startLines = [
    ...darwinRouteLogSetupLines(configPath, profile.interfaceName, action),
    'mkdir -p /var/run/wireguard',
    ...darwinEndpointBypassCommands(profile.endpointHosts, '"$ROUTE_LOG"'),
    `rm -f ${shellQuote(nameFile)} ${shellQuote(pidFile)}`,
    `BEFORE_INTERFACES="$(${shellQuote(wg)} show interfaces 2>/dev/null || true)"`,
    `WG_PROCESS_FOREGROUND=1 WG_TUN_NAME_FILE=${shellQuote(nameFile)} ${shellQuote(wireGuardGo)} utun >${shellQuote(logFile)} 2>&1 &`,
    `echo "$!" > ${shellQuote(pidFile)}`,
    `chmod 644 ${shellQuote(pidFile)} >/dev/null 2>&1 || true`,
    `i=0; while [ ! -s ${shellQuote(nameFile)} ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done`,
    `REAL_INTERFACE="$(cat ${shellQuote(nameFile)} 2>/dev/null || true)"`,
    `if [ -z "$REAL_INTERFACE" ]; then AFTER_INTERFACES="$(${shellQuote(wg)} show interfaces 2>/dev/null || true)"; for candidate in $AFTER_INTERFACES; do case " $BEFORE_INTERFACES " in *" $candidate "*) ;; *) REAL_INTERFACE="$candidate"; break ;; esac; done; fi`,
    '[ -n "$REAL_INTERFACE" ]',
    'case " $BEFORE_INTERFACES " in *" $REAL_INTERFACE "*) echo "wireguard-go returned an existing interface: $REAL_INTERFACE" >&2; exit 1 ;; esac',
    `WIREGUARD_GO_PID="$(cat ${shellQuote(pidFile)} 2>/dev/null || true)"`,
    `if [ -z "$WIREGUARD_GO_PID" ] || ! kill -0 "$WIREGUARD_GO_PID" >/dev/null 2>&1; then echo "wireguard-go exited before interface configuration" >&2; tail -n 40 ${shellQuote(logFile)} >&2 2>/dev/null || true; exit 1; fi`,
    `echo ${shellQuote('realInterface=')}"$REAL_INTERFACE" >> "$ROUTE_LOG" 2>&1`,
    `echo ${shellQuote(`anchorAddress=${anchorIp}`)} >> "$ROUTE_LOG" 2>&1`,
    `echo "$REAL_INTERFACE" > ${shellQuote(nameFile)}`,
    `chmod 644 ${shellQuote(nameFile)} >/dev/null 2>&1 || true`,
    `${shellQuote(wg)} setconf "$REAL_INTERFACE" ${shellQuote(profile.setConfigPath)}`,
    'ifconfig "$REAL_INTERFACE" up',
    ...addressCommands,
    ...(primaryAddress ? [
      `ifconfig "$REAL_INTERFACE" 2>/dev/null | grep -q ${shellQuote(`inet ${primaryAddress}`)} || { echo "wireguard interface missing primary address ${primaryAddress}" >&2; ifconfig "$REAL_INTERFACE" >&2 2>/dev/null || true; exit 1; }`
    ] : []),
    anchorUpCommand,
    ...routeDownCommands,
    ...routeUpCommands,
    ...selfRouteUpCommands,
    ...dnsSetCommands,
    ...finalStartValidationCommands
  ];
  const scriptLines = action === 'down'
    ? ['set -e', ...stopLines]
    : ['set -e', ...stopLines, 'REAL_INTERFACE=""', ...startLines];
  const shellCommand = scriptLines.join('\n');
  const scriptPath = join(dirname(configPath), `${profile.interfaceName}.${action}.sh`);
  writeFileSync(scriptPath, shellCommand + '\n', { mode: 0o700 });
  const scriptCommand = `/bin/sh ${shellQuote(scriptPath)}`;
  const script = `do shell script ${appleScriptString(scriptCommand)} with administrator privileges`;
  return {
    action,
    platform: runtime.platform,
    configPath,
    command: 'osascript',
    args: ['-e', script],
    displayCommand: `osascript -e ${shellQuote(script)} # ${shellQuote(scriptPath)}`,
    needsAdmin: true,
    runtime
  };
}

type DarwinUserspaceProfile = {
  interfaceName: string;
  addresses: string[];
  allowedIps: string[];
  routePriorityCidrs: string[];
  dnsServers: string[];
  dnsDomains: string[];
  endpointHosts: string[];
  setConfigPath: string;
};

function prepareDarwinUserspaceProfile(configPath: string): DarwinUserspaceProfile {
  return darwinUserspaceProfile(configPath, true);
}

function inspectDarwinUserspaceProfile(configPath: string): DarwinUserspaceProfile {
  return darwinUserspaceProfile(configPath, false);
}

function darwinUserspaceProfile(configPath: string, writeSetConfig: boolean): DarwinUserspaceProfile {
  const parsed = parseWireGuardProfile(configPath);
  const setConfigPath = join(dirname(configPath), `${parsed.interfaceName}.setconf`);
  if (writeSetConfig) {
    writeFileSync(setConfigPath, parsed.setConfigLines.join('\n').trimEnd() + '\n', { mode: 0o600 });
  }
  return {
    interfaceName: parsed.interfaceName,
    addresses: parsed.addresses,
    allowedIps: parsed.allowedIps,
    routePriorityCidrs: parsed.routePriorityCidrs,
    dnsServers: parsed.dnsServers,
    dnsDomains: parsed.dnsDomains,
    endpointHosts: parsed.endpointHosts,
    setConfigPath
  };
}

interface DarwinLaunchDaemonAssets {
  displayName: string;
  label: string;
  supportDir: string;
  binDir: string;
  logDir: string;
  plistPath: string;
  daemonScriptPath: string;
  routeLogPath: string;
  launchdStdoutPath: string;
  launchdStderrPath: string;
  wireGuardGoLogPath: string;
  sourceConfigPath: string;
  sourceSetConfigPath: string;
  sourceWgPath: string;
  sourceWireGuardGoPath: string;
  rootConfigPath: string;
  rootSetConfigPath: string;
  rootWgPath: string;
  rootWireGuardGoPath: string;
  nameFile: string;
  pidFile: string;
  cleanStartMarkerPath: string;
  dnsStatePath: string;
  staleLaunchDaemonLabelPrefixes: string[];
  profile: DarwinUserspaceProfile;
}

function wireGuardLaunchDaemonUnsupportedStatus(
  runtime: WireGuardConnectionRuntimeStatus,
  configPath: string
): WireGuardLaunchDaemonStatus {
  return {
    ok: true,
    supported: false,
    installed: false,
    loaded: false,
    running: false,
    mode: runtime.method,
    label: null,
    plistPath: null,
    supportDir: null,
    daemonScriptPath: null,
    configPath,
    runtime
  };
}

function darwinLaunchDaemonAssets(
  runtime: WireGuardConnectionRuntimeStatus,
  configPath: string,
  options: { writeSetConfig?: boolean; serviceIdentity?: WireGuardServiceIdentity } = {}
): DarwinLaunchDaemonAssets {
  const wg = runtime.wg.command;
  const wireGuardGo = runtime.wireGuardGo?.command;
  if (!wg || !wireGuardGo) throw new Error(runtime.error ?? 'darwin userspace WireGuard runtime unavailable');
  const profile = options.writeSetConfig === false
    ? inspectDarwinUserspaceProfile(configPath)
    : prepareDarwinUserspaceProfile(configPath);
  const identity = normalizeWireGuardServiceIdentity(options.serviceIdentity);
  const component = sanitizeLaunchDaemonComponent(profile.interfaceName);
  const label = `${identity.darwinLaunchDaemonLabelPrefix}.${component}`;
  const supportDir = `${identity.darwinSupportRoot}/${component}`;
  const binDir = `${supportDir}/bin`;
  const logDir = identity.darwinLogDir;
  return {
    displayName: identity.displayName,
    label,
    supportDir,
    binDir,
    logDir,
    plistPath: `/Library/LaunchDaemons/${label}.plist`,
    daemonScriptPath: `${supportDir}/${identity.darwinDaemonScriptName}`,
    routeLogPath: `${supportDir}/${profile.interfaceName}.route.log`,
    launchdStdoutPath: `${logDir}/${profile.interfaceName}.launchd.out.log`,
    launchdStderrPath: `${logDir}/${profile.interfaceName}.launchd.err.log`,
    wireGuardGoLogPath: `${logDir}/${profile.interfaceName}.wireguard-go.log`,
    sourceConfigPath: configPath,
    sourceSetConfigPath: profile.setConfigPath,
    sourceWgPath: wg,
    sourceWireGuardGoPath: wireGuardGo,
    rootConfigPath: `${supportDir}/${basename(configPath)}`,
    rootSetConfigPath: `${supportDir}/${basename(profile.setConfigPath)}`,
    rootWgPath: `${binDir}/wg`,
    rootWireGuardGoPath: `${binDir}/wireguard-go`,
    nameFile: `/var/run/wireguard/${profile.interfaceName}.name`,
    pidFile: `/var/run/wireguard/${profile.interfaceName}.pid`,
    cleanStartMarkerPath: `/var/run/wireguard/${profile.interfaceName}.clean-start`,
    dnsStatePath: `${supportDir}/${profile.interfaceName}.dns.state`,
    staleLaunchDaemonLabelPrefixes: identity.staleDarwinLaunchDaemonLabelPrefixes,
    profile
  };
}

function normalizeWireGuardServiceIdentity(input?: WireGuardServiceIdentity): Required<WireGuardServiceIdentity> {
  const defaultLabelPrefix = 'com.qpjoy.hdo.wireguard';
  const labelPrefix = sanitizeLaunchDaemonLabelPrefix(input?.darwinLaunchDaemonLabelPrefix || defaultLabelPrefix);
  return {
    displayName: input?.displayName?.trim() || 'HDO WireGuard',
    darwinLaunchDaemonLabelPrefix: labelPrefix,
    darwinSupportRoot: trimTrailingSlash(input?.darwinSupportRoot || '/Library/Application Support/QPJoy/HDO'),
    darwinLogDir: trimTrailingSlash(input?.darwinLogDir || '/Library/Logs/QPJoy-HDO'),
    darwinDaemonScriptName: sanitizeDarwinScriptName(input?.darwinDaemonScriptName || 'hdo-wireguard-daemon.sh'),
    staleDarwinLaunchDaemonLabelPrefixes: uniqueStrings([
      labelPrefix,
      ...(input?.staleDarwinLaunchDaemonLabelPrefixes || []).map(sanitizeLaunchDaemonLabelPrefix).filter(Boolean)
    ]),
    darwinExtraInstallShell: input?.darwinExtraInstallShell || null,
    darwinExtraUninstallShell: input?.darwinExtraUninstallShell || null
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '') || '/';
}

function sanitizeLaunchDaemonLabelPrefix(value: string): string {
  return value
    .split('.')
    .map((part) => sanitizeLaunchDaemonComponent(part))
    .filter(Boolean)
    .join('.') || 'com.qpjoy.hdo.wireguard';
}

function sanitizeDarwinScriptName(value: string): string {
  return basename(value).replace(/[^a-zA-Z0-9_.-]/g, '-') || 'wireguard-daemon.sh';
}

function darwinLaunchDaemonInstallShell(assets: DarwinLaunchDaemonAssets, extraShell?: string | null): string {
  const daemonScript = darwinLaunchDaemonScript(assets);
  const plist = darwinLaunchDaemonPlist(assets);
  return [
    'set -e',
    `LABEL=${shellQuote(assets.label)}`,
    `PLIST=${shellQuote(assets.plistPath)}`,
    `SUPPORT_DIR=${shellQuote(assets.supportDir)}`,
    `BIN_DIR=${shellQuote(assets.binDir)}`,
    `LOG_DIR=${shellQuote(assets.logDir)}`,
    `PRIMARY_ADDRESS=${shellQuote(assets.profile.addresses[0]?.split('/')[0] ?? '')}`,
    `CLEAN_START_MARKER=${shellQuote(assets.cleanStartMarkerPath)}`,
    ...darwinStaleLaunchDaemonCleanupLines(assets.staleLaunchDaemonLabelPrefixes),
    '__hdo_previous_loaded=0',
    'if launchctl print "system/$LABEL" >/dev/null 2>&1; then __hdo_previous_loaded=1; fi',
    'launchctl bootout "system/$LABEL" >/dev/null 2>&1 || launchctl bootout system "$PLIST" >/dev/null 2>&1 || true',
    '__hdo_bootout_i=0',
    'while launchctl print "system/$LABEL" >/dev/null 2>&1 && [ "$__hdo_bootout_i" -lt 40 ]; do sleep 0.25; __hdo_bootout_i=$((__hdo_bootout_i + 1)); done',
    'mkdir -p "$SUPPORT_DIR" "$BIN_DIR" "$LOG_DIR" /var/run/wireguard',
    'if [ "$__hdo_previous_loaded" = "1" ] && ! launchctl print "system/$LABEL" >/dev/null 2>&1; then touch "$CLEAN_START_MARKER"; fi',
    `cp ${shellQuote(assets.sourceConfigPath)} ${shellQuote(assets.rootConfigPath)}`,
    `cp ${shellQuote(assets.sourceSetConfigPath)} ${shellQuote(assets.rootSetConfigPath)}`,
    `cp ${shellQuote(assets.sourceWgPath)} ${shellQuote(assets.rootWgPath)}`,
    `cp ${shellQuote(assets.sourceWireGuardGoPath)} ${shellQuote(assets.rootWireGuardGoPath)}`,
    heredocWriteCommand(assets.daemonScriptPath, daemonScript),
    heredocWriteCommand(assets.plistPath, plist),
    `chown -R root:wheel ${shellQuote(assets.supportDir)} ${shellQuote(assets.logDir)}`,
    `chown root:wheel ${shellQuote(assets.plistPath)}`,
    `chmod 600 ${shellQuote(assets.rootConfigPath)} ${shellQuote(assets.rootSetConfigPath)}`,
    `chmod 755 ${shellQuote(assets.rootWgPath)} ${shellQuote(assets.rootWireGuardGoPath)} ${shellQuote(assets.daemonScriptPath)}`,
    `chmod 644 ${shellQuote(assets.plistPath)}`,
    '__hdo_bootstrap_i=0',
    'until launchctl bootstrap system "$PLIST"; do',
    '  __hdo_bootstrap_status=$?',
    '  if [ "$__hdo_bootstrap_i" -ge 5 ]; then exit "$__hdo_bootstrap_status"; fi',
    '  launchctl bootout "system/$LABEL" >/dev/null 2>&1 || launchctl bootout system "$PLIST" >/dev/null 2>&1 || true',
    '  sleep 0.5',
    '  __hdo_bootstrap_i=$((__hdo_bootstrap_i + 1))',
    'done',
    'launchctl enable "system/$LABEL" >/dev/null 2>&1 || true',
    'launchctl kickstart -k "system/$LABEL" >/dev/null 2>&1 || true',
    'launchctl print "system/$LABEL" >/dev/null',
    ...(extraShell ? [
      '# Extra network setup requested by launcher.',
      extraShell
    ] : [])
  ].join('\n');
}

function darwinStaleLaunchDaemonCleanupLines(labelPrefixes: string[]): string[] {
  return [
    'if [ -n "$PRIMARY_ADDRESS" ]; then',
    `  for STALE_PREFIX in ${labelPrefixes.map(shellQuote).join(' ')}; do`,
    '    for STALE_PLIST in /Library/LaunchDaemons/$STALE_PREFIX.*.plist; do',
    '      [ -e "$STALE_PLIST" ] || continue',
    '      [ "$STALE_PLIST" = "$PLIST" ] && continue',
    '      STALE_SCRIPT="$(/usr/libexec/PlistBuddy -c "Print :ProgramArguments:1" "$STALE_PLIST" 2>/dev/null || true)"',
    '      [ -f "$STALE_SCRIPT" ] || continue',
    '      grep -F "PRIMARY_ADDRESS=\'$PRIMARY_ADDRESS\'" "$STALE_SCRIPT" >/dev/null 2>&1 || continue',
    '      STALE_LABEL="$(basename "$STALE_PLIST" .plist)"',
    '      STALE_SUPPORT_DIR="$(dirname "$STALE_SCRIPT")"',
    '      launchctl bootout "system/$STALE_LABEL" >/dev/null 2>&1 || launchctl bootout system "$STALE_PLIST" >/dev/null 2>&1 || true',
    '      __hdo_stale_i=0',
    '      while launchctl print "system/$STALE_LABEL" >/dev/null 2>&1 && [ "$__hdo_stale_i" -lt 40 ]; do sleep 0.25; __hdo_stale_i=$((__hdo_stale_i + 1)); done',
    '      rm -f "$STALE_PLIST"',
    '      rm -rf "$STALE_SUPPORT_DIR"',
    '    done',
    '  done',
    'fi'
  ];
}

function darwinLaunchDaemonUninstallShell(assets: DarwinLaunchDaemonAssets, extraShell?: string | null): string {
  return [
    'set -e',
    `LABEL=${shellQuote(assets.label)}`,
    `PLIST=${shellQuote(assets.plistPath)}`,
    `SUPPORT_DIR=${shellQuote(assets.supportDir)}`,
    `PID_FILE=${shellQuote(assets.pidFile)}`,
    `WIREGUARD_GO=${shellQuote(assets.rootWireGuardGoPath)}`,
    `CLEAN_START_MARKER=${shellQuote(assets.cleanStartMarkerPath)}`,
    'launchctl bootout "system/$LABEL" >/dev/null 2>&1 || launchctl bootout system "$PLIST" >/dev/null 2>&1 || true',
    '__hdo_bootout_i=0',
    'while launchctl print "system/$LABEL" >/dev/null 2>&1 && [ "$__hdo_bootout_i" -lt 40 ]; do sleep 0.25; __hdo_bootout_i=$((__hdo_bootout_i + 1)); done',
    'if ! launchctl print "system/$LABEL" >/dev/null 2>&1; then mkdir -p /var/run/wireguard; touch "$CLEAN_START_MARKER"; else rm -f "$CLEAN_START_MARKER"; fi',
    'if [ -s "$PID_FILE" ]; then WG_PID="$(cat "$PID_FILE" 2>/dev/null || true)"; if [ -n "$WG_PID" ]; then kill "$WG_PID" >/dev/null 2>&1 || true; sleep 0.2; kill -9 "$WG_PID" >/dev/null 2>&1 || true; fi; fi',
    'if command -v pgrep >/dev/null 2>&1; then for stale_pid in $(pgrep -x wireguard-go 2>/dev/null || true); do stale_command="$(ps -p "$stale_pid" -o command= 2>/dev/null || true)"; printf \'%s\\n\' "$stale_command" | grep -F "$WIREGUARD_GO" >/dev/null 2>&1 && kill "$stale_pid" >/dev/null 2>&1 || true; done; fi',
    extraShell ? `# extra uninstall cleanup\n${extraShell}` : null,
    `rm -f ${shellQuote(assets.plistPath)} ${shellQuote(assets.nameFile)} ${shellQuote(assets.pidFile)}`,
    `rm -rf ${shellQuote(assets.supportDir)}`
  ].filter(Boolean).join('\n');
}

function darwinLaunchDaemonScript(assets: DarwinLaunchDaemonAssets): string {
  const profile = assets.profile;
  const routeInstallCidrs = darwinRouteInstallCidrs(profile.allowedIps, profile.routePriorityCidrs);
  const routeCleanupCidrs = uniqueStrings([
    ...profile.allowedIps.map((cidr) => normalizeCidr(cidr) ?? cidr),
    ...routeInstallCidrs,
    ...darwinStalePriorityRouteCidrs(profile.allowedIps)
  ]);
  const routeUpCommands = routeInstallCidrs
    .filter((cidr) => cidr.includes('/'))
    .map((cidr) => [
      darwinRouteDeleteCommand(cidr),
      darwinRouteInstallCommand(cidr, '"$REAL_INTERFACE"'),
      darwinRouteEnsureCommand(cidr, '"$REAL_INTERFACE"'),
      darwinRouteProbeLogCommand(cidr, '"$REAL_INTERFACE"', '"$ROUTE_LOG"')
    ].join('\n'));
  const routeDownCommands = routeCleanupCidrs
    .filter((cidr) => cidr.includes('/'))
    .map((cidr) => darwinRouteDeleteCommand(cidr));
  const selfRouteIps = uniqueStrings(profile.addresses
    .map((address) => address.split('/')[0] ?? address)
    .filter(isIpv4));
  const selfRouteUpCommands = selfRouteIps.map((ip) => [
    darwinSelfRouteInstallCommand(ip),
    darwinSelfRouteProbeLogCommand(ip, '"$ROUTE_LOG"')
  ].join('\n'));
  const selfRouteDownCommands = selfRouteIps.map((ip) => darwinSelfRouteDeleteCommand(ip));
  const anchorIp = darwinUserspaceAnchorIp(profile.interfaceName, selfRouteIps);
  const anchorUpCommand = darwinUserspaceAnchorInstallCommand(anchorIp);
  const anchorDownCommand = darwinUserspaceAnchorDeleteCommand(anchorIp);
  const endpointCleanupCommands = darwinEndpointBypassCleanupCommands(profile.endpointHosts, '"$ROUTE_LOG"');
  const addressCommands = profile.addresses.map(darwinUserspaceInterfaceAddressInstallCommand);
  const addressDownCommands = profile.addresses.map((address) => {
    const ip = address.split('/')[0] ?? address;
    if (address.includes(':')) return `ifconfig "$REAL_INTERFACE" inet6 ${shellQuote(ip)} -alias >/dev/null 2>&1 || true`;
    return `ifconfig "$REAL_INTERFACE" inet ${shellQuote(ip)} ${shellQuote(ip)} -alias >/dev/null 2>&1 || ifconfig "$REAL_INTERFACE" inet ${shellQuote(ip)} -alias >/dev/null 2>&1 || true`;
  });
  const primaryAddress = profile.addresses[0]?.split('/')[0] ?? '';
  const staleHdoInterfaceCleanupLines = darwinStaleUserspaceInterfaceCleanupLines(
    [...selfRouteDownCommands, ...routeDownCommands],
    primaryAddress
  );
  const finalStartValidationCommands = [
    'if [ -z "$WG_PID" ] || ! kill -0 "$WG_PID" >/dev/null 2>&1; then echo "wireguard-go exited after route configuration" >&2; tail -n 40 "$WG_GO_LOG" >&2 2>/dev/null || true; exit 1; fi',
    ...(primaryAddress ? [
      `ifconfig "$REAL_INTERFACE" 2>/dev/null | grep -q ${shellQuote(`inet ${primaryAddress}`)} || { echo "wireguard interface lost primary address ${primaryAddress}" >&2; ifconfig "$REAL_INTERFACE" >&2 2>/dev/null || true; exit 1; }`
    ] : [])
  ];
  const dnsRestoreCommands = darwinDnsRestoreCommands('"$DNS_STATE_FILE"', '"$ROUTE_LOG"');
  const dnsSetCommands = darwinDnsSetCommands(profile.dnsServers, profile.dnsDomains, '"$DNS_STATE_FILE"', '"$ROUTE_LOG"');
  const endpointBypassCommands = darwinEndpointBypassCommands(profile.endpointHosts, '"$ROUTE_LOG"');
  const endpointBypassFunctionLines = endpointBypassCommands.length > 0
    ? [
        'apply_endpoint_bypass() {',
        ...endpointBypassCommands.map((line) => `  ${line}`),
        '}'
      ]
    : [];
  // The endpoint bypass host routes are pinned to the physical IPv4 default
  // selected from netstat, not the logical default reported by a Clash/mihomo
  // utun. After a Wi-Fi/network switch they keep pointing at the old
  // gateway/source address and black-hole the relay endpoint (bootstrap API
  // included) until deleted with root. This daemon is the only resident root
  // process, so it watches the default path and re-applies the bypass when it
  // changes. Source address matters when two Wi-Fi networks use the same
  // interface and gateway but DHCP assigns a different local address. The
  // routes are also shared kernel state: another product's daemon cleanup can
  // delete them while this tunnel is still up (multiple standalone launchers
  // may point at the same relay IP), so when the default path is stable the
  // watchdog verifies each applied host route still exists and still follows
  // the current default gateway/interface/source, restoring it otherwise.
  const endpointBypassWatchdogLines = endpointBypassCommands.length > 0
    ? [
        'current_endpoint_bypass_path() {',
        "  __hdo_physical_path=\"$(/usr/sbin/netstat -rn -f inet 2>/dev/null | awk '$1 == \"default\" && $2 ~ /^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$/ && $2 !~ /^198\\.(18|19)\\./ && $4 !~ /^(utun|lo)[0-9]*$/ { print $2, $4; exit }')\"",
        '  set -- $__hdo_physical_path',
        '  __hdo_physical_gateway="${1:-}"',
        '  __hdo_physical_interface="${2:-}"',
        '  [ -n "$__hdo_physical_gateway" ] && [ -n "$__hdo_physical_interface" ] || return 0',
        "  __hdo_physical_source=\"$(/sbin/ifconfig \"$__hdo_physical_interface\" 2>/dev/null | awk '/^[[:space:]]*inet[[:space:]]/ { print $2; exit }')\"",
        '  printf "%s %s %s" "$__hdo_physical_gateway" "$__hdo_physical_interface" "${__hdo_physical_source:--}"',
        '}',
        ...renderDarwinEndpointBypassRouteStateFunctionLines(),
        '(',
        '  __hdo_bypass_path="$(current_endpoint_bypass_path)"',
        '  while kill -0 "$WG_PID" >/dev/null 2>&1; do',
        '    sleep 5',
        '    __hdo_bypass_next="$(current_endpoint_bypass_path)"',
        '    if [ -n "$__hdo_bypass_next" ] && [ "$__hdo_bypass_next" != "$__hdo_bypass_path" ]; then',
        '      log_action "endpoint-bypass-refresh"',
        '      log_route "defaultPathChanged=${__hdo_bypass_path}-> ${__hdo_bypass_next}"',
        '      apply_endpoint_bypass',
        '      __hdo_bypass_path="$__hdo_bypass_next"',
        '    elif [ -n "$__hdo_bypass_next" ]; then',
        '      set -- $__hdo_bypass_next',
        '      __hdo_bypass_gw="${1:-}"',
        '      __hdo_bypass_interface="${2:-}"',
        '      __hdo_bypass_source="${3:-}"',
        '      case "$__hdo_bypass_gw" in *[!0-9.]*|"") __hdo_bypass_gw="" ;; esac',
        '      if [ -n "$__hdo_bypass_gw" ]; then',
        '        for __hdo_bypass_ip in ${__hdo_bypass_applied_ips:-}; do',
        '          __hdo_bypass_route_state="$(endpoint_bypass_route_state "$__hdo_bypass_ip")"',
        '          set -- $__hdo_bypass_route_state',
        '          __hdo_bypass_dest="${1:--}"',
        '          __hdo_bypass_rgw="${2:--}"',
        '          __hdo_bypass_rinterface="${3:--}"',
        '          __hdo_bypass_rsource="${4:--}"',
        '          if [ "$__hdo_bypass_dest" != "$__hdo_bypass_ip" ] || { [ "$__hdo_bypass_rgw" != "-" ] && [ "$__hdo_bypass_rgw" != "$__hdo_bypass_gw" ]; } || { [ "$__hdo_bypass_rinterface" != "-" ] && [ "$__hdo_bypass_rinterface" != "$__hdo_bypass_interface" ]; } || { [ "$__hdo_bypass_rsource" != "-" ] && [ "$__hdo_bypass_source" != "-" ] && [ "$__hdo_bypass_rsource" != "$__hdo_bypass_source" ]; }; then',
        '            log_action "endpoint-bypass-restore"',
        '            log_route "bypassRouteDrift=${__hdo_bypass_ip} dest=${__hdo_bypass_dest:-missing} gateway=${__hdo_bypass_rgw:-none}->${__hdo_bypass_gw} interface=${__hdo_bypass_rinterface:-none}->${__hdo_bypass_interface} source=${__hdo_bypass_rsource:-none}->${__hdo_bypass_source}"',
        '            apply_endpoint_bypass',
        '            break',
        '          fi',
        '        done',
        '      fi',
        '    fi',
        '  done',
        ') &',
        'ENDPOINT_WATCHDOG_PID="$!"'
      ]
    : [];
  return [
    '#!/bin/sh',
    'set -u',
    `INTERFACE_NAME=${shellQuote(profile.interfaceName)}`,
    `WG=${shellQuote(assets.rootWgPath)}`,
    `WIREGUARD_GO=${shellQuote(assets.rootWireGuardGoPath)}`,
    `SETCONF=${shellQuote(assets.rootSetConfigPath)}`,
    `NAME_FILE=${shellQuote(assets.nameFile)}`,
    `PID_FILE=${shellQuote(assets.pidFile)}`,
    `DNS_STATE_FILE=${shellQuote(assets.dnsStatePath)}`,
    `CLEAN_START_MARKER=${shellQuote(assets.cleanStartMarkerPath)}`,
    `HDO_DNS_SERVERS=${shellQuote(profile.dnsServers.join(' '))}`,
    `ROUTE_LOG=${shellQuote(assets.routeLogPath)}`,
    `WG_GO_LOG=${shellQuote(assets.wireGuardGoLogPath)}`,
    `PRIMARY_ADDRESS=${shellQuote(primaryAddress)}`,
    `ANCHOR_ADDRESS=${shellQuote(anchorIp)}`,
    'mkdir -p /var/run/wireguard "$(dirname "$ROUTE_LOG")" "$(dirname "$WG_GO_LOG")"',
    'touch "$ROUTE_LOG" "$WG_GO_LOG"',
    'chmod 644 "$ROUTE_LOG" "$WG_GO_LOG" >/dev/null 2>&1 || true',
    'log_route() { printf "%s\\n" "$*" >> "$ROUTE_LOG" 2>&1; }',
    'log_action() { log_route "---"; log_route "action=$1"; log_route "timestamp=$(date -u \'+%Y-%m-%dT%H:%M:%SZ\')"; log_route "interface=$INTERFACE_NAME"; }',
    ...endpointBypassFunctionLines,
    'cleanup() {',
    '  code="${1:-0}"',
    '  log_action "launchdaemon-cleanup"',
    '  log_route "exit=$code"',
    '  if [ -n "${ENDPOINT_WATCHDOG_PID:-}" ]; then kill "$ENDPOINT_WATCHDOG_PID" >/dev/null 2>&1 || true; ENDPOINT_WATCHDOG_PID=""; fi',
    '  REAL_INTERFACE="$(cat "$NAME_FILE" 2>/dev/null || true)"',
    '  if [ -z "$REAL_INTERFACE" ] && [ -n "$PRIMARY_ADDRESS" ]; then for candidate in $(ifconfig -l 2>/dev/null); do if ifconfig "$candidate" 2>/dev/null | grep -q "inet $PRIMARY_ADDRESS"; then REAL_INTERFACE="$candidate"; break; fi; done; fi',
    '  if [ -z "$REAL_INTERFACE" ] && [ -n "$ANCHOR_ADDRESS" ]; then for candidate in $(ifconfig -l 2>/dev/null); do if ifconfig "$candidate" 2>/dev/null | grep -q "inet $ANCHOR_ADDRESS"; then REAL_INTERFACE="$candidate"; break; fi; done; fi',
    '  if [ -n "$REAL_INTERFACE" ]; then REAL_INTERFACE_STATE="$(ifconfig "$REAL_INTERFACE" 2>/dev/null || true)"; REAL_INTERFACE_OWNED=0; if [ -n "$PRIMARY_ADDRESS" ] && printf \'%s\\n\' "$REAL_INTERFACE_STATE" | grep -q "inet $PRIMARY_ADDRESS"; then REAL_INTERFACE_OWNED=1; fi; if [ "$REAL_INTERFACE_OWNED" != "1" ] && [ -n "$ANCHOR_ADDRESS" ] && printf \'%s\\n\' "$REAL_INTERFACE_STATE" | grep -q "inet $ANCHOR_ADDRESS"; then REAL_INTERFACE_OWNED=1; fi; if [ "$REAL_INTERFACE_OWNED" != "1" ]; then log_route "skipStaleRealInterfaceBeforeStop=$REAL_INTERFACE"; REAL_INTERFACE=""; fi; fi',
    ...dnsRestoreCommands.map((line) => `  ${line}`),
    ...endpointCleanupCommands.map((line) => `  ${line}`),
    '  if [ -n "$REAL_INTERFACE" ]; then',
    ...selfRouteDownCommands.map((line) => `    ${line}`),
    ...routeDownCommands.map((line) => `    ${line}`),
    ...addressDownCommands.map((line) => `    ${line}`),
    `    ${anchorDownCommand}`,
    '    ifconfig "$REAL_INTERFACE" down >/dev/null 2>&1 || true',
    '    rm -f "/var/run/wireguard/$REAL_INTERFACE.sock"',
    '  fi',
    '  if [ -s "$PID_FILE" ]; then WG_PID="$(cat "$PID_FILE" 2>/dev/null || true)"; if [ -n "$WG_PID" ]; then kill "$WG_PID" >/dev/null 2>&1 || true; sleep 0.2; kill -9 "$WG_PID" >/dev/null 2>&1 || true; fi; fi',
    '  if command -v pgrep >/dev/null 2>&1; then for stale_pid in $(pgrep -x wireguard-go 2>/dev/null || true); do stale_command="$(ps -p "$stale_pid" -o command= 2>/dev/null || true)"; printf \'%s\\n\' "$stale_command" | grep -F "$WIREGUARD_GO" >/dev/null 2>&1 && kill "$stale_pid" >/dev/null 2>&1 || true; done; fi',
    ...staleHdoInterfaceCleanupLines.map((line) => `  ${line}`),
    '  rm -f "$NAME_FILE" "$PID_FILE"',
    '}',
    'trap \'code=$?; cleanup "$code"; exit "$code"\' EXIT',
    'trap \'exit 0\' INT TERM HUP',
    'if [ -f "$CLEAN_START_MARKER" ]; then',
    '  rm -f "$CLEAN_START_MARKER"',
    '  log_action "launchdaemon-clean-start"',
    'else',
    '  cleanup 0 >/dev/null 2>&1 || true',
    'fi',
    'log_action "launchdaemon-start"',
    ...(endpointBypassFunctionLines.length > 0 ? ['apply_endpoint_bypass'] : []),
    'rm -f "$NAME_FILE" "$PID_FILE"',
    'BEFORE_INTERFACES="$("$WG" show interfaces 2>/dev/null || true)"',
    'WG_PROCESS_FOREGROUND=1 WG_TUN_NAME_FILE="$NAME_FILE" "$WIREGUARD_GO" utun >> "$WG_GO_LOG" 2>&1 &',
    'WG_PID="$!"',
    'echo "$WG_PID" > "$PID_FILE"',
    'chmod 644 "$PID_FILE" >/dev/null 2>&1 || true',
    'i=0; while [ ! -s "$NAME_FILE" ] && [ "$i" -lt 80 ]; do sleep 0.1; i=$((i + 1)); done',
    'REAL_INTERFACE="$(cat "$NAME_FILE" 2>/dev/null || true)"',
    'if [ -z "$REAL_INTERFACE" ]; then AFTER_INTERFACES="$("$WG" show interfaces 2>/dev/null || true)"; for candidate in $AFTER_INTERFACES; do case " $BEFORE_INTERFACES " in *" $candidate "*) ;; *) REAL_INTERFACE="$candidate"; break ;; esac; done; fi',
    '[ -n "$REAL_INTERFACE" ]',
    'case " $BEFORE_INTERFACES " in *" $REAL_INTERFACE "*) echo "wireguard-go returned an existing interface: $REAL_INTERFACE" >&2; exit 1 ;; esac',
    'if [ -z "$WG_PID" ] || ! kill -0 "$WG_PID" >/dev/null 2>&1; then echo "wireguard-go exited before interface configuration" >&2; tail -n 40 "$WG_GO_LOG" >&2 2>/dev/null || true; exit 1; fi',
    'echo "$REAL_INTERFACE" > "$NAME_FILE"',
    'chmod 644 "$NAME_FILE" >/dev/null 2>&1 || true',
    'log_route "realInterface=$REAL_INTERFACE"',
    'log_route "anchorAddress=$ANCHOR_ADDRESS"',
    '"$WG" setconf "$REAL_INTERFACE" "$SETCONF"',
    'ifconfig "$REAL_INTERFACE" up',
    ...addressCommands,
    ...(primaryAddress ? [
      `ifconfig "$REAL_INTERFACE" 2>/dev/null | grep -q ${shellQuote(`inet ${primaryAddress}`)} || { echo "wireguard interface missing primary address ${primaryAddress}" >&2; ifconfig "$REAL_INTERFACE" >&2 2>/dev/null || true; exit 1; }`
    ] : []),
    anchorUpCommand,
    ...routeDownCommands,
    ...routeUpCommands,
    ...selfRouteUpCommands,
    ...dnsSetCommands,
    ...finalStartValidationCommands,
    ...endpointBypassWatchdogLines,
    'wait "$WG_PID"',
    'exit "$?"'
  ].join('\n') + '\n';
}

export function renderDarwinEndpointBypassRouteStateFunctionLines(): string[] {
  return [
    'endpoint_bypass_route_state() {',
    "  route -vn get \"$1\" 2>/dev/null | awk '",
    "    /^[[:space:]]*destination:/ { destination=$2 }",
    "    /^[[:space:]]*gateway:/ { gateway=$2 }",
    "    /^[[:space:]]*interface:/ { interfaceName=$2 }",
    "    /sockaddrs: .*IFA/ { getline; source=$NF }",
    '    END {',
    '      if (destination == "") destination="-"',
    '      if (gateway == "") gateway="-"',
    '      if (interfaceName == "") interfaceName="-"',
    '      if (source == "") source="-"',
    '      printf "%s %s %s %s", destination, gateway, interfaceName, source',
    '    }',
    "  '",
    '}'
  ];
}

function darwinLaunchDaemonPlist(assets: DarwinLaunchDaemonAssets): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xmlEscape(assets.label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>/bin/sh</string>',
    `    <string>${xmlEscape(assets.daemonScriptPath)}</string>`,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>ThrottleInterval</key>',
    '  <integer>5</integer>',
    '  <key>StandardOutPath</key>',
    `  <string>${xmlEscape(assets.launchdStdoutPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xmlEscape(assets.launchdStderrPath)}</string>`,
    '</dict>',
    '</plist>',
    ''
  ].join('\n');
}

function heredocWriteCommand(path: string, content: string): string {
  const marker = `__HDO_${Math.random().toString(36).slice(2).toUpperCase()}__`;
  return `cat > ${shellQuote(path)} <<'${marker}'\n${content}${content.endsWith('\n') ? '' : '\n'}${marker}`;
}

function sanitizeLaunchDaemonComponent(value: string): string {
  return value.replace(/[^A-Za-z0-9.-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'hdo-client';
}

function xmlEscape(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function darwinRouteInstallCidrs(allowedIps: string[], priorityCidrs: string[] = []): string[] {
  return uniqueStrings([
    ...darwinCriticalHdoRouteCidrs(allowedIps, priorityCidrs),
    ...allowedIps.map((cidr) => normalizeCidr(cidr) ?? cidr)
  ]);
}

function darwinRouteDeleteCommand(cidr: string): string {
  const boundedDelete = (command: string) =>
    `__hdo_route_delete_i=0; while [ "$__hdo_route_delete_i" -lt 4 ] && ${command} >/dev/null 2>&1; do __hdo_route_delete_i=$((__hdo_route_delete_i + 1)); done`;
  const parsed = parseIpv4Cidr(normalizeCidr(cidr) ?? cidr);
  if (parsed) {
    const cidrValue = shellQuote(`${intToIpv4(parsed.network)}/${parsed.prefix}`);
    const destination = shellQuote(intToIpv4(parsed.network));
    const netmask = shellQuote(prefixToIpv4Mask(parsed.prefix));
    return [
      boundedDelete(`route -q -n delete -net ${cidrValue}`),
      boundedDelete(`route -q -n delete -net ${destination} -netmask ${netmask}`)
    ].join('\n');
  }
  const family = cidr.includes(':') ? '-inet6 -net' : '-net';
  return boundedDelete(`route -q -n delete ${family} ${shellQuote(cidr)}`);
}

function darwinRouteInstallCommand(cidr: string, interfaceArg: string): string {
  const parsed = parseIpv4Cidr(normalizeCidr(cidr) ?? cidr);
  if (parsed) {
    const cidrValue = shellQuote(`${intToIpv4(parsed.network)}/${parsed.prefix}`);
    const destination = shellQuote(intToIpv4(parsed.network));
    const netmask = shellQuote(prefixToIpv4Mask(parsed.prefix));
    return [
      `route -q -n add -net ${cidrValue} -interface ${interfaceArg}`,
      `route -q -n change -net ${cidrValue} -interface ${interfaceArg}`,
      `route -q -n add -net ${destination} -netmask ${netmask} -interface ${interfaceArg}`,
      `route -q -n change -net ${destination} -netmask ${netmask} -interface ${interfaceArg}`,
      'true'
    ].join(' || ');
  }
  const family = cidr.includes(':') ? '-inet6 -net' : '-net';
  return `route -q -n add ${family} ${shellQuote(cidr)} -interface ${interfaceArg} || route -q -n change ${family} ${shellQuote(cidr)} -interface ${interfaceArg} || true`;
}

function darwinRouteEnsureCommand(cidr: string, interfaceArg: string): string {
  const check = darwinRouteInterfaceCheckCommand(cidr, interfaceArg);
  if (!check) return 'true';
  return `${check} || (\n${darwinRouteDeleteCommand(cidr)}\n${darwinRouteInstallCommand(cidr, interfaceArg)}\n${check} || true\n)`;
}

function darwinRouteProbeLogCommand(cidr: string, interfaceArg: string, logArg: string): string {
  const target = darwinRouteProbeTarget(cidr);
  if (!target) return 'true';
  return `{ echo ${shellQuote(`route=${normalizeCidr(cidr) ?? cidr}`)}; echo ${shellQuote(`target=${target}`)}; echo ${shellQuote('expected=')}${interfaceArg}; route -n get ${shellQuote(target)} 2>&1; } >> ${logArg} 2>&1`;
}

function darwinUserspaceInterfaceAddressInstallCommand(address: string): string {
  if (address.includes(':')) return `ifconfig "$REAL_INTERFACE" inet6 ${shellQuote(address)} alias`;
  const ip = address.split('/')[0] ?? address;
  if (!isIpv4(ip)) return 'true';
  return `ifconfig "$REAL_INTERFACE" inet ${shellQuote(ip)} ${shellQuote(ip)} alias >/dev/null 2>&1 || ifconfig "$REAL_INTERFACE" inet ${shellQuote(ip)} alias >/dev/null 2>&1 || true`;
}

function darwinSelfRouteInstallCommand(ip: string): string {
  const quotedIp = shellQuote(ip);
  const quotedCidr = shellQuote(`${ip}/32`);
  return [
    `ifconfig lo0 alias ${quotedCidr} >/dev/null 2>&1 || ifconfig lo0 alias ${quotedIp} >/dev/null 2>&1 || true`,
    `route -q -n delete -host ${quotedIp} >/dev/null 2>&1 || true`,
    `route -q -n add -host ${quotedIp} 127.0.0.1 || route -q -n change -host ${quotedIp} 127.0.0.1 || route -q -n add -host ${quotedIp} -interface lo0 || route -q -n change -host ${quotedIp} -interface lo0 || true`
  ].join('\n');
}

function darwinSelfRouteDeleteCommand(ip: string): string {
  const quotedIp = shellQuote(ip);
  return [
    `route -q -n delete -host ${quotedIp} >/dev/null 2>&1 || true`,
    `ifconfig lo0 -alias ${quotedIp} >/dev/null 2>&1 || true`
  ].join('\n');
}

function darwinSelfRouteProbeLogCommand(ip: string, logArg: string): string {
  return `{ echo ${shellQuote(`selfRoute=${ip}`)}; echo ${shellQuote('expected=lo0')}; route -n get ${shellQuote(ip)} 2>&1; } >> ${logArg} 2>&1`;
}

function darwinUserspaceAnchorIp(interfaceName: string, selfIps: string[]): string {
  const seed = `${interfaceName}:${selfIps.join(',')}`;
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const third = 64 + (hash % 128);
  const fourth = 1 + ((hash >>> 8) % 254);
  return `169.254.${third}.${fourth}`;
}

function darwinUserspaceAnchorInstallCommand(ip: string): string {
  const quotedIp = shellQuote(ip);
  return [
    `ifconfig "$REAL_INTERFACE" inet ${quotedIp} ${quotedIp} alias >/dev/null 2>&1 || ifconfig "$REAL_INTERFACE" inet ${quotedIp} alias >/dev/null 2>&1 || true`,
    `{ echo ${shellQuote(`utunAnchor=${ip}`)}; ifconfig "$REAL_INTERFACE" 2>&1; } >> "$ROUTE_LOG" 2>&1`
  ].join('\n');
}

function darwinUserspaceAnchorDeleteCommand(ip: string): string {
  const quotedIp = shellQuote(ip);
  return `ifconfig "$REAL_INTERFACE" inet ${quotedIp} ${quotedIp} -alias >/dev/null 2>&1 || ifconfig "$REAL_INTERFACE" inet ${quotedIp} -alias >/dev/null 2>&1 || true`;
}

function darwinEndpointBypassCommands(endpointHosts: string[], logArg: string): string[] {
  const hosts = uniqueStrings(endpointHosts.filter((host) => isIpv4(host) || /^[a-zA-Z0-9.-]+$/.test(host)));
  if (hosts.length === 0) return [];
  return [
    "__hdo_endpoint_path=\"$(/usr/sbin/netstat -rn -f inet 2>/dev/null | awk '$1 == \"default\" && $2 ~ /^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$/ && $2 !~ /^198\\.(18|19)\\./ && $4 !~ /^(utun|lo)[0-9]*$/ { print $2, $4; exit }')\"",
    'set -- $__hdo_endpoint_path',
    '__hdo_endpoint_gateway="${1:-}"',
    '__hdo_endpoint_interface="${2:-}"',
    "__hdo_endpoint_source=\"$(/sbin/ifconfig \"$__hdo_endpoint_interface\" 2>/dev/null | awk '/^[[:space:]]*inet[[:space:]]/ { print $2; exit }')\"",
    '__hdo_bypass_applied_ips=""',
    'if [ -n "$__hdo_endpoint_gateway" ] && [ -n "$__hdo_endpoint_interface" ]; then',
    `  for __hdo_endpoint_host in ${hosts.map(shellQuote).join(' ')}; do`,
    '    case "$__hdo_endpoint_host" in',
    '      *[!0-9.]*|"")',
    '        __hdo_endpoint_ips="$(dscacheutil -q host -a name "$__hdo_endpoint_host" 2>/dev/null | awk \'/^ip_address: [0-9]/{print $2}\' | sort -u)"',
    '        if [ -z "$__hdo_endpoint_ips" ] && command -v dig >/dev/null 2>&1; then __hdo_endpoint_ips="$(dig +short A "$__hdo_endpoint_host" 2>/dev/null | awk \'/^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$/{print}\' | sort -u)"; fi',
    '        ;;',
    '      *)',
    '        __hdo_endpoint_ips="$__hdo_endpoint_host"',
    '        ;;',
    '    esac',
    `    { echo "endpointBypass=$__hdo_endpoint_host"; echo "endpointIps=$__hdo_endpoint_ips"; echo "gateway=$__hdo_endpoint_gateway"; echo "defaultInterface=$__hdo_endpoint_interface"; echo "defaultSource=$__hdo_endpoint_source"; } >> ${logArg} 2>&1`,
    '    for __hdo_endpoint_ip in $__hdo_endpoint_ips; do',
    '      route -q -n delete -host "$__hdo_endpoint_ip" >/dev/null 2>&1 || true',
    '      route -q -n add -host "$__hdo_endpoint_ip" "$__hdo_endpoint_gateway" >/dev/null 2>&1 || route -q -n change -host "$__hdo_endpoint_ip" "$__hdo_endpoint_gateway" >/dev/null 2>&1 || true',
    '      __hdo_bypass_applied_ips="$__hdo_bypass_applied_ips $__hdo_endpoint_ip"',
    `      route -n get "$__hdo_endpoint_ip" >> ${logArg} 2>&1 || true`,
    '    done',
    '  done',
    'else',
    `  echo "endpointBypass=skipped no default gateway" >> ${logArg} 2>&1`,
    'fi'
  ];
}

function darwinEndpointBypassCleanupCommands(endpointHosts: string[], logArg: string): string[] {
  const hosts = uniqueStrings(endpointHosts.filter((host) => isIpv4(host) || /^[a-zA-Z0-9.-]+$/.test(host)));
  if (hosts.length === 0) return [];
  return [
    `for __hdo_endpoint_host in ${hosts.map(shellQuote).join(' ')}; do`,
    '  case "$__hdo_endpoint_host" in',
    '    *[!0-9.]*|"")',
    '      __hdo_endpoint_ips="$(dscacheutil -q host -a name "$__hdo_endpoint_host" 2>/dev/null | awk \'/^ip_address: [0-9]/{print $2}\' | sort -u)"',
    '      if [ -z "$__hdo_endpoint_ips" ] && command -v dig >/dev/null 2>&1; then __hdo_endpoint_ips="$(dig +short A "$__hdo_endpoint_host" 2>/dev/null | awk \'/^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$/{print}\' | sort -u)"; fi',
    '      ;;',
    '    *)',
    '      __hdo_endpoint_ips="$__hdo_endpoint_host"',
    '      ;;',
    '  esac',
    `  { echo "endpointBypassCleanup=$__hdo_endpoint_host"; echo "endpointIps=$__hdo_endpoint_ips"; } >> ${logArg} 2>&1`,
    '  for __hdo_endpoint_ip in $__hdo_endpoint_ips; do',
    `    route -n get "$__hdo_endpoint_ip" >> ${logArg} 2>&1 || true`,
    '    route -q -n delete -host "$__hdo_endpoint_ip" >/dev/null 2>&1 || true',
    '  done',
    'done'
  ];
}

function darwinDnsSetCommands(dnsServers: string[], dnsDomains: string[], statePathArg: string, logArg: string): string[] {
  const servers = uniqueStrings(dnsServers.filter((value) => Boolean(value.trim())));
  if (servers.length === 0) return [];
  const domains = uniqueStrings(dnsDomains.map(normalizeDnsDomain).filter(isString));
  if (domains.length > 0) {
    return darwinDnsResolverSetCommands(servers, domains, statePathArg, logArg);
  }
  return [
    `HDO_DNS_SERVERS=${shellQuote(servers.join(' '))}`,
    `DNS_STATE_FILE=${statePathArg}`,
    `DNS_LOG=${logArg}`,
    'dns_join_lines() { awk \'BEGIN{out=""; bad=0} {if ($0 ~ / / || $0 == "") {bad=1; print "Empty"; exit} if (out != "") out = out ","; out = out $0} END{if (!bad) {if (out == "") print "Empty"; else print out}}\'; }',
    'mkdir -p "$(dirname "$DNS_STATE_FILE")" >/dev/null 2>&1 || true',
    ': > "$DNS_STATE_FILE"',
    'networksetup -listallnetworkservices 2>/dev/null | tail -n +2 | while IFS= read -r service; do',
    '  case "$service" in \\**) service="${service#\\*}" ;; esac',
    '  [ -n "$service" ] || continue',
    '  old_dns="$(networksetup -getdnsservers "$service" 2>/dev/null | dns_join_lines || printf Empty)"',
    '  old_search="$(networksetup -getsearchdomains "$service" 2>/dev/null | dns_join_lines || printf Empty)"',
    '  printf "%s\\t%s\\t%s\\n" "$service" "$old_dns" "$old_search" >> "$DNS_STATE_FILE"',
    '  effective_dns="$HDO_DNS_SERVERS"',
    '  if [ -n "$old_dns" ] && [ "$old_dns" != "Empty" ]; then',
    '    for old_dns_server in $(printf "%s" "$old_dns" | tr "," " "); do',
    '      case " $effective_dns " in *" $old_dns_server "*) ;; *) effective_dns="$effective_dns $old_dns_server" ;; esac',
    '    done',
    '  fi',
    '  echo "dnsSet service=$service servers=$effective_dns" >> "$DNS_LOG" 2>&1 || true',
    '  # shellcheck disable=SC2086',
    '  networksetup -setdnsservers "$service" $effective_dns >> "$DNS_LOG" 2>&1 || true',
    '  networksetup -setsearchdomains "$service" Empty >> "$DNS_LOG" 2>&1 || true',
    'done'
  ];
}

function darwinDnsResolverSetCommands(
  dnsServers: string[],
  dnsDomains: string[],
  statePathArg: string,
  logArg: string
): string[] {
  return [
    `HDO_DNS_SERVERS=${shellQuote(dnsServers.join(' '))}`,
    `HDO_DNS_DOMAINS=${shellQuote(dnsDomains.join(' '))}`,
    `DNS_STATE_FILE=${statePathArg}`,
    `DNS_LOG=${logArg}`,
    'mkdir -p "$(dirname "$DNS_STATE_FILE")" /etc/resolver >/dev/null 2>&1 || true',
    ': > "$DNS_STATE_FILE"',
    'for domain in $HDO_DNS_DOMAINS; do',
    '  [ -n "$domain" ] || continue',
    '  target="/etc/resolver/$domain"',
    '  safe_domain="$(printf "%s" "$domain" | tr -c "A-Za-z0-9._-" "_")"',
    '  backup="$DNS_STATE_FILE.resolver.$safe_domain.bak"',
    '  if [ -f "$target" ]; then',
    '    cp "$target" "$backup" >/dev/null 2>&1 || true',
    '    existed=1',
    '  else',
    '    rm -f "$backup" >/dev/null 2>&1 || true',
    '    existed=0',
    '  fi',
    '  printf "resolver\\t%s\\t%s\\t%s\\n" "$domain" "$backup" "$existed" >> "$DNS_STATE_FILE"',
    '  {',
    '    echo "# Generated by HDO; removed when HDO disconnects."',
    '    resolver_port=""',
    '    for dns_server in $HDO_DNS_SERVERS; do',
    '      dns_host="$dns_server"',
    '      dns_port=""',
    '      case "$dns_server" in',
    '        *:*)',
    '          dns_host="${dns_server%:*}"',
    '          dns_port="${dns_server##*:}"',
    '          case "$dns_host" in ""|*[!0-9.]*) dns_host="$dns_server"; dns_port="" ;; esac',
    '          case "$dns_port" in ""|*[!0-9]*) dns_port="" ;; esac',
    '          ;;',
    '      esac',
    '      echo "nameserver $dns_host"',
    '      if [ -n "$dns_port" ]; then',
    '        if [ -z "$resolver_port" ]; then resolver_port="$dns_port"; elif [ "$resolver_port" != "$dns_port" ]; then echo "dnsResolverPortMismatch domain=$domain first=$resolver_port ignored=$dns_port" >> "$DNS_LOG" 2>&1 || true; fi',
    '      fi',
    '    done',
    '    if [ -n "$resolver_port" ]; then echo "port $resolver_port"; fi',
    '    echo "timeout 2"',
    '  } > "$target"',
    '  chmod 644 "$target" >/dev/null 2>&1 || true',
    '  echo "dnsResolverSet domain=$domain servers=$HDO_DNS_SERVERS" >> "$DNS_LOG" 2>&1 || true',
    'done'
  ];
}

function darwinDnsRestoreCommands(statePathArg: string, logArg: string): string[] {
  return [
    `DNS_STATE_FILE=${statePathArg}`,
    `DNS_LOG=${logArg}`,
    '[ -f "$DNS_STATE_FILE" ] || true',
    'if [ -f "$DNS_STATE_FILE" ]; then',
    '  restore_service_dns() {',
    '    [ -n "$service" ] || return 0',
    '    if [ -z "$dns_csv" ] || [ "$dns_csv" = "Empty" ]; then',
    '      networksetup -setdnsservers "$service" Empty >> "$DNS_LOG" 2>&1 || true',
    '    else',
    '      dns_args="$(printf "%s" "$dns_csv" | tr "," " ")"',
    '      # shellcheck disable=SC2086',
    '      networksetup -setdnsservers "$service" $dns_args >> "$DNS_LOG" 2>&1 || true',
    '    fi',
    '    if [ -z "$search_csv" ] || [ "$search_csv" = "Empty" ]; then',
    '      networksetup -setsearchdomains "$service" Empty >> "$DNS_LOG" 2>&1 || true',
    '    else',
    '      search_args="$(printf "%s" "$search_csv" | tr "," " ")"',
    '      # shellcheck disable=SC2086',
    '      networksetup -setsearchdomains "$service" $search_args >> "$DNS_LOG" 2>&1 || true',
    '    fi',
    '  }',
    '  while IFS="$(printf \'\\t\')" read -r kind first second third; do',
    '    [ -n "$kind" ] || continue',
    '    if [ "$kind" = "resolver" ]; then',
    '      domain="$first"',
    '      backup="$second"',
    '      existed="$third"',
    '      [ -n "$domain" ] || continue',
    '      target="/etc/resolver/$domain"',
    '      if [ "$existed" = "1" ] && [ -f "$backup" ]; then',
    '        cp "$backup" "$target" >> "$DNS_LOG" 2>&1 || true',
    '      else',
    '        rm -f "$target" >> "$DNS_LOG" 2>&1 || true',
    '      fi',
    '      rm -f "$backup" >> "$DNS_LOG" 2>&1 || true',
    '      echo "dnsResolverRestore domain=$domain existed=$existed" >> "$DNS_LOG" 2>&1 || true',
    '      continue',
    '    fi',
    '    if [ "$kind" = "service" ]; then',
    '      service="$first"',
    '      dns_csv="$second"',
    '      search_csv="$third"',
    '    else',
    '      service="$kind"',
    '      dns_csv="$first"',
    '      search_csv="$second"',
    '    fi',
    '    restore_service_dns',
    '  done < "$DNS_STATE_FILE"',
    '  rm -f "$DNS_STATE_FILE"',
    'fi'
  ];
}

function darwinWgQuickShellCommand(
  configPath: string,
  action: WireGuardTunnelAction,
  env: Record<string, string>,
  wgQuick: string
): string {
  const profile = parseWireGuardProfile(configPath);
  const envPrefix = Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ');
  const wgQuickCommand = [envPrefix, shellQuote(wgQuick)].filter(Boolean).join(' ');
  if (action === 'down') {
    return [
      'set +e',
      ...darwinRouteLogSetupLines(configPath, profile.interfaceName, 'wg-quick-down'),
      [wgQuickCommand, 'down', shellQuote(configPath)].join(' '),
      '__hdo_wg_quick_status=$?',
      ...darwinEndpointBypassCleanupCommands(profile.endpointHosts, '"$ROUTE_LOG"'),
      'exit "$__hdo_wg_quick_status"'
    ].join('\n');
  }
  const upCommand = [wgQuickCommand, 'up', shellQuote(configPath)].join(' ');
  const lines = [
    'set -e',
    ...darwinRouteLogSetupLines(configPath, profile.interfaceName, action === 'restart' ? 'wg-quick-restart' : 'wg-quick-up')
  ];
  if (action === 'restart') {
    lines.push([wgQuickCommand, 'down', shellQuote(configPath), '>/dev/null 2>&1 || true'].join(' '));
  }
  lines.push(
    ...darwinEndpointBypassCommands(profile.endpointHosts, '"$ROUTE_LOG"'),
    upCommand
  );
  return lines.join('\n');
}

function darwinRouteInterfaceCheckCommand(cidr: string, interfaceArg: string): string | null {
  const target = darwinRouteProbeTarget(cidr);
  if (!target) return null;
  return [
    `route -n get ${shellQuote(target)} 2>/dev/null`,
    `awk -v expected=${interfaceArg} '/interface:/{if ($2 == expected) found=1} END{exit found?0:1}'`
  ].join(' | ');
}

function darwinRouteProbeTarget(cidr: string): string | null {
  return selectDarwinWireGuardRouteProbeTarget(cidr);
}

export function selectDarwinWireGuardRouteProbeTarget(
  cidr: string,
  interfaceAddresses: string[] = []
): string | null {
  const parsed = parseIpv4Cidr(normalizeCidr(cidr) ?? cidr);
  if (!parsed) return null;
  const firstOffset = parsed.prefix >= 31 ? 0 : 1;
  const addressCount = 2 ** (32 - parsed.prefix);
  const lastOffset = parsed.prefix === 32
    ? 0
    : parsed.prefix === 31
      ? 1
      : addressCount - 2;
  const excluded = new Set(interfaceAddresses
    .map((address) => address.split('/')[0] ?? address)
    .filter(isIpv4));
  const fallback = intToIpv4((parsed.network + firstOffset) >>> 0);
  const candidates = Math.min(
    lastOffset - firstOffset + 1,
    excluded.size + 1
  );
  for (let index = 0; index < candidates; index += 1) {
    const target = intToIpv4((parsed.network + firstOffset + index) >>> 0);
    if (!excluded.has(target)) return target;
  }
  return fallback;
}

function darwinRouteLogSetupLines(configPath: string, interfaceName: string, action: string): string[] {
  const routeLogPath = wireGuardRouteLogPath(configPath, interfaceName);
  return [
    `ROUTE_LOG=${shellQuote(routeLogPath)}`,
    `mkdir -p ${shellQuote(dirname(routeLogPath))}`,
    `touch "$ROUTE_LOG"`,
    `chmod 644 "$ROUTE_LOG" >/dev/null 2>&1 || true`,
    `trap 'code=$?; echo "exit=$code" >> "$ROUTE_LOG" 2>&1; exit $code' EXIT`,
    `{ echo ${shellQuote('---')}; echo ${shellQuote(`action=${action}`)}; echo "timestamp=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"; echo ${shellQuote(`config=${configPath}`)}; } >> "$ROUTE_LOG" 2>&1`
  ];
}

function darwinStaleUserspaceInterfaceCleanupLines(
  routeDownCommands: string[],
  primaryAddress: string
): string[] {
  const addressPattern = darwinStaleInterfaceAddressAwkPattern(primaryAddress);
  return [
    'for candidate in $(ifconfig -l 2>/dev/null); do',
    '  case "$candidate" in utun*) ;; *) continue ;; esac',
    '  candidate_state="$(ifconfig "$candidate" 2>/dev/null || true)"',
    `  printf '%s\\n' "$candidate_state" | awk '${addressPattern} {found=1} END{exit found?0:1}' >/dev/null 2>&1 || continue`,
    ...routeDownCommands.map((line) => `  ${line.replaceAll('"$REAL_INTERFACE"', '"$candidate"')}`),
    `  for hdo_ip in $(printf '%s\\n' "$candidate_state" | awk '${addressPattern} {print $2}'); do ifconfig "$candidate" inet "$hdo_ip" "$hdo_ip" -alias >/dev/null 2>&1 || ifconfig "$candidate" inet "$hdo_ip" -alias >/dev/null 2>&1 || true; done`,
    '  ifconfig "$candidate" down >/dev/null 2>&1 || true',
    '  rm -f "/var/run/wireguard/$candidate.sock"',
    'done'
  ];
}

function darwinStaleInterfaceAddressAwkPattern(primaryAddress: string): string {
  const patterns = isIpv4(primaryAddress)
    ? [`inet ${escapeAwkRegex(primaryAddress)}([[:space:]]|$)`]
    : [];
  if (patterns.length === 0) return '/MX_WIREGUARD_NO_STALE_INTERFACE_MATCH/';
  return `/${patterns.join('|')}/`;
}

function escapeAwkRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function darwinRouteProbeResults(
  allowedIps: string[],
  expectedInterface: string,
  priorityCidrs: string[] = [],
  interfaceAddresses: string[] = []
): WireGuardRouteProbeStatus[] {
  return darwinRequiredHealthyRouteCidrs(allowedIps, priorityCidrs)
    .map((cidr) => normalizeCidr(cidr) ?? cidr)
    .filter((cidr) => cidr.includes('/'))
    .flatMap((cidr): WireGuardRouteProbeStatus[] => {
      const target = selectDarwinWireGuardRouteProbeTarget(cidr, interfaceAddresses);
      if (!target) {
        return [];
      }
      const result = tryExecFile('route', ['-n', 'get', target]);
      const raw = (result.stdout || result.stderr).trim();
      const actualInterface = routeGetInterface(raw);
      return [{
        cidr,
        target,
        expectedInterface,
        actualInterface,
        ok: result.ok && actualInterface === expectedInterface,
        raw: raw || null,
        error: result.ok ? null : result.error || result.stderr.trim() || null
      }];
    });
}

function routeGetInterface(raw: string): string | null {
  const match = raw.match(/^\s*interface:\s*(\S+)/m);
  return match?.[1] ?? null;
}

function wireGuardRouteLogPath(configPath: string, interfaceName: string): string {
  return join(dirname(configPath), `${interfaceName}.route.log`);
}

function wireGuardRouteLogPathFromConfig(configPath: string): string | null {
  try {
    const profile = parseWireGuardProfile(configPath);
    return wireGuardRouteLogPath(configPath, profile.interfaceName);
  } catch {
    return wireGuardRouteLogPath(configPath, wireGuardInterfaceName(configPath));
  }
}

function readTextTail(path: string | null, maxBytes = 12000): string | null {
  if (!path || !existsSync(path)) return null;
  try {
    const raw = readFileSync(path);
    return raw.subarray(Math.max(0, raw.length - maxBytes)).toString('utf8');
  } catch {
    return null;
  }
}

function darwinCriticalHdoRouteCidrs(allowedIps: string[], priorityCidrs: string[] = []): string[] {
  const normalizedAllowed = allowedIps
    .map((cidr) => normalizeCidr(cidr) ?? cidr)
    .filter((cidr) => cidr.includes('/'));
  if (normalizedAllowed.length === 0) return [];

  // macOS and Clash/Mihomo TUN routing use longest-prefix wins. Expand overlay
  // /16s into a bounded set of /20 routes and add explicit /32 control-plane
  // targets so V2 routes stay on WireGuard even when another TUN owns 10.x/16.
  const dynamicPriorityCidrs = normalizedAllowed.flatMap((cidr) =>
    priorityIpv4CidrsAtPrefix(cidr, DARWIN_HDO_PRIORITY_ROUTE_PREFIX)
  );
  const explicitPriorityCidrs = priorityCidrs
    .map((cidr) => normalizeCidr(cidr) ?? cidr)
    .filter((cidr) => cidr.includes('/'))
    .filter((cidr) => normalizedAllowed.some((allowedCidr) => cidrContains(allowedCidr, cidr)));
  return uniqueStrings([...dynamicPriorityCidrs, ...explicitPriorityCidrs]);
}

function darwinRequiredHealthyRouteCidrs(allowedIps: string[], priorityCidrs: string[] = []): string[] {
  const criticalCidrs = darwinCriticalHdoRouteCidrs(allowedIps, priorityCidrs);
  const normalizedAllowed = allowedIps
    .map((cidr) => normalizeCidr(cidr) ?? cidr)
    .filter((cidr) => cidr.includes('/'));
  return uniqueStrings([
    ...normalizedAllowed.filter((allowedCidr) =>
      !criticalCidrs.some((priorityCidr) => cidrContains(allowedCidr, priorityCidr))
    ),
    ...criticalCidrs
  ]);
}

function darwinStalePriorityRouteCidrs(allowedIps: string[]): string[] {
  const hdoRanges = HDO_MESH_ROUTE_CIDRS
    .map((value) => cidrRange(value))
    .filter((range): range is { start: number; end: number } => Boolean(range));
  return uniqueStrings(allowedIps.flatMap((cidr) => {
    const parsed = parseIpv4Cidr(normalizeCidr(cidr) ?? cidr);
    const range = parsed ? cidrRange(`${intToIpv4(parsed.network)}/${parsed.prefix}`) : null;
    if (!parsed || !range || parsed.prefix < 8 || parsed.prefix >= 31 || !rangeOverlapsAny(range, hdoRanges)) {
      return [];
    }
    const childPrefix = parsed.prefix + 1;
    const childSize = 2 ** (32 - childPrefix);
    return [
      `${intToIpv4(parsed.network)}/${childPrefix}`,
      `${intToIpv4((parsed.network + childSize) >>> 0)}/${childPrefix}`
    ];
  }));
}

function parseWireGuardProfile(configPath: string): {
  interfaceName: string;
  addresses: string[];
  allowedIps: string[];
  routePriorityCidrs: string[];
  dnsServers: string[];
  dnsDomains: string[];
  endpointHosts: string[];
  setConfigLines: string[];
} {
  const raw = readFileSync(configPath, 'utf8');
  const interfaceName = wireGuardInterfaceName(configPath);
  const addresses: string[] = [];
  const allowedIps: string[] = [];
  const routePriorityCidrs: string[] = [];
  const dnsServers: string[] = [];
  const dnsDomains: string[] = [];
  const endpoints: string[] = [];
  const setConfigLines: string[] = [];
  let section = '';
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    const sectionMatch = trimmed.match(/^\[(.+)]$/);
    if (sectionMatch) section = sectionMatch[1].toLowerCase();
    const key = trimmed.split('=', 1)[0]?.trim().toLowerCase();
    if (section === 'interface' && key === 'address') {
      addresses.push(...valueList(line));
      continue;
    }
    if (section === 'interface' && key === 'dns') {
      dnsServers.push(...valueList(line));
      continue;
    }
    if (section === 'interface' && /^#\s*HDO\s+DNS\s+Servers\s*=/i.test(trimmed)) {
      dnsServers.push(...valueList(line));
      continue;
    }
    if (section === 'interface' && /^#\s*HDO\s+DNS\s+Domains\s*=/i.test(trimmed)) {
      dnsDomains.push(...valueList(line).map(normalizeDnsDomain).filter(isString));
      continue;
    }
    if (section === 'interface' && /^#\s*HDO\s+Route\s+Priority\s+CIDRs\s*=/i.test(trimmed)) {
      routePriorityCidrs.push(...valueList(line).map((cidr) => normalizeCidr(cidr) ?? cidr));
      continue;
    }
    if (section === 'peer' && key === 'allowedips') {
      allowedIps.push(...valueList(line));
    }
    if (section === 'peer' && key === 'endpoint') {
      endpoints.push(...valueList(line));
    }
    if (section === 'interface' && ['address', 'dns', 'mtu', 'table', 'preup', 'predown', 'postup', 'postdown', 'saveconfig'].includes(key)) {
      continue;
    }
    setConfigLines.push(line);
  }
  if (addresses.length === 0) throw new Error('WireGuard config missing Interface Address');
  if (allowedIps.length === 0) throw new Error('WireGuard config missing Peer AllowedIPs');
  return {
    interfaceName,
    addresses,
    allowedIps: uniqueStrings(allowedIps),
    routePriorityCidrs: uniqueStrings(routePriorityCidrs),
    dnsServers: uniqueStrings(dnsServers),
    dnsDomains: uniqueStrings(dnsDomains),
    endpointHosts: uniqueStrings(endpoints.map(wireGuardEndpointHost).filter(isString)),
    setConfigLines
  };
}

function wireGuardInterfaceName(configPath: string): string {
  const name = basename(configPath).replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_=+.-]/g, '-').slice(0, 15);
  return name || 'hdo';
}

function valueList(line: string): string[] {
  return line
    .replace(/^[^=]+=/, '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function wireGuardEndpointHost(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('[')) return null;
  const colonIndex = trimmed.lastIndexOf(':');
  const host = colonIndex >= 0 ? trimmed.slice(0, colonIndex) : trimmed;
  if (isIpv4(host)) return host;
  if (/^[a-zA-Z0-9.-]+$/.test(host) && host.includes('.')) return host;
  return null;
}

function resolveWireGuardRealInterface(
  runtime: WireGuardConnectionRuntimeStatus,
  interfaceName: string,
  addresses: string[] = []
): string | null {
  if (runtime.platform === 'darwin') {
    const nameFile = `/var/run/wireguard/${interfaceName}.name`;
    try {
      if (existsSync(nameFile)) {
        const value = readFileSync(nameFile, 'utf8').trim();
        const state = value ? readInterfaceState(value) : null;
        if (value && state && interfaceStateIsUp(state) && interfaceHasAnyConfiguredAddress(value, addresses)) {
          return value;
        }
      }
    } catch {
      // Older launches wrote this file as root-only; discover the utun by address instead.
    }
    return findDarwinInterfaceByAddress(addresses);
  }
  return interfaceName;
}

function interfaceHasAnyConfiguredAddress(interfaceName: string, addresses: string[]): boolean {
  const ips = addresses
    .map((address) => address.split('/')[0])
    .filter((address) => Boolean(address && !address.includes(':')));
  if (ips.length === 0) return true;
  const state = readInterfaceState(interfaceName);
  return Boolean(state && interfaceStateIsUp(state) && ips.some((ip) => state.includes(`inet ${ip}`)));
}

function findDarwinInterfaceByAddress(addresses: string[]): string | null {
  const ips = addresses
    .map((address) => address.split('/')[0])
    .filter((address) => Boolean(address && !address.includes(':')));
  if (ips.length === 0) return null;

  const raw = safeExecFile('ifconfig', ['-l']);
  if (!raw) return null;
  const matches = raw
    .split(/\s+/)
    .filter((name) => isWireGuardLikeInterface(name))
    .filter((name) => {
      const state = readInterfaceState(name);
      return Boolean(state && interfaceStateIsUp(state) && ips.some((ip) => state.includes(`inet ${ip}`)));
    });
  if (matches.length === 0) return null;
  return matches.sort((a, b) => detectInterfaceRoutes(b).length - detectInterfaceRoutes(a).length)[0] ?? null;
}

function interfaceStateIsUp(state: string): boolean {
  const firstLine = state.split(/\r?\n/, 1)[0] ?? '';
  const flags = firstLine.match(/<([^>]+)>/)?.[1] ?? '';
  return flags.split(',').includes('UP');
}

function shouldSkipWireGuardDump(runtime: WireGuardConnectionRuntimeStatus): boolean {
  return runtime.platform === 'darwin'
    && runtime.method === 'darwin-userspace'
    && typeof process.getuid === 'function'
    && process.getuid() !== 0;
}

function parseWireGuardDump(raw: string): WireGuardPeerRuntimeStatus[] {
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const nowSeconds = Math.floor(Date.now() / 1000);
  return lines.slice(1).map((line) => {
    const columns = line.split('\t');
    const latestHandshakeSeconds = numberOrNull(columns[4]);
    return {
      publicKey: columns[0] ?? '',
      endpoint: emptyToNull(columns[2]),
      allowedIps: (columns[3] ?? '').split(',').map((item) => item.trim()).filter(Boolean),
      latestHandshakeAt:
        latestHandshakeSeconds && latestHandshakeSeconds > 0
          ? new Date(latestHandshakeSeconds * 1000).toISOString()
          : null,
      latestHandshakeSeconds:
        latestHandshakeSeconds && latestHandshakeSeconds > 0
          ? Math.max(0, nowSeconds - latestHandshakeSeconds)
          : null,
      transferRxBytes: numberOrNull(columns[5]) ?? 0,
      transferTxBytes: numberOrNull(columns[6]) ?? 0,
      persistentKeepalive: numberOrNull(columns[7])
    };
  }).filter((peer) => Boolean(peer.publicKey));
}

function detectInterfaceRoutes(interfaceName: string): string[] {
  if (process.platform === 'darwin') {
    const raw = safeExecFile('netstat', ['-rn', '-f', 'inet']);
    if (!raw) return [];
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.endsWith(` ${interfaceName}`) || line.includes(` ${interfaceName} `));
  }
  if (process.platform === 'linux') {
    const raw = safeExecFile('ip', ['route', 'show', 'dev', interfaceName]);
    return raw ? raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
  }
  return [];
}

function missingInterfaceRoutes(
  runtime: WireGuardConnectionRuntimeStatus,
  allowedIps: string[],
  routes: string[],
  priorityCidrs: string[] = []
): string[] {
  if (runtime.platform !== 'darwin') return [];
  const routeCidrs = routes
    .map((line) => routeDestinationToCidr(line.trim().split(/\s+/)[0]))
    .filter(isString);
  const requiredCidrs = darwinRequiredHealthyRouteCidrs(allowedIps, priorityCidrs)
    .map((cidr) => normalizeCidr(cidr) ?? cidr)
    .filter((cidr) => cidr.includes('/'));
  return requiredCidrs.filter((required) =>
    !routeCidrs.some((installed) => cidrContains(installed, required))
  );
}

function readInterfaceState(interfaceName: string): string | null {
  if (process.platform === 'win32') return null;
  return safeExecFile('ifconfig', [interfaceName]);
}

const WINDOWS_TUNNEL_SERVICE_PROBE_TIMEOUT_MS = 8000;
const WINDOWS_TUNNEL_INVENTORY_PROBE_TIMEOUT_MS = 12_000;

// The tunnel service state is the decisive liveness signal, and `sc.exe` answers
// it without paying for a PowerShell process at all. Only fall back to
// Get-Service when sc.exe produced nothing we could parse (a localized STATE
// line, or sc.exe itself unavailable).
//
// The distinction between "the service is not running" and "we could not ask"
// is what callers were missing: a failed probe used to be reported as a stopped
// tunnel, and MX-H2I then cleaned up a live one.
function readWindowsTunnelServiceState(interfaceName: string): {
  ok: boolean;
  serviceState: string | null;
  error: string | null;
} {
  const serviceName = `WireGuardTunnel$${interfaceName}`;
  const sc = tryExecFile('sc.exe', ['query', serviceName], WINDOWS_TUNNEL_SERVICE_PROBE_TIMEOUT_MS);
  const scFallback = sc.stdout
    ? sc
    : tryExecFile('sc', ['query', serviceName], WINDOWS_TUNNEL_SERVICE_PROBE_TIMEOUT_MS);
  const match = scFallback.stdout?.match(/STATE\s*:\s*\d+\s+([A-Z_]+)/i);
  if (match?.[1]) return { ok: true, serviceState: match[1].toUpperCase(), error: null };

  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$svc = Get-Service -Name ${powerShellString(serviceName)} -ErrorAction SilentlyContinue`,
    "if ($null -eq $svc) { 'NOT_FOUND' } else { ([string]$svc.Status).ToUpperInvariant() }"
  ].join('\r\n');
  const ps = tryExecFile(windowsPowerShellCommand(), [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script
  ], WINDOWS_TUNNEL_SERVICE_PROBE_TIMEOUT_MS);
  const serviceState = ps.ok ? (nullableText(ps.stdout)?.toUpperCase() ?? null) : null;
  if (serviceState) return { ok: true, serviceState, error: null };
  return {
    ok: false,
    serviceState: null,
    error: ps.stderr.trim()
      || ps.error
      || scFallback.error
      || `Unable to query ${serviceName}`
  };
}

// `Get-NetAdapter -IncludeHidden` plus a `Get-NetRoute` per adapter is far more
// expensive than the service query, and on a machine carrying several tunnel
// stacks it can run for many seconds. Running both in one spawnSync meant a
// slow inventory killed the whole process, and that ETIMEDOUT came back as
// serviceState:null -> active:false, indistinguishable from a genuinely
// stopped tunnel. Keep them separate so the service answer survives.
function readWindowsTunnelInventory(interfaceName: string): {
  ok: boolean;
  adapters: string[];
  routes: string[];
  error: string | null;
} {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$adapters = @(Get-NetAdapter -IncludeHidden -ErrorAction Stop | Where-Object { [string]$_.Name -eq ${powerShellString(interfaceName)} })`,
    '$routes = @($adapters | ForEach-Object {',
    '  $index = [int]$_.InterfaceIndex',
    "  Get-NetRoute -InterfaceIndex $index -ErrorAction Stop | ForEach-Object { ([string]$_.DestinationPrefix) + '|if=' + [string]$_.InterfaceIndex + '|nextHop=' + [string]$_.NextHop }",
    '})',
    '[pscustomobject]@{',
    '  adapters = @($adapters | ForEach-Object { ([string]$_.Name) + \'|if=\' + [string]$_.InterfaceIndex + \'|status=\' + [string]$_.Status })',
    '  routes = $routes',
    '} | ConvertTo-Json -Depth 5 -Compress'
  ].join('\r\n');
  const result = tryExecFile(windowsPowerShellCommand(), [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script
  ], WINDOWS_TUNNEL_INVENTORY_PROBE_TIMEOUT_MS);
  if (!result.ok) {
    return {
      ok: false,
      adapters: [],
      routes: [],
      error: result.stderr.trim() || result.error || `Unable to enumerate ${interfaceName}`
    };
  }
  try {
    const row = JSON.parse(result.stdout) as Record<string, unknown>;
    return {
      ok: true,
      adapters: normalizeWindowsNrptTextList(row.adapters),
      routes: normalizeWindowsNrptTextList(row.routes),
      error: null
    };
  } catch (err) {
    return {
      ok: false,
      adapters: [],
      routes: [],
      error: `Invalid Windows tunnel cleanup probe: ${errorMessage(err)}`
    };
  }
}

function readWindowsTunnelMachineState(interfaceName: string): {
  ok: boolean;
  serviceStateKnown: boolean;
  serviceState: string | null;
  adapters: string[];
  routes: string[];
  error: string | null;
} {
  const service = readWindowsTunnelServiceState(interfaceName);
  const inventory = readWindowsTunnelInventory(interfaceName);
  return {
    // `ok` still means "the whole machine state was read", because teardown
    // readiness checks treat an empty route list as proof of a clean machine.
    ok: service.ok && inventory.ok,
    serviceStateKnown: service.ok,
    serviceState: service.serviceState,
    adapters: inventory.adapters,
    routes: inventory.routes,
    error: [service.error, inventory.error].filter(Boolean).join('; ') || null
  };
}

function routeLooksLikeExistingHdoRoute(
  route: HdoLocalRoute,
  hdoRanges: Array<{ start: number; end: number }>
): boolean {
  const routeRange = cidrRange(route.cidr);
  if (!routeRange) return false;
  if (!rangeOverlapsAny(routeRange, hdoRanges)) return false;

  if (route.source === 'darwin-netstat') {
    return isWireGuardLikeInterface(route.interfaceName) || isWireGuardLikeInterface(route.gateway);
  }

  if (route.source === 'linux-ip-route') {
    return isWireGuardLikeInterface(route.interfaceName);
  }

  if (route.source !== 'windows-route-print') return false;
  const interfaceIp = route.interfaceName ? ipv4ToInt(route.interfaceName) : null;
  if (interfaceIp !== null && hdoRanges.some((range) => interfaceIp >= range.start && interfaceIp <= range.end)) {
    return true;
  }
  const gateway = (route.gateway ?? '').trim().toLowerCase();
  return !gateway || gateway === 'on-link' || gateway === '在链路上' || !isIpv4(gateway);
}

function routeLooksLikeProxyTunCaptureRoute(route: HdoLocalRoute): boolean {
  const range = cidrRange(route.cidr);
  if (!range || !isProxyTunIpv4(route.gateway)) return false;
  const prefix = prefixFromRange(range);
  return prefix !== null && prefix <= 8;
}

function isProxyTunIpv4(value: string | null | undefined): boolean {
  const gateway = value ? ipv4ToInt(value) : null;
  const proxyGatewayStart = ipv4ToInt('198.18.0.0');
  const proxyGatewayEnd = ipv4ToInt('198.19.255.255');
  return gateway !== null
    && proxyGatewayStart !== null
    && proxyGatewayEnd !== null
    && gateway >= proxyGatewayStart
    && gateway <= proxyGatewayEnd;
}

function isWireGuardLikeInterface(value: string | null | undefined): boolean {
  const normalized = (value ?? '').trim().toLowerCase();
  return /^(utun\d+|wg\d*|wg-.+|hdo[-_].*)$/.test(normalized) || normalized.includes('wireguard');
}

function rangeOverlapsAny(
  target: { start: number; end: number },
  ranges: Array<{ start: number; end: number }>
): boolean {
  return ranges.some((range) => target.start <= range.end && range.start <= target.end);
}

function prefixFromRange(range: { start: number; end: number }): number | null {
  const size = range.end - range.start + 1;
  const hostBits = Math.log2(size);
  if (size <= 0 || !Number.isInteger(hostBits)) return null;
  return 32 - hostBits;
}

function safeExecFile(command: string, args: string[]): string | null {
  const result = tryExecFile(command, args);
  return result.ok ? result.stdout.trim() : null;
}

function tryExecFile(
  command: string,
  args: string[],
  timeoutMs = 3000
): { ok: boolean; stdout: string; stderr: string; error?: string } {
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return {
      ok: result.status === 0 && !result.error,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
      error: result.error ? errorMessage(result.error) : undefined
    };
  } catch (err) {
    return { ok: false, stdout: '', stderr: '', error: errorMessage(err) };
  }
}

function numberOrNull(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function emptyToNull(value: string | undefined): string | null {
  if (!value || value === '(none)') return null;
  return value;
}

function resolveWireGuardTool(input: {
  name: WireGuardToolName;
  commandName: string;
  installDir: string;
  bundledDir?: string | null;
  allowSystemFallback?: boolean;
}): WireGuardToolStatus {
  const target = platformArchKey();
  const installedPath = join(input.installDir, input.commandName);
  if (existsSync(installedPath)) {
    const error = validateWireGuardTool(input.name, installedPath);
    if (error) {
      return {
        target,
        name: input.name,
        available: false,
        source: 'installed',
        command: null,
        bundledPath: null,
        installedPath,
        systemPath: null,
        error
      };
    }
    return {
      target,
      name: input.name,
      available: true,
      source: 'installed',
      command: installedPath,
      bundledPath: null,
      installedPath,
      systemPath: null
    };
  }

  const bundledPath = findBundledWireGuardTool(input.name, input.bundledDir ?? null);
  if (bundledPath) {
    try {
      const command = installBundledWireGuardTool(bundledPath, input.installDir, input.commandName);
      const error = validateWireGuardTool(input.name, command);
      if (error) {
        return {
          target,
          name: input.name,
          available: false,
          source: 'bundled',
          command: null,
          bundledPath,
          installedPath: command,
          systemPath: null,
          error
        };
      }
      return {
        target,
        name: input.name,
        available: true,
        source: 'bundled',
        command,
        bundledPath,
        installedPath: command,
        systemPath: null
      };
    } catch (err) {
      return {
        target,
        name: input.name,
        available: false,
        source: 'missing',
        command: null,
        bundledPath,
        installedPath,
        systemPath: null,
        error: errorMessage(err)
      };
    }
  }

  if (input.allowSystemFallback) {
    const systemPath = findSystemWireGuardTool(input.name, input.commandName);
    if (systemPath) {
      return {
        target,
        name: input.name,
        available: true,
        source: 'system',
        command: systemPath,
        bundledPath: null,
        installedPath: null,
        systemPath
      };
    }
  }

  return {
    target,
    name: input.name,
    available: false,
    source: 'missing',
    command: null,
    bundledPath: null,
    installedPath,
    systemPath: null,
    error: `missing ${input.commandName} for ${target}`
  };
}

function findSystemWireGuardTool(name: WireGuardToolName, commandName: string): string | null {
  for (const candidate of systemToolCandidates(name, commandName)) {
    if (isPathLike(candidate)) {
      if (existsSync(candidate) && !validateWireGuardTool(name, candidate)) return candidate;
      continue;
    }
    const resolved = which(candidate);
    if (resolved && !validateWireGuardTool(name, resolved)) return resolved;
  }
  return null;
}

function validateWireGuardTool(name: WireGuardToolName, command: string): string | null {
  if (name !== 'bash') return null;
  try {
    const raw = execFileSync(command, ['--version'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true
    });
    const match = raw.match(/version\s+(\d+)\./i);
    if (!match || Number(match[1]) < 4) {
      return 'macOS wg-quick requires Bash 4+';
    }
    return null;
  } catch (err) {
    return errorMessage(err);
  }
}

function systemToolCandidates(name: WireGuardToolName, commandName: string): string[] {
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const wireGuardName = name === 'wireguard' ? 'wireguard.exe' : commandName;
    return [
      wireGuardName,
      join(programFiles, 'WireGuard', wireGuardName),
      join(programFilesX86, 'WireGuard', wireGuardName)
    ];
  }
  return [
    commandName,
    join('/opt/homebrew/bin', commandName),
    join('/usr/local/bin', commandName),
    join('/usr/bin', commandName),
    join('/bin', commandName),
    join('/usr/sbin', commandName),
    join('/sbin', commandName)
  ];
}

function which(commandName: string): string | null {
  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which';
    const raw = execFileSync(command, [commandName], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true
    }).trim();
    return raw.split(/\r?\n/).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

function bundledToolNames(name: WireGuardToolName): string[] {
  if (process.platform === 'win32') {
    if (name === 'wireguard') return ['wireguard.exe', 'wireguard.exe.gz'];
    if (name === 'wg') return ['wg.exe', 'wg.exe.gz', 'wg', 'wg.gz'];
  }
  return [`${name}`, `${name}.gz`];
}

function wireGuardQuickEnv(runtime: WireGuardConnectionRuntimeStatus): Record<string, string> {
  const dirs = uniqueStrings([
    runtime.wg.command ? dirname(runtime.wg.command) : null,
    runtime.wgQuick?.command ? dirname(runtime.wgQuick.command) : null,
    runtime.wireGuardGo?.command ? dirname(runtime.wireGuardGo.command) : null,
    runtime.bash?.command ? dirname(runtime.bash.command) : null,
    ...defaultWireGuardPathDirs()
  ].filter(isString));
  const env: Record<string, string> = {
    PATH: dirs.join(':')
  };
  if (runtime.wireGuardGo?.command) {
    env.WG_QUICK_USERSPACE_IMPLEMENTATION = runtime.wireGuardGo.command;
  }
  return env;
}

function defaultWireGuardPathDirs(): string[] {
  if (process.platform === 'win32') return [];
  return ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function powerShellString(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function windowsCommandLineArgument(value: string): string {
  const text = String(value);
  if (text.length === 0) return '""';
  if (!/[\s"]/u.test(text)) return text;
  return `"${text
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\+)$/u, '$1$1')}"`;
}

type WindowsNrptRule = WireGuardWindowsNrptExpectedRule;

type WindowsRouteRule = {
  destinationPrefix: string;
};

function windowsNrptRulesFromProfile(profile: ReturnType<typeof parseWireGuardProfile>): WindowsNrptRule[] {
  if (profile.dnsServers.length === 0 || profile.dnsDomains.length === 0) return [];
  const servers = uniqueStrings(profile.dnsServers.filter(isIpv4));
  if (servers.length === 0) return [];
  const namespaces = uniqueStrings(profile.dnsDomains.flatMap((domain) => [domain, `.${domain}`]));
  return namespaces.map((namespace) => ({
    namespace,
    nameServers: servers
  }));
}

function normalizeWindowsNrptExpectedRules(
  rules: WireGuardWindowsNrptExpectedRule[]
): WindowsNrptRule[] {
  const byNamespace = new Map<string, string[]>();
  for (const rule of rules) {
    const namespace = normalizeWindowsNrptNamespace(rule?.namespace);
    const nameServers = normalizeWindowsNrptNameServers(rule?.nameServers);
    if (!namespace || nameServers.length === 0) continue;
    byNamespace.set(namespace, nameServers);
  }
  return [...byNamespace.entries()].map(([namespace, nameServers]) => ({
    namespace,
    nameServers
  }));
}

function windowsRouteRulesFromProfile(profile: ReturnType<typeof parseWireGuardProfile>): WindowsRouteRule[] {
  const selfIps = new Set(profile.addresses
    .map((address) => address.split('/')[0]?.trim())
    .filter(isString));
  return uniqueStrings(profile.allowedIps
    .map((cidr) => normalizeCidr(cidr) ?? cidr)
    .filter((cidr) => {
      const parsed = parseIpv4Cidr(cidr);
      if (!parsed || parsed.prefix === 0) return false;
      const host = cidr.split('/')[0]?.trim();
      return !(parsed.prefix === 32 && host && selfIps.has(host));
    }))
    .map((destinationPrefix) => ({ destinationPrefix }));
}

function windowsElevatedStartProcessScripts(
  command: string,
  args: string[],
  action: WireGuardTunnelAction,
  tunnelName: string,
  nrptRules: WindowsNrptRule[],
  nrptOwnershipEvidenceComplete: boolean,
  routeRules: WindowsRouteRule[],
  interfaceAddresses: string[],
  endpointHosts: string[],
  endpointBypassOwnerKey: string,
  elevatedScriptPath: string,
  auditLogPath?: string | null
): { wrapper: string; elevated: string } {
  const serviceName = `WireGuardTunnel$${tunnelName}`;
  const serviceArg = powerShellString(serviceName);
  const serviceLookup = `$svc = Get-Service -Name ${serviceArg} -ErrorAction SilentlyContinue`;
  const canPreflight = action === 'up'
    && endpointHosts.length === 0
    && nrptRules.length === 0
    && routeRules.length === 0
    && !isMxH2iTunnel(tunnelName);
  const preflightLines = !canPreflight
    ? []
    : [serviceLookup, "if ($null -ne $svc -and $svc.Status -eq 'Running') { exit 0 }"];
  const wireGuardArgumentLine = args.map(windowsCommandLineArgument).join(' ');
  const nrptLines = windowsNrptPowerShellLines(
    nrptRules,
    tunnelName,
    nrptOwnershipEvidenceComplete
  );
  const routeLines = windowsRoutePowerShellLines(routeRules, tunnelName, interfaceAddresses);
  const endpointBypassLines = windowsEndpointBypassPowerShellLines(
    endpointHosts,
    tunnelName,
    endpointBypassOwnerKey
  );
  const waitForServiceAbsent = () => [
    '$deadline = (Get-Date).AddSeconds(12)',
    'while ($true) {',
    `  $serviceProbe = Get-Service -Name ${serviceArg} -ErrorAction SilentlyContinue`,
    '  if ($null -eq $serviceProbe) { break }',
    '  try { $serviceProbe.Close() } catch { }',
    '  try { $serviceProbe.Dispose() } catch { }',
    '  $serviceProbe = $null',
    `  if ((Get-Date) -gt $deadline) { throw ${powerShellString(`Timed out waiting for ${serviceName} to be removed`)} }`,
    '  Start-Sleep -Milliseconds 250',
    '}'
  ];
  const waitForServiceStopped = () => [
    '$deadline = (Get-Date).AddSeconds(12)',
    'while ($true) {',
    `  $serviceProbe = Get-Service -Name ${serviceArg} -ErrorAction SilentlyContinue`,
    '  if ($null -eq $serviceProbe) { break }',
    '  $serviceProbeState = [string]$serviceProbe.Status',
    '  try { $serviceProbe.Close() } catch { }',
    '  try { $serviceProbe.Dispose() } catch { }',
    '  $serviceProbe = $null',
    "  if ($serviceProbeState -eq 'Stopped') { break }",
    `  if ((Get-Date) -gt $deadline) { throw ${powerShellString(`Timed out waiting for ${serviceName} to stop`)} }`,
    '  Start-Sleep -Milliseconds 250',
    '}'
  ];
  const waitForServiceRunning = () => [
    '$deadline = (Get-Date).AddSeconds(35)',
    '$stableUntil = $null',
    'while ($true) {',
    `  $svc = Get-Service -Name ${serviceArg} -ErrorAction SilentlyContinue`,
    "  if ($null -ne $svc -and $svc.Status -eq 'Running') {",
    "    if ($null -eq $stableUntil) { $stableUntil = (Get-Date).AddSeconds(4) }",
    '    if ((Get-Date) -gt $stableUntil) { break }',
    '  } else {',
    '    $stableUntil = $null',
    `    if ($null -ne $svc -and $svc.Status -eq 'Stopped') { Start-Service -Name ${serviceArg} -ErrorAction SilentlyContinue }`,
    '  }',
    `  if ((Get-Date) -gt $deadline) { throw ${powerShellString(`Timed out waiting for ${serviceName} to be running`)} }`,
    '  Start-Sleep -Milliseconds 500',
    '}'
  ];
  const elevatedLines: string[] = [
    "$ErrorActionPreference = 'Stop'",
    ...windowsAuditPowerShellLines(auditLogPath),
    "trap { $failure = ($_ | Out-String).Trim(); try { Write-HdoAudit ('elevated failed: ' + $failure) } catch { }; exit 1 }",
    `Write-HdoAudit ${powerShellString(`elevated start action=${action} tunnel=${tunnelName} service=${serviceName} nrptRules=${nrptRules.length}`)}`,
    ...nrptLines,
    ...routeLines,
    ...endpointBypassLines,
    serviceLookup
  ];
  if (action === 'up') {
    elevatedLines.push('Add-HdoEndpointBypass');
    elevatedLines.push(
      "if ($null -ne $svc -and $svc.Status -eq 'Running') {",
      "  Write-HdoAudit 'service already running; applying routes and NRPT rules'",
      '  Add-HdoOverlayRoutes',
      '  Add-HdoNrptRules',
      ...waitForServiceRunning(),
      '  exit 0',
      '}',
      `if ($null -ne $svc) {`,
      `  Write-HdoAudit ${powerShellString(`service exists; ensuring ${serviceName} is running`)}`,
      `  Start-Service -Name ${serviceArg} -ErrorAction SilentlyContinue`,
      ...waitForServiceRunning(),
      '  Add-HdoOverlayRoutes',
      '  Add-HdoNrptRules',
      ...waitForServiceRunning(),
      '  exit 0',
      '}'
    );
  } else if (action === 'down') {
    elevatedLines.push(`Write-HdoAudit ${powerShellString(`removing NRPT rules for ${serviceName}`)}`);
    elevatedLines.push('Remove-HdoNrptRules');
    elevatedLines.push('Remove-HdoOverlayRoutes');
    elevatedLines.push('Remove-HdoEndpointBypass');
    elevatedLines.push('if ($null -eq $svc) { exit 0 }');
    elevatedLines.push('try { $svc.Close() } catch { }');
    elevatedLines.push('try { $svc.Dispose() } catch { }');
    elevatedLines.push('$svc = $null');
  } else {
    elevatedLines.push(`Write-HdoAudit ${powerShellString(`restart removing NRPT rules for ${serviceName}`)}`);
    elevatedLines.push('Remove-HdoNrptRules');
    elevatedLines.push('Remove-HdoOverlayRoutes');
    elevatedLines.push('Add-HdoEndpointBypass');
    elevatedLines.push(
      'if ($null -ne $svc) {',
      `  Write-HdoAudit ${powerShellString(`stopping ${serviceName} before WireGuard-managed replacement`)}`,
      `  if ($svc.Status -ne 'Stopped') { Stop-Service -Name ${serviceArg} -Force -ErrorAction SilentlyContinue }`,
      ...waitForServiceStopped(),
      '  try { $svc.Close() } catch { }',
      '  try { $svc.Dispose() } catch { }',
      '  $svc = $null',
      "  Write-HdoAudit 'service stopped; wireguard install will replace it transactionally'",
      '}'
    );
  }
  elevatedLines.push(
    `Write-HdoAudit ${powerShellString(`wireguard command action=${action}`)}`,
    `$wireGuardProcess = Start-Process -FilePath ${powerShellString(command)} -ArgumentList ${powerShellString(wireGuardArgumentLine)} -WindowStyle Hidden -Wait -PassThru`,
    '$wireGuardExitCode = $wireGuardProcess.ExitCode',
    "Write-HdoAudit ('wireguard exitCode=' + [string]$wireGuardExitCode)",
    "if ($null -eq $wireGuardExitCode -or $wireGuardExitCode -ne 0) { Write-HdoAudit ('wireguard command failed exitCode=' + [string]$wireGuardExitCode); exit 1 }",
    ...(action === 'down' ? waitForServiceAbsent() : waitForServiceRunning()),
    ...(action === 'down' ? [] : ['Add-HdoOverlayRoutes', 'Add-HdoNrptRules']),
    ...(action === 'down' ? [] : waitForServiceRunning()),
    `Write-HdoAudit ${powerShellString(`elevated complete action=${action} tunnel=${tunnelName}`)}`,
    'exit 0'
  );
  return {
    wrapper: windowsElevatedPowerShellWrapperScript(elevatedScriptPath, preflightLines, auditLogPath),
    elevated: elevatedLines.join('\n')
  };
}

function buildWindowsRepairCommand(
  runtime: WireGuardConnectionRuntimeStatus,
  configPath: string,
  nrptRules: WindowsNrptRule[],
  routeRules: WindowsRouteRule[],
  interfaceAddresses: string[],
  endpointHosts: string[]
): WireGuardTunnelCommand {
  const tunnelName = pathWin32.basename(configPath).replace(/\.[^.]+$/, '');
  const profile = parseWireGuardProfile(configPath);
  const routeLogPath = wireGuardRouteLogPath(configPath, profile.interfaceName);
  const scriptPaths = windowsPowerShellScriptPaths(configPath, tunnelName, 'repair-dns');
  const elevated = [
    "$ErrorActionPreference = 'Stop'",
    ...windowsAuditPowerShellLines(routeLogPath),
    `Write-HdoAudit ${powerShellString(`repair start tunnel=${tunnelName} nrptRules=${nrptRules.length} routeRules=${routeRules.length}`)}`,
    ...windowsNrptPowerShellLines(nrptRules, tunnelName),
    ...windowsRoutePowerShellLines(routeRules, tunnelName, interfaceAddresses),
    ...windowsEndpointBypassPowerShellLines(
      endpointHosts,
      tunnelName,
      windowsEndpointBypassOwnerKey(configPath, tunnelName)
    ),
    'Add-HdoEndpointBypass',
    'Add-HdoOverlayRoutes',
    'Add-HdoNrptRules',
    `Write-HdoAudit ${powerShellString(`repair complete tunnel=${tunnelName}`)}`,
    'exit 0'
  ].join('\n');
  writePowerShellScriptFile(scriptPaths.elevated, elevated);
  writePowerShellScriptFile(scriptPaths.wrapper, windowsElevatedPowerShellWrapperScript(scriptPaths.elevated, [], routeLogPath));
  const powershell = windowsPowerShellCommand();
  return {
    action: 'up',
    platform: runtime.platform,
    configPath,
    command: powershell,
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPaths.wrapper],
    displayCommand: `${powershell} -NoProfile -ExecutionPolicy Bypass -File <hdo-nrpt-repair-wrapper.ps1>`,
    needsAdmin: true,
    runtime
  };
}

function windowsElevatedPowerShellWrapperScript(
  elevatedScriptPath: string,
  preflightLines: string[] = [],
  auditLogPath?: string | null
): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    ...windowsAuditPowerShellLines(auditLogPath),
    `Write-HdoAudit ${powerShellString('wrapper start')}`,
    ...preflightLines,
    "$pwsh = Join-Path $PSHOME 'powershell.exe'",
    `$elevatedScript = ${powerShellString(elevatedScriptPath)}`,
    "Write-HdoAudit ('wrapper powershell=' + $pwsh)",
    "Write-HdoAudit ('wrapper elevatedScript=' + $elevatedScript)",
    `$quotedElevatedScript = '"' + $elevatedScript.Replace('"', '\\"') + '"'`,
    `$argLine = '-NoProfile -ExecutionPolicy Bypass -File ' + $quotedElevatedScript`,
    "Write-HdoAudit ('wrapper argLine=' + $argLine)",
    'try {',
    `  $p = Start-Process -FilePath $pwsh -ArgumentList $argLine -Verb RunAs -WindowStyle Hidden -Wait -PassThru`,
    '} catch {',
    "  Write-HdoAudit ('wrapper elevation failed: ' + $_.Exception.Message)",
    '  $nativeErrorCode = $null',
    "  if ($null -ne $_.Exception.PSObject.Properties['NativeErrorCode']) { $nativeErrorCode = $_.Exception.NativeErrorCode }",
    "  if ($null -eq $nativeErrorCode -and $null -ne $_.Exception.InnerException -and $null -ne $_.Exception.InnerException.PSObject.Properties['NativeErrorCode']) { $nativeErrorCode = $_.Exception.InnerException.NativeErrorCode }",
    "  $authorizationCanceled = ($nativeErrorCode -eq 1223) -or ($_.Exception.Message -match '(?i)cancel(?:ed|led)|用户.*取消|取消.*用户')",
    "  if ($authorizationCanceled) { [Console]::Error.WriteLine('MX_WIREGUARD_AUTHORIZATION_CANCELED'); exit 1223 }",
    '  throw',
    '}',
    "Write-HdoAudit ('wrapper elevated exitCode=' + [string]$p.ExitCode)",
    'if ($null -ne $p.ExitCode) { exit $p.ExitCode }'
  ].join('\n');
}

function windowsAuditPowerShellLines(auditLogPath?: string | null): string[] {
  return [
    `$hdoAuditLogPath = ${auditLogPath ? powerShellString(auditLogPath) : '$null'}`,
    'function Write-HdoAudit {',
    '  param([string]$Message)',
    '  if (-not $hdoAuditLogPath) { return }',
    '  try {',
    '    $parent = Split-Path -Parent $hdoAuditLogPath',
    '    if ($parent) { New-Item -ItemType Directory -Path $parent -Force -ErrorAction SilentlyContinue | Out-Null }',
    "    Add-Content -Path $hdoAuditLogPath -Value ((Get-Date -Format o) + ' ' + $Message) -Encoding UTF8 -ErrorAction SilentlyContinue",
    '  } catch { }',
    '}'
  ];
}

function windowsRoutePowerShellLines(
  rules: WindowsRouteRule[],
  tunnelName: string,
  interfaceAddresses: string[]
): string[] {
  const product = windowsTunnelProductLabels(tunnelName);
  if (rules.length === 0) {
    return [
      `Write-HdoAudit ${powerShellString(`route skipped tunnel=${tunnelName} rules=0`)}`,
      "function Add-HdoOverlayRoutes { Write-HdoAudit 'route add skipped rules=0' }",
      "function Remove-HdoOverlayRoutes { Write-HdoAudit 'route remove skipped rules=0' }"
    ];
  }
  const routeEntries = rules.map((rule) =>
    `[pscustomobject]@{ DestinationPrefix = ${powerShellString(rule.destinationPrefix)} }`
  );
  const addressEntries = uniqueStrings(interfaceAddresses
    .map((address) => address.split('/')[0]?.trim())
    .filter(isString)
    .filter(isIpv4))
    .map(powerShellString);
  return [
    `$hdoRouteRules = @(${routeEntries.join(', ')})`,
    `$hdoRouteTunnelName = ${powerShellString(tunnelName)}`,
    `$hdoRouteInterfaceAddresses = @(${addressEntries.join(', ')})`,
    `Write-HdoAudit ${powerShellString(`route prepared tunnel=${tunnelName} rules=${rules.length}`)}`,
    'function Resolve-HdoOverlayInterface {',
    '  $iface = Get-NetIPInterface -AddressFamily IPv4 -InterfaceAlias $hdoRouteTunnelName -ErrorAction SilentlyContinue | Select-Object -First 1',
    '  if ($null -eq $iface -and $hdoRouteInterfaceAddresses.Count -gt 0) {',
    '    $addr = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $hdoRouteInterfaceAddresses -contains $_.IPAddress } | Select-Object -First 1',
    '    if ($null -ne $addr) {',
    '      $iface = Get-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $addr.InterfaceIndex -ErrorAction SilentlyContinue | Select-Object -First 1',
    '    }',
    '  }',
    "  if ($null -eq $iface) { Write-HdoAudit ('route interface missing tunnel=' + $hdoRouteTunnelName); return $null }",
    "  Write-HdoAudit ('route interface index=' + [string]$iface.InterfaceIndex + ' alias=' + [string]$iface.InterfaceAlias)",
    '  return $iface',
    '}',
    'function Remove-HdoOverlayRoutes {',
    '  $iface = Resolve-HdoOverlayInterface',
    "  if ($null -eq $iface) { Write-HdoAudit 'route remove skipped: interface missing'; return }",
    '  foreach ($rule in $hdoRouteRules) {',
    "    Write-HdoAudit ('route remove prefix=' + $rule.DestinationPrefix + ' if=' + [string]$iface.InterfaceIndex)",
    '    Get-NetRoute -AddressFamily IPv4 -DestinationPrefix $rule.DestinationPrefix -InterfaceIndex $iface.InterfaceIndex -ErrorAction SilentlyContinue | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue',
    '  }',
    '}',
    'function Add-HdoOverlayRoutes {',
    '  $iface = Resolve-HdoOverlayInterface',
    `  if ($null -eq $iface) { throw (${powerShellString(`${product.shortName} WireGuard interface not found for `)} + $hdoRouteTunnelName) }`,
    '  try {',
    '    Set-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $iface.InterfaceIndex -InterfaceMetric 1 -ErrorAction Stop | Out-Null',
    "    Write-HdoAudit ('route interface metric set if=' + [string]$iface.InterfaceIndex)",
    '  } catch {',
    "    Write-HdoAudit ('route interface metric failed: ' + ($_ | Out-String).Trim())",
    '  }',
    '  foreach ($rule in $hdoRouteRules) {',
    '    Get-NetRoute -AddressFamily IPv4 -DestinationPrefix $rule.DestinationPrefix -InterfaceIndex $iface.InterfaceIndex -ErrorAction SilentlyContinue | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue',
    '    try {',
    "      New-NetRoute -AddressFamily IPv4 -DestinationPrefix $rule.DestinationPrefix -InterfaceIndex $iface.InterfaceIndex -NextHop '0.0.0.0' -RouteMetric 1 -PolicyStore ActiveStore -ErrorAction Stop | Out-Null",
    "      Write-HdoAudit ('route add ok prefix=' + $rule.DestinationPrefix + ' if=' + [string]$iface.InterfaceIndex)",
    '    } catch {',
    '      $existing = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix $rule.DestinationPrefix -InterfaceIndex $iface.InterfaceIndex -ErrorAction SilentlyContinue)',
    '      if ($existing.Count -eq 0) { throw }',
    "      Write-HdoAudit ('route add kept existing prefix=' + $rule.DestinationPrefix + ' if=' + [string]$iface.InterfaceIndex)",
    '    }',
    '    $verified = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix $rule.DestinationPrefix -InterfaceIndex $iface.InterfaceIndex -ErrorAction SilentlyContinue)',
    `    if ($verified.Count -eq 0) { throw (${powerShellString(`${product.shortName} route missing after add: `)} + $rule.DestinationPrefix) }`,
    '  }',
    '}'
  ];
}

function windowsEndpointBypassOwnerKey(configPath: string, tunnelName: string): string {
  const normalizedPath = resolve(configPath).replace(/\\/g, '/').toLowerCase();
  return `${tunnelName.trim().toLowerCase()}|${normalizedPath}`;
}

function windowsEndpointBypassPowerShellLines(
  endpointHosts: string[],
  tunnelName: string,
  ownerKey: string
): string[] {
  const hosts = uniqueStrings(endpointHosts
    .map((host) => host.trim())
    .filter((host) => isIpv4(host) || /^[a-zA-Z0-9.-]+$/.test(host)));
  const hostEntries = hosts.map(powerShellString);
  return [
    `$hdoEndpointBypassHosts = @(${hostEntries.join(', ')})`,
    `$hdoEndpointBypassTunnelName = ${powerShellString(tunnelName)}`,
    `$hdoEndpointBypassOwner = ${powerShellString(ownerKey)}`,
    '$hdoEndpointBypassRouteMetric = 3',
    "$hdoEndpointBypassMutexName = 'Global\\QPJoy.WireGuard.EndpointBypass.v1'",
    '$hdoEndpointBypassCommonData = [Environment]::GetFolderPath([System.Environment+SpecialFolder]::CommonApplicationData)',
    'if ([string]::IsNullOrWhiteSpace($hdoEndpointBypassCommonData)) { throw "Windows CommonApplicationData is unavailable for endpoint bypass ownership" }',
    '$hdoEndpointBypassStateDir = Join-Path $hdoEndpointBypassCommonData "QPJoy\\WireGuard"',
    '$hdoEndpointBypassRegistryPath = Join-Path $hdoEndpointBypassStateDir "endpoint-bypass-registry.json"',
    `Write-HdoAudit ${powerShellString(`endpoint bypass prepared tunnel=${tunnelName} hosts=${hosts.length}`)}`,
    'function Enter-HdoEndpointBypassMutex {',
    '  param([int]$TimeoutMs = 30000)',
    '  $mutex = [System.Threading.Mutex]::new($false, $hdoEndpointBypassMutexName)',
    '  $acquired = $false',
    '  try {',
    '    $acquired = $mutex.WaitOne($TimeoutMs)',
    '  } catch [System.Threading.AbandonedMutexException] {',
    '    $acquired = $true',
    '  } catch {',
    '    $mutex.Dispose()',
    '    throw',
    '  }',
    '  if (-not $acquired) {',
    '    $mutex.Dispose()',
    '    throw ("Timed out waiting for machine-wide endpoint bypass mutex " + $hdoEndpointBypassMutexName)',
    '  }',
    '  return $mutex',
    '}',
    'function Exit-HdoEndpointBypassMutex {',
    '  param([System.Threading.Mutex]$Mutex)',
    '  if ($null -eq $Mutex) { return }',
    '  try { $Mutex.ReleaseMutex() } finally { $Mutex.Dispose() }',
    '}',
    'function Test-HdoEndpointIpv4 {',
    '  param([string]$Address)',
    "  if ($Address -notmatch '^(?:[0-9]{1,3}\\.){3}[0-9]{1,3}$') { return $false }",
    '  $parts = @($Address.Split(".") | ForEach-Object { [int]$_ })',
    '  return $parts.Count -eq 4 -and @($parts | Where-Object { $_ -lt 0 -or $_ -gt 255 }).Count -eq 0',
    '}',
    'function Test-HdoPublicEndpointIpv4 {',
    '  param([string]$Address)',
    '  if (-not (Test-HdoEndpointIpv4 $Address)) { return $false }',
    '  $parts = @($Address.Split(".") | ForEach-Object { [int]$_ })',
    '  if ($parts[0] -eq 0 -or $parts[0] -eq 10 -or $parts[0] -eq 127 -or $parts[0] -ge 224) { return $false }',
    '  if ($parts[0] -eq 100 -and $parts[1] -ge 64 -and $parts[1] -le 127) { return $false }',
    '  if ($parts[0] -eq 169 -and $parts[1] -eq 254) { return $false }',
    '  if ($parts[0] -eq 172 -and $parts[1] -ge 16 -and $parts[1] -le 31) { return $false }',
    '  if ($parts[0] -eq 192 -and $parts[1] -eq 168) { return $false }',
    '  if ($parts[0] -eq 198 -and ($parts[1] -eq 18 -or $parts[1] -eq 19)) { return $false }',
    '  return $true',
    '}',
    'function Get-HdoEndpointBypassIps {',
    '  $ips = New-Object System.Collections.Generic.List[string]',
    '  foreach ($hostName in $hdoEndpointBypassHosts) {',
    '    if (Test-HdoEndpointIpv4 $hostName) {',
    '      if (Test-HdoPublicEndpointIpv4 $hostName) { $ips.Add($hostName) }',
    '      continue',
    '    }',
    '    try {',
    '      $resolved = @([System.Net.Dns]::GetHostAddresses($hostName) | Where-Object { $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork } | ForEach-Object { $_.IPAddressToString })',
    '      foreach ($ip in $resolved) { if (Test-HdoPublicEndpointIpv4 $ip) { $ips.Add($ip) } }',
    '    } catch {',
    "      Write-HdoAudit ('endpoint bypass resolve failed host=' + $hostName + ' error=' + ($_ | Out-String).Trim())",
    '    }',
    '  }',
    '  return @($ips | Sort-Object -Unique)',
    '}',
    'function Get-HdoPhysicalDefaultRoute {',
    '  $interfaces = @{}',
    '  @(Get-NetIPInterface -AddressFamily IPv4 -ErrorAction SilentlyContinue) | ForEach-Object { $interfaces[[string]$_.InterfaceIndex] = $_ }',
    '  $candidates = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue | ForEach-Object {',
    '    $iface = $interfaces[[string]$_.InterfaceIndex]',
    '    $nextHop = [string]$_.NextHop',
    '    if ($null -eq $iface -or -not (Test-HdoEndpointIpv4 $nextHop) -or $nextHop -eq "0.0.0.0") { return }',
    '    $nextParts = @($nextHop.Split(".") | ForEach-Object { [int]$_ })',
    '    if ($nextParts[0] -eq 198 -and ($nextParts[1] -eq 18 -or $nextParts[1] -eq 19)) { return }',
    '    $alias = [string]$iface.InterfaceAlias',
    '    if ($alias -eq $hdoEndpointBypassTunnelName -or $alias -match "(?i)(clash|mihomo|sing-box|wintun|proxy[ -]?tun)") { return }',
    '    if ([string]$iface.ConnectionState -eq "Disconnected") { return }',
    '    [pscustomobject]@{',
    '      InterfaceIndex = [int]$_.InterfaceIndex',
    '      InterfaceAlias = $alias',
    '      NextHop = $nextHop',
    '      Cost = ([int]$_.RouteMetric + [int]$iface.InterfaceMetric)',
    '    }',
    '  })',
    '  return $candidates | Sort-Object -Property Cost,InterfaceIndex | Select-Object -First 1',
    '}',
    'function New-HdoEndpointBypassRegistry {',
    '  return [pscustomobject]@{ Version = 1; Routes = @() }',
    '}',
    'function Read-HdoEndpointBypassRegistry {',
    '  if (-not (Test-Path $hdoEndpointBypassRegistryPath -ErrorAction SilentlyContinue)) { return (New-HdoEndpointBypassRegistry) }',
    '  try {',
    '    $registry = Get-Content -Path $hdoEndpointBypassRegistryPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop',
    '  } catch {',
    '    throw ("Endpoint bypass registry is unreadable; refusing unowned route cleanup: " + $hdoEndpointBypassRegistryPath + ": " + $_.Exception.Message)',
    '  }',
    '  if ([int]$registry.Version -ne 1) { throw ("Unsupported endpoint bypass registry version: " + [string]$registry.Version) }',
    '  if ($null -eq $registry.Routes) { $registry.Routes = @() }',
    '  return $registry',
    '}',
    'function Write-HdoEndpointBypassRegistry {',
    '  param([object]$Registry)',
    '  $routes = @($Registry.Routes | ForEach-Object {',
    '    [pscustomobject]@{',
    '      DestinationPrefix = [string]$_.DestinationPrefix',
    '      InterfaceIndex = [int]$_.InterfaceIndex',
    '      NextHop = [string]$_.NextHop',
    '      RouteMetric = [int]$_.RouteMetric',
    '      Managed = [bool]$_.Managed',
    '      Owners = @($_.Owners | ForEach-Object { ([string]$_).Trim().ToLowerInvariant() } | Where-Object { $_ } | Sort-Object -Unique)',
    '    }',
    '  })',
    '  if ($routes.Count -eq 0) {',
    '    if (Test-Path $hdoEndpointBypassRegistryPath -ErrorAction SilentlyContinue) { Remove-Item -Path $hdoEndpointBypassRegistryPath -Force -ErrorAction Stop }',
    '    return',
    '  }',
    '  New-Item -ItemType Directory -Path $hdoEndpointBypassStateDir -Force -ErrorAction Stop | Out-Null',
    '  $payload = [ordered]@{ Version = 1; Routes = $routes }',
    '  $temporary = $hdoEndpointBypassRegistryPath + ".tmp." + [string]$PID + "." + [guid]::NewGuid().ToString("N")',
    '  try {',
    '    $payload | ConvertTo-Json -Depth 7 | Set-Content -Path $temporary -Encoding UTF8 -ErrorAction Stop',
    '    Move-Item -Path $temporary -Destination $hdoEndpointBypassRegistryPath -Force -ErrorAction Stop',
    '  } finally {',
    '    if (Test-Path $temporary -ErrorAction SilentlyContinue) { Remove-Item -Path $temporary -Force -ErrorAction SilentlyContinue }',
    '  }',
    '}',
    'function Get-HdoEndpointBypassRouteKey {',
    '  param([string]$DestinationPrefix, [int]$InterfaceIndex, [string]$NextHop)',
    '  return ($DestinationPrefix.ToLowerInvariant() + "|" + [string]$InterfaceIndex + "|" + $NextHop.ToLowerInvariant())',
    '}',
    'function Get-HdoEndpointBypassExactRoutes {',
    '  param([object]$Entry)',
    '  return @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix ([string]$Entry.DestinationPrefix) -InterfaceIndex ([int]$Entry.InterfaceIndex) -ErrorAction SilentlyContinue | Where-Object {',
    '    [string]$_.NextHop -eq [string]$Entry.NextHop -and [int]$_.RouteMetric -eq [int]$Entry.RouteMetric',
    '  })',
    '}',
    'function Remove-HdoEndpointBypassRoute {',
    '  param([object]$Entry)',
    '  if (-not [bool]$Entry.Managed) { return }',
    '  $matches = @(Get-HdoEndpointBypassExactRoutes $Entry)',
    "  Write-HdoAudit ('endpoint bypass last-owner remove prefix=' + [string]$Entry.DestinationPrefix + ' if=' + [string]$Entry.InterfaceIndex + ' nextHop=' + [string]$Entry.NextHop + ' count=' + [string]$matches.Count)",
    '  foreach ($match in $matches) { $match | Remove-NetRoute -Confirm:$false -ErrorAction Stop }',
    '  $remaining = @(Get-HdoEndpointBypassExactRoutes $Entry)',
    '  if ($remaining.Count -gt 0) { throw ("Endpoint bypass route remains after last-owner cleanup: " + [string]$Entry.DestinationPrefix) }',
    '}',
    'function Release-HdoEndpointBypassOwnerUnlocked {',
    '  param([object]$Registry, [string[]]$KeepKeys = @())',
    '  $kept = @()',
    '  foreach ($entry in @($Registry.Routes)) {',
    '    $key = Get-HdoEndpointBypassRouteKey ([string]$entry.DestinationPrefix) ([int]$entry.InterfaceIndex) ([string]$entry.NextHop)',
    '    $owners = @($entry.Owners | ForEach-Object { ([string]$_).Trim().ToLowerInvariant() } | Where-Object { $_ } | Sort-Object -Unique)',
    '    if ($KeepKeys -notcontains $key) { $owners = @($owners | Where-Object { $_ -ne $hdoEndpointBypassOwner }) }',
    '    $entry.Owners = @($owners)',
    '    if ($owners.Count -eq 0) {',
    '      Remove-HdoEndpointBypassRoute $entry',
    '      continue',
    '    }',
    '    $kept += $entry',
    '  }',
    '  $Registry.Routes = @($kept)',
    '}',
    'function Ensure-HdoEndpointBypassRouteUnlocked {',
    '  param([object]$Registry, [string]$DestinationPrefix, [object]$Physical)',
    '  $interfaceIndex = [int]$Physical.InterfaceIndex',
    '  $nextHop = [string]$Physical.NextHop',
    '  $entry = @($Registry.Routes | Where-Object {',
    '    [string]$_.DestinationPrefix -eq $DestinationPrefix -and [int]$_.InterfaceIndex -eq $interfaceIndex -and [string]$_.NextHop -eq $nextHop',
    '  } | Select-Object -First 1)[0]',
    '  $created = $false',
    '  if ($null -eq $entry) {',
    '    $existing = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix $DestinationPrefix -InterfaceIndex $interfaceIndex -ErrorAction SilentlyContinue | Where-Object { [string]$_.NextHop -eq $nextHop } | Sort-Object -Property RouteMetric)',
    '    if ($existing.Count -gt 0) {',
    '      $entry = [pscustomobject]@{ DestinationPrefix = $DestinationPrefix; InterfaceIndex = $interfaceIndex; NextHop = $nextHop; RouteMetric = [int]$existing[0].RouteMetric; Managed = $false; Owners = @() }',
    '    } else {',
    '      New-NetRoute -AddressFamily IPv4 -DestinationPrefix $DestinationPrefix -InterfaceIndex $interfaceIndex -NextHop $nextHop -RouteMetric $hdoEndpointBypassRouteMetric -PolicyStore ActiveStore -ErrorAction Stop | Out-Null',
    '      $entry = [pscustomobject]@{ DestinationPrefix = $DestinationPrefix; InterfaceIndex = $interfaceIndex; NextHop = $nextHop; RouteMetric = $hdoEndpointBypassRouteMetric; Managed = $true; Owners = @() }',
    '      $created = $true',
    '    }',
    '    $Registry.Routes = @($Registry.Routes) + $entry',
    '  } elseif (@(Get-HdoEndpointBypassExactRoutes $entry).Count -eq 0) {',
    '    $existing = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix $DestinationPrefix -InterfaceIndex $interfaceIndex -ErrorAction SilentlyContinue | Where-Object { [string]$_.NextHop -eq $nextHop } | Sort-Object -Property RouteMetric)',
    '    if ($existing.Count -gt 0) {',
    '      $entry.RouteMetric = [int]$existing[0].RouteMetric',
    '      $entry.Managed = $false',
    '    } else {',
    '      New-NetRoute -AddressFamily IPv4 -DestinationPrefix $DestinationPrefix -InterfaceIndex $interfaceIndex -NextHop $nextHop -RouteMetric $hdoEndpointBypassRouteMetric -PolicyStore ActiveStore -ErrorAction Stop | Out-Null',
    '      $entry.RouteMetric = $hdoEndpointBypassRouteMetric',
    '      $entry.Managed = $true',
    '      $created = $true',
    '    }',
    '  }',
    '  $entry.Owners = @(@($entry.Owners | ForEach-Object { ([string]$_).Trim().ToLowerInvariant() }) + $hdoEndpointBypassOwner | Where-Object { $_ } | Sort-Object -Unique)',
    '  try {',
    '    Write-HdoEndpointBypassRegistry $Registry',
    '  } catch {',
    '    if ($created) { try { Remove-HdoEndpointBypassRoute $entry } catch { } }',
    '    throw',
    '  }',
    '  $verified = @(Get-HdoEndpointBypassExactRoutes $entry)',
    '  if ($verified.Count -eq 0) { throw ("Endpoint bypass route missing after shared registration: " + $DestinationPrefix) }',
    "  Write-HdoAudit ('endpoint bypass registered prefix=' + $DestinationPrefix + ' if=' + [string]$interfaceIndex + ' nextHop=' + $nextHop + ' managed=' + [string]$entry.Managed + ' owners=' + [string](@($entry.Owners).Count))",
    '  return (Get-HdoEndpointBypassRouteKey $DestinationPrefix $interfaceIndex $nextHop)',
    '}',
    'function Remove-HdoEndpointBypassUnlocked {',
    '  $registry = Read-HdoEndpointBypassRegistry',
    '  Release-HdoEndpointBypassOwnerUnlocked $registry',
    '  Write-HdoEndpointBypassRegistry $registry',
    "  Write-HdoAudit 'endpoint bypass owner release complete'",
    '}',
    'function Add-HdoEndpointBypassUnlocked {',
    '  $endpointIps = @(Get-HdoEndpointBypassIps)',
    '  if ($endpointIps.Count -eq 0) {',
    '    if ($hdoEndpointBypassHosts.Count -gt 0) { throw "No public IPv4 WireGuard endpoint could be resolved for physical bypass" }',
    '    Remove-HdoEndpointBypassUnlocked',
    "    Write-HdoAudit 'endpoint bypass reconciled empty desired state'",
    '    return',
    '  }',
    '  $physical = Get-HdoPhysicalDefaultRoute',
    '  if ($null -eq $physical) { throw "Physical IPv4 default route is unavailable for WireGuard endpoint bypass" }',
    "  Write-HdoAudit ('endpoint bypass physical if=' + [string]$physical.InterfaceIndex + ' alias=' + [string]$physical.InterfaceAlias + ' nextHop=' + [string]$physical.NextHop)",
    '  $registry = Read-HdoEndpointBypassRegistry',
    '  $desiredKeys = @()',
    '  foreach ($ip in $endpointIps) {',
    '    $desiredKeys += Ensure-HdoEndpointBypassRouteUnlocked $registry ($ip + "/32") $physical',
    '  }',
    '  Release-HdoEndpointBypassOwnerUnlocked $registry $desiredKeys',
    '  Write-HdoEndpointBypassRegistry $registry',
    "  Write-HdoAudit ('endpoint bypass owner reconcile complete desired=' + ($desiredKeys -join ','))",
    '}',
    'function Remove-HdoEndpointBypass {',
    '  $mutex = Enter-HdoEndpointBypassMutex',
    '  try { Remove-HdoEndpointBypassUnlocked } finally { Exit-HdoEndpointBypassMutex $mutex }',
    '}',
    'function Add-HdoEndpointBypass {',
    '  $mutex = Enter-HdoEndpointBypassMutex',
    '  try { Add-HdoEndpointBypassUnlocked } finally { Exit-HdoEndpointBypassMutex $mutex }',
    '}'
  ];
}

function windowsNrptMutexPowerShellLines(): string[] {
  return [
    `$hdoNrptMutexName = ${powerShellString(WINDOWS_NRPT_MUTEX_NAME)}`,
    'function Enter-HdoNrptMutex {',
    '  param([int]$TimeoutMs = 30000)',
    '  $mutex = [System.Threading.Mutex]::new($false, $hdoNrptMutexName)',
    '  $acquired = $false',
    '  try {',
    '    $acquired = $mutex.WaitOne($TimeoutMs)',
    '  } catch [System.Threading.AbandonedMutexException] {',
    '    $acquired = $true',
    '  }',
    '  if (-not $acquired) {',
    '    $mutex.Dispose()',
    '    throw ("Timed out waiting for machine-wide NRPT transaction mutex " + $hdoNrptMutexName)',
    '  }',
    '  return $mutex',
    '}',
    'function Exit-HdoNrptMutex {',
    '  param([System.Threading.Mutex]$Mutex)',
    '  if ($null -eq $Mutex) { return }',
    '  try { $Mutex.ReleaseMutex() } finally { $Mutex.Dispose() }',
    '}'
  ];
}

function windowsNrptPowerShellLines(
  rules: WindowsNrptRule[],
  tunnelName: string,
  ownershipEvidenceComplete = true
): string[] {
  const product = windowsTunnelProductLabels(tunnelName);
  const entries = rules.map((rule) => {
    const servers = rule.nameServers.map(powerShellString).join(',');
    return `[pscustomobject]@{ Namespace = ${powerShellString(rule.namespace)}; NameServers = @(${servers}) }`;
  });
  const comment = `${product.commentPrefix} ${tunnelName}`;
  const legacyComment = windowsLegacyNrptComment(tunnelName);
  const ownsUntaggedRules = false;
  const legacyStateFileName = `nrpt-global-${tunnelName}.json`;
  return [
    `$hdoNrptRules = @(${entries.join(', ')})`,
    `$hdoNrptComment = ${powerShellString(comment)}`,
    `$hdoNrptLegacyComment = ${legacyComment ? powerShellString(legacyComment) : '$null'}`,
    `$hdoNrptOwnsUntagged = ${ownsUntaggedRules ? '$true' : '$false'}`,
    `$hdoNrptOwnershipEvidenceComplete = ${ownershipEvidenceComplete ? '$true' : '$false'}`,
    `$hdoNrptGlobalStatePath = Join-Path $env:ProgramData ${powerShellString(WINDOWS_NRPT_SHARED_STATE_RELATIVE_PATH)}`,
    '$hdoNrptStateDir = Split-Path -Parent $hdoNrptGlobalStatePath',
    `$hdoNrptLegacyStateDir = Join-Path $env:ProgramData ${powerShellString(product.programDataDir)}`,
    `$hdoNrptLegacyGlobalStatePath = Join-Path $hdoNrptLegacyStateDir ${powerShellString(legacyStateFileName)}`,
    '$hdoNrptLegacyOwnerKey = "legacy-state:" + $hdoNrptLegacyGlobalStatePath.ToLowerInvariant()',
    '$hdoNrptMayMigrateUntagged = Test-Path $hdoNrptLegacyGlobalStatePath -ErrorAction Stop',
    "$hdoNrptLegacySearchRoot = Join-Path $env:ProgramData 'QPJoy'",
    `$hdoNrptTunnelName = ${powerShellString(tunnelName)}`,
    "$hdoNrptEnableAttempts = @('EnableAlways', 'EnableDA', 'Enable', $true)",
    ...windowsNrptMutexPowerShellLines(),
    "Write-HdoAudit ('nrpt prepared tunnel=' + $hdoNrptTunnelName + ' rules=' + [string]$hdoNrptRules.Count + ' comment=' + $hdoNrptComment)",
    // NRPT is a machine-global table shared by every standalone launcher product.
    // MX-H2I may migrate its exact historical tag, or an exact namespace/DNS
    // match backed by its legacy state file. Other products retain the old
    // untagged fallback; an untagged rule alone never proves MX-H2I ownership.
    'function Test-HdoNrptRuleTaggedOwner {',
    '  param([object]$Rule)',
    '  $comment = [string]$Rule.Comment',
    '  $display = [string]$Rule.DisplayName',
    '  if ($comment -eq $hdoNrptComment -or $display -eq $hdoNrptComment) { return $true }',
    '  if ($null -ne $hdoNrptLegacyComment -and ($comment -eq $hdoNrptLegacyComment -or $display -eq $hdoNrptLegacyComment)) { return $true }',
    '  return $false',
    '}',
    'function Test-HdoNrptRuleLegacyMigrationCandidate {',
    '  param([object]$Rule)',
    '  if (-not $hdoNrptMayMigrateUntagged -or $hdoNrptOwnsUntagged) { return $false }',
    '  if (-not [string]::IsNullOrEmpty([string]$Rule.Comment) -or -not [string]::IsNullOrEmpty([string]$Rule.DisplayName)) { return $false }',
    '  foreach ($expected in $hdoNrptRules) {',
    '    if ([string]$Rule.Namespace -eq [string]$expected.Namespace -and (Test-HdoNrptRuleNameServers $Rule $expected.NameServers)) { return $true }',
    '  }',
    '  return $false',
    '}',
    'function Test-HdoNrptRuleOwned {',
    '  param([object]$Rule)',
    '  if (Test-HdoNrptRuleTaggedOwner $Rule) { return $true }',
    '  $comment = [string]$Rule.Comment',
    '  $display = [string]$Rule.DisplayName',
    '  return (($hdoNrptOwnsUntagged -and [string]::IsNullOrEmpty($comment) -and [string]::IsNullOrEmpty($display)) -or (Test-HdoNrptRuleLegacyMigrationCandidate $Rule))',
    '}',
    'function Get-HdoOwnedNrptRules {',
    '  $expectedNamespaces = @($hdoNrptRules | ForEach-Object { [string]$_.Namespace })',
    '  return @(Get-DnsClientNrptRule -ErrorAction SilentlyContinue | Where-Object {',
    '    (Test-HdoNrptRuleTaggedOwner $_) -or',
    '      (Test-HdoNrptRuleLegacyMigrationCandidate $_) -or',
    '      ($hdoNrptOwnsUntagged -and $expectedNamespaces -contains ([string]$_.Namespace) -and',
    '        [string]::IsNullOrEmpty([string]$_.Comment) -and [string]::IsNullOrEmpty([string]$_.DisplayName))',
    '  })',
    '}',
    'function Format-HdoNrptGlobalForLog {',
    '  $global = Get-DnsClientNrptGlobal -ErrorAction SilentlyContinue',
    "  if ($null -eq $global) { return '<null>' }",
    "  return ('QueryPolicy={0}; EnableDAForAllNetworks={1}; SecureNameQueryFallback={2}' -f [string]$global.QueryPolicy, [string]$global.EnableDAForAllNetworks, [string]$global.SecureNameQueryFallback)",
    '}',
    'function Get-HdoLegacyNrptGlobalState {',
    '  if (-not (Test-Path $hdoNrptLegacyGlobalStatePath -ErrorAction SilentlyContinue)) { return $null }',
    '  try {',
    '    $state = Get-Content -Path $hdoNrptLegacyGlobalStatePath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop',
    '    if ([string]$state.QueryPolicy -and [string]$state.EnableDAForAllNetworks) { return $state }',
    '  } catch {',
    "    Write-HdoAudit ('nrpt legacy state ignored path=' + $hdoNrptLegacyGlobalStatePath + ' error=' + ($_ | Out-String).Trim())",
    '  }',
    '  return $null',
    '}',
    'function Test-HdoLegacyStateOwnerActive {',
    '  param([string]$StatePath)',
    '  if (-not $StatePath -or -not (Test-Path $StatePath -ErrorAction SilentlyContinue)) { return $false }',
    '  $baseName = [System.IO.Path]::GetFileNameWithoutExtension($StatePath)',
    "  if ($baseName -notmatch '^nrpt-global-(.+)$') { return $false }",
    '  $legacyTunnelName = [string]$Matches[1]',
    "  $legacyService = Get-Service -Name ('WireGuardTunnel$' + $legacyTunnelName) -ErrorAction SilentlyContinue",
    '  return $null -ne $legacyService',
    '}',
    'function Write-HdoNrptGlobalState {',
    '  param([string]$QueryPolicy, [string]$EnableDAForAllNetworks, [object[]]$Owners)',
    '  if (-not $QueryPolicy -or -not $EnableDAForAllNetworks) { throw "NRPT baseline is incomplete" }',
    '  New-Item -ItemType Directory -Path $hdoNrptStateDir -Force -ErrorAction Stop | Out-Null',
    '  $normalizedOwners = @($Owners | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ } | Sort-Object -Unique)',
    '  $tempPath = $hdoNrptGlobalStatePath + ".tmp"',
    '  [pscustomobject]@{ QueryPolicy = $QueryPolicy; EnableDAForAllNetworks = $EnableDAForAllNetworks; Owners = $normalizedOwners } | ConvertTo-Json -Depth 4 -Compress | Set-Content -Path $tempPath -Encoding UTF8 -ErrorAction Stop',
    '  Move-Item -Path $tempPath -Destination $hdoNrptGlobalStatePath -Force -ErrorAction Stop',
    '  $verified = Get-Content -Path $hdoNrptGlobalStatePath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop',
    '  $verifiedOwners = @($verified.Owners | ForEach-Object { [string]$_ })',
    '  if ([string]$verified.QueryPolicy -ne $QueryPolicy -or [string]$verified.EnableDAForAllNetworks -ne $EnableDAForAllNetworks) { throw "NRPT baseline state read-back mismatch" }',
    '  foreach ($owner in $normalizedOwners) { if ($verifiedOwners -notcontains $owner) { throw ("NRPT owner state read-back missing " + $owner) } }',
    '}',
    'function Save-HdoNrptGlobalState {',
    "  Write-HdoAudit ('nrpt save global before=' + (Format-HdoNrptGlobalForLog))",
    '  $global = Get-DnsClientNrptGlobal -ErrorAction Stop',
    '  if ($null -eq $global) { throw "NRPT global baseline is unavailable" }',
    '  $queryPolicy = [string]$global.QueryPolicy',
    '  $enableAll = [string]$global.EnableDAForAllNetworks',
    '  $owners = @()',
    '  if (Test-Path $hdoNrptGlobalStatePath -ErrorAction Stop) {',
    '    $existing = Get-Content -Path $hdoNrptGlobalStatePath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop',
    '    if (-not [string]$existing.QueryPolicy -or -not [string]$existing.EnableDAForAllNetworks) { throw "Existing NRPT baseline state is incomplete" }',
    '    $queryPolicy = [string]$existing.QueryPolicy',
    '    $enableAll = [string]$existing.EnableDAForAllNetworks',
    '    $owners = @($existing.Owners | ForEach-Object { [string]$_ })',
    '  } else {',
    '    $legacy = Get-HdoLegacyNrptGlobalState',
    '    if ($null -ne $legacy) {',
    '      $queryPolicy = [string]$legacy.QueryPolicy',
    '      $enableAll = [string]$legacy.EnableDAForAllNetworks',
    "      Write-HdoAudit ('nrpt migrated first-owner legacy baseline queryPolicy=' + $queryPolicy + ' enableAll=' + $enableAll)",
    '    }',
    '  }',
    '  $owners = @($owners + $hdoNrptComment | Sort-Object -Unique)',
    '  Write-HdoNrptGlobalState $queryPolicy $enableAll $owners',
    "  Write-HdoAudit ('nrpt saved first-owner baseline path=' + $hdoNrptGlobalStatePath + ' queryPolicy=' + $queryPolicy + ' enableAll=' + $enableAll + ' owners=' + ($owners -join ','))",
    '}',
    'function Test-HdoNrptEnableAllNetworks {',
    '  param([object]$GlobalState)',
    '  $value = [string]$GlobalState.EnableDAForAllNetworks',
    "  return $value -match '^(EnableAlways|EnableDA|True|Enable|Enabled)$'",
    '}',
    'function Enable-HdoNrptGlobalQueryPolicy {',
    '  Save-HdoNrptGlobalState',
    '  $global = Get-DnsClientNrptGlobal -ErrorAction SilentlyContinue',
    "  if ($null -eq $global -or [string]$global.QueryPolicy -ne 'QueryBoth' -or -not (Test-HdoNrptEnableAllNetworks $global)) {",
    '    $setOk = $false',
    '    $setErrors = @()',
    '    foreach ($enableAll in $hdoNrptEnableAttempts) {',
    '      try {',
    "        Set-DnsClientNrptGlobal -QueryPolicy 'QueryBoth' -EnableDAForAllNetworks $enableAll -ErrorAction Stop | Out-Null",
    "        Write-HdoAudit ('nrpt global set ok enable=' + [string]$enableAll)",
    '        $setOk = $true',
    '        break',
    '      } catch {',
    '        $msg = ($_ | Out-String).Trim()',
    "        $setErrors += ('enable=' + [string]$enableAll + ' error=' + $msg)",
    "        Write-HdoAudit ('nrpt global set failed enable=' + [string]$enableAll + ' error=' + $msg)",
    '      }',
    '    }',
    `    if (-not $setOk) { throw (${powerShellString(`${product.shortName} NRPT global policy failed: `)} + ($setErrors -join ' | ')) }`,
    '  }',
    '  $verified = Get-DnsClientNrptGlobal -ErrorAction SilentlyContinue',
    "  Write-HdoAudit ('nrpt global verified=' + (Format-HdoNrptGlobalForLog))",
    "  if ($null -eq $verified -or [string]$verified.QueryPolicy -ne 'QueryBoth' -or -not (Test-HdoNrptEnableAllNetworks $verified)) {",
    `    throw (${powerShellString(`${product.shortName} NRPT global policy is not enabled: `)} + (Format-HdoNrptGlobalForLog))`,
    '  }',
    '}',
    'function Restore-HdoNrptGlobalQueryPolicy {',
    '  if (-not (Test-Path $hdoNrptGlobalStatePath -ErrorAction Stop)) {',
    '    $legacy = Get-HdoLegacyNrptGlobalState',
    '    if ($null -eq $legacy) { throw "NRPT baseline state is missing; refusing to report cleanup complete" }',
    '    Write-HdoNrptGlobalState ([string]$legacy.QueryPolicy) ([string]$legacy.EnableDAForAllNetworks) @($hdoNrptComment)',
    '  }',
    '  $state = Get-Content -Path $hdoNrptGlobalStatePath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop',
    '  $queryPolicy = [string]$state.QueryPolicy',
    '  $enableAllText = [string]$state.EnableDAForAllNetworks',
    '  if (-not $queryPolicy -or -not $enableAllText) { throw "NRPT baseline state is incomplete" }',
    '  $otherRules = @(Get-DnsClientNrptRule -ErrorAction Stop)',
    "  $otherQpjoyOwnerTags = @($otherRules | ForEach-Object { @(([string]$_.Comment), ([string]$_.DisplayName)) } | Where-Object { $_ -match '^MX(?:-[A-Z0-9]+)?(?:\\s+[^/]*)?\\s*/\\s*QPJoy\\s+' -and $_ -ne $hdoNrptComment -and ($null -eq $hdoNrptLegacyComment -or $_ -ne $hdoNrptLegacyComment) })",
    '  $remainingOwners = @($state.Owners | ForEach-Object { [string]$_ } | Where-Object {',
    '    $owner = [string]$_',
    '    $keep = $owner -and $owner -ne $hdoNrptComment -and $owner -ne $hdoNrptLegacyOwnerKey -and ($null -eq $hdoNrptLegacyComment -or $owner -ne $hdoNrptLegacyComment)',
    "    if ($keep -and $owner.StartsWith('legacy-state:', [System.StringComparison]::OrdinalIgnoreCase)) { $keep = Test-HdoLegacyStateOwnerActive ($owner.Substring(13)) }",
    "    elseif ($keep -and $owner -match '^MX(?:-[A-Z0-9]+)?(?:\\s+[^/]*)?\\s*/\\s*QPJoy\\s+') { $keep = $otherQpjoyOwnerTags -contains $owner }",
    '    $keep',
    '  })',
    "  $otherLegacyOwnerKeys = @(Get-ChildItem -Path $hdoNrptLegacySearchRoot -Filter 'nrpt-global-*.json' -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.FullName -ne $hdoNrptLegacyGlobalStatePath -and (Test-HdoLegacyStateOwnerActive ($_.FullName)) } | ForEach-Object { 'legacy-state:' + $_.FullName.ToLowerInvariant() })",
    '  $remainingOwners = @($remainingOwners + $otherQpjoyOwnerTags + $otherLegacyOwnerKeys | Sort-Object -Unique)',
    '  if ($remainingOwners.Count -gt 0) {',
    '    Write-HdoNrptGlobalState $queryPolicy $enableAllText $remainingOwners',
    '    if (Test-Path $hdoNrptLegacyGlobalStatePath -ErrorAction Stop) { Remove-Item -Path $hdoNrptLegacyGlobalStatePath -Force -ErrorAction Stop }',
    "    Write-HdoAudit ('nrpt restore deferred remainingOwners=' + ($remainingOwners -join ',') + ' otherRules=' + [string]$otherRules.Count)",
    '    return',
    '  }',
    '  $enableAll = $null',
    "  if (@('EnableOnNetworkID', 'EnableAlways', 'EnableDA', 'Disable', 'DisableDA') -contains $enableAllText) { $enableAll = $enableAllText }",
    "  if ($enableAllText -match '^(True|Enable|Enabled)$') { $enableAll = 'EnableAlways' }",
    "  if ($enableAllText -match '^(False|Disabled)$') { $enableAll = 'Disable' }",
    "  if (@('Disable', 'QueryIPv6Only', 'QueryBoth') -notcontains $queryPolicy) { throw ('Unsupported NRPT QueryPolicy baseline: ' + $queryPolicy) }",
    "  if ($null -eq $enableAll) { throw ('Unsupported NRPT EnableDAForAllNetworks baseline: ' + $enableAllText) }",
    '  Set-DnsClientNrptGlobal -QueryPolicy $queryPolicy -ErrorAction Stop | Out-Null',
    '  Set-DnsClientNrptGlobal -EnableDAForAllNetworks $enableAll -ErrorAction Stop | Out-Null',
    '  $verified = Get-DnsClientNrptGlobal -ErrorAction Stop',
    '  $verifiedQueryPolicy = [string]$verified.QueryPolicy',
    '  $verifiedEnableAll = [string]$verified.EnableDAForAllNetworks',
    '  $enableVerified = $verifiedEnableAll -eq $enableAll',
    "  if ($enableAll -eq 'EnableAlways') { $enableVerified = $verifiedEnableAll -match '^(EnableAlways|EnableDA|True|Enable|Enabled)$' }",
    "  if ($enableAll -eq 'Disable') { $enableVerified = $verifiedEnableAll -match '^(Disable|DisableDA|False|Disabled)$' }",
    '  if ($verifiedQueryPolicy -ne $queryPolicy -or -not $enableVerified) {',
    `    throw (${powerShellString(`${product.shortName} NRPT global restore read-back mismatch: `)} + ('expected=' + $queryPolicy + '/' + $enableAll + ' actual=' + $verifiedQueryPolicy + '/' + $verifiedEnableAll))`,
    '  }',
    '  if (Test-Path $hdoNrptLegacyGlobalStatePath -ErrorAction SilentlyContinue) { Remove-Item -Path $hdoNrptLegacyGlobalStatePath -Force -ErrorAction Stop }',
    '  Remove-Item -Path $hdoNrptGlobalStatePath -Force -ErrorAction Stop',
    '  if (Test-Path $hdoNrptGlobalStatePath -ErrorAction Stop) { throw "NRPT baseline state remains after verified restore" }',
    "  Write-HdoAudit ('nrpt restored global queryPolicy=' + $queryPolicy + ' enableAll=' + [string]$enableAll)",
    '}',
    'function Get-HdoNormalizedNameServers {',
    '  param([object[]]$Values)',
    '  return @($Values | ForEach-Object { @(([string]$_).Split(",")) } | ForEach-Object { ([string]$_).Trim().ToLowerInvariant() } | Where-Object { $_ } | Sort-Object -Unique)',
    '}',
    'function Test-HdoNrptRuleNameServers {',
    '  param([object]$InstalledRule, [object[]]$ExpectedValues)',
    '  $expected = @(Get-HdoNormalizedNameServers $ExpectedValues)',
    '  $actual = @(Get-HdoNormalizedNameServers @($InstalledRule.NameServers))',
    '  if ($expected.Count -ne $actual.Count) { return $false }',
    '  foreach ($server in $expected) { if ($actual -notcontains $server) { return $false } }',
    '  return $true',
    '}',
    'function Assert-HdoNrptRules {',
    "  Write-HdoAudit ('nrpt assert global=' + (Format-HdoNrptGlobalForLog))",
    '  $missing = @()',
    '  $mismatched = @()',
    '  foreach ($rule in $hdoNrptRules) {',
    '    $installed = @(Get-DnsClientNrptRule -ErrorAction SilentlyContinue | Where-Object { $_.Namespace -eq $rule.Namespace -and (Test-HdoNrptRuleOwned $_) })',
    '    $matching = @($installed | Where-Object { Test-HdoNrptRuleNameServers $_ $rule.NameServers })',
    "    Write-HdoAudit ('nrpt assert namespace=' + $rule.Namespace + ' count=' + [string]$installed.Count + ' matchingNameServers=' + [string]$matching.Count)",
    '    if ($installed.Count -eq 0) { $missing += $rule.Namespace }',
    '    elseif ($matching.Count -ne $installed.Count) { $mismatched += $rule.Namespace }',
    '  }',
    '  $expectedNamespaces = @($hdoNrptRules | ForEach-Object { [string]$_.Namespace })',
    '  $unexpected = @(Get-HdoOwnedNrptRules | Where-Object { $expectedNamespaces -notcontains ([string]$_.Namespace) })',
    `  if ($missing.Count -gt 0) { throw (${powerShellString(`${product.shortName} NRPT rules missing after add: `)} + ($missing -join ', ')) }`,
    `  if ($mismatched.Count -gt 0) { throw (${powerShellString(`${product.shortName} NRPT name servers mismatch after add: `)} + ($mismatched -join ', ')) }`,
    `  if ($unexpected.Count -gt 0) { throw (${powerShellString(`${product.shortName} stale NRPT namespaces remain after add: `)} + (($unexpected | ForEach-Object { [string]$_.Namespace } | Sort-Object -Unique) -join ', ')) }`,
    '}',
    'function Remove-HdoNrptRulesUnlocked {',
    '  param([bool]$RestoreGlobal = $true)',
    "  Write-HdoAudit ('nrpt remove start restoreGlobal=' + [string]$RestoreGlobal)",
    '  $ownerStatePresent = [bool]$hdoNrptMayMigrateUntagged',
    '  if (-not $ownerStatePresent -and (Test-Path $hdoNrptGlobalStatePath -ErrorAction SilentlyContinue)) {',
    '    $ownerState = Get-Content -Path $hdoNrptGlobalStatePath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop',
    '    $ownerStatePresent = @($ownerState.Owners | ForEach-Object { [string]$_ }) -contains $hdoNrptComment',
    '  }',
    '  if ($RestoreGlobal -and $ownerStatePresent) {',
    '    $expectedNamespaces = @($hdoNrptRules | ForEach-Object { [string]$_.Namespace })',
    '    $ambiguousUntagged = @(Get-DnsClientNrptRule -ErrorAction Stop | Where-Object {',
    '      [string]::IsNullOrEmpty([string]$_.Comment) -and',
    '      [string]::IsNullOrEmpty([string]$_.DisplayName) -and',
    '      (-not $hdoNrptOwnershipEvidenceComplete -or $expectedNamespaces -contains ([string]$_.Namespace)) -and',
    '      -not (Test-HdoNrptRuleLegacyMigrationCandidate $_)',
    '    })',
    '    if ($ambiguousUntagged.Count -gt 0) {',
    '      throw "WireGuard ownership evidence is incomplete and untagged NRPT rules are ambiguous; refusing to delete rollback evidence"',
    '    }',
    '  }',
    '  $matches = @(Get-HdoOwnedNrptRules)',
    "  Write-HdoAudit ('nrpt remove ownedMatches=' + [string]$matches.Count + ' namespaces=' + (($matches | ForEach-Object { [string]$_.Namespace } | Sort-Object -Unique) -join ','))",
    '  if ($RestoreGlobal -and $matches.Count -gt 0 -and -not (Test-Path $hdoNrptGlobalStatePath -ErrorAction Stop)) {',
    '    $legacy = Get-HdoLegacyNrptGlobalState',
    '    if ($null -eq $legacy) { throw "NRPT baseline state is missing; refusing to remove owned rules without recoverable cleanup evidence" }',
    '    Write-HdoNrptGlobalState ([string]$legacy.QueryPolicy) ([string]$legacy.EnableDAForAllNetworks) @($hdoNrptComment)',
    '  }',
    '  $matches | ForEach-Object {',
    '    Remove-DnsClientNrptRule -Name $_.Name -Force -ErrorAction SilentlyContinue',
    '  }',
    '  $remaining = @(Get-HdoOwnedNrptRules)',
    `  if ($remaining.Count -gt 0) { throw (${powerShellString(`${product.shortName} owned NRPT rules remain after remove: `)} + (($remaining | ForEach-Object { [string]$_.Namespace } | Sort-Object -Unique) -join ', ')) }`,
    '  if ($RestoreGlobal -and ($matches.Count -gt 0 -or (Test-Path $hdoNrptGlobalStatePath -ErrorAction SilentlyContinue) -or (Test-Path $hdoNrptLegacyGlobalStatePath -ErrorAction SilentlyContinue))) { Restore-HdoNrptGlobalQueryPolicy }',
    '  Clear-DnsClientCache -ErrorAction SilentlyContinue',
    "  Write-HdoAudit ('nrpt remove complete global=' + (Format-HdoNrptGlobalForLog))",
    '}',
    'function Add-HdoNrptRulesUnlocked {',
    "  Write-HdoAudit ('nrpt add start rules=' + [string]$hdoNrptRules.Count)",
    '  if ($hdoNrptRules.Count -eq 0) {',
    '    Remove-HdoNrptRulesUnlocked',
    "    Write-HdoAudit 'nrpt add reconciled empty desired state'",
    '    return',
    '  }',
    '  Enable-HdoNrptGlobalQueryPolicy',
    '  Remove-HdoNrptRulesUnlocked -RestoreGlobal:$false',
    '  foreach ($rule in $hdoNrptRules) {',
    '    $foreign = @(Get-DnsClientNrptRule -ErrorAction SilentlyContinue | Where-Object { $_.Namespace -eq $rule.Namespace -and -not (Test-HdoNrptRuleOwned $_) })',
    "    if ($foreign.Count -gt 0) { Write-HdoAudit ('nrpt conflict namespace=' + $rule.Namespace + ' foreignOwners=' + (($foreign | ForEach-Object { if ([string]$_.Comment) { [string]$_.Comment } else { [string]$_.DisplayName } }) -join ';')) }",
    "    Write-HdoAudit ('nrpt add namespace=' + $rule.Namespace + ' servers=' + ($rule.NameServers -join ','))",
    '    try {',
    '      Add-DnsClientNrptRule -Namespace $rule.Namespace -NameServers $rule.NameServers -DisplayName $hdoNrptComment -Comment $hdoNrptComment -ErrorAction Stop | Out-Null',
    "      Write-HdoAudit ('nrpt add ok namespace=' + $rule.Namespace + ' metadata=true')",
    '    } catch {',
    '      $msg = ($_ | Out-String).Trim()',
    "      Write-HdoAudit ('nrpt add metadata failed namespace=' + $rule.Namespace + ' error=' + $msg)",
    '      if (-not $hdoNrptOwnsUntagged) { throw }',
    '      Add-DnsClientNrptRule -Namespace $rule.Namespace -NameServers $rule.NameServers -ErrorAction Stop | Out-Null',
    "      Write-HdoAudit ('nrpt add ok namespace=' + $rule.Namespace + ' metadata=false')",
    '    }',
    '  }',
    '  Enable-HdoNrptGlobalQueryPolicy',
    '  Assert-HdoNrptRules',
    '  Clear-DnsClientCache -ErrorAction SilentlyContinue',
    "  Write-HdoAudit ('nrpt add complete global=' + (Format-HdoNrptGlobalForLog))",
    '}',
    'function Remove-HdoNrptRules {',
    '  param([bool]$RestoreGlobal = $true)',
    '  $mutex = Enter-HdoNrptMutex',
    '  try { Remove-HdoNrptRulesUnlocked -RestoreGlobal:$RestoreGlobal } finally { Exit-HdoNrptMutex $mutex }',
    '}',
    'function Add-HdoNrptRules {',
    '  $mutex = Enter-HdoNrptMutex',
    '  try { Add-HdoNrptRulesUnlocked } finally { Exit-HdoNrptMutex $mutex }',
    '}'
  ];
}

function windowsLegacyNrptComment(tunnelName: string): string | null {
  return tunnelName.toLowerCase() === 'mx-h2i'
    ? 'MX HDO / QPJoy HDO mx-h2i'
    : null;
}

function isMxH2iTunnel(tunnelName: string): boolean {
  return /^mx-h2i(?:$|[-_.])/i.test(tunnelName);
}

function windowsTunnelProductLabels(tunnelName: string): {
  shortName: string;
  commentPrefix: string;
  programDataDir: string;
} {
  if (isMxH2iTunnel(tunnelName)) {
    return {
      shortName: 'MX-H2I',
      commentPrefix: 'MX-H2I / QPJoy MX-H2I',
      programDataDir: 'QPJoy\\MX-H2I'
    };
  }
  // Every standalone launcher product needs its own label: the NRPT comment
  // decides rule ownership on the shared machine-global table, and the
  // ProgramData dir keeps per-product global-state files apart. Only legacy
  // HDO-era tunnel names keep the historical HDO label.
  const token = /^(?!hdo(?:$|[-_.]))([a-z][a-z0-9]{2,23})(?:$|[-_.])/i.exec(tunnelName)?.[1];
  if (token) {
    const upper = token.toUpperCase();
    const title = token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
    return {
      shortName: upper,
      commentPrefix: `MX-${upper} / QPJoy ${title}`,
      programDataDir: `QPJoy\\${title}`
    };
  }
  return {
    shortName: 'HDO',
    commentPrefix: 'MX HDO / QPJoy HDO',
    programDataDir: 'QPJoy\\HDO'
  };
}

function windowsPowerShellScriptPaths(
  configPath: string,
  tunnelName: string,
  action: WireGuardTunnelAction | 'repair-dns'
): { wrapper: string; elevated: string } {
  const scriptDir = join(dirname(configPath), 'scripts');
  const safeName = tunnelName.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 48) || 'hdo-client';
  const stamp = `${process.pid}-${Date.now()}`;
  return {
    wrapper: join(scriptDir, `${safeName}.${action}.${stamp}.wrapper.ps1`),
    elevated: join(scriptDir, `${safeName}.${action}.${stamp}.elevated.ps1`)
  };
}

function writePowerShellScriptFile(scriptPath: string, script: string): void {
  mkdirSync(dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, `\uFEFF${script.trimEnd()}\n`, 'utf8');
}

function windowsPowerShellCommand(): string {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  const candidates = systemRoot
    ? [
        join(systemRoot, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        join(systemRoot, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      ]
    : [];
  return candidates.find((candidate) => existsSync(candidate)) ?? 'powershell.exe';
}

function wireGuardCommandErrorMessage(command: WireGuardTunnelCommand, err: unknown): string {
  const detail = errorMessage(err);
  const output = commandOutputMessage(err);
  if (isWireGuardAuthorizationCancelled(command, err)) {
    return '已取消 WireGuard 管理员授权。';
  }
  if (command.platform === 'win32') {
    return [
      'Windows WireGuard 系统命令执行失败（未检测到用户取消 UAC）。',
      detail,
      output
    ].filter(Boolean).join(' ');
  }
  return [detail, output].filter(Boolean).join(' ');
}

function isWireGuardAuthorizationCancelled(command: WireGuardTunnelCommand, err: unknown): boolean {
  const detail = [
    errorMessage(err),
    commandOutputMessage(err),
    typeof err === 'object' && err && 'code' in err ? String(err.code) : ''
  ].filter(Boolean).join('\n');
  if (command.platform === 'darwin') return isAppleScriptAuthorizationCancelled(detail);
  if (command.platform !== 'win32') return false;
  return /MX_WIREGUARD_AUTHORIZATION_CANCELED|\b1223\b|operation was cancel(?:ed|led) by the user|用户.*取消|取消.*用户/i.test(detail);
}

function commandOutputMessage(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const row = err as { stdout?: unknown; stderr?: unknown };
  const stderr = typeof row.stderr === 'string' ? row.stderr.trim() : '';
  const stdout = typeof row.stdout === 'string' ? row.stdout.trim() : '';
  return [stderr && `stderr: ${stderr}`, stdout && `stdout: ${stdout}`].filter(Boolean).join(' ');
}

function isAppleScriptAuthorizationCancelled(message: string): boolean {
  return message.includes('(-128)');
}

function isPathLike(value: string): boolean {
  return value.includes('/') || value.includes('\\') || /^[A-Za-z]:/.test(value);
}

function execFileAsync(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      encoding: 'utf8',
      env: options.env,
      windowsHide: true,
      ...(options.timeoutMs ? { timeout: options.timeoutMs } : {})
    }, (err, stdout, stderr) => {
      if (err) {
        (err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }).stdout =
          typeof stdout === 'string' ? stdout : String(stdout ?? '');
        (err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }).stderr =
          typeof stderr === 'string' ? stderr : String(stderr ?? '');
        reject(err);
        return;
      }
      resolve({
        stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
        stderr: typeof stderr === 'string' ? stderr : String(stderr ?? '')
      });
    });
  });
}

function normalizeTimeoutMs(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0
    ? Math.max(1, Math.floor(Number(value)))
    : fallback;
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) {
    throw new Error(`${label} is required`);
  }
}

function routeDestinationToCidr(value: string | undefined): string | null {
  if (!value || value === 'default') return value === 'default' ? '0.0.0.0/0' : null;
  if (value.includes('/')) {
    const [address, prefix] = value.split('/');
    if (!address || !prefix) return null;
    const parts = address.split('.');
    if (parts.length >= 1 && parts.length <= 4 && parts.every((part) => /^\d+$/.test(part))) {
      return normalizeCidr(`${[...parts, ...Array(4 - parts.length).fill('0')].join('.')}/${prefix}`);
    }
    return normalizeCidr(value);
  }
  const parts = value.split('.');
  if (parts.length === 1 && /^\d+$/.test(parts[0])) return normalizeCidr(`${parts[0]}.0.0.0/8`);
  if (parts.length === 2 && parts.every((part) => /^\d+$/.test(part))) {
    return normalizeCidr(`${parts[0]}.${parts[1]}.0.0/16`);
  }
  if (parts.length === 3 && parts.every((part) => /^\d+$/.test(part))) {
    return normalizeCidr(`${parts[0]}.${parts[1]}.${parts[2]}.0/24`);
  }
  if (isIpv4(value)) return normalizeCidr(`${value}/32`);
  return null;
}

function cidrFromAddressAndMask(address: string, mask: string): string | null {
  const maskInt = ipv4ToInt(mask);
  const addressInt = ipv4ToInt(address);
  if (maskInt === null || addressInt === null) return null;
  const prefix = maskToPrefix(maskInt);
  if (prefix === null) return null;
  return normalizeCidr(`${intToIpv4((addressInt & maskInt) >>> 0)}/${prefix}`);
}

function parseIpv4Cidr(value: string): { network: number; prefix: number } | null {
  const [address, prefixRaw] = value.trim().split('/');
  const ip = ipv4ToInt(address);
  if (ip === null) return null;
  const prefix = prefixRaw === undefined ? 32 : Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { network: (ip & mask) >>> 0, prefix };
}

function cidrRange(value: string): { start: number; end: number } | null {
  const parsed = parseIpv4Cidr(value);
  if (!parsed) return null;
  const size = 2 ** (32 - parsed.prefix);
  return {
    start: parsed.network,
    end: (parsed.network + size - 1) >>> 0
  };
}

function subtractRange(
  base: { start: number; end: number },
  exclusion: { start: number; end: number }
): Array<{ start: number; end: number }> {
  if (exclusion.end < base.start || exclusion.start > base.end) return [base];
  const out: Array<{ start: number; end: number }> = [];
  if (exclusion.start > base.start) {
    out.push({ start: base.start, end: Math.min(base.end, exclusion.start - 1) });
  }
  if (exclusion.end < base.end) {
    out.push({ start: Math.max(base.start, exclusion.end + 1), end: base.end });
  }
  return out;
}

function rangeToCidrs(start: number, end: number): string[] {
  const out: string[] = [];
  let cursor = start;
  while (cursor <= end) {
    let blockSize = cursor === 0 ? 2 ** 32 : ((cursor & -cursor) >>> 0);
    if (blockSize === 0) blockSize = 2 ** 32;
    const remaining = end - cursor + 1;
    while (blockSize > remaining) blockSize /= 2;
    const prefix = 32 - Math.log2(blockSize);
    out.push(`${intToIpv4(cursor)}/${prefix}`);
    cursor += blockSize;
  }
  return out;
}

function ipv4ToInt(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    out = ((out << 8) | n) >>> 0;
  }
  return out >>> 0;
}

function intToIpv4(value: number): string {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255
  ].join('.');
}

function prefixToIpv4Mask(prefix: number): string {
  const mask = prefix <= 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return intToIpv4(mask);
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

function isIpv4(value: string): boolean {
  return ipv4ToInt(value) !== null;
}

function normalizeDnsDomain(value: string | null): string | null {
  const text = value?.trim().toLowerCase().replace(/\.+$/, '');
  if (!text || text.length > 253 || text.includes('..')) return null;
  const labels = text.split('.');
  if (labels.length < 2) return null;
  for (const label of labels) {
    if (!label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) return null;
  }
  return text;
}

function uniqueRoutes(routes: HdoLocalRoute[]): HdoLocalRoute[] {
  const seen = new Set<string>();
  return routes.filter((route) => {
    const key = `${route.cidr}:${route.interfaceName ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isString(value: string | null): value is string {
  return typeof value === 'string';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultWireGuardCommandName(): string {
  return process.platform === 'win32' ? 'wg.exe' : 'wg';
}

function platformArchKey(): string {
  return `${process.platform}-${process.arch}`;
}

function optionalWireGuardEnginePackageDir(): string | null {
  const packageName = `@qpjoy/electron-core-wireguard-engine-${platformArchKey()}`;
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-var-requires
    const packageJsonPath = require.resolve(`${packageName}/package.json`);
    return join(packageJsonPath, '..', 'resources', 'wireguard');
  } catch {
    return null;
  }
}
