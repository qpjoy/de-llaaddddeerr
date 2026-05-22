import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, win32 as pathWin32 } from 'node:path';
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
  error?: string | null;
}

export interface HdoLocalRoute {
  cidr: string;
  source: 'darwin-netstat' | 'linux-ip-route' | 'windows-route-print';
  interfaceName?: string | null;
  gateway?: string | null;
  raw?: string | null;
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
  '100.90.0.0/16'
];

const DARWIN_HDO_PRIORITY_ROUTE_PREFIX = 24;

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
  if (config.dns?.length) lines.push(`DNS = ${config.dns.join(', ')}`);
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
  domesticPublicKey: string;
  domesticEndpoint: string;
  allowedIps?: string[];
  dns?: string[];
  mtu?: number | null;
  persistentKeepalive?: number | null;
}): string {
  return renderWireGuardInterface({
    privateKey: input.privateKey,
    addresses: [input.address],
    dns: input.dns,
    mtu: input.mtu,
    peers: [
      {
        name: 'HDO Domestic',
        publicKey: input.domesticPublicKey,
        allowedIps: input.allowedIps?.length ? input.allowedIps : HDO_MESH_ROUTE_CIDRS,
        endpoint: input.domesticEndpoint,
        persistentKeepalive: input.persistentKeepalive ?? 25
      }
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
}): WireGuardTunnelCommand {
  const { runtime, configPath, action } = input;
  if (!configPath.trim()) throw new Error('configPath is required');

  if (runtime.platform === 'win32') {
    const command = runtime.windowsWireGuard?.command;
    if (!command) throw new Error(runtime.error ?? 'wireguard.exe unavailable');
    const tunnelName = pathWin32.basename(configPath).replace(/\.[^.]+$/, '');
    const wireGuardArgs = action === 'down'
      ? ['/uninstalltunnelservice', tunnelName]
      : ['/installtunnelservice', configPath];
    const script = windowsElevatedStartProcessScript(command, wireGuardArgs, action, tunnelName);
    const powershell = windowsPowerShellCommand();
    return {
      action,
      platform: runtime.platform,
      configPath,
      command: powershell,
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(script)],
      displayCommand: `${powershell} -NoProfile -ExecutionPolicy Bypass -EncodedCommand <wireguard-uac-script>`,
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
  const shellCommand = [
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

export async function setWireGuardTunnelState(input: {
  runtime: WireGuardConnectionRuntimeStatus;
  configPath: string;
  action: WireGuardTunnelAction;
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
    return {
      ok: false,
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
    runtime: input.runtime
  };
  if (!input.runtime.available) {
    return {
      ...baseResult,
      ok: false,
      message: input.runtime.error ?? 'WireGuard runtime unavailable'
    };
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

  const routeInstallCidrs = darwinRouteInstallCidrs(profile.allowedIps);
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
    ...routeDownCommands,
    ...routeUpCommands
  ].join('\n');
  const script = `do shell script ${appleScriptString(shellCommand)} with administrator privileges`;
  const displayCommand = `osascript -e ${shellQuote(script)}`;
  try {
    const result = await execFileAsync('osascript', ['-e', script]);
    return {
      ...baseResult,
      ok: true,
      command: displayCommand,
      routeLogTail: readTextTail(baseResult.routeLogPath),
      stdout: result.stdout,
      stderr: result.stderr,
      message: `已把 HDO 路由重新绑定到 ${realInterfaceName}。`
    };
  } catch (err) {
    return {
      ...baseResult,
      ok: false,
      command: displayCommand,
      routeLogTail: readTextTail(baseResult.routeLogPath),
      message: wireGuardCommandErrorMessage({
        action: 'up',
        platform: input.runtime.platform,
        configPath: input.configPath,
        command: 'osascript',
        args: ['-e', script],
        displayCommand,
        needsAdmin: true,
        runtime: input.runtime
      }, err)
    };
  }
}

export function getDarwinWireGuardLaunchDaemonStatus(input: {
  runtime: WireGuardConnectionRuntimeStatus;
  configPath: string;
}): WireGuardLaunchDaemonStatus {
  const base = wireGuardLaunchDaemonUnsupportedStatus(input.runtime, input.configPath);
  if (input.runtime.platform !== 'darwin' || input.runtime.method !== 'darwin-userspace') return base;
  try {
    const assets = darwinLaunchDaemonAssets(input.runtime, input.configPath, { writeSetConfig: false });
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
}): Promise<WireGuardLaunchDaemonResult> {
  const base = getDarwinWireGuardLaunchDaemonStatus(input);
  if (!base.supported) {
    return {
      ...base,
      ok: false,
      command: '',
      message: '当前平台不支持 HDO WireGuard LaunchDaemon。'
    };
  }
  if (!input.runtime.available) {
    return {
      ...base,
      ok: false,
      command: '',
      message: input.runtime.error ?? 'WireGuard runtime unavailable'
    };
  }
  try {
    const assets = darwinLaunchDaemonAssets(input.runtime, input.configPath, { writeSetConfig: true });
    const shellCommand = darwinLaunchDaemonInstallShell(assets);
    const script = `do shell script ${appleScriptString(shellCommand)} with administrator privileges`;
    const displayCommand = `osascript -e ${shellQuote(script)}`;
    const result = await execFileAsync('osascript', ['-e', script]);
    const status = getDarwinWireGuardLaunchDaemonStatus(input);
    return {
      ...status,
      ok: status.loaded || status.installed,
      command: displayCommand,
      routeLogPath: assets.routeLogPath,
      routeLogTail: readTextTail(assets.routeLogPath),
      stdout: result.stdout,
      stderr: result.stderr,
      message: status.loaded
        ? '已安装并启动 HDO WireGuard 系统守护。'
        : '已安装 HDO WireGuard 系统守护，但 launchd 尚未报告运行状态。'
    };
  } catch (err) {
    const status = getDarwinWireGuardLaunchDaemonStatus(input);
    return {
      ...status,
      ok: false,
      command: 'osascript -e <install-hdo-wireguard-launchdaemon>',
      routeLogPath: wireGuardRouteLogPathFromConfig(input.configPath),
      routeLogTail: readTextTail(wireGuardRouteLogPathFromConfig(input.configPath)),
      message: wireGuardCommandErrorMessage({
        action: 'up',
        platform: input.runtime.platform,
        configPath: input.configPath,
        command: 'osascript',
        args: ['-e', '<install-hdo-wireguard-launchdaemon>'],
        displayCommand: 'osascript -e <install-hdo-wireguard-launchdaemon>',
        needsAdmin: true,
        runtime: input.runtime
      }, err)
    };
  }
}

export async function uninstallDarwinWireGuardLaunchDaemon(input: {
  runtime: WireGuardConnectionRuntimeStatus;
  configPath: string;
}): Promise<WireGuardLaunchDaemonResult> {
  const base = getDarwinWireGuardLaunchDaemonStatus(input);
  if (!base.supported) {
    return {
      ...base,
      ok: false,
      command: '',
      message: '当前平台不支持 HDO WireGuard LaunchDaemon。'
    };
  }
  try {
    const assets = darwinLaunchDaemonAssets(input.runtime, input.configPath, { writeSetConfig: false });
    const shellCommand = darwinLaunchDaemonUninstallShell(assets);
    const script = `do shell script ${appleScriptString(shellCommand)} with administrator privileges`;
    const displayCommand = `osascript -e ${shellQuote(script)}`;
    const result = await execFileAsync('osascript', ['-e', script]);
    const status = getDarwinWireGuardLaunchDaemonStatus(input);
    return {
      ...status,
      ok: !status.loaded && !status.installed,
      command: displayCommand,
      routeLogPath: assets.routeLogPath,
      routeLogTail: readTextTail(assets.routeLogPath),
      stdout: result.stdout,
      stderr: result.stderr,
      message: '已卸载 HDO WireGuard 系统守护。'
    };
  } catch (err) {
    const status = getDarwinWireGuardLaunchDaemonStatus(input);
    return {
      ...status,
      ok: false,
      command: 'osascript -e <uninstall-hdo-wireguard-launchdaemon>',
      routeLogPath: wireGuardRouteLogPathFromConfig(input.configPath),
      routeLogTail: readTextTail(wireGuardRouteLogPathFromConfig(input.configPath)),
      message: wireGuardCommandErrorMessage({
        action: 'down',
        platform: input.runtime.platform,
        configPath: input.configPath,
        command: 'osascript',
        args: ['-e', '<uninstall-hdo-wireguard-launchdaemon>'],
        displayCommand: 'osascript -e <uninstall-hdo-wireguard-launchdaemon>',
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
  if (input.runtime.platform === 'win32') {
    const wg = input.runtime.wg.command;
    if (wg) {
      const dump = tryExecFile(wg, ['show', profile.interfaceName, 'dump']);
      if (dump.ok) {
        const rawDump = dump.stdout.trim();
        return {
          ...status,
          active: true,
          peers: parseWireGuardDump(rawDump),
          rawDump,
          routes: detectInterfaceRoutes(profile.interfaceName),
          ifconfig: readInterfaceState(profile.interfaceName)
        };
      }
    }
    const serviceState = readWindowsTunnelServiceState(profile.interfaceName);
    return {
      ...status,
      active: serviceState === 'RUNNING',
      routes: detectInterfaceRoutes(profile.interfaceName),
      ifconfig: readInterfaceState(profile.interfaceName),
      error: serviceState ? null : `WireGuard tunnel service WireGuardTunnel$${profile.interfaceName} 未安装`
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
    const routeProbes = darwinRouteProbeResults(profile.allowedIps, realInterfaceName);
    return {
      ...status,
      active: true,
      peers,
      rawDump,
      routes,
      routeProbes,
      missingRoutes: routeProbes.length
        ? routeProbes.filter((probe) => !probe.ok).map((probe) => probe.cidr)
        : missingInterfaceRoutes(input.runtime, profile.allowedIps, routes),
      routeLogTail: readTextTail(status.routeLogPath),
      ifconfig: readInterfaceState(realInterfaceName)
    };
  }

  const routes = detectInterfaceRoutes(realInterfaceName);
  const ifconfig = readInterfaceState(realInterfaceName);
  const hasConfiguredAddress = Boolean(
    ifconfig && profile.addresses.some((address) => ifconfig.includes(`inet ${address.split('/')[0]}`))
  );
  if (ifconfig && interfaceStateIsUp(ifconfig) && hasConfiguredAddress) {
    const routeProbes = darwinRouteProbeResults(profile.allowedIps, realInterfaceName);
    return {
      ...status,
      active: true,
      peers: [],
      rawDump: null,
      routes,
      routeProbes,
      missingRoutes: routeProbes.length
        ? routeProbes.filter((probe) => !probe.ok).map((probe) => probe.cidr)
        : missingInterfaceRoutes(input.runtime, profile.allowedIps, routes),
      routeLogTail: readTextTail(status.routeLogPath),
      ifconfig
    };
  }
  const routeProbes = darwinRouteProbeResults(profile.allowedIps, realInterfaceName);
  return {
    ...status,
    ok: false,
    error: dump.stderr.trim() || dump.error || `wg show ${realInterfaceName} failed`,
    routes,
    routeProbes,
    missingRoutes: routeProbes.length
      ? routeProbes.filter((probe) => !probe.ok).map((probe) => probe.cidr)
      : missingInterfaceRoutes(input.runtime, profile.allowedIps, routes),
    routeLogTail: readTextTail(status.routeLogPath),
    ifconfig
  };
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

function priorityIpv4CidrAtPrefix(cidr: string, targetPrefix: number): string[] {
  const parsed = parseIpv4Cidr(normalizeCidr(cidr) ?? cidr);
  if (!parsed) return [];
  if (parsed.prefix >= targetPrefix) {
    return [normalizeCidr(`${intToIpv4(parsed.network)}/${parsed.prefix}`) ?? cidr];
  }
  return [`${intToIpv4(parsed.network)}/${targetPrefix}`];
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
  const routeInstallCidrs = darwinRouteInstallCidrs(profile.allowedIps);
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
  const addressCommands = profile.addresses.map((address) => {
    if (address.includes(':')) return `ifconfig "$REAL_INTERFACE" inet6 ${shellQuote(address)} alias`;
    const ip = address.split('/')[0] ?? address;
    return `ifconfig "$REAL_INTERFACE" inet ${shellQuote(ip)} ${shellQuote(ip)} netmask 255.255.255.255 alias || ifconfig "$REAL_INTERFACE" inet ${shellQuote(ip)} ${shellQuote(ip)} netmask 255.255.255.255`;
  });
  const addressDownCommands = profile.addresses.map((address) => {
    const ip = address.split('/')[0] ?? address;
    if (address.includes(':')) return `ifconfig "$REAL_INTERFACE" inet6 ${shellQuote(ip)} -alias >/dev/null 2>&1 || true`;
    return `ifconfig "$REAL_INTERFACE" inet ${shellQuote(ip)} ${shellQuote(ip)} -alias >/dev/null 2>&1 || ifconfig "$REAL_INTERFACE" inet ${shellQuote(ip)} -alias >/dev/null 2>&1 || true`;
  });
  const staleHdoInterfaceCleanupLines = [
    'for candidate in $(ifconfig -l 2>/dev/null); do',
    '  case "$candidate" in utun*) ;; *) continue ;; esac',
    '  candidate_state="$(ifconfig "$candidate" 2>/dev/null || true)"',
    `  printf '%s\\n' "$candidate_state" | awk '/inet 100[.](88|89|90)[.]/{found=1} END{exit found?0:1}' >/dev/null 2>&1 || continue`,
    ...routeDownCommands.map((line) => `  ${line.replaceAll('"$REAL_INTERFACE"', '"$candidate"')}`),
    `  for hdo_ip in $(printf '%s\\n' "$candidate_state" | awk '/inet 100[.](88|89|90)[.]/{print $2}'); do ifconfig "$candidate" inet "$hdo_ip" "$hdo_ip" -alias >/dev/null 2>&1 || ifconfig "$candidate" inet "$hdo_ip" -alias >/dev/null 2>&1 || true; done`,
    '  ifconfig "$candidate" down >/dev/null 2>&1 || true',
    '  rm -f "/var/run/wireguard/$candidate.sock"',
    'done'
  ];
  const primaryAddress = profile.addresses[0]?.split('/')[0] ?? '';
  const stopLines = [
    ...darwinRouteLogSetupLines(configPath, profile.interfaceName, action === 'down' ? 'down' : 'restart-stop'),
    'mkdir -p /var/run/wireguard',
    `REAL_INTERFACE="$(cat ${shellQuote(nameFile)} 2>/dev/null || true)"`,
    `if [ -z "$REAL_INTERFACE" ] && [ -n ${shellQuote(primaryAddress)} ]; then for candidate in $(ifconfig -l 2>/dev/null); do if ifconfig "$candidate" 2>/dev/null | grep -q ${shellQuote(`inet ${primaryAddress}`)}; then REAL_INTERFACE="$candidate"; break; fi; done; fi`,
    `echo ${shellQuote('realInterfaceBeforeStop=')}"$REAL_INTERFACE" >> "$ROUTE_LOG" 2>&1`,
    `if [ -n "$REAL_INTERFACE" ]; then`,
    ...routeDownCommands.map((line) => `  ${line}`),
    ...addressDownCommands.map((line) => `  ${line}`),
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
    ...staleHdoInterfaceCleanupLines,
    `if command -v pgrep >/dev/null 2>&1; then for stale_pid in $(pgrep -x wireguard-go 2>/dev/null || true); do stale_command="$(ps -p "$stale_pid" -o command= 2>/dev/null || true)"; printf '%s\\n' "$stale_command" | grep -F ${shellQuote(wireGuardGo)} >/dev/null 2>&1 && kill "$stale_pid" >/dev/null 2>&1 || true; done; fi`,
    `rm -f ${shellQuote(nameFile)} ${shellQuote(pidFile)}`
  ];
  const startLines = [
    ...darwinRouteLogSetupLines(configPath, profile.interfaceName, action),
    'mkdir -p /var/run/wireguard',
    `rm -f ${shellQuote(nameFile)} ${shellQuote(pidFile)}`,
    `BEFORE_INTERFACES="$(${shellQuote(wg)} show interfaces 2>/dev/null || true)"`,
    `WG_PROCESS_FOREGROUND=1 WG_TUN_NAME_FILE=${shellQuote(nameFile)} ${shellQuote(wireGuardGo)} utun >${shellQuote(logFile)} 2>&1 &`,
    `echo "$!" > ${shellQuote(pidFile)}`,
    `chmod 644 ${shellQuote(pidFile)} >/dev/null 2>&1 || true`,
    `i=0; while [ ! -s ${shellQuote(nameFile)} ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done`,
    `REAL_INTERFACE="$(cat ${shellQuote(nameFile)} 2>/dev/null || true)"`,
    `if [ -z "$REAL_INTERFACE" ]; then AFTER_INTERFACES="$(${shellQuote(wg)} show interfaces 2>/dev/null || true)"; for candidate in $AFTER_INTERFACES; do case " $BEFORE_INTERFACES " in *" $candidate "*) ;; *) REAL_INTERFACE="$candidate"; break ;; esac; done; fi`,
    '[ -n "$REAL_INTERFACE" ]',
    `echo ${shellQuote('realInterface=')}"$REAL_INTERFACE" >> "$ROUTE_LOG" 2>&1`,
    `echo "$REAL_INTERFACE" > ${shellQuote(nameFile)}`,
    `chmod 644 ${shellQuote(nameFile)} >/dev/null 2>&1 || true`,
    `${shellQuote(wg)} setconf "$REAL_INTERFACE" ${shellQuote(profile.setConfigPath)}`,
    'ifconfig "$REAL_INTERFACE" up',
    ...addressCommands,
    ...routeDownCommands,
    ...routeUpCommands
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
    setConfigPath
  };
}

interface DarwinLaunchDaemonAssets {
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
  options: { writeSetConfig?: boolean } = {}
): DarwinLaunchDaemonAssets {
  const wg = runtime.wg.command;
  const wireGuardGo = runtime.wireGuardGo?.command;
  if (!wg || !wireGuardGo) throw new Error(runtime.error ?? 'darwin userspace WireGuard runtime unavailable');
  const profile = options.writeSetConfig === false
    ? inspectDarwinUserspaceProfile(configPath)
    : prepareDarwinUserspaceProfile(configPath);
  const component = sanitizeLaunchDaemonComponent(profile.interfaceName);
  const label = `com.qpjoy.hdo.wireguard.${component}`;
  const supportDir = `/Library/Application Support/QPJoy/HDO/${component}`;
  const binDir = `${supportDir}/bin`;
  const logDir = '/Library/Logs/QPJoy-HDO';
  return {
    label,
    supportDir,
    binDir,
    logDir,
    plistPath: `/Library/LaunchDaemons/${label}.plist`,
    daemonScriptPath: `${supportDir}/hdo-wireguard-daemon.sh`,
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
    profile
  };
}

function darwinLaunchDaemonInstallShell(assets: DarwinLaunchDaemonAssets): string {
  const daemonScript = darwinLaunchDaemonScript(assets);
  const plist = darwinLaunchDaemonPlist(assets);
  return [
    'set -e',
    `LABEL=${shellQuote(assets.label)}`,
    `PLIST=${shellQuote(assets.plistPath)}`,
    `SUPPORT_DIR=${shellQuote(assets.supportDir)}`,
    `BIN_DIR=${shellQuote(assets.binDir)}`,
    `LOG_DIR=${shellQuote(assets.logDir)}`,
    'launchctl bootout "system/$LABEL" >/dev/null 2>&1 || launchctl bootout system "$PLIST" >/dev/null 2>&1 || true',
    'mkdir -p "$SUPPORT_DIR" "$BIN_DIR" "$LOG_DIR" /var/run/wireguard',
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
    'launchctl bootstrap system "$PLIST"',
    'launchctl enable "system/$LABEL" >/dev/null 2>&1 || true',
    'launchctl kickstart -k "system/$LABEL" >/dev/null 2>&1 || true',
    'launchctl print "system/$LABEL" >/dev/null'
  ].join('\n');
}

function darwinLaunchDaemonUninstallShell(assets: DarwinLaunchDaemonAssets): string {
  return [
    'set -e',
    `LABEL=${shellQuote(assets.label)}`,
    `PLIST=${shellQuote(assets.plistPath)}`,
    `SUPPORT_DIR=${shellQuote(assets.supportDir)}`,
    `PID_FILE=${shellQuote(assets.pidFile)}`,
    `WIREGUARD_GO=${shellQuote(assets.rootWireGuardGoPath)}`,
    'launchctl bootout "system/$LABEL" >/dev/null 2>&1 || launchctl bootout system "$PLIST" >/dev/null 2>&1 || true',
    'if [ -s "$PID_FILE" ]; then WG_PID="$(cat "$PID_FILE" 2>/dev/null || true)"; if [ -n "$WG_PID" ]; then kill "$WG_PID" >/dev/null 2>&1 || true; sleep 0.2; kill -9 "$WG_PID" >/dev/null 2>&1 || true; fi; fi',
    'if command -v pgrep >/dev/null 2>&1; then for stale_pid in $(pgrep -x wireguard-go 2>/dev/null || true); do stale_command="$(ps -p "$stale_pid" -o command= 2>/dev/null || true)"; printf \'%s\\n\' "$stale_command" | grep -F "$WIREGUARD_GO" >/dev/null 2>&1 && kill "$stale_pid" >/dev/null 2>&1 || true; done; fi',
    `rm -f ${shellQuote(assets.plistPath)} ${shellQuote(assets.nameFile)} ${shellQuote(assets.pidFile)}`,
    `rm -rf ${shellQuote(assets.supportDir)}`
  ].join('\n');
}

function darwinLaunchDaemonScript(assets: DarwinLaunchDaemonAssets): string {
  const profile = assets.profile;
  const routeInstallCidrs = darwinRouteInstallCidrs(profile.allowedIps);
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
  const addressCommands = profile.addresses.map((address) => {
    if (address.includes(':')) return `ifconfig "$REAL_INTERFACE" inet6 ${shellQuote(address)} alias`;
    const ip = address.split('/')[0] ?? address;
    return `ifconfig "$REAL_INTERFACE" inet ${shellQuote(ip)} ${shellQuote(ip)} netmask 255.255.255.255 alias || ifconfig "$REAL_INTERFACE" inet ${shellQuote(ip)} ${shellQuote(ip)} netmask 255.255.255.255`;
  });
  const addressDownCommands = profile.addresses.map((address) => {
    const ip = address.split('/')[0] ?? address;
    if (address.includes(':')) return `ifconfig "$REAL_INTERFACE" inet6 ${shellQuote(ip)} -alias >/dev/null 2>&1 || true`;
    return `ifconfig "$REAL_INTERFACE" inet ${shellQuote(ip)} ${shellQuote(ip)} -alias >/dev/null 2>&1 || ifconfig "$REAL_INTERFACE" inet ${shellQuote(ip)} -alias >/dev/null 2>&1 || true`;
  });
  const primaryAddress = profile.addresses[0]?.split('/')[0] ?? '';
  const staleHdoInterfaceCleanupLines = [
    'for candidate in $(ifconfig -l 2>/dev/null); do',
    '  case "$candidate" in utun*) ;; *) continue ;; esac',
    '  candidate_state="$(ifconfig "$candidate" 2>/dev/null || true)"',
    `  printf '%s\\n' "$candidate_state" | awk '/inet 100[.](88|89|90)[.]/{found=1} END{exit found?0:1}' >/dev/null 2>&1 || continue`,
    ...routeDownCommands.map((line) => `  ${line.replaceAll('"$REAL_INTERFACE"', '"$candidate"')}`),
    `  for hdo_ip in $(printf '%s\\n' "$candidate_state" | awk '/inet 100[.](88|89|90)[.]/{print $2}'); do ifconfig "$candidate" inet "$hdo_ip" "$hdo_ip" -alias >/dev/null 2>&1 || ifconfig "$candidate" inet "$hdo_ip" -alias >/dev/null 2>&1 || true; done`,
    '  ifconfig "$candidate" down >/dev/null 2>&1 || true',
    '  rm -f "/var/run/wireguard/$candidate.sock"',
    'done'
  ];

  return [
    '#!/bin/sh',
    'set -u',
    `INTERFACE_NAME=${shellQuote(profile.interfaceName)}`,
    `WG=${shellQuote(assets.rootWgPath)}`,
    `WIREGUARD_GO=${shellQuote(assets.rootWireGuardGoPath)}`,
    `SETCONF=${shellQuote(assets.rootSetConfigPath)}`,
    `NAME_FILE=${shellQuote(assets.nameFile)}`,
    `PID_FILE=${shellQuote(assets.pidFile)}`,
    `ROUTE_LOG=${shellQuote(assets.routeLogPath)}`,
    `WG_GO_LOG=${shellQuote(assets.wireGuardGoLogPath)}`,
    `PRIMARY_ADDRESS=${shellQuote(primaryAddress)}`,
    'mkdir -p /var/run/wireguard "$(dirname "$ROUTE_LOG")" "$(dirname "$WG_GO_LOG")"',
    'touch "$ROUTE_LOG" "$WG_GO_LOG"',
    'chmod 644 "$ROUTE_LOG" "$WG_GO_LOG" >/dev/null 2>&1 || true',
    'log_route() { printf "%s\\n" "$*" >> "$ROUTE_LOG" 2>&1; }',
    'log_action() { log_route "---"; log_route "action=$1"; log_route "timestamp=$(date -u \'+%Y-%m-%dT%H:%M:%SZ\')"; log_route "interface=$INTERFACE_NAME"; }',
    'cleanup() {',
    '  code="${1:-0}"',
    '  log_action "launchdaemon-cleanup"',
    '  log_route "exit=$code"',
    '  REAL_INTERFACE="$(cat "$NAME_FILE" 2>/dev/null || true)"',
    '  if [ -z "$REAL_INTERFACE" ] && [ -n "$PRIMARY_ADDRESS" ]; then for candidate in $(ifconfig -l 2>/dev/null); do if ifconfig "$candidate" 2>/dev/null | grep -q "inet $PRIMARY_ADDRESS"; then REAL_INTERFACE="$candidate"; break; fi; done; fi',
    '  if [ -n "$REAL_INTERFACE" ]; then',
    ...routeDownCommands.map((line) => `    ${line}`),
    ...addressDownCommands.map((line) => `    ${line}`),
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
    'cleanup 0 >/dev/null 2>&1 || true',
    'log_action "launchdaemon-start"',
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
    'echo "$REAL_INTERFACE" > "$NAME_FILE"',
    'chmod 644 "$NAME_FILE" >/dev/null 2>&1 || true',
    'log_route "realInterface=$REAL_INTERFACE"',
    '"$WG" setconf "$REAL_INTERFACE" "$SETCONF"',
    'ifconfig "$REAL_INTERFACE" up',
    ...addressCommands,
    ...routeDownCommands,
    ...routeUpCommands,
    'wait "$WG_PID"',
    'exit "$?"'
  ].join('\n') + '\n';
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

function darwinRouteInstallCidrs(allowedIps: string[]): string[] {
  return uniqueStrings([
    ...darwinCriticalHdoRouteCidrs(allowedIps),
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
  return `${check} || (\n${darwinRouteDeleteCommand(cidr)}\n${darwinRouteInstallCommand(cidr, interfaceArg)}\n${check}\n)`;
}

function darwinRouteProbeLogCommand(cidr: string, interfaceArg: string, logArg: string): string {
  const target = darwinRouteProbeTarget(cidr);
  if (!target) return 'true';
  return `{ echo ${shellQuote(`route=${normalizeCidr(cidr) ?? cidr}`)}; echo ${shellQuote(`target=${target}`)}; echo ${shellQuote('expected=')}${interfaceArg}; route -n get ${shellQuote(target)} 2>&1; } >> ${logArg} 2>&1`;
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
  const parsed = parseIpv4Cidr(normalizeCidr(cidr) ?? cidr);
  if (!parsed) return null;
  if (parsed.prefix >= 31) return intToIpv4(parsed.network);
  return intToIpv4((parsed.network + 1) >>> 0);
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

function darwinRouteProbeResults(
  allowedIps: string[],
  expectedInterface: string
): WireGuardRouteProbeStatus[] {
  return darwinRequiredHealthyRouteCidrs(allowedIps)
    .map((cidr) => normalizeCidr(cidr) ?? cidr)
    .filter((cidr) => cidr.includes('/'))
    .flatMap((cidr): WireGuardRouteProbeStatus[] => {
      const target = darwinRouteProbeTarget(cidr);
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
    return null;
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

function darwinCriticalHdoRouteCidrs(allowedIps: string[]): string[] {
  const normalizedAllowed = allowedIps
    .map((cidr) => normalizeCidr(cidr) ?? cidr)
    .filter((cidr) => cidr.includes('/'));
  if (normalizedAllowed.length === 0) return [];

  // macOS/Clash TUN route priority is longest-prefix first; add the active
  // HDO base /24s so common mesh traffic stays on the WireGuard utun.
  return uniqueStrings(HDO_MESH_ROUTE_CIDRS.flatMap((hdoCidr) => {
    const priorityCidrs = priorityIpv4CidrAtPrefix(hdoCidr, DARWIN_HDO_PRIORITY_ROUTE_PREFIX);
    return priorityCidrs.filter((priorityCidr) =>
      normalizedAllowed.some((allowedCidr) => cidrContains(allowedCidr, priorityCidr))
    );
  }));
}

function darwinRequiredHealthyRouteCidrs(allowedIps: string[]): string[] {
  const priorityCidrs = darwinCriticalHdoRouteCidrs(allowedIps);
  const normalizedAllowed = allowedIps
    .map((cidr) => normalizeCidr(cidr) ?? cidr)
    .filter((cidr) => cidr.includes('/'));
  return uniqueStrings([
    ...normalizedAllowed.filter((allowedCidr) =>
      !priorityCidrs.some((priorityCidr) => cidrContains(allowedCidr, priorityCidr))
    ),
    ...priorityCidrs
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
  setConfigLines: string[];
} {
  const raw = readFileSync(configPath, 'utf8');
  const interfaceName = wireGuardInterfaceName(configPath);
  const addresses: string[] = [];
  const allowedIps: string[] = [];
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
    if (section === 'peer' && key === 'allowedips') {
      allowedIps.push(...valueList(line));
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
        if (value && interfaceHasAnyConfiguredAddress(value, addresses)) return value;
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
  routes: string[]
): string[] {
  if (runtime.platform !== 'darwin') return [];
  const routeCidrs = routes
    .map((line) => routeDestinationToCidr(line.trim().split(/\s+/)[0]))
    .filter(isString);
  const requiredCidrs = darwinRequiredHealthyRouteCidrs(allowedIps)
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

function readWindowsTunnelServiceState(interfaceName: string): string | null {
  const raw = tryExecFile('sc.exe', ['query', `WireGuardTunnel$${interfaceName}`]).stdout
    || tryExecFile('sc', ['query', `WireGuardTunnel$${interfaceName}`]).stdout;
  const match = raw?.match(/STATE\s*:\s*\d+\s+([A-Z_]+)/i);
  return match?.[1]?.toUpperCase() ?? null;
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
  const gateway = route.gateway ? ipv4ToInt(route.gateway) : null;
  if (!range || gateway === null) return false;
  const proxyGatewayStart = ipv4ToInt('198.18.0.0');
  const proxyGatewayEnd = ipv4ToInt('198.19.255.255');
  if (proxyGatewayStart === null || proxyGatewayEnd === null) return false;
  if (gateway < proxyGatewayStart || gateway > proxyGatewayEnd) return false;
  const prefix = prefixFromRange(range);
  return prefix !== null && prefix <= 8;
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

function tryExecFile(command: string, args: string[]): { ok: boolean; stdout: string; stderr: string; error?: string } {
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: 3000,
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

function windowsElevatedStartProcessScript(
  command: string,
  args: string[],
  action: WireGuardTunnelAction,
  tunnelName: string
): string {
  const serviceName = `WireGuardTunnel$${tunnelName}`;
  const serviceArg = powerShellString(serviceName);
  const serviceLookup = `$svc = Get-Service -Name ${serviceArg} -ErrorAction SilentlyContinue`;
  const preflightLines = action === 'up'
    ? [serviceLookup, "if ($null -ne $svc -and $svc.Status -eq 'Running') { exit 0 }"]
    : (action === 'down' ? [serviceLookup, 'if ($null -eq $svc) { exit 0 }'] : []);
  const runWireGuard = (wireGuardArgs: string[]) => `& ${powerShellString(command)} ${wireGuardArgs.map(powerShellString).join(' ')}`;
  const waitForServiceAbsent = () => [
    '$deadline = (Get-Date).AddSeconds(12)',
    'while ($true) {',
    `  $svc = Get-Service -Name ${serviceArg} -ErrorAction SilentlyContinue`,
    '  if ($null -eq $svc) { break }',
    `  if ((Get-Date) -gt $deadline) { throw ${powerShellString(`Timed out waiting for ${serviceName} to be removed`)} }`,
    '  Start-Sleep -Milliseconds 250',
    '}'
  ];
  const waitForServiceRunning = () => [
    '$deadline = (Get-Date).AddSeconds(20)',
    'while ($true) {',
    `  $svc = Get-Service -Name ${serviceArg} -ErrorAction SilentlyContinue`,
    "  if ($null -ne $svc -and $svc.Status -eq 'Running') { break }",
    `  if ($null -ne $svc -and $svc.Status -eq 'Stopped') { Start-Service -Name ${serviceArg} -ErrorAction SilentlyContinue }`,
    `  if ((Get-Date) -gt $deadline) { throw ${powerShellString(`Timed out waiting for ${serviceName} to be running`)} }`,
    '  Start-Sleep -Milliseconds 500',
    '}'
  ];
  const elevatedLines: string[] = [
    "$ErrorActionPreference = 'Stop'",
    serviceLookup
  ];
  if (action === 'up') {
    elevatedLines.push(
      "if ($null -ne $svc -and $svc.Status -eq 'Running') { exit 0 }",
      `if ($null -ne $svc) {`,
      `  Start-Service -Name ${serviceArg} -ErrorAction SilentlyContinue`,
      ...waitForServiceRunning(),
      '  exit 0',
      '}'
    );
  } else if (action === 'down') {
    elevatedLines.push('if ($null -eq $svc) { exit 0 }');
  } else {
    elevatedLines.push(
      'if ($null -ne $svc) {',
      `  if ($svc.Status -ne 'Stopped') { Stop-Service -Name ${serviceArg} -Force -ErrorAction SilentlyContinue }`,
      `  ${runWireGuard(['/uninstalltunnelservice', tunnelName])}`,
      '  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
      ...waitForServiceAbsent(),
      '}'
    );
  }
  elevatedLines.push(
    runWireGuard(args),
    'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
    ...(action === 'down' ? waitForServiceAbsent() : waitForServiceRunning()),
    'exit 0'
  );
  const elevatedEncoded = encodePowerShell(elevatedLines.join('\n'));
  return [
    "$ErrorActionPreference = 'Stop'",
    ...preflightLines,
    "$pwsh = Join-Path $PSHOME 'powershell.exe'",
    `$p = Start-Process -FilePath $pwsh -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ${powerShellString(elevatedEncoded)}) -Verb RunAs -Wait -PassThru`,
    'if ($null -ne $p.ExitCode) { exit $p.ExitCode }'
  ].join('\n');
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

function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function wireGuardCommandErrorMessage(command: WireGuardTunnelCommand, err: unknown): string {
  const detail = errorMessage(err);
  if (command.platform === 'darwin' && isAppleScriptAuthorizationCancelled(detail)) {
    return '已取消 WireGuard 管理员授权。';
  }
  if (command.platform === 'win32') {
    return [
      'Windows 启停 WireGuard 需要管理员授权。',
      '请在弹出的 UAC 窗口点击“是”；如果没有弹窗，请用“以管理员身份运行”启动 QPJoy 后重试。',
      detail
    ].filter(Boolean).join(' ');
  }
  return detail;
}

function isAppleScriptAuthorizationCancelled(message: string): boolean {
  return message.includes('(-128)')
    || message.includes('用户已取消')
    || /user canceled/i.test(message)
    || /cancelled/i.test(message);
}

function isPathLike(value: string): boolean {
  return value.includes('/') || value.includes('\\') || /^[A-Za-z]:/.test(value);
}

function execFileAsync(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      encoding: 'utf8',
      env: options.env,
      windowsHide: true
    }, (err, stdout, stderr) => {
      if (err) {
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
