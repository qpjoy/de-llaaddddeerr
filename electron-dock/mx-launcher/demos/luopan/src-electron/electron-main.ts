import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createConnection } from 'node:net';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  applyElectronLauncherStandaloneDataPlane,
  buildElectronLauncherStandaloneOwnershipClaim,
  createElectronLauncher,
  diagnoseElectronLauncherStandaloneDataPlane,
  defineLauncherProduct,
  readElectronLauncherStandaloneOwnershipState,
  routePlanFromSnapshot,
  stopElectronLauncherStandaloneDataPlane,
  upsertElectronLauncherStandaloneOwnershipClaim,
  type ElectronLauncherStandaloneDataPlaneDiagnostics,
  type LauncherNetworkSession,
  type LauncherProductDefinition,
  type StandaloneLauncher
} from '@qpjoy/electron-launcher';

type RuntimeStatus = 'idle' | 'connecting' | 'lease-active' | 'data-plane-pending' | 'network-ready' | 'error';

interface RuntimeConfig {
  baseUrl: string;
  productId: string;
  mode: 'standalone';
  sdkTestMode: boolean;
  deviceLabel: string;
}

interface RuntimeConnection {
  status: RuntimeStatus;
  leaseIp: string | null;
  serviceVip: string | null;
  dnsServer: string | null;
  routeCidrs: string[];
  snapshotDigest: string | null;
  dataPlane: ElectronLauncherStandaloneDataPlaneDiagnostics | null;
  message: string | null;
  updatedAt: string | null;
}

interface RuntimeState {
  installId: string;
  deviceId: string;
  config: RuntimeConfig;
  connection: RuntimeConnection;
  events: string[];
}

const PRODUCT = defineLauncherProduct({
  productId: 'luopan',
  displayName: 'Luopan',
  mode: 'standalone',
  appCenter: {
    visible: true,
    category: 'custom'
  },
  release: {
    componentId: 'luopan',
    channel: 'shadow',
    rolloutGroup: 'sdk-test'
  },
  launcherActions: {
    network: true,
    release: true,
    update: true,
    rollout: true,
    appCenter: false
  }
});

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = 'luopan-runtime.json';
const LUOPAN_DNS_HOST = 'luopan.mxinfo-inc.cn';
const LUOPAN_DNS_ZONE = 'mxinfo-inc.cn';
const FORCE_STANDALONE_WG = booleanish(process.env.LUOPAN_FORCE_STANDALONE_WG, false);

let mainWindow: BrowserWindow | null = null;
let runtime: RuntimeState | null = null;
let activeSession: LauncherNetworkSession | null = null;

app.setAppUserModelId('dev.qpjoy.luopan');

function defaultConfig(): RuntimeConfig {
  return {
    baseUrl: normalizeBaseUrl(process.env.LUOPAN_LAUNCHER_BASE_URL || process.env.MX_LAUNCHER_BASE_URL || 'http://100.89.0.12:18090'),
    productId: 'luopan',
    mode: 'standalone',
    sdkTestMode: booleanish(process.env.LUOPAN_SDK_TEST_MODE, true),
    deviceLabel: process.env.LUOPAN_DEVICE_LABEL?.trim() || 'Luopan Quasar Demo'
  };
}

function emptyConnection(): RuntimeConnection {
  return {
    status: 'idle',
    leaseIp: null,
    serviceVip: null,
    dnsServer: null,
    routeCidrs: [],
    snapshotDigest: null,
    dataPlane: null,
    message: 'Launcher adapter ready.',
    updatedAt: null
  };
}

async function loadRuntime(): Promise<RuntimeState> {
  const fallback: RuntimeState = {
    installId: `luopan-inst-${randomUUID()}`,
    deviceId: `luopan-dev-${randomUUID()}`,
    config: defaultConfig(),
    connection: emptyConnection(),
    events: []
  };
  const file = runtimeStateFile();
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<RuntimeState>;
    return {
      installId: stringValue(parsed.installId) || fallback.installId,
      deviceId: stringValue(parsed.deviceId) || fallback.deviceId,
      config: normalizeConfig(parsed.config, fallback.config),
      connection: normalizeConnection(parsed.connection),
      events: Array.isArray(parsed.events) ? parsed.events.filter((item): item is string => typeof item === 'string').slice(-12) : []
    };
  } catch {
    return fallback;
  }
}

async function saveRuntime(): Promise<void> {
  if (!runtime) return;
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(runtimeStateFile(), JSON.stringify(runtime, null, 2));
}

function runtimeStateFile(): string {
  return path.join(app.getPath('userData'), STATE_FILE);
}

function visibleRuntime() {
  const state = requireRuntime();
  return {
    appId: PRODUCT.productId,
    displayName: PRODUCT.displayName,
    packageName: '@qpjoy/electron-launcher',
    launcherMode: PRODUCT.mode,
    installId: state.installId,
    deviceId: state.deviceId,
    config: state.config,
    connection: state.connection,
    events: state.events
  };
}

function requireRuntime(): RuntimeState {
  if (!runtime) throw new Error('Luopan runtime is not ready');
  return runtime;
}

function launcherClient(): StandaloneLauncher {
  const state = requireRuntime();
  const launcher = createElectronLauncher({
    baseUrl: state.config.baseUrl,
    productId: state.config.productId,
    mode: 'standalone',
    installId: state.installId,
    deviceId: state.deviceId,
    deviceLabel: state.config.deviceLabel
  });
  if (launcher.mode !== 'standalone') {
    throw new Error('Luopan demo requires standalone launcher mode');
  }
  return launcher;
}

function pushEvent(message: string): void {
  const state = requireRuntime();
  const stamp = new Date().toISOString().slice(11, 19);
  state.events = [`${stamp} ${message}`, ...state.events].slice(0, 12);
}

async function setConnection(connection: Partial<RuntimeConnection>): Promise<void> {
  const state = requireRuntime();
  state.connection = {
    ...state.connection,
    ...connection,
    updatedAt: new Date().toISOString()
  };
  await saveRuntime();
  broadcastRuntime();
}

function broadcastRuntime(): void {
  mainWindow?.webContents.send('luopan:runtime', visibleRuntime());
}

function resolvePreloadPath(): string {
  const override = process.env.QUASAR_ELECTRON_PRELOAD;
  const candidates = [
    override ? path.resolve(currentDir, override) : '',
    path.resolve(currentDir, 'preload/electron-preload.cjs'),
    path.resolve(currentDir, 'electron-preload.cjs'),
    path.resolve(currentDir, 'electron-preload.js')
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

async function createWindow(): Promise<void> {
  nativeTheme.themeSource = 'dark';
  const window = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 1040,
    minHeight: 700,
    show: false,
    title: 'Luopan',
    backgroundColor: '#171b28',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: resolvePreloadPath()
    }
  });
  mainWindow = window;

  window.once('ready-to-show', () => {
    mainWindow?.show();
    broadcastRuntime();
  });
  window.on('closed', () => {
    mainWindow = null;
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.DEV) {
    await loadDevRenderer(window);
  } else {
    await window.loadFile('index.html');
  }
}

async function loadDevRenderer(window: BrowserWindow): Promise<void> {
  const candidates = devRendererUrlCandidates();
  const attempts: string[] = [];
  const deadline = Date.now() + 15000;
  for (const url of candidates) {
    try {
      await waitForDevServer(url, Math.max(1000, deadline - Date.now()));
      await window.loadURL(url);
      return;
    } catch (error) {
      attempts.push(`${url}: ${errorMessage(error)}`);
    }
  }
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(devRendererErrorHtml(attempts))}`);
  if (!window.isVisible()) window.show();
}

function devRendererUrlCandidates(): string[] {
  return uniqueStrings([
    normalizeDevRendererUrl(process.env.APP_URL),
    'http://127.0.0.1:9031',
    'http://localhost:9031'
  ].filter((url): url is string => Boolean(url)));
}

function normalizeDevRendererUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

async function waitForDevServer(rawUrl: string, timeoutMs: number): Promise<void> {
  const url = new URL(rawUrl);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const host = url.hostname;
  const startedAt = Date.now();
  let lastError = 'not-ready';
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await tcpProbe(host, port);
      return;
    } catch (error) {
      lastError = errorMessage(error);
      await sleep(250);
    }
  }
  throw new Error(`dev server not reachable on ${host}:${port} (${lastError})`);
}

function tcpProbe(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const finish = (error?: Error) => {
      socket.removeAllListeners();
      socket.destroy();
      error ? reject(error) : resolve();
    };
    socket.setTimeout(1000, () => finish(new Error('tcp-timeout')));
    socket.once('connect', () => finish());
    socket.once('error', finish);
  });
}

function devRendererErrorHtml(attempts: string[]): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Luopan renderer unavailable</title>
    <style>
      body { margin: 0; min-height: 100vh; background: #171b28; color: #f4f7fb; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: grid; place-items: center; }
      main { width: min(760px, calc(100vw - 64px)); border: 1px solid #33415f; border-radius: 8px; padding: 28px; background: #1d2333; }
      h1 { margin: 0 0 12px; font-size: 28px; }
      p, li { color: #b7bfce; line-height: 1.55; }
      code { color: #34f5d2; }
      pre { white-space: pre-wrap; color: #fda4af; background: #111624; border-radius: 6px; padding: 14px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Luopan renderer is not ready</h1>
      <p>Electron could not load the Quasar dev server. Keep <code>pnpm dev</code> running and check that port <code>9031</code> is not blocked or occupied.</p>
      <pre>${escapeHtml(attempts.join('\n') || 'No renderer URL was attempted.')}</pre>
    </main>
  </body>
</html>`;
}

function registerIpc(): void {
  ipcMain.handle('luopan:get-runtime', () => visibleRuntime());
  ipcMain.handle('luopan:save-config', async (_event, input) => {
    const state = requireRuntime();
    state.config = normalizeConfig(input, state.config);
    pushEvent('runtime config saved');
    await saveRuntime();
    broadcastRuntime();
    return visibleRuntime();
  });
  ipcMain.handle('luopan:connect-test-mode', async () => {
    const state = requireRuntime();
    await setConnection({
      status: 'connecting',
      message: state.config.sdkTestMode
        ? 'Requesting Launcher Network lease in SDK test mode.'
        : 'Requesting registered Luopan Launcher Network lease.'
    });
    pushEvent('lease request started');
    try {
      const session = await launcherClient().connectNetwork({
        identityKind: 'anonymous',
        platform: 'quasar-electron',
        sdkTestMode: state.config.sdkTestMode,
        requestedBy: 'luopan-quasar-demo',
        requestId: `luopan-${Date.now()}`
      });
      activeSession = session;
      await applySession(session);
      pushEvent(`lease active ${session.lease.leaseIp}`);
    } catch (error) {
      await setConnection({
        status: 'error',
        message: errorMessage(error)
      });
      pushEvent(`lease failed ${errorMessage(error)}`);
    }
    await saveRuntime();
    broadcastRuntime();
    return visibleRuntime();
  });
  ipcMain.handle('luopan:apply-data-plane', async () => {
    await setConnection({
      status: 'connecting',
      message: FORCE_STANDALONE_WG
        ? 'Syncing Domestic peer and applying isolated Luopan WireGuard data plane.'
        : 'Checking existing MX-H2I/foundation data plane for Luopan reuse.'
    });
    pushEvent('data-plane apply started');
    try {
      if (!activeSession) throw new Error('Request a Luopan lease before applying the local data plane.');
      const privateKey = stringValue(activeSession.wireGuard.privateKey);
      if (!privateKey) throw new Error('Luopan WireGuard private key is missing; request a fresh lease.');
      if (!FORCE_STANDALONE_WG) {
        const attached = attachToFoundationDataPlane(activeSession);
        if (attached) {
          await setConnection({
            status: runtimeStatusForDataPlane(attached.dataPlane),
            dataPlane: attached.dataPlane,
            message: attached.message
          });
          pushEvent(`data-plane attached ${attached.reason}`);
          return visibleRuntime();
        }
        const dataPlane = diagnoseFoundationDataPlane(activeSession);
        await setConnection({
          status: runtimeStatusForDataPlane(dataPlane),
          dataPlane,
          message: dataPlane.message
        });
        pushEvent(`data-plane pending ${dataPlane.state}`);
        return visibleRuntime();
      }
      await syncLeasePeers(activeSession);
      const result = await applyElectronLauncherStandaloneDataPlane({
        userDataDir: app.getPath('userData'),
        profileName: 'luopan.conf',
        routePlan: activeSession.routePlan,
        privateKey,
        dnsDomains: [LUOPAN_DNS_ZONE],
        ownerId: `${PRODUCT.productId}:${requireRuntime().installId}`,
        productId: PRODUCT.productId,
        instanceId: requireRuntime().installId,
        displayName: PRODUCT.displayName,
        dnsHosts: [LUOPAN_DNS_HOST],
        failOnOwnershipConflicts: true,
        allowSystemFallback: false,
        darwinLaunchDaemon: true,
        fallbackToAppManaged: false,
        darwinServiceIdentity: luopanWireGuardServiceIdentity()
      });
      const dataPlane = withServiceVipReachability(result.diagnostics, activeSession, 'standalone-wireguard');
      await setConnection({
        status: runtimeStatusForDataPlane(dataPlane),
        dataPlane,
        message: dataPlane.ok ? result.message : dataPlane.message
      });
      pushEvent(result.ok && dataPlane.ok ? 'data-plane ready' : `data-plane pending ${dataPlane.state}`);
    } catch (error) {
      await setConnection({
        status: 'error',
        message: errorMessage(error)
      });
      pushEvent(`data-plane failed ${errorMessage(error)}`);
    }
    return visibleRuntime();
  });
  ipcMain.handle('luopan:disconnect-data-plane', async () => {
    pushEvent('data-plane disconnect started');
    try {
      const result = await stopElectronLauncherStandaloneDataPlane({
        userDataDir: app.getPath('userData'),
        profileName: 'luopan.conf',
        ownerId: `${PRODUCT.productId}:${requireRuntime().installId}`,
        darwinLaunchDaemon: true,
        allowSystemFallback: false,
        darwinServiceIdentity: luopanWireGuardServiceIdentity()
      });
      const nextDataPlane = activeSession
        ? diagnoseElectronLauncherStandaloneDataPlane({
            routePlan: activeSession.routePlan,
            leaseIp: activeSession.lease.leaseIp,
            serviceVip: activeSession.lease.serviceVip,
            dnsServer: activeSession.routePlan.dnsServer
          })
        : null;
      await setConnection({
        status: nextDataPlane ? runtimeStatusForDataPlane(nextDataPlane) : 'idle',
        dataPlane: nextDataPlane,
        message: result.message
      });
      pushEvent(result.ok ? 'data-plane stopped' : `data-plane stop failed ${result.message}`);
    } catch (error) {
      await setConnection({
        status: 'error',
        message: errorMessage(error)
      });
      pushEvent(`data-plane stop failed ${errorMessage(error)}`);
    }
    return visibleRuntime();
  });
  ipcMain.handle('luopan:refresh-snapshot', async () => {
    try {
      const state = requireRuntime();
      const snapshot = await launcherClient().createSnapshot({
        requestId: `luopan-snapshot-${Date.now()}`
      });
      const routePlan = routePlanFromSnapshot(snapshot);
      const dataPlane = diagnoseElectronLauncherStandaloneDataPlane({
        routePlan,
        leaseIp: state.connection.leaseIp || routePlan.leaseIp,
        serviceVip: snapshot.topology.product.serviceVip,
        dnsServer: snapshot.topology.relayPlan.routes.dnsServer
      });
      await setConnection({
        status: runtimeStatusForDataPlane(dataPlane),
        leaseIp: state.connection.leaseIp || routePlan.leaseIp,
        serviceVip: snapshot.topology.product.serviceVip,
        dnsServer: snapshot.topology.relayPlan.routes.dnsServer,
        routeCidrs: snapshot.topology.relayPlan.routes.internalCidrs,
        snapshotDigest: snapshot.signatures.digest,
        dataPlane,
        message: `Snapshot refreshed. ${dataPlane.message}`
      });
      pushEvent('snapshot refreshed');
    } catch (error) {
      await setConnection({
        status: 'error',
        message: errorMessage(error)
      });
      pushEvent(`snapshot failed ${errorMessage(error)}`);
    }
    return visibleRuntime();
  });
  ipcMain.handle('luopan:reset-session', async () => {
    const state = requireRuntime();
    state.connection = emptyConnection();
    pushEvent('local runtime session reset');
    await saveRuntime();
    broadcastRuntime();
    return visibleRuntime();
  });
  ipcMain.handle('luopan:open-admin', async () => {
    await shell.openExternal(`${requireRuntime().config.baseUrl}/admin/`);
  });
  ipcMain.handle('luopan:open-internal-entry', async () => {
    await shell.openExternal('http://luopan.mxinfo-inc.cn/');
  });
}

async function applySession(session: LauncherNetworkSession): Promise<void> {
  const dataPlane = diagnoseElectronLauncherStandaloneDataPlane({
    routePlan: session.routePlan,
    leaseIp: session.lease.leaseIp,
    serviceVip: session.lease.serviceVip,
    dnsServer: session.routePlan.dnsServer
  });
  await setConnection({
    status: runtimeStatusForDataPlane(dataPlane),
    leaseIp: session.lease.leaseIp,
    serviceVip: session.lease.serviceVip,
    dnsServer: session.routePlan.dnsServer,
    routeCidrs: session.routePlan.routeCidrs,
    snapshotDigest: session.snapshot.signatures.digest,
    dataPlane,
    message: session.lease.productId === PRODUCT.productId
      ? dataPlane.message
      : `Lease is active on ${session.lease.productId}. ${dataPlane.message}`
  });
}

function diagnoseFoundationDataPlane(session: LauncherNetworkSession): ElectronLauncherStandaloneDataPlaneDiagnostics {
  const routeProof = foundationRouteProof(session);
  if (!foundationRoutesReady(routeProof)) {
    return {
      ...routeProof,
      ok: false,
      state: routeProof.state === 'proxy-tun-captured' ? routeProof.state : 'data-plane-pending',
      severity: routeProof.severity === 'error' ? routeProof.severity : 'warning',
      message: `Foundation data plane is not ready for Luopan reuse. ${routeProof.message} Standalone WireGuard is disabled by default; set LUOPAN_FORCE_STANDALONE_WG=1 only for isolated tunnel testing.`
    };
  }
  const gatewayReachability = probeIcmpReachability(session.routePlan.domesticGatewayIp);
  if (!gatewayReachability.ok) {
    return {
      ...routeProof,
      ok: false,
      state: 'data-plane-pending',
      severity: 'warning',
      message: `Foundation routes are present, but Domestic gateway ${session.routePlan.domesticGatewayIp} is not reachable (${gatewayReachability.message}). Keep MX-H2I/foundation connected before Luopan reuses the shared data plane.`
    };
  }
  return withServiceVipReachability(routeProof, session, 'foundation-reuse');
}

function attachToFoundationDataPlane(session: LauncherNetworkSession): {
  dataPlane: ElectronLauncherStandaloneDataPlaneDiagnostics;
  message: string;
  reason: string;
} | null {
  const routeProof = foundationRouteProof(session);
  if (!foundationRoutesReady(routeProof)) return null;
  const gatewayReachability = probeIcmpReachability(session.routePlan.domesticGatewayIp);
  if (!gatewayReachability.ok) return null;

  const state = readElectronLauncherStandaloneOwnershipState();
  const foundationOwner = state.claims.find(isFoundationOwner) ?? null;
  const dataPlane = withServiceVipReachability(routeProof, session, 'foundation-reuse');
  const claim = {
    ...buildElectronLauncherStandaloneOwnershipClaim(session.routePlan, {
      ownerId: `${PRODUCT.productId}:${requireRuntime().installId}`,
      productId: PRODUCT.productId,
      instanceId: requireRuntime().installId,
      displayName: PRODUCT.displayName,
      dnsHosts: [LUOPAN_DNS_HOST],
      routeCidrs: session.routePlan.leaseCidr ? [session.routePlan.leaseCidr] : [],
      priority: 90
    }),
    state: dataPlane.ok ? 'active' as const : 'connecting' as const,
    metadata: {
      dataPlaneMode: 'foundation-reuse',
      foundationOwnerId: foundationOwner?.ownerId ?? null,
      serviceVip: session.routePlan.serviceVip,
      dnsServer: session.routePlan.dnsServer
    }
  };
  upsertElectronLauncherStandaloneOwnershipClaim(claim);
  const reason = foundationOwner?.ownerId ? `owner:${foundationOwner.ownerId}` : 'route-proof';
  return {
    dataPlane,
    reason,
    message: `Attached to existing foundation data plane (${reason}). ${dataPlane.message}`
  };
}

function foundationRouteProof(session: LauncherNetworkSession): ElectronLauncherStandaloneDataPlaneDiagnostics {
  return diagnoseElectronLauncherStandaloneDataPlane({
    routePlan: session.routePlan,
    leaseIp: session.lease.leaseIp,
    serviceVip: session.lease.serviceVip,
    dnsServer: session.routePlan.dnsServer,
    wireGuardActive: true
  });
}

function foundationRoutesReady(dataPlane: ElectronLauncherStandaloneDataPlaneDiagnostics): boolean {
  const targets = new Set(['internal-control', 'domestic-gateway', 'dns-server']);
  const probes = dataPlane.probes.filter((probe) => targets.has(probe.target));
  return probes.length > 0 && probes.every((probe) => probe.ok && !probe.viaProxyTun);
}

function isFoundationOwner(claim: { ownerId?: string | null; productId?: string | null; state?: string | null; dnsZones?: string[] | null; routeCidrs?: string[] | null }): boolean {
  if (!claim.ownerId || claim.state === 'released') return false;
  if (claim.productId === 'mx-h2i') return true;
  if ((claim.dnsZones ?? []).includes(LUOPAN_DNS_ZONE)) return true;
  return (claim.routeCidrs ?? []).some((cidr) => cidr === '10.88.0.0/16' || cidr === '10.89.0.0/16');
}

function withServiceVipReachability(
  dataPlane: ElectronLauncherStandaloneDataPlaneDiagnostics,
  session: LauncherNetworkSession,
  mode: 'foundation-reuse' | 'standalone-wireguard'
): ElectronLauncherStandaloneDataPlaneDiagnostics {
  const serviceVip = stringValue(session.lease.serviceVip) || stringValue(session.routePlan.serviceVip);
  const serviceRoute = dataPlane.probes.find((probe) => probe.target === 'service-vip');
  if (!serviceVip || serviceRoute?.ok !== true) return dataPlane;
  const reachable = probeIcmpReachability(serviceVip);
  if (reachable.ok) return dataPlane;
  const prefix = mode === 'foundation-reuse'
    ? 'Foundation routes are present'
    : 'Standalone WireGuard routes are present';
  return {
    ...dataPlane,
    ok: false,
    state: 'service-unreachable',
    severity: 'error',
    message: `${prefix}, but Luopan service VIP ${serviceVip} is not reachable (${reachable.message}). Verify the Internal service peer, Domestic relay, and Luopan upstream before treating this channel as network-ready.`
  };
}

function probeIcmpReachability(host: string): { ok: boolean; message: string } {
  const args = process.platform === 'win32'
    ? ['-n', '1', '-w', '1000', host]
    : process.platform === 'darwin'
      ? ['-c', '1', '-W', '1000', host]
      : ['-c', '1', '-W', '1', host];
  try {
    execFileSync('ping', args, { stdio: 'pipe', timeout: 2500 });
    return { ok: true, message: 'icmp-ok' };
  } catch (error) {
    return { ok: false, message: errorMessage(error) || 'icmp-timeout' };
  }
}

async function syncLeasePeers(session: LauncherNetworkSession): Promise<void> {
  const leaseId = stringValue(session.lease.leaseId);
  if (!leaseId) throw new Error('Launcher leaseId is missing; cannot sync Domestic peer.');
  await postLauncherNetwork(`/leases/${encodeURIComponent(leaseId)}/domestic-peer/sync`, {
    requestedBy: 'luopan-quasar-demo',
    requestId: `luopan-domestic-peer-${Date.now()}`
  });
  try {
    await postLauncherNetwork(`/leases/${encodeURIComponent(leaseId)}/internal-direct-peer/sync`, {
      requestedBy: 'luopan-quasar-demo',
      requestId: `luopan-internal-direct-peer-${Date.now()}`
    });
  } catch (error) {
    pushEvent(`internal direct sync skipped ${errorMessage(error)}`);
  }
}

async function postLauncherNetwork(pathname: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${requireRuntime().config.baseUrl}/internal/v1/launcher-network${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  const payload = text ? safeJson(text) : null;
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'message' in payload
      ? String((payload as { message?: unknown }).message)
      : text || response.statusText;
    throw new Error(`Launcher peer sync failed: ${response.status} ${message}`);
  }
  return payload;
}

function luopanWireGuardServiceIdentity() {
  return {
    displayName: 'Luopan WireGuard',
    darwinLaunchDaemonLabelPrefix: 'com.qpjoy.luopan.wireguard',
    darwinSupportRoot: '/Library/Application Support/QPJoy/Luopan',
    darwinLogDir: '/Library/Logs/QPJoy-Luopan',
    darwinDaemonScriptName: 'luopan-wireguard-daemon.sh',
    staleDarwinLaunchDaemonLabelPrefixes: ['com.qpjoy.luopan.wireguard']
  };
}

function normalizeConfig(input: unknown, fallback: RuntimeConfig = defaultConfig()): RuntimeConfig {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  return {
    baseUrl: normalizeBaseUrl(stringValue(record.baseUrl) || fallback.baseUrl),
    productId: 'luopan',
    mode: 'standalone',
    sdkTestMode: typeof record.sdkTestMode === 'boolean' ? record.sdkTestMode : fallback.sdkTestMode,
    deviceLabel: stringValue(record.deviceLabel) || fallback.deviceLabel
  };
}

function normalizeConnection(input: unknown): RuntimeConnection {
  const fallback = emptyConnection();
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const leaseIp = stringValue(record.leaseIp);
  const dataPlane = normalizeDataPlane(record.dataPlane);
  const status = normalizeRuntimeStatus(record.status, leaseIp, dataPlane);
  return {
    status,
    leaseIp,
    serviceVip: stringValue(record.serviceVip),
    dnsServer: stringValue(record.dnsServer),
    routeCidrs: Array.isArray(record.routeCidrs) ? record.routeCidrs.filter((item): item is string => typeof item === 'string') : [],
    snapshotDigest: stringValue(record.snapshotDigest),
    dataPlane,
    message: stringValue(record.message) || fallback.message,
    updatedAt: stringValue(record.updatedAt)
  };
}

function runtimeStatusForDataPlane(dataPlane: ElectronLauncherStandaloneDataPlaneDiagnostics): RuntimeStatus {
  if (dataPlane.ok) return 'network-ready';
  if (dataPlane.state === 'lease-missing') return 'idle';
  if (dataPlane.state === 'lease-active') return 'lease-active';
  return 'data-plane-pending';
}

function isRuntimeStatus(value: unknown): value is RuntimeStatus {
  return value === 'idle'
    || value === 'connecting'
    || value === 'lease-active'
    || value === 'data-plane-pending'
    || value === 'network-ready'
    || value === 'error';
}

function normalizeRuntimeStatus(
  value: unknown,
  leaseIp: string | null,
  dataPlane: ElectronLauncherStandaloneDataPlaneDiagnostics | null
): RuntimeStatus {
  if (value === 'connected') return dataPlane?.ok ? 'network-ready' : leaseIp ? 'data-plane-pending' : 'idle';
  return isRuntimeStatus(value) ? value : 'idle';
}

function normalizeDataPlane(value: unknown): ElectronLauncherStandaloneDataPlaneDiagnostics | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<ElectronLauncherStandaloneDataPlaneDiagnostics>;
  if (typeof record.state !== 'string' || typeof record.message !== 'string') return null;
  return record as ElectronLauncherStandaloneDataPlaneDiagnostics;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return 'http://100.89.0.12:18090';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function booleanish(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

app.whenReady().then(async () => {
  runtime = await loadRuntime();
  registerIpc();
  await createWindow();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
