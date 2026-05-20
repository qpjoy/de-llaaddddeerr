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
  stdout?: string;
  stderr?: string;
  message: string;
  runtime: WireGuardConnectionRuntimeStatus;
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

export interface WireGuardTunnelStatus {
  ok: boolean;
  active: boolean;
  mode: WireGuardConnectionRuntimeStatus['method'];
  interfaceName: string | null;
  realInterfaceName: string | null;
  configPath: string;
  addresses: string[];
  allowedIps: string[];
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
    stdout: result.stdout,
    stderr: result.stderr,
    message: input.action === 'down'
      ? '已停止 WireGuard peer。'
      : (input.action === 'restart' ? '已更新并启动 WireGuard peer。' : '已启动 WireGuard peer。'),
    runtime: command.runtime
  };
}

export function getWireGuardTunnelStatus(input: {
  runtime: WireGuardConnectionRuntimeStatus;
  configPath: string;
}): WireGuardTunnelStatus {
  const profile = parseWireGuardProfile(input.configPath);
  const realInterfaceName = resolveWireGuardRealInterface(input.runtime, profile.interfaceName);
  const status: WireGuardTunnelStatus = {
    ok: true,
    active: false,
    mode: input.runtime.method,
    interfaceName: profile.interfaceName,
    realInterfaceName,
    configPath: input.configPath,
    addresses: profile.addresses,
    allowedIps: uniqueStrings(profile.allowedIps),
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

  try {
    const rawDump = execFileSync(wg, ['show', realInterfaceName, 'dump'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true
    }).trim();
    const peers = parseWireGuardDump(rawDump);
    return {
      ...status,
      active: true,
      peers,
      rawDump,
      routes: detectInterfaceRoutes(realInterfaceName),
      ifconfig: readInterfaceState(realInterfaceName)
    };
  } catch (err) {
    return {
      ...status,
      ok: false,
      error: errorMessage(err),
      routes: detectInterfaceRoutes(realInterfaceName),
      ifconfig: readInterfaceState(realInterfaceName)
    };
  }
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
  const routeCidrs = routes.map((row) => normalizeCidr(row.cidr)).filter(isString);
  const localCidrs = uniqueStrings([
    ...routeCidrs,
    ...(input.localCidrs ?? []).map((cidr) => normalizeCidr(cidr)).filter(isString)
  ]).filter((cidr) => cidr !== '0.0.0.0/0');
  const hdoCidrs = uniqueStrings(
    (input.hdoCidrs ?? HDO_MESH_ROUTE_CIDRS).map((cidr) => normalizeCidr(cidr)).filter(isString)
  );
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
      interfaceName: columns[5] ?? null,
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
  const routeCommands = profile.allowedIps
    .filter((cidr) => cidr.includes('/'))
    .map((cidr) => {
      const family = cidr.includes(':') ? '-inet6 -net' : '-net';
      return action === 'up'
        ? `route -q -n delete ${family} ${shellQuote(cidr)} >/dev/null 2>&1 || true\nroute -q -n add ${family} ${shellQuote(cidr)} -interface "$REAL_INTERFACE"`
        : `route -q -n delete ${family} ${shellQuote(cidr)} >/dev/null 2>&1 || true`;
    });
  const addressCommands = profile.addresses.map((address) => {
    if (address.includes(':')) return `ifconfig "$REAL_INTERFACE" inet6 ${shellQuote(address)} alias`;
    return `ifconfig "$REAL_INTERFACE" inet ${shellQuote(address)} ${shellQuote(address.split('/')[0])} alias`;
  });
  const primaryAddress = profile.addresses[0]?.split('/')[0] ?? '';
  const scriptLines = action === 'up'
    ? [
        'set -e',
        'mkdir -p /var/run/wireguard',
        `rm -f ${shellQuote(nameFile)}`,
        `BEFORE_INTERFACES="$(${shellQuote(wg)} show interfaces 2>/dev/null || true)"`,
        `WG_TUN_NAME_FILE=${shellQuote(nameFile)} ${shellQuote(wireGuardGo)} utun`,
        `i=0; while [ ! -s ${shellQuote(nameFile)} ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done`,
        `REAL_INTERFACE="$(cat ${shellQuote(nameFile)} 2>/dev/null || true)"`,
        `if [ -z "$REAL_INTERFACE" ]; then AFTER_INTERFACES="$(${shellQuote(wg)} show interfaces 2>/dev/null || true)"; for candidate in $AFTER_INTERFACES; do case " $BEFORE_INTERFACES " in *" $candidate "*) ;; *) REAL_INTERFACE="$candidate"; break ;; esac; done; fi`,
        '[ -n "$REAL_INTERFACE" ]',
        `echo "$REAL_INTERFACE" > ${shellQuote(nameFile)}`,
        `${shellQuote(wg)} setconf "$REAL_INTERFACE" ${shellQuote(profile.setConfigPath)}`,
        'ifconfig "$REAL_INTERFACE" up',
        ...addressCommands,
        ...routeCommands
      ]
    : [
        'set -e',
        `REAL_INTERFACE="$(cat ${shellQuote(nameFile)} 2>/dev/null || true)"`,
        `if [ -z "$REAL_INTERFACE" ] && [ -n ${shellQuote(primaryAddress)} ]; then for candidate in $(${shellQuote(wg)} show interfaces 2>/dev/null || true); do if ifconfig "$candidate" 2>/dev/null | grep -q ${shellQuote(primaryAddress)}; then REAL_INTERFACE="$candidate"; break; fi; done; fi`,
        `if [ -n "$REAL_INTERFACE" ]; then`,
        ...routeCommands.map((line) => `  ${line}`),
        '  rm -f "/var/run/wireguard/$REAL_INTERFACE.sock"',
        `  rm -f ${shellQuote(nameFile)}`,
        'fi'
      ];
  const shellCommand = scriptLines.join('\n');
  const script = `do shell script ${appleScriptString(shellCommand)} with administrator privileges`;
  return {
    action,
    platform: runtime.platform,
    configPath,
    command: 'osascript',
    args: ['-e', script],
    displayCommand: `osascript -e ${shellQuote(script)}`,
    needsAdmin: true,
    runtime
  };
}

function prepareDarwinUserspaceProfile(configPath: string): {
  interfaceName: string;
  addresses: string[];
  allowedIps: string[];
  setConfigPath: string;
} {
  const parsed = parseWireGuardProfile(configPath);
  const setConfigPath = join(dirname(configPath), `${parsed.interfaceName}.setconf`);
  writeFileSync(setConfigPath, parsed.setConfigLines.join('\n').trimEnd() + '\n', { mode: 0o600 });
  return {
    interfaceName: parsed.interfaceName,
    addresses: parsed.addresses,
    allowedIps: parsed.allowedIps,
    setConfigPath
  };
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

function resolveWireGuardRealInterface(runtime: WireGuardConnectionRuntimeStatus, interfaceName: string): string | null {
  if (runtime.platform === 'darwin') {
    const nameFile = `/var/run/wireguard/${interfaceName}.name`;
    try {
      if (existsSync(nameFile)) {
        const value = readFileSync(nameFile, 'utf8').trim();
        return value || null;
      }
    } catch {
      return null;
    }
    return null;
  }
  return interfaceName;
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
  if (route.source !== 'windows-route-print') return false;
  const routeRange = cidrRange(route.cidr);
  if (!routeRange) return false;
  const interfaceIp = route.interfaceName ? ipv4ToInt(route.interfaceName) : null;
  if (interfaceIp !== null && hdoRanges.some((range) => interfaceIp >= range.start && interfaceIp <= range.end)) {
    return true;
  }
  if (!rangeOverlapsAny(routeRange, hdoRanges)) return false;
  const gateway = (route.gateway ?? '').trim().toLowerCase();
  return !gateway || gateway === 'on-link' || gateway === '在链路上' || !isIpv4(gateway);
}

function rangeOverlapsAny(
  target: { start: number; end: number },
  ranges: Array<{ start: number; end: number }>
): boolean {
  return ranges.some((range) => target.start <= range.end && range.start <= target.end);
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
  const serviceLookup = `$svc = Get-Service -Name ${powerShellString(serviceName)} -ErrorAction SilentlyContinue`;
  const preflightLines = action === 'up'
    ? [serviceLookup, "if ($null -ne $svc -and $svc.Status -eq 'Running') { exit 0 }"]
    : (action === 'down' ? [serviceLookup, 'if ($null -eq $svc) { exit 0 }'] : []);
  const runWireGuard = (wireGuardArgs: string[]) => `& ${powerShellString(command)} ${wireGuardArgs.map(powerShellString).join(' ')}`;
  const elevatedLines = [
    "$ErrorActionPreference = 'Stop'",
    `$svc = Get-Service -Name ${powerShellString(serviceName)} -ErrorAction SilentlyContinue`,
    ...(action === 'up'
      ? [
          "if ($null -ne $svc -and $svc.Status -eq 'Running') { exit 0 }",
          `if ($null -ne $svc) { Start-Service -Name ${powerShellString(serviceName)}; exit 0 }`
        ]
      : (action === 'down'
        ? [
          'if ($null -eq $svc) { exit 0 }'
          ]
        : [
            `if ($null -ne $svc) { ${runWireGuard(['/uninstalltunnelservice', tunnelName])}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }`
          ])),
    runWireGuard(args),
    'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
    'exit 0'
  ];
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
  if (command.platform === 'win32') {
    return [
      'Windows 启停 WireGuard 需要管理员授权。',
      '请在弹出的 UAC 窗口点击“是”；如果没有弹窗，请用“以管理员身份运行”启动 QPJoy 后重试。',
      detail
    ].filter(Boolean).join(' ');
  }
  return detail;
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
  if (value.includes('/')) return normalizeCidr(value);
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
