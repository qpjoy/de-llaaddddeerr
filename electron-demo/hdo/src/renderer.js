// Demo landing page logic. It drives the market host through a tiny app-level API.
const api = window.qpjoyDemo;

document.getElementById('btn-market').addEventListener('click', () => {
  void api.openMarket();
});

document.getElementById('btn-market-new').addEventListener('click', () => {
  void api.openMarketInNewWindow();
});

const serverInput = document.getElementById('hdo-server-url');
const testUrlInput = document.getElementById('hdo-test-url');
const relayModeSelect = document.getElementById('hdo-relay-mode');
const accountInput = document.getElementById('hdo-account-id');
const passwordInput = document.getElementById('hdo-account-password');
const output = document.getElementById('hdo-output');
const chip = document.getElementById('hdo-status-chip');
const modeEl = document.getElementById('hdo-mode');
const overlayEl = document.getElementById('hdo-overlay');
const wgEl = document.getElementById('hdo-wg');
const buttons = [
  document.getElementById('btn-hdo-account-connect'),
  document.getElementById('btn-hdo-account-config'),
  document.getElementById('btn-hdo-anon-connect'),
  document.getElementById('btn-hdo-anon-config'),
  document.getElementById('btn-hdo-save-settings'),
  document.getElementById('btn-hdo-open-test'),
  document.getElementById('btn-hdo-stop'),
  document.getElementById('btn-hdo-refresh')
];

const savedServer = localStorage.getItem('qpjoy.hdoDemo.serverUrl');
if (savedServer) serverInput.value = savedServer;
testUrlInput.value = localStorage.getItem('qpjoy.hdoDemo.testUrl') || 'http://internal.mingxi.com';
relayModeSelect.value = normalizeRelayMode(localStorage.getItem('qpjoy.hdoDemo.relayMode'));
accountInput.value = localStorage.getItem('qpjoy.hdoDemo.accountId') || '';

document.getElementById('btn-hdo-refresh').addEventListener('click', () => {
  void refreshStatus();
});

document.getElementById('btn-hdo-anon-connect').addEventListener('click', () => {
  void runAnonymous(true);
});

document.getElementById('btn-hdo-anon-config').addEventListener('click', () => {
  void runAnonymous(false);
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

document.getElementById('btn-hdo-open-test').addEventListener('click', () => {
  void runAction('打开测试域名', async () => {
    persistInputs();
    return api.hdoOpenTestUrl(testUrlInput.value.trim());
  });
});

document.getElementById('btn-hdo-stop').addEventListener('click', () => {
  void runAction('停止 HDO', async () => api.hdoStop());
});

serverInput.addEventListener('change', persistInputs);
testUrlInput.addEventListener('change', persistInputs);
relayModeSelect.addEventListener('change', persistInputs);
accountInput.addEventListener('change', persistInputs);

void refreshStatus();

async function runAnonymous(autoConnect) {
  persistInputs();
  const serverUrl = serverInput.value.trim();
  await runAction(autoConnect ? '匿名连接 / 更新' : '只拉匿名配置', async () =>
    api.hdoAnonymousConnect({
      serverUrl,
      relayMode: normalizeRelayMode(relayModeSelect.value),
      autoConnect,
      testUrl: testUrlInput.value.trim()
    })
  );
}

async function runAccount(autoConnect) {
  persistInputs();
  await runAction(autoConnect ? '账号连接 / 更新' : '只拉账号配置', async () =>
    api.hdoAccountConnect({
      serverUrl: serverInput.value.trim(),
      relayMode: normalizeRelayMode(relayModeSelect.value),
      identifier: accountInput.value.trim() || null,
      password: passwordInput.value || null,
      autoConnect,
      testUrl: testUrlInput.value.trim()
    })
  );
}

async function runAction(label, fn) {
  setBusy(true);
  writeOutput(`${label}...`);
  try {
    const result = await fn();
    writeOutput(publicJson(result));
    await refreshStatus(false);
  } catch (err) {
    writeOutput(err instanceof Error ? err.message : String(err), true);
    chip.textContent = '出错';
    chip.className = 'status-chip status-chip--bad';
  } finally {
    setBusy(false);
  }
}

async function refreshStatus(showOutput = true) {
  try {
    const status = await api.hdoStatus();
    const hdo = status.hdo || {};
    const settings = hdo.settings || {};
    if (!serverInput.value && (settings.hdoControlBaseUrl || status.defaultServerUrl)) {
      serverInput.value = settings.hdoControlBaseUrl || status.defaultServerUrl;
    }
    relayModeSelect.value = normalizeRelayMode(settings.relayMode || relayModeSelect.value);
    const peer = settings.wireGuardPeer || {};
    const anonymous = settings.anonymous || {};
    const wgActive = hdo.wireGuardStatus && hdo.wireGuardStatus.active === true;
    const session = status.auth || hdo.session || {};
    const loggedIn = Boolean(session.user || session.loggedIn);
    const mode = anonymous.mode === 'anonymous' ? '匿名' : (loggedIn ? '账号' : '未登录');
    modeEl.textContent = mode;
    overlayEl.textContent = peer.overlayIp || '-';
    wgEl.textContent = wgActive ? '运行中' : '未运行';
    chip.textContent = wgActive ? `${mode}已连接` : `${mode}待连接`;
    chip.className = `status-chip ${wgActive ? 'status-chip--ok' : ''}`;
    if (showOutput) {
      writeOutput(publicJson({
        loggedIn,
        mode,
        serverBaseUrl: hdo.serverBaseUrl,
        relayMode: relayModeLabel(relayModeSelect.value),
        overlayIp: peer.overlayIp || null,
        wireGuardActive: wgActive,
        anonymous: anonymous.mode === 'anonymous' ? {
          appId: anonymous.appId,
          installId: anonymous.installId,
          updatedAt: anonymous.updatedAt
        } : null,
        domainProxy: settings.domainProxy || null,
        lastError: hdo.lastError || peer.lastError || null
      }));
    }
  } catch (err) {
    chip.textContent = '未就绪';
    chip.className = 'status-chip status-chip--bad';
    writeOutput(err instanceof Error ? err.message : String(err), true);
  }
}

function persistInputs() {
  localStorage.setItem('qpjoy.hdoDemo.serverUrl', serverInput.value.trim());
  localStorage.setItem('qpjoy.hdoDemo.testUrl', testUrlInput.value.trim());
  localStorage.setItem('qpjoy.hdoDemo.relayMode', normalizeRelayMode(relayModeSelect.value));
  localStorage.setItem('qpjoy.hdoDemo.accountId', accountInput.value.trim());
}

function setBusy(busy) {
  buttons.forEach((button) => {
    button.disabled = busy;
  });
}

function normalizeRelayMode(value) {
  return value === 'mesh-service-p2p' || value === 'mesh-p2p' ? value : 'mesh-server';
}

function relayModeLabel(value) {
  const mode = normalizeRelayMode(value);
  if (mode === 'mesh-service-p2p') return 'Service P2P';
  if (mode === 'mesh-p2p') return 'Mesh P2P';
  return 'Mesh Server';
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
