#!/usr/bin/env node
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(scriptDir, '..');
const artifactRoot = process.env.MX_INTERNAL_SERVICE_ARTIFACT_DIR
  || join(serverDir, 'artifacts/site-slots/domestic');
const defaultConfigPath = process.env.MX_INTERNAL_SERVICE_CONFIG
  || join(artifactRoot, 'mx-internal-service-peer.conf');
const defaultApplyScriptPath = process.env.MX_INTERNAL_SERVICE_APPLY_SCRIPT
  || join(artifactRoot, 'mx-internal-service-peer-apply.sh');
const defaultInternalEgressSubscriptionPath = process.env.MX_INTERNAL_EGRESS_SUBSCRIPTION
  || join(artifactRoot, 'mx-internal-egress-subscription.yaml');
const defaultInterfaceName = process.env.MX_INTERNAL_SERVICE_WG_INTERFACE || 'mx-internal-svc';
const fallbackTunnelCliArchiveName = 'mx-domestic-qp-tunnel-cli-fallback.tar.gz';
const fallbackTunnelCliRuntimeDir = process.env.MX_QP_TUNNEL_CLI_BUNDLE_DIR
  || join(artifactRoot, 'qp-tunnel-cli-runtime');
const host = process.env.MX_INTERNAL_HOST_RUNNER_HOST || '127.0.0.1';
const port = Number(process.argv[2] || process.env.MX_INTERNAL_HOST_RUNNER_PORT || '19190');
const runnerUrl = `http://${host}:${port}`;
const nativeHostRunnerInstallCommand = `bash scripts/manage.sh ops site-slot native-host-runner install ${port}`;
const nativeHostRunnerStartCommand = `bash scripts/manage.sh ops site-slot native-host-runner start ${port}`;
const legacyHostRunnerStartCommand = `MX_INTERNAL_HOST_RUNNER_HOST=0.0.0.0 bash scripts/manage.sh ops site-slot internal-service-peer-host-runner ${port}`;
const requiredProxyBypassEntries = [
  '10.88.0.0/16',
  '10.89.0.0/16',
  '10.90.0.0/16'
];
const splitDnsSuffixes = [
  '.internal',
  '.cluster.local'
];

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stringValue(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function boolValue(value) {
  return value === true || value === 'true';
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isLinuxKitHost() {
  return platform() === 'linux' && /linuxkit/i.test(release());
}

function csvEntries(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function mergeCsvEntries(...lists) {
  const seen = new Set();
  const merged = [];
  for (const list of lists) {
    for (const entry of list) {
      const normalized = entry.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      merged.push(entry);
    }
  }
  return merged;
}

function primeProxyBypassEnv() {
  if (process.env.MX_INTERNAL_HOST_RUNNER_NO_PROXY_AUTOFILL === '0') {
    return { enabled: false, applied: false };
  }
  const current = mergeCsvEntries(csvEntries(process.env.NO_PROXY), csvEntries(process.env.no_proxy));
  const merged = mergeCsvEntries(current, requiredProxyBypassEntries, splitDnsSuffixes);
  const value = merged.join(',');
  process.env.NO_PROXY = value;
  process.env.no_proxy = value;
  return {
    enabled: true,
    applied: merged.length !== current.length,
    entries: merged
  };
}

const proxyBypassEnv = primeProxyBypassEnv();
let cachedFallbackTunnelCli = null;

async function commandPath(command) {
  const override = command === 'qp-tunnel-cli'
    ? process.env.MX_QP_TUNNEL_CLI_PATH || process.env.QP_TUNNEL_CLI
    : null;
  if (override?.trim()) {
    const path = override.trim();
    return {
      available: existsSync(path),
      path: existsSync(path) ? path : null,
      probe: existsSync(path) ? 'passed' : 'missing',
      command
    };
  }
  if (command === 'qp-tunnel-cli') {
    const fallback = await ensureFallbackTunnelCli();
    if (fallback.path) {
      return {
        available: true,
        path: fallback.path,
        probe: fallback.probe,
        command,
        fallbackArchivePath: fallback.archivePath,
        version: await commandVersion(fallback.path),
        error: null
      };
    }
    const result = await runCommand('sh', ['-lc', `command -v ${command}`], 1000);
    const path = result.status === 'passed' ? result.stdout.trim().split(/\s+/)[0] || null : null;
    if (path) {
      return {
        available: true,
        path,
        probe: result.status,
        command,
        fallbackArchivePath: null,
        version: await commandVersion(path),
        error: null
      };
    }
    return {
      available: false,
      path: null,
      probe: fallback.error ? 'missing-fallback-artifact' : result.status,
      command,
      fallbackArchivePath: fallback.archivePath || null,
      version: null,
      error: fallback.error || null
    };
  }
  const result = await runCommand('sh', ['-lc', `command -v ${command}`], 1000);
  const path = result.status === 'passed' ? result.stdout.trim().split(/\s+/)[0] || null : null;
  return {
    available: Boolean(path),
    path,
    probe: result.status,
    command
  };
}

async function commandVersion(path) {
  const result = await runCommand(path, ['-v'], 2000);
  return result.status === 'passed' ? result.stdout.trim() || null : null;
}

function fallbackTunnelCliPath() {
  return join(fallbackTunnelCliRuntimeDir, 'bin/qp-tunnel-cli');
}

function fallbackTunnelCliMarkerPath() {
  return join(fallbackTunnelCliRuntimeDir, '.fallback-archive');
}

function fallbackTunnelCliRuntimeReady() {
  return existsSync(fallbackTunnelCliPath())
    && existsSync(join(fallbackTunnelCliRuntimeDir, 'node_modules/@qpjoy/electron-core-wireguard/package.json'))
    && existsSync(join(fallbackTunnelCliRuntimeDir, 'node_modules/@qpjoy/electron-core-wireguard/dist/index.js'));
}

function fallbackArchiveFingerprint(archivePath) {
  const stat = statSync(archivePath);
  return `${archivePath}\n${stat.size}\n${Math.trunc(stat.mtimeMs)}`;
}

function fallbackArchiveMarkerMatches(archivePath) {
  const markerPath = fallbackTunnelCliMarkerPath();
  if (!existsSync(markerPath)) return false;
  try {
    return readFileSync(markerPath, 'utf8') === fallbackArchiveFingerprint(archivePath);
  } catch {
    return false;
  }
}

function writeFallbackArchiveMarker(archivePath) {
  writeFileSync(fallbackTunnelCliMarkerPath(), fallbackArchiveFingerprint(archivePath), { mode: 0o600 });
}

function fallbackTunnelCliArchiveCandidates() {
  return [
    process.env.MX_QP_TUNNEL_CLI_FALLBACK_TAR,
    join(artifactRoot, fallbackTunnelCliArchiveName),
    resolve(serverDir, '../artifacts/site-slots/domestic', fallbackTunnelCliArchiveName),
    resolve(scriptDir, '../../artifacts/site-slots/domestic', fallbackTunnelCliArchiveName),
    join(serverDir, 'artifacts/site-slots/domestic', fallbackTunnelCliArchiveName),
    `/app/artifacts/site-slots/domestic/${fallbackTunnelCliArchiveName}`
  ].filter((candidate, index, candidates) => (
    typeof candidate === 'string'
    && candidate.trim()
    && candidates.indexOf(candidate) === index
  ));
}

function chmodFallbackTunnelCliRuntime() {
  for (const target of [
    'bin/qp-tunnel-cli',
    'package/resources/mihomo-client.sh',
    'node_modules/@qpjoy/electron-core-wireguard-engine-darwin-arm64/resources/wireguard/darwin-arm64/wg',
    'node_modules/@qpjoy/electron-core-wireguard-engine-darwin-arm64/resources/wireguard/darwin-arm64/wg-quick',
    'node_modules/@qpjoy/electron-core-wireguard-engine-darwin-arm64/resources/wireguard/darwin-arm64/wireguard-go',
    'node_modules/@qpjoy/electron-core-wireguard-engine-darwin-x64/resources/wireguard/darwin-x64/wg',
    'node_modules/@qpjoy/electron-core-wireguard-engine-darwin-x64/resources/wireguard/darwin-x64/wg-quick',
    'node_modules/@qpjoy/electron-core-wireguard-engine-darwin-x64/resources/wireguard/darwin-x64/wireguard-go',
    'node_modules/@qpjoy/electron-core-wireguard-engine-linux-arm64/resources/wireguard/linux-arm64/wg',
    'node_modules/@qpjoy/electron-core-wireguard-engine-linux-arm64/resources/wireguard/linux-arm64/wg-quick',
    'node_modules/@qpjoy/electron-core-wireguard-engine-linux-x64/resources/wireguard/linux-x64/wg',
    'node_modules/@qpjoy/electron-core-wireguard-engine-linux-x64/resources/wireguard/linux-x64/wg-quick',
    'node_modules/@qpjoy/electron-core-wireguard-engine-win32-x64/resources/wireguard/win32-x64/wg.exe',
    'node_modules/@qpjoy/electron-core-wireguard-engine-win32-x64/resources/wireguard/win32-x64/wireguard.exe'
  ]) {
    const path = join(fallbackTunnelCliRuntimeDir, target);
    if (existsSync(path)) chmodSync(path, 0o755);
  }
}

async function ensureFallbackTunnelCli() {
  const archivePath = fallbackTunnelCliArchiveCandidates().find((candidate) => existsSync(candidate)) || null;
  if (cachedFallbackTunnelCli?.path && fallbackTunnelCliRuntimeReady()) {
    if (!archivePath || fallbackArchiveMarkerMatches(archivePath)) return cachedFallbackTunnelCli;
    cachedFallbackTunnelCli = null;
  }
  const existingCli = fallbackTunnelCliPath();
  if (fallbackTunnelCliRuntimeReady() && (!archivePath || fallbackArchiveMarkerMatches(archivePath))) {
    chmodFallbackTunnelCliRuntime();
    cachedFallbackTunnelCli = {
      path: existingCli,
      probe: 'fallback-artifact',
      archivePath,
      error: null
    };
    return cachedFallbackTunnelCli;
  }

  if (!archivePath) {
    return {
      path: null,
      probe: 'missing-fallback-artifact',
      archivePath: null,
      error: `qp-tunnel-cli fallback archive not found: ${fallbackTunnelCliArchiveCandidates().join(', ')}`
    };
  }

  try {
    rmSync(fallbackTunnelCliRuntimeDir, { recursive: true, force: true });
    mkdirSync(fallbackTunnelCliRuntimeDir, { recursive: true });
    const extracted = await runCommand('tar', ['-xzf', archivePath, '-C', fallbackTunnelCliRuntimeDir], 30000);
    if (extracted.status !== 'passed') {
      throw new Error(extracted.stderr || extracted.stdout || `tar exited with ${extracted.exitCode}`);
    }
    chmodFallbackTunnelCliRuntime();
    if (!fallbackTunnelCliRuntimeReady()) {
      throw new Error(`extracted archive does not contain qp-tunnel-cli plus @qpjoy/electron-core-wireguard under ${fallbackTunnelCliRuntimeDir}`);
    }
    writeFallbackArchiveMarker(archivePath);
    cachedFallbackTunnelCli = {
      path: existingCli,
      probe: 'fallback-artifact',
      archivePath,
      error: null
    };
    return cachedFallbackTunnelCli;
  } catch (error) {
    return {
      path: null,
      probe: 'failed-fallback-artifact',
      archivePath,
      error: `Failed to extract qp-tunnel-cli fallback archive ${archivePath}: ${errorMessage(error)}`
    };
  }
}

async function runCommand(command, args, timeoutMs) {
  const startedAt = new Date().toISOString();
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024
    });
    return {
      status: 'passed',
      command,
      args,
      exitCode: 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      startedAt,
      finishedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      status: error.killed ? 'timeout' : error.code === 'ENOENT' ? 'missing' : 'failed',
      command,
      args,
      exitCode: typeof error.code === 'number' ? error.code : null,
      stdout: (error.stdout || '').trim(),
      stderr: (error.stderr || error.message || '').trim(),
      signal: error.signal || null,
      startedAt,
      finishedAt: new Date().toISOString()
    };
  }
}

function commandEnvArgs(env = {}) {
  return Object.entries(env)
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim())
    .map(([key, value]) => `${key}=${String(value)}`);
}

function privilegedCommand(command, args, env = {}) {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const envArgs = commandEnvArgs(env);
  if (envArgs.length) {
    return isRoot
      ? { command: 'env', args: [...envArgs, command, ...args] }
      : { command: 'sudo', args: ['-n', 'env', ...envArgs, command, ...args] };
  }
  return isRoot
    ? { command, args }
    : { command: 'sudo', args: ['-n', command, ...args] };
}

function internalEgressCommandEnv() {
  return {
    MIHOMO_HOME: process.env.MX_INTERNAL_EGRESS_HOME || '/etc/mx-internal-egress',
    MIHOMO_BIN: process.env.MX_INTERNAL_EGRESS_MIHOMO_BIN || '/usr/local/bin/mx-internal-egress-mihomo',
    MIHOMO_CLIENT_LAUNCHER: process.env.MX_INTERNAL_EGRESS_CLIENT_LAUNCHER || '/usr/local/bin/mx-internal-egress',
    MIHOMO_SERVICE_NAME: process.env.MX_INTERNAL_EGRESS_SERVICE_NAME || 'mx-internal-egress.service',
    MIHOMO_PROFILE_PROXY_FILE: process.env.MX_INTERNAL_EGRESS_PROFILE_PROXY_FILE || '/etc/profile.d/mx-internal-egress-proxy.sh',
    MIHOMO_DAEMON_PROXY_DROPIN_NAME: process.env.MX_INTERNAL_EGRESS_DAEMON_PROXY_DROPIN_NAME || 'mx-internal-egress-proxy.conf',
    MIHOMO_SSH_PROXY_HELPER: process.env.MX_INTERNAL_EGRESS_SSH_PROXY_HELPER || '/usr/local/bin/mx-internal-egress-ssh-proxy',
    MIHOMO_SSH_CONFIG_FILE: process.env.MX_INTERNAL_EGRESS_SSH_CONFIG_FILE || '/etc/ssh/ssh_config.d/99-mx-internal-egress-proxy.conf'
  };
}

function displayCommand(command, args, env = {}) {
  const envArgs = commandEnvArgs(env);
  return [
    ...(envArgs.length ? ['env', ...envArgs.map(shellQuote)] : []),
    shellQuote(command),
    ...args.map(shellQuote)
  ].join(' ');
}

function defaultWireGuardInstallDir() {
  if (platform() === 'win32') {
    return join(
      process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
      'QPJoy',
      'MX Launcher',
      'Internal WireGuard',
      'bin'
    );
  }
  if (platform() === 'linux') return '/usr/local/lib/qpjoy/mx-launcher/internal-wireguard/bin';
  return join(homedir(), '.qpjoy', 'mx-launcher', 'internal-wireguard', 'bin');
}

function internalWireGuardServiceIdentity() {
  return {
    displayName: process.env.MX_INTERNAL_SERVICE_WG_DISPLAY_NAME || 'MX Internal WireGuard',
    darwinLaunchDaemonLabelPrefix: process.env.MX_INTERNAL_SERVICE_WG_LAUNCHD_LABEL_PREFIX
      || 'com.qpjoy.mx-launcher.internal.wireguard',
    darwinSupportRoot: process.env.MX_INTERNAL_SERVICE_WG_DARWIN_SUPPORT_ROOT
      || '/Library/Application Support/QPJoy/MX Launcher/Internal WireGuard',
    darwinLogDir: process.env.MX_INTERNAL_SERVICE_WG_DARWIN_LOG_DIR
      || '/Library/Logs/QPJoy-MX-Launcher',
    darwinDaemonScriptName: process.env.MX_INTERNAL_SERVICE_WG_DARWIN_SCRIPT_NAME
      || 'mx-internal-wireguard-daemon.sh',
    staleDarwinLaunchDaemonLabelPrefixes: mergeCsvEntries(
      ['com.qpjoy.hdo.wireguard'],
      csvEntries(process.env.MX_INTERNAL_SERVICE_WG_STALE_LAUNCHD_PREFIXES)
    )
  };
}

function loadWireGuardCore(qpTunnelCliPath) {
  if (!qpTunnelCliPath) {
    return {
      available: false,
      source: 'missing-qp-tunnel-cli',
      modulePath: null,
      module: null,
      error: 'qp-tunnel-cli is required; WireGuard runtime must come from @qpjoy/tunnel-cli -> @qpjoy/electron-core-wireguard'
    };
  }
  try {
    const tunnelCliRequire = createRequire(realpathSync(qpTunnelCliPath));
    const modulePath = tunnelCliRequire.resolve('@qpjoy/electron-core-wireguard');
    const module = require(modulePath);
    if (typeof module?.resolveWireGuardConnectionRuntime !== 'function') {
      throw new Error('resolveWireGuardConnectionRuntime export is missing');
    }
    return {
      available: true,
      source: 'qp-tunnel-cli',
      modulePath,
      module,
      error: null
    };
  } catch (error) {
    return {
      available: false,
      source: 'qp-tunnel-cli',
      modulePath: null,
      module: null,
      error: `Failed to load @qpjoy/electron-core-wireguard from qp-tunnel-cli: ${errorMessage(error)}`
    };
  }
}

function resolveWireGuardCoreRuntime(qpTunnelCliPath) {
  const loaded = loadWireGuardCore(qpTunnelCliPath);
  const installDir = process.env.MX_INTERNAL_SERVICE_WG_INSTALL_DIR || defaultWireGuardInstallDir();
  if (!loaded.available) {
    return {
      moduleAvailable: false,
      available: false,
      source: loaded.source,
      modulePath: loaded.modulePath,
      module: null,
      installDir,
      runtime: null,
      error: loaded.error
    };
  }
  try {
    const runtime = loaded.module.resolveWireGuardConnectionRuntime({
      installDir,
      allowSystemFallback: false
    });
    return {
      moduleAvailable: true,
      available: Boolean(runtime?.available),
      source: loaded.source,
      modulePath: loaded.modulePath,
      module: loaded.module,
      installDir,
      runtime,
      error: runtime?.error || null
    };
  } catch (error) {
    return {
      moduleAvailable: true,
      available: false,
      source: loaded.source,
      modulePath: loaded.modulePath,
      module: loaded.module,
      installDir,
      runtime: null,
      error: errorMessage(error)
    };
  }
}

function toolRuntimeSummary(tool) {
  if (!tool) return null;
  return {
    available: Boolean(tool.available),
    source: tool.source || null,
    command: tool.command || null,
    bundledPath: tool.bundledPath || null,
    installedPath: tool.installedPath || null,
    systemPath: tool.systemPath || null,
    error: tool.error || null
  };
}

function wireGuardRuntimeSummary(runtime) {
  if (!runtime) return null;
  return {
    target: runtime.target || null,
    platform: runtime.platform || null,
    available: Boolean(runtime.available),
    method: runtime.method || 'missing',
    error: runtime.error || null,
    warnings: Array.isArray(runtime.warnings) ? runtime.warnings : [],
    wg: toolRuntimeSummary(runtime.wg),
    wgQuick: toolRuntimeSummary(runtime.wgQuick),
    wireGuardGo: toolRuntimeSummary(runtime.wireGuardGo),
    bash: toolRuntimeSummary(runtime.bash),
    windowsWireGuard: toolRuntimeSummary(runtime.windowsWireGuard)
  };
}

function truncateText(value, limit = 4000) {
  const text = typeof value === 'string' ? value : '';
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function wireGuardTunnelSummary(status) {
  if (!status) return null;
  return {
    ok: Boolean(status.ok),
    active: Boolean(status.active),
    mode: status.mode || null,
    interfaceName: status.interfaceName || null,
    realInterfaceName: status.realInterfaceName || null,
    addresses: Array.isArray(status.addresses) ? status.addresses : [],
    allowedIps: Array.isArray(status.allowedIps) ? status.allowedIps : [],
    missingRoutes: Array.isArray(status.missingRoutes) ? status.missingRoutes : [],
    routeProbes: Array.isArray(status.routeProbes)
      ? status.routeProbes.map((probe) => ({
          cidr: probe.cidr || null,
          ok: Boolean(probe.ok),
          interfaceName: probe.interfaceName || null,
          stdout: truncateText(probe.stdout, 500),
          stderr: truncateText(probe.stderr, 500)
        }))
      : [],
    peers: Array.isArray(status.peers)
      ? status.peers.map((peer) => ({
          publicKey: peer.publicKey || null,
          endpoint: peer.endpoint || null,
          allowedIps: Array.isArray(peer.allowedIps) ? peer.allowedIps : [],
          latestHandshakeAt: peer.latestHandshakeAt || null
        }))
      : [],
    routes: Array.isArray(status.routes) ? status.routes.slice(0, 50) : [],
    routeLogPath: status.routeLogPath || null,
    routeLogTail: truncateText(status.routeLogTail, 4000),
    ifconfig: truncateText(status.ifconfig, 4000),
    error: status.error || null
  };
}

function wireGuardDaemonSummary(status) {
  if (!status) return null;
  return {
    ok: Boolean(status.ok),
    supported: Boolean(status.supported),
    installed: Boolean(status.installed),
    loaded: Boolean(status.loaded),
    running: Boolean(status.running),
    mode: status.mode || null,
    label: status.label || null,
    plistPath: status.plistPath || null,
    supportDir: status.supportDir || null,
    daemonScriptPath: status.daemonScriptPath || null,
    configPath: status.configPath || null,
    stdout: truncateText(status.stdout, 4000),
    stderr: truncateText(status.stderr, 4000),
    error: status.error || null
  };
}

function wireGuardCoreApplySummary(result) {
  if (!result) return null;
  return {
    ok: Boolean(result.ok),
    action: result.action || null,
    mode: result.mode || null,
    command: result.command || null,
    message: result.message || null,
    stdout: truncateText(result.stdout, 4000),
    stderr: truncateText(result.stderr, 4000),
    routeLogPath: result.routeLogPath || null,
    routeLogTail: truncateText(result.routeLogTail, 4000)
  };
}

function wireGuardCliProbeSkippedResult(command, args, reason) {
  return {
    status: 'not-checked',
    command,
    args,
    exitCode: null,
    stdout: '',
    stderr: reason,
    startedAt: null,
    finishedAt: null
  };
}

function shouldSkipWireGuardCliProbe(wireGuardCore) {
  const runtime = wireGuardCore?.runtime || {};
  return runtime.platform === 'darwin'
    && runtime.method === 'darwin-userspace'
    && typeof process.getuid === 'function'
    && process.getuid() !== 0;
}

function wireGuardProbeInterfaceName(wireGuardCore, interfaceName) {
  return wireGuardCore?.tunnel?.realInterfaceName || interfaceName;
}

function validWireGuardPublicKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value.trim());
}

function validWireGuardPrivateKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value.trim());
}

function wireGuardPrivateKeyRawFromConfig(configPath) {
  try {
    const content = readFileSync(configPath, 'utf8');
    const match = content.match(/^\s*PrivateKey\s*=\s*(\S+)\s*$/im);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

function wireGuardPrivateKeyFromConfig(configPath) {
  const privateKey = wireGuardPrivateKeyRawFromConfig(configPath);
  return validWireGuardPrivateKey(privateKey) ? privateKey : null;
}

function internalServicePeerConfigReadiness(artifacts) {
  const configPath = artifacts.runtimeConfigPath || artifacts.configPath;
  const configExists = artifacts.runtimeConfigExists ?? artifacts.configExists;
  if (!configExists) {
    return {
      status: 'blocked',
      configPath,
      privateKey: 'missing',
      summary: `missing config: ${configPath}`,
      blockedReasons: [`Internal service peer config artifact is missing: ${configPath}`]
    };
  }
  let content = '';
  try {
    content = readFileSync(configPath, 'utf8');
  } catch (error) {
    return {
      status: 'blocked',
      configPath,
      privateKey: 'unreadable',
      summary: `unreadable config: ${configPath}`,
      blockedReasons: [`Internal service peer config is unreadable: ${errorMessage(error)}`]
    };
  }
  const rawPrivateKey = wireGuardPrivateKeyRawFromConfig(configPath);
  const blockedReasons = [];
  if (/<internal-service-private-key-from-internal-secret>|<[^>\n]+>/.test(content)) {
    blockedReasons.push(`Internal service peer config still contains template placeholders: ${configPath}`);
  }
  if (!rawPrivateKey) {
    blockedReasons.push(`Internal service peer private key is missing: ${configPath}`);
  } else if (!validWireGuardPrivateKey(rawPrivateKey)) {
    blockedReasons.push(`Internal service peer private key is not a valid WireGuard private key: ${configPath}`);
  }
  return {
    status: blockedReasons.length ? 'blocked' : 'ready',
    configPath,
    privateKey: rawPrivateKey ? validWireGuardPrivateKey(rawPrivateKey) ? 'configured' : 'invalid' : 'missing',
    summary: blockedReasons.length ? blockedReasons[0] : 'config key ready',
    blockedReasons
  };
}

function wireGuardPublicKeyFromConfig(wgCommand, configPath) {
  const privateKey = wireGuardPrivateKeyFromConfig(configPath);
  if (!wgCommand || !privateKey) return null;
  try {
    const publicKey = execFileSync(wgCommand, ['pubkey'], {
      input: `${privateKey}\n`,
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();
    return validWireGuardPublicKey(publicKey) ? publicKey : null;
  } catch {
    return null;
  }
}

function buildWireGuardCoreStatus(tools, artifacts) {
  const resolved = resolveWireGuardCoreRuntime(tools.qpTunnelCli?.path);
  let tunnel = null;
  let daemon = null;
  const configPath = artifacts.runtimeConfigPath || artifacts.configPath;
  const configExists = artifacts.runtimeConfigExists ?? artifacts.configExists;
  const publicKey = configExists
    ? wireGuardPublicKeyFromConfig(resolved.runtime?.wg?.command, configPath)
    : null;
  if (resolved.runtime && configExists) {
    if (typeof resolved.module?.getWireGuardTunnelStatus === 'function') {
      try {
        tunnel = wireGuardTunnelSummary(resolved.module.getWireGuardTunnelStatus({
          runtime: resolved.runtime,
          configPath
        }));
      } catch (error) {
        tunnel = { ok: false, active: false, error: errorMessage(error) };
      }
    }
    if (
      resolved.runtime.platform === 'darwin'
      && typeof resolved.module?.getDarwinWireGuardLaunchDaemonStatus === 'function'
    ) {
      try {
        daemon = wireGuardDaemonSummary(resolved.module.getDarwinWireGuardLaunchDaemonStatus({
          runtime: resolved.runtime,
          configPath,
          serviceIdentity: internalWireGuardServiceIdentity()
        }));
      } catch (error) {
        daemon = { ok: false, supported: true, error: errorMessage(error) };
      }
    }
  }
  const tunnelReady = tunnel?.active === true && (!Array.isArray(tunnel.missingRoutes) || tunnel.missingRoutes.length === 0);
  const daemonStarted = daemon?.running === true || daemon?.loaded === true;
  const status = !resolved.moduleAvailable
    ? 'missing'
    : !resolved.available
      ? 'blocked'
      : tunnelReady
        ? 'passed'
        : 'ready';
  return {
    available: Boolean(resolved.available),
    moduleAvailable: Boolean(resolved.moduleAvailable),
    status,
    source: resolved.source,
    modulePath: resolved.modulePath,
    installDir: resolved.installDir,
    method: resolved.runtime?.method || 'missing',
    runtime: wireGuardRuntimeSummary(resolved.runtime),
    publicKey,
    publicKeySource: publicKey ? 'runtime-config-private-key' : null,
    daemon,
    tunnel,
    error: resolved.error
  };
}

async function healthProbe(url, timeoutMs) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    return {
      status: response.ok ? 'passed' : 'failed',
      url,
      httpStatus: response.status,
      durationMs: Date.now() - startedAt,
      body: text.slice(0, 500)
    };
  } catch (error) {
    return {
      status: 'failed',
      url,
      httpStatus: null,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseHandshake(stdout) {
  const rows = stdout.trim().split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const latest = rows.map((line) => {
    const [publicKey, rawTimestamp] = line.split(/\s+/);
    const timestamp = Number(rawTimestamp || 0);
    return {
      publicKey,
      timestamp: Number.isFinite(timestamp) ? timestamp : 0,
      at: Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000).toISOString() : null
    };
  });
  const newest = latest.reduce((current, item) => item.timestamp > current.timestamp ? item : current, {
    publicKey: null,
    timestamp: 0,
    at: null
  });
  return {
    status: newest.timestamp > 0 ? 'passed' : rows.length > 0 ? 'blocked' : 'missing',
    newest,
    peers: latest
  };
}

function proxyBypassStatus() {
  const noProxy = process.env.NO_PROXY || '';
  const lowerNoProxy = process.env.no_proxy || '';
  const entries = [...new Set([...csvEntries(noProxy), ...csvEntries(lowerNoProxy)])];
  const normalizedEntries = entries.map((entry) => entry.toLowerCase());
  const missingBypass = requiredProxyBypassEntries.filter((entry) => !normalizedEntries.includes(entry.toLowerCase()));
  return {
    status: missingBypass.length ? 'ready' : 'passed',
    noProxy: noProxy || null,
    lowerNoProxy: lowerNoProxy || null,
    autofill: proxyBypassEnv,
    requiredBypass: requiredProxyBypassEntries,
    missingBypass,
    clashTunCompatibility: missingBypass.length
      ? 'proxy-env-bypass-missing; split-dns/direct-rules-required'
      : 'proxy-env-bypass-ready',
    splitDns: {
      status: 'planned',
      authority: 'Internal DNS over H2I',
      internalDnsIp: '10.88.88.88',
      suffixes: splitDnsSuffixes,
      resolverHint: 'route .internal and product domains to Internal DNS once deployed',
      directCidrs: requiredProxyBypassEntries
    }
  };
}

function parseInternalEgressOnStatus(statusCommand) {
  const stdout = statusCommand?.stdout || '';
  const stderr = statusCommand?.stderr || '';
  const output = `${stdout}\n${stderr}`;
  const serviceActive = /Active:\s+active\s+\(running\)/.test(output);
  const shellProxyEnabled = /Shell proxy profile:\s+enabled/.test(output);
  const sshProxyEnabled = /SSH proxy config:\s+enabled/.test(output);
  const daemonProxyMatch = /Managed daemon proxy services:\s*([^\n]+)/.exec(output);
  const daemonProxyServices = daemonProxyMatch?.[1]?.trim() || '';
  const daemonProxyEnabled = Boolean(daemonProxyServices && daemonProxyServices !== 'none');
  return {
    serviceActive,
    shellProxyEnabled,
    sshProxyEnabled,
    daemonProxyServices: daemonProxyServices || null,
    daemonProxyEnabled,
    ready: serviceActive && shellProxyEnabled && sshProxyEnabled && daemonProxyEnabled
  };
}

function internalEgressOnCliSupported() {
  return platform() === 'linux' && !isLinuxKitHost();
}

function internalEgressOnUnsupportedSummary() {
  if (isLinuxKitHost()) return 'linuxkit container host; native Internal egress-on must run on the real host';
  if (platform() === 'darwin') return 'darwin host; native Internal WG is managed by LaunchDaemon, mac egress-on daemon is not required for H2I handoff';
  return `${platform()} host; qp-tunnel-cli egress-on is not supported by this CLI runtime`;
}

async function buildInternalEgressOnStatus(tools, artifacts) {
  const qpTunnelCliPath = tools.qpTunnelCli?.path || null;
  const subscriptionPath = artifacts.internalEgressSubscriptionPath || defaultInternalEgressSubscriptionPath;
  const subscriptionExists = Boolean(artifacts.internalEgressSubscriptionExists);
  const supported = internalEgressOnCliSupported();
  const forcedRequired = process.env.MX_INTERNAL_EGRESS_ON_REQUIRED === '1';
  const required = forcedRequired || supported;
  const egressEnv = internalEgressCommandEnv();
  const installCommand = subscriptionExists && qpTunnelCliPath
    ? `sudo ${displayCommand(qpTunnelCliPath, ['install', '--file', subscriptionPath], egressEnv)}`
    : null;
  const enableCommand = qpTunnelCliPath
    ? `sudo ${displayCommand(qpTunnelCliPath, ['egress-on'], egressEnv)}`
    : 'sudo qp-tunnel-cli egress-on';

  if (!supported) {
    const summary = internalEgressOnUnsupportedSummary();
    return {
      status: forcedRequired ? 'blocked' : 'ready',
      mode: 'qp-tunnel-cli-egress-on',
      supported: false,
      required: forcedRequired,
      subscriptionPath,
      subscriptionExists,
      env: egressEnv,
      serviceName: egressEnv.MIHOMO_SERVICE_NAME,
      home: egressEnv.MIHOMO_HOME,
      installCommand,
      enableCommand,
      summary,
      statusCommand: null,
      blockedReasons: forcedRequired ? [summary] : []
    };
  }

  if (!tools.qpTunnelCli?.available || !qpTunnelCliPath) {
    return {
      status: 'blocked',
      mode: 'qp-tunnel-cli-egress-on',
      supported: true,
      required: true,
      subscriptionPath,
      subscriptionExists,
      env: egressEnv,
      serviceName: egressEnv.MIHOMO_SERVICE_NAME,
      home: egressEnv.MIHOMO_HOME,
      installCommand,
      enableCommand,
      summary: 'qp-tunnel-cli missing',
      statusCommand: null,
      blockedReasons: ['Internal qp-tunnel-cli egress-on requires qp-tunnel-cli on the Internal runtime host']
    };
  }

  const statusInvocation = privilegedCommand(qpTunnelCliPath, ['status'], egressEnv);
  const statusCommand = await runCommand(statusInvocation.command, statusInvocation.args, 8000);
  const parsed = parseInternalEgressOnStatus(statusCommand);
  const systemctlMissing = /Required command not found:\s*systemctl/.test(`${statusCommand.stdout}\n${statusCommand.stderr}`);
  const status = parsed.ready
    ? 'passed'
    : systemctlMissing
      ? 'blocked'
      : 'ready';
  const summary = parsed.ready
    ? 'egress-on active'
    : systemctlMissing
      ? 'systemctl missing on runner host'
      : subscriptionExists
        ? 'egress-on not active; install/restart can enable it'
        : 'egress-on not active; subscription artifact missing unless host is already configured';
  return {
    status,
    mode: 'qp-tunnel-cli-egress-on',
    supported: true,
    required: true,
    subscriptionPath,
    subscriptionExists,
    env: egressEnv,
    serviceName: egressEnv.MIHOMO_SERVICE_NAME,
    home: egressEnv.MIHOMO_HOME,
    installCommand,
    enableCommand,
    summary,
    statusCommand,
    parsed,
    blockedReasons: status === 'blocked' ? [summary] : []
  };
}

function syncArtifacts(payload) {
  const artifacts = asRecord(payload.artifacts);
  mkdirSync(artifactRoot, { recursive: true });
  const configContent = typeof artifacts.configContent === 'string' ? artifacts.configContent : '';
  const applyScriptContent = typeof artifacts.applyScriptContent === 'string' ? artifacts.applyScriptContent : '';
  const internalEgressSubscriptionContent = typeof artifacts.internalEgressSubscriptionContent === 'string'
    ? artifacts.internalEgressSubscriptionContent
    : typeof artifacts.egressSubscriptionContent === 'string'
      ? artifacts.egressSubscriptionContent
      : '';
  if (configContent) {
    writeFileSync(defaultConfigPath, configContent, { mode: 0o600 });
    chmodSync(defaultConfigPath, 0o600);
  }
  if (applyScriptContent) {
    writeFileSync(defaultApplyScriptPath, applyScriptContent, { mode: 0o755 });
    chmodSync(defaultApplyScriptPath, 0o755);
  }
  if (internalEgressSubscriptionContent) {
    writeFileSync(defaultInternalEgressSubscriptionPath, internalEgressSubscriptionContent, { mode: 0o600 });
    chmodSync(defaultInternalEgressSubscriptionPath, 0o600);
  }
  return {
    configPath: defaultConfigPath,
    configExists: existsSync(defaultConfigPath),
    applyScriptPath: defaultApplyScriptPath,
    applyScriptExists: existsSync(defaultApplyScriptPath),
    internalEgressSubscriptionPath: defaultInternalEgressSubscriptionPath,
    internalEgressSubscriptionExists: existsSync(defaultInternalEgressSubscriptionPath),
    syncedFromApi: Boolean(configContent || applyScriptContent || internalEgressSubscriptionContent)
  };
}

function runtimeConfigPath(interfaceName) {
  return join(artifactRoot, `${interfaceName}.conf`);
}

function prepareRuntimeConfigArtifact(artifacts, interfaceName) {
  const targetPath = runtimeConfigPath(interfaceName);
  if (artifacts.configExists) {
    if (targetPath !== artifacts.configPath) {
      writeFileSync(targetPath, readFileSync(artifacts.configPath), { mode: 0o600 });
      chmodSync(targetPath, 0o600);
    } else {
      chmodSync(targetPath, 0o600);
    }
  }
  return {
    ...artifacts,
    runtimeConfigPath: targetPath,
    runtimeConfigExists: existsSync(targetPath)
  };
}

async function buildStatus(payload) {
  const interfaceName = stringValue(payload.interfaceName, defaultInterfaceName);
  const artifacts = prepareRuntimeConfigArtifact(syncArtifacts(payload), interfaceName);
  const configReadiness = internalServicePeerConfigReadiness(artifacts);
  const domesticGatewayIp = stringValue(payload.domesticGatewayIp, '10.88.0.1');
  const internalServiceIp = stringValue(payload.internalServiceIp, '10.88.88.88');
  const tools = {
    wg: await commandPath('wg'),
    wgQuick: await commandPath('wg-quick'),
    systemctl: await commandPath('systemctl'),
    ip: await commandPath('ip'),
    ping: await commandPath('ping'),
    qpTunnelCli: await commandPath('qp-tunnel-cli')
  };
  const proxy = proxyBypassStatus();
  const internalEgress = await buildInternalEgressOnStatus(tools, artifacts);
  const wireGuardCore = buildWireGuardCoreStatus(tools, artifacts);
  const wireGuardProbeCommand = wireGuardCore.runtime?.wg?.available
    ? wireGuardCore.runtime.wg.command
    : null;
  const wireGuardProbeName = wireGuardProbeInterfaceName(wireGuardCore, interfaceName);
  const skipWireGuardProbe = shouldSkipWireGuardCliProbe(wireGuardCore);
  const wgShow = wireGuardProbeCommand
    ? skipWireGuardProbe
      ? wireGuardCliProbeSkippedResult(
          wireGuardProbeCommand,
          ['show', wireGuardProbeName],
          'macOS userspace WireGuard requires elevated access for wg show; using LaunchDaemon and route probes'
        )
      : await runCommand(wireGuardProbeCommand, ['show', wireGuardProbeName], 3000)
    : null;
  const latestHandshakes = wireGuardProbeCommand
    ? skipWireGuardProbe
      ? wireGuardCliProbeSkippedResult(
          wireGuardProbeCommand,
          ['show', wireGuardProbeName, 'latest-handshakes'],
          'macOS userspace WireGuard requires elevated access for latest-handshakes'
        )
      : await runCommand(wireGuardProbeCommand, ['show', wireGuardProbeName, 'latest-handshakes'], 3000)
    : null;
  const routeToDomestic = tools.ip.available
    ? await runCommand(tools.ip.path || 'ip', ['route', 'get', domesticGatewayIp], 3000)
    : await runCommand('route', ['-n', 'get', domesticGatewayIp], 3000);
  const domesticGatewayPing = tools.ping.available
    ? await runCommand(tools.ping.path || 'ping', ['-c', '1', domesticGatewayIp], 3000)
    : null;
  const internalHealthz = await healthProbe(`http://${internalServiceIp}:18090/healthz`, 3000);
  const handshake = latestHandshakes?.status === 'not-checked'
    ? {
        status: 'not-checked',
        newest: { publicKey: null, timestamp: 0, at: null },
        peers: []
      }
    : parseHandshake(latestHandshakes?.stdout || '');
  const blockedReasons = [
    ...configReadiness.blockedReasons,
    ...(!artifacts.applyScriptExists ? [`Internal service peer apply script is missing: ${artifacts.applyScriptPath}`] : []),
    ...(internalEgress.status === 'blocked' ? internalEgress.blockedReasons : []),
    ...(!wireGuardCore.available
      ? [wireGuardCore.error
          ? `WireGuard runtime is unavailable on the Internal runtime host: ${wireGuardCore.error}`
          : 'WireGuard runtime is unavailable on the Internal runtime host']
      : [])
  ];
  const coreTunnelReady = wireGuardCore.tunnel?.active === true
    && (!Array.isArray(wireGuardCore.tunnel?.missingRoutes) || wireGuardCore.tunnel.missingRoutes.length === 0);
  const interfaceReady = wgShow?.status === 'passed' || coreTunnelReady;
  const linkReady = handshake.status === 'passed' || domesticGatewayPing?.status === 'passed';
  const healthReady = internalHealthz.status === 'passed';
  const wireGuardRuntimeBlocked = wireGuardCore.status === 'blocked';
  const status = blockedReasons.length > 0 || wireGuardRuntimeBlocked
    ? 'blocked'
    : interfaceReady && linkReady && healthReady
      ? 'passed'
      : 'ready';
  const installMethod = wireGuardCore.available ? 'electron-core-wireguard' : 'unavailable';
  return {
    status,
    mode: 'internal-service-peer-host-runner-status',
    siteId: stringValue(payload.siteId, null),
    planId: stringValue(payload.planId, null),
    host: {
      hostname: hostname(),
      platform: platform(),
      release: release()
    },
    interfaceName,
    domesticGatewayIp,
    internalServiceIp,
    runtimeTarget: {
      mode: 'host-runner',
      boundary: 'host-runner-local-runtime',
      hostRunner: {
        configured: true,
        url: runnerUrl,
        installCommand: nativeHostRunnerInstallCommand,
        startCommand: nativeHostRunnerStartCommand,
        legacyForegroundCommand: legacyHostRunnerStartCommand
      },
      apiRuntime: asRecord(payload.apiRuntime)
    },
    tools,
    internalEgress,
    proxy,
    configReadiness,
    wireGuardCore,
    artifacts,
    interface: {
      name: interfaceName,
      realName: wireGuardProbeName,
      publicKey: wireGuardCore.publicKey || null,
      publicKeySource: wireGuardCore.publicKeySource || null,
      wgShow,
      latestHandshakes,
      handshake
    },
    link: {
      routeToDomestic,
      domesticGatewayPing,
      internalHealthz
    },
    install: {
      available: blockedReasons.length === 0,
      method: installMethod,
      applyCommand: `bash scripts/manage.sh ops site-slot internal-service-peer-handoff apply`,
      hostRunnerCommand: nativeHostRunnerInstallCommand,
      requires: [
        'qp-tunnel-cli egress-on on the Internal runtime host for H2O/outbound bootstrap',
        'qp-tunnel-cli with @qpjoy/electron-core-wireguard on the Internal runtime host',
        'sudo/root privilege on the Internal runtime host'
      ],
      blockedReasons
    },
    blockedReasons,
    checkedAt: new Date().toISOString()
  };
}

async function applyWithWireGuardCore(beforeStatus) {
  const resolved = resolveWireGuardCoreRuntime(beforeStatus.tools?.qpTunnelCli?.path);
  if (!resolved.runtime?.available) {
    return {
      status: 'blocked',
      execution: 'not-started',
      mode: 'electron-core-wireguard',
      command: null,
      exitCode: null,
      stdout: '',
      stderr: resolved.error || 'WireGuard runtime is unavailable on the Internal runtime host',
      coreResult: null
    };
  }

  const input = {
    runtime: resolved.runtime,
    configPath: beforeStatus.artifacts.runtimeConfigPath || beforeStatus.artifacts.configPath,
    serviceIdentity: internalWireGuardServiceIdentity()
  };
  const useDarwinLaunchDaemon = resolved.runtime.platform === 'darwin'
    && resolved.runtime.method === 'darwin-userspace'
    && typeof resolved.module?.installDarwinWireGuardLaunchDaemon === 'function';
  const result = useDarwinLaunchDaemon
    ? await resolved.module.installDarwinWireGuardLaunchDaemon(input)
    : await resolved.module.setWireGuardTunnelState({ ...input, action: 'restart' });
  const summary = wireGuardCoreApplySummary(result);
  return {
    status: result?.ok ? 'passed' : 'failed',
    execution: result?.ok ? 'completed' : 'failed',
    mode: useDarwinLaunchDaemon ? 'electron-core-wireguard-darwin-launchdaemon' : 'electron-core-wireguard',
    command: summary?.command || null,
    exitCode: result?.ok ? 0 : 1,
    stdout: summary?.stdout || '',
    stderr: summary?.stderr || summary?.message || '',
    coreResult: summary
  };
}

async function ensureInternalEgressOn(beforeStatus) {
  const egressStatus = beforeStatus.internalEgress || {};
  const egressEnv = egressStatus.env || internalEgressCommandEnv();
  if (egressStatus.supported === false) {
    return {
      status: 'skipped',
      execution: 'skipped',
      mode: 'qp-tunnel-cli-egress-on',
      command: null,
      exitCode: 0,
      stdout: egressStatus.summary || 'qp-tunnel-cli egress-on is not supported on this host runtime',
      stderr: '',
      steps: []
    };
  }
  const qpTunnelCliPath = beforeStatus.tools?.qpTunnelCli?.path || null;
  if (!qpTunnelCliPath) {
    return {
      status: 'blocked',
      execution: 'not-started',
      mode: 'qp-tunnel-cli-egress-on',
      command: null,
      exitCode: null,
      stdout: '',
      stderr: 'qp-tunnel-cli is required before enabling Internal egress-on',
      steps: []
    };
  }
  const steps = [];
  if (beforeStatus.artifacts?.internalEgressSubscriptionExists) {
    const installInvocation = privilegedCommand(qpTunnelCliPath, [
      'install',
      '--file',
      beforeStatus.artifacts.internalEgressSubscriptionPath
    ], egressEnv);
    const installExecution = await runCommand(installInvocation.command, installInvocation.args, 120000);
    steps.push({ step: 'install-subscription', ...installExecution });
    if (installExecution.status !== 'passed') {
      return {
        status: 'failed',
        execution: 'failed',
        mode: 'qp-tunnel-cli-egress-on',
        command: `${installInvocation.command} ${installInvocation.args.map(shellQuote).join(' ')}`,
        exitCode: installExecution.exitCode,
        stdout: installExecution.stdout,
        stderr: installExecution.stderr,
        steps
      };
    }
  }

  const egressInvocation = privilegedCommand(qpTunnelCliPath, ['egress-on'], egressEnv);
  const egressExecution = await runCommand(egressInvocation.command, egressInvocation.args, 120000);
  steps.push({ step: 'egress-on', ...egressExecution });
  return {
    status: egressExecution.status === 'passed' ? 'passed' : 'failed',
    execution: egressExecution.status === 'passed' ? 'completed' : 'failed',
    mode: 'qp-tunnel-cli-egress-on',
    command: `${egressInvocation.command} ${egressInvocation.args.map(shellQuote).join(' ')}`,
    exitCode: egressExecution.exitCode,
    stdout: egressExecution.stdout,
    stderr: egressExecution.stderr,
    steps
  };
}

async function applyServicePeer(payload) {
  const beforeStatus = await buildStatus(payload);
  const confirm = boolValue(payload.confirmInternalServicePeerApply);
  const blockedReasons = [
    ...(!confirm ? ['confirmInternalServicePeerApply=true is required before installing the service'] : []),
    ...beforeStatus.blockedReasons
  ];
  if (blockedReasons.length > 0) {
    return {
      status: 'blocked',
      execution: 'not-started',
      mode: 'internal-service-peer-host-runner-apply',
      siteId: beforeStatus.siteId,
      planId: beforeStatus.planId,
      command: null,
      exitCode: null,
      stdout: '',
      stderr: blockedReasons.join('\n'),
      beforeStatus,
      afterStatus: beforeStatus,
      blockedReasons,
      finishedAt: new Date().toISOString()
    };
  }

  const internalEgressApply = await ensureInternalEgressOn(beforeStatus);
  if (internalEgressApply.status === 'blocked' || internalEgressApply.status === 'failed') {
    const afterStatus = await buildStatus(payload);
    return {
      status: internalEgressApply.status,
      execution: internalEgressApply.execution,
      mode: 'internal-service-peer-host-runner-apply',
      siteId: beforeStatus.siteId,
      planId: beforeStatus.planId,
      command: internalEgressApply.command,
      exitCode: internalEgressApply.exitCode,
      stdout: internalEgressApply.stdout,
      stderr: internalEgressApply.stderr,
      internalEgressApply,
      beforeStatus,
      afterStatus,
      blockedReasons: internalEgressApply.status === 'blocked'
        ? [internalEgressApply.stderr || 'Internal qp-tunnel-cli egress-on is blocked']
        : afterStatus.blockedReasons,
      finishedAt: new Date().toISOString()
    };
  }

  const shouldUseWireGuardCore = beforeStatus.wireGuardCore?.available;
  if (shouldUseWireGuardCore) {
    const execution = await applyWithWireGuardCore(beforeStatus);
    const afterStatus = await buildStatus(payload);
    const status = execution.status === 'passed'
      ? afterStatus.status === 'passed' ? 'passed' : 'ready'
      : execution.status;
    return {
      status,
      execution: execution.execution,
      mode: execution.mode,
      siteId: beforeStatus.siteId,
      planId: beforeStatus.planId,
      command: execution.command,
      exitCode: execution.exitCode,
      stdout: execution.stdout,
      stderr: execution.stderr,
      internalEgressApply,
      wireGuardCoreApply: execution.coreResult,
      beforeStatus,
      afterStatus,
      blockedReasons: status === 'passed' ? [] : afterStatus.blockedReasons,
      finishedAt: new Date().toISOString()
    };
  }

  const interfaceName = beforeStatus.interfaceName;
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const command = isRoot ? 'env' : 'sudo';
  const args = isRoot
    ? [`MX_INTERNAL_SERVICE_WG_INTERFACE=${interfaceName}`, 'bash', defaultApplyScriptPath, defaultConfigPath]
    : ['-n', 'env', `MX_INTERNAL_SERVICE_WG_INTERFACE=${interfaceName}`, 'bash', defaultApplyScriptPath, defaultConfigPath];
  const execution = await runCommand(command, args, 60000);
  const afterStatus = await buildStatus(payload);
  const status = execution.status === 'passed'
    ? afterStatus.status === 'passed' ? 'passed' : 'ready'
    : 'failed';
  return {
    status,
    execution: execution.status === 'passed' ? 'completed' : 'failed',
    mode: 'internal-service-peer-host-runner-apply',
    siteId: beforeStatus.siteId,
    planId: beforeStatus.planId,
    command: `${command} ${args.map(shellQuote).join(' ')}`,
    exitCode: execution.exitCode,
    stdout: execution.stdout,
    stderr: execution.stderr,
    internalEgressApply,
    beforeStatus,
    afterStatus,
    blockedReasons: status === 'passed' ? [] : afterStatus.blockedReasons,
    finishedAt: new Date().toISOString()
  };
}

async function syncDirectPeer(payload) {
  const beforeStatus = await buildStatus(payload);
  const peerPublicKey = stringValue(payload.peerPublicKey, null);
  const peerAllowedIp = stringValue(payload.peerAllowedIp, null);
  const leaseId = stringValue(payload.leaseId, null);
  const blockedReasons = [
    ...(!validWireGuardPublicKey(peerPublicKey) ? ['peerPublicKey is not a valid WireGuard public key'] : []),
    ...(!validSingleHostCidr(peerAllowedIp) ? ['peerAllowedIp must be an IPv4 /32 CIDR'] : []),
    ...(!beforeStatus.artifacts?.runtimeConfigExists ? [`Internal service runtime config is missing: ${beforeStatus.artifacts?.runtimeConfigPath || beforeStatus.artifacts?.configPath || 'unknown'}`] : []),
    ...(!beforeStatus.wireGuardCore?.available ? ['WireGuard runtime is unavailable on the Internal runtime host'] : [])
  ];
  if (blockedReasons.length > 0) {
    return {
      status: 'blocked',
      execution: 'not-started',
      mode: 'internal-service-peer-direct-peer-sync',
      siteId: beforeStatus.siteId,
      planId: beforeStatus.planId,
      leaseId,
      peerPublicKey,
      peerAllowedIp,
      beforeStatus,
      afterStatus: beforeStatus,
      blockedReasons,
      finishedAt: new Date().toISOString()
    };
  }

  const configPath = beforeStatus.artifacts.runtimeConfigPath || beforeStatus.artifacts.configPath;
  const configPaths = mergeCsvEntries([
    beforeStatus.artifacts.configPath,
    beforeStatus.artifacts.runtimeConfigPath
  ].filter(Boolean));
  let changed = false;
  for (const targetPath of configPaths) {
    if (!existsSync(targetPath)) continue;
    const previousConfig = readFileSync(targetPath, 'utf8');
    const nextConfig = upsertManagedHomePeerConfig(previousConfig, {
      publicKey: peerPublicKey,
      allowedIp: peerAllowedIp,
      leaseId,
      requestedBy: stringValue(payload.requestedBy, 'launcher-network')
    });
    if (nextConfig === previousConfig) continue;
    writeFileSync(targetPath, nextConfig, { mode: 0o600 });
    chmodSync(targetPath, 0o600);
    changed = true;
  }
  if (!changed) {
    const afterStatus = await buildStatus(payload);
    const status = afterStatus.status === 'passed' ? 'passed' : afterStatus.status;
    return {
      status,
      execution: 'not-needed',
      mode: 'internal-service-peer-direct-peer-sync',
      siteId: beforeStatus.siteId,
      planId: beforeStatus.planId,
      leaseId,
      peerPublicKey,
      peerAllowedIp,
      configPath,
      changed,
      beforeStatus,
      afterStatus,
      blockedReasons: status === 'passed' ? [] : [`Internal service peer is ${status}`],
      finishedAt: new Date().toISOString()
    };
  }
  const execution = await applyWithWireGuardCore(beforeStatus);
  const afterStatus = await buildStatus(payload);
  const status = execution.status === 'passed' ? 'passed' : execution.status;
  return {
    status,
    execution: execution.execution,
    mode: 'internal-service-peer-direct-peer-sync',
    siteId: beforeStatus.siteId,
    planId: beforeStatus.planId,
    leaseId,
    peerPublicKey,
    peerAllowedIp,
    configPath,
    changed,
    command: execution.command,
    exitCode: execution.exitCode,
    stdout: execution.stdout,
    stderr: execution.stderr,
    beforeStatus,
    afterStatus,
    blockedReasons: status === 'passed' ? [] : [execution.stderr || execution.status || 'direct peer sync failed'],
    finishedAt: new Date().toISOString()
  };
}

function validSingleHostCidr(value) {
  if (typeof value !== 'string' || !value.trim().endsWith('/32')) return false;
  const ip = value.trim().slice(0, -3);
  const parts = ip.split('.');
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const number = Number(part);
    return Number.isInteger(number) && number >= 0 && number <= 255;
  });
}

function upsertManagedHomePeerConfig(config, peer) {
  const nextBlock = [
    '# MX-H2I managed home peer begin',
    `# lease_id = ${peer.leaseId || 'unknown'}`,
    `# requested_by = ${peer.requestedBy || 'launcher-network'}`,
    '[Peer]',
    `PublicKey = ${peer.publicKey}`,
    `AllowedIPs = ${peer.allowedIp}`,
    '# MX-H2I managed home peer end'
  ].join('\n');
  const withoutExisting = String(config || '')
    .replace(/\n?# MX-H2I managed home peer begin\n[\s\S]*?# MX-H2I managed home peer end\n?/g, (block) => {
      if (block.includes(`PublicKey = ${peer.publicKey}`) || block.includes(`AllowedIPs = ${peer.allowedIp}`)) return '\n';
      return block;
    })
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
  return `${withoutExisting}\n\n${nextBlock}\n`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.trim() ? JSON.parse(raw) : {};
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function checkToken(req) {
  const expected = process.env.MX_INTERNAL_HOST_RUNNER_TOKEN?.trim();
  if (!expected) return true;
  return req.headers['x-mx-host-runner-token'] === expected;
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/healthz') {
      sendJson(res, 200, { status: 'ok', mode: 'internal-service-peer-host-runner', url: runnerUrl });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    if (!checkToken(req)) {
      sendJson(res, 401, { error: 'Invalid host runner token' });
      return;
    }
    const payload = asRecord(await readJson(req));
    if (req.url === '/internal-service-peer/status') {
      sendJson(res, 200, { runtimeStatus: await buildStatus(payload) });
      return;
    }
    if (req.url === '/internal-service-peer/apply') {
      sendJson(res, 200, { applyResult: await applyServicePeer(payload) });
      return;
    }
    if (req.url === '/internal-service-peer/direct-peer-sync') {
      sendJson(res, 200, { directPeerSync: await syncDirectPeer(payload) });
      return;
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, host, () => {
  console.log(`Internal service peer host runner listening at ${runnerUrl}`);
  console.log(`Artifact root: ${artifactRoot}`);
});
