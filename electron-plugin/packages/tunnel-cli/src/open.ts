import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `qp-tunnel-cli open` - OpenVPN reverse access.
 *
 * Two roles share one verb because they are two ends of the same link:
 *
 *   server  an Oversea host that accepts spokes and can reach back into them
 *   client  a spoke, typically a restricted internal server, that dials out and
 *           receives one stable address without letting anything else about its
 *           networking change
 *
 * This module only resolves the role, validates the shape of the invocation and
 * re-runs itself through sudo. Every privileged action lives in the bundled
 * shell scripts so the exact same code path runs whether it was reached through
 * npm, through a site-slot artifact, or by hand on a host with no Node.
 */

export interface OpenCliContext {
  isRoot: () => boolean;
  sudoSelf: (cliArgs: string[]) => never;
}

type Role = 'server' | 'client';

const packageRoot = resolve(__dirname, '..');

const scriptCandidates = {
  server: [
    resolve(packageRoot, 'resources/openvpn-server.sh'),
    resolve(packageRoot, '../../../scripts/openvpn-server.sh'),
  ],
  client: [
    resolve(packageRoot, 'resources/openvpn-client.sh'),
    resolve(packageRoot, '../../../scripts/openvpn-client.sh'),
  ],
} satisfies Record<Role, string[]>;

/** Commands that only ever make sense on the Oversea server. */
const serverOnlyCommands = new Set([
  'install',
  'create',
  'reissue',
  'list',
  'revoke',
  'reachable',
]);

/** Commands that only ever make sense on a spoke. */
const clientOnlyCommands = new Set(['enroll', 'egress', 'doctor', 'routes']);

/** Commands both roles implement; the role is resolved from local state. */
const sharedCommands = new Set([
  'preflight',
  'up',
  'start',
  'down',
  'stop',
  'restart',
  'status',
  'logs',
  'uninstall',
]);

/** Commands that read nothing privileged and must not prompt for a password. */
const unprivilegedCommands = new Set(['preflight', 'status', 'list', 'logs', 'routes', 'doctor']);

const serverStateRoot = '/etc/qp-openvpn-server';
const clientStateRoot = '/etc/qp-openvpn';

export async function runOpenCli(args: string[], ctx: OpenCliContext): Promise<void> {
  const command = args[0] ?? 'help';

  if (command === 'help' || command === '--help' || command === '-h') {
    openHelp();
    return;
  }

  if (!serverOnlyCommands.has(command) && !clientOnlyCommands.has(command) && !sharedCommands.has(command)) {
    process.stderr.write(`Unknown open command: ${command}\n\n`);
    openHelp();
    process.exit(1);
  }

  const { role, forwardedArgs } = resolveRole(command, args.slice(1));
  assertPlatformSupported(role);

  const script = resolveScript(role);

  if (!ctx.isRoot() && !unprivilegedCommands.has(command)) {
    ctx.sudoSelf(['open', ...args]);
  }

  runScript(script, [command, ...forwardedArgs]);
}

/**
 * Picks the role, and strips the explicit `--server` / `--client` selector so
 * the shell scripts never have to know it existed.
 */
function resolveRole(
  command: string,
  rest: string[],
): { role: Role; forwardedArgs: string[] } {
  const forwardedArgs: string[] = [];
  let explicit: Role | undefined;
  let instance = 'mx';

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--server') {
      explicit = assignRole(explicit, 'server');
      continue;
    }
    if (arg === '--client' || arg === '--spoke') {
      explicit = assignRole(explicit, 'client');
      continue;
    }
    if (arg === '--instance') {
      const value = rest[index + 1];
      if (!value) {
        process.stderr.write('Missing value for --instance.\n');
        process.exit(1);
      }
      instance = value;
    } else if (arg.startsWith('--instance=')) {
      instance = arg.slice('--instance='.length);
    }
    forwardedArgs.push(arg);
  }

  if (serverOnlyCommands.has(command)) {
    if (explicit === 'client') {
      process.stderr.write(`open ${command} is a server command; --client does not apply.\n`);
      process.exit(1);
    }
    return { role: 'server', forwardedArgs };
  }

  if (clientOnlyCommands.has(command)) {
    if (explicit === 'server') {
      process.stderr.write(`open ${command} is a spoke command; --server does not apply.\n`);
      process.exit(1);
    }
    return { role: 'client', forwardedArgs };
  }

  if (explicit) {
    return { role: explicit, forwardedArgs };
  }

  return { role: detectInstalledRole(command, instance), forwardedArgs };
}

function assignRole(current: Role | undefined, next: Role): Role {
  if (current && current !== next) {
    process.stderr.write('Pass either --server or --client, not both.\n');
    process.exit(1);
  }
  return next;
}

/**
 * A shared command such as `status` means different things on each end of the
 * link, so the role follows whichever side is actually installed here. A host
 * that is somehow both must say which one it meant.
 */
function detectInstalledRole(command: string, instance: string): Role {
  const serverInstalled = existsSync(`${serverStateRoot}/${instance}/server.env`);
  const clientInstalled = existsSync(`${clientStateRoot}/${instance}/client.conf`);

  if (serverInstalled && clientInstalled) {
    process.stderr.write(
      `Both an OpenVPN server and a spoke are installed for instance "${instance}".\n` +
        `Say which one you mean: qp-tunnel-cli open ${command} --server | --client\n`,
    );
    process.exit(1);
  }

  if (serverInstalled) return 'server';
  if (clientInstalled) return 'client';

  // Nothing installed yet. `preflight` is the command people run first, and on
  // a fresh host the spoke checks are the useful ones; `install` never reaches
  // here because it is server-only.
  return 'client';
}

function assertPlatformSupported(role: Role): void {
  if (process.platform === 'linux') {
    return;
  }

  if (role === 'server') {
    process.stderr.write(
      'The OpenVPN server targets Linux hosts. Run this on the Oversea server.\n',
    );
    process.exit(1);
  }

  if (process.platform !== 'darwin') {
    process.stderr.write(
      `OpenVPN spoke commands support Linux and macOS; this is ${process.platform}.\n`,
    );
    process.exit(1);
  }
}

function resolveScript(role: Role): string {
  for (const candidate of scriptCandidates[role]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  process.stderr.write(
    `Could not find openvpn-${role}.sh. Expected ${scriptCandidates[role][0]} in the npm package.\n`,
  );
  process.exit(1);
}

function runScript(script: string, scriptArgs: string[]): never {
  const result = spawnSync('bash', [script, ...scriptArgs], {
    stdio: 'inherit',
    env: process.env,
  });
  exitFromSpawn(result);
}

function exitFromSpawn(result: SpawnSyncReturns<Buffer>): never {
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
    process.exit(1);
  }
  if (result.signal) {
    process.stderr.write(`Command terminated by signal ${result.signal}\n`);
    process.exit(1);
  }
  process.exit(result.status ?? 0);
}

function openHelp(): void {
  process.stdout.write(`QPJoy OpenVPN reverse access

An Oversea server accepts spokes; a spoke dials out from inside a restricted
network and receives one stable address the Oversea host can reach back on.
The server pushes no routes, no gateway and no DNS, and the spoke connects with
route-nopull, so joining the link changes nothing else about its networking.

Oversea server:
  qp-tunnel-cli open preflight --server [--subnet 100.127.0.0/24]
  qp-tunnel-cli open install [--subnet CIDR] [--port PORT] [--proto udp|tcp]
                             [--host ADDR] [--port-range 20000-20100]
                             [--runtime auto|docker|host]
  qp-tunnel-cli open create internal-01 [--ip 100.127.0.10] [--oversea]
  qp-tunnel-cli open reissue internal-01
  qp-tunnel-cli open list
  qp-tunnel-cli open revoke internal-01
  qp-tunnel-cli open reachable

Spoke (internal server, or a Mac for testing):
  qp-tunnel-cli open preflight --file internal-01.ovpn
  qp-tunnel-cli open enroll --file internal-01.ovpn
  qp-tunnel-cli open doctor
  qp-tunnel-cli open routes
  qp-tunnel-cli open egress on [--mode cn-direct|full]
  qp-tunnel-cli open egress off

Both:
  qp-tunnel-cli open up | down | restart | status | logs | uninstall
  --instance NAME   Instance namespace, default "mx". Use one instance per
                    Oversea server so several links can coexist on one spoke.
  --server/--client Force the role when a host runs both ends.

Runtime selection on the Oversea host is automatic: when the qp-tunnel-cli
managed mx-oversea-hysteria2 stack is present, OpenVPN is deployed as a sibling
container on network_mode: host; otherwise it is installed on the host itself.
`);
}
