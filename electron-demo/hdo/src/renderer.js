const api = window.qpjoyHdo || window.qpjoyDemo;

const serverInput = document.getElementById('hdo-server-url');
const internalUrlInput = document.getElementById('hdo-test-url');
const relayModeSelect = document.getElementById('hdo-relay-mode');
const accountInput = document.getElementById('hdo-account-id');
const passwordInput = document.getElementById('hdo-account-password');
const passwordToggleButton = document.getElementById('btn-hdo-toggle-password');
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

const buttons = [
  document.getElementById('btn-hdo-account-connect'),
  document.getElementById('btn-hdo-account-config'),
  document.getElementById('btn-hdo-anon-connect'),
  document.getElementById('btn-hdo-anon-config'),
  document.getElementById('btn-hdo-save-settings'),
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

const storageKeys = {
  serverUrl: 'qpjoy.hdo.serverUrl',
  internalUrl: 'qpjoy.hdo.internalUrl',
  relayMode: 'qpjoy.hdo.relayMode',
  accountId: 'qpjoy.hdo.accountId',
  accountPassword: 'qpjoy.hdo.accountPassword'
};

const legacyStorageKeys = {
  serverUrl: 'qpjoy.hdoDemo.serverUrl',
  internalUrl: 'qpjoy.hdoDemo.testUrl',
  relayMode: 'qpjoy.hdoDemo.relayMode',
  accountId: 'qpjoy.hdoDemo.accountId'
};

let pendingStatusRefresh = null;
let lastStatus = null;
let autoAnonymousStarted = false;

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

document.getElementById('btn-hdo-anon-connect').addEventListener('click', () => {
  void runAnonymous(true, '重新连接');
});

document.getElementById('btn-hdo-anon-config').addEventListener('click', () => {
  void runAnonymous(false, '同步匿名配置');
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

document.getElementById('btn-hdo-account-connect').addEventListener('click', () => {
  void runAccount(true);
});

document.getElementById('btn-hdo-account-config').addEventListener('click', () => {
  void runAccount(false);
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
  void runAction('停止 HDO', async () => api.hdoStop());
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
  await ensureAnonymousConnected();
  scheduleStatusRefresh(false, 1200);
}

function scheduleStatusRefresh(showOutput = false, delay = 400) {
  if (pendingStatusRefresh) clearTimeout(pendingStatusRefresh);
  pendingStatusRefresh = setTimeout(() => {
    pendingStatusRefresh = null;
    void refreshStatus(showOutput);
  }, delay);
}

async function ensureAnonymousConnected() {
  if (autoAnonymousStarted) return;
  autoAnonymousStarted = true;
  const status = lastStatus || await refreshStatus(false);
  const hdo = status?.hdo || {};
  const settings = hdo.settings || {};
  const wgActive = hdo.wireGuardStatus && hdo.wireGuardStatus.active === true;
  const peer = settings.wireGuardPeer || {};
  if (wgActive) {
    if (isAnonymousPeer(settings, peer) && accountInput.value.trim() && passwordInput.value) {
      await runAccount(true, '切换账号线路');
    }
    return;
  }

  const serverUrl = serverInput.value.trim() || status?.defaultServerUrl || '';
  if (!serverUrl) {
    setConnectionCopy('需要配置服务地址', '请在高级功能中填写 HDO 服务地址，或使用已预置服务的安装包。');
    chip.textContent = '待配置';
    chip.className = 'status-chip status-chip--warn';
    return;
  }
  serverInput.value = serverUrl;
  if (accountInput.value.trim() && passwordInput.value) {
    await runAccount(true, '启用账号线路');
    return;
  }
  await runAnonymous(true, '启用匿名访问');
}

async function runAnonymous(autoConnect, label = '重新连接') {
  persistInputs();
  const serverUrl = serverInput.value.trim();
  relayModeSelect.value = FAST_RELAY_MODE;
  await runAction(label, async () =>
    api.hdoAnonymousConnect({
      serverUrl,
      relayMode: FAST_RELAY_MODE,
      autoConnect,
      testUrl: internalUrlInput.value.trim()
    })
  );
}

async function runAccount(autoConnect, label) {
  const identifier = accountInput.value.trim();
  const password = passwordInput.value;
  if (!identifier || !password) {
    writeOutput('请输入用户名和密码。', true);
    chip.textContent = '待登录';
    chip.className = 'status-chip status-chip--warn';
    return;
  }

  const relayMode = FAST_RELAY_MODE;
  relayModeSelect.value = FAST_RELAY_MODE;
  persistInputs();

  await runAction(label || (autoConnect ? '登录并提速' : '同步账号配置'), async () =>
    api.hdoAccountConnect({
      serverUrl: serverInput.value.trim(),
      relayMode,
      identifier,
      password,
      rotate: true,
      autoConnect,
      testUrl: internalUrlInput.value.trim()
    })
  );
}

async function runAction(label, fn) {
  setBusy(true);
  chip.textContent = `${label}中`;
  chip.className = 'status-chip';
  writeOutput(`${label}...`);
  try {
    const result = await fn();
    writeOutput(publicJson(result));
    if (shouldWaitForTunnel(result)) {
      setConnectionCopy('正在完成连接', '已确认系统权限，正在等待线路启动。');
      chip.textContent = '连接中';
      chip.className = 'status-chip status-chip--warn';
      await waitForTunnelReady();
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

async function waitForTunnelReady(timeoutMs = 14_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await delay(900);
    const status = await refreshStatus(false);
    if (status?.hdo?.wireGuardStatus?.active === true) return true;
  }
  return false;
}

function shouldWaitForTunnel(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.wireGuardStatus && result.wireGuardStatus.active === true) return false;
  const connected = result.connected;
  const peer = result.peer;
  return Boolean(
    result.ok !== false &&
    peer &&
    typeof peer === 'object' &&
    peer.configPath &&
    connected &&
    typeof connected === 'object' &&
    connected.ok !== false
  );
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
    const wgActive = hdo.wireGuardStatus && hdo.wireGuardStatus.active === true;
    const systemDomainProxy = status.systemDomainProxy || {};
    const session = status.auth || hdo.session || {};
    const loggedIn = Boolean(session.user || session.loggedIn);
    const anonymousPeer = isAnonymousPeer(settings, peer);
    const accountConnected = loggedIn && !anonymousPeer;
    const mode = accountConnected
      ? '账号线路'
      : (anonymousPeer ? '匿名线路' : (loggedIn ? '账号待切换' : '准备中'));
    const lastError = hdo.lastError || peer.lastError || null;
    renderUpdateBanner(status.updates?.restartRequired || null);

    modeEl.textContent = mode;
    overlayEl.textContent = peer.overlayIp || '-';
    wgEl.textContent = wgActive ? '已连接' : '未连接';
    systemDomainEl.textContent = systemDomainProxy.applied
      ? '已接管'
      : (systemDomainProxy.supported === false ? '不支持' : '未启用');
    serverLabelEl.textContent = serverInput.value ? '服务已配置' : '服务未配置';
    loginHintEl.textContent = loggedIn
      ? '已使用账号配置，后续会优先保持专属线路。'
      : '未登录也可以使用匿名线路；登录后会自动切换到账号线路。';

    if (wgActive) {
      chip.textContent = '已连接';
      chip.className = 'status-chip status-chip--ok';
      setConnectionCopy(
        accountConnected ? '专属线路已开启' : '匿名线路已开启',
        accountConnected ? '已拉取账号配置，正在使用更稳定的访问路径。' : '当前可直接访问；登录后会切换到你的专属配置。'
      );
    } else if (lastError) {
      chip.textContent = '需处理';
      chip.className = 'status-chip status-chip--bad';
      setConnectionCopy('连接未完成', String(lastError));
    } else {
      chip.textContent = '准备中';
      chip.className = 'status-chip status-chip--warn';
      setConnectionCopy('正在准备安全访问', '系统会优先尝试匿名线路，登录后可获得更快线路。');
    }

    if (showOutput) {
      writeOutput(publicJson({
        loggedIn,
        mode,
        serverBaseUrl: hdo.serverBaseUrl,
        relayMode: relayModeLabel(relayModeSelect.value),
        overlayIp: peer.overlayIp || null,
        wireGuardActive: wgActive,
        accountConnected,
        anonymousPeer,
        anonymous: anonymous.mode === 'anonymous' ? {
          appId: anonymous.appId,
          installId: anonymous.installId,
          updatedAt: anonymous.updatedAt
        } : null,
        domainProxy: settings.domainProxy || null,
        systemDomainProxy,
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
