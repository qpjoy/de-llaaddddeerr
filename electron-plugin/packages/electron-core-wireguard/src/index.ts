import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  homeCidr: '100.88.0.0/24',
  userCidr: '100.89.0.0/24',
  serviceCidr: '100.90.0.0/24',
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
    const system = detectWireGuardCli('wg');
    if (system.available) {
      return {
        target,
        available: true,
        source: 'system',
        command: 'wg',
        bundledPath: null,
        installedPath: null,
        systemPath: 'wg'
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

export function findBundledWireGuardCli(bundledDir?: string | null): string | null {
  const packageDir = optionalWireGuardEnginePackageDir();
  const roots = [bundledDir, packageDir].filter((row): row is string => Boolean(row));
  const key = platformArchKey();
  const aliases = key.endsWith('-x64') ? [key, key.replace('-x64', '-amd64')] : [key];
  const names = process.platform === 'win32' ? ['wg.exe', 'wg.exe.gz', 'wg', 'wg.gz'] : ['wg', 'wg.gz'];
  const candidates = roots.flatMap((root) =>
    aliases.flatMap((alias) => names.map((name) => join(root, alias, name)))
  );
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function installBundledWireGuardCli(sourcePath: string, installDir: string, commandName = defaultWireGuardCommandName()): string {
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
