#!/usr/bin/env node

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const packageRoot = resolve(__dirname, '..');
const bundledClientScript = resolve(packageRoot, 'resources/mihomo-client.sh');
const repoClientScript = resolve(packageRoot, '../../../scripts/mihomo-client.sh');
const defaultInstallTarget = '/usr/local/bin/mihomo-client';

const clientCommands = new Set([
  'setup',
  'install',
  'update-subscription',
  'start',
  'stop',
  'restart',
  'status',
  'logs',
  'enable',
  'disable',
  'proxy-on',
  'proxy-off',
  'tun-on',
  'tun-off',
  'ssh-proxy-on',
  'ssh-proxy-off',
  'daemon-proxy-on',
  'daemon-proxy-off',
  'docker-proxy-on',
  'docker-proxy-off',
  'run',
  'test',
  'print-env',
  'uninstall',
]);

function help(): void {
  process.stdout.write(`QPJoy Tunnel CLI

Usage:
  qp-tunnel-cli help
  qp-tunnel-cli install-script [--target /usr/local/bin/mihomo-client]
  qp-tunnel-cli script-path
  qp-tunnel-cli client-help
  qp-tunnel-cli <mihomo-client command> [options]

Common commands:
  qp-tunnel-cli install --url http://IP:3434/peer_user01.mihomo.yaml --user download --password pass
  qp-tunnel-cli status
  qp-tunnel-cli start
  qp-tunnel-cli tun-on
  qp-tunnel-cli tun-off
  qp-tunnel-cli update-subscription
  qp-tunnel-cli uninstall --purge

The npm package is a thin distributor for the Linux mihomo-client script. Client
commands re-run through sudo when needed, then execute the bundled shell script.

Install the script as a normal server command:
  sudo qp-tunnel-cli install-script
  sudo mihomo-client status
`);
}

function clientHelp(): never {
  runScriptWithoutSudo(['help']);
}

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function isRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function resolveClientScript(): string {
  if (existsSync(bundledClientScript)) {
    return bundledClientScript;
  }

  if (existsSync(repoClientScript)) {
    return repoClientScript;
  }

  process.stderr.write(
    `Could not find mihomo-client.sh. Expected ${bundledClientScript} in the npm package.\n`,
  );
  process.exit(1);
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

function sudoSelf(cliArgs: string[]): never {
  const result = spawnSync('sudo', ['-E', process.execPath, __filename, ...cliArgs], {
    stdio: 'inherit',
    env: process.env,
  });
  exitFromSpawn(result);
}

function runScriptWithoutSudo(scriptArgs: string[]): never {
  const result = spawnSync('bash', [resolveClientScript(), ...scriptArgs], {
    stdio: 'inherit',
    env: process.env,
  });
  exitFromSpawn(result);
}

function runClientCommand(scriptArgs: string[]): never {
  if (process.platform !== 'linux') {
    process.stderr.write(
      'mihomo-client commands target Linux systemd servers. Use this CLI on the server host.\n',
    );
    process.exit(1);
  }

  if (!isRoot()) {
    sudoSelf(scriptArgs);
  }

  runScriptWithoutSudo(scriptArgs);
}

function parseInstallScriptArgs(scriptArgs: string[]): string {
  let target = defaultInstallTarget;

  for (let index = 0; index < scriptArgs.length; index += 1) {
    const arg = scriptArgs[index];
    if (arg === '--target') {
      const value = scriptArgs[index + 1];
      if (!value) {
        process.stderr.write('Missing value for --target.\n');
        process.exit(1);
      }
      target = value;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`Usage:
  qp-tunnel-cli install-script [--target /usr/local/bin/mihomo-client]

Copies the bundled mihomo-client.sh to the target path and chmods it 755.
`);
      process.exit(0);
    } else {
      process.stderr.write(`Unknown install-script option: ${arg}\n`);
      process.exit(1);
    }
  }

  return resolve(target);
}

function isPermissionError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EACCES'
  );
}

function installClientScript(scriptArgs: string[]): void {
  const target = parseInstallScriptArgs(scriptArgs);
  const source = resolveClientScript();

  try {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    chmodSync(target, 0o755);
  } catch (error) {
    if (!isRoot() && isPermissionError(error)) {
      sudoSelf(['install-script', ...scriptArgs]);
    }
    throw error;
  }

  process.stdout.write(`Installed mihomo-client launcher to ${target}\n`);
}

async function printScriptPath(): Promise<void> {
  const script = resolveClientScript();
  try {
    await access(script, constants.R_OK);
  } catch {
    process.stderr.write(`Script is not readable: ${script}\n`);
    process.exit(1);
  }
  process.stdout.write(`${script}\n`);
}

async function main(): Promise<void> {
  const command = args[0] ?? 'help';

  if (command === 'help' || command === '--help' || command === '-h') {
    help();
    return;
  }

  if (command === 'version' || command === '--version' || command === '-v') {
    process.stdout.write(`${version()}\n`);
    return;
  }

  if (command === 'client-help') {
    clientHelp();
  }

  if (command === 'script-path') {
    await printScriptPath();
    return;
  }

  if (command === 'install-script') {
    installClientScript(args.slice(1));
    return;
  }

  const passthroughCommand = command === '--verbose' ? args[1] : command;
  if (passthroughCommand && clientCommands.has(passthroughCommand)) {
    runClientCommand(args);
  }

  process.stderr.write(`Unknown command: ${command}\n`);
  help();
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
