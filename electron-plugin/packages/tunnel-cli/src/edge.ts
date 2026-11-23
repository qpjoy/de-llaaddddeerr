import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import {
  accessSync,
  appendFileSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

/**
 * `qp-tunnel-cli edge` - reach and deploy to edge hosts (Domestic relays, jump
 * hosts, bastions) from an Internal machine over plain SSH.
 *
 * Edge hosts have a public address, so Internal can push to them directly; they
 * never need Kubernetes. The deploy model is the v1 Launcher site-slot one cut
 * down to its core: upload a bundle, extract it as a new release under
 * /opt/mx/releases/<component>/<revision>, switch /opt/mx/current/<component>,
 * run the bundle's deploy.sh and health.sh. Releases are never overwritten or
 * deleted, so rollback is a symlink switch plus the old hooks.
 *
 * Host facts live in a local JSON file (no passwords, only key paths). The
 * Launcher keeps the same facts as site-slot SSH profiles; `edge import` copies
 * them over with one read-only GET.
 *
 * Every remote action is resources/edge/lib/edge-os.sh plus
 * resources/edge/remote.sh streamed over ssh, so the same code runs when an
 * operator copies resources/edge to a host by hand.
 *
 * Stacks (resources/edge/stacks/<name>) are ready-made bundles per technology:
 * wg-nginx, open-nginx, hy2-mihomo. Each declares the OS families it handles in
 * stack.env; remote.sh checks the host against it before switching anything.
 * Secrets never travel inside a bundle: they come from --state-dir and land in
 * state/<component>/ on the host.
 *
 * Any Internal machine can push: each is an "origin" with a name (edge origin).
 * The host records which origin manages each component and refuses a push or
 * rollback from another origin unless --take-over. Each origin keeps an edge
 * home (default /var/lib/qp-tunnel/edge on Linux, outside home directories,
 * Git checkouts and the npm install) with its name, the per-host state
 * directories and an append-only ledger of its pushes; `edge relations` joins
 * the ledger with what the hosts report.
 */

export interface EdgeHost {
  host: string;
  user: string;
  port: number;
  key?: string;
  knownHostsFile?: string;
  jump?: string;
  role?: string;
  note?: string;
  source?: string;
  launcherIdentityFile?: string;
}

interface HostsFile {
  version: 1;
  hosts: Record<string, EdgeHost>;
}

interface ParsedArgs {
  positionals: string[];
  options: Map<string, string | true>;
  lists: Map<string, string[]>;
  passthrough: string[];
}

const packageRoot = resolve(__dirname, '..');
const edgeResources = resolve(packageRoot, 'resources/edge');
const remoteScriptPath = join(edgeResources, 'remote.sh');
const edgeLibDir = join(edgeResources, 'lib');
const stacksDir = join(edgeResources, 'stacks');
// A source checkout has the vendored files at their repository paths; the npm
// package carries copies under resources/edge/vendor (scripts/prepare-package.mjs).
const repoRoot = resolve(packageRoot, '../../..');
const namePattern = /^[A-Za-z0-9._-]+$/;
const defaultRoot = '/opt/mx';

const flagOptions = new Set(['dry-run', 'yes', 'y', 'json', 'help', 'h', 'take-over', 'shared-host', 'force-os', 'health', 'local', 'all', 'offline', 'no-boot', 'replace']);
// Words the host side uses in status and history; an origin cannot be called that.
const reservedOrigins = new Set(['edge', 'other', 'manual', 'local']);

export async function runEdgeCli(args: string[]): Promise<void> {
  const command = args[0] ?? 'help';
  const parsed = parseArgs(args.slice(1));
  if (command === 'help' || command === '--help' || command === '-h' || parsed.options.has('help')) {
    edgeHelp();
    return;
  }

  switch (command) {
    case 'hosts':
    case 'list':
      listHosts(parsed);
      return;
    case 'add':
      addHost(parsed);
      return;
    case 'remove':
    case 'rm':
      removeHost(parsed);
      return;
    case 'import':
      await importFromLauncher(parsed);
      return;
    case 'ssh':
      await sshInto(parsed);
      return;
    case 'check':
      await checkHosts(parsed);
      return;
    case 'status':
      await status(parsed);
      return;
    case 'stacks':
    case 'stack':
      stacksCommand(parsed);
      return;
    case 'origin':
      await originCommand(parsed);
      return;
    case 'relations':
      await relations(parsed);
      return;
    case 'state':
      await stateCommand(parsed);
      return;
    case 'link':
    case 'links':
      await linkCommand(parsed);
      return;
    case 'setup':
    case 'wizard':
    case 'tui':
      await setupWizard(parsed);
      return;
    case 'releases':
      await releases(parsed);
      return;
    case 'push':
      await push(parsed);
      return;
    case 'rollback':
      await rollback(parsed);
      return;
    case 'key':
      await keyCommand(parsed);
      return;
    case 'ssh-args':
      await printSshArgs(parsed);
      return;
    default:
      process.stderr.write(`Unknown edge command: ${command}\n\n`);
      edgeHelp();
      process.exit(2);
  }
}

function edgeHelp(): void {
  process.stdout.write(`qp-tunnel-cli edge - reach and deploy to edge hosts (Domestic relays, jump hosts, bastions) over SSH

Step by step (asks one question at a time, with defaults; installs missing tools after asking):
  qp-tunnel-cli edge setup                              tools, edge home, origin name, host, read-only look, stack,
                                                        tunnel, push, this side of the tunnel, check

Saved hosts (${hostsFilePath()}; no passwords, only key paths):
  qp-tunnel-cli edge hosts [--role domestic] [--json]
  qp-tunnel-cli edge add <name> --host <ip|dns> [--user root] [--port 22] [--key ~/.ssh/id_ed25519]
                         [--jump <saved-name>|user@host[:port]] [--known-hosts <file>] [--role domestic] [--note text]
  qp-tunnel-cli edge remove <name>                      forgets the entry; touches no machine
  qp-tunnel-cli edge key                                this origin's SSH key for edge hosts (<edge home>/ssh/id_ed25519)
  qp-tunnel-cli edge key install <name>                 host that only takes a password: log in once (you type the password
                         into ssh's own prompt; it is not seen or kept here), add this origin's public key to
                         authorized_keys there, and use the key from then on
  qp-tunnel-cli edge import --launcher-url http://10.88.88.88:18090 [--token <ops-token>]
                         copies the Launcher's site-slot SSH profiles (one GET); keys stay where they are

Reach a host (omit <name> in a terminal to pick from the saved list):
  qp-tunnel-cli edge ssh [<name>] [-- <command> ...]      like ssh: the command words reach the remote shell as typed
  qp-tunnel-cli edge check [<name>[,<name>...]] [--role domestic]   read-only: os, cpu, memory, network, listeners, wireguard, docker, releases
  qp-tunnel-cli edge ssh-args <name>                    prints the ssh arguments, for scp/rsync or debugging

What runs where (read-only):
  qp-tunnel-cli edge status [<name>[,<name>...] | --role domestic | --local] [--health] [--all] [--json]
                         this machine plus every saved host: pushed releases, qp-tunnel-cli wg/open/mihomo
                         instances, other WireGuard interfaces, running containers (--all: stopped ones and
                         Kubernetes pod containers too), nginx/caddy/docker/containerd/kubelet

Who manages what (any Internal machine can push; each one is an origin):
  qp-tunnel-cli edge origin                             this origin's name, its edge home, state directories, ledger
  qp-tunnel-cli edge origin set <name>                  name this machine once (default: its short hostname)
  qp-tunnel-cli edge relations [<name>[,<name>...] | --role domestic | --local] [--offline] [--json]
                         origin -> host -> component (stack, revision, since), from what the hosts report,
                         checked against this origin's ledger; --offline reads only the ledger

Stacks (ready-made bundles, one per technology; ${stacksDir}):
  qp-tunnel-cli edge stacks                             list: wg-nginx, open-nginx, hy2-mihomo
  qp-tunnel-cli edge stacks <stack> [--init <dir>]      details; --init writes the state template to fill in

State directories kept by this origin (<edge home>/state/<host>/<component>; certificates, keys, site files):
  qp-tunnel-cli edge state                              list them
  qp-tunnel-cli edge state init <name> --stack <stack> [--component <name>]   write the template there (never overwrites)
  qp-tunnel-cli edge state pull <name> --component <name>   copy back what pushes put on the host (never overwrites)

Tunnel from this machine to an edge host (the Launcher's mx-domestic 10.88.0.1 / mx-internal-svc 10.88.88.88 shape:
the edge host listens, this machine dials out and routes only the edge host's /32; no DNS change, no default route):
  qp-tunnel-cli edge link                               list this origin's links and whether each interface is up
  qp-tunnel-cli edge link init <name> [--plan launcher|isolated | --subnet <cidr>] [--ip <this machine's address>] [--relay-ip <addr>] [--port 51820]
                         [--endpoint host:port] [--interface qpjoy-<name>] [--relay-interface qpjoy-relay] [--component wg-nginx]
                         makes both key pairs here; the relay side goes into state/<name>/<component>/wg/ for
                         edge push --stack wg-nginx, this side stays in <edge home>/links/<name>/ (never overwrites;
                         --replace moves the current link to <edge home>/replaced/ first).
                         --plan launcher (default in a terminal): the Launcher's numbering in 10.88.0.0/16, this machine
                         (origin <name>M) 10.88.88.(87+M) (s2 .89; s1 .87, because 10.88.88.88 is the Launcher's Internal),
                         edge host <name>N 10.88.0.N (10.88.0.1 stays the current Domestic, 10.88.88.88 the current Internal,
                         10.88.100.0/24 the Launcher's VIPs); --plan isolated: 100.127.200.0/24,
                         same numbering, for other clusters. Only /32s are routed; only edge host -> Internal.
                         Refused: an address another interface routes or holds; outside the launcher plan also
                         10.0.0.0/8 (Launcher applications), 100.88.0.0/14 (HDO V1), 100.127.0.0/24 (OpenVPN mesh),
                         192.168.224.0/19 (Kubernetes)
  qp-tunnel-cli edge link show <name>                   addresses, keys (public only), files
  qp-tunnel-cli edge link up <name> [--no-boot] [--yes] installs wireguard-tools when missing (asks; --yes does not),
                         installs this side as /etc/wireguard/<interface>.conf (sudo), starts wg-quick@<interface>
                         (enabled at boot unless --no-boot), then checks it
  qp-tunnel-cli edge link check <name>                  read-only, both ends: unit, handshake, routes, ping
  qp-tunnel-cli edge link down <name>                   stops this side (files stay)

Deploy (layout under --root, default ${defaultRoot}):
  qp-tunnel-cli edge push <name>[,<name>...] (--stack <stack> | --bundle <dir>) [--state-dir <dir>] [--image <ref>]...
                         [--component <name>] [--revision <rev>] [--root ${defaultRoot}] [--take-over] [--shared-host] [--force-os]
                         [--dry-run] [--yes]
  qp-tunnel-cli edge releases <name> [--component <name>]
  qp-tunnel-cli edge rollback <name> --component <name> [--revision <rev>] [--take-over] [--yes]

push uploads the bundle as releases/<component>/<revision> and the state files into state/<component>
(replaced files are copied to state/<component>/.edge-replaced/<revision>/ first). The state files come from
--state-dir, else from this origin's <edge home>/state/<host>/<component> when it exists. Before switching anything
the host is checked: OS family (debian or rhel), systemd and required state files from the stack; a component
another origin manages, or a current/<component> the edge tool did not create (the v1 Launcher uses the same
layout), is left alone unless --take-over; a host where another tool deployed any component (the current Domestic)
is left alone unless --shared-host. Then current/<component> is switched and deploy.sh, health.sh run.
--image ships a local docker image for hosts that cannot pull. Several hosts are pushed one after another and the
run stops at the first failure. Nothing is ever deleted on the host; rollback switches current back and reruns
that release's hooks. Every push and rollback is appended to this origin's ledger.

Environment: QP_EDGE_HOME (edge home), QP_EDGE_ORIGIN (origin name), QP_EDGE_HOSTS_FILE (hosts file),
             QP_EDGE_SSH_BIN (ssh binary), MX_OPS_TOKEN (Launcher ops token),
             QP_EDGE_SUDO (sudo command for edge link up/down/check; empty runs without), QP_EDGE_WG_DIR (default /etc/wireguard)
`);
}

// ---------- argument parsing ----------

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options = new Map<string, string | true>();
  const lists = new Map<string, string[]>();
  let passthrough: string[] = [];
  const remember = (key: string, value: string) => {
    options.set(key, value);
    lists.set(key, [...(lists.get(key) ?? []), value]);
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      passthrough = args.slice(index + 1);
      break;
    }
    if (arg.startsWith('--') || (arg.startsWith('-') && arg.length === 2)) {
      const raw = arg.replace(/^--?/, '');
      const eq = raw.indexOf('=');
      if (eq >= 0) {
        remember(raw.slice(0, eq), raw.slice(eq + 1));
        continue;
      }
      if (flagOptions.has(raw)) {
        options.set(raw, true);
        continue;
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) fail(`--${raw} needs a value`);
      remember(raw, value);
      index += 1;
      continue;
    }
    positionals.push(arg);
  }
  return { positionals, options, lists, passthrough };
}

function option(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.options.get(name);
  return typeof value === 'string' ? value : undefined;
}

/** Every value of a repeatable option; commas split too (--image a,b --image c). */
function optionList(parsed: ParsedArgs, name: string): string[] {
  return (parsed.lists.get(name) ?? []).flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean);
}

function flag(parsed: ParsedArgs, ...names: string[]): boolean {
  return names.some((name) => parsed.options.get(name) === true);
}

function fail(message: string, code = 2): never {
  process.stderr.write(`edge: ${message}\n`);
  process.exit(code);
}

// ---------- hosts file ----------

function hostsFilePath(): string {
  return process.env.QP_EDGE_HOSTS_FILE || join(homedir(), '.config', 'qp-tunnel', 'edge-hosts.json');
}

function readHosts(): HostsFile {
  const file = hostsFilePath();
  if (!existsSync(file)) return { version: 1, hosts: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<HostsFile>;
    return { version: 1, hosts: parsed.hosts ?? {} };
  } catch (error) {
    fail(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}

function writeHosts(data: HostsFile): void {
  const file = hostsFilePath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

function validateName(label: string, value: string): void {
  if (!namePattern.test(value) || value === '.' || value === '..') {
    fail(`invalid ${label} '${value}' (allowed: letters, digits, . _ -)`);
  }
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`invalid port '${value}'`);
  return port;
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

function listHosts(parsed: ParsedArgs): void {
  const role = option(parsed, 'role');
  const entries = Object.entries(readHosts().hosts).filter(([, host]) => !role || host.role === role);
  if (flag(parsed, 'json')) {
    process.stdout.write(`${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`);
    return;
  }
  if (entries.length === 0) {
    process.stdout.write(`No saved hosts${role ? ` with role ${role}` : ''} in ${hostsFilePath()}.\n`);
    printAddHint();
    return;
  }
  const rows = entries.map(([name, host]) => [
    name,
    host.role ?? '-',
    `${host.user}@${host.host}:${host.port}`,
    host.jump ? `via ${host.jump}` : '-',
    host.key ?? (host.launcherIdentityFile ? 'no local key (Launcher has one)' : 'ssh default'),
    host.note ?? '',
  ]);
  const header = ['NAME', 'ROLE', 'TARGET', 'JUMP', 'KEY', 'NOTE'];
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)));
  for (const row of [header, ...rows]) {
    process.stdout.write(`${row.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd()}\n`);
  }
}

function printAddHint(): void {
  process.stdout.write(`Add one:          qp-tunnel-cli edge add domestic-1 --host 203.0.113.10 --key ~/.ssh/id_ed25519 --role domestic
Or copy from Launcher: qp-tunnel-cli edge import --launcher-url http://10.88.88.88:18090
`);
}

function addHost(parsed: ParsedArgs): void {
  const name = parsed.positionals[0];
  if (!name) fail('usage: edge add <name> --host <ip|dns> [--user root] [--port 22] [--key path] [--jump name] [--role domestic]');
  validateName('name', name);
  const data = readHosts();
  const previous = data.hosts[name];
  const host = option(parsed, 'host') ?? previous?.host;
  if (!host) fail('--host is required for a new entry');
  const key = option(parsed, 'key');
  if (key && !existsSync(expandHome(key))) {
    process.stderr.write(`edge: warning: key file ${key} does not exist on this machine yet\n`);
  }
  const jump = option(parsed, 'jump') ?? previous?.jump;
  if (jump === name) fail('a host cannot be its own jump host');
  const entry: EdgeHost = {
    ...previous,
    host,
    user: option(parsed, 'user') ?? previous?.user ?? 'root',
    port: parsePort(option(parsed, 'port'), previous?.port ?? 22),
    ...(key !== undefined ? { key } : {}),
    ...(option(parsed, 'known-hosts') !== undefined ? { knownHostsFile: option(parsed, 'known-hosts') } : {}),
    ...(jump ? { jump } : {}),
    ...(option(parsed, 'role') !== undefined ? { role: option(parsed, 'role') } : {}),
    ...(option(parsed, 'note') !== undefined ? { note: option(parsed, 'note') } : {}),
    source: previous?.source ?? 'manual',
  };
  data.hosts[name] = entry;
  writeHosts(data);
  process.stdout.write(`${previous ? 'Updated' : 'Saved'} ${name}: ${entry.user}@${entry.host}:${entry.port}${entry.jump ? ` via ${entry.jump}` : ''}\n`);
  if (!parsed.options.has('from-setup')) process.stdout.write(`Next: qp-tunnel-cli edge check ${name}\n`);
}

function removeHost(parsed: ParsedArgs): void {
  const name = parsed.positionals[0];
  if (!name) fail('usage: edge remove <name>');
  const data = readHosts();
  if (!data.hosts[name]) fail(`no saved host named ${name}`, 1);
  const users = Object.entries(data.hosts).filter(([, host]) => host.jump === name).map(([other]) => other);
  if (users.length > 0) fail(`${name} is the jump host of ${users.join(', ')}; change those first`, 1);
  delete data.hosts[name];
  writeHosts(data);
  process.stdout.write(`Forgot ${name}. Nothing on the host was touched.\n`);
}

interface LauncherSshProfile {
  profileId?: string;
  siteId?: string;
  kind?: string;
  host?: string | null;
  sshUser?: string;
  sshPort?: number;
  identityFile?: string | null;
  status?: string;
}

async function importFromLauncher(parsed: ParsedArgs): Promise<void> {
  const base = option(parsed, 'launcher-url') ?? process.env.MX_LAUNCHER_URL;
  if (!base) fail('usage: edge import --launcher-url http://10.88.88.88:18090 [--token <ops-token>]');
  const url = `${base.replace(/\/+$/, '')}/internal/v1/config-center/site-slot-ssh-profiles`;
  const token = option(parsed, 'token') ?? process.env.MX_OPS_TOKEN;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: token ? { 'x-mx-ops-token': token } : {},
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    fail(`cannot reach ${url}: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
  if (!response.ok) fail(`${url} answered HTTP ${response.status}${response.status === 401 || response.status === 403 ? ' (pass --token or MX_OPS_TOKEN)' : ''}`, 1);
  const body = (await response.json()) as { profiles?: LauncherSshProfile[] };
  const profiles = Array.isArray(body.profiles) ? body.profiles : [];

  const data = readHosts();
  let imported = 0;
  for (const profile of profiles) {
    const name = (profile.siteId || profile.profileId || '').replace(/[^A-Za-z0-9._-]/g, '_');
    if (!name || !profile.host) {
      process.stdout.write(`skip ${profile.profileId ?? '(unnamed)'}: no host recorded in Launcher\n`);
      continue;
    }
    const previous = data.hosts[name];
    data.hosts[name] = {
      ...previous,
      host: profile.host,
      user: profile.sshUser || previous?.user || 'root',
      port: profile.sshPort || previous?.port || 22,
      role: profile.kind || previous?.role,
      source: `launcher:${profile.profileId ?? name}`,
      ...(profile.identityFile ? { launcherIdentityFile: profile.identityFile } : {}),
      ...(profile.status === 'paused' ? { note: 'paused in Launcher' } : {}),
    };
    imported += 1;
    process.stdout.write(`${previous ? 'updated' : 'added'} ${name}: ${data.hosts[name].user}@${profile.host}:${data.hosts[name].port}${data.hosts[name].key ? '' : '  (no local key yet)'}\n`);
  }
  writeHosts(data);
  process.stdout.write(`Imported ${imported} of ${profiles.length} Launcher profiles into ${hostsFilePath()}.\n`);
  if (Object.values(data.hosts).some((host) => !host.key && host.launcherIdentityFile)) {
    process.stdout.write(`Launcher keeps its private keys inside its own volume; this file only records their path there.
Point an entry at a key this machine can read: qp-tunnel-cli edge add <name> --key ~/.ssh/<key>
`);
  }
}

// ---------- edge home, origin, ledger ----------

/**
 * Where this origin keeps what must outlive a reinstall: its name, the state
 * directories it pushes (secrets) and the ledger. Not under the home directory
 * on Linux, not in a Git checkout or the npm install, not under /tmp.
 */
function edgeHome(): string {
  if (process.env.QP_EDGE_HOME) return resolve(expandHome(process.env.QP_EDGE_HOME));
  if (process.platform === 'linux') return '/var/lib/qp-tunnel/edge';
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'qp-tunnel', 'edge');
  return join(homedir(), '.local', 'share', 'qp-tunnel', 'edge');
}

function homeWritable(home: string): boolean {
  try {
    accessSync(home, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Creates the edge home when the parent allows it; otherwise says how to, once, with sudo. */
function ensureHome(): string {
  const home = edgeHome();
  if (!existsSync(home)) {
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 });
    } catch {
      fail(`cannot create the edge home ${home}. Create it once on this machine (it will hold state directories with secrets):
  sudo install -d -m 700 -o "$(id -un)" ${shellQuote(home)}
or set QP_EDGE_HOME to a directory that survives reinstalls and is not inside a Git checkout`, 1);
    }
  }
  if (!homeWritable(home)) fail(`the edge home ${home} is not writable by this user. sudo chown "$(id -un)" ${shellQuote(home)}`, 1);
  return home;
}

function stateRoot(): string {
  return join(edgeHome(), 'state');
}

function defaultStateDir(host: string, component: string): string {
  return join(stateRoot(), host, component);
}

interface OriginInfo {
  name?: string;
  source: string;
  error?: string;
}

function checkOriginName(name: string): string | undefined {
  if (!namePattern.test(name) || name === '.' || name === '..') return `'${name}' is not a valid origin name (letters, digits, . _ -)`;
  if (reservedOrigins.has(name)) return `'${name}' is reserved (the host side uses ${[...reservedOrigins].join(', ')})`;
  return undefined;
}

function readOrigin(): OriginInfo {
  const fromEnv = process.env.QP_EDGE_ORIGIN;
  if (fromEnv) {
    const error = checkOriginName(fromEnv);
    return error ? { source: 'QP_EDGE_ORIGIN', error } : { name: fromEnv, source: 'QP_EDGE_ORIGIN' };
  }
  const file = join(edgeHome(), 'origin');
  if (existsSync(file)) {
    const name = readFileSync(file, 'utf8').split('\n')[0].trim();
    const error = checkOriginName(name);
    return error ? { source: file, error } : { name, source: file };
  }
  const short = hostname().split('.')[0];
  if (!short || /^localhost$/i.test(short)) {
    return { source: 'hostname', error: `this machine's hostname (${hostname() || 'empty'}) cannot tell origins apart` };
  }
  const error = checkOriginName(short);
  return error ? { source: 'hostname', error } : { name: short, source: 'hostname' };
}

function requireOrigin(): string {
  const origin = readOrigin();
  if (!origin.name) fail(`${origin.error}. Name this machine once: qp-tunnel-cli edge origin set <name>`, 1);
  return origin.name;
}

interface LedgerEntry {
  at: string;
  origin: string;
  host: string;
  target: string;
  action: 'push' | 'rollback';
  component: string;
  revision?: string;
  stack?: string;
  result: 'ok' | 'failed' | 'unreachable';
  exit?: number;
  state?: string;
}

function ledgerPath(): string {
  return join(edgeHome(), 'ledger.jsonl');
}

/** Append-only; one JSON object per line. Nothing in the tool rewrites or trims it. */
function appendLedger(entry: LedgerEntry): void {
  try {
    appendFileSync(ledgerPath(), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch (error) {
    process.stderr.write(`edge: warning: could not append to ${ledgerPath()}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function readLedger(): LedgerEntry[] {
  const file = ledgerPath();
  if (!existsSync(file)) return [];
  const entries: LedgerEntry[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as LedgerEntry);
    } catch {
      process.stderr.write(`edge: warning: skipped an unreadable line in ${file}\n`);
    }
  }
  return entries;
}

function resultOf(status: number): LedgerEntry['result'] {
  return status === 0 ? 'ok' : status === 255 ? 'unreachable' : 'failed';
}

function targetOf(host: EdgeHost): string {
  return `${host.user}@${host.host}:${host.port}${host.jump ? ` via ${host.jump}` : ''}`;
}

async function originCommand(parsed: ParsedArgs): Promise<void> {
  if (parsed.positionals[0] === 'set') {
    const name = parsed.positionals[1];
    if (!name) fail('usage: edge origin set <name>');
    const error = checkOriginName(name);
    if (error) fail(error);
    const home = ensureHome();
    const file = join(home, 'origin');
    const previous = existsSync(file) ? readFileSync(file, 'utf8').split('\n')[0].trim() : undefined;
    if (previous && previous !== name) {
      process.stderr.write(`Hosts record ${previous} as the origin of what this machine pushed. After the rename they refuse pushes
from ${name} until each component is pushed once with --take-over.\n`);
      await confirm(parsed, `Rename this origin from ${previous} to ${name}?`);
    }
    writeFileSync(file, `${name}\n`, { mode: 0o600 });
    process.stdout.write(`This origin is ${name} (${file}).\n`);
    if (process.env.QP_EDGE_ORIGIN && process.env.QP_EDGE_ORIGIN !== name) {
      process.stdout.write(`Note: QP_EDGE_ORIGIN=${process.env.QP_EDGE_ORIGIN} is set in this shell and wins over the file.\n`);
    }
    return;
  }
  if (parsed.positionals[0]) fail('usage: edge origin [set <name>]');
  const home = edgeHome();
  const origin = readOrigin();
  const ledger = existsSync(home) ? readLedger() : [];
  const stateDirs = listStateDirs();
  const info = {
    origin: origin.name ?? null,
    source: origin.source,
    ...(origin.error ? { error: origin.error } : {}),
    home,
    homeExists: existsSync(home),
    homeWritable: existsSync(home) && homeWritable(home),
    stateDirs: stateDirs.length,
    ledgerEntries: ledger.length,
    lastLedgerEntry: ledger.at(-1)?.at ?? null,
    hostsFile: hostsFilePath(),
    savedHosts: Object.keys(readHosts().hosts).length,
  };
  if (flag(parsed, 'json')) {
    process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
    return;
  }
  process.stdout.write(`origin   ${origin.name ?? `not usable: ${origin.error}`} (from ${origin.source})
home     ${home} (${!info.homeExists ? 'does not exist yet; created on the first push, or: sudo install -d -m 700 -o "$(id -un)" ' + shellQuote(home) : info.homeWritable ? 'writable' : 'NOT writable by this user'})
state    ${stateDirs.length} director${stateDirs.length === 1 ? 'y' : 'ies'} under ${stateRoot()}
ledger   ${ledger.length} entr${ledger.length === 1 ? 'y' : 'ies'} in ${ledgerPath()}${info.lastLedgerEntry ? `, last ${info.lastLedgerEntry}` : ''}
hosts    ${info.savedHosts} saved in ${info.hostsFile}
`);
  if (!origin.name) process.stdout.write('\nName this machine: qp-tunnel-cli edge origin set <name>\n');
}

// ---------- host selection ----------

async function selectHosts(parsed: ParsedArgs, allowMany: boolean): Promise<Array<[string, EdgeHost]>> {
  const data = readHosts();
  const role = option(parsed, 'role');
  const spec = parsed.positionals[0];
  if (spec) {
    const names = spec.split(',').map((name) => name.trim()).filter(Boolean);
    if (names.length > 1 && !allowMany) fail('this command takes one host');
    return names.map((name) => {
      const host = data.hosts[name];
      if (!host) fail(`no saved host named ${name}. Saved: ${Object.keys(data.hosts).join(', ') || '(none)'}`, 1);
      return [name, host] as [string, EdgeHost];
    });
  }
  if (role && allowMany) {
    const matched = Object.entries(data.hosts).filter(([, host]) => host.role === role);
    if (matched.length === 0) fail(`no saved host with role ${role}`, 1);
    return matched;
  }
  return [await promptForHost(data, role)];
}

async function promptForHost(data: HostsFile, role?: string): Promise<[string, EdgeHost]> {
  const entries = Object.entries(data.hosts).filter(([, host]) => !role || host.role === role);
  if (entries.length === 0) {
    process.stderr.write(`No saved hosts in ${hostsFilePath()}.\n`);
    printAddHint();
    process.exit(2);
  }
  if (!process.stdin.isTTY) {
    fail(`no host given. Saved hosts: ${entries.map(([name]) => name).join(', ')}`);
  }
  process.stderr.write('Saved hosts:\n');
  entries.forEach(([name, host], index) => {
    process.stderr.write(`  ${index + 1}) ${name}  ${host.user}@${host.host}:${host.port}${host.jump ? ` via ${host.jump}` : ''}${host.role ? `  [${host.role}]` : ''}${host.note ? `  ${host.note}` : ''}\n`);
  });
  const answer = (await ask(`Pick a host [1-${entries.length}] or name: `)).trim();
  const byIndex = Number(answer);
  const picked = Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= entries.length
    ? entries[byIndex - 1]
    : entries.find(([name]) => name === answer);
  if (!picked) fail(`no such host: ${answer}`);
  return picked;
}

let sigintHooked = false;

/**
 * One line from the terminal. terminal: false keeps readline from writing cursor
 * control (ESC[1G, ESC[0J), which some terminals show as a stray "["; the
 * terminal's own line editing and echo do the rest.
 */
function ask(question: string): Promise<string> {
  if (!sigintHooked) {
    sigintHooked = true;
    process.on('SIGINT', () => {
      process.stderr.write('\nStopped. Steps already finished stay done.\n');
      process.exit(130);
    });
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  return new Promise((resolveAnswer) => {
    let answered = false;
    rl.on('close', () => {
      if (!answered) fail('input closed before an answer', 1);
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolveAnswer(answer);
    });
  });
}

async function confirm(parsed: ParsedArgs, question: string): Promise<void> {
  if (flag(parsed, 'yes', 'y')) return;
  if (!process.stdin.isTTY) fail('not a terminal; pass --yes to proceed without the prompt');
  const answer = (await ask(`${question} [y/N] `)).trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes') fail('cancelled', 1);
}

// ---------- ssh ----------

function sshBin(): string {
  return process.env.QP_EDGE_SSH_BIN || 'ssh';
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function jumpProxyCommand(jump: string, hosts: Record<string, EdgeHost>, seen: Set<string>): string {
  const saved = hosts[jump];
  if (saved) {
    if (seen.has(jump)) fail(`jump host loop through ${jump}`, 1);
    seen.add(jump);
    // ssh hands ProxyCommand to /bin/sh, so every word is quoted for sh,
    // including a nested ProxyCommand when the jump host has its own jump host.
    const inner = [
      'ssh',
      ...baseOptions(saved, true),
      ...(saved.jump ? ['-o', `ProxyCommand=${jumpProxyCommand(saved.jump, hosts, seen)}`] : []),
      '-W',
      '%h:%p',
      `${saved.user}@${saved.host}`,
    ];
    return inner.map(shellQuote).join(' ');
  }
  const match = /^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/.exec(jump);
  if (!match) fail(`cannot parse jump host '${jump}' (use a saved name or user@host[:port])`, 1);
  const [, user, host, port] = match;
  return ['ssh', '-o', 'BatchMode=yes', '-p', port ?? '22', '-W', '%h:%p', `${user ? `${user}@` : ''}${host}`].map(shellQuote).join(' ');
}

function baseOptions(host: EdgeHost, batch: boolean): string[] {
  return [
    '-p', String(host.port),
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15',
    '-o', 'StrictHostKeyChecking=accept-new',
    ...(batch ? ['-o', 'BatchMode=yes'] : []),
    ...(host.key ? ['-i', expandHome(host.key), '-o', 'IdentitiesOnly=yes'] : []),
    ...(host.knownHostsFile ? ['-o', `UserKnownHostsFile=${expandHome(host.knownHostsFile)}`] : []),
  ];
}

export function buildSshArgs(name: string, hosts: Record<string, EdgeHost>, batch: boolean): string[] {
  const host = hosts[name];
  const args = baseOptions(host, batch);
  if (host.jump) args.push('-o', `ProxyCommand=${jumpProxyCommand(host.jump, hosts, new Set([name]))}`);
  args.push(`${host.user}@${host.host}`);
  return args;
}

function asRoot(host: EdgeHost, command: string): string {
  return host.user === 'root' ? command : `sudo -n ${command}`;
}

/** lib/edge-os.sh followed by remote.sh: what `bash -s` runs on the host. */
function remoteScript(): Buffer {
  const lib = join(edgeLibDir, 'edge-os.sh');
  for (const file of [lib, remoteScriptPath]) {
    if (!existsSync(file)) fail(`missing ${file}; reinstall @qpjoy/tunnel-cli`, 1);
  }
  return Buffer.concat([readFileSync(lib), Buffer.from('\n'), readFileSync(remoteScriptPath)]);
}

function remoteInner(root: string, scriptArgs: string[], extraEnv: Record<string, string> = {}): string {
  const env = [`MX_ROOT=${shellQuote(root)}`, ...Object.entries(extraEnv).map(([key, value]) => `${key}=${shellQuote(value)}`)];
  return `env ${env.join(' ')} bash -s -- ${scriptArgs.map(shellQuote).join(' ')}`;
}

/** Runs remote.sh on the host with the given arguments. Returns the exit status. */
function runRemote(
  name: string,
  hosts: Record<string, EdgeHost>,
  root: string,
  scriptArgs: string[],
  needsRoot: boolean,
  extraEnv: Record<string, string> = {},
): number {
  const host = hosts[name];
  const inner = remoteInner(root, scriptArgs, extraEnv);
  const remoteCommand = needsRoot ? asRoot(host, inner) : inner;
  const result = spawnSync(sshBin(), [...buildSshArgs(name, hosts, true), remoteCommand], {
    input: remoteScript(),
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  return reportSsh(name, result.status, result.error);
}

interface Captured {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

function runCapture(command: string, args: string[], input: Buffer, env: NodeJS.ProcessEnv = process.env): Promise<Captured> {
  return new Promise((resolveCapture) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error) => resolveCapture({ status: null, stdout, stderr, error }));
    child.on('close', (status) => resolveCapture({ status, stdout, stderr }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

/**
 * remote.sh never exits 255, so for our own scripts 255 means ssh itself
 * failed. For `edge ssh -- <command>` the user's command may return 255 too.
 */
function reportSsh(name: string, status: number | null, error?: Error, userCommand = false): number {
  if (error) {
    process.stderr.write(`edge: cannot run ${sshBin()}: ${error.message}\n`);
    return 1;
  }
  if (status === 255) {
    process.stderr.write(userCommand
      ? `edge: ${name}: ssh exited 255 (could not connect, or the command itself returned 255)\n`
      : `edge: ${name}: ssh could not connect (UNREACHABLE)\n`);
  }
  return status ?? 1;
}

async function sshInto(parsed: ParsedArgs): Promise<void> {
  const [[name]] = await selectHosts(parsed, false);
  const hosts = readHosts().hosts;
  const interactive = parsed.passthrough.length === 0;
  const args = buildSshArgs(name, hosts, !interactive);
  if (interactive) args.unshift('-t');
  // Same contract as ssh: the words are joined and the remote shell parses
  // them, so `-- 'systemctl status nginx && wg show'` works as typed.
  const result = spawnSync(sshBin(), [...args, ...parsed.passthrough], { stdio: 'inherit' });
  process.exit(reportSsh(name, result.status, result.error, !interactive));
}

async function printSshArgs(parsed: ParsedArgs): Promise<void> {
  const [[name]] = await selectHosts(parsed, false);
  process.stdout.write(`${[sshBin(), ...buildSshArgs(name, readHosts().hosts, false)].map(shellQuote).join(' ')}\n`);
}

async function checkHosts(parsed: ParsedArgs): Promise<void> {
  const selected = await selectHosts(parsed, true);
  const hosts = readHosts().hosts;
  const root = option(parsed, 'root') ?? defaultRoot;
  let failed = 0;
  for (const [name, host] of selected) {
    process.stdout.write(`\n##### ${name} (${host.user}@${host.host}:${host.port}${host.jump ? ` via ${host.jump}` : ''})\n`);
    if (runRemote(name, hosts, root, ['check'], false) !== 0) failed += 1;
  }
  if (failed > 0) process.exit(1);
}

async function releases(parsed: ParsedArgs): Promise<void> {
  const [[name]] = await selectHosts(parsed, false);
  const component = option(parsed, 'component');
  if (component) validateName('component', component);
  const status = runRemote(name, readHosts().hosts, option(parsed, 'root') ?? defaultRoot, ['releases', ...(component ? [component] : [])], false);
  process.exit(status);
}

function defaultRevision(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

async function push(parsed: ParsedArgs): Promise<void> {
  const stackName = option(parsed, 'stack');
  const bundleOption = option(parsed, 'bundle');
  if (!stackName === !bundleOption) {
    fail('usage: edge push <name>[,<name>...] (--stack <stack> | --bundle <dir>) [--state-dir <dir>] [--image <ref>]... [--component <name>] [--revision <rev>]');
  }
  const stack = stackName ? findStack(stackName) : undefined;
  const bundle = bundleOption ? resolve(expandHome(bundleOption)) : undefined;
  if (bundle && (!existsSync(bundle) || !statSync(bundle).isDirectory())) fail(`bundle must be a directory: ${bundle}`);
  const sourceDir = stack ? stack.dir : (bundle as string);
  const component = option(parsed, 'component') ?? (stack ? stack.name : basename(sourceDir));
  const revision = option(parsed, 'revision') ?? defaultRevision();
  const root = option(parsed, 'root') ?? defaultRoot;
  validateName('component', component);
  validateName('revision', revision);
  if (!root.startsWith('/')) fail('--root must be an absolute path');

  const stateDirOption = option(parsed, 'state-dir');
  const explicitState = stateDirOption ? resolve(expandHome(stateDirOption)) : undefined;
  if (explicitState && (!existsSync(explicitState) || !statSync(explicitState).isDirectory())) fail(`--state-dir must be a directory: ${explicitState}`);
  if (explicitState && listFiles(explicitState).length === 0) fail(`--state-dir ${explicitState} has no files`);
  const images = optionList(parsed, 'image');
  for (const image of images) {
    const inspect = spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' });
    if (inspect.error || inspect.status !== 0) fail(`--image ${image} is not in the local docker; pull it first (docker pull ${image})`, 1);
  }
  const stackImages = (stack?.manifest.STACK_IMAGES ?? '').split(/\s+/).filter(Boolean);
  for (const image of images) {
    if (stack && stackImages.length > 0 && !stackImages.includes(image)) {
      process.stderr.write(`edge: warning: --image ${image} is not one the stack runs (${stackImages.join(' ')}); compose will still pull those\n`);
    }
  }
  const vendor = stack ? (stack.manifest.STACK_VENDOR ?? '').split(/\s+/).filter(Boolean) : [];
  const missingVendor = vendor.filter((file) => !vendorSource(file));
  if (missingVendor.length > 0) fail(`stack ${stack?.name} needs files this install does not have: ${missingVendor.join(', ')}`, 1);

  const selected = await selectHosts(parsed, true);
  const hosts = readHosts().hosts;
  const hooks = ['deploy.sh', 'health.sh'].filter((hook) => existsSync(join(sourceDir, hook)));
  const incoming = `${root}/incoming/${component}-${revision}.tar.gz`;
  const incomingState = `${root}/incoming/${component}-${revision}.state.tar.gz`;
  const required = stack ? (stack.manifest.STACK_STATE_REQUIRED ?? '').split(/\s+/).filter(Boolean) : [];

  // Each host gets --state-dir, or this origin's state directory for it when there is one.
  const plans = selected.map(([name, host]) => {
    const own = defaultStateDir(name, component);
    const dir = explicitState ?? (existsSync(own) && listFiles(own).length > 0 ? own : undefined);
    const files = dir ? listFiles(dir) : [];
    const refused = files.filter((file) => file.split('/').some((part) => part.startsWith('.edge-')));
    if (refused.length > 0) fail(`${dir} must not contain .edge-* paths (the host keeps its own): ${refused.join(', ')}`);
    const missing = required.filter((entry) => !files.some((file) => file === entry || file.startsWith(`${entry}/`)));
    return { name, host, dir, files, missing };
  });
  const origin = readOrigin();

  process.stdout.write(`Push plan
  source     ${stack ? `stack ${stack.name} (${stack.dir})` : `bundle ${bundle}`}
  component  ${component}
  revision   ${revision}
  origin     ${origin.name ?? `not usable: ${origin.error} (qp-tunnel-cli edge origin set <name>)`}
  hosts      ${selected.map(([name, host]) => `${name} (${host.user}@${host.host})`).join(', ')}
  on host    ${root}/releases/${component}/${revision}  ->  ${root}/current/${component}
  hooks      ${hooks.length > 0 ? hooks.join(', then ') : 'none shipped (files are only unpacked and linked)'}
`);
  if (stack) {
    process.stdout.write(`  os         ${stack.manifest.STACK_OS || 'any'}${stack.manifest.STACK_SYSTEMD === '1' ? ', systemd' : ''}${flag(parsed, 'force-os') ? ' (--force-os: not enforced)' : ' (checked on the host before the switch)'}
  installs   ${stack.manifest.STACK_INSTALLS || 'nothing'}
  ports      ${stack.manifest.STACK_PORTS || '-'} (open them in the cloud security group; nothing here opens ports)
`);
  }
  const describeState = (plan: (typeof plans)[number]) => (plan.dir
    ? `${plan.files.length} file(s) from ${plan.dir} -> ${root}/state/${component}/: ${plan.files.join(', ')}`
    : `none pushed (no --state-dir, nothing in ${defaultStateDir(plan.name, component)})`);
  const sameState = plans.every((plan) => plan.dir === plans[0].dir);
  for (const plan of sameState ? plans.slice(0, 1) : plans) {
    process.stdout.write(`  state      ${sameState ? '' : `[${plan.name}] `}${describeState(plan)}\n`);
    if (plan.missing.length > 0) {
      process.stdout.write(`             needs ${plan.missing.join(', ')} in state/${component} on the host already, or the push stops before the switch
`);
      if (stack?.manifest.STACK_STATE_HINT) process.stdout.write(`             ${stack.manifest.STACK_STATE_HINT.replace('<host>', plan.name)}\n`);
    }
  }
  for (const dir of new Set(plans.map((plan) => plan.dir).filter((dir): dir is string => Boolean(dir)))) warnIfTracked(dir);
  process.stdout.write(`  images     ${images.length > 0 ? images.join(', ') : `none shipped${stackImages.length > 0 ? ` (the host pulls ${stackImages.join(' ')} itself)` : ''}`}
`);
  if (flag(parsed, 'take-over')) process.stdout.write(`  take-over  yes: replaces current/${component} even if another origin or the v1 Launcher manages it
`);
  if (flag(parsed, 'shared-host')) process.stdout.write(`  shared     yes: pushes even where another tool (the v1 Launcher) deployed components on the host
`);

  if (flag(parsed, 'dry-run')) {
    for (const plan of plans) {
      process.stdout.write(`\n[${plan.name}] upload:   ${shellQuote(sshBin())} ${buildSshArgs(plan.name, hosts, true).map(shellQuote).join(' ')} ${shellQuote(asRoot(plan.host, uploadCommand(root, incoming)))} < bundle.tar.gz\n`);
      if (plan.dir) process.stdout.write(`[${plan.name}] upload:   ... ${shellQuote(asRoot(plan.host, uploadCommand(root, incomingState)))} < state.tar.gz\n`);
      process.stdout.write(`[${plan.name}] activate: remote.sh activate ${component} ${revision} ${incoming}${plan.dir ? ` ${incomingState}` : ''}  (MX_ROOT=${root}, EDGE_ORIGIN=${origin.name ?? '?'})\n`);
    }
    process.stdout.write('\nDry run: nothing was uploaded.\n');
    return;
  }
  const originName = requireOrigin();
  ensureHome();
  await ensureLocalTools(pushTools(), parsed);
  const question = `Push ${component} ${revision} to ${selected.map(([name]) => name).join(', ')}?`;
  if (parsed.options.has('from-setup')) {
    if (!(await askYesNo(question, true))) fail(`stopped before the push. Later: qp-tunnel-cli edge push ${selected.map(([name]) => name).join(',')}${stack ? ` --stack ${stack.name}` : ''}`, 1);
  } else {
    await confirm(parsed, question);
  }
  const extraEnv: Record<string, string> = {
    EDGE_ORIGIN: originName,
    ...(flag(parsed, 'take-over') ? { EDGE_TAKE_OVER: '1' } : {}),
    ...(flag(parsed, 'shared-host') ? { EDGE_SHARED_HOST: '1' } : {}),
    ...(flag(parsed, 'force-os') ? { EDGE_FORCE_OS: '1' } : {}),
  };

  const workDir = mkdtempSync(join(tmpdir(), 'qp-edge-'));
  try {
    const staged = join(workDir, 'bundle');
    stageBundle(staged, sourceDir, vendor, images);
    const tarball = join(workDir, 'bundle.tar.gz');
    packDir(staged, tarball);
    const stateTarballs = new Map<string, string>();
    for (const dir of new Set(plans.map((plan) => plan.dir).filter((dir): dir is string => Boolean(dir)))) {
      const file = join(workDir, `state-${stateTarballs.size}.tar.gz`);
      packDir(dir, file);
      stateTarballs.set(dir, file);
    }
    process.stdout.write(`Packed ${Math.ceil(statSync(tarball).size / 1024)} KiB${[...stateTarballs.values()].map((file) => ` + state ${Math.ceil(statSync(file).size / 1024)} KiB`).join('')}\n`);

    for (const plan of plans) {
      const { name, host } = plan;
      const stateTarball = plan.dir ? stateTarballs.get(plan.dir) : undefined;
      const entry: LedgerEntry = {
        at: new Date().toISOString(), origin: originName, host: name, target: targetOf(host), action: 'push',
        component, revision, ...(stack ? { stack: stack.name } : {}), result: 'failed', ...(plan.dir ? { state: plan.dir } : {}),
      };
      process.stdout.write(`\n##### ${name}: upload\n`);
      let sent = upload(name, hosts, host, tarball, uploadCommand(root, incoming));
      if (sent === 0 && stateTarball) sent = upload(name, hosts, host, stateTarball, uploadCommand(root, incomingState));
      if (sent !== 0) {
        appendLedger({ ...entry, result: resultOf(sent), exit: sent });
        fail(`${name}: upload failed; hosts after it were not touched`, 1);
      }
      process.stdout.write(`##### ${name}: activate\n`);
      const activateArgs = ['activate', component, revision, incoming, ...(stateTarball ? [incomingState] : [])];
      const status = runRemote(name, hosts, root, activateArgs, true, extraEnv);
      appendLedger({ ...entry, result: resultOf(status), ...(status !== 0 ? { exit: status } : {}) });
      if (status !== 0) fail(`${name}: activation failed; hosts after it were not touched`, 1);
    }
    process.stdout.write(`\nDone: ${component} ${revision} is current on ${plans.map((plan) => plan.name).join(', ')}, managed from ${originName}.\n`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** Streams a file to the host. Returns the ssh exit status. */
function upload(name: string, hosts: Record<string, EdgeHost>, host: EdgeHost, file: string, command: string): number {
  const fd = openSync(file, 'r');
  let result;
  try {
    result = spawnSync(sshBin(), [...buildSshArgs(name, hosts, true), asRoot(host, command)], {
      stdio: [fd, 'inherit', 'inherit'],
    });
  } finally {
    closeSync(fd);
  }
  return reportSsh(name, result.status, result.error);
}

function packDir(dir: string, tarball: string): void {
  // COPYFILE_DISABLE keeps macOS tar from adding ._* AppleDouble files.
  const tar = spawnSync('tar', ['-czf', tarball, '-C', dir, '.'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  if (tar.status !== 0) fail(`could not pack ${dir} with tar`, 1);
}

/** Copies the stack or bundle, its vendored files, the edge shell library and any --image tarballs. */
function stageBundle(staged: string, sourceDir: string, vendor: string[], images: string[]): void {
  cpSync(sourceDir, staged, {
    recursive: true,
    filter: (path) => !path.split(/[\\/]/).includes('state.example'),
  });
  for (const file of vendor) {
    const target = join(staged, 'vendor', file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(vendorSource(file) as string, target);
    chmodSync(target, statSync(vendorSource(file) as string).mode & 0o777);
  }
  mkdirSync(join(staged, 'lib'), { recursive: true });
  for (const lib of ['edge-os.sh', 'edge-nginx.sh']) {
    if (!existsSync(join(staged, 'lib', lib))) copyFileSync(join(edgeLibDir, lib), join(staged, 'lib', lib));
  }
  if (images.length > 0) mkdirSync(join(staged, 'images'), { recursive: true });
  for (const image of images) {
    const out = join(staged, 'images', `${image.replace(/[^A-Za-z0-9._-]/g, '_')}.tar.gz`);
    process.stdout.write(`docker save ${image}\n`);
    const save = spawnSync('sh', ['-c', `docker save ${shellQuote(image)} | gzip -1 > ${shellQuote(out)}`], { stdio: ['ignore', 'inherit', 'inherit'] });
    if (save.status !== 0) fail(`docker save ${image} failed`, 1);
  }
}

/** Directories 0700, files 0600: state directories hold keys and certificates. */
function privateTree(dir: string): void {
  chmodSync(dir, 0o700);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) privateTree(path);
    else if (entry.isFile()) chmodSync(path, 0o600);
  }
}

function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(dir, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

function warnIfTracked(dir: string): void {
  const inside = spawnSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return;
  const ignored = spawnSync('git', ['-C', dir, 'check-ignore', '-q', '.'], { encoding: 'utf8' });
  if (ignored.status !== 0) {
    process.stderr.write(`edge: warning: ${dir} is inside a Git work tree and not ignored; its secrets could be committed\n`);
  }
}

function uploadCommand(root: string, incoming: string): string {
  const dir = shellQuote(`${root}/incoming`);
  return `sh -c ${shellQuote(`mkdir -p ${dir} && cat > ${shellQuote(incoming)}`)}`;
}

async function rollback(parsed: ParsedArgs): Promise<void> {
  const [[name]] = await selectHosts(parsed, false);
  const component = option(parsed, 'component');
  if (!component) fail('usage: edge rollback <name> --component <name> [--revision <rev>]');
  validateName('component', component);
  const revision = option(parsed, 'revision');
  if (revision) validateName('revision', revision);
  const originName = requireOrigin();
  ensureHome();
  await confirm(parsed, `Roll back ${component} on ${name} to ${revision ?? 'the previous release'}?`);
  const hosts = readHosts().hosts;
  const extraEnv: Record<string, string> = { EDGE_ORIGIN: originName, ...(flag(parsed, 'take-over') ? { EDGE_TAKE_OVER: '1' } : {}) };
  const status = runRemote(name, hosts, option(parsed, 'root') ?? defaultRoot, ['rollback', component, ...(revision ? [revision] : [])], true, extraEnv);
  appendLedger({
    at: new Date().toISOString(), origin: originName, host: name, target: targetOf(hosts[name]), action: 'rollback',
    component, ...(revision ? { revision } : {}), result: resultOf(status), ...(status !== 0 ? { exit: status } : {}),
  });
  process.exit(status);
}

// ---------- status: what runs here and on every saved host ----------

interface StatusRow {
  kind: string;
  name: string;
  version: string;
  state: string;
  detail: string;
}

interface HostStatus {
  label: string;
  target: string;
  reachable: boolean;
  error?: string;
  host?: { hostname: string; os: string; access: string; facts: string };
  rows: StatusRow[];
}

function parseStatus(stdout: string): Pick<HostStatus, 'host' | 'rows'> {
  const rows: StatusRow[] = [];
  let host: HostStatus['host'];
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('@edge\t')) continue;
    const [, kind = '-', name = '-', version = '-', state = '-', detail = '-'] = line.split('\t');
    if (kind === 'host') host = { hostname: name, os: version, access: state, facts: detail };
    else rows.push({ kind, name, version, state, detail: detail === '-' ? '' : detail });
  }
  return { host, rows };
}

async function status(parsed: ParsedArgs): Promise<void> {
  const root = option(parsed, 'root') ?? defaultRoot;
  const health = flag(parsed, 'health');
  const results = await collectStatus(parsed, root, health);

  if (flag(parsed, 'json')) {
    process.stdout.write(`${JSON.stringify({ root, hosts: results }, null, 2)}\n`);
  } else {
    printTable(['HOST', 'TARGET', 'OS', 'ACCESS'], results.map((result) => [
      result.label,
      result.target,
      result.host ? `${result.host.os} (${result.host.facts.split(' ').filter((fact) => /^(family|init|eol)=/.test(fact)).join(' ')})` : '-',
      result.reachable ? (result.host?.access ?? '-') : (result.error ?? 'UNKNOWN'),
    ]));
    process.stdout.write('\n');
    const rows = results.flatMap((result) => {
      if (!result.reachable) return [[result.label, '-', '-', '-', 'UNKNOWN', result.error ?? '']];
      if (result.rows.length === 0) return [[result.label, '-', '-', '-', '-', 'nothing the edge tool recognises']];
      return result.rows.map((row) => [result.label, row.kind, row.name, row.version, row.state, row.detail]);
    });
    printTable(['HOST', 'KIND', 'NAME', 'VERSION', 'STATE', 'DETAIL'], rows);
    if (!health) process.stdout.write('\nRelease health is not checked; add --health (runs each health.sh, needs root on the host).\n');
  }
  if (results.some((result) => !result.reachable)) process.exit(1);
}

/** Runs `remote.sh status` here and on the selected hosts (default: here plus every saved host), four at a time. */
async function collectStatus(parsed: ParsedArgs, root: string, health: boolean): Promise<HostStatus[]> {
  const data = readHosts();
  const role = option(parsed, 'role');
  const spec = parsed.positionals[0];
  let remote: Array<[string, EdgeHost]>;
  let includeLocal: boolean;
  if (flag(parsed, 'local')) {
    remote = [];
    includeLocal = true;
  } else if (spec || role) {
    remote = await selectHosts(parsed, true);
    includeLocal = false;
  } else {
    remote = Object.entries(data.hosts);
    includeLocal = true;
  }

  const script = remoteScript();
  const scriptArgs = ['status', ...(health ? ['--health'] : []), ...(flag(parsed, 'all') ? ['--all'] : [])];
  const jobs: Array<() => Promise<HostStatus>> = [];
  if (includeLocal) {
    const me = readOrigin().name;
    jobs.push(async () => {
      const result = await runCapture('bash', ['-s', '--', ...scriptArgs], script, { ...process.env, MX_ROOT: root });
      const parsedStatus = parseStatus(result.stdout);
      const reachable = result.status === 0 && Boolean(parsedStatus.host);
      return { label: 'local', target: `this machine${me ? ` (origin ${me})` : ''}`, reachable, ...parsedStatus, ...(reachable ? {} : { error: (result.error?.message ?? result.stderr.trim()) || `exit ${result.status}` }) };
    });
  }
  for (const [name, host] of remote) {
    jobs.push(async () => {
      const inner = remoteInner(root, scriptArgs);
      const command = health ? asRoot(host, inner) : inner;
      const result = await runCapture(sshBin(), [...buildSshArgs(name, data.hosts, true), command], script);
      const parsedStatus = parseStatus(result.stdout);
      const target = targetOf(host);
      if (result.status === 0 && parsedStatus.host) return { label: name, target, reachable: true, ...parsedStatus };
      const why = result.error ? result.error.message
        : result.status === 255 ? 'UNREACHABLE'
          : (result.stderr.trim().split('\n').pop() || `exit ${result.status}`);
      return { label: name, target, reachable: false, error: why, ...parsedStatus };
    });
  }
  return runPool(jobs, 4);
}

// ---------- relations: which origin manages what, where ----------

interface Relation {
  origin: string;
  host: string;
  component: string;
  stack: string;
  revision: string;
  since: string;
  state: string;
  note: string;
}

function detailField(detail: string, key: string): string | undefined {
  const match = new RegExp(`(?:^| )${key}=(\\S+)`).exec(detail);
  return match ? match[1] : undefined;
}

async function relations(parsed: ParsedArgs): Promise<void> {
  const root = option(parsed, 'root') ?? defaultRoot;
  const me = readOrigin();
  const ledger = readLedger();
  const offline = flag(parsed, 'offline');
  const results = offline ? [] : await collectStatus(parsed, root, false);
  const saved = readHosts().hosts;

  // What this origin last did successfully to each host/component, from its ledger.
  const lastOk = new Map<string, LedgerEntry>();
  for (const entry of ledger) {
    if (entry.result === 'ok' && entry.origin === me.name) lastOk.set(`${entry.host}\t${entry.component}`, entry);
  }
  const fromLedger = (entry: LedgerEntry, state: string, note: string): Relation => ({
    origin: entry.origin, host: entry.host, component: entry.component, stack: entry.stack ?? '-',
    revision: entry.action === 'rollback' ? `${entry.revision ?? 'previous'} (rollback)` : entry.revision ?? '-',
    since: entry.at, state, note,
  });

  const rows: Relation[] = [];
  const covered = new Set<string>();
  const unreachable: string[] = [];
  const empty: string[] = [];
  for (const result of results) {
    const hostLabel = result.label === 'local' ? (me.name ?? 'local') : result.label;
    if (!result.reachable) {
      unreachable.push(result.label);
      for (const [key, entry] of lastOk) {
        if (entry.host !== hostLabel) continue;
        covered.add(key);
        rows.push(fromLedger(entry, 'UNKNOWN', `unreachable (${result.error ?? 'no answer'}); last push from here per the ledger`));
      }
      continue;
    }
    const edgeRows = result.rows.filter((row) => row.kind === 'edge');
    if (edgeRows.length === 0) empty.push(result.label === 'local' ? `${hostLabel} (this machine)` : hostLabel);
    for (const row of edgeRows) {
      const key = `${hostLabel}\t${row.name}`;
      covered.add(key);
      const by = detailField(row.detail, 'pushed-by') ?? '?';
      const mine = lastOk.get(key);
      const notes: string[] = [];
      if (result.label === 'local') notes.push('this machine');
      if (by === 'other') notes.push('not pushed by the edge tool (the v1 Launcher uses the same layout)');
      if (by === 'edge') notes.push('pushed before origins were recorded');
      if (mine && by !== me.name) notes.push(`this origin pushed ${mine.revision ?? '?'} at ${mine.at}; ${by} took it over since`);
      if (mine && by === me.name && mine.action === 'push' && mine.revision && mine.revision !== row.version) {
        notes.push(`the ledger's last push from here was ${mine.revision}`);
      }
      rows.push({
        origin: by,
        host: hostLabel,
        component: row.name,
        stack: detailField(row.detail, 'stack') ?? '-',
        revision: row.version,
        since: detailField(row.detail, 'since') ?? '-',
        state: row.state,
        note: notes.join('; '),
      });
    }
  }
  // Ledger entries for hosts that were not asked (offline, or no longer saved) or whose component is gone.
  const asked = new Set(results.map((result) => (result.label === 'local' ? (me.name ?? 'local') : result.label)));
  const narrowed = Boolean(parsed.positionals[0] || option(parsed, 'role') || flag(parsed, 'local'));
  for (const [key, entry] of lastOk) {
    if (covered.has(key)) continue;
    if (offline) rows.push(fromLedger(entry, '-', 'from the ledger (--offline: hosts not asked)'));
    else if (asked.has(entry.host)) rows.push(fromLedger(entry, 'GONE', 'the ledger has it, the host does not show it any more'));
    else if (!saved[entry.host] && !narrowed) rows.push(fromLedger(entry, '-', 'host is no longer saved here; from the ledger'));
  }

  const rank = (origin: string) => (origin === me.name ? 0 : origin === 'other' ? 2 : 1);
  rows.sort((a, b) => rank(a.origin) - rank(b.origin) || a.origin.localeCompare(b.origin) || a.host.localeCompare(b.host) || a.component.localeCompare(b.component));

  if (flag(parsed, 'json')) {
    process.stdout.write(`${JSON.stringify({ origin: me.name ?? null, ledger: ledgerPath(), relations: rows, unreachable, nothingPushed: empty }, null, 2)}\n`);
  } else {
    process.stdout.write(`This origin: ${me.name ?? `not usable (${me.error})`}${me.name ? ` (from ${me.source})` : ''}. Ledger: ${ledgerPath()}${existsSync(ledgerPath()) ? '' : ' (none yet)'}\n\n`);
    if (rows.length === 0) {
      process.stdout.write('No pushed components found.\n');
    } else {
      printTable(['ORIGIN', 'HOST', 'COMPONENT', 'STACK', 'REVISION', 'SINCE', 'STATE', 'NOTE'],
        rows.map((row) => [row.origin === me.name ? `${row.origin} *` : row.origin, row.host, row.component, row.stack, row.revision, row.since, row.state, row.note]));
      const counts = new Map<string, Set<string>>();
      for (const row of rows) counts.set(row.origin, (counts.get(row.origin) ?? new Set<string>()).add(row.host));
      process.stdout.write(`\n${[...counts].map(([origin, set]) => `${origin}${origin === me.name ? ' (this origin)' : ''}: ${set.size} host(s)`).join(', ')}\n`);
    }
    if (empty.length > 0) process.stdout.write(`Nothing pushed on: ${empty.join(', ')}\n`);
    if (!offline) process.stdout.write('Only hosts saved on this machine are asked; import the Launcher profiles on every origin to see the same picture.\n');
  }
  if (!offline && unreachable.length > 0) process.exit(1);
}

// ---------- state directories kept by this origin ----------

function listStateDirs(): Array<{ host: string; component: string; dir: string; files: number }> {
  const root = stateRoot();
  if (!existsSync(root)) return [];
  const out: Array<{ host: string; component: string; dir: string; files: number }> = [];
  for (const host of readdirSync(root, { withFileTypes: true })) {
    if (!host.isDirectory()) continue;
    for (const component of readdirSync(join(root, host.name), { withFileTypes: true })) {
      if (!component.isDirectory()) continue;
      const dir = join(root, host.name, component.name);
      out.push({ host: host.name, component: component.name, dir, files: listFiles(dir).length });
    }
  }
  return out.sort((a, b) => a.host.localeCompare(b.host) || a.component.localeCompare(b.component));
}

async function stateCommand(parsed: ParsedArgs): Promise<void> {
  const sub = parsed.positionals[0] ?? 'list';
  const rest: ParsedArgs = { ...parsed, positionals: parsed.positionals.slice(1) };
  if (sub === 'list') {
    const dirs = listStateDirs().filter((entry) => !rest.positionals[0] || entry.host === rest.positionals[0]);
    if (flag(parsed, 'json')) {
      process.stdout.write(`${JSON.stringify({ root: stateRoot(), dirs }, null, 2)}\n`);
      return;
    }
    if (dirs.length === 0) {
      process.stdout.write(`No state directories under ${stateRoot()}.\nStart one: qp-tunnel-cli edge state init <host> --stack <stack>\n`);
      return;
    }
    printTable(['HOST', 'COMPONENT', 'FILES', 'DIRECTORY'], dirs.map((entry) => [entry.host, entry.component, String(entry.files), entry.dir]));
    process.stdout.write(`\nedge push <host> --stack <stack> uses ${stateRoot()}/<host>/<component> when --state-dir is not given.\n`);
    return;
  }
  if (sub === 'init') {
    const stackName = option(parsed, 'stack');
    if (!stackName || !rest.positionals[0]) fail('usage: edge state init <name> --stack <stack> [--component <name>]');
    const [[name]] = await selectHosts(rest, false);
    const stack = findStack(stackName);
    const component = option(parsed, 'component') ?? stack.name;
    validateName('component', component);
    ensureHome();
    mkdirSync(stateRoot(), { recursive: true, mode: 0o700 });
    initStackState(stack, defaultStateDir(name, component), name);
    return;
  }
  if (sub === 'pull') {
    const component = option(parsed, 'component');
    if (!component || !rest.positionals[0]) fail('usage: edge state pull <name> --component <name>');
    validateName('component', component);
    const [[name, host]] = await selectHosts(rest, false);
    ensureHome();
    pullState(name, host, component, option(parsed, 'root') ?? defaultRoot);
    return;
  }
  fail(`unknown edge state command: ${sub} (list, init, pull)`);
}

/** Copies the state files pushes put on the host back into this origin's state directory. Never overwrites. */
function pullState(name: string, host: EdgeHost, component: string, root: string): void {
  const hosts = readHosts().hosts;
  const result = spawnSync(sshBin(), [...buildSshArgs(name, hosts, true), asRoot(host, remoteInner(root, ['state-export', component]))], {
    input: remoteScript(),
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.stderr?.length) process.stderr.write(result.stderr);
  const status = reportSsh(name, result.status, result.error);
  if (status !== 0) process.exit(status === 255 ? 1 : status);
  const workDir = mkdtempSync(join(tmpdir(), 'qp-edge-pull-'));
  try {
    const tarball = join(workDir, 'state.tar.gz');
    writeFileSync(tarball, result.stdout);
    const listing = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
    if (listing.status !== 0) fail(`${name}: what came back is not a tar.gz archive`, 1);
    const members = listing.stdout.split('\n').filter(Boolean);
    const bad = members.filter((member) => member.startsWith('/') || member.split('/').includes('..'));
    if (bad.length > 0) fail(`${name}: refusing archive paths ${bad.join(', ')}`, 1);

    const own = defaultStateDir(name, component);
    const target = existsSync(own) && listFiles(own).length > 0
      ? `${own}.pulled-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`
      : own;
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const extract = spawnSync('tar', ['-xzf', tarball, '-C', target], { stdio: ['ignore', 'inherit', 'inherit'] });
    if (extract.status !== 0) fail(`${name}: could not unpack into ${target}`, 1);
    privateTree(target);
    process.stdout.write(`${listFiles(target).length} file(s) from ${name} state/${component} -> ${target}\n`);
    if (target !== own) {
      process.stdout.write(`${own} already had files, so nothing there was changed. Compare, then move what you want:
  diff -r ${shellQuote(own)} ${shellQuote(target)}
`);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function runPool<T>(jobs: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      const index = next;
      next += 1;
      results[index] = await jobs[index]();
    }
  });
  await Promise.all(workers);
  return results;
}

function printTable(header: string[], rows: string[][]): void {
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => (row[column] ?? '').length)));
  for (const row of [header, ...rows]) {
    process.stdout.write(`${row.map((cell, column) => (cell ?? '').padEnd(widths[column])).join('  ').trimEnd()}\n`);
  }
}

// ---------- links: WireGuard back-haul between this machine and an edge host ----------
//
// The shape of the Launcher's Domestic relay and service peer (mx-domestic
// 10.88.0.1/16 on Domestic, mx-internal-svc 10.88.88.88/32 on Internal;
// server/scripts/site-slot-artifact-materializer.mjs): the edge host has the
// public address and listens; this machine dials out with a keepalive, so it
// needs no public ingress. Both sides use Table = off and explicit routes for
// the link subnet only (plus a /32 for the relay, so a mihomo/Clash TUN cannot
// shadow it), no DNS line. Both key pairs are made here. The relay side goes
// into the stack state (state/<host>/<component>/wg/, pushed by edge push
// --stack wg-nginx); this side stays in <edge home>/links/<host>/.

const linkMarker = '# qp-tunnel-cli edge link';
const wgInterfacePattern = /^[A-Za-z0-9_=+.-]{1,15}$/;
const defaultRelayInterface = 'qpjoy-relay';
const defaultLinkPort = 51820;
// The v1 plan keeps qp-tunnel-cli tunnels in 100.127.0.0/16 (OpenVPN 100.127.0.0/24
// and up, WireGuard VPN 100.127.50/100/101.0/24). All edge links share one block with a
// fixed address per machine, numbered like the Launcher's 10.88.0.1 / 10.88.88.88 / .89:
// edge host <name>N -> .N (domestic02 -> .2), Internal <name>N -> .(87+N) (s2/internal02 .89; in the
// launcher plan s1/internal01 takes .87, because .88 is the Launcher's Internal role address). Traffic goes edge host -> Internal only; each Internal routes just the
// edge hosts' /32s, so edge hosts never reach each other and Internals talk over their LAN.
const edgeFabric = '100.127.200.0/24';
const edgeHostMax = 86;

function ipToInt(value: string): number | undefined {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return undefined;
  return parts.reduce((sum, part) => sum * 256 + Number(part), 0);
}

function intToIp(value: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.');
}

interface Cidr {
  base: number;
  prefix: number;
  last: number;
}

function parseCidr(value: string): Cidr | undefined {
  const [address, prefixText = '32', extra] = value.split('/');
  if (extra !== undefined || !/^\d{1,2}$/.test(prefixText) || Number(prefixText) > 32) return undefined;
  const ip = ipToInt(address);
  if (ip === undefined) return undefined;
  const size = 2 ** (32 - Number(prefixText));
  const base = ip - (ip % size);
  return { base, prefix: Number(prefixText), last: base + size - 1 };
}

function cidrText(cidr: Cidr): string {
  return `${intToIp(cidr.base)}/${cidr.prefix}`;
}

function cidrsOverlap(a: Cidr, b: Cidr): boolean {
  return a.base <= b.last && b.base <= a.last;
}

/**
 * Two address plans for edge links, both numbered the same way.
 * launcher (default): the Launcher's own numbering in 10.88.0.0/16: Internal 10.88.88.(87+M)
 *   (s2 .89), edge hosts 10.88.0.N. 10.88.0.1 and 10.88.88.88 are the Launcher's role addresses
 *   (the current Domestic relay and the current Internal service peer; they move with the role,
 *   de-ladder2 docs/48), so no edge link takes them and s1/internal01 gets .87. 10.88.100.0/24 is
 *   the Launcher's product service VIPs. Only /32s are routed, so the Launcher's own 10.88.0.0/16
 *   routes on a machine are left alone.
 * isolated: 100.127.200.0/24, where nothing the Launcher uses lives; for other clusters.
 */
interface AddressPlan {
  name: 'launcher' | 'isolated';
  subnet: string;
  edgeBase: number;
  internalBase: number;
  edgeFirst: number;
  reserved: Array<[Cidr, string]>;
  summary: string;
}

const addressPlans: Record<AddressPlan['name'], AddressPlan> = {
  launcher: {
    name: 'launcher',
    subnet: '10.88.0.0/16',
    edgeBase: ipToInt('10.88.0.0') as number,
    internalBase: ipToInt('10.88.88.0') as number,
    edgeFirst: 2,
    reserved: [
      [parseCidr('10.88.0.1/32') as Cidr, "the Launcher's relay on the current Domestic (mx-domestic)"],
      [parseCidr('10.88.88.88/32') as Cidr, "the Launcher's Internal service peer (mx-internal-svc), a role address that moves with the active Internal"],
      [parseCidr('10.88.100.0/24') as Cidr, "the Launcher's product service VIPs"],
    ],
    summary: "the Launcher's numbering: Internal 10.88.88.(87+N) (s2 .89, s1 .87), edge hosts 10.88.0.N; 10.88.0.1 and 10.88.88.88 stay the Launcher's Domestic and Internal",
  },
  isolated: {
    name: 'isolated',
    subnet: edgeFabric,
    edgeBase: ipToInt('100.127.200.0') as number,
    internalBase: ipToInt('100.127.200.0') as number,
    edgeFirst: 1,
    reserved: [],
    summary: '100.127.200.0/24: Internal .88 / .89, edge hosts .N; overlaps nothing the Launcher uses, for other clusters',
  },
};

function planOf(subnet: string | undefined): AddressPlan | undefined {
  return Object.values(addressPlans).find((plan) => plan.subnet === subnet);
}

/** Plan-specific addresses an edge link must not take. */
function planAddressProblem(text: string, subnet: string): string | undefined {
  const ip = ipToInt(text);
  const plan = planOf(subnet);
  if (ip === undefined || !plan) return undefined;
  const hit = plan.reserved.find(([block]) => ip >= block.base && ip <= block.last);
  return hit ? `${text} is ${hit[1]}` : undefined;
}


/**
 * Blocks a link must stay out of, from the v1 network plan
 * (mx-launcher/docs/11-k8s-deployment-runbook.md and the Launcher sources).
 */
const reservedBlocks: Array<[Cidr, string]> = [
  [parseCidr('10.0.0.0/8') as Cidr, 'Launcher applications (relay 10.88, products 10.(90+n), other apps)'],
  [parseCidr('100.88.0.0/14') as Cidr, 'HDO V1 overlays (100.88-100.91)'],
  [parseCidr('100.127.0.0/24') as Cidr, 'the OpenVPN mesh (qp-tunnel-cli open, instance mx)'],
  [parseCidr('192.168.224.0/19') as Cidr, 'Kubernetes pods 192.168.224.0/20 and services 192.168.240.0/20'],
];

interface RouteCheck {
  checked: boolean;
  clashes: string[];
}

/** Routes on this machine (any table) that overlap the subnet, except those on our own interface. Linux only. */
function localRouteClashes(subnet: Cidr, ownInterfaces: string | string[] = []): RouteCheck {
  const own = new Set(Array.isArray(ownInterfaces) ? ownInterfaces : [ownInterfaces]);
  const ipBin = process.env.QP_EDGE_IP_BIN || 'ip';
  if (process.platform !== 'linux' && !process.env.QP_EDGE_IP_BIN) return { checked: false, clashes: [] };
  const result = spawnSync(ipBin, ['-4', 'route', 'show', 'table', 'all'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return { checked: false, clashes: [] };
  const clashes: string[] = [];
  for (const raw of result.stdout.split('\n')) {
    const words = raw.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0 || ['default', 'local', 'broadcast', 'multicast', 'anycast', 'nat'].includes(words[0])) continue;
    if (['unicast', 'blackhole', 'unreachable', 'prohibit', 'throw'].includes(words[0])) words.shift();
    const dest = words[0] && words[0] !== 'default' ? parseCidr(words[0]) : undefined;
    if (!dest) continue;
    const dev = words.includes('dev') ? words[words.indexOf('dev') + 1] : undefined;
    if (dev && own.has(dev)) continue;
    if (cidrsOverlap(subnet, dest)) clashes.push(raw.trim());
  }
  return { checked: true, clashes };
}

function wgKeyPair(): { privateKey: string; publicKey: string } {
  // A WireGuard key is a raw X25519 key in base64; the JWK export gives the raw bytes.
  const { privateKey } = generateKeyPairSync('x25519');
  const jwk = privateKey.export({ format: 'jwk' }) as { d?: string; x?: string };
  if (!jwk.d || !jwk.x) fail('could not make a WireGuard key pair (node:crypto x25519)', 1);
  const toBase64 = (value: string) => Buffer.from(value, 'base64url').toString('base64');
  return { privateKey: toBase64(jwk.d), publicKey: toBase64(jwk.x) };
}

interface LinkInfo {
  host: string;
  component: string;
  origin: string;
  subnet: string;
  relayIp: string;
  localIp: string;
  port: number;
  endpoint: string;
  relayInterface: string;
  localInterface: string;
  relayPublicKey: string;
  localPublicKey: string;
  created: string;
  dir: string;
  localConfig: string;
  relayDir: string;
}

function linksRoot(): string {
  return join(edgeHome(), 'links');
}

function readLink(host: string): LinkInfo | undefined {
  const dir = join(linksRoot(), host);
  const file = join(dir, 'link.env');
  if (!existsSync(file)) return undefined;
  const m = readManifest(file);
  const localInterface = m.LINK_LOCAL_INTERFACE ?? '';
  const component = m.LINK_COMPONENT ?? 'wg-nginx';
  return {
    host,
    component,
    origin: m.LINK_ORIGIN ?? '?',
    subnet: m.LINK_SUBNET ?? '',
    relayIp: m.LINK_RELAY_IP ?? '',
    localIp: m.LINK_LOCAL_IP ?? '',
    port: Number(m.LINK_PORT ?? defaultLinkPort),
    endpoint: m.LINK_ENDPOINT ?? '',
    relayInterface: m.LINK_RELAY_INTERFACE ?? defaultRelayInterface,
    localInterface,
    relayPublicKey: m.LINK_RELAY_PUBLIC_KEY ?? '',
    localPublicKey: m.LINK_LOCAL_PUBLIC_KEY ?? '',
    created: m.LINK_CREATED ?? '',
    dir,
    localConfig: join(dir, `${localInterface}.conf`),
    relayDir: join(defaultStateDir(host, component), 'wg'),
  };
}

function allLinks(): LinkInfo[] {
  const root = linksRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readLink(entry.name))
    .filter((link): link is LinkInfo => Boolean(link));
}

function requireLink(host: string): LinkInfo {
  const link = readLink(host);
  if (!link) fail(`no link to ${host} on this origin (${join(linksRoot(), host)}). Start one: qp-tunnel-cli edge link init ${host}`, 1);
  if (!existsSync(link.localConfig)) fail(`${link.localConfig} is missing; the link record in ${link.dir} is incomplete`, 1);
  return link;
}

/** qpjoy-<host> when it fits the 15-character limit; otherwise qpjoy- plus the first letter and the trailing number (domestic02 -> qpjoy-d02). */
function defaultLocalInterface(host: string): string {
  const plain = `qpjoy-${host}`;
  if (wgInterfacePattern.test(plain)) return plain;
  const letters = host.replace(/[^A-Za-z0-9]/g, '');
  const digits = /(\d+)$/.exec(letters)?.[1] ?? '';
  const short = digits && digits.length < letters.length ? `${letters[0]}${digits}` : letters;
  return `qpjoy-${short.slice(0, 9)}`;
}

function trailingNumber(name: string | undefined): number | undefined {
  const match = name ? /(\d+)$/.exec(name) : null;
  return match ? Number(match[1]) : undefined;
}

function interfaceProblem(value: string): string | undefined {
  return wgInterfacePattern.test(value) ? undefined : `${value}: WireGuard interface names are at most 15 characters of letters, digits and _=+.-`;
}

function portProblem(value: string): string | undefined {
  return /^\d{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65535 ? undefined : `${value} is not a port (1-65535)`;
}

function endpointProblem(value: string): string | undefined {
  return /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):\d{1,5}$/.test(value) ? undefined : `${value} must be host:port`;
}

/** Checks a link subnet against the reserved blocks, this origin's other links and this machine's routes. */
function linkSubnetProblem(text: string, forHost?: string): string | undefined {
  const cidr = parseCidr(text);
  if (!cidr) return `${text} is not an IPv4 CIDR like ${edgeFabric}`;
  if (cidr.prefix < 16 || cidr.prefix > 30) return `${text}: use a block between /16 and /30 (${edgeFabric} holds every edge link)`;
  if (cidrText(cidr) !== text) return `${text} has host bits set; the block is ${cidrText(cidr)}`;
  const launcherPlan = text === addressPlans.launcher.subnet;
  for (const [block, label] of reservedBlocks) {
    if (!launcherPlan && cidrsOverlap(cidr, block)) {
      return `${text} overlaps ${cidrText(block)}, ${label}. Use --plan launcher (${addressPlans.launcher.subnet}, the Launcher's numbering) or --plan isolated (${edgeFabric})`;
    }
  }
  // Links share one block; a different block that overlaps another link's is a mistake.
  for (const link of allLinks()) {
    const other = parseCidr(link.subnet);
    if (link.host !== forHost && other && cidrsOverlap(cidr, other) && link.subnet !== text) return `${text} overlaps ${link.subnet}, the link to ${link.host}; links share one block`;
  }
  // The Launcher's own routes for 10.88.0.0/16 (mx-internal-svc, mx-domestic) are expected under the
  // launcher plan; links route /32s only, checked one by one (addressRouteProblem).
  if (launcherPlan) return undefined;
  const routes = localRouteClashes(cidr, allLinks().map((link) => link.localInterface));
  if (routes.clashes.length > 0) return `${text} overlaps routes on this machine: ${routes.clashes.join('; ')}`;
  return undefined;
}

interface AddressRoutes {
  clash?: string;
  covering: string[];
}

/** Routes for one address: an exact /32 or a local address on another interface is a clash; wider ones are only covered. */
function addressRoutes(text: string, ownInterfaces: string[]): AddressRoutes {
  const ip = ipToInt(text);
  if (ip === undefined || (process.platform !== 'linux' && !process.env.QP_EDGE_IP_BIN)) return { covering: [] };
  const result = spawnSync(process.env.QP_EDGE_IP_BIN || 'ip', ['-4', 'route', 'show', 'table', 'all'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return { covering: [] };
  const covering: string[] = [];
  for (const raw of result.stdout.split('\n')) {
    const words = raw.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0 || ['default', 'broadcast', 'multicast', 'anycast', 'nat'].includes(words[0])) continue;
    const local = words[0] === 'local';
    if (local || ['unicast', 'blackhole', 'unreachable', 'prohibit', 'throw'].includes(words[0])) words.shift();
    const dest = words[0] ? parseCidr(words[0]) : undefined;
    if (!dest || ip < dest.base || ip > dest.last) continue;
    const dev = words.includes('dev') ? words[words.indexOf('dev') + 1] : undefined;
    if (dev && ownInterfaces.includes(dev)) continue;
    if (dest.prefix === 32) return { clash: raw.trim(), covering };
    if (!local) covering.push(raw.trim());
  }
  return { covering };
}

function hostAddressProblem(text: string, subnet: Cidr): string | undefined {
  const value = ipToInt(text);
  if (value === undefined) return `${text} is not an IPv4 address`;
  if (value <= subnet.base || value >= subnet.last) return `${text} is not a host address in ${cidrText(subnet)}`;
  return undefined;
}

/** The block every edge link shares: the one this origin's links already use, else 100.127.200.0/24. */
function defaultLinkSubnet(host: string): string | undefined {
  const used = allLinks().find((link) => link.host !== host && parseCidr(link.subnet))?.subnet;
  return [used, edgeFabric].find((candidate): candidate is string => Boolean(candidate) && !linkSubnetProblem(candidate as string, host));
}

/** Relay addresses other links in this block already took. */
function takenRelayAddresses(subnet: Cidr, host: string): Map<number, string> {
  const taken = new Map<number, string>();
  for (const link of allLinks()) {
    if (link.host === host || link.subnet !== cidrText(subnet)) continue;
    const ip = ipToInt(link.relayIp);
    if (ip !== undefined) taken.set(ip, link.host);
  }
  return taken;
}

/** Edge host N -> .N in the plan (domestic02 -> 10.88.0.2 or 100.127.200.2), skipping reserved and taken ones. */
function defaultRelayAddress(subnet: Cidr, host: string): string {
  const plan = planOf(cidrText(subnet));
  const base = plan?.edgeBase ?? subnet.base;
  const first = plan?.edgeFirst ?? 1;
  const taken = takenRelayAddresses(subnet, host);
  const free = (octet: number) => !taken.has(base + octet) && !planAddressProblem(intToIp(base + octet), cidrText(subnet));
  const n = trailingNumber(host);
  if (n !== undefined && n >= first && n <= edgeHostMax && free(n)) return intToIp(base + n);
  for (let octet = first; octet <= edgeHostMax; octet += 1) if (free(octet)) return intToIp(base + octet);
  return intToIp(base + first);
}

/**
 * The address this machine already has in the block, else .(87+n) for an origin ending in n
 * (s2/internal02 .89). A reserved result (launcher plan: .88, the Launcher's Internal) becomes
 * .(88-n), so s1/internal01 takes .87 and never collides with internal02, 03, ...
 */
function defaultLocalAddress(subnet: Cidr, origin: string | undefined, relayIp: number): string {
  const mine = allLinks().find((link) => link.subnet === cidrText(subnet) && ipToInt(link.localIp) !== relayIp)?.localIp;
  if (mine) return mine;
  const n = trailingNumber(origin);
  const base = planOf(cidrText(subnet))?.internalBase ?? subnet.base;
  let octet = n !== undefined && n >= 1 && n <= 100 ? 87 + n : 88;
  if (planAddressProblem(intToIp(base + octet), cidrText(subnet))) octet = 88 - (n !== undefined && n >= 1 && n <= 87 ? n : 1);
  const candidate = base + octet;
  return intToIp(candidate < subnet.last && candidate !== relayIp ? candidate : subnet.base + 2);
}

interface LinkInput {
  plan?: string;
  subnet?: string;
  ip?: string;
  relayIp?: string;
  port?: string;
  endpoint?: string;
  localInterface?: string;
  relayInterface?: string;
  component?: string;
}

interface LinkPlan {
  host: string;
  component: string;
  subnet: Cidr;
  relayIp: number;
  localIp: number;
  port: number;
  endpoint: string;
  relayInterface: string;
  localInterface: string;
}

const linkInitUsage = 'edge link init <name> [--replace] [--plan launcher|isolated | --subnet <cidr>] [--ip <this machine\'s address>] [--relay-ip <addr>] [--port 51820] [--endpoint host:port] [--interface <name>] [--relay-interface qpjoy-relay] [--component wg-nginx]';

/** Everything init checks, before any file is written. A string is the reason it cannot go ahead. */
function resolveLinkPlan(name: string, host: EdgeHost, input: LinkInput): LinkPlan | string {
  if (input.plan && !(input.plan in addressPlans)) return `--plan ${input.plan}: use launcher (${addressPlans.launcher.subnet}) or isolated (${edgeFabric})`;
  const chosen = input.plan ? addressPlans[input.plan as AddressPlan['name']] : undefined;
  if (chosen && input.subnet && input.subnet !== chosen.subnet) return `--plan ${chosen.name} is ${chosen.subnet}; leave out --subnet or pass --plan to match it`;
  const subnetText = input.subnet ?? chosen?.subnet;
  if (!subnetText) return `usage: ${linkInitUsage}\nIn a terminal, init asks for what is missing and suggests defaults.`;
  const subnetIssue = linkSubnetProblem(subnetText, name);
  if (subnetIssue) return `--subnet ${subnetIssue}`;
  const subnet = parseCidr(subnetText) as Cidr;
  const ipText = input.ip ?? defaultLocalAddress(subnet, readOrigin().name, ipToInt(defaultRelayAddress(subnet, name)) as number);
  const ipIssue = hostAddressProblem(ipText, subnet) ?? planAddressProblem(ipText, subnetText);
  if (ipIssue) return `--ip ${ipIssue}`;
  const localIp = ipToInt(ipText) as number;
  let relayIp = subnet.base + 1;
  if (input.relayIp) {
    const relayIssue = hostAddressProblem(input.relayIp, subnet) ?? planAddressProblem(input.relayIp, subnetText);
    if (relayIssue) return `--relay-ip ${relayIssue}`;
    relayIp = ipToInt(input.relayIp) as number;
  }
  if (!input.relayIp) relayIp = ipToInt(defaultRelayAddress(subnet, name)) as number;
  if (relayIp === localIp) return `--ip and the relay address are both ${intToIp(localIp)}; pass --relay-ip`;
  const taken = takenRelayAddresses(subnet, name);
  if (taken.has(relayIp)) return `--relay-ip ${intToIp(relayIp)} is already ${taken.get(relayIp)}'s address in ${cidrText(subnet)}`;
  if (taken.has(localIp)) return `--ip ${intToIp(localIp)} is ${taken.get(localIp)}'s address in ${cidrText(subnet)}`;
  const relayRoutes = addressRoutes(intToIp(relayIp), allLinks().filter((link) => link.host === name).map((link) => link.localInterface));
  if (relayRoutes.clash) return `${intToIp(relayIp)} is already routed or assigned on this machine (${relayRoutes.clash}); pass another --relay-ip`;
  const portText = input.port ?? String(defaultLinkPort);
  const portIssue = portProblem(portText);
  if (portIssue) return `--port ${portIssue}`;
  const port = Number(portText);
  if (!input.endpoint && host.jump) return `${name} is reached through ${host.jump}, so ${host.host} may not be its public address. Pass --endpoint <public address>:${port}`;
  const endpoint = input.endpoint ?? `${host.host.includes(':') ? `[${host.host}]` : host.host}:${port}`;
  const endpointIssue = endpointProblem(endpoint);
  if (endpointIssue) return `--endpoint ${endpointIssue}`;
  const localInterface = input.localInterface ?? defaultLocalInterface(name);
  const relayInterface = input.relayInterface ?? defaultRelayInterface;
  const localIssue = interfaceProblem(localInterface);
  if (localIssue) return `--interface ${localIssue}`;
  const relayIssue = interfaceProblem(relayInterface);
  if (relayIssue) return `--relay-interface ${relayIssue}`;
  const clash = allLinks().find((link) => link.host !== name && link.localInterface === localInterface);
  if (clash) return `--interface ${localInterface} is already the link to ${clash.host}; pass another --interface`;
  const component = input.component ?? 'wg-nginx';
  if (!namePattern.test(component)) return `component '${component}' must match ${namePattern}`;
  return { host: name, component, subnet, relayIp, localIp, port, endpoint, relayInterface, localInterface };
}

/** Writes both sides. Refuses when the host already has a link from this origin: keys are never overwritten. */
function writeLink(plan: LinkPlan, origin: string): LinkInfo {
  const name = plan.host;
  const dir = join(linksRoot(), name);
  const relayDir = join(defaultStateDir(name, plan.component), 'wg');
  for (const existing of [join(dir, 'link.env'), join(relayDir, 'relay.conf')]) {
    if (existsSync(existing)) {
      fail(`${existing} already exists: ${name} has a link from this origin, and init never overwrites keys.
See it: qp-tunnel-cli edge link show ${name}. To start over, move ${dir} and ${relayDir} aside first.`, 1);
    }
  }
  ensureHome();
  const relayKeys = wgKeyPair();
  const localKeys = wgKeyPair();
  const now = new Date().toISOString();
  const subnetCidr = cidrText(plan.subnet);
  const relayAddress = intToIp(plan.relayIp);
  const localAddress = intToIp(plan.localIp);
  const { relayInterface, localInterface, port, endpoint } = plan;
  const writePrivate = (file: string, content: string) => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, content, { mode: 0o600 });
    chmodSync(file, 0o600);
  };

  writePrivate(join(relayDir, 'relay.conf'), `${linkMarker} ${name}: relay side, written on ${origin} at ${now}.
# Installed by the wg-nginx stack as /etc/wireguard/${relayInterface}.conf. Same shape as the
# Launcher's mx-domestic (10.88.0.1, Table = off): this host listens; the Internal machine
# dials out to it. Only its /32 is routed here (not the block), no DNS, no forwarding, no NAT.
[Interface]
Address = ${relayAddress}/32
ListenPort = ${port}
PrivateKey = ${relayKeys.privateKey}
Table = off
SaveConfig = false
PostUp = ip route replace ${localAddress}/32 dev %i
PostDown = ip route del ${localAddress}/32 dev %i 2>/dev/null || true

# ${origin}
[Peer]
PublicKey = ${localKeys.publicKey}
AllowedIPs = ${localAddress}/32
`);
  writePrivate(join(relayDir, 'relay.env'), `# Written by qp-tunnel-cli edge link init on ${origin} at ${now}; read (not sourced) by the wg-nginx hooks.
EDGE_LINK_HOST=${name}
EDGE_LINK_ORIGIN=${origin}
EDGE_WG_INTERFACE=${relayInterface}
EDGE_WG_PORT=${port}
EDGE_WG_ADDRESS=${relayAddress}/32
EDGE_WG_SUBNET=${subnetCidr}
EDGE_WG_PEERS="${origin}=${localAddress}"
`);
  writePrivate(join(dir, `${localInterface}.conf`), `${linkMarker} ${name}: this side (${origin}), written at ${now}.
# Installed by edge link up as /etc/wireguard/${localInterface}.conf. Same shape as the
# Launcher's mx-internal-svc (10.88.88.88/32): this machine dials out to ${name} and routes
# only ${relayAddress}/32 into the tunnel (${subnetCidr} is shared by all edge links). No DNS line, no default route.
[Interface]
Address = ${localAddress}/32
PrivateKey = ${localKeys.privateKey}
Table = off
PostUp = ip route replace ${relayAddress}/32 dev %i
PostDown = ip route del ${relayAddress}/32 dev %i 2>/dev/null || true

# ${name}
[Peer]
PublicKey = ${relayKeys.publicKey}
Endpoint = ${endpoint}
AllowedIPs = ${relayAddress}/32
PersistentKeepalive = 25
`);
  writePrivate(join(dir, 'link.env'), `# qp-tunnel-cli edge link ${name}: written on ${origin} at ${now}. No private keys in this file.
LINK_HOST=${name}
LINK_COMPONENT=${plan.component}
LINK_ORIGIN=${origin}
LINK_PLAN=${planOf(subnetCidr)?.name ?? 'custom'}
LINK_SUBNET=${subnetCidr}
LINK_RELAY_IP=${relayAddress}
LINK_LOCAL_IP=${localAddress}
LINK_PORT=${port}
LINK_ENDPOINT=${endpoint}
LINK_RELAY_INTERFACE=${relayInterface}
LINK_LOCAL_INTERFACE=${localInterface}
LINK_RELAY_PUBLIC_KEY=${relayKeys.publicKey}
LINK_LOCAL_PUBLIC_KEY=${localKeys.publicKey}
LINK_CREATED=${now}
`);
  privateTree(dir);
  privateTree(relayDir);
  warnIfTracked(dir);
  return readLink(name) as LinkInfo;
}

/** Moves a link's files to <edge home>/replaced/<time>-<host>/ (nothing is deleted). Returns the old link and where it went. */
function setLinkAside(host: string): { old: LinkInfo; aside: string } {
  const old = requireLink(host);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const aside = join(edgeHome(), 'replaced', `${stamp}-${host}`);
  mkdirSync(aside, { recursive: true, mode: 0o700 });
  renameSync(old.dir, join(aside, 'link'));
  if (existsSync(old.relayDir)) renameSync(old.relayDir, join(aside, 'wg'));
  privateTree(aside);
  process.stdout.write(`The link to ${host} (${old.subnet}, ${old.localIp} -> ${old.relayIp}) was moved to ${aside}; nothing was deleted.\n`);
  return { old, aside };
}

/** After a replace: the old interface keeps running when the new link uses another name, so stop it (its config stays). */
function retireOldInterface(old: LinkInfo, current: LinkInfo): void {
  if (old.localInterface === current.localInterface || !interfacePresent(old.localInterface)) return;
  process.stdout.write(`Stopping the old interface ${old.localInterface} (its config stays in ${wgDir()}).\n`);
  runAsRoot(stopLinkScript, [old.localInterface, wgDir()]);
}

function describeLink(link: LinkInfo, routesChecked: boolean): string {
  return `Link ${link.host} <-> ${link.origin} (this machine)
  plan       ${planOf(link.subnet)?.name ?? 'custom'}: ${link.subnet}, shared by all edge links, one address per machine
  ${link.host.padEnd(10)} ${link.relayIp} on ${link.relayInterface}, listens on udp ${link.port}; reached at ${link.endpoint}
  this side  ${link.localIp} on ${link.localInterface}, dials out, keepalive 25s; only ${link.relayIp}/32 goes into it
  routes     ${routesChecked ? (() => {
    const covering = addressRoutes(link.relayIp, [link.localInterface]).covering;
    return covering.length > 0 ? `${link.relayIp}/32 goes into ${link.localInterface}; it is more specific than: ${covering.join('; ')}` : 'nothing else on this machine routes these addresses';
  })() : 'not checked here (not Linux); edge link up checks again'}
  files      ${link.relayDir}/relay.conf, relay.env   (pushed with the stack; ${link.host}'s private key)
             ${link.localConfig}   (stays here; this side's private key)
`;
}

function interfacePresent(name: string): boolean | undefined {
  if (process.platform !== 'linux' && !process.env.QP_EDGE_IP_BIN) return undefined;
  const result = spawnSync(process.env.QP_EDGE_IP_BIN || 'ip', ['link', 'show', name], { stdio: 'ignore' });
  if (result.error) return undefined;
  return result.status === 0;
}

function commandExists(name: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${shellQuote(name)}`], { stdio: 'ignore' }).status === 0;
}

/** Runs a bash script as root: directly when already root, else through sudo (it may ask for a password). */
function runAsRoot(script: string, args: string[], capture = false): Captured {
  const sudo = process.env.QP_EDGE_SUDO ?? 'sudo';
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const command = isRoot || sudo === '' ? 'bash' : sudo;
  const commandArgs = isRoot || sudo === '' ? ['-s', '--', ...args] : ['bash', '-s', '--', ...args];
  const result = spawnSync(command, commandArgs, {
    input: script,
    encoding: 'utf8',
    stdio: ['pipe', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
  });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}

// ---------- tools this machine needs, installed on request ----------

interface LocalTool {
  command: string;
  apt: string;
  rpm: string;
}

/** What push needs here: the ssh it will run (QP_EDGE_SSH_BIN when set) and tar. */
function pushTools(): LocalTool[] {
  return [
    { command: sshBin(), apt: 'openssh-client', rpm: 'openssh-clients' },
    { command: 'tar', apt: 'tar', rpm: 'tar' },
  ];
}

const linkTools: LocalTool[] = [
  { command: 'wg', apt: 'wireguard-tools', rpm: 'wireguard-tools' },
  { command: 'wg-quick', apt: 'wireguard-tools', rpm: 'wireguard-tools' },
  { command: 'ip', apt: 'iproute2', rpm: 'iproute' },
  { command: 'ping', apt: 'iputils-ping', rpm: 'iputils' },
];

interface LocalOs {
  id: string;
  pretty: string;
  manager?: 'apt-get' | 'dnf' | 'yum';
  eol?: string;
}

function localOs(): LocalOs {
  const file = process.env.QP_EDGE_OS_RELEASE || '/etc/os-release';
  const release = existsSync(file) ? readManifest(file) : {};
  const id = release.ID ?? process.platform;
  const major = (release.VERSION_ID ?? '').split('.')[0];
  const manager = (['apt-get', 'dnf', 'yum'] as const).find((candidate) => commandExists(candidate));
  const eol = id === 'centos' && /^CentOS Linux/.test(release.NAME ?? '') && ['7', '8'].includes(major)
    ? `CentOS Linux ${major} is end of life: package installs work only if its repositories point at vault.centos.org or a local mirror`
    : undefined;
  return { id, pretty: release.PRETTY_NAME ?? id, ...(manager ? { manager } : {}), ...(eol ? { eol } : {}) };
}

const installPackagesScript = `set -euo pipefail
manager="$1" epel="$2" proxy="$3"; shift 3
if [ -n "$proxy" ]; then export http_proxy="$proxy" https_proxy="$proxy" HTTP_PROXY="$proxy" HTTPS_PROXY="$proxy"; fi
case "$manager" in
  apt-get)
    set -- -y -q "$@"
    if [ -n "$proxy" ]; then
      DEBIAN_FRONTEND=noninteractive apt-get -o "Acquire::http::Proxy=$proxy" -o "Acquire::https::Proxy=$proxy" update -q
      DEBIAN_FRONTEND=noninteractive apt-get -o "Acquire::http::Proxy=$proxy" -o "Acquire::https::Proxy=$proxy" install "$@"
    else
      DEBIAN_FRONTEND=noninteractive apt-get update -q
      DEBIAN_FRONTEND=noninteractive apt-get install "$@"
    fi
    ;;
  dnf|yum)
    if [ "$epel" = 1 ] && ! rpm -q epel-release >/dev/null 2>&1; then "$manager" install -y -q epel-release; fi
    "$manager" install -y -q "$@"
    ;;
  *) echo "no supported package manager" >&2; exit 1 ;;
esac
`;

/**
 * Checks the commands are on PATH and, when some are missing, installs their
 * packages with apt-get/dnf/yum through sudo after asking (or with --yes).
 * The proxy comes from PROXY / HTTPS_PROXY / HTTP_PROXY, because sudo drops them.
 */
async function ensureLocalTools(tools: LocalTool[], parsed: ParsedArgs): Promise<void> {
  const missing = tools.filter((tool) => !commandExists(tool.command));
  if (missing.length === 0) return;
  const names = missing.map((tool) => tool.command).join(', ');
  const os = localOs();
  const packages = [...new Set(missing.map((tool) => (os.manager === 'apt-get' ? tool.apt : tool.rpm)))];
  if ((process.platform !== 'linux' && !process.env.QP_EDGE_OS_RELEASE) || !os.manager) {
    fail(`${names} not found on this machine. Install ${packages.join(' ')} with its package manager, then run this again`, 1);
  }
  const epel = os.manager !== 'apt-get' && os.id !== 'fedora' && packages.includes('wireguard-tools');
  const proxy = process.env.PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
  const commands = os.manager === 'apt-get'
    ? `sudo apt-get update && sudo apt-get install -y ${packages.join(' ')}`
    : `${epel ? `sudo ${os.manager} install -y epel-release && ` : ''}sudo ${os.manager} install -y ${packages.join(' ')}`;
  process.stdout.write(`Missing on this machine (${os.pretty}): ${names}
  installs: ${packages.join(' ')}${epel ? ' (wireguard-tools comes from EPEL here)' : ''}${proxy ? `, through the proxy ${proxy}` : ''}
  by hand:  ${commands}
`);
  if (os.eol) process.stdout.write(`  note:     ${os.eol}\n`);
  if (!flag(parsed, 'yes', 'y')) {
    if (!process.stdin.isTTY) fail(`not a terminal: install them by hand (above), or pass --yes to install them`, 1);
    if (!(await askYesNo(`Install ${packages.join(' ')} now (sudo)?`, true))) fail('nothing was installed', 1);
  }
  const result = runAsRoot(installPackagesScript, [os.manager as string, epel ? '1' : '0', proxy, ...packages]);
  if (result.error) fail(`cannot run ${process.env.QP_EDGE_SUDO ?? 'sudo'}: ${result.error.message}`, 1);
  if (result.status !== 0) fail(`installing ${packages.join(' ')} failed (exit ${result.status})${os.eol ? `. ${os.eol}` : ''}`, 1);
  const still = missing.filter((tool) => !commandExists(tool.command));
  if (still.length > 0) fail(`${still.map((tool) => tool.command).join(', ')} still not found after installing ${packages.join(' ')}`, 1);
  process.stdout.write(`Installed ${packages.join(' ')}.\n`);
}

// ---------- link commands ----------

async function linkCommand(parsed: ParsedArgs): Promise<void> {
  const sub = parsed.positionals[0] ?? 'list';
  const rest: ParsedArgs = { ...parsed, positionals: parsed.positionals.slice(1) };
  switch (sub) {
    case 'list':
      listLinks(parsed);
      return;
    case 'init':
      await linkInit(rest);
      return;
    case 'show':
      showLink(rest);
      return;
    case 'up':
      await linkUp(rest);
      return;
    case 'down':
      linkDown(rest);
      return;
    case 'check':
      linkCheck(rest);
      return;
    default:
      if (namePattern.test(sub) && readLink(sub)) {
        showLink(parsed);
        return;
      }
      fail(`unknown edge link command: ${sub} (list, init, show, up, check, down)`);
  }
}

function linkHostArg(parsed: ParsedArgs, usage: string): string {
  const name = parsed.positionals[0];
  if (!name) fail(`usage: ${usage}`);
  validateName('host', name);
  return name;
}

function listLinks(parsed: ParsedArgs): void {
  const links = allLinks();
  if (flag(parsed, 'json')) {
    process.stdout.write(`${JSON.stringify(links.map((link) => ({ ...link, up: interfacePresent(link.localInterface) ?? null })), null, 2)}\n`);
    return;
  }
  if (links.length === 0) {
    process.stdout.write(`No links under ${linksRoot()}.\nStart one: qp-tunnel-cli edge link init <host>   (or the whole way: qp-tunnel-cli edge setup)\n`);
    return;
  }
  printTable(['HOST', 'SUBNET', 'THIS SIDE', 'RELAY', 'ENDPOINT', 'INTERFACE', 'STATE'], links.map((link) => {
    const up = interfacePresent(link.localInterface);
    return [link.host, link.subnet, link.localIp, `${link.relayIp} (${link.relayInterface})`, link.endpoint, link.localInterface, up === undefined ? '-' : up ? 'up' : 'down'];
  }));
}

/** Asks for what the command line left out, with defaults; only in a terminal. */
async function promptLinkInput(name: string, host: EdgeHost, origin: string | undefined, given: LinkInput): Promise<LinkInput> {
  const input: LinkInput = { ...given };
  if (!input.subnet) {
    if (input.plan && input.plan in addressPlans) {
      input.subnet = addressPlans[input.plan as AddressPlan['name']].subnet;
    } else {
      process.stdout.write(`  Each machine gets one fixed address; traffic goes edge host -> Internal only.\n`);
      const existing = planOf(allLinks().find((link) => link.host !== name)?.subnet);
      const choice = await promptChoice('Address plan', [
        ['launcher', addressPlans.launcher.summary],
        ['isolated', addressPlans.isolated.summary],
      ], existing?.name === 'isolated' ? 1 : 0);
      if (choice === 0) {
        input.subnet = addressPlans.launcher.subnet;
      } else {
        input.subnet = await promptValue('Edge subnet (shared by all edge links)', defaultLinkSubnet(name), (value) => linkSubnetProblem(value, name));
      }
    }
  }
  const subnetIssue = linkSubnetProblem(input.subnet, name);
  if (subnetIssue) fail(subnetIssue);
  const subnet = parseCidr(input.subnet) as Cidr;
  const taken = takenRelayAddresses(subnet, name);
  input.relayIp ??= await promptValue(`${name}'s address`, defaultRelayAddress(subnet, name),
    (value) => hostAddressProblem(value, subnet) ?? planAddressProblem(value, input.subnet as string)
      ?? (taken.has(ipToInt(value) as number) ? `${value} is already ${taken.get(ipToInt(value) as number)}'s address` : undefined)
      ?? (addressRoutes(value, []).clash ? `${value} is already routed or assigned on this machine` : undefined));
  const relayIp = ipToInt(input.relayIp) as number;
  input.ip ??= await promptValue('This machine\'s address', defaultLocalAddress(subnet, origin, relayIp),
    (value) => hostAddressProblem(value, subnet) ?? planAddressProblem(value, input.subnet as string)
      ?? (ipToInt(value) === relayIp ? `${value} is ${name}'s address` : taken.has(ipToInt(value) as number) ? `${value} is ${taken.get(ipToInt(value) as number)}'s address` : undefined));
  input.port ??= await promptValue(`UDP port ${name} listens on (open it in its security group)`, String(defaultLinkPort), portProblem);
  input.endpoint ??= await promptValue(`Where this machine dials ${name} (public address:port)`,
    host.jump ? undefined : `${host.host.includes(':') ? `[${host.host}]` : host.host}:${input.port}`, endpointProblem);
  input.relayInterface ??= await promptValue(`WireGuard interface on ${name}`, defaultRelayInterface, interfaceProblem);
  input.localInterface ??= await promptValue('WireGuard interface on this machine', defaultLocalInterface(name), (value) => {
    const clash = allLinks().find((link) => link.host !== name && link.localInterface === value);
    return interfaceProblem(value) ?? (clash ? `${value} is already the link to ${clash.host}` : undefined);
  });
  return input;
}

async function linkInit(parsed: ParsedArgs): Promise<void> {
  const name = linkHostArg(parsed, linkInitUsage);
  const host = readHosts().hosts[name];
  if (!host) fail(`no saved host named ${name}. Add it first: qp-tunnel-cli edge add ${name} --host <ip|dns> ...`);
  let input: LinkInput = {
    plan: option(parsed, 'plan'),
    subnet: option(parsed, 'subnet'), ip: option(parsed, 'ip'), relayIp: option(parsed, 'relay-ip'), port: option(parsed, 'port'),
    endpoint: option(parsed, 'endpoint'), localInterface: option(parsed, 'interface'), relayInterface: option(parsed, 'relay-interface'),
    component: option(parsed, 'component'),
  };
  for (const key of Object.keys(input) as Array<keyof LinkInput>) if (input[key] === undefined) delete input[key];
  const existing = readLink(name);
  if (existing && !flag(parsed, 'replace')) {
    fail(`${name} already has a link from this origin (qp-tunnel-cli edge link show ${name}); init never overwrites keys.
To make a new one: qp-tunnel-cli edge link init ${name} --replace   (the current files are moved aside, not deleted)`, 1);
  }
  if (!input.subnet && !input.plan && process.stdin.isTTY && process.stdout.isTTY) {
    input = await promptLinkInput(name, host, readOrigin().name, input);
  }
  // Every check runs while the old link is still in place (its interface and routes are ours);
  // it is moved aside only when the new one is ready to be written.
  const plan = resolveLinkPlan(name, host, input);
  if (typeof plan === 'string') fail(plan);
  const origin = requireOrigin();
  const replaced = existing ? setLinkAside(name).old : undefined;
  const link = writeLink(plan, origin);
  if (replaced) retireOldInterface(replaced, link);
  const routes = localRouteClashes(plan.subnet, plan.localInterface);
  const pushComponent = plan.component === 'wg-nginx' ? '' : ` --component ${plan.component}`;
  process.stdout.write(`${describeLink(link, routes.checked)}
Next:
  1. open udp ${plan.port} to ${name} in its cloud security group
  2. qp-tunnel-cli edge push ${name} --stack wg-nginx${pushComponent} --dry-run
     qp-tunnel-cli edge push ${name} --stack wg-nginx${pushComponent} --yes
  3. qp-tunnel-cli edge link up ${name}
  4. qp-tunnel-cli edge link check ${name}
`);
}

function showLink(parsed: ParsedArgs): void {
  const name = linkHostArg(parsed, 'edge link show <name>');
  const link = requireLink(name);
  const up = interfacePresent(link.localInterface);
  process.stdout.write(`Link ${name}, made on ${link.origin} at ${link.created}
  subnet      ${link.subnet}
  ${name.padEnd(11)} ${link.relayIp} on ${link.relayInterface}, udp ${link.port}, endpoint ${link.endpoint}
              public key ${link.relayPublicKey}
  internal    ${link.localIp} on ${link.localInterface} (${up === undefined ? 'state unknown here' : up ? 'up' : 'down'})
              public key ${link.localPublicKey}
  component   ${link.component} (relay files in ${link.relayDir})
  this side   ${link.localConfig}
`);
}

const installLinkScript = `set -euo pipefail
src="$1" iface="$2" boot="$3" dir="$4"
target="$dir/$iface.conf"
unit="wg-quick@$iface"
same() { if command -v cmp >/dev/null 2>&1; then cmp -s "$1" "$2"; else [ "$(cksum < "$1")" = "$(cksum < "$2")" ]; fi; }
changed=0
if [ -L "$dir" ] && [ ! -d "$dir" ]; then echo "[link] error: $dir is a symlink to a missing directory ($(readlink "$dir")); create that directory first" >&2; exit 1; fi
[ -d "$dir" ] || install -d -m 700 "$dir"
if [ -e "$target" ]; then
  if same "$src" "$target"; then
    echo "[link] $target unchanged"
  elif head -n 1 "$target" | grep -q '^${linkMarker}'; then
    backup="$dir/qp-edge-backup/$(date -u +%Y%m%dT%H%M%SZ)"
    mkdir -p "$backup"
    chmod 700 "$dir/qp-edge-backup"
    cp -p "$target" "$backup/"
    install -m 600 "$src" "$target"
    changed=1
    echo "[link] $target replaced (the previous one is in $backup)"
  else
    echo "[link] error: $target exists and was not written by qp-tunnel-cli edge link; nothing was changed" >&2
    exit 3
  fi
else
  install -m 600 "$src" "$target"
  changed=1
  echo "[link] $target written"
fi
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  if [ "$boot" = 1 ]; then
    systemctl enable "$unit" >/dev/null 2>&1 || { echo "[link] error: systemctl enable $unit failed" >&2; exit 1; }
    echo "[link] $unit enabled at boot"
  fi
  if systemctl is-active --quiet "$unit"; then
    if [ "$changed" = 1 ]; then systemctl restart "$unit"; echo "[link] $unit restarted"; else echo "[link] $unit already active"; fi
  else
    if ip link show "$iface" >/dev/null 2>&1; then wg-quick down "$target" || true; fi
    systemctl start "$unit" || { echo "[link] error: systemctl start $unit failed (journalctl -u $unit)" >&2; exit 1; }
    echo "[link] $unit started"
  fi
else
  if ip link show "$iface" >/dev/null 2>&1; then
    if [ "$changed" = 1 ]; then wg-quick down "$target" || true; wg-quick up "$target"; fi
  else
    wg-quick up "$target"
  fi
  echo "[link] $iface up (no systemd here, so not started at boot)"
fi
`;

const stopLinkScript = `set -euo pipefail
iface="$1" dir="$2"
unit="wg-quick@$iface"
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  systemctl disable --now "$unit" >/dev/null 2>&1 || true
fi
if ip link show "$iface" >/dev/null 2>&1; then wg-quick down "$dir/$iface.conf"; fi
echo "[link] $iface down; $dir/$iface.conf kept"
`;

function wgDir(): string {
  return process.env.QP_EDGE_WG_DIR || '/etc/wireguard';
}

/** Installs and starts this side, then checks it. Exits on refusals. */
async function bringLinkUp(link: LinkInfo, boot: boolean, parsed: ParsedArgs): Promise<LocalReport> {
  if (process.platform !== 'linux' && !process.env.QP_EDGE_WG_DIR) fail('edge link up sets up a Linux WireGuard interface; run it on the Internal machine', 1);
  await ensureLocalTools(linkTools, parsed);
  const subnet = parseCidr(link.subnet);
  if (!subnet) fail(`${link.dir}/link.env has no usable LINK_SUBNET`, 1);
  const own = allLinks().map((other) => other.localInterface);
  if (!planOf(link.subnet) || planOf(link.subnet)?.name === 'isolated') {
    const routes = localRouteClashes(subnet, own);
    if (routes.clashes.length > 0) fail(`${link.subnet} overlaps routes on this machine now:\n  ${routes.clashes.join('\n  ')}\nNothing was changed`, 1);
  }
  const relayRoutes = addressRoutes(link.relayIp, own);
  if (relayRoutes.clash) fail(`${link.relayIp} is routed or assigned elsewhere on this machine now (${relayRoutes.clash}); nothing was changed`, 1);
  process.stdout.write(`Bringing up ${link.localInterface}: ${link.localIp} -> ${link.host} ${link.relayIp} at ${link.endpoint} (only ${link.relayIp}/32 goes in)\n`);
  const result = runAsRoot(installLinkScript, [link.localConfig, link.localInterface, boot ? '1' : '0', wgDir()]);
  if (result.error) fail(`cannot run ${process.env.QP_EDGE_SUDO ?? 'sudo'}: ${result.error.message}`, 1);
  if (result.status !== 0) process.exit(result.status ?? 1);
  return reportLocalSide(link, 20);
}

/** Both ends after edge link up; prints the reason when there is no handshake. */
function checkBothEnds(link: LinkInfo, local: LocalReport): boolean {
  const remote = reportRemoteSide(link);
  explainLink(link, local, remote);
  return local.ok && remote.ok;
}

function linkUpAdvice(link: LinkInfo): string {
  return `${link.localInterface} is installed but the check failed (see "why" above). After fixing it: qp-tunnel-cli edge link check ${link.host}
Take it down again with: qp-tunnel-cli edge link down ${link.host}`;
}

async function linkUp(parsed: ParsedArgs): Promise<void> {
  const name = linkHostArg(parsed, 'edge link up <name> [--no-boot] [--yes]');
  const link = requireLink(name);
  const local = await bringLinkUp(link, !flag(parsed, 'no-boot'), parsed);
  const ok = checkBothEnds(link, local);
  process.stdout.write(ok ? `\nUp on both ends.\n` : `\n${linkUpAdvice(link)}\n`);
  if (!ok) process.exit(1);
}

function linkDown(parsed: ParsedArgs): void {
  const name = linkHostArg(parsed, 'edge link down <name>');
  const link = requireLink(name);
  const result = runAsRoot(stopLinkScript, [link.localInterface, wgDir()]);
  if (result.error) fail(`cannot run ${process.env.QP_EDGE_SUDO ?? 'sudo'}: ${result.error.message}`, 1);
  process.exit(result.status ?? 1);
}

interface LocalReport {
  ok: boolean;
  handshake: boolean;
  tx?: number;
  rx?: number;
}

/** Prints the local checks. ok when the handshake and ping pass and no default route goes in. */
function reportLocalSide(link: LinkInfo, waitSeconds: number): LocalReport {
  const ipBin = process.env.QP_EDGE_IP_BIN || 'ip';
  const line = (good: boolean | undefined, text: string) => process.stdout.write(`  ${good === undefined ? 'UNKNOWN' : good ? 'ok     ' : 'FAIL   '} ${text}\n`);
  process.stdout.write(`\nthis side (${link.localInterface})\n`);
  let ok = true;
  const present = interfacePresent(link.localInterface);
  line(present, `interface ${link.localInterface} ${present ? 'exists' : present === false ? 'does not exist (edge link up)' : 'cannot be checked here'}`);
  if (!present) return { ok: false, handshake: false, tx: 0 };

  let handshake = 0;
  const deadline = Date.now() + waitSeconds * 1000;
  let readable = true;
  for (;;) {
    const shown = runAsRoot('wg show "$1" latest-handshakes', [link.localInterface], true);
    if (shown.status !== 0) {
      readable = false;
      break;
    }
    handshake = Math.max(0, ...shown.stdout.split('\n').map((row) => Number(row.trim().split(/\s+/)[1] ?? 0)).filter((value) => Number.isFinite(value)));
    if (handshake > 0 || Date.now() >= deadline) break;
    spawnSync('sleep', ['1']);
  }
  let rx: number | undefined;
  let tx: number | undefined;
  const transfer = readable ? runAsRoot('wg show "$1" transfer', [link.localInterface], true) : undefined;
  const row = transfer?.stdout.split('\n').map((text) => text.trim().split(/\s+/)).find((cols) => cols[0] === link.relayPublicKey);
  if (row) {
    rx = Number(row[1]);
    tx = Number(row[2]);
  }
  const counted = rx !== undefined ? ` (sent ${tx} bytes, received ${rx})` : '';
  if (!readable) {
    line(undefined, `handshake: wg show ${link.localInterface} needs root (sudo)`);
    ok = false;
  } else if (handshake > 0) {
    line(true, `handshake with ${link.host} ${Math.max(0, Math.round(Date.now() / 1000 - handshake))}s ago`);
  } else {
    line(false, `no handshake with ${link.host} at ${link.endpoint}${waitSeconds > 0 ? ` after ${waitSeconds}s` : ''}${counted}`);
    ok = false;
  }

  const devPattern = new RegExp(`\\bdev ${link.localInterface.replace(/[.+]/g, '\\$&')}\\b`);
  const routeGet = (address: string) => spawnSync(ipBin, ['-4', 'route', 'get', address], { encoding: 'utf8' });
  const toRelay = routeGet(link.relayIp);
  const relayDev = !toRelay.error && toRelay.status === 0 && devPattern.test(toRelay.stdout);
  line(relayDev, `${link.relayIp} is routed ${relayDev ? `into ${link.localInterface}` : `elsewhere: ${(toRelay.stdout || toRelay.stderr || '').trim()}`}`);
  ok &&= relayDev;
  const outside = routeGet('1.1.1.1');
  const hijacked = !outside.error && outside.status === 0 && devPattern.test(outside.stdout);
  line(!hijacked, hijacked ? `everything else goes into ${link.localInterface} too: ${outside.stdout.trim()}` : 'other traffic stays off the tunnel (1.1.1.1 is not routed into it)');
  ok &&= !hijacked;
  const ping = spawnSync('ping', ['-c', '3', '-W', '2', link.relayIp], { encoding: 'utf8' });
  const pinged = !ping.error && ping.status === 0;
  line(pinged, `ping ${link.relayIp} (${link.host}) ${pinged ? (ping.stdout.split('\n').find((text) => /min\/avg/.test(text))?.trim() ?? 'answered') : 'got no answer'}`);
  return { ok: ok && pinged, handshake: handshake > 0, ...(tx !== undefined ? { tx, rx } : {}) };
}

interface RemoteReport {
  ok: boolean;
  reached: boolean;
  unit?: string;
  handshake?: boolean;
  isPeer?: boolean;
  relayKey?: string;
  port?: string;
  rx?: number;
  tx?: number;
  firewall?: string;
  capture?: string;
}

/** Prints the edge host's side over ssh; when there is no handshake it also says what arrives there. */
function reportRemoteSide(link: LinkInfo): RemoteReport {
  const hosts = readHosts().hosts;
  const host = hosts[link.host];
  process.stdout.write(`\n${link.host} (${link.relayInterface})\n`);
  if (!host) {
    process.stdout.write(`  UNKNOWN ${link.host} is not a saved host on this machine (edge add ${link.host} ...)\n`);
    return { ok: false, reached: false };
  }
  // Read-only. tcpdump (when installed and there is no handshake) watches udp <port> for 7 s: it sees packets
  // before the host firewall, so it tells "nothing arrives" from "arrives and is dropped here".
  const script = `iface=${shellQuote(link.relayInterface)}; peer=${shellQuote(link.localIp)}; me=${shellQuote(link.localPublicKey)}; port=${shellQuote(String(link.port))}
printf 'unit=%s\\n' "$(systemctl is-active "wg-quick@$iface" 2>/dev/null || true)"
if command -v wg >/dev/null 2>&1; then
  wg show "$iface" latest-handshakes 2>/dev/null | sed 's/^/hs=/'
  wg show "$iface" transfer 2>/dev/null | sed 's/^/tr=/'
  printf 'pub=%s\\n' "$(wg show "$iface" public-key 2>/dev/null)"
  printf 'port=%s\\n' "$(wg show "$iface" listen-port 2>/dev/null)"
else echo 'nowg=1'; fi
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  if firewall-cmd --query-port="$port/udp" >/dev/null 2>&1; then echo fw=firewalld-open; else echo fw=firewalld-closed; fi
elif command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  if ufw status 2>/dev/null | grep -Eq "^$port(/udp)?[[:space:]].*ALLOW"; then echo fw=ufw-open; else echo fw=ufw-closed; fi
elif command -v iptables >/dev/null 2>&1 && iptables -S INPUT 2>/dev/null | grep -Eq -- "-p udp.*--dport $port .*-j (DROP|REJECT)"; then echo fw=iptables-drop
elif command -v iptables >/dev/null 2>&1 && iptables -S INPUT 2>/dev/null | grep -q '^-P INPUT DROP'; then echo fw=iptables-policy-drop
else echo fw=none; fi
seen="$(wg show "$iface" latest-handshakes 2>/dev/null | awk -v k="$me" '$1==k {print $2}')"
if [ "\${seen:-0}" = 0 ]; then
  if command -v tcpdump >/dev/null 2>&1; then
    got="$(timeout 7 tcpdump -lni any -c 1 "udp port $port" 2>/dev/null | head -n 1)"
    if [ -n "$got" ]; then printf 'cap=seen %s\\n' "$got"; else echo cap=none; fi
  else echo cap=no-tcpdump; fi
fi
if ping -c 3 -W 2 "$peer" >/dev/null 2>&1; then echo ping=ok; else echo ping=fail; fi`;
  const result = spawnSync(sshBin(), [...buildSshArgs(link.host, hosts, true), asRoot(host, `sh -c ${shellQuote(script)}`)], { encoding: 'utf8' });
  if (result.error || result.status === 255) {
    process.stdout.write(`  UNKNOWN ssh could not reach ${link.host}${result.error ? `: ${result.error.message}` : ''}\n`);
    return { ok: false, reached: false };
  }
  const out = result.stdout ?? '';
  const field = (key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(out)?.[1]?.trim();
  const unit = field('unit') || 'unknown';
  const line = (good: boolean, text: string) => process.stdout.write(`  ${good ? 'ok     ' : 'FAIL   '} ${text}\n`);
  line(unit === 'active', `wg-quick@${link.relayInterface} is ${unit}${unit === 'active' ? '' : ` (edge push ${link.host} --stack wg-nginx)`}`);
  const rows = (prefix: string) => out.split('\n').filter((text) => text.startsWith(`${prefix}=`)).map((text) => text.slice(prefix.length + 1).trim().split(/\s+/));
  const peerRow = rows('hs').find((cols) => cols[0] === link.localPublicKey);
  const transfer = rows('tr').find((cols) => cols[0] === link.localPublicKey);
  const at = Number(peerRow?.[1] ?? 0);
  const rx = transfer ? Number(transfer[1]) : undefined;
  const tx = transfer ? Number(transfer[2]) : undefined;
  if (/^nowg=1$/m.test(out)) line(false, 'wg is not installed there');
  else line(at > 0, at > 0 ? `handshake with this side ${Math.max(0, Math.round(Date.now() / 1000 - at))}s ago`
    : peerRow ? `no handshake with this side yet${rx !== undefined ? ` (received ${rx} bytes, sent ${tx})` : ''}` : `this side's key is not a peer of ${link.relayInterface} there (pushed from another link?)`);
  const pinged = /^ping=ok$/m.test(out);
  line(pinged, `ping ${link.localIp} (this side) from ${link.host} ${pinged ? 'answered' : 'got no answer'}`);
  let ok = unit === 'active' && at > 0 && pinged;
  if (result.status !== 0 && !/^unit=/m.test(out)) {
    process.stdout.write(`  ${(result.stderr ?? '').trim() || `remote check exited ${result.status}`}${host.user === 'root' ? '' : ' (the remote user needs passwordless sudo)'}\n`);
    ok = false;
  }
  return {
    ok, reached: true, unit, handshake: at > 0, isPeer: Boolean(peerRow), relayKey: field('pub'), port: field('port'),
    ...(rx !== undefined ? { rx, tx } : {}), firewall: field('fw'), capture: field('cap'),
  };
}

/** When there is no handshake: which part of the path fails, from what both ends saw. */
function explainLink(link: LinkInfo, local: LocalReport, remote: RemoteReport): void {
  if (local.handshake && remote.handshake) return;
  const port = link.port;
  const why: string[] = [];
  const firewallFix = (fw?: string): string | undefined => {
    switch (fw) {
      case 'firewalld-closed': return `${link.host}'s firewalld does not allow udp ${port}: sudo firewall-cmd --add-port=${port}/udp && sudo firewall-cmd --permanent --add-port=${port}/udp`;
      case 'ufw-closed': return `${link.host}'s ufw does not allow udp ${port}: sudo ufw allow ${port}/udp`;
      case 'iptables-drop': return `an iptables rule on ${link.host} drops udp ${port} (iptables -S INPUT)`;
      case 'iptables-policy-drop': return `${link.host}'s iptables INPUT policy is DROP and may not let udp ${port} in (iptables -S INPUT)`;
      default: return undefined;
    }
  };
  const securityGroup = `the cloud security group of ${link.host} must allow udp ${port} inbound (Aliyun console: 安全组 → 入方向 → add UDP ${port}/${port}); if it does, the network of this machine may block outbound udp ${port}`;
  if (local.tx === 0) {
    why.push(`this machine has sent nothing to ${link.endpoint}: is ${link.localInterface} up? (edge link up ${link.host})`);
  } else if (!remote.reached) {
    why.push(`${link.host} could not be asked over ssh, so only this side is known: ${securityGroup}`);
  } else if (remote.unit !== 'active') {
    why.push(`wg-quick@${link.relayInterface} is not running on ${link.host}: edge push ${link.host} --stack wg-nginx`);
  } else if (remote.port && remote.port !== String(port)) {
    why.push(`${link.host} listens on udp ${remote.port}, but this side dials ${port}`);
  } else if (remote.relayKey && link.relayPublicKey && remote.relayKey !== link.relayPublicKey) {
    why.push(`the relay on ${link.host} has another key than this link expects (another link was pushed there): edge push ${link.host} --stack wg-nginx, then edge link up ${link.host}`);
  } else if (!remote.isPeer) {
    why.push(`this machine's key is not a peer on ${link.host}: edge push ${link.host} --stack wg-nginx`);
  } else if (remote.capture === 'none') {
    why.push(`nothing from this machine arrives at ${link.host} on udp ${port} (watched 7 s with tcpdump there; packets are dropped before they reach the host)`);
    why.push(securityGroup);
  } else if (remote.capture?.startsWith('seen') && !remote.rx) {
    const fix = firewallFix(remote.firewall);
    why.push(`packets arrive at ${link.host} (${remote.capture.slice(5, 120)}) but are not accepted`);
    why.push(fix ?? `${link.host}'s firewall shows no block (${remote.firewall ?? 'unknown'}); check iptables/nft rules there for udp ${port}`);
  } else if (!remote.rx) {
    const fix = firewallFix(remote.firewall);
    why.push(`nothing from this machine is accepted on ${link.host} (received 0 bytes)${remote.capture === 'no-tcpdump' ? '; install tcpdump there to see whether packets arrive at all' : ''}`);
    why.push(fix ?? securityGroup);
  } else if (!remote.tx) {
    why.push(`${link.host} receives this machine's packets but does not answer: push again (edge push ${link.host} --stack wg-nginx), then edge link up ${link.host}`);
  } else if (!local.rx) {
    why.push(`${link.host} answers but the replies do not come back to this machine: something on this side drops incoming udp from ${link.endpoint}`);
  }
  if (why.length === 0) return;
  process.stdout.write(`\nwhy\n${why.map((text) => `  - ${text}`).join('\n')}\n`);
}

function linkCheck(parsed: ParsedArgs): void {
  const name = linkHostArg(parsed, 'edge link check <name>');
  const link = requireLink(name);
  const local = reportLocalSide(link, 0);
  const remote = reportRemoteSide(link);
  explainLink(link, local, remote);
  process.exit(local.ok && remote.ok ? 0 : 1);
}

// ---------- this origin's SSH key, installed once with a password ----------
//
// The v1 Launcher's Bootstrap Key: a one-time password only puts a key that
// Internal generated into the host's authorized_keys; the password is never
// stored. Here ssh itself asks for the password on the terminal, so this tool
// never sees it. One key per origin, kept in the edge home.

function originKeyPath(): string {
  return join(edgeHome(), 'ssh', 'id_ed25519');
}

const keygenTool: LocalTool = { command: 'ssh-keygen', apt: 'openssh-client', rpm: 'openssh-clients' };

/** Makes the key on first use (ssh-keygen, ed25519, no passphrase: the edge home is 700 and owned by this user). */
async function ensureOriginKey(parsed: ParsedArgs): Promise<string> {
  const key = originKeyPath();
  if (existsSync(key) && existsSync(`${key}.pub`)) return key;
  await ensureLocalTools([keygenTool], parsed);
  ensureHome();
  mkdirSync(dirname(key), { recursive: true, mode: 0o700 });
  chmodSync(dirname(key), 0o700);
  if (existsSync(key)) {
    const pub = spawnSync('ssh-keygen', ['-y', '-f', key], { encoding: 'utf8' });
    if (pub.status !== 0) fail(`${key} exists but ssh-keygen cannot read it: ${(pub.stderr ?? '').trim()}`, 1);
    writeFileSync(`${key}.pub`, pub.stdout, { mode: 0o644 });
    return key;
  }
  const comment = `qp-tunnel-cli-edge-${(readOrigin().name ?? hostname().split('.')[0]).replace(/[^A-Za-z0-9._-]/g, '')}`;
  const made = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', key], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (made.status !== 0) fail(`ssh-keygen could not make ${key}`, 1);
  chmodSync(key, 0o600);
  process.stdout.write(`Made this origin's SSH key for edge hosts: ${key}\n`);
  return key;
}

interface SshProbe {
  ok: boolean;
  auth: boolean;
  message: string;
}

/** One non-interactive login. auth = the host answered but refused the key. */
function probeSsh(name: string): SshProbe {
  const result = spawnSync(sshBin(), [...buildSshArgs(name, readHosts().hosts, true), 'true'], { encoding: 'utf8' });
  if (result.error) return { ok: false, auth: false, message: result.error.message };
  if (result.status === 0) return { ok: true, auth: false, message: '' };
  const stderr = result.stderr ?? '';
  return {
    ok: false,
    auth: /Permission denied|Too many authentication failures|no such identity|Load key|No such file/i.test(stderr),
    message: stderr.trim().split('\n').pop() || `ssh exited ${result.status}`,
  };
}

/** Logs in once with the password (ssh asks for it), adds this origin's key, saves it for the host and checks a key login. */
async function installKeyWithPassword(name: string, parsed: ParsedArgs): Promise<boolean> {
  const data = readHosts();
  const host = data.hosts[name];
  if (!host) fail(`no saved host named ${name}`, 1);
  if (!process.stdin.isTTY) fail('the password is typed into ssh\'s own prompt, so this needs a terminal', 1);
  const key = await ensureOriginKey(parsed);
  const pub = readFileSync(`${key}.pub`, 'utf8').trim();
  const remote = [
    'umask 077',
    'mkdir -p ~/.ssh',
    'touch ~/.ssh/authorized_keys',
    'chmod 700 ~/.ssh',
    'chmod 600 ~/.ssh/authorized_keys',
    `{ grep -qxF ${shellQuote(pub)} ~/.ssh/authorized_keys || printf '%s\\n' ${shellQuote(pub)} >> ~/.ssh/authorized_keys; }`,
    '{ command -v restorecon >/dev/null 2>&1 && restorecon -R ~/.ssh >/dev/null 2>&1 || true; }',
    // sshd (StrictModes) refuses every key when the home directory is group- or world-writable.
    `{ case "$(ls -ld ~ | cut -c1-10)" in ?????w????|????????w?) chmod go-w ~ && echo "[edge] removed group/other write permission from $HOME: sshd refuses keys otherwise" ;; esac; }`,
  ].join(' && ');
  const withoutKey: EdgeHost = { ...host };
  delete withoutKey.key;
  const args = [
    ...baseOptions(withoutKey, false),
    '-o', 'PreferredAuthentications=keyboard-interactive,password',
    '-o', 'PubkeyAuthentication=no',
    '-o', 'NumberOfPasswordPrompts=3',
    ...(host.jump ? ['-o', `ProxyCommand=${jumpProxyCommand(host.jump, data.hosts, new Set([name]))}`] : []),
    `${host.user}@${host.host}`,
    remote,
  ];
  process.stdout.write(`Log in to ${name} (${host.user}@${host.host}:${host.port}) once with its password. ssh asks for it below;
this tool does not see or keep it. Then this origin's public key goes into ~${host.user}/.ssh/authorized_keys there
and every later connection uses ${key}.\n`);
  const result = spawnSync(sshBin(), args, { stdio: 'inherit' });
  if (result.error) fail(`cannot run ${sshBin()}: ${result.error.message}`, 1);
  if (result.status !== 0) {
    process.stderr.write(`edge: the password login to ${name} did not work (ssh exited ${result.status}).
If ${name} refuses password logins for ${host.user} (cloud images often set PermitRootLogin prohibit-password),
add this public key through the cloud console, or log in another way and append it to ~${host.user}/.ssh/authorized_keys:
  ${pub}
then run: qp-tunnel-cli edge add ${name} --key ${key}\n`);
    return false;
  }
  data.hosts[name] = { ...host, key };
  writeHosts(data);
  const probe = probeSsh(name);
  if (!probe.ok) {
    process.stderr.write(`edge: the key was added, but a key login to ${name} still fails: ${probe.message}
Look at the sshd log on ${name} (journalctl -u ssh or -u sshd): a line like "bad ownership or modes" or an
AuthorizedKeysFile setting other than .ssh/authorized_keys explains it.\n`);
    return false;
  }
  process.stdout.write(`Key login to ${name} works; ${name} now uses ${key}.\n`);
  if (host.user !== 'root') {
    const sudo = spawnSync(sshBin(), [...buildSshArgs(name, readHosts().hosts, true), 'sudo -n true'], { encoding: 'utf8' });
    if (sudo.status !== 0) {
      process.stdout.write(`Note: ${host.user} cannot run sudo without a password on ${name}. Pushing needs root there: log in as root,
or give ${host.user} passwordless sudo (a sudoers.d entry), then run this again.\n`);
    }
  }
  return true;
}

async function keyCommand(parsed: ParsedArgs): Promise<void> {
  const sub = parsed.positionals[0] ?? 'show';
  if (sub === 'show') {
    const key = originKeyPath();
    if (!existsSync(`${key}.pub`)) {
      process.stdout.write(`No SSH key for edge hosts yet (${key}).\nIt is made on first use: qp-tunnel-cli edge key install <name>, or edge setup.\n`);
      return;
    }
    const users = Object.entries(readHosts().hosts).filter(([, host]) => host.key && expandHome(host.key) === key).map(([name]) => name);
    process.stdout.write(`key      ${key}
public   ${readFileSync(`${key}.pub`, 'utf8').trim()}
used by  ${users.length > 0 ? users.join(', ') : 'no saved host yet'}
`);
    return;
  }
  if (sub === 'install') {
    const name = parsed.positionals[1];
    if (!name) fail('usage: edge key install <name>');
    validateName('host', name);
    if (!(await installKeyWithPassword(name, parsed))) process.exit(1);
    process.stdout.write(`Next: qp-tunnel-cli edge check ${name}\n`);
    return;
  }
  fail(`unknown edge key command: ${sub} (show, install)`);
}

// ---------- edge setup: the whole way, one question at a time ----------

const useColor = (): boolean => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const bold = (text: string): string => (useColor() ? `\x1b[1m${text}\x1b[0m` : text);
const dim = (text: string): string => (useColor() ? `\x1b[2m${text}\x1b[0m` : text);

/** Asks until the answer passes the check; Enter takes the default. */
async function promptValue(label: string, def: string | undefined, check?: (value: string) => string | undefined, optional = false): Promise<string> {
  for (;;) {
    const answer = (await ask(`  ${label}${def ? ` ${dim(`[${def}]`)}` : optional ? ` ${dim('[none]')}` : ''}: `)).trim();
    const value = answer || def || '';
    if (!value) {
      if (optional) return '';
      process.stderr.write('  needs a value\n');
      continue;
    }
    const problem = check?.(value);
    if (problem) {
      process.stderr.write(`  ${problem}\n`);
      continue;
    }
    return value;
  }
}

async function askYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  for (;;) {
    const answer = (await ask(`  ${question} ${dim(defaultYes ? '[Y/n]' : '[y/N]')} `)).trim().toLowerCase();
    if (!answer) return defaultYes;
    if (['y', 'yes'].includes(answer)) return true;
    if (['n', 'no'].includes(answer)) return false;
  }
}

async function promptChoice(label: string, choices: Array<[string, string]>, defaultIndex: number): Promise<number> {
  const width = Math.max(...choices.map(([title]) => title.length));
  choices.forEach(([title, detail], index) => process.stdout.write(`    ${index + 1}) ${title.padEnd(width)}  ${dim(detail)}\n`));
  const answer = await promptValue(label, String(defaultIndex + 1), (value) => (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= choices.length ? undefined : `pick 1-${choices.length}`));
  return Number(answer) - 1;
}

function emptyArgs(positionals: string[] = [], options: Array<[string, string | true]> = []): ParsedArgs {
  return { positionals, options: new Map(options), lists: new Map(), passthrough: [] };
}

/** The edge home, created with sudo when its parent is not writable (asks first). */
async function ensureHomeInteractive(): Promise<string> {
  const home = edgeHome();
  if (existsSync(home) && homeWritable(home)) {
    process.stdout.write(`  edge home   ${home} ${dim('(exists)')}\n`);
    return home;
  }
  if (!existsSync(home)) {
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      process.stdout.write(`  edge home   ${home} ${dim('(created)')}\n`);
      return home;
    } catch {
      // falls through to sudo
    }
  }
  const user = userInfo().username;
  const args = existsSync(home) ? ['chown', user, home] : ['install', '-d', '-m', '700', '-o', user, home];
  process.stdout.write(`  The edge home ${home} holds keys and the push ledger; it lives outside home directories and Git.\n`);
  if (!(await askYesNo(`Run: sudo ${args.join(' ')}?`, true))) fail(`stopped: create it yourself (sudo ${args.join(' ')}) or set QP_EDGE_HOME`, 1);
  const result = spawnSync(process.env.QP_EDGE_SUDO || 'sudo', args, { stdio: 'inherit' });
  if (result.status !== 0 || !homeWritable(home)) fail(`could not prepare ${home}`, 1);
  process.stdout.write(`  edge home   ${home} ${dim('(created)')}\n`);
  return home;
}

async function setupOrigin(): Promise<string> {
  const current = readOrigin();
  if (current.source === 'QP_EDGE_ORIGIN' && current.name) {
    process.stdout.write(`  origin      ${current.name} ${dim('(QP_EDGE_ORIGIN in this shell)')}\n`);
    return current.name;
  }
  process.stdout.write(`  ${dim('Each Internal machine that pushes has a name; edge hosts record it as the one managing what it pushed.')}\n`);
  const file = join(edgeHome(), 'origin');
  const saved = existsSync(file) ? readFileSync(file, 'utf8').split('\n')[0].trim() : undefined;
  const name = await promptValue('Name of this machine (origin)', current.name, checkOriginName);
  if (saved && saved !== name) {
    process.stdout.write(`  Hosts record ${saved} as the origin of what this machine pushed; after a rename they refuse pushes from ${name} until --take-over.\n`);
    if (!(await askYesNo(`Rename this origin from ${saved} to ${name}?`, false))) return saved;
  }
  if (saved !== name) writeFileSync(file, `${name}\n`, { mode: 0o600 });
  return name;
}

async function setupHost(origin: string): Promise<[string, EdgeHost]> {
  const data = readHosts();
  const entries = Object.entries(data.hosts);
  const n = trailingNumber(origin);
  const suggested = n !== undefined ? `domestic${String(n).padStart(2, '0')}` : 'domestic01';
  const choices: Array<[string, string]> = [
    ...entries.map(([name, host]) => [name, `${host.user}@${host.host}:${host.port}${host.jump ? ` via ${host.jump}` : ''}${host.role ? `, ${host.role}` : ''}`] as [string, string]),
    ['add a new host', 'saved in the hosts file; no passwords, only the key path'],
  ];
  const preferred = entries.findIndex(([name]) => name === suggested);
  const pick = await promptChoice('Edge host', choices, preferred >= 0 ? preferred : choices.length - 1);
  if (pick < entries.length) return entries[pick];

  let fresh = suggested;
  for (let next = (trailingNumber(suggested) ?? 0) + 1; data.hosts[fresh]; next += 1) fresh = `domestic${String(next).padStart(2, '0')}`;
  const name = await promptValue('Name', fresh, (value) => (!namePattern.test(value) ? 'letters, digits, . _ -' : data.hosts[value] ? `${value} is already saved; pick it from the list` : undefined));
  const address = await promptValue('Public address (IP or DNS name)', undefined, (value) => (/^[A-Za-z0-9.:-]+$/.test(value) ? undefined : 'an IP address or a DNS name'));
  const user = await promptValue('SSH user', 'root', (value) => (/^[A-Za-z0-9._-]+$/.test(value) ? undefined : 'not a user name'));
  const port = await promptValue('SSH port', '22', portProblem);
  const keyDefault = ['~/.ssh/id_ed25519', '~/.ssh/id_ecdsa', '~/.ssh/id_rsa'].find((key) => existsSync(expandHome(key)));
  const originKey = existsSync(originKeyPath()) ? originKeyPath() : undefined;
  const method = await promptChoice(`How do you log in to ${name} now`, [
    ['password', `typed once into ssh's own prompt (not kept); this machine's edge key is put there and used from then on`],
    ['key file', 'an SSH private key on this machine that already works there'],
  ], keyDefault || originKey ? 1 : 0);
  let key = '';
  if (method === 1) {
    key = await promptValue('SSH private key', originKey ?? keyDefault, (value) => (existsSync(expandHome(value)) ? undefined : `${value} does not exist on this machine`));
  }
  const jump = await promptValue('Jump host (a saved name or user@host[:port])', undefined, undefined, true);
  const role = await promptValue('Role', 'domestic', (value) => (namePattern.test(value) ? undefined : 'letters, digits, . _ -'));
  addHost(emptyArgs([name], [
    ['host', address], ['user', user], ['port', port], ['role', role], ['from-setup', true],
    ...(key ? [['key', key] as [string, string]] : []), ...(jump ? [['jump', jump] as [string, string]] : []),
  ]));
  if (method === 0 && !(await installKeyWithPassword(name, emptyArgs()))) {
    fail(`could not log in to ${name} with its password. ${name} is saved; run edge setup again after fixing it`, 1);
  }
  return [name, readHosts().hosts[name]];
}

async function setupWizard(parsed: ParsedArgs): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail('edge setup asks questions, so it needs a terminal. Without one, run the commands it runs: edge add, edge link init, edge push, edge link up, edge link check (edge help)');
  }
  const total = 8;
  let current = 0;
  const step = (title: string) => {
    current += 1;
    process.stdout.write(`\n${bold(`[${current}/${total}] ${title}`)}\n`);
  };
  process.stdout.write(`${bold('qp-tunnel-cli edge setup')}: connect an edge host to this machine, step by step.
Defaults are in ${dim('[brackets]')}; Enter takes them. Ctrl-C stops; finished steps stay done and the next run picks them up.
`);

  step('Tools on this machine');
  await ensureLocalTools(pushTools(), parsed);
  process.stdout.write(`  ${pushTools().map((tool) => basename(tool.command)).join(', ')} ${dim('found')}\n`);

  step('Edge home and the name of this machine');
  await ensureHomeInteractive();
  const origin = await setupOrigin();

  step('Edge host');
  const [name, host] = await setupHost(origin);

  step(`Look at ${name} (read-only)`);
  let probe = probeSsh(name);
  if (!probe.ok && probe.auth) {
    process.stdout.write(`  ${name} refuses this machine's key: ${probe.message}\n`);
    if (await askYesNo(`Log in once with ${name}'s password to put this machine's edge key there?`, true)) {
      if (await installKeyWithPassword(name, parsed)) probe = probeSsh(name);
    }
  }
  if (!probe.ok) {
    fail(`${name} cannot be reached over SSH (${probe.message}). Check the address, user, key and that TCP ${readHosts().hosts[name]?.port ?? host.port} is open, then run edge setup again`, 1);
  }
  const [status] = await collectStatus(emptyArgs([name]), option(parsed, 'root') ?? defaultRoot, false);
  if (!status?.reachable) {
    fail(`${name} cannot be reached over SSH (${status?.error ?? 'no answer'}). Check the address, user, key and that TCP ${host.port} is open, then run edge setup again`, 1);
  }
  process.stdout.write(`  ${status.host?.os ?? ''}\n  ${dim(`${status.host?.access ?? ''} ${status.host?.facts ?? ''}`.trim())}\n`);
  const edgeRows = status.rows.filter((row) => row.kind === 'edge');
  for (const row of edgeRows) process.stdout.write(`  already there: ${row.name} ${row.version} ${row.state} ${dim(row.detail)}\n`);
  const foreign = edgeRows.filter((row) => detailField(row.detail, 'pushed-by') === 'other');
  if (foreign.length > 0) {
    fail(`${name} runs components another tool deployed (${foreign.map((row) => row.name).join(', ')}), so it is not a new machine. edge setup stops here; see --shared-host in edge help`, 1);
  }

  step('Stack');
  const stacks = listStacks();
  const stackIndex = await promptChoice('Stack', stacks.map((stack) => [stack.name, stack.manifest.STACK_SUMMARY ?? ''] as [string, string]),
    Math.max(0, stacks.findIndex((stack) => stack.name === 'wg-nginx')));
  const stack = stacks[stackIndex];

  let link: LinkInfo | undefined;
  let replacedLink: LinkInfo | undefined;
  if (stack.name === 'wg-nginx') {
    step('Tunnel (the shape of the Launcher\'s mx-domestic / mx-internal-svc)');
    link = readLink(name);
    if (link) {
      process.stdout.write(`  ${name} already has a link from this origin:\n${describeLink(link, true).split('\n').filter((line) => line && !line.includes('routes ')).map((line) => `  ${line}`).join('\n')}\n`);
      if (!(await askYesNo('Use this link?', true))) {
        if (!(await askYesNo(`Make a new link to ${name}? The current files are moved to ${join(edgeHome(), 'replaced')}/, not deleted`, true))) fail('stopped; nothing was changed', 1);
        replacedLink = link;
        link = undefined;
      }
    }
    if (!link) {
      const input = await promptLinkInput(name, host, origin, {});
      const plan = resolveLinkPlan(name, host, input);
      if (typeof plan === 'string') fail(plan);
      if (replacedLink) setLinkAside(name);
      link = writeLink(plan, origin);
      if (replacedLink) retireOldInterface(replacedLink, link);
      process.stdout.write(`\n${describeLink(link, localRouteClashes(plan.subnet, allLinks().map((other) => other.localInterface)).checked)}`);
    }
  } else {
    step('State files');
    const dir = defaultStateDir(name, stack.name);
    ensureHome();
    mkdirSync(stateRoot(), { recursive: true, mode: 0o700 });
    initStackState(stack, dir, name);
    const required = (stack.manifest.STACK_STATE_REQUIRED ?? '').split(/\s+/).filter(Boolean);
    for (;;) {
      await ask(`  Fill in the files in ${dir}, then press Enter `);
      const files = listFiles(dir);
      const missing = required.filter((entry) => !files.some((file) => file === entry || file.startsWith(`${entry}/`)));
      if (missing.length === 0) break;
      process.stderr.write(`  still missing: ${missing.join(', ')}\n`);
    }
  }

  step(`Push ${stack.name} to ${name}`);
  const ports = stack.name === 'wg-nginx' && link ? `${link.port}/udp${stack.manifest.STACK_PORTS?.includes('80/tcp') ? ' (and 80/tcp, 443/tcp once there are nginx sites)' : ''}` : stack.manifest.STACK_PORTS || '-';
  await ask(`  The cloud security group of ${name} must allow ${ports}. Press Enter when it does `);
  await push(emptyArgs([name], [['stack', stack.name], ['from-setup', true]]));

  if (link) {
    step('This side of the tunnel');
    const boot = await askYesNo(`Start ${link.localInterface} at boot (systemctl enable)?`, true);
    const local = await bringLinkUp(link, boot, parsed);
    if (!checkBothEnds(link, local)) {
      process.stdout.write(`\n${linkUpAdvice(link)}\n`);
      process.exit(1);
    }
    process.stdout.write(`
${bold('Done.')} ${name} runs wg-nginx, managed from ${origin}; the tunnel is up (${planOf(link.subnet)?.name ?? 'custom'} plan, ${link.subnet}):
  ${name} ${link.relayIp} (${link.relayInterface})  <->  this machine ${link.localIp} (${link.localInterface})
Next:
  sites   put <name>.conf in ${defaultStateDir(name, stack.name)}/nginx/ with proxy_pass http://${link.localIp}:80;
          (this machine's host-nginx must listen on ${link.localIp}), then: qp-tunnel-cli edge push ${name} --stack wg-nginx --yes
  look    qp-tunnel-cli edge link check ${name}    qp-tunnel-cli edge status ${name} --health    qp-tunnel-cli edge relations
`);
    return;
  }
  step(`Check ${name}`);
  const [health] = await collectStatus(emptyArgs([name]), option(parsed, 'root') ?? defaultRoot, true);
  const row = health?.rows.find((candidate) => candidate.kind === 'edge' && candidate.name === stack.name);
  process.stdout.write(`  ${row ? `${row.name} ${row.version} ${row.state} ${dim(row.detail)}` : `UNKNOWN: ${health?.error ?? 'no status row'}`}\n`);
  process.stdout.write(`\n${bold('Done.')} Look again: qp-tunnel-cli edge status ${name} --health    qp-tunnel-cli edge relations\n`);
}

// ---------- stacks ----------

interface StackInfo {
  name: string;
  dir: string;
  manifest: Record<string, string>;
}

function readManifest(file: string): Record<string, string> {
  const manifest: Record<string, string> = {};
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    manifest[match[1]] = value;
  }
  return manifest;
}

function listStacks(): StackInfo[] {
  if (!existsSync(stacksDir)) return [];
  return readdirSync(stacksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(stacksDir, entry.name, 'stack.env')))
    .map((entry) => ({ name: entry.name, dir: join(stacksDir, entry.name), manifest: readManifest(join(stacksDir, entry.name, 'stack.env')) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function findStack(name: string): StackInfo {
  const stack = listStacks().find((candidate) => candidate.name === name);
  if (!stack) fail(`no stack named ${name}. Stacks: ${listStacks().map((candidate) => candidate.name).join(', ') || '(none)'}`);
  return stack;
}

function vendorSource(file: string): string | undefined {
  if (file.split('/').includes('..') || file.startsWith('/')) return undefined;
  return [join(edgeResources, 'vendor', file), join(repoRoot, file)].find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

function stacksCommand(parsed: ParsedArgs): void {
  const name = parsed.positionals[0];
  if (!name) {
    const stacks = listStacks();
    if (flag(parsed, 'json')) {
      process.stdout.write(`${JSON.stringify(stacks.map(({ name: stackName, manifest }) => ({ name: stackName, ...manifest })), null, 2)}\n`);
      return;
    }
    printTable(['STACK', 'OS', 'PORTS', 'SUMMARY'], stacks.map((stack) => [
      stack.name, stack.manifest.STACK_OS ?? 'any', stack.manifest.STACK_PORTS ?? '-', stack.manifest.STACK_SUMMARY ?? '',
    ]));
    process.stdout.write(`\nDetails: qp-tunnel-cli edge stacks <stack>    State template: qp-tunnel-cli edge stacks <stack> --init <dir>\n`);
    return;
  }
  const stack = findStack(name);
  const initDir = option(parsed, 'init');
  if (initDir) {
    initStackState(stack, resolve(expandHome(initDir)));
    return;
  }
  const m = stack.manifest;
  const vendor = (m.STACK_VENDOR ?? '').split(/\s+/).filter(Boolean);
  const example = join(stack.dir, 'state.example');
  process.stdout.write(`${stack.name}: ${m.STACK_SUMMARY ?? ''}
  directory   ${stack.dir}
  os          ${m.STACK_OS || 'any'}${m.STACK_SYSTEMD === '1' ? ' (systemd required)' : ''}
  installs    ${m.STACK_INSTALLS || 'nothing'}
  ports       ${m.STACK_PORTS || '-'}
  state       ${m.STACK_STATE_REQUIRED || 'nothing required'}
  images      ${m.STACK_IMAGES || '-'}
  vendor      ${vendor.length === 0 ? '-' : vendor.map((file) => `${file}${vendorSource(file) ? '' : ' (MISSING)'}`).join('\n              ')}
  template    ${existsSync(example) ? listFiles(example).join(', ') : '-'}${m.STACK_STATE_TEMPLATES ? `, ${m.STACK_STATE_TEMPLATES.split(/\s+/).map((pair) => pair.split('=')[0]).join(', ')}` : ''}

Start:  qp-tunnel-cli edge state init <host> --stack ${stack.name}   (in this origin's edge home, ${stateRoot()}/<host>/${stack.name})
        or anywhere: qp-tunnel-cli edge stacks ${stack.name} --init <dir>, then push with --state-dir <dir>
Push:   qp-tunnel-cli edge push <host> --stack ${stack.name} --dry-run
`);
}

function initStackState(stack: StackInfo, dir: string, forHost?: string): void {
  const example = join(stack.dir, 'state.example');
  const files: Array<[string, string]> = existsSync(example) ? listFiles(example).map((file) => [file, join(example, file)]) : [];
  for (const pair of (stack.manifest.STACK_STATE_TEMPLATES ?? '').split(/\s+/).filter(Boolean)) {
    const [target, source] = pair.split('=');
    const resolved = source ? vendorSource(source) : undefined;
    if (!target || !resolved) fail(`stack ${stack.name}: template ${pair} cannot be resolved`, 1);
    files.push([target, resolved]);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let written = 0;
  for (const [rel, source] of files) {
    const target = join(dir, rel);
    if (existsSync(target)) {
      process.stdout.write(`kept     ${rel} (already there)\n`);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(source, target);
    chmodSync(target, 0o600);
    written += 1;
    process.stdout.write(`written  ${rel}\n`);
  }
  if (stack.manifest.STACK_STATE_HINT) process.stdout.write(`\nAlso needed: ${stack.manifest.STACK_STATE_HINT.replace('<host>', forHost ?? '<host>')}\n`);
  process.stdout.write(forHost
    ? `\n${written} file(s) in ${dir}. Fill them in. Then (this directory is used without --state-dir):
  qp-tunnel-cli edge push ${forHost} --stack ${stack.name}${basename(dir) === stack.name ? '' : ` --component ${basename(dir)}`} --dry-run
`
    : `\n${written} file(s) in ${dir}. Fill them in; keep this directory out of Git. Then:
  qp-tunnel-cli edge push <host> --stack ${stack.name} --state-dir ${dir} --dry-run
`);
  warnIfTracked(dir);
}
