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
    void run('setMode', button.dataset.mode || 'app-rule');
    return;
  }
  if (action === 'start-runtime') {
    shellMenuOpen = false;
    void run('startRuntime');
    return;
  }
  if (action === 'stop-runtime') {
    shellMenuOpen = false;
    void run('stopRuntime');
    return;
  }
  if (action === 'install-tun') {
    shellMenuOpen = false;
    void run('installTun');
    return;
  }
  if (action === 'uninstall-tun') {
    shellMenuOpen = false;
    void run('uninstallTun');
    return;
  }
  if (action === 'save-ports') {
    shellMenuOpen = false;
    void run('setPorts', readPortFields());
    return;
  }
  if (action === 'add-demo-subscription') {
    shellMenuOpen = false;
    void run('addSubscription', {
      name: 'Oversea backup policy',
      url: 'mx-h2i://managed/home-to-oversea-backup'
    });
    return;
  }
  if (action === 'set-active-subscription') {
    shellMenuOpen = false;
    void run('setActiveSubscription', button.dataset.subscriptionId || '');
    return;
  }
  if (action === 'refresh-subscription') {
    shellMenuOpen = false;
    void run('refreshSubscription', button.dataset.subscriptionId || '');
    return;
  }
  if (action === 'toggle-rule') {
    shellMenuOpen = false;
    void run('toggleRule', button.dataset.ruleId || '');
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
      startRuntime: () => api.startRuntime(),
      stopRuntime: () => api.stopRuntime(),
      installTun: () => api.installTun(),
      uninstallTun: () => api.uninstallTun(),
      setPorts: (input) => api.setPorts(input),
      addSubscription: (input) => api.addSubscription(input),
      setActiveSubscription: (subscriptionId) => api.setActiveSubscription(subscriptionId),
      refreshSubscription: (subscriptionId) => api.refreshSubscription(subscriptionId),
      toggleRule: (ruleId) => api.toggleRule(ruleId),
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
          ${navItem('subscriptions', '订阅')}
          ${navItem('rules', '规则')}
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
  if (view === 'subscriptions') return renderSubscriptions();
  if (view === 'rules') return renderRules();
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
        <div><strong>引擎</strong><span>${escapeHtml(state.engine?.running ? '运行中' : runtimeStatusLabel(state.engine?.status))}</span></div>
        <div><strong>订阅</strong><span>${escapeHtml(activeSubscription()?.name || '未选择')}</span></div>
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
        ${detail('Engine', state.engine?.status || '-')}
        ${detail('TUN', state.engine?.tunInstalled ? 'installed' : 'missing')}
        ${detail('Mixed', `:${state.ports?.mixed || '-'}`)}
        ${detail('DNS', `:${state.ports?.dns || '-'}`)}
      </div>
      <div class="permission-list">
        ${(state.broker.session?.grantedCapabilities || state.broker.channel?.capabilities || []).map((item) => `<span>${escapeHtml(item)}</span>`).join('') || '<span>pending</span>'}
      </div>
      <button class="secondary-button" type="button" data-action="toggle-debug">关闭 Debug</button>
    </aside>
  `;
}

function renderRuntime() {
  const running = state.engine?.running === true;
  const active = activeSubscription();
  return `
    <section class="h2o-grid">
      ${metricCard('引擎', running ? '运行中' : runtimeStatusLabel(state.engine?.status))}
      ${metricCard('代理模式', modeLabel(state.policy.mode))}
      ${metricCard('订阅', active?.name || '未选择')}
      ${metricCard('Internal', state.network.internalApi === 'ready' ? '可访问' : '待检查')}
    </section>
    <section class="h2o-panel">
      <div class="panel-head">
        <div>
          <h3>Home To Oversea</h3>
          <p>${escapeHtml(running ? '当前策略已由 MX-H2I broker 托管' : '启动后接管当前应用的出海策略')}</p>
        </div>
        <div class="toolbar-actions">
          <button class="secondary-button" type="button" data-action="request-proxy" ${!running ? 'disabled' : ''}>应用策略</button>
          <button class="${running ? 'secondary-button' : 'primary-button'}" type="button" data-action="${running ? 'stop-runtime' : 'start-runtime'}" ${busy === 'startRuntime' || busy === 'stopRuntime' ? 'disabled' : ''}>
            ${running ? '停止' : '启动'}
          </button>
        </div>
      </div>
      <div class="mode-segments">
        ${modeButton('app-rule', '规则')}
        ${modeButton('app-global', '全局')}
        ${modeButton('system-tun', 'TUN')}
        ${modeButton('direct', '直连')}
      </div>
      ${state.engine?.status === 'tun-required' ? '<p class="h2o-warning">TUN 模式需要先安装虚拟网卡助手。可以在“代理”页安装，或切回规则模式。</p>' : ''}
    </section>
    <section class="h2o-panel h2o-managed-card">
      <div class="panel-head">
        <div>
          <h3>当前订阅</h3>
          <p>${escapeHtml(active?.url || '由 MX-H2I managed profile 提供')}</p>
        </div>
        <button class="secondary-button" type="button" data-action="refresh-subscription" data-subscription-id="${escapeAttr(active?.id || '')}">刷新</button>
      </div>
      <div class="h2o-grid is-compact">
        ${metricCard('节点', String(active?.nodes || 0))}
        ${metricCard('延迟', active ? `${active.latencyMs} ms` : '-')}
        ${metricCard('规则', String((state.rules || []).filter((rule) => rule.enabled !== false).length))}
        ${metricCard('端口', `:${state.ports?.mixed || state.policy.proxyPort}`)}
      </div>
    </section>
    ${renderRules({ compact: true })}
  `;
}

function renderProxy() {
  const running = state.engine?.running === true;
  return `
    <section class="h2o-panel">
      <div class="panel-head">
        <div>
          <h3>代理</h3>
          <p>${escapeHtml(modeLabel(state.policy.mode))} / ${escapeHtml(runtimeStatusLabel(state.engine?.status))}</p>
        </div>
        <div class="toolbar-actions">
          <button class="${running ? 'secondary-button' : 'primary-button'}" type="button" data-action="${running ? 'stop-runtime' : 'start-runtime'}">
            ${running ? '停止' : '启动'}
          </button>
          <button class="primary-button" type="button" data-action="request-proxy" ${!running ? 'disabled' : ''}>切换</button>
        </div>
      </div>
      <div class="mode-segments">
        ${modeButton('app-rule', 'App 规则')}
        ${modeButton('app-global', 'App 全局')}
        ${modeButton('system-tun', '系统 TUN')}
        ${modeButton('direct', '直连')}
      </div>
    </section>
    <section class="h2o-panel">
      <div class="panel-head">
        <div>
          <h3>TUN 助手</h3>
          <p>${escapeHtml(state.engine?.tunInstalled ? '已安装，可以启用系统 TUN 模式' : '仅系统 TUN 模式需要安装')}</p>
        </div>
        <button class="secondary-button" type="button" data-action="${state.engine?.tunInstalled ? 'uninstall-tun' : 'install-tun'}">
          ${state.engine?.tunInstalled ? '卸载 TUN' : '安装 TUN'}
        </button>
      </div>
      <div class="h2o-grid">
        ${metricCard('Mixed', `:${state.ports?.mixed || '-'}`)}
        ${metricCard('DNS', `:${state.ports?.dns || '-'}`)}
        ${metricCard('Controller', `:${state.ports?.controller || '-'}`)}
        ${metricCard('Admin', `:${state.ports?.admin || '-'}`)}
      </div>
      <div class="port-editor">
        ${portField('mixed', state.ports?.mixed)}
        ${portField('dns', state.ports?.dns)}
        ${portField('controller', state.ports?.controller)}
        ${portField('admin', state.ports?.admin)}
        <button class="secondary-button" type="button" data-action="save-ports">保存端口</button>
      </div>
    </section>
  `;
}

function renderSubscriptions() {
  const subscriptions = state.subscriptions || [];
  return `
    <section class="h2o-panel">
      <div class="panel-head">
        <div>
          <h3>订阅</h3>
          <p>Managed profile / local fallback</p>
        </div>
        <button class="secondary-button" type="button" data-action="add-demo-subscription">添加示例</button>
      </div>
      <div class="subscription-list">
        ${subscriptions.map((item) => `
          <article class="${item.id === state.engine?.activeSubscriptionId ? 'is-active' : ''}">
            <div>
              <strong>${escapeHtml(item.name)}</strong>
              <span>${escapeHtml(item.url)}</span>
            </div>
            <div class="subscription-meta">
              <span>${escapeHtml(String(item.nodes || 0))} nodes</span>
              <span>${escapeHtml(String(item.latencyMs || '-'))} ms</span>
              <span>${escapeHtml(formatTime(item.lastUpdatedAt))}</span>
            </div>
            <div class="toolbar-actions">
              <button class="secondary-button" type="button" data-action="refresh-subscription" data-subscription-id="${escapeAttr(item.id)}">刷新</button>
              <button class="primary-button" type="button" data-action="set-active-subscription" data-subscription-id="${escapeAttr(item.id)}" ${item.id === state.engine?.activeSubscriptionId ? 'disabled' : ''}>使用</button>
            </div>
          </article>
        `).join('') || '<p class="empty">暂无订阅</p>'}
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

function renderRules(options = {}) {
  return `
    <section class="h2o-panel">
      <div class="panel-head">
        <div>
          <h3>规则</h3>
          <p>${options.compact ? '常用 Internal 服务' : 'Internal direct / broker session / oversea policy'}</p>
        </div>
      </div>
      <div class="rule-table">
        ${(state.rules || []).map((rule) => `
          <div class="${rule.enabled === false ? 'is-disabled' : ''}">
            <strong>${escapeHtml(rule.host)}</strong>
            <span>${escapeHtml(rule.target)}</span>
            <em>${escapeHtml(rule.policy)}</em>
            ${options.compact ? '' : `<button class="secondary-button" type="button" data-action="toggle-rule" data-rule-id="${escapeAttr(rule.id)}">${rule.enabled === false ? '启用' : '停用'}</button>`}
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
  if (mode === 'global' || mode === 'app-global') return '全局';
  if (mode === 'system-tun') return '系统 TUN';
  if (mode === 'direct') return '直连';
  return '规则';
}

function runtimeStatusLabel(status) {
  if (state.engine?.running) return '运行中';
  if (status === 'tun-required') return '等待 TUN';
  if (status === 'ready') return '就绪';
  if (status === 'error') return '异常';
  return '未启动';
}

function activeSubscription() {
  const rows = state.subscriptions || [];
  return rows.find((item) => item.id === state.engine?.activeSubscriptionId) || rows[0] || null;
}

function metricCard(label, value) {
  return `<article class="metric-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || '-')}</strong></article>`;
}

function detail(label, value) {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || '-')}</strong></div>`;
}

function portField(name, value) {
  const label = name === 'mixed' ? 'Mixed' : name === 'dns' ? 'DNS' : name === 'controller' ? 'Controller' : 'Admin';
  return `
    <label>
      <span>${escapeHtml(label)}</span>
      <input data-port-field="${escapeAttr(name)}" inputmode="numeric" value="${escapeAttr(String(value || ''))}" />
    </label>
  `;
}

function readPortFields() {
  const result = {};
  for (const input of root.querySelectorAll('[data-port-field]')) {
    result[input.dataset.portField] = Number(input.value || 0);
  }
  return result;
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
    policy: { mode: 'app-rule', pac: 'dynamic-split', dns: 'internal-first', proxyPort: 23458, profile: 'home-to-oversea' },
    engine: {
      running: false,
      status: 'ready',
      mode: 'app-rule',
      tunInstalled: false,
      activeSubscriptionId: 'h2o-default',
      startedAt: null,
      adminUrl: 'http://127.0.0.1:23456',
      core: 'h2o-shim',
      coreVersion: '0.1.0'
    },
    ports: { admin: 23456, controller: 23457, mixed: 23458, dns: 1053 },
    network: { localIp: '10.89.100.12', routePolicy: 'guest limited', internalApi: 'ready', splitDns: 'internal-first', pac: 'dynamic-split', profile: 'home-to-oversea' },
    subscriptions: [
      { id: 'h2o-default', name: 'Home To Oversea 默认策略', url: 'mx-h2i://managed/home-to-oversea', nodes: 6, latencyMs: 42, status: 'ready', lastUpdatedAt: new Date().toISOString() }
    ],
    rules: [
      { id: 'internal-api', host: 'api.mxinfo-inc.cn', target: '10.88.88.88', policy: 'internal-direct', enabled: true, source: 'builtin' },
      { id: 'appcenter', host: 'appcenter.mxinfo-inc.cn', target: 'mx-h2i broker', policy: 'broker-session', enabled: true, source: 'builtin' },
      { id: 'oversea-default', host: '*.oversea', target: 'system proxy', policy: 'home-to-oversea', enabled: true, source: 'managed' }
    ],
    metrics: { uploadBytes: 0, downloadBytes: 0, lastProxyAppliedAt: null },
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
    setMode: async (mode) => commit({
      policy: { ...mock.policy, mode },
      engine: { ...mock.engine, mode, status: mode === 'system-tun' && !mock.engine.tunInstalled ? 'tun-required' : mock.engine.running ? 'running' : 'ready' },
      activity: [{ type: 'policy.mode', level: 'info', message: `Mode switched to ${mode}`, at: new Date().toISOString() }, ...mock.activity]
    }),
    startRuntime: async () => commit({
      engine: mock.policy.mode === 'system-tun' && !mock.engine.tunInstalled
        ? { ...mock.engine, running: false, status: 'tun-required' }
        : { ...mock.engine, running: true, status: 'running', startedAt: mock.engine.startedAt || new Date().toISOString() },
      activity: [{ type: 'runtime.start', level: 'info', message: 'H2O proxy runtime started.', at: new Date().toISOString() }, ...mock.activity]
    }),
    stopRuntime: async () => commit({
      engine: { ...mock.engine, running: false, status: 'stopped', startedAt: null },
      activity: [{ type: 'runtime.stop', level: 'info', message: 'H2O proxy runtime stopped.', at: new Date().toISOString() }, ...mock.activity]
    }),
    installTun: async () => commit({
      engine: { ...mock.engine, tunInstalled: true, status: mock.engine.running ? 'running' : 'ready' },
      activity: [{ type: 'tun.install', level: 'info', message: 'TUN helper installed.', at: new Date().toISOString() }, ...mock.activity]
    }),
    uninstallTun: async () => commit({
      policy: { ...mock.policy, mode: mock.policy.mode === 'system-tun' ? 'app-rule' : mock.policy.mode },
      engine: { ...mock.engine, tunInstalled: false, mode: mock.engine.mode === 'system-tun' ? 'app-rule' : mock.engine.mode, status: mock.engine.running ? 'running' : 'ready' },
      activity: [{ type: 'tun.uninstall', level: 'info', message: 'TUN helper removed.', at: new Date().toISOString() }, ...mock.activity]
    }),
    setPorts: async (input) => commit({
      ports: { ...mock.ports, ...input },
      policy: { ...mock.policy, proxyPort: Number(input?.mixed || mock.ports.mixed) },
      activity: [{ type: 'ports.save', level: 'info', message: 'Ports saved.', at: new Date().toISOString() }, ...mock.activity]
    }),
    addSubscription: async (input) => {
      const id = `sub-${Date.now().toString(36)}`;
      const row = { id, name: input?.name || 'Managed subscription', url: input?.url || 'mx-h2i://managed/custom', nodes: 3, latencyMs: 58, status: 'ready', lastUpdatedAt: new Date().toISOString() };
      return commit({
        subscriptions: [row, ...mock.subscriptions],
        engine: { ...mock.engine, activeSubscriptionId: id },
        activity: [{ type: 'subscription.add', level: 'info', message: `Subscription added: ${row.name}`, at: new Date().toISOString() }, ...mock.activity]
      });
    },
    setActiveSubscription: async (subscriptionId) => commit({
      engine: { ...mock.engine, activeSubscriptionId: subscriptionId },
      activity: [{ type: 'subscription.active', level: 'info', message: `Active subscription switched to ${subscriptionId}`, at: new Date().toISOString() }, ...mock.activity]
    }),
    refreshSubscription: async (subscriptionId) => commit({
      subscriptions: mock.subscriptions.map((item) => item.id === subscriptionId ? { ...item, latencyMs: 36, lastUpdatedAt: new Date().toISOString() } : item),
      activity: [{ type: 'subscription.refresh', level: 'info', message: `Subscription refreshed: ${subscriptionId || mock.engine.activeSubscriptionId}`, at: new Date().toISOString() }, ...mock.activity]
    }),
    toggleRule: async (ruleId) => commit({
      rules: mock.rules.map((rule) => rule.id === ruleId ? { ...rule, enabled: rule.enabled === false } : rule),
      activity: [{ type: 'rule.toggle', level: 'info', message: `Rule toggled: ${ruleId}`, at: new Date().toISOString() }, ...mock.activity]
    }),
    requestBroker: async (name, payload) => ({ state: commit({ activity: [{ type: name, message: JSON.stringify(payload || {}), at: new Date().toISOString() }, ...mock.activity] }), result: { ok: true } }),
    onState: () => () => {}
  };
}
