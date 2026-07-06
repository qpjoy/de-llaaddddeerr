import { execFile } from 'node:child_process';
import { createSocket, type RemoteInfo, type Socket as DgramSocket } from 'node:dgram';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import {
  buildElectronLauncherNetworkOwnershipRegistry,
  mergedElectronLauncherDnsZones,
  mergedElectronLauncherReverseProxyRoutes,
  resolveElectronLauncherDnsOwner,
  type ElectronLauncherNetworkOwnershipClaim,
  type ElectronLauncherNetworkOwnershipRegistry
} from './network-ownership-registry.js';

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
const INTERNAL_GATEWAY_APP_PORTS = new Set([80, 8008]);

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

export interface ElectronLauncherSystemDomainProxyStatus {
  supported: boolean;
  applied: boolean;
  platform: NodeJS.Platform;
  pacUrl?: string | null;
  proxy?: string | null;
  matchMode?: ElectronLauncherPacMatchMode | null;
  fallbackProxy?: string | null;
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
  error?: string;
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
  apply(policy: ElectronLauncherSystemDomainProxyPolicy): Promise<ElectronLauncherSystemDomainProxyStatus>;
  disable(reason?: string): Promise<ElectronLauncherSystemDomainProxyStatus>;
  restoreStale(reason?: string): Promise<ElectronLauncherSystemDomainProxyStatus>;
  darwinPrepareApply?(policy: ElectronLauncherSystemDomainProxyPolicy): Promise<ElectronLauncherSystemDomainProxyStatus>;
  completeExternalApply?(reason?: string): Promise<ElectronLauncherSystemDomainProxyStatus>;
  darwinRestoreScript?(): string | null;
  completeExternalRestore?(reason?: string): Promise<ElectronLauncherSystemDomainProxyStatus>;
  status(): ElectronLauncherSystemDomainProxyStatus;
  statusVerified(): Promise<ElectronLauncherSystemDomainProxyStatus>;
  close(): Promise<void>;
}

type PacProxy = ElectronLauncherPacProxy;

interface ResolvedPacSource {
  pacUrl: string;
  domains: string[];
  proxy: PacProxy | null;
  matchMode: ElectronLauncherPacMatchMode;
  fallbackProxy: PacProxy | null;
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
  updatedAt: string;
}

interface LocalPacServerConfig {
  domains: string[];
  proxy: PacProxy | null;
  matchMode: ElectronLauncherPacMatchMode;
  fallbackProxy: PacProxy | null;
  dnsServers: string[];
  dnsFallbackTarget: string | null;
  reverseProxyRoutes: ElectronLauncherSystemDomainProxyRoute[];
  ownershipClaims: ElectronLauncherNetworkOwnershipClaim[];
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
  pac: ResolvedPacSource;
  resolverPlan: {
    mode: ElectronLauncherSystemResolverMode;
    domains: string[];
    port: number | null;
  };
  next: StoredState;
  changed: boolean;
}

export function createElectronLauncherSystemDomainProxy(
  options: ElectronLauncherSystemDomainProxyOptions
): ElectronLauncherSystemDomainProxyManager {
  const statePath = options.statePath || join(options.userDataDir, DEFAULT_STATE_FILE);
  const log = options.log || console;
  let localPacServer: Server | null = null;
  let localDnsServer: DgramSocket | null = null;
  let localPacPort: number | null = null;
  let localPacKey: string | null = null;
  let localPacConfig: LocalPacServerConfig | null = null;

  function localConfigFromPac(pac: Omit<ResolvedPacSource, 'pacUrl' | 'usesLocalPac' | 'sharedLocalPac'>): LocalPacServerConfig {
    return applyOwnershipRegistryToLocalConfig({
      domains: pac.domains,
      proxy: pac.proxy,
      matchMode: pac.matchMode,
      fallbackProxy: pac.fallbackProxy,
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async function ensureLocalPacServer(pac: Omit<ResolvedPacSource, 'pacUrl' | 'usesLocalPac' | 'sharedLocalPac'>): Promise<{
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
        await new Promise<void>((resolve) => server.close(() => resolve()));
      } catch {
        // The server may have failed before entering the listening state.
      }
      if (preferredPort > 0 && isAddressInUseError(err)) {
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
        dnsServers: localPacConfig?.dnsServers || [],
        dnsFallbackTarget: localPacConfig?.dnsFallbackTarget || null,
        reverseProxyRoutes: localPacConfig?.reverseProxyRoutes || [],
        ownershipClaims: localPacConfig?.ownershipClaims || [],
        ownershipRegistry: localPacConfig ? localConfigOwnershipRegistry(localPacConfig) : null
      });
      return;
    }
    if (controlPath === SHARED_APPLY_PATH && req.method === 'POST') {
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
        dnsServers: localPacConfig.dnsServers,
        dnsFallbackTarget: localPacConfig.dnsFallbackTarget,
        reverseProxyRoutes: localPacConfig.reverseProxyRoutes,
        ownershipClaims: localPacConfig.ownershipClaims,
        ownershipRegistry: localConfigOwnershipRegistry(localPacConfig)
      });
      return;
    }
    if (controlPath === SHARED_RELEASE_PATH && req.method === 'POST') {
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
      const directResponse = dnsAResponse(message, routeTarget);
      if (directResponse.length) {
        socket.send(directResponse, remote.port, remote.address);
        return;
      }
    }
    const ownershipTarget = dnsOwnershipTargetForHost(host, config);
    if (ownershipTarget && isIP(ownershipTarget) === 4) {
      const directResponse = dnsAResponse(message, ownershipTarget);
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
        const fallbackResponse = dnsAResponse(message, config.dnsFallbackTarget || '');
        if (fallbackResponse.length) {
          socket.send(fallbackResponse, remote.port, remote.address);
          return;
        }
      }
      socket.send(response, remote.port, remote.address);
    } catch {
      if (config.dnsFallbackTarget && isIP(config.dnsFallbackTarget) === 4) {
        const fallbackResponse = dnsAResponse(message, config.dnsFallbackTarget);
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

  async function resolvePacSource(policy: ElectronLauncherSystemDomainProxyPolicy, previous: unknown): Promise<ResolvedPacSource | null> {
    if (policy?.enabled !== true) return null;
    const domains = normalizeDomains(policy.domains);
    const pacUrl = stringValue(policy.pacUrl);
    const pacPort = normalizePort(policy.pacPort) || normalizePort(options.pacPort);
    const dnsServers = normalizeDnsServers(policy.dnsServers);
    const dnsFallbackTarget = normalizeDnsTarget(policy.dnsFallbackTarget);
    const systemResolverMode = normalizeSystemResolverMode(policy.systemResolver);
    const reverseProxyRoutes = normalizeReverseProxyRoutes(policy.reverseProxyRoutes);
    const fallbackProxy = normalizeProxyAddress(policy.fallbackProxy) || fallbackProxyForPac(previous);
    const ownershipClaim = normalizeOwnershipClaim(policy.ownershipClaim);
    if (pacUrl) {
      return {
        pacUrl,
        domains,
        proxy: normalizeProxyAddress(policy.proxy),
        matchMode: normalizeMatchMode(policy.matchMode, policy.proxy),
        fallbackProxy,
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
      pacPort,
      sharedLocalPac: false,
      dnsServers,
      dnsFallbackTarget,
      systemResolverMode,
      reverseProxyRoutes,
      ownershipClaim,
      ownershipClaims: normalizeOwnershipClaims(ownershipClaim ? [ownershipClaim] : [])
    };
    const localServer = await ensureLocalPacServer(localPac);
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

  async function prepareApplyState(policy: ElectronLauncherSystemDomainProxyPolicy): Promise<PreparedSystemDomainProxyApply | null> {
    const existing = readState(statePath);
    const previous = existing?.applied === true && existing.platform === process.platform
      ? existing.previous
      : await capturePlatformState();
    const pac = await resolvePacSource(policy, previous);
    if (!pac) return null;

    const resolverPlan = systemResolverPlan(pac);
    const next: StoredState = {
      version: STATE_VERSION,
      applied: true,
      platform: process.platform,
      pacUrl: pac.pacUrl,
      proxy: pac.proxy?.address || null,
      matchMode: pac.matchMode,
      fallbackProxy: pac.fallbackProxy?.directive || null,
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
      updatedAt: new Date().toISOString()
    });
    return {
      existing,
      previous,
      pac,
      resolverPlan,
      next,
      changed
    };
  }

  async function releaseSharedOwnerForState(state: StoredState): Promise<LocalPacServerConfig | null> {
    const ownerId = stateOwnershipOwnerId(state);
    const port = normalizePort(state.pacPort);
    if (state.sharedLocalPac !== true || !ownerId || !port) return null;
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
    const resolver = await applyPlatformPacAndSystemResolvers(pac, state.previous, state, log);
    const next: StoredState = {
      ...state,
      applied: true,
      pacUrl: pac.pacUrl,
      proxy: pac.proxy?.address || null,
      matchMode: pac.matchMode,
      fallbackProxy: pac.fallbackProxy?.directive || null,
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

  return {
    async apply(policy) {
      if (!isSupportedPlatform()) return unsupportedStatus();
      const prepared = await prepareApplyState(policy);
      if (!prepared) {
        await closeLocalPacServer();
        return this.disable('domain-proxy-disabled');
      }
      const { pac, previous, existing, next, changed } = prepared;
      const resolver = await applyPlatformPacAndSystemResolvers(pac, previous, existing, log);
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
    },

    async darwinPrepareApply(policy) {
      if (!isSupportedPlatform()) return unsupportedStatus();
      if (process.platform !== 'darwin') return unsupportedStatus({ platform: process.platform });
      const prepared = await prepareApplyState(policy);
      if (!prepared) {
        await closeLocalPacServer();
        return this.disable('domain-proxy-disabled');
      }
      const shell = await darwinPlatformAndSystemApplyShell(
        prepared.pac.pacUrl,
        prepared.previous,
        prepared.existing,
        prepared.resolverPlan
      );
      if (!shell) {
        return publicState(prepared.next, {
          changed: prepared.changed,
          pending: true,
          externalApply: false,
          darwinApplyShell: null,
          skipped: true,
          reason: 'darwin-apply-shell-unavailable'
        });
      }
      return publicState(prepared.next, {
        changed: prepared.changed,
        pending: true,
        externalApply: true,
        darwinApplyShell: shell
      });
    },

    async completeExternalApply(reason = 'external') {
      const existing = readState(statePath);
      if (!existing?.applied || existing.platform !== process.platform) {
        return {
          supported: true,
          applied: false,
          platform: process.platform,
          reason,
          skipped: true
        };
      }
      const resolver = await verifySystemResolvers(existing).catch((err) => ({
        applied: false,
        platform: process.platform,
        mode: storedSystemResolverMode(existing),
        domains: [],
        error: errorMessage(err)
      }));
      const actual = await verifyPlatformPac(existing.pacUrl, existing.previous).catch((err) => ({
        applied: false,
        platform: process.platform,
        error: errorMessage(err)
      }));
      const next: StoredState = {
        ...existing,
        systemResolver: resolver.mode !== 'off',
        systemResolverMode: resolver.mode,
        resolverDomains: normalizeDomains(existing.resolverDomains),
        resolverPort: normalizePort(existing.resolverPort),
        resolverApplied: resolver.applied,
        resolverError: resolver.error || null,
        pending: false,
        updatedAt: new Date().toISOString()
      };
      delete next.pending;
      writeState(statePath, next);
      return publicState(next, {
        reason,
        verified: true,
        externalApply: true,
        actual: {
          pac: actual,
          resolver
        }
      });
    },

    async disable(reason = 'manual') {
      if (!isSupportedPlatform()) return unsupportedStatus({ reason });
      const existing = readState(statePath);
      if (!existing?.applied || existing.platform !== process.platform) {
        await closeLocalPacServer();
        return {
          supported: true,
          applied: false,
          platform: process.platform,
          reason,
          skipped: true
        };
      }

      const retained = await releaseLocalOwnerAndRetainSharedEdge(existing).catch((err) => {
        log.warn('[electron-launcher] failed to release local PAC owner before restore', err);
        return null;
      });
      if (retained) {
        return publicState(retained, {
          reason,
          changed: true,
          skipped: true
        });
      }
      await releaseSharedOwnerForState(existing).catch((err) => {
        log.warn('[electron-launcher] failed to release shared PAC owner before restore', err);
      });
      await restorePlatformAndSystemState(existing, log);
      await closeLocalPacServer();
      removeState(statePath, log);
      return {
        supported: true,
        applied: false,
        platform: process.platform,
        reason,
        restored: true
      };
    },

    async restoreStale(reason = 'startup') {
      if (!isSupportedPlatform()) return unsupportedStatus({ reason });
      const existing = readState(statePath);
      if (existing?.applied === true && existing.platform === process.platform) {
        await restorePlatformAndSystemState(existing, log);
        await closeLocalPacServer();
        removeState(statePath, log);
        return {
          supported: true,
          applied: false,
          platform: process.platform,
          reason,
          restored: true,
          staleState: true
        };
      }
      const orphanCleanup = await restoreOrphanSystemResolvers(log);
      await closeLocalPacServer();
      return {
        supported: true,
        applied: false,
        platform: process.platform,
        reason,
        skipped: !orphanCleanup,
        restored: orphanCleanup,
        orphanCleanup
      };
    },

    darwinRestoreScript() {
      if (process.platform !== 'darwin') return null;
      const existing = readState(statePath);
      if (existing?.applied === true && existing.platform === process.platform) {
        if (requiresManagedRelease(existing, localPacConfig)) return null;
        return darwinPlatformAndSystemRestoreShell(existing);
      }
      return darwinOrphanSystemResolverRestoreShell();
    },

    async completeExternalRestore(reason = 'external') {
      const existing = readState(statePath);
      if (existing?.applied === true && existing.platform === process.platform) {
        await releaseSharedOwnerForState(existing).catch((err) => {
          log.warn('[electron-launcher] failed to release shared PAC owner after external restore', err);
        });
      }
      await closeLocalPacServer();
      removeState(statePath, log);
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
        return publicState(state, {
          applied: pacVerification.applied && resolverVerification.applied,
          verified: true,
          actual: {
            pac: pacVerification,
            resolver: resolverVerification
          },
          resolverApplied: resolverVerification.applied,
          resolverError: resolverVerification.error || null
        });
      } catch (err) {
        return publicState(state, {
          applied: false,
          verified: false,
          error: errorMessage(err)
        });
      }
    },

    close: closeLocalPacServer
  };
}

export function renderElectronLauncherPacScript(input: {
  domains: string[];
  proxy?: ElectronLauncherPacProxy | null;
  matchMode?: ElectronLauncherPacMatchMode | null;
  fallbackProxy?: ElectronLauncherPacProxy | null;
  ownershipClaims?: ElectronLauncherNetworkOwnershipClaim[] | null;
}): string {
  const matchDirective = input.matchMode === 'proxy' && input.proxy
    ? input.proxy.directive
    : 'DIRECT';
  const fallbackDirective = input.fallbackProxy
    ? `${input.fallbackProxy.directive}; DIRECT`
    : 'DIRECT';
  const directCidrs = pacDirectCidrs(input.ownershipClaims);
  return `// ${PAC_MARKER}
function FindProxyForURL(url, host) {
  var h = String(host || '').toLowerCase();
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

async function applyPlatformPac(pacUrl: string, previous: unknown): Promise<void> {
  if (process.platform === 'darwin') {
    await applyDarwinPac(pacUrl, previous);
    return;
  }
  if (process.platform === 'win32') {
    await applyWindowsPac(pacUrl);
  }
}

async function applyPlatformPacAndSystemResolvers(
  pac: ResolvedPacSource,
  previous: unknown,
  existing: StoredState | null,
  log: Pick<Console, 'warn'>
): Promise<SystemResolverApplyResult> {
  const plan = systemResolverPlan(pac);
  if (process.platform === 'darwin' && plan.mode === 'dynamic' && plan.port && plan.domains.length > 0) {
    return applyDarwinPacAndDynamicResolvers(pac.pacUrl, previous, existing, { ...plan, port: plan.port }, log);
  }
  await applyPlatformPac(pac.pacUrl, previous);
  return applySystemResolversWithPlan(pac, existing, plan, log);
}

async function restorePlatformState(previous: unknown): Promise<void> {
  if (process.platform === 'darwin') {
    await restoreDarwinState(previous);
    return;
  }
  if (process.platform === 'win32') {
    await restoreWindowsState(previous);
  }
}

async function restorePlatformAndSystemState(state: StoredState, log: Pick<Console, 'warn'>): Promise<void> {
  if (process.platform === 'darwin') {
    await restoreDarwinPlatformAndSystemState(state, log);
    return;
  }
  await restorePlatformState(state.previous);
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
  if (process.platform === 'win32') return verifyWindowsPac(pacUrl);
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
  const roots: string[] = [];
  const candidates = normalizeDomains(domains)
    .filter(isDarwinResolverDomain)
    .sort((left, right) => left.length - right.length || left.localeCompare(right));
  for (const domain of candidates) {
    if (roots.some((root) => domain === root || domain.endsWith(`.${root}`))) continue;
    roots.push(domain);
  }
  return roots;
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
  log: Pick<Console, 'warn'>
): Promise<SystemResolverApplyResult> {
  if (existing?.applied && existing.pacUrl === pacUrl && systemResolverPlanMatches(existing, plan)) {
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
    const verification = await verifyDarwinDynamicResolvers(plan.domains, plan.port);
    return {
      mode: plan.mode,
      domains: plan.domains,
      port: plan.port,
      applied: verification.applied,
      error: verification.error || null
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
  let services = darwinServiceNames(previous);
  if (services.length === 0) services = await listDarwinNetworkServices();
  if (services.length === 0) throw new Error('macOS network services not found');
  return [
    'set -e',
    ...darwinStaleResolverFileRemovalCommands(existing, plan),
    ...services.flatMap((name) => [
      ['/usr/sbin/networksetup', '-setautoproxyurl', name, pacUrl].map(shellQuote).join(' '),
      ['/usr/sbin/networksetup', '-setautoproxystate', name, 'on'].map(shellQuote).join(' ')
    ]),
    `/usr/bin/printf %s ${shellQuote(resolverScript)} | /usr/sbin/scutil`
  ].join('\n');
}

async function restoreDarwinPlatformAndSystemState(state: StoredState, log: Pick<Console, 'warn'>): Promise<void> {
  try {
    await runDarwinPrivilegedShell(darwinPlatformAndSystemRestoreShell(state));
  } catch (err) {
    log.warn('[electron-launcher] failed to restore macOS PAC and split DNS in one transaction', err);
    await restoreDarwinState(state.previous).catch((restoreErr) => {
      log.warn('[electron-launcher] failed to restore macOS PAC after combined restore failure', restoreErr);
    });
    await restoreSystemResolvers(state, log);
  }
}

function darwinPlatformAndSystemRestoreShell(state: StoredState): string {
  return [
    'set -e',
    ...darwinAutoProxyRestoreCommands(state.previous),
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

function darwinAutoProxyRestoreCommands(previous: unknown): string[] {
  return previousServices(previous)
    .filter((service) => service.name)
    .flatMap((service) => {
      const name = String(service.name);
      const commands: string[] = [];
      if (service.url) {
        commands.push(['/usr/sbin/networksetup', '-setautoproxyurl', name, String(service.url)].map(shellQuote).join(' ') + ' || true');
      }
      commands.push(['/usr/sbin/networksetup', '-setautoproxystate', name, service.enabled === true ? 'on' : 'off'].map(shellQuote).join(' ') + ' || true');
      return commands;
    });
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
  let services = darwinServiceNames(previous);
  if (services.length === 0) services = await listDarwinNetworkServices();
  if (services.length === 0) throw new Error('macOS network services not found');
  const commands = [];
  for (const name of services) {
    commands.push(['-setautoproxyurl', name, pacUrl]);
    commands.push(['-setautoproxystate', name, 'on']);
  }
  await runDarwinNetworksetupSetBatch(commands);
}

async function verifyDarwinPac(pacUrl: string, previous: unknown): Promise<{ applied: boolean; platform: NodeJS.Platform; pacUrl: string; services: unknown[] }> {
  let services = darwinServiceNames(previous);
  if (services.length === 0) services = await listDarwinNetworkServices();
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
      rows.push({
        name,
        applied: false,
        error: errorMessage(err)
      });
    }
  }
  return {
    applied: rows.length > 0 && rows.every((row) => row.applied === true),
    platform: process.platform,
    pacUrl,
    services: rows
  };
}

async function restoreDarwinState(previous: unknown): Promise<void> {
  const services = previousServices(previous);
  const commands = [];
  for (const service of services) {
    if (!service.name) continue;
    if (service.url) {
      commands.push(['-setautoproxyurl', service.name, service.url]);
    }
    commands.push([
      '-setautoproxystate',
      service.name,
      service.enabled === true ? 'on' : 'off'
    ]);
  }
  await runDarwinNetworksetupSetBatch(commands);
}

async function listDarwinNetworkServices(): Promise<string[]> {
  const result = await execFileText('/usr/sbin/networksetup', ['-listallnetworkservices']);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('An asterisk') && !line.startsWith('*'));
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
      ...commands.map((args) => ['/usr/sbin/networksetup', ...args].map(shellQuote).join(' '))
    ].join('\n');
    await execFileText('/usr/bin/osascript', [
      '-e',
      `do shell script ${JSON.stringify(command)} with administrator privileges`
    ]);
  }
}

async function captureWindowsState(): Promise<Record<string, unknown>> {
  return {
    autoConfigUrl: await queryWindowsRegistryValue('AutoConfigURL'),
    proxyEnable: await queryWindowsRegistryValue('ProxyEnable'),
    proxyServer: await queryWindowsRegistryValue('ProxyServer'),
    proxyOverride: await queryWindowsRegistryValue('ProxyOverride'),
    autoDetect: await queryWindowsRegistryValue('AutoDetect')
  };
}

async function applyWindowsPac(pacUrl: string): Promise<void> {
  await addWindowsRegistryValue('AutoConfigURL', 'REG_SZ', pacUrl);
  await addWindowsRegistryValue('ProxyEnable', 'REG_DWORD', '0');
  await notifyWindowsProxyChanged();
}

async function verifyWindowsPac(pacUrl: string): Promise<{ applied: boolean; platform: NodeJS.Platform; pacUrl: string; autoConfigUrl: unknown }> {
  const autoConfigUrl = await queryWindowsRegistryValue('AutoConfigURL');
  return {
    applied: Boolean(autoConfigUrl.exists && autoConfigUrl.value === pacUrl),
    platform: process.platform,
    pacUrl,
    autoConfigUrl
  };
}

async function restoreWindowsState(previous: unknown): Promise<void> {
  const row = previous && typeof previous === 'object' ? previous as Record<string, RegistryValue> : {};
  await restoreWindowsRegistryValue('AutoConfigURL', row.autoConfigUrl, 'REG_SZ');
  await restoreWindowsRegistryValue('ProxyServer', row.proxyServer, 'REG_SZ');
  await restoreWindowsRegistryValue('ProxyOverride', row.proxyOverride, 'REG_SZ');
  await restoreWindowsRegistryValue('AutoDetect', row.autoDetect, 'REG_DWORD');
  await restoreWindowsRegistryValue('ProxyEnable', row.proxyEnable, 'REG_DWORD');
  await notifyWindowsProxyChanged();
}

interface RegistryValue {
  exists?: boolean;
  name?: string;
  type?: string;
  value?: string;
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
    const result = await execFileText('reg.exe', ['query', WINDOWS_PROXY_KEY, '/v', name]);
    return parseWindowsRegistryValue(result.stdout, name) || { exists: false, name };
  } catch {
    return { exists: false, name };
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

function addWindowsRegistryValue(name: string, type: string, value: string): Promise<ExecTextResult> {
  return execFileText('reg.exe', ['add', WINDOWS_PROXY_KEY, '/v', name, '/t', type, '/d', String(value), '/f']);
}

function deleteWindowsRegistryValue(name: string): Promise<ExecTextResult | undefined> {
  return execFileText('reg.exe', ['delete', WINDOWS_PROXY_KEY, '/v', name, '/f']).catch(() => undefined);
}

function notifyWindowsProxyChanged(): Promise<ExecTextResult | undefined> {
  const script = [
    '$sig = @\'',
    '[DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);',
    '\'@;',
    '$type = Add-Type -MemberDefinition $sig -Name WinInetNotify -Namespace QPJoy -PassThru;',
    '[void]$type::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0);',
    '[void]$type::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0);'
  ].join(' ');
  return execFileText('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script])
    .catch(() => undefined);
}

function fallbackProxyForPac(previous: unknown): PacProxy | null {
  if (process.platform === 'darwin') {
    for (const service of previousServices(previous)) {
      const proxy = service.secureWebProxy || service.webProxy || service.socksProxy;
      if (proxy?.directive) return proxy as PacProxy;
    }
    return null;
  }
  if (process.platform !== 'win32' || !previous || typeof previous !== 'object') return null;
  const row = previous as Record<string, RegistryValue>;
  const enabled = row.proxyEnable;
  const server = row.proxyServer;
  if (!enabled?.exists || String(enabled.value || '').trim() === '0') return null;
  if (!server?.exists || !server.value) return null;
  return normalizeWindowsProxyServer(server.value);
}

function normalizeWindowsProxyServer(value: string): PacProxy | null {
  const text = stringValue(value);
  if (!text) return null;
  if (!text.includes('=')) return normalizeProxyAddress(text);

  const entries: Record<string, string> = {};
  for (const part of text.split(';')) {
    const [rawKey, ...rawValue] = part.split('=');
    const key = String(rawKey || '').trim().toLowerCase();
    const candidate = rawValue.join('=').trim();
    if (!key || !candidate) continue;
    entries[key] = candidate;
  }

  return normalizeProxyAddress(entries.https)
    || normalizeProxyAddress(entries.http)
    || normalizeProxyAddress(entries.socks ? `socks://${entries.socks}` : null)
    || normalizeProxyAddress(Object.values(entries).find(Boolean));
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
  if (!ownerId) return false;
  if (state.sharedLocalPac === true) return true;
  const claims = normalizeOwnershipClaims(config?.ownershipClaims);
  return claims.some((claim) => normalizeOwnerId(claim.ownerId) !== ownerId);
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
      if (size > 32_768) {
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
    dnsServers: normalizeDnsServers((body as LocalPacServerConfig).dnsServers),
    dnsFallbackTarget: normalizeDnsTarget((body as LocalPacServerConfig).dnsFallbackTarget),
    reverseProxyRoutes: normalizeReverseProxyRoutes((body as LocalPacServerConfig).reverseProxyRoutes),
    ownershipClaims: normalizeOwnershipClaims((body as LocalPacServerConfig).ownershipClaims)
  };
}

function resolveDnsA(hostname: string, server: string): Promise<string> {
  const query = buildDnsAQuery(hostname);
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
        const address = parseDnsAResponse(message, query.id);
        if (!address) throw new Error(`DNS A record missing for ${hostname}`);
        resolve(address);
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
      return await forwardDnsPacketToServer(packet, server);
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
  response.writeUInt16BE((flags | 0x8000) & 0xfff0 | 0x0002, 2);
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
  response.writeUInt16BE((flags | 0x8000 | 0x0080) & 0xfff0, 2);
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

function buildDnsAQuery(hostname: string): { id: number; packet: Buffer } {
  const id = Math.floor(Math.random() * 0xffff);
  const labels = hostname.split('.').filter(Boolean);
  const question = Buffer.concat([
    ...labels.map((label) => {
      const bytes = Buffer.from(label, 'ascii');
      return Buffer.concat([Buffer.from([bytes.length]), bytes]);
    }),
    Buffer.from([0, 0, 1, 0, 1])
  ]);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  return { id, packet: Buffer.concat([header, question]) };
}

function parseDnsAResponse(packet: Buffer, expectedId: number): string | null {
  return parseDnsARecords(packet, expectedId)[0] || null;
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

function shouldUseDnsFallbackResponse(query: Buffer, response: Buffer, fallbackTarget: string | null): boolean {
  if (!fallbackTarget || isIP(fallbackTarget) !== 4) return false;
  let records: string[] = [];
  try {
    records = parseDnsARecords(response, query.readUInt16BE(0));
  } catch {
    return true;
  }
  if (records.length === 0) return true;
  if (records.includes(fallbackTarget)) return false;
  return records.every((record) => isPublicOrProxyFakeIp(record));
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

function execFileText(command: string, args: string[]): Promise<ExecTextResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(err, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function readState(statePath: string): StoredState | null {
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as StoredState;
    return state && state.version === STATE_VERSION ? state : null;
  } catch {
    return null;
  }
}

function writeState(statePath: string, state: StoredState): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
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
    || storedSystemResolverMode(existing) !== next.systemResolverMode
    || existing.resolverPort !== next.resolverPort
    || JSON.stringify(normalizeDomains(existing.resolverDomains)) !== JSON.stringify(normalizeDomains(next.resolverDomains));
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
