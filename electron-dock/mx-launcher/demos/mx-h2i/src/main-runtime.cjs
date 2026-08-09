const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const dnsPromises = require('node:dns').promises;
const net = require('node:net');
const dgram = require('node:dgram');
const { execFile } = require('node:child_process');
const { createHash, randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const {
  DEFAULT_DOMESTIC_PEER_SYNC_TIMEOUT_MS,
  darwinSupersedableOwnershipOwnerIds,
  isDarwinDynamicProxyEndpointRoute,
  retainedGuestRecoveryDecision,
  shouldRepairDarwinRetainedOwnership,
  stableOwnershipInstanceId,
  wireGuardRecoveryGate,
  wireGuardRecoveryTurn
} = require('./network-recovery-policy.cjs');
const {
  postConnectDataPlaneReady,
  standaloneOwnershipReady,
  windowsBrowserFallbackState,
  windowsBrowserPromotionPrerequisitesReady,
  windowsLocalEdgePrerequisitesReady,
  windowsSplitDnsPathReady,
  windowsSystemDnsDataPlaneReady
} = require('./windows-network-readiness.cjs');
const {
  darwinSplitDnsStatusReady,
  invalidatePersistedDarwinSplitDnsProof,
  resolverRootsCoverDomains
} = require('./split-dns-policy.cjs');
const {
  reconcileRuntimeUpdateWithInstalledVersion
} = require('./update-state-policy.cjs');
const {
  decideClashLinkAction,
  resolveEffectiveProxyNode
} = require('./clash-link-policy.cjs');
const {
  extractNpmTarball,
  normalizePluginSources,
  pluginDownloadPlan,
  rewriteTarballToSource,
  selectPackumentVersion,
  verifyTarballIntegrity
} = require('./plugin-package-source.cjs');
const {
  confirmElectronLauncherAsarLaunch,
  runningElectronLauncherVersion
} = loadAsarBootstrap();
const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, screen: electronScreen, powerMonitor, net: electronNet, dialog, session: electronSession, safeStorage } = require('electron');

loadDotEnvFiles();

const APP_ID = 'dev.qpjoy.mx-h2i';
const STATE_FILE = 'mx-h2i-runtime.json';
const H2O_RUNTIME_STORE_FILE = 'mx-h2i-h2o-runtime.json';
const STATE_BACKUP_DIR_NAME = 'state-backups';
const STATE_BACKUP_LIMIT = 5;
const DIAGNOSTIC_LOG_DIR_NAME = 'logs';
const DIAGNOSTIC_LOG_FILE_NAME = 'mx-h2i-runtime.ndjson';
const DIAGNOSTIC_LOG_MAX_BYTES = 2 * 1024 * 1024;
const DIAGNOSTIC_LOG_ROTATIONS = 2;
const DIAGNOSTIC_RECENT_LIMIT = 40;
const WINDOWS_PRIVATE_JSON_RENAME_RETRY_DELAYS_MS = Object.freeze([25, 75, 150, 300]);
const PRODUCT_ID = 'mx-h2i';
const PRODUCT_DISPLAY_NAME = 'MX-H2I';
const REQUESTED_BY = 'mx-h2i-desktop';
const WIREGUARD_PROFILE_NAME = 'mx-h2i.conf';
const INTERNAL_PEER_IP = '10.88.88.88';
const LOCAL_INTERNAL_BASE_URLS = ['http://127.0.0.1:18090', 'http://localhost:18090'];
const BOOTSTRAP_DNS_RETRY_LIMIT = 3;
const BOOTSTRAP_DNS_RETRY_DELAY_MS = 350;
const DEFAULT_LOCAL_EDGE_PORT = 2053;
const DEFAULT_DOMESTIC_DNS_EDGE_PORT = 53;
const DEFAULT_INTERNAL_DNS_EDGE_PORT = 53;
const DEFAULT_INTERNAL_GATEWAY_APP_PORT = 80;
const DEFAULT_BOOTSTRAP_HOST = 'h2i.minsight-ai.com';
const LEGACY_DEFAULT_BOOTSTRAP_HOST = 'h2i.mxinfo-inc.cn';
const DEFAULT_DOMESTIC_RELAY_HOST = '116.62.51.154';
const STALE_DOMESTIC_RELAY_HOSTS = new Set(['121.43.253.179', '121.43.254.179']);
const DEFAULT_SPLIT_DNS_DOMAINS = 'mx.cn mxinfo-inc.cn internal.mx corp.mx h2i.mx';
const DEFAULT_FEISHU_CALLBACK_PORT = 17891;
const FEISHU_CALLBACK_PATH = '/oauth/feishu/callback';
const FEISHU_AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const FEISHU_OAUTH_SCOPE = 'auth.read appcenter.read network.dns.policy oversea.subscription.ensure';
const EMPLOYEE_IDENTITY_BASE_SCOPES = [
  'auth.read',
  'appcenter.read',
  'network.hdi.status',
  'network.proxy.app',
  'network.dns.policy'
];
const DARWIN_WIREGUARD_SERVICE_IDENTITY = {
  displayName: 'MX-H2I WireGuard',
  darwinLaunchDaemonLabelPrefix: 'com.qpjoy.mx-h2i.wireguard',
  darwinSupportRoot: '/Library/Application Support/QPJoy/MX-H2I',
  darwinLogDir: '/Library/Logs/QPJoy-MX-H2I',
  darwinDaemonScriptName: 'mx-h2i-wireguard-daemon.sh',
  staleDarwinLaunchDaemonLabelPrefixes: ['com.qpjoy.mx-h2i.wireguard']
};
const SYSTEM_DOMAIN_PROXY_REFRESH_MS = process.platform === 'win32' ? 5_000 : 30_000;
const WINDOWS_SYSTEM_PROXY_CONTINUATION_REFRESH_MS = 30_000;
const SYSTEM_DOMAIN_PROXY_ROUTE_REFRESH_TIMEOUT_MS = 2200;
const SYSTEM_DOMAIN_PROXY_ROUTE_WARNING_MS = 60_000;
const NETWORK_CHANGE_MONITOR_MS = 5000;
const NETWORK_CHANGE_DEBOUNCE_MS = 1800;
const DARWIN_PROXY_SIGNATURE_TIMEOUT_MS = 1200;
const DARWIN_ENDPOINT_ROUTE_PROBE_TIMEOUT_MS = 1800;
const DARWIN_ENDPOINT_ROUTE_REPAIR_COOLDOWN_MS = 20_000;
const NETWORK_DIAGNOSTIC_LOOKUP_TIMEOUT_MS = 2500;
const WIREGUARD_BACKGROUND_PROBE_DOWNGRADE_THRESHOLD = 3;
const WINDOWS_BROWSER_PROOF_SESSION_ID = randomUUID();
const DEFAULT_CONFIG = {
  productId: defaultLauncherProductId(),
  productDisplayName: defaultLauncherProductDisplayName(),
  bootstrapApiBaseUrl: defaultBootstrapApiBaseUrl(),
  internalApiBaseUrl: 'http://10.88.88.88:18090',
  domesticRelayHost: defaultDomesticRelayHost(),
  domesticRelayPort: 51280,
  sdkGatewayBaseUrl: '',
  hostResolve: defaultHostResolve(),
  bootstrapResolveMode: defaultBootstrapResolveMode(),
  bootstrapDnsServers: defaultBootstrapDnsServers(),
  splitDnsDomains: nullableString(process.env.MX_H2I_SPLIT_DNS_DOMAINS)
    || nullableString(process.env.MX_H2I_DNS_DOMAINS)
    || DEFAULT_SPLIT_DNS_DOMAINS,
  routePathPreference: normalizeRoutePathPreference(process.env.MX_H2I_ROUTE_PATH || process.env.MX_H2I_PATH_PREFERENCE || 'auto'),
  releaseChannel: 'stable',
  releaseUpdateStrategy: 'installer',
  rolloutGroup: 'staff-ring',
  useLocalEngineResources: true,
  restartAfterCodeUpdate: true
};

function currentReleaseVersion() {
  return runningElectronLauncherVersion(app.getVersion());
}

function loadAsarBootstrap() {
  try {
    return require('@qpjoy/electron-launcher/asar-bootstrap');
  } catch (error) {
    // An ASAR delivered to the original 2.1.2 base cannot use a package export
    // that did not exist yet. The build script copies the same compiled shared
    // module into the update artifact for that one-way compatibility bridge.
    try {
      return require('./vendor/asar-bootstrap.cjs');
    } catch {
      throw error;
    }
  }
}

function importInstalledPackage(specifier) {
  const packageName = '@qpjoy/electron-launcher';
  if (specifier !== packageName && !specifier.startsWith(`${packageName}/`)) {
    throw new Error(`Unsupported installed package import: ${specifier}`);
  }
  const manifestPath = require.resolve(`${packageName}/package.json`);
  const manifest = require(manifestPath);
  const exportKey = specifier === packageName ? '.' : `.${specifier.slice(packageName.length)}`;
  const declaration = manifest.exports?.[exportKey];
  const relativeEntry = typeof declaration === 'string' ? declaration : declaration?.import;
  if (!relativeEntry) throw new Error(`Installed package has no import export for ${specifier}`);
  return import(pathToFileURL(path.resolve(path.dirname(manifestPath), relativeEntry)).href);
}

let mainWindow = null;
let h2oTestWindow = null;
let h2oTestWindowLoadId = 0;
let h2oTunnelManager = null;
let runtime = null;
let tray = null;
let currentWindowMode = 'launcher';
let isTopHidden = false;
let isTopHideAnimating = false;
let topRevealTimer = null;
let lastVisibleBounds = null;
let isTopDocked = false;
let topDockHidePending = false;
let topAnimationTimer = null;
let needsRevealZoneReentry = false;
let topDockHoldUntil = 0;
let topDockLeaveStartedAt = 0;
let wireGuardRecoveryInterval = null;
let wireGuardRecoveryInFlight = null;
let wireGuardConnectInFlight = false;
const wireGuardConnectOperations = new Set();
let wireGuardDisconnectInFlight = false;
let networkMutationEpoch = 0;
let windowBoundsSaveTimer = null;
let windowBoundsTrackingSuppressed = false;
let activeWindowDrag = null;
let windowDragSizeBatchTimer = null;
let lastWindowDragId = 0;
let lastWireGuardRecoveryFailureAt = 0;
let wireGuardBackgroundProbeFailures = 0;
const wireGuardRecoveryTimers = [];
let networkChangeMonitorInterval = null;
let networkChangeDebounceTimer = null;
let networkChangeInFlight = false;
let lastNetworkSignature = null;
let systemDomainProxyManager = null;
let systemDomainProxyRefreshInterval = null;
let systemDomainProxyRefreshInFlight = false;
let systemDomainProxyEnsureInFlight = null;
let h2oManagedHydrateInFlight = null;
let lastSystemDomainProxySignature = null;
let lastSystemDomainProxyPolicySignature = null;
let lastSystemDomainProxyAuthorizationCanceledSignature = null;
let lastWindowsSystemProxyTakeoverSignature = null;
let pendingWindowsSystemProxyTakeoverSignature = null;
let lastWindowsSystemProxyContinuationRefreshAt = 0;
let lastSystemPacReverseProxyRoutes = [];
let lastSystemPacReverseProxyRoutesWarningAt = 0;
let lastNetworkEnvironmentSignature = null;
let lastDarwinEndpointRouteRepairAt = 0;
let releaseUpdateCheckInFlight = null;
let postConnectUpdateTimer = null;
let diagnosticLogQueue = Promise.resolve();
let diagnosticLogBytes = null;
let diagnosticLogDirReady = false;
let recentDiagnosticLogs = [];
const privateJsonFileWriteQueues = new Map();
let appShutdownInFlight = null;
let appShutdownRequested = false;
let appShutdownCompleted = false;
let appRelaunchRequested = false;
let pendingFeishuLogin = null;

const WINDOWS_SPLIT_DNS_DIAGNOSTIC_HOST_MISSING = 'split-dns-diagnostic-host-missing';

const TOP_DOCK_Y = 0;
const TOP_REVEAL_ZONE = 18;
const TOP_ANIMATION_STEPS = 24;
const TOP_REVEAL_HOLD_MS = 900;
const TOP_LEAVE_HIDE_MS = 180;
const WINDOW_BOUNDS_SAVE_DELAY_MS = 420;
const WINDOW_DRAG_SIZE_BATCH_MS = 80;
const H2O_PROXY_START_TIMEOUT_MS = 12_000;
const H2O_PORT_RELEASE_TIMEOUT_MS = 8_000;
// 订阅里 MATCH 指向的那个 select 组；Internal 渲染订阅时用的是同一个名字。
const H2O_OVERSEA_SELECT_GROUP = 'Oversea';
const H2O_MANAGED_SUBSCRIPTION_REFRESH_MS = 30_000;

app.setAppUserModelId(APP_ID);

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  showMainWindow();
});

if (gotSingleInstanceLock) {
  app.whenReady().then(async () => {
    runtime = await loadRuntime();
    if (process.platform === 'darwin' && app.dock) {
      app.dock.setIcon(productIconPath());
    }
    queueDiagnosticLog('info', 'app.started', 'MX-H2I main process started.', {
      version: currentReleaseVersion(),
      baseVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      packaged: app.isPackaged
    });
    await initializeSystemDomainProxy();
    const credentialStorageRecovery = await reconcileCredentialStorageFailureAfterStartup();
    if (credentialStorageRecovery.blocked !== true) {
      await reconcileExistingWireGuardAfterStartup();
      await reconcilePendingNetworkHandoverAfterStartup();
      await refreshSystemDomainProxyForRuntime('app-startup');
      startSystemDomainProxyRefreshWatcher();
    }
    scheduleNetworkEnvironmentDiagnostics('app-startup', {
      lookupTimeoutMs: NETWORK_DIAGNOSTIC_LOOKUP_TIMEOUT_MS
    });
    registerIpc();
    createTray();
    createMainWindow();
    void restoreH2oRuntimeAfterStartup().catch((err) => {
      console.warn('[mx-h2i] H2O startup restore failed:', errorMessage(err));
      queueDiagnosticError('startup.h2o-restore', err);
    });
    void reportInstallCompletionAndAdoptPendingUpdates().catch((err) => {
      console.warn('[mx-h2i] startup update bookkeeping failed:', errorMessage(err));
      queueDiagnosticError('startup.update-bookkeeping', err);
    });
    startTopRevealWatcher();
    if (credentialStorageRecovery.blocked !== true) {
      startWireGuardRecoveryWatcher();
    }
    startNetworkChangeWatcher();
    confirmElectronLauncherAsarLaunch({
      baseDir: app.getPath('userData'),
      componentId: PRODUCT_ID,
      activePath: process.env.MX_LAUNCHER_ACTIVE_ASAR || process.env.MX_H2I_ACTIVE_ASAR
    });
  });
}

// Closes the installer loop and promotes staged npm-package artifacts: on the
// first start after a version change, report installer-completed to Release
// Center; pending launcher-package pointers written by the update executor
// switch to current so this run resolves the new build output.
async function reportInstallCompletionAndAdoptPendingUpdates() {
  const executorMod = await importInstalledPackage('@qpjoy/electron-launcher/release-update-executor');
  const baseDir = app.getPath('userData');
  await repairStagedLauncherPackagePointerFromRuntime('startup');
  const adopted = await executorMod.adoptPendingElectronLauncherPackages(baseDir);
  for (const pointer of adopted) {
    pushAppLog('appcenter', 'info', `Launcher package update adopted on start: ${pointer.version} (${pointer.path}).`);
  }
  const baseUrl = appCenterCatalogBaseUrl();
  if (!baseUrl) return;
  const mod = await importInstalledPackage('@qpjoy/electron-launcher');
  const updater = mod.createElectronLauncherReleaseUpdater({
    baseUrl,
    fetchImpl: launcherFetchForBootstrap(runtime?.config?.bootstrapResolveMode),
    reportInstallId: runtime?.installation?.installId
  });
  const completion = await executorMod.reportElectronLauncherInstallCompletionIfUpgraded({
    updater,
    baseDir,
    currentVersion: app.getVersion(),
    installId: runtime?.installation?.installId
  });
  if (completion.upgraded) {
    pushAppLog('appcenter', 'info', `Installer completion reported: ${completion.from} -> ${completion.to}.`);
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (!gotSingleInstanceLock || (!runtime && !systemDomainProxyManager)) {
    appShutdownCompleted = true;
    return;
  }
  if (appShutdownCompleted) return;
  event.preventDefault();
  beginApplicationShutdown();
});

function beginApplicationShutdown() {
  if (appShutdownCompleted || appShutdownInFlight) return;
  appShutdownRequested = true;
  networkMutationEpoch += 1;
  appShutdownInFlight = shutdownApplication();
}

async function shutdownApplication() {
  queueDiagnosticLog('info', 'app.before-quit', 'MX-H2I is shutting down.', {
    relaunch: appRelaunchRequested
  });
  clearPendingFeishuLogin('app-shutdown');
  stopNetworkChangeWatcher();
  stopWireGuardRecoveryWatcher();
  stopSystemDomainProxyRefreshWatcher();
  if (process.platform === 'win32') {
    wireGuardDisconnectInFlight = true;
    let proxyRestored = false;
    let wireGuard = null;
    try {
      // These mutations are intentionally awaited to settlement. Promise
      // timeouts do not cancel reg.exe/PowerShell/UAC work and would allow a
      // late restore to race the rollback watcher after shutdown is canceled.
      await drainWireGuardConnectOperations();
      await drainWireGuardRecoveryOperation();
      await drainSystemDomainProxyApply('app-before-quit', 0);
      await disableSystemDomainProxyForRuntimeStrict(
        'app-before-quit',
        2,
        { keepLocalEdgeAlive: true }
      );
      proxyRestored = true;
      wireGuard = await stopWireGuardForRuntime();
      if (wireGuard?.cleanupReady !== true) {
        const err = new Error(
          wireGuard?.message
          || wireGuard?.windowsNrpt?.error
          || 'Windows WireGuard/NRPT cleanup was not verified.'
        );
        err.wireGuard = wireGuard;
        throw err;
      }
      await disableSystemDomainProxyForRuntimeStrict('app-before-quit-finalize');
      const standaloneOwnership = await releaseStandaloneOwnershipForRuntime('app-before-quit');
      if (standaloneOwnership?.error) {
        const err = new Error(`Standalone ownership release failed: ${standaloneOwnership.error}`);
        err.wireGuard = wireGuard;
        err.standaloneOwnership = standaloneOwnership;
        throw err;
      }
      await closeSystemDomainProxy();
    } catch (err) {
      queueDiagnosticError(
        proxyRestored
          ? 'wireguard.shutdown-cleanup-failed'
          : 'system-domain-proxy.shutdown-restore-failed',
        err
      );
      appShutdownRequested = false;
      appShutdownCompleted = false;
      wireGuardDisconnectInFlight = false;
      let browserRollback = null;
      const cleanupWireGuard = err?.wireGuard || wireGuard;
      if (
        proxyRestored
        && wireGuardRuntimeIsActive(cleanupWireGuard)
      ) {
        browserRollback = await attachWindowsBrowserAccessProof(
          await ensureSystemDomainProxyForRuntimeOnce('manual-shutdown-rollback'),
          'manual-shutdown-rollback'
        ).catch((rollbackErr) => ({
          browserReady: false,
          error: errorMessage(rollbackErr)
        }));
      }
      const wireGuardCleanupPending = proxyRestored
        && !wireGuardRuntimeIsActive(cleanupWireGuard);
      if (wireGuardCleanupPending) {
        const connection = runtime?.connection || idleConnection();
        const routePlan = normalizeRoutePlan(connection.routePlan);
        const shutdownCleanup = {
          ok: false,
          cleanupReady: cleanupWireGuard?.cleanupReady === true,
          localEdgeClosePending: cleanupWireGuard?.cleanupReady === true
            && !err?.standaloneOwnership?.error,
          ownershipReleasePending: Boolean(err?.standaloneOwnership?.error),
          stage: err?.standaloneOwnership?.error
            ? 'standalone-ownership-release'
            : cleanupWireGuard?.cleanupReady === true
              ? 'local-edge-finalize'
              : 'wireguard-nrpt-stop',
          message: errorMessage(err),
          wireGuard: cleanupWireGuard,
          standaloneOwnership: err?.standaloneOwnership || null,
          updatedAt: nowIso()
        };
        runtime.connection = isRetainedConnectionState(connection.state) && routePlan
          ? {
              ...connection,
              state: 'lease-only',
              wireGuard: summarizeWireGuardStatus(cleanupWireGuard?.status, connection),
              health: {
                ...normalizeHealth(connection.health, leasedHealth()),
                wireGuard: 'stale',
                internalApi: 'idle',
                splitDns: 'stale'
              },
              diagnostics: {
                ...(connection.diagnostics || {}),
                shutdownCleanup,
                updatedAt: nowIso()
              }
            }
          : {
              ...idleConnection(),
              mode: connection.mode === 'employee' ? 'employee' : 'guest',
              diagnostics: {
                ...(connection.diagnostics || {}),
                shutdownCleanup,
                updatedAt: nowIso()
              }
            };
      }
      runtime.feedback = {
        tone: 'warning',
        message: proxyRestored
          ? wireGuardCleanupPending
            ? `应用未退出：WireGuard 已停止或状态无法确认，Windows 服务/NRPT、local edge 或 ownership 收尾尚未完成；PAC 保持已恢复，不会指向 2053。请执行“修复网络”后再退出。${errorMessage(err)}`
            : browserRollback?.browserAccess?.ready === true
            ? `应用未退出：Windows WireGuard/NRPT 尚未确认清理，已恢复浏览器 Internal 路径。${errorMessage(err)}`
            : `应用未退出：Windows WireGuard/NRPT 尚未确认清理；浏览器 PAC 恢复状态也未确认。${browserRollback?.error || browserRollback?.browserAccess?.error || errorMessage(err)}`
          : `应用未退出：Windows 系统代理恢复失败，本机 2053 继续运行，避免留下失效 PAC。${errorMessage(err)}`
      };
      touchRuntime('windows shutdown canceled by network cleanup');
      await saveAndBroadcast().catch(() => undefined);
      startSystemDomainProxyRefreshWatcher();
      startWireGuardRecoveryWatcher();
      startNetworkChangeWatcher();
      appRelaunchRequested = false;
      appShutdownInFlight = null;
      return;
    }
  } else {
    await withTimeout(
      closeSystemDomainProxy(),
      3000,
      'Timed out closing the local system proxy during shutdown.',
      'MX_SYSTEM_PROXY_SHUTDOWN_CLOSE_TIMEOUT'
    ).catch((err) => {
      queueDiagnosticError('system-domain-proxy.shutdown-close-failed', err);
    });
  }
  await withTimeout(
    diagnosticLogQueue,
    1500,
    'Timed out flushing the diagnostic log during shutdown.',
    'MX_DIAGNOSTIC_SHUTDOWN_TIMEOUT'
  ).catch(() => undefined);
  appShutdownCompleted = true;
  wireGuardDisconnectInFlight = false;
  if (appRelaunchRequested) app.relaunch();
  app.exit(0);
}

app.on('render-process-gone', (_event, _contents, details) => {
  queueDiagnosticLog('error', 'process.renderer-gone', 'Renderer process exited unexpectedly.', details);
});

app.on('child-process-gone', (_event, details) => {
  queueDiagnosticLog('error', 'process.child-gone', 'Electron child process exited unexpectedly.', details);
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
    return;
  }
  showMainWindow();
});

function createMainWindow() {
  currentWindowMode = 'launcher';
  const initialBounds = windowBoundsForMode('launcher');
  const initialMinimum = windowMinimumSizeForMode('launcher', initialBounds);
  mainWindow = new BrowserWindow({
    x: initialBounds.x,
    y: initialBounds.y,
    width: initialBounds.width,
    height: initialBounds.height,
    minWidth: initialMinimum.width,
    minHeight: initialMinimum.height,
    resizable: false,
    title: 'MX-H2I',
    icon: productIconPath(),
    backgroundColor: '#242734',
    frame: false,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (target.protocol === 'http:' || target.protocol === 'https:') void shell.openExternal(target.toString());
    } catch {
      // Release notes may contain malformed links; keep them inside the denied popup.
    }
    return { action: 'deny' };
  });
  if (process.platform === 'win32') {
    // Windows does not emit app.before-quit during logoff/shutdown. Delay the
    // session end until the same PAC -> WG/NRPT -> local-edge teardown settles.
    mainWindow.on('query-session-end', (event) => {
      if (appShutdownCompleted) return;
      event.preventDefault();
      beginApplicationShutdown();
    });
  }
  mainWindow.once('closed', () => {
    mainWindow = null;
  });
  attachWindowBoundsTracking();
  rememberWindowBoundsForMode('launcher', mainWindow.getBounds());
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

function registerIpc() {
  ipcMain.handle('mx-h2i:get-state', () => visibleRuntime());
  ipcMain.handle('mx-h2i:save-config', async (_event, input) => {
    runtime.config = normalizeConfig(input);
    runtime.launcherContract = await launcherContract(runtime.config);
    touchRuntime('config saved');
    await saveAndBroadcast();
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:connect-guest', async () => {
    const connectOperation = beginWireGuardConnectOperation();
    const lifecycleEpoch = networkMutationEpoch;
    const transitionStartedAt = Date.now();
    const transitionId = makeRequestId('visit-connect');
    let retainedConnectionWasProbed = false;
    try {
      assertNetworkTransitionCurrent(lifecycleEpoch);
    if (runtime.connection?.mode === 'employee' && runtime.connection?.state === 'connecting') {
      runtime.feedback = {
        tone: 'info',
        message: '员工网络正在连接；本次访客连接请求已忽略，不会中断员工网络。'
      };
      touchRuntime('visit connect skipped: staff active');
      await publishNetworkModeEvent('visit:connect', 'skipped', {
        reason: 'staff-active',
        transitionId
      });
      await saveAndBroadcast();
      return visibleRuntime();
    }
    if (runtime.connection?.mode === 'employee' && runtime.connection?.state === 'connected') {
      const staffProbe = await probeConnectedModeBeforeTransition('employee', 'visit-connect-staff-guard');
      retainedConnectionWasProbed = true;
      if (staffProbe.superseded) return visibleRuntime();
      const preserveStaffConnection = staffProbe.ready || staffProbe.result?.wireGuard?.active === true;
      if (preserveStaffConnection) {
        runtime.feedback = {
          tone: 'info',
          message: staffProbe.ready
            ? '员工网络已经连接；本次访客连接请求已忽略，不会断开或重启员工网络。'
            : '员工 WireGuard 仍在运行；为避免中断员工网络，本次访客连接请求已忽略。'
        };
        touchRuntime('visit connect skipped: staff active');
        await publishNetworkModeEvent('visit:connect', 'skipped', {
          reason: 'staff-active',
          transitionId
        });
        await saveAndBroadcast();
        return visibleRuntime();
      }
    }
    if (runtime.connection?.mode === 'guest' && runtime.connection?.state === 'connecting') {
      runtime.feedback = {
        tone: 'info',
        message: '访客网络正在连接；本次重复连接请求已忽略。'
      };
      touchRuntime('visit connect skipped: visit active');
      await publishNetworkModeEvent('visit:connect', 'skipped', {
        reason: 'visit-active',
        transitionId
      });
      await saveAndBroadcast();
      return visibleRuntime();
    }
    if (runtime.connection?.mode === 'guest' && runtime.connection?.state === 'connected') {
      const guestProbe = await probeConnectedModeBeforeTransition('guest', 'visit-connect-guest-guard');
      retainedConnectionWasProbed = guestProbe.ready;
      if (guestProbe.superseded) return visibleRuntime();
      if (guestProbe.ready) {
        runtime.feedback = {
          tone: 'info',
          message: '访客网络已经连接；本次重复连接请求已忽略。'
        };
        touchRuntime('visit connect skipped: visit active');
        await publishNetworkModeEvent('visit:connect', 'skipped', {
          reason: 'visit-active',
          transitionId
        });
        await saveAndBroadcast();
        return visibleRuntime();
      }
    }
    const guestEndpointRouteRepair = await repairDarwinEndpointRouteBeforeBootstrap('guest-pre-bootstrap');
    if (guestEndpointRouteRepair?.stale === true && guestEndpointRouteRepair?.repaired !== true) {
      await saveAndBroadcast();
      return visibleRuntime();
    }
    let retainedRecovery = null;
    if (!retainedConnectionWasProbed && shouldAttemptRetainedWireGuardPreBootstrap(runtime.connection)) {
      retainedRecovery = await recoverRetainedWireGuardBeforeBootstrap('guest-pre-bootstrap', {
        allowPrivileged: shouldAllowPrivilegedPreBootstrapRecovery()
      });
    }
    if (retainedRecovery?.authorizationCanceled === true) {
      runtime.feedback = {
        tone: 'warning',
        message: '已取消 WireGuard 修复授权；MX-H2I 已保留当前网络状态，不会再次弹窗或继续重装隧道。'
      };
      touchRuntime('visit connect authorization canceled during retained repair');
      await publishNetworkModeEvent('visit:connect', 'failed', {
        reason: 'authorization-canceled',
        transitionId
      });
      await saveAndBroadcast();
      return visibleRuntime();
    }
    let recoveredGuestProbe = null;
    if (
      runtime.connection?.mode === 'guest'
      && shouldRecoverWireGuardConnection(runtime.connection)
    ) {
      recoveredGuestProbe = await probeConnectedModeBeforeTransition(
        'guest',
        'visit-connect-recovered-guard',
        { allowRecoverableState: true }
      );
      if (recoveredGuestProbe.superseded) return visibleRuntime();
    }
    const recoveredGuestDecision = retainedGuestRecoveryDecision({
      ready: recoveredGuestProbe?.ready === true,
      liveWireGuardActive: recoveredGuestProbe?.result?.wireGuard?.active === true
    });
    if (runtime.connection?.mode === 'guest' && recoveredGuestDecision === 'recovered') {
      runtime.feedback = {
        tone: 'success',
        message: '访客网络已通过原位修复恢复；本次重新连接没有卸载或重装正在运行的 WireGuard 服务。'
      };
      touchRuntime('visit connect recovered retained tunnel');
      await publishNetworkModeEvent('visit:connect', 'connected', {
        leaseIp: runtime.connection.localIp,
        reason: 'retained-tunnel-recovered',
        transitionId
      });
      await saveAndBroadcast();
      return visibleRuntime();
    }
    if (runtime.connection?.mode === 'guest' && recoveredGuestDecision === 'preserve') {
      const recoveryMessage = nullableString(retainedRecovery?.message)
        || nullableString(runtime.feedback?.message)
        || 'Windows split DNS 原位修复尚未通过。';
      runtime.feedback = {
        tone: 'warning',
        message: `访客 WireGuard 仍在运行，已停止破坏性重装，避免把可用隧道卸掉。${recoveryMessage}`
      };
      touchRuntime('visit connect preserved active tunnel after repair failure');
      await publishNetworkModeEvent('visit:connect', 'skipped', {
        reason: 'retained-tunnel-repair-pending',
        transitionId
      });
      await saveAndBroadcast();
      return visibleRuntime();
    }
    if (
      runtime.connection?.mode === 'employee'
      && (
        retainedRecovery?.ready === true
        || connectionHasReadyNetworkProof(runtime.connection)
        || runtime.connection?.wireGuard?.active === true
      )
    ) {
      runtime.feedback = {
        tone: 'info',
        message: '员工网络已恢复并且 ready；本次访客连接已忽略，不会中断员工网络。'
      };
      touchRuntime('visit connect skipped: recovered staff active');
      await publishNetworkModeEvent('visit:connect', 'skipped', {
        reason: 'staff-active',
        transitionId
      });
      await saveAndBroadcast();
      return visibleRuntime();
    }
    assertNetworkTransitionCurrent(lifecycleEpoch);
    setConnecting('guest');
    await publishNetworkModeEvent('visit:connect', 'connecting', { transitionId });
    await saveAndBroadcast();
    assertNetworkTransitionCurrent(lifecycleEpoch);
    scheduleNetworkEnvironmentDiagnostics('guest-pre-connect', {
      phase: 'bootstrap',
      persist: false,
      lookupTimeoutMs: NETWORK_DIAGNOSTIC_LOOKUP_TIMEOUT_MS
    });
    try {
      const session = await connectLauncherNetworkWithLocalIdentityRepair({
        identityKind: 'anonymous',
        requestTag: 'guest'
      });
      assertNetworkTransitionCurrent(lifecycleEpoch);
      await applyNetworkSession(session, {
        mode: 'guest',
        subject: `anonymous:${session.lease.installId}`,
        routePolicy: 'guest limited',
        identity: {
          kind: 'anonymous',
          displayName: 'Visitor',
          account: null,
          scopes: ['auth.read', 'network.hdi.status', 'network.proxy.app']
        },
        auth: null,
        feedback: '访客 lease 已由 Internal 下发，并保留 180 天未续租回收。',
        lifecycleEpoch,
        transitionId,
        transitionStartedAt
      });
    } catch (err) {
      if (isSupersededNetworkTransitionError(err)) return visibleRuntime();
      await applyConnectionError('访客连接失败', err);
      await publishNetworkModeEvent('visit:connect', 'failed', {
        reason: errorMessage(err),
        transitionId
      });
    }
    await saveAndBroadcast();
    return visibleRuntime();
    } catch (err) {
      if (isSupersededNetworkTransitionError(err)) return visibleRuntime();
      throw err;
    } finally {
      connectOperation.finish();
    }
  });
  ipcMain.handle('mx-h2i:login-employee', async (_event, input) => {
    const account = typeof input?.account === 'string' ? input.account.trim() : '';
    const password = typeof input?.password === 'string' ? input.password : '';
    if (!account || !password) {
      runtime.feedback = {
        tone: 'danger',
        message: '请输入员工账号和密码。'
      };
      return visibleRuntime();
    }
    if (pendingFeishuLogin) {
      runtime.feedback = {
        tone: 'warning',
        message: '飞书登录正在进行；请先完成或取消飞书登录，再使用员工账号密码。'
      };
      await saveAndBroadcast();
      return visibleRuntime();
    }
    return promoteEmployeeConnection({
      provider: 'password',
      account,
      requestTag: 'employee',
      authenticate: (baseUrl, bootstrap) => authenticateUserViaGateway(baseUrl, account, password, {
        bootstrapResolveMode: bootstrap.resolveMode
      })
    });
  });
  ipcMain.handle('mx-h2i:start-feishu-login', async () => {
    await startFeishuLogin();
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:cancel-feishu-login', async () => {
    await cancelFeishuLogin('user-canceled');
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:disconnect', async () => {
    if (wireGuardDisconnectInFlight) return visibleRuntime();
    clearPendingFeishuLogin('network-disconnect');
    wireGuardDisconnectInFlight = true;
    networkMutationEpoch += 1;
    let disconnectedMode = runtime.connection?.mode === 'employee' ? 'employee' : 'guest';
    let disconnectedIp = nullableString(runtime.connection?.localIp);
    let retainedConnection = runtime.connection;
    let retainedAuth = runtime.auth;
    try {
      await drainWireGuardConnectOperations();
      await drainWireGuardRecoveryOperation();
      disconnectedMode = runtime.connection?.mode === 'employee' ? 'employee' : 'guest';
      disconnectedIp = nullableString(runtime.connection?.localIp);
      retainedConnection = runtime.connection;
      retainedAuth = runtime.auth;
      if (postConnectUpdateTimer) {
        clearTimeout(postConnectUpdateTimer);
        postConnectUpdateTimer = null;
      }
      try {
        await drainSystemDomainProxyApply('disconnect');
      } catch (err) {
        runtime.connection = retainedConnection;
        runtime.auth = retainedAuth;
        runtime.feedback = {
          tone: 'warning',
          message: `断开尚未开始：等待正在执行的 Windows PAC 切换超时，现有连接保持不变。${errorMessage(err)}`
        };
        touchRuntime('disconnect blocked by active system proxy apply');
        await saveAndBroadcast();
        return visibleRuntime();
      }
      let windowsSystemDomainProxy = null;
      if (process.platform === 'win32') {
        try {
          // Remove the browser interception while WireGuard is still usable.
          // If restore fails, keep the connection and 2053 alive.
          windowsSystemDomainProxy = await disableSystemDomainProxyForRuntimeStrict(
            'disconnect-before-wireguard-stop',
            2,
            { keepLocalEdgeAlive: true }
          );
        } catch (err) {
          runtime.connection = retainedConnection;
          runtime.auth = retainedAuth;
          runtime.feedback = {
            tone: 'warning',
            message: `断开未执行：Windows 系统代理恢复失败，WireGuard 和本机 2053 保持运行，避免留下失效 PAC。${errorMessage(err)}`
          };
          queueDiagnosticError('system-domain-proxy.disconnect-restore-failed', err);
          touchRuntime('disconnect blocked by system proxy restore failure');
          await saveAndBroadcast();
          return visibleRuntime();
        }
      }
      const systemDomainRestoreScript = systemDomainProxyManager?.darwinRestoreScript?.() || null;
      const wireGuard = await stopWireGuardForRuntime({
        darwinExtraUninstallShell: systemDomainRestoreScript
      });
      const authorizationCanceled = wireGuard?.authorizationCanceled === true
        || isUserAuthorizationCanceledError(wireGuard);
      const wireGuardStillActive = wireGuardRuntimeIsActive(wireGuard);
      const wireGuardStopUnknown = process.platform !== 'win32'
        && wireGuard?.ok === false
        && typeof wireGuard?.status?.active !== 'boolean'
        && !wireGuardStillActive;

      if (authorizationCanceled || wireGuardStillActive || wireGuardStopUnknown) {
        let browserRollback = null;
        if (process.platform === 'win32' && windowsSystemDomainProxy) {
          browserRollback = await attachWindowsBrowserAccessProof(
            await ensureSystemDomainProxyForRuntimeOnce('manual-disconnect-rollback'),
            'manual-disconnect-rollback'
          );
        }
        if (authorizationCanceled && lastSystemDomainProxyPolicySignature) {
          lastSystemDomainProxyAuthorizationCanceledSignature = lastSystemDomainProxyPolicySignature;
        }
        runtime.connection = retainedConnection;
        runtime.auth = retainedAuth;
        const reason = authorizationCanceled
          ? 'authorization-canceled'
          : wireGuardStillActive
            ? 'wireguard-still-active'
            : 'wireguard-stop-unverified';
        const detail = wireGuard?.message || wireGuard?.error || '无法确认 WireGuard 已停止';
        runtime.feedback = {
          tone: 'warning',
          message: browserRollback?.browserAccess?.ready !== true && process.platform === 'win32'
            ? `断开未完成，WireGuard 仍在，但 Windows 浏览器 PAC 恢复也失败：${browserRollback?.browserAccess?.error || browserRollback?.error || detail}`
            : authorizationCanceled
              ? '已取消断开；WireGuard、PAC、split DNS 和员工/访客连接均保持原状态。'
            : wireGuardStillActive
              ? `断开未完成，检测到 WireGuard 仍在运行：${detail}`
              : `断开未完成，无法确认 WireGuard 已停止：${detail}`
        };
        queueDiagnosticLog('warning', `wireguard.disconnect-${reason}`, detail, {
          mode: disconnectedMode,
          leaseIp: disconnectedIp,
          status: wireGuard?.status,
          launchDaemon: wireGuard?.launchDaemon
        });
        touchRuntime(`disconnect failed; connection retained: ${reason}`);
        await publishNetworkModeEvent(
          disconnectedMode === 'employee' ? 'staff:disconnect' : 'visit:disconnect',
          'failed',
          { leaseIp: disconnectedIp, reason }
        );
        await saveAndBroadcast();
        return visibleRuntime();
      }

      if (process.platform === 'win32' && wireGuard?.cleanupReady !== true) {
        const detail = wireGuard?.message
          || wireGuard?.windowsNrpt?.error
          || 'Windows WireGuard/NRPT cleanup was not verified.';
        runtime.connection = {
          ...retainedConnection,
          state: 'lease-only',
          wireGuard: summarizeWireGuardStatus(wireGuard?.status, retainedConnection),
          health: {
            ...normalizeHealth(retainedConnection?.health, leasedHealth()),
            wireGuard: 'stale',
            internalApi: 'idle',
            splitDns: 'stale'
          },
          diagnostics: {
            ...(retainedConnection?.diagnostics || {}),
            disconnectCleanup: {
              ok: false,
              cleanupReady: false,
              message: detail,
              wireGuard,
              updatedAt: nowIso()
            },
            updatedAt: nowIso()
          }
        };
        runtime.auth = retainedAuth;
        runtime.feedback = {
          tone: 'warning',
          message: `WireGuard 已停止且浏览器 PAC 已恢复，但 Windows 服务/NRPT 清理尚未确认；未发布“已断开”，也未释放 ownership。${detail} 请再次点击“清理旧连接”或在高级选项执行“修复网络”。`
        };
        queueDiagnosticLog('warning', 'wireguard.disconnect-cleanup-required', detail, {
          mode: disconnectedMode,
          leaseIp: disconnectedIp,
          status: wireGuard?.status,
          windowsNrpt: wireGuard?.windowsNrpt
        });
        touchRuntime('disconnect requires Windows cleanup retry');
        await publishNetworkModeEvent(
          disconnectedMode === 'employee' ? 'staff:disconnect' : 'visit:disconnect',
          'failed',
          { leaseIp: disconnectedIp, reason: 'windows-cleanup-unverified' }
        );
        await saveAndBroadcast();
        return visibleRuntime();
      }

      if (process.platform === 'win32') {
        try {
          windowsSystemDomainProxy = await disableSystemDomainProxyForRuntimeStrict(
            'disconnect-after-wireguard-cleanup'
          );
        } catch (err) {
          const detail = errorMessage(err);
          runtime.connection = {
            ...retainedConnection,
            state: 'lease-only',
            wireGuard: summarizeWireGuardStatus(wireGuard?.status, retainedConnection),
            health: {
              ...normalizeHealth(retainedConnection?.health, leasedHealth()),
              wireGuard: 'stale',
              internalApi: 'idle',
              splitDns: 'stale'
            },
            diagnostics: {
              ...(retainedConnection?.diagnostics || {}),
              disconnectCleanup: {
                ok: false,
                cleanupReady: true,
                localEdgeClosePending: true,
                message: detail,
                wireGuard,
                updatedAt: nowIso()
              },
              updatedAt: nowIso()
            }
          };
          runtime.auth = retainedAuth;
          runtime.feedback = {
            tone: 'warning',
            message: `WireGuard/NRPT 已清理且浏览器 PAC 已恢复，但本机 2053/state 收尾未确认；未发布“已断开”。${detail} 请再次点击“清理旧连接”或执行“修复网络”。`
          };
          queueDiagnosticError('system-domain-proxy.disconnect-finalize-failed', err, {
            mode: disconnectedMode,
            leaseIp: disconnectedIp,
            wireGuard
          });
          touchRuntime('disconnect requires local edge cleanup retry');
          await publishNetworkModeEvent(
            disconnectedMode === 'employee' ? 'staff:disconnect' : 'visit:disconnect',
            'failed',
            { leaseIp: disconnectedIp, reason: 'windows-local-edge-cleanup-unverified' }
          );
          await saveAndBroadcast();
          return visibleRuntime();
        }
      }

      const standaloneOwnership = await releaseStandaloneOwnershipForRuntime('disconnect');
      const systemDomainProxy = process.platform === 'win32'
        ? windowsSystemDomainProxy
        : systemDomainRestoreScript && wireGuard?.launchDaemon
          ? await completeExternalSystemDomainProxyRestore('disconnect-combined')
          : await disableSystemDomainProxyForRuntime('disconnect');
      if (process.platform === 'win32' && standaloneOwnership?.error) {
        runtime.connection = {
          ...retainedConnection,
          state: 'lease-only',
          wireGuard: summarizeWireGuardStatus(wireGuard?.status, retainedConnection),
          health: {
            ...normalizeHealth(retainedConnection?.health, leasedHealth()),
            wireGuard: 'stale',
            internalApi: 'idle',
            splitDns: 'stale'
          },
          diagnostics: {
            ...(retainedConnection?.diagnostics || {}),
            disconnectCleanup: {
              ok: false,
              cleanupReady: true,
              localEdgeClosePending: false,
              ownershipReleasePending: true,
              stage: 'standalone-ownership-release',
              message: standaloneOwnership.error,
              wireGuard,
              systemDomainProxy,
              standaloneOwnership,
              updatedAt: nowIso()
            },
            updatedAt: nowIso()
          }
        };
        runtime.auth = retainedAuth;
        runtime.feedback = {
          tone: 'warning',
          message: `WireGuard、NRPT、浏览器 PAC 和本机 2053 已清理，但 standalone ownership 释放失败；未发布“已断开”。${standaloneOwnership.error} 请再次点击“清理旧连接”或执行“修复网络”。`
        };
        queueDiagnosticLog(
          'warning',
          'standalone-ownership.disconnect-release-failed',
          standaloneOwnership.error,
          { mode: disconnectedMode, leaseIp: disconnectedIp, wireGuard, systemDomainProxy, standaloneOwnership }
        );
        touchRuntime('disconnect requires standalone ownership cleanup retry');
        await publishNetworkModeEvent(
          disconnectedMode === 'employee' ? 'staff:disconnect' : 'visit:disconnect',
          'failed',
          { leaseIp: disconnectedIp, reason: 'standalone-ownership-release-unverified' }
        );
        await saveAndBroadcast();
        return visibleRuntime();
      }
      runtime.connection = idleConnection();
      runtime.auth = null;
      runtime.feedback = {
        tone: wireGuard?.ok === false || systemDomainProxy?.error ? 'warning' : 'info',
        message: wireGuard?.ok === false
          ? `WireGuard 已停止，但系统网络清理未全部确认：${wireGuard.message || wireGuard.error || 'unknown'}。请在高级选项中执行网络修复。`
          : systemDomainProxy?.error
            ? `已断开 MX-H2I standalone channel；系统 PAC 恢复失败：${systemDomainProxy.error}`
            : standaloneOwnership?.error
              ? `已断开 MX-H2I standalone channel；本机 ownership registry 释放失败：${standaloneOwnership.error}`
              : '已断开 MX-H2I standalone channel、系统 PAC 和客户端 WireGuard；IP lease 会保留并在下次连接时续租。'
      };
      queueDiagnosticLog(
        wireGuard?.ok === false || systemDomainProxy?.error ? 'warning' : 'info',
        'wireguard.disconnected',
        runtime.feedback.message,
        { mode: disconnectedMode, leaseIp: disconnectedIp, wireGuard, systemDomainProxy, standaloneOwnership }
      );
      touchRuntime('disconnected');
      await publishNetworkModeEvent(
        disconnectedMode === 'employee' ? 'staff:disconnect' : 'visit:disconnect',
        'disconnected',
        { leaseIp: disconnectedIp, reason: wireGuard?.ok === false ? 'manual-disconnect-partial-cleanup' : 'manual-disconnect' }
      );
      await saveAndBroadcast();
      return visibleRuntime();
    } finally {
      wireGuardDisconnectInFlight = false;
    }
  });
  ipcMain.handle('mx-h2i:reset-local-network-identity', async () => {
    if (wireGuardDisconnectInFlight) return visibleRuntime();
    clearPendingFeishuLogin('local-identity-reset');
    networkMutationEpoch += 1;
    const previousMode = runtime.connection?.mode === 'employee' ? 'employee' : 'guest';
    const previousIp = nullableString(runtime.connection?.localIp);
    try {
      await drainWireGuardConnectOperations();
      await drainWireGuardRecoveryOperation();
      const standaloneOwnership = await releaseStandaloneOwnershipForRuntime('local-identity-reset');
      const systemDomainProxy = await disableSystemDomainProxyForRuntime('local-identity-reset');
      const rotation = await rotateLocalLauncherIdentity('manual-clear-old-connection', {
        diagnostics: {
          standaloneOwnership,
          systemDomainProxy
        }
      });
      runtime.feedback = {
        tone: 'success',
        message: '已清理旧连接，并轮换本机 installation、device 和 WireGuard 密钥；请重新连接以申请新的租约。'
      };
      queueDiagnosticLog('info', 'network.local-identity-reset', runtime.feedback.message, {
        previousMode,
        previousIp,
        ...rotation
      });
      touchRuntime('local network identity reset');
      await publishNetworkModeEvent(
        previousMode === 'employee' ? 'staff:disconnect' : 'visit:disconnect',
        'disconnected',
        { leaseIp: previousIp, reason: 'local-identity-reset' }
      );
    } catch (err) {
      runtime.feedback = {
        tone: 'danger',
        message: `清理旧连接失败：${errorMessage(err)}`
      };
      queueDiagnosticError('network.local-identity-reset-failed', err, {
        previousMode,
        previousIp
      });
      touchRuntime('local network identity reset failed');
    }
    await saveAndBroadcast();
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:install-appcenter', async () => {
    if (runtime.connection.state !== 'connected') {
      runtime.feedback = {
        tone: 'warning',
        message: 'AppCenter 需要先连接 MX-H2I channel。'
      };
      await saveAndBroadcast();
      return visibleRuntime();
    }
    const catalogSync = await syncAppCenterCatalog('install-appcenter');
    runtime.apps.appcenter.installed = true;
    runtime.apps.appcenter.enabled = true;
    runtime.apps.appcenter.status = 'ready';
    runtime.apps.appcenter.installedVersion = runtime.apps.appcenter.version;
    runtime.apps.appcenter.latestVersion = runtime.apps.appcenter.latestVersion || runtime.apps.appcenter.version;
    runtime.apps.appcenter.installPath = 'builtin://appcenter';
    runtime.apps.appcenter.installSource = 'builtin';
    runtime.apps.appcenter.installedAt = runtime.apps.appcenter.installedAt || nowIso();
    runtime.apps.appcenter.runtimeState = 'ready';
    runtime.apps.appcenter.lastAction = nowIso();
    pushAppLog('appcenter', 'info', 'AppCenter builtin runtime is ready.');
    const installReport = await reportAppCenterInstallation(runtime.apps.appcenter, 'install-appcenter');
    const warnings = [
      catalogSync.ok === false ? `远程应用目录同步失败：${catalogSync.message}` : null,
      installReport.ok === false ? `安装状态同步失败：${installReport.message}` : null
    ].filter(Boolean);
    runtime.feedback = {
      tone: warnings.length ? 'warning' : 'success',
      message: warnings.length
        ? `AppCenter 已安装，本地缓存已就绪；${warnings.join('；')}`
        : `AppCenter 已安装，已同步 ${catalogSync.count} 个应用目录记录。`
    };
    touchRuntime('appcenter installed');
    await saveAndBroadcast();
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:enable-h2o', async () => {
    if (!runtime.apps.appcenter.installed) {
      runtime.feedback = {
        tone: 'warning',
        message: '请先安装 AppCenter。'
      };
      await saveAndBroadcast();
      return visibleRuntime();
    }
    try {
      const install = await installAppPackage(runtime.apps.h2o);
      runtime.apps.h2o = normalizeApp({
        ...runtime.apps.h2o,
        ...install,
        installed: true,
        enabled: true,
        status: 'enabled',
        runtimeState: 'ready',
        runtime: h2oPluginRuntime({
          ...runtime.apps.h2o.runtime,
          running: false,
          status: 'ready'
        }),
        lastAction: nowIso(),
        errorMessage: null
      }, runtime.apps.h2o);
      pushAppLog('h2o', 'info', `Installed ${runtime.apps.h2o.packageName} from ${install.installSource}.`);
      const installReport = await reportAppCenterInstallation(runtime.apps.h2o, 'enable-h2o');
      runtime.feedback = {
        tone: installReport.ok === false ? 'warning' : 'success',
        message: installReport.ok === false
          ? `H2O 已安装并启用；安装状态同步失败：${installReport.message}`
          : 'H2O 已安装并启用。'
      };
      touchRuntime('h2o enabled');
    } catch (error) {
      const message = errorMessage(error);
      runtime.apps.h2o.status = 'error';
      runtime.apps.h2o.runtimeState = 'error';
      runtime.apps.h2o.errorMessage = message;
      runtime.apps.h2o.lastAction = nowIso();
      pushAppLog('h2o', 'error', message);
      await reportAppCenterInstallation(runtime.apps.h2o, 'enable-h2o-error');
      runtime.feedback = {
        tone: 'warning',
        message: `H2O 安装失败：${message}`
      };
      touchRuntime('h2o install failed');
    }
    await saveAndBroadcast();
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:launch-h2o', async () => {
    if (!runtime.apps.h2o.installed) {
      runtime.feedback = {
        tone: 'warning',
        message: '请先在 AppCenter 安装 H2O。开发态可运行 pnpm --filter @qpjoy/electron-launcher-app-h2o dev。'
      };
      await saveAndBroadcast();
      return visibleRuntime();
    }
    const currentH2oRuntime = await ensureH2oActiveSubscriptionReady(h2oPluginRuntime(runtime.apps.h2o.runtime), {
      reason: 'launch-h2o'
    });
    if (!h2oHasUsableSubscription(currentH2oRuntime.activeSubscription)) {
      runtime.apps.h2o.runtime = h2oPluginRuntime({
        ...currentH2oRuntime,
        running: false,
        status: 'subscription-required',
        lastAppliedAt: nowIso()
      });
      runtime.apps.h2o.runtimeState = 'ready';
      runtime.apps.h2o.status = 'enabled';
      runtime.apps.h2o.lastAction = nowIso();
      pushAppLog('h2o', 'warning', 'H2O start blocked: no usable oversea subscription for current user.');
      runtime.feedback = {
        tone: 'warning',
        message: 'H2O 需要登录用户获得 Internal / k8s admin 指派的 oversea 订阅后才能启动。'
      };
      touchRuntime('h2o subscription required');
      await saveAndBroadcast();
      return visibleRuntime();
    }
    if (h2oModeNeedsTun(currentH2oRuntime.mode) && !currentH2oRuntime.tunInstalled) {
      runtime.apps.h2o.runtime = h2oPluginRuntime({
        ...currentH2oRuntime,
        running: false,
        status: 'tun-required',
        lastAppliedAt: nowIso()
      });
      runtime.apps.h2o.runtimeState = 'ready';
      runtime.apps.h2o.status = 'enabled';
      runtime.apps.h2o.lastAction = nowIso();
      pushAppLog('h2o', 'warning', 'H2O start blocked: system TUN helper is not installed.');
      runtime.feedback = {
        tone: 'warning',
        message: '系统 TUN 模式需要先安装本机 TUN helper。'
      };
      touchRuntime('h2o tun required');
      await saveAndBroadcast();
      return visibleRuntime();
    }
    let tunnelStatus;
    try {
      tunnelStatus = await startH2oMihomoRuntime(currentH2oRuntime);
    } catch (err) {
      const message = errorMessage(err);
      runtime.apps.h2o.enabled = true;
      runtime.apps.h2o.status = 'enabled';
      runtime.apps.h2o.runtimeState = 'ready';
      runtime.apps.h2o.runtime = h2oPluginRuntime({
        ...currentH2oRuntime,
        running: false,
        status: 'error',
        lastAppliedAt: nowIso()
      });
      runtime.apps.h2o.errorMessage = message;
      runtime.apps.h2o.lastAction = nowIso();
      pushAppLog('h2o', 'error', `H2O mihomo start failed: ${message}`);
      runtime.feedback = {
        tone: 'error',
        message: `H2O mihomo 启动失败：${message}`
      };
      touchRuntime('h2o mihomo start failed');
      await saveAndBroadcast();
      return visibleRuntime();
    }
    const nextRuntime = h2oRuntimeWithTunnelStatus(currentH2oRuntime, tunnelStatus);
    const running = nextRuntime.running === true;
    runtime.apps.h2o.enabled = true;
    runtime.apps.h2o.status = running ? 'running' : 'enabled';
    runtime.apps.h2o.runtimeState = running ? 'running' : 'ready';
    runtime.apps.h2o.runtime = nextRuntime;
    runtime.apps.h2o.errorMessage = null;
    runtime.apps.h2o.lastAction = nowIso();
    pushAppLog('h2o', 'info', running ? 'H2O mihomo runtime started from AppCenter.' : 'H2O mihomo config applied without runtime start.');
    await applyH2oAppNetworkPriority(nextRuntime, 'launch-h2o');
    const installReport = await reportAppCenterInstallation(runtime.apps.h2o, 'launch-h2o');
    runtime.feedback = {
      tone: installReport.ok === false ? 'warning' : 'success',
      message: installReport.ok === false
        ? `H2O 运行态已就绪；安装状态同步失败：${installReport.message}`
        : running
          ? 'H2O mihomo 已启动，mixed 代理端口已交给 AppCenter 管理。'
          : 'H2O 配置已应用，系统 TUN 需要显式授权后启动。'
    };
    touchRuntime('h2o launched');
    await saveAndBroadcast();
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:stop-h2o', async () => {
    if (!runtime.apps.h2o.installed) {
      runtime.feedback = {
        tone: 'warning',
        message: 'H2O 尚未安装。'
      };
      await saveAndBroadcast();
      return visibleRuntime();
    }
    let stopError = null;
    try {
      await stopH2oMihomoRuntime();
    } catch (err) {
      stopError = err;
      pushAppLog('h2o', 'warning', `H2O mihomo stop failed: ${errorMessage(err)}`);
    }
    runtime.apps.h2o.enabled = true;
    runtime.apps.h2o.status = 'enabled';
    runtime.apps.h2o.runtimeState = 'ready';
    runtime.apps.h2o.runtime = h2oPluginRuntime({
      ...runtime.apps.h2o.runtime,
      running: false,
      status: 'stopped',
      startedAt: null,
      lastAppliedAt: nowIso()
    });
    runtime.apps.h2o.errorMessage = stopError ? runtime.apps.h2o.errorMessage : null;
    runtime.apps.h2o.lastAction = nowIso();
    pushAppLog('h2o', 'info', 'H2O runtime stopped from AppCenter.');
    await applyH2oAppNetworkPriority(runtime.apps.h2o.runtime, 'stop-h2o');
    const installReport = await reportAppCenterInstallation(runtime.apps.h2o, 'stop-h2o');
    runtime.feedback = {
      tone: stopError || installReport.ok === false ? 'warning' : 'info',
      message: stopError
        ? `H2O 停止请求已发送，但 mihomo 停止失败：${errorMessage(stopError)}`
        : installReport.ok === false
        ? `H2O 已停止；安装状态同步失败：${installReport.message}`
        : 'H2O 已停止，配置和订阅仍保留。'
    };
    touchRuntime('h2o stopped');
    await saveAndBroadcast();
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:set-h2o-mode', async (_event, mode) => {
    if (!runtime.apps.h2o.installed) {
      runtime.feedback = {
        tone: 'warning',
        message: '请先安装 H2O。'
      };
      await saveAndBroadcast();
      return visibleRuntime();
    }
    const nextMode = normalizeH2oMode(mode);
    const currentH2oRuntime = await ensureH2oActiveSubscriptionReady(h2oPluginRuntime(runtime.apps.h2o.runtime), {
      reason: 'set-h2o-mode'
    });
    if (!h2oHasUsableSubscription(currentH2oRuntime.activeSubscription)) {
      runtime.apps.h2o.runtime = h2oPluginRuntime({
        ...currentH2oRuntime,
        status: 'subscription-required',
        lastAppliedAt: nowIso()
      });
      runtime.feedback = {
        tone: 'warning',
        message: 'H2O 需要先获得可用 oversea 订阅后才能切换模式。'
      };
      pushAppLog('h2o', 'warning', `H2O mode switch blocked without usable subscription: ${nextMode}.`);
      touchRuntime('h2o subscription required');
      await saveAndBroadcast();
      return visibleRuntime();
    }
    if (h2oModeNeedsTun(nextMode) && !currentH2oRuntime.tunInstalled) {
      runtime.apps.h2o.runtime = h2oPluginRuntime({
        ...currentH2oRuntime,
        status: 'tun-required',
        lastAppliedAt: nowIso()
      });
      runtime.feedback = {
        tone: 'warning',
        message: '切换系统 TUN 前需要先安装本机 TUN helper。'
      };
      pushAppLog('h2o', 'warning', 'H2O system TUN mode blocked before TUN helper installation.');
      touchRuntime('h2o tun required');
      await saveAndBroadcast();
      return visibleRuntime();
    }
    let nextRuntime = h2oPluginRuntime({
      ...currentH2oRuntime,
      mode: nextMode,
      status: runtime.apps.h2o.runtimeState === 'running' ? 'running' : 'ready',
      lastAppliedAt: nowIso()
    });
    if (nextRuntime.running) {
      try {
        const tunnelStatus = await startH2oMihomoRuntime(nextRuntime);
        nextRuntime = h2oRuntimeWithTunnelStatus(nextRuntime, tunnelStatus);
      } catch (err) {
        nextRuntime = h2oPluginRuntime({
          ...nextRuntime,
          running: false,
          status: 'error',
          lastAppliedAt: nowIso()
        });
        runtime.apps.h2o.runtime = nextRuntime;
        runtime.apps.h2o.runtimeState = 'ready';
        runtime.apps.h2o.status = 'enabled';
        runtime.apps.h2o.errorMessage = errorMessage(err);
        runtime.apps.h2o.lastAction = nowIso();
        pushAppLog('h2o', 'error', `H2O mode switch failed while applying mihomo config: ${errorMessage(err)}`);
        runtime.feedback = {
          tone: 'error',
          message: `H2O 模式已保存，但 mihomo 配置应用失败：${errorMessage(err)}`
        };
        touchRuntime('h2o mode apply failed');
        await saveAndBroadcast();
        return visibleRuntime();
      }
    }
    runtime.apps.h2o.runtime = nextRuntime;
    runtime.apps.h2o.errorMessage = null;
    runtime.apps.h2o.lastAction = nowIso();
    pushAppLog('h2o', 'info', `H2O mode switched to ${nextMode}.`);
    await applyH2oAppNetworkPriority(nextRuntime, 'set-h2o-mode');
    const installReport = await reportAppCenterInstallation(runtime.apps.h2o, 'set-h2o-mode');
    runtime.feedback = {
      tone: installReport.ok === false ? 'warning' : 'success',
      message: installReport.ok === false
        ? `H2O 模式已切换；安装状态同步失败：${installReport.message}`
        : 'H2O 模式已切换。'
    };
    touchRuntime('h2o mode changed');
    await saveAndBroadcast();
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:select-h2o-node', async (_event, nodeName) => {
    const name = nullableString(nodeName);
    const current = h2oPluginRuntime(runtime.apps.h2o.runtime);
    if (!name) return visibleRuntime();
    let nextRuntime = h2oPluginRuntime({ ...current, selectedNode: name, lastAppliedAt: nowIso() });
    if (current.running) {
      // 运行中优先走 external-controller 即时切换，不重启核心也不断开现有连接。
      try {
        const manager = getH2oTunnelManager();
        const result = await manager.selectProxyNode(name);
        nextRuntime = h2oPluginRuntime({
          ...nextRuntime,
          nodes: normalizeH2oNodes(h2oTunnelNodes(manager)) || nextRuntime.nodes
        });
        pushAppLog('h2o', 'info', `H2O oversea node switched to ${name} (${result.applied}).`);
        runtime.feedback = { tone: 'success', message: `已切换出海节点：${name}` };
      } catch (err) {
        pushAppLog('h2o', 'error', `H2O oversea node switch failed: ${errorMessage(err)}`);
        runtime.feedback = { tone: 'error', message: `切换出海节点失败：${errorMessage(err)}` };
        await saveAndBroadcast();
        return visibleRuntime();
      }
    } else {
      pushAppLog('h2o', 'info', `H2O oversea node preset to ${name}; applies on next start.`);
      runtime.feedback = { tone: 'success', message: `已选择出海节点：${name}，下次启动生效。` };
    }
    runtime.apps.h2o.runtime = nextRuntime;
    runtime.apps.h2o.lastAction = nowIso();
    await saveH2oUserRuntimeProfileForCurrentUser(nextRuntime, { reason: 'select-h2o-node' });
    await saveAndBroadcast();
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:update-h2o-runtime', async (_event, patch) => {
    if (!runtime.apps.h2o.installed) {
      runtime.feedback = {
        tone: 'warning',
        message: '请先安装 H2O。'
      };
      await saveAndBroadcast();
      return visibleRuntime();
    }
    const row = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const current = h2oPluginRuntime(runtime.apps.h2o.runtime);
    let nextRuntime = h2oPluginRuntime({
      ...current,
      ...row,
      ports: {
        ...current.ports,
        ...(row.ports && typeof row.ports === 'object' ? row.ports : {})
      },
      activeSubscription: {
        ...current.activeSubscription,
        ...(row.activeSubscription && typeof row.activeSubscription === 'object' ? row.activeSubscription : {})
      },
      metrics: {
        ...current.metrics,
        ...(row.metrics && typeof row.metrics === 'object' ? row.metrics : {})
      },
      subscriptions: Array.isArray(row.subscriptions) ? row.subscriptions : current.subscriptions,
      rules: Array.isArray(row.rules) ? row.rules : current.rules,
      lastAppliedAt: nullableString(row.lastAppliedAt) || nowIso()
    });
    if (row.applyTunnelRuntime === true && nextRuntime.running) {
      try {
        const tunnelStatus = await startH2oMihomoRuntime(nextRuntime);
        nextRuntime = h2oRuntimeWithTunnelStatus(nextRuntime, tunnelStatus);
      } catch (err) {
        nextRuntime = h2oPluginRuntime({
          ...nextRuntime,
          running: false,
          status: 'error',
          lastAppliedAt: nowIso()
        });
        row.logLevel = 'error';
        row.logMessage = `H2O mihomo config apply failed: ${errorMessage(err)}`;
      }
    }
    runtime.apps.h2o.enabled = true;
    runtime.apps.h2o.status = nextRuntime.running ? 'running' : 'enabled';
    runtime.apps.h2o.runtimeState = nextRuntime.running ? 'running' : 'ready';
    runtime.apps.h2o.runtime = nextRuntime;
    runtime.apps.h2o.errorMessage = row.logLevel === 'error'
      ? nullableString(row.logMessage) || runtime.apps.h2o.errorMessage
      : null;
    runtime.apps.h2o.lastAction = nowIso();
    pushAppLog('h2o', ['info', 'warning', 'error'].includes(row.logLevel) ? row.logLevel : 'info', nullableString(row.logMessage) || 'H2O runtime updated from AppCenter.');
    await applyH2oAppNetworkPriority(nextRuntime, 'update-h2o-runtime');
    const profileSync = await saveH2oUserRuntimeProfileForCurrentUser(runtime.apps.h2o.runtime, {
      reason: 'update-h2o-runtime'
    });
    runtime.feedback = {
      tone: row.logLevel === 'error' ? 'error' : profileSync?.ok === false ? 'warning' : 'success',
      message: row.logLevel === 'error'
        ? `H2O 运行配置已保存，但 mihomo 应用失败：${nullableString(row.logMessage) || 'unknown'}`
        : profileSync?.ok === false
          ? `H2O 运行配置已保存到本机，但同步 Internal 用户配置失败：${profileSync.message}`
        : 'H2O 运行配置已更新。'
    };
    touchRuntime('h2o runtime updated');
    await saveAndBroadcast();
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:issue-h2o-clash-link', async (_event, input = {}) => {
    try {
      const issued = await issueH2oClashSubscriptionLink(input);
      const current = h2oPluginRuntime(runtime.apps.h2o.runtime);
      runtime.apps.h2o.runtime = h2oPluginRuntime({
        ...current,
        clashLink: { url: issued.url, expiresAt: issued.expiresAt, issuedAt: nowIso() }
      });
      runtime.feedback = {
        tone: 'success',
        message: 'Clash 订阅链接已生成，可直接复制到 Clash。旧链接同时失效。'
      };
      pushAppLog('h2o', 'info', 'H2O clash subscription link issued.');
    } catch (err) {
      runtime.feedback = { tone: 'warning', message: `生成 Clash 订阅链接失败：${errorMessage(err)}` };
      pushAppLog('h2o', 'warning', `H2O clash subscription link failed: ${errorMessage(err)}`);
    }
    await saveAndBroadcast();
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:refresh-h2o-subscription', async (_event, input = {}) => {
    if (!runtime.apps.h2o.installed) {
      runtime.feedback = {
        tone: 'warning',
        message: '请先安装 H2O。'
      };
      await saveAndBroadcast();
      return visibleRuntime();
    }
    const subscriptionId = nullableString(input?.subscriptionId);
    const current = h2oPluginRuntime(runtime.apps.h2o.runtime);
    const targetSubscription = current.subscriptions.find((item) => item.id === subscriptionId)
      || current.activeSubscription;
    if (targetSubscription && !targetSubscription.requiresUser) {
      await refreshH2oExternalSubscription(targetSubscription.id);
      const refreshed = h2oPluginRuntime(runtime.apps.h2o.runtime);
      const refreshedSubscription = refreshed.subscriptions.find((item) => item.id === targetSubscription.id)
        || refreshed.activeSubscription;
      const ready = h2oHasUsableSubscription(refreshedSubscription);
      const profileSync = await saveH2oUserRuntimeProfileForCurrentUser(runtime.apps.h2o.runtime, {
        reason: 'refresh-h2o-external-subscription'
      });
      runtime.feedback = {
        tone: ready && profileSync?.ok !== false ? 'success' : 'warning',
        message: profileSync?.ok === false
          ? `H2O 自定义订阅已刷新到本机，但同步 Internal 用户配置失败：${profileSync.message}`
          : ready ? 'H2O 自定义订阅已刷新。' : 'H2O 自定义订阅刷新失败，请检查订阅地址或认证信息。'
      };
      touchRuntime('h2o custom subscription refreshed');
      await saveAndBroadcast();
      return visibleRuntime();
    }
    if (!runtimeHasUserIdentity()) {
      applyH2oManagedSubscriptionState(current, {
        status: 'login-required',
        syncStatus: 'login-required',
        errorMessage: '系统 oversea 订阅需要先登录员工用户。'
      });
      runtime.feedback = {
        tone: 'warning',
        message: '请先登录员工用户后再刷新 H2O oversea 订阅。'
      };
      await saveAndBroadcast();
      return visibleRuntime();
    }
    await hydrateH2oSystemSubscriptionsForUser({ showInitializing: true });
    const ready = h2oHasUsableSubscription(runtime.apps.h2o.runtime?.activeSubscription);
    runtime.feedback = {
      tone: ready ? 'success' : 'warning',
      message: ready
        ? 'H2O 已获得当前用户的默认 oversea 订阅。'
        : 'H2O 当前用户 oversea 订阅仍未就绪，请检查 Internal / k8s admin 的 Oversea 状态。'
    };
    touchRuntime('h2o subscription refreshed');
    await saveAndBroadcast();
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:provision-h2o-oversea', async (_event, input = {}) => {
    if (!runtime.apps.h2o.installed) {
      runtime.feedback = {
        tone: 'warning',
        message: '请先安装 H2O。'
      };
      await saveAndBroadcast();
      return visibleRuntime();
    }
    if (!runtimeHasUserIdentity()) {
      const current = h2oPluginRuntime(runtime.apps.h2o.runtime);
      applyH2oManagedSubscriptionState(current, {
        status: 'login-required',
        syncStatus: 'login-required',
        errorMessage: '新建系统 oversea 订阅需要先登录员工用户。'
      });
      runtime.feedback = {
        tone: 'warning',
        message: '请先登录员工用户后再分配 H2O oversea 订阅。'
      };
      await saveAndBroadcast();
      return visibleRuntime();
    }
    try {
      await markH2oSystemSubscriptionInitializing(h2oPluginRuntime(runtime.apps.h2o.runtime), 'h2o oversea provision initializing');
      const provisionResult = await provisionH2oOverseaForCurrentUser(input);
      const ready = h2oHasUsableSubscription(runtime.apps.h2o.runtime?.activeSubscription);
      const syncStatus = nullableString(provisionResult?.syncStatus);
      const syncMessage = syncStatus && syncStatus !== 'skipped' ? `返回 ${syncStatus}` : '仍未完成';
      runtime.feedback = {
        tone: ready ? 'success' : 'warning',
        message: ready
          ? '已为当前用户分配并同步 H2O oversea 订阅。'
          : `已为当前用户创建 oversea entitlement，但远端 runtime 同步${syncMessage}。`
      };
      touchRuntime('h2o oversea provisioned');
    } catch (err) {
      const current = h2oPluginRuntime(runtime.apps.h2o.runtime);
      applyH2oManagedSubscriptionState(current, {
        status: 'error',
        syncStatus: 'provision-failed',
        errorMessage: `分配 H2O oversea 订阅失败：${errorMessage(err)}`
      });
      runtime.feedback = {
        tone: 'error',
        message: `分配 H2O oversea 订阅失败：${errorMessage(err)}`
      };
      touchRuntime('h2o oversea provision failed');
    }
    await saveAndBroadcast();
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:open-h2o-test-window', async (_event, input = {}) => {
    try {
      await openH2oTestWindow(input);
    } catch (err) {
      runtime.feedback = {
        tone: 'error',
        message: `H2O 测试窗口打开失败：${errorMessage(err)}`
      };
      pushAppLog('h2o', 'error', `H2O test window failed: ${errorMessage(err)}`);
    }
    await saveAndBroadcast();
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:check-updates', async () => {
    await checkUpdatesWithConnectionGuard('manual-check', { manual: true });
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:apply-update', async () => {
    await applyLauncherUpdate('manual-apply');
    await saveAndBroadcast();
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:install-release', async (_event, releaseId) => {
    await applyLauncherUpdate('history-install', releaseId);
    await saveAndBroadcast();
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:show-downloaded-installer', async () => {
    await showDownloadedInstaller();
    await saveAndBroadcast();
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:restart-app', async () => {
    runtime.feedback = {
      tone: 'info',
      message: '正在重启 MX-H2I。'
    };
    touchRuntime('app restart requested');
    await saveAndBroadcast();
    appRelaunchRequested = true;
    setTimeout(() => {
      app.quit();
    }, 120);
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:open-rollback', async (_event, rollbackId) => {
    await openRollbackInstaller(rollbackId);
    await saveAndBroadcast();
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:refresh-diagnostics', async () => {
    await recoverWireGuardForRuntime('manual-diagnostics', { allowPrivileged: false });
    await refreshWireGuardDiagnostics();
    await refreshNetworkEnvironmentDiagnostics('manual-diagnostics', { persist: false });
    await saveAndBroadcast();
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:open-diagnostic-logs', async () => {
    await fs.mkdir(diagnosticLogDirPath(), { recursive: true });
    const openError = await shell.openPath(diagnosticLogDirPath());
    if (openError) {
      runtime.feedback = { tone: 'danger', message: `打开日志目录失败：${openError}` };
      queueDiagnosticLog('error', 'diagnostics.open-log-dir-failed', openError);
      await saveAndBroadcast();
    }
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:export-diagnostics', async () => {
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: '选择 MX-H2I 诊断包保存位置',
      buttonLabel: '导出到这里',
      properties: ['openDirectory', 'createDirectory']
    });
    if (selection.canceled || !selection.filePaths[0]) return visibleRuntime();
    try {
      const bundle = await exportDiagnosticBundle(selection.filePaths[0]);
      runtime.feedback = {
        tone: 'success',
        message: `诊断包已导出：${bundle.folderName}。其中可能包含本机网络、DNS 和路由信息，分享前请确认接收方。`
      };
      touchRuntime('diagnostic bundle exported');
      await saveAndBroadcast();
      shell.showItemInFolder(path.join(bundle.folderPath, 'summary.json'));
    } catch (err) {
      runtime.feedback = { tone: 'danger', message: `诊断包导出失败：${errorMessage(err)}` };
      queueDiagnosticError('diagnostics.export-failed', err);
      await saveAndBroadcast();
    }
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:list-state-backups', async () => listAppsStateBackups());
  ipcMain.handle('mx-h2i:restore-state-backup', async (_event, fileName) => {
    const snapshot = await readAppsStateBackup(fileName);
    runtime.apps = normalizeApps(snapshot.apps);
    touchRuntime(`apps state restored from ${snapshot.file}`);
    await saveAndBroadcast();
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:repair-system-network', async () => {
    await repairSystemNetworkForRuntime('manual-repair');
    await saveAndBroadcast();
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:open-admin', async () => {
    const baseUrl = runtime.connection?.state === 'connected'
      ? (runtime.connection.internalBaseUrl || runtime.config.internalApiBaseUrl)
      : (runtime.config.bootstrapApiBaseUrl || runtime.config.internalApiBaseUrl);
    const url = `${baseUrl.replace(/\/+$/, '')}/admin/`;
    await shell.openExternal(url);
    return true;
  });
  ipcMain.handle('mx-h2i:set-window-mode', (_event, mode) => {
    resizeWindowForMode(mode === 'appcenter' ? 'appcenter' : 'launcher');
    return true;
  });
  ipcMain.handle('mx-h2i:window-control', (_event, action) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (action === 'close') {
      mainWindow.close();
      return true;
    }
    if (action === 'minimize') {
      mainWindow.minimize();
      return true;
    }
    if (action === 'zoom') {
      if (mainWindow.isResizable()) {
        if (mainWindow.isMaximized()) mainWindow.unmaximize();
        else mainWindow.maximize();
      } else {
        mainWindow.center();
      }
      return true;
    }
    return false;
  });
  ipcMain.handle('mx-h2i:start-window-drag', (_event, input) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (currentWindowMode !== 'launcher' || isTopHidden) return false;
    return beginWindowDragSnapshot(input?.dragId);
  });
  ipcMain.handle('mx-h2i:move-window-by', (_event, input) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (currentWindowMode !== 'launcher' || isTopHidden) return false;
    const dx = Number(input?.dx);
    const dy = Number(input?.dy);
    const totalDx = Number(input?.totalDx);
    const totalDy = Number(input?.totalDy);
    const windowsDrag = process.platform === 'win32';
    if (windowsDrag) {
      const dragId = normalizeWindowDragId(input?.dragId);
      if (!activeWindowDrag || dragId === null || activeWindowDrag.id !== dragId) return false;
      if (!Number.isFinite(totalDx) || !Number.isFinite(totalDy)) return false;
    } else if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
      return false;
    }
    const bounds = windowsDrag ? activeWindowDrag : mainWindow.getBounds();
    const nextBounds = {
      x: Math.round(windowsDrag ? bounds.startX + totalDx : bounds.x + dx),
      y: Math.round(windowsDrag ? bounds.startY + totalDy : bounds.y + dy),
      width: bounds.width,
      height: bounds.height
    };
    const display = electronScreen.getDisplayMatching(nextBounds);
    const releaseDock = isTopDocked && Number.isFinite(totalDy) && totalDy >= dockReleaseDistance(bounds, display);
    if (releaseDock) {
      isTopDocked = false;
      topDockHidePending = false;
      topDockHoldUntil = 0;
      topDockLeaveStartedAt = 0;
      nextBounds.y = Math.max(nextBounds.y, display.workArea.y + Math.round(totalDy));
    } else if (nextBounds.y <= display.workArea.y + dockActivationDistance(nextBounds, display)) {
      isTopDocked = true;
      topDockHidePending = false;
      nextBounds.y = display.workArea.y + TOP_DOCK_Y;
    } else if (!isTopDocked) {
      isTopDocked = false;
      topDockHidePending = false;
    }
    stopTopAnimation();
    // Pointer events change position only. Windows size correction always uses
    // the drag-start snapshot, so DPI-adjusted width/height never feed the next move.
    mainWindow.setPosition(nextBounds.x, nextBounds.y, false);
    if (windowsDrag) {
      activeWindowDrag.x = nextBounds.x;
      activeWindowDrag.y = nextBounds.y;
      lastVisibleBounds = { ...nextBounds };
      scheduleWindowDragSizeCorrection();
    } else {
      lastVisibleBounds = mainWindow.getBounds();
    }
    return {
      bounds: lastVisibleBounds,
      docked: isTopDocked
    };
  });
  ipcMain.handle('mx-h2i:finish-window-drag', (_event, input) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (currentWindowMode !== 'launcher' || isTopHidden) return false;
    if (process.platform === 'win32') {
      const dragId = normalizeWindowDragId(input?.dragId);
      if (!activeWindowDrag || dragId === null || activeWindowDrag.id !== dragId) return false;
    }
    const bounds = finishWindowDragSnapshot(input) || mainWindow.getBounds();
    const display = electronScreen.getDisplayMatching(bounds);
    const totalDy = Number(input?.totalDy);
    const releaseDock = isTopDocked && Number.isFinite(totalDy) && totalDy >= dockReleaseDistance(bounds, display);
    const shouldDock = !releaseDock && (isTopDocked || bounds.y <= display.workArea.y + dockActivationDistance(bounds, display));
    if (!shouldDock) {
      isTopDocked = false;
      topDockHidePending = false;
      topDockHoldUntil = 0;
      topDockLeaveStartedAt = 0;
      lastVisibleBounds = { ...bounds };
      if (process.platform === 'win32') {
        rememberWindowBoundsForMode('launcher', bounds);
        persistWindowStateSoon();
      }
      return { docked: false, bounds: lastVisibleBounds };
    }
    return snapToTopEdge();
  });
  ipcMain.handle('mx-h2i:hide-top-dock-if-pending', () => {
    maybeHideTopDock();
    return true;
  });
}

async function promoteEmployeeConnection(options = {}) {
  const connectOperation = beginWireGuardConnectOperation();
  const lifecycleEpoch = networkMutationEpoch;
  const transitionStartedAt = Date.now();
  const transitionId = makeRequestId(options.provider === 'feishu' ? 'feishu-staff-connect' : 'staff-connect');
  const provider = options.provider === 'feishu' ? 'feishu' : 'password';
  const providerLabel = provider === 'feishu' ? '飞书' : '员工账号';
  const accountHint = nullableString(options.account);
  try {
    assertNetworkTransitionCurrent(lifecycleEpoch);
    await ensureCredentialStorageRecoveryReady();
    const employeeEndpointRouteRepair = await repairDarwinEndpointRouteBeforeBootstrap(
      provider === 'feishu' ? 'feishu-pre-bootstrap' : 'employee-pre-bootstrap'
    );
    if (employeeEndpointRouteRepair?.stale === true && employeeEndpointRouteRepair?.repaired !== true) {
      await saveAndBroadcast();
      return visibleRuntime();
    }
    let connectedFallbackWasProbed = false;
    if (runtime.connection?.state === 'connected') {
      const guestProbe = await probeConnectedModeBeforeTransition(
        runtime.connection.mode === 'employee' ? 'employee' : 'guest',
        provider === 'feishu' ? 'feishu-connect-guest-fallback-guard' : 'staff-connect-guest-fallback-guard'
      );
      if (guestProbe.superseded) return visibleRuntime();
      connectedFallbackWasProbed = true;
    }
    let retainedRecovery = null;
    if (!connectedFallbackWasProbed && shouldAttemptRetainedWireGuardPreBootstrap(runtime.connection)) {
      retainedRecovery = await recoverRetainedWireGuardBeforeBootstrap(
        provider === 'feishu' ? 'feishu-pre-bootstrap' : 'employee-pre-bootstrap',
        { allowPrivileged: shouldAllowPrivilegedPreBootstrapRecovery() }
      );
    }
    if (retainedRecovery?.authorizationCanceled === true) {
      runtime.feedback = {
        tone: 'warning',
        message: `已取消 WireGuard 修复授权；MX-H2I 已保留当前网络状态，不会继续${providerLabel}登录或再次弹窗。`
      };
      touchRuntime(`${provider} staff connect authorization canceled during retained repair`);
      await publishNetworkModeEvent('staff:connect', 'failed', {
        reason: 'authorization-canceled',
        transitionId
      });
      await saveAndBroadcast();
      return visibleRuntime();
    }
    const networkFallback =
      (connectionHasReadyNetworkProof(runtime.connection) || runtime.connection?.wireGuard?.active === true)
      ? retainableConnectionSnapshot(runtime.connection)
      : null;
    const guestFallback = networkFallback?.mode === 'guest' ? networkFallback : null;
    const identityFallback = networkFallback ? runtime.identity : null;
    const authFallback = networkFallback ? runtime.auth : null;
    assertNetworkTransitionCurrent(lifecycleEpoch);
    setConnecting('employee', {
      replacingGuest: Boolean(guestFallback),
      provider
    });
    await publishNetworkModeEvent('staff:connect', 'connecting', {
      reason: guestFallback ? 'visit-to-staff' : provider === 'feishu' ? 'feishu-login' : null,
      transitionId
    });
    await saveAndBroadcast({ fallbackConnection: networkFallback });
    assertNetworkTransitionCurrent(lifecycleEpoch);
    scheduleNetworkEnvironmentDiagnostics(`${provider}-pre-connect`, {
      phase: 'bootstrap',
      persist: false,
      lookupTimeoutMs: NETWORK_DIAGNOSTIC_LOOKUP_TIMEOUT_MS
    });
    let authenticated = options.auth || null;
    let resolvedBootstrap = options.bootstrap || null;
    let dataPlaneApplyStarted = false;
    try {
      const bootstrap = resolvedBootstrap || await resolveBootstrapEndpoint(runtime.config, {
        requireSecureTransport: provider === 'feishu'
      });
      assertNetworkTransitionCurrent(lifecycleEpoch);
      if (provider === 'feishu') {
        assertSecureFeishuTransport(bootstrap, '员工网络切换');
      }
      await assertLiveSecureLauncherCapabilityTransport(
        bootstrap,
        provider === 'feishu' ? '飞书员工凭据传输' : '员工账号密码传输'
      );
      const baseUrl = bootstrap.baseUrl;
      await applyResolvedBootstrapEndpoint(bootstrap);
      assertNetworkTransitionCurrent(lifecycleEpoch);
      const auth = authenticated || await options.authenticate?.(baseUrl, bootstrap);
      if (!auth?.user?.userId || !auth?.accessToken) {
        throw new Error(`${providerLabel}登录没有返回可用的 Internal user token。`);
      }
      assertNetworkTransitionCurrent(lifecycleEpoch);
      authenticated = auth;
      resolvedBootstrap = bootstrap;
      const account = nullableString(auth.user.email)
        || nullableString(auth.user.account)
        || accountHint
        || auth.user.userId;
      if (guestFallback) {
        runtime.feedback = {
          tone: 'info',
          message: `${providerLabel}身份验证通过，正在申请员工 lease 并切换系统网络；切换开始后将替换当前访客通道。`
        };
        touchRuntime(`${provider} authenticated; preparing visit-to-staff switch`);
        await saveAndBroadcast();
      }
      const session = await connectLauncherNetworkWithLocalIdentityRepair({
        identityKind: 'user',
        userId: auth.user.userId,
        leaseProfile: provider === 'feishu' ? 'feishu' : undefined,
        accessToken: auth.accessToken,
        authProvider: provider,
        requestTag: provider === 'feishu' ? 'feishu-employee' : 'employee'
      }, {
        preservePreviousOnRetryFailure: Boolean(networkFallback)
      });
      assertNetworkTransitionCurrent(lifecycleEpoch);
      dataPlaneApplyStarted = true;
      await applyNetworkSession(session, {
        mode: 'employee',
        subject: `user:${auth.user.userId}`,
        routePolicy: 'user full',
        identity: {
          kind: 'user',
          provider,
          displayName: auth.user.displayName || displayNameFromAccount(account),
          account,
          scopes: [...new Set([
            ...EMPLOYEE_IDENTITY_BASE_SCOPES,
            ...(Array.isArray(auth.scopes) ? auth.scopes : [])
          ])]
        },
        auth,
        feedback: provider === 'feishu'
          ? '飞书账号已绑定 Internal User Center，并续租飞书员工 IP。'
          : '员工账号已绑定 Internal User Center，并续租固定 user IP。',
        replacedMode: networkFallback?.mode || null,
        fallbackConnection: networkFallback,
        fallbackIdentity: identityFallback,
        fallbackAuth: authFallback,
        lifecycleEpoch,
        transitionId,
        transitionStartedAt
      });
    } catch (err) {
      if (isSupersededNetworkTransitionError(err)) return visibleRuntime();
      if (networkFallback && !dataPlaneApplyStarted) {
        runtime.connection = networkFallback;
        runtime.identity = identityFallback;
        runtime.auth = authFallback;
        runtime.feedback = {
          tone: 'danger',
          message: `${providerLabel}登录失败：${errorMessage(err)}；原有网络保持连接。`
        };
        touchRuntime(`${provider} staff connect failed; existing network retained`);
      } else {
        await applyConnectionError(`${providerLabel}登录失败`, err);
      }
      await publishNetworkModeEvent('staff:connect', 'failed', {
        reason: errorMessage(err),
        transitionId
      });
    }
    if (authenticated && resolvedBootstrap && runtime.connection?.mode === 'employee' && runtime.connection?.state === 'connected') {
      try {
        await hydrateH2oSystemSubscriptionsForUser({
          userId: authenticated.user.userId,
          baseUrl: resolvedBootstrap.baseUrl,
          bootstrapResolveMode: resolvedBootstrap.resolveMode,
          showInitializing: true
        });
      } catch (err) {
        runtime.feedback = {
          tone: 'warning',
          message: `员工网络已连接，但 H2O 系统订阅刷新失败：${errorMessage(err)}`
        };
        touchRuntime('employee connected; h2o subscription refresh failed');
      }
    }
    await saveAndBroadcast();
    return visibleRuntime();
  } catch (err) {
    if (isSupersededNetworkTransitionError(err)) return visibleRuntime();
    throw err;
  } finally {
    connectOperation.finish();
  }
}

async function startFeishuLogin() {
  await ensureCredentialStorageRecoveryReady();
  if (pendingFeishuLogin) {
    runtime.feedback = {
      tone: 'info',
      message: '飞书登录已在浏览器中等待授权，请完成授权或取消当前登录。'
    };
    await saveAndBroadcast();
    return;
  }
  const redirectUri = feishuRedirectUri();
  const flow = {
    id: makeRequestId('feishu-login'),
    state: randomBytes(32).toString('base64url'),
    codeVerifier: randomBytes(48).toString('base64url'),
    exchangeHandle: null,
    redirectUri,
    stage: 'starting',
    startedAt: nowIso(),
    expiresAt: new Date(Date.now() + FEISHU_AUTH_TIMEOUT_MS).toISOString(),
    server: null,
    timeout: null,
    callbackAccepted: false,
    baseUrl: null,
    bootstrapResolveMode: null
  };
  pendingFeishuLogin = flow;
  try {
    await listenForFeishuCallback(flow);
    if (pendingFeishuLogin !== flow) return;
    const bootstrap = await resolveBootstrapEndpoint(runtime.config, {
      requireSecureTransport: true
    });
    if (pendingFeishuLogin !== flow) return;
    assertSecureFeishuTransport(bootstrap, '授权初始化');
    await assertLiveSecureFeishuTransport(bootstrap, '授权初始化');
    await applyResolvedBootstrapEndpoint(bootstrap);
    if (pendingFeishuLogin !== flow) return;
    flow.baseUrl = bootstrap.baseUrl;
    flow.bootstrapResolveMode = bootstrap.resolveMode;
    const payload = await requestJson(
      joinApiUrl(bootstrap.baseUrl, '/internal/v1/sdk/oauth/feishu/authorize'),
      {
        method: 'POST',
        timeoutMs: 10_000,
        bootstrapResolveMode: bootstrap.resolveMode,
        body: {
          redirectUri,
          state: flow.state,
          codeChallenge: createHash('sha256').update(flow.codeVerifier).digest('base64url'),
          exchangeHandleVersion: 'mxfx2'
        }
      }
    );
    if (pendingFeishuLogin !== flow) return;
    const authorizationUrl = nullableString(payload?.authorizationUrl);
    const exchangeHandle = nullableString(payload?.exchangeHandle);
    if (
      !authorizationUrl
      || !isSafeFeishuAuthorizationUrl(authorizationUrl)
      || !isSafeFeishuExchangeHandle(exchangeHandle)
    ) {
      throw new Error('Internal 没有返回安全的飞书 HTTPS 授权地址。');
    }
    flow.exchangeHandle = exchangeHandle;
    flow.stage = 'opening-browser';
    runtime.feedback = {
      tone: 'info',
      message: guestPreservingFeishuMessage('正在打开系统浏览器进行飞书授权。')
    };
    touchRuntime('feishu authorization browser opening');
    await saveAndBroadcast();
    await shell.openExternal(authorizationUrl);
    if (pendingFeishuLogin !== flow) return;
    flow.stage = 'waiting-callback';
    flow.timeout = setTimeout(() => {
      void expireFeishuLogin(flow);
    }, Math.max(1, Date.parse(flow.expiresAt) - Date.now()));
    runtime.feedback = {
      tone: 'info',
      message: guestPreservingFeishuMessage('已打开系统浏览器，请在飞书完成授权；可随时返回 MX-H2I 取消。')
    };
    touchRuntime('feishu authorization waiting');
    await saveAndBroadcast();
  } catch (err) {
    if (pendingFeishuLogin !== flow) return;
    clearPendingFeishuLogin('start-failed', flow);
    runtime.feedback = {
      tone: 'danger',
      message: guestPreservingFeishuMessage(`飞书登录启动失败：${errorMessage(err)}。`)
    };
    queueDiagnosticError('auth.feishu-start-failed', err);
    touchRuntime('feishu authorization start failed');
    await saveAndBroadcast();
  }
}

function listenForFeishuCallback(flow) {
  return new Promise((resolve, reject) => {
    const callbackUrl = new URL(flow.redirectUri);
    const server = http.createServer((request, response) => {
      handleFeishuCallbackRequest(flow, request, response);
    });
    flow.server = server;
    const fail = (err) => {
      server.removeListener('listening', ready);
      reject(err);
    };
    const ready = () => {
      server.removeListener('error', fail);
      server.on('error', (err) => {
        queueDiagnosticError('auth.feishu-callback-server', err, {
          port: callbackUrl.port
        });
      });
      resolve();
    };
    server.once('error', fail);
    server.once('listening', ready);
    server.listen(Number(callbackUrl.port), '127.0.0.1');
  });
}

function handleFeishuCallbackRequest(flow, request, response) {
  if (request.method !== 'GET') {
    writeFeishuCallbackResponse(response, 405, '请求方式不受支持', '请返回 MX-H2I 重新发起飞书登录。');
    return;
  }
  let callback;
  try {
    callback = new URL(request.url || '/', flow.redirectUri);
  } catch {
    writeFeishuCallbackResponse(response, 400, '回调地址无效', '请返回 MX-H2I 重新发起飞书登录。');
    return;
  }
  const expectedCallback = new URL(flow.redirectUri);
  if (callback.origin !== expectedCallback.origin || callback.pathname !== FEISHU_CALLBACK_PATH) {
    writeFeishuCallbackResponse(response, 404, '不是 MX-H2I 飞书回调', '此本地地址仅用于飞书登录。');
    return;
  }
  if (pendingFeishuLogin !== flow) {
    writeFeishuCallbackResponse(response, 410, '登录请求已结束', '可以关闭此页面并返回 MX-H2I。');
    return;
  }
  if (flow.callbackAccepted) {
    writeFeishuCallbackResponse(response, 410, '登录回调已处理', '可以关闭此页面并返回 MX-H2I。');
    return;
  }
  const returnedState = nullableString(callback.searchParams.get('state'));
  if (!returnedState || !secureStringEqual(returnedState, flow.state)) {
    writeFeishuCallbackResponse(response, 400, '登录校验失败', 'state 不匹配；为保护账号，本次回调未被接受。');
    queueDiagnosticLog('warning', 'auth.feishu-state-mismatch', 'Rejected a Feishu callback with mismatched state.');
    return;
  }
  flow.callbackAccepted = true;
  closeFeishuCallbackServer(flow);
  if (flow.timeout) {
    clearTimeout(flow.timeout);
    flow.timeout = null;
  }
  const providerError = nullableString(callback.searchParams.get('error'));
  if (providerError) {
    writeFeishuCallbackResponse(response, 200, '飞书授权已取消', '访客网络保持连接，可以关闭此页面。');
    void rejectFeishuCallback(flow, providerError);
    return;
  }
  const code = feishuAuthorizationCodeFromRawUrl(request.url);
  if (!code) {
    writeFeishuCallbackResponse(response, 400, '飞书没有返回授权码', '请返回 MX-H2I 重新发起登录。');
    void rejectFeishuCallback(flow, 'missing-code');
    return;
  }
  flow.stage = 'exchanging-token';
  writeFeishuCallbackResponse(response, 200, '飞书授权已完成', 'MX-H2I 正在验证身份并准备员工网络，可以关闭此页面。');
  broadcastState();
  void completeFeishuLogin(flow, code);
}

function feishuAuthorizationCodeFromRawUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  const queryStart = rawUrl.indexOf('?');
  if (queryStart < 0) return null;
  const fragmentStart = rawUrl.indexOf('#', queryStart + 1);
  const query = rawUrl.slice(queryStart + 1, fragmentStart < 0 ? undefined : fragmentStart);
  let code = null;
  for (const part of query.split('&')) {
    const separator = part.indexOf('=');
    const rawName = separator < 0 ? part : part.slice(0, separator);
    const rawValue = separator < 0 ? '' : part.slice(separator + 1);
    let name;
    let value;
    try {
      name = decodeURIComponent(rawName);
      value = decodeURIComponent(rawValue);
    } catch {
      return null;
    }
    if (name !== 'code') continue;
    if (code !== null) return null;
    code = value;
  }
  if (
    typeof code !== 'string'
    || !code
    || code.length > 2048
    || code.trim() !== code
    || /[\u0000-\u001f\u007f]/.test(code)
  ) {
    return null;
  }
  return code;
}

async function completeFeishuLogin(flow, code) {
  try {
    await assertLiveSecureFeishuTransport({
      baseUrl: flow.baseUrl,
      resolveMode: flow.bootstrapResolveMode
    }, '授权码交换');
    const auth = await authenticateFeishuViaGateway(
      flow.baseUrl,
      code,
      flow.redirectUri,
      flow.codeVerifier,
      flow.exchangeHandle,
      {
      bootstrapResolveMode: flow.bootstrapResolveMode
      }
    );
    if (pendingFeishuLogin !== flow) return;
    flow.codeVerifier = null;
    flow.exchangeHandle = null;
    flow.stage = 'connecting';
    runtime.feedback = {
      tone: 'info',
      message: guestPreservingFeishuMessage('飞书身份验证通过，正在准备员工网络。')
    };
    touchRuntime('feishu authenticated; preparing staff promotion');
    await saveAndBroadcast();
    await promoteEmployeeConnection({
      provider: 'feishu',
      account: auth.user.email || auth.user.account || auth.user.userId,
      auth,
      bootstrap: {
        baseUrl: flow.baseUrl,
        resolveMode: flow.bootstrapResolveMode,
        fallback: null,
        preserveConfigBaseUrl: true
      },
      requestTag: 'feishu-employee'
    });
    if (pendingFeishuLogin === flow) {
      clearPendingFeishuLogin('completed', flow);
      broadcastState();
    }
  } catch (err) {
    if (pendingFeishuLogin !== flow) return;
    if (isFeishuAuthorizationTransactionMissingError(err)) {
      clearPendingFeishuLogin('token-transaction-missing', flow);
      runtime.feedback = {
        tone: 'danger',
        message: guestPreservingFeishuMessage(`飞书登录失败：${feishuTokenExchangeFailureMessage(err)}。请重新点击“使用飞书登录”发起新的授权。`)
      };
      queueDiagnosticError('auth.feishu-transaction-missing', err, {
        flowId: flow.id,
        stage: flow.stage
      });
      touchRuntime('feishu transaction missing');
      await saveAndBroadcast();
      return;
    }
    clearPendingFeishuLogin('token-exchange-failed', flow);
    runtime.feedback = {
      tone: 'danger',
      message: guestPreservingFeishuMessage(`飞书登录失败：${feishuTokenExchangeFailureMessage(err)}。`)
    };
    queueDiagnosticError('auth.feishu-login-failed', err);
    touchRuntime('feishu login failed');
    await saveAndBroadcast();
  }
}

function isFeishuAuthorizationTransactionMissingError(err) {
  return errorMessage(err)
    .toLowerCase()
    .includes('feishu authorization transaction is missing, expired, or already consumed');
}

function feishuTokenExchangeFailureMessage(err) {
  const message = errorMessage(err);
  return isFeishuAuthorizationTransactionMissingError(err)
    ? `${message}；本机 127.0.0.1 回调地址是正确的，请重新点击“使用飞书登录”。如果连续出现，请检查 Internal API 是否部署最新版本并使用同一个 Postgres 存储飞书授权交易。`
    : message;
}

async function rejectFeishuCallback(flow, reason) {
  if (pendingFeishuLogin !== flow) return;
  clearPendingFeishuLogin('provider-rejected', flow);
  runtime.feedback = {
    tone: 'warning',
    message: guestPreservingFeishuMessage(
      reason === 'access_denied'
        ? '已取消飞书授权。'
        : `飞书授权未完成（${sanitizeFeishuReason(reason)}）。`
    )
  };
  touchRuntime('feishu authorization rejected');
  await saveAndBroadcast();
}

async function expireFeishuLogin(flow) {
  if (pendingFeishuLogin !== flow) return;
  clearPendingFeishuLogin('expired', flow);
  runtime.feedback = {
    tone: 'warning',
    message: guestPreservingFeishuMessage('飞书登录等待超时，请重新发起授权。')
  };
  touchRuntime('feishu authorization expired');
  await saveAndBroadcast();
}

async function cancelFeishuLogin(reason) {
  const flow = pendingFeishuLogin;
  if (!flow) {
    runtime.feedback = {
      tone: 'info',
      message: '当前没有等待中的飞书登录。'
    };
    await saveAndBroadcast();
    return;
  }
  if (flow.stage === 'connecting') {
    runtime.feedback = {
      tone: 'info',
      message: '飞书身份已经验证，员工网络正在切换；此阶段请等待连接完成或取消系统授权。'
    };
    await saveAndBroadcast();
    return;
  }
  clearPendingFeishuLogin(reason, flow);
  runtime.feedback = {
    tone: 'warning',
    message: guestPreservingFeishuMessage('已取消飞书登录。')
  };
  touchRuntime('feishu login canceled');
  await saveAndBroadcast();
}

function clearPendingFeishuLogin(reason, expectedFlow = null) {
  const flow = pendingFeishuLogin;
  if (!flow || (expectedFlow && flow !== expectedFlow)) return false;
  pendingFeishuLogin = null;
  flow.canceledReason = reason;
  flow.codeVerifier = null;
  flow.exchangeHandle = null;
  if (flow.timeout) {
    clearTimeout(flow.timeout);
    flow.timeout = null;
  }
  closeFeishuCallbackServer(flow);
  return true;
}

function closeFeishuCallbackServer(flow) {
  const server = flow?.server;
  flow.server = null;
  if (!server) return;
  try {
    server.close();
  } catch {
    // The callback listener may already be closed after a completed request.
  }
}

function writeFeishuCallbackResponse(response, statusCode, title, message) {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'" />
  <title>MX-H2I 飞书登录</title>
  <style>body{margin:0;background:#171922;color:#eef1f3;font:16px/1.6 system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}.card{max-width:520px;margin:24px;padding:32px;border:1px solid #334057;border-radius:16px;background:#222633}h1{margin:0 0 12px;font-size:24px}p{margin:0;color:#aeb6c4}</style>
</head>
<body><main class="card"><h1>${escapeHtmlText(title)}</h1><p>${escapeHtmlText(message)}</p></main></body>
</html>`;
  response.writeHead(statusCode, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(html);
}

function visibleFeishuAuthFlow() {
  const flow = pendingFeishuLogin;
  if (!flow) return null;
  return {
    provider: 'feishu',
    stage: flow.stage,
    startedAt: flow.startedAt,
    expiresAt: flow.expiresAt,
    redirectUri: flow.redirectUri
  };
}

function feishuRedirectUri() {
  return `http://127.0.0.1:${feishuCallbackPort()}${FEISHU_CALLBACK_PATH}`;
}

function feishuCallbackPort() {
  const raw = nullableString(process.env.MX_H2I_FEISHU_CALLBACK_PORT);
  if (!raw) return DEFAULT_FEISHU_CALLBACK_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('MX_H2I_FEISHU_CALLBACK_PORT 必须是 1024 到 65535 之间的端口。');
  }
  return port;
}

function isSafeFeishuAuthorizationUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'accounts.feishu.cn'
      && url.port === ''
      && url.pathname === '/open-apis/authen/v1/authorize'
      && url.username === ''
      && url.password === ''
      && url.hash === '';
  } catch {
    return false;
  }
}

function isSafeFeishuExchangeHandle(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  return /^mxfx1\.[A-Za-z0-9_-]{43}$/.test(value)
    || /^mxfx2\.[A-Za-z0-9_-]{32,1800}\.[A-Za-z0-9_-]{43}$/.test(value);
}

function assertSecureFeishuTransport(bootstrap, operation) {
  const baseUrl = normalizeBaseUrl(
    typeof bootstrap === 'string' ? bootstrap : bootstrap?.baseUrl
  );
  if (feishuTransportIsSecure(baseUrl)) return baseUrl;
  const err = new Error(
    `飞书${operation || '登录'}禁止通过明文 bootstrap 传输。请先连接已验证的访客 WireGuard，或为 Internal bootstrap 配置有效 HTTPS。`
  );
  err.code = 'MX_FEISHU_INSECURE_TRANSPORT';
  throw err;
}

async function assertLiveSecureFeishuTransport(bootstrap, operation) {
  const baseUrl = assertSecureFeishuTransport(bootstrap, operation);
  const target = new URL(baseUrl);
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  if (
    target.protocol === 'https:'
    || hostname === '::1'
    || (net.isIP(hostname) === 4 && hostname.startsWith('127.'))
  ) {
    return baseUrl;
  }
  const connection = runtime?.connection || {};
  const routePlan = normalizeRoutePlan(connection.routePlan);
  const probe = routePlan
    ? await probeWireGuardForConnection({
        connection,
        routePlan,
        internalBaseUrl: connection.internalBaseUrl
      })
    : null;
  const liveOverlayReady = probe?.wireGuard?.active === true
    && probe?.diagnostics?.route?.ok === true
    && probe?.diagnostics?.internalApi?.ok === true;
  if (liveOverlayReady) {
    runtime.connection = {
      ...connection,
      wireGuard: probe.wireGuard,
      health: {
        ...connection.health,
        wireGuard: 'ready',
        internalApi: 'ready'
      },
      diagnostics: {
        ...(connection.diagnostics || {}),
        ...(probe.diagnostics || {}),
        feishuTransportProbe: {
          ok: true,
          operation: operation || '登录',
          updatedAt: nowIso()
        },
        updatedAt: nowIso()
      }
    };
    return baseUrl;
  }
  const err = new Error(
    `飞书${operation || '登录'}前的 WireGuard 实时复检未通过；授权码和登录令牌未发送。请恢复访客网络后重新授权。`
  );
  err.code = 'MX_FEISHU_OVERLAY_NOT_READY';
  throw err;
}

async function assertLiveSecureLauncherCapabilityTransport(bootstrap, operation) {
  const baseUrl = normalizeBaseUrl(
    typeof bootstrap === 'string' ? bootstrap : bootstrap?.baseUrl
  );
  if (!feishuTransportIsSecure(baseUrl)) {
    const err = new Error(
      `Launcher ${operation || 'lease capability 传输'}禁止使用未验证的明文 bootstrap。请配置有效 HTTPS、使用 loopback，或先建立并实时验证 Internal overlay。`
    );
    err.code = 'MX_LAUNCHER_CAPABILITY_INSECURE_TRANSPORT';
    throw err;
  }
  try {
    return await assertLiveSecureFeishuTransport(bootstrap, operation || 'lease capability 传输');
  } catch (cause) {
    const err = new Error(
      `Launcher ${operation || 'lease capability 传输'}前的 WireGuard 实时复检未通过；capability 与 bearer token 均未发送。`
    );
    err.code = 'MX_LAUNCHER_CAPABILITY_OVERLAY_NOT_READY';
    err.cause = cause;
    throw err;
  }
}

function feishuTransportIsSecure(baseUrl) {
  let target;
  try {
    target = new URL(baseUrl || '');
  } catch {
    return false;
  }
  if (target.username || target.password) return false;
  if (target.protocol === 'https:') return true;
  if (target.protocol !== 'http:') return false;
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  if (
    hostname === '::1'
    || (net.isIP(hostname) === 4 && hostname.startsWith('127.'))
  ) {
    return true;
  }
  const connection = runtime?.connection || {};
  if (!connectionHasReadyOverlayTransportProof(connection)) return false;
  const routePlan = normalizeRoutePlan(connection.routePlan);
  if (!routePlan) return false;
  let overlay;
  try {
    overlay = new URL(internalOverlayBaseUrl(
      routePlan,
      connection.internalBaseUrl || runtime?.config?.internalApiBaseUrl
    ));
  } catch {
    return false;
  }
  return target.origin === overlay.origin;
}

function secureStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function guestPreservingFeishuMessage(message) {
  const guestIp = runtime?.connection?.mode === 'guest'
    && isRetainedConnectionState(runtime.connection?.state)
    ? nullableString(runtime.connection.localIp)
    : null;
  return guestIp
    ? `${message} 当前访客连接（${guestIp}）保持不变。`
    : message;
}

function sanitizeFeishuReason(value) {
  return String(value || 'unknown')
    .replace(/[^a-z0-9._-]+/ig, '-')
    .slice(0, 64) || 'unknown';
}

function escapeHtmlText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function beginWindowDragSnapshot(inputDragId) {
  let bounds = mainWindow.getBounds();
  if (process.platform !== 'win32') return { bounds };
  const dragId = normalizeWindowDragId(inputDragId);
  if (dragId === null) return false;
  if (activeWindowDrag?.id === dragId) return { bounds: { ...activeWindowDrag } };
  if (dragId <= lastWindowDragId) return false;
  if (windowDragSizeBatchTimer) {
    clearTimeout(windowDragSizeBatchTimer);
    windowDragSizeBatchTimer = null;
  }
  if (activeWindowDrag) {
    applyWindowDragSizeSnapshot();
    bounds = mainWindow.getBounds();
  }
  lastWindowDragId = dragId;
  activeWindowDrag = {
    id: dragId,
    startX: bounds.x,
    startY: bounds.y,
    ...bounds
  };
  return { bounds: { ...activeWindowDrag } };
}

function normalizeWindowDragId(value) {
  const dragId = Number(value);
  return Number.isSafeInteger(dragId) && dragId > 0 ? dragId : null;
}

function scheduleWindowDragSizeCorrection() {
  if (process.platform !== 'win32' || !activeWindowDrag) return;
  // This must stay a trailing debounce. Repeated setBounds calls while a
  // frameless Windows window is moving can accumulate non-client/DPI width.
  if (windowDragSizeBatchTimer) clearTimeout(windowDragSizeBatchTimer);
  windowDragSizeBatchTimer = setTimeout(() => {
    windowDragSizeBatchTimer = null;
    applyWindowDragSizeSnapshot();
  }, WINDOW_DRAG_SIZE_BATCH_MS);
}

function applyWindowDragSizeSnapshot() {
  if (!activeWindowDrag || !mainWindow || mainWindow.isDestroyed()) return null;
  const current = mainWindow.getBounds();
  const target = {
    x: current.x,
    y: current.y,
    width: activeWindowDrag.width,
    height: activeWindowDrag.height
  };
  activeWindowDrag.x = target.x;
  activeWindowDrag.y = target.y;
  if (current.width !== target.width || current.height !== target.height) {
    windowBoundsTrackingSuppressed = true;
    try {
      mainWindow.setSize(target.width, target.height, false);
      mainWindow.setPosition(target.x, target.y, false);
    } catch (err) {
      console.warn('[mx-h2i] window drag size restore failed:', errorMessage(err));
      queueDiagnosticError('window.drag-size-restore-failed', err, { target });
    } finally {
      windowBoundsTrackingSuppressed = false;
    }
  }
  const restored = mainWindow.getBounds();
  activeWindowDrag.x = restored.x;
  activeWindowDrag.y = restored.y;
  lastVisibleBounds = { ...restored };
  return restored;
}

function finishWindowDragSnapshot(input) {
  if (process.platform !== 'win32' || !activeWindowDrag) return null;
  const dragId = normalizeWindowDragId(input?.dragId);
  if (dragId === null || activeWindowDrag.id !== dragId) return null;
  if (windowDragSizeBatchTimer) {
    clearTimeout(windowDragSizeBatchTimer);
    windowDragSizeBatchTimer = null;
  }
  const totalDx = Number(input?.totalDx);
  const totalDy = Number(input?.totalDy);
  if (Number.isFinite(totalDx) && Number.isFinite(totalDy)) {
    activeWindowDrag.x = Math.round(activeWindowDrag.startX + totalDx);
    activeWindowDrag.y = Math.round(activeWindowDrag.startY + totalDy);
    try {
      mainWindow.setPosition(activeWindowDrag.x, activeWindowDrag.y, false);
    } catch (err) {
      console.warn('[mx-h2i] final window drag position failed:', errorMessage(err));
      queueDiagnosticError('window.drag-position-restore-failed', err, {
        x: activeWindowDrag.x,
        y: activeWindowDrag.y
      });
    }
  }
  const bounds = applyWindowDragSizeSnapshot();
  activeWindowDrag = null;
  return bounds;
}

function resizeWindowForMode(mode) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const nextMode = mode === 'appcenter' ? 'appcenter' : 'launcher';
  if (currentWindowMode === nextMode) {
    applyWindowModeChrome(nextMode);
    const constrained = constrainWindowBounds(mainWindow.getBounds(), nextMode);
    if (!sameBounds(constrained, mainWindow.getBounds())) {
      setWindowBoundsWithoutTracking(constrained);
    }
    rememberWindowBoundsForMode(nextMode, mainWindow.getBounds());
    persistWindowStateSoon();
    showMainWindow();
    return;
  }
  rememberWindowBoundsForMode(currentWindowMode, mainWindow.getBounds());
  currentWindowMode = nextMode;
  isTopHidden = false;
  isTopDocked = false;
  topDockHidePending = false;
  topDockHoldUntil = 0;
  topDockLeaveStartedAt = 0;
  stopTopAnimation();
  applyWindowModeChrome(nextMode);
  setWindowBoundsWithoutTracking(windowBoundsForMode(nextMode));
  rememberWindowBoundsForMode(nextMode, mainWindow.getBounds());
  persistWindowStateSoon();
  showMainWindow();
}

function applyWindowModeChrome(mode) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  const minimum = windowMinimumSizeForMode(mode, bounds);
  mainWindow.setMinimumSize(minimum.width, minimum.height);
  mainWindow.setResizable(mode === 'appcenter');
}

function attachWindowBoundsTracking() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.on('resize', scheduleWindowBoundsSave);
  mainWindow.on('move', scheduleWindowBoundsSave);
}

function scheduleWindowBoundsSave() {
  if (!shouldPersistWindowBounds()) return;
  if (windowBoundsSaveTimer) clearTimeout(windowBoundsSaveTimer);
  windowBoundsSaveTimer = setTimeout(() => {
    windowBoundsSaveTimer = null;
    if (!shouldPersistWindowBounds()) return;
    rememberWindowBoundsForMode(currentWindowMode, mainWindow.getBounds());
    saveRuntime(runtime).catch((err) => {
      console.warn('[mx-h2i] failed to persist window bounds:', errorMessage(err));
    });
  }, WINDOW_BOUNDS_SAVE_DELAY_MS);
}

function persistWindowStateSoon() {
  if (!runtime) return;
  if (windowBoundsSaveTimer) clearTimeout(windowBoundsSaveTimer);
  windowBoundsSaveTimer = setTimeout(() => {
    windowBoundsSaveTimer = null;
    saveRuntime(runtime).catch((err) => {
      console.warn('[mx-h2i] failed to persist window state:', errorMessage(err));
    });
  }, WINDOW_BOUNDS_SAVE_DELAY_MS);
}

function shouldPersistWindowBounds() {
  if (windowBoundsTrackingSuppressed) return false;
  if (activeWindowDrag) return false;
  if (!runtime || !mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMinimized()) return false;
  if (currentWindowMode === 'launcher' && (isTopHidden || isTopHideAnimating || isTopDocked || topDockHidePending || topAnimationTimer)) {
    return false;
  }
  return true;
}

function rememberWindowBoundsForMode(mode = currentWindowMode, bounds = null) {
  if (!runtime) return;
  const normalizedMode = mode === 'appcenter' ? 'appcenter' : 'launcher';
  const normalizedBounds = normalizeWindowBounds(bounds);
  if (!normalizedBounds) return;
  const current = normalizeWindowState(runtime.window);
  runtime.window = {
    ...current,
    mode: normalizedMode,
    bounds: {
      ...current.bounds,
      [normalizedMode]: normalizedBounds
    }
  };
}

function windowBoundsForMode(mode) {
  const normalizedMode = mode === 'appcenter' ? 'appcenter' : 'launcher';
  const remembered = normalizeWindowState(runtime?.window).bounds[normalizedMode];
  const fallback = defaultWindowBoundsForMode(normalizedMode, remembered || mainWindow?.getBounds());
  return constrainWindowBounds(remembered || fallback, normalizedMode);
}

function defaultWindowBoundsForMode(mode, referenceBounds = null) {
  const normalizedMode = mode === 'appcenter' ? 'appcenter' : 'launcher';
  const display = referenceBounds
    ? electronScreen.getDisplayMatching(referenceBounds)
    : electronScreen.getPrimaryDisplay();
  const workArea = display.workArea;
  if (normalizedMode === 'appcenter') {
    const marginX = clamp(Math.round(workArea.width * 0.04), 24, 64);
    const marginY = clamp(Math.round(workArea.height * 0.055), 24, 60);
    const maxWidth = Math.max(720, workArea.width - marginX * 2);
    const maxHeight = Math.max(620, workArea.height - marginY * 2);
    const minWidth = Math.min(980, maxWidth);
    const minHeight = Math.min(680, maxHeight);
    let width = clamp(Math.round(workArea.width * 0.84), minWidth, Math.min(1440, maxWidth));
    let height = clamp(Math.round(width / 1.58), minHeight, Math.min(940, maxHeight));
    if (height > maxHeight) {
      height = maxHeight;
      width = clamp(Math.round(height * 1.58), minWidth, maxWidth);
    }
    return centeredBoundsInWorkArea({ width, height }, workArea);
  }
  const maxWidth = Math.max(410, workArea.width - 24);
  const maxHeight = Math.max(680, workArea.height - 24);
  const width = Math.min(462, maxWidth);
  const height = Math.min(760, maxHeight);
  return centeredBoundsInWorkArea({ width, height }, workArea);
}

function centeredBoundsInWorkArea(size, workArea) {
  return {
    x: Math.round(workArea.x + (workArea.width - size.width) / 2),
    y: Math.round(workArea.y + (workArea.height - size.height) / 2),
    width: Math.round(size.width),
    height: Math.round(size.height)
  };
}

function constrainWindowBounds(input, mode) {
  const normalizedMode = mode === 'appcenter' ? 'appcenter' : 'launcher';
  const normalized = normalizeWindowBounds(input) || defaultWindowBoundsForMode(normalizedMode);
  const display = electronScreen.getDisplayMatching(normalized);
  const workArea = display.workArea;
  const minimum = windowMinimumSizeForMode(normalizedMode, normalized);
  const launcherDefault = normalizedMode === 'launcher'
    ? defaultWindowBoundsForMode('launcher', normalized)
    : null;
  const width = launcherDefault?.width
    ?? clamp(normalized.width, minimum.width, Math.max(minimum.width, workArea.width));
  const height = launcherDefault?.height
    ?? clamp(normalized.height, minimum.height, Math.max(minimum.height, workArea.height));
  return {
    x: clamp(normalized.x, workArea.x, workArea.x + Math.max(0, workArea.width - width)),
    y: clamp(normalized.y, workArea.y, workArea.y + Math.max(0, workArea.height - height)),
    width,
    height
  };
}

function windowMinimumSizeForMode(mode, referenceBounds = null) {
  const display = referenceBounds
    ? electronScreen.getDisplayMatching(referenceBounds)
    : electronScreen.getPrimaryDisplay();
  const workArea = display.workArea;
  if (mode === 'appcenter') {
    return {
      width: Math.min(980, Math.max(520, workArea.width - 48)),
      height: Math.min(680, Math.max(480, workArea.height - 48))
    };
  }
  return {
    width: Math.min(410, Math.max(320, workArea.width - 24)),
    height: Math.min(680, Math.max(480, workArea.height - 24))
  };
}

function setWindowBoundsWithoutTracking(bounds) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  windowBoundsTrackingSuppressed = true;
  try {
    mainWindow.setBounds(bounds, false);
  } finally {
    windowBoundsTrackingSuppressed = false;
  }
}

function sameBounds(a, b) {
  return a && b
    && a.x === b.x
    && a.y === b.y
    && a.width === b.width
    && a.height === b.height;
}

function createTray() {
  if (tray) return;
  tray = new Tray(createTrayIcon());
  tray.setToolTip('MX-H2I');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 MX-H2I', click: () => showMainWindow() },
    { label: '收起到顶部', click: () => hideToTopEdge({ requireReentry: true }) },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]));
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
}

function createTrayIcon() {
  const assetPath = process.platform === 'darwin'
    ? path.join(__dirname, 'assets', 'mingxi-trayTemplate.png')
    : productIconPath();
  const icon = nativeImage.createFromPath(assetPath).resize({
    width: 22,
    height: 22,
    quality: 'best'
  });
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  return icon;
}

function productIconPath() {
  return path.join(__dirname, 'assets', 'mingxi-logo.png');
}

function snapToTopEdge() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const bounds = mainWindow.getBounds();
  const display = electronScreen.getDisplayMatching(bounds);
  isTopDocked = true;
  topDockHidePending = true;
  topDockHoldUntil = Date.now() + 260;
  topDockLeaveStartedAt = 0;
  const target = {
    x: bounds.x,
    y: display.workArea.y + TOP_DOCK_Y,
    width: bounds.width,
    height: bounds.height
  };
  animateWindow(bounds, target, 10, () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    lastVisibleBounds = mainWindow.getBounds();
  });
  return { docked: true, bounds: target };
}

function hideToTopEdge(options = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (currentWindowMode !== 'launcher' || isTopHidden || isTopHideAnimating) return;
  isTopHideAnimating = true;
  topDockHidePending = false;
  topDockHoldUntil = 0;
  topDockLeaveStartedAt = 0;
  const bounds = mainWindow.getBounds();
  const display = electronScreen.getDisplayMatching(bounds);
  lastVisibleBounds = { ...bounds };
  const targetY = display.workArea.y - bounds.height + TOP_REVEAL_ZONE;
  animateWindow(bounds, { ...bounds, y: targetY }, TOP_ANIMATION_STEPS, () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.hide();
    isTopHidden = true;
    isTopDocked = false;
    isTopHideAnimating = false;
    needsRevealZoneReentry = options.requireReentry !== false;
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  isTopHidden = false;
  isTopDocked = false;
  topDockHidePending = false;
  topDockHoldUntil = 0;
  topDockLeaveStartedAt = 0;
  needsRevealZoneReentry = false;
  applyWindowModeChrome(currentWindowMode);
  const remembered = normalizeWindowState(runtime?.window).bounds[currentWindowMode];
  const baseBounds = currentWindowMode === 'launcher'
    ? (lastVisibleBounds || remembered || mainWindow.getBounds())
    : (remembered || mainWindow.getBounds());
  const display = electronScreen.getDisplayMatching(baseBounds);
  const y = currentWindowMode === 'launcher'
    ? Math.max(baseBounds.y, display.workArea.y + dockActivationDistance(baseBounds, display) + 18)
    : baseBounds.y;
  const targetBounds = constrainWindowBounds({ ...baseBounds, y }, currentWindowMode);
  mainWindow.show();
  setWindowBoundsWithoutTracking(targetBounds);
  rememberWindowBoundsForMode(currentWindowMode, mainWindow.getBounds());
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function showFromTopEdge() {
  if (!mainWindow || mainWindow.isDestroyed() || !lastVisibleBounds) return;
  if (!isTopHidden || isTopHideAnimating) return;
  const bounds = lastVisibleBounds;
  const display = electronScreen.getDisplayMatching(bounds);
  const start = {
    ...bounds,
    y: display.workArea.y - bounds.height + TOP_REVEAL_ZONE
  };
  const target = {
    ...bounds,
    y: display.workArea.y + TOP_DOCK_Y
  };
  stopTopAnimation();
  try {
    mainWindow.setPosition(start.x, start.y, false);
  } catch (err) {
    recoverTopWindowAnimation('top-reveal-start', err, target);
    return;
  }
  mainWindow.showInactive();
  isTopHidden = false;
  isTopDocked = true;
  topDockHidePending = true;
  topDockHoldUntil = Date.now() + TOP_REVEAL_HOLD_MS;
  topDockLeaveStartedAt = 0;
  animateWindow(start, target, TOP_ANIMATION_STEPS, () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    lastVisibleBounds = mainWindow.getBounds();
  });
}

function startTopRevealWatcher() {
  if (topRevealTimer) clearInterval(topRevealTimer);
  topRevealTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const point = electronScreen.getCursorScreenPoint();
    if (topDockHidePending && !isTopHidden) {
      maybeHideTopDock(point);
      return;
    }
    if (!isTopHidden || !lastVisibleBounds) return;
    const display = electronScreen.getDisplayMatching(lastVisibleBounds);
    const withinX = point.x >= lastVisibleBounds.x && point.x <= lastVisibleBounds.x + lastVisibleBounds.width;
    const nearTop = point.y <= display.workArea.y + TOP_REVEAL_ZONE;
    if (needsRevealZoneReentry) {
      if (!withinX || !nearTop) needsRevealZoneReentry = false;
      return;
    }
    if (withinX && nearTop) showFromTopEdge();
  }, 160);
}

function startWireGuardRecoveryWatcher() {
  stopWireGuardRecoveryWatcher();
  scheduleWireGuardRecovery('app-ready', [2500, 12_000]);
  wireGuardRecoveryInterval = setInterval(() => {
    scheduleWireGuardRecovery('interval', [0]);
  }, 45_000);
  wireGuardRecoveryInterval.unref?.();
  powerMonitor?.on?.('resume', onPowerResume);
  powerMonitor?.on?.('unlock-screen', onUnlockScreen);
}

function stopWireGuardRecoveryWatcher() {
  if (wireGuardRecoveryInterval) clearInterval(wireGuardRecoveryInterval);
  wireGuardRecoveryInterval = null;
  while (wireGuardRecoveryTimers.length) {
    clearTimeout(wireGuardRecoveryTimers.pop());
  }
  powerMonitor?.off?.('resume', onPowerResume);
  powerMonitor?.off?.('unlock-screen', onUnlockScreen);
}

function onPowerResume() {
  scheduleWireGuardRecovery('power-resume', [2500, 12_000, 25_000]);
}

function onUnlockScreen() {
  scheduleWireGuardRecovery('unlock-screen', [1500, 10_000, 25_000]);
}

function scheduleWireGuardRecovery(reason, delays = [2500, 12_000, 25_000], options = {}) {
  const allowPrivileged = options.allowPrivileged === true;
  for (const delay of delays) {
    const timer = setTimeout(() => {
      const index = wireGuardRecoveryTimers.indexOf(timer);
      if (index >= 0) wireGuardRecoveryTimers.splice(index, 1);
      void recoverWireGuardForRuntime(reason, { allowPrivileged })
        .then((result) => maybeRefreshSystemDomainProxyAfterWireGuardRecovery(reason, result))
        .catch(() => undefined);
    }, Math.max(0, delay));
    timer.unref?.();
    wireGuardRecoveryTimers.push(timer);
  }
}

function startNetworkChangeWatcher() {
  stopNetworkChangeWatcher();
  if (!['darwin', 'win32'].includes(process.platform)) return;
  void pollNetworkSignature('startup').catch(() => undefined);
  networkChangeMonitorInterval = setInterval(() => {
    void pollNetworkSignature('interval').catch(() => undefined);
  }, NETWORK_CHANGE_MONITOR_MS);
  networkChangeMonitorInterval.unref?.();
}

function stopNetworkChangeWatcher() {
  if (networkChangeMonitorInterval) clearInterval(networkChangeMonitorInterval);
  networkChangeMonitorInterval = null;
  if (networkChangeDebounceTimer) clearTimeout(networkChangeDebounceTimer);
  networkChangeDebounceTimer = null;
  networkChangeInFlight = false;
}

async function pollNetworkSignature(reason) {
  if (networkChangeInFlight) return;
  networkChangeInFlight = true;
  try {
    const signature = await captureNetworkSignature();
    if (!signature) return;
    if (!lastNetworkSignature) {
      lastNetworkSignature = signature;
      return;
    }
    if (signature === lastNetworkSignature) return;
    lastNetworkSignature = signature;
    scheduleNetworkChangeRecovery(reason);
  } finally {
    networkChangeInFlight = false;
  }
}

function scheduleNetworkChangeRecovery(reason) {
  if (networkChangeDebounceTimer) clearTimeout(networkChangeDebounceTimer);
  networkChangeDebounceTimer = setTimeout(() => {
    networkChangeDebounceTimer = null;
    void handleNetworkChange(reason).catch((err) => {
      console.warn('[mx-h2i] network change recovery failed:', errorMessage(err));
    });
  }, NETWORK_CHANGE_DEBOUNCE_MS);
  networkChangeDebounceTimer.unref?.();
}

async function handleNetworkChange(reason) {
  const recoveryReason = `network-change-${reason || 'detected'}`;
  const endpointRouteRepair = await repairDarwinStaleEndpointRoutesForRuntime(recoveryReason, { force: true });
  await recordDarwinEndpointRouteRepairDiagnostics(endpointRouteRepair, recoveryReason);
  scheduleWireGuardRecovery(
    recoveryReason,
    endpointRouteRepair?.repaired ? [500, 2500, 8000] : [1500, 5000, 15_000],
    { allowPrivileged: false }
  );
  if (!systemDomainProxyRuntimeEligible()) return;
  await refreshSystemDomainProxyAfterNetworkChange(recoveryReason);
}

async function refreshSystemDomainProxyAfterNetworkChange(reason) {
  if (!systemDomainProxyManager || !systemDomainProxyRuntimeEligible()) return null;
  if (typeof systemDomainProxyManager.statusVerified === 'function') {
    const verified = await systemDomainProxyManager.statusVerified().catch(() => null);
    const withBrowserProof = await attachWindowsBrowserAccessProof(verified, reason);
    if (withBrowserProof?.applied === true && systemDomainProxyConnectionReady(withBrowserProof)) {
      await recordSystemDomainProxyDiagnostics({
        ...withBrowserProof,
        reason,
        verified: true,
        skipped: true,
        skipReason: 'network-change-verified'
      }, `system domain proxy verified: ${reason}`);
      return withBrowserProof;
    }
  }
  const status = await ensureSystemDomainProxyForRuntime('route-refresh');
  await recordSystemDomainProxyDiagnostics({
    ...(status && typeof status === 'object' ? status : {}),
    reason,
    verified: false,
    repairReason: 'network-change'
  }, `system domain proxy checked after network change: ${reason}`);
  return status;
}

async function maybeRefreshSystemDomainProxyAfterWireGuardRecovery(reason, result) {
  if (appShutdownRequested || wireGuardDisconnectInFlight) return null;
  if (!result?.ready || !systemDomainProxyRuntimeEligible()) return null;
  if (!shouldRefreshSystemDomainProxyAfterWireGuardRecovery(reason)) return null;
  return refreshSystemDomainProxyForRuntime('route-refresh');
}

function shouldRefreshSystemDomainProxyAfterWireGuardRecovery(reason) {
  const text = String(reason || '');
  return text === 'unlock-screen'
    || text === 'power-resume'
    || text.startsWith('network-change-');
}

async function captureNetworkSignature() {
  if (process.platform === 'win32') {
    return JSON.stringify({
      online: electronNet.isOnline(),
      interfaces: compactWindowsNetworkInterfaces(os.networkInterfaces())
    });
  }
  if (process.platform !== 'darwin') return null;
  const [route, services, networkInfo] = await Promise.all([
    darwinRouteGet('default'),
    execFileText('/usr/sbin/networksetup', ['-listallnetworkservices']).catch((err) => `services-error:${errorMessage(err)}`),
    execFileText('/usr/sbin/scutil', ['--nwi']).catch((err) => `nwi-error:${errorMessage(err)}`)
  ]);
  const serviceNames = compactDarwinNetworkServices(services);
  const autoProxy = await captureDarwinAutoProxySignature(serviceNames);
  return JSON.stringify({
    route: route?.ok === true
      ? {
          gateway: route.gateway || null,
          interfaceName: route.interfaceName || null,
          ifscope: route.ifscope || null,
          sourceAddress: route.sourceAddress || null
        }
      : { error: route?.error || 'default route unavailable' },
    services: serviceNames,
    autoProxy,
    networkInfo: compactDarwinNetworkInfo(networkInfo)
  });
}

function compactWindowsNetworkInterfaces(interfaces) {
  return Object.entries(interfaces || {})
    .flatMap(([name, addresses]) => (Array.isArray(addresses) ? addresses : [])
      .filter((address) => !address?.internal)
      .map((address) => ({
        name,
        address: nullableString(address?.address),
        family: nullableString(address?.family),
        netmask: nullableString(address?.netmask),
        mac: nullableString(address?.mac)
      })))
    .sort((left, right) => `${left.name}:${left.address}`.localeCompare(`${right.name}:${right.address}`));
}

function compactDarwinNetworkServices(stdout) {
  return String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('An asterisk'))
    .map((line) => line.replace(/^\*\s*/, ''))
    .sort();
}

async function captureDarwinAutoProxySignature(services) {
  const names = arrayValue(services, []).slice(0, 12);
  const rows = await Promise.all(names.map(async (name) => {
    const result = await execFileText('/usr/sbin/networksetup', ['-getautoproxyurl', name], {
      timeoutMs: DARWIN_PROXY_SIGNATURE_TIMEOUT_MS
    }).catch((err) => `autoproxy-error:${errorMessage(err)}`);
    return compactDarwinAutoProxyStatus(name, result);
  }));
  return rows.filter(Boolean).sort((left, right) => left.name.localeCompare(right.name));
}

function compactDarwinAutoProxyStatus(name, stdout) {
  const service = nullableString(name);
  if (!service) return null;
  const text = String(stdout || '');
  const url = nullableString(text.match(/URL:\s*(.*)$/im)?.[1]);
  const enabled = nullableString(text.match(/Enabled:\s*(.*)$/im)?.[1]);
  if (!url && !enabled && !/autoproxy-error:/i.test(text)) return null;
  return {
    name: service,
    enabled: enabled || null,
    url: url || null,
    error: /autoproxy-error:/i.test(text) ? text.slice(0, 160) : null
  };
}

function compactDarwinNetworkInfo(stdout) {
  return String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(IPv4|Reachable|Network interfaces|utun|en\d|awdl|llw|flags|nwi-error:)/i.test(line))
    .slice(0, 80);
}

function execFileText(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 2000;
    execFile(command, args, {
      timeout,
      maxBuffer: 256 * 1024
    }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

function appleScriptString(value) {
  return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function initializeSystemDomainProxy() {
  try {
    const mod = await importInstalledPackage('@qpjoy/electron-launcher/system-domain-proxy');
    systemDomainProxyManager = mod.createElectronLauncherSystemDomainProxy({
      userDataDir: app.getPath('userData'),
      pacPort: localEdgePort(),
      log: systemDomainProxyLogger()
    });
  } catch (err) {
    console.warn('[mx-h2i] system domain proxy unavailable:', errorMessage(err));
    queueDiagnosticError('system-domain-proxy.initialize-failed', err);
    systemDomainProxyManager = null;
    return;
  }

  try {
    if (process.platform === 'win32' || process.env.MX_H2I_RESTORE_SYSTEM_PROXY_ON_STARTUP === '1') {
      await systemDomainProxyManager.restoreStale('app-startup');
    } else {
      const status = typeof systemDomainProxyManager.status === 'function'
        ? systemDomainProxyManager.status()
        : null;
      if (status?.applied) {
        console.warn('[mx-h2i] system domain proxy state exists; startup restore skipped to avoid a macOS authorization prompt. Disconnect or reconnect MX-H2I to repair it.');
      }
    }
  } catch (err) {
    // Keep the manager and its durable state. A transient registry/UAC/owner
    // failure must remain retryable from startup refresh, manual repair, or
    // strict quit cleanup.
    console.warn('[mx-h2i] system domain proxy startup restore failed:', errorMessage(err));
    queueDiagnosticError('system-domain-proxy.startup-restore-failed', err);
  }
}

function systemDomainProxyLogger() {
  return {
    log: (...args) => console.log(...args),
    info: (...args) => console.info(...args),
    warn: (...args) => {
      console.warn(...args);
      queueDiagnosticLog('warning', 'system-domain-proxy.warning', args.map(String).join(' '));
    },
    error: (...args) => {
      console.error(...args);
      queueDiagnosticLog('error', 'system-domain-proxy.error', args.map(String).join(' '));
    }
  };
}

async function ensureSystemDomainProxyForRuntime(reason = 'manual') {
  if (appShutdownRequested) return shutdownSystemDomainProxyStatus(reason);
  if (systemDomainProxyEnsureInFlight) {
    const status = await systemDomainProxyEnsureInFlight;
    if (appShutdownRequested) return shutdownSystemDomainProxyStatus(reason);
    if (
      shouldApplySystemDomainProxyForReason(reason)
      && status?.skipped === true
      && status?.skipReason === 'background-refresh-no-privileged-apply'
    ) {
      return attachWindowsBrowserAccessProof(
        await ensureSystemDomainProxyForRuntimeOnce(reason),
        reason
      );
    }
    return status && typeof status === 'object'
      ? { ...status, reason, coalesced: true }
      : status;
  }
  const pending = ensureSystemDomainProxyForRuntimeOnce(reason)
    .then((status) => attachWindowsBrowserAccessProof(status, reason));
  systemDomainProxyEnsureInFlight = pending;
  try {
    return await pending;
  } finally {
    if (systemDomainProxyEnsureInFlight === pending) {
      systemDomainProxyEnsureInFlight = null;
    }
  }
}

async function ensureSystemDomainProxyForRuntimeOnce(reason = 'manual') {
  if (appShutdownRequested) return shutdownSystemDomainProxyStatus(reason);
  if (!systemDomainProxyManager) return null;
  if (process.platform === 'win32' && !windowsSystemPacEnabled()) {
    const disabled = await disableSystemDomainProxyForRuntime(`${reason}-windows-nrpt-only`);
    return {
      ...(disabled && typeof disabled === 'object' ? disabled : {}),
      supported: true,
      applied: false,
      platform: process.platform,
      reason,
      skipped: true,
      skipReason: 'windows-nrpt-only'
    };
  }
  if (!systemDomainProxyRuntimeEligible()) {
    return disableSystemDomainProxyForRuntime(`${reason}-not-connected`);
  }
  try {
    const backgroundRefresh = isBackgroundSystemDomainProxyReason(reason);
    const reverseProxyRoutes = await systemPacReverseProxyRoutes({
      allowWarnings: !backgroundRefresh,
      timeoutMs: backgroundRefresh ? SYSTEM_DOMAIN_PROXY_ROUTE_REFRESH_TIMEOUT_MS : 5000
    });
    const domains = uniqueStrings([
      ...splitDnsDomains(runtime?.config),
      ...reverseProxyRoutes.map((route) => route.host).filter(Boolean)
    ]);
    if (domains.length === 0) {
      return disableSystemDomainProxyForRuntime(`${reason}-no-domains`);
    }
    const policy = {
      enabled: true,
      domains,
      matchMode: 'proxy',
      proxy: localEdgeProxy(),
      pacPort: localEdgePort(),
      dnsServers: systemPacDnsServers(),
      dnsFallbackTarget: systemPacDnsFallbackTarget(),
      systemResolver: 'dynamic',
      reverseProxyRoutes,
      fallbackProxy: systemPacFallbackProxy(),
      ownershipClaim: systemDomainProxyOwnershipClaim(domains, reverseProxyRoutes)
    };
    const policySignature = systemDomainProxyPolicySignature(policy);
    const skipped = await maybeSkipSystemDomainProxyApply(reason, policySignature);
    if (skipped) return skipped;
    if (!shouldApplySystemDomainProxyForReason(reason)) {
      return currentSystemDomainProxyStatus(reason, {
        skipped: true,
        skipReason: 'background-refresh-no-privileged-apply',
        domains,
        reverseProxyRoutes
      });
    }
    try {
      let status = await systemDomainProxyManager.apply(policy);
      if (
        process.platform === 'darwin'
        && status?.applied === true
        && typeof systemDomainProxyManager.statusVerified === 'function'
      ) {
        status = {
          ...await systemDomainProxyManager.statusVerified(),
          reason
        };
      }
      lastSystemDomainProxyPolicySignature = policySignature;
      if (process.platform === 'win32' && pendingWindowsSystemProxyTakeoverSignature) {
        lastWindowsSystemProxyTakeoverSignature = pendingWindowsSystemProxyTakeoverSignature;
        pendingWindowsSystemProxyTakeoverSignature = null;
      }
      if (isSystemDomainProxyAuthorizationCanceled(status)) {
        lastSystemDomainProxyAuthorizationCanceledSignature = policySignature;
      } else if (status?.applied && !status?.error && !status?.resolverError) {
        lastSystemDomainProxyAuthorizationCanceledSignature = null;
      }
      return status;
    } catch (err) {
      lastSystemDomainProxyPolicySignature = policySignature;
      pendingWindowsSystemProxyTakeoverSignature = null;
      if (isSystemDomainProxyAuthorizationCanceled(err)) {
        lastSystemDomainProxyAuthorizationCanceledSignature = policySignature;
      }
      return {
        supported: true,
        applied: false,
        platform: process.platform,
        reason,
        domains,
        reverseProxyRoutes,
        error: errorMessage(err)
      };
    }
  } catch (err) {
    return {
      supported: true,
      applied: false,
      platform: process.platform,
      reason,
      error: errorMessage(err)
    };
  }
}

async function attachWindowsBrowserAccessProof(status, reason = 'manual') {
  if (process.platform !== 'win32') return status;
  const base = status && typeof status === 'object'
    ? status
    : {
        supported: Boolean(systemDomainProxyManager),
        applied: false,
        platform: process.platform,
        reason
      };
  const domains = splitDnsDomains(runtime?.config);
  const host = windowsSplitDnsDiagnosticHost(domains, base.reverseProxyRoutes);
  if (domains.length === 0) {
    return {
      ...base,
      browserReady: true,
      browserAccess: {
        supported: true,
        ready: true,
        host: null,
        port: null,
        pacApplied: base.applied === true,
        proxyReachable: false,
        skipped: true,
        skipReason: 'split-dns-not-configured',
        proofSessionId: WINDOWS_BROWSER_PROOF_SESSION_ID,
        checkedAt: nowIso()
      }
    };
  }
  if (!host) {
    const pacApplied = base.applied === true;
    return {
      ...base,
      browserReady: pacApplied,
      browserAccess: {
        supported: Boolean(systemDomainProxyManager),
        ready: pacApplied,
        host: null,
        port: null,
        pacApplied,
        proxyReachable: false,
        skipped: true,
        skipReason: WINDOWS_SPLIT_DNS_DIAGNOSTIC_HOST_MISSING,
        proofSessionId: WINDOWS_BROWSER_PROOF_SESSION_ID,
        checkedAt: nowIso(),
        error: pacApplied
          ? null
          : base.error || 'Windows Internal 浏览器 PAC 尚未应用。'
      }
    };
  }
  if (base.applied !== true || typeof systemDomainProxyManager?.probeBrowserAccess !== 'function') {
    return {
      ...base,
      browserReady: false,
      browserAccess: {
        supported: Boolean(systemDomainProxyManager),
        ready: false,
        host,
        port: windowsBrowserDiagnosticPort(host),
        pacApplied: base.applied === true,
        proxyReachable: false,
        proofSessionId: WINDOWS_BROWSER_PROOF_SESSION_ID,
        checkedAt: nowIso(),
        error: base.error || 'Windows Internal 浏览器 PAC 尚未应用。'
      }
    };
  }
  try {
    const browserAccess = await systemDomainProxyManager.probeBrowserAccess({
      host,
      port: windowsBrowserDiagnosticPort(host),
      timeoutMs: normalizePort(process.env.MX_H2I_WINDOWS_BROWSER_PROBE_TIMEOUT_MS, 12_000)
    });
    const chromiumProxy = browserAccess?.ready === true
      ? await probeWindowsChromiumSystemProxyDecision(
          host,
          windowsBrowserDiagnosticPort(host),
          browserAccess.proxy || localEdgeProxy()
        )
      : {
          ready: false,
          decision: null,
          error: browserAccess?.error || 'Local edge CONNECT proof failed.'
        };
    return {
      ...base,
      browserReady: browserAccess?.ready === true && chromiumProxy.ready === true,
      browserAccess: {
        ...browserAccess,
        ready: browserAccess?.ready === true && chromiumProxy.ready === true,
        chromiumProxy,
        proofSessionId: WINDOWS_BROWSER_PROOF_SESSION_ID,
        checkedAt: nowIso()
      }
    };
  } catch (err) {
    return {
      ...base,
      browserReady: false,
      browserAccess: {
        supported: true,
        ready: false,
        host,
        port: windowsBrowserDiagnosticPort(host),
        pacApplied: base.applied === true,
        proxyReachable: false,
        proofSessionId: WINDOWS_BROWSER_PROOF_SESSION_ID,
        checkedAt: nowIso(),
        error: errorMessage(err)
      }
    };
  }
}

async function probeWindowsChromiumSystemProxyDecision(host, port, expectedProxy) {
  if (process.platform !== 'win32' || !electronSession?.fromPartition) {
    return {
      ready: false,
      decision: null,
      expectedProxy,
      error: 'Chromium system-proxy session is unavailable.'
    };
  }
  try {
    const ses = electronSession.fromPartition('mx-h2i-windows-browser-proof', { cache: false });
    await ses.setProxy({ mode: 'system' });
    if (typeof ses.forceReloadProxyConfig === 'function') {
      await ses.forceReloadProxyConfig();
    }
    if (typeof ses.closeAllConnections === 'function') {
      await ses.closeAllConnections();
    }
    const targetUrl = `https://${host}:${port}/`;
    const decision = await withTimeout(
      ses.resolveProxy(targetUrl),
      5000,
      `Chromium system proxy decision timed out for ${targetUrl}`,
      'MX_WINDOWS_BROWSER_PROXY_DECISION_TIMEOUT'
    );
    const ready = proxyDecisionUsesEndpoint(decision, expectedProxy);
    return {
      ready,
      decision,
      expectedProxy,
      targetUrl,
      error: ready
        ? null
        : `Chromium resolved ${targetUrl} as ${decision || 'unknown'}, expected PROXY ${expectedProxy}.`
    };
  } catch (err) {
    return {
      ready: false,
      decision: null,
      expectedProxy,
      error: errorMessage(err)
    };
  }
}

function proxyDecisionUsesEndpoint(decision, expectedProxy) {
  const expected = nullableString(expectedProxy)?.replace(/^https?:\/\//i, '').toLowerCase();
  if (!expected) return false;
  return String(decision || '')
    .split(';')
    .map((part) => part.trim().toLowerCase())
    .some((part) => part === `proxy ${expected}` || part === `https ${expected}`);
}

function windowsBrowserDiagnosticPort(host) {
  const configured = normalizePort(process.env.MX_H2I_WINDOWS_BROWSER_DIAGNOSTIC_PORT, null);
  if (configured) return configured;
  for (const value of [
    runtime?.config?.bootstrapApiBaseUrl,
    process.env.MX_H2I_BOOTSTRAP_API_BASE_URL,
    `https://${DEFAULT_BOOTSTRAP_HOST}`
  ]) {
    const text = nullableString(value);
    if (!text || !/^https?:\/\//i.test(text)) continue;
    try {
      const url = new URL(text);
      if (host && url.hostname !== host) continue;
      return normalizePort(url.port, url.protocol === 'http:' ? 80 : 443);
    } catch {
      // Try the next configured URL.
    }
  }
  return 443;
}

function windowsBrowserAccessReady(status) {
  if (process.platform !== 'win32') return true;
  if (splitDnsDomains(runtime?.config).length === 0) return true;
  return status?.applied === true
    && status?.browserReady === true
    && status?.browserAccess?.ready === true
    && status?.browserAccess?.proofSessionId === WINDOWS_BROWSER_PROOF_SESSION_ID;
}

function windowsBrowserAccessProofSkipped(status) {
  return process.platform === 'win32'
    && status?.browserAccess?.skipped === true
    && status?.browserAccess?.skipReason === WINDOWS_SPLIT_DNS_DIAGNOSTIC_HOST_MISSING;
}

function systemDomainProxyConnectionReady(status) {
  const domains = splitDnsDomains(runtime?.config);
  if (process.platform === 'win32') return windowsBrowserAccessReady(status);
  if (process.platform === 'darwin') {
    return darwinSplitDnsStatusReady(status, domains);
  }
  return true;
}

function darwinSystemDomainProxyRepairEligible(connection = {}) {
  return process.platform === 'darwin'
    && connection?.state === 'tunnel-only'
    && connection?.health?.wireGuard === 'ready'
    && connection?.health?.internalApi === 'ready'
    && standaloneOwnershipReady(connection);
}

function systemDomainProxyRuntimeEligible() {
  const connection = runtime?.connection || {};
  if (connection.state === 'connected') {
    return standaloneOwnershipReady(connection);
  }
  if (darwinSystemDomainProxyRepairEligible(connection)) return true;
  if (process.platform !== 'win32' || connection.state !== 'tunnel-only') return false;
  return windowsBrowserPromotionPrerequisitesReady(connection);
}

async function prepareSystemDomainProxyForWireGuardInstall(reason = 'pre-connect') {
  if (!systemDomainProxyManager?.darwinPrepareApply || process.platform !== 'darwin') return null;
  try {
    const cachedRoutes = Array.isArray(lastSystemPacReverseProxyRoutes) ? lastSystemPacReverseProxyRoutes : [];
    const reverseProxyRoutes = cachedRoutes.length > 0
      ? cachedRoutes
      : await systemPacReverseProxyRoutes({
          allowWarnings: false,
          timeoutMs: 1500
        });
    const domains = uniqueStrings([
      ...splitDnsDomains(runtime?.config),
      ...reverseProxyRoutes.map((route) => route.host).filter(Boolean)
    ]);
    if (domains.length === 0) return null;
    const policy = {
      enabled: true,
      domains,
      matchMode: 'proxy',
      proxy: localEdgeProxy(),
      pacPort: localEdgePort(),
      dnsServers: systemPacDnsServers(),
      dnsFallbackTarget: systemPacDnsFallbackTarget(),
      systemResolver: 'dynamic',
      reverseProxyRoutes,
      fallbackProxy: systemPacFallbackProxy(),
      ownershipClaim: systemDomainProxyOwnershipClaim(domains, reverseProxyRoutes)
    };
    const status = await systemDomainProxyManager.darwinPrepareApply(policy);
    const shell = nullableString(status?.darwinApplyShell);
    if (!shell) return { status, shell: null };
    lastSystemDomainProxyPolicySignature = systemDomainProxyPolicySignature(policy);
    lastSystemDomainProxyAuthorizationCanceledSignature = null;
    return {
      status,
      shell
    };
  } catch (err) {
    return {
      status: {
        supported: true,
        applied: false,
        platform: process.platform,
        reason,
        error: errorMessage(err)
      },
      shell: null
    };
  }
}

function shouldSuppressWireGuardDnsForSystemDomainProxy(prepared = null) {
  if (process.platform !== 'darwin') return false;
  const status = prepared?.status;
  const expectedDomains = splitDnsDomains(runtime?.config);
  const resolverDomains = arrayValue(status?.resolverDomains, []);
  return Boolean(
    nullableString(prepared?.shell)
    && status?.applied === true
    && status?.pending === true
    && status?.externalApply === true
    && !status?.error
    && !status?.resolverError
    && nullableString(status?.proxy) === localEdgeProxy()
    && Number(status?.pacPort) === localEdgePort()
    && status?.systemResolverMode === 'dynamic'
    && Number(status?.resolverPort) === localEdgePort()
    && resolverRootsCoverDomains(expectedDomains, resolverDomains)
  );
}

async function disableSystemDomainProxyForRuntime(reason = 'manual', options = {}) {
  if (!systemDomainProxyManager) return null;
  lastSystemDomainProxySignature = null;
  lastSystemDomainProxyPolicySignature = null;
  lastSystemDomainProxyAuthorizationCanceledSignature = null;
  lastWindowsSystemProxyTakeoverSignature = null;
  pendingWindowsSystemProxyTakeoverSignature = null;
  lastWindowsSystemProxyContinuationRefreshAt = 0;
  lastSystemPacReverseProxyRoutes = [];
  lastSystemPacReverseProxyRoutesWarningAt = 0;
  try {
    return await systemDomainProxyManager.disable(reason, options);
  } catch (err) {
    return {
      supported: true,
      applied: false,
      platform: process.platform,
      reason,
      error: errorMessage(err)
    };
  }
}

async function disableSystemDomainProxyForRuntimeStrict(reason, attempts = 2, options = {}) {
  let status = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    status = await disableSystemDomainProxyForRuntime(reason, options);
    if (status && status.applied !== true && !status.error) return status;
    if (status?.actual?.sharedPacRetained === true) {
      const err = new Error(
        '本进程仍承载其他 Launcher owner 的 2053 local edge，无法安全关闭；请先断开依赖该 edge 的应用。'
      );
      err.status = status;
      throw err;
    }
    if (attempt < attempts) await delay(250);
  }
  const err = new Error(
    status?.error
    || `System proxy restore did not complete (${reason}).`
  );
  err.status = status;
  throw err;
}

async function drainSystemDomainProxyApply(reason, timeoutMs = 15_000) {
  const pending = systemDomainProxyEnsureInFlight;
  if (!pending) return { drained: true, pending: false };
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    await withTimeout(
      pending,
      timeoutMs,
      `Timed out waiting for the active system proxy apply (${reason}).`,
      'MX_SYSTEM_PROXY_DRAIN_TIMEOUT'
    );
  } else {
    await pending;
  }
  return { drained: true, pending: true };
}

async function drainWireGuardConnectOperations() {
  while (wireGuardConnectOperations.size > 0) {
    await Promise.allSettled([...wireGuardConnectOperations]);
  }
  return { drained: true };
}

async function drainWireGuardRecoveryOperation() {
  while (wireGuardRecoveryInFlight) {
    await Promise.allSettled([wireGuardRecoveryInFlight]);
  }
  return { drained: true };
}

function beginWireGuardConnectOperation() {
  let settled = false;
  let settle;
  const promise = new Promise((resolve) => {
    settle = resolve;
  });
  wireGuardConnectOperations.add(promise);
  wireGuardConnectInFlight = true;
  return {
    finish() {
      if (settled) return;
      settled = true;
      wireGuardConnectOperations.delete(promise);
      wireGuardConnectInFlight = wireGuardConnectOperations.size > 0;
      settle();
    }
  };
}

function supersededNetworkTransitionError() {
  const err = new Error('The network transition was superseded by disconnect or shutdown.');
  err.code = 'MX_NETWORK_TRANSITION_SUPERSEDED';
  return err;
}

function isSupersededNetworkTransitionError(value) {
  return value?.code === 'MX_NETWORK_TRANSITION_SUPERSEDED';
}

function assertNetworkTransitionCurrent(epoch) {
  if (
    wireGuardDisconnectInFlight
    || appShutdownRequested
    || epoch !== networkMutationEpoch
  ) {
    throw supersededNetworkTransitionError();
  }
}

async function completeExternalSystemDomainProxyApply(reason = 'external') {
  if (!systemDomainProxyManager?.completeExternalApply) return null;
  try {
    let status = await systemDomainProxyManager.completeExternalApply(reason);
    if (
      status?.applied === true
      && typeof systemDomainProxyManager.statusVerified === 'function'
    ) {
      const verified = await systemDomainProxyManager.statusVerified();
      status = {
        ...verified,
        reason,
        externalApply: true
      };
    }
    if (status?.applied && !status?.error && !status?.resolverError) {
      lastSystemDomainProxyAuthorizationCanceledSignature = null;
    }
    return status;
  } catch (err) {
    return {
      supported: true,
      applied: false,
      platform: process.platform,
      reason,
      error: errorMessage(err)
    };
  }
}

async function completeExternalSystemDomainProxyRestore(reason = 'external') {
  if (!systemDomainProxyManager?.completeExternalRestore) return null;
  lastSystemDomainProxySignature = null;
  lastSystemDomainProxyPolicySignature = null;
  lastSystemDomainProxyAuthorizationCanceledSignature = null;
  lastWindowsSystemProxyTakeoverSignature = null;
  pendingWindowsSystemProxyTakeoverSignature = null;
  lastWindowsSystemProxyContinuationRefreshAt = 0;
  lastSystemPacReverseProxyRoutes = [];
  lastSystemPacReverseProxyRoutesWarningAt = 0;
  try {
    return await systemDomainProxyManager.completeExternalRestore(reason);
  } catch (err) {
    return {
      supported: true,
      applied: false,
      platform: process.platform,
      reason,
      error: errorMessage(err)
    };
  }
}

async function closeSystemDomainProxy() {
  stopSystemDomainProxyRefreshWatcher();
  if (!systemDomainProxyManager) return;
  await systemDomainProxyManager.close?.();
}

function startSystemDomainProxyRefreshWatcher() {
  if (systemDomainProxyRefreshInterval) return;
  if (process.platform === 'win32' && !windowsSystemPacEnabled()) return;
  systemDomainProxyRefreshInterval = setInterval(() => {
    void refreshSystemDomainProxyForRuntime('route-refresh').catch(() => undefined);
  }, SYSTEM_DOMAIN_PROXY_REFRESH_MS);
  systemDomainProxyRefreshInterval.unref?.();
}

function stopSystemDomainProxyRefreshWatcher() {
  if (systemDomainProxyRefreshInterval) clearInterval(systemDomainProxyRefreshInterval);
  systemDomainProxyRefreshInterval = null;
  systemDomainProxyRefreshInFlight = false;
}

async function refreshSystemDomainProxyForRuntime(reason = 'manual') {
  if (appShutdownRequested) return shutdownSystemDomainProxyStatus(reason);
  if (wireGuardDisconnectInFlight) {
    return {
      supported: true,
      skipped: true,
      reason,
      skipReason: 'disconnect-in-flight'
    };
  }
  if (systemDomainProxyRefreshInFlight || !systemDomainProxyManager) return null;
  if (!systemDomainProxyRuntimeEligible()) {
    if (process.platform !== 'win32') return null;
    const status = await disableSystemDomainProxyForRuntime(`${reason}-not-eligible`);
    await recordSystemDomainProxyDiagnostics(status, `system domain proxy restored while inactive: ${reason}`);
    return status;
  }
  systemDomainProxyRefreshInFlight = true;
  try {
    const status = await ensureSystemDomainProxyForRuntime(reason);
    await recordSystemDomainProxyDiagnostics(status, `system domain proxy refreshed: ${reason}`);
    return status;
  } finally {
    systemDomainProxyRefreshInFlight = false;
  }
}

function shutdownSystemDomainProxyStatus(reason) {
  return {
    supported: true,
    applied: false,
    platform: process.platform,
    reason,
    skipped: true,
    skipReason: 'app-shutdown'
  };
}

async function recordSystemDomainProxyDiagnostics(status, touchReason) {
  const proxySignature = systemDomainProxyStatusSignature(status);
  if (!proxySignature) return false;
  const previousState = runtime.connection?.state;
  const browserReady = systemDomainProxyConnectionReady(status);
  const localEdgePrerequisitesReady = windowsLocalEdgePrerequisitesReady(runtime.connection);
  const browserPromotionPrerequisitesReady =
    windowsBrowserPromotionPrerequisitesReady(runtime.connection);
  const systemDnsReady = process.platform !== 'win32'
    || windowsSystemDnsDataPlaneReady(runtime.connection);
  const systemDnsDegraded = process.platform === 'win32'
    && localEdgePrerequisitesReady
    && !systemDnsReady;
  const signature = ['win32', 'darwin'].includes(process.platform)
    ? `${proxySignature}|state=${previousState || 'none'}|systemDns=${systemDnsReady}|ownership=${standaloneOwnershipReady(runtime.connection)}|localEdge=${localEdgePrerequisitesReady}`
    : proxySignature;
  if (signature === lastSystemDomainProxySignature) return false;
  lastSystemDomainProxySignature = signature;
  if (status?.error || status?.resolverError) {
    queueDiagnosticLog('error', 'system-domain-proxy.status-error', status.error || status.resolverError, {
      reason: status.reason,
      applied: status.applied,
      resolverApplied: status.resolverApplied,
      platform: status.platform
    });
  }
  const promoteWindows = process.platform === 'win32'
    && previousState === 'tunnel-only'
    && browserReady
    && browserPromotionPrerequisitesReady;
  const promoteDarwin = process.platform === 'darwin'
    && previousState === 'tunnel-only'
    && browserReady
    && runtime.connection?.health?.wireGuard === 'ready'
    && runtime.connection?.health?.internalApi === 'ready'
    && standaloneOwnershipReady(runtime.connection);
  const downgradeWindows = process.platform === 'win32'
    && previousState === 'connected'
    && !browserReady;
  const downgradeDarwin = process.platform === 'darwin'
    && previousState === 'connected'
    && !browserReady;
  const promote = promoteWindows || promoteDarwin;
  const downgrade = downgradeWindows || downgradeDarwin;
  const nextState = promote ? 'connected' : downgrade ? 'tunnel-only' : runtime.connection?.state;
  const browserFallback = process.platform === 'win32'
    ? windowsBrowserFallbackState({
        connection: runtime.connection,
        browserReady,
        connected: nextState === 'connected'
      })
    : null;
  const previousBrowserFallback =
    runtime.connection?.diagnostics?.windowsBrowserFallback || {};
  const browserFallbackChanged = process.platform === 'win32'
    && ['active', 'browserReady', 'systemDnsReady', 'nonPacProgramsReady']
      .some((key) => previousBrowserFallback[key] !== browserFallback[key]);
  runtime.connection = {
    ...runtime.connection,
    state: nextState,
    health: promote || downgrade
      ? {
          ...runtime.connection?.health,
          splitDns: promote ? 'ready' : 'blocked'
        }
      : runtime.connection?.health,
    diagnostics: {
      ...(runtime.connection?.diagnostics || {}),
      systemDomainProxy: status,
      ...(process.platform === 'win32'
        ? {
            windowsBrowserFallback: {
              ...browserFallback,
              updatedAt: nowIso()
            }
          }
        : {})
    }
  };
  if (promote) {
    const browserProofSkipped = windowsBrowserAccessProofSkipped(status);
    runtime.feedback = {
      tone: 'success',
      message: process.platform === 'darwin'
        ? 'macOS dynamic split DNS 与本机 DNS relay 已重新验证，Internal 浏览器和系统解析路径恢复 ready。'
        : browserProofSkipped
        ? 'Windows WireGuard、Internal API、NRPT 与系统 PAC 已 ready；当前没有 split-DNS 域名诊断主机，已跳过浏览器 CONNECT 证明。'
        : systemDnsDegraded
        ? `Windows 浏览器已通过 ${status?.browserAccess?.proxy || localEdgeProxy()} 访问 Internal；浏览器路径 ready，系统 DNS 未通过，非 PAC 程序仍为 degraded。`
        : `Windows 浏览器已通过 ${status?.browserAccess?.proxy || localEdgeProxy()} 访问 Internal，完整网络已 ready。`
    };
  } else if (downgrade) {
    runtime.feedback = {
      tone: 'warning',
      message: process.platform === 'darwin'
        ? `macOS split DNS 实时验证失败，连接降级为 tunnel-only：${status?.resolverError || status?.error || 'dynamic resolver/local DNS relay 未通过'}`
        : `Windows 浏览器 Internal 路径已失效，连接降级为 tunnel-only：${status?.browserAccess?.error || status?.error || 'PAC/local edge 未通过'}`
    };
  } else if (browserFallbackChanged && nextState === 'connected') {
    runtime.feedback = browserFallback.active
      ? {
          tone: 'warning',
          message: `Windows 浏览器仍通过 ${status?.browserAccess?.proxy || localEdgeProxy()} 访问 Internal；系统 DNS 已降级，非 PAC 程序尚未 ready。`
        }
      : browserFallback.systemDnsReady
        ? {
            tone: 'success',
            message: `Windows 浏览器与系统 DNS 均已恢复 Internal 路径，完整网络 ready。`
          }
        : runtime.feedback;
  }
  touchRuntime(touchReason);
  await saveAndBroadcast();
  if (promote || downgrade) {
    await publishNetworkModeEvent(
      runtime.connection?.mode === 'employee' ? 'staff:connect' : 'visit:connect',
      promote ? 'connected' : 'failed',
      {
        reason: promote
          ? `${process.platform}-domain-path-ready`
          : `${process.platform}-domain-path-lost`,
        transitionId: makeRequestId('browser-path')
      }
    );
  }
  return true;
}

async function refreshNetworkEnvironmentDiagnostics(reason = 'manual', options = {}) {
  if (!runtime) return null;
  const diagnostics = await collectNetworkEnvironmentDiagnostics(reason, options);
  if (options.expectedConnection && runtime.connection !== options.expectedConnection) {
    return diagnostics;
  }
  const signature = networkEnvironmentSignature(diagnostics);
  const shouldPersist = options.persist !== false;
  runtime.connection = {
    ...(runtime.connection || idleConnection()),
    diagnostics: {
      ...(runtime.connection?.diagnostics || {}),
      networkEnvironment: diagnostics,
      updatedAt: nowIso()
    }
  };
  if (signature && signature !== lastNetworkEnvironmentSignature) {
    lastNetworkEnvironmentSignature = signature;
    touchRuntime(`network environment: ${reason}`);
    if (shouldPersist) await saveAndBroadcast();
  }
  return diagnostics;
}

function scheduleNetworkEnvironmentDiagnostics(reason, options = {}) {
  const expectedConnection = runtime?.connection || null;
  void refreshNetworkEnvironmentDiagnostics(reason, {
    ...options,
    expectedConnection
  }).catch((err) => {
    console.warn(`[mx-h2i] ${reason} network diagnostics failed:`, errorMessage(err));
    queueDiagnosticError('network.diagnostics-background-failed', err, { reason });
  });
}

async function collectNetworkEnvironmentDiagnostics(reason = 'manual', options = {}) {
  const phase = options.phase || networkDiagnosticPhase();
  const host = options.host || networkDiagnosticHost();
  const status = await systemDomainProxyStatusForDiagnostics(phase);
  const endpointRoute = await collectDarwinEndpointRouteDiagnostics(reason, { phase });
  const windowsNrpt = await collectWindowsNrptDiagnostics();
  let resolution = null;
  try {
    const mod = await importInstalledPackage('@qpjoy/electron-launcher/network-diagnostics');
    const lookupTimeoutMs = Number(options.lookupTimeoutMs);
    const lookup = Number.isFinite(lookupTimeoutMs) && lookupTimeoutMs > 0
      ? (lookupHost) => withTimeout(
          dnsPromises.lookup(lookupHost, { all: true, family: 4 }),
          lookupTimeoutMs,
          `Network diagnostics DNS timeout for ${lookupHost}`,
          'MX_NETWORK_DIAGNOSTIC_TIMEOUT'
        )
      : null;
    resolution = await mod.diagnoseLauncherHostResolution({
      host,
      phase,
      expectedInternalTargets: expectedInternalDnsTargets(),
      internalCidrs: internalDiagnosticCidrs(),
      v1HdoCidrs: configuredCidrList(process.env.MX_H2I_V1_HDO_CIDRS),
      proxyFakeIpCidrs: configuredCidrList(process.env.MX_H2I_PROXY_FAKE_IP_CIDRS),
      ...(lookup ? { lookup } : {})
    });
  } catch (err) {
    resolution = {
      host: host || null,
      phase,
      addresses: [],
      state: 'unresolved',
      severity: phase === 'connected' ? 'error' : 'warning',
      ok: false,
      message: `网络解析诊断失败：${errorMessage(err)}`,
      expectedInternalTargets: expectedInternalDnsTargets(),
      internalCidrs: internalDiagnosticCidrs(),
      v1HdoCidrs: configuredCidrList(process.env.MX_H2I_V1_HDO_CIDRS),
      proxyFakeIpCidrs: configuredCidrList(process.env.MX_H2I_PROXY_FAKE_IP_CIDRS),
      error: errorMessage(err),
      updatedAt: nowIso()
    };
  }
  resolution = annotateResolutionWithWindowsNrpt(resolution, windowsNrpt);
  if (process.platform === 'win32' && phase === 'connected' && host) {
    resolution = {
      ...resolution,
      proofLayers: await collectWindowsDnsProofLayers({
        host,
        routePlan: runtime?.connection?.routePlan,
        windowsNrpt,
        nodeResolution: resolution
      })
    };
  }
  const diagnostics = {
    reason,
    phase,
    host: host || null,
    resolution,
    endpointRoute,
    windowsNrpt,
    systemDomainProxy: compactSystemDomainProxyStatus(status),
    priority: phase === 'connected'
      ? ['v2-split-dns', 'mx-h2i-wireguard', 'system-proxy-or-dns-for-unmatched', 'external-dns-for-unmatched']
      : ['bootstrap-dns-or-host-resolve', 'system-proxy-or-dns', 'external-dns'],
    updatedAt: nowIso()
  };
  if (resolution?.severity === 'error' || windowsNrpt?.ready === false) {
    queueDiagnosticLog(
      resolution?.severity === 'error' ? 'error' : 'warning',
      'network.diagnostics-problem',
      resolution?.message || `Windows NRPT state: ${windowsNrpt.state}`,
      { reason, phase, host, resolution, windowsNrpt, systemDomainProxy: diagnostics.systemDomainProxy }
    );
  }
  return diagnostics;
}

async function systemDomainProxyStatusForDiagnostics(phase) {
  const status = typeof systemDomainProxyManager?.status === 'function'
    ? systemDomainProxyManager.status()
    : null;
  if (phase !== 'connected' || typeof systemDomainProxyManager?.statusVerified !== 'function') {
    return status;
  }
  const verified = await systemDomainProxyManager.statusVerified().catch(() => status);
  return attachWindowsBrowserAccessProof(verified, 'diagnostics');
}

async function collectWindowsNrptDiagnostics() {
  if (process.platform !== 'win32') return null;
  const audit = collectWindowsNrptAuditDiagnostics();
  try {
    const mod = await importInstalledPackage('@qpjoy/electron-launcher/wireguard');
    const live = await launcherWindowsNrptStatus(mod);
    if (!live) return audit;
    return {
      platform: 'win32',
      ...live,
      source: 'live-powershell',
      audit
    };
  } catch (err) {
    return {
      platform: 'win32',
      configured: true,
      state: 'probe-failed',
      ready: false,
      source: 'live-powershell',
      error: errorMessage(err),
      audit
    };
  }
}

function collectWindowsNrptAuditDiagnostics() {
  if (process.platform !== 'win32') return null;
  const wireGuard = runtime?.connection?.wireGuard || {};
  const text = nullableString(wireGuard.routeLogTail) || nullableString(wireGuard.statusError) || '';
  if (!text) return null;
  const legacyComment = /comment=MX HDO \/ QPJoy HDO\s+mx-h2i/i.test(text);
  const currentComment = /comment=MX-H2I \/ QPJoy MX-H2I\s+mx-h2i/i.test(text);
  const addComplete = /nrpt add complete global=/i.test(text);
  const addStarted = /nrpt add start rules=/i.test(text);
  const removeComplete = /nrpt remove complete global=/i.test(text);
  const rulesMissing = /NRPT rules missing after add|nrpt assert namespace=.* count=0/i.test(text);
  const globalDisabled = /QueryPolicy=Disable|EnableDAForAllNetworks=Disable/i.test(text);
  const globalReady = /nrpt add complete global=.*QueryPolicy=QueryBoth/i.test(text)
    && /nrpt add complete global=.*EnableDAForAllNetworks=(EnableAlways|EnableDA|True|Enable|Enabled)/i.test(text);
  const state = legacyComment
    ? 'legacy-hdo-script'
    : rulesMissing
      ? 'rules-missing'
      : globalDisabled && !globalReady
        ? 'global-disabled'
        : removeComplete && !addStarted && !addComplete
          ? 'restart-remove-only'
          : globalReady
            ? 'ready'
            : currentComment
              ? 'current-script'
              : 'unknown';
  return {
    platform: 'win32',
    source: 'audit-derived',
    state,
    ready: state === 'ready',
    legacyComment,
    currentComment,
    addStarted,
    addComplete,
    removeComplete,
    rulesMissing,
    globalDisabled,
    globalReady,
    serviceState: nullableString(wireGuard.serviceState),
    routeLogPath: nullableString(wireGuard.routeLogPath)
  };
}

function annotateResolutionWithWindowsNrpt(resolution, windowsNrpt) {
  if (!resolution || typeof resolution !== 'object' || !windowsNrpt) return resolution;
  if (resolution.ok === true) return resolution;
  const hint = windowsNrptResolutionHint(windowsNrpt);
  if (!hint) return resolution;
  return {
    ...resolution,
    message: `${resolution.message || ''}${hint}`
  };
}

function windowsNrptResolutionHint(windowsNrpt) {
  if (!windowsNrpt || typeof windowsNrpt !== 'object') return '';
  if (windowsNrpt.state === 'legacy-hdo-script') {
    return '；审计日志检测到旧 MX-H2I NRPT 标记，请安装最新包后用管理员授权重连。NRPT 只接管配置的 Internal 域名，不会接管微信、豆包或 Steam 等公网域名。';
  }
  if (windowsNrpt.state === 'restart-remove-only') {
    return '；审计日志只看到移除 NRPT，尚未看到重新添加；请刷新实时诊断，仍失败则用管理员授权重连或修复网络。';
  }
  if (windowsNrpt.state === 'global-disabled') {
    return '；Windows 实时 NRPT 全局策略为 Disable，配置的 Internal 域名无法进入 split DNS；请用管理员授权重连或修复网络。该策略不负责公网应用域名。';
  }
  if (windowsNrpt.state === 'rules-missing') {
    if (windowsNrpt.profileMissingSplitDns === true) {
      return '；当前 WireGuard profile 的 Windows split-DNS namespace 或 DNS 地址与 Internal 当前配置不一致，请重新连接生成最新 profile；仅修复旧 profile 的路由不能补齐。';
    }
    return '；Windows 实时 NRPT 缺少 Internal namespace 规则；请用管理员授权重连或修复网络，并检查安全软件或组策略。';
  }
  if (windowsNrpt.state === 'name-server-mismatch') {
    return '；Windows 实时 NRPT 的 Internal namespace 仍指向旧 DNS，请用管理员授权修复；公网域名不在这组规则范围内。';
  }
  if (windowsNrpt.state === 'ready') {
    return '；Windows 实时 NRPT 已就绪，若 Internal 域名仍外部解析，请检查 Secure DNS/DoH、系统 DNS 缓存或第三方代理。';
  }
  if (windowsNrpt.state === 'probe-failed') {
    return '；无法读取 Windows 实时 NRPT，本条审计结论不能作为当前系统状态；请导出诊断包后再判断。';
  }
  return '';
}

async function repairSystemNetworkForRuntime(reason = 'manual-repair') {
  const before = await collectNetworkEnvironmentDiagnostics(`${reason}-before`);
  // User-triggered repair: allow one macOS admin prompt to delete stale
  // endpoint routes (route delete needs root). Background recovery paths keep
  // allowPrivileged off so no surprise auth dialogs appear.
  const endpointRouteRepair = await repairDarwinStaleEndpointRoutesForRuntime(reason, { force: true, allowPrivileged: true });
  const pendingCleanup = pendingWindowsCleanupDiagnostic(runtime?.connection);
  if (pendingCleanup) {
    return repairPendingWindowsCleanupForRuntime(
      reason,
      before,
      endpointRouteRepair,
      pendingCleanup
    );
  }
  const wireGuardSystemRepair = await repairWireGuardSystemStateForRuntime(reason);
  let wireGuardProbe = null;
  if (shouldRecoverWireGuardConnection(runtime?.connection)) {
    wireGuardProbe = await probeWireGuardForConnection({
      connection: runtime.connection,
      routePlan: runtime.connection.routePlan,
      internalBaseUrl: runtime.connection.internalBaseUrl
    });
    runtime.connection = {
      ...runtime.connection,
      state: wireGuardProbe.state,
      health: wireGuardProbe.health,
      wireGuard: wireGuardProbe.wireGuard,
      diagnostics: {
        ...(runtime.connection?.diagnostics || {}),
        ...(wireGuardProbe.diagnostics || {})
      }
    };
  }
  let systemDomainProxy = null;
  if (systemDomainProxyRuntimeEligible()) {
    systemDomainProxy = await ensureSystemDomainProxyForRuntime(reason);
  } else if (systemDomainProxyManager?.restoreStale) {
    try {
      systemDomainProxy = await systemDomainProxyManager.restoreStale(reason);
    } catch (err) {
      systemDomainProxy = {
        supported: true,
        applied: false,
        platform: process.platform,
        reason,
        error: errorMessage(err)
      };
    }
  } else {
    systemDomainProxy = await disableSystemDomainProxyForRuntime(reason);
  }
  let windowsSystemDnsDegraded = false;
  const windowsBrowserReady = process.platform === 'win32'
    && windowsBrowserAccessReady(systemDomainProxy);
  if (
    process.platform === 'win32'
    && runtime?.connection?.state === 'tunnel-only'
    && windowsBrowserPromotionPrerequisitesReady(runtime.connection)
    && windowsBrowserReady
  ) {
    runtime.connection = {
      ...runtime.connection,
      state: 'connected',
      health: {
        ...runtime.connection.health,
        splitDns: 'ready'
      }
    };
  }
  if (process.platform === 'win32') {
    const browserFallback = windowsBrowserFallbackState({
      connection: runtime.connection,
      browserReady: windowsBrowserReady,
      connected: runtime.connection?.state === 'connected'
    });
    windowsSystemDnsDegraded = Boolean(browserFallback.reason);
    runtime.connection = {
      ...runtime.connection,
      diagnostics: {
        ...(runtime.connection?.diagnostics || {}),
        windowsBrowserFallback: {
          ...browserFallback,
          updatedAt: nowIso()
        }
      }
    };
  }
  const connected = runtime?.connection?.state === 'connected';
  lastSystemDomainProxySignature = null;
  lastNetworkEnvironmentSignature = null;
  lastNetworkSignature = null;
  const after = await collectNetworkEnvironmentDiagnostics(`${reason}-after`, {
    phase: connected ? 'connected' : 'disconnected'
  });
  runtime.connection = {
    ...(runtime.connection || idleConnection()),
    diagnostics: {
      ...(runtime.connection?.diagnostics || {}),
      networkEnvironment: after,
      systemDomainProxy,
      networkRepair: {
        reason,
        connected,
        before,
        endpointRouteRepair,
        wireGuardSystemRepair,
        wireGuardProbe,
        systemDomainProxy,
        after,
        updatedAt: nowIso()
      },
      updatedAt: nowIso()
    }
  };
  runtime.feedback = {
    tone: systemDomainProxy?.error
      || wireGuardSystemRepair?.ok === false
      || (endpointRouteRepair?.stale === true && endpointRouteRepair?.repaired !== true)
      ? 'warning'
      : after?.resolution?.severity === 'error'
        ? 'warning'
        : 'success',
    message: connected
      ? `已重新确认 MX-H2I WireGuard 路由和 PAC/DNS：${after?.resolution?.message || 'network ready'}${windowsSystemDnsDegraded && windowsBrowserReady ? ' 浏览器路径 ready，非 PAC 程序的系统 DNS 仍为 degraded。' : ''}${darwinEndpointRouteRepairFeedback(endpointRouteRepair)}`
      : `已执行系统网络修复，但 WireGuard 尚未恢复 ready：${after?.resolution?.message || wireGuardProbe?.message || 'stale state cleared'}${darwinEndpointRouteRepairFeedback(endpointRouteRepair)}`
  };
  touchRuntime(`system network repaired: ${reason}`);
  return {
    before,
    endpointRouteRepair,
    wireGuardSystemRepair,
    wireGuardProbe,
    systemDomainProxy,
    after
  };
}

function pendingWindowsCleanupDiagnostic(connection = runtime?.connection) {
  if (process.platform !== 'win32') return null;
  const diagnostics = connection?.diagnostics;
  if (!diagnostics || typeof diagnostics !== 'object') return null;
  for (const key of ['disconnectCleanup', 'shutdownCleanup', 'startupCleanup']) {
    const value = diagnostics[key];
    if (!value || typeof value !== 'object') continue;
    if (
      value.ok !== true
      || value.cleanupReady !== true
      || value.localEdgeClosePending === true
      || value.ownershipReleasePending === true
    ) {
      return { key, value };
    }
  }
  return null;
}

async function runWindowsNetworkCleanupOnly(reason) {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      cleanupReady: false,
      stage: 'unsupported-platform',
      message: 'Windows cleanup-only flow is unavailable on this platform.'
    };
  }
  let systemDomainProxy = null;
  let wireGuard = null;
  let standaloneOwnership = null;
  try {
    systemDomainProxy = await disableSystemDomainProxyForRuntimeStrict(
      `${reason}-before-wireguard-stop`,
      2,
      { keepLocalEdgeAlive: true }
    );
  } catch (err) {
    return {
      ok: false,
      cleanupReady: false,
      stage: 'system-domain-proxy-restore',
      message: errorMessage(err),
      systemDomainProxy: err?.status || systemDomainProxy,
      wireGuard,
      standaloneOwnership
    };
  }
  wireGuard = await stopWireGuardForRuntime();
  if (wireGuard?.cleanupReady !== true) {
    return {
      ok: false,
      cleanupReady: false,
      stage: 'wireguard-nrpt-stop',
      message: wireGuard?.message
        || wireGuard?.windowsNrpt?.error
        || 'Windows WireGuard/NRPT cleanup could not be verified.',
      systemDomainProxy,
      wireGuard,
      standaloneOwnership
    };
  }
  try {
    systemDomainProxy = await disableSystemDomainProxyForRuntimeStrict(`${reason}-finalize`);
  } catch (err) {
    return {
      ok: false,
      cleanupReady: true,
      stage: 'local-edge-finalize',
      message: errorMessage(err),
      systemDomainProxy: err?.status || systemDomainProxy,
      wireGuard,
      standaloneOwnership
    };
  }
  standaloneOwnership = await releaseStandaloneOwnershipForRuntime(`${reason}-cleanup`);
  if (standaloneOwnership?.error) {
    return {
      ok: false,
      cleanupReady: true,
      stage: 'standalone-ownership-release',
      message: standaloneOwnership.error,
      systemDomainProxy,
      wireGuard,
      standaloneOwnership
    };
  }
  return {
    ok: true,
    cleanupReady: true,
    stage: 'complete',
    message: 'Windows WireGuard, NRPT, PAC/local edge and standalone ownership cleanup completed.',
    systemDomainProxy,
    wireGuard,
    standaloneOwnership
  };
}

async function repairPendingWindowsCleanupForRuntime(
  reason,
  before,
  endpointRouteRepair,
  pendingCleanup
) {
  const connection = runtime?.connection || idleConnection();
  const disconnectedMode = connection.mode === 'employee' ? 'employee' : 'guest';
  const disconnectedIp = nullableString(connection.localIp);
  const cleanup = await runWindowsNetworkCleanupOnly(reason);
  const cleanupDiagnostic = {
    ...pendingCleanup.value,
    ok: cleanup.ok === true,
    action: 'cleanup-only-retry',
    cleanupReady: cleanup.cleanupReady === true,
    localEdgeClosePending: cleanup.stage === 'local-edge-finalize',
    ownershipReleasePending: cleanup.stage === 'standalone-ownership-release',
    stage: cleanup.stage,
    message: cleanup.message,
    wireGuard: cleanup.wireGuard || pendingCleanup.value?.wireGuard || null,
    systemDomainProxy: cleanup.systemDomainProxy || null,
    standaloneOwnership: cleanup.standaloneOwnership || null,
    updatedAt: nowIso()
  };
  if (cleanup.ok === true) {
    runtime.connection = {
      ...idleConnection(),
      mode: disconnectedMode,
      diagnostics: {
        [pendingCleanup.key]: cleanupDiagnostic,
        updatedAt: nowIso()
      }
    };
    runtime.auth = null;
    await publishNetworkModeEvent(
      disconnectedMode === 'employee' ? 'staff:disconnect' : 'visit:disconnect',
      'disconnected',
      {
        leaseIp: disconnectedIp,
        reason: 'manual-cleanup-complete',
        transitionId: makeRequestId('manual-cleanup')
      }
    ).catch((err) => {
      queueDiagnosticError('network-mode.manual-cleanup-publish-failed', err);
    });
  } else {
    const routePlan = normalizeRoutePlan(connection.routePlan);
    runtime.connection = isRetainedConnectionState(connection.state) && routePlan
      ? {
          ...connection,
          state: 'lease-only',
          wireGuard: summarizeWireGuardStatus(cleanup.wireGuard?.status, connection),
          health: {
            ...normalizeHealth(connection.health, leasedHealth()),
            wireGuard: 'stale',
            internalApi: 'idle',
            splitDns: 'stale'
          },
          diagnostics: {
            ...(connection.diagnostics || {}),
            [pendingCleanup.key]: cleanupDiagnostic,
            updatedAt: nowIso()
          }
        }
      : {
          ...idleConnection(),
          mode: disconnectedMode,
          diagnostics: {
            ...(connection.diagnostics || {}),
            [pendingCleanup.key]: cleanupDiagnostic,
            updatedAt: nowIso()
          }
        };
  }
  lastSystemDomainProxySignature = null;
  lastNetworkEnvironmentSignature = null;
  lastNetworkSignature = null;
  const after = await collectNetworkEnvironmentDiagnostics(`${reason}-after`, {
    phase: 'disconnected'
  });
  const wireGuardSystemRepair = {
    ...cleanup,
    action: 'cleanup-only'
  };
  runtime.connection = {
    ...runtime.connection,
    diagnostics: {
      ...(runtime.connection?.diagnostics || {}),
      networkEnvironment: after,
      networkRepair: {
        reason,
        connected: false,
        cleanupOnly: true,
        cleanupDiagnostic: pendingCleanup.key,
        before,
        endpointRouteRepair,
        wireGuardSystemRepair,
        wireGuardProbe: null,
        systemDomainProxy: cleanup.systemDomainProxy || null,
        standaloneOwnership: cleanup.standaloneOwnership || null,
        after,
        updatedAt: nowIso()
      },
      updatedAt: nowIso()
    }
  };
  runtime.feedback = {
    tone: cleanup.ok === true ? 'success' : 'warning',
    message: cleanup.ok === true
      ? 'Windows WireGuard、NRPT、PAC/local edge 和 standalone ownership 已清理完成，当前为未连接。'
      : `Windows 清理仍未完成（${cleanup.stage}）：${cleanup.message}。本次修复没有恢复或启动 WireGuard。`
  };
  touchRuntime(
    cleanup.ok === true
      ? `Windows cleanup completed: ${reason}`
      : `Windows cleanup remains pending: ${reason}`
  );
  return {
    before,
    endpointRouteRepair,
    wireGuardSystemRepair,
    wireGuardProbe: null,
    systemDomainProxy: cleanup.systemDomainProxy || null,
    standaloneOwnership: cleanup.standaloneOwnership || null,
    after
  };
}

async function repairWireGuardSystemStateForRuntime(reason) {
  if (!shouldRecoverWireGuardConnection(runtime?.connection)) {
    if (process.platform !== 'win32') {
      return { ok: true, skipped: true, reason: 'connection-not-retained' };
    }
    try {
      const mod = await importInstalledPackage('@qpjoy/electron-launcher/wireguard');
      const options = wireGuardRuntimeOptions();
      const status = mod.getLauncherWireGuardPeerStatus(options);
      const windowsNrpt = typeof mod.getLauncherWireGuardNrptStatus === 'function'
        ? await mod.getLauncherWireGuardNrptStatus(options).catch(() => null)
        : null;
      if (windowsWireGuardCleanupConfirmed(
        { status },
        windowsNrpt,
        mod.launcherWindowsWireGuardCleanupReady,
        mod.launcherWindowsWireGuardTunnelCleanupReady
      )) {
        return {
          ok: true,
          skipped: true,
          reason: 'connection-not-retained-system-clean',
          status,
          windowsNrpt,
          cleanupReady: true
        };
      }
      return stopWireGuardForRuntime();
    } catch (err) {
      queueDiagnosticError('wireguard.idle-system-cleanup-failed', err, { reason });
      return {
        ok: false,
        reason,
        cleanupReady: false,
        message: errorMessage(err)
      };
    }
  }
  try {
    const mod = await importInstalledPackage('@qpjoy/electron-launcher/wireguard');
    const options = wireGuardRuntimeOptions();
    const status = mod.getLauncherWireGuardPeerStatus(options);
    if (status?.active === true) {
      return await mod.repairLauncherWireGuardPeerRoutes(options);
    }
    return await mod.recoverLauncherWireGuardPeer({ ...options, reason });
  } catch (err) {
    queueDiagnosticError('wireguard.system-route-repair-failed', err, { reason });
    return {
      ok: false,
      reason,
      message: errorMessage(err)
    };
  }
}

async function recordDarwinEndpointRouteRepairDiagnostics(result, reason) {
  if (!runtime || !result || result.supported !== true) return false;
  if (result.stale !== true && result.repaired !== true && !Array.isArray(result.repairs)) return false;
  runtime.connection = {
    ...(runtime.connection || idleConnection()),
    diagnostics: {
      ...(runtime.connection?.diagnostics || {}),
      endpointRouteRepair: result,
      updatedAt: nowIso()
    }
  };
  if (result.repaired === true) {
    runtime.feedback = {
      tone: 'info',
      message: `检测到网络切换后 relay endpoint 路由仍指向旧路径，已自动刷新：${darwinEndpointRouteRepairSummary(result)}`
    };
  } else if (result.stale === true) {
    runtime.feedback = {
      tone: 'warning',
      message: `检测到 relay endpoint 路由疑似仍指向旧路径：${darwinEndpointRouteRepairSummary(result)}${darwinEndpointRouteRepairFailure(result)}`
    };
  } else {
    return false;
  }
  touchRuntime(`endpoint route checked: ${reason}`);
  await saveAndBroadcast();
  return true;
}

async function collectDarwinEndpointRouteDiagnostics(reason = 'manual', options = {}) {
  if (process.platform !== 'darwin') return null;
  const targetSet = await darwinEndpointRouteTargets();
  const defaultRoute = await darwinPhysicalDefaultRoute();
  const routes = [];
  for (const target of targetSet.targets.slice(0, 8)) {
    const route = await darwinRouteGet(target.address);
    const classification = classifyDarwinEndpointRoute(route, defaultRoute);
    routes.push({
      target,
      ok: route.ok === true,
      routeTo: route.routeTo || null,
      destination: route.destination || null,
      gateway: route.gateway || null,
      interfaceName: route.interfaceName || null,
      ifscope: route.ifscope || null,
      sourceAddress: route.sourceAddress || null,
      flags: arrayValue(route.flags, []),
      stale: classification.stale,
      staleReason: classification.reason,
      error: route.error || null,
      raw: route.raw || null
    });
  }
  return {
    supported: true,
    platform: process.platform,
    reason,
    phase: options.phase || networkDiagnosticPhase(),
    targets: targetSet.targets,
    targetErrors: targetSet.errors,
    defaultRoute: defaultRoute.ok === true
      ? {
          gateway: defaultRoute.gateway || null,
          interfaceName: defaultRoute.interfaceName || null,
          ifscope: defaultRoute.ifscope || null,
          sourceAddress: defaultRoute.sourceAddress || null,
          flags: arrayValue(defaultRoute.flags, [])
        }
      : {
          ok: false,
          error: defaultRoute.error || 'default route unavailable'
        },
    routes,
    stale: routes.some((route) => route.stale === true),
    updatedAt: nowIso()
  };
}

async function repairDarwinStaleEndpointRoutesForRuntime(reason = 'manual', options = {}) {
  if (process.platform !== 'darwin') return null;
  const diagnostics = await collectDarwinEndpointRouteDiagnostics(reason, options);
  if (!diagnostics || diagnostics.supported !== true) return diagnostics;
  const staleRoutes = diagnostics.routes.filter((route) => route.stale === true && route.target?.address);
  const now = Date.now();
  const coolingDown = options.force !== true && now - lastDarwinEndpointRouteRepairAt < DARWIN_ENDPOINT_ROUTE_REPAIR_COOLDOWN_MS;
  const repairs = [];
  if (staleRoutes.length > 0 && !coolingDown) {
    lastDarwinEndpointRouteRepairAt = now;
  }
  for (const route of staleRoutes) {
    repairs.push({
      target: route.target,
      before: {
        gateway: route.gateway,
        interfaceName: route.interfaceName,
        sourceAddress: route.sourceAddress,
        flags: arrayValue(route.flags, []),
        staleReason: route.staleReason
      },
      ok: false,
      skipped: coolingDown || options.allowPrivileged !== true,
      skipReason: coolingDown ? 'cooldown' : options.allowPrivileged !== true ? 'privileged-repair-required' : null,
      requiresPrivilege: true,
      after: null,
      updatedAt: nowIso()
    });
  }
  // Route mutation always needs root. User-triggered repair installs a
  // deterministic physical-gateway /32 in one privileged batch; background
  // checks stay diagnostic-only and never surface an expected EPERM failure.
  let privilegedEscalation = null;
  if (options.allowPrivileged === true) {
    const candidates = repairs.filter((repair) => repair.skipped !== true && repair.target?.address);
    if (candidates.length > 0) {
      privilegedEscalation = await repairDarwinHostRoutesPrivileged(candidates, diagnostics.defaultRoute);
      for (const repair of candidates) {
        if (privilegedEscalation.ok !== true) {
          repair.privilegedError = privilegedEscalation.error;
          continue;
        }
        const afterRoute = await darwinRouteGet(repair.target.address);
        const afterClassification = classifyDarwinEndpointRoute(afterRoute, diagnostics.defaultRoute);
        repair.ok = afterRoute.ok === true && afterClassification.stale !== true;
        repair.privileged = true;
        repair.after = {
          ok: afterRoute.ok === true,
          gateway: afterRoute.gateway || null,
          interfaceName: afterRoute.interfaceName || null,
          sourceAddress: afterRoute.sourceAddress || null,
          flags: arrayValue(afterRoute.flags, []),
          stale: afterClassification.stale,
          staleReason: afterClassification.reason,
          error: afterRoute.error || null
        };
        if (repair.ok !== true) {
          repair.privilegedError = afterRoute.error || afterClassification.reason || 'route remained stale after privileged repair';
        }
        repair.updatedAt = nowIso();
      }
    }
  }
  return {
    ...diagnostics,
    repairs,
    privilegedEscalation,
    repaired: repairs.some((repair) => repair.ok === true && repair.after?.stale !== true),
    skipped: coolingDown,
    skipReason: coolingDown ? 'cooldown' : null,
    updatedAt: nowIso()
  };
}

async function repairDarwinHostRoutesPrivileged(repairs, defaultRoute) {
  const gateway = nullableString(defaultRoute?.gateway);
  if (!gateway || net.isIP(gateway) !== 4 || isDarwinProxyFakeGateway(gateway)) {
    return { ok: false, error: 'physical IPv4 default gateway is unavailable' };
  }
  const routes = objectList(repairs).filter((repair) => net.isIP(repair?.target?.address) === 4);
  if (routes.length === 0) return { ok: false, error: 'no privileged route repair targets' };
  const commands = routes.map((repair) => {
    const address = repair.target.address;
    const previousGateway = net.isIP(repair?.before?.gateway) === 4 ? repair.before.gateway : null;
    const deleteExact = previousGateway
      ? `/sbin/route -q -n delete -host ${address} ${previousGateway}`
      : `/sbin/route -q -n delete -host ${address}`;
    return `${deleteExact} >/dev/null 2>&1 || /sbin/route -q -n delete -host ${address} >/dev/null 2>&1 || true; /sbin/route -q -n add -host ${address} ${gateway} >/dev/null 2>&1 || /sbin/route -q -n change -host ${address} ${gateway}`;
  });
  const shellCommand = commands.join('; ');
  const script = `do shell script ${appleScriptString(shellCommand)} with administrator privileges`;
  try {
    await execFileText('/usr/bin/osascript', ['-e', script], { timeoutMs: 30_000 });
    return {
      ok: true,
      targets: routes.map((repair) => repair.target.address),
      gateway,
      interfaceName: defaultRoute?.interfaceName || null,
      sourceAddress: defaultRoute?.sourceAddress || null,
      command: shellCommand
    };
  } catch (err) {
    return {
      ok: false,
      targets: routes.map((repair) => repair.target.address),
      gateway,
      command: shellCommand,
      canceled: isUserAuthorizationCanceledError(err),
      error: errorMessage(err)
    };
  }
}

async function darwinEndpointRouteTargets() {
  const routePlan = normalizeRoutePlan(runtime?.connection?.routePlan);
  const candidates = [
    { source: 'connection.domesticRelayEndpoint', value: runtime?.connection?.domesticRelayEndpoint, endpoint: true },
    { source: 'routePlan.domesticRelayEndpoint', value: routePlan?.domesticRelayEndpoint, endpoint: true },
    { source: 'routePlan.h2iDirectEndpoint', value: routePlan?.h2iDirectEndpoint, endpoint: true },
    { source: 'config.domesticRelayHost', value: runtime?.config?.domesticRelayHost, endpoint: false },
    { source: 'default.domesticRelayHost', value: DEFAULT_CONFIG.domesticRelayHost, endpoint: false }
  ];
  const seenHosts = new Set();
  const uniqueCandidates = candidates.filter((candidate) => {
    const host = darwinEndpointRouteCandidateHost(candidate);
    const key = String(host || '').toLowerCase();
    if (!key || seenHosts.has(key)) return false;
    seenHosts.add(key);
    return true;
  });
  const targets = [];
  const errors = [];
  const resolvedCandidates = await Promise.all(
    uniqueCandidates.map((candidate) => resolveDarwinEndpointRouteCandidate(candidate))
  );
  for (const resolved of resolvedCandidates) {
    for (const row of resolved) {
      if (row.error) errors.push(row);
      else targets.push(row);
    }
  }
  const seen = new Set();
  return {
    targets: targets.filter((target) => {
      const key = target.address;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    errors
  };
}

function darwinEndpointRouteCandidateHost(candidate) {
  const text = nullableString(candidate?.value);
  if (!text) return null;
  return candidate.endpoint ? publicHostFromEndpoint(text) : hostnameFromMaybeUrl(text);
}

async function resolveDarwinEndpointRouteCandidate(candidate) {
  const text = nullableString(candidate.value);
  if (!text) return [];
  const host = darwinEndpointRouteCandidateHost(candidate);
  if (!host || host === 'localhost' || net.isIP(host) === 6) return [];
  if (net.isIP(host) === 4) {
    return isPublicIpv4Address(host)
      ? [{ source: candidate.source, value: text, host, address: host }]
      : [];
  }
  try {
    const rows = await withTimeout(
      dnsPromises.lookup(host, { family: 4, all: true }),
      DARWIN_ENDPOINT_ROUTE_PROBE_TIMEOUT_MS,
      `Darwin endpoint-route DNS timeout for ${host}`,
      'MX_DARWIN_ENDPOINT_DNS_TIMEOUT'
    );
    return rows
      .map((row) => nullableString(row?.address))
      .filter((address) => address && isPublicIpv4Address(address))
      .map((address) => ({ source: candidate.source, value: text, host, address }));
  } catch (err) {
    return [{
      source: candidate.source,
      value: text,
      host,
      address: null,
      error: errorMessage(err)
    }];
  }
}

async function darwinRouteGet(target) {
  const host = nullableString(target);
  if (!host) return { ok: false, error: 'empty route target' };
  try {
    let stdout;
    try {
      stdout = await execFileText('/sbin/route', ['-vn', 'get', host], {
        timeoutMs: DARWIN_ENDPOINT_ROUTE_PROBE_TIMEOUT_MS
      });
    } catch {
      stdout = await execFileText('/sbin/route', ['-n', 'get', host], {
        timeoutMs: DARWIN_ENDPOINT_ROUTE_PROBE_TIMEOUT_MS
      });
    }
    return {
      ok: true,
      ...parseDarwinRouteGet(stdout)
    };
  } catch (err) {
    return {
      ok: false,
      error: errorMessage(err),
      stderr: tailText(err?.stderr, 800),
      stdout: tailText(err?.stdout, 800)
    };
  }
}

async function darwinPhysicalDefaultRoute() {
  try {
    const mod = await importInstalledPackage('@qpjoy/electron-launcher/wireguard');
    return mod.probeDarwinPhysicalDefaultRoute();
  } catch (err) {
    return {
      ok: false,
      gateway: null,
      interfaceName: null,
      sourceAddress: null,
      flags: [],
      raw: null,
      error: errorMessage(err)
    };
  }
}

function parseDarwinRouteGet(stdout) {
  const text = String(stdout || '');
  const flags = pickDarwinRouteField(text, 'flags')
    ?.replace(/[<>]/g, '')
    .split(',')
    .map((flag) => flag.trim())
    .filter(Boolean) || [];
  return {
    routeTo: pickDarwinRouteField(text, 'route to'),
    destination: pickDarwinRouteField(text, 'destination'),
    gateway: pickDarwinRouteField(text, 'gateway'),
    interfaceName: pickDarwinRouteField(text, 'interface'),
    ifscope: pickDarwinRouteField(text, 'ifscope'),
    sourceAddress: parseDarwinRouteSourceAddress(text),
    flags,
    raw: tailText(text, 1200)
  };
}

function parseDarwinRouteSourceAddress(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (let index = 0; index < lines.length - 1; index += 1) {
    const fields = lines[index].match(/^\s*sockaddrs:\s*<([^>]+)>/i)?.[1]
      ?.split(',')
      .map((field) => field.trim().toUpperCase());
    const sourceIndex = fields?.indexOf('IFA') ?? -1;
    if (sourceIndex < 0) continue;
    const values = lines[index + 1].trim().split(/\s+/);
    const source = nullableString(values[sourceIndex]);
    if (source && net.isIP(source)) return source;
  }
  return null;
}

function pickDarwinRouteField(text, name) {
  const escaped = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return nullableString(String(text || '').match(new RegExp(`^\\s*${escaped}:\\s*(.+)$`, 'im'))?.[1]);
}

function classifyDarwinEndpointRoute(route, defaultRoute) {
  if (!route || route.ok !== true) return { stale: false, reason: null };
  const flags = new Set(arrayValue(route.flags, []));
  if (!flags.has('HOST')) return { stale: false, reason: null };
  const gateway = nullableString(route.gateway);
  const interfaceName = nullableString(route.interfaceName);
  const sourceAddress = nullableString(route.sourceAddress);
  const defaultGateway = nullableString(defaultRoute?.gateway);
  const defaultInterfaceName = nullableString(defaultRoute?.interfaceName);
  const defaultSourceAddress = nullableString(defaultRoute?.sourceAddress);
  if (isDarwinDynamicProxyEndpointRoute({
    gateway,
    flags: [...flags]
  })) {
    return { stale: false, reason: 'proxy-tun-dynamic-route' };
  }
  if (gateway && isDarwinProxyFakeGateway(gateway)) {
    return { stale: true, reason: `proxy-fake-gateway:${gateway}` };
  }
  // These targets are public relay endpoints; a pinned host route must follow
  // the current default path. The WG daemon installs a STATIC bypass route (no
  // WASCLONED flag), so a mismatch is stale regardless of how the route was
  // created — after a Wi-Fi switch it black-holes the bootstrap API until
  // deleted. IPv4 gateway and IFA/source mismatches are compared; direct/link
  // routes without those fields stay valid.
  if (gateway && defaultGateway && net.isIP(gateway) === 4 && net.isIP(defaultGateway) === 4 && gateway !== defaultGateway) {
    return { stale: true, reason: `gateway-mismatch:${gateway}->${defaultGateway}` };
  }
  if (interfaceName && defaultInterfaceName && interfaceName !== defaultInterfaceName) {
    return { stale: true, reason: `interface-mismatch:${interfaceName}->${defaultInterfaceName}` };
  }
  if (sourceAddress && defaultSourceAddress && net.isIP(sourceAddress) === 4 && net.isIP(defaultSourceAddress) === 4 && sourceAddress !== defaultSourceAddress) {
    return { stale: true, reason: `source-mismatch:${sourceAddress}->${defaultSourceAddress}` };
  }
  return { stale: false, reason: null };
}

function darwinEndpointRouteRepairFeedback(result) {
  if (!result || result.supported !== true) return '';
  if (result.repaired === true) return ' 已检测并刷新 relay endpoint 的旧 host route，请重试连接。';
  if (result.stale === true) return ` 检测到 relay endpoint host route 仍指向旧路径（${darwinEndpointRouteRepairSummary(result)}）${darwinEndpointRouteRepairFailure(result)}`;
  return '';
}

function darwinEndpointRouteRepairSummary(result) {
  const routes = objectList(result?.routes);
  const route = routes.find((item) => item?.stale === true) || routes[0];
  const target = route?.target?.address || route?.target?.host || 'unknown endpoint';
  const via = [route?.gateway, route?.interfaceName, route?.sourceAddress ? `source=${route.sourceAddress}` : null].filter(Boolean).join(' / ') || 'unknown route';
  return `${target} via ${via}`;
}

function darwinEndpointRouteRepairFailure(result) {
  const unchanged = objectList(result?.repairs).find((repair) => repair?.ok === true && repair?.after?.stale === true);
  if (unchanged) {
    const via = [unchanged.after?.gateway, unchanged.after?.interfaceName, unchanged.after?.sourceAddress ? `source=${unchanged.after.sourceAddress}` : null].filter(Boolean).join(' / ') || 'unknown route';
    return `，删除后系统仍解析到 ${via}。`;
  }
  const failed = objectList(result?.repairs).find((repair) => repair?.ok !== true && repair?.skipped !== true);
  if (!failed) return '。';
  if (failed.privilegedError) return `，系统路由修复失败：${failed.privilegedError}。`;
  if (failed.requiresPrivilege === true) return '，自动删除需要系统 route 权限。';
  return failed.error ? `，自动删除失败：${failed.error}。` : '，自动删除失败。';
}

function compactDarwinEndpointRouteSignature(result) {
  return {
    stale: result?.stale === true,
    repaired: result?.repaired === true,
    routes: objectList(result?.routes)
      .map((route) => ({
        target: route?.target?.address || null,
        gateway: route?.gateway || null,
        interfaceName: route?.interfaceName || null,
        sourceAddress: route?.sourceAddress || null,
        flags: arrayValue(route?.flags, []).sort(),
        stale: route?.stale === true,
        staleReason: route?.staleReason || null
      }))
      .sort((a, b) => String(a.target || '').localeCompare(String(b.target || ''))),
    repairs: objectList(result?.repairs)
      .map((repair) => ({
        target: repair?.target?.address || null,
        ok: repair?.ok === true,
        skipped: repair?.skipped === true,
        notFound: repair?.notFound === true,
        requiresPrivilege: repair?.requiresPrivilege === true,
        error: repair?.error || null
      }))
  };
}

function objectList(value) {
  return Array.isArray(value) ? value : [];
}

function isDarwinProxyFakeGateway(ip) {
  return isIpv4InCidr(ip, '198.18.0.0/15');
}

function isPublicIpv4Address(ip) {
  const value = ipv4ToInt(ip);
  if (value === null) return false;
  if (isIpv4InCidr(ip, '0.0.0.0/8')) return false;
  if (isIpv4InCidr(ip, '10.0.0.0/8')) return false;
  if (isIpv4InCidr(ip, '100.64.0.0/10')) return false;
  if (isIpv4InCidr(ip, '127.0.0.0/8')) return false;
  if (isIpv4InCidr(ip, '169.254.0.0/16')) return false;
  if (isIpv4InCidr(ip, '172.16.0.0/12')) return false;
  if (isIpv4InCidr(ip, '192.168.0.0/16')) return false;
  if (isIpv4InCidr(ip, '198.18.0.0/15')) return false;
  if (value >= ipv4ToInt('224.0.0.0')) return false;
  return true;
}

function isIpv4InCidr(ip, cidr) {
  const address = ipv4ToInt(ip);
  const [baseText, bitsText] = String(cidr || '').split('/');
  const base = ipv4ToInt(baseText);
  const bits = Number(bitsText);
  if (address === null || base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) === (base & mask);
}

function ipv4ToInt(ip) {
  const parts = String(ip || '').split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const number = Number(part);
    if (!Number.isInteger(number) || number < 0 || number > 255) return null;
    value = (value << 8) + number;
  }
  return value >>> 0;
}

function networkDiagnosticPhase() {
  const state = runtime?.connection?.state;
  if (state === 'connected' || state === 'tunnel-only') return 'connected';
  if (state === 'connecting') return 'bootstrap';
  return 'disconnected';
}

function networkDiagnosticHost() {
  const routeHost = preferredReverseProxyDiagnosticHost();
  const connectedInternalFallback = ['connected', 'tunnel-only'].includes(runtime?.connection?.state)
    ? LEGACY_DEFAULT_BOOTSTRAP_HOST
    : null;
  return firstHostname([
    process.env.MX_H2I_DNS_DIAGNOSTIC_HOST,
    routeHost,
    connectedInternalFallback,
    process.env.MX_H2I_BOOTSTRAP_DOMAIN,
    process.env.MX_H2I_BOOTSTRAP_HOST,
    runtime?.config?.bootstrapApiBaseUrl,
    DEFAULT_CONFIG.bootstrapApiBaseUrl,
    runtime?.config?.internalApiBaseUrl
  ]);
}

function preferredReverseProxyDiagnosticHost() {
  const routes = Array.isArray(lastSystemPacReverseProxyRoutes) ? lastSystemPacReverseProxyRoutes : [];
  const h2i = routes.find((route) => /(^|\.)h2i\./i.test(String(route?.host || '')));
  return nullableString(h2i?.host) || nullableString(routes.find((route) => route?.host)?.host);
}

function firstHostname(values) {
  for (const value of values) {
    const host = hostnameFromMaybeUrl(value);
    if (host) return host;
  }
  return null;
}

function hostnameFromMaybeUrl(value) {
  const text = nullableString(value);
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) {
    try {
      return new URL(text).hostname || null;
    } catch {
      return null;
    }
  }
  return text.replace(/:\d{1,5}$/, '') || null;
}

function expectedInternalDnsTargets(
  routePlanInput = runtime?.connection?.routePlan,
  connectionInput = runtime?.connection
) {
  const routePlan = normalizeRoutePlan(routePlanInput);
  const connection = connectionInput || {};
  return uniqueStrings([
    nullableString(routePlan?.internalControlIp),
    ipv4HostFromBaseUrl(routePlan?.internalBaseUrl),
    nullableString(connection?.internalControlIp),
    ipv4HostFromBaseUrl(connection?.internalBaseUrl),
    systemPacDnsFallbackTarget(),
    INTERNAL_PEER_IP
  ].filter(Boolean));
}

function internalDiagnosticCidrs(routePlanInput = runtime?.connection?.routePlan) {
  const routePlan = normalizeRoutePlan(routePlanInput);
  return uniqueStrings([
    ...configuredCidrList(process.env.MX_H2I_INTERNAL_CIDRS),
    ...arrayValue(routePlan?.routeCidrs, []).filter(isLikelyInternalDiagnosticCidr),
    '10.88.0.0/16',
    '10.89.0.0/16',
    '10.90.0.0/16'
  ].filter(Boolean));
}

async function probeWindowsSplitDnsResolution(routePlanInput, windowsNrpt) {
  if (process.platform !== 'win32') return null;
  const routePlan = normalizeRoutePlan(routePlanInput);
  const domains = splitDnsDomains(runtime?.config);
  if (domains.length === 0) {
    return {
      host: null,
      state: 'not-configured',
      severity: 'ok',
      ok: true,
      ready: true,
      skipped: true,
      skipReason: 'split-dns-not-configured',
      updatedAt: nowIso()
    };
  }
  const host = windowsSplitDnsDiagnosticHost(domains);
  if (!windowsNrptReadyForConnection(windowsNrpt)) {
    return {
      host,
      state: 'nrpt-not-ready',
      severity: 'error',
      ok: false,
      ready: false,
      skipped: true,
      skipReason: windowsNrpt?.state || 'nrpt-not-ready',
      message: 'Windows NRPT 元数据尚未 ready；已记录 Internal DNS 直查和默认解析，仅跳过 Node 端到端 ready 证明。',
      proofLayers: host
        ? await collectWindowsDnsProofLayers({
            host,
            routePlan,
            windowsNrpt,
            nodeSkipReason: 'nrpt-not-ready'
          })
        : null,
      updatedAt: nowIso()
    };
  }
  if (!host) {
    return {
      host: null,
      state: 'proof-skipped',
      severity: 'warning',
      ok: true,
      ready: true,
      skipped: true,
      skipReason: WINDOWS_SPLIT_DNS_DIAGNOSTIC_HOST_MISSING,
      message: '没有位于当前 split-DNS namespace 内的可诊断主机；已跳过 Windows 系统 DNS 端到端证明。',
      updatedAt: nowIso()
    };
  }
  let result = null;
  try {
    const mod = await importInstalledPackage('@qpjoy/electron-launcher/network-diagnostics');
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      result = await mod.diagnoseLauncherHostResolution({
        host,
        phase: 'connected',
        expectedInternalTargets: expectedInternalDnsTargets(routePlan),
        internalCidrs: internalDiagnosticCidrs(routePlan),
        v1HdoCidrs: configuredCidrList(process.env.MX_H2I_V1_HDO_CIDRS),
        proxyFakeIpCidrs: configuredCidrList(process.env.MX_H2I_PROXY_FAKE_IP_CIDRS),
        lookup: (lookupHost) => withTimeout(
          dnsPromises.lookup(lookupHost, { all: true, family: 4 }),
          1200,
          `Windows split DNS proof timeout for ${lookupHost}`,
          'MX_WINDOWS_SPLIT_DNS_PROOF_TIMEOUT'
        )
      });
      if (result?.ok === true || attempt === 3) break;
      await delay(250);
    }
  } catch (err) {
    result = {
      host,
      state: 'unresolved',
      severity: 'error',
      ok: false,
      error: errorMessage(err),
      message: `Windows split DNS 端到端解析失败：${errorMessage(err)}`,
      updatedAt: nowIso()
    };
  }
  return {
    ...result,
    ready: windowsNrptReadyForConnection(windowsNrpt) && result?.ok === true,
    proof: 'system-dns-lookup',
    proofLayers: await collectWindowsDnsProofLayers({
      host,
      routePlan,
      windowsNrpt,
      nodeResolution: result
    })
  };
}

function windowsSplitDnsDiagnosticHost(domains, reverseProxyRoutes = null) {
  const routeHosts = [
    ...arrayValue(Array.isArray(reverseProxyRoutes)
      ? reverseProxyRoutes.map((route) => nullableString(route?.host))
      : [], []),
    preferredReverseProxyDiagnosticHost()
  ].filter(Boolean);
  const candidates = [
    process.env.MX_H2I_DNS_DIAGNOSTIC_HOST,
    ...routeHosts,
    runtime?.config?.bootstrapApiBaseUrl,
    DEFAULT_BOOTSTRAP_HOST,
    runtime?.config?.internalApiBaseUrl
  ];
  return candidates
    .map(hostnameFromMaybeUrl)
    .find((host) => host && domains.some((domain) => host === domain || host.endsWith(`.${domain}`)))
    || null;
}

async function collectWindowsDnsProofLayers(input) {
  const host = nullableString(input?.host);
  const routePlan = normalizeRoutePlan(input?.routePlan);
  const powershellLayers = await probeWindowsResolveDnsNameLayers(host, routePlan?.dnsServer);
  const nodeResolution = input?.nodeResolution;
  return {
    directDns: powershellLayers.directDns,
    nrpt: {
      ...powershellLayers.nrpt,
      metadataReady: windowsNrptReadyForConnection(input?.windowsNrpt),
      metadataState: nullableString(input?.windowsNrpt?.state)
    },
    nodeGetaddrinfo: {
      proof: 'node-getaddrinfo',
      host,
      ok: nodeResolution?.ok === true,
      skipped: Boolean(input?.nodeSkipReason),
      skipReason: nullableString(input?.nodeSkipReason),
      state: nullableString(nodeResolution?.state) || (input?.nodeSkipReason ? 'skipped' : 'unknown'),
      addresses: Array.isArray(nodeResolution?.addresses) ? nodeResolution.addresses.slice(0, 16) : [],
      error: nullableString(nodeResolution?.error),
      message: nullableString(nodeResolution?.message)
    }
  };
}

async function probeWindowsResolveDnsNameLayers(hostInput, dnsServerInput) {
  const host = nullableString(hostInput);
  const dnsServer = nullableString(dnsServerInput);
  const failed = (proof, server, error, state = 'query-failed') => ({
    proof,
    host,
    server,
    ok: false,
    state,
    addresses: [],
    records: [],
    error
  });
  if (!host) {
    return {
      directDns: failed('internal-dns-direct', dnsServer, 'diagnostic host is missing', 'invalid-host'),
      nrpt: failed('windows-nrpt-default-resolver', null, 'diagnostic host is missing', 'invalid-host')
    };
  }

  const [directDns, nrpt] = await Promise.all([
    dnsServer
      ? probeWindowsResolveDnsNameLayer({
          host,
          dnsServer,
          proof: 'internal-dns-direct'
        })
      : Promise.resolve(
          failed('internal-dns-direct', null, 'routePlan.dnsServer is missing', 'dns-server-not-configured')
        ),
    probeWindowsResolveDnsNameLayer({
      host,
      dnsServer: null,
      proof: 'windows-nrpt-default-resolver'
    })
  ]);
  return { directDns, nrpt };
}

async function probeWindowsResolveDnsNameLayer(input) {
  const host = input.host;
  const dnsServer = input.dnsServer;
  const identity = {
    proof: input.proof,
    host,
    server: dnsServer
  };
  const query = dnsServer
    ? 'Resolve-DnsName -Name $name -Server $server -Type A -DnsOnly -NoHostsFile -ErrorAction Stop'
    : 'Resolve-DnsName -Name $name -Type A -DnsOnly -NoHostsFile -ErrorAction Stop';
  const powershellScript = [
    "$ErrorActionPreference = 'Stop'",
    '$result = $null',
    'try {',
    `$name = ${windowsPowerShellLiteral(host)}`,
    `$server = ${dnsServer ? windowsPowerShellLiteral(dnsServer) : '$null'}`,
    `  $records = @(${query} | Select-Object -Property Name,Type,TTL,Section,IPAddress,NameHost -First 16)`,
    '  $addresses = @($records | ForEach-Object { $_.IPAddress } | Where-Object { $_ })',
    "  $state = if ($addresses.Count -gt 0) { 'resolved' } else { 'no-a-records' }",
    '  $result = [ordered]@{ ok = ($addresses.Count -gt 0); state = $state; addresses = $addresses; records = $records; error = $null }',
    '} catch {',
    "  $result = [ordered]@{ ok = $false; state = 'query-failed'; addresses = @(); records = @(); error = $_.Exception.Message }",
    '}',
    '$result | ConvertTo-Json -Depth 5 -Compress'
  ].join('\r\n');

  try {
    const stdout = await execFileText(windowsPowerShellCommandForDiagnostics(), [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      powershellScript
    ], { timeoutMs: 3500 });
    const parsed = parseJsonText(stdout);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Resolve-DnsName output was not valid JSON.');
    }
    return normalizeWindowsDnsProofLayer(parsed, identity);
  } catch (err) {
    return {
      ...identity,
      ok: false,
      state: 'query-failed',
      addresses: [],
      records: [],
      error: errorMessage(err)
    };
  }
}

function normalizeWindowsDnsProofLayer(value, identity) {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const records = Array.isArray(row.records)
    ? row.records
    : row.records && typeof row.records === 'object'
      ? [row.records]
      : [];
  const addresses = uniqueStrings(Array.isArray(row.addresses) ? row.addresses : [row.addresses]);
  return {
    proof: identity.proof,
    host: identity.host,
    server: identity.server,
    ok: row.ok === true && addresses.length > 0,
    state: nullableString(row.state) || (addresses.length > 0 ? 'resolved' : 'query-failed'),
    addresses,
    records: records.slice(0, 16).map((record) => ({
      name: nullableString(record?.Name),
      type: nullableString(String(record?.Type ?? '')),
      ttl: Number.isFinite(record?.TTL) ? record.TTL : null,
      section: nullableString(String(record?.Section ?? '')),
      ipAddress: nullableString(record?.IPAddress),
      nameHost: nullableString(record?.NameHost)
    })),
    error: nullableString(row.error)
  };
}

function windowsPowerShellLiteral(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function configuredCidrList(value) {
  return String(value || '')
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isLikelyInternalDiagnosticCidr(value) {
  const text = String(value || '').trim();
  return /^10\./.test(text) || /^172\.(1[6-9]|2\d|3[01])\./.test(text) || /^192\.168\./.test(text);
}

function ipv4HostFromBaseUrl(value) {
  const baseUrl = normalizeBaseUrl(value);
  if (!baseUrl) return null;
  try {
    const host = new URL(baseUrl).hostname;
    return net.isIP(host) === 4 ? host : null;
  } catch {
    return null;
  }
}

function compactSystemDomainProxyStatus(status) {
  if (!status || typeof status !== 'object') return null;
  return {
    supported: status.supported === true,
    applied: status.applied === true,
    verified: status.verified === true,
    skipped: status.skipped === true,
    reason: nullableString(status.reason),
    skipReason: nullableString(status.skipReason),
    pacUrl: nullableString(status.pacUrl),
    proxy: nullableString(status.proxy),
    fallbackProxy: nullableString(status.fallbackProxy),
    fallbackPacUrl: nullableString(status.fallbackPacUrl),
    browserReady: status.browserReady === true,
    browserAccess: status.browserAccess && typeof status.browserAccess === 'object'
      ? {
          ready: status.browserAccess.ready === true,
          host: nullableString(status.browserAccess.host),
          port: status.browserAccess.port || null,
          pacApplied: status.browserAccess.pacApplied === true,
          proxyReachable: status.browserAccess.proxyReachable === true,
          proxyStatusCode: status.browserAccess.proxyStatusCode || null,
          error: nullableString(status.browserAccess.error)
        }
      : null,
    systemResolverMode: nullableString(status.systemResolverMode),
    resolverApplied: status.resolverApplied === true,
    resolverError: nullableString(status.resolverError),
    resolverDomains: arrayValue(status.resolverDomains, []),
    resolverPort: status.resolverPort || null,
    ownershipRegistry: status.ownershipRegistry && typeof status.ownershipRegistry === 'object'
      ? {
          owners: Array.isArray(status.ownershipRegistry.owners)
            ? status.ownershipRegistry.owners.map((owner) => nullableString(owner?.ownerId)).filter(Boolean)
            : [],
          conflicts: Array.isArray(status.ownershipRegistry.conflicts)
            ? status.ownershipRegistry.conflicts
            : []
        }
      : null,
    staleState: status.staleState === true,
    stalePreviousPacSkipped: status.stalePreviousPacSkipped === true,
    stalePreviousProxySkipped: status.stalePreviousProxySkipped === true,
    error: nullableString(status.error)
  };
}

function systemDomainProxyOwnershipClaim(domains, reverseProxyRoutes) {
  const connection = runtime?.connection || {};
  const productId = launcherProductId();
  return {
    ownerId: standaloneOwnershipOwnerId(),
    productId,
    instanceId: standaloneOwnershipInstanceId(),
    displayName: launcherProductDisplayName(),
    state: connection.state === 'connecting' ? 'connecting' : 'active',
    priority: 100,
    leaseIp: nullableString(connection.localIp),
    gatewayIp: systemPacDnsFallbackTarget(),
    dnsZones: arrayValue(domains, []),
    dnsHosts: arrayValue(reverseProxyRoutes, []).map((route) => nullableString(route?.host)).filter(Boolean),
    routeCidrs: productOwnershipRouteCidrs(connection.routePlan, connection),
    reverseProxyRoutes: arrayValue(reverseProxyRoutes, []),
    metadata: {
      channel: runtime?.config?.releaseChannel || null,
      mode: connection.mode || null
    },
    updatedAt: nowIso()
  };
}

async function upsertStandaloneOwnershipForRoutePlan(
  routePlan,
  connection = {},
  reason = 'manual',
  ownerState = 'connecting'
) {
  try {
    const mod = await importInstalledPackage('@qpjoy/electron-launcher/standalone-data-plane');
    const claim = mxH2iStandaloneOwnershipClaim(mod, routePlan, connection);
    const nextClaim = {
      ...claim,
      state: ownerState,
      updatedAt: nowIso()
    };
    let ownershipState = mod.claimElectronLauncherStandaloneOwnershipClaim(nextClaim);
    if (ownershipState?.claimed === false && process.platform === 'darwin') {
      const proof = await darwinOwnershipSupersessionProof(reason);
      const supersedeOwnerIds = darwinSupersedableOwnershipOwnerIds({
        platform: process.platform,
        productId: claim.productId,
        currentOwnerId: claim.ownerId,
        claims: ownershipState.claims,
        conflicts: ownershipState.registry?.conflicts,
        tunnelInactive: proof.tunnelInactive,
        retainedDataPlaneProven: proof.retainedDataPlaneProven
      });
      if (supersedeOwnerIds.length > 0) {
        const supersedeClaims = objectList(ownershipState.claims)
          .filter((row) => supersedeOwnerIds.includes(row?.ownerId));
        ownershipState = mod.claimElectronLauncherStandaloneOwnershipClaim(nextClaim, {
          supersedeClaims
        });
        if (ownershipState.claimed === true) {
          queueDiagnosticLog(
            'warning',
            'standalone-ownership.same-product-adopted',
            'Recovered an orphaned MX-H2I ownership claim after installation identity changed.',
            {
              reason,
              supersededOwnerIds: ownershipState.supersededOwnerIds,
              ownerId: claim.ownerId,
              proof
            }
          );
        }
      }
    }
    return compactStandaloneOwnershipState(ownershipState, reason);
  } catch (err) {
    return {
      ok: false,
      reason,
      error: errorMessage(err),
      updatedAt: nowIso()
    };
  }
}

async function darwinOwnershipSupersessionProof(reason) {
  if (reason === 'darwin-retained-data-plane-recovery') {
    return {
      retainedDataPlaneProven: true,
      tunnelInactive: false,
      source: reason
    };
  }
  if (reason !== 'connect-preflight') {
    return {
      retainedDataPlaneProven: false,
      tunnelInactive: false,
      source: reason
    };
  }
  try {
    const mod = await importInstalledPackage('@qpjoy/electron-launcher/wireguard');
    const status = mod.getLauncherWireGuardPeerStatus(wireGuardRuntimeOptions());
    const launchDaemon = status?.launchDaemon;
    return {
      retainedDataPlaneProven: false,
      tunnelInactive: status?.ok === true
        && status?.active === false
        && launchDaemon?.ok === true
        && launchDaemon?.supported === true
        && launchDaemon?.installed === false
        && launchDaemon?.loaded === false
        && launchDaemon?.running === false,
      source: reason,
      statusOk: status?.ok === true,
      active: status?.active === true,
      launchDaemonSupported: launchDaemon?.supported === true,
      launchDaemonInstalled: launchDaemon?.installed === true,
      launchDaemonLoaded: launchDaemon?.loaded === true,
      launchDaemonRunning: launchDaemon?.running === true
    };
  } catch (err) {
    return {
      retainedDataPlaneProven: false,
      tunnelInactive: false,
      source: reason,
      error: errorMessage(err)
    };
  }
}

async function releaseStandaloneOwnershipForRuntime(reason = 'manual') {
  try {
    const mod = await importInstalledPackage('@qpjoy/electron-launcher/standalone-data-plane');
    const state = mod.releaseElectronLauncherStandaloneOwnershipClaim(standaloneOwnershipOwnerId());
    return compactStandaloneOwnershipState(state, reason);
  } catch (err) {
    return {
      ok: false,
      reason,
      error: errorMessage(err),
      updatedAt: nowIso()
    };
  }
}

function mxH2iStandaloneOwnershipClaim(mod, routePlan, connection) {
  const reverseProxyRoutes = arrayValue(lastSystemPacReverseProxyRoutes, []);
  return mod.buildElectronLauncherStandaloneOwnershipClaim(routePlan, {
    ownerId: standaloneOwnershipOwnerId(),
    productId: launcherProductId(),
    instanceId: standaloneOwnershipInstanceId(),
    displayName: launcherProductDisplayName(),
    priority: 100,
    metadata: {
      dataPlaneMode: 'standalone-wireguard',
      dataPlaneOwner: true,
      foundationOwner: false
    },
    dnsZones: splitDnsDomains(runtime?.config),
    dnsHosts: reverseProxyRoutes.map((route) => nullableString(route?.host)).filter(Boolean),
    routeCidrs: productOwnershipRouteCidrs(routePlan, connection),
    reverseProxyRoutes
  });
}

function productOwnershipRouteCidrs(routePlan, connection = {}) {
  const plan = normalizeRoutePlan(routePlan || connection.routePlan);
  const installed = uniqueStrings(arrayValue(plan?.routeCidrs, [])
    .map(nullableString)
    .filter(isRegisteredStandaloneRouteCidr));
  if (plan?.leaseCidr) installed.push(plan.leaseCidr);
  const normalized = uniqueStrings(installed);
  if (normalized.length > 0) return normalized;
  const localIp = nullableString(connection.localIp);
  return localIp ? [`${localIp}/32`] : [];
}

function standaloneOwnershipInstanceId() {
  return stableOwnershipInstanceId(runtime?.installation || {})
    || nullableString(runtime?.credentialStorageFailure?.ownershipInstanceId);
}

function standaloneOwnershipOwnerId() {
  return `${launcherProductId()}:${standaloneOwnershipInstanceId() || 'local'}`;
}

function compactStandaloneOwnershipState(state, reason) {
  const registry = state?.registry && typeof state.registry === 'object' ? state.registry : {};
  const conflicts = Array.isArray(registry.conflicts) ? registry.conflicts : [];
  return {
    ok: state?.claimed !== false && conflicts.length === 0,
    claimed: state?.claimed !== false,
    reason,
    statePath: nullableString(state?.statePath),
    supersededOwnerIds: arrayValue(state?.supersededOwnerIds, []),
    supersessionRejectedReason: nullableString(state?.supersessionRejectedReason),
    owners: Array.isArray(registry.owners)
      ? registry.owners.map((owner) => nullableString(owner?.ownerId)).filter(Boolean)
      : [],
    conflicts,
    updatedAt: nullableString(state?.updatedAt) || nowIso()
  };
}

function networkEnvironmentSignature(diagnostics) {
  if (!diagnostics || typeof diagnostics !== 'object') return null;
  const resolution = diagnostics.resolution || {};
  return JSON.stringify({
    phase: diagnostics.phase,
    host: diagnostics.host,
    state: resolution.state,
    severity: resolution.severity,
    addresses: arrayValue(resolution.addresses, [])
      .map((row) => `${row.address}:${row.classification}`)
      .sort(),
    endpointRoute: diagnostics.endpointRoute
      ? compactDarwinEndpointRouteSignature(diagnostics.endpointRoute)
      : null,
    windowsNrpt: diagnostics.windowsNrpt
      ? {
          source: diagnostics.windowsNrpt.source || null,
          state: diagnostics.windowsNrpt.state || null,
          ready: diagnostics.windowsNrpt.ready === true,
          globalReady: diagnostics.windowsNrpt.globalReady === true,
          missingNamespaces: arrayValue(diagnostics.windowsNrpt.missingNamespaces, []).sort(),
          mismatchedNamespaces: arrayValue(diagnostics.windowsNrpt.mismatchedNamespaces, []).sort()
        }
      : null,
    systemDomainProxy: diagnostics.systemDomainProxy
      ? {
          applied: diagnostics.systemDomainProxy.applied === true,
          skipReason: diagnostics.systemDomainProxy.skipReason || null,
          pacUrl: diagnostics.systemDomainProxy.pacUrl || null,
          browserReady: diagnostics.systemDomainProxy.browserReady === true,
          browserProxyStatusCode: diagnostics.systemDomainProxy.browserAccess?.proxyStatusCode || null,
          systemResolverMode: diagnostics.systemDomainProxy.systemResolverMode || null,
          resolverApplied: diagnostics.systemDomainProxy.resolverApplied === true,
          resolverDomains: arrayValue(diagnostics.systemDomainProxy.resolverDomains, []).sort()
        }
      : null
  });
}

function systemDomainProxyStatusSignature(status) {
  if (!status || typeof status !== 'object') return null;
  return JSON.stringify({
    applied: status.applied === true,
    verified: status.verified === true,
    skipped: status.skipped === true,
    skipReason: nullableString(status.skipReason),
    pacUrl: nullableString(status.pacUrl),
    proxy: nullableString(status.proxy),
    fallbackProxy: nullableString(status.fallbackProxy),
    fallbackPacUrl: nullableString(status.fallbackPacUrl),
    browserReady: status.browserReady === true,
    browserHost: nullableString(status.browserAccess?.host),
    browserProxyStatusCode: status.browserAccess?.proxyStatusCode || null,
    browserError: nullableString(status.browserAccess?.error),
    dnsFallbackTarget: nullableString(status.dnsFallbackTarget),
    systemResolverMode: nullableString(status.systemResolverMode),
    resolverPort: status.resolverPort || null,
    resolverApplied: status.resolverApplied === true,
    resolverError: nullableString(status.resolverError),
    resolverDomains: arrayValue(status.resolverDomains, []).map(String).sort(),
    domains: arrayValue(status.domains, []).map(String).sort(),
    dnsServers: arrayValue(status.dnsServers, []).map(String).sort(),
    reverseProxyRoutes: arrayValue(status.reverseProxyRoutes, [])
      .map((route) => ({
        host: nullableString(route?.host),
        dnsTarget: nullableString(route?.dnsTarget),
        targetUrl: nullableString(route?.targetUrl),
        tlsMode: nullableString(route?.tlsMode),
        enabled: route?.enabled !== false
      }))
      .sort((left, right) => String(left.host).localeCompare(String(right.host)))
  });
}

function systemDomainProxyPolicySignature(policy) {
  if (!policy || typeof policy !== 'object') return null;
  return JSON.stringify({
    enabled: policy.enabled === true,
    matchMode: nullableString(policy.matchMode),
    proxy: nullableString(policy.proxy),
    fallbackProxy: nullableString(policy.fallbackProxy),
    pacPort: policy.pacPort || null,
    dnsFallbackTarget: nullableString(policy.dnsFallbackTarget),
    systemResolver: nullableString(policy.systemResolver),
    domains: arrayValue(policy.domains, []).map(String).sort(),
    dnsServers: arrayValue(policy.dnsServers, []).map(String).sort(),
    directCidrs: arrayValue(policy.ownershipClaim?.routeCidrs, [])
      .map((cidr) => nullableString(cidr))
      .filter(Boolean)
      .sort(),
    reverseProxyRoutes: arrayValue(policy.reverseProxyRoutes, [])
      .map((route) => ({
        host: nullableString(route?.host),
        dnsTarget: nullableString(route?.dnsTarget),
        targetUrl: nullableString(route?.targetUrl),
        tlsMode: nullableString(route?.tlsMode),
        authRequired: route?.authRequired === true,
        enabled: route?.enabled !== false
      }))
      .sort((left, right) => String(left.host).localeCompare(String(right.host)))
  });
}

async function maybeSkipSystemDomainProxyApply(reason, policySignature) {
  if (!isBackgroundSystemDomainProxyReason(reason) || !policySignature) return null;
  const policyUnchanged = policySignature === lastSystemDomainProxyPolicySignature;
  const status = typeof systemDomainProxyManager?.status === 'function'
    ? systemDomainProxyManager.status()
    : null;
  const verified = shouldVerifySystemDomainProxyBeforeBackgroundSkip(reason)
    ? await systemDomainProxyManager?.statusVerified?.().catch(() => null)
    : null;
  if (!policyUnchanged && process.platform !== 'win32') return null;
  if (!policyUnchanged && (!status || typeof status !== 'object' || status.applied !== true)) return null;
  if (
    policyUnchanged
    &&
    policySignature === lastSystemDomainProxyAuthorizationCanceledSignature
    && (!status || typeof status !== 'object')
  ) {
    return {
      supported: true,
      applied: false,
      platform: process.platform,
      reason,
      skipped: true,
      skipReason: 'authorization-canceled'
    };
  }
  if (!status || typeof status !== 'object') return null;
  if (verified && typeof verified === 'object') {
    if (policyUnchanged && systemDomainProxyStatusLooksApplied(verified)) {
      if (
        process.platform === 'win32'
        && typeof systemDomainProxyManager?.refreshWindowsContinuation === 'function'
        && Date.now() - lastWindowsSystemProxyContinuationRefreshAt >= WINDOWS_SYSTEM_PROXY_CONTINUATION_REFRESH_MS
      ) {
        lastWindowsSystemProxyContinuationRefreshAt = Date.now();
        const refreshed = await systemDomainProxyManager
          .refreshWindowsContinuation(reason)
          .catch((err) => ({
            ...verified,
            reason,
            error: `Windows proxy continuation refresh failed: ${errorMessage(err)}`
          }));
        return {
          ...refreshed,
          reason,
          skipped: true
        };
      }
      return {
        ...verified,
        reason,
        skipped: true
      };
    }
    if (process.platform === 'win32' && policyUnchanged) {
      const pacStillOwned = verified?.actual?.pac?.applied === true;
      if (!pacStillOwned) {
        const takeoverSignature = windowsSystemProxyTakeoverSignature(verified);
        if (
          takeoverSignature
          && takeoverSignature === lastWindowsSystemProxyTakeoverSignature
        ) {
          return {
            ...verified,
            reason,
            skipped: true,
            skipReason: 'external-system-proxy-owner-stable',
            error: verified.error
              || 'Windows 系统代理被同一个外部 owner 持续占用；MX-H2I 不会周期抢写。请切换代理模式、重连或执行网络修复。'
          };
        }
        // Suppress a stable owner only after coordination succeeds. A Clash
        // PAC/listener may start a few seconds after login; failed read-only
        // continuation discovery must remain retryable without touching the
        // registry.
        pendingWindowsSystemProxyTakeoverSignature = takeoverSignature;
      }
    }
    if (!policyUnchanged) return null;
    if (policySignature === lastSystemDomainProxyAuthorizationCanceledSignature) {
      return {
        ...verified,
        reason,
        skipped: true,
        skipReason: 'authorization-canceled'
      };
    }
    return null;
  }
  if (!policyUnchanged) return null;
  if (systemDomainProxyStatusLooksApplied(status)) {
    return {
      ...status,
      reason,
      skipped: true
    };
  }
  if (
    policySignature === lastSystemDomainProxyAuthorizationCanceledSignature
  ) {
    return {
      ...status,
      reason,
      skipped: true,
      skipReason: 'authorization-canceled'
    };
  }
  return null;
}

function windowsSystemProxyTakeoverSignature(status) {
  if (process.platform !== 'win32') return null;
  const pac = status?.actual?.pac;
  if (!pac || typeof pac !== 'object') return null;
  return JSON.stringify({
    autoConfigUrl: windowsRegistryValueSignature(pac.autoConfigUrl),
    proxyEnable: windowsRegistryValueSignature(pac.proxyEnable),
    proxyServer: windowsRegistryValueSignature(pac.proxyServer),
    proxyOverride: windowsRegistryValueSignature(pac.proxyOverride),
    autoDetect: windowsRegistryValueSignature(pac.autoDetect)
  });
}

function windowsRegistryValueSignature(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    exists: value.exists === true,
    type: nullableString(value.type),
    value: value.value ?? null
  };
}

function isBackgroundSystemDomainProxyReason(reason) {
  const text = String(reason || '');
  return text === 'route-refresh' || text === 'app-startup' || text === 'app-startup-refresh';
}

function shouldVerifySystemDomainProxyBeforeBackgroundSkip(reason) {
  if (process.platform === 'win32') return isBackgroundSystemDomainProxyReason(reason);
  // A persisted Darwin state can outlive the in-process PAC/DNS listeners.
  // Verify every background reuse before treating split DNS as connected.
  return process.platform === 'darwin' && isBackgroundSystemDomainProxyReason(reason);
}

function systemDomainProxyStatusLooksApplied(status) {
  if (!status || typeof status !== 'object' || status.applied !== true) return false;
  const resolverMode = nullableString(status.systemResolverMode);
  const resolverDomains = arrayValue(status.resolverDomains, []);
  return resolverMode !== 'dynamic' || resolverDomains.length === 0 || status.resolverApplied === true;
}

function shouldApplySystemDomainProxyForReason(reason) {
  const text = String(reason || '');
  if (
    process.platform === 'win32'
    && windowsSystemPacEnabled()
    && isBackgroundSystemDomainProxyReason(text)
  ) {
    return true;
  }
  if (process.platform === 'darwin' && text === 'route-refresh' && allowMacBackgroundSystemDomainProxyRepair()) return true;
  return text === 'post-connect' || text.startsWith('manual');
}

function allowMacBackgroundSystemDomainProxyRepair() {
  return !['0', 'false', 'no', 'off'].includes(String(process.env.MX_H2I_MAC_BACKGROUND_PROXY_REPAIR || '').trim().toLowerCase());
}

function currentSystemDomainProxyStatus(reason, extra = {}) {
  const status = typeof systemDomainProxyManager?.status === 'function'
    ? systemDomainProxyManager.status()
    : null;
  return {
    supported: true,
    platform: process.platform,
    ...(status && typeof status === 'object' ? status : {}),
    reason,
    ...extra
  };
}

function deferredSystemDomainProxyRestoreStatus(reason, prepared = null) {
  const status = typeof systemDomainProxyManager?.status === 'function'
    ? systemDomainProxyManager.status()
    : null;
  const preparedStatus = prepared?.status && typeof prepared.status === 'object'
    ? prepared.status
    : null;
  return {
    supported: true,
    platform: process.platform,
    ...(status && typeof status === 'object' ? status : {}),
    reason,
    skipped: true,
    skipReason: 'wireguard-not-ready-no-privileged-restore',
    pending: preparedStatus?.pending === true || status?.pending === true,
    externalApply: preparedStatus?.externalApply === true || status?.externalApply === true,
    error: preparedStatus?.error || status?.error || null
  };
}

function isSystemDomainProxyAuthorizationCanceled(status) {
  return isUserAuthorizationCanceledError(status);
}

function isUserAuthorizationCanceledError(value) {
  const text = authorizationErrorText(value);
  return /authorization canceled|administrator authorization canceled|user canceled|user cancelled|用户已取消|取消授权|已取消|\(-128\)|osascript.*canceled|osascript.*cancelled/i.test(text);
}

function authorizationErrorText(value) {
  if (!value) return '';
  if (value instanceof Error) {
    return [
      value.message,
      value.stack,
      value.stderr,
      value.stdout,
      value.cause?.message,
      value.cause?.stderr,
      value.cause?.stdout
    ].filter(Boolean).join('\n');
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    return [
      value.error,
      value.resolverError,
      value.message,
      value.stderr,
      value.stdout,
      value.reason,
      value.skipReason
    ].filter(Boolean).join('\n');
  }
  return String(value);
}

function systemPacFallbackProxy() {
  return nullableString(process.env.MX_H2I_SYSTEM_PAC_FALLBACK_PROXY)
    || nullableString(process.env.MX_H2I_CLASH_PROXY)
    || nullableString(process.env.MX_H2I_MIHOMO_PROXY)
    || null;
}

function windowsSystemPacEnabled() {
  const configured = nullableString(process.env.MX_H2I_WINDOWS_SYSTEM_PAC);
  if (configured) {
    return ['1', 'true', 'yes', 'on'].includes(configured.toLowerCase());
  }
  return process.platform === 'win32' || Boolean(systemPacFallbackProxy());
}

function localEdgePort() {
  const port = Number(
    nullableString(process.env.MX_H2I_LOCAL_EDGE_PORT)
    || nullableString(process.env.MX_H2I_SYSTEM_PAC_PORT)
    || DEFAULT_LOCAL_EDGE_PORT
  );
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_LOCAL_EDGE_PORT;
}

function localEdgeProxy() {
  return `127.0.0.1:${localEdgePort()}`;
}

function systemPacDnsServers() {
  return arrayValue([
    process.env.MX_H2I_LOCAL_EDGE_DNS_SERVER,
    dnsServerWithDefaultPort(runtime?.connection?.routePlan?.dnsServer, DEFAULT_DOMESTIC_DNS_EDGE_PORT),
    internalDnsEdgeServer(runtime?.connection?.routePlan?.internalControlIp),
    internalDnsEdgeServer(runtime?.connection?.internalControlIp),
    internalDnsEdgeServer(INTERNAL_PEER_IP),
    process.env.MX_H2I_DOMESTIC_DNS_SERVER,
    process.env.MX_H2I_DOMESTIC_DNS_EDGE,
    domesticGatewayDnsServer(),
    domesticPublicDnsServer()
  ], [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .filter((item, index, rows) => rows.indexOf(item) === index);
}

function domesticPublicDnsServer() {
  const host = publicHostFromEndpoint(runtime?.connection?.domesticRelayEndpoint)
    || publicHostFromUrl(runtime?.config?.bootstrapApiBaseUrl)
    || publicHostFromUrl(DEFAULT_CONFIG.bootstrapApiBaseUrl);
  return host ? dnsEndpoint(host, DEFAULT_DOMESTIC_DNS_EDGE_PORT) : null;
}

function domesticGatewayDnsServer() {
  const host = nullableString(runtime?.connection?.routePlan?.domesticGatewayIp) || '10.88.0.1';
  return dnsEndpoint(host, DEFAULT_DOMESTIC_DNS_EDGE_PORT);
}

function internalDnsEdgeServer(host) {
  return dnsServerWithDefaultPort(host, DEFAULT_INTERNAL_DNS_EDGE_PORT);
}

function dnsServerWithDefaultPort(value, port) {
  const clean = nullableString(value);
  if (!clean) return null;
  if (/^\[[^\]]+\]:\d{1,5}$/.test(clean) || /^[^:]+:\d{1,5}$/.test(clean)) return clean;
  return dnsEndpoint(clean, port);
}

function dnsEndpoint(host, port) {
  const cleanHost = nullableString(host);
  if (!cleanHost) return null;
  return cleanHost.includes(':') && !cleanHost.startsWith('[')
    ? `[${cleanHost}]:${port}`
    : `${cleanHost}:${port}`;
}

function publicHostFromEndpoint(endpoint) {
  const text = nullableString(endpoint);
  if (!text) return null;
  try {
    return new URL(text.includes('://') ? text : `udp://${text}`).hostname || null;
  } catch {
    return text.split(':')[0] || null;
  }
}

function publicHostFromUrl(value) {
  const text = normalizeBaseUrl(value);
  if (!text) return null;
  try {
    const host = new URL(text).hostname;
    return host && host !== 'localhost' && net.isIP(host) !== 6 ? host : null;
  } catch {
    return null;
  }
}

function systemPacDnsFallbackTarget() {
  return nullableString(runtime?.connection?.routePlan?.internalControlIp)
    || nullableString(runtime?.connection?.internalControlIp)
    || INTERNAL_PEER_IP;
}

function systemPacGatewayTargetUrl() {
  const host = systemPacDnsFallbackTarget();
  const port = Number.parseInt(
    nullableString(process.env.MX_H2I_INTERNAL_GATEWAY_PORT)
      || nullableString(process.env.MX_H2I_GATEWAY_APP_PORT)
      || String(DEFAULT_INTERNAL_GATEWAY_APP_PORT),
    10
  );
  const safePort = Number.isInteger(port) && port > 0 && port <= 65535
    ? port
    : DEFAULT_INTERNAL_GATEWAY_APP_PORT;
  return `http://${host}:${safePort}`;
}

async function systemPacReverseProxyRoutes(options = {}) {
  const baseUrls = systemPacReverseProxyRouteBaseUrls();
  const failures = [];
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 5000;
  for (const baseUrl of baseUrls) {
    try {
      const payload = await requestJson(joinApiUrl(baseUrl, '/internal/v1/dns/reverse-proxy/routes'), {
        timeoutMs,
        bootstrapResolveMode: runtime?.config?.bootstrapResolveMode
      });
      const routes = arrayValue(payload?.routes, [])
        .map((route) => normalizeSystemPacReverseProxyRoute(route))
        .filter(Boolean);
      lastSystemPacReverseProxyRoutes = routes;
      return routes;
    } catch (err) {
      failures.push(`${baseUrl}: ${errorMessage(err)}`);
    }
  }
  if (lastSystemPacReverseProxyRoutes.length > 0) {
    warnSystemPacReverseProxyRoutesUnavailable(
      '[mx-h2i] reverse proxy routes unavailable for local edge; using cached routes:',
      failures,
      options
    );
    return lastSystemPacReverseProxyRoutes;
  }
  if (failures.length > 0) {
    warnSystemPacReverseProxyRoutesUnavailable(
      '[mx-h2i] reverse proxy routes unavailable for local edge:',
      failures,
      options
    );
  }
  return [];
}

function warnSystemPacReverseProxyRoutesUnavailable(prefix, failures, options = {}) {
  if (!failures.length) return;
  const now = Date.now();
  const allowWarnings = options.allowWarnings !== false
    && !wireGuardDisconnectInFlight
    && !appShutdownRequested;
  if (!allowWarnings) {
    return;
  }
  if (now - lastSystemPacReverseProxyRoutesWarningAt < SYSTEM_DOMAIN_PROXY_ROUTE_WARNING_MS) {
    return;
  }
  lastSystemPacReverseProxyRoutesWarningAt = now;
  console.warn(prefix, failures.join('; '));
}

function systemPacReverseProxyRouteBaseUrls() {
  const routePlan = runtime?.connection?.routePlan;
  return uniqueStrings([
    normalizeBaseUrl(runtime?.connection?.internalBaseUrl),
    internalOverlayBaseUrl(routePlan, runtime?.config?.internalApiBaseUrl),
    normalizeBaseUrl(runtime?.config?.internalApiBaseUrl),
    normalizeBaseUrl(runtime?.config?.bootstrapApiBaseUrl),
    ...LOCAL_INTERNAL_BASE_URLS.map((url) => normalizeBaseUrl(url))
  ]);
}

function normalizeSystemPacReverseProxyRoute(input) {
  const row = input && typeof input === 'object' ? input : {};
  const host = nullableString(row.host);
  if (!host || row.enabled === false) return null;
  const routeUpstream = nullableString(row.targetUrl);
  return {
    routeId: nullableString(row.routeId),
    host,
    dnsTarget: nullableString(row.dnsTarget),
    targetUrl: routeUpstream ? systemPacGatewayTargetUrl() : null,
    tlsMode: nullableString(row.tlsMode),
    authRequired: row.authRequired === true,
    enabled: true
  };
}

function isCursorInsideWindow(point = electronScreen.getCursorScreenPoint()) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const bounds = mainWindow.getBounds();
  return point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height;
}

function maybeHideTopDock(point = electronScreen.getCursorScreenPoint()) {
  if (!topDockHidePending || isTopHidden || isTopHideAnimating) return false;
  if (isCursorInsideWindow(point) || isCursorInTopHoldZone(point)) {
    topDockLeaveStartedAt = 0;
    return false;
  }
  const now = Date.now();
  if (now < topDockHoldUntil) return false;
  if (!topDockLeaveStartedAt) {
    topDockLeaveStartedAt = now;
    return false;
  }
  if (now - topDockLeaveStartedAt < TOP_LEAVE_HIDE_MS) return false;
  hideToTopEdge({ requireReentry: true });
  return true;
}

function isCursorInTopHoldZone(point) {
  if (!lastVisibleBounds) return false;
  const bounds = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : lastVisibleBounds;
  const display = electronScreen.getDisplayMatching(bounds);
  const withinX = point.x >= bounds.x && point.x <= bounds.x + bounds.width;
  const nearTop = point.y >= display.bounds.y - 2 && point.y <= bounds.y + TOP_REVEAL_ZONE;
  return withinX && nearTop;
}

function dockActivationDistance(bounds, display) {
  const base = Math.min(bounds.height, display.workArea.height) * 0.032;
  return clamp(Math.round(base), 16, 30);
}

function dockReleaseDistance(bounds, display) {
  const base = Math.min(bounds.height, display.workArea.height) * 0.09;
  return clamp(Math.round(base), 58, 92);
}

function animateWindow(from, to, steps, onDone) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  stopTopAnimation();
  let step = 0;
  topAnimationTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      stopTopAnimation();
      return;
    }
    step += 1;
    const t = easeOutCubic(step / steps);
    const x = Math.round(from.x + (to.x - from.x) * t);
    const y = Math.round(from.y + (to.y - from.y) * t);
    try {
      if (from.width === to.width && from.height === to.height) {
        mainWindow.setPosition(x, y, false);
      } else {
        mainWindow.setBounds({
          x,
          y,
          width: Math.round(from.width + (to.width - from.width) * t),
          height: Math.round(from.height + (to.height - from.height) * t)
        }, false);
      }
    } catch (err) {
      const visibleFallback = to.y < from.y ? from : to;
      recoverTopWindowAnimation('top-animation', err, visibleFallback);
      return;
    }
    if (step >= steps) {
      stopTopAnimation();
      onDone?.();
    }
  }, 18);
}

function recoverTopWindowAnimation(reason, err, visibleFallback) {
  stopTopAnimation();
  isTopHidden = false;
  isTopHideAnimating = false;
  isTopDocked = false;
  topDockHidePending = false;
  topDockHoldUntil = 0;
  topDockLeaveStartedAt = 0;
  needsRevealZoneReentry = false;
  console.warn('[mx-h2i] top window animation stopped:', errorMessage(err));
  queueDiagnosticError('window.top-animation-failed', err, { reason });
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const fallback = normalizeWindowBounds(visibleFallback) || normalizeWindowBounds(lastVisibleBounds);
    if (fallback) {
      windowBoundsTrackingSuppressed = true;
      try {
        mainWindow.setPosition(fallback.x, fallback.y, false);
        if (process.platform === 'win32') mainWindow.setSize(fallback.width, fallback.height, false);
      } finally {
        windowBoundsTrackingSuppressed = false;
      }
      lastVisibleBounds = { ...fallback };
    }
    if (!mainWindow.isVisible()) mainWindow.showInactive();
  } catch (recoveryError) {
    console.warn('[mx-h2i] top window recovery failed:', errorMessage(recoveryError));
    queueDiagnosticError('window.top-animation-recovery-failed', recoveryError, { reason });
    if (!mainWindow.isVisible()) mainWindow.showInactive();
  }
}

function stopTopAnimation() {
  if (!topAnimationTimer) return;
  clearInterval(topAnimationTimer);
  topAnimationTimer = null;
}

function easeOutCubic(value) {
  const t = Math.min(1, Math.max(0, value));
  return 1 - Math.pow(1 - t, 3);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function loadRuntime() {
  let loaded;
  try {
    const raw = await fs.readFile(runtimePath(), 'utf8');
    loaded = await normalizeRuntime(unprotectPersistedRuntime(JSON.parse(raw)));
  } catch {
    loaded = await normalizeRuntime({});
  }
  const persistedH2oRuntime = await loadPersistedH2oRuntime();
  const merged = mergePersistedH2oRuntime(loaded, persistedH2oRuntime);
  await maybeSnapshotAppsState(merged.apps);
  return merged;
}

async function normalizeRuntime(input) {
  const row = input && typeof input === 'object' ? input : {};
  const config = normalizeConfig(row.config);
  const reconciledUpdate = reconcileRuntimeUpdateWithInstalledVersion(
    row.update,
    currentReleaseVersion()
  );
  return {
    config,
    installation: normalizeInstallation(row.installation),
    auth: normalizeAuth(row.auth),
    connection: normalizeConnection(row.connection),
    credentialStorageFailure: normalizeCredentialStorageFailure(row.credentialStorageFailure),
    leaseCapabilities: normalizeLeaseCapabilities(row.leaseCapabilities),
    networkHandover: normalizePendingNetworkHandover(row.networkHandover),
    identity: normalizeIdentity(row.identity),
    apps: normalizeApps(row.apps),
    update: normalizeUpdate(reconciledUpdate, config),
    launcherContract: await launcherContract(config),
    window: normalizeWindowState(row.window),
    feedback: null,
    networkEvent: normalizeNetworkModeEvent(row.networkEvent),
    activity: Array.isArray(row.activity) ? row.activity.slice(0, 8) : defaultActivity(),
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : nowIso()
  };
}

function normalizeCredentialStorageFailure(input) {
  const row = input && typeof input === 'object' ? input : null;
  if (!row) return null;
  return {
    reason: nullableString(row.reason) || 'Persisted credentials could not be decrypted.',
    detectedAt: nullableString(row.detectedAt) || nowIso(),
    ownershipInstanceId: nullableString(row.ownershipInstanceId),
    previousMode: row.previousMode === 'employee' ? 'employee' : 'guest',
    previousLeaseIp: nullableString(row.previousLeaseIp)
  };
}

function normalizeNetworkModeEvent(input) {
  const row = input && typeof input === 'object' ? input : null;
  if (!row) return null;
  const name = ['visit:connect', 'visit:disconnect', 'staff:connect', 'staff:disconnect'].includes(row.name)
    ? row.name
    : null;
  const phase = ['connecting', 'connected', 'disconnected', 'skipped', 'failed'].includes(row.phase)
    ? row.phase
    : null;
  if (!name || !phase) return null;
  return {
    name,
    phase,
    sequence: Number.isInteger(row.sequence) ? row.sequence : null,
    productId: nullableString(row.productId) || launcherProductId(),
    instanceId: nullableString(row.instanceId),
    leaseIp: nullableString(row.leaseIp),
    reason: nullableString(row.reason),
    transitionId: nullableString(row.transitionId),
    occurredAt: nullableString(row.occurredAt) || nowIso()
  };
}

function normalizeWindowState(input) {
  const row = input && typeof input === 'object' ? input : {};
  const bounds = row.bounds && typeof row.bounds === 'object' ? row.bounds : {};
  return {
    mode: row.mode === 'appcenter' ? 'appcenter' : 'launcher',
    bounds: {
      launcher: normalizeWindowBounds(bounds.launcher),
      appcenter: normalizeWindowBounds(bounds.appcenter)
    }
  };
}

function normalizeWindowBounds(input) {
  const row = input && typeof input === 'object' ? input : {};
  const x = Math.round(Number(row.x));
  const y = Math.round(Number(row.y));
  const width = Math.round(Number(row.width));
  const height = Math.round(Number(row.height));
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width < 320 || height < 420 || width > 10000 || height > 10000) return null;
  return { x, y, width, height };
}

function normalizeConfig(input) {
  const row = input && typeof input === 'object' ? input : {};
  const domesticRelayPort = Number(row.domesticRelayPort);
  const internalApiBaseUrl = normalizeInternalApiBaseUrlConfig(row.internalApiBaseUrl);
  const bootstrapApiBaseUrl = normalizeBootstrapApiBaseUrlConfig(
    row.bootstrapApiBaseUrl,
    internalApiBaseUrl
  );
  const domesticRelayHost = normalizeDomesticRelayHost(row.domesticRelayHost);
  const hostResolve = normalizeHostResolveConfig(row.hostResolve, bootstrapApiBaseUrl, domesticRelayHost);
  const productId = normalizeLauncherProductId(row.productId || DEFAULT_CONFIG.productId);
  const productDisplayName = nullableString(row.productDisplayName)
    || (productId === DEFAULT_CONFIG.productId ? DEFAULT_CONFIG.productDisplayName : null)
    || displayNameForLauncherProductId(productId);
  return {
    productId,
    productDisplayName,
    bootstrapApiBaseUrl,
    internalApiBaseUrl,
    domesticRelayHost,
    domesticRelayPort: Number.isInteger(domesticRelayPort) && domesticRelayPort > 0 ? domesticRelayPort : DEFAULT_CONFIG.domesticRelayPort,
    sdkGatewayBaseUrl: normalizeSdkGatewayBaseUrlConfig(
      row.sdkGatewayBaseUrl,
      bootstrapApiBaseUrl,
      internalApiBaseUrl
    ),
    hostResolve,
    bootstrapResolveMode: normalizeBootstrapResolveModeConfig(row.bootstrapResolveMode, bootstrapApiBaseUrl, hostResolve),
    bootstrapDnsServers: stringValue(row.bootstrapDnsServers, DEFAULT_CONFIG.bootstrapDnsServers),
    splitDnsDomains: stringValue(row.splitDnsDomains, DEFAULT_CONFIG.splitDnsDomains),
    routePathPreference: normalizeRoutePathPreference(row.routePathPreference || DEFAULT_CONFIG.routePathPreference),
    releaseChannel: stringValue(row.releaseChannel, DEFAULT_CONFIG.releaseChannel),
    releaseUpdateStrategy: row.releaseUpdateStrategy === 'asar' ? 'asar' : 'installer',
    rolloutGroup: stringValue(row.rolloutGroup, DEFAULT_CONFIG.rolloutGroup),
    useLocalEngineResources: row.useLocalEngineResources !== false,
    restartAfterCodeUpdate: row.restartAfterCodeUpdate !== false
  };
}

function normalizeBootstrapApiBaseUrlConfig(value, internalApiBaseUrl) {
  const normalized = normalizeBaseUrl(value) || DEFAULT_CONFIG.bootstrapApiBaseUrl;
  if (isLegacyDefaultBootstrapApiBaseUrl(normalized)) return DEFAULT_CONFIG.bootstrapApiBaseUrl;
  if (
    productionBootstrapCanonicalRequired()
    && normalized === normalizeBaseUrl(DEFAULT_CONFIG.internalApiBaseUrl)
    && normalized === normalizeBaseUrl(internalApiBaseUrl)
  ) {
    return DEFAULT_CONFIG.bootstrapApiBaseUrl;
  }
  if (productionBootstrapCanonicalRequired() && isBarePublicIpBootstrapBaseUrl(normalized)) {
    return DEFAULT_CONFIG.bootstrapApiBaseUrl;
  }
  return normalized;
}

function isLegacyDefaultBootstrapApiBaseUrl(value) {
  try {
    const parsed = new URL(normalizeBaseUrl(value) || '');
    if (
      parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
    ) {
      return false;
    }
    if (
      parsed.protocol === 'https:'
      && parsed.hostname === LEGACY_DEFAULT_BOOTSTRAP_HOST
      && !parsed.port
    ) {
      return true;
    }
    return parsed.protocol === 'http:'
      && ['api.mxinfo-inc.cn', LEGACY_DEFAULT_BOOTSTRAP_HOST].includes(parsed.hostname)
      && parsed.port === '18090';
  } catch {
    return false;
  }
}

function normalizeSdkGatewayBaseUrlConfig(value, bootstrapApiBaseUrl, internalApiBaseUrl) {
  const fallback = DEFAULT_CONFIG.sdkGatewayBaseUrl || sdkGatewayBaseUrl(bootstrapApiBaseUrl);
  const normalized = normalizeBaseUrl(value);
  if (!normalized || isLegacyDefaultSdkGatewayBaseUrl(normalized)) return fallback;
  if (
    productionBootstrapCanonicalRequired()
    && normalized === sdkGatewayBaseUrl(DEFAULT_CONFIG.internalApiBaseUrl)
    && normalizeBaseUrl(internalApiBaseUrl) === normalizeBaseUrl(DEFAULT_CONFIG.internalApiBaseUrl)
  ) {
    return fallback;
  }
  return normalized;
}

function isLegacyDefaultSdkGatewayBaseUrl(value) {
  try {
    const parsed = new URL(normalizeBaseUrl(value) || '');
    if (
      parsed.username
      || parsed.password
      || parsed.pathname.replace(/\/+$/, '') !== '/internal/v1/sdk'
      || parsed.search
      || parsed.hash
    ) {
      return false;
    }
    if (
      parsed.protocol === 'https:'
      && parsed.hostname === LEGACY_DEFAULT_BOOTSTRAP_HOST
      && !parsed.port
    ) {
      return true;
    }
    return parsed.protocol === 'http:'
      && ['api.mxinfo-inc.cn', LEGACY_DEFAULT_BOOTSTRAP_HOST].includes(parsed.hostname)
      && parsed.port === '18090';
  } catch {
    return false;
  }
}

function normalizeDomesticRelayHost(value) {
  const host = nullableString(value);
  if (!host || STALE_DOMESTIC_RELAY_HOSTS.has(host)) return DEFAULT_CONFIG.domesticRelayHost;
  return host;
}

function normalizeHostResolveConfig(value, bootstrapApiBaseUrl, domesticRelayHost) {
  const host = publicHostFromUrl(bootstrapApiBaseUrl) || DEFAULT_BOOTSTRAP_HOST;
  const explicitDefault = explicitDefaultHostResolve();
  let text = nullableString(value) || explicitDefault;
  if (hostResolveHasStaleDomesticRelay(text)) {
    text = hostResolveHasStaleDomesticRelay(explicitDefault) ? '' : explicitDefault;
  }
  if (!shouldAutoBootstrapHostResolve(host)) return text || '';
  text = migrateKnownLegacyDefaultHostResolve(text);
  if (!text) return `${host}=${domesticRelayHost}`;
  if (hostResolveMentionsHost(text, host)) return text;
  if (host === DEFAULT_BOOTSTRAP_HOST && hostResolveMentionsHost(text, 'api.mxinfo-inc.cn')) {
    const legacyTarget = parseHostResolve(text).get('api.mxinfo-inc.cn');
    if (legacyTarget?.host) {
      const migrated = `${host}=${legacyTarget.host}${legacyTarget.port ? `:${legacyTarget.port}` : ''}`;
      return uniqueValues([migrated, text]).join(',');
    }
  }
  return uniqueValues([`${host}=${domesticRelayHost}`, text]).join(',');
}

function migrateKnownLegacyDefaultHostResolve(value) {
  const text = nullableString(value);
  if (!text) return '';
  return uniqueValues(text
    .split(/[,\n;]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.includes('=') ? '=' : ':';
      const index = entry.indexOf(separator);
      if (index <= 0) return entry;
      const host = entry.slice(0, index).trim().toLowerCase();
      const target = parseHostResolveTarget(entry.slice(index + 1).trim());
      if (
        host !== LEGACY_DEFAULT_BOOTSTRAP_HOST
        || target?.host !== DEFAULT_DOMESTIC_RELAY_HOST
        || target.port
      ) {
        return entry;
      }
      return `${DEFAULT_BOOTSTRAP_HOST}=${DEFAULT_DOMESTIC_RELAY_HOST}`;
    }))
    .join(',');
}

function productionBootstrapCanonicalRequired() {
  return app.isPackaged === true
    || String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
}

function isBarePublicIpBootstrapBaseUrl(value) {
  try {
    return isPublicIpv4Address(new URL(normalizeBaseUrl(value) || '').hostname);
  } catch {
    return false;
  }
}

function hostResolveHasStaleDomesticRelay(value) {
  return Array.from(STALE_DOMESTIC_RELAY_HOSTS).some((host) => String(value || '').includes(host));
}

function shouldAutoBootstrapHostResolve(host) {
  return String(host || '').trim().toLowerCase() === DEFAULT_BOOTSTRAP_HOST;
}

function normalizeBootstrapResolveModeConfig(value, bootstrapApiBaseUrl, hostResolve) {
  const mode = normalizeBootstrapResolveMode(value || DEFAULT_CONFIG.bootstrapResolveMode);
  const host = publicHostFromUrl(bootstrapApiBaseUrl) || DEFAULT_BOOTSTRAP_HOST;
  if (
    mode === 'dns-first'
    && !hasExplicitBootstrapResolveModeEnv()
    && shouldAutoBootstrapHostResolve(host)
    && hostResolveMentionsHost(hostResolve, host)
  ) {
    return 'env-first';
  }
  return mode;
}

function hasExplicitBootstrapResolveModeEnv() {
  return Boolean(
    nullableString(process.env.MX_H2I_BOOTSTRAP_RESOLVE_MODE)
    || nullableString(process.env.MX_H2I_BOOTSTRAP_DNS_MODE)
  );
}

function hostResolveMentionsHost(value, host) {
  const normalized = String(host || '').trim().toLowerCase();
  return normalized ? parseHostResolve(value).has(normalized) : false;
}

function normalizeInternalApiBaseUrlConfig(value) {
  const normalized = normalizeBaseUrl(value);
  if (!normalized) return DEFAULT_CONFIG.internalApiBaseUrl;
  if (process.env.MX_H2I_KEEP_LOCAL_INTERNAL === '1') return normalized;
  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.toLowerCase();
    const isLegacyLocal = (host === '127.0.0.1' || host === 'localhost') && (parsed.port || '80') === '18090';
    return isLegacyLocal ? DEFAULT_CONFIG.internalApiBaseUrl : normalized;
  } catch {
    return normalized;
  }
}

function normalizeInstallation(input) {
  const row = input && typeof input === 'object' ? input : {};
  const keyPairRow = row.keyPair && typeof row.keyPair === 'object' ? row.keyPair : {};
  const privateKey = nullableString(row.privateKey) || nullableString(keyPairRow.privateKey);
  const publicKey = nullableString(row.publicKey) || nullableString(keyPairRow.publicKey);
  return {
    installId: nullableString(row.installId),
    deviceId: nullableString(row.deviceId),
    ownershipInstanceId: stableOwnershipInstanceId(row),
    siteId: stringValue(row.siteId, 'domestic-main'),
    deviceLabel: nullableString(row.deviceLabel),
    deviceModel: nullableString(row.deviceModel),
    osVersion: nullableString(row.osVersion),
    appVersion: nullableString(row.appVersion),
    keyPair: privateKey && publicKey ? { privateKey, publicKey } : null,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : null,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null
  };
}

function isRetainedConnectionState(state) {
  return [
    'connected',
    'lease-only',
    'tunnel-only',
    'server-unavailable',
    'network-unavailable',
    'forbidden'
  ].includes(state);
}

function normalizeConnection(input) {
  const row = input && typeof input === 'object' ? input : {};
  if (isRetainedConnectionState(row.state)) {
    return connectedState({
      state: row.state,
      mode: row.mode === 'employee' ? 'employee' : 'guest',
      localIp: nullableString(row.localIp),
      routePolicy: stringValue(row.routePolicy, 'guest limited'),
      subject: stringValue(row.subject, 'anonymousPrincipal:h2i-demo'),
      connectedAt: typeof row.connectedAt === 'string' ? row.connectedAt : nowIso(),
      leaseId: nullableString(row.leaseId),
      leaseCapability: nullableString(row.leaseCapability),
      snapshotId: nullableString(row.snapshotId),
      productId: nullableString(row.productId),
      serviceVip: nullableString(row.serviceVip),
      internalBaseUrl: nullableString(row.internalBaseUrl),
      internalControlIp: nullableString(row.internalControlIp),
      domesticRelayEndpoint: nullableString(row.domesticRelayEndpoint),
      publicKey: nullableString(row.publicKey),
      allowedIps: arrayValue(row.allowedIps, []),
      routeCidrs: arrayValue(row.routeCidrs, []),
      routePlan: normalizeRoutePlan(row.routePlan),
      health: normalizeHealth(row.health, leasedHealth()),
      wireGuard: normalizeWireGuardSummary(row.wireGuard),
      domesticPeerSync: normalizeDomesticPeerSync(row.domesticPeerSync),
      diagnostics: normalizeDiagnostics(row.diagnostics)
    });
  }
  if (row.state === 'connecting') {
    return {
      ...idleConnection(),
      mode: row.mode === 'employee' ? 'employee' : 'guest',
      diagnostics: normalizeDiagnostics(row.diagnostics),
      health: {
        ...idleHealth(),
        wireGuard: 'stale',
        internalApi: 'idle'
      }
    };
  }
  return {
    ...idleConnection(),
    diagnostics: normalizeDiagnostics(row.diagnostics)
  };
}

function normalizeLeaseCapabilities(input) {
  const rows = input && typeof input === 'object' ? Object.values(input) : [];
  return Object.fromEntries(rows
    .filter((row) => row && typeof row === 'object')
    .map((row) => ({
      capabilityKey: nullableString(row.capabilityKey) || nullableString(row.leaseId),
      leaseId: nullableString(row.leaseId),
      capability: nullableString(row.capability),
      productId: nullableString(row.productId),
      identityKind: row.identityKind === 'user' ? 'user' : 'anonymous',
      leaseProfile: ['employee', 'feishu', 'anonymous'].includes(row.leaseProfile)
        ? row.leaseProfile
        : row.identityKind === 'user' ? 'employee' : 'anonymous',
      installId: nullableString(row.installId),
      userId: nullableString(row.userId),
      publicKey: nullableString(row.publicKey),
      expiresAt: nullableString(row.expiresAt),
      updatedAt: nullableString(row.updatedAt) || nowIso()
    }))
    .filter((row) => row.capabilityKey && row.capability)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 16)
    .map((row) => [row.capabilityKey, row]));
}

function normalizePendingNetworkHandover(input) {
  const row = input && typeof input === 'object' ? input : null;
  if (!row) return null;
  const oldLeaseId = nullableString(row.oldLeaseId);
  const newLeaseId = nullableString(row.newLeaseId);
  if (!oldLeaseId || !newLeaseId || oldLeaseId === newLeaseId) return null;
  return {
    transitionId: nullableString(row.transitionId),
    phase: ['preparing', 'prepared', 'commit-pending', 'abort-pending'].includes(row.phase)
      ? row.phase
      : 'preparing',
    oldLeaseId,
    newLeaseId,
    oldConnection: row.oldConnection && typeof row.oldConnection === 'object'
      ? visibleConnection(row.oldConnection)
      : null,
    newRoutePlan: normalizeRoutePlan(row.newRoutePlan),
    bootstrapBaseUrl: normalizeBaseUrl(row.bootstrapBaseUrl),
    bootstrapResolveMode: normalizeBootstrapResolveMode(row.bootstrapResolveMode),
    startedAt: nullableString(row.startedAt) || nowIso(),
    updatedAt: nullableString(row.updatedAt) || nowIso()
  };
}

function rememberLeaseCapability(lease) {
  const leaseId = nullableString(lease?.leaseId);
  const capability = nullableString(lease?.capability);
  if (!leaseId || !capability) return;
  const previous = Object.fromEntries(Object.entries(runtime.leaseCapabilities || {})
    .filter(([, record]) => (
      record?.leaseId && record.leaseId !== leaseId
        ? true
        : record?.capability !== capability
    )));
  runtime.leaseCapabilities = normalizeLeaseCapabilities({
    ...previous,
    [leaseId]: {
      capabilityKey: leaseId,
      leaseId,
      capability,
      productId: nullableString(lease.productId),
      identityKind: lease.identityKind === 'user' ? 'user' : 'anonymous',
      leaseProfile: nullableString(lease.leaseProfile),
      installId: nullableString(lease.installId),
      userId: nullableString(lease.userId),
      publicKey: nullableString(lease.publicKey),
      expiresAt: nullableString(lease.expiresAt),
      updatedAt: nowIso()
    }
  });
}

function ensurePendingLeaseCapability(input) {
  const requestedProfile = input.identityKind === 'user'
    ? input.authProvider === 'feishu' ? 'feishu' : 'employee'
    : 'anonymous';
  const userId = nullableString(input.userId) || 'anonymous';
  const productId = launcherProductId();
  const installId = nullableString(runtime.installation?.installId);
  if (!installId) {
    throw new Error('Lease capability requires a bound installation.');
  }
  const capabilityKey = `pending:${productId}:${installId}:${requestedProfile}:${userId}`;
  const existing = runtime.leaseCapabilities?.[capabilityKey];
  if (existing?.capability) return existing.capability;
  const capability = `mxlc1.${randomBytes(32).toString('base64url')}`;
  runtime.leaseCapabilities = normalizeLeaseCapabilities({
    ...(runtime.leaseCapabilities || {}),
    [capabilityKey]: {
      capabilityKey,
      leaseId: null,
      capability,
      productId,
      identityKind: input.identityKind === 'user' ? 'user' : 'anonymous',
      leaseProfile: requestedProfile,
      installId,
      userId: nullableString(input.userId),
      publicKey: nullableString(runtime.installation?.keyPair?.publicKey),
      expiresAt: null,
      updatedAt: nowIso()
    }
  });
  return capability;
}

function leaseCapabilitiesForEnrollment(input) {
  const installation = runtime.installation || {};
  const installId = nullableString(installation.installId);
  const publicKey = nullableString(installation.keyPair?.publicKey);
  const productId = launcherProductId();
  if (!installId || !publicKey) return undefined;
  const records = Object.values(runtime.leaseCapabilities || {});
  const relevant = records.filter((record) => (
    record
    && record.productId === productId
    && record.installId === installId
    && record.publicKey === publicKey
  ));
  const requestedProfile = input.identityKind === 'user'
    ? input.authProvider === 'feishu' ? 'feishu' : 'employee'
    : 'anonymous';
  return [...new Set(relevant
    .sort((left, right) => {
      const leftPriority = left.leaseProfile === requestedProfile ? 1 : 0;
      const rightPriority = right.leaseProfile === requestedProfile ? 1 : 0;
      return rightPriority - leftPriority || right.updatedAt.localeCompare(left.updatedAt);
    })
    .map((record) => nullableString(record.capability))
    .filter(Boolean))].slice(0, 16).join(',') || undefined;
}

function leaseAccessForLeaseId(leaseId) {
  const normalizedLeaseId = nullableString(leaseId);
  const record = normalizedLeaseId ? runtime.leaseCapabilities?.[normalizedLeaseId] : null;
  const capability = nullableString(record?.capability);
  return normalizedLeaseId && capability
    ? { leaseId: normalizedLeaseId, capability }
    : null;
}

function retainableConnectionSnapshot(connection) {
  if (!connection || typeof connection !== 'object') return null;
  if (isRetainedConnectionState(connection.state)) return connection;
  return null;
}

function normalizeIdentity(input) {
  const row = input && typeof input === 'object' ? input : {};
  if (row.kind === 'user') {
    return {
      kind: 'user',
      provider: row.provider === 'feishu' ? 'feishu' : 'password',
      displayName: stringValue(row.displayName, 'employee'),
      account: stringValue(row.account, 'employee@qpjoy.local'),
      scopes: arrayValue(row.scopes, ['auth.read', 'appcenter.read'])
    };
  }
  return {
    kind: 'anonymous',
    provider: null,
    displayName: 'Visitor',
    account: null,
    scopes: ['auth.read']
  };
}

function normalizeAuth(input) {
  const row = input && typeof input === 'object' ? input : {};
  const accessToken = nullableString(row.accessToken) || nullableString(row.access_token);
  if (!accessToken) return null;
  return {
    accessToken,
    tokenType: nullableString(row.tokenType) || nullableString(row.token_type) || 'Bearer',
    issuedTokenType: nullableString(row.issuedTokenType) || nullableString(row.issued_token_type) || 'urn:ietf:params:oauth:token-type:jwt',
    issuer: nullableString(row.issuer),
    audience: nullableString(row.audience),
    subject: nullableString(row.subject),
    expiresAt: nullableString(row.expiresAt) || nullableString(row.expires_at),
    scopes: arrayValue(row.scopes, typeof row.scope === 'string' ? row.scope.split(/\s+/) : []),
    provider: row.provider === 'feishu' || row.auth_provider === 'feishu' ? 'feishu' : 'password'
  };
}

function normalizeApps(input) {
  const row = input && typeof input === 'object' ? input : {};
  const apps = {
    appcenter: normalizeApp(row.appcenter, {
      appId: 'appcenter',
      displayName: 'AppCenter',
      category: 'platform',
      description: '内置应用市场，负责应用发现、安装、权限申请和版本状态。',
      packageName: '@qpjoy/electron-launcher-appcenter',
      launcherMode: 'embed',
      standaloneChannelProductId: 'mx-h2i',
      networkScope: 'broker-session',
      serviceVip: '10.88.100.9',
      version: '0.1.0',
      latestVersion: '0.1.0',
      updatePolicy: 'launcher-managed',
      permissions: ['auth.read', 'appcenter.read', 'permission.request'],
      installSource: 'builtin',
      installPath: 'builtin://appcenter',
      entrypoints: {
        desktop: 'app://appcenter/index.html',
        settings: 'app://appcenter/settings.html'
      }
    }),
    h2o: normalizeApp(row.h2o, {
      appId: 'h2o',
      displayName: 'H2O',
      fullName: 'Home To Oversea',
      category: 'network',
      description: 'AppCenter 内置的 Home To Oversea 网络插件，提供类 Clash 的代理模式、PAC、Split DNS 和 Internal 出海状态面板。',
      packageName: '@qpjoy/electron-launcher-app-h2o',
      launcherMode: 'embed',
      standaloneChannelProductId: 'mx-h2i',
      networkScope: 'broker-session',
      serviceVip: '10.88.100.10',
      version: '0.1.0',
      latestVersion: '0.1.0',
      updatePolicy: 'launcher-managed',
      permissions: ['network.hdi.status', 'network.proxy.app', 'network.dns.policy', 'network.pac.policy', 'system:exec:mihomo'],
      requiredCapabilities: ['user.session', 'network.status', 'network.proxy', 'network.dns.policy', 'network.pac.policy', 'network.tunnel.mihomo', 'app-center-runtime'],
      manifest: {
        appId: 'h2o',
        productId: 'h2o',
        displayName: 'H2O',
        description: 'AppCenter 内置的 Home To Oversea 网络插件，提供类 Clash 的代理模式、PAC、Split DNS 和 Internal 出海状态面板。',
        packageName: '@qpjoy/electron-launcher-app-h2o',
        category: 'network',
        launcherMode: 'embed',
        protocolVersion: '2',
        runtimeContractVersion: '0.1',
        requiredCapabilities: ['user.session', 'network.status', 'network.proxy', 'network.dns.policy', 'network.pac.policy', 'network.tunnel.mihomo', 'app-center-runtime'],
        network: { scope: 'broker-session' },
        runtimeDependencies: {
          packages: ['@qpjoy/electron-plugin-tunnel', '@qpjoy/electron-core-mihomo'],
          optionalPackages: [
            '@qpjoy/electron-plugin-tunnel-engine-darwin-arm64',
            '@qpjoy/electron-plugin-tunnel-engine-darwin-x64',
            '@qpjoy/electron-plugin-tunnel-engine-linux-arm64',
            '@qpjoy/electron-plugin-tunnel-engine-linux-x64',
            '@qpjoy/electron-plugin-tunnel-engine-win32-x64'
          ]
        },
        embed: { standaloneChannelProductId: 'mx-h2i', launchWithoutBroker: 'blocked' }
      },
      installSource: 'builtin',
      installPath: 'builtin://h2o',
      entrypoints: {
        desktop: 'app://h2o/index.html',
        settings: 'app://h2o/settings.html',
        dev: 'workspace:demos/mx-app-h2o'
      },
      runtime: defaultH2oPluginRuntime()
    })
  };
  for (const [key, value] of Object.entries(row)) {
    if (apps[key]) continue;
    apps[key] = normalizeApp(value, defaultAppRecordFor(value, key));
  }
  return apps;
}

function normalizeApp(input, defaults) {
  const row = input && typeof input === 'object' ? input : {};
  const installed = row.installed === true;
  const enabled = row.enabled === true;
  const version = nullableString(row.version) || defaults.version || '0.1.0';
  const launcherMode = row.launcherMode === 'standalone' ? 'standalone' : row.launcherMode === 'embed' ? 'embed' : defaults.launcherMode || 'embed';
  return {
    ...defaults,
    appId: nullableString(row.appId) || defaults.appId,
    displayName: nullableString(row.displayName) || defaults.displayName || nullableString(row.appId) || defaults.appId || 'App',
    fullName: nullableString(row.fullName) || nullableString(defaults.fullName),
    category: nullableString(row.category) || defaults.category || 'custom',
    version,
    launcherMode,
    standaloneChannelProductId: nullableString(row.standaloneChannelProductId) || defaults.standaloneChannelProductId || 'mx-h2i',
    productNetworkId: nullableString(row.productNetworkId) || nullableString(defaults.productNetworkId),
    serviceVip: nullableString(row.serviceVip) || nullableString(defaults.serviceVip),
    updatePolicy: nullableString(row.updatePolicy) || defaults.updatePolicy || 'launcher-managed',
    permissions: arrayValue(row.permissions, defaults.permissions || []),
    requiredCapabilities: arrayValue(row.requiredCapabilities, defaults.requiredCapabilities || []),
    channels: arrayValue(row.channels, defaults.channels || []),
    networkScope: nullableString(row.networkScope) || defaults.networkScope || (launcherMode === 'embed' ? 'broker-session' : 'owner'),
    packageName: nullableString(row.packageName) || defaults.packageName || null,
    latestVersion: nullableString(row.latestVersion) || version || defaults.latestVersion || defaults.version,
    installedVersion: nullableString(row.installedVersion),
    installedAt: nullableString(row.installedAt),
    installPath: nullableString(row.installPath) || nullableString(defaults.installPath),
    description: nullableString(row.description) || defaults.description || '',
    installSource: nullableString(row.installSource) || defaults.installSource || 'npm',
    runtimeState: nullableString(row.runtimeState) || (enabled ? 'ready' : installed ? 'installed' : 'idle'),
    entrypoints: normalizeStringRecord(row.entrypoints, defaults.entrypoints || {}),
    manifest: row.manifest && typeof row.manifest === 'object' ? row.manifest : defaults.manifest || null,
    runtime: normalizeAppRuntime(row.runtime, defaults.runtime),
    errorMessage: nullableString(row.errorMessage),
    logs: normalizeAppLogs(row.logs),
    installed,
    enabled,
    status: stringValue(row.status, enabled ? 'ready' : installed ? 'installed' : 'available'),
    lastAction: typeof row.lastAction === 'string' ? row.lastAction : null
  };
}

function normalizeAppRuntime(input, defaults) {
  if (defaults?.kind === 'h2o-plugin' || input?.kind === 'h2o-plugin') {
    return h2oPluginRuntime({ ...(defaults || {}), ...(input || {}) });
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) return { ...input };
  if (defaults && typeof defaults === 'object' && !Array.isArray(defaults)) return { ...defaults };
  return null;
}

function defaultH2oPluginRuntime() {
  return h2oPluginRuntime({});
}

function h2oPluginRuntime(input) {
  const row = input && typeof input === 'object' ? input : {};
  const ports = row.ports && typeof row.ports === 'object' ? row.ports : {};
  const subscription = row.activeSubscription && typeof row.activeSubscription === 'object' ? row.activeSubscription : {};
  const subscriptions = normalizeH2oSubscriptions(row.subscriptions, subscription);
  const activeSubscriptionId = nullableString(row.activeSubscriptionId)
    || nullableString(subscription.id)
    || subscriptions[0]?.id
    || 'h2o-default';
  const activeSubscription = subscriptions.find((item) => item.id === activeSubscriptionId) || subscriptions[0] || normalizeH2oSubscription(subscription, {});
  const rawStatus = nullableString(row.status) || (row.running === true ? 'running' : 'stopped');
  const status = !row.running && rawStatus === 'ready' && !h2oHasUsableSubscription(activeSubscription)
    ? 'subscription-required'
    : rawStatus;
  return {
    kind: 'h2o-plugin',
    mode: normalizeH2oMode(row.mode),
    running: row.running === true,
    status,
    tunInstalled: row.tunInstalled === true,
    adminUrl: nullableString(row.adminUrl) || 'http://127.0.0.1:23456',
    ports: {
      admin: normalizePort(ports.admin, 23456),
      controller: normalizePort(ports.controller, 23457),
      mixed: normalizePort(ports.mixed, 23458),
      dns: normalizePort(ports.dns, 1053)
    },
    tuning: normalizeH2oTuning(row.tuning),
    nodes: normalizeH2oNodes(row.nodes),
    selectedNode: nullableString(row.selectedNode),
    activeSubscriptionId: activeSubscription.id,
    activeSubscription,
    subscriptions,
    rules: normalizeH2oRules(row.rules),
    metrics: normalizeH2oMetrics(row.metrics),
    clashLink: normalizeH2oClashLink(row.clashLink),
    // 用户选的是 selectedNode，实际出流量的是 activeNode——开了自动顺延时两者会不一样。
    activeNode: nullableString(row.activeNode),
    startedAt: nullableString(row.startedAt),
    lastAppliedAt: nullableString(row.lastAppliedAt)
  };
}

/**
 * 只保存可复制的地址和有效期；token 本身就在 URL 里，不额外留副本。
 *
 * `url` 为空但有 issuedAt/expiresAt 是一个有意义的状态：服务端有活跃链接，但明文只在
 * 签发那一次返回过，本机没有副本——UI 要能把「还没有链接」和「有链接但看不到」分开说。
 */
function normalizeH2oClashLink(value) {
  const row = value && typeof value === 'object' ? value : {};
  const url = nullableString(row.url);
  const issuedAt = nullableString(row.issuedAt);
  const expiresAt = nullableString(row.expiresAt);
  if (!url && !issuedAt && !expiresAt) return null;
  return { url, issuedAt, expiresAt };
}

function normalizeH2oSubscriptions(value, activeSubscription) {
  const rows = Array.isArray(value) ? value : [];
  const normalized = rows
    .map((item) => normalizeH2oSubscription(item, {}))
    .filter((item) => item && !h2oShouldDropSubscription(item));
  const active = normalizeH2oSubscription(activeSubscription, {});
  if (!h2oShouldDropSubscription(active) && !normalized.some((item) => item.id === active.id)) normalized.unshift(active);
  if (!normalized.some((item) => item.id === 'h2o-default')) {
    normalized.unshift(normalizeH2oSubscription({
      id: 'h2o-default',
      name: 'System Oversea 默认订阅',
      url: 'mx-h2i://managed/home-to-oversea',
      nodes: 6,
      latencyMs: 42,
      status: runtimeHasUserIdentity() ? 'pending' : 'login-required',
      source: 'internal',
      requiresUser: true,
      syncStatus: runtimeHasUserIdentity() ? 'missing-entitlement' : 'login-required',
      errorMessage: runtimeHasUserIdentity() ? '当前用户还没有可用的系统 oversea 订阅。' : '系统 oversea 订阅需要先登录员工用户。'
    }, {}));
  }
  return orderH2oSubscriptions(normalized).slice(0, 12);
}

function normalizeH2oSubscription(input, defaults) {
  const row = input && typeof input === 'object' ? input : {};
  const id = nullableString(row.id) || nullableString(defaults.id) || 'h2o-default';
  const source = nullableString(row.source) || nullableString(defaults.source) || 'internal';
  const requiresUser = row.requiresUser === true
    || defaults.requiresUser === true
    || (source !== 'demo' && source !== 'custom' && source !== 'external' && id.startsWith('h2o-'));
  let status = requiresUser && !runtimeHasUserIdentity()
    ? 'login-required'
    : nullableString(row.status) || nullableString(defaults.status) || 'ready';
  if (requiresUser && runtimeHasUserIdentity() && status === 'login-required') {
    status = source === 'internal' || h2oIsManagedSubscriptionId(id) ? 'pending' : status;
  }
  const rawSyncStatus = nullableString(row.syncStatus) || nullableString(defaults.syncStatus);
  const syncStatus = status === 'pending' && rawSyncStatus === 'login-required'
    ? 'missing-entitlement'
    : rawSyncStatus;
  const rawErrorMessage = nullableString(row.errorMessage) || nullableString(defaults.errorMessage);
  const errorMessage = status === 'pending' && /登录员工用户|等待登录|login/i.test(rawErrorMessage || '')
    ? '当前用户还没有可用的系统 oversea 订阅。'
    : rawErrorMessage;
  const rawUrl = nullableString(row.url) || nullableString(defaults.url) || 'mx-h2i://managed/home-to-oversea';
  const url = source === 'internal' || h2oIsManagedSubscriptionId(id)
    ? h2oManagedSubscriptionUrl(rawUrl) || rawUrl
    : rawUrl;
  return {
    id,
    name: nullableString(row.name) || nullableString(defaults.name) || 'System Oversea 默认订阅',
    url,
    nodes: normalizeNonNegativeInteger(row.nodes, normalizeNonNegativeInteger(defaults.nodes, 6)),
    latencyMs: normalizeNonNegativeInteger(row.latencyMs, normalizeNonNegativeInteger(defaults.latencyMs, 42)),
    status,
    source,
    requiresUser,
    assignable: row.assignable !== false && defaults.assignable !== false,
    entitlementId: nullableString(row.entitlementId) || nullableString(defaults.entitlementId),
    siteIds: arrayValue(row.siteIds, arrayValue(defaults.siteIds, [])).map((item) => String(item || '').trim()).filter(Boolean),
    syncStatus,
    errorMessage,
    yamlBytes: normalizeNonNegativeInteger(row.yamlBytes, normalizeNonNegativeInteger(defaults.yamlBytes, 0)),
    // 上一次真正取回内容的地址；比 url 更可信，候选链会优先用它。
    resolvedUrl: nullableString(row.resolvedUrl) || nullableString(defaults.resolvedUrl),
    auth: normalizeH2oSubscriptionAuth(row.auth, defaults.auth),
    headers: normalizeStringRecord(row.headers, defaults.headers || {}),
    pinnedAt: nullableString(row.pinnedAt) || nullableString(defaults.pinnedAt),
    lastUpdatedAt: nullableString(row.lastUpdatedAt) || nullableString(defaults.lastUpdatedAt) || nowIso()
  };
}

function orderH2oSubscriptions(subscriptions) {
  return subscriptions
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftPinned = Date.parse(left.item.pinnedAt || '');
      const rightPinned = Date.parse(right.item.pinnedAt || '');
      const leftHasPin = Number.isFinite(leftPinned);
      const rightHasPin = Number.isFinite(rightPinned);
      if (leftHasPin && rightHasPin) return rightPinned - leftPinned || left.index - right.index;
      if (leftHasPin) return -1;
      if (rightHasPin) return 1;
      return left.index - right.index;
    })
    .map(({ item }) => item);
}

function normalizeH2oSubscriptionAuth(input, defaults = {}) {
  const row = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const base = defaults && typeof defaults === 'object' && !Array.isArray(defaults) ? defaults : {};
  const type = String(row.type || base.type || 'none').trim().toLowerCase();
  if (type === 'basic') {
    return {
      type: 'basic',
      username: nullableString(row.username) ?? nullableString(base.username) ?? '',
      password: nullableString(row.password) ?? nullableString(base.password) ?? ''
    };
  }
  return { type: 'none', username: null, password: null };
}

function normalizeH2oRules(value) {
  const rows = Array.isArray(value) ? value : [];
  const normalized = rows.map((item) => {
    const row = item && typeof item === 'object' ? item : {};
    const host = nullableString(row.host);
    if (!host) return null;
    const kind = normalizeH2oRuleKind(nullableString(row.kind) || policyToH2oRuleKind(row.policy));
    return {
      id: nullableString(row.id) || h2oRuleIdFromHost(host),
      host,
      target: nullableString(row.target) || defaultH2oRuleTarget(kind),
      kind,
      enabled: row.enabled !== false,
      source: nullableString(row.source) || 'managed',
      hitCount: normalizeNonNegativeInteger(row.hitCount, 0)
    };
  }).filter(Boolean);
  if (normalized.length) return normalized.slice(0, 96);
  return [
    { id: 'google', host: 'google.com', target: 'App 模式白名单', kind: 'allow', enabled: true, source: 'preset:google', hitCount: 0 },
    { id: 'youtube', host: 'youtube.com', target: 'App 模式白名单', kind: 'allow', enabled: true, source: 'preset:youtube', hitCount: 0 },
    { id: 'telegram', host: 'telegram.org', target: 'App 模式白名单', kind: 'allow', enabled: true, source: 'preset:telegram', hitCount: 0 },
    { id: 'internal-api', host: 'api.mxinfo-inc.cn', target: '全局/TUN 黑名单', kind: 'block', enabled: true, source: 'builtin', hitCount: 0 }
  ];
}

function normalizeH2oMetrics(value) {
  const row = value && typeof value === 'object' ? value : {};
  return {
    uploadBytes: normalizeNonNegativeInteger(row.uploadBytes, 0),
    downloadBytes: normalizeNonNegativeInteger(row.downloadBytes, 0),
    connections: normalizeNonNegativeInteger(row.connections, 0),
    lastProxyAppliedAt: nullableString(row.lastProxyAppliedAt)
  };
}

function h2oRuleIdFromHost(host) {
  return String(host || 'rule').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'rule';
}

function defaultH2oRuleTarget(kind) {
  return kind === 'block' ? '全局/TUN 黑名单' : 'App 模式白名单';
}

function normalizeH2oRuleKind(value) {
  return String(value || '').trim() === 'block' ? 'block' : 'allow';
}

function policyToH2oRuleKind(policy) {
  return ['internal-direct', 'direct', 'block', 'blacklist'].includes(String(policy || '').trim()) ? 'block' : 'allow';
}

const H2O_MODES = ['app-rule', 'app-global', 'system-tun'];

function normalizeH2oMode(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'rule') return 'app-rule';
  if (text === 'global' || text === 'direct') return 'app-global';
  // system-fakeip 曾短暂作为独立模式存在，现在折叠成 system-tun + dnsMode。
  if (text === 'tun' || text === 'system-fakeip' || text === 'fakeip' || text === 'fake-ip') return 'system-tun';
  return H2O_MODES.includes(text) ? text : 'app-global';
}

/** 虚拟网卡模式需要 TUN 安装 + 管理员授权。 */
function h2oModeNeedsTun(mode) {
  return normalizeH2oMode(mode) === 'system-tun';
}

// 订阅里可选的出海节点。一个 oversea entitlement 可能覆盖多台机器
// （oversea-main / oversea-mx / oversea-sg-1…），用户在这些之间切换。
function normalizeH2oNodes(value) {
  const rows = Array.isArray(value) ? value : [];
  return rows.map((item) => {
    const row = item && typeof item === 'object' ? item : {};
    const name = nullableString(row.name);
    if (!name) return null;
    return {
      name,
      type: nullableString(row.type),
      server: nullableString(row.server),
      port: normalizeNonNegativeInteger(row.port, 0) || null,
      latencyMs: normalizeNonNegativeInteger(row.latencyMs, 0) || null
    };
  }).filter(Boolean).slice(0, 64);
}

// fake-ip / redir-host、TUN 协议栈、cn-direct 都是 mode 之外的独立开关，
// 和 Clash 的设置分层一致：换模式不该把用户的 DNS 偏好重置掉。
function normalizeH2oTuning(value) {
  const row = value && typeof value === 'object' ? value : {};
  const dnsMode = String(row.dnsMode || '').trim().toLowerCase().replace(/_/g, '-');
  const tunStack = String(row.tunStack || '').trim().toLowerCase();
  return {
    dnsMode: ['redir-host', 'redir', 'real-ip'].includes(dnsMode) ? 'redir-host' : 'fake-ip',
    // 默认 system：内核栈最快，也是判断问题是否出在协议栈上的基线；
    // 出问题按 system -> mixed -> gvisor 升级。
    tunStack: ['gvisor', 'mixed'].includes(tunStack) ? tunStack : 'system',
    strictRoute: row.strictRoute === true,
    cnDirect: row.cnDirect !== false
  };
}

function h2oHasUsableSubscription(subscription) {
  if (!subscription) return false;
  if (subscription.requiresUser && !runtimeHasUserIdentity()) return false;
  if (['login-required', 'pending', 'error'].includes(subscription.status)) return false;
  if (!h2oLooksLikeHttpSubscriptionUrl(subscription.url)) return false;
  return Number(subscription.nodes || 0) > 0;
}

function runtimeHasUserIdentity() {
  return runtime?.identity?.kind === 'user'
    || runtime?.connection?.mode === 'employee'
    || h2oSubjectLooksLikeUser(runtime?.auth?.subject)
    || h2oSubjectLooksLikeUser(runtime?.connection?.subject);
}

function h2oSubjectLooksLikeUser(subject) {
  const text = nullableString(subject);
  return Boolean(text && text.startsWith('user:'));
}

async function h2oCurrentUserId(options = {}) {
  return h2oKnownUserId() || await resolveH2oUserIdFromAccount(options);
}

function h2oKnownUserId() {
  return nullableString(runtime?.auth?.user?.userId)
    || h2oUserIdFromSubject(runtime?.auth?.subject)
    || h2oUserIdFromSubject(runtime?.connection?.subject);
}

function h2oUserIdFromSubject(subject) {
  const text = nullableString(subject);
  if (!text) return null;
  if (text.startsWith('user:')) return nullableString(text.slice('user:'.length));
  return /^usr[_-]/i.test(text) ? text : null;
}

async function resolveH2oUserIdFromAccount(options = {}) {
  const account = nullableString(runtime?.identity?.account)
    || nullableString(runtime?.identity?.displayName);
  if (!account || account === 'Visitor') return null;
  const baseUrl = normalizeBaseUrl(options.baseUrl)
    || normalizeBaseUrl(runtime.connection?.internalBaseUrl)
    || normalizeBaseUrl(runtime.config?.internalApiBaseUrl)
    || normalizeBaseUrl(runtime.config?.bootstrapApiBaseUrl);
  if (!baseUrl) return null;
  try {
    // Same public-vs-Internal fallback as the hydrate path: the user directory is
    // not on Domestic's public allowlist, so the bootstrap base URL 404s here.
    const { payload } = await h2oRequestInternalJson(baseUrl, '/internal/v1/user-center/users', {
      timeoutMs: 3500,
      bootstrapResolveMode: options.bootstrapResolveMode,
      headers: appCenterCatalogHeaders()
    });
    const users = Array.isArray(payload?.users) ? payload.users : [];
    const target = account.trim().toLowerCase();
    const user = users.find((item) => [
      item?.userId,
      item?.account,
      item?.email,
      item?.displayName
    ].map((value) => String(value || '').trim().toLowerCase()).includes(target));
    return nullableString(user?.userId);
  } catch (err) {
    pushAppLog('h2o', 'warning', `H2O userId lookup failed for account ${account}: ${errorMessage(err)}`);
    return null;
  }
}

async function ensureH2oActiveSubscriptionReady(currentRuntime, options = {}) {
  let current = h2oPluginRuntime(currentRuntime);
  if (h2oHasUsableSubscription(current.activeSubscription)) {
    return ensureH2oManagedSubscriptionsReady(current, options);
  }

  const localPreferred = firstUsableH2oLocalSubscription(current);
  if (localPreferred) {
    const restored = activateH2oSubscription(current, localPreferred, options.reason || 'restore-local-subscription');
    return ensureH2oManagedSubscriptionsReady(restored, options);
  }

  if (h2oCanAutoHydrateManagedSubscription(current.activeSubscription)) {
    await markH2oSystemSubscriptionInitializing(current, options.reason || 'hydrate-managed-subscription');
    await hydrateH2oSystemSubscriptionsForUser({
      ...options,
      autoProvision: options.autoProvision !== false,
      showInitializing: false
    });
    current = h2oPluginRuntime(runtime.apps.h2o.runtime);
    if (h2oHasUsableSubscription(current.activeSubscription)) return current;

    const defaultSubscription = current.subscriptions.find((item) => item.id === 'h2o-default');
    if (h2oHasUsableSubscription(defaultSubscription)) {
      return activateH2oSubscription(current, defaultSubscription, options.reason || 'managed-oversea-default');
    }

    const localFallback = firstUsableH2oLocalSubscription(current);
    if (localFallback) {
      return activateH2oSubscription(current, localFallback, options.reason || 'fallback-local-subscription');
    }
  }

  return current;
}

async function ensureH2oManagedSubscriptionsReady(currentRuntime, options = {}) {
  const current = h2oPluginRuntime(currentRuntime);
  if (!h2oManagedSubscriptionNeedsEnsure(current)) return current;
  if (!h2oManagedHydrateInFlight) {
    h2oManagedHydrateInFlight = (async () => {
      await hydrateH2oSystemSubscriptionsForUser({
        ...options,
        autoProvision: options.autoProvision !== false,
        autoSyncRuntime: options.autoSyncRuntime !== false,
        showInitializing: options.showInitializing === true
      });
    })().catch((err) => {
      pushAppLog('h2o', 'warning', `H2O managed oversea ensure skipped: ${errorMessage(err)}`);
    }).finally(() => {
      h2oManagedHydrateInFlight = null;
    });
  }
  await h2oManagedHydrateInFlight;
  return h2oPluginRuntime(runtime?.apps?.h2o?.runtime || current);
}

function h2oManagedSubscriptionNeedsEnsure(h2oRuntime) {
  if (!runtimeHasUserIdentity()) return false;
  const current = h2oPluginRuntime(h2oRuntime);
  const managed = current.subscriptions.filter((item) => h2oIsHydratableManagedSubscription(item));
  if (!managed.length) return true;
  if (
    h2oIsHydratableManagedSubscription(current.activeSubscription)
    && h2oManagedSubscriptionIsStale(current.activeSubscription)
  ) {
    return true;
  }
  return managed.some((item) => {
    const syncStatus = nullableString(item.syncStatus);
    return !h2oHasUsableSubscription(item)
      || ['login-required', 'pending', 'error'].includes(nullableString(item.status))
      || h2oManagedSubscriptionIsStale(item)
      || ['missing-entitlement', 'missing-active-account', 'pending-runtime-sync', 'initializing', 'auto-provision-failed', 'fetch-failed', 'missing-user'].includes(syncStatus);
  });
}

function h2oIsHydratableManagedSubscription(item) {
  const id = nullableString(item?.id);
  return id === 'h2o-default'
    || (/^h2o-oversea-/i.test(id || '') && id !== 'h2o-oversea-backup');
}

function h2oManagedSubscriptionIsStale(item) {
  if (!h2oHasUsableSubscription(item)) return false;
  const updatedAt = Date.parse(nullableString(item?.lastUpdatedAt) || '');
  return Number.isFinite(updatedAt)
    && Date.now() - updatedAt > H2O_MANAGED_SUBSCRIPTION_REFRESH_MS;
}

async function markH2oSystemSubscriptionInitializing(currentRuntime, reason = 'h2o-subscription-initializing') {
  applyH2oManagedSubscriptionState(h2oPluginRuntime(currentRuntime), {
    status: 'pending',
    syncStatus: 'initializing',
    errorMessage: '正在为当前用户初始化系统 oversea 订阅。'
  });
  runtime.apps.h2o.status = 'enabled';
  runtime.apps.h2o.runtimeState = 'ready';
  runtime.apps.h2o.lastAction = nowIso();
  runtime.feedback = {
    tone: 'info',
    message: '正在为当前用户初始化 H2O oversea 订阅，请稍等。'
  };
  touchRuntime(reason);
  await saveAndBroadcast();
}

function h2oCanAutoHydrateManagedSubscription(subscription) {
  if (!runtimeHasUserIdentity()) return false;
  if (!subscription) return true;
  return subscription.requiresUser === true
    || nullableString(subscription.source) === 'internal'
    || h2oLooksLikeManagedSubscriptionUrl(subscription.url);
}

function firstUsableH2oLocalSubscription(h2oRuntime) {
  const current = h2oPluginRuntime(h2oRuntime);
  const candidates = h2oPreservedLocalSubscriptions(current);
  return candidates.find((item) => h2oHasUsableSubscription(item)) || null;
}

function activateH2oSubscription(currentRuntime, subscription, reason = 'subscription-active') {
  const current = h2oPluginRuntime(currentRuntime);
  const activeSubscription = normalizeH2oSubscription(subscription, {});
  const subscriptions = upsertH2oRuntimeSubscription(current.subscriptions, activeSubscription);
  const nextRuntime = h2oPluginRuntime({
    ...current,
    subscriptions,
    activeSubscription,
    activeSubscriptionId: activeSubscription.id,
    status: current.running ? 'running' : h2oHasUsableSubscription(activeSubscription) ? 'ready' : 'subscription-required',
    lastAppliedAt: nowIso()
  });
  runtime.apps.h2o.runtime = nextRuntime;
  pushAppLog('h2o', 'info', `H2O active subscription selected for ${reason}: ${activeSubscription.name}.`);
  return nextRuntime;
}

function upsertH2oRuntimeSubscription(subscriptions, subscription) {
  const normalized = normalizeH2oSubscription(subscription, {});
  const rows = Array.isArray(subscriptions) ? subscriptions : [];
  const normalizedExternalUrl = h2oLooksLikeExternalSubscriptionUrl(normalized.url)
    ? h2oComparableSubscriptionUrl(normalized.url)
    : '';
  return [
    normalized,
    ...rows.filter((item) => (
      item?.id !== normalized.id
      && !(normalizedExternalUrl && h2oComparableSubscriptionUrl(item?.url) === normalizedExternalUrl)
    ))
  ].slice(0, 12);
}

function loadH2oMihomoManagerClass() {
  const directPackageCandidates = [
    () => {
      const packageJsonPath = require.resolve('@qpjoy/electron-plugin-tunnel/package.json');
      return path.join(path.dirname(packageJsonPath), 'dist', 'mihomo', 'MihomoManager.js');
    },
    () => path.resolve(__dirname, '../../../../../electron-plugin/packages/electron-plugin-tunnel/dist/mihomo/MihomoManager.js')
  ];
  let lastError = null;
  for (const resolveCandidate of directPackageCandidates) {
    try {
      const modulePath = resolveCandidate();
      const mod = require(modulePath);
      if (typeof mod?.MihomoManager === 'function') return mod.MihomoManager;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`缺少 H2O tunnel runtime 依赖 @qpjoy/electron-plugin-tunnel / @qpjoy/electron-core-mihomo：${errorMessage(lastError)}`);
}

function getH2oTunnelManager() {
  if (h2oTunnelManager) return h2oTunnelManager;
  const MihomoManager = loadH2oMihomoManagerClass();
  const current = h2oPluginRuntime(runtime.apps.h2o.runtime);
  h2oTunnelManager = new MihomoManager({
    userDataPath: path.join(app.getPath('userData'), 'h2o'),
    adminPort: current.ports.admin,
    controllerPort: current.ports.controller,
    mixedPort: current.ports.mixed,
    dnsPort: current.ports.dns
  });
  // 进程重启后 manager 是新实例，先补一次控制面白名单，
  // 避免 admin 页 / 订阅刷新触发的 renderConfig 少了直连规则。
  if (typeof h2oTunnelManager.setRuntimeGuard === 'function') {
    h2oTunnelManager.setRuntimeGuard(h2oControlPlaneGuard(current));
  }
  if (typeof h2oTunnelManager.setRuntimeTuning === 'function') {
    h2oTunnelManager.setRuntimeTuning(current.tuning);
  }
  return h2oTunnelManager;
}

async function startH2oMihomoRuntime(currentRuntime) {
  const current = h2oPluginRuntime(currentRuntime);
  const manager = getH2oTunnelManager();
  const beforeStart = typeof manager.status === 'function' ? manager.status() : null;
  if (beforeStart?.running !== true) {
    await prepareH2oRuntimePortsForStart(current, 'start');
  }
  await manager.setLocalPorts({
    mixed: current.ports.mixed,
    dns: current.ports.dns
  });
  const subscriptionInput = h2oTunnelSubscriptionInput(current.activeSubscription);
  const prefetched = await h2oPrefetchSubscriptionContent(current.activeSubscription, subscriptionInput);
  // 交给 mihomo 的 URL 必须是真正取回内容的那一个：公网 Domestic 目前不反代
  // /internal/v1/*，固定 404，预取失败时 mihomo 用同一个地址下载只会再 404 一次。
  if (prefetched?.url) subscriptionInput.url = prefetched.url;
  const result = await manager.applyManagedConfig({
    subscription: subscriptionInput,
    ...(prefetched?.yaml ? { subscriptionContent: prefetched.yaml } : {}),
    mode: current.mode,
    tuning: current.tuning,
    selectedNode: current.selectedNode,
    rules: h2oTunnelRulesForMode(current),
    guard: h2oControlPlaneGuard(current),
    source: 'h2o',
    autoStart: true,
    autoUpdate: true,
    allowSystemTunPrivilege: h2oModeNeedsTun(current.mode)
  });
  let status = result.status || manager.status();
  const mixedPort = normalizePort(status?.ports?.mixed, current.ports.mixed);
  const proxyReady = await waitForH2oStableLocalProxy(mixedPort, H2O_PROXY_START_TIMEOUT_MS, 3);
  if (proxyReady) await delay(260);
  status = manager.status();
  if (!proxyReady || status?.running !== true) {
    const recentProblem = h2oTunnelRecentProblem(manager);
    const portHint = await h2oRuntimePortDiagnosticHint(current);
    const runningHint = status?.running === true ? 'mihomo 已启动但' : 'mihomo 启动后已退出，且';
    const diagnosis = recentProblem
      ? `最近日志：${recentProblem}`
      : portHint || '请查看 H2O 日志确认订阅配置或端口是否有效。';
    throw new Error(`${runningHint} mixed-port 127.0.0.1:${mixedPort} 未监听。${diagnosis}${recentProblem && portHint ? ` ${portHint}` : ''}`);
  }
  await stopH2oOrphanMihomoProcesses({ preservePid: status?.pid, reason: 'start-ready' });
  const traffic = await h2oTunnelTrafficSummary(manager);
  return {
    ...status,
    traffic,
    nodes: h2oTunnelNodes(manager),
    selectedNode: h2oTunnelSelectedNode(manager),
    resolvedSubscriptionUrl: prefetched?.url || null
  };
}

async function stopH2oMihomoRuntime() {
  if (h2oTunnelManager) {
    await h2oTunnelManager.stop();
  }
  await stopH2oOrphanMihomoProcesses({ reason: 'stop-h2o' });
  if (runtime?.apps?.h2o?.runtime) {
    await waitForH2oRequiredPortsAvailable(runtime.apps.h2o.runtime, 2600);
  }
}

function h2oTunnelSubscriptionInput(subscription) {
  if (!subscription || !/^https?:\/\//i.test(subscription.url || '')) {
    throw new Error('H2O 当前订阅不是 http/https URL，无法交给 mihomo runtime 下载。');
  }
  const auth = normalizeH2oSubscriptionAuth(subscription.auth);
  return {
    name: subscription.name || hostnameFromUrl(subscription.url) || 'H2O Oversea',
    url: subscription.url,
    username: auth.type === 'basic' ? auth.username || undefined : undefined,
    password: auth.type === 'basic' ? auth.password || undefined : undefined
  };
}

// mihomo runtime 用裸 fetch 下载订阅，不会带 MX-H2I 的 Host Resolve / SNI 覆写；
// Domestic ingress 按 SNI 分流，裸 IP https 会直接返回 TLS unrecognized_name。
// 这里先用 launcher 自己的 requestText（带 host override + servername）取回 YAML，
// 成功就把内容直接交给 MihomoManager，避免它再发一次不带 SNI 的请求。
/**
 * managed 订阅的候选地址，按可达性排序。
 *
 * Domestic edge 目前只暴露 /healthz（`x-mx-domestic-mode: bootstrap-and-relay`），
 * `/internal/v1/*` 一律 nginx 404 —— 所以公网地址只是"将来 Domestic 开了反代就能用"
 * 的首选项，真正可达的是 WG 之后的 Internal 地址。两个都试，用第一个成功的。
 */
function h2oSubscriptionUrlCandidates(subscription) {
  const url = nullableString(subscription?.url);
  if (!url) return [];
  const candidates = [nullableString(subscription?.resolvedUrl), url].filter(Boolean);
  if (h2oLooksLikeManagedSubscriptionUrl(url)) {
    const pathName = h2oManagedSubscriptionPath(url);
    for (const baseUrl of [
      runtime?.connection?.internalBaseUrl,
      runtime?.config?.internalApiBaseUrl,
      DEFAULT_CONFIG.internalApiBaseUrl
    ]) {
      const normalized = normalizeBaseUrl(baseUrl);
      if (!normalized || !pathName) continue;
      try {
        candidates.push(joinApiUrl(normalized, pathName));
      } catch (_err) {
        // skip an unusable base URL
      }
    }
  }
  return uniqueStrings(candidates);
}

/**
 * Internal control-plane base URLs, most-reachable first.
 *
 * Login hands this module the public bootstrap base URL, but Domestic only
 * reverse-proxies a tiny allowlist -- user-center paths deliberately are not on
 * it, so every such call 404s at nginx. Try the caller's base first (it becomes
 * correct the moment Domestic proxies more), then the Internal address behind WG.
 */
function h2oInternalApiBaseUrls(preferredBaseUrl) {
  return uniqueStrings([
    normalizeBaseUrl(preferredBaseUrl),
    normalizeBaseUrl(runtime?.connection?.internalBaseUrl),
    normalizeBaseUrl(runtime?.config?.internalApiBaseUrl),
    normalizeBaseUrl(DEFAULT_CONFIG.internalApiBaseUrl)
  ].filter(Boolean));
}

/** Same call against each base URL; the first that answers wins. */
async function h2oRequestInternalJson(preferredBaseUrl, pathName, options = {}) {
  const failures = [];
  for (const base of h2oInternalApiBaseUrls(preferredBaseUrl)) {
    try {
      return { payload: await requestJson(joinApiUrl(base, pathName), options), baseUrl: base };
    } catch (err) {
      failures.push(`${base}: ${errorMessage(err)}`);
    }
  }
  throw new Error(failures.join('；') || `没有可用的 Internal API 地址：${pathName}`);
}

function h2oSubscriptionRequestHeaders(subscription, subscriptionInput) {
  const headers = {
    accept: 'text/yaml, application/yaml, text/plain, */*',
    ...appCenterCatalogHeaders(),
    ...normalizeStringRecord(subscription?.headers, {})
  };
  if (subscriptionInput?.username || subscriptionInput?.password) {
    const token = Buffer
      .from(`${subscriptionInput.username || ''}:${subscriptionInput.password || ''}`, 'utf8')
      .toString('base64');
    headers.authorization = `Basic ${token}`;
  }
  return headers;
}

/**
 * 返回 { yaml, url }：url 是**实际取回内容的那个地址**，调用方要把它写回 runtime，
 * 这样 UI 和 mihomo 看到的都是真正可达的地址，而不是一个固定 404 的公网地址。
 */
async function h2oPrefetchSubscriptionContent(subscription, subscriptionInput) {
  const candidates = h2oSubscriptionUrlCandidates({
    ...subscription,
    url: nullableString(subscriptionInput?.url) || subscription?.url
  });
  if (!candidates.length) return null;
  const headers = h2oSubscriptionRequestHeaders(subscription, subscriptionInput);
  const failures = [];
  for (const candidate of candidates) {
    try {
      const yaml = await requestText(candidate, { timeoutMs: 12000, headers });
      if (!nullableString(yaml)) throw new Error('订阅内容为空。');
      pushAppLog('h2o', 'info', `H2O subscription prefetched via launcher network: ${candidate}`);
      return { yaml, url: candidate };
    } catch (err) {
      failures.push(`${candidate}: ${errorMessage(err)}`);
    }
  }
  pushAppLog(
    'h2o',
    'warning',
    `H2O subscription prefetch failed, falling back to mihomo download: ${failures.join('；')}`
  );
  return null;
}

// 虚拟网卡模式会接管整机流量。MX-H2I 自己的控制面（WireGuard endpoint、Domestic
// bootstrap、Internal API、split-DNS 内网域名、订阅下载地址）必须留在隧道之外，
// 否则 H2O 一启动就会把 launcher 的连接掐掉，再也拿不到订阅/续期。
function h2oControlPlaneGuard(h2oRuntime) {
  const config = runtime?.config || {};
  const connection = runtime?.connection || {};
  const routePlan = connection.routePlan || {};
  const directDomains = uniqueStrings([
    ...splitDnsDomains(config),
    hostnameFromUrl(config.bootstrapApiBaseUrl),
    hostnameFromUrl(DEFAULT_CONFIG.bootstrapApiBaseUrl),
    hostnameFromUrl(connection.internalBaseUrl),
    hostnameFromUrl(config.internalApiBaseUrl),
    hostnameFromUrl(routePlan.internalBaseUrl),
    publicHostFromEndpoint(config.domesticRelayHost),
    hostnameFromUrl(h2oRuntime?.activeSubscription?.url),
    ...parseHostResolve(effectiveHostResolve()).keys()
  ].filter((host) => host && net.isIP(host) === 0));
  const directIps = uniqueStrings([
    publicHostFromEndpoint(config.domesticRelayHost),
    publicHostFromEndpoint(DEFAULT_CONFIG.domesticRelayHost),
    publicHostFromEndpoint(connection.domesticRelayEndpoint),
    publicHostFromEndpoint(connection.wireGuard?.endpoint),
    publicHostFromEndpoint(routePlan.endpoint),
    ...expectedInternalDnsTargets(),
    ...[...parseHostResolve(effectiveHostResolve()).values()].map((mapped) => mapped?.host)
  ].filter((host) => host && net.isIP(host) !== 0));
  return { directDomains, directIps, fakeIpFilter: directDomains.map((domain) => `+.${domain}`) };
}

function h2oTunnelRulesForMode(h2oRuntime) {
  const enabled = normalizeH2oRules(h2oRuntime.rules).filter((rule) => rule.enabled !== false);
  const blocklist = enabled.filter((rule) => rule.kind === 'block').map((rule) => rule.host);
  const allowlist = h2oRuntime.mode === 'app-rule'
    ? enabled.filter((rule) => rule.kind === 'allow').map((rule) => rule.host)
    : [];
  return { allowlist, blocklist };
}

function h2oTunnelNodes(manager) {
  if (typeof manager?.listProxyNodes !== 'function') return [];
  try {
    return manager.listProxyNodes();
  } catch (_err) {
    return [];
  }
}

function h2oTunnelSelectedNode(manager) {
  if (typeof manager?.selectedProxyNode !== 'function') return null;
  try {
    return manager.selectedProxyNode();
  } catch (_err) {
    return null;
  }
}

function h2oRuntimeWithTunnelStatus(h2oRuntime, tunnelStatus) {
  const running = tunnelStatus?.running === true;
  const nodes = normalizeH2oNodes(tunnelStatus?.nodes);
  // 把真正可达的订阅地址写回去，下次启动和 UI 都直接用它，不再从 404 的公网地址重试。
  const resolvedUrl = nullableString(tunnelStatus?.resolvedSubscriptionUrl);
  const activeSubscription = resolvedUrl && h2oRuntime.activeSubscription
    ? { ...h2oRuntime.activeSubscription, resolvedUrl }
    : h2oRuntime.activeSubscription;
  return h2oPluginRuntime({
    ...h2oRuntime,
    activeSubscription,
    running,
    status: running ? 'running' : 'ready',
    nodes: nodes.length ? nodes : h2oRuntime.nodes,
    selectedNode: nullableString(tunnelStatus?.selectedNode) || h2oRuntime.selectedNode,
    ports: tunnelStatus?.ports || h2oRuntime.ports,
    adminUrl: tunnelStatus?.adminUrl || h2oRuntime.adminUrl,
    metrics: h2oMetricsFromTunnelTraffic(tunnelStatus?.traffic, h2oRuntime.metrics),
    startedAt: running ? h2oRuntime.startedAt || nowIso() : h2oRuntime.startedAt,
    lastAppliedAt: nowIso()
  });
}

async function restoreH2oRuntimeAfterStartup() {
  if (!runtime?.apps?.h2o?.installed) return;
  if (runtimeHasUserIdentity()) {
    await loadH2oUserRuntimeProfileForCurrentUser({ reason: 'startup-restore' }).catch((err) => {
      pushAppLog('h2o', 'warning', `H2O user runtime profile startup load skipped: ${errorMessage(err)}`);
    });
  }
  const current = h2oPluginRuntime(runtime.apps.h2o.runtime);
  if (!current.running && h2oLooksLikeIdleProxyError(runtime.apps.h2o.errorMessage)) {
    runtime.apps.h2o.runtime = h2oPluginRuntime({
      ...current,
      status: h2oHasUsableSubscription(current.activeSubscription) ? 'ready' : 'subscription-required',
      metrics: {
        ...normalizeH2oMetrics(current.metrics),
        connections: 0
      }
    });
    runtime.apps.h2o.status = 'enabled';
    runtime.apps.h2o.runtimeState = 'ready';
    runtime.apps.h2o.errorMessage = null;
    touchRuntime('h2o idle proxy error cleared');
    await saveAndBroadcast();
    return;
  }
  const shouldRestore = current.running || current.status === 'starting';
  if (!shouldRestore) return;
  runtime.apps.h2o.runtime = h2oPluginRuntime({
    ...current,
    running: false,
    status: 'starting',
    metrics: {
      ...normalizeH2oMetrics(current.metrics),
      connections: 0
    }
  });
  runtime.apps.h2o.status = 'enabled';
  runtime.apps.h2o.runtimeState = 'ready';
  runtime.feedback = {
    tone: 'info',
    message: '正在恢复 H2O mihomo runtime。'
  };
  await saveAndBroadcast();
  await ensureH2oProxyReady({ ...current, running: true }, 'startup-restore');
}

async function h2oTunnelTrafficSummary(manager = h2oTunnelManager) {
  if (!manager || typeof manager.trafficSummary !== 'function') return null;
  try {
    return await manager.trafficSummary();
  } catch {
    return null;
  }
}

/**
 * 问 mihomo「现在实际在用哪个节点」。
 *
 * 不能直接显示用户选的那个：Oversea 是 select 组，选中 Oversea-Auto 时真正出流量的是
 * fallback 组按健康探测顺延到的节点，可能已经不是列表里的第一个了。
 * 所以顺着 group -> now 一路走到底，走到非组为止。
 */
async function h2oActiveProxyNode(manager = h2oTunnelManager) {
  const api = manager?.api;
  if (!api || typeof api.proxies !== 'function') return null;
  try {
    const response = await api.proxies();
    const proxies = response?.ok ? response.data?.proxies : null;
    if (!proxies || typeof proxies !== 'object') return null;
    return resolveEffectiveProxyNode(proxies, H2O_OVERSEA_SELECT_GROUP);
  } catch (_err) {
    return null;
  }
}

function h2oTunnelRecentProblem(manager = h2oTunnelManager) {
  if (!manager || typeof manager.listEvents !== 'function') return '';
  try {
    const events = manager.listEvents();
    const event = events.find((item) => {
      const level = String(item?.level || '').toLowerCase();
      const message = String(item?.message || '');
      return level === 'error'
        || /listen .*error|bind:|permission|denied|failed|panic|fatal|not found|missing/i.test(message);
    }) || events[0];
    return sanitizeH2oRuntimeLogMessage(event?.message);
  } catch {
    return '';
  }
}

function sanitizeH2oRuntimeLogMessage(value) {
  const text = nullableString(value);
  if (!text) return '';
  return text
    .replace(/password:\s*[^,\s}]+/gi, 'password: ******')
    .replace(/secret:\s*[^,\s}]+/gi, 'secret: ******')
    .slice(0, 420);
}

function h2oRuntimeRequiredPorts(h2oRuntime) {
  const current = h2oPluginRuntime(h2oRuntime);
  return [
    {
      id: 'controller',
      label: 'controller',
      protocol: 'tcp',
      host: '127.0.0.1',
      port: normalizePort(current.ports.controller, 23457)
    },
    {
      id: 'mixed',
      label: 'mixed',
      protocol: 'tcp',
      host: '127.0.0.1',
      port: normalizePort(current.ports.mixed, 23458)
    },
    {
      id: 'dns-tcp',
      label: 'dns tcp',
      protocol: 'tcp',
      host: '0.0.0.0',
      port: normalizePort(current.ports.dns, 1053)
    },
    {
      id: 'dns-udp',
      label: 'dns udp',
      protocol: 'udp',
      host: '0.0.0.0',
      port: normalizePort(current.ports.dns, 1053)
    }
  ];
}

async function prepareH2oRuntimePortsForStart(h2oRuntime, reason = 'start') {
  let conflicts = await h2oRequiredPortConflicts(h2oRuntime);
  if (!conflicts.length) return;
  await stopH2oOrphanMihomoProcesses({ reason: `${reason}-port-conflict` });
  await waitForH2oRequiredPortsAvailable(h2oRuntime, H2O_PORT_RELEASE_TIMEOUT_MS);
  conflicts = await h2oRequiredPortConflicts(h2oRuntime);
  if (!conflicts.length) return;
  // The occupant is not our own orphan (those were just cleaned), so it is most
  // likely another standalone launcher product on this machine. Ports are ours
  // to move; the other product's listener is not ours to kill.
  const reallocated = await reallocateConflictedH2oPorts(h2oRuntime, conflicts);
  if (reallocated.length) {
    pushAppLog('h2o', 'warning', `H2O 端口被其他进程占用，已改用新端口：${reallocated.map((item) => `${item.label} ${item.from}->${item.to}`).join('、')}（${reason}）。`);
    conflicts = await h2oRequiredPortConflicts(h2oRuntime);
    if (!conflicts.length) return;
  }
  const detail = await h2oPortOccupancySummary(h2oRuntime);
  throw new Error(`H2O 端口仍被占用，无法启动 mihomo：${h2oPortConflictText(conflicts)}${detail ? `。占用详情：${detail}` : ''}`);
}

async function reallocateConflictedH2oPorts(h2oRuntime, conflicts) {
  let allocate;
  try {
    ({ allocateElectronLauncherLocalPort: allocate } = await importInstalledPackage('@qpjoy/electron-launcher/local-ports'));
  } catch {
    return [];
  }
  const portKeyByConflictId = { controller: 'controller', mixed: 'mixed', 'dns-tcp': 'dns', 'dns-udp': 'dns' };
  const moved = [];
  const movedKeys = new Set();
  for (const conflict of conflicts) {
    const key = portKeyByConflictId[conflict.id];
    if (!key || movedKeys.has(key)) continue;
    try {
      const lease = await allocate({
        productId: 'mx-h2i',
        service: `mihomo-${key}`,
        host: conflict.host === '0.0.0.0' ? '127.0.0.1' : conflict.host
      });
      moved.push({ label: conflict.label, from: h2oRuntime.ports[key], to: lease.port });
      h2oRuntime.ports[key] = lease.port;
      movedKeys.add(key);
    } catch {
      // Leave the original port in place; the caller reports the conflict.
    }
  }
  return moved;
}

async function h2oRuntimePortDiagnosticHint(h2oRuntime) {
  const conflicts = await h2oRequiredPortConflicts(h2oRuntime);
  const detail = await h2oPortOccupancySummary(h2oRuntime);
  const parts = [];
  if (conflicts.length) parts.push(`端口占用：${h2oPortConflictText(conflicts)}`);
  if (detail) parts.push(`占用详情：${detail}`);
  return parts.join('；');
}

async function h2oRequiredPortConflicts(h2oRuntime) {
  const specs = h2oRuntimeRequiredPorts(h2oRuntime);
  const results = [];
  for (const spec of specs) {
    const available = spec.protocol === 'udp'
      ? await h2oUdpPortAvailable(spec.port, spec.host)
      : await h2oTcpPortAvailable(spec.port, spec.host);
    if (!available) results.push(spec);
  }
  return results;
}

async function waitForH2oRequiredPortsAvailable(h2oRuntime, timeoutMs = H2O_PORT_RELEASE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!(await h2oRequiredPortConflicts(h2oRuntime)).length) return true;
    await delay(180);
  } while (Date.now() < deadline);
  return !(await h2oRequiredPortConflicts(h2oRuntime)).length;
}

function h2oPortConflictText(conflicts) {
  return conflicts
    .map((item) => `${item.label} ${item.host}:${item.port}`)
    .join('、');
}

function h2oTcpPortAvailable(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    let timer = null;
    const finish = (available) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.removeAllListeners();
      try {
        server.close(() => resolve(available));
      } catch {
        resolve(available);
      }
    };
    timer = setTimeout(() => finish(false), 600);
    server.once('error', () => finish(false));
    server.once('listening', () => finish(true));
    try {
      server.listen({ host, port, exclusive: true });
    } catch {
      finish(false);
    }
  });
}

function h2oUdpPortAvailable(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    let timer = null;
    const finish = (available) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      try {
        socket.close(() => resolve(available));
      } catch {
        resolve(available);
      }
    };
    timer = setTimeout(() => finish(false), 600);
    socket.once('error', () => finish(false));
    socket.once('listening', () => finish(true));
    try {
      socket.bind(port, host);
    } catch {
      finish(false);
    }
  });
}

async function h2oPortOccupancySummary(h2oRuntime) {
  if (process.platform === 'win32') return '';
  const ports = h2oRuntimeRequiredPorts(h2oRuntime);
  const tcpPorts = [...new Set(ports.filter((item) => item.protocol === 'tcp').map((item) => item.port))];
  const udpPorts = [...new Set(ports.filter((item) => item.protocol === 'udp').map((item) => item.port))];
  const tcpOutput = tcpPorts.length
    ? await execFileText('/usr/sbin/lsof', [
      '-nP',
      '-sTCP:LISTEN',
      ...tcpPorts.map((port) => `-iTCP:${port}`)
    ], { timeoutMs: 1500 }).catch((err) => (
      String(err?.stdout || err?.stderr || '')
    ))
    : '';
  const udpOutput = udpPorts.length
    ? await execFileText('/usr/sbin/lsof', [
      '-nP',
      ...udpPorts.map((port) => `-iUDP:${port}`)
    ], { timeoutMs: 1500 }).catch((err) => (
      String(err?.stdout || err?.stderr || '')
    ))
    : '';
  return compactH2oLsofOutput(`${tcpOutput}\n${udpOutput}`);
}

function compactH2oLsofOutput(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const rows = lines.filter((line) => !/^COMMAND\s+PID\s+/i.test(line));
  if (!rows.length) return '';
  return rows.slice(0, 8).map((line) => {
    const parts = line.split(/\s+/);
    const command = parts[0] || 'process';
    const pid = parts[1] || '?';
    const name = parts.slice(8).join(' ') || parts.at(-1) || '';
    return `${command}[${pid}] ${name}`.trim();
  }).join('; ');
}

function h2oMetricsFromTunnelTraffic(traffic, fallback = {}) {
  const base = normalizeH2oMetrics(fallback);
  if (!traffic || typeof traffic !== 'object' || traffic.available === false) {
    return {
      ...base,
      connections: 0
    };
  }
  return {
    uploadBytes: normalizeNonNegativeInteger(traffic.uploadTotal, base.uploadBytes),
    downloadBytes: normalizeNonNegativeInteger(traffic.downloadTotal, base.downloadBytes),
    connections: normalizeNonNegativeInteger(traffic.connections, 0),
    lastProxyAppliedAt: base.lastProxyAppliedAt
  };
}

async function waitForH2oLocalProxy(port, timeoutMs = H2O_PROXY_START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await h2oLocalProxyReady(port)) return true;
    await delay(180);
  } while (Date.now() < deadline);
  return false;
}

async function waitForH2oStableLocalProxy(port, timeoutMs = H2O_PROXY_START_TIMEOUT_MS, requiredReadyCount = 3) {
  const deadline = Date.now() + timeoutMs;
  let readyCount = 0;
  do {
    if (await h2oLocalProxyReady(port)) {
      readyCount += 1;
      if (readyCount >= requiredReadyCount) return true;
      await delay(220);
      continue;
    }
    readyCount = 0;
    await delay(180);
  } while (Date.now() < deadline);
  return false;
}

async function h2oMihomoProcessIds() {
  if (process.platform === 'win32') return [];
  const binaryPath = path.join(app.getPath('userData'), 'h2o', 'mihomo-tunnel', 'bin', 'mihomo');
  const stdout = await execFileText('/bin/ps', ['-axo', 'pid=,command='], { timeoutMs: 1400 }).catch(() => '');
  return String(stdout || '')
    .split(/\r?\n/)
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) return null;
      const pid = Number(match[1]);
      const command = match[2] || '';
      return Number.isInteger(pid) && command.includes(binaryPath) ? pid : null;
    })
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

async function stopH2oOrphanMihomoProcesses({ preservePid = null, reason = 'orphan-cleanup' } = {}) {
  const preserve = Number(preservePid);
  const pids = (await h2oMihomoProcessIds()).filter((pid) => pid !== preserve);
  if (!pids.length) return [];
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // The process may have already exited between ps and kill.
    }
  }
  await delay(260);
  const remaining = (await h2oMihomoProcessIds()).filter((pid) => pid !== preserve);
  if (remaining.length) {
    pushAppLog('h2o', 'warning', `H2O orphan mihomo cleanup requested for ${reason}; still running pids=${remaining.join(',')}.`);
  } else {
    pushAppLog('h2o', 'info', `H2O orphan mihomo cleanup completed for ${reason}; stopped pids=${pids.join(',')}.`);
  }
  return pids;
}

async function ensureH2oProxyReady(currentRuntime, reason = 'proxy-check') {
  const current = h2oPluginRuntime(currentRuntime);
  const mixedPort = normalizePort(current.ports.mixed, 23458);
  if (!current.running || !h2oHasUsableSubscription(current.activeSubscription)) {
    if (current.running) {
      markH2oRuntimeProxyUnavailable(current, `H2O mixed-port 127.0.0.1:${mixedPort} 未监听。`);
      await applyH2oAppNetworkPriority(runtime.apps.h2o.runtime, reason);
      await saveAndBroadcast();
    }
    return { ready: false, message: `H2O mixed-port 127.0.0.1:${mixedPort} 未监听。` };
  }

  try {
    const manager = getH2oTunnelManager();
    const statusBeforeStart = typeof manager.status === 'function' ? manager.status() : null;
    if (statusBeforeStart?.running === true) {
      if (await waitForH2oStableLocalProxy(mixedPort, 1200, 2)) {
        const nextRuntime = h2oPluginRuntime({
          ...current,
          running: true,
          status: 'running',
          ports: statusBeforeStart.ports || current.ports,
          adminUrl: statusBeforeStart.adminUrl || current.adminUrl,
          startedAt: current.startedAt || nowIso(),
          lastAppliedAt: nowIso()
        });
        runtime.apps.h2o.runtime = nextRuntime;
        runtime.apps.h2o.status = 'running';
        runtime.apps.h2o.runtimeState = 'running';
        runtime.apps.h2o.errorMessage = null;
        runtime.apps.h2o.lastAction = nowIso();
        await refreshH2oRuntimeTrafficSnapshot(reason);
        await applyH2oAppNetworkPriority(nextRuntime, reason);
        await saveAndBroadcast();
        return { ready: true, runtime: h2oPluginRuntime(runtime.apps.h2o.runtime) };
      }
      pushAppLog('h2o', 'warning', `H2O manager reported running but mixed-port 127.0.0.1:${mixedPort} was not stable; restarting for ${reason}.`);
      await stopH2oMihomoRuntime().catch((err) => {
        pushAppLog('h2o', 'warning', `H2O stale mihomo stop failed before restart: ${errorMessage(err)}`);
      });
      await waitForH2oRequiredPortsAvailable(current, H2O_PORT_RELEASE_TIMEOUT_MS);
    }
    const tunnelStatus = await startH2oMihomoRuntime(current);
    const nextRuntime = h2oRuntimeWithTunnelStatus(current, tunnelStatus);
    runtime.apps.h2o.runtime = nextRuntime;
    runtime.apps.h2o.status = nextRuntime.running ? 'running' : 'enabled';
    runtime.apps.h2o.runtimeState = nextRuntime.running ? 'running' : 'ready';
    runtime.apps.h2o.errorMessage = nextRuntime.running ? null : runtime.apps.h2o.errorMessage;
    runtime.apps.h2o.lastAction = nowIso();
    pushAppLog('h2o', 'info', `H2O mihomo runtime recovered for ${reason}.`);
    await applyH2oAppNetworkPriority(nextRuntime, reason);
    await saveAndBroadcast();
    return { ready: nextRuntime.running === true, runtime: nextRuntime };
  } catch (err) {
    const message = `H2O mihomo 恢复失败：${errorMessage(err)}`;
    markH2oRuntimeProxyUnavailable(current, message);
    pushAppLog('h2o', 'error', message);
    await applyH2oAppNetworkPriority(runtime.apps.h2o.runtime, reason);
    await saveAndBroadcast();
    return { ready: false, message };
  }
}

async function refreshH2oRuntimeTrafficSnapshot(reason = 'traffic-refresh') {
  if (!runtime?.apps?.h2o?.runtime) return null;
  const current = h2oPluginRuntime(runtime.apps.h2o.runtime);
  const traffic = await h2oTunnelTrafficSummary();
  const metrics = h2oMetricsFromTunnelTraffic(traffic, current.metrics);
  const activeNode = await h2oActiveProxyNode();
  if (activeNode && current.activeNode && activeNode !== current.activeNode) {
    pushAppLog('h2o', 'info', `H2O oversea traffic moved to ${activeNode} (was ${current.activeNode}).`);
  }
  runtime.apps.h2o.runtime = h2oPluginRuntime({
    ...current,
    metrics,
    activeNode: activeNode || current.activeNode,
    lastAppliedAt: nowIso()
  });
  pushAppLog('h2o', 'info', `H2O traffic snapshot refreshed: ${reason}.`);
  return runtime.apps.h2o.runtime;
}

function markH2oRuntimeProxyUnavailable(currentRuntime, message) {
  const current = h2oPluginRuntime(currentRuntime);
  runtime.apps.h2o.runtime = h2oPluginRuntime({
    ...current,
    running: false,
    status: 'proxy-unavailable',
    metrics: {
      ...normalizeH2oMetrics(current.metrics),
      connections: 0
    },
    lastAppliedAt: nowIso()
  });
  runtime.apps.h2o.status = 'enabled';
  runtime.apps.h2o.runtimeState = 'ready';
  runtime.apps.h2o.errorMessage = message;
  runtime.apps.h2o.lastAction = nowIso();
  runtime.feedback = {
    tone: 'warning',
    message
  };
}

async function openH2oTestWindow(input = {}) {
  if (!runtime.apps.h2o.installed) {
    runtime.feedback = {
      tone: 'warning',
      message: '请先安装 H2O 后再打开测试窗口。'
    };
    return;
  }
  const targetUrl = normalizeH2oTestUrl(input?.url);
  const current = h2oPluginRuntime(runtime.apps.h2o.runtime);
  const win = h2oTestWindow && !h2oTestWindow.isDestroyed()
    ? h2oTestWindow
    : createH2oTestWindow(targetUrl);
  const loadId = ++h2oTestWindowLoadId;
  h2oTestWindow = win;
  stopH2oTestWindowLoad(win);
  win.setTitle(`H2O Test - ${hostnameFromUrl(targetUrl) || 'browser'}`);
  win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
  if (h2oTestWindowShouldPreflightStart(current)) {
    await ensureH2oProxyReady({ ...current, running: true }, 'test-window-preflight');
    if (!isH2oTestLoadCurrent(loadId, win)) return;
  }
  const readyCurrent = h2oPluginRuntime(runtime.apps.h2o.runtime);
  const proxyMode = await configureH2oTestWindowProxy(win, readyCurrent, targetUrl, loadId);
  if (!isH2oTestLoadCurrent(loadId, win) || proxyMode === 'stale') return;
  const now = nowIso();
  const afterProxy = h2oPluginRuntime(runtime.apps.h2o.runtime);
  runtime.apps.h2o.runtime = h2oPluginRuntime({
    ...afterProxy,
    metrics: {
      ...afterProxy.metrics,
      lastProxyAppliedAt: now
    },
    lastAppliedAt: now
  });
  const hostname = hostnameFromUrl(targetUrl) || targetUrl;
  runtime.feedback = {
    tone: proxyMode === 'proxy' ? 'success' : 'info',
    message: `H2O 测试窗口已打开：${hostname}（正在加载，${h2oTestProxyModeLabel(proxyMode)}）。`
  };
  pushAppLog('h2o', 'info', `H2O test window opened ${targetUrl} via ${proxyMode}; loading async.`);
  void loadH2oTestWindowUrl(win, targetUrl, proxyMode, loadId);
}

/**
 * 测试窗口的意义就是走 H2O，所以订阅可用时先把 mihomo 拉起来，而不是静默回退系统代理
 * 再抛一个 ERR_FAILED —— 后者正是「点了测试却上不了外网」的现象。
 *
 * TUN 模式例外：那会改整机路由，必须留给用户显式点「启动」。
 */
function h2oTestWindowShouldPreflightStart(current) {
  return !current.running
    && !h2oModeNeedsTun(current.mode)
    && h2oHasUsableSubscription(current.activeSubscription);
}

function createH2oTestWindow(targetUrl) {
  const win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    title: `H2O Test - ${hostnameFromUrl(targetUrl) || 'browser'}`,
    icon: productIconPath(),
    backgroundColor: '#11131a',
    show: false,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    webPreferences: {
      partition: 'persist:mx-h2i-h2o-test',
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  win.once('closed', () => {
    if (h2oTestWindow === win) h2oTestWindow = null;
  });
  return win;
}

function stopH2oTestWindowLoad(win) {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.stop();
  } catch {
    // The test window may be closing while a new click arrives.
  }
}

function isH2oTestLoadCurrent(loadId, win) {
  return loadId === h2oTestWindowLoadId
    && win
    && !win.isDestroyed();
}

function h2oTestWindowSession(win) {
  if (!win || win.isDestroyed()) return null;
  try {
    const webContents = win.webContents;
    if (!webContents || (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed())) {
      return null;
    }
    return webContents.session || null;
  } catch (_err) {
    return null;
  }
}

function isH2oTestAbortError(err) {
  return /ERR_ABORTED/i.test(errorMessage(err));
}

async function loadH2oTestWindowUrl(win, targetUrl, proxyMode, loadId) {
  if (!isH2oTestLoadCurrent(loadId, win)) return;
  const hostname = hostnameFromUrl(targetUrl) || targetUrl;
  if (proxyMode === 'h2o-proxy-unavailable' || proxyMode === 'blocked') {
    const message = proxyMode === 'blocked'
      ? '目标域名命中 H2O 黑名单，已按规则阻止访问。'
      : 'H2O mixed 端口未监听。请确认 @qpjoy/electron-plugin-tunnel / electron-core-mihomo 和对应平台 engine 已安装，并重新启动 H2O。';
    if (!isH2oTestLoadCurrent(loadId, win)) return;
    const errorPageLoaded = await loadH2oTestErrorPage(win, targetUrl, message).then(() => true).catch((err) => {
      if (!isH2oTestAbortError(err)) {
        pushAppLog('h2o', 'warning', `H2O test error page render skipped: ${errorMessage(err)}`);
      }
      return false;
    });
    if (!errorPageLoaded || !isH2oTestLoadCurrent(loadId, win)) return;
    runtime.feedback = {
      tone: 'warning',
      message: `H2O 测试窗口已打开，但 ${hostname} 未加载：${message}`
    };
    pushAppLog('h2o', 'warning', `H2O test skipped remote load for ${targetUrl}: ${message}`);
    await saveAndBroadcast();
    return;
  }
  try {
    await loadH2oTestWindowUrlWithRetry(win, targetUrl, proxyMode, loadId);
    if (!isH2oTestLoadCurrent(loadId, win)) return;
    if (proxyMode === 'proxy') {
      await refreshH2oRuntimeTrafficSnapshot('test-window-loaded');
    }
    runtime.feedback = {
      tone: proxyMode === 'proxy' ? 'success' : 'info',
      message: `H2O 测试窗口已加载：${hostname}（${h2oTestProxyModeLabel(proxyMode)}）。`
    };
    pushAppLog('h2o', 'info', `H2O test window loaded ${targetUrl} via ${proxyMode}.`);
  } catch (err) {
    if (!isH2oTestLoadCurrent(loadId, win) || isH2oTestAbortError(err)) {
      pushAppLog('h2o', 'info', `H2O test load superseded for ${targetUrl}: ${errorMessage(err)}`);
      return;
    }
    const diagnostics = await h2oTestWindowFailureDiagnostics(win, targetUrl, proxyMode);
    const message = diagnostics
      ? `${errorMessage(err)}\n${diagnostics}`
      : errorMessage(err);
    if (isH2oTestLoadCurrent(loadId, win)) {
      await loadH2oTestErrorPage(win, targetUrl, message).catch((pageErr) => {
        if (!isH2oTestAbortError(pageErr)) {
          pushAppLog('h2o', 'warning', `H2O test error page render skipped: ${errorMessage(pageErr)}`);
        }
      });
    }
    if (!isH2oTestLoadCurrent(loadId, win)) return;
    runtime.feedback = {
      tone: 'warning',
      message: `H2O 测试窗口已打开，但 ${hostname} 加载失败：${errorMessage(err)}（${h2oTestProxyModeLabel(proxyMode)}）`
    };
    pushAppLog('h2o', 'warning', `H2O test opened with load failure for ${targetUrl}: ${message}`);
  }
  await saveAndBroadcast();
}

async function loadH2oTestWindowUrlWithRetry(win, targetUrl, proxyMode, loadId) {
  try {
    await win.loadURL(targetUrl);
    return;
  } catch (err) {
    if (!isH2oTestLoadCurrent(loadId, win) || isH2oTestAbortError(err)) throw err;
    if (!await shouldRetryH2oTestLoad(win, proxyMode, err)) throw err;
    const beforeSession = h2oTestWindowSession(win);
    const before = beforeSession ? await h2oResolveProxyDecision(beforeSession, targetUrl) : '';
    pushAppLog('h2o', 'warning', `H2O test load failed once, recovering mihomo and retrying: ${errorMessage(err)}; before=${before || 'unknown'}`);
    const recovered = await recoverH2oProxyForTestLoad(win, targetUrl, loadId);
    if (!recovered) throw err;
    await delay(260);
    if (!isH2oTestLoadCurrent(loadId, win)) throw err;
    const afterSession = h2oTestWindowSession(win);
    const after = afterSession ? await h2oResolveProxyDecision(afterSession, targetUrl) : '';
    pushAppLog('h2o', 'info', `H2O test retry proxy decision: ${after || 'unknown'}.`);
    await win.loadURL(targetUrl);
  }
}

async function shouldRetryH2oTestLoad(win, proxyMode, err) {
  if (!win || win.isDestroyed() || proxyMode !== 'proxy') return false;
  return /ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_CONNECTION_TIMED_OUT|ERR_NAME_NOT_RESOLVED/i.test(errorMessage(err));
}

async function recoverH2oProxyForTestLoad(win, targetUrl, loadId) {
  if (!isH2oTestLoadCurrent(loadId, win)) return false;
  const current = h2oPluginRuntime(runtime.apps.h2o.runtime);
  const ensured = await ensureH2oProxyReady({ ...current, running: true }, 'test-window-load-retry');
  if (!ensured.ready || !isH2oTestLoadCurrent(loadId, win)) return false;
  const readyRuntime = h2oPluginRuntime(runtime.apps.h2o.runtime);
  const readyPort = normalizePort(readyRuntime?.ports?.mixed, current?.ports?.mixed || 23458);
  const session = h2oTestWindowSession(win);
  if (!session) return false;
  await applyH2oTestSessionProxy(session, readyPort, targetUrl);
  return isH2oTestLoadCurrent(loadId, win);
}

async function h2oTestWindowFailureDiagnostics(win, targetUrl, proxyMode) {
  const session = h2oTestWindowSession(win);
  if (!session) return '';
  const parts = [];
  // 回退系统代理时失败的原因几乎总是「H2O 根本没在代理这次请求」，
  // 直接说清楚下一步，别让用户对着裸 ERR_FAILED 猜。
  const hint = h2oTestFallbackHint(proxyMode);
  if (hint) parts.push(hint);
  const decision = await h2oResolveProxyDecision(session, targetUrl);
  if (decision) parts.push(`resolveProxy=${decision}`);
  if (proxyMode === 'proxy') {
    const current = h2oPluginRuntime(runtime.apps.h2o.runtime);
    const mixedPort = normalizePort(current?.ports?.mixed, 23458);
    const ready = await h2oLocalProxyReady(mixedPort);
    parts.push(`mixed 127.0.0.1:${mixedPort}=${ready ? 'listening' : 'not listening'}`);
  }
  return parts.length ? `诊断：${parts.join('；')}` : '';
}

function h2oTestFallbackHint(proxyMode) {
  if (proxyMode === 'direct-not-running') {
    return '本次请求没有走 H2O：H2O 未运行，已回退系统代理。请先在 H2O 管理页点击「启动」再测试';
  }
  if (proxyMode === 'direct-no-subscription') {
    return '本次请求没有走 H2O：订阅未就绪，已回退系统代理。请先刷新/分配系统默认订阅';
  }
  if (proxyMode === 'direct-not-whitelisted') {
    return '本次请求没有走 H2O：App 规则模式下该域名不在白名单，走的是直连';
  }
  return '';
}

async function loadH2oTestErrorPage(win, targetUrl, message) {
  if (!win || win.isDestroyed()) return;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(h2oTestErrorHtml(targetUrl, message))}`);
}

function h2oTestErrorHtml(targetUrl, message) {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<title>H2O Test Error</title>',
    '<style>',
    'body{margin:0;background:#10131b;color:#eef2f7;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}',
    '.wrap{max-width:780px;margin:70px auto;padding:28px;border:1px solid rgba(72,244,212,.28);border-radius:10px;background:#171a24;}',
    'h1{margin:0 0 12px;font-size:24px;}p{color:#9aa0aa;line-height:1.65;}code{display:block;white-space:pre-wrap;margin-top:18px;padding:14px;border-radius:8px;background:#0d1017;color:#ffd46b;}',
    '</style></head><body><main class="wrap">',
    '<h1>H2O 测试页面加载失败</h1>',
    `<p>目标地址：${h2oTestEscapeHtml(targetUrl)}</p>`,
    `<code>${h2oTestEscapeHtml(message)}</code>`,
    '</main></body></html>'
  ].join('');
}

function h2oTestEscapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function configureH2oTestWindowProxy(win, h2oRuntime, targetUrl, loadId) {
  if (!win || win.isDestroyed()) return 'direct';
  if (loadId !== undefined && !isH2oTestLoadCurrent(loadId, win)) return 'stale';
  const mode = h2oTestProxyMode(h2oRuntime, targetUrl);
  const ses = h2oTestWindowSession(win);
  if (!ses) return 'stale';
  if (mode !== 'proxy') {
    if (loadId !== undefined && !isH2oTestLoadCurrent(loadId, win)) return 'stale';
    await configureH2oTestWindowFallbackProxy(ses, mode, targetUrl);
    return mode;
  }
  const ensured = await ensureH2oProxyReady({ ...h2oRuntime, running: true }, 'test-window');
  if (loadId !== undefined && !isH2oTestLoadCurrent(loadId, win)) return 'stale';
  if (!ensured.ready) {
    await applyH2oDirectSessionProxy(ses, targetUrl);
    return 'h2o-proxy-unavailable';
  }
  const readyRuntime = h2oPluginRuntime(runtime.apps.h2o.runtime);
  const readyPort = normalizePort(readyRuntime?.ports?.mixed, h2oRuntime?.ports?.mixed || 23458);
  await applyH2oTestSessionProxy(ses, readyPort, targetUrl);
  return 'proxy';
}

async function configureH2oTestWindowFallbackProxy(session, mode, targetUrl) {
  if (h2oShouldUseSystemProxyFallback(mode)) {
    await session.setProxy({ mode: 'system' });
    await refreshH2oSessionProxyState(session, targetUrl);
    return;
  }
  await applyH2oDirectSessionProxy(session, targetUrl);
}

async function applyH2oTestSessionProxy(session, mixedPort, targetUrl) {
  await session.setProxy(h2oFixedProxyConfig(mixedPort));
  await refreshH2oSessionProxyState(session, targetUrl);
  const decision = await h2oResolveProxyDecision(session, targetUrl);
  pushAppLog('h2o', 'info', `H2O test session proxy resolved ${targetUrl}: ${decision || 'unknown'}.`);
}

function h2oFixedProxyConfig(mixedPort) {
  const proxyRules = [
    `http=127.0.0.1:${mixedPort}`,
    `https=127.0.0.1:${mixedPort}`,
    `socks5=127.0.0.1:${mixedPort}`
  ].join(';');
  return {
    mode: 'fixed_servers',
    proxyRules,
    proxyBypassRules: '<local>;localhost;127.0.0.1;::1'
  };
}

async function applyH2oDirectSessionProxy(session, targetUrl) {
  await session.setProxy({ mode: 'direct' });
  await refreshH2oSessionProxyState(session, targetUrl);
}

async function applyH2oAppNetworkPriority(h2oRuntime, reason = 'h2o-network-priority') {
  const ses = electronSession?.defaultSession;
  if (!ses) return;
  const current = h2oPluginRuntime(h2oRuntime || runtime?.apps?.h2o?.runtime);
  const mixedPort = normalizePort(current?.ports?.mixed, 23458);
  const shouldUseH2o = current.running === true
    && current.mode === 'app-global'
    && h2oHasUsableSubscription(current.activeSubscription)
    && await h2oLocalProxyReady(mixedPort);
  if (shouldUseH2o) {
    await ses.setProxy(h2oFixedProxyConfig(mixedPort));
    await refreshH2oSessionProxyState(ses, 'https://www.google.com/');
    const decision = await h2oResolveProxyDecision(ses, 'https://www.google.com/');
    pushAppLog('h2o', 'info', `H2O default session now prefers H2O mixed proxy for ${reason}: ${decision || 'unknown'}.`);
    return;
  }
  await ses.setProxy({ mode: 'system' });
  await refreshH2oSessionProxyState(ses, 'https://www.google.com/');
  pushAppLog('h2o', 'info', `H2O default session fell back to system proxy for ${reason}.`);
}

async function refreshH2oSessionProxyState(session, targetUrl) {
  try {
    if (typeof session.forceReloadProxyConfig === 'function') {
      await session.forceReloadProxyConfig();
    }
  } catch (err) {
    pushAppLog('h2o', 'warning', `H2O proxy config reload skipped: ${errorMessage(err)}`);
  }
  try {
    if (typeof session.closeAllConnections === 'function') {
      await session.closeAllConnections();
    }
  } catch (err) {
    pushAppLog('h2o', 'warning', `H2O proxy connection pool reset skipped: ${errorMessage(err)}`);
  }
  const hostname = hostnameFromUrl(targetUrl);
  try {
    if (hostname && typeof session.clearHostResolverCache === 'function') {
      await session.clearHostResolverCache();
    }
  } catch (err) {
    pushAppLog('h2o', 'warning', `H2O host resolver cache reset skipped: ${errorMessage(err)}`);
  }
}

async function h2oResolveProxyDecision(session, targetUrl) {
  if (!session || typeof session.resolveProxy !== 'function') return '';
  try {
    return await session.resolveProxy(targetUrl);
  } catch (err) {
    return `resolveProxy failed: ${errorMessage(err)}`;
  }
}

function h2oShouldUseSystemProxyFallback(mode) {
  return mode === 'direct-not-running'
    || mode === 'direct-no-subscription';
}

function h2oLocalProxyReady(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (ready) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function h2oTestProxyMode(h2oRuntime, targetUrl) {
  if (!h2oRuntime?.running) return 'direct-not-running';
  if (!h2oHasUsableSubscription(h2oRuntime.activeSubscription)) return 'direct-no-subscription';
  if (h2oModeNeedsTun(h2oRuntime.mode)) return 'system-tun';
  const hostname = hostnameFromUrl(targetUrl);
  if (!hostname) return 'direct';
  if (h2oRuleMatchesHost(h2oRuntime.rules, hostname, 'block')) return 'blocked';
  if (h2oRuntime.mode === 'app-rule' && !h2oRuleMatchesHost(h2oRuntime.rules, hostname, 'allow')) {
    return 'direct-not-whitelisted';
  }
  return 'proxy';
}

function h2oRuleMatchesHost(rules, hostname, kind) {
  const host = String(hostname || '').toLowerCase();
  return normalizeH2oRules(rules).some((rule) => (
    rule.enabled !== false
    && rule.kind === kind
    && h2oRuleHostMatches(rule.host, host)
  ));
}

function h2oRuleHostMatches(ruleHost, hostname) {
  const normalizedRule = String(ruleHost || '').trim().toLowerCase().replace(/^\*\./, '');
  const normalizedHost = String(hostname || '').trim().toLowerCase();
  if (!normalizedRule || !normalizedHost) return false;
  return normalizedHost === normalizedRule || normalizedHost.endsWith(`.${normalizedRule}`);
}

function h2oTestProxyModeLabel(mode) {
  if (mode === 'proxy') return 'H2O mixed proxy';
  if (mode === 'h2o-proxy-unavailable') return 'H2O mixed 未监听';
  if (mode === 'system-tun') return '系统 TUN';
  if (mode === 'direct-not-whitelisted') return 'App 白名单未命中，cn-direct';
  if (mode === 'blocked') return '命中黑名单，已阻止';
  if (mode === 'direct-not-running') return 'H2O 未运行，回退系统代理';
  if (mode === 'direct-no-subscription') return '订阅未就绪，回退系统代理';
  return '直连';
}

function normalizeH2oTestUrl(value) {
  const text = nullableString(value) || 'https://www.google.com';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    return 'https://www.google.com';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'https://www.google.com';
  return parsed.toString();
}

async function provisionH2oOverseaForCurrentUser(input = {}) {
  const baseUrl = normalizeBaseUrl(input?.baseUrl)
    || normalizeBaseUrl(runtime.connection?.internalBaseUrl)
    || await resolveBootstrapBaseUrl(runtime.config);
  const userId = await h2oCurrentUserId({
    baseUrl,
    bootstrapResolveMode: input.bootstrapResolveMode
  });
  if (!userId) throw new Error('Internal OAuth token 没有返回 userId，无法分配 oversea 订阅。');
  // Read the current grant first so re-provisioning keeps whatever the admin set
  // in User Center instead of resetting the user to a client-side default.
  const existingEntitlement = await h2oRequestInternalJson(
    baseUrl,
    `/internal/v1/user-center/users/${encodeURIComponent(userId)}/oversea`,
    { timeoutMs: 5000, bootstrapResolveMode: input.bootstrapResolveMode, headers: appCenterCatalogHeaders() }
  ).then((result) => result.payload?.entitlement || null).catch(() => null);
  const siteAttempts = await h2oOverseaProvisionSiteAttempts(input, {
    baseUrl,
    bootstrapResolveMode: input.bootstrapResolveMode,
    entitlementSiteIds: arrayValue(existingEntitlement?.siteIds, [])
  });
  const requestedBy = 'mx-h2i-h2o';
  const requestId = makeRequestId('h2o-oversea');
  let entitlementPayload = null;
  let entitlement = null;
  let assignedSiteIds = [];
  let syncStatus = 'skipped';
  let lastProvisionError = null;
  for (const siteIds of siteAttempts) {
    try {
      entitlementPayload = await requestJson(
        joinApiUrl(baseUrl, `/internal/v1/user-center/users/${encodeURIComponent(userId)}/oversea/ensure-subscription`),
        {
          method: 'POST',
          timeoutMs: 22000,
          bootstrapResolveMode: input.bootstrapResolveMode,
          headers: appCenterCatalogHeaders(),
          body: {
            ...(siteIds.length ? { siteIds } : {}),
            syncRuntime: true,
            confirmRemoteExecution: true,
            requestedBy,
            requestId: siteIds.length ? requestId : `${requestId}-default`
          }
        }
      );
      entitlement = entitlementPayload?.entitlement && typeof entitlementPayload.entitlement === 'object'
        ? entitlementPayload.entitlement
        : null;
      assignedSiteIds = arrayValue(entitlement?.siteIds, siteIds)
        .map((item) => String(item || '').trim())
        .filter(Boolean);
      if (!entitlement || entitlement.status !== 'active' || !assignedSiteIds.length) {
        throw new Error('Internal 没有返回可用的 active oversea entitlement。');
      }
      syncStatus = nullableString(entitlementPayload?.sync?.status)
        || nullableString(entitlementPayload?.ensure?.status)
        || 'unknown';
      if (syncStatus !== 'passed' && syncStatus !== 'ready') {
        pushAppLog('h2o', 'warning', `H2O user oversea ensure result is ${syncStatus}.`);
      }
      break;
    } catch (err) {
      lastProvisionError = err;
      const target = siteIds.length ? siteIds.join(',') : 'server-default';
      pushAppLog('h2o', 'warning', `H2O oversea ensure attempt failed for ${target}: ${errorMessage(err)}`);
    }
  }
  if (!entitlement || !assignedSiteIds.length) {
    throw lastProvisionError || new Error('Internal 没有可分配的 oversea 站点。');
  }
  if (input.skipHydrate !== true) {
    await hydrateH2oSystemSubscriptionsForUser({
      userId,
      baseUrl,
      bootstrapResolveMode: input.bootstrapResolveMode,
      autoProvision: false
    });
  }
  return { siteIds: assignedSiteIds, syncStatus };
}

async function h2oOverseaProvisionSiteAttempts(input = {}, options = {}) {
  const explicit = uniqueStrings([
    ...arrayValue(input?.siteIds, []),
    nullableString(input?.siteId)
  ].map((item) => String(item || '').trim()).filter(Boolean));
  if (explicit.length) return [explicit];

  // What the admin already granted this user outranks any client-side guess:
  // re-provisioning used to hard-code oversea-main first, so it silently reverted
  // an explicit Oversea access change back to a site the admin had moved off.
  const entitledSiteIds = uniqueStrings(arrayValue(options.entitlementSiteIds, [])
    .map((item) => String(item || '').trim())
    .filter(Boolean));

  const discoveredSiteIds = await discoverH2oOverseaSiteIds(options);
  // 第一档是「admin 授权的全集」而不是逐个站点：订阅本来就是多节点聚合，
  // 只发第一个站点会把多站点授权在服务端裁成单站点，用户的节点列表随之变短。
  // 之后才逐档降级；空数组 = 不带 siteIds，由 Internal 保留已有分配或取平台默认。
  const candidates = [
    entitledSiteIds,
    ...entitledSiteIds.map((siteId) => [siteId]),
    ...discoveredSiteIds.map((siteId) => [siteId]),
    [],
    ['oversea-main']
  ];
  const seen = new Set();
  return candidates.filter((siteIds) => {
    const key = siteIds.length ? siteIds.join(',') : '<server-default>';
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function discoverH2oOverseaSiteIds(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl)
    || normalizeBaseUrl(runtime.connection?.internalBaseUrl)
    || normalizeBaseUrl(runtime.config?.internalApiBaseUrl)
    || normalizeBaseUrl(runtime.config?.bootstrapApiBaseUrl);
  if (!baseUrl) return [];
  try {
    const payload = await requestJson(joinApiUrl(baseUrl, '/internal/v1/site-slots/plans'), {
      timeoutMs: 3500,
      bootstrapResolveMode: options.bootstrapResolveMode,
      headers: appCenterCatalogHeaders()
    });
    const plans = Array.isArray(payload?.plans) ? payload.plans : [];
    const seen = new Set();
    return plans
      .filter((plan) => plan?.kind === 'oversea' && plan?.status !== 'blocked')
      .map((plan) => String(plan?.siteId || '').trim())
      .filter((siteId) => {
        if (!siteId || seen.has(siteId)) return false;
        seen.add(siteId);
        return true;
      });
  } catch (err) {
    pushAppLog('h2o', 'warning', `H2O oversea site discovery failed, falling back to default site: ${errorMessage(err)}`);
    return [];
  }
}

async function syncH2oOverseaRuntimeForUser(input = {}) {
  const userId = nullableString(input.userId);
  if (!userId) throw new Error('缺少 userId，无法同步 oversea runtime。');
  const baseUrl = normalizeBaseUrl(input.baseUrl)
    || normalizeBaseUrl(runtime.connection?.internalBaseUrl)
    || await resolveBootstrapBaseUrl(runtime.config);
  return requestJson(
    joinApiUrl(baseUrl, `/internal/v1/user-center/users/${encodeURIComponent(userId)}/oversea/sync-runtime`),
    {
      method: 'POST',
      timeoutMs: 15000,
      bootstrapResolveMode: input.bootstrapResolveMode,
      headers: appCenterCatalogHeaders(),
      body: {
        siteIds: arrayValue(input.siteIds, []),
        confirmRemoteExecution: true,
        requestedBy: nullableString(input.requestedBy) || 'mx-h2i-h2o',
        requestId: nullableString(input.requestId) || makeRequestId('h2o-oversea-sync')
      }
    }
  );
}

async function refreshH2oExternalSubscription(subscriptionId) {
  const current = h2oPluginRuntime(runtime.apps.h2o.runtime);
  const target = current.subscriptions.find((item) => item.id === subscriptionId) || current.activeSubscription;
  if (!target) return;
  const now = nowIso();
  let nextSubscription;
  try {
    if (!/^https?:\/\//i.test(target.url)) {
      throw new Error('自定义订阅需要使用 http 或 https 地址。');
    }
    const request = h2oExternalSubscriptionRequest(target);
    const yaml = await requestText(request.url, {
      timeoutMs: 8000,
      headers: request.headers
    });
    nextSubscription = {
      ...target,
      url: request.url,
      auth: request.auth,
      nodes: countMihomoSubscriptionNodes(yaml),
      status: 'ready',
      syncStatus: 'fetched',
      errorMessage: null,
      yamlBytes: Buffer.byteLength(yaml, 'utf8'),
      lastUpdatedAt: now
    };
    pushAppLog('h2o', 'info', `H2O external subscription refreshed: ${target.name}.`);
  } catch (err) {
    nextSubscription = {
      ...target,
      status: 'error',
      syncStatus: 'fetch-failed',
      errorMessage: `刷新自定义订阅失败：${errorMessage(err)}`,
      lastUpdatedAt: now
    };
    pushAppLog('h2o', 'error', nextSubscription.errorMessage);
  }
  const subscriptions = current.subscriptions.map((item) => item.id === nextSubscription.id ? nextSubscription : item);
  if (!subscriptions.some((item) => item.id === nextSubscription.id)) subscriptions.unshift(nextSubscription);
  const activeSubscription = current.activeSubscription.id === nextSubscription.id
    ? nextSubscription
    : current.activeSubscription;
  runtime.apps.h2o.runtime = h2oPluginRuntime({
    ...current,
    subscriptions,
    activeSubscription,
    activeSubscriptionId: activeSubscription.id,
    status: current.running ? 'running' : h2oHasUsableSubscription(activeSubscription) ? 'ready' : 'subscription-required',
    lastAppliedAt: now
  });
}

function h2oExternalSubscriptionRequest(subscription) {
  let parsed;
  try {
    parsed = new URL(subscription?.url || '');
  } catch {
    throw new Error('自定义订阅地址无效。');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('自定义订阅需要使用 http 或 https 地址。');
  }
  const embeddedUsername = safeDecodeUrlPart(parsed.username);
  const embeddedPassword = safeDecodeUrlPart(parsed.password);
  parsed.username = '';
  parsed.password = '';
  const headers = {
    accept: 'text/yaml, text/plain, */*',
    ...normalizeStringRecord(subscription?.headers, {})
  };
  const auth = normalizeH2oSubscriptionAuth(subscription?.auth);
  const needsBasic = auth.type === 'basic' || embeddedUsername || embeddedPassword;
  const nextAuth = needsBasic
    ? {
      type: 'basic',
      username: nullableString(auth.username) || embeddedUsername,
      password: nullableString(auth.password) || embeddedPassword
    }
    : { type: 'none', username: null, password: null };
  if (needsBasic) {
    if (!nextAuth.username || !nextAuth.password) {
      throw new Error('Basic Auth 订阅需要用户名和密码。');
    }
    headers.authorization = `Basic ${Buffer.from(`${nextAuth.username}:${nextAuth.password}`, 'utf8').toString('base64')}`;
  }
  return {
    url: parsed.toString(),
    headers,
    auth: nextAuth
  };
}

function safeDecodeUrlPart(value) {
  const text = String(value || '');
  if (!text) return '';
  try {
    return decodeURIComponent(text);
  } catch (_err) {
    return text;
  }
}

async function loadH2oUserRuntimeProfileForCurrentUser(options = {}) {
  if (!runtime?.apps?.h2o?.runtime || !runtimeHasUserIdentity()) {
    return { ok: true, skipped: true, reason: 'no-user-runtime' };
  }
  const baseUrl = normalizeBaseUrl(options.baseUrl)
    || normalizeBaseUrl(runtime.connection?.internalBaseUrl)
    || normalizeBaseUrl(runtime.config?.internalApiBaseUrl)
    || await resolveBootstrapBaseUrl(runtime.config);
  const userId = nullableString(options.userId)
    || await h2oCurrentUserId({
      baseUrl,
      bootstrapResolveMode: options.bootstrapResolveMode
    });
  if (!userId) return { ok: false, message: 'missing userId' };
  const payload = await requestJson(
    joinApiUrl(baseUrl, `/internal/v1/user-center/users/${encodeURIComponent(userId)}/h2o/runtime-profile`),
    {
      timeoutMs: 5000,
      bootstrapResolveMode: options.bootstrapResolveMode,
      headers: appCenterCatalogHeaders()
    }
  );
  const profile = payload?.profile && typeof payload.profile === 'object' ? payload.profile : null;
  if (!profile) return { ok: true, skipped: true, reason: 'no-profile' };
  const applied = applyH2oUserRuntimeProfile(profile);
  if (applied) {
    pushAppLog('h2o', 'info', `H2O user runtime profile loaded from Internal for ${userId}.`);
  }
  return { ok: true, profile, applied };
}

async function saveH2oUserRuntimeProfileForCurrentUser(currentRuntime, options = {}) {
  if (!runtimeHasUserIdentity()) return { ok: true, skipped: true, reason: 'no-user' };
  const baseUrl = normalizeBaseUrl(options.baseUrl)
    || normalizeBaseUrl(runtime.connection?.internalBaseUrl)
    || normalizeBaseUrl(runtime.config?.internalApiBaseUrl)
    || await resolveBootstrapBaseUrl(runtime.config);
  const userId = nullableString(options.userId)
    || await h2oCurrentUserId({
      baseUrl,
      bootstrapResolveMode: options.bootstrapResolveMode
    });
  if (!userId) return { ok: false, message: 'missing userId' };
  const payload = h2oUserRuntimeProfilePayload(currentRuntime);
  try {
    const response = await requestJson(
      joinApiUrl(baseUrl, `/internal/v1/user-center/users/${encodeURIComponent(userId)}/h2o/runtime-profile`),
      {
        method: 'POST',
        timeoutMs: 5000,
        bootstrapResolveMode: options.bootstrapResolveMode,
        headers: appCenterCatalogHeaders(),
        body: {
          ...payload,
          userId,
          appId: 'h2o',
          requestedBy: 'mx-h2i-h2o',
          requestId: makeRequestId('h2o-runtime-profile')
        }
      }
    );
    pushAppLog('h2o', 'info', `H2O user runtime profile synced to Internal for ${userId}; local subscriptions=${payload.subscriptions.length}.`);
    return { ok: true, profile: response?.profile };
  } catch (err) {
    const message = errorMessage(err);
    pushAppLog('h2o', 'warning', `H2O user runtime profile sync failed: ${message}`);
    return { ok: false, message };
  }
}

function h2oUserRuntimeProfilePayload(currentRuntime) {
  const current = h2oPluginRuntime(currentRuntime);
  const subscriptions = h2oPreservedLocalSubscriptions(current)
    .filter((item) => h2oLooksLikeHttpSubscriptionUrl(item.url))
    .map((item) => ({
      ...item,
      source: nullableString(item.source) || 'custom',
      requiresUser: false
    }));
  const activeLocal = h2oPreservedLocalSubscription(current.activeSubscription);
  const activeSubscription = activeLocal && subscriptions.some((item) => item.id === activeLocal.id)
    ? activeLocal
    : subscriptions.find((item) => item.id === current.activeSubscriptionId) || null;
  return {
    mode: current.mode,
    activeSubscriptionId: activeSubscription?.id || null,
    activeSubscription,
    subscriptions,
    ports: current.ports,
    rules: current.rules
  };
}

function applyH2oUserRuntimeProfile(profile) {
  const current = h2oPluginRuntime(runtime.apps.h2o.runtime);
  const profileSubscriptions = h2oUserRuntimeProfileSubscriptions(profile);
  const subscriptions = profileSubscriptions.length
    ? mergeH2oRuntimeSubscriptions(profileSubscriptions, current.subscriptions)
    : current.subscriptions.filter((item) => !h2oPreservedLocalSubscription(item));
  const activeSubscription = h2oUserRuntimeProfileActiveSubscription(profile, subscriptions)
    || (subscriptions.some((item) => item.id === current.activeSubscriptionId) ? current.activeSubscription : null)
    || subscriptions.find((item) => item.id === 'h2o-default')
    || subscriptions[0]
    || current.activeSubscription;
  runtime.apps.h2o.runtime = h2oPluginRuntime({
    ...current,
    mode: nullableString(profile?.mode) || current.mode,
    ports: {
      ...current.ports,
      ...(profile?.ports && typeof profile.ports === 'object' ? profile.ports : {})
    },
    rules: Array.isArray(profile?.rules) && profile.rules.length ? profile.rules : current.rules,
    subscriptions,
    activeSubscription,
    activeSubscriptionId: activeSubscription.id,
    status: current.running ? 'running' : h2oHasUsableSubscription(activeSubscription) ? 'ready' : current.status,
    lastAppliedAt: nowIso()
  });
  return profileSubscriptions.length > 0 || Array.isArray(profile?.subscriptions);
}

function h2oUserRuntimeProfileSubscriptions(profile) {
  const byId = new Map();
  const rows = [
    ...(profile?.activeSubscription ? [profile.activeSubscription] : []),
    ...arrayValue(profile?.subscriptions, [])
  ];
  for (const row of rows) {
    const subscription = h2oPreservedLocalSubscription(row);
    if (subscription && h2oLooksLikeHttpSubscriptionUrl(subscription.url)) {
      byId.set(subscription.id, {
        ...subscription,
        source: nullableString(subscription.source) || 'custom',
        requiresUser: false
      });
    }
  }
  return [...byId.values()];
}

function h2oUserRuntimeProfileActiveSubscription(profile, subscriptions) {
  const activeId = nullableString(profile?.activeSubscriptionId)
    || nullableString(profile?.activeSubscription?.id);
  if (activeId) {
    const byId = subscriptions.find((item) => item.id === activeId);
    if (byId) return byId;
  }
  const activeUrl = h2oComparableSubscriptionUrl(profile?.activeSubscription?.url);
  if (activeUrl) {
    return subscriptions.find((item) => h2oComparableSubscriptionUrl(item.url) === activeUrl) || null;
  }
  return null;
}

async function hydrateH2oSystemSubscriptionsForUser(options = {}) {
  if (!runtime?.apps?.h2o?.runtime || !runtimeHasUserIdentity()) return;
  let current = h2oPluginRuntime(runtime.apps.h2o.runtime);
  let baseUrl = normalizeBaseUrl(options.baseUrl)
    || normalizeBaseUrl(runtime.connection?.internalBaseUrl)
    || await resolveBootstrapBaseUrl(runtime.config);
  const userId = nullableString(options.userId)
    || await h2oCurrentUserId({
      baseUrl,
      bootstrapResolveMode: options.bootstrapResolveMode
    });
  if (!userId) {
    applyH2oManagedSubscriptionState(current, {
      status: 'error',
      syncStatus: 'missing-user',
      errorMessage: 'Internal OAuth token 没有返回 userId，无法获取 oversea 订阅。'
    });
    return;
  }
  if (options.loadRuntimeProfile !== false) {
    await loadH2oUserRuntimeProfileForCurrentUser({
      userId,
      baseUrl,
      bootstrapResolveMode: options.bootstrapResolveMode,
      reason: 'hydrate-h2o-system-subscriptions'
    }).catch((err) => {
      pushAppLog('h2o', 'warning', `H2O user runtime profile hydrate load skipped: ${errorMessage(err)}`);
    });
    current = h2oPluginRuntime(runtime.apps.h2o.runtime);
  }
  if (options.showInitializing === true) {
    applyH2oManagedSubscriptionState(current, {
      status: 'pending',
      syncStatus: 'initializing',
      errorMessage: '正在为当前用户初始化系统 oversea 订阅。'
    });
    runtime.feedback = {
      tone: 'info',
      message: '正在为当前用户初始化 H2O oversea 订阅，请稍等。'
    };
    touchRuntime('h2o subscription initializing');
    await saveAndBroadcast();
  }
  try {
    const entitlementResult = await h2oRequestInternalJson(
      baseUrl,
      `/internal/v1/user-center/users/${encodeURIComponent(userId)}/oversea`,
      {
        timeoutMs: 5000,
        bootstrapResolveMode: options.bootstrapResolveMode,
        headers: appCenterCatalogHeaders()
      }
    );
    const entitlementPayload = entitlementResult.payload;
    // Every later call in this function reuses the base URL that actually
    // answered, so one probe fixes the whole hydrate rather than each call site.
    baseUrl = entitlementResult.baseUrl;
    let entitlement = entitlementPayload?.entitlement && typeof entitlementPayload.entitlement === 'object'
      ? entitlementPayload.entitlement
      : null;
    if (!entitlement || entitlement.status !== 'active') {
      if (options.autoProvision !== false) {
        try {
          await provisionH2oOverseaForCurrentUser({
            baseUrl,
            bootstrapResolveMode: options.bootstrapResolveMode,
            skipHydrate: true
          });
          return await hydrateH2oSystemSubscriptionsForUser({
            ...options,
            userId,
            baseUrl,
            autoProvision: false,
            showInitializing: false
          });
        } catch (err) {
          applyH2oManagedSubscriptionState(current, {
            status: 'error',
            syncStatus: 'auto-provision-failed',
            errorMessage: `当前用户没有 oversea 订阅，自动分配默认订阅失败：${errorMessage(err)}`
          });
          return;
        }
      }
      applyH2oManagedSubscriptionState(current, {
        status: 'pending',
        syncStatus: 'missing-entitlement',
        errorMessage: '当前用户还没有 active oversea entitlement，请先在 Internal / k8s admin 分配 oversea。'
      });
      return;
    }

    let accounts = Array.isArray(entitlement.accounts) ? entitlement.accounts : [];
    let activeAccounts = accounts.filter((account) => account?.status === 'active');
    let syncedAccounts = activeAccounts.filter((account) => account?.runtimeSync?.status === 'synced');
    const entitlementSiteIds = arrayValue(entitlement?.siteIds, accounts.map((account) => account.siteId))
      .map((item) => String(item || '').trim())
      .filter(Boolean);
    if (options.autoProvision !== false && (!activeAccounts.length || !syncedAccounts.length)) {
      try {
        await provisionH2oOverseaForCurrentUser({
          baseUrl,
          bootstrapResolveMode: options.bootstrapResolveMode,
          siteIds: entitlementSiteIds,
          skipHydrate: true
        });
        return await hydrateH2oSystemSubscriptionsForUser({
          ...options,
          userId,
          baseUrl,
          autoProvision: false,
          showInitializing: false
        });
      } catch (err) {
        pushAppLog('h2o', 'warning', `H2O existing oversea entitlement ensure failed during hydrate: ${errorMessage(err)}`);
      }
    }
    const subscriptionPath = nullableString(entitlement.subscriptionPath)
      || `/internal/v1/user-center/users/${encodeURIComponent(userId)}/oversea/subscription.yaml`;
    const subscriptionFetchUrl = h2oManagedSubscriptionUrl(subscriptionPath, { baseUrl })
      || joinApiUrl(baseUrl, subscriptionPath);
    const subscriptionRuntimeUrl = h2oManagedSubscriptionUrl(subscriptionPath, { baseUrl: subscriptionFetchUrl })
      || subscriptionFetchUrl;

    if (!activeAccounts.length) {
      applyH2oManagedSubscriptionState(current, {
        entitlement,
        status: 'pending',
        syncStatus: 'missing-active-account',
        errorMessage: '当前用户有 oversea entitlement，但没有 active oversea account。'
      });
      return;
    }

    if (!syncedAccounts.length && options.autoSyncRuntime !== false) {
      try {
        const syncPayload = await syncH2oOverseaRuntimeForUser({
          userId,
          baseUrl,
          siteIds: activeAccounts.map((account) => account.siteId).filter(Boolean),
          requestedBy: 'mx-h2i-h2o',
          requestId: makeRequestId('h2o-oversea-hydrate-sync'),
          bootstrapResolveMode: options.bootstrapResolveMode
        });
        const refreshedEntitlement = syncPayload?.entitlement && typeof syncPayload.entitlement === 'object'
          ? syncPayload.entitlement
          : null;
        if (refreshedEntitlement) {
          entitlement = refreshedEntitlement;
          accounts = Array.isArray(entitlement.accounts) ? entitlement.accounts : [];
          activeAccounts = accounts.filter((account) => account?.status === 'active');
          syncedAccounts = activeAccounts.filter((account) => account?.runtimeSync?.status === 'synced');
        }
      } catch (err) {
        pushAppLog('h2o', 'warning', `H2O user oversea runtime sync failed during hydrate: ${errorMessage(err)}`);
      }
    }

    // 和启动时的预取共用同一条候选链，并记住真正成功的地址：Domestic edge 现在
    // 只反代 /healthz，公网地址恒 404，能取到的是 WG 之后的 Internal 地址。
    const fetchCandidates = uniqueStrings([
      subscriptionFetchUrl,
      joinApiUrl(baseUrl, subscriptionPath),
      ...h2oSubscriptionUrlCandidates({ url: subscriptionFetchUrl })
    ]);
    let yaml = null;
    let resolvedUrl = null;
    const fetchFailures = [];
    for (const candidate of fetchCandidates) {
      try {
        yaml = await requestText(candidate, {
          timeoutMs: 5000,
          bootstrapResolveMode: options.bootstrapResolveMode,
          headers: { ...appCenterCatalogHeaders(), accept: 'text/yaml, text/plain, */*' }
        });
        resolvedUrl = candidate;
        break;
      } catch (err) {
        fetchFailures.push(`${candidate}: ${errorMessage(err)}`);
      }
    }
    if (!resolvedUrl) throw new Error(fetchFailures.join('；'));
    if (resolvedUrl !== subscriptionFetchUrl) {
      pushAppLog('h2o', 'info', `H2O subscription resolved via fallback URL: ${resolvedUrl}`);
    }
    await ensureH2oClashSubscriptionLink({ baseUrl, bootstrapResolveMode: options.bootstrapResolveMode });
    applyH2oManagedSubscriptionState(current, {
      entitlement,
      status: 'ready',
      syncStatus: syncedAccounts.length ? 'synced' : 'pending-runtime-sync',
      subscriptionUrl: subscriptionRuntimeUrl,
      resolvedUrl,
      yaml,
      errorMessage: syncedAccounts.length
        ? null
        : firstH2oOverseaSyncReason(activeAccounts) || '订阅已由 Internal 生成；oversea runtime 同步仍在等待，可先应用到 H2O。'
    });
  } catch (err) {
    applyH2oManagedSubscriptionState(current, {
      status: 'error',
      syncStatus: 'fetch-failed',
      errorMessage: `获取 Internal oversea 订阅失败：${errorMessage(err)}`
    });
  }
}

function applyH2oManagedSubscriptionState(current, input = {}) {
  const now = nowIso();
  const entitlement = input.entitlement && typeof input.entitlement === 'object' ? input.entitlement : null;
  const accounts = Array.isArray(entitlement?.accounts) ? entitlement.accounts : [];
  const activeAccounts = accounts.filter((account) => account?.status === 'active');
  const syncedAccounts = activeAccounts.filter((account) => account?.runtimeSync?.status === 'synced');
  const siteIds = arrayValue(entitlement?.siteIds, activeAccounts.map((account) => account.siteId))
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  const defaultUrl = input.subscriptionUrl
    || h2oManagedSubscriptionUrl(entitlement?.subscriptionPath)
    || 'mx-h2i://managed/home-to-oversea';
  const yamlBytes = typeof input.yaml === 'string' ? Buffer.byteLength(input.yaml, 'utf8') : 0;
  const nodes = countHysteria2Proxies(input.yaml) || syncedAccounts.length || activeAccounts.length || 0;
  const defaultSubscription = {
    id: 'h2o-default',
    name: 'System Oversea 默认订阅',
    url: defaultUrl,
    resolvedUrl: nullableString(input.resolvedUrl) || nullableString(current.activeSubscription?.resolvedUrl),
    nodes,
    latencyMs: Number(current.activeSubscription?.latencyMs || 42),
    status: input.status || 'pending',
    source: 'internal',
    requiresUser: true,
    assignable: true,
    entitlementId: nullableString(entitlement?.entitlementId),
    siteIds,
    syncStatus: input.syncStatus || null,
    errorMessage: nullableString(input.errorMessage),
    yamlBytes,
    lastUpdatedAt: now
  };
  const siteSubscriptions = activeAccounts.map((account) => ({
    id: `h2o-${String(account.siteId || 'oversea').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name: `${account.siteId || 'Oversea'} 用户订阅`,
    url: h2oManagedSubscriptionUrl(account.subscriptionPath || account.siteSubscriptionUrl) || defaultUrl,
    nodes: account.runtimeSync?.status === 'synced' ? 1 : 0,
    latencyMs: 42,
    status: account.runtimeSync?.status === 'synced' ? 'ready' : 'pending',
    source: 'internal',
    requiresUser: true,
    assignable: account.runtimeSync?.status === 'synced',
    entitlementId: nullableString(entitlement?.entitlementId),
    siteIds: [account.siteId].filter(Boolean),
    syncStatus: nullableString(account.runtimeSync?.status),
    errorMessage: account.runtimeSync?.status === 'synced' ? null : nullableString(account.runtimeSync?.reason),
    yamlBytes: 0,
    lastUpdatedAt: now
  }));
  const localSubscriptions = h2oPreservedLocalSubscriptions(current);
  const byId = new Map();
  for (const item of [defaultSubscription, ...siteSubscriptions, ...localSubscriptions]) {
    byId.set(item.id, item);
  }
  const subscriptions = [...byId.values()];
  const activeLocal = h2oPreservedLocalSubscription(current.activeSubscription);
  const activeSubscription = subscriptions.find((item) => item.id === (activeLocal?.id || current.activeSubscriptionId))
    || subscriptions.find((item) => item.id === 'h2o-default')
    || current.activeSubscription;
  const nextStatus = input.syncStatus === 'initializing'
    ? 'subscription-initializing'
    : current.running ? 'running' : h2oHasUsableSubscription(activeSubscription) ? 'ready' : 'subscription-required';
  runtime.apps.h2o.runtime = h2oPluginRuntime({
    ...current,
    subscriptions,
    activeSubscription,
    activeSubscriptionId: activeSubscription.id,
    status: nextStatus,
    // `current` 是调用方更早拿的快照，而 clashLink 可能在那之后才写进来（水合时顺带签发的）。
    // 不显式取实时值的话，这次覆盖会把刚拿到的链接冲掉。
    clashLink: h2oPluginRuntime(runtime.apps.h2o.runtime).clashLink || current.clashLink || null,
    lastAppliedAt: now
  });
  if (input.status === 'ready') {
    pushAppLog('h2o', 'info', `H2O user oversea subscription is ready for ${siteIds.join(',') || 'default site'}.`);
  } else if (input.syncStatus === 'initializing' && input.errorMessage) {
    pushAppLog('h2o', 'info', input.errorMessage);
  } else if (input.errorMessage) {
    pushAppLog('h2o', input.status === 'error' ? 'error' : 'warning', input.errorMessage);
  }
}

function h2oPreservedLocalSubscriptions(h2oRuntime) {
  const current = h2oPluginRuntime(h2oRuntime);
  const byId = new Map();
  for (const item of [current.activeSubscription, ...current.subscriptions]) {
    const preserved = h2oPreservedLocalSubscription(item);
    if (preserved) byId.set(preserved.id, preserved);
  }
  return [...byId.values()];
}

function h2oPreservedLocalSubscription(item) {
  const normalized = normalizeH2oSubscription(item, {});
  if (!shouldPreserveH2oLocalSubscription(normalized)) return null;
  if (h2oIsManagedSubscriptionId(normalized.id) && h2oLooksLikeExternalSubscriptionUrl(normalized.url)) {
    return {
      ...normalized,
      id: `custom-${h2oSubscriptionIdFromText(normalized.url)}`,
      source: 'custom',
      requiresUser: false,
      status: normalized.status === 'error' ? 'error' : 'ready',
      syncStatus: normalized.syncStatus || 'migrated-local',
      errorMessage: normalized.status === 'error' ? normalized.errorMessage : null
    };
  }
  return normalized;
}

function shouldPreserveH2oLocalSubscription(item) {
  const source = nullableString(item?.source);
  return source === 'custom'
    || source === 'external'
    || source === 'demo'
    || item?.requiresUser === false
    || h2oLooksLikeExternalSubscriptionUrl(item?.url);
}

function h2oIsManagedSubscriptionId(id) {
  const text = nullableString(id);
  return text === 'h2o-default'
    || text === 'h2o-oversea-backup'
    || /^h2o-oversea-/i.test(text || '');
}

function h2oShouldDropSubscription(item) {
  return nullableString(item?.id) === 'h2o-oversea-backup';
}

function h2oLooksLikeExternalSubscriptionUrl(url) {
  const text = nullableString(url);
  return /^https?:\/\//i.test(text || '') && !h2oLooksLikeManagedSubscriptionUrl(text);
}

function h2oLooksLikeHttpSubscriptionUrl(url) {
  return /^https?:\/\//i.test(nullableString(url) || '');
}

function h2oLooksLikeManagedSubscriptionUrl(url) {
  const text = nullableString(url);
  if (!text) return false;
  if (/^mx-h2i:\/\//i.test(text)) return true;
  try {
    const parsed = new URL(text);
    return parsed.pathname.includes('/internal/v1/user-center/')
      || parsed.pathname.includes('/internal/v1/site-slots/');
  } catch (_err) {
    return false;
  }
}

function h2oComparableSubscriptionUrl(url) {
  const text = nullableString(url);
  if (!text) return '';
  try {
    const parsed = new URL(text);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch (_err) {
    return text;
  }
}

function h2oSubscriptionIdFromText(value) {
  const safe = String(value || 'subscription')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return safe || 'subscription';
}

function firstH2oOverseaSyncReason(accounts) {
  const rows = Array.isArray(accounts) ? accounts : [];
  const account = rows.find((item) => item?.runtimeSync?.reason) || rows[0];
  return nullableString(account?.runtimeSync?.reason);
}

/**
 * 聚合订阅（System Oversea 默认订阅）的地址**不能给 Clash 用**：
 * 它要 Bearer，而且 Domestic edge 的 allowlist 故意不放行 /internal/v1/user-center/*，
 * 所以粘到 Clash 里只会 404。第三方客户端要用的是 token 在路径里的 public link。
 *
 * 这里按用户自己的 Bearer 签发/轮换那条链接（scope: oversea.subscription.ensure），
 * 明文 token 只在签发响应里出现一次，所以拿到就直接存进 runtime 供复制。
 */
/**
 * 水合订阅时顺带备好那条可复制的 token 链接，这样默认订阅那一行直接就有能用的地址，
 * 不用用户先去点一次按钮。
 *
 * **绝不静默轮换**：签发会吊销上一条，已经配进 Clash 的订阅会当场失效。
 * 所以只在「服务端没有活跃链接」且「本机也没有副本」时才签发；服务端有链接但本机没有
 * 明文（明文只在签发响应里出现一次，换了台机器就拿不回来）时保持为空，由 UI 说明要重新生成。
 */
async function ensureH2oClashSubscriptionLink(input = {}) {
  try {
    const current = h2oPluginRuntime(runtime.apps.h2o.runtime);
    if (decideClashLinkAction({ local: current.clashLink }) === 'reuse') return current.clashLink;
    const baseUrl = normalizeBaseUrl(input?.baseUrl)
      || normalizeBaseUrl(runtime.connection?.internalBaseUrl);
    const userId = await h2oCurrentUserId({ baseUrl, bootstrapResolveMode: input.bootstrapResolveMode });
    if (!userId) return null;
    const remote = await h2oRequestInternalJson(
      baseUrl,
      `/internal/v1/user-center/users/${encodeURIComponent(userId)}/oversea/subscription-link`,
      { timeoutMs: 5000, bootstrapResolveMode: input.bootstrapResolveMode, headers: appCenterCatalogHeaders() }
    ).then((result) => result.payload?.link || null).catch(() => null);
    const action = decideClashLinkAction({ local: current.clashLink, remote });
    if (action === 'remote-only') {
      // 有链接但本机没有明文：宁可让用户显式重新生成，也不要替他把旧链接作废。
      runtime.apps.h2o.runtime = h2oPluginRuntime({
        ...h2oPluginRuntime(runtime.apps.h2o.runtime),
        clashLink: { url: null, issuedAt: nullableString(remote.issuedAt), expiresAt: nullableString(remote.expiresAt) }
      });
      return null;
    }
    const issued = await issueH2oClashSubscriptionLink(input);
    runtime.apps.h2o.runtime = h2oPluginRuntime({
      ...h2oPluginRuntime(runtime.apps.h2o.runtime),
      clashLink: { url: issued.url, expiresAt: issued.expiresAt, issuedAt: nowIso() }
    });
    pushAppLog('h2o', 'info', 'H2O clash subscription link provisioned during hydrate.');
    return issued;
  } catch (err) {
    // 这是锦上添花的一步，取不到不该影响订阅本身。
    pushAppLog('h2o', 'info', `H2O clash subscription link skipped: ${errorMessage(err)}`);
    return null;
  }
}

async function issueH2oClashSubscriptionLink(input = {}) {
  const baseUrl = normalizeBaseUrl(input?.baseUrl)
    || normalizeBaseUrl(runtime.connection?.internalBaseUrl)
    || await resolveBootstrapBaseUrl(runtime.config);
  const userId = await h2oCurrentUserId({ baseUrl, bootstrapResolveMode: input.bootstrapResolveMode });
  if (!userId) throw new Error('需要先登录员工用户才能签发 Clash 订阅链接。');
  const { payload } = await h2oRequestInternalJson(
    baseUrl,
    `/internal/v1/user-center/users/${encodeURIComponent(userId)}/oversea/subscription-link`,
    {
      method: 'POST',
      timeoutMs: 8000,
      bootstrapResolveMode: input.bootstrapResolveMode,
      headers: appCenterCatalogHeaders(),
      body: {
        requestedBy: 'mx-h2i-h2o',
        requestId: makeRequestId('h2o-clash-link')
      }
    }
  );
  const path = nullableString(payload?.link?.path);
  if (!path) throw new Error('Internal 没有返回可用的订阅链接。');
  // public link 必须走公网域名：裸 IP 的 https 在 Domestic ingress 上 SNI 握手必失败。
  const url = h2oManagedSubscriptionUrl(path, { baseUrl });
  if (!url) throw new Error('无法拼出可用的订阅链接地址。');
  return { url, expiresAt: nullableString(payload?.link?.expiresAt) };
}

function h2oManagedSubscriptionUrl(pathName, options = {}) {
  const pathText = h2oManagedSubscriptionPath(pathName);
  const baseUrl = h2oSubscriptionDeliveryBaseUrl(options.baseUrl);
  if (!pathText || !baseUrl) return null;
  try {
    return joinApiUrl(baseUrl, pathText);
  } catch (_err) {
    return null;
  }
}

function h2oManagedSubscriptionPath(value) {
  const text = nullableString(value);
  if (!text) return null;
  if (/^mx-h2i:\/\//i.test(text)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.pathname}${parsed.search || ''}`;
  } catch (_err) {
    return null;
  }
}

function h2oSubscriptionDeliveryBaseUrl(fallbackBaseUrl) {
  return h2oDomesticApiBaseUrl(fallbackBaseUrl)
    || normalizeBaseUrl(runtime?.config?.bootstrapApiBaseUrl)
    || normalizeBaseUrl(fallbackBaseUrl)
    || normalizeBaseUrl(runtime?.connection?.internalBaseUrl)
    || normalizeBaseUrl(runtime?.config?.internalApiBaseUrl)
    || normalizeBaseUrl(DEFAULT_CONFIG.internalApiBaseUrl);
}

function h2oDomesticApiBaseUrl(fallbackBaseUrl) {
  const bootstrapBaseUrl = normalizeBaseUrl(runtime?.config?.bootstrapApiBaseUrl)
    || normalizeBaseUrl(fallbackBaseUrl)
    || normalizeBaseUrl(DEFAULT_CONFIG.bootstrapApiBaseUrl);
  const domesticHost = publicHostFromEndpoint(runtime?.config?.domesticRelayHost)
    || publicHostFromEndpoint(DEFAULT_CONFIG.domesticRelayHost)
    || publicHostFromUrl(bootstrapBaseUrl);
  if (!bootstrapBaseUrl || !domesticHost) return null;
  try {
    const parsed = new URL(bootstrapBaseUrl);
    // 订阅 URL 会被交给 mihomo / 外部下载器，它们不会带 MX-H2I 的 Host Resolve + SNI 覆写。
    // Domestic 入口是按 SNI 分流的 ingress，用裸 IP 直连 https 会拿到 TLS unrecognized_name，
    // 因此 https 场景保留 bootstrap 域名（域名已解析到同一个 Domestic 公网 IP）。
    if (!h2oSubscriptionHostKeepsTlsIdentity(parsed, domesticHost)) {
      parsed.hostname = domesticHost;
    }
    parsed.username = '';
    parsed.password = '';
    return normalizeBaseUrl(parsed.toString());
  } catch (_err) {
    return null;
  }
}

function h2oSubscriptionHostKeepsTlsIdentity(parsed, domesticHost) {
  if (parsed.protocol !== 'https:') return false;
  if (net.isIP(domesticHost) === 0) return false;
  return net.isIP(parsed.hostname) === 0;
}

function countHysteria2Proxies(yaml) {
  if (typeof yaml !== 'string') return 0;
  const matches = yaml.match(/^\s{4}type:\s*hysteria2\s*$/gm);
  return matches ? matches.length : 0;
}

function countMihomoSubscriptionNodes(yaml) {
  if (typeof yaml !== 'string') return 1;
  const hysteria2Count = countHysteria2Proxies(yaml);
  const namedProxyCount = (yaml.match(/^\s*-\s+name\s*:/gm) || []).length;
  return Math.max(hysteria2Count, namedProxyCount, 1);
}

function normalizePort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

function normalizeNonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function defaultAppRecordFor(input, fallbackAppId) {
  const row = input && typeof input === 'object' ? input : {};
  const appId = nullableString(row.appId) || safePathSegment(fallbackAppId);
  return {
    appId,
    displayName: nullableString(row.displayName) || appId,
    category: nullableString(row.category) || 'custom',
    description: nullableString(row.description) || '',
    packageName: nullableString(row.packageName) || `@qpjoy/electron-launcher-app-${safePathSegment(appId).toLowerCase()}`,
    launcherMode: row.launcherMode === 'standalone' ? 'standalone' : 'embed',
    standaloneChannelProductId: nullableString(row.standaloneChannelProductId) || 'mx-h2i',
    networkScope: nullableString(row.networkScope) || (row.launcherMode === 'standalone' ? 'owner' : 'broker-session'),
    version: nullableString(row.version) || '0.1.0',
    latestVersion: nullableString(row.latestVersion) || nullableString(row.version) || '0.1.0',
    updatePolicy: nullableString(row.updatePolicy) || 'launcher-managed',
    permissions: arrayValue(row.permissions, []),
    requiredCapabilities: arrayValue(row.requiredCapabilities, []),
    installSource: nullableString(row.installSource) || 'npm',
    entrypoints: normalizeStringRecord(row.entrypoints, {})
  };
}

function normalizeAppLogs(value) {
  return Array.isArray(value)
    ? value.map((item) => {
      const row = item && typeof item === 'object' ? item : {};
      const level = ['info', 'warning', 'error'].includes(row.level) ? row.level : 'info';
      const message = nullableString(row.message);
      if (!message) return null;
      return {
        level,
        message,
        at: nullableString(row.at) || nowIso()
      };
    }).filter(Boolean).slice(0, 20)
    : [];
}

function pushAppLog(appId, level, message) {
  const appRecord = runtime?.apps?.[appId];
  if (!appRecord) return;
  appRecord.logs = normalizeAppLogs([
    { level, message, at: nowIso() },
    ...(appRecord.logs || [])
  ]);
  if (level === 'warning' || level === 'error') {
    queueDiagnosticLog(level, `app.${appId}`, message);
  }
}

async function syncAppCenterCatalog(reason) {
  try {
    const baseUrl = appCenterCatalogBaseUrl();
    if (!baseUrl) return { ok: false, count: 0, message: 'Internal API baseUrl 为空' };
    const params = new URLSearchParams();
    params.set('sourceAppId', PRODUCT_ID);
    const userId = appCenterCatalogUserId();
    if (userId) params.set('userId', userId);
    const identity = appCenterInstallationIdentity();
    if (identity.installId) params.set('installId', identity.installId);
    if (identity.deviceId) params.set('deviceId', identity.deviceId);
    const pathName = `/internal/v1/app-center/apps?${params.toString()}`;
    const payload = await requestJson(joinApiUrl(baseUrl, pathName), {
      timeoutMs: 4500,
      headers: appCenterCatalogHeaders()
    });
    const apps = Array.isArray(payload?.apps) ? payload.apps : [];
    mergeAppCenterCatalogApps(apps);
    pushAppLog('appcenter', 'info', `Synced ${apps.length} apps from Internal catalog (${reason}).`);
    touchRuntime(`appcenter catalog synced:${reason}`);
    return { ok: true, count: apps.length, message: '' };
  } catch (error) {
    const message = errorMessage(error);
    pushAppLog('appcenter', 'warning', `Catalog sync failed (${reason}): ${message}`);
    return { ok: false, count: 0, message };
  }
}

function releaseCenterConnectionReady() {
  return runtime?.connection?.state === 'connected'
    && Boolean(normalizeBaseUrl(runtime.connection.internalBaseUrl) || normalizeBaseUrl(runtime?.config?.internalApiBaseUrl));
}

function releaseCenterConnectionPrompt() {
  return '更新服务部署在 Internal 上，请先点击连接进入访客模式，或使用员工登录。连接成功后 MX-H2I 会自动检查更新。';
}

async function checkUpdatesWithConnectionGuard(reason, options = {}) {
  const manual = options.manual === true;
  if (!releaseCenterConnectionReady()) {
    const message = releaseCenterConnectionPrompt();
    runtime.update = normalizeUpdate({
      ...(runtime.update || {}),
      status: 'needs-connection',
      updateAvailable: false,
      reason: message
    }, runtime.config);
    if (manual) {
      runtime.feedback = {
        tone: 'info',
        message
      };
    }
    pushAppLog('appcenter', 'info', `Release check skipped (${reason}): Internal not connected.`);
    touchRuntime('update check waiting for internal');
    await saveAndBroadcast();
    return { ok: false, skipped: true, message };
  }
  if (releaseUpdateCheckInFlight) {
    if (manual) {
      runtime.feedback = {
        tone: 'info',
        message: '正在检查更新，请稍候。'
      };
      touchRuntime('update check already running');
      await saveAndBroadcast();
    }
    return releaseUpdateCheckInFlight;
  }
  releaseUpdateCheckInFlight = performUpdateCheck(reason, options).finally(() => {
    releaseUpdateCheckInFlight = null;
  });
  return releaseUpdateCheckInFlight;
}

async function performUpdateCheck(reason, options = {}) {
  const quiet = options.quiet === true;
  const catalogSync = await syncAppCenterCatalog(reason);
  const releaseSync = await checkReleaseCenterUpdate(reason);
  const releaseCatalog = await fetchReleaseHistory(reason);
  const releaseResult = releaseSync.result;
  const releasePlan = releaseResult?.plan || null;
  const releaseDecision = releaseResult?.decision || null;
  const releaseArtifact = releaseResult?.artifacts?.[0] || null;
  const updateAvailable = releaseResult?.status === 'update-available' || releaseResult?.status === 'blocked';
  const checkedAt = releaseResult?.checkedAt || nowIso();
  const historyEntry = updateHistoryEntry({
    kind: 'check',
    status: releaseResult?.status || (releaseSync.ok ? 'checked' : 'failed'),
    version: releaseDecision?.targetVersion || currentReleaseVersion(),
    fromVersion: currentReleaseVersion(),
    releaseId: releasePlan?.releaseId || null,
    planId: releasePlan?.planId || null,
    componentKind: releaseDecision?.componentKind || null,
    updateMode: releaseDecision?.updateMode || null,
    message: releaseSync.ok ? releaseUpdateMessage(releaseResult) : userFacingUpdateFailure(releaseSync.message),
    at: checkedAt
  });
  runtime.update = normalizeUpdate({
    ...(runtime.update || {}),
    status: releaseSync.ok ? releaseResult.status : 'failed',
    currentVersion: currentReleaseVersion(),
    latestVersion: releaseDecision?.targetVersion || currentReleaseVersion(),
    policy: releaseDecision?.updateMode || 'launcher-managed',
    channel: runtime.config.releaseChannel,
    rolloutGroup: releasePlan?.rollout?.segmentId || runtime.config.rolloutGroup,
    updateAvailable,
    canSkip: releaseDecision?.canSkip === true,
    lastCheckedAt: checkedAt,
    planId: releasePlan?.planId || null,
    releaseId: releasePlan?.releaseId || null,
    componentId: releaseDecision?.componentId || launcherProductId(),
    componentKind: releaseDecision?.componentKind || null,
    updateMode: releaseDecision?.updateMode || null,
    reason: releaseSync.ok ? releaseResult.reason : userFacingUpdateFailure(releaseSync.message),
    artifactKind: releaseArtifact?.kind || null,
    artifactId: releaseArtifact?.artifactId || null,
    artifactUrl: releaseArtifact?.url || null,
    artifactDigest: releaseArtifact?.digest || null,
    artifactSignature: releaseArtifact?.signature || null,
    artifactSizeBytes: Number.isFinite(releaseArtifact?.sizeBytes) ? releaseArtifact.sizeBytes : null,
    artifactPlatform: releaseArtifact?.platform || null,
    artifactArch: releaseArtifact?.arch || null,
    artifactFileName: releaseArtifact?.fileName || null,
    activation: releaseArtifact?.activation || null,
    restartRequired: releaseArtifact?.restartRequired === true,
    majorUpdateRequiresInstaller: releasePlan?.activation?.majorUpdateRequiresInstaller === true,
    hotUpdateAuto: releasePlan?.activation?.hotUpdateAuto === true,
    deliveryMode: normalizeReleaseDeliveryMode(releaseResult?.deliveryMode),
    releaseNotes: releaseResult?.releaseNotes || null,
    rolloutMatchedBy: releaseResult?.rollout?.matchedBy || null,
    rolloutBucket: Number.isFinite(releaseResult?.rollout?.bucket) ? releaseResult.rollout.bucket : null,
    featureFlags: Array.isArray(releaseResult?.featureFlags) ? releaseResult.featureFlags : [],
    downloadProgress: null,
    availableReleases: mergeAvailableRelease(
      releaseCatalog.ok ? releaseCatalog.releases : runtime.update?.availableReleases,
      availableReleaseFromPlan(releasePlan, releaseDecision, releaseArtifact, releaseResult?.status)
    ),
    history: prependUpdateHistory(runtime.update?.history, historyEntry)
  }, runtime.config);
  const failures = [
    catalogSync.ok === false ? `AppCenter 目录同步失败：${userFacingUpdateFailure(catalogSync.message)}` : null,
    releaseSync.ok === false ? `Release Center 检查失败：${userFacingUpdateFailure(releaseSync.message)}` : null
  ].filter(Boolean);
  const releaseMessage = releaseSync.ok
    ? releaseUpdateMessage(releaseResult)
    : 'Release Center 更新策略读取失败。';
  const hasUpdateSignal = ['update-available', 'blocked'].includes(releaseResult?.status);
  const deliveryMode = normalizeReleaseDeliveryMode(releaseResult?.deliveryMode);
  const silentDelivery = deliveryMode === 'silent-download-next-start';
  if (!quiet || (hasUpdateSignal && !silentDelivery)) {
    const updateFeedbackMessage = `${releaseMessage} 当前 ${currentReleaseVersion()}，目标 ${releaseDecision?.targetVersion || currentReleaseVersion()}，通道 ${runtime.config.releaseChannel}。AppCenter 目录已同步 ${catalogSync.count} 个应用。`;
    runtime.feedback = {
      tone: failures.length ? 'warning' : (releaseResult?.status === 'update-available' ? 'success' : 'info'),
      message: failures.length
        ? `${releaseMessage} ${failures.join('；')}`
        : updateFeedbackMessage
    };
  }
  touchRuntime('update checked');
  await saveAndBroadcast();
  if (
    releaseResult?.status === 'update-available'
    && deliveryMode === 'silent-download-next-start'
    && /asar/i.test(releaseArtifact?.kind || '')
  ) {
    await applyLauncherUpdate(`silent-${reason}`);
    await saveAndBroadcast();
  }
  return { ok: failures.length === 0, skipped: false, releaseResult, catalogSync, releaseSync };
}

async function fetchReleaseHistory(reason) {
  try {
    const baseUrl = appCenterCatalogBaseUrl();
    if (!baseUrl) return { ok: false, releases: [], message: 'Internal API baseUrl 为空' };
    const productId = launcherProductId();
    const params = new URLSearchParams({
      componentId: productId,
      channel: runtime.config.releaseChannel,
      platform: process.platform,
      arch: process.arch,
      limit: '8'
    });
    let releases;
    try {
      const payload = await requestJson(joinApiUrl(baseUrl, `/internal/v1/releases/history?${params}`), {
        timeoutMs: 4500,
        headers: appCenterCatalogHeaders()
      });
      releases = normalizeAvailableReleases(payload?.releases);
    } catch {
      // Compatibility with an older Internal server during rolling upgrade.
      const payload = await requestJson(joinApiUrl(baseUrl, '/internal/v1/release-management/plans'), {
        timeoutMs: 4500,
        headers: appCenterCatalogHeaders()
      });
      releases = (Array.isArray(payload?.plans) ? payload.plans : [])
        .map((plan) => availableReleaseFromPlan(plan))
        .filter(Boolean)
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
        .slice(0, 8);
    }
    pushAppLog('appcenter', 'info', `Loaded ${releases.length} release plans (${reason}).`);
    return { ok: true, releases, message: '' };
  } catch (error) {
    const message = userFacingUpdateFailure(errorMessage(error));
    pushAppLog('appcenter', 'warning', `Release history sync failed (${reason}): ${message}`);
    return { ok: false, releases: [], message };
  }
}

function availableReleaseFromPlan(plan, decision = null, artifact = null, status = null) {
  if (!plan && !decision && !artifact) return null;
  const productId = launcherProductId();
  const selectedDecision = decision
    || [plan?.components?.launcher, plan?.components?.app].filter(Boolean).find((item) => item.componentId === productId)
    || null;
  const selectedArtifact = artifact
    || arrayValue(plan?.artifacts, []).find((item) => {
      if (item.componentId && item.componentId !== productId) return false;
      if (item.platform && item.platform !== process.platform) return false;
      return !item.arch || item.arch === 'universal' || item.arch === process.arch;
    })
    || null;
  if (!selectedDecision && !selectedArtifact) return null;
  const gate = nullableString(plan?.test?.gate?.verdict);
  return {
    id: nullableString(plan?.planId) || nullableString(plan?.releaseId) || nullableString(selectedArtifact?.artifactId) || makeRequestId('release'),
    releaseId: nullableString(plan?.releaseId),
    planId: nullableString(plan?.planId),
    version: nullableString(selectedDecision?.targetVersion) || nullableString(selectedArtifact?.version),
    channel: nullableString(plan?.channel) || runtime?.config?.releaseChannel || null,
    status: nullableString(status) || (gate && gate !== 'passed' ? 'blocked' : gate === 'passed' ? 'ready' : 'planned'),
    componentKind: nullableString(selectedDecision?.componentKind) || nullableString(selectedArtifact?.kind),
    updateMode: nullableString(selectedDecision?.updateMode),
    artifactKind: nullableString(selectedArtifact?.kind),
    activation: nullableString(selectedArtifact?.activation),
    sizeBytes: Number.isFinite(selectedArtifact?.sizeBytes) ? selectedArtifact.sizeBytes : null,
    platform: nullableString(selectedArtifact?.platform),
    arch: nullableString(selectedArtifact?.arch),
    fileName: nullableString(selectedArtifact?.fileName),
    artifactId: nullableString(selectedArtifact?.artifactId),
    artifactUrl: nullableString(selectedArtifact?.url),
    artifactDigest: nullableString(selectedArtifact?.digest),
    artifactSignature: nullableString(selectedArtifact?.signature),
    deliveryMode: normalizeReleaseDeliveryMode(plan?.deliveryMode),
    restartRequired: selectedArtifact?.restartRequired === true,
    createdAt: nullableString(plan?.createdAt),
    gate
  };
}

function mergeAvailableRelease(existing, nextRelease) {
  const rows = normalizeAvailableReleases(existing);
  if (!nextRelease) return rows;
  const normalized = normalizeAvailableReleases([nextRelease])[0];
  if (!normalized) return rows;
  return [
    normalized,
    ...rows.filter((item) => item.id !== normalized.id && item.releaseId !== normalized.releaseId)
  ].slice(0, 8);
}

async function checkReleaseCenterUpdate(reason) {
  try {
    const baseUrl = appCenterCatalogBaseUrl();
    if (!baseUrl) return { ok: false, result: null, message: 'Internal API baseUrl 为空' };
    const mod = await importInstalledPackage('@qpjoy/electron-launcher');
    if (typeof mod.createElectronLauncherReleaseUpdater !== 'function') {
      return { ok: false, result: null, message: '当前 Launcher 包不包含 release updater。' };
    }
    const identity = appCenterInstallationIdentity();
    const userId = releaseCenterUserId();
    const updater = mod.createElectronLauncherReleaseUpdater({
      baseUrl,
      fetchImpl: launcherFetchForBootstrap(runtime.config.bootstrapResolveMode),
      reportInstallId: identity.installId
    });
    const currentVersion = currentReleaseVersion();
    const checks = [];
    const productId = launcherProductId();
    for (const target of [
      { componentId: productId, componentKind: 'app-installer' },
      { componentId: productId, componentKind: 'app-asar' },
      { componentId: `${productId}-renderer`, componentKind: 'renderer-ui' }
    ]) {
      try {
        checks.push(await updater.check({
          ...target,
          productId,
          currentVersion,
          channel: runtime.config.releaseChannel,
          installId: identity.installId,
          userId,
          platform: process.platform,
          arch: process.arch
        }));
      } catch (error) {
        checks.push({ status: 'failed', error: errorMessage(error), target });
      }
    }
    const result = chooseReleaseUpdateResult(checks, currentVersion, baseUrl);
    await updater.report({
      installId: identity.installId,
      status: result.status === 'failed' ? 'check-failed' : 'checked',
      error: result.status === 'failed' ? result.reason : null,
      metadata: {
        reason,
        productId,
        currentVersion,
        channel: runtime.config.releaseChannel,
        platform: process.platform,
        arch: process.arch,
        releaseId: result.plan?.releaseId || null,
        planId: result.plan?.planId || null,
        componentId: result.decision?.componentId || null,
        componentKind: result.decision?.componentKind || null,
        updateMode: result.decision?.updateMode || null,
        status: result.status
      }
    }).catch((error) => {
      pushAppLog('appcenter', 'warning', `Release report failed (${reason}): ${errorMessage(error)}`);
    });
    pushAppLog('appcenter', result.status === 'failed' ? 'warning' : 'info', `Release check ${result.status}: ${result.reason}`);
    return { ok: result.status !== 'failed', result, message: result.reason };
  } catch (error) {
    const message = errorMessage(error);
    pushAppLog('appcenter', 'warning', `Release check failed (${reason}): ${message}`);
    return { ok: false, result: null, message };
  }
}

function normalizeReleaseDeliveryMode(value) {
  if (value === 'manual-download') return 'manual-download';
  if (value === 'silent-download-next-start') return 'silent-download-next-start';
  return 'prompt-download-restart';
}

function chooseReleaseUpdateResult(results, currentVersion, baseUrl) {
  const successful = results.filter((result) => result && !result.error && result.decision);
  const available = successful.filter((result) => result.status === 'update-available');
  const blocked = successful.filter((result) => result.status === 'blocked');
  const selected = available.find((result) => result.decision?.updateMode === 'mandatory')
    || available[0]
    || blocked.find((result) => result.decision?.updateMode === 'mandatory')
    || blocked[0]
    || successful[0];
  if (selected) return selected;
  const firstFailure = results.find((result) => result?.error);
  return {
    checkedAt: nowIso(),
    baseUrl,
    status: 'failed',
    plan: null,
    decision: {
      componentKind: firstFailure?.target?.componentKind || 'app-managed',
      componentId: firstFailure?.target?.componentId || launcherProductId(),
      currentVersion,
      targetVersion: currentVersion,
      updateAvailable: false,
      updateMode: 'none',
      canSkip: true,
      canDefer: true,
      requiresGate: false,
      rollbackRequired: false,
      reason: firstFailure?.error || 'Release Center check failed'
    },
    artifacts: [],
    reason: firstFailure?.error || 'Release Center check failed'
  };
}

function releaseUpdateMessage(result) {
  if (!result) return 'Release Center 没有返回更新策略。';
  if (result.status === 'up-to-date') return `当前已是最新版本 ${result.decision?.currentVersion || currentReleaseVersion()}。`;
  if (result.status === 'blocked') return `发现更新但门禁未通过：${result.reason}`;
  if (result.status === 'update-available') {
    const decision = result.decision || {};
    const plan = result.plan || {};
    if (decision.updateMode === 'mandatory') {
      return `发现 MX-H2I 大版本 ${decision.targetVersion}，需要手动下载安装包（${plan.releaseId || 'release plan'}）。`;
    }
    return `发现可自动更新版本 ${decision.targetVersion}（${decision.componentKind || 'component'}）。`;
  }
  return result.reason || 'Release Center 更新策略已读取。';
}

function updateHistoryEntry(input) {
  return normalizeUpdateHistory([{
    id: makeRequestId('update-history'),
    kind: input.kind,
    status: input.status,
    version: input.version,
    fromVersion: input.fromVersion,
    releaseId: input.releaseId,
    planId: input.planId,
    componentKind: input.componentKind,
    updateMode: input.updateMode,
    message: input.message,
    at: input.at || nowIso()
  }])[0];
}

function prependUpdateHistory(existing, entry) {
  const normalized = normalizeUpdateHistory(existing);
  if (!entry) return normalized;
  return [
    entry,
    ...normalized.filter((item) => {
      if (entry.releaseId && item.releaseId === entry.releaseId && item.kind === entry.kind && item.status === entry.status) return false;
      return item.id !== entry.id;
    })
  ].slice(0, 12);
}

function userFacingUpdateFailure(message) {
  const value = nullableString(message) || 'Internal 更新服务暂不可达。';
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|fetch failed|network/i.test(value)) {
    return 'Internal 更新服务暂不可达，请确认已连接 MX-H2I 后重试。';
  }
  return value;
}

function schedulePostConnectUpdateCheck(reason) {
  if (postConnectUpdateTimer) clearTimeout(postConnectUpdateTimer);
  postConnectUpdateTimer = setTimeout(() => {
    postConnectUpdateTimer = null;
    void checkUpdatesWithConnectionGuard(reason, { quiet: true }).catch((error) => {
      pushAppLog('appcenter', 'warning', `Post-connect release check failed (${reason}): ${errorMessage(error)}`);
    });
  }, 900);
  postConnectUpdateTimer.unref?.();
}

function releaseCenterUserId() {
  return parseUserIdFromSubject(runtime?.auth?.subject)
    || nullableString(runtime?.auth?.user?.userId)
    || null;
}

function availableReleaseById(releaseId) {
  const id = nullableString(releaseId);
  if (!id) return null;
  return normalizeAvailableReleases(runtime.update?.availableReleases)
    .find((item) => item.id === id || item.releaseId === id || item.planId === id || item.artifactId === id)
    || null;
}

function updateForAvailableRelease(update, release) {
  const activation = nullableString(release.activation) || 'installer-manual';
  return normalizeUpdate({
    ...update,
    status: 'update-available',
    latestVersion: release.version || update.latestVersion || currentReleaseVersion(),
    planId: release.planId,
    releaseId: release.releaseId,
    componentId: launcherProductId(),
    componentKind: release.componentKind || release.artifactKind || 'app-installer',
    artifactKind: release.artifactKind || release.componentKind || 'app-installer',
    artifactId: release.artifactId,
    artifactUrl: release.artifactUrl,
    artifactDigest: release.artifactDigest,
    artifactSignature: release.artifactSignature,
    artifactSizeBytes: release.sizeBytes,
    artifactPlatform: release.platform,
    artifactArch: release.arch,
    artifactFileName: release.fileName,
    activation,
    restartRequired: release.restartRequired === true || activation === 'installer-manual',
    majorUpdateRequiresInstaller: activation === 'installer-manual',
    hotUpdateAuto: activation === 'hot-auto',
    deliveryMode: normalizeReleaseDeliveryMode(release.deliveryMode),
    updateAvailable: true,
    stagedPath: null,
    downloadedAt: null,
    downloadedBytes: null,
    downloadedDigest: null,
    downloadProgress: null,
    installerOpenError: null,
    restartPrompt: false
  }, runtime.config);
}

async function applyLauncherUpdate(reason, requestedReleaseId = null) {
  const silent = String(reason || '').startsWith('silent-');
  let update = runtime.update || {};
  const selectedRelease = requestedReleaseId ? availableReleaseById(requestedReleaseId) : null;
  if (requestedReleaseId && !selectedRelease) {
    runtime.feedback = {
      tone: 'warning',
      message: '没有找到该大版本记录，请重新检查更新。'
    };
    return;
  }
  if (selectedRelease) {
    update = updateForAvailableRelease(update, selectedRelease);
    runtime.update = update;
  }
  const artifact = releaseArtifactFromUpdate(update);
  if (!artifact.url) {
    runtime.feedback = {
      tone: 'warning',
      message: selectedRelease
        ? '该历史版本没有可下载的安装包。'
        : '当前没有可下载的 Release artifact，请先检查更新。'
    };
    return;
  }
  const installer = artifact.activation === 'installer-manual' || update.majorUpdateRequiresInstaller === true;
  const baseUrl = appCenterCatalogBaseUrl();
  const mod = await importInstalledPackage('@qpjoy/electron-launcher');
  const updater = baseUrl && typeof mod.createElectronLauncherReleaseUpdater === 'function'
    ? mod.createElectronLauncherReleaseUpdater({
        baseUrl,
        fetchImpl: launcherFetchForBootstrap(runtime.config.bootstrapResolveMode),
        reportInstallId: runtime.installation?.installId
      })
    : null;
  if (
    installer
    && !selectedRelease
    && update.status === 'ready-to-install'
    && update.stagedPath
    && fsSync.existsSync(update.stagedPath)
  ) {
    await openDownloadedInstaller({
      updater,
      reason,
      artifact,
      targetPath: update.stagedPath,
      bytes: update.downloadedBytes,
      digest: update.downloadedDigest
    });
    return;
  }
  if (installer) {
    const choice = await dialog.showMessageBox(mainWindow || undefined, {
      type: 'info',
      buttons: ['下载并打开', '取消'],
      defaultId: 0,
      cancelId: 1,
      title: 'MX-H2I 更新',
      message: selectedRelease
        ? `安装 MX-H2I 指定版本 ${update.latestVersion || artifact.version || ''}`
        : `发现 MX-H2I ${update.latestVersion || artifact.version || ''} 更新`,
      detail: `${selectedRelease ? '将下载所选历史版本；安装旧版本会覆盖当前应用。' : '将下载 Release Center 中登记的安装包。'}校验 sha256 后交给系统打开，当前连接不会被重启或断开。`
    });
    if (choice.response !== 0) {
      runtime.feedback = { tone: 'info', message: '已取消下载更新。' };
      return;
    }
  }
  const targetPath = updateArtifactTargetPath(update, artifact);
  let lastProgressBroadcastAt = 0;
  runtime.update = normalizeUpdate({
    ...update,
    status: 'downloading',
    downloadProgress: {
      state: 'downloading',
      bytes: 0,
      totalBytes: artifact.sizeBytes,
      percent: artifact.sizeBytes ? 0 : null,
      updatedAt: nowIso()
    },
    history: prependUpdateHistory(update.history, updateHistoryEntry({
      kind: installer ? 'major-download' : 'hot-download',
      status: 'started',
      version: update.latestVersion || artifact.version,
      fromVersion: update.currentVersion || currentReleaseVersion(),
      releaseId: update.releaseId,
      planId: update.planId,
      componentKind: update.componentKind || artifact.kind,
      updateMode: update.updateMode,
      message: installer ? '开始下载大版本安装包。' : '开始下载热更新包。'
    }))
  }, runtime.config);
  if (!silent) {
    runtime.feedback = {
      tone: 'info',
      message: installer ? '正在下载 MX-H2I 安装包。' : '正在下载热更新包。'
    };
  }
  touchRuntime('update download started');
  await saveAndBroadcast();
  await updater?.report?.({
    installId: runtime.installation?.installId,
    status: 'download-started',
    metadata: releaseReportMetadata(reason, update, artifact, { targetPath })
  }).catch((error) => {
    pushAppLog('appcenter', 'warning', `Release download-started report failed: ${errorMessage(error)}`);
  });
  try {
    const result = await downloadReleaseArtifactToFileWithProgress({
      artifact,
      targetPath,
      onProgress: (progress) => {
        const now = Date.now();
        runtime.update = normalizeUpdate({
          ...runtime.update,
          downloadedBytes: progress.bytes,
          downloadProgress: {
            state: 'downloading',
            bytes: progress.bytes,
            totalBytes: progress.totalBytes,
            percent: progress.percent,
            updatedAt: nowIso()
          }
        }, runtime.config);
        if (now - lastProgressBroadcastAt > 450 || progress.percent === 100) {
          lastProgressBroadcastAt = now;
          broadcastState();
        }
      }
    });
    runtime.update = normalizeUpdate({
      ...runtime.update,
      status: installer ? 'ready-to-install' : 'staged',
      stagedPath: result.targetPath,
      downloadedAt: nowIso(),
      downloadedBytes: result.bytes,
      downloadedDigest: result.digest,
      installerOpenError: null,
      downloadProgress: {
        state: 'downloaded',
        bytes: result.bytes,
        totalBytes: result.bytes,
        percent: 100,
        updatedAt: nowIso()
      },
      history: prependUpdateHistory(runtime.update?.history, updateHistoryEntry({
        kind: installer ? 'major-download' : 'hot-download',
        status: 'downloaded',
        version: runtime.update?.latestVersion || artifact.version,
        fromVersion: runtime.update?.currentVersion || currentReleaseVersion(),
        releaseId: runtime.update?.releaseId,
        planId: runtime.update?.planId,
        componentKind: runtime.update?.componentKind || artifact.kind,
        updateMode: runtime.update?.updateMode,
        message: installer ? '大版本安装包已下载并校验。' : '热更新包已下载并校验。'
      })),
      rollbackSlots: installer
        ? rememberRollbackSlot(runtime.update?.rollbackSlots, {
            version: runtime.update?.latestVersion || artifact.version,
            releaseId: runtime.update?.releaseId,
            planId: runtime.update?.planId,
            artifactId: artifact.artifactId,
            artifactKind: artifact.kind,
            path: result.targetPath,
            digest: result.digest,
            sizeBytes: result.bytes,
            platform: artifact.platform,
            downloadedAt: runtime.update?.downloadedAt || nowIso()
          })
        : runtime.update?.rollbackSlots
    }, runtime.config);
    await updater?.report?.({
      installId: runtime.installation?.installId,
      status: installer ? 'installer-downloaded' : 'artifact-staged',
      metadata: releaseReportMetadata(reason, runtime.update, artifact, result)
    }).catch((error) => {
      pushAppLog('appcenter', 'warning', `Release downloaded report failed: ${errorMessage(error)}`);
    });
    if (installer) {
      await openDownloadedInstaller({ updater, reason, artifact, ...result });
    } else {
      let activation = null;
      try {
        activation = await activateStagedHotArtifact(updater, artifact, result.targetPath, runtime.update);
      } catch (activationError) {
        pushAppLog('appcenter', 'warning', `Hot activation failed, artifact stays staged: ${errorMessage(activationError)}`);
      }
      const applied = activation?.activated === true;
      const pendingRestart = /restart|next start/i.test(activation?.deferredReason || '');
      runtime.update = normalizeUpdate({
        ...runtime.update,
        status: applied ? 'applied' : runtime.update.status,
        restartPrompt: silent ? false : runtime.update.restartRequired === true || pendingRestart,
        history: applied
          ? prependUpdateHistory(runtime.update?.history, updateHistoryEntry({
              kind: 'hot-apply',
              status: 'applied',
              version: runtime.update?.latestVersion || artifact.version,
              fromVersion: runtime.update?.currentVersion || currentReleaseVersion(),
              releaseId: runtime.update?.releaseId,
              planId: runtime.update?.planId,
              componentKind: runtime.update?.componentKind || artifact.kind,
              updateMode: runtime.update?.updateMode,
              message: '热更新已自动激活。'
            }))
          : runtime.update?.history
      }, runtime.config);
      if (!silent) {
        runtime.feedback = applied
          ? { tone: 'success', message: '热更新已下载校验并自动激活。' }
          : {
              tone: activation?.deferredReason ? 'info' : 'success',
              message: pendingRestart
                ? '热更新包已下载并校验，将在下次启动时生效。'
                : activation?.deferredReason
                  ? `热更新包已下载并校验，激活已推迟：${activation.deferredReason}。`
                  : '热更新包已下载并校验，等待热更新激活器处理。'
            };
      }
    }
    touchRuntime('update downloaded');
  } catch (error) {
    const message = errorMessage(error);
    runtime.update = normalizeUpdate({
      ...runtime.update,
      status: 'download-failed',
      reason: message,
      downloadProgress: {
        ...(runtime.update?.downloadProgress || {}),
        state: 'failed',
        updatedAt: nowIso()
      },
      history: prependUpdateHistory(runtime.update?.history, updateHistoryEntry({
        kind: installer ? 'major-download' : 'hot-download',
        status: 'failed',
        version: runtime.update?.latestVersion || artifact.version,
        fromVersion: runtime.update?.currentVersion || currentReleaseVersion(),
        releaseId: runtime.update?.releaseId,
        planId: runtime.update?.planId,
        componentKind: runtime.update?.componentKind || artifact.kind,
        updateMode: runtime.update?.updateMode,
        message
      }))
    }, runtime.config);
    runtime.feedback = {
      tone: 'danger',
      message: `更新下载失败：${message}`
    };
    await updater?.report?.({
      installId: runtime.installation?.installId,
      status: 'download-failed',
      error: message,
      metadata: releaseReportMetadata(reason, runtime.update, artifact, { targetPath })
    }).catch((reportError) => {
      pushAppLog('appcenter', 'warning', `Release download-failed report failed: ${errorMessage(reportError)}`);
    });
    touchRuntime('update download failed');
  }
}

function installerPathValidationError(targetPath) {
  if (!targetPath || !fsSync.existsSync(targetPath)) return '安装包文件不存在';
  const extension = path.extname(targetPath).toLowerCase();
  const allowed = process.platform === 'darwin'
    ? ['.dmg', '.pkg']
    : process.platform === 'win32'
      ? ['.exe', '.msi']
      : ['.appimage', '.deb', '.rpm'];
  if (!allowed.includes(extension)) {
    return `安装包文件名无效（需要 ${allowed.join(' / ')}，实际为 ${path.basename(targetPath)}）`;
  }
  return null;
}

async function openDownloadedInstaller(input) {
  let openError = installerPathValidationError(input.targetPath);
  if (!openError) {
    try {
      openError = await shell.openPath(input.targetPath);
    } catch (error) {
      openError = errorMessage(error);
    }
  }
  if (openError) {
    runtime.update = normalizeUpdate({
      ...runtime.update,
      status: 'ready-to-install',
      restartPrompt: false,
      installerOpenError: openError,
      history: prependUpdateHistory(runtime.update?.history, updateHistoryEntry({
        kind: 'major-install',
        status: 'open-failed',
        version: runtime.update?.latestVersion || input.artifact.version,
        fromVersion: runtime.update?.currentVersion || currentReleaseVersion(),
        releaseId: runtime.update?.releaseId,
        planId: runtime.update?.planId,
        componentKind: runtime.update?.componentKind || input.artifact.kind,
        updateMode: runtime.update?.updateMode,
        message: openError
      }))
    }, runtime.config);
    runtime.feedback = {
      tone: 'danger',
      message: `安装包已下载，但打开失败：${openError}。可以打开所在文件夹后手动安装。`
    };
    await input.updater?.report?.({
      installId: runtime.installation?.installId,
      status: 'installer-open-failed',
      error: openError,
      metadata: releaseReportMetadata(input.reason, runtime.update, input.artifact, input)
    }).catch((error) => {
      pushAppLog('appcenter', 'warning', `Release installer-open-failed report failed: ${errorMessage(error)}`);
    });
    touchRuntime('installer open failed');
    return false;
  }
  runtime.update = normalizeUpdate({
    ...runtime.update,
    status: 'installer-opened',
    restartPrompt: true,
    installerOpenError: null,
    history: prependUpdateHistory(runtime.update?.history, updateHistoryEntry({
      kind: 'major-install',
      status: 'installer-opened',
      version: runtime.update?.latestVersion || input.artifact.version,
      fromVersion: runtime.update?.currentVersion || currentReleaseVersion(),
      releaseId: runtime.update?.releaseId,
      planId: runtime.update?.planId,
      componentKind: runtime.update?.componentKind || input.artifact.kind,
      updateMode: runtime.update?.updateMode,
      message: '安装包已打开，等待用户完成系统安装。'
    }))
  }, runtime.config);
  runtime.feedback = {
    tone: 'success',
    message: '安装包已校验并打开。安装完成后可以立即重启 MX-H2I，也可以稍后手动重启。'
  };
  await input.updater?.report?.({
    installId: runtime.installation?.installId,
    status: 'installer-opened',
    metadata: releaseReportMetadata(input.reason, runtime.update, input.artifact, input)
  }).catch((error) => {
    pushAppLog('appcenter', 'warning', `Release installer-opened report failed: ${errorMessage(error)}`);
  });
  touchRuntime('installer opened');
  return true;
}

async function showDownloadedInstaller() {
  const targetPath = nullableString(runtime.update?.stagedPath)
    || normalizeRollbackSlots(runtime.update?.rollbackSlots)[0]?.path
    || null;
  if (!targetPath || !fsSync.existsSync(targetPath)) {
    runtime.feedback = {
      tone: 'warning',
      message: '没有找到已下载的安装包，请先下载版本。'
    };
    return;
  }
  try {
    shell.showItemInFolder(targetPath);
    runtime.feedback = {
      tone: 'info',
      message: `已在文件夹中显示安装包：${path.basename(targetPath)}`
    };
    touchRuntime('installer revealed in folder');
  } catch (error) {
    runtime.feedback = {
      tone: 'danger',
      message: `打开安装包所在文件夹失败：${errorMessage(error)}`
    };
  }
}

// Hot activation goes through the shared update executor: config/renderer
// artifacts swap into update-slots with a previous slot for rollback; npm/asar
// artifacts stage a next-start pointer. Activation defers automatically while
// WireGuard is connecting.
async function activateStagedHotArtifact(updater, artifact, stagedPath, update) {
  const executorMod = await importInstalledPackage('@qpjoy/electron-launcher/release-update-executor');
  const executor = executorMod.createElectronLauncherReleaseUpdateExecutor({
    updater: updater || { async check() { throw new Error('release updater unavailable'); }, async report() { return {}; } },
    baseDir: app.getPath('userData'),
    installId: runtime.installation?.installId,
    networkGate: () => (wireGuardConnectInFlight || runtime.connection?.state === 'connecting' ? 'connecting' : 'idle'),
    applyConfig: (activePath) => {
      pushAppLog('appcenter', 'info', `Hot config snapshot activated: ${activePath}.`);
      broadcastState();
    },
    applyRenderer: (activePath) => {
      pushAppLog('appcenter', 'info', `Renderer bundle activated, reloading window: ${activePath}.`);
      mainWindow?.webContents?.reload();
    }
  });
  try {
    const activation = await executor.activateStaged(artifact, stagedPath, { releaseId: update?.releaseId ?? null });
    await ensureLauncherPackagePendingPointer(artifact, stagedPath, activation?.activePath);
    return activation;
  } catch (error) {
    const healed = await ensureLauncherPackagePendingPointer(artifact, stagedPath, null);
    if (healed) {
      pushAppLog('appcenter', 'warning', `Hot activation self-healed pending pointer after executor error: ${errorMessage(error)}.`);
      return {
        artifactClass: /npm|package/i.test(artifact?.kind || '') ? 'npm-package' : 'asar',
        activated: false,
        deferredReason: artifact?.restartRequired === false ? 'applies on next start' : 'restart required',
        activePath: healed.path
      };
    }
    throw error;
  }
}

async function ensureLauncherPackagePendingPointer(artifact, stagedPath, activePath) {
  if (!/asar|npm|launcher-package|package-dist/i.test(artifact?.kind || '')) return null;
  const componentId = safeLauncherPackageSegment(nullableString(artifact?.componentId) || launcherProductId(), 'componentId').toLowerCase();
  const version = safeLauncherPackageSegment(nullableString(artifact?.version), 'version');
  let candidatePath = nullableString(activePath) || path.join(app.getPath('userData'), 'launcher-packages', componentId, version, path.basename(stagedPath));
  if (!fsSync.existsSync(candidatePath) && fsSync.existsSync(stagedPath)) {
    await copyReleasePackageFile(stagedPath, candidatePath);
  }
  if (!candidatePath || !fsSync.existsSync(candidatePath)) return null;
  const pointer = {
    version,
    path: candidatePath,
    activatedAt: 'next-start'
  };
  const pointerPath = path.join(app.getPath('userData'), 'launcher-packages', `${componentId}.pending.json`);
  await writeJsonFileAtomic(pointerPath, pointer);
  return pointer;
}

async function repairStagedLauncherPackagePointerFromRuntime(reason) {
  const update = runtime?.update || null;
  if (!update || update.status !== 'staged') return null;
  const stagedPath = nullableString(update.stagedPath);
  if (!stagedPath || !fsSync.existsSync(stagedPath)) return null;
  const artifact = releaseArtifactFromUpdate(update);
  if (!/asar|npm|launcher-package|package-dist/i.test(artifact.kind || '')) return null;
  const expectedDigest = normalizeReleaseDigest(update.downloadedDigest || update.artifactDigest);
  if (expectedDigest) {
    const actualDigest = await sha256FileDigest(stagedPath);
    if (actualDigest !== expectedDigest) {
      pushAppLog('appcenter', 'warning', `Skipped staged ${artifact.kind} pointer repair (${reason}): digest mismatch ${actualDigest} != ${expectedDigest}.`);
      return null;
    }
  }
  const pointer = await ensureLauncherPackagePendingPointer(artifact, stagedPath, null);
  if (pointer) {
    pushAppLog('appcenter', 'warning', `Repaired staged ${artifact.kind} pointer (${reason}): ${pointer.version} (${pointer.path}).`);
  }
  return pointer;
}

async function sha256FileDigest(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const input = fsSync.createReadStream(filePath);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', resolve);
  });
  return `sha256:${hash.digest('hex')}`;
}

async function copyReleasePackageFile(sourcePath, targetPath) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  if (!sourcePath.toLowerCase().includes('.asar') && !targetPath.toLowerCase().includes('.asar')) {
    await fs.copyFile(sourcePath, targetPath);
    return;
  }
  await withElectronAsarDisabled(() => fs.copyFile(sourcePath, targetPath));
}

async function withElectronAsarDisabled(operation) {
  const hadNoAsar = Object.prototype.hasOwnProperty.call(process, 'noAsar');
  const previous = process.noAsar;
  process.noAsar = true;
  try {
    return await operation();
  } finally {
    if (hadNoAsar) process.noAsar = previous;
    else delete process.noAsar;
  }
}

function safeLauncherPackageSegment(value, name) {
  const segment = nullableString(value);
  if (!segment || !/^[a-z0-9][a-z0-9._+-]*$/i.test(segment) || segment === '.' || segment === '..') {
    throw new Error(`invalid release artifact ${name}: ${value}`);
  }
  return segment;
}

async function writeJsonFileAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.next`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
}

function releaseArtifactFromUpdate(update) {
  const version = nullableString(update.latestVersion) || currentReleaseVersion();
  const activation = nullableString(update.activation) || (update.majorUpdateRequiresInstaller ? 'installer-manual' : 'hot-auto');
  return {
    artifactId: nullableString(update.artifactId) || `${nullableString(update.releaseId) || 'release'}-${nullableString(update.artifactKind) || 'artifact'}-${version}`,
    kind: nullableString(update.artifactKind) || nullableString(update.componentKind) || 'app-installer',
    componentId: nullableString(update.componentId) || launcherProductId(),
    version,
    source: 'internal-postgres',
    url: nullableString(update.artifactUrl),
    digest: nullableString(update.artifactDigest),
    signature: nullableString(update.artifactSignature),
    sizeBytes: Number.isFinite(update.artifactSizeBytes) ? update.artifactSizeBytes : null,
    platform: nullableString(update.artifactPlatform),
    arch: nullableString(update.artifactArch),
    fileName: nullableString(update.artifactFileName),
    activation,
    autoApply: update.hotUpdateAuto === true,
    restartRequired: update.restartRequired === true,
    requiredAppRestart: update.restartRequired === true || activation === 'installer-manual',
    notes: []
  };
}

async function downloadReleaseArtifactToFileWithProgress(input) {
  const artifact = input.artifact || {};
  const url = nullableString(artifact.url);
  if (!url) throw new Error(`Release artifact ${artifact.artifactId || 'artifact'} has no URL`);
  await fs.mkdir(path.dirname(input.targetPath), { recursive: true });
  const tempPath = `${input.targetPath}.download`;
  await fs.rm(tempPath, { force: true });
  const hash = createHash('sha256');
  const expectedDigest = normalizeReleaseDigest(artifact.digest);
  let bytes = 0;
  try {
    const response = await openReleaseDownloadStream(url, input.maxRedirects ?? 3);
    const headerLength = Number(response.headers?.['content-length']);
    const totalBytes = Number.isFinite(artifact.sizeBytes) && artifact.sizeBytes > 0
      ? artifact.sizeBytes
      : Number.isFinite(headerLength) && headerLength > 0
        ? headerLength
        : null;
    await new Promise((resolve, reject) => {
      const output = fsSync.createWriteStream(tempPath, { flags: 'wx' });
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      response.stream.on('data', (chunk) => {
        bytes += chunk.length;
        hash.update(chunk);
        const percent = totalBytes ? Math.min(100, Math.round((bytes / totalBytes) * 100)) : null;
        input.onProgress?.({ bytes, totalBytes, percent });
      });
      response.stream.on('error', fail);
      output.on('error', fail);
      output.on('finish', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      response.stream.pipe(output);
    });
    const digest = `sha256:${hash.digest('hex')}`;
    if (Number.isFinite(artifact.sizeBytes) && bytes !== artifact.sizeBytes) {
      throw new Error(`Release artifact size mismatch: expected ${artifact.sizeBytes}, got ${bytes}`);
    }
    if (expectedDigest && digest !== expectedDigest) {
      throw new Error(`Release artifact digest mismatch: expected ${expectedDigest}, got ${digest}`);
    }
    await fs.rename(tempPath, input.targetPath);
    input.onProgress?.({ bytes, totalBytes: bytes, percent: 100 });
    return {
      ok: true,
      targetPath: input.targetPath,
      digest,
      expectedDigest,
      bytes
    };
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

function openReleaseDownloadStream(url, redirectsLeft) {
  const parsed = new URL(url);
  const getter = parsed.protocol === 'https:' ? https.get : parsed.protocol === 'http:' ? http.get : null;
  if (!getter) throw new Error(`Unsupported release artifact URL protocol: ${parsed.protocol}`);
  return new Promise((resolve, reject) => {
    const req = getter(parsed, (response) => {
      const status = response.statusCode || 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        if (redirectsLeft <= 0) {
          reject(new Error(`Too many redirects while downloading release artifact: ${url}`));
          return;
        }
        openReleaseDownloadStream(new URL(location, parsed).toString(), redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`Release artifact download failed: HTTP ${status}`));
        return;
      }
      resolve({ stream: response, headers: response.headers });
    });
    req.on('error', reject);
  });
}

function normalizeReleaseDigest(value) {
  const digest = nullableString(value)?.toLowerCase();
  if (!digest) return null;
  return digest.startsWith('sha256:') ? digest : `sha256:${digest}`;
}

function rememberRollbackSlot(existing, slot) {
  const normalizedSlot = normalizeRollbackSlots([{
    id: nullableString(slot.artifactId) || makeRequestId('rollback'),
    ...slot
  }])[0];
  if (!normalizedSlot) return normalizeRollbackSlots(existing);
  return [
    normalizedSlot,
    ...normalizeRollbackSlots(existing).filter((item) => {
      if (normalizedSlot.artifactId && item.artifactId === normalizedSlot.artifactId) return false;
      if (normalizedSlot.releaseId && item.releaseId === normalizedSlot.releaseId) return false;
      return item.path !== normalizedSlot.path;
    })
  ].slice(0, 3);
}

async function openRollbackInstaller(rollbackId) {
  const id = nullableString(rollbackId);
  const slot = normalizeRollbackSlots(runtime.update?.rollbackSlots)
    .find((item) => item.id === id || item.artifactId === id || item.releaseId === id || item.path === id);
  if (!slot?.path) {
    runtime.feedback = {
      tone: 'warning',
      message: '没有找到可回滚的大版本安装包。'
    };
    return;
  }
  if (!fsSync.existsSync(slot.path)) {
    runtime.update = normalizeUpdate({
      ...(runtime.update || {}),
      rollbackSlots: normalizeRollbackSlots(runtime.update?.rollbackSlots).filter((item) => item.path !== slot.path)
    }, runtime.config);
    runtime.feedback = {
      tone: 'warning',
      message: `回滚安装包已不存在：${slot.version || slot.releaseId || 'unknown'}。`
    };
    return;
  }
  const openError = await shell.openPath(slot.path);
  if (openError) {
    runtime.feedback = {
      tone: 'danger',
      message: `打开回滚安装包失败：${openError}`
    };
    return;
  }
  runtime.update = normalizeUpdate({
    ...(runtime.update || {}),
    restartPrompt: true,
    history: prependUpdateHistory(runtime.update?.history, updateHistoryEntry({
      kind: 'rollback',
      status: 'installer-opened',
      version: slot.version,
      releaseId: slot.releaseId,
      planId: slot.planId,
      componentKind: slot.artifactKind,
      message: `已打开 ${slot.version || slot.releaseId || '历史版本'} 回滚安装包。`
    }))
  }, runtime.config);
  runtime.feedback = {
    tone: 'success',
    message: `已打开 ${slot.version || slot.releaseId || '历史版本'} 回滚安装包。完成安装后可以重启 MX-H2I。`
  };
  touchRuntime('rollback installer opened');
}

function updateArtifactTargetPath(update, artifact) {
  const releaseId = safePathSegment(nullableString(update.releaseId) || nullableString(update.planId) || 'release');
  const catalogRelease = normalizeAvailableReleases(update.availableReleases)
    .find((item) => item.releaseId === update.releaseId || item.artifactId === artifact.artifactId || item.version === artifact.version);
  const fileName = safeUpdateArtifactFileName(
    artifact.fileName || catalogRelease?.fileName,
    artifact.url,
    artifact.kind,
    artifact.version,
    artifact.platform
  );
  return path.join(app.getPath('userData'), 'updates', releaseId, fileName);
}

function safeUpdateArtifactFileName(fileName, url, artifactKind, version, platform) {
  const installer = artifactKind === 'app-installer' || artifactKind === 'mx-h2i-installer';
  const declaredName = safePathSegment(nullableString(fileName));
  if (declaredName && !['app', 'download'].includes(declaredName.toLowerCase()) && (!installer || path.extname(declaredName))) {
    return declaredName;
  }
  try {
    const parsed = new URL(url);
    const baseName = safePathSegment(decodeURIComponent(path.basename(parsed.pathname)));
    if (baseName && !['app', 'download'].includes(baseName.toLowerCase()) && (!installer || path.extname(baseName))) {
      return baseName;
    }
  } catch {
    // fallback below
  }
  const targetPlatform = nullableString(platform) || process.platform;
  const extension = installer
    ? targetPlatform === 'darwin' ? 'dmg' : targetPlatform === 'win32' ? 'exe' : 'AppImage'
    : 'bin';
  return `${safePathSegment(artifactKind || 'artifact')}-${safePathSegment(version || currentReleaseVersion())}.${extension}`;
}

function releaseReportMetadata(reason, update, artifact, extra = {}) {
  return {
    reason,
    productId: launcherProductId(),
    planId: nullableString(update.planId),
    releaseId: nullableString(update.releaseId),
    componentId: artifact.componentId,
    componentKind: nullableString(update.componentKind),
    artifactId: artifact.artifactId,
    artifactKind: artifact.kind,
    artifactUrl: artifact.url,
    artifactDigest: artifact.digest,
    artifactPlatform: artifact.platform,
    artifactArch: artifact.arch,
    artifactFileName: artifact.fileName,
    activation: artifact.activation,
    currentVersion: nullableString(update.currentVersion),
    latestVersion: nullableString(update.latestVersion),
    platform: process.platform,
    arch: process.arch,
    ...extra
  };
}

function mergeAppCenterCatalogApps(remoteApps) {
  const next = { ...(runtime.apps || normalizeApps({})) };
  for (const raw of remoteApps) {
    const remote = raw && typeof raw === 'object' ? raw : {};
    const appId = nullableString(remote.appId);
    if (!appId) continue;
    const local = next[appId] || {};
    const installation = normalizeRemoteInstallation(remote.installation);
    const installationStatus = nullableString(installation?.status);
    const installationInstalledVersion = nullableString(installation?.installedVersion);
    const entrypoints = {
      ...(local.entrypoints || {}),
      ...normalizeStringRecord(remote.entrypoints, {})
    };
    const merged = {
      ...remote,
      appId,
      latestVersion: nullableString(installation?.latestVersion) || nullableString(remote.latestVersion) || nullableString(remote.version) || nullableString(local.latestVersion) || nullableString(local.version),
      installSource: nullableString(installation?.installSource) || nullableString(local.installSource) || nullableString(remote.installSource) || (remote.builtin === true ? 'builtin' : 'npm'),
      installPath: nullableString(installation?.installPath) || nullableString(local.installPath) || nullableString(remote.installPath),
      installed: installation ? appInstallationIsInstalled(installation) : local.installed === true,
      enabled: installation ? appInstallationIsEnabled(installation) || local.enabled === true : local.enabled === true,
      installedVersion: installationInstalledVersion || nullableString(local.installedVersion),
      installedAt: nullableString(installation?.installedAt) || nullableString(local.installedAt),
      runtimeState: nullableString(installation?.runtimeState) || nullableString(local.runtimeState) || 'idle',
      status: installationStatus || nullableString(local.status) || (remote.enabled === false ? 'disabled' : 'available'),
      lastAction: nullableString(local.lastAction),
      logs: local.logs || [],
      errorMessage: nullableString(installation?.errorMessage) || nullableString(local.errorMessage),
      // App runtime is client-owned state (H2O subscriptions, active profile,
      // rules, ports, running flag). The catalog record only carries a default
      // template, so a sync must never replace what the user configured
      // locally — that wiped saved/applied subscriptions on every update check.
      runtime: local.runtime && typeof local.runtime === 'object' ? local.runtime : remote.runtime,
      entrypoints
    };
    next[appId] = normalizeApp(merged, defaultAppRecordFor({ ...remote, entrypoints }, appId));
  }
  runtime.apps = next;
}

function appCenterCatalogBaseUrl() {
  return normalizeBaseUrl(runtime?.connection?.internalBaseUrl)
    || normalizeBaseUrl(runtime?.config?.internalApiBaseUrl)
    || normalizeBaseUrl(runtime?.config?.bootstrapApiBaseUrl);
}

function appCenterCatalogHeaders() {
  const token = nullableString(runtime?.auth?.accessToken);
  if (!token) return {};
  const type = nullableString(runtime?.auth?.tokenType) || 'Bearer';
  return { authorization: `${type} ${token}` };
}

function appCenterInstallationIdentity() {
  return {
    installId: nullableString(runtime?.installation?.installId),
    deviceId: nullableString(runtime?.installation?.deviceId)
  };
}

function appCenterCatalogUserId() {
  return parseUserIdFromSubject(runtime?.auth?.subject)
    || nullableString(runtime?.identity?.account)
    || null;
}

async function reportAppCenterInstallation(appRecord, eventName) {
  try {
    const appId = nullableString(appRecord?.appId);
    if (!appId) return { ok: false, message: '缺少 appId' };
    const baseUrl = appCenterCatalogBaseUrl();
    if (!baseUrl) return { ok: false, message: 'Internal API baseUrl 为空' };
    const identity = appCenterInstallationIdentity();
    const status = nullableString(appRecord.status) || (appRecord.enabled ? 'enabled' : appRecord.installed ? 'installed' : 'not-installed');
    const installedVersion = nullableString(appRecord.installedVersion)
      || (appRecordStatusImpliesInstalled(status) ? nullableString(appRecord.version) : null);
    const payload = await requestJson(joinApiUrl(baseUrl, `/internal/v1/app-center/apps/${encodeURIComponent(appId)}/installations`), {
      method: 'POST',
      timeoutMs: 4500,
      headers: appCenterCatalogHeaders(),
      body: {
        appId,
        installId: identity.installId,
        deviceId: identity.deviceId,
        userId: appCenterCatalogUserId(),
        sourceAppId: PRODUCT_ID,
        packageName: nullableString(appRecord.packageName),
        installedVersion,
        latestVersion: nullableString(appRecord.latestVersion) || nullableString(appRecord.version),
        status,
        runtimeState: nullableString(appRecord.runtimeState),
        installSource: nullableString(appRecord.installSource),
        installPath: nullableString(appRecord.installPath),
        manifest: appRecord.manifest && typeof appRecord.manifest === 'object' ? appRecord.manifest : null,
        installedAt: nullableString(appRecord.installedAt),
        errorMessage: nullableString(appRecord.errorMessage),
        metadata: {
          event: eventName,
          launcherMode: nullableString(appRecord.launcherMode),
          standaloneChannelProductId: nullableString(appRecord.standaloneChannelProductId),
          updatePolicy: nullableString(appRecord.updatePolicy)
        },
        requestedBy: 'mx-h2i'
      }
    });
    const installation = normalizeRemoteInstallation(payload?.installation);
    if (installation) {
      applyAppCenterInstallationState(appRecord, installation);
      pushAppLog(appId, 'info', `Installation state synced: ${installation.status || 'unknown'} ${installation.installedVersion || ''}`.trim());
    }
    return { ok: true, message: '', installation };
  } catch (error) {
    const message = errorMessage(error);
    const appId = nullableString(appRecord?.appId);
    if (appId) pushAppLog(appId, 'warning', `Installation state sync failed (${eventName}): ${message}`);
    return { ok: false, message };
  }
}

function normalizeRemoteInstallation(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function applyAppCenterInstallationState(appRecord, installation) {
  if (!appRecord || !installation) return;
  appRecord.latestVersion = nullableString(installation.latestVersion) || appRecord.latestVersion;
  appRecord.installedVersion = nullableString(installation.installedVersion) || appRecord.installedVersion;
  appRecord.installedAt = nullableString(installation.installedAt) || appRecord.installedAt;
  appRecord.installSource = nullableString(installation.installSource) || appRecord.installSource;
  appRecord.installPath = nullableString(installation.installPath) || appRecord.installPath;
  appRecord.runtimeState = nullableString(installation.runtimeState) || appRecord.runtimeState;
  appRecord.status = nullableString(installation.status) || appRecord.status;
  appRecord.installed = appInstallationIsInstalled(installation);
  appRecord.enabled = appInstallationIsEnabled(installation) || appRecord.enabled === true;
  appRecord.errorMessage = nullableString(installation.errorMessage) || (appRecord.status === 'error' ? appRecord.errorMessage : null);
}

function appInstallationIsInstalled(installation) {
  const status = nullableString(installation?.status);
  return appRecordStatusImpliesInstalled(status) || Boolean(nullableString(installation?.installedVersion));
}

function appInstallationIsEnabled(installation) {
  return ['enabled', 'ready', 'running'].includes(nullableString(installation?.status));
}

function appRecordStatusImpliesInstalled(status) {
  return ['installed', 'enabled', 'ready', 'running'].includes(nullableString(status));
}

async function installAppPackage(appRecord) {
  const source = nullableString(appRecord?.installSource) || 'npm';
  const packageName = nullableString(appRecord?.packageName);
  const version = nullableString(appRecord?.latestVersion) || nullableString(appRecord?.version) || '0.1.0';
  if (!packageName) throw new Error('缺少 packageName');
  const bundledRuntime = isBundledAppRuntime(appRecord, packageName);
  if (source === 'builtin' && !bundledRuntime) {
    return {
      installSource: 'builtin',
      installPath: nullableString(appRecord.installPath) || `builtin://${appRecord.appId}`,
      installedVersion: version,
      installedAt: nowIso()
    };
  }
  const workspacePath = await resolveWorkspaceEntrypoint(appRecord);
  if (workspacePath) {
    const packageJson = await readPackageJson(path.join(workspacePath, 'package.json'));
    return {
      installSource: 'workspace',
      installPath: workspacePath,
      installedVersion: nullableString(packageJson.version) || version,
      installedAt: nowIso()
    };
  }
  if (bundledRuntime) {
    return {
      installSource: 'builtin',
      installPath: `builtin://${appRecord.appId}`,
      installedVersion: version,
      installedAt: nowIso()
    };
  }
  // 首选：用 launcher 自己的网络栈拉 tarball 并解到独立 slot。
  // 打包后的客户端不能指望本机有可用的 npm/pnpm（Windows 上 spawn npm 常年失败），
  // 而且这条路径可以做 integrity 校验和原子回滚。npm CLI 只作为最后兜底。
  try {
    const staged = await stagePluginPackage(appRecord, packageName, version);
    return { ...staged, installSource: source };
  } catch (err) {
    pushAppLog(
      appRecord.appId || 'appcenter',
      'warning',
      `插件包直连安装失败，回退到本机包管理器：${errorMessage(err)}`
    );
  }
  const targetDir = path.join(app.getPath('userData'), 'appcenter-cache', safePathSegment(appRecord.appId || packageName));
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(path.join(targetDir, 'package.json'), JSON.stringify({
    private: true,
    dependencies: {
      [packageName]: version
    }
  }, null, 2));
  const packageSpec = `${packageName}@${version}`;
  const packageManager = nullableString(process.env.MX_H2I_APPCENTER_PACKAGE_MANAGER) || 'npm';
  await execPackageManagerInstall(packageManager, targetDir, packageSpec);
  return {
    installSource: source,
    installPath: targetDir,
    installedVersion: version,
    installedAt: nowIso()
  };
}

function appCenterPluginSources() {
  return normalizePluginSources({
    registryUrl: nullableString(process.env.MX_H2I_APPCENTER_REGISTRY)
      || nullableString(runtime?.config?.appCenterRegistryUrl),
    mirrorRegistryUrl: nullableString(process.env.MX_H2I_APPCENTER_REGISTRY_MIRROR)
      || nullableString(runtime?.config?.appCenterRegistryMirrorUrl),
    tarballBaseUrl: nullableString(process.env.MX_H2I_APPCENTER_TARBALL_BASE)
      || nullableString(runtime?.config?.appCenterTarballBaseUrl)
  });
}

/**
 * 按 registry -> mirror -> OSS 顺序尝试，第一个通过完整性校验的来源获胜。
 * 每个版本解到自己的 slot 目录，安装成功后才切换 current 指针，
 * 失败时上一版仍然完整可用。
 */
async function stagePluginPackage(appRecord, packageName, version) {
  const sources = appCenterPluginSources();
  const plan = pluginDownloadPlan({ packageName, version, sources });
  if (!plan.length) throw new Error('没有可用的插件包来源，请检查 AppCenter registry / OSS 配置。');
  const failures = [];
  for (const step of plan) {
    try {
      const resolved = await resolvePluginTarball(step, packageName, version);
      const tarball = await requestBuffer(resolved.tarballUrl, { timeoutMs: 60_000 });
      const verified = verifyTarballIntegrity(tarball, resolved);
      if (!verified.ok) throw new Error(`完整性校验失败（${verified.reason}）`);
      const installPath = await writePluginSlot(appRecord, packageName, resolved.version, tarball);
      pushAppLog(
        appRecord.appId || 'appcenter',
        'info',
        `插件包已从 ${step.sourceId} 安装：${packageName}@${resolved.version}（${verified.algorithm} 校验通过）`
      );
      return { installPath, installedVersion: resolved.version, installedAt: nowIso() };
    } catch (err) {
      failures.push(`${step.sourceId}: ${errorMessage(err)}`);
    }
  }
  throw new Error(failures.join('；'));
}

async function resolvePluginTarball(step, packageName, version) {
  if (step.kind === 'tarball') {
    // OSS 直链没有 packument，integrity 由 Release Center 的 sidecar 提供。
    const meta = await requestJson(`${step.tarballUrl}.json`, { timeoutMs: 15_000 }).catch(() => null);
    return {
      version: nullableString(meta?.version) || version,
      tarballUrl: step.tarballUrl,
      integrity: nullableString(meta?.integrity),
      shasum: nullableString(meta?.shasum)
    };
  }
  const packument = await requestJson(step.packumentUrl, { timeoutMs: 20_000 });
  const selected = selectPackumentVersion(packument, version);
  if (!selected?.tarball) throw new Error(`registry 没有返回 ${packageName}@${version} 的 tarball`);
  return {
    version: selected.version,
    tarballUrl: rewriteTarballToSource(step.source, selected.tarball),
    integrity: selected.integrity,
    shasum: selected.shasum
  };
}

async function writePluginSlot(appRecord, packageName, version, tarball) {
  const entries = extractNpmTarball(tarball);
  if (!entries.some((entry) => entry.path === 'package.json')) {
    throw new Error('tarball 里没有 package.json，不是有效的 npm 包');
  }
  const root = path.join(app.getPath('userData'), 'appcenter-plugins', safePathSegment(appRecord.appId || packageName));
  const slot = path.join(root, `v${safePathSegment(version)}`);
  const staging = `${slot}.staging`;
  await fs.rm(staging, { recursive: true, force: true });
  for (const entry of entries) {
    const target = path.join(staging, entry.path);
    // extractNpmTarball 已经挡了 `..` 和绝对路径，这里再确认一次落点在 slot 内。
    if (!target.startsWith(`${staging}${path.sep}`)) throw new Error(`tarball 条目越界：${entry.path}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, entry.content, { mode: entry.mode & 0o777 });
  }
  await fs.rm(slot, { recursive: true, force: true });
  await fs.rename(staging, slot);
  await pruneOldPluginSlots(root, path.basename(slot));
  return slot;
}

/** 只保留当前版本和上一版，回滚够用，又不会让缓存无限长大。 */
async function pruneOldPluginSlots(root, keepName) {
  const rows = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const slots = rows
    .filter((row) => row.isDirectory() && row.name.startsWith('v') && row.name !== keepName)
    .map((row) => row.name)
    .sort();
  for (const name of slots.slice(0, Math.max(0, slots.length - 1))) {
    await fs.rm(path.join(root, name), { recursive: true, force: true }).catch(() => {});
  }
}

async function resolveWorkspaceEntrypoint(appRecord) {
  const devEntrypoint = nullableString(appRecord?.entrypoints?.dev);
  if (!devEntrypoint?.startsWith('workspace:')) return null;
  const workspaceRelative = devEntrypoint.slice('workspace:'.length).trim();
  if (!workspaceRelative) return null;
  const demoRelative = path.resolve(__dirname, '..', '..', workspaceRelative.replace(/^demos\//, ''));
  const rootRelative = path.resolve(__dirname, '..', '..', '..', workspaceRelative);
  for (const candidate of [demoRelative, rootRelative]) {
    try {
      const stat = await fs.stat(path.join(candidate, 'package.json'));
      if (stat.isFile()) return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

async function readPackageJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function execPackageManagerInstall(packageManager, cwd, packageSpec) {
  const command = packageManager === 'pnpm' ? 'pnpm' : 'npm';
  const args = command === 'pnpm'
    ? ['add', packageSpec, '--prod']
    : ['install', packageSpec, '--omit=dev', '--no-audit', '--no-fund'];
  const invocation = packageManagerInvocation(command, args);
  return new Promise((resolve, reject) => {
    execFile(invocation.command, invocation.args, {
      cwd,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      env: strippedInstallEnv()
    }, (err, stdout, stderr) => {
      if (err) {
        const output = String(stderr || stdout || err.message).split(/\r?\n/).slice(-8).join('\n');
        const packageManagerMissing = err.code === 'ENOENT'
          || /(?:not recognized as an internal or external command|不是内部或外部命令)/i.test(output);
        reject(new Error(packageManagerMissing
          ? `未找到 ${command}${process.platform === 'win32' ? '.cmd' : ''}。请安装 Node.js/${command} 并确认其已加入 PATH；MX-H2I 内置应用不应依赖系统 npm。`
          : output));
        return;
      }
      resolve();
    });
  });
}

function isBundledAppRuntime(appRecord, packageName) {
  return nullableString(appRecord?.appId) === 'h2o'
    && packageName === '@qpjoy/electron-launcher-app-h2o';
}

function packageManagerInvocation(command, args) {
  if (process.platform !== 'win32') return { command, args };
  return {
    command: windowsSystemCommand('cmd.exe'),
    args: ['/d', '/s', '/c', `${command}.cmd`, ...args]
  };
}

function strippedInstallEnv() {
  const next = { ...process.env };
  delete next.ELECTRON_RUN_AS_NODE;
  delete next.ELECTRON_NO_ATTACH_CONSOLE;
  delete next.NODE_OPTIONS;
  delete next.npm_config_node_options;
  delete next.NPM_CONFIG_NODE_OPTIONS;
  return next;
}

function safePathSegment(value) {
  return String(value || 'app').trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'app';
}

function normalizeUpdate(input, config) {
  const row = input && typeof input === 'object' ? input : {};
  return {
    status: stringValue(row.status, 'idle'),
    currentVersion: currentReleaseVersion(),
    latestVersion: stringValue(row.latestVersion, currentReleaseVersion()),
    policy: stringValue(row.policy, 'launcher-managed'),
    channel: config.releaseChannel,
    rolloutGroup: config.rolloutGroup,
    updateAvailable: row.updateAvailable === true,
    canSkip: row.canSkip === true,
    lastCheckedAt: typeof row.lastCheckedAt === 'string' ? row.lastCheckedAt : null,
    planId: nullableString(row.planId),
    releaseId: nullableString(row.releaseId),
    componentId: nullableString(row.componentId),
    componentKind: nullableString(row.componentKind),
    updateMode: nullableString(row.updateMode),
    reason: nullableString(row.reason),
    artifactKind: nullableString(row.artifactKind),
    artifactId: nullableString(row.artifactId),
    artifactUrl: nullableString(row.artifactUrl),
    artifactDigest: nullableString(row.artifactDigest),
    artifactSignature: nullableString(row.artifactSignature),
    artifactSizeBytes: Number.isFinite(row.artifactSizeBytes) ? row.artifactSizeBytes : null,
    artifactPlatform: nullableString(row.artifactPlatform),
    artifactArch: nullableString(row.artifactArch),
    artifactFileName: nullableString(row.artifactFileName),
    activation: nullableString(row.activation),
    restartRequired: row.restartRequired === true,
    majorUpdateRequiresInstaller: row.majorUpdateRequiresInstaller === true,
    hotUpdateAuto: row.hotUpdateAuto === true,
    deliveryMode: normalizeReleaseDeliveryMode(row.deliveryMode),
    stagedPath: nullableString(row.stagedPath),
    downloadedAt: nullableString(row.downloadedAt),
    downloadedBytes: Number.isFinite(row.downloadedBytes) ? row.downloadedBytes : null,
    downloadedDigest: nullableString(row.downloadedDigest),
    installerOpenError: nullableString(row.installerOpenError),
    downloadProgress: normalizeUpdateDownloadProgress(row.downloadProgress),
    history: normalizeUpdateHistory(row.history),
    availableReleases: normalizeAvailableReleases(row.availableReleases),
    rollbackSlots: normalizeRollbackSlots(row.rollbackSlots),
    restartPrompt: row.restartPrompt === true,
    releaseNotes: nullableString(row.releaseNotes),
    rolloutMatchedBy: nullableString(row.rolloutMatchedBy),
    rolloutBucket: Number.isFinite(row.rolloutBucket) ? row.rolloutBucket : null,
    featureFlags: Array.isArray(row.featureFlags) ? row.featureFlags.filter((key) => typeof key === 'string' && key) : []
  };
}

function normalizeUpdateDownloadProgress(input) {
  const row = input && typeof input === 'object' ? input : null;
  if (!row) return null;
  const bytes = Number(row.bytes);
  const totalBytes = Number(row.totalBytes);
  const percent = Number(row.percent);
  return {
    state: nullableString(row.state) || 'idle',
    bytes: Number.isFinite(bytes) ? bytes : 0,
    totalBytes: Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : null,
    percent: Number.isFinite(percent) ? clamp(percent, 0, 100) : null,
    updatedAt: nullableString(row.updatedAt) || nowIso()
  };
}

function normalizeUpdateHistory(input) {
  return arrayValue(input, [])
    .map((item) => {
      const row = item && typeof item === 'object' ? item : {};
      return {
        id: nullableString(row.id) || makeRequestId('update-history'),
        kind: nullableString(row.kind) || 'check',
        status: nullableString(row.status) || 'unknown',
        version: nullableString(row.version),
        fromVersion: nullableString(row.fromVersion),
        releaseId: nullableString(row.releaseId),
        planId: nullableString(row.planId),
        componentKind: nullableString(row.componentKind),
        updateMode: nullableString(row.updateMode),
        message: nullableString(row.message),
        at: nullableString(row.at) || nowIso()
      };
    })
    .filter((item) => item.version || item.releaseId || item.message)
    .slice(0, 12);
}

function normalizeAvailableReleases(input) {
  return arrayValue(input, [])
    .map((item) => {
      const row = item && typeof item === 'object' ? item : {};
      const sizeBytes = Number(row.sizeBytes);
      return {
        id: nullableString(row.id) || nullableString(row.planId) || makeRequestId('release'),
        releaseId: nullableString(row.releaseId),
        planId: nullableString(row.planId),
        version: nullableString(row.version),
        channel: nullableString(row.channel),
        status: nullableString(row.status) || 'unknown',
        componentKind: nullableString(row.componentKind),
        updateMode: nullableString(row.updateMode),
        artifactKind: nullableString(row.artifactKind),
        activation: nullableString(row.activation),
        sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
        platform: nullableString(row.platform),
        arch: nullableString(row.arch),
        fileName: nullableString(row.fileName),
        artifactId: nullableString(row.artifactId),
        artifactUrl: nullableString(row.artifactUrl),
        artifactDigest: nullableString(row.artifactDigest),
        artifactSignature: nullableString(row.artifactSignature),
        deliveryMode: normalizeReleaseDeliveryMode(row.deliveryMode),
        restartRequired: row.restartRequired === true,
        createdAt: nullableString(row.createdAt),
        gate: nullableString(row.gate)
      };
    })
    .filter((item) => item.version || item.releaseId)
    .slice(0, 8);
}

function normalizeRollbackSlots(input) {
  return arrayValue(input, [])
    .map((item) => {
      const row = item && typeof item === 'object' ? item : {};
      const sizeBytes = Number(row.sizeBytes);
      return {
        id: nullableString(row.id) || nullableString(row.artifactId) || makeRequestId('rollback'),
        version: nullableString(row.version),
        releaseId: nullableString(row.releaseId),
        planId: nullableString(row.planId),
        artifactId: nullableString(row.artifactId),
        artifactKind: nullableString(row.artifactKind),
        path: nullableString(row.path),
        digest: nullableString(row.digest),
        sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
        platform: nullableString(row.platform),
        downloadedAt: nullableString(row.downloadedAt) || nowIso()
      };
    })
    .filter((item) => item.path)
    .slice(0, 3);
}

async function launcherContract(config) {
  const productId = normalizeLauncherProductId(config.productId);
  const displayName = stringValue(config.productDisplayName, displayNameForLauncherProductId(productId));
  const fallback = {
    packageName: '@qpjoy/electron-launcher',
    available: false,
    product: {
      productId,
      displayName,
      mode: 'standalone'
    },
    foundation: foundationContract(),
    createOptions: launcherCreateOptions(config),
    embedDefaults: embedDefaults()
  };
  try {
    const mod = await importInstalledPackage('@qpjoy/electron-launcher');
    const product = mod.defineLauncherProduct({
      productId,
      displayName,
      mode: 'standalone',
      appCenter: {
        visible: true,
        category: productId === PRODUCT_ID ? 'vpn' : 'custom'
      },
      release: {
        componentId: productId,
        channel: config.releaseChannel,
        rolloutGroup: config.rolloutGroup
      },
      launcherActions: {
        network: true,
        release: true,
        update: true,
        rollout: true,
        appCenter: true
      }
    });
    return {
      packageName: mod.ELECTRON_LAUNCHER_PACKAGE_NAME || fallback.packageName,
      available: true,
      product,
      foundation: foundationContract(),
      createOptions: launcherCreateOptions(config),
      embedDefaults: embedDefaults()
    };
  } catch (err) {
    return {
      ...fallback,
      error: err && err.message ? err.message : String(err)
    };
  }
}

function launcherCreateOptions(config) {
  const productId = normalizeLauncherProductId(config.productId);
  return {
    baseUrl: config.bootstrapApiBaseUrl || config.internalApiBaseUrl,
    productId,
    mode: 'standalone',
    deviceLabel: `${stringValue(config.productDisplayName, displayNameForLauncherProductId(productId))} Desktop`
  };
}

function embedDefaults() {
  return [
    {
      productId: 'appcenter',
      mode: 'embed',
      standaloneChannelProductId: 'mx-h2i',
      hostVersionRange: '^0.1.0',
      peerLease: 'shared'
    },
    {
      productId: 'h2o',
      mode: 'embed',
      standaloneChannelProductId: 'mx-h2i',
      hostVersionRange: '^0.1.0',
      peerLease: 'shared'
    }
  ];
}

// Standalone owner 列表来自 Internal 的 launcher app registry（每个 standalone
// 产品由 admin 注册并分到 10.88.100.x 的 service VIP），不是本机常量。
// 早期版本在这里写死了 luopan=10.88.110.1/reserved，和注册表对不上。
const FOUNDATION_OWNER_FALLBACKS = [
  { productId: PRODUCT_ID, displayName: 'MX-H2I', serviceVip: '10.88.100.1' },
  { productId: 'luopan', displayName: 'Luopan', serviceVip: '10.88.100.3' }
];

function foundationContract() {
  const apps = runtime?.apps && typeof runtime.apps === 'object' ? runtime.apps : {};
  const owners = new Map();
  for (const fallback of FOUNDATION_OWNER_FALLBACKS) {
    owners.set(fallback.productId, { ...fallback, state: foundationOwnerState(fallback.productId, null) });
  }
  for (const app of Object.values(apps)) {
    if (!app || app.launcherMode !== 'standalone') continue;
    const productId = nullableString(app.productNetworkId) || nullableString(app.appId);
    if (!productId) continue;
    const previous = owners.get(productId);
    owners.set(productId, {
      productId,
      displayName: nullableString(app.displayName) || previous?.displayName || productId,
      state: foundationOwnerState(productId, app),
      serviceVip: nullableString(app.serviceVip) || previous?.serviceVip || null
    });
  }
  return {
    runtimeName: 'Launcher Foundation',
    socketNamespace: '~/.qpjoy/mx-launcher/sockets/{standaloneChannelProductId}.sock',
    sharedCapabilities: ['auth', 'permission', 'release', 'network', 'observability'],
    standaloneOwners: [...owners.values()]
  };
}

/**
 * 只有本机正在持有 standalone channel 的产品才是 active；其它已注册产品是
 * `registered`（admin 已分配 VIP，本机没跑），未注册的才是 `reserved`。
 */
function foundationOwnerState(productId, app) {
  if (productId === normalizeLauncherProductId(runtime?.config?.productId)) {
    return runtime?.connection?.state === 'connected' ? 'active' : 'idle';
  }
  if (app) return app.installed === true ? 'installed' : 'registered';
  return 'registered';
}

function idleConnection() {
  return {
    state: 'idle',
    mode: 'guest',
    localIp: null,
    routePolicy: 'none',
    subject: null,
    connectedAt: null,
    leaseId: null,
    leaseCapability: null,
    snapshotId: null,
    productId: null,
    serviceVip: null,
    internalBaseUrl: null,
    internalControlIp: null,
    domesticRelayEndpoint: null,
    publicKey: null,
    allowedIps: [],
    routeCidrs: [],
    routePlan: null,
    wireGuard: null,
    domesticPeerSync: null,
    diagnostics: null,
    health: idleHealth()
  };
}

async function probeConnectedModeBeforeTransition(mode, reason, options = {}) {
  const connection = runtime?.connection;
  const probeable = connection?.mode === mode
    && (
      connection?.state === 'connected'
      || (
        options.allowRecoverableState === true
        && shouldRecoverWireGuardConnection(connection)
      )
    );
  if (!probeable) {
    return { ready: false, superseded: true, result: null };
  }
  const routePlan = normalizeRoutePlan(connection.routePlan);
  const result = routePlan
    ? await probeWireGuardForConnection({
        connection,
        routePlan,
        internalBaseUrl: connection.internalBaseUrl
      })
    : wireGuardFailure('launcher routePlan 缺失。');
  const current = runtime?.connection;
  if (!sameConnectionTransitionIdentity(current, connection)) {
    return { ready: false, superseded: true, result };
  }
  const systemDomainProxy = result.ready
    ? await ensureSystemDomainProxyForRuntime('manual-connect-guard')
    : null;
  const ready = result.ready && systemDomainProxyConnectionReady(systemDomainProxy);
  runtime.connection = {
    ...current,
    state: ready ? result.state : result.ready ? 'tunnel-only' : result.state,
    health: result.ready && !ready
      ? { ...result.health, splitDns: 'blocked' }
      : result.health,
    wireGuard: result.wireGuard,
    diagnostics: {
      ...(current.diagnostics || {}),
      ...(result.diagnostics || {}),
      ...(systemDomainProxy ? { systemDomainProxy } : {}),
      connectGuard: {
        ok: ready,
        mode,
        reason,
        message: ready
          ? result.message
          : result.ready
            ? systemDomainProxy?.browserAccess?.error || systemDomainProxy?.error || 'Windows browser path is not ready.'
            : result.message,
        updatedAt: nowIso()
      },
      updatedAt: nowIso()
    }
  };
  queueDiagnosticLog(
    ready ? 'info' : 'warning',
    'connection.pre-connect-guard',
    ready
      ? `${mode} connection is still ready; preserving it.`
      : `${mode} persisted connection is not ready; allowing a fresh connection.`,
    {
      mode,
      reason,
      state: result.state,
      wireGuardActive: result.wireGuard?.active === true,
      routeReady: result.diagnostics?.route?.ok === true,
      internalApiReady: result.diagnostics?.internalApi?.ok === true,
      splitDnsReady: result.health?.splitDns === 'ready',
      browserReady: systemDomainProxy?.browserAccess?.ready === true,
      windowsNrpt: result.diagnostics?.windowsNrpt || null,
      message: result.message
    }
  );
  return { ready, superseded: false, result, systemDomainProxy };
}

function sameConnectionTransitionIdentity(left, right) {
  if (!left || !right) return left === right;
  return left.mode === right.mode
    && left.state === right.state
    && nullableString(left.leaseId) === nullableString(right.leaseId)
    && nullableString(left.snapshotId) === nullableString(right.snapshotId)
    && nullableString(left.localIp) === nullableString(right.localIp)
    && nullableString(left.connectedAt) === nullableString(right.connectedAt);
}

function shouldAttemptRetainedWireGuardPreBootstrap(connection) {
  if (!shouldRecoverWireGuardConnection(connection)) return false;
  if (connection?.wireGuard?.active === true) return true;
  return connectionHasReadyNetworkProof(connection);
}

function connectionHasReadyNetworkProof(connection) {
  return connection?.state === 'connected'
    && connectionHasReadyDataPlaneProof(connection);
}

function connectionHasReadyDataPlaneProof(connection) {
  return connectionHasReadyOverlayProof(connection)
    && connection?.health?.splitDns === 'ready'
    && systemDomainProxyConnectionReady(connection?.diagnostics?.systemDomainProxy);
}

function connectionHasReadyOverlayProof(connection) {
  return connectionHasReadyOverlayTransportProof(connection)
    && standaloneOwnershipReady(connection);
}

function connectionHasReadyOverlayTransportProof(connection) {
  return connection?.health?.wireGuard === 'ready'
    && connection?.wireGuard?.active === true
    && connection?.diagnostics?.route?.ok === true
    && connection?.diagnostics?.internalApi?.ok === true;
}

function idleHealth() {
  return {
    wireGuard: 'idle',
    domesticRelay: 'idle',
    internalApi: 'idle',
    splitDns: 'idle',
    appBroker: 'idle'
  };
}

function leasedHealth() {
  return {
    wireGuard: 'lease',
    domesticRelay: 'pending',
    internalApi: 'pending',
    splitDns: 'pending',
    appBroker: 'ready'
  };
}

function readyHealth() {
  return {
    wireGuard: 'ready',
    domesticRelay: 'ready',
    internalApi: 'ready',
    splitDns: 'ready',
    appBroker: 'ready'
  };
}

function blockedHealth() {
  return {
    wireGuard: 'blocked',
    domesticRelay: 'pending',
    internalApi: 'blocked',
    splitDns: 'pending',
    appBroker: 'ready'
  };
}

function normalizeHealth(input, fallback) {
  const row = input && typeof input === 'object' ? input : {};
  return {
    wireGuard: stringValue(row.wireGuard, fallback.wireGuard),
    domesticRelay: stringValue(row.domesticRelay, fallback.domesticRelay),
    internalApi: stringValue(row.internalApi, fallback.internalApi),
    splitDns: stringValue(row.splitDns, fallback.splitDns),
    appBroker: stringValue(row.appBroker, fallback.appBroker)
  };
}

function normalizeWireGuardSummary(input) {
  const row = input && typeof input === 'object' ? input : null;
  if (!row) return null;
  return {
    ok: row.ok === true,
    active: row.active === true,
    mode: nullableString(row.mode),
    interfaceName: nullableString(row.interfaceName),
    realInterfaceName: nullableString(row.realInterfaceName),
    configPath: nullableString(row.configPath),
    endpoint: nullableString(row.endpoint),
    path: nullableString(row.path),
    allowedIps: arrayValue(row.allowedIps, []),
    statusError: nullableString(row.statusError),
    serviceState: nullableString(row.serviceState),
    launchDaemon: normalizeWireGuardLaunchDaemon(row.launchDaemon),
    routeLogPath: nullableString(row.routeLogPath),
    routeLogTail: tailText(nullableString(row.routeLogTail), 1600),
    peers: Array.isArray(row.peers) ? row.peers : [],
    routes: Array.isArray(row.routes) ? row.routes : [],
    message: nullableString(row.message),
    error: nullableString(row.error),
    updatedAt: nullableString(row.updatedAt) || nowIso()
  };
}

function normalizeWireGuardLaunchDaemon(input) {
  const row = input && typeof input === 'object' ? input : null;
  if (!row) return null;
  return {
    ok: row.ok === true,
    supported: row.supported === true,
    installed: row.installed === true,
    loaded: row.loaded === true,
    running: row.running === true,
    label: nullableString(row.label),
    plistPath: nullableString(row.plistPath),
    supportDir: nullableString(row.supportDir),
    daemonScriptPath: nullableString(row.daemonScriptPath),
    message: nullableString(row.message),
    error: nullableString(row.error)
  };
}

function normalizeDomesticPeerSync(input) {
  const row = input && typeof input === 'object' ? input : null;
  if (!row) return null;
  const lease = row.lease && typeof row.lease === 'object' ? row.lease : null;
  const domesticRelay = row.domesticRelay && typeof row.domesticRelay === 'object' ? row.domesticRelay : null;
  const result = row.result && typeof row.result === 'object' ? row.result : null;
  return {
    status: nullableString(row.status) || 'unknown',
    execution: nullableString(row.execution),
    checkedAt: nullableString(row.checkedAt),
    failures: arrayValue(row.failures, []),
    error: nullableString(row.error),
    lease: lease ? {
      leaseId: nullableString(lease.leaseId),
      leaseIp: nullableString(lease.leaseIp),
      allowedIp: nullableString(lease.allowedIp),
      domesticSiteId: nullableString(lease.domesticSiteId)
    } : null,
    domesticRelay: domesticRelay ? {
      siteId: nullableString(domesticRelay.siteId),
      planId: nullableString(domesticRelay.planId),
      planStatus: nullableString(domesticRelay.planStatus),
      host: nullableString(domesticRelay.host),
      profileId: nullableString(domesticRelay.profileId),
      interfaceName: nullableString(domesticRelay.interfaceName),
      gatewayIp: nullableString(domesticRelay.gatewayIp)
    } : null,
    result: result ? {
      exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
      stdout: tailText(nullableString(result.stdout), 1600),
      stderr: tailText(nullableString(result.stderr), 1600)
    } : null
  };
}

function normalizeInternalDirectPeerSync(input) {
  const row = input && typeof input === 'object' ? input : null;
  if (!row) return null;
  const lease = row.lease && typeof row.lease === 'object' ? row.lease : null;
  const internalDirect = row.internalDirect && typeof row.internalDirect === 'object' ? row.internalDirect : null;
  const result = row.result && typeof row.result === 'object' ? row.result : null;
  return {
    status: nullableString(row.status) || 'unknown',
    execution: nullableString(row.execution),
    checkedAt: nullableString(row.checkedAt),
    message: nullableString(row.message),
    failures: arrayValue(row.failures, []),
    error: nullableString(row.error),
    lease: lease ? {
      leaseId: nullableString(lease.leaseId),
      leaseIp: nullableString(lease.leaseIp),
      allowedIp: nullableString(lease.allowedIp)
    } : null,
    internalDirect: internalDirect ? {
      siteId: nullableString(internalDirect.siteId),
      enabled: internalDirect.enabled === true,
      endpoint: nullableString(internalDirect.endpoint),
      listenPort: typeof internalDirect.listenPort === 'number' ? internalDirect.listenPort : null,
      internalServiceIp: nullableString(internalDirect.internalServiceIp),
      publicKeyStatus: nullableString(internalDirect.publicKeyStatus)
    } : null,
    result: result ? {
      status: nullableString(result.status),
      execution: nullableString(result.execution),
      changed: result.changed === true,
      configPath: nullableString(result.configPath),
      stderr: tailText(nullableString(result.stderr), 1600),
      stdout: tailText(nullableString(result.stdout), 1600)
    } : null
  };
}

function normalizeDiagnostics(input) {
  const row = input && typeof input === 'object' ? input : null;
  if (!row) return null;
  return {
    route: row.route && typeof row.route === 'object' ? {
      ok: row.route.ok === true,
      targetIp: nullableString(row.route.targetIp),
      interfaceName: nullableString(row.route.interfaceName),
      gateway: nullableString(row.route.gateway),
      viaLoopback: row.route.viaLoopback === true,
      expectedInterfaceName: nullableString(row.route.expectedInterfaceName),
      error: nullableString(row.route.error)
    } : null,
    endpointRoute: row.endpointRoute && typeof row.endpointRoute === 'object' ? {
      ok: row.endpointRoute.ok === true,
      endpoint: nullableString(row.endpointRoute.endpoint),
      host: nullableString(row.endpointRoute.host),
      interfaceName: nullableString(row.endpointRoute.interfaceName),
      gateway: nullableString(row.endpointRoute.gateway),
      viaProxyTun: row.endpointRoute.viaProxyTun === true,
      error: nullableString(row.endpointRoute.error)
    } : null,
    internalApi: row.internalApi && typeof row.internalApi === 'object' ? {
      ok: row.internalApi.ok === true,
      baseUrl: nullableString(row.internalApi.baseUrl),
      error: nullableString(row.internalApi.error)
    } : null,
    internalDirectPeerSync: normalizeInternalDirectPeerSync(row.internalDirectPeerSync),
    domesticPeerSync: normalizeDomesticPeerSync(row.domesticPeerSync),
    domesticRelayDiagnostics: row.domesticRelayDiagnostics && typeof row.domesticRelayDiagnostics === 'object'
      ? row.domesticRelayDiagnostics
      : null,
    systemDomainProxy: row.systemDomainProxy && typeof row.systemDomainProxy === 'object'
      ? invalidatePersistedDarwinSplitDnsProof(row.systemDomainProxy, process.platform)
      : null,
    standaloneOwnership: row.standaloneOwnership && typeof row.standaloneOwnership === 'object'
      ? row.standaloneOwnership
      : null,
    networkEnvironment: row.networkEnvironment && typeof row.networkEnvironment === 'object'
      ? row.networkEnvironment
      : null,
    networkRepair: row.networkRepair && typeof row.networkRepair === 'object'
      ? row.networkRepair
      : null,
    transitionTiming: row.transitionTiming && typeof row.transitionTiming === 'object'
      ? row.transitionTiming
      : null,
    startupCleanup: row.startupCleanup && typeof row.startupCleanup === 'object'
      ? row.startupCleanup
      : null,
    disconnectCleanup: row.disconnectCleanup && typeof row.disconnectCleanup === 'object'
      ? row.disconnectCleanup
      : null,
    shutdownCleanup: row.shutdownCleanup && typeof row.shutdownCleanup === 'object'
      ? row.shutdownCleanup
      : null,
    localPersistence: row.localPersistence && typeof row.localPersistence === 'object' ? {
      ok: row.localPersistence.ok === true,
      label: nullableString(row.localPersistence.label),
      message: nullableString(row.localPersistence.message),
      updatedAt: nullableString(row.localPersistence.updatedAt)
    } : null,
    updatedAt: nullableString(row.updatedAt) || nowIso()
  };
}

function connectedState(input) {
  return {
    state: input.state || 'connected',
    mode: input.mode,
    localIp: input.localIp,
    routePolicy: input.routePolicy,
    subject: input.subject,
    connectedAt: input.connectedAt || nowIso(),
    leaseId: input.leaseId || null,
    leaseCapability: nullableString(input.leaseCapability),
    snapshotId: input.snapshotId || null,
    productId: input.productId || launcherProductId(),
    serviceVip: input.serviceVip || null,
    internalBaseUrl: input.internalBaseUrl || null,
    internalControlIp: input.internalControlIp || null,
    domesticRelayEndpoint: input.domesticRelayEndpoint || null,
    publicKey: input.publicKey || null,
    allowedIps: arrayValue(input.allowedIps, []),
    routeCidrs: arrayValue(input.routeCidrs, []),
    routePlan: normalizeRoutePlan(input.routePlan),
    wireGuard: normalizeWireGuardSummary(input.wireGuard),
    domesticPeerSync: normalizeDomesticPeerSync(input.domesticPeerSync),
    diagnostics: normalizeDiagnostics(input.diagnostics),
    health: normalizeHealth(input.health, leasedHealth())
  };
}

function setConnecting(mode, options = {}) {
  const previous = retainableConnectionSnapshot(runtime.connection);
  const employeeLabel = options.provider === 'feishu' ? '飞书员工身份' : '员工账号';
  runtime.connection = {
    ...(previous || idleConnection()),
    state: 'connecting',
    mode,
    retainedMode: previous?.mode || null
  };
  runtime.feedback = {
    tone: 'info',
    message: mode === 'employee'
      ? options.replacingGuest
        ? options.provider === 'feishu'
          ? '飞书身份已验证，正在开始系统网络切换；当前访客通道将被替换。'
          : '正在验证员工账号；认证失败或取消时保留访客连接，验证通过后开始系统网络切换。'
        : `正在使用${employeeLabel}刷新员工 lease。`
      : '正在申请游客 relay lease。'
  };
  touchRuntime(mode === 'employee' ? 'employee connecting' : 'guest connecting');
}

async function connectLauncherNetwork(input) {
  await ensureCredentialStorageRecoveryReady();
  const context = await launcherContext();
  await assertLiveSecureLauncherCapabilityTransport(context.bootstrap, 'lease capability 传输');
  const requestTag = stringValue(input.requestTag, 'connect');
  const newLeaseCapability = ensurePendingLeaseCapability(input);
  await saveRuntime(runtime);
  const session = await context.launcher.connectNetwork({
    identityKind: input.identityKind,
    userId: input.userId || undefined,
    leaseProfile: input.leaseProfile || undefined,
    accessToken: input.accessToken || undefined,
    leaseCapability: leaseCapabilitiesForEnrollment(input),
    newLeaseCapability,
    installId: context.installation.installId,
    deviceId: context.installation.deviceId,
    siteId: context.installation.siteId,
    keyPair: context.installation.keyPair,
    privateKey: context.installation.keyPair.privateKey,
    publicKey: context.installation.keyPair.publicKey,
    deviceLabel: context.installation.deviceLabel,
    platform: process.platform,
    deviceModel: context.installation.deviceModel,
    osVersion: context.installation.osVersion,
    appVersion: currentReleaseVersion(),
    requestedBy: REQUESTED_BY,
    requestId: makeRequestId(requestTag)
  });
  return {
    ...session,
    bootstrapResolution: context.bootstrap
  };
}

async function connectLauncherNetworkWithLocalIdentityRepair(input, options = {}) {
  try {
    return await connectLauncherNetwork(input);
  } catch (err) {
    if (!isLauncherPublicKeyConflictError(err)) throw err;
    const previousRuntime = {
      installation: runtime.installation,
      leaseCapabilities: runtime.leaseCapabilities,
      connection: runtime.connection,
      identity: runtime.identity,
      auth: runtime.auth,
      networkHandover: runtime.networkHandover
    };
    const rotation = await rotateLocalLauncherIdentity('public-key-conflict-auto-repair');
    runtime.feedback = {
      tone: 'info',
      message: '检测到本机 WireGuard 公钥仍被旧 active lease 占用，已自动轮换本机 installation 与 WireGuard 密钥并重试一次。'
    };
    queueDiagnosticError('network.public-key-conflict-before-repair', err, rotation);
    touchRuntime('local identity rotated after public key conflict');
    await saveAndBroadcast();
    try {
      return await connectLauncherNetwork({
        ...input,
        requestTag: `${stringValue(input.requestTag, 'connect')}-identity-repair`
      });
    } catch (retryErr) {
      if (options.preservePreviousOnRetryFailure === true) {
        runtime.installation = previousRuntime.installation;
        runtime.leaseCapabilities = previousRuntime.leaseCapabilities;
        runtime.connection = previousRuntime.connection;
        runtime.identity = previousRuntime.identity;
        runtime.auth = previousRuntime.auth;
        runtime.networkHandover = previousRuntime.networkHandover;
        touchRuntime('local identity repair rolled back after retry failure');
      }
      throw retryErr;
    }
  }
}

function isLauncherPublicKeyConflictError(err) {
  const status = Number(err?.status || err?.statusCode || err?.payload?.statusCode || 0);
  return status === 401
    && errorMessage(err).toLowerCase().includes('wireguard public key is already bound to another active lease');
}

async function ensureCredentialStorageRecoveryReady() {
  if (runtime?.credentialStorageFailure) {
    const recovery = await reconcileCredentialStorageFailureAfterStartup();
    if (recovery.blocked === true) {
      throw new Error(
        recovery.message
        || '安全存储失效后的本机网络清理尚未确认，当前连接被阻止。'
      );
    }
    startSystemDomainProxyRefreshWatcher();
    startWireGuardRecoveryWatcher();
  }
  if (!secureCredentialStorageAvailable()) {
    const err = new Error('Electron safeStorage 不可用，不能安全保存 token、lease capability 或 WireGuard 私钥；已阻止建立网络。');
    err.code = 'MX_SECURE_CREDENTIAL_STORAGE_UNAVAILABLE';
    throw err;
  }
}

async function recoverRetainedWireGuardBeforeBootstrap(reason, options = {}) {
  if (!runtime || !shouldRecoverWireGuardConnection(runtime.connection)) return null;
  const connection = runtime.connection || {};
  if (!normalizeRoutePlan(connection.routePlan)) return null;
  const result = await recoverWireGuardForRuntime(reason, {
    allowPrivileged: options.allowPrivileged === true,
    foreground: true
  });
  if (result?.ready) {
    runtime.feedback = {
      tone: 'info',
      message: '已检测到本地保留的 WireGuard ready，接下来通过 Internal overlay 刷新 bootstrap。'
    };
    touchRuntime(`wireguard pre-bootstrap ready: ${reason}`);
    await saveAndBroadcast();
  }
  return result;
}

async function repairDarwinEndpointRouteBeforeBootstrap(reason) {
  if (process.platform !== 'darwin') return null;
  try {
    const result = await repairDarwinStaleEndpointRoutesForRuntime(reason, {
      force: true,
      allowPrivileged: true
    });
    await recordDarwinEndpointRouteRepairDiagnostics(result, reason);
    return result;
  } catch (err) {
    queueDiagnosticError('bootstrap.endpoint-route-repair-failed', err, { reason });
    return null;
  }
}

async function launcherContext() {
  const bootstrap = await resolveBootstrapEndpoint(runtime.config);
  const baseUrl = bootstrap.baseUrl;
  await applyResolvedBootstrapEndpoint(bootstrap);
  const installation = await ensureInstallation();
  const productId = launcherProductId();
  const productDisplayName = launcherProductDisplayName();
  const mod = await importInstalledPackage('@qpjoy/electron-launcher');
  const launcher = mod.createElectronLauncher({
    baseUrl,
    fetchImpl: launcherFetchForBootstrap(bootstrap.resolveMode),
    productId,
    mode: 'standalone',
    installId: installation.installId,
    deviceId: installation.deviceId,
    siteId: installation.siteId,
    keyPair: installation.keyPair,
    privateKey: installation.keyPair.privateKey,
    publicKey: installation.keyPair.publicKey,
    deviceLabel: installation.deviceLabel
  });
  await ensureLauncherProduct(launcher, productId, productDisplayName);
  return { baseUrl, bootstrap, installation, launcher, productId, productDisplayName };
}

async function ensureInstallation() {
  const current = normalizeInstallation(runtime.installation);
  const productId = launcherProductId().replace(/[^a-z0-9]+/g, '_');
  let keyPair = current.keyPair;
  if (!keyPair) {
    const mod = await importInstalledPackage('@qpjoy/electron-launcher');
    keyPair = mod.createLauncherWireGuardKeyPair();
  }
  const now = nowIso();
  const installId = current.installId || `inst_${productId}_${shortId()}`;
  const deviceId = current.deviceId || `dev_${productId}_${shortId()}`;
  const deviceModel = current.deviceModel || await detectDeviceModel();
  const installation = {
    installId,
    deviceId,
    ownershipInstanceId: stableOwnershipInstanceId(current) || installId || deviceId,
    siteId: current.siteId,
    deviceLabel: current.deviceLabel || `${launcherProductDisplayName()} Desktop`,
    deviceModel,
    osVersion: os.release(),
    appVersion: currentReleaseVersion(),
    keyPair,
    createdAt: current.createdAt || now,
    updatedAt: now
  };
  runtime.installation = installation;
  return installation;
}

async function rotateLocalLauncherIdentity(reason, options = {}) {
  const current = normalizeInstallation(runtime.installation);
  const productId = launcherProductId().replace(/[^a-z0-9]+/g, '_');
  const normalizedProductId = launcherProductId();
  const mod = await importInstalledPackage('@qpjoy/electron-launcher');
  const keyPair = mod.createLauncherWireGuardKeyPair();
  const now = nowIso();
  const installId = `inst_${productId}_${shortId()}`;
  const deviceId = `dev_${productId}_${shortId()}`;
  const previousInstallId = nullableString(current.installId);
  const previousDeviceId = nullableString(current.deviceId);
  const previousPublicKey = nullableString(current.keyPair?.publicKey);
  const previousConnection = retainableConnectionSnapshot(runtime.connection);
  runtime.installation = normalizeInstallation({
    installId,
    deviceId,
    ownershipInstanceId: installId,
    siteId: current.siteId,
    deviceLabel: current.deviceLabel || `${launcherProductDisplayName()} Desktop`,
    deviceModel: await detectDeviceModel(),
    osVersion: os.release(),
    appVersion: currentReleaseVersion(),
    keyPair,
    createdAt: now,
    updatedAt: now
  });
  runtime.leaseCapabilities = normalizeLeaseCapabilities(
    Object.fromEntries(Object.entries(runtime.leaseCapabilities || {})
      .filter(([key, record]) => !(
        record?.productId === normalizedProductId
        && (
          record.installId === previousInstallId
          || record.publicKey === previousPublicKey
          || key.startsWith(`pending:${normalizedProductId}:${previousInstallId || ''}:`)
        )
      )))
  );
  runtime.networkHandover = null;
  runtime.connection = {
    ...idleConnection(),
    mode: previousConnection?.mode || runtime.connection?.mode || 'guest',
    diagnostics: {
      ...(previousConnection?.diagnostics || {}),
      localIdentityRepair: {
        ok: true,
        reason,
        previousInstallId,
        previousDeviceId,
        previousPublicKey,
        nextInstallId: installId,
        nextDeviceId: deviceId,
        diagnostics: options.diagnostics || null,
        updatedAt: now
      },
      updatedAt: now
    }
  };
  runtime.identity = normalizeIdentity(null);
  runtime.auth = null;
  return {
    reason,
    previousInstallId,
    previousDeviceId,
    previousPublicKey,
    nextInstallId: installId,
    nextDeviceId: deviceId
  };
}

async function detectDeviceModel() {
  const configured = nullableString(process.env.MX_H2I_DEVICE_MODEL);
  if (configured) return configured;
  try {
    if (process.platform === 'darwin') {
      return nullableString(await execFileText('/usr/sbin/sysctl', ['-n', 'hw.model'], {
        timeoutMs: 1500
      })) || os.machine();
    }
    if (process.platform === 'win32') {
      return nullableString(await execFileText('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-CimInstance Win32_ComputerSystem).Model'
      ], {
        timeoutMs: 2500
      })) || os.machine();
    }
    if (process.platform === 'linux') {
      return nullableString(await fs.readFile('/sys/class/dmi/id/product_name', 'utf8'))
        || os.machine();
    }
  } catch {
    // Hardware inventory is best-effort audit metadata and never gates a lease.
  }
  return nullableString(typeof os.machine === 'function' ? os.machine() : process.arch);
}

async function ensureLauncherProduct(launcher, productId, productDisplayName) {
  const normalizedProductId = normalizeLauncherProductId(productId);
  const displayName = stringValue(productDisplayName, displayNameForLauncherProductId(normalizedProductId));
  try {
    const product = await launcher.getProduct(normalizedProductId);
    if (product.enabled === false) throw new Error(`${displayName} 尚未在 Internal 后台启用。`);
    return product;
  } catch (err) {
    if (err?.status && err.status !== 404) throw err;
    if (!err?.status && !/404/.test(err?.message || '')) throw err;
    if (normalizedProductId !== PRODUCT_ID) {
      throw new Error(`${displayName} (${normalizedProductId}) 尚未在 Internal admin 创建 launcher standalone product。请先在 AppCenter / Launcher App 中保存产品网络。`);
    }
  }
  return launcher.upsertProduct(normalizedProductId, {
    productId: normalizedProductId,
    displayName,
    mode: 'standalone',
    serviceVip: '10.88.100.1',
    userCidr: '10.89.0.0/16',
    feishuCidr: '10.89.0.0/16',
    anonymousCidr: '10.89.0.0/16',
    userLeaseStart: '10.89.0.1',
    userLeaseEnd: '10.89.49.254',
    feishuLeaseStart: '10.89.50.1',
    feishuLeaseEnd: '10.89.99.254',
    anonymousLeaseStart: '10.89.100.1',
    anonymousLeaseEnd: '10.89.254.254',
    defaultDomesticSiteId: 'domestic-main',
    defaultOverseaSiteId: 'oversea-main',
    updatePolicy: 'launcher-managed',
    enabled: true,
    requestedBy: REQUESTED_BY,
    requestId: makeRequestId('product')
  });
}

async function applyNetworkSession(session, options) {
  assertNetworkTransitionCurrent(options.lifecycleEpoch);
  const transitionStartedAt = Number.isFinite(options.transitionStartedAt) ? options.transitionStartedAt : Date.now();
  const applyStartedAt = Date.now();
  const lease = session.lease || {};
  for (const handoverLease of arrayValue(lease.handoverLeases, [])) {
    rememberLeaseCapability(handoverLease);
  }
  rememberLeaseCapability(lease);
  const fallbackLeaseId = nullableString(options.fallbackConnection?.leaseId);
  const recoveredFallbackLease = fallbackLeaseId
    ? leaseAccessForLeaseId(fallbackLeaseId)
    : null;
  if (options.fallbackConnection && recoveredFallbackLease?.capability) {
    options = {
      ...options,
      fallbackConnection: {
        ...options.fallbackConnection,
        leaseCapability: recoveredFallbackLease.capability
      }
    };
  }
  const bootstrapResolution = normalizeBootstrapResolution(session.bootstrapResolution);
  const bootstrapResolveMode = bootstrapResolution?.resolveMode || runtime.config.bootstrapResolveMode;
  const bootstrapBaseUrl = bootstrapResolution?.baseUrl || runtime.config.bootstrapApiBaseUrl;
  const feedback = bootstrapResolution?.fallback?.message
    ? `${options.feedback} ${bootstrapResolution.fallback.message}`
    : options.feedback;
  const routePlan = normalizeRoutePlan(session.routePlan);
    const fallbackLease = leaseAccessFromConnection(options.fallbackConnection);
    const handoverOptions = fallbackLease && fallbackLease.leaseId !== lease.leaseId
      ? {
          handoverPhase: 'prepare',
          peerLease: fallbackLease,
          transitionId: options.transitionId
        }
      : {};
    const wireGuard = session.wireGuard || {};
    const privateKey = nullableString(wireGuard.privateKey) || runtime.installation?.keyPair?.privateKey;
    const publicKey = nullableString(wireGuard.publicKey) || runtime.installation?.keyPair?.publicKey || lease.publicKey;
    const now = nowIso();
    runtime.installation = normalizeInstallation({
      ...runtime.installation,
      installId: lease.installId || runtime.installation?.installId,
      deviceId: lease.deviceId || runtime.installation?.deviceId,
      siteId: lease.siteId || runtime.installation?.siteId,
      privateKey,
      publicKey,
      updatedAt: now,
      createdAt: runtime.installation?.createdAt || now
    });
    const overlayInternalBaseUrl = internalOverlayBaseUrl(routePlan, runtime.config.internalApiBaseUrl);
    runtime.connection = connectedState({
      state: 'lease-only',
      mode: options.mode,
      localIp: routePlan?.leaseIp || lease.leaseIp,
      routePolicy: options.routePolicy,
      subject: options.subject,
      leaseId: lease.leaseId,
      leaseCapability: lease.capability,
      snapshotId: routePlan?.snapshotId || session.snapshot?.snapshotId,
      productId: routePlan?.productId || lease.productId,
      serviceVip: routePlan?.serviceVip || lease.serviceVip,
      internalBaseUrl: overlayInternalBaseUrl,
      internalControlIp: routePlan?.internalControlIp || null,
      domesticRelayEndpoint: routePlan?.domesticRelayEndpoint || null,
      publicKey,
      allowedIps: routePlan?.allowedIps || [],
      routeCidrs: routePlan?.routeCidrs || [],
      routePlan,
      health: leasedHealth()
    });
    if (fallbackLease) {
      runtime.networkHandover = normalizePendingNetworkHandover({
        transitionId: options.transitionId,
        phase: 'preparing',
        oldLeaseId: fallbackLease.leaseId,
        newLeaseId: lease.leaseId,
        oldConnection: options.fallbackConnection,
        newRoutePlan: routePlan,
        bootstrapBaseUrl,
        bootstrapResolveMode,
        startedAt: nowIso(),
        updatedAt: nowIso()
      });
    }
    runtime.identity = options.identity;
    runtime.auth = normalizeAuth(options.auth);
    runtime.feedback = {
      tone: 'info',
      message: `${feedback} 正在并行同步 relay peer 和准备 PAC / split DNS。`
    };
    touchRuntime(options.mode === 'employee' ? 'employee lease ready' : 'guest lease ready');
    await saveAndBroadcast();
    assertNetworkTransitionCurrent(options.lifecycleEpoch);

    const preflightStartedAt = Date.now();
    const preflightResults = await Promise.allSettled([
      syncDomesticPeerForLease(lease, { bootstrapResolveMode, bootstrapBaseUrl, ...handoverOptions }),
      syncInternalDirectPeerForLease(lease, routePlan, { bootstrapResolveMode, bootstrapBaseUrl, ...handoverOptions }),
      prepareSystemDomainProxyForWireGuardInstall('pre-connect')
    ]);
    const domesticPeerSync = preflightResults[0].status === 'fulfilled'
      ? preflightResults[0].value
      : { status: 'failed', message: errorMessage(preflightResults[0].reason) };
    const internalDirectPeerSync = preflightResults[1].status === 'fulfilled'
      ? preflightResults[1].value
      : { status: 'failed', message: errorMessage(preflightResults[1].reason) };
    const combinedSystemDomainProxy = preflightResults[2].status === 'fulfilled'
      ? preflightResults[2].value
      : null;
    const preflightFailure = preflightResults.find((result) => result.status === 'rejected');
    if (!fallbackLease && preflightFailure) {
      throw preflightFailure.reason;
    }
    if (
      fallbackLease
      && (
        preflightFailure
        || !peerHandoverSyncsReady(domesticPeerSync, internalDirectPeerSync, routePlan)
      )
    ) {
      const rollback = await syncPeerHandover(
        fallbackLease,
        lease,
        'abort',
        normalizeRoutePlan(options.fallbackConnection?.routePlan),
        { bootstrapResolveMode, bootstrapBaseUrl, transitionId: options.transitionId }
      );
      runtime.networkHandover = rollback.ok
        ? null
        : {
            ...runtime.networkHandover,
            phase: 'abort-pending',
            updatedAt: nowIso()
          };
      const fallbackProbe = rollback.ok && options.fallbackConnection?.routePlan
        ? await probeWireGuardForConnection({
            connection: options.fallbackConnection,
            routePlan: normalizeRoutePlan(options.fallbackConnection.routePlan),
            internalBaseUrl: options.fallbackConnection.internalBaseUrl
          })
        : null;
      restoreFallbackConnectionAfterHandover(
        options,
        rollback,
        fallbackProbe,
        `切换预检未完成（Domestic=${domesticPeerSync?.status || 'unknown'}, Internal=${internalDirectPeerSync?.status || 'unknown'}, System=${preflightResults[2].status}）`
      );
      await publishNetworkModeEvent('staff:connect', 'failed', {
        reason: 'peer-handover-prepare-failed',
        transitionId: options.transitionId
      });
      await saveAndBroadcast();
      return;
    }
    if (runtime.networkHandover) {
      runtime.networkHandover = {
        ...runtime.networkHandover,
        phase: 'prepared',
        updatedAt: nowIso()
      };
    }
    assertNetworkTransitionCurrent(options.lifecycleEpoch);
    const preflightFinishedAt = Date.now();
    runtime.feedback = {
      tone: 'info',
      message: `${feedback} relay peer 已准备，正在原子切换 WireGuard、PAC 和 split DNS。`
    };
    touchRuntime(options.mode === 'employee' ? 'employee data-plane switching' : 'guest data-plane switching');
    await saveAndBroadcast();

    const wireGuardStartedAt = Date.now();
    let wireGuardResult;
    try {
      wireGuardResult = await startWireGuardForSession({
        routePlan,
        privateKey,
        internalBaseUrl: overlayInternalBaseUrl,
        internalDirectPeerSync,
        domesticPeerSync,
        domesticRelayDiagnostics: null,
        darwinExtraInstallShell: combinedSystemDomainProxy?.shell || null,
        suppressWireGuardDns: shouldSuppressWireGuardDnsForSystemDomainProxy(combinedSystemDomainProxy)
      });
    } catch (err) {
      if (fallbackLease) {
        const rollback = await syncPeerHandover(
          fallbackLease,
          lease,
          'abort',
          normalizeRoutePlan(options.fallbackConnection?.routePlan),
          { bootstrapResolveMode, bootstrapBaseUrl, transitionId: options.transitionId }
        ).catch(() => null);
        runtime.networkHandover = rollback?.ok === true
          ? null
          : runtime.networkHandover
            ? { ...runtime.networkHandover, phase: 'abort-pending', updatedAt: nowIso() }
            : null;
      }
      throw err;
    }
    assertNetworkTransitionCurrent(options.lifecycleEpoch);
    const wireGuardFinishedAt = Date.now();
    if (wireGuardResult.authorizationCanceled === true) {
      const handoverRollback = fallbackLease
        ? await syncPeerHandover(
            fallbackLease,
            lease,
            'abort',
            normalizeRoutePlan(options.fallbackConnection?.routePlan),
            { bootstrapResolveMode, bootstrapBaseUrl, transitionId: options.transitionId }
          )
        : null;
      runtime.networkHandover = handoverRollback?.ok === true
        ? null
        : runtime.networkHandover
          ? {
              ...runtime.networkHandover,
              phase: 'abort-pending',
              updatedAt: nowIso()
            }
          : null;
      const fallbackProbe = fallbackLease && options.fallbackConnection?.routePlan
        ? await probeWireGuardForConnection({
            connection: options.fallbackConnection,
            routePlan: normalizeRoutePlan(options.fallbackConnection.routePlan),
            internalBaseUrl: options.fallbackConnection.internalBaseUrl
          })
        : null;
      applyWireGuardAuthorizationCanceled(options, wireGuardResult, handoverRollback, fallbackProbe);
      await publishNetworkModeEvent(
        options.mode === 'employee' ? 'staff:connect' : 'visit:connect',
        'failed',
        { reason: 'authorization-canceled', transitionId: options.transitionId }
      );
      return;
    }
    runtime.connection = {
      ...runtime.connection,
      state: wireGuardResult.state,
      routeCidrs: wireGuardResult.routeCidrs || runtime.connection.routeCidrs,
      routePlan: wireGuardResult.routePlan || runtime.connection.routePlan,
      health: wireGuardResult.health,
      wireGuard: wireGuardResult.wireGuard,
      domesticPeerSync,
      diagnostics: wireGuardResult.diagnostics
    };
    const postConnectReady = postConnectDataPlaneReady({
      platform: process.platform,
      wireGuardReady: wireGuardResult.ready,
      connection: runtime.connection
    });
    const handoverCommit = fallbackLease && postConnectReady
      ? await syncPeerHandover(
          lease,
          fallbackLease,
          'commit',
          routePlan,
          { bootstrapResolveMode, bootstrapBaseUrl, transitionId: options.transitionId }
        )
      : null;
    if (handoverCommit) {
      runtime.networkHandover = handoverCommit.ok
        ? null
        : {
            ...runtime.networkHandover,
            phase: 'commit-pending',
            updatedAt: nowIso()
          };
    }
    if (postConnectReady) {
      wireGuardBackgroundProbeFailures = 0;
      lastWireGuardRecoveryFailureAt = 0;
    } else {
      queueDiagnosticLog('error', 'wireguard.not-ready', wireGuardResult.message || 'WireGuard did not become ready.', {
        state: wireGuardResult.state,
        path: wireGuardResult.path,
        statusError: wireGuardResult.wireGuard?.statusError,
        routeLogPath: wireGuardResult.wireGuard?.routeLogPath,
        routeLogTail: wireGuardResult.wireGuard?.routeLogTail,
        diagnostics: wireGuardResult.diagnostics
      });
    }
    const systemDomainProxy = postConnectReady
      ? (combinedSystemDomainProxy?.shell
          ? await completeExternalSystemDomainProxyApply('post-connect-combined')
          : await ensureSystemDomainProxyForRuntime('post-connect'))
      : deferredSystemDomainProxyRestoreStatus('wireguard-not-ready', combinedSystemDomainProxy);
    assertNetworkTransitionCurrent(options.lifecycleEpoch);
    const standaloneOwnership = wireGuardResult.diagnostics?.standaloneOwnershipRegistry || null;
    assertNetworkTransitionCurrent(options.lifecycleEpoch);
    const browserReady = systemDomainProxyConnectionReady(systemDomainProxy);
    const ownershipReady = standaloneOwnership?.ok === true;
    const connectionReady = postConnectReady && browserReady && ownershipReady;
    const supersededLeaseRetirements = connectionReady
      && (!handoverCommit || handoverCommit.ok)
      ? await retireSupersededLocalLeases(lease, {
          bootstrapResolveMode,
          bootstrapBaseUrl,
          transitionId: options.transitionId
        })
      : [];
    const browserFallback = process.platform === 'win32'
      ? windowsBrowserFallbackState({
          connection: runtime.connection,
          browserReady,
          connected: connectionReady
        })
      : null;
    const systemDnsReady = process.platform !== 'win32'
      || browserFallback.systemDnsReady;
    const systemDnsDegraded = process.platform === 'win32'
      && postConnectReady
      && !systemDnsReady;
    const finishedAt = Date.now();
    runtime.connection = {
      ...runtime.connection,
      state: connectionReady
        ? 'connected'
        : postConnectReady
          ? 'tunnel-only'
          : runtime.connection.state,
      health: connectionReady
        ? {
            ...runtime.connection.health,
            splitDns: 'ready'
          }
        : postConnectReady && !browserReady
        ? {
            ...runtime.connection.health,
            splitDns: 'blocked'
          }
        : runtime.connection.health,
      diagnostics: {
        ...(runtime.connection.diagnostics || {}),
        ...(handoverCommit ? { handoverCommit } : {}),
        ...(supersededLeaseRetirements.length > 0 ? { supersededLeaseRetirements } : {}),
        ...(systemDomainProxy ? { systemDomainProxy } : {}),
        ...(standaloneOwnership ? { standaloneOwnership } : {}),
        ...(process.platform === 'win32'
          ? {
              windowsBrowserFallback: {
                ...browserFallback,
                updatedAt: nowIso()
              }
            }
          : {}),
        transitionTiming: {
          transitionId: options.transitionId || null,
          startedAt: new Date(transitionStartedAt).toISOString(),
          controlPlaneMs: Math.max(0, applyStartedAt - transitionStartedAt),
          preflightMs: preflightFinishedAt - preflightStartedAt,
          wireGuardMs: wireGuardFinishedAt - wireGuardStartedAt,
          postConnectMs: finishedAt - wireGuardFinishedAt,
          totalMs: finishedAt - transitionStartedAt
        },
        updatedAt: nowIso()
      }
    };
    const resolverFeedback = arrayValue(systemDomainProxy?.resolverDomains, []).length > 0 && systemDomainProxy?.resolverApplied
      ? ' 系统 dynamic split DNS 已接管命令行和其它非 PAC 应用的域名解析。'
      : systemDomainProxy?.resolverError
        ? ` 系统 split DNS 未启用：${systemDomainProxy.resolverError}`
        : '';
    const publicTrafficFeedback = systemDomainProxy?.fallbackProxy
      ? `其它流量回落到当前仍在监听的 ${systemDomainProxy.fallbackProxy}。`
      : systemDomainProxy?.fallbackPacUrl
        ? `其它流量继续使用连接前的 PAC ${systemDomainProxy.fallbackPacUrl}。`
      : process.platform === 'win32'
        ? '其它流量保持 DIRECT。'
        : '其它流量回落到原系统代理。';
    const browserProofSkipped = windowsBrowserAccessProofSkipped(systemDomainProxy);
    const pacFeedback = systemDomainProxy?.applied
      ? process.platform === 'darwin' && systemDomainProxyConnectionReady(systemDomainProxy)
        ? ` macOS PAC、dynamic split DNS 与本机 DNS relay 已实时验证；${publicTrafficFeedback}${resolverFeedback}`
        : browserProofSkipped
        ? ` 系统 PAC 已写入；当前没有 split-DNS 域名诊断主机，已跳过浏览器 CONNECT 证明。${publicTrafficFeedback}${resolverFeedback}`
        : systemDomainProxy?.browserAccess?.ready
        ? ` 系统 PAC 已将 Internal 域名接入本机 ${localEdgeProxy()}，浏览器 CONNECT 探测通过；${publicTrafficFeedback}${resolverFeedback}`
        : ` 系统 PAC 已写入，但浏览器 Internal 路径未通过：${systemDomainProxy?.browserAccess?.error || 'unknown'}。`
      : systemDomainProxy?.error
        ? ` 系统 PAC 未启用：${systemDomainProxy.error}`
      : systemDomainProxy?.skipReason === 'windows-nrpt-only'
          ? ' Windows 浏览器 PAC 被显式关闭，当前只能提供 NRPT，不能保证浏览器访问 Internal。'
          : '';
    const systemDnsFeedback = systemDnsDegraded
      ? ' Windows 系统 DNS 仍受第三方 TUN/DoH 或上游 DNS 影响；浏览器已由 PAC/local edge 兜底，非 PAC 程序保持 degraded。'
      : '';
    const domainPathError = process.platform === 'darwin'
      ? systemDomainProxy?.resolverError || systemDomainProxy?.error || 'dynamic resolver/local DNS relay 未通过'
      : systemDomainProxy?.browserAccess?.error || systemDomainProxy?.error || 'PAC/local edge 未通过';
    runtime.feedback = {
      tone: connectionReady ? 'success' : 'warning',
      message: connectionReady
        ? `${feedback} 客户端 WireGuard 已通过 ${wireGuardPathLabel(wireGuardResult.path)} 探测 Internal。${pacFeedback}${systemDnsFeedback}`
        : postConnectReady
          ? process.platform === 'darwin'
            ? `${feedback} WireGuard 与 Internal API 已就绪，但 macOS split DNS 尚未实时验证：${domainPathError}。${pacFeedback}`
            : `${feedback} WireGuard、Internal API 和 NRPT 已就绪，但 Windows 浏览器路径未 ready：${domainPathError}。${pacFeedback}${systemDnsFeedback}`
          : `${feedback} 已保留租约，但客户端 WireGuard 还未 ready：${wireGuardResult.message}`
    };
    touchRuntime(connectionReady
      ? (options.mode === 'employee' ? 'employee wireguard connected' : 'guest wireguard connected')
      : postConnectReady
        ? 'wireguard ready; browser path blocked'
        : 'wireguard lease only');
    if (connectionReady) {
      if (options.replacedMode === 'guest') {
        await publishNetworkModeEvent('visit:disconnect', 'disconnected', {
          reason: 'staff-preempted-visit',
          transitionId: options.transitionId
        });
      }
      await publishNetworkModeEvent(
        options.mode === 'employee' ? 'staff:connect' : 'visit:connect',
        'connected',
        {
          leaseIp: runtime.connection.localIp,
          reason: options.replacedMode === 'guest' ? 'visit-to-staff' : null,
          transitionId: options.transitionId
        }
      );
      scheduleDomesticRelayDiagnostics(lease, {
        bootstrapResolveMode,
        bootstrapBaseUrl
      });
      schedulePostConnectUpdateCheck(`${options.mode}-connected`);
    } else {
      await publishNetworkModeEvent(
        options.mode === 'employee' ? 'staff:connect' : 'visit:connect',
        'failed',
        {
          reason: postConnectReady
            ? domainPathError
            : wireGuardResult.message,
          transitionId: options.transitionId
        }
      );
    }
    if (!connectionReady) {
      scheduleWireGuardRecovery('post-connect-probe', [1500, 4000, 9000]);
    }
    await saveAndBroadcast();
  scheduleNetworkEnvironmentDiagnostics('post-connect', {
    phase: connectionReady ? 'connected' : postConnectReady ? 'tunnel-only' : 'bootstrap',
    lookupTimeoutMs: NETWORK_DIAGNOSTIC_LOOKUP_TIMEOUT_MS
  });
}

function restoreFallbackConnectionAfterHandover(options, handoverRollback, fallbackProbe, reason) {
  const fallbackReady = handoverRollback?.ok === true && fallbackProbe?.ready === true;
  runtime.connection = {
    ...options.fallbackConnection,
    state: fallbackReady ? 'connected' : 'lease-only',
    health: fallbackReady
      ? fallbackProbe.health
      : {
          ...normalizeHealth(options.fallbackConnection.health, leasedHealth()),
          wireGuard: 'stale',
          internalApi: 'idle',
          splitDns: 'stale'
        },
    wireGuard: fallbackProbe?.wireGuard || options.fallbackConnection.wireGuard,
    diagnostics: {
      ...(options.fallbackConnection.diagnostics || {}),
      handoverRollback: {
        ...handoverRollback,
        reason,
        fallbackReady,
        updatedAt: nowIso()
      },
      updatedAt: nowIso()
    }
  };
  runtime.identity = options.fallbackIdentity || normalizeIdentity(null);
  runtime.auth = normalizeAuth(options.fallbackAuth);
  runtime.feedback = {
    tone: fallbackReady ? 'warning' : 'danger',
    message: fallbackReady
      ? `${reason}；远端 peer 已回滚并实测恢复原访客连接。`
      : `${reason}；远端 peer 已尝试回滚，但原访客通道尚未重新验证，请重新连接。`
  };
  touchRuntime('employee handover rolled back to guest');
}

function applyWireGuardAuthorizationCanceled(options, wireGuardResult, handoverRollback = null, fallbackProbe = null) {
  if (options.fallbackConnection) {
    restoreFallbackConnectionAfterHandover(
      options,
      handoverRollback,
      fallbackProbe,
      '已取消系统授权'
    );
    runtime.connection = {
      ...runtime.connection,
      diagnostics: {
        ...(runtime.connection.diagnostics || {}),
        authorizationCanceled: {
          ok: false,
          message: wireGuardResult.message || '用户取消了系统授权。',
          updatedAt: nowIso()
        }
      }
    };
    return;
  }
  runtime.connection = {
    ...idleConnection(),
    mode: options.mode === 'employee' ? 'employee' : 'guest',
    diagnostics: {
      authorizationCanceled: {
        ok: false,
        message: wireGuardResult.message || '用户取消了系统授权。',
        updatedAt: nowIso()
      },
      wireGuard: wireGuardResult.wireGuard,
      updatedAt: nowIso()
    }
  };
  runtime.identity = normalizeIdentity(null);
  runtime.auth = null;
  runtime.feedback = {
    tone: 'warning',
    message: '已取消系统授权，MX-H2I 连接已停止；没有继续启动 WireGuard、PAC 或后台恢复。'
  };
  touchRuntime(options.mode === 'employee' ? 'employee authorization canceled' : 'guest authorization canceled');
}

async function applyConnectionError(label, err) {
  const previous = retainableConnectionSnapshot(runtime.connection);
  const classified = classifyConnectionError(err);
  queueDiagnosticError('connection.failed', err, {
    label,
    classifiedState: classified.state,
    classifiedMessage: classified.message,
    previousMode: previous?.mode,
    previousState: previous?.state
  });
  if (classified.state === 'local-storage-error') {
    applyLocalRuntimePersistenceError(label, classified, previous);
    return;
  }
  const endpointRouteRepair = isBootstrapReachabilityState(classified.state)
    ? await repairDarwinStaleEndpointRoutesForRuntime(`${label}-connect-error`, { force: true })
    : null;
  const routePlan = normalizeRoutePlan(previous?.routePlan);
  if (previous && routePlan && isBootstrapReachabilityState(classified.state)) {
    const wireGuardResult = await probeWireGuardForConnection({
      connection: previous,
      routePlan,
      internalBaseUrl: previous.internalBaseUrl
    });
    runtime.connection = {
      ...previous,
      state: wireGuardResult.state,
      health: wireGuardResult.health,
      wireGuard: wireGuardResult.wireGuard,
      domesticPeerSync: previous.domesticPeerSync,
      diagnostics: {
        ...wireGuardResult.diagnostics,
        bootstrapRefresh: {
          ok: false,
          state: classified.state,
          label,
          message: classified.message,
          updatedAt: nowIso()
        },
        endpointRouteRepair
      }
    };
    runtime.auth = null;
    runtime.feedback = {
      tone: wireGuardResult.ready ? 'warning' : 'danger',
      message: wireGuardResult.ready
        ? `${label}：bootstrap API 暂不可达，但本地 WireGuard overlay 仍可用；本次没有刷新租约。原始错误：${classified.message}${darwinEndpointRouteRepairFeedback(endpointRouteRepair)}`
        : `${label}：bootstrap API 暂不可达，且本地 WireGuard 未 ready：${wireGuardResult.message}。原始错误：${classified.message}${darwinEndpointRouteRepairFeedback(endpointRouteRepair)}`
    };
    touchRuntime(`${label} bootstrap refresh failed`);
    return;
  }
  runtime.connection = {
    ...(previous || idleConnection()),
    state: classified.state,
    mode: previous?.mode || runtime.connection?.mode || 'guest',
    diagnostics: {
      ...(previous?.diagnostics || runtime.connection?.diagnostics || {}),
      bootstrapRefresh: {
        ok: false,
        state: classified.state,
        label,
        message: classified.message,
        updatedAt: nowIso()
      },
      endpointRouteRepair,
      updatedAt: nowIso()
    }
  };
  runtime.auth = null;
  runtime.feedback = {
    tone: 'danger',
    message: `${label}：${classified.message}${darwinEndpointRouteRepairFeedback(endpointRouteRepair)}`
  };
  touchRuntime(`${label} failed`);
}

function applyLocalRuntimePersistenceError(label, classified, previous) {
  runtime.connection = {
    ...(previous || idleConnection()),
    mode: previous?.mode || runtime.connection?.mode || 'guest',
    diagnostics: {
      ...(previous?.diagnostics || runtime.connection?.diagnostics || {}),
      localPersistence: {
        ok: false,
        label,
        message: classified.message,
        updatedAt: nowIso()
      },
      updatedAt: nowIso()
    }
  };
  runtime.auth = null;
  runtime.feedback = {
    tone: 'danger',
    message: `${label}：${classified.message}`
  };
  touchRuntime(`${label} local persistence failed`);
}

function isBootstrapReachabilityState(state) {
  return state === 'network-unavailable' || state === 'server-unavailable';
}

async function startWireGuardForSession(input) {
  const baseRoutePlan = normalizeRoutePlan(input.routePlan);
  const privateKey = nullableString(input.privateKey);
  const internalDirectPeerSync = normalizeInternalDirectPeerSync(input.internalDirectPeerSync);
  const domesticPeerSync = normalizeDomesticPeerSync(input.domesticPeerSync);
  const domesticRelayDiagnostics = input.domesticRelayDiagnostics || null;
  if (!baseRoutePlan) return wireGuardFailure('launcher routePlan 缺失。');
  if (!privateKey) return wireGuardFailure('本机 WireGuard privateKey 缺失。');

  try {
    const routePlan = baseRoutePlan;
    const connectingOwnership = await upsertStandaloneOwnershipForRoutePlan(
      routePlan,
      {
        ...(runtime?.connection || {}),
        routePlan,
        state: 'connecting'
      },
      'connect-preflight',
      'connecting'
    );
    if (connectingOwnership?.ok !== true) {
      const message = connectingOwnership?.error === 'ownership-conflict'
        || arrayValue(connectingOwnership?.conflicts, []).length > 0
        ? '本机 Launcher network ownership 存在冲突，未安装 WireGuard；请先断开冲突产品或修复旧 claim。'
        : `无法原子登记本机 Launcher network ownership，未安装 WireGuard：${connectingOwnership?.error || 'unknown error'}`;
      const failure = wireGuardFailure(message);
      failure.diagnostics = {
        ...failure.diagnostics,
        standaloneOwnershipRegistry: connectingOwnership
      };
      return failure;
    }
    const mod = await importInstalledPackage('@qpjoy/electron-launcher/wireguard');
    const internalBaseUrl = internalOverlayBaseUrl(routePlan, input.internalBaseUrl);
    const configuredPreference = normalizeRoutePathPreference(runtime.config.routePathPreference);
    const pathSelection = selectWireGuardPathPreference(mod, routePlan, internalDirectPeerSync, configuredPreference);
    const pathPreference = pathSelection.pathPreference;
    let attempt = await connectAndProbeWireGuardPath(mod, {
      routePlan,
      privateKey,
      internalBaseUrl,
      pathPreference,
      darwinExtraInstallShell: input.darwinExtraInstallShell,
      suppressWireGuardDns: input.suppressWireGuardDns
    });
    const {
      result,
      route,
      endpointRoute,
      internalApi,
      windowsNrpt,
      windowsDnsResolution,
      splitDnsReady,
      ready: dataPlaneReady
    } = attempt;
    const tunnelReady = result.ok === true;
    const wireGuard = summarizeWireGuardResult(result);
    const tunnelAbsenceProven = launcherConnectResultProvesTunnelAbsent(mod, result, windowsNrpt);
    const tunnelMayBeLive = tunnelReady
      || wireGuard.active
      || result?.tunnel?.ok === true
      || result?.launchDaemon?.ok === true
      || !tunnelAbsenceProven;
    const standaloneOwnershipRegistry = tunnelMayBeLive
      ? await upsertStandaloneOwnershipForRoutePlan(
          routePlan,
          {
            ...(runtime?.connection || {}),
            routePlan,
            state: 'connected'
          },
          tunnelReady || wireGuard.active ? 'connect-active' : 'connect-preserve-ambiguous',
          tunnelReady || wireGuard.active ? 'active' : 'connecting'
        )
      : await releaseStandaloneOwnershipForRuntime('connect-no-live-tunnel');
    const ownershipReady = standaloneOwnershipRegistry?.ok === true;
    const ready = dataPlaneReady && ownershipReady;
    const domesticRelayReady = domesticRelayDiagnostics?.status === 'passed' || domesticPeerSync?.status === 'passed' || route.ok === true;
    return {
      state: ready ? 'connected' : (tunnelReady ? 'tunnel-only' : 'lease-only'),
      ready,
      routePlan,
      routeCidrs: routePlan.routeCidrs,
      health: launcherNetworkHealth({
        networkReady: ready,
        wireGuardReady: result.ok === true,
        domesticRelayReady,
        route,
        internalApi,
        splitDnsReady,
        domesticPeerSync
      }),
      wireGuard,
      diagnostics: {
        route,
        endpointRoute,
        internalApi,
        windowsNrpt,
        windowsDnsResolution,
        internalDirectPeerSync,
        domesticPeerSync,
        domesticRelayDiagnostics,
        pathSelection,
        standaloneOwnershipRegistry,
        updatedAt: nowIso()
      },
      path: result.peer?.path || routePathFromPreference(attempt.pathPreference),
      message: ready
        ? 'ready'
        : !ownershipReady
          ? `WireGuard 已启动，但本机 Launcher network ownership 未确认：${standaloneOwnershipRegistry?.error || 'ownership conflict'}。`
        : wireGuardConnectionNotReadyMessage(
            result,
            route,
            internalApi,
            windowsNrpt,
            windowsDnsResolution,
            null,
            internalDirectPeerSync,
            domesticPeerSync,
            domesticRelayDiagnostics
          )
    };
  } catch (err) {
    if (isUserAuthorizationCanceledError(err)) {
      return wireGuardAuthorizationCanceledFailure(errorMessage(err));
    }
    return wireGuardFailure(errorMessage(err));
  }
}

function launcherConnectResultProvesTunnelAbsent(mod, result, windowsNrpt) {
  const status = result?.status || null;
  if (process.platform === 'win32') {
    return typeof mod?.launcherWindowsWireGuardCleanupReady === 'function'
      && mod.launcherWindowsWireGuardCleanupReady(status, windowsNrpt) === true;
  }
  return status?.ok === true
    && status?.active === false
    && result?.tunnel?.ok !== true
    && result?.launchDaemon?.ok !== true;
}

function isRegisteredStandaloneRouteCidr(value) {
  const cidr = nullableString(value);
  if (!cidr || cidr === '0.0.0.0/0' || cidr === '::/0') return false;
  return /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}\/([1-9]|[1-2]\d|3[0-2])$/.test(cidr);
}

async function connectAndProbeWireGuardPath(mod, input) {
  const result = await mod.connectLauncherWireGuardPeer({
    ...wireGuardRuntimeOptions({
      darwinExtraInstallShell: input.darwinExtraInstallShell
    }),
    routePlan: input.routePlan,
    privateKey: input.privateKey,
    dnsDomains: input.suppressWireGuardDns ? [] : splitDnsDomains(runtime.config),
    suppressWireGuardDns: input.suppressWireGuardDns === true,
    pathPreference: input.pathPreference,
    action: 'restart'
  });
  const status = result.status || {};
  const targetIp = internalTargetIp(input.routePlan, input.internalBaseUrl);
  const endpointRoute = mod.probeLauncherWireGuardEndpoint({
    endpoint: result.peer?.endpoint || endpointForRoutePreference(input.routePlan, input.pathPreference)
  });
  const route = mod.probeLauncherWireGuardRoute({
    ...wireGuardRuntimeOptions(),
    targetIp,
    expectedInterfaceName: status.realInterfaceName || status.interfaceName || null,
    expectedInterfaceAddresses: status.addresses || []
  });
  const tunnelProofReady = result.ok === true;
  const routeReady = route.ok === true;
  const internalApi = routeReady
    ? await probeInternalApiViaOverlay(input.internalBaseUrl)
    : internalApiProbeBlockedByRoute(input.internalBaseUrl, targetIp, route);
  const internalApiReady = internalApi?.ok === true;
  const windowsNrpt = await launcherWindowsNrptStatus(mod, input.routePlan);
  const windowsDnsResolution = await probeWindowsSplitDnsResolution(input.routePlan, windowsNrpt);
  const splitDnsReady = windowsNrptReadyForConnection(windowsNrpt)
    && (process.platform !== 'win32' || windowsDnsResolution?.ready === true);
  return {
    pathPreference: input.pathPreference,
    result,
    route,
    endpointRoute,
    internalApi,
    windowsNrpt,
    windowsDnsResolution,
    splitDnsReady,
    ready: tunnelProofReady && routeReady && internalApiReady && splitDnsReady
  };
}

async function probeWireGuardForConnection(input) {
  const connection = input.connection || {};
  const routePlan = normalizeRoutePlan(input.routePlan || connection.routePlan);
  const internalDirectPeerSync = normalizeInternalDirectPeerSync(input.internalDirectPeerSync || connection.diagnostics?.internalDirectPeerSync);
  const domesticPeerSync = normalizeDomesticPeerSync(input.domesticPeerSync || connection.domesticPeerSync);
  const domesticRelayDiagnostics = input.domesticRelayDiagnostics || connection.diagnostics?.domesticRelayDiagnostics || null;
  if (!routePlan) return wireGuardFailure('launcher routePlan 缺失。');

  try {
    const mod = await importInstalledPackage('@qpjoy/electron-launcher/wireguard');
    const internalBaseUrl = internalOverlayBaseUrl(routePlan, input.internalBaseUrl || connection.internalBaseUrl);
    const status = mod.getLauncherWireGuardPeerStatus(wireGuardRuntimeOptions());
    const wireGuard = summarizeWireGuardStatus(status, connection);
    const targetIp = internalTargetIp(routePlan, internalBaseUrl);
    const endpointRoute = mod.probeLauncherWireGuardEndpoint({
      endpoint: wireGuard.endpoint || endpointForRoutePreference(routePlan, wireGuard.path)
    });
    const expectedInterfaceName = status?.realInterfaceName || status?.interfaceName || wireGuard.realInterfaceName || wireGuard.interfaceName || null;
    const route = mod.probeLauncherWireGuardRoute({
      ...wireGuardRuntimeOptions(),
      targetIp,
      expectedInterfaceName,
      expectedInterfaceAddresses: status?.addresses || []
    });
    const tunnelProofReady = wireGuardStatusIsHealthy(status);
    const routeReady = route.ok === true;
    const internalApi = routeReady
      ? await probeInternalApiViaOverlay(internalBaseUrl)
      : internalApiProbeBlockedByRoute(internalBaseUrl, targetIp, route);
    const tunnelReady = tunnelProofReady;
    const internalApiReady = internalApi?.ok === true;
    const windowsNrpt = await launcherWindowsNrptStatus(mod, routePlan);
    const windowsDnsResolution = await probeWindowsSplitDnsResolution(routePlan, windowsNrpt);
    const systemDnsReady = windowsNrptReadyForConnection(windowsNrpt)
      && (process.platform !== 'win32' || windowsDnsResolution?.ready === true);
    const systemDomainProxy = connection.diagnostics?.systemDomainProxy || null;
    const browserAccess = systemDomainProxy?.browserAccess || null;
    const browserReady = systemDomainProxyConnectionReady(systemDomainProxy);
    const splitDnsReady = process.platform === 'win32'
      ? windowsSplitDnsPathReady({
          nrptReady: windowsNrptReadyForConnection(windowsNrpt),
          systemDnsReady,
          browserReady
        })
      : systemDnsReady && browserReady;
    let standaloneOwnershipRegistry =
      connection.diagnostics?.standaloneOwnershipRegistry
      || connection.diagnostics?.standaloneOwnership
      || null;
    if (shouldRepairDarwinRetainedOwnership({
      platform: process.platform,
      ownershipReady: standaloneOwnershipRegistry?.ok === true,
      tunnelReady,
      routeReady,
      internalApiReady,
      splitDnsReady
    })) {
      standaloneOwnershipRegistry = await upsertStandaloneOwnershipForRoutePlan(
        routePlan,
        connection,
        'darwin-retained-data-plane-recovery',
        'active'
      );
    }
    const ownershipReady = standaloneOwnershipRegistry?.ok === true;
    const ready = tunnelReady
      && routeReady
      && internalApiReady
      && splitDnsReady
      && ownershipReady;
    const browserFallback = process.platform === 'win32'
      ? windowsBrowserFallbackState({
          connection: {
            ...connection,
            health: {
              ...(connection.health || {}),
              wireGuard: tunnelReady ? 'ready' : 'blocked',
              internalApi: internalApiReady ? 'ready' : 'blocked'
            },
            diagnostics: {
              ...(connection.diagnostics || {}),
              windowsNrpt,
              windowsDnsResolution,
              standaloneOwnershipRegistry
            }
          },
          browserReady,
          connected: ready
        })
      : null;
    const domesticRelayReady = domesticRelayDiagnostics?.status === 'passed' || domesticPeerSync?.status === 'passed' || route.ok === true;
    const resultLike = {
      ok: tunnelReady,
      status,
      peer: {
        endpoint: connection.domesticRelayEndpoint,
        path: wireGuard.path,
        allowedIps: connection.routeCidrs,
        configPath: wireGuard.configPath
      },
      tunnel: {
        message: status?.error || wireGuard.message
      },
      message: status?.error || wireGuard.message
    };
    return {
      state: ready ? 'connected' : (tunnelReady ? 'tunnel-only' : 'lease-only'),
      ready,
      health: launcherNetworkHealth({
        networkReady: ready,
        wireGuardReady: tunnelReady,
        domesticRelayReady,
        route,
        internalApi,
        splitDnsReady,
        domesticPeerSync
      }),
      wireGuard,
      diagnostics: {
        route,
        endpointRoute,
        internalApi,
        windowsNrpt,
        windowsDnsResolution,
        systemDomainProxy: connection.diagnostics?.systemDomainProxy || null,
        standaloneOwnershipRegistry,
        ...(browserFallback
          ? {
              windowsBrowserFallback: {
                ...browserFallback,
                updatedAt: nowIso()
              }
            }
          : {}),
        internalDirectPeerSync,
        domesticPeerSync,
        domesticRelayDiagnostics,
        updatedAt: nowIso()
      },
      message: ready
        ? 'ready'
        : !ownershipReady
          ? `WireGuard 数据面可达，但本机 Launcher network ownership 未确认：${standaloneOwnershipRegistry?.error || 'ownership registry missing or conflicted'}。`
        : wireGuardConnectionNotReadyMessage(
            resultLike,
            route,
            internalApi,
            windowsNrpt,
            windowsDnsResolution,
            browserAccess,
            internalDirectPeerSync,
            domesticPeerSync,
            domesticRelayDiagnostics
          )
    };
  } catch (err) {
    return wireGuardFailure(errorMessage(err));
  }
}

function launcherNetworkHealth(input) {
  if (input.networkReady) {
    return {
      wireGuard: 'ready',
      domesticRelay: input.domesticRelayReady ? 'ready' : 'pending',
      internalApi: internalApiHealthStatus(input.route, input.internalApi),
      splitDns: input.splitDnsReady === false ? 'blocked' : 'ready',
      appBroker: 'ready'
    };
  }
  const domesticPeerSync = input.domesticPeerSync;
  return {
    wireGuard: input.wireGuardReady ? 'ready' : 'blocked',
    domesticRelay: input.domesticRelayReady ? 'ready' : domesticPeerSync?.status === 'failed' || domesticPeerSync?.status === 'blocked' ? 'blocked' : 'pending',
    internalApi: internalApiHealthStatus(input.route, input.internalApi),
    splitDns: input.splitDnsReady === false
      ? 'blocked'
      : input.route?.ok === true
        ? 'ready'
        : 'pending',
    appBroker: 'ready'
  };
}

function launcherLeaseAccessHeaders(lease) {
  const headers = { ...appCenterCatalogHeaders() };
  const capability = nullableString(lease?.capability) || nullableString(lease?.leaseCapability);
  if (capability) headers['x-mx-lease-capability'] = capability;
  return headers;
}

function leaseAccessFromConnection(connection) {
  const leaseId = nullableString(connection?.leaseId);
  const capability = nullableString(connection?.leaseCapability);
  if (!leaseId || !capability) return null;
  return { leaseId, capability };
}

async function syncPeerHandover(targetLease, peerLease, handoverPhase, routePlan, options = {}) {
  const sharedOptions = {
    ...options,
    handoverPhase,
    peerLease
  };
  const results = await Promise.allSettled([
    syncDomesticPeerForLease(targetLease, sharedOptions),
    syncInternalDirectPeerForLease(targetLease, routePlan, sharedOptions)
  ]);
  const domesticPeerSync = results[0].status === 'fulfilled'
    ? results[0].value
    : { status: 'failed', message: errorMessage(results[0].reason) };
  const internalDirectPeerSync = results[1].status === 'fulfilled'
    ? results[1].value
    : { status: 'failed', message: errorMessage(results[1].reason) };
  const peersReady = peerHandoverSyncsReady(
    domesticPeerSync,
    internalDirectPeerSync,
    routePlan
  );
  const retirement = handoverPhase !== 'prepare' && peersReady
    ? await releaseRetiredHandoverLease(peerLease, options)
    : null;
  return {
    phase: handoverPhase,
    ok: peersReady && (handoverPhase === 'prepare' || retirement?.ok === true),
    domesticPeerSync,
    internalDirectPeerSync,
    retirement,
    updatedAt: nowIso()
  };
}

async function releaseRetiredHandoverLease(lease, options = {}) {
  const leaseId = nullableString(lease?.leaseId);
  if (!leaseId) {
    return {
      ok: false,
      status: 'failed',
      message: 'Retired handover lease is missing leaseId.',
      updatedAt: nowIso()
    };
  }
  try {
    const baseUrl = normalizeBaseUrl(options.bootstrapBaseUrl) || runtime.config.bootstrapApiBaseUrl;
    const payload = await requestJson(
      joinApiUrl(
        baseUrl,
        `/internal/v1/launcher-network/leases/${encodeURIComponent(leaseId)}/release`
      ),
      {
        method: 'POST',
        headers: launcherLeaseAccessHeaders(lease),
        body: {
          requestedBy: REQUESTED_BY,
          requestId: nullableString(options.transitionId)
            ? `${options.transitionId}:retire:${leaseId}`
            : makeRequestId('handover-lease-release')
        },
        timeoutMs: 10_000,
        bootstrapResolveMode: options.bootstrapResolveMode || runtime.config.bootstrapResolveMode
      }
    );
    const released = payload?.lease;
    if (released?.status !== 'released') {
      throw new Error('Internal did not confirm that the retired handover lease was released.');
    }
    return {
      ok: true,
      status: 'released',
      leaseId,
      releasedAt: nullableString(released.releasedAt),
      updatedAt: nowIso()
    };
  } catch (err) {
    return {
      ok: false,
      status: 'failed',
      leaseId,
      message: errorMessage(err),
      updatedAt: nowIso()
    };
  }
}

async function retireSupersededLocalLeases(currentLease, options = {}) {
  const leaseId = nullableString(currentLease?.leaseId);
  const productId = nullableString(currentLease?.productId) || launcherProductId();
  const installId = nullableString(currentLease?.installId)
    || nullableString(runtime.installation?.installId);
  const publicKey = nullableString(currentLease?.publicKey)
    || nullableString(runtime.installation?.keyPair?.publicKey);
  if (!leaseId || !installId || !publicKey) return [];
  const candidates = Object.values(runtime.leaseCapabilities || {})
    .filter((record) => (
      record?.leaseId
      && record.leaseId !== leaseId
      && record.productId === productId
      && record.installId === installId
      && record.publicKey === publicKey
    ))
    .map((record) => ({
      leaseId: record.leaseId,
      capability: record.capability
    }));
  const results = await Promise.all(candidates.map((candidate) => (
    releaseRetiredHandoverLease(candidate, options)
  )));
  for (const result of results) {
    if (result.ok) continue;
    queueDiagnosticLog(
      'warning',
      'network.superseded-lease-retirement-pending',
      'A superseded local launcher lease could not be retired and will be retried after a later connection.',
      { leaseId: result.leaseId, message: result.message }
    );
  }
  return results;
}

function peerHandoverSyncsReady(domesticPeerSync, internalDirectPeerSync, routePlan) {
  const relayRequired = routePlanHasRelay(routePlan);
  const directRequired = routePlanHasDirect(routePlan);
  return (!relayRequired || domesticPeerSync?.status === 'passed')
    && (!directRequired || internalDirectPeerSync?.status === 'passed')
    && (relayRequired || directRequired);
}

async function reconcilePendingNetworkHandoverAfterStartup() {
  const pending = normalizePendingNetworkHandover(runtime?.networkHandover);
  if (!pending) return null;
  const oldLease = leaseAccessForLeaseId(pending.oldLeaseId);
  const newLease = leaseAccessForLeaseId(pending.newLeaseId);
  if (!oldLease || !newLease) {
    runtime.feedback = {
      tone: 'danger',
      message: '检测到未完成的网络身份切换，但本机安全存储缺少 lease capability；请由管理员清理远端双 IP peer 后重新连接。'
    };
    queueDiagnosticLog('error', 'network.handover-capability-missing', runtime.feedback.message, {
      transitionId: pending.transitionId,
      phase: pending.phase,
      oldLeaseId: pending.oldLeaseId,
      newLeaseId: pending.newLeaseId
    });
    await saveRuntime(runtime);
    return null;
  }

  const currentRoutePlan = normalizeRoutePlan(runtime.connection?.routePlan || pending.newRoutePlan);
  const oldRoutePlan = normalizeRoutePlan(pending.oldConnection?.routePlan);
  const newRoutePlan = normalizeRoutePlan(pending.newRoutePlan || currentRoutePlan);
  const oldLeaseIp = nullableString(oldRoutePlan?.leaseIp)
    || nullableString(pending.oldConnection?.localIp);
  const newLeaseIp = nullableString(newRoutePlan?.leaseIp);
  let actualInterfaceIps = [];
  let wireGuardStatus = null;
  try {
    const mod = await importInstalledPackage('@qpjoy/electron-launcher/wireguard');
    wireGuardStatus = mod.getLauncherWireGuardPeerStatus(wireGuardRuntimeOptions());
    actualInterfaceIps = uniqueStrings(arrayValue(wireGuardStatus?.addresses, [])
      .map((address) => nullableString(address)?.split('/')[0])
      .filter(Boolean));
  } catch (err) {
    queueDiagnosticError('network.handover-recovery-address-probe-failed', err, {
      transitionId: pending.transitionId
    });
  }
  const actualUsesOldLease = Boolean(oldLeaseIp && actualInterfaceIps.includes(oldLeaseIp));
  const actualUsesNewLease = Boolean(newLeaseIp && actualInterfaceIps.includes(newLeaseIp));
  if (
    !oldLeaseIp
    || !newLeaseIp
    || actualUsesOldLease === actualUsesNewLease
  ) {
    runtime.networkHandover = {
      ...pending,
      updatedAt: nowIso()
    };
    runtime.feedback = {
      tone: 'danger',
      message: '检测到未完成的网络身份切换，但无法从 WireGuard 实际接口地址唯一判断旧/新路径；已保留 pending，未自动 commit 或 abort。'
    };
    queueDiagnosticLog('error', 'network.handover-recovery-address-ambiguous', runtime.feedback.message, {
      transitionId: pending.transitionId,
      phase: pending.phase,
      oldLeaseIp,
      newLeaseIp,
      actualInterfaceIps,
      wireGuardActive: wireGuardStatus?.active === true
    });
    await saveRuntime(runtime);
    return {
      ok: false,
      pending: true,
      reason: 'wireguard-interface-address-ambiguous',
      oldLeaseIp,
      newLeaseIp,
      actualInterfaceIps
    };
  }
  const commit = actualUsesNewLease;
  const targetLease = commit ? newLease : oldLease;
  const peerLease = commit ? oldLease : newLease;
  const targetRoutePlan = commit
    ? newRoutePlan
    : oldRoutePlan;
  const result = await syncPeerHandover(
    targetLease,
    peerLease,
    commit ? 'commit' : 'abort',
    targetRoutePlan,
    {
      bootstrapBaseUrl: pending.bootstrapBaseUrl,
      bootstrapResolveMode: pending.bootstrapResolveMode,
      transitionId: pending.transitionId
    }
  );
  if (result.ok) {
    runtime.networkHandover = null;
    if (!commit && pending.oldConnection) {
      runtime.connection = {
        ...pending.oldConnection,
        state: 'lease-only',
        health: {
          ...normalizeHealth(pending.oldConnection.health, leasedHealth()),
          wireGuard: 'stale',
          internalApi: 'idle',
          splitDns: 'stale'
        },
        diagnostics: {
          ...(pending.oldConnection.diagnostics || {}),
          handoverRecovery: result,
          updatedAt: nowIso()
        }
      };
    }
  } else {
    runtime.networkHandover = {
      ...pending,
      phase: commit ? 'commit-pending' : 'abort-pending',
      updatedAt: nowIso()
    };
  }
  queueDiagnosticLog(
    result.ok ? 'info' : 'warning',
    `network.handover-${commit ? 'commit' : 'abort'}-${result.ok ? 'completed' : 'pending'}`,
    result.ok
      ? `Pending network handover ${commit ? 'commit' : 'abort'} completed.`
      : `Pending network handover ${commit ? 'commit' : 'abort'} remains degraded and will be retried.`,
    { transitionId: pending.transitionId, result }
  );
  await saveRuntime(runtime);
  return result;
}

function launcherPeerHandoverRequest(options = {}) {
  const peerLeaseId = nullableString(options.peerLease?.leaseId);
  const transitionId = nullableString(options.transitionId);
  const handoverPhase = ['prepare', 'commit', 'abort'].includes(options.handoverPhase)
    ? options.handoverPhase
    : null;
  if (!peerLeaseId || !handoverPhase || !transitionId) return { headers: {}, body: {} };
  const peerCapability = nullableString(options.peerLease?.capability)
    || nullableString(options.peerLease?.leaseCapability);
  return {
    headers: peerCapability ? { 'x-mx-peer-lease-capability': peerCapability } : {},
    body: { transitionId, peerLeaseId, handoverPhase }
  };
}

async function syncDomesticPeerForLease(lease, options = {}) {
  const leaseId = nullableString(lease?.leaseId);
  if (!leaseId) {
    return {
      status: 'skipped',
      execution: 'not-started',
      checkedAt: nowIso(),
      failures: ['leaseId missing before Domestic peer sync']
    };
  }
  try {
    const baseUrl = normalizeBaseUrl(options.bootstrapBaseUrl) || runtime.config.bootstrapApiBaseUrl;
    const handover = launcherPeerHandoverRequest(options);
    const payload = await requestJson(joinApiUrl(baseUrl, `/internal/v1/launcher-network/leases/${encodeURIComponent(leaseId)}/domestic-peer/sync`), {
      method: 'POST',
      headers: { ...launcherLeaseAccessHeaders(lease), ...handover.headers },
      body: {
        requestedBy: REQUESTED_BY,
        requestId: makeRequestId('domestic-peer-sync'),
        ...handover.body
      },
      timeoutMs: DEFAULT_DOMESTIC_PEER_SYNC_TIMEOUT_MS,
      bootstrapResolveMode: options.bootstrapResolveMode || runtime.config.bootstrapResolveMode
    });
    return normalizeDomesticPeerSync(payload?.domesticPeerSync) || {
      status: 'failed',
      execution: 'failed',
      checkedAt: nowIso(),
      failures: ['Domestic peer sync returned an empty payload']
    };
  } catch (err) {
    return {
      status: 'failed',
      execution: 'failed',
      checkedAt: nowIso(),
      error: errorMessage(err),
      failures: [errorMessage(err)]
    };
  }
}

async function syncInternalDirectPeerForLease(lease, routePlan, options = {}) {
  const leaseId = nullableString(lease?.leaseId);
  const plan = normalizeRoutePlan(routePlan);
  if (!leaseId) {
    return {
      status: 'skipped',
      execution: 'not-started',
      checkedAt: nowIso(),
      failures: ['leaseId missing before Internal direct peer sync']
    };
  }
  if (!routePlanHasDirect(plan) && runtime.config.routePathPreference !== 'direct') {
    return {
      status: 'skipped',
      execution: 'not-started',
      checkedAt: nowIso(),
      message: 'H2I direct endpoint is not configured; using Domestic relay path.',
      failures: []
    };
  }
  try {
    const baseUrl = normalizeBaseUrl(options.bootstrapBaseUrl) || runtime.config.bootstrapApiBaseUrl;
    const handover = launcherPeerHandoverRequest(options);
    const payload = await requestJson(joinApiUrl(baseUrl, `/internal/v1/launcher-network/leases/${encodeURIComponent(leaseId)}/internal-direct-peer/sync`), {
      method: 'POST',
      headers: { ...launcherLeaseAccessHeaders(lease), ...handover.headers },
      body: {
        requestedBy: REQUESTED_BY,
        requestId: makeRequestId('internal-direct-peer-sync'),
        ...handover.body
      },
      timeoutMs: 20000,
      bootstrapResolveMode: options.bootstrapResolveMode || runtime.config.bootstrapResolveMode
    });
    return normalizeInternalDirectPeerSync(payload?.internalDirectPeerSync) || {
      status: 'failed',
      execution: 'failed',
      checkedAt: nowIso(),
      failures: ['Internal direct peer sync returned an empty payload']
    };
  } catch (err) {
    return {
      status: 'failed',
      execution: 'failed',
      checkedAt: nowIso(),
      error: errorMessage(err),
      failures: [errorMessage(err)]
    };
  }
}

async function diagnoseDomesticRelayForLease(lease, options = {}) {
  const leaseId = nullableString(lease?.leaseId);
  if (!leaseId) {
    return {
      status: 'skipped',
      execution: 'not-started',
      checkedAt: nowIso(),
      failures: ['leaseId missing before Domestic relay diagnostics']
    };
  }
  try {
    const baseUrl = normalizeBaseUrl(options.bootstrapBaseUrl) || runtime.config.bootstrapApiBaseUrl;
    const payload = await requestJson(joinApiUrl(baseUrl, `/internal/v1/launcher-network/leases/${encodeURIComponent(leaseId)}/domestic-relay/diagnostics`), {
      method: 'POST',
      headers: launcherLeaseAccessHeaders(lease),
      body: {
        requestedBy: REQUESTED_BY,
        requestId: makeRequestId('domestic-relay-diagnostics')
      },
      timeoutMs: 22000,
      bootstrapResolveMode: options.bootstrapResolveMode || runtime.config.bootstrapResolveMode
    });
    return payload?.domesticRelayDiagnostics || {
      status: 'failed',
      execution: 'failed',
      checkedAt: nowIso(),
      failures: ['Domestic relay diagnostics returned an empty payload']
    };
  } catch (err) {
    return {
      status: 'failed',
      execution: 'failed',
      checkedAt: nowIso(),
      error: errorMessage(err),
      failures: [errorMessage(err)]
    };
  }
}

function scheduleDomesticRelayDiagnostics(lease, options = {}) {
  const leaseId = nullableString(lease?.leaseId);
  if (!leaseId) return;
  void diagnoseDomesticRelayForLease(lease, options).then(async (diagnostics) => {
    if (runtime?.connection?.leaseId !== leaseId) return;
    runtime.connection = {
      ...runtime.connection,
      diagnostics: {
        ...(runtime.connection.diagnostics || {}),
        domesticRelayDiagnostics: diagnostics,
        updatedAt: nowIso()
      }
    };
    touchRuntime('domestic relay diagnostics completed');
    await saveAndBroadcast();
  }).catch(() => undefined);
}

async function refreshWireGuardDiagnostics() {
  const connection = runtime.connection || {};
  const routePlan = normalizeRoutePlan(connection.routePlan);
  if (!routePlan || !connection.leaseId) {
    runtime.feedback = { tone: 'warning', message: '当前没有可诊断的 launcher lease。' };
    return;
  }
  const leaseAccess = {
    leaseId: connection.leaseId,
    capability: connection.leaseCapability
  };
  const domesticPeerSync = await syncDomesticPeerForLease(leaseAccess);
  const internalDirectPeerSync = await syncInternalDirectPeerForLease(leaseAccess, routePlan);
  const domesticRelayDiagnostics = await diagnoseDomesticRelayForLease(leaseAccess);
  const wireGuardResult = await probeWireGuardForConnection({
    connection,
    routePlan,
    internalBaseUrl: connection.internalBaseUrl,
    internalDirectPeerSync,
    domesticPeerSync,
    domesticRelayDiagnostics
  });
  runtime.connection = {
    ...connection,
    state: wireGuardResult.state,
    health: wireGuardResult.health,
    wireGuard: wireGuardResult.wireGuard,
    domesticPeerSync,
      diagnostics: wireGuardResult.diagnostics
    };
  const browserFallbackActive =
    wireGuardResult.diagnostics?.windowsBrowserFallback?.active === true;
  runtime.feedback = {
    tone: wireGuardResult.ready ? 'success' : 'warning',
    message: wireGuardResult.ready
      ? browserFallbackActive
        ? 'WireGuard、Domestic、Internal 与浏览器 PAC 路径已通过；Windows 系统 DNS 仍为 degraded，非 PAC 程序尚未 ready。'
        : 'WireGuard 诊断通过，Domestic 和 Internal overlay 可达。'
      : `WireGuard 仍未 ready：${wireGuardResult.message}`
  };
  if (runtime.networkHandover) {
    await reconcilePendingNetworkHandoverAfterStartup();
  }
  touchRuntime('wireguard diagnostics refreshed');
}

function feedbackIsWireGuardWarning(feedback) {
  if (!feedback || typeof feedback !== 'object') return false;
  const message = nullableString(feedback.message);
  if (!message) return false;
  return /WireGuard|隧道|overlay|Internal API/.test(message)
    && /未 ready|暂未确认|探测失败|ECONNREFUSED|恢复后仍未 ready/.test(message);
}

async function recoverWireGuardForRuntime(reason = 'manual', options = {}) {
  if (!runtime || !shouldRecoverWireGuardConnection(runtime.connection)) {
    return { ok: true, skipped: true, reason: 'connection-not-desired' };
  }
  const manual = options.foreground === true || String(reason || '').startsWith('manual');
  const currentRecoveryGate = () => wireGuardRecoveryGate({
    connectOperationCount: wireGuardConnectOperations.size,
    disconnectInFlight: wireGuardDisconnectInFlight,
    connectionState: runtime.connection?.state,
    foreground: options.foreground === true,
    manual,
    lastFailureAt: lastWireGuardRecoveryFailureAt
  });
  let recoveryGate = currentRecoveryGate();
  if (recoveryGate) {
    return {
      ok: true,
      skipped: true,
      reason: recoveryGate
    };
  }
  if (wireGuardRecoveryInFlight) {
    const backgroundRecovery = wireGuardRecoveryInFlight;
    const recoveryTurn = await wireGuardRecoveryTurn(
      backgroundRecovery,
      options.foreground === true
    );
    if (recoveryTurn.action === 'reuse') return recoveryTurn.recovery;
    if (!runtime || !shouldRecoverWireGuardConnection(runtime.connection)) {
      return { ok: true, skipped: true, reason: 'connection-not-desired' };
    }
    recoveryGate = currentRecoveryGate();
    if (recoveryGate) {
      return { ok: true, skipped: true, reason: recoveryGate };
    }
  }
  const allowPrivileged = options.allowPrivileged !== false;
  wireGuardRecoveryInFlight = (async () => {
    const connection = runtime.connection || {};
    const routePlan = normalizeRoutePlan(connection.routePlan);
    if (!routePlan) return { ok: true, skipped: true, reason: 'missing-route-plan' };
    try {
      const mod = await importInstalledPackage('@qpjoy/electron-launcher/wireguard');
      if (!allowPrivileged) {
        const wireGuardResult = await probeWireGuardForConnection({
          connection,
          routePlan,
          internalBaseUrl: connection.internalBaseUrl
        });
        if (wireGuardResult.ready) {
          wireGuardBackgroundProbeFailures = 0;
        } else if (!manual && connection.state === 'connected') {
          wireGuardBackgroundProbeFailures += 1;
        }
        const routeProofLost = wireGuardResult.diagnostics?.route
          && wireGuardResult.diagnostics.route.ok !== true;
        const ownershipProofLost =
          wireGuardResult.diagnostics?.standaloneOwnershipRegistry?.ok !== true;
        const splitDnsProofLost = (
          wireGuardResult.diagnostics?.windowsNrpt?.configured === true
          && wireGuardResult.diagnostics.windowsNrpt.ready !== true
          && wireGuardResult.diagnostics.windowsNrpt.state !== 'probe-failed'
        ) || (
          process.platform === 'win32'
          && wireGuardResult.diagnostics?.windowsDnsResolution?.proof === 'system-dns-lookup'
          && wireGuardResult.diagnostics.windowsDnsResolution.ready !== true
          && !windowsBrowserAccessReady(connection.diagnostics?.systemDomainProxy)
        ) || (
          process.platform === 'darwin'
          && !systemDomainProxyConnectionReady(connection.diagnostics?.systemDomainProxy)
        );
        const preserveConnected = !manual
          && connection.state === 'connected'
          && !wireGuardResult.ready
          && !routeProofLost
          && !ownershipProofLost
          && !splitDnsProofLost
          && wireGuardBackgroundProbeFailures < WIREGUARD_BACKGROUND_PROBE_DOWNGRADE_THRESHOLD;
        const currentBrowserFallback = connection.diagnostics?.windowsBrowserFallback || {};
        const nextBrowserFallback = wireGuardResult.diagnostics?.windowsBrowserFallback || {};
        const browserFallbackChanged = process.platform === 'win32'
          && ['active', 'browserReady', 'systemDnsReady', 'nonPacProgramsReady']
            .some((key) => currentBrowserFallback[key] !== nextBrowserFallback[key]);
        const shouldPersistProbe = !preserveConnected
          && (
            wireGuardResult.state !== connection.state
            || reason !== 'interval'
            || browserFallbackChanged
          );
        if (shouldPersistProbe) {
          runtime.connection = {
            ...connection,
            state: wireGuardResult.state,
            health: wireGuardResult.health,
            wireGuard: wireGuardResult.wireGuard,
            diagnostics: {
              ...(connection.diagnostics || {}),
              ...wireGuardResult.diagnostics,
              recovery: {
                ok: wireGuardResult.ready,
                action: 'probe-only',
                reason,
                message: wireGuardResult.ready ? 'ready' : wireGuardResult.message,
                missingRoutes: [],
                updatedAt: nowIso()
              }
            }
          };
          if (wireGuardResult.ready && reason !== 'interval') {
            const browserFallbackActive =
              wireGuardResult.diagnostics?.windowsBrowserFallback?.active === true;
            runtime.feedback = {
              tone: 'success',
              message: browserFallbackActive
                ? `MX-H2I 已检测到 WireGuard 与浏览器 PAC 路径 ready（${reason}）；Windows 系统 DNS 仍为 degraded，非 PAC 程序尚未 ready。`
                : `MX-H2I 已检测到 WireGuard ready（${reason}）。`
            };
          } else if (!wireGuardResult.ready && reason !== 'interval') {
            runtime.feedback = {
              tone: 'warning',
              message: `MX-H2I 正在原位校验保留隧道：${wireGuardResult.message}。本机租约会保留；如长时间未恢复，请在高级选项刷新诊断或执行修复网络。`
            };
          } else if (browserFallbackChanged) {
            runtime.feedback = nextBrowserFallback.active === true
              ? {
                  tone: 'warning',
                  message: 'Clash TUN/DoH 已使 Windows 系统 DNS 降级；浏览器继续通过 PAC/local edge 访问 Internal，非 PAC 程序尚未 ready。'
                }
              : nextBrowserFallback.systemDnsReady === true && wireGuardResult.ready
                ? {
                    tone: 'success',
                    message: 'Windows 系统 DNS 已恢复 Internal 解析；浏览器与非 PAC 程序均 ready。'
                  }
                : {
                    tone: 'warning',
                    message: `Windows Internal 网络状态已变化：${wireGuardResult.message}`
                  };
          }
          touchRuntime(`wireguard probed: ${reason}`);
          await saveAndBroadcast();
        } else if (wireGuardResult.ready && feedbackIsWireGuardWarning(runtime.feedback)) {
          runtime.feedback = null;
          runtime.connection = {
            ...connection,
            state: wireGuardResult.state,
            health: wireGuardResult.health,
            wireGuard: wireGuardResult.wireGuard,
            diagnostics: {
              ...(connection.diagnostics || {}),
              ...wireGuardResult.diagnostics,
              recovery: {
                ok: true,
                action: 'probe-only',
                reason,
                message: 'ready',
                missingRoutes: [],
                updatedAt: nowIso()
              }
            }
          };
          touchRuntime(`wireguard ready warning cleared: ${reason}`);
          await saveAndBroadcast();
        } else if (preserveConnected && reason !== 'interval') {
          runtime.connection = {
            ...connection,
            diagnostics: {
              ...(connection.diagnostics || {}),
              backgroundProbe: {
                ok: false,
                action: 'probe-only',
                reason,
                message: wireGuardResult.message,
                consecutiveFailures: wireGuardBackgroundProbeFailures,
                downgradeThreshold: WIREGUARD_BACKGROUND_PROBE_DOWNGRADE_THRESHOLD,
                updatedAt: nowIso()
              }
            }
          };
          runtime.feedback = {
            tone: 'warning',
            message: `MX-H2I 后台探测暂未确认 WireGuard ready，已保持连接状态（${wireGuardBackgroundProbeFailures}/${WIREGUARD_BACKGROUND_PROBE_DOWNGRADE_THRESHOLD}）：${wireGuardResult.message}`
          };
          touchRuntime(`wireguard probe warning: ${reason}`);
          await saveAndBroadcast();
        }
        if (wireGuardResult.ready && runtime.networkHandover) {
          await reconcilePendingNetworkHandoverAfterStartup();
        }
        return {
          ok: true,
          skipped: true,
          reason: 'privileged-recovery-disabled',
          recoveryReason: reason,
          ready: wireGuardResult.ready
        };
      }
      const recovered = await mod.recoverLauncherWireGuardPeer({
        ...wireGuardRuntimeOptions(),
        reason
      });
      if (recovered?.skipped) return recovered;
      const wireGuardResult = await probeWireGuardForConnection({
        connection,
        routePlan,
        internalBaseUrl: connection.internalBaseUrl
      });
      if (wireGuardResult.ready) {
        wireGuardBackgroundProbeFailures = 0;
      }
      runtime.connection = {
        ...connection,
        state: wireGuardResult.state,
        health: wireGuardResult.health,
        wireGuard: wireGuardResult.wireGuard,
        diagnostics: {
          ...wireGuardResult.diagnostics,
          recovery: {
            ok: recovered?.ok !== false,
            action: recovered?.action || recovered?.mode || 'recover',
            reason,
            message: nullableString(recovered?.message),
            missingRoutes: arrayValue(recovered?.missingRoutes, []),
            updatedAt: nowIso()
          }
        }
      };
      runtime.feedback = {
        tone: wireGuardResult.ready ? 'success' : 'warning',
        message: wireGuardResult.ready
          ? `MX-H2I 已恢复 WireGuard 路由（${reason}）。`
          : `MX-H2I 恢复后仍未 ready：${wireGuardResult.message}`
      };
      touchRuntime(`wireguard recovered: ${reason}`);
      await saveAndBroadcast();
      if (wireGuardResult.ready && runtime.networkHandover) {
        await reconcilePendingNetworkHandoverAfterStartup();
      }
      if (recovered?.ok === false || !wireGuardResult.ready) lastWireGuardRecoveryFailureAt = Date.now();
      else lastWireGuardRecoveryFailureAt = 0;
      return {
        ...recovered,
        ready: wireGuardResult.ready,
        route: wireGuardResult.diagnostics?.route || null,
        internalApi: wireGuardResult.diagnostics?.internalApi || null
      };
    } catch (err) {
      lastWireGuardRecoveryFailureAt = Date.now();
      if (manual) {
        runtime.feedback = {
          tone: 'warning',
          message: `MX-H2I 恢复 WireGuard 失败：${errorMessage(err)}`
        };
        touchRuntime(`wireguard recovery failed: ${reason}`);
        await saveAndBroadcast();
      }
      return { ok: false, reason, message: errorMessage(err) };
    } finally {
      wireGuardRecoveryInFlight = null;
    }
  })();
  return wireGuardRecoveryInFlight;
}

function shouldRecoverWireGuardConnection(connection) {
  if (pendingWindowsCleanupDiagnostic(connection)) return false;
  const state = connection?.state;
  return (state === 'connected' || state === 'tunnel-only' || state === 'lease-only' || state === 'server-unavailable' || state === 'network-unavailable')
    && Boolean(normalizeRoutePlan(connection.routePlan));
}

async function stopWireGuardForRuntime(options = {}) {
  try {
    const mod = await importInstalledPackage('@qpjoy/electron-launcher/wireguard');
    const runtimeOptions = wireGuardRuntimeOptions(options);
    if (
      process.platform === 'win32'
      && typeof mod.getLauncherWireGuardNrptStatus === 'function'
    ) {
      try {
        const beforeStatus = mod.getLauncherWireGuardPeerStatus(runtimeOptions);
        const beforeNrpt = await mod.getLauncherWireGuardNrptStatus(runtimeOptions).catch(() => null);
        if (windowsWireGuardCleanupConfirmed(
          { status: beforeStatus },
          beforeNrpt,
          mod.launcherWindowsWireGuardCleanupReady,
          mod.launcherWindowsWireGuardTunnelCleanupReady
        )) {
          return {
            ok: true,
            skipped: true,
            reason: 'windows-wireguard-already-clean',
            status: beforeStatus,
            windowsNrpt: beforeNrpt,
            cleanupReady: true
          };
        }
      } catch {
        // Let stopLauncherWireGuardPeer handle a missing or unreadable profile.
      }
    }
    const result = await mod.stopLauncherWireGuardPeer(runtimeOptions);
    if (process.platform !== 'win32') return result;
    const windowsNrpt = typeof mod.getLauncherWireGuardNrptStatus === 'function'
      ? await mod.getLauncherWireGuardNrptStatus(runtimeOptions).catch((err) => ({
          ready: false,
          state: 'probe-failed',
          error: errorMessage(err),
          namespaces: []
        }))
      : null;
    return {
      ...result,
      windowsNrpt,
      cleanupReady: windowsWireGuardCleanupConfirmed(
        result,
        windowsNrpt,
        mod.launcherWindowsWireGuardCleanupReady,
        mod.launcherWindowsWireGuardTunnelCleanupReady
      )
    };
  } catch (err) {
    return {
      ok: false,
      cleanupReady: false,
      message: errorMessage(err)
    };
  }
}

function windowsWireGuardCleanupConfirmed(result, windowsNrpt, cleanupReady, tunnelCleanupReady) {
  if (process.platform !== 'win32') return true;
  if (typeof cleanupReady === 'function') {
    return cleanupReady(result?.status || null, windowsNrpt || null);
  }
  const tunnelClean = typeof tunnelCleanupReady === 'function'
    ? tunnelCleanupReady(result?.status || null)
    : result?.status?.ok === true
      && result.status.active === false
      && ['NOT_FOUND', 'DOES_NOT_EXIST', 'MISSING'].includes(
        String(result.status.serviceState).toUpperCase()
      )
      && arrayValue(result.status.routes, []).length === 0
      && !nullableString(result.status.ifconfig);
  if (!tunnelClean || !windowsNrpt) return false;
  if (windowsNrpt.state === 'probe-failed') return false;
  if (windowsNrpt.globalRestorePending === true) return false;
  if (Number(windowsNrpt.totalOwnedRuleCount || 0) !== 0) return false;
  if (Number(windowsNrpt.legacyAmbiguousRuleCount || 0) !== 0) return false;
  if (arrayValue(windowsNrpt.unexpectedOwnedNamespaces, []).length > 0) return false;
  return arrayValue(windowsNrpt.namespaces, []).every(
    (namespace) => Number(namespace?.ownedRuleCount || 0) === 0
      && Number(namespace?.legacyAmbiguousRuleCount || 0) === 0
  );
}

function wireGuardRuntimeIsActive(result) {
  return result?.status?.active === true
    || result?.launchDaemon?.running === true
    || result?.launchDaemon?.loaded === true;
}

async function reconcileCredentialStorageFailureAfterStartup() {
  const failure = normalizeCredentialStorageFailure(runtime?.credentialStorageFailure);
  if (!failure) return { ok: true, required: false };

  let preliminarySystemDomainProxy = null;
  let wireGuard = null;
  let systemDomainProxy = null;
  let standaloneOwnership = null;
  try {
    if (process.platform === 'win32') {
      preliminarySystemDomainProxy = await disableSystemDomainProxyForRuntimeStrict(
        'credential-storage-fail-closed-before-wireguard-stop',
        2,
        { keepLocalEdgeAlive: true }
      );
    }
    const darwinRestoreScript = process.platform === 'darwin'
      ? systemDomainProxyManager?.darwinRestoreScript?.() || null
      : null;
    wireGuard = await stopWireGuardForRuntime({
      darwinExtraUninstallShell: darwinRestoreScript
    });
    const wireGuardStillActive = wireGuardRuntimeIsActive(wireGuard);
    const wireGuardStopUnknown = process.platform !== 'win32'
      && wireGuard?.ok === false
      && typeof wireGuard?.status?.active !== 'boolean'
      && !wireGuardStillActive;
    if (
      wireGuardStillActive
      || wireGuardStopUnknown
      || (process.platform === 'win32' && wireGuard?.cleanupReady !== true)
    ) {
      throw new Error(
        wireGuard?.message
        || wireGuard?.error
        || 'Credential fail-closed could not verify WireGuard cleanup.'
      );
    }
    systemDomainProxy = process.platform === 'darwin'
      && darwinRestoreScript
      && wireGuard?.launchDaemon
      ? await completeExternalSystemDomainProxyRestore('credential-storage-fail-closed')
      : await disableSystemDomainProxyForRuntimeStrict(
          'credential-storage-fail-closed',
          2
        );
    if (systemDomainProxy?.error || systemDomainProxy?.applied === true) {
      throw new Error(
        systemDomainProxy?.error
        || 'Credential fail-closed could not verify PAC/split-DNS cleanup.'
      );
    }
    standaloneOwnership = await releaseStandaloneOwnershipForRuntime(
      'credential-storage-fail-closed'
    );
    if (standaloneOwnership?.error || standaloneOwnership?.ok === false) {
      throw new Error(
        standaloneOwnership?.error
        || 'Credential fail-closed could not verify standalone ownership release.'
      );
    }
  } catch (err) {
    const message = errorMessage(err);
    runtime.auth = null;
    runtime.identity = null;
    runtime.networkHandover = null;
    runtime.connection = {
      ...idleConnection(),
      state: 'forbidden',
      mode: failure.previousMode,
      health: blockedHealth(),
      diagnostics: {
        credentialStorageFailure: {
          ok: false,
          cleanupRequired: true,
          message,
          preliminarySystemDomainProxy,
          wireGuard,
          systemDomainProxy,
          standaloneOwnership,
          updatedAt: nowIso()
        },
        updatedAt: nowIso()
      }
    };
    runtime.feedback = {
      tone: 'danger',
      message: `安全存储不可用，旧网络凭据已作废；本机 WireGuard/PAC/ownership 清理尚未确认，已阻止恢复连接：${message}`
    };
    queueDiagnosticError('credential-storage.fail-closed-cleanup-pending', err, {
      wireGuard,
      systemDomainProxy,
      standaloneOwnership
    });
    touchRuntime('credential storage fail-closed cleanup pending');
    await saveRuntime(runtime);
    return { ok: false, required: true, blocked: true, message };
  }

  runtime.credentialStorageFailure = null;
  runtime.auth = null;
  runtime.identity = null;
  runtime.networkHandover = null;
  runtime.leaseCapabilities = {};
  runtime.connection = {
    ...idleConnection(),
    diagnostics: {
      credentialStorageFailure: {
        ok: true,
        cleanupRequired: false,
        message: '旧 WireGuard、PAC/split DNS 与 standalone ownership 已清理。',
        preliminarySystemDomainProxy,
        wireGuard,
        systemDomainProxy,
        standaloneOwnership,
        updatedAt: nowIso()
      },
      updatedAt: nowIso()
    }
  };
  runtime.feedback = {
    tone: 'warning',
    message: '安全存储中的旧凭据不可恢复，已完成本机网络清理并重置身份；请重新登录或连接访客网络。'
  };
  queueDiagnosticLog(
    'warning',
    'credential-storage.fail-closed-cleanup-complete',
    runtime.feedback.message,
    { wireGuard, systemDomainProxy, standaloneOwnership }
  );
  touchRuntime('credential storage fail-closed cleanup complete');
  await saveRuntime(runtime);
  return { ok: true, required: true, cleaned: true };
}

async function reconcileExistingWireGuardAfterStartup() {
  try {
    const mod = await importInstalledPackage('@qpjoy/electron-launcher/wireguard');
    const runtimeOptions = wireGuardRuntimeOptions();
    let status = mod.getLauncherWireGuardPeerStatus(runtimeOptions);
    let connection = runtime?.connection || idleConnection();
    const retainedStartupConnection = isRetainedConnectionState(connection.state)
      && Boolean(normalizeRoutePlan(connection.routePlan));
    const activeIdleOrphan = process.platform === 'win32'
      && status?.active === true
      && !retainedStartupConnection;
    const pendingCleanupAtStartup = pendingWindowsCleanupDiagnostic(connection);
    if (
      process.platform === 'win32'
      && (status?.active !== true || activeIdleOrphan || pendingCleanupAtStartup)
    ) {
      const cleanup = await runWindowsNetworkCleanupOnly('app-startup-orphan');
      const startupCleanup = {
        ok: cleanup.ok === true,
        action: activeIdleOrphan
          ? 'stopped-active-idle-orphan'
          : 'windows-orphan-cleanup',
        cleanupReady: cleanup.cleanupReady === true,
        localEdgeClosePending: cleanup.stage === 'local-edge-finalize',
        ownershipReleasePending: cleanup.stage === 'standalone-ownership-release',
        stage: cleanup.stage,
        message: cleanup.message,
        wireGuard: cleanup.wireGuard || null,
        systemDomainProxy: cleanup.systemDomainProxy || null,
        standaloneOwnership: cleanup.standaloneOwnership || null,
        updatedAt: nowIso()
      };
      if (cleanup.ok !== true) {
        const routePlan = normalizeRoutePlan(connection.routePlan);
        const nextState = !activeIdleOrphan
          && isRetainedConnectionState(connection.state)
          && routePlan
          ? 'lease-only'
          : 'idle';
        runtime.connection = nextState === 'idle'
          ? {
              ...idleConnection(),
              mode: connection.mode === 'employee' ? 'employee' : 'guest',
              diagnostics: {
                ...(connection.diagnostics || {}),
                startupCleanup,
                updatedAt: nowIso()
              }
            }
          : {
              ...connection,
              state: nextState,
              wireGuard: summarizeWireGuardStatus(cleanup.wireGuard?.status || status, connection),
              health: {
                ...normalizeHealth(connection.health, leasedHealth()),
                wireGuard: 'stale',
                internalApi: 'idle',
                splitDns: 'stale'
              },
              diagnostics: {
                ...(connection.diagnostics || {}),
                startupCleanup,
                updatedAt: nowIso()
              }
            };
        if (nextState === 'idle') runtime.auth = null;
        runtime.feedback = {
          tone: 'warning',
          message: `检测到 Windows WireGuard、NRPT、PAC/local edge 或 ownership 遗留，但启动清理未确认完成：${startupCleanup.message}。请在高级选项执行“修复网络”。`
        };
        queueDiagnosticLog('warning', 'wireguard.startup-orphan-cleanup-failed', startupCleanup.message, {
          previousState: connection.state,
          nextState,
          activeIdleOrphan,
          stage: cleanup.stage,
          status: cleanup.wireGuard?.status || status,
          windowsNrpt: cleanup.wireGuard?.windowsNrpt || null,
          systemDomainProxy: cleanup.systemDomainProxy || null,
          standaloneOwnership: cleanup.standaloneOwnership || null
        });
        touchRuntime('startup Windows orphan cleanup required');
        await saveRuntime(runtime);
        return {
          ok: false,
          active: activeIdleOrphan,
          cleanupReady: false,
          cleanup,
          state: runtime.connection.state
        };
      }
      status = cleanup.wireGuard?.status || status;
      const resolvedDiagnostics = {
        ...(connection.diagnostics || {}),
        ...(pendingCleanupAtStartup ? {
          [pendingCleanupAtStartup.key]: {
            ...pendingCleanupAtStartup.value,
            ok: true,
            cleanupReady: true,
            localEdgeClosePending: false,
            ownershipReleasePending: false,
            action: 'startup-cleanup-complete',
            stage: 'complete',
            message: cleanup.message,
            updatedAt: nowIso()
          }
        } : {}),
        startupCleanup,
        updatedAt: nowIso()
      };
      connection = {
        ...connection,
        diagnostics: resolvedDiagnostics
      };
      queueDiagnosticLog('info', 'wireguard.startup-orphan-cleanup-complete', startupCleanup.message, {
        previousState: connection.state,
        activeIdleOrphan,
        status,
        windowsNrpt: cleanup.wireGuard?.windowsNrpt || null,
        standaloneOwnership: cleanup.standaloneOwnership || null
      });
      if (activeIdleOrphan || pendingCleanupAtStartup) {
        runtime.connection = {
          ...idleConnection(),
          mode: connection.mode === 'employee' ? 'employee' : 'guest',
          diagnostics: resolvedDiagnostics
        };
        runtime.auth = null;
        runtime.feedback = {
          tone: 'info',
          message: activeIdleOrphan
            ? '检测到 idle 状态下仍运行的 Windows WireGuard，已主动停止并完成 NRPT、PAC/local edge 与 ownership 清理。'
            : 'Windows 启动遗留清理已完成，当前为未连接。'
        };
        await publishNetworkModeEvent(
          connection.mode === 'employee' ? 'staff:disconnect' : 'visit:disconnect',
          'disconnected',
          {
            leaseIp: connection.localIp,
            reason: activeIdleOrphan ? 'startup-active-idle-orphan-cleaned' : 'startup-cleanup-complete',
            transitionId: makeRequestId('startup-cleanup')
          }
        ).catch((err) => {
          queueDiagnosticError('network-mode.startup-cleanup-publish-failed', err);
        });
        touchRuntime('startup Windows orphan cleanup complete');
        await saveRuntime(runtime);
        return {
          ok: true,
          active: false,
          cleanupReady: true,
          cleaned: true,
          state: 'idle'
        };
      }
    }
    if (status?.active !== true) {
      if (!isRetainedConnectionState(connection.state)) {
        return { ok: true, active: false };
      }
      const routePlan = normalizeRoutePlan(connection.routePlan);
      const nextState = routePlan && ['connected', 'tunnel-only'].includes(connection.state)
        ? 'lease-only'
        : routePlan
          ? connection.state
          : 'idle';
      const startupReconciliation = {
        ok: false,
        action: nextState === 'idle' ? 'reset-to-idle' : `refreshed-as-${nextState}`,
        message: '持久化连接状态与系统 WireGuard 不一致；已以实际未运行状态更新连接证据。',
        updatedAt: nowIso()
      };
      if (nextState !== 'idle') {
        runtime.connection = {
          ...connection,
          state: nextState,
          wireGuard: summarizeWireGuardStatus(status, connection),
          health: {
            ...normalizeHealth(connection.health, leasedHealth()),
            wireGuard: 'stale',
            internalApi: 'idle',
            splitDns: 'idle'
          },
          diagnostics: {
            ...(connection.diagnostics || {}),
            startupReconciliation,
            updatedAt: nowIso()
          }
        };
      } else {
        runtime.connection = {
          ...idleConnection(),
          mode: connection.mode === 'employee' ? 'employee' : 'guest',
          diagnostics: {
            startupReconciliation,
            updatedAt: nowIso()
          }
        };
        runtime.auth = null;
      }
      runtime.feedback = {
        tone: 'warning',
        message: nextState !== 'idle'
          ? '上次的连接记录已过期，系统 WireGuard 未运行。可直接重新连接，不需要先切换到员工登录断开。'
          : '上次的已连接状态已过期，已自动恢复为未连接。'
      };
      await publishNetworkModeEvent(
        connection.mode === 'employee' ? 'staff:disconnect' : 'visit:disconnect',
        'disconnected',
        {
          leaseIp: connection.localIp,
          reason: 'startup-wireguard-inactive',
          transitionId: makeRequestId('startup-reconcile')
        }
      );
      queueDiagnosticLog('warning', 'wireguard.startup-state-downgraded', startupReconciliation.message, {
        previousMode: connection.mode,
        previousState: connection.state,
        nextState: runtime.connection.state,
        wireGuardActive: false,
        retainedRoutePlan: Boolean(routePlan)
      });
      touchRuntime('startup downgraded stale connected state');
      await saveRuntime(runtime);
      return { ok: true, active: false, reconciled: true, state: runtime.connection.state };
    }
    if (isRetainedConnectionState(connection.state) && normalizeRoutePlan(connection.routePlan)) {
      const probe = await probeWireGuardForConnection({
        connection,
        routePlan: connection.routePlan,
        internalBaseUrl: connection.internalBaseUrl
      });
      runtime.connection = {
        ...connection,
        state: probe.state,
        health: probe.health,
        wireGuard: probe.wireGuard,
        diagnostics: {
          ...(connection.diagnostics || {}),
          ...(probe.diagnostics || {}),
          startupReconciliation: {
            ok: probe.ready === true,
            action: 'probed-retained-tunnel',
            message: probe.ready
              ? '已根据系统 WireGuard、路由、Internal API 和 split DNS 实时探测恢复连接。'
              : `系统 WireGuard 存在，但未达到 ready：${probe.message}`,
            updatedAt: nowIso()
          },
          updatedAt: nowIso()
        }
      };
      if (!probe.ready) {
        runtime.feedback = {
          tone: 'warning',
          message: `检测到上次的 WireGuard 仍在，但完整网络证据未 ready：${probe.message}`
        };
      }
      queueDiagnosticLog(
        probe.ready ? 'info' : 'warning',
        'wireguard.startup-retained-probed',
        probe.ready ? 'Retained WireGuard is ready.' : 'Retained WireGuard is not ready.',
        {
          previousMode: connection.mode,
          previousState: connection.state,
          nextState: probe.state,
          wireGuardActive: probe.wireGuard?.active === true,
          routeReady: probe.diagnostics?.route?.ok === true,
          internalApiReady: probe.diagnostics?.internalApi?.ok === true,
          splitDnsReady: probe.health?.splitDns === 'ready',
          windowsNrpt: probe.diagnostics?.windowsNrpt || null,
          message: probe.message
        }
      );
      touchRuntime('startup probed retained WireGuard state');
      await saveRuntime(runtime);
      return { ok: true, active: true, retained: true, ready: probe.ready === true, state: probe.state };
    }
    const employee = runtime?.identity?.kind === 'user'
      || String(runtime?.networkEvent?.name || '').startsWith('staff:');
    const localIp = arrayValue(status.addresses, [])
      .map((address) => String(address || '').split('/')[0])
      .find(Boolean) || nullableString(runtime?.networkEvent?.leaseIp);
    const mode = employee ? 'employee' : 'guest';
    const previousDiagnostics = normalizeDiagnostics(runtime?.connection?.diagnostics);
    runtime.connection = connectedState({
      state: 'tunnel-only',
      mode,
      localIp,
      routePolicy: employee ? 'user full' : 'guest limited',
      subject: employee
        ? nullableString(runtime?.identity?.account) || 'retainedEmployee'
        : 'anonymousPrincipal:retained',
      connectedAt: nowIso(),
      wireGuard: summarizeWireGuardStatus(status, runtime?.connection),
      diagnostics: {
        ...(previousDiagnostics || {}),
        startupReconciliation: {
          ok: false,
          action: 'retained-active-tunnel',
          message: '持久化状态为 idle，但系统 WireGuard 仍在运行。',
          updatedAt: nowIso()
        },
        updatedAt: nowIso()
      },
      health: {
        ...leasedHealth(),
        wireGuard: 'ready',
        internalApi: 'pending',
        splitDns: 'pending'
      }
    });
    runtime.feedback = {
      tone: 'warning',
      message: '检测到上次取消授权后系统 WireGuard 仍在运行；已恢复真实状态。点击“断开连接”并允许一次管理员授权即可完整清理。'
    };
    queueDiagnosticLog('warning', 'wireguard.startup-state-reconciled', runtime.feedback.message, {
      mode,
      localIp,
      interfaceName: status.interfaceName,
      realInterfaceName: status.realInterfaceName,
      launchDaemon: status.launchDaemon
    });
    touchRuntime('startup reconciled active WireGuard from idle state');
    await saveRuntime(runtime);
    return { ok: true, active: true, reconciled: true };
  } catch (err) {
    queueDiagnosticError('wireguard.startup-state-reconcile-failed', err);
    return { ok: false, active: null, error: errorMessage(err) };
  }
}

function wireGuardRuntimeOptions(options = {}) {
  const retainedRoutePlan = normalizeRoutePlan(runtime?.connection?.routePlan);
  const darwinServiceIdentity = {
    ...DARWIN_WIREGUARD_SERVICE_IDENTITY,
    ...(options.darwinExtraInstallShell ? {
      darwinExtraInstallShell: options.darwinExtraInstallShell
    } : {}),
    ...(options.darwinExtraUninstallShell ? {
      darwinExtraUninstallShell: options.darwinExtraUninstallShell
    } : {})
  };
  return {
    userDataDir: app.getPath('userData'),
    profileName: WIREGUARD_PROFILE_NAME,
    allowSystemFallback: false,
    darwinLaunchDaemon: true,
    darwinServiceIdentity,
    nrptCleanupDnsDomains: splitDnsDomains(runtime?.config),
    nrptCleanupDnsServer: retainedRoutePlan?.dnsServer || null
  };
}

function effectiveWireGuardPathPreference(routePlan, _internalDirectPeerSync, configuredPreference) {
  const preference = normalizeRoutePathPreference(configuredPreference);
  if (preference === 'relay') return 'relay';
  if (preference === 'direct') return 'direct';
  if (preference === 'hybrid') return 'hybrid';
  return routePlanHasDirect(routePlan) ? 'direct' : 'relay';
}

function selectWireGuardPathPreference(mod, routePlan, internalDirectPeerSync, configuredPreference) {
  const configured = normalizeRoutePathPreference(configuredPreference);
  const selected = effectiveWireGuardPathPreference(routePlan, internalDirectPeerSync, configured);
  const endpoint = endpointForRoutePreference(routePlan, selected);
  const endpointRoute = endpoint ? mod.probeLauncherWireGuardEndpoint({ endpoint }) : null;
  const shouldFallbackToRelay = (configured === 'auto' || configured === 'hybrid')
    && selected !== 'relay'
    && endpointRoute?.viaProxyTun === true
    && routePlanHasRelay(routePlan);
  if (!shouldFallbackToRelay) {
    return {
      configuredPreference: configured,
      pathPreference: selected,
      endpointRoute,
      fallbackReason: null
    };
  }
  const relayEndpointRoute = mod.probeLauncherWireGuardEndpoint({
    endpoint: routePlan.domesticRelayEndpoint
  });
  return {
    configuredPreference: configured,
    pathPreference: 'relay',
    endpointRoute: relayEndpointRoute,
    fallbackFrom: selected,
    fallbackReason: `direct endpoint route captured by proxy TUN gateway ${endpointRoute.gateway || 'unknown'}`,
    directEndpointRoute: endpointRoute
  };
}

function routePathFromPreference(preference) {
  const normalized = normalizeRoutePathPreference(preference);
  if (normalized === 'direct') return 'h2i-direct';
  if (normalized === 'hybrid' || normalized === 'auto') return 'h2i-hybrid';
  return 'hdi-relay';
}

function endpointForRoutePreference(routePlan, preference) {
  const plan = normalizeRoutePlan(routePlan);
  const normalized = normalizeRoutePathPreference(preference);
  if (normalized === 'relay') return plan?.domesticRelayEndpoint || null;
  return plan?.h2iDirectEndpoint || plan?.domesticRelayEndpoint || null;
}

function wireGuardPathLabel(path) {
  if (path === 'h2i-direct') return 'H2I direct';
  if (path === 'h2i-hybrid') return 'H2I hybrid';
  return 'Domestic relay';
}

function routePlanHasDirect(routePlan) {
  const plan = normalizeRoutePlan(routePlan);
  return plan?.h2iDirectEnabled === true
    && Boolean(plan.h2iDirectEndpoint)
    && Boolean(plan.h2iDirectPublicKey);
}

function routePlanHasRelay(routePlan) {
  const plan = normalizeRoutePlan(routePlan);
  return Boolean(plan?.domesticRelayEndpoint && plan.domesticRelayPublicKey);
}

async function probeInternalApiViaOverlay(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    return {
      ok: false,
      baseUrl: null,
      error: 'Internal API baseUrl 为空。'
    };
  }
  try {
    await requestJson(joinApiUrl(normalized, '/healthz'), { timeoutMs: 2200 });
    return {
      ok: true,
      baseUrl: normalized,
      error: null
    };
  } catch (err) {
    return {
      ok: false,
      baseUrl: normalized,
      error: errorMessage(err)
    };
  }
}

function internalApiProbeBlockedByRoute(baseUrl, targetIp, route) {
  const routeLabel = route?.interfaceName || route?.error || 'unknown route';
  return {
    ok: false,
    baseUrl: normalizeBaseUrl(baseUrl),
    error: route?.viaLoopback
      ? `route to ${targetIp} is local loopback (${routeLabel}); same-host Internal/client test shadows H2I route proof`
      : `route to ${targetIp} is not on WireGuard (${routeLabel})`
  };
}

function wireGuardStatusIsHealthy(status) {
  const missingRoutes = Array.isArray(status?.missingRoutes) ? status.missingRoutes.length : 0;
  return status?.active === true && missingRoutes === 0;
}

function internalApiHealthStatus(route, internalApi) {
  if (internalApi?.ok === true) return 'ready';
  if (route?.viaLoopback) return 'local-route';
  return 'blocked';
}

function wireGuardFailure(message) {
  return {
    state: 'lease-only',
    ready: false,
    health: blockedHealth(),
    wireGuard: {
      ok: false,
      active: false,
      mode: null,
      interfaceName: null,
      realInterfaceName: null,
    configPath: null,
    endpoint: null,
    path: null,
    allowedIps: [],
      statusError: null,
      serviceState: null,
      routeLogPath: null,
      routeLogTail: null,
      peers: [],
      routes: [],
      message,
      error: message,
      updatedAt: nowIso()
    },
    diagnostics: {
      route: null,
      internalApi: null,
      updatedAt: nowIso()
    },
    message
  };
}

function wireGuardAuthorizationCanceledFailure(message) {
  const failure = wireGuardFailure(message || '用户取消了系统授权。');
  return {
    ...failure,
    state: 'authorization-canceled',
    authorizationCanceled: true,
    diagnostics: {
      ...failure.diagnostics,
      authorizationCanceled: {
        ok: false,
        message: failure.message,
        updatedAt: nowIso()
      }
    }
  };
}

function summarizeWireGuardResult(result) {
  const status = result?.status || {};
  const peer = result?.peer || {};
  const tunnel = result?.tunnel || {};
  const message = nullableString(result?.message) || nullableString(tunnel.message);
  return {
    ok: result?.ok === true,
    active: status.active === true,
    mode: nullableString(status.mode) || nullableString(result?.runtime?.method),
    interfaceName: nullableString(status.interfaceName),
    realInterfaceName: nullableString(status.realInterfaceName),
    configPath: nullableString(peer.configPath) || nullableString(tunnel.configPath),
    endpoint: nullableString(peer.endpoint),
    path: nullableString(peer.path),
    allowedIps: arrayValue(peer.allowedIps, arrayValue(status.allowedIps, [])),
    statusError: nullableString(status.error),
    serviceState: nullableString(status.serviceState),
    launchDaemon: normalizeWireGuardLaunchDaemon(result?.launchDaemon || status.launchDaemon || tunnel.launchDaemon),
    routeLogPath: nullableString(status.routeLogPath) || nullableString(tunnel.routeLogPath),
    routeLogTail: tailText(nullableString(status.routeLogTail) || nullableString(tunnel.routeLogTail), 1600),
    peers: Array.isArray(status.peers) ? status.peers : [],
    routes: Array.isArray(status.routes) ? status.routes : [],
    message,
    error: result?.ok === true ? null : message,
    updatedAt: nowIso()
  };
}

function summarizeWireGuardStatus(status, connection = {}) {
  const previous = connection?.wireGuard || {};
  const message = nullableString(status?.error) || nullableString(previous.message);
  return {
    ok: status?.ok !== false,
    active: status?.active === true,
    mode: nullableString(status?.mode) || nullableString(previous.mode),
    interfaceName: nullableString(status?.interfaceName) || nullableString(previous.interfaceName),
    realInterfaceName: nullableString(status?.realInterfaceName) || nullableString(previous.realInterfaceName),
    configPath: nullableString(status?.configPath) || nullableString(previous.configPath),
    endpoint: nullableString(previous.endpoint) || nullableString(connection?.domesticRelayEndpoint),
    path: nullableString(previous.path),
    allowedIps: arrayValue(status?.allowedIps, arrayValue(previous.allowedIps, arrayValue(connection?.routeCidrs, []))),
    statusError: nullableString(status?.error),
    serviceState: nullableString(status?.serviceState) || nullableString(previous.serviceState),
    launchDaemon: normalizeWireGuardLaunchDaemon(status?.launchDaemon || previous.launchDaemon),
    routeLogPath: nullableString(status?.routeLogPath) || nullableString(previous.routeLogPath),
    routeLogTail: tailText(nullableString(status?.routeLogTail) || nullableString(previous.routeLogTail), 1600),
    peers: Array.isArray(status?.peers) ? status.peers : (Array.isArray(previous.peers) ? previous.peers : []),
    routes: Array.isArray(status?.routes) ? status.routes : (Array.isArray(previous.routes) ? previous.routes : []),
    message,
    error: status?.ok === false ? message : null,
    updatedAt: nowIso()
  };
}

async function launcherWindowsNrptStatus(mod, routePlanInput = runtime?.connection?.routePlan) {
  if (process.platform !== 'win32') return null;
  try {
    if (typeof mod?.getLauncherWireGuardNrptStatus !== 'function') {
      throw new Error('electron-launcher does not expose live Windows NRPT status');
    }
    if (typeof mod?.validateLauncherWindowsNrptDesiredState !== 'function') {
      throw new Error('electron-launcher does not expose Windows NRPT desired-state validation');
    }
    const status = await mod.getLauncherWireGuardNrptStatus(wireGuardRuntimeOptions()) || {
      supported: true,
      configured: false,
      ready: true,
      source: 'live-powershell',
      state: 'not-configured',
      tunnelName: WIREGUARD_PROFILE_NAME.replace(/\.conf$/i, ''),
      comment: null,
      queryPolicy: null,
      enableDaForAllNetworks: null,
      globalReady: true,
      namespaces: [],
      missingNamespaces: [],
      mismatchedNamespaces: [],
      error: null
    };
    const routePlan = normalizeRoutePlan(routePlanInput);
    return mod.validateLauncherWindowsNrptDesiredState(status, {
      dnsDomains: splitDnsDomains(runtime?.config),
      dnsServer: routePlan?.dnsServer || null
    });
  } catch (err) {
    return {
      supported: true,
      configured: true,
      ready: false,
      source: 'live-powershell',
      state: 'probe-failed',
      error: errorMessage(err)
    };
  }
}

function windowsNrptReadyForConnection(status) {
  return process.platform !== 'win32' || status?.ready === true;
}

function wireGuardConnectionNotReadyMessage(
  result,
  route,
  internalApi,
  windowsNrpt,
  windowsDnsResolution,
  browserAccess,
  internalDirectPeerSync,
  domesticPeerSync,
  domesticRelayDiagnostics
) {
  if (
    result?.ok === true
    && route?.ok === true
    && internalApi?.ok === true
    && !windowsNrptReadyForConnection(windowsNrpt)
  ) {
    if (windowsNrpt?.profileMissingSplitDns === true) {
      return '当前 Windows WireGuard profile 与 Internal 下发的 split-DNS 域名或 DNS 地址不一致；请重新连接以生成最新 profile。仅修复旧 profile 的路由不能补齐该配置。';
    }
    if (windowsNrpt?.state === 'probe-failed') {
      return `Windows NRPT 实时校验失败：${windowsNrpt.error || '无法读取系统策略'}。当前仅确认隧道与 Internal API 可用，不能把 split DNS 标记为 ready。`;
    }
    const details = [
      arrayValue(windowsNrpt?.missingNamespaces, []).length
        ? `缺少 ${windowsNrpt.missingNamespaces.join(', ')}`
        : null,
      arrayValue(windowsNrpt?.mismatchedNamespaces, []).length
        ? `DNS 不匹配 ${windowsNrpt.mismatchedNamespaces.join(', ')}`
        : null
    ].filter(Boolean).join('；');
    return `Windows split DNS 未 ready（${windowsNrpt?.state || 'unknown'}${details ? `：${details}` : ''}）。请使用“重新连接”或“修复网络”并允许管理员授权。`;
  }
  if (
    process.platform === 'win32'
    && result?.ok === true
    && route?.ok === true
    && internalApi?.ok === true
    && windowsNrptReadyForConnection(windowsNrpt)
    && windowsDnsResolution?.ready !== true
    && browserAccess?.ready !== true
  ) {
    return `Windows NRPT 规则已就绪，但系统端到端解析仍未进入 Internal，且浏览器 PAC/local edge 尚未通过：${windowsDnsResolution?.message || windowsDnsResolution?.error || browserAccess?.error || '未知解析错误'} 当前连接保持 tunnel-only。`;
  }
  if (
    process.platform === 'win32'
    && result?.ok === true
    && route?.ok === true
    && internalApi?.ok === true
    && windowsNrptReadyForConnection(windowsNrpt)
    && windowsDnsResolution?.ready === true
    && splitDnsDomains(runtime?.config).length > 0
    && browserAccess?.ready !== true
  ) {
    return `Windows 系统 DNS 已进入 Internal，但 Chromium/WinINet PAC 或本机 2053 CONNECT 未 ready：${browserAccess?.error || browserAccess?.chromiumProxy?.error || '未知浏览器路径错误'}。当前连接保持 tunnel-only。`;
  }
  return wireGuardNotReadyMessage(
    result,
    route,
    internalApi,
    internalDirectPeerSync,
    domesticPeerSync,
    domesticRelayDiagnostics
  );
}

function wireGuardNotReadyMessage(result, route, internalApi, internalDirectPeerSync, domesticPeerSync, domesticRelayDiagnostics) {
  const peerPath = nullableString(result?.peer?.path);
  if ((peerPath === 'h2i-direct' || peerPath === 'h2i-hybrid') && (internalDirectPeerSync?.status === 'failed' || internalDirectPeerSync?.status === 'blocked')) {
    const reason = internalDirectPeerSync.failures?.[0] || internalDirectPeerSync.error || internalDirectPeerSync.status;
    return `Internal direct peer 未同步：${reason}`;
  }
  if (domesticPeerSync?.status === 'failed' || domesticPeerSync?.status === 'blocked') {
    const reason = domesticPeerSync.failures?.[0] || domesticPeerSync.error || domesticPeerSync.status;
    return `Domestic relay peer 未同步：${reason}`;
  }
  if (domesticRelayDiagnostics?.status === 'failed' || domesticRelayDiagnostics?.status === 'blocked') {
    const reasons = Array.isArray(domesticRelayDiagnostics.blockedReasons)
      ? domesticRelayDiagnostics.blockedReasons
      : Array.isArray(domesticRelayDiagnostics.failures)
        ? domesticRelayDiagnostics.failures
        : [];
    return `Domestic relay 诊断未通过：${reasons[0] || domesticRelayDiagnostics.error || domesticRelayDiagnostics.status}`;
  }
  if (result?.ok !== true) return nullableString(result?.message) || nullableString(result?.tunnel?.message) || 'WireGuard tunnel 未启动。';
  if (route?.ok !== true) {
    if (route?.viaLoopback) return `到 ${route?.targetIp || INTERNAL_PEER_IP} 当前走 lo0，本机 Internal/客户端同机测试会覆盖 overlay 路由。`;
    if (route?.interfaceName && route?.expectedInterfaceName) {
      return `到 ${route.targetIp || INTERNAL_PEER_IP} 当前走 ${route.interfaceName}，期望 ${route.expectedInterfaceName}；可能被系统代理、TUN 或其它路由规则抢先。`;
    }
    return `到 ${route?.targetIp || INTERNAL_PEER_IP} 的路由没有走 MX-H2I WireGuard。`;
  }
  if (internalApi?.ok !== true) return `Internal API overlay 探测失败：${internalApi?.error || 'unknown'}`;
  return 'WireGuard 未 ready。';
}

function internalOverlayBaseUrl(routePlan, fallbackBaseUrl) {
  const internalIp = nullableString(routePlan?.internalControlIp) || INTERNAL_PEER_IP;
  const port = portFromBaseUrl(routePlan?.internalBaseUrl) || portFromBaseUrl(fallbackBaseUrl) || '18090';
  return `http://${internalIp}:${port}`;
}

function internalTargetIp(routePlan, baseUrl) {
  const routePlanIp = nullableString(routePlan?.internalControlIp);
  if (routePlanIp) return routePlanIp;
  try {
    const hostname = new URL(normalizeBaseUrl(baseUrl) || '').hostname;
    return hostname || INTERNAL_PEER_IP;
  } catch {
    return INTERNAL_PEER_IP;
  }
}

function portFromBaseUrl(value) {
  const normalized = normalizeBaseUrl(value);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    if (url.port) return url.port;
    return url.protocol === 'https:' ? '443' : '80';
  } catch {
    return null;
  }
}

async function authenticateUserViaGateway(baseUrl, account, password, requestOptions = {}) {
  const tokenPayload = await requestJson(joinApiUrl(baseUrl, '/internal/v1/sdk/oauth/token'), {
    method: 'POST',
    timeoutMs: 5000,
    bootstrapResolveMode: requestOptions.bootstrapResolveMode,
    body: {
      grant_type: 'password',
      username: account,
      password,
      audience: 'mx-sdk',
      scope: 'auth.read appcenter.read network.hdi.status network.proxy.app network.dns.policy oversea.subscription.ensure',
      requestId: makeRequestId('oauth')
    }
  });
  return gatewayUserAuth(tokenPayload, {
    account,
    fallbackProvider: 'password'
  });
}

async function authenticateFeishuViaGateway(
  baseUrl,
  code,
  redirectUri,
  codeVerifier,
  exchangeHandle,
  requestOptions = {}
) {
  const tokenPayload = await requestJson(joinApiUrl(baseUrl, '/internal/v1/sdk/oauth/feishu/token'), {
    method: 'POST',
    timeoutMs: 10_000,
    bootstrapResolveMode: requestOptions.bootstrapResolveMode,
    body: {
      code,
      redirectUri,
      codeVerifier,
      exchangeHandle,
      audience: 'mx-sdk',
      scope: FEISHU_OAUTH_SCOPE,
      requestId: makeRequestId('feishu-oauth')
    }
  });
  const auth = gatewayUserAuth(tokenPayload);
  if (auth.provider !== 'feishu') {
    throw new Error('Internal 返回的 token 不是飞书身份。');
  }
  return auth;
}

function gatewayUserAuth(tokenPayload, options = {}) {
  const token = tokenPayload?.token || tokenPayload;
  const principal = token?.principal && typeof token.principal === 'object' ? token.principal : {};
  const userId = nullableString(principal.userId) || parseUserIdFromSubject(token?.subject);
  if (!userId) throw new Error('OAuth token 没有返回 user principal。');
  const account = nullableString(principal.email)
    || nullableString(principal.account)
    || nullableString(options.account)
    || userId;
  return {
    accessToken: token.access_token,
    tokenType: token.token_type,
    issuedTokenType: token.issued_token_type,
    issuer: token.issuer,
    audience: token.audience,
    subject: token.subject,
    expiresAt: token.expires_at,
    scopes: typeof token.scope === 'string' ? token.scope.split(/\s+/).filter(Boolean) : [],
    provider: nullableString(token.auth_provider) || nullableString(token.authProvider) || options.fallbackProvider || null,
    user: {
      userId,
      displayName: nullableString(principal.displayName) || displayNameFromAccount(account),
      account,
      email: nullableString(principal.email) || (account.includes('@') ? account : null)
    }
  };
}

async function resolveBootstrapBaseUrl(config) {
  return (await resolveBootstrapEndpoint(config)).baseUrl;
}

async function resolveBootstrapEndpoint(config, options = {}) {
  const requestedMode = normalizeBootstrapResolveMode(config?.bootstrapResolveMode || DEFAULT_CONFIG.bootstrapResolveMode);
  const retainedOverlayBaseUrl = retainedOverlayBootstrapBaseUrl(config);
  const seeds = [
    retainedOverlayBaseUrl,
    normalizeBaseUrl(process.env.MX_H2I_BOOTSTRAP_BASE_URL),
    normalizeBaseUrl(config.bootstrapApiBaseUrl),
    defaultBootstrapApiBaseUrl(),
    defaultPublicBootstrapBaseUrl(config),
    normalizeBaseUrl(process.env.MX_H2I_PUBLIC_BASE_URL),
    normalizeBaseUrl(process.env.MX_H2I_INTERNAL_BASE_URL),
    normalizeBaseUrl(config.internalApiBaseUrl)
  ].filter(Boolean);
  const candidates = bootstrapBaseUrlCandidates(seeds);
  const failures = [];
  for (const candidate of candidates) {
    if (options.requireSecureTransport === true && !feishuTransportIsSecure(candidate)) {
      continue;
    }
    for (const resolveMode of bootstrapResolveAttempts(candidate, config)) {
      try {
        await probeBootstrapApiBaseUrl(candidate, { bootstrapResolveMode: resolveMode });
        return {
          baseUrl: candidate,
          resolveMode,
          fallback: bootstrapResolveFallback(requestedMode, resolveMode, failures),
          preserveConfigBaseUrl: shouldPreserveConfiguredBootstrapBaseUrl(
            candidate,
            config,
            retainedOverlayBaseUrl
          )
        };
      } catch (err) {
        failures.push({
          candidate,
          resolveMode,
          error: err,
          override: hostResolveOverride(candidate, { bootstrapResolveMode: resolveMode })
        });
      }
    }
  }
  throw new Error(`无法连接 bootstrap API：${summarizeBootstrapProbeFailures(failures)}`);
}

function retainedOverlayBootstrapBaseUrl(config) {
  const connection = runtime?.connection || {};
  const routePlan = normalizeRoutePlan(connection.routePlan);
  if (!routePlan) return null;
  if (!shouldPreferRetainedOverlayBootstrap(connection)) return null;
  return internalOverlayBaseUrl(routePlan, connection.internalBaseUrl || config?.internalApiBaseUrl);
}

function shouldPreferRetainedOverlayBootstrap(connection) {
  if (!connection) return false;
  if (!['connected', 'tunnel-only', 'connecting'].includes(connection.state)) return false;
  // Bootstrap can use the already-proven Internal overlay while split DNS is
  // or ownership registry is precisely the layer being repaired. This is a
  // read-only transport decision; final connected readiness still gates both.
  return connectionHasReadyOverlayTransportProof(connection);
}

function shouldAllowPrivilegedPreBootstrapRecovery() {
  const override = nullableString(process.env.MX_H2I_PREBOOTSTRAP_PRIVILEGED_RECOVERY);
  if (override) return !['0', 'false', 'no', 'off'].includes(override.toLowerCase());
  // This path runs only after an explicit Connect/Login action. Background
  // network and wake watchers continue to probe without privilege, while a
  // foreground macOS repair may legitimately surface the system password UI.
  return process.platform === 'win32' || process.platform === 'darwin';
}

function bootstrapResolveAttempts(candidate, config) {
  const mode = normalizeBootstrapResolveMode(config?.bootstrapResolveMode || DEFAULT_CONFIG.bootstrapResolveMode);
  const hasHostOverride = Boolean(hostResolveOverride(candidate, { bootstrapResolveMode: 'env-only' }));
  if (mode === 'env-only') return ['env-only'];
  if (mode === 'dns-only') return ['dns-only'];
  if (mode === 'system-only') return ['system-only'];
  if (bootstrapCandidateShouldPreferDirect(candidate)) {
    return uniqueValues([
      'dns-only',
      ...(hasHostOverride ? ['env-only'] : []),
      'system-only'
    ]);
  }
  if (mode === 'dns-first') return uniqueValues([
    'dns-only',
    ...(hasHostOverride ? ['env-only'] : []),
    'system-only'
  ]);
  return uniqueValues([
    ...(hasHostOverride ? ['env-only'] : []),
    'system-only',
    'dns-only'
  ]);
}

function bootstrapCandidateShouldPreferDirect(candidate) {
  try {
    const hostname = new URL(candidate).hostname;
    return hostname === 'localhost' || net.isIP(hostname) !== 0;
  } catch {
    return false;
  }
}

function shouldPreserveConfiguredBootstrapBaseUrl(candidate, config, retainedOverlayBaseUrl) {
  if (
    retainedOverlayBaseUrl
    && normalizeBaseUrl(candidate) === normalizeBaseUrl(retainedOverlayBaseUrl)
  ) {
    return true;
  }
  const configured = normalizeBaseUrl(config?.bootstrapApiBaseUrl);
  if (!configured || normalizeBaseUrl(candidate) === configured) return false;
  return isDirectPublicBootstrapUrl(candidate);
}

function isDirectPublicBootstrapUrl(value) {
  try {
    const parsed = new URL(normalizeBaseUrl(value) || '');
    return publicBootstrapDialHosts().includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function bootstrapBaseUrlCandidates(seeds) {
  const expanded = [];
  for (const seed of seeds) {
    const normalized = normalizeBaseUrl(seed);
    if (!normalized) continue;
    expanded.push(normalized);
    expanded.push(...bootstrapPortVariantUrls(normalized));
  }
  expanded.push(
    ...LOCAL_INTERNAL_BASE_URLS,
    ...LOCAL_INTERNAL_BASE_URLS.flatMap((baseUrl) => bootstrapPortVariantUrls(baseUrl))
  );
  return uniqueValues(expanded.map((value) => normalizeBaseUrl(value)).filter(Boolean));
}

function bootstrapPortVariantUrls(baseUrl) {
  let parsed;
  try {
    parsed = new URL(normalizeBaseUrl(baseUrl) || '');
  } catch {
    return [];
  }
  const protocol = parsed.protocol.replace(/:$/, '') === 'https' ? 'https' : 'http';
  const host = parsed.hostname.includes(':') ? `[${parsed.hostname}]` : parsed.hostname;
  if (!host) return [];
  return bootstrapPortCandidates(parsed.port, protocol).map((port) => {
    const defaultPort = protocol === 'https' ? '443' : '80';
    return `${protocol}://${host}${String(port) === defaultPort ? '' : `:${port}`}`;
  });
}

function bootstrapPortCandidates(primaryPort, protocol) {
  return uniqueValues([
    ...parseBootstrapPortList(process.env.MX_H2I_BOOTSTRAP_PORTS),
    nullableString(process.env.MX_H2I_BOOTSTRAP_PORT),
    nullableString(primaryPort),
    ...(protocol === 'https' ? ['443'] : ['18090', '8088', '80'])
  ].filter(Boolean))
    .map((port) => String(port).trim())
    .filter((port) => {
      const number = Number(port);
      return Number.isFinite(number) && number > 0 && number <= 65535;
    });
}

function parseBootstrapPortList(value) {
  return String(value || '')
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function defaultPublicBootstrapBaseUrl(config = {}) {
  const explicit = normalizeBaseUrl(process.env.MX_H2I_PUBLIC_BOOTSTRAP_BASE_URL)
    || normalizeBaseUrl(process.env.MX_H2I_DOMESTIC_BOOTSTRAP_BASE_URL);
  if (explicit) return explicit;
  const host = nullableString(config?.domesticRelayHost)
    || defaultDomesticRelayHost();
  if (!host) return null;
  const reference = normalizeBaseUrl(config?.bootstrapApiBaseUrl)
    || defaultBootstrapApiBaseUrl();
  let protocol = 'https';
  let port = nullableString(process.env.MX_H2I_BOOTSTRAP_PORT);
  try {
    const parsed = new URL(reference);
    protocol = parsed.protocol.replace(/:$/, '') || protocol;
    port = parsed.port || port || (protocol === 'https' ? '' : '18090');
  } catch {
    // Keep the default public bootstrap shape.
  }
  const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const defaultPort = protocol === 'https' ? '443' : '80';
  return `${protocol}://${formattedHost}${port && port !== defaultPort ? `:${port}` : ''}`;
}

function bootstrapResolveFallback(requestedMode, resolveMode, failures) {
  if (requestedMode !== 'dns-first' || resolveMode === 'dns-only') return null;
  const dnsFailures = failures.filter((failure) => failure.resolveMode === 'dns-only' && isBootstrapDnsFailure(failure.error));
  if (!dnsFailures.length) return null;
  const retryCount = Math.max(
    BOOTSTRAP_DNS_RETRY_LIMIT,
    ...dnsFailures.map((failure) => Number(failure.error?.dnsRetryCount) || 0)
  );
  return {
    from: 'dns-first',
    to: resolveMode,
    retryCount,
    message: `Bootstrap DNS 连续 ${retryCount} 次未成功，已临时降级到 ${bootstrapResolveModeLabel(resolveMode)} 继续建立 HDI。`
  };
}

function isBootstrapDnsFailure(err) {
  if (!err) return false;
  if (err.code === 'MX_BOOTSTRAP_DNS_FAILED' || err.code === 'MX_BOOTSTRAP_DNS_TIMEOUT') return true;
  return isBootstrapDnsFailure(err.cause);
}

function bootstrapResolveModeLabel(mode) {
  if (mode === 'env-only' || mode === 'env-first') return 'Host Resolve/env-first';
  if (mode === 'system-only') return '系统默认网络/系统代理';
  if (mode === 'dns-only' || mode === 'dns-first') return 'Bootstrap DNS';
  return String(mode || '默认网络');
}

function summarizeBootstrapProbeFailures(failures) {
  const rows = failures.slice(0, 8).map((failure) => {
    const dialUrl = failure.override?.url || failure.error?.dialUrl;
    const resolved = dialUrl && dialUrl !== failure.candidate
      ? ` -> ${dialUrl}`
      : '';
    const mode = bootstrapResolveModeShortLabel(failure.resolveMode);
    return `[${mode}] ${failure.candidate}${resolved}: ${errorMessage(failure.error)}`;
  });
  const hidden = failures.length > rows.length ? `；另有 ${failures.length - rows.length} 个候选失败` : '';
  const hostResolveHint = bootstrapHostResolveHint(failures);
  return `${rows.join('；')}${hidden}${hostResolveHint}`;
}

function bootstrapResolveModeShortLabel(mode) {
  if (mode === 'env-only' || mode === 'env-first') return 'env';
  if (mode === 'system-only') return 'system';
  return 'dns';
}

function bootstrapHostResolveHint(failures) {
  const host = bootstrapHintHost(failures);
  if (!host) return '';
  const apiFailures = failures.filter((failure) => hostnameFromUrl(failure.candidate) === host);
  if (!apiFailures.length) return '';
  const hasOverride = apiFailures.some((failure) => failure.override);
  if (hasOverride) return '';
  return `；Host Resolve 未命中 ${host}，请在 .env 或高级选项设置 MX_H2I_HOST_RESOLVE=${host}=<Domestic公网IP>`;
}

function bootstrapHintHost(failures) {
  const preferred = [
    process.env.MX_H2I_BOOTSTRAP_HOST,
    process.env.MX_H2I_BOOTSTRAP_DOMAIN,
    hostnameFromUrl(process.env.MX_H2I_BOOTSTRAP_BASE_URL),
    hostnameFromUrl(runtime?.config?.bootstrapApiBaseUrl),
    DEFAULT_BOOTSTRAP_HOST,
    'api.mxinfo-inc.cn'
  ].map(nullableString).filter(Boolean);
  const failureHosts = new Set(failures.map((failure) => hostnameFromUrl(failure.candidate)).filter(Boolean));
  return preferred.find((host) => failureHosts.has(host)) || null;
}

async function probeBootstrapApiBaseUrl(baseUrl, options = {}) {
  let bootstrapHealthError = null;
  try {
    await assertHealthResponse(requestJson(joinApiUrl(baseUrl, '/bootstrap-healthz'), {
      timeoutMs: 1400,
      bootstrapResolveMode: options.bootstrapResolveMode
    }));
    return;
  } catch (err) {
    bootstrapHealthError = err;
    if (!shouldFallbackToLegacyHealthz(err)) throw err;
  }
  try {
    await assertHealthResponse(requestJson(joinApiUrl(baseUrl, '/healthz'), {
      timeoutMs: 900,
      bootstrapResolveMode: options.bootstrapResolveMode
    }));
  } catch (err) {
    err.bootstrapHealthError = bootstrapHealthError;
    throw err;
  }
}

async function assertHealthResponse(promise) {
  const payload = await promise;
  if (payload && typeof payload === 'object' && payload.ok === true) return payload;
  const err = new Error('healthz 没有返回 JSON ok=true。');
  err.code = 'MX_HEALTH_PAYLOAD_UNSUPPORTED';
  err.payload = payload;
  throw err;
}

function shouldFallbackToLegacyHealthz(err) {
  if (!err) return false;
  if (err.code === 'MX_HEALTH_PAYLOAD_UNSUPPORTED') return true;
  return /^HTTP (404|405|501)\b/.test(err.message || '');
}

async function applyResolvedBootstrapBaseUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized || normalized === runtime.config.bootstrapApiBaseUrl) return;
  runtime.config = normalizeConfig({
    ...runtime.config,
    bootstrapApiBaseUrl: normalized,
    sdkGatewayBaseUrl: sdkGatewayBaseUrl(normalized)
  });
  runtime.launcherContract = await launcherContract(runtime.config);
}

async function applyResolvedBootstrapEndpoint(bootstrap) {
  const resolution = normalizeBootstrapResolution(bootstrap);
  if (!resolution?.baseUrl) return;
  if (!resolution.preserveConfigBaseUrl) await applyResolvedBootstrapBaseUrl(resolution.baseUrl);
  if (!resolution.fallback?.message) return;
  runtime.feedback = {
    tone: 'warning',
    message: resolution.fallback.message
  };
  touchRuntime('bootstrap dns fallback');
  await saveAndBroadcast();
}

function normalizeBootstrapResolution(input) {
  const row = input && typeof input === 'object' ? input : null;
  if (!row) return null;
  const fallback = row.fallback && typeof row.fallback === 'object' ? row.fallback : null;
  return {
    baseUrl: normalizeBaseUrl(row.baseUrl),
    resolveMode: normalizeBootstrapResolveMode(row.resolveMode),
    fallback: fallback ? {
      from: normalizeBootstrapResolveMode(fallback.from),
      to: normalizeBootstrapResolveMode(fallback.to),
      retryCount: Number.isFinite(fallback.retryCount) ? fallback.retryCount : null,
      message: nullableString(fallback.message)
    } : null,
    preserveConfigBaseUrl: row.preserveConfigBaseUrl === true
  };
}

function normalizeRoutePlan(input) {
  const row = input && typeof input === 'object' ? input : null;
  if (!row) return null;
  return {
    productId: nullableString(row.productId) || launcherProductId(),
    launcherMode: nullableString(row.launcherMode) || 'standalone',
    identityKind: nullableString(row.identityKind) || 'anonymous',
    leaseIp: nullableString(row.leaseIp),
    leaseCidr: nullableString(row.leaseCidr),
    serviceVip: nullableString(row.serviceVip),
    internalControlIp: nullableString(row.internalControlIp),
    internalBaseUrl: nullableString(row.internalBaseUrl),
    domesticGatewayIp: nullableString(row.domesticGatewayIp),
    domesticRelayEndpoint: nullableString(row.domesticRelayEndpoint),
    domesticRelayPublicKey: nullableString(row.domesticRelayPublicKey),
    preferredPath: normalizeRoutePlanPath(row.preferredPath),
    h2iDirectEnabled: row.h2iDirectEnabled === true,
    h2iDirectEndpoint: nullableString(row.h2iDirectEndpoint),
    h2iDirectPublicKey: nullableString(row.h2iDirectPublicKey),
    h2iDirectAllowedIps: arrayValue(row.h2iDirectAllowedIps, []),
    domesticSiteId: nullableString(row.domesticSiteId),
    overseaSiteId: nullableString(row.overseaSiteId),
    dnsServer: nullableString(row.dnsServer),
    allowedIps: arrayValue(row.allowedIps, []),
    routeCidrs: arrayValue(row.routeCidrs, []),
    updatePolicy: nullableString(row.updatePolicy),
    rateLimitProfile: nullableString(row.rateLimitProfile),
    dnsPolicyId: nullableString(row.dnsPolicyId),
    licensePolicyId: nullableString(row.licensePolicyId),
    snapshotId: nullableString(row.snapshotId),
    snapshotDigest: nullableString(row.snapshotDigest),
    materialDigest: nullableString(row.materialDigest),
    secretUpdatedAt: nullableString(row.secretUpdatedAt),
    refreshKey: nullableString(row.refreshKey)
  };
}

async function requestJson(url, options = {}) {
  const resolveMode = normalizeBootstrapResolveMode(
    options.bootstrapResolveMode || runtime?.config?.bootstrapResolveMode || DEFAULT_CONFIG.bootstrapResolveMode
  );
  const hostOverride = await requestHostOverride(url, { bootstrapResolveMode: options.bootstrapResolveMode });
  if (hostOverride) return requestJsonWithHostOverride(hostOverride, options);
  if (resolveMode === 'system-only') return requestJsonWithSystemNetwork(url, options);
  const result = await requestTextWithFetch(url, options);
  const payload = parseJsonPayload(result.text);
  if (result.status < 200 || result.status >= 300) {
    const err = new Error(`HTTP ${result.status}${result.statusText ? ` ${result.statusText}` : ''}`);
    err.payload = payload;
    throw err;
  }
  return payload;
}

async function requestText(url, options = {}) {
  const resolveMode = normalizeBootstrapResolveMode(
    options.bootstrapResolveMode || runtime?.config?.bootstrapResolveMode || DEFAULT_CONFIG.bootstrapResolveMode
  );
  const hostOverride = await requestHostOverride(url, { bootstrapResolveMode: options.bootstrapResolveMode });
  const result = hostOverride
    ? await requestTextWithHostOverride(hostOverride, options)
    : resolveMode === 'system-only'
      ? await requestTextWithSystemNetwork(url, options)
      : await requestTextWithFetch(url, options);
  if (result.status < 200 || result.status >= 300) {
    const err = new Error(`HTTP ${result.status}${result.statusText ? ` ${result.statusText}` : ''}`);
    err.payload = result.text;
    throw err;
  }
  return result.text;
}

// 插件 tarball 走和 Internal API 完全相同的一条网络路径（Host Resolve + SNI 覆写、
// bootstrap DNS、system-only 回退），这样公司网络里能取到 API 就一定能取到插件包。
async function requestBuffer(url, options = {}) {
  const resolveMode = normalizeBootstrapResolveMode(
    options.bootstrapResolveMode || runtime?.config?.bootstrapResolveMode || DEFAULT_CONFIG.bootstrapResolveMode
  );
  const hostOverride = await requestHostOverride(url, { bootstrapResolveMode: options.bootstrapResolveMode });
  const result = hostOverride
    ? await requestTextWithHostOverride(hostOverride, options)
    : resolveMode === 'system-only'
      ? await requestTextWithSystemNetwork(url, options)
      : await requestTextWithFetch(url, options);
  if (result.status < 200 || result.status >= 300) {
    const err = new Error(`HTTP ${result.status}${result.statusText ? ` ${result.statusText}` : ''}`);
    err.originalUrl = url;
    throw err;
  }
  return Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.text || '', 'utf8');
}

function requestJsonWithHostOverride(override, options = {}) {
  return requestTextWithHostOverride(override, options).then((result) => {
    const payload = parseJsonPayload(result.text);
    if (result.status < 200 || result.status >= 300) {
      const err = new Error(`HTTP ${result.status}${result.statusText ? ` ${result.statusText}` : ''}`);
      err.payload = payload;
      err.dialUrl = override.url;
      err.originalUrl = override.originalUrl;
      err.bootstrapResolveMode = override.resolveMode;
      throw err;
    }
    return payload;
  });
}

function requestJsonWithSystemNetwork(url, options = {}) {
  return requestTextWithSystemNetwork(url, options).then((result) => {
    const payload = parseJsonPayload(result.text);
    if (result.status < 200 || result.status >= 300) {
      const err = new Error(`HTTP ${result.status}${result.statusText ? ` ${result.statusText}` : ''}`);
      err.payload = payload;
      err.originalUrl = url;
      err.bootstrapResolveMode = 'system-only';
      throw err;
    }
    return payload;
  });
}

function launcherFetchForBootstrap(resolveMode) {
  const mode = normalizeBootstrapResolveMode(resolveMode);
  return async (url, init = {}) => {
    const hostOverride = await requestHostOverride(String(url), { bootstrapResolveMode: mode });
    if (!hostOverride) {
      if (mode === 'system-only') {
        const result = await requestTextWithSystemNetwork(String(url), {
          method: init.method || 'GET',
          headers: init.headers,
          body: init.body,
          timeoutMs: 10000
        });
        return new Response(result.text, {
          status: result.status,
          statusText: result.statusText,
          headers: result.headers
        });
      }
      if (typeof fetch !== 'function') throw new Error('当前 Electron 运行时没有 fetch。');
      return fetch(url, init);
    }
    const result = await requestTextWithHostOverride(hostOverride, {
      method: init.method || 'GET',
      headers: init.headers,
      body: init.body,
      timeoutMs: 10000
    });
    return new Response(result.text, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers
    });
  };
}

function requestTextWithHostOverride(override, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(override.url);
    const method = requestMethod(options.method);
    const body = requestBodyForMethod(method, options.body);
    const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 6000;
    const headers = {
      ...normalizeRequestHeaders(options.headers),
      accept: 'application/json',
      host: override.hostHeader,
      ...bootstrapForwardHeaders(override, target)
    };
    if (body !== undefined) {
      if (!hasRequestHeader(headers, 'content-type')) headers['content-type'] = 'application/json';
      if (!hasRequestHeader(headers, 'content-length')) headers['content-length'] = String(Buffer.byteLength(body));
    }
    const client = target.protocol === 'https:' ? https : http;
    const request = client.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      servername: override.servername,
      timeout
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          text: body.toString('utf8'),
          body,
          status: response.statusCode || 0,
          statusText: response.statusMessage || '',
          headers: response.headers
        });
      });
    });
    request.on('timeout', () => {
      const err = new Error(`请求超时：${override.originalUrl || ''} -> ${override.url}`);
      err.code = 'MX_BOOTSTRAP_TIMEOUT';
      err.dialUrl = override.url;
      err.originalUrl = override.originalUrl;
      err.bootstrapResolveMode = override.resolveMode;
      request.destroy(err);
    });
    request.on('error', (err) => {
      err.dialUrl = err.dialUrl || override.url;
      err.originalUrl = err.originalUrl || override.originalUrl;
      err.bootstrapResolveMode = err.bootstrapResolveMode || override.resolveMode;
      reject(err);
    });
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function requestTextWithSystemNetwork(url, options = {}) {
  if (!electronNet?.request) return requestTextWithFetch(url, options, 'system-only');
  try {
    return await requestTextWithElectronNet(url, options);
  } catch (err) {
    if (!isElectronNetInvalidArgument(err)) throw err;
    return requestTextWithFetch(url, options, 'system-only');
  }
}

function requestTextWithElectronNet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const method = requestMethod(options.method);
    const body = requestBodyForMethod(method, options.body);
    const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 6000;
    const headers = {
      accept: 'application/json',
      ...normalizeRequestHeaders(options.headers)
    };
    if (body !== undefined) {
      if (!hasRequestHeader(headers, 'content-type')) headers['content-type'] = 'application/json';
      if (!hasRequestHeader(headers, 'content-length')) headers['content-length'] = String(Buffer.byteLength(body));
    }
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    const request = electronNet.request({
      method,
      url
    });
    for (const [key, value] of Object.entries(headers)) {
      request.setHeader(key, value);
    }
    timer = setTimeout(() => {
      const err = new Error(`请求超时：${url}`);
      err.code = 'MX_BOOTSTRAP_TIMEOUT';
      err.originalUrl = url;
      err.bootstrapResolveMode = 'system-only';
      request.abort();
      finish(reject, err);
    }, timeout);
    request.on('response', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        finish(resolve, {
          text: body.toString('utf8'),
          body,
          status: response.statusCode || 0,
          statusText: response.statusMessage || '',
          headers: response.headers || {}
        });
      });
    });
    request.on('error', (err) => {
      err.originalUrl = err.originalUrl || url;
      err.bootstrapResolveMode = err.bootstrapResolveMode || 'system-only';
      finish(reject, err);
    });
    try {
      if (body !== undefined) request.write(body);
      request.end();
    } catch (err) {
      err.originalUrl = err.originalUrl || url;
      err.bootstrapResolveMode = err.bootstrapResolveMode || 'system-only';
      finish(reject, err);
    }
  });
}

function isElectronNetInvalidArgument(err) {
  return /ERR_INVALID_ARGUMENT|invalid argument/i.test(`${err?.code || ''} ${err?.message || ''}`);
}

async function requestTextWithFetch(url, options = {}, resolveMode = null) {
  if (typeof fetch !== 'function') throw new Error('当前 Electron 运行时没有 fetch。');
  const controller = new AbortController();
  const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 6000;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const method = requestMethod(options.method);
    const body = requestBodyForMethod(method, options.body);
    const headers = {
      accept: 'application/json',
      ...normalizeRequestHeaders(options.headers)
    };
    if (body !== undefined && !hasRequestHeader(headers, 'content-type')) {
      headers['content-type'] = 'application/json';
    }
    const response = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: controller.signal
    });
    const payload = Buffer.from(await response.arrayBuffer());
    return {
      text: payload.toString('utf8'),
      body: payload,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    };
  } catch (err) {
    if (resolveMode) err.bootstrapResolveMode = err.bootstrapResolveMode || resolveMode;
    err.originalUrl = err.originalUrl || url;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function requestMethod(method) {
  return String(method || 'GET').toUpperCase();
}

function requestBodyForMethod(method, body) {
  if (body === undefined || body === null) {
    return method !== 'GET' && method !== 'HEAD' ? '{}' : undefined;
  }
  if (typeof body === 'string' || Buffer.isBuffer(body)) return body;
  return JSON.stringify(body);
}

function normalizeRequestHeaders(headers) {
  let entries = [];
  if (!headers) return {};
  if (typeof headers.entries === 'function') {
    entries = [...headers.entries()];
  } else if (Array.isArray(headers)) {
    entries = headers;
  } else if (typeof headers === 'object') {
    entries = Object.entries(headers);
  }
  return Object.fromEntries(entries
    .filter(([key, value]) => key && value !== undefined && value !== null)
    .map(([key, value]) => [
      String(key),
      Array.isArray(value) ? value.map((item) => String(item)).join(', ') : String(value)
    ]));
}

function hasRequestHeader(headers, name) {
  const lowerName = String(name).toLowerCase();
  return Object.keys(headers || {}).some((key) => key.toLowerCase() === lowerName);
}

function diagnosticLogDirPath() {
  return path.join(app.getPath('userData'), DIAGNOSTIC_LOG_DIR_NAME);
}

function diagnosticLogFilePath(rotation = 0) {
  const suffix = rotation > 0 ? `.${rotation}` : '';
  return path.join(diagnosticLogDirPath(), `${DIAGNOSTIC_LOG_FILE_NAME}${suffix}`);
}

function queueDiagnosticLog(level, event, message, details = null) {
  const entry = {
    at: nowIso(),
    level: ['warning', 'error'].includes(level) ? level : 'info',
    event: nullableString(event) || 'runtime',
    message: sanitizeDiagnosticText(message),
    details: sanitizeDiagnosticValue(details)
  };
  recentDiagnosticLogs = [entry, ...recentDiagnosticLogs].slice(0, DIAGNOSTIC_RECENT_LIMIT);
  const line = `${JSON.stringify(entry)}\n`;
  diagnosticLogQueue = diagnosticLogQueue
    .then(() => appendDiagnosticLogLine(line))
    .catch((err) => {
      console.warn('[mx-h2i] diagnostic log write failed:', errorMessage(err));
    });
}

function queueDiagnosticError(event, err, details = null) {
  queueDiagnosticLog('error', event, errorMessage(err), {
    ...(details && typeof details === 'object' ? details : {}),
    name: nullableString(err?.name),
    code: nullableString(err?.code),
    signal: nullableString(err?.signal),
    killed: err?.killed === true,
    stderr: diagnosticOutputTail(err?.stderr),
    stdout: diagnosticOutputTail(err?.stdout),
    stack: diagnosticOutputTail(err?.stack, 6000)
  });
}

async function appendDiagnosticLogLine(line) {
  if (!diagnosticLogDirReady) {
    await fs.mkdir(diagnosticLogDirPath(), { recursive: true });
    diagnosticLogDirReady = true;
  }
  if (!Number.isFinite(diagnosticLogBytes)) {
    diagnosticLogBytes = await fs.stat(diagnosticLogFilePath()).then((stat) => stat.size).catch(() => 0);
  }
  const bytes = Buffer.byteLength(line);
  if (diagnosticLogBytes + bytes > DIAGNOSTIC_LOG_MAX_BYTES) {
    await rotateDiagnosticLogs();
    diagnosticLogBytes = 0;
  }
  await fs.appendFile(diagnosticLogFilePath(), line, 'utf8');
  diagnosticLogBytes += bytes;
}

async function rotateDiagnosticLogs() {
  for (let index = DIAGNOSTIC_LOG_ROTATIONS; index >= 1; index -= 1) {
    const source = diagnosticLogFilePath(index - 1);
    const target = diagnosticLogFilePath(index);
    await fs.rm(target, { force: true }).catch(() => undefined);
    await fs.rename(source, target).catch((err) => {
      if (err?.code !== 'ENOENT') throw err;
    });
  }
}

function diagnosticLogStatus() {
  return {
    enabled: true,
    fileName: DIAGNOSTIC_LOG_FILE_NAME,
    maxBytes: DIAGNOSTIC_LOG_MAX_BYTES,
    rotations: DIAGNOSTIC_LOG_ROTATIONS,
    recent: recentDiagnosticLogs.slice(0, 12)
  };
}

function sanitizeDiagnosticValue(value, key = '', depth = 0) {
  if (value === undefined || value === null) return null;
  if (/token|password|private.?key|secret|capability|authorization|cookie|code.?verifier|exchange.?handle|authorization.?code|login.?ticket|^(?:code|ticket|state)$/i.test(key)) return '[redacted]';
  if (typeof value === 'string') return sanitizeDiagnosticText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 6) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, 80).map((item) => sanitizeDiagnosticValue(item, key, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 120).map(([childKey, childValue]) => [
      childKey,
      sanitizeDiagnosticValue(childValue, childKey, depth + 1)
    ]));
  }
  return sanitizeDiagnosticText(String(value));
}

function sanitizeDiagnosticText(value) {
  const text = String(value ?? '')
    .replace(/(authorization:\s*bearer\s+)[^\s]+/ig, '$1[redacted]')
    .replace(/([?&](?:token|access_token|password|secret|key|capability|code|authorization_code|ticket|code_verifier|exchange_handle|state)=)[^&\s]+/ig, '$1[redacted]');
  return text.length > 8000 ? `${text.slice(0, 7997)}...` : text;
}

function diagnosticOutputTail(value, limit = 3000) {
  const text = sanitizeDiagnosticText(value);
  return text.length > limit ? text.slice(-limit) : text;
}

async function exportDiagnosticBundle(parentDir) {
  queueDiagnosticLog('info', 'diagnostics.export-started', 'User requested a diagnostic bundle.');
  await diagnosticLogQueue;
  const folderName = `MX-H2I-diagnostics-${nowIso().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')}-${randomUUID().slice(0, 6)}`;
  const folderPath = path.join(parentDir, folderName);
  await fs.mkdir(folderPath, { recursive: false });
  const networkDiagnostics = await collectNetworkEnvironmentDiagnostics('diagnostic-export', {
    phase: networkDiagnosticPhase()
  });
  const summary = diagnosticBundleSummary(networkDiagnostics);
  await Promise.all([
    writeDiagnosticJson(path.join(folderPath, 'summary.json'), summary),
    writeDiagnosticJson(path.join(folderPath, 'network-diagnostics.json'), networkDiagnostics),
    copyDiagnosticRuntimeLogs(folderPath),
    copyWireGuardRouteLog(folderPath),
    collectPlatformDiagnosticFiles(folderPath),
    fs.writeFile(path.join(folderPath, 'README.txt'), diagnosticBundleReadme(), 'utf8')
  ]);
  queueDiagnosticLog('info', 'diagnostics.export-completed', 'Diagnostic bundle exported.', { folderName });
  return { folderName, folderPath };
}

function diagnosticBundleSummary(networkDiagnostics) {
  const connection = runtime?.connection || {};
  const wireGuard = connection.wireGuard || {};
  return {
    exportedAt: nowIso(),
    app: {
      name: PRODUCT_DISPLAY_NAME,
      version: currentReleaseVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform,
      release: require('node:os').release(),
      arch: process.arch,
      packaged: app.isPackaged
    },
    update: {
      runningVersion: currentReleaseVersion(),
      currentVersion: runtime?.update?.currentVersion || null,
      latestVersion: runtime?.update?.latestVersion || null,
      status: runtime?.update?.status || null,
      updateAvailable: runtime?.update?.updateAvailable === true,
      lastCheckedAt: runtime?.update?.lastCheckedAt || null
    },
    ownership: {
      ownerId: standaloneOwnershipOwnerId(),
      installationId: runtime?.installation?.installId || null,
      ownershipInstanceId: standaloneOwnershipInstanceId()
    },
    connection: {
      state: connection.state,
      mode: connection.mode,
      localIp: connection.localIp,
      routePolicy: connection.routePolicy,
      health: connection.health,
      routeCidrs: connection.routeCidrs,
      wireGuard: {
        active: wireGuard.active,
        ready: wireGuard.ready,
        path: wireGuard.path,
        interfaceName: wireGuard.interfaceName,
        realInterfaceName: wireGuard.realInterfaceName,
        endpoint: wireGuard.endpoint,
        allowedIps: wireGuard.allowedIps,
        serviceState: wireGuard.serviceState,
        statusError: wireGuard.statusError,
        routeLogPath: wireGuard.routeLogPath
      }
    },
    networkEvent: runtime?.networkEvent || null,
    networkDiagnostics,
    recentLogs: recentDiagnosticLogs,
    activity: runtime?.activity || []
  };
}

async function writeDiagnosticJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(sanitizeDiagnosticValue(value), null, 2)}\n`, 'utf8');
}

async function copyDiagnosticRuntimeLogs(folderPath) {
  const targetDir = path.join(folderPath, 'runtime-logs');
  await fs.mkdir(targetDir, { recursive: true });
  for (let rotation = 0; rotation <= DIAGNOSTIC_LOG_ROTATIONS; rotation += 1) {
    const source = diagnosticLogFilePath(rotation);
    const target = path.join(targetDir, path.basename(source));
    await fs.copyFile(source, target).catch((err) => {
      if (err?.code !== 'ENOENT') throw err;
    });
  }
}

async function copyWireGuardRouteLog(folderPath) {
  const routeLogPath = nullableString(runtime?.connection?.wireGuard?.routeLogPath);
  if (!routeLogPath || !path.isAbsolute(routeLogPath)) return;
  await fs.copyFile(routeLogPath, path.join(folderPath, 'wireguard-route-audit.log')).catch((err) => {
    if (err?.code !== 'ENOENT') throw err;
  });
}

async function collectPlatformDiagnosticFiles(folderPath) {
  if (process.platform === 'win32') {
    await collectWindowsDiagnosticFiles(folderPath);
    return;
  }
  if (process.platform === 'darwin') {
    const [dns, proxy, route] = await Promise.all([
      captureDiagnosticCommand('/usr/sbin/scutil', ['--dns'], 8000),
      captureDiagnosticCommand('/usr/sbin/scutil', ['--proxy'], 4000),
      captureDiagnosticCommand('/sbin/route', ['-n', 'get', 'default'], 4000)
    ]);
    await writeDiagnosticJson(path.join(folderPath, 'macos-network.json'), { dns, proxy, route });
  }
}

async function collectWindowsDiagnosticFiles(folderPath) {
  const powershellScript = [
    "$ErrorActionPreference = 'Stop'",
    'function Invoke-MxCapture([scriptblock]$Action) {',
    '  try { return @{ ok = $true; value = @(& $Action); error = $null } }',
    '  catch { return @{ ok = $false; value = @(); error = $_.Exception.Message } }',
    '}',
    '$result = [ordered]@{',
    "  capturedAt = (Get-Date).ToUniversalTime().ToString('o')",
    '  nrptGlobal = Invoke-MxCapture { Get-DnsClientNrptGlobal | Select-Object -Property EnableDAForAllNetworks,QueryPolicy,SecureNameQueryFallback -First 1 }',
    '  nrptPolicy = Invoke-MxCapture { Get-DnsClientNrptPolicy -Effective | Select-Object -Property Namespace,NameServers,Comment,DisplayName,DirectAccessEnabled -First 256 }',
    '  nrptRules = Invoke-MxCapture { Get-DnsClientNrptRule | Select-Object -Property Namespace,NameServers,Comment,DisplayName,DirectAccessEnabled -First 256 }',
    '  dnsServers = Invoke-MxCapture { Get-DnsClientServerAddress | Select-Object -Property InterfaceAlias,InterfaceIndex,AddressFamily,ServerAddresses -First 128 }',
    '  dnsGlobal = Invoke-MxCapture { Get-DnsClientGlobalSetting | Select-Object -Property SuffixSearchList,UseDevolution,DevolutionLevel -First 1 }',
    '  ipConfiguration = Invoke-MxCapture { Get-NetIPConfiguration | Select-Object -Property InterfaceAlias,InterfaceIndex,@{ Name = "NetworkCategory"; Expression = { $_.NetProfile.NetworkCategory } },@{ Name = "IPv4Addresses"; Expression = { @($_.IPv4Address | ForEach-Object { $_.IPAddress }) } },@{ Name = "IPv6Addresses"; Expression = { @($_.IPv6Address | ForEach-Object { $_.IPAddress }) } },@{ Name = "IPv4DefaultGateways"; Expression = { @($_.IPv4DefaultGateway | ForEach-Object { $_.NextHop }) } },@{ Name = "DnsServers"; Expression = { @($_.DNSServer | ForEach-Object { $_.ServerAddresses }) } } -First 128 }',
    "  internetSettings = Invoke-MxCapture { Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' | Select-Object AutoConfigURL,ProxyEnable,ProxyServer,ProxyOverride,AutoDetect }",
    '  tcpListeners = Invoke-MxCapture { Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in @(2053,8080,23455,23456,23457,23458) } | Select-Object -Property LocalAddress,LocalPort,OwningProcess,State -First 64 }',
    '  networkAdapters = Invoke-MxCapture { Get-NetAdapter | Select-Object -Property Name,InterfaceDescription,Status,ifIndex,LinkSpeed,MacAddress -First 128 }',
    '}',
    '$result | ConvertTo-Json -Depth 5 -Compress'
  ].join('\r\n');
  const powershell = await captureDiagnosticCommand(windowsPowerShellCommandForDiagnostics(), [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    powershellScript
  ], 15_000);
  const ipconfig = await captureDiagnosticCommand(windowsSystemCommand('ipconfig.exe'), ['/all'], 12_000);
  const route = await captureDiagnosticCommand(windowsSystemCommand('route.exe'), ['print'], 12_000);
  const winHttp = await captureDiagnosticCommand(windowsSystemCommand('netsh.exe'), ['winhttp', 'show', 'proxy'], 8000);
  const parsedPowershell = powershell.ok
    ? parseJsonText(powershell.stdout) || { parseError: 'PowerShell output was not valid JSON.', raw: powershell.stdout }
    : powershell;
  await Promise.all([
    writeDiagnosticJson(path.join(folderPath, 'windows-dns-nrpt.json'), parsedPowershell),
    fs.writeFile(path.join(folderPath, 'windows-ipconfig-all.txt'), diagnosticCommandText(ipconfig), 'utf8'),
    fs.writeFile(path.join(folderPath, 'windows-route-print.txt'), diagnosticCommandText(route), 'utf8'),
    fs.writeFile(path.join(folderPath, 'windows-winhttp-proxy.txt'), diagnosticCommandText(winHttp), 'utf8')
  ]);
}

async function captureDiagnosticCommand(command, args, timeoutMs) {
  try {
    const stdout = await execFileText(command, args, { timeoutMs });
    return { ok: true, command: path.basename(command), stdout, stderr: '', capturedAt: nowIso() };
  } catch (err) {
    const result = {
      ok: false,
      command: path.basename(command),
      code: nullableString(err?.code),
      signal: nullableString(err?.signal),
      error: errorMessage(err),
      stdout: diagnosticOutputTail(err?.stdout, 16_000),
      stderr: diagnosticOutputTail(err?.stderr, 16_000),
      capturedAt: nowIso()
    };
    queueDiagnosticLog('error', 'diagnostics.command-failed', result.error, result);
    return result;
  }
}

function windowsSystemCommand(fileName) {
  const systemRoot = nullableString(process.env.SystemRoot);
  if (!systemRoot) return fileName;
  const candidate = path.join(systemRoot, 'System32', fileName);
  return fsSync.existsSync(candidate) ? candidate : fileName;
}

function windowsPowerShellCommandForDiagnostics() {
  const systemRoot = nullableString(process.env.SystemRoot);
  if (!systemRoot) return 'powershell.exe';
  const candidate = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fsSync.existsSync(candidate) ? candidate : 'powershell.exe';
}

function diagnosticCommandText(result) {
  const lines = [
    `ok=${result.ok}`,
    `command=${result.command || '-'}`,
    `capturedAt=${result.capturedAt || '-'}`,
    result.error ? `error=${result.error}` : '',
    result.stderr ? `stderr:\n${result.stderr}` : '',
    result.stdout ? `stdout:\n${result.stdout}` : ''
  ];
  return `${lines.filter(Boolean).join('\n')}\n`;
}

function parseJsonText(value) {
  try {
    return JSON.parse(String(value || '').trim());
  } catch {
    return null;
  }
}

function diagnosticBundleReadme() {
  return [
    'MX-H2I 运行诊断包',
    '',
    'summary.json：应用、连接、最近错误和活动摘要。',
    'network-diagnostics.json：MX-H2I DNS、PAC、WireGuard 与域名解析诊断。',
    'runtime-logs/：异步滚动运行日志（NDJSON，每行一个事件）。',
    'wireguard-route-audit.log：WireGuard 服务审计；Windows 上包含 NRPT add/remove/assert 和失败原因。',
    'windows-dns-nrpt.json：Windows 实时 NRPT、WinINET 系统代理、关键本地监听端口、网卡和 DNS。',
    'windows-ipconfig-all.txt / windows-route-print.txt / windows-winhttp-proxy.txt：Windows 网络、路由和 WinHTTP 代理快照。',
    '',
    '日志会自动隐藏常见 token、密码、私钥和 Authorization 字段。',
    '诊断包仍可能包含本机 IP、网卡、DNS 后缀、路由和员工账号相关网络信息，请仅发送给可信的排查人员。',
    ''
  ].join('\n');
}

function visibleRuntime(source = runtime) {
  const {
    leaseCapabilities: _leaseCapabilities,
    encryptedLeaseCapabilities: _encryptedLeaseCapabilities,
    networkHandover: _networkHandover,
    ...safeSource
  } = source;
  return {
    ...safeSource,
    installation: visibleInstallation(source.installation),
    connection: visibleConnection(source.connection),
    auth: visibleAuth(source.auth),
    authFlow: visibleFeishuAuthFlow(),
    diagnosticLog: diagnosticLogStatus()
  };
}

function visibleConnection(input) {
  if (!input || typeof input !== 'object') return input;
  const {
    leaseCapability: _leaseCapability,
    encryptedLeaseCapability: _encryptedLeaseCapability,
    retainedMode: _retainedMode,
    ...safe
  } = input;
  return safe;
}

function visibleInstallation(input) {
  const installation = normalizeInstallation(input);
  return {
    installId: installation.installId,
    deviceId: installation.deviceId,
    siteId: installation.siteId,
    deviceLabel: installation.deviceLabel,
    publicKey: installation.keyPair?.publicKey || null,
    createdAt: installation.createdAt,
    updatedAt: installation.updatedAt
  };
}

function visibleAuth(input) {
  const auth = normalizeAuth(input);
  if (!auth) return null;
  return {
    tokenType: auth.tokenType,
    issuedTokenType: auth.issuedTokenType,
    issuer: auth.issuer,
    audience: auth.audience,
    subject: auth.subject,
    expiresAt: auth.expiresAt,
    scopes: auth.scopes,
    provider: auth.provider
  };
}

async function saveAndBroadcast(options = {}) {
  try {
    await saveRuntime(runtime);
  } catch (err) {
    if (!isLocalRuntimePersistenceError(err)) throw err;
    const previous = retainableConnectionSnapshot(options.fallbackConnection)
      || retainableConnectionSnapshot(runtime.connection);
    const classified = classifyConnectionError(err);
    queueDiagnosticError('runtime.primary-save-failed', err, {
      classifiedState: classified.state,
      previousMode: previous?.mode,
      previousState: previous?.state
    });
    applyLocalRuntimePersistenceError('本机状态保存失败', classified, previous);
    broadcastState();
    throw err;
  }
  broadcastState();
}

async function publishNetworkModeEvent(name, phase, options = {}) {
  const fallback = normalizeNetworkModeEvent({
    name,
    phase,
    productId: launcherProductId(),
    instanceId: runtime?.installation?.installId || runtime?.installation?.deviceId,
    leaseIp: options.leaseIp || runtime?.connection?.localIp,
    reason: options.reason,
    transitionId: options.transitionId,
    occurredAt: nowIso()
  });
  try {
    const mod = await importInstalledPackage('@qpjoy/electron-launcher/network-mode-events');
    const state = mod.publishElectronLauncherNetworkModeEvent(fallback);
    runtime.networkEvent = normalizeNetworkModeEvent(state.current) || fallback;
    return state;
  } catch (err) {
    runtime.networkEvent = {
      ...fallback,
      reason: fallback?.reason || `shared-event-publish-failed: ${errorMessage(err)}`
    };
    return null;
  }
}

async function saveRuntime(next) {
  const persistable = persistableRuntime(next);
  await writePrivateJsonFile(runtimePath(), protectPersistedRuntime(persistable));
  try {
    await savePersistedH2oRuntime(
      persistable.apps?.h2o?.runtime,
      persistable.updatedAt
    );
  } catch (err) {
    queueDiagnosticLog(
      'warning',
      'runtime.h2o-mirror-save-failed',
      'H2O derived runtime mirror could not be persisted; the primary runtime remains authoritative.',
      {
        code: typeof err?.code === 'string' ? err.code : null,
        syscall: typeof err?.syscall === 'string' ? err.syscall : null,
        message: errorMessage(err)
      }
    );
  }
  await maybeSnapshotAppsState(persistable.apps);
}

function persistableRuntime(input) {
  const next = input && typeof input === 'object' ? { ...input } : {};
  if (next.connection?.state === 'connecting') {
    const retainedMode = next.connection.retainedMode === 'employee' ? 'employee' : 'guest';
    next.connection = next.connection.leaseId
      ? {
          ...next.connection,
          state: 'lease-only',
          mode: retainedMode
        }
      : {
          ...idleConnection(),
          mode: retainedMode,
          diagnostics: normalizeDiagnostics(next.connection.diagnostics)
        };
    delete next.connection.retainedMode;
  }
  return next;
}

function protectPersistedRuntime(input) {
  const next = input && typeof input === 'object' ? { ...input } : {};
  const auth = normalizeAuth(next.auth);
  const connection = next.connection && typeof next.connection === 'object'
    ? { ...next.connection }
    : null;
  const installation = normalizeInstallation(next.installation);
  const leaseCapabilities = normalizeLeaseCapabilities(next.leaseCapabilities);
  const accessToken = nullableString(auth?.accessToken);
  const leaseCapability = nullableString(connection?.leaseCapability);
  const wireGuardPrivateKey = nullableString(installation.keyPair?.privateKey);
  const hasLeaseCapabilities = Object.keys(leaseCapabilities).length > 0;
  if (!accessToken && !leaseCapability && !hasLeaseCapabilities && !wireGuardPrivateKey) return next;
  if (!secureCredentialStorageAvailable()) {
    const failureReason = 'Electron safeStorage is unavailable or does not provide encrypted Linux storage';
    return {
      ...next,
      auth: null,
      identity: null,
      connection: {
        ...idleConnection(),
        state: 'forbidden',
        mode: connection?.mode === 'employee' ? 'employee' : 'guest',
        diagnostics: {
          credentialStorageFailure: {
            ok: false,
            cleanupRequired: true,
            message: failureReason,
            updatedAt: nowIso()
          },
          updatedAt: nowIso()
        }
      },
      networkHandover: null,
      installation: {
        ...installation,
        installId: null,
        deviceId: null,
        ownershipInstanceId: null,
        keyPair: null
      },
      leaseCapabilities: {},
      protectedCredentialStorageUnavailable: true,
      credentialStorageFailure: {
        reason: failureReason,
        detectedAt: nowIso(),
        ownershipInstanceId: stableOwnershipInstanceId(installation),
        previousMode: connection?.mode === 'employee' ? 'employee' : 'guest',
        previousLeaseIp: nullableString(connection?.localIp)
      }
    };
  }
  return {
    ...next,
    ...(auth ? { auth: {
      ...auth,
      accessToken: null,
      ...(accessToken
        ? { encryptedAccessToken: safeStorage.encryptString(accessToken).toString('base64') }
        : {}),
      tokenStorage: 'electron-safe-storage-v1'
    } } : {}),
    ...(connection ? { connection: {
      ...connection,
      leaseCapability: null,
      ...(leaseCapability
        ? { encryptedLeaseCapability: safeStorage.encryptString(leaseCapability).toString('base64') }
        : {})
    } } : {}),
    installation: {
      ...installation,
      keyPair: installation.keyPair
        ? { publicKey: installation.keyPair.publicKey, privateKey: null }
        : null,
      ...(wireGuardPrivateKey
        ? { encryptedWireGuardPrivateKey: safeStorage.encryptString(wireGuardPrivateKey).toString('base64') }
        : {})
    },
    leaseCapabilities: {},
    ...(hasLeaseCapabilities
      ? {
          encryptedLeaseCapabilities: safeStorage
            .encryptString(JSON.stringify(leaseCapabilities))
            .toString('base64')
        }
      : {})
  };
}

function unprotectPersistedRuntime(input) {
  const next = input && typeof input === 'object' ? { ...input } : {};
  const auth = next.auth && typeof next.auth === 'object' ? { ...next.auth } : null;
  const connection = next.connection && typeof next.connection === 'object'
    ? { ...next.connection }
    : null;
  const installation = next.installation && typeof next.installation === 'object'
    ? { ...next.installation }
    : null;
  if (next.protectedCredentialStorageUnavailable === true) {
    const failure = normalizeCredentialStorageFailure(
      next.credentialStorageFailure || {
        reason: 'Electron safeStorage was unavailable when runtime credentials were persisted.',
        detectedAt: nowIso(),
        ownershipInstanceId: stableOwnershipInstanceId(installation || {}),
        previousMode: connection?.mode,
        previousLeaseIp: connection?.localIp
      }
    );
    return {
      ...next,
      auth: null,
      identity: null,
      connection: {
        ...idleConnection(),
        state: 'forbidden',
        mode: failure.previousMode,
        diagnostics: {
          credentialStorageFailure: {
            ok: false,
            cleanupRequired: true,
            message: failure.reason,
            updatedAt: nowIso()
          },
          updatedAt: nowIso()
        }
      },
      networkHandover: null,
      leaseCapabilities: {},
      encryptedLeaseCapabilities: null,
      credentialStorageFailure: failure
    };
  }
  let leaseCapabilities = normalizeLeaseCapabilities(next.leaseCapabilities);
  if (
    !auth?.encryptedAccessToken
    && !connection?.encryptedLeaseCapability
    && !installation?.encryptedWireGuardPrivateKey
    && !next.encryptedLeaseCapabilities
  ) return next;
  try {
    if (!secureCredentialStorageAvailable()) {
      throw new Error('Electron safeStorage is unavailable or does not provide encrypted Linux storage');
    }
    if (auth?.encryptedAccessToken) {
      auth.accessToken = safeStorage.decryptString(Buffer.from(auth.encryptedAccessToken, 'base64'));
    }
    if (connection?.encryptedLeaseCapability) {
      connection.leaseCapability = safeStorage.decryptString(
        Buffer.from(connection.encryptedLeaseCapability, 'base64')
      );
    }
    if (installation?.encryptedWireGuardPrivateKey) {
      installation.keyPair = {
        privateKey: safeStorage.decryptString(
          Buffer.from(installation.encryptedWireGuardPrivateKey, 'base64')
        ),
        publicKey: nullableString(installation.keyPair?.publicKey)
          || nullableString(installation.publicKey)
      };
    }
    if (next.encryptedLeaseCapabilities) {
      leaseCapabilities = normalizeLeaseCapabilities(JSON.parse(
        safeStorage.decryptString(Buffer.from(next.encryptedLeaseCapabilities, 'base64'))
      ));
    }
  } catch (err) {
    const failureReason = errorMessage(err);
    queueDiagnosticLog('warning', 'auth.persisted-token-unavailable', 'Persisted credentials could not be decrypted; re-login or lease re-enrollment is required.', {
      reason: failureReason
    });
    return {
      ...next,
      auth: null,
      identity: null,
      connection: {
        ...idleConnection(),
        state: 'forbidden',
        mode: connection?.mode === 'employee' ? 'employee' : 'guest',
        diagnostics: {
          credentialStorageFailure: {
            ok: false,
            cleanupRequired: true,
            message: failureReason,
            updatedAt: nowIso()
          },
          updatedAt: nowIso()
        }
      },
      networkHandover: null,
      leaseCapabilities: {},
      encryptedLeaseCapabilities: null,
      credentialStorageFailure: {
        reason: failureReason,
        detectedAt: nowIso(),
        ownershipInstanceId: stableOwnershipInstanceId(installation || {}),
        previousMode: connection?.mode === 'employee' ? 'employee' : 'guest',
        previousLeaseIp: nullableString(connection?.localIp)
      },
      ...(installation ? {
        installation: {
          ...installation,
          installId: null,
          deviceId: null,
          ownershipInstanceId: null,
          keyPair: null,
          encryptedWireGuardPrivateKey: null
        }
      } : {})
    };
  }
  if (auth) {
    delete auth.encryptedAccessToken;
    delete auth.tokenStorage;
  }
  if (connection) delete connection.encryptedLeaseCapability;
  if (installation) delete installation.encryptedWireGuardPrivateKey;
  delete next.encryptedLeaseCapabilities;
  return {
    ...next,
    ...(auth ? { auth } : {}),
    ...(connection ? { connection } : {}),
    ...(installation ? { installation } : {}),
    leaseCapabilities
  };
}

function secureCredentialStorageAvailable() {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform !== 'linux') return true;
  const backend = typeof safeStorage.getSelectedStorageBackend === 'function'
    ? nullableString(safeStorage.getSelectedStorageBackend())
    : null;
  return Boolean(backend && backend !== 'basic_text');
}

async function writePrivateJsonFile(filePath, value) {
  return serializePrivateJsonFileWrite(filePath, async () => {
    const directory = path.dirname(filePath);
    const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
      });
      await fs.chmod(temporaryPath, 0o600);
      await renamePrivateJsonFileWithRetry(temporaryPath, filePath);
      await fs.chmod(filePath, 0o600);
    } catch (err) {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw err;
    }
  });
}

function serializePrivateJsonFileWrite(filePath, write) {
  const previous = privateJsonFileWriteQueues.get(filePath) || Promise.resolve();
  const current = previous.catch(() => undefined).then(write);
  const tracked = current.finally(() => {
    if (privateJsonFileWriteQueues.get(filePath) === tracked) {
      privateJsonFileWriteQueues.delete(filePath);
    }
  });
  privateJsonFileWriteQueues.set(filePath, tracked);
  return tracked;
}

async function renamePrivateJsonFileWithRetry(sourcePath, targetPath, options = {}) {
  const rename = typeof options.rename === 'function' ? options.rename : fs.rename.bind(fs);
  const wait = typeof options.wait === 'function' ? options.wait : delay;
  const platform = options.platform || process.platform;
  let retryIndex = 0;
  while (true) {
    try {
      await rename(sourcePath, targetPath);
      return;
    } catch (err) {
      const retryDelay = WINDOWS_PRIVATE_JSON_RENAME_RETRY_DELAYS_MS[retryIndex];
      if (
        retryDelay === undefined
        || !isRetryableWindowsPrivateJsonRenameError(err, platform)
      ) {
        throw err;
      }
      retryIndex += 1;
      await wait(retryDelay);
    }
  }
}

function isRetryableWindowsPrivateJsonRenameError(err, platform = process.platform) {
  return platform === 'win32'
    && ['EPERM', 'EACCES', 'EBUSY'].includes(
      typeof err?.code === 'string' ? err.code.toUpperCase() : ''
    );
}

async function loadPersistedH2oRuntime() {
  try {
    const raw = await fs.readFile(h2oRuntimeStorePath(), 'utf8');
    const row = JSON.parse(raw);
    return {
      runtime: h2oPluginRuntime(row),
      sourceRuntimeUpdatedAt: nullableString(row.sourceRuntimeUpdatedAt),
      sourceRuntimeFingerprint: nullableString(row.sourceRuntimeFingerprint)
    };
  } catch {
    return null;
  }
}

async function savePersistedH2oRuntime(input, sourceRuntimeUpdatedAt) {
  if (!input) return;
  const current = h2oPluginRuntime(input);
  const store = {
    kind: 'h2o-plugin',
    sourceRuntimeUpdatedAt: nullableString(sourceRuntimeUpdatedAt),
    sourceRuntimeFingerprint: h2oRuntimePersistenceFingerprint(current),
    mode: current.mode,
    running: false,
    status: h2oHasUsableSubscription(current.activeSubscription) ? 'ready' : 'subscription-required',
    tunInstalled: current.tunInstalled,
    adminUrl: current.adminUrl,
    ports: current.ports,
    activeSubscriptionId: current.activeSubscriptionId,
    activeSubscription: current.activeSubscription,
    subscriptions: current.subscriptions,
    rules: current.rules,
    metrics: current.metrics,
    startedAt: null,
    lastAppliedAt: current.lastAppliedAt
  };
  await writePrivateJsonFile(h2oRuntimeStorePath(), store);
}

// Apps 状态备份环：每次持久化时在 <userData>/state-backups/ 保留最近 STATE_BACKUP_LIMIT
// 份 runtime.apps 快照（按 H2O 订阅/规则等客户端自有字段去重），用于在 merge/normalize
// 回归清空 H2O 订阅后恢复。恢复方式：
//   1) 应用内 DevTools 控制台执行 await window.mxH2i.listStateBackups() 查看快照，
//      再执行 await window.mxH2i.restoreStateBackup('<file>') 恢复；
//   2) 或关闭应用后，把快照文件里的 apps 对象手工覆盖到 <userData>/mx-h2i-runtime.json 的 apps 字段。
let lastAppsBackupFingerprint;

function stateBackupsDirPath() {
  return path.join(app.getPath('userData'), STATE_BACKUP_DIR_NAME);
}

function appsStateBackupFingerprint(apps) {
  const h2o = apps?.h2o?.runtime;
  if (!h2o) return null;
  return JSON.stringify({
    mode: h2o.mode ?? null,
    tunInstalled: h2o.tunInstalled ?? null,
    activeSubscriptionId: h2o.activeSubscriptionId ?? null,
    activeSubscription: h2o.activeSubscription ?? null,
    subscriptions: h2o.subscriptions ?? [],
    rules: h2o.rules ?? []
  });
}

async function maybeSnapshotAppsState(apps) {
  try {
    const fingerprint = appsStateBackupFingerprint(apps);
    if (!fingerprint) return;
    if (lastAppsBackupFingerprint === undefined) lastAppsBackupFingerprint = await latestAppsStateBackupFingerprint();
    if (fingerprint === lastAppsBackupFingerprint) return;
    const dir = stateBackupsDirPath();
    const createdAt = nowIso();
    const fileName = `apps-${createdAt.replace(/[:.]/g, '-')}.json`;
    await writePrivateJsonFile(path.join(dir, fileName), {
      kind: 'mx-h2i-apps-backup',
      createdAt,
      apps
    });
    lastAppsBackupFingerprint = fingerprint;
    await pruneAppsStateBackups();
  } catch (err) {
    console.warn('[mx-h2i] apps state backup failed:', errorMessage(err));
  }
}

async function latestAppsStateBackupFingerprint() {
  try {
    const names = await listAppsStateBackupFiles();
    if (!names.length) return null;
    const snapshot = await readAppsStateBackup(names[names.length - 1]);
    return appsStateBackupFingerprint(snapshot.apps);
  } catch {
    return null;
  }
}

async function listAppsStateBackupFiles() {
  try {
    const names = await fs.readdir(stateBackupsDirPath());
    return names.filter((name) => /^apps-[\w.-]+\.json$/.test(name)).sort();
  } catch {
    return [];
  }
}

async function listAppsStateBackups() {
  const names = await listAppsStateBackupFiles();
  const backups = [];
  for (const name of names.slice().reverse()) {
    try {
      const snapshot = await readAppsStateBackup(name);
      const h2o = snapshot.apps?.h2o?.runtime || {};
      backups.push({
        file: name,
        createdAt: snapshot.createdAt || null,
        h2oMode: h2o.mode || null,
        h2oActiveSubscriptionId: h2o.activeSubscriptionId || null,
        h2oSubscriptionCount: Array.isArray(h2o.subscriptions) ? h2o.subscriptions.length : 0,
        h2oRuleCount: Array.isArray(h2o.rules) ? h2o.rules.length : 0
      });
    } catch {
      backups.push({ file: name, createdAt: null, error: 'unreadable' });
    }
  }
  return backups;
}

async function readAppsStateBackup(fileName) {
  const name = path.basename(String(fileName || ''));
  if (!/^apps-[\w.-]+\.json$/.test(name)) throw new Error(`无效的备份文件名: ${fileName}`);
  const raw = await fs.readFile(path.join(stateBackupsDirPath(), name), 'utf8');
  const snapshot = JSON.parse(raw);
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.apps || typeof snapshot.apps !== 'object') {
    throw new Error(`备份文件缺少 apps 数据: ${name}`);
  }
  return { ...snapshot, file: name };
}

async function pruneAppsStateBackups() {
  const names = await listAppsStateBackupFiles();
  for (const name of names.slice(0, Math.max(0, names.length - STATE_BACKUP_LIMIT))) {
    await fs.rm(path.join(stateBackupsDirPath(), name), { force: true });
  }
}

function mergePersistedH2oRuntime(source, persistedRecord) {
  const next = source && typeof source === 'object' ? { ...source } : source;
  const appRecord = next?.apps?.h2o;
  if (!appRecord?.runtime) return next;
  const current = h2oPluginRuntime(appRecord.runtime);
  const persisted = shouldMergePersistedH2oRuntime(next, current, persistedRecord)
    ? h2oPluginRuntime(persistedRecord.runtime)
    : null;
  const subscriptions = persisted
    ? mergeH2oRuntimeSubscriptions(persisted.subscriptions, current.subscriptions)
    : current.subscriptions;
  const activeSubscription = subscriptions.find((item) => persisted && item.id === persisted.activeSubscriptionId)
    || subscriptions.find((item) => item.id === current.activeSubscriptionId)
    || subscriptions[0]
    || current.activeSubscription;
  const shouldClearIdleProxyError = current.running !== true && h2oLooksLikeIdleProxyError(appRecord.errorMessage);
  const status = current.running
    ? current.status
    : shouldClearIdleProxyError || ['starting', 'proxy-unavailable'].includes(current.status)
      ? h2oHasUsableSubscription(activeSubscription) ? 'ready' : 'subscription-required'
      : current.status;
  const mergedRuntime = h2oPluginRuntime({
    ...current,
    ...(persisted ? {
      mode: persisted.mode,
      tunInstalled: persisted.tunInstalled,
      adminUrl: persisted.adminUrl,
      ports: persisted.ports,
      rules: persisted.rules
    } : {}),
    running: current.running === true,
    status,
    subscriptions,
    activeSubscription,
    activeSubscriptionId: activeSubscription.id,
    startedAt: current.running === true ? current.startedAt : null
  });
  next.apps = {
    ...next.apps,
    h2o: {
      ...appRecord,
      runtime: mergedRuntime,
      status: current.running === true ? 'running' : shouldClearIdleProxyError && appRecord.installed ? 'enabled' : appRecord.status,
      runtimeState: current.running === true ? 'running' : shouldClearIdleProxyError && appRecord.installed ? 'ready' : appRecord.runtimeState,
      errorMessage: shouldClearIdleProxyError ? null : appRecord.errorMessage
    }
  };
  return next;
}

function shouldMergePersistedH2oRuntime(source, current, persistedRecord) {
  if (!persistedRecord?.runtime) return false;
  const mirrorFingerprint = nullableString(persistedRecord.sourceRuntimeFingerprint);
  if (mirrorFingerprint) {
    return mirrorFingerprint === h2oRuntimePersistenceFingerprint(current);
  }
  const sourceUpdatedAt = nullableString(source?.updatedAt);
  const mirrorUpdatedAt = nullableString(persistedRecord.sourceRuntimeUpdatedAt);
  if (mirrorUpdatedAt) {
    const sourceTime = Date.parse(sourceUpdatedAt || '');
    const mirrorTime = Date.parse(mirrorUpdatedAt);
    if (Number.isFinite(sourceTime) && Number.isFinite(mirrorTime)) {
      return mirrorTime >= sourceTime;
    }
    return !sourceUpdatedAt || mirrorUpdatedAt === sourceUpdatedAt;
  }
  return !arrayValue(current?.subscriptions, []).some(h2oHasUsableSubscription)
    && !h2oHasUsableSubscription(current?.activeSubscription);
}

function h2oRuntimePersistenceFingerprint(input) {
  const current = h2oPluginRuntime(input);
  return createHash('sha256').update(JSON.stringify({
    mode: current.mode,
    tunInstalled: current.tunInstalled,
    adminUrl: current.adminUrl,
    ports: current.ports,
    activeSubscriptionId: current.activeSubscriptionId,
    activeSubscription: current.activeSubscription,
    subscriptions: current.subscriptions,
    rules: current.rules
  })).digest('hex');
}

function mergeH2oRuntimeSubscriptions(primary, secondary) {
  const byId = new Map();
  const add = (item) => {
    const normalized = normalizeH2oSubscription(item, {});
    const existing = byId.get(normalized.id);
    byId.set(normalized.id, chooseH2oSubscription(existing, normalized));
  };
  for (const item of arrayValue(primary, [])) add(item);
  for (const item of arrayValue(secondary, [])) add(item);
  return orderH2oSubscriptions([...byId.values()]).slice(0, 12);
}

function chooseH2oSubscription(existing, incoming) {
  if (!existing) return incoming;
  const existingUsable = h2oHasUsableSubscription(existing);
  const incomingUsable = h2oHasUsableSubscription(incoming);
  if (incomingUsable && !existingUsable) return incoming;
  if (existingUsable && !incomingUsable) return existing;
  const existingHttp = h2oLooksLikeHttpSubscriptionUrl(existing.url);
  const incomingHttp = h2oLooksLikeHttpSubscriptionUrl(incoming.url);
  if (incomingHttp && !existingHttp) return incoming;
  if (existingHttp && !incomingHttp) return existing;
  return existing;
}

function h2oLooksLikeIdleProxyError(message) {
  return /mixed-port|未监听|proxy-unavailable|H2O mihomo 恢复失败/i.test(nullableString(message) || '');
}

function h2oRuntimeStorePath() {
  return path.join(app.getPath('userData'), 'h2o', H2O_RUNTIME_STORE_FILE);
}

function broadcastState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('mx-h2i:state', visibleRuntime());
}

function runtimePath() {
  return path.join(app.getPath('userData'), STATE_FILE);
}

function touchRuntime(label) {
  runtime.updatedAt = nowIso();
  runtime.activity = [
    {
      label,
      at: runtime.updatedAt
    },
    ...runtime.activity
  ].slice(0, 8);
  queueDiagnosticLog('info', 'runtime.activity', label, {
    connectionState: runtime.connection?.state,
    connectionMode: runtime.connection?.mode,
    networkEvent: runtime.networkEvent?.name,
    networkEventPhase: runtime.networkEvent?.phase
  });
}

function defaultActivity() {
  return [
    {
      label: 'runtime initialized',
      at: nowIso()
    }
  ];
}

function loadDotEnvFiles() {
  const bases = uniqueValues([
    process.cwd(),
    process.env.INIT_CWD,
    path.resolve(process.cwd(), 'demos', 'mx-h2i'),
    path.resolve(process.cwd(), 'electron-dock', 'mx-launcher', 'demos', 'mx-h2i'),
    path.resolve(__dirname, '..'),
    path.resolve(__dirname, '..', '..'),
    process.resourcesPath ? path.join(process.resourcesPath, 'app') : null,
    process.resourcesPath || null
  ].filter(Boolean));
  const candidates = uniqueValues(bases.flatMap((base) => [
    path.join(base, '.env.local'),
    path.join(base, '.env')
  ]));
  for (const file of candidates) {
    loadDotEnvFile(file);
  }
}

function loadDotEnvFile(file) {
  try {
    if (!fsSync.existsSync(file)) return;
    const raw = fsSync.readFileSync(file, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) continue;
      const key = match[1];
      if (Object.prototype.hasOwnProperty.call(process.env, key)) continue;
      process.env[key] = unquoteEnvValue(match[2]);
    }
  } catch {
    // A missing or unreadable local .env should not prevent the desktop app from booting.
  }
}

function unquoteEnvValue(value) {
  const trimmed = String(value ?? '').trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function defaultLauncherProductId() {
  return normalizeLauncherProductId(
    process.env.MX_H2I_PRODUCT_ID
      || process.env.MX_LAUNCHER_PRODUCT_ID
      || PRODUCT_ID
  );
}

function defaultLauncherProductDisplayName() {
  return nullableString(process.env.MX_H2I_PRODUCT_DISPLAY_NAME)
    || nullableString(process.env.MX_LAUNCHER_PRODUCT_DISPLAY_NAME)
    || displayNameForLauncherProductId(defaultLauncherProductId());
}

function normalizeLauncherProductId(value) {
  const text = nullableString(value) || PRODUCT_ID;
  const normalized = text.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || PRODUCT_ID;
}

function launcherProductId() {
  return normalizeLauncherProductId(runtime?.config?.productId || DEFAULT_CONFIG.productId || PRODUCT_ID);
}

function launcherProductDisplayName() {
  const productId = launcherProductId();
  return stringValue(runtime?.config?.productDisplayName, displayNameForLauncherProductId(productId));
}

function displayNameForLauncherProductId(productId) {
  const normalized = normalizeLauncherProductId(productId);
  if (normalized === PRODUCT_ID) return PRODUCT_DISPLAY_NAME;
  return normalized
    .split(/[-_.]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ') || normalized;
}

function defaultBootstrapApiBaseUrl() {
  const explicit = normalizeBaseUrl(process.env.MX_H2I_BOOTSTRAP_BASE_URL)
    || normalizeBaseUrl(process.env.MX_H2I_PUBLIC_BASE_URL);
  let candidate = explicit;
  if (!candidate) {
    const host = nullableString(process.env.MX_H2I_BOOTSTRAP_HOST)
      || nullableString(process.env.MX_H2I_BOOTSTRAP_DOMAIN)
      || DEFAULT_BOOTSTRAP_HOST;
    const protocol = stringValue(process.env.MX_H2I_BOOTSTRAP_PROTOCOL, 'https').replace(/:$/, '');
    const port = nullableString(process.env.MX_H2I_BOOTSTRAP_PORT)
      || (protocol === 'https' ? '' : '18090');
    const defaultPort = protocol === 'https' ? '443' : '80';
    candidate = `${protocol}://${host}${port && port !== defaultPort ? `:${port}` : ''}`;
  }
  if (isLegacyDefaultBootstrapApiBaseUrl(candidate)) {
    return `https://${DEFAULT_BOOTSTRAP_HOST}`;
  }
  if (productionBootstrapCanonicalRequired() && isBarePublicIpBootstrapBaseUrl(candidate)) {
    return `https://${DEFAULT_BOOTSTRAP_HOST}`;
  }
  return candidate;
}

function defaultHostResolve() {
  const explicit = explicitDefaultHostResolve();
  const host = hostnameFromUrl(defaultBootstrapApiBaseUrl())
    || DEFAULT_BOOTSTRAP_HOST;
  if (explicit) {
    return shouldAutoBootstrapHostResolve(host)
      ? migrateKnownLegacyDefaultHostResolve(explicit)
      : explicit;
  }
  const ip = nullableString(process.env.MX_H2I_BOOTSTRAP_RESOLVE_IP)
    || nullableString(process.env.MX_H2I_BOOTSTRAP_IP);
  if (host && ip) return `${host}=${ip}`;
  return shouldAutoBootstrapHostResolve(host) ? `${host}=${defaultDomesticRelayHost()}` : '';
}

function explicitDefaultHostResolve() {
  return nullableString(process.env.MX_H2I_HOST_RESOLVE)
    || nullableString(process.env.MX_H2I_BOOTSTRAP_HOST_RESOLVE);
}

function defaultDomesticRelayHost() {
  return nullableString(process.env.MX_H2I_DOMESTIC_RELAY_HOST)
    || nullableString(process.env.MX_H2I_DOMESTIC_HOST)
    || nullableString(process.env.MX_H2I_DOMESTIC_PUBLIC_HOST)
    || DEFAULT_DOMESTIC_RELAY_HOST;
}

function defaultBootstrapResolveMode() {
  return normalizeBootstrapResolveMode(
    process.env.MX_H2I_BOOTSTRAP_RESOLVE_MODE
      || process.env.MX_H2I_BOOTSTRAP_DNS_MODE
      || 'env-first'
  );
}

function defaultBootstrapDnsServers() {
  return nullableString(process.env.MX_H2I_BOOTSTRAP_DNS_SERVERS)
    || nullableString(process.env.MX_H2I_BOOTSTRAP_DNS_SERVER)
    || nullableString(process.env.MX_H2I_BOOTSTRAP_RESOLVE_DNS)
    || nullableString(process.env.MX_H2I_BOOTSTRAP_DNS)
    || '';
}

function normalizeBootstrapResolveMode(value) {
  const text = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  if (['env', 'env-first', 'host', 'host-first', 'host-resolve', 'host-resolve-first'].includes(text)) {
    return 'env-first';
  }
  if (['dns', 'dns-first', 'public-dns', 'system-dns', 'provider-dns'].includes(text)) {
    return 'dns-first';
  }
  if (['env-only', 'host-only', 'host-resolve-only'].includes(text)) return 'env-only';
  if (['dns-only', 'public-dns-only', 'system-dns-only', 'provider-dns-only'].includes(text)) return 'dns-only';
  if (['system', 'system-only', 'system-proxy', 'default-network'].includes(text)) return 'system-only';
  return 'env-first';
}

function normalizeRoutePathPreference(value) {
  const text = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  if (['direct', 'h2i', 'h2i-direct'].includes(text)) return 'direct';
  if (['hybrid', 'h2i-hybrid', 'mixed', 'mix'].includes(text)) return 'hybrid';
  if (['relay', 'hdi', 'hdi-relay', 'domestic', 'domestic-relay'].includes(text)) return 'relay';
  return 'auto';
}

function normalizeRoutePlanPath(value) {
  const text = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  if (text === 'h2i-direct' || text === 'direct') return 'h2i-direct';
  if (text === 'h2i-hybrid' || text === 'hybrid') return 'h2i-hybrid';
  return 'hdi-relay';
}

async function requestHostOverride(url, options = {}) {
  const resolveMode = normalizeBootstrapResolveMode(
    options.bootstrapResolveMode || runtime?.config?.bootstrapResolveMode || DEFAULT_CONFIG.bootstrapResolveMode
  );
  if (resolveMode === 'system-only') return null;
  if (resolveMode === 'env-first' || resolveMode === 'env-only') {
    return hostResolveOverride(url, { bootstrapResolveMode: resolveMode })
      || directPublicBootstrapOverride(url, { bootstrapResolveMode: resolveMode });
  }
  if (resolveMode === 'dns-first' || resolveMode === 'dns-only') {
    return await bootstrapDnsResolveOverride(url, { bootstrapResolveMode: resolveMode })
      || directPublicBootstrapOverride(url, { bootstrapResolveMode: resolveMode });
  }
  return null;
}

async function bootstrapDnsResolveOverride(url, options = {}) {
  const resolveMode = normalizeBootstrapResolveMode(
    options.bootstrapResolveMode || runtime?.config?.bootstrapResolveMode || DEFAULT_CONFIG.bootstrapResolveMode
  );
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!shouldResolveBootstrapHost(parsed.hostname)) return null;
  const servers = bootstrapDnsServers();
  if (!servers.length) return null;
  const address = await resolveBootstrapHostname(parsed.hostname, servers, resolveMode);
  return buildHostOverride(parsed, { host: address, port: null }, resolveMode, {
    preserveOriginalHost: false,
    source: 'bootstrap-dns'
  });
}

function shouldResolveBootstrapHost(hostname) {
  const host = nullableString(hostname);
  if (!host) return false;
  if (host === 'localhost') return false;
  return net.isIP(host) === 0;
}

function bootstrapDnsServers() {
  return parseDnsServerList([
    runtime?.config?.bootstrapDnsServers,
    DEFAULT_CONFIG.bootstrapDnsServers
  ].filter(Boolean).join(','));
}

function parseDnsServerList(value) {
  return uniqueValues(String(value || '')
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean));
}

async function resolveBootstrapHostname(hostname, servers, resolveMode) {
  const resolver = new dnsPromises.Resolver();
  resolver.setServers(servers);
  const failures = [];
  for (let attempt = 1; attempt <= BOOTSTRAP_DNS_RETRY_LIMIT; attempt += 1) {
    try {
      const records = await withTimeout(
        resolver.resolve4(hostname),
        1600,
        `Bootstrap DNS timeout for ${hostname} via ${servers.join(',')}`
      );
      const address = records.find((record) => isIpv4(record));
      if (address) return address;
      throw new Error(`Bootstrap DNS did not return an A record for ${hostname}`);
    } catch (err) {
      failures.push(err);
      if (attempt < BOOTSTRAP_DNS_RETRY_LIMIT) {
        await delay(BOOTSTRAP_DNS_RETRY_DELAY_MS * attempt);
      }
    }
  }
  const last = failures[failures.length - 1];
  const wrapped = new Error(`Bootstrap DNS failed for ${hostname} via ${servers.join(',')} after ${failures.length} attempts: ${errorMessage(last)}`);
  wrapped.code = 'MX_BOOTSTRAP_DNS_FAILED';
  wrapped.bootstrapResolveMode = resolveMode;
  wrapped.dnsRetryCount = failures.length;
  wrapped.cause = last;
  throw wrapped;
}

function withTimeout(promise, timeoutMs, message, errorCode = 'MX_BOOTSTRAP_DNS_TIMEOUT') {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(message);
      err.code = errorCode;
      reject(err);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function hostResolveOverride(url, options = {}) {
  const resolveMode = normalizeBootstrapResolveMode(options.bootstrapResolveMode || runtime?.config?.bootstrapResolveMode || DEFAULT_CONFIG.bootstrapResolveMode);
  if (resolveMode === 'dns-first' || resolveMode === 'dns-only' || resolveMode === 'system-only') return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const resolveMap = parseHostResolve(effectiveHostResolve());
  const mapped = resolveMap.get(parsed.hostname.toLowerCase());
  if (!mapped) return null;
  return buildHostOverride(parsed, mapped, resolveMode, {
    preserveOriginalHost: false,
    source: 'host-resolve'
  });
}

function directPublicBootstrapOverride(url, options = {}) {
  const resolveMode = normalizeBootstrapResolveMode(options.bootstrapResolveMode || runtime?.config?.bootstrapResolveMode || DEFAULT_CONFIG.bootstrapResolveMode);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!shouldAttachOriginalHostForDirectBootstrap(parsed)) return null;
  const originalHostHeader = bootstrapOriginalHostHeader(parsed);
  if (!originalHostHeader) return null;
  const original = new URL(parsed.toString());
  original.host = originalHostHeader;
  const useTlsIdentity = parsed.protocol === 'https:';
  return {
    originalUrl: original.toString(),
    url: parsed.toString(),
    hostHeader: useTlsIdentity ? original.host : parsed.host,
    originalHostHeader,
    resolveMode,
    source: 'direct-public-bootstrap',
    servername: useTlsIdentity ? original.hostname : undefined
  };
}

function shouldAttachOriginalHostForDirectBootstrap(parsed) {
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return false;
  if (parsed.hostname === 'localhost' || net.isIP(parsed.hostname) === 0) return false;
  return publicBootstrapDialHosts().includes(parsed.hostname.toLowerCase());
}

function publicBootstrapDialHosts() {
  return uniqueValues([
    runtime?.config?.domesticRelayHost,
    DEFAULT_CONFIG.domesticRelayHost,
    defaultDomesticRelayHost(),
    DEFAULT_DOMESTIC_RELAY_HOST
  ].map((host) => String(host || '').trim().toLowerCase()).filter(Boolean));
}

function bootstrapOriginalHostHeader(parsed) {
  const host = bootstrapOriginalHostname();
  if (!host) return null;
  const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const defaultPort = parsed.protocol === 'https:' ? '443' : '80';
  return parsed.port && parsed.port !== defaultPort ? `${formattedHost}:${parsed.port}` : formattedHost;
}

function bootstrapOriginalHostname() {
  return [
    process.env.MX_H2I_BOOTSTRAP_ORIGINAL_HOST,
    hostnameFromUrl(runtime?.config?.bootstrapApiBaseUrl),
    hostnameFromUrl(defaultBootstrapApiBaseUrl()),
    DEFAULT_BOOTSTRAP_HOST
  ].map(nullableString).find((host) => host && host !== 'localhost' && net.isIP(host) === 0) || null;
}

function buildHostOverride(parsed, mapped, resolveMode, options = {}) {
  const target = new URL(parsed.toString());
  target.hostname = mapped.host;
  if (mapped.port) target.port = mapped.port;
  const useOriginalHostHeader = options.preserveOriginalHost === true || target.protocol === 'https:';
  return {
    originalUrl: parsed.toString(),
    url: target.toString(),
    hostHeader: useOriginalHostHeader ? parsed.host : target.host,
    originalHostHeader: parsed.host,
    resolveMode,
    source: options.source || 'host-resolve',
    servername: useOriginalHostHeader ? parsed.hostname : undefined
  };
}

function bootstrapForwardHeaders(override, target) {
  if (!override.originalHostHeader) return {};
  const originalProtocol = protocolFromUrl(override.originalUrl) || target.protocol.replace(/:$/, '') || 'http';
  const originalPort = portFromHostHeader(override.originalHostHeader)
    || portFromUrl(override.originalUrl)
    || String(target.port || (target.protocol === 'https:' ? 443 : 80));
  return {
    'x-forwarded-host': override.originalHostHeader,
    'x-forwarded-proto': originalProtocol,
    'x-forwarded-port': originalPort,
    'x-mx-original-host': override.originalHostHeader,
    'x-mx-bootstrap-host': override.originalHostHeader,
    'x-mx-bootstrap-domain': hostnameFromUrl(override.originalUrl || ''),
    'x-mx-bootstrap-dial-host': target.host,
    'x-mx-bootstrap-source': override.source || 'host-resolve'
  };
}

function effectiveHostResolve() {
  return [
    runtime?.config?.hostResolve,
    DEFAULT_CONFIG.hostResolve
  ].filter(Boolean).join(',');
}

function parseHostResolve(value) {
  const map = new Map();
  const text = nullableString(value);
  if (!text) return map;
  for (const pair of text.split(/[,\n;]/)) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const separator = trimmed.includes('=') ? '=' : ':';
    const index = trimmed.indexOf(separator);
    if (index <= 0) continue;
    const host = trimmed.slice(0, index).trim().toLowerCase();
    const target = parseHostResolveTarget(trimmed.slice(index + 1).trim());
    if (host && target) map.set(host, target);
  }
  return map;
}

function parseHostResolveTarget(value) {
  const text = nullableString(value);
  if (!text) return null;
  if (text.startsWith('[')) {
    const close = text.indexOf(']');
    if (close > 0) {
      return {
        host: text.slice(1, close),
        port: text.slice(close + 1).replace(/^:/, '') || null
      };
    }
  }
  const [host, port] = text.split(':');
  return {
    host,
    port: port || null
  };
}

function splitDnsDomains(config) {
  return arrayValue(String(config?.splitDnsDomains || '').split(/[,\s]+/), [])
    .map((domain) => domain.replace(/^\.+/, '').replace(/\.+$/, '').toLowerCase())
    .filter(Boolean);
}

function uniqueStrings(items) {
  return [...new Set(arrayValue(items, [])
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean))];
}

function nowIso() {
  return new Date().toISOString();
}

function stringValue(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function nullableString(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

function tailText(value, maxLength) {
  const text = nullableString(value);
  if (!text) return null;
  const limit = Number.isFinite(maxLength) ? Math.max(80, Math.floor(maxLength)) : 1200;
  return text.length > limit ? text.slice(text.length - limit) : text;
}

function arrayValue(value, fallback) {
  return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : fallback;
}

function normalizeStringRecord(value, fallback = {}) {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
  return Object.entries(row).reduce((next, [key, raw]) => {
    const normalizedKey = String(key || '').trim();
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (normalizedKey && text) next[normalizedKey] = text;
    return next;
  }, {});
}

function normalizeBaseUrl(value) {
  const text = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
  return text || null;
}

function hostnameFromUrl(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return '';
  }
}

function protocolFromUrl(value) {
  try {
    return new URL(value).protocol.replace(/:$/, '');
  } catch {
    return '';
  }
}

function portFromUrl(value) {
  try {
    return new URL(value).port;
  } catch {
    return '';
  }
}

function portFromHostHeader(value) {
  const text = nullableString(value);
  if (!text) return '';
  if (text.startsWith('[')) {
    const close = text.indexOf(']');
    return close > 0 ? text.slice(close + 1).replace(/^:/, '') : '';
  }
  const match = /:(\d+)$/.exec(text);
  return match?.[1] || '';
}

function joinApiUrl(baseUrl, pathName) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new Error('Internal API baseUrl 为空。');
  return `${base}${pathName.startsWith('/') ? pathName : `/${pathName}`}`;
}

function sdkGatewayBaseUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  return normalized ? `${normalized}/internal/v1/sdk` : '';
}

function uniqueValues(values) {
  return [...new Set(values)];
}

function displayNameFromAccount(account) {
  const text = account.trim();
  return text.includes('@') ? text.split('@')[0] : text;
}

function parseUserIdFromSubject(subject) {
  const text = nullableString(subject);
  if (!text) return null;
  return text.startsWith('user:') ? text.slice('user:'.length) : text;
}

function shortId() {
  return randomUUID().replace(/-/g, '');
}

function makeRequestId(prefix) {
  return `${prefix}-${Date.now()}-${shortId().slice(0, 8)}`;
}

function parseJsonPayload(text) {
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function classifyConnectionError(err) {
  const message = errorMessage(err);
  const status = Number(err?.status || err?.statusCode || err?.payload?.statusCode || 0);
  const lower = message.toLowerCase();
  if (isLocalRuntimePersistenceError(err)) {
    return {
      state: 'local-storage-error',
      message: `本机运行状态写入失败，这是本机文件错误，不表示服务端状态。请关闭重复运行的 MX-H2I，并检查安全软件或文件占用后重试；原始错误：${message}`
    };
  }
  if (isPublicIcpBlockedError(err)) {
    const host = publicHostFromUrl(runtime?.config?.bootstrapApiBaseUrl) || DEFAULT_BOOTSTRAP_HOST;
    return {
      state: 'network-unavailable',
      message: `公网域名被备案/公网入口拦截，不是 Internal 权限拒绝。请保留 Bootstrap API 域名，并使用 Host Resolve ${host}=<正式 Domestic gateway IP>；HTTPS 仅把该 IP 作为拨号目标，TLS SNI、HTTP Host 与证书校验仍使用原域名。原始错误：${message}`
    };
  }
  if (
    status === 401
    && lower.includes('wireguard public key is already bound to another active lease')
  ) {
    return {
      state: 'forbidden',
      message: `本机 WireGuard 公钥仍绑定在另一条活动租约上；这不是 Domestic 443 或 Internal 网络不可达。客户端已尝试本机保存的历史 capability，仍无法证明旧租约所有权。请在 Internal Admin 按公钥/设备找到并 release 旧租约，或使用“清理旧连接”完整轮换本机 installation 与 WireGuard 密钥后重连；原始错误：${message}`
    };
  }
  if (status === 403 || lower.includes('403 forbidden') || lower.includes('forbidden')) {
    return {
      state: 'forbidden',
      message: `Internal 已响应但拒绝请求（403）。请检查 launcher-network 产品、租约或当前 principal 权限；原始错误：${message}`
    };
  }
  if (lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('enetunreach') || lower.includes('ehostunreach') || lower.includes('eaddrnotavail') || lower.includes('etimedout') || lower.includes('fetch failed') || lower.includes('timeout') || lower.includes('请求超时')) {
    return {
      state: 'network-unavailable',
      message: `网络或 bootstrap API 暂不可达，已保留本机租约并等待恢复；原始错误：${message}`
    };
  }
  if (status >= 500 || lower.includes('service unavailable') || lower.includes('bad gateway') || lower.includes('socket hang up')) {
    return {
      state: 'server-unavailable',
      message: `Internal 服务可能正在重启或部署中，已保留本机租约并等待恢复；原始错误：${message}`
    };
  }
  return {
    state: 'server-unavailable',
    message
  };
}

function isLocalRuntimePersistenceError(err) {
  const code = typeof err?.code === 'string' ? err.code.toUpperCase() : '';
  const syscall = typeof err?.syscall === 'string' ? err.syscall.toLowerCase() : '';
  return ['EPERM', 'EACCES', 'EBUSY', 'ENOSPC', 'EROFS'].includes(code)
    && ['rename', 'write', 'open', 'chmod', 'mkdir', 'unlink', 'rm', 'fsync'].includes(syscall);
}

function isPublicIcpBlockedError(err) {
  const text = errorPayloadText(err).toLowerCase();
  return text.includes('non-compliance icp filing')
    || text.includes('beian')
    || text.includes('aliyun.com/beian')
    || text.includes('server: beaver');
}

function errorPayloadText(err) {
  const payload = err?.payload;
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object') {
    return Object.values(payload)
      .map((value) => Array.isArray(value) ? value.join(' ') : String(value || ''))
      .join(' ');
  }
  return '';
}

function errorMessage(err) {
  if (!err) return 'unknown error';
  const dial = err.originalUrl && err.dialUrl ? `${err.originalUrl} -> ${err.dialUrl}` : '';
  const mode = err.bootstrapResolveMode ? `resolve=${err.bootstrapResolveMode}` : '';
  const payload = err.payload;
  if (payload && typeof payload === 'object') {
    if (typeof payload.message === 'string') return payload.message;
    if (Array.isArray(payload.message)) return payload.message.join(', ');
    if (typeof payload.error === 'string') return payload.error;
  }
  if (typeof payload === 'string' && payload.trim()) {
    const compact = payload.replace(/\s+/g, ' ').trim();
    return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
  }
  if (err.name === 'AbortError') return '请求超时。';
  if (err.cause && typeof err.cause === 'object') {
    const code = typeof err.cause.code === 'string' ? err.cause.code : '';
    const address = typeof err.cause.address === 'string' ? err.cause.address : '';
    const port = err.cause.port ? `:${err.cause.port}` : '';
    const causeMessage = typeof err.cause.message === 'string' ? err.cause.message : '';
    if (code || causeMessage) {
      return [dial, mode, err.message, code, address ? `${address}${port}` : '', causeMessage]
        .filter(Boolean)
        .join(' / ');
    }
  }
  if (typeof err.code === 'string') {
    const address = typeof err.address === 'string' ? err.address : '';
    const port = err.port ? `:${err.port}` : '';
    return [dial, mode, err.message, err.code, address ? `${address}${port}` : '']
      .filter(Boolean)
      .join(' / ');
  }
  return [dial, mode, err.message || String(err)].filter(Boolean).join(' / ');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
