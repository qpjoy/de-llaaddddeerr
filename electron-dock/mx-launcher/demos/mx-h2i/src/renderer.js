const electronApi = window.mxH2i || null;
const api = electronApi || createMockApi();
const root = document.getElementById('app');

let state = null;
let busyAction = '';
let screen = 'launcher';
let modeDraft = 'guest';
let windowDrag = null;
let appSearch = '';
let appCategory = 'all';
let selectedAppId = 'h2o';

void boot();

async function boot() {
  state = await api.getState();
  modeDraft = state.connection?.mode === 'employee' ? 'employee' : 'guest';
  render();
  if (typeof api.onState === 'function') {
    api.onState((next) => {
      state = next;
      render();
    });
  }
}

root.addEventListener('click', (event) => {
  const control = event.target.closest('[data-window-control]');
  if (control) {
    void api.windowControl?.(control.dataset.windowControl);
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'select-mode') {
    modeDraft = button.dataset.mode === 'employee' ? 'employee' : 'guest';
    render();
    return;
  }
  if (action === 'show-launcher') {
    void setScreen('launcher');
    return;
  }
  if (action === 'show-advanced') {
    void setScreen('advanced');
    return;
  }
  if (action === 'show-appcenter') {
    if (state.apps?.appcenter?.installed) {
      void setScreen('appcenter');
    } else {
      void runAction('installAppCenter');
    }
    return;
  }
  if (action === 'select-app') {
    selectedAppId = button.dataset.appId || selectedAppId;
    render();
    return;
  }
  if (action === 'set-app-category') {
    appCategory = button.dataset.category || 'all';
    render();
    return;
  }
  void runAction(action);
});

root.addEventListener('input', (event) => {
  const input = event.target.closest('[data-app-search]');
  if (!input) return;
  appSearch = input.value || '';
  render();
});

root.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  const action = form.dataset.formAction;
  if (action === 'save-config') {
    void runAction(action, readConfigForm(form));
  }
  if (action === 'login-employee') {
    const payload = Object.fromEntries(new FormData(form).entries());
    void runAction(action, {
      account: String(payload.account || ''),
      password: String(payload.password || '')
    });
  }
});

root.addEventListener('pointerdown', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target || event.button !== 0) return;
  if (target.closest('button,input,select,a')) return;
  const dragHandle = target.closest('[data-window-drag]');
  if (!dragHandle || typeof api.moveWindowBy !== 'function') return;
  windowDrag = {
    pointerId: event.pointerId,
    screenX: event.screenX,
    screenY: event.screenY,
    startScreenY: event.screenY,
    totalDy: 0
  };
  dragHandle.setPointerCapture?.(event.pointerId);
  document.body.classList.add('is-window-dragging');
  event.preventDefault();
});

window.addEventListener('pointermove', (event) => {
  if (!windowDrag || event.pointerId !== windowDrag.pointerId) return;
  const dx = Math.round(event.screenX - windowDrag.screenX);
  const dy = Math.round(event.screenY - windowDrag.screenY);
  if (!dx && !dy) return;
  windowDrag.screenX = event.screenX;
  windowDrag.screenY = event.screenY;
  windowDrag.totalDy = Math.round(event.screenY - windowDrag.startScreenY);
  void api.moveWindowBy?.({ dx, dy, totalDy: windowDrag.totalDy });
  event.preventDefault();
});

window.addEventListener('pointerup', finishWindowDrag);
window.addEventListener('pointercancel', finishWindowDrag);
root.addEventListener('mouseleave', () => {
  if (!windowDrag) void api.hideTopDockIfPending?.();
});

function finishWindowDrag(event) {
  if (!windowDrag) return;
  if (event && windowDrag && event.pointerId !== windowDrag.pointerId) return;
  const totalDy = windowDrag.totalDy;
  windowDrag = null;
  document.body.classList.remove('is-window-dragging');
  void api.finishWindowDrag?.({ totalDy });
}

async function runAction(action, payload) {
  if (busyAction) return;
  busyAction = action;
  render();
  try {
    const handlers = {
      connectGuest: () => api.connectGuest(),
      disconnect: () => api.disconnect(),
      'login-employee': () => api.loginEmployee(payload),
      'save-config': () => api.saveConfig(payload),
      installAppCenter: () => api.installAppCenter(),
      enableH2o: () => api.enableH2o(),
      launchH2o: () => api.launchH2o?.() || api.enableH2o(),
      checkUpdates: () => api.checkUpdates(),
      refreshDiagnostics: () => api.refreshDiagnostics?.(),
      repairSystemNetwork: () => api.repairSystemNetwork?.(),
      openAdmin: () => api.openAdmin()
    };
    if (handlers[action]) {
      const next = await handlers[action]();
      if (next && typeof next === 'object' && 'connection' in next) state = next;
      if (action === 'installAppCenter' && state.apps?.appcenter?.installed) {
        await setScreen('appcenter');
      }
    }
  } finally {
    busyAction = '';
    render();
  }
}

async function setScreen(nextScreen) {
  screen = nextScreen;
  if (nextScreen === 'appcenter') {
    await api.setWindowMode?.('appcenter');
  } else {
    await api.setWindowMode?.('launcher');
  }
  render();
}

function render() {
  if (!state) return;
  const connected = state.connection?.state === 'connected';
  const leaseOnly = state.connection?.state === 'lease-only';
  const tunnelOnly = state.connection?.state === 'tunnel-only';
  const connecting = state.connection?.state === 'connecting';
  const degraded = ['server-unavailable', 'network-unavailable', 'forbidden'].includes(state.connection?.state);
  const shellClass = screen === 'appcenter' ? 'is-appcenter' : 'is-phone';
  root.innerHTML = `
    <div class="mx-shell ${shellClass}">
      ${screen === 'appcenter' ? '' : renderWindowChrome()}
      ${screen === 'appcenter' ? renderWorkbench(connected, connecting) : renderPhone(connected, connecting, leaseOnly, tunnelOnly, degraded)}
    </div>
  `;
}

function renderWindowChrome() {
  return `
    <div class="window-chrome" aria-label="Window controls">
      <div class="traffic-controls">
        <button class="traffic-dot is-close" type="button" data-window-control="close" aria-label="Close"></button>
        <button class="traffic-dot is-minimize" type="button" data-window-control="minimize" aria-label="Minimize"></button>
        <button class="traffic-dot is-zoom" type="button" data-window-control="zoom" aria-label="Zoom"></button>
      </div>
      <div class="top-drag-strip" data-window-drag="true" aria-hidden="true"><span></span></div>
    </div>
  `;
}

function renderPhone(connected, connecting, leaseOnly = false, tunnelOnly = false, degraded = false) {
  if (screen === 'advanced') return renderAdvancedPhone();
  const mode = modeDraft;
  const activeLease = connected || leaseOnly || tunnelOnly || degraded;
  const showEmployeeLogin = mode === 'employee' && (!connected || state.connection.mode !== 'employee');
  const modeTitle = connected
    ? showEmployeeLogin
      ? '员工模式'
      : `${state.connection.mode === 'employee' ? '员工' : '访客'}模式 已连接`
    : leaseOnly
      ? `${state.connection.mode === 'employee' ? '员工' : '访客'}模式 租约已保留`
      : tunnelOnly
        ? `${state.connection.mode === 'employee' ? '员工' : '访客'}模式 隧道待恢复`
        : degraded
          ? `${state.connection.mode === 'employee' ? '员工' : '访客'}模式 待恢复`
    : mode === 'employee'
      ? '员工模式'
      : '访客模式';
  return `
    <section class="mx-phone" aria-label="MX-H2I standalone launcher">
      <header class="phone-bar" data-window-drag="true">
        <button class="icon-button" type="button" data-action="show-launcher" aria-label="Back">‹</button>
        <div class="window-dots" aria-hidden="true"><span></span><span></span><span></span></div>
      </header>

      <section class="phone-hero">
        <div class="app-mark">H2I</div>
        <p class="kicker">MX-H2I</p>
        <h1>${escapeHtml(modeTitle)}</h1>
        <p>${escapeHtml(connectionCaption())}</p>
      </section>
      ${renderFeedback()}

      ${showEmployeeLogin ? renderEmployeeLogin(connecting) : renderGuestConnect(connected, connecting, activeLease && !connected)}
      ${renderConnectionStrip()}
      ${renderPhoneAppCenterAction(connected, connecting)}
    </section>
  `;
}

function renderGuestConnect(connected, connecting, leaseOnly = false) {
  const label = connected ? '断开连接' : connecting ? '连接中' : leaseOnly ? '重新连接' : '连接';
  const action = connected ? 'disconnect' : 'connectGuest';
  return `
    <section class="connect-panel">
      <button class="connect-dial ${connected && !leaseOnly ? 'is-connected' : ''}" type="button" data-action="${action}" ${connecting ? 'disabled' : ''}>
        <span>${escapeHtml(label)}</span>
      </button>
      <div class="connect-actions">
        <button class="text-button" type="button" data-action="select-mode" data-mode="employee">员工登录</button>
        <button class="text-button" type="button" data-action="checkUpdates">检查更新</button>
        <button class="text-button" type="button" data-action="show-advanced">高级选项</button>
      </div>
    </section>
  `;
}

function renderEmployeeLogin(connecting) {
  return `
    <form class="login-panel" data-form-action="login-employee">
      <label class="field">
        <span>账号</span>
        <input name="account" value="${escapeAttr(state.identity?.account || 'talentzhong@lilith.com')}" autocomplete="username" />
      </label>
      <label class="field">
        <span>密码</span>
        <input name="password" type="password" autocomplete="current-password" placeholder="Password" />
      </label>
      <button class="primary-button block-button" type="submit" ${connecting ? 'disabled' : ''}>
        ${connecting ? '连接中' : '连接'}
      </button>
      <button class="secondary-button block-button" type="button" data-action="connectGuest" ${connecting ? 'disabled' : ''}>
        使用飞书连接
      </button>
      <button class="text-button" type="button" data-action="select-mode" data-mode="guest">返回访客模式</button>
    </form>
  `;
}

function renderPhoneAppCenterAction(connected, connecting) {
  const installed = state.apps?.appcenter?.installed;
  return `
    <section class="phone-action-card">
      <div>
        <h2>AppCenter</h2>
        <p>${installed ? '宽屏桌面应用已就绪' : '安装后进入宽屏桌面应用'}</p>
      </div>
      <button class="primary-button" type="button" data-action="${installed ? 'show-appcenter' : 'installAppCenter'}" ${!connected || connecting || busyAction === 'installAppCenter' ? 'disabled' : ''}>
        ${installed ? '进入' : '安装'}
      </button>
    </section>
  `;
}

function renderAdvancedPhone() {
  return `
    <section class="mx-phone advanced-phone" aria-label="MX-H2I advanced options">
      <header class="phone-bar" data-window-drag="true">
        <button class="icon-button" type="button" data-action="show-launcher" aria-label="Back">‹</button>
        <div class="window-dots" aria-hidden="true"><span></span><span></span><span></span></div>
      </header>
      <section class="advanced-title">
        <p class="kicker">MX-H2I</p>
        <h1>高级选项</h1>
        <p>Launcher Foundation / endpoint / release</p>
      </section>
      ${renderFeedback()}
      <section class="advanced-list">
        ${renderAdvancedRow('指纹、人脸与密码', 'identity / device binding', '◎')}
        ${renderAdvancedRow('安全', 'permission broker / helper policy', '◆')}
        ${renderAdvancedRow('隐私保护', 'audit scope / token isolation', '◇')}
        ${renderAdvancedRow('应用设置', 'AppCenter / H2O embed defaults', '⚙')}
        ${renderAdvancedRow('更多设置', 'network, release, diagnostics', '…')}
      </section>
      ${renderWireGuardDiagnostics()}
      ${renderConfigForm()}
    </section>
  `;
}

function renderAdvancedRow(title, detail, icon) {
  return `
    <button class="advanced-row" type="button">
      <span class="advanced-row__icon">${escapeHtml(icon)}</span>
      <span>
        <strong>${escapeHtml(title)}</strong>
        <small>${escapeHtml(detail)}</small>
      </span>
      <span class="advanced-row__arrow">›</span>
    </button>
  `;
}

function renderConnectionStrip() {
  const connection = state.connection || {};
  const health = connection.health || {};
  return `
    <section class="connection-strip">
      <div>
        <span>本机 IP</span>
        <strong>${escapeHtml(connection.localIp || '未分配')}</strong>
      </div>
      <div>
        <span>Channel</span>
        <strong>mx-h2i</strong>
      </div>
      <div>
        <span>Internal</span>
        <strong>${escapeHtml(health.internalApi || 'idle')}</strong>
      </div>
    </section>
  `;
}

function renderWireGuardDiagnostics() {
  const connection = state.connection || {};
  const wireGuard = connection.wireGuard || {};
  const diagnostics = connection.diagnostics || {};
  const route = diagnostics.route || {};
  const endpointRoute = diagnostics.endpointRoute || {};
  const internalApi = diagnostics.internalApi || {};
  const directSync = diagnostics.internalDirectPeerSync || {};
  const peerSync = connection.domesticPeerSync || diagnostics.domesticPeerSync || {};
  const relayDiag = diagnostics.domesticRelayDiagnostics || {};
  const relaySummary = relayDiag.summary || {};
  const relayBlockedReasons = Array.isArray(relayDiag.blockedReasons) ? relayDiag.blockedReasons : [];
  const relayFailures = Array.isArray(relayDiag.failures) ? relayDiag.failures : [];
  const directSyncFailures = directSync.status === 'skipped' ? [] : (Array.isArray(directSync.failures) ? directSync.failures : []);
  const directSyncStatus = directSync.status === 'skipped' && directSync.message ? 'relay fallback' : (directSync.status || '-');
  const networkEnvironment = diagnostics.networkEnvironment || {};
  const resolution = networkEnvironment.resolution || {};
  const resolutionAddresses = Array.isArray(resolution.addresses)
    ? resolution.addresses.map((row) => `${row.address || '-'} ${row.classification || ''}`.trim()).join(', ')
    : '';
  const systemProxy = networkEnvironment.systemDomainProxy || diagnostics.systemDomainProxy || {};
  const launchDaemon = wireGuard.launchDaemon || {};
  const launchDaemonStatus = launchDaemon.supported
    ? (launchDaemon.running ? 'running' : launchDaemon.loaded ? 'loaded' : launchDaemon.installed ? 'installed' : 'missing')
    : '-';
  return `
    <section class="settings-panel">
      <div class="panel-head">
        <div>
          <h2>WireGuard 诊断</h2>
          <p>route proof / overlay health</p>
        </div>
        <div class="toolbar-actions">
          <button class="secondary-button" type="button" data-action="repairSystemNetwork" ${busyAction === 'repairSystemNetwork' ? 'disabled' : ''}>修复网络</button>
          <button class="secondary-button" type="button" data-action="refreshDiagnostics" ${busyAction === 'refreshDiagnostics' ? 'disabled' : ''}>重新诊断</button>
        </div>
      </div>
      <div class="metric-grid">
        ${metric('WG', connection.health?.wireGuard || 'idle')}
        ${metric('Path', pathLabel(wireGuard.path || connection.routePlan?.preferredPath))}
        ${metric('DNS Phase', networkEnvironment.phase || '-')}
        ${metric('DNS Host', networkEnvironment.host || '-')}
        ${metric('Resolved', compactText(resolutionAddresses, 90))}
        ${metric('Resolution', resolution.state ? `${resolution.state} / ${resolution.severity || '-'}` : '-')}
        ${metric('System PAC', systemProxy.applied ? `on / ${systemProxy.systemResolverMode || '-'}` : 'off')}
        ${metric('Direct Sync', directSyncStatus)}
        ${metric('Peer Sync', peerSync.status || '-')}
        ${metric('Relay', relayDiag.status || '-')}
        ${metric('IP Forward', relaySummary.ipForward || '-')}
        ${metric('Relay FORWARD', relaySummary.firewallForward || '-')}
        ${metric('Relay Docker', relaySummary.firewallDockerUser || '-')}
        ${metric('Interface', wireGuard.realInterfaceName || wireGuard.interfaceName || '-')}
        ${metric('Expected', route.expectedInterfaceName || wireGuard.realInterfaceName || '-')}
        ${metric('Endpoint', wireGuard.endpoint || connection.domesticRelayEndpoint || '-')}
        ${metric('Endpoint route', endpointRoute.interfaceName ? `${endpointRoute.interfaceName}${endpointRoute.gateway ? ` / ${endpointRoute.gateway}` : ''}` : (endpointRoute.error || '-'))}
        ${metric('Endpoint proxy', endpointRoute.viaProxyTun ? 'proxy-tun' : (endpointRoute.ok ? 'clear' : '-'))}
        ${metric('Target', route.targetIp || '10.88.88.88')}
        ${metric('Route dev', route.interfaceName || '-')}
        ${metric('Service', wireGuard.serviceState || (wireGuard.active ? 'active' : '-'))}
        ${metric('LaunchDaemon', launchDaemonStatus)}
        ${metric('Internal', internalApi.ok ? 'ready' : (internalApi.error || connection.health?.internalApi || 'idle'))}
        ${metric('Relay to lease', relaySummary.routeToLease || '-')}
        ${metric('Relay client', relaySummary.clientPeerConfigured ? `${relaySummary.clientPeerConfigured} / ${relaySummary.clientLatestHandshake || '-'} / ${relaySummary.clientTransfer || '-'}` : '-')}
        ${metric('Relay Internal', relaySummary.internalPeerConfigured ? `${relaySummary.internalPeerConfigured} / ${relaySummary.internalLatestHandshake || '-'} / ${relaySummary.internalTransfer || '-'}` : '-')}
        ${metric('Relay healthz', relaySummary.internalHealthz || '-')}
        ${metric('AllowedIPs', compactList(wireGuard.allowedIps))}
        ${metric('Route CIDRs', compactList(connection.routeCidrs))}
        ${metric('Config', wireGuard.configPath || '-')}
      </div>
      ${directSync.message ? `<p class="diagnostic-note">${escapeHtml(directSync.message)}</p>` : ''}
      ${directSyncFailures.length ? `<p class="diagnostic-note">${escapeHtml(directSyncFailures.join(' / '))}</p>` : ''}
      ${peerSync.failures?.length ? `<p class="diagnostic-note">${escapeHtml(peerSync.failures.join(' / '))}</p>` : ''}
      ${relayBlockedReasons.length || relayFailures.length ? `<p class="diagnostic-note">${escapeHtml([...relayBlockedReasons, ...relayFailures].join(' / '))}</p>` : ''}
      ${wireGuard.statusError || wireGuard.routeLogTail ? `<p class="diagnostic-note">${escapeHtml(wireGuard.statusError || wireGuard.routeLogTail)}</p>` : ''}
      ${resolution.message ? `<p class="diagnostic-note">${escapeHtml(resolution.message)}</p>` : ''}
    </section>
  `;
}

function renderConfigForm() {
  const config = state.config || {};
  return `
    <form class="settings-panel" data-form-action="save-config">
      <div class="panel-head">
        <div>
          <h2>运行配置</h2>
          <p>endpoint injection</p>
        </div>
        <button class="secondary-button" type="submit" ${busyAction === 'save-config' ? 'disabled' : ''}>保存</button>
      </div>
      <label class="field">
        <span>Bootstrap API</span>
        <input name="bootstrapApiBaseUrl" value="${escapeAttr(config.bootstrapApiBaseUrl || '')}" />
      </label>
      <label class="field">
        <span>Overlay Internal API</span>
        <input name="internalApiBaseUrl" value="${escapeAttr(config.internalApiBaseUrl)}" />
      </label>
      <div class="field-row">
        <label class="field">
          <span>Domestic Host</span>
          <input name="domesticRelayHost" value="${escapeAttr(config.domesticRelayHost)}" />
        </label>
        <label class="field compact">
          <span>UDP</span>
          <input name="domesticRelayPort" inputmode="numeric" value="${escapeAttr(String(config.domesticRelayPort || ''))}" />
        </label>
      </div>
      <label class="field">
        <span>SDK Gateway</span>
        <input name="sdkGatewayBaseUrl" value="${escapeAttr(config.sdkGatewayBaseUrl)}" />
      </label>
      <label class="field">
        <span>Host Resolve</span>
        <input name="hostResolve" value="${escapeAttr(config.hostResolve || '')}" placeholder="api.mxinfo-inc.cn=<gateway-ip>" />
      </label>
      <label class="field">
        <span>Bootstrap DNS</span>
        <select name="bootstrapResolveMode">
          ${option('env-first', config.bootstrapResolveMode)}
          ${option('dns-first', config.bootstrapResolveMode)}
          ${option('env-only', config.bootstrapResolveMode)}
          ${option('dns-only', config.bootstrapResolveMode)}
        </select>
      </label>
      <label class="field">
        <span>Bootstrap DNS Servers</span>
        <input name="bootstrapDnsServers" value="${escapeAttr(config.bootstrapDnsServers || '')}" placeholder="223.5.5.5, 119.29.29.29" />
      </label>
      <label class="field">
        <span>WG Path</span>
        <select name="routePathPreference">
          ${option('auto', config.routePathPreference)}
          ${option('hybrid', config.routePathPreference)}
          ${option('direct', config.routePathPreference)}
          ${option('relay', config.routePathPreference)}
        </select>
      </label>
      <label class="field">
        <span>Split DNS Domains</span>
        <input name="splitDnsDomains" value="${escapeAttr(config.splitDnsDomains || '')}" placeholder="mxinfo-inc.cn, api.mxinfo-inc.cn" />
      </label>
      <div class="field-row">
        <label class="field">
          <span>Channel</span>
          <select name="releaseChannel">
            ${option('stable', config.releaseChannel)}
            ${option('beta', config.releaseChannel)}
            ${option('internal', config.releaseChannel)}
          </select>
        </label>
        <label class="field">
          <span>Gray</span>
          <input name="rolloutGroup" value="${escapeAttr(config.rolloutGroup)}" />
        </label>
      </div>
      <label class="check-row">
        <input name="useLocalEngineResources" type="checkbox" ${config.useLocalEngineResources ? 'checked' : ''} />
        <span>使用本地引擎资源</span>
      </label>
      <label class="check-row">
        <input name="restartAfterCodeUpdate" type="checkbox" ${config.restartAfterCodeUpdate ? 'checked' : ''} />
        <span>代码更新后自动重启</span>
      </label>
    </form>
  `;
}

function renderWorkbench(connected, connecting) {
  const contract = state.launcherContract || {};
  const foundation = contract.foundation || {};
  return `
    <section class="mx-workbench">
      <header class="workbench-toolbar">
        <div>
          <p class="kicker">LAUNCHER FOUNDATION</p>
          <h2>MX-H2I Desktop</h2>
          <span>${escapeHtml(foundation.socketNamespace || 'launcher socket namespace')}</span>
        </div>
        <div class="toolbar-actions">
          <button class="icon-text-button" type="button" data-action="show-launcher">Launcher</button>
          <button class="icon-text-button ${screen === 'appcenter' ? 'is-active' : ''}" type="button" data-action="show-appcenter">AppCenter</button>
          <button class="primary-button" type="button" data-action="checkUpdates" ${busyAction === 'checkUpdates' ? 'disabled' : ''}>Refresh</button>
        </div>
      </header>

      ${renderFeedback()}

      <section class="workbench-grid">
        <section class="panel foundation-panel">
          <div class="panel-head">
            <div>
              <h3>Standalone owners</h3>
              <p>launcher 底座可被平级产品引用</p>
            </div>
            <span class="tag">${escapeHtml(contract.available ? 'sdk loaded' : 'sdk pending')}</span>
          </div>
          <div class="owner-list">
            ${(foundation.standaloneOwners || []).map(renderOwner).join('')}
          </div>
          <div class="capability-row">
            ${(foundation.sharedCapabilities || []).map((item) => `<span>${escapeHtml(item)}</span>`).join('')}
          </div>
        </section>

        <section class="panel runtime-panel">
          <div class="panel-head">
            <div>
              <h3>Runtime</h3>
              <p>${escapeHtml(state.connection?.subject || 'no active subject')}</p>
            </div>
            <span class="status-pill" data-state="${escapeAttr(state.connection?.state || 'idle')}">${escapeHtml(state.connection?.state || 'idle')}</span>
          </div>
          <div class="metric-grid">
            ${metric('Base URL', state.config?.internalApiBaseUrl)}
            ${metric('Relay', `${state.config?.domesticRelayHost}:${state.config?.domesticRelayPort}`)}
            ${metric('Local IP', state.connection?.localIp || '-')}
            ${metric('Route', state.connection?.routePolicy || '-')}
          </div>
        </section>
      </section>

      ${screen === 'appcenter' ? renderAppCenterView(connected) : renderLauncherView(connected, connecting)}
    </section>
  `;
}

function renderLauncherView(connected, connecting) {
  return `
    <section class="panel app-registry-panel">
      <div class="panel-head">
        <div>
          <p class="kicker">APPLICATIONS</p>
          <h3>Launcher app registry</h3>
        </div>
        <button class="primary-button" type="button" data-action="installAppCenter" ${!connected || busyAction === 'installAppCenter' ? 'disabled' : ''}>
          Install AppCenter
        </button>
      </div>
      <div class="app-grid">
        ${renderAppCard(state.apps?.appcenter, {
          action: 'installAppCenter',
          actionLabel: state.apps?.appcenter?.installed ? 'Ready' : 'Install',
          disabled: !connected || connecting || state.apps?.appcenter?.installed
        })}
        ${renderAppCard(state.apps?.h2o, {
          action: 'enableH2o',
          actionLabel: state.apps?.h2o?.enabled ? 'Enabled' : 'Enable',
          disabled: !state.apps?.appcenter?.installed || state.apps?.h2o?.enabled
        })}
      </div>
    </section>
    ${renderUpdatePanel()}
  `;
}

function renderAppCenterView(connected) {
  const apps = appCatalog();
  const visibleApps = filteredAppCatalog(apps);
  if (!apps.some((app) => app.appId === selectedAppId)) selectedAppId = apps[0]?.appId || 'h2o';
  const selected = apps.find((app) => app.appId === selectedAppId) || visibleApps[0] || apps[0] || null;
  const categories = appCenterCategories(apps);
  return `
    <section class="appcenter-window appcenter-product">
      <aside class="appcenter-rail">
        <div class="appcenter-account">
          <div class="avatar-mark">${escapeHtml((state.identity?.displayName || 'V').slice(0, 1))}</div>
          <div>
            <strong>${escapeHtml(state.identity?.displayName || 'Visitor')}</strong>
            <span>${escapeHtml(state.identity?.account || state.connection?.routePolicy || 'guest limited')}</span>
          </div>
        </div>
        <nav class="appcenter-nav" aria-label="AppCenter sections">
          ${categories.map((item) => `
            <button class="${appCategory === item.id ? 'is-active' : ''}" type="button" data-action="set-app-category" data-category="${escapeAttr(item.id)}">
              <span>${escapeHtml(item.label)}</span>
              <small>${escapeHtml(String(item.count))}</small>
            </button>
          `).join('')}
        </nav>
        <div class="appcenter-rail-foot">
          <span>Home ${escapeHtml(state.update?.currentVersion || '0.1.0')}</span>
          <span>Channel ${escapeHtml(state.update?.channel || state.config?.releaseChannel || 'stable')}</span>
        </div>
      </aside>

      <section class="appcenter-main">
        <header class="appcenter-titlebar">
          <div>
            <p class="kicker">MX-H2I APPCENTER</p>
            <h3>Internal 应用市场</h3>
            <span>${escapeHtml(state.launcherContract?.packageName || '@qpjoy/electron-launcher')} / ${escapeHtml(state.connection?.subject || 'no active subject')}</span>
          </div>
          <div class="toolbar-actions">
            <button class="icon-button" type="button" data-action="show-launcher" aria-label="Back">‹</button>
            <button class="secondary-button" type="button" data-action="checkUpdates" ${busyAction === 'checkUpdates' ? 'disabled' : ''}>刷新版本</button>
            <span class="status-pill" data-state="${connected ? 'connected' : 'idle'}">${connected ? 'broker ready' : 'offline'}</span>
          </div>
        </header>

        <div class="appcenter-notice">
          <strong>embed runtime</strong>
          <span>AppCenter 与 H2O 通过 MX-H2I broker-session 共享网络、身份、权限和更新上下文，不再申请独立 WireGuard peer。</span>
        </div>

        <section class="appcenter-marketbar">
          <div>
            <h4>Apps</h4>
            <p>${escapeHtml(visibleApps.length)} visible / ${escapeHtml(apps.length)} registered</p>
          </div>
          <label class="appcenter-search">
            <span>⌕</span>
            <input data-app-search value="${escapeAttr(appSearch)}" placeholder="Search package, app, permission" />
          </label>
        </section>

        <section class="catalog-grid appcenter-card-grid">
          ${visibleApps.length ? visibleApps.map((app) => renderAppCenterCard(app, connected, selected?.appId === app.appId)).join('') : renderEmptyCatalog()}
        </section>
      </section>

      ${selected ? renderAppCenterInspector(selected, connected) : ''}
    </section>
  `;
}

function appCatalog() {
  const appcenter = state.apps?.appcenter || {};
  const h2o = state.apps?.h2o || {};
  return [
    normalizeCatalogApp(appcenter, {
      appId: 'appcenter',
      displayName: 'AppCenter',
      category: 'platform',
      description: '内置应用市场，负责安装、版本、权限和入口管理。',
      packageName: '@qpjoy/electron-launcher-appcenter',
      permissions: ['auth.read', 'appcenter.read', 'permission.request']
    }),
    normalizeCatalogApp(h2o, {
      appId: 'h2o',
      displayName: 'H2O',
      category: 'network',
      description: 'H2I 内置网络应用 demo，展示 PAC、Split DNS、代理规则和 Internal 状态。',
      packageName: '@qpjoy/electron-launcher-app-h2o',
      permissions: ['network.hdi.status', 'network.proxy.app', 'network.dns.policy', 'network.pac.policy']
    }),
    normalizeCatalogApp({
      appId: 'diagnostics',
      displayName: 'Diagnostics',
      category: 'ops',
      description: 'Route proof、H/D/I/O trace、broker smoke 和版本巡检。',
      packageName: '@qpjoy/electron-launcher-app-diagnostics',
      launcherMode: 'embed',
      standaloneChannelProductId: 'mx-h2i',
      networkScope: 'broker-session',
      version: '0.1.0',
      latestVersion: state.update?.latestVersion || '0.1.1',
      installed: true,
      enabled: true,
      status: 'ready',
      runtimeState: state.update?.status || 'idle',
      installSource: 'builtin',
      permissions: ['observability.read', 'release.read'],
      entrypoints: { desktop: 'app://diagnostics/index.html' }
    }, {}),
    normalizeCatalogApp({
      appId: 'luopan-bridge',
      displayName: 'Luopan Bridge',
      category: 'bridge',
      description: '预留给 Luopan standalone channel 的桥接测试入口，不影响 Luopan 自己的 WG。',
      packageName: '@qpjoy/electron-launcher-app-luopan-bridge',
      launcherMode: 'embed',
      standaloneChannelProductId: 'luopan',
      networkScope: 'broker-session',
      version: '0.1.0',
      latestVersion: '0.1.0',
      installed: false,
      enabled: false,
      status: 'reserved',
      runtimeState: 'reserved',
      installSource: 'registry',
      permissions: ['launcher.bridge.read'],
      entrypoints: { desktop: 'app://luopan-bridge/index.html' }
    }, {})
  ];
}

function normalizeCatalogApp(app, defaults) {
  const row = app && typeof app === 'object' ? app : {};
  return {
    ...defaults,
    ...row,
    appId: row.appId || defaults.appId,
    displayName: row.displayName || defaults.displayName,
    category: row.category || defaults.category || 'custom',
    description: row.description || defaults.description || '',
    packageName: row.packageName || defaults.packageName || `@qpjoy/electron-launcher-app-${row.appId || defaults.appId}`,
    launcherMode: row.launcherMode || defaults.launcherMode || 'embed',
    standaloneChannelProductId: row.standaloneChannelProductId || defaults.standaloneChannelProductId || 'mx-h2i',
    networkScope: row.networkScope || defaults.networkScope || 'broker-session',
    version: row.version || defaults.version || '0.1.0',
    latestVersion: row.latestVersion || defaults.latestVersion || row.version || defaults.version || '0.1.0',
    installedVersion: row.installedVersion || defaults.installedVersion || null,
    installSource: row.installSource || defaults.installSource || 'npm',
    runtimeState: row.runtimeState || defaults.runtimeState || (row.enabled ? 'ready' : row.installed ? 'installed' : 'idle'),
    permissions: Array.isArray(row.permissions) ? row.permissions : defaults.permissions || [],
    entrypoints: row.entrypoints || defaults.entrypoints || {}
  };
}

function filteredAppCatalog(apps) {
  const query = appSearch.trim().toLowerCase();
  return apps.filter((app) => {
    const matchesCategory = appCategory === 'all'
      || app.category === appCategory
      || (appCategory === 'updates' && app.latestVersion && app.latestVersion !== (app.installedVersion || app.version));
    if (!matchesCategory) return false;
    if (!query) return true;
    const haystack = [
      app.appId,
      app.displayName,
      app.category,
      app.packageName,
      app.description,
      app.networkScope,
      app.standaloneChannelProductId,
      ...(app.permissions || [])
    ].join(' ').toLowerCase();
    return haystack.includes(query);
  });
}

function appCenterCategories(apps) {
  return [
    { id: 'all', label: 'All Apps', count: apps.length },
    { id: 'network', label: 'Network', count: apps.filter((app) => app.category === 'network').length },
    { id: 'platform', label: 'Platform', count: apps.filter((app) => app.category === 'platform').length },
    { id: 'ops', label: 'Diagnostics', count: apps.filter((app) => app.category === 'ops').length },
    { id: 'updates', label: 'Updates', count: apps.filter((app) => app.latestVersion && app.latestVersion !== (app.installedVersion || app.version)).length }
  ];
}

function renderAppCenterCard(app, connected, selected) {
  const action = appPrimaryAction(app, connected);
  return `
    <article class="catalog-card appcenter-app-card ${selected ? 'is-active' : ''}">
      <button class="catalog-card-select" type="button" data-action="select-app" data-app-id="${escapeAttr(app.appId)}" aria-label="${escapeAttr(`Select ${app.displayName}`)}"></button>
      <div class="catalog-cover" data-category="${escapeAttr(app.category)}">
        <span>${escapeHtml(app.displayName.slice(0, 3).toUpperCase())}</span>
      </div>
      <div class="catalog-card-body">
        <div>
          <h4>${escapeHtml(app.displayName)}</h4>
          <p>${escapeHtml(app.description)}</p>
        </div>
        <div class="package-line">${escapeHtml(app.packageName)}</div>
      </div>
      <div class="catalog-card-foot">
        <span class="status-dot" data-state="${escapeAttr(app.status || app.runtimeState || 'available')}">${escapeHtml(appStatusLabel(app))}</span>
        <button class="secondary-button" type="button" data-action="${escapeAttr(action.action)}" ${action.disabled ? 'disabled' : ''}>
          ${escapeHtml(action.label)}
        </button>
      </div>
    </article>
  `;
}

function renderAppCenterInspector(app, connected) {
  const action = appPrimaryAction(app, connected);
  return `
    <aside class="appcenter-inspector">
      <div class="inspector-head">
        <div class="app-icon-large">${escapeHtml(app.displayName.slice(0, 3).toUpperCase())}</div>
        <div>
          <p class="kicker">${escapeHtml(app.category)}</p>
          <h4>${escapeHtml(app.displayName)}</h4>
          <span>${escapeHtml(app.packageName)}</span>
        </div>
      </div>
      <p class="inspector-summary">${escapeHtml(app.description)}</p>
      <div class="detail-list">
        <div><span>Mode</span><strong>${escapeHtml(app.launcherMode)}</strong></div>
        <div><span>Channel</span><strong>${escapeHtml(app.standaloneChannelProductId || '-')}</strong></div>
        <div><span>Network</span><strong>${escapeHtml(app.networkScope || '-')}</strong></div>
        <div><span>Install</span><strong>${escapeHtml(app.installSource || 'npm')}</strong></div>
        <div><span>Installed</span><strong>${escapeHtml(app.installedVersion || (app.installed ? app.version : 'not installed'))}</strong></div>
        <div><span>Latest</span><strong>${escapeHtml(app.latestVersion || app.version)}</strong></div>
        <div><span>Runtime</span><strong>${escapeHtml(app.runtimeState || app.status || 'idle')}</strong></div>
        <div><span>Last Action</span><strong>${escapeHtml(formatDateTime(app.lastAction))}</strong></div>
      </div>
      <div class="permission-stack">
        ${(app.permissions || []).map((item) => `<span>${escapeHtml(item)}</span>`).join('')}
      </div>
      <div class="entrypoint-box">
        <strong>Entrypoints</strong>
        ${Object.entries(app.entrypoints || {}).map(([key, value]) => `<span>${escapeHtml(key)}: ${escapeHtml(value)}</span>`).join('') || '<span>-</span>'}
      </div>
      <button class="primary-button block-button" type="button" data-action="${escapeAttr(action.action)}" ${action.disabled ? 'disabled' : ''}>
        ${escapeHtml(action.label)}
      </button>
      <button class="secondary-button block-button" type="button" data-action="checkUpdates" ${busyAction === 'checkUpdates' ? 'disabled' : ''}>
        Check Version
      </button>
    </aside>
  `;
}

function appPrimaryAction(app, connected) {
  if (app.appId === 'appcenter') {
    return { action: 'show-appcenter', label: app.installed ? 'Open' : 'Install', disabled: !connected || busyAction === 'installAppCenter' };
  }
  if (app.appId === 'h2o') {
    if (app.installed && app.enabled) return { action: 'launchH2o', label: app.runtimeState === 'running' ? 'Running' : 'Open', disabled: !connected || busyAction === 'launchH2o' };
    return { action: 'enableH2o', label: 'Install', disabled: !connected || !state.apps?.appcenter?.installed || busyAction === 'enableH2o' };
  }
  if (app.appId === 'diagnostics') {
    return { action: 'checkUpdates', label: 'Open', disabled: busyAction === 'checkUpdates' };
  }
  return { action: 'select-app', label: 'Reserved', disabled: true };
}

function appStatusLabel(app) {
  if (app.status === 'reserved') return 'Reserved';
  if (app.runtimeState === 'running') return 'Running';
  if (app.installed && app.enabled) return 'Installed';
  if (app.installed) return 'Cached';
  return 'Available';
}

function renderEmptyCatalog() {
  return `
    <div class="empty-catalog">
      <strong>No app matched</strong>
      <span>Try another keyword or category.</span>
    </div>
  `;
}

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function renderLegacyAppCenterView(connected) {
  return `
    <section class="appcenter-window">
      <header class="appcenter-titlebar">
        <div>
          <p class="kicker">APPCENTER</p>
          <h3>Installed through MX-H2I</h3>
        </div>
        <span class="status-pill" data-state="${connected ? 'connected' : 'idle'}">${connected ? 'channel ready' : 'offline'}</span>
      </header>
      <div class="appcenter-layout">
        <aside class="appcenter-nav">
          <button class="is-active" type="button">All Apps</button>
          <button type="button">Network</button>
          <button type="button">Platform</button>
          <button type="button">Updates</button>
        </aside>
        <section class="catalog-grid">
          ${renderCatalogCard('H2O', 'network', '规则、订阅、PAC、Split DNS', state.apps?.h2o?.enabled ? 'Enabled' : 'Available', 'enableH2o')}
          ${renderCatalogCard('Diagnostics', 'ops', 'H/D/I/O trace、route plan、日志', 'Bundled', 'checkUpdates')}
          ${renderCatalogCard('Luopan Bridge', 'reserved', '未来可切换到 luopan standalone channel', 'Reserved', 'show-launcher')}
        </section>
        <aside class="detail-panel">
          <h4>H2O runtime</h4>
          <div class="detail-list">
            <div><span>Mode</span><strong>embed</strong></div>
            <div><span>Channel</span><strong>mx-h2i</strong></div>
            <div><span>Network scope</span><strong>broker-session</strong></div>
            <div><span>Service context</span><strong>via MX-H2I</strong></div>
            <div><span>Permissions</span><strong>network / dns / pac</strong></div>
          </div>
          <button class="primary-button block-button" type="button" data-action="enableH2o" ${!state.apps?.appcenter?.installed ? 'disabled' : ''}>
            ${state.apps?.h2o?.enabled ? 'Open H2O' : 'Enable H2O'}
          </button>
        </aside>
      </div>
    </section>
  `;
}

function renderFeedback() {
  const feedback = state.feedback;
  if (!feedback) return '';
  return `<div class="feedback" data-tone="${escapeAttr(feedback.tone || 'info')}">${escapeHtml(feedback.message || '')}</div>`;
}

function renderOwner(owner) {
  return `
    <article class="owner-row ${owner.state === 'active' ? 'is-active' : ''}">
      <div class="product-icon">${escapeHtml(owner.productId === 'mx-h2i' ? 'H2I' : 'LP')}</div>
      <div>
        <strong>${escapeHtml(owner.displayName)}</strong>
        <span>${escapeHtml(owner.productId)} / ${escapeHtml(owner.serviceVip)}</span>
      </div>
      <span class="status-pill" data-state="${escapeAttr(owner.state)}">${escapeHtml(owner.state)}</span>
    </article>
  `;
}

function renderAppCard(app, options) {
  if (!app) return '';
  return `
    <article class="app-card ${app.enabled ? 'is-enabled' : ''}">
      <div class="product-icon">${escapeHtml(app.appId === 'h2o' ? 'H2O' : 'APP')}</div>
      <div>
        <h4>${escapeHtml(app.displayName)}</h4>
        <p>${escapeHtml(app.launcherMode)} via ${escapeHtml(app.standaloneChannelProductId)}</p>
      </div>
      <div class="app-card-meta">
        <span>${escapeHtml(app.networkScope || (app.launcherMode === 'embed' ? 'broker-session' : app.serviceVip))}</span>
        <strong>${escapeHtml(app.installed ? app.status : 'available')}</strong>
      </div>
      <button class="secondary-button" type="button" data-action="${escapeAttr(options.action)}" ${options.disabled ? 'disabled' : ''}>
        ${escapeHtml(options.actionLabel)}
      </button>
    </article>
  `;
}

function renderCatalogCard(name, category, summary, status, action) {
  return `
    <article class="catalog-card">
      <div class="catalog-cover" data-category="${escapeAttr(category)}"></div>
      <div>
        <h4>${escapeHtml(name)}</h4>
        <p>${escapeHtml(summary)}</p>
      </div>
      <div class="catalog-card-foot">
        <span>${escapeHtml(status)}</span>
        <button class="secondary-button" type="button" data-action="${escapeAttr(action)}">${status === 'Enabled' ? 'Open' : 'Select'}</button>
      </div>
    </article>
  `;
}

function renderUpdatePanel() {
  const update = state.update || {};
  return `
    <section class="panel update-panel">
      <div class="panel-head">
        <div>
          <h3>Release / Gray</h3>
          <p>由 Launcher standalone 更新器执行</p>
        </div>
        <button class="secondary-button" type="button" data-action="openAdmin">Admin</button>
      </div>
      <div class="metric-grid">
        ${metric('Current', update.currentVersion)}
        ${metric('Latest', update.latestVersion)}
        ${metric('Policy', update.policy)}
        ${metric('Gray', update.rolloutGroup)}
      </div>
    </section>
  `;
}

function metric(label, value) {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || '-')}</strong></div>`;
}

function pathLabel(value) {
  if (value === 'hdi-relay') return 'H2I via Domestic relay';
  if (value === 'h2i-direct') return 'H2I direct';
  if (value === 'h2i-hybrid') return 'H2I hybrid';
  return value || '-';
}

function compactList(value) {
  const items = Array.isArray(value) ? value : [];
  if (!items.length) return '-';
  const text = items.map((item) => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') return item.cidr || item.destination || item.interfaceName || JSON.stringify(item);
    return String(item || '');
  }).filter(Boolean).join(', ');
  return text.length > 90 ? `${text.slice(0, 87)}...` : text;
}

function compactText(value, limit = 90) {
  const text = String(value || '').trim();
  if (!text) return '-';
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3))}...` : text;
}

function connectionCaption() {
  const connection = state.connection || {};
  if (connection.state === 'connecting') return '正在准备 WireGuard、DNS、PAC 和权限上下文';
  if (connection.state === 'connected') return `${connection.localIp} / ${connection.routePolicy}`;
  if (connection.state === 'tunnel-only') return `${connection.localIp} / tunnel only / ${connection.health?.internalApi || 'internal pending'}`;
  if (connection.state === 'lease-only') return `${connection.localIp} / lease only / ${connection.health?.wireGuard || 'wg pending'}`;
  if (connection.state === 'network-unavailable') return `${connection.localIp || '未分配'} / network unavailable`;
  if (connection.state === 'server-unavailable') return `${connection.localIp || '未分配'} / server redeploying`;
  if (connection.state === 'forbidden') return `${connection.localIp || '未分配'} / blocked`;
  return 'standalone launcher channel owner';
}

function readConfigForm(form) {
  const formData = new FormData(form);
  return {
    bootstrapApiBaseUrl: String(formData.get('bootstrapApiBaseUrl') || ''),
    internalApiBaseUrl: String(formData.get('internalApiBaseUrl') || ''),
    domesticRelayHost: String(formData.get('domesticRelayHost') || ''),
    domesticRelayPort: Number(formData.get('domesticRelayPort') || 0),
    sdkGatewayBaseUrl: String(formData.get('sdkGatewayBaseUrl') || ''),
    hostResolve: String(formData.get('hostResolve') || ''),
    bootstrapResolveMode: String(formData.get('bootstrapResolveMode') || ''),
    bootstrapDnsServers: String(formData.get('bootstrapDnsServers') || ''),
    routePathPreference: String(formData.get('routePathPreference') || ''),
    splitDnsDomains: String(formData.get('splitDnsDomains') || ''),
    releaseChannel: String(formData.get('releaseChannel') || ''),
    rolloutGroup: String(formData.get('rolloutGroup') || ''),
    useLocalEngineResources: formData.get('useLocalEngineResources') === 'on',
    restartAfterCodeUpdate: formData.get('restartAfterCodeUpdate') === 'on'
  };
}

function option(value, selected) {
  return `<option value="${escapeAttr(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(value)}</option>`;
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createMockApi() {
  let mockState = {
    config: {
      bootstrapApiBaseUrl: 'http://api.mxinfo-inc.cn:18090',
      internalApiBaseUrl: 'http://10.88.88.88:18090',
      domesticRelayHost: '121.43.253.179',
      domesticRelayPort: 51280,
      sdkGatewayBaseUrl: 'http://api.mxinfo-inc.cn:18090/internal/v1/sdk',
      hostResolve: '',
      bootstrapResolveMode: 'env-first',
      bootstrapDnsServers: '',
      routePathPreference: 'auto',
      splitDnsDomains: 'mxinfo-inc.cn,api.mxinfo-inc.cn',
      releaseChannel: 'stable',
      rolloutGroup: 'staff-ring',
      useLocalEngineResources: true,
      restartAfterCodeUpdate: true
    },
    connection: {
      state: 'idle',
      mode: 'guest',
      localIp: null,
      routePolicy: 'none',
      subject: null,
      connectedAt: null,
      health: {
        wireGuard: 'idle',
        domesticRelay: 'idle',
        internalApi: 'idle',
        splitDns: 'idle',
        appBroker: 'idle'
      }
    },
    identity: {
      kind: 'anonymous',
      displayName: 'Visitor',
      account: null,
      scopes: ['auth.read']
    },
    apps: {
      appcenter: {
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
        permissions: ['auth.read', 'appcenter.read'],
        installSource: 'builtin',
        runtimeState: 'idle',
        entrypoints: {
          desktop: 'app://appcenter/index.html',
          settings: 'app://appcenter/settings.html'
        },
        installed: false,
        enabled: false,
        status: 'available'
      },
      h2o: {
        appId: 'h2o',
        displayName: 'H2O',
        category: 'network',
        description: 'H2I 内置网络应用 demo，展示 PAC、Split DNS、代理规则和 Internal 服务状态。',
        packageName: '@qpjoy/electron-launcher-app-h2o',
        launcherMode: 'embed',
        standaloneChannelProductId: 'mx-h2i',
        networkScope: 'broker-session',
        serviceVip: '10.88.100.10',
        version: '0.1.0',
        latestVersion: '0.1.0',
        updatePolicy: 'launcher-managed',
        permissions: ['network.hdi.status', 'network.proxy.app'],
        installSource: 'npm',
        runtimeState: 'idle',
        entrypoints: {
          desktop: 'app://h2o/index.html',
          settings: 'app://h2o/settings.html',
          dev: 'workspace:demos/mx-app-h2o'
        },
        installed: false,
        enabled: false,
        status: 'available'
      }
    },
    update: {
      status: 'idle',
      currentVersion: '0.1.0',
      latestVersion: '0.1.0',
      policy: 'launcher-managed',
      channel: 'stable',
      rolloutGroup: 'staff-ring',
      canSkip: false,
      lastCheckedAt: null
    },
    launcherContract: {
      packageName: '@qpjoy/electron-launcher',
      available: true,
      product: {
        productId: 'mx-h2i',
        displayName: 'MX-H2I',
        mode: 'standalone'
      },
      foundation: {
        runtimeName: 'Launcher Foundation',
        socketNamespace: '~/.qpjoy/mx-launcher/sockets/{standaloneChannelProductId}.sock',
        sharedCapabilities: ['auth', 'permission', 'release', 'network', 'observability'],
        standaloneOwners: [
          { productId: 'mx-h2i', displayName: 'MX-H2I', state: 'active', serviceVip: '10.88.100.1' },
          { productId: 'luopan', displayName: 'Luopan', state: 'reserved', serviceVip: '10.88.110.1' }
        ]
      }
    },
    feedback: null,
    activity: [],
    updatedAt: new Date().toISOString()
  };

  const commit = (patch) => {
    mockState = {
      ...mockState,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    return clone(mockState);
  };

  return {
    getState: async () => clone(mockState),
    saveConfig: async (input) => commit({ config: { ...mockState.config, ...input }, feedback: { tone: 'success', message: '配置已保存。' } }),
    connectGuest: async () => commit({
      connection: {
        ...mockState.connection,
        state: 'connected',
        mode: 'guest',
        localIp: '10.89.120.24',
        routePolicy: 'guest limited',
        subject: 'anonymousPrincipal:h2i-demo',
        health: {
          wireGuard: 'ready',
          domesticRelay: 'ready',
          internalApi: 'ready',
          splitDns: 'ready',
          appBroker: 'ready'
        }
      },
      feedback: null
    }),
    loginEmployee: async (input) => commit({
      connection: {
        ...mockState.connection,
        state: 'connected',
        mode: 'employee',
        localIp: '10.89.8.24',
        routePolicy: 'user full',
        subject: `user:${String(input.account || 'employee').split('@')[0]}`,
        health: {
          wireGuard: 'ready',
          domesticRelay: 'ready',
          internalApi: 'ready',
          splitDns: 'ready',
          appBroker: 'ready'
        }
      },
      identity: {
        kind: 'user',
        displayName: String(input.account || 'employee').split('@')[0],
        account: input.account || 'employee@qpjoy.local',
        scopes: ['auth.read', 'appcenter.read', 'network.hdi.status']
      },
      feedback: null
    }),
    disconnect: async () => commit({
      connection: {
        ...mockState.connection,
        state: 'idle',
        localIp: null,
        routePolicy: 'none',
        subject: null,
        health: {
          wireGuard: 'idle',
          domesticRelay: 'idle',
          internalApi: 'idle',
          splitDns: 'idle',
          appBroker: 'idle'
        }
      },
      feedback: { tone: 'info', message: '连接已断开。' }
    }),
    installAppCenter: async () => commit({
      apps: {
        ...mockState.apps,
        appcenter: {
          ...mockState.apps.appcenter,
          installed: true,
          enabled: true,
          status: 'ready',
          installedVersion: mockState.apps.appcenter.version,
          latestVersion: mockState.apps.appcenter.latestVersion || mockState.apps.appcenter.version,
          runtimeState: 'ready',
          lastAction: new Date().toISOString()
        }
      },
      feedback: { tone: 'success', message: 'AppCenter 已安装，package/version 已写入本地缓存。' }
    }),
    enableH2o: async () => commit({
      apps: {
        ...mockState.apps,
        h2o: {
          ...mockState.apps.h2o,
          installed: true,
          enabled: true,
          status: 'enabled',
          installedVersion: mockState.apps.h2o.version,
          latestVersion: mockState.apps.h2o.latestVersion || mockState.apps.h2o.version,
          runtimeState: 'ready',
          lastAction: new Date().toISOString()
        }
      },
      feedback: { tone: 'success', message: 'H2O 已启用，broker-session 权限已就绪。' }
    }),
    launchH2o: async () => commit({
      apps: {
        ...mockState.apps,
        h2o: {
          ...mockState.apps.h2o,
          installed: true,
          enabled: true,
          status: 'running',
          runtimeState: 'running',
          installedVersion: mockState.apps.h2o.installedVersion || mockState.apps.h2o.version,
          lastAction: new Date().toISOString()
        }
      },
      feedback: { tone: 'success', message: 'H2O 运行态已就绪。开发态从 mx-app-h2o 单独启动窗口。' }
    }),
    checkUpdates: async () => commit({
      update: {
        ...mockState.update,
        status: 'ready',
        latestVersion: '0.1.1',
        canSkip: true,
        lastCheckedAt: new Date().toISOString()
      },
      feedback: { tone: 'info', message: '更新策略已刷新。' }
    }),
    refreshDiagnostics: async () => commit({
      connection: {
        ...mockState.connection,
        domesticPeerSync: {
          status: 'passed',
          execution: 'executed',
          checkedAt: new Date().toISOString(),
          failures: []
        }
      },
      feedback: { tone: 'success', message: '诊断已刷新。' }
    }),
    repairSystemNetwork: async () => commit({
      connection: {
        ...mockState.connection,
        diagnostics: {
          ...(mockState.connection.diagnostics || {}),
          networkEnvironment: {
            reason: 'mock-repair',
            phase: mockState.connection.state === 'connected' ? 'connected' : 'disconnected',
            host: 'h2i.mxinfo-inc.cn',
            resolution: {
              state: mockState.connection.state === 'connected' ? 'expected-internal' : 'public',
              severity: 'ok',
              message: 'mock network repaired',
              addresses: [{ address: mockState.connection.state === 'connected' ? '10.88.88.88' : '116.62.51.154', classification: mockState.connection.state === 'connected' ? 'expected-internal-target' : 'public' }]
            },
            systemDomainProxy: { applied: mockState.connection.state === 'connected', systemResolverMode: 'dynamic' }
          }
        }
      },
      feedback: { tone: 'success', message: '系统网络状态已修复。' }
    }),
    openAdmin: async () => true,
    setWindowMode: async () => true,
    moveWindowBy: async () => true,
    finishWindowDrag: async () => true,
    hideTopDockIfPending: async () => true,
    windowControl: async () => true,
    onState: () => () => {}
  };
}
