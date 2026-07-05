const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const dnsPromises = require('node:dns').promises;
const net = require('node:net');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, screen: electronScreen, powerMonitor, net: electronNet, dialog } = require('electron');

loadDotEnvFiles();

const APP_ID = 'dev.qpjoy.mx-h2i';
const STATE_FILE = 'mx-h2i-runtime.json';
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
const DEFAULT_SPLIT_DNS_DOMAINS = 'mx.cn mxinfo-inc.cn internal.mx corp.mx h2i.mx';
const DARWIN_WIREGUARD_SERVICE_IDENTITY = {
  displayName: 'MX-H2I WireGuard',
  darwinLaunchDaemonLabelPrefix: 'com.qpjoy.mx-h2i.wireguard',
  darwinSupportRoot: '/Library/Application Support/QPJoy/MX-H2I',
  darwinLogDir: '/Library/Logs/QPJoy-MX-H2I',
  darwinDaemonScriptName: 'mx-h2i-wireguard-daemon.sh',
  staleDarwinLaunchDaemonLabelPrefixes: ['com.qpjoy.mx-h2i.wireguard']
};
const SYSTEM_DOMAIN_PROXY_REFRESH_MS = 30_000;
const SYSTEM_DOMAIN_PROXY_ROUTE_REFRESH_TIMEOUT_MS = 2200;
const SYSTEM_DOMAIN_PROXY_ROUTE_WARNING_MS = 60_000;
const NETWORK_CHANGE_MONITOR_MS = 5000;
const NETWORK_CHANGE_DEBOUNCE_MS = 1800;
const DARWIN_ENDPOINT_ROUTE_PROBE_TIMEOUT_MS = 1800;
const DARWIN_ENDPOINT_ROUTE_DELETE_TIMEOUT_MS = 2500;
const DARWIN_ENDPOINT_ROUTE_REPAIR_COOLDOWN_MS = 20_000;
const WIREGUARD_BACKGROUND_PROBE_DOWNGRADE_THRESHOLD = 3;
const DEFAULT_CONFIG = {
  productId: defaultLauncherProductId(),
  productDisplayName: defaultLauncherProductDisplayName(),
  bootstrapApiBaseUrl: defaultBootstrapApiBaseUrl(),
  internalApiBaseUrl: 'http://10.88.88.88:18090',
  domesticRelayHost: '121.43.253.179',
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
let lastSystemDomainProxySignature = null;
let lastSystemDomainProxyPolicySignature = null;
let lastSystemDomainProxyAuthorizationCanceledSignature = null;
let lastSystemPacReverseProxyRoutes = [];
let lastSystemPacReverseProxyRoutesWarningAt = 0;
let lastNetworkEnvironmentSignature = null;
let lastDarwinEndpointRouteRepairAt = 0;

const TOP_DOCK_Y = 0;
const TOP_REVEAL_ZONE = 18;
const TOP_ANIMATION_STEPS = 24;
const TOP_REVEAL_HOLD_MS = 900;
const TOP_LEAVE_HIDE_MS = 180;

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
  startTopRevealWatcher();
  startWireGuardRecoveryWatcher();
  startNetworkChangeWatcher();
});

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
  mainWindow = new BrowserWindow({
    width: 462,
    height: 760,
    minWidth: 410,
    minHeight: 680,
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
  mainWindow.center();
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
    await recoverRetainedWireGuardBeforeBootstrap('guest-pre-bootstrap', { allowPrivileged: false });
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
    await recoverRetainedWireGuardBeforeBootstrap('employee-pre-bootstrap', { allowPrivileged: false });
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
    } catch (err) {
      await applyConnectionError('员工登录失败', err);
    }
    await saveAndBroadcast();
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:disconnect', async () => {
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
    runtime.apps.h2o.enabled = true;
    runtime.apps.h2o.status = 'running';
    runtime.apps.h2o.runtimeState = 'running';
    runtime.apps.h2o.runtime = h2oPluginRuntime({
      ...runtime.apps.h2o.runtime,
      running: true,
      status: 'running',
      startedAt: runtime.apps.h2o.runtime?.startedAt || nowIso(),
      lastAppliedAt: nowIso()
    });
    runtime.apps.h2o.lastAction = nowIso();
    const installReport = await reportAppCenterInstallation(runtime.apps.h2o, 'launch-h2o');
    runtime.feedback = {
      tone: installReport.ok === false ? 'warning' : 'success',
      message: installReport.ok === false
        ? `H2O 运行态已就绪；安装状态同步失败：${installReport.message}`
        : 'H2O 运行态已就绪。开发态请从 mx-app-h2o 启动窗口，生产态由 AppCenter package runtime 打开入口。'
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
    runtime.apps.h2o.lastAction = nowIso();
    pushAppLog('h2o', 'info', 'H2O runtime stopped from AppCenter.');
    const installReport = await reportAppCenterInstallation(runtime.apps.h2o, 'stop-h2o');
    runtime.feedback = {
      tone: installReport.ok === false ? 'warning' : 'info',
      message: installReport.ok === false
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
    runtime.apps.h2o.runtime = h2oPluginRuntime({
      ...runtime.apps.h2o.runtime,
      mode: nextMode,
      status: runtime.apps.h2o.runtimeState === 'running' ? 'running' : 'ready',
      lastAppliedAt: nowIso()
    });
    runtime.apps.h2o.lastAction = nowIso();
    pushAppLog('h2o', 'info', `H2O mode switched to ${nextMode}.`);
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
  ipcMain.handle('mx-h2i:check-updates', async () => {
    const catalogSync = await syncAppCenterCatalog('check-updates');
    const releaseSync = await checkReleaseCenterUpdate('manual-check');
    const releaseResult = releaseSync.result;
    const releasePlan = releaseResult?.plan || null;
    const releaseDecision = releaseResult?.decision || null;
    const releaseArtifact = releaseResult?.artifacts?.[0] || null;
    runtime.update = {
      status: releaseSync.ok ? releaseResult.status : 'failed',
      currentVersion: app.getVersion(),
      latestVersion: releaseDecision?.targetVersion || app.getVersion(),
      policy: releaseDecision?.updateMode || 'launcher-managed',
      channel: runtime.config.releaseChannel,
      rolloutGroup: releasePlan?.rollout?.segmentId || runtime.config.rolloutGroup,
      canSkip: releaseDecision?.canSkip === true,
      lastCheckedAt: releaseResult?.checkedAt || nowIso(),
      planId: releasePlan?.planId || null,
      releaseId: releasePlan?.releaseId || null,
      componentId: releaseDecision?.componentId || launcherProductId(),
      componentKind: releaseDecision?.componentKind || null,
      updateMode: releaseDecision?.updateMode || null,
      reason: releaseSync.ok ? releaseResult.reason : releaseSync.message,
      artifactKind: releaseArtifact?.kind || null,
      artifactId: releaseArtifact?.artifactId || null,
      artifactUrl: releaseArtifact?.url || null,
      artifactDigest: releaseArtifact?.digest || null,
      artifactSignature: releaseArtifact?.signature || null,
      artifactSizeBytes: Number.isFinite(releaseArtifact?.sizeBytes) ? releaseArtifact.sizeBytes : null,
      activation: releaseArtifact?.activation || null,
      restartRequired: releaseArtifact?.restartRequired === true,
      majorUpdateRequiresInstaller: releasePlan?.activation?.majorUpdateRequiresInstaller === true,
      hotUpdateAuto: releasePlan?.activation?.hotUpdateAuto === true
    };
    const failures = [
      catalogSync.ok === false ? `AppCenter 目录同步失败：${catalogSync.message}` : null,
      releaseSync.ok === false ? `Release Center 检查失败：${releaseSync.message}` : null
    ].filter(Boolean);
    const releaseMessage = releaseSync.ok
      ? releaseUpdateMessage(releaseResult)
      : 'Release Center 更新策略读取失败。';
    runtime.feedback = {
      tone: failures.length ? 'warning' : (releaseResult?.status === 'update-available' ? 'success' : 'info'),
      message: failures.length
        ? `${releaseMessage} ${failures.join('；')}`
        : `${releaseMessage} AppCenter 目录已同步 ${catalogSync.count} 个应用。`
    };
    touchRuntime('update checked');
    await saveAndBroadcast();
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:apply-update', async () => {
    await applyLauncherUpdate('manual-apply');
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
  currentWindowMode = mode;
  isTopHidden = false;
  isTopDocked = false;
  topDockHidePending = false;
  topDockHoldUntil = 0;
  topDockLeaveStartedAt = 0;
  if (mode === 'appcenter') {
    mainWindow.setResizable(true);
    mainWindow.setMinimumSize(980, 680);
    mainWindow.setSize(1240, 760, true);
  } else {
    mainWindow.setResizable(false);
    mainWindow.setMinimumSize(410, 680);
    mainWindow.setSize(462, 760, true);
  }
  mainWindow.center();
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
  const bounds = lastVisibleBounds || mainWindow.getBounds();
  const display = electronScreen.getDisplayMatching(bounds);
  const y = Math.max(bounds.y, display.workArea.y + dockActivationDistance(bounds, display) + 18);
  mainWindow.show();
  mainWindow.setBounds({ ...bounds, y }, false);
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
      void recoverWireGuardForRuntime(reason, { allowPrivileged }).catch(() => undefined);
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
  const status = currentSystemDomainProxyStatus('network-change', {
    skipped: true,
    skipReason: 'network-change-no-privileged-apply',
    verified: false
  });
  await recordSystemDomainProxyDiagnostics(status, `system domain proxy network change: ${reason}`);
  return status;
}

async function captureNetworkSignature() {
  if (process.platform !== 'darwin') return null;
  const [route, services, networkInfo] = await Promise.all([
    execFileText('/sbin/route', ['-n', 'get', 'default']).catch((err) => `route-error:${errorMessage(err)}`),
    execFileText('/usr/sbin/networksetup', ['-listallnetworkservices']).catch((err) => `services-error:${errorMessage(err)}`),
    execFileText('/usr/sbin/scutil', ['--nwi']).catch((err) => `nwi-error:${errorMessage(err)}`)
  ]);
  return JSON.stringify({
    route: compactDarwinDefaultRoute(route),
    services: compactDarwinNetworkServices(services),
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
    const skipped = maybeSkipSystemDomainProxyApply(reason, policySignature);
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
  const status = typeof systemDomainProxyManager?.status === 'function'
    ? systemDomainProxyManager.status()
    : null;
  const endpointRoute = await collectDarwinEndpointRouteDiagnostics(reason, { phase });
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
  return {
    reason,
    phase,
    host: host || null,
    resolution,
    endpointRoute,
    systemDomainProxy: compactSystemDomainProxyStatus(status),
    priority: phase === 'connected'
      ? ['v2-split-dns', 'mx-h2i-wireguard', 'system-proxy-or-dns-for-unmatched', 'external-dns-for-unmatched']
      : ['bootstrap-dns-or-host-resolve', 'system-proxy-or-dns', 'external-dns'],
    updatedAt: nowIso()
  };
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

function maybeSkipSystemDomainProxyApply(reason, policySignature) {
  if (!isBackgroundSystemDomainProxyReason(reason) || !policySignature || policySignature !== lastSystemDomainProxyPolicySignature) {
    return null;
  }
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
  const resolverMode = nullableString(status.systemResolverMode);
  const resolverDomains = arrayValue(status.resolverDomains, []);
  if (status.applied && (resolverMode !== 'dynamic' || resolverDomains.length === 0 || status.resolverApplied === true)) {
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

function shouldApplySystemDomainProxyForReason(reason) {
  const text = String(reason || '');
  return text === 'post-connect' || text.startsWith('manual');
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
  const text = status instanceof Error
    ? `${status.message || ''}\n${status.stack || ''}`
    : `${status?.error || ''}\n${status?.resolverError || ''}`;
  return /authorization canceled|administrator authorization canceled|user canceled|用户已取消|\(-128\)/i.test(text);
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
  try {
    const raw = await fs.readFile(runtimePath(), 'utf8');
    return await normalizeRuntime(JSON.parse(raw));
  } catch {
    return await normalizeRuntime({});
  }
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
    feedback: null,
    activity: Array.isArray(row.activity) ? row.activity.slice(0, 8) : defaultActivity(),
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : nowIso()
  };
}

function normalizeConfig(input) {
  const row = input && typeof input === 'object' ? input : {};
  const domesticRelayPort = Number(row.domesticRelayPort);
  const bootstrapApiBaseUrl = stringValue(row.bootstrapApiBaseUrl, DEFAULT_CONFIG.bootstrapApiBaseUrl);
  const productId = normalizeLauncherProductId(row.productId || DEFAULT_CONFIG.productId);
  const productDisplayName = nullableString(row.productDisplayName)
    || (productId === DEFAULT_CONFIG.productId ? DEFAULT_CONFIG.productDisplayName : null)
    || displayNameForLauncherProductId(productId);
  return {
    productId,
    productDisplayName,
    bootstrapApiBaseUrl,
    internalApiBaseUrl: stringValue(row.internalApiBaseUrl, DEFAULT_CONFIG.internalApiBaseUrl),
    domesticRelayHost: stringValue(row.domesticRelayHost, DEFAULT_CONFIG.domesticRelayHost),
    domesticRelayPort: Number.isInteger(domesticRelayPort) && domesticRelayPort > 0 ? domesticRelayPort : DEFAULT_CONFIG.domesticRelayPort,
    sdkGatewayBaseUrl: stringValue(row.sdkGatewayBaseUrl, DEFAULT_CONFIG.sdkGatewayBaseUrl || sdkGatewayBaseUrl(bootstrapApiBaseUrl)),
    hostResolve: stringValue(row.hostResolve, DEFAULT_CONFIG.hostResolve),
    bootstrapResolveMode: normalizeBootstrapResolveMode(row.bootstrapResolveMode || DEFAULT_CONFIG.bootstrapResolveMode),
    bootstrapDnsServers: stringValue(row.bootstrapDnsServers, DEFAULT_CONFIG.bootstrapDnsServers),
    splitDnsDomains: stringValue(row.splitDnsDomains, DEFAULT_CONFIG.splitDnsDomains),
    routePathPreference: normalizeRoutePathPreference(row.routePathPreference || DEFAULT_CONFIG.routePathPreference),
    releaseChannel: stringValue(row.releaseChannel, DEFAULT_CONFIG.releaseChannel),
    rolloutGroup: stringValue(row.rolloutGroup, DEFAULT_CONFIG.rolloutGroup),
    useLocalEngineResources: row.useLocalEngineResources !== false,
    restartAfterCodeUpdate: row.restartAfterCodeUpdate !== false
  };
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
      permissions: ['network.hdi.status', 'network.proxy.app', 'network.dns.policy', 'network.pac.policy'],
      requiredCapabilities: ['user.session', 'network.status', 'network.proxy', 'network.dns.policy', 'network.pac.policy', 'app-center-runtime'],
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
        requiredCapabilities: ['user.session', 'network.status', 'network.proxy', 'network.dns.policy', 'network.pac.policy', 'app-center-runtime'],
        network: { scope: 'broker-session' },
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
  return {
    kind: 'h2o-plugin',
    mode: normalizeH2oMode(row.mode),
    running: row.running === true,
    status: nullableString(row.status) || (row.running === true ? 'running' : 'stopped'),
    tunInstalled: row.tunInstalled === true,
    adminUrl: nullableString(row.adminUrl) || 'http://127.0.0.1:23456',
    ports: {
      admin: normalizePort(ports.admin, 23456),
      controller: normalizePort(ports.controller, 23457),
      mixed: normalizePort(ports.mixed, 23458),
      dns: normalizePort(ports.dns, 1053)
    },
    activeSubscription: {
      id: nullableString(subscription.id) || 'h2o-default',
      name: nullableString(subscription.name) || 'Home To Oversea 默认策略',
      nodes: normalizeNonNegativeInteger(subscription.nodes, 6),
      latencyMs: normalizeNonNegativeInteger(subscription.latencyMs, 42)
    },
    startedAt: nullableString(row.startedAt),
    lastAppliedAt: nullableString(row.lastAppliedAt)
  };
}

function normalizeH2oMode(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'rule') return 'app-rule';
  if (text === 'global') return 'app-global';
  if (text === 'tun') return 'system-tun';
  return ['app-rule', 'app-global', 'system-tun', 'direct'].includes(text) ? text : 'app-rule';
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
  if (result.status === 'up-to-date') return '当前已是最新版本。';
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
  runtime.update = normalizeUpdate({
    ...update,
    status: 'downloading'
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
    const result = await mod.downloadElectronLauncherReleaseArtifactToFile({
      artifact,
      targetPath
    });
    runtime.update = normalizeUpdate({
      ...runtime.update,
      status: installer ? 'ready-to-install' : 'staged',
      stagedPath: result.targetPath,
      downloadedAt: nowIso(),
      downloadedBytes: result.bytes,
      downloadedDigest: result.digest
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
      runtime.feedback = {
        tone: 'success',
        message: '安装包已校验并打开。请按系统安装器完成更新。'
      };
      await updater?.report?.({
        installId: runtime.installation?.installId,
        status: 'installer-opened',
        metadata: releaseReportMetadata(reason, runtime.update, artifact, result)
      }).catch((error) => {
        pushAppLog('appcenter', 'warning', `Release installer-opened report failed: ${errorMessage(error)}`);
      });
    } else {
      runtime.feedback = {
        tone: 'success',
        message: '更新包已下载并校验，等待后续热更新激活器处理。'
      };
    }
    touchRuntime('update downloaded');
  } catch (error) {
    const message = errorMessage(error);
    runtime.update = normalizeUpdate({
      ...runtime.update,
      status: 'download-failed',
      reason: message
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
    activation,
    autoApply: update.hotUpdateAuto === true,
    restartRequired: update.restartRequired === true,
    requiredAppRestart: update.restartRequired === true || activation === 'installer-manual',
    notes: []
  };
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
    activation: nullableString(row.activation),
    restartRequired: row.restartRequired === true,
    majorUpdateRequiresInstaller: row.majorUpdateRequiresInstaller === true,
    hotUpdateAuto: row.hotUpdateAuto === true,
    stagedPath: nullableString(row.stagedPath),
    downloadedAt: nullableString(row.downloadedAt),
    downloadedBytes: Number.isFinite(row.downloadedBytes) ? row.downloadedBytes : null,
    downloadedDigest: nullableString(row.downloadedDigest)
  };
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

    const domesticPeerSync = await syncDomesticPeerForLease(lease, { bootstrapResolveMode });
    const internalDirectPeerSync = await syncInternalDirectPeerForLease(lease, routePlan, { bootstrapResolveMode });
    const domesticRelayDiagnostics = await diagnoseDomesticRelayForLease(lease, { bootstrapResolveMode });
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
    if (!wireGuardResult.ready) {
      scheduleWireGuardRecovery('post-connect-probe', [1500, 4000, 9000]);
    }
  } finally {
    wireGuardConnectInFlight = false;
  }
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
    const payload = await requestJson(joinApiUrl(runtime.config.bootstrapApiBaseUrl, `/internal/v1/launcher-network/leases/${encodeURIComponent(leaseId)}/domestic-peer/sync`), {
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
    const payload = await requestJson(joinApiUrl(runtime.config.bootstrapApiBaseUrl, `/internal/v1/launcher-network/leases/${encodeURIComponent(leaseId)}/internal-direct-peer/sync`), {
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
    const payload = await requestJson(joinApiUrl(runtime.config.bootstrapApiBaseUrl, `/internal/v1/launcher-network/leases/${encodeURIComponent(leaseId)}/domestic-relay/diagnostics`), {
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
      return `到 ${route.targetIp || INTERNAL_PEER_IP} 当前走 ${route.interfaceName}，期望 ${route.expectedInterfaceName}；可能被系统代理或其它 utun 规则抢先。`;
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
          fallback: bootstrapResolveFallback(requestedMode, resolveMode, failures)
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
  const apiFailures = failures.filter((failure) => {
    try {
      return new URL(failure.candidate).hostname === 'api.mxinfo-inc.cn';
    } catch {
      return false;
    }
  });
  if (!apiFailures.length) return '';
  const hasOverride = apiFailures.some((failure) => failure.override);
  if (hasOverride) return '';
  return '；Host Resolve 未命中 api.mxinfo-inc.cn，请在 .env 或高级选项设置 MX_H2I_HOST_RESOLVE=api.mxinfo-inc.cn=<Domestic公网IP>';
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
  await applyResolvedBootstrapBaseUrl(resolution.baseUrl);
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
    } : null
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
      ...(override.originalHostHeader ? {
        'x-forwarded-host': override.originalHostHeader,
        'x-mx-bootstrap-host': override.originalHostHeader,
        'x-mx-bootstrap-domain': hostnameFromUrl(override.originalUrl || '')
      } : {})
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
  await fs.mkdir(path.dirname(runtimePath()), { recursive: true });
  await fs.writeFile(runtimePath(), JSON.stringify(persistableRuntime(next), null, 2) + '\n', 'utf8');
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
    || nullableString(process.env.MX_H2I_BOOTSTRAP_DOMAIN);
  if (!host) return '';
  const protocol = stringValue(process.env.MX_H2I_BOOTSTRAP_PROTOCOL, 'http').replace(/:$/, '');
  const port = nullableString(process.env.MX_H2I_BOOTSTRAP_PORT) || '18090';
  return `${protocol}://${host}${port ? `:${port}` : ''}`;
}

function defaultHostResolve() {
  const explicit = nullableString(process.env.MX_H2I_HOST_RESOLVE)
    || nullableString(process.env.MX_H2I_BOOTSTRAP_HOST_RESOLVE);
  if (explicit) return explicit;
  const host = nullableString(process.env.MX_H2I_BOOTSTRAP_HOST)
    || nullableString(process.env.MX_H2I_BOOTSTRAP_DOMAIN);
  const ip = nullableString(process.env.MX_H2I_BOOTSTRAP_RESOLVE_IP)
    || nullableString(process.env.MX_H2I_BOOTSTRAP_IP);
  return host && ip ? `${host}=${ip}` : '';
}

function defaultBootstrapResolveMode() {
  return normalizeBootstrapResolveMode(
    process.env.MX_H2I_BOOTSTRAP_RESOLVE_MODE
      || process.env.MX_H2I_BOOTSTRAP_DNS_MODE
      || (defaultHostResolve() ? 'env-first' : 'dns-first')
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
    return hostResolveOverride(url, { bootstrapResolveMode: resolveMode });
  }
  if (resolveMode === 'dns-first' || resolveMode === 'dns-only') {
    return bootstrapDnsResolveOverride(url, { bootstrapResolveMode: resolveMode });
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
  if (status === 403 && isPublicIcpBlockedError(err)) {
    return {
      state: 'network-unavailable',
      message: `公网域名被备案/公网入口拦截（403），不是 Internal 权限拒绝。请保留 Bootstrap API 域名，并在高级选项 Host Resolve 设置 api.mxinfo-inc.cn=<正式 Domestic gateway IP>；客户端会连接该 IP，HTTP Host 使用 gateway IP，原始域名放在 X-Forwarded-Host/X-MX-Bootstrap-Host。原始错误：${message}`
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
