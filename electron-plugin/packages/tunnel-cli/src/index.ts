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

import { runHdoCli } from './hdo';

const args = process.argv.slice(2);
const packageRoot = resolve(__dirname, '..');
const bundledClientScript = resolve(packageRoot, 'resources/mihomo-client.sh');
const repoClientScript = resolve(packageRoot, '../../../scripts/mihomo-client.sh');
const defaultInstallTarget = '/usr/local/bin/mihomo-client';
const defaultMihomoConfigFile = '/etc/mihomo-client/config.yaml';
const defaultNoProxyEntries = [
  'localhost',
  '127.0.0.1',
  '::1',
  'postgres',
  'market',
  'db',
  'redis',
  'host.docker.internal',
  'docker.for.mac.host.internal',
  'docker.for.win.localhost',
  'kubernetes.docker.internal',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '100.88.0.0/16',
  '100.89.0.0/16',
  '100.90.0.0/16',
  '.local',
];

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
  'upgrade-systemd',
  'server-on',
  'server-off',
  'egress-on',
  'egress-off',
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
  qp-tunnel-cli hdo enroll --server-url https://domestic.example.com --username user
  qp-tunnel-cli <mihomo-client command> [options]
  qp-tunnel-cli -- <command> [args...]
  qp-tunnel-cli <command-path> [args...]

Common commands:
  qp-tunnel-cli install --url http://IP:3434/peer_user01.mihomo.yaml --user download --password pass
  qp-tunnel-cli status
  qp-tunnel-cli start
  qp-tunnel-cli server-on
  qp-tunnel-cli tun-on
  qp-tunnel-cli tun-off
  qp-tunnel-cli update-subscription
  qp-tunnel-cli hdo status
  qp-tunnel-cli uninstall --purge
  qp-tunnel-cli ./electron-server/scripts/manage.sh redeploy

The npm package distributes the Linux mihomo-client script and a cross-platform
HDO WireGuard enrollment command. Linux mihomo-client commands re-run through
sudo when needed, then execute the bundled shell script.

Unknown commands are executed with QPJoy proxy variables injected. Host commands
receive HTTP_PROXY=http://127.0.0.1:<mixed-port>; Docker/Compose build contexts
also receive container-facing variables such as MARKET_CONTAINER_HTTP_PROXY and
QP_TUNNEL_CONTAINER_HTTP_PROXY=http://host.docker.internal:<mixed-port>.

Install the script as a normal server command:
  sudo qp-tunnel-cli install-script
  sudo mihomo-client status

Enroll this machine into an HDO mesh:
  HDO_PASSWORD=... qp-tunnel-cli hdo enroll --server-url https://domestic.example.com --username user
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

function mixedPortFromConfig(): string {
  const explicit = process.env.QP_TUNNEL_MIXED_PORT || process.env.MIHOMO_MIXED_PORT;
  if (explicit && /^\d+$/.test(explicit)) {
    return explicit;
  }

  const configFile = process.env.MIHOMO_CONFIG_FILE || defaultMihomoConfigFile;
  if (!existsSync(configFile)) {
    process.stderr.write(
      `Mihomo config not found: ${configFile}\nRun: sudo qp-tunnel-cli install ... && sudo qp-tunnel-cli server-on\n`,
    );
    process.exit(1);
  }

  const content = readFileSync(configFile, 'utf8');
  const match = /^\s*mixed-port\s*:\s*(\d+)/m.exec(content);
  if (!match) {
    process.stderr.write(`Could not detect mixed-port from ${configFile}\n`);
    process.exit(1);
  }
  return match[1];
}

function mergeCsvValues(...values: Array<string | undefined>): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const value of values) {
    for (const item of (value || '').split(',')) {
      const trimmed = item.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      merged.push(trimmed);
    }
  }
  return merged.join(',');
}

function proxyEnvironment(): NodeJS.ProcessEnv {
  const port = mixedPortFromConfig();
  const hostProxy = `http://127.0.0.1:${port}`;
  const hostSocksProxy = `socks5://127.0.0.1:${port}`;
  const containerHost = process.env.QP_TUNNEL_CONTAINER_HOST || 'host.docker.internal';
  const containerProxy = `http://${containerHost}:${port}`;
  const noProxy = mergeCsvValues(
    process.env.NO_PROXY,
    process.env.no_proxy,
    defaultNoProxyEntries.join(','),
  );
  const containerNoProxy = mergeCsvValues(
    process.env.MARKET_CONTAINER_NO_PROXY,
    process.env.QP_TUNNEL_CONTAINER_NO_PROXY,
    noProxy,
  );

  return {
    ...process.env,
    HTTP_PROXY: hostProxy,
    HTTPS_PROXY: hostProxy,
    ALL_PROXY: hostSocksProxy,
    http_proxy: hostProxy,
    https_proxy: hostProxy,
    all_proxy: hostSocksProxy,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    npm_config_proxy: hostProxy,
    npm_config_https_proxy: hostProxy,
    npm_config_noproxy: noProxy,
    pnpm_config_proxy: hostProxy,
    pnpm_config_https_proxy: hostProxy,
    pnpm_config_noproxy: noProxy,
    QP_TUNNEL_MIXED_PORT: port,
    QP_TUNNEL_HOST_HTTP_PROXY: hostProxy,
    QP_TUNNEL_HOST_HTTPS_PROXY: hostProxy,
    QP_TUNNEL_HOST_ALL_PROXY: hostSocksProxy,
    QP_TUNNEL_CONTAINER_HTTP_PROXY: containerProxy,
    QP_TUNNEL_CONTAINER_HTTPS_PROXY: containerProxy,
    QP_TUNNEL_CONTAINER_NO_PROXY: containerNoProxy,
    CONTAINER_HTTP_PROXY: containerProxy,
    CONTAINER_HTTPS_PROXY: containerProxy,
    CONTAINER_NO_PROXY: containerNoProxy,
    BUILD_CONTAINER_HTTP_PROXY: containerProxy,
    BUILD_CONTAINER_HTTPS_PROXY: containerProxy,
    BUILD_CONTAINER_NO_PROXY: containerNoProxy,
    MARKET_CONTAINER_HTTP_PROXY: process.env.MARKET_CONTAINER_HTTP_PROXY || containerProxy,
    MARKET_CONTAINER_HTTPS_PROXY: process.env.MARKET_CONTAINER_HTTPS_PROXY || containerProxy,
    MARKET_CONTAINER_NO_PROXY: containerNoProxy,
  };
}

function runExternalCommand(commandArgs: string[]): never {
  if (commandArgs.length === 0) {
    process.stderr.write('Missing command after qp-tunnel-cli --\n');
    process.exit(1);
  }

  const [rawCommand, ...rawArgs] = commandArgs;
  const command = rawCommand === 'sudo' && !rawArgs.includes('-E') ? 'sudo' : rawCommand;
  const commandArgsWithSudoEnv =
    rawCommand === 'sudo' && !rawArgs.includes('-E') ? ['-E', ...rawArgs] : rawArgs;
  const result = spawnSync(command, commandArgsWithSudoEnv, {
    stdio: 'inherit',
    env: proxyEnvironment(),
  });
  exitFromSpawn(result);
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

  if (command === '--') {
    runExternalCommand(args.slice(1));
  }

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

  if (command === 'hdo' || command === 'hdo-enroll' || command === 'hdo-refresh') {
    const hdoArgs = command === 'hdo' ? args.slice(1) : [command.replace(/^hdo-/, ''), ...args.slice(1)];
    await runHdoCli(hdoArgs, { isRoot, sudoSelf });
    return;
  }

  const passthroughCommand = command === '--verbose' ? args[1] : command;
  if (passthroughCommand && clientCommands.has(passthroughCommand)) {
    runClientCommand(args);
  }

  if (args.length > 0) {
    runExternalCommand(args);
  }

  help();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
