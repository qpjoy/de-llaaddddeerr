import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface WgCliContext {
  isRoot: () => boolean;
  sudoSelf: (cliArgs: string[]) => never;
}

type Role = 'server' | 'client';

const packageRoot = resolve(__dirname, '..');
const scriptCandidates = [
  resolve(packageRoot, 'resources/wireguard.sh'),
  resolve(packageRoot, '../../../scripts/wireguard.sh'),
];

const serverOnlyCommands = new Set([
  'preflight',
  'install',
  'create',
  'list',
  'revoke',
  'rotate-port',
]);
const clientOnlyCommands = new Set(['enroll']);
const sharedCommands = new Set([
  'up',
  'start',
  'down',
  'stop',
  'restart',
  'status',
  'logs',
  'uninstall',
]);
const unprivilegedCommands = new Set(['status', 'logs']);

export async function runWgCli(args: string[], ctx: WgCliContext): Promise<void> {
  const command = args[0] ?? 'help';
  if (command === 'help' || command === '--help' || command === '-h') {
    wgHelp();
    return;
  }

  if (!serverOnlyCommands.has(command) && !clientOnlyCommands.has(command) && !sharedCommands.has(command)) {
    process.stderr.write(`Unknown wg command: ${command}\n\n`);
    wgHelp();
    process.exit(1);
  }

  const { role, forwardedArgs } = resolveRole(command, args.slice(1));
  if (process.platform !== 'linux') {
    process.stderr.write('Managed WireGuard server and enrollment commands target Linux hosts.\n');
    process.exit(1);
  }

  if (!ctx.isRoot() && !unprivilegedCommands.has(command)) {
    ctx.sudoSelf(['wg', ...args]);
  }

  runScript(resolveScript(), [command, ...forwardedArgs], role);
}

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
      process.stderr.write(`wg ${command} is a server command; --client does not apply.\n`);
      process.exit(1);
    }
    return { role: 'server', forwardedArgs };
  }

  if (clientOnlyCommands.has(command)) {
    if (explicit === 'server') {
      process.stderr.write(`wg ${command} is a spoke command; --server does not apply.\n`);
      process.exit(1);
    }
    return { role: 'client', forwardedArgs };
  }

  return { role: explicit ?? detectInstalledRole(command, instance), forwardedArgs };
}

function assignRole(current: Role | undefined, next: Role): Role {
  if (current && current !== next) {
    process.stderr.write('Pass either --server or --client, not both.\n');
    process.exit(1);
  }
  return next;
}

function detectInstalledRole(command: string, instance: string): Role {
  const serverInstalled = existsSync(`/etc/qp-wireguard/server/${instance}/server.env`);
  const clientInstalled = existsSync(`/etc/qp-wireguard/client/${instance}/client.env`);
  if (serverInstalled && clientInstalled) {
    process.stderr.write(
      `Both WireGuard roles are installed for instance "${instance}".\n` +
        `Select one: qp-tunnel-cli wg ${command} --server | --client\n`,
    );
    process.exit(1);
  }
  if (serverInstalled) return 'server';
  if (clientInstalled) return 'client';
  process.stderr.write(
    `No managed WireGuard instance "${instance}" is installed. Pass --server/--client or install/enroll it first.\n`,
  );
  process.exit(1);
}

function resolveScript(): string {
  for (const candidate of scriptCandidates) {
    if (existsSync(candidate)) return candidate;
  }
  process.stderr.write(
    `Could not find wireguard.sh. Expected ${scriptCandidates[0]} in the npm package.\n`,
  );
  process.exit(1);
}

function runScript(script: string, scriptArgs: string[], role: Role): never {
  const result = spawnSync('bash', [script, ...scriptArgs], {
    stdio: 'inherit',
    env: { ...process.env, QP_WG_ROLE: role },
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

function wgHelp(): void {
  process.stdout.write(`QPJoy managed WireGuard global VPN

Oversea/AWS server:
  qp-tunnel-cli wg preflight --server [--subnet 100.127.50.0/24]
  qp-tunnel-cli wg install --host <AWS-EIP> [--subnet CIDR] [--dns DNS-LIST]
                           [--port PORT]
                           [--port-range 20000-20100] [--instance mx]
  qp-tunnel-cli wg create internal-01 [--ip 100.127.50.10] [--dns DNS-LIST]
  qp-tunnel-cli wg list | revoke internal-01
  qp-tunnel-cli wg rotate-port [--port PORT | --port-range 20000-20100]

Spoke/internal server:
  qp-tunnel-cli wg enroll --file internal-01.conf [--force]

Both:
  qp-tunnel-cli wg up | down | restart | status | logs | uninstall
  --instance NAME   Isolates interfaces, state and services; default "mx".
  --server/--client Selects the role when both exist on one host.

The default is 100.127.50.0/24; 100.127.100.0/24 is another suggested start.
100.128.0.0/16 is public space, not RFC 6598 space, and is rejected.

Without a configured range, rotate-port increments the current UDP port by one.
With --port-range it selects the next free port in the range; --port selects an
exact port. It updates the live listener and issued profiles without changing
keys. Spokes change their Endpoint port manually or re-enroll an updated profile.

Generated profiles default to DNS = 1.1.1.1, 8.8.8.8; pass --dns with a quoted,
comma-separated IPv4 list to override it. AllowedIPs is 0.0.0.0/0, ::/0. The
managed server provides IPv4 egress; ::/0 prevents native IPv6 from bypassing
the tunnel rather than providing IPv6 egress.
`);
}
