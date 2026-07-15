import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  adoptPendingElectronLauncherPackages,
  loadElectronLauncherEnvFiles,
  parseElectronLauncherBootstrapUrls,
  resolveElectronLauncherBootstrap,
  type ElectronLauncherBootstrapResolution,
  applyElectronLauncherStandaloneDataPlane,
  buildElectronLauncherStandaloneOwnershipClaim,
  classifyElectronLauncherUpdateArtifact,
  createElectronLauncher,
  createElectronLauncherReleaseUpdateExecutor,
  createElectronLauncherReleaseUpdater,
  diagnoseElectronLauncherStandaloneDataPlane,
  defineLauncherProduct,
  readElectronLauncherStandaloneOwnershipState,
  reportElectronLauncherInstallCompletionIfUpgraded,
  routePlanFromSnapshot,
  stopElectronLauncherStandaloneDataPlane,
  upsertElectronLauncherStandaloneOwnershipClaim,
  type ElectronLauncherNetworkGateState,
  type ElectronLauncherReleaseUpdater,
  type ElectronLauncherStandaloneDataPlaneDiagnostics,
  type ElectronLauncherUpdateCheckResult,
  type ElectronLauncherUpdateExecutionResult,
  type LauncherNetworkSession,
  type LauncherProductDefinition,
  type StandaloneLauncher
} from '@qpjoy/electron-launcher';

type RuntimeStatus = 'idle' | 'connecting' | 'lease-active' | 'data-plane-pending' | 'network-ready' | 'error';
type LuopanDataPlaneMode = 'reuse' | 'standalone';

interface RuntimeConfig {
  baseUrl: string;
  /**
   * Bootstrap candidates probed BEFORE the tunnel exists (docs/20 §4.5): the
   * registered baseUrl is the in-tunnel VIP and is unreachable on first
   * enroll. Sourced from LUOPAN_BOOTSTRAP_URLS (env or .env file) or edited
   * in the CONFIG panel; the resolved one serves enroll/login/update until
   * the data plane reports network-ready.
   */
  bootstrapUrls: string[];
  productId: string;
  mode: 'standalone';
  sdkTestMode: boolean;
  deviceLabel: string;
}

interface RuntimeConnection {
  status: RuntimeStatus;
  bootstrapBaseUrl: string | null;
  leaseIp: string | null;
  serviceVip: string | null;
  dnsServer: string | null;
  routeCidrs: string[];
  snapshotDigest: string | null;
  dataPlane: ElectronLauncherStandaloneDataPlaneDiagnostics | null;
  message: string | null;
  updatedAt: string | null;
}

type RuntimeUpdateStatus = 'idle' | 'checking' | 'up-to-date' | 'update-available' | 'blocked' | 'failed';

interface RuntimeUpdateArtifact {
  artifactId: string;
  kind: string;
  artifactClass: string;
  version: string;
  activation: string;
  autoApply: boolean;
  sizeBytes: number | null;
}

interface RuntimeUpdateExecution {
  artifactId: string;
  artifactClass: string;
  phase: string;
  activated: boolean;
  deferredReason: string | null;
  error: string | null;
}

interface RuntimeUpdate {
  status: RuntimeUpdateStatus;
  checkedAt: string | null;
  currentVersion: string;
  targetVersion: string | null;
  releaseId: string | null;
  releaseNotes: string | null;
  matchedBy: string | null;
  featureFlags: string[];
  artifacts: RuntimeUpdateArtifact[];
  execution: RuntimeUpdateExecution[];
  message: string | null;
}

// User Center identity (docs/15 SDK gateway). The access token stays in
// memory only; the persisted identity is display metadata + the userId used
// for the login-range lease and release targeting.
interface RuntimeIdentity {
  kind: 'anonymous' | 'user';
  userId: string | null;
  displayName: string | null;
  account: string | null;
  scopes: string[];
  tokenExpiresAt: string | null;
  loginAt: string | null;
}

interface RuntimeState {
  installId: string;
  deviceId: string;
  config: RuntimeConfig;
  identity: RuntimeIdentity;
  connection: RuntimeConnection;
  update: RuntimeUpdate;
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
const DATA_PLANE_MODE = luopanDataPlaneMode();

let mainWindow: BrowserWindow | null = null;
let runtime: RuntimeState | null = null;
let activeSession: LauncherNetworkSession | null = null;
// In-memory only: never persisted, cleared on logout/restart.
let activeAccessToken: string | null = null;
// Pinned by the last successful bootstrap resolution; serves every API call
// made before the data plane is network-ready.
let activeBootstrapBaseUrl: string | null = null;

app.setAppUserModelId('dev.qpjoy.luopan');

function luopanDataPlaneMode(): LuopanDataPlaneMode {
  if (booleanish(process.env.LUOPAN_FORCE_STANDALONE_WG, false)) return 'standalone';
  const value = process.env.LUOPAN_DATA_PLANE_MODE?.trim().toLowerCase();
  if (value === 'reuse') return 'reuse';
  return 'standalone';
}

function initialDataPlaneApplyMessage(): string {
  if (DATA_PLANE_MODE === 'reuse') {
    return 'Checking existing shared launcher data plane for Luopan reuse.';
  }
  return 'Syncing Domestic peer and applying Luopan as an independent standalone data-plane owner.';
}

function defaultConfig(): RuntimeConfig {
  return {
    // Luopan's registered product VIP (docs/19, HANDOFF §网络注册). Never fall
    // back to 10.88.88.88 / 10.88.0.1 — those are MX-H2I/foundation migration
    // compatibility addresses and are off-limits to Luopan.
    baseUrl: normalizeBaseUrl(process.env.LUOPAN_LAUNCHER_BASE_URL || process.env.MX_LAUNCHER_BASE_URL || 'http://10.88.100.3:18090'),
    bootstrapUrls: parseElectronLauncherBootstrapUrls(process.env.LUOPAN_BOOTSTRAP_URLS),
    productId: 'luopan',
    mode: 'standalone',
    // Registered mode by default: the lease request must pass the server-side
    // ProductNetwork + AppCenter entitlement gate. SDK test mode bypasses that
    // gate and only works when the server enables it — dev opt-in via env.
    sdkTestMode: booleanish(process.env.LUOPAN_SDK_TEST_MODE, false),
    deviceLabel: process.env.LUOPAN_DEVICE_LABEL?.trim() || 'Luopan Quasar Demo'
  };
}

function emptyConnection(): RuntimeConnection {
  return {
    status: 'idle',
    bootstrapBaseUrl: null,
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

function emptyIdentity(): RuntimeIdentity {
  return {
    kind: 'anonymous',
    userId: null,
    displayName: null,
    account: null,
    scopes: [],
    tokenExpiresAt: null,
    loginAt: null
  };
}

function emptyUpdate(): RuntimeUpdate {
  return {
    status: 'idle',
    checkedAt: null,
    currentVersion: app.getVersion(),
    targetVersion: null,
    releaseId: null,
    releaseNotes: null,
    matchedBy: null,
    featureFlags: [],
    artifacts: [],
    execution: [],
    message: 'Release Center not checked yet.'
  };
}

async function loadRuntime(): Promise<RuntimeState> {
  const fallback: RuntimeState = {
    installId: `luopan-inst-${randomUUID()}`,
    deviceId: `luopan-dev-${randomUUID()}`,
    config: defaultConfig(),
    identity: emptyIdentity(),
    connection: emptyConnection(),
    update: emptyUpdate(),
    events: []
  };
  const file = runtimeStateFile();
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<RuntimeState>;
    return {
      installId: stringValue(parsed.installId) || fallback.installId,
      deviceId: stringValue(parsed.deviceId) || fallback.deviceId,
      config: normalizeConfig(parsed.config, fallback.config),
      identity: normalizeIdentity(parsed.identity),
      connection: normalizeConnection(parsed.connection),
      update: normalizeUpdate(parsed.update),
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
    identity: { ...state.identity, tokenPresent: Boolean(activeAccessToken) },
    connection: state.connection,
    update: state.update,
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
    baseUrl: effectiveApiBaseUrl(),
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

/**
 * API base for the current phase: once the data plane is network-ready the
 * product talks to its own VIP; before that (enroll, login, update check,
 * peer sync) everything goes through the resolved bootstrap URL.
 */
function effectiveApiBaseUrl(): string {
  const state = requireRuntime();
  if (state.connection.status === 'network-ready') return state.config.baseUrl;
  return activeBootstrapBaseUrl || state.config.baseUrl;
}

/**
 * Probe bootstrap candidates (env/.env/config order) and pin the first
 * healthy one. `force` re-probes even when one is already pinned — used when
 * a connect attempt starts, so a network change picks a new entrance.
 */
async function ensureBootstrapResolved(force = false): Promise<ElectronLauncherBootstrapResolution | null> {
  const state = requireRuntime();
  if (!force && activeBootstrapBaseUrl) return null;
  const resolution = await resolveElectronLauncherBootstrap({
    candidates: [
      ...state.config.bootstrapUrls.map((url) => ({ url, source: 'bootstrap-urls' })),
      { url: state.config.baseUrl, source: 'config.baseUrl' }
    ],
    timeoutMs: 3000
  });
  if (resolution.ok && resolution.baseUrl) {
    activeBootstrapBaseUrl = resolution.baseUrl;
    state.connection.bootstrapBaseUrl = resolution.baseUrl;
    pushEvent(`bootstrap resolved ${resolution.baseUrl} (${resolution.source})`);
  } else {
    activeBootstrapBaseUrl = null;
    state.connection.bootstrapBaseUrl = null;
    pushEvent('bootstrap resolve failed');
  }
  return resolution;
}

// --- Release update wiring (docs/19 §3+§5, docs/17 state machine) ----------
// Everything below consumes @qpjoy/electron-launcher; no update logic lives in
// the product. The last check result is kept in memory only: `apply-update`
// must always execute a fresh Release Center decision, never a persisted one.
let lastUpdateCheck: ElectronLauncherUpdateCheckResult | null = null;

function releaseUpdater(): ElectronLauncherReleaseUpdater {
  const state = requireRuntime();
  return createElectronLauncherReleaseUpdater({
    // In-tunnel VIP once connected; bootstrap URL before that, so the update
    // panel (and startup bookkeeping) works pre-connect too.
    baseUrl: effectiveApiBaseUrl(),
    reportInstallId: state.installId
  });
}

// docs/17 stability boundary: never activate artifacts while the product's
// network path is busy. Luopan maps its connection status onto the gate; the
// executor re-checks this before every activation and defers with a report.
function updateNetworkGate(): ElectronLauncherNetworkGateState {
  const status = requireRuntime().connection.status;
  if (status === 'connecting') return 'connecting';
  if (status === 'data-plane-pending') return 'recovering';
  return 'idle';
}

function updateExecutor(updater: ElectronLauncherReleaseUpdater) {
  return createElectronLauncherReleaseUpdateExecutor({
    updater,
    baseDir: app.getPath('userData'),
    installId: requireRuntime().installId,
    networkGate: () => updateNetworkGate(),
    onPhase: (phase, detail) => {
      const artifactId = typeof detail.artifactId === 'string' ? ` ${detail.artifactId}` : '';
      pushEvent(`update ${phase}${artifactId}`);
      broadcastRuntime();
    },
    applyConfig: (activePath) => {
      pushEvent(`config snapshot activated ${path.basename(activePath)}`);
      broadcastRuntime();
    },
    applyRenderer: (activePath) => {
      pushEvent(`renderer bundle activated ${path.basename(activePath)}`);
      mainWindow?.webContents.reload();
    },
    openInstaller: async (filePath) => {
      await shell.openPath(filePath);
    }
  });
}

// Ranking across the installer/hot component namespaces: an actionable
// decision wins; blocked beats up-to-date so gate state stays visible.
function chooseUpdateCheck(checks: ElectronLauncherUpdateCheckResult[]): ElectronLauncherUpdateCheckResult {
  if (checks.length === 0) throw new Error('Release check returned no results');
  return checks.find((check) => check.status === 'update-available')
    ?? checks.find((check) => check.status === 'blocked')
    ?? checks.find((check) => check.status === 'up-to-date')
    ?? checks[0];
}

function updateFromCheck(check: ElectronLauncherUpdateCheckResult): RuntimeUpdate {
  return {
    status: check.status,
    checkedAt: check.checkedAt,
    currentVersion: app.getVersion(),
    targetVersion: check.decision.targetVersion || null,
    releaseId: check.plan?.releaseId ?? null,
    releaseNotes: check.releaseNotes ?? null,
    matchedBy: check.rollout?.matchedBy ?? null,
    featureFlags: check.featureFlags ?? [],
    artifacts: check.artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      artifactClass: classifyElectronLauncherUpdateArtifact(artifact.kind),
      version: artifact.version,
      activation: artifact.activation,
      autoApply: artifact.autoApply,
      sizeBytes: artifact.sizeBytes
    })),
    execution: [],
    message: check.reason
  };
}

function executionSummary(result: ElectronLauncherUpdateExecutionResult): RuntimeUpdateExecution[] {
  return result.artifacts.map((artifact) => ({
    artifactId: artifact.artifactId,
    artifactClass: artifact.artifactClass,
    phase: artifact.phase,
    activated: artifact.activated,
    deferredReason: artifact.deferredReason,
    error: artifact.error
  }));
}

// Boot-time update bookkeeping (docs/19 §5 pipelines 3+4): promote staged
// npm-package pointers to current, then report installer-completed on the
// first start after a version change so Release Center closes the loop.
async function adoptUpdatesAndReportInstallCompletion(): Promise<void> {
  const baseDir = app.getPath('userData');
  const adopted = await adoptPendingElectronLauncherPackages(baseDir);
  for (const pointer of adopted) {
    pushEvent(`launcher package adopted ${pointer.version}`);
  }
  const completion = await reportElectronLauncherInstallCompletionIfUpgraded({
    updater: releaseUpdater(),
    baseDir,
    currentVersion: app.getVersion(),
    installId: requireRuntime().installId
  });
  if (completion.upgraded) {
    pushEvent(`installer completed ${completion.from} -> ${completion.to}`);
  }
  if (adopted.length > 0 || completion.upgraded) {
    await saveRuntime();
    broadcastRuntime();
  }
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
  const lastErrors = new Map<string, string>();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const url of candidates) {
      try {
        await probeDevServer(url);
        await window.loadURL(url);
        return;
      } catch (error) {
        lastErrors.set(url, errorMessage(error));
      }
    }
    await sleep(250);
  }
  const attempts = candidates.map((url) => `${url}: ${lastErrors.get(url) || 'not-attempted'}`);
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(devRendererErrorHtml(attempts))}`);
  if (!window.isVisible()) window.show();
}

function devRendererUrlCandidates(): string[] {
  const explicit = normalizeDevRendererUrl(process.env.LUOPAN_RENDERER_URL);
  const appUrl = normalizeDevRendererUrl(process.env.APP_URL);
  const ports = uniqueNumbers([
    devRendererPort(explicit),
    devRendererPort(appUrl),
    9031
  ].filter((port): port is number => Boolean(port)));
  return uniqueStrings([
    explicit,
    ...ports.flatMap((port) => devRendererNetworkHosts().map((host) => `http://${host}:${port}`)),
    appUrl,
    ...ports.flatMap((port) => [`http://127.0.0.1:${port}`, `http://localhost:${port}`])
  ].filter((url): url is string => Boolean(url)));
}

function normalizeDevRendererUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.hostname === '0.0.0.0' || url.hostname === '::') return null;
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function devRendererPort(rawUrl: string | null): number | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

function devRendererNetworkHosts(): string[] {
  const addresses = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address)
    .filter(isDevRendererAddress)
    .sort((left, right) => devRendererAddressScore(left) - devRendererAddressScore(right));
  return uniqueStrings(addresses);
}

function isDevRendererAddress(address: string): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) return false;
  const parts = address.split('.').map(Number);
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  if (parts[0] === 127 || (parts[0] === 169 && parts[1] === 254)) return false;
  if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return false;
  return true;
}

function devRendererAddressScore(address: string): number {
  if (address.startsWith('192.168.')) return 0;
  if (address.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) return 2;
  return 3;
}

async function probeDevServer(rawUrl: string): Promise<void> {
  const url = new URL(rawUrl);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const host = url.hostname;
  await tcpProbe(host, port);
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

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
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
  // User Center: password login via SDK gateway -> identityKind 'user'. The
  // next connect (or reconnect) picks up the login lease range automatically.
  ipcMain.handle('luopan:login', async (_event, input) => {
    const state = requireRuntime();
    const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const account = stringValue(record.account);
    const password = typeof record.password === 'string' ? record.password : '';
    if (!account || !password) {
      pushEvent('login rejected: missing account or password');
      await saveRuntime();
      broadcastRuntime();
      return visibleRuntime();
    }
    try {
      if (state.connection.status !== 'network-ready') await ensureBootstrapResolved();
      const auth = await authenticateLuopanUser(account, password);
      activeAccessToken = auth.accessToken;
      state.identity = {
        kind: 'user',
        userId: auth.userId,
        displayName: auth.displayName || account,
        account,
        scopes: auth.scopes,
        tokenExpiresAt: auth.expiresAt,
        loginAt: new Date().toISOString()
      };
      pushEvent(`user login ${auth.userId}`);
    } catch (error) {
      activeAccessToken = null;
      pushEvent(`login failed ${errorMessage(error)}`);
    }
    await saveRuntime();
    broadcastRuntime();
    return visibleRuntime();
  });
  ipcMain.handle('luopan:logout', async () => {
    const state = requireRuntime();
    activeAccessToken = null;
    state.identity = emptyIdentity();
    pushEvent('user logged out');
    await saveRuntime();
    broadcastRuntime();
    return visibleRuntime();
  });
  ipcMain.handle('luopan:connect-test-mode', async () => {
    await requestLuopanLease();
    await saveRuntime();
    broadcastRuntime();
    return visibleRuntime();
  });
  ipcMain.handle('luopan:apply-data-plane', async () => {
    await applyLuopanDataPlane();
    return visibleRuntime();
  });
  // One-click "connect into Internal": registered lease -> WG data plane ->
  // in-tunnel service VIP reachability. Same building blocks as the two-step
  // buttons; success means the product path to Internal is proven end to end.
  ipcMain.handle('luopan:connect-internal', async () => {
    const leased = await requestLuopanLease();
    if (leased) {
      const ready = await applyLuopanDataPlane();
      pushEvent(ready ? 'connect internal complete' : 'connect internal pending data plane');
    }
    await saveRuntime();
    broadcastRuntime();
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
  ipcMain.handle('luopan:check-updates', async () => {
    const state = requireRuntime();
    state.update = { ...state.update, status: 'checking', message: 'Checking Release Center decision.' };
    broadcastRuntime();
    try {
      if (state.connection.status !== 'network-ready') await ensureBootstrapResolved();
      // Launcher convention (same as mx-h2i): installer plans target
      // `<componentId>`, hot plans target `<componentId>-renderer`. Check
      // both namespaces and keep the strongest decision. userId is passed so
      // per-user targeted releases (docs/20 §5.8) match logged-in users.
      const updater = releaseUpdater();
      const userId = state.identity.kind === 'user' ? state.identity.userId : null;
      const checks: ElectronLauncherUpdateCheckResult[] = [];
      for (const componentId of [PRODUCT.release.componentId, `${PRODUCT.release.componentId}-renderer`]) {
        checks.push(await updater.check({
          componentId,
          currentVersion: app.getVersion(),
          channel: PRODUCT.release.channel,
          installId: state.installId,
          userId,
          platform: process.platform
        }));
      }
      const check = chooseUpdateCheck(checks);
      lastUpdateCheck = check;
      state.update = updateFromCheck(check);
      pushEvent(`update check ${check.status}`);
    } catch (error) {
      lastUpdateCheck = null;
      state.update = { ...emptyUpdate(), status: 'failed', message: errorMessage(error) };
      pushEvent(`update check failed ${errorMessage(error)}`);
    }
    await saveRuntime();
    broadcastRuntime();
    return visibleRuntime();
  });
  ipcMain.handle('luopan:apply-update', async () => {
    const state = requireRuntime();
    if (!lastUpdateCheck || lastUpdateCheck.status !== 'update-available') {
      state.update = { ...state.update, message: 'No update-available decision in memory; run check first.' };
      broadcastRuntime();
      return visibleRuntime();
    }
    try {
      const result = await updateExecutor(releaseUpdater()).execute(lastUpdateCheck);
      state.update = {
        ...state.update,
        execution: executionSummary(result),
        message: result.executed
          ? `Executed release ${result.releaseId}: ${result.artifacts.length} artifact(s) processed.`
          : result.reason
      };
      pushEvent(`update executed ${result.releaseId ?? 'none'}`);
    } catch (error) {
      state.update = { ...state.update, status: 'failed', message: errorMessage(error) };
      pushEvent(`update execute failed ${errorMessage(error)}`);
    }
    await saveRuntime();
    broadcastRuntime();
    return visibleRuntime();
  });
  ipcMain.handle('luopan:open-staged-installer', async () => {
    const state = requireRuntime();
    const artifact = lastUpdateCheck?.artifacts.find(
      (candidate) => classifyElectronLauncherUpdateArtifact(candidate.kind) === 'installer'
    );
    if (!artifact) {
      state.update = { ...state.update, message: 'No installer artifact in the last check.' };
      broadcastRuntime();
      return visibleRuntime();
    }
    try {
      const installerPath = await updateExecutor(releaseUpdater()).openStagedInstaller(artifact);
      state.update = { ...state.update, message: `Installer opened: ${path.basename(installerPath)}. Confirm the OS prompt to install.` };
      pushEvent('installer opened');
    } catch (error) {
      state.update = { ...state.update, message: errorMessage(error) };
      pushEvent(`installer open failed ${errorMessage(error)}`);
    }
    await saveRuntime();
    broadcastRuntime();
    return visibleRuntime();
  });
  ipcMain.handle('luopan:rollback-update-slot', async (_event, slot) => {
    const state = requireRuntime();
    const normalizedSlot = slot === 'renderer' ? 'renderer' : 'config';
    try {
      const pointer = await updateExecutor(releaseUpdater()).rollback(normalizedSlot);
      state.update = {
        ...state.update,
        message: pointer
          ? `Rolled ${normalizedSlot} slot back to ${pointer.version}.`
          : `No previous ${normalizedSlot} slot to roll back to.`
      };
      pushEvent(pointer ? `update slot rolled back ${normalizedSlot} ${pointer.version}` : `rollback skipped ${normalizedSlot}`);
    } catch (error) {
      state.update = { ...state.update, message: errorMessage(error) };
      pushEvent(`rollback failed ${errorMessage(error)}`);
    }
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

// Step 1 of connecting into Internal: enroll a lease against the registered
// ProductNetwork (identityKind anonymous -> anonymous lease range). In
// registered mode the server enforces the entitlement gate: ProductNetwork
// enabled + AppCenter app `luopan` enabled with launcher-network +
// launcher-standalone capabilities.
async function requestLuopanLease(): Promise<boolean> {
  const state = requireRuntime();
  const loggedIn = state.identity.kind === 'user' && Boolean(state.identity.userId);
  await setConnection({
    status: 'connecting',
    message: state.config.sdkTestMode
      ? 'Requesting Launcher Network lease in SDK test mode.'
      : loggedIn
        ? `Requesting user-range Luopan lease for ${state.identity.userId}.`
        : 'Requesting registered Luopan Launcher Network lease.'
  });
  pushEvent('lease request started');
  try {
    // First hop must be bootstrap-reachable: re-probe candidates on every
    // connect attempt so a network change picks a working entrance.
    const resolution = await ensureBootstrapResolved(true);
    if (resolution && !resolution.ok) {
      throw new Error(resolution.message);
    }
    const session = await launcherClient().connectNetwork({
      // Logged-in users land in the user lease range, anonymous sessions in
      // the anonymous range (docs/20 §1.2). Same API, different identityKind.
      identityKind: loggedIn ? 'user' : 'anonymous',
      userId: loggedIn ? state.identity.userId : undefined,
      platform: 'quasar-electron',
      sdkTestMode: state.config.sdkTestMode,
      requestedBy: 'luopan-quasar-demo',
      requestId: `luopan-${Date.now()}`
    });
    activeSession = session;
    await applySession(session);
    pushEvent(`lease active ${session.lease.leaseIp}`);
    return true;
  } catch (error) {
    await setConnection({
      status: 'error',
      message: errorMessage(error)
    });
    pushEvent(`lease failed ${errorMessage(error)}`);
    return false;
  }
}

// Step 2: bring up the local WG data plane for the active lease and verify the
// product service VIP is reachable in-tunnel. Returns true only when the data
// plane is fully ready (routes installed + VIP healthz answered).
async function applyLuopanDataPlane(): Promise<boolean> {
  await setConnection({
    status: 'connecting',
    message: initialDataPlaneApplyMessage()
  });
  pushEvent('data-plane apply started');
  try {
    if (!activeSession) throw new Error('Request a Luopan lease before applying the local data plane.');
    const privateKey = stringValue(activeSession.wireGuard.privateKey);
    if (!privateKey) throw new Error('Luopan WireGuard private key is missing; request a fresh lease.');
    if (DATA_PLANE_MODE === 'reuse') {
      const attached = attachToSharedDataPlane(activeSession);
      if (attached) {
        await setConnection({
          status: runtimeStatusForDataPlane(attached.dataPlane),
          dataPlane: attached.dataPlane,
          message: attached.message
        });
        pushEvent(`data-plane attached ${attached.reason}`);
        return attached.dataPlane.ok;
      }
      const dataPlane = diagnoseSharedDataPlane(activeSession);
      await setConnection({
        status: runtimeStatusForDataPlane(dataPlane),
        dataPlane,
        message: dataPlane.message
      });
      pushEvent(`data-plane pending ${dataPlane.state}`);
      return dataPlane.ok;
    }
    await syncLeasePeers(activeSession);
    const dataPlaneRoutePlan = luopanStandaloneDataPlaneRoutePlan(activeSession.routePlan);
    const result = await applyElectronLauncherStandaloneDataPlane({
      userDataDir: app.getPath('userData'),
      profileName: 'luopan.conf',
      routePlan: dataPlaneRoutePlan,
      privateKey,
      dnsDomains: [LUOPAN_DNS_ZONE],
      suppressWireGuardDns: true,
      requiredProbeTargets: ['lease-ip', 'service-vip'],
      ownerId: `${PRODUCT.productId}:${requireRuntime().installId}`,
      productId: PRODUCT.productId,
      instanceId: requireRuntime().installId,
      displayName: PRODUCT.displayName,
      metadata: {
        dataPlaneMode: 'standalone-wireguard',
        dataPlaneOwner: true
      },
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
    return result.ok && dataPlane.ok;
  } catch (error) {
    await setConnection({
      status: 'error',
      message: errorMessage(error)
    });
    pushEvent(`data-plane failed ${errorMessage(error)}`);
    return false;
  }
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

function diagnoseSharedDataPlane(session: LauncherNetworkSession): ElectronLauncherStandaloneDataPlaneDiagnostics {
  const routeProof = sharedDataPlaneRouteProof(session);
  if (!sharedCoreRoutesReady(routeProof)) {
    return {
      ...routeProof,
      ok: false,
      state: routeProof.state === 'proxy-tun-captured' ? routeProof.state : 'data-plane-pending',
      severity: routeProof.severity === 'error' ? routeProof.severity : 'warning',
      message: `No shared launcher data plane is ready for Luopan reuse. ${routeProof.message} Unset LUOPAN_DATA_PLANE_MODE or set it to standalone when Luopan should own its data plane.`
    };
  }
  const dataPlaneOwner = sharedFoundationOwnerClaim();
  if (!dataPlaneOwner) {
    return {
      ...routeProof,
      ok: false,
      state: 'data-plane-pending',
      severity: 'warning',
      message: 'Shared foundation routes are present, but no product-neutral launcher-foundation owner claim is registered. Start the launcher foundation plane or use standalone product routes.'
    };
  }
  const gatewayReachability = probeIcmpReachability(session.routePlan.domesticGatewayIp);
  if (!gatewayReachability.ok) {
    return {
      ...routeProof,
      ok: false,
      state: 'data-plane-pending',
      severity: 'warning',
      message: `Shared launcher routes are present, but Domestic gateway ${session.routePlan.domesticGatewayIp} is not reachable (${gatewayReachability.message}). Keep the current data-plane owner connected before Luopan reuses it.`
    };
  }
  return withServiceVipReachability(routeProof, session, 'shared-reuse');
}

function attachToSharedDataPlane(session: LauncherNetworkSession): {
  dataPlane: ElectronLauncherStandaloneDataPlaneDiagnostics;
  message: string;
  reason: string;
} | null {
  const routeProof = sharedDataPlaneRouteProof(session);
  if (!sharedCoreRoutesReady(routeProof)) return null;
  const gatewayReachability = probeIcmpReachability(session.routePlan.domesticGatewayIp);
  if (!gatewayReachability.ok) return null;

  const dataPlaneOwner = sharedFoundationOwnerClaim();
  if (!dataPlaneOwner) return null;
  const dataPlane = withServiceVipReachability(routeProof, session, 'shared-reuse');
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
      dataPlaneMode: 'shared-reuse',
      dataPlaneOwnerId: dataPlaneOwner?.ownerId ?? null,
      serviceVip: session.routePlan.serviceVip,
      dnsServer: session.routePlan.dnsServer
    }
  };
  upsertElectronLauncherStandaloneOwnershipClaim(claim);
  const reason = dataPlaneOwner?.ownerId ? `owner:${dataPlaneOwner.ownerId}` : 'route-proof';
  return {
    dataPlane,
    reason,
    message: `Attached to existing shared launcher data plane (${reason}). ${dataPlane.message}`
  };
}

function luopanStandaloneDataPlaneRoutePlan(routePlan: LauncherNetworkSession['routePlan']): LauncherNetworkSession['routePlan'] {
  const routeCidrs = uniqueStrings([
    routePlan.leaseCidr,
    routePlan.serviceVip ? `${routePlan.serviceVip}/32` : ''
  ].filter((value): value is string => Boolean(value)));
  return {
    ...routePlan,
    routeCidrs,
    allowedIps: routeCidrs,
    h2iDirectAllowedIps: routeCidrs
  };
}

function sharedDataPlaneRouteProof(session: LauncherNetworkSession): ElectronLauncherStandaloneDataPlaneDiagnostics {
  return diagnoseElectronLauncherStandaloneDataPlane({
    routePlan: session.routePlan,
    leaseIp: session.lease.leaseIp,
    serviceVip: session.lease.serviceVip,
    dnsServer: session.routePlan.dnsServer,
    wireGuardActive: true
  });
}

function sharedCoreRoutesReady(dataPlane: ElectronLauncherStandaloneDataPlaneDiagnostics): boolean {
  const targets = new Set(['internal-control', 'domestic-gateway', 'dns-server']);
  const probes = dataPlane.probes.filter((probe) => targets.has(probe.target));
  return probes.length > 0 && probes.every((probe) => probe.ok && !probe.viaProxyTun);
}

function sharedFoundationOwnerClaim(): { ownerId?: string | null; productId?: string | null; state?: string | null; metadata?: Record<string, unknown> | null } | null {
  const state = readElectronLauncherStandaloneOwnershipState();
  return state.claims.find(isSharedDataPlaneOwner) ?? null;
}

function isSharedDataPlaneOwner(claim: { ownerId?: string | null; productId?: string | null; state?: string | null; dnsZones?: string[] | null; routeCidrs?: string[] | null; metadata?: Record<string, unknown> | null }): boolean {
  if (!claim.ownerId || claim.state === 'released') return false;
  const dataPlaneMode = claim.metadata?.dataPlaneMode;
  return dataPlaneMode === 'launcher-foundation'
    || dataPlaneMode === 'shared-foundation'
    || claim.metadata?.foundationOwner === true;
}

function withServiceVipReachability(
  dataPlane: ElectronLauncherStandaloneDataPlaneDiagnostics,
  session: LauncherNetworkSession,
  mode: 'shared-reuse' | 'standalone-wireguard'
): ElectronLauncherStandaloneDataPlaneDiagnostics {
  const serviceVip = stringValue(session.lease.serviceVip) || stringValue(session.routePlan.serviceVip);
  const serviceRoute = dataPlane.probes.find((probe) => probe.target === 'service-vip');
  if (!serviceVip || serviceRoute?.ok !== true || !dataPlane.ok) return dataPlane;
  const prefix = mode === 'shared-reuse'
    ? 'Shared launcher routes are present'
    : 'Standalone WireGuard routes are present';
  const serviceHealth = probeServiceVipHealth(session, serviceVip);
  if (!serviceHealth.ok) {
    return {
      ...dataPlane,
      ok: false,
      state: 'service-unreachable',
      severity: 'warning',
      message: `${prefix}; Luopan service VIP ${serviceVip} is routed through ${serviceRoute.interfaceName || 'WireGuard'}, but ${serviceHealth.url} is not reachable (${serviceHealth.message}). Apply Domestic relay/Internal service-peer materialization before treating this channel as network-ready.`
    };
  }
  return {
    ...dataPlane,
    message: `${prefix}; Luopan service VIP ${serviceVip} is routed through ${serviceRoute.interfaceName || 'WireGuard'} and ${serviceHealth.url} is reachable.`
  };
}

function probeServiceVipHealth(session: LauncherNetworkSession, serviceVip: string): { ok: boolean; url: string; message: string } {
  const url = serviceVipHealthUrl(session, serviceVip);
  try {
    execFileSync('curl', ['-fsS', '--max-time', '2', url], { stdio: 'pipe', timeout: 3000 });
    return { ok: true, url, message: 'healthz ok' };
  } catch (error) {
    return { ok: false, url, message: errorMessage(error) };
  }
}

function serviceVipHealthUrl(session: LauncherNetworkSession, serviceVip: string): string {
  try {
    const parsed = new URL(stringValue(session.routePlan.internalBaseUrl) || `http://${serviceVip}:18090`);
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : parsed.protocol === 'http:' ? '80' : '18090');
    return `${parsed.protocol}//${serviceVip}${port ? `:${port}` : ''}/healthz`;
  } catch {
    return `http://${serviceVip}:18090/healthz`;
  }
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
  // Called during data-plane bring-up (pre-tunnel): must use the bootstrap URL.
  const response = await fetch(`${effectiveApiBaseUrl()}/internal/v1/launcher-network${pathname}`, {
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

// User Center login via the SDK gateway OAuth password grant (docs/15). The
// returned principal.userId is the key for the login-range lease
// (identityKind 'user') and for Release Center user targeting.
async function authenticateLuopanUser(account: string, password: string): Promise<{
  userId: string;
  displayName: string | null;
  scopes: string[];
  accessToken: string | null;
  expiresAt: string | null;
}> {
  const response = await fetch(`${effectiveApiBaseUrl()}/internal/v1/sdk/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'password',
      username: account,
      password,
      audience: 'mx-sdk',
      scope: 'auth.read network.hdi.status',
      requestId: `luopan-oauth-${Date.now()}`
    })
  });
  const text = await response.text();
  const payload = text ? safeJson(text) : null;
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  if (!response.ok) {
    const message = stringValue(record.message) || text || response.statusText;
    throw new Error(`User Center login failed: ${response.status} ${message}`);
  }
  const token = (record.token && typeof record.token === 'object' ? record.token : record) as Record<string, unknown>;
  const principal = token.principal && typeof token.principal === 'object' ? token.principal as Record<string, unknown> : {};
  const subject = stringValue(token.subject);
  const userId = stringValue(principal.userId)
    || (subject?.startsWith('user:') ? stringValue(subject.slice('user:'.length)) : null);
  if (!userId) throw new Error('User Center login did not return a user principal.');
  return {
    userId,
    displayName: stringValue(principal.displayName),
    scopes: typeof token.scope === 'string' ? token.scope.split(/\s+/).filter(Boolean) : [],
    accessToken: stringValue(token.access_token),
    expiresAt: stringValue(token.expires_at)
  };
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
    bootstrapUrls: normalizeBootstrapUrls(record.bootstrapUrls, fallback.bootstrapUrls),
    productId: 'luopan',
    mode: 'standalone',
    sdkTestMode: typeof record.sdkTestMode === 'boolean' ? record.sdkTestMode : fallback.sdkTestMode,
    deviceLabel: stringValue(record.deviceLabel) || fallback.deviceLabel
  };
}

// Empty input falls back (usually to LUOPAN_BOOTSTRAP_URLS from env/.env):
// an explicit list wins, a cleared field re-enables the environment default.
function normalizeBootstrapUrls(input: unknown, fallback: string[]): string[] {
  const raw = typeof input === 'string'
    ? input
    : Array.isArray(input)
      ? input.filter((item): item is string => typeof item === 'string').join(',')
      : null;
  if (raw === null) return fallback;
  const parsed = parseElectronLauncherBootstrapUrls(raw);
  return parsed.length > 0 ? parsed : fallback;
}

function normalizeConnection(input: unknown): RuntimeConnection {
  const fallback = emptyConnection();
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const leaseIp = stringValue(record.leaseIp);
  const dataPlane = normalizeDataPlane(record.dataPlane);
  const status = normalizeRuntimeStatus(record.status, leaseIp, dataPlane);
  return {
    status,
    bootstrapBaseUrl: stringValue(record.bootstrapBaseUrl),
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

function normalizeIdentity(input: unknown): RuntimeIdentity {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const userId = stringValue(record.userId);
  if (record.kind !== 'user' || !userId) return emptyIdentity();
  return {
    kind: 'user',
    userId,
    displayName: stringValue(record.displayName),
    account: stringValue(record.account),
    scopes: Array.isArray(record.scopes) ? record.scopes.filter((item): item is string => typeof item === 'string') : [],
    tokenExpiresAt: stringValue(record.tokenExpiresAt),
    loginAt: stringValue(record.loginAt)
  };
}

function normalizeUpdate(input: unknown): RuntimeUpdate {
  const fallback = emptyUpdate();
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const status = record.status;
  return {
    // A persisted 'checking' means the app died mid-check; reset to idle. The
    // execution summary is kept for display, but apply always re-checks.
    status: status === 'up-to-date' || status === 'update-available' || status === 'blocked' || status === 'failed' ? status : 'idle',
    checkedAt: stringValue(record.checkedAt),
    currentVersion: app.getVersion(),
    targetVersion: stringValue(record.targetVersion),
    releaseId: stringValue(record.releaseId),
    releaseNotes: stringValue(record.releaseNotes),
    matchedBy: stringValue(record.matchedBy),
    featureFlags: Array.isArray(record.featureFlags) ? record.featureFlags.filter((item): item is string => typeof item === 'string') : [],
    artifacts: Array.isArray(record.artifacts) ? record.artifacts.filter((item): item is RuntimeUpdateArtifact => Boolean(item) && typeof item === 'object') : [],
    execution: Array.isArray(record.execution) ? record.execution.filter((item): item is RuntimeUpdateExecution => Boolean(item) && typeof item === 'object') : [],
    message: stringValue(record.message) || fallback.message
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
  if (!trimmed) return 'http://10.88.88.88:18090';
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
  // .env support for packaged builds (no shell env there). Real env vars win;
  // then per-machine <userData>/.env; then the .env shipped inside the app
  // (electron-builder extraResources); then the project .env during dev.
  const envResult = loadElectronLauncherEnvFiles([
    path.join(app.getPath('userData'), '.env'),
    process.resourcesPath ? path.join(process.resourcesPath, '.env') : null,
    path.join(app.getAppPath(), '.env'),
    path.resolve(currentDir, '..', '..', '.env')
  ]);
  if (envResult.loadedFrom) {
    console.log(`[luopan] env file loaded: ${envResult.loadedFrom} (${envResult.applied.join(', ') || 'no new keys'})`);
  }
  runtime = await loadRuntime();
  registerIpc();
  await createWindow();
  void adoptUpdatesAndReportInstallCompletion().catch((error) => {
    console.warn('[luopan] startup update bookkeeping failed:', errorMessage(error));
  });
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
