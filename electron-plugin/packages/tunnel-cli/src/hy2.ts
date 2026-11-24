import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, X509Certificate } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { get as httpGet } from 'node:http';
import { connect as netConnect, createServer, isIP } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import {
  type BundleExtra,
  type EdgeHost,
  type ParsedArgs,
  addHost,
  asRoot,
  askYesNo,
  bold,
  buildSshArgs,
  commandExists,
  defaultRevision,
  defaultStateDir,
  dim,
  edgeHome,
  emptyArgs,
  ensureHome,
  ensureLocalTools,
  expandHome,
  findStack,
  flag,
  installKeyWithPassword,
  listFiles,
  option,
  parseArgs,
  printTable,
  privateTree,
  probeSsh,
  promptValue,
  push,
  readHosts,
  readOrigin,
  requireOrigin,
  runCapture,
  shellQuote,
  sshBin,
  validateName,
} from './edge';

/**
 * `qp-tunnel-cli hy2` - push a Hysteria2 server to an edge host over SSH and
 * give this machine a local proxy port that leads there.
 *
 *   qp-tunnel-cli hy2 up <host>     password, certificate and port made here;
 *                                   the hy2 edge stack pushed with the mihomo
 *                                   engine for the host's architecture; a
 *                                   mihomo-client instance on 127.0.0.1:<port>
 *                                   here; a check through it.
 *
 * Both ends run the mihomo engine that @qpjoy/electron-plugin-tunnel-engine-*
 * already publishes on npm, so nothing is downloaded from GitHub or Docker Hub
 * and the host needs no outbound access at all: the pushing machine fetches
 * the engine once (npm pack, any registry mirror) and ships it in the bundle.
 *
 * The TLS certificate is self-signed and pinned by its SHA-256 fingerprint in
 * every client configuration, so no domain name or CA is needed.
 *
 * The local side is a named mihomo-client instance (`hy2-<host>`), never the
 * default one: the default instance's mixed port 7788 (the MX-H2I egress) and
 * the subscriptions instance's 7890 are refused as local ports.
 *
 * Files on the pushing machine (<edge home> is that of `qp-tunnel-cli edge`):
 *   <edge home>/hy2/<host>/hy2.json      settings and secrets (0600)
 *   <edge home>/hy2/<host>/client.yaml   the local client configuration
 *   <edge home>/state/<host>/<component>/ what is pushed: server.yaml, hy2.env, tls/
 *   <edge home>/cache/engine/<target>/   engines fetched from npm
 */

const packageRoot = resolve(__dirname, '..');
const marker = '# qp-tunnel-cli hy2';
const hy2Flags = new Set(['obfs', 'no-obfs', 'rotate-password', 'new-cert', 'refresh-engine', 'purge', 'push', 'no-connect', 'no-test', 'no-ip', 'diagnose', 'no-diagnose']);
// Sources a port open on every interface (--bind 0.0.0.0) accepts: it carries no password.
const privateSources = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '::1/128', 'fc00::/7'];
const reservedLocalPorts = new Map<number, string>([
  [7788, 'the default mihomo-client instance (the MX-H2I egress)'],
  [7890, 'the mihomo-client subscriptions instance'],
]);
const serverPortCandidates = [443, 8443, 10443, 20443, 30443];
const localPortCandidates = [...range(7891, 7899), ...range(17891, 17999)];
const instancePattern = /^[a-z][a-z0-9-]{0,31}$/;
const addressPattern = /^[A-Za-z0-9.:-]+$/;
const enginePackagePrefix = '@qpjoy/electron-plugin-tunnel-engine-';
const defaultIpUrl = 'http://api.ipify.org/';
// Tried in order by hy2 test when the one before fails: a host in mainland China may not reach api.ipify.org.
const exitIpUrls = [defaultIpUrl, 'http://ip.3322.net/', 'http://myip.ipip.net/'];

export interface Hy2Config {
  version: 1;
  host: string;
  component: string;
  server: string;
  port: number;
  user: string;
  password: string;
  sni?: string;
  fingerprint: string;
  obfsPassword?: string;
  upMbps?: number;
  downMbps?: number;
  localPort: number;
  bind: string;
  instance: string;
  createdAt: string;
  updatedAt: string;
  pushed?: { revision: string; digest: string; at: string; engine: string; target: string };
  /** The client.yaml the local instance was last installed with (sha256), so status can tell a setting that never took effect. */
  applied?: { digest: string; at: string };
}

interface RemoteFacts {
  arch: string;
  target?: string;
  unit: string;
  current: string;
  ss: boolean;
  udp: Set<number>;
}

interface Engine {
  gz: string;
  source: string;
  sha256: string;
  target: string;
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

function die(message: string, code = 1): never {
  process.stderr.write(`hy2: ${message}\n`);
  process.exit(code);
}

export async function runHy2Cli(args: string[]): Promise<void> {
  const command = args[0] ?? 'status';
  const parsed = parseArgs(args.slice(1), hy2Flags);
  if (['help', '--help', '-h'].includes(command) || flag(parsed, 'help', 'h')) {
    hy2Help();
    return;
  }
  switch (command) {
    case 'up':
      await upCommand(parsed);
      return;
    case 'init':
      await initCommand(parsed);
      return;
    case 'push':
      await pushCommand(parsed);
      return;
    case 'connect':
      await connectCommand(parsed);
      return;
    case 'run':
      await runCommand(parsed);
      return;
    case 'test':
    case 'check':
      await testCommand(parsed);
      return;
    case 'status':
    case 'list':
    case 'ls':
      await statusCommand(parsed);
      return;
    case 'show':
      showCommand(parsed);
      return;
    case 'export':
      exportCommand(parsed);
      return;
    case 'disconnect':
      disconnectCommand(parsed);
      return;
    case 'engine':
      await engineCommand(parsed);
      return;
    default:
      process.stderr.write(`Unknown hy2 command: ${command}\n\n`);
      hy2Help();
      process.exit(2);
  }
}

function hy2Help(): void {
  process.stdout.write(`qp-tunnel-cli hy2 - push a Hysteria2 server to a host over SSH; applications here use a local port that leads there

One command (asks for what it needs in a terminal; --yes answers yes):
  qp-tunnel-cli hy2 up <host> [--host <address> --user root --ssh-port 22 --key ~/.ssh/id_ed25519]
                       [--port <udp>] [--local-port <tcp>] [--yes]
      host not saved yet: --host saves it (as qp-tunnel-cli edge add would); without --key, and in a terminal,
      you log in once with the password and this machine's edge key is put there.
      Then: password and self-signed certificate made here, the hy2 stack pushed with the mihomo engine for the
      host's architecture (nothing is downloaded on the host), a local mihomo-client instance hy2-<host> on
      127.0.0.1:<local port> (Linux, systemd), and a check through it. Run again any time: an unchanged server is
      not pushed again.

Steps one by one:
  qp-tunnel-cli hy2 init <host> [options]      make or change the settings, certificate and both configurations here
  qp-tunnel-cli hy2 push <host> [options] [--dry-run] [--yes] [--take-over] [--shared-host] [--force-os]
                                               (re)push the server (always pushes); restarts the local instance
  qp-tunnel-cli hy2 connect <host> [--bind docker|0.0.0.0] [--local-port <n>]
                                               local instance hy2-<host> via mihomo-client (Linux, sudo)
  qp-tunnel-cli hy2 run <host>                 the local client in the foreground, any OS (Ctrl-C stops it)
  qp-tunnel-cli hy2 test <host>                through the local port: the host's own sshd answers, and the exit address;
                                               when that fails, both ends are examined (service, port, firewall, tcpdump
                                               on the host while this side sends) and the failing part is named.
                                               --diagnose: examine them anyway; --no-diagnose: never
  qp-tunnel-cli hy2 status [<host>] [--json]   what this machine set up, and whether each local port is live
  qp-tunnel-cli hy2 show <host>                settings (no secrets) and files
  qp-tunnel-cli hy2 export <host> [--format yaml|uri] [--bind 0.0.0.0]   client configuration for another machine or app
                                               (has the password; listens on 127.0.0.1 there unless --bind)
  qp-tunnel-cli hy2 disconnect <host> [--purge]         remove the local instance; the server keeps running
  qp-tunnel-cli hy2 engine [--target linux-x64|linux-arm64|darwin-arm64|...] [--refresh-engine]   fetch or show an engine

Options for up / init / push (connect and run take --local-port and --bind too):
  --server <address>      what clients dial (default: the saved host address)
  --port <udp>            server port (default 443, else 8443, 10443, ... when taken on the host)
  --sni <name>            TLS server name (default: --server when it is a DNS name)
  --obfs | --no-obfs      salamander obfuscation on or off (default off)
  --up <Mbps> --down <Mbps>   this machine's bandwidth for Hysteria's Brutal congestion control (default: BBR)
  --local-port <tcp>      local mixed (HTTP + SOCKS5) port (default 7891, else the next free one; never 7788 or 7890)
  --bind <where>          where the local port listens, comma-separated (default 127.0.0.1; 127.0.0.1 always stays):
                            docker    also every Docker bridge gateway here (docker0 172.17.0.1, br-* 172.18.0.1, ...),
                                      looked up again by each hy2 connect; the unit then starts after docker.service
                            0.0.0.0   every interface, but only private and loopback sources are served
                            a.b.c.d   also these addresses of this machine
                          the port has no password: whoever reaches one of those addresses can use it
  --instance <name>       local mihomo-client instance (default hy2-<host>)
  --component <name>      edge component on the host (default hy2; unit qp-edge-<component>.service)
  --rotate-password       new password (exported clients need the new configuration)
  --new-cert              new certificate (likewise)
  --engine <file>         the host's engine (mihomo.gz or a binary) instead of npm; --refresh-engine fetches again
  --mihomo <binary>       the local engine for connect / run
  --root /opt/mx          host layout root (as edge push)
  up only: --push (push even when unchanged), --no-connect (server only), --no-test

Engines come from @qpjoy/electron-plugin-tunnel-engine-<target> on npm (MIHOMO_NPM_REGISTRY, MIHOMO_NPM_ENGINE_VERSION),
cached in <edge home>/cache/engine. Hosts: qp-tunnel-cli edge hosts. Files: <edge home>/hy2/<host>/ (edge origin).
`);
}

// ---------- files ----------

function hy2Root(): string {
  return join(edgeHome(), 'hy2');
}

function hostDir(host: string): string {
  return join(hy2Root(), host);
}

function configPath(host: string): string {
  return join(hostDir(host), 'hy2.json');
}

function clientPath(host: string): string {
  return join(hostDir(host), 'client.yaml');
}

export function readConfig(host: string): Hy2Config | undefined {
  const file = configPath(host);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Hy2Config;
  } catch (error) {
    die(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writePrivate(file: string, content: string | Buffer): void {
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, content, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

function writeConfig(cfg: Hy2Config): void {
  ensureHome();
  mkdirSync(hostDir(cfg.host), { recursive: true, mode: 0o700 });
  chmodSync(hy2Root(), 0o700);
  chmodSync(hostDir(cfg.host), 0o700);
  writePrivate(configPath(cfg.host), `${JSON.stringify(cfg, null, 2)}\n`);
}

function allConfigs(): Hy2Config[] {
  if (!existsSync(hy2Root())) return [];
  return readdirSync(hy2Root(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(configPath(entry.name)))
    .map((entry) => readConfig(entry.name) as Hy2Config)
    .sort((a, b) => a.host.localeCompare(b.host));
}

function requireConfig(parsed: ParsedArgs, usage: string): Hy2Config {
  const host = parsed.positionals[0];
  if (!host) die(`usage: qp-tunnel-cli hy2 ${usage}`, 2);
  validateName('host', host);
  const cfg = readConfig(host);
  if (!cfg) die(`no hy2 set up for ${host} on this machine (${configPath(host)}). Start with: qp-tunnel-cli hy2 up ${host}`);
  return cfg;
}

// ---------- configurations ----------

function yamlString(value: string): string {
  // JSON strings are YAML double-quoted scalars.
  return JSON.stringify(value);
}

export function renderServerYaml(cfg: Hy2Config, origin: string): string {
  return [
    `${marker} server for ${cfg.host} (component ${cfg.component}), made on ${origin}.`,
    '# Rewritten by qp-tunnel-cli hy2 init/push on that machine; change it there, not here.',
    'log-level: warning',
    'allow-lan: false',
    'ipv6: false',
    'mode: rule',
    'geo-auto-update: false',
    'profile:',
    '  store-selected: false',
    '  store-fake-ip: false',
    'listeners:',
    '  - name: qp-hy2',
    '    type: hysteria2',
    '    listen: 0.0.0.0',
    `    port: ${cfg.port}`,
    '    users:',
    `      ${yamlString(cfg.user)}: ${yamlString(cfg.password)}`,
    '    certificate: ./tls/server.crt',
    '    private-key: ./tls/server.key',
    ...(cfg.obfsPassword ? ['    obfs: salamander', `    obfs-password: ${yamlString(cfg.obfsPassword)}`] : []),
    'rules:',
    '  - MATCH,DIRECT',
    '',
  ].join('\n');
}

function proxyName(cfg: Hy2Config): string {
  return `hy2-${cfg.host}`;
}

// ---------- where the local port listens (--bind) ----------

/**
 * --bind, comma-separated: 127.0.0.1 (always included), 0.0.0.0 (every interface, private sources only),
 * docker (the Docker bridge gateways of this machine: docker0, br-*), or IPv4 addresses of this machine.
 * Kept as given; docker is looked up again whenever the configuration is rendered (hy2 connect).
 */
function parseBind(value: string): string {
  const tokens = value.split(',').map((token) => token.trim().toLowerCase()).filter(Boolean).map((token) => (token === 'localhost' ? '127.0.0.1' : token));
  if (tokens.length === 0) die('--bind needs a value', 2);
  for (const token of tokens) {
    if (token !== 'docker' && isIP(token) !== 4) die(`--bind takes 127.0.0.1, 0.0.0.0, docker, or IPv4 addresses of this machine, comma-separated; not '${token}'`, 2);
  }
  if (tokens.includes('0.0.0.0')) return '0.0.0.0';
  return [...new Set(['127.0.0.1', ...tokens])].join(',');
}

/** `ip -4 -o addr show` lines -> interface and address. */
export function parseIpAddr(text: string): { name: string; address: string }[] {
  const found: { name: string; address: string }[] = [];
  for (const line of text.split('\n')) {
    const match = /^\d+:\s+([^\s@]+)(?:@\S+)?\s+inet\s+(\d{1,3}(?:\.\d{1,3}){3})\//.exec(line);
    if (match) found.push({ name: match[1], address: match[2] });
  }
  return found;
}

let ipv4Cache: { name: string; address: string }[] | undefined;
/**
 * Every IPv4 address of this machine. Node's networkInterfaces() leaves out links that are not running,
 * such as docker0 with no container attached (NO-CARRIER), although its address takes connections;
 * on Linux `ip` lists those too.
 */
function ipv4Addresses(): { name: string; address: string }[] {
  if (ipv4Cache) return ipv4Cache;
  let found: { name: string; address: string }[] = [];
  // QP_HY2_IP: a stand-in for `ip` (tests).
  if (process.platform === 'linux' || process.env.QP_HY2_IP) {
    const result = spawnSync(process.env.QP_HY2_IP || 'ip', ['-4', '-o', 'addr', 'show'], { encoding: 'utf8' });
    if (result.status === 0) found = parseIpAddr(result.stdout ?? '');
  }
  if (found.length === 0) {
    found = Object.entries(networkInterfaces()).flatMap(([name, list]) => (list ?? [])
      .filter((entry) => entry.family === 'IPv4' || (entry.family as unknown) === 4)
      .map((entry) => ({ name, address: entry.address })));
  }
  ipv4Cache = found;
  return found;
}

function localIPv4(): string[] {
  return [...new Set(ipv4Addresses().map((entry) => entry.address))];
}

function inIPv4Cidr(address: string, cidr: string): boolean {
  const [base, bits] = cidr.split('/');
  if (isIP(base) !== 4 || isIP(address) !== 4) return false;
  const number = (value: string) => value.split('.').reduce((sum, part) => sum * 256 + Number(part), 0);
  const size = 2 ** (32 - Number(bits));
  return Math.floor(number(address) / size) === Math.floor(number(base) / size);
}

/**
 * This machine's own IPv4 addresses outside the private ranges (a public address on the main interface).
 * Docker masquerades what this machine itself sends to one of its bridge addresses (src in the bridge
 * subnet, not leaving through that bridge) to the main address, so without these such requests are refused.
 * Safe to allow: Linux drops packets from outside that claim one of its own addresses as source.
 */
function ownPublicAddresses(): string[] {
  return localIPv4().filter((address) => !privateSources.some((cidr) => inIPv4Cidr(address, cidr)));
}

function dockerBridgeAddresses(): string[] {
  return [...new Set(ipv4Addresses()
    .filter(({ name }) => name === 'docker0' || name.startsWith('br-'))
    .map(({ address }) => address))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

interface ResolvedBind {
  all: boolean;
  /** Addresses besides 127.0.0.1, each served by its own mixed listener. */
  extra: string[];
}

/** strict: refuse addresses this machine does not have (when --bind was just given here). */
function resolveBind(spec: string, strict: boolean): ResolvedBind {
  if (spec === '0.0.0.0') return { all: true, extra: [] };
  const extra = new Set<string>();
  const mine = localIPv4();
  for (const token of spec.split(',')) {
    if (token === '127.0.0.1' || !token) continue;
    if (token === 'docker') {
      const found = dockerBridgeAddresses();
      if (strict && found.length === 0) die('--bind docker: this machine has no Docker bridge (docker0, br-*) right now. Start Docker first, or use --bind 0.0.0.0', 2);
      for (const address of found) extra.add(address);
    } else {
      if (strict && !mine.includes(token)) die(`--bind ${token} is not an address of this machine (it has ${mine.join(', ')})`, 2);
      extra.add(token);
    }
  }
  return { all: false, extra: [...extra] };
}

function bindSummary(spec: string, port: number): string {
  const resolved = resolveBind(spec, false);
  if (resolved.all) return `0.0.0.0:${port} (every interface; private and loopback sources only)`;
  const others = resolved.extra.map((address) => `${address}:${port}`);
  return `127.0.0.1:${port}${others.length > 0 ? ` and ${others.join(', ')}` : ''}${spec.split(',').includes('docker') ? ' (docker: the Docker bridges, looked up again by hy2 connect)' : ''}`;
}

/** here: false renders for another machine (hy2 export), so this machine's own addresses stay out. */
export function renderClientYaml(cfg: Hy2Config, overrides: { localPort?: number; bind?: string; here?: boolean } = {}): string {
  const localPort = overrides.localPort ?? cfg.localPort;
  const bind = resolveBind(overrides.bind ?? cfg.bind, false);
  const own = bind.all && overrides.here !== false ? ownPublicAddresses() : [];
  const name = proxyName(cfg);
  return [
    `${marker} client for ${cfg.host}: ${cfg.server}:${cfg.port}/udp, local mixed port ${localPort}.`,
    '# Rewritten by qp-tunnel-cli hy2 init/push/connect; everything this port receives leaves from that host.',
    `mixed-port: ${localPort}`,
    ...(bind.all
      ? [
        'allow-lan: true',
        'bind-address: "*"',
        // The port carries no password, so only private and loopback sources may use it.
        'lan-allowed-ips:',
        ...privateSources.map((cidr) => `  - ${cidr}`),
        // This machine itself, as Docker rewrites it when it uses a bridge address (see ownPublicAddresses).
        ...own.map((address) => `  - ${address}/32`),
      ]
      : ['allow-lan: false']),
    'mode: rule',
    'log-level: warning',
    'ipv6: false',
    'geo-auto-update: false',
    'profile:',
    '  store-selected: false',
    '  store-fake-ip: false',
    'proxies:',
    `  - name: ${yamlString(name)}`,
    '    type: hysteria2',
    `    server: ${yamlString(cfg.server)}`,
    `    port: ${cfg.port}`,
    `    password: ${yamlString(cfg.password)}`,
    ...(cfg.sni ? [`    sni: ${yamlString(cfg.sni)}`] : []),
    // A self-signed certificate, pinned: only this exact certificate is accepted.
    `    fingerprint: ${yamlString(cfg.fingerprint)}`,
    ...(cfg.upMbps ? [`    up: ${cfg.upMbps}`] : []),
    ...(cfg.downMbps ? [`    down: ${cfg.downMbps}`] : []),
    ...(cfg.obfsPassword ? ['    obfs: salamander', `    obfs-password: ${yamlString(cfg.obfsPassword)}`] : []),
    // The same port on more addresses (Docker bridges, ...): programs and containers there can use it.
    // An address that is missing when mihomo starts only loses its own listener.
    ...(bind.extra.length > 0
      ? ['listeners:', ...bind.extra.flatMap((address) => [
        `  - name: ${yamlString(`local-${address}`)}`,
        '    type: mixed',
        `    listen: ${address}`,
        `    port: ${localPort}`,
      ])]
      : []),
    'rules:',
    `  - MATCH,${name}`,
    '',
  ].join('\n');
}

export function renderUri(cfg: Hy2Config): string {
  const host = isIP(cfg.server) === 6 ? `[${cfg.server}]` : cfg.server;
  const params = new URLSearchParams();
  // insecure=1 with pinSHA256: the self-signed certificate is accepted only when its fingerprint matches.
  params.set('insecure', '1');
  params.set('pinSHA256', cfg.fingerprint.replace(/:/g, '').toLowerCase());
  if (cfg.sni) params.set('sni', cfg.sni);
  if (cfg.obfsPassword) {
    params.set('obfs', 'salamander');
    params.set('obfs-password', cfg.obfsPassword);
  }
  return `hysteria2://${encodeURIComponent(cfg.password)}@${host}:${cfg.port}/?${params.toString()}#${encodeURIComponent(proxyName(cfg))}`;
}

function writeServerState(cfg: Hy2Config): string {
  const dir = defaultStateDir(cfg.host, cfg.component);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writePrivate(join(dir, 'server.yaml'), renderServerYaml(cfg, readOrigin().name ?? 'an unnamed origin'));
  writePrivate(join(dir, 'hy2.env'), `${marker}: read by the hy2 stack's deploy.sh and health.sh (parsed, never sourced)\nHY2_PORT=${cfg.port}\n`);
  privateTree(dir);
  return dir;
}

function writeClientYaml(cfg: Hy2Config): string {
  const content = renderClientYaml(cfg);
  writePrivate(clientPath(cfg.host), content);
  return content;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Whether the local instance runs what hy2.json says now. Root reads the copy mihomo-client installed;
 * otherwise the digest recorded by the last successful install. unknown: neither is there (set up before 2.2.2).
 */
function appliedState(cfg: Hy2Config): 'applied' | 'not applied' | 'unknown' {
  const want = renderClientYaml(cfg);
  try {
    return readFileSync(`/etc/mihomo-client/instances/${cfg.instance}/subscription.yaml`, 'utf8') === want ? 'applied' : 'not applied';
  } catch {
    // Not root, or no instance on this machine.
  }
  if (!cfg.applied) return 'unknown';
  return cfg.applied.digest === sha256(want) ? 'applied' : 'not applied';
}

// ---------- certificate ----------

const opensslTool = { command: 'openssl', apt: 'openssl', rpm: 'openssl' };

function certificateProblem(crt: string, names: string[]): string | undefined {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(readFileSync(crt));
  } catch {
    return 'unreadable';
  }
  const san = cert.subjectAltName ?? '';
  const missing = names.filter((name) => !san.split(/,\s*/).some((entry) => entry === `IP Address:${name}` || entry === `DNS:${name}`));
  if (missing.length > 0) return `does not name ${missing.join(', ')}`;
  if (Date.parse(cert.validTo) - Date.now() < 30 * 24 * 3600 * 1000) return `expires ${cert.validTo}`;
  return undefined;
}

/** ECDSA P-256 key from node:crypto, self-signed for 10 years by the local openssl. */
async function makeCertificate(tlsDir: string, names: string[], parsed: ParsedArgs): Promise<void> {
  await ensureLocalTools([opensslTool], parsed);
  mkdirSync(tlsDir, { recursive: true, mode: 0o700 });
  const work = mkdtempSync(join(tmpdir(), 'qp-hy2-cert-'));
  try {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const keyFile = join(work, 'server.key');
    const crtFile = join(work, 'server.crt');
    const cnfFile = join(work, 'openssl.cnf');
    writeFileSync(keyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    writeFileSync(cnfFile, [
      '[req]',
      'distinguished_name = dn',
      'x509_extensions = v3_req',
      'prompt = no',
      '[dn]',
      `CN = ${names[names.length - 1]}`,
      '[v3_req]',
      'basicConstraints = critical,CA:FALSE',
      'keyUsage = critical,digitalSignature',
      'extendedKeyUsage = serverAuth',
      'subjectAltName = @alt',
      '[alt]',
      ...names.map((name, index) => `${isIP(name) ? 'IP' : 'DNS'}.${index + 1} = ${name}`),
      '',
    ].join('\n'));
    const made = spawnSync('openssl', ['req', '-x509', '-new', '-key', keyFile, '-sha256', '-days', '3650', '-config', cnfFile, '-extensions', 'v3_req', '-out', crtFile], { encoding: 'utf8' });
    if (made.status !== 0) die(`openssl could not make the certificate: ${(made.stderr || made.error?.message || '').trim()}`);
    for (const [from, to] of [[keyFile, 'server.key'], [crtFile, 'server.crt']]) {
      copyFileSync(from, join(tlsDir, `${to}.tmp`));
      chmodSync(join(tlsDir, `${to}.tmp`), 0o600);
      renameSync(join(tlsDir, `${to}.tmp`), join(tlsDir, to));
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function fingerprintOf(crt: string): string {
  return new X509Certificate(readFileSync(crt)).fingerprint256;
}

// ---------- ports ----------

function parseNumber(label: string, value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) die(`${label} must be a whole number from ${min} to ${max}, not '${value}'`, 2);
  return number;
}

function pickServerPort(name: string, parsed: ParsedArgs, existing: Hy2Config | undefined, facts: RemoteFacts | undefined, notes: string[]): number {
  const explicit = parseNumber('--port', option(parsed, 'port'), 1, 65535);
  // Our own unit holding its port is a re-push, not a clash.
  const ours = facts?.unit === 'active' ? existing?.port : undefined;
  const taken = (port: number) => Boolean(facts?.udp.has(port)) && port !== ours;
  if (explicit !== undefined) {
    if (taken(explicit)) die(`udp ${explicit} is already in use on ${name}; pick another --port, or leave it out to take a free one`);
    return explicit;
  }
  if (existing) {
    if (!taken(existing.port)) return existing.port;
    notes.push(`udp ${existing.port} is now used by another program on ${name}, so the server moves`);
  }
  const free = serverPortCandidates.find((port) => !taken(port));
  if (free === undefined) die(`udp ${serverPortCandidates.join(', ')} are all in use on ${name}; pass --port <n>`);
  if (!existing && free !== serverPortCandidates[0]) notes.push(`udp ${serverPortCandidates[0]} is in use on ${name}; using ${free}`);
  return free;
}

function canConnect(host: string, port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolveConnect) => {
    const socket = netConnect({ host, port });
    const done = (value: boolean) => {
      socket.destroy();
      resolveConnect(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
  });
}

async function waitListening(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await canConnect(host, port, 1000)) return true;
    if (Date.now() >= until) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  }
}

/** false only when the port is taken there; an address this machine lacks right now does not count. */
function canBind(host: string, port: number): Promise<boolean> {
  return new Promise((resolveBind) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => resolveBind(error.code === 'EADDRNOTAVAIL'));
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolveBind(true)));
  });
}

/** Free = nothing answers on it and it can be bound on every address --bind names. */
async function localPortFree(port: number, bind: string): Promise<boolean> {
  if (await canConnect('127.0.0.1', port)) return false;
  const resolved = resolveBind(bind, false);
  if (resolved.all) return canBind('0.0.0.0', port);
  for (const address of ['127.0.0.1', ...resolved.extra]) {
    if (!(await canBind(address, port))) return false;
  }
  return true;
}

function localPortProblem(port: number): string | undefined {
  const reserved = reservedLocalPorts.get(port);
  if (reserved) return `local port ${port} belongs to ${reserved}; hy2 never takes it`;
  if (port < 1024) return `local port ${port} is privileged; pick one from 1024 up`;
  return undefined;
}

async function pickLocalPort(name: string, parsed: ParsedArgs, existing: Hy2Config | undefined, bind: string): Promise<number> {
  const explicit = parseNumber('--local-port', option(parsed, 'local-port'), 1, 65535);
  const others = new Set(allConfigs().filter((cfg) => cfg.host !== name).map((cfg) => cfg.localPort));
  if (explicit !== undefined) {
    const problem = localPortProblem(explicit);
    if (problem) die(problem, 2);
    if (others.has(explicit)) die(`local port ${explicit} is already the hy2 port of ${allConfigs().find((cfg) => cfg.localPort === explicit)?.host}`, 2);
    return explicit;
  }
  if (existing) return existing.localPort;
  for (const port of localPortCandidates) {
    if (others.has(port) || reservedLocalPorts.has(port)) continue;
    if (await localPortFree(port, bind)) return port;
  }
  die('no free local port among 7891-7899 and 17891-17999; pass --local-port <n>');
}

// ---------- settings: hy2 init ----------

function defaultInstance(host: string): string {
  const base = `hy2-${host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'host'}`.slice(0, 32).replace(/-+$/, '');
  const used = new Set(allConfigs().filter((cfg) => cfg.host !== host).map((cfg) => cfg.instance));
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base.slice(0, 32 - String(n).length - 1)}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

interface Prepared {
  cfg: Hy2Config;
  notes: string[];
  changed: boolean;
}

async function prepare(name: string, host: EdgeHost, parsed: ParsedArgs, facts?: RemoteFacts): Promise<Prepared> {
  ensureHome();
  const existing = readConfig(name);
  const notes: string[] = [];
  const component = option(parsed, 'component') ?? existing?.component ?? 'hy2';
  validateName('component', component);
  if (existing && existing.component !== component) {
    die(`${name} already has hy2 as component ${existing.component}. One hy2 per saved host: save the address under another name for a second one (qp-tunnel-cli edge add <name> --host ${host.host})`, 2);
  }
  const server = option(parsed, 'server') ?? existing?.server ?? host.host;
  if (!addressPattern.test(server)) die(`--server ${server} is not an IP address or DNS name`, 2);
  if (!existing && !option(parsed, 'server') && host.jump) {
    notes.push(`${name} is reached through ${host.jump}; clients dial ${server}. If that is not its public address, run again with --server <public address>`);
  }
  const sniOption = option(parsed, 'sni');
  // --sni wins ('' clears it); otherwise a new or changed server address brings its own default.
  const sni = sniOption !== undefined
    ? (sniOption || undefined)
    : existing && existing.server === server ? existing.sni : (isIP(server) ? undefined : server);
  if (sni !== undefined && (!addressPattern.test(sni) || isIP(sni))) die(`--sni ${sni} is not a DNS name`, 2);
  const bind = parseBind(option(parsed, 'bind') ?? existing?.bind ?? '127.0.0.1');
  if (option(parsed, 'bind')) resolveBind(bind, true);
  const instance = option(parsed, 'instance') ?? existing?.instance ?? defaultInstance(name);
  if (!instancePattern.test(instance) || instance === 'default' || instance === 'subscriptions') {
    die(`--instance ${instance}: needs [a-z][a-z0-9-]{0,31}, and not default or subscriptions (those are the existing mihomo-client instances)`, 2);
  }
  const port = pickServerPort(name, parsed, existing, facts, notes);
  const localPort = await pickLocalPort(name, parsed, existing, bind);
  const up = parseNumber('--up', option(parsed, 'up'), 0, 100000);
  const down = parseNumber('--down', option(parsed, 'down'), 0, 100000);
  let obfsPassword = existing?.obfsPassword;
  if (flag(parsed, 'obfs')) obfsPassword = obfsPassword ?? randomBytes(18).toString('base64url');
  if (flag(parsed, 'no-obfs')) obfsPassword = undefined;
  const now = new Date().toISOString();
  const cfg: Hy2Config = {
    version: 1,
    host: name,
    component,
    server,
    port,
    user: existing?.user ?? (readOrigin().name ?? 'qp').replace(/[^A-Za-z0-9._-]/g, '_'),
    password: !existing || flag(parsed, 'rotate-password') ? randomBytes(24).toString('base64url') : existing.password,
    ...(sni ? { sni } : {}),
    fingerprint: existing?.fingerprint ?? '',
    ...(obfsPassword ? { obfsPassword } : {}),
    ...((up ?? existing?.upMbps) ? { upMbps: up ?? existing?.upMbps } : {}),
    ...((down ?? existing?.downMbps) ? { downMbps: down ?? existing?.downMbps } : {}),
    localPort,
    bind,
    instance,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(existing?.pushed ? { pushed: existing.pushed } : {}),
    ...(existing?.applied ? { applied: existing.applied } : {}),
  };
  if (bind !== '127.0.0.1') notes.push(`the local port also listens on ${bindSummary(bind, localPort).replace(/^127\.0\.0\.1:\d+ and /, '')}; it has no password, so whoever reaches it there can use it`);

  const tlsDir = join(defaultStateDir(name, component), 'tls');
  const crt = join(tlsDir, 'server.crt');
  const names = [...new Set([server, ...(sni ? [sni] : [])])];
  const problem = existsSync(crt) && existsSync(join(tlsDir, 'server.key')) ? certificateProblem(crt, names) : 'missing';
  if (flag(parsed, 'new-cert') || problem) {
    await makeCertificate(tlsDir, names, parsed);
    if (existing) notes.push(`new certificate (${flag(parsed, 'new-cert') ? '--new-cert' : `the old one ${problem}`}); clients exported earlier need the new configuration`);
  }
  cfg.fingerprint = fingerprintOf(crt);
  if (existing && flag(parsed, 'rotate-password')) notes.push('new password; clients exported earlier need the new configuration');
  if (existing && existing.port !== cfg.port) notes.push(`server port ${existing.port} -> ${cfg.port}/udp`);

  const comparable = (value: Hy2Config | undefined) => (value ? JSON.stringify({ ...value, createdAt: '', updatedAt: '', pushed: undefined, applied: undefined }) : '');
  const changed = comparable(existing) !== comparable(cfg);
  if (!changed && existing) cfg.updatedAt = existing.updatedAt;
  writeServerState(cfg);
  writeConfig(cfg);
  writeClientYaml(cfg);
  return { cfg, notes, changed };
}

function describe(cfg: Hy2Config): string {
  return `  server     ${cfg.server}:${cfg.port}/udp on ${cfg.host} (component ${cfg.component}, unit qp-edge-${cfg.component}.service)
  tls        self-signed, pinned ${cfg.fingerprint.slice(0, 23)}...${cfg.sni ? `, sni ${cfg.sni}` : ''}${cfg.obfsPassword ? ', salamander obfuscation' : ''}
  local      ${bindSummary(cfg.bind, cfg.localPort)} (HTTP + SOCKS5), mihomo-client instance ${cfg.instance}
  files      ${hostDir(cfg.host)}/ and ${defaultStateDir(cfg.host, cfg.component)}/
`;
}

function savedHost(parsed: ParsedArgs, usage: string): [string, EdgeHost] {
  const name = parsed.positionals[0];
  if (!name) die(`usage: qp-tunnel-cli hy2 ${usage}`, 2);
  validateName('host', name);
  const host = readHosts().hosts[name];
  if (!host) die(`no saved host named ${name}. Save it with qp-tunnel-cli edge add ${name} --host <address> --key <key>, or let qp-tunnel-cli hy2 up ${name} --host <address> do it`, 2);
  return [name, host];
}

async function initCommand(parsed: ParsedArgs): Promise<void> {
  const [name, host] = savedHost(parsed, 'init <host> [options]');
  const { cfg, notes } = await prepare(name, host, parsed);
  process.stdout.write(`hy2 settings for ${name}:\n${describe(cfg)}`);
  for (const note of notes) process.stdout.write(`  note       ${note}\n`);
  process.stdout.write(`Next: qp-tunnel-cli hy2 push ${name} --dry-run, then qp-tunnel-cli hy2 up ${name}\n`);
}

// ---------- the host ----------

function archTarget(arch: string): string | undefined {
  if (arch === 'x86_64' || arch === 'amd64') return 'linux-x64';
  if (arch === 'aarch64' || arch === 'arm64') return 'linux-arm64';
  return undefined;
}

async function probeRemote(name: string, component: string, root: string): Promise<RemoteFacts> {
  const unit = `qp-edge-${component}.service`;
  const script = [
    '# qp-hy2-probe: read-only',
    `printf 'arch=%s\\n' "$(uname -m)"`,
    `printf 'unit=%s\\n' "$(systemctl is-active ${shellQuote(unit)} 2>/dev/null || true)"`,
    `printf 'current=%s\\n' "$(readlink ${shellQuote(`${root}/current/${component}`)} 2>/dev/null || true)"`,
    `if command -v ss >/dev/null 2>&1; then printf 'ss=1\\n'; ss -lun 2>/dev/null | awk 'NR > 1 { print "udp=" $4 }'; else printf 'ss=0\\n'; fi`,
    '',
  ].join('\n');
  const result = await runCapture(sshBin(), [...buildSshArgs(name, readHosts().hosts, true), 'sh -s'], Buffer.from(script));
  if (result.error) die(`cannot run ${sshBin()}: ${result.error.message}`);
  if (result.status !== 0) {
    die(`cannot look at ${name} over ssh (exit ${result.status}${result.stderr.trim() ? `: ${result.stderr.trim().split('\n').pop()}` : ''})`);
  }
  const facts: RemoteFacts = { arch: '', unit: '', current: '', ss: false, udp: new Set() };
  for (const line of result.stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1).trim();
    if (key === 'arch') facts.arch = value;
    else if (key === 'unit') facts.unit = value;
    else if (key === 'current') facts.current = value;
    else if (key === 'ss') facts.ss = value === '1';
    else if (key === 'udp') {
      const port = Number(value.slice(value.lastIndexOf(':') + 1));
      if (Number.isInteger(port) && port > 0) facts.udp.add(port);
    }
  }
  facts.target = archTarget(facts.arch);
  return facts;
}

// ---------- engines ----------

function engineDir(target: string): string {
  return join(edgeHome(), 'cache', 'engine', target);
}

function workspaceEngine(target: string): string | undefined {
  const file = resolve(packageRoot, '..', 'tunnel-engines', target, 'resources', 'engine', target, 'mihomo.gz');
  return existsSync(file) ? file : undefined;
}

/** ELF e_machine of a Linux binary: 0x3e x86-64, 0xb7 aarch64. Other formats are not checked. */
function elfTarget(binary: Buffer): string | undefined {
  if (binary.length < 20 || binary.readUInt32BE(0) !== 0x7f454c46) return undefined;
  const machine = binary.readUInt16LE(18);
  return machine === 0x3e ? 'linux-x64' : machine === 0xb7 ? 'linux-arm64' : `linux-machine-0x${machine.toString(16)}`;
}

function engineFrom(gz: string, source: string, target: string): Engine {
  const data = readFileSync(gz);
  if (data[0] !== 0x1f || data[1] !== 0x8b) die(`${gz} is not gzip`);
  if (target.startsWith('linux-')) {
    let found: string | undefined;
    try {
      found = elfTarget(gunzipSync(data));
    } catch (error) {
      die(`${gz} does not unpack: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (found !== target) die(`${gz} holds ${found ?? 'no Linux binary'}, not the ${target} engine`);
  }
  return { gz, source, sha256: createHash('sha256').update(data).digest('hex'), target };
}

function fetchEngine(target: string): Engine {
  if (!commandExists('npm')) die(`npm is not on PATH, so the ${target} engine cannot be fetched. Pass --engine <mihomo.gz> (from ${enginePackagePrefix}${target})`);
  const pkg = `${enginePackagePrefix}${target}`;
  const version = process.env.MIHOMO_NPM_ENGINE_VERSION || 'latest';
  const registry = process.env.MIHOMO_NPM_REGISTRY;
  const work = mkdtempSync(join(tmpdir(), 'qp-hy2-engine-'));
  try {
    process.stdout.write(`Fetching the ${target} engine: npm pack ${pkg}@${version}${registry ? ` --registry ${registry}` : ''}\n`);
    const packed = spawnSync('npm', ['pack', `${pkg}@${version}`, '--pack-destination', work, '--cache', join(work, 'npm-cache'), '--json', ...(registry ? ['--registry', registry] : [])], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000,
    });
    if (packed.status !== 0) {
      die(`npm pack ${pkg}@${version} failed: ${(packed.stderr || packed.error?.message || '').trim().split('\n').slice(-3).join(' ')}. Set MIHOMO_NPM_REGISTRY (e.g. https://registry.npmmirror.com), or pass --engine <mihomo.gz>`);
    }
    const tgz = readdirSync(work).find((file) => file.endsWith('.tgz'));
    if (!tgz) die(`npm pack ${pkg}@${version} produced no tarball`);
    let packedVersion = version;
    try {
      const info = JSON.parse(packed.stdout) as Array<{ version?: string }>;
      packedVersion = info[0]?.version ?? version;
    } catch {
      // the tarball name still says it
    }
    const inner = `package/resources/engine/${target}/mihomo.gz`;
    const untar = spawnSync('tar', ['-xzf', join(work, tgz), '-C', work, inner], { encoding: 'utf8' });
    if (untar.status !== 0) die(`${tgz} has no ${inner}`);
    const dir = engineDir(target);
    ensureHome();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    copyFileSync(join(work, inner), join(dir, 'mihomo.gz.tmp'));
    renameSync(join(dir, 'mihomo.gz.tmp'), join(dir, 'mihomo.gz'));
    writeFileSync(join(dir, 'source.txt'), `${pkg}@${packedVersion}\n`);
    return engineFrom(join(dir, 'mihomo.gz'), `${pkg}@${packedVersion}`, target);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function resolveEngine(target: string, parsed: ParsedArgs, explicitOption = 'engine'): Promise<Engine> {
  const explicit = option(parsed, explicitOption);
  if (explicit) {
    const file = resolve(expandHome(explicit));
    if (!existsSync(file)) die(`--${explicitOption} ${file} does not exist`, 2);
    const data = readFileSync(file);
    if (data[0] === 0x1f && data[1] === 0x8b) return engineFrom(file, `file:${file}`, target);
    ensureHome();
    mkdirSync(engineDir(target), { recursive: true, mode: 0o700 });
    const gz = join(engineDir(target), `given-${createHash('sha256').update(data).digest('hex').slice(0, 12)}.gz`);
    if (!existsSync(gz)) writeFileSync(gz, gzipSync(data, { level: 6 }));
    return engineFrom(gz, `file:${file}`, target);
  }
  if (!flag(parsed, 'refresh-engine')) {
    const workspace = workspaceEngine(target);
    if (workspace) return engineFrom(workspace, `workspace tunnel-engines/${target}`, target);
    const cached = join(engineDir(target), 'mihomo.gz');
    if (existsSync(cached)) {
      const source = existsSync(join(engineDir(target), 'source.txt')) ? readFileSync(join(engineDir(target), 'source.txt'), 'utf8').trim() : 'cache';
      return engineFrom(cached, source, target);
    }
  }
  return fetchEngine(target);
}

function localTarget(): string | undefined {
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : undefined;
  if (!arch) return undefined;
  if (process.platform === 'linux' || process.platform === 'darwin') return `${process.platform}-${arch}`;
  if (process.platform === 'win32' && arch === 'x64') return 'win32-x64';
  return undefined;
}

/** This machine's mihomo binary: --mihomo, QP_HY2_MIHOMO, or the engine for this platform unpacked into the cache. */
async function localMihomo(parsed: ParsedArgs): Promise<{ bin: string; source: string }> {
  const explicit = option(parsed, 'mihomo') ?? process.env.QP_HY2_MIHOMO;
  if (explicit) {
    const bin = resolve(expandHome(explicit));
    if (!existsSync(bin)) die(`--mihomo ${bin} does not exist`, 2);
    return { bin, source: bin };
  }
  const target = localTarget();
  if (!target) die(`no mihomo engine is published for ${process.platform}-${process.arch}; pass --mihomo <binary>`);
  const engine = await resolveEngine(target, parsed, 'local-engine');
  ensureHome();
  mkdirSync(engineDir(target), { recursive: true, mode: 0o700 });
  const bin = join(engineDir(target), `mihomo-${engine.sha256.slice(0, 12)}${process.platform === 'win32' ? '.exe' : ''}`);
  if (!existsSync(bin)) {
    writeFileSync(`${bin}.tmp`, gunzipSync(readFileSync(engine.gz)), { mode: 0o755 });
    chmodSync(`${bin}.tmp`, 0o755);
    renameSync(`${bin}.tmp`, bin);
  }
  return { bin, source: engine.source };
}

async function engineCommand(parsed: ParsedArgs): Promise<void> {
  const target = option(parsed, 'target') ?? localTarget();
  if (!target || !/^(linux|darwin|win32)-(x64|arm64)$/.test(target)) die('usage: qp-tunnel-cli hy2 engine [--target linux-x64|linux-arm64|darwin-arm64|darwin-x64|win32-x64] [--refresh-engine]', 2);
  const engine = await resolveEngine(target, parsed);
  process.stdout.write(`engine   ${engine.target}
source   ${engine.source}
file     ${engine.gz}
sha256   ${engine.sha256}
`);
}

// ---------- push ----------

function pushDigest(cfg: Hy2Config, engine: Engine): string {
  const hash = createHash('sha256');
  const add = (dir: string, label: string) => {
    for (const file of listFiles(dir)) {
      hash.update(`${label}/${file}\0`);
      hash.update(readFileSync(join(dir, file)));
    }
  };
  add(defaultStateDir(cfg.host, cfg.component), 'state');
  add(findStack('hy2').dir, 'stack');
  add(resolve(packageRoot, 'resources/edge/lib'), 'lib');
  hash.update(`engine\0${engine.sha256}`);
  return hash.digest('hex');
}

interface PushOutcome {
  cfg: Hy2Config;
  pushed: boolean;
}

async function pushFlow(name: string, host: EdgeHost, parsed: ParsedArgs, always: boolean, interactive: boolean): Promise<PushOutcome> {
  ensureHome();
  requireOrigin();
  const root = option(parsed, 'root') ?? '/opt/mx';
  const dryRun = flag(parsed, 'dry-run');
  const existing = readConfig(name);
  const component = option(parsed, 'component') ?? existing?.component ?? 'hy2';
  validateName('component', component);

  let facts: RemoteFacts | undefined;
  if (!dryRun) {
    process.stdout.write(`Looking at ${name} (read-only) ...\n`);
    facts = await probeRemote(name, component, root);
    if (!facts.target) die(`${name} is ${facts.arch || 'an unknown architecture'}; engines exist for x86_64 and aarch64`);
    process.stdout.write(`  ${facts.arch} (${facts.target}), unit qp-edge-${component}.service ${facts.unit || 'unknown'}${facts.ss ? `, ${facts.udp.size} udp listener(s)` : ', ss missing (udp ports not checked)'}\n`);
  }
  const { cfg, notes } = await prepare(name, host, parsed, facts);
  for (const note of notes) process.stdout.write(`  note: ${note}\n`);

  const target = facts?.target ?? option(parsed, 'target');
  const engine = target ? await resolveEngine(target, parsed) : undefined;
  const digest = engine ? pushDigest(cfg, engine) : undefined;
  if (!always && !dryRun && facts && cfg.pushed && digest === cfg.pushed.digest && facts.unit === 'active' && facts.current.endsWith(`/${cfg.pushed.revision}`)) {
    process.stdout.write(`${name} already runs this server (revision ${cfg.pushed.revision}, unit active); not pushed again. --push forces it.\n`);
    return { cfg, pushed: false };
  }

  const extras: BundleExtra[] = [];
  if (engine) {
    const meta = join(hostDir(name), 'bundle');
    mkdirSync(meta, { recursive: true, mode: 0o700 });
    writeFileSync(join(meta, 'engine-target'), `${engine.target}\n`);
    writeFileSync(join(meta, 'engine-source'), `${engine.source} sha256:${engine.sha256}\n`);
    extras.push(
      { path: 'engine/mihomo.gz', source: engine.gz },
      { path: 'engine/target', source: join(meta, 'engine-target') },
      { path: 'engine/source', source: join(meta, 'engine-source') },
    );
  }
  process.stdout.write(`\nhy2 for ${name}:\n${describe(cfg)}  engine     ${engine ? `${engine.source} (${engine.target})` : 'picked for the host\'s architecture on a real push (--target linux-x64 to show it now)'}
  open       udp ${cfg.port} in ${name}'s cloud security group (nothing here opens ports; deploy.sh reports the host firewall)\n\n`);
  const revision = option(parsed, 'revision') ?? defaultRevision();
  const passOn: Array<[string, string | true]> = [['stack', 'hy2'], ['component', cfg.component], ['revision', revision], ['root', root]];
  for (const name2 of ['yes', 'dry-run', 'take-over', 'shared-host', 'force-os']) if (flag(parsed, name2)) passOn.push([name2, true]);
  if (flag(parsed, 'y')) passOn.push(['yes', true]);
  if (interactive) passOn.push(['from-setup', true]);
  await push(emptyArgs([name], passOn), extras);
  if (dryRun) return { cfg, pushed: false };

  cfg.pushed = { revision, digest: digest as string, at: new Date().toISOString(), engine: (engine as Engine).source, target: (engine as Engine).target };
  writeConfig(cfg);
  return { cfg, pushed: true };
}

async function pushCommand(parsed: ParsedArgs): Promise<void> {
  const [name, host] = savedHost(parsed, 'push <host> [options] [--dry-run] [--yes]');
  const { cfg, pushed } = await pushFlow(name, host, parsed, true, false);
  if (!pushed) return;
  // A restarted server makes clients wait for their QUIC idle timeout; the local instance is restarted
  // right away (with the new configuration, when it changed) instead.
  if (instanceState(cfg.instance) === 'active') {
    process.stdout.write(`\nRefreshing the local instance ${cfg.instance}:\n`);
    await installLocal(cfg, parsed);
  } else {
    process.stdout.write(`\nNext: qp-tunnel-cli hy2 connect ${name}   (or qp-tunnel-cli hy2 run ${name} in the foreground)\n`);
  }
}

// ---------- this machine ----------

function systemdHere(): boolean {
  // QP_HY2_ASSUME_SYSTEMD: tests, with QP_HY2_SYSTEMCTL and QP_HY2_CLIENT_SCRIPT stand-ins.
  return Boolean(process.env.QP_HY2_ASSUME_SYSTEMD) || (process.platform === 'linux' && existsSync('/run/systemd/system'));
}

function instanceState(instance: string): string {
  if (!systemdHere()) return 'n/a';
  const result = spawnSync(process.env.QP_HY2_SYSTEMCTL || 'systemctl', ['is-active', `mihomo-client@${instance}.service`], { encoding: 'utf8' });
  return (result.stdout ?? '').trim() || 'unknown';
}

function clientScript(): string {
  if (process.env.QP_HY2_CLIENT_SCRIPT) return process.env.QP_HY2_CLIENT_SCRIPT;
  const bundled = resolve(packageRoot, 'resources/mihomo-client.sh');
  const repo = resolve(packageRoot, '../../../scripts/mihomo-client.sh');
  const found = [bundled, repo].find((file) => existsSync(file));
  if (!found) die(`missing ${bundled}; reinstall @qpjoy/tunnel-cli`);
  return found;
}

/** Runs a command as root: directly when root, else through sudo (QP_EDGE_SUDO, as edge link up). */
function runPrivileged(argv: string[]): number {
  const sudo = process.env.QP_EDGE_SUDO ?? 'sudo';
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const [command, ...args] = isRoot || sudo === '' ? argv : [sudo, ...argv];
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) die(`cannot run ${command}: ${result.error.message}`);
  return result.status ?? 1;
}

async function installLocal(cfg: Hy2Config, parsed: ParsedArgs): Promise<void> {
  const state = instanceState(cfg.instance);
  if (state !== 'active' && !(await localPortFree(cfg.localPort, cfg.bind))) {
    die(`local port ${cfg.localPort} is in use on this machine. Pick another: qp-tunnel-cli hy2 connect ${cfg.host} --local-port <n>`);
  }
  const content = writeClientYaml(cfg);
  const { bin, source } = await localMihomo(parsed);
  process.stdout.write(`Local instance ${cfg.instance} on ${bindSummary(cfg.bind, cfg.localPort)} (engine ${source}; mihomo-client, sudo)\n`);
  // Docker bridges appear when docker has started; a listener whose address is missing at start is not retried.
  const dropin = `/etc/systemd/system/mihomo-client@${cfg.instance}.service.d/10-qp-hy2-after-docker.conf`;
  const wantDropin = resolveBind(cfg.bind, false).extra.length > 0;
  if (wantDropin || existsSync(dropin)) {
    const script = `d="/etc/systemd/system/mihomo-client@$1.service.d"; f="$d/10-qp-hy2-after-docker.conf"
if [ "$2" = add ]; then mkdir -p "$d" && printf '%s\\n' '${marker}: this instance also listens on Docker bridge addresses, which exist once docker has started' '[Unit]' 'After=docker.service' > "$f"
else rm -f "$f"; rmdir "$d" 2>/dev/null || true; fi`;
    if (runPrivileged(['sh', '-c', script, 'sh', cfg.instance, wantDropin ? 'add' : 'remove']) !== 0) die(`could not ${wantDropin ? 'write' : 'remove'} ${dropin}`);
  }
  const status = runPrivileged(['bash', clientScript(), 'install', '--instance', cfg.instance, '--mixed-port', String(cfg.localPort), '--file', clientPath(cfg.host), '--binary-path', bin]);
  if (status !== 0) {
    die(`mihomo-client install --instance ${cfg.instance} failed (exit ${status}). The local port keeps what it had before; hy2 status shows "not applied" until an install succeeds.
  logs       qp-tunnel-cli logs --instance ${cfg.instance}
  try again  qp-tunnel-cli hy2 connect ${cfg.host}`);
  }
  const saved = readConfig(cfg.host) ?? cfg;
  saved.applied = { digest: sha256(content), at: new Date().toISOString() };
  writeConfig(saved);
  cfg.applied = saved.applied;
}

function notHereAdvice(cfg: Hy2Config): string {
  return `This machine is not Linux with systemd, so no service is installed here. Instead:
  foreground   qp-tunnel-cli hy2 run ${cfg.host}          (local port ${cfg.localPort}; Ctrl-C stops it)
  any client   qp-tunnel-cli hy2 export ${cfg.host} --format uri    (or --format yaml for Clash/mihomo apps)
`;
}

async function connectLocal(cfg: Hy2Config, parsed: ParsedArgs): Promise<boolean> {
  if (!systemdHere()) {
    process.stdout.write(notHereAdvice(cfg));
    return false;
  }
  await installLocal(cfg, parsed);
  return true;
}

async function connectCommand(parsed: ParsedArgs): Promise<void> {
  const existing = requireConfig(parsed, 'connect <host> [--local-port <n>] [--bind 127.0.0.1]');
  let cfg = existing;
  if (option(parsed, 'local-port') || option(parsed, 'bind')) {
    const host = readHosts().hosts[existing.host] ?? { host: existing.server, user: 'root', port: 22 };
    ({ cfg } = await prepare(existing.host, host, parsed));
    if (cfg.localPort !== existing.localPort || cfg.bind !== existing.bind) {
      process.stdout.write(`Local port ${bindSummary(existing.bind, existing.localPort)} -> ${bindSummary(cfg.bind, cfg.localPort)}\n`);
    }
  }
  if (!(await connectLocal(cfg, parsed))) return;
  if (flag(parsed, 'no-test')) return;
  const ok = await testTunnel(cfg, parsed);
  if (!ok) process.exit(1);
}

async function runCommand(parsed: ParsedArgs): Promise<void> {
  const cfg = requireConfig(parsed, 'run <host> [--local-port <n>] [--bind 127.0.0.1] [--mihomo <binary>]');
  const localPort = parseNumber('--local-port', option(parsed, 'local-port'), 1, 65535) ?? cfg.localPort;
  const problem = localPortProblem(localPort);
  if (problem) die(problem, 2);
  const bind = parseBind(option(parsed, 'bind') ?? cfg.bind);
  resolveBind(bind, Boolean(option(parsed, 'bind')));
  if (!(await localPortFree(localPort, bind))) {
    die(`local port ${localPort} is in use${instanceState(cfg.instance) === 'active' ? ` (the installed instance ${cfg.instance} already serves it)` : ''}; pick another with --local-port <n>`);
  }
  const { bin, source } = await localMihomo(parsed);
  const runDir = join(hostDir(cfg.host), 'run');
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const file = join(runDir, 'config.yaml');
  writePrivate(file, renderClientYaml(cfg, { localPort, bind }));
  process.stdout.write(`${bold(`hy2 ${cfg.host}`)}: ${cfg.server}:${cfg.port}/udp  ->  local ${bindSummary(bind, localPort)} (HTTP + SOCKS5). Ctrl-C stops it.
  ${dim(`engine ${source}`)}
  try: curl -x http://127.0.0.1:${localPort} ${defaultIpUrl}
`);
  const child = spawn(bin, ['-d', runDir, '-f', file], { stdio: 'inherit' });
  const forward = (signal: NodeJS.Signals) => {
    child.kill(signal);
  };
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  child.on('error', (error) => die(`cannot start ${bin}: ${error.message}`));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 0 : 1)));
}

// ---------- checks ----------

/** SOCKS5 CONNECT through the local port; resolves with the first line the far end sends. */
/** A SOCKS5 greeting to host:port: undefined when it answers as a SOCKS5 proxy, else what happened. */
function socksGreeting(host: string, port: number, timeoutMs: number): Promise<string | undefined> {
  return new Promise((done) => {
    const socket = netConnect({ host, port });
    let settled = false;
    const finish = (problem?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      done(problem);
    };
    const timer = setTimeout(() => finish('no answer in time'), timeoutMs);
    socket.on('connect', () => socket.write(Buffer.from([5, 1, 0])));
    socket.on('data', (chunk: Buffer) => finish(chunk[0] === 5 && chunk[1] === 0 ? undefined : 'answered, but not as a SOCKS5 proxy'));
    // mihomo closes a refused source before reading: a FIN, or a reset when the greeting was already there.
    const closed = 'closed the connection at once: mihomo refused the source address this machine used';
    socket.on('close', () => finish(closed));
    socket.on('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ECONNRESET' || error.code === 'EPIPE'
      ? closed
      : error.code === 'ECONNREFUSED' ? 'nothing listens there (connection refused)' : error.message));
  });
}

/** The addresses besides 127.0.0.1 that the local port is meant to answer on, as hy2 test checks them. */
function sharedAddresses(bind: string): string[] {
  const resolved = resolveBind(bind, false);
  if (!resolved.all) return resolved.extra;
  const bridges = dockerBridgeAddresses();
  return (bridges.length > 0 ? bridges : localIPv4().filter((address) => !address.startsWith('127.'))).slice(0, 8);
}

export function socksFirstLine(proxyHost: string, proxyPort: number, destHost: string, destPort: number, timeoutMs: number): Promise<string> {
  return new Promise((resolveLine, rejectLine) => {
    const socket = netConnect({ host: proxyHost, port: proxyPort });
    let stage = 0;
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, line?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectLine(error);
      else resolveLine(line ?? '');
    };
    const timer = setTimeout(() => finish(new Error(stage < 2 ? 'the local port did not finish the SOCKS5 handshake in time' : 'no answer from the far end in time')), timeoutMs);
    socket.on('connect', () => socket.write(Buffer.from([5, 1, 0])));
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0) {
        if (buffer.length < 2) return;
        if (buffer[0] !== 5 || buffer[1] !== 0) return finish(new Error('the local port refused the SOCKS5 greeting'));
        buffer = buffer.subarray(2);
        stage = 1;
        const address = isIP(destHost) === 4
          ? Buffer.from([1, ...destHost.split('.').map(Number)])
          : Buffer.concat([Buffer.from([3, Buffer.byteLength(destHost)]), Buffer.from(destHost)]);
        socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, Buffer.from([destPort >> 8, destPort & 0xff])]));
      }
      if (stage === 1) {
        if (buffer.length < 5) return;
        if (buffer[1] !== 0) return finish(new Error(`SOCKS5 CONNECT failed (reply ${buffer[1]})`));
        const length = buffer[3] === 1 ? 10 : buffer[3] === 4 ? 22 : 7 + buffer[4];
        if (buffer.length < length) return;
        buffer = buffer.subarray(length);
        stage = 2;
      }
      if (stage === 2) {
        const text = buffer.toString('latin1');
        const newline = text.indexOf('\n');
        if (newline >= 0 || buffer.length > 255) finish(undefined, text.slice(0, newline >= 0 ? newline : 255).trim());
      }
    });
    socket.on('error', (error) => finish(error));
    socket.on('close', () => finish(new Error(stage === 2 ? 'the connection closed before the far end said anything' : 'the local port closed the connection')));
  });
}

function getViaProxy(proxyHost: string, proxyPort: number, url: string, timeoutMs: number): Promise<string> {
  const target = new URL(url);
  return new Promise((resolveGet, rejectGet) => {
    const request = httpGet({ host: proxyHost, port: proxyPort, path: url, headers: { Host: target.host, 'User-Agent': 'qp-tunnel-cli' }, timeout: timeoutMs }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => (response.statusCode === 200 ? resolveGet(body.trim()) : rejectGet(new Error(`HTTP ${response.statusCode}`))));
    });
    request.on('timeout', () => request.destroy(new Error('timed out')));
    request.on('error', rejectGet);
  });
}

async function testTunnel(cfg: Hy2Config, parsed: ParsedArgs): Promise<boolean> {
  const localPort = parseNumber('--local-port', option(parsed, 'local-port'), 1, 65535) ?? cfg.localPort;
  // 127.0.0.1 is served in every --bind mode.
  const proxyHost = '127.0.0.1';
  const sshPort = parseNumber('--ssh-port', option(parsed, 'ssh-port'), 1, 65535) ?? readHosts().hosts[cfg.host]?.port ?? 22;
  const timeoutMs = (parseNumber('--timeout', option(parsed, 'timeout'), 1, 120) ?? 12) * 1000;
  process.stdout.write(`\nChecking the tunnel to ${cfg.host} through ${proxyHost}:${localPort} ...\n`);
  // A unit that was just (re)started needs a moment before mihomo listens: systemctl returns at once.
  if (!(await waitListening(proxyHost, localPort, 15000))) {
    process.stdout.write(systemdHere()
      ? `  FAIL  nothing listens on ${proxyHost}:${localPort} after 15 s; mihomo-client@${cfg.instance}.service is ${instanceState(cfg.instance)}. Look at:
        qp-tunnel-cli status --instance ${cfg.instance}
        sudo journalctl -u mihomo-client@${cfg.instance}.service -n 30 --no-pager
`
      : `  FAIL  nothing listens on ${proxyHost}:${localPort}. Start it: qp-tunnel-cli hy2 run ${cfg.host}\n`);
    return false;
  }
  let tunnel = false;
  // The server dials 127.0.0.1:<ssh port> from its own side: its sshd answering proves the whole path.
  let banner = '';
  let bannerError = '';
  for (let attempt = 1; attempt <= 3 && !tunnel; attempt += 1) {
    try {
      banner = await socksFirstLine(proxyHost, localPort, '127.0.0.1', sshPort, timeoutMs);
      tunnel = /^SSH-/.test(banner);
      if (!tunnel) bannerError = `answered '${banner.slice(0, 40)}', not an SSH banner`;
    } catch (error) {
      bannerError = error instanceof Error ? error.message : String(error);
    }
  }
  if (tunnel) process.stdout.write(`  ok    ${cfg.host}'s own sshd answered through the tunnel (${banner})\n`);
  let exitIp = '';
  if (!flag(parsed, 'no-ip')) {
    const given = option(parsed, 'ip-url');
    const urls = given ? given.split(',').map((url) => url.trim()).filter(Boolean) : exitIpUrls;
    // With the tunnel already unanswered, one site is enough to confirm it.
    const tries = tunnel ? urls : urls.slice(0, 1);
    const failures: string[] = [];
    for (const url of tries) {
      try {
        const body = await getViaProxy(proxyHost, localPort, url, timeoutMs);
        // Some sites answer with a sentence around the address (myip.ipip.net).
        exitIp = /\b\d{1,3}(?:\.\d{1,3}){3}\b/.exec(body)?.[0] ?? body.slice(0, 80);
        const same = exitIp === cfg.server;
        const before = failures.length > 0 ? `; ${failures.join('; ')}` : '';
        process.stdout.write(`  ok    exit address ${exitIp} (${url}${before})${same ? ', the server itself' : isIP(cfg.server) ? `; the server is ${cfg.server} (a host with several addresses, or NAT, can differ)` : ''}\n`);
        tunnel = true;
        break;
      } catch (error) {
        failures.push(`${url} gave ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!exitIp) {
      process.stdout.write(`  ${tunnel ? 'note' : 'fail'}  through the tunnel: ${failures.join('; ')}${tunnel ? ` (the tunnel works; ${failures.length > 1 ? 'those sites are' : 'that site may be'} unreachable from ${cfg.host})` : ''}\n`);
    }
  }
  if (!tunnel) process.stdout.write(`  FAIL  no answer through the tunnel (${bannerError || 'no detail'})\n`);
  // The other addresses (--bind): does the port answer there at all, whatever the tunnel does.
  let shared = true;
  const others = cfg.bind === '127.0.0.1' ? [] : sharedAddresses(cfg.bind);
  if (others.length > 0) {
    const results = await Promise.all(others.map(async (address) => ({ address, problem: await socksGreeting(address, localPort, 3000) })));
    const answered = results.filter((result) => !result.problem).map((result) => `${result.address}:${localPort}`);
    if (answered.length > 0) process.stdout.write(`  ok    the local port also answers on ${answered.join(', ')}${dockerBridgeAddresses().length > 0 ? ' (containers use their network\'s gateway)' : ''}\n`);
    for (const { address, problem } of results.filter((result) => result.problem)) {
      shared = false;
      process.stdout.write(`  FAIL  ${address}:${localPort}: ${problem}\n`);
    }
    if (!shared) {
      process.stdout.write(`        ${appliedState(cfg) === 'not applied' ? `the instance does not run these settings yet: qp-tunnel-cli hy2 connect ${cfg.host}` : `from a container: docker exec -e http_proxy=http://<its gateway>:${localPort} <container> wget -qO- ${defaultIpUrl}`}\n`);
    }
  }
  if ((!tunnel || flag(parsed, 'diagnose')) && !flag(parsed, 'no-diagnose')) {
    await diagnose(cfg, parsed, tunnel, () => socksFirstLine(proxyHost, localPort, '127.0.0.1', sshPort, 6000).then(() => undefined, () => undefined));
  } else if (!tunnel) {
    process.stdout.write(`        The usual causes, most likely first:
        - udp ${cfg.port} is not allowed by ${cfg.host}'s cloud security group, or by its host firewall (the push printed that report)
        - the server is not running: qp-tunnel-cli edge status ${cfg.host} --health
        - ${cfg.server} is not the address clients reach (pass --server <public address> to hy2 push)
        - this machine's own network blocks outgoing UDP (some offices do)
        Both ends, explained: qp-tunnel-cli hy2 test ${cfg.host} (without --no-diagnose)
`);
  }
  return tunnel && shared;
}

// ---------- diagnosis: what both ends see, as edge link check does for the WireGuard relay ----------

const captureSeconds = 9;

interface LocalFacts {
  instance: string;
  publicIp?: string;
  route?: string;
  routeNote?: string;
  log: string[];
}

interface RemoteFindings {
  reached: boolean;
  error?: string;
  unit: string;
  pid: string;
  holder?: string;
  firewall: string;
  log: string[];
  capture: 'done' | 'no-tcpdump' | 'not-run';
  inbound: number;
  outbound: number;
  sources: string[];
}

function getDirect(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolveGet, rejectGet) => {
    const request = httpGet(url, { headers: { 'User-Agent': 'qp-tunnel-cli' }, timeout: timeoutMs }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => (response.statusCode === 200 ? resolveGet(body.trim()) : rejectGet(new Error(`HTTP ${response.statusCode}`))));
    });
    request.on('timeout', () => request.destroy(new Error('timed out')));
    request.on('error', rejectGet);
  });
}

async function localFacts(cfg: Hy2Config, parsed: ParsedArgs): Promise<LocalFacts> {
  const facts: LocalFacts = { instance: systemdHere() ? `mihomo-client@${cfg.instance}.service ${instanceState(cfg.instance)}` : 'hy2 run (no service on this machine)', log: [] };
  if (!flag(parsed, 'no-ip')) {
    facts.publicIp = await getDirect(option(parsed, 'ip-url')?.split(',')[0]?.trim() || defaultIpUrl, 6000).catch(() => undefined);
  }
  if (process.platform === 'linux' && isIP(cfg.server) === 4 && commandExists('ip')) {
    const route = spawnSync('ip', ['route', 'get', cfg.server], { encoding: 'utf8' });
    const line = (route.stdout ?? '').split('\n')[0]?.trim();
    const dev = / dev (\S+)/.exec(line ?? '')?.[1];
    if (line) facts.route = line.replace(/\s+uid \d+.*$/, '');
    // A TUN or a full-tunnel VPN here carries the UDP instead of the normal network.
    if (dev && /^(meta|mihomo|clash|utun|tun|sing|tailscale|wg|qpwgc|hdo)/i.test(dev)) {
      facts.routeNote = `traffic to ${cfg.server} leaves through ${dev}, not the normal network: a TUN or VPN on this machine carries the UDP`;
    }
  }
  if (systemdHere() && commandExists('journalctl')) {
    const journal = spawnSync('journalctl', ['-u', `mihomo-client@${cfg.instance}.service`, '-n', '80', '--no-pager', '-o', 'cat'], { encoding: 'utf8' });
    facts.log = (journal.stdout ?? '').split('\n')
      .filter((line) => /level=(warning|error)/.test(line))
      .map((line) => /msg="(.*)"\s*$/.exec(line)?.[1] ?? line)
      .slice(-3);
  }
  return facts;
}

function diagnoseScript(cfg: Hy2Config): string {
  return `# qp-hy2-diagnose: read-only
unit=${shellQuote(`qp-edge-${cfg.component}.service`)}; port=${cfg.port}
printf 'unit=%s\\n' "$(systemctl is-active "$unit" 2>/dev/null || true)"
printf 'pid=%s\\n' "$(systemctl show -p MainPID "$unit" 2>/dev/null | sed 's/^MainPID=//')"
if command -v ss >/dev/null 2>&1; then printf 'holder=%s\\n' "$(ss -lunp "sport = :$port" 2>/dev/null | sed 1d | head -n 1 | tr -s ' ')"; fi
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  if firewall-cmd --query-port="$port/udp" >/dev/null 2>&1; then echo fw=firewalld-open; else echo fw=firewalld-closed; fi
elif command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  if ufw status 2>/dev/null | grep -Eq "^$port(/udp)?[[:space:]].*ALLOW"; then echo fw=ufw-open; else echo fw=ufw-closed; fi
elif command -v iptables >/dev/null 2>&1 && iptables -S INPUT 2>/dev/null | grep -Eq -- "-p udp.*--dport $port .*-j (DROP|REJECT)"; then echo fw=iptables-drop
elif command -v iptables >/dev/null 2>&1 && iptables -S INPUT 2>/dev/null | grep -q '^-P INPUT DROP'; then echo fw=iptables-policy-drop
else echo fw=none; fi
journalctl -u "$unit" -n 6 --no-pager -o cat 2>/dev/null | sed 's/^/log=/'
if command -v tcpdump >/dev/null 2>&1; then
  echo capture=start
  timeout ${captureSeconds} tcpdump -lnqi any -c 80 "udp port $port" 2>/dev/null | sed 's/^/pkt=/'
  echo capture=done
else echo capture=no-tcpdump; fi
`;
}

/** Runs the read-only report on the host; while its tcpdump watches the port, trigger() sends traffic from here. */
function remoteFindings(cfg: Hy2Config, trigger: () => Promise<void>): Promise<RemoteFindings> {
  const empty: RemoteFindings = { reached: false, unit: 'unknown', pid: '', firewall: 'unknown', log: [], capture: 'not-run', inbound: 0, outbound: 0, sources: [] };
  const hosts = readHosts().hosts;
  const host = hosts[cfg.host];
  if (!host) return Promise.resolve({ ...empty, error: `${cfg.host} is not a saved host here` });
  return new Promise((resolveFindings) => {
    const child = spawn(sshBin(), [...buildSshArgs(cfg.host, hosts, true), asRoot(host, `sh -c ${shellQuote(diagnoseScript(cfg))}`)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let triggered: Promise<void> | undefined;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      // tcpdump needs a moment before it captures.
      if (!triggered && stdout.includes('capture=start')) triggered = new Promise((done) => setTimeout(() => trigger().then(done, done), 1000));
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => resolveFindings({ ...empty, error: error.message }));
    child.on('close', async (status) => {
      if (triggered) await triggered;
      if (status === 255 || !/^unit=/m.test(stdout)) {
        resolveFindings({ ...empty, error: stderr.trim().split('\n').pop() || `ssh exited ${status}${host.user === 'root' ? '' : ' (the remote user needs passwordless sudo)'}` });
        return;
      }
      const field = (key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(stdout)?.[1]?.trim();
      const lines = (key: string) => stdout.split('\n').filter((line) => line.startsWith(`${key}=`)).map((line) => line.slice(key.length + 1));
      let inbound = 0;
      let outbound = 0;
      const sources = new Set<string>();
      for (const packet of lines('pkt')) {
        const match = /IP6?\s+(\S+)\.(\d+)\s+>\s+(\S+)\.(\d+):/.exec(packet);
        if (!match) continue;
        if (Number(match[4]) === cfg.port) {
          inbound += 1;
          sources.add(match[1]);
        } else if (Number(match[2]) === cfg.port) {
          outbound += 1;
        }
      }
      resolveFindings({
        reached: true,
        unit: field('unit') || 'unknown',
        pid: field('pid') ?? '',
        ...(/^holder=/m.test(stdout) ? { holder: field('holder') ?? '' } : {}),
        firewall: field('fw') ?? 'unknown',
        log: lines('log').slice(-4),
        capture: /^capture=no-tcpdump$/m.test(stdout) ? 'no-tcpdump' : /^capture=start$/m.test(stdout) ? 'done' : 'not-run',
        inbound,
        outbound,
        sources: [...sources],
      });
    });
  });
}

function firewallFix(cfg: Hy2Config, firewall: string): string | undefined {
  switch (firewall) {
    case 'firewalld-closed': return `${cfg.host}'s firewalld does not allow udp ${cfg.port}: qp-tunnel-cli edge ssh ${cfg.host} -- 'firewall-cmd --permanent --add-port=${cfg.port}/udp && firewall-cmd --reload'`;
    case 'ufw-closed': return `${cfg.host}'s ufw does not allow udp ${cfg.port}: qp-tunnel-cli edge ssh ${cfg.host} -- 'ufw allow ${cfg.port}/udp'`;
    case 'iptables-drop': return `an iptables rule on ${cfg.host} drops udp ${cfg.port} (iptables -S INPUT there)`;
    case 'iptables-policy-drop': return `${cfg.host}'s iptables INPUT policy is DROP and may not let udp ${cfg.port} in (iptables -S INPUT there)`;
    default: return undefined;
  }
}

/** Which part of the path fails, from what both ends saw. Empty when nothing is wrong. */
function explainFailure(cfg: Hy2Config, local: LocalFacts, remote: RemoteFindings, tunnel: boolean): string[] {
  if (tunnel && (!remote.reached || remote.unit === 'active')) return [];
  const why: string[] = [];
  const securityGroup = `${cfg.host}'s cloud security group must allow udp ${cfg.port} inbound${local.publicIp ? ` from ${local.publicIp} (this machine's public address)` : ''}; Aliyun: 安全组 → 入方向 → UDP ${cfg.port}/${cfg.port}`;
  const otherPort = cfg.port === 443
    ? `udp 443 to a mainland-China cloud host can be filtered even when the security group allows it; a high port avoids that: allow udp 20443 there, then qp-tunnel-cli hy2 push ${cfg.host} --port 20443 --yes`
    : `if the security group already allows it, try another port (allow it first): qp-tunnel-cli hy2 push ${cfg.host} --port <n> --yes`;
  if (!remote.reached) {
    why.push(`${cfg.host} could not be asked over ssh (${remote.error ?? 'no answer'}), so only this side is known`);
    why.push(securityGroup);
    if (local.routeNote) why.push(local.routeNote);
    return why;
  }
  if (remote.unit !== 'active') {
    why.push(`qp-edge-${cfg.component}.service is ${remote.unit} on ${cfg.host}: the server is not running (its log is above). Push again: qp-tunnel-cli hy2 push ${cfg.host} --yes`);
    return why;
  }
  if (remote.holder !== undefined && !remote.holder.includes(`pid=${remote.pid},`)) {
    why.push(remote.holder
      ? `udp ${cfg.port} on ${cfg.host} is held by another process (${remote.holder}), not by the server`
      : `the server runs on ${cfg.host} but nothing listens on udp ${cfg.port} there (its log is above)`);
    return why;
  }
  if (remote.capture === 'no-tcpdump') {
    why.push(`tcpdump is not installed on ${cfg.host}, so it is unknown whether packets arrive. Install it there and run this again: qp-tunnel-cli edge ssh ${cfg.host} -- 'apt-get install -y tcpdump || yum install -y tcpdump'`);
    why.push(firewallFix(cfg, remote.firewall) ?? securityGroup);
    return why;
  }
  if (remote.inbound === 0) {
    why.push(`nothing from this machine reached ${cfg.host} on udp ${cfg.port} (tcpdump watched ${captureSeconds} s there; it sees packets before the host firewall), so they are dropped on the way`);
    if (local.routeNote) why.push(local.routeNote);
    why.push(securityGroup);
    why.push(otherPort);
    why.push(`or this machine's network blocks outgoing udp ${cfg.port} (some providers and offices do)`);
    return why;
  }
  if (remote.outbound === 0) {
    why.push(`packets arrive at ${cfg.host} (${remote.inbound}, from ${remote.sources.join(', ')}) but the server does not answer them`);
    why.push(firewallFix(cfg, remote.firewall) ?? `${cfg.host}'s firewall shows no block (${remote.firewall}); look at its iptables/nft rules for udp ${cfg.port}`);
    return why;
  }
  if (tunnel) return why;
  const log = local.log.join(' ');
  if (/fingerprint/i.test(log)) {
    why.push(`the server answers, but its certificate is not the one pinned here (settings out of sync). Push again, which also refreshes this side: qp-tunnel-cli hy2 push ${cfg.host} --yes`);
  } else if (/auth|password|unauthori[sz]ed/i.test(log)) {
    why.push(`the server answers, but rejects this side's password (settings out of sync). Push again, which also refreshes this side: qp-tunnel-cli hy2 push ${cfg.host} --yes`);
  } else {
    why.push(`the server answers (${remote.outbound} packets back), yet nothing works here: either the replies do not come back to this machine (something on this side drops incoming udp from ${cfg.server}), or the settings here and there differ (qp-tunnel-cli hy2 push ${cfg.host} --yes refreshes both)`);
  }
  return why;
}

async function diagnose(cfg: Hy2Config, parsed: ParsedArgs, tunnel: boolean, trigger: () => Promise<void>): Promise<void> {
  process.stdout.write(`\nLooking at both ends (read-only; tcpdump on ${cfg.host} watches udp ${cfg.port} for ${captureSeconds} s while this side sends) ...\n`);
  const [local, remote] = await Promise.all([localFacts(cfg, parsed), remoteFindings(cfg, trigger)]);
  const row = (where: string, text: string) => process.stdout.write(`  ${where.padEnd(12)} ${text}\n`);
  row('this side', `${local.instance}${local.publicIp ? `; public address ${local.publicIp}` : ''}`);
  if (local.route) row('this side', `route: ${local.route}`);
  for (const line of local.log) row('this side', `client log: ${line}`);
  if (remote.reached) {
    row(cfg.host, `qp-edge-${cfg.component}.service ${remote.unit}${remote.holder ? `; udp ${cfg.port}: ${remote.holder.includes(`pid=${remote.pid},`) ? `held by the server (pid ${remote.pid})` : remote.holder}` : remote.holder === '' ? `; nothing listens on udp ${cfg.port}` : ''}`);
    row(cfg.host, `firewall: ${remote.firewall}`);
    if (remote.unit !== 'active' || remote.holder === '') for (const line of remote.log) row(cfg.host, `server log: ${line}`);
    row(cfg.host, remote.capture === 'done'
      ? `tcpdump on udp ${cfg.port} for ${captureSeconds} s: ${remote.inbound} packet(s) in${remote.sources.length > 0 ? ` from ${remote.sources.join(', ')}` : ''}, ${remote.outbound} out`
      : remote.capture === 'no-tcpdump' ? 'tcpdump is not installed there' : 'no packet capture');
  } else {
    row(cfg.host, `UNKNOWN: ${remote.error ?? 'not reached'}`);
  }
  const why = explainFailure(cfg, local, remote, tunnel);
  if (why.length > 0) process.stdout.write(`why\n${why.map((text) => `  - ${text}`).join('\n')}\n`);
}

async function testCommand(parsed: ParsedArgs): Promise<void> {
  const cfg = requireConfig(parsed, 'test <host> [--local-port <n>] [--ssh-port <n>] [--no-ip] [--ip-url http://...[,http://...]] [--diagnose | --no-diagnose]');
  if (!(await testTunnel(cfg, parsed))) process.exit(1);
}

// ---------- status, show, export, disconnect ----------

async function statusCommand(parsed: ParsedArgs): Promise<void> {
  const only = parsed.positionals[0];
  const configs = allConfigs().filter((cfg) => !only || cfg.host === only);
  if (only && configs.length === 0) die(`no hy2 set up for ${only} on this machine. Start with: qp-tunnel-cli hy2 up ${only}`);
  const rows = await Promise.all(configs.map(async (cfg) => {
    const listening = await canConnect('127.0.0.1', cfg.localPort);
    return { cfg, instance: instanceState(cfg.instance), listening, applied: appliedState(cfg) };
  }));
  if (flag(parsed, 'json')) {
    process.stdout.write(`${JSON.stringify(rows.map(({ cfg, instance, listening, applied }) => ({
      host: cfg.host, component: cfg.component, server: cfg.server, port: cfg.port, local: `${cfg.bind === '127.0.0.1' ? '127.0.0.1' : cfg.bind}:${cfg.localPort}`, listen: bindSummary(cfg.bind, cfg.localPort),
      instance: cfg.instance, instanceState: instance, listening, applied, pushed: cfg.pushed ?? null,
    })), null, 2)}\n`);
    return;
  }
  if (rows.length === 0) {
    process.stdout.write(`No hy2 set up from this machine yet (${hy2Root()}).\nStart: qp-tunnel-cli hy2 up <host> --host <address>\n`);
    return;
  }
  printTable(['HOST', 'SERVER', 'LOCAL', 'INSTANCE', 'STATE', 'PUSHED'], rows.map(({ cfg, instance, listening, applied }) => [
    cfg.host,
    `${cfg.server}:${cfg.port}/udp`,
    `${cfg.bind === '0.0.0.0' ? '0.0.0.0' : cfg.bind === '127.0.0.1' ? '127.0.0.1' : '127.0.0.1+'}:${cfg.localPort}`,
    cfg.instance,
    `${instance}${listening ? ', listening' : ', not listening'}${applied === 'not applied' ? ', not applied' : ''}`,
    cfg.pushed ? `${cfg.pushed.revision}` : 'never',
  ]));
  for (const { cfg } of rows.filter((row) => row.applied === 'not applied')) {
    process.stdout.write(`\n${cfg.host}: the local instance does not run these settings (LOCAL ${bindSummary(cfg.bind, cfg.localPort)}). Apply: qp-tunnel-cli hy2 connect ${cfg.host}\n`);
  }
  process.stdout.write(`\nCheck one: qp-tunnel-cli hy2 test <host>    The host side: qp-tunnel-cli edge status <host> --health\n`);
}

function showCommand(parsed: ParsedArgs): void {
  const cfg = requireConfig(parsed, 'show <host>');
  process.stdout.write(`hy2 ${cfg.host}
${describe(cfg)}  user       ${cfg.user} (password in ${configPath(cfg.host)}; hy2 export prints it)
  bandwidth  ${cfg.upMbps || cfg.downMbps ? `up ${cfg.upMbps ?? '-'} / down ${cfg.downMbps ?? '-'} Mbps (Brutal)` : 'not set (BBR)'}
  pushed     ${cfg.pushed ? `${cfg.pushed.revision} at ${cfg.pushed.at}, engine ${cfg.pushed.engine}` : 'never'}
  this side  ${instanceState(cfg.instance)}${appliedState(cfg) === 'not applied' ? `, not running these settings (qp-tunnel-cli hy2 connect ${cfg.host})` : ''}
`);
}

function exportCommand(parsed: ParsedArgs): void {
  const cfg = requireConfig(parsed, 'export <host> [--format yaml|uri]');
  const format = option(parsed, 'format') ?? 'yaml';
  // For another machine: this machine's --bind (and its Docker bridges) mean nothing there.
  const bind = parseBind(option(parsed, 'bind') ?? '127.0.0.1');
  if (bind.split(',').includes('docker')) die('--bind docker names this machine\'s Docker bridges; for another machine use 0.0.0.0 or its own addresses', 2);
  if (format === 'uri') {
    process.stdout.write(`${renderUri(cfg)}\n`);
  } else if (format === 'yaml') {
    process.stdout.write(renderClientYaml(cfg, { bind, here: false }));
  } else {
    die(`--format ${format}: yaml or uri`, 2);
  }
  process.stderr.write(`hy2: this carries ${cfg.host}'s password. Anyone with it can use the server; rotate with: qp-tunnel-cli hy2 push ${cfg.host} --rotate-password\n`);
}

function disconnectCommand(parsed: ParsedArgs): void {
  const cfg = requireConfig(parsed, 'disconnect <host> [--purge]');
  if (!systemdHere()) die('there is no local instance on this machine (not Linux with systemd); stop hy2 run with Ctrl-C');
  const status = runPrivileged(['bash', clientScript(), 'uninstall', '--instance', cfg.instance, ...(flag(parsed, 'purge') ? ['--purge'] : [])]);
  if (status !== 0) die(`mihomo-client uninstall --instance ${cfg.instance} failed (exit ${status})`);
  process.stdout.write(`Removed the local instance ${cfg.instance}. The server on ${cfg.host} keeps running; the settings stay in ${hostDir(cfg.host)}.
Back: qp-tunnel-cli hy2 connect ${cfg.host}    Stop the server too: qp-tunnel-cli edge ssh ${cfg.host} -- sudo systemctl disable --now qp-edge-${cfg.component}.service
`);
}

// ---------- hy2 up ----------

async function saveNewHost(name: string, parsed: ParsedArgs): Promise<void> {
  const tty = Boolean(process.stdin.isTTY);
  const address = option(parsed, 'host') ?? (tty ? await promptValue(`Public address of ${name} (IP or DNS name)`, undefined, (value) => (addressPattern.test(value) ? undefined : 'an IP address or a DNS name')) : undefined);
  if (!address) die(`no saved host named ${name}. Pass --host <address> [--user root] [--ssh-port 22] [--key ~/.ssh/id_ed25519], or run in a terminal`, 2);
  const user = option(parsed, 'user') ?? (tty && !option(parsed, 'host') ? await promptValue('SSH user', 'root') : 'root');
  const sshPort = option(parsed, 'ssh-port') ?? (tty && !option(parsed, 'host') ? await promptValue('SSH port', '22') : '22');
  let key = option(parsed, 'key');
  if (!key && tty && !option(parsed, 'host')) {
    key = await promptValue('SSH private key that works there (Enter: log in once with the password instead)', undefined, (value) => (existsSync(expandHome(value)) ? undefined : `${value} does not exist on this machine`), true) || undefined;
  }
  addHost(emptyArgs([name], [
    ['host', address], ['user', user], ['port', sshPort], ['role', option(parsed, 'role') ?? 'hy2'], ['from-setup', true],
    ...(key ? [['key', key] as [string, string]] : []),
  ]));
}

async function ensureReachable(name: string, parsed: ParsedArgs): Promise<void> {
  let probe = probeSsh(name);
  if (!probe.ok && probe.auth && process.stdin.isTTY) {
    process.stdout.write(`${name} does not take this machine's key yet (${probe.message}).\n`);
    if (await askYesNo(`Log in once with ${name}'s password to put this machine's edge key there?`, true)) {
      if (await installKeyWithPassword(name, parsed)) probe = probeSsh(name);
    }
  }
  if (!probe.ok) die(`${name} cannot be reached over SSH (${probe.message}). Check the address, user, key and that its SSH port is open; qp-tunnel-cli edge hosts shows what is saved`);
}

/** Where containers and other programs reach the port, when --bind opens it beyond 127.0.0.1. */
function otherAddresses(cfg: Hy2Config): string {
  const resolved = resolveBind(cfg.bind, false);
  const port = cfg.localPort;
  const firewall = commandExists('ufw') || commandExists('firewall-cmd')
    ? `  firewall     if ufw/firewalld is active here, let containers in: sudo ufw allow from 172.16.0.0/12 to any port ${port} proto tcp
`
    : '';
  if (resolved.all) {
    const mine = localIPv4().filter((address) => !address.startsWith('127.'));
    return `  also         every interface, private and loopback sources only: ${mine.map((address) => `http://${address}:${port}`).join(', ') || `http://<this machine's private address>:${port}`}
  containers   http://172.17.0.1:${port}, or http://host.docker.internal:${port} with extra_hosts: ["host.docker.internal:host-gateway"]
${firewall}`;
  }
  if (resolved.extra.length === 0) {
    return `  containers   not yet: the port listens on 127.0.0.1 only. For Docker: qp-tunnel-cli hy2 connect ${cfg.host} --bind docker (or --bind 0.0.0.0)
`;
  }
  return `  also         ${resolved.extra.map((address) => `http://${address}:${port}`).join(', ')}
  containers   the gateway of their network above, or http://host.docker.internal:${port} with extra_hosts: ["host.docker.internal:host-gateway"]${cfg.bind.split(',').includes('docker') ? `
               new Docker networks later: qp-tunnel-cli hy2 connect ${cfg.host} (looks the bridges up again)` : ''}
${firewall}`;
}

function printSummary(cfg: Hy2Config, connected: boolean, checked: boolean | undefined): void {
  const proxy = `127.0.0.1:${cfg.localPort}`;
  process.stdout.write(`
${bold(checked === false ? 'Server pushed, but the check failed (above).' : 'Done.')} ${connected ? `Applications on this machine reach ${cfg.host} through ${proxy}:` : `The server runs on ${cfg.host}.`}
`);
  if (connected) {
    process.stdout.write(`  HTTP proxy   http://${proxy}
  SOCKS5       socks5h://${proxy}
  try          curl -x http://${proxy} ${defaultIpUrl}
  one command  HTTPS_PROXY=http://${proxy} HTTP_PROXY=http://${proxy} ALL_PROXY=socks5h://${proxy} <command>
  service      mihomo-client@${cfg.instance}.service (qp-tunnel-cli status --instance ${cfg.instance})
`);
    process.stdout.write(otherAddresses(cfg));
  }
  process.stdout.write(`  server       ${cfg.server}:${cfg.port}/udp, unit qp-edge-${cfg.component}.service${cfg.pushed ? `, revision ${cfg.pushed.revision}` : ''}
  later        qp-tunnel-cli hy2 status | hy2 test ${cfg.host} | hy2 export ${cfg.host} --format uri | hy2 push ${cfg.host} --rotate-password
`);
}

async function upCommand(parsed: ParsedArgs): Promise<void> {
  let name = parsed.positionals[0];
  if (!name) {
    if (!process.stdin.isTTY) die('usage: qp-tunnel-cli hy2 up <host> [--host <address> --key <key>] [--port <udp>] [--local-port <tcp>] [--yes]', 2);
    name = await promptValue('Name for the host (as saved by qp-tunnel-cli edge)', undefined, (value) => (/^[A-Za-z0-9._-]+$/.test(value) ? undefined : 'letters, digits, . _ -'));
  }
  validateName('host', name);
  const saved = readHosts().hosts[name];
  const given = option(parsed, 'host');
  if (!saved) {
    await saveNewHost(name, parsed);
  } else if (given && given !== saved.host) {
    die(`${name} is saved with the address ${saved.host}, not ${given}. Change it with qp-tunnel-cli edge add ${name} --host ${given}`, 2);
  }
  await ensureReachable(name, parsed);
  const host = readHosts().hosts[name];
  const interactive = Boolean(process.stdin.isTTY) && !flag(parsed, 'yes', 'y');
  const { cfg } = await pushFlow(name, host, parsed, flag(parsed, 'push'), interactive);
  if (flag(parsed, 'dry-run')) return;
  if (flag(parsed, 'no-connect')) {
    printSummary(cfg, false, undefined);
    return;
  }
  process.stdout.write('\n');
  const connected = await connectLocal(cfg, parsed);
  const checked = connected && !flag(parsed, 'no-test') ? await testTunnel(cfg, parsed) : undefined;
  printSummary(cfg, connected, checked);
  if (checked === false) process.exit(1);
}

/** edge setup, after it saved and looked at the host and the stack picked was hy2: three more steps. */
export async function hy2SetupSteps(name: string, parsed: ParsedArgs, step: (title: string) => void): Promise<void> {
  step('Hysteria2 settings');
  const existing = readConfig(name);
  const host = readHosts().hosts[name];
  const facts = await probeRemote(name, existing?.component ?? 'hy2', option(parsed, 'root') ?? '/opt/mx');
  const notes: string[] = [];
  const portDefault = pickServerPort(name, emptyArgs(), existing, facts, notes);
  for (const note of notes) process.stdout.write(`  ${note}\n`);
  const port = await promptValue(`UDP port on ${name}`, String(portDefault), (value) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > 65535) return 'a port, 1-65535';
    if (facts.udp.has(number) && !(facts.unit === 'active' && existing?.port === number)) return `udp ${number} is in use on ${name}`;
    return undefined;
  });
  const localDefault = existing?.localPort ?? (await pickLocalPort(name, emptyArgs(), undefined, '127.0.0.1'));
  const localPort = await promptValue('Local port on this machine (HTTP + SOCKS5)', String(localDefault), (value) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > 65535) return 'a port, 1-65535';
    return localPortProblem(number);
  });
  parsed.options.set('port', port);
  parsed.options.set('local-port', localPort);

  step(`Push hy2 to ${name}`);
  const { cfg } = await pushFlow(name, host, parsed, true, true);

  step('Local port on this machine, and a check');
  const connected = await connectLocal(cfg, parsed);
  const checked = connected ? await testTunnel(cfg, parsed) : undefined;
  printSummary(cfg, connected, checked);
  if (checked === false) process.exit(1);
}
