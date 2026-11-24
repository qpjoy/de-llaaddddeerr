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
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import {
  type BundleExtra,
  type EdgeHost,
  type ParsedArgs,
  addHost,
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
const hy2Flags = new Set(['obfs', 'no-obfs', 'rotate-password', 'new-cert', 'refresh-engine', 'purge', 'push', 'no-connect', 'no-test', 'no-ip']);
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
  qp-tunnel-cli hy2 connect <host>             local instance hy2-<host> via mihomo-client (Linux, sudo)
  qp-tunnel-cli hy2 run <host>                 the local client in the foreground, any OS (Ctrl-C stops it)
  qp-tunnel-cli hy2 test <host>                through the local port: the host's own sshd answers, and the exit address
  qp-tunnel-cli hy2 status [<host>] [--json]   what this machine set up, and whether each local port is live
  qp-tunnel-cli hy2 show <host>                settings (no secrets) and files
  qp-tunnel-cli hy2 export <host> [--format yaml|uri]   client configuration for another machine or app (has the password)
  qp-tunnel-cli hy2 disconnect <host> [--purge]         remove the local instance; the server keeps running
  qp-tunnel-cli hy2 engine [--target linux-x64|linux-arm64|darwin-arm64|...] [--refresh-engine]   fetch or show an engine

Options for up / init / push:
  --server <address>      what clients dial (default: the saved host address)
  --port <udp>            server port (default 443, else 8443, 10443, ... when taken on the host)
  --sni <name>            TLS server name (default: --server when it is a DNS name)
  --obfs | --no-obfs      salamander obfuscation on or off (default off)
  --up <Mbps> --down <Mbps>   this machine's bandwidth for Hysteria's Brutal congestion control (default: BBR)
  --local-port <tcp>      local mixed (HTTP + SOCKS5) port (default 7891, else the next free one; never 7788 or 7890)
  --bind <address>        local listen address (default 127.0.0.1; anything else opens the proxy to private networks)
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

export function renderClientYaml(cfg: Hy2Config, overrides: { localPort?: number; bind?: string } = {}): string {
  const localPort = overrides.localPort ?? cfg.localPort;
  const bind = overrides.bind ?? cfg.bind;
  const loopback = bind === '127.0.0.1' || bind === 'localhost';
  const name = proxyName(cfg);
  return [
    `${marker} client for ${cfg.host}: ${cfg.server}:${cfg.port}/udp, local mixed port ${localPort}.`,
    '# Rewritten by qp-tunnel-cli hy2 init/push/connect; everything this port receives leaves from that host.',
    `mixed-port: ${localPort}`,
    ...(loopback
      ? ['allow-lan: false']
      : [
        'allow-lan: true',
        `bind-address: ${yamlString(bind === '0.0.0.0' ? '*' : bind)}`,
        // Private and loopback sources only: the port carries no authentication.
        'lan-allowed-ips:',
        ...['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10'].map((cidr) => `  - ${cidr}`),
      ]),
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

function writeClientYaml(cfg: Hy2Config): void {
  writePrivate(clientPath(cfg.host), renderClientYaml(cfg));
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

function canBind(host: string, port: number): Promise<boolean> {
  return new Promise((resolveBind) => {
    const server = createServer();
    server.once('error', () => resolveBind(false));
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolveBind(true)));
  });
}

/** Free = nothing answers on it and it can be bound (on the loopback and, for a wider bind, there too). */
async function localPortFree(port: number, bind: string): Promise<boolean> {
  if (await canConnect('127.0.0.1', port)) return false;
  if (!(await canBind('127.0.0.1', port))) return false;
  if (bind !== '127.0.0.1' && bind !== 'localhost' && !(await canBind(bind, port))) return false;
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

function checkBind(value: string): string {
  if (value === 'localhost') return '127.0.0.1';
  if (isIP(value) !== 4) die(`--bind takes an IPv4 address (127.0.0.1, 0.0.0.0, or one of this machine's), not '${value}'`, 2);
  return value;
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
  const bind = checkBind(option(parsed, 'bind') ?? existing?.bind ?? '127.0.0.1');
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
  };
  if (bind !== '127.0.0.1') notes.push(`the local port listens on ${bind}: anyone on a private network that reaches it can use the proxy`);

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

  const comparable = (value: Hy2Config | undefined) => (value ? JSON.stringify({ ...value, createdAt: '', updatedAt: '', pushed: undefined }) : '');
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
  local      ${cfg.bind}:${cfg.localPort} (HTTP + SOCKS5), mihomo-client instance ${cfg.instance}
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
  return process.platform === 'linux' && (existsSync('/run/systemd/system') || Boolean(process.env.QP_HY2_ASSUME_SYSTEMD));
}

function instanceState(instance: string): string {
  if (!systemdHere()) return 'n/a';
  const result = spawnSync(process.env.QP_HY2_SYSTEMCTL || 'systemctl', ['is-active', `mihomo-client@${instance}.service`], { encoding: 'utf8' });
  return (result.stdout ?? '').trim() || 'unknown';
}

function clientScript(): string {
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
  writeClientYaml(cfg);
  const { bin, source } = await localMihomo(parsed);
  process.stdout.write(`Local instance ${cfg.instance} on ${cfg.bind}:${cfg.localPort} (engine ${source}; mihomo-client, sudo)\n`);
  const status = runPrivileged(['bash', clientScript(), 'install', '--instance', cfg.instance, '--mixed-port', String(cfg.localPort), '--file', clientPath(cfg.host), '--binary-path', bin]);
  if (status !== 0) die(`mihomo-client install --instance ${cfg.instance} failed (exit ${status}). Logs: qp-tunnel-cli logs --instance ${cfg.instance}`);
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
      process.stdout.write(`Local port ${existing.bind}:${existing.localPort} -> ${cfg.bind}:${cfg.localPort}\n`);
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
  const bind = checkBind(option(parsed, 'bind') ?? cfg.bind);
  if (!(await localPortFree(localPort, bind))) {
    die(`local port ${localPort} is in use${instanceState(cfg.instance) === 'active' ? ` (the installed instance ${cfg.instance} already serves it)` : ''}; pick another with --local-port <n>`);
  }
  const { bin, source } = await localMihomo(parsed);
  const runDir = join(hostDir(cfg.host), 'run');
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const file = join(runDir, 'config.yaml');
  writePrivate(file, renderClientYaml(cfg, { localPort, bind }));
  process.stdout.write(`${bold(`hy2 ${cfg.host}`)}: ${cfg.server}:${cfg.port}/udp  ->  local ${bind}:${localPort} (HTTP + SOCKS5). Ctrl-C stops it.
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
  const proxyHost = cfg.bind === '0.0.0.0' ? '127.0.0.1' : cfg.bind;
  const sshPort = parseNumber('--ssh-port', option(parsed, 'ssh-port'), 1, 65535) ?? readHosts().hosts[cfg.host]?.port ?? 22;
  const timeoutMs = (parseNumber('--timeout', option(parsed, 'timeout'), 1, 120) ?? 12) * 1000;
  process.stdout.write(`\nChecking the tunnel to ${cfg.host} through ${proxyHost}:${localPort} ...\n`);
  if (!(await canConnect(proxyHost, localPort, 2000))) {
    process.stdout.write(`  FAIL  nothing listens on ${proxyHost}:${localPort}. ${systemdHere() ? `Look at: qp-tunnel-cli status --instance ${cfg.instance}` : `Start it: qp-tunnel-cli hy2 run ${cfg.host}`}\n`);
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
    const url = option(parsed, 'ip-url') ?? defaultIpUrl;
    try {
      exitIp = await getViaProxy(proxyHost, localPort, url, timeoutMs);
      const same = exitIp === cfg.server;
      process.stdout.write(`  ok    exit address ${exitIp} (${url})${same ? ', the server itself' : isIP(cfg.server) ? `; the server is ${cfg.server} (a host with several addresses, or NAT, can differ)` : ''}\n`);
      tunnel = true;
    } catch (error) {
      process.stdout.write(`  ${tunnel ? 'note' : 'fail'}  ${url} through the tunnel: ${error instanceof Error ? error.message : String(error)}${tunnel ? ' (the tunnel works; that site may be unreachable from the host)' : ''}\n`);
    }
  }
  if (!tunnel) {
    process.stdout.write(`  FAIL  no answer through the tunnel (${bannerError || 'no detail'}). The usual causes, most likely first:
        - udp ${cfg.port} is not allowed by ${cfg.host}'s cloud security group, or by its host firewall (the push printed that report)
        - the server is not running: qp-tunnel-cli edge status ${cfg.host} --health
        - ${cfg.server} is not the address clients reach (pass --server <public address> to hy2 push)
        - this machine's own network blocks outgoing UDP (some offices do)
        Local client log: ${systemdHere() ? `qp-tunnel-cli logs --instance ${cfg.instance}` : 'the hy2 run terminal'}
`);
  }
  return tunnel;
}

async function testCommand(parsed: ParsedArgs): Promise<void> {
  const cfg = requireConfig(parsed, 'test <host> [--local-port <n>] [--ssh-port <n>] [--no-ip] [--ip-url http://...]');
  if (!(await testTunnel(cfg, parsed))) process.exit(1);
}

// ---------- status, show, export, disconnect ----------

async function statusCommand(parsed: ParsedArgs): Promise<void> {
  const only = parsed.positionals[0];
  const configs = allConfigs().filter((cfg) => !only || cfg.host === only);
  if (only && configs.length === 0) die(`no hy2 set up for ${only} on this machine. Start with: qp-tunnel-cli hy2 up ${only}`);
  const rows = await Promise.all(configs.map(async (cfg) => {
    const probeHost = cfg.bind === '0.0.0.0' ? '127.0.0.1' : cfg.bind;
    const listening = await canConnect(probeHost, cfg.localPort);
    return { cfg, instance: instanceState(cfg.instance), listening };
  }));
  if (flag(parsed, 'json')) {
    process.stdout.write(`${JSON.stringify(rows.map(({ cfg, instance, listening }) => ({
      host: cfg.host, component: cfg.component, server: cfg.server, port: cfg.port, local: `${cfg.bind}:${cfg.localPort}`,
      instance: cfg.instance, instanceState: instance, listening, pushed: cfg.pushed ?? null,
    })), null, 2)}\n`);
    return;
  }
  if (rows.length === 0) {
    process.stdout.write(`No hy2 set up from this machine yet (${hy2Root()}).\nStart: qp-tunnel-cli hy2 up <host> --host <address>\n`);
    return;
  }
  printTable(['HOST', 'SERVER', 'LOCAL', 'INSTANCE', 'STATE', 'PUSHED'], rows.map(({ cfg, instance, listening }) => [
    cfg.host,
    `${cfg.server}:${cfg.port}/udp`,
    `${cfg.bind}:${cfg.localPort}`,
    cfg.instance,
    `${instance}${listening ? ', listening' : ', not listening'}`,
    cfg.pushed ? `${cfg.pushed.revision}` : 'never',
  ]));
  process.stdout.write(`\nCheck one: qp-tunnel-cli hy2 test <host>    The host side: qp-tunnel-cli edge status <host> --health\n`);
}

function showCommand(parsed: ParsedArgs): void {
  const cfg = requireConfig(parsed, 'show <host>');
  process.stdout.write(`hy2 ${cfg.host}
${describe(cfg)}  user       ${cfg.user} (password in ${configPath(cfg.host)}; hy2 export prints it)
  bandwidth  ${cfg.upMbps || cfg.downMbps ? `up ${cfg.upMbps ?? '-'} / down ${cfg.downMbps ?? '-'} Mbps (Brutal)` : 'not set (BBR)'}
  pushed     ${cfg.pushed ? `${cfg.pushed.revision} at ${cfg.pushed.at}, engine ${cfg.pushed.engine}` : 'never'}
  this side  ${instanceState(cfg.instance)}
`);
}

function exportCommand(parsed: ParsedArgs): void {
  const cfg = requireConfig(parsed, 'export <host> [--format yaml|uri]');
  const format = option(parsed, 'format') ?? 'yaml';
  if (format === 'uri') {
    process.stdout.write(`${renderUri(cfg)}\n`);
  } else if (format === 'yaml') {
    process.stdout.write(renderClientYaml(cfg));
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

function printSummary(cfg: Hy2Config, connected: boolean, checked: boolean | undefined): void {
  const proxy = `${cfg.bind === '0.0.0.0' ? '127.0.0.1' : cfg.bind}:${cfg.localPort}`;
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
