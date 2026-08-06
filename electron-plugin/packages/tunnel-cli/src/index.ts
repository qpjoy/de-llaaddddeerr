#!/usr/bin/env node

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { runHdoCli } from './hdo';
import { runH2iCli } from './h2i';

const args = process.argv.slice(2);
const packageRoot = resolve(__dirname, '..');
const bundledClientScript = resolve(packageRoot, 'resources/mihomo-client.sh');
const repoClientScript = resolve(packageRoot, '../../../scripts/mihomo-client.sh');
const defaultInstallTarget = '/usr/local/bin/mihomo-client';
const defaultMihomoConfigFile = '/etc/mihomo-client/config.yaml';
const defaultK8sImageNamespace = 'k8s.io';
const defaultK8sRuntimeImages = ['postgres:16-alpine', 'coredns/coredns:1.11.3', 'caddy:2.8.4-alpine'];
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
  'kubernetes.default.svc',
  '.cluster.local',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '169.254.169.254',
  '169.254.169.254/32',
  '100.100.100.200',
  '100.100.100.200/32',
  '100.64.0.0/10',
  '100.88.0.0/16',
  '100.89.0.0/16',
  '100.90.0.0/16',
  '10.88.0.0/16',
  '10.89.0.0/16',
  '10.90.0.0/16',
  '10.91.0.0/16',
  '.local',
  '.lan',
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
  'reload',
  'port',
  'listen',
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
  'docker-build-proxy',
  'run',
  'test',
  'print-env',
  'print-unset-env',
  'uninstall',
]);

function help(): void {
  process.stdout.write(`QPJoy Tunnel CLI

Usage:
  qp-tunnel-cli help
  qp-tunnel-cli install-script [--target /usr/local/bin/mihomo-client]
  qp-tunnel-cli script-path
  qp-tunnel-cli client-help
  qp-tunnel-cli k8s preload-images [--image postgres:16-alpine]
  qp-tunnel-cli hdo enroll --server-url https://domestic.example.com --username user
  qp-tunnel-cli h2i enroll --bootstrap-url https://h2i.example.com --username user
  qp-tunnel-cli h2i enroll --bootstrap-url https://h2i.example.com --anonymous
  qp-tunnel-cli <mihomo-client command> [options]
  qp-tunnel-cli -- <command> [args...]
  qp-tunnel-cli <command-path> [args...]

Common commands:
  qp-tunnel-cli install --url http://IP:3434/peer_user01.mihomo.yaml --user download --password pass
  qp-tunnel-cli install --url http://internal:18090/internal/v1/site-slots/oversea-main/subscriptions/hysteria2/oversea-main-internal.yaml
  qp-tunnel-cli install --file /opt/mx/current/qp-tunnel-cli/domestic-bootstrap-subscription.yaml
  qp-tunnel-cli status
  qp-tunnel-cli start
  qp-tunnel-cli egress-on
  qp-tunnel-cli egress-off
  qp-tunnel-cli docker-build-proxy on
  qp-tunnel-cli docker-build-proxy off
  eval "$(qp-tunnel-cli print-unset-env)"
  qp-tunnel-cli tun-on
  MIHOMO_TUN_ROUTE_EXCLUDE_ADDRESS=203.0.113.10/32 sudo -E qp-tunnel-cli tun-on
  qp-tunnel-cli tun-off
  qp-tunnel-cli k8s preload-images
  qp-tunnel-cli update-subscription
  qp-tunnel-cli reload
  qp-tunnel-cli port 7888
  qp-tunnel-cli listen on
  qp-tunnel-cli listen on 7890
  qp-tunnel-cli listen off
  qp-tunnel-cli hdo status
  qp-tunnel-cli h2i status
  qp-tunnel-cli uninstall --purge
  qp-tunnel-cli ./electron-server/scripts/manage.sh redeploy

The npm package distributes the Linux mihomo-client script and a cross-platform
HDO WireGuard enrollment command. Linux mihomo-client commands re-run through
sudo when needed, then execute the bundled shell script.

Unknown commands are executed with QPJoy proxy variables injected. Host commands
receive HTTP_PROXY=http://127.0.0.1:<mixed-port>; Docker/Compose build contexts
also receive container-facing variables such as MARKET_CONTAINER_HTTP_PROXY and
QP_TUNNEL_CONTAINER_HTTP_PROXY=http://host.docker.internal:<mixed-port>.

K8s/containerd hosts keep a separate image store from Docker. After tun-on or
egress-on makes Docker pulls work, preload runtime images into containerd:
  sudo qp-tunnel-cli tun-on
  sudo qp-tunnel-cli k8s preload-images
  sudo qp-tunnel-cli tun-off

tun-on uses server-safer defaults: Linux auto-redirect is off by default, local
and private networks bypass TUN, and the current SSH client IP is preserved.
Add public ingress sources with MIHOMO_TUN_ROUTE_EXCLUDE_ADDRESS or
/etc/mihomo-client/tun-route-exclude-addresses.txt before enabling tun-on.

Install the script as a normal server command:
  sudo qp-tunnel-cli install-script
  sudo mihomo-client status
  sudo mihomo-client egress-on

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
  const sudoEnvironment = [
    'H2I_BOOTSTRAP_URL',
    'MX_H2I_BOOTSTRAP_BASE_URL',
    'H2I_USERNAME',
    'H2I_PASSWORD',
    'H2I_ACCESS_TOKEN',
    'H2I_USER_ID',
  ].join(',');
  const sudoOptions = cliArgs[0] === 'h2i'
    ? [`--preserve-env=${sudoEnvironment}`]
    : ['-E'];
  const result = spawnSync('sudo', [...sudoOptions, process.execPath, __filename, ...cliArgs], {
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

  // Printing the unset lines touches nothing privileged, and prompting for a
  // sudo password inside `eval "$(...)"` would be both surprising and unusable.
  if (!isRoot() && scriptArgs[0] !== 'print-unset-env') {
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
      `Mihomo config not found: ${configFile}\nRun: sudo qp-tunnel-cli install ... && sudo qp-tunnel-cli egress-on\n`,
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

function commandAvailable(command: string): boolean {
  const result = spawnSync('sh', ['-c', `command -v ${command} >/dev/null 2>&1`], {
    stdio: 'ignore',
  });
  return result.status === 0;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function runStep(command: string, commandArgs: string[], dryRun = false): void {
  process.stdout.write(`+ ${[command, ...commandArgs].map(shellQuote).join(' ')}\n`);
  if (dryRun) {
    return;
  }

  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
    process.exit(1);
  }
  if (result.signal) {
    process.stderr.write(`Command terminated by signal ${result.signal}\n`);
    process.exit(1);
  }
  if ((result.status ?? 0) !== 0) {
    process.exit(result.status ?? 1);
  }
}

function commandSucceeds(command: string, commandArgs: string[]): boolean {
  const result = spawnSync(command, commandArgs, {
    stdio: 'ignore',
    env: process.env,
  });
  return !result.error && !result.signal && result.status === 0;
}

function splitImageList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

type K8sPreloadOptions = {
  dryRun: boolean;
  fromCluster: boolean;
  images: string[];
  namespace: string;
  pull: boolean;
};

function k8sHelp(): void {
  process.stdout.write(`Usage:
  qp-tunnel-cli k8s help
  qp-tunnel-cli k8s preload-images [options]

Options:
  --image <image>       Add one image. Can be repeated.
  --images <images>     Add comma- or space-separated images.
  --from-cluster        Include images referenced by current Kubernetes pods.
  --namespace <name>    containerd namespace. Default: ${defaultK8sImageNamespace}
  --no-pull             Import only images already present in Docker.
  --dry-run             Print commands without running them.

Default images used when no image options are provided and --from-cluster is not set:
  ${defaultK8sRuntimeImages.join(' ')}

The preload command pulls with Docker, saves each image, then imports it into
containerd's k8s.io namespace so kubelet can start pods without reaching the
remote registry itself. Run it after tun-on or egress-on on the K8s host.
`);
}

function parseK8sPreloadArgs(commandArgs: string[]): K8sPreloadOptions {
  let namespace = defaultK8sImageNamespace;
  let pull = true;
  let dryRun = false;
  let fromCluster = false;
  const images: string[] = [];

  for (let index = 0; index < commandArgs.length; index += 1) {
    const arg = commandArgs[index];
    if (arg === '--image') {
      const value = commandArgs[index + 1];
      if (!value) {
        process.stderr.write('Missing value for --image.\n');
        process.exit(1);
      }
      images.push(value);
      index += 1;
    } else if (arg === '--images') {
      const value = commandArgs[index + 1];
      if (!value) {
        process.stderr.write('Missing value for --images.\n');
        process.exit(1);
      }
      images.push(...splitImageList(value));
      index += 1;
    } else if (arg === '--namespace') {
      const value = commandArgs[index + 1];
      if (!value) {
        process.stderr.write('Missing value for --namespace.\n');
        process.exit(1);
      }
      namespace = value;
      index += 1;
    } else if (arg === '--no-pull') {
      pull = false;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--from-cluster') {
      fromCluster = true;
    } else if (arg === '--help' || arg === '-h') {
      k8sHelp();
      process.exit(0);
    } else {
      process.stderr.write(`Unknown k8s preload-images option: ${arg}\n`);
      process.exit(1);
    }
  }

  return {
    dryRun,
    fromCluster,
    images: dedupe(images),
    namespace,
    pull,
  };
}

function ensureK8sHostTools(dryRun: boolean, fromCluster: boolean): void {
  if (dryRun) {
    return;
  }

  const requiredCommands = fromCluster ? ['docker', 'ctr', 'kubectl'] : ['docker', 'ctr'];
  const missing = requiredCommands.filter((command) => !commandAvailable(command));
  if (missing.length > 0) {
    process.stderr.write(
      `Missing required command(s): ${missing.join(', ')}\nInstall Docker and containerd, then retry on the K8s host.\n`,
    );
    process.exit(1);
  }
}

function collectImagesFromContainerList(value: unknown, images: string[]): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const container of value) {
    if (
      typeof container === 'object' &&
      container !== null &&
      'image' in container &&
      typeof container.image === 'string'
    ) {
      images.push(container.image);
    }
  }
}

function collectClusterPodImages(dryRun: boolean): string[] {
  process.stdout.write('+ kubectl get pods -A -o json\n');
  if (dryRun) {
    return [];
  }

  const result = spawnSync('kubectl', ['get', 'pods', '-A', '-o', 'json'], {
    encoding: 'utf8',
    env: process.env,
  });
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
    process.exit(1);
  }
  if (result.signal) {
    process.stderr.write(`Command terminated by signal ${result.signal}\n`);
    process.exit(1);
  }
  if ((result.status ?? 0) !== 0) {
    process.stderr.write(result.stderr || 'kubectl get pods failed.\n');
    process.exit(result.status ?? 1);
  }

  const parsed = JSON.parse(result.stdout) as { items?: Array<{ spec?: Record<string, unknown> }> };
  const images: string[] = [];
  for (const item of parsed.items ?? []) {
    const spec = item.spec ?? {};
    collectImagesFromContainerList(spec.initContainers, images);
    collectImagesFromContainerList(spec.containers, images);
    collectImagesFromContainerList(spec.ephemeralContainers, images);
  }
  return dedupe(images);
}

function importDockerImageIntoContainerd(image: string, namespace: string, dryRun: boolean): void {
  const tempDir = dryRun ? '/tmp/qp-tunnel-cli-k8s-dry-run' : mkdtempSync(join(tmpdir(), 'qp-tunnel-cli-k8s-'));
  const archive = join(tempDir, 'image.tar');

  try {
    runStep('docker', ['save', image, '-o', archive], dryRun);
    runStep('ctr', ['-n', namespace, 'images', 'import', archive], dryRun);
  } finally {
    if (!dryRun) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

function preloadK8sImages(commandArgs: string[]): void {
  if (process.platform !== 'linux') {
    process.stderr.write('K8s/containerd image preload targets Linux servers. Run this on the K8s host.\n');
    process.exit(1);
  }

  if (!isRoot()) {
    sudoSelf(['k8s', 'preload-images', ...commandArgs]);
  }

  const options = parseK8sPreloadArgs(commandArgs);
  ensureK8sHostTools(options.dryRun, options.fromCluster);

  const clusterImages = options.fromCluster ? collectClusterPodImages(options.dryRun) : [];
  const images = dedupe([
    ...(options.images.length > 0 || options.fromCluster ? options.images : defaultK8sRuntimeImages),
    ...clusterImages,
  ]);
  if (images.length === 0) {
    process.stderr.write('No K8s images found to preload.\n');
    process.exit(1);
  }

  process.stdout.write(
    `Preloading ${images.length} image(s) into containerd namespace ${options.namespace}\n`,
  );

  for (const image of images) {
    process.stdout.write(`\nImage: ${image}\n`);
    const inDocker = !options.dryRun && commandSucceeds('docker', ['image', 'inspect', image]);
    if (!inDocker && options.pull) {
      runStep('docker', ['pull', image], options.dryRun);
    } else if (!inDocker && !options.pull) {
      process.stderr.write(`Docker image is missing and --no-pull was set: ${image}\n`);
      process.exit(1);
    }
    importDockerImageIntoContainerd(image, options.namespace, options.dryRun);
  }

  process.stdout.write('\nK8s/containerd image preload complete.\n');
}

function runK8sCommand(commandArgs: string[]): void {
  const subcommand = commandArgs[0] ?? 'help';

  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    k8sHelp();
    return;
  }

  if (subcommand === 'preload' || subcommand === 'preload-images' || subcommand === 'containerd-preload') {
    preloadK8sImages(commandArgs.slice(1));
    return;
  }

  process.stderr.write(`Unknown k8s command: ${subcommand}\n`);
  k8sHelp();
  process.exit(1);
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

  if (command === 'k8s') {
    runK8sCommand(args.slice(1));
    return;
  }

  if (command === 'hdo' || command === 'hdo-enroll' || command === 'hdo-refresh') {
    const hdoArgs = command === 'hdo' ? args.slice(1) : [command.replace(/^hdo-/, ''), ...args.slice(1)];
    await runHdoCli(hdoArgs, { isRoot, sudoSelf });
    return;
  }

  if (command === 'h2i' || command === 'h2i-enroll') {
    const h2iArgs = command === 'h2i' ? args.slice(1) : ['enroll', ...args.slice(1)];
    await runH2iCli(h2iArgs, { isRoot, sudoSelf });
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
