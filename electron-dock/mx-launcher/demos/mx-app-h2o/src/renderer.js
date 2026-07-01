const electronApi = window.h2o || null;
const api = electronApi || createMockApi();
const root = document.getElementById('app');

let state = null;
let busy = '';
let view = 'runtime';

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
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'set-view') {
    view = button.dataset.view || 'runtime';
    render();
    return;
  }
  if (action === 'set-mode') {
    void run('setMode', button.dataset.mode || 'rule');
    return;
  }
  if (action === 'request-proxy') {
    void run('requestBroker', 'network.proxy', { mode: state.policy.mode });
    return;
  }
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
    <section class="h2o-shell">
      <aside class="h2o-sidebar">
        <div class="h2o-brand">
          <div class="h2o-mark">H2O</div>
          <div>
            <h1>H2O</h1>
            <p>${escapeHtml(state.app.packageName)}</p>
          </div>
        </div>
        <nav class="h2o-nav">
          ${navItem('runtime', 'Runtime')}
          ${navItem('proxy', 'Proxy')}
          ${navItem('dns', 'DNS / PAC')}
          ${navItem('permissions', 'Permissions')}
          ${navItem('logs', 'Logs')}
        </nav>
        <div class="h2o-version">
          <span>App ${escapeHtml(state.app.version)}</span>
          <span>Embed via ${escapeHtml(state.app.standaloneChannelProductId)}</span>
        </div>
      </aside>

      <section class="h2o-main">
        <header class="h2o-toolbar">
          <div>
            <p class="kicker">MX-H2I EMBED APP</p>
            <h2>Network Console</h2>
          </div>
          <div class="toolbar-actions">
            <button class="secondary-button" type="button" data-action="connectBroker" ${busy === 'connectBroker' ? 'disabled' : ''}>
              ${connected ? 'Reconnect' : 'Connect Broker'}
            </button>
            <button class="primary-button" type="button" data-action="refresh" ${!connected || busy === 'refresh' ? 'disabled' : ''}>Refresh</button>
          </div>
        </header>

        <section class="h2o-status-strip" data-state="${escapeAttr(state.broker.state)}">
          <strong>${escapeHtml(state.broker.state)}</strong>
          <span>${escapeHtml(state.broker.message)}</span>
        </section>

        ${renderView()}
      </section>

      <aside class="h2o-inspector">
        <h3>Broker Session</h3>
        <div class="detail-list">
          ${detail('State', state.broker.state)}
          ${detail('Scope', state.app.networkScope)}
          ${detail('Channel', state.app.standaloneChannelProductId)}
          ${detail('Session', state.broker.session?.sessionId || '-')}
          ${detail('Socket', state.broker.channel?.socketPath || '-')}
          ${detail('Local IP', state.network.localIp || '-')}
          ${detail('Internal', state.network.internalApi)}
        </div>
        <div class="permission-list">
          ${(state.broker.session?.grantedCapabilities || state.broker.channel?.capabilities || []).map((item) => `<span>${escapeHtml(item)}</span>`).join('') || '<span>pending</span>'}
        </div>
      </aside>
    </section>
  `;
}

function renderView() {
  if (view === 'proxy') return renderProxy();
  if (view === 'dns') return renderDns();
  if (view === 'permissions') return renderPermissions();
  if (view === 'logs') return renderLogs();
  return renderRuntime();
}

function renderRuntime() {
  return `
    <section class="h2o-grid">
      ${metricCard('Route Policy', state.network.routePolicy)}
      ${metricCard('Split DNS', state.network.splitDns)}
      ${metricCard('PAC', state.network.pac)}
      ${metricCard('Proxy Port', String(state.policy.proxyPort))}
    </section>
    <section class="h2o-panel">
      <div class="panel-head">
        <div>
          <h3>Traffic Mode</h3>
          <p>broker controlled proxy surface</p>
        </div>
        <button class="secondary-button" type="button" data-action="request-proxy">Apply</button>
      </div>
      <div class="mode-segments">
        ${modeButton('rule', 'Rule')}
        ${modeButton('global', 'Global')}
        ${modeButton('direct', 'Direct')}
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
          <h3>Proxy Runtime</h3>
          <p>${escapeHtml(state.policy.mode)} / ${escapeHtml(state.network.routePolicy)}</p>
        </div>
        <button class="primary-button" type="button" data-action="request-proxy">Apply Proxy</button>
      </div>
      <div class="h2o-grid">
        ${metricCard('Mixed Port', String(state.policy.proxyPort))}
        ${metricCard('Broker', state.broker.ok ? 'connected' : 'blocked')}
        ${metricCard('Scope', state.app.networkScope)}
        ${metricCard('Channel', state.app.standaloneChannelProductId)}
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
          <h3>DNS / PAC Policy</h3>
          <p>${escapeHtml(state.policy.dns)} / ${escapeHtml(state.policy.pac)}</p>
        </div>
        <button class="secondary-button" type="button" data-action="refresh">Probe</button>
      </div>
      <div class="h2o-grid">
        ${metricCard('api.mxinfo-inc.cn', '10.88.88.88')}
        ${metricCard('DNS Mode', state.policy.dns)}
        ${metricCard('PAC Mode', state.policy.pac)}
        ${metricCard('Resolver', '127.0.0.1:2053')}
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
          <h3>Rules</h3>
          <p>host policies resolved through broker-session</p>
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
      packageName: '@qpjoy/electron-launcher-app-h2o',
      version: '0.1.0',
      launcherMode: 'embed',
      standaloneChannelProductId: 'mx-h2i',
      networkScope: 'broker-session'
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
    policy: { mode: 'rule', pac: 'dynamic-split', dns: 'internal-first', proxyPort: 2053 },
    network: { localIp: '10.89.100.12', routePolicy: 'guest limited', internalApi: 'ready', splitDns: 'internal-first', pac: 'dynamic-split' },
    rules: [
      { id: 'internal-api', host: 'api.mxinfo-inc.cn', target: '10.88.88.88', policy: 'internal' },
      { id: 'appcenter', host: 'appcenter.mxinfo-inc.cn', target: 'mx-h2i broker', policy: 'broker-session' },
      { id: 'public-docs', host: 'docs.qpjoy.local', target: 'system proxy', policy: 'fallback' }
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
