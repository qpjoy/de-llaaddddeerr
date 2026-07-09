const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const dnsPromises = require('node:dns').promises;
const net = require('node:net');
const dgram = require('node:dgram');
const { execFile } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, screen: electronScreen, powerMonitor, net: electronNet, dialog, session: electronSession } = require('electron');

loadDotEnvFiles();

const APP_ID = 'dev.qpjoy.mx-h2i';
const STATE_FILE = 'mx-h2i-runtime.json';
const H2O_RUNTIME_STORE_FILE = 'mx-h2i-h2o-runtime.json';
const STATE_BACKUP_DIR_NAME = 'state-backups';
const STATE_BACKUP_LIMIT = 5;
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
const DEFAULT_BOOTSTRAP_HOST = 'h2i.mxinfo-inc.cn';
const DEFAULT_DOMESTIC_RELAY_HOST = '116.62.51.154';
const STALE_DOMESTIC_RELAY_HOSTS = new Set(['121.43.253.179', '121.43.254.179']);
const DEFAULT_SPLIT_DNS_DOMAINS = 'mx.cn mxinfo-inc.cn internal.mx corp.mx h2i.mx';
const DARWIN_WIREGUARD_SERVICE_IDENTITY = {
  displayName: 'MX-H2I WireGuard',
  darwinLaunchDaemonLabelPrefix: 'com.qpjoy.mx-h2i.wireguard',
  darwinSupportRoot: '/Library/Application Support/QPJoy/MX-H2I',
  darwinLogDir: '/Library/Logs/QPJoy-MX-H2I',
  darwinDaemonScriptName: 'mx-h2i-wireguard-daemon.sh',
  staleDarwinLaunchDaemonLabelPrefixes: ['com.qpjoy.mx-h2i.wireguard']
};
const SYSTEM_DOMAIN_PROXY_REFRESH_MS = process.platform === 'win32' ? 5_000 : 30_000;
const SYSTEM_DOMAIN_PROXY_ROUTE_REFRESH_TIMEOUT_MS = 2200;
const SYSTEM_DOMAIN_PROXY_ROUTE_WARNING_MS = 60_000;
const NETWORK_CHANGE_MONITOR_MS = 5000;
const NETWORK_CHANGE_DEBOUNCE_MS = 1800;
const DARWIN_PROXY_SIGNATURE_TIMEOUT_MS = 1200;
const DARWIN_ENDPOINT_ROUTE_PROBE_TIMEOUT_MS = 1800;
const DARWIN_ENDPOINT_ROUTE_DELETE_TIMEOUT_MS = 2500;
const DARWIN_ENDPOINT_ROUTE_REPAIR_COOLDOWN_MS = 20_000;
const WIREGUARD_BACKGROUND_PROBE_DOWNGRADE_THRESHOLD = 3;
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
  rolloutGroup: 'staff-ring',
  useLocalEngineResources: true,
  restartAfterCodeUpdate: true
};

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
let windowBoundsSaveTimer = null;
let windowBoundsTrackingSuppressed = false;
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
let lastSystemPacReverseProxyRoutes = [];
let lastSystemPacReverseProxyRoutesWarningAt = 0;
let lastNetworkEnvironmentSignature = null;
let lastDarwinEndpointRouteRepairAt = 0;
let releaseUpdateCheckInFlight = null;
let postConnectUpdateTimer = null;

const TOP_DOCK_Y = 0;
const TOP_REVEAL_ZONE = 18;
const TOP_ANIMATION_STEPS = 24;
const TOP_REVEAL_HOLD_MS = 900;
const TOP_LEAVE_HIDE_MS = 180;
const WINDOW_BOUNDS_SAVE_DELAY_MS = 420;
const H2O_PROXY_START_TIMEOUT_MS = 12_000;
const H2O_PORT_RELEASE_TIMEOUT_MS = 8_000;
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

app.whenReady().then(async () => {
  runtime = await loadRuntime();
  await initializeSystemDomainProxy();
  void refreshNetworkEnvironmentDiagnostics('app-startup').catch((err) => {
    console.warn('[mx-h2i] startup network diagnostics failed:', errorMessage(err));
  });
  registerIpc();
  createTray();
  createMainWindow();
  void restoreH2oRuntimeAfterStartup().catch((err) => {
    console.warn('[mx-h2i] H2O startup restore failed:', errorMessage(err));
  });
  void reportInstallCompletionAndAdoptPendingUpdates().catch((err) => {
    console.warn('[mx-h2i] startup update bookkeeping failed:', errorMessage(err));
  });
  startTopRevealWatcher();
  startWireGuardRecoveryWatcher();
  startNetworkChangeWatcher();
});

// Closes the installer loop and promotes staged npm-package artifacts: on the
// first start after a version change, report installer-completed to Release
// Center; pending launcher-package pointers written by the update executor
// switch to current so this run resolves the new build output.
async function reportInstallCompletionAndAdoptPendingUpdates() {
  const executorMod = await import('@qpjoy/electron-launcher/release-update-executor');
  const baseDir = app.getPath('userData');
  const adopted = await executorMod.adoptPendingElectronLauncherPackages(baseDir);
  for (const pointer of adopted) {
    pushAppLog('appcenter', 'info', `Launcher package update adopted on start: ${pointer.version} (${pointer.path}).`);
  }
  const baseUrl = appCenterCatalogBaseUrl();
  if (!baseUrl) return;
  const mod = await import('@qpjoy/electron-launcher');
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

app.on('before-quit', () => {
  stopNetworkChangeWatcher();
  stopWireGuardRecoveryWatcher();
  void closeSystemDomainProxy();
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
    await recoverRetainedWireGuardBeforeBootstrap('guest-pre-bootstrap', {
      allowPrivileged: shouldAllowPrivilegedPreBootstrapRecovery()
    });
    setConnecting('guest');
    await refreshNetworkEnvironmentDiagnostics('guest-pre-connect', { phase: 'bootstrap', persist: false });
    await saveAndBroadcast();
    try {
      const session = await connectLauncherNetwork({
        identityKind: 'anonymous',
        requestTag: 'guest'
      });
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
        feedback: '访客 lease 已由 Internal 下发，并保留 180 天未续租回收。'
      });
    } catch (err) {
      await applyConnectionError('访客连接失败', err);
    }
    await saveAndBroadcast();
    return visibleRuntime();
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
    if (isGuestConnectionActiveForEmployeeLogin(runtime.connection)) {
      runtime.feedback = {
        tone: 'warning',
        message: guestConnectionEmployeeLoginMessage(runtime.connection)
      };
      touchRuntime('employee login blocked by guest connection');
      await saveAndBroadcast();
      return visibleRuntime();
    }
    await recoverRetainedWireGuardBeforeBootstrap('employee-pre-bootstrap', {
      allowPrivileged: shouldAllowPrivilegedPreBootstrapRecovery()
    });
    setConnecting('employee');
    await refreshNetworkEnvironmentDiagnostics('employee-pre-connect', { phase: 'bootstrap', persist: false });
    await saveAndBroadcast();
    try {
      const bootstrap = await resolveBootstrapEndpoint(runtime.config);
      const baseUrl = bootstrap.baseUrl;
      await applyResolvedBootstrapEndpoint(bootstrap);
      const auth = await authenticateUserViaGateway(baseUrl, account, password, {
        bootstrapResolveMode: bootstrap.resolveMode
      });
      const session = await connectLauncherNetwork({
        identityKind: 'user',
        userId: auth.user.userId,
        requestTag: 'employee'
      });
      await applyNetworkSession(session, {
        mode: 'employee',
        subject: `user:${auth.user.userId}`,
        routePolicy: 'user full',
        identity: {
          kind: 'user',
          displayName: auth.user.displayName || displayNameFromAccount(account),
          account: auth.user.email || account,
          scopes: ['auth.read', 'appcenter.read', 'network.hdi.status', 'network.proxy.app', 'network.dns.policy']
        },
        auth,
        feedback: '员工账号已绑定 Internal User Center，并续租固定 user IP。'
      });
      await hydrateH2oSystemSubscriptionsForUser({
        userId: auth.user.userId,
        baseUrl,
        bootstrapResolveMode: bootstrap.resolveMode,
        showInitializing: true
      });
    } catch (err) {
      await applyConnectionError('员工登录失败', err);
    }
    await saveAndBroadcast();
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:disconnect', async () => {
    if (postConnectUpdateTimer) {
      clearTimeout(postConnectUpdateTimer);
      postConnectUpdateTimer = null;
    }
    const systemDomainRestoreScript = systemDomainProxyManager?.darwinRestoreScript?.() || null;
    const wireGuard = await stopWireGuardForRuntime({
      darwinExtraUninstallShell: systemDomainRestoreScript
    });
    const standaloneOwnership = await releaseStandaloneOwnershipForRuntime('disconnect');
    const systemDomainProxy = systemDomainRestoreScript && wireGuard?.launchDaemon && wireGuard?.ok !== false
      ? await completeExternalSystemDomainProxyRestore('disconnect-combined')
      : await disableSystemDomainProxyForRuntime('disconnect');
    runtime.connection = idleConnection();
    runtime.auth = null;
    runtime.feedback = {
      tone: wireGuard?.ok === false || systemDomainProxy?.error ? 'warning' : 'info',
      message: wireGuard?.ok === false
        ? `已断开 launcher channel，但 WireGuard 停止失败：${wireGuard.message || wireGuard.error || 'unknown'}`
        : systemDomainProxy?.error
          ? `已断开 MX-H2I standalone channel；系统 PAC 恢复失败：${systemDomainProxy.error}`
          : standaloneOwnership?.error
            ? `已断开 MX-H2I standalone channel；本机 ownership registry 释放失败：${standaloneOwnership.error}`
          : '已断开 MX-H2I standalone channel、系统 PAC 和客户端 WireGuard；IP lease 会保留并在下次连接时续租。'
    };
    touchRuntime('disconnected');
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
    if (currentH2oRuntime.mode === 'system-tun' && !currentH2oRuntime.tunInstalled) {
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
    if (nextMode === 'system-tun' && !currentH2oRuntime.tunInstalled) {
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
  ipcMain.handle('mx-h2i:restart-app', async () => {
    runtime.feedback = {
      tone: 'info',
      message: '正在重启 MX-H2I。'
    };
    touchRuntime('app restart requested');
    await saveAndBroadcast();
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
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
  ipcMain.handle('mx-h2i:move-window-by', (_event, input) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (currentWindowMode !== 'launcher' || isTopHidden) return false;
    const dx = Number(input?.dx);
    const dy = Number(input?.dy);
    const totalDy = Number(input?.totalDy);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    const bounds = mainWindow.getBounds();
    const nextBounds = {
      x: Math.round(bounds.x + dx),
      y: Math.round(bounds.y + dy),
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
    mainWindow.setBounds({
      x: nextBounds.x,
      y: nextBounds.y,
      width: nextBounds.width,
      height: nextBounds.height
    }, false);
    lastVisibleBounds = mainWindow.getBounds();
    return {
      bounds: lastVisibleBounds,
      docked: isTopDocked
    };
  });
  ipcMain.handle('mx-h2i:finish-window-drag', (_event, input) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (currentWindowMode !== 'launcher' || isTopHidden) return false;
    const bounds = mainWindow.getBounds();
    const display = electronScreen.getDisplayMatching(bounds);
    const totalDy = Number(input?.totalDy);
    const releaseDock = isTopDocked && Number.isFinite(totalDy) && totalDy >= dockReleaseDistance(bounds, display);
    const shouldDock = !releaseDock && (isTopDocked || bounds.y <= display.workArea.y + dockActivationDistance(bounds, display));
    if (!shouldDock) {
      isTopDocked = false;
      topDockHidePending = false;
      topDockHoldUntil = 0;
      topDockLeaveStartedAt = 0;
      lastVisibleBounds = mainWindow.getBounds();
      return { docked: false, bounds: lastVisibleBounds };
    }
    return snapToTopEdge();
  });
  ipcMain.handle('mx-h2i:hide-top-dock-if-pending', () => {
    maybeHideTopDock();
    return true;
  });
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
  const width = clamp(normalized.width, minimum.width, Math.max(minimum.width, workArea.width));
  const height = clamp(normalized.height, minimum.height, Math.max(minimum.height, workArea.height));
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
  mainWindow.setBounds(bounds, false);
  windowBoundsTrackingSuppressed = false;
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
  const svg = encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
      <rect x="2" y="2" width="18" height="18" rx="5" fill="#2bf6d2"/>
      <path d="M6.2 7.3h2v3h5.6v-3h2v7.4h-2v-3H8.2v3h-2V7.3Z" fill="#071311"/>
    </svg>
  `);
  return nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${svg}`);
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
  mainWindow.setBounds(start, false);
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
  if (process.platform !== 'darwin') return;
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
  if (runtime?.connection?.state !== 'connected') return;
  await refreshSystemDomainProxyAfterNetworkChange(recoveryReason);
}

async function refreshSystemDomainProxyAfterNetworkChange(reason) {
  if (!systemDomainProxyManager || runtime?.connection?.state !== 'connected') return null;
  if (typeof systemDomainProxyManager.statusVerified === 'function') {
    const verified = await systemDomainProxyManager.statusVerified().catch(() => null);
    if (verified?.applied === true) {
      await recordSystemDomainProxyDiagnostics({
        ...verified,
        reason,
        verified: true,
        skipped: true,
        skipReason: 'network-change-verified'
      }, `system domain proxy verified: ${reason}`);
      return verified;
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
  if (!result?.ready || runtime?.connection?.state !== 'connected') return null;
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
  if (process.platform !== 'darwin') return null;
  const [route, services, networkInfo] = await Promise.all([
    execFileText('/sbin/route', ['-n', 'get', 'default']).catch((err) => `route-error:${errorMessage(err)}`),
    execFileText('/usr/sbin/networksetup', ['-listallnetworkservices']).catch((err) => `services-error:${errorMessage(err)}`),
    execFileText('/usr/sbin/scutil', ['--nwi']).catch((err) => `nwi-error:${errorMessage(err)}`)
  ]);
  const serviceNames = compactDarwinNetworkServices(services);
  const autoProxy = await captureDarwinAutoProxySignature(serviceNames);
  return JSON.stringify({
    route: compactDarwinDefaultRoute(route),
    services: serviceNames,
    autoProxy,
    networkInfo: compactDarwinNetworkInfo(networkInfo)
  });
}

function compactDarwinDefaultRoute(stdout) {
  const text = String(stdout || '');
  const pick = (name) => nullableString(text.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, 'im'))?.[1]);
  return {
    gateway: pick('gateway'),
    interfaceName: pick('interface'),
    ifscope: pick('ifscope')
  };
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

async function initializeSystemDomainProxy() {
  try {
    const mod = await import('@qpjoy/electron-launcher/system-domain-proxy');
    systemDomainProxyManager = mod.createElectronLauncherSystemDomainProxy({
      userDataDir: app.getPath('userData'),
      pacPort: localEdgePort(),
      log: console
    });
    if (process.env.MX_H2I_RESTORE_SYSTEM_PROXY_ON_STARTUP === '1') {
      await systemDomainProxyManager.restoreStale('app-startup');
    } else {
      const status = typeof systemDomainProxyManager.status === 'function'
        ? systemDomainProxyManager.status()
        : null;
      if (status?.applied) {
        console.warn('[mx-h2i] system domain proxy state exists; startup restore skipped to avoid a macOS authorization prompt. Disconnect or reconnect MX-H2I to repair it.');
      }
    }
    startSystemDomainProxyRefreshWatcher();
  } catch (err) {
    console.warn('[mx-h2i] system domain proxy unavailable:', errorMessage(err));
    systemDomainProxyManager = null;
  }
}

async function ensureSystemDomainProxyForRuntime(reason = 'manual') {
  if (systemDomainProxyEnsureInFlight) {
    const status = await systemDomainProxyEnsureInFlight;
    if (
      shouldApplySystemDomainProxyForReason(reason)
      && status?.skipped === true
      && status?.skipReason === 'background-refresh-no-privileged-apply'
    ) {
      return ensureSystemDomainProxyForRuntimeOnce(reason);
    }
    return status && typeof status === 'object'
      ? { ...status, reason, coalesced: true }
      : status;
  }
  const pending = ensureSystemDomainProxyForRuntimeOnce(reason);
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
  if (!systemDomainProxyManager) return null;
  if (runtime?.connection?.state !== 'connected') {
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
      const status = await systemDomainProxyManager.apply(policy);
      lastSystemDomainProxyPolicySignature = policySignature;
      if (isSystemDomainProxyAuthorizationCanceled(status)) {
        lastSystemDomainProxyAuthorizationCanceledSignature = policySignature;
      } else if (status?.applied && !status?.error && !status?.resolverError) {
        lastSystemDomainProxyAuthorizationCanceledSignature = null;
      }
      return status;
    } catch (err) {
      lastSystemDomainProxyPolicySignature = policySignature;
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

function shouldSuppressWireGuardDnsForSystemDomainProxy(_prepared = null) {
  return process.platform === 'darwin' && Boolean(systemDomainProxyManager);
}

async function disableSystemDomainProxyForRuntime(reason = 'manual') {
  if (!systemDomainProxyManager) return null;
  lastSystemDomainProxySignature = null;
  lastSystemDomainProxyPolicySignature = null;
  lastSystemDomainProxyAuthorizationCanceledSignature = null;
  lastSystemPacReverseProxyRoutes = [];
  lastSystemPacReverseProxyRoutesWarningAt = 0;
  try {
    return await systemDomainProxyManager.disable(reason);
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

async function completeExternalSystemDomainProxyApply(reason = 'external') {
  if (!systemDomainProxyManager?.completeExternalApply) return null;
  try {
    const status = await systemDomainProxyManager.completeExternalApply(reason);
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
  await systemDomainProxyManager.close?.().catch(() => undefined);
}

function startSystemDomainProxyRefreshWatcher() {
  if (systemDomainProxyRefreshInterval) return;
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
  if (systemDomainProxyRefreshInFlight || !systemDomainProxyManager) return null;
  if (runtime?.connection?.state !== 'connected') return null;
  systemDomainProxyRefreshInFlight = true;
  try {
    const status = await ensureSystemDomainProxyForRuntime(reason);
    await recordSystemDomainProxyDiagnostics(status, `system domain proxy refreshed: ${reason}`);
    return status;
  } finally {
    systemDomainProxyRefreshInFlight = false;
  }
}

async function recordSystemDomainProxyDiagnostics(status, touchReason) {
  const signature = systemDomainProxyStatusSignature(status);
  if (!signature || signature === lastSystemDomainProxySignature) return false;
  lastSystemDomainProxySignature = signature;
  runtime.connection = {
    ...runtime.connection,
    diagnostics: {
      ...(runtime.connection?.diagnostics || {}),
      systemDomainProxy: status
    }
  };
  touchRuntime(touchReason);
  await saveAndBroadcast();
  return true;
}

async function refreshNetworkEnvironmentDiagnostics(reason = 'manual', options = {}) {
  if (!runtime) return null;
  const diagnostics = await collectNetworkEnvironmentDiagnostics(reason, options);
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

async function collectNetworkEnvironmentDiagnostics(reason = 'manual', options = {}) {
  const phase = options.phase || networkDiagnosticPhase();
  const host = options.host || networkDiagnosticHost();
  const status = await systemDomainProxyStatusForDiagnostics(phase);
  const endpointRoute = await collectDarwinEndpointRouteDiagnostics(reason, { phase });
  const windowsNrpt = collectWindowsNrptDiagnostics();
  let resolution = null;
  try {
    const mod = await import('@qpjoy/electron-launcher/network-diagnostics');
    resolution = await mod.diagnoseLauncherHostResolution({
      host,
      phase,
      expectedInternalTargets: expectedInternalDnsTargets(),
      internalCidrs: internalDiagnosticCidrs(),
      v1HdoCidrs: configuredCidrList(process.env.MX_H2I_V1_HDO_CIDRS),
      proxyFakeIpCidrs: configuredCidrList(process.env.MX_H2I_PROXY_FAKE_IP_CIDRS)
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
  return {
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
}

async function systemDomainProxyStatusForDiagnostics(phase) {
  const status = typeof systemDomainProxyManager?.status === 'function'
    ? systemDomainProxyManager.status()
    : null;
  if (phase !== 'connected' || typeof systemDomainProxyManager?.statusVerified !== 'function') {
    return status;
  }
  return systemDomainProxyManager.statusVerified().catch(() => status);
}

function collectWindowsNrptDiagnostics() {
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
    state,
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
    return '；检测到旧 HDO Windows NRPT 脚本标记（comment=MX HDO / QPJoy HDO），这台机器大概率不是最新 MX-H2I 安装包或旧服务脚本未覆盖，请安装最新包后重连。';
  }
  if (windowsNrpt.state === 'restart-remove-only') {
    return '；当前日志只看到重启时移除 NRPT，尚未看到 nrpt add complete，可能正处于重启窗口期或服务脚本未继续安装规则，请稍等数秒后重新诊断，仍失败则重新连接/修复网络。';
  }
  if (windowsNrpt.state === 'global-disabled') {
    return '；Windows NRPT 全局策略仍为 Disable，split DNS 不会接管所有网络，请用管理员授权重新连接或修复网络。';
  }
  if (windowsNrpt.state === 'rules-missing') {
    return '；Windows NRPT 规则安装后校验缺失，请用管理员授权重新连接或修复网络，并检查是否有安全软件/组策略拦截 NRPT。';
  }
  if (windowsNrpt.state === 'ready') {
    return '；Windows NRPT 日志显示规则已安装，若仍外部解析，请检查浏览器 Secure DNS/DoH、系统 DNS 缓存或第三方代理残留。';
  }
  return '';
}

async function repairSystemNetworkForRuntime(reason = 'manual-repair') {
  const connected = runtime?.connection?.state === 'connected';
  const before = await collectNetworkEnvironmentDiagnostics(`${reason}-before`);
  const endpointRouteRepair = await repairDarwinStaleEndpointRoutesForRuntime(reason, { force: true });
  let systemDomainProxy = null;
  if (connected) {
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
  lastSystemDomainProxySignature = null;
  lastNetworkEnvironmentSignature = null;
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
        systemDomainProxy,
        after,
        updatedAt: nowIso()
      },
      updatedAt: nowIso()
    }
  };
  runtime.feedback = {
    tone: systemDomainProxy?.error || (endpointRouteRepair?.stale === true && endpointRouteRepair?.repaired !== true)
      ? 'warning'
      : after?.resolution?.severity === 'error'
        ? 'warning'
        : 'success',
    message: connected
      ? `已重新确认 MX-H2I PAC/DNS：${after?.resolution?.message || 'network ready'}${darwinEndpointRouteRepairFeedback(endpointRouteRepair)}`
      : `已执行系统网络修复：${after?.resolution?.message || 'stale state cleared'}${darwinEndpointRouteRepairFeedback(endpointRouteRepair)}`
  };
  touchRuntime(`system network repaired: ${reason}`);
  return {
    before,
    endpointRouteRepair,
    systemDomainProxy,
    after
  };
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
  const defaultRoute = await darwinRouteGet('default');
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
    if (coolingDown) {
      repairs.push({
        target: route.target,
        ok: false,
        skipped: true,
        skipReason: 'cooldown',
        updatedAt: nowIso()
      });
      continue;
    }
    const repair = await deleteDarwinHostRoute(route.target.address);
    let after = null;
    if (repair.ok === true) {
      const afterRoute = await darwinRouteGet(route.target.address);
      const afterClassification = classifyDarwinEndpointRoute(afterRoute, diagnostics.defaultRoute);
      after = {
        ok: afterRoute.ok === true,
        gateway: afterRoute.gateway || null,
        interfaceName: afterRoute.interfaceName || null,
        flags: arrayValue(afterRoute.flags, []),
        stale: afterClassification.stale,
        staleReason: afterClassification.reason,
        error: afterRoute.error || null
      };
    }
    repairs.push({
      target: route.target,
      before: {
        gateway: route.gateway,
        interfaceName: route.interfaceName,
        flags: arrayValue(route.flags, []),
        staleReason: route.staleReason
      },
      ...repair,
      after,
      updatedAt: nowIso()
    });
  }
  return {
    ...diagnostics,
    repairs,
    repaired: repairs.some((repair) => repair.ok === true && repair.after?.stale !== true),
    skipped: coolingDown,
    skipReason: coolingDown ? 'cooldown' : null,
    updatedAt: nowIso()
  };
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
  const targets = [];
  const errors = [];
  for (const candidate of candidates) {
    const resolved = await resolveDarwinEndpointRouteCandidate(candidate);
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

async function resolveDarwinEndpointRouteCandidate(candidate) {
  const text = nullableString(candidate.value);
  if (!text) return [];
  const host = candidate.endpoint ? publicHostFromEndpoint(text) : hostnameFromMaybeUrl(text);
  if (!host || host === 'localhost' || net.isIP(host) === 6) return [];
  if (net.isIP(host) === 4) {
    return isPublicIpv4Address(host)
      ? [{ source: candidate.source, value: text, host, address: host }]
      : [];
  }
  try {
    const rows = await dnsPromises.lookup(host, { family: 4, all: true });
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
    const stdout = await execFileText('/sbin/route', ['-n', 'get', host], {
      timeoutMs: DARWIN_ENDPOINT_ROUTE_PROBE_TIMEOUT_MS
    });
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
    flags,
    raw: tailText(text, 1200)
  };
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
  const defaultGateway = nullableString(defaultRoute?.gateway);
  const defaultInterfaceName = nullableString(defaultRoute?.interfaceName);
  if (gateway && isDarwinProxyFakeGateway(gateway)) {
    return { stale: true, reason: `proxy-fake-gateway:${gateway}` };
  }
  if (flags.has('WASCLONED') && gateway && defaultGateway && gateway !== defaultGateway) {
    return { stale: true, reason: `gateway-mismatch:${gateway}->${defaultGateway}` };
  }
  if (flags.has('WASCLONED') && interfaceName && defaultInterfaceName && interfaceName !== defaultInterfaceName) {
    return { stale: true, reason: `interface-mismatch:${interfaceName}->${defaultInterfaceName}` };
  }
  return { stale: false, reason: null };
}

async function deleteDarwinHostRoute(address) {
  const target = nullableString(address);
  if (!target) return { ok: false, error: 'empty route delete target' };
  const attempts = [
    ['delete', '-host', target],
    ['delete', target]
  ];
  const failures = [];
  for (const args of attempts) {
    try {
      const stdout = await execFileText('/sbin/route', args, {
        timeoutMs: DARWIN_ENDPOINT_ROUTE_DELETE_TIMEOUT_MS
      });
      return {
        ok: true,
        command: `/sbin/route ${args.join(' ')}`,
        stdout: tailText(stdout, 800)
      };
    } catch (err) {
      const message = `${errorMessage(err)} ${err?.stderr || ''} ${err?.stdout || ''}`.trim();
      const failure = {
        command: `/sbin/route ${args.join(' ')}`,
        error: errorMessage(err),
        stderr: tailText(err?.stderr, 800),
        stdout: tailText(err?.stdout, 800),
        requiresPrivilege: /must be root|not permitted|operation not permitted|permission denied|权限/i.test(message)
      };
      if (/not in table|not found|no such process/i.test(message)) {
        return {
          ...failure,
          ok: true,
          notFound: true
        };
      }
      failures.push(failure);
    }
  }
  return {
    ok: false,
    failures,
    error: failures[failures.length - 1]?.error || 'route delete failed',
    requiresPrivilege: failures.some((failure) => failure.requiresPrivilege === true)
  };
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
  const via = [route?.gateway, route?.interfaceName].filter(Boolean).join(' / ') || 'unknown route';
  return `${target} via ${via}`;
}

function darwinEndpointRouteRepairFailure(result) {
  const unchanged = objectList(result?.repairs).find((repair) => repair?.ok === true && repair?.after?.stale === true);
  if (unchanged) {
    const via = [unchanged.after?.gateway, unchanged.after?.interfaceName].filter(Boolean).join(' / ') || 'unknown route';
    return `，删除后系统仍解析到 ${via}。`;
  }
  const failed = objectList(result?.repairs).find((repair) => repair?.ok !== true && repair?.skipped !== true);
  if (!failed) return '。';
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
  return firstHostname([
    process.env.MX_H2I_DNS_DIAGNOSTIC_HOST,
    routeHost,
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

function expectedInternalDnsTargets() {
  const routePlan = normalizeRoutePlan(runtime?.connection?.routePlan);
  return uniqueStrings([
    nullableString(routePlan?.internalControlIp),
    ipv4HostFromBaseUrl(routePlan?.internalBaseUrl),
    nullableString(runtime?.connection?.internalControlIp),
    ipv4HostFromBaseUrl(runtime?.connection?.internalBaseUrl),
    systemPacDnsFallbackTarget(),
    INTERNAL_PEER_IP
  ].filter(Boolean));
}

function internalDiagnosticCidrs() {
  const routePlan = normalizeRoutePlan(runtime?.connection?.routePlan);
  return uniqueStrings([
    ...configuredCidrList(process.env.MX_H2I_INTERNAL_CIDRS),
    ...arrayValue(routePlan?.routeCidrs, []).filter(isLikelyInternalDiagnosticCidr),
    '10.88.0.0/16',
    '10.89.0.0/16',
    '10.90.0.0/16'
  ].filter(Boolean));
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
    pacUrl: nullableString(status.pacUrl),
    proxy: nullableString(status.proxy),
    fallbackProxy: nullableString(status.fallbackProxy),
    systemResolverMode: nullableString(status.systemResolverMode),
    resolverApplied: status.resolverApplied === true,
    resolverError: nullableString(status.resolverError),
    resolverDomains: arrayValue(status.resolverDomains, []),
    resolverPort: status.resolverPort || null,
    ownershipRegistry: status.ownershipRegistry && typeof status.ownershipRegistry === 'object'
      ? {
          owners: arrayValue(status.ownershipRegistry.owners, []).map((owner) => nullableString(owner?.ownerId)).filter(Boolean),
          conflicts: arrayValue(status.ownershipRegistry.conflicts, [])
        }
      : null,
    staleState: status.staleState === true,
    error: nullableString(status.error)
  };
}

function systemDomainProxyOwnershipClaim(domains, reverseProxyRoutes) {
  const installation = runtime?.installation || {};
  const connection = runtime?.connection || {};
  const productId = launcherProductId();
  return {
    ownerId: `${productId}:${installation.installId || installation.deviceId || 'local'}`,
    productId,
    instanceId: nullableString(installation.installId) || nullableString(installation.deviceId),
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

async function registerStandaloneOwnershipForRuntime(reason = 'manual') {
  const connection = runtime?.connection || {};
  const routePlan = normalizeRoutePlan(connection.routePlan);
  if (!routePlan) return null;
  try {
    const mod = await import('@qpjoy/electron-launcher/standalone-data-plane');
    const claim = mxH2iStandaloneOwnershipClaim(mod, routePlan, connection);
    const state = mod.upsertElectronLauncherStandaloneOwnershipClaim({
      ...claim,
      state: connection.state === 'connected' ? 'active' : 'connecting',
      updatedAt: nowIso()
    });
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

async function releaseStandaloneOwnershipForRuntime(reason = 'manual') {
  try {
    const mod = await import('@qpjoy/electron-launcher/standalone-data-plane');
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
    instanceId: nullableString(runtime?.installation?.installId) || nullableString(runtime?.installation?.deviceId),
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
  if (plan?.leaseCidr) return [plan.leaseCidr];
  const localIp = nullableString(connection.localIp);
  return localIp ? [`${localIp}/32`] : [];
}

function standaloneOwnershipOwnerId() {
  return `${launcherProductId()}:${nullableString(runtime?.installation?.installId) || nullableString(runtime?.installation?.deviceId) || 'local'}`;
}

function compactStandaloneOwnershipState(state, reason) {
  const registry = state?.registry && typeof state.registry === 'object' ? state.registry : {};
  const conflicts = arrayValue(registry.conflicts, []);
  return {
    ok: conflicts.length === 0,
    reason,
    statePath: nullableString(state?.statePath),
    owners: arrayValue(registry.owners, []).map((owner) => nullableString(owner?.ownerId)).filter(Boolean),
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
    systemDomainProxy: diagnostics.systemDomainProxy
      ? {
          applied: diagnostics.systemDomainProxy.applied === true,
          pacUrl: diagnostics.systemDomainProxy.pacUrl || null,
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
    pacUrl: nullableString(status.pacUrl),
    proxy: nullableString(status.proxy),
    fallbackProxy: nullableString(status.fallbackProxy),
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
  if (!isBackgroundSystemDomainProxyReason(reason) || !policySignature || policySignature !== lastSystemDomainProxyPolicySignature) {
    return null;
  }
  if (process.platform === 'win32') return null;
  const status = typeof systemDomainProxyManager?.status === 'function'
    ? systemDomainProxyManager.status()
    : null;
  if (
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
  const verified = shouldVerifySystemDomainProxyBeforeBackgroundSkip(reason)
    ? await systemDomainProxyManager?.statusVerified?.().catch(() => null)
    : null;
  if (verified && typeof verified === 'object') {
    if (systemDomainProxyStatusLooksApplied(verified)) {
      return {
        ...verified,
        reason,
        skipped: true
      };
    }
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

function isBackgroundSystemDomainProxyReason(reason) {
  const text = String(reason || '');
  return text === 'route-refresh' || text === 'app-startup' || text === 'app-startup-refresh';
}

function shouldVerifySystemDomainProxyBeforeBackgroundSkip(reason) {
  return process.platform === 'darwin' && String(reason || '') === 'route-refresh';
}

function systemDomainProxyStatusLooksApplied(status) {
  if (!status || typeof status !== 'object' || status.applied !== true) return false;
  const resolverMode = nullableString(status.systemResolverMode);
  const resolverDomains = arrayValue(status.resolverDomains, []);
  return resolverMode !== 'dynamic' || resolverDomains.length === 0 || status.resolverApplied === true;
}

function shouldApplySystemDomainProxyForReason(reason) {
  const text = String(reason || '');
  if (process.platform === 'win32' && isBackgroundSystemDomainProxyReason(text)) return true;
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
    process.env.MX_H2I_DOMESTIC_DNS_SERVER,
    process.env.MX_H2I_DOMESTIC_DNS_EDGE,
    domesticPublicDnsServer(),
    dnsServerWithDefaultPort(runtime?.connection?.routePlan?.dnsServer, DEFAULT_DOMESTIC_DNS_EDGE_PORT),
    domesticGatewayDnsServer(),
    internalDnsEdgeServer(runtime?.connection?.routePlan?.internalControlIp),
    internalDnsEdgeServer(runtime?.connection?.internalControlIp),
    internalDnsEdgeServer(INTERNAL_PEER_IP)
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
  const allowWarnings = options.allowWarnings !== false;
  if (!allowWarnings && now - lastSystemPacReverseProxyRoutesWarningAt < SYSTEM_DOMAIN_PROXY_ROUTE_WARNING_MS) {
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
    mainWindow.setBounds({
      x: Math.round(from.x + (to.x - from.x) * t),
      y: Math.round(from.y + (to.y - from.y) * t),
      width: Math.round(from.width + (to.width - from.width) * t),
      height: Math.round(from.height + (to.height - from.height) * t)
    }, false);
    if (step >= steps) {
      stopTopAnimation();
      onDone?.();
    }
  }, 18);
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
    loaded = await normalizeRuntime(JSON.parse(raw));
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
  return {
    config,
    installation: normalizeInstallation(row.installation),
    auth: normalizeAuth(row.auth),
    connection: normalizeConnection(row.connection),
    identity: normalizeIdentity(row.identity),
    apps: normalizeApps(row.apps),
    update: normalizeUpdate(row.update, config),
    launcherContract: await launcherContract(config),
    window: normalizeWindowState(row.window),
    feedback: null,
    activity: Array.isArray(row.activity) ? row.activity.slice(0, 8) : defaultActivity(),
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : nowIso()
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
  const bootstrapApiBaseUrl = normalizeBootstrapApiBaseUrlConfig(row.bootstrapApiBaseUrl);
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
    internalApiBaseUrl: normalizeInternalApiBaseUrlConfig(row.internalApiBaseUrl),
    domesticRelayHost,
    domesticRelayPort: Number.isInteger(domesticRelayPort) && domesticRelayPort > 0 ? domesticRelayPort : DEFAULT_CONFIG.domesticRelayPort,
    sdkGatewayBaseUrl: normalizeSdkGatewayBaseUrlConfig(row.sdkGatewayBaseUrl, bootstrapApiBaseUrl),
    hostResolve,
    bootstrapResolveMode: normalizeBootstrapResolveModeConfig(row.bootstrapResolveMode, bootstrapApiBaseUrl, hostResolve),
    bootstrapDnsServers: stringValue(row.bootstrapDnsServers, DEFAULT_CONFIG.bootstrapDnsServers),
    splitDnsDomains: stringValue(row.splitDnsDomains, DEFAULT_CONFIG.splitDnsDomains),
    routePathPreference: normalizeRoutePathPreference(row.routePathPreference || DEFAULT_CONFIG.routePathPreference),
    releaseChannel: stringValue(row.releaseChannel, DEFAULT_CONFIG.releaseChannel),
    rolloutGroup: stringValue(row.rolloutGroup, DEFAULT_CONFIG.rolloutGroup),
    useLocalEngineResources: row.useLocalEngineResources !== false,
    restartAfterCodeUpdate: row.restartAfterCodeUpdate !== false
  };
}

function normalizeBootstrapApiBaseUrlConfig(value) {
  const normalized = normalizeBaseUrl(value) || DEFAULT_CONFIG.bootstrapApiBaseUrl;
  if (isLegacyDefaultBootstrapApiBaseUrl(normalized)) return DEFAULT_CONFIG.bootstrapApiBaseUrl;
  return normalized;
}

function isLegacyDefaultBootstrapApiBaseUrl(value) {
  try {
    const parsed = new URL(normalizeBaseUrl(value) || '');
    return parsed.hostname === 'api.mxinfo-inc.cn' && (parsed.port || '80') === '18090';
  } catch {
    return false;
  }
}

function normalizeSdkGatewayBaseUrlConfig(value, bootstrapApiBaseUrl) {
  const fallback = DEFAULT_CONFIG.sdkGatewayBaseUrl || sdkGatewayBaseUrl(bootstrapApiBaseUrl);
  const normalized = normalizeBaseUrl(value);
  if (!normalized || isLegacyDefaultSdkGatewayBaseUrl(normalized)) return fallback;
  return normalized;
}

function isLegacyDefaultSdkGatewayBaseUrl(value) {
  try {
    const parsed = new URL(normalizeBaseUrl(value) || '');
    return parsed.hostname === 'api.mxinfo-inc.cn'
      && (parsed.port || '80') === '18090'
      && parsed.pathname.replace(/\/+$/, '') === '/internal/v1/sdk';
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
    siteId: stringValue(row.siteId, 'domestic-main'),
    deviceLabel: nullableString(row.deviceLabel),
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
      localIp: stringValue(row.localIp, '10.89.120.24'),
      routePolicy: stringValue(row.routePolicy, 'guest limited'),
      subject: stringValue(row.subject, 'anonymousPrincipal:h2i-demo'),
      connectedAt: typeof row.connectedAt === 'string' ? row.connectedAt : nowIso(),
      leaseId: nullableString(row.leaseId),
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
      displayName: stringValue(row.displayName, 'employee'),
      account: stringValue(row.account, 'employee@qpjoy.local'),
      scopes: arrayValue(row.scopes, ['auth.read', 'appcenter.read'])
    };
  }
  return {
    kind: 'anonymous',
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
    scopes: arrayValue(row.scopes, typeof row.scope === 'string' ? row.scope.split(/\s+/) : [])
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
      installSource: 'npm',
      installPath: null,
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
    activeSubscriptionId: activeSubscription.id,
    activeSubscription,
    subscriptions,
    rules: normalizeH2oRules(row.rules),
    metrics: normalizeH2oMetrics(row.metrics),
    startedAt: nullableString(row.startedAt),
    lastAppliedAt: nullableString(row.lastAppliedAt)
  };
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

function normalizeH2oMode(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'rule') return 'app-rule';
  if (text === 'global') return 'app-global';
  if (text === 'tun') return 'system-tun';
  if (text === 'direct') return 'app-global';
  return ['app-rule', 'app-global', 'system-tun'].includes(text) ? text : 'app-global';
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
    const payload = await requestJson(joinApiUrl(baseUrl, '/internal/v1/user-center/users'), {
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
  const result = await manager.applyManagedConfig({
    subscription: h2oTunnelSubscriptionInput(current.activeSubscription),
    mode: current.mode,
    rules: h2oTunnelRulesForMode(current),
    source: 'h2o',
    autoStart: true,
    autoUpdate: true,
    allowSystemTunPrivilege: current.mode === 'system-tun'
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
  return { ...status, traffic };
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

function h2oTunnelRulesForMode(h2oRuntime) {
  const enabled = normalizeH2oRules(h2oRuntime.rules).filter((rule) => rule.enabled !== false);
  const blocklist = enabled.filter((rule) => rule.kind === 'block').map((rule) => rule.host);
  const allowlist = h2oRuntime.mode === 'app-rule'
    ? enabled.filter((rule) => rule.kind === 'allow').map((rule) => rule.host)
    : [];
  return { allowlist, blocklist };
}

function h2oRuntimeWithTunnelStatus(h2oRuntime, tunnelStatus) {
  const running = tunnelStatus?.running === true;
  return h2oPluginRuntime({
    ...h2oRuntime,
    running,
    status: running ? 'running' : 'ready',
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
    ({ allocateElectronLauncherLocalPort: allocate } = await import('@qpjoy/electron-launcher/local-ports'));
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
  runtime.apps.h2o.runtime = h2oPluginRuntime({
    ...current,
    metrics,
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
  if (
    !current.running
    && current.status === 'starting'
    && h2oHasUsableSubscription(current.activeSubscription)
  ) {
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

function createH2oTestWindow(targetUrl) {
  const win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    title: `H2O Test - ${hostnameFromUrl(targetUrl) || 'browser'}`,
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
  if (h2oRuntime.mode === 'system-tun') return 'system-tun';
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
  const siteAttempts = await h2oOverseaProvisionSiteAttempts(input, {
    baseUrl,
    bootstrapResolveMode: input.bootstrapResolveMode
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
  const explicit = [
    ...arrayValue(input?.siteIds, []),
    nullableString(input?.siteId)
  ].map((item) => String(item || '').trim()).filter(Boolean);
  if (explicit.length) return [[explicit[0]]];

  const discoveredSiteIds = await discoverH2oOverseaSiteIds(options);
  const hasOverseaMain = discoveredSiteIds.includes('oversea-main');
  const candidates = hasOverseaMain || !discoveredSiteIds.length
    ? ['oversea-main', '', ...discoveredSiteIds.filter((item) => item !== 'oversea-main')]
    : [discoveredSiteIds[0], '', ...discoveredSiteIds.slice(1), 'oversea-main'];
  const seen = new Set();
  return candidates
    .filter((siteId) => {
      const key = siteId || '<server-default>';
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((siteId) => siteId ? [siteId] : []);
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
  const baseUrl = normalizeBaseUrl(options.baseUrl)
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
    const entitlementPayload = await requestJson(
      joinApiUrl(baseUrl, `/internal/v1/user-center/users/${encodeURIComponent(userId)}/oversea`),
      {
        timeoutMs: 5000,
        bootstrapResolveMode: options.bootstrapResolveMode,
        headers: appCenterCatalogHeaders()
      }
    );
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

    let yaml;
    try {
      yaml = await requestText(subscriptionFetchUrl, {
        timeoutMs: 5000,
        bootstrapResolveMode: options.bootstrapResolveMode,
        headers: { ...appCenterCatalogHeaders(), accept: 'text/yaml, text/plain, */*' }
      });
    } catch (err) {
      const internalSubscriptionUrl = joinApiUrl(baseUrl, subscriptionPath);
      if (internalSubscriptionUrl === subscriptionFetchUrl) throw err;
      pushAppLog('h2o', 'warning', `H2O public subscription fetch failed, retrying Internal URL: ${errorMessage(err)}`);
      yaml = await requestText(internalSubscriptionUrl, {
        timeoutMs: 5000,
        bootstrapResolveMode: options.bootstrapResolveMode,
        headers: { ...appCenterCatalogHeaders(), accept: 'text/yaml, text/plain, */*' }
      });
    }
    applyH2oManagedSubscriptionState(current, {
      entitlement,
      status: 'ready',
      syncStatus: syncedAccounts.length ? 'synced' : 'pending-runtime-sync',
      subscriptionUrl: subscriptionRuntimeUrl,
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
    parsed.hostname = domesticHost;
    parsed.username = '';
    parsed.password = '';
    return normalizeBaseUrl(parsed.toString());
  } catch (_err) {
    return null;
  }
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
    version: releaseDecision?.targetVersion || app.getVersion(),
    fromVersion: app.getVersion(),
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
    currentVersion: app.getVersion(),
    latestVersion: releaseDecision?.targetVersion || app.getVersion(),
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
    activation: releaseArtifact?.activation || null,
    restartRequired: releaseArtifact?.restartRequired === true,
    majorUpdateRequiresInstaller: releasePlan?.activation?.majorUpdateRequiresInstaller === true,
    hotUpdateAuto: releasePlan?.activation?.hotUpdateAuto === true,
    releaseNotes: releaseResult?.releaseNotes || null,
    rolloutMatchedBy: releaseResult?.rollout?.matchedBy || null,
    rolloutBucket: Number.isFinite(releaseResult?.rollout?.bucket) ? releaseResult.rollout.bucket : null,
    featureFlags: Array.isArray(releaseResult?.featureFlags) ? releaseResult.featureFlags : [],
    downloadProgress: null,
    availableReleases: releaseCatalog.ok
      ? releaseCatalog.releases
      : mergeAvailableRelease(runtime.update?.availableReleases, availableReleaseFromPlan(releasePlan, releaseDecision, releaseArtifact, releaseResult?.status)),
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
  if (!quiet || hasUpdateSignal) {
    runtime.feedback = {
      tone: failures.length ? 'warning' : (releaseResult?.status === 'update-available' ? 'success' : 'info'),
      message: failures.length
        ? `${releaseMessage} ${failures.join('；')}`
        : `${releaseMessage} 当前 ${app.getVersion()}，目标 ${releaseDecision?.targetVersion || app.getVersion()}，通道 ${runtime.config.releaseChannel}。AppCenter 目录已同步 ${catalogSync.count} 个应用。`
    };
  }
  touchRuntime('update checked');
  await saveAndBroadcast();
  return { ok: failures.length === 0, skipped: false, releaseResult, catalogSync, releaseSync };
}

async function fetchReleaseHistory(reason) {
  try {
    const baseUrl = appCenterCatalogBaseUrl();
    if (!baseUrl) return { ok: false, releases: [], message: 'Internal API baseUrl 为空' };
    const payload = await requestJson(joinApiUrl(baseUrl, '/internal/v1/release-management/plans'), {
      timeoutMs: 4500,
      headers: appCenterCatalogHeaders()
    });
    const plans = Array.isArray(payload?.plans) ? payload.plans : [];
    const releases = plans
      .map((plan) => availableReleaseFromPlan(plan))
      .filter(Boolean)
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      .slice(0, 8);
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
    || plan?.components?.launcher
    || plan?.components?.app
    || null;
  const selectedArtifact = artifact
    || arrayValue(plan?.artifacts, []).find((item) => {
      if (item.componentId && item.componentId !== productId) return false;
      return !item.platform || item.platform === process.platform;
    })
    || arrayValue(plan?.artifacts, [])[0]
    || null;
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
    const mod = await import('@qpjoy/electron-launcher');
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
    const currentVersion = app.getVersion();
    const checks = [];
    const productId = launcherProductId();
    for (const target of [
      { componentId: productId, componentKind: 'mx-h2i-installer' },
      { componentId: `${productId}-renderer`, componentKind: 'renderer-ui' }
    ]) {
      try {
        checks.push(await updater.check({
          ...target,
          currentVersion,
          channel: runtime.config.releaseChannel,
          installId: identity.installId,
          userId,
          platform: process.platform
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
  if (result.status === 'up-to-date') return `当前已是最新版本 ${result.decision?.currentVersion || app.getVersion()}。`;
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

async function applyLauncherUpdate(reason) {
  const update = runtime.update || {};
  const artifact = releaseArtifactFromUpdate(update);
  if (!artifact.url) {
    runtime.feedback = {
      tone: 'warning',
      message: '当前没有可下载的 Release artifact，请先检查更新。'
    };
    return;
  }
  const installer = artifact.activation === 'installer-manual' || update.majorUpdateRequiresInstaller === true;
  if (installer) {
    const choice = await dialog.showMessageBox(mainWindow || undefined, {
      type: 'info',
      buttons: ['下载并打开', '取消'],
      defaultId: 0,
      cancelId: 1,
      title: 'MX-H2I 更新',
      message: `发现 MX-H2I ${update.latestVersion || artifact.version || ''} 更新`,
      detail: '将下载 Release Center 中登记的安装包，校验 sha256 后交给系统打开。当前连接不会被重启或断开。'
    });
    if (choice.response !== 0) {
      runtime.feedback = { tone: 'info', message: '已取消下载更新。' };
      return;
    }
  }
  const baseUrl = appCenterCatalogBaseUrl();
  const mod = await import('@qpjoy/electron-launcher');
  const updater = baseUrl && typeof mod.createElectronLauncherReleaseUpdater === 'function'
    ? mod.createElectronLauncherReleaseUpdater({
        baseUrl,
        fetchImpl: launcherFetchForBootstrap(runtime.config.bootstrapResolveMode),
        reportInstallId: runtime.installation?.installId
      })
    : null;
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
      fromVersion: update.currentVersion || app.getVersion(),
      releaseId: update.releaseId,
      planId: update.planId,
      componentKind: update.componentKind || artifact.kind,
      updateMode: update.updateMode,
      message: installer ? '开始下载大版本安装包。' : '开始下载热更新包。'
    }))
  }, runtime.config);
  runtime.feedback = {
    tone: 'info',
    message: installer ? '正在下载 MX-H2I 安装包。' : '正在下载热更新包。'
  };
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
        fromVersion: runtime.update?.currentVersion || app.getVersion(),
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
      const openError = await shell.openPath(result.targetPath);
      if (openError) throw new Error(openError);
      runtime.update = normalizeUpdate({
        ...runtime.update,
        status: 'installer-opened',
        restartPrompt: true,
        history: prependUpdateHistory(runtime.update?.history, updateHistoryEntry({
          kind: 'major-install',
          status: 'installer-opened',
          version: runtime.update?.latestVersion || artifact.version,
          fromVersion: runtime.update?.currentVersion || app.getVersion(),
          releaseId: runtime.update?.releaseId,
          planId: runtime.update?.planId,
          componentKind: runtime.update?.componentKind || artifact.kind,
          updateMode: runtime.update?.updateMode,
          message: '安装包已打开，等待用户完成系统安装。'
        }))
      }, runtime.config);
      runtime.feedback = {
        tone: 'success',
        message: '安装包已校验并打开。安装完成后可以立即重启 MX-H2I，也可以稍后手动重启。'
      };
      await updater?.report?.({
        installId: runtime.installation?.installId,
        status: 'installer-opened',
        metadata: releaseReportMetadata(reason, runtime.update, artifact, result)
      }).catch((error) => {
        pushAppLog('appcenter', 'warning', `Release installer-opened report failed: ${errorMessage(error)}`);
      });
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
        restartPrompt: runtime.update.restartRequired === true || pendingRestart,
        history: applied
          ? prependUpdateHistory(runtime.update?.history, updateHistoryEntry({
              kind: 'hot-apply',
              status: 'applied',
              version: runtime.update?.latestVersion || artifact.version,
              fromVersion: runtime.update?.currentVersion || app.getVersion(),
              releaseId: runtime.update?.releaseId,
              planId: runtime.update?.planId,
              componentKind: runtime.update?.componentKind || artifact.kind,
              updateMode: runtime.update?.updateMode,
              message: '热更新已自动激活。'
            }))
          : runtime.update?.history
      }, runtime.config);
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
        fromVersion: runtime.update?.currentVersion || app.getVersion(),
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

// Hot activation goes through the shared update executor: config/renderer
// artifacts swap into update-slots with a previous slot for rollback; npm/asar
// artifacts stage a next-start pointer. Activation defers automatically while
// WireGuard is connecting.
async function activateStagedHotArtifact(updater, artifact, stagedPath, update) {
  const executorMod = await import('@qpjoy/electron-launcher/release-update-executor');
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
  return executor.activateStaged(artifact, stagedPath, { releaseId: update?.releaseId ?? null });
}

function releaseArtifactFromUpdate(update) {
  const version = nullableString(update.latestVersion) || app.getVersion();
  const activation = nullableString(update.activation) || (update.majorUpdateRequiresInstaller ? 'installer-manual' : 'hot-auto');
  return {
    artifactId: nullableString(update.artifactId) || `${nullableString(update.releaseId) || 'release'}-${nullableString(update.artifactKind) || 'artifact'}-${version}`,
    kind: nullableString(update.artifactKind) || nullableString(update.componentKind) || 'mx-h2i-installer',
    componentId: nullableString(update.componentId) || launcherProductId(),
    version,
    source: 'internal-postgres',
    url: nullableString(update.artifactUrl),
    digest: nullableString(update.artifactDigest),
    signature: nullableString(update.artifactSignature),
    sizeBytes: Number.isFinite(update.artifactSizeBytes) ? update.artifactSizeBytes : null,
    platform: nullableString(update.artifactPlatform),
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
  const fileName = safeUpdateArtifactFileName(artifact.url, artifact.kind, artifact.version);
  return path.join(app.getPath('userData'), 'updates', releaseId, fileName);
}

function safeUpdateArtifactFileName(url, artifactKind, version) {
  try {
    const parsed = new URL(url);
    const baseName = safePathSegment(decodeURIComponent(path.basename(parsed.pathname)));
    if (baseName && baseName !== 'app') return baseName;
  } catch {
    // fallback below
  }
  return `${safePathSegment(artifactKind || 'artifact')}-${safePathSegment(version || app.getVersion())}.bin`;
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
    activation: artifact.activation,
    currentVersion: nullableString(update.currentVersion),
    latestVersion: nullableString(update.latestVersion),
    platform: process.platform,
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
  if (source === 'builtin') {
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
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      env: strippedInstallEnv()
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(String(stderr || stdout || err.message).split(/\r?\n/).slice(-8).join('\n')));
        return;
      }
      resolve();
    });
  });
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
    currentVersion: stringValue(row.currentVersion, app.getVersion()),
    latestVersion: stringValue(row.latestVersion, app.getVersion()),
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
    activation: nullableString(row.activation),
    restartRequired: row.restartRequired === true,
    majorUpdateRequiresInstaller: row.majorUpdateRequiresInstaller === true,
    hotUpdateAuto: row.hotUpdateAuto === true,
    stagedPath: nullableString(row.stagedPath),
    downloadedAt: nullableString(row.downloadedAt),
    downloadedBytes: Number.isFinite(row.downloadedBytes) ? row.downloadedBytes : null,
    downloadedDigest: nullableString(row.downloadedDigest),
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
        createdAt: nullableString(row.createdAt),
        gate: nullableString(row.gate)
      };
    })
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
    const mod = await import('@qpjoy/electron-launcher');
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

function foundationContract() {
  return {
    runtimeName: 'Launcher Foundation',
    socketNamespace: '~/.qpjoy/mx-launcher/sockets/{standaloneChannelProductId}.sock',
    sharedCapabilities: ['auth', 'permission', 'release', 'network', 'observability'],
    standaloneOwners: [
      {
        productId: 'mx-h2i',
        displayName: 'MX-H2I',
        state: 'active',
        serviceVip: '10.88.100.1'
      },
      {
        productId: 'luopan',
        displayName: 'Luopan',
        state: 'reserved',
        serviceVip: '10.88.110.1'
      }
    ]
  };
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

function isGuestConnectionActiveForEmployeeLogin(connection = runtime.connection) {
  return connection?.mode === 'guest'
    && ['connecting', 'connected', 'lease-only', 'tunnel-only', 'server-unavailable', 'network-unavailable', 'forbidden'].includes(connection.state);
}

function guestConnectionEmployeeLoginMessage(connection = runtime.connection) {
  const ip = connection?.localIp ? `（当前访客 IP：${connection.localIp}）` : '';
  return `当前已连接访客模式${ip}，请先断开访客模式后再进行员工登录。`;
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
      ? row.systemDomainProxy
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

function setConnecting(mode) {
  const previous = retainableConnectionSnapshot(runtime.connection);
  runtime.connection = {
    ...(previous || idleConnection()),
    state: 'connecting',
    mode
  };
  runtime.feedback = {
    tone: 'info',
    message: mode === 'employee' ? '正在刷新员工 lease。' : '正在申请游客 relay lease。'
  };
  touchRuntime(mode === 'employee' ? 'employee connecting' : 'guest connecting');
}

async function connectLauncherNetwork(input) {
  const context = await launcherContext();
  const requestTag = stringValue(input.requestTag, 'connect');
  const session = await context.launcher.connectNetwork({
    identityKind: input.identityKind,
    userId: input.userId || undefined,
    installId: context.installation.installId,
    deviceId: context.installation.deviceId,
    siteId: context.installation.siteId,
    keyPair: context.installation.keyPair,
    privateKey: context.installation.keyPair.privateKey,
    publicKey: context.installation.keyPair.publicKey,
    deviceLabel: context.installation.deviceLabel,
    platform: process.platform,
    requestedBy: REQUESTED_BY,
    requestId: makeRequestId(requestTag)
  });
  return {
    ...session,
    bootstrapResolution: context.bootstrap
  };
}

async function recoverRetainedWireGuardBeforeBootstrap(reason, options = {}) {
  if (!runtime || !shouldRecoverWireGuardConnection(runtime.connection)) return null;
  const connection = runtime.connection || {};
  if (!normalizeRoutePlan(connection.routePlan)) return null;
  const result = await recoverWireGuardForRuntime(reason, {
    allowPrivileged: options.allowPrivileged === true
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

async function launcherContext() {
  const bootstrap = await resolveBootstrapEndpoint(runtime.config);
  const baseUrl = bootstrap.baseUrl;
  await applyResolvedBootstrapEndpoint(bootstrap);
  const installation = await ensureInstallation();
  const productId = launcherProductId();
  const productDisplayName = launcherProductDisplayName();
  const mod = await import('@qpjoy/electron-launcher');
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
    const mod = await import('@qpjoy/electron-launcher');
    keyPair = mod.createLauncherWireGuardKeyPair();
  }
  const now = nowIso();
  const installation = {
    installId: current.installId || `inst_${productId}_${shortId()}`,
    deviceId: current.deviceId || `dev_${productId}_${shortId()}`,
    siteId: current.siteId,
    deviceLabel: current.deviceLabel || `${launcherProductDisplayName()} Desktop`,
    keyPair,
    createdAt: current.createdAt || now,
    updatedAt: now
  };
  runtime.installation = installation;
  return installation;
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
    anonymousCidr: '10.89.0.0/16',
    defaultDomesticSiteId: 'domestic-main',
    defaultOverseaSiteId: 'oversea-main',
    updatePolicy: 'launcher-managed',
    enabled: true,
    requestedBy: REQUESTED_BY,
    requestId: makeRequestId('product')
  });
}

async function applyNetworkSession(session, options) {
  wireGuardConnectInFlight = true;
  const lease = session.lease || {};
  const bootstrapResolution = normalizeBootstrapResolution(session.bootstrapResolution);
  const bootstrapResolveMode = bootstrapResolution?.resolveMode || runtime.config.bootstrapResolveMode;
  const bootstrapBaseUrl = bootstrapResolution?.baseUrl || runtime.config.bootstrapApiBaseUrl;
  const feedback = bootstrapResolution?.fallback?.message
    ? `${options.feedback} ${bootstrapResolution.fallback.message}`
    : options.feedback;
  try {
    const routePlan = normalizeRoutePlan(session.routePlan);
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
    runtime.identity = options.identity;
    runtime.auth = normalizeAuth(options.auth);
    runtime.feedback = {
      tone: 'info',
      message: `${feedback} 正在启动客户端 WireGuard。`
    };
    touchRuntime(options.mode === 'employee' ? 'employee lease ready' : 'guest lease ready');

    const domesticPeerSync = await syncDomesticPeerForLease(lease, { bootstrapResolveMode, bootstrapBaseUrl });
    const internalDirectPeerSync = await syncInternalDirectPeerForLease(lease, routePlan, { bootstrapResolveMode, bootstrapBaseUrl });
    const domesticRelayDiagnostics = await diagnoseDomesticRelayForLease(lease, { bootstrapResolveMode, bootstrapBaseUrl });
    const combinedSystemDomainProxy = await prepareSystemDomainProxyForWireGuardInstall('pre-connect');
    const wireGuardResult = await startWireGuardForSession({
      routePlan,
      privateKey,
      internalBaseUrl: overlayInternalBaseUrl,
      internalDirectPeerSync,
      domesticPeerSync,
      domesticRelayDiagnostics,
      darwinExtraInstallShell: combinedSystemDomainProxy?.shell || null,
      suppressWireGuardDns: shouldSuppressWireGuardDnsForSystemDomainProxy(combinedSystemDomainProxy)
    });
    if (wireGuardResult.authorizationCanceled === true) {
      applyWireGuardAuthorizationCanceled(options, wireGuardResult);
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
    if (wireGuardResult.ready) {
      wireGuardBackgroundProbeFailures = 0;
      lastWireGuardRecoveryFailureAt = 0;
    }
    const systemDomainProxy = wireGuardResult.ready
      ? (combinedSystemDomainProxy?.shell
          ? await completeExternalSystemDomainProxyApply('post-connect-combined')
          : await ensureSystemDomainProxyForRuntime('post-connect'))
      : deferredSystemDomainProxyRestoreStatus('wireguard-not-ready', combinedSystemDomainProxy);
    const networkEnvironment = await collectNetworkEnvironmentDiagnostics('post-connect', {
      phase: wireGuardResult.ready ? 'connected' : 'bootstrap'
    });
    const standaloneOwnership = wireGuardResult.ready
      ? await registerStandaloneOwnershipForRuntime('post-connect')
      : null;
    runtime.connection = {
      ...runtime.connection,
      diagnostics: {
        ...(runtime.connection.diagnostics || {}),
        ...(systemDomainProxy ? { systemDomainProxy } : {}),
        ...(standaloneOwnership ? { standaloneOwnership } : {}),
        networkEnvironment,
        updatedAt: nowIso()
      }
    };
    const resolverFeedback = arrayValue(systemDomainProxy?.resolverDomains, []).length > 0 && systemDomainProxy?.resolverApplied
      ? ' 系统 dynamic split DNS 已接管命令行和其它非 PAC 应用的域名解析。'
      : systemDomainProxy?.resolverError
        ? ` 系统 split DNS 未启用：${systemDomainProxy.resolverError}`
        : '';
    const pacFeedback = systemDomainProxy?.applied
      ? ` 系统 PAC 已将 Internal 域名接入本机 ${localEdgeProxy()}，其它流量回落到原系统代理。${resolverFeedback}`
      : systemDomainProxy?.error
        ? ` 系统 PAC 未启用：${systemDomainProxy.error}`
        : '';
    runtime.feedback = {
      tone: wireGuardResult.ready ? 'success' : 'warning',
      message: wireGuardResult.ready
        ? `${feedback} 客户端 WireGuard 已通过 ${wireGuardPathLabel(wireGuardResult.path)} 探测 Internal。${pacFeedback}`
        : `${feedback} 已保留租约，但客户端 WireGuard 还未 ready：${wireGuardResult.message}`
    };
    touchRuntime(wireGuardResult.ready
      ? (options.mode === 'employee' ? 'employee wireguard connected' : 'guest wireguard connected')
      : 'wireguard lease only');
    if (wireGuardResult.ready) {
      schedulePostConnectUpdateCheck(`${options.mode}-connected`);
    }
    if (!wireGuardResult.ready) {
      scheduleWireGuardRecovery('post-connect-probe', [1500, 4000, 9000]);
    }
  } finally {
    wireGuardConnectInFlight = false;
  }
}

function applyWireGuardAuthorizationCanceled(options, wireGuardResult) {
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
    const standaloneOwnershipRegistry = await summarizeStandaloneOwnershipRegistry(baseRoutePlan, 'connect');
    const routePlan = baseRoutePlan;
    const mod = await import('@qpjoy/electron-launcher/wireguard');
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
    const { result, route, endpointRoute, internalApi, ready } = attempt;
    const tunnelReady = result.ok === true;
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
        domesticPeerSync
      }),
      wireGuard: summarizeWireGuardResult(result),
      diagnostics: {
        route,
        endpointRoute,
        internalApi,
        internalDirectPeerSync,
        domesticPeerSync,
        domesticRelayDiagnostics,
        pathSelection,
        standaloneOwnershipRegistry,
        updatedAt: nowIso()
      },
      path: result.peer?.path || routePathFromPreference(attempt.pathPreference),
      message: ready ? 'ready' : wireGuardNotReadyMessage(result, route, internalApi, internalDirectPeerSync, domesticPeerSync, domesticRelayDiagnostics)
    };
  } catch (err) {
    if (isUserAuthorizationCanceledError(err)) {
      return wireGuardAuthorizationCanceledFailure(errorMessage(err));
    }
    return wireGuardFailure(errorMessage(err));
  }
}

async function summarizeStandaloneOwnershipRegistry(routePlan, reason = 'connect') {
  const baseRoutePlan = normalizeRoutePlan(routePlan);
  if (!baseRoutePlan) {
    return {
      ok: false,
      reason,
      error: 'missing-route-plan',
      routeCidrs: [],
      foreignRouteCidrs: [],
      updatedAt: nowIso()
    };
  }
  try {
    const mod = await import('@qpjoy/electron-launcher/standalone-data-plane');
    const state = mod.readElectronLauncherStandaloneOwnershipState();
    const conflicts = arrayValue(state?.registry?.conflicts, []);
    const registeredCidrs = uniqueStrings(arrayValue(state?.registry?.routeCidrs, [])
      .map((entry) => nullableString(entry?.value) || nullableString(entry?.key))
      .filter(isRegisteredStandaloneRouteCidr));
    const baseCidrs = arrayValue(baseRoutePlan.routeCidrs, []);
    const foreignRouteCidrs = registeredCidrs.filter((cidr) => !baseCidrs.includes(cidr));
    if (conflicts.length > 0) {
      return {
        ok: false,
        reason,
        error: 'ownership-conflict',
        statePath: nullableString(state?.statePath),
        owners: arrayValue(state?.registry?.owners, []).map((owner) => nullableString(owner?.ownerId)).filter(Boolean),
        conflicts,
        routeCidrs: registeredCidrs,
        foreignRouteCidrs,
        updatedAt: nowIso()
      };
    }
    return {
      ok: true,
      reason,
      statePath: nullableString(state?.statePath),
      owners: arrayValue(state?.registry?.owners, []).map((owner) => nullableString(owner?.ownerId)).filter(Boolean),
      routeCidrs: registeredCidrs,
      foreignRouteCidrs,
      updatedAt: nowIso()
    };
  } catch (err) {
    return {
      ok: false,
      reason,
      error: errorMessage(err),
      routeCidrs: [],
      foreignRouteCidrs: [],
      updatedAt: nowIso()
    };
  }
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
  return {
    pathPreference: input.pathPreference,
    result,
    route,
    endpointRoute,
    internalApi,
    ready: tunnelProofReady && routeReady && internalApiReady
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
    const mod = await import('@qpjoy/electron-launcher/wireguard');
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
    const ready = tunnelReady && routeReady && internalApiReady;
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
        domesticPeerSync
      }),
      wireGuard,
      diagnostics: {
        route,
        endpointRoute,
        internalApi,
        internalDirectPeerSync,
        domesticPeerSync,
        domesticRelayDiagnostics,
        updatedAt: nowIso()
      },
      message: ready ? 'ready' : wireGuardNotReadyMessage(resultLike, route, internalApi, internalDirectPeerSync, domesticPeerSync, domesticRelayDiagnostics)
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
      splitDns: input.route?.ok === true ? 'ready' : 'pending',
      appBroker: 'ready'
    };
  }
  const domesticPeerSync = input.domesticPeerSync;
  return {
    wireGuard: input.wireGuardReady ? 'ready' : 'blocked',
    domesticRelay: input.domesticRelayReady ? 'ready' : domesticPeerSync?.status === 'failed' || domesticPeerSync?.status === 'blocked' ? 'blocked' : 'pending',
    internalApi: internalApiHealthStatus(input.route, input.internalApi),
    splitDns: input.route?.ok === true ? 'ready' : 'pending',
    appBroker: 'ready'
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
    const payload = await requestJson(joinApiUrl(baseUrl, `/internal/v1/launcher-network/leases/${encodeURIComponent(leaseId)}/domestic-peer/sync`), {
      method: 'POST',
      body: {
        requestedBy: REQUESTED_BY,
        requestId: makeRequestId('domestic-peer-sync')
      },
      timeoutMs: 18000,
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
    const payload = await requestJson(joinApiUrl(baseUrl, `/internal/v1/launcher-network/leases/${encodeURIComponent(leaseId)}/internal-direct-peer/sync`), {
      method: 'POST',
      body: {
        requestedBy: REQUESTED_BY,
        requestId: makeRequestId('internal-direct-peer-sync')
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

async function refreshWireGuardDiagnostics() {
  const connection = runtime.connection || {};
  const routePlan = normalizeRoutePlan(connection.routePlan);
  if (!routePlan || !connection.leaseId) {
    runtime.feedback = { tone: 'warning', message: '当前没有可诊断的 launcher lease。' };
    return;
  }
  const domesticPeerSync = await syncDomesticPeerForLease({ leaseId: connection.leaseId });
  const internalDirectPeerSync = await syncInternalDirectPeerForLease({ leaseId: connection.leaseId }, routePlan);
  const domesticRelayDiagnostics = await diagnoseDomesticRelayForLease({ leaseId: connection.leaseId });
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
  runtime.feedback = {
    tone: wireGuardResult.ready ? 'success' : 'warning',
    message: wireGuardResult.ready ? 'WireGuard 诊断通过，Domestic 和 Internal overlay 可达。' : `WireGuard 仍未 ready：${wireGuardResult.message}`
  };
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
  if (wireGuardConnectInFlight || runtime.connection?.state === 'connecting') {
    return { ok: true, skipped: true, reason: 'connect-in-flight' };
  }
  if (wireGuardRecoveryInFlight) return wireGuardRecoveryInFlight;
  const manual = String(reason || '').startsWith('manual');
  const allowPrivileged = options.allowPrivileged !== false;
  if (!manual && lastWireGuardRecoveryFailureAt && Date.now() - lastWireGuardRecoveryFailureAt < 5 * 60 * 1000) {
    return { ok: true, skipped: true, reason: 'failure-cooldown' };
  }
  wireGuardRecoveryInFlight = (async () => {
    const connection = runtime.connection || {};
    const routePlan = normalizeRoutePlan(connection.routePlan);
    if (!routePlan) return { ok: true, skipped: true, reason: 'missing-route-plan' };
    try {
      const mod = await import('@qpjoy/electron-launcher/wireguard');
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
        const preserveConnected = !manual
          && connection.state === 'connected'
          && !wireGuardResult.ready
          && !routeProofLost
          && wireGuardBackgroundProbeFailures < WIREGUARD_BACKGROUND_PROBE_DOWNGRADE_THRESHOLD;
        const shouldPersistProbe = !preserveConnected
          && (wireGuardResult.state !== connection.state || reason !== 'interval');
        if (shouldPersistProbe) {
          runtime.connection = {
            ...connection,
            state: wireGuardResult.state,
            health: wireGuardResult.health,
            wireGuard: wireGuardResult.wireGuard,
            diagnostics: {
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
            runtime.feedback = {
              tone: 'success',
              message: `MX-H2I 已检测到 WireGuard ready（${reason}）。`
            };
          } else if (!wireGuardResult.ready && reason !== 'interval') {
            runtime.feedback = {
              tone: 'warning',
              message: `MX-H2I 检测到 WireGuard 未 ready：${wireGuardResult.message}。请点击重新连接进行授权修复，或刷新诊断查看当前路由。`
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
  const state = connection?.state;
  return (state === 'connected' || state === 'tunnel-only' || state === 'lease-only' || state === 'server-unavailable' || state === 'network-unavailable')
    && Boolean(normalizeRoutePlan(connection.routePlan));
}

async function stopWireGuardForRuntime(options = {}) {
  try {
    const mod = await import('@qpjoy/electron-launcher/wireguard');
    return await mod.stopLauncherWireGuardPeer(wireGuardRuntimeOptions(options));
  } catch (err) {
    return {
      ok: false,
      message: errorMessage(err)
    };
  }
}

function wireGuardRuntimeOptions(options = {}) {
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
    darwinServiceIdentity
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
      scope: 'auth.read appcenter.read network.hdi.status network.proxy.app network.dns.policy',
      requestId: makeRequestId('oauth')
    }
  });
  const token = tokenPayload?.token || tokenPayload;
  const principal = token?.principal && typeof token.principal === 'object' ? token.principal : {};
  const userId = nullableString(principal.userId) || parseUserIdFromSubject(token?.subject);
  if (!userId) throw new Error('OAuth token 没有返回 user principal。');
  return {
    accessToken: token.access_token,
    tokenType: token.token_type,
    issuedTokenType: token.issued_token_type,
    issuer: token.issuer,
    audience: token.audience,
    subject: token.subject,
    expiresAt: token.expires_at,
    scopes: typeof token.scope === 'string' ? token.scope.split(/\s+/).filter(Boolean) : [],
    user: {
      userId,
      displayName: nullableString(principal.displayName) || displayNameFromAccount(account),
      email: account.includes('@') ? account : null
    }
  };
}

async function resolveBootstrapBaseUrl(config) {
  return (await resolveBootstrapEndpoint(config)).baseUrl;
}

async function resolveBootstrapEndpoint(config) {
  const requestedMode = normalizeBootstrapResolveMode(config?.bootstrapResolveMode || DEFAULT_CONFIG.bootstrapResolveMode);
  const seeds = [
    retainedOverlayBootstrapBaseUrl(config),
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
    for (const resolveMode of bootstrapResolveAttempts(candidate, config)) {
      try {
        await probeBootstrapApiBaseUrl(candidate, { bootstrapResolveMode: resolveMode });
        return {
          baseUrl: candidate,
          resolveMode,
          fallback: bootstrapResolveFallback(requestedMode, resolveMode, failures),
          preserveConfigBaseUrl: shouldPreserveConfiguredBootstrapBaseUrl(candidate, config)
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
  if (connection.state === 'connected' || connection.state === 'tunnel-only') return true;
  if (connection.health?.wireGuard === 'ready') return true;
  if (connection.wireGuard?.active === true) return true;
  return false;
}

function shouldAllowPrivilegedPreBootstrapRecovery() {
  const override = nullableString(process.env.MX_H2I_PREBOOTSTRAP_PRIVILEGED_RECOVERY);
  if (override) return !['0', 'false', 'no', 'off'].includes(override.toLowerCase());
  return process.platform === 'win32';
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

function shouldPreserveConfiguredBootstrapBaseUrl(candidate, config) {
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
    '18090',
    '8088',
    protocol === 'https' ? '443' : '80'
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
  let protocol = 'http';
  let port = nullableString(process.env.MX_H2I_BOOTSTRAP_PORT) || '18090';
  try {
    const parsed = new URL(reference);
    protocol = parsed.protocol.replace(/:$/, '') || protocol;
    port = parsed.port || port;
  } catch {
    // Keep the default public bootstrap shape.
  }
  const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${protocol}://${formattedHost}${port ? `:${port}` : ''}`;
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
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          text,
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
        finish(resolve, {
          text: Buffer.concat(chunks).toString('utf8'),
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
    return {
      text: await response.text(),
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

function visibleRuntime(source = runtime) {
  return {
    ...source,
    installation: visibleInstallation(source.installation),
    auth: visibleAuth(source.auth)
  };
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
    scopes: auth.scopes
  };
}

async function saveAndBroadcast() {
  await saveRuntime(runtime);
  broadcastState();
}

async function saveRuntime(next) {
  const persistable = persistableRuntime(next);
  await fs.mkdir(path.dirname(runtimePath()), { recursive: true });
  await fs.writeFile(runtimePath(), JSON.stringify(persistable, null, 2) + '\n', 'utf8');
  await savePersistedH2oRuntime(persistable.apps?.h2o?.runtime);
  await maybeSnapshotAppsState(persistable.apps);
}

function persistableRuntime(input) {
  const next = input && typeof input === 'object' ? { ...input } : {};
  if (next.connection?.state === 'connecting') {
    next.connection = {
      ...idleConnection(),
      mode: next.connection.mode === 'employee' ? 'employee' : 'guest',
      diagnostics: normalizeDiagnostics(next.connection.diagnostics)
    };
  }
  return next;
}

async function loadPersistedH2oRuntime() {
  try {
    const raw = await fs.readFile(h2oRuntimeStorePath(), 'utf8');
    return h2oPluginRuntime(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function savePersistedH2oRuntime(input) {
  if (!input) return;
  const current = h2oPluginRuntime(input);
  const store = {
    kind: 'h2o-plugin',
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
  await fs.mkdir(path.dirname(h2oRuntimeStorePath()), { recursive: true });
  await fs.writeFile(h2oRuntimeStorePath(), JSON.stringify(store, null, 2) + '\n', 'utf8');
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
    await fs.mkdir(dir, { recursive: true });
    const createdAt = nowIso();
    const fileName = `apps-${createdAt.replace(/[:.]/g, '-')}.json`;
    await fs.writeFile(path.join(dir, fileName), JSON.stringify({ kind: 'mx-h2i-apps-backup', createdAt, apps }, null, 2) + '\n', 'utf8');
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

function mergePersistedH2oRuntime(source, persistedRuntime) {
  const next = source && typeof source === 'object' ? { ...source } : source;
  const appRecord = next?.apps?.h2o;
  if (!appRecord?.runtime) return next;
  const current = h2oPluginRuntime(appRecord.runtime);
  const persisted = persistedRuntime ? h2oPluginRuntime(persistedRuntime) : null;
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
  if (explicit) return explicit;
  const host = nullableString(process.env.MX_H2I_BOOTSTRAP_HOST)
    || nullableString(process.env.MX_H2I_BOOTSTRAP_DOMAIN)
    || DEFAULT_BOOTSTRAP_HOST;
  const protocol = stringValue(process.env.MX_H2I_BOOTSTRAP_PROTOCOL, 'http').replace(/:$/, '');
  const port = nullableString(process.env.MX_H2I_BOOTSTRAP_PORT) || '18090';
  return `${protocol}://${host}${port ? `:${port}` : ''}`;
}

function defaultHostResolve() {
  const explicit = explicitDefaultHostResolve();
  if (explicit) return explicit;
  const host = nullableString(process.env.MX_H2I_BOOTSTRAP_HOST)
    || nullableString(process.env.MX_H2I_BOOTSTRAP_DOMAIN)
    || hostnameFromUrl(process.env.MX_H2I_BOOTSTRAP_BASE_URL)
    || hostnameFromUrl(process.env.MX_H2I_PUBLIC_BASE_URL)
    || DEFAULT_BOOTSTRAP_HOST;
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

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(message);
      err.code = 'MX_BOOTSTRAP_DNS_TIMEOUT';
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
  return {
    originalUrl: original.toString(),
    url: parsed.toString(),
    hostHeader: parsed.host,
    originalHostHeader,
    resolveMode,
    source: 'direct-public-bootstrap',
    servername: undefined
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
    process.env.MX_H2I_BOOTSTRAP_HOST,
    process.env.MX_H2I_BOOTSTRAP_DOMAIN,
    hostnameFromUrl(process.env.MX_H2I_BOOTSTRAP_BASE_URL),
    hostnameFromUrl(process.env.MX_H2I_PUBLIC_BASE_URL),
    hostnameFromUrl(runtime?.config?.bootstrapApiBaseUrl),
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
  if (isPublicIcpBlockedError(err)) {
    const host = publicHostFromUrl(runtime?.config?.bootstrapApiBaseUrl) || DEFAULT_BOOTSTRAP_HOST;
    return {
      state: 'network-unavailable',
      message: `公网域名被备案/公网入口拦截，不是 Internal 权限拒绝。请保留 Bootstrap API 域名，并使用 Host Resolve ${host}=<正式 Domestic gateway IP>；客户端会连接该 IP，HTTP Host 使用 gateway IP，原始域名放在 X-Forwarded-Host/X-MX-Original-Host/X-MX-Bootstrap-Host。原始错误：${message}`
    };
  }
  if (status === 403 || lower.includes('403 forbidden') || lower.includes('forbidden')) {
    return {
      state: 'forbidden',
      message: `Internal 已响应但拒绝请求（403）。请检查 launcher-network 产品、租约或当前 principal 权限；原始错误：${message}`
    };
  }
  if (lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('enetunreach') || lower.includes('ehostunreach') || lower.includes('etimedout') || lower.includes('fetch failed') || lower.includes('timeout') || lower.includes('请求超时')) {
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
