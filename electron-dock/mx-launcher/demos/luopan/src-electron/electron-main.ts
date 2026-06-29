import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  applyElectronLauncherStandaloneDataPlane,
  createElectronLauncher,
  diagnoseElectronLauncherStandaloneDataPlane,
  defineLauncherProduct,
  routePlanFromSnapshot,
  stopElectronLauncherStandaloneDataPlane,
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
  mainWindow = new BrowserWindow({
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

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    broadcastRuntime();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.DEV) {
    await mainWindow.loadURL(process.env.APP_URL || 'http://127.0.0.1:9031');
  } else {
    await mainWindow.loadFile('index.html');
  }
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
      message: 'Syncing Domestic peer and applying local WireGuard data plane.'
    });
    pushEvent('data-plane apply started');
    try {
      if (!activeSession) throw new Error('Request a Luopan lease before applying the local data plane.');
      const privateKey = stringValue(activeSession.wireGuard.privateKey);
      if (!privateKey) throw new Error('Luopan WireGuard private key is missing; request a fresh lease.');
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
      await setConnection({
        status: runtimeStatusForDataPlane(result.diagnostics),
        dataPlane: result.diagnostics,
        message: result.message
      });
      pushEvent(result.ok ? 'data-plane ready' : `data-plane pending ${result.state}`);
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
