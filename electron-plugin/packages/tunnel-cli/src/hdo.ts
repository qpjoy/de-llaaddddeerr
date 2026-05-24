import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  generateWireGuardKeyPairWithCli,
  getDarwinWireGuardLaunchDaemonStatus,
  getWireGuardTunnelStatus,
  installDarwinWireGuardLaunchDaemon,
  renderHdoClientWireGuardConfig,
  resolveWireGuardConnectionRuntime,
  resolveWireGuardRuntime,
  setWireGuardTunnelState,
  type WireGuardConnectionRuntimeStatus,
  type WireGuardPeer,
  uninstallDarwinWireGuardLaunchDaemon,
} from '@qpjoy/electron-core-wireguard';

interface HdoCliContext {
  isRoot(): boolean;
  sudoSelf(args: string[]): never;
}

interface HdoClientState {
  serverUrl?: string;
  bearerToken?: string;
  refreshToken?: string;
  accessExpiresAt?: string;
  refreshExpiresAt?: string;
  username?: string;
  deviceId?: string;
  label?: string;
  interfaceName?: string;
  configPath?: string;
  installDir?: string;
  privateKey?: string;
  publicKey?: string;
  overlayIp?: string;
  directListener?: boolean;
  preferDirectPeers?: boolean;
  endpointHost?: string;
  listenPort?: number;
  lastManifestGeneration?: number;
  enrolledAt?: string;
  updatedAt?: string;
}

interface HdoEnrollOptions {
  serverUrl?: string;
  token?: string;
  tokenFile?: string;
  username?: string;
  password?: string;
  passwordFile?: string;
  deviceId?: string;
  label?: string;
  interfaceName: string;
  configPath?: string;
  stateFile?: string;
  installDir?: string;
  role: string;
  start: boolean;
  rotateKey: boolean;
  directListener: boolean;
  preferDirectPeers: boolean;
  publicEndpoint?: string;
  endpointHost?: string;
  listenPort?: number;
}

interface HdoAuthMaterial {
  accessToken: string;
  refreshToken?: string;
  accessExpiresAt?: string;
  refreshExpiresAt?: string;
  username?: string;
}

interface HdoCommandOptions {
  stateFile?: string;
  interfaceName?: string;
  configPath?: string;
  installDir?: string;
}

const defaultInterfaceName = 'hdo-internal';

export async function runHdoCli(args: string[], ctx: HdoCliContext): Promise<void> {
  const command = args[0] ?? 'help';
  const rest = args.slice(1);

  if (command === 'help' || command === '--help' || command === '-h') {
    hdoHelp();
    return;
  }

  if (process.platform === 'linux' && !ctx.isRoot()) {
    ctx.sudoSelf(['hdo', ...args]);
  }

  switch (command) {
    case 'enroll':
    case 'refresh':
      await enrollCommand(rest, command === 'refresh');
      return;
    case 'status':
      statusCommand(parseCommandOptions(rest));
      return;
    case 'down':
      await downCommand(parseCommandOptions(rest));
      return;
    default:
      process.stderr.write(`Unknown hdo command: ${command}\n\n`);
      hdoHelp();
      process.exitCode = 1;
  }
}

function hdoHelp(): void {
  process.stdout.write(`QPJoy HDO CLI

Usage:
  qp-tunnel-cli hdo enroll --server-url URL --username USER [options]
  qp-tunnel-cli hdo enroll --server-url URL --token TOKEN [options]
  qp-tunnel-cli hdo refresh [--server-url URL] [--username USER]
  qp-tunnel-cli hdo status [--interface NAME]
  qp-tunnel-cli hdo down [--interface NAME]

Enroll options:
  --server-url URL       HDO/electron-server base URL
  --username USER        Login username/email/phone
  --password PASS        Login password. Prefer HDO_PASSWORD or --password-file
  --password-file PATH   Read login password from a file
  --token TOKEN          Existing bearer token for the HDO API
  --token-file PATH      Read bearer token from a file
  --device-id ID         Stable device id. Default: hdo-<platform>-<hostname>
  --label LABEL          Device label. Default: <platform> <hostname>
  --interface NAME       WireGuard interface/config name. Default: hdo-internal
  --config-path PATH     WireGuard config path
  --install-dir PATH     WireGuard engine install/cache directory
  --state-file PATH      HDO client state file
  --role ROLE            Metadata role. Default: internal
  --direct-listener      Accept direct WireGuard peers from other HDO devices
  --try-direct-peers     Try direct HDO device peers from observed NAT endpoints
  --public-endpoint HOST:PORT
                         Publish this device as a direct peer endpoint
  --endpoint-host HOST   Direct peer endpoint host
  --listen-port PORT     Local WireGuard listen port for direct peers
  --rotate-key           Generate a new WireGuard keypair
  --no-start             Write config without starting the system tunnel

Environment:
  HDO_SERVER_URL / QPJOY_HDO_SERVER_URL
  HDO_USERNAME / QPJOY_HDO_USERNAME
  HDO_PASSWORD / QPJOY_HDO_PASSWORD
  HDO_TOKEN / QPJOY_HDO_TOKEN
  HDO_PUBLIC_ENDPOINT / QPJOY_HDO_PUBLIC_ENDPOINT

Examples:
  qp-tunnel-cli hdo enroll \\
    --server-url https://domestic.example.com \\
    --username user@example.com

  HDO_PASSWORD='...' qp-tunnel-cli hdo enroll \\
    --server-url https://domestic.example.com \\
    --username internal-i

Notes:
  Linux writes /etc/wireguard and enables wg-quick@<interface>.
  If Linux does not provide wg-quick@.service, this CLI installs a compatible
  systemd unit that uses the bundled WireGuard tools from npm.
  Use --direct-listener --public-endpoint HOST:PORT on reachable Internal
  machines. Use --try-direct-peers only when both devices are managed by this
  CLI/plugin and you accept NAT hole-punching fallback risk.
  macOS installs a LaunchDaemon and may prompt for an administrator password.
  Windows installs a WireGuard tunnel service and may show a UAC prompt.

Tip:
  If the Electron HDO plugin created the tunnel, stop it with:
  qp-tunnel-cli hdo down --interface hdo-client
`);
}

async function enrollCommand(args: string[], refreshOnly: boolean): Promise<void> {
  const options = parseEnrollOptions(args);
  const stateFile = resolveStateFile(options.stateFile);
  const previous = readState(stateFile);
  const interfaceName = sanitizeInterfaceName(options.interfaceName || previous.interfaceName || defaultInterfaceName);
  const configPath = resolveConfigPath(options.configPath || previous.configPath, interfaceName);
  const installDir = resolveInstallDir(options.installDir || previous.installDir);
  const serverUrl = normalizeBaseUrl(
    options.serverUrl ??
      process.env.HDO_SERVER_URL ??
      process.env.QPJOY_HDO_SERVER_URL ??
      previous.serverUrl,
  );
  const username =
    options.username ??
    process.env.HDO_USERNAME ??
    process.env.QPJOY_HDO_USERNAME ??
    previous.username;

  if (!serverUrl) {
    throw new Error('Missing --server-url or HDO_SERVER_URL.');
  }

  const auth = await resolveAuth(serverUrl, options, previous, username);
  const deviceId =
    options.deviceId ||
    previous.deviceId ||
    `hdo-${process.platform}-${sanitizeId(hostname())}`;
  const label = options.label || previous.label || `${process.platform} ${hostname()}`;
  const keys = resolveKeypair(options, previous, installDir);
  const direct = resolveDirectEndpoint(options, previous);

  const registered = await apiJson(serverUrl, auth.accessToken, '/api/v1/hdo/devices/register', {
    method: 'POST',
    body: {
      id: deviceId,
      label,
      platform: `${process.platform}-${process.arch}`,
      publicKey: keys.publicKey,
      status: 'online',
      metadata: {
        source: '@qpjoy/tunnel-cli',
        role: options.role,
        hostname: hostname(),
        wireGuard: {
          publicKey: keys.publicKey,
          interfaceName,
          preferDirectPeers: direct.preferDirectPeers,
          acceptDirectPeers: direct.directListener,
          directListener: direct.directListener,
          endpointHost: direct.endpointHost,
          listenPort: direct.listenPort,
          endpoint: direct.endpoint,
          updatedAt: new Date().toISOString(),
        },
      },
    },
  });
  const manifest = await apiJson(serverUrl, auth.accessToken, `/api/v1/hdo/manifest/${encodeURIComponent(deviceId)}`, {
    method: 'GET',
  });
  const runtime = hdoRuntimeFromManifest(manifest, registered, keys.privateKey);
  writeWireGuardConfig(configPath, renderHdoClientWireGuardConfig({
    privateKey: runtime.privateKey,
    address: runtime.address,
    listenPort: direct.listenPort,
    domesticPublicKey: runtime.domesticPublicKey,
    domesticEndpoint: runtime.domesticEndpoint,
    allowedIps: runtime.allowedIps,
    directPeers: runtime.directPeers,
    persistentKeepalive: 25,
  }));

  const now = new Date().toISOString();
  writeState(stateFile, {
    serverUrl,
    bearerToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    accessExpiresAt: auth.accessExpiresAt,
    refreshExpiresAt: auth.refreshExpiresAt,
    username: auth.username ?? username,
    deviceId,
    label,
    interfaceName,
    configPath,
    installDir,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    overlayIp: runtime.overlayIp,
    directListener: direct.directListener,
    preferDirectPeers: direct.preferDirectPeers,
    endpointHost: direct.endpointHost,
    listenPort: direct.listenPort,
    lastManifestGeneration: runtime.generation,
    enrolledAt: previous.enrolledAt || now,
    updatedAt: now,
  });

  let startMessage = 'System tunnel not started (--no-start).';
  if (options.start) {
    startMessage = await startSystemTunnel(interfaceName, configPath, installDir);
  }

  process.stdout.write(
    [
      refreshOnly ? 'HDO config refreshed.' : 'HDO device enrolled.',
      `Device: ${deviceId}`,
      `Overlay IP: ${runtime.overlayIp}`,
      `WireGuard config: ${configPath}`,
      `State file: ${stateFile}`,
      startMessage,
      '',
    ].join('\n'),
  );
}

function statusCommand(input: HdoCommandOptions): void {
  const stateFile = resolveStateFile(input.stateFile);
  const state = readState(stateFile);
  const interfaceName = sanitizeInterfaceName(input.interfaceName || state.interfaceName || defaultInterfaceName);
  const configPath = resolveConfigPath(input.configPath || state.configPath, interfaceName);
  const installDir = resolveInstallDir(input.installDir || state.installDir);
  const runtime = resolveWireGuardConnectionRuntime({
    installDir,
    allowSystemFallback: true,
  });

  process.stdout.write(`State file: ${stateFile}\n`);
  process.stdout.write(`Server URL: ${state.serverUrl || 'unset'}\n`);
  process.stdout.write(`Device: ${state.deviceId || 'unset'}\n`);
  process.stdout.write(`Overlay IP: ${state.overlayIp || 'unset'}\n`);
  process.stdout.write(`WireGuard config: ${configPath}\n\n`);

  if (process.platform === 'linux') {
    if (commandAvailable('systemctl')) {
      inherit('systemctl', ['status', `wg-quick@${interfaceName}`, '--no-pager']);
      process.stdout.write('\n');
    } else {
      process.stdout.write('systemctl unavailable; showing WireGuard runtime status only.\n\n');
    }
    printWireGuardRuntimeStatus(runtime, configPath);
    return;
  }

  if (process.platform === 'darwin') {
    const daemon = getDarwinWireGuardLaunchDaemonStatus({ runtime, configPath });
    process.stdout.write(`LaunchDaemon: ${daemon.loaded ? 'loaded' : 'not loaded'}; running=${daemon.running}\n`);
    if (daemon.plistPath) process.stdout.write(`plist: ${daemon.plistPath}\n`);
  }
  try {
    const tunnel = getWireGuardTunnelStatus({ runtime, configPath });
    process.stdout.write(`WireGuard active: ${tunnel.active}\n`);
    process.stdout.write(`Runtime: ${runtime.method}\n`);
    if (tunnel.realInterfaceName) process.stdout.write(`Interface: ${tunnel.realInterfaceName}\n`);
    if (tunnel.peers.length) process.stdout.write(`Peers: ${tunnel.peers.length}\n`);
    if (tunnel.error) process.stdout.write(`Status detail: ${tunnel.error}\n`);
  } catch (err) {
    process.stdout.write(`WireGuard status detail: ${errorMessage(err)}\n`);
  }
}

async function downCommand(input: HdoCommandOptions): Promise<void> {
  const stateFile = resolveStateFile(input.stateFile);
  const state = readState(stateFile);
  const interfaceName = sanitizeInterfaceName(input.interfaceName || state.interfaceName || defaultInterfaceName);
  const configPath = resolveConfigPath(input.configPath || state.configPath, interfaceName);
  const installDir = resolveInstallDir(input.installDir || state.installDir);

  if (process.platform === 'linux') {
    const runtime = resolveWireGuardConnectionRuntime({
      installDir,
      allowSystemFallback: true,
    });
    if (commandAvailable('systemctl') && systemdUnitExists('wg-quick@.service')) {
      inheritRequired('systemctl', ['disable', '--now', `wg-quick@${interfaceName}`]);
      return;
    }
    const result = await setWireGuardTunnelState({ runtime, configPath, action: 'down' });
    if (!result.ok) throw new Error(result.message);
    process.stdout.write(`${result.message}\n`);
    return;
  }

  const runtime = resolveWireGuardConnectionRuntime({
    installDir,
    allowSystemFallback: true,
  });
  if (process.platform === 'darwin') {
    if (!canReadFile(configPath)) {
      uninstallDarwinLaunchDaemonByInterface(interfaceName);
      return;
    }
    const result = await uninstallDarwinWireGuardLaunchDaemon({ runtime, configPath });
    if (!result.ok) throw new Error(result.message);
    process.stdout.write(`${result.message}\n`);
    return;
  }
  const result = await setWireGuardTunnelState({ runtime, configPath, action: 'down' });
  if (!result.ok) throw new Error(result.message);
  process.stdout.write(`${result.message}\n`);
}

function parseEnrollOptions(args: string[]): HdoEnrollOptions {
  const options: HdoEnrollOptions = {
    interfaceName: defaultInterfaceName,
    role: 'internal',
    start: true,
    rotateKey: false,
    directListener: false,
    preferDirectPeers: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const readValue = () => {
      const value = args[index + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      index += 1;
      return value;
    };
    switch (arg) {
      case '--server-url':
        options.serverUrl = readValue();
        break;
      case '--token':
        options.token = readValue();
        break;
      case '--token-file':
        options.tokenFile = readValue();
        break;
      case '--username':
      case '--user':
        options.username = readValue();
        break;
      case '--password':
        options.password = readValue();
        break;
      case '--password-file':
        options.passwordFile = readValue();
        break;
      case '--device-id':
        options.deviceId = readValue();
        break;
      case '--label':
        options.label = readValue();
        break;
      case '--interface':
        options.interfaceName = readValue();
        break;
      case '--config-path':
        options.configPath = readValue();
        break;
      case '--state-file':
        options.stateFile = readValue();
        break;
      case '--install-dir':
        options.installDir = readValue();
        break;
      case '--role':
        options.role = readValue();
        break;
      case '--direct-listener':
        options.directListener = true;
        break;
      case '--try-direct-peers':
      case '--prefer-direct-peers':
        options.preferDirectPeers = true;
        break;
      case '--public-endpoint':
        options.publicEndpoint = readValue();
        break;
      case '--endpoint-host':
      case '--public-host':
        options.endpointHost = readValue();
        break;
      case '--listen-port':
        options.listenPort = parsePort(readValue(), arg);
        break;
      case '--rotate-key':
        options.rotateKey = true;
        break;
      case '--no-start':
        options.start = false;
        break;
      default:
        throw new Error(`Unknown hdo enroll option: ${arg}`);
    }
  }

  return options;
}

function parseCommandOptions(args: string[]): HdoCommandOptions {
  const options: HdoCommandOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const readValue = () => {
      const value = args[index + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      index += 1;
      return value;
    };
    switch (arg) {
      case '--state-file':
        options.stateFile = readValue();
        break;
      case '--interface':
        options.interfaceName = readValue();
        break;
      case '--config-path':
        options.configPath = readValue();
        break;
      case '--install-dir':
        options.installDir = readValue();
        break;
      default:
        throw new Error(`Unknown hdo option: ${arg}`);
    }
  }
  return options;
}

async function resolveAuth(
  serverUrl: string,
  options: HdoEnrollOptions,
  previous: HdoClientState,
  username?: string,
): Promise<HdoAuthMaterial> {
  const token = resolveExplicitToken(options);
  if (token) {
    return {
      accessToken: token,
      refreshToken: previous.refreshToken,
      accessExpiresAt: previous.accessExpiresAt,
      refreshExpiresAt: previous.refreshExpiresAt,
      username,
    };
  }

  if (previous.refreshToken && !tokenExpired(previous.refreshExpiresAt)) {
    try {
      return await refreshAuth(serverUrl, previous.refreshToken, username ?? previous.username);
    } catch {
      // Fall through to username/password login.
    }
  }

  const identifier = username;
  const password = resolvePassword(options);
  if (identifier && password) {
    return loginAuth(serverUrl, identifier, password);
  }
  if (previous.bearerToken && !tokenExpired(previous.accessExpiresAt)) {
    return {
      accessToken: previous.bearerToken,
      refreshToken: previous.refreshToken,
      accessExpiresAt: previous.accessExpiresAt,
      refreshExpiresAt: previous.refreshExpiresAt,
      username: username ?? previous.username,
    };
  }
  if (!identifier) {
    throw new Error('Missing --username, HDO_USERNAME, or --token.');
  }
  throw new Error('Missing --password, --password-file, or HDO_PASSWORD.');
}

function resolveExplicitToken(options: HdoEnrollOptions): string | undefined {
  if (options.token) return options.token;
  if (options.tokenFile) return readFileSync(resolve(options.tokenFile), 'utf8').trim();
  return process.env.HDO_TOKEN ?? process.env.QPJOY_HDO_TOKEN;
}

function resolvePassword(options: HdoEnrollOptions): string | undefined {
  if (options.password) return options.password;
  if (options.passwordFile) return readFileSync(resolve(options.passwordFile), 'utf8').trim();
  return process.env.HDO_PASSWORD ?? process.env.QPJOY_HDO_PASSWORD;
}

async function loginAuth(serverUrl: string, identifier: string, password: string): Promise<HdoAuthMaterial> {
  const raw = await apiJson(serverUrl, '', '/api/v1/auth/login', {
    method: 'POST',
    body: { identifier, password },
    auth: false,
  });
  const root = requireRecord(raw, 'auth response');
  const tokens = requireRecord(root.tokens, 'auth response tokens');
  const accessToken = stringField(tokens.accessToken);
  if (!accessToken) throw new Error('Auth response did not include accessToken.');
  return {
    accessToken,
    refreshToken: stringField(tokens.refreshToken) ?? undefined,
    accessExpiresAt: stringField(tokens.accessExpiresAt) ?? undefined,
    refreshExpiresAt: stringField(tokens.refreshExpiresAt) ?? undefined,
    username: identifier,
  };
}

async function refreshAuth(serverUrl: string, refreshToken: string, username?: string): Promise<HdoAuthMaterial> {
  const raw = await apiJson(serverUrl, '', '/api/v1/auth/refresh', {
    method: 'POST',
    body: { refreshToken },
    auth: false,
  });
  const root = requireRecord(raw, 'refresh response');
  const accessToken = stringField(root.accessToken);
  if (!accessToken) throw new Error('Refresh response did not include accessToken.');
  return {
    accessToken,
    refreshToken: stringField(root.refreshToken) ?? refreshToken,
    accessExpiresAt: stringField(root.accessExpiresAt) ?? undefined,
    refreshExpiresAt: stringField(root.refreshExpiresAt) ?? undefined,
    username,
  };
}

function resolveKeypair(
  options: HdoEnrollOptions,
  previous: HdoClientState,
  installDir: string,
): { privateKey: string; publicKey: string } {
  if (!options.rotateKey && previous.privateKey && previous.publicKey) {
    return { privateKey: previous.privateKey, publicKey: previous.publicKey };
  }
  const runtime = resolveWireGuardRuntime({
    installDir,
    allowSystemFallback: true,
  });
  if (!runtime.command) {
    throw new Error(runtime.error ?? 'WireGuard wg command unavailable.');
  }
  return generateWireGuardKeyPairWithCli(runtime.command);
}

function resolveDirectEndpoint(
  options: HdoEnrollOptions,
  previous: HdoClientState,
): { directListener: boolean; preferDirectPeers: boolean; endpointHost?: string; listenPort?: number; endpoint?: string } {
  const publicEndpoint =
    options.publicEndpoint ??
    process.env.HDO_PUBLIC_ENDPOINT ??
    process.env.QPJOY_HDO_PUBLIC_ENDPOINT;
  const parsedEndpoint = publicEndpoint ? parseEndpoint(publicEndpoint) : {};
  const endpointHost =
    options.endpointHost ??
    process.env.HDO_ENDPOINT_HOST ??
    process.env.QPJOY_HDO_ENDPOINT_HOST ??
    parsedEndpoint.host ??
    previous.endpointHost;
  const listenPort =
    options.listenPort ??
    parseOptionalPort(process.env.HDO_LISTEN_PORT ?? process.env.QPJOY_HDO_LISTEN_PORT) ??
    parsedEndpoint.port ??
    previous.listenPort;
  const directListener = Boolean(
    options.directListener ||
    publicEndpoint ||
    options.endpointHost ||
    options.listenPort ||
    previous.directListener,
  );
  const preferDirectPeers = Boolean(options.preferDirectPeers || previous.preferDirectPeers);
  return {
    directListener,
    preferDirectPeers,
    endpointHost,
    listenPort,
    endpoint: endpointHost && listenPort ? `${endpointHost}:${listenPort}` : undefined,
  };
}

function directPeersFromManifest(wireGuard: Record<string, unknown>, ownOverlayIp: string): WireGuardPeer[] {
  const ownIp = ownOverlayIp.split('/')[0] || ownOverlayIp;
  const rows = Array.isArray(wireGuard.directPeers) ? wireGuard.directPeers : [];
  return rows.flatMap((item) => {
    const row = plainObject(item);
    if (!row) return [];
    const publicKey = stringField(row.publicKey);
    const overlayIp = stringField(row.overlayIp);
    if (!publicKey || !overlayIp || overlayIp === ownIp) return [];
    const allowedIps = stringArray(row.allowedIps);
    const peer: WireGuardPeer = {
      name: `HDO Direct ${stringField(row.label) ?? stringField(row.id) ?? overlayIp}`,
      publicKey,
      allowedIps: allowedIps.length ? allowedIps : [`${overlayIp}/32`],
      endpoint: stringField(row.endpoint),
      persistentKeepalive: 25,
    };
    return [peer];
  });
}

async function startSystemTunnel(interfaceName: string, configPath: string, installDir: string): Promise<string> {
  if (process.platform === 'linux') {
    const runtime = await ensureLinuxWireGuardRuntime(installDir);
    if (!commandAvailable('systemctl')) {
      const result = await setWireGuardTunnelState({ runtime, configPath, action: 'restart' });
      if (!result.ok) throw new Error(result.message);
      return `${result.message} systemctl is unavailable, so this tunnel is not installed as a boot service.`;
    }
    ensureLinuxWgQuickSystemdUnit(runtime);
    inheritRequired('systemctl', ['daemon-reload']);
    inheritRequired('systemctl', ['enable', `wg-quick@${interfaceName}`]);
    inheritRequired('systemctl', ['restart', `wg-quick@${interfaceName}`]);
    return `Enabled and restarted wg-quick@${interfaceName}.`;
  }

  const runtime = resolveWireGuardConnectionRuntime({
    installDir,
    allowSystemFallback: true,
  });
  if (process.platform === 'darwin') {
    const result = await installDarwinWireGuardLaunchDaemon({ runtime, configPath });
    if (!result.ok) throw new Error(result.message);
    return result.message;
  }

  if (process.platform === 'win32') {
    const result = await setWireGuardTunnelState({ runtime, configPath, action: 'restart' });
    if (!result.ok) throw new Error(result.message);
    return result.message;
  }

  throw new Error(`Unsupported platform for HDO system tunnel: ${process.platform}`);
}

function readState(path: string): HdoClientState {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) return {};
  return parsed as HdoClientState;
}

function writeState(path: string, state: HdoClientState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  chmodSyncSafe(path, 0o600);
}

function writeWireGuardConfig(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
  chmodSyncSafe(path, 0o600);
}

function hdoRuntimeFromManifest(
  manifest: unknown,
  registered: unknown,
  privateKey: string,
): {
  privateKey: string;
  address: string;
  overlayIp: string;
  domesticPublicKey: string;
  domesticEndpoint: string;
  allowedIps: string[];
  directPeers: WireGuardPeer[];
  generation?: number;
} {
  const root = requireRecord(manifest, 'manifest');
  const license = requireRecord(root.license, 'manifest.license');
  if (license.active !== true) {
    throw new Error('HDO mesh license is not active for this user/device.');
  }
  const wireGuard = requireRecord(root.wireGuard, 'manifest.wireGuard');
  const client = requireRecord(wireGuard.client, 'manifest.wireGuard.client');
  const domestic = requireRecord(wireGuard.domestic, 'manifest.wireGuard.domestic');
  const overlayIp =
    stringField(client.overlayIp) ||
    stringField(requireRecord(registered, 'registered device').overlayIp);
  const domesticPublicKey = stringField(domestic.publicKey);
  const domesticEndpoint = stringField(domestic.endpoint);
  if (!overlayIp) throw new Error('HDO manifest did not assign an overlay IP.');
  if (!domesticPublicKey || !domesticEndpoint) {
    throw new Error('HDO manifest is missing domestic WireGuard publicKey/endpoint.');
  }
  const routeCidrs = stringArray(wireGuard.routeCidrs);
  const domesticOverlay = stringField(domestic.overlayIp);
  const allowedIps = uniqueStrings([
    ...routeCidrs,
    ...(domesticOverlay ? [`${domesticOverlay}/32`] : []),
  ]).filter((value) => value.includes('/'));
  if (allowedIps.length === 0) {
    throw new Error('HDO manifest did not include WireGuard AllowedIPs.');
  }
  return {
    privateKey,
    address: overlayIp.includes('/') ? overlayIp : `${overlayIp}/32`,
    overlayIp: overlayIp.split('/')[0] || overlayIp,
    domesticPublicKey,
    domesticEndpoint,
    allowedIps,
    directPeers: directPeersFromManifest(wireGuard, overlayIp),
    generation: numberField(root.generation),
  };
}

async function apiJson(
  serverUrl: string,
  token: string,
  path: string,
  input: { method: 'GET' | 'POST'; body?: unknown; auth?: boolean },
): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (input.auth !== false) headers.authorization = `Bearer ${token}`;
  if (input.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${serverUrl}${path}`, {
    method: input.method,
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HDO API ${input.method} ${path} failed: HTTP ${response.status} ${text}`);
  }
  return text ? JSON.parse(text) as unknown : null;
}

function resolveStateFile(input?: string): string {
  return resolve(input || defaultStateFile());
}

function resolveConfigPath(input: string | undefined, interfaceName: string): string {
  if (input) return resolve(input);
  const launchDaemonConfig = darwinLaunchDaemonConfigPath(interfaceName);
  if (launchDaemonConfig && existsSync(launchDaemonConfig)) return launchDaemonConfig;
  return resolve(defaultConfigPath(interfaceName));
}

function resolveInstallDir(input?: string): string {
  return resolve(input || defaultInstallDir());
}

function defaultStateFile(): string {
  if (process.platform === 'linux') return '/etc/qpjoy/hdo/client.json';
  if (process.platform === 'win32') return join(windowsUserDataDir(), 'client.json');
  return join(homedir(), '.qpjoy', 'hdo', 'client.json');
}

function defaultConfigPath(interfaceName: string): string {
  if (process.platform === 'linux') return `/etc/wireguard/${interfaceName}.conf`;
  if (process.platform === 'win32') return join(windowsUserDataDir(), `${interfaceName}.conf`);
  return join(homedir(), '.qpjoy', 'hdo', `${interfaceName}.conf`);
}

function darwinLaunchDaemonConfigPath(interfaceName: string): string | null {
  if (process.platform !== 'darwin') return null;
  return `/Library/Application Support/QPJoy/HDO/${interfaceName}/${interfaceName}.conf`;
}

function defaultInstallDir(): string {
  if (process.platform === 'linux') return '/usr/local/lib/qpjoy/hdo/bin';
  if (process.platform === 'win32') return join(windowsUserDataDir(), 'bin');
  return join(homedir(), '.qpjoy', 'hdo', 'bin');
}

function windowsUserDataDir(): string {
  return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'QPJoy', 'HDO');
}

function inherit(command: string, args: string[]): void {
  spawnSync(command, args, { stdio: 'inherit' });
}

function inheritRequired(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  assertSpawnOk(command, args, result);
}

function printWireGuardRuntimeStatus(runtime: WireGuardConnectionRuntimeStatus, configPath: string): void {
  process.stdout.write(`Runtime: ${runtime.method}\n`);
  if (runtime.warnings.length) {
    process.stdout.write(`Runtime warnings: ${runtime.warnings.join('; ')}\n`);
  }
  try {
    const tunnel = getWireGuardTunnelStatus({ runtime, configPath });
    process.stdout.write(`WireGuard active: ${tunnel.active}\n`);
    if (tunnel.realInterfaceName) process.stdout.write(`Interface: ${tunnel.realInterfaceName}\n`);
    if (tunnel.peers.length) process.stdout.write(`Peers: ${tunnel.peers.length}\n`);
    if (tunnel.error) process.stdout.write(`Status detail: ${tunnel.error}\n`);
  } catch (err) {
    process.stdout.write(`WireGuard status detail: ${errorMessage(err)}\n`);
  }
}

async function ensureLinuxWireGuardRuntime(installDir: string): Promise<WireGuardConnectionRuntimeStatus> {
  let runtime = resolveWireGuardConnectionRuntime({
    installDir,
    allowSystemFallback: true,
  });
  if (runtime.available) return runtime;

  const installed = installLinuxWireGuardTools();
  runtime = resolveWireGuardConnectionRuntime({
    installDir,
    allowSystemFallback: true,
  });
  if (runtime.available) return runtime;

  throw new Error(
    installed
      ? runtime.error ?? 'WireGuard runtime unavailable after installing wireguard-tools.'
      : `${runtime.error ?? 'WireGuard runtime unavailable'}. Install wireguard-tools or use an npm package with the matching @qpjoy/electron-core-wireguard-engine package.`,
  );
}

function installLinuxWireGuardTools(): boolean {
  const installers: Array<{ probe: string; commands: string[][]; label: string }> = [
    { probe: 'apt-get', label: 'apt-get', commands: [['apt-get', 'update'], ['apt-get', 'install', '-y', 'wireguard-tools']] },
    { probe: 'dnf', label: 'dnf', commands: [['dnf', 'install', '-y', 'wireguard-tools']] },
    { probe: 'yum', label: 'yum', commands: [['yum', 'install', '-y', 'epel-release'], ['yum', 'install', '-y', 'wireguard-tools']] },
    { probe: 'apk', label: 'apk', commands: [['apk', 'add', '--no-cache', 'wireguard-tools']] },
    { probe: 'zypper', label: 'zypper', commands: [['zypper', '--non-interactive', 'install', 'wireguard-tools']] },
    { probe: 'pacman', label: 'pacman', commands: [['pacman', '-Sy', '--noconfirm', 'wireguard-tools']] },
  ];

  for (const installer of installers) {
    if (!commandAvailable(installer.probe)) continue;
    process.stdout.write(`WireGuard tools are missing; installing wireguard-tools with ${installer.label}.\n`);
    for (const command of installer.commands) {
      const [name, ...args] = command;
      const result = spawnSync(name, args, { stdio: 'inherit' });
      if (result.status !== 0) {
        process.stdout.write(`wireguard-tools install step failed: ${command.join(' ')}\n`);
        return false;
      }
    }
    return true;
  }
  return false;
}

function ensureLinuxWgQuickSystemdUnit(runtime: WireGuardConnectionRuntimeStatus): void {
  if (systemdUnitUsable()) return;

  const wgQuick = runtime.wgQuick?.command;
  if (!wgQuick) {
    throw new Error(runtime.error ?? 'wg-quick unavailable; cannot install systemd boot service.');
  }

  const unitPath = '/etc/systemd/system/wg-quick@.service';
  if (existsSync(unitPath)) {
    throw new Error(
      `${unitPath} exists but wg/wg-quick is not available in PATH. Install wireguard-tools or fix the existing unit.`,
    );
  }

  mkdirSync(dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, renderLinuxWgQuickSystemdUnit(runtime, wgQuick), { mode: 0o644 });
  chmodSyncSafe(unitPath, 0o644);
  process.stdout.write(`Installed ${unitPath} using bundled WireGuard tools.\n`);
}

function renderLinuxWgQuickSystemdUnit(
  runtime: WireGuardConnectionRuntimeStatus,
  wgQuick: string,
): string {
  const pathDirs = uniqueStrings([
    runtime.wg.command ? dirname(runtime.wg.command) : '',
    runtime.wgQuick?.command ? dirname(runtime.wgQuick.command) : '',
    runtime.wireGuardGo?.command ? dirname(runtime.wireGuardGo.command) : '',
    '/usr/local/sbin',
    '/usr/local/bin',
    '/usr/sbin',
    '/usr/bin',
    '/sbin',
    '/bin',
  ].filter(Boolean));
  return `[Unit]
Description=WireGuard via wg-quick(8) for %I
Documentation=man:wg-quick(8) man:wg(8)
Wants=network-online.target
After=network-online.target nss-lookup.target
ConditionPathExists=/etc/wireguard/%i.conf

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=${systemdQuote(`PATH=${pathDirs.join(':')}`)}
Environment=WG_ENDPOINT_RESOLUTION_RETRIES=infinity
ExecStart=${systemdQuote(wgQuick)} up %i
ExecStop=${systemdQuote(wgQuick)} down %i

[Install]
WantedBy=multi-user.target
`;
}

function systemdUnitUsable(): boolean {
  return systemdUnitExists('wg-quick@.service') && commandAvailable('wg') && commandAvailable('wg-quick');
}

function systemdUnitExists(unitName: string): boolean {
  const paths = [
    `/etc/systemd/system/${unitName}`,
    `/run/systemd/system/${unitName}`,
    `/lib/systemd/system/${unitName}`,
    `/usr/lib/systemd/system/${unitName}`,
  ];
  if (paths.some((path) => existsSync(path))) return true;
  if (!commandAvailable('systemctl')) return false;
  const result = spawnSync('systemctl', ['cat', unitName], { stdio: 'ignore' });
  return result.status === 0;
}

function commandAvailable(command: string): boolean {
  const result = spawnSync('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', command], {
    stdio: 'ignore',
  });
  return result.status === 0;
}

function uninstallDarwinLaunchDaemonByInterface(interfaceName: string): void {
  const component = sanitizeLaunchDaemonComponent(interfaceName);
  const label = `com.qpjoy.hdo.wireguard.${component}`;
  const plist = `/Library/LaunchDaemons/${label}.plist`;
  const supportDir = `/Library/Application Support/QPJoy/HDO/${component}`;
  const script = [
    'set -e',
    `LABEL=${shellQuote(label)}`,
    `PLIST=${shellQuote(plist)}`,
    `SUPPORT_DIR=${shellQuote(supportDir)}`,
    `PID_FILE=${shellQuote(`/var/run/wireguard/${interfaceName}.pid`)}`,
    `NAME_FILE=${shellQuote(`/var/run/wireguard/${interfaceName}.name`)}`,
    `WIREGUARD_GO=${shellQuote(`${supportDir}/bin/wireguard-go`)}`,
    'launchctl bootout "system/$LABEL" >/dev/null 2>&1 || launchctl bootout system "$PLIST" >/dev/null 2>&1 || true',
    'if [ -s "$PID_FILE" ]; then WG_PID="$(cat "$PID_FILE" 2>/dev/null || true)"; if [ -n "$WG_PID" ]; then kill "$WG_PID" >/dev/null 2>&1 || true; sleep 0.2; kill -9 "$WG_PID" >/dev/null 2>&1 || true; fi; fi',
    'if command -v pgrep >/dev/null 2>&1; then for stale_pid in $(pgrep -x wireguard-go 2>/dev/null || true); do stale_command="$(ps -p "$stale_pid" -o command= 2>/dev/null || true)"; printf "%s\\n" "$stale_command" | grep -F "$WIREGUARD_GO" >/dev/null 2>&1 && kill "$stale_pid" >/dev/null 2>&1 || true; done; fi',
    'rm -f "$PLIST" "$PID_FILE" "$NAME_FILE"',
    'rm -rf "$SUPPORT_DIR"'
  ].join('\n');
  const appleScript = `do shell script ${appleScriptString(script)} with administrator privileges`;
  const result = spawnSync('osascript', ['-e', appleScript], {
    encoding: 'utf8'
  });
  assertSpawnOk('osascript', ['-e', '<uninstall-hdo-launchdaemon>'], result);
  process.stdout.write(`Stopped and removed ${label}.\n`);
}

function assertSpawnOk(command: string, args: string[], result: SpawnSyncReturns<string | Buffer>): void {
  if (result.error) {
    throw new Error(`${command} failed: ${result.error.message}`);
  }
  if (result.status && result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : result.stderr;
    throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}${stderr ? `: ${stderr}` : ''}`);
  }
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/\/+$/, '');
}

function sanitizeInterfaceName(value: string): string {
  const safe = value.trim();
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(safe)) {
    throw new Error(`Invalid WireGuard interface name: ${value}`);
  }
  return safe;
}

function sanitizeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'device';
}

function parseEndpoint(value: string): { host?: string; port?: number } {
  const trimmed = value.trim();
  const index = trimmed.lastIndexOf(':');
  if (index <= 0 || index === trimmed.length - 1) {
    throw new Error(`Invalid --public-endpoint, expected HOST:PORT: ${value}`);
  }
  const host = trimmed.slice(0, index).replace(/^\[|\]$/g, '');
  const port = parsePort(trimmed.slice(index + 1), '--public-endpoint');
  return { host, port };
}

function parsePort(value: string, label: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return port;
}

function parseOptionalPort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  return parsePort(value, 'listen port');
}

function tokenExpired(value: string | undefined): boolean {
  if (!value) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && Date.now() > time - 60_000;
}

function canReadFile(path: string): boolean {
  try {
    readFileSync(path, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function chmodSyncSafe(path: string, mode: number): void {
  if (process.platform === 'win32') return;
  chmodSync(path, mode);
}

function sanitizeLaunchDaemonComponent(value: string): string {
  return value.replace(/[^A-Za-z0-9.-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'hdo-client';
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function systemdQuote(value: string): string {
  return `"${String(value).replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is not an object.`);
  return value;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => stringField(item)).filter((item): item is string => Boolean(item));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
