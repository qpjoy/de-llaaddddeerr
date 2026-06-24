import { execFile } from 'node:child_process';
import { createSocket, type RemoteInfo, type Socket as DgramSocket } from 'node:dgram';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const STATE_VERSION = 1;
const DEFAULT_STATE_FILE = 'electron-launcher-system-domain-proxy.json';
const PAC_PATH = '/proxy.pac';
const SHARED_STATUS_PATH = '/__electron-launcher/domain-proxy/status';
const SHARED_APPLY_PATH = '/__electron-launcher/domain-proxy/apply';
const PAC_MARKER = 'MX_ELECTRON_LAUNCHER_PAC';
const WINDOWS_PROXY_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const DNS_QUERY_TIMEOUT_MS = 1500;
const PROXY_CONNECT_TIMEOUT_MS = 10_000;

export type ElectronLauncherPacMatchMode = 'direct' | 'proxy';

export interface ElectronLauncherSystemDomainProxyPolicy {
  enabled?: boolean;
  domains?: string[] | null;
  pacUrl?: string | null;
  proxy?: string | null;
  matchMode?: ElectronLauncherPacMatchMode | null;
  fallbackProxy?: string | null;
  pacPort?: number | null;
  dnsServers?: string[] | null;
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
  domains?: string[];
  updatedAt?: string | null;
  changed?: boolean;
  verified?: boolean;
  actual?: unknown;
  reason?: string;
  restored?: boolean;
  skipped?: boolean;
  staleState?: boolean;
  error?: string;
}

export interface ElectronLauncherPacProxy {
  address: string;
  directive: string;
}

export interface ElectronLauncherSystemDomainProxyManager {
  apply(policy: ElectronLauncherSystemDomainProxyPolicy): Promise<ElectronLauncherSystemDomainProxyStatus>;
  disable(reason?: string): Promise<ElectronLauncherSystemDomainProxyStatus>;
  restoreStale(reason?: string): Promise<ElectronLauncherSystemDomainProxyStatus>;
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
  domains: string[];
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
}

interface ExecTextResult {
  stdout: string;
  stderr: string;
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
    sharedLocalPac: boolean;
  }> {
    const key = JSON.stringify({
      domains: pac.domains,
      matchMode: pac.matchMode,
      proxy: pac.proxy?.directive || null,
      fallbackProxy: pac.fallbackProxy?.directive || null,
      dnsServers: pac.dnsServers,
      pacPort: pac.pacPort || null
    });
    if (localPacServer && localPacPort && localPacKey === key) {
      return {
        pacUrl: `http://127.0.0.1:${localPacPort}${PAC_PATH}`,
        port: localPacPort,
        sharedLocalPac: false
      };
    }

    const nextConfig: LocalPacServerConfig = {
      domains: pac.domains,
      proxy: pac.proxy,
      matchMode: pac.matchMode,
      fallbackProxy: pac.fallbackProxy,
      dnsServers: pac.dnsServers
    };

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
        return {
          pacUrl: shared.pacUrl,
          port: preferredPort,
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
        dnsServers: localPacConfig?.dnsServers || []
      });
      return;
    }
    if (controlPath === SHARED_APPLY_PATH && req.method === 'POST') {
      const body = await readRequestJson(req);
      localPacConfig = normalizeSharedLocalPacConfig(body);
      localPacKey = JSON.stringify({
        domains: localPacConfig.domains,
        matchMode: localPacConfig.matchMode,
        proxy: localPacConfig.proxy?.directive || null,
        fallbackProxy: localPacConfig.fallbackProxy?.directive || null,
        dnsServers: localPacConfig.dnsServers,
        pacPort: localPacPort || null
      });
      writeJsonResponse(res, 200, {
        marker: PAC_MARKER,
        pacUrl: localPacPort ? `http://127.0.0.1:${localPacPort}${PAC_PATH}` : null,
        shared: false
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
    if (!config?.dnsServers.length || !host || !hostMatchesDomains(host, config.domains)) {
      const failure = dnsFailureResponse(message);
      if (failure.length) socket.send(failure, remote.port, remote.address);
      return;
    }
    try {
      const response = await forwardDnsPacket(message, config.dnsServers);
      socket.send(response, remote.port, remote.address);
    } catch {
      const failure = dnsFailureResponse(message);
      if (failure.length) socket.send(failure, remote.port, remote.address);
    }
  }

  async function handleProxyConnectRequest(req: IncomingMessage, clientSocket: Socket, head: Buffer): Promise<void> {
    const config = localPacConfig;
    try {
      const authority = parseProxyAuthority(req.url || '', 443);
      if (!authority) throw new Error(`unsupported CONNECT target: ${req.url || ''}`);
      const targetHost = await resolveProxyHost(authority.host, config);
      const upstream = netConnect({
        host: targetHost,
        port: authority.port,
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
    const fallbackProxy = normalizeProxyAddress(policy.fallbackProxy) || fallbackProxyForPac(previous);
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
      dnsServers
    };
    const localServer = await ensureLocalPacServer(localPac);
    return {
      ...localPac,
      pacUrl: localServer.pacUrl,
      pacPort: localServer.port,
      sharedLocalPac: localServer.sharedLocalPac,
      usesLocalPac: true
    };
  }

  return {
    async apply(policy) {
      if (!isSupportedPlatform()) return unsupportedStatus();
      const existing = readState(statePath);
      const previous = existing?.applied === true && existing.platform === process.platform
        ? existing.previous
        : await capturePlatformState();
      const pac = await resolvePacSource(policy, previous);
      if (!pac) {
        await closeLocalPacServer();
        return this.disable('domain-proxy-disabled');
      }

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
        domains: pac.domains,
        previous,
        updatedAt: new Date().toISOString()
      };
      writeState(statePath, {
        ...next,
        pending: true,
        updatedAt: new Date().toISOString()
      });
      await applyPlatformPac(pac.pacUrl, previous);
      if (pac.usesLocalPac !== true) await closeLocalPacServer();
      delete next.pending;
      next.updatedAt = new Date().toISOString();
      writeState(statePath, next);
      return publicState(next, { changed: !existing || existing.pacUrl !== pac.pacUrl });
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

      await restorePlatformState(existing.previous);
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
        await restorePlatformState(existing.previous);
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
      await closeLocalPacServer();
      return {
        supported: true,
        applied: false,
        platform: process.platform,
        reason,
        skipped: true
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
        const verification = await verifyPlatformPac(state.pacUrl, state.previous);
        return publicState(state, {
          applied: verification.applied,
          verified: true,
          actual: verification
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
}): string {
  const matchDirective = input.matchMode === 'proxy' && input.proxy
    ? input.proxy.directive
    : 'DIRECT';
  const fallbackDirective = input.fallbackProxy
    ? `${input.fallbackProxy.directive}; DIRECT`
    : 'DIRECT';
  return `// ${PAC_MARKER}
function FindProxyForURL(url, host) {
  var h = String(host || '').toLowerCase();
  var domains = ${JSON.stringify(normalizeDomains(input.domains))};
  for (var i = 0; i < domains.length; i++) {
    var d = domains[i];
    if (h === d || h.slice(-(d.length + 1)) === '.' + d) {
      return ${JSON.stringify(matchDirective)};
    }
  }
  return ${JSON.stringify(fallbackDirective)};
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

async function restorePlatformState(previous: unknown): Promise<void> {
  if (process.platform === 'darwin') {
    await restoreDarwinState(previous);
    return;
  }
  if (process.platform === 'win32') {
    await restoreWindowsState(previous);
  }
}

async function verifyPlatformPac(pacUrl: string, previous: unknown): Promise<{ applied: boolean; platform: NodeJS.Platform; [key: string]: unknown }> {
  if (process.platform === 'darwin') return verifyDarwinPac(pacUrl, previous);
  if (process.platform === 'win32') return verifyWindowsPac(pacUrl);
  return { applied: false, platform: process.platform };
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
    const targetHost = await resolveProxyHost(target.hostname, config);
    const upstream = httpRequest({
      host: targetHost,
      port: target.port || 80,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: proxyForwardHeaders(req, target.host),
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
  if (!config?.dnsServers.length || !hostMatchesDomains(cleanHost, config.domains)) return cleanHost;
  const failures: string[] = [];
  for (const server of config.dnsServers) {
    try {
      return await resolveDnsA(cleanHost, server);
    } catch (err) {
      failures.push(`${server}: ${errorMessage(err)}`);
    }
  }
  throw new Error(`Internal DNS failed for ${cleanHost}: ${failures.join('; ')}`);
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

function proxyForwardHeaders(req: IncomingMessage, hostHeader: string): Record<string, string | string[]> {
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

async function registerSharedLocalPacServer(port: number, config: LocalPacServerConfig): Promise<{ pacUrl: string }> {
  const pacUrl = `http://127.0.0.1:${port}${PAC_PATH}`;
  const status = await sharedLocalPacStatus(port).catch(() => null);
  if (status?.marker !== PAC_MARKER) {
    throw new Error(`127.0.0.1:${port} is already in use and is not an Electron Launcher local edge`);
  }
  const response = await httpJsonRequest(`http://127.0.0.1:${port}${SHARED_APPLY_PATH}`, config, 1800);
  if (response.marker !== PAC_MARKER) {
    throw new Error(`127.0.0.1:${port} did not accept Electron Launcher PAC registration`);
  }
  return { pacUrl };
}

async function sharedLocalPacStatus(port: number): Promise<Record<string, unknown>> {
  return httpJsonRequest(`http://127.0.0.1:${port}${SHARED_STATUS_PATH}`, null, 1200);
}

function normalizeSharedLocalPacConfig(value: unknown): LocalPacServerConfig {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    domains: normalizeDomains(row.domains),
    proxy: normalizeProxyAddress(row.proxyDirective) || normalizeProxyAddress(row.proxy),
    matchMode: normalizeMatchMode(row.matchMode, row.proxy),
    fallbackProxy: normalizeProxyAddress(row.fallbackProxyDirective) || normalizeProxyAddress(row.fallbackProxy),
    dnsServers: normalizeDnsServers(row.dnsServers)
  };
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
    const payload = body === null ? null : JSON.stringify({
      domains: normalizeDomains((body as LocalPacServerConfig).domains),
      proxy: (body as LocalPacServerConfig).proxy?.address || null,
      proxyDirective: (body as LocalPacServerConfig).proxy?.directive || null,
      matchMode: (body as LocalPacServerConfig).matchMode,
      fallbackProxy: (body as LocalPacServerConfig).fallbackProxy?.address || null,
      fallbackProxyDirective: (body as LocalPacServerConfig).fallbackProxy?.directive || null,
      dnsServers: normalizeDnsServers((body as LocalPacServerConfig).dnsServers)
    });
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

function resolveDnsA(hostname: string, server: string): Promise<string> {
  const query = buildDnsAQuery(hostname);
  const serverHost = stripHostBrackets(server.split(':')[0] || server);
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
    socket.send(query.packet, 53, serverHost);
  });
}

function forwardDnsPacket(packet: Buffer, servers: string[]): Promise<Buffer> {
  const server = servers[0];
  if (!server) return Promise.reject(new Error('Internal DNS server is not configured'));
  const serverHost = stripHostBrackets(server.split(':')[0] || server);
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
    socket.send(packet, 53, serverHost);
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
  if (packet.length < 12 || packet.readUInt16BE(0) !== expectedId) return null;
  const rcode = packet.readUInt16BE(2) & 0x000f;
  if (rcode !== 0) throw new Error(`DNS response code ${rcode}`);
  const questions = packet.readUInt16BE(4);
  const answers = packet.readUInt16BE(6);
  let offset = 12;
  for (let i = 0; i < questions; i += 1) {
    offset = skipDnsName(packet, offset);
    offset += 4;
  }
  for (let i = 0; i < answers; i += 1) {
    offset = skipDnsName(packet, offset);
    if (offset + 10 > packet.length) return null;
    const type = packet.readUInt16BE(offset);
    const klass = packet.readUInt16BE(offset + 2);
    const length = packet.readUInt16BE(offset + 8);
    offset += 10;
    if (offset + length > packet.length) return null;
    if (type === 1 && klass === 1 && length === 4) {
      return `${packet[offset]}.${packet[offset + 1]}.${packet[offset + 2]}.${packet[offset + 3]}`;
    }
    offset += length;
  }
  return null;
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
    domains: normalizeDomains(state.domains),
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

function normalizeDnsServers(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(/[,\s]+/) : []);
  return [...new Set(raw
    .map((item) => typeof item === 'string' ? stripHostBrackets(item.trim()) : '')
    .filter((item) => Boolean(item && isIP(item))))];
}

function normalizePort(value: unknown): number | null {
  const port = typeof value === 'number' ? value : Number.NaN;
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
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
