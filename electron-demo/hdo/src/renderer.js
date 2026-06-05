const api = window.qpjoyHdo || window.qpjoyDemo;

const serverInput = document.getElementById('hdo-server-url');
const internalUrlInput = document.getElementById('hdo-test-url');
const relayModeSelect = document.getElementById('hdo-relay-mode');
const accountInput = document.getElementById('hdo-account-id');
const passwordInput = document.getElementById('hdo-account-password');
const passwordToggleButton = document.getElementById('btn-hdo-toggle-password');
const reconnectButton = document.getElementById('btn-hdo-anon-connect');
const disconnectButton = document.getElementById('btn-hdo-disconnect');
const accountConnectButton = document.getElementById('btn-hdo-account-connect');
const output = document.getElementById('hdo-output');
const chip = document.getElementById('hdo-status-chip');
const modeEl = document.getElementById('hdo-mode');
const overlayEl = document.getElementById('hdo-overlay');
const wgEl = document.getElementById('hdo-wg');
const systemDomainEl = document.getElementById('hdo-system-domain');
const titleEl = document.getElementById('hdo-connection-title');
const detailEl = document.getElementById('hdo-status-detail');
const serverLabelEl = document.getElementById('hdo-server-label');
const loginHintEl = document.getElementById('hdo-login-hint');
const updateBannerEl = document.getElementById('hdo-update-banner');
const updateTextEl = document.getElementById('hdo-update-text');
const repairDnsMainButton = document.getElementById('btn-hdo-repair-dns-main');
const repairDnsButtons = [
  repairDnsMainButton,
  document.getElementById('btn-hdo-repair-dns')
].filter(Boolean);

const buttons = [
  accountConnectButton,
  document.getElementById('btn-hdo-account-config'),
  reconnectButton,
  disconnectButton,
  document.getElementById('btn-hdo-anon-config'),
  document.getElementById('btn-hdo-switch-anonymous'),
  document.getElementById('btn-hdo-save-settings'),
  ...repairDnsButtons,
  document.getElementById('btn-hdo-open-test'),
  document.getElementById('btn-hdo-stop'),
  document.getElementById('btn-hdo-refresh'),
  document.getElementById('btn-hdo-check-updates'),
  document.getElementById('btn-market'),
  document.getElementById('btn-market-new')
].filter(Boolean);

const DEFAULT_INTERNAL_URL = 'http://delta.mxinfo-inc.cn';
const LEGACY_DEFAULT_INTERNAL_URL = 'http://internal.mingxi.com';
const FAST_RELAY_MODE = 'mesh-h2i';
const NETWORK_ANONYMOUS = 'anonymous';
const NETWORK_ACCOUNT = 'account';
const CONNECT_PERMISSION_NOTE = [
  '权限提示：',
  '连接或重连 HDO 网络时，系统可能会请求管理员权限。'
].join('\n');
const DISCONNECT_PERMISSION_NOTE = [
  '权限提示：',
  '断开当前 HDO 网络时，系统可能会请求管理员权限。'
].join('\n');
const REPAIR_DNS_PERMISSION_NOTE = [
  '权限提示：',
  '修复 HDO DNS 优先级时，系统可能会请求管理员权限。'
].join('\n');

const storageKeys = {
  serverUrl: 'qpjoy.hdo.serverUrl',
  internalUrl: 'qpjoy.hdo.internalUrl',
  relayMode: 'qpjoy.hdo.relayMode',
  accountId: 'qpjoy.hdo.accountId',
  accountPassword: 'qpjoy.hdo.accountPassword',
  preferredNetwork: 'qpjoy.hdo.preferredNetwork'
};

const legacyStorageKeys = {
  serverUrl: 'qpjoy.hdoDemo.serverUrl',
  internalUrl: 'qpjoy.hdoDemo.testUrl',
  relayMode: 'qpjoy.hdoDemo.relayMode',
  accountId: 'qpjoy.hdoDemo.accountId'
};

let pendingStatusRefresh = null;
let lastStatus = null;

serverInput.value = readSaved('serverUrl') || '';
{
  const savedInternalUrl = readSaved('internalUrl');
  internalUrlInput.value = savedInternalUrl && savedInternalUrl !== LEGACY_DEFAULT_INTERNAL_URL
    ? savedInternalUrl
    : DEFAULT_INTERNAL_URL;
}
relayModeSelect.value = FAST_RELAY_MODE;
relayModeSelect.disabled = true;
accountInput.value = readSaved('accountId') || '';
passwordInput.value = readSaved('accountPassword') || '';

document.getElementById('btn-market').addEventListener('click', () => {
  void api.openMarket();
});

document.getElementById('btn-market-new').addEventListener('click', () => {
  void api.openMarketInNewWindow();
});

document.getElementById('btn-hdo-refresh').addEventListener('click', () => {
  void refreshStatus();
});

reconnectButton.addEventListener('click', () => {
  void runReconnect();
});

disconnectButton.addEventListener('click', () => {
  void runDisconnect('断开当前网络');
});

document.getElementById('btn-hdo-anon-config').addEventListener('click', () => {
  void runAnonymous(false, '同步匿名配置');
});

document.getElementById('btn-hdo-switch-anonymous').addEventListener('click', () => {
  void switchToAnonymousNetwork();
});

document.getElementById('btn-hdo-save-settings').addEventListener('click', () => {
  void runAction('保存配置', async () => {
    persistInputs();
    return api.hdoUpdateSettings({
      hdoControlBaseUrl: serverInput.value.trim(),
      relayMode: normalizeRelayMode(relayModeSelect.value)
    });
  });
});

accountConnectButton.addEventListener('click', () => {
  void runAccount(true);
});

document.getElementById('btn-hdo-account-config').addEventListener('click', () => {
  void runAccount(false);
});

repairDnsButtons.forEach((button) => {
  button.addEventListener('click', () => {
    void repairDnsPriority();
  });
});

passwordToggleButton.addEventListener('click', () => {
  const showing = passwordInput.type === 'text';
  passwordInput.type = showing ? 'password' : 'text';
  passwordToggleButton.textContent = showing ? '显示' : '隐藏';
});

document.getElementById('btn-hdo-open-test').addEventListener('click', () => {
  void runAction('打开内部地址', async () => {
    persistInputs();
    return api.hdoOpenTestUrl(internalUrlInput.value.trim());
  });
});

document.getElementById('btn-hdo-stop').addEventListener('click', () => {
  void runDisconnect('断开当前网络');
});

document.getElementById('btn-hdo-check-updates').addEventListener('click', () => {
  void runAction('检查更新', async () => api.checkUpdates());
});

serverInput.addEventListener('change', persistInputs);
internalUrlInput.addEventListener('change', persistInputs);
relayModeSelect.addEventListener('change', () => {
  relayModeSelect.value = FAST_RELAY_MODE;
  persistInputs();
});
accountInput.addEventListener('change', persistInputs);
passwordInput.addEventListener('change', persistInputs);
passwordInput.addEventListener('input', persistInputs);

if (typeof api.onHdoEvent === 'function') {
  api.onHdoEvent(() => {
    scheduleStatusRefresh(false, 300);
  });
}

void boot();
setInterval(() => {
  if (!document.hidden) scheduleStatusRefresh(false, 0);
}, 5000);

async function boot() {
  await refreshStatus(false);
  scheduleStatusRefresh(false, 1200);
}

function scheduleStatusRefresh(showOutput = false, delay = 400) {
  if (pendingStatusRefresh) clearTimeout(pendingStatusRefresh);
  pendingStatusRefresh = setTimeout(() => {
    pendingStatusRefresh = null;
    void refreshStatus(showOutput);
  }, delay);
}

async function runAnonymous(autoConnect, label = '重新连接') {
  if (!(await ensureNetworkActionAllowed(NETWORK_ANONYMOUS))) return;
  persistInputs();
  if (autoConnect) setPreferredNetwork(NETWORK_ANONYMOUS);
  const serverUrl = serverInput.value.trim();
  relayModeSelect.value = FAST_RELAY_MODE;
  await runAction(label, async () => api.hdoAnonymousConnect({
      serverUrl,
      relayMode: FAST_RELAY_MODE,
      autoConnect,
      testUrl: internalUrlInput.value.trim()
    }), autoConnect ? {
      permissionNote: CONNECT_PERMISSION_NOTE,
      detail: '接下来的系统权限用于连接或重启 HDO 网络。'
    } : {});
}

async function switchToAnonymousNetwork() {
  if (!(await ensureNetworkActionAllowed(NETWORK_ANONYMOUS))) return;
  persistInputs();
  setPreferredNetwork(NETWORK_ANONYMOUS);
  relayModeSelect.value = FAST_RELAY_MODE;
  await runAction('切回匿名网络', async () => api.hdoSwitchAnonymous({
      serverUrl: serverInput.value.trim(),
      relayMode: FAST_RELAY_MODE,
      testUrl: internalUrlInput.value.trim()
    }), {
      permissionNote: CONNECT_PERMISSION_NOTE,
      detail: '接下来的系统权限用于连接匿名 HDO 网络。'
    });
}

async function runReconnect() {
  const status = lastStatus || await refreshStatus(false);
  const target = targetNetworkForConnect(status);
  if (target === NETWORK_ACCOUNT && hasAccountAccess(status)) {
    await runAccount(true, isWireGuardActive(status) ? '重连账号线路' : '连接账号线路', false);
    return;
  }
  await runAnonymous(true, isWireGuardActive(status) ? '重连匿名线路' : '连接匿名线路');
}

async function runAccount(autoConnect, label, requireCredentials = true) {
  if (!(await ensureNetworkActionAllowed(NETWORK_ACCOUNT))) return;
  const identifier = accountInput.value.trim();
  const password = passwordInput.value;
  if ((identifier && !password) || (!identifier && password) || (requireCredentials && (!identifier || !password))) {
    writeOutput('请输入用户名和密码。', true);
    chip.textContent = '待登录';
    chip.className = 'status-chip status-chip--warn';
    return;
  }

  const relayMode = FAST_RELAY_MODE;
  relayModeSelect.value = FAST_RELAY_MODE;
  persistInputs();
  if (autoConnect) setPreferredNetwork(NETWORK_ACCOUNT);

  await runAction(label || (autoConnect ? '登录切换网段' : '同步账号配置'), async () => {
    const payload = {
      serverUrl: serverInput.value.trim(),
      relayMode,
      autoConnect,
      testUrl: internalUrlInput.value.trim()
    };
    if (identifier && password) {
      payload.identifier = identifier;
      payload.password = password;
    }
    return api.hdoAccountConnect(payload);
  }, autoConnect ? {
    permissionNote: CONNECT_PERMISSION_NOTE,
    detail: '接下来的系统权限用于连接或重启 HDO 网络。'
  } : {});
}

async function runDisconnect(label) {
  const status = lastStatus || await refreshStatus(false);
  if (!isWireGuardActive(status)) {
    writeOutput('当前没有已连接的 HDO 网络。');
    setConnectionCopy('当前未连接', '需要访问内网时，请点击连接当前线路。');
    chip.textContent = '未连接';
    chip.className = 'status-chip status-chip--warn';
    return;
  }
  const network = networkFromStatus(status);
  if (network) setPreferredNetwork(network);
  await runAction(label, async () => api.hdoStop(), {
    permissionNote: DISCONNECT_PERMISSION_NOTE,
    detail: '接下来的系统权限用于断开当前 HDO 网络。',
    waitFor: 'down'
  });
}

async function repairDnsPriority() {
  await runAction('修复 DNS 优先级', async () => api.hdoRepairDns(), {
    permissionNote: REPAIR_DNS_PERMISSION_NOTE,
    detail: '接下来的系统权限用于重新写入 HDO DNS/NRPT 优先级规则。'
  });
}

async function runAction(label, fn, options = {}) {
  setBusy(true);
  chip.textContent = `${label}中`;
  chip.className = 'status-chip';
  if (options.detail) setConnectionCopy(label, options.detail);
  writeOutput(options.permissionNote ? `${label}...\n\n${options.permissionNote}` : `${label}...`);
  try {
    const result = await fn();
    writeOutput(publicJson(result));
    const failure = actionFailureMessage(result);
    if (failure) throw new Error(failure);
    if (options.waitFor === 'down') {
      setConnectionCopy('正在断开网络', '已确认系统权限，正在等待 HDO 网络停止。');
      chip.textContent = '断开中';
      chip.className = 'status-chip status-chip--warn';
      await waitForTunnelDown();
    }
    if (shouldWaitForTunnel(result)) {
      setConnectionCopy('正在完成连接', '已确认系统权限，正在等待线路启动。');
      chip.textContent = '连接中';
      chip.className = 'status-chip status-chip--warn';
      const ready = await waitForTunnelReady();
      if (!ready) {
        setConnectionCopy('正在确认线路', '系统授权已完成，正在等待后台隧道进入可用状态。');
        scheduleStatusRefresh(false, 1800);
      }
    }
    await refreshStatus(false);
    scheduleStatusRefresh(false, 1200);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeOutput(message, true);
    chip.textContent = '处理失败';
    chip.className = 'status-chip status-chip--bad';
    setConnectionCopy('连接未完成', message);
  } finally {
    setBusy(false);
  }
}

async function waitForTunnelReady(timeoutMs = 45_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await delay(1200);
    const status = await refreshStatus(false);
    if (status?.hdo?.wireGuardStatus?.active === true && status?.hdoNetworkProbe?.ok === true) return true;
  }
  return false;
}

async function waitForTunnelDown(timeoutMs = 20_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await delay(800);
    const status = await refreshStatus(false);
    if (status?.hdo?.wireGuardStatus?.active !== true) return true;
  }
  return false;
}

function shouldWaitForTunnel(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.wireGuardStatus && result.wireGuardStatus.active === true) return false;
  if (isAuthorizationCancelResult(result.connected)) return false;
  const connected = result.connected;
  const prepared = result.prepared && typeof result.prepared === 'object' ? result.prepared : null;
  const peer = result.peer || (prepared && prepared.peer);
  if (connected && typeof connected === 'object' && connected.ok === true) return true;
  return Boolean(
    result.ok !== false &&
    peer &&
    typeof peer === 'object' &&
    peer.configPath &&
    result.connected !== null &&
    result.connected !== undefined
  );
}

function actionFailureMessage(result) {
  if (!result || typeof result !== 'object') return null;
  const connected = result.connected;
  if (connected && typeof connected === 'object' && connected.ok === false) {
    return String(connected.message || connected.error || 'WireGuard 启动失败');
  }
  const prepared = result.prepared;
  if (prepared && typeof prepared === 'object' && prepared.ok === false) {
    return String(prepared.message || prepared.error || 'WireGuard 配置生成失败');
  }
  const peer = result.peer || (prepared && typeof prepared === 'object' ? prepared.peer : null);
  if (peer && typeof peer === 'object' && peer.lastError) {
    return String(peer.lastError);
  }
  return null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function refreshStatus(showOutput = true) {
  try {
    const status = await api.hdoStatus();
    lastStatus = status;
    const hdo = status.hdo || {};
    const settings = hdo.settings || {};
    const configuredServerUrl = status.defaultServerUrl
      ? (settings.hdoControlBaseUrl || status.defaultServerUrl)
      : '';
    if (!serverInput.value && configuredServerUrl) {
      serverInput.value = configuredServerUrl;
    }
    relayModeSelect.value = FAST_RELAY_MODE;

    const peer = settings.wireGuardPeer || {};
    const anonymous = settings.anonymous || {};
    const wireGuardStatus = hdo.wireGuardStatus || null;
    const wgActive = wireGuardStatus && wireGuardStatus.active === true;
    const hdoNetworkProbe = status.hdoNetworkProbe || null;
    const networkReady = wgActive && hdoNetworkProbe && hdoNetworkProbe.ok === true;
    const systemDomainProxy = status.systemDomainProxy || {};
    const session = status.auth || hdo.session || {};
    const loggedIn = Boolean(session.user || session.loggedIn);
    const currentNetwork = networkFromStatus(status);
    const configuredNetwork = currentNetwork || targetNetworkForConnect(status);
    const anonymousPeer = currentNetwork === NETWORK_ANONYMOUS;
    const accountConnected = currentNetwork === NETWORK_ACCOUNT;
    const mode = currentNetwork ? networkLabel(currentNetwork) : networkLabel(configuredNetwork);
    const lastError = hdo.lastError || peer.lastError || null;
    renderUpdateBanner(status.updates?.restartRequired || null);

    modeEl.textContent = mode;
    overlayEl.textContent = peer.overlayIp || '-';
    wgEl.textContent = networkReady ? '已连接' : (wgActive ? '网络未通' : '未连接');
    systemDomainEl.textContent = systemDomainProxy.applied
      ? '已接管'
      : (systemDomainProxy.supported === false ? '不支持' : '未启用');
    serverLabelEl.textContent = serverInput.value ? '服务已配置' : '服务未配置';
    disconnectButton.hidden = !wgActive;
    if (repairDnsMainButton) repairDnsMainButton.hidden = !wgActive;
    reconnectButton.textContent = wgActive ? '重连当前线路' : `连接${networkLabel(configuredNetwork)}`;
    accountConnectButton.textContent = accountConnected ? '重连账号线路' : (wgActive ? '先断开再切账号' : '登录切换网段');
    loginHintEl.textContent = wgActive
      ? `当前为${networkLabel(currentNetwork)}；切换线路前请先断开当前网络。`
      : (configuredNetwork === NETWORK_ACCOUNT
        ? '当前未连接账号线路；需要匿名段时可在高级功能切回匿名网络。'
        : (loggedIn ? '当前未连接匿名线路；点击登录会在断开状态下切换到账号网段。' : '当前未连接匿名线路；登录后可切换到账号网段。'));

    if (networkReady) {
      chip.textContent = '已连接';
      chip.className = 'status-chip status-chip--ok';
      setConnectionCopy(
        `${networkLabel(currentNetwork)}已连接`,
        '需要切换账号/匿名线路时，请先断开当前网络，再连接目标线路。'
      );
    } else if (wgActive && hdoNetworkProbe && hdoNetworkProbe.ok === false) {
      chip.textContent = '网络未通';
      chip.className = 'status-chip status-chip--bad';
      setConnectionCopy(
        `${networkLabel(currentNetwork)}未连通`,
        `WireGuard 已启动，但 ${hdoNetworkProbe.target || '100.88.0.1'} 暂不可达；请重连当前线路或断开后重新连接。`
      );
    } else if (lastError) {
      chip.textContent = '需处理';
      chip.className = 'status-chip status-chip--bad';
      setConnectionCopy('连接未完成', String(lastError));
    } else {
      chip.textContent = '未连接';
      chip.className = 'status-chip status-chip--warn';
      setConnectionCopy(`${networkLabel(configuredNetwork)}未连接`, '点击连接当前线路；切换账号/匿名线路不再自动进行。');
    }

    if (showOutput) {
      writeOutput(publicJson({
        loggedIn,
        mode,
        serverBaseUrl: hdo.serverBaseUrl,
        relayMode: relayModeLabel(relayModeSelect.value),
        overlayIp: peer.overlayIp || null,
        wireGuardActive: wgActive,
        wireGuardDiagnostics: wireGuardStatus ? {
          mode: wireGuardStatus.mode || null,
          interfaceName: wireGuardStatus.interfaceName || null,
          realInterfaceName: wireGuardStatus.realInterfaceName || null,
          addresses: wireGuardStatus.addresses || [],
          allowedIps: wireGuardStatus.allowedIps || [],
          missingRoutes: wireGuardStatus.missingRoutes || [],
          routeLogPath: wireGuardStatus.routeLogPath || null,
          routeLogTail: wireGuardStatus.routeLogTail || null,
          error: wireGuardStatus.error || null
        } : null,
        accountConnected,
        anonymousPeer,
        anonymous: anonymous.mode === 'anonymous' ? {
          appId: anonymous.appId,
          installId: anonymous.installId,
          updatedAt: anonymous.updatedAt
        } : null,
        domainProxy: settings.domainProxy || null,
        systemDomainProxy,
        hdoNetworkProbe,
        lastError
      }));
    }
    return status;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    chip.textContent = '未就绪';
    chip.className = 'status-chip status-chip--bad';
    setConnectionCopy('服务未就绪', message);
    writeOutput(message, true);
    return null;
  }
}

function renderUpdateBanner(update) {
  if (!update || typeof update !== 'object') {
    updateBannerEl.hidden = true;
    updateTextEl.textContent = '';
    return;
  }
  const targetKind = update.targetKind || 'app';
  const target = update.targetId || 'MX HDO';
  const version = update.toVersion ? ` ${update.toVersion}` : '';
  updateTextEl.textContent =
    targetKind === 'game'
      ? `MX HDO${version} 已进入当前设备的发布范围，重启或安装新版后完成更新。`
      : `${target}${version} 需要重启后完成更新。`;
  updateBannerEl.hidden = false;
}

function persistInputs() {
  localStorage.setItem(storageKeys.serverUrl, serverInput.value.trim());
  localStorage.setItem(storageKeys.internalUrl, internalUrlInput.value.trim());
  localStorage.setItem(storageKeys.relayMode, FAST_RELAY_MODE);
  localStorage.setItem(storageKeys.accountId, accountInput.value.trim());
  localStorage.setItem(storageKeys.accountPassword, passwordInput.value);
}

function readSaved(key) {
  const value = localStorage.getItem(storageKeys[key]);
  if (value) return value;
  return localStorage.getItem(legacyStorageKeys[key]);
}

function setPreferredNetwork(value) {
  if (value !== NETWORK_ACCOUNT && value !== NETWORK_ANONYMOUS) return;
  localStorage.setItem(storageKeys.preferredNetwork, value);
}

function setBusy(busy) {
  buttons.forEach((button) => {
    button.disabled = busy;
  });
}

function setConnectionCopy(title, detail) {
  titleEl.textContent = title;
  detailEl.textContent = detail;
}

function normalizeRelayMode(value) {
  return FAST_RELAY_MODE;
}

function accountPreferredRelayMode() {
  return FAST_RELAY_MODE;
}

function relayModeLabel(value) {
  const mode = normalizeRelayMode(value);
  if (mode === 'mesh-h2i') return 'Mesh H2I';
  if (mode === 'mesh-h2h') return 'Mesh H2H';
  return 'Mesh HDI';
}

function isAnonymousPeer(settings, peer) {
  if (settings?.anonymous?.mode === 'anonymous') return true;
  if (String(settings?.deviceId || '').startsWith('hdo-anon-')) return true;
  return String(peer?.overlayIp || '').startsWith('100.91.');
}

function isWireGuardActive(status) {
  return status?.hdo?.wireGuardStatus?.active === true;
}

function networkFromStatus(status) {
  const hdo = status?.hdo || {};
  const settings = hdo.settings || {};
  const peer = settings.wireGuardPeer || {};
  if (!peer.overlayIp) return null;
  return isAnonymousPeer(settings, peer) ? NETWORK_ANONYMOUS : NETWORK_ACCOUNT;
}

function activeNetworkFromStatus(status) {
  return isWireGuardActive(status) ? networkFromStatus(status) : null;
}

function targetNetworkForConnect(status) {
  const target = networkFromStatus(status) || preferredNetworkFromStatus(status);
  if (target === NETWORK_ACCOUNT && !hasAccountAccess(status)) return NETWORK_ANONYMOUS;
  return target;
}

function preferredNetworkFromStatus(status) {
  const saved = localStorage.getItem(storageKeys.preferredNetwork);
  if (saved === NETWORK_ACCOUNT || saved === NETWORK_ANONYMOUS) return saved;
  return networkFromStatus(status) || NETWORK_ANONYMOUS;
}

function hasAccountAccess(status) {
  const hdo = status?.hdo || {};
  const session = status?.auth || hdo.session || {};
  return Boolean(session.user || session.loggedIn || (accountInput.value.trim() && passwordInput.value));
}

async function ensureNetworkActionAllowed(targetNetwork) {
  const status = lastStatus || await refreshStatus(false);
  const activeNetwork = activeNetworkFromStatus(status);
  if (!activeNetwork || activeNetwork === targetNetwork) return true;
  const currentLabel = networkLabel(activeNetwork);
  const targetLabel = networkLabel(targetNetwork);
  const message = `当前已连接${currentLabel}。切换到${targetLabel}前，请先点击“断开当前网络”。`;
  writeOutput(message, true);
  chip.textContent = '需先断开';
  chip.className = 'status-chip status-chip--warn';
  setConnectionCopy('请先断开当前网络', message);
  return false;
}

function networkLabel(value) {
  return value === NETWORK_ACCOUNT ? '账号线路' : '匿名线路';
}

function isAuthorizationCancelResult(value) {
  if (!value || typeof value !== 'object' || value.ok !== false) return false;
  const message = String(value.error || value.message || '');
  return /cancel|取消|用户已取消|user canceled|-128/i.test(message);
}

function writeOutput(value, isError = false) {
  output.textContent = value;
  output.classList.toggle('console--error', isError);
}

function publicJson(value) {
  return JSON.stringify(redact(value), null, 2);
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (/privateKey|config|password|token|authorization/i.test(key)) {
      out[key] = '<redacted>';
    } else {
      out[key] = redact(raw);
    }
  }
  return out;
}
