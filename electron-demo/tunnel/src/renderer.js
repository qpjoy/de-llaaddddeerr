// Demo landing page logic. The host app can run tunnel fully locally, or ask
// the D backend for a managed profile and apply it to the local tunnel plugin.
const api = window.qpjoyDemo;

document.getElementById('btn-market').addEventListener('click', () => {
  void api.openMarket();
});

document.getElementById('btn-market-new').addEventListener('click', () => {
  void api.openMarketInNewWindow();
});

const state = {
  mode: localStorage.getItem('qpjoy.demo.connectionMode') || 'client-only',
  busy: false,
  tunnelStatus: null
};

const el = {
  clientMode: document.getElementById('btn-mode-client'),
  backendMode: document.getElementById('btn-mode-backend'),
  backendPanel: document.getElementById('backend-panel'),
  serverUrl: document.getElementById('server-url'),
  identifier: document.getElementById('server-identifier'),
  password: document.getElementById('server-password'),
  saveServer: document.getElementById('btn-save-server'),
  applyBackend: document.getElementById('btn-apply-backend'),
  toggleTunnel: document.getElementById('btn-toggle-tunnel'),
  stopTunnel: document.getElementById('btn-stop-tunnel'),
  status: document.getElementById('demo-status'),
  pillServer: document.getElementById('pill-server'),
  pillServerText: document.getElementById('pill-server-text')
};

const modeLabels = {
  'app-rule': 'App 模式',
  'app-global': '全局模式',
  'system-tun': '虚拟网卡'
};

function setStatus(message, tone = 'idle') {
  el.status.textContent = message;
  el.status.dataset.tone = tone;
}

function describeStatus(status) {
  if (!status) return 'Tunnel 插件暂未返回状态。';
  const active = status.activeSubscription?.name || '未选择订阅';
  return [
    `Tunnel: ${status.running ? '运行中' : '未启动'}`,
    `模式: ${status.mode}`,
    `订阅: ${active}`,
    `管理端口: ${status.adminUrl || 'http://127.0.0.1:23456'}`
  ].join('\n');
}

function renderTunnelControls() {
  const status = state.tunnelStatus;
  const mode = status?.mode || 'app-global';
  const label = modeLabels[mode] || mode;
  const running = Boolean(status?.running);
  if (el.toggleTunnel) {
    el.toggleTunnel.textContent = running ? '停止 Tunnel' : `开启 ${label}`;
    el.toggleTunnel.classList.toggle('mini-button--stop', running);
    el.toggleTunnel.classList.toggle('mini-button--run', !running);
  }
  if (el.stopTunnel) {
    el.stopTunnel.disabled = !running;
  }
}

function setConnectionMode(mode) {
  state.mode = mode;
  localStorage.setItem('qpjoy.demo.connectionMode', mode);
  const backend = mode === 'backend';
  el.clientMode.classList.toggle('is-active', !backend);
  el.backendMode.classList.toggle('is-active', backend);
  el.backendPanel.classList.toggle('is-hidden', !backend);
  el.pillServer.classList.toggle('pill--ok', backend);
  el.pillServerText.textContent = backend ? '等待后端配置' : '本机离线运行';
}

function loadSavedForm() {
  el.serverUrl.value = localStorage.getItem('qpjoy.demo.serverUrl') || '';
  el.identifier.value = localStorage.getItem('qpjoy.demo.identifier') || '';
}

function saveForm() {
  localStorage.setItem('qpjoy.demo.serverUrl', el.serverUrl.value.trim());
  localStorage.setItem('qpjoy.demo.identifier', el.identifier.value.trim());
}

async function refreshStatus() {
  try {
    const status = await api.status();
    state.tunnelStatus = status?.tunnel ?? null;
    renderTunnelControls();
    const server = status?.marketServer?.effective?.url || status?.marketServer?.nextRestart?.url || '';
    if (server && !el.serverUrl.value) {
      el.serverUrl.value = server;
    }
    const suffix = status?.marketServer?.restartRequired ? '\n市场同步 URL 已保存，重启后生效。' : '';
    setStatus(`${describeStatus(status?.tunnel)}${suffix}`, status?.tunnelAvailable ? 'ok' : 'warn');
  } catch (err) {
    setStatus(`读取状态失败：${err.message || String(err)}`, 'error');
  }
}

async function runTask(label, task) {
  if (state.busy) return;
  state.busy = true;
  setStatus(`${label}...`, 'idle');
  try {
    const result = await task();
    const latest = await api.status().catch(() => null);
    if (latest) {
      state.tunnelStatus = latest.tunnel ?? null;
      renderTunnelControls();
    }
    const current = latest?.tunnel ? `\n\n当前状态:\n${describeStatus(latest.tunnel)}` : '';
    setStatus(`${label}完成。\n${JSON.stringify(result, null, 2)}${current}`, 'ok');
  } catch (err) {
    setStatus(`${label}失败：${err.message || String(err)}`, 'error');
  } finally {
    state.busy = false;
  }
}

el.clientMode.addEventListener('click', () => {
  setConnectionMode('client-only');
  setStatus('已切换到客户端 only：订阅、规则、模式都由本机 Tunnel 控制。', 'ok');
});

el.backendMode.addEventListener('click', () => {
  setConnectionMode('backend');
  setStatus('已切换到后端托管：填写 D 后端地址和用户账号后即可拉取配置。', 'idle');
});

el.saveServer.addEventListener('click', () => {
  saveForm();
  void runTask('保存市场后端 URL', () => api.setMarketServer({ serverUrl: el.serverUrl.value.trim() }));
});

el.applyBackend.addEventListener('click', () => {
  saveForm();
  setConnectionMode('backend');
  void runTask('应用后端 Tunnel 配置', () => api.applyBackendConfig({
    serverUrl: el.serverUrl.value.trim(),
    identifier: el.identifier.value.trim(),
    password: el.password.value
  }));
});

if (el.toggleTunnel) {
  el.toggleTunnel.addEventListener('click', () => {
    const status = state.tunnelStatus;
    if (status?.running) {
      void runTask('停止 Tunnel', () => api.stopTunnel());
      return;
    }
    const mode = status?.mode || 'app-global';
    void runTask(`开启 Tunnel ${modeLabels[mode] || mode}`, () => api.startTunnelMode(mode));
  });
}

if (el.stopTunnel) {
  el.stopTunnel.addEventListener('click', () => {
    void runTask('停止 Tunnel', () => api.stopTunnel());
  });
}

for (const button of document.querySelectorAll('[data-tunnel-start-mode]')) {
  button.addEventListener('click', () => {
    const mode = button.getAttribute('data-tunnel-start-mode');
    void runTask(`启动 Tunnel ${button.textContent.trim()}`, () => api.startTunnelMode(mode));
  });
}

loadSavedForm();
setConnectionMode(state.mode);
renderTunnelControls();
void refreshStatus();
