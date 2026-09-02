import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createSocket, type RemoteInfo, type Socket as DgramSocket } from 'node:dgram';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import {
  buildElectronLauncherNetworkOwnershipRegistry,
  mergedElectronLauncherDnsZones,
  mergedElectronLauncherReverseProxyRoutes,
  resolveElectronLauncherDnsOwner,
  type ElectronLauncherNetworkOwnershipClaim,
  type ElectronLauncherNetworkOwnershipRegistry
} from './network-ownership-registry.js';
import {
  acquireElectronLauncherProcessLease,
  ElectronLauncherProcessLeaseBusyError,
  releaseElectronLauncherProcessLease,
  type ElectronLauncherProcessLease
} from './process-lease.js';
import {
  currentDarwinCleanupOnlyServices,
  currentDarwinExternalApplyPhase,
  currentDarwinResolverDomains,
  darwinExternalApplyAbortAllowed,
  darwinPacVerificationRowsReady,
  intersectDarwinManagedServiceNames,
  mergeDarwinPreviousState,
  type DarwinExternalApplyPhase
} from './darwin-system-domain-proxy-state.js';
import { windowsPowerShellCommand } from './windows-command.js';

const STATE_VERSION = 1;
const DEFAULT_STATE_FILE = 'electron-launcher-system-domain-proxy.json';
const PAC_PATH = '/proxy.pac';
const SHARED_STATUS_PATH = '/__electron-launcher/domain-proxy/status';
const SHARED_APPLY_PATH = '/__electron-launcher/domain-proxy/apply';
const SHARED_RELEASE_PATH = '/__electron-launcher/domain-proxy/release';
const PAC_MARKER = 'MX_ELECTRON_LAUNCHER_PAC';
const DARWIN_RESOLVER_MARKER = 'MX_ELECTRON_LAUNCHER_RESOLVER';
const DARWIN_RESOLVER_DIR = '/etc/resolver';
const DARWIN_DYNAMIC_DNS_KEY = 'State:/Network/Service/com.qpjoy.electron-launcher.domain-proxy/DNS';
const WINDOWS_PROXY_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const DNS_QUERY_TIMEOUT_MS = 1500;
const PROXY_CONNECT_TIMEOUT_MS = 10_000;
// captureWindowsState() spawns five reg.exe processes at once every background
// continuation refresh. Process creation on a machine under load or real-time
// AV scanning routinely passed 2.5 s, and a timed-out query is re-thrown rather
// than retried, so the refresh reported a hard error for what was only a slow
// read. Give the spawn room; a slow refresh just skips the next tick, because
// systemDomainProxyRefreshInFlight already serializes them.
const WINDOWS_REGISTRY_COMMAND_TIMEOUT_MS = 6000;
const WINDOWS_PROXY_NOTIFY_TIMEOUT_MS = 5000;
const WINDOWS_BROWSER_PROXY_PROBE_TIMEOUT_MS = 12_000;
const WINDOWS_FALLBACK_PAC_TIMEOUT_MS = 1800;
const WINDOWS_FALLBACK_PAC_MAX_BYTES = 512 * 1024;
const WINDOWS_CURRENT_USER_GATE_FILE = 'windows-system-domain-proxy-owner-v1.json';
const INTERNAL_GATEWAY_APP_PORTS = new Set([80, 8008]);
let stateWriteSequence = 0;

export type ElectronLauncherPacMatchMode = 'direct' | 'proxy';
export type ElectronLauncherSystemResolverMode = 'off' | 'dynamic' | 'file';

export interface ElectronLauncherSystemDomainProxyPolicy {
  enabled?: boolean;
  domains?: string[] | null;
  pacUrl?: string | null;
  proxy?: string | null;
  matchMode?: ElectronLauncherPacMatchMode | null;
  fallbackProxy?: string | null;
  pacPort?: number | null;
  dnsServers?: string[] | null;
  dnsFallbackTarget?: string | null;
  systemResolver?: boolean | ElectronLauncherSystemResolverMode | null;
  reverseProxyRoutes?: ElectronLauncherSystemDomainProxyRoute[] | null;
  ownershipClaim?: ElectronLauncherNetworkOwnershipClaim | null;
}

export interface ElectronLauncherSystemDomainProxyOptions {
  userDataDir: string;
  statePath?: string;
  pacPort?: number | null;
  log?: Pick<Console, 'warn'> | null;
}

export interface ElectronLauncherSystemDomainProxyApplyOptions {
  forceDarwinRefresh?: boolean;
}

export interface ElectronLauncherSystemDomainProxyStatus {
  supported: boolean;
  applied: boolean;
  platform: NodeJS.Platform;
  pacUrl?: string | null;
  proxy?: string | null;
  matchMode?: ElectronLauncherPacMatchMode | null;
  fallbackProxy?: string | null;
  fallbackPacUrl?: string | null;
  pacPort?: number | null;
  sharedPac?: boolean;
  dnsServers?: string[];
  dnsFallbackTarget?: string | null;
  systemResolver?: boolean;
  systemResolverMode?: ElectronLauncherSystemResolverMode;
  resolverDomains?: string[];
  resolverPort?: number | null;
  resolverApplied?: boolean;
  resolverError?: string | null;
  domains?: string[];
  reverseProxyRoutes?: ElectronLauncherSystemDomainProxyRoute[];
  ownershipRegistry?: ElectronLauncherNetworkOwnershipRegistry | null;
  updatedAt?: string | null;
  changed?: boolean;
  verified?: boolean;
  actual?: unknown;
  reason?: string;
  restored?: boolean;
  skipped?: boolean;
  staleState?: boolean;
  orphanCleanup?: boolean;
  pending?: boolean;
  externalApply?: boolean;
  darwinApplyShell?: string | null;
  transactionToken?: string | null;
  externalApplyPhase?: DarwinExternalApplyPhase | null;
  error?: string;
  skipReason?: string;
  localEdgeResumed?: boolean;
}

export type ElectronLauncherExternalApplyAbortExecution =
  | 'not-started'
  | 'authorization-canceled';

export interface ElectronLauncherExternalApplyAbortOptions {
  execution: ElectronLauncherExternalApplyAbortExecution;
  reason?: string;
}

export interface ElectronLauncherBrowserAccessStatus {
  supported: boolean;
  ready: boolean;
  platform: NodeJS.Platform;
  host: string | null;
  port: number | null;
  pacApplied: boolean;
  proxyReachable: boolean;
  proxyStatusCode?: number | null;
  proxyStatusLine?: string | null;
  pacUrl?: string | null;
  proxy?: string | null;
  skipped?: boolean;
  error?: string | null;
}

export interface ElectronLauncherPacProxy {
  address: string;
  directive: string;
}

export interface ElectronLauncherSystemDomainProxyRoute {
  routeId?: string | null;
  host: string;
  dnsTarget?: string | null;
  targetUrl?: string | null;
  tlsMode?: 'internal' | 'passthrough' | 'edge-terminated' | null;
  authRequired?: boolean | null;
  enabled?: boolean | null;
}

export interface ElectronLauncherSystemDomainProxyManager {
  apply(
    policy: ElectronLauncherSystemDomainProxyPolicy,
    options?: ElectronLauncherSystemDomainProxyApplyOptions
  ): Promise<ElectronLauncherSystemDomainProxyStatus>;
  disable(
    reason?: string,
    options?: { keepLocalEdgeAlive?: boolean }
  ): Promise<ElectronLauncherSystemDomainProxyStatus>;
  restoreStale(reason?: string): Promise<ElectronLauncherSystemDomainProxyStatus>;
  prepareExternalApply?(
    policy: ElectronLauncherSystemDomainProxyPolicy
  ): Promise<ElectronLauncherSystemDomainProxyStatus>;
  abortExternalApply?(
    transactionToken: string,
    options: ElectronLauncherExternalApplyAbortOptions
  ): Promise<ElectronLauncherSystemDomainProxyStatus>;
  markExternalApplyHandoff?(
    transactionToken: string
  ): ElectronLauncherSystemDomainProxyStatus;
  darwinPrepareApply?(policy: ElectronLauncherSystemDomainProxyPolicy): Promise<ElectronLauncherSystemDomainProxyStatus>;
  completeExternalApply?(
    transactionToken: string,
    reason?: string
  ): Promise<ElectronLauncherSystemDomainProxyStatus>;
  darwinRestoreScript?(): string | null;
  completeExternalRestore?(reason?: string): Promise<ElectronLauncherSystemDomainProxyStatus>;
  status(): ElectronLauncherSystemDomainProxyStatus;
  statusVerified(): Promise<ElectronLauncherSystemDomainProxyStatus>;
  resumeDarwinLocalEdge?(
    policy: ElectronLauncherSystemDomainProxyPolicy,
    reason?: string
  ): Promise<ElectronLauncherSystemDomainProxyStatus>;
  refreshWindowsContinuation?(reason?: string): Promise<ElectronLauncherSystemDomainProxyStatus>;
  probeBrowserAccess(input: {
    host: string;
    port?: number | null;
    timeoutMs?: number | null;
  }): Promise<ElectronLauncherBrowserAccessStatus>;
  close(): Promise<void>;
}

type PacProxy = ElectronLauncherPacProxy;

interface ResolvedPacSource {
  pacUrl: string;
  domains: string[];
  proxy: PacProxy | null;
  matchMode: ElectronLauncherPacMatchMode;
  fallbackProxy: PacProxy | null;
  fallbackPacUrl: string | null;
  fallbackPacScript: string | null;
  staleWindowsPacIgnored?: boolean;
  pacPort: number | null;
  sharedLocalPac: boolean;
  dnsServers: string[];
  dnsFallbackTarget: string | null;
  systemResolverMode: ElectronLauncherSystemResolverMode;
  reverseProxyRoutes: ElectronLauncherSystemDomainProxyRoute[];
  ownershipClaim: ElectronLauncherNetworkOwnershipClaim | null;
  ownershipClaims: ElectronLauncherNetworkOwnershipClaim[];
  usesLocalPac: boolean;
}

interface StoredState {
  version: number;
  applied: boolean;
  platform: NodeJS.Platform;
  pacUrl: string;
  proxy: string | null;
  matchMode: ElectronLauncherPacMatchMode;
  fallbackProxy: string | null;
  fallbackPacUrl?: string | null;
  pacPort: number | null;
  sharedLocalPac?: boolean;
  dnsServers: string[];
  dnsFallbackTarget?: string | null;
  systemResolver?: boolean;
  systemResolverMode?: ElectronLauncherSystemResolverMode;
  resolverDomains?: string[];
  resolverPort?: number | null;
  resolverApplied?: boolean;
  resolverError?: string | null;
  domains: string[];
  reverseProxyRoutes?: ElectronLauncherSystemDomainProxyRoute[];
  ownershipClaim?: ElectronLauncherNetworkOwnershipClaim | null;
  ownershipRegistry?: ElectronLauncherNetworkOwnershipRegistry | null;
  previous: unknown;
  pending?: boolean;
  externalTransactionToken?: string;
  externalTransactionPhase?: DarwinExternalApplyPhase;
  continuationNotifyPending?: boolean;
  updatedAt: string;
}

interface LocalPacServerConfig {
  domains: string[];
  proxy: PacProxy | null;
  matchMode: ElectronLauncherPacMatchMode;
  fallbackProxy: PacProxy | null;
  fallbackPacUrl: string | null;
  fallbackPacScript: string | null;
  dnsServers: string[];
  dnsFallbackTarget: string | null;
  reverseProxyRoutes: ElectronLauncherSystemDomainProxyRoute[];
  ownershipClaims: ElectronLauncherNetworkOwnershipClaim[];
}

interface PacContinuation {
  fallbackProxy: PacProxy | null;
  fallbackPacUrl: string | null;
  fallbackPacScript: string | null;
  staleWindowsPacIgnored?: boolean;
}

interface ExecTextResult {
  stdout: string;
  stderr: string;
}

interface SystemResolverApplyResult {
  mode: ElectronLauncherSystemResolverMode;
  domains: string[];
  port: number | null;
  applied: boolean;
  error?: string | null;
}

interface PreparedSystemDomainProxyApply {
  existing: StoredState | null;
  previous: unknown;
  windowsApplySnapshot: Record<string, RegistryValue> | null;
  pac: ResolvedPacSource;
  resolverPlan: {
    mode: ElectronLauncherSystemResolverMode;
    domains: string[];
    port: number | null;
  };
  next: StoredState;
  changed: boolean;
}

interface LocalEdgeSnapshot {
  server: Server | null;
  dnsServer: DgramSocket | null;
  port: number | null;
  key: string | null;
  config: LocalPacServerConfig | null;
}

interface DarwinExternalApplyTransaction {
  token: string;
  phase: DarwinExternalApplyPhase;
  beforeState: StoredState | null;
  localEdgeBefore: LocalEdgeSnapshot;
}

interface WindowsCurrentUserProxyLease {
  version: 1;
  pid: number;
  token: string;
  statePath: string;
  createdAt: string;
}

export function createElectronLauncherSystemDomainProxy(
  options: ElectronLauncherSystemDomainProxyOptions
): ElectronLauncherSystemDomainProxyManager {
  const statePath = options.statePath || join(options.userDataDir, DEFAULT_STATE_FILE);
  const log = options.log || console;
  const windowsOwnershipGatePath = windowsCurrentUserProxyGatePath();
  let windowsOwnershipGateLease: ElectronLauncherProcessLease | null = null;
  let localPacServer: Server | null = null;
  let localDnsServer: DgramSocket | null = null;
  let localPacPort: number | null = null;
  let localPacKey: string | null = null;
  let localPacConfig: LocalPacServerConfig | null = null;
  let darwinExternalApplyTransaction: DarwinExternalApplyTransaction | null = null;
  const localPacSockets = new Set<Socket>();

  function acquireWindowsOwnershipGate(): void {
    if (process.platform !== 'win32' || windowsOwnershipGateLease) return;
    windowsOwnershipGateLease = acquireWindowsCurrentUserProxyLease(
      windowsOwnershipGatePath,
      statePath
    );
  }

  function releaseWindowsOwnershipGate(): void {
    if (process.platform !== 'win32' || !windowsOwnershipGateLease) return;
    releaseElectronLauncherProcessLease(windowsOwnershipGateLease);
    windowsOwnershipGateLease = null;
  }

  function localConfigFromPac(pac: Omit<ResolvedPacSource, 'pacUrl' | 'usesLocalPac' | 'sharedLocalPac'>): LocalPacServerConfig {
    return applyOwnershipRegistryToLocalConfig({
      domains: pac.domains,
      proxy: pac.proxy,
      matchMode: pac.matchMode,
      fallbackProxy: pac.fallbackProxy,
      fallbackPacUrl: pac.fallbackPacUrl,
      fallbackPacScript: pac.fallbackPacScript,
      dnsServers: pac.dnsServers,
      dnsFallbackTarget: pac.dnsFallbackTarget,
      reverseProxyRoutes: pac.reverseProxyRoutes,
      ownershipClaims: normalizeOwnershipClaims(pac.ownershipClaim ? [pac.ownershipClaim] : [])
    });
  }

  async function closeLocalPacServer(): Promise<void> {
    const server = localPacServer;
    const dnsServer = localDnsServer;
    localPacServer = null;
    localDnsServer = null;
    localPacPort = null;
    localPacKey = null;
    localPacConfig = null;
    if (dnsServer) {
      await new Promise<void>((resolve) => dnsServer.close(() => resolve()));
    }
    if (!server) return;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const socket of localPacSockets) socket.destroy();
    localPacSockets.clear();
    await closed;
  }

  async function ensureLocalPacServer(
    pac: Omit<ResolvedPacSource, 'pacUrl' | 'usesLocalPac' | 'sharedLocalPac'>,
    serverOptions: { allowShared?: boolean } = {}
  ): Promise<{
    pacUrl: string;
    port: number;
    config?: LocalPacServerConfig | null;
    sharedLocalPac: boolean;
  }> {
    const key = JSON.stringify({
      domains: pac.domains,
      matchMode: pac.matchMode,
      proxy: pac.proxy?.directive || null,
      fallbackProxy: pac.fallbackProxy?.directive || null,
      fallbackPacUrl: pac.fallbackPacUrl,
      fallbackPacScript: pac.fallbackPacScript,
      dnsServers: pac.dnsServers,
      dnsFallbackTarget: pac.dnsFallbackTarget,
      reverseProxyRoutes: pac.reverseProxyRoutes,
      ownershipClaim: pac.ownershipClaim?.ownerId || null,
      directCidrs: pacDirectCidrs(pac.ownershipClaim ? [pac.ownershipClaim] : []),
      pacPort: pac.pacPort || null
    });
    if (localPacServer && localPacPort && localPacKey === key) {
      return {
        pacUrl: `http://127.0.0.1:${localPacPort}${PAC_PATH}`,
        port: localPacPort,
        sharedLocalPac: false
      };
    }

    const nextConfig = localConfigFromPac(pac);

    if (localPacServer && localPacPort) {
      localPacConfig = nextConfig;
      localPacKey = key;
      return {
        pacUrl: `http://127.0.0.1:${localPacPort}${PAC_PATH}`,
        port: localPacPort,
        sharedLocalPac: false
      };
    }

    const preferredPort = pac.pacPort || normalizePort(options.pacPort) || 0;
    const server = createServer((req, res) => {
      void handleLocalEdgeRequest(req, res);
    });
    server.on('connect', (req, socket, head) => {
      void handleProxyConnectRequest(req, socket as Socket, head);
    });
    server.on('connection', (socket) => {
      localPacSockets.add(socket);
      socket.once('close', () => localPacSockets.delete(socket));
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(preferredPort, '127.0.0.1', () => {
          server.off('error', reject);
          const address = server.address();
          if (!address || typeof address === 'string') {
            reject(new Error('failed to allocate Electron Launcher PAC port'));
            return;
          }
          localPacServer = server;
          localPacPort = address.port;
          localPacKey = key;
          localPacConfig = nextConfig;
          resolve();
        });
      });
      await ensureLocalDnsServer(localPacPort || preferredPort);
    } catch (err) {
      try {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        for (const socket of localPacSockets) socket.destroy();
        localPacSockets.clear();
        await closed;
      } catch {
        // The server may have failed before entering the listening state.
      }
      if (preferredPort > 0 && isAddressInUseError(err)) {
        if (serverOptions.allowShared === false) {
          throw new Error(`macOS local edge 127.0.0.1:${preferredPort} is already in use; read-only resume will not register with another process.`);
        }
        if (process.platform === 'win32') {
          throw new Error(
            `Windows local edge 127.0.0.1:${preferredPort} is already owned by another process; `
            + 'cross-process PAC sharing cannot guarantee safe browser cleanup.'
          );
        }
        const shared = await registerSharedLocalPacServer(preferredPort, nextConfig);
        const sharedConfig = normalizeSharedLocalPacConfig(shared.config || shared);
        return {
          pacUrl: shared.pacUrl,
          port: preferredPort,
          config: sharedConfig,
          sharedLocalPac: true
        };
      }
      throw err;
    }

    const activePort = localPacPort;
    if (!activePort) throw new Error('failed to allocate Electron Launcher PAC port');
    return {
      pacUrl: `http://127.0.0.1:${activePort}${PAC_PATH}`,
      port: activePort,
      sharedLocalPac: false
    };
  }

  async function handleLocalEdgeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const controlPath = localControlPath(req);
    if (controlPath === PAC_PATH) {
      const config = localPacConfig;
      if (!config) {
        writeTextResponse(res, 503, 'Electron Launcher PAC is not configured');
        return;
      }
      const body = req.method === 'HEAD' ? '' : renderElectronLauncherPacScript(config);
      res.writeHead(200, {
        'Content-Type': 'application/x-ns-proxy-autoconfig; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': String(Buffer.byteLength(body, 'utf8')),
        Connection: 'close'
      });
      res.end(body);
      return;
    }
    if (controlPath === SHARED_STATUS_PATH) {
      writeJsonResponse(res, 200, {
        marker: PAC_MARKER,
        pacUrl: localPacPort ? `http://127.0.0.1:${localPacPort}${PAC_PATH}` : null,
        domains: localPacConfig?.domains || [],
        proxy: localPacConfig?.proxy?.address || null,
        proxyDirective: localPacConfig?.proxy?.directive || null,
        matchMode: localPacConfig?.matchMode || null,
        fallbackProxy: localPacConfig?.fallbackProxy?.address || null,
        fallbackProxyDirective: localPacConfig?.fallbackProxy?.directive || null,
        fallbackPacUrl: localPacConfig?.fallbackPacUrl || null,
        dnsServers: localPacConfig?.dnsServers || [],
        dnsFallbackTarget: localPacConfig?.dnsFallbackTarget || null,
        reverseProxyRoutes: localPacConfig?.reverseProxyRoutes || [],
        ownershipClaims: localPacConfig?.ownershipClaims || [],
        ownershipRegistry: localPacConfig ? localConfigOwnershipRegistry(localPacConfig) : null
      });
      return;
    }
    if (controlPath === SHARED_APPLY_PATH && req.method === 'POST') {
      if (process.platform === 'win32') {
        writeJsonResponse(res, 409, {
          marker: PAC_MARKER,
          error: 'Windows application-process PAC sharing is disabled; use one Launcher network broker.'
        });
        return;
      }
      const body = await readRequestJson(req);
      localPacConfig = mergeLocalPacConfigs(localPacConfig, normalizeSharedLocalPacConfig(body));
      localPacKey = localPacConfigKey(localPacConfig, localPacPort);
      writeJsonResponse(res, 200, {
        marker: PAC_MARKER,
        pacUrl: localPacPort ? `http://127.0.0.1:${localPacPort}${PAC_PATH}` : null,
        shared: false,
        domains: localPacConfig.domains,
        proxy: localPacConfig.proxy?.address || null,
        proxyDirective: localPacConfig.proxy?.directive || null,
        matchMode: localPacConfig.matchMode,
        fallbackProxy: localPacConfig.fallbackProxy?.address || null,
        fallbackProxyDirective: localPacConfig.fallbackProxy?.directive || null,
        fallbackPacUrl: localPacConfig.fallbackPacUrl,
        dnsServers: localPacConfig.dnsServers,
        dnsFallbackTarget: localPacConfig.dnsFallbackTarget,
        reverseProxyRoutes: localPacConfig.reverseProxyRoutes,
        ownershipClaims: localPacConfig.ownershipClaims,
        ownershipRegistry: localConfigOwnershipRegistry(localPacConfig)
      });
      return;
    }
    if (controlPath === SHARED_RELEASE_PATH && req.method === 'POST') {
      if (process.platform === 'win32') {
        writeJsonResponse(res, 409, {
          marker: PAC_MARKER,
          error: 'Windows application-process PAC sharing is disabled; use one Launcher network broker.'
        });
        return;
      }
      const body = await readRequestJson(req);
      const ownerId = normalizeOwnerId((body as Record<string, unknown>)?.ownerId);
      if (ownerId && localPacConfig) {
        localPacConfig = releaseLocalPacConfigOwner(localPacConfig, ownerId);
        localPacKey = localPacConfigKey(localPacConfig, localPacPort);
      }
      writeJsonResponse(res, 200, {
        marker: PAC_MARKER,
        pacUrl: localPacPort ? `http://127.0.0.1:${localPacPort}${PAC_PATH}` : null,
        releasedOwnerId: ownerId,
        domains: localPacConfig?.domains || [],
        proxy: localPacConfig?.proxy?.address || null,
        proxyDirective: localPacConfig?.proxy?.directive || null,
        matchMode: localPacConfig?.matchMode || null,
        fallbackProxy: localPacConfig?.fallbackProxy?.address || null,
        fallbackProxyDirective: localPacConfig?.fallbackProxy?.directive || null,
        fallbackPacUrl: localPacConfig?.fallbackPacUrl || null,
        dnsServers: localPacConfig?.dnsServers || [],
        dnsFallbackTarget: localPacConfig?.dnsFallbackTarget || null,
        reverseProxyRoutes: localPacConfig?.reverseProxyRoutes || [],
        ownershipClaims: localPacConfig?.ownershipClaims || [],
        ownershipRegistry: localPacConfig ? localConfigOwnershipRegistry(localPacConfig) : null
      });
      return;
    }
    await handleProxyHttpRequest(req, res, localPacConfig);
  }

  async function ensureLocalDnsServer(port: number): Promise<void> {
    if (!port || localDnsServer) return;
    const socket = createSocket('udp4');
    socket.on('message', (message, remote) => {
      void handleLocalDnsRelay(message, remote, socket);
    });
    socket.on('error', (err) => {
      log.warn('[electron-launcher] local DNS relay error', err);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(port, '127.0.0.1', () => {
          socket.off('error', reject);
          localDnsServer = socket;
          resolve();
        });
      });
    } catch (err) {
      log.warn(`[electron-launcher] local DNS relay on 127.0.0.1:${port} unavailable`, err);
      try {
        socket.close();
      } catch {
        // Ignore cleanup failures for a socket that never bound.
      }
    }
  }

  async function handleLocalDnsRelay(message: Buffer, remote: RemoteInfo, socket: DgramSocket): Promise<void> {
    const config = localPacConfig;
    const host = dnsQuestionHost(message);
    if (!config || !host || !hostMatchesDomains(host, config.domains)) {
      const failure = dnsFailureResponse(message);
      if (failure.length) socket.send(failure, remote.port, remote.address);
      return;
    }
    const routeTarget = dnsTargetForHost(host, config);
    if (routeTarget && isIP(routeTarget) === 4) {
      const directResponse = dnsSyntheticIpv4Response(message, routeTarget);
      if (directResponse.length) {
        socket.send(directResponse, remote.port, remote.address);
        return;
      }
    }
    const ownershipTarget = dnsOwnershipTargetForHost(host, config);
    if (ownershipTarget && isIP(ownershipTarget) === 4) {
      const directResponse = dnsSyntheticIpv4Response(message, ownershipTarget);
      if (directResponse.length) {
        socket.send(directResponse, remote.port, remote.address);
        return;
      }
    }
    if (!config.dnsServers.length) {
      const failure = dnsFailureResponse(message);
      if (failure.length) socket.send(failure, remote.port, remote.address);
      return;
    }
    try {
      const response = await forwardDnsPacket(message, config.dnsServers);
      if (shouldUseDnsFallbackResponse(message, response, config.dnsFallbackTarget)) {
        const fallbackResponse = dnsSyntheticIpv4Response(message, config.dnsFallbackTarget || '');
        if (fallbackResponse.length) {
          socket.send(fallbackResponse, remote.port, remote.address);
          return;
        }
      }
      socket.send(response, remote.port, remote.address);
    } catch {
      if (config.dnsFallbackTarget && isIP(config.dnsFallbackTarget) === 4) {
        const fallbackResponse = dnsSyntheticIpv4Response(message, config.dnsFallbackTarget);
        if (fallbackResponse.length) {
          socket.send(fallbackResponse, remote.port, remote.address);
          return;
        }
      }
      const failure = dnsFailureResponse(message);
      if (failure.length) socket.send(failure, remote.port, remote.address);
    }
  }

  async function handleProxyConnectRequest(req: IncomingMessage, clientSocket: Socket, head: Buffer): Promise<void> {
    const config = localPacConfig;
    try {
      const authority = parseProxyAuthority(req.url || '', 443);
      if (!authority) throw new Error(`unsupported CONNECT target: ${req.url || ''}`);
      const routedTarget = connectRouteTarget(authority, config);
      const targetHost = routedTarget?.host || await resolveProxyHost(authority.host, config);
      const upstream = netConnect({
        host: targetHost,
        port: routedTarget?.port || authority.port,
        timeout: PROXY_CONNECT_TIMEOUT_MS
      });
      upstream.once('connect', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: MX-H2I\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.once('timeout', () => {
        upstream.destroy(new Error(`proxy CONNECT timeout: ${authority.host}:${authority.port}`));
      });
      upstream.once('error', (err) => {
        destroyProxyClient(clientSocket, `HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n${errorMessage(err)}`);
      });
      clientSocket.once('error', () => upstream.destroy());
    } catch (err) {
      destroyProxyClient(clientSocket, `HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n${errorMessage(err)}`);
    }
  }

  async function resolvePacSource(
    policy: ElectronLauncherSystemDomainProxyPolicy,
    previous: unknown,
    serverOptions: { allowShared?: boolean; startLocalEdge?: boolean } = {}
  ): Promise<ResolvedPacSource | null> {
    if (policy?.enabled !== true) return null;
    const domains = normalizeDomains(policy.domains);
    const pacUrl = stringValue(policy.pacUrl);
    const pacPort = normalizePort(policy.pacPort) || normalizePort(options.pacPort);
    const dnsServers = normalizeDnsServers(policy.dnsServers);
    const dnsFallbackTarget = normalizeDnsTarget(policy.dnsFallbackTarget);
    const systemResolverMode = normalizeSystemResolverMode(policy.systemResolver);
    const reverseProxyRoutes = normalizeReverseProxyRoutes(policy.reverseProxyRoutes);
    const explicitFallbackProxy = normalizeProxyAddress(policy.fallbackProxy);
    const continuation: PacContinuation = pacUrl
      ? { fallbackProxy: explicitFallbackProxy, fallbackPacUrl: null, fallbackPacScript: null }
      : explicitFallbackProxy
        ? { fallbackProxy: explicitFallbackProxy, fallbackPacUrl: null, fallbackPacScript: null }
        : await fallbackForPac(previous, log);
    const fallbackProxy = continuation.fallbackProxy;
    const ownershipClaim = normalizeOwnershipClaim(policy.ownershipClaim);
    if (pacUrl) {
      return {
        pacUrl,
        domains,
        proxy: normalizeProxyAddress(policy.proxy),
        matchMode: normalizeMatchMode(policy.matchMode, policy.proxy),
        fallbackProxy,
        fallbackPacUrl: continuation.fallbackPacUrl,
        fallbackPacScript: continuation.fallbackPacScript,
        staleWindowsPacIgnored: continuation.staleWindowsPacIgnored,
        pacPort: null,
        sharedLocalPac: false,
        dnsServers,
        dnsFallbackTarget,
        systemResolverMode,
        reverseProxyRoutes,
        ownershipClaim,
        ownershipClaims: normalizeOwnershipClaims(ownershipClaim ? [ownershipClaim] : []),
        usesLocalPac: false
      };
    }
    if (domains.length === 0) return null;
    const matchMode = normalizeMatchMode(policy.matchMode, policy.proxy);
    const proxy = matchMode === 'proxy' ? normalizeProxyAddress(policy.proxy) : null;
    if (matchMode === 'proxy' && !proxy) return null;
    const localPac = {
      domains,
      proxy,
      matchMode,
      fallbackProxy,
      fallbackPacUrl: continuation.fallbackPacUrl,
      fallbackPacScript: continuation.fallbackPacScript,
      staleWindowsPacIgnored: continuation.staleWindowsPacIgnored,
      pacPort,
      sharedLocalPac: false,
      dnsServers,
      dnsFallbackTarget,
      systemResolverMode,
      reverseProxyRoutes,
      ownershipClaim,
      ownershipClaims: normalizeOwnershipClaims(ownershipClaim ? [ownershipClaim] : [])
    };
    if (serverOptions.startLocalEdge === false) {
      if (!pacPort) return null;
      const effectiveConfig = localConfigFromPac(localPac);
      return {
        ...localPac,
        pacUrl: `http://127.0.0.1:${pacPort}${PAC_PATH}`,
        pacPort,
        domains: effectiveConfig.domains,
        dnsServers: effectiveConfig.dnsServers,
        dnsFallbackTarget: effectiveConfig.dnsFallbackTarget,
        reverseProxyRoutes: effectiveConfig.reverseProxyRoutes,
        ownershipClaims: effectiveConfig.ownershipClaims,
        sharedLocalPac: false,
        usesLocalPac: true
      };
    }
    const localServer = await ensureLocalPacServer(localPac, serverOptions);
    const effectiveConfig = localServer.config || localConfigFromPac(localPac);
    return {
      ...localPac,
      pacUrl: localServer.pacUrl,
      pacPort: localServer.port,
      domains: effectiveConfig.domains,
      dnsServers: effectiveConfig.dnsServers,
      dnsFallbackTarget: effectiveConfig.dnsFallbackTarget,
      reverseProxyRoutes: effectiveConfig.reverseProxyRoutes,
      ownershipClaims: effectiveConfig.ownershipClaims,
      sharedLocalPac: localServer.sharedLocalPac,
      usesLocalPac: true
    };
  }

  async function prepareApplyState(
    policy: ElectronLauncherSystemDomainProxyPolicy,
    prepareOptions: {
      allowSharedLocalEdge?: boolean;
      externalTransactionToken?: string | null;
    } = {}
  ): Promise<PreparedSystemDomainProxyApply | null> {
    const existing = readState(statePath);
    const platformStates = await platformStatesForApply(existing);
    const pac = await resolvePacSource(policy, platformStates.previous, {
      allowShared: prepareOptions.allowSharedLocalEdge !== false
    });
    if (!pac) return null;
    const previous = pac.staleWindowsPacIgnored === true
      ? windowsStateWithoutAutoConfigUrl(platformStates.previous)
      : platformStates.previous;
    const windowsApplySnapshot = platformStates.windowsApplySnapshot;

    const resolverPlan = systemResolverPlan(pac);
    const next: StoredState = {
      version: STATE_VERSION,
      applied: true,
      platform: process.platform,
      pacUrl: pac.pacUrl,
      proxy: pac.proxy?.address || null,
      matchMode: pac.matchMode,
      fallbackProxy: pac.fallbackProxy?.directive || null,
      fallbackPacUrl: pac.fallbackPacUrl,
      pacPort: pac.pacPort,
      sharedLocalPac: pac.sharedLocalPac,
      dnsServers: pac.dnsServers,
      dnsFallbackTarget: pac.dnsFallbackTarget,
      systemResolver: pac.systemResolverMode !== 'off',
      systemResolverMode: pac.systemResolverMode,
      resolverDomains: resolverPlan.domains,
      resolverPort: resolverPlan.port,
      resolverApplied: false,
      resolverError: null,
      domains: pac.domains,
      reverseProxyRoutes: pac.reverseProxyRoutes,
      ownershipClaim: pac.ownershipClaim,
      ownershipRegistry: pac.ownershipClaims.length
        ? buildElectronLauncherNetworkOwnershipRegistry(pac.ownershipClaims)
        : null,
      previous,
      updatedAt: new Date().toISOString()
    };
    const changed = systemDomainProxyStateChanged(existing, next);
    writeState(statePath, {
      ...next,
      pending: true,
      ...(prepareOptions.externalTransactionToken
        ? {
            externalTransactionToken: prepareOptions.externalTransactionToken,
            externalTransactionPhase: 'prepared' as const
          }
        : {}),
      updatedAt: new Date().toISOString()
    });
    return {
      existing,
      previous,
      windowsApplySnapshot,
      pac,
      resolverPlan,
      next,
      changed
    };
  }

  async function releaseSharedOwnerForState(state: StoredState): Promise<LocalPacServerConfig | null> {
    if (state.sharedLocalPac !== true) return null;
    const ownerId = stateOwnershipOwnerId(state);
    const port = normalizePort(state.pacPort);
    if (!ownerId || !port) {
      throw new Error('Shared local PAC state is missing the owner id or port required for a safe release.');
    }
    const response = await releaseSharedLocalPacServer(port, ownerId);
    return normalizeSharedLocalPacConfig(response);
  }

  async function releaseLocalOwnerAndRetainSharedEdge(state: StoredState): Promise<StoredState | null> {
    const ownerId = stateOwnershipOwnerId(state);
    if (!ownerId || !localPacServer || !localPacPort || !localPacConfig) return null;
    const nextConfig = releaseLocalPacConfigOwner(localPacConfig, ownerId);
    if (!nextConfig.ownershipClaims.length) return null;

    localPacConfig = nextConfig;
    localPacKey = localPacConfigKey(nextConfig, localPacPort);

    const pac = resolvedPacSourceFromLocalConfig(
      `http://127.0.0.1:${localPacPort}${PAC_PATH}`,
      localPacPort,
      storedSystemResolverMode(state),
      nextConfig
    );
    const windowsApplySnapshot = process.platform === 'win32'
      ? await captureWindowsState()
      : null;
    const resolver = await applyPlatformPacAndSystemResolvers(
      pac,
      state.previous,
      state,
      log,
      windowsApplySnapshot
    );
    const next: StoredState = {
      ...state,
      applied: true,
      pacUrl: pac.pacUrl,
      proxy: pac.proxy?.address || null,
      matchMode: pac.matchMode,
      fallbackProxy: pac.fallbackProxy?.directive || null,
      fallbackPacUrl: pac.fallbackPacUrl,
      pacPort: pac.pacPort,
      sharedLocalPac: false,
      dnsServers: pac.dnsServers,
      dnsFallbackTarget: pac.dnsFallbackTarget,
      systemResolver: resolver.mode !== 'off',
      systemResolverMode: resolver.mode,
      resolverDomains: resolver.domains,
      resolverPort: resolver.port,
      resolverApplied: resolver.applied,
      resolverError: resolver.error || null,
      domains: pac.domains,
      reverseProxyRoutes: pac.reverseProxyRoutes,
      ownershipClaim: null,
      ownershipRegistry: localConfigOwnershipRegistry(nextConfig),
      pending: false,
      updatedAt: new Date().toISOString()
    };
    delete next.pending;
    writeState(statePath, next);
    return next;
  }

  async function currentVerifiedStatus(): Promise<ElectronLauncherSystemDomainProxyStatus> {
    if (!isSupportedPlatform()) return unsupportedStatus();
    const state = readState(statePath);
    if (!state?.applied || state.platform !== process.platform) {
      return {
        supported: true,
        applied: false,
        verified: true,
        platform: process.platform
      };
    }
    try {
      const pacVerification = await verifyPlatformPac(state.pacUrl, state.previous);
      const resolverVerification = await verifySystemResolvers(state);
      const localDnsVerification = await verifyLocalDnsRelay(state);
      return publicState(state, {
        applied: pacVerification.applied && resolverVerification.applied && localDnsVerification.applied,
        verified: true,
        actual: {
          pac: pacVerification,
          resolver: resolverVerification,
          localDns: localDnsVerification
        },
        resolverApplied: resolverVerification.applied && localDnsVerification.applied,
        resolverError: resolverVerification.error || localDnsVerification.error || null
      });
    } catch (err) {
      return publicState(state, {
        applied: false,
        verified: false,
        error: errorMessage(err)
      });
    }
  }

  async function rollbackDarwinLocalEdgeResume(
    before: LocalEdgeSnapshot,
    _pac: ResolvedPacSource | null
  ): Promise<void> {
    if (!before.server && localPacServer) {
      await closeLocalPacServer();
      return;
    }
    localPacServer = before.server;
    localDnsServer = before.dnsServer;
    localPacPort = before.port;
    localPacKey = before.key;
    localPacConfig = before.config;
  }

  function captureLocalEdgeSnapshot(): LocalEdgeSnapshot {
    return {
      server: localPacServer,
      dnsServer: localDnsServer,
      port: localPacPort,
      key: localPacKey,
      config: localPacConfig
    };
  }

  async function restoreExternalApplyLocalEdge(before: LocalEdgeSnapshot): Promise<void> {
    if (before.server) {
      if (localPacServer !== before.server || localDnsServer !== before.dnsServer) {
        throw new Error('External apply local edge changed concurrently; refusing an unsafe rollback.');
      }
      localPacPort = before.port;
      localPacKey = before.key;
      localPacConfig = before.config;
      return;
    }
    if (localPacServer || localDnsServer) await closeLocalPacServer();
    localPacPort = before.port;
    localPacKey = before.key;
    localPacConfig = before.config;
  }

  function externalApplyConflictStatus(reason: string): ElectronLauncherSystemDomainProxyStatus {
    const current = readState(statePath);
    const transactionToken = darwinExternalApplyTransaction?.token
      || current?.externalTransactionToken
      || null;
    const externalApplyPhase = currentDarwinExternalApplyPhase(
      darwinExternalApplyTransaction?.phase || current?.externalTransactionPhase
    );
    const extra = {
      applied: false,
      reason,
      skipped: true,
      skipReason: 'external-apply-transaction-in-flight',
      transactionToken,
      externalApplyPhase,
      error: 'A macOS external system proxy transaction is already in flight.'
    };
    return current?.applied && current.platform === process.platform
      ? publicState(current, extra)
      : {
          supported: true,
          platform: process.platform,
          ...extra
        };
  }

  function externalApplyTransactionPending(): boolean {
    if (darwinExternalApplyTransaction) return true;
    const current = readState(statePath);
    return current?.pending === true && Boolean(current.externalTransactionToken);
  }

  function externalApplyTransactionPhase(
    transaction: DarwinExternalApplyTransaction | null,
    current: StoredState | null
  ): DarwinExternalApplyPhase {
    const phases = [
      currentDarwinExternalApplyPhase(transaction?.phase),
      currentDarwinExternalApplyPhase(current?.externalTransactionPhase)
    ];
    if (phases.includes('readback-started')) return 'readback-started';
    if (phases.includes('privileged-handoff')) return 'privileged-handoff';
    return 'prepared';
  }

  function externalApplyTokenMismatchStatus(
    reason: string,
    transactionToken: string
  ): ElectronLauncherSystemDomainProxyStatus {
    const current = readState(statePath);
    const extra = {
      applied: false,
      reason,
      skipped: true,
      skipReason: 'external-apply-transaction-token-mismatch',
      transactionToken: current?.externalTransactionToken || null,
      externalApplyPhase: currentDarwinExternalApplyPhase(current?.externalTransactionPhase),
      error: `External apply transaction token is stale or unknown: ${transactionToken}`
    };
    return current?.applied && current.platform === process.platform
      ? publicState(current, extra)
      : {
          supported: true,
          platform: process.platform,
          ...extra
        };
  }

  async function prepareExternalApplyTransaction(
    policy: ElectronLauncherSystemDomainProxyPolicy
  ): Promise<ElectronLauncherSystemDomainProxyStatus> {
    const reason = 'external-prepare';
    if (!isSupportedPlatform()) return unsupportedStatus({ reason });
    if (process.platform !== 'darwin') {
      return unsupportedStatus({ reason, platform: process.platform });
    }
    if (darwinExternalApplyTransaction) return externalApplyConflictStatus(reason);

    const beforeState = readState(statePath);
    if (beforeState?.pending === true || beforeState?.externalTransactionToken) {
      return publicState(beforeState, {
        applied: false,
        reason,
        skipped: true,
        skipReason: 'external-apply-durable-state-pending',
        transactionToken: beforeState.externalTransactionToken || null,
        error: 'A pending system proxy state must be completed or repaired before preparing another external apply.'
      });
    }
    if (beforeState?.sharedLocalPac === true) {
      return publicState(beforeState, {
        applied: false,
        reason,
        skipped: true,
        skipReason: 'external-apply-shared-edge-rollback-unsafe',
        transactionToken: null,
        error: 'Refusing to prepare an external apply over a shared local edge because an abort cannot safely restore another owner.'
      });
    }

    const token = randomUUID();
    const localEdgeBefore = captureLocalEdgeSnapshot();
    darwinExternalApplyTransaction = {
      token,
      phase: 'prepared',
      beforeState,
      localEdgeBefore
    };

    let prepared: PreparedSystemDomainProxyApply | null;
    try {
      prepared = await prepareApplyState(policy, {
        allowSharedLocalEdge: false,
        externalTransactionToken: token
      });
    } catch (err) {
      const current = readState(statePath);
      if (current?.externalTransactionToken === token) {
        return publicState(current, {
          applied: false,
          reason,
          pending: true,
          externalApply: false,
          darwinApplyShell: null,
          transactionToken: token,
          error: errorMessage(err)
        });
      }
      try {
        await restoreExternalApplyLocalEdge(localEdgeBefore);
      } catch (rollbackErr) {
        return {
          supported: true,
          applied: false,
          platform: process.platform,
          reason,
          transactionToken: token,
          error: `External apply prepare failed (${errorMessage(err)}); local edge rollback also failed (${errorMessage(rollbackErr)}).`
        };
      }
      darwinExternalApplyTransaction = null;
      return {
        supported: true,
        applied: false,
        platform: process.platform,
        reason,
        transactionToken: null,
        error: errorMessage(err)
      };
    }

    if (!prepared) {
      await restoreExternalApplyLocalEdge(localEdgeBefore);
      darwinExternalApplyTransaction = null;
      return {
        supported: true,
        applied: false,
        platform: process.platform,
        reason,
        skipped: true,
        skipReason: 'external-apply-policy-disabled',
        transactionToken: null
      };
    }

    let shell: string | null = null;
    let shellError: string | null = null;
    try {
      shell = await darwinPlatformAndSystemApplyShell(
        prepared.pac.pacUrl,
        prepared.previous,
        prepared.existing,
        prepared.resolverPlan
      );
    } catch (err) {
      shellError = errorMessage(err);
    }
    return publicState(prepared.next, {
      applied: false,
      changed: prepared.changed,
      pending: true,
      externalApply: Boolean(shell),
      darwinApplyShell: shell,
      transactionToken: token,
      externalApplyPhase: 'prepared',
      ...(shell
        ? {}
        : {
            skipped: true,
            skipReason: 'darwin-apply-shell-unavailable',
            error: shellError || 'macOS external apply shell is unavailable.'
          })
    });
  }

  async function abortExternalApplyTransaction(
    transactionToken: string,
    abortOptions: ElectronLauncherExternalApplyAbortOptions
  ): Promise<ElectronLauncherSystemDomainProxyStatus> {
    const reason = abortOptions?.reason || 'external-abort';
    if (!['not-started', 'authorization-canceled'].includes(abortOptions?.execution)) {
      return {
        supported: true,
        applied: false,
        platform: process.platform,
        reason,
        skipped: true,
        skipReason: 'external-apply-abort-execution-unknown',
        transactionToken: stringValue(transactionToken),
        error: 'External apply abort requires proof that the privileged shell was not executed.'
      };
    }
    const token = stringValue(transactionToken);
    const transaction = darwinExternalApplyTransaction;
    const current = readState(statePath);
    if (
      !token
      || !transaction
      || transaction.token !== token
      || current?.pending !== true
      || current.externalTransactionToken !== token
    ) {
      return externalApplyTokenMismatchStatus(reason, token || '<empty>');
    }
    const phase = externalApplyTransactionPhase(transaction, current);
    if (!darwinExternalApplyAbortAllowed(phase, abortOptions.execution)) {
      return publicState(current, {
        applied: false,
        reason,
        skipped: true,
        skipReason: 'external-apply-abort-after-handoff',
        transactionToken: token,
        externalApplyPhase: phase,
        error: 'Refusing to abort this execution phase; complete live readback instead.'
      });
    }
    if (current.sharedLocalPac === true || transaction.beforeState?.sharedLocalPac === true) {
      return publicState(current, {
        applied: false,
        reason,
        skipped: true,
        skipReason: 'external-apply-shared-edge-rollback-unsafe',
        transactionToken: token,
        error: 'Refusing to abort a shared local edge transaction; no external owner was released or deleted.'
      });
    }

    try {
      await restoreExternalApplyLocalEdge(transaction.localEdgeBefore);
      if (transaction.beforeState) writeState(statePath, transaction.beforeState);
      else rmSync(statePath, { force: true });
    } catch (err) {
      return publicState(current, {
        applied: false,
        reason,
        skipped: true,
        skipReason: 'external-apply-abort-failed',
        transactionToken: token,
        error: errorMessage(err)
      });
    }
    darwinExternalApplyTransaction = null;
    if (transaction.beforeState) {
      return publicState(transaction.beforeState, {
        reason,
        restored: true,
        skipped: true,
        skipReason: 'external-apply-aborted-before-system-write',
        transactionToken: null
      });
    }
    return {
      supported: true,
      applied: false,
      platform: process.platform,
      reason,
      restored: true,
      skipped: true,
      skipReason: 'external-apply-aborted-before-system-write',
      transactionToken: null
    };
  }

  function markExternalApplyHandoffTransaction(
    transactionToken: string
  ): ElectronLauncherSystemDomainProxyStatus {
    const reason = 'external-handoff';
    const token = stringValue(transactionToken);
    const transaction = darwinExternalApplyTransaction;
    const current = readState(statePath);
    if (
      !token
      || !transaction
      || transaction.token !== token
      || current?.pending !== true
      || current.externalTransactionToken !== token
    ) {
      return externalApplyTokenMismatchStatus(reason, token || '<empty>');
    }
    const phase = externalApplyTransactionPhase(transaction, current);
    if (phase === 'readback-started') {
      return publicState(current, {
        applied: false,
        reason,
        pending: true,
        externalApply: true,
        transactionToken: token,
        externalApplyPhase: phase
      });
    }
    const next: StoredState = {
      ...current,
      externalTransactionPhase: 'privileged-handoff',
      updatedAt: new Date().toISOString()
    };
    writeState(statePath, next);
    transaction.phase = 'privileged-handoff';
    return publicState(next, {
      applied: false,
      reason,
      pending: true,
      externalApply: true,
      transactionToken: token,
      externalApplyPhase: 'privileged-handoff'
    });
  }

  async function completeExternalApplyTransaction(
    transactionToken: string,
    reason = 'external'
  ): Promise<ElectronLauncherSystemDomainProxyStatus> {
    const token = stringValue(transactionToken);
    const existing = readState(statePath);
    if (
      !token
      || !existing?.applied
      || existing.platform !== process.platform
      || existing.pending !== true
      || existing.externalTransactionToken !== token
    ) {
      return externalApplyTokenMismatchStatus(reason, token || '<empty>');
    }
    if (darwinExternalApplyTransaction?.token === token) {
      darwinExternalApplyTransaction.phase = 'readback-started';
    }
    const readbackState: StoredState = {
      ...existing,
      externalTransactionPhase: 'readback-started',
      updatedAt: new Date().toISOString()
    };
    writeState(statePath, readbackState);
    const resolver = await verifySystemResolvers(readbackState).catch((err) => ({
      applied: false,
      platform: process.platform,
      mode: storedSystemResolverMode(readbackState),
      domains: [],
      error: errorMessage(err)
    }));
    const actual = await verifyPlatformPac(readbackState.pacUrl, readbackState.previous).catch((err) => ({
      applied: false,
      platform: process.platform,
      error: errorMessage(err)
    }));
    const next: StoredState = {
      ...readbackState,
      systemResolver: resolver.mode !== 'off',
      systemResolverMode: resolver.mode,
      resolverDomains: normalizeDomains(readbackState.resolverDomains),
      resolverPort: normalizePort(readbackState.resolverPort),
      resolverApplied: resolver.applied,
      resolverError: resolver.error || null,
      pending: false,
      updatedAt: new Date().toISOString()
    };
    delete next.pending;
    delete next.externalTransactionToken;
    delete next.externalTransactionPhase;
    writeState(statePath, next);
    if (darwinExternalApplyTransaction?.token === token) {
      darwinExternalApplyTransaction = null;
    }
    return publicState(next, {
      applied: actual.applied === true && resolver.applied === true,
      reason,
      verified: true,
      externalApply: true,
      transactionToken: null,
      actual: {
        pac: actual,
        resolver
      }
    });
  }

  return {
    async apply(policy, applyOptions = {}) {
      if (!isSupportedPlatform()) return unsupportedStatus();
      if (externalApplyTransactionPending()) return externalApplyConflictStatus('apply');
      const gateWasHeld = Boolean(windowsOwnershipGateLease);
      const localServerBeforePrepare = localPacServer;
      const localPortBeforePrepare = localPacPort;
      const localKeyBeforePrepare = localPacKey;
      const localConfigBeforePrepare = localPacConfig;
      const hadWorkingLocalEdge = Boolean(localServerBeforePrepare);
      acquireWindowsOwnershipGate();
      let prepared: PreparedSystemDomainProxyApply | null;
      try {
        prepared = await prepareApplyState(policy);
      } catch (err) {
        if (gateWasHeld || hadWorkingLocalEdge) {
          // A reapply may update the in-memory continuation on the existing
          // edge before its pending state write fails. Keep the established
          // owner alive and restore the last known working local config.
          if (localPacServer && localPacServer !== localServerBeforePrepare) {
            await closeLocalPacServer();
          }
          localPacServer = localServerBeforePrepare;
          localPacPort = localPortBeforePrepare;
          localPacKey = localKeyBeforePrepare;
          localPacConfig = localConfigBeforePrepare;
        } else {
          await closeLocalPacServer();
          releaseWindowsOwnershipGate();
        }
        throw err;
      }
      if (!prepared) {
        return this.disable('domain-proxy-disabled');
      }
      const { pac, previous, windowsApplySnapshot, existing, next, changed } = prepared;
      try {
        const resolver = await applyPlatformPacAndSystemResolvers(
          pac,
          previous,
          existing,
          log,
          windowsApplySnapshot,
          applyOptions
        );
        next.systemResolver = resolver.mode !== 'off';
        next.systemResolverMode = resolver.mode;
        next.resolverDomains = resolver.domains;
        next.resolverPort = resolver.port;
        next.resolverApplied = resolver.applied;
        next.resolverError = resolver.error || null;
        if (pac.usesLocalPac !== true) await closeLocalPacServer();
        delete next.pending;
        next.updatedAt = new Date().toISOString();
        writeState(statePath, next);
        return publicState(next, { changed });
      } catch (applyErr) {
        // AutoConfigURL can commit before the WinINet change notification or
        // its read-back verification fails. Roll back from the pending state
        // before reporting failure so shutdown cannot inherit a dead PAC.
        try {
          if (process.platform === 'win32') {
            await rollbackWindowsPartialApply(previous, pac.pacUrl);
          } else {
            await restorePlatformAndSystemState(next, log);
          }
          if (next.sharedLocalPac === true) {
            await releaseSharedOwnerForState(next);
          }
          await closeLocalPacServer();
          removeState(statePath, log);
          releaseWindowsOwnershipGate();
        } catch (rollbackErr) {
          log.warn('[electron-launcher] failed to roll back partial system domain proxy apply', rollbackErr);
          const error = new Error(
            `System domain proxy apply failed (${errorMessage(applyErr)}); rollback also failed (${errorMessage(rollbackErr)})`
          );
          Object.assign(error, { cause: applyErr, rollbackError: rollbackErr });
          throw error;
        }
        throw applyErr;
      }
    },

    prepareExternalApply: prepareExternalApplyTransaction,
    abortExternalApply: abortExternalApplyTransaction,
    markExternalApplyHandoff: markExternalApplyHandoffTransaction,
    // Compatibility alias for existing Darwin callers. New callers must keep
    // the returned transactionToken and pass it to abort/complete.
    darwinPrepareApply: prepareExternalApplyTransaction,
    completeExternalApply: completeExternalApplyTransaction,

    async disable(reason = 'manual', disableOptions = {}) {
      if (!isSupportedPlatform()) return unsupportedStatus({ reason });
      if (externalApplyTransactionPending()) return externalApplyConflictStatus(reason);
      const existing = readState(statePath);
      if (!existing?.applied || existing.platform !== process.platform) {
        await closeLocalPacServer();
        releaseWindowsOwnershipGate();
        return {
          supported: true,
          applied: false,
          platform: process.platform,
          reason,
          skipped: true
        };
      }

      acquireWindowsOwnershipGate();
      if (existing.sharedLocalPac === true) {
        const shared = await releaseSharedOwnerForState(existing);
        const remainingOwners = normalizeOwnershipClaims(shared?.ownershipClaims).map((claim) => claim.ownerId);
        let restored = false;
        if (remainingOwners.length === 0) {
          const restore = process.platform === 'win32'
            ? await sanitizeWindowsStaleRestoreState(existing, log)
            : { state: existing, skippedDeadPac: false, skippedDeadProxy: false };
          await restorePlatformAndSystemState(restore.state, log);
          restored = true;
        }
        await closeLocalPacServer();
        removeState(statePath, log);
        releaseWindowsOwnershipGate();
        return {
          supported: true,
          applied: false,
          platform: process.platform,
          reason,
          restored,
          skipped: !restored,
          sharedPac: true,
          actual: {
            sharedPacRetained: remainingOwners.length > 0,
            remainingOwners
          }
        };
      }

      if (process.platform === 'win32') {
        const ownerId = stateOwnershipOwnerId(existing);
        const otherOwnerIds = normalizeOwnershipClaims(localPacConfig?.ownershipClaims)
          .map((claim) => claim.ownerId)
          .filter((candidate) => candidate && candidate !== ownerId);
        if (otherOwnerIds.length > 0) {
          throw new Error(
            `Windows local edge still has other Launcher owners (${otherOwnerIds.join(', ')}); `
            + 'disconnect them or move all owners to one Launcher network broker.'
          );
        }
      }

      const retained = await releaseLocalOwnerAndRetainSharedEdge(existing).catch((err) => {
        log.warn('[electron-launcher] failed to release local PAC owner before restore', err);
        return null;
      });
      if (retained) {
        return publicState(retained, {
          reason,
          changed: true,
          skipped: true,
          actual: {
            localOwnerReleased: true,
            sharedPacRetained: true,
            remainingOwners: arrayValue(retained.ownershipRegistry?.owners, [])
              .map((owner) => normalizeOwnerId((owner as { ownerId?: unknown }).ownerId))
              .filter(Boolean)
          }
        });
      }
      const restore = process.platform === 'win32'
        ? await sanitizeWindowsStaleRestoreState(existing, log)
        : { state: existing, skippedDeadPac: false, skippedDeadProxy: false };
      await restorePlatformAndSystemState(restore.state, log);
      if (disableOptions.keepLocalEdgeAlive === true && localPacServer) {
        return {
          supported: true,
          applied: false,
          platform: process.platform,
          reason,
          restored: true,
          stalePreviousPacSkipped: restore.skippedDeadPac,
          stalePreviousProxySkipped: restore.skippedDeadProxy,
          actual: {
            localEdgeRetained: true,
            pacUrl: existing.pacUrl,
            pacPort: existing.pacPort
          }
        };
      }
      await closeLocalPacServer();
      removeState(statePath, log);
      releaseWindowsOwnershipGate();
      return {
        supported: true,
        applied: false,
        platform: process.platform,
        reason,
        restored: true,
        stalePreviousPacSkipped: restore.skippedDeadPac,
        stalePreviousProxySkipped: restore.skippedDeadProxy
      };
    },

    async restoreStale(reason = 'startup') {
      if (!isSupportedPlatform()) return unsupportedStatus({ reason });
      if (externalApplyTransactionPending()) return externalApplyConflictStatus(reason);
      acquireWindowsOwnershipGate();
      const existing = readState(statePath);
      if (existing?.applied === true && existing.platform === process.platform) {
        if (existing.sharedLocalPac === true) {
          try {
            const shared = await releaseSharedOwnerForState(existing);
            const remainingOwners = normalizeOwnershipClaims(shared?.ownershipClaims).map((claim) => claim.ownerId);
            let restored = false;
            if (remainingOwners.length === 0) {
              const staleRestore = process.platform === 'win32'
                ? await sanitizeWindowsStaleRestoreState(existing, log)
                : { state: existing, skippedDeadPac: false, skippedDeadProxy: false };
              await restorePlatformAndSystemState(staleRestore.state, log);
              restored = true;
            }
            await closeLocalPacServer();
            removeState(statePath, log);
            releaseWindowsOwnershipGate();
            return {
              supported: true,
              applied: false,
              platform: process.platform,
              reason,
              restored,
              skipped: !restored,
              staleState: true,
              sharedPac: true,
              actual: {
                sharedPacRetained: remainingOwners.length > 0,
                remainingOwners
              }
            };
          } catch (err) {
            const port = normalizePort(existing.pacPort);
            const liveShared = port
              ? await sharedLocalPacStatus(port).catch(() => null)
              : null;
            if (liveShared?.marker === PAC_MARKER) throw err;
            // The former host is gone. Fall through to the normal stale
            // restore, which uses compare-and-swap on Windows AutoConfigURL.
          }
        }
        const staleRestore = process.platform === 'win32'
          ? await sanitizeWindowsStaleRestoreState(existing, log)
          : { state: existing, skippedDeadPac: false, skippedDeadProxy: false };
        await restorePlatformAndSystemState(staleRestore.state, log);
        await closeLocalPacServer();
        removeState(statePath, log);
        releaseWindowsOwnershipGate();
        return {
          supported: true,
          applied: false,
          platform: process.platform,
          reason,
          restored: true,
          staleState: true,
          stalePreviousPacSkipped: staleRestore.skippedDeadPac,
          stalePreviousProxySkipped: staleRestore.skippedDeadProxy
        };
      }
      const orphanWindowsPac = process.platform === 'win32'
        ? await restoreOrphanWindowsPac(normalizePort(options.pacPort), log)
        : false;
      const orphanCleanup = await restoreOrphanSystemResolvers(log);
      await closeLocalPacServer();
      releaseWindowsOwnershipGate();
      return {
        supported: true,
        applied: false,
        platform: process.platform,
        reason,
        skipped: !orphanCleanup && !orphanWindowsPac,
        restored: orphanCleanup || orphanWindowsPac,
        orphanCleanup,
        actual: {
          orphanWindowsPac
        }
      };
    },

    darwinRestoreScript() {
      if (process.platform !== 'darwin') return null;
      if (externalApplyTransactionPending()) return null;
      const existing = readState(statePath);
      if (existing?.applied === true && existing.platform === process.platform) {
        if (requiresManagedRelease(existing, localPacConfig)) return null;
        return darwinPlatformAndSystemRestoreShell(existing);
      }
      return darwinOrphanSystemResolverRestoreShell();
    },

    async completeExternalRestore(reason = 'external') {
      if (externalApplyTransactionPending()) return externalApplyConflictStatus(reason);
      const existing = readState(statePath);
      if (existing?.applied === true && existing.platform === process.platform) {
        await releaseSharedOwnerForState(existing).catch((err) => {
          log.warn('[electron-launcher] failed to release shared PAC owner after external restore', err);
        });
      }
      await closeLocalPacServer();
      removeState(statePath, log);
      releaseWindowsOwnershipGate();
      return {
        supported: true,
        applied: false,
        platform: process.platform,
        reason,
        restored: true
      };
    },

    status() {
      if (!isSupportedPlatform()) return unsupportedStatus();
      const state = readState(statePath);
      if (!state?.applied || state.platform !== process.platform) {
        return {
          supported: true,
          applied: false,
          platform: process.platform
        };
      }
      return publicState(state);
    },

    async statusVerified() {
      return currentVerifiedStatus();
    },

    async resumeDarwinLocalEdge(policy, reason = 'app-startup') {
      if (process.platform !== 'darwin') {
        return unsupportedStatus({ reason, platform: process.platform });
      }
      const existing = readState(statePath);
      if (
        !existing?.applied
        || existing.platform !== process.platform
        || existing.pending === true
        || existing.sharedLocalPac === true
        || !isLocalPacUrl(existing.pacUrl)
      ) {
        return existing?.applied
          ? publicState(existing, {
              applied: false,
              verified: false,
              reason,
              skipped: true,
              skipReason: existing.pending === true
                ? 'darwin-local-edge-state-pending'
                : existing.sharedLocalPac === true
                  ? 'darwin-shared-local-edge-not-resumable'
                : 'darwin-local-edge-state-not-resumable',
              localEdgeResumed: false
            })
          : {
              supported: true,
              applied: false,
              verified: false,
              platform: process.platform,
              reason,
              skipped: true,
              skipReason: 'darwin-local-edge-state-missing',
              localEdgeResumed: false
            };
      }

      const before = {
        server: localPacServer,
        dnsServer: localDnsServer,
        port: localPacPort,
        key: localPacKey,
        config: localPacConfig
      };
      let pac: ResolvedPacSource | null = null;
      try {
        const [pacVerification, resolverVerification] = await Promise.all([
          verifyPlatformPac(existing.pacUrl, existing.previous),
          verifySystemResolvers(existing)
        ]);
        if (pacVerification.applied !== true || resolverVerification.applied !== true) {
          return publicState(existing, {
            applied: false,
            verified: true,
            reason,
            skipped: true,
            skipReason: 'darwin-live-system-state-mismatch',
            localEdgeResumed: false,
            actual: {
              pac: pacVerification,
              resolver: resolverVerification
            }
          });
        }
        const candidate = await resolvePacSource(policy, existing.previous, {
          allowShared: false,
          startLocalEdge: false
        });
        if (!candidate || !darwinLocalEdgeMatchesStoredState(candidate, existing)) {
          return publicState(existing, {
            applied: false,
            verified: false,
            reason,
            skipped: true,
            skipReason: 'darwin-local-edge-policy-mismatch',
            localEdgeResumed: false
          });
        }
        pac = await resolvePacSource(policy, existing.previous, { allowShared: false });
        if (!pac || !darwinLocalEdgeMatchesStoredState(pac, existing)) {
          await rollbackDarwinLocalEdgeResume(before, pac);
          return publicState(existing, {
            applied: false,
            verified: false,
            reason,
            skipped: true,
            skipReason: 'darwin-local-edge-policy-mismatch',
            localEdgeResumed: false
          });
        }
        const verified = await currentVerifiedStatus();
        if (verified.applied !== true || verified.verified !== true || verified.resolverApplied !== true) {
          await rollbackDarwinLocalEdgeResume(before, pac);
          return {
            ...verified,
            reason,
            skipped: true,
            skipReason: 'darwin-live-system-state-mismatch',
            localEdgeResumed: false
          };
        }
        return {
          ...verified,
          reason,
          changed: false,
          skipped: true,
          skipReason: 'darwin-local-edge-resumed',
          localEdgeResumed: true
        };
      } catch (err) {
        try {
          await rollbackDarwinLocalEdgeResume(before, pac);
        } catch (rollbackErr) {
          log.warn('[electron-launcher] failed to roll back macOS local edge resume', rollbackErr);
        }
        return publicState(existing, {
          applied: false,
          verified: false,
          reason,
          skipped: true,
          skipReason: 'darwin-local-edge-resume-failed',
          localEdgeResumed: false,
          error: errorMessage(err)
        });
      }
    },

    async refreshWindowsContinuation(reason = 'background') {
      if (process.platform !== 'win32') {
        return unsupportedStatus({ reason, platform: process.platform });
      }
      const state = readState(statePath);
      if (!state?.applied || state.platform !== process.platform || !state.pacPort) {
        return {
          supported: true,
          applied: false,
          platform: process.platform,
          reason,
          skipped: true
        };
      }
      if (state.sharedLocalPac === true || !localPacConfig || !localPacServer) {
        return publicState(state, {
          reason,
          skipped: true,
          changed: false,
          actual: { continuationRefresh: 'shared-or-nonlocal-edge' }
        });
      }
      let changed = false;
      let retriedPendingNotification = false;
      try {
        if (state.continuationNotifyPending === true) {
          await notifyWindowsProxyChanged();
          delete state.continuationNotifyPending;
          state.updatedAt = new Date().toISOString();
          writeState(statePath, state);
          retriedPendingNotification = true;
        }
        const current = await captureWindowsState() as Record<string, RegistryValue>;
        const continuationPrevious = windowsContinuationPrevious(state.previous, current);
        const continuation = await fallbackForPac(continuationPrevious, log);
        changed = (
          localPacConfig.fallbackProxy?.directive !== continuation.fallbackProxy?.directive
          || localPacConfig.fallbackPacUrl !== continuation.fallbackPacUrl
          || localPacConfig.fallbackPacScript !== continuation.fallbackPacScript
        );
        if (changed) {
          localPacConfig = {
            ...localPacConfig,
            fallbackProxy: continuation.fallbackProxy,
            fallbackPacUrl: continuation.fallbackPacUrl,
            fallbackPacScript: continuation.fallbackPacScript
          };
          localPacKey = localPacConfigKey(localPacConfig, localPacPort);
          state.fallbackProxy = continuation.fallbackProxy?.directive || null;
          state.fallbackPacUrl = continuation.fallbackPacUrl;
          state.continuationNotifyPending = true;
          state.updatedAt = new Date().toISOString();
          writeState(statePath, state);
          await notifyWindowsProxyChanged();
          delete state.continuationNotifyPending;
          state.updatedAt = new Date().toISOString();
          writeState(statePath, state);
        }
        return publicState(state, {
          reason,
          changed,
          verified: true,
          pending: false,
          actual: {
            continuationRefresh: changed
              ? 'updated'
              : retriedPendingNotification
                ? 'notification-retried'
                : 'unchanged'
          }
        });
      } catch (err) {
        const persisted = readState(statePath) || state;
        return publicState(persisted, {
          reason,
          changed,
          pending: persisted.continuationNotifyPending === true,
          error: `Windows proxy continuation refresh failed: ${errorMessage(err)}`,
          actual: {
            continuationRefresh: 'failed'
          }
        });
      }
    },

    async probeBrowserAccess(input) {
      const host = normalizeDomainName(input?.host);
      const port = normalizePort(input?.port) || 443;
      if (process.platform !== 'win32') {
        return {
          supported: false,
          ready: false,
          platform: process.platform,
          host,
          port,
          pacApplied: false,
          proxyReachable: false,
          skipped: true
        };
      }
      const state = readState(statePath);
      if (
        !host
        || !state?.applied
        || state.platform !== process.platform
        || state.matchMode !== 'proxy'
        || !hostMatchesDomains(host, state.domains)
      ) {
        return {
          supported: true,
          ready: false,
          platform: process.platform,
          host,
          port,
          pacApplied: false,
          proxyReachable: false,
          pacUrl: state?.pacUrl || null,
          proxy: state?.proxy || null,
          error: !host
            ? 'Invalid browser diagnostic host.'
            : 'The Internal host is not covered by an applied proxy-mode PAC.'
        };
      }
      const verified = await this.statusVerified();
      const endpoint = proxyTargetEndpoint(state.proxy || '');
      if (verified.applied !== true || !endpoint || !isLoopbackProxyHost(endpoint.host)) {
        return {
          supported: true,
          ready: false,
          platform: process.platform,
          host,
          port,
          pacApplied: verified.applied === true,
          proxyReachable: false,
          pacUrl: state.pacUrl,
          proxy: state.proxy,
          error: verified.error || verified.resolverError || 'Windows PAC is not applied to the local edge.'
        };
      }
      const connect = await probeHttpConnectProxy(
        {
          host: normalizeLoopbackProxyHost(endpoint.host),
          port: endpoint.port
        },
        { host, port },
        normalizeInteger(input?.timeoutMs) || WINDOWS_BROWSER_PROXY_PROBE_TIMEOUT_MS
      );
      return {
        supported: true,
        ready: connect.statusCode === 200,
        platform: process.platform,
        host,
        port,
        pacApplied: true,
        proxyReachable: connect.proxyReachable,
        proxyStatusCode: connect.statusCode,
        proxyStatusLine: connect.statusLine,
        pacUrl: state.pacUrl,
        proxy: state.proxy,
        error: connect.statusCode === 200 ? null : connect.error || connect.statusLine || 'Internal proxy CONNECT failed.'
      };
    },

    async close() {
      await closeLocalPacServer();
      releaseWindowsOwnershipGate();
    }
  };
}

export function renderElectronLauncherPacScript(input: {
  domains: string[];
  proxy?: ElectronLauncherPacProxy | null;
  matchMode?: ElectronLauncherPacMatchMode | null;
  fallbackProxy?: ElectronLauncherPacProxy | null;
  fallbackPacScript?: string | null;
  ownershipClaims?: ElectronLauncherNetworkOwnershipClaim[] | null;
}): string {
  const matchDirective = input.matchMode === 'proxy' && input.proxy
    ? input.proxy.directive
    : 'DIRECT';
  const fallbackDirective = input.fallbackProxy
    ? `${input.fallbackProxy.directive}; DIRECT`
    : 'DIRECT';
  const directCidrs = pacDirectCidrs(input.ownershipClaims);
  const fallbackPacScript = stringValue(input.fallbackPacScript);
  const previousPac = fallbackPacScript
    ? `var __mxPreviousFindProxyForURL = (function() {
  var FindProxyForURL;
${fallbackPacScript.replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => `  ${line}`).join('\n')}
  return typeof FindProxyForURL === 'function' ? FindProxyForURL : null;
})();`
    : 'var __mxPreviousFindProxyForURL = null;';
  return `// ${PAC_MARKER}
${previousPac}
function FindProxyForURL(url, host) {
  var h = String(host || '').toLowerCase();
  if (h === 'localhost' || h === '::1' || h === '[::1]' || h.slice(0, 4) === '127.') {
    return 'DIRECT';
  }
  var directCidrs = ${JSON.stringify(directCidrs)};
  if (isIpv4Literal(h)) {
    for (var j = 0; j < directCidrs.length; j++) {
      var c = directCidrs[j];
      if (isInNet(h, c.base, c.mask)) {
        return 'DIRECT';
      }
    }
  }
  var domains = ${JSON.stringify(normalizeDomains(input.domains))};
  for (var i = 0; i < domains.length; i++) {
    var d = domains[i];
    if (h === d || h.slice(-(d.length + 1)) === '.' + d) {
      return ${JSON.stringify(matchDirective)};
    }
  }
  if (__mxPreviousFindProxyForURL) {
    try {
      var previousDecision = __mxPreviousFindProxyForURL(url, host);
      if (typeof previousDecision === 'string' && previousDecision) {
        return previousDecision;
      }
    } catch (ignored) {
    }
  }
  return ${JSON.stringify(fallbackDirective)};
}

function isIpv4Literal(value) {
  if (!/^\\d{1,3}(?:\\.\\d{1,3}){3}$/.test(value)) return false;
  var parts = value.split('.');
  for (var i = 0; i < parts.length; i++) {
    var n = Number(parts[i]);
    if (!isFinite(n) || n < 0 || n > 255 || Math.floor(n) !== n) return false;
  }
  return true;
}
`;
}

function isSupportedPlatform(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32';
}

function unsupportedStatus(extra: Partial<ElectronLauncherSystemDomainProxyStatus> = {}): ElectronLauncherSystemDomainProxyStatus {
  return {
    supported: false,
    applied: false,
    platform: process.platform,
    ...extra
  };
}

async function capturePlatformState(): Promise<unknown> {
  if (process.platform === 'darwin') return captureDarwinState();
  if (process.platform === 'win32') return captureWindowsState();
  return {};
}

async function platformStatesForApply(existing: StoredState | null): Promise<{
  previous: unknown;
  windowsApplySnapshot: Record<string, RegistryValue> | null;
}> {
  if (process.platform === 'darwin') {
    if (!existing?.applied || existing.platform !== process.platform) {
      return {
        previous: await capturePlatformState(),
        windowsApplySnapshot: null
      };
    }
    let current: unknown = null;
    try {
      current = await capturePlatformState();
    } catch {
      // A transient networksetup read failure must not discard the original
      // restore snapshot. Live apply/verification filters stale services.
    }
    return {
      previous: mergeDarwinPreviousState(existing.previous, current, existing.pacUrl),
      windowsApplySnapshot: null
    };
  }
  if (process.platform !== 'win32') {
    return {
      previous: !existing?.applied || existing.platform !== process.platform
        ? await capturePlatformState()
        : existing.previous,
      windowsApplySnapshot: null
    };
  }
  const current = await captureWindowsState() as Record<string, RegistryValue>;
  if (!existing?.applied || existing.platform !== process.platform) {
    return { previous: current, windowsApplySnapshot: current };
  }
  const autoConfigUrl = current.autoConfigUrl;
  if (!autoConfigUrl?.exists || autoConfigUrl.value !== existing.pacUrl) {
    return { previous: current, windowsApplySnapshot: current };
  }
  const previous = existing.previous && typeof existing.previous === 'object'
    ? existing.previous as Record<string, RegistryValue>
    : {};
  return {
    previous: {
      ...current,
      autoConfigUrl: previous.autoConfigUrl ?? { exists: false, name: 'AutoConfigURL' }
    },
    windowsApplySnapshot: current
  };
}

function windowsStateWithoutAutoConfigUrl(previous: unknown): Record<string, RegistryValue> {
  const row = previous && typeof previous === 'object'
    ? previous as Record<string, RegistryValue>
    : {};
  return {
    ...row,
    autoConfigUrl: { exists: false, name: 'AutoConfigURL' }
  };
}

async function applyPlatformPac(
  pacUrl: string,
  previous: unknown,
  windowsApplySnapshot: Record<string, RegistryValue> | null
): Promise<void> {
  if (process.platform === 'darwin') {
    await applyDarwinPac(pacUrl, previous);
    return;
  }
  if (process.platform === 'win32') {
    await applyWindowsPac(pacUrl, previous, windowsApplySnapshot);
  }
}

async function applyPlatformPacAndSystemResolvers(
  pac: ResolvedPacSource,
  previous: unknown,
  existing: StoredState | null,
  log: Pick<Console, 'warn'>,
  windowsApplySnapshot: Record<string, RegistryValue> | null,
  applyOptions: ElectronLauncherSystemDomainProxyApplyOptions = {}
): Promise<SystemResolverApplyResult> {
  const plan = systemResolverPlan(pac);
  if (process.platform === 'darwin' && plan.mode === 'dynamic' && plan.port && plan.domains.length > 0) {
    return applyDarwinPacAndDynamicResolvers(
      pac.pacUrl,
      previous,
      existing,
      { ...plan, port: plan.port },
      log,
      applyOptions.forceDarwinRefresh === true
    );
  }
  await applyPlatformPac(pac.pacUrl, previous, windowsApplySnapshot);
  return applySystemResolversWithPlan(pac, existing, plan, log);
}

async function restorePlatformState(previous: unknown, pacUrl: string): Promise<void> {
  if (process.platform === 'darwin') {
    await restoreDarwinState(previous, pacUrl);
    return;
  }
  if (process.platform === 'win32') {
    await restoreWindowsState(previous, pacUrl);
  }
}

async function restorePlatformAndSystemState(state: StoredState, log: Pick<Console, 'warn'>): Promise<void> {
  if (process.platform === 'darwin') {
    await restoreDarwinPlatformAndSystemState(state, log);
    return;
  }
  await restorePlatformState(state.previous, state.pacUrl);
  await restoreSystemResolvers(state, log);
}

async function restoreOrphanSystemResolvers(log: Pick<Console, 'warn'>): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    await runDarwinPrivilegedShell(darwinOrphanSystemResolverRestoreShell());
    return true;
  } catch (err) {
    log.warn('[electron-launcher] failed to remove orphan macOS split DNS resolver', err);
    return false;
  }
}

async function verifyPlatformPac(pacUrl: string, previous: unknown): Promise<{ applied: boolean; platform: NodeJS.Platform; [key: string]: unknown }> {
  if (process.platform === 'darwin') return verifyDarwinPac(pacUrl, previous);
  if (process.platform === 'win32') return verifyWindowsPac(pacUrl, previous);
  return { applied: false, platform: process.platform };
}

async function applySystemResolvers(
  pac: ResolvedPacSource,
  existing: StoredState | null,
  log: Pick<Console, 'warn'>
): Promise<SystemResolverApplyResult> {
  const plan = systemResolverPlan(pac);
  return applySystemResolversWithPlan(pac, existing, plan, log);
}

async function applySystemResolversWithPlan(
  _pac: ResolvedPacSource,
  existing: StoredState | null,
  plan: { mode: ElectronLauncherSystemResolverMode; domains: string[]; port: number | null },
  log: Pick<Console, 'warn'>
): Promise<SystemResolverApplyResult> {
  if (systemResolverPlanMatches(existing, plan)) {
    const current = await verifySystemResolvers(existing);
    if (current.applied) {
      return {
        mode: plan.mode,
        domains: plan.domains,
        port: plan.port,
        applied: true,
        error: null
      };
    }
  }
  await removeStaleSystemResolvers(existing, plan, log);
  if (process.platform !== 'darwin' || plan.mode === 'off' || !plan.port || plan.domains.length === 0) {
    return {
      mode: plan.mode,
      domains: plan.domains,
      port: plan.port,
      applied: true,
      error: null
    };
  }
  try {
    if (plan.mode === 'dynamic') await applyDarwinDynamicResolvers(plan.domains, plan.port);
    else await applyDarwinResolvers(plan.domains, plan.port);
    const verification = plan.mode === 'dynamic'
      ? await verifyDarwinDynamicResolvers(plan.domains, plan.port)
      : verifyDarwinFileResolvers(plan.domains, plan.port);
    return {
      mode: plan.mode,
      domains: plan.domains,
      port: plan.port,
      applied: verification.applied,
      error: verification.error || null
    };
  } catch (err) {
    const message = darwinAuthorizationErrorMessage(err);
    log.warn('[electron-launcher] failed to apply macOS split DNS resolver', err);
    return {
      mode: plan.mode,
      domains: plan.domains,
      port: plan.port,
      applied: false,
      error: message
    };
  }
}

function systemResolverPlanMatches(
  existing: StoredState | null,
  plan: { mode: ElectronLauncherSystemResolverMode; domains: string[]; port: number | null }
): existing is StoredState {
  if (!existing?.applied || existing.platform !== process.platform) return false;
  if (storedSystemResolverMode(existing) !== plan.mode) return false;
  if ((normalizePort(existing.resolverPort) || null) !== (plan.port || null)) return false;
  const previousDomains = normalizeDomains(existing.resolverDomains).sort();
  const nextDomains = normalizeDomains(plan.domains).sort();
  return previousDomains.length === nextDomains.length
    && previousDomains.every((domain, index) => domain === nextDomains[index]);
}

async function verifySystemResolvers(state: StoredState): Promise<{ applied: boolean; platform: NodeJS.Platform; mode: ElectronLauncherSystemResolverMode; domains: unknown[]; error?: string | null }> {
  const mode = storedSystemResolverMode(state);
  if (process.platform !== 'darwin') {
    return {
      applied: true,
      platform: process.platform,
      mode,
      domains: []
    };
  }
  const domains = normalizeDomains(state.resolverDomains);
  const port = normalizePort(state.resolverPort);
  if (mode === 'off' || !domains.length || !port) {
    return {
      applied: true,
      platform: process.platform,
      mode,
      domains: []
    };
  }
  return mode === 'dynamic'
    ? verifyDarwinDynamicResolvers(domains, port)
    : verifyDarwinFileResolvers(domains, port);
}

async function verifyLocalDnsRelay(state: StoredState): Promise<{
  applied: boolean;
  host?: string;
  server?: string;
  aRecords?: string[];
  aaaaAnswerTypes?: number[];
  skipped?: boolean;
  error?: string | null;
}> {
  const mode = storedSystemResolverMode(state);
  const port = normalizePort(state.resolverPort);
  if (process.platform !== 'darwin' || mode === 'off' || !port) {
    return { applied: true, skipped: true };
  }
  const routes = normalizeReverseProxyRoutes(state.reverseProxyRoutes)
    .filter((item) => item.enabled !== false && isIP(item.dnsTarget || '') === 4);
  const route = routes.find((item) => /(^|\.)h2i\./i.test(item.host)) || routes[0];
  const resolverDomains = normalizeDomains(state.resolverDomains);
  const exactH2iDomain = resolverDomains
    .filter((domain) => /(^|\.)h2i\./i.test(domain))
    .sort((left, right) => right.length - left.length)[0];
  const host = route?.host || exactH2iDomain || resolverDomains[0] || normalizeDomains(state.domains)[0];
  if (!host) return { applied: true, skipped: true };
  const server = `127.0.0.1:${port}`;
  try {
    const [aResult, aaaaResult] = await Promise.all([
      queryDnsPacket(host, server, 1),
      queryDnsPacket(host, server, 28)
    ]);
    const aRecords = parseDnsARecords(aResult.response, aResult.id);
    const aaaaAnswerTypes = parseDnsAnswerTypes(aaaaResult.response, aaaaResult.id);
    if (!aRecords.length) throw new Error(`DNS A record missing for ${host}`);
    if (aaaaAnswerTypes.includes(1)) {
      throw new Error(`DNS relay returned an A answer to an AAAA query for ${host}`);
    }
    return {
      applied: true,
      host,
      server,
      aRecords,
      aaaaAnswerTypes
    };
  } catch (err) {
    return {
      applied: false,
      host,
      server,
      error: errorMessage(err)
    };
  }
}

async function restoreSystemResolvers(state: StoredState, log: Pick<Console, 'warn'>): Promise<void> {
  if (process.platform !== 'darwin') return;
  try {
    await removeDarwinDynamicResolvers();
    await removeDarwinResolvers(normalizeDomains(state.resolverDomains));
  } catch (err) {
    log.warn('[electron-launcher] failed to remove macOS split DNS resolver', err);
  }
}

async function removeStaleSystemResolvers(
  existing: StoredState | null,
  next: { mode: ElectronLauncherSystemResolverMode; domains: string[]; port: number | null },
  log: Pick<Console, 'warn'>
): Promise<void> {
  if (process.platform !== 'darwin' || !existing) return;
  const previousMode = storedSystemResolverMode(existing);
  const previousDomains = normalizeDomains(existing.resolverDomains);
  try {
    if (previousMode === 'dynamic' && (next.mode !== 'dynamic' || existing.resolverPort !== next.port)) {
      await removeDarwinDynamicResolvers();
    }
    const nextFileDomains = next.mode === 'file' ? new Set(normalizeDomains(next.domains)) : new Set<string>();
    const staleFiles = previousDomains.filter((domain) => !nextFileDomains.has(domain));
    if (staleFiles.length) await removeDarwinResolvers(staleFiles);
  } catch (err) {
    log.warn('[electron-launcher] failed to remove stale macOS split DNS resolver', err);
  }
}

function systemResolverPlan(pac: ResolvedPacSource): { mode: ElectronLauncherSystemResolverMode; domains: string[]; port: number | null } {
  if (process.platform !== 'darwin' || pac.usesLocalPac !== true || pac.systemResolverMode === 'off') {
    return {
      mode: 'off',
      domains: [],
      port: null
    };
  }
  return {
    mode: pac.systemResolverMode,
    domains: darwinResolverDomains(pac.domains),
    port: normalizePort(pac.pacPort)
  };
}

function darwinResolverDomains(domains: unknown): string[] {
  // Keep exact child zones as well as parent roots. A more-specific V2 zone
  // must be able to outrank a still-active V1 HDO /etc/resolver parent without
  // deleting or rewriting that foreign resolver.
  return currentDarwinResolverDomains(normalizeDomains(domains));
}

async function applyDarwinDynamicResolvers(domains: string[], port: number): Promise<void> {
  const script = darwinDynamicResolverScript(domains, port);
  if (!script) return;
  await runScutilScript(script);
}

function darwinDynamicResolverScript(domains: string[], port: number): string | null {
  const normalized = normalizeDomains(domains).filter(isDarwinResolverDomain);
  if (normalized.length === 0) return null;
  return [
    'd.init',
    'd.add ServerAddresses * 127.0.0.1',
    `d.add ServerPort # ${port}`,
    `d.add SupplementalMatchDomains * ${normalized.map(scutilToken).join(' ')}`,
    `d.add SupplementalMatchOrders * ${normalized.map((_, index) => String(50 + index)).join(' ')}`,
    'd.add SupplementalMatchDomainsNoSearch # 1',
    `set ${DARWIN_DYNAMIC_DNS_KEY}`,
    'quit',
    ''
  ].join('\n');
}

async function applyDarwinPacAndDynamicResolvers(
  pacUrl: string,
  previous: unknown,
  existing: StoredState | null,
  plan: { mode: ElectronLauncherSystemResolverMode; domains: string[]; port: number },
  log: Pick<Console, 'warn'>,
  forceRefresh = false
): Promise<SystemResolverApplyResult> {
  if (!forceRefresh && existing?.applied && existing.pacUrl === pacUrl && systemResolverPlanMatches(existing, plan)) {
    const pacVerification = await verifyDarwinPac(pacUrl, previous).catch(() => null);
    const resolverVerification = await verifyDarwinDynamicResolvers(plan.domains, plan.port).catch(() => null);
    if (pacVerification?.applied === true && resolverVerification?.applied === true) {
      return {
        mode: plan.mode,
        domains: plan.domains,
        port: plan.port,
        applied: true,
        error: null
      };
    }
  }
  const shell = await darwinPlatformAndSystemApplyShell(pacUrl, previous, existing, plan);
  if (!shell) {
    await applyDarwinPac(pacUrl, previous);
    return {
      mode: plan.mode,
      domains: plan.domains,
      port: plan.port,
      applied: true,
      error: null
    };
  }
  try {
    await runDarwinPrivilegedShell(shell);
    const [pacVerification, resolverVerification] = await Promise.all([
      verifyDarwinPac(pacUrl, previous),
      verifyDarwinDynamicResolvers(plan.domains, plan.port)
    ]);
    const applied = pacVerification.applied && resolverVerification.applied;
    return {
      mode: plan.mode,
      domains: plan.domains,
      port: plan.port,
      applied,
      error: applied
        ? null
        : resolverVerification.error || 'macOS PAC was not applied to every current network service'
    };
  } catch (err) {
    const message = darwinAuthorizationErrorMessage(err);
    log.warn('[electron-launcher] failed to apply macOS PAC and dynamic split DNS resolver', err);
    return {
      mode: plan.mode,
      domains: plan.domains,
      port: plan.port,
      applied: false,
      error: message
    };
  }
}

async function darwinPlatformAndSystemApplyShell(
  pacUrl: string,
  previous: unknown,
  existing: StoredState | null,
  plan: { mode: ElectronLauncherSystemResolverMode; domains: string[]; port: number | null }
): Promise<string | null> {
  if (process.platform !== 'darwin' || plan.mode !== 'dynamic' || !plan.port) return null;
  const resolverScript = darwinDynamicResolverScript(plan.domains, plan.port);
  if (!resolverScript) return null;
  const services = await liveDarwinNetworkServices(previous);
  if (services.length === 0) throw new Error('macOS network services not found');
  return [
    'set -e',
    ...darwinStaleResolverFileRemovalCommands(existing, plan),
    ...services.flatMap((name) => [
      darwinGuardedNetworksetupMutation(name, ['-setautoproxyurl', name, pacUrl]),
      darwinGuardedNetworksetupMutation(name, ['-setautoproxystate', name, 'on'])
    ]),
    `/usr/bin/printf %s ${shellQuote(resolverScript)} | /usr/sbin/scutil`,
    '/usr/bin/dscacheutil -flushcache >/dev/null 2>&1 || true',
    '/usr/bin/killall -HUP mDNSResponder >/dev/null 2>&1 || true'
  ].join('\n');
}

async function restoreDarwinPlatformAndSystemState(state: StoredState, log: Pick<Console, 'warn'>): Promise<void> {
  try {
    await runDarwinPrivilegedShell(darwinPlatformAndSystemRestoreShell(state));
  } catch (err) {
    log.warn('[electron-launcher] failed to restore macOS PAC and split DNS in one transaction', err);
    // Keep durable ownership state and the local edge intact for an explicit
    // retry. A failed/canceled combined restore must never launch a second or
    // third administrator prompt in the same user action.
    throw err;
  }
}

function darwinPlatformAndSystemRestoreShell(state: StoredState): string {
  return [
    'set -e',
    ...darwinAutoProxyRestoreCommands(state.previous, state.pacUrl),
    ...darwinOwnedPacCleanupCommands(state.previous),
    darwinLiveOwnedPacCleanupCommand(state.pacUrl),
    darwinDynamicResolverRemovalCommand(),
    ...darwinOwnedResolverFileRemovalCommands(normalizeDomains(state.resolverDomains))
  ].join('\n');
}

function darwinOrphanSystemResolverRestoreShell(): string {
  return [
    'set -e',
    darwinDynamicResolverRemovalCommand(),
    ...darwinOwnedResolverFileRemovalCommands()
  ].join('\n');
}

function darwinAutoProxyRestoreCommands(previous: unknown, ownedPacUrl: string): string[] {
  if (!ownedPacUrl) return [];
  return previousServices(previous)
    .filter((service) => service.name)
    .flatMap((service) => {
      const name = String(service.name);
      const mutations: string[] = [];
      if (service.url) {
        mutations.push(darwinGuardedNetworksetupMutation(
          name,
          ['-setautoproxyurl', name, String(service.url)]
        ));
      }
      mutations.push(darwinGuardedNetworksetupMutation(
        name,
        ['-setautoproxystate', name, service.enabled === true ? 'on' : 'off']
      ));
      const read = ['/usr/sbin/networksetup', '-getautoproxyurl', name].map(shellQuote).join(' ');
      return [
        `if ! current_proxy=$(${read} 2>/dev/null); then`,
        ...darwinNetworkServiceReadFailureGuard(name).split('\n').map((line) => `  ${line}`),
        `elif /usr/bin/printf '%s\\n' "$current_proxy" | /usr/bin/grep -Fqx ${shellQuote(`URL: ${ownedPacUrl}`)} &&`,
        `  /usr/bin/printf '%s\\n' "$current_proxy" | /usr/bin/grep -Fqx 'Enabled: Yes'; then`,
        ...mutations.flatMap((command) => command.split('\n').map((line) => `  ${line}`)),
        'fi'
      ];
    });
}

function darwinOwnedPacCleanupCommands(previous: unknown): string[] {
  return currentDarwinCleanupOnlyServices(previous).map(({ name, pacUrl }) => {
    const read = ['/usr/sbin/networksetup', '-getautoproxyurl', name]
      .map(shellQuote)
      .join(' ');
    const disable = ['/usr/sbin/networksetup', '-setautoproxystate', name, 'off']
      .map(shellQuote)
      .join(' ');
    return `if ${read} 2>/dev/null | /usr/bin/grep -Fqx ${shellQuote(`URL: ${pacUrl}`)}; then ${disable} || true; fi`;
  });
}

function darwinLiveOwnedPacCleanupCommand(pacUrl: string): string {
  if (!pacUrl) return ':';
  return [
    'network_services=$(/usr/sbin/networksetup -listallnetworkservices) || exit 1',
    '/usr/bin/printf \'%s\\n\' "$network_services" | while IFS= read -r service; do',
    '  case "$service" in ""|"An asterisk"*) continue ;; esac',
    '  service=${service#\\*}',
    `  if /usr/sbin/networksetup -getautoproxyurl "$service" 2>/dev/null | /usr/bin/grep -Fqx ${shellQuote(`URL: ${pacUrl}`)}; then`,
    '    /usr/sbin/networksetup -setautoproxystate "$service" off || true',
    '  fi',
    'done',
    'network_services=$(/usr/sbin/networksetup -listallnetworkservices) || exit 1',
    'if /usr/bin/printf \'%s\\n\' "$network_services" | while IFS= read -r service; do',
    '  case "$service" in ""|"An asterisk"*) continue ;; esac',
    '  service=${service#\\*}',
    '  if ! current_proxy=$(/usr/sbin/networksetup -getautoproxyurl "$service" 2>/dev/null); then',
    '    if ! refreshed_services=$(/usr/sbin/networksetup -listallnetworkservices 2>/dev/null); then',
    '      /usr/bin/printf \'inventory-read-failed:%s\\n\' "$service"',
    '    elif /usr/bin/printf \'%s\\n\' "$refreshed_services" | /usr/bin/sed \'s/^\\*//\' | /usr/bin/grep -Fqx "$service"; then',
    '      /usr/bin/printf \'service-read-failed:%s\\n\' "$service"',
    '    fi',
    '    continue',
    '  fi',
    `  if /usr/bin/printf '%s\\n' "$current_proxy" | /usr/bin/grep -Fqx ${shellQuote(`URL: ${pacUrl}`)} &&`,
    `    /usr/bin/printf '%s\\n' "$current_proxy" | /usr/bin/grep -Fqx 'Enabled: Yes'; then`,
    `    /usr/bin/printf '%s\\n' "$service"`,
    '  fi',
    'done | /usr/bin/grep -q .; then exit 1; fi'
  ].join('\n');
}

function darwinDynamicResolverRemovalCommand(): string {
  const script = `remove ${DARWIN_DYNAMIC_DNS_KEY}\nquit\n`;
  return `/usr/bin/printf %s ${shellQuote(script)} | /usr/sbin/scutil >/dev/null 2>&1 || true`;
}

function darwinStaleResolverFileRemovalCommands(
  existing: StoredState | null,
  next: { mode: ElectronLauncherSystemResolverMode; domains: string[] }
): string[] {
  if (!existing) return [];
  const previousDomains = normalizeDomains(existing.resolverDomains).filter(isDarwinResolverDomain);
  const nextFileDomains = next.mode === 'file' ? new Set(normalizeDomains(next.domains)) : new Set<string>();
  return previousDomains
    .filter((domain) => !nextFileDomains.has(domain))
    .map((domain) => darwinResolverPath(domain))
    .filter((filePath): filePath is string => Boolean(filePath))
    .map((filePath) => `if [ -f ${shellQuote(filePath)} ] && /usr/bin/grep -q ${shellQuote(DARWIN_RESOLVER_MARKER)} ${shellQuote(filePath)}; then /bin/rm -f ${shellQuote(filePath)}; fi`);
}

function darwinOwnedResolverFileRemovalCommands(domains?: string[]): string[] {
  const files = domains && domains.length > 0
    ? domains
        .map((domain) => darwinResolverPath(domain))
        .filter((filePath): filePath is string => Boolean(filePath))
    : darwinOwnedResolverFiles();
  return uniqueList(files)
    .map((filePath) => `if [ -f ${shellQuote(filePath)} ] && /usr/bin/grep -q ${shellQuote(DARWIN_RESOLVER_MARKER)} ${shellQuote(filePath)}; then /bin/rm -f ${shellQuote(filePath)}; fi`);
}

function darwinOwnedResolverFiles(): string[] {
  try {
    return readdirSync(DARWIN_RESOLVER_DIR)
      .map((name) => join(DARWIN_RESOLVER_DIR, name))
      .filter((filePath) => hasOwnedDarwinResolverFile(filePath));
  } catch {
    return [];
  }
}

async function verifyDarwinDynamicResolvers(domains: string[], port: number): Promise<{ applied: boolean; platform: NodeJS.Platform; mode: ElectronLauncherSystemResolverMode; domains: unknown[]; error?: string | null }> {
  const normalized = normalizeDomains(domains).filter(isDarwinResolverDomain);
  const result = await runScutilReadScript(`show ${DARWIN_DYNAMIC_DNS_KEY}\nquit\n`).catch((err) => ({
    stdout: '',
    stderr: errorMessage(err)
  }));
  const dns = await execFileText('/usr/sbin/scutil', ['--dns']).catch((err) => ({
    stdout: '',
    stderr: errorMessage(err)
  }));
  const text = `${result.stdout}\n${result.stderr}\n${dns.stdout}\n${dns.stderr}`;
  const rows = normalized.map((domain) => ({
    domain,
    applied: text.includes(domain)
  }));
  const hasServer = /127\.0\.0\.1/.test(text);
  const hasPort = new RegExp(`\\b${port}\\b`).test(text);
  const applied = rows.every((row) => row.applied) && hasServer && hasPort;
  return {
    applied,
    platform: process.platform,
    mode: 'dynamic',
    domains: rows,
    error: applied ? null : 'macOS dynamic resolver not applied'
  };
}

async function removeDarwinDynamicResolvers(): Promise<void> {
  await runScutilScript(`remove ${DARWIN_DYNAMIC_DNS_KEY}\nquit\n`).catch(() => undefined);
}

async function applyDarwinResolvers(domains: string[], port: number): Promise<void> {
  try {
    writeDarwinResolverFiles(domains, port);
  } catch {
    await runDarwinResolverApplyScript(domains, port);
  }
}

function writeDarwinResolverFiles(domains: string[], port: number): void {
  mkdirSync(DARWIN_RESOLVER_DIR, { recursive: true });
  for (const domain of domains) {
    const filePath = darwinResolverPath(domain);
    if (!filePath) continue;
    if (hasForeignDarwinResolverFile(filePath)) continue;
    writeFileSync(filePath, darwinResolverBody(domain, port));
  }
}

async function runDarwinResolverApplyScript(domains: string[], port: number): Promise<void> {
  if (domains.length === 0) return;
  const commands = ['/bin/mkdir -p /etc/resolver'];
  for (const domain of domains) {
    const filePath = darwinResolverPath(domain);
    if (!filePath) continue;
    commands.push([
      `if [ -e ${shellQuote(filePath)} ] && ! /usr/bin/grep -q ${shellQuote(DARWIN_RESOLVER_MARKER)} ${shellQuote(filePath)}; then`,
      '  :',
      'else',
      `  /usr/bin/printf %s ${shellQuote(darwinResolverBody(domain, port))} > ${shellQuote(filePath)}`,
      'fi'
    ].join('\n'));
  }
  await runDarwinPrivilegedShell(commands.join('\n'));
}

async function removeDarwinResolvers(domains: string[]): Promise<void> {
  const normalized = normalizeDomains(domains).filter(isDarwinResolverDomain);
  if (normalized.length === 0) return;
  try {
    for (const domain of normalized) {
      const filePath = darwinResolverPath(domain);
      if (!filePath || !hasOwnedDarwinResolverFile(filePath)) continue;
      rmSync(filePath, { force: true });
    }
  } catch {
    const commands = normalized
      .map((domain) => darwinResolverPath(domain))
      .filter((filePath): filePath is string => Boolean(filePath))
      .map((filePath) => `if [ -f ${shellQuote(filePath)} ] && /usr/bin/grep -q ${shellQuote(DARWIN_RESOLVER_MARKER)} ${shellQuote(filePath)}; then /bin/rm -f ${shellQuote(filePath)}; fi`);
    if (commands.length) await runDarwinPrivilegedShell(commands.join('\n'));
  }
}

function verifyDarwinFileResolvers(domains: string[], port: number): { applied: boolean; platform: NodeJS.Platform; mode: ElectronLauncherSystemResolverMode; domains: unknown[]; error?: string | null } {
  const rows = normalizeDomains(domains).map((domain) => {
    const filePath = darwinResolverPath(domain);
    if (!filePath) {
      return {
        domain,
        applied: false,
        error: 'invalid resolver domain'
      };
    }
    try {
      const text = readFileSync(filePath, 'utf8');
      const owned = text.includes(DARWIN_RESOLVER_MARKER);
      const hasNameserver = /^\s*nameserver\s+127\.0\.0\.1\s*$/im.test(text);
      const portMatch = text.match(/^\s*port\s+(\d+)\s*$/im);
      const portApplied = Number(portMatch?.[1]) === port;
      return {
        domain,
        filePath,
        owned,
        port,
        applied: owned && hasNameserver && portApplied
      };
    } catch (err) {
      return {
        domain,
        filePath,
        applied: false,
        error: errorMessage(err)
      };
    }
  });
  const failed = rows.find((row) => row.applied !== true);
  return {
    applied: rows.every((row) => row.applied === true),
    platform: process.platform,
    mode: 'file',
    domains: rows,
    error: failed ? `macOS resolver not applied for ${(failed as { domain?: string }).domain || 'domain'}` : null
  };
}

function darwinResolverBody(domain: string, port: number): string {
  return [
    `# ${DARWIN_RESOLVER_MARKER}`,
    '# generated by @qpjoy/electron-launcher',
    `# domain ${domain}`,
    'nameserver 127.0.0.1',
    `port ${port}`,
    'timeout 1',
    'search_order 1',
    ''
  ].join('\n');
}

function darwinResolverPath(domain: string): string | null {
  const clean = normalizeDomains([domain])[0];
  if (!clean || !isDarwinResolverDomain(clean)) return null;
  return join(DARWIN_RESOLVER_DIR, clean);
}

function isDarwinResolverDomain(domain: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(domain);
}

function hasForeignDarwinResolverFile(filePath: string): boolean {
  try {
    const text = readFileSync(filePath, 'utf8');
    return !text.includes(DARWIN_RESOLVER_MARKER);
  } catch {
    return false;
  }
}

function hasOwnedDarwinResolverFile(filePath: string): boolean {
  try {
    return readFileSync(filePath, 'utf8').includes(DARWIN_RESOLVER_MARKER);
  } catch {
    return false;
  }
}

async function runDarwinPrivilegedShell(command: string): Promise<void> {
  await execFileText('/usr/bin/osascript', [
    '-e',
    `do shell script ${JSON.stringify(command)} with administrator privileges`
  ]);
}

async function runScutilScript(script: string): Promise<void> {
  const command = `/usr/bin/printf %s ${shellQuote(script)} | /usr/sbin/scutil`;
  try {
    const result = await execFileText('/bin/sh', ['-c', command]);
    if (scutilNeedsPrivilege(result)) {
      throw new Error(scutilOutput(result) || 'scutil permission denied');
    }
  } catch {
    await runDarwinPrivilegedShell(command);
  }
}

function runScutilReadScript(script: string): Promise<ExecTextResult> {
  const command = `/usr/bin/printf %s ${shellQuote(script)} | /usr/sbin/scutil`;
  return execFileText('/bin/sh', ['-c', command]);
}

function scutilToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '');
}

function scutilNeedsPrivilege(result: ExecTextResult): boolean {
  return /permission denied/i.test(scutilOutput(result));
}

function scutilOutput(result: ExecTextResult): string {
  return `${result.stdout || ''}\n${result.stderr || ''}`.trim();
}

async function captureDarwinState(): Promise<{ services: unknown[] }> {
  const services = await listDarwinNetworkServices();
  const out = [];
  for (const name of services) {
    try {
      const autoProxy = await execFileText('/usr/sbin/networksetup', ['-getautoproxyurl', name]);
      const webProxy = await execFileText('/usr/sbin/networksetup', ['-getwebproxy', name]).catch(() => null);
      const secureWebProxy = await execFileText('/usr/sbin/networksetup', ['-getsecurewebproxy', name]).catch(() => null);
      const socksProxy = await execFileText('/usr/sbin/networksetup', ['-getsocksfirewallproxy', name]).catch(() => null);
      out.push({
        name,
        ...parseDarwinAutoProxy(autoProxy.stdout),
        webProxy: webProxy ? parseDarwinProxy(webProxy.stdout, 'http') : null,
        secureWebProxy: secureWebProxy ? parseDarwinProxy(secureWebProxy.stdout, 'http') : null,
        socksProxy: socksProxy ? parseDarwinProxy(socksProxy.stdout, 'socks') : null
      });
    } catch {
      // Ignore transient services that disappear while applying network settings.
    }
  }
  return { services: out };
}

async function applyDarwinPac(pacUrl: string, previous: unknown): Promise<void> {
  const services = await liveDarwinNetworkServices(previous);
  if (services.length === 0) throw new Error('macOS network services not found');
  const commands = [];
  for (const name of services) {
    commands.push(['-setautoproxyurl', name, pacUrl]);
    commands.push(['-setautoproxystate', name, 'on']);
  }
  await runDarwinNetworksetupSetBatch(commands);
}

async function verifyDarwinPac(pacUrl: string, previous: unknown): Promise<{ applied: boolean; platform: NodeJS.Platform; pacUrl: string; services: unknown[] }> {
  const baseline = darwinManagedServiceBaseline(previous);
  let listed: string[] | null = null;
  let inventoryError: string | null = null;
  try {
    listed = await listDarwinNetworkServices();
  } catch (err) {
    inventoryError = errorMessage(err);
  }
  const services = listed
    ? intersectDarwinManagedServiceNames(baseline, listed)
    : await liveDarwinNetworkServices(previous);
  const rows = [];
  for (const name of services) {
    try {
      const result = await execFileText('/usr/sbin/networksetup', ['-getautoproxyurl', name]);
      const parsed = parseDarwinAutoProxy(result.stdout);
      rows.push({
        name,
        url: parsed.url,
        enabled: parsed.enabled,
        applied: parsed.enabled === true && parsed.url === pacUrl
      });
    } catch (err) {
      const stillExists = await darwinNetworkServiceExists(name);
      rows.push(stillExists === false
        ? { name, applied: true, ignored: true, error: errorMessage(err) }
        : { name, applied: false, error: errorMessage(err) });
    }
  }
  if (listed) {
    const managed = new Set(baseline);
    for (const name of listed) {
      if (!managed.has(name)) {
        rows.push({
          name,
          applied: false,
          unmanaged: true,
          error: 'current macOS network service has no pre-MX restore snapshot'
        });
      }
    }
  } else {
    rows.push({
      name: null,
      applied: false,
      inventoryUnavailable: true,
      error: inventoryError || 'macOS network service inventory unavailable'
    });
  }
  return {
    applied: darwinPacVerificationRowsReady(rows),
    platform: process.platform,
    pacUrl,
    services: rows
  };
}

async function restoreDarwinState(previous: unknown, ownedPacUrl: string): Promise<void> {
  await runDarwinPrivilegedShell([
    'set -e',
    ...darwinAutoProxyRestoreCommands(previous, ownedPacUrl),
    ...darwinOwnedPacCleanupCommands(previous),
    darwinLiveOwnedPacCleanupCommand(ownedPacUrl)
  ].join('\n'));
}

async function listDarwinNetworkServices(): Promise<string[]> {
  const result = await execFileText('/usr/sbin/networksetup', ['-listallnetworkservices']);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('An asterisk') && !line.startsWith('*'));
}

async function liveDarwinNetworkServices(previous: unknown): Promise<string[]> {
  const baseline = darwinManagedServiceBaseline(previous);
  if (baseline.length === 0) return [];
  try {
    const listed = await listDarwinNetworkServices();
    return intersectDarwinManagedServiceNames(baseline, listed);
  } catch {
    // Fall back to the durable restore inventory, but only keep services that
    // networksetup can still read. Deleted test/VPN services must not poison
    // the privileged PAC + resolver transaction or its readiness readback.
  }
  const live = [];
  for (const name of baseline) {
    try {
      await execFileText('/usr/sbin/networksetup', ['-getautoproxyurl', name]);
      live.push(name);
    } catch {
      // The service was removed after the original restore snapshot.
    }
  }
  return live;
}

function darwinManagedServiceBaseline(previous: unknown): string[] {
  return uniqueList([
    ...darwinServiceNames(previous),
    ...currentDarwinCleanupOnlyServices(previous).map((service) => service.name)
  ]);
}

async function darwinNetworkServiceExists(name: string): Promise<boolean | null> {
  try {
    return (await listDarwinNetworkServices()).includes(name);
  } catch {
    return null;
  }
}

function parseDarwinAutoProxy(stdout: string): { url: string | null; enabled: boolean } {
  const urlMatch = stdout.match(/^URL:\s*(.*)$/im);
  const enabledMatch = stdout.match(/^Enabled:\s*(.*)$/im);
  const url = stringValue(urlMatch?.[1]);
  return {
    url: url && url !== '(null)' ? url : null,
    enabled: /^yes$/i.test(String(enabledMatch?.[1] || '').trim())
  };
}

function parseDarwinProxy(stdout: string, kind: 'http' | 'socks'): PacProxy | null {
  const enabled = /^Enabled:\s*Yes$/im.test(stdout);
  const server = stringValue(stdout.match(/^Server:\s*(.*)$/im)?.[1]);
  const port = stringValue(stdout.match(/^Port:\s*(.*)$/im)?.[1]);
  if (!enabled || !server || !port) return null;
  return normalizeProxyAddress(`${kind === 'socks' ? 'socks://' : ''}${server}:${port}`);
}

function darwinServiceNames(previous: unknown): string[] {
  return previousServices(previous).map((service) => service.name).filter(Boolean);
}

function previousServices(previous: unknown): Array<Record<string, any>> {
  if (!previous || typeof previous !== 'object') return [];
  const services = (previous as { services?: unknown }).services;
  return Array.isArray(services)
    ? services.filter((service): service is Record<string, any> => Boolean(service && typeof service === 'object'))
    : [];
}

async function runDarwinNetworksetupSetBatch(commands: string[][]): Promise<void> {
  if (commands.length === 0) return;
  try {
    for (const args of commands) {
      await execFileText('/usr/sbin/networksetup', args);
    }
  } catch {
    const command = [
      'set -e',
      ...commands.map((args) => {
        const service = args[1];
        const mutation = ['/usr/sbin/networksetup', ...args].map(shellQuote).join(' ');
        if (!service) return mutation;
        return darwinGuardedNetworksetupMutation(service, args);
      })
    ].join('\n');
    await execFileText('/usr/bin/osascript', [
      '-e',
      `do shell script ${JSON.stringify(command)} with administrator privileges`
    ]);
  }
}

function darwinGuardedNetworksetupMutation(service: string, args: string[]): string {
  const probe = ['/usr/sbin/networksetup', '-getautoproxyurl', service]
    .map(shellQuote)
    .join(' ');
  const mutation = ['/usr/sbin/networksetup', ...args]
    .map(shellQuote)
    .join(' ');
  return [
    `if ${probe} >/dev/null 2>&1; then`,
    `  if ! ${mutation}; then`,
    `    if ${probe} >/dev/null 2>&1; then`,
    '      exit 1',
    '    else',
    ...darwinNetworkServiceReadFailureGuard(service).split('\n').map((line) => `      ${line}`),
    '    fi',
    '  fi',
    'else',
    ...darwinNetworkServiceReadFailureGuard(service).split('\n').map((line) => `  ${line}`),
    'fi'
  ].join('\n');
}

function darwinNetworkServiceReadFailureGuard(service: string): string {
  return [
    'refreshed_services=$(/usr/sbin/networksetup -listallnetworkservices) || exit 1',
    `if /usr/bin/printf '%s\\n' "$refreshed_services" | /usr/bin/sed 's/^\\*//' | /usr/bin/grep -Fqx ${shellQuote(service)}; then exit 1; fi`
  ].join('\n');
}

async function captureWindowsState(): Promise<Record<string, RegistryValue>> {
  const [autoConfigUrl, proxyEnable, proxyServer, proxyOverride, autoDetect] = await Promise.all([
    queryWindowsRegistryValue('AutoConfigURL'),
    queryWindowsRegistryValue('ProxyEnable'),
    queryWindowsRegistryValue('ProxyServer'),
    queryWindowsRegistryValue('ProxyOverride'),
    queryWindowsRegistryValue('AutoDetect')
  ]);
  return {
    autoConfigUrl,
    proxyEnable,
    proxyServer,
    proxyOverride,
    autoDetect
  };
}

async function applyWindowsPac(
  pacUrl: string,
  previous: unknown,
  expectedCurrent: Record<string, RegistryValue> | null
): Promise<void> {
  if (!expectedCurrent) {
    throw new Error('Windows PAC apply is missing its captured WinINet state; refusing to overwrite AutoConfigURL.');
  }
  const current = await captureWindowsState() as Record<string, RegistryValue>;
  if (!windowsRegistrySnapshotEquals(current, expectedCurrent)) {
    throw new Error('Windows proxy settings changed while MX-H2I was preparing its PAC; refusing to overwrite AutoConfigURL.');
  }
  await addWindowsRegistryValue('AutoConfigURL', 'REG_SZ', pacUrl);
  await notifyWindowsProxyChanged();
  const verified = await verifyWindowsPac(pacUrl, previous);
  if (!verified.applied) {
    throw new Error('Windows did not retain the MX-H2I PAC after apply.');
  }
}

async function verifyWindowsPac(pacUrl: string, _previous: unknown): Promise<{
  applied: boolean;
  platform: NodeJS.Platform;
  pacUrl: string;
  autoConfigUrl: unknown;
  proxyEnable: unknown;
  proxyServer: unknown;
  proxyOverride: unknown;
  autoDetect: unknown;
}> {
  const [autoConfigUrl, proxyEnable, proxyServer, proxyOverride, autoDetect] = await Promise.all([
    queryWindowsRegistryValue('AutoConfigURL'),
    queryWindowsRegistryValue('ProxyEnable'),
    queryWindowsRegistryValue('ProxyServer'),
    queryWindowsRegistryValue('ProxyOverride'),
    queryWindowsRegistryValue('AutoDetect')
  ]);
  return {
    applied: Boolean(
      autoConfigUrl.exists
      && autoConfigUrl.value === pacUrl
    ),
    platform: process.platform,
    pacUrl,
    autoConfigUrl,
    proxyEnable,
    proxyServer,
    proxyOverride,
    autoDetect
  };
}

async function restoreWindowsState(previous: unknown, pacUrl: string): Promise<void> {
  const autoConfigUrl = await queryWindowsRegistryValue('AutoConfigURL');
  if (!autoConfigUrl.exists || autoConfigUrl.value !== pacUrl) {
    // An external owner may have won the compare-and-swap, or a previous
    // restore attempt may have committed before its WinINet notification
    // failed. Notify again before allowing the local edge to close.
    await notifyWindowsProxyChanged();
    return;
  }
  const row = previous && typeof previous === 'object' ? previous as Record<string, RegistryValue> : {};
  // AutoConfigURL is the only WinINet value owned by MX-H2I. Keeping
  // ProxyEnable/ProxyServer/ProxyOverride read-only preserves Clash system
  // proxy behavior for non-PAC applications and removes the multi-write race.
  await restoreWindowsRegistryValue('AutoConfigURL', row.autoConfigUrl, 'REG_SZ');
  await notifyWindowsProxyChanged();
  const after = await queryWindowsRegistryValue('AutoConfigURL');
  if (after.exists && after.value === pacUrl) {
    throw new Error('Windows still references the MX-H2I PAC after restore.');
  }
}

async function rollbackWindowsPartialApply(previous: unknown, pacUrl: string): Promise<void> {
  const autoConfigUrl = await queryWindowsRegistryValue('AutoConfigURL');
  if (!autoConfigUrl.exists || autoConfigUrl.value !== pacUrl) return;
  const row = previous && typeof previous === 'object' ? previous as Record<string, RegistryValue> : {};
  await restoreWindowsRegistryValue('AutoConfigURL', row.autoConfigUrl, 'REG_SZ');
  await notifyWindowsProxyChanged();
}

async function sanitizeWindowsStaleRestoreState(
  state: StoredState,
  log: Pick<Console, 'warn'>
): Promise<{ state: StoredState; skippedDeadPac: boolean; skippedDeadProxy: boolean }> {
  const previous = state.previous && typeof state.previous === 'object'
    ? state.previous as Record<string, RegistryValue>
    : {};
  const nextPrevious: Record<string, RegistryValue> = { ...previous };
  let skippedDeadPac = false;
  let skippedDeadProxy = false;

  const previousPacEndpoint = loopbackUrlEndpoint(previous.autoConfigUrl?.value);
  let loopbackProxyEndpoints: TcpEndpoint[] | null = null;
  if (previous.proxyEnable?.exists && !windowsRegistryDwordEquals(previous.proxyEnable, 0)) {
    // ProxyEnable would activate the live ProxyServer value, not the saved
    // snapshot. If that live value is unreadable, abort stale restore rather
    // than guessing listener liveness from an unrelated old port.
    const currentProxyServer = await queryWindowsRegistryValue('ProxyServer');
    loopbackProxyEndpoints = windowsLoopbackProxyEndpoints(currentProxyServer?.value);
  }
  // During Windows login MX-H2I can start slightly before Clash. Give loopback
  // owners a short grace window before deciding that an old listener is stale.
  const [previousPacReady, previousProxyReady] = await Promise.all([
    previousPacEndpoint ? tcpEndpointReadyWithGrace(previousPacEndpoint) : Promise.resolve(true),
    loopbackProxyEndpoints
      ? loopbackProxyEndpoints.length > 0
        ? Promise.all(loopbackProxyEndpoints.map(tcpEndpointReadyWithGrace)).then((rows) => rows.every(Boolean))
        : Promise.resolve(false)
      : Promise.resolve(true)
  ]);
  if (previousPacEndpoint && !previousPacReady) {
    nextPrevious.autoConfigUrl = { exists: false, name: 'AutoConfigURL' };
    skippedDeadPac = true;
    log.warn(
      `[electron-launcher] skipped stale Windows PAC restore because ${previousPacEndpoint.host}:${previousPacEndpoint.port} is not listening`
    );
  }

  if (loopbackProxyEndpoints && !previousProxyReady) {
    nextPrevious.proxyEnable = {
      exists: true,
      name: 'ProxyEnable',
      type: 'REG_DWORD',
      value: '0'
    };
    skippedDeadProxy = true;
    log.warn('[electron-launcher] skipped stale Windows static proxy enable because its loopback listener is unavailable');
  }

  if (!skippedDeadPac && !skippedDeadProxy) {
    return { state, skippedDeadPac, skippedDeadProxy };
  }
  return {
    state: {
      ...state,
      previous: nextPrevious
    },
    skippedDeadPac,
    skippedDeadProxy
  };
}

async function restoreOrphanWindowsPac(
  expectedPort: number | null,
  log: Pick<Console, 'warn'>
): Promise<boolean> {
  if (process.platform !== 'win32' || !expectedPort) return false;
  const current = await queryWindowsRegistryValue('AutoConfigURL');
  const value = current.exists ? stringValue(current.value) : null;
  if (!value) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (
    !['http:', 'https:'].includes(url.protocol)
    || !isLoopbackProxyHost(url.hostname)
    || port !== expectedPort
    || url.pathname !== PAC_PATH
  ) {
    return false;
  }
  try {
    const script = await httpTextRequest(url, 1000, WINDOWS_FALLBACK_PAC_MAX_BYTES);
    // A live marked edge may belong to another launcher process. Without a
    // state/owner claim this process must not remove its system PAC.
    if (script.includes(PAC_MARKER)) return false;
    return false;
  } catch {
    const endpoint = { host: normalizeLoopbackProxyHost(url.hostname), port };
    if (await tcpEndpointReady(endpoint)) return false;
  }
  await deleteWindowsRegistryValue('AutoConfigURL');
  await notifyWindowsProxyChanged();
  const after = await queryWindowsRegistryValue('AutoConfigURL');
  if (after.exists && after.value === value) {
    throw new Error('Windows orphan MX-H2I PAC cleanup did not clear AutoConfigURL.');
  }
  log.warn(`[electron-launcher] removed orphan Windows PAC ${value} because its local edge is unavailable`);
  return true;
}

interface RegistryValue {
  exists?: boolean;
  name?: string;
  type?: string;
  value?: string;
}

interface TcpEndpoint {
  host: string;
  port: number;
}

function windowsRegistryDwordEquals(value: RegistryValue, expected: number): boolean {
  const text = String(value.value || '').trim();
  return value.exists === true && text !== '' && Number(text) === expected;
}

function loopbackUrlEndpoint(value: string | undefined): TcpEndpoint | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (!isLoopbackProxyHost(parsed.hostname)) return null;
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    return Number.isInteger(port) && port > 0 && port <= 65535
      ? { host: normalizeLoopbackProxyHost(parsed.hostname), port }
      : null;
  } catch {
    return null;
  }
}

function windowsLoopbackProxyEndpoints(value: string | undefined): TcpEndpoint[] | null {
  const text = String(value || '').trim();
  if (!text) return [];
  const targets = text.includes('=')
    ? text.split(';').map((part) => part.slice(part.indexOf('=') + 1).trim()).filter(Boolean)
    : [text];
  const endpoints: TcpEndpoint[] = [];
  for (const target of targets) {
    const endpoint = proxyTargetEndpoint(target);
    if (!endpoint || !isLoopbackProxyHost(endpoint.host)) return null;
    endpoints.push({
      host: normalizeLoopbackProxyHost(endpoint.host),
      port: endpoint.port
    });
  }
  return endpoints.filter((endpoint, index, rows) => (
    rows.findIndex((row) => row.host === endpoint.host && row.port === endpoint.port) === index
  ));
}

function proxyTargetEndpoint(value: string): TcpEndpoint | null {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    const parsed = new URL(text.includes('://') ? text : `http://${text}`);
    const port = Number(parsed.port);
    if (!parsed.hostname || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return { host: parsed.hostname, port };
  } catch {
    return null;
  }
}

function isLoopbackProxyHost(value: string): boolean {
  const host = String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function normalizeLoopbackProxyHost(value: string): string {
  const host = String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' ? '127.0.0.1' : host;
}

function tcpEndpointReady(endpoint: TcpEndpoint): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host: endpoint.host, port: endpoint.port });
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ready);
    };
    const timer = setTimeout(() => finish(false), 500);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function tcpEndpointReadyWithGrace(endpoint: TcpEndpoint): Promise<boolean> {
  for (let attempt = 1; attempt <= 7; attempt += 1) {
    if (await tcpEndpointReady(endpoint)) return true;
    if (attempt < 7) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function probeHttpConnectProxy(
  proxy: TcpEndpoint,
  target: TcpEndpoint,
  timeoutMs: number
): Promise<{
  proxyReachable: boolean;
  statusCode: number | null;
  statusLine: string | null;
  error: string | null;
}> {
  return new Promise((resolve) => {
    const socket = netConnect({ host: proxy.host, port: proxy.port });
    let settled = false;
    let proxyReachable = false;
    let response = '';
    const finish = (result: {
      statusCode?: number | null;
      statusLine?: string | null;
      error?: string | null;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({
        proxyReachable,
        statusCode: result.statusCode ?? null,
        statusLine: result.statusLine ?? null,
        error: result.error ?? null
      });
    };
    const timer = setTimeout(() => {
      finish({ error: `Browser proxy CONNECT timed out after ${timeoutMs} ms.` });
    }, Math.max(250, timeoutMs));
    socket.once('connect', () => {
      proxyReachable = true;
      socket.write(
        `CONNECT ${target.host}:${target.port} HTTP/1.1\r\n`
        + `Host: ${target.host}:${target.port}\r\n`
        + 'Proxy-Connection: close\r\n\r\n'
      );
    });
    socket.on('data', (chunk) => {
      if (response.length < 4096) response += chunk.toString('latin1');
      const lineEnd = response.indexOf('\r\n');
      if (lineEnd < 0) return;
      const statusLine = response.slice(0, lineEnd);
      const match = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/i);
      finish({
        statusCode: match ? Number(match[1]) : null,
        statusLine,
        error: match ? null : `Invalid proxy response: ${statusLine}`
      });
    });
    socket.once('error', (err) => finish({ error: errorMessage(err) }));
    socket.once('end', () => {
      if (!settled) finish({ error: 'Browser proxy closed before returning a CONNECT response.' });
    });
  });
}

async function restoreWindowsRegistryValue(name: string, value: RegistryValue | undefined, fallbackType: string): Promise<void> {
  if (value?.exists) {
    await addWindowsRegistryValue(name, value.type || fallbackType, value.value || '');
  } else {
    await deleteWindowsRegistryValue(name);
  }
}

async function queryWindowsRegistryValue(name: string): Promise<RegistryValue> {
  try {
    const result = await execFileText(
      'reg.exe',
      ['query', WINDOWS_PROXY_KEY, '/v', name],
      { timeoutMs: WINDOWS_REGISTRY_COMMAND_TIMEOUT_MS }
    );
    return parseWindowsRegistryValue(result.stdout, name) || { exists: false, name };
  } catch (err) {
    if (execFileTimedOut(err)) throw err;
    // `reg query /v` uses the same non-zero exit status for a missing value
    // and for operational failures such as access denial. Re-query the whole
    // key: a readable key with no matching row proves absence; another failure
    // is unknown state and must abort CAS/restore instead of closing a PAC that
    // may still be registered.
    try {
      const result = await execFileText(
        'reg.exe',
        ['query', WINDOWS_PROXY_KEY],
        { timeoutMs: WINDOWS_REGISTRY_COMMAND_TIMEOUT_MS }
      );
      return parseWindowsRegistryValue(result.stdout, name) || { exists: false, name };
    } catch (keyErr) {
      throw keyErr;
    }
  }
}

function parseWindowsRegistryValue(stdout: string, name: string): RegistryValue | null {
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const match = line.trim().match(/^(\S+)\s+(REG_\S+)\s*(.*)$/);
    if (!match || match[1] !== name) continue;
    return {
      exists: true,
      name,
      type: match[2],
      value: match[3] || ''
    };
  }
  return null;
}

async function addWindowsRegistryValue(name: string, type: string, value: string): Promise<ExecTextResult> {
  try {
    return await execFileText(
      'reg.exe',
      ['add', WINDOWS_PROXY_KEY, '/v', name, '/t', type, '/d', String(value), '/f'],
      { timeoutMs: WINDOWS_REGISTRY_COMMAND_TIMEOUT_MS }
    );
  } catch (err) {
    // A timed-out or interrupted reg.exe may have committed before reporting
    // failure. Only accept that ambiguous result when a read-back proves the
    // exact target value; otherwise preserve state and surface the write error.
    const current = await queryWindowsRegistryValue(name);
    if (windowsRegistryValueEquals(current, type, value)) {
      return { stdout: '', stderr: '' };
    }
    throw err;
  }
}

async function deleteWindowsRegistryValue(name: string): Promise<ExecTextResult | undefined> {
  try {
    return await execFileText(
      'reg.exe',
      ['delete', WINDOWS_PROXY_KEY, '/v', name, '/f'],
      { timeoutMs: WINDOWS_REGISTRY_COMMAND_TIMEOUT_MS }
    );
  } catch (err) {
    // Missing is an idempotent delete success, including the case where
    // reg.exe removed the value and then returned an error. A readable value
    // that still exists means restore did not complete and must not be hidden.
    const current = await queryWindowsRegistryValue(name);
    if (!current.exists) return undefined;
    throw err;
  }
}

function windowsRegistryValueEquals(value: RegistryValue, type: string, expected: string): boolean {
  if (!value.exists || String(value.type || '').toUpperCase() !== type.toUpperCase()) return false;
  if (type.toUpperCase() === 'REG_DWORD') {
    const actualNumber = Number(String(value.value || '').trim());
    const expectedNumber = Number(String(expected).trim());
    return Number.isFinite(actualNumber)
      && Number.isFinite(expectedNumber)
      && actualNumber === expectedNumber;
  }
  return String(value.value ?? '') === String(expected);
}

function windowsRegistrySnapshotEquals(
  current: Record<string, RegistryValue>,
  expected: Record<string, RegistryValue>
): boolean {
  for (const key of ['autoConfigUrl', 'proxyEnable', 'proxyServer', 'proxyOverride', 'autoDetect']) {
    const currentValue = current[key];
    const expectedValue = expected[key];
    if (currentValue?.exists !== expectedValue?.exists) return false;
    if (currentValue?.exists !== true) continue;
    if (!expectedValue?.type || expectedValue.value === undefined) return false;
    if (!windowsRegistryValueEquals(currentValue, expectedValue.type, expectedValue.value)) return false;
  }
  return true;
}

async function notifyWindowsProxyChanged(): Promise<ExecTextResult> {
  const script = [
    `$sig = '[DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);';`,
    '$type = Add-Type -MemberDefinition $sig -Name WinInetNotify -Namespace QPJoy -PassThru;',
    '$settingsChanged = $type::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0);',
    'if (-not $settingsChanged) { $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error(); throw "InternetSetOption(39) failed: $code"; }',
    '$refresh = $type::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0);',
    'if (-not $refresh) { $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error(); throw "InternetSetOption(37) failed: $code"; }'
  ].join(' ');
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script];
  const powershell = windowsPowerShellCommand();
  try {
    return await execFileText(
      powershell,
      args,
      { timeoutMs: WINDOWS_PROXY_NOTIFY_TIMEOUT_MS }
    );
  } catch {
    return execFileText(
      powershell,
      args,
      { timeoutMs: WINDOWS_PROXY_NOTIFY_TIMEOUT_MS }
    );
  }
}

async function fallbackForPac(
  previous: unknown,
  log?: Pick<Console, 'warn'>
): Promise<PacContinuation> {
  if (process.platform === 'darwin') {
    for (const service of previousServices(previous)) {
      const proxy = service.secureWebProxy || service.webProxy || service.socksProxy;
      if (proxy?.directive) {
        return {
          fallbackProxy: proxy as PacProxy,
          fallbackPacUrl: null,
          fallbackPacScript: null
        };
      }
    }
    return { fallbackProxy: null, fallbackPacUrl: null, fallbackPacScript: null };
  }
  if (process.platform !== 'win32') {
    return { fallbackProxy: null, fallbackPacUrl: null, fallbackPacScript: null };
  }

  const row = previous && typeof previous === 'object'
    ? previous as Record<string, RegistryValue>
    : {};
  // Chromium gives automatic settings precedence over manual proxy rules.
  // Preserve a configured PAC before considering ProxyEnable/ProxyServer.
  // platformStatesForApply removes our own PAC URL when Clash toggles
  // ProxyEnable while MX-H2I is active, so that transition still becomes a
  // static-proxy continuation rather than recursively wrapping our PAC.
  const fallbackPacUrl = row.autoConfigUrl?.exists
    ? stringValue(row.autoConfigUrl.value)
    : null;
  let staleWindowsPacIgnored = false;
  if (fallbackPacUrl) {
    try {
      const fallbackPacScript = await readWindowsFallbackPac(fallbackPacUrl);
      return { fallbackProxy: null, fallbackPacUrl, fallbackPacScript };
    } catch (err) {
      const endpoint = loopbackUrlEndpoint(fallbackPacUrl);
      if (
        !endpoint
        || !errorMessage(err).startsWith('Existing Windows PAC could not be read:')
      ) {
        throw err;
      }
      if (await tcpEndpointReadyWithGrace(endpoint)) {
        const fallbackPacScript = await readWindowsFallbackPac(fallbackPacUrl);
        return { fallbackProxy: null, fallbackPacUrl, fallbackPacScript };
      }
      staleWindowsPacIgnored = true;
      log?.warn(
        `[electron-launcher] ignored stale Windows PAC ${fallbackPacUrl} because `
        + `${endpoint.host}:${endpoint.port} is not listening`
      );
    }
  }
  if (windowsRegistryDwordEquals(row.proxyEnable, 1)) {
    const proxy = windowsStaticProxyForPac(row.proxyServer?.value);
    if (!proxy) {
      throw new Error('Active Windows static proxy cannot be represented safely in the MX-H2I PAC.');
    }
    const endpoints = windowsLoopbackProxyEndpoints(row.proxyServer?.value);
    if (!endpoints?.length) {
      throw new Error('Active Windows static proxy is not a supported loopback proxy; MX-H2I did not replace it.');
    }
    const ready = await Promise.all(endpoints.map(tcpEndpointReadyWithGrace));
    const unavailable = endpoints.find((_endpoint, index) => ready[index] !== true);
    if (unavailable) {
      throw new Error(`Active Windows proxy ${unavailable.host}:${unavailable.port} is not listening; MX-H2I did not replace it.`);
    }
    return {
      fallbackProxy: proxy,
      fallbackPacUrl: null,
      fallbackPacScript: windowsStaticProxyPacScript(
        row.proxyServer?.value,
        row.proxyOverride?.value
      ),
      staleWindowsPacIgnored
    };
  }
  if (windowsRegistryDwordEquals(row.autoDetect, 1)) {
    throw new Error('Windows WPAD/AutoDetect is active and cannot be preserved by the MX-H2I PAC.');
  }
  return {
    fallbackProxy: null,
    fallbackPacUrl: null,
    fallbackPacScript: null,
    staleWindowsPacIgnored
  };
}

function windowsContinuationPrevious(
  previous: unknown,
  current: Record<string, RegistryValue>
): Record<string, RegistryValue> {
  const row = previous && typeof previous === 'object'
    ? previous as Record<string, RegistryValue>
    : {};
  // AutoConfigURL is currently the MX PAC, so retain the captured external
  // PAC URL. Manual proxy fields are inactive for that automatic owner.
  if (row.autoConfigUrl?.exists && stringValue(row.autoConfigUrl.value)) {
    return row;
  }
  return {
    ...row,
    autoConfigUrl: { exists: false, name: 'AutoConfigURL' },
    proxyEnable: current.proxyEnable,
    proxyServer: current.proxyServer,
    proxyOverride: current.proxyOverride,
    autoDetect: current.autoDetect
  };
}

function windowsStaticProxyForPac(value: string | undefined): PacProxy | null {
  const entries = windowsStaticProxyEntries(value);
  for (const scheme of ['https', 'http', 'socks', 'socks5', 'all']) {
    const entry = entries.find((candidate) => candidate.scheme === scheme);
    if (!entry) continue;
    if (entry.proxy) return entry.proxy;
  }
  return null;
}

function windowsStaticProxyEntries(
  value: string | undefined
): Array<{ scheme: string; target: string; proxy: PacProxy | null }> {
  const text = stringValue(value);
  if (!text) return [];
  const rows = text.includes('=')
    ? text.split(';').map((part) => {
        const separator = part.indexOf('=');
        return separator > 0
          ? {
              scheme: part.slice(0, separator).trim().toLowerCase(),
              target: part.slice(separator + 1).trim()
            }
          : null;
      }).filter((entry): entry is { scheme: string; target: string } => Boolean(entry?.target))
    : [{ scheme: 'all', target: text }];
  return rows.map((entry) => ({
    ...entry,
    proxy: normalizeProxyAddress(
      entry.scheme.startsWith('socks') ? `socks://${entry.target}` : entry.target
    )
  }));
}

function windowsStaticProxyPacScript(
  proxyServer: string | undefined,
  proxyOverride: string | undefined
): string {
  const entries = windowsStaticProxyEntries(proxyServer)
    .filter((entry) => entry.proxy);
  const rules: Record<string, string> = {};
  for (const entry of entries) {
    if (!['all', 'http', 'https', 'ftp', 'socks', 'socks5'].includes(entry.scheme)) continue;
    rules[entry.scheme === 'socks5' ? 'socks' : entry.scheme] = entry.proxy
      ? `${entry.proxy.directive}; DIRECT`
      : 'DIRECT';
  }
  const bypass = String(proxyOverride || '')
    .split(';')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return `function FindProxyForURL(url, host) {
  var h = String(host || '').toLowerCase();
  var u = String(url || '');
  var bypass = ${JSON.stringify(bypass)};
  for (var i = 0; i < bypass.length; i++) {
    var pattern = bypass[i];
    if (pattern === '<local>' && h.indexOf('.') < 0) return 'DIRECT';
    if (pattern === '<-loopback>') continue;
    if (pattern.indexOf('://') >= 0) {
      if (shExpMatch(u.toLowerCase(), pattern)) return 'DIRECT';
    } else if (shExpMatch(h, pattern)) {
      return 'DIRECT';
    }
  }
  var rules = ${JSON.stringify(rules)};
  var separator = u.indexOf(':');
  var scheme = separator > 0 ? u.slice(0, separator).toLowerCase() : '';
  return rules[scheme] || rules.all || rules.socks || 'DIRECT';
}`;
}

async function readWindowsFallbackPac(value: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Existing Windows PAC URL is invalid: ${value}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !isLoopbackProxyHost(parsed.hostname)) {
    throw new Error(`Existing Windows PAC must be a readable loopback HTTP(S) URL: ${value}`);
  }
  let script: string;
  try {
    script = await httpTextRequest(
      parsed,
      WINDOWS_FALLBACK_PAC_TIMEOUT_MS,
      WINDOWS_FALLBACK_PAC_MAX_BYTES
    );
  } catch (err) {
    throw new Error(`Existing Windows PAC could not be read: ${errorMessage(err)}`);
  }
  if (!/\bFindProxyForURL\b/.test(script)) {
    throw new Error(`Existing Windows PAC does not define FindProxyForURL: ${value}`);
  }
  try {
    // Compile only. The existing PAC already runs in the browser PAC sandbox;
    // wrapping it must not execute it inside the launcher process.
    new Function(`return function () {\nvar FindProxyForURL;\n${script}\nreturn FindProxyForURL;\n};`);
  } catch (err) {
    throw new Error(`Existing Windows PAC cannot be wrapped safely: ${errorMessage(err)}`);
  }
  return script;
}

function httpTextRequest(url: URL, timeoutMs: number, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const requestImpl = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = requestImpl({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      timeout: timeoutMs
    }, (res) => {
      if ((res.statusCode || 500) >= 400) {
        res.resume();
        reject(new Error(`Existing Windows PAC returned HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          res.destroy(new Error(`Existing Windows PAC exceeds ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`Existing Windows PAC request timed out: ${url.href}`)));
    req.on('error', reject);
    req.end();
  });
}

async function handleProxyHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: LocalPacServerConfig | null
): Promise<void> {
  if (!config) {
    writeTextResponse(res, 503, 'Electron Launcher proxy is not configured');
    return;
  }
  if (req.method === 'CONNECT') {
    writeTextResponse(res, 405, 'CONNECT must use the proxy tunnel path');
    return;
  }
  const target = proxyHttpTarget(req);
  if (!target) {
    writeTextResponse(res, 400, 'unsupported proxy request target');
    return;
  }
  if (target.protocol !== 'http:') {
    writeTextResponse(res, 501, `unsupported proxy protocol: ${target.protocol}`);
    return;
  }
  try {
    const route = reverseProxyRouteForHost(target.hostname, config);
    const routeUrl = route?.targetUrl ? new URL(route.targetUrl) : null;
    const targetHost = routeUrl
      ? stripHostBrackets(routeUrl.hostname)
      : await resolveProxyHost(target.hostname, config);
    const targetPort = routeUrl
      ? upstreamPort(routeUrl)
      : Number(target.port || 80);
    const requestImpl = routeUrl?.protocol === 'https:' ? httpsRequest : httpRequest;
    const upstreamHostHeader = routeUrl && route && shouldPreserveHostForGatewayRoute(route, routeUrl)
      ? target.host
      : routeUrl?.host || target.host;
    const upstream = requestImpl({
      host: targetHost,
      port: targetPort,
      method: req.method,
      path: routeUrl ? reverseProxyPath(routeUrl, target) : `${target.pathname}${target.search}`,
      headers: proxyForwardHeaders(req, upstreamHostHeader, target.host),
      timeout: PROXY_CONNECT_TIMEOUT_MS
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.statusMessage || undefined, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new Error(`proxy request timeout: ${target.host}`)));
    upstream.on('error', (err) => {
      if (!res.headersSent) writeTextResponse(res, 502, errorMessage(err));
      else res.destroy(err);
    });
    req.pipe(upstream);
  } catch (err) {
    writeTextResponse(res, 502, errorMessage(err));
  }
}

async function resolveProxyHost(host: string, config: LocalPacServerConfig | null): Promise<string> {
  const cleanHost = stripHostBrackets(host).toLowerCase();
  if (!cleanHost || isIP(cleanHost)) return cleanHost;
  const routeTarget = dnsTargetForHost(cleanHost, config);
  if (routeTarget) return routeTarget;
  const ownershipTarget = dnsOwnershipTargetForHost(cleanHost, config);
  if (ownershipTarget) return ownershipTarget;
  if (!config?.dnsServers.length || !hostMatchesDomains(cleanHost, config.domains)) return cleanHost;
  const failures: string[] = [];
  for (const server of config.dnsServers) {
    try {
      return await resolveDnsA(cleanHost, server);
    } catch (err) {
      failures.push(`${server}: ${errorMessage(err)}`);
    }
  }
  if (config.dnsFallbackTarget) return config.dnsFallbackTarget;
  throw new Error(`Internal DNS failed for ${cleanHost}: ${failures.join('; ')}`);
}

function reverseProxyRouteForHost(host: string, config: LocalPacServerConfig | null): ElectronLauncherSystemDomainProxyRoute | null {
  const cleanHost = normalizeDomainName(stripHostBrackets(host));
  if (!cleanHost || !config?.reverseProxyRoutes.length) return null;
  return config.reverseProxyRoutes.find((route) => route.host === cleanHost) || null;
}

function dnsTargetForHost(host: string, config: LocalPacServerConfig | null): string | null {
  const route = reverseProxyRouteForHost(host, config);
  return route?.dnsTarget && isIP(route.dnsTarget) ? route.dnsTarget : null;
}

function dnsOwnershipTargetForHost(host: string, config: LocalPacServerConfig | null): string | null {
  if (!config?.ownershipClaims.length) return null;
  const registry = localConfigOwnershipRegistry(config);
  const owner = resolveElectronLauncherDnsOwner(registry, host);
  return owner?.target && isIP(owner.target) === 4 ? owner.target : null;
}

function connectRouteTarget(
  authority: { host: string; port: number },
  config: LocalPacServerConfig | null
): { host: string; port: number } | null {
  const route = reverseProxyRouteForHost(authority.host, config);
  if (!route?.targetUrl) return null;
  const url = new URL(route.targetUrl);
  if (url.protocol !== 'https:' && route.tlsMode !== 'passthrough') return null;
  return {
    host: stripHostBrackets(url.hostname),
    port: upstreamPort(url)
  };
}

function shouldPreserveHostForGatewayRoute(route: ElectronLauncherSystemDomainProxyRoute, url: URL): boolean {
  const dnsTarget = normalizeDnsTarget(route.dnsTarget);
  if (!dnsTarget || stripHostBrackets(url.hostname) !== dnsTarget) return false;
  return INTERNAL_GATEWAY_APP_PORTS.has(upstreamPort(url));
}

function upstreamPort(url: URL): number {
  const port = Number(url.port);
  if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
  return url.protocol === 'https:' ? 443 : 80;
}

function reverseProxyPath(upstream: URL, target: URL): string {
  const base = upstream.pathname && upstream.pathname !== '/'
    ? upstream.pathname.replace(/\/+$/g, '')
    : '';
  const path = target.pathname || '/';
  return `${base}${path.startsWith('/') ? path : `/${path}`}${target.search}`;
}

function proxyHttpTarget(req: IncomingMessage): URL | null {
  const raw = req.url || '';
  try {
    if (/^https?:\/\//i.test(raw)) return new URL(raw);
    const host = headerString(req.headers.host);
    if (!host) return null;
    return new URL(raw || '/', `http://${host}`);
  } catch {
    return null;
  }
}

function proxyForwardHeaders(req: IncomingMessage, hostHeader: string, originalHost?: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if ([
      'connection',
      'proxy-authorization',
      'proxy-connection',
      'proxy-authenticate',
      'te',
      'trailer',
      'transfer-encoding',
      'upgrade'
    ].includes(lower)) continue;
    out[key] = Array.isArray(value) ? value.map(String) : String(value);
  }
  out.Host = hostHeader;
  if (originalHost && originalHost !== hostHeader) {
    out['X-Forwarded-Host'] = originalHost;
    out['X-MX-Original-Host'] = originalHost;
  }
  return out;
}

function localControlPath(req: IncomingMessage): string | null {
  const raw = req.url || '/';
  try {
    if (/^https?:\/\//i.test(raw)) {
      const url = new URL(raw);
      return isLocalhostName(url.hostname) ? url.pathname : null;
    }
    return new URL(raw, 'http://127.0.0.1').pathname;
  } catch {
    return null;
  }
}

async function registerSharedLocalPacServer(port: number, config: LocalPacServerConfig): Promise<{ pacUrl: string; config?: LocalPacServerConfig | null }> {
  const pacUrl = `http://127.0.0.1:${port}${PAC_PATH}`;
  const status = await sharedLocalPacStatus(port).catch(() => null);
  if (status?.marker !== PAC_MARKER) {
    throw new Error(`127.0.0.1:${port} is already in use and is not an Electron Launcher local edge`);
  }
  const response = await httpJsonRequest(`http://127.0.0.1:${port}${SHARED_APPLY_PATH}`, config, 1800);
  if (response.marker !== PAC_MARKER) {
    throw new Error(`127.0.0.1:${port} did not accept Electron Launcher PAC registration`);
  }
  return { pacUrl, config: normalizeSharedLocalPacConfig(response) };
}

async function releaseSharedLocalPacServer(port: number, ownerId: string): Promise<Record<string, unknown>> {
  const response = await httpJsonRequest(`http://127.0.0.1:${port}${SHARED_RELEASE_PATH}`, { ownerId }, 1800);
  if (response.marker !== PAC_MARKER) {
    throw new Error(`127.0.0.1:${port} did not accept Electron Launcher PAC release`);
  }
  return response;
}

async function sharedLocalPacStatus(port: number): Promise<Record<string, unknown>> {
  return httpJsonRequest(`http://127.0.0.1:${port}${SHARED_STATUS_PATH}`, null, 1200);
}

function resolvedPacSourceFromLocalConfig(
  pacUrl: string,
  pacPort: number,
  systemResolverMode: ElectronLauncherSystemResolverMode,
  config: LocalPacServerConfig
): ResolvedPacSource {
  const effective = applyOwnershipRegistryToLocalConfig(config);
  return {
    pacUrl,
    domains: effective.domains,
    proxy: effective.proxy,
    matchMode: effective.matchMode,
    fallbackProxy: effective.fallbackProxy,
    fallbackPacUrl: effective.fallbackPacUrl,
    fallbackPacScript: effective.fallbackPacScript,
    pacPort,
    sharedLocalPac: false,
    dnsServers: effective.dnsServers,
    dnsFallbackTarget: effective.dnsFallbackTarget,
    systemResolverMode,
    reverseProxyRoutes: effective.reverseProxyRoutes,
    ownershipClaim: null,
    ownershipClaims: effective.ownershipClaims,
    usesLocalPac: true
  };
}

function normalizeSharedLocalPacConfig(value: unknown): LocalPacServerConfig {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    domains: normalizeDomains(row.domains),
    proxy: normalizeProxyAddress(row.proxyDirective) || normalizeProxyAddress(row.proxy),
    matchMode: normalizeMatchMode(row.matchMode, row.proxy),
    fallbackProxy: normalizeProxyAddress(row.fallbackProxyDirective) || normalizeProxyAddress(row.fallbackProxy),
    fallbackPacUrl: stringValue(row.fallbackPacUrl),
    fallbackPacScript: stringValue(row.fallbackPacScript),
    dnsServers: normalizeDnsServers(row.dnsServers),
    dnsFallbackTarget: normalizeDnsTarget(row.dnsFallbackTarget),
    reverseProxyRoutes: normalizeReverseProxyRoutes(row.reverseProxyRoutes),
    ownershipClaims: normalizeOwnershipClaims([
      ...arrayValue(row.ownershipClaims, []),
      row.ownershipClaim
    ])
  };
}

function mergeLocalPacConfigs(
  current: LocalPacServerConfig | null,
  incoming: LocalPacServerConfig
): LocalPacServerConfig {
  if (!current) return applyOwnershipRegistryToLocalConfig(incoming);
  return applyOwnershipRegistryToLocalConfig({
    domains: uniqueList([...current.domains, ...incoming.domains]),
    proxy: incoming.proxy || current.proxy,
    matchMode: current.matchMode === 'proxy' || incoming.matchMode === 'proxy' ? 'proxy' : incoming.matchMode,
    fallbackProxy: incoming.fallbackProxy || current.fallbackProxy,
    fallbackPacUrl: incoming.fallbackPacUrl || current.fallbackPacUrl,
    fallbackPacScript: incoming.fallbackPacScript || current.fallbackPacScript,
    dnsServers: uniqueList([...current.dnsServers, ...incoming.dnsServers]),
    dnsFallbackTarget: incoming.dnsFallbackTarget || current.dnsFallbackTarget,
    reverseProxyRoutes: mergeReverseProxyRoutes(current.reverseProxyRoutes, incoming.reverseProxyRoutes),
    ownershipClaims: mergeOwnershipClaims(current.ownershipClaims, incoming.ownershipClaims)
  });
}

function releaseLocalPacConfigOwner(config: LocalPacServerConfig, ownerId: string): LocalPacServerConfig {
  const releasedOwnerId = normalizeOwnerId(ownerId);
  const claims = normalizeOwnershipClaims(config.ownershipClaims);
  const releasedClaims = claims.filter((claim) => normalizeOwnerId(claim.ownerId) === releasedOwnerId);
  const remainingClaims = claims.filter((claim) => normalizeOwnerId(claim.ownerId) !== releasedOwnerId);
  const releasedDomains = new Set(releasedClaims.flatMap(ownershipClaimDomains));
  const remainingDomains = new Set(remainingClaims.flatMap(ownershipClaimDomains));
  const releasedRouteHosts = new Set(releasedClaims.flatMap(ownershipClaimRouteHosts));
  const remainingRouteHosts = new Set(remainingClaims.flatMap(ownershipClaimRouteHosts));
  return applyOwnershipRegistryToLocalConfig({
    ...config,
    domains: config.domains.filter((domain) => !releasedDomains.has(domain) || remainingDomains.has(domain)),
    reverseProxyRoutes: config.reverseProxyRoutes.filter((route) => {
      const host = normalizeDomainName(route.host);
      return !host || !releasedRouteHosts.has(host) || remainingRouteHosts.has(host);
    }),
    ownershipClaims: remainingClaims
  });
}

function applyOwnershipRegistryToLocalConfig(config: LocalPacServerConfig): LocalPacServerConfig {
  const ownershipClaims = normalizeOwnershipClaims(config.ownershipClaims);
  if (!ownershipClaims.length) {
    return {
      ...config,
      ownershipClaims
    };
  }
  const registry = buildElectronLauncherNetworkOwnershipRegistry(ownershipClaims);
  const registryZones = mergedElectronLauncherDnsZones(registry);
  const registryHosts = registry.dnsHosts.map((entry) => entry.key);
  const registryRoutes: ElectronLauncherSystemDomainProxyRoute[] = mergedElectronLauncherReverseProxyRoutes(registry)
    .map((route): ElectronLauncherSystemDomainProxyRoute => ({
      routeId: route.routeId,
      host: route.host,
      dnsTarget: route.dnsTarget,
      targetUrl: route.targetUrl,
      tlsMode: normalizeTlsMode(route.tlsMode),
      authRequired: route.authRequired,
      enabled: route.enabled
    }));
  return {
    ...config,
    domains: uniqueList([...config.domains, ...registryZones, ...registryHosts]),
    reverseProxyRoutes: mergeReverseProxyRoutes(config.reverseProxyRoutes, registryRoutes),
    ownershipClaims
  };
}

function localConfigOwnershipRegistry(config: LocalPacServerConfig): ElectronLauncherNetworkOwnershipRegistry {
  return buildElectronLauncherNetworkOwnershipRegistry(config.ownershipClaims);
}

function pacDirectCidrs(claims: unknown): Array<{ base: string; mask: string }> {
  return uniqueList(normalizeOwnershipClaims(claims)
    .flatMap((claim) => claim.routeCidrs || [])
    .map(normalizeIpv4Cidr)
    .filter(Boolean))
    .map((cidr) => {
      const [base, prefix] = cidr.split('/');
      return {
        base,
        mask: prefixToIpv4Mask(Number(prefix))
      };
    });
}

function normalizeIpv4Cidr(value: unknown): string {
  const text = stringValue(value);
  if (!text) return '';
  const [ip, rawPrefix] = text.split('/');
  const prefix = rawPrefix === undefined ? 32 : Number(rawPrefix);
  if (isIP(ip) !== 4 || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return '';
  return `${ip}/${prefix}`;
}

function prefixToIpv4Mask(prefix: number): string {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return [
    (mask >>> 24) & 255,
    (mask >>> 16) & 255,
    (mask >>> 8) & 255,
    mask & 255
  ].join('.');
}

function requiresManagedRelease(state: StoredState, config: LocalPacServerConfig | null): boolean {
  const ownerId = stateOwnershipOwnerId(state);
  const claims = normalizeOwnershipClaims(config?.ownershipClaims);
  const registeredOwnerIds = arrayValue(state.ownershipRegistry?.owners, [])
    .map((owner) => normalizeOwnerId((owner as { ownerId?: unknown }).ownerId))
    .filter((candidate): candidate is string => Boolean(candidate));
  if (!ownerId) return claims.length > 0 || registeredOwnerIds.length > 0;
  if (state.sharedLocalPac === true) return true;
  return claims.some((claim) => normalizeOwnerId(claim.ownerId) !== ownerId)
    || registeredOwnerIds.some((candidate) => candidate !== ownerId);
}

function stateOwnershipOwnerId(state: StoredState): string | null {
  return normalizeOwnerId(state.ownershipClaim?.ownerId);
}

function ownershipClaimDomains(claim: ElectronLauncherNetworkOwnershipClaim): string[] {
  return uniqueList([
    ...normalizeDomains(claim.dnsZones),
    ...normalizeDomains(claim.dnsHosts),
    ...ownershipClaimRouteHosts(claim)
  ]);
}

function ownershipClaimRouteHosts(claim: ElectronLauncherNetworkOwnershipClaim): string[] {
  return normalizeReverseProxyRoutes(claim.reverseProxyRoutes).map((route) => route.host);
}

function mergeOwnershipClaims(
  current: ElectronLauncherNetworkOwnershipClaim[],
  incoming: ElectronLauncherNetworkOwnershipClaim[]
): ElectronLauncherNetworkOwnershipClaim[] {
  const byOwner = new Map<string, ElectronLauncherNetworkOwnershipClaim>();
  for (const claim of normalizeOwnershipClaims(current)) byOwner.set(claim.ownerId, claim);
  for (const claim of normalizeOwnershipClaims(incoming)) byOwner.set(claim.ownerId, claim);
  return [...byOwner.values()];
}

function localPacConfigKey(config: LocalPacServerConfig, port: number | null): string {
  return JSON.stringify({
    domains: config.domains,
    matchMode: config.matchMode,
    proxy: config.proxy?.directive || null,
    fallbackProxy: config.fallbackProxy?.directive || null,
    fallbackPacUrl: config.fallbackPacUrl,
    fallbackPacScript: config.fallbackPacScript,
    dnsServers: config.dnsServers,
    dnsFallbackTarget: config.dnsFallbackTarget,
    reverseProxyRoutes: config.reverseProxyRoutes,
    ownershipClaims: config.ownershipClaims.map((claim) => claim.ownerId).sort(),
    directCidrs: pacDirectCidrs(config.ownershipClaims),
    pacPort: port || null
  });
}

function mergeReverseProxyRoutes(
  current: ElectronLauncherSystemDomainProxyRoute[],
  incoming: ElectronLauncherSystemDomainProxyRoute[]
): ElectronLauncherSystemDomainProxyRoute[] {
  const byHost = new Map<string, ElectronLauncherSystemDomainProxyRoute>();
  for (const route of current) byHost.set(route.host, route);
  for (const route of incoming) byHost.set(route.host, route);
  return [...byHost.values()];
}

function parseProxyAuthority(value: string, defaultPort: number): { host: string; port: number } | null {
  const text = value.trim();
  if (!text) return null;
  const bracket = text.match(/^\[([^\]]+)](?::(\d+))?$/);
  if (bracket) {
    return normalizeProxyAuthority(bracket[1], bracket[2], defaultPort);
  }
  const parts = text.split(':');
  if (parts.length === 1) return normalizeProxyAuthority(parts[0], null, defaultPort);
  const port = parts.pop();
  return normalizeProxyAuthority(parts.join(':'), port || null, defaultPort);
}

function normalizeProxyAuthority(host: string, port: string | null | undefined, defaultPort: number): { host: string; port: number } | null {
  const cleanHost = stripHostBrackets(host);
  if (!cleanHost) return null;
  const parsedPort = port ? Number(port) : defaultPort;
  if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) return null;
  return { host: cleanHost, port: parsedPort };
}

function destroyProxyClient(socket: Socket, response: string): void {
  if (!socket.destroyed) socket.end(response);
}

function writeTextResponse(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body, 'utf8')),
    Connection: 'close'
  });
  res.end(body);
}

function writeJsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(text, 'utf8')),
    Connection: 'close'
  });
  res.end(text);
}

function readRequestJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > WINDOWS_FALLBACK_PAC_MAX_BYTES + 32_768) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function httpJsonRequest(url: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = body === null ? null : JSON.stringify(normalizeHttpJsonBody(body));
    const req = httpRequest({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method: payload === null ? 'GET' : 'POST',
      headers: payload === null ? undefined : {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(payload, 'utf8'))
      },
      timeout: timeoutMs
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode || 500) >= 400) {
          reject(new Error(text || `HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(text || '{}') as Record<string, unknown>);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`request timeout: ${url}`)));
    req.on('error', reject);
    if (payload !== null) req.end(payload);
    else req.end();
  });
}

function normalizeHttpJsonBody(body: unknown): Record<string, unknown> {
  const row = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const ownerId = normalizeOwnerId(row.ownerId);
  if (ownerId && row.domains === undefined && row.ownershipClaims === undefined && row.proxy === undefined) {
    return { ownerId };
  }
  return {
    domains: normalizeDomains((body as LocalPacServerConfig).domains),
    proxy: (body as LocalPacServerConfig).proxy?.address || null,
    proxyDirective: (body as LocalPacServerConfig).proxy?.directive || null,
    matchMode: (body as LocalPacServerConfig).matchMode,
    fallbackProxy: (body as LocalPacServerConfig).fallbackProxy?.address || null,
    fallbackProxyDirective: (body as LocalPacServerConfig).fallbackProxy?.directive || null,
    fallbackPacUrl: stringValue((body as LocalPacServerConfig).fallbackPacUrl),
    fallbackPacScript: stringValue((body as LocalPacServerConfig).fallbackPacScript),
    dnsServers: normalizeDnsServers((body as LocalPacServerConfig).dnsServers),
    dnsFallbackTarget: normalizeDnsTarget((body as LocalPacServerConfig).dnsFallbackTarget),
    reverseProxyRoutes: normalizeReverseProxyRoutes((body as LocalPacServerConfig).reverseProxyRoutes),
    ownershipClaims: normalizeOwnershipClaims((body as LocalPacServerConfig).ownershipClaims)
  };
}

function resolveDnsA(hostname: string, server: string): Promise<string> {
  return queryDnsPacket(hostname, server, 1).then(({ response, id }) => {
    const address = parseUsableInternalDnsAResponse(response, id);
    if (!address) throw new Error(`DNS returned no private/overlay A record for ${hostname}`);
    return address;
  });
}

function queryDnsPacket(hostname: string, server: string, questionType: number): Promise<{ id: number; response: Buffer }> {
  const query = buildDnsQuery(hostname, questionType);
  const endpoint = parseDnsServerEndpoint(server);
  if (!endpoint) return Promise.reject(new Error(`Invalid DNS server endpoint: ${server}`));
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`DNS timeout for ${hostname} via ${server}`));
    }, DNS_QUERY_TIMEOUT_MS);
    socket.once('message', (message) => {
      clearTimeout(timer);
      socket.close();
      try {
        if (message.length < 12 || message.readUInt16BE(0) !== query.id) {
          throw new Error(`DNS response id mismatch for ${hostname}`);
        }
        const rcode = message.readUInt16BE(2) & 0x000f;
        if (rcode !== 0) throw new Error(`DNS response code ${rcode}`);
        resolve({ id: query.id, response: message });
      } catch (err) {
        reject(err);
      }
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      socket.close();
      reject(err);
    });
    socket.send(query.packet, endpoint.port, endpoint.host);
  });
}

async function forwardDnsPacket(packet: Buffer, servers: string[]): Promise<Buffer> {
  const failures: string[] = [];
  for (const server of servers) {
    try {
      const response = await forwardDnsPacketToServer(packet, server);
      const expectedId = packet.length >= 2 ? packet.readUInt16BE(0) : -1;
      if (!parseUsableInternalDnsAResponse(response, expectedId)) {
        failures.push(`${server}: DNS returned no private/overlay A record`);
        continue;
      }
      return response;
    } catch (err) {
      failures.push(`${server}: ${errorMessage(err)}`);
    }
  }
  throw new Error(failures.length ? failures.join('; ') : 'Internal DNS server is not configured');
}

function forwardDnsPacketToServer(packet: Buffer, server: string): Promise<Buffer> {
  const endpoint = parseDnsServerEndpoint(server);
  if (!endpoint) return Promise.reject(new Error(`Invalid DNS server endpoint: ${server}`));
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`DNS relay timeout via ${server}`));
    }, DNS_QUERY_TIMEOUT_MS);
    socket.once('message', (message) => {
      clearTimeout(timer);
      socket.close();
      resolve(message);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      socket.close();
      reject(err);
    });
    socket.send(packet, endpoint.port, endpoint.host);
  });
}

function dnsFailureResponse(query: Buffer): Buffer {
  if (query.length < 12) return Buffer.alloc(0);
  const response = Buffer.from(query);
  const flags = query.readUInt16BE(2);
  response.writeUInt16BE(0x8082 | (flags & 0x0100), 2);
  response.writeUInt16BE(0, 6);
  response.writeUInt16BE(0, 8);
  response.writeUInt16BE(0, 10);
  return response;
}

function dnsSyntheticIpv4Response(query: Buffer, address: string): Buffer {
  const questionType = dnsQuestionType(query);
  if (questionType === 1 || questionType === 255) return dnsAResponse(query, address);
  return dnsNoDataResponse(query);
}

function dnsNoDataResponse(query: Buffer): Buffer {
  if (query.length < 12) return Buffer.alloc(0);
  const questionEnd = dnsQuestionEndOffset(query);
  if (!questionEnd) return Buffer.alloc(0);
  const response = Buffer.from(query.subarray(0, questionEnd));
  const flags = query.readUInt16BE(2);
  response.writeUInt16BE(0x8080 | (flags & 0x0100), 2);
  response.writeUInt16BE(0, 6);
  response.writeUInt16BE(0, 8);
  response.writeUInt16BE(0, 10);
  return response;
}

function dnsAResponse(query: Buffer, address: string): Buffer {
  if (query.length < 12 || isIP(address) !== 4) return Buffer.alloc(0);
  const questionEnd = dnsQuestionEndOffset(query);
  if (!questionEnd) return Buffer.alloc(0);
  const response = Buffer.alloc(questionEnd + 16);
  query.copy(response, 0, 0, questionEnd);
  const flags = query.readUInt16BE(2);
  response.writeUInt16BE(0x8080 | (flags & 0x0100), 2);
  response.writeUInt16BE(1, 6);
  response.writeUInt16BE(0, 8);
  response.writeUInt16BE(0, 10);
  let offset = questionEnd;
  response.writeUInt16BE(0xc00c, offset);
  offset += 2;
  response.writeUInt16BE(1, offset);
  offset += 2;
  response.writeUInt16BE(1, offset);
  offset += 2;
  response.writeUInt32BE(30, offset);
  offset += 4;
  response.writeUInt16BE(4, offset);
  offset += 2;
  for (const part of address.split('.')) {
    response[offset] = Number(part);
    offset += 1;
  }
  return response;
}

/** @internal Protocol smoke-test seam for the local DNS relay. */
export function buildElectronLauncherDnsRelayFallbackResponse(query: Uint8Array, address: string): Buffer {
  return dnsSyntheticIpv4Response(Buffer.from(query), address);
}

function dnsQuestionEndOffset(packet: Buffer): number | null {
  if (packet.length < 13 || packet.readUInt16BE(4) < 1) return null;
  let offset = 12;
  while (offset < packet.length) {
    const length = packet[offset];
    if (length === 0) return offset + 5 <= packet.length ? offset + 5 : null;
    if ((length & 0xc0) === 0xc0 || offset + 1 + length > packet.length) return null;
    offset += length + 1;
  }
  return null;
}

function dnsQuestionType(packet: Buffer): number | null {
  const questionEnd = dnsQuestionEndOffset(packet);
  return questionEnd ? packet.readUInt16BE(questionEnd - 4) : null;
}

function dnsQuestionHost(packet: Buffer): string | null {
  if (packet.length < 13 || packet.readUInt16BE(4) < 1) return null;
  const labels: string[] = [];
  let offset = 12;
  while (offset < packet.length) {
    const length = packet[offset];
    if (length === 0) return labels.join('.').toLowerCase() || null;
    if ((length & 0xc0) === 0xc0 || offset + 1 + length > packet.length) return null;
    labels.push(packet.subarray(offset + 1, offset + 1 + length).toString('ascii'));
    offset += length + 1;
  }
  return null;
}

function buildDnsQuery(hostname: string, questionType: number): { id: number; packet: Buffer } {
  const id = Math.floor(Math.random() * 0xffff);
  const labels = hostname.split('.').filter(Boolean);
  const question = Buffer.concat([
    ...labels.map((label) => {
      const bytes = Buffer.from(label, 'ascii');
      return Buffer.concat([Buffer.from([bytes.length]), bytes]);
    }),
    Buffer.from([0, (questionType >> 8) & 0xff, questionType & 0xff, 0, 1])
  ]);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  return { id, packet: Buffer.concat([header, question]) };
}

function parseUsableInternalDnsAResponse(packet: Buffer, expectedId: number): string | null {
  const records = parseDnsARecords(packet, expectedId);
  if (!records.length || records.some(isPublicOrProxyFakeIp)) return null;
  return records[0] || null;
}

function parseDnsARecords(packet: Buffer, expectedId: number): string[] {
  if (packet.length < 12 || packet.readUInt16BE(0) !== expectedId) return [];
  const rcode = packet.readUInt16BE(2) & 0x000f;
  if (rcode !== 0) throw new Error(`DNS response code ${rcode}`);
  const questions = packet.readUInt16BE(4);
  const answers = packet.readUInt16BE(6);
  let offset = 12;
  for (let i = 0; i < questions; i += 1) {
    offset = skipDnsName(packet, offset);
    offset += 4;
  }
  const records: string[] = [];
  for (let i = 0; i < answers; i += 1) {
    offset = skipDnsName(packet, offset);
    if (offset + 10 > packet.length) return [];
    const type = packet.readUInt16BE(offset);
    const klass = packet.readUInt16BE(offset + 2);
    const length = packet.readUInt16BE(offset + 8);
    offset += 10;
    if (offset + length > packet.length) return [];
    if (type === 1 && klass === 1 && length === 4) {
      records.push(`${packet[offset]}.${packet[offset + 1]}.${packet[offset + 2]}.${packet[offset + 3]}`);
    }
    offset += length;
  }
  return records;
}

function parseDnsAnswerTypes(packet: Buffer, expectedId: number): number[] {
  if (packet.length < 12 || packet.readUInt16BE(0) !== expectedId) return [];
  const rcode = packet.readUInt16BE(2) & 0x000f;
  if (rcode !== 0) throw new Error(`DNS response code ${rcode}`);
  const questions = packet.readUInt16BE(4);
  const answers = packet.readUInt16BE(6);
  let offset = 12;
  for (let i = 0; i < questions; i += 1) {
    offset = skipDnsName(packet, offset);
    offset += 4;
  }
  const types: number[] = [];
  for (let i = 0; i < answers; i += 1) {
    offset = skipDnsName(packet, offset);
    if (offset + 10 > packet.length) throw new Error('truncated DNS answer');
    const type = packet.readUInt16BE(offset);
    const length = packet.readUInt16BE(offset + 8);
    offset += 10;
    if (offset + length > packet.length) throw new Error('truncated DNS answer data');
    types.push(type);
    offset += length;
  }
  return types;
}

function shouldUseDnsFallbackResponse(query: Buffer, response: Buffer, fallbackTarget: string | null): boolean {
  if (!fallbackTarget || isIP(fallbackTarget) !== 4) return false;
  try {
    return !parseUsableInternalDnsAResponse(response, query.readUInt16BE(0));
  } catch {
    return true;
  }
}

function isPublicOrProxyFakeIp(value: string): boolean {
  if (isIP(value) !== 4) return false;
  return !isOverlayOrPrivateIp(value) || cidrContainsIp('198.18.0.0/15', value);
}

function isOverlayOrPrivateIp(value: string): boolean {
  return [
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '100.64.0.0/10',
    '127.0.0.0/8'
  ].some((cidr) => cidrContainsIp(cidr, value));
}

function cidrContainsIp(cidr: string, ip: string): boolean {
  const parsed = parseIpv4Cidr(cidr);
  const target = ipv4ToInt(ip);
  if (!parsed || target === null) return false;
  const mask = parsed.prefix === 0 ? 0 : (0xffffffff << (32 - parsed.prefix)) >>> 0;
  return (target & mask) === (parsed.base & mask);
}

function parseIpv4Cidr(value: string): { base: number; prefix: number } | null {
  const [ip, prefixText] = value.split('/');
  const base = ipv4ToInt(ip);
  const prefix = Number(prefixText);
  if (base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  return { base, prefix };
}

function ipv4ToInt(value: string | null | undefined): number | null {
  const text = value?.trim();
  if (!text || isIP(text) !== 4) return null;
  const parts = text.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function skipDnsName(packet: Buffer, offset: number): number {
  let cursor = offset;
  while (cursor < packet.length) {
    const length = packet[cursor];
    if ((length & 0xc0) === 0xc0) return cursor + 2;
    if (length === 0) return cursor + 1;
    cursor += length + 1;
  }
  return cursor;
}

function execFileText(
  command: string,
  args: string[],
  options: { timeoutMs?: number } = {}
): Promise<ExecTextResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      windowsHide: true,
      ...(options.timeoutMs ? { timeout: options.timeoutMs } : {})
    }, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(err, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function execFileTimedOut(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const error = value as { code?: unknown; killed?: unknown; signal?: unknown };
  return error.code === 'ETIMEDOUT'
    || error.killed === true
    || error.signal === 'SIGTERM'
    || error.signal === 'SIGKILL';
}

function readState(statePath: string): StoredState | null {
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as StoredState;
    return state && state.version === STATE_VERSION ? state : null;
  } catch {
    return null;
  }
}

function windowsCurrentUserProxyGatePath(): string {
  const userRoot = stringValue(process.env.LOCALAPPDATA)
    || stringValue(process.env.APPDATA)
    || join(homedir(), 'AppData', 'Local');
  return join(userRoot, 'QPJoy', 'MXLauncher', 'network', WINDOWS_CURRENT_USER_GATE_FILE);
}

function acquireWindowsCurrentUserProxyLease(
  gatePath: string,
  statePath: string
): ElectronLauncherProcessLease {
  let lease: ElectronLauncherProcessLease;
  try {
    lease = acquireElectronLauncherProcessLease(gatePath, {
      waitMs: 1_000,
      metadata: {
        kind: 'windows-current-user-proxy',
        statePath
      }
    });
  } catch (err) {
    if (err instanceof ElectronLauncherProcessLeaseBusyError) {
      const holder = err.candidates
        .filter((candidate) => !candidate.choosing)
        .sort((left, right) => left.ticket - right.ticket || left.token.localeCompare(right.token))[0];
      const ownerState = typeof holder?.metadata?.statePath === 'string'
        ? holder.metadata.statePath
        : 'unknown';
      throw new Error(
        `Another Windows Launcher process (pid ${holder?.pid ?? 'unknown'}) owns current-user AutoConfigURL; `
        + `owner state: ${ownerState}.`
      );
    }
    throw err;
  }
  try {
    reconcileLegacyWindowsCurrentUserProxyLease(gatePath);
    return lease;
  } catch (err) {
    releaseElectronLauncherProcessLease(lease);
    throw err;
  }
}

function reconcileLegacyWindowsCurrentUserProxyLease(gatePath: string): void {
  let raw: string;
  try {
    raw = readFileSync(gatePath, 'utf8');
  } catch (err) {
    if (isFileMissingError(err)) return;
    throw err;
  }
  const existing = parseWindowsCurrentUserProxyLease(raw);
  if (!existing) {
    throw new Error(
      `Windows current-user proxy ownership gate ${gatePath} is unreadable; refusing to overwrite AutoConfigURL.`
    );
  }
  if (isProcessAlive(existing.pid)) {
    throw new Error(
      `Another Windows Launcher process (pid ${existing.pid}) owns current-user AutoConfigURL; `
      + `owner state: ${existing.statePath}.`
    );
  }
  rmSync(gatePath);
}

function parseWindowsCurrentUserProxyLease(raw: string): WindowsCurrentUserProxyLease | null {
  try {
    const value = JSON.parse(raw) as Partial<WindowsCurrentUserProxyLease>;
    if (
      value?.version !== 1
      || !Number.isInteger(value.pid)
      || Number(value.pid) <= 0
      || typeof value.token !== 'string'
      || !value.token
      || typeof value.statePath !== 'string'
      || !value.statePath
    ) {
      return null;
    }
    return value as WindowsCurrentUserProxyLease;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(
      err
      && typeof err === 'object'
      && (err as NodeJS.ErrnoException).code === 'EPERM'
    );
  }
}

function isFileMissingError(err: unknown): boolean {
  return Boolean(
    err
    && typeof err === 'object'
    && (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function writeState(statePath: string, state: StoredState): void {
  mkdirSync(dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.${process.pid}.${++stateWriteSequence}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    // Windows FlushFileBuffers, used by fsyncSync, requires a writable handle.
    const fd = openSync(tempPath, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tempPath, statePath);
  } catch (err) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Preserve the original state file if temporary cleanup also fails.
    }
    throw err;
  }
}

function removeState(statePath: string, log: Pick<Console, 'warn'>): void {
  try {
    rmSync(statePath, { force: true });
  } catch (err) {
    log.warn('[electron-launcher] failed to remove system domain proxy state', err);
  }
}

function systemDomainProxyStateChanged(existing: StoredState | null, next: StoredState): boolean {
  return !existing
    || existing.pacUrl !== next.pacUrl
    || existing.fallbackProxy !== next.fallbackProxy
    || existing.fallbackPacUrl !== next.fallbackPacUrl
    || storedSystemResolverMode(existing) !== next.systemResolverMode
    || existing.resolverPort !== next.resolverPort
    || JSON.stringify(normalizeDomains(existing.resolverDomains)) !== JSON.stringify(normalizeDomains(next.resolverDomains));
}

function isLocalPacUrl(value: unknown): boolean {
  const text = stringValue(value);
  if (!text) return false;
  try {
    const url = new URL(text);
    return url.protocol === 'http:'
      && isLoopbackProxyHost(url.hostname)
      && url.pathname === PAC_PATH
      && Boolean(normalizePort(Number(url.port)));
  } catch {
    return false;
  }
}

function darwinLocalEdgeMatchesStoredState(pac: ResolvedPacSource, state: StoredState): boolean {
  if (!pac.usesLocalPac || !state.applied || state.platform !== 'darwin') return false;
  return pac.pacUrl === state.pacUrl
    && pac.pacPort === normalizePort(state.pacPort)
    && (pac.proxy?.address || null) === (state.proxy || null)
    && pac.matchMode === state.matchMode
    && (pac.fallbackProxy?.directive || null) === (state.fallbackProxy || null)
    && (pac.fallbackPacUrl || null) === (state.fallbackPacUrl || null)
    && pac.dnsFallbackTarget === normalizeDnsTarget(state.dnsFallbackTarget)
    && normalizedStringSetEqual(pac.domains, state.domains)
    && normalizedStringSetEqual(pac.dnsServers, state.dnsServers, normalizeDnsServers)
    && canonicalReverseProxyRoutes(pac.reverseProxyRoutes) === canonicalReverseProxyRoutes(state.reverseProxyRoutes)
    && canonicalOwnershipClaim(pac.ownershipClaim) === canonicalOwnershipClaim(state.ownershipClaim)
    && systemResolverPlanMatches(state, systemResolverPlan(pac));
}

function normalizedStringSetEqual(
  left: unknown,
  right: unknown,
  normalize: (value: unknown) => string[] = normalizeDomains
): boolean {
  const a = [...normalize(left)].sort();
  const b = [...normalize(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function canonicalReverseProxyRoutes(value: unknown): string {
  return JSON.stringify(normalizeReverseProxyRoutes(value)
    .map((route) => ({
      routeId: route.routeId || null,
      host: route.host,
      dnsTarget: route.dnsTarget || null,
      targetUrl: route.targetUrl || null,
      tlsMode: route.tlsMode || null,
      authRequired: route.authRequired === true,
      enabled: route.enabled !== false
    }))
    .sort((left, right) => left.host.localeCompare(right.host)));
}

function canonicalOwnershipClaim(value: unknown): string {
  const claim = normalizeOwnershipClaim(value);
  if (!claim) return 'null';
  return JSON.stringify({
    ownerId: claim.ownerId,
    productId: claim.productId || null,
    instanceId: claim.instanceId || null,
    displayName: claim.displayName || null,
    state: claim.state || null,
    priority: claim.priority ?? null,
    leaseIp: claim.leaseIp || null,
    gatewayIp: claim.gatewayIp || null,
    dnsHosts: [...(claim.dnsHosts || [])].sort(),
    dnsZones: [...(claim.dnsZones || [])].sort(),
    routeCidrs: [...(claim.routeCidrs || [])].sort(),
    reverseProxyRoutes: canonicalReverseProxyRoutes(claim.reverseProxyRoutes),
    metadata: claim.metadata || null
  });
}

function publicState(state: StoredState, extra: Partial<ElectronLauncherSystemDomainProxyStatus> = {}): ElectronLauncherSystemDomainProxyStatus {
  return {
    supported: true,
    applied: state.applied === true,
    platform: state.platform,
    pacUrl: state.pacUrl || null,
    proxy: state.proxy || null,
    matchMode: state.matchMode || null,
    fallbackProxy: state.fallbackProxy || null,
    fallbackPacUrl: state.fallbackPacUrl || null,
    pacPort: state.pacPort || null,
    sharedPac: state.sharedLocalPac === true,
    dnsServers: normalizeDnsServers(state.dnsServers),
    dnsFallbackTarget: normalizeDnsTarget(state.dnsFallbackTarget),
    systemResolver: storedSystemResolverMode(state) !== 'off',
    systemResolverMode: storedSystemResolverMode(state),
    resolverDomains: normalizeDomains(state.resolverDomains),
    resolverPort: normalizePort(state.resolverPort),
    resolverApplied: state.resolverApplied === true,
    resolverError: state.resolverError || null,
    domains: normalizeDomains(state.domains),
    reverseProxyRoutes: normalizeReverseProxyRoutes(state.reverseProxyRoutes),
    ownershipRegistry: state.ownershipRegistry || (state.ownershipClaim
      ? buildElectronLauncherNetworkOwnershipRegistry([state.ownershipClaim])
      : null),
    pending: state.pending === true || state.continuationNotifyPending === true,
    transactionToken: state.externalTransactionToken || null,
    externalApplyPhase: currentDarwinExternalApplyPhase(state.externalTransactionPhase),
    updatedAt: state.updatedAt || null,
    ...extra
  };
}

function normalizeDomains(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => typeof item === 'string' ? item.trim().toLowerCase().replace(/^\.+|\.+$/g, '') : '')
    .filter(Boolean))];
}

function uniqueList(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function arrayValue(value: unknown, fallback: unknown[] = []): unknown[] {
  return Array.isArray(value) ? value : fallback;
}

function normalizeOwnershipClaims(value: unknown): ElectronLauncherNetworkOwnershipClaim[] {
  return arrayValue(value, [])
    .map(normalizeOwnershipClaim)
    .filter((claim): claim is ElectronLauncherNetworkOwnershipClaim => Boolean(claim));
}

function normalizeOwnershipClaim(value: unknown): ElectronLauncherNetworkOwnershipClaim | null {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (!row) return null;
  const ownerId = normalizeOwnerId(row.ownerId);
  if (!ownerId) return null;
  return {
    ownerId,
    productId: stringValue(row.productId) || null,
    instanceId: stringValue(row.instanceId) || null,
    displayName: stringValue(row.displayName) || null,
    state: normalizeOwnershipState(row.state),
    priority: normalizeInteger(row.priority),
    leaseIp: normalizeDnsTarget(row.leaseIp),
    gatewayIp: normalizeDnsTarget(row.gatewayIp),
    dnsHosts: normalizeDomains(row.dnsHosts),
    dnsZones: normalizeDomains(row.dnsZones),
    routeCidrs: arrayValue(row.routeCidrs, [])
      .map((item) => stringValue(item))
      .filter((item): item is string => Boolean(item)),
    reverseProxyRoutes: normalizeReverseProxyRoutes(row.reverseProxyRoutes),
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata as Record<string, unknown> : null,
    updatedAt: stringValue(row.updatedAt) || null
  };
}

function normalizeOwnerId(value: unknown): string | null {
  const text = stringValue(value);
  if (!text) return null;
  return text.replace(/[^a-zA-Z0-9_.:-]/g, '-').slice(0, 160) || null;
}

function normalizeOwnershipState(value: unknown): ElectronLauncherNetworkOwnershipClaim['state'] {
  return value === 'connecting' || value === 'active' || value === 'stale' || value === 'released'
    ? value
    : 'active';
}

function normalizeInteger(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function normalizeDnsServers(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(/[,\s]+/) : []);
  return [...new Set(raw
    .map((item) => normalizeDnsServerEndpoint(item))
    .filter((item): item is string => Boolean(item)))];
}

function normalizeDnsServerEndpoint(value: unknown): string | null {
  const parsed = parseDnsServerEndpoint(value);
  if (!parsed) return null;
  if (parsed.port === 53) return parsed.host;
  return parsed.host.includes(':') ? `[${parsed.host}]:${parsed.port}` : `${parsed.host}:${parsed.port}`;
}

function parseDnsServerEndpoint(value: unknown): { host: string; port: number } | null {
  const text = stringValue(value);
  if (!text) return null;
  let host = text;
  let portText: string | null = null;
  if (text.startsWith('[')) {
    const close = text.indexOf(']');
    if (close <= 0) return null;
    host = text.slice(1, close);
    const rest = text.slice(close + 1);
    if (rest.startsWith(':')) portText = rest.slice(1);
  } else {
    const portMatch = text.match(/^(.+):(\d{1,5})$/);
    if (portMatch && !portMatch[1].includes(':')) {
      host = portMatch[1];
      portText = portMatch[2];
    }
  }
  const cleanHost = stripHostBrackets(host.trim().replace(/\.+$/g, ''));
  if (!isDnsServerHost(cleanHost)) return null;
  const port = portText ? Number(portText) : 53;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host: cleanHost, port };
}

function isDnsServerHost(host: string): boolean {
  if (!host) return false;
  if (isIP(host)) return true;
  if (host === 'localhost') return true;
  return /^(?=.{1,253}$)(?!-)[a-z0-9-]+(?:\.(?!-)[a-z0-9-]+)*\.?$/i.test(host);
}

function normalizeReverseProxyRoutes(value: unknown): ElectronLauncherSystemDomainProxyRoute[] {
  const rows = Array.isArray(value) ? value : [];
  const routes: ElectronLauncherSystemDomainProxyRoute[] = [];
  const seen = new Set<string>();
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (row.enabled === false) continue;
    const host = normalizeDomainName(row.host);
    if (!host || seen.has(host)) continue;
    const dnsTarget = normalizeDnsTarget(row.dnsTarget);
    const targetUrl = normalizeTargetUrl(row.targetUrl);
    routes.push({
      routeId: stringValue(row.routeId),
      host,
      dnsTarget,
      targetUrl,
      tlsMode: normalizeTlsMode(row.tlsMode),
      authRequired: row.authRequired === true,
      enabled: true
    });
    seen.add(host);
  }
  return routes;
}

function normalizeDomainName(value: unknown): string | null {
  const text = stringValue(value)?.toLowerCase().replace(/^\.+|\.+$/g, '') || null;
  if (!text || text.length > 253 || text.includes('/') || text.includes(':')) return null;
  return text;
}

function normalizeDnsTarget(value: unknown): string | null {
  const text = stringValue(value);
  if (!text) return null;
  const host = text.startsWith('[')
    ? text.slice(1, text.indexOf(']') > 0 ? text.indexOf(']') : undefined)
    : text.split(':')[0];
  const cleanHost = stripHostBrackets(host || text);
  return isIP(cleanHost) ? cleanHost : null;
}

function normalizeTargetUrl(value: unknown): string | null {
  const text = stringValue(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeTlsMode(value: unknown): ElectronLauncherSystemDomainProxyRoute['tlsMode'] {
  return value === 'passthrough' || value === 'edge-terminated' || value === 'internal' ? value : null;
}

function normalizePort(value: unknown): number | null {
  const port = typeof value === 'number' ? value : Number.NaN;
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function normalizeSystemResolverMode(value: unknown): ElectronLauncherSystemResolverMode {
  if (value === true || value === 'dynamic') return 'dynamic';
  if (value === 'file') return 'file';
  return 'off';
}

function storedSystemResolverMode(state: Pick<StoredState, 'systemResolver' | 'systemResolverMode' | 'resolverDomains' | 'resolverPort'>): ElectronLauncherSystemResolverMode {
  const mode = normalizeSystemResolverMode(state.systemResolverMode);
  if (mode !== 'off') return mode;
  if (state.systemResolver === true) return 'dynamic';
  if (normalizeDomains(state.resolverDomains).length > 0 || normalizePort(state.resolverPort)) return 'file';
  return 'off';
}

function normalizeMatchMode(value: unknown, proxy: unknown): ElectronLauncherPacMatchMode {
  if (value === 'proxy') return 'proxy';
  if (value === 'direct') return 'direct';
  return stringValue(proxy) ? 'proxy' : 'direct';
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeProxyAddress(value: unknown): PacProxy | null {
  const text = stringValue(value);
  if (!text) return null;
  const parsed = parseProxyAddress(text);
  if (!parsed) return null;
  return {
    address: parsed.address,
    directive: `${parsed.kind === 'socks' ? 'SOCKS' : 'PROXY'} ${parsed.address}`
  };
}

function parseProxyAddress(value: string): { kind: 'http' | 'socks'; address: string } | null {
  const text = value.trim();
  const withProtocol = text.match(/^(https?|socks5?|socks):\/\/(.+)$/i);
  const kind = withProtocol && /^socks/i.test(withProtocol[1]) ? 'socks' : 'http';
  const candidate = withProtocol ? withProtocol[2] : text;
  const match = candidate.match(/^(127\.0\.0\.1|localhost):([1-9]\d{0,4})$/i);
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port > 65535) return null;
  return {
    kind,
    address: `${match[1]}:${port}`
  };
}

function hostMatchesDomains(host: string, domains: string[]): boolean {
  const h = host.toLowerCase().replace(/\.+$/g, '');
  return normalizeDomains(domains).some((domain) => h === domain || h.endsWith(`.${domain}`));
}

function headerString(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] || null;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stripHostBrackets(value: string): string {
  return value.replace(/^\[|\]$/g, '').trim();
}

function isLocalhostName(value: string): boolean {
  return /^(127\.0\.0\.1|localhost|\[?::1]?)$/i.test(value);
}

function isAddressInUseError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === 'EADDRINUSE');
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function darwinAuthorizationErrorMessage(err: unknown): string {
  const message = errorMessage(err);
  return /用户已取消|\(-128\)|user canceled|user cancelled/i.test(message)
    ? 'macOS administrator authorization canceled'
    : message;
}
