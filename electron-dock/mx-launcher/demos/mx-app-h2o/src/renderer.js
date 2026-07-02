const electronApi = window.h2o || null;
const api = electronApi || createMockApi();
const root = document.getElementById('app');

let state = null;
let busy = '';
let view = 'runtime';
let debugOpen = false;
let shellMenuOpen = false;
let shellNotice = '';

void boot();

async function boot() {
  state = await api.getState();
  render();
  api.onState?.((next) => {
    state = next;
    render();
  });
}

root.addEventListener('click', (event) => {
  const control = event.target.closest('[data-window-control]');
  if (control) {
    shellMenuOpen = false;
    void api.windowControl?.(control.dataset.windowControl);
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'toggle-shell-menu') {
    shellMenuOpen = !shellMenuOpen;
    render();
    return;
  }
  if (action === 'switch-shell-target') {
    shellMenuOpen = false;
    const target = button.dataset.target || 'h2o';
    if (target === 'close') {
      void api.windowControl?.('close');
      return;
    }
    shellNotice = target === 'h2i'
      ? 'H2I（VPN）入口由 MX-H2I/AppCenter 容器承载；开发态请回到 MX-H2I 窗口。'
      : 'AppCenter 入口由 MX-H2I 容器承载；开发态请回到 MX-H2I 窗口。';
    render();
    return;
  }
  if (action === 'set-view') {
    shellMenuOpen = false;
    view = button.dataset.view || 'runtime';
    render();
    return;
  }
  if (action === 'set-mode') {
    shellMenuOpen = false;
    void run('setMode', button.dataset.mode || 'rule');
    return;
  }
  if (action === 'toggle-debug') {
    shellMenuOpen = false;
    debugOpen = !debugOpen;
    render();
    return;
  }
  if (action === 'request-proxy') {
    shellMenuOpen = false;
    void run('requestBroker', 'network.proxy', { mode: state.policy.mode });
    return;
  }
  shellMenuOpen = false;
  void run(action);
});

async function run(action, ...args) {
  if (busy) return;
  busy = action;
  render();
  try {
    const handlers = {
      connectBroker: () => api.connectBroker(),
      refresh: () => api.refresh(),
      setMode: (mode) => api.setMode(mode),
      requestBroker: (name, payload) => api.requestBroker(name, payload)
    };
    if (handlers[action]) {
      const result = await handlers[action](...args);
      state = result?.state || result;
    }
  } finally {
    busy = '';
    render();
  }
}

function render() {
  if (!state) return;
  const connected = state.broker?.ok === true;
  root.innerHTML = `
    <section class="h2o-shell ${debugOpen ? 'is-debug-open' : ''}">
      ${renderAppShellBar(connected)}
      <aside class="h2o-sidebar">
        <div class="h2o-brand">
          <div class="h2o-mark">H2O</div>
          <div>
            <h1>H2O</h1>
            <p>Home To Oversea</p>
          </div>
        </div>
        <nav class="h2o-nav">
          ${navItem('runtime', '概览')}
          ${navItem('proxy', '代理')}
          ${navItem('dns', 'DNS / PAC')}
          ${navItem('logs', '记录')}
        </nav>
        <div class="h2o-version">
          <button class="text-button" type="button" data-action="toggle-debug">${debugOpen ? '隐藏 Debug' : 'Debug'}</button>
          <span>App ${escapeHtml(state.app.version)}</span>
        </div>
      </aside>

      <section class="h2o-main">
        <header class="h2o-toolbar">
          <div>
            <p class="kicker">H2O</p>
            <h2>Home To Oversea</h2>
          </div>
          <div class="toolbar-actions">
            <button class="secondary-button" type="button" data-action="toggle-debug">${debugOpen ? '关闭 Debug' : 'Debug'}</button>
            <button class="primary-button" type="button" data-action="refresh" ${!connected || busy === 'refresh' ? 'disabled' : ''}>刷新</button>
          </div>
        </header>

        <section class="h2o-status-strip" data-state="${escapeAttr(state.broker.state)}">
          <strong>${escapeHtml(connected ? '运行正常' : '需要连接')}</strong>
          <span>${escapeHtml(shellNotice || (connected ? 'Home To Oversea 规则、PAC 和 Split DNS 已就绪。' : state.broker.message))}</span>
        </section>

        ${renderView()}
      </section>

      ${debugOpen ? renderDebugPanel() : renderUserPanel()}
    </section>
  `;
}

function renderAppShellBar(connected) {
  return `
    <header class="app-shell-bar">
      <div class="app-shell-identity">
        <div class="app-shell-mark">H2O</div>
        <div>
          <strong>H2O</strong>
          <span>${escapeHtml(connected ? 'MX-H2I broker-session 已连接' : '等待 MX-H2I broker-session')}</span>
        </div>
      </div>
      <div class="app-shell-actions">
        <button class="app-window-button" type="button" data-window-control="minimize" aria-label="Minimize">-</button>
        <button class="app-window-button" type="button" data-window-control="zoom" aria-label="Zoom">□</button>
        <div class="app-shell-menu">
          <button class="app-window-button" type="button" data-action="toggle-shell-menu" aria-label="App menu">...</button>
          ${shellMenuOpen ? `
            <div class="app-shell-popover" role="menu">
              <button type="button" data-action="switch-shell-target" data-target="h2i">
                <span>H2I（VPN）</span>
                <small>返回连接面板</small>
              </button>
              <button type="button" data-action="switch-shell-target" data-target="appcenter">
                <span>AppCenter</span>
                <small>应用中心</small>
              </button>
              <button type="button" data-action="switch-shell-target" data-target="close">
                <span>关闭</span>
                <small>关闭当前应用</small>
              </button>
            </div>
          ` : ''}
        </div>
      </div>
    </header>
  `;
}

function renderView() {
  if (view === 'proxy') return renderProxy();
  if (view === 'dns') return renderDns();
  if (view === 'logs') return renderLogs();
  return renderRuntime();
}

function renderUserPanel() {
  const connected = state.broker?.ok === true;
  return `
    <aside class="h2o-inspector h2o-user-panel">
      <h3>当前状态</h3>
      <div class="h2o-health-card" data-state="${escapeAttr(connected ? 'ok' : 'warning')}">
        <strong>${escapeHtml(connected ? '已就绪' : '未连接')}</strong>
        <span>${escapeHtml(connected ? '当前出海网络策略由 MX-H2I broker-session 托管。' : '请先通过 MX-H2I 打开 H2O。')}</span>
      </div>
      <div class="h2o-tip-list">
        <div><strong>代理模式</strong><span>${escapeHtml(modeLabel(state.policy.mode))}</span></div>
        <div><strong>规则数量</strong><span>${escapeHtml(String((state.rules || []).length))}</span></div>
        <div><strong>最近刷新</strong><span>${escapeHtml(formatTime(state.updatedAt))}</span></div>
      </div>
      <button class="secondary-button" type="button" data-action="toggle-debug">Debug</button>
    </aside>
  `;
}

function renderDebugPanel() {
  return `
    <aside class="h2o-inspector h2o-debug-panel">
      <h3>Debug</h3>
      <div class="detail-list">
        ${detail('State', state.broker.state)}
        ${detail('Scope', state.app.networkScope)}
        ${detail('Channel', state.app.standaloneChannelProductId)}
        ${detail('Package', state.app.packageName)}
        ${detail('Contract', state.app.manifest?.runtimeContractVersion || '-')}
        ${detail('Session', state.broker.session?.sessionId || '-')}
        ${detail('Socket', state.broker.channel?.socketPath || '-')}
        ${detail('Local IP', state.network.localIp || '-')}
        ${detail('Internal', state.network.internalApi)}
      </div>
      <div class="permission-list">
        ${(state.broker.session?.grantedCapabilities || state.broker.channel?.capabilities || []).map((item) => `<span>${escapeHtml(item)}</span>`).join('') || '<span>pending</span>'}
      </div>
      <button class="secondary-button" type="button" data-action="toggle-debug">关闭 Debug</button>
    </aside>
  `;
}

function renderRuntime() {
  return `
    <section class="h2o-grid">
      ${metricCard('连接状态', state.broker.ok ? '已就绪' : '未连接')}
      ${metricCard('代理模式', modeLabel(state.policy.mode))}
      ${metricCard('规则数量', String((state.rules || []).length))}
      ${metricCard('Internal', state.network.internalApi === 'ready' ? '可访问' : '待检查')}
    </section>
    <section class="h2o-panel">
      <div class="panel-head">
        <div>
          <h3>流量模式</h3>
          <p>Home To Oversea policy</p>
        </div>
        <button class="secondary-button" type="button" data-action="request-proxy">应用</button>
      </div>
      <div class="mode-segments">
        ${modeButton('rule', '规则')}
        ${modeButton('global', '全局')}
        ${modeButton('direct', '直连')}
      </div>
    </section>
    ${renderRuleTable()}
  `;
}

function renderProxy() {
  return `
    <section class="h2o-panel">
      <div class="panel-head">
        <div>
          <h3>代理</h3>
          <p>${escapeHtml(modeLabel(state.policy.mode))}</p>
        </div>
        <button class="primary-button" type="button" data-action="request-proxy">应用</button>
      </div>
      <div class="h2o-grid">
        ${metricCard('端口', String(state.policy.proxyPort))}
        ${metricCard('状态', state.broker.ok ? '已连接' : '未连接')}
        ${metricCard('模式', modeLabel(state.policy.mode))}
        ${metricCard('Internal', state.network.internalApi === 'ready' ? '可访问' : '待检查')}
      </div>
    </section>
    ${renderRuleTable()}
  `;
}

function renderDns() {
  return `
    <section class="h2o-panel">
      <div class="panel-head">
        <div>
          <h3>DNS / PAC</h3>
          <p>Split DNS and PAC</p>
        </div>
        <button class="secondary-button" type="button" data-action="refresh">检查</button>
      </div>
      <div class="h2o-grid">
        ${metricCard('api.mxinfo-inc.cn', '10.88.88.88')}
        ${metricCard('DNS', '自动')}
        ${metricCard('PAC', '动态')}
        ${metricCard('解析器', '本机')}
      </div>
    </section>
  `;
}

function renderPermissions() {
  return `
    <section class="h2o-panel">
      <div class="panel-head">
        <div>
          <h3>Permissions</h3>
          <p>granted by MX-H2I broker</p>
        </div>
      </div>
      <div class="permission-list is-large">
        ${(state.broker.session?.grantedCapabilities || []).map((item) => `<span>${escapeHtml(item)}</span>`).join('') || '<span>Connect broker first</span>'}
      </div>
    </section>
  `;
}

function renderLogs() {
  return `
    <section class="h2o-panel">
      <div class="panel-head">
        <div>
          <h3>Activity</h3>
          <p>${escapeHtml(state.updatedAt)}</p>
        </div>
      </div>
      <div class="activity-list">
        ${(state.activity || []).map((item) => `<div><strong>${escapeHtml(item.type)}</strong><span>${escapeHtml(item.message)}</span><small>${escapeHtml(formatTime(item.at))}</small></div>`).join('') || '<p class="empty">No activity</p>'}
      </div>
    </section>
  `;
}

function renderRuleTable() {
  return `
    <section class="h2o-panel">
      <div class="panel-head">
        <div>
          <h3>规则</h3>
          <p>常用 Internal 服务</p>
        </div>
      </div>
      <div class="rule-table">
        ${(state.rules || []).map((rule) => `
          <div>
            <strong>${escapeHtml(rule.host)}</strong>
            <span>${escapeHtml(rule.target)}</span>
            <em>${escapeHtml(rule.policy)}</em>
          </div>
        `).join('')}
      </div>
    </section>
  `;
}

function navItem(id, label) {
  return `<button class="${view === id ? 'is-active' : ''}" type="button" data-action="set-view" data-view="${escapeAttr(id)}">${escapeHtml(label)}</button>`;
}

function modeButton(mode, label) {
  return `<button class="${state.policy.mode === mode ? 'is-active' : ''}" type="button" data-action="set-mode" data-mode="${escapeAttr(mode)}">${escapeHtml(label)}</button>`;
}

function modeLabel(mode) {
  if (mode === 'global') return '全局';
  if (mode === 'direct') return '直连';
  return '规则';
}

function metricCard(label, value) {
  return `<article class="metric-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || '-')}</strong></article>`;
}

function detail(label, value) {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || '-')}</strong></div>`;
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleTimeString('zh-CN', { hour12: false });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function createMockApi() {
  let mock = {
    app: {
      appId: 'h2o',
      displayName: 'H2O',
      fullName: 'Home To Oversea',
      description: 'AppCenter 内置的 Home To Oversea 网络插件，提供类 Clash 的代理模式、PAC、Split DNS 和 Internal 出海状态面板。',
      packageName: '@qpjoy/electron-launcher-app-h2o',
      version: '0.1.0',
      launcherMode: 'embed',
      standaloneChannelProductId: 'mx-h2i',
      networkScope: 'broker-session',
      manifest: {
        appId: 'h2o',
        productId: 'h2o',
        displayName: 'H2O',
        description: 'AppCenter 内置的 Home To Oversea 网络插件，提供类 Clash 的代理模式、PAC、Split DNS 和 Internal 出海状态面板。',
        packageName: '@qpjoy/electron-launcher-app-h2o',
        launcherMode: 'embed',
        runtimeContractVersion: '0.1',
        requiredCapabilities: ['user.session', 'network.status', 'network.proxy', 'network.dns.policy', 'network.pac.policy', 'app-center-runtime'],
        network: { scope: 'broker-session' },
        embed: { standaloneChannelProductId: 'mx-h2i', launchWithoutBroker: 'blocked' }
      }
    },
    broker: {
      state: 'network-ready',
      ok: true,
      message: 'Connected to MX-H2I mock broker.',
      session: {
        sessionId: 'embed_h2o_mock',
        grantedCapabilities: ['user.session', 'network.status', 'network.proxy', 'network.dns.policy', 'network.pac.policy', 'app-center-runtime']
      },
      channel: { socketPath: '~/.qpjoy/mx-launcher/sockets/mx-h2i.sock' },
      missingCapabilities: []
    },
    policy: { mode: 'rule', pac: 'dynamic-split', dns: 'internal-first', proxyPort: 2053, profile: 'home-to-oversea' },
    network: { localIp: '10.89.100.12', routePolicy: 'guest limited', internalApi: 'ready', splitDns: 'internal-first', pac: 'dynamic-split', profile: 'home-to-oversea' },
    rules: [
      { id: 'internal-api', host: 'api.mxinfo-inc.cn', target: '10.88.88.88', policy: 'internal-direct' },
      { id: 'appcenter', host: 'appcenter.mxinfo-inc.cn', target: 'mx-h2i broker', policy: 'broker-session' },
      { id: 'oversea-default', host: '*.oversea', target: 'system proxy', policy: 'home-to-oversea' }
    ],
    activity: [],
    updatedAt: new Date().toISOString()
  };
  const commit = (patch) => {
    mock = { ...mock, ...patch, updatedAt: new Date().toISOString() };
    return JSON.parse(JSON.stringify(mock));
  };
  return {
    getState: async () => JSON.parse(JSON.stringify(mock)),
    connectBroker: async () => commit({ broker: { ...mock.broker, state: 'network-ready', ok: true, message: 'Connected to MX-H2I mock broker.' } }),
    refresh: async () => commit({ network: { ...mock.network, internalApi: 'ready', localIp: '10.89.100.12' } }),
    setMode: async (mode) => commit({ policy: { ...mock.policy, mode }, activity: [{ type: 'policy.mode', message: `Mode switched to ${mode}`, at: new Date().toISOString() }, ...mock.activity] }),
    requestBroker: async (name, payload) => ({ state: commit({ activity: [{ type: name, message: JSON.stringify(payload || {}), at: new Date().toISOString() }, ...mock.activity] }), result: { ok: true } }),
    onState: () => () => {}
  };
}
